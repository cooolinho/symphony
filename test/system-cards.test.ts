import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { startHttpServer } from '../src/http/server.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { CHIP_TONES, SYSTEM_COLORS } from '../src/http/ui/palette.ts';
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
      { name: 'state', path: '/data', used_bytes: 20 * GB, total_bytes: 100 * GB, device: 7 },
      { name: 'workspace', path: '/ws', used_bytes: 45 * GB, total_bytes: 50 * GB, device: 7 },
    ],
    gpu: null as unknown,
  };
}

function systemFixture(cpu: number | null = 42.5, gpu: unknown = null) {
  const history = [sample(30, '2026-10-30T09:59:40Z'), sample(35, '2026-10-30T09:59:50Z'), sample(cpu)];
  for (const s of history) s.gpu = gpu;
  return {
    current: history.at(-1), history, gpu, cpu_count: 4,
    host: { hostname: 'h1', container: null as string | null, uptime_seconds: 3600 },
    usage: { workspaces_bytes: 41 * GB, transcripts_bytes: 9 * GB, at: '2026-10-30T10:00:00Z' },
  };
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
const label = (card: FakeElement) => card.byClass('syscard-label')[0]!.textContent;
const value = (card: FakeElement) => card.byClass('mono')[0]!.textContent;
const unit = (card: FakeElement) => card.byClass('syscard-unit')[0]?.textContent;
const sub = (card: FakeElement) => card.byClass('syscard-sub')[0]?.textContent;
const dot = (card: FakeElement) => card.byClass('syscard-dot')[0]!.style.background;
const fill = (card: FakeElement) => card.byClass('ui-bar-fill')[0]?.style.background;
const bars = (card: FakeElement) => card.byClass('ui-bar');
const sparks = (card: FakeElement) => card.find((e) => e.tagName === 'svg' && e.classList.contains('ui-spark'));
const byLabel = (list: FakeElement[], name: string) => list.find((c) => label(c) === name)!;

describe('system cards: layout and order', () => {
  it('renders CPU, RAM, Disk · State, Load, Agent-Slots and GitHub API in this order as .gi cards', () => {
    const list = cards(systemFixture(), stateFixture());
    assert.ok(list.every((c) => c.tagName === 'article' && c.classList.contains('syscard') && c.classList.contains('gi')));
    assert.deepEqual(list.map(label), ['CPU', 'RAM', 'Disk · State', 'Load', 'Agent-Slots', 'GitHub API']);
  });

  it('a second volume on another device adds Disk · Workspaces right after Disk · State', () => {
    const system = systemFixture();
    (system.current as any).disks[1].device = 8;
    const list = cards(system, stateFixture());
    assert.deepEqual(list.map(label), ['CPU', 'RAM', 'Disk · State', 'Disk · Workspaces', 'Load', 'Agent-Slots', 'GitHub API']);
    assert.equal(value(list[3]!), '45');
    assert.equal(unit(list[3]!), '/ 50 GB');
  });

  it('is a 190px grid with 12px gap above the metric tiles, two columns on narrow screens, inside the System panel', () => {
    const cardsAt = DASHBOARD_HTML.indexOf('id="system-cards"');
    assert.ok(cardsAt > 0 && cardsAt < DASHBOARD_HTML.indexOf('id="stats"'));
    assert.match(DASHBOARD_HTML, /\.syscards \{ display: grid; grid-template-columns: repeat\(auto-fit, minmax\(190px, 1fr\)\); gap: 12px; \}/);
    assert.match(DASHBOARD_HTML, /\.syscard \{[^}]*padding: 14px 14px 10px;/);
    assert.match(DASHBOARD_HTML, /<h2 id="system-title">System<\/h2><span class="sys-host" id="system-host">/);
    const narrow = DASHBOARD_HTML.slice(DASHBOARD_HTML.lastIndexOf('@media (max-width: 640px) {'));
    assert.match(narrow.slice(0, narrow.indexOf('\n  }\n')), /\.syscards \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  });
});

describe('system cards: head with host, container and uptime', () => {
  const head = (system: unknown) => {
    const local = cardsContext();
    const node = new FakeElement('span');
    local.$ = () => node;
    local.fixture = system;
    run(local, 'systemData = fixture; renderSystemHost()');
    return node.textContent;
  };
  it('shows "Host <hostname> · Container <name or —> · seit <uptime>"', () => {
    assert.equal(head(systemFixture()), 'Host h1 · Container — · seit 1h 0m');
    const named = systemFixture();
    named.host = { hostname: 'box', container: 'symphony', uptime_seconds: 90_000 };
    assert.equal(head(named), 'Host box · Container symphony · seit 1 d 1 h');
    assert.equal(head(null), '');
  });
});

describe('system cards: value, unit, bar, sparkline and text', () => {
  it('every card has a value, a 5 px bar, a sparkline and a text line', () => {
    const list = cards(systemFixture(), stateFixture(), { slots: [50, 66.7], github: [10, 20] });
    for (const card of list) {
      assert.equal(card.byClass('mono').length, 1, label(card));
      assert.equal(bars(card).length, 1, label(card));
      assert.ok(bars(card)[0]!.classList.contains('ui-bar-h5'), label(card));
      assert.equal(sparks(card).length, 1, label(card));
      assert.ok(sub(card), label(card));
    }
  });

  it('draws the sparkline from the history (one point per sample)', () => {
    const cpu = byLabel(cards(systemFixture(), stateFixture()), 'CPU');
    assert.equal(sparks(cpu)[0]!.children[0]!.getAttribute('points')!.split(' ').length, 3);
  });

  it('shows value, unit and text as in the mockup', () => {
    const list = cards(systemFixture(34), stateFixture({ running: 2, max: 3, queued: 4 }));
    const at = (n: string) => byLabel(list, n);
    assert.deepEqual([value(at('CPU')), unit(at('CPU')), sub(at('CPU'))], ['34', '%', '4 Kerne · 2 Agents aktiv']);
    assert.deepEqual([value(at('RAM')), unit(at('RAM')), sub(at('RAM'))], ['7.5', '/ 16.0 GB', '47 % belegt']);
    assert.deepEqual([value(at('Disk · State')), unit(at('Disk · State')), sub(at('Disk · State'))], ['20', '/ 100 GB', 'Workspaces 41 GB · Transkripte 9 GB']);
    assert.deepEqual([value(at('Load')), unit(at('Load')), sub(at('Load'))], ['1.52', '1 min', '5 min 0.90 · 15 min 0.40']);
    assert.equal(bars(at('Load'))[0]!.getAttribute('aria-valuenow'), '38');
    assert.deepEqual([value(at('Agent-Slots')), unit(at('Agent-Slots')), sub(at('Agent-Slots'))], ['2', '/ 3', '1 frei · 4 in der Queue']);
    assert.deepEqual([value(at('GitHub API')), unit(at('GitHub API'))], ['4.000', '/ 5.000']);
    assert.match(sub(at('GitHub API'))!, /^Poll vor 12s? · ok$/);
  });

  it('without usage the disk text falls back to "% belegt"', () => {
    const system = systemFixture();
    (system as any).usage = null;
    assert.equal(sub(byLabel(cards(system, stateFixture()), 'Disk · State')), '20 % belegt');
  });
});

describe('system cards: colours and traffic light', () => {
  it('CPU at 34 / 82 / 97 %: dot and bar sky, amber, red', () => {
    for (const [cpu, tone, bar] of [[34, 'green', SYSTEM_COLORS.cpu], [82, 'amber', CHIP_TONES.amber.c], [97, 'red', CHIP_TONES.red.c]] as const) {
      const card = byLabel(cards(systemFixture(cpu), stateFixture()), 'CPU');
      assert.equal(dot(card), CHIP_TONES[tone].c, String(cpu));
      assert.equal(fill(card), bar, String(cpu));
    }
  });

  it('every card has its colour on bar and sparkline: RAM violet, disk green, load amber, slots green, GitHub grey', () => {
    const list = cards(systemFixture(), stateFixture(), { slots: [1, 2], github: [1, 2] });
    assert.equal(fill(byLabel(list, 'CPU')), '#38bdf8');
    assert.equal(fill(byLabel(list, 'RAM')), '#a78bfa');
    assert.equal(fill(byLabel(list, 'Disk · State')), '#34d399');
    assert.equal(fill(byLabel(list, 'Load')), '#fbbf24');
    assert.equal(fill(byLabel(list, 'Agent-Slots')), '#34d399');
    assert.equal(fill(byLabel(list, 'GitHub API')), '#cbd5e1');
  });

  it('the load percentage is load 1 min / cores', () => {
    const system = systemFixture();
    (system.current as any).load = { one: 3.88, five: 1, fifteen: 1 };
    const load = byLabel(cards(system, stateFixture()), 'Load');
    assert.equal(dot(load), CHIP_TONES.red.c);
    assert.equal(fill(load), CHIP_TONES.red.c);
  });

  it('slots and GitHub API follow their utilisation', () => {
    const list = cards(systemFixture(), stateFixture({ running: 4, max: 5, api: { remaining: 200, limit: 5000, reset_at: null, observed_at: 'x' } }));
    assert.equal(dot(byLabel(list, 'Agent-Slots')), CHIP_TONES.amber.c);
    assert.equal(dot(byLabel(list, 'GitHub API')), CHIP_TONES.red.c);
  });
});

describe('system cards: missing values and the GPU', () => {
  it('without /api/v1/system the host cards show "—" without bar, sparkline, text or colour', () => {
    const list = cards(null, stateFixture());
    assert.equal(list.length, 6);
    for (const card of list.slice(0, 4)) {
      assert.equal(value(card), '—', label(card));
      assert.equal(unit(card), undefined, label(card));
      assert.equal(bars(card).length, 0, label(card));
      assert.equal(sparks(card).length, 0, label(card));
      assert.equal(sub(card), undefined, label(card));
    }
    assert.equal(value(byLabel(list, 'Agent-Slots')), '2');
  });

  it('a null value empties only its own card', () => {
    const list = cards(systemFixture(null), stateFixture());
    assert.equal(value(byLabel(list, 'CPU')), '—');
    assert.equal(bars(byLabel(list, 'CPU')).length, 0);
    assert.equal(value(byLabel(list, 'RAM')), '7.5');

    const system = systemFixture();
    system.current = { ...system.current!, memory: null as never, load: null as never, disks: [{ name: 'state', path: '/d', used_bytes: null, total_bytes: null }] as never };
    for (const name of ['RAM', 'Load', 'Disk · State']) {
      const card = byLabel(cards(system, stateFixture()), name);
      assert.equal(value(card), '—', name);
      assert.equal(bars(card).length, 0, name);
      assert.equal(sparks(card).length, 0, name);
    }
  });

  it('without a state, or without a tracker budget, slots and GitHub API show "—"', () => {
    const list = cards(systemFixture(), null);
    assert.equal(value(byLabel(list, 'Agent-Slots')), '—');
    assert.equal(value(byLabel(list, 'GitHub API')), '—');
    const noBudget = byLabel(cards(systemFixture(), stateFixture({ api: null })), 'GitHub API');
    assert.equal(value(noBudget), '—');
    assert.equal(bars(noBudget).length, 0);
  });

  it('gpu null gives no GPU card, a set GPU a last card', () => {
    assert.equal(cards(systemFixture(), stateFixture()).length, 6);
    const gpu = { utilization_percent: 40, memory_used_mib: 1024, memory_total_mib: 8192, temperature_c: 61 };
    const list = cards(systemFixture(42.5, gpu), stateFixture());
    assert.equal(list.length, 7);
    const card = list.at(-1)!;
    assert.equal(label(card), 'GPU');
    assert.equal(value(card), '40');
    assert.equal(sub(card), '1024 / 8192 MiB · 61 °C');
    assert.equal(dot(card), CHIP_TONES.green.c);
    assert.equal(sparks(card).length, 1);
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
    assert.equal(dot(host.children[0]!), CHIP_TONES.amber.c);
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
