import { errorMessage } from '../../util/errors.ts';
import type { AutoMergeChecks, AutoMergeResult, Issue } from '../types.ts';
import { compileIgnoreGlobs, describeChecks, evaluateRollup, type CheckEvaluation } from './checks.ts';
import type { GithubGraphqlClient } from './client.ts';
import { assertNoGraphqlErrors } from './client.ts';
import { AWAITING_CHECKS_LABEL } from './labels.ts';
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
/** A push between the read and the merge: the next attempt reads the new head and its checks. */
const HEAD_MOVED = /head branch was modified|head ref.*(?:changed|modified)|expected head oid/i;
/** Branch protection or rulesets refused the merge; integrating the base branch does not help. */
const RULES = /required status check|repository rule|rule violation|protected branch|review is required/i;

/** Hidden marker of a send-back for failing checks; counted for `auto_merge.checks.max_send_backs`. */
export const CHECKS_FAILED_MARKER = '<!-- symphony:merge-gate checks_failed -->';
const NEEDS_HUMAN_LABEL = 'needs-human';

export interface MergeTarget {
  issueId: string;
  repository: string;
  number: number;
}

/** Board, comment and label operations of the calling tool, so the merge reuses its status lookup. */
export interface MergeOps {
  /** Moves the issue to a column and returns the column's name. */
  setStatus(status: string): Promise<string>;
  comment(body: string): Promise<void>;
  addLabel(name: string): Promise<void>;
  /** How often the merge gate sent the issue back for failing checks before (comments with {@link CHECKS_FAILED_MARKER}). */
  sendBacks(): Promise<number>;
}

export interface MergeOptions {
  /** Commit the entry checks ran on; a pull request with another head is never merged. */
  checkedSha?: string | null;
  /** A retry of an issue waiting for checks: no new comment or label while they are still pending. */
  retry?: boolean;
}

function summary(checks: CheckEvaluation): AutoMergeChecks {
  return { state: checks.state, failing: checks.failing, pending: checks.pending.map((check) => check.name) };
}

/**
 * Merges the issue's open pull request into the base branch after the issue entered `settings.onEnter`, closes the
 * issue and moves it to the done column. Never merges into the default branch, a draft, or anything carrying the
 * opt-out label. Without a pull request nothing happens. The merge gate reads the checks of the head commit:
 * failing checks send the issue to `settings.onChecksFailed` (else `onConflict`), pending ones (and a mergeable state
 * GitHub has not computed yet) make it wait with the label `awaiting-checks`, unless `checks.wait` is off. A conflict
 * sends the issue to `settings.onConflict` (when set) for the developer; every other refusal or failure leaves it
 * where it is, with a comment for the human.
 */
export async function autoMerge(
  client: GithubGraphqlClient,
  settings: AutoMergeSettings,
  baseBranch: string,
  target: MergeTarget,
  issue: Pick<Issue, 'branch_name'>,
  currentStatus: string,
  ops: MergeOps,
  options: MergeOptions = {},
): Promise<AutoMergeResult> {
  const head = issue.branch_name ?? `symphony/issue-${target.number}`;
  const warnings: string[] = [];
  let checks: AutoMergeChecks | undefined;
  const result = (merged: boolean, number: number | null, status: string, reason: string, extra: Partial<AutoMergeResult> = {}): AutoMergeResult => ({
    merged,
    pull_request: number,
    status,
    reason,
    ...extra,
    ...(checks !== undefined ? { checks } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  });
  const stay = async (reason: string, number: number | null): Promise<AutoMergeResult> => {
    try {
      await ops.comment(`Symphony did not merge automatically: ${reason}. The issue stays in "${currentStatus}" for a human.`);
    } catch (error) {
      warnings.push(`could not comment on the issue: ${errorMessage(error)}`);
    }
    return result(false, number, currentStatus, reason);
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
      return result(false, null, currentStatus, `there is no open pull request from ${head} into ${baseBranch}`);
    }
    const number = typeof pullRequest.number === 'number' ? pullRequest.number : null;
    if (pullRequest.isDraft === true) return await stay(`pull request #${number} is a draft`, number);
    const optOut = settings.optOutLabel.trim().toLowerCase();
    if (labelNames(pullRequest).includes(optOut) || labelNames(repository?.issue).includes(optOut)) {
      return await stay(`the pull request or the issue has the label "${settings.optOutLabel}"`, number);
    }
    const headSha = typeof pullRequest.headRefOid === 'string' ? pullRequest.headRefOid : null;
    const checkedSha = options.checkedSha ?? null;
    if (checkedSha !== null && headSha !== checkedSha) {
      return await stay(
        `pull request #${number} has commits the entry checks did not see (checked ${checkedSha.slice(0, 7)}, head ${String(headSha).slice(0, 7)})`,
        number,
      );
    }
    if (pullRequest.mergeable === 'CONFLICTING') return await conflict(number);

    const evaluation = evaluateRollup(pullRequest.commits, target.repository, compileIgnoreGlobs(settings.checks.ignore));
    checks = summary(evaluation);
    if (evaluation.state === 'failure') {
      if (evaluation.infra) {
        return await stay(
          `the checks of #${number} did not run: GitHub did not start their jobs (${describeChecks(evaluation.failing)}), ` +
            'usually because the Actions minutes or the spending limit are used up. Fix the billing, or let Symphony run the ' +
            'checks (repository variable `CI_RUNNER=symphony`, see docs/adapters/github-project.md), then move the issue back',
          number,
        );
      }
      return await checksFailed(number, evaluation);
    }
    if (evaluation.state === 'pending') return await awaiting(`the checks of #${number} are still running (${describeChecks(evaluation.pending)})`, number);
    if (pullRequest.mergeable === 'UNKNOWN') return await awaiting(`GitHub has not computed yet whether #${number} can be merged`, number);

    const merged = await client.request<Json>(MERGE_PULL_REQUEST_MUTATION, {
      pullRequestId: pullRequest.id,
      expectedHeadOid: pullRequest.headRefOid,
      method: settings.method,
      headline: `${String(pullRequest.title ?? head)} (#${number})`,
    });
    if (merged.errors.length > 0) {
      const message = merged.errors.map((e) => e.message).join('; ');
      if (HEAD_MOVED.test(message)) return await awaiting(`the head of #${number} changed while merging`, number);
      if (RULES.test(message)) return await stay(`GitHub refused the merge of #${number}: ${message}`, number);
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
    const checked = evaluation.state === 'none' ? 'the pull request has no checks' : 'its checks passed';
    try {
      await ops.comment(
        `Symphony merged #${number} into \`${baseBranch}\` (${settings.method.toLowerCase()}) after the agent review and the entry checks; ${checked}: ${String(pullRequest.url ?? '')}`,
      );
    } catch (error) {
      warnings.push(`could not comment on the issue: ${errorMessage(error)}`);
    }
    return result(true, number, status, `merged into ${baseBranch}`);
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
    return result(false, number, status, reason);
  }

  /** Waits in the column (label `awaiting-checks`); the orchestrator retries every poll. */
  async function awaiting(reason: string, number: number | null): Promise<AutoMergeResult> {
    if (!settings.checks.wait) return stay(`${reason} (auto_merge.checks.wait is off)`, number);
    if (options.retry !== true) {
      try {
        await ops.addLabel(AWAITING_CHECKS_LABEL);
      } catch (error) {
        // Without the label nothing retries the merge, so a human must.
        return stay(`${reason}, and the label "${AWAITING_CHECKS_LABEL}" could not be added (${errorMessage(error)})`, number);
      }
      try {
        await ops.comment(
          `Symphony waits before merging: ${reason}. It merges as soon as they pass and sends the issue back if one fails ` +
            `(label \`${AWAITING_CHECKS_LABEL}\`).`,
        );
      } catch (error) {
        warnings.push(`could not comment on the issue: ${errorMessage(error)}`);
      }
    }
    return result(false, number, currentStatus, reason, { awaiting_checks: true });
  }

  async function checksFailed(number: number | null, evaluation: CheckEvaluation): Promise<AutoMergeResult> {
    const list = describeChecks(evaluation.failing);
    const reason = `checks of pull request #${number} failed: ${list}`;
    const back = settings.onChecksFailed ?? settings.onConflict;
    if (back === null) return stay(reason, number);
    let count = 0;
    try {
      count = await ops.sendBacks();
    } catch (error) {
      warnings.push(`could not count earlier send-backs: ${errorMessage(error)}`);
    }
    if (count >= settings.checks.maxSendBacks) {
      try {
        await ops.addLabel(NEEDS_HUMAN_LABEL);
      } catch (error) {
        warnings.push(`could not add the label "${NEEDS_HUMAN_LABEL}": ${errorMessage(error)}`);
      }
      return stay(`${reason}; the issue was sent back for failing checks ${count} times already (auto_merge.checks.max_send_backs)`, number);
    }
    let status = currentStatus;
    try {
      status = await ops.setStatus(back);
      await ops.comment(
        `${CHECKS_FAILED_MARKER}\nSymphony did not merge #${number}, these checks failed: ${list}. ` +
          'Open the linked runs, fix the cause on the branch, push, run the checks again and hand the issue off for review.',
      );
    } catch (error) {
      warnings.push(`could not send the issue back: ${errorMessage(error)}`);
    }
    return result(false, number, status, reason);
  }
}
