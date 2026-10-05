import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sessionClaudeConfig } from '../agent/model.ts';
import type { AgentEvent, AgentRunner, AgentSession } from '../agent/types.ts';
import { prepareLaravelBoost } from '../laravel/boost.ts';
import type { Logger } from '../log.ts';
import type { Issue, TrackerAdapter } from '../tracker/types.ts';
import { SymphonyError, errorMessage } from '../util/errors.ts';
import { describeHolder, type LockResult } from '../workspace/lock.ts';
import { describeFailure, type HookIssue, type Workspace, type WorkspaceManager } from '../workspace/manager.ts';
import type { EffectiveWorkflow } from '../workflow/store.ts';
import { issueTemplateValue, renderPrompt } from '../workflow/template.ts';

export type RunPhase =
  | 'PreparingWorkspace'
  | 'BuildingPrompt'
  | 'LaunchingAgentProcess'
  | 'InitializingSession'
  | 'StreamingTurn'
  | 'Finishing'
  | 'Succeeded'
  | 'Failed'
  | 'TimedOut'
  | 'Stalled'
  | 'CanceledByReconciliation';

export type WorkerOutcome =
  | { kind: 'normal'; turns: number; reason: string }
  | { kind: 'failed'; code: string; message: string; phase: RunPhase }
  | { kind: 'cancelled'; message: string };

/** Final commit and branch of a git workspace. */
export interface GitHead {
  headSha: string;
  branch: string;
}

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
  /** Final commit and branch of the workspace, reported once while the attempt finishes. */
  gitHead(head: GitHead): void;
}

export interface WorkerParams {
  issue: Issue;
  attempt: number | null;
  /** Workflow snapshot for this attempt: prompt, max_turns and agent settings stay fixed for the session. */
  workflow: EffectiveWorkflow;
  /** Model for the session: from a "Model: <model>" label, else claude.model; null = Claude Code default. */
  model: string | null;
  /** Adapter snapshot: the tools advertised to the session and the ones executed are the same. */
  adapter: TrackerAdapter;
  runner: AgentRunner;
  workspaces: WorkspaceManager;
  /** Environment for the agent process (tracker secrets already removed). */
  childEnv: NodeJS.ProcessEnv;
  logger: Logger;
  signal: AbortSignal;
  /** Directory for per-session JSONL transcripts, or null to disable them. */
  transcriptDir: string | null;
  /** Live eligibility check (uses the current workflow config). */
  stillEligible: (issue: Issue) => boolean;
  callbacks: WorkerCallbacks;
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
  const maxTurns = params.workflow.config.agent.maxTurns;
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

    // Laravel Boost for detected Laravel apps; problems only log warnings.
    const extensions = await prepareLaravelBoost({
      workspacePath: workspace.path,
      config: params.workflow.config.laravel,
      env: params.childEnv,
      logger,
      signal,
    });
    if (signal.aborted) return await finish(cancelled());

    setPhase('LaunchingAgentProcess');
    const activeWorkspace = workspace;
    session = await params.runner.startSession({
      cwd: activeWorkspace.path,
      issue,
      config: sessionClaudeConfig(params.workflow.config.claude, params.model),
      tools: params.adapter.agentToolSpecs(),
      toolContext: () => ({ issue }),
      env: params.childEnv,
      logger,
      signal,
      onEvent: callbacks.agentEvent,
      transcriptPath: transcriptPath(params.transcriptDir, activeWorkspace),
      ...(extensions !== null ? { extensions } : {}),
    });

    for (let turn = 1; ; turn++) {
      setPhase('BuildingPrompt');
      const prompt =
        turn === 1
          ? await renderPrompt(params.workflow.prompt, { issue: issueTemplateValue(issue), attempt: params.attempt })
          : await renderPrompt(params.workflow.continuationPrompt, {
              issue: issueTemplateValue(issue),
              attempt: params.attempt,
              turn_number: turn,
              max_turns: maxTurns,
            });

      setPhase('StreamingTurn');
      const result = await session.runTurn(prompt);
      if (signal.aborted) return await finish(cancelled());
      if (!result.ok) return await finish({ kind: 'failed', code: result.code, message: result.message, phase });

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
      if (!params.stillEligible(issue)) {
        return await finish({ kind: 'normal', turns: turn, reason: `issue left the active states ("${issue.state}")` });
      }
      if (turn >= maxTurns) return await finish({ kind: 'normal', turns: turn, reason: `reached agent.max_turns (${maxTurns})` });
    }
  } catch (error) {
    if (signal.aborted) return await finish(cancelled());
    const code = error instanceof SymphonyError ? error.code : 'worker_error';
    return await finish({ kind: 'failed', code, message: errorMessage(error), phase });
  }
}
