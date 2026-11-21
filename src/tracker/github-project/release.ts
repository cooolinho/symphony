import { sleep } from '../../util/async.ts';
import { errorMessage } from '../../util/errors.ts';
import { TrackerError } from '../types.ts';
import { compileIgnoreGlobs, describeChecks, evaluateRollup } from './checks.ts';
import type { GithubGraphqlClient } from './client.ts';
import { assertNoGraphqlErrors } from './client.ts';
import {
  CREATE_PULL_REQUEST_MUTATION,
  MERGE_PULL_REQUEST_MUTATION,
  RELEASE_BRANCH_PULL_REQUESTS_QUERY,
  RELEASE_PULL_REQUEST_QUERY,
  RELEASE_REPOSITORY_QUERY,
} from './queries.ts';
import type { ReleaseSettings } from './settings.ts';
import { restBase } from './statuses.ts';

/**
 * `publish_release`: turns a merged-ready version bump into a release. Every step first checks whether it is already
 * done, so a call after an interruption (a session that ended, a `pending` result) continues where the last one stopped:
 *
 * 1. preconditions: a valid version above the highest `v*` tag, a bump pull request into the base branch that changes
 *    only the declared version files and the changelog, no opt-out label;
 * 2. merge the bump pull request into the base branch (its checks must pass);
 * 3. with a base branch other than the default branch: open (or reuse) the pull request base -> default branch titled
 *    `Release vX.Y.Z` and merge it (its checks must pass);
 * 4. create the tag and the GitHub release on that merge commit.
 */

type Json = Record<string, unknown>;

export const CHANGELOG_FILE = 'CHANGELOG.md';
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;
/** A push between the read and the merge: the next read sees the new head and its checks. */
const HEAD_MOVED = /head branch was modified|head ref.*(?:changed|modified)|expected head oid/i;

export interface ReleaseRequest {
  /** `owner/name` of the release issue's repository. */
  repository: string;
  /** The release issue (its labels can stop the release). */
  issueNumber: number;
  /** `X.Y.Z` or `vX.Y.Z`. */
  version: string;
  /** The version-bump pull request into the base branch. */
  pullRequest: number;
  /** Release notes (Markdown): the body of the release pull request and of the GitHub release. */
  notes: string;
  /** Files the bump changes besides CHANGELOG.md (package.json, composer.json, …); nothing else may change. */
  files: string[];
}

export type ReleaseStatus = 'published' | 'pending' | 'failed';
export type ReleaseStep = 'preconditions' | 'merge_bump' | 'merge_release' | 'tag';

export interface ReleaseResult {
  status: ReleaseStatus;
  /** The step the call ended in (the last one on success). */
  step: ReleaseStep;
  reason: string;
  tag: string | null;
  release_url: string | null;
  /** Pull requests merged in this call or found merged. */
  merged: { bump: number | null; release: number | null };
  /** What to do next, for the agent. */
  next: string;
  /** Board column of the release issue after the call (set once the release is published). */
  issue_status?: string;
  /** Problems after the release was published (report comment, closing, moving the issue). */
  warnings?: string[];
}

/** Heading of the report comment Symphony posts on the release issue; the release skill looks for it. */
export const RELEASE_REPORT_HEADING = '## Release Report';

/** The report comment for a published release. */
export function releaseReport(result: ReleaseResult, request: Pick<ReleaseRequest, 'notes'>): string {
  const lines = [RELEASE_REPORT_HEADING, ''];
  lines.push(`**Released:** ${result.release_url !== null ? `[${result.tag}](${result.release_url})` : String(result.tag)}`);
  if (result.merged.bump !== null) lines.push(`**Version bump:** #${result.merged.bump}`);
  if (result.merged.release !== null) lines.push(`**Release pull request:** #${result.merged.release}`);
  lines.push('', request.notes.trim());
  return lines.join('\n');
}

export interface ReleaseDeps {
  client: GithubGraphqlClient;
  settings: ReleaseSettings;
  /** `tracker.provider.base_branch`; null = the bump pull request targets the default branch. */
  baseBranch: string | null;
  rest: { fetch: typeof fetch; endpoint: string; token: string; timeoutMs: number };
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** `[major, minor, patch]` of `vX.Y.Z` / `X.Y.Z`; null for anything else. */
export function parseVersion(text: string): [number, number, number] | null {
  const match = VERSION.exec(text.trim());
  if (match === null) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The highest `vX.Y.Z` among tag names (other tags are ignored); null without one. */
export function highestVersionTag(tags: readonly string[]): string | null {
  let best: { tag: string; version: [number, number, number] } | null = null;
  for (const tag of tags) {
    if (!tag.startsWith('v')) continue;
    const version = parseVersion(tag);
    if (version !== null && (best === null || compareVersions(version, best.version) > 0)) best = { tag, version };
  }
  return best?.tag ?? null;
}

/** Changed files outside `allowed` (and CHANGELOG.md); paths compared without a leading `./`. */
export function unexpectedFiles(changed: readonly string[], allowed: readonly string[]): string[] {
  const clean = (path: string) => path.trim().replace(/^\.\//, '');
  const permitted = new Set([...allowed.map(clean), CHANGELOG_FILE]);
  return changed.filter((path) => !permitted.has(clean(path)));
}

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

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Thrown inside the flow to end the call with a result. */
class Stop extends Error {
  readonly status: Exclude<ReleaseStatus, 'published'>;
  readonly reason: string;

  constructor(status: Exclude<ReleaseStatus, 'published'>, reason: string) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

export async function publishRelease(deps: ReleaseDeps, request: ReleaseRequest): Promise<ReleaseResult> {
  const { client, settings } = deps;
  const wait = deps.sleep ?? ((ms: number) => sleep(ms));
  const now = deps.now ?? Date.now;
  const deadline = now() + settings.waitMs;
  const ignore = compileIgnoreGlobs(settings.ignore);
  const optOut = settings.optOutLabel.trim().toLowerCase();
  const [owner, name] = request.repository.split('/');
  const merged: ReleaseResult['merged'] = { bump: null, release: null };
  let step: ReleaseStep = 'preconditions';
  let tag: string | null = null;

  const done = (status: ReleaseStatus, reason: string, releaseUrl: string | null, next: string): ReleaseResult => ({
    status,
    step,
    reason,
    tag,
    release_url: releaseUrl,
    merged,
    next,
  });

  try {
    const version = parseVersion(request.version);
    if (version === null) throw new Stop('failed', `"${request.version}" is not a version of the form X.Y.Z`);
    tag = `v${version.join('.')}`;
    if (request.notes.trim() === '') throw new Stop('failed', 'the release notes are empty');

    const repoResponse = await client.request<Json>(RELEASE_REPOSITORY_QUERY, {
      owner,
      name,
      issue: request.issueNumber,
      tag,
      qualifiedTag: `refs/tags/${tag}`,
    });
    assertNoGraphqlErrors(repoResponse.errors);
    const repository = obj(obj(repoResponse.data)?.repository);
    const repositoryId = str(repository?.id);
    const defaultBranch = str(obj(repository?.defaultBranchRef)?.name);
    if (repository === null || repositoryId === null || defaultBranch === null) {
      throw new Stop('failed', `repository ${request.repository} is not accessible or has no default branch`);
    }
    const existingRelease = str(obj(repository.release)?.url);
    if (existingRelease !== null) {
      step = 'tag';
      return done('published', `the GitHub release ${tag} exists already`, existingRelease, 'Nothing is left to do: Symphony closed the issue. End your turn.');
    }
    if (labelNames(repository.issue).includes(optOut)) throw new Stop('failed', `the release issue has the label "${settings.optOutLabel}"`);
    const last = highestVersionTag(nodes(repository.refs).map((ref) => String(ref.name ?? '')));
    const lastVersion = last === null ? null : parseVersion(last);
    if (lastVersion !== null && compareVersions(version, lastVersion) <= 0) {
      throw new Stop('failed', `${tag} is not higher than the last release ${last}`);
    }
    // Only the newest 100 tags are read: an older tag of the same name still stops the release.
    if (obj(repository.ref) !== null) {
      throw new Stop('failed', `the tag ${tag} exists already without a GitHub release (tagged by hand?); pick a higher version or release that tag by hand`);
    }
    const base = deps.baseBranch ?? defaultBranch;

    // Step 2: the version bump into the base branch.
    step = 'merge_bump';
    let bump = await readPullRequest(request.pullRequest);
    if (bump === null) throw new Stop('failed', `pull request #${request.pullRequest} does not exist`);
    if (bump.baseRefName !== base) throw new Stop('failed', `pull request #${request.pullRequest} targets \`${String(bump.baseRefName)}\`, not the base branch \`${base}\``);
    const files = obj(bump.files);
    const changed = nodes(files).map((file) => String(file.path ?? ''));
    const total = typeof files?.totalCount === 'number' ? files.totalCount : changed.length;
    if (total > changed.length) throw new Stop('failed', `pull request #${request.pullRequest} changes ${total} files; a version bump changes only a few`);
    const extra = unexpectedFiles(changed, request.files);
    if (extra.length > 0) {
      throw new Stop(
        'failed',
        `pull request #${request.pullRequest} changes files other than the declared version files and ${CHANGELOG_FILE}: ${extra.join(', ')}. ` +
          'A release must not carry code past the review; move those changes to their own issue',
      );
    }
    if (bump.merged === true) {
      merged.bump = request.pullRequest;
    } else if (bump.state !== 'OPEN') {
      throw new Stop('failed', `pull request #${request.pullRequest} is closed without being merged`);
    } else {
      if (labelNames(bump).includes(optOut)) throw new Stop('failed', `pull request #${request.pullRequest} has the label "${settings.optOutLabel}"`);
      if (bump.isDraft === true) throw new Stop('failed', `pull request #${request.pullRequest} is a draft`);
      bump = await mergeWhenGreen(request.pullRequest, `${tag}: Version (#${request.pullRequest})`);
      merged.bump = request.pullRequest;
    }
    let target = str(obj(bump.mergeCommit)?.oid);

    // Step 3: base branch -> default branch.
    if (base !== defaultBranch) {
      step = 'merge_release';
      const title = `Release ${tag}`;
      const branches = await client.request<Json>(RELEASE_BRANCH_PULL_REQUESTS_QUERY, { owner, name, head: base, base: defaultBranch });
      assertNoGraphqlErrors(branches.errors);
      const branchRepo = obj(obj(branches.data)?.repository);
      const previous = nodes(branchRepo?.merged).find((pr) => String(pr.title ?? '').trim() === title);
      if (previous !== undefined) {
        merged.release = typeof previous.number === 'number' ? previous.number : null;
        target = str(obj(previous.mergeCommit)?.oid) ?? target;
      } else {
        let number = nodes(branchRepo?.open)[0]?.number;
        if (typeof number !== 'number') {
          const created = await client.request<Json>(CREATE_PULL_REQUEST_MUTATION, {
            repositoryId,
            base: defaultBranch,
            head: base,
            title,
            body: request.notes,
            draft: false,
          });
          if (created.errors.length > 0) throw new Stop('failed', `GitHub refused the release pull request: ${created.errors.map((e) => e.message).join('; ')}`);
          number = obj(obj(obj(created.data)?.createPullRequest)?.pullRequest)?.number;
          if (typeof number !== 'number') throw new Stop('failed', 'GitHub created no release pull request');
        }
        const release = await mergeWhenGreen(number, `${title} (#${number})`);
        merged.release = number;
        target = str(obj(release.mergeCommit)?.oid);
      }
    }

    // Step 4: tag and GitHub release.
    step = 'tag';
    const url = await createRelease(tag, target, request.notes);
    return done('published', `${tag} is released`, url, 'Nothing is left to do: Symphony posted the report and closed the issue. End your turn.');
  } catch (error) {
    if (error instanceof Stop) {
      const next =
        error.status === 'pending'
          ? 'Call publish_release again with the same arguments; it continues where it stopped.'
          : 'Explain the reason on the issue and move it to Blocked; once fixed, a new run continues where this one stopped.';
      return done(error.status, error.reason, null, next);
    }
    const message = error instanceof TrackerError ? error.message : errorMessage(error);
    return done('failed', `publish_release failed: ${message}`, null, 'Explain the reason on the issue and move it to Blocked.');
  }

  async function readPullRequest(number: number): Promise<Json | null> {
    const response = await client.request<Json>(RELEASE_PULL_REQUEST_QUERY, { owner, name, number });
    assertNoGraphqlErrors(response.errors, (error) => error.type === 'NOT_FOUND');
    return obj(obj(obj(response.data)?.repository)?.pullRequest);
  }

  /** Waits (until the call's deadline) for the checks of pull request `number`, then merges it; returns it merged. */
  async function mergeWhenGreen(number: number, headline: string): Promise<Json> {
    for (;;) {
      const pr = await readPullRequest(number);
      if (pr === null) throw new Stop('failed', `pull request #${number} does not exist`);
      if (pr.merged === true) return pr;
      if (pr.state !== 'OPEN') throw new Stop('failed', `pull request #${number} is closed without being merged`);
      if (pr.mergeable === 'CONFLICTING') throw new Stop('failed', `pull request #${number} has conflicts with \`${String(pr.baseRefName)}\``);
      const checks = evaluateRollup(pr.commits, request.repository, ignore);
      if (checks.state === 'failure') throw new Stop('failed', `the checks of pull request #${number} failed: ${describeChecks(checks.failing)}`);
      let waiting: string | null = null;
      if (checks.state === 'pending') waiting = `the checks of pull request #${number} are still running (${describeChecks(checks.pending)})`;
      else if (pr.mergeable === 'UNKNOWN') waiting = `GitHub has not computed yet whether pull request #${number} can be merged`;
      if (waiting === null) {
        const result = await client.request<Json>(MERGE_PULL_REQUEST_MUTATION, {
          pullRequestId: pr.id,
          expectedHeadOid: pr.headRefOid,
          method: settings.method,
          headline,
        });
        if (result.errors.length === 0) {
          const after = await readPullRequest(number);
          if (after?.merged === true) return after;
          waiting = `pull request #${number} is not shown as merged yet`;
        } else {
          const message = result.errors.map((e) => e.message).join('; ');
          if (!HEAD_MOVED.test(message)) throw new Stop('failed', `GitHub refused to merge pull request #${number}: ${message}`);
          waiting = `the head of pull request #${number} changed while merging`;
        }
      }
      const left = deadline - now();
      if (left <= 0) throw new Stop('pending', waiting);
      await wait(Math.min(settings.pollMs, left));
    }
  }

  /** REST `POST /repos/{repo}/releases`, creating the tag on `target` (null: the default branch). Returns the release's URL. */
  async function createRelease(tagName: string, target: string | null, notes: string): Promise<string | null> {
    const { rest } = deps;
    const response = await rest.fetch(`${restBase(rest.endpoint)}/repos/${request.repository}/releases`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${rest.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: tagName, name: tagName, body: notes, ...(target !== null ? { target_commitish: target } : {}) }),
      signal: AbortSignal.timeout(rest.timeoutMs),
    });
    const text = await response.text().catch(() => '');
    if (!response.ok) throw new Stop('failed', `GitHub refused the release ${tagName}: HTTP ${response.status} ${text.slice(0, 200)}`);
    try {
      return str(obj(JSON.parse(text))?.html_url);
    } catch {
      return null;
    }
  }
}
