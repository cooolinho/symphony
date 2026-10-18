import type { AgentToolContext, AgentToolSpec, Issue, StatusChange, ToolResult, TrackerAdapter } from '../tracker/types.ts';
import { SerialQueue } from '../util/async.ts';
import { SymphonyError, errorMessage } from '../util/errors.ts';
import { normalizeStateName, type ServiceConfig } from '../workflow/config.ts';
import { RESULT_VERDICTS, parseResult, renderResultComment, toolInputShape, type ResultMeta, type StageResult } from '../workflow/results.ts';
import type { RoleConfig } from '../workflow/roles.ts';
import type { StageHistory } from './stage-history.ts';
import { resolveTransition, type StageConditions, type Transition, type TransitionProfile } from './transitions.ts';

/** Name of the tool a role with `result` hands off with, instead of `set_status`. */
export const RESULT_TOOL = 'report_result';
export const RESULT_RECORDED_NOTE = 'Result recorded — end your turn now.';

/** What the tool needs from the tracker: the comment, the move (including `auto_merge`) and the limit label. */
export type ResultToolAdapter = Required<Pick<TrackerAdapter, 'postComment' | 'setStatus' | 'addLabels' | 'removeLabels'>>;

/** Facts for the result's meta that come from the session; read when the result is recorded. */
export interface ResultMetaSource {
  /** Hash of the workflow the session runs with; null when unknown. */
  workflowHash: string | null;
  /** Workspace commit; null outside git or when unknown. */
  headSha: () => Promise<string | null>;
  now?: () => Date;
}

export interface ResultToolParams {
  /** The session's role; its `result` is the kind the tool reports. */
  role: RoleConfig;
  /** Round counters of the issue's persisted results, loaded when the session starts (a run reports once). */
  history: Pick<StageHistory, 'reviewRounds' | 'testRounds'>;
  profile: TransitionProfile | null;
  flags: StageConditions;
  config: Pick<ServiceConfig, 'tracker' | 'roles' | 'pipeline'>;
  /** The board's columns in board order; null when the tracker does not list them. */
  boardColumns: readonly string[] | null;
  adapter: ResultToolAdapter;
  /** The session's current issue; routing reads its description (the roles of later columns may depend on a command). */
  issue: () => Issue;
  /** The run recorded in the meta; null when unknown. */
  runId: string | null;
  meta: ResultMetaSource;
}

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

function fail(category: string, message: string): ToolResult {
  return { ok: false, error: { category, message } };
}

type Plan = { ok: true; result: StageResult; transition: Transition } | { ok: false; failure: ToolResult };

/**
 * The `report_result` tool of one session (docs/results.md#the-report_result-tool). The agent reports a result;
 * Symphony validates it and computes the target column (`resolveTransition`). `transitionTarget` hands that column to
 * the transition guard (`guardTools`), so the move passes `may_move_to` and the entry checks like `set_status`, and a
 * failed check reaches the agent with nothing written. Only after the guard allowed the move does `execute` post the
 * result comment (Markdown and marker), move the issue (including `auto_merge`) and set the limit label.
 *
 * A run reports once: after the comment is posted, every further call returns the stored outcome without touching
 * the tracker. Calls run one at a time.
 */
export function createResultTool(params: ResultToolParams): AgentToolSpec {
  const { role, adapter } = params;
  const kind = role.result;
  if (kind === null) throw new Error(`role ${role.name} reports no result (roles.${role.name}.result is not set)`);
  const queue = new SerialQueue();
  const now = params.meta.now ?? (() => new Date());
  /** The outcome of the call that posted the result comment; null until one did. */
  let recorded: ToolResult | null = null;

  const plan = (args: Record<string, unknown>): Plan => {
    const parsed = parseResult(kind, args);
    if (!parsed.ok) return { ok: false, failure: fail('invalid_result', parsed.message) };
    const transition = resolveTransition({
      role,
      verdict: parsed.result.verdict,
      history: params.history,
      profile: params.profile,
      flags: params.flags,
      config: params.config,
      boardColumns: params.boardColumns,
      issue: params.issue(),
    });
    if (!transition.ok) {
      return {
        ok: false,
        failure: fail(
          'transition_error',
          `Symphony cannot route this ${kind} result: ${transition.problem}. This is a configuration problem, not a problem ` +
            'with your result: nothing was recorded. Describe it in an issue comment and end your turn.',
        ),
      };
    }
    return { ok: true, result: parsed.result, transition };
  };

  /** Applies the transition's labels (removing only those the issue carries); failures become warnings. */
  const applyLabels = async (issue: Issue, labels: Transition['labels'], warnings: string[]): Promise<{ added: string[]; removed: string[] }> => {
    const changed = { added: [] as string[], removed: [] as string[] };
    const carried = new Set(issue.labels.map((name) => name.toLowerCase()));
    const remove = labels.remove.filter((name) => carried.has(name.toLowerCase()));
    if (labels.add.length > 0) {
      try {
        const result = await adapter.addLabels(issue, labels.add, { create: true });
        changed.added = result.added;
        if (result.unknown.length > 0) warnings.push(`label(s) ${result.unknown.map((name) => `"${name}"`).join(', ')} do not exist and were not added`);
      } catch (error) {
        warnings.push(`could not add label(s) ${labels.add.join(', ')}: ${errorMessage(error)}`);
      }
    }
    if (remove.length > 0) {
      try {
        changed.removed = (await adapter.removeLabels(issue, remove)).removed;
      } catch (error) {
        warnings.push(`could not remove label(s) ${remove.join(', ')}: ${errorMessage(error)}`);
      }
    }
    return changed;
  };

  const record = async (args: Record<string, unknown>, context: AgentToolContext): Promise<ToolResult> => {
    if (recorded !== null) return recorded.ok ? ok({ ...(recorded.data as object), already_recorded: true }) : recorded;
    const planned = plan(args);
    if (!planned.ok) return planned.failure;
    const { result, transition } = planned;
    // Fail closed: nothing is written unless the guard allowed exactly this move.
    const allowed = context.transition;
    if (allowed === undefined || normalizeStateName(allowed.target) !== normalizeStateName(transition.target)) {
      return fail('tool_error', `${RESULT_TOOL} ran without the transition guard's approval for "${transition.target}"; nothing was recorded`);
    }

    const meta: ResultMeta = {
      role: role.name,
      run: params.runId,
      round: transition.round,
      profile: params.profile?.name ?? null,
      workflow_hash: params.meta.workflowHash,
      head_sha: await params.meta.headSha().catch(() => null),
      checks: allowed.check,
      target: transition.target,
      created_at: now().toISOString(),
    };
    let body: string;
    try {
      body = renderResultComment(result, meta);
    } catch (error) {
      if (error instanceof SymphonyError && error.code === 'result_too_large') return fail('invalid_result', `${error.message}, then report again`);
      throw error;
    }

    let url: string | null;
    try {
      url = (await adapter.postComment(context.issue, body)).url;
    } catch (error) {
      return fail(
        'comment_failed',
        `Posting the result comment failed (${errorMessage(error)}), so nothing was recorded and the issue was not moved. ` +
          `Call ${RESULT_TOOL} again; if it fails again, end your turn.`,
      );
    }

    // The result is recorded from here on; the move and the labels follow it, and a repeated call changes nothing.
    let change: StatusChange | null = null;
    let statusError: string | null = null;
    try {
      change = await adapter.setStatus(context.issue, transition.target);
    } catch (error) {
      statusError = errorMessage(error);
    }
    const warnings: string[] = [];
    const labels = await applyLabels(context.issue, transition.labels, warnings);

    if (change === null) {
      recorded = fail(
        'status_failed',
        `The ${kind} result was recorded${url !== null ? ` (${url})` : ''}, but moving the issue to "${transition.target}" ` +
          `failed: ${statusError}. Do not report again: end your turn now. Symphony moves the issue on its next run.` +
          (warnings.length > 0 ? ` Also: ${warnings.join('; ')}.` : ''),
      );
      return recorded;
    }
    recorded = ok({
      kind,
      verdict: result.verdict,
      target: transition.target,
      status: change.status,
      previous_status: change.previous,
      round: transition.round,
      reason: transition.reason,
      checks: allowed.check?.result ?? null,
      comment_url: url,
      ...(labels.added.length > 0 || labels.removed.length > 0 ? { labels } : {}),
      ...(change.autoMerge !== undefined ? { auto_merge: change.autoMerge } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      note: RESULT_RECORDED_NOTE,
    });
    return recorded;
  };

  return {
    name: RESULT_TOOL,
    description:
      `Report the result of your stage (a ${kind} result; verdict one of ${RESULT_VERDICTS[kind].join(', ')}) and hand the ` +
      'issue on. Symphony checks the result, computes the next column from the verdict and runs that column\'s entry ' +
      'checks; when they pass, it posts the result as an issue comment and moves the issue. Report once, when the stage ' +
      'is complete, then end your turn. If the result is invalid or a check fails, nothing is recorded and the issue ' +
      'stays: do what the error message says and report again.',
    inputSchema: toolInputShape(kind),
    mutates: true,
    transitionTarget: (args) => {
      if (recorded !== null) return null;
      const planned = plan(args);
      return planned.ok ? planned.transition.target : null;
    },
    execute: (args, context) => queue.run(() => record(args, context)),
  };
}
