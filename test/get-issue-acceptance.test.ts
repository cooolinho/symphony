import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GithubProjectAdapter } from '../src/tracker/github-project/adapter.ts';
import { createGithubTools } from '../src/tracker/github-project/tools.ts';
import type { AgentToolSpec } from '../src/tracker/types.ts';
import { decodeMarker, internalResult, renderResultComment, type ResultMeta } from '../src/workflow/results.ts';
import { makeIssue } from './helpers.ts';

const NATIVE_REF = { provider: 'github_project', item_id: 'PVTI_1', issue_id: 'I_1', repository: 'o/r', number: 1 };

const meta: ResultMeta = {
  role: 'developer',
  run: 'run-1',
  round: null,
  profile: 'standard',
  workflow_hash: 'f'.repeat(64),
  head_sha: 'a'.repeat(40),
  checks: null,
  target: 'Testing',
  created_at: '2026-10-23T05:18:21.853Z',
};

interface Output {
  issue: Record<string, unknown>;
  status_options: unknown[];
  comments: Array<{ author: string | null; from_symphony: boolean; created_at: string | null; url: string | null; body: string }>;
  total_comments: number | null;
  linked_pull_requests: Array<Record<string, unknown>>;
}

interface Fixture {
  comments?: Array<Record<string, unknown>>;
  prs?: Array<Record<string, unknown>>;
  statusOptions?: string[];
}

function tool(fixture: Fixture = {}): AgentToolSpec {
  const comments = fixture.comments ?? [];
  const issue = makeIssue({ id: 'I_1', native_ref: NATIVE_REF } as never);
  const adapter = {
    settings: { baseBranch: null },
    fetchIssuesByIds: async () => [issue],
    viewerLogin: async () => 'cooolinho-bot',
    branchPullRequest: GithubProjectAdapter.prototype.branchPullRequest,
    meta: async () => ({ statusOptions: (fixture.statusOptions ?? ['Todo', 'Testing']).map((name, i) => ({ id: `o${i}`, name })) }),
    client: {
      request: async () => ({
        errors: [],
        data: { node: { comments: { totalCount: comments.length + 5, nodes: comments }, closedByPullRequestsReferences: { nodes: fixture.prs ?? [] } } },
      }),
    },
  };
  const found = createGithubTools(adapter as never).find((t) => t.name === 'get_issue');
  assert.ok(found);
  return found;
}

async function run(t: AgentToolSpec, args: Record<string, unknown> = {}): Promise<Output> {
  const result = await t.execute(args, { issue: makeIssue({ id: 'I_1', native_ref: NATIVE_REF } as never) } as never);
  assert.ok(result.ok, JSON.stringify(result));
  return result.data as Output;
}

function resultComment(): { body: string; marker: string; visible: string } {
  const full = renderResultComment(
    internalResult('skipped', 'x'.repeat(3000)),
    meta,
  );
  const marker = /<!-- symphony:result:v1 [A-Za-z0-9_-]+ -->/.exec(full)?.[0];
  assert.ok(marker, 'rendered comment carries a marker');
  return { body: full, marker, visible: full.replace(marker, '') };
}

const comment = (body: string) => ({ author: { login: 'cooolinho-bot' }, createdAt: '2026-10-23T05:00:00Z', url: 'https://example.test/c', body });

describe('get_issue acceptance', () => {
  it('strips the base64 payload of a real rendered result comment', async () => {
    const { body, marker, visible } = resultComment();
    assert.ok(decodeMarker(body), 'precondition: the original marker decodes');
    const out = await run(tool({ comments: [comment(body)] }));
    const returned = out.comments[0]?.body ?? '';
    assert.ok(!returned.includes('symphony:result:v1'));
    assert.ok(!returned.includes(marker.split(' ')[2] ?? 'unreachable'));
    assert.equal(returned, body.replace(marker, '<!-- symphony:result -->'));
    // nothing that reads results can work from get_issue output
    assert.equal(decodeMarker(returned), null);
  });

  it('replaces every marker in one body and leaves surrounding text alone', async () => {
    const a = `<!-- symphony:result:v1 ${Buffer.from('{"a":1}').toString('base64url')} -->`;
    const b = `<!-- symphony:result:v1 ${Buffer.from('{"b":2}').toString('base64url')} -->`;
    const out = await run(tool({ comments: [comment(`one\n${a}\ntwo ${b} three`)] }));
    assert.equal(out.comments[0]?.body, 'one\n<!-- symphony:result -->\ntwo <!-- symphony:result --> three');
  });

  it('leaves comments without a result marker byte-identical', async () => {
    const bodies = ['', 'plain', '<!-- symphony:result -->', '<!-- other:marker abc -->', 'code `<!-- x -->`\n\n  trailing  \n', 'ünïcödé ✅ **bold**'];
    const out = await run(tool({ comments: bodies.map(comment) }));
    assert.deepEqual(
      out.comments.map((c) => c.body),
      bodies,
    );
  });

  it('treats a missing or null comment body as an empty string', async () => {
    const out = await run(tool({ comments: [{ author: { login: 'x' }, createdAt: 't', url: 'u' }, { author: null, createdAt: 't', url: 'u', body: null }] }));
    assert.deepEqual(out.comments.map((c) => c.body), ['', '']);
    assert.equal(out.comments[1]?.author, null);
  });

  it('keeps the documented output shape', async () => {
    const out = await run(
      tool({
        comments: [comment('hi')],
        prs: [{ number: 7, url: 'https://example.test/pr/7', state: 'OPEN', title: 'T', headRefName: 'symphony/issue-1' }],
        statusOptions: ['Backlog', 'Testing'],
      }),
    );
    assert.deepEqual(Object.keys(out).sort(), ['branch_pull_request', 'comments', 'issue', 'linked_pull_requests', 'status_options', 'total_comments']);
    assert.deepEqual(out.status_options, ['Backlog', 'Testing']);
    assert.deepEqual(Object.keys(out.comments[0] ?? {}).sort(), ['author', 'body', 'created_at', 'from_symphony', 'url']);
    assert.equal(out.comments[0]?.from_symphony, true);
    assert.equal(out.comments[0]?.author, 'cooolinho-bot');
    assert.equal(out.total_comments, 6);
    assert.deepEqual(out.linked_pull_requests, [{ number: 7, url: 'https://example.test/pr/7', state: 'OPEN', title: 'T', head: 'symphony/issue-1' }]);
  });

  it('returns an empty list of linked pull requests when there are none', async () => {
    const out = await run(tool());
    assert.deepEqual(out.linked_pull_requests, []);
    assert.deepEqual(out.comments, []);
  });

  it('describes every output field including the field names of comments and pull requests', () => {
    const { description } = tool();
    for (const field of ['issue', 'status_options', 'comments', 'author', 'created_at', 'url', 'body', 'total_comments', 'linked_pull_requests', 'number', 'state', 'title', 'head']) {
      assert.match(description, new RegExp(`\\b${field}\\b`), field);
    }
    assert.match(description, /status_options: list of strings/);
    assert.match(description, /symphony:result/);
  });

  it('stays read-only and offers max_comment_chars as the only argument', () => {
    const t = tool();
    assert.equal(t.mutates, false);
    assert.deepEqual(Object.keys(t.inputSchema), ['max_comment_chars']);
    const schema = t.inputSchema.max_comment_chars as unknown as { safeParse(v: unknown): { success: boolean } };
    assert.equal(schema.safeParse(undefined).success, true);
    assert.equal(schema.safeParse(100).success, true);
    assert.equal(schema.safeParse(0).success, false);
    assert.equal(schema.safeParse(-5).success, false);
    assert.equal(schema.safeParse(1.5).success, false);
    assert.equal(schema.safeParse('10').success, false);
  });

  it('without max_comment_chars does not cut long bodies', async () => {
    const long = 'y'.repeat(70_000);
    const out = await run(tool({ comments: [comment(long)] }));
    assert.equal(out.comments[0]?.body, long);
  });

  it('cuts only bodies longer than the limit and reports the exact number of cut characters', async () => {
    const out = await run(tool({ comments: [comment('a'.repeat(10)), comment('b'.repeat(11)), comment('short')] }), { max_comment_chars: 10 });
    assert.equal(out.comments[0]?.body, 'a'.repeat(10));
    assert.equal(out.comments[1]?.body, `${'b'.repeat(10)}… [1 characters cut]`);
    assert.equal(out.comments[2]?.body, 'short');
  });

  it('counts the limit against the stripped body, not the base64 marker', async () => {
    const { body, marker } = resultComment();
    const stripped = body.replace(marker, '<!-- symphony:result -->');
    assert.ok(marker.length > 100);
    const out = await run(tool({ comments: [comment(body)] }), { max_comment_chars: stripped.length });
    assert.equal(out.comments[0]?.body, stripped, 'a limit equal to the cleaned length cuts nothing');
    const cut = await run(tool({ comments: [comment(body)] }), { max_comment_chars: 100 });
    assert.equal(cut.comments[0]?.body, `${stripped.slice(0, 100)}… [${stripped.length - 100} characters cut]`);
  });

  it('shrinks a realistic result-heavy comment list measurably and keeps the visible text', async () => {
    const comments = Array.from({ length: 20 }, () => comment(resultComment().body));
    const before = JSON.stringify({ comments: comments.map((c) => c.body) }).length;
    const out = await run(tool({ comments }));
    const after = JSON.stringify({ comments: out.comments.map((c) => c.body) }).length;
    assert.ok(after < before * 0.7, `before ${before}, after ${after}`);
    const visible = resultComment().visible;
    for (const c of out.comments) assert.ok(c.body.startsWith(visible.trimEnd()));
  });
});
