import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GithubGraphqlClient, GraphqlResponse } from '../src/tracker/github-project/client.ts';
import {
  compareVersions,
  highestVersionTag,
  parseVersion,
  publishRelease,
  releaseReport,
  unexpectedFiles,
  type ReleaseDeps,
  type ReleaseRequest,
} from '../src/tracker/github-project/release.ts';
import { parseSettings, type ReleaseSettings } from '../src/tracker/github-project/settings.ts';

type Json = Record<string, unknown>;

interface FakePr {
  number: number;
  title: string;
  base: string;
  head: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  files: string[];
  labels?: string[];
  draft?: boolean;
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  /** Check states of the head commit, consumed one per read (the last one stays). */
  checks?: Array<'SUCCESS' | 'FAILURE' | 'PENDING' | 'none'>;
  mergeCommit?: string;
}

/** A repository with tags, pull requests and releases, behind the GraphQL client and the REST fetch. */
class FakeRepo {
  defaultBranch = 'main';
  tags: string[] = ['v1.4.0', 'v1.5.1', 'v1.5.0', 'nightly'];
  issueLabels: string[] = [];
  releases = new Map<string, { target: string | null; body: string }>();
  prs = new Map<number, FakePr>();
  nextPr = 100;
  log: string[] = [];
  mergeError: string | null = null;

  pr(pr: FakePr): this {
    this.prs.set(pr.number, pr);
    return this;
  }

  client(): GithubGraphqlClient {
    return { request: async <T>(query: string, variables: Json) => this.#graphql(query, variables) as GraphqlResponse<T> } as unknown as GithubGraphqlClient;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Json;
    this.log.push(`POST ${url}`);
    const tag = String(body.tag_name);
    if (this.releases.has(tag)) return new Response('{"message":"already_exists"}', { status: 422 });
    this.releases.set(tag, { target: typeof body.target_commitish === 'string' ? body.target_commitish : null, body: String(body.body) });
    if (!this.tags.includes(tag)) this.tags.unshift(tag);
    return new Response(JSON.stringify({ html_url: `https://github.com/acme/app/releases/tag/${tag}` }), { status: 201 });
  };

  #prNode(pr: FakePr): Json {
    const checks = pr.checks ?? ['SUCCESS'];
    const state = checks.length > 1 ? checks.shift() : checks[0];
    return {
      id: `PR_${pr.number}`,
      number: pr.number,
      url: `https://github.com/acme/app/pull/${pr.number}`,
      title: pr.title,
      state: pr.state,
      merged: pr.state === 'MERGED',
      isDraft: pr.draft === true,
      baseRefName: pr.base,
      headRefName: pr.head,
      headRefOid: `sha-${pr.number}`,
      mergeable: pr.mergeable ?? 'MERGEABLE',
      mergeCommit: pr.mergeCommit !== undefined ? { oid: pr.mergeCommit } : null,
      labels: { nodes: (pr.labels ?? []).map((name) => ({ name })) },
      files: { totalCount: pr.files.length, nodes: pr.files.map((path) => ({ path })) },
      commits: {
        nodes: [
          {
            commit: {
              oid: `sha-${pr.number}`,
              statusCheckRollup:
                state === 'none'
                  ? null
                  : {
                      state,
                      contexts: {
                        totalCount: 1,
                        nodes: [
                          state === 'PENDING'
                            ? { __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS', conclusion: null, detailsUrl: null, annotations: { nodes: [] } }
                            : { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: state, detailsUrl: null, annotations: { nodes: [] } },
                        ],
                      },
                    },
            },
          },
        ],
      },
    };
  }

  #graphql(query: string, variables: Json): { data: Json | null; errors: Array<{ message: string; type?: string }> } {
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? '';
    this.log.push(op);
    switch (op) {
      case 'SymphonyReleaseRepository': {
        const tag = String(variables.tag);
        return {
          data: {
            repository: {
              id: 'R_1',
              defaultBranchRef: { name: this.defaultBranch },
              issue: { labels: { nodes: this.issueLabels.map((name) => ({ name })) } },
              release: this.releases.has(tag) ? { url: `https://github.com/acme/app/releases/tag/${tag}` } : null,
              ref: this.tags.includes(tag) ? { name: tag } : null,
              refs: { nodes: this.tags.map((name) => ({ name })) },
            },
          },
          errors: [],
        };
      }
      case 'SymphonyReleasePullRequest': {
        const pr = this.prs.get(Number(variables.number));
        if (pr === undefined) return { data: { repository: { pullRequest: null } }, errors: [{ message: 'not found', type: 'NOT_FOUND' }] };
        return { data: { repository: { pullRequest: this.#prNode(pr) } }, errors: [] };
      }
      case 'SymphonyReleaseBranchPullRequests': {
        const matching = [...this.prs.values()].filter((pr) => pr.head === variables.head && pr.base === variables.base);
        return {
          data: {
            repository: {
              open: { nodes: matching.filter((pr) => pr.state === 'OPEN').map((pr) => ({ number: pr.number })) },
              merged: { nodes: matching.filter((pr) => pr.state === 'MERGED').map((pr) => ({ number: pr.number, title: pr.title, mergeCommit: { oid: pr.mergeCommit } })) },
            },
          },
          errors: [],
        };
      }
      case 'SymphonyCreatePullRequest': {
        const number = this.nextPr++;
        this.pr({ number, title: String(variables.title), base: String(variables.base), head: String(variables.head), state: 'OPEN', files: [] });
        return { data: { createPullRequest: { pullRequest: { number, url: `https://github.com/acme/app/pull/${number}`, title: variables.title, isDraft: false } } }, errors: [] };
      }
      case 'SymphonyMergePullRequest': {
        if (this.mergeError !== null) return { data: null, errors: [{ message: this.mergeError }] };
        const number = Number(String(variables.pullRequestId).slice('PR_'.length));
        const pr = this.prs.get(number);
        assert.ok(pr !== undefined);
        assert.equal(variables.method, 'MERGE');
        pr.state = 'MERGED';
        pr.mergeCommit = `merge-${number}`;
        return { data: { mergePullRequest: { pullRequest: { number, merged: true } } }, errors: [] };
      }
      default:
        throw new Error(`unexpected GraphQL operation ${op}`);
    }
  }
}

const SETTINGS: ReleaseSettings = { method: 'MERGE', waitMs: 60_000, pollMs: 20_000, ignore: [], optOutLabel: 'manual-merge', doneState: 'Done' };

const REQUEST: ReleaseRequest = {
  repository: 'acme/app',
  issueNumber: 7,
  version: '1.6.0',
  pullRequest: 10,
  notes: 'Completes the epics E18–E26.',
  files: ['package.json', 'package-lock.json'],
};

function bumpPr(overrides: Partial<FakePr> = {}): FakePr {
  return { number: 10, title: 'Version 1.6.0', base: 'develop', head: 'release/v1.6.0', state: 'OPEN', files: ['package.json', 'package-lock.json', 'CHANGELOG.md'], ...overrides };
}

function deps(repo: FakeRepo, overrides: Partial<ReleaseDeps> = {}): ReleaseDeps {
  let clock = 0;
  return {
    client: repo.client(),
    settings: SETTINGS,
    baseBranch: 'develop',
    rest: { fetch: repo.fetch, endpoint: 'https://api.github.com/graphql', token: 't', timeoutMs: 1000 },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    ...overrides,
  };
}

describe('release helpers', () => {
  it('parses X.Y.Z with or without v and compares versions', () => {
    assert.deepEqual(parseVersion('v1.6.0'), [1, 6, 0]);
    assert.deepEqual(parseVersion(' 2.10.3 '), [2, 10, 3]);
    assert.equal(parseVersion('1.6'), null);
    assert.equal(parseVersion('1.6.0-rc.1'), null);
    assert.ok(compareVersions([1, 10, 0], [1, 9, 9]) > 0);
    assert.equal(compareVersions([1, 2, 3], [1, 2, 3]), 0);
  });

  it('takes the highest vX.Y.Z tag, ignoring other tags', () => {
    assert.equal(highestVersionTag(['v1.4.0', 'v1.10.0', 'v1.9.2', 'nightly', '2.0.0']), 'v1.10.0');
    assert.equal(highestVersionTag(['nightly']), null);
  });

  it('allows only the declared files and CHANGELOG.md', () => {
    assert.deepEqual(unexpectedFiles(['package.json', 'CHANGELOG.md', 'src/app.ts'], ['./package.json']), ['src/app.ts']);
    assert.deepEqual(unexpectedFiles(['CHANGELOG.md'], []), []);
  });

  it('writes the report with the marker heading, the merged pull requests and the notes', () => {
    const text = releaseReport(
      { status: 'published', step: 'tag', reason: '', tag: 'v1.6.0', release_url: 'https://x/r', merged: { bump: 10, release: 11 }, next: '' },
      { notes: 'Notes' },
    );
    assert.match(text, /^## Release Report\n/);
    assert.match(text, /\[v1\.6\.0\]\(https:\/\/x\/r\)/);
    assert.match(text, /#10/);
    assert.match(text, /#11/);
    assert.match(text, /Notes$/);
  });
});

describe('publishRelease', () => {
  it('merges the bump, merges develop into main, then tags the release on the merge commit', async () => {
    const repo = new FakeRepo().pr(bumpPr());
    const result = await publishRelease(deps(repo), REQUEST);
    assert.equal(result.status, 'published', result.reason);
    assert.equal(result.tag, 'v1.6.0');
    assert.equal(result.release_url, 'https://github.com/acme/app/releases/tag/v1.6.0');
    assert.deepEqual(result.merged, { bump: 10, release: 100 });
    const release = repo.prs.get(100);
    assert.equal(release?.title, 'Release v1.6.0');
    assert.equal(release?.base, 'main');
    assert.equal(release?.head, 'develop');
    assert.deepEqual(repo.releases.get('v1.6.0'), { target: 'merge-100', body: REQUEST.notes });
  });

  it('is idempotent: a second call finds the release and changes nothing', async () => {
    const repo = new FakeRepo().pr(bumpPr());
    await publishRelease(deps(repo), REQUEST);
    const before = repo.log.length;
    const again = await publishRelease(deps(repo), REQUEST);
    assert.equal(again.status, 'published');
    assert.deepEqual(repo.log.slice(before), ['SymphonyReleaseRepository']);
  });

  it('continues after an interruption: a merged bump and a merged release pull request are not merged again', async () => {
    const repo = new FakeRepo()
      .pr(bumpPr({ state: 'MERGED', mergeCommit: 'merge-10' }))
      .pr({ number: 11, title: 'Release v1.6.0', base: 'main', head: 'develop', state: 'MERGED', files: [], mergeCommit: 'merge-11' });
    const result = await publishRelease(deps(repo), REQUEST);
    assert.equal(result.status, 'published', result.reason);
    assert.deepEqual(result.merged, { bump: 10, release: 11 });
    assert.ok(!repo.log.includes('SymphonyMergePullRequest'));
    assert.ok(!repo.log.includes('SymphonyCreatePullRequest'));
    assert.equal(repo.releases.get('v1.6.0')?.target, 'merge-11');
  });

  it('reuses an open release pull request', async () => {
    const repo = new FakeRepo()
      .pr(bumpPr({ state: 'MERGED', mergeCommit: 'merge-10' }))
      .pr({ number: 12, title: 'Release v1.6.0', base: 'main', head: 'develop', state: 'OPEN', files: [] });
    const result = await publishRelease(deps(repo), REQUEST);
    assert.equal(result.status, 'published', result.reason);
    assert.equal(result.merged.release, 12);
    assert.ok(!repo.log.includes('SymphonyCreatePullRequest'));
  });

  it('without a separate base branch, releases the bump merge commit on the default branch', async () => {
    const repo = new FakeRepo().pr(bumpPr({ base: 'main' }));
    const result = await publishRelease(deps(repo, { baseBranch: null }), REQUEST);
    assert.equal(result.status, 'published', result.reason);
    assert.deepEqual(result.merged, { bump: 10, release: null });
    assert.equal(repo.releases.get('v1.6.0')?.target, 'merge-10');
  });

  it('refuses a version that is not higher than the last vX.Y.Z tag', async () => {
    const repo = new FakeRepo().pr(bumpPr());
    const result = await publishRelease(deps(repo), { ...REQUEST, version: 'v1.5.1' });
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /not higher than the last release v1\.5\.1/);
    assert.ok(!repo.log.includes('SymphonyMergePullRequest'));
  });

  it('refuses an invalid version and empty notes', async () => {
    const repo = new FakeRepo().pr(bumpPr());
    assert.match((await publishRelease(deps(repo), { ...REQUEST, version: 'next' })).reason, /not a version/);
    assert.match((await publishRelease(deps(repo), { ...REQUEST, notes: '  ' })).reason, /notes are empty/);
  });

  it('refuses a bump that changes files besides the declared ones and CHANGELOG.md', async () => {
    const repo = new FakeRepo().pr(bumpPr({ files: ['package.json', 'CHANGELOG.md', 'src/feature.ts'] }));
    const result = await publishRelease(deps(repo), REQUEST);
    assert.equal(result.status, 'failed');
    assert.equal(result.step, 'merge_bump');
    assert.match(result.reason, /src\/feature\.ts/);
    assert.ok(!repo.log.includes('SymphonyMergePullRequest'));
  });

  it('refuses a bump into another branch than the base branch', async () => {
    const repo = new FakeRepo().pr(bumpPr({ base: 'main' }));
    const result = await publishRelease(deps(repo), REQUEST);
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /targets `main`, not the base branch `develop`/);
  });

  it('stops on the opt-out label of the release issue or the bump pull request', async () => {
    const labelled = new FakeRepo().pr(bumpPr());
    labelled.issueLabels = ['manual-merge'];
    assert.match((await publishRelease(deps(labelled), REQUEST)).reason, /release issue has the label "manual-merge"/);
    const pr = new FakeRepo().pr(bumpPr({ labels: ['Manual-Merge'] }));
    assert.match((await publishRelease(deps(pr), REQUEST)).reason, /#10 has the label "manual-merge"/);
  });

  it('fails on failing checks and on a conflict, without merging', async () => {
    const red = new FakeRepo().pr(bumpPr({ checks: ['FAILURE'] }));
    const failed = await publishRelease(deps(red), REQUEST);
    assert.equal(failed.status, 'failed');
    assert.match(failed.reason, /checks of pull request #10 failed/);
    const conflicting = new FakeRepo().pr(bumpPr({ mergeable: 'CONFLICTING' }));
    assert.match((await publishRelease(deps(conflicting), REQUEST)).reason, /#10 has conflicts/);
    assert.ok(!red.log.includes('SymphonyMergePullRequest') && !conflicting.log.includes('SymphonyMergePullRequest'));
  });

  it('waits for pending checks within the call and merges once they pass', async () => {
    const repo = new FakeRepo().pr(bumpPr({ checks: ['PENDING', 'PENDING', 'SUCCESS'] }));
    const result = await publishRelease(deps(repo), REQUEST);
    assert.equal(result.status, 'published', result.reason);
  });

  it('returns pending once the wait is used up, and a later call continues', async () => {
    // One read for the preconditions, then reads at 0, 20 and 40 s and the last one at 60 s, when the wait is used up.
    const repo = new FakeRepo().pr(bumpPr({ checks: ['PENDING', 'PENDING', 'PENDING', 'PENDING', 'PENDING', 'SUCCESS'] }));
    const first = await publishRelease(deps(repo), REQUEST);
    assert.equal(first.status, 'pending');
    assert.equal(first.step, 'merge_bump');
    assert.match(first.reason, /still running/);
    assert.match(first.next, /call publish_release again/i);
    const second = await publishRelease(deps(repo), REQUEST);
    assert.equal(second.status, 'published', second.reason);
  });

  it('reports a refused merge as failed', async () => {
    const repo = new FakeRepo().pr(bumpPr());
    repo.mergeError = 'Required status check "deploy" is expected';
    const result = await publishRelease(deps(repo), REQUEST);
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /GitHub refused to merge pull request #10/);
  });

  it('refuses a version whose tag exists without a GitHub release (tagged by hand)', async () => {
    const repo = new FakeRepo().pr(bumpPr());
    repo.tags.unshift('v1.6.0');
    const result = await publishRelease(deps(repo), REQUEST);
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /v1\.6\.0 is not higher than the last release v1\.6\.0/);
    assert.ok(!repo.log.includes('SymphonyMergePullRequest'));
    assert.equal(repo.releases.size, 0);
  });
});

describe('tracker.provider.release', () => {
  const base = { project_number: 1, repositories: 'acme/app', token: 't', base_branch: 'develop' };

  it('is off unless enabled', () => {
    assert.equal(parseSettings(base, {}).settings?.release, null);
    assert.equal(parseSettings({ ...base, release: { enabled: '$SYMPHONY_RELEASE_ENABLED' } }, {}).settings?.release, null);
  });

  it('reads the defaults and overrides, $VAR included', () => {
    const on = parseSettings({ ...base, release: { enabled: '$SYMPHONY_RELEASE_ENABLED' } }, { SYMPHONY_RELEASE_ENABLED: 'true' }).settings?.release;
    assert.deepEqual(on, { method: 'MERGE', waitMs: 240_000, pollMs: 20_000, ignore: [], optOutLabel: 'manual-merge', doneState: 'Done' });
    const custom = parseSettings(
      { ...base, release: { enabled: true, method: 'squash', done_state: 'Released', opt_out_label: 'hold', checks: { wait_ms: 0, poll_ms: 5000, ignore: 'deploy, acme/app:lint' } } },
      {},
    ).settings?.release;
    assert.deepEqual(custom, { method: 'SQUASH', waitMs: 0, pollMs: 5000, ignore: ['deploy', 'acme/app:lint'], optOutLabel: 'hold', doneState: 'Released' });
  });

  it('rejects unknown keys and invalid values', () => {
    const { errors } = parseSettings({ ...base, release: { enabled: true, method: 'fast', tag: 'x', checks: { poll_ms: 10, other: 1 } } }, {});
    assert.ok(errors.some((e) => e.includes('tracker.provider.release.tag is not a known key')));
    assert.ok(errors.some((e) => e.includes('tracker.provider.release.method must be squash, merge or rebase')));
    assert.ok(errors.some((e) => e.includes('tracker.provider.release.checks.poll_ms must be an integer >= 1000')));
    assert.ok(errors.some((e) => e.includes('tracker.provider.release.checks.other is not a known key')));
  });
});
