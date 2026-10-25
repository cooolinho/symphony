import type { Issue, TrackedResult } from '../tracker/types.ts';
import { classify } from '../workflow/classify.ts';
import { normalizeStateName, type ServiceConfig } from '../workflow/config.ts';
import { profileFor } from '../workflow/profile.ts';
import type { RoleConfig } from '../workflow/roles.ts';
import { buildStageHistory } from './stage-history.ts';
import { checkFailedRoute, resolveTransition, type Transition } from './transitions.ts';

/**
 * A hand-off whose result comment was posted but whose move did not happen (Symphony crashed in between, or the move
 * failed): the issue is still in the column the result was reported from.
 */
export interface InterruptedTransition {
  /** The newest result of the issue, the one that names the move. */
  result: TrackedResult;
  /** Column the result hands the issue to (its `meta.target`). */
  target: string;
  /** `native_ref.status_updated_at` the decision was made with; a move later changes it. */
  statusUpdatedAt: string;
}

/** When the issue's column last changed (`native_ref.status_updated_at`); null when the tracker does not say. */
export function statusUpdatedAt(issue: Pick<Issue, 'native_ref'>): Date | null {
  const value = issue.native_ref?.status_updated_at;
  if (typeof value !== 'string') return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

const seconds = (at: Date) => Math.floor(at.getTime() / 1000);

/**
 * The transition Symphony recorded but did not complete, or null. All of these must hold:
 *
 * - the newest result (by the comment's `createdAt`) comes from `role`, the role of the issue's column;
 * - it names a `target` other than the issue's column;
 * - the column has not changed since: the Status field's `updatedAt` lies in an earlier second than the comment.
 *
 * Both timestamps come from the tracker and have second precision; a move in the same second as the comment counts as a
 * move after it, so a doubt never leads to a recovery. Without `status_updated_at` there is none: a human's move and a
 * failed one would look the same. Who moved the issue is no help either, since Symphony's own moves carry the token
 * owner's name like a human's.
 */
export function interruptedTransition(
  issue: Pick<Issue, 'state' | 'native_ref'>,
  role: Pick<RoleConfig, 'name'> | null,
  tracked: readonly TrackedResult[],
): InterruptedTransition | null {
  const updated = statusUpdatedAt(issue);
  if (role === null || updated === null) return null;
  let newest: TrackedResult | undefined;
  for (const candidate of tracked) if (newest === undefined || candidate.createdAt.getTime() >= newest.createdAt.getTime()) newest = candidate;
  if (newest === undefined) return null;
  const { target, role: reporter } = newest.meta;
  if (reporter !== role.name || target === null || normalizeStateName(target) === normalizeStateName(issue.state)) return null;
  if (seconds(updated) >= seconds(newest.createdAt)) return null;
  return { result: newest, target, statusUpdatedAt: updated.toISOString() };
}

const NO_LABELS: Transition['labels'] = { add: [], remove: [] };

/**
 * The labels that belong to the interrupted move (the round limit label), routed again from the results before it. A
 * route that does not lead to the recorded target (a reload changed it, the move was an `on_check_failed` fallback, a
 * skipped stage) changes no labels, like a fallback in `report_result`.
 */
export function interruptedLabels(
  interrupted: InterruptedTransition,
  tracked: readonly TrackedResult[],
  role: RoleConfig,
  config: Pick<ServiceConfig, 'tracker' | 'roles' | 'pipeline'>,
  boardColumns: readonly string[] | null,
  issue: Pick<Issue, 'labels' | 'description'>,
): Transition['labels'] {
  const { result, meta } = interrupted.result;
  // Every copy of the interrupted result (a run's repeated comment) leaves the history, so its round is counted once.
  const same = (entry: TrackedResult) => entry === interrupted.result || (meta.run !== null && entry.meta.run === meta.run && entry.meta.role === meta.role && entry.result.kind === result.kind);
  const before = tracked.filter((entry) => !same(entry)).map((entry) => ({ result: entry.result, meta: entry.meta }));
  if (role.result !== result.kind) return NO_LABELS;
  const history = buildStageHistory(before);
  if (meta.check_failed_for) {
    // An `on_check_failed` hand-off: the target is the fallback route; only the one reaching the limit carries a label.
    const route = checkFailedRoute({ role, history, config });
    if (route === null || normalizeStateName(route.column) !== normalizeStateName(interrupted.target)) return NO_LABELS;
    return route.limitReached ? { add: [config.pipeline.limitLabel], remove: [] } : NO_LABELS;
  }
  const transition = resolveTransition({
    role,
    verdict: result.verdict,
    history,
    profile: profileFor(config.pipeline, classify(issue.labels).type),
    config,
    boardColumns,
    issue,
  });
  return transition.ok && normalizeStateName(transition.target) === normalizeStateName(interrupted.target) ? transition.labels : NO_LABELS;
}
