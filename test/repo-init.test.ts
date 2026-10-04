import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { describe, it } from 'node:test';
import { GithubRestClient, GithubRestError, type GithubLabel, type NewLabel } from '../src/repo-init/github-rest.ts';
import { STANDARD_LABELS, applyLabelChanges, planLabelChanges } from '../src/repo-init/labels.ts';
import { BOOST_ISSUE_TITLE, boostIssueBody, planBoostSetup } from '../src/repo-init/laravel-boost.ts';
import { runRepoInit } from '../src/repo-init/main.ts';
import { tempDir } from './helpers.ts';

type Json = Record<string, unknown>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function label(name: string, overrides: Partial<GithubLabel> = {}): GithubLabel {
  return { name, color: 'ededed', description: null, archived_at: null, ...overrides };
}

function standardSpec(name: string): NewLabel {
  const spec = STANDARD_LABELS.find((entry) => entry.name === name);
  if (spec === undefined) throw new Error(`no standard label ${name}`);
  return spec;
}

/** A standard label as GitHub returns it. */
function standard(name: string): GithubLabel {
  return { ...standardSpec(name), archived_at: null };
}

interface FakeIssue {
  number: number;
  title: string;
  body?: string;
  html_url: string;
  pull_request?: Json;
}

/** In-memory GitHub REST API for repository labels, files on the default branch "main", and issues. */
class FakeRestGithub {
  repos = new Map<string, GithubLabel[]>();
  files = new Map<string, Record<string, string>>();
  issues = new Map<string, FakeIssue[]>();
  requests: Array<{ method: string; path: string; headers: Record<string, string>; body: Json | undefined }> = [];
  pageSize = 100;
  /** Canned replies keyed by "METHOD /path". */
  failures = new Map<string, { status: number; body: unknown }>();

  constructor(repos: Record<string, GithubLabel[]> = {}) {
    for (const [name, labels] of Object.entries(repos)) this.repos.set(name, labels.map((entry) => ({ ...entry })));
  }

  mutations() {
    return this.requests.filter((request) => request.method !== 'GET');
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Json);
    this.requests.push({ method, path: `${url.pathname}${url.search}`, headers: { ...(init?.headers as Record<string, string>) }, body });
    const failure = this.failures.get(`${method} ${url.pathname}`);
    if (failure !== undefined) return json(failure.body, failure.status);
    const contents = this.#contents(method, url, body);
    if (contents !== null) return contents;

    const match = /^\/repos\/([^/]+)\/([^/]+)\/labels(?:\/([^/]+))?$/.exec(url.pathname);
    const labels = match === null ? undefined : this.repos.get(`${decodeURIComponent(match[1] ?? '')}/${decodeURIComponent(match[2] ?? '')}`);
    if (match === null || labels === undefined) return json({ message: 'Not Found' }, 404);
    const name = match[3] === undefined ? null : decodeURIComponent(match[3]);
    const find = (wanted: string) => labels.find((entry) => entry.name.toLowerCase() === wanted.toLowerCase());

    if (method === 'GET' && name === null) {
      const page = Number(url.searchParams.get('page') ?? '1');
      const next = new URL(url);
      next.searchParams.set('page', String(page + 1));
      const more = page * this.pageSize < labels.length;
      return json(labels.slice((page - 1) * this.pageSize, page * this.pageSize), 200, more ? { link: `<${next.href}>; rel="next"` } : {});
    }
    if (method === 'GET' && name !== null) {
      const found = find(name);
      return found === undefined ? json({ message: 'Not Found' }, 404) : json(found);
    }
    if (method === 'POST' && body !== undefined) {
      if (find(String(body.name)) !== undefined) {
        return json({ message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] }, 422);
      }
      const created = label(String(body.name), { color: String(body.color), description: (body.description as string | undefined) ?? null });
      labels.push(created);
      return json(created, 201);
    }
    if (method === 'PATCH' && name !== null && body !== undefined) {
      const found = find(name);
      if (found === undefined) return json({ message: 'Not Found' }, 404);
      if (typeof body.color === 'string') found.color = body.color;
      if (typeof body.description === 'string') found.description = body.description;
      if (body.archived === false) found.archived_at = null;
      return json(found);
    }
    return json({ message: 'Not Found' }, 404);
  };

  #contents(method: string, url: URL, body: Json | undefined): Response | null {
    const match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (match === null) return null;
    const repository = `${decodeURIComponent(match[1] ?? '')}/${decodeURIComponent(match[2] ?? '')}`;
    const rest = match[3] ?? '';
    const files = this.files.get(repository);
    if (files === undefined || rest.startsWith('/labels')) return null;
    if (method === 'GET' && rest === '') return json({ full_name: repository, default_branch: 'main' });
    if (method === 'GET' && rest === '/git/trees/main') {
      return json({ sha: 'x', truncated: false, tree: Object.keys(files).map((file) => ({ path: file, type: 'blob' })) });
    }
    if (method === 'GET' && rest.startsWith('/contents/')) {
      const file = rest.slice('/contents/'.length).split('/').map(decodeURIComponent).join('/');
      const content = files[file];
      if (content === undefined || url.searchParams.get('ref') !== 'main') return json({ message: 'Not Found' }, 404);
      return json({ type: 'file', encoding: 'base64', path: file, content: Buffer.from(content).toString('base64') });
    }
    const issues = this.issues.get(repository) ?? [];
    this.issues.set(repository, issues);
    if (method === 'GET' && rest === '/issues') return json(issues);
    if (method === 'POST' && rest === '/issues' && body !== undefined) {
      const number = issues.length + 1;
      const issue = { number, title: String(body.title), body: String(body.body), html_url: `https://github.com/${repository}/issues/${number}` };
      issues.push(issue);
      return json(issue, 201);
    }
    return null;
  }
}

/** Runs repo-init with the answers as piped input; returns the exit code and everything it printed. */
async function run(
  answers: string[],
  options: { github?: FakeRestGithub; env?: NodeJS.ProcessEnv; argv?: string[]; rootDir?: string } = {},
): Promise<{ code: number; text: string }> {
  const input = new PassThrough();
  input.end(answers.map((answer) => `${answer}\n`).join(''));
  let text = '';
  const output = new Writable({
    write(chunk, _encoding, done) {
      text += String(chunk);
      done();
    },
  });
  const code = await runRepoInit({
    argv: options.argv ?? [],
    env: options.env ?? { GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 'secret-token' },
    rootDir: options.rootDir ?? tempDir(),
    input,
    output,
    fetch: (options.github ?? new FakeRestGithub()).fetch,
  });
  return { code, text };
}

describe('repo-init labels', () => {
  it('plans creates and updates, matching label names case-insensitively', () => {
    const wanted = [
      { name: 'Model: opus', color: '5319e7', description: 'A' },
      { name: 'Model: sonnet', color: '1d76db', description: 'B' },
      { name: 'Model: haiku', color: '0e8a16', description: 'C' },
      { name: 'Model: claude-opus', color: '5319e7', description: '' },
      { name: 'Model: claude-sonnet', color: '1d76db', description: 'D' },
    ];
    const existing = [
      label('model: OPUS', { color: '5319E7', description: 'A' }),
      label('Model: sonnet', { color: '000000', description: 'old' }),
      label('Model: haiku', { color: '0e8a16', description: 'C', archived_at: '2026-05-01T00:00:00Z' }),
      label('Model: claude-opus', { color: '5319e7', description: null }),
    ];
    const plan = planLabelChanges(existing, wanted);
    assert.deepEqual(plan.map((change) => change.kind), ['ok', 'update', 'update', 'ok', 'create']);
    assert.deepEqual(plan[1]?.kind === 'update' && plan[1].differences, ['color 000000 → 1d76db', 'description']);
    assert.deepEqual(plan[2]?.kind === 'update' && plan[2].differences, ['archived']);
  });

  it('counts a label that appeared after planning as existing instead of failing', async () => {
    const github = new FakeRestGithub({ 'acme/app': [] });
    const client = new GithubRestClient({ token: 't', fetch: github.fetch });
    const changes = planLabelChanges([], [standardSpec('Model: opus')]);
    github.repos.get('acme/app')?.push(standard('Model: opus'));
    assert.deepEqual(await applyLabelChanges(client, 'acme/app', changes, false), { created: 0, updated: 0, existing: 1, failures: [] });
  });
});

describe('repo-init GitHub REST client', () => {
  it('sends API version 2026-03-10 with the token and follows pagination', async () => {
    const github = new FakeRestGithub({ 'acme/app': ['a', 'b', 'c', 'd', 'e'].map((name) => label(name)) });
    github.pageSize = 2;
    const labels = await new GithubRestClient({ token: 'secret-token', fetch: github.fetch }).listLabels('acme/app');
    assert.deepEqual(labels.map((entry) => entry.name), ['a', 'b', 'c', 'd', 'e']);
    assert.equal(github.requests.length, 3);
    for (const request of github.requests) {
      assert.equal(request.headers['x-github-api-version'], '2026-03-10');
      assert.equal(request.headers.authorization, 'Bearer secret-token');
      assert.equal(request.headers.accept, 'application/vnd.github+json');
    }
  });

  it('encodes label names in paths and explains failures', async () => {
    const github = new FakeRestGithub({ 'acme/app': [label('Model: opus')] });
    const client = new GithubRestClient({ token: 't', fetch: github.fetch });
    await client.updateLabel('acme/app', 'Model: opus', { color: '5319e7' });
    assert.equal(github.requests.at(-1)?.path, '/repos/acme/app/labels/Model%3A%20opus');
    assert.equal(await client.getLabel('acme/app', 'Model: nope'), null);

    await assert.rejects(client.createLabel('acme/app', { name: 'model: OPUS', color: 'ffffff', description: '' }), (error: unknown) => {
      return error instanceof GithubRestError && error.status === 422 && /Validation Failed \(name already_exists\)/.test(error.message);
    });
    await assert.rejects(client.listLabels('acme/missing'), /does not exist or the token cannot see it/);
    github.failures.set('GET /repos/acme/app/labels', { status: 403, body: { message: 'Resource not accessible by personal access token' } });
    await assert.rejects(client.listLabels('acme/app'), /HTTP 403: Resource not accessible by personal access token.*"repo" scope/);
    github.failures.set('GET /repos/acme/app/labels', { status: 401, body: { message: 'Bad credentials' } });
    await assert.rejects(client.listLabels('acme/app'), /rejected the token/);
  });

  it('does not follow pagination links to another host', async () => {
    const client = new GithubRestClient({
      token: 't',
      fetch: async () => json([], 200, { link: '<https://elsewhere.example/repos/acme/app/labels?page=2>; rel="next"' }),
    });
    await assert.rejects(client.listLabels('acme/app'), /unexpected pagination link/);
  });
});

const LARAVEL_BOOST = JSON.stringify({ require: { 'laravel/framework': '^12.0' }, 'require-dev': { 'laravel/boost': '^2.0' } });
const LARAVEL = JSON.stringify({ require: { 'laravel/framework': '^12.0' } });

describe('repo-init Laravel Boost', () => {
  it('plans per repository from the default branch: none, installed, open issue or create', async () => {
    const github = new FakeRestGithub();
    github.files.set('acme/site', { 'package.json': '{}', 'README.md': '' });
    github.files.set('acme/shop', { artisan: '', 'composer.json': LARAVEL_BOOST });
    github.files.set('acme/portal', { 'laravel/artisan': '', 'laravel/composer.json': LARAVEL, 'vendor/artisan': '', 'vendor/composer.json': LARAVEL });
    github.files.set('acme/old', { artisan: '', 'composer.json': LARAVEL });
    github.issues.set('acme/old', [
      { number: 3, title: BOOST_ISSUE_TITLE, html_url: 'https://github.com/acme/old/pull/3', pull_request: {} },
      { number: 4, title: BOOST_ISSUE_TITLE, html_url: 'https://github.com/acme/old/issues/4' },
    ]);
    const client = new GithubRestClient({ token: 't', fetch: github.fetch });
    assert.deepEqual(await planBoostSetup(client, 'acme/site'), { kind: 'none', truncated: false });
    assert.deepEqual(await planBoostSetup(client, 'acme/shop'), { kind: 'installed', apps: [{ dir: '', boost: true }] });
    assert.deepEqual(await planBoostSetup(client, 'acme/portal'), { kind: 'create', apps: [{ dir: 'laravel', boost: false }], truncated: false });
    assert.deepEqual(await planBoostSetup(client, 'acme/old'), {
      kind: 'open',
      apps: [{ dir: '', boost: false }],
      issue: { number: 4, url: 'https://github.com/acme/old/issues/4' },
    });
  });

  it('writes setup steps that work without a terminal and keep generated files out of git', () => {
    const body = boostIssueBody([{ dir: 'laravel', boost: false }]);
    assert.match(body, /Die Laravel-App in `laravel\/` hat Boost noch nicht\./);
    assert.match(body, /composer require laravel\/boost --dev/);
    assert.match(body, /APP_ENV=local php artisan boost:install --no-interaction --guidelines --skills --mcp/);
    assert.match(body, /"agents": \["claude_code"\]/);
    assert.match(body, /\/boost\.json\n {3}\/\.mcp\.json\n {3}\/\.claude\/skills\//);
    assert.match(body, /\.ai\/guidelines\//);
  });

  it('creates the issue after confirmation and skips repositories that need none', async () => {
    const env = { GITHUB_REPOSITORY: 'acme/portal,acme/shop', GITHUB_TOKEN: 't' };
    const github = new FakeRestGithub();
    github.files.set('acme/portal', { 'laravel/artisan': '', 'laravel/composer.json': LARAVEL });
    github.files.set('acme/shop', { artisan: '', 'composer.json': LARAVEL_BOOST });
    // all repositories, task 2, confirm, exit
    const first = await run(['', '2', '', '0'], { github, env });
    assert.equal(first.code, 0);
    assert.match(first.text, /acme\/portal\n {2}\+ create issue "Laravel Boost einrichten" \(laravel\/ without Boost\)/);
    assert.match(first.text, /acme\/shop\n {2}✓ Laravel Boost installed: \(root\) with Boost/);
    assert.match(first.text, /✓ acme\/portal: issue #1 https:\/\/github\.com\/acme\/portal\/issues\/1/);
    assert.match(first.text, /column Ready/);
    assert.equal(github.issues.get('acme/portal')?.[0]?.title, BOOST_ISSUE_TITLE);
    assert.equal(github.issues.get('acme/shop')?.length ?? 0, 0);

    const second = await run(['', '2', '0'], { github, env });
    assert.match(second.text, /= open issue #1 "Laravel Boost einrichten"/);
    assert.match(second.text, /No issue needed\./);
    assert.equal(github.issues.get('acme/portal')?.length, 1);
  });
});

describe('repo-init', () => {
  it('creates the missing standard labels and, when asked to, updates differing ones', async () => {
    const env = { GITHUB_REPOSITORY: 'acme/app, acme/web', GITHUB_TOKEN: 'secret-token' };
    const github = new FakeRestGithub({
      'acme/app': [
        label('bug', { color: 'd73a4a' }),
        label('model: sonnet', { color: '0052cc', description: 'old' }),
        { ...standard('Model: haiku'), archived_at: '2026-05-01T00:00:00Z' },
      ],
      'acme/web': [],
    });
    // all repositories, task 1, update the differing labels, confirm, exit
    const first = await run(['', '1', 'y', '', '0'], { github, env });
    assert.equal(first.code, 0);
    assert.match(first.text, /2 existing labels differ from the standard\. Update them\?/);
    assert.match(first.text, /Create 4 labels and update 2 labels\?/);
    assert.match(first.text, /✓ acme\/app: 1 created, 2 updated/);
    assert.match(first.text, /✓ acme\/web: 3 created/);
    for (const repository of ['acme/app', 'acme/web']) {
      const labels = github.repos.get(repository) ?? [];
      assert.ok(planLabelChanges(labels, STANDARD_LABELS).every((change) => change.kind === 'ok'), repository);
    }
    assert.ok(github.repos.get('acme/app')?.some((entry) => entry.name === 'bug'));

    const before = github.requests.length;
    const second = await run(['', '1', '0'], { github, env });
    assert.equal(second.code, 0);
    assert.match(second.text, /= all 3 labels up to date/);
    assert.match(second.text, /All standard labels are up to date\./);
    assert.ok(github.requests.slice(before).every((request) => request.method === 'GET'));
  });

  it('re-asks after invalid answers and changes nothing when the user declines', async () => {
    const github = new FakeRestGithub({ 'acme/app': [] });
    const result = await run(['7', '1', 'maybe', 'n'], { github });
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.text, /Which repositories\?/);
    assert.match(result.text, /Please enter a number from 0 to 2\./);
    assert.match(result.text, /Please answer y or n\./);
    assert.match(result.text, /Cancelled; nothing changed\./);
    assert.equal(github.mutations().length, 0);
  });

  it('reports repositories it cannot read, carries on with the others and exits with 1', async () => {
    const github = new FakeRestGithub({ 'acme/app': [] });
    const result = await run(['', '1', '', '0'], { github, env: { GITHUB_REPOSITORY: 'acme/missing,acme/app', GITHUB_TOKEN: 't' } });
    assert.equal(result.code, 1);
    assert.match(result.text, /acme\/missing\n {2}✗ cannot read the labels: not found \(HTTP 404\)/);
    assert.match(result.text, /✓ acme\/app: 3 created/);
  });

  it('explains missing or invalid configuration', async () => {
    const noRepository = await run([], { env: { GITHUB_TOKEN: 't' } });
    assert.equal(noRepository.code, 1);
    assert.match(noRepository.text, /GITHUB_REPOSITORY is not set/);
    assert.match((await run([], { env: { GITHUB_REPOSITORY: 'acme', GITHUB_TOKEN: 't' } })).text, /needs owner\/name entries \(got "acme"\)/);
    assert.match((await run([], { env: { GITHUB_REPOSITORY: 'acme/app' } })).text, /no GitHub token: set GITHUB_TOKEN or GH_TOKEN/);
    assert.equal((await run([], { argv: ['--bogus'] })).code, 2);
  });

  it('reads GITHUB_REPOSITORY and the token from the .env next to repo-init.ts', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, '.env'), 'GITHUB_REPOSITORY=acme/app\nGITHUB_TOKEN=from-file\n');
    const github = new FakeRestGithub({ 'acme/app': [] });
    const result = await run(['1', 'n'], { github, env: {}, rootDir: dir });
    assert.match(result.text, /Env file: +.*\.env/);
    assert.match(result.text, /Repository: acme\/app/);
    assert.equal(github.requests[0]?.headers.authorization, 'Bearer from-file');
  });

  it('prints usage with --help', () => {
    const script = path.resolve(import.meta.dirname, '../repo-init.ts');
    const result = spawnSync(process.execPath, [script, '--help'], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: repo-init/);
  });
});
