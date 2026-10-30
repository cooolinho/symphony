import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { startHttpServer } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { configuredRepositories } from '../src/tracker/github-project/settings.ts';
import { parseWorkflow } from '../src/workflow/loader.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, renderPage, tempDir } from './helpers.ts';
import { dashboardState } from './helpers/page-fixtures.ts';

// Acceptance tests of #277 (connected repositories in the dashboard), derived from the issue: the repositories of
// GITHUB_REPOSITORY show up in GET /api/v1/state (health.repositories) and as links on the dashboard.

function get(port: number, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: urlPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Serves a dashboard for a front matter + env and returns /api/v1/state and the dashboard page. */
async function serve(front: Record<string, unknown>, env: NodeJS.ProcessEnv) {
  const orchestrator = new Orchestrator({
    workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), front), { env })),
    runner: new FakeRunner(),
    logger: Logger.silent(),
    env,
    logDir: null,
    timers: new ManualTimers(),
    createAdapter: () => new FakeTracker(),
  });
  const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
  try {
    const state = await get(server.port, '/api/v1/state');
    assert.equal(state.status, 200, state.body);
    const page = await get(server.port, '/');
    assert.equal(page.status, 200);
    return { state: JSON.parse(state.body), page: page.body };
  } finally {
    await server.close();
  }
}

const provider = (repositories?: unknown) => ({
  tracker: {
    kind: 'github_project',
    provider: { owner: 'acme', project_number: 1, token: 'test-token', ...(repositories !== undefined ? { repositories } : {}) },
  },
});

describe('GET /api/v1/state: health.repositories (#277)', () => {
  it('lists one repository from $GITHUB_REPOSITORY', async () => {
    const { state } = await serve(provider('$GITHUB_REPOSITORY'), { GITHUB_REPOSITORY: 'acme/app' });
    assert.deepEqual(state.health.repositories, ['acme/app']);
  });

  it('lists every comma-separated repository once, in configuration order', async () => {
    const { state } = await serve(provider('$GITHUB_REPOSITORY'), { GITHUB_REPOSITORY: 'zeta/z, acme/app,acme/api,  zeta/z' });
    assert.deepEqual(state.health.repositories, ['zeta/z', 'acme/app', 'acme/api']);
  });

  it('splits on whitespace and newlines as well, and deduplicates case-insensitively', async () => {
    const { state } = await serve(provider('$R'), { R: 'acme/app\nacme/api   Acme/APP,\tother/lib' });
    assert.deepEqual(state.health.repositories, ['acme/app', 'acme/api', 'other/lib']);
  });

  it('accepts the list notation of WORKFLOW.md, with $VAR entries', async () => {
    const source = [
      '---',
      'tracker:',
      '  kind: github_project',
      '  provider:',
      '    project_number: 1',
      '    owner: acme',
      '    token: test-token',
      '    repositories:',
      '      - acme/app',
      '      - $SECOND',
      '      - acme/app',
      '---',
      'Work on {{ issue.identifier }}',
    ].join('\n');
    const front = parseWorkflow(source).config;
    const { state } = await serve(front as Record<string, unknown>, { SECOND: 'other/lib' });
    assert.deepEqual(state.health.repositories, ['acme/app', 'other/lib']);
  });

  it('is null without a restriction (setting absent, empty or the variable unset)', async () => {
    assert.equal((await serve(provider(), {})).state.health.repositories, null);
    assert.equal((await serve(provider(''), {})).state.health.repositories, null);
    assert.equal((await serve(provider('$GITHUB_REPOSITORY'), {})).state.health.repositories, null);
    assert.equal((await serve(provider([]), {})).state.health.repositories, null);
  });

  it('never lists entries that are not owner/name (no broken or script links)', async () => {
    const { state } = await serve(provider('$R'), { R: 'acme/app javascript:alert(1) <b>x</b>/y a/b/c nonsense acme/<img>' });
    assert.deepEqual(state.health.repositories, ['acme/app']);
  });

  it('keeps the existing health fields', async () => {
    const { state } = await serve(provider('$R'), { R: 'acme/app' });
    for (const key of ['tracker_kind', 'active_states', 'terminal_states', 'poll_interval_ms', 'dispatch_errors', 'max_concurrent_agents']) {
      assert.ok(key in state.health, key);
    }
    assert.equal(state.health.tracker_kind, 'github_project');
  });
});

describe('configuredRepositories edge cases (#277)', () => {
  it('ignores non-string and blank list entries and does not split list entries', () => {
    assert.deepEqual(configuredRepositories(['acme/app', 7, null, '  ', ' acme/api '], {}), ['acme/app', 'acme/api']);
  });

  it('does not mutate the input list', () => {
    const list = ['acme/a', 'acme/A'];
    configuredRepositories(list, {});
    assert.deepEqual(list, ['acme/a', 'acme/A']);
  });
});

describe('dashboard page: repositories bar (#277)', () => {
  it('is served first in <main>, before the existing sections, which are all still there', async () => {
    const { page } = await serve(provider('$R'), { R: 'acme/app' });
    const bar = page.indexOf('id="repositories"');
    assert.ok(bar > page.indexOf('<main id="main">'), 'bar inside main');
    for (const id of ['problems', 'dispatch-gate', 'model-holds', 'model-controls', 'running-section', 'next-section', 'waiting-section', 'paused-section']) {
      const at = page.indexOf(`id="${id}"`);
      assert.ok(at > bar, `${id} comes after the repositories bar`);
    }
    assert.match(page, /<dl class="sysinfo"/);
    assert.match(page, /id="repo-list"/);
  });

  it('is hidden until a snapshot arrives and shows its label', () => {
    assert.match(DASHBOARD_HTML, /<section id="repositories"[^>]*\bhidden\b/);
    assert.match(DASHBOARD_HTML, />Repositories<\/span>/);
  });

  it('wraps long chip lists and never overflows its container', () => {
    assert.match(DASHBOARD_HTML, /\.repos \{[^}]*flex-wrap: wrap/);
    assert.match(DASHBOARD_HTML, /\.repo-list \{[^}]*flex-wrap: wrap/);
    assert.match(DASHBOARD_HTML, /\.repo-list \{[^}]*min-width: 0/);
    assert.match(DASHBOARD_HTML, /\.repo-chip \{[^}]*max-width: 100%/);
  });

  it('is shown and the header goes live when a snapshot is rendered', () => {
    const page = renderPage(DASHBOARD_HTML);
    assert.equal(page.$('repositories').hidden, true);
    page.render(withRepositories(['acme/app']));
    assert.equal(page.$('repositories').hidden, false);
    assert.ok(page.$('shell-live').classList.contains('tone-green'));
  });
});

const withRepositories = (repositories: unknown) => dashboardState({ health: { ...dashboardState().health, repositories } });

describe('dashboard client: renderRepositories through the page (#277)', () => {
  const run = (repositories: unknown, again?: unknown) => {
    const page = renderPage(DASHBOARD_HTML, withRepositories(repositories));
    if (again !== undefined) page.render(withRepositories(again));
    return page;
  };

  it('shows every repository as an owner/name link to GitHub, in order, opening safely in a new tab', () => {
    const page = run(['acme/app', 'acme/api', 'other/lib']);
    const chips = page.$('repo-list').children;
    assert.deepEqual(chips.map((c) => c.textContent), ['acme/app', 'acme/api', 'other/lib']);
    assert.deepEqual(chips.map((c) => c.href), ['https://github.com/acme/app', 'https://github.com/acme/api', 'https://github.com/other/lib']);
    for (const chip of chips) {
      assert.equal(chip.tagName, 'a');
      assert.match(chip.className, /\bchip\b/);
      assert.equal(chip.target, '_blank');
      assert.match(chip.rel, /noopener/);
    }
    assert.equal(page.$('repositories').hidden, false);
  });

  it('sets names as text, never as markup (no XSS)', () => {
    const evil = '"><img src=x onerror=alert(1)>/<script>alert(2)</script>';
    const [chip] = run([evil]).$('repo-list').children;
    assert.equal(chip!.textContent, evil);
    assert.equal(chip!.children.length, 0);
  });

  it('shows a hint instead of links without a restriction, also for an empty list or a missing field', () => {
    for (const repositories of [null, [], undefined]) {
      const chips = run(repositories).$('repo-list').children;
      assert.equal(chips.length, 1);
      assert.equal(chips[0]!.textContent, 'all repositories on the board');
      assert.equal(chips[0]!.tagName, 'span');
      assert.equal(chips[0]!.href, '');
    }
  });

  it('replaces the chips when the list changes', () => {
    const grown = run(['a/b'], ['a/b', 'c/d', 'e/f']).$('repo-list').children;
    assert.deepEqual(grown.map((c) => c.textContent), ['a/b', 'c/d', 'e/f']);
    const shrunk = run(['a/b', 'c/d', 'e/f'], ['c/d']).$('repo-list').children;
    assert.deepEqual(shrunk.map((c) => c.href), ['https://github.com/c/d']);
    const cleared = run(['a/b'], null).$('repo-list').children;
    assert.deepEqual(cleared.map((c) => c.textContent), ['all repositories on the board']);
  });
});
