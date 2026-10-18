import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { childEnvironment } from '../agent/env.ts';
import { chooseEffort, chooseModel } from '../agent/model.ts';
import { classify } from '../workflow/classify.ts';
import { MODEL_FAMILIES, modelFamilyOf } from '../agent/rate-limit.ts';
import type { AgentEvent, AgentRunner, IntegrationReport, TokenUsage } from '../agent/types.ts';
import { estimateCost, totalTokens, type ModelTokenUsage, type PricingStore } from '../costs/pricing.ts';
import type { HistoryLog, RunOutcome, RunStart } from '../history/history.ts';
import { readTranscript, type TranscriptChunk } from '../agent/transcript.ts';
import { defaultIntegrations } from '../integrations/registry.ts';
import type { WorkspaceIntegration } from '../integrations/types.ts';
import type { Logger } from '../log.ts';
import { getTrackerFactory } from '../tracker/registry.ts';
import type { Issue, TrackedResult, TrackerAdapter } from '../tracker/types.ts';
import { SerialQueue, settledWithin } from '../util/async.ts';
import { SymphonyError, errorMessage } from '../util/errors.ts';
import { truncate } from '../util/text.ts';
import { describeHolder, type LockResult } from '../workspace/lock.ts';
import { WorkspaceManager, type HookIssue, type Workspace } from '../workspace/manager.ts';
import type { ServiceConfig } from '../workflow/config.ts';
import { roleFor, roleName, type RoleConfig } from '../workflow/roles.ts';
import { internalResult, renderResultComment, type ResultMeta } from '../workflow/results.ts';
import type { EffectiveWorkflow, WorkflowLoadError } from '../workflow/store.ts';
import { skipCheckProblems, skipReason, stageSkip, type StageSkip } from './skip.ts';
import { nextStageProblems, unknownBoardColumns, validateDispatch } from '../workflow/validate.ts';
import {
  CONTINUATION_DELAY_MS,
  MAX_TIMER_MS,
  failureBackoffMs,
  hasRequiredFields,
  hasRequiredLabels,
  isActiveState,
  isRoutable,
  isTerminalState,
  sessionLimitWaitMs,
  stateLimit,
  waitingForSubIssues,
} from './eligibility.ts';
import { normalizeStateName } from '../workflow/config.ts';
import { planDispatch, type PlanIssue, type PlanItem, type PlanRetry } from './dispatch-plan.ts';
import { createGuard, entryCheckFor, type CheckCache, type CheckRecord } from './guard.ts';
import { IssueArchive, type ArchivedIssue } from './issue-archive.ts';
import {
  activeReservations,
  applyLimitUpdate,
  effectiveAgentLimits,
  hasLimitOverride,
  heldForOtherRoles,
  limitsJson,
  limitsSummary,
  NO_LIMIT_OVERRIDE,
  reservationProblem,
  sameLimitOverride,
  withAgentLimits,
  type AgentLimitOverride,
} from './limits.ts';
import { RuntimeStateStore, runtimeStateFile, type ModelHold, type OperatorHold } from './runtime-state.ts';
import { resultRows, type PersistedResult } from './stage-history.ts';
import { blockedBucketColumns, derivePipeline, type PipelineStage, type StageSession } from './pipeline.ts';
import { copyToolUsage, countToolUse, emptyToolUsage, integrationJson, integrationUsage, type ToolUsage } from './tool-usage.ts';
import { runAgentAttempt, type RunPhase, type WorkerOutcome } from './worker.ts';
import { interruptedLabels, interruptedTransition, statusUpdatedAt, type InterruptedTransition } from './recovery.ts';
import { applyTransitionLabels, RESULT_TOOL } from './result-tool.ts';

export interface Clock {
  now(): Date;
  monotonicMs(): number;
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = { now: () => new Date(), monotonicMs: () => performance.now() };
export const systemTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** What the orchestrator needs from the workflow store (a fake in tests). */
export interface WorkflowSource {
  readonly path: string;
  readonly current: EffectiveWorkflow;
  readonly lastError: WorkflowLoadError | null;
  refreshIfChanged(): Promise<void>;
}

export type RestartResult =
  | { ok: true; issueIdentifier: string; previous: 'retrying' | 'paused' }
  | { ok: false; reason: 'not_found' | 'running' | 'stopping' | 'not_waiting' };

export type PauseResult =
  | { ok: true; issueIdentifier: string; previous: 'running' | 'retrying' | 'queued' | 'paused' }
  | { ok: false; reason: 'not_found' | 'already_paused' | 'stopping' };

export type ResumeResult = { ok: true; issueIdentifier: string } | { ok: false; reason: 'not_found' | 'not_paused' | 'stopping' };

/** Slot counts of a force-start: `running` includes the forced sessions, `limit` is agent.max_concurrent_agents. */
export interface ForceSlots {
  running: number;
  forced: number;
  limit: number;
}

export type ForceResult =
  | { ok: true; issueIdentifier: string; previous: 'queued' | 'retrying' | 'paused'; slots: ForceSlots }
  | { ok: false; reason: 'not_found' | 'running' | 'stopping' | 'blocked' | 'not_eligible' | 'invalid_workflow' | 'tracker_error' | 'spawn_failed'; message: string }
  | { ok: false; reason: 'model_held'; message: string; model: string };

export type ModelControlResult =
  | { ok: true; model: string; issues: number }
  | { ok: false; reason: 'unknown_model' | 'already_paused' | 'not_paused' | 'stopping' };

export type AgentSettingsResult =
  | { ok: true; changed: boolean; limits: ReturnType<typeof limitsJson> }
  | { ok: false; reason: 'invalid'; message: string }
  | { ok: false; reason: 'stopping' };

export type AdapterFactory = (config: ServiceConfig, env: NodeJS.ProcessEnv, logger: Logger) => TrackerAdapter;

export interface OrchestratorDeps {
  workflow: WorkflowSource;
  runner: AgentRunner;
  logger: Logger;
  env: NodeJS.ProcessEnv;
  /** Root for session transcripts (`<logDir>/sessions/...`), or null. */
  logDir: string | null;
  clock?: Clock;
  timers?: Timers;
  createAdapter?: AdapterFactory;
  /** model-costs.yml; without it costs fall back to Claude Code's own estimate. */
  pricing?: PricingStore | null;
  /** Per-repository run history; null disables it. */
  history?: HistoryLog | null;
  /** Workspace integrations prepared before each session; defaults to the registry. */
  integrations?: readonly WorkspaceIntegration[];
}

/** `paused`: the operator paused the issue; `model_hold`: the operator paused the issue's model. */
type StopKind = 'terminal' | 'inactive' | 'unroutable' | 'missing' | 'stalled' | 'shutdown' | 'paused' | 'model_hold';

interface StopRequest {
  kind: StopKind;
  cleanupWorkspace: boolean;
  reason: string;
  atMs: number;
}

interface RunningEntry {
  issueId: string;
  identifier: string;
  /** Repository for the history log (`owner/name`, or `unknown`). */
  repo: string;
  /** Short id tying the history lines of one run together. */
  runId: string;
  /** Role serving the issue's column at dispatch (`default` without a matching role); fixed for the run. */
  role: string;
  /** The role's configuration at dispatch (`on_missing_result`, its columns); null for the implicit `default` role. */
  roleConfig: RoleConfig | null;
  /** The session recorded its stage result (`report_result` posted the result comment). */
  resultRecorded: boolean;
  /** The recorded result moved the issue (false when the move after the comment failed). */
  resultMoved: boolean;
  /** Started by the operator in an extra slot (`forceStart`): holds no slot of the limits, for this session only. */
  forced: boolean;
  /** Logger for this run's agent events, tagged with `run_id` and `role`. */
  runLog: Logger;
  issue: Issue;
  attempt: number | null;
  startedAt: Date;
  startedAtMs: number;
  /** When the run left PreparingWorkspace; stall detection counts from here until the first agent event. */
  preparedAtMs: number | null;
  phase: RunPhase;
  workspacePath: string | null;
  /** Model the agent session reported at startup (`session_configured`). */
  model: string | null;
  /** Model requested at dispatch (label, role or claude.model); null = Claude Code default. */
  requestedModel: string | null;
  /** Effort requested at dispatch (label, role or claude.effort); null = Claude Code default. */
  effort: string | null;
  sessionId: string | null;
  threadId: string | null;
  turnId: string | null;
  turnCount: number;
  pid: number | null;
  lastEvent: string | null;
  lastEventAt: Date | null;
  lastEventAtMs: number | null;
  lastMessage: string | null;
  tokens: TokenUsage;
  reported: TokenUsage;
  /** Estimated cost with model-costs.yml (Claude Code's estimate when no price table is configured). */
  costUsd: number;
  reportedCostUsd: number;
  claudeEstimateUsd: number;
  modelUsage: Record<string, ModelTokenUsage>;
  /** MCP servers Symphony added that did not connect in the session. */
  mcpUnavailable: string[];
  /** `run_started` line waiting for the integrations' fields; written once they ran, or when the run ends first. */
  pendingStart: RunStart | null;
  /** `tool_use` events per MCP server (`mcp__<server>__<tool>`); built-in tools are not counted. */
  mcpToolCalls: Record<string, number>;
  /** `tool_use` events per tool and Skill tool calls per skill, built-in tools included. */
  toolUsage: ToolUsage;
  /** What the workspace integrations (e.g. Laravel Boost) set up for the session. */
  integrations: IntegrationReport[];
  /** Skills Claude Code loaded at session start (`session_configured`); null until then. */
  sessionSkills: string[] | null;
  headSha: string | null;
  branch: string | null;
  controller: AbortController;
  stop: StopRequest | null;
  done: Promise<void>;
}

interface RetryEntry {
  issueId: string;
  identifier: string;
  url: string | null;
  attempt: number;
  kind: 'continuation' | 'failure' | 'session_limit';
  dueAtMs: number;
  dueAt: Date;
  error: string | null;
  /** The session limit behind a `session_limit` retry; null for the other kinds. */
  limit: SessionLimitState | null;
  /** Requeued because the dispatch plan gave the slot to another issue: it still competes for the next free one. */
  queued: boolean;
  timer: unknown;
}

/** A session-limit failure as the retry queue keeps it (GET /api/v1/state `retrying[].limit`). */
interface SessionLimitState {
  window: string | null;
  /** `model`: only `model` is limited; the issue waits for the end of the model's hold, not for a quick retry. */
  scope: 'account' | 'model';
  /** Model family of a `model` limit; null for `account`. */
  model: string | null;
  resetsAt: Date | null;
  source: 'event' | 'message' | null;
  /** The original Claude message; the entry's `error` is replaced by queue-state texts such as "waiting for a free slot (2/2 busy)". */
  text: string;
  /** Consecutive session-limit failures of this claim, including this one. */
  hits: number;
  /** agent.max_session_limit_retries when this entry was scheduled. */
  maxRetries: number;
  /** Retries used up: the entry waits for the reset (`due_at` = reset + SESSION_LIMIT_RESET_BUFFER_MS). */
  waiting: boolean;
  overageDisabledReason: string | null;
  /** When the failure was observed. */
  observedAt: Date;
}

function limitJson(limit: SessionLimitState | null) {
  if (limit === null) return null;
  return {
    window: limit.window,
    scope: limit.scope,
    model: limit.model,
    resets_at: limit.resetsAt?.toISOString() ?? null,
    source: limit.source,
    text: limit.text,
    hits: limit.hits,
    max_retries: limit.maxRetries,
    waiting: limit.waiting,
    overage_disabled_reason: limit.overageDisabledReason,
    observed_at: limit.observedAt.toISOString(),
  };
}

/**
 * One entry of an issue's execution timeline (GET /api/v1/<identifier>/timeline): agent events, phase
 * transitions and lifecycle steps of the orchestrator (`run_dispatched`, `run_finished`, `retry_scheduled`,
 * `issue_paused`). `seq` grows per issue, so clients can ask for the entries after the last one they have.
 */
export interface TimelineEvent {
  seq: number;
  at: string;
  kind: 'lifecycle' | 'phase' | 'agent';
  event: string;
  /** Severity the orchestrator logs this event with. */
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string | null;
  run: string | null;
  turn: number | null;
  detail: Record<string, unknown> | null;
}

/** One agent session (run) of a claimed issue. */
interface SessionInfo {
  run: string;
  attempt: number | null;
  role: string;
  state: string;
  /** Model chosen at dispatch; null = Claude Code default (the session reports the actual one). */
  model: string | null;
  /** Effort chosen at dispatch; null = Claude Code default. */
  effort: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  outcome: RunOutcome | null;
  /** JSONL transcript of the session, or null when transcripts are disabled. */
  transcript: string | null;
}

/** Board fields of an issue kept while it is claimed, so retrying and paused issues keep their context. */
interface IssueMeta {
  state: string;
  /** First non-empty description line only, enough for `parseIssueCommand` via `roleFor`. */
  description: string | null;
  labels: string[];
  priority: number | null;
  createdAt: Date | null;
  blockedBy: Issue['blocked_by'];
  dispatchNote: string | null;
  parent: unknown;
  subIssues: unknown[];
}

/** First non-empty line of a description; what command detection and the pipeline need. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Why an issue was paused, for the timeline entry of its Resume. */
function pausedBecause(paused: PausedEntry): string {
  if (paused.source === 'operator') return 'by the operator';
  if (paused.source === 'budget') return 'because its cost budget was used up';
  return `after ${paused.continuations} continuation session(s)`;
}

function firstLine(text: string | null): string | null {
  return text?.split(/\r?\n/).find((line) => line.trim() !== '') ?? null;
}

function issueMeta(issue: Issue): IssueMeta {
  return {
    state: issue.state,
    description: firstLine(issue.description),
    labels: issue.labels,
    priority: issue.priority,
    createdAt: issue.created_at,
    blockedBy: issue.blocked_by,
    dispatchNote: typeof issue.native_ref?.dispatch_note === 'string' ? issue.native_ref.dispatch_note : null,
    parent: issue.native_ref?.parent ?? null,
    subIssues: Array.isArray(issue.native_ref?.sub_issues) ? issue.native_ref.sub_issues : [],
  };
}

/** `issue` object of GET /api/v1/<identifier>. */
function metaJson(meta: IssueMeta | null) {
  if (meta === null) return null;
  return {
    state: meta.state,
    labels: meta.labels,
    priority: meta.priority,
    blocked_by: meta.blockedBy,
    dispatch_note: meta.dispatchNote,
    parent: meta.parent,
    sub_issues: meta.subIssues,
  };
}

/** Per-issue debugging context kept while the issue is claimed. */
interface IssueRecord {
  identifier: string;
  url: string | null;
  title: string;
  repo: string | null;
  workspacePath: string | null;
  runs: number;
  /** Continuation sessions dispatched since the issue was claimed (agent.max_continuations). */
  continuations: number;
  /** Consecutive session-limit failures; reset by every run that ends without one. */
  sessionLimitHits: number;
  lastError: string | null;
  /** Execution timeline of the claim, the newest TIMELINE_EVENTS entries. */
  timeline: TimelineEvent[];
  nextSeq: number;
  /** Sessions of the claim, the newest MAX_SESSIONS. */
  sessions: SessionInfo[];
  /** Commit, branch and MCP tool usage of the running or last run. */
  lastRun: RunTrace | null;
  /** Passing entry-check results per HEAD and script (docs/configuration.md#checks); in memory, dropped with the claim. */
  checkCache: CheckCache;
  /** The latest entry check of any run for this issue. */
  lastCheck: CheckRecord | null;
  /** Board fields of the issue at the last dispatch or reconcile; null before the first dispatch. */
  meta: IssueMeta | null;
  /** The issue's stage results as the latest result-driven session saw or reported them; empty before the first one. */
  results: PersistedResult[];
}

interface RunTrace {
  headSha: string | null;
  branch: string | null;
  mcpToolCalls: Record<string, number>;
  toolUsage: ToolUsage;
  integrations: IntegrationReport[];
  sessionSkills: string[] | null;
  /** MCP servers that did not connect at session start. */
  mcpUnavailable: string[];
}

function traceOf(entry: RunningEntry): RunTrace {
  return {
    headSha: entry.headSha,
    branch: entry.branch,
    mcpToolCalls: { ...entry.mcpToolCalls },
    toolUsage: copyToolUsage(entry.toolUsage),
    integrations: entry.integrations,
    sessionSkills: entry.sessionSkills,
    mcpUnavailable: [...entry.mcpUnavailable],
  };
}

function traceJson(trace: RunTrace | null) {
  if (trace === null) return null;
  return {
    head_sha: trace.headSha,
    branch: trace.branch,
    mcp_tool_calls: trace.mcpToolCalls,
    tool_calls: trace.toolUsage.tools,
    skill_calls: trace.toolUsage.skills,
    agent_calls: trace.toolUsage.agents,
    integrations: trace.integrations.map((report) => integrationJson(report, trace.toolUsage, trace.sessionSkills, trace.mcpUnavailable)),
  };
}

function checkJson(check: CheckRecord | null) {
  if (check === null) return null;
  return {
    target: check.target,
    role: check.role,
    sha: check.sha,
    ok: check.ok,
    result: check.result,
    exit_code: check.exitCode,
    timed_out: check.timedOut,
    duration_ms: check.durationMs,
    finished_at: check.finishedAt.toISOString(),
  };
}

/** The newest agent events with a message, for the dashboard. */
function recentEvents(timeline: TimelineEvent[]) {
  return timeline
    .filter((event) => event.kind === 'agent' && event.message !== null)
    .slice(-RECENT_EVENTS)
    .map((event) => ({ at: event.at, event: event.event, message: event.message }));
}

/** `mcp__<server>__<tool>` → `<server>`; null for built-in tools. */
function mcpServerOf(tool: string): string | null {
  const match = /^mcp__(.+?)__/.exec(tool);
  return match?.[1] ?? null;
}

/**
 * A paused issue: claimed, but not running or retrying. `continuations`: held back after agent.max_continuations,
 * lifted by any change on the board. `operator`: paused from the dashboard, lifted only by Resume, a terminal state or
 * leaving the board; persisted in the runtime state file.
 */
interface PausedEntry {
  issueId: string;
  identifier: string;
  url: string | null;
  title: string | null;
  state: string;
  updatedAtMs: number | null;
  continuations: number;
  pausedAt: Date;
  /** `budget`: the issue's cost reached agent.max_issue_cost_usd. */
  source: 'continuations' | 'operator' | 'budget';
  /** Retry attempt of the claim when it was paused; Resume starts with it. */
  attempt: number | null;
  /** Cost and cap of a `budget` pause. */
  budget?: IssueBudget;
}

/** An issue's cost against agent.max_issue_cost_usd, both in USD. */
interface IssueBudget {
  costUsd: number;
  limitUsd: number;
}

/** What holds a model: a limit (until its reset) or the operator (until the release). */
type ActiveHold = { model: string; source: 'limit' | 'operator'; since: Date; until: Date | null };

/** Session-limit windows that apply to the whole account; a wait for one of them pauses new dispatches. */
const ACCOUNT_WIDE_WINDOWS = new Set(['five_hour', 'seven_day']);

/** New dispatches are held back while a worker waits for an account-wide session limit to reset. */
interface DispatchGate {
  until: Date;
  window: string;
  issueIdentifier: string;
}

const RECENT_EVENTS = 50;
const TIMELINE_EVENTS = 2000;
const MAX_SESSIONS = 20;
const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
/** Lifecycle events logged at info level; everything else is debug. */
const LIFECYCLE_EVENTS = new Set([
  'session_started',
  'session_configured',
  'startup_failed',
  'turn_started',
  'turn_completed',
  'turn_failed',
  'turn_cancelled',
  'turn_timeout',
  'turn_input_required',
  'approval_denied',
  'agent_exited',
  'tracker_tool',
  'transition_denied',
  'checks_started',
  'checks_cached',
  'checks_skipped',
  'checks_finished',
]);
/** Events that usually need an operator's attention. */
const WARNING_EVENTS = new Set(['agent_error', 'startup_failed', 'turn_failed', 'turn_timeout']);

function defaultAdapterFactory(config: ServiceConfig, env: NodeJS.ProcessEnv, logger: Logger): TrackerAdapter {
  const factory = getTrackerFactory(config.tracker.kind);
  if (factory === undefined) throw new SymphonyError('unsupported_tracker_kind', `unsupported tracker.kind ${config.tracker.kind}`);
  return factory.create({
    provider: config.tracker.provider,
    activeStates: config.tracker.activeStates,
    terminalStates: config.tracker.terminalStates,
    env,
    logger,
  });
}

function usageDelta(next: TokenUsage, previous: TokenUsage): TokenUsage {
  // Absolute totals; a decrease means the session counter restarted, so count it from zero.
  const pick = (a: number, b: number) => (a >= b ? a - b : a);
  return {
    inputTokens: pick(next.inputTokens, previous.inputTokens),
    outputTokens: pick(next.outputTokens, previous.outputTokens),
    totalTokens: pick(next.totalTokens, previous.totalTokens),
  };
}

/** Session totals as the dashboard counts them (input includes cache reads and writes), from per-model totals. */
function tokensOfModelUsage(usage: Record<string, ModelTokenUsage>): TokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const model of Object.values(usage)) {
    inputTokens += model.inputTokens + model.cacheReadTokens + model.cacheWriteTokens;
    outputTokens += model.outputTokens;
  }
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function primaryModelOf(usage: Record<string, ModelTokenUsage>): string | null {
  let best: string | null = null;
  let most = -1;
  for (const [model, tokens] of Object.entries(usage)) {
    if (totalTokens(tokens) > most) {
      best = model;
      most = totalTokens(tokens);
    }
  }
  return best;
}

function tokensJson(usage: TokenUsage) {
  return { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, total_tokens: usage.totalTokens };
}

/** What a tracker needs to complete an interrupted transition (`#recoverTransition`). */
type RecoveryAdapter = TrackerAdapter & Required<Pick<TrackerAdapter, 'readResults' | 'setStatus' | 'addLabels' | 'removeLabels'>>;

function canRecover(adapter: TrackerAdapter): adapter is RecoveryAdapter {
  return adapter.readResults !== undefined && adapter.setStatus !== undefined && adapter.addLabels !== undefined && adapter.removeLabels !== undefined;
}

/** How a transition recovery ended: moved, declined (the stage runs), changed (moved by someone else) or failed (retried). */
type RecoveryOutcome =
  | { kind: 'moved'; status: string; check: CheckRecord | null; labels: { added: string[]; removed: string[] }; warnings: string[] }
  | { kind: 'declined' | 'changed' | 'failed'; reason: string };

/**
 * The single authority over scheduling state (spec 7-8): polling, dispatch, reconciliation,
 * retries. Mutations run through one serial queue; agent events only update counters.
 */
export class Orchestrator {
  #deps: OrchestratorDeps;
  #clock: Clock;
  #timers: Timers;
  #logger: Logger;
  #createAdapter: AdapterFactory;
  #serial = new SerialQueue();

  #running = new Map<string, RunningEntry>();
  #claimed = new Set<string>();
  /** Stage skips and transition recoveries in flight (see `#skipStage`, `#recoverTransition`); `stop` waits for them. */
  #skips = new Set<Promise<void>>();
  /** Aborted at shutdown: stops the entry check of a transition recovery. */
  #halt = new AbortController();
  /** The result comment of an interrupted transition whose recovery was declined, by issue id: its stage runs instead. */
  #recoveryDeclined = new Map<string, string>();
  /** Issues whose `skipped` comment is posted but whose move failed, by issue id: the retry must not post it again. */
  #skipCommented = new Map<string, { key: string; url: string | null }>();
  #retries = new Map<string, RetryEntry>();
  #completed = new Set<string>();
  #archive: IssueArchive;
  #records = new Map<string, IssueRecord>();
  #paused = new Map<string, PausedEntry>();
  /** Cap of the budget comment already posted per issue, so a Resume that pauses again does not comment twice. */
  #budgetNotified = new Map<string, number>();
  /** Issues whose workspace this process created or used; checked for terminal states after release. */
  #watched = new Map<string, string>();
  #cleanups = new Map<string, Promise<void>>();
  #totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, endedSeconds: 0, costUsd: 0, claudeEstimateUsd: 0 };
  #rateLimits: unknown = null;
  /** The latest `turn_completed` of any run: session limits observed before it are gone. */
  #lastTurnSuccessAt: Date | null = null;
  /** The dispatch gate the last tick logged, to log its start and end once. */
  #loggedGate: DispatchGate | null = null;
  /** Why the reservations were ignored at the last tick, to log it once. */
  #loggedReservationProblem: string | null = null;
  /** Models on hold after a model-scoped usage limit, by family; persisted in the runtime state file. */
  #modelHolds = new Map<string, ModelHold>();
  /** Models the operator paused, by family; no end of their own, persisted in the runtime state file. */
  #operatorHolds = new Map<string, OperatorHold>();
  /** Agent slots set on the dashboard; they take precedence over `WORKFLOW.md`, persisted in the runtime state file. */
  #limitOverride: AgentLimitOverride = NO_LIMIT_OVERRIDE;
  #runtimeState: RuntimeStateStore;

  #pollIntervalMs: number;
  #tickTimer: unknown = null;
  #tickInFlight = false;
  #refreshPending = false;
  #stopping = false;
  #shutdown: Promise<void> | null = null;
  #lastTickAt: Date | null = null;
  #dispatchErrors: string[] = [];
  #lastTrackerError: { at: Date; message: string } | null = null;
  #adapterCache: { version: number; adapter: TrackerAdapter } | null = null;
  #statusOptionsCache: { version: number; options: string[] } | null = null;
  /** The last successful board fetch: active-column candidates plus blocked-column issues, for the dashboard. */
  #board: { fetchedAt: Date; candidates: Issue[]; parked: Issue[] } | null = null;
  #listeners = new Set<() => void>();

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
    this.#timers = deps.timers ?? systemTimers;
    this.#logger = deps.logger;
    this.#createAdapter = deps.createAdapter ?? defaultAdapterFactory;
    this.#pollIntervalMs = deps.workflow.current.config.polling.intervalMs;
    this.#archive = new IssueArchive(deps.logDir === null ? null : path.join(deps.logDir, 'issues'), deps.logger);
    const tracker = deps.workflow.current.config.tracker;
    this.#runtimeState = new RuntimeStateStore(runtimeStateFile(deps.logDir, tracker, deps.env), deps.logger);
    const restored = this.#runtimeState.load(this.#clock.now());
    for (const hold of restored.modelHolds) {
      this.#modelHolds.set(hold.model, hold);
      this.#logger.info(`model ${hold.model} on hold until ${hold.until.toISOString()} (restored)`, { model: hold.model, issue_identifier: hold.issueIdentifier });
    }
    for (const hold of restored.operatorHolds) {
      this.#operatorHolds.set(hold.model, hold);
      this.#logger.info(`model ${hold.model} paused by the operator (restored)`, { model: hold.model });
    }
    if (hasLimitOverride(restored.settings)) {
      this.#limitOverride = restored.settings;
      this.#logger.info('agent slots set on the dashboard (restored)', limitsSummary(deps.workflow.current.config, restored.settings));
    }
    // Restored pauses keep their claim; the next reconcile fills in the board fields or releases them.
    for (const pause of restored.pausedIssues) {
      this.#paused.set(pause.issueId, {
        issueId: pause.issueId,
        identifier: pause.identifier,
        url: pause.url,
        title: null,
        state: '',
        updatedAtMs: null,
        continuations: 0,
        pausedAt: pause.since,
        source: 'operator',
        attempt: null,
      });
      this.#claimed.add(pause.issueId);
      this.#logger.info('issue paused by the operator (restored)', { issue_id: pause.issueId, issue_identifier: pause.identifier });
    }
  }

  /** Startup validation (fails startup), terminal workspace cleanup, then an immediate first tick. */
  async start(): Promise<void> {
    const workflow = this.#deps.workflow.current;
    await this.#loadStatusOptions(workflow);
    const errors = this.#validate(workflow);
    if (errors.length > 0) throw new SymphonyError('startup_validation_failed', errors.join('; '));
    this.#pollIntervalMs = workflow.config.polling.intervalMs;
    await this.#startupCleanup(workflow);
    this.#scheduleTick(0);
  }

  /** Stops dispatching, cancels retries and stops running workers (bounded wait). */
  shutdown(timeoutMs: number): Promise<void> {
    this.#shutdown ??= (async () => {
      this.#stopping = true;
      if (this.#tickTimer !== null) this.#timers.clearTimeout(this.#tickTimer);
      this.#tickTimer = null;
      for (const retry of this.#retries.values()) this.#timers.clearTimeout(retry.timer);
      this.#retries.clear();
      const entries = [...this.#running.values()];
      for (const entry of entries) {
        this.#requestStop(entry, { kind: 'shutdown', cleanupWorkspace: false, reason: 'orchestrator shutting down' });
      }
      if (entries.length > 0) {
        this.#logger.info('waiting for running agents to stop', { count: entries.length });
        await settledWithin(Promise.all(entries.map((entry) => entry.done)), timeoutMs);
      }
      this.#halt.abort();
      await settledWithin(Promise.all(this.#skips), timeoutMs);
      this.#notify();
    })();
    return this.#shutdown;
  }

  /** Queues an immediate poll + reconcile (POST /api/v1/refresh). Repeated requests coalesce. */
  requestRefresh(): { queued: boolean; coalesced: boolean } {
    if (this.#stopping) return { queued: false, coalesced: false };
    const coalesced = this.#refreshPending;
    this.#refreshPending = true;
    if (!coalesced && !this.#tickInFlight) this.#scheduleTick(0);
    return { queued: true, coalesced };
  }

  /**
   * Puts a worker that waits in the retry queue, or is paused, back into the retry queue without delay.
   * An operator override: the session-limit and continuation counters start again, and the next run is a
   * plain attempt (never a continuation, so `agent.max_continuations` cannot pause it again).
   * `#onRetryTimer` still re-checks eligibility, validation and free slots.
   */
  restartWorker(key: string): Promise<RestartResult> {
    return this.#serial.run(async (): Promise<RestartResult> => {
      if (this.#stopping) return { ok: false, reason: 'stopping' };
      const matches = (id: string, identifier: string) => id === key || identifier === key;
      if ([...this.#running.values()].some((e) => matches(e.issueId, e.identifier))) return { ok: false, reason: 'running' };
      const retry = [...this.#retries.values()].find((r) => matches(r.issueId, r.identifier));
      const paused = retry === undefined ? [...this.#paused.values()].find((p) => matches(p.issueId, p.identifier)) : undefined;
      const waiting = retry ?? paused;
      if (waiting === undefined) {
        const claimed = [...this.#claimed].some((id) => matches(id, this.#records.get(id)?.identifier ?? ''));
        return { ok: false, reason: claimed ? 'not_waiting' : 'not_found' };
      }
      const issueId = waiting.issueId;
      const record = this.#restartClaim(issueId, waiting.identifier, waiting.url, retry?.attempt ?? paused?.attempt ?? 1, 'restarted by the operator');
      const previous = retry !== undefined ? 'retrying' : 'paused';
      if (record !== undefined) {
        this.#trace(record, {
          kind: 'lifecycle',
          event: 'worker_restarted',
          level: 'info',
          message: `restarted by the operator (was ${previous})`,
          run: null,
          turn: null,
          detail: { previous },
        });
      }
      this.#deps.history?.note(record?.repo ?? 'unknown', 'worker_restarted', {
        issue: waiting.identifier,
        title: record?.title ?? null,
        previous,
      });
      this.#logger.info('worker restarted by the operator', { issue_id: issueId, issue_identifier: waiting.identifier, previous });
      this.#notify();
      return { ok: true, issueIdentifier: waiting.identifier, previous };
    });
  }

  /** Counters reset, pause lifted, and an immediate retry (`#onRetryTimer` re-checks eligibility and slots). */
  #restartClaim(issueId: string, identifier: string, url: string | null, attempt: number, error: string): IssueRecord | undefined {
    const record = this.#records.get(issueId);
    if (record !== undefined) {
      record.sessionLimitHits = 0;
      record.continuations = 0;
    }
    this.#unpause(issueId);
    this.#scheduleRetry(issueId, attempt, { identifier, url, kind: 'failure', error, limit: null }, 0);
    return record;
  }

  /** Drops a pause; an operator pause also leaves the runtime state file (kept there while shutting down). */
  #unpause(issueId: string): void {
    const paused = this.#paused.get(issueId);
    if (paused === undefined) return;
    this.#paused.delete(issueId);
    if (paused.source === 'operator' && !this.#stopping) this.#saveRuntimeState();
  }

  /**
   * Pauses an issue from the dashboard: running (its agent stops at once, workspace kept, no retry follows), retrying
   * (the timer is cancelled), queued on the board (it is claimed) or paused after its continuations. Only Resume, a
   * terminal state or leaving the board lifts it; board changes such as comments, labels or column moves do not.
   */
  pauseIssue(key: string): Promise<PauseResult> {
    return this.#serial.run((): PauseResult => {
      if (this.#stopping) return { ok: false, reason: 'stopping' };
      const matches = (id: string, identifier: string) => id === key || identifier === key;
      const now = this.#clock.now();
      const entry = [...this.#running.values()].find((e) => matches(e.issueId, e.identifier));
      const existing = [...this.#paused.values()].find((p) => matches(p.issueId, p.identifier));
      if (entry !== undefined && entry.stop !== null) return { ok: false, reason: existing?.source === 'operator' ? 'already_paused' : 'stopping' };
      if (existing !== undefined && existing.source === 'operator') return { ok: false, reason: 'already_paused' };
      const retry = [...this.#retries.values()].find((r) => matches(r.issueId, r.identifier));
      const candidate =
        entry === undefined && retry === undefined && existing === undefined
          ? this.#board?.candidates.find((issue) => matches(issue.id, issue.identifier) && !this.#claimed.has(issue.id) && !this.#cleanups.has(issue.id))
          : undefined;
      let previous: 'running' | 'retrying' | 'queued' | 'paused';
      let paused: PausedEntry;
      const base = (issueId: string, identifier: string, url: string | null, title: string | null, state: string, attempt: number | null): PausedEntry => ({
        issueId,
        identifier,
        url,
        title,
        state,
        updatedAtMs: null,
        continuations: this.#records.get(issueId)?.continuations ?? 0,
        pausedAt: now,
        source: 'operator',
        attempt,
      });
      if (existing !== undefined) {
        previous = 'paused';
        paused = { ...existing, source: 'operator', pausedAt: now };
      } else if (entry !== undefined) {
        previous = 'running';
        paused = base(entry.issueId, entry.identifier, entry.issue.url, entry.issue.title, entry.issue.state, entry.attempt);
      } else if (retry !== undefined) {
        previous = 'retrying';
        this.#cancelRetry(retry.issueId);
        const meta = this.#records.get(retry.issueId)?.meta;
        paused = base(retry.issueId, retry.identifier, retry.url, this.#records.get(retry.issueId)?.title ?? null, meta?.state ?? '', retry.attempt);
      } else if (candidate !== undefined) {
        previous = 'queued';
        const record = this.#record(candidate);
        record.repo ??= this.#repositoryOf(candidate);
        record.meta = issueMeta(candidate);
        paused = base(candidate.id, candidate.identifier, candidate.url, candidate.title, candidate.state, null);
      } else {
        return { ok: false, reason: 'not_found' };
      }
      this.#paused.set(paused.issueId, paused);
      this.#claimed.add(paused.issueId);
      this.#saveRuntimeState();
      if (entry !== undefined) this.#requestStop(entry, { kind: 'paused', cleanupWorkspace: false, reason: 'paused by the operator' });
      const record = this.#records.get(paused.issueId);
      if (record !== undefined) {
        this.#trace(record, {
          kind: 'lifecycle',
          event: 'issue_paused',
          level: 'info',
          message: `paused by the operator (was ${previous})`,
          run: entry?.runId ?? null,
          turn: null,
          detail: { source: 'operator', previous, state: paused.state },
        });
      }
      this.#deps.history?.note(entry?.repo ?? record?.repo ?? 'unknown', 'issue_paused', {
        issue: paused.identifier,
        title: paused.title ?? record?.title ?? null,
        state: paused.state,
        source: 'operator',
        previous,
      });
      this.#logger.info('issue paused by the operator', { issue_id: paused.issueId, issue_identifier: paused.identifier, previous });
      this.#notify();
      return { ok: true, issueIdentifier: paused.identifier, previous };
    });
  }

  /** Lifts a pause (operator or continuations): the issue starts fresh like Resume now (counters reset, attempt kept). */
  resumeIssue(key: string): Promise<ResumeResult> {
    return this.#serial.run((): ResumeResult => {
      if (this.#stopping) return { ok: false, reason: 'stopping' };
      const matches = (id: string, identifier: string) => id === key || identifier === key;
      const paused = [...this.#paused.values()].find((p) => matches(p.issueId, p.identifier));
      if (paused === undefined) {
        const known =
          [...this.#claimed].some((id) => matches(id, this.#records.get(id)?.identifier ?? '')) ||
          [...this.#running.values()].some((e) => matches(e.issueId, e.identifier)) ||
          (this.#board?.candidates ?? []).some((issue) => matches(issue.id, issue.identifier));
        return { ok: false, reason: known ? 'not_paused' : 'not_found' };
      }
      // Still stopping after the pause: it resumes once the agent exited.
      if (this.#running.has(paused.issueId)) return { ok: false, reason: 'stopping' };
      const record = this.#restartClaim(paused.issueId, paused.identifier, paused.url, paused.attempt ?? 1, 'resumed by the operator');
      if (record !== undefined) {
        this.#trace(record, {
          kind: 'lifecycle',
          event: 'issue_resumed',
          level: 'info',
          message: `resumed by the operator (paused ${pausedBecause(paused)})`,
          run: null,
          turn: null,
          detail: { source: paused.source },
        });
      }
      this.#deps.history?.note(record?.repo ?? 'unknown', 'issue_resumed', {
        issue: paused.identifier,
        title: record?.title ?? paused.title,
        source: paused.source,
      });
      this.#logger.info('issue resumed by the operator', { issue_id: paused.issueId, issue_identifier: paused.identifier, source: paused.source });
      this.#notify();
      return { ok: true, issueIdentifier: paused.identifier };
    });
  }

  /**
   * Starts an issue now in an extra slot (Start now): a candidate in Up next, a waiting retry (backoff, session limit,
   * continuation) or a paused issue (the pause is lifted). Bypasses the retry wait, the account-wide dispatch gate, the
   * global and column limits and the reservations; the counters reset as with Retry now. Respects the board (blockers,
   * open sub-issues for `wait_for_sub_issues`, required labels, an active column) and model holds. The session is
   * `forced` and holds no slot; what follows it (continuation, hand-off, retry) queues like any other work.
   */
  forceStart(key: string): Promise<ForceResult> {
    return this.#serial.run(async (): Promise<ForceResult> => {
      const stopping: ForceResult = { ok: false, reason: 'stopping', message: 'the orchestrator is shutting down' };
      if (this.#stopping) return stopping;
      const matches = (id: string, identifier: string) => id === key || identifier === key;
      if ([...this.#running.values()].some((e) => matches(e.issueId, e.identifier))) {
        return { ok: false, reason: 'running', message: `issue ${key} is already running` };
      }
      const retry = [...this.#retries.values()].find((r) => matches(r.issueId, r.identifier));
      const paused = retry === undefined ? [...this.#paused.values()].find((p) => matches(p.issueId, p.identifier)) : undefined;
      const candidate =
        retry === undefined && paused === undefined
          ? this.#board?.candidates.find((issue) => matches(issue.id, issue.identifier) && !this.#claimed.has(issue.id))
          : undefined;
      const issueId = retry?.issueId ?? paused?.issueId ?? candidate?.id;
      if (issueId === undefined) return { ok: false, reason: 'not_found', message: `issue ${key} is not queued, waiting or paused` };
      if (this.#cleanups.has(issueId)) return { ok: false, reason: 'not_eligible', message: 'the workspace of this issue is being removed' };
      const previous = retry !== undefined ? 'retrying' : paused !== undefined ? 'paused' : 'queued';

      const workflow = this.#deps.workflow.current;
      const config = workflow.config;
      await this.#loadStatusOptions(workflow);
      const errors = this.#validate(workflow);
      if (errors.length > 0) return { ok: false, reason: 'invalid_workflow', message: `dispatch validation failed: ${errors[0]}` };
      let adapter: TrackerAdapter;
      let issue: Issue | undefined;
      try {
        adapter = this.#adapterFor(workflow);
        issue = (await adapter.fetchIssuesByIds([issueId])).find((fresh) => fresh.id === issueId);
      } catch (error) {
        return { ok: false, reason: 'tracker_error', message: `issue refresh failed: ${errorMessage(error)}` };
      }
      if (this.#stopping) return stopping;
      if (this.#running.has(issueId)) return { ok: false, reason: 'running', message: `issue ${key} is already running` };
      if (issue === undefined) return { ok: false, reason: 'not_found', message: `issue ${key} is no longer visible on the tracker` };
      if (!hasRequiredFields(issue) || !isActiveState(issue.state, config.tracker)) {
        return { ok: false, reason: 'not_eligible', message: `issue is in "${issue.state}", not an active column` };
      }
      if (issue.dispatchable !== true) {
        const note = typeof issue.native_ref?.dispatch_note === 'string' && issue.native_ref.dispatch_note !== '' ? issue.native_ref.dispatch_note : 'not dispatchable';
        return { ok: false, reason: 'blocked', message: note };
      }
      if (!hasRequiredLabels(issue, config.tracker.requiredLabels)) {
        return { ok: false, reason: 'not_eligible', message: `missing required labels (${config.tracker.requiredLabels.join(', ')})` };
      }
      const subIssues = waitingForSubIssues(issue, roleFor(issue, config.roles), adapter);
      if (subIssues.length > 0) return { ok: false, reason: 'blocked', message: `waiting for sub-issues ${subIssues.join(', ')}` };
      const hold = this.#holdFor(issue, config);
      if (hold !== null) {
        const message =
          hold.until === null
            ? `model ${hold.model} is paused by the operator; resume the model first`
            : `model ${hold.model} is on hold until ${hold.until.toISOString()}; it cannot start before`;
        return { ok: false, reason: 'model_held', message, model: hold.model };
      }

      const record = this.#records.get(issueId);
      if (record !== undefined) {
        record.sessionLimitHits = 0;
        record.continuations = 0;
      }
      this.#unpause(issueId);
      this.#cancelRetry(issueId);
      const attempt = retry?.attempt ?? paused?.attempt ?? null;
      this.#dispatch(issue, attempt, workflow, adapter, false, true);
      const entry = this.#running.get(issueId);
      if (entry === undefined) {
        // The spawn failed: #dispatch queued a retry.
        this.#notify();
        return { ok: false, reason: 'spawn_failed', message: this.#retries.get(issueId)?.error ?? 'failed to spawn agent' };
      }
      const slots = this.#slotsJson();
      const forcedRecord = this.#records.get(issueId);
      if (forcedRecord !== undefined) {
        this.#trace(forcedRecord, {
          kind: 'lifecycle',
          event: 'worker_forced',
          level: 'info',
          message: `started by the operator in an extra slot (was ${previous}; ${slots.running}/${slots.limit} running, ${slots.forced} forced)`,
          run: entry.runId,
          turn: null,
          detail: { previous, running: slots.running, forced: slots.forced, limit: slots.limit },
        });
      }
      this.#deps.history?.note(entry.repo, 'worker_forced', {
        issue: issue.identifier,
        title: issue.title,
        previous,
        running: slots.running,
        forced: slots.forced,
        limit: slots.limit,
      });
      this.#logger.info('issue started by the operator in an extra slot', { issue_id: issueId, issue_identifier: issue.identifier, previous, ...slots });
      this.#notify();
      return { ok: true, issueIdentifier: issue.identifier, previous, slots };
    });
  }

  /**
   * Changes the agent slots from the dashboard (`PUT /api/v1/settings/agents`, see `applyLimitUpdate`). The override
   * takes precedence over `WORKFLOW.md` and its reloads and applies from the next tick, which is requested at once.
   * Lowering below the running count stops nobody: nothing new starts until the count is below the limit.
   */
  updateAgentSettings(body: unknown): Promise<AgentSettingsResult> {
    return this.#serial.run((): AgentSettingsResult => {
      if (this.#stopping) return { ok: false, reason: 'stopping' };
      const result = applyLimitUpdate(this.#limitOverride, body, this.#deps.workflow.current.config);
      if (!result.ok) return { ok: false, reason: 'invalid', message: result.message };
      return this.#setLimitOverride(result.override, 'dashboard');
    });
  }

  /** Removes the dashboard override (`DELETE /api/v1/settings/agents`): `WORKFLOW.md` applies again. */
  resetAgentSettings(): Promise<AgentSettingsResult> {
    return this.#serial.run((): AgentSettingsResult => {
      if (this.#stopping) return { ok: false, reason: 'stopping' };
      return this.#setLimitOverride(NO_LIMIT_OVERRIDE, 'reset');
    });
  }

  #setLimitOverride(override: AgentLimitOverride, source: 'dashboard' | 'reset'): AgentSettingsResult {
    const config = this.#deps.workflow.current.config;
    if (sameLimitOverride(override, this.#limitOverride)) return { ok: true, changed: false, limits: limitsJson(config, override, this.#runningByRole()) };
    const previous = limitsSummary(config, this.#limitOverride);
    this.#limitOverride = override;
    this.#saveRuntimeState();
    const current = limitsSummary(config, override);
    const detail = { source, old: previous, new: current, running: this.#running.size };
    const columns = (limits: Record<string, number>) => Object.entries(limits).map(([state, limit]) => `${state}=${limit}`).join(', ');
    for (const repo of this.#knownRepos()) {
      this.#deps.history?.note(repo, 'settings_changed', {
        source,
        old_max_concurrent_agents: previous.max_concurrent_agents,
        new_max_concurrent_agents: current.max_concurrent_agents,
        old_by_state: columns(previous.max_concurrent_agents_by_state),
        new_by_state: columns(current.max_concurrent_agents_by_state),
        old_reserved: columns(previous.reserved_slots_by_role),
        new_reserved: columns(current.reserved_slots_by_role),
        running: this.#running.size,
      });
    }
    this.#logger.info(
      `agent slots ${source === 'reset' ? 'reset to WORKFLOW.md' : 'changed on the dashboard'}: ${previous.max_concurrent_agents} -> ${current.max_concurrent_agents}`,
      detail,
    );
    // A raised limit starts the next agents with this tick.
    this.requestRefresh();
    this.#notify();
    return { ok: true, changed: true, limits: limitsJson(config, override, this.#runningByRole()) };
  }

  /**
   * Pauses a model family from the dashboard: an operator hold without an end, next to the limit holds. Running agents
   * of that model stop at once (workspace kept) and wait with reason `model_hold`; no issue of it starts, nor falls
   * back to another model, until `releaseModel`.
   */
  holdModel(model: string): Promise<ModelControlResult> {
    return this.#serial.run((): ModelControlResult => {
      const family = model.trim().toLowerCase();
      if (!(MODEL_FAMILIES as readonly string[]).includes(family)) return { ok: false, reason: 'unknown_model' };
      if (this.#stopping) return { ok: false, reason: 'stopping' };
      if (this.#operatorHolds.has(family)) return { ok: false, reason: 'already_paused' };
      const hold: OperatorHold = { model: family, since: this.#clock.now() };
      this.#operatorHolds.set(family, hold);
      this.#saveRuntimeState();
      const stopped = [...this.#running.values()].filter((entry) => entry.stop === null && modelFamilyOf(entry.requestedModel) === family);
      const detail = { model: family, source: 'operator', since: hold.since.toISOString(), until: null };
      for (const entry of stopped) {
        this.#requestStop(entry, { kind: 'model_hold', cleanupWorkspace: false, reason: `model ${family} paused by the operator` });
        const record = this.#records.get(entry.issueId);
        if (record !== undefined) {
          this.#trace(record, { kind: 'lifecycle', event: 'model_hold', level: 'info', message: `model ${family} paused by the operator`, run: entry.runId, turn: null, detail });
        }
      }
      for (const repo of this.#knownRepos()) this.#deps.history?.note(repo, 'model_hold', { ...detail, stopped: stopped.length });
      this.#logger.info(`model ${family} paused by the operator`, { model: family, stopped: stopped.length });
      this.#notify();
      return { ok: true, model: family, issues: stopped.length };
    });
  }

  /** Lifts the operator hold of a model: its waiting issues retry at once (still subject to free slots and limit holds). */
  releaseModel(model: string): Promise<ModelControlResult> {
    return this.#serial.run((): ModelControlResult => {
      const family = model.trim().toLowerCase();
      if (!(MODEL_FAMILIES as readonly string[]).includes(family)) return { ok: false, reason: 'unknown_model' };
      if (this.#stopping) return { ok: false, reason: 'stopping' };
      const hold = this.#operatorHolds.get(family);
      if (hold === undefined) return { ok: false, reason: 'not_paused' };
      this.#operatorHolds.delete(family);
      this.#saveRuntimeState();
      const config = this.#deps.workflow.current.config;
      const waiting = [...this.#retries.values()].filter(
        (retry) => modelFamilyOf(this.#modelFor(this.#planIssue(retry.issueId, retry.identifier, null), config)) === family,
      );
      const detail = { model: family, source: 'operator', since: hold.since.toISOString() };
      for (const retry of waiting) {
        const { issueId, attempt, identifier, url, kind, limit } = retry;
        this.#scheduleRetry(issueId, attempt, { identifier, url, kind, error: `model ${family} released by the operator`, limit }, 0);
        const record = this.#records.get(issueId);
        if (record !== undefined) {
          this.#trace(record, { kind: 'lifecycle', event: 'model_hold_ended', level: 'info', message: `model ${family} released by the operator`, run: null, turn: null, detail });
        }
      }
      for (const repo of this.#knownRepos()) this.#deps.history?.note(repo, 'model_hold_ended', { ...detail, requeued: waiting.length });
      this.#logger.info(`model ${family} released by the operator`, { model: family, requeued: waiting.length });
      // New candidates of the model start with the next tick.
      this.requestRefresh();
      this.#notify();
      return { ok: true, model: family, issues: waiting.length };
    });
  }

  /** Repositories of the claimed issues, for history lines that belong to no single issue. */
  #knownRepos(): string[] {
    const repos = new Set<string>();
    for (const entry of this.#running.values()) repos.add(entry.repo);
    for (const record of this.#records.values()) if (record.repo !== null) repos.add(record.repo);
    return repos.size > 0 ? [...repos] : ['unknown'];
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Runs one tick right away (tests and --dry-run style tooling). */
  tickNow(): Promise<void> {
    return this.#serial.run(() => this.#tick());
  }

  // ---------------------------------------------------------------- ticks

  #scheduleTick(delayMs: number): void {
    if (this.#stopping) return;
    if (this.#tickTimer !== null) this.#timers.clearTimeout(this.#tickTimer);
    this.#tickTimer = this.#timers.setTimeout(() => {
      this.#tickTimer = null;
      if (this.#tickInFlight) {
        this.#refreshPending = true;
        return;
      }
      this.#tickInFlight = true;
      void this.#serial
        .run(() => this.#tick())
        .finally(() => {
          this.#tickInFlight = false;
          this.#scheduleTick(this.#refreshPending ? 0 : this.#pollIntervalMs);
        });
    }, delayMs);
  }

  async #tick(): Promise<void> {
    if (this.#stopping) return;
    this.#refreshPending = false;
    try {
      await this.#deps.workflow.refreshIfChanged();
      const workflow = this.#deps.workflow.current;
      const config = workflow.config;
      this.#pollIntervalMs = config.polling.intervalMs;

      await this.#reconcile(workflow);

      await this.#loadStatusOptions(workflow);
      const errors = this.#validate(workflow);
      if (errors.join('\n') !== this.#dispatchErrors.join('\n') && errors.length > 0) {
        this.#logger.error('dispatch validation failed; skipping dispatch until fixed', { errors: errors.join('; ') });
      } else if (errors.length === 0 && this.#dispatchErrors.length > 0) {
        this.#logger.info('dispatch validation passes again');
      }
      this.#dispatchErrors = errors;
      if (errors.length > 0) return;

      this.#expireModelHolds();
      // The board is fetched even while the dispatch gate is closed, so the dashboard stays current.
      this.#logGate(this.#dispatchGate());
      this.#logReservationProblem(config);

      const adapter = this.#adapterFor(workflow);
      let fetched: Issue[];
      const blockedStates = this.#blockedStates(config);
      try {
        fetched = await adapter.fetchIssuesByStates([...config.tracker.activeStates, ...blockedStates]);
        this.#lastTrackerError = null;
      } catch (error) {
        this.#trackerFailure('candidate fetch failed; skipping dispatch this tick', error);
        return;
      }
      const candidates = fetched.filter((issue) => isActiveState(issue.state, config.tracker));
      // Only the first description line is kept: enough for command detection, without large texts in memory.
      const strip = (issue: Issue): Issue => ({ ...issue, description: firstLine(issue.description) });
      for (const issue of fetched) {
        const record = this.#claimed.has(issue.id) ? this.#records.get(issue.id) : undefined;
        if (record !== undefined) record.meta = issueMeta(issue);
      }
      this.#board = {
        fetchedAt: this.#clock.now(),
        candidates: candidates.map(strip),
        parked: fetched.filter((issue) => !isActiveState(issue.state, config.tracker)).map(strip),
      };

      const byId = new Map(candidates.map((issue) => [issue.id, issue]));
      await this.#startPlanned(this.#plan(config, adapter), async (item) => {
        const issue = byId.get(item.issueId);
        if (issue === undefined || !this.#shouldDispatch(issue, config, adapter)) return;
        const budget = this.#budgetExceeded(issue, this.#repositoryOf(issue), config);
        if (budget !== null) this.#pauseForBudget(issue, adapter, budget, null);
        else await this.#start(issue, null, workflow, adapter, false);
      });
    } catch (error) {
      this.#logger.error('tick failed', { error: errorMessage(error) });
    } finally {
      this.#lastTickAt = this.#clock.now();
      this.#notify();
    }
  }

  #validate(workflow: EffectiveWorkflow): string[] {
    const errors = validateDispatch(workflow, this.#deps.workflow.lastError, this.#deps.env);
    if (errors.length === 0) {
      try {
        this.#adapterFor(workflow);
      } catch (error) {
        errors.push(errorMessage(error));
      }
    }
    if (this.#statusOptionsCache?.version === workflow.version) {
      errors.push(...unknownBoardColumns(workflow.config, this.#statusOptionsCache.options));
      errors.push(...nextStageProblems(workflow.config, this.#statusOptionsCache.options));
      errors.push(...skipCheckProblems(workflow.config, this.#statusOptionsCache.options));
    } else if (errors.length === 0 && this.#adapterFor(workflow).statusOptions === undefined) {
      errors.push(...nextStageProblems(workflow.config, null)); // a tracker without columns has no board order
    }
    return errors;
  }

  /**
   * Fetches the board's status options once per workflow version (adapters without `statusOptions` skip
   * the check). A failure is a tracker error, not a validation error, and is retried on the next call.
   */
  async #loadStatusOptions(workflow: EffectiveWorkflow): Promise<void> {
    if (this.#statusOptionsCache?.version === workflow.version) return;
    let adapter: TrackerAdapter;
    try {
      adapter = this.#adapterFor(workflow);
    } catch {
      return; // reported by #validate
    }
    if (adapter.statusOptions === undefined) return;
    try {
      this.#statusOptionsCache = { version: workflow.version, options: await adapter.statusOptions() };
    } catch (error) {
      this.#trackerFailure('board status options fetch failed; skipping the column check', error);
    }
  }

  /** Columns fetched alongside the active states so the dashboard can list blocked issues. */
  #blockedStates(config: ServiceConfig): string[] {
    return blockedBucketColumns(config.roles, config.tracker.activeStates, config.tracker.terminalStates);
  }

  /** One adapter per workflow version, so a reload never changes an in-flight session's tracker. */
  #adapterFor(workflow: EffectiveWorkflow): TrackerAdapter {
    if (this.#adapterCache?.version !== workflow.version) {
      const adapter = this.#createAdapter(workflow.config, this.#deps.env, this.#logger);
      this.#adapterCache = { version: workflow.version, adapter };
    }
    return this.#adapterCache.adapter;
  }

  #workspaces(workflow: EffectiveWorkflow): WorkspaceManager {
    const { config } = workflow;
    return new WorkspaceManager(
      { root: config.workspace.root, hooks: config.hooks, workflowDir: config.workflowDir },
      this.#childEnv(config),
      this.#logger,
    );
  }

  #childEnv(config: ServiceConfig): NodeJS.ProcessEnv {
    const secrets = getTrackerFactory(config.tracker.kind)?.secretEnvironmentNames(config.tracker.provider) ?? [];
    return childEnvironment(this.#deps.env, secrets);
  }

  #trackerFailure(message: string, error: unknown): void {
    const text = errorMessage(error);
    this.#lastTrackerError = { at: this.#clock.now(), message: text };
    this.#logger.warn(message, { error: text });
  }

  // ---------------------------------------------------------------- dispatch

  /**
   * Derived from the waiting retry entries, never stored: an entry that expires, is released or restarted, or
   * a later successful turn lifts the gate by itself. Lasts until the latest `dueAt` of the gating entries.
   */
  #dispatchGate(): DispatchGate | null {
    const now = this.#clock.now().getTime();
    const since = this.#lastTurnSuccessAt?.getTime() ?? -Infinity;
    let gate: DispatchGate | null = null;
    for (const retry of this.#retries.values()) {
      const limit = retry.limit;
      if (retry.kind !== 'session_limit' || limit === null || !limit.waiting || limit.scope === 'model') continue;
      if (limit.window === null || !ACCOUNT_WIDE_WINDOWS.has(limit.window)) continue;
      if (limit.observedAt.getTime() <= since || retry.dueAt.getTime() <= now) continue;
      if (gate === null || retry.dueAt > gate.until) gate = { until: retry.dueAt, window: limit.window, issueIdentifier: retry.identifier };
    }
    return gate;
  }

  #logGate(gate: DispatchGate | null): void {
    const previous = this.#loggedGate;
    this.#loggedGate = gate;
    if (gate !== null && previous === null) {
      this.#logger.info(`dispatch paused until ${gate.until.toISOString()}: session limit (${gate.window})`, {
        window: gate.window,
        issue_identifier: gate.issueIdentifier,
      });
    } else if (gate === null && previous !== null) {
      this.#logger.info('dispatch resumed: no worker waits for an account-wide session limit any more');
    }
  }

  #logReservationProblem(config: ServiceConfig): void {
    const problem = reservationProblem(effectiveAgentLimits(config, this.#limitOverride));
    if (problem === this.#loggedReservationProblem) return;
    if (problem !== null) this.#logger.warn(problem);
    else this.#logger.info('reserved slots apply again');
    this.#loggedReservationProblem = problem;
  }

  /** Running sessions that hold a slot: all but the forced ones, which run in an extra slot each. */
  #slotted(): RunningEntry[] {
    return [...this.#running.values()].filter((entry) => !entry.forced);
  }

  #forcedCount(): number {
    return this.#running.size - this.#slotted().length;
  }

  /** Running sessions that hold a slot, by role name (`RunningEntry.role`). */
  #runningByRole(): Map<string, number> {
    const byRole = new Map<string, number>();
    for (const entry of this.#slotted()) byRole.set(entry.role, (byRole.get(entry.role) ?? 0) + 1);
    return byRole;
  }

  /** Free slots for `issue`: the total less the unused reservations of other roles, capped by its column limit. */
  #slotsFor(issue: Issue, config: ServiceConfig): number {
    const normalized = normalizeStateName(issue.state);
    const slotted = this.#slotted();
    let inState = 0;
    for (const entry of slotted) {
      if (normalizeStateName(entry.issue.state) === normalized) inState++;
    }
    const limits = effectiveAgentLimits(config, this.#limitOverride);
    const held = heldForOtherRoles(roleName(roleFor(issue, config.roles)), activeReservations(limits), this.#runningByRole());
    const free = limits.maxConcurrentAgents - slotted.length - held.slots;
    return Math.max(Math.min(free, stateLimit(issue.state, limits) - inState), 0);
  }

  #shouldDispatch(issue: Issue, config: ServiceConfig, adapter: TrackerAdapter): boolean {
    return (
      hasRequiredFields(issue) &&
      isActiveState(issue.state, config.tracker) &&
      isRoutable(issue, config.tracker) &&
      !this.#running.has(issue.id) &&
      !this.#claimed.has(issue.id) &&
      !this.#cleanups.has(issue.id) &&
      this.#slotsFor(issue, config) > 0 &&
      this.#holdFor(issue, config) === null &&
      waitingForSubIssues(issue, roleFor(issue, config.roles), adapter).length === 0
    );
  }

  /** A claimed issue as the dispatch plan sees it: its newest board fields (dispatch, run end, tick, reconcile). */
  #planIssue(issueId: string, identifier: string, state: string | null): PlanIssue {
    const meta = this.#records.get(issueId)?.meta ?? null;
    const board = meta === null ? this.#board?.candidates.find((issue) => issue.id === issueId) : undefined;
    if (board !== undefined) return board;
    return {
      id: issueId,
      identifier,
      state: state ?? meta?.state ?? '',
      priority: meta?.priority ?? null,
      created_at: meta?.createdAt ?? null,
      labels: meta?.labels ?? [],
      description: meta?.description ?? null,
    };
  }

  #planRetry(retry: RetryEntry, now: number, issue: PlanIssue | null = null): PlanRetry {
    return {
      issue: issue ?? this.#planIssue(retry.issueId, retry.identifier, null),
      kind: retry.kind,
      attempt: retry.attempt,
      dueAt: retry.dueAt,
      due: retry.kind === 'continuation' || retry.queued || retry.dueAt.getTime() <= now,
      limit: retry.limit,
    };
  }

  /**
   * The dispatch plan of the current state (src/orchestrator/dispatch-plan.ts). `fired` is a retry whose timer
   * just fired: it is out of the retry queue while it runs, and due whatever its `dueAt` says.
   */
  #plan(config: ServiceConfig, adapter: TrackerAdapter | null, fired: { retry: RetryEntry; issue: Issue } | null = null): PlanItem[] {
    const now = this.#clock.now();
    const retries = [...this.#retries.values()].map((retry) => this.#planRetry(retry, now.getTime()));
    if (fired !== null) retries.push({ ...this.#planRetry(fired.retry, now.getTime(), fired.issue), due: true });
    const gate = this.#dispatchGate();
    return planDispatch({
      config: withAgentLimits(config, this.#limitOverride),
      now,
      running: this.#slotted().map((entry) => ({ state: entry.issue.state, role: entry.role })),
      retries,
      paused: this.#pausedEntries().map((paused) => ({
        issue: this.#planIssue(paused.issueId, paused.identifier, paused.state),
        source: paused.source,
        continuations: paused.continuations,
        ...(paused.budget !== undefined ? { budget: paused.budget } : {}),
      })),
      candidates: (this.#board?.candidates ?? []).filter(
        (issue) => !this.#claimed.has(issue.id) && !this.#running.has(issue.id) && !this.#cleanups.has(issue.id),
      ),
      holds: this.#planHolds(),
      gate: gate === null ? null : { until: gate.until, window: gate.window },
      waitingForSubIssues: (issue) => (adapter === null ? [] : waitingForSubIssues(issue, roleFor(issue, config.roles), adapter)),
    });
  }

  /**
   * Starts what the plan gives a slot to, in plan order: retries that are due through the retry path (it refreshes
   * the issue first), new candidates through `startNew`. A continuation inside its short delay keeps its slot and
   * starts from its own timer.
   */
  async #startPlanned(plan: PlanItem[], startNew: ((item: PlanItem) => Promise<void>) | null): Promise<void> {
    const now = this.#clock.now().getTime();
    for (const item of plan) {
      if (this.#stopping) return;
      if (item.group !== 'next' || item.decision !== 'start') continue;
      if (item.kind === 'new') {
        await startNew?.(item);
        continue;
      }
      const retry = this.#retries.get(item.issueId);
      if (retry !== undefined && (retry.queued || retry.dueAt.getTime() <= now)) await this.#onRetryTimer(item.issueId);
    }
  }

  // ---------------------------------------------------------------- model holds

  /** The model a session for the issue runs with, as `#dispatch` chooses it: label, else complexity-based, else role, else claude.model. */
  #modelFor(issue: Pick<Issue, 'state' | 'description' | 'labels'>, config: ServiceConfig): string | null {
    const role = roleFor(issue, config.roles);
    const { complexity } = classify(issue.labels);
    return chooseModel(issue.labels, role?.claude.model ?? config.claude.model, role?.modelLabel, complexity, role?.claude.modelByComplexity ?? null).model;
  }

  /** The active hold of the model the issue would run with; null for Claude Code's default model (never held). */
  #holdFor(issue: Pick<Issue, 'state' | 'description' | 'labels'>, config: ServiceConfig): ActiveHold | null {
    const family = modelFamilyOf(this.#modelFor(issue, config));
    return family === null ? null : this.#activeHold(family);
  }

  /** What holds the model now: the operator's hold first (it has no end), else an unexpired limit hold. */
  #activeHold(family: string): ActiveHold | null {
    const operator = this.#operatorHolds.get(family);
    if (operator !== undefined) return { model: family, source: 'operator', since: operator.since, until: null };
    const limit = this.#activeLimitHold(family);
    return limit === null ? null : { model: family, source: 'limit', since: limit.since, until: limit.until };
  }

  #activeLimitHold(family: string): ModelHold | null {
    const hold = this.#modelHolds.get(family);
    return hold !== undefined && hold.until.getTime() > this.#clock.now().getTime() ? hold : null;
  }

  /** Holds as the dispatch plan reads them: an operator hold has no end (`until: null`). */
  #planHolds(): Map<string, { until: Date | null }> {
    const holds = new Map<string, { until: Date | null }>(this.#modelHolds);
    for (const family of this.#operatorHolds.keys()) holds.set(family, { until: null });
    return holds;
  }

  /** How long a retry waits for a hold: until a limit hold ends; an operator hold wakes it on release. */
  #holdDelayMs(hold: ActiveHold): number {
    return hold.until === null ? MAX_TIMER_MS : Math.max(hold.until.getTime() - this.#clock.now().getTime(), 1_000);
  }

  /** Paused issues without the ones whose agent is still stopping (they show as running until it exited). */
  #pausedEntries(): PausedEntry[] {
    return [...this.#paused.values()].filter((paused) => !this.#running.has(paused.issueId));
  }

  /**
   * Sets or extends the hold of a model after a model-scoped limit: until the reset + 60 s when the message names
   * one, else for agent.model_hold_ms. A later limit while held extends the hold, never shortens it.
   */
  #holdModelForLimit(family: string, entry: RunningEntry, text: string, resetsAt: Date | null): ModelHold {
    const now = this.#clock.now();
    const waitMs = sessionLimitWaitMs(resetsAt, now) ?? this.#deps.workflow.current.config.agent.modelHoldMs;
    const until = new Date(now.getTime() + waitMs);
    const existing = this.#activeLimitHold(family);
    const hold: ModelHold = {
      model: family,
      source: 'limit',
      since: existing?.since ?? now,
      until: existing !== null && existing.until > until ? existing.until : until,
      text,
      issueIdentifier: entry.identifier,
      repo: entry.repo,
    };
    this.#modelHolds.set(family, hold);
    this.#saveRuntimeState();
    const extended = existing !== null;
    const message = `model ${family} on hold until ${hold.until.toISOString()}`;
    this.#issueLogger(entry.issue).warn(`${message}${extended ? ' (extended)' : ''}: model limit`, { model: family, text });
    const record = this.#records.get(entry.issueId);
    if (record !== undefined) {
      this.#trace(record, {
        kind: 'lifecycle',
        event: 'model_hold',
        level: 'warn',
        message: `${message}: ${text}`,
        run: entry.runId,
        turn: null,
        detail: { model: family, since: hold.since.toISOString(), until: hold.until.toISOString(), extended, text },
      });
    }
    this.#deps.history?.note(entry.repo, 'model_hold', {
      issue: entry.identifier,
      title: entry.issue.title,
      model: family,
      since: hold.since.toISOString(),
      until: hold.until.toISOString(),
      extended,
      text,
    });
    return hold;
  }

  /** Drops the holds whose time is up; the next issue of that model is the probe. */
  #expireModelHolds(): void {
    const now = this.#clock.now();
    let changed = false;
    for (const [family, hold] of this.#modelHolds) {
      if (hold.until.getTime() > now.getTime()) continue;
      this.#modelHolds.delete(family);
      changed = true;
      this.#logger.info(`model ${family} hold ended`, { model: family, since: hold.since.toISOString(), until: hold.until.toISOString() });
      const record = [...this.#records.values()].find((candidate) => candidate.identifier === hold.issueIdentifier);
      if (record !== undefined) {
        this.#trace(record, {
          kind: 'lifecycle',
          event: 'model_hold_ended',
          level: 'info',
          message: `model ${family} hold ended`,
          run: null,
          turn: null,
          detail: { model: family, since: hold.since.toISOString(), until: hold.until.toISOString() },
        });
      }
      this.#deps.history?.note(hold.repo, 'model_hold_ended', {
        issue: hold.issueIdentifier,
        model: family,
        since: hold.since.toISOString(),
        until: hold.until.toISOString(),
      });
    }
    if (changed) this.#saveRuntimeState();
  }

  #saveRuntimeState(): void {
    this.#runtimeState.save({
      modelHolds: [...this.#modelHolds.values()],
      operatorHolds: [...this.#operatorHolds.values()],
      pausedIssues: [...this.#paused.values()]
        .filter((paused) => paused.source === 'operator')
        .map((paused) => ({ issueId: paused.issueId, identifier: paused.identifier, url: paused.url, since: paused.pausedAt })),
      settings: this.#limitOverride,
    });
  }

  #modelHoldJson(hold: ModelHold) {
    return {
      model: hold.model,
      source: hold.source,
      since: hold.since.toISOString(),
      until: hold.until.toISOString(),
      text: hold.text,
      issue_identifier: hold.issueIdentifier,
    };
  }

  #operatorHoldJson(hold: OperatorHold) {
    return { model: hold.model, source: 'operator' as const, since: hold.since.toISOString(), until: null, text: 'paused by the operator', issue_identifier: null };
  }

  /**
   * Model families in use (running, planned, or held), each with its holds, for the dashboard's Pause / Resume per model.
   */
  #modelControls(plan: PlanItem[]) {
    const families = new Set<string>([...this.#operatorHolds.keys()]);
    for (const hold of this.#modelHolds.values()) if (this.#activeLimitHold(hold.model) === hold) families.add(hold.model);
    for (const entry of this.#running.values()) {
      const family = modelFamilyOf(entry.requestedModel);
      if (family !== null) families.add(family);
    }
    for (const item of plan) {
      const family = modelFamilyOf(item.model);
      if (family !== null) families.add(family);
    }
    return MODEL_FAMILIES.filter((family) => families.has(family)).map((family) => ({
      model: family,
      paused: this.#operatorHolds.has(family),
      paused_since: this.#operatorHolds.get(family)?.since.toISOString() ?? null,
      limit_until: this.#activeLimitHold(family)?.until.toISOString() ?? null,
    }));
  }

  /**
   * Passes a stage without a session: posts the `skipped` result (comment and marker) and moves the issue on. The issue
   * stays claimed meanwhile, so no tick dispatches it; its record (and with it the timeline) lives on for the next stage.
   * A failure is logged and leaves the issue where it is: the next tick decides again.
   */
  #skipStage(issue: Issue, skip: StageSkip, workflow: EffectiveWorkflow, repo: string, adapter: Required<Pick<TrackerAdapter, 'postComment' | 'setStatus'>>): void {
    const log = this.#issueLogger(issue);
    const record = this.#record(issue);
    record.meta = issueMeta(issue);
    record.repo = repo;
    this.#claimed.add(issue.id);
    const summary = `Stage ${skip.role} skipped: ${skip.reason}. No session was started; the issue moves on to "${skip.target}".`;
    const meta: ResultMeta = {
      role: skip.role,
      run: null,
      round: null,
      profile: skip.profile,
      workflow_hash: workflow.contentHash,
      head_sha: null,
      checks: null,
      target: skip.target,
      created_at: this.#clock.now().toISOString(),
    };
    const work = (async () => {
      try {
        // A failed move leaves the issue in its column, so the next tick skips again; the comment is posted only once.
        const key = `${issue.state}\u0000${skip.target}`;
        let posted = this.#skipCommented.get(issue.id);
        if (posted?.key !== key) {
          const comment = await adapter.postComment(issue, renderResultComment(internalResult('skipped', summary), meta));
          posted = { key, url: comment.url };
          this.#skipCommented.set(issue.id, posted);
        }
        const change = await adapter.setStatus(issue, skip.target);
        this.#skipCommented.delete(issue.id);
        this.#trace(record, {
          kind: 'lifecycle',
          event: 'stage_skipped',
          level: 'info',
          message: `${skip.role} stage skipped in "${issue.state}" (${skip.reason}); moved to "${change.status}" without a session`,
          run: null,
          turn: null,
          detail: { role: skip.role, state: issue.state, target: change.status, reason: skip.reason, profile: skip.profile, comment_url: posted.url },
        });
        log.info('stage skipped', { role: skip.role, state: issue.state, target: change.status, reason: skip.reason });
        this.#deps.history?.note(repo, 'stage_skipped', { issue: issue.identifier, title: issue.title, role: skip.role, from: issue.state, to: change.status, reason: skip.reason });
      } catch (error) {
        log.warn('skipping stage failed; the issue stays', { role: skip.role, state: issue.state, target: skip.target, error: errorMessage(error) });
      } finally {
        this.#claimed.delete(issue.id);
        this.#notify();
      }
    })();
    this.#skips.add(work);
    void work.finally(() => this.#skips.delete(work));
  }

  /**
   * Starts the stage of the issue's column (`#dispatch`), unless the issue's newest result recorded a hand-off whose move
   * never happened: `#recoverTransition` then completes it without a session. Only a result-driven role on a tracker
   * that reports when the column last changed reads the results for that; its run reuses them. An operator's restart
   * (`force`) never comes here: it always runs the stage.
   */
  async #start(issue: Issue, attempt: number | null, workflow: EffectiveWorkflow, adapter: TrackerAdapter, continuation: boolean): Promise<void> {
    const role = roleFor(issue, workflow.config.roles);
    let tracked: TrackedResult[] | null = null;
    if (role?.result != null && statusUpdatedAt(issue) !== null && canRecover(adapter)) {
      try {
        tracked = await adapter.readResults(issue);
      } catch (error) {
        // The run reads them again, and fails with results_read_error when the tracker still refuses.
        this.#issueLogger(issue).debug('reading the stage results before dispatch failed', { error: errorMessage(error) });
      }
      if (this.#stopping) {
        this.#release(issue.id);
        return;
      }
      const interrupted = tracked === null ? null : interruptedTransition(issue, role, tracked);
      if (tracked !== null && interrupted !== null && this.#recoveryDeclined.get(issue.id) !== interrupted.result.url) {
        this.#recoverTransition(issue, role, interrupted, tracked, attempt, workflow, adapter);
        return;
      }
    }
    this.#dispatch(issue, attempt, workflow, adapter, continuation, false, tracked);
  }

  /**
   * Completes a hand-off whose result comment was posted but whose move did not happen (see `interruptedTransition`),
   * without a session. The issue stays claimed meanwhile. Afterwards (`#afterRecovery`) the next stage follows as a
   * continuation, like after any hand-off; a denied move or a failed entry check runs the stage instead, an issue that
   * moved meanwhile is left to the next tick, and an error is retried with backoff.
   */
  #recoverTransition(
    issue: Issue,
    role: RoleConfig,
    interrupted: InterruptedTransition,
    tracked: readonly TrackedResult[],
    attempt: number | null,
    workflow: EffectiveWorkflow,
    adapter: RecoveryAdapter,
  ): void {
    const record = this.#record(issue);
    record.meta = issueMeta(issue);
    record.repo = adapter.issueRepository?.(issue) ?? 'unknown';
    this.#claimed.add(issue.id);
    const work = (async () => {
      let outcome: RecoveryOutcome;
      try {
        outcome = await this.#completeTransition(issue, role, interrupted, tracked, workflow, adapter, record);
      } catch (error) {
        outcome = { kind: 'failed', reason: errorMessage(error) };
      }
      await this.#serial.run(() => this.#afterRecovery(issue, role, interrupted, attempt, record, outcome));
    })();
    this.#skips.add(work);
    void work.finally(() => this.#skips.delete(work));
  }

  /**
   * The move of `#recoverTransition`. It passes the transition guard like `report_result`: `may_move_to`, then the
   * target's entry check, run in the issue's workspace (the stage's work; a workspace that no longer exists declines).
   * Right before the move a fresh read confirms that the column and `status_updated_at` are unchanged, so a human's
   * move during the check is never undone. The labels follow the move (`interruptedLabels`).
   */
  async #completeTransition(
    issue: Issue,
    role: RoleConfig,
    interrupted: InterruptedTransition,
    tracked: readonly TrackedResult[],
    workflow: EffectiveWorkflow,
    adapter: RecoveryAdapter,
    record: IssueRecord,
  ): Promise<RecoveryOutcome> {
    const { config } = workflow;
    const { target } = interrupted;
    const workspaces = this.#workspaces(workflow);
    const hookIssue: HookIssue = { id: issue.id, identifier: issue.identifier, url: issue.url, branch_name: issue.branch_name, env: adapter.hookEnvironment?.(issue) ?? {} };
    let lock: Extract<LockResult, { ok: true }> | null = null;
    try {
      let workspace: Workspace | null = null;
      if (entryCheckFor(target, role, config) !== null) {
        const acquired = await workspaces.lock(issue.identifier);
        if (!acquired.ok) return { kind: 'failed', reason: `workspace locked by ${describeHolder(acquired.holder)}` };
        lock = acquired;
        workspace = await workspaces.ensure(hookIssue);
        if (workspace.createdNow) return { kind: 'declined', reason: `the entry check for "${target}" needs the stage's workspace, which no longer existed` };
        record.workspacePath = workspace.path;
        this.#watched.set(issue.id, issue.identifier);
      }
      let check: CheckRecord | null = null;
      const guard = createGuard({
        role,
        config,
        workspace,
        issue: () => hookIssue,
        manager: workspaces,
        signal: this.#halt.signal,
        onEvent: (event, message, detail) =>
          this.#trace(record, { kind: 'lifecycle', event, level: event === 'transition_denied' ? 'warn' : 'info', message, run: null, turn: null, detail }),
        onCheckFinished: (finished) => {
          check = finished;
          record.lastCheck = finished;
        },
      });
      const decision = await guard(target, RESULT_TOOL);
      if (!decision.allow) {
        const reason = `${decision.category}: ${decision.message}`;
        return decision.category === 'transition_denied' || decision.category === 'check_failed' ? { kind: 'declined', reason } : { kind: 'failed', reason };
      }
      if (this.#halt.signal.aborted) return { kind: 'failed', reason: 'orchestrator shutting down' };
      const fresh = (await adapter.fetchIssuesByIds([issue.id])).find((candidate) => candidate.id === issue.id);
      if (fresh === undefined) return { kind: 'changed', reason: 'the issue is no longer visible on the tracker' };
      if (normalizeStateName(fresh.state) !== normalizeStateName(issue.state) || statusUpdatedAt(fresh)?.toISOString() !== interrupted.statusUpdatedAt) {
        return { kind: 'changed', reason: `the issue was moved meanwhile (now in "${fresh.state}")` };
      }
      const change = await adapter.setStatus(fresh, target);
      const boardColumns = this.#statusOptionsCache?.version === workflow.version ? this.#statusOptionsCache.options : null;
      const warnings: string[] = [];
      const labels = await applyTransitionLabels(adapter, fresh, interruptedLabels(interrupted, tracked, role, config, boardColumns, fresh), warnings);
      return { kind: 'moved', status: change.status, check, labels, warnings };
    } finally {
      await lock?.release().catch((error: unknown) => this.#issueLogger(issue).warn('workspace lock could not be released', { error: errorMessage(error) }));
    }
  }

  /** What follows a transition recovery; see `#recoverTransition`. Runs in the serial queue. */
  #afterRecovery(issue: Issue, role: RoleConfig, interrupted: InterruptedTransition, attempt: number | null, record: IssueRecord, outcome: RecoveryOutcome): void {
    const log = this.#issueLogger(issue);
    const from = issue.state;
    const { target } = interrupted;
    const comment = interrupted.result.url;
    const retryInfo = { identifier: issue.identifier, url: issue.url, limit: null };
    const trace = (event: string, level: TimelineEvent['level'], message: string, detail: Record<string, unknown>) =>
      this.#trace(record, { kind: 'lifecycle', event, level, message, run: null, turn: null, detail: { role: role.name, from, target, comment_url: comment, ...detail } });
    if (outcome.kind === 'moved') {
      this.#recoveryDeclined.delete(issue.id);
      // A hand-off is progress, as after a run whose result moved the issue.
      record.continuations = 0;
      trace('transition_recovered', 'info', `completed the interrupted move of the ${role.name} result from "${from}" to "${outcome.status}" without a session`, {
        status: outcome.status,
        check: outcome.check?.result ?? null,
        labels: outcome.labels,
        ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
      });
      log.info('interrupted transition completed', { role: role.name, from, target: outcome.status, comment_url: comment });
      this.#deps.history?.note(record.repo ?? 'unknown', 'transition_recovered', { issue: issue.identifier, title: issue.title, role: role.name, from, to: outcome.status, comment_url: comment });
    } else if (outcome.kind === 'declined') {
      this.#recoveryDeclined.set(issue.id, comment);
      trace('transition_recovery_declined', 'warn', `the interrupted move to "${target}" was not completed (${outcome.reason}); the ${role.name} stage runs again`, { reason: outcome.reason });
      log.warn('interrupted transition not completed; the stage runs again', { role: role.name, from, target, reason: outcome.reason });
    } else if (outcome.kind === 'changed') {
      log.info('interrupted transition left alone', { role: role.name, from, target, reason: outcome.reason });
    } else {
      record.lastError = `transition recovery failed: ${outcome.reason}`;
      log.warn('completing the interrupted transition failed; retrying', { role: role.name, from, target, error: outcome.reason });
    }
    if (this.#stopping) {
      this.#release(issue.id);
    } else if (this.#paused.has(issue.id)) {
      // The operator paused the issue meanwhile: the claim stays until Resume.
    } else if (outcome.kind === 'moved') {
      this.#scheduleRetry(issue.id, 1, { ...retryInfo, kind: 'continuation', error: null });
    } else if (outcome.kind === 'failed') {
      this.#scheduleRetry(issue.id, (attempt ?? 0) + 1, { ...retryInfo, kind: 'failure', error: `transition recovery failed: ${outcome.reason}` });
    } else {
      // The next tick decides afresh: it runs the declined stage, or whatever the issue's new column needs.
      this.#claimed.delete(issue.id);
      this.requestRefresh();
    }
    this.#notify();
  }

  #dispatch(
    issue: Issue,
    attempt: number | null,
    workflow: EffectiveWorkflow,
    adapter: TrackerAdapter,
    continuation = false,
    forced = false,
    results: readonly TrackedResult[] | null = null,
  ): void {
    const log = this.#issueLogger(issue);
    const controller = new AbortController();
    const config = workflow.config;
    const role = roleFor(issue, config.roles);
    const name = roleName(role);
    // A fresh stage the profile or a condition leaves out costs no session. Restarts by the operator, retries and
    // continuations of a stage that already ran are never skipped.
    if (!forced && !continuation && attempt === null) {
      const skip = stageSkip(issue, role, config, this.#statusOptionsCache?.version === workflow.version ? this.#statusOptionsCache.options : null);
      if (skip !== null && adapter.postComment !== undefined && adapter.setStatus !== undefined) {
        this.#skipStage(issue, skip, workflow, adapter.issueRepository?.(issue) ?? 'unknown', { postComment: adapter.postComment.bind(adapter), setStatus: adapter.setStatus.bind(adapter) });
        return;
      }
    }
    const runId = randomUUID().replace(/-/g, '').slice(0, 12);
    const entry: RunningEntry = {
      issueId: issue.id,
      identifier: issue.identifier,
      repo: adapter.issueRepository?.(issue) ?? 'unknown',
      runId,
      role: name,
      roleConfig: role,
      resultRecorded: false,
      resultMoved: false,
      forced,
      runLog: log.child({ run_id: runId, role: name }),
      issue,
      attempt,
      startedAt: this.#clock.now(),
      startedAtMs: this.#clock.monotonicMs(),
      preparedAtMs: null,
      phase: 'PreparingWorkspace',
      workspacePath: null,
      model: null,
      requestedModel: null,
      effort: null,
      sessionId: null,
      threadId: null,
      turnId: null,
      turnCount: 0,
      pid: null,
      lastEvent: null,
      lastEventAt: null,
      lastEventAtMs: null,
      lastMessage: null,
      tokens: ZERO_USAGE,
      reported: ZERO_USAGE,
      costUsd: 0,
      reportedCostUsd: 0,
      claudeEstimateUsd: 0,
      modelUsage: {},
      mcpUnavailable: [],
      pendingStart: null,
      mcpToolCalls: {},
      toolUsage: emptyToolUsage(),
      integrations: [],
      sessionSkills: null,
      headSha: null,
      branch: null,
      controller,
      stop: null,
      done: Promise.resolve(),
    };
    this.#running.set(issue.id, entry);
    this.#claimed.add(issue.id);
    this.#cancelRetry(issue.id);
    const record = this.#record(issue);
    record.runs++;
    if (continuation) record.continuations++;
    record.repo = entry.repo;
    record.meta = issueMeta(issue);
    // A "Model: <model>" label picks the model for this run, else model_by_complexity, else the role's claude.model, else claude.model.
    const { complexity } = classify(issue.labels);
    const choice = chooseModel(issue.labels, role?.claude.model ?? config.claude.model, role?.modelLabel, complexity, role?.claude.modelByComplexity ?? null);
    // Likewise an "Effort: <level>" label picks the effort, else the role's claude.effort, else claude.effort.
    const effortChoice = chooseEffort(issue.labels, role?.claude.effort ?? config.claude.effort);
    entry.requestedModel = choice.model;
    entry.effort = effortChoice.effort;
    record.sessions.push({
      run: runId,
      attempt,
      role: name,
      state: issue.state,
      model: choice.model,
      effort: effortChoice.effort,
      startedAt: entry.startedAt,
      finishedAt: null,
      outcome: null,
      transcript: null,
    });
    if (record.sessions.length > MAX_SESSIONS) record.sessions.shift();
    this.#trace(record, {
      kind: 'lifecycle',
      event: 'run_dispatched',
      level: 'info',
      message: `${continuation ? 'continuation session' : attempt === null ? 'session' : `retry attempt ${attempt}`} started as ${name} in "${issue.state}"`,
      run: runId,
      turn: null,
      detail: {
        attempt,
        role: name,
        state: issue.state,
        model: choice.model,
        model_label: choice.label,
        model_label_ignored: choice.labelIgnored,
        model_source: choice.source,
        complexity,
        effort: effortChoice.effort,
        effort_label: effortChoice.label,
        continuation,
        forced,
      },
    });
    if (choice.warning !== null) log.warn('model label ignored', { warning: choice.warning, model: choice.model ?? 'Claude Code default' });
    if (effortChoice.warning !== null) {
      log.warn('effort label ignored', { warning: effortChoice.warning, effort: effortChoice.effort ?? 'Claude Code default' });
    }
    log.info('dispatching issue', {
      state: issue.state,
      attempt,
      continuation: continuation ? record.continuations : undefined,
      forced: forced || undefined,
      role: entry.role,
      model: choice.model ?? 'Claude Code default',
      model_label: choice.label ?? undefined,
      effort: effortChoice.effort ?? 'Claude Code default',
      effort_label: effortChoice.label ?? undefined,
      title: truncate(issue.title, 120),
    });
    entry.pendingStart = {
      repo: entry.repo,
      issue: issue.identifier,
      title: issue.title,
      state: issue.state,
      attempt,
      model: choice.model,
      effort: effortChoice.effort,
      role: entry.role,
      run: entry.runId,
      at: entry.startedAt,
    };

    let worker: Promise<WorkerOutcome>;
    try {
      worker = runAgentAttempt({
        issue,
        ...(results !== null ? { results } : {}),
        runId,
        attempt,
        workflow,
        model: choice.model,
        effort: effortChoice.effort,
        role,
        adapter,
        runner: this.#deps.runner,
        integrations: this.#deps.integrations ?? defaultIntegrations(),
        workspaces: this.#workspaces(workflow),
        childEnv: this.#childEnv(config),
        logger: log,
        signal: controller.signal,
        checkCache: record.checkCache,
        transcriptDir: this.#deps.logDir === null ? null : path.join(this.#deps.logDir, 'sessions'),
        continueWith: (fresh) => {
          const current = this.#deps.workflow.current.config;
          if (!isActiveState(fresh.state, current.tracker)) return `issue left the active states ("${fresh.state}")`;
          if (!isRoutable(fresh, current.tracker)) return 'issue is no longer dispatchable (assignee, blockers or labels)';
          const nextRole = roleFor(fresh, current.roles);
          const next = roleName(nextRole);
          if (next !== entry.role) return `role changed (${entry.role} → ${next})`;
          // The role's work for now is done: it starts again once these sub-issues are closed.
          const waiting = waitingForSubIssues(fresh, nextRole, adapter);
          return waiting.length > 0 ? `waiting for sub-issues ${waiting.join(', ')}` : null;
        },
        callbacks: {
          phase: (phase) => {
            if (entry.phase === 'PreparingWorkspace' && phase !== 'PreparingWorkspace') entry.preparedAtMs = this.#clock.monotonicMs();
            // The stall clock starts fresh after a check; the agent was waiting for its tool call meanwhile.
            if (entry.phase === 'RunningChecks' && phase !== 'RunningChecks') entry.lastEventAtMs = this.#clock.monotonicMs();
            if (entry.phase !== phase && this.#running.get(entry.issueId) === entry) {
              this.#trace(record, {
                kind: 'phase',
                event: 'phase',
                level: 'debug',
                message: `${entry.phase} → ${phase}`,
                run: runId,
                turn: entry.turnCount,
                detail: { from: entry.phase, to: phase },
              });
            }
            entry.phase = phase;
          },
          transcript: (file) => {
            const session = record.sessions.find((candidate) => candidate.run === runId);
            if (session !== undefined) session.transcript = file;
          },
          workspace: (workspace) => {
            entry.workspacePath = workspace.path;
            record.workspacePath = workspace.path;
            this.#watched.set(issue.id, issue.identifier);
          },
          agentEvent: (event) => this.#onAgentEvent(entry, event),
          gitHead: (head) => {
            entry.headSha = head.headSha;
            entry.branch = head.branch;
          },
          issueRefreshed: (fresh) => {
            if (this.#running.get(entry.issueId) === entry) entry.issue = fresh;
          },
          integrationsPrepared: (fields, reports) => {
            entry.integrations = reports;
            this.#flushStart(entry, fields);
          },
          mcpUnavailable: (servers) => {
            entry.mcpUnavailable = servers;
          },
          resultRecorded: () => {
            entry.resultRecorded = true;
          },
          resultMoved: () => {
            entry.resultMoved = true;
          },
          checkFinished: (check) => {
            record.lastCheck = check;
            this.#deps.history?.checkFinished({
              repo: entry.repo,
              issue: entry.identifier,
              run: entry.runId,
              role: check.role,
              target: check.target,
              sha: check.sha,
              exitCode: check.exitCode,
              timedOut: check.timedOut,
              durationMs: check.durationMs,
              ok: check.ok,
              result: check.result,
              at: check.finishedAt,
            });
          },
          results: (results) => {
            record.results = results;
          },
          transitionDenied: (target, message) => {
            this.#deps.history?.transitionDenied({
              repo: entry.repo,
              issue: entry.identifier,
              run: entry.runId,
              role: entry.role,
              target,
              reason: message,
              at: this.#clock.now(),
            });
          },
        },
      });
    } catch (error) {
      this.#flushStart(entry);
      this.#running.delete(issue.id);
      record.sessionLimitHits = 0;
      this.#scheduleRetry(issue.id, (attempt ?? 0) + 1, {
        identifier: issue.identifier,
        url: issue.url,
        kind: 'failure',
        error: `failed to spawn agent: ${errorMessage(error)}`,
        limit: null,
      });
      return;
    }
    entry.done = worker.then(
      (outcome) => this.#serial.run(() => this.#onWorkerExit(entry, outcome)),
      (error: unknown) =>
        this.#serial.run(() =>
          this.#onWorkerExit(entry, { kind: 'failed', code: 'worker_crashed', message: errorMessage(error), phase: entry.phase }),
        ),
    );
  }

  #onWorkerExit(entry: RunningEntry, outcome: WorkerOutcome): void {
    if (this.#running.get(entry.issueId) !== entry) return;
    this.#running.delete(entry.issueId);
    const agentSeconds = (this.#clock.monotonicMs() - entry.startedAtMs) / 1000;
    this.#totals.endedSeconds += agentSeconds;
    const result = this.#runResult(entry, outcome);
    this.#recordRun(entry, result, agentSeconds);
    const finished = this.#records.get(entry.issueId);
    if (finished) {
      finished.lastRun = traceOf(entry);
      // A hand-off with a result is progress, not a loop: the round limits bound result-driven hand-offs. A result
      // whose move failed is none, so a move that keeps failing ends at max_continuations instead of looping.
      if (entry.resultMoved) finished.continuations = 0;
      // The worker refreshes the issue after each turn: the column it ended in decides what comes next.
      finished.meta = issueMeta(entry.issue);
      const session = finished.sessions.find((candidate) => candidate.run === entry.runId);
      if (session !== undefined) {
        session.finishedAt = this.#clock.now();
        session.outcome = result.result;
      }
      this.#trace(finished, {
        kind: 'lifecycle',
        event: 'run_finished',
        level: result.result === 'failed' || result.result === 'stalled' ? 'error' : result.result === 'continuing' || result.result === 'handed_off' ? 'info' : 'warn',
        message: `${result.result}: ${result.reason}`,
        run: entry.runId,
        turn: entry.turnCount,
        detail: {
          outcome: result.result,
          reason: result.reason,
          ...(outcome.kind === 'failed' ? { code: outcome.code, phase: outcome.phase } : {}),
          ...(result.nextRole !== undefined ? { next_role: result.nextRole } : {}),
          state: entry.issue.state,
          turns: entry.turnCount,
          agent_seconds: Math.round(agentSeconds * 10) / 10,
          tokens: tokensJson(entry.tokens),
          cost_usd: Math.round(entry.costUsd * 10_000) / 10_000,
          model: primaryModelOf(entry.modelUsage) ?? entry.model,
        },
      });
      // A snapshot on disk, so the detail view survives a restart even before the issue is released.
      this.#archive.save(this.#archivedOf(entry.issueId, finished, false));
    }
    const log = this.#issueLogger(entry.issue);
    const record = this.#records.get(entry.issueId);
    const nextAttempt = (entry.attempt ?? 0) + 1;
    const stop = entry.stop;
    const retryInfo = { identifier: entry.identifier, url: entry.issue.url, limit: null };
    // Every run that ends without a session limit starts the count again.
    const sessionLimit = stop === null && outcome.kind === 'failed' ? (outcome.sessionLimit ?? null) : null;
    if (record && sessionLimit === null) record.sessionLimitHits = 0;

    if (stop !== null) {
      if (stop.kind === 'stalled' && !this.#stopping) {
        entry.phase = 'Stalled';
        if (record) record.lastError = stop.reason;
        log.warn('stalled agent stopped; retrying', { reason: stop.reason });
        this.#scheduleRetry(entry.issueId, nextAttempt, { ...retryInfo, kind: 'failure', error: `stalled: ${stop.reason}` });
      } else if (stop.kind === 'paused' && this.#paused.has(entry.issueId)) {
        // Keeps the claim and the pause; no retry until Resume.
        entry.phase = 'CanceledByReconciliation';
        log.info('agent stopped; issue paused by the operator', { reason: stop.reason });
      } else if (stop.kind === 'model_hold' && !this.#stopping) {
        // Waits for the release of the model; never runs on another model meanwhile.
        entry.phase = 'CanceledByReconciliation';
        log.info('agent stopped; waiting for the model hold to end', { reason: stop.reason });
        const family = modelFamilyOf(entry.requestedModel);
        const hold = family === null ? null : this.#activeHold(family);
        this.#scheduleRetry(entry.issueId, entry.attempt ?? 1, { ...retryInfo, kind: 'failure', error: stop.reason }, hold === null ? 0 : this.#holdDelayMs(hold));
      } else {
        entry.phase = 'CanceledByReconciliation';
        log.info('agent stopped', { reason: stop.reason, cleanup_workspace: stop.cleanupWorkspace });
        this.#release(entry.issueId);
        if (stop.cleanupWorkspace) this.#cleanupWorkspace(entry.issue);
      }
      this.#notify();
      return;
    }

    if (this.#stopping) {
      this.#release(entry.issueId);
    } else if (outcome.kind === 'normal') {
      entry.phase = 'Succeeded';
      this.#completed.add(entry.issueId);
      log.info('agent run finished', { turns: outcome.turns, reason: outcome.reason });
      const missing = outcome.missingResult === true && !entry.resultRecorded ? entry.roleConfig : null;
      if (missing?.onMissingResult != null) {
        // The claim stays until the check has decided: continue as before, or end the stage.
        void this.#serial.run(() => this.#endStageWithoutResult(entry, missing, retryInfo));
      } else {
        this.#scheduleRetry(entry.issueId, 1, { ...retryInfo, kind: 'continuation', error: null });
      }
    } else if (outcome.kind === 'cancelled') {
      entry.phase = 'CanceledByReconciliation';
      this.#release(entry.issueId);
    } else {
      entry.phase = outcome.code === 'turn_timeout' ? 'TimedOut' : 'Failed';
      const error = `${outcome.code}: ${outcome.message}`;
      if (record) record.lastError = error;
      log.warn('agent run failed', { code: outcome.code, phase: outcome.phase, error: outcome.message });
      if (sessionLimit !== null && record) {
        const hits = ++record.sessionLimitHits;
        const config = this.#deps.workflow.current.config;
        const maxRetries = config.agent.maxSessionLimitRetries;
        // An invalid reset time counts as unknown (and would break toISOString()).
        const resetsAtDate = sessionLimit.resetsAt !== null && Number.isFinite(sessionLimit.resetsAt.getTime()) ? sessionLimit.resetsAt : null;
        const limit: SessionLimitState = {
          window: sessionLimit.window,
          scope: sessionLimit.scope,
          model: sessionLimit.model,
          resetsAt: resetsAtDate,
          source: sessionLimit.source,
          text: sessionLimit.text,
          hits,
          maxRetries,
          waiting: false,
          overageDisabledReason: sessionLimit.overageDisabledReason,
          observedAt: this.#clock.now(),
        };
        // A model limit holds its model and the issue waits for the end of the hold: it is not transient, so no
        // quick retries. Otherwise, within the cap the backoff follows the session-limit count; beyond it the retry
        // waits for the reset, or, without a usable reset time, the usual attempt-based backoff applies.
        const now = this.#clock.now();
        const waitMs = hits > maxRetries ? sessionLimitWaitMs(resetsAtDate, now) : null;
        let delayMs: number;
        if (sessionLimit.scope === 'model' && sessionLimit.model !== null) {
          const hold = this.#holdModelForLimit(sessionLimit.model, entry, sessionLimit.text, resetsAtDate);
          limit.waiting = true;
          delayMs = Math.max(hold.until.getTime() - now.getTime(), 0);
        } else if (waitMs !== null) {
          limit.waiting = true;
          delayMs = waitMs;
          const retryAt = new Date(now.getTime() + waitMs).toISOString();
          const resetsAt = resetsAtDate?.toISOString() ?? null;
          log.warn('session limit: retries used up; waiting for the reset', { window: sessionLimit.window, resets_at: resetsAt, retry_at: retryAt, hits });
          this.#trace(record, {
            kind: 'lifecycle',
            event: 'session_limit_wait',
            level: 'warn',
            message: `session limit: retries used up; waiting for the reset until ${retryAt}`,
            run: entry.runId,
            turn: null,
            detail: { window: sessionLimit.window, resets_at: resetsAt, retry_at: retryAt, source: sessionLimit.source, hits, max_retries: maxRetries },
          });
          this.#deps.history?.note(entry.repo, 'session_limit_wait', {
            issue: entry.identifier,
            title: entry.issue.title,
            state: entry.issue.state,
            window: sessionLimit.window,
            resets_at: resetsAt,
            retry_at: retryAt,
            hits,
            max_retries: maxRetries,
            source: sessionLimit.source,
          });
        } else {
          if (hits > maxRetries) {
            log.warn('session limit: reset time unknown; retrying with backoff', {
              window: sessionLimit.window,
              resets_at: resetsAtDate?.toISOString() ?? null,
              hits,
            });
          }
          delayMs = failureBackoffMs(hits <= maxRetries ? hits : nextAttempt, config.agent.maxRetryBackoffMs);
        }
        this.#scheduleRetry(entry.issueId, nextAttempt, { ...retryInfo, kind: 'session_limit', error: `worker exited: ${error}`, limit }, delayMs);
      } else {
        this.#scheduleRetry(entry.issueId, nextAttempt, { ...retryInfo, kind: 'failure', error: `worker exited: ${error}` });
      }
    }
    this.#notify();
  }

  /**
   * A run of a result-driven role ended without a result (after the reminder, or at the turn limit). Only after a
   * fresh fetch confirms the issue is still in the role's column does Symphony comment and move it to the role's
   * `on_missing_result`, then release it. An issue moved meanwhile (a human, another run) is left alone and the
   * normal continuation follows; a tracker error is retried like a failed run.
   */
  async #endStageWithoutResult(
    entry: RunningEntry,
    role: RoleConfig,
    retryInfo: { identifier: string; url: string | null; limit: null },
  ): Promise<void> {
    const issueId = entry.issueId;
    const target = role.onMissingResult;
    // A stop, pause or release in between has already dealt with the issue.
    if (target === null || this.#running.has(issueId) || this.#retries.has(issueId) || !this.#claimed.has(issueId) || this.#paused.has(issueId)) return;
    if (this.#stopping) {
      this.#release(issueId);
      return;
    }
    const log = this.#issueLogger(entry.issue);
    const resume = (error: string | null) =>
      this.#scheduleRetry(issueId, error === null ? 1 : (entry.attempt ?? 0) + 1, { ...retryInfo, kind: error === null ? 'continuation' : 'failure', error });
    const adapter = this.#adapterFor(this.#deps.workflow.current);
    let fresh: Issue | undefined;
    try {
      fresh = (await adapter.fetchIssuesByIds([issueId])).find((candidate) => candidate.id === issueId);
    } catch (error) {
      log.warn('could not confirm the column of a stage that ended without a result', { error: errorMessage(error) });
      resume(`missing-result check failed: ${errorMessage(error)}`);
      return;
    }
    if (this.#stopping) {
      this.#release(issueId);
      return;
    }
    if (fresh === undefined || !role.states.includes(normalizeStateName(fresh.state))) {
      log.info('stage ended without a result, but the issue has moved on; not moving it again', { state: fresh?.state ?? null });
      resume(null);
      return;
    }
    if (adapter.setStatus === undefined) {
      resume(`the ${adapter.kind} tracker cannot move issues`);
      return;
    }
    const body =
      `**Stage ended without a result.** The ${role.name} session for "${fresh.state}" ended without calling ` +
      `\`report_result\` (after ${entry.turnCount} turn${entry.turnCount === 1 ? '' : 's'}), so Symphony moved the issue to "${target}" (\`roles.${role.name}.on_missing_result\`). A human needs to look at it.`;
    try {
      await adapter.postComment?.(fresh, body);
    } catch (error) {
      // The move matters more than the note: an issue left in the column would start the same stage again.
      log.warn('could not post the missing-result comment', { error: errorMessage(error) });
    }
    try {
      await adapter.setStatus(fresh, target);
    } catch (error) {
      log.warn('could not move the issue after a stage ended without a result', { target, error: errorMessage(error) });
      resume(`moving the issue to "${target}" failed: ${errorMessage(error)}`);
      return;
    }
    log.warn('stage ended without a result; issue moved', { from: fresh.state, to: target, role: role.name });
    const record = this.#records.get(issueId);
    if (record !== undefined) {
      this.#trace(record, {
        kind: 'lifecycle',
        event: 'missing_result',
        level: 'warn',
        message: `stage ended without a result; moved from "${fresh.state}" to "${target}"`,
        run: entry.runId,
        turn: entry.turnCount,
        detail: { role: role.name, from: fresh.state, to: target },
      });
    }
    this.#release(issueId);
    this.#notify();
  }

  /** Writes the pending `run_started` line (once), with fields the integrations added. */
  #flushStart(entry: RunningEntry, extra: Record<string, string> = {}): void {
    const start = entry.pendingStart;
    if (start === null) return;
    entry.pendingStart = null;
    this.#deps.history?.runStarted({ ...start, extra });
  }

  /** How a run ended, as the repository history and the timeline report it. */
  #runResult(entry: RunningEntry, outcome: WorkerOutcome): { result: RunOutcome; reason: string; nextRole?: string } {
    const config = this.#deps.workflow.current.config;
    let result: RunOutcome;
    let reason: string;
    let nextRole: string | undefined;
    if (entry.stop !== null) {
      result = entry.stop.kind === 'stalled' ? 'stalled' : entry.stop.kind === 'shutdown' ? 'shutdown' : 'stopped';
      reason = entry.stop.reason;
    } else if (outcome.kind === 'normal') {
      result = isActiveState(entry.issue.state, config.tracker) ? 'continuing' : 'handed_off';
      reason = outcome.reason;
      if (result === 'continuing') {
        // Moved to a column served by another role: the next session runs as that role.
        const next = roleName(roleFor(entry.issue, config.roles));
        if (next !== entry.role) {
          result = 'handed_off';
          nextRole = next;
        }
      }
    } else if (outcome.kind === 'cancelled') {
      result = 'stopped';
      reason = outcome.message;
    } else {
      result = outcome.sessionLimit ? 'session_limit' : 'failed';
      reason = `${outcome.code}: ${outcome.message}`;
    }
    return nextRole === undefined ? { result, reason } : { result, reason, nextRole };
  }

  /** Writes the finished run to the repository history. */
  #recordRun(entry: RunningEntry, { result, reason, nextRole }: { result: RunOutcome; reason: string; nextRole?: string }, agentSeconds: number): void {
    this.#flushStart(entry);
    const history = this.#deps.history;
    if (history === null || history === undefined) return;
    history.runFinished({
      repo: entry.repo,
      issue: entry.identifier,
      title: entry.issue.title,
      run: entry.runId,
      session: entry.threadId,
      attempt: entry.attempt,
      outcome: result,
      role: entry.role,
      ...(nextRole !== undefined ? { nextRole } : {}),
      state: entry.issue.state,
      reason,
      turns: entry.turnCount,
      startedAt: entry.startedAt,
      finishedAt: this.#clock.now(),
      agentSeconds,
      modelRequested: entry.requestedModel,
      effort: entry.effort,
      usage: entry.modelUsage,
      claudeEstimateUsd: entry.claudeEstimateUsd > 0 ? entry.claudeEstimateUsd : null,
      mcpUnavailable: entry.mcpUnavailable,
      headSha: entry.headSha,
      branch: entry.branch,
      mcpToolCalls: entry.mcpToolCalls,
      toolCalls: entry.toolUsage.tools,
      skillCalls: entry.toolUsage.skills,
      agentCalls: entry.toolUsage.agents,
      integrations: entry.integrations.map((report) => ({ id: report.id, status: report.status, ...integrationUsage(report, entry.toolUsage) })),
    });
  }

  #repositoryOf(issue: Issue): string {
    try {
      return this.#adapterFor(this.#deps.workflow.current).issueRepository?.(issue) ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  // ---------------------------------------------------------------- retries

  #scheduleRetry(
    issueId: string,
    attempt: number,
    info: { identifier: string; url: string | null; kind: RetryEntry['kind']; error: string | null; limit: SessionLimitState | null; queued?: boolean },
    delayMs?: number,
  ): void {
    if (this.#stopping) {
      this.#release(issueId);
      return;
    }
    this.#cancelRetry(issueId);
    const delay =
      delayMs ??
      (info.kind === 'continuation'
        ? CONTINUATION_DELAY_MS
        : failureBackoffMs(attempt, this.#deps.workflow.current.config.agent.maxRetryBackoffMs));
    const timer = this.#timers.setTimeout(() => void this.#serial.run(() => this.#onRetryTimer(issueId)), Math.min(delay, MAX_TIMER_MS));
    this.#retries.set(issueId, {
      issueId,
      identifier: info.identifier,
      url: info.url,
      attempt,
      kind: info.kind,
      dueAtMs: this.#clock.monotonicMs() + delay,
      dueAt: new Date(this.#clock.now().getTime() + delay),
      error: info.error,
      limit: info.limit,
      queued: info.queued ?? false,
      timer,
    });
    this.#claimed.add(issueId);
    const record = this.#records.get(issueId);
    const last = record?.timeline.at(-1);
    const repeated =
      last?.event === 'retry_scheduled' && last.detail?.attempt === attempt && last.detail?.kind === info.kind && last.detail?.error === info.error;
    if (record !== undefined && !repeated) {
      this.#trace(record, {
        kind: 'lifecycle',
        event: 'retry_scheduled',
        level: info.kind === 'continuation' ? 'info' : 'warn',
        message:
          info.kind === 'continuation'
            ? `continuation in ${Math.round(delay / 1000)}s`
            : info.kind === 'session_limit' && info.limit?.waiting
              ? `session limit: waiting for the reset, retry in ${Math.round(delay / 1000)}s`
              : info.kind === 'session_limit' && info.limit !== null
              ? `session limit: retry ${info.limit.hits} of ${info.limit.maxRetries} in ${Math.round(delay / 1000)}s`
              : `retry ${attempt} in ${Math.round(delay / 1000)}s: ${info.error ?? 'unknown error'}`,
        run: null,
        turn: null,
        detail: {
          attempt,
          kind: info.kind,
          delay_ms: delay,
          due_at: new Date(this.#clock.now().getTime() + delay).toISOString(),
          error: info.error,
          limit: limitJson(info.limit),
        },
      });
    }
    this.#logger.info('retry scheduled', {
      issue_id: issueId,
      issue_identifier: info.identifier,
      attempt,
      kind: info.kind,
      delay_ms: delay,
      error: info.error,
    });
  }

  #cancelRetry(issueId: string): void {
    const retry = this.#retries.get(issueId);
    if (retry === undefined) return;
    this.#timers.clearTimeout(retry.timer);
    this.#retries.delete(issueId);
  }

  async #onRetryTimer(issueId: string): Promise<void> {
    const retry = this.#retries.get(issueId);
    if (retry === undefined) return;
    // A tick may start a due retry before its timer fires.
    this.#timers.clearTimeout(retry.timer);
    this.#retries.delete(issueId);
    if (this.#paused.has(issueId)) return;
    if (this.#stopping) {
      this.#release(issueId);
      return;
    }
    if (retry.kind === 'session_limit' && retry.limit?.waiting) {
      // The timer fired early (wall-clock jump, suspend) or was clamped: keep waiting for the remaining time.
      const remainingMs = retry.dueAt.getTime() - this.#clock.now().getTime();
      if (remainingMs > 1_000) {
        this.#scheduleRetry(
          issueId,
          retry.attempt,
          { identifier: retry.identifier, url: retry.url, kind: retry.kind, error: retry.error, limit: retry.limit },
          remainingMs,
        );
        return;
      }
    }
    // A session-limit retry keeps its kind and limit; any other kind is requeued as a failure, as before.
    // A woken waiting entry is past its reset: it now waits for a short backoff, not for the reset again.
    const limit = retry.limit?.waiting ? { ...retry.limit, waiting: false } : retry.limit;
    const requeue = (error: string) =>
      this.#scheduleRetry(issueId, retry.attempt + 1, {
        identifier: retry.identifier,
        url: retry.url,
        kind: retry.kind === 'session_limit' ? 'session_limit' : 'failure',
        error,
        limit,
      });

    const workflow = this.#deps.workflow.current;
    const config = workflow.config;
    let adapter: TrackerAdapter;
    let refreshed: Issue[];
    try {
      adapter = this.#adapterFor(workflow);
      refreshed = await adapter.fetchIssuesByIds([issueId]);
    } catch (error) {
      requeue(`retry refresh failed: ${errorMessage(error)}`);
      return;
    }
    if (this.#stopping) {
      this.#release(issueId);
      return;
    }

    const issue = refreshed.find((candidate) => candidate.id === issueId);
    const log = this.#logger.child({ issue_id: issueId, issue_identifier: issue?.identifier ?? retry.identifier });
    if (issue === undefined) {
      log.info('issue no longer visible; releasing claim');
      this.#release(issueId);
      return;
    }
    if (isTerminalState(issue.state, config.tracker)) {
      log.info('issue is terminal; releasing claim', { state: issue.state, cleanup_workspace: config.workspace.cleanupTerminal });
      this.#release(issueId);
      if (config.workspace.cleanupTerminal) this.#cleanupWorkspace(issue);
      return;
    }
    if (!hasRequiredFields(issue) || !isActiveState(issue.state, config.tracker) || !isRoutable(issue, config.tracker)) {
      log.info('issue no longer eligible; releasing claim', { state: issue.state, dispatchable: issue.dispatchable });
      this.#release(issueId);
      return;
    }
    const waiting = waitingForSubIssues(issue, roleFor(issue, config.roles), adapter);
    if (waiting.length > 0) {
      // Not a pause: the next tick dispatches the issue again once its sub-issues are closed.
      log.info('issue waits for its open sub-issues; releasing claim', { sub_issues: waiting.join(', ') });
      this.#release(issueId);
      return;
    }
    const continuations = this.#records.get(issueId)?.continuations ?? 0;
    const maxContinuations = config.agent.maxContinuations;
    if (retry.kind === 'continuation' && maxContinuations !== null && continuations >= maxContinuations) {
      this.#pause(issue, continuations, maxContinuations);
      return;
    }
    const budget = this.#budgetExceeded(issue, this.#repositoryOf(issue), config);
    if (budget !== null) {
      this.#pauseForBudget(issue, adapter, budget, retry.attempt);
      return;
    }
    await this.#loadStatusOptions(workflow);
    if (this.#stopping) {
      this.#release(issueId);
      return;
    }
    const errors = this.#validate(workflow);
    if (errors.length > 0) {
      requeue(`dispatch validation failed: ${errors[0]}`);
      return;
    }
    const hold = this.#holdFor(issue, config);
    if (hold !== null) {
      // The model is on hold (also for an operator restart): wait for its end, keep kind, attempt and limit.
      const error = hold.until === null ? `model ${hold.model} paused by the operator` : `model ${hold.model} on hold until ${hold.until.toISOString()}`;
      this.#scheduleRetry(issueId, retry.attempt, { identifier: retry.identifier, url: retry.url, kind: retry.kind, error, limit: retry.limit }, this.#holdDelayMs(hold));
      return;
    }
    const plan = this.#plan(config, adapter, { retry, issue });
    const index = plan.findIndex((item) => item.issueId === issueId);
    const item = plan[index];
    if (item !== undefined && item.decision === 'wait') {
      // No slot for it (a column limit, or the plan gives the free slot to work ahead of it): not a failure. Keep
      // kind and attempt; it keeps competing for the next free slot, at the latest after one poll interval.
      this.#scheduleRetry(
        issueId,
        retry.attempt,
        { identifier: retry.identifier, url: retry.url, kind: retry.kind, error: item.reason.text, limit, queued: true },
        config.polling.intervalMs,
      );
      // Start the due work the slot went to now instead of at its own timer.
      await this.#startPlanned(plan.slice(0, index), null);
      return;
    }
    await this.#start(issue, retry.attempt, workflow, adapter, retry.kind === 'continuation');
  }

  #release(issueId: string): void {
    this.#cancelRetry(issueId);
    this.#claimed.delete(issueId);
    // The details stay available (agent detail view, Logs page "Detail") after the release.
    const record = this.#records.get(issueId);
    if (record !== undefined && record.runs > 0) this.#archive.save(this.#archivedOf(issueId, record, true));
    this.#records.delete(issueId);
    this.#unpause(issueId);
  }

  /** The issue's debugging context in the archive's JSON shape. */
  #archivedOf(issueId: string, record: IssueRecord, released: boolean): ArchivedIssue {
    const state = record.meta?.state ?? record.sessions.at(-1)?.state ?? '';
    return {
      version: 2,
      issue_meta: metaJson(record.meta),
      pipeline: this.#pipelineFor({ state, description: record.meta?.description ?? null, labels: record.meta?.labels }, issueId, this.#deps.workflow.current),
      issue_id: issueId,
      issue_identifier: record.identifier,
      issue_url: record.url,
      title: record.title,
      repo: record.repo,
      workspace_path: record.workspacePath,
      runs: record.runs,
      continuations: record.continuations,
      last_error: record.lastError,
      archived_at: this.#clock.now().toISOString(),
      released,
      completed_before: this.#completed.has(issueId),
      timeline: record.timeline.slice(),
      next_seq: record.nextSeq,
      sessions: record.sessions.map((session) => this.#sessionJson(session)),
      results: resultRows(record.results),
      run_trace: traceJson(record.lastRun),
      last_check: checkJson(record.lastCheck),
    };
  }

  #sessionJson(session: SessionInfo) {
    return {
      run: session.run,
      attempt: session.attempt,
      role: session.role,
      state: session.state,
      model: session.model,
      effort: session.effort,
      started_at: session.startedAt.toISOString(),
      finished_at: session.finishedAt?.toISOString() ?? null,
      outcome: session.outcome,
      transcript: session.transcript,
    };
  }

  /** Holds an issue that stays active after its continuation sessions, until it changes. */
  #pause(issue: Issue, continuations: number, limit: number): void {
    this.#paused.set(issue.id, {
      issueId: issue.id,
      identifier: issue.identifier,
      url: issue.url,
      title: issue.title,
      state: issue.state,
      updatedAtMs: issue.updated_at?.getTime() ?? null,
      continuations,
      pausedAt: this.#clock.now(),
      source: 'continuations',
      attempt: null,
    });
    this.#claimed.add(issue.id);
    const record = this.#records.get(issue.id);
    if (record !== undefined) {
      this.#trace(record, {
        kind: 'lifecycle',
        event: 'issue_paused',
        level: 'warn',
        message: `paused after ${continuations} continuation session(s) in "${issue.state}"; change the issue on the board to resume`,
        run: null,
        turn: null,
        detail: { source: 'continuations', state: issue.state, continuations, max_continuations: limit },
      });
    }
    this.#deps.history?.note(this.#repositoryOf(issue), 'issue_paused', {
      issue: issue.identifier,
      title: issue.title,
      state: issue.state,
      source: 'continuations',
      continuations,
      max_continuations: limit,
    });
    this.#issueLogger(issue).warn(
      'issue paused: still active after its continuation sessions; change it on the board (status, comment, labels) to resume',
      { state: issue.state, continuations, max_continuations: limit },
    );
  }

  /**
   * The issue's cost against `agent.max_issue_cost_usd`: finished runs of every role from the repository history plus the
   * running run. null while the issue is within its budget or has no cap.
   */
  #budgetExceeded(issue: Pick<Issue, 'id' | 'identifier'>, repo: string, config: ServiceConfig): IssueBudget | null {
    const limitUsd = config.agent.maxIssueCostUsd;
    if (limitUsd === null) return null;
    const costUsd = (this.#deps.history?.issueCostUsd(repo, issue.identifier) ?? 0) + (this.#running.get(issue.id)?.costUsd ?? 0);
    return costUsd >= limitUsd ? { costUsd, limitUsd } : null;
  }

  /**
   * Holds an issue whose budget is used up instead of starting its next session (a running session is never stopped).
   * Only Resume, a raised or removed cap, a terminal state or leaving the board lifts the pause.
   */
  #pauseForBudget(issue: Issue, adapter: TrackerAdapter, budget: IssueBudget, attempt: number | null): void {
    const repo = this.#repositoryOf(issue);
    const record = this.#record(issue);
    record.repo ??= repo;
    record.meta = issueMeta(issue);
    this.#cancelRetry(issue.id);
    this.#paused.set(issue.id, {
      issueId: issue.id,
      identifier: issue.identifier,
      url: issue.url,
      title: issue.title,
      state: issue.state,
      updatedAtMs: null,
      continuations: record.continuations,
      pausedAt: this.#clock.now(),
      source: 'budget',
      attempt,
      budget,
    });
    this.#claimed.add(issue.id);
    const spent = `${formatUsd(budget.costUsd)} of ${formatUsd(budget.limitUsd)}`;
    this.#trace(record, {
      kind: 'lifecycle',
      event: 'issue_paused',
      level: 'warn',
      message: `paused: the issue cost ${spent} (agent.max_issue_cost_usd); the next stage does not start`,
      run: null,
      turn: null,
      detail: { source: 'budget', state: issue.state, cost_usd: round4(budget.costUsd), max_issue_cost_usd: budget.limitUsd },
    });
    this.#deps.history?.note(repo, 'issue_paused', {
      issue: issue.identifier,
      title: issue.title,
      state: issue.state,
      source: 'budget',
      cost_usd: round4(budget.costUsd),
      max_issue_cost_usd: budget.limitUsd,
    });
    this.#issueLogger(issue).warn('issue paused: its cost budget is used up; raise agent.max_issue_cost_usd or press Resume', {
      state: issue.state,
      cost_usd: round4(budget.costUsd),
      max_issue_cost_usd: budget.limitUsd,
    });
    this.#notifyBudget(issue, adapter, budget);
    this.#notify();
  }

  /** One comment on the issue per cap, so the board says why nothing starts. A failed comment is only logged. */
  #notifyBudget(issue: Issue, adapter: TrackerAdapter, budget: IssueBudget): void {
    if (this.#budgetNotified.get(issue.id) === budget.limitUsd || adapter.commentOnIssue === undefined) return;
    this.#budgetNotified.set(issue.id, budget.limitUsd);
    const body =
      `**Cost budget used up.** The agents spent ${formatUsd(budget.costUsd)} on this issue; the limit \`agent.max_issue_cost_usd\` is ` +
      `${formatUsd(budget.limitUsd)}. The next stage ("${issue.state}") does not start.\n\n` +
      'To continue, raise `agent.max_issue_cost_usd` in `WORKFLOW.md` (the issue then resumes by itself) or press *Resume* on the dashboard.';
    adapter.commentOnIssue(issue, body).catch((error: unknown) => {
      this.#budgetNotified.delete(issue.id);
      this.#issueLogger(issue).warn('budget comment failed', { error: errorMessage(error) });
    });
  }

  // ---------------------------------------------------------------- reconciliation

  async #reconcile(workflow: EffectiveWorkflow): Promise<void> {
    const config = workflow.config;
    const now = this.#clock.monotonicMs();

    // Part A: stall detection, plus a watchdog for workers that ignore a stop request.
    const stallMs = config.claude.stallTimeoutMs;
    const abandonAfterMs = config.hooks.timeoutMs * 2 + 60_000;
    for (const entry of [...this.#running.values()]) {
      if (entry.stop !== null) {
        if (now - entry.stop.atMs > abandonAfterMs) {
          this.#issueLogger(entry.issue).error('worker did not exit after a stop request; abandoning it', { reason: entry.stop.reason });
          this.#onWorkerExit(entry, { kind: 'cancelled', message: 'abandoned after stop request' });
        }
        continue;
      }
      // Workspace preparation (hooks, composer, Boost) and entry checks have their own timeouts and emit no agent events.
      if (stallMs <= 0 || entry.phase === 'PreparingWorkspace' || entry.phase === 'RunningChecks') continue;
      const elapsed = now - (entry.lastEventAtMs ?? entry.preparedAtMs ?? entry.startedAtMs);
      if (elapsed > stallMs) {
        this.#requestStop(entry, { kind: 'stalled', cleanupWorkspace: false, reason: `no agent activity for ${Math.round(elapsed / 1000)}s` });
      }
    }

    // Part B: tracker state refresh for everything still running, plus paused issues and released
    // issues that still have a workspace (so it is deleted as soon as they reach a terminal state).
    const ids = [...this.#running.values()].filter((entry) => entry.stop === null).map((entry) => entry.issueId);
    const pausedIds = this.#pausedEntries().map((paused) => paused.issueId);
    const waitingIds = [...this.#retries.values()]
      .filter((retry) => retry.kind === 'session_limit' && retry.limit?.waiting === true)
      .map((retry) => retry.issueId);
    const watchedIds = config.workspace.cleanupTerminal
      ? [...this.#watched.keys()].filter((id) => !this.#claimed.has(id) && !this.#cleanups.has(id))
      : [];
    if (ids.length === 0 && pausedIds.length === 0 && waitingIds.length === 0 && watchedIds.length === 0) return;
    let refreshed: Issue[];
    try {
      refreshed = await this.#adapterFor(workflow).fetchIssuesByIds([...ids, ...pausedIds, ...waitingIds, ...watchedIds]);
    } catch (error) {
      this.#trackerFailure('running-issue refresh failed; keeping workers running', error);
      return;
    }
    const byId = new Map(refreshed.map((issue) => [issue.id, issue]));
    for (const [id, issue] of byId) {
      const record = this.#records.get(id);
      if (record !== undefined) record.meta = issueMeta(issue);
    }
    for (const id of ids) {
      const entry = this.#running.get(id);
      if (entry === undefined || entry.stop !== null) continue;
      const issue = byId.get(id);
      if (issue === undefined) {
        this.#requestStop(entry, { kind: 'missing', cleanupWorkspace: false, reason: 'issue is no longer visible on the tracker' });
      } else if (isTerminalState(issue.state, config.tracker)) {
        entry.issue = issue;
        this.#requestStop(entry, {
          kind: 'terminal',
          cleanupWorkspace: config.workspace.cleanupTerminal,
          reason: `issue moved to terminal state "${issue.state}"`,
        });
      } else if (isActiveState(issue.state, config.tracker) && isRoutable(issue, config.tracker)) {
        entry.issue = issue;
      } else if (isActiveState(issue.state, config.tracker)) {
        entry.issue = issue;
        this.#requestStop(entry, { kind: 'unroutable', cleanupWorkspace: false, reason: 'issue is no longer dispatchable (assignee, blockers or labels)' });
      } else {
        entry.issue = issue;
        this.#requestStop(entry, { kind: 'inactive', cleanupWorkspace: false, reason: `issue moved to non-active state "${issue.state}"` });
      }
    }

    for (const id of watchedIds) {
      const issue = byId.get(id);
      if (issue === undefined) {
        this.#watched.delete(id);
      } else if (isTerminalState(issue.state, config.tracker)) {
        this.#issueLogger(issue).info('issue reached a terminal state; removing its workspace', { state: issue.state });
        this.#cleanupWorkspace(issue);
      }
    }

    // A waiting entry only follows the board; a changed issue does not end the wait early.
    for (const id of waitingIds) {
      const retry = this.#retries.get(id);
      if (retry === undefined || retry.kind !== 'session_limit' || retry.limit?.waiting !== true) continue;
      const issue = byId.get(id);
      const log = this.#logger.child({ issue_id: id, issue_identifier: issue?.identifier ?? retry.identifier });
      if (issue === undefined) {
        log.info('waiting issue is no longer visible; releasing it');
        this.#release(id);
      } else if (isTerminalState(issue.state, config.tracker)) {
        log.info('waiting issue is terminal; releasing it', { state: issue.state });
        this.#release(id);
        if (config.workspace.cleanupTerminal) this.#cleanupWorkspace(issue);
      } else if (!isActiveState(issue.state, config.tracker) || !isRoutable(issue, config.tracker)) {
        log.info('waiting issue left the active states; releasing it', { state: issue.state });
        this.#release(id);
      }
    }

    for (const id of pausedIds) {
      const paused = this.#paused.get(id);
      if (paused === undefined) continue;
      const issue = byId.get(id);
      const log = this.#logger.child({ issue_id: id, issue_identifier: issue?.identifier ?? paused.identifier });
      if (issue === undefined) {
        log.info('paused issue is no longer visible; releasing it');
        this.#release(id);
      } else if (isTerminalState(issue.state, config.tracker)) {
        log.info('paused issue is terminal; releasing it', { state: issue.state });
        this.#release(id);
        if (config.workspace.cleanupTerminal) this.#cleanupWorkspace(issue);
      } else if (paused.source === 'operator') {
        // Only Resume lifts an operator pause: comments, labels and column moves (also to Backlog and back) do not.
        paused.state = issue.state;
        paused.title = issue.title;
        paused.url = issue.url;
      } else if (!isActiveState(issue.state, config.tracker) || !isRoutable(issue, config.tracker)) {
        log.info('paused issue left the active states; releasing it', { state: issue.state });
        this.#release(id);
      } else if (paused.source === 'budget') {
        // Board changes do not lift a budget pause: Resume does, or a raised or removed agent.max_issue_cost_usd.
        paused.state = issue.state;
        paused.title = issue.title;
        paused.url = issue.url;
        const budget = this.#budgetExceeded(issue, this.#records.get(id)?.repo ?? this.#repositoryOf(issue), config);
        if (budget === null) {
          log.info('resuming paused issue', { reason: 'agent.max_issue_cost_usd raised or removed' });
          this.#release(id);
        } else {
          paused.budget = budget;
        }
      } else {
        const limit = config.agent.maxContinuations;
        const changed =
          normalizeStateName(issue.state) !== normalizeStateName(paused.state) ||
          (issue.updated_at?.getTime() ?? null) !== paused.updatedAtMs;
        if (changed || limit === null || paused.continuations < limit) {
          // Releasing makes it a fresh candidate for this tick's dispatch pass.
          log.info('resuming paused issue', { reason: changed ? 'issue changed on the tracker' : 'agent.max_continuations raised' });
          this.#release(id);
        }
      }
    }
  }

  #requestStop(entry: RunningEntry, stop: Omit<StopRequest, 'atMs'>): void {
    if (entry.stop !== null) return;
    entry.stop = { ...stop, atMs: this.#clock.monotonicMs() };
    this.#issueLogger(entry.issue).info('stopping agent', { reason: stop.reason, kind: stop.kind });
    entry.controller.abort(stop.reason);
  }

  /** Hook view of an issue, including adapter-provided variables such as the repository. */
  #hookIssue(issue: Issue): HookIssue {
    let env: Record<string, string> = {};
    try {
      env = this.#adapterFor(this.#deps.workflow.current).hookEnvironment?.(issue) ?? {};
    } catch {
      // No usable adapter right now; hooks still get the core SYMPHONY_* variables.
    }
    return { id: issue.id, identifier: issue.identifier, url: issue.url, branch_name: issue.branch_name, env };
  }

  #cleanupWorkspace(issue: Issue): void {
    if (this.#cleanups.has(issue.id)) return;
    const cleanup = this.#workspaces(this.#deps.workflow.current)
      .remove(this.#hookIssue(issue))
      .then((removed) => {
        this.#watched.delete(issue.id);
        if (removed) this.#deps.history?.note(this.#repositoryOf(issue), 'workspace_removed', { issue: issue.identifier, state: issue.state });
      })
      .catch((error: unknown) => {
        this.#issueLogger(issue).warn('workspace cleanup failed', { error: errorMessage(error) });
      })
      .finally(() => this.#cleanups.delete(issue.id));
    this.#cleanups.set(issue.id, cleanup);
  }

  async #startupCleanup(workflow: EffectiveWorkflow): Promise<void> {
    if (!workflow.config.workspace.cleanupTerminal) {
      this.#logger.info('startup cleanup skipped (workspace.cleanup_terminal is false)');
      return;
    }
    let issues: Issue[];
    try {
      issues = await this.#adapterFor(workflow).fetchIssuesByStates(workflow.config.tracker.terminalStates);
    } catch (error) {
      this.#logger.warn('startup cleanup skipped: could not fetch terminal issues', { error: errorMessage(error) });
      return;
    }
    const workspaces = this.#workspaces(workflow);
    let removed = 0;
    for (const issue of issues) {
      try {
        if (await workspaces.remove(this.#hookIssue(issue))) removed++;
      } catch (error) {
        this.#issueLogger(issue).warn('startup workspace cleanup failed', { error: errorMessage(error) });
      }
    }
    this.#logger.info('startup cleanup finished', { terminal_issues: issues.length, workspaces_removed: removed });
  }

  // ---------------------------------------------------------------- agent events

  #onAgentEvent(entry: RunningEntry, event: AgentEvent): void {
    if (this.#running.get(entry.issueId) !== entry) return;
    entry.lastEvent = event.event;
    entry.lastEventAt = event.timestamp;
    entry.lastEventAtMs = this.#clock.monotonicMs();
    if (event.pid !== null) entry.pid = event.pid;
    if (event.threadId !== null) entry.threadId = event.threadId;
    if (event.turnId !== null) entry.turnId = event.turnId;
    if (event.sessionId !== null) entry.sessionId = event.sessionId;
    entry.turnCount = event.turnCount;
    if (event.message !== undefined && event.message !== '') entry.lastMessage = event.message;
    if (event.event === 'tool_use' && typeof event.detail?.tool === 'string') {
      const server = mcpServerOf(event.detail.tool);
      if (server !== null) entry.mcpToolCalls[server] = (entry.mcpToolCalls[server] ?? 0) + 1;
      countToolUse(
        entry.toolUsage,
        event.detail.tool,
        typeof event.detail.skill === 'string' ? event.detail.skill : null,
        typeof event.detail.agent === 'string' ? event.detail.agent : null,
      );
    }
    if (event.event === 'session_configured' && typeof event.detail?.model === 'string') entry.model = event.detail.model;
    if (event.event === 'session_configured' && Array.isArray(event.detail?.skill_names)) {
      entry.sessionSkills = event.detail.skill_names.filter((name): name is string => typeof name === 'string');
    }

    // Per-model totals alone (a model call in the middle of a turn) also move the session's token counters.
    const usage = event.usage ?? (event.modelUsage !== undefined ? tokensOfModelUsage(event.modelUsage) : undefined);
    if (usage !== undefined) {
      const delta = usageDelta(usage, entry.reported);
      this.#totals.inputTokens += delta.inputTokens;
      this.#totals.outputTokens += delta.outputTokens;
      this.#totals.totalTokens += delta.totalTokens;
      entry.tokens = usage;
      entry.reported = usage;
    }
    if (event.costUsd !== undefined) {
      this.#totals.claudeEstimateUsd += Math.max(0, event.costUsd - entry.claudeEstimateUsd);
      entry.claudeEstimateUsd = event.costUsd;
    }
    if (event.modelUsage !== undefined) entry.modelUsage = event.modelUsage;
    if (event.modelUsage !== undefined || event.costUsd !== undefined) {
      const pricing = this.#deps.pricing?.current();
      const cost = pricing !== undefined ? estimateCost(pricing, entry.modelUsage) : entry.claudeEstimateUsd;
      this.#totals.costUsd += cost >= entry.reportedCostUsd ? cost - entry.reportedCostUsd : cost;
      entry.costUsd = cost;
      entry.reportedCostUsd = cost;
    }
    if (event.rateLimits !== undefined) this.#rateLimits = event.rateLimits;
    // Outside #serial: only the timestamp, the dispatch gate is derived from it on demand.
    if (event.event === 'turn_completed') this.#lastTurnSuccessAt = this.#clock.now();

    const failedTool = event.event === 'tracker_tool' && event.detail?.ok === false;
    const level = WARNING_EVENTS.has(event.event) || failedTool ? 'warn' : LIFECYCLE_EVENTS.has(event.event) ? 'info' : 'debug';

    const record = this.#records.get(entry.issueId);
    const hasMessage = event.message !== undefined && event.message !== '';
    if (record !== undefined && (hasMessage || event.detail !== undefined || event.usage !== undefined)) {
      const detail: Record<string, unknown> = { ...(event.detail ?? {}) };
      if (event.usage !== undefined) {
        detail.usage = tokensJson(event.usage);
        detail.cost_usd = Math.round(entry.costUsd * 10_000) / 10_000;
      }
      this.#trace(record, {
        kind: 'agent',
        event: event.event,
        level,
        message: hasMessage ? (event.message as string) : null,
        run: entry.runId,
        turn: event.turnCount,
        detail: Object.keys(detail).length > 0 ? detail : null,
        at: event.timestamp,
      });
    }

    entry.runLog.log(level, `agent ${event.event}`, {
      session_id: event.sessionId ?? event.threadId,
      thread_id: event.threadId,
      detail: event.message,
      ...(event.detail ?? {}),
    });
  }

  // ---------------------------------------------------------------- observability

  #record(issue: Issue): IssueRecord {
    let record = this.#records.get(issue.id);
    if (record === undefined) {
      record = {
        identifier: issue.identifier,
        url: issue.url,
        title: issue.title,
        repo: null,
        workspacePath: null,
        runs: 0,
        continuations: 0,
        sessionLimitHits: 0,
        lastError: null,
        timeline: [],
        nextSeq: 1,
        sessions: [],
        lastRun: null,
        checkCache: new Map(),
        lastCheck: null,
        meta: null,
        results: [],
      };
      this.#records.set(issue.id, record);
    }
    record.identifier = issue.identifier;
    record.url = issue.url;
    record.title = issue.title;
    return record;
  }

  /** Appends to the issue's timeline, keeping the newest TIMELINE_EVENTS entries. */
  #trace(record: IssueRecord, event: Omit<TimelineEvent, 'seq' | 'at'> & { at?: Date }): void {
    const { at, ...rest } = event;
    record.timeline.push({ seq: record.nextSeq++, at: (at ?? this.#clock.now()).toISOString(), ...rest });
    if (record.timeline.length > TIMELINE_EVENTS) record.timeline.shift();
  }

  /** Finds the record of a claimed issue by id or identifier. */
  #findRecord(key: string): { issueId: string; record: IssueRecord } | null {
    for (const [issueId, record] of this.#records) if (issueId === key || record.identifier === key) return { issueId, record };
    return null;
  }

  #issueLogger(issue: Pick<Issue, 'id' | 'identifier'>): Logger {
    return this.#logger.child({ issue_id: issue.id, issue_identifier: issue.identifier });
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        this.#logger.warn('status listener failed', { error: errorMessage(error) });
      }
    }
  }

  #runningRow(entry: RunningEntry, now: number) {
    return {
      issue_id: entry.issueId,
      issue_identifier: entry.identifier,
      issue_url: entry.issue.url,
      title: entry.issue.title,
      state: entry.issue.state,
      role: entry.role,
      /** Started with Start now in an extra slot: it holds no slot of the limits. */
      forced: entry.forced,
      phase: entry.phase,
      attempt: entry.attempt,
      session_id: entry.sessionId,
      thread_id: entry.threadId,
      turn_count: entry.turnCount,
      pid: entry.pid,
      last_event: entry.lastEvent,
      last_message: entry.lastMessage ?? '',
      started_at: entry.startedAt.toISOString(),
      last_event_at: entry.lastEventAt?.toISOString() ?? null,
      seconds_running: Math.round((now - entry.startedAtMs) / 100) / 10,
      workspace: entry.workspacePath,
      tokens: tokensJson(entry.tokens),
      // The model that used the most tokens; until the first model call, the one the session started with.
      model: primaryModelOf(entry.modelUsage) ?? entry.model,
      effort: entry.effort,
      cost_usd: Math.round(entry.costUsd * 10_000) / 10_000,
      claude_estimate_usd: Math.round(entry.claudeEstimateUsd * 10_000) / 10_000,
      repo: entry.repo,
      stopping: entry.stop?.reason ?? null,
      head_sha: entry.headSha,
      branch: entry.branch,
      mcp_tool_calls: entry.mcpToolCalls,
      tool_calls: entry.toolUsage.tools,
      skill_calls: entry.toolUsage.skills,
      agent_calls: entry.toolUsage.agents,
      integrations: entry.integrations.map((report) => integrationJson(report, entry.toolUsage, entry.sessionSkills, entry.mcpUnavailable)),
    };
  }

  #retryRow(retry: RetryEntry, now: number) {
    return {
      issue_id: retry.issueId,
      issue_identifier: retry.identifier,
      issue_url: retry.url,
      attempt: retry.attempt,
      kind: retry.kind,
      due_at: retry.dueAt.toISOString(),
      due_in_ms: Math.max(0, Math.round(retry.dueAtMs - now)),
      error: retry.error,
      limit: limitJson(retry.limit),
    };
  }

  #pausedRow(paused: PausedEntry) {
    return {
      issue_id: paused.issueId,
      issue_identifier: paused.identifier,
      issue_url: paused.url,
      state: paused.state,
      source: paused.source,
      continuations: paused.continuations,
      paused_at: paused.pausedAt.toISOString(),
      ...(paused.budget !== undefined ? { cost_usd: round4(paused.budget.costUsd), max_issue_cost_usd: paused.budget.limitUsd } : {}),
    };
  }

  /** The issue's stations across the board, with the sessions of its claim attributed to them. */
  #pipelineFor(issue: { state: string; description: string | null; labels?: readonly string[] }, issueId: string, workflow: EffectiveWorkflow): PipelineStage[] {
    const config = workflow.config;
    const sessions: StageSession[] = (this.#records.get(issueId)?.sessions ?? []).map((session) => this.#sessionJson(session));
    return derivePipeline({
      issue,
      roles: config.roles,
      activeStates: config.tracker.activeStates,
      terminalStates: config.tracker.terminalStates,
      boardColumns: this.#statusOptionsCache?.version === workflow.version ? this.#statusOptionsCache.options : null,
      sessions,
      skip: (config.roles ?? []).filter((role) => skipReason({ labels: issue.labels ?? [] }, role, config) !== null).map((role) => role.name),
      results: this.#records.get(issueId)?.results ?? [],
    });
  }

  /** One `issues[]` row of GET /api/v1/state: an issue in flight with its pipeline, live status and place in the plan. */
  #issueRow(
    status: 'running' | 'retrying' | 'paused' | 'queued',
    issue: { id: string; identifier: string; url: string | null; title: string | null; state: string; description: string | null; labels?: readonly string[] },
    workflow: EffectiveWorkflow,
    now: number,
    rows: { running?: RunningEntry; retry?: RetryEntry; paused?: PausedEntry; dispatchNote?: string | null; modelHold?: ActiveHold | null; plan?: PlanItem },
  ) {
    const record = this.#records.get(issue.id);
    const meta = record?.meta ?? null;
    const plan = rows.plan ?? null;
    return {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      issue_url: issue.url,
      title: issue.title ?? record?.title ?? null,
      repo: rows.running?.repo ?? record?.repo ?? null,
      state: issue.state,
      status,
      /** Dashboard section: `running`, else the dispatch plan group (`next`, `waiting`, `paused`). */
      section: plan?.group ?? 'running',
      /** Place in the dispatch order (`next` only). */
      position: plan?.position ?? null,
      decision: plan?.decision ?? null,
      reason: plan === null ? null : { code: plan.reason.code, text: plan.reason.text },
      /** Model the next session would run with (the running session reports its own in `running.model`). */
      model: plan?.model ?? rows.running?.requestedModel ?? null,
      labels: meta?.labels ?? [],
      priority: plan?.priority ?? meta?.priority ?? null,
      /** True when the orchestrator holds debugging context, so /agent?id=… has something to show. */
      tracked: record !== undefined,
      stages: this.#pipelineFor({ state: issue.state, description: issue.description, labels: issue.labels }, issue.id, workflow),
      running: rows.running === undefined ? null : this.#runningRow(rows.running, now),
      retry: rows.retry === undefined ? null : this.#retryRow(rows.retry, now),
      paused: rows.paused === undefined ? null : this.#pausedRow(rows.paused),
      dispatch_note: rows.dispatchNote ?? null,
      /** The hold of the model this waiting issue would run with: it does not start before `until`. */
      model_hold: rows.modelHold
        ? { model: rows.modelHold.model, source: rows.modelHold.source, until: rows.modelHold.until?.toISOString() ?? null }
        : null,
    };
  }

  /** `issues[]`, `queue[]` and `blocked[]` of GET /api/v1/state: running sessions, then the dispatch plan. */
  #issueRows(workflow: EffectiveWorkflow, now: number, plan: PlanItem[]) {
    const config = workflow.config;
    const byId = new Map((this.#board?.candidates ?? []).map((issue) => [issue.id, issue]));
    const issues = [];
    for (const entry of this.#running.values()) {
      const { issue } = entry;
      issues.push(this.#issueRow('running', { ...issue, description: firstLine(issue.description) }, workflow, now, { running: entry }));
    }
    const blocked = [];
    const parked = [];
    const blockedRow = (issue: Issue, reason: string, code: string) => ({
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      issue_url: issue.url,
      title: issue.title,
      repo: this.#records.get(issue.id)?.repo ?? null,
      state: issue.state,
      reason,
      reason_code: code,
      blocked_by: issue.blocked_by,
      tracked: this.#records.has(issue.id),
    });
    for (const item of plan) {
      const board = byId.get(item.issueId);
      const retry = this.#retries.get(item.issueId);
      const paused = this.#paused.get(item.issueId);
      const meta = this.#records.get(item.issueId)?.meta;
      if (item.group === 'blocked') {
        if (board !== undefined) blocked.push(blockedRow(board, item.reason.text, item.reason.code));
      } else if (item.kind === 'new') {
        if (board === undefined) continue;
        const note = typeof board.native_ref?.dispatch_note === 'string' ? board.native_ref.dispatch_note : null;
        issues.push(this.#issueRow('queued', board, workflow, now, { dispatchNote: note, modelHold: this.#holdFor(board, config), plan: item }));
      } else if (paused !== undefined) {
        const title = board?.title ?? paused.title;
        const row = { id: paused.issueId, identifier: paused.identifier, url: paused.url, title, state: paused.state, description: meta?.description ?? null, labels: board?.labels ?? meta?.labels };
        issues.push(this.#issueRow('paused', row, workflow, now, { paused, plan: item }));
      } else if (retry !== undefined) {
        const held = board ?? (meta ? { state: meta.state, description: meta.description, labels: meta.labels } : null);
        const row = {
          id: retry.issueId,
          identifier: retry.identifier,
          url: retry.url,
          title: board?.title ?? null,
          state: meta?.state ?? board?.state ?? '',
          description: meta?.description ?? board?.description ?? null,
          labels: board?.labels ?? meta?.labels,
        };
        issues.push(this.#issueRow('retrying', row, workflow, now, { retry, modelHold: held === null ? null : this.#holdFor(held, config), plan: item }));
      }
    }
    // Issues in a blocked-bucket column first, then candidates that are not dispatchable or lack a required label.
    const listed = new Set(issues.map((row) => row.issue_id));
    for (const issue of this.#board?.parked ?? []) {
      if (!listed.has(issue.id)) parked.push(blockedRow(issue, `in column "${issue.state}"`, 'column'));
    }
    const queue = plan
      .filter((item) => item.group !== 'blocked')
      .map((item) => ({
        position: item.position,
        issue_id: item.issueId,
        issue_identifier: item.identifier,
        status: item.group,
        kind: item.kind,
        decision: item.decision,
        reason: { code: item.reason.code, text: item.reason.text },
        due_at: item.dueAt?.toISOString() ?? null,
        state: item.state,
        priority: item.priority,
        model: item.model,
      }));
    return { issues, queue, blocked: [...parked, ...blocked] };
  }

  #slotsJson(): ForceSlots {
    return {
      running: this.#running.size,
      forced: this.#forcedCount(),
      limit: effectiveAgentLimits(this.#deps.workflow.current.config, this.#limitOverride).maxConcurrentAgents,
    };
  }

  /** Runtime snapshot for GET /api/v1/state (spec 13.3). */
  snapshot() {
    const now = this.#clock.monotonicMs();
    const workflow = this.#deps.workflow.current;
    const config = workflow.config;
    let activeSeconds = 0;
    for (const entry of this.#running.values()) activeSeconds += (now - entry.startedAtMs) / 1000;
    const gate = this.#dispatchGate();
    let adapter: TrackerAdapter | null = null;
    try {
      adapter = this.#adapterFor(workflow);
    } catch {
      // Reported by the tick's validation; the plan then ignores sub-issues.
    }
    const plan = this.#plan(config, adapter);
    const { issues, queue, blocked } = this.#issueRows(workflow, now, plan);
    return {
      generated_at: this.#clock.now().toISOString(),
      counts: {
        running: this.#running.size,
        /** Running sessions started with Start now: `running` may exceed the limit by this many. */
        forced: this.#forcedCount(),
        retrying: this.#retries.size,
        paused: this.#pausedEntries().length,
        claimed: this.#claimed.size,
        queued: queue.filter((item) => item.kind === 'new' && item.status === 'next').length,
        blocked: blocked.length,
      },
      issues,
      queue,
      blocked,
      board_fetched_at: this.#board?.fetchedAt.toISOString() ?? null,
      pipeline_config: {
        board_columns: this.#statusOptionsCache?.version === workflow.version ? this.#statusOptionsCache.options : null,
        roles:
          config.roles === null
            ? null
            : config.roles.map((role) => ({ name: role.name, states: role.states, read_only: role.readOnly, commands: role.commands })),
        blocked_states: this.#blockedStates(config),
      },
      running: [...this.#running.values()].map((entry) => this.#runningRow(entry, now)),
      retrying: [...this.#retries.values()].sort((a, b) => a.dueAtMs - b.dueAtMs).map((retry) => this.#retryRow(retry, now)),
      paused: this.#pausedEntries().map((paused) => this.#pausedRow(paused)),
      // Operator holds first (no end), then limit holds soonest first; a model can have both.
      model_holds: [
        ...[...this.#operatorHolds.values()].map((hold) => this.#operatorHoldJson(hold)),
        ...[...this.#modelHolds.values()]
          .filter((hold) => this.#activeLimitHold(hold.model) === hold)
          .sort((a, b) => a.until.getTime() - b.until.getTime())
          .map((hold) => this.#modelHoldJson(hold)),
      ],
      model_controls: this.#modelControls(plan),
      limits: limitsJson(config, this.#limitOverride, this.#runningByRole()),
      agent_totals: {
        input_tokens: this.#totals.inputTokens,
        output_tokens: this.#totals.outputTokens,
        total_tokens: this.#totals.totalTokens,
        seconds_running: Math.round((this.#totals.endedSeconds + activeSeconds) * 10) / 10,
        cost_usd: Math.round(this.#totals.costUsd * 10_000) / 10_000,
        claude_estimate_usd: Math.round(this.#totals.claudeEstimateUsd * 10_000) / 10_000,
      },
      rate_limits: this.#rateLimits,
      health: {
        stopping: this.#stopping,
        workflow_path: this.#deps.workflow.path,
        workflow_version: workflow.version,
        workflow_loaded_at: workflow.loadedAt.toISOString(),
        workflow_error: this.#deps.workflow.lastError
          ? { code: this.#deps.workflow.lastError.code, message: this.#deps.workflow.lastError.message }
          : null,
        dispatch_errors: this.#dispatchErrors,
        dispatch_gate:
          gate === null
            ? null
            : { reason: 'session_limit' as const, window: gate.window, until: gate.until.toISOString(), issue_identifier: gate.issueIdentifier },
        last_tick_at: this.#lastTickAt?.toISOString() ?? null,
        last_tracker_error: this.#lastTrackerError
          ? { at: this.#lastTrackerError.at.toISOString(), message: this.#lastTrackerError.message }
          : null,
        tracker_kind: config.tracker.kind,
        active_states: config.tracker.activeStates,
        terminal_states: config.tracker.terminalStates,
        poll_interval_ms: this.#pollIntervalMs,
        max_concurrent_agents: effectiveAgentLimits(config, this.#limitOverride).maxConcurrentAgents,
        max_turns: config.agent.maxTurns,
        max_continuations: config.agent.maxContinuations,
        max_session_limit_retries: config.agent.maxSessionLimitRetries,
        cleanup_terminal: config.workspace.cleanupTerminal,
        completed_count: this.#completed.size,
        pricing_file: this.#deps.pricing?.path ?? null,
        pricing_error: this.#deps.pricing?.lastError ?? null,
        history_dir: this.#deps.history?.dir ?? null,
      },
    };
  }

  /**
   * Debug details for GET /api/v1/<issue_identifier>: the live claim, else the archived details of a finished
   * claim (`status` = `finished`); null when the issue is unknown.
   */
  issueDetail(key: string) {
    const now = this.#clock.monotonicMs();
    const matches = (id: string, identifier: string) => id === key || identifier === key;
    const entry = [...this.#running.values()].find((e) => matches(e.issueId, e.identifier));
    const retry = [...this.#retries.values()].find((r) => matches(r.issueId, r.identifier));
    const paused = [...this.#paused.values()].find((p) => matches(p.issueId, p.identifier));
    let issueId = entry?.issueId ?? retry?.issueId ?? paused?.issueId;
    if (issueId === undefined) {
      for (const [id, record] of this.#records) if (matches(id, record.identifier)) issueId = id;
    }
    if (issueId === undefined) {
      const archived = this.#archive.get(key);
      return archived === null ? null : this.#archivedDetail(archived);
    }
    const record = this.#records.get(issueId);
    const identifier = entry?.identifier ?? retry?.identifier ?? record?.identifier ?? key;
    const pricing = this.#deps.pricing?.current();
    const meta = entry !== undefined ? issueMeta(entry.issue) : (record?.meta ?? null);
    const state = entry?.issue.state ?? paused?.state ?? meta?.state ?? record?.sessions.at(-1)?.state ?? '';
    return {
      issue_identifier: identifier,
      issue_id: issueId,
      issue_url: entry?.issue.url ?? retry?.url ?? record?.url ?? null,
      title: entry?.issue.title ?? record?.title ?? null,
      repo: entry?.repo ?? record?.repo ?? null,
      status:
        entry !== undefined ? (entry.stop !== null ? 'stopping' : 'running') : retry !== undefined ? 'retrying' : paused !== undefined ? 'paused' : 'claimed',
      role: entry?.role ?? null,
      issue: metaJson(meta),
      pipeline: this.#pipelineFor({ state, description: meta?.description ?? null, labels: meta?.labels }, issueId, this.#deps.workflow.current),
      results: resultRows(record?.results ?? []),
      workspace: { path: entry?.workspacePath ?? record?.workspacePath ?? null },
      attempts: {
        runs: record?.runs ?? 0,
        continuations: record?.continuations ?? 0,
        restart_count: Math.max((record?.runs ?? 1) - 1, 0),
        current_retry_attempt: retry?.attempt ?? entry?.attempt ?? null,
      },
      run_trace: entry !== undefined ? traceJson(traceOf(entry)) : traceJson(record?.lastRun ?? null),
      running: entry === undefined ? null : this.#runningRow(entry, now),
      retry: retry === undefined ? null : this.#retryRow(retry, now),
      paused: paused === undefined ? null : this.#pausedRow(paused),
      logs: { session_transcripts_dir: this.#deps.logDir === null ? null : path.join(this.#deps.logDir, 'sessions') },
      // Per-model usage of the running session, priced like cost_usd (model-costs.yml).
      usage_by_model:
        entry === undefined
          ? null
          : Object.fromEntries(
              Object.entries(entry.modelUsage).map(([model, usage]) => [
                model,
                {
                  input_tokens: usage.inputTokens,
                  output_tokens: usage.outputTokens,
                  cache_read_tokens: usage.cacheReadTokens,
                  cache_write_tokens: usage.cacheWriteTokens,
                  total_tokens: totalTokens(usage),
                  cost_usd: pricing === undefined ? null : Math.round(estimateCost(pricing, { [model]: usage }) * 10_000) / 10_000,
                },
              ]),
            ),
      sessions: (record?.sessions ?? []).map((session) => this.#sessionJson(session)),
      timeline_seq: (record?.nextSeq ?? 1) - 1,
      recent_events: recentEvents(record?.timeline ?? []),
      last_error: record?.lastError ?? null,
      last_check: checkJson(record?.lastCheck ?? null),
      tracked: { completed_before: this.#completed.has(issueId) },
      /** Agent slots now, for the Start now confirmation: `running` includes the `forced` sessions. */
      slots: this.#slotsJson(),
      archived: null as { archived_at: string; released: boolean } | null,
    };
  }

  /** issueDetail for a finished claim served from the archive: the same shape, without live parts. */
  #archivedDetail(archived: ArchivedIssue) {
    const lastSession = archived.sessions.at(-1);
    return {
      issue_identifier: archived.issue_identifier,
      issue_id: archived.issue_id,
      issue_url: archived.issue_url,
      title: archived.title,
      repo: archived.repo,
      status: 'finished',
      role: lastSession?.role ?? null,
      issue: archived.issue_meta ?? null,
      pipeline: archived.pipeline ?? [],
      results: archived.results,
      workspace: { path: archived.workspace_path },
      attempts: {
        runs: archived.runs,
        continuations: archived.continuations,
        restart_count: Math.max(archived.runs - 1, 0),
        current_retry_attempt: null,
      },
      run_trace: archived.run_trace,
      running: null,
      retry: null,
      paused: null,
      logs: { session_transcripts_dir: this.#deps.logDir === null ? null : path.join(this.#deps.logDir, 'sessions') },
      usage_by_model: null,
      sessions: archived.sessions,
      timeline_seq: archived.next_seq - 1,
      recent_events: recentEvents(archived.timeline),
      last_error: archived.last_error,
      last_check: archived.last_check,
      tracked: { completed_before: archived.completed_before },
      slots: this.#slotsJson(),
      archived: { archived_at: archived.archived_at, released: archived.released },
    };
  }

  /** Timeline and sessions of a claimed issue, else of an archived one; null when the issue is unknown. */
  #findTrace(key: string): { identifier: string; timeline: TimelineEvent[]; nextSeq: number; sessions: Array<{ run: string; transcript: string | null }> } | null {
    const found = this.#findRecord(key);
    if (found !== null) return { identifier: found.record.identifier, timeline: found.record.timeline, nextSeq: found.record.nextSeq, sessions: found.record.sessions };
    const archived = this.#archive.get(key);
    if (archived === null) return null;
    return { identifier: archived.issue_identifier, timeline: archived.timeline, nextSeq: archived.next_seq, sessions: archived.sessions };
  }

  /** Timeline entries after `after` (a `seq`) for GET /api/v1/<identifier>/timeline; null when the issue is unknown. */
  issueTimeline(key: string, after = 0) {
    const trace = this.#findTrace(key);
    if (trace === null) return null;
    const events = trace.timeline.filter((event) => event.seq > after);
    return {
      issue_identifier: trace.identifier,
      latest_seq: trace.nextSeq - 1,
      // Older entries than the first one here were dropped (TIMELINE_EVENTS).
      first_seq: trace.timeline[0]?.seq ?? trace.nextSeq,
      events,
    };
  }

  /** The transcript file of a session (the latest when `run` is null), or null. */
  issueTranscriptFile(key: string, run: string | null): string | null {
    const trace = this.#findTrace(key);
    if (trace === null) return null;
    const session = run === null ? trace.sessions.at(-1) : trace.sessions.find((candidate) => candidate.run === run);
    return session?.transcript ?? null;
  }

  /**
   * Normalized transcript lines of a session from byte `from` on (GET /api/v1/<identifier>/transcript); null when
   * the issue is unknown. Model calls are priced with model-costs.yml.
   */
  issueTranscript(key: string, run: string | null, from = 0): ({ run: string | null; available: boolean; reason: string | null } & Partial<TranscriptChunk>) | null {
    const trace = this.#findTrace(key);
    if (trace === null) return null;
    const session = run === null ? trace.sessions.at(-1) : trace.sessions.find((candidate) => candidate.run === run);
    if (session === undefined) return { run, available: false, reason: 'unknown session' };
    if (session.transcript === null) {
      return { run: session.run, available: false, reason: this.#deps.logDir === null ? 'session transcripts are disabled (no log directory)' : 'no transcript yet' };
    }
    const chunk = readTranscript(session.transcript, from, { pricing: this.#deps.pricing?.current() ?? null });
    if (chunk === null) return { run: session.run, available: false, reason: 'transcript file not found' };
    return { run: session.run, available: true, reason: null, ...chunk };
  }
}
