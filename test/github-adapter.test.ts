import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Logger } from '../src/log.ts';
import { createGuard, guardTools } from '../src/orchestrator/guard.ts';
import { githubProjectFactory } from '../src/tracker/github-project/index.ts';
import { parseSettings } from '../src/tracker/github-project/settings.ts';
import { TrackerError, type Issue, type ToolResult, type TrackerAdapter } from '../src/tracker/types.ts';
import { internalResult, renderResultComment } from '../src/workflow/results.ts';
import type { ServiceConfig } from '../src/workflow/config.ts';

type Json = Record<string, unknown>;
interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

const STATUS_OPTIONS = [
  { id: 'o1', name: 'Todo' },
  { id: 'o2', name: 'In Progress' },
  { id: 'o3', name: 'Human Review' },
  { id: 'o4', name: 'Done' },
];

function itemNode(id: string, options: { status?: string | null; repo?: string; number?: number; title?: string; state?: string; labels?: string[]; assignees?: string[]; blockedBy?: Array<{ state: string; number?: number }>; project?: string; type?: string; body?: string; parent?: { number: number; title: string; state: string }; subIssues?: Array<{ number: number; state: string; stateReason?: string }> } = {}): Json {
  const status = options.status === undefined ? 'Todo' : options.status;
  const option = STATUS_OPTIONS.find((o) => o.name === status);
  return {
    __typename: 'ProjectV2Item',
    id,
    isArchived: false,
    project: { id: options.project ?? 'PVT_1' },
    status: status === null ? null : { name: status, optionId: option?.id ?? 'ox', updatedAt: '2026-09-02T08:30:04Z' },
    content:
      options.type === 'DraftIssue'
        ? { __typename: 'DraftIssue' }
        : {
            __typename: 'Issue',
            id: `I_${id}`,
            number: options.number ?? 1,
            title: options.title ?? `Title ${id}`,
            body: options.body ?? 'Body',
            url: `https://github.com/${options.repo ?? 'acme/app'}/issues/${options.number ?? 1}`,
            state: options.state ?? 'OPEN',
            createdAt: '2026-09-01T10:00:00Z',
            updatedAt: '2026-09-02T10:00:00Z',
            repository: { nameWithOwner: options.repo ?? 'acme/app' },
            labels: { nodes: (options.labels ?? []).map((name) => ({ name })) },
            assignees: { nodes: (options.assignees ?? []).map((login) => ({ login })) },
            linkedBranches: { nodes: [] },
            blockedBy: { nodes: (options.blockedBy ?? []).map((b, i) => ({ id: `B${i}`, number: b.number ?? 90 + i, state: b.state, repository: { nameWithOwner: 'acme/app' } })) },
            parent: options.parent ? { ...options.parent, repository: { nameWithOwner: 'acme/app' } } : null,
            subIssues: { nodes: (options.subIssues ?? []).map((sub) => ({ ...sub, title: `Sub ${sub.number}`, repository: { nameWithOwner: 'acme/app' } })) },
          },
  };
}

/** Light board entry derived from a full item node. */
function boardEntry(node: Json): Json {
  const content = node.content as Json;
  return {
    id: node.id,
    isArchived: false,
    status: node.status,
    content: content.__typename === 'Issue' ? { __typename: 'Issue', repository: content.repository } : { __typename: content.__typename },
  };
}

class FakeGithub {
  items = new Map<string, Json>();
  pages: string[][] = [];
  requests: Array<{ op: string; variables: Json }> = [];
  /** Return undefined to fall through to the default reply. */
  overrides = new Map<string, (variables: Json) => Reply | undefined>();
  /** States of issues/PRs referenced in issue text, keyed "owner/repo#N"; missing keys are NOT_FOUND. */
  references = new Map<string, string>();
  lastQuery = '';
  networkError: Error | null = null;
  /** Sub-issues by parent issue id, as the context query returns them; creating one appends to it. */
  subIssues = new Map<string, Json[]>();
  /** References ("owner/repo#N") that are pull requests, not issues. */
  pullRequests = new Set<string>();
  /** Repository labels by lowercase name. */
  labels = new Map<string, string>();
  /** How the repository spells a label (by lowercase name); without an entry the lookup echoes the requested name. */
  labelSpelling = new Map<string, string>();
  /** Comments by issue node id, oldest first; the comments query pages through them 100 at a time. */
  comments = new Map<string, Json[]>();
  /** Login the viewer query returns. */
  viewer = 'symphony-bot';
  /** Numbers handed out to created issues. */
  nextNumber = 100;
  /** The repository the auto-merge candidate query returns. */
  mergeCandidate: Json = { defaultBranchRef: { name: 'main' }, issue: { labels: { nodes: [] } }, pullRequests: { nodes: [] } };

  add(...nodes: Json[]): this {
    for (const node of nodes) this.items.set(node.id as string, node);
    return this;
  }

  fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (this.networkError !== null) throw this.networkError;
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Json };
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? 'unknown';
    this.lastQuery = query;
    this.requests.push({ op, variables });
    const reply = this.overrides.get(op)?.(variables) ?? this.#default(op, variables);
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status ?? 200, headers: reply.headers });
  };

  #default(op: string, variables: Json): Reply {
    switch (op) {
      case 'SymphonyProjectMeta':
        return {
          body: {
            data: {
              repositoryOwner: {
                __typename: 'User',
                projectV2: {
                  id: 'PVT_1',
                  title: 'Board',
                  url: 'https://github.com/users/acme/projects/1',
                  closed: false,
                  statusField: { __typename: 'ProjectV2SingleSelectField', id: 'F_status', name: 'Status', options: STATUS_OPTIONS },
                },
              },
            },
          },
        };
      case 'SymphonyProjectItems': {
        const pages = this.pages.length > 0 ? this.pages : [[...this.items.keys()]];
        const index = variables.after === null ? 0 : Number(String(variables.after).slice(1));
        const ids = pages[index] ?? [];
        const hasNextPage = index + 1 < pages.length;
        return {
          body: {
            data: {
              node: {
                items: {
                  pageInfo: { hasNextPage, endCursor: hasNextPage ? `c${index + 1}` : null },
                  nodes: ids.map((id) => boardEntry(this.items.get(id) as Json)),
                },
              },
            },
          },
        };
      }
      case 'SymphonyItemDetails': {
        const ids = variables.ids as string[];
        const errors = ids
          .map((id, i) => (this.items.has(id) ? null : { type: 'NOT_FOUND', path: ['nodes', i], message: `Could not resolve ${id}` }))
          .filter((e) => e !== null);
        return { body: { data: { nodes: ids.map((id) => this.items.get(id) ?? null) }, ...(errors.length ? { errors } : {}) } };
      }
      case 'SymphonyReferences': {
        const data: Json = {};
        const errors: Json[] = [];
        for (const match of this.lastQuery.matchAll(/ref(\d+): repository\(owner: \$o\d+, name: \$n\d+\) \{ issueOrPullRequest\(number: (\d+)\)/g)) {
          const index = match[1] as string;
          const key = `${variables[`o${index}`]}/${variables[`n${index}`]}#${match[2]}`;
          const state = this.references.get(key);
          if (state === undefined) {
            data[`ref${index}`] = { issueOrPullRequest: null };
            errors.push({ type: 'NOT_FOUND', path: [`ref${index}`, 'issueOrPullRequest'], message: `no ${key}` });
          } else {
            const typename = this.pullRequests.has(key) ? 'PullRequest' : 'Issue';
            data[`ref${index}`] = { issueOrPullRequest: { __typename: typename, id: `I_${key}`, number: Number(match[2]), state } };
          }
        }
        return { body: { data, ...(errors.length ? { errors } : {}) } };
      }
      case 'SymphonySetStatus':
        return { body: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.itemId } } } } };
      case 'SymphonyRepository':
        return {
          body: {
            data: {
              repository: {
                id: 'R_1',
                defaultBranchRef: { name: 'main' },
                pullRequests: { nodes: [{ id: 'PR_5', number: 5, url: 'https://github.com/acme/app/pull/5', title: 'Existing', baseRefName: 'main', headRefName: variables.head, isDraft: false }] },
              },
            },
          },
        };
      case 'SymphonySubIssueContext': {
        // Like GitHub, every child brings its own sub-issues; a test may set `subIssues` or `blockedBy` on a node itself.
        const children = (this.subIssues.get(String(variables.issueId)) ?? []).map((child) => ({
          blockedBy: { nodes: [] },
          subIssues: { nodes: this.subIssues.get(String(child.id)) ?? [] },
          ...child,
        }));
        return {
          body: {
            data: {
              node: {
                repository: { id: 'R_1', nameWithOwner: 'acme/app' },
                subIssues: { nodes: children },
              },
            },
          },
        };
      }
      case 'SymphonyLabels': {
        const data: Json = { id: 'R_1' };
        for (const match of this.lastQuery.matchAll(/l(\d+): label\(/g)) {
          const name = String(variables[`l${match[1]}`]);
          const id = this.labels.get(name.toLowerCase());
          data[`l${match[1]}`] = id === undefined ? null : { id, name: this.labelSpelling.get(name.toLowerCase()) ?? name };
        }
        return { body: { data: { repository: data } } };
      }
      case 'SymphonyCreateLabel': {
        const name = String(variables.name);
        if (this.labels.has(name.toLowerCase())) {
          return { body: { data: null, errors: [{ type: 'UNPROCESSABLE', message: 'Name has already been taken', path: ['createLabel'] }] } };
        }
        const id = `L_${this.labels.size + 1}`;
        this.labels.set(name.toLowerCase(), id);
        return { body: { data: { createLabel: { label: { id, name } } } } };
      }
      case 'SymphonyAddLabels':
      case 'SymphonyRemoveLabels':
        return { body: { data: { [op === 'SymphonyAddLabels' ? 'addLabelsToLabelable' : 'removeLabelsFromLabelable']: { clientMutationId: null } } } };
      case 'SymphonyIssueComments': {
        const all = this.comments.get(String(variables.issueId)) ?? [];
        const start = variables.after === null ? 0 : Number(String(variables.after).slice(1));
        const hasNextPage = start + 100 < all.length;
        return {
          body: {
            data: { node: { comments: { pageInfo: { hasNextPage, endCursor: hasNextPage ? `c${start + 100}` : null }, nodes: all.slice(start, start + 100) } } },
          },
        };
      }
      case 'SymphonyViewer':
        return { body: { data: { viewer: { login: this.viewer } } } };
      case 'SymphonyCreateSubIssue': {
        const number = this.nextNumber++;
        const issue = { id: `I_new${number}`, number, url: `https://github.com/acme/app/issues/${number}` };
        const siblings = this.subIssues.get(String(variables.parentId)) ?? [];
        siblings.push({ ...issue, title: variables.title, state: 'OPEN', projectItems: { nodes: [] } });
        this.subIssues.set(String(variables.parentId), siblings);
        return { body: { data: { createIssue: { issue } } } };
      }
      case 'SymphonyAddBlockedBy':
        return { body: { data: { addBlockedBy: { issue: { number: 1 } } } } };
      case 'SymphonyAddProjectItem':
        return { body: { data: { addProjectV2ItemById: { item: { id: `PVTI_${variables.contentId}` } } } } };
      case 'SymphonyAddComment':
        return { body: { data: { addComment: { commentEdge: { node: { url: 'https://github.com/acme/app/issues/1#issuecomment-1' } } } } } };
      case 'SymphonyUpdatePullRequest':
        return { body: { data: { updatePullRequest: { pullRequest: { number: 5, url: 'https://github.com/acme/app/pull/5', title: variables.title, baseRefName: 'main' } } } } };
      case 'SymphonyCreatePullRequest':
        return { body: { data: { createPullRequest: { pullRequest: { number: 8, url: 'https://github.com/acme/app/pull/8', title: variables.title, isDraft: false } } } } };
      case 'SymphonyMergeCandidate':
        return { body: { data: { repository: this.mergeCandidate } } };
      case 'SymphonyMergePullRequest':
        return { body: { data: { mergePullRequest: { pullRequest: { number: 7, merged: true } } } } };
      case 'SymphonyCloseIssue':
        return { body: { data: { closeIssue: { issue: { number: 1, state: 'CLOSED' } } } } };
      default:
        return { status: 500, body: { message: `unexpected ${op}` } };
    }
  }
}

function adapter(github: FakeGithub, provider: Json = {}, logger: Logger = Logger.silent()): TrackerAdapter {
  return githubProjectFactory.create({
    provider: { owner: 'acme', project_number: 1, token: 'tok', request_retries: 0, ...provider },
    activeStates: ['Todo', 'In Progress'],
    terminalStates: ['Done'],
    env: {},
    logger,
    fetch: github.fetch,
  });
}

describe('github_project settings', () => {
  it('takes the board owner from the first repository and resolves $VAR references', () => {
    const { settings } = parseSettings(
      { project_number: '$NUM', repositories: '$REPOS', token: '$GITHUB_TOKEN' },
      { NUM: '10', REPOS: 'org/repo-one, org/repo-two', GITHUB_TOKEN: 'ghp_x' },
    );
    assert.equal(settings?.owner, 'org');
    assert.equal(settings?.projectNumber, 10);
    assert.deepEqual([...(settings?.repositories ?? [])], ['org/repo-one', 'org/repo-two']);
    assert.equal(settings?.tokenSource, 'GITHUB_TOKEN');
  });

  it('accepts a project URL, whose owner wins over the repository owner', () => {
    const { settings } = parseSettings({ project_number: 'https://github.com/orgs/my-org/projects/7/', repositories: 'me/app', token: 't' }, {});
    assert.equal(settings?.owner, 'my-org');
    assert.equal(settings?.projectNumber, 7);
  });

  it('treats an unset token variable as a missing secret and an unset optional owner as omitted', () => {
    const result = parseSettings({ project_number: 3, owner: '$GITHUB_PROJECT_OWNER', repositories: 'a/b', token: '$GITHUB_TOKEN' }, {});
    assert.equal(result.category, 'missing_tracker_secret');
    assert.match(result.errors.join(), /GITHUB_TOKEN/);
    assert.equal(parseSettings({ project_number: 3, owner: '$GITHUB_PROJECT_OWNER', repositories: 'a/b' }, { GH_TOKEN: 'x' }).settings?.owner, 'a');
  });

  it('declares the referenced token variable as a secret', () => {
    assert.ok(githubProjectFactory.secretEnvironmentNames({ token: '$MY_GH' }).includes('MY_GH'));
    assert.ok(githubProjectFactory.secretEnvironmentNames({}).includes('GITHUB_TOKEN'));
  });

  it('reports missing required settings', () => {
    assert.match(githubProjectFactory.validate({ token: 't' }, {}).join('; '), /project_number is required.*owner is required/);
  });
});

describe('github_project adapter reads', () => {
  it('returns nothing without a request for empty inputs', async () => {
    const github = new FakeGithub();
    const tracker = adapter(github);
    assert.deepEqual(await tracker.fetchIssuesByStates([]), []);
    assert.deepEqual(await tracker.fetchIssuesByIds([]), []);
    assert.equal(github.requests.length, 0);
  });

  it('lists the status option names of the board', async () => {
    const tracker = adapter(new FakeGithub());
    assert.deepEqual(await tracker.statusOptions?.(), ['Todo', 'In Progress', 'Human Review', 'Done']);
  });

  it('pages through the board, filters by state and scope, and keeps board order', async () => {
    const github = new FakeGithub().add(
      itemNode('A', { status: 'Todo', number: 1, labels: [' Bug ', 'bug', 'UI'] }),
      itemNode('B', { status: 'Done', number: 2 }),
      itemNode('C', { type: 'DraftIssue' }),
      itemNode('D', { status: 'In Progress', number: 4, repo: 'other/repo' }),
      itemNode('E', { status: 'in progress', number: 5 }),
    );
    github.pages = [['A', 'B', 'C'], ['D', 'E']];
    const issues = await adapter(github, { repositories: ['acme/app'] }).fetchIssuesByStates(['Todo', 'In Progress']);
    assert.deepEqual(issues.map((i) => i.identifier), ['acme/app#1', 'acme/app#5']);
    const first = issues[0] as Issue;
    assert.deepEqual(first.labels, ['bug', 'ui']);
    assert.equal(first.id, 'A');
    assert.equal(first.state, 'Todo');
    assert.equal(first.dispatchable, true);
    assert.deepEqual(first.native_ref, { provider: 'github_project', project_id: 'PVT_1', item_id: 'A', issue_id: 'I_A', repository: 'acme/app', number: 1, issue_state: 'OPEN', status_option_id: 'o1', status_updated_at: '2026-09-02T08:30:04.000Z', parent: null, sub_issues: [], base_branch: null, dispatch_note: null, held_by_sub_issues: false });
    assert.equal(first.created_at?.toISOString(), '2026-09-01T10:00:00.000Z');
    assert.equal(github.requests.filter((r) => r.op === 'SymphonyProjectItems').length, 2);
  });

  it('derives dispatchable from issue state, blockers and the assignee filter', async () => {
    const github = new FakeGithub().add(
      itemNode('open', { number: 1 }),
      itemNode('closed', { number: 2, state: 'CLOSED' }),
      itemNode('blocked', { number: 3, blockedBy: [{ state: 'OPEN' }] }),
      itemNode('unblocked', { number: 4, blockedBy: [{ state: 'CLOSED' }] }),
      itemNode('mine', { number: 5, assignees: ['Me'] }),
    );
    const byId = async (provider: Json) => new Map((await adapter(github, provider).fetchIssuesByStates(['Todo'])).map((i) => [i.id, i.dispatchable]));
    assert.deepEqual(Object.fromEntries(await byId({})), { open: true, closed: false, blocked: false, unblocked: true, mine: true });
    const assigned = await byId({ assignee: 'me' });
    assert.equal(assigned.get('mine'), true);
    assert.equal(assigned.get('open'), false);
  });

  it('omits unknown ids and items of other projects, and fails on malformed requested items', async () => {
    const github = new FakeGithub().add(itemNode('A'), itemNode('X', { project: 'PVT_other' }));
    const tracker = adapter(github);
    assert.deepEqual((await tracker.fetchIssuesByIds(['A', 'gone', 'X', 'A'])).map((i) => i.id), ['A']);
    github.add(itemNode('M', { title: '' }));
    await assert.rejects(tracker.fetchIssuesByIds(['M']), (error: unknown) => error instanceof TrackerError && error.category === 'tracker_response');
  });

  it('reports items without a status value as "No Status"', async () => {
    const github = new FakeGithub().add(itemNode('A', { status: null }));
    const issues = await adapter(github).fetchIssuesByStates(['No Status']);
    assert.equal(issues[0]?.state, 'No Status');
  });
});

describe('github_project error mapping', () => {
  const category = async (setup: (github: FakeGithub) => void): Promise<string> => {
    const github = new FakeGithub().add(itemNode('A'));
    setup(github);
    try {
      await adapter(github).fetchIssuesByStates(['Todo']);
      return 'none';
    } catch (error) {
      return error instanceof TrackerError ? error.category : 'other';
    }
  };

  it('maps transport, status, rate-limit, payload and pagination failures', async () => {
    assert.equal(await category((g) => { g.networkError = new TypeError('fetch failed'); }), 'tracker_request');
    assert.equal(await category((g) => g.overrides.set('SymphonyProjectMeta', () => ({ status: 401, body: { message: 'Bad credentials' } }))), 'tracker_status');
    assert.equal(await category((g) => g.overrides.set('SymphonyProjectMeta', () => ({ status: 429, headers: { 'retry-after': '30' }, body: {} }))), 'tracker_rate_limited');
    assert.equal(await category((g) => g.overrides.set('SymphonyProjectMeta', () => ({ status: 403, headers: { 'x-ratelimit-remaining': '0' }, body: {} }))), 'tracker_rate_limited');
    assert.equal(await category((g) => g.overrides.set('SymphonyProjectMeta', () => ({ body: { errors: [{ type: 'INSUFFICIENT_SCOPES', message: 'needs read:project' }] } }))), 'tracker_status');
    assert.equal(await category((g) => g.overrides.set('SymphonyProjectMeta', () => ({ body: 'not json' }))), 'tracker_response');
    assert.equal(
      await category((g) =>
        g.overrides.set('SymphonyProjectItems', () => ({ body: { data: { node: { items: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] } } } } })),
      ),
      'tracker_pagination',
    );
    assert.equal(await category((g) => g.overrides.set('SymphonyProjectMeta', () => ({ body: { data: { repositoryOwner: null } } }))), 'invalid_tracker_config');
  });

  it('retries queries after transient 5xx errors, but never mutations', async () => {
    const github = new FakeGithub().add(itemNode('A'));
    let metaCalls = 0;
    github.overrides.set('SymphonyProjectMeta', () => (++metaCalls === 1 ? { status: 503, body: { message: 'No server is currently available' } } : undefined));
    const tracker = adapter(github, { request_retries: 1 });
    const [issue] = await tracker.fetchIssuesByIds(['A']);
    assert.equal(issue?.id, 'A');
    assert.equal(metaCalls, 2);

    github.overrides.set('SymphonySetStatus', () => ({ status: 503, body: {} }));
    const setStatus = tracker.agentToolSpecs().find((t) => t.name === 'set_status');
    const result = await setStatus?.execute({ status: 'Done' }, { issue: issue as Issue });
    assert.equal(result?.ok, false);
    assert.equal(github.requests.filter((r) => r.op === 'SymphonySetStatus').length, 1);
  });

  it('keeps the retry-after hint on rate-limit errors', async () => {
    const github = new FakeGithub();
    github.overrides.set('SymphonyProjectMeta', () => ({ status: 429, headers: { 'retry-after': '30' }, body: {} }));
    await assert.rejects(adapter(github).fetchIssuesByStates(['Todo']), (error: unknown) => error instanceof TrackerError && error.retryAfterMs === 30_000);
  });
});

describe('github_project dependencies', () => {
  const dispatch = async (github: FakeGithub, provider: Json = {}) =>
    new Map((await adapter(github, provider).fetchIssuesByStates(['Todo'])).map((i) => [i.id, i]));

  it('treats "blocked by #N" in the issue text as a dependency, with its live state', async () => {
    const github = new FakeGithub().add(
      itemNode('open', { number: 1, body: 'Needs the API first.\n\nBlocked by #20' }),
      itemNode('closed', { number: 2, body: 'blocked #21' }),
      itemNode('merged', { number: 3, body: 'blocked by other/lib#7' }),
      itemNode('typo', { number: 4, body: 'blocked by #999' }),
    );
    github.references.set('acme/app#20', 'OPEN').set('acme/app#21', 'CLOSED').set('other/lib#7', 'MERGED');
    const issues = await dispatch(github);
    assert.equal(issues.get('open')?.dispatchable, false);
    assert.deepEqual(issues.get('open')?.blocked_by, [{ id: 'I_acme/app#20', identifier: 'acme/app#20', state: 'OPEN' }]);
    assert.equal(issues.get('open')?.native_ref?.dispatch_note, 'blocked by acme/app#20');
    assert.equal(issues.get('closed')?.dispatchable, true);
    assert.equal(issues.get('merged')?.dispatchable, true);
    assert.equal(issues.get('typo')?.dispatchable, true);
    assert.equal(issues.get('typo')?.blocked_by.length, 0);
    assert.equal(github.requests.filter((r) => r.op === 'SymphonyReferences').length, 1);
  });

  it('does not duplicate a dependency set both as relationship and in text', async () => {
    const github = new FakeGithub().add(itemNode('a', { number: 1, body: 'blocked by #90', blockedBy: [{ state: 'OPEN', number: 90 }] }));
    const issue = (await dispatch(github)).get('a');
    assert.equal(issue?.blocked_by.length, 1);
    assert.equal(github.requests.some((r) => r.op === 'SymphonyReferences'), false);
  });

  it('holds a parent issue back until its sub-issues are closed', async () => {
    const github = new FakeGithub().add(
      itemNode('parent', { number: 1, subIssues: [{ number: 2, state: 'OPEN' }, { number: 3, state: 'CLOSED' }] }),
      itemNode('done', { number: 4, subIssues: [{ number: 5, state: 'CLOSED' }] }),
      itemNode('child', { number: 2, parent: { number: 1, title: 'Parent', state: 'OPEN' } }),
    );
    const issues = await dispatch(github);
    assert.equal(issues.get('parent')?.dispatchable, false);
    assert.equal(issues.get('parent')?.native_ref?.dispatch_note, 'waiting for sub-issues acme/app#2');
    assert.equal(issues.get('done')?.dispatchable, true);
    assert.equal(issues.get('child')?.dispatchable, true);
    assert.deepEqual(issues.get('child')?.native_ref?.parent, { identifier: 'acme/app#1', title: 'Parent', state: 'OPEN', state_reason: null });
    assert.equal((await dispatch(github, { respect_sub_issues: false })).get('parent')?.dispatchable, true);
  });

  it('marks an issue that only its open sub-issues hold back, for the session that filed them (held_by_sub_issues)', async () => {
    const subIssues = [{ number: 2, state: 'OPEN' }];
    const github = new FakeGithub().add(
      itemNode('held', { number: 1, subIssues }),
      itemNode('blocked', { number: 3, subIssues, blockedBy: [{ state: 'OPEN', number: 90 }] }),
      itemNode('closed', { number: 4, subIssues: [{ number: 5, state: 'CLOSED' }] }),
    );
    const issues = await dispatch(github);
    const tracker = adapter(github);
    const held = (id: string) => [issues.get(id)?.dispatchable, issues.get(id)?.native_ref?.held_by_sub_issues, tracker.heldBySubIssues?.(issues.get(id) as Issue)];
    assert.deepEqual(held('held'), [false, true, true]);
    assert.deepEqual(held('blocked'), [false, false, false], 'an open blocker holds it back as well');
    assert.deepEqual(held('closed'), [true, false, false]);
    assert.equal((await dispatch(github, { respect_sub_issues: false })).get('held')?.native_ref?.held_by_sub_issues, false);
  });
});

describe('github_project adapter operations', () => {
  const comment = (n: number, extra: Json = {}): Json => ({
    author: { login: n % 2 === 0 ? 'symphony-bot' : 'alice' },
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, n)).toISOString(),
    url: `https://github.com/acme/app/issues/1#issuecomment-${n}`,
    body: `Comment ${n}`,
    ...extra,
  });

  async function setup(provider: Json = {}, logger?: Logger) {
    const github = new FakeGithub().add(itemNode('A', { number: 1 }));
    const tracker = adapter(github, provider, logger) as Required<TrackerAdapter>;
    const [issue] = await tracker.fetchIssuesByIds(['A']);
    assert.ok(issue);
    const count = (op: string) => github.requests.filter((r) => r.op === op).length;
    return { github, tracker, issue, count };
  }

  describe('readComments', () => {
    it('reads all 250 comments over three pages, each with author and timestamp', async () => {
      const { github, tracker, issue } = await setup();
      github.comments.set('I_A', Array.from({ length: 250 }, (_, i) => comment(i + 1)));
      const comments = await tracker.readComments(issue);
      assert.equal(comments.length, 250);
      assert.deepEqual(comments[0], {
        author: 'alice',
        createdAt: new Date('2026-09-01T00:00:01Z'),
        body: 'Comment 1',
        url: 'https://github.com/acme/app/issues/1#issuecomment-1',
      });
      assert.equal(comments[249]?.body, 'Comment 250');
      assert.equal(comments[249]?.author, 'symphony-bot');
      assert.deepEqual(comments.map((c) => c.body), Array.from({ length: 250 }, (_, i) => `Comment ${i + 1}`));
      assert.ok(comments.every((c) => c.createdAt instanceof Date && !Number.isNaN(c.createdAt.getTime())));
      const pages = github.requests.filter((r) => r.op === 'SymphonyIssueComments');
      assert.deepEqual(pages.map((r) => r.variables), [
        { issueId: 'I_A', after: null },
        { issueId: 'I_A', after: 'c100' },
        { issueId: 'I_A', after: 'c200' },
      ]);
      assert.match(github.lastQuery, /comments\(first: 100, after: \$after\)/);
    });

    it('returns an empty list for an issue without comments and reads a deleted account as a null author', async () => {
      const { github, tracker, issue } = await setup();
      assert.deepEqual(await tracker.readComments(issue), []);
      github.comments.set('I_A', [comment(1, { author: null })]);
      assert.equal((await tracker.readComments(issue))[0]?.author, null);
    });

    it('fails on a page that promises more without a new cursor, and on malformed comments', async () => {
      const { github, tracker, issue } = await setup();
      github.overrides.set('SymphonyIssueComments', () => ({
        body: { data: { node: { comments: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [comment(1)] } } } },
      }));
      await assert.rejects(tracker.readComments(issue), (e: unknown) => e instanceof TrackerError && e.category === 'tracker_pagination');

      github.overrides.set('SymphonyIssueComments', () => ({
        body: { data: { node: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [comment(1, { createdAt: 'yesterday' })] } } } },
      }));
      await assert.rejects(tracker.readComments(issue), (e: unknown) => e instanceof TrackerError && e.category === 'tracker_response');

      github.overrides.set('SymphonyIssueComments', () => ({ body: { data: { node: null } } }));
      await assert.rejects(tracker.readComments(issue), (e: unknown) => e instanceof TrackerError && e.category === 'tracker_response');
    });

    it('needs an issue that comes from the board', async () => {
      const { tracker, issue } = await setup();
      await assert.rejects(tracker.readComments({ ...issue, native_ref: null }), /has no GitHub reference to read comments of/);
    });
  });

  describe('readResults', () => {
    const meta = { role: 'reviewer', run: null, round: 1, profile: null, workflow_hash: null, head_sha: null, checks: null, target: null, created_at: '2026-09-01T00:00:00Z' };
    const marked = renderResultComment(internalResult('reset', 'Reset'), meta);

    it('decodes markers only from comments of the viewer and ignores all others', async () => {
      const { github, tracker, issue } = await setup();
      github.comments.set('I_A', [
        comment(1, { body: marked }), // alice
        comment(2, { body: marked }), // symphony-bot
        comment(3, { author: null, body: marked }),
        comment(4, { body: 'plain comment from the bot' }),
      ]);
      const results = await tracker.readResults(issue);
      assert.equal(results.length, 1);
      assert.equal(results[0]?.result.kind, 'reset');
      assert.equal(results[0]?.url, 'https://github.com/acme/app/issues/1#issuecomment-2');
    });

    it('skips a damaged marker of its own with a warning; the intact ones still count', async () => {
      const lines: string[] = [];
      const logger = Logger.create({ sinks: [{ name: 'memory', write: (line) => lines.push(line) }], level: 'info' });
      const { github, tracker, issue } = await setup({}, logger);
      const payload = /<!-- symphony:result:v1 ([A-Za-z0-9_-]+) -->/.exec(marked)?.[1] ?? '';
      github.comments.set('I_A', [
        comment(2, { body: marked.replace(payload, payload.slice(0, 20)) }), // cut off
        comment(4, { body: marked.replace('result:v1', 'result:v2') }), // unknown version
        comment(6, { body: marked }),
        comment(7, { body: marked.replace(payload, 'garbage') }), // alice: no warning, not trusted anyway
      ]);
      const results = await tracker.readResults(issue);
      assert.deepEqual(results.map((result) => result.url), ['https://github.com/acme/app/issues/1#issuecomment-6']);
      const warnings = lines.filter((line) => line.includes('msg="ignoring a damaged result marker"'));
      assert.equal(warnings.length, 2);
      assert.match(warnings[0] ?? '', /issuecomment-2/);
      assert.match(warnings[1] ?? '', /issuecomment-4/);
    });
  });

  describe('viewerLogin', () => {
    it('asks GitHub once per adapter and retries after a failure', async () => {
      const { github, tracker, count } = await setup();
      github.overrides.set('SymphonyViewer', () => ({ status: 500, body: {} }));
      await assert.rejects(tracker.viewerLogin(), TrackerError);
      github.overrides.delete('SymphonyViewer');
      assert.equal(await tracker.viewerLogin(), 'symphony-bot');
      assert.equal(await tracker.viewerLogin(), 'symphony-bot');
      assert.equal(count('SymphonyViewer'), 2);
    });

    it('rejects a response without a login', async () => {
      const { github, tracker } = await setup();
      github.overrides.set('SymphonyViewer', () => ({ body: { data: { viewer: null } } }));
      await assert.rejects(tracker.viewerLogin(), (e: unknown) => e instanceof TrackerError && e.category === 'tracker_response');
    });
  });

  describe('postComment', () => {
    it('posts the body on the issue and returns the comment URL', async () => {
      const { github, tracker, issue } = await setup();
      assert.deepEqual(await tracker.postComment(issue, 'Stage result'), { url: 'https://github.com/acme/app/issues/1#issuecomment-1' });
      assert.deepEqual(github.requests.at(-1), { op: 'SymphonyAddComment', variables: { subjectId: 'I_A', body: 'Stage result' } });
    });

    it('is what the add_comment tool and commentOnIssue use', async () => {
      const { github, tracker, issue } = await setup();
      const addComment = tracker.agentToolSpecs().find((t) => t.name === 'add_comment');
      assert.deepEqual(await addComment?.execute({ body: 'From the agent' }, { issue }), {
        ok: true,
        data: { url: 'https://github.com/acme/app/issues/1#issuecomment-1' },
      });
      await tracker.commentOnIssue(issue, 'From Symphony');
      assert.deepEqual(github.requests.filter((r) => r.op === 'SymphonyAddComment').map((r) => r.variables.body), ['From the agent', 'From Symphony']);
      await assert.rejects(tracker.commentOnIssue({ ...issue, native_ref: null }, 'x'), /has no GitHub reference to comment on/);
    });
  });

  describe('markers in agent text', () => {
    it('add_comment rejects a result marker and still posts normal comments', async () => {
      const { github, tracker, issue } = await setup();
      const addComment = tracker.agentToolSpecs().find((t) => t.name === 'add_comment');
      for (const body of ['<!-- symphony:result:v1 abc -->', 'text <!--symphony:x', '<!--   SYMPHONY:result']) {
        const result = await addComment?.execute({ body }, { issue });
        assert.equal(result?.ok, false);
        assert.equal(result?.ok === false && result.error.category, 'invalid_argument');
      }
      assert.equal(github.requests.filter((r) => r.op === 'SymphonyAddComment').length, 0);
      assert.equal((await addComment?.execute({ body: 'a <!-- note --> b' }, { issue }))?.ok, true);
    });
  });

  describe('labels', () => {
    it('creates a missing "Type: …" label and adds it; other unknown labels are neither created nor added', async () => {
      const { github, tracker, issue, count } = await setup();
      github.labels.set('complexity: m', 'L_existing');
      const result = await tracker.addLabels(issue, ['Type: feature', 'Complexity: M', 'wontfix', 'Type:', 'Epic: x', 'type: FEATURE'], { create: true });
      assert.deepEqual(result, { added: ['Type: feature', 'Complexity: M'], created: ['Type: feature'], unknown: ['wontfix', 'Type:', 'Epic: x'] });
      assert.equal(count('SymphonyCreateLabel'), 1);
      const create = github.requests.find((r) => r.op === 'SymphonyCreateLabel');
      assert.deepEqual(create?.variables, { repositoryId: 'R_1', name: 'Type: feature', color: '7f7fff', description: 'This issue is a feature' });
      const add = github.requests.find((r) => r.op === 'SymphonyAddLabels');
      assert.deepEqual(add?.variables, { labelableId: 'I_A', labelIds: ['L_2', 'L_existing'] });
      const lookup = github.requests.find((r) => r.op === 'SymphonyLabels');
      assert.deepEqual(lookup?.variables, { owner: 'acme', name: 'app', l0: 'Type: feature', l1: 'Complexity: M', l2: 'wontfix', l3: 'Type:', l4: 'Epic: x' });
    });

    it('creates the Complexity and needs-human families, with a plain color for names outside the standard set', async () => {
      const { github, tracker, issue } = await setup();
      const result = await tracker.addLabels(issue, ['needs-human', 'Complexity: XL', 'Type: spike'], { create: true });
      assert.deepEqual(result.created, ['needs-human', 'Complexity: XL', 'Type: spike']);
      const created = github.requests.filter((r) => r.op === 'SymphonyCreateLabel').map((r) => r.variables);
      assert.deepEqual(created.map((v) => v.name), ['needs-human', 'Complexity: XL', 'Type: spike']);
      assert.deepEqual(created.map((v) => v.color), ['ff0000', 'ff6347', 'ededed']);
      assert.equal(created[2]?.description, null);
    });

    it('creates nothing without create, and adds the labels that exist', async () => {
      const { github, tracker, issue, count } = await setup();
      github.labels.set('bug', 'L_bug');
      const result = await tracker.addLabels(issue, ['bug', 'Type: feature']);
      assert.deepEqual(result, { added: ['bug'], created: [], unknown: ['Type: feature'] });
      assert.equal(count('SymphonyCreateLabel'), 0);
      assert.deepEqual(github.requests.find((r) => r.op === 'SymphonyAddLabels')?.variables, { labelableId: 'I_A', labelIds: ['L_bug'] });

      github.requests.length = 0;
      assert.deepEqual(await tracker.addLabels(issue, ['nothing']), { added: [], created: [], unknown: ['nothing'] });
      assert.equal(count('SymphonyAddLabels'), 0);
    });

    it('sends nothing for an empty list and drops duplicates (label names are case-insensitive)', async () => {
      const { github, tracker, issue, count } = await setup();
      assert.deepEqual(await tracker.addLabels(issue, ['', '  '], { create: true }), { added: [], created: [], unknown: [] });
      assert.deepEqual(await tracker.removeLabels(issue, []), { removed: [], unknown: [] });
      assert.equal(github.requests.some((r) => r.op === 'SymphonyLabels'), false);

      const result = await tracker.addLabels(issue, ['Type: bugfix', 'type: BUGFIX', ' Type: bugfix '], { create: true });
      assert.deepEqual(result.created, ['Type: bugfix']);
      assert.equal(count('SymphonyCreateLabel'), 1);
    });

    it('uses the label a concurrent writer created between lookup and creation', async () => {
      const { github, tracker, issue } = await setup();
      let lookups = 0;
      github.overrides.set('SymphonyLabels', () => {
        if (++lookups === 2) github.labels.set('type: feature', 'L_theirs');
        return undefined;
      });
      github.overrides.set('SymphonyCreateLabel', () => {
        github.labels.set('type: feature', 'L_theirs');
        return { body: { data: null, errors: [{ type: 'UNPROCESSABLE', message: 'Name has already been taken', path: ['createLabel'] }] } };
      });
      const result = await tracker.addLabels(issue, ['Type: feature'], { create: true });
      assert.deepEqual(result.added, ['Type: feature']);
      assert.deepEqual(github.requests.find((r) => r.op === 'SymphonyAddLabels')?.variables, { labelableId: 'I_A', labelIds: ['L_theirs'] });
    });

    it('removes existing labels by id and reports the ones the repository does not have', async () => {
      const { github, tracker, issue, count } = await setup();
      github.labels.set('needs-human', 'L_nh');
      github.labelSpelling.set('needs-human', 'needs-human');
      const result = await tracker.removeLabels(issue, ['Needs-Human', 'ghost']);
      assert.deepEqual(result, { removed: ['needs-human'], unknown: ['ghost'] });
      assert.deepEqual(github.requests.find((r) => r.op === 'SymphonyRemoveLabels')?.variables, { labelableId: 'I_A', labelIds: ['L_nh'] });

      github.requests.length = 0;
      assert.deepEqual(await tracker.removeLabels(issue, ['ghost']), { removed: [], unknown: ['ghost'] });
      assert.equal(count('SymphonyRemoveLabels'), 0);
    });

    it('fails when the repository cannot be read', async () => {
      const { github, tracker, issue } = await setup();
      github.overrides.set('SymphonyLabels', () => ({ body: { data: { repository: null } } }));
      await assert.rejects(tracker.addLabels(issue, ['bug']), (e: unknown) => e instanceof TrackerError && e.category === 'tracker_response');
    });
  });

  it('never retries a mutation, even with retries configured', async () => {
    const { github, tracker, issue, count } = await setup({ request_retries: 2 });
    github.labels.set('bug', 'L_bug');
    for (const [op, run] of [
      ['SymphonyAddComment', () => tracker.postComment(issue, 'x')],
      ['SymphonyCreateLabel', () => tracker.addLabels(issue, ['Type: feature'], { create: true })],
      ['SymphonyAddLabels', () => tracker.addLabels(issue, ['bug'])],
      ['SymphonyRemoveLabels', () => tracker.removeLabels(issue, ['bug'])],
      ['SymphonySetStatus', () => tracker.setStatus(issue, 'Done')],
    ] as const) {
      github.overrides.set(op, () => ({ status: 503, body: {} }));
      await assert.rejects(run(), (e: unknown) => e instanceof TrackerError && e.status === 503, op);
      assert.equal(count(op), 1, op);
    }
  });

  describe('setStatus', () => {
    it('moves the board item by column name and reports the previous column of the snapshot', async () => {
      const { github, tracker, issue } = await setup();
      assert.deepEqual(await tracker.setStatus(issue, 'human review'), { previous: 'Todo', status: 'Human Review' });
      assert.deepEqual(github.requests.find((r) => r.op === 'SymphonySetStatus')?.variables, {
        projectId: 'PVT_1',
        itemId: 'A',
        fieldId: 'F_status',
        optionId: 'o3',
      });
    });

    it('rejects an unknown column as invalid_argument, naming the valid ones, without a mutation', async () => {
      const { github, tracker, issue } = await setup();
      await assert.rejects(tracker.setStatus(issue, 'Shipped'), (e: unknown) => {
        assert.ok(e instanceof TrackerError);
        assert.equal(e.category, 'invalid_argument');
        assert.match(e.message, /unknown status "Shipped"; valid options: "Todo", "In Progress", "Human Review", "Done"/);
        return true;
      });
      assert.equal(github.requests.some((r) => r.op === 'SymphonySetStatus'), false);
    });

    it('needs an issue that comes from the board', async () => {
      const { tracker, issue } = await setup();
      await assert.rejects(tracker.setStatus({ ...issue, native_ref: null }, 'Done'), /has no GitHub reference to move/);
    });
  });
});

describe('github_project agent tools', () => {
  it('moves the issue to a status chosen by name, case-insensitively', async () => {
    const github = new FakeGithub().add(itemNode('A'));
    const tracker = adapter(github);
    const [issue] = await tracker.fetchIssuesByIds(['A']);
    const setStatus = tracker.agentToolSpecs().find((t) => t.name === 'set_status');
    const ok = await setStatus?.execute({ status: 'human review' }, { issue: issue as Issue });
    assert.deepEqual(ok, { ok: true, data: { previous_status: 'Todo', status: 'Human Review' } });
    const mutation = github.requests.find((r) => r.op === 'SymphonySetStatus');
    assert.deepEqual(mutation?.variables, { projectId: 'PVT_1', itemId: 'A', fieldId: 'F_status', optionId: 'o3' });

    const bad = await setStatus?.execute({ status: 'Shipped' }, { issue: issue as Issue });
    assert.equal(bad?.ok, false);
    assert.match(bad?.ok === false ? bad.error.message : '', /valid options: "Todo", "In Progress", "Human Review", "Done"/);
  });

  it('sends no mutation when the transition guard denies set_status', async () => {
    const github = new FakeGithub().add(itemNode('A'));
    const tracker = adapter(github);
    const [issue] = await tracker.fetchIssuesByIds(['A']);
    const guard = createGuard({
      role: null,
      config: { tracker: { terminalStates: ['Done'] } as ServiceConfig['tracker'], roles: null, checks: { timeoutMs: 1_000, retries: 0, onEnter: new Map() } },
      workspace: { path: '/nonexistent', key: 'A', createdNow: false },
      issue: () => ({ id: 'A', identifier: 'acme/app#1' }),
      manager: { runScript: () => Promise.reject(new Error('no check expected')) },
      signal: new AbortController().signal,
    });
    const setStatus = guardTools(tracker.agentToolSpecs(), guard).find((t) => t.name === 'set_status');
    const denied = await setStatus?.execute({ status: 'done' }, { issue: issue as Issue });
    assert.equal(denied?.ok === false ? denied.error.category : null, 'transition_denied');
    assert.equal(github.requests.some((r) => r.op === 'SymphonySetStatus'), false);

    const moved = await setStatus?.execute({ status: 'Human Review' }, { issue: issue as Issue });
    assert.equal(moved?.ok, true);
    assert.equal(github.requests.filter((r) => r.op === 'SymphonySetStatus').length, 1);
  });

  it('returns the open pull request for a branch instead of creating a duplicate', async () => {
    const github = new FakeGithub().add(itemNode('A'));
    const tracker = adapter(github);
    const [issue] = await tracker.fetchIssuesByIds(['A']);
    const open = tracker.agentToolSpecs().find((t) => t.name === 'open_pull_request');
    const result = await open?.execute({ head: 'symphony/issue-1', title: 'Fix' }, { issue: issue as Issue });
    assert.deepEqual(result, { ok: true, data: { created: false, updated: false, number: 5, url: 'https://github.com/acme/app/pull/5', title: 'Existing', base: 'main' } });
    assert.equal(github.requests.some((r) => r.op === 'SymphonyCreatePullRequest'), false);
    assert.equal(github.requests.some((r) => r.op === 'SymphonyUpdatePullRequest'), false);
  });

  it('updates the title and description of the open pull request when called again with a body', async () => {
    const github = new FakeGithub().add(itemNode('A'));
    const tracker = adapter(github);
    const [issue] = await tracker.fetchIssuesByIds(['A']);
    const open = tracker.agentToolSpecs().find((t) => t.name === 'open_pull_request');
    assert.match(open?.description ?? '', /refresh the description/);
    const body = 'Closes #1\n\n![Screenshot](https://example.com/shot.png)';
    const result = await open?.execute({ head: 'symphony/issue-1', title: 'Fix login', body }, { issue: issue as Issue });
    assert.deepEqual(result, { ok: true, data: { created: false, updated: true, number: 5, url: 'https://github.com/acme/app/pull/5', title: 'Fix login', base: 'main' } });
    assert.deepEqual(
      github.requests.filter((r) => r.op === 'SymphonyUpdatePullRequest').map((r) => r.variables),
      [{ pullRequestId: 'PR_5', title: 'Fix login', body }],
    );
    assert.equal(github.requests.some((r) => r.op === 'SymphonyCreatePullRequest'), false);
  });

  it('reports a failed pull request update to the agent', async () => {
    const github = new FakeGithub().add(itemNode('A'));
    github.overrides.set('SymphonyUpdatePullRequest', () => ({ body: { data: null, errors: [{ message: 'Resource not accessible by integration' }] } }));
    const tracker = adapter(github);
    const [issue] = await tracker.fetchIssuesByIds(['A']);
    const open = tracker.agentToolSpecs().find((t) => t.name === 'open_pull_request');
    const result = await open?.execute({ head: 'symphony/issue-1', title: 'Fix', body: 'New body' }, { issue: issue as Issue });
    assert.deepEqual(result, { ok: false, error: { category: 'github_error', message: 'Resource not accessible by integration' } });
  });

  it('exposes the issue repository to hooks', async () => {
    const github = new FakeGithub().add(itemNode('A', { repo: 'acme/app', number: 12 }));
    const tracker = adapter(github);
    const [issue] = await tracker.fetchIssuesByIds(['A']);
    assert.deepEqual(tracker.hookEnvironment?.(issue as Issue), { SYMPHONY_ISSUE_REPOSITORY: 'acme/app', SYMPHONY_ISSUE_NUMBER: '12' });
  });
});

describe('github_project create_sub_issue', () => {
  // The fake board has no "Backlog" column, so the tests use one of its columns as the sub-issue status.
  const COLUMN = { sub_issue_status: 'Human Review' };

  async function setup(provider: Json = COLUMN, front: Json = {}) {
    const github = new FakeGithub().add(itemNode('A', { number: 1, ...front }));
    github.labels.set('bug', 'L_bug');
    const tracker = adapter(github, provider);
    const [issue] = await tracker.fetchIssuesByIds(['A']);
    const tool = tracker.agentToolSpecs().find((t) => t.name === 'create_sub_issue');
    assert.ok(tool);
    /** `max` is the role's max_sub_issues; null runs the tool for a role that has none. */
    const run = (args: Json, max: number | null = 5) =>
      tool.execute(args, { issue: issue as Issue, ...(max !== null ? { maxSubIssues: max } : {}) });
    const ops = (op: string) => github.requests.filter((r) => r.op === op);
    return { github, tracker, tool, run, ops };
  }

  /** The data of a successful tool result. */
  const dataOf = (result: ToolResult): Json => {
    assert.equal(result.ok, true);
    return (result as { ok: true; data: Json }).data;
  };

  it('rejects a result marker in the body or title and creates normal issues', async () => {
    const { run, ops } = await setup();
    for (const args of [{ title: 'T', body: 'x\n<!-- symphony:result:v1 abc -->' }, { title: '<!-- symphony:x -->' }]) {
      const result = await run(args);
      assert.equal(result.ok === false && result.error.category, 'invalid_argument');
    }
    assert.equal(ops('SymphonyCreateSubIssue').length, 0);
    assert.equal((await run({ title: 'T', body: '<!-- plain -->' })).ok, true);
  });

  it('creates the issue under its parent, labels it and puts it on the board in the configured column', async () => {
    const { run, ops } = await setup();
    const result = await run({ title: '  Tests: invoices  ', body: 'Details', labels: ['bug', 'nope'] });
    assert.deepEqual(result, {
      ok: true,
      data: {
        created: true,
        number: 100,
        identifier: 'acme/app#100',
        url: 'https://github.com/acme/app/issues/100',
        status: 'Human Review',
        on_board: true,
        unknown_labels: ['nope'],
        remaining: 4,
      },
    });
    assert.deepEqual(ops('SymphonyCreateSubIssue')[0]?.variables, {
      repositoryId: 'R_1',
      parentId: 'I_A',
      title: 'Tests: invoices',
      body: 'Details',
      labelIds: ['L_bug'],
    });
    assert.deepEqual(ops('SymphonyAddProjectItem')[0]?.variables, { projectId: 'PVT_1', contentId: 'I_new100' });
    assert.deepEqual(ops('SymphonySetStatus')[0]?.variables, { projectId: 'PVT_1', itemId: 'PVTI_I_new100', fieldId: 'F_status', optionId: 'o3' });
  });

  it('skips the label lookup without labels and sends no body as null', async () => {
    const { run, ops } = await setup();
    assert.equal((await run({ title: 'Plain' })).ok, true);
    assert.equal(ops('SymphonyLabels').length, 0);
    assert.deepEqual(ops('SymphonyCreateSubIssue')[0]?.variables, { repositoryId: 'R_1', parentId: 'I_A', title: 'Plain', body: null, labelIds: [] });
  });

  it('returns the open sub-issue with the same title instead of creating one', async () => {
    const { github, run, ops } = await setup();
    const onBoard = { id: 'PVTI_old', project: { id: 'PVT_1' } };
    github.subIssues.set('I_A', [{ id: 'I_old', number: 7, title: 'Tests:   Invoices', state: 'OPEN', url: 'https://github.com/acme/app/issues/7', projectItems: { nodes: [onBoard] } }]);
    const result = await run({ title: 'tests: invoices' });
    assert.equal(dataOf(result).created, false);
    assert.equal(dataOf(result).number, 7);
    assert.equal(dataOf(result).remaining, 4);
    assert.equal(ops('SymphonyCreateSubIssue').length, 0);
    // Already on the board: a human may have moved it, so neither a second item nor a status change.
    assert.equal(ops('SymphonyAddProjectItem').length, 0);
    assert.equal(ops('SymphonySetStatus').length, 0);
  });

  it('repairs a sub-issue that never made it onto the board', async () => {
    const { github, run, ops } = await setup();
    github.subIssues.set('I_A', [{ id: 'I_old', number: 7, title: 'Orphan', state: 'OPEN', url: 'u', projectItems: { nodes: [{ id: 'X', project: { id: 'PVT_other' } }] } }]);
    const result = await run({ title: 'Orphan' });
    assert.equal(dataOf(result).created, false);
    assert.deepEqual(ops('SymphonyAddProjectItem')[0]?.variables, { projectId: 'PVT_1', contentId: 'I_old' });
    assert.equal(ops('SymphonySetStatus')[0]?.variables.optionId, 'o3');
  });

  it('creates a new issue when the sub-issue with that title is closed', async () => {
    const { github, run, ops } = await setup();
    github.subIssues.set('I_A', [{ id: 'I_old', number: 7, title: 'Done thing', state: 'CLOSED', url: 'u', projectItems: { nodes: [] } }]);
    const result = await run({ title: 'Done thing' });
    assert.equal(dataOf(result).created, true);
    assert.equal(ops('SymphonyCreateSubIssue').length, 1);
  });

  it('creates exactly one issue for parallel calls with the same title', async () => {
    const { run, ops } = await setup();
    const results = await Promise.all([run({ title: 'Same' }), run({ title: 'same ' }), run({ title: 'Same' })]);
    assert.deepEqual(results.map((r) => dataOf(r).created), [true, false, false]);
    assert.equal(ops('SymphonyCreateSubIssue').length, 1);
  });

  it('refuses beyond max_sub_issues, counting only open sub-issues', async () => {
    const { github, run, ops } = await setup();
    github.subIssues.set('I_A', [
      { id: 'I_1', number: 7, title: 'One', state: 'OPEN', url: 'u', projectItems: { nodes: [] } },
      { id: 'I_2', number: 8, title: 'Two', state: 'CLOSED', url: 'u', projectItems: { nodes: [] } },
    ]);
    assert.equal((await run({ title: 'Three' }, 2)).ok, true);
    const refused = await run({ title: 'Four' }, 2);
    assert.equal(refused.ok === false ? refused.error.category : null, 'limit_reached');
    assert.equal(ops('SymphonyCreateSubIssue').length, 1);
  });

  it('is not allowed without a limit in the context', async () => {
    const { run, github } = await setup();
    const result = await run({ title: 'Nope' }, null);
    assert.equal(result.ok === false ? result.error.category : null, 'not_allowed');
    assert.equal(github.requests.some((r) => r.op === 'SymphonySubIssueContext'), false);
  });

  it('reports GitHub errors from creating the issue', async () => {
    const { github, run, ops } = await setup();
    github.overrides.set('SymphonyCreateSubIssue', () => ({ body: { data: null, errors: [{ type: 'FORBIDDEN', message: 'no permission', path: ['createIssue'] }] } }));
    const result = await run({ title: 'X' });
    assert.equal(result.ok === false ? result.error.category : null, 'github_error');
    assert.equal(ops('SymphonyAddProjectItem').length, 0);
  });

  it('keeps the created issue and warns when the board step fails', async () => {
    const { github, run, ops } = await setup();
    github.overrides.set('SymphonyAddProjectItem', () => ({ body: { data: null, errors: [{ type: 'FORBIDDEN', message: 'project is read-only', path: ['addProjectV2ItemById'] }] } }));
    const result = await run({ title: 'X' });
    assert.equal(result.ok, true);
    assert.equal(dataOf(result).created, true);
    assert.equal(dataOf(result).on_board, false);
    assert.match(String((dataOf(result).warnings as string[])[0]), /could not put the issue on the board: .*project is read-only/);
    assert.equal(ops('SymphonySetStatus').length, 0);
  });

  it('warns when the configured column is not on the board and leaves the item without a status', async () => {
    const { run, ops } = await setup({});
    const result = await run({ title: 'X' });
    assert.equal(result.ok, true);
    assert.equal(dataOf(result).status, null);
    assert.match(String((dataOf(result).warnings as string[])[0]), /board column "Backlog" does not exist \(valid: "Todo"/);
    assert.equal(ops('SymphonyAddProjectItem').length, 1);
    assert.equal(ops('SymphonySetStatus').length, 0);
  });

  it('marks the tool as sub-issue creating and names the target column', async () => {
    const { tool } = await setup();
    assert.equal(tool.createsSubIssues, true);
    assert.equal(tool.mutates, true);
    assert.match(tool.description, /column "Human Review"/);
  });

  describe('under an epic (parent)', () => {
    const epic = (number: number, extra: Json = {}): Json => ({ id: `I_epic${number}`, number, title: `Epic ${number}`, state: 'OPEN', url: 'u', projectItems: { nodes: [] }, ...extra });

    it('creates the issue one level deeper and counts the whole tree for remaining', async () => {
      const { github, run, ops } = await setup();
      github.subIssues.set('I_A', [epic(7)]);
      const result = await run({ title: 'Feature: invoices', parent: 7 });
      assert.equal(dataOf(result).created, true);
      assert.equal(dataOf(result).parent, 7);
      assert.equal(dataOf(result).remaining, 3); // max 5, the epic and the new issue
      assert.equal(ops('SymphonyCreateSubIssue')[0]?.variables.parentId, 'I_epic7');
      assert.equal(github.subIssues.get('I_epic7')?.length, 1);
      assert.equal(github.subIssues.get('I_A')?.length, 1, 'the root still has only the epic');
    });

    it('finds a duplicate among the issues of the same epic only', async () => {
      const { github, run, ops } = await setup();
      github.subIssues.set('I_A', [epic(7), epic(9)]);
      github.subIssues.set('I_epic7', [{ id: 'I_c', number: 8, title: 'Same', state: 'OPEN', url: 'u', projectItems: { nodes: [] } }]);
      const again = await run({ title: 'same', parent: 7 });
      assert.deepEqual([dataOf(again).created, dataOf(again).number], [false, 8]);
      const other = await run({ title: 'Same', parent: 9 });
      assert.equal(dataOf(other).created, true);
      assert.equal(ops('SymphonyCreateSubIssue').length, 1);
    });

    it('refuses a parent that is not an open sub-issue of the session issue, without a mutation', async () => {
      const { github, run, ops } = await setup();
      github.subIssues.set('I_A', [epic(7, { state: 'CLOSED' })]);
      for (const parent of [7, 99]) {
        const result = await run({ title: 'X', parent });
        assert.equal(result.ok === false ? result.error.category : null, 'invalid_argument', String(parent));
      }
      assert.equal(ops('SymphonyCreateSubIssue').length, 0);
    });

    it('counts the open sub-issues of the sub-issues against max_sub_issues', async () => {
      const { github, run } = await setup();
      const grandchildren = { nodes: [{ state: 'OPEN' }, { state: 'OPEN' }, { state: 'CLOSED' }] };
      github.subIssues.set('I_A', [epic(7, { subIssues: grandchildren })]);
      const refused = await run({ title: 'Y', parent: 7 }, 3); // the epic and two open issues
      assert.equal(refused.ok === false ? refused.error.category : null, 'limit_reached');
      const allowed = await run({ title: 'Y', parent: 7 }, 4);
      assert.equal(dataOf(allowed).remaining, 0);
    });
  });

  describe('blocked_by', () => {
    it('sets the relationships of a new issue, once per blocker', async () => {
      const { github, run, ops } = await setup();
      github.references.set('acme/app#7', 'OPEN');
      github.references.set('acme/app#8', 'CLOSED');
      const result = await run({ title: 'Feature: B', blocked_by: [7, 8, 7] });
      assert.equal(dataOf(result).created, true);
      assert.deepEqual([dataOf(result).blocked_by, dataOf(result).unknown_blockers], [[7, 8], []]);
      assert.deepEqual(
        ops('SymphonyAddBlockedBy').map((r) => r.variables),
        [
          { issueId: 'I_new100', blockingIssueId: 'I_acme/app#7' },
          { issueId: 'I_new100', blockingIssueId: 'I_acme/app#8' },
        ],
      );
    });

    it('reports numbers that are no issue and skips itself and relationships that exist', async () => {
      const { github, run, ops } = await setup();
      github.references.set('acme/app#7', 'OPEN');
      github.references.set('acme/app#9', 'OPEN');
      github.pullRequests.add('acme/app#9');
      github.subIssues.set('I_A', [{ id: 'I_old', number: 20, title: 'Existing', state: 'OPEN', url: 'u', projectItems: { nodes: [] }, blockedBy: { nodes: [{ number: 7 }] } }]);
      const result = await run({ title: 'Existing', blocked_by: [7, 9, 50, 20] });
      assert.equal(dataOf(result).created, false);
      assert.deepEqual([dataOf(result).blocked_by, dataOf(result).unknown_blockers], [[7], [9, 50]]);
      assert.equal(ops('SymphonyAddBlockedBy').length, 0);
    });

    it('sets the blockers an earlier call missed when it finds the issue again', async () => {
      const { github, run, ops } = await setup();
      github.references.set('acme/app#7', 'OPEN');
      github.subIssues.set('I_A', [{ id: 'I_old', number: 20, title: 'Retry', state: 'OPEN', url: 'u', projectItems: { nodes: [] } }]);
      await run({ title: 'Retry', blocked_by: [7] });
      assert.deepEqual(ops('SymphonyAddBlockedBy')[0]?.variables, { issueId: 'I_old', blockingIssueId: 'I_acme/app#7' });
    });

    it('keeps the created issue and warns when a relationship cannot be set', async () => {
      const { github, run } = await setup();
      github.references.set('acme/app#7', 'OPEN');
      github.overrides.set('SymphonyAddBlockedBy', () => ({ body: { data: null, errors: [{ type: 'FORBIDDEN', message: 'no permission', path: ['addBlockedBy'] }] } }));
      const result = await run({ title: 'W', blocked_by: [7] });
      assert.equal(dataOf(result).created, true);
      assert.deepEqual(dataOf(result).blocked_by, []);
      assert.match(String((dataOf(result).warnings as string[])[0]), /could not set "blocked by #7": .*no permission/);
    });

    it('adds neither parent nor blocked_by to the result of a plain call', async () => {
      const { run } = await setup();
      const data = dataOf(await run({ title: 'Plain' }));
      assert.equal('parent' in data || 'blocked_by' in data || 'unknown_blockers' in data, false);
    });
  });

  it('rejects a sub_issue_status that is an active or terminal column', () => {
    const github = new FakeGithub();
    assert.throws(() => adapter(github, { sub_issue_status: 'todo' }), /sub_issue_status "todo" must not be an active or terminal state/);
    assert.throws(() => adapter(github, { sub_issue_status: 'Done' }), /must not be an active or terminal state/);
    assert.doesNotThrow(() => adapter(github, { sub_issue_status: 'Backlog' }));
    assert.equal(parseSettings({ owner: 'acme', project_number: 1, token: 't' }, {}).settings?.subIssueStatus, 'Backlog');
  });

  it('does not hold back an issue that starts with a command for its open sub-issues', async () => {
    const subIssues = [{ number: 2, state: 'OPEN' }];
    const github = new FakeGithub().add(
      itemNode('audit', { number: 1, body: '/refactoring app/Filament\n\nScope: the panel', subIssues }),
      itemNode('plain', { number: 3, body: 'Needs the children first.', subIssues }),
    );
    const issues = new Map((await adapter(github).fetchIssuesByStates(['Todo'])).map((i) => [i.id, i]));
    assert.equal(issues.get('audit')?.dispatchable, true);
    assert.equal(issues.get('plain')?.dispatchable, false);
  });
});

describe('github_project base branch and waves', () => {
  it('reads base_branch, exposes it to hooks and the prompt, and leaves both out without it', async () => {
    const github = new FakeGithub().add(itemNode('A', { repo: 'acme/app', number: 12 }));
    const unset = adapter(github, { base_branch: '$BASE' });
    assert.equal(parseSettings({ owner: 'acme', project_number: 1, token: 't', base_branch: '$BASE' }, { BASE: 'develop' }).settings?.baseBranch, 'develop');
    assert.equal(parseSettings({ owner: 'acme', project_number: 1, token: 't', base_branch: '${BASE:-}' }, {}).settings?.baseBranch, null);
    const [issue] = await adapter(github, { base_branch: 'develop' }).fetchIssuesByIds(['A']);
    assert.equal(issue?.native_ref?.base_branch, 'develop');
    assert.deepEqual(adapter(github, { base_branch: 'develop' }).hookEnvironment?.(issue as Issue), {
      SYMPHONY_ISSUE_REPOSITORY: 'acme/app',
      SYMPHONY_ISSUE_NUMBER: '12',
      SYMPHONY_BASE_BRANCH: 'develop',
    });
    const [plain] = await unset.fetchIssuesByIds(['A']);
    assert.equal(plain?.native_ref?.base_branch, null);
    assert.equal('SYMPHONY_BASE_BRANCH' in (unset.hookEnvironment?.(plain as Issue) ?? {}), false);
  });

  it('opens pull requests against base_branch unless the agent names a base', async () => {
    const github = new FakeGithub().add(itemNode('A'));
    github.overrides.set('SymphonyRepository', () => ({
      body: { data: { repository: { id: 'R_1', defaultBranchRef: { name: 'main' }, pullRequests: { nodes: [] } } } },
    }));
    const tracker = adapter(github, { base_branch: 'develop' });
    const [issue] = await tracker.fetchIssuesByIds(['A']);
    const open = tracker.agentToolSpecs().find((t) => t.name === 'open_pull_request');
    assert.match(open?.description ?? '', /Without base, it targets "develop"/);
    const toDevelop = await open?.execute({ head: 'symphony/issue-1', title: 'Fix' }, { issue: issue as Issue });
    assert.equal(toDevelop?.ok === true && (toDevelop.data as Json).base, 'develop');
    const release = await open?.execute({ head: 'develop', base: 'main', title: 'Release' }, { issue: issue as Issue });
    assert.equal(release?.ok === true && (release.data as Json).base, 'main');
    assert.deepEqual(github.requests.filter((r) => r.op === 'SymphonyCreatePullRequest').map((r) => r.variables.base), ['develop', 'main']);
  });

  it('reports open sub-issues and why closed ones were closed', async () => {
    const github = new FakeGithub().add(
      itemNode('epic', {
        number: 1,
        body: '/auto-code',
        subIssues: [
          { number: 2, state: 'OPEN' },
          { number: 3, state: 'CLOSED', stateReason: 'NOT_PLANNED' },
          { number: 4, state: 'CLOSED', stateReason: 'COMPLETED' },
        ],
      }),
    );
    const tracker = adapter(github);
    const [epic] = await tracker.fetchIssuesByIds(['epic']);
    assert.deepEqual(tracker.openSubIssues?.(epic as Issue), ['acme/app#2']);
    assert.deepEqual(epic?.native_ref?.sub_issues, [
      { identifier: 'acme/app#2', title: 'Sub 2', state: 'OPEN', state_reason: null },
      { identifier: 'acme/app#3', title: 'Sub 3', state: 'CLOSED', state_reason: 'NOT_PLANNED' },
      { identifier: 'acme/app#4', title: 'Sub 4', state: 'CLOSED', state_reason: 'COMPLETED' },
    ]);
    // The command keeps the epic dispatchable for the adapter; the role's wait_for_sub_issues holds it back.
    assert.equal(epic?.dispatchable, true);
    assert.match(github.lastQuery, /subIssues\(first: 100\) \{ nodes \{ number title state stateReason/);
  });

  it('puts sub-issues in the column the role names instead of the provider default', async () => {
    const github = new FakeGithub().add(itemNode('A', { number: 1 }));
    const tracker = adapter(github, { sub_issue_status: 'Human Review' });
    const [issue] = await tracker.fetchIssuesByIds(['A']);
    const tool = tracker.agentToolSpecs().find((t) => t.name === 'create_sub_issue');
    const result = await tool?.execute({ title: 'Feature: Export' }, { issue: issue as Issue, maxSubIssues: 5, subIssueStatus: 'in progress' });
    assert.equal(result?.ok === true && (result.data as Json).status, 'In Progress');
    const status = github.requests.find((r) => r.op === 'SymphonySetStatus');
    assert.equal(status?.variables.optionId, 'o2');
  });
});

describe('github_project auto_merge', () => {
  const MERGE = { base_branch: 'develop', auto_merge: { enabled: '$AUTO', on_enter: 'Human Review', on_conflict: 'In Progress' } };
  const pullRequest = (extra: Json = {}): Json => ({
    id: 'PR_7',
    number: 7,
    url: 'https://github.com/acme/app/pull/7',
    title: 'Feature: Export',
    isDraft: false,
    headRefOid: 'abc123',
    mergeable: 'MERGEABLE',
    labels: { nodes: [] },
    ...extra,
  });

  async function setup(candidate: Json = {}, provider: Json = MERGE) {
    const github = new FakeGithub().add(itemNode('A', { number: 1 }));
    github.mergeCandidate = { ...github.mergeCandidate, pullRequests: { nodes: [pullRequest()] }, ...candidate };
    const tracker = githubProjectFactory.create({
      provider: { owner: 'acme', project_number: 1, token: 'tok', request_retries: 0, ...provider },
      activeStates: ['Todo', 'In Progress'],
      terminalStates: ['Done'],
      env: { AUTO: 'true' },
      logger: Logger.silent(),
      fetch: github.fetch,
    });
    const [issue] = await tracker.fetchIssuesByIds(['A']);
    const setStatus = tracker.agentToolSpecs().find((t) => t.name === 'set_status');
    assert.ok(setStatus);
    const move = async (status: string) => {
      const result = await setStatus.execute({ status }, { issue: issue as Issue });
      assert.equal(result.ok, true, JSON.stringify(result));
      return (result as { ok: true; data: Json }).data;
    };
    const ops = () => github.requests.map((r) => r.op).filter((op) => op !== 'SymphonyItemDetails' && op !== 'SymphonyProjectMeta');
    const statuses = () => github.requests.filter((r) => r.op === 'SymphonySetStatus').map((r) => r.variables.optionId);
    const comments = () => github.requests.filter((r) => r.op === 'SymphonyAddComment').map((r) => String(r.variables.body));
    return { github, tracker, issue: issue as Issue, move, ops, statuses, comments };
  }

  it('merges the pull request into the base branch, closes the issue and moves it to the done column', async () => {
    const { github, move, ops, statuses, comments } = await setup();
    const data = await move('Human Review');
    assert.equal(data.status, 'Done');
    assert.deepEqual(data.auto_merge, { merged: true, pull_request: 7, status: 'Done', reason: 'merged into develop', checks: { state: 'none', failing: [], pending: [] } });
    assert.deepEqual(ops(), ['SymphonySetStatus', 'SymphonyMergeCandidate', 'SymphonyMergePullRequest', 'SymphonyCloseIssue', 'SymphonySetStatus', 'SymphonyAddComment']);
    assert.deepEqual(statuses(), ['o3', 'o4']);
    const candidate = github.requests.find((r) => r.op === 'SymphonyMergeCandidate');
    assert.deepEqual(candidate?.variables, { owner: 'acme', name: 'app', number: 1, head: 'symphony/issue-1', base: 'develop' });
    const merge = github.requests.find((r) => r.op === 'SymphonyMergePullRequest');
    assert.deepEqual(merge?.variables, { pullRequestId: 'PR_7', expectedHeadOid: 'abc123', method: 'SQUASH', headline: 'Feature: Export (#7)' });
    assert.match(comments()[0] ?? '', /merged #7 into `develop` \(squash\)/);
  });

  it('merges through the adapter\'s setStatus exactly like the tool', async () => {
    const viaTool = await setup();
    const toolData = await viaTool.move('Human Review');

    const viaAdapter = await setup();
    const change = await viaAdapter.tracker.setStatus?.(viaAdapter.issue, 'Human Review');
    assert.deepEqual(change, {
      previous: 'Todo',
      status: 'Done',
      autoMerge: { merged: true, pull_request: 7, status: 'Done', reason: 'merged into develop', checks: { state: 'none', failing: [], pending: [] } },
    });
    assert.deepEqual(change?.autoMerge, toolData.auto_merge);
    assert.equal(change?.status, toolData.status);
    assert.deepEqual(viaAdapter.ops(), viaTool.ops());
    assert.deepEqual(viaAdapter.statuses(), ['o3', 'o4']);
    assert.deepEqual(viaAdapter.comments(), viaTool.comments());

    // Other columns, and a conflict, behave as through the tool.
    assert.deepEqual(await viaAdapter.tracker.setStatus?.(viaAdapter.issue, 'In Progress'), { previous: 'Todo', status: 'In Progress' });
    const conflicting = await setup({ pullRequests: { nodes: [pullRequest({ mergeable: 'CONFLICTING' })] } });
    const sentBack = await conflicting.tracker.setStatus?.(conflicting.issue, 'Human Review');
    assert.equal(sentBack?.status, 'In Progress');
    assert.equal(sentBack?.autoMerge?.merged, false);
    assert.deepEqual(conflicting.statuses(), ['o3', 'o2']);
  });

  it('only merges on the configured column', async () => {
    const { move, ops } = await setup();
    const data = await move('In Progress');
    assert.equal(data.auto_merge, undefined);
    assert.deepEqual(ops(), ['SymphonySetStatus']);
  });

  it('leaves the issue for a human with the opt-out label, a draft or the default branch as base', async () => {
    const cases: Array<[Json, RegExp]> = [
      [{ issue: { labels: { nodes: [{ name: 'Manual-Merge' }] } } }, /has the label "manual-merge"/],
      [{ pullRequests: { nodes: [pullRequest({ labels: { nodes: [{ name: 'manual-merge' }] } })] } }, /has the label "manual-merge"/],
      [{ pullRequests: { nodes: [pullRequest({ isDraft: true })] } }, /pull request #7 is a draft/],
      [{ defaultBranchRef: { name: 'develop' } }, /`develop` is the default branch/],
    ];
    for (const [candidate, reason] of cases) {
      const { move, ops, statuses, comments } = await setup(candidate);
      const data = await move('Human Review');
      assert.equal(data.status, 'Human Review', String(reason));
      assert.equal((data.auto_merge as Json).merged, false);
      assert.match(String((data.auto_merge as Json).reason), reason);
      assert.equal(ops().includes('SymphonyMergePullRequest'), false, String(reason));
      assert.deepEqual(statuses(), ['o3']);
      assert.match(comments()[0] ?? '', /did not merge automatically: .* stays in "Human Review" for a human/);
    }
  });

  it('does nothing without a pull request, as for the hand-off of an auditor, autopilot or planner', async () => {
    const { move, ops, comments } = await setup({ pullRequests: { nodes: [] } });
    const data = await move('Human Review');
    assert.equal(data.status, 'Human Review');
    assert.deepEqual(data.auto_merge, { merged: false, pull_request: null, status: 'Human Review', reason: 'there is no open pull request from symphony/issue-1 into develop' });
    assert.deepEqual(ops(), ['SymphonySetStatus', 'SymphonyMergeCandidate']);
    assert.deepEqual(comments(), []);
  });

  it('sends a conflicting pull request back to the developer', async () => {
    for (const conflict of ['reported', 'on merge']) {
      const { github, move, statuses, comments } = await setup(conflict === 'reported' ? { pullRequests: { nodes: [pullRequest({ mergeable: 'CONFLICTING' })] } } : {});
      if (conflict === 'on merge') {
        github.overrides.set('SymphonyMergePullRequest', () => ({ body: { data: null, errors: [{ type: 'UNPROCESSABLE', message: 'Pull Request is not mergeable', path: ['mergePullRequest'] }] } }));
      }
      const data = await move('Human Review');
      assert.equal(data.status, 'In Progress', conflict);
      assert.match(String((data.auto_merge as Json).reason), /conflicts with `develop`/);
      assert.deepEqual(statuses(), ['o3', 'o2']);
      assert.match(comments()[0] ?? '', /Merge `origin\/develop` into `symphony\/issue-1`/);
      assert.equal(github.requests.some((r) => r.op === 'SymphonyCloseIssue'), false);
    }
  });

  it('sends the conflicting pull request of a work package back to its developer while the parent keeps waiting', async () => {
    // Another package was merged into develop first: this package's pull request conflicts with it now.
    const { github, move, statuses, comments } = await setup({ pullRequests: { nodes: [pullRequest({ mergeable: 'CONFLICTING' })] } });
    github.add(itemNode('P', { number: 9, title: 'Invoice export', subIssues: [{ number: 1, state: 'OPEN' }, { number: 2, state: 'CLOSED', stateReason: 'COMPLETED' }] }));
    const data = await move('Human Review');
    assert.equal(data.status, 'In Progress');
    assert.match(String((data.auto_merge as Json).reason), /conflicts with `develop`/);
    assert.deepEqual(statuses(), ['o3', 'o2']);
    assert.match(comments()[0] ?? '', /Merge `origin\/develop` into `symphony\/issue-1`/);
    assert.equal(github.requests.some((r) => r.op === 'SymphonyCloseIssue'), false, 'the package stays open');
    const [parent] = await adapter(github).fetchIssuesByIds(['P']);
    assert.equal(parent?.dispatchable, false);
    assert.equal(parent?.native_ref?.dispatch_note, 'waiting for sub-issues acme/app#1');
  });

  it('keeps a merged result when closing or moving the issue fails afterwards', async () => {
    const { github, move } = await setup();
    github.overrides.set('SymphonyCloseIssue', () => ({ body: { data: null, errors: [{ type: 'FORBIDDEN', message: 'no access', path: ['closeIssue'] }] } }));
    const data = await move('Human Review');
    assert.equal((data.auto_merge as Json).merged, true);
    assert.match(String(((data.auto_merge as Json).warnings as string[])[0]), /could not close the issue: .*no access/);
  });

  it('validates the auto_merge settings', () => {
    const settingsOf = (autoMerge: unknown, extra: Json = { base_branch: 'develop' }) =>
      parseSettings({ owner: 'acme', project_number: 1, token: 't', ...extra, auto_merge: autoMerge }, { ON: 'true' });
    assert.equal(settingsOf({ enabled: '${OFF:-false}', on_enter: 'In review' }).settings?.autoMerge, null);
    assert.deepEqual(settingsOf({ enabled: '$ON', on_enter: 'In review', method: 'Rebase' }).settings?.autoMerge, {
      onEnter: 'In review',
      doneState: null,
      onConflict: null,
      method: 'REBASE',
      optOutLabel: 'manual-merge',
      onChecksFailed: null,
      checks: { wait: true, timeoutMs: 3_600_000, ignore: [], maxSendBacks: 2 },
    });
    assert.deepEqual(
      settingsOf({ enabled: true, on_enter: 'In review', on_checks_failed: 'In progress', checks: { wait: 'false', timeout_ms: '60000', ignore: 'acme/app:ci, lint*', max_send_backs: 0 } }).settings?.autoMerge?.checks,
      { wait: false, timeoutMs: 60_000, ignore: ['acme/app:ci', 'lint*'], maxSendBacks: 0 },
    );
    assert.equal(settingsOf({ enabled: true, on_enter: 'In review', on_checks_failed: 'In progress' }).settings?.autoMerge?.onChecksFailed, 'In progress');
    assert.match(settingsOf({ enabled: true, on_enter: 'x', checks: { bogus: 1 } }).errors.join(), /auto_merge\.checks\.bogus is not a known key/);
    assert.match(settingsOf({ enabled: true, on_enter: 'x', checks: { wait: 'maybe' } }).errors.join(), /auto_merge\.checks\.wait must be true or false/);
    assert.match(settingsOf({ enabled: true, on_enter: 'x', checks: { timeout_ms: 0 } }).errors.join(), /auto_merge\.checks\.timeout_ms must be an integer >= 1/);
    assert.match(settingsOf({ enabled: true, on_enter: 'x', checks: { ignore: [1] } }).errors.join(), /auto_merge\.checks\.ignore must be a list/);
    assert.match(settingsOf({ enabled: true, on_enter: 'x', checks: { ignore: ['{a'] } }).errors.join(), /is not a valid glob/);
    assert.match(settingsOf({ enabled: true, on_enter: 'x', checks: 'on' }).errors.join(), /auto_merge\.checks must be a map/);
    assert.match(settingsOf({ enabled: true, on_enter: 'In review' }, {}).errors.join(), /auto_merge needs tracker\.provider\.base_branch/);
    assert.match(settingsOf({ enabled: true }).errors.join(), /auto_merge\.on_enter is required/);
    assert.match(settingsOf({ enabled: true, on_enter: 'x', method: 'octopus' }).errors.join(), /method must be squash, merge or rebase/);
    assert.match(settingsOf({ enabled: 'yes', on_enter: 'x' }).errors.join(), /auto_merge\.enabled must be true or false/);
    assert.match(settingsOf({ enabled: false, bogus: 1 }).errors.join(), /auto_merge\.bogus is not a known key/);
    assert.match(settingsOf('on').errors.join(), /auto_merge must be a map/);

    const github = new FakeGithub();
    const create = (autoMerge: Json) => () => adapter(github, { base_branch: 'develop', auto_merge: { enabled: true, ...autoMerge } });
    assert.throws(create({ on_enter: 'In Progress' }), /auto_merge\.on_enter "In Progress" must not be an active or terminal state/);
    assert.throws(create({ on_enter: 'Human Review', done_state: 'Human Review' }), /auto_merge\.done_state "Human Review" must be a terminal state/);
    assert.throws(create({ on_enter: 'Human Review', on_conflict: 'Done' }), /auto_merge\.on_conflict "Done" must not be a terminal state/);
    assert.throws(create({ on_enter: 'Human Review', on_checks_failed: 'Done' }), /auto_merge\.on_checks_failed "Done" must not be a terminal state/);
    assert.doesNotThrow(create({ on_enter: 'Human Review' }));
  });

  describe('merge gate on the pull request checks', () => {
    const run = (name: string, conclusion: string | null, extra: Json = {}): Json => ({
      __typename: 'CheckRun',
      name,
      status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
      conclusion,
      detailsUrl: `https://github.com/acme/app/actions/runs/${name}`,
      annotations: { nodes: [] },
      ...extra,
    });
    const status = (context: string, state: string): Json => ({ __typename: 'StatusContext', context, state, description: null, targetUrl: `https://symphony.example/${context}` });
    const withChecks = (contexts: Json[] | null, extra: Json = {}): Json => ({
      pullRequests: {
        nodes: [
          pullRequest({
            commits: { nodes: [{ commit: { oid: 'abc123', statusCheckRollup: contexts === null ? null : { state: 'X', contexts: { totalCount: contexts.length, nodes: contexts } } } }] },
            ...extra,
          }),
        ],
      },
    });
    const BILLING = { annotations: { nodes: [{ message: 'The job was not started because recent account payments have failed or your spending limit needs to be increased.' }] } };
    const labelOps = (github: FakeGithub) => github.requests.filter((r) => r.op === 'SymphonyAddLabels' || r.op === 'SymphonyRemoveLabels').map((r) => r.op);

    it('merges when every check passed, was skipped or is ignored, and when there are none', async () => {
      const cases: Array<[Json, Json]> = [
        [withChecks([run('ci', 'SUCCESS'), run('prod-smoke', 'SKIPPED'), status('symphony/ci', 'SUCCESS')]), MERGE],
        [withChecks(null), MERGE],
        [withChecks([run('ci', 'FAILURE'), run('lint', 'NEUTRAL')]), { ...MERGE, auto_merge: { ...MERGE.auto_merge, checks: { ignore: ['acme/app:ci'] } } }],
      ];
      for (const [candidate, provider] of cases) {
        const { move, comments } = await setup(candidate, provider);
        const data = await move('Human Review');
        assert.equal(data.status, 'Done', JSON.stringify(candidate));
        assert.equal((data.auto_merge as Json).merged, true);
        assert.match(comments()[0] ?? '', /merged #7 into `develop`/);
      }
    });

    it('sends failing checks back to the developer with links and a marker', async () => {
      for (const contexts of [[run('ci', 'FAILURE'), run('prod-smoke', 'SUCCESS')], [status('symphony/ci', 'FAILURE')]]) {
        const { github, move, statuses, comments } = await setup(withChecks(contexts));
        const data = await move('Human Review');
        assert.equal(data.status, 'In Progress');
        const auto = data.auto_merge as Json;
        assert.equal(auto.merged, false);
        assert.equal((auto.checks as Json).state, 'failure');
        assert.deepEqual(statuses(), ['o3', 'o2']);
        assert.match(comments()[0] ?? '', /<!-- symphony:merge-gate checks_failed -->/);
        assert.match(comments()[0] ?? '', /these checks failed: \[(ci|symphony\/ci)\]\(https:\/\/[^)]+\) \(failure\)/);
        assert.equal(github.requests.some((r) => r.op === 'SymphonyMergePullRequest'), false);
      }
    });

    it('uses on_checks_failed over on_conflict', async () => {
      const provider = { ...MERGE, auto_merge: { ...MERGE.auto_merge, on_checks_failed: 'Todo' } };
      const { move, statuses } = await setup(withChecks([run('ci', 'FAILURE')]), provider);
      assert.equal((await move('Human Review')).status, 'Todo');
      assert.deepEqual(statuses(), ['o3', 'o1']);
    });

    it('leaves the issue for a human after max_send_backs send-backs, with needs-human', async () => {
      const { github, issue, move, statuses, comments } = await setup(withChecks([run('ci', 'FAILURE')]));
      const marker = { author: { login: 'symphony-bot' }, createdAt: '2026-09-03T10:00:00Z', body: '<!-- symphony:merge-gate checks_failed -->\nfailed', url: 'https://x/1' };
      github.comments.set(issue.native_ref?.issue_id as string, [marker, { ...marker, url: 'https://x/2' }, { ...marker, author: { login: 'someone' }, url: 'https://x/3' }]);
      github.labels.set('needs-human', 'L_nh');
      const data = await move('Human Review');
      assert.equal(data.status, 'Human Review');
      assert.match(String((data.auto_merge as Json).reason), /sent back for failing checks 2 times already/);
      assert.deepEqual(statuses(), ['o3']);
      assert.ok(github.requests.some((r) => r.op === 'SymphonyAddLabels'));
      assert.match(comments()[0] ?? '', /stays in "Human Review" for a human/);
    });

    it('never sends back checks GitHub did not start (billing), and says how to fix it', async () => {
      const { github, move, statuses, comments } = await setup(withChecks([run('ci', 'FAILURE', BILLING), run('prod-smoke', 'FAILURE', BILLING)]));
      const data = await move('Human Review');
      assert.equal(data.status, 'Human Review');
      assert.deepEqual(statuses(), ['o3']);
      assert.match(comments()[0] ?? '', /GitHub did not start their jobs .*CI_RUNNER=symphony/);
      assert.equal(github.requests.some((r) => r.op === 'SymphonyMergePullRequest'), false);
    });

    it('treats a code failure next to a billing failure as a code failure', async () => {
      const { move } = await setup(withChecks([run('ci', 'FAILURE', BILLING), status('symphony/ci', 'FAILURE')]));
      assert.equal((await move('Human Review')).status, 'In Progress');
    });

    it('never merges a head the entry checks did not see', async () => {
      const { tracker, issue, github, comments } = await setup(withChecks([run('ci', 'SUCCESS')]));
      const change = await tracker.setStatus?.(issue, 'Human Review', { checkedSha: 'fff999' });
      assert.equal(change?.status, 'Human Review');
      assert.match(String(change?.autoMerge?.reason), /commits the entry checks did not see \(checked fff999, head abc123\)/);
      assert.equal(github.requests.some((r) => r.op === 'SymphonyMergePullRequest'), false);
      assert.equal(comments().length, 1);
      const same = await setup(withChecks([run('ci', 'SUCCESS')]));
      assert.equal((await same.tracker.setStatus?.(same.issue, 'Human Review', { checkedSha: 'abc123' }))?.autoMerge?.merged, true);
    });

    it('waits for pending checks with a label, retries quietly and merges once they pass', async () => {
      const { github, tracker, issue, move, comments } = await setup(withChecks([run('ci', null), status('symphony/ci', 'PENDING')]));
      const data = await move('Human Review');
      assert.equal(data.status, 'Human Review');
      const auto = data.auto_merge as Json;
      assert.equal(auto.awaiting_checks, true);
      assert.deepEqual((auto.checks as Json).pending, ['ci', 'symphony/ci']);
      assert.ok(github.labels.has('awaiting-checks'), 'the label is created');
      assert.deepEqual(labelOps(github), ['SymphonyAddLabels']);
      assert.match(comments()[0] ?? '', /waits before merging: the checks of #7 are still running/);

      const watch = tracker.mergeWatch?.();
      assert.ok(watch);
      assert.equal(watch.column, 'Human Review');
      const waiting: Issue = { ...issue, state: 'Human Review', labels: ['awaiting-checks'], native_ref: { ...issue.native_ref, status_updated_at: new Date().toISOString() } };
      assert.equal(watch.awaiting(waiting), true);
      assert.equal(watch.awaiting({ ...waiting, labels: [] }), false);
      assert.equal(watch.awaiting({ ...waiting, state: 'Todo' }), false);

      const still = await watch.retry(waiting);
      assert.equal(still.awaiting_checks, true);
      assert.equal(comments().length, 1, 'no new comment while waiting');
      assert.deepEqual(labelOps(github), ['SymphonyAddLabels']);

      github.mergeCandidate = { ...github.mergeCandidate, ...withChecks([run('ci', 'SUCCESS'), status('symphony/ci', 'SUCCESS')]) };
      const merged = await watch.retry(waiting);
      assert.equal(merged.merged, true);
      assert.equal(merged.status, 'Done');
      assert.deepEqual(labelOps(github), ['SymphonyAddLabels', 'SymphonyRemoveLabels']);
    });

    it('waits while GitHub has not computed mergeability or the head moved during the merge', async () => {
      const unknown = await setup(withChecks([run('ci', 'SUCCESS')], { mergeable: 'UNKNOWN' }));
      assert.equal(((await unknown.move('Human Review')).auto_merge as Json).awaiting_checks, true);

      const moved = await setup(withChecks([run('ci', 'SUCCESS')]));
      moved.github.overrides.set('SymphonyMergePullRequest', () => ({ body: { data: null, errors: [{ type: 'UNPROCESSABLE', message: 'Head branch was modified. Review and try the merge again.', path: ['mergePullRequest'] }] } }));
      const data = await moved.move('Human Review');
      assert.equal(data.status, 'Human Review');
      assert.equal((data.auto_merge as Json).awaiting_checks, true);
    });

    it('does not mistake a rule refusal for a conflict', async () => {
      const { github, move, statuses } = await setup(withChecks([run('ci', 'SUCCESS')]));
      github.overrides.set('SymphonyMergePullRequest', () => ({
        body: { data: null, errors: [{ type: 'UNPROCESSABLE', message: 'Pull request is not mergeable: Required status check "symphony/ci" is expected.', path: ['mergePullRequest'] }] },
      }));
      const data = await move('Human Review');
      assert.equal(data.status, 'Human Review');
      assert.match(String((data.auto_merge as Json).reason), /GitHub refused the merge of #7: .*Required status check/);
      assert.deepEqual(statuses(), ['o3']);
    });

    it('leaves pending checks to a human when waiting is off, or after the timeout', async () => {
      const off = await setup(withChecks([run('ci', null)]), { ...MERGE, auto_merge: { ...MERGE.auto_merge, checks: { wait: false } } });
      const data = await off.move('Human Review');
      assert.match(String((data.auto_merge as Json).reason), /still running .*auto_merge\.checks\.wait is off/);
      assert.equal((data.auto_merge as Json).awaiting_checks, undefined);
      assert.equal(off.tracker.mergeWatch?.(), null);

      const late = await setup(withChecks([run('ci', null)]), { ...MERGE, auto_merge: { ...MERGE.auto_merge, checks: { timeout_ms: 60_000 } } });
      const watch = late.tracker.mergeWatch?.();
      assert.ok(watch);
      const waiting: Issue = { ...late.issue, state: 'Human Review', labels: ['awaiting-checks'], native_ref: { ...late.issue.native_ref, status_updated_at: new Date(Date.now() - 120_000).toISOString() } };
      late.github.labels.set('awaiting-checks', 'L_ac');
      const gaveUp = await watch.retry(waiting);
      assert.equal(gaveUp.merged, false);
      assert.match(gaveUp.reason, /did not finish within 1 minutes/);
      assert.deepEqual(labelOps(late.github), ['SymphonyRemoveLabels']);
      assert.equal(late.github.requests.some((r) => r.op === 'SymphonyMergeCandidate'), false);
    });

    it('drops a stale awaiting-checks label when a later entry ends the wait', async () => {
      const { github, tracker, issue } = await setup(withChecks([run('ci', 'SUCCESS')]));
      github.labels.set('awaiting-checks', 'L_ac');
      const change = await tracker.setStatus?.({ ...issue, labels: ['awaiting-checks'] }, 'Human Review');
      assert.equal(change?.autoMerge?.merged, true);
      assert.deepEqual(labelOps(github), ['SymphonyRemoveLabels']);
    });
  });
});

describe('github_project work packages as sub-issues (#211)', () => {
  // The fake board has no "Ready" column, so "Human Review" stands in for the column the architect's packages start in.
  const READY = 'Human Review';
  const PACKAGES = [
    { title: 'Export: CSV writer', body: 'Rows as CSV.\n\nPart of #7', labels: ['Type: feature', 'Complexity: M'] },
    { title: 'Export: PDF writer', body: 'One PDF per invoice.\n\nPart of #7', labels: ['Type: feature', 'Complexity: M'] },
    { title: 'Export: CLI command', body: 'Wires both.\n\nBlocked by #8, #9\n\nPart of #7', labels: ['Type: feature', 'Complexity: S'], blocked_by: [8, 9] },
  ];

  /** The parent #7 as an XL issue on the board; GitHub numbers the packages 8, 9 and 10. */
  function parentBoard() {
    const github = new FakeGithub().add(itemNode('P', { number: 7, title: 'Invoice export', labels: ['Type: feature', 'Complexity: XL'] }));
    github.nextNumber = 8;
    for (const label of ['type: feature', 'complexity: m', 'complexity: s']) github.labels.set(label, `L_${label}`);
    github.references.set('acme/app#8', 'OPEN');
    github.references.set('acme/app#9', 'OPEN');
    return github;
  }

  /** Lets the parent's board item list the sub-issues GitHub holds now, as the item query would. */
  function syncParent(github: FakeGithub, states: Record<number, { state: string; stateReason?: string }> = {}): void {
    const node = github.items.get('P') as Json;
    const content = node.content as Json;
    const children = (github.subIssues.get('I_P') ?? []) as Json[];
    content.subIssues = {
      nodes: children.map((child) => ({ number: child.number, title: child.title, state: 'OPEN', ...states[child.number as number], repository: { nameWithOwner: 'acme/app' } })),
    };
  }

  it('files exactly three sub-issues under the parent, in the role\'s column, with the last one blocked by the other two', async () => {
    const github = parentBoard();
    const tracker = adapter(github);
    const [parent] = await tracker.fetchIssuesByIds(['P']);
    const create = tracker.agentToolSpecs().find((tool) => tool.name === 'create_sub_issue');
    assert.ok(create);
    const results: ToolResult[] = [];
    for (const pkg of PACKAGES) results.push(await create.execute(pkg, { issue: parent as Issue, maxSubIssues: 5, subIssueStatus: READY }));

    const data = results.map((result) => {
      assert.equal(result.ok, true, JSON.stringify(result));
      return (result as { ok: true; data: Json }).data;
    });
    assert.deepEqual(data.map((entry) => [entry.created, entry.number, entry.identifier, entry.status, entry.remaining]), [
      [true, 8, 'acme/app#8', READY, 4],
      [true, 9, 'acme/app#9', READY, 3],
      [true, 10, 'acme/app#10', READY, 2],
    ]);
    const creates = github.requests.filter((r) => r.op === 'SymphonyCreateSubIssue');
    assert.deepEqual(creates.map((r) => [r.variables.parentId, r.variables.title]), PACKAGES.map((pkg) => ['I_P', pkg.title]));
    assert.deepEqual(creates.map((r) => r.variables.labelIds), [['L_type: feature', 'L_complexity: m'], ['L_type: feature', 'L_complexity: m'], ['L_type: feature', 'L_complexity: s']]);
    // Each package is on the board in the column of the role (not the provider default), so it starts without a human.
    assert.deepEqual(github.requests.filter((r) => r.op === 'SymphonySetStatus').map((r) => r.variables.optionId), ['o3', 'o3', 'o3']);
    // Only the dependent package waits, for exactly the two packages it builds on.
    assert.deepEqual(
      github.requests.filter((r) => r.op === 'SymphonyAddBlockedBy').map((r) => [r.variables.issueId, r.variables.blockingIssueId]),
      [['I_new10', 'I_acme/app#8'], ['I_new10', 'I_acme/app#9']],
    );
    assert.deepEqual(data[2]?.blocked_by, [8, 9]);
    assert.deepEqual(data[0]?.blocked_by, undefined);
  });

  it('does not file a package twice when the architect runs the same calls again, and stops at max_sub_issues', async () => {
    const github = parentBoard();
    const tracker = adapter(github);
    const [parent] = await tracker.fetchIssuesByIds(['P']);
    const create = tracker.agentToolSpecs().find((tool) => tool.name === 'create_sub_issue');
    assert.ok(create);
    const context = (max: number) => ({ issue: parent as Issue, maxSubIssues: max, subIssueStatus: READY });
    for (const pkg of PACKAGES) await create.execute(pkg, context(3));
    const again = await Promise.all(PACKAGES.map((pkg) => create.execute(pkg, context(3))));
    assert.deepEqual(again.map((result) => result.ok && (result.data as Json).created), [false, false, false]);
    assert.equal(github.requests.filter((r) => r.op === 'SymphonyCreateSubIssue').length, 3, 'three sub-issues, not six');
    const fourth = await create.execute({ title: 'Export: a fourth package' }, context(3));
    assert.equal(fourth.ok === false && fourth.error.category, 'limit_reached');
    assert.equal(github.requests.filter((r) => r.op === 'SymphonyCreateSubIssue').length, 3);
  });

  it('holds the parent until the last package is closed, whatever the reason, and then releases it', async () => {
    const github = parentBoard();
    const tracker = adapter(github);
    const [fresh] = await tracker.fetchIssuesByIds(['P']);
    assert.deepEqual([fresh?.dispatchable, fresh?.native_ref?.held_by_sub_issues], [true, false], 'no package yet');
    const create = tracker.agentToolSpecs().find((tool) => tool.name === 'create_sub_issue');
    assert.ok(create);
    for (const pkg of PACKAGES) await create.execute(pkg, { issue: fresh as Issue, maxSubIssues: 5, subIssueStatus: READY });

    const read = async () => {
      const [parent] = await tracker.fetchIssuesByIds(['P']);
      assert.ok(parent);
      return { parent, open: tracker.openSubIssues?.(parent), held: tracker.heldBySubIssues?.(parent) };
    };
    syncParent(github);
    let seen = await read();
    assert.deepEqual([seen.parent.dispatchable, seen.held, seen.open], [false, true, ['acme/app#8', 'acme/app#9', 'acme/app#10']]);
    assert.equal(seen.parent.native_ref?.dispatch_note, 'waiting for sub-issues acme/app#8, acme/app#9, acme/app#10');

    syncParent(github, { 8: { state: 'CLOSED', stateReason: 'COMPLETED' } });
    seen = await read();
    assert.deepEqual([seen.parent.dispatchable, seen.open], [false, ['acme/app#9', 'acme/app#10']]);
    syncParent(github, { 8: { state: 'CLOSED', stateReason: 'COMPLETED' }, 9: { state: 'CLOSED', stateReason: 'NOT_PLANNED' } });
    seen = await read();
    assert.deepEqual([seen.parent.dispatchable, seen.open], [false, ['acme/app#10']]);

    syncParent(github, { 8: { state: 'CLOSED', stateReason: 'COMPLETED' }, 9: { state: 'CLOSED', stateReason: 'NOT_PLANNED' }, 10: { state: 'CLOSED', stateReason: 'COMPLETED' } });
    seen = await read();
    assert.deepEqual([seen.parent.dispatchable, seen.held, seen.open], [true, false, []]);
    // The integration review reads each package with the reason it was closed.
    assert.deepEqual(
      (seen.parent.native_ref?.sub_issues as Json[]).map((entry) => [entry.identifier, entry.state, entry.state_reason]),
      [['acme/app#8', 'CLOSED', 'COMPLETED'], ['acme/app#9', 'CLOSED', 'NOT_PLANNED'], ['acme/app#10', 'CLOSED', 'COMPLETED']],
    );
    assert.equal(seen.parent.native_ref?.dispatch_note, null);
  });

  describe('a package whose pull request conflicts after another package was merged', () => {
    const MERGE = { base_branch: 'develop', auto_merge: { enabled: '$AUTO', on_enter: 'Human Review', on_conflict: 'In Progress' } };
    const pullRequest = (extra: Json = {}): Json => ({ id: 'PR_7', number: 7, url: 'https://github.com/acme/app/pull/7', title: 'Export: CSV writer', isDraft: false, headRefOid: 'abc123', mergeable: 'MERGEABLE', labels: { nodes: [] }, ...extra });

    it('returns to In Progress with a comment naming the base, the parent keeps waiting, and the resolved package then merges and releases it', async () => {
      // #1 is the package under test (a sub-issue of #9), #2 the package another developer merged first.
      const github = new FakeGithub().add(
        itemNode('A', { number: 1, title: 'Export: CSV writer', parent: { number: 9, title: 'Invoice export', state: 'OPEN' } }),
        itemNode('P', { number: 9, title: 'Invoice export', labels: ['Type: feature', 'Complexity: XL'], subIssues: [{ number: 1, state: 'OPEN' }, { number: 2, state: 'CLOSED', stateReason: 'COMPLETED' }] }),
      );
      github.mergeCandidate = { ...github.mergeCandidate, pullRequests: { nodes: [pullRequest({ mergeable: 'CONFLICTING' })] } };
      const tracker = githubProjectFactory.create({
        provider: { owner: 'acme', project_number: 1, token: 'tok', request_retries: 0, ...MERGE },
        activeStates: ['Todo', 'In Progress'],
        terminalStates: ['Done'],
        env: { AUTO: 'true' },
        logger: Logger.silent(),
        fetch: github.fetch,
      });
      const [pkg] = await tracker.fetchIssuesByIds(['A']);
      assert.equal((pkg?.native_ref?.parent as Json).identifier, 'acme/app#9', 'the package knows its parent');
      const setStatus = tracker.agentToolSpecs().find((tool) => tool.name === 'set_status');
      assert.ok(setStatus);
      const move = async () => {
        const result = await setStatus.execute({ status: 'Human Review' }, { issue: pkg as Issue });
        assert.equal(result.ok, true, JSON.stringify(result));
        return (result as { ok: true; data: Json }).data;
      };
      const parentState = async () => {
        const [parent] = await tracker.fetchIssuesByIds(['P']);
        return [parent?.dispatchable, parent?.native_ref?.dispatch_note];
      };

      // Conflict: the package goes back to the developer, is not merged and not closed; the parent keeps waiting for it.
      const first = await move();
      assert.equal(first.status, 'In Progress');
      assert.equal((first.auto_merge as Json).merged, false);
      assert.match(String((first.auto_merge as Json).reason), /pull request #7 conflicts with `develop`/);
      const commentsOf = () => github.requests.filter((r) => r.op === 'SymphonyAddComment').map((r) => String(r.variables.body));
      assert.match(commentsOf()[0] ?? '', /could not merge: pull request #7 conflicts with `develop`\. Merge `origin\/develop` into `symphony\/issue-1`/);
      assert.equal(github.requests.some((r) => r.op === 'SymphonyMergePullRequest'), false);
      assert.equal(github.requests.some((r) => r.op === 'SymphonyCloseIssue'), false);
      assert.deepEqual(await parentState(), [false, 'waiting for sub-issues acme/app#1']);

      // The developer merged the base into the branch; the next hand-off merges the pull request and closes the package.
      github.mergeCandidate = { ...github.mergeCandidate, pullRequests: { nodes: [pullRequest({ mergeable: 'MERGEABLE' })] } };
      const second = await move();
      assert.equal(second.status, 'Done');
      assert.equal((second.auto_merge as Json).merged, true);
      assert.equal(github.requests.filter((r) => r.op === 'SymphonyCloseIssue').length, 1);
      assert.deepEqual(github.requests.filter((r) => r.op === 'SymphonySetStatus').map((r) => r.variables.optionId), ['o3', 'o2', 'o3', 'o4']);

      // GitHub closed the package: the parent's item lists no open sub-issue any more.
      ((github.items.get('P') as Json).content as Json).subIssues = {
        nodes: [1, 2].map((number) => ({ number, title: `Sub ${number}`, state: 'CLOSED', stateReason: 'COMPLETED', repository: { nameWithOwner: 'acme/app' } })),
      };
      assert.deepEqual(await parentState(), [true, null]);
    });

    it('leaves a conflicting package where it is when no on_conflict column is configured (a human sees the pull request)', async () => {
      const github = new FakeGithub().add(itemNode('A', { number: 1 }));
      github.mergeCandidate = { ...github.mergeCandidate, pullRequests: { nodes: [pullRequest({ mergeable: 'CONFLICTING' })] } };
      const tracker = githubProjectFactory.create({
        provider: { owner: 'acme', project_number: 1, token: 'tok', request_retries: 0, base_branch: 'develop', auto_merge: { enabled: true, on_enter: 'Human Review' } },
        activeStates: ['Todo', 'In Progress'],
        terminalStates: ['Done'],
        env: {},
        logger: Logger.silent(),
        fetch: github.fetch,
      });
      const [pkg] = await tracker.fetchIssuesByIds(['A']);
      const change = await tracker.setStatus?.(pkg as Issue, 'Human Review');
      assert.equal(change?.status, 'Human Review');
      assert.equal(change?.autoMerge?.merged, false);
      assert.deepEqual(github.requests.filter((r) => r.op === 'SymphonySetStatus').map((r) => r.variables.optionId), ['o3']);
      assert.equal(github.requests.some((r) => r.op === 'SymphonyCloseIssue'), false);
    });
  });

  it('does not treat an issue as held by its sub-issues alone while a blocker named in its text is open', async () => {
    const github = new FakeGithub().add(
      itemNode('P', { number: 7, title: 'Invoice export', body: 'Needs the payment API.\n\nBlocked by #99', subIssues: [{ number: 8, state: 'OPEN' }] }),
      itemNode('Q', { number: 20, title: 'Other export', body: 'Blocked by #99', subIssues: [{ number: 21, state: 'OPEN' }] }),
    );
    github.references.set('acme/app#99', 'OPEN');
    const tracker = adapter(github);
    const [open] = await tracker.fetchIssuesByIds(['P']);
    assert.deepEqual([open?.dispatchable, open?.native_ref?.held_by_sub_issues, tracker.heldBySubIssues?.(open as Issue)], [false, false, false]);
    assert.match(String(open?.native_ref?.dispatch_note), /blocked by acme\/app#99; waiting for sub-issues acme\/app#8/);
    const listed = (await tracker.fetchIssuesByStates(['Todo'])).find((issue) => issue.id === 'Q');
    assert.deepEqual([listed?.dispatchable, listed?.native_ref?.held_by_sub_issues], [false, false], 'the same on the dispatch listing');

    github.references.set('acme/app#99', 'CLOSED');
    const [resolved] = await tracker.fetchIssuesByIds(['P']);
    assert.deepEqual([resolved?.dispatchable, resolved?.native_ref?.held_by_sub_issues], [false, true], 'only the sub-issue holds it back now');
  });

  it('leaves the parent in In review for a human after an approved integration review, even with auto-merge on: it has no pull request of its own', async () => {
    const github = new FakeGithub().add(
      itemNode('P', { number: 7, title: 'Invoice export', labels: ['Type: feature', 'Complexity: XL'], subIssues: [8, 9, 10].map((number) => ({ number, state: 'CLOSED', stateReason: 'COMPLETED' })) }),
    );
    github.mergeCandidate = { ...github.mergeCandidate, pullRequests: { nodes: [] } };
    const tracker = githubProjectFactory.create({
      provider: { owner: 'acme', project_number: 1, token: 'tok', request_retries: 0, base_branch: 'develop', auto_merge: { enabled: true, on_enter: 'Human Review', on_conflict: 'In Progress' } },
      activeStates: ['Todo', 'In Progress'],
      terminalStates: ['Done'],
      env: {},
      logger: Logger.silent(),
      fetch: github.fetch,
    });
    const [parent] = await tracker.fetchIssuesByIds(['P']);
    assert.equal(parent?.dispatchable, true, 'every package is closed');
    const change = await tracker.setStatus?.(parent as Issue, 'Human Review');
    assert.equal(change?.status, 'Human Review', 'not merged, not closed, not moved to Done');
    assert.equal(change?.autoMerge?.merged, false);
    assert.match(String(change?.autoMerge?.reason), /there is no open pull request from symphony\/issue-7 into develop/);
    assert.equal(github.requests.some((r) => r.op === 'SymphonyMergePullRequest' || r.op === 'SymphonyCloseIssue'), false);
    assert.deepEqual(github.requests.filter((r) => r.op === 'SymphonySetStatus').map((r) => r.variables.optionId), ['o3']);
  });
});
