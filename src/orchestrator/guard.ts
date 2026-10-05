import type { AgentToolSpec, ToolResult } from '../tracker/types.ts';
import { SerialQueue } from '../util/async.ts';
import { errorMessage } from '../util/errors.ts';
import { tail } from '../util/text.ts';
import type { HookResult } from '../workspace/hooks.ts';
import { describeFailure, type HookIssue, type Workspace, type WorkspaceManager } from '../workspace/manager.ts';
import { normalizeStateName, type ServiceConfig } from '../workflow/config.ts';
import { roleName, type RoleConfig } from '../workflow/roles.ts';
import { isTerminalState } from './eligibility.ts';

/** Tool error categories the guard returns instead of running a status-changing tool. */
export type GuardDenial = 'transition_denied' | 'check_failed' | 'check_error';

export type GuardDecision =
  | { allow: true; note: string | null }
  | { allow: false; category: GuardDenial; message: string };

/** Decides whether the session may move its issue to `target`. Never throws. */
export type TransitionGuard = (target: string) => Promise<GuardDecision>;

/** Check output passed back to the agent on a failed check. */
export const CHECK_OUTPUT_LIMIT = 6_000;
export const CHECK_PASSED_NOTE = 'Checks passed — end your turn now.';

export interface GuardParams {
  /** The run's role; null = the implicit `default` role. */
  role: RoleConfig | null;
  config: Pick<ServiceConfig, 'tracker' | 'roles' | 'checks'>;
  workspace: Workspace;
  /** Current issue facts for the check environment. */
  issue: () => HookIssue;
  manager: Pick<WorkspaceManager, 'runScript'>;
  /** The worker's signal: aborting it kills a running check's process group. */
  signal: AbortSignal;
  /** Extra check variables from a workspace integration, when one is available. */
  checkEnv?: () => Promise<Record<string, string>>;
  onEvent?: (event: string, message: string, detail: Record<string, unknown>) => void;
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

function checkError(target: string, why: string): GuardDecision {
  return {
    allow: false,
    category: 'check_error',
    message:
      `The entry check for "${target}" could not run properly (${why}). This is not a problem with your change: ` +
      'do not change code; describe the problem in an issue comment and move the issue to Blocked.',
  };
}

function decide(target: string, result: HookResult): GuardDecision {
  if (result.ok && result.exitCode === 0) return { allow: true, note: CHECK_PASSED_NOTE };
  if (!result.timedOut && result.error === null && result.signal === null && result.exitCode === 1) {
    const output = tail(result.output.trim(), CHECK_OUTPUT_LIMIT);
    return {
      allow: false,
      category: 'check_failed',
      message:
        `The entry check for "${target}" failed, so the issue was not moved.\n\n${output === '' ? '(no output)' : output}\n\n` +
        'Fix the problems and call set_status again.',
    };
  }
  return checkError(target, describeFailure({ ...result, output: '' }));
}

/**
 * The transition guard for one session (docs/configuration.md#checks): denies terminal targets and targets outside
 * the role's `may_move_to`, then runs the target's `checks.on_enter` script. Runs one decision at a time.
 */
export function createGuard(params: GuardParams): TransitionGuard {
  const queue = new SerialQueue();
  const emit = params.onEvent ?? (() => undefined);
  const role = roleName(params.role);

  const evaluate = async (target: string): Promise<GuardDecision> => {
    const allowed = allowedTargets(params);
    const key = normalizeStateName(target);
    const terminal = isTerminalState(target, params.config.tracker);
    if (terminal || (allowed !== null && !allowed.some((column) => normalizeStateName(column) === key))) {
      const why = terminal ? `"${target}" is a terminal column; only a human moves issues there` : `role ${role} may not move issues to "${target}"`;
      const message = `${why}. Allowed targets: ${describeAllowed(params, allowed)}.`;
      emit('transition_denied', `set_status to ${target} denied`, { target, role });
      return { allow: false, category: 'transition_denied', message };
    }

    const script = params.config.checks.onEnter.get(key);
    if (script === undefined) return { allow: true, note: null };

    emit('entry_check_started', `entry check for ${target} started`, { target, role });
    const extra = params.checkEnv !== undefined ? await params.checkEnv() : {};
    const result = await params.manager.runScript(`check:${target}`, script, params.workspace, params.issue(), {
      signal: params.signal,
      timeoutMs: params.config.checks.timeoutMs,
      env: { ...extra, SYMPHONY_ROLE: role, SYMPHONY_TARGET_STATE: target },
    });
    const decision = decide(target, result);
    emit('entry_check_finished', `entry check for ${target} ${decision.allow ? 'passed' : decision.category}`, {
      target,
      role,
      ok: decision.allow,
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      duration_ms: result.durationMs,
    });
    return decision;
  };

  return (target) =>
    queue.run(async () => {
      try {
        return await evaluate(target);
      } catch (error) {
        return checkError(target, errorMessage(error));
      }
    });
}

function withNote(data: unknown, note: string): unknown {
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) return { ...data, note };
  return { result: data, note };
}

/** Wraps every spec with `transitionTarget` so a denied transition never reaches the tracker. */
export function guardTools(specs: AgentToolSpec[], guard: TransitionGuard): AgentToolSpec[] {
  return specs.map((spec) => {
    const transitionTarget = spec.transitionTarget;
    if (transitionTarget === undefined) return spec;
    return {
      ...spec,
      execute: async (args, context): Promise<ToolResult> => {
        const target = transitionTarget(args);
        if (target === null) return spec.execute(args, context);
        const decision = await guard(target);
        if (!decision.allow) return { ok: false, error: { category: decision.category, message: decision.message } };
        const result = await spec.execute(args, context);
        return result.ok && decision.note !== null ? { ok: true, data: withNote(result.data, decision.note) } : result;
      },
    };
  });
}
