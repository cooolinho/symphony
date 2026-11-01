import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { startHttpServer } from '../src/http/server.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { CHIP_TONES } from '../src/http/ui/palette.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { SystemCollector } from '../src/system/metrics.ts';
import { GithubGraphqlClient } from '../src/tracker/github-project/client.ts';
import { FakeElement, domContext, run } from './helpers/fake-dom.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, tempDir } from './helpers.ts';
import fs from 'node:fs';
import path from 'node:path';

// E2-2 (#352), independent acceptance tests derived from the issue: boundaries of the traffic light per tile, "—" handling,
// GPU tile, values 1:1 from the API (also through the real HTTP route), 10 s reload and the rate-limit header capture.

const GB = 1073741824;
const START = '// ------------------------------------------------------------------ system cards';
const END = '// ------------------------------------------------------------------ polling';

function pageContext() {
  const start = DASHBOARD_HTML.indexOf(START);
  const end = DASHBOARD_HTML.indexOf(END);
  assert.ok(start > 0 && end > start);
  return domContext(BASE_JS, DASHBOARD_HTML.slice(start, end));
}

function cardsOf(ctx: any, system: unknown, state: unknown): FakeElement[] {
  ctx.fx = { system, state, trend: { slots: [], github: [] } };
  return Array.from(run(ctx, 'systemCards(fx.system, fx.state, fx.trend)')) as FakeElement[];
}

const label = (c: FakeElement) => c.byClass('syscard-label')[0]!.textContent;
const val = (c: FakeElement) => c.byClass('mono')[0]!.textContent;
const tone = (c: FakeElement) => (['green', 'amber', 'red'] as const).find((t) => c.byClass('syscard-dot')[0]!.style.background === CHIP_TONES[t].c) ?? null;
const named = (l: FakeElement[], n: string) => l.find((c) => label(c) === n)!;

function system(over: { cpu?: number | null; memUsed?: number; load?: number; disks?: [string, number][]; gpu?: unknown } = {}) {
  const sample = (cpu: number | null) => ({
    at: '2026-10-31T10:00:00Z',
    cpu_percent: cpu,
    memory: { used_bytes: over.memUsed ?? 4 * GB, total_bytes: 10 * GB },
    load: { one: over.load ?? 1, five: 1, fifteen: 1 },
    disks: (over.disks ?? [['data', 10]]).map(([name, pct]) => ({ name, path: '/' + name, used_bytes: pct * GB, total_bytes: 100 * GB })),
    gpu: over.gpu ?? null,
  });
  const cpu = over.cpu === undefined ? 10 : over.cpu;
  const history = [sample(1), sample(2), sample(3), sample(4), sample(cpu)];
  return { current: history.at(-1), history, gpu: over.gpu ?? null, cpu_count: 10 };
}

const state = (running = 1, max = 4, queued = 0, api: unknown = { remaining: 5000, limit: 5000, reset_at: null, observed_at: 'x' }) => ({
  counts: { running, forced: 0, queued },
  health: { max_concurrent_agents: max, last_tick_at: new Date(Date.now() - 65_000).toISOString(), tracker_api: api },
});

describe('QA system cards: traffic light boundaries', () => {
  const ctx = pageContext();
  const cases: [number, string][] = [[0, 'green'], [79.9, 'green'], [80, 'amber'], [94.9, 'amber'], [95, 'red'], [100, 'red']];

  it('CPU: exact boundaries', () => {
    for (const [pct, t] of cases) assert.equal(tone(named(cardsOf(ctx, system({ cpu: pct }), state()), 'CPU')), t, String(pct));
  });
  it('memory: exact boundaries (8 / 10 GB = 80 %)', () => {
    for (const [pct, t] of cases) assert.equal(tone(named(cardsOf(ctx, system({ memUsed: (pct / 10) * GB }), state()), 'RAM')), t, String(pct));
  });
  it('disk: State card follows the state volume', () => {
    for (const [pct, t] of cases) {
      const l = cardsOf(ctx, system({ disks: [['state', pct]] }), state());
      assert.equal(tone(named(l, 'Disk · State')), t, String(pct));
    }
  });
  it('slots follow running / max, GitHub API follows the used share', () => {
    for (const [pct, t] of [[75, 'green'], [80, 'amber'], [100, 'red']] as const) {
      assert.equal(tone(named(cardsOf(ctx, system(), state(pct / 25, 4)), 'Agent-Slots')), t, 'slots ' + pct);
    }
    for (const [remaining, t] of [[1001, 'green'], [1000, 'amber'], [251, 'amber'], [250, 'red'], [0, 'red']] as const) {
      const api = { remaining, limit: 5000, reset_at: null, observed_at: 'x' };
      assert.equal(tone(named(cardsOf(ctx, system(), state(1, 4, 0, api)), 'GitHub API')), t, 'remaining ' + remaining);
    }
  });
  it('the bar takes the card colour below 80 %, amber from 80 % and red from 95 %', () => {
    const fill = (pct: number) => named(cardsOf(ctx, system({ cpu: pct }), state()), 'CPU').byClass('ui-bar-fill')[0]!.style.background;
    assert.equal(fill(10), '#38bdf8');
    assert.equal(fill(85), CHIP_TONES.amber.c);
    assert.equal(fill(96), CHIP_TONES.red.c);
  });
});

describe('QA system cards: "—" and GPU', () => {
  const ctx = pageContext();
  it('unreachable system and empty route answer: six tiles, host tiles with "—" and no bar', () => {
    for (const sys of [null, { current: null, history: [], gpu: null, cpu_count: null }]) {
      const l = cardsOf(ctx, sys, state());
      assert.equal(l.length, 6);
      for (const n of ['CPU', 'RAM', 'Disk · State', 'Load']) {
        assert.equal(val(named(l, n)), '—', n);
        assert.equal(named(l, n).byClass('ui-bar').length, 0, n);
        assert.equal(tone(named(l, n)), null, n);
      }
    }
  });
  it('each null field blanks exactly its own tile', () => {
    const s = system();
    (s.current as any).cpu_percent = null;
    (s.current as any).load = null;
    const l = cardsOf(ctx, s, state());
    assert.equal(val(named(l, 'CPU')), '—');
    assert.equal(val(named(l, 'Load')), '—');
    assert.notEqual(val(named(l, 'RAM')), '—');
    assert.notEqual(val(named(l, 'Disk · State')), '—');
  });
  it('GPU tile only for a non-null gpu', () => {
    assert.equal(cardsOf(ctx, system(), state()).some((c) => label(c) === 'GPU'), false);
    const gpu = { utilization_percent: 96, memory_used_mib: 100, memory_total_mib: 200, temperature_c: 70 };
    const l = cardsOf(ctx, system({ gpu }), state());
    assert.equal(l.length, 7);
    assert.equal(tone(named(l, 'GPU')), 'red');
  });
  it('untrusted host names reach the page as text only', () => {
    const l = cardsOf(ctx, system({ disks: [['state', 10], ['<img src=x onerror=1>', 20]] }), state());
    assert.ok(l.every((c) => c.find((e) => e.tagName === 'img').length === 0));
  });
});

describe('QA system cards: values 1:1, German, slots and API', () => {
  const ctx = pageContext();
  it('shows the counts and the poll age', () => {
    const l = cardsOf(ctx, system(), state(2, 5, 7, { remaining: 1234, limit: 5000, reset_at: null, observed_at: 'x' }));
    assert.equal(val(named(l, 'Agent-Slots')), '2');
    assert.match(named(l, 'Agent-Slots').textContent, /\/ 5/);
    assert.match(named(l, 'Agent-Slots').textContent, /3 frei · 7 in der Queue/);
    assert.match(named(l, 'GitHub API').textContent, /1\.234/);
    assert.match(named(l, 'GitHub API').textContent, /Poll vor \d+\s?(s|m|min).* · ok/);
    assert.match(named(l, 'RAM').textContent, /4\.0.*\/ 10\.0 GB/);
  });
  it('the State card reads the state volume, a second device adds Disk · Workspaces', () => {
    const s = system({ disks: [['state', 10], ['workspace', 55]] });
    (s.current as any).disks[0].device = 1;
    (s.current as any).disks[1].device = 2;
    const l = cardsOf(ctx, s, state());
    assert.equal(named(l, 'Disk · State').byClass('ui-bar')[0]!.getAttribute('aria-valuenow'), '10');
    assert.equal(named(l, 'Disk · Workspaces').byClass('ui-bar')[0]!.getAttribute('aria-valuenow'), '55');
  });
  it('sparkline carries one point per history sample', () => {
    const c = named(cardsOf(ctx, system(), state()), 'CPU');
    const svg = c.find((e) => e.tagName === 'svg')[0]!;
    const pts = svg.descendants().map((e) => e.getAttribute('points')).find(Boolean)!;
    assert.equal(pts.trim().split(/\s+/).length, 5);
  });
});

describe('QA system cards: polling', () => {
  it('registers a separate 10 s interval and keeps the 2 s state polling', () => {
    assert.match(DASHBOARD_HTML, /setInterval\(\s*loadSystem\s*,\s*10000\s*\)/);
    assert.match(DASHBOARD_HTML, /live\(\s*load\s*,\s*pollEvery\(\s*load\s*,\s*2000\s*\)\s*\)/);
    assert.ok(DASHBOARD_HTML.indexOf('id="system-cards"') < DASHBOARD_HTML.indexOf('id="stats"'));
  });
  it('a failing or non-ok /api/v1/system does not throw and leaves "—"', async () => {
    for (const fetchImpl of [
      async () => { throw new Error('down'); },
      async () => ({ ok: false, status: 503, json: async () => { throw new Error('no body'); } }),
    ]) {
      const ctx: any = pageContext();
      const host = new FakeElement('section');
      ctx.$ = () => host;
      run(ctx, 'patchChildren = (h, nodes) => h.replaceChildren(...nodes)');
      ctx.fetch = fetchImpl;
      await run(ctx, 'loadSystem()');
      assert.equal(host.children.length, 6);
      assert.equal(val(host.children[0]!), '—');
    }
  });
  it('a later successful load recovers the tiles', async () => {
    const ctx: any = pageContext();
    const host = new FakeElement('section');
    ctx.$ = () => host;
    run(ctx, 'patchChildren = (h, nodes) => h.replaceChildren(...nodes)');
    ctx.fetch = async () => { throw new Error('down'); };
    await run(ctx, 'loadSystem()');
    ctx.fetch = async () => ({ ok: true, json: async () => system({ cpu: 97 }) });
    await run(ctx, 'loadSystem()');
    assert.equal(val(host.children[0]!), '97');
    assert.equal(tone(host.children[0]!), 'red');
  });
});

describe('QA GET /api/v1/system and /api/v1/state feed the cards', () => {
  it('collector answer over HTTP renders to the same numbers', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'stat'), 'cpu  100 0 100 800 0 0 0 0 0 0\n');
    fs.writeFileSync(path.join(dir, 'meminfo'), 'MemTotal: 1048576 kB\nMemAvailable: 262144 kB\n');
    fs.writeFileSync(path.join(dir, 'loadavg'), '3.00 2.00 1.00 1/2 3\n');
    const collector = new SystemCollector({ procDir: dir, volumes: [], gpu: false, logger: { info() {} } as any, cpuCount: 8 });
    await collector.collect();
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
      runner: new FakeRunner(), logger: Logger.silent(), env: {}, logDir: null, timers: new ManualTimers(), createAdapter: () => new FakeTracker(),
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent(), system: collector });
    try {
      const sys = await (await fetch(`http://127.0.0.1:${server.port}/api/v1/system`)).json() as any;
      const st = await (await fetch(`http://127.0.0.1:${server.port}/api/v1/state`)).json() as any;
      assert.equal(sys.cpu_count, 8);
      assert.equal(st.health.tracker_api, null);
      const l = cardsOf(pageContext(), sys, st);
      assert.equal(l.length, 6);
      assert.equal(val(named(l, 'Load')), '3.00');
      assert.match(named(l, 'Load').textContent, /5 min 2\.00 · 15 min 1\.00/);
      assert.equal(val(named(l, 'RAM')), '0.8');
      assert.match(named(l, 'RAM').textContent, /\/ 1\.0 GB/);
      assert.equal(val(named(l, 'GitHub API')), '—');
      // one reading only: no CPU delta yet, so the API says null and the tile shows the dash
      assert.equal(sys.current.cpu_percent, null);
      assert.equal(val(named(l, 'CPU')), '—');
    } finally {
      await server.close();
    }
  });
});

describe('QA GitHub client rate-limit capture', () => {
  const client = (fetchImpl: typeof fetch) => new GithubGraphqlClient({ token: 't', timeoutMs: 5000, retries: 0, endpoint: 'https://api.github.test/graphql', fetch: fetchImpl } as any);
  const ok = (headers: Record<string, string>) => async () => new Response(JSON.stringify({ data: { x: 1 } }), { status: 200, headers });

  it('is null before any response and after one without headers', async () => {
    const c = client(ok({}));
    assert.equal(c.rateLimit(), null);
    await c.request('query { x }', {});
    assert.equal(c.rateLimit(), null);
  });
  it('reads remaining, limit and reset from a successful (200) response', async () => {
    const c = client(ok({ 'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1800000000' }));
    await c.request('query { x }', {});
    const r = c.rateLimit()!;
    assert.equal(r.remaining, 4999);
    assert.equal(r.limit, 5000);
    assert.equal(r.reset_at, new Date(1800000000_000).toISOString());
  });
  it('ignores malformed headers', async () => {
    const c = client(ok({ 'x-ratelimit-remaining': 'abc', 'x-ratelimit-limit': '5000' }));
    await c.request('query { x }', {});
    assert.equal(c.rateLimit(), null);
  });
  it('the newest response wins', async () => {
    let n = 5000;
    const c = client(async () => new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'x-ratelimit-remaining': String(--n), 'x-ratelimit-limit': '5000' } }));
    await c.request('query { x }', {});
    await c.request('query { x }', {});
    assert.equal(c.rateLimit()!.remaining, 4998);
  });
});
