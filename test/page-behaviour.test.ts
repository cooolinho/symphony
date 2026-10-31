import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { after, before, describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { BRAIN_HTML } from '../src/http/brain-page.ts';
import { CHANGES_HTML } from '../src/http/changes-page.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { startHttpServer, type HttpServerHandle } from '../src/http/server.ts';
import { TASKS_HTML } from '../src/http/tasks-page.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, inlineScripts, makeWorkflow, reindentScripts, renderPage, tempDir, until } from './helpers.ts';
import { analyticsFixture, changeEntry, changesFixture, dashboardState, issueDetail, issueRow } from './helpers/page-fixtures.ts';

// Independent acceptance tests for E1-5 (#350): the page tests check behaviour in the fake DOM, not the page source.

const AGENT_URL = 'http://127.0.0.1/issue?id=acme%2Fapp%231';
const PAGES: Record<string, string> = { dashboard: DASHBOARD_HTML, agent: AGENT_HTML, logs: LOGS_HTML, changes: CHANGES_HTML, tasks: TASKS_HTML, brain: BRAIN_HTML };
const HOOKED = ['dashboard', 'agent', 'logs'];

/** The same page with the layout of its scripts changed: CRLF line ends, tabs, trailing blanks, blank lines. */
function reflowScripts(html: string): string {
  return html.replace(/<script>([\s\S]*?)<\/script>/g, (_all, code: string) => {
    const lines = code.split('\n').map((line) => '\t\t' + line.trimStart() + '   ');
    return `<script>\n\n${lines.join('\r\n\r\n')}\n\n</script>`;
  });
}

function request(port: number, method: string, url: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('renderPage (#350)', () => {
  it('runs the inline scripts, renders the state and returns a queryable tree', () => {
    const page = renderPage(DASHBOARD_HTML, dashboardState({ issues: [issueRow()] }));
    assert.ok(page.root.outerHTML.length > 1000, 'a real document tree');
    assert.throws(() => page.$('no-such-id'), /no-such-id/, 'a missing element is an error, not a silent null');
    assert.ok(page.query('a[href="/stats"]').length >= 1, 'selector queries reach the static markup');
  });

  it('shows the state that was passed in, and a changed state changes the result', () => {
    const issue = { issues: [issueRow({ title: 'Unique-Title-4711' })] };
    const empty = renderPage(DASHBOARD_HTML, dashboardState());
    const withIssue = renderPage(DASHBOARD_HTML, dashboardState(issue));
    assert.ok(!empty.root.outerHTML.includes('Unique-Title-4711'));
    assert.ok(withIssue.root.outerHTML.includes('Unique-Title-4711'));
    empty.render(dashboardState(issue));
    assert.ok(empty.root.outerHTML.includes('Unique-Title-4711'), 'render() again updates the same tree');
  });

  it('is deterministic: the same state gives the same tree (frozen clock)', () => {
    const state = () => dashboardState({ issues: [issueRow()] });
    assert.equal(renderPage(DASHBOARD_HTML, state()).root.outerHTML, renderPage(DASHBOARD_HTML, state()).root.outerHTML);
    const detail = () => ({ detail: issueDetail() });
    assert.equal(renderPage(AGENT_HTML, detail(), { url: AGENT_URL }).root.outerHTML, renderPage(AGENT_HTML, detail(), { url: AGENT_URL }).root.outerHTML);
  });

  it('answers the page fetches with the fake and records them; nothing reaches a network', async () => {
    const page = renderPage(LOGS_HTML, undefined, { fetch: () => analyticsFixture() });
    await until(() => page.fetches.length > 0, 3_000, 'a fetch call');
    assert.equal(page.fetches[0]?.method, 'GET');
    assert.ok(page.fetches.every((f) => f.url.startsWith('/')), 'only same-origin paths are asked');
  });
});

describe('the render hook is inert without the test flag (#350)', () => {
  it('only dashboard, agent and logs carry a hook, and every hook is guarded by the same flag', () => {
    for (const [name, html] of Object.entries(PAGES)) {
      const hits = (html.match(/__SYMPHONY_TEST__/g) ?? []).length;
      assert.equal(hits, HOOKED.includes(name) ? 1 : 0, name);
    }
  });

  it('without the flag the scripts still load and no window.__render exists', () => {
    for (const name of HOOKED) {
      const off = (PAGES[name] as string).replaceAll('__SYMPHONY_TEST__', '__SYMPHONY_TEST_OFF__');
      const page = renderPage(off, undefined, { url: name === 'agent' ? AGENT_URL : undefined });
      assert.throws(() => page.render({}), /__render/, `${name}: the hook is only installed under the flag`);
    }
  });
});

describe('page behaviour does not depend on the layout of the scripts (#350)', () => {
  const renderers: Array<[string, (html: string) => Promise<string>]> = [
    ['dashboard', async (html) => renderPage(html, dashboardState({ issues: [issueRow()] })).root.outerHTML],
    ['agent', async (html) => renderPage(html, { detail: issueDetail(), online: true }, { url: AGENT_URL }).root.outerHTML],
    [
      'logs',
      async (html) => {
        const page = renderPage(html, undefined, { fetch: () => analyticsFixture() });
        await until(() => /tone-green/.test(page.$('shell-live').className), 3_000, 'logs rendered');
        return page.root.outerHTML;
      },
    ],
  ];

  for (const [name, render] of renderers) {
    it(`${name}: re-indented and re-flowed scripts render the identical tree`, async () => {
      const html = PAGES[name] as string;
      const original = await render(html);
      assert.notEqual(reindentScripts(html), html, 'the variant really differs');
      assert.notEqual(reflowScripts(html), html, 'the variant really differs');
      assert.equal(await render(reindentScripts(html)), original, 're-indented');
      assert.equal(await render(reflowScripts(html)), original, 're-flowed');
    });
  }
});

describe('inline scripts of every page parse (#350)', () => {
  let server: HttpServerHandle;
  before(async () => {
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
      runner: new FakeRunner(),
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker(),
    });
    server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
  });
  after(async () => {
    await server.close();
  });

  it('serves six pages over HTTP, each with inline scripts that compile', async () => {
    const routes = ['/', '/changes', '/tasks', '/brain', '/stats', '/issue?id=acme%2Fapp%231'];
    for (const route of routes) {
      const res = await request(server.port, 'GET', route);
      assert.equal(res.status, 200, route);
      assert.match(res.headers['content-type'] ?? '', /^text\/html/, route);
      const scripts = inlineScripts(res.body);
      assert.ok(scripts.length > 0, `${route} has inline scripts`);
      scripts.forEach((code, i) => assert.doesNotThrow(() => new vm.Script(code, { filename: `${route}#${i}.js` }), route));
    }
  });

  it('redirects the former routes with Status, Location and no body', async () => {
    for (const [from, to] of [['/logs', '/stats'], ['/agent?id=acme%2Fapp%231', '/issue?id=acme%2Fapp%231']] as const) {
      const res = await request(server.port, 'GET', from);
      assert.equal(res.status, 301, from);
      assert.equal(res.headers.location, to, from);
    }
  });

  it('the constants of all six pages compile as well (no page escapes the check)', () => {
    for (const [name, html] of Object.entries(PAGES)) {
      const scripts = inlineScripts(html);
      assert.ok(scripts.length > 0, name);
      scripts.forEach((code) => assert.doesNotThrow(() => new vm.Script(code, { filename: `${name}.js` }), name));
    }
  });
});

describe('the four converted test files check the rendered result, not the page source (#350)', () => {
  const dir = import.meta.dirname;
  const files = ['http', 'stage-results-dashboard', 'repositories-dashboard', 'gate-run'].map((n) => path.join(dir, `${n}.test.ts`));

  it('do not cut functions out of the page source or run the page constants in a bare vm', () => {
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const name = path.basename(file);
      assert.doesNotMatch(text, /functionSource\s*\(/, `${name}: functionSource`);
      assert.doesNotMatch(text, /\b(DASHBOARD|AGENT|LOGS)_HTML\.(slice|substring|substr|indexOf)\(/, `${name}: slicing the page source`);
      assert.doesNotMatch(text, /vm\.runInContext\([^)]*_HTML/, `${name}: running page source directly`);
      assert.doesNotMatch(text, /(DASHBOARD|AGENT|LOGS)_HTML\.includes\(\s*['"`][^'"`]*(=>|const |function |\.textContent|\.className)/, `${name}: JS fragment asserts`);
    }
  });
});

describe('changes page (E6-3a)', () => {
  const URL_FILTERED = 'http://127.0.0.1/changes?type=code&repo=acme%2Fapp';
  const open = (data: (url: string) => unknown, url = URL_FILTERED) =>
    renderPage(CHANGES_HTML, undefined, { url, fetch: (u) => (u.startsWith('/api/v1/state') ? dashboardState({ health: { repositories: ['acme/app', 'acme/lib'] } }) : data(u)) });
  const feed = (page: ReturnType<typeof renderPage>) => page.$('changes-feed');

  it('takes the filter from the URL and reloads on a chip click', async () => {
    const page = open(() => changesFixture());
    await until(() => page.query('.chg').length === 1, 3_000, 'feed rendered');
    const chips = page.query('#changes-types .ui-fchip');
    assert.deepEqual(chips.map((c) => [c.getAttribute('data-type'), c.getAttribute('aria-pressed')]), [['all', 'false'], ['code', 'true'], ['brain', 'false']]);
    assert.match(chips[0]!.textContent, /Alle\s*3/);
    assert.equal((page.$('changes-repo') as unknown as { value: string }).value, 'acme/app');
    assert.deepEqual(page.query('#changes-repo option').map((o) => o.textContent), ['Alle Repositories', 'acme/app', 'acme/lib']);
    const first = page.fetches.find((f) => f.url.startsWith('/api/v1/changes'))!;
    assert.match(first.url, /type=code/);
    assert.match(first.url, /repo=acme%2Fapp/);
    const before = page.fetches.length;
    page.click(chips[2]!);
    await until(() => page.fetches.length > before, 3_000, 'reload');
    assert.match(page.fetches.at(-1)!.url, /type=brain/);
  });

  it('renders entries with bars, links and chips, and escapes the title', async () => {
    const page = open(() =>
      changesFixture({
        entries: [
          changeEntry({ title: '<b>bold</b>', status: 'merged' }),
          changeEntry({ id: 'brain:1', type: 'brain', pr: null, title: 'Note', files: [{ path: 'brain/x.md', added: 1, deleted: 0, status: 'added' }], diff: '+hi' }),
        ],
      }),
    );
    await until(() => page.query('.chg').length === 2, 3_000, 'entries');
    const [code, brain] = page.query('.chg');
    assert.equal(code!.querySelector('.chg-title')!.textContent, '<b>bold</b>');
    assert.equal(code!.querySelector('b'), null);
    assert.deepEqual(code!.querySelectorAll('.chg-bar-add').map((b) => b.style.width), ['100%', '20%']);
    assert.deepEqual(code!.querySelectorAll('.chg-bar-del').map((b) => b.style.width), ['0%', '30%']);
    assert.ok(code!.querySelector('.chg-add')!.className.includes('mono'));
    assert.ok(code!.querySelector('.chg-del')!.className.includes('mono'));
    assert.equal(code!.querySelector('a')!.getAttribute('href'), '/issue?id=acme%2Fapp%231');
    assert.equal(code!.querySelector('.chg-pr')!.textContent, '#7');
    assert.equal(code!.querySelector('.chg-status')!.textContent, 'merged');
    assert.ok(brain!.querySelector('.chg-note'));
    assert.equal(brain!.querySelector('.chg-pr'), null);
  });

  it('shows "Mehr laden" only with next_before and appends the next page', async () => {
    const page = open((u) =>
      u.includes('before=') ? changesFixture({ entries: [changeEntry({ id: 'code:acme/app:def' })], next_before: null }) : changesFixture({ next_before: 'code:acme/app:abc' }),
    );
    await until(() => page.query('#changes-more button').length === 1, 3_000, 'more button');
    assert.equal(page.query('#changes-more button')[0]!.textContent, 'Mehr laden');
    page.click(page.query('#changes-more button')[0]!);
    await until(() => page.query('.chg').length === 2, 3_000, 'second page');
    assert.match(page.fetches.at(-1)!.url, /before=code%3Aacme%2Fapp%3Aabc/);
    assert.equal(page.query('#changes-more button').length, 0);
  });

  it('shows the empty state and the side figures', async () => {
    const empty = open(() => changesFixture({ entries: [], counts: { all: 0, code: 0, brain: 0 } }));
    await until(() => /Noch keine Änderungen\./.test(feed(empty).textContent), 3_000, 'empty state');
    assert.equal(empty.query('#changes-more button').length, 0);
    const page = open(() => changesFixture());
    await until(() => /×5/.test(page.$('changes-hotspots').textContent), 3_000, 'hotspots');
    assert.match(page.$('changes-hotspots').textContent, /src\/a\.ts/);
    assert.match(page.$('changes-today').textContent, /Commits/);
    assert.match(page.$('changes-today').textContent, /\+12/);
  });
});
