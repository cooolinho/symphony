import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { GithubProjectAdapter } from '../src/tracker/github-project/adapter.ts';
import { BRANCH_PULL_REQUEST_QUERY } from '../src/tracker/github-project/queries.ts';
import { createGithubTools } from '../src/tracker/github-project/tools.ts';
import type { AgentToolSpec } from '../src/tracker/types.ts';
import { makeIssue } from './helpers.ts';

const NATIVE = { provider: 'github_project', item_id: 'PVTI_1', issue_id: 'I_1', repository: 'o/r', number: 1 };
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

type Json = Record<string, unknown>;

function adapterWith(pullRequests: Json[], issueReply?: (variables: Json) => unknown) {
  const issue = makeIssue({ id: 'I_1', branch_name: null, native_ref: NATIVE } as never);
  return {
    issue,
    adapter: {
      settings: { baseBranch: null, statusField: 'Status' },
      fetchIssuesByIds: async () => [issue],
      meta: async () => ({ statusOptions: [] }),
      viewerLogin: async () => 'bot',
      branchPullRequest: GithubProjectAdapter.prototype.branchPullRequest,
      client: {
        request: async (query: string, variables: Json) => {
          if (query.includes('SymphonyBranchPullRequest')) return { errors: [], data: { repository: { pullRequests: { nodes: pullRequests } } } };
          if (query.includes('SymphonyIssueByNumber')) return issueReply ? issueReply(variables) : { errors: [], data: { repository: { issue: null } } };
          return { errors: [], data: { node: { comments: { totalCount: 0, nodes: [] }, closedByPullRequestsReferences: { nodes: [] } } } };
        },
      },
    },
  };
}

function tool(name: string, adapter: unknown): AgentToolSpec {
  const found = createGithubTools(adapter as never).find((t) => t.name === name);
  assert.ok(found, `tool ${name} is registered`);
  return found;
}

async function branchPr(pullRequests: Json[], args: Json = {}) {
  const { adapter, issue } = adapterWith(pullRequests);
  const result = await tool('get_issue', adapter).execute(args, { issue } as never);
  assert.ok(result.ok, JSON.stringify(result));
  return (result.data as { branch_pull_request: Json | null }).branch_pull_request;
}

const PR_BASE = { number: 5, url: 'https://github.com/o/r/pull/5', baseRefName: 'develop', headRefOid: 'sha1', commits: { nodes: [] } };

describe('get_issue returns the pull request description and discussion', () => {
  it('has the body of the branch pull request, with the existing fields untouched', async () => {
    const pr = await branchPr([{ ...PR_BASE, body: '## Notes\n![shot](https://x/y.png)' }]);
    assert.ok(pr);
    assert.equal(pr.body, '## Notes\n![shot](https://x/y.png)');
    assert.equal(pr.number, 5);
    assert.equal(pr.base, 'develop');
    assert.equal(pr.head_sha, 'sha1');
    assert.ok(pr.checks);
  });

  it('is null without an open pull request', async () => {
    assert.equal(await branchPr([]), null);
  });

  it('a pull request without a description or discussion has an empty body and no comments', async () => {
    const pr = await branchPr([{ ...PR_BASE, body: null }]);
    assert.ok(pr);
    assert.equal(pr.body, '');
    assert.deepEqual(pr.comments, []);
  });

  it('keeps conversation, review and review-thread comments with author, date, url and body, oldest first', async () => {
    const pr = await branchPr([
      {
        ...PR_BASE,
        body: 'b',
        comments: { nodes: [{ author: { login: 'a' }, createdAt: '2026-02-01T00:00:00Z', url: 'u-c', body: 'conv' }] },
        reviews: { nodes: [{ author: { login: 'b' }, submittedAt: '2026-01-01T00:00:00Z', url: 'u-r', body: 'sum', state: 'CHANGES_REQUESTED' }] },
        reviewThreads: {
          nodes: [{ comments: { nodes: [{ author: null, createdAt: '2026-03-01T00:00:00Z', url: 'u-t', body: 'line note', path: 'a.ts' }] } }],
        },
      },
    ]);
    assert.ok(pr);
    const comments = pr.comments as Array<Json>;
    assert.deepEqual(comments.map((c) => c.url), ['u-r', 'u-c', 'u-t']);
    assert.equal(comments[0]?.author, 'b');
    assert.equal(comments[0]?.created_at, '2026-01-01T00:00:00Z');
    assert.equal(comments[0]?.body, 'sum');
    assert.equal(comments[0]?.state, 'CHANGES_REQUESTED');
    assert.equal(comments[2]?.author, null);
    assert.equal(comments[2]?.path, 'a.ts');
    assert.ok(comments.every((c) => typeof c.kind === 'string'));
  });

  it('drops comments with a blank body', async () => {
    const pr = await branchPr([
      { ...PR_BASE, body: 'b', reviews: { nodes: [{ author: { login: 'x' }, submittedAt: 't', url: 'u', body: '  \n', state: 'APPROVED' }] } },
    ]);
    assert.deepEqual(pr?.comments, []);
  });

  it('max_comment_chars cuts body and every kind of comment and notes the cut', async () => {
    const long = 'y'.repeat(100);
    const pr = await branchPr(
      [
        {
          ...PR_BASE,
          body: long,
          comments: { nodes: [{ author: { login: 'a' }, createdAt: '1', url: 'c', body: long }] },
          reviews: { nodes: [{ author: { login: 'a' }, submittedAt: '2', url: 'r', body: long, state: 'COMMENTED' }] },
          reviewThreads: { nodes: [{ comments: { nodes: [{ author: { login: 'a' }, createdAt: '3', url: 't', body: long, path: 'p' }] } }] },
        },
      ],
      { max_comment_chars: 20 },
    );
    assert.ok(pr);
    assert.match(String(pr.body), /^y{20}.*\[80 characters cut\]$/);
    const comments = pr.comments as Array<{ body: string }>;
    assert.equal(comments.length, 3);
    for (const c of comments) assert.match(c.body, /^y{20}.*\[80 characters cut\]$/);
  });

  it('does not cut without max_comment_chars', async () => {
    const long = 'z'.repeat(5000);
    const pr = await branchPr([{ ...PR_BASE, body: long }]);
    assert.equal(pr?.body, long);
  });

  it('the GraphQL query asks for body, comments, reviews and review threads of the pull request', () => {
    for (const field of ['body', 'comments', 'reviews', 'reviewThreads']) assert.match(BRANCH_PULL_REQUEST_QUERY, new RegExp(`\\b${field}\\b`));
  });

  it('the orchestrator-facing adapter.branchPullRequest still returns the old fields, new ones are additive', async () => {
    const { adapter, issue } = adapterWith([{ ...PR_BASE, body: 'b' }]);
    const pr = await GithubProjectAdapter.prototype.branchPullRequest.call(adapter, issue);
    assert.ok(pr);
    assert.equal(pr.number, 5);
    assert.equal(pr.url, 'https://github.com/o/r/pull/5');
    assert.equal(pr.base, 'develop');
    assert.equal(pr.head_sha, 'sha1');
    assert.ok(pr.checks && 'state' in pr.checks && 'failing' in pr.checks && 'pending' in pr.checks);
  });

  it('the tool description tells what is returned and that gh and a token are missing', () => {
    const { adapter } = adapterWith([]);
    const description = tool('get_issue', adapter).description;
    assert.match(description, /body/);
    assert.match(description, /comments/);
    assert.match(description, /gh/);
  });
});

describe('get_issue_by_number', () => {
  const ISSUE = {
    number: 7,
    title: 'Sibling',
    body: 'b'.repeat(40),
    state: 'OPEN',
    url: 'https://github.com/o/r/issues/7',
    labels: { nodes: [{ name: 'bug' }, { name: 'ui' }] },
    projectItems: { nodes: [{ status: { name: 'Ready' } }] },
    comments: { totalCount: 25, nodes: [{ author: { login: 'h' }, createdAt: 't', url: 'cu', body: 'hello' }] },
    subIssues: { nodes: [{ number: 8, title: 'child', state: 'OPEN' }] },
  };

  async function call(args: Json) {
    const seen: Json[] = [];
    const { adapter, issue } = adapterWith([], (variables) => {
      seen.push(variables);
      return { errors: [], data: { repository: { issue: variables.number === 7 ? ISSUE : null } } };
    });
    const t = tool('get_issue_by_number', adapter);
    return { t, seen, result: await t.execute(args, { issue } as never) };
  }

  it('is registered next to get_issue and is read-only', async () => {
    const { t } = await call({ number: 7 });
    assert.equal(t.mutates, false);
    assert.match(t.description, /same repository/i);
  });

  it('returns title, body, state, status, labels, comments and sub-issues of the same repository', async () => {
    const { result, seen } = await call({ number: 7 });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(seen[0]?.owner, 'o');
    assert.equal(seen[0]?.name, 'r');
    assert.equal(seen[0]?.number, 7);
    const data = result.data as { issue: Json; comments: Json[]; total_comments: number; sub_issues: Json[] };
    assert.equal(data.issue.number, 7);
    assert.equal(data.issue.title, 'Sibling');
    assert.equal(data.issue.description, 'b'.repeat(40));
    assert.equal(data.issue.state, 'OPEN');
    assert.equal(data.issue.status, 'Ready');
    assert.deepEqual(data.issue.labels, ['bug', 'ui']);
    assert.equal(data.comments[0]?.author, 'h');
    assert.equal(data.comments[0]?.body, 'hello');
    assert.equal(data.total_comments, 25);
    assert.deepEqual(data.sub_issues, [{ number: 8, title: 'child', state: 'OPEN' }]);
  });

  it('cuts description and comments with max_comment_chars', async () => {
    const { result } = await call({ number: 7, max_comment_chars: 3 });
    assert.ok(result.ok);
    const data = result.data as { issue: { description: string }; comments: Array<{ body: string }> };
    assert.match(data.issue.description, /^bbb.*\[37 characters cut\]$/);
    assert.match(data.comments[0]!.body, /^hel.*\[2 characters cut\]$/);
  });

  it('an unknown number fails with not_found and does not throw', async () => {
    const { result } = await call({ number: 999 });
    assert.equal(result.ok, false);
  });

  it('has no repository parameter: another repository cannot be addressed', async () => {
    const { t } = await call({ number: 7 });
    assert.deepEqual(Object.keys(t.inputSchema).sort(), ['max_comment_chars', 'number']);
  });

  it('a number that is not a positive integer is refused by the input schema', async () => {
    const { t } = await call({ number: 7 });
    const number = t.inputSchema.number as { safeParse(v: unknown): { success: boolean } };
    assert.equal(number.safeParse(0).success, false);
    assert.equal(number.safeParse(-1).success, false);
    assert.equal(number.safeParse(1.5).success, false);
    assert.equal(number.safeParse('7').success, false);
    assert.equal(number.safeParse(7).success, true);
  });
});

describe('role prompts and docs', () => {
  const NO_GH = /`gh` is not installed and there is no GitHub token/;

  it('reviewer prompt names the fields get_issue returns and says gh and a token are unavailable', () => {
    const text = read('roles/reviewer.md');
    assert.match(text, /branch_pull_request/);
    assert.match(text, /`body`/);
    assert.match(text, /`comments`/);
    assert.match(text, NO_GH);
    assert.doesNotMatch(text, /linked pull request \(its base branch, description and discussion\)/);
  });

  it('reviewer prompt says a failing check gives name and URL, not the log', () => {
    assert.match(read('roles/reviewer.md'), /not the log/);
  });

  it('analyst prompts point to get_issue_by_number and say gh and a token are unavailable', () => {
    for (const file of ['roles/issue-analyst.md', 'roles/analyst.md']) {
      const text = read(file);
      assert.match(text, /get_issue_by_number/, file);
      assert.match(text, NO_GH, file);
    }
  });

  it('the github-project adapter doc lists get_issue_by_number and the new get_issue fields', () => {
    const doc = read('docs/adapters/github-project.md');
    assert.match(doc, /`get_issue_by_number`/);
    assert.match(doc, /branch_pull_request[^|]*body/);
  });
});
