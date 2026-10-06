import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Logger } from '../src/log.ts';
import { createGuard, guardTools } from '../src/orchestrator/guard.ts';
import { githubProjectFactory } from '../src/tracker/github-project/index.ts';
import { parseSettings } from '../src/tracker/github-project/settings.ts';
import { TrackerError, type Issue, type ToolResult, type TrackerAdapter } from '../src/tracker/types.ts';
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

function itemNode(id: string, options: { status?: string | null; repo?: string; number?: number; title?: string; state?: string; labels?: string[]; assignees?: string[]; blockedBy?: Array<{ state: string; number?: number }>; project?: string; type?: string; body?: string; parent?: { number: number; title: string; state: string }; subIssues?: Array<{ number: number; state: string }> } = {}): Json {
  const status = options.status === undefined ? 'Todo' : options.status;
  const option = STATUS_OPTIONS.find((o) => o.name === status);
  return {
    __typename: 'ProjectV2Item',
    id,
    isArchived: false,
    project: { id: options.project ?? 'PVT_1' },
    status: status === null ? null : { name: status, optionId: option?.id ?? 'ox' },
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
  /** Repository labels by lowercase name. */
  labels = new Map<string, string>();
  /** Numbers handed out to created issues. */
  nextNumber = 100;

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
            data[`ref${index}`] = { issueOrPullRequest: { __typename: 'Issue', id: `I_${key}`, number: Number(match[2]), state } };
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
                pullRequests: { nodes: [{ number: 5, url: 'https://github.com/acme/app/pull/5', title: 'Existing', baseRefName: 'main', headRefName: variables.head, isDraft: false }] },
              },
            },
          },
        };
      case 'SymphonySubIssueContext':
        return {
          body: {
            data: {
              node: {
                repository: { id: 'R_1', nameWithOwner: 'acme/app' },
                subIssues: { nodes: this.subIssues.get(String(variables.issueId)) ?? [] },
              },
            },
          },
        };
      case 'SymphonyLabels': {
        const data: Json = {};
        for (const match of this.lastQuery.matchAll(/l(\d+): label\(/g)) {
          const name = String(variables[`l${match[1]}`]);
          const id = this.labels.get(name.toLowerCase());
          data[`l${match[1]}`] = id === undefined ? null : { id, name };
        }
        return { body: { data: { repository: data } } };
      }
      case 'SymphonyCreateSubIssue': {
        const number = this.nextNumber++;
        const issue = { id: `I_new${number}`, number, url: `https://github.com/acme/app/issues/${number}` };
        const siblings = this.subIssues.get(String(variables.parentId)) ?? [];
        siblings.push({ ...issue, title: variables.title, state: 'OPEN', projectItems: { nodes: [] } });
        this.subIssues.set(String(variables.parentId), siblings);
        return { body: { data: { createIssue: { issue } } } };
      }
      case 'SymphonyAddProjectItem':
        return { body: { data: { addProjectV2ItemById: { item: { id: `PVTI_${variables.contentId}` } } } } };
      default:
        return { status: 500, body: { message: `unexpected ${op}` } };
    }
  }
}

function adapter(github: FakeGithub, provider: Json = {}): TrackerAdapter {
  return githubProjectFactory.create({
    provider: { owner: 'acme', project_number: 1, token: 'tok', request_retries: 0, ...provider },
    activeStates: ['Todo', 'In Progress'],
    terminalStates: ['Done'],
    env: {},
    logger: Logger.silent(),
    fetch: github.fetch,
  });
}

describe('github_project settings', () => {
  it('takes the board owner from the first repository and resolves $VAR references', () => {
    const { settings } = parseSettings(
      { project_number: '$NUM', repositories: '$REPOS', token: '$GITHUB_TOKEN' },
      { NUM: '10', REPOS: 'cooolinho/trainingsstunden-portal, cooolinho/other', GITHUB_TOKEN: 'ghp_x' },
    );
    assert.equal(settings?.owner, 'cooolinho');
    assert.equal(settings?.projectNumber, 10);
    assert.deepEqual([...(settings?.repositories ?? [])], ['cooolinho/trainingsstunden-portal', 'cooolinho/other']);
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
    assert.deepEqual(first.native_ref, { provider: 'github_project', project_id: 'PVT_1', item_id: 'A', issue_id: 'I_A', repository: 'acme/app', number: 1, issue_state: 'OPEN', status_option_id: 'o1', parent: null, sub_issues: [], dispatch_note: null });
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
    assert.deepEqual(issues.get('child')?.native_ref?.parent, { identifier: 'acme/app#1', title: 'Parent', state: 'OPEN' });
    assert.equal((await dispatch(github, { respect_sub_issues: false })).get('parent')?.dispatchable, true);
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
    assert.deepEqual(result, { ok: true, data: { created: false, number: 5, url: 'https://github.com/acme/app/pull/5', title: 'Existing', base: 'main' } });
    assert.equal(github.requests.some((r) => r.op === 'SymphonyCreatePullRequest'), false);
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
