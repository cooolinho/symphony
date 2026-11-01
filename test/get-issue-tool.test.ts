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
