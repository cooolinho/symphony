import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import { sessionClaudeConfig } from '../agent/model.ts';
import type { AgentEvent, AgentRunner, AgentSession, IntegrationReport, SessionLimitInfo } from '../agent/types.ts';
import { prepareIntegrations } from '../integrations/registry.ts';
import type { WorkspaceIntegration } from '../integrations/types.ts';
import type { Logger } from '../log.ts';
import type { Issue, TrackerAdapter } from '../tracker/types.ts';
import { SymphonyError, errorMessage } from '../util/errors.ts';
import { describeHolder, type LockResult } from '../workspace/lock.ts';
import { describeFailure, type HookIssue, type Workspace, type WorkspaceManager } from '../workspace/manager.ts';
import { commandSkills } from '../workflow/command.ts';
import { roleName, type RoleConfig } from '../workflow/roles.ts';
import type { EffectiveWorkflow } from '../workflow/store.ts';
import { issueTemplateValue, renderPrompt } from '../workflow/template.ts';
import { createGuard, guardTools, toolsForRole, type CheckCache, type CheckRecord } from './guard.ts';

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
  | { kind: 'normal'; turns: number; reason: string }
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
  /** Result of an entry check run by the transition guard. */
  checkFinished(check: CheckRecord): void;
  /** The guard refused a move (terminal column or outside the role's `may_move_to`). */
  transitionDenied(target: string, message: string): void;
  /** JSONL transcript of this attempt's agent session, reported before the session starts. */
  transcript(path: string): void;
}

export interface WorkerParams {
  issue: Issue;
  attempt: number | null;
  /** Workflow snapshot for this attempt: prompt, max_turns and agent settings stay fixed for the session. */
  workflow: EffectiveWorkflow;
  /** Model for the session: a "Model: <model>" label, else roles.<role>.claude.model, else claude.model; null = Claude Code default. */
  model: string | null;
  /** Effort for the session: an "Effort: <level>" label, else roles.<role>.claude.effort, else claude.effort; null = Claude Code default. */
  effort: EffortLevel | null;
  /** Role serving the issue's column at dispatch; null = the implicit `default` role. Fixed for the run. */
  role: RoleConfig | null;
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

function transcriptPath(dir: string | null, workspace: Workspace): string | null {
  if (dir === null) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, workspace.key, `${stamp}.jsonl`);
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
    }
    if (lock !== null) {
      await lock.release().catch((error: unknown) => logger.warn('workspace lock could not be released', { error: errorMessage(error) }));
      lock = null;
    }
    return outcome;
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

    setPhase('LaunchingAgentProcess');
    const activeWorkspace = workspace;
    // Guard events carry the session fields of the latest agent event, so they do not reset the running entry.
    let lastEvent: AgentEvent | null = null;
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
      onCheckFinished: (check) => callbacks.checkFinished(check),
      onDenied: (target, message) => callbacks.transitionDenied(target, message),
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
    const transcript = transcriptPath(params.transcriptDir, activeWorkspace);
    if (transcript !== null) callbacks.transcript(transcript);
    session = await params.runner.startSession({
      cwd: activeWorkspace.path,
      issue,
      config: sessionClaudeConfig(params.workflow.config.claude, params.model, params.effort, role?.claude),
      policy: { readOnly: role?.readOnly ?? false },
      // Entry checks run inside the status tool call; leave a minute for the tracker call around them.
      toolTimeoutMs: params.workflow.config.checks.timeoutMs + TOOL_TIMEOUT_MARGIN_MS,
      tools: guardTools(toolsForRole(params.adapter.agentToolSpecs(), role), guard),
      toolContext: () => ({
        issue,
        ...(role?.maxSubIssues != null ? { maxSubIssues: role.maxSubIssues } : {}),
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
    for (let turn = 1; ; turn++) {
      setPhase('BuildingPrompt');
      const prompt =
        turn === 1
          ? withMcpNotes(unavailableMcp, await renderPrompt(params.workflow.prompt, { issue: issueTemplateValue(issue, skills), attempt: params.attempt, role: name }))
          : await renderPrompt(params.workflow.continuationPrompt, {
              issue: issueTemplateValue(issue, skills),
              attempt: params.attempt,
              role: name,
              turn_number: turn,
              max_turns: maxTurns,
            });

      setPhase('StreamingTurn');
      const result = await session.runTurn(prompt);
      if (signal.aborted) return await finish(cancelled());
      if (!result.ok) return await finish({ kind: 'failed', code: result.code, message: result.message, phase, ...(result.sessionLimit ? { sessionLimit: result.sessionLimit } : {}) });

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
      if (turn >= maxTurns) return await finish({ kind: 'normal', turns: turn, reason: `reached ${maxTurnsSetting} (${maxTurns})` });
    }
  } catch (error) {
    if (signal.aborted) return await finish(cancelled());
    const code = error instanceof SymphonyError ? error.code : 'worker_error';
    return await finish({ kind: 'failed', code, message: errorMessage(error), phase });
  }
}
