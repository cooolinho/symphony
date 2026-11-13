import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GithubProjectAdapter } from '../src/tracker/github-project/adapter.ts';
import { createGithubTools } from '../src/tracker/github-project/tools.ts';
import type { AgentToolSpec } from '../src/tracker/types.ts';
import { makeIssue } from './helpers.ts';

const MARKER = `<!-- symphony:result:v1 ${Buffer.from('{"kind":"implementation"}').toString('base64url')} -->`;

function getIssueTool(comments: Array<{ body: string }>): AgentToolSpec {
  const issue = makeIssue({
    id: 'I_1',
    native_ref: { provider: 'github_project', item_id: 'PVTI_1', issue_id: 'I_1', repository: 'o/r', number: 1 },
  } as never);
  const adapter = {
    settings: { baseBranch: null },
    fetchIssuesByIds: async () => [issue],
    meta: async () => ({ statusOptions: [{ id: 'a', name: 'Todo' }] }),
    viewerLogin: async () => 'bot',
    branchPullRequest: GithubProjectAdapter.prototype.branchPullRequest,
    client: {
      request: async () => ({
        errors: [],
        data: {
          node: {
            comments: { totalCount: comments.length, nodes: comments.map((c) => ({ author: { login: 'bot' }, createdAt: 't', url: 'u', ...c })) },
            closedByPullRequestsReferences: { nodes: [] },
          },
        },
      }),
    },
  };
  const tool = createGithubTools(adapter as never).find((t) => t.name === 'get_issue');
  assert.ok(tool);
  return tool;
}

async function run(tool: AgentToolSpec, args: Record<string, unknown> = {}): Promise<{ comments: Array<{ body: string }> }> {
  const result = await tool.execute(args, { issue: makeIssue({ id: 'I_1', native_ref: { provider: 'github_project', item_id: 'PVTI_1', issue_id: 'I_1', repository: 'o/r', number: 1 } } as never) } as never);
  assert.ok(result.ok, JSON.stringify(result));
  return result.data as { comments: Array<{ body: string }> };
}

describe('get_issue branch_pull_request', () => {
  function withBranchPullRequest(reply: (variables: Record<string, unknown>) => unknown) {
    const issue = makeIssue({ id: 'I_1', branch_name: null, native_ref: { provider: 'github_project', item_id: 'PVTI_1', issue_id: 'I_1', repository: 'o/r', number: 1 } } as never);
    const seen: Array<Record<string, unknown>> = [];
    const adapter = {
      settings: { baseBranch: null },
      fetchIssuesByIds: async () => [issue],
      meta: async () => ({ statusOptions: [] }),
      viewerLogin: async () => 'bot',
      branchPullRequest: GithubProjectAdapter.prototype.branchPullRequest,
      client: {
        request: async (query: string, variables: Record<string, unknown>) => {
          if (!query.includes('SymphonyBranchPullRequest')) return { errors: [], data: { node: { comments: { totalCount: 0, nodes: [] }, closedByPullRequestsReferences: { nodes: [] } } } };
          seen.push(variables);
          return reply(variables);
        },
      },
    };
    const tool = createGithubTools(adapter as never).find((t) => t.name === 'get_issue');
    assert.ok(tool);
    return { tool, seen };
  }

  it('shows the checks of the open pull request from the issue branch', async () => {
    const { tool, seen } = withBranchPullRequest(() => ({
      errors: [],
      data: {
        repository: {
          pullRequests: {
            nodes: [
              {
                number: 9,
                url: 'https://github.com/o/r/pull/9',
                baseRefName: 'develop',
                headRefOid: 'abc',
                commits: {
                  nodes: [
                    {
                      commit: {
                        oid: 'abc',
                        statusCheckRollup: {
                          state: 'FAILURE',
                          contexts: {
                            totalCount: 2,
                            nodes: [
                              { __typename: 'StatusContext', context: 'symphony/ci', state: 'FAILURE', targetUrl: 'https://s/agent' },
                              { __typename: 'CheckRun', name: 'lint', status: 'QUEUED', conclusion: null, detailsUrl: null, annotations: { nodes: [] } },
                            ],
                          },
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    }));
    const data = (await run(tool)) as unknown as { branch_pull_request: unknown };
    assert.deepEqual(seen, [{ owner: 'o', name: 'r', head: 'symphony/issue-1' }]);
    assert.deepEqual(data.branch_pull_request, {
      number: 9,
      url: 'https://github.com/o/r/pull/9',
      base: 'develop',
      head_sha: 'abc',
      checks: { state: 'failure', failing: [{ name: 'symphony/ci', state: 'FAILURE', url: 'https://s/agent' }], pending: ['lint'] },
      body: '',
      comments: [],
    });
  });

  it('is null without a pull request, and when GitHub cannot say', async () => {
    const none = withBranchPullRequest(() => ({ errors: [], data: { repository: { pullRequests: { nodes: [] } } } }));
    assert.equal(((await run(none.tool)) as unknown as { branch_pull_request: unknown }).branch_pull_request, null);
    const broken = withBranchPullRequest(() => {
      throw new Error('rate limited');
    });
    assert.equal(((await run(broken.tool)) as unknown as { branch_pull_request: unknown }).branch_pull_request, null);
  });
});

describe('get_issue', () => {
  it('replaces the base64 result marker and keeps the visible text', async () => {
    const tool = getIssueTool([{ body: `Summary text\n\n${MARKER}` }, { body: 'plain <!-- note --> comment' }]);
    const { comments } = await run(tool);
    assert.equal(comments[0]?.body, 'Summary text\n\n<!-- symphony:result -->');
    assert.equal(comments[1]?.body, 'plain <!-- note --> comment');
  });

  it('truncates bodies with max_comment_chars and says how much was cut', async () => {
    const tool = getIssueTool([{ body: 'x'.repeat(100) }]);
    const { comments } = await run(tool, { max_comment_chars: 10 });
    assert.match(comments[0]?.body ?? '', /^x{10}… \[90 characters cut\]$/);
  });

  it('marks the comments of Symphony\'s own account with from_symphony', async () => {
    const tool = getIssueTool([{ body: 'result' }, { body: 'Bitte X ändern', author: { login: 'human' } } as never]);
    const { comments } = (await run(tool)) as unknown as { comments: Array<{ from_symphony: boolean }> };
    assert.deepEqual(
      comments.map((c) => c.from_symphony),
      [true, false],
    );
    assert.match(getIssueTool([]).description, /oldest first/);
  });

  it('documents the JSON shape in its description', () => {
    const { description } = getIssueTool([]);
    for (const part of ['status_options', 'list of strings', 'comments', 'created_at', 'total_comments', 'linked_pull_requests', 'may be empty']) {
      assert.ok(description.includes(part), part);
    }
  });
});

describe('get_issue pull request description and discussion', () => {
  const NATIVE = { provider: 'github_project', item_id: 'PVTI_1', issue_id: 'I_1', repository: 'o/r', number: 1 };
  const PR = {
    number: 9,
    url: 'https://github.com/o/r/pull/9',
    baseRefName: 'develop',
    headRefOid: 'abc',
    body: 'PR notes '.repeat(10),
    comments: { nodes: [{ author: { login: 'human' }, createdAt: '2026-01-02T00:00:00Z', url: 'c1', body: 'x'.repeat(50) }] },
    reviews: { nodes: [{ author: { login: 'rev' }, submittedAt: '2026-01-03T00:00:00Z', url: 'r1', body: 'looks fine', state: 'COMMENTED' }, { author: { login: 'empty' }, submittedAt: '2026-01-01T00:00:00Z', url: 'r0', body: '', state: 'APPROVED' }] },
    reviewThreads: { nodes: [{ comments: { nodes: [{ author: { login: 'rev' }, createdAt: '2026-01-04T00:00:00Z', url: 't1', body: 'rename this', path: 'src/a.ts' }] } }] },
    commits: { nodes: [] },
  };

  function tool() {
    const issue = makeIssue({ id: 'I_1', branch_name: null, native_ref: NATIVE } as never);
    const adapter = {
      settings: { baseBranch: null },
      fetchIssuesByIds: async () => [issue],
      meta: async () => ({ statusOptions: [] }),
      viewerLogin: async () => 'bot',
      branchPullRequest: GithubProjectAdapter.prototype.branchPullRequest,
      client: {
        request: async (query: string) =>
          query.includes('SymphonyBranchPullRequest')
            ? { errors: [], data: { repository: { pullRequests: { nodes: [PR] } } } }
            : { errors: [], data: { node: { comments: { totalCount: 0, nodes: [] }, closedByPullRequestsReferences: { nodes: [] } } } },
      },
    };
    const found = createGithubTools(adapter as never).find((t) => t.name === 'get_issue');
    assert.ok(found);
    return found;
  }

  async function pr(args: Record<string, unknown> = {}) {
    const result = await tool().execute(args, { issue: makeIssue({ id: 'I_1', native_ref: NATIVE } as never) } as never);
    assert.ok(result.ok, JSON.stringify(result));
    return (result.data as { branch_pull_request: { body: string; comments: Array<Record<string, unknown>> } }).branch_pull_request;
  }

  it('returns the pull request body and its discussion, oldest first, without empty reviews', async () => {
    const data = await pr();
    assert.equal(data.body, PR.body);
    assert.deepEqual(data.comments.map((c) => [c.kind, c.author, c.url]), [
      ['comment', 'human', 'c1'],
      ['review', 'rev', 'r1'],
      ['review_comment', 'rev', 't1'],
    ]);
    assert.equal(data.comments[2]?.path, 'src/a.ts');
  });

  it('cuts body and comments with max_comment_chars', async () => {
    const data = await pr({ max_comment_chars: 10 });
    assert.equal(data.body, `${PR.body.slice(0, 10)}… [${PR.body.length - 10} characters cut]`);
    assert.match(String(data.comments[0]?.body), /characters cut\]$/);
  });
});

describe('get_issue_by_number', () => {
  it('is a read-only tool that reads issues of the same repository only', async () => {
    const issue = makeIssue({ id: 'I_1', native_ref: { provider: 'github_project', item_id: 'PVTI_1', issue_id: 'I_1', repository: 'o/r', number: 1 } } as never);
    const seen: Array<Record<string, unknown>> = [];
    const adapter = {
      settings: { baseBranch: null, statusField: 'Status' },
      meta: async () => ({ projectId: 'P1' }),
      client: {
        request: async (_q: string, variables: Record<string, unknown>) => {
          seen.push(variables);
          return {
            errors: [],
            data: {
              repository: {
                issue: {
                  number: 7, title: 'Sibling', body: 'text', state: 'OPEN', url: 'u', labels: { nodes: [{ name: 'bug' }] },
                  comments: { totalCount: 1, nodes: [{ author: { login: 'h' }, createdAt: 't', url: 'c', body: 'z'.repeat(30) }] },
                  subIssues: { nodes: [{ number: 8, title: 'child', state: 'CLOSED' }] },
                  projectItems: { nodes: [{ project: { id: 'P0' }, status: { name: 'Other' } }, { project: { id: 'P1' }, status: { name: 'Ready' } }] },
                },
              },
            },
          };
        },
      },
    };
    const found = createGithubTools(adapter as never).find((t) => t.name === 'get_issue_by_number');
    assert.ok(found);
    assert.equal(found.mutates, false);
    const result = await found.execute({ number: 7, max_comment_chars: 5 }, { issue } as never);
    assert.ok(result.ok, JSON.stringify(result));
    const data = result.data as { issue: Record<string, unknown>; comments: Array<{ body: string }>; sub_issues: unknown[] };
    assert.deepEqual(seen[0], { owner: 'o', name: 'r', number: 7, statusField: 'Status' });
    assert.equal(data.issue.title, 'Sibling');
    assert.deepEqual(data.issue.labels, ['bug']);
    assert.match(data.comments[0]!.body, /characters cut\]$/);
    assert.equal(data.sub_issues.length, 1);
    assert.equal(data.issue.status, 'Ready');
  });
});

describe('get_issue log_tail of failing CI jobs', () => {
  const jobUrl = (job: number) => `https://github.com/o/r/actions/runs/43120591492/job/${job}`;
  const checkRun = (name: string, job: number | null) => ({
    __typename: 'CheckRun',
    name,
    status: 'COMPLETED',
    conclusion: 'FAILURE',
    detailsUrl: job === null ? null : jobUrl(job),
    annotations: { nodes: [] },
  });

  function setup(contexts: unknown[], respond: (url: string) => Response | Promise<Response>) {
    const issue = makeIssue({ id: 'I_1', branch_name: null, native_ref: { provider: 'github_project', item_id: 'PVTI_1', issue_id: 'I_1', repository: 'o/r', number: 1 } } as never);
    const client = {
      request: async (query: string) => {
        if (!query.includes('SymphonyBranchPullRequest')) return { errors: [], data: { node: { comments: { totalCount: 0, nodes: [] }, closedByPullRequestsReferences: { nodes: [] } } } };
        return {
          errors: [],
          data: {
            repository: {
              pullRequests: {
                nodes: [
                  {
                    number: 41,
                    url: 'https://github.com/o/r/pull/41',
                    baseRefName: 'develop',
                    headRefOid: 'abc',
                    commits: { nodes: [{ commit: { oid: 'abc', statusCheckRollup: { state: 'FAILURE', contexts: { totalCount: contexts.length, nodes: contexts } } } }] },
                  },
                ],
              },
            },
          },
        };
      },
    };
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchMock = (async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return respond(String(input));
    }) as typeof fetch;
    const settings = { endpoint: 'https://api.github.com/graphql', token: 'tok', requestTimeoutMs: 5000, baseBranch: null, autoMerge: null };
    const adapter = new GithubProjectAdapter(settings as never, client as never, { child: () => ({}) } as never, fetchMock);
    Object.assign(adapter, {
      fetchIssuesByIds: async () => [issue],
      meta: async () => ({ statusOptions: [] }),
      viewerLogin: async () => 'bot',
    });
    const tool = createGithubTools(adapter).find((t) => t.name === 'get_issue');
    assert.ok(tool);
    return { tool, calls };
  }

  function first<T>(list: readonly T[]): T {
    const [head] = list;
    assert.ok(head !== undefined, 'empty list');
    return head;
  }

  type Failing = Array<{ name: string; state: string; url: string | null; log_tail?: string | null; log_error?: string }>;
  async function failing(tool: AgentToolSpec): Promise<Failing> {
    const data = (await run(tool)) as unknown as { branch_pull_request: { checks: { failing: Failing } } };
    return data.branch_pull_request.checks.failing;
  }

  const SHELLCHECK_LOG = [
    '﻿2026-11-11T23:28:01.1234567Z ##[group]Run shellcheck setup/*.sh',
    ...Array.from({ length: 120 }, (_, i) => `2026-11-11T23:28:02.0000000Z \u001b[36;1mchecking file ${i}\u001b[0m`),
    '2026-11-11T23:28:03.0000000Z In setup/setup.sh line 128:',
    '2026-11-11T23:28:03.0000000Z \u001b[31mif [ -f "$f" ]; then echo ok; fi done\u001b[0m',
    '2026-11-11T23:28:03.0000000Z                                       ^-- SC1010 (warning): Use semicolon or linefeed before \'done\'.',
    '2026-11-11T23:28:03.5000000Z ##[error]Process completed with exit code 1.',
    '2026-11-11T23:28:04.0000000Z Post job cleanup.',
    '2026-11-11T23:28:04.1000000Z [command]/usr/bin/git version',
    '2026-11-11T23:28:04.2000000Z Cleaning up orphan processes',
    '',
  ].join('\r\n');

  it('adds the cleaned, cut end of the job log to a failing GitHub Actions job', async () => {
    const { tool, calls } = setup([checkRun('shellcheck', 130859746028)], () => new Response(SHELLCHECK_LOG, { status: 200 }));
    const check = first(await failing(tool));
    assert.equal(calls.length, 1);
    assert.equal(first(calls).url, 'https://api.github.com/repos/o/r/actions/jobs/130859746028/logs');
    assert.equal(new Headers(first(calls).init?.headers).get('authorization'), 'Bearer tok');
    assert.equal(first(calls).init?.redirect, 'follow');
    assert.ok(first(calls).init?.signal instanceof AbortSignal);
    assert.equal(check.name, 'shellcheck');
    assert.equal(check.url, jobUrl(130859746028));
    assert.equal(check.log_error, undefined);
    const tail = check.log_tail;
    assert.ok(typeof tail === 'string');
    const lines = tail.split('\n');
    assert.match(first(lines), /^\[log cut: last 80 of 125 lines\]$/);
    assert.equal(lines.length, 81);
    assert.match(tail, /SC1010/);
    assert.match(tail, /setup\/setup\.sh line 128/);
    assert.equal(lines.at(-1), '##[error]Process completed with exit code 1.');
    assert.doesNotMatch(tail, /\u001b/);
    assert.doesNotMatch(tail, /2026-11-11T/);
    assert.doesNotMatch(tail, /\r/);
    assert.doesNotMatch(tail, /Post job cleanup|orphan processes|git version/);
    assert.doesNotMatch(tail, /##\[group\]Run shellcheck/);
  });

  it('caps the log tail at about 6000 characters and notes the cut', async () => {
    const long = Array.from({ length: 70 }, (_, i) => `line ${i} ${'x'.repeat(200)}`).concat('##[error]boom').join('\n');
    const { tool } = setup([checkRun('bats', 7)], () => new Response(long, { status: 200 }));
    const check = first(await failing(tool));
    const tail = check.log_tail ?? '';
    const [note, ...rest] = tail.split('\n');
    assert.match(note ?? '', /^\[log cut: last \d+ of 71 lines\]$/);
    assert.ok(rest.join('\n').length <= 6000, String(rest.join('\n').length));
    assert.ok(rest.length < 71);
    assert.equal(rest.at(-1), '##[error]boom');
  });

  it('keeps a short log uncut and without a note', async () => {
    const { tool } = setup([checkRun('lint', 8)], () => new Response('2026-11-11T23:28:01.1Z SC2174 in backup/backup.sh:223\n2026-11-11T23:28:01.2Z ##[error]Process completed with exit code 1.\n', { status: 200 }));
    const check = first(await failing(tool));
    assert.equal(check.log_tail, 'SC2174 in backup/backup.sh:223\n##[error]Process completed with exit code 1.');
  });

  for (const status of [403, 404]) {
    it(`gives log_tail null with log_error on HTTP ${status}, and get_issue still succeeds`, async () => {
      const { tool, calls } = setup([checkRun('shellcheck', 9)], () => new Response('{"message":"nope"}', { status }));
      const check = first(await failing(tool));
      assert.equal(calls.length, 1);
      assert.equal(check.log_tail, null);
      assert.match(check.log_error ?? '', new RegExp(`^HTTP ${status}`));
    });
  }

  it('gives log_tail null with log_error when the request throws or times out', async () => {
    const { tool } = setup([checkRun('shellcheck', 10)], () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    });
    const check = first(await failing(tool));
    assert.equal(check.log_tail, null);
    assert.equal(check.log_error, 'timeout after 5000 ms');
  });

  it('loads no log for a status context or a check run without a job id', async () => {
    const { tool, calls } = setup(
      [
        { __typename: 'StatusContext', context: 'symphony/ci', state: 'FAILURE', targetUrl: 'https://s/agent' },
        { __typename: 'StatusContext', context: 'ext', state: 'ERROR', targetUrl: null },
        checkRun('external', null),
      ],
      () => {
        throw new Error('must not fetch');
      },
    );
    const checks = await failing(tool);
    assert.equal(calls.length, 0);
    assert.equal(checks.length, 3);
    for (const check of checks) {
      assert.equal('log_tail' in check, false, check.name);
      assert.equal('log_error' in check, false, check.name);
    }
  });

  it('loads at most 3 logs and says the others were not loaded', async () => {
    const { tool, calls } = setup([1, 2, 3, 4, 5].map((n) => checkRun(`job${n}`, n)), (url) => new Response(`${url}\n##[error]fail`, { status: 200 }));
    const checks = await failing(tool);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((c) => c.url.replace(/.*\/jobs\/(\d+)\/logs$/, '$1')), ['1', '2', '3']);
    assert.deepEqual(checks.slice(0, 3).map((c) => typeof c.log_tail), ['string', 'string', 'string']);
    for (const check of checks.slice(3)) {
      assert.equal(check.log_tail, null);
      assert.match(check.log_error ?? '', /not loaded/);
    }
  });

  it('loads no log outside get_issue (branchPullRequest without logTails)', async () => {
    const { calls } = setup([checkRun('shellcheck', 11)], () => new Response('x', { status: 200 }));
    // The orchestrator's change log calls branchPullRequest without the option: no request, no log fields.
    const adapter = new GithubProjectAdapter(
      { endpoint: 'https://api.github.com/graphql', token: 't', requestTimeoutMs: 1, baseBranch: null, autoMerge: null } as never,
      {
        request: async () => ({
          errors: [],
          data: { repository: { pullRequests: { nodes: [{ number: 1, commits: { nodes: [{ commit: { oid: 'a', statusCheckRollup: { contexts: { totalCount: 1, nodes: [checkRun('shellcheck', 11)] } } } }] } }] } } },
        }),
      } as never,
      { child: () => ({}) } as never,
      (async () => {
        calls.push({ url: 'unexpected', init: undefined });
        return new Response('x');
      }) as typeof fetch,
    );
    const issue = makeIssue({ id: 'I_1', native_ref: { provider: 'github_project', item_id: 'PVTI_1', issue_id: 'I_1', repository: 'o/r', number: 1 } } as never);
    const pull = await adapter.branchPullRequest(issue);
    assert.equal(calls.length, 0);
    assert.deepEqual(pull?.checks.failing, [{ name: 'shellcheck', state: 'FAILURE', url: jobUrl(11) }]);
  });
});
