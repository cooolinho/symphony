import type { Issue } from '../tracker/types.ts';
import { classify } from '../workflow/classify.ts';
import { SPLIT_COMPLEXITY } from '../workflow/results.ts';
import type { RoleConfig } from '../workflow/roles.ts';
import type { StageHistory } from './stage-history.ts';

/**
 * Work packages (docs/results.md#work-packages): an architect splits an issue of complexity XL into sub-issues, one per
 * package, and the issue waits for them before its integration review.
 */

/** The issue's sub-issues as the tracker lists them in `native_ref.sub_issues` (open and closed); 0 when it lists none. */
export function subIssueCount(issue: Pick<Issue, 'native_ref'>): number {
  const subIssues = issue.native_ref?.sub_issues;
  return Array.isArray(subIssues) ? subIssues.length : 0;
}

/** Whether the issue is itself a sub-issue: the tracker names a parent in `native_ref.parent`. */
export function isSubIssue(issue: Pick<Issue, 'native_ref'>): boolean {
  const parent = issue.native_ref?.parent;
  return typeof parent === 'object' && parent !== null;
}

/** Whether the issue may be split into work packages: complexity XL, and not a sub-issue (a work package is never split again). */
export function isSplittable(issue: Pick<Issue, 'labels' | 'native_ref'>): boolean {
  return classify(issue.labels).complexity === SPLIT_COMPLEXITY && !isSubIssue(issue);
}

/**
 * How many open sub-issues a session of `role` may have under `issue` at once: the role's `max_sub_issues`, null = it
 * creates none and does not get `create_sub_issue`. A role that reports a design files sub-issues only to split the issue
 * into work packages, so it creates none for an issue that is not {@link isSplittable}: an issue below XL or a work
 * package, whose architect would otherwise split it again with sub-issues of its own.
 */
export function subIssueLimit(role: Pick<RoleConfig, 'maxSubIssues' | 'result'> | null, issue: Pick<Issue, 'labels' | 'native_ref'>): number | null {
  const max = role?.maxSubIssues ?? null;
  if (max === null) return null;
  return role?.result === 'design' && !isSplittable(issue) ? null : max;
}

/**
 * Whether a review of the issue is an integration review: the issue has sub-issues (the work packages of a `split`
 * design) and no implementation of its own, whatever its verdict and across resets (`implementation` of
 * `resultsTemplateValue`). The reviewer and the security auditor of WORKFLOW.md switch to their integration mode by the
 * same rule (`integration`).
 */
export function isIntegrationReview(issue: Pick<Issue, 'native_ref'>, history: Pick<StageHistory, 'results'>): boolean {
  return subIssueCount(issue) > 0 && !history.results.some(({ result }) => result.kind === 'implementation');
}
