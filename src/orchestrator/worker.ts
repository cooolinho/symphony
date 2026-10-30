import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import { sessionClaudeConfig } from '../agent/model.ts';
import type { AgentEvent, AgentRunner, AgentSession, IntegrationReport, SessionLimitInfo } from '../agent/types.ts';
import { brainToolsFor, createVaultGit } from '../brain/tools.ts';
import { repoFolderName } from '../brain/vault.ts';
import { isRepositoryName } from '../tracker/github-project/settings.ts';
import { prepareIntegrations } from '../integrations/registry.ts';
import type { WorkspaceIntegration } from '../integrations/types.ts';
import type { Logger } from '../log.ts';
import type { AgentToolSpec, AutoMergeResult, Issue, IssueComment, ToolResult, TrackedResult, TrackerAdapter } from '../tracker/types.ts';
import { SymphonyError, errorMessage } from '../util/errors.ts';
import { describeHolder, type LockResult } from '../workspace/lock.ts';
import { describeFailure, type HookIssue, type Workspace, type WorkspaceManager } from '../workspace/manager.ts';
import { commandSkills, pluginAgents } from '../workflow/command.ts';
import { classify } from '../workflow/classify.ts';
import { profileFor } from '../workflow/profile.ts';
import { roleName, sessionAgents, sessionBrainMode, type RoleConfig } from '../workflow/roles.ts';
import type { EffectiveWorkflow } from '../workflow/store.ts';
import { internalResult, renderResultComment, type ResultMeta } from '../workflow/results.ts';
import { maxColumnCheckMs, normalizeStateName, type ServiceConfig } from '../workflow/config.ts';
import { EMPTY_RESULTS, issueTemplateValue, renderPrompt } from '../workflow/template.ts';
import { writeAttachments, type AttachmentFile } from '../workspace/attachments.ts';
import { changedFiles, commitStats, type CommitStat } from '../workspace/changes.ts';
import { baselineCommit, changedFilesSince, isAncestor } from './changed-files.ts';
import { createGuard, guardTools, toolsForRole, type CheckCache, type CheckRecord, type GateRun, type GuardParams } from './guard.ts';
import { createResultTool, resultReminder, type PathRule, type ResultToolAdapter, type ResultToolParams } from './result-tool.ts';
import { reviewedFiles, securityBaseRef } from './security.ts';
import { interruptedTransition } from './recovery.ts';
import { analysisFlagsSecurity, analysisNeedsDocs, docsBaseHead, buildStageHistory, humanFeedback, implementationHead, resultsTemplateValue, type HumanFeedbackComment, type PersistedResult, type ResultsTemplateValue, type StageHistory } from './stage-history.ts';
import { effectivePaths } from '../workflow/path-globs.ts';
import { subIssueLimit } from './work-packages.ts';

export type RunPhase =
  | 'PreparingWorkspace'
  | 'BuildingPrompt'
  | 'LaunchingAgentProcess'
  | 'InitializingSession'
  | 'StreamingTurn'
  /** An entry check runs inside a status-changing tool call; the agent emits no events meanwhile. */
  | 'RunningChecks'
  | 'Finishing'
  | 'Succeeded'
  | 'Failed'
  | 'TimedOut'
  | 'Stalled'
  | 'CanceledByReconciliation';

export type WorkerOutcome =
  | {
      kind: 'normal';
      turns: number;
      reason: string;
      /**
       * A result-driven role ended its run without recording a result, after the reminder turn or at the turn limit
       * while the issue was still in its column. The orchestrator confirms the column and applies `on_missing_result`.
       */
      missingResult?: true;
      /** With `missingResult`: background tasks still running when the last turn ended (they end with the session). */
      backgroundTasks?: string[];
    }
  | { kind: 'failed'; code: string; message: string; phase: RunPhase; sessionLimit?: SessionLimitInfo }
  | { kind: 'cancelled'; message: string };

/** Final commit and branch of a git workspace. */
export interface GitHead {
  headSha: string;
  branch: string;
}

/** Added to checks.timeout_ms for the tool-call timeout of Symphony's MCP server. */
export const TOOL_TIMEOUT_MARGIN_MS = 60_000;

/** Upper bound for reading the final commit and branch; the two git calls run in parallel. */
const GIT_HEAD_TIMEOUT_MS = 5000;

function gitOutput(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_HEAD_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

/** Best effort: null for a non-git workspace or when git is slow or fails. Never throws. */
export async function readGitHead(workspacePath: string): Promise<GitHead | null> {
  try {
    if (!fs.existsSync(path.join(workspacePath, '.git'))) return null;
    const [headSha, branch] = await Promise.all([
      gitOutput(workspacePath, ['rev-parse', 'HEAD']),
      gitOutput(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    ]);
    return headSha === '' ? null : { headSha, branch };
  } catch {
    return null;
  }
}

export interface WorkerCallbacks {
  phase(phase: RunPhase): void;
  workspace(workspace: Workspace): void;
  agentEvent(event: AgentEvent): void;
  issueRefreshed(issue: Issue): void;
  /** Names of the MCP servers Symphony added that did not connect (called once the session started). */
  mcpUnavailable(servers: string[]): void;
  /** Extra `run_started` fields and reports (e.g. Laravel Boost) of the prepared integrations (called once, after they ran). */
  integrationsPrepared(historyFields: Record<string, string>, reports: IntegrationReport[]): void;
  /** Final commit and branch of the workspace, reported once while the attempt finishes. */
  gitHead(head: GitHead): void;
  /** The session recorded its stage result (called once, when `report_result` posts the result comment). */
  resultRecorded(): void;
  /** The recorded result moved the issue (called once, after `report_result` moved it; not when the move failed). */
  resultMoved(): void;
  /** Result of an entry check run by the transition guard. */
  checkFinished(check: CheckRecord): void;
  /** The state of the entry gate changed (a snapshot: checks pending, running, finished). */
  gateUpdated(gate: GateRun): void;
  /** The session recorded a stage result: called once, with the result as persisted, when `report_result` posts its comment. */
  stageResult(entry: PersistedResult): void;
  /** The issue's stage results: as loaded at the start of a result-driven session, again with each result it records. */
  results(results: PersistedResult[]): void;
  /** The guard refused a move (terminal column or outside the role's `may_move_to`). */
  transitionDenied(target: string, message: string): void;
  /** JSONL transcript of this attempt's agent session, reported before the session starts. */
  transcript(path: string): void;
  /** The commits the session added to the workspace's branch, oldest first: once while the attempt finishes, only with at least one. */
  commits(commits: CommitStat[]): Promise<void> | void;
  /** A tool call (`set_status`, `report_result`) whose `auto_merge` merged the issue's pull request. */
  merged(result: AutoMergeResult): void;
}

/** The `auto_merge` of a successful tool result, when it merged. */
function mergedBy(result: ToolResult): AutoMergeResult | null {
  if (!result.ok || typeof result.data !== 'object' || result.data === null) return null;
  const merge = (result.data as { auto_merge?: unknown }).auto_merge;
  if (typeof merge !== 'object' || merge === null || (merge as AutoMergeResult).merged !== true) return null;
  return merge as AutoMergeResult;
}

/** Wraps every spec that moves the issue so a call whose `auto_merge` merged reports it; the result stays unchanged. */
export function observeMerges(specs: AgentToolSpec[], onMerged: (result: AutoMergeResult) => void): AgentToolSpec[] {
  return specs.map((spec) => {
    if (spec.transitionTarget === undefined) return spec;
    return {
      ...spec,
      execute: async (args, context) => {
        const result = await spec.execute(args, context);
        const merge = mergedBy(result);
        if (merge !== null) {
          try {
            onMerged(merge);
          } catch {
            // Recording the merge never fails the tool call.
          }
        }
        return result;
      },
    };
  });
}

export interface WorkerParams {
  /** Context window (tokens) of a model id; null when unknown. Passed on to the session. */
  contextWindow?: (model: string) => number | null;
  issue: Issue;
  /** Id of this run, recorded in the meta of the results it reports; null when unknown. */
  runId: string | null;
  attempt: number | null;
  /** Workflow snapshot for this attempt: prompt, max_turns and agent settings stay fixed for the session. */
  workflow: EffectiveWorkflow;
  /** Model for the session: a "Model: <model>" label, else roles.<role>.claude.model, else claude.model; null = Claude Code default. */
  model: string | null;
  /** Effort for the session: an "Effort: <level>" label, else roles.<role>.claude.effort, else claude.effort; null = Claude Code default. */
  effort: EffortLevel | null;
  /** Role serving the issue's column at dispatch; null = the implicit `default` role. Fixed for the run. */
  role: RoleConfig | null;
  /** The issue's stage results, when the dispatch has just read them; omitted = the run reads them itself. */
  results?: readonly TrackedResult[];
  /** Adapter snapshot: the tools advertised to the session and the ones executed are the same. */
  adapter: TrackerAdapter;
  runner: AgentRunner;
  /** Workspace integrations (e.g. Laravel Boost) prepared after before_run; their configs live in workflow.config.integrations. */
  integrations: readonly WorkspaceIntegration[];
  workspaces: WorkspaceManager;
  /** Environment for the agent process (tracker secrets already removed). */
  childEnv: NodeJS.ProcessEnv;
  logger: Logger;
  signal: AbortSignal;
  /** Passing entry-check results of the claim, shared by its sessions. */
  checkCache: CheckCache;
  /** Directory for per-session JSONL transcripts, or null to disable them. */
  transcriptDir: string | null;
  /**
   * Live check after each turn (uses the current workflow config): null continues the session, a string ends it
   * normally with that reason (the issue left the active states, is no longer routable, or another role serves it).
   */
  continueWith: (issue: Issue) => string | null;
  callbacks: WorkerCallbacks;
}

/** Prepends one generic note per unavailable MCP server; integration-specific hints stay in their own prompt sections. */
function withMcpNotes(unavailable: Array<[string, string]>, prompt: string): string {
  if (unavailable.length === 0) return prompt;
  const notes = unavailable.map(([name, status]) => `MCP server \`${name}\` is unavailable (${status}); do not call its tools.`);
  return `${notes.join('\n')}\n\n${prompt}`;
}

/** What a session of a result-driven role starts with: the issue's stage history and the tool that extends it. */
interface ResultSupport {
  tool: AgentToolSpec;
  results: ResultsTemplateValue;
  /** The prompt variable `human_feedback`: what a human wrote since the pipeline last handed the issue off. */
  humanFeedback: HumanFeedbackComment[];
  round: number;
}

/**
 * The path rule of a role with `result: test`: its session may only change files matching `pipeline.test_paths`,
 * measured from the developer's last hand-off (`handoffSha`) when HEAD descends from it, else from the commit the
 * session started from (`startSha`); a session that started on the base branch (`startOnBase`) does not blame the merged
 * pull requests between the hand-off and its start. Without a commit to measure from (not a git checkout, or git failed) the rule
 * cannot be evaluated: it refuses to guess, so the result is not accepted unchecked.
 */
function testPathRule(workspacePath: string, testPaths: readonly string[], startSha: string | null, startOnBase: boolean, handoffSha: string | null, extra: Pick<PathRule, 'setting' | 'guidance'> = {}): PathRule {
  return {
    ...extra,
    allowed: testPaths,
    changedFiles: async () => {
      const base = await baselineCommit(workspacePath, handoffSha, startSha, startOnBase);
      if (base === null) throw new SymphonyError('paths_unverifiable', 'the commit this session started from is unknown');
      return { base, files: await changedFilesSince(workspacePath, base) };
    },
  };
}

/**
 * `reportStatus` for the transition guard: named checks become tracker statuses (GitHub: `symphony/<name>`) when
 * `checks.report_status` is on and the tracker can report them; the link goes to the issue's agent page.
 */
export function checkStatusReporter(
  config: Pick<ServiceConfig, 'checks' | 'server'>,
  adapter: Pick<TrackerAdapter, 'reportCheckStatus'>,
  issue: Issue,
): Pick<GuardParams, 'reportStatus'> {
  if (!config.checks.reportStatus || adapter.reportCheckStatus === undefined) return {};
  const targetUrl = config.server.publicUrl !== null ? `${config.server.publicUrl}/issue?id=${encodeURIComponent(issue.identifier)}` : null;
  return { reportStatus: (report) => adapter.reportCheckStatus?.(issue, { ...report, targetUrl }) ?? Promise.resolve() };
}

const RESULT_CAPABILITIES = ['readResults', 'postComment', 'setStatus', 'addLabels', 'removeLabels'] as const;

/**
 * Loads the issue's stage history and builds the `report_result` tool for a session of a result-driven role: one
 * paginated read of the issue's comments, plus the board's columns (cached by the adapter). Any failure is a
 * `results_read_error`: without the history the round counters would be wrong, so the run fails and is retried.
 */
async function loadResultSupport(
  params: WorkerParams,
  role: RoleConfig,
  issue: () => Issue,
  headSha: () => Promise<string | null>,
  pathRule: ((history: StageHistory) => PathRule) | null,
  security: ((history: StageHistory) => NonNullable<ResultToolParams['security']>) | null,
  docs: ((history: StageHistory) => NonNullable<ResultToolParams['docs']>) | null,
  screenshots: ResultToolParams['screenshots'],
  report: (results: PersistedResult[]) => void,
  onRecorded: (entry: PersistedResult) => void,
  onMoved: () => void,
): Promise<ResultSupport> {
  const { adapter, workflow } = params;
  const missing = RESULT_CAPABILITIES.filter((capability) => adapter[capability] === undefined);
  if (missing.length > 0) {
    throw new SymphonyError('results_read_error', `role ${role.name} reports results, but the ${adapter.kind} tracker lacks ${missing.join(', ')}`);
  }
  const resultAdapter = adapter as TrackerAdapter & ResultToolAdapter & Required<Pick<TrackerAdapter, 'readResults'>>;
  let tracked;
  let boardColumns: string[] | null;
  let comments: Awaited<ReturnType<typeof readHumanComments>>;
  try {
    [tracked, comments] = await Promise.all([params.results ?? resultAdapter.readResults(issue()), readHumanComments(adapter, issue())]);
    boardColumns = adapter.statusOptions !== undefined ? await adapter.statusOptions() : null;
  } catch (error) {
    throw new SymphonyError('results_read_error', `could not read the stage results of ${issue().identifier}: ${errorMessage(error)}`, { cause: error });
  }
  let persisted: PersistedResult[] = tracked.map(({ result, meta, url }) => ({ result, meta, url }));
  let history = buildStageHistory(persisted);
  const reset = interruptedTransition(issue(), role, tracked) === null ? await resetAfterHumanResume(params, resultAdapter, issue(), history) : null;
  if (reset !== null) {
    persisted = [...persisted, reset];
    history = buildStageHistory(persisted);
  }
  report(history.results);
  const tool = createResultTool({
    role,
    history,
    onRecorded: (entry) => {
      report([...history.results, entry]);
      onRecorded(entry);
    },
    onMoved,
    profile: profileFor(workflow.config.pipeline, classify(issue().labels).type),
    config: workflow.config,
    boardColumns,
    adapter: resultAdapter,
    issue,
    runId: params.runId,
    meta: { workflowHash: workflow.contentHash, headSha },
    pathRule: pathRule?.(history) ?? null,
    security: security?.(history) ?? null,
    docs: docs?.(history) ?? null,
    screenshots: screenshots ?? null,
  });
  return {
    tool,
    results: resultsTemplateValue(history),
    humanFeedback: comments === null ? [] : humanFeedback(comments.comments, comments.viewer, history.results),
    round: (role.result === 'test' ? history.testRounds : role.result === 'security' ? history.securityRounds : history.reviewRounds) + 1,
  };
}

/** The issue's comments and Symphony's own login, for `human_feedback`; null when the tracker cannot read comments. */
async function readHumanComments(adapter: TrackerAdapter, issue: Issue): Promise<{ comments: IssueComment[]; viewer: string } | null> {
  if (adapter.readComments === undefined || adapter.viewerLogin === undefined) return null;
  const [comments, viewer] = await Promise.all([adapter.readComments(issue), adapter.viewerLogin()]);
  return { comments, viewer };
}

/**
 * A human moved the issue back into an active column after a hand-off to a non-active one (a round limit or Blocked):
 * the newest marker still points at that column, but the board is elsewhere. Not called for a hand-off whose move never
 * happened (`interruptedTransition`): its rounds go on. Records a `reset` marker so the loop starts
 * at round 1 and removes the limit label. Returns the marker, or null when nothing was written.
 */
async function resetAfterHumanResume(
  params: WorkerParams,
  adapter: ResultToolAdapter,
  issue: Issue,
  history: StageHistory,
): Promise<PersistedResult | null> {
  const { activeStates } = params.workflow.config.tracker;
  const target = history.lastTarget;
  if (target === null) return null;
  const isActive = (state: string) => activeStates.some((active) => normalizeStateName(active) === normalizeStateName(state));
  if (isActive(target) || !isActive(issue.state)) return null;
  const result = internalResult('reset', `${issue.identifier} was moved from "${target}" back to "${issue.state}" by a human; the round counters start again.`);
  const meta: ResultMeta = {
    role: 'symphony',
    run: params.runId,
    round: null,
    profile: null,
    workflow_hash: params.workflow.contentHash,
    head_sha: null,
    checks: null,
    target: null,
    created_at: new Date().toISOString(),
  };
  try {
    await adapter.postComment(issue, renderResultComment(result, meta));
  } catch (error) {
    throw new SymphonyError('results_read_error', `could not record the reset of ${issue.identifier}: ${errorMessage(error)}`, { cause: error });
  }
  const label = params.workflow.config.pipeline.limitLabel;
  if (issue.labels.some((name) => name.toLowerCase() === label.toLowerCase())) {
    await adapter.removeLabels(issue, [label]).catch((error: unknown) => params.logger.warn('could not remove the limit label', { error: errorMessage(error) }));
  }
  return { result, meta };
}

function transcriptPath(dir: string | null, workspace: Workspace): string | null {
  if (dir === null) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, workspace.key, `${stamp}.jsonl`);
}

/**
 * Downloads the issue's attachments into the workspace for the prompt variable `attachments`. Never throws: when the
 * issue cannot be read, the list holds one entry with the error, so the agent knows the files are missing.
 */
async function prepareAttachments(adapter: TrackerAdapter, issue: Issue, workspacePath: string, logger: Logger): Promise<AttachmentFile[]> {
  if (adapter.issueAttachments === undefined) return [];
  try {
    const files = await writeAttachments(workspacePath, await adapter.issueAttachments(issue));
    if (files.length > 0) {
      logger.info('issue attachments downloaded', { files: files.map((file) => file.path ?? `failed (${file.error})`).join(', ') });
    }
    return files;
  } catch (error) {
    logger.warn('issue attachments could not be downloaded', { error: errorMessage(error) });
    await writeAttachments(workspacePath, []).catch(() => undefined);
    return [{ path: null, label: '', source: 'description and comments', error: errorMessage(error) }];
  }
}

/**
 * One run attempt (spec 16.5): workspace, before_run, one live agent session with up to
 * max_turns turns while the issue stays active, then after_run. Never throws.
 */
export async function runAgentAttempt(params: WorkerParams): Promise<WorkerOutcome> {
  const { signal, callbacks, logger } = params;
  const role = params.role;
  const name = roleName(role);
  const maxTurns = role?.maxTurns ?? params.workflow.config.agent.maxTurns;
  const maxTurnsSetting = role !== null && role.maxTurns !== null ? `roles.${name}.max_turns` : 'agent.max_turns';
  let issue = params.issue;
  let workspace: Workspace | null = null;
  let session: AgentSession | null = null;
  let phase: RunPhase = 'PreparingWorkspace';
  let lock: Extract<LockResult, { ok: true }> | null = null;
  // HEAD before the agent acted; set once the session is about to start (undefined: no session, no commits to report).
  let sessionStart: { sha: string | null } | undefined;

  const setPhase = (next: RunPhase) => {
    phase = next;
    callbacks.phase(next);
  };
  const hookIssue = (): HookIssue => ({
    id: issue.id,
    identifier: issue.identifier,
    url: issue.url,
    branch_name: issue.branch_name,
    env: params.adapter.hookEnvironment?.(issue) ?? {},
  });
  const cancelled = (): WorkerOutcome => ({ kind: 'cancelled', message: String(signal.reason ?? 'cancelled') });

  const finish = async (outcome: WorkerOutcome): Promise<WorkerOutcome> => {
    setPhase('Finishing');
    if (session !== null) {
      await session.stop().catch((error: unknown) => logger.warn('agent session stop failed', { error: errorMessage(error) }));
    }
    if (workspace !== null) {
      // after_run runs after every attempt once the workspace exists; its failure is only logged.
      await params.workspaces
        .runHook('after_run', workspace, hookIssue())
        .catch((error: unknown) => logger.warn('after_run hook could not run', { error: errorMessage(error) }));
      const head = await readGitHead(workspace.path);
      if (head !== null) callbacks.gitHead(head);
      if (head !== null && sessionStart !== undefined && head.headSha !== sessionStart.sha) await reportCommits(workspace.path, sessionStart.sha);
    }
    if (lock !== null) {
      await lock.release().catch((error: unknown) => logger.warn('workspace lock could not be released', { error: errorMessage(error) }));
      lock = null;
    }
    return outcome;
  };

  const reportCommits = async (workspacePath: string, since: string | null) => {
    try {
      const commits = await commitStats(workspacePath, { since, base: securityBaseRef(issue.native_ref?.base_branch) });
      if (commits.length > 0) await callbacks.commits(commits);
    } catch (error) {
      logger.warn('could not list the commits of the session', { error: errorMessage(error) });
    }
  };

  try {
    setPhase('PreparingWorkspace');
    const acquired = await params.workspaces.lock(issue.identifier);
    if (!acquired.ok) {
      // Another Symphony instance owns this workspace: no hooks, no session. The next poll tick retries.
      const message = `workspace locked by ${describeHolder(acquired.holder)}`;
      logger.warn('workspace is locked by another Symphony instance; skipping this attempt', { holder: describeHolder(acquired.holder) });
      return await finish({ kind: 'cancelled', message });
    }
    lock = acquired;
    workspace = await params.workspaces.ensure(hookIssue());
    callbacks.workspace(workspace);
    if (signal.aborted) return await finish(cancelled());

    const beforeRun = await params.workspaces.runHook('before_run', workspace, hookIssue());
    if (beforeRun !== null && !beforeRun.ok) {
      return await finish({ kind: 'failed', code: 'hook_failed', message: `before_run hook ${describeFailure(beforeRun)}`, phase });
    }
    if (signal.aborted) return await finish(cancelled());

    // Workspace integrations (e.g. Laravel Boost); problems only log warnings.
    const extensions = await prepareIntegrations(params.integrations, params.workflow.config.integrations, {
      workspacePath: workspace.path,
      env: params.childEnv,
      logger,
      signal,
    });
    callbacks.integrationsPrepared(extensions?.historyFields ?? {}, extensions?.reports ?? []);
    if (signal.aborted) return await finish(cancelled());

    // Images and PDFs uploaded to the issue: the agent only sees their content when it opens the downloaded files.
    const attachments = await prepareAttachments(params.adapter, issue, workspace.path, logger);
    if (signal.aborted) return await finish(cancelled());

    // Plugin subagents for this role and workspace: the prompt lists the allowed ones, the session refuses the rest.
    const agents = sessionAgents(
      pluginAgents(params.workflow.config.claude.plugins),
      role,
      params.integrations.flatMap((integration) => (integration.agentPrefix !== undefined ? [integration.agentPrefix] : [])),
      extensions?.agentPrefixes ?? [],
    );
    const agentsValue = agents.allowed.map((agent) => ({ name: agent.qualified, description: agent.description }));

    setPhase('LaunchingAgentProcess');
    const activeWorkspace = workspace;
    // Guard events carry the session fields of the latest agent event, so they do not reset the running entry.
    let lastEvent: AgentEvent | null = null;
    // Whether the newest entry check timed out; in a result-driven session every check belongs to `report_result`.
    let checkTimedOut = false;
    const onEvent = (event: AgentEvent) => {
      lastEvent = event;
      callbacks.agentEvent(event);
    };
    const guard = createGuard({
      role,
      config: params.workflow.config,
      workspace: activeWorkspace,
      issue: hookIssue,
      manager: params.workspaces,
      signal,
      cache: params.checkCache,
      headSha: async () => (await readGitHead(activeWorkspace.path))?.headSha ?? null,
      whileChecking: async (run) => {
        const previous = phase;
        setPhase('RunningChecks');
        try {
          return await run();
        } finally {
          // A stopped run may have moved on to Finishing meanwhile; keep that.
          if (phase === 'RunningChecks') setPhase(previous);
        }
      },
      onCheckFinished: (check) => {
        checkTimedOut = check.result === 'check_timeout';
        callbacks.checkFinished(check);
      },
      onGateUpdate: (gate) => callbacks.gateUpdated(gate),
      onDenied: (target, message) => callbacks.transitionDenied(target, message),
      ...checkStatusReporter(params.workflow.config, params.adapter, issue),
      onEvent: (event, message, detail) =>
        callbacks.agentEvent({
          pid: lastEvent?.pid ?? null,
          threadId: lastEvent?.threadId ?? null,
          turnId: lastEvent?.turnId ?? null,
          sessionId: lastEvent?.sessionId ?? null,
          turnCount: lastEvent?.turnCount ?? 0,
          event,
          timestamp: new Date(),
          message,
          detail,
        }),
    });
    // Roles with `result` start with the issue's stage history; every other role makes no extra tracker request.
    let resultRecorded = false;
    let resultMoved = false;
    // Default path globs also apply below the root of a Laravel app in a subdirectory; explicit ones stay as written.
    const appDirs = (await Promise.all(params.integrations.map((integration) => integration.appDirs?.(activeWorkspace.path) ?? []))).flat();
    const paths = effectivePaths(params.workflow.config.pipeline, appDirs);
    // A test engineer's changes are measured from the developer's last hand-off, else from the workspace as this session found it.
    // Also where the session's commits start (change log).
    const startSha = (await readGitHead(activeWorkspace.path))?.headSha ?? null;
    // Fixed before the agent acts, so a push of its own cannot move the baseline; false when git cannot tell.
    const startOnBase = (role?.result === 'test' || role?.result === 'docs') && startSha !== null && (await isAncestor(activeWorkspace.path, startSha, securityBaseRef(issue.native_ref?.base_branch)));
    const pathRule =
      role?.result === 'test'
        ? (history: StageHistory) => testPathRule(activeWorkspace.path, paths.testPaths, startSha, startOnBase, implementationHead(history))
        : role?.result === 'docs'
          ? (history: StageHistory) =>
              testPathRule(activeWorkspace.path, paths.docsPaths, startSha, startOnBase, docsBaseHead(history), {
                setting: 'pipeline.docs_paths',
                guidance: 'Code and tests belong to the developer and the test engineer: leave them alone and report the verdict `blocked` if the documentation cannot be written without changing them.',
              })
          : null;
    // A developer's or test engineer's hand-off needs the documentation stage for a docs_needed analysis or changed configuration files.
    const docs =
      role?.result === 'implementation' || role?.result === 'test'
        ? (history: StageHistory) => ({
            docsNeeded: analysisNeedsDocs(history),
            docsPaths: paths.docsPaths,
            triggerPaths: paths.docsTriggerPaths,
            changedFiles: () => changedFiles(activeWorkspace.path, securityBaseRef(issue.native_ref?.base_branch)),
          })
        : null;
    // A developer's hand-off for a UI change needs screenshots (or the reason there are none), when the project asks for them.
    const screenshots =
      role?.result === 'implementation'
        ? {
            uiPaths: paths.uiPaths,
            screenshotPaths: paths.screenshotPaths,
            policy: params.workflow.config.pipeline.requireScreenshots,
            workspace: activeWorkspace.path,
            issueText: () => `${issue.title}\n${issue.description ?? ''}`,
            changedFiles: () => changedFiles(activeWorkspace.path, securityBaseRef(issue.native_ref?.base_branch)),
          }
        : null;
    // A reviewer's approval needs the security review for a security label, a risk in the analysis or a changed security
    // path (for an integration review: a path the merged work packages changed).
    const security =
      role?.result === 'review'
        ? (history: StageHistory) => ({
            risk: analysisFlagsSecurity(history),
            securityPaths: paths.securityPaths,
            changedFiles: () => reviewedFiles(activeWorkspace.path, issue, history),
          })
        : null;
    const support =
      role?.result != null
        ? await loadResultSupport(
            params,
            role,
            () => issue,
            async () => (await readGitHead(activeWorkspace.path))?.headSha ?? null,
            pathRule,
            security,
            docs,
            screenshots,
            callbacks.results,
            (entry) => {
              resultRecorded = true;
              callbacks.resultRecorded();
              callbacks.stageResult(entry);
            },
            () => {
              resultMoved = true;
              callbacks.resultMoved();
            },
          )
        : null;
    if (signal.aborted) return await finish(cancelled());
    const brainMode = sessionBrainMode(params.workflow.config.brain.enabled, role);
    const repository = params.adapter.issueRepository?.(issue) ?? null;
    const resultVariables = {
      brain: brainMode,
      brain_index: repository !== null && isRepositoryName(repository) ? `Repos/${repoFolderName(repository)}/index.md` : null,
      results: support?.results ?? EMPTY_RESULTS,
      human_feedback: support?.humanFeedback ?? [],
      round: support?.round ?? 1,
      result_required: support !== null,
      test_paths: paths.testPaths,
      docs_paths: paths.docsPaths,
      attachments,
    };
    const transcript = transcriptPath(params.transcriptDir, activeWorkspace);
    if (transcript !== null) callbacks.transcript(transcript);
    // An architect files sub-issues only to split an issue it may split (XL, not a work package itself).
    const subIssues = subIssueLimit(role, issue);
    sessionStart = { sha: startSha };
    const brainTools = brainToolsFor(
      params.workflow.config.brain,
      brainMode,
      logger,
      brainMode !== 'off' ? { versioning: createVaultGit(params.workflow.config.brain.path, logger) } : {},
    );
    session = await params.runner.startSession({
      ...(params.contextWindow ? { contextWindow: params.contextWindow } : {}),
      cwd: activeWorkspace.path,
      issue,
      config: sessionClaudeConfig(params.workflow.config.claude, params.model, params.effort, role?.claude),
      policy: { readOnly: role?.readOnly ?? false },
      // The bare name too: a repository's own .claude/agents may load the same agent without the plugin prefix.
      deniedAgents: agents.denied.flatMap((agent) => [agent.qualified, agent.name]),
      // Entry checks run inside the status tool call; leave a minute for the tracker call around them.
      toolTimeoutMs: Math.max(params.workflow.config.checks.timeoutMs, maxColumnCheckMs(params.workflow.config.checks)) + TOOL_TIMEOUT_MARGIN_MS,
      tools: guardTools(observeMerges(toolsForRole(params.adapter.agentToolSpecs(), role, issue, support?.tool ?? null), callbacks.merged), guard),
      ...(brainTools.length > 0 ? { brainTools } : {}),
      toolContext: () => ({
        issue,
        role: name,
        ...(params.runId !== null ? { runId: params.runId } : {}),
        ...(subIssues !== null ? { maxSubIssues: subIssues } : {}),
        ...(role?.subIssueStatus != null ? { subIssueStatus: role.subIssueStatus } : {}),
      }),
      env: params.childEnv,
      logger,
      signal,
      onEvent,
      transcriptPath: transcript,
      ...(extensions !== null ? { extensions } : {}),
    });
    const unavailableMcp = Object.entries(session.mcpStatus ?? {}).filter(([, status]) => status !== 'connected');
    if (unavailableMcp.length > 0) callbacks.mcpUnavailable(unavailableMcp.map(([name]) => name));

    const skills = commandSkills(params.workflow.config.claude.plugins);
    // What the last turn left running in the background; the session's end stops it.
    let backgroundTasks: string[] = [];
    for (let turn = 1; ; turn++) {
      setPhase('BuildingPrompt');
      let prompt: string;
      if (turn === 1) {
        prompt = withMcpNotes(unavailableMcp, await renderPrompt(params.workflow.prompt, { issue: issueTemplateValue(issue, skills, params.workflow.config.pipeline), attempt: params.attempt, role: name, agents: agentsValue, ...resultVariables }));
      } else {
        prompt = await renderPrompt(params.workflow.continuationPrompt, {
          issue: issueTemplateValue(issue, skills, params.workflow.config.pipeline),
          attempt: params.attempt,
          role: name,
          agents: agentsValue,
          ...resultVariables,
          turn_number: turn,
          max_turns: maxTurns,
        });
        // Mandatory for a result-driven role, whatever the continuation prompt says.
        if (support !== null) prompt = `${prompt}\n\n${resultReminder(role?.onMissingResult ?? null)}`;
      }

      setPhase('StreamingTurn');
      const result = await session.runTurn(prompt);
      if (signal.aborted) return await finish(cancelled());
      if (!result.ok) return await finish({ kind: 'failed', code: result.code, message: result.message, phase, ...(result.sessionLimit ? { sessionLimit: result.sessionLimit } : {}) });
      backgroundTasks = result.backgroundTasks ?? [];

      let refreshed: Issue[];
      try {
        refreshed = await params.adapter.fetchIssuesByIds([issue.id]);
      } catch (error) {
        return await finish({ kind: 'failed', code: 'issue_state_refresh_error', message: errorMessage(error), phase });
      }
      const next = refreshed.find((candidate) => candidate.id === issue.id);
      if (next === undefined) return await finish({ kind: 'normal', turns: turn, reason: 'issue is no longer visible on the tracker' });
      issue = next;
      callbacks.issueRefreshed(issue);
      const stopReason = params.continueWith(issue);
      if (stopReason !== null) return await finish({ kind: 'normal', turns: turn, reason: stopReason });
      // The issue is still in the role's column. A result-driven run reports once: after its result it ends (the move
      // failed, or led to another column of the role, whose stage starts in a new session).
      if (support !== null && resultRecorded) {
        const reason = resultMoved ? `result recorded; "${issue.state}" starts in a new session` : `result recorded, but the issue is still in "${issue.state}"`;
        return await finish({ kind: 'normal', turns: turn, reason });
      }
      // A hand-off whose entry check timed out is a runtime limit, not a missing result: no reminder, no
      // on_missing_result; the stage runs again in a later session.
      if (support !== null && checkTimedOut) {
        return await finish({ kind: 'normal', turns: turn, reason: 'the entry check of the hand-off timed out (checks.timeout_ms)' });
      }
      // A result-driven role that has not reported by the turn limit, or after the one reminder turn (turn 2), ends
      // the run: the orchestrator decides what happens to the issue.
      const reachedMaxTurns = turn >= maxTurns;
      if (support !== null && (reachedMaxTurns || turn >= 2)) {
        const reason = reachedMaxTurns ? `reached ${maxTurnsSetting} (${maxTurns}) without a result` : 'no result after the reminder';
        return await finish({ kind: 'normal', turns: turn, reason, missingResult: true, ...(backgroundTasks.length > 0 ? { backgroundTasks } : {}) });
      }
      if (reachedMaxTurns) return await finish({ kind: 'normal', turns: turn, reason: `reached ${maxTurnsSetting} (${maxTurns})` });
    }
  } catch (error) {
    if (signal.aborted) return await finish(cancelled());
    const code = error instanceof SymphonyError ? error.code : 'worker_error';
    return await finish({ kind: 'failed', code, message: errorMessage(error), phase });
  }
}
