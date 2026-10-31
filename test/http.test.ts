import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { PricingStore } from '../src/costs/pricing.ts';
import { HistoryLog } from '../src/history/history.ts';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { BOOST_ICON_URI } from '../src/http/icons.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { CHANGES_HTML } from '../src/http/changes-page.ts';
import { TASKS_HTML } from '../src/http/tasks-page.ts';
import { BRAIN_HTML } from '../src/http/brain-page.ts';
import { LAYOUT_CSS, LAYOUT_JS, NAV_ITEMS, page as shellPage } from '../src/http/ui/layout.ts';
import { TOKENS_CSS } from '../src/http/ui/tokens.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { SYMPHONY_VERSION } from '../src/version.ts';
import { analyticsFixture, dashboardState, issueDetail, issueRow } from './helpers/page-fixtures.ts';
import { FakeElement } from './helpers/fake-dom.ts';
import { startHttpServer, type HttpServerHandle } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { SystemCollector } from '../src/system/metrics.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeIssue, makeWorkflow, inlineScripts, reindentScripts, renderPage, tempDir, until } from './helpers.ts';

/** Raw request so tests can set the Host header freely. */
function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const AGENT_URL = 'http://127.0.0.1/issue?id=acme%2Fapp%231';

describe('dashboard pages', () => {
  it('share the glass tokens CSS without external URLs', () => {
    for (const [name, html] of Object.entries({ dashboard: DASHBOARD_HTML, agent: AGENT_HTML, logs: LOGS_HTML })) {
      assert.ok(html.includes(TOKENS_CSS), `${name} embeds the tokens CSS`);
      const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1] as string).join('\n');
      assert.doesNotMatch(styles, /https?:\/\//, `${name} CSS has no external URL`);
      assert.doesNotMatch(styles, /@import|@font-face|url\(/, `${name} CSS loads no resources`);
    }
    const block = (marker: string): string => {
      const start = TOKENS_CSS.indexOf(marker);
      assert.ok(start >= 0, marker);
      let depth = 0;
      for (let i = TOKENS_CSS.indexOf('{', start); i < TOKENS_CSS.length; i++) {
        if (TOKENS_CSS[i] === '{') depth++;
        if (TOKENS_CSS[i] === '}' && --depth === 0) return TOKENS_CSS.slice(start, i + 1);
      }
      throw new Error(`unbalanced ${marker}`);
    };
    const motion = block('@media (prefers-reduced-motion: reduce)');
    assert.match(motion, /animation: none/);
    assert.match(motion, /transition: none/);
    const transparency = block('@media (prefers-reduced-transparency: reduce)');
    assert.match(transparency, /var\(--solid\)/);
    assert.match(transparency, /backdrop-filter: none/);
    assert.match(TOKENS_CSS, /--solid: #111a2c/);

    assert.ok(TOKENS_CSS.includes('#070b16'));
    const roles = { analyst: '#38bdf8', architect: '#a78bfa', developer: '#34d399', tester: '#fbbf24', docs: '#cbd5e1', reviewer: '#f472b6', security: '#fb923c', symphony: '#94a3b8' };
    for (const [role, hex] of Object.entries(roles)) assert.ok(TOKENS_CSS.includes(`--role-${role}: ${hex}`), role);
    for (const token of ['--st-run', '--st-warn', '--st-error', '--st-wait']) assert.ok(TOKENS_CSS.includes(token + ':'), token);
    assert.ok(TOKENS_CSS.includes('.g {') && TOKENS_CSS.includes('.gi {'));
    assert.ok(TOKENS_CSS.includes('backdrop-filter: blur('));
    assert.ok(TOKENS_CSS.includes('button:focus-visible') && TOKENS_CSS.includes('a:focus-visible'));
    assert.ok(TOKENS_CSS.includes('min-height: 44px'));

    // Animations and transitions only touch transform and opacity.
    const keyframes = [...TOKENS_CSS.matchAll(/@keyframes [\w-]+/g)];
    assert.ok(keyframes.length > 0);
    for (const frame of keyframes) {
      const body = block(frame[0]);
      const props = [...body.matchAll(/([\w-]+)\s*:/g)].map((match) => match[1]);
      for (const prop of props) assert.ok(['transform', 'opacity'].includes(prop as string), `${frame[0]} animates ${prop}`);
    }
    for (const match of TOKENS_CSS.matchAll(/transition:([^;}]*)/g)) {
      assert.match((match[1] as string).replace(/\s*!important/, ""), /^\s*(none|(transform|opacity)\b[^,]*(,\s*(transform|opacity)\b[^,]*)*)\s*$/);
    }
  });

  const ALL_PAGES = { dashboard: DASHBOARD_HTML, agent: AGENT_HTML, logs: LOGS_HTML, changes: CHANGES_HTML, tasks: TASKS_HTML, brain: BRAIN_HTML };

  it('load in a fake DOM without errors, every page', () => {
    for (const [name, html] of Object.entries(ALL_PAGES)) {
      const page = renderPage(html, undefined, name === 'agent' ? { url: AGENT_URL } : {});
      assert.ok(page.$('main'), name);
    }
  });

  it('behave the same when the inline scripts are indented differently', () => {
    const fixtures: Array<[string, string, unknown, string?]> = [
      ['dashboard', DASHBOARD_HTML, dashboardState({ issues: [issueRow({ labels: ['needs-human'], budget: { cost_usd: 9, max_issue_cost_usd: 10 } })], counts: { ...dashboardState().counts, running: 1 } })],
      ['agent', AGENT_HTML, { detail: issueDetail({ results: [{ role: 'developer', kind: 'implementation', verdict: 'done', round: null, target: 'Agent review', summary: 'Done.', created_at: '2026-10-30T11:00:00Z', url: 'https://github.com/acme/app/issues/1#issuecomment-1', findings: [], blockers: [] }] }) }, AGENT_URL],
      ['logs', LOGS_HTML, undefined],
    ];
    for (const [name, html, fixture, url] of fixtures) {
      assert.notEqual(reindentScripts(html), html, name);
      const opts = url ? { url } : {};
      const a = renderPage(html, fixture, opts);
      const b = renderPage(reindentScripts(html), fixture, opts);
      assert.equal(b.$('main').outerHTML, a.$('main').outerHTML, name);
      assert.deepEqual(b.fetches, a.fetches, name);
    }
  });

  it('ship inline scripts that parse and the Laravel Boost icon', () => {
    for (const [name, html] of Object.entries(ALL_PAGES)) {
      const scripts = inlineScripts(html);
      assert.ok(scripts.length > 0, name);
      for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script, { filename: `${name}.js` }), name);
    }
    for (const [name, html] of Object.entries({ dashboard: DASHBOARD_HTML, agent: AGENT_HTML, logs: LOGS_HTML })) {
      assert.ok(html.includes(BOOST_ICON_URI), `${name} embeds the Boost icon`);
    }
    assert.match(BOOST_ICON_URI, /^data:image\/svg\+xml;base64,/);
    assert.match(Buffer.from(BOOST_ICON_URI.split(',')[1] as string, 'base64').toString('utf8'), /^<svg [^>]*viewBox="0 0 64 64"/);
  });
});

describe('http extension', () => {
  let server: HttpServerHandle;
  const timers = new ManualTimers();

  before(async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
    const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
    const historyLog = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
    historyLog.runFinished({
      repo: 'acme/app', issue: 'acme/app#1', title: 'First', run: 'r1', session: null, attempt: null, outcome: 'handed_off',
      state: 'In review', reason: 'done', turns: 1, startedAt: new Date('2026-10-04T08:00:00Z'), finishedAt: new Date('2026-10-04T08:01:00Z'),
      agentSeconds: 60, usage: { 'claude-opus-5-5': { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 } }, claudeEstimateUsd: null,
    });
    historyLog.stageResult({
      repo: 'acme/app', issue: 'acme/app#1', run: 'r1', role: 'developer', kind: 'implementation', verdict: 'done', round: null, target: 'Agent review',
      profile: 'bugfix', complexity: 'S', findings: 0, at: new Date('2026-10-04T08:01:00Z'),
    });
    historyLog.stageResult({
      repo: 'acme/app', issue: 'acme/app#1', run: 'r2', role: 'reviewer', kind: 'review', verdict: 'approved', round: 1, target: 'In review',
      profile: 'bugfix', complexity: 'S', findings: 0, at: new Date('2026-10-04T08:05:00Z'),
    });
    historyLog.note('other/repo', 'workspace_removed', { issue: 'other/repo#2', state: 'Done' });
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
      runner: new FakeRunner(),
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers,
      createAdapter: () => new FakeTracker(),
    });
    server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent(), history: { dir: historyLog.dir, pricing } });
  });

  after(async () => {
    await server.close();
  });

  it('answers /api/v1/system without a collector instead of an issue 404', async () => {
    const res = await request(server.port, 'GET', '/api/v1/system');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { current: null, history: [], gpu: null, cpu_count: null });
  });

  it('serves the dashboard and the state snapshot', async () => {
    const page = await request(server.port, 'GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>Symphony<\/title>/);
    assert.ok(page.body.includes(TOKENS_CSS), 'dashboard embeds the tokens CSS');
    assert.match(page.body, /<nav class="shell-nav" aria-label="Hauptnavigation">/);
    // Markup of the sections; what the page script does with them is covered by 'dashboard page behaviour'.
    assert.doesNotMatch(page.body, /Issues in flight/);
    for (const name of ['running', 'next', 'waiting', 'paused']) {
      assert.match(page.body, new RegExp(`<div class="agents[^"]*" id="${name}"></div>`));
      assert.match(page.body, new RegExp(`<span class="count" id="${name}-count"></span>`));
    }
    for (const name of ['next', 'waiting', 'paused']) assert.match(page.body, new RegExp(`<section class="agents-section queue-section" id="${name}-section"[^>]*hidden>`));
    assert.match(page.body, /id="blocked-section"/);
    assert.match(page.body, /id="refresh"/);
    assert.match(page.body, /\.pipe-verdict\.vd-warn/);
    assert.match(page.body, /\.pipe-node\.st-skipped/);
    assert.match(page.body, /<section id="dispatch-gate" class="dispatch-gate" role="status" hidden>/);
    assert.match(page.body, /<section id="model-holds" class="dispatch-gate model-holds" role="status" hidden>/);
    assert.doesNotMatch(page.body, /\bonclick=/);
    assert.match(page.body, /<div class="slot-settings" id="slot-settings" role="group" aria-label="Agent slots" hidden><\/div>/);

    const state = await request(server.port, 'GET', '/api/v1/state');
    assert.equal(state.status, 200);
    const body = JSON.parse(state.body);
    assert.deepEqual(Object.keys(body.counts), ['running', 'forced', 'retrying', 'paused', 'claimed', 'queued', 'blocked']);
    assert.ok(Array.isArray(body.issues) && Array.isArray(body.blocked) && Array.isArray(body.queue));
    assert.deepEqual(Object.keys(body.pipeline_config), ['board_columns', 'roles', 'blocked_states']);
    assert.deepEqual(Object.keys(body.agent_totals), ['input_tokens', 'output_tokens', 'total_tokens', 'seconds_running', 'cost_usd', 'claude_estimate_usd']);
    assert.ok(Array.isArray(body.running) && Array.isArray(body.retrying));
    assert.deepEqual(Object.keys(body), [
      'generated_at',
      'counts',
      'issues',
      'queue',
      'blocked',
      'board_fetched_at',
      'pipeline_config',
      'running',
      'retrying',
      'paused',
      'model_holds',
      'model_controls',
      'limits',
      'agent_totals',
      'rate_limits',
      'health',
      'controls',
    ]);
    assert.deepEqual(body.model_holds, []);
    assert.equal(body.health.dispatch_gate, null);
  });

  it('links the logs page from the dashboard and serves it', async () => {
    const dashboard = (await request(server.port, 'GET', '/')).body;
    assert.match(dashboard, /href="\/stats"/);
    // The Logs button opens a drawer fed by the history API; the link stays as a fallback.
    assert.match(dashboard, /role="dialog"[^>]*aria-labelledby="logs-title"/);
    const page = await request(server.port, 'GET', '/stats');
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>Statistik · Symphony<\/title>/);
    assert.ok(page.body.includes(TOKENS_CSS), 'logs page embeds the tokens CSS');
  });

  it('serves all page routes in the shell (E1-4)', async () => {
    const pages: Array<[string, string | null, string]> = [
      ['/', 'href="/" aria-current="page"', 'Symphony'],
      ['/changes', 'href="/changes" aria-current="page"', 'Changes'],
      ['/tasks', 'href="/tasks" aria-current="page"', 'Tasks'],
      ['/brain', 'href="/brain" aria-current="page"', 'Brain'],
      ['/stats', 'href="/stats" aria-current="page"', 'Statistik'],
      ['/issue?id=acme%2Fapp%231', null, 'Issue'],
    ];
    for (const [path, current, text] of pages) {
      const res = await request(server.port, 'GET', path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers['content-type'] ?? '', /text\/html/, path);
      if (current !== null) assert.ok(res.body.includes(current), `${path} marks its navigation entry`);
      assert.ok(res.body.includes(text), path);
    }
    const issue = (await request(server.port, 'GET', '/issue?id=acme%2Fapp%231')).body;
    assert.ok(issue.includes('id="crumb-current" aria-current="page">Issue<'));
    const placeholders: Array<[string, string]> = [['/changes', 'Changes'], ['/tasks', 'Tasks'], ['/brain', 'Brain']];
    for (const [path, title] of placeholders) {
      const res = await request(server.port, 'GET', path);
      assert.ok(res.body.includes('Diese Seite kommt in Kürze.'), path);
      assert.ok(res.body.includes(`<h1 id="page-title">${title}</h1>`), path);
      const head = await request(server.port, 'HEAD', path);
      assert.equal(head.status, 200);
      assert.equal(head.body, '');
      const post = await request(server.port, 'POST', path);
      assert.equal(post.status, 405);
      assert.equal(post.headers.allow, 'GET, HEAD');
    }
  });

  it('redirects the former page paths with 301 and keeps the query (E1-4)', async () => {
    const cases: Array<[string, string]> = [
      ['/logs', '/stats'],
      ['/logs?period=7d', '/stats?period=7d'],
      ['/agent?id=repo%2F1', '/issue?id=repo%2F1'],
    ];
    for (const [from, to] of cases) {
      for (const method of ['GET', 'HEAD']) {
        const res = await request(server.port, method, from);
        assert.equal(res.status, 301, `${method} ${from}`);
        assert.equal(res.headers.location, to);
      }
    }
    assert.equal((await request(server.port, 'DELETE', '/logs')).status, 405);
  });

  it('applies the host check to every page route and redirect (E1-4)', async () => {
    for (const path of ['/', '/changes', '/tasks', '/brain', '/stats', '/issue?id=x', '/logs', '/agent?id=x']) {
      for (const host of ['evil.example:80', 'bad host']) {
        const res = await request(server.port, 'GET', path, { host });
        assert.equal(res.status, 403, `${path} with Host ${host}`);
        assert.equal(JSON.parse(res.body).error.code, 'forbidden_host');
        assert.equal(res.headers.location, undefined);
      }
    }
  });

  it('keeps the old routes out of the client links (E1-4)', () => {
    for (const html of [DASHBOARD_HTML, LOGS_HTML, AGENT_HTML]) {
      assert.doesNotMatch(html, /href="\/logs"|\/agent\?id=/);
    }
    assert.ok(DASHBOARD_HTML.includes('href="/stats"'));
    const hrefs = (page: { query(sel: string): Array<{ href: string }> }) => page.query('a').map((a) => a.href).filter(Boolean);
    const dashboard = renderPage(DASHBOARD_HTML, dashboardState({ issues: [issueRow()] }));
    assert.ok(hrefs(dashboard).includes('/issue?id=acme%2Fapp%231'), 'the dashboard card links the issue page');
    assert.ok(hrefs(dashboard).every((href) => !/^\/(logs|agent)\b/.test(href)));
    const logs = renderPage(LOGS_HTML, analyticsFixture());
    const logHrefs = hrefs(logs);
    assert.ok(logHrefs.some((href) => href.startsWith('/issue?id=')), 'the stats page links issues to /issue');
    assert.ok(logHrefs.every((href) => !/^\/(logs|agent)\b/.test(href)));
  });

  it('serves history statistics for all repositories or one, and the raw log', async () => {
    const all = JSON.parse((await request(server.port, 'GET', '/api/v1/history')).body);
    assert.deepEqual(all.repositories_available.map((r: { repo: string }) => r.repo), ['acme/app', 'other/repo']);
    assert.equal(all.totals.runs, 1);
    assert.equal(all.totals.total_tokens, 1500);
    assert.equal(all.totals.cost_usd, 0.0175);
    assert.deepEqual(all.models.map((m: { model: string }) => m.model), ['claude-opus-5-5']);

    const one = JSON.parse((await request(server.port, 'GET', '/api/v1/history?repo=other%2Frepo')).body);
    assert.equal(one.repo, 'other/repo');
    assert.equal(one.totals.runs, 0);
    assert.equal(one.recent[0].event, 'workspace_removed');

    const raw = await request(server.port, 'GET', '/api/v1/history/raw?repo=acme%2Fapp');
    assert.equal(raw.status, 200);
    assert.match(raw.headers['content-type'] ?? '', /text\/plain/);
    assert.match(raw.body, /event=run_finished repo=acme\/app issue=acme\/app#1/);
    assert.equal((await request(server.port, 'GET', '/api/v1/history/raw')).status, 400);
  });

  it('serves analytics and log entries for one period, repository and model', async () => {
    const page = (await request(server.port, 'GET', '/stats')).body;
    assert.match(page, /\/api\/v1\/history\/analytics\?/);
    assert.match(page, /\/api\/v1\/history\/entries\?/);
    assert.match(page, /data-body="roles"/);
    assert.match(page, /Most expensive issue pipelines/);

    const week = '/api/v1/history/analytics?from=2026-09-28T00:00:00Z&to=2026-10-05T00:00:00Z&tz=Europe%2FBerlin';
    const a = JSON.parse((await request(server.port, 'GET', week)).body);
    assert.equal(a.totals.runs, 1);
    assert.equal(a.totals.cost_usd, 0.0175);
    assert.equal(a.period.time_zone, 'Europe/Berlin');
    assert.equal(a.period.granularity, 'day');
    assert.deepEqual(a.repositories_available, ['acme/app', 'other/repo']);
    assert.deepEqual(a.models_available, ['claude-opus-5-5']);
    assert.deepEqual(a.efforts_available, ['unknown']);
    assert.deepEqual(a.by_role.map((r: { role: string; runs: number }) => [r.role, r.runs]), [['default', 1]]);
    assert.equal(a.top.pipelines.length, 1);
    // Stage results by profile and the verdicts per role (the stage_result lines of the seeded history).
    assert.equal(a.stage_results, 2);
    assert.deepEqual(a.by_profile.map((p: { profile: string; results: number; issues: number; runs: number; verdicts: object }) => [p.profile, p.results, p.issues, p.runs, p.verdicts]), [
      ['bugfix', 2, 1, 1, { 'implementation:done': 1, 'review:approved': 1 }],
    ]);
    assert.deepEqual(a.verdicts_by_role.map((r: { role: string; verdicts: object }) => [r.role, r.verdicts]), [
      ['developer', { 'implementation:done': 1 }],
      ['reviewer', { 'review:approved': 1 }],
    ]);
    assert.equal(a.filter.effort, null);
    // A second identical request is served from the cache with the same figures.
    assert.deepEqual(JSON.parse((await request(server.port, 'GET', week)).body).series, a.series);
    const effort = JSON.parse((await request(server.port, 'GET', `${week}&effort=high`)).body);
    assert.equal(effort.totals.runs, 0);
    assert.equal(effort.filter.effort, 'high');

    const empty = JSON.parse((await request(server.port, 'GET', '/api/v1/history/analytics?repo=other%2Frepo&model=claude-opus-5-5')).body);
    assert.equal(empty.totals.runs, 0);
    assert.deepEqual(empty.repositories_available, ['acme/app', 'other/repo']);

    assert.equal((await request(server.port, 'GET', '/api/v1/history/analytics?from=yesterday')).status, 400);
    assert.equal((await request(server.port, 'GET', '/api/v1/history/analytics?from=2026-10-05T00:00:00Z&to=2026-10-01T00:00:00Z')).status, 400);

    const log = JSON.parse((await request(server.port, 'GET', '/api/v1/history/entries?repo=other%2Frepo&limit=5')).body);
    assert.deepEqual(log.entries.map((e: { event: string }) => e.event), ['workspace_removed']);
    const runs = JSON.parse((await request(server.port, 'GET', '/api/v1/history/entries?result=handed_off&order=asc')).body);
    assert.deepEqual(runs.entries.map((e: { issue: string }) => e.issue), ['acme/app#1']);
  });

  it('serves the agent detail view and links the agent cards to it', async () => {
    const page = await request(server.port, 'GET', '/issue?id=acme%2Fapp%231');
    assert.equal(page.status, 200);
    assert.match(page.body, /<nav class="crumbs" aria-label="Brotkrumen">/);
    assert.ok(page.body.includes(TOKENS_CSS), 'agent page embeds the tokens CSS');
    assert.match(page.body, /<li><a href="\/">Übersicht<\/a><\/li>/);
    assert.match(page.body, /id="timeline"/);
    // Pipeline topology section and the Issue sidebar (labels, blockers, sub-issues).
    assert.match(page.body, /id="pipe-section"/);
    assert.match(page.body, /id="issue-section"/);
    assert.match(page.body, /id="results-section"/);
    assert.match(page.body, /id="result-cards"/);
    assert.equal((await request(server.port, 'HEAD', '/issue')).status, 200);
  });

  it('returns a JSON 404 for unknown issues and routes', async () => {
    const unknown = await request(server.port, 'GET', `/api/v1/${encodeURIComponent('acme/app#404')}`);
    assert.equal(unknown.status, 404);
    assert.equal(JSON.parse(unknown.body).error.code, 'issue_not_found');
    for (const sub of ['timeline', 'team', 'transcript']) {
      const missing = await request(server.port, 'GET', `/api/v1/${encodeURIComponent('acme/app#404')}/${sub}`);
      assert.equal(missing.status, 404);
      assert.equal(JSON.parse(missing.body).error.code, 'issue_not_found');
    }
    const route = await request(server.port, 'GET', '/nope');
    assert.equal(route.status, 404);
  });

  it('queues a refresh with 202 and coalesces repeats', async () => {
    const first = await request(server.port, 'POST', '/api/v1/refresh');
    assert.equal(first.status, 202);
    assert.deepEqual(JSON.parse(first.body).operations, ['poll', 'reconcile']);
    const second = await request(server.port, 'POST', '/api/v1/refresh');
    assert.equal(JSON.parse(second.body).coalesced, true);
    assert.ok(timers.delays().includes(0));
  });

  it('rejects unsupported methods, foreign Host headers and cross-origin refreshes', async () => {
    const wrongMethod = await request(server.port, 'DELETE', '/api/v1/state');
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.allow, 'GET');
    const rebinding = await request(server.port, 'GET', '/api/v1/state', { host: 'evil.example:80' });
    assert.equal(rebinding.status, 403);
    const crossOrigin = await request(server.port, 'POST', '/api/v1/refresh', { origin: 'https://evil.example' });
    assert.equal(crossOrigin.status, 403);
  });
});

describe('issue details', () => {
  it('returns the entry gate with a running and a finished check', async () => {
    const workspaceRoot = tempDir();
    const runner = new FakeRunner(async (_turn, params) => {
      void params.tools.find((t) => t.name === 'set_status')!.execute({ status: 'Agent review' }, params.toolContext());
      return new Promise((resolve) => params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: '1', code: 'turn_cancelled', message: 'cancelled' })));
    });
    const front = baseFront(workspaceRoot, {
      tracker: { kind: 'github_project', provider: { owner: 'acme', project_number: 1, token: 'test-token' }, active_states: ['Todo', 'Agent review'] },
      checks: {
        on_enter: {
          'Agent review': [
            { name: 'lint', command: 'exit 0' },
            { name: 'ci', command: 'while [ ! -f "$SYMPHONY_WORKSPACE/go" ]; do sleep 0.02; done; exit 0', timeout_ms: 30000 },
          ],
        },
      },
    });
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(front)),
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker([makeIssue({ id: 'g' })]),
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    const detailOf = async () => JSON.parse((await request(server.port, 'GET', `/api/v1/${encodeURIComponent('acme/app#g')}`)).body);
    try {
      await orchestrator.tickNow();
      await until(() => orchestrator.issueDetail('acme/app#g')?.gate?.checks[1]?.status === 'running', 5_000, 'running check');
      let detail = await detailOf();
      assert.equal(detail.gate.target, 'Agent review');
      assert.equal(detail.gate.finished_at, null);
      const [lint, ci] = detail.gate.checks;
      assert.equal(lint.name, 'lint');
      assert.equal(lint.status, 'passed');
      assert.equal(typeof lint.duration_ms, 'number');
      assert.equal(lint.cached, false);
      assert.equal(lint.output, null);
      assert.equal(ci.name, 'ci');
      assert.equal(typeof ci.started_at, 'string');
      assert.ok(ci.duration_ms >= 0);
      assert.equal(ci.timeout_ms, 30000);
      fs.writeFileSync(path.join(orchestrator.issueDetail('acme/app#g')!.workspace.path as string, 'go'), '');
      await until(() => orchestrator.issueDetail('acme/app#g')?.gate?.finished_at != null, 5_000, 'finished gate');
      detail = await detailOf();
      assert.deepEqual(detail.gate.checks.map((c: { status: string }) => c.status), ['passed', 'passed']);
      assert.equal(detail.last_check.target, 'Agent review');
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });

  it('returns gate: null without an entry gate', async () => {
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
      runner: new FakeRunner(async () => ({ ok: true, turnId: '1', resultText: '' })),
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker([makeIssue({ id: 'n' })]),
    });
    await orchestrator.tickNow();
    const detail = orchestrator.issueDetail('acme/app#n');
    assert.equal(detail?.gate, null);
    assert.equal(detail?.last_check, null);
    await orchestrator.shutdown(1_000);
  });

  it('returns the last entry check as last_check', async () => {
    let checked = false;
    const runner = new FakeRunner(async (_turn, params) => {
      await params.tools.find((t) => t.name === 'set_status')!.execute({ status: 'Agent review' }, params.toolContext());
      checked = true;
      return new Promise((resolve) => params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: '1', code: 'turn_cancelled', message: 'cancelled' })));
    });
    const front = baseFront(tempDir(), {
      tracker: { kind: 'github_project', provider: { owner: 'acme', project_number: 1, token: 'test-token' }, active_states: ['Todo', 'Agent review'] },
      checks: { on_enter: { 'Agent review': 'exit 0' } },
    });
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(front)),
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker([makeIssue({ id: 'c' })]),
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      await orchestrator.tickNow();
      await until(() => checked, 5_000, 'entry check');
      const detail = JSON.parse((await request(server.port, 'GET', `/api/v1/${encodeURIComponent('acme/app#c')}`)).body);
      assert.equal(detail.last_check.target, 'Agent review');
      assert.equal(detail.last_check.ok, true);
      assert.equal(detail.last_check.result, 'passed');
      assert.equal(detail.last_check.exit_code, 0);
      assert.equal(typeof detail.last_check.duration_ms, 'number');
      assert.equal(typeof detail.last_check.finished_at, 'string');
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });
});

describe('team API', () => {
  const make = (logDir: string, issues: ReturnType<typeof makeIssue>[], runner = new FakeRunner(() => new Promise(() => undefined))) =>
    new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
      runner,
      logger: Logger.silent(),
      env: {},
      logDir,
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker(issues),
    });

  it('serves the team view of a running issue', async () => {
    const runner = new FakeRunner((turn, params) => {
      params.onEvent({ event: 'tool_use', timestamp: new Date(), pid: 1, threadId: 't', turnId: '1', sessionId: 't-1', turnCount: turn, message: 'Bash: ls', detail: { tool: 'Bash' } });
      return new Promise(() => undefined);
    });
    const orchestrator = make(tempDir(), [makeIssue({ id: 't' })], runner);
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    const base = `/api/v1/${encodeURIComponent('acme/app#t')}/team`;
    try {
      await orchestrator.tickNow();
      await until(() => (orchestrator.issueTimeline('t')?.events ?? []).some((e) => e.event === 'tool_use'), 3_000, 'tool event');
      const res = await request(server.port, 'GET', base);
      assert.equal(res.status, 200);
      const team = JSON.parse(res.body);
      assert.deepEqual(Object.keys(team).sort(), ['active', 'blocks', 'handoffs', 'seats', 'subagents']);
      assert.equal(team.active.role, 'default');
      assert.equal(team.active.recent_tools.at(-1).tool, 'Bash');
      assert.equal(team.seats.at(-1).role, 'you');
      assert.equal(team.blocks.length, 1);
      assert.equal(team.blocks[0].ended_at, null);
      assert.ok(team.blocks[0].tool_calls >= 1);
      assert.equal((await request(server.port, 'POST', base)).status, 405);
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });

  it('serves the team view of an archived issue', async () => {
    const logDir = tempDir();
    const session = { run: 'r1', attempt: null, role: 'default', state: 'Todo', model: null, effort: null, started_at: '2026-10-03T12:00:00.000Z', finished_at: '2026-10-03T12:05:00.000Z', outcome: 'handed_off', verdict: null, round: null };
    const stage = { id: 'default', label: 'default', kind: 'agent', columns: ['Todo'], status: 'done', sessions: [session], verdict: null, round: null };
    const event = { seq: 1, at: '2026-10-03T12:01:00.000Z', kind: 'agent', event: 'tool_use', level: 'info', message: 'Bash: ls', run: 'r1', turn: 1, detail: { tool: 'Bash' } };
    fs.mkdirSync(path.join(logDir, 'issues'), { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'issues', 'acme_app_old.json'),
      JSON.stringify({ version: 1, pipeline: [stage], issue_id: 'old', issue_identifier: 'acme/app#old', issue_url: null, title: 'Old', repo: null, workspace_path: null, runs: 1, continuations: 0, last_error: null, archived_at: '2026-10-03T12:10:00.000Z', released: true, completed_before: false, timeline: [event], next_seq: 2, sessions: [], run_trace: null, last_check: null }),
    );
    const orchestrator = make(logDir, []);
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      const res = await request(server.port, 'GET', `/api/v1/${encodeURIComponent('acme/app#old')}/team`);
      assert.equal(res.status, 200);
      const team = JSON.parse(res.body);
      assert.equal(team.active, null);
      assert.equal(team.blocks.length, 1);
      assert.equal(team.blocks[0].tool_calls, 1);
      assert.equal(team.seats[0].status, 'done');
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });
});

describe('agent trace API', () => {
  it('serves the timeline incrementally and the session transcript, normalized or raw', async () => {
    const runner = new FakeRunner((turn, params) => {
      fs.mkdirSync(path.dirname(params.transcriptPath as string), { recursive: true });
      fs.appendFileSync(params.transcriptPath as string, `${JSON.stringify({ at: new Date().toISOString(), prompt: { turn, text: 'Work on acme/app#t' } })}\n`);
      params.onEvent({ event: 'tool_use', timestamp: new Date(), pid: 1, threadId: 't', turnId: '1', sessionId: 't-1', turnCount: turn, message: 'Bash: ls', detail: { tool: 'Bash' } });
      return new Promise(() => undefined);
    });
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: tempDir(),
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker([makeIssue({ id: 't' })]),
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    const base = `/api/v1/${encodeURIComponent('acme/app#t')}`;
    try {
      await orchestrator.tickNow();
      await until(() => (orchestrator.issueTimeline('t')?.events ?? []).some((e) => e.event === 'tool_use'), 3_000, 'tool event');
      const timeline = JSON.parse((await request(server.port, 'GET', `${base}/timeline`)).body);
      assert.equal(timeline.issue_identifier, 'acme/app#t');
      assert.equal(timeline.events[0].event, 'run_dispatched');
      const after = JSON.parse((await request(server.port, 'GET', `${base}/timeline?after=${timeline.latest_seq}`)).body);
      assert.deepEqual(after.events, []);

      const transcript = JSON.parse((await request(server.port, 'GET', `${base}/transcript`)).body);
      assert.equal(transcript.available, true);
      assert.deepEqual(transcript.entries.map((e: { type: string }) => e.type), ['prompt']);
      const next = JSON.parse((await request(server.port, 'GET', `${base}/transcript?run=${transcript.run}&from=${transcript.next_offset}`)).body);
      assert.deepEqual(next.entries, []);
      const raw = await request(server.port, 'GET', `${base}/transcript?run=${transcript.run}&format=raw`);
      assert.equal(raw.status, 200);
      assert.match(raw.headers['content-type'] ?? '', /text\/plain/);
      assert.match(raw.body, /"prompt":\{"turn":1,"text":"Work on acme\/app#t"\}/);
      assert.equal((await request(server.port, 'GET', `${base}/transcript?run=nope&format=raw`)).status, 404);
      assert.equal((await request(server.port, 'POST', `${base}/timeline`)).status, 405);
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });
});

describe('POST /api/v1/<identifier>/retry', () => {
  const base = `/api/v1/${encodeURIComponent('acme/app#a')}/retry`;

  it('restarts a waiting worker and reports why others cannot be restarted', async () => {
    let mode: 'fail' | 'hang' = 'fail';
    const runner = new FakeRunner((turn, params) =>
      mode === 'hang'
        ? new Promise((resolve) => params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: String(turn), code: 'turn_cancelled', message: 'cancelled' })))
        : { ok: false, turnId: String(turn), code: 'turn_failed', message: 'boom' },
    );
    const timers = new ManualTimers();
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), { agent: { max_turns: 1 } }))),
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers,
      createAdapter: () => new FakeTracker([makeIssue({ id: 'a' })]),
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    const state = async () => JSON.parse((await request(server.port, 'GET', '/api/v1/state')).body);
    try {
      const unknown = await request(server.port, 'POST', `/api/v1/${encodeURIComponent('acme/app#zzz')}/retry`);
      assert.equal(unknown.status, 404);
      assert.equal(JSON.parse(unknown.body).error.code, 'issue_not_found');

      await orchestrator.tickNow();
      await until(() => orchestrator.snapshot().retrying.length === 1, 3_000, 'waiting');
      mode = 'hang';
      const queued = await request(server.port, 'POST', base);
      assert.equal(queued.status, 202);
      const body = JSON.parse(queued.body);
      assert.equal(body.queued, true);
      assert.equal(body.issue_identifier, 'acme/app#a');
      assert.equal(body.previous, 'retrying');
      assert.equal(typeof body.requested_at, 'string');
      timers.fire(0);
      await until(() => orchestrator.snapshot().running.length === 1, 3_000, 'dispatched');
      assert.equal((await state()).running.length, 1);
      assert.deepEqual((await state()).controls, { retry: true });
      const detail = JSON.parse((await request(server.port, 'GET', `/api/v1/${encodeURIComponent('acme/app#a')}`)).body);
      assert.deepEqual(detail.controls, { retry: true });

      const running = await request(server.port, 'POST', base);
      assert.equal(running.status, 409);
      assert.equal(JSON.parse(running.body).error.code, 'running');
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });

  it('maps every refusal of restartWorker and guards the route', async () => {
    let reason: string = 'not_waiting';
    let calls = 0;
    const orchestrator = {
      restartWorker: async () => {
        calls++;
        return { ok: false, reason };
      },
    } as unknown as Orchestrator;
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      for (const [r, status, code] of [['not_waiting', 409, 'not_waiting'], ['stopping', 409, 'stopping'], ['not_found', 404, 'issue_not_found']] as const) {
        reason = r;
        const res = await request(server.port, 'POST', base);
        assert.equal(res.status, status);
        assert.equal(JSON.parse(res.body).error.code, code);
      }
      const get = await request(server.port, 'GET', base);
      assert.equal(get.status, 405);
      assert.equal(get.headers.allow, 'POST');
      assert.equal((await request(server.port, 'POST', base, { origin: 'https://evil.example' })).status, 403);
      assert.equal(JSON.parse((await request(server.port, 'POST', base, { origin: 'https://evil.example' })).body).error.code, 'forbidden_origin');
      assert.equal((await request(server.port, 'POST', base, { host: 'evil.example' })).status, 403);
      assert.equal(calls, 3);
    } finally {
      await server.close();
    }
  });

  const remoteOrchestrator = () => {
    const counts = { restart: 0, refresh: 0 };
    const orchestrator = {
      restartWorker: async () => {
        counts.restart++;
        return { ok: true, issueIdentifier: 'acme/app#a', previous: 'retrying' };
      },
      requestRefresh: () => {
        counts.refresh++;
        return { queued: true, coalesced: false };
      },
      snapshot: () => ({}),
      issueDetail: () => ({ issue_identifier: 'acme/app#a' }),
    } as unknown as Orchestrator;
    return { orchestrator, counts };
  };
  const detailPath = `/api/v1/${encodeURIComponent('acme/app#a')}`;

  it('is disabled on a non-loopback bind unless remote control is allowed', async () => {
    const { orchestrator, counts } = remoteOrchestrator();
    const server = await startHttpServer({ host: '0.0.0.0', port: 0, orchestrator, logger: Logger.silent() });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const res = await request(server.port, 'POST', base, { origin });
      assert.equal(res.status, 403);
      const error = JSON.parse(res.body).error;
      assert.equal(error.code, 'control_disabled');
      assert.match(error.message, /server\.allow_remote_control/);
      assert.match(error.message, /SYMPHONY_ALLOW_REMOTE_CONTROL/);
      assert.equal(counts.restart, 0);
      const state = await request(server.port, 'GET', '/api/v1/state');
      assert.equal(state.status, 200);
      assert.deepEqual(JSON.parse(state.body).controls, { retry: false });
      assert.deepEqual(JSON.parse((await request(server.port, 'GET', detailPath)).body).controls, { retry: false });
      // Refresh is unchanged: allowed without an Origin, refused with a foreign one.
      assert.equal((await request(server.port, 'POST', '/api/v1/refresh')).status, 202);
      assert.equal((await request(server.port, 'POST', '/api/v1/refresh', { origin: 'https://evil.example' })).status, 403);
      assert.equal(counts.refresh, 1);
    } finally {
      await server.close();
    }
  });

  it('requires a matching Origin when remote control is allowed on a non-loopback bind', async () => {
    const { orchestrator, counts } = remoteOrchestrator();
    const server = await startHttpServer({ host: '0.0.0.0', port: 0, orchestrator, logger: Logger.silent(), allowRemoteControl: true });
    try {
      const missing = await request(server.port, 'POST', base);
      assert.equal(missing.status, 403);
      assert.equal(JSON.parse(missing.body).error.code, 'forbidden_origin');
      assert.match(JSON.parse(missing.body).error.message, /Origin/);
      const foreign = await request(server.port, 'POST', base, { origin: 'https://evil.example' });
      assert.equal(foreign.status, 403);
      assert.equal(JSON.parse(foreign.body).error.code, 'forbidden_origin');
      assert.equal(counts.restart, 0);

      // Behind a proxy the browser sends the public origin and the proxy forwards the public Host.
      const proxied = await request(server.port, 'POST', base, { host: 'symphony.example', origin: 'https://symphony.example' });
      assert.equal(proxied.status, 202);
      assert.equal(JSON.parse(proxied.body).issue_identifier, 'acme/app#a');
      const direct = await request(server.port, 'POST', base, { origin: `http://127.0.0.1:${server.port}` });
      assert.equal(direct.status, 202);
      assert.equal(counts.restart, 2);

      assert.deepEqual(JSON.parse((await request(server.port, 'GET', '/api/v1/state')).body).controls, { retry: true });
      assert.deepEqual(JSON.parse((await request(server.port, 'GET', detailPath)).body).controls, { retry: true });
      assert.equal((await request(server.port, 'POST', '/api/v1/refresh')).status, 202);
    } finally {
      await server.close();
    }
  });
});

describe('operator pause routes', () => {
  const issuePath = (action: string) => `/api/v1/${encodeURIComponent('acme/app#a')}/${action}`;

  /** A fake orchestrator whose control methods answer with `results[name]` and count their calls. */
  const fakeOrchestrator = (results: Record<string, unknown>) => {
    const calls: string[] = [];
    const method = (name: string) => async (key: string) => {
      calls.push(`${name} ${key}`);
      return results[name];
    };
    const orchestrator = {
      pauseIssue: method('pauseIssue'),
      resumeIssue: method('resumeIssue'),
      holdModel: method('holdModel'),
      releaseModel: method('releaseModel'),
      restartWorker: method('restartWorker'),
      forceStart: method('forceStart'),
      snapshot: () => ({}),
    } as unknown as Orchestrator;
    return { orchestrator, calls };
  };

  it('force-starts an issue with 202 and maps its refusals', async () => {
    const results: Record<string, unknown> = {
      forceStart: { ok: true, issueIdentifier: 'acme/app#a', previous: 'queued', slots: { running: 4, forced: 1, limit: 3 } },
    };
    const { orchestrator, calls } = fakeOrchestrator(results);
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      const started = await request(server.port, 'POST', issuePath('force'));
      assert.equal(started.status, 202);
      const body = JSON.parse(started.body);
      assert.deepEqual([body.started, body.issue_identifier, body.previous, body.slots], [true, 'acme/app#a', 'queued', { running: 4, forced: 1, limit: 3 }]);
      assert.deepEqual(calls, ['forceStart acme/app#a']);
      const refusals = [
        ['running', 409, 'running'],
        ['blocked', 409, 'blocked'],
        ['not_eligible', 409, 'not_eligible'],
        ['model_held', 409, 'model_held'],
        ['invalid_workflow', 409, 'invalid_workflow'],
        ['stopping', 409, 'stopping'],
        ['not_found', 404, 'issue_not_found'],
        ['tracker_error', 502, 'tracker_error'],
        ['spawn_failed', 500, 'spawn_failed'],
      ] as const;
      for (const [reason, status, code] of refusals) {
        results.forceStart = { ok: false, reason, message: `refused: ${reason}`, model: 'opus' };
        const res = await request(server.port, 'POST', issuePath('force'));
        assert.equal(res.status, status, reason);
        assert.deepEqual(JSON.parse(res.body).error, { code, message: `refused: ${reason}` });
      }
      assert.equal((await request(server.port, 'GET', issuePath('force'))).status, 405);
    } finally {
      await server.close();
    }
  });

  it('pauses and resumes issues and models with 202', async () => {
    const { orchestrator, calls } = fakeOrchestrator({
      pauseIssue: { ok: true, issueIdentifier: 'acme/app#a', previous: 'running' },
      resumeIssue: { ok: true, issueIdentifier: 'acme/app#a' },
      holdModel: { ok: true, model: 'fable', issues: 2 },
      releaseModel: { ok: true, model: 'fable', issues: 1 },
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      const paused = await request(server.port, 'POST', issuePath('pause'));
      assert.equal(paused.status, 202);
      assert.equal(JSON.parse(paused.body).previous, 'running');
      assert.equal((await request(server.port, 'POST', issuePath('resume'))).status, 202);
      const hold = await request(server.port, 'POST', '/api/v1/models/fable/hold');
      assert.equal(hold.status, 202);
      assert.deepEqual([JSON.parse(hold.body).model, JSON.parse(hold.body).stopped], ['fable', 2]);
      const release = await request(server.port, 'POST', '/api/v1/models/fable/release');
      assert.equal(release.status, 202);
      assert.equal(JSON.parse(release.body).requeued, 1);
      assert.deepEqual(calls, ['pauseIssue acme/app#a', 'resumeIssue acme/app#a', 'holdModel fable', 'releaseModel fable']);
      assert.equal((await request(server.port, 'GET', issuePath('pause'))).status, 405);
      assert.equal((await request(server.port, 'GET', '/api/v1/models/fable/hold')).status, 405);
    } finally {
      await server.close();
    }
  });

  it('maps refusals to 409, 404 and 400', async () => {
    const results: Record<string, unknown> = {};
    const { orchestrator } = fakeOrchestrator(results);
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    const expect = async (path: string, status: number, code: string) => {
      const res = await request(server.port, 'POST', path);
      assert.equal(res.status, status, path);
      assert.equal(JSON.parse(res.body).error.code, code, path);
    };
    try {
      for (const [reason, status, code] of [['already_paused', 409, 'already_paused'], ['stopping', 409, 'stopping'], ['not_found', 404, 'issue_not_found']] as const) {
        results.pauseIssue = { ok: false, reason };
        await expect(issuePath('pause'), status, code);
      }
      for (const [reason, status, code] of [['not_paused', 409, 'not_paused'], ['stopping', 409, 'stopping'], ['not_found', 404, 'issue_not_found']] as const) {
        results.resumeIssue = { ok: false, reason };
        await expect(issuePath('resume'), status, code);
      }
      for (const [reason, status, code] of [['unknown_model', 400, 'unknown_model'], ['already_paused', 409, 'already_paused'], ['stopping', 409, 'stopping']] as const) {
        results.holdModel = { ok: false, reason };
        await expect('/api/v1/models/gpt/hold', status, code);
      }
      results.releaseModel = { ok: false, reason: 'not_paused' };
      await expect('/api/v1/models/fable/release', 409, 'not_paused');
    } finally {
      await server.close();
    }
  });

  it('guards every control route like retry', async () => {
    const { orchestrator, calls } = fakeOrchestrator({});
    const routes = [issuePath('pause'), issuePath('resume'), '/api/v1/models/fable/hold', '/api/v1/models/fable/release', issuePath('retry'), issuePath('force')];
    const local = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    const remote = await startHttpServer({ host: '0.0.0.0', port: 0, orchestrator, logger: Logger.silent() });
    const proxied = await startHttpServer({ host: '0.0.0.0', port: 0, orchestrator, logger: Logger.silent(), allowRemoteControl: true });
    try {
      for (const route of routes) {
        const foreign = await request(local.port, 'POST', route, { origin: 'https://evil.example' });
        assert.equal(foreign.status, 403, route);
        assert.equal(JSON.parse(foreign.body).error.code, 'forbidden_origin');
        const disabled = await request(remote.port, 'POST', route, { origin: `http://127.0.0.1:${remote.port}` });
        assert.equal(disabled.status, 403, route);
        assert.equal(JSON.parse(disabled.body).error.code, 'control_disabled');
        const missing = await request(proxied.port, 'POST', route);
        assert.equal(missing.status, 403, route);
        assert.equal(JSON.parse(missing.body).error.code, 'forbidden_origin');
      }
      assert.deepEqual(calls, []);
    } finally {
      await Promise.all([local.close(), remote.close(), proxied.close()]);
    }
  });

  it('pauses a running issue end to end and lists it as paused', async () => {
    const runner = new FakeRunner((turn, params) => new Promise((resolve) => params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: String(turn), code: 'turn_cancelled', message: 'cancelled' }))));
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), { agent: { max_turns: 1 } }))),
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker([makeIssue({ id: 'a' })]),
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      await orchestrator.tickNow();
      await until(() => orchestrator.snapshot().running[0]?.phase === 'StreamingTurn', 3_000, 'streaming');
      assert.equal((await request(server.port, 'POST', issuePath('pause'))).status, 202);
      await until(() => orchestrator.snapshot().running.length === 0, 3_000, 'stopped');
      const state = JSON.parse((await request(server.port, 'GET', '/api/v1/state')).body);
      assert.equal(state.issues[0].section, 'paused');
      assert.equal(state.paused[0].source, 'operator');
      assert.equal(JSON.parse((await request(server.port, 'POST', issuePath('pause'))).body).error.code, 'already_paused');
      assert.equal((await request(server.port, 'POST', issuePath('resume'))).status, 202);
      assert.equal(JSON.parse((await request(server.port, 'POST', issuePath('resume'))).body).error.code, 'not_paused');
      assert.equal((await request(server.port, 'POST', '/api/v1/models/nope/hold')).status, 400);
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });
});

describe('agent settings routes', () => {
  const route = '/api/v1/settings/agents';
  const json = { 'content-type': 'application/json' };
  const setup = (front: Record<string, unknown> = {}) =>
    new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), { agent: { max_concurrent_agents: 2, max_concurrent_agents_by_state: { todo: 1 } }, ...front }))),
      runner: new FakeRunner(),
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker(),
    });

  it('changes and resets the slots and reports them under limits', async () => {
    const orchestrator = setup();
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      const before = JSON.parse((await request(server.port, 'GET', '/api/v1/state')).body).limits;
      assert.deepEqual(before.max_concurrent_agents, { effective: 2, workflow: 2, override: null });
      assert.deepEqual(before.by_state.Todo, { effective: 1, workflow: 1, override: null });
      assert.equal(before.override_active, false);

      const put = await request(server.port, 'PUT', route, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ max_concurrent_agents: 3, max_concurrent_agents_by_state: { Todo: 2 } }));
      assert.equal(put.status, 200);
      const body = JSON.parse(put.body);
      assert.equal(body.changed, true);
      assert.deepEqual(body.limits.max_concurrent_agents, { effective: 3, workflow: 2, override: 3 });
      assert.deepEqual(body.limits.by_state.Todo, { effective: 2, workflow: 1, override: 2 });
      const state = JSON.parse((await request(server.port, 'GET', '/api/v1/state')).body);
      assert.equal(state.limits.override_active, true);
      assert.equal(state.health.max_concurrent_agents, 3);

      const reset = await request(server.port, 'DELETE', route, json);
      assert.equal(reset.status, 200);
      assert.deepEqual(JSON.parse(reset.body).limits.max_concurrent_agents, { effective: 2, workflow: 2, override: null });
      assert.equal((await request(server.port, 'POST', route, json, '{}')).status, 405);
      assert.equal((await request(server.port, 'GET', route)).status, 405);
    } finally {
      await server.close();
    }
  });

  it('answers 400 for invalid values, 415 without JSON and 413 for a large body', async () => {
    const orchestrator = setup();
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    const expect = async (body: string, status: number, code: string, headers: Record<string, string> = json) => {
      const res = await request(server.port, 'PUT', route, headers, body);
      assert.equal(res.status, status, body.slice(0, 80));
      const error = JSON.parse(res.body).error;
      assert.equal(error.code, code, body.slice(0, 80));
      return error.message as string;
    };
    try {
      assert.match(await expect(JSON.stringify({ max_concurrent_agents: 51 }), 400, 'invalid_settings'), /0 to 50/);
      assert.match(await expect(JSON.stringify({ max_concurrent_agents_by_state: { Todo: 0 } }), 400, 'invalid_settings'), /1 to 50/);
      assert.match(await expect(JSON.stringify({ max_concurrent_agents_by_state: { Done: 1 } }), 400, 'invalid_settings'), /not an active column/);
      assert.match(await expect('{nope', 400, 'bad_request'), /not valid JSON/);
      assert.match(await expect('', 400, 'invalid_settings'), /JSON object/);
      await expect('max_concurrent_agents=3', 415, 'unsupported_media_type', { 'content-type': 'application/x-www-form-urlencoded' });
      await expect('{"max_concurrent_agents":3}', 415, 'unsupported_media_type', { 'content-type': 'text/plain' });
      await expect('{"max_concurrent_agents":3}', 415, 'unsupported_media_type', {});
      assert.equal((await request(server.port, 'DELETE', route)).status, 415);
      await expect(JSON.stringify({ max_concurrent_agents: 3, pad: 'x'.repeat(20_000) }), 413, 'payload_too_large');
      assert.equal(orchestrator.snapshot().limits.override_active, false, 'nothing changed');
    } finally {
      await server.close();
    }
  });

  it('changes reserved slots and refuses a limit below their sum with 400', async () => {
    const orchestrator = setup({
      agent: { max_concurrent_agents: 3, reserved_slots_by_role: { developer: 1, reviewer: 1 } },
      tracker: { kind: 'github_project', provider: { owner: 'acme', project_number: 1, token: 't' }, active_states: ['Ready', 'Agent review'] },
      roles: { developer: { states: ['Ready'] }, reviewer: { states: ['Agent review'], read_only: true } },
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      const before = JSON.parse((await request(server.port, 'GET', '/api/v1/state')).body).limits;
      assert.deepEqual(before.reserved_slots_by_role.reviewer, { effective: 1, workflow: 1, override: null, running: 0 });
      assert.equal(before.reservation_problem, null);

      const low = await request(server.port, 'PUT', route, json, JSON.stringify({ max_concurrent_agents: 1 }));
      assert.equal(low.status, 400);
      assert.deepEqual(JSON.parse(low.body).error, {
        code: 'invalid_settings',
        message: 'the limit of 1 agent slot is below the reserved slots (developer 1 + reviewer 1 = 2); lower the reservations first',
      });
      assert.equal(orchestrator.snapshot().limits.override_active, false, 'nothing changed');

      const put = await request(server.port, 'PUT', route, json, JSON.stringify({ reserved_slots_by_role: { developer: 2 } }));
      assert.equal(put.status, 200);
      assert.deepEqual(JSON.parse(put.body).limits.reserved_slots_by_role.developer, { effective: 2, workflow: 1, override: 2, running: 0 });
      const unknownRole = await request(server.port, 'PUT', route, json, JSON.stringify({ reserved_slots_by_role: { tester: 1 } }));
      assert.equal(unknownRole.status, 400);
      assert.match(JSON.parse(unknownRole.body).error.message, /tester is not a role/);
    } finally {
      await server.close();
    }
  });

  it('uses the shared control guard', async () => {
    const orchestrator = setup();
    const local = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    const remote = await startHttpServer({ host: '0.0.0.0', port: 0, orchestrator, logger: Logger.silent() });
    const proxied = await startHttpServer({ host: '0.0.0.0', port: 0, orchestrator, logger: Logger.silent(), allowRemoteControl: true });
    const put = JSON.stringify({ max_concurrent_agents: 4 });
    try {
      for (const method of ['PUT', 'DELETE']) {
        // Node's client sends a DELETE body without a length, which breaks the kept-alive connection.
        const body = method === 'PUT' ? put : undefined;
        const foreign = await request(local.port, method, route, { ...json, origin: 'https://evil.example' }, body);
        assert.equal(foreign.status, 403, method);
        assert.equal(JSON.parse(foreign.body).error.code, 'forbidden_origin');
        const disabled = await request(remote.port, method, route, { ...json, origin: `http://127.0.0.1:${remote.port}` }, body);
        assert.equal(disabled.status, 403, method);
        assert.equal(JSON.parse(disabled.body).error.code, 'control_disabled');
        const missing = await request(proxied.port, method, route, json, body);
        assert.equal(missing.status, 403, method);
        assert.equal(JSON.parse(missing.body).error.code, 'forbidden_origin');
      }
      assert.equal(orchestrator.snapshot().limits.override_active, false);
      const allowed = await request(proxied.port, 'PUT', route, { ...json, host: 'symphony.example', origin: 'https://symphony.example' }, put);
      assert.equal(allowed.status, 200);
      assert.equal(orchestrator.snapshot().limits.max_concurrent_agents.override, 4);
    } finally {
      await Promise.all([local.close(), remote.close(), proxied.close()]);
    }
  });
});

describe('system route', () => {
  it('serves current, history and gpu', async () => {
    const system = new SystemCollector({ procDir: path.join(tempDir(), 'none'), volumes: [], gpu: false, logger: Logger.silent() });
    await system.collect();
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
      runner: new FakeRunner(),
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker(),
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent(), system });
    try {
      const res = await request(server.port, 'GET', '/api/v1/system');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.deepEqual(Object.keys(body).sort(), ['cpu_count', 'current', 'gpu', 'history']);
      assert.equal(body.gpu, null);
      assert.equal(body.history.length, 1);
      assert.deepEqual(Object.keys(body.current).sort(), ['at', 'cpu_percent', 'disks', 'gpu', 'load', 'memory']);
      assert.equal((await request(server.port, 'POST', '/api/v1/system')).status, 405);
    } finally {
      await server.close();
    }
  });
});

describe('page shell (layout.ts, #342)', () => {
  const PAGES = { dashboard: DASHBOARD_HTML, agent: AGENT_HTML, logs: LOGS_HTML, changes: CHANGES_HTML, tasks: TASKS_HTML, brain: BRAIN_HTML };
  const header = (html: string): string => html.slice(html.indexOf('<header'), html.indexOf('</header>') + 9);
  const mainNav = (html: string): string => {
    const at = html.indexOf('aria-label="Hauptnavigation"');
    return html.slice(at, html.indexOf('</nav>', at));
  };
  const styleOf = (html: string): string => html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const count = (text: string, needle: string): number => text.split(needle).length - 1;
  const ruleOf = (css: string, selector: string): string => {
    const at = css.indexOf(`\n  ${selector} {`);
    assert.ok(at >= 0, `${selector} rule`);
    return css.slice(at, css.indexOf('}', at));
  };

  it('page() builds the complete document with the tokens CSS, BASE_JS and the shell', () => {
    const html = shellPage({ title: 'A<b', nav: null, body: '<p>x</p>', scripts: 'pageScript();' });
    assert.ok(html.startsWith('<!doctype html>\n<html lang="de">'));
    assert.match(html, /<title>A&lt;b<\/title>/);
    for (const part of [TOKENS_CSS, LAYOUT_CSS, BASE_JS, LAYOUT_JS]) assert.ok(html.includes(part));
    assert.match(html, /function setLive\(/);
    assert.ok(html.includes('<main id="main"><p>x</p></main>'));
    assert.ok(html.indexOf('pageScript();') > html.indexOf('function setLive('), 'the page script runs after the shell script');
    assert.equal(count(html, '<script>'), 1);
    assert.ok(!html.includes('Brotkrumen'), 'no breadcrumbs without crumbs');
    const withCrumbs = shellPage({ title: 'T', nav: null, crumbs: [{ label: 'Übersicht', href: '/' }, { label: 'X<y' }], body: '', scripts: '' });
    assert.match(withCrumbs, /<nav class="crumbs" aria-label="Brotkrumen"><ol><li><a href="\/">Übersicht<\/a><\/li><li><span id="crumb-current" aria-current="page">X&lt;y<\/span><\/li><\/ol><\/nav>/);
  });

  it('draws the aurora as one fixed layer of radial gradients and keeps every page at most 4 blur layers', () => {
    const aurora = ruleOf(LAYOUT_CSS, '.aurora');
    assert.match(aurora, /position: fixed/);
    assert.match(aurora, /z-index: 0/);
    assert.match(aurora, /pointer-events: none/);
    const gradients = count(aurora, 'radial-gradient(');
    assert.ok(gradients >= 2 && gradients <= 3, `${gradients} colour fields`);
    assert.doesNotMatch(aurora, /url\(|filter:/);
    assert.doesNotMatch(LAYOUT_CSS, /backdrop-filter/);
    assert.doesNotMatch(TOKENS_CSS, /radial-gradient/, 'the body ground no longer carries the gradients');
    for (const [name, html] of Object.entries(PAGES)) {
      assert.equal(count(html, '<div class="aurora" aria-hidden="true"></div>'), 1, name);
      const blurs = styleOf(html).match(/(?<!-webkit-)backdrop-filter:\s*blur\(/g) ?? [];
      assert.ok(blurs.length >= 1 && blurs.length <= 4, `${name}: ${blurs.length} blur layers`);
    }
    // Reduced transparency drops the aurora too.
    assert.match(LAYOUT_CSS, /@media \(prefers-reduced-transparency: reduce\) \{\s*\.aurora \{ display: none; \}/);
  });

  it('renders exactly one header with logo, LIVE, the main navigation, 5 h chip, version and clock on every page', () => {
    for (const [name, html] of Object.entries(PAGES)) {
      assert.equal(count(html, '<header'), 1, name);
      assert.equal(count(html, 'aria-label="Hauptnavigation"'), 1, `${name}: one main navigation`);
      const head = header(html);
      assert.match(head, /<header class="shell-head g">/);
      assert.match(head, /<a class="brand" href="\/"[^>]*>[\s\S]*<span class="brand-name">Symphony<\/span>/);
      assert.match(head, /id="shell-live"/);
      assert.match(head, /id="shell-budget"[^>]*>5 h —</);
      assert.ok(head.includes(`id="shell-version" title="Symphony-Version">v${SYMPHONY_VERSION}<`), name);
      assert.match(head, /<time class="shell-clock mono" id="shell-clock" aria-label="Uhr"/);
      assert.match(head, /id="progress"/);
      const nav = mainNav(html);
      const links = [...nav.matchAll(/<a class="nv" href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
      assert.deepEqual(links, [['/', 'Übersicht'], ['/changes', 'Changes'], ['/tasks', 'Tasks'], ['/brain', 'Brain'], ['/stats', 'Statistik']], name);
    }
    assert.deepEqual(NAV_ITEMS.map((i) => i.key), ['overview', 'changes', 'tasks', 'brain', 'stats']);
  });

  it('marks the active entry with aria-current="page" and shows breadcrumbs only on the agent page', () => {
    const current = (html: string): string[] => [...mainNav(html).matchAll(/href="([^"]+)" aria-current="page"/g)].map((m) => m[1] as string);
    assert.deepEqual(current(DASHBOARD_HTML), ['/']);
    assert.deepEqual(current(LOGS_HTML), ['/stats']);
    assert.deepEqual(current(AGENT_HTML), []);
    assert.equal(count(mainNav(DASHBOARD_HTML), 'aria-current'), 1);
    assert.equal(count(AGENT_HTML, '<nav class="crumbs" aria-label="Brotkrumen">'), 1);
    assert.match(AGENT_HTML, /aria-label="Brotkrumen"><ol><li><a href="\/">Übersicht<\/a><\/li><li><span id="crumb-current" aria-current="page">Issue<\/span>/);
    const agent = renderPage(AGENT_HTML, { detail: issueDetail() }, { url: AGENT_URL });
    assert.equal(agent.$('crumb-current').textContent, 'Issue #1', 'the crumb names the issue');
    assert.equal(agent.query('nav[aria-label="Brotkrumen"] a[href="/"]').length, 1);
    for (const html of [DASHBOARD_HTML, LOGS_HTML]) assert.ok(!html.includes('aria-label="Brotkrumen"'));
  });

  it('goes back in the history from the Übersicht crumb only when the dashboard was the previous page', () => {
    const crumb = (page: ReturnType<typeof renderPage>) => page.query('nav[aria-label="Brotkrumen"] a[href="/"]')[0]!;
    const from = renderPage(AGENT_HTML, { detail: issueDetail() }, { url: AGENT_URL, referrer: 'http://127.0.0.1/', historyLength: 2 });
    from.click(crumb(from));
    assert.equal(from.backs, 1);
    const direct = renderPage(AGENT_HTML, { detail: issueDetail() }, { url: AGENT_URL, historyLength: 2 });
    direct.click(crumb(direct));
    assert.equal(direct.backs, 0, 'no referrer: the link navigates');
    const other = renderPage(AGENT_HTML, { detail: issueDetail() }, { url: AGENT_URL, referrer: 'http://127.0.0.1/stats', historyLength: 2 });
    other.click(crumb(other));
    assert.equal(other.backs, 0, 'another page: the link navigates');
    const fresh = renderPage(AGENT_HTML, { detail: issueDetail() }, { url: AGENT_URL, referrer: 'http://127.0.0.1/', historyLength: 1 });
    fresh.click(crumb(fresh));
    assert.equal(fresh.backs, 0, 'nothing to go back to');
  });

  it('replaces the three copied top bars; the page actions live in <main>', () => {
    for (const [name, html] of Object.entries(PAGES)) {
      for (const old of ['class="topbar"', 'topbar-inner', 'brand-sub', 'AGENT ORCHESTRATOR', 'AGENT TRACE', 'STATISTICS &amp; ANALYTICS', 'id="back"', 'id="sys-version"', 'id="sys-updated"']) {
        assert.ok(!html.includes(old), `${name} still has ${old}`);
      }
      assert.equal(count(html, '<main id="main">'), 1, name);
      assert.equal(count(html, 'id="announce"'), 1, name);
    }
    assert.doesNotMatch(TOKENS_CSS, /\.topbar|\.brand|\.sysinfo|@keyframes sweep/);
    const main = (html: string): string => html.slice(html.indexOf('<main id="main">'), html.indexOf('</main>'));
    for (const id of ['logs-open', 'refresh', 'sys-status', 'sys-workflow', 'sys-interval', 'sys-lastpoll']) assert.ok(main(DASHBOARD_HTML).includes(`id="${id}"`), id);
    assert.match(main(DASHBOARD_HTML), /<dl class="sysinfo"/);
    for (const id of ['raw', 'reload']) assert.ok(main(LOGS_HTML).includes(`id="${id}"`), id);
  });

  it('LIVE is set by the client: setLive() switches green/pulse and gray, every page calls it; the clock ticks', () => {
    const nodes = new Map<string, FakeElement>([['shell-live', new FakeElement('span')], ['shell-live-text', new FakeElement('span')], ['shell-clock', new FakeElement('time')]]);
    const timers: Array<[() => void, number]> = [];
    const ctx = vm.createContext({
      document: { getElementById: (id: string) => nodes.get(id) ?? null },
      setInterval: (fn: () => void, ms: number) => timers.push([fn, ms]),
      fmtClock: (iso: string) => 'clock:' + iso.slice(11, 19),
    });
    vm.runInContext(LAYOUT_JS, ctx);
    const live = nodes.get('shell-live') as FakeElement & { title?: string };
    vm.runInContext('setLive(true)', ctx);
    assert.deepEqual(live.className.split(' ').sort(), ['badge', 'pulse', 'tone-green']);
    assert.equal(nodes.get('shell-live-text')?.textContent, 'Live: verbunden');
    vm.runInContext('setLive(false)', ctx);
    assert.equal(live.className, 'badge tone-gray');
    assert.equal(nodes.get('shell-live-text')?.textContent, 'Live: keine Verbindung');
    const clock = nodes.get('shell-clock') as FakeElement;
    assert.match(clock.textContent, /^clock:\d\d:\d\d:\d\d$/);
    assert.match(clock.getAttribute('datetime') ?? '', /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(timers.map((t) => t[1]), [1000]);
  });

  it('every page switches LIVE: green with data, gray without', async () => {
    const tone = (page: { $(id: string): { className: string } }) => page.$('shell-live').className;
    const dashboard = renderPage(DASHBOARD_HTML, dashboardState());
    assert.match(tone(dashboard), /tone-green/);
    const agent = renderPage(AGENT_HTML, { detail: issueDetail(), online: true }, { url: AGENT_URL });
    assert.match(tone(agent), /tone-green/);
    agent.render({ online: false });
    assert.match(tone(agent), /tone-gray/);
    const logs = renderPage(LOGS_HTML, undefined, { fetch: () => analyticsFixture() });
    await until(() => /tone-green/.test(tone(logs)), 3_000, 'logs LIVE green');
    const broken = renderPage(LOGS_HTML, undefined, { fetch: () => { throw new Error('offline'); } });
    await until(() => /tone-gray/.test(tone(broken)), 3_000, 'logs LIVE gray');
  });

  it('at 390 px the navigation scrolls inside its frame, the page does not; touch targets are at least 44px', () => {
    const nav = ruleOf(LAYOUT_CSS, '.shell-nav');
    assert.match(nav, /overflow-x: auto/);
    assert.match(nav, /min-width: 0/);
    const pill = ruleOf(LAYOUT_CSS, '.nv');
    assert.match(pill, /min-height: 44px/);
    assert.match(pill, /display: inline-flex/);
    assert.match(pill, /white-space: nowrap/);
    assert.match(ruleOf(LAYOUT_CSS, '.brand'), /min-height: 44px/);
    assert.match(ruleOf(LAYOUT_CSS, '.crumbs a'), /min-height: 44px/);
    assert.match(LAYOUT_CSS, /@media \(max-width: 640px\) \{[^@]*\.shell-nav \{ order: 3; flex-basis: 100%; \}/);
    assert.match(TOKENS_CSS, /body \{[^}]*overflow-x: hidden/);
  });

  it('shows German shell texts (Übersicht, Statistik, Uhr, Brotkrumen); Changes, Tasks and Brain stay', () => {
    for (const [name, html] of Object.entries(PAGES)) {
      const head = header(html);
      for (const text of ['Übersicht', 'Changes', 'Tasks', 'Brain', 'Statistik', 'aria-label="Uhr"', 'title="5-Stunden-Budget"']) assert.ok(head.includes(text), `${name}: ${text}`);
      for (const text of ['>Overview<', '>Dashboard<', '>Logs<', 'Statistics', 'Clock']) assert.ok(!head.includes(text), `${name}: ${text}`);
    }
  });
});

describe('GET /api/v1/budget', () => {
  let server: HttpServerHandle;

  before(async () => {
    const logDir = tempDir();
    fs.mkdirSync(path.join(logDir, 'budget'));
    fs.writeFileSync(
      path.join(logDir, 'budget', 'rate-limits.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), run_id: 'r', issue: 'acme/app#1', role: 'developer', model: null, rate_limit_info: { rateLimitType: 'five_hour', status: 'allowed' } })}\n`,
    );
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
      runner: new FakeRunner(),
      logger: Logger.silent(),
      env: {},
      logDir,
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker(),
    });
    server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
  });

  after(async () => {
    await server.close();
  });

  it('answers both windows with usage, forecast and by_role', async () => {
    const res = await request(server.port, 'GET', '/api/v1/budget');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(Object.keys(body).sort(), ['five_hour', 'generated_at', 'seven_day']);
    assert.ok(!Number.isNaN(Date.parse(body.generated_at)));
    for (const window of ['five_hour', 'seven_day']) {
      const item = body[window];
      assert.equal(item.window, window);
      assert.equal(item.used_tokens, 0);
      assert.equal(item.burn_rate_per_min, 0);
      assert.equal(item.forecast, null);
      assert.equal(item.alert, false);
      assert.deepEqual(item.by_role, {});
      assert.ok('resets_at' in item);
    }
  });

  it('rejects other methods', async () => {
    assert.equal((await request(server.port, 'POST', '/api/v1/budget')).status, 405);
  });
});

describe('dashboard page behaviour', () => {
  const ID = 'acme/app#2';
  const idPath = encodeURIComponent(ID);
  const waiting = (over: Record<string, unknown> = {}) =>
    issueRow({
      issue_id: '2', issue_identifier: ID, title: 'Second', status: 'retrying', section: 'waiting', running: null, tracked: true, position: null,
      reason: { code: 'backoff', text: 'Backoff until 2026-10-30 12:30 UTC' },
      retry: { kind: 'failure', attempt: 2, due_at: '2026-10-30T12:30:00Z', due_in_ms: 1_800_000, error: 'boom', limit: null },
      ...over,
    });
  const render = (issues: unknown[], over: Record<string, unknown> = {}, opts = {}) => renderPage(DASHBOARD_HTML, dashboardState({ issues, ...over }), opts);
  const buttons = (page: ReturnType<typeof renderPage>) => page.query('button.restart');
  const button = (page: ReturnType<typeof renderPage>, text: string) => {
    const found = buttons(page).find((b) => b.textContent === text);
    assert.ok(found, `button ${text}`);
    return found;
  };

  it('loads the state, the history and the system cards when the page opens', () => {
    const page = renderPage(DASHBOARD_HTML);
    assert.deepEqual(page.fetches.map((f) => f.url), ['/api/v1/state', '/api/v1/history', '/api/v1/system']);
  });

  it('puts every card into its section with a count, and hides the empty queue sections', () => {
    const page = render(
      [issueRow(), waiting({ issue_id: '3', issue_identifier: 'acme/app#3', section: 'next', status: 'queued', retry: null, reason: { code: 'ready', text: 'Ready' }, position: 1 }), waiting()],
      { counts: { ...dashboardState().counts, running: 1 }, board_fetched_at: '2026-10-30T11:59:00Z' },
    );
    assert.equal(page.$('running').children.length, 1);
    assert.equal(page.$('next').children.length, 1);
    assert.equal(page.$('waiting').children.length, 1);
    assert.deepEqual(['running', 'next', 'waiting', 'paused'].map((n) => page.$(`${n}-count`).textContent), ['01', '01', '01', '00']);
    assert.equal(page.$('next-section').hidden, false);
    assert.equal(page.$('paused-section').hidden, true);
    assert.equal(page.$('next-meta').textContent, 'in start order · board as of 1m 0s ago');
    assert.equal(page.$('next').querySelector('.pos')!.textContent, '#1');
    assert.equal(page.$('next').querySelector('.pos')!.hidden, false);
    const empty = render([]);
    for (const name of ['next', 'waiting', 'paused']) assert.equal(empty.$(`${name}-section`).hidden, true, name);
  });

  it('links the card title to the issue page and shows model and phase of a running issue', () => {
    const page = render([issueRow()], { counts: { ...dashboardState().counts, running: 1 } });
    assert.equal(page.$('running').querySelector('a.agent-link')!.href, '/issue?id=acme%2Fapp%231');
    const fields = page.$('running').querySelectorAll('dd').map((d) => d.textContent);
    assert.deepEqual(fields, ['claude-code-default', 'StreamingTurn']);
  });

  it('names the reason of a waiting card and shows its UTC time in local time', () => {
    const page = render([waiting()]);
    const chip = page.$('waiting').querySelector('.reason')!;
    assert.match(chip.className, /tone-amber/);
    assert.equal(chip.title, 'backoff: Backoff until 2026-10-30 12:30 UTC');
    assert.doesNotMatch(chip.textContent, /UTC/, 'the shown time is local');
    assert.match(chip.textContent, /^Backoff until /);
  });

  it('offers Retry now, Start now and Pause on a waiting card, and posts the click', () => {
    const page = render([waiting()], { counts: { ...dashboardState().counts, running: 0 } });
    assert.deepEqual(buttons(page).map((b) => b.textContent), ['Retry now', 'Start now', 'Pause']);
    page.click(button(page, 'Retry now'));
    page.click(button(page, 'Start now'));
    page.click(button(page, 'Pause'));
    assert.deepEqual(page.fetches.filter((f) => f.method === 'POST').map((f) => `${f.method} ${f.url}`), [
      `POST /api/v1/${idPath}/retry`,
      `POST /api/v1/${idPath}/force`,
      `POST /api/v1/${idPath}/pause`,
    ]);
    assert.deepEqual(page.confirms, [], 'a free slot needs no confirmation');
  });

  it('offers Resume now on a paused card', () => {
    const page = render([waiting({ status: 'paused', section: 'paused', retry: null, reason: { code: 'paused', text: 'Paused' }, paused: { source: 'operator', paused_at: '2026-10-30T11:50:00Z' } })]);
    assert.equal(page.$('paused-section').hidden, false);
    assert.match(page.$('paused').textContent, /paused by operator/);
    page.click(button(page, 'Resume now'));
    assert.equal(page.fetches.at(-1)!.url, `/api/v1/${idPath}/resume`);
  });

  it('asks before Start now when every slot is taken, and starts nothing when declined', () => {
    const full = { counts: { ...dashboardState().counts, running: 1 }, health: { ...dashboardState().health, max_concurrent_agents: 1 } };
    const declined = render([waiting()], full, { confirm: false });
    const before = declined.fetches.length;
    declined.click(button(declined, 'Start now'));
    assert.deepEqual(declined.confirms, ['All 1 slot is busy. Start #2 in an extra slot?']);
    assert.equal(declined.fetches.length, before);
    const accepted = render([waiting()], full);
    accepted.click(button(accepted, 'Start now'));
    assert.equal(accepted.fetches.at(-1)!.url, `/api/v1/${idPath}/force`);
  });

  it('counts forced sessions in the slot bar and takes the Start now button away from held models', () => {
    const page = render([], { counts: { ...dashboardState().counts, running: 2, forced: 1 } });
    assert.match(page.$('slots').textContent, /02 \/ 10 agents, 1 forced/);
    const held = render([waiting({ model_hold: { model: 'opus', until: '2026-10-30T14:00:00Z' }, reason: { code: 'model_hold', text: 'Model hold' } })]);
    assert.ok(!buttons(held).some((b) => b.textContent === 'Start now'));
  });

  it('shows the model controls and posts a hold', () => {
    const page = render([], { model_controls: [{ model: 'opus', paused: false, limit_until: null }] });
    assert.equal(page.$('model-controls').hidden, false);
    assert.match(page.$('model-controls').textContent, /opus.*running/);
    const [control] = page.query('button.model-control');
    assert.equal(control!.textContent, 'Pause');
    page.click(control!);
    assert.deepEqual(page.fetches.at(-1), { url: '/api/v1/models/opus/hold', method: 'POST' });
    const resumed = render([], { model_controls: [{ model: 'opus', paused: true, limit_until: null }] });
    assert.match(resumed.$('model-controls').textContent, /paused by operator/);
    resumed.click(resumed.query('button.model-control')[0]!);
    assert.equal(resumed.fetches.at(-1)!.url, '/api/v1/models/opus/release');
  });

  it('names held models and the cards that wait for them', () => {
    const hold = { model: 'opus', source: 'limit', until: '2026-10-30T14:00:00Z', since: '2026-10-30T11:00:00Z', issue_identifier: ID, text: 'weekly limit' };
    const page = render([waiting({ status: 'queued', retry: null, reason: null, model_hold: hold })], { model_holds: [hold] });
    assert.equal(page.$('model-holds').hidden, false);
    assert.match(page.$('model-hold-list').textContent, /^Model opus on hold until .* · hit by acme\/app#2 · weekly limit$/);
    assert.match(page.$('waiting').textContent, /Waiting for model opus \(limit until /);
    assert.equal(render([]).$('model-holds').hidden, true);
  });

  const stagesOf = (verdictStage: Record<string, unknown>) => [
    { id: 'dev', label: 'developer', kind: 'agent', columns: ['In progress'], status: 'active', sessions: [], verdict: null, round: null, ...verdictStage },
    { id: 'rev', label: 'reviewer', kind: 'agent', columns: ['Review'], status: 'skipped', sessions: [], verdict: null, round: null },
  ];

  it('draws the pipeline of a card with its verdict, round and skipped stage', () => {
    const page = render([issueRow({ stages: stagesOf({ verdict: 'changes_needed', round: 1 }) })]);
    const nodes = page.$('running').querySelectorAll('.pipe-node');
    assert.equal(nodes.length, 2);
    assert.match(nodes[0]!.title, /verdict: changes needed · round 1/);
    assert.match(nodes[1]!.className, /st-skipped/);
    assert.equal(page.$('running').querySelectorAll('.pipe-node.st-skipped').length, 1);
  });

  it('shows the dispatch note of a waiting card and no generic waiting hint', () => {
    const card = { retry: null, reason: null, section: 'next', status: 'queued', position: 1 };
    const noted = render([waiting({ ...card, dispatch_note: 'Blocked by #9' })]);
    assert.match(noted.$('next').textContent, /Blocked by #9/);
    const plain = render([waiting({ ...card, dispatch_note: null })]);
    assert.doesNotMatch(plain.root.textContent, /Waiting for a free agent slot or the next poll/);
  });

  it('shows the dispatch gate only when the session limit paused the dispatch', () => {
    const gate = { until: '2026-10-30T14:00:00Z', window: 'five_hour', issue_identifier: ID };
    const page = render([], { health: { ...dashboardState().health, dispatch_gate: gate } });
    assert.equal(page.$('dispatch-gate').hidden, false);
    assert.match(page.$('dispatch-gate-text').textContent, /^Dispatch paused until .* · session limit \(five_hour\) · started by acme\/app#2$/);
    assert.equal(render([]).$('dispatch-gate').hidden, true);
  });

  it('describes a session limit retry, also when the extra usage is off', () => {
    const limit = { waiting: true, resets_at: '2026-10-30T14:00:00Z', window: 'five_hour', text: 'You hit your limit', hits: 1, max_retries: 3, overage_disabled_reason: 'out_of_credits' };
    const retry = { kind: 'session_limit', attempt: 1, due_at: '2026-10-30T14:00:00Z', due_in_ms: 7_200_000, error: 'limit', limit };
    const page = render([waiting({ retry, reason: null })]);
    const text = page.$('waiting').textContent;
    assert.match(text, /waiting for reset/);
    assert.match(text, /five hour/);
    assert.match(text, /You hit your limit/);
    assert.match(text, /Extra usage is off because credits are used up\. Top up, then press Retry now\./);
  });

  it('lets the operator change and reset the agent slots', () => {
    const limits = { ...dashboardState().limits, override_active: true, max_concurrent_agents: { effective: 3, workflow: 10, override: 3 } };
    const page = render([], { limits });
    const slots = page.$('slot-settings');
    assert.equal(slots.hidden, false);
    const reset = slots.querySelector('button.slot-reset')!;
    assert.equal(reset.textContent, 'Reset to WORKFLOW.md (10)');
    const more = page.query('button.slot-control').find((b) => b.getAttribute('aria-label') === 'More agent slots')!;
    page.click(more);
    assert.deepEqual(page.fetches.at(-1), { url: '/api/v1/settings/agents', method: 'PUT', body: { max_concurrent_agents: 4 } });
    const again = render([], { limits });
    again.click(again.$('slot-settings').querySelector('button.slot-reset')!);
    assert.deepEqual([again.fetches.at(-1)!.url, again.fetches.at(-1)!.method], ['/api/v1/settings/agents', 'DELETE']);
  });

  it('warns when the limit is lowered below the running count', () => {
    const limits = { ...dashboardState().limits, max_concurrent_agents: { effective: 1, workflow: 10, override: 1 } };
    const page = render([], { limits, counts: { ...dashboardState().counts, running: 3 } });
    assert.match(page.$('slot-settings').textContent, /3 running, limit 1: no new starts until 3 finish/);
  });

  it('disables every control on a bind that does not allow remote control', () => {
    const page = render([waiting()], { controls: { retry: false } });
    assert.equal(buttons(page).length, 0);
    assert.match(page.$('waiting').textContent, /Controls disabled/);
  });
});

describe('agent page behaviour', () => {
  const opts = { url: AGENT_URL };
  const retrying = (retry: Record<string, unknown>) => issueDetail({ status: 'retrying', running: null, retry });
  const sessionLimit = { kind: 'session_limit', attempt: 1, due_at: '2026-10-30T13:00:00Z', due_in_ms: 3_600_000, error: 'limit', limit: { waiting: true, resets_at: '2026-10-30T13:00:00Z', window: 'five_hour', text: 'You hit the limit', hits: 1, max_retries: 3 } };

  it('shows a stage result with a link to its comment', () => {
    const results = [{ role: 'developer', kind: 'implementation', verdict: 'done', round: null, target: 'Agent review', summary: 'Done.', created_at: '2026-10-30T11:00:00Z', url: 'https://github.com/acme/app/issues/1#issuecomment-1', findings: [], blockers: [] }];
    const page = renderPage(AGENT_HTML, { detail: issueDetail({ results }) }, opts);
    const [link] = page.$('result-cards').querySelectorAll('a');
    assert.equal(link!.textContent, 'Comment ↗');
    assert.equal(link!.href, results[0]!.url);
    assert.equal(page.$('results-section').hidden, false);
  });

  it('explains a session limit with the window and the reset time', () => {
    const page = renderPage(AGENT_HTML, { detail: retrying(sessionLimit) }, opts);
    const alert = page.$('alert');
    assert.equal(alert.hidden, false);
    assert.match(alert.className, /tone-amber/);
    assert.match(alert.textContent, /Session limit reached/);
    assert.match(alert.textContent, /five hour/);
    assert.match(alert.textContent, /Resets at/);
    assert.match(page.$('main').textContent, /⏳ Waiting for limit/);
    const event = { seq: 1, at: '2026-10-30T11:59:00Z', kind: 'orchestrator', event: 'retry_scheduled', level: 'info', message: 'x', detail: { kind: 'session_limit', attempt: 1, due_at: '2026-10-30T13:00:00Z', limit: sessionLimit.limit } };
    const timeline = renderPage(AGENT_HTML, { detail: retrying(sessionLimit), events: [event], dirty: true }, opts);
    assert.match(timeline.$('timeline').textContent, /WAITING FOR RESET/);
  });

  it('counts the session limit retries while the limit is not yet waiting', () => {
    const limit = { ...sessionLimit.limit, waiting: false, hits: 1, max_retries: 3 };
    const event = { seq: 1, at: '2026-10-30T11:59:00Z', kind: 'orchestrator', event: 'retry_scheduled', level: 'info', message: 'x', detail: { kind: 'session_limit', attempt: 1, due_at: '2026-10-30T13:00:00Z', limit } };
    const page = renderPage(AGENT_HTML, { detail: retrying({ ...sessionLimit, limit }), events: [event], dirty: true }, opts);
    assert.match(page.$('timeline').textContent, /SESSION LIMIT · RETRY 1\/3/);
    assert.doesNotMatch(page.$('timeline').textContent, /WAITING FOR RESET/);
    assert.match(page.$('main').textContent, /⏳ Session limit #1/);
    assert.doesNotMatch(page.$('main').textContent, /Waiting for limit/);
  });

  it('labels a session that ended on the limit', () => {
    const session = { run: 'r1', attempt: null, role: 'default', state: 'Todo', model: null, effort: null, started_at: '2026-10-30T11:00:00Z', finished_at: '2026-10-30T11:30:00Z', outcome: 'session_limit', transcript: null };
    const page = renderPage(AGENT_HTML, { detail: issueDetail({ sessions: [session] }) }, opts);
    assert.match(page.$('main').textContent, /session limit/);
  });

  it('draws the pipeline with verdict, round and the skipped stage', () => {
    const pipeline = [
      { id: 'dev', label: 'developer', kind: 'agent', columns: ['In progress'], status: 'done', sessions: [], verdict: 'changes_needed', round: 1 },
      { id: 'rev', label: 'reviewer', kind: 'agent', columns: ['Review'], status: 'skipped', sessions: [], verdict: null, round: null },
    ];
    const page = renderPage(AGENT_HTML, { detail: issueDetail({ pipeline }) }, opts);
    const verdict = page.$('pipeline').querySelector('.pipe-verdict.vd-warn')!;
    assert.equal(verdict.textContent, 'changes needed · round 1');
    assert.equal(page.$('pipeline').querySelectorAll('.pipe-node.st-skipped').length, 1);
  });

  it('pauses a running issue and shows Resume now for an operator pause', () => {
    const running = renderPage(AGENT_HTML, { detail: issueDetail() }, opts);
    const pause = running.query('button.restart').find((b) => b.textContent === 'Pause')!;
    running.click(pause);
    assert.deepEqual(running.fetches.at(-1), { url: '/api/v1/acme%2Fapp%231/pause', method: 'POST' });
    const paused = renderPage(AGENT_HTML, { detail: issueDetail({ status: 'paused', running: null, paused: { source: 'operator', paused_at: '2026-10-30T11:50:00Z', continuations: 0 } }) }, opts);
    assert.match(paused.$('alert').textContent, /Paused by operator/);
    const resume = paused.query('button.restart').find((b) => b.textContent === 'Resume now')!;
    paused.click(resume);
    assert.equal(paused.fetches.at(-1)!.url, '/api/v1/acme%2Fapp%231/resume');
  });

  it('asks before Start now when every slot is taken', () => {
    const detail = retrying(sessionLimit);
    detail.slots = { running: 1, forced: 0, limit: 1 };
    const page = renderPage(AGENT_HTML, { detail }, { ...opts, confirm: false });
    const force = page.query('button.restart').find((b) => b.textContent === 'Start now')!;
    const before = page.fetches.length;
    page.click(force);
    assert.deepEqual(page.confirms, ['All 1 slot is busy. Start #1 in an extra slot?']);
    assert.equal(page.fetches.length, before);
  });

  it('lists the restart and extra-slot events in the timeline', () => {
    const event = (seq: number, name: string, message: string) => ({ seq, at: '2026-10-30T11:59:00Z', kind: 'orchestrator', event: name, level: 'info', message, detail: {} });
    const page = renderPage(AGENT_HTML, { detail: issueDetail(), events: [event(1, 'worker_restarted', 'Restarted'), event(2, 'worker_forced', 'Forced')], dirty: true }, opts);
    const text = page.$('timeline').textContent;
    assert.match(text, /WORKER RESTARTED/);
    assert.match(text, /STARTED IN AN EXTRA SLOT/);
  });

  it('fetches the incremental timeline and the session transcript while polling', async () => {
    const detail = issueDetail({ timeline_seq: 1, sessions: [{ run: 'r1', attempt: null, role: 'default', state: 'Todo', model: null, effort: null, started_at: '2026-10-30T11:00:00Z', finished_at: null, outcome: null, transcript: '/t/r1.jsonl' }] });
    const page = renderPage(AGENT_HTML, undefined, {
      ...opts,
      fetch: (url) => (url.includes('/timeline') ? { events: [], latest_seq: 1, first_seq: 1 } : url.includes('/transcript') ? { available: true, entries: [], next_offset: 0, more: false } : detail),
    });
    await until(() => page.fetches.some((f) => f.url.includes('/transcript?run=')), 3_000, 'transcript request');
    const urls = page.fetches.map((f) => f.url);
    assert.ok(urls.some((u) => u.endsWith('/timeline?after=0')), urls.join(' '));
    assert.ok(urls.some((u) => u.includes('/transcript?run=r1')));
  });
});
