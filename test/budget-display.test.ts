import assert from 'node:assert/strict';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { TASKS_HTML } from '../src/http/tasks-page.ts';
import { ROLE_COLORS } from '../src/http/ui/palette.ts';
import { LAYOUT_JS } from '../src/http/ui/layout.ts';
import { renderPage, until } from './helpers.ts';
import { dashboardState, issueDetail, issueRow } from './helpers/page-fixtures.ts';

// E4-5 (#357): budget section on the overview and the 5 h chip in the header, rendered from fixture answers of
// /api/v1/budget (the test clock stands at 2026-10-30T12:00:00Z).

const RESET = '2026-10-30T14:00:00.000Z';
const ETA = '2026-10-30T13:00:00.000Z';

interface Opts { used?: number; limit?: number; eta?: string | null; burn?: number; alert?: boolean; byRole?: Record<string, number>; noForecast?: boolean }

function windowFixture(o: Opts = {}) {
  return {
    window: 'five_hour',
    used_tokens: o.used ?? 1_240_000,
    burn_rate_per_min: o.burn ?? 3000,
    resets_at: RESET,
    forecast: o.noForecast ? null : { limit_tokens: o.limit ?? 2_000_000, limit_source: 'sdk', eta: o.eta === undefined ? ETA : o.eta },
    alert: o.alert ?? false,
    by_role: o.byRole ?? { developer: 900_000, analyst: 40_000 },
  };
}

function budgetFixture(o: Opts = {}) {
  return { five_hour: windowFixture(o), seven_day: windowFixture({ ...o, used: 5_000_000, limit: 20_000_000, eta: null }), generated_at: '2026-10-30T12:00:00.000Z' };
}

function router(budget: unknown, state: unknown = dashboardState()) {
  return (url: string): unknown => {
    if (url === '/api/v1/budget') {
      if (budget instanceof Error) throw budget;
      return budget;
    }
    if (url === '/api/v1/state') return state;
    if (url === '/api/v1/history') return { recent: [] };
    return {};
  };
}

async function overview(budget: unknown, state: unknown = dashboardState()) {
  const page = renderPage(DASHBOARD_HTML, state, { fetch: router(budget, state) });
  await until(() => page.fetches.some((f) => f.url === '/api/v1/budget'), 3_000, 'budget fetch');
  await new Promise((r) => setTimeout(r, 20));
  return page;
}

const text = (node: { textContent: string }) => node.textContent.replace(/\s+/g, ' ');

describe('budget section (E4-5)', () => {
  it('known hit: bar per window with hatched forecast, reset, burn rate and ETA', async () => {
    const page = await overview(budgetFixture());
    assert.equal(page.$('budget').hidden, false);
    assert.equal(text(page.$('budget-title')), 'Budget');
    const windows = page.query('.budget-window');
    assert.equal(windows.length, 2);
    const five = windows[0] as typeof windows[number];
    assert.match(text(five), /5 Stunden/);
    const bar = five.querySelectorAll('.ui-bar');
    assert.equal(bar.length, 1);
    assert.equal(bar[0]?.getAttribute('role'), 'progressbar');
    assert.equal(bar[0]?.getAttribute('aria-valuenow'), '62');
    assert.equal(bar[0]?.getAttribute('aria-label'), '5-Stunden-Fenster');
    assert.equal(five.querySelectorAll('.ui-bar-forecast').length, 1);
    assert.match(text(five), /62 %/);
    assert.match(text(five), /Reset in 2h 0m/);
    assert.match(text(five), /Burn-Rate 3,000 Tokens\/min/);
    assert.match(text(five), /ETA /);
    assert.doesNotMatch(text(five), /Noch kein Limit-Treffer bekannt/);
    // 7-day window: forecast but no ETA yet
    const seven = windows[1] as typeof windows[number];
    assert.doesNotMatch(text(seven), /ETA/);
    assert.match(text(seven), /Reset in/);
  });

  it('no hit: only the usage, no hatching and no ETA, with the hint', async () => {
    const page = await overview(budgetFixture({ noForecast: true }));
    for (const w of page.query('.budget-window')) {
      assert.equal(w.querySelectorAll('.ui-bar-forecast').length, 0);
      assert.doesNotMatch(text(w), /ETA/);
      assert.match(text(w), /Noch kein Limit-Treffer bekannt/);
      assert.match(text(w), /Burn-Rate/);
      const bar = w.querySelectorAll('.ui-bar')[0];
      assert.equal(bar?.getAttribute('aria-valuenow'), null);
      assert.match(bar?.getAttribute('aria-valuetext') ?? '', /Tokens, Grenze unbekannt/);
    }
  });

  it('tokens per role: coloured dot, name, tokens, descending; empty text without tokens', async () => {
    const page = await overview(budgetFixture({ byRole: { analyst: 40_000, developer: 900_000 } }));
    const items = page.query('.budget-roles li');
    assert.deepEqual(items.map(text), ['Developer900.0K', 'Analyst40.0K']);
    assert.equal(items[0]!.querySelectorAll('.ui-dot')[0]!.style.background, ROLE_COLORS.developer);
    assert.equal(items[0]!.querySelectorAll('.mono').length, 1);
    const empty = await overview(budgetFixture({ byRole: {} }));
    assert.match(text(empty.$('budget-body')), /Keine Tokens im 5-h-Fenster/);
  });

  it('context hint: only for sessions above 70 %, with links; absent otherwise', async () => {
    const running = (id: string, percent: number | null) => {
      const r = structuredClone(issueRow().running as Record<string, unknown>);
      return { ...r, issue_id: id, issue_identifier: `acme/app#${id}`, context: { tokens: 1, window: 100, percent, compacts: 0 } };
    };
    const hot = dashboardState({ running: [running('1', 83), running('2', 71.5), running('3', 70), running('4', null)] });
    const page = await overview(budgetFixture(), hot);
    const hint = page.query('.budget-context');
    assert.equal(hint.length, 1);
    assert.match(text(hint[0]!), /^2 Sessions über 70 % Context/);
    const links = hint[0]!.querySelectorAll('a');
    assert.deepEqual(links.map((a) => a.getAttribute('href')), ['/issue?id=acme%2Fapp%231', '/issue?id=acme%2Fapp%232']);
    const one = await overview(budgetFixture(), dashboardState({ running: [running('1', 90)] }));
    assert.match(text(one.query('.budget-context')[0]!), /^1 Session über 70 % Context/);
    const cool = await overview(budgetFixture(), dashboardState({ running: [running('1', 70), running('2', null)] }));
    assert.equal(cool.query('.budget-context').length, 0);
  });

  it('numbers are monospace', async () => {
    const page = await overview(budgetFixture());
    const five = page.query('.budget-window')[0]!;
    const monos = five.querySelectorAll('.mono').map(text).join('|');
    assert.match(monos, /62 %/);
    assert.match(monos, /1\.2M \/ 2\.0M/);
  });

  it('stays hidden when the budget cannot be loaded or has the wrong shape', async () => {
    assert.equal((await overview(new Error('offline'))).$('budget').hidden, true);
    assert.equal((await overview({ nope: true })).$('budget').hidden, true);
  });
});

describe('5 h chip (E4-5)', () => {
  const chipOn = async (html: string, budget: unknown, opts: { url?: string } = {}) => {
    const other = router(budget);
    const page = renderPage(html, undefined, { ...opts, fetch: (url) => (url === '/api/v1/budget' ? other(url) : issueDetail()) });
    await until(() => page.fetches.some((f) => f.url === '/api/v1/budget'), 3_000, 'budget fetch');
    await new Promise((r) => setTimeout(r, 20));
    return page.$('shell-budget');
  };

  it('62 % is amber, 85 % red, 40 % neutral', async () => {
    const tone = (n: { children: Array<{ className: string }> }) => n.children.map((c) => c.className).join(' ');
    const amber = await chipOn(TASKS_HTML, budgetFixture());
    assert.equal(text(amber), '5h 62 %');
    assert.match(tone(amber), /\btone-amber\b/);
    const red = await chipOn(TASKS_HTML, budgetFixture({ used: 1_700_000 }));
    assert.equal(text(red), '5h 85 %');
    assert.match(tone(red), /\btone-red\b/);
    const neutral = await chipOn(TASKS_HTML, budgetFixture({ used: 800_000 }));
    assert.equal(text(neutral), '5h 40 %');
    assert.doesNotMatch(tone(neutral), /tone-/);
  });

  it('shows 5 h — without data, without forecast and on errors', async () => {
    for (const budget of [budgetFixture({ noForecast: true }), new Error('offline'), { nope: 1 }]) {
      const chip = await chipOn(TASKS_HTML, budget);
      assert.equal(text(chip), '5h —');
      assert.doesNotMatch(chip.className, /tone-/);
    }
  });

  it('is loaded on every page', async () => {
    assert.equal(text(await chipOn(AGENT_HTML, budgetFixture(), { url: 'http://127.0.0.1/issue?id=acme%2Fapp%231' })), '5h 62 %');
    assert.equal(text(await chipOn(DASHBOARD_HTML, budgetFixture())), '5h 62 %');
  });

  it('reloads every 30 seconds', () => {
    const intervals: number[] = [];
    const ctx = vm.createContext({
      document: { getElementById: () => null },
      setInterval: (_fn: unknown, ms: number) => intervals.push(ms),
      fetch: () => Promise.reject(new Error('x')),
      fmtClock: () => '',
    });
    vm.runInContext(LAYOUT_JS, ctx);
    assert.ok(intervals.includes(30_000));
  });
});

