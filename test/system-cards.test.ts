import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { startHttpServer } from '../src/http/server.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { CHIP_TONES } from '../src/http/ui/palette.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeElement, domContext, run } from './helpers/fake-dom.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, tempDir } from './helpers.ts';

// E2-2 (#352): system cards on the overview, rendered from fixture answers of /api/v1/system and /api/v1/state.

const START = '// ------------------------------------------------------------------ system cards';
const END = '// ------------------------------------------------------------------ polling';

function cardsContext() {
  const start = DASHBOARD_HTML.indexOf(START);
  const end = DASHBOARD_HTML.indexOf(END);
  assert.ok(start > 0 && end > start, 'the page script has a system cards section before polling');
  return domContext(BASE_JS, DASHBOARD_HTML.slice(start, end));
}

const GB = 1073741824;

function sample(cpu: number | null, at = '2026-10-30T10:00:00Z') {
  return {
    at,
    cpu_percent: cpu,
    memory: { used_bytes: 8053063680, total_bytes: 16 * GB },
    load: { one: 1.52, five: 0.9, fifteen: 0.4 },
    disks: [
      { name: 'state', path: '/data', used_bytes: 20 * GB, total_bytes: 100 * GB },
      { name: 'workspaces', path: '/ws', used_bytes: 45 * GB, total_bytes: 50 * GB },
    ],
    gpu: null as unknown,
  };
}

function systemFixture(cpu: number | null = 42.5, gpu: unknown = null) {
  const history = [sample(30, '2026-10-30T09:59:40Z'), sample(35, '2026-10-30T09:59:50Z'), sample(cpu)];
  for (const s of history) s.gpu = gpu;
  return { current: history.at(-1), history, gpu, cpu_count: 4 };
}

function stateFixture(overrides: { running?: number; max?: number; queued?: number; api?: unknown; lastTickAgoS?: number } = {}) {
  return {
    counts: { running: overrides.running ?? 2, forced: 0, queued: overrides.queued ?? 4 },
    health: {
      max_concurrent_agents: overrides.max ?? 3,
      last_tick_at: new Date(Date.now() - (overrides.lastTickAgoS ?? 12) * 1000).toISOString(),
      tracker_api: overrides.api === undefined ? { remaining: 4000, limit: 5000, reset_at: null, observed_at: '2026-10-30T10:00:00Z' } : overrides.api,
    },
  };
}

const ctx = cardsContext();
const cards = (system: unknown, state: unknown, trend: unknown = { slots: [], github: [] }): FakeElement[] => {
  ctx.fixture = { system, state, trend };
  return Array.from(run(ctx, 'systemCards(fixture.system, fixture.state, fixture.trend)'));
};
const label = (card: FakeElement) => card.byClass('ui-kpi-label')[0]!.textContent;
const value = (card: FakeElement) => card.byClass('ui-kpi-value')[0]!.textContent;
const sub = (card: FakeElement) => card.byClass('ui-kpi-sub')[0]?.textContent;
const bars = (card: FakeElement) => card.byClass('ui-bar');
const sparks = (card: FakeElement) => card.find((e) => e.tagName === 'svg' && e.classList.contains('ui-spark'));
const toneOf = (card: FakeElement) => card.className.split(' ').find((c) => c.startsWith('tone-')) ?? null;
const byLabel = (list: FakeElement[], name: string) => list.find((c) => label(c) === name)!;

describe('system cards: six tiles', () => {
  it('renders CPU, memory, disk, load, agent slots and GitHub API in this order', () => {
    const list = cards(systemFixture(), stateFixture());
    assert.equal(list.length, 6);
    assert.ok(list.every((c) => c.tagName === 'article' && c.classList.contains('syscard')));
    assert.deepEqual(list.map(label), ['CPU', 'Arbeitsspeicher', 'Festplatte', 'Load 1/5/15', 'Agent-Slots', 'GitHub-API']);
  });

  it('sits above the metric tiles in a grid row that falls back to two columns on narrow screens', () => {
    const cardsAt = DASHBOARD_HTML.indexOf('id="system-cards"');
    assert.ok(cardsAt > 0 && cardsAt < DASHBOARD_HTML.indexOf('id="stats"'));
    assert.match(DASHBOARD_HTML, /\.syscards \{ display: grid; grid-template-columns: repeat\(auto-fit, minmax\(170px, 1fr\)\)/);
    const narrow = DASHBOARD_HTML.slice(DASHBOARD_HTML.lastIndexOf('@media (max-width: 640px) {'));
    assert.match(narrow.slice(0, narrow.indexOf('\n  }\n')), /\.syscards \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  });
});

describe('system cards: value, bar and sparkline', () => {
  it('every tile has one value, at least one bar and a sparkline; the disk tile has one labelled bar per volume', () => {
    const list = cards(systemFixture(), stateFixture(), { slots: [50, 66.7], github: [10, 20] });
    for (const card of list) {
      assert.equal(card.byClass('ui-kpi-value').length, 1, label(card));
      assert.ok(bars(card).length >= 1, label(card));
      assert.equal(sparks(card).length, 1, label(card));
    }
    const disk = byLabel(list, 'Festplatte');
    assert.equal(bars(disk).length, 2);
    assert.deepEqual(disk.byClass('syscard-barlabel').map((e) => e.textContent), ['state', 'workspaces']);
    assert.deepEqual(bars(disk).map((b) => b.getAttribute('aria-valuenow')), ['20', '90']);
  });

  it('draws the sparkline from the history (one point per sample)', () => {
    const cpu = byLabel(cards(systemFixture(), stateFixture()), 'CPU');
    const line = sparks(cpu)[0]!.children[0]!;
    assert.equal(line.getAttribute('points')!.split(' ').length, 3);
  });
});

describe('system cards: traffic light', () => {
  it('CPU 42.5 % is green, 85 % amber, 96 % red, on the tile, the value and the bar', () => {
    for (const [cpu, tone] of [[42.5, 'green'], [85, 'amber'], [96, 'red']] as const) {
      const card = byLabel(cards(systemFixture(cpu), stateFixture()), 'CPU');
      assert.equal(toneOf(card), 'tone-' + tone, String(cpu));
      assert.equal(card.byClass('ui-kpi-value')[0]!.style.color, CHIP_TONES[tone].c);
      assert.equal(card.byClass('ui-bar-fill')[0]!.style.background, CHIP_TONES[tone].c);
    }
  });

  it('disk takes the fullest volume; slots and GitHub API follow their utilisation', () => {
    const list = cards(systemFixture(), stateFixture({ running: 4, max: 5, api: { remaining: 200, limit: 5000, reset_at: null, observed_at: 'x' } }));
    assert.equal(toneOf(byLabel(list, 'Festplatte')), 'tone-amber');
    assert.equal(toneOf(byLabel(list, 'Agent-Slots')), 'tone-amber');
    assert.equal(toneOf(byLabel(list, 'GitHub-API')), 'tone-red');
    assert.equal(bars(byLabel(list, 'GitHub-API'))[0]!.getAttribute('aria-valuenow'), '96');
  });
});

describe('system cards: missing values and the GPU', () => {
  it('without /api/v1/system the host tiles show "—" without bar, sparkline or tone', () => {
    const list = cards(null, stateFixture());
    assert.equal(list.length, 6);
    for (const card of list.slice(0, 4)) {
      assert.equal(value(card), '—', label(card));
      assert.equal(bars(card).length, 0, label(card));
      assert.equal(sparks(card).length, 0, label(card));
      assert.equal(toneOf(card), null, label(card));
      assert.ok(card.classList.contains('is-empty'));
    }
    assert.equal(value(byLabel(list, 'Agent-Slots')), '2 / 3');
  });

  it('a null value empties only its own tile', () => {
    const list = cards(systemFixture(null), stateFixture());
    assert.equal(value(byLabel(list, 'CPU')), '—');
    assert.equal(bars(byLabel(list, 'CPU')).length, 0);
    assert.equal(value(byLabel(list, 'Arbeitsspeicher')), '7.5 / 16.0 GB');

    const system = systemFixture();
    system.current = { ...system.current!, memory: null as never, load: null as never, disks: [{ name: 'state', path: '/d', used_bytes: null, total_bytes: null }] as never };
    const partial = cards(system, stateFixture());
    for (const name of ['Arbeitsspeicher', 'Load 1/5/15', 'Festplatte']) {
      assert.equal(value(byLabel(partial, name)), '—', name);
      assert.equal(bars(byLabel(partial, name)).length, 0, name);
    }
  });

  it('without a state, or without a tracker budget, slots and GitHub API show "—"', () => {
    const list = cards(systemFixture(), null);
    assert.equal(value(byLabel(list, 'Agent-Slots')), '—');
    assert.equal(value(byLabel(list, 'GitHub-API')), '—');
    assert.equal(bars(byLabel(list, 'GitHub-API')).length, 0);
    const noBudget = byLabel(cards(systemFixture(), stateFixture({ api: null })), 'GitHub-API');
    assert.equal(value(noBudget), '—');
    assert.equal(bars(noBudget).length, 0);
  });

  it('gpu null gives no GPU tile, a set GPU a seventh tile', () => {
    assert.equal(cards(systemFixture(), stateFixture()).length, 6);
    const gpu = { utilization_percent: 40, memory_used_mib: 1024, memory_total_mib: 8192, temperature_c: 61 };
    const list = cards(systemFixture(42.5, gpu), stateFixture());
    assert.equal(list.length, 7);
    const card = list.at(-1)!;
    assert.equal(label(card), 'GPU');
    assert.equal(value(card), '40 %');
    assert.equal(sub(card), '1024 / 8192 MiB · 61 °C');
    assert.equal(toneOf(card), 'tone-green');
    assert.equal(sparks(card).length, 1);
  });
});

describe('system cards: values as in the API, German texts', () => {
  it('shows the API values with GB / % as the only conversion', () => {
    const list = cards(systemFixture(), stateFixture());
    assert.equal(value(byLabel(list, 'CPU')), '42.5 %');
    assert.equal(value(byLabel(list, 'Arbeitsspeicher')), '7.5 / 16.0 GB');
    const disk = byLabel(list, 'Festplatte');
    assert.equal(value(disk), '45.0 / 50.0 GB');
    assert.equal(sub(disk), 'workspaces');
    const load = byLabel(list, 'Load 1/5/15');
    assert.equal(value(load), '1.52 / 0.90 / 0.40');
    assert.equal(sub(load), '4 Kerne');
    assert.equal(bars(load)[0]!.getAttribute('aria-valuenow'), '38');
    const slots = byLabel(list, 'Agent-Slots');
    assert.equal(value(slots), '2 / 3');
    assert.equal(sub(slots), 'Queue: 4');
    const api = byLabel(list, 'GitHub-API');
    assert.equal(value(api), '4,000 / 5,000');
    assert.equal(bars(api)[0]!.getAttribute('aria-valuenow'), '20');
    assert.equal(sub(api), 'letzter Poll vor 12s');
    assert.equal(sub(byLabel(cards(systemFixture(), { ...stateFixture(), health: { ...stateFixture().health, last_tick_at: null } }), 'GitHub-API')), 'noch kein Poll');
  });
});

describe('system cards: own 10 s interval', () => {
  it('loads /api/v1/system every 10 s next to the 2 s state polling, and a failure empties the tiles', () => {
    assert.match(DASHBOARD_HTML, /setInterval\(loadSystem, 10000\);/);
    assert.match(DASHBOARD_HTML, /live\(load, pollEvery\(load, 2000\)\);/);
    const source = DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf('async function loadSystem('));
    const body = source.slice(0, source.indexOf('\n  }\n'));
    assert.match(body, /fetch\('\/api\/v1\/system', \{ cache: 'no-store' \}\)/);
    assert.match(body, /catch \{\s*systemData = null;/);
  });

  it('loadSystem renders "—" when the request fails and keeps a 360-point trend for slots and GitHub API', async () => {
    const local = cardsContext();
    const host = new FakeElement('section');
    local.$ = () => host;
    // The fake DOM has no outerHTML to diff, so the test swaps all children.
    run(local, 'patchChildren = (h, nodes) => h.replaceChildren(...nodes)');
    local.fetch = async () => {
      throw new Error('offline');
    };
    await run(local, 'loadSystem()');
    assert.equal(host.children.length, 6);
    assert.equal(value(host.children[0]!), '—');
    local.fixture = stateFixture({ running: 1, max: 4 });
    run(local, 'lastState = fixture');
    local.fetch = async () => ({ ok: true, json: async () => systemFixture(85) });
    for (let i = 0; i < 365; i++) await run(local, 'loadSystem()');
    assert.equal(run(local, 'trend.slots.length'), 360);
    assert.equal(run(local, 'trend.slots.at(-1)'), 25);
    assert.equal(Math.round(run(local, 'trend.github.at(-1)')), 20);
    assert.equal(toneOf(host.children[0]!), 'tone-amber');
  });
});

describe('GET /api/v1/state: health.tracker_api', () => {
  const stateOf = async (tracker: FakeTracker) => {
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
      runner: new FakeRunner(),
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => tracker,
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/state`);
      return (await res.json()) as { health: { tracker_api: unknown } };
    } finally {
      await server.close();
    }
  };

  it('is null for a tracker without a budget', async () => {
    assert.equal((await stateOf(new FakeTracker())).health.tracker_api, null);
  });

  it('passes the budget of the adapter through unchanged', async () => {
    const tracker = new FakeTracker();
    const budget = { remaining: 4000, limit: 5000, reset_at: '2026-10-30T11:00:00.000Z', observed_at: '2026-10-30T10:00:00.000Z' };
    tracker.apiBudget = () => budget;
    assert.deepEqual((await stateOf(tracker)).health.tracker_api, budget);
  });
});
