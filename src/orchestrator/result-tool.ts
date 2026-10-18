import type { AgentToolContext, AgentToolSpec, AllowedTransition, Issue, StatusChange, ToolResult, TrackerAdapter } from '../tracker/types.ts';
import { SerialQueue } from '../util/async.ts';
import { SymphonyError, errorMessage } from '../util/errors.ts';
import { tail, truncate } from '../util/text.ts';
import { normalizeStateName, type ServiceConfig } from '../workflow/config.ts';
import { RESULT_VERDICTS, SUMMARY_MAX, parseResult, renderResultComment, toolInputShape, type ResultMeta, type StageResult } from '../workflow/results.ts';
import type { RoleConfig } from '../workflow/roles.ts';
import type { PersistedResult, StageHistory } from './stage-history.ts';
import { resolveTransition, type StageConditions, type Transition, type TransitionProfile } from './transitions.ts';

/** Name of the tool a role with `result` hands off with, instead of `set_status`. */
export const RESULT_TOOL = 'report_result';
export const RESULT_RECORDED_NOTE = 'Result recorded — end your turn now.';

/**
 * Appended to every continuation prompt of a result-driven role (also to a custom `agent.continuation_prompt`): the
 * reminder that a stage ends with a result. `column` is the role's `on_missing_result`.
 */
export function resultReminder(column: string | null): string {
  const consequence = column !== null ? `Symphony moves the issue to "${column}" and posts a comment` : 'Symphony stops the stage and posts a comment';
  return (
    `Your stage ends with a result: call \`${RESULT_TOOL}\` now. If you cannot finish, report the verdict \`blocked\` with the reason. ` +
    `If this session ends without a reported result, ${consequence}.`
  );
}

/**
 * What the tool needs from the tracker: the issue's current column, the comment, the move (including `auto_merge`)
 * and the limit label.
 */
export type ResultToolAdapter = Pick<TrackerAdapter, 'fetchIssuesByIds'> & Required<Pick<TrackerAdapter, 'postComment' | 'setStatus' | 'addLabels' | 'removeLabels'>>;

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
  /** Called once, when the result comment is posted (the result is recorded from then on), with the result as persisted. */
  onRecorded?: (entry: PersistedResult) => void;
  /** Called once, after the recorded result moved the issue (not when the move failed). */
  onMoved?: () => void;
}

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

function fail(category: string, message: string): ToolResult {
  return { ok: false, error: { category, message } };
}

/** Room kept for the cut marker and the line break before the check output in {@link withCheckFailedNote}. */
const NOTE_SLACK = 40;
/** Smallest piece of check output worth quoting. */
const MIN_QUOTED_OUTPUT = 200;

/**
 * The result with a note that its hand-off failed an entry check and went to `on_check_failed` instead. The note comes
 * after the summary and quotes as much of the check output as the summary limit leaves room for; the summary itself is
 * cut when the note alone would not fit.
 */
function withCheckFailedNote(result: StageResult, failed: NonNullable<AllowedTransition['checkFailed']>, target: string): StageResult {
  const note =
    `**Entry check failed.** The entry check for "${failed.target}" failed, so Symphony moved the issue to "${target}" ` +
    '(`on_check_failed`) instead of the column this result leads to.';
  const summary = truncate(result.summary, Math.max(0, SUMMARY_MAX - note.length - 2));
  const room = SUMMARY_MAX - summary.length - note.length - NOTE_SLACK;
  const output = failed.output.trim();
  const quoted = output !== '' && room >= MIN_QUOTED_OUTPUT ? `\n\n${tail(output, room).replace(/^/gm, '    ')}` : '';
  return { ...result, summary: `${summary}\n\n${note}${quoted}` };
}

/** Applies a transition's labels (removing only those the issue carries); failures become warnings. */
export async function applyTransitionLabels(
  adapter: Pick<ResultToolAdapter, 'addLabels' | 'removeLabels'>,
  issue: Issue,
  labels: Transition['labels'],
  warnings: string[],
): Promise<{ added: string[]; removed: string[] }> {
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
}

type Plan = { ok: true; result: StageResult; transition: Transition } | { ok: false; failure: ToolResult };

/**
 * The `report_result` tool of one session (docs/results.md#the-report_result-tool). The agent reports a result;
 * Symphony validates it and computes the target column (`resolveTransition`). `transitionTarget` hands that column to
 * the transition guard (`guardTools`), so the move passes `may_move_to` and the entry checks like `set_status`, and a
 * failed check reaches the agent with nothing written. Only after the guard allowed the move, and a fresh read
 * confirmed the issue is still in one of the role's columns, does `execute` post the result comment (Markdown and
 * marker), move the issue (including `auto_merge`) and set the limit label.
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

  const record = async (args: Record<string, unknown>, context: AgentToolContext): Promise<ToolResult> => {
    if (recorded !== null) return recorded.ok ? ok({ ...(recorded.data as object), already_recorded: true }) : recorded;
    const planned = plan(args);
    if (!planned.ok) return planned.failure;
    // Fail closed: nothing is written unless the guard allowed exactly this move, or the `on_check_failed` fallback
    // after the computed move failed its entry check.
    const allowed = context.transition;
    const failed = allowed?.checkFailed;
    const fallback = failed !== undefined && role.readOnly ? role.onCheckFailed : null;
    const expected = fallback ?? planned.transition.target;
    if (
      allowed === undefined ||
      normalizeStateName(allowed.target) !== normalizeStateName(expected) ||
      (failed !== undefined && (fallback === null || normalizeStateName(failed.target) !== normalizeStateName(planned.transition.target)))
    ) {
      return fail('tool_error', `${RESULT_TOOL} ran without the transition guard's approval for "${expected}"; nothing was recorded`);
    }
    // The limit label belongs to the move the verdict leads to; a redirect to `on_check_failed` leaves it alone.
    const transition: Transition =
      failed === undefined
        ? planned.transition
        : {
            ...planned.transition,
            target: allowed.target,
            labels: { add: [], remove: [] },
            limitReached: false,
            reason: `${planned.transition.reason}; entry check for "${failed.target}" failed → "${allowed.target}" (on_check_failed)`,
          };
    const result = failed === undefined ? planned.result : withCheckFailedNote(planned.result, failed, allowed.target);

    // The issue may have left the role's columns while the agent worked or the check ran (a human moved it): a result
    // for a column it is no longer in would move it back. Confirmed right before anything is written.
    let issue: Issue | undefined;
    try {
      issue = (await adapter.fetchIssuesByIds([context.issue.id])).find((candidate) => candidate.id === context.issue.id);
    } catch (error) {
      return fail(
        'tracker_error',
        `Symphony could not read the issue's column before recording the result (${errorMessage(error)}), so nothing was ` +
          `recorded and the issue was not moved. Call ${RESULT_TOOL} again; if it fails again, end your turn.`,
      );
    }
    if (issue === undefined || !role.states.includes(normalizeStateName(issue.state))) {
      const where = issue === undefined ? 'is no longer visible on the tracker' : `was moved to "${issue.state}"`;
      return fail(
        'issue_moved',
        `The issue ${where} while you worked (by a human or another run), so this ${kind} result was not recorded and ` +
          'the issue was not moved. Do not report again: end your turn now.',
      );
    }

    const meta: ResultMeta = {
      role: role.name,
      run: params.runId,
      round: transition.round,
      profile: params.profile?.name ?? null,
      workflow_hash: params.meta.workflowHash,
      head_sha: await params.meta.headSha().catch(() => null),
      checks: failed?.check ?? allowed.check,
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
      url = (await adapter.postComment(issue, body)).url;
    } catch (error) {
      return fail(
        'comment_failed',
        `Posting the result comment failed (${errorMessage(error)}), so nothing was recorded and the issue was not moved. ` +
          `Call ${RESULT_TOOL} again; if it fails again, end your turn.`,
      );
    }

    // The result is recorded from here on; the move and the labels follow it, and a repeated call changes nothing.
    params.onRecorded?.({ result, meta });
    let change: StatusChange;
    try {
      change = await adapter.setStatus(issue, transition.target);
    } catch (error) {
      // The labels belong to the move, so they stay as they are. The run ends after this turn; the next dispatch
      // completes the move from the result's marker without a session (docs/usage.md#failures-of-result-driven-stages).
      recorded = fail(
        'status_failed',
        `The ${kind} result was recorded${url !== null ? ` (${url})` : ''}, but moving the issue to "${transition.target}" ` +
          `failed: ${errorMessage(error)}. Do not report again: end your turn now. The issue stays in "${issue.state}" ` +
          'for now; Symphony completes the move later without running this stage again.',
      );
      return recorded;
    }
    params.onMoved?.();
    const warnings: string[] = [];
    const labels = await applyTransitionLabels(adapter, issue, transition.labels, warnings);
    recorded = ok({
      kind,
      verdict: result.verdict,
      target: transition.target,
      status: change.status,
      previous_status: change.previous,
      round: transition.round,
      reason: transition.reason,
      checks: (failed?.check ?? allowed.check)?.result ?? null,
      ...(failed !== undefined ? { check_failed_for: failed.target } : {}),
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
    checkFailedTarget: (args) => {
      if (recorded !== null || !role.readOnly || role.onCheckFailed === null) return null;
      return plan(args).ok ? role.onCheckFailed : null;
    },
    execute: (args, context) => queue.run(() => record(args, context)),
  };
}
