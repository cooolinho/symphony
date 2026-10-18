import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { AgentToolSpec, AllowedTransition, ToolResult } from '../tracker/types.ts';
import { SerialQueue } from '../util/async.ts';
import { errorMessage } from '../util/errors.ts';
import { tail } from '../util/text.ts';
import type { HookResult } from '../workspace/hooks.ts';
import { describeFailure, type HookIssue, type Workspace, type WorkspaceManager } from '../workspace/manager.ts';
import { normalizeStateName, type ServiceConfig } from '../workflow/config.ts';
import { checkSummary } from '../workflow/results.ts';
import { roleName, type RoleConfig } from '../workflow/roles.ts';
import { isTerminalState } from './eligibility.ts';

/** Tool error categories the guard returns instead of running a status-changing tool. */
export type GuardDenial = 'transition_denied' | 'check_failed' | 'check_timeout' | 'check_error';

export type GuardDecision =
  /** `check`: the entry check that cleared the move (this call's run or a cached pass); absent when none applied. */
  | { allow: true; note: string | null; check?: CheckRecord }
  | {
      allow: false;
      category: GuardDenial;
      message: string;
      /** For `check_failed`: the check's output (cut to {@link CHECK_OUTPUT_LIMIT}) and its record. */
      failed?: { output: string; check: CheckRecord };
    };

/**
 * Decides whether the session may move its issue to `target`; `tool` (default `set_status`) is the tool the agent
 * called, named in the denial messages. Never throws.
 */
export type TransitionGuard = (target: string, tool?: string) => Promise<GuardDecision>;

/** The adapter tool that moves an issue to a column the agent names. */
const STATUS_TOOL = 'set_status';

/** Check output passed back to the agent on a failed check. */
export const CHECK_OUTPUT_LIMIT = 6_000;
export const CHECK_PASSED_NOTE = 'Checks passed — end your turn now.';
/** Upper bound for each git call that builds the cache key; on timeout the cache is skipped. */
const GIT_TIMEOUT_MS = 5000;

/** Passing check results of one claim, keyed by `<HEAD sha>:<script hash>`; see {@link cacheKey}. */
export type CheckCache = Map<string, CheckRecord>;

/** Result of one entry check, reported to the orchestrator (`last_check`, history line `checks_finished`). */
export interface CheckRecord {
  target: string;
  role: string;
  /** Workspace commit the check ran on; null outside git or when unknown. */
  sha: string | null;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  ok: boolean;
  /** `passed`, or the denial category the agent received. */
  result: 'passed' | Exclude<GuardDenial, 'transition_denied'>;
  finishedAt: Date;
}

export interface GuardParams {
  /** The run's role; null = the implicit `default` role. */
  role: RoleConfig | null;
  config: Pick<ServiceConfig, 'tracker' | 'roles' | 'checks'>;
  /** Where entry checks run; null = none at hand, so a move that needs a check is a `check_error`. */
  workspace: Workspace | null;
  /** Current issue facts for the check environment. */
  issue: () => HookIssue;
  manager: Pick<WorkspaceManager, 'runScript'>;
  /** The worker's signal: aborting it kills a running check's process group. */
  signal: AbortSignal;
  /** Passing results to reuse; omitted = no caching. Lives as long as the claim, in memory only. */
  cache?: CheckCache;
  /** Extra check variables from a workspace integration, when one is available. */
  checkEnv?: () => Promise<Record<string, string>>;
  onEvent?: (event: string, message: string, detail: Record<string, unknown>) => void;
  /** Workspace commit for check events; null when unknown. */
  headSha?: () => Promise<string | null>;
  /** Runs a check; the worker uses it to switch to the RunningChecks phase for the check's duration. */
  whileChecking?: <T>(run: () => Promise<T>) => Promise<T>;
  onCheckFinished?: (check: CheckRecord) => void;
  onDenied?: (target: string, message: string) => void;
}

/** Columns the role may move to, or null when unrestricted (no `roles`, or no `may_move_to`). */
function allowedTargets(params: GuardParams): string[] | null {
  if (params.config.roles === null || params.role === null || params.role.mayMoveTo === null) return null;
  return params.role.mayMoveTo.filter((column) => !isTerminalState(column, params.config.tracker));
}

function describeAllowed(params: GuardParams, allowed: string[] | null): string {
  if (allowed === null) {
    const terminal = params.config.tracker.terminalStates.map((s) => `"${s}"`).join(', ');
    return `any column except the terminal ones (${terminal})`;
  }
  return allowed.length === 0 ? 'none' : allowed.map((s) => `"${s}"`).join(', ');
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

/** `<HEAD sha>:<script hash>` for a clean working tree; null (never cached) when it is dirty or git fails. */
async function cacheKey(cwd: string, script: string): Promise<{ sha: string; key: string } | null> {
  try {
    const [head, status] = await Promise.all([git(cwd, ['rev-parse', 'HEAD']), git(cwd, ['status', '--porcelain'])]);
    const sha = head.trim();
    if (sha === '' || status.trim() !== '') return null;
    return { sha, key: `${sha}:${createHash('sha256').update(script).digest('hex')}` };
  } catch {
    return null;
  }
}

/** A broken check environment: `set_status` moves the issue to Blocked; other tools (`report_result`) end the turn. */
function checkError(target: string, why: string, tool: string): GuardDecision {
  const next = tool === STATUS_TOOL ? 'move the issue to Blocked' : `end your turn without calling ${tool} again`;
  return {
    allow: false,
    category: 'check_error',
    message:
      `The entry check for "${target}" could not run properly (${why}). This is not a problem with your change: ` +
      `do not change code; describe the problem in an issue comment and ${next}.`,
  };
}

/** A check that ran into `checks.timeout_ms`: a runtime limit, so the issue stays in its column instead of Blocked. */
function checkTimeout(target: string, durationMs: number, tool: string): GuardDecision {
  return {
    allow: false,
    category: 'check_timeout',
    message:
      `The entry check for "${target}" timed out after ${Math.round(durationMs / 1000)}s (checks.timeout_ms), so the issue ` +
      'was not moved. This is a runtime limit, not a problem with your change: do not change code and do not move the ' +
      `issue to Blocked. Call ${tool} again once; if it times out again, post a short issue comment and end your turn ` +
      'without changing the status. Symphony picks the issue up again later.',
  };
}

function checkOutput(result: HookResult): string {
  return tail(result.output.trim(), CHECK_OUTPUT_LIMIT);
}

function decide(target: string, result: HookResult, tool: string): GuardDecision {
  if (result.ok && result.exitCode === 0) return { allow: true, note: CHECK_PASSED_NOTE };
  if (result.timedOut) return checkTimeout(target, result.durationMs, tool);
  if (!result.timedOut && result.error === null && result.signal === null && result.exitCode === 1) {
    const output = checkOutput(result);
    return {
      allow: false,
      category: 'check_failed',
      message:
        `The entry check for "${target}" failed, so the issue was not moved.\n\n${output === '' ? '(no output)' : output}\n\n` +
        `Fix the problems and call ${tool} again.`,
    };
  }
  return checkError(target, describeFailure({ ...result, output: '' }), tool);
}

/** The `checks.on_enter` script a move of `role` to `target` runs; null when none does (no script, or `run_checks: false`). */
export function entryCheckFor(target: string, role: RoleConfig | null, config: Pick<ServiceConfig, 'checks'>): string | null {
  if (role?.runChecks === false) return null;
  return config.checks.onEnter.get(normalizeStateName(target)) ?? null;
}

/**
 * The transition guard for one session (docs/configuration.md#checks): denies terminal targets and targets outside
 * the role's `may_move_to`, then runs the target's `checks.on_enter` script. Runs one decision at a time.
 */
export function createGuard(params: GuardParams): TransitionGuard {
  const queue = new SerialQueue();
  const emit = params.onEvent ?? (() => undefined);
  const role = roleName(params.role);

  const evaluate = async (target: string, tool: string): Promise<GuardDecision> => {
    const allowed = allowedTargets(params);
    const key = normalizeStateName(target);
    const terminal = isTerminalState(target, params.config.tracker);
    if (terminal || (allowed !== null && !allowed.some((column) => normalizeStateName(column) === key))) {
      const why = terminal ? `"${target}" is a terminal column; only a human moves issues there` : `role ${role} may not move issues to "${target}"`;
      const message = `${why}. Allowed targets: ${describeAllowed(params, allowed)}.`;
      emit('transition_denied', `${tool} to ${target} denied`, { target, role });
      params.onDenied?.(target, message);
      return { allow: false, category: 'transition_denied', message };
    }

    const script = params.config.checks.onEnter.get(key);
    if (script === undefined) return { allow: true, note: null };
    if (params.role?.runChecks === false) {
      emit('checks_skipped', `entry check for ${target} skipped (roles.${role}.run_checks is false)`, { target, role });
      return { allow: true, note: null };
    }

    const workspace = params.workspace;
    if (workspace === null) return checkError(target, 'there is no workspace to run it in', tool);

    const cached = params.cache !== undefined ? await cacheKey(workspace.path, script) : null;
    const reused = cached !== null ? params.cache?.get(cached.key) : undefined;
    if (cached !== null && reused !== undefined) {
      emit('checks_cached', `entry check for ${target} reused (${cached.sha})`, { target, role, sha: cached.sha });
      return { allow: true, note: `cached result for ${cached.sha}`, check: reused };
    }

    const whileChecking = params.whileChecking ?? ((run) => run());
    return whileChecking(async () => {
      const sha = cached?.sha ?? (params.headSha !== undefined ? await params.headSha() : null);
      emit('checks_started', `entry check for ${target} started`, { target, role, sha });
      const extra = params.checkEnv !== undefined ? await params.checkEnv() : {};
      const result = await params.manager.runScript(`check:${target}`, script, workspace, params.issue(), {
        signal: params.signal,
        timeoutMs: params.config.checks.timeoutMs,
        env: { ...extra, SYMPHONY_ROLE: role, SYMPHONY_TARGET_STATE: target },
      });
      const decision = decide(target, result, tool);
      const check: CheckRecord = {
        target,
        role,
        sha,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        ok: decision.allow,
        result: decision.allow ? 'passed' : (decision.category as CheckRecord['result']),
        finishedAt: new Date(),
      };
      emit('checks_finished', `entry check for ${target} ${check.result}`, {
        target,
        role,
        sha,
        ok: check.ok,
        exit_code: check.exitCode,
        timed_out: check.timedOut,
        duration_ms: check.durationMs,
      });
      params.onCheckFinished?.(check);
      if (!decision.allow) return decision.category === 'check_failed' ? { ...decision, failed: { output: checkOutput(result), check } } : decision;
      if (cached !== null) params.cache?.set(cached.key, check);
      return { ...decision, check };
    });
  };

  return (target, tool = STATUS_TOOL) =>
    queue.run(async () => {
      try {
        return await evaluate(target, tool);
      } catch (error) {
        return checkError(target, errorMessage(error), tool);
      }
    });
}

/**
 * The tools `role` may use: tools that create sub-issues only for a role with `max_sub_issues`. A role with `result`
 * hands off through `resultTool` (`report_result`, see `createResultTool`) instead of the adapter's tools that move
 * the issue to a column the agent names (`set_status`); it never gets those, with or without `resultTool`.
 */
export function toolsForRole(specs: AgentToolSpec[], role: RoleConfig | null, resultTool: AgentToolSpec | null = null): AgentToolSpec[] {
  const subIssues = role?.maxSubIssues != null;
  const reportsResult = role?.result != null;
  const allowed = specs.filter((spec) => (subIssues || spec.createsSubIssues !== true) && !(reportsResult && spec.transitionTarget !== undefined));
  return reportsResult && resultTool !== null ? [...allowed, resultTool] : allowed;
}

/** Adds the guard's note to a tool's data; a note of the tool's own (`report_result`) wins. */
function withNote(data: unknown, note: string): unknown {
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) return 'note' in data ? data : { ...data, note };
  return { result: data, note };
}

/**
 * Wraps every spec with `transitionTarget` so a denied transition never reaches the tracker. A call the tool's `precheck`
 * refuses stops before the guard (no entry check runs). An allowed call gets the move in `context.transition`; a call
 * without a target never does, so a tool can rely on it as proof of the guard.
 */
export function guardTools(specs: AgentToolSpec[], guard: TransitionGuard): AgentToolSpec[] {
  return specs.map((spec) => {
    const transitionTarget = spec.transitionTarget;
    if (transitionTarget === undefined) return spec;
    return {
      ...spec,
      execute: async (args, { transition: _unchecked, ...context }): Promise<ToolResult> => {
        const target = await transitionTarget(args);
        if (target === null) return spec.execute(args, context);
        const refused = await spec.precheck?.(args, context);
        if (refused !== undefined && refused !== null) return refused;
        let decision = await guard(target, spec.name);
        let moved = target;
        let checkFailed: AllowedTransition['checkFailed'];
        if (!decision.allow && decision.failed !== undefined) {
          // The entry check failed for a tool that has another column for this case (`on_check_failed`): the same
          // guard decides about that column, so `may_move_to` and its own entry check still apply.
          const fallback = spec.checkFailedTarget?.(args) ?? null;
          if (fallback !== null && normalizeStateName(fallback) !== normalizeStateName(target)) {
            const failed = decision.failed;
            decision = await guard(fallback, spec.name);
            moved = fallback;
            checkFailed = { target, output: failed.output, check: checkSummary(failed.check) };
          }
        }
        if (!decision.allow) return { ok: false, error: { category: decision.category, message: decision.message } };
        const check = decision.check !== undefined ? checkSummary(decision.check) : null;
        const result = await spec.execute(args, { ...context, transition: { target: moved, check, ...(checkFailed !== undefined ? { checkFailed } : {}) } });
        return result.ok && decision.note !== null ? { ok: true, data: withNote(result.data, decision.note) } : result;
      },
    };
  });
}
