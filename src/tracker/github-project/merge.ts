import { errorMessage } from '../../util/errors.ts';
import type { Issue } from '../types.ts';
import type { GithubGraphqlClient } from './client.ts';
import { assertNoGraphqlErrors } from './client.ts';
import { CLOSE_ISSUE_MUTATION, MERGE_CANDIDATE_QUERY, MERGE_PULL_REQUEST_MUTATION } from './queries.ts';
import type { AutoMergeSettings } from './settings.ts';

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function nodes(connection: unknown): Json[] {
  const list = obj(connection)?.nodes;
  return Array.isArray(list) ? (list.map(obj).filter((n) => n !== null) as Json[]) : [];
}

function labelNames(connection: unknown): string[] {
  return nodes(obj(connection)?.labels).map((label) => String(label.name ?? '').trim().toLowerCase());
}

/** Merge errors the developer can fix by integrating the base branch. */
const CONFLICT = /conflict|not mergeable|merge commit cannot be cleanly created/i;

export interface MergeTarget {
  issueId: string;
  repository: string;
  number: number;
}

/** Board and comment operations of the calling tool, so the merge reuses its status lookup. */
export interface MergeOps {
  /** Moves the issue to a column and returns the column's name. */
  setStatus(status: string): Promise<string>;
  comment(body: string): Promise<void>;
}

export interface AutoMergeResult {
  merged: boolean;
  pull_request: number | null;
  /** Column the issue is in afterwards. */
  status: string;
  reason: string;
  warnings?: string[];
}

/**
 * Merges the issue's open pull request into the base branch after the issue entered `settings.onEnter`, closes the
 * issue and moves it to the done column. Never merges into the default branch, a draft, or anything carrying the
 * opt-out label. Without a pull request nothing happens. A conflict sends the issue to `settings.onConflict` (when set)
 * for the developer; every other refusal or failure leaves it where it is, with a comment for the human.
 */
export async function autoMerge(
  client: GithubGraphqlClient,
  settings: AutoMergeSettings,
  baseBranch: string,
  target: MergeTarget,
  issue: Pick<Issue, 'branch_name'>,
  currentStatus: string,
  ops: MergeOps,
): Promise<AutoMergeResult> {
  const head = issue.branch_name ?? `symphony/issue-${target.number}`;
  const warnings: string[] = [];
  const stay = async (reason: string, number: number | null): Promise<AutoMergeResult> => {
    try {
      await ops.comment(`Symphony did not merge automatically: ${reason}. The issue stays in "${currentStatus}" for a human.`);
    } catch (error) {
      warnings.push(`could not comment on the issue: ${errorMessage(error)}`);
    }
    return { merged: false, pull_request: number, status: currentStatus, reason, ...(warnings.length > 0 ? { warnings } : {}) };
  };

  let pullRequest: Json | undefined;
  try {
    const [owner, name] = target.repository.split('/');
    const response = await client.request<Json>(MERGE_CANDIDATE_QUERY, { owner, name, number: target.number, head, base: baseBranch });
    assertNoGraphqlErrors(response.errors);
    const repository = obj(obj(response.data)?.repository);
    const defaultBranch = obj(repository?.defaultBranchRef)?.name;
    if (defaultBranch === baseBranch) return await stay(`\`${baseBranch}\` is the default branch, which auto_merge never merges into`, null);
    pullRequest = nodes(repository?.pullRequests)[0];
    // Nothing to merge, e.g. the hand-off of a role that files sub-issues (auditor, autopilot, analyst, planner): no comment either.
    if (pullRequest === undefined) {
      return { merged: false, pull_request: null, status: currentStatus, reason: `there is no open pull request from ${head} into ${baseBranch}` };
    }
    const number = typeof pullRequest.number === 'number' ? pullRequest.number : null;
    if (pullRequest.isDraft === true) return await stay(`pull request #${number} is a draft`, number);
    const optOut = settings.optOutLabel.trim().toLowerCase();
    if (labelNames(pullRequest).includes(optOut) || labelNames(repository?.issue).includes(optOut)) {
      return await stay(`the pull request or the issue has the label "${settings.optOutLabel}"`, number);
    }
    if (pullRequest.mergeable === 'CONFLICTING') return await conflict(number);

    const merged = await client.request<Json>(MERGE_PULL_REQUEST_MUTATION, {
      pullRequestId: pullRequest.id,
      expectedHeadOid: pullRequest.headRefOid,
      method: settings.method,
      headline: `${String(pullRequest.title ?? head)} (#${number})`,
    });
    if (merged.errors.length > 0) {
      const message = merged.errors.map((e) => e.message).join('; ');
      return CONFLICT.test(message) ? await conflict(number) : await stay(`GitHub refused the merge of #${number}: ${message}`, number);
    }

    // The pull request is merged: from here on, problems are warnings, never a reason to report failure.
    try {
      const closed = await client.request<Json>(CLOSE_ISSUE_MUTATION, { issueId: target.issueId });
      assertNoGraphqlErrors(closed.errors);
    } catch (error) {
      warnings.push(`could not close the issue: ${errorMessage(error)}`);
    }
    let status = currentStatus;
    try {
      status = await ops.setStatus(settings.doneState ?? currentStatus);
    } catch (error) {
      warnings.push(`could not move the issue to "${settings.doneState}": ${errorMessage(error)}`);
    }
    try {
      await ops.comment(`Symphony merged #${number} into \`${baseBranch}\` (${settings.method.toLowerCase()}) after the agent review and the entry checks: ${String(pullRequest.url ?? '')}`);
    } catch (error) {
      warnings.push(`could not comment on the issue: ${errorMessage(error)}`);
    }
    return { merged: true, pull_request: number, status, reason: `merged into ${baseBranch}`, ...(warnings.length > 0 ? { warnings } : {}) };
  } catch (error) {
    const number = typeof pullRequest?.number === 'number' ? pullRequest.number : null;
    return stay(`auto-merge failed: ${errorMessage(error)}`, number);
  }

  async function conflict(number: number | null): Promise<AutoMergeResult> {
    const reason = `pull request #${number} conflicts with \`${baseBranch}\``;
    if (settings.onConflict === null) return stay(reason, number);
    let status = currentStatus;
    try {
      status = await ops.setStatus(settings.onConflict);
      await ops.comment(
        `Symphony could not merge: ${reason}. Merge \`origin/${baseBranch}\` into \`${head}\`, resolve the conflicts, ` +
          'run the checks again and hand the issue off for review.',
      );
    } catch (error) {
      warnings.push(`could not send the issue back: ${errorMessage(error)}`);
    }
    return { merged: false, pull_request: number, status, reason, ...(warnings.length > 0 ? { warnings } : {}) };
  }
}
