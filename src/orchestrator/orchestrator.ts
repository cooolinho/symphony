import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { childEnvironment } from '../agent/env.ts';
import { chooseModel } from '../agent/model.ts';
import type { AgentEvent, AgentRunner, TokenUsage } from '../agent/types.ts';
import { estimateCost, totalTokens, type ModelTokenUsage, type PricingStore } from '../costs/pricing.ts';
import type { HistoryLog, RunOutcome } from '../history/history.ts';
import { defaultIntegrations } from '../integrations/registry.ts';
import type { WorkspaceIntegration } from '../integrations/types.ts';
import type { Logger } from '../log.ts';
import { getTrackerFactory } from '../tracker/registry.ts';
import type { Issue, TrackerAdapter } from '../tracker/types.ts';
import { SerialQueue, settledWithin } from '../util/async.ts';
import { SymphonyError, errorMessage } from '../util/errors.ts';
import { truncate } from '../util/text.ts';
import { WorkspaceManager, type HookIssue } from '../workspace/manager.ts';
import type { ServiceConfig } from '../workflow/config.ts';
import { roleFor, roleName } from '../workflow/roles.ts';
import type { EffectiveWorkflow, WorkflowLoadError } from '../workflow/store.ts';
import { unknownBoardColumns, validateDispatch } from '../workflow/validate.ts';
import {
  CONTINUATION_DELAY_MS,
  failureBackoffMs,
  hasRequiredFields,
  isActiveState,
  isRoutable,
  isTerminalState,
  sortForDispatch,
  stateLimit,
} from './eligibility.ts';
import { normalizeStateName } from '../workflow/config.ts';
import { runAgentAttempt, type RunPhase, type WorkerOutcome } from './worker.ts';

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

type StopKind = 'terminal' | 'inactive' | 'unroutable' | 'missing' | 'stalled' | 'shutdown';

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
  /** `tool_use` events per MCP server (`mcp__<server>__<tool>`); built-in tools are not counted. */
  mcpToolCalls: Record<string, number>;
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
  kind: 'continuation' | 'failure';
  dueAtMs: number;
  dueAt: Date;
  error: string | null;
  timer: unknown;
}

interface RecentEvent {
  at: string;
  event: string;
  message: string | null;
}

/** Per-issue debugging context kept while the issue is claimed. */
interface IssueRecord {
  identifier: string;
  url: string | null;
  workspacePath: string | null;
  runs: number;
  /** Continuation sessions dispatched since the issue was claimed (agent.max_continuations). */
  continuations: number;
  lastError: string | null;
  recentEvents: RecentEvent[];
  /** Commit, branch and MCP tool usage of the running or last run. */
  lastRun: RunTrace | null;
}

interface RunTrace {
  headSha: string | null;
  branch: string | null;
  mcpToolCalls: Record<string, number>;
}

/** `mcp__<server>__<tool>` → `<server>`; null for built-in tools. */
function traceOf(entry: RunningEntry): RunTrace {
  return { headSha: entry.headSha, branch: entry.branch, mcpToolCalls: { ...entry.mcpToolCalls } };
}

function traceJson(trace: RunTrace | null) {
  return trace === null ? null : { head_sha: trace.headSha, branch: trace.branch, mcp_tool_calls: trace.mcpToolCalls };
}

function mcpServerOf(tool: string): string | null {
  const match = /^mcp__(.+?)__/.exec(tool);
  return match?.[1] ?? null;
}

/** An issue held back after agent.max_continuations: claimed, but not running or retrying. */
interface PausedEntry {
  issueId: string;
  identifier: string;
  url: string | null;
  state: string;
  updatedAtMs: number | null;
  continuations: number;
  pausedAt: Date;
}

const RECENT_EVENTS = 50;
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
  #retries = new Map<string, RetryEntry>();
  #completed = new Set<string>();
  #records = new Map<string, IssueRecord>();
  #paused = new Map<string, PausedEntry>();
  /** Issues whose workspace this process created or used; checked for terminal states after release. */
  #watched = new Map<string, string>();
  #cleanups = new Map<string, Promise<void>>();
  #totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, endedSeconds: 0, costUsd: 0, claudeEstimateUsd: 0 };
  #rateLimits: unknown = null;

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
  #listeners = new Set<() => void>();

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
    this.#timers = deps.timers ?? systemTimers;
    this.#logger = deps.logger;
    this.#createAdapter = deps.createAdapter ?? defaultAdapterFactory;
    this.#pollIntervalMs = deps.workflow.current.config.polling.intervalMs;
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

      const adapter = this.#adapterFor(workflow);
      let candidates: Issue[];
      try {
        candidates = await adapter.fetchIssuesByStates(config.tracker.activeStates);
        this.#lastTrackerError = null;
      } catch (error) {
        this.#trackerFailure('candidate fetch failed; skipping dispatch this tick', error);
        return;
      }

      for (const issue of sortForDispatch(candidates)) {
        if (this.#stopping || this.#globalSlots(config) <= 0) break;
        if (this.#shouldDispatch(issue, config)) this.#dispatch(issue, null, workflow, adapter);
      }
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

  #globalSlots(config: ServiceConfig): number {
    return Math.max(config.agent.maxConcurrentAgents - this.#running.size, 0);
  }

  #slotsFor(state: string, config: ServiceConfig): number {
    const normalized = normalizeStateName(state);
    let inState = 0;
    for (const entry of this.#running.values()) {
      if (normalizeStateName(entry.issue.state) === normalized) inState++;
    }
    return Math.min(this.#globalSlots(config), Math.max(stateLimit(state, config.agent) - inState, 0));
  }

  #shouldDispatch(issue: Issue, config: ServiceConfig): boolean {
    return (
      hasRequiredFields(issue) &&
      isActiveState(issue.state, config.tracker) &&
      isRoutable(issue, config.tracker) &&
      !this.#running.has(issue.id) &&
      !this.#claimed.has(issue.id) &&
      !this.#cleanups.has(issue.id) &&
      this.#slotsFor(issue.state, config) > 0
    );
  }

  #dispatch(issue: Issue, attempt: number | null, workflow: EffectiveWorkflow, adapter: TrackerAdapter, continuation = false): void {
    const log = this.#issueLogger(issue);
    const controller = new AbortController();
    const config = workflow.config;
    const role = roleFor(issue.state, config.roles);
    const name = roleName(role);
    const runId = randomUUID().replace(/-/g, '').slice(0, 12);
    const entry: RunningEntry = {
      issueId: issue.id,
      identifier: issue.identifier,
      repo: adapter.issueRepository?.(issue) ?? 'unknown',
      runId,
      role: name,
      runLog: log.child({ run_id: runId, role: name }),
      issue,
      attempt,
      startedAt: this.#clock.now(),
      startedAtMs: this.#clock.monotonicMs(),
      preparedAtMs: null,
      phase: 'PreparingWorkspace',
      workspacePath: null,
      model: null,
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
      mcpToolCalls: {},
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
    // A "Model: <model>" label picks the model for this run, else the role's claude.model, else claude.model.
    const choice = chooseModel(issue.labels, role?.claude.model ?? config.claude.model);
    if (choice.warning !== null) log.warn('model label ignored', { warning: choice.warning, model: choice.model ?? 'Claude Code default' });
    log.info('dispatching issue', {
      state: issue.state,
      attempt,
      continuation: continuation ? record.continuations : undefined,
      role: entry.role,
      model: choice.model ?? 'Claude Code default',
      model_label: choice.label ?? undefined,
      title: truncate(issue.title, 120),
    });
    this.#deps.history?.runStarted({
      repo: entry.repo,
      issue: issue.identifier,
      title: issue.title,
      state: issue.state,
      attempt,
      model: choice.model,
      role: entry.role,
      run: entry.runId,
      at: entry.startedAt,
    });

    let worker: Promise<WorkerOutcome>;
    try {
      worker = runAgentAttempt({
        issue,
        attempt,
        workflow,
        model: choice.model,
        role,
        adapter,
        runner: this.#deps.runner,
        integrations: this.#deps.integrations ?? defaultIntegrations(),
        workspaces: this.#workspaces(workflow),
        childEnv: this.#childEnv(config),
        logger: log,
        signal: controller.signal,
        transcriptDir: this.#deps.logDir === null ? null : path.join(this.#deps.logDir, 'sessions'),
        continueWith: (fresh) => {
          const current = this.#deps.workflow.current.config;
          if (!isActiveState(fresh.state, current.tracker)) return `issue left the active states ("${fresh.state}")`;
          if (!isRoutable(fresh, current.tracker)) return 'issue is no longer dispatchable (assignee, blockers or labels)';
          const next = roleName(roleFor(fresh.state, current.roles));
          return next === entry.role ? null : `role changed (${entry.role} → ${next})`;
        },
        callbacks: {
          phase: (phase) => {
            if (entry.phase === 'PreparingWorkspace' && phase !== 'PreparingWorkspace') entry.preparedAtMs = this.#clock.monotonicMs();
            entry.phase = phase;
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
        },
      });
    } catch (error) {
      this.#running.delete(issue.id);
      this.#scheduleRetry(issue.id, (attempt ?? 0) + 1, {
        identifier: issue.identifier,
        url: issue.url,
        kind: 'failure',
        error: `failed to spawn agent: ${errorMessage(error)}`,
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
    this.#recordRun(entry, outcome, agentSeconds);
    const finished = this.#records.get(entry.issueId);
    if (finished) finished.lastRun = traceOf(entry);
    const log = this.#issueLogger(entry.issue);
    const record = this.#records.get(entry.issueId);
    const nextAttempt = (entry.attempt ?? 0) + 1;
    const retryInfo = { identifier: entry.identifier, url: entry.issue.url };

    const stop = entry.stop;
    if (stop !== null) {
      if (stop.kind === 'stalled' && !this.#stopping) {
        entry.phase = 'Stalled';
        if (record) record.lastError = stop.reason;
        log.warn('stalled agent stopped; retrying', { reason: stop.reason });
        this.#scheduleRetry(entry.issueId, nextAttempt, { ...retryInfo, kind: 'failure', error: `stalled: ${stop.reason}` });
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
      this.#scheduleRetry(entry.issueId, 1, { ...retryInfo, kind: 'continuation', error: null });
    } else if (outcome.kind === 'cancelled') {
      entry.phase = 'CanceledByReconciliation';
      this.#release(entry.issueId);
    } else {
      entry.phase = outcome.code === 'turn_timeout' ? 'TimedOut' : 'Failed';
      const error = `${outcome.code}: ${outcome.message}`;
      if (record) record.lastError = error;
      log.warn('agent run failed', { code: outcome.code, phase: outcome.phase, error: outcome.message });
      this.#scheduleRetry(entry.issueId, nextAttempt, { ...retryInfo, kind: 'failure', error: `worker exited: ${error}` });
    }
    this.#notify();
  }

  /** Writes the finished run to the repository history. */
  #recordRun(entry: RunningEntry, outcome: WorkerOutcome, agentSeconds: number): void {
    const history = this.#deps.history;
    if (history === null || history === undefined) return;
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
        const next = roleName(roleFor(entry.issue.state, config.roles));
        if (next !== entry.role) {
          result = 'handed_off';
          nextRole = next;
        }
      }
    } else if (outcome.kind === 'cancelled') {
      result = 'stopped';
      reason = outcome.message;
    } else {
      result = 'failed';
      reason = `${outcome.code}: ${outcome.message}`;
    }
    history.runFinished({
      repo: entry.repo,
      issue: entry.identifier,
      title: entry.issue.title,
      run: entry.runId,
      session: entry.threadId,
      attempt: entry.attempt,
      outcome: result,
      ...(nextRole !== undefined ? { role: entry.role, nextRole } : {}),
      state: entry.issue.state,
      reason,
      turns: entry.turnCount,
      startedAt: entry.startedAt,
      finishedAt: this.#clock.now(),
      agentSeconds,
      usage: entry.modelUsage,
      claudeEstimateUsd: entry.claudeEstimateUsd > 0 ? entry.claudeEstimateUsd : null,
      headSha: entry.headSha,
      branch: entry.branch,
      mcpToolCalls: entry.mcpToolCalls,
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
    info: { identifier: string; url: string | null; kind: RetryEntry['kind']; error: string | null },
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
    const timer = this.#timers.setTimeout(() => void this.#serial.run(() => this.#onRetryTimer(issueId)), delay);
    this.#retries.set(issueId, {
      issueId,
      identifier: info.identifier,
      url: info.url,
      attempt,
      kind: info.kind,
      dueAtMs: this.#clock.monotonicMs() + delay,
      dueAt: new Date(this.#clock.now().getTime() + delay),
      error: info.error,
      timer,
    });
    this.#claimed.add(issueId);
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
    this.#retries.delete(issueId);
    if (this.#stopping) {
      this.#release(issueId);
      return;
    }
    const requeue = (error: string) =>
      this.#scheduleRetry(issueId, retry.attempt + 1, { identifier: retry.identifier, url: retry.url, kind: 'failure', error });

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
    const continuations = this.#records.get(issueId)?.continuations ?? 0;
    const limit = config.agent.maxContinuations;
    if (retry.kind === 'continuation' && limit !== null && continuations >= limit) {
      this.#pause(issue, continuations, limit);
      return;
    }
    await this.#loadStatusOptions(workflow);
    const errors = this.#validate(workflow);
    if (errors.length > 0) {
      requeue(`dispatch validation failed: ${errors[0]}`);
      return;
    }
    if (this.#slotsFor(issue.state, config) <= 0) {
      // Waiting for a slot is not a failure: keep kind and attempt, retry after one poll interval.
      this.#scheduleRetry(
        issueId,
        retry.attempt,
        { identifier: retry.identifier, url: retry.url, kind: retry.kind, error: 'no available orchestrator slots' },
        config.polling.intervalMs,
      );
      return;
    }
    this.#dispatch(issue, retry.attempt, workflow, adapter, retry.kind === 'continuation');
  }

  #release(issueId: string): void {
    this.#cancelRetry(issueId);
    this.#claimed.delete(issueId);
    this.#records.delete(issueId);
    this.#paused.delete(issueId);
  }

  /** Holds an issue that stays active after its continuation sessions, until it changes. */
  #pause(issue: Issue, continuations: number, limit: number): void {
    this.#paused.set(issue.id, {
      issueId: issue.id,
      identifier: issue.identifier,
      url: issue.url,
      state: issue.state,
      updatedAtMs: issue.updated_at?.getTime() ?? null,
      continuations,
      pausedAt: this.#clock.now(),
    });
    this.#claimed.add(issue.id);
    this.#deps.history?.note(this.#repositoryOf(issue), 'issue_paused', {
      issue: issue.identifier,
      title: issue.title,
      state: issue.state,
      continuations,
      max_continuations: limit,
    });
    this.#issueLogger(issue).warn(
      'issue paused: still active after its continuation sessions; change it on the board (status, comment, labels) to resume',
      { state: issue.state, continuations, max_continuations: limit },
    );
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
      // Workspace preparation (hooks, composer, Boost) has its own timeouts and emits no agent events.
      if (stallMs <= 0 || entry.phase === 'PreparingWorkspace') continue;
      const elapsed = now - (entry.lastEventAtMs ?? entry.preparedAtMs ?? entry.startedAtMs);
      if (elapsed > stallMs) {
        this.#requestStop(entry, { kind: 'stalled', cleanupWorkspace: false, reason: `no agent activity for ${Math.round(elapsed / 1000)}s` });
      }
    }

    // Part B: tracker state refresh for everything still running, plus paused issues and released
    // issues that still have a workspace (so it is deleted as soon as they reach a terminal state).
    const ids = [...this.#running.values()].filter((entry) => entry.stop === null).map((entry) => entry.issueId);
    const pausedIds = [...this.#paused.keys()];
    const watchedIds = config.workspace.cleanupTerminal
      ? [...this.#watched.keys()].filter((id) => !this.#claimed.has(id) && !this.#cleanups.has(id))
      : [];
    if (ids.length === 0 && pausedIds.length === 0 && watchedIds.length === 0) return;
    let refreshed: Issue[];
    try {
      refreshed = await this.#adapterFor(workflow).fetchIssuesByIds([...ids, ...pausedIds, ...watchedIds]);
    } catch (error) {
      this.#trackerFailure('running-issue refresh failed; keeping workers running', error);
      return;
    }
    const byId = new Map(refreshed.map((issue) => [issue.id, issue]));
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
      } else if (!isActiveState(issue.state, config.tracker) || !isRoutable(issue, config.tracker)) {
        log.info('paused issue left the active states; releasing it', { state: issue.state });
        this.#release(id);
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
    }
    if (event.event === 'session_configured' && typeof event.detail?.model === 'string') entry.model = event.detail.model;

    if (event.usage !== undefined) {
      const delta = usageDelta(event.usage, entry.reported);
      this.#totals.inputTokens += delta.inputTokens;
      this.#totals.outputTokens += delta.outputTokens;
      this.#totals.totalTokens += delta.totalTokens;
      entry.tokens = event.usage;
      entry.reported = event.usage;
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

    const record = this.#records.get(entry.issueId);
    if (record !== undefined && event.message !== undefined && event.message !== '') {
      record.recentEvents.push({ at: event.timestamp.toISOString(), event: event.event, message: event.message });
      if (record.recentEvents.length > RECENT_EVENTS) record.recentEvents.shift();
    }

    const failedTool = event.event === 'tracker_tool' && event.detail?.ok === false;
    const level = WARNING_EVENTS.has(event.event) || failedTool ? 'warn' : LIFECYCLE_EVENTS.has(event.event) ? 'info' : 'debug';
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
      record = { identifier: issue.identifier, url: issue.url, workspacePath: null, runs: 0, continuations: 0, lastError: null, recentEvents: [], lastRun: null };
      this.#records.set(issue.id, record);
    }
    record.identifier = issue.identifier;
    record.url = issue.url;
    return record;
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
      // The model that used the most tokens; until the first turn ends, the one the session started with.
      model: primaryModelOf(entry.modelUsage) ?? entry.model,
      cost_usd: Math.round(entry.costUsd * 10_000) / 10_000,
      claude_estimate_usd: Math.round(entry.claudeEstimateUsd * 10_000) / 10_000,
      repo: entry.repo,
      stopping: entry.stop?.reason ?? null,
      head_sha: entry.headSha,
      branch: entry.branch,
      mcp_tool_calls: entry.mcpToolCalls,
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
    };
  }

  #pausedRow(paused: PausedEntry) {
    return {
      issue_id: paused.issueId,
      issue_identifier: paused.identifier,
      issue_url: paused.url,
      state: paused.state,
      continuations: paused.continuations,
      paused_at: paused.pausedAt.toISOString(),
    };
  }

  /** Runtime snapshot for GET /api/v1/state (spec 13.3). */
  snapshot() {
    const now = this.#clock.monotonicMs();
    const workflow = this.#deps.workflow.current;
    const config = workflow.config;
    let activeSeconds = 0;
    for (const entry of this.#running.values()) activeSeconds += (now - entry.startedAtMs) / 1000;
    return {
      generated_at: this.#clock.now().toISOString(),
      counts: { running: this.#running.size, retrying: this.#retries.size, paused: this.#paused.size, claimed: this.#claimed.size },
      running: [...this.#running.values()].map((entry) => this.#runningRow(entry, now)),
      retrying: [...this.#retries.values()].sort((a, b) => a.dueAtMs - b.dueAtMs).map((retry) => this.#retryRow(retry, now)),
      paused: [...this.#paused.values()].map((paused) => this.#pausedRow(paused)),
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
        last_tick_at: this.#lastTickAt?.toISOString() ?? null,
        last_tracker_error: this.#lastTrackerError
          ? { at: this.#lastTrackerError.at.toISOString(), message: this.#lastTrackerError.message }
          : null,
        tracker_kind: config.tracker.kind,
        active_states: config.tracker.activeStates,
        terminal_states: config.tracker.terminalStates,
        poll_interval_ms: this.#pollIntervalMs,
        max_concurrent_agents: config.agent.maxConcurrentAgents,
        max_turns: config.agent.maxTurns,
        max_continuations: config.agent.maxContinuations,
        cleanup_terminal: config.workspace.cleanupTerminal,
        completed_count: this.#completed.size,
        pricing_file: this.#deps.pricing?.path ?? null,
        pricing_error: this.#deps.pricing?.lastError ?? null,
        history_dir: this.#deps.history?.dir ?? null,
      },
    };
  }

  /** Debug details for GET /api/v1/<issue_identifier>; null when the issue is not tracked. */
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
    if (issueId === undefined) return null;
    const record = this.#records.get(issueId);
    const identifier = entry?.identifier ?? retry?.identifier ?? record?.identifier ?? key;
    return {
      issue_identifier: identifier,
      issue_id: issueId,
      issue_url: entry?.issue.url ?? retry?.url ?? record?.url ?? null,
      status:
        entry !== undefined ? (entry.stop !== null ? 'stopping' : 'running') : retry !== undefined ? 'retrying' : paused !== undefined ? 'paused' : 'claimed',
      role: entry?.role ?? null,
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
      recent_events: record?.recentEvents ?? [],
      last_error: record?.lastError ?? null,
      tracked: { completed_before: this.#completed.has(issueId) },
    };
  }
}
