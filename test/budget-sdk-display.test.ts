import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { TASKS_HTML } from '../src/http/tasks-page.ts';
import { renderPage, until } from './helpers.ts';
import { dashboardState } from './helpers/page-fixtures.ts';

// E4-9 (#467), independent acceptance tests derived from the issue. Clock of renderPage: 2026-10-30T12:00:00Z.

const UI_RED = '#f87171';
const AMBER = '#fbbf24';
const RESET = '2026-10-30T14:00:00.000Z';
const WEEK_RESET = '2026-11-04T10:00:00.000Z'; // a Wednesday
const ETA = '2026-10-30T13:00:00.000Z';
const EVENT = '2026-10-30T11:57:00.000Z';
const hm = (iso: string) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayHm = (iso: string) => `${new Date(iso).toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '')} ${hm(iso)}`;
const text = (n: { textContent: string }) => n.textContent.replace(/\s+/g, ' ').trim();

// token based value of the five_hour fixture: 720k / 2M = 36 %
function fiveWin(over: Record<string, unknown> = {}) {
  return {
    window: 'five_hour',
    used_tokens: 720_000,
    burn_rate_per_min: 2000,
    resets_at: RESET,
    forecast: { limit_tokens: 2_000_000, limit_source: 'sdk', eta: ETA },
    alert: false,
    by_role: {},
    ...over,
  };
}
const sdkFive = (percent: number, over: Record<string, unknown> = {}) =>
  fiveWin({ percent, percent_source: 'sdk', sdk: { utilization: percent / 100, resets_at: RESET, event_at: EVENT, status: 'allowed' }, ...over });
function rep(five: Record<string, unknown>, seven: Record<string, unknown> = {}) {
  return {
    five_hour: five,
    seven_day: { ...fiveWin({ used_tokens: 10_000_000, forecast: { limit_tokens: 20_000_000, limit_source: 'sdk', eta: null }, resets_at: WEEK_RESET }), window: 'seven_day', ...seven },
    generated_at: '2026-10-30T12:00:00.000Z',
  };
}
const gateState = (until: string, window = 'five_hour') => {
  const s = dashboardState();
  (s.health as Record<string, unknown>).dispatch_gate = { reason: 'session_limit', window, until, issue_identifier: 'acme/app#1' };
  return s;
};

async function overview(budget: unknown, state: unknown = dashboardState()) {
  const page = renderPage(DASHBOARD_HTML, state, {
    fetch: (url) => {
      if (url === '/api/v1/budget') return budget;
      if (url === '/api/v1/state') return state;
      if (url === '/api/v1/history') return { recent: [] };
      return {};
    },
  });
  await until(() => page.fetches.some((f) => f.url === '/api/v1/budget'), 3_000, 'budget fetch');
  await new Promise((r) => setTimeout(r, 30));
  return page;
}
type Page = Awaited<ReturnType<typeof overview>>;
const win = (page: Page, i: number) => page.query('.budget-win')[i]!;
const pctOf = (page: Page, i: number) => win(page, i).querySelectorAll('.budget-win-pct')[0]!;
const textOf = (page: Page, i: number) => text(win(page, i).querySelectorAll('.budget-win-text')[0]!);
const barOf = (page: Page, i: number) => win(page, i).querySelectorAll('.ui-bar')[0]!;
const chip = (page: Page) => {
  const n = page.$('shell-budget');
  return { text: text(n), tone: n.children.map((c) => c.className).join(' '), title: n.getAttribute('title') };
};

describe('E4-9 budgetPercent: SDK value first, tokens as fallback', () => {
  it('percent 72 beats 36 % from tokens in panel, bar and chip', async () => {
    const page = await overview(rep(sdkFive(72)));
    assert.equal(text(pctOf(page, 0)), '72 %');
    assert.equal(barOf(page, 0).getAttribute('aria-valuenow'), '72');
    assert.equal(chip(page).text, '5h 72 %');
  });

  it('percent 0 is a number and is not replaced by the token value', async () => {
    const page = await overview(rep(sdkFive(0)));
    assert.equal(text(pctOf(page, 0)), '0 %');
    assert.equal(chip(page).text, '5h 0 %');
    assert.doesNotMatch(chip(page).tone, /tone-/);
  });

  it('fractional percent is rounded the same way in panel and chip', async () => {
    const page = await overview(rep(sdkFive(71.6)));
    assert.equal(text(pctOf(page, 0)), '72 %');
    assert.equal(chip(page).text, '5h 72 %');
  });

  it('without percent (old answer shape) used / limit still applies in panel and chip', async () => {
    const page = await overview(rep(fiveWin()));
    assert.equal(text(pctOf(page, 0)), '36 %');
    assert.equal(chip(page).text, '5h 36 %');
    assert.equal(chip(page).title, `5-h-Fenster · Reset ${hm(RESET)}`);
  });

  it('percent null with a token value falls back to used / limit', async () => {
    const page = await overview(rep(fiveWin({ percent: null })));
    assert.equal(text(pctOf(page, 0)), '36 %');
    assert.equal(chip(page).text, '5h 36 %');
  });

  it('a non-numeric percent is ignored', async () => {
    const page = await overview(rep(fiveWin({ percent: '72' })));
    assert.equal(text(pctOf(page, 0)), '36 %');
  });

  it('week window uses its own SDK percent', async () => {
    const page = await overview(rep(sdkFive(40), { percent: 88, percent_source: 'sdk', sdk: { utilization: 0.88, resets_at: WEEK_RESET, event_at: EVENT, status: 'allowed' } }));
    assert.equal(text(pctOf(page, 1)), '88 %');
    assert.equal(pctOf(page, 1).style.color, UI_RED);
  });
});

describe('E4-9 5 h chip', () => {
  it('tone thresholds: 49 neutral, 50 amber, 84 amber, 85 red, 100 red', async () => {
    const expect: [number, RegExp | null][] = [[49, null], [50, /tone-amber/], [84, /tone-amber/], [85, /tone-red/], [100, /tone-red/]];
    for (const [p, tone] of expect) {
      const c = chip(await overview(rep(sdkFive(p))));
      assert.equal(c.text, `5h ${p} %`);
      if (tone) assert.match(c.tone, tone, String(p));
      else assert.doesNotMatch(c.tone, /tone-/, String(p));
    }
  });

  it('title per source: sdk with Stand, calibrated, none', async () => {
    const sdk = chip(await overview(rep(sdkFive(72))));
    assert.equal(sdk.title, `5-h-Fenster · 72 % laut SDK (Stand ${hm(EVENT)}) · Reset ${hm(RESET)}`);
    const cal = chip(await overview(rep(fiveWin({ percent: 36, percent_source: 'calibrated', sdk: null }))));
    assert.equal(cal.text, '5h 36 %');
    assert.equal(cal.title, `5-h-Fenster · 36 % geschätzt aus Tokens · Reset ${hm(RESET)}`);
    const none = chip(await overview(rep(fiveWin({ percent: null, percent_source: 'none', sdk: null, forecast: null }))));
    assert.equal(none.text, '5h —');
    assert.equal(none.title, '5-h-Fenster · Auslastung unbekannt');
  });

  it('the chip shows the SDK value on pages without a state poll', async () => {
    const page = renderPage(TASKS_HTML, undefined, { fetch: (u) => (u === '/api/v1/budget' ? rep(sdkFive(72)) : {}) });
    await until(() => page.fetches.some((f) => f.url === '/api/v1/budget'), 3_000, 'budget fetch');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(chip(page as unknown as Page).text, '5h 72 %');
    assert.match(chip(page as unknown as Page).tone, /tone-amber/);
  });
});

describe('E4-9 panel above 100 % and colours', () => {
  it('101 %: bar value capped at 100, number real, red, no hatch even with an ETA', async () => {
    const page = await overview(rep(sdkFive(101)));
    assert.equal(barOf(page, 0).getAttribute('aria-valuenow'), '100');
    assert.equal(text(pctOf(page, 0)), '101 %');
    assert.equal(pctOf(page, 0).style.color, UI_RED);
    assert.equal(win(page, 0).querySelectorAll('.ui-bar-forecast').length, 0);
  });

  it('colour switches at 85 %: 84 amber, 85 red', async () => {
    assert.equal(pctOf(await overview(rep(sdkFive(84))), 0).style.color, AMBER);
    assert.equal(pctOf(await overview(rep(sdkFive(85))), 0).style.color, UI_RED);
  });

  it('hatch only below 100 %: 99 % with ETA hatched, 100 % not, without ETA never', async () => {
    const at99 = await overview(rep(sdkFive(99)));
    const hatch = win(at99, 0).querySelectorAll('.ui-bar-forecast');
    assert.equal(hatch.length, 1);
    assert.equal(parseFloat(String(hatch[0]!.style.left)), 99);
    assert.equal(win(await overview(rep(sdkFive(100))), 0).querySelectorAll('.ui-bar-forecast').length, 0);
    const noEta = sdkFive(60, { forecast: { limit_tokens: 2_000_000, limit_source: 'sdk', eta: null } });
    assert.equal(win(await overview(rep(noEta)), 0).querySelectorAll('.ui-bar-forecast').length, 0);
  });

  it('hatch spans from the SDK value to 100 %', async () => {
    const page = await overview(rep(sdkFive(60)));
    const hatch = win(page, 0).querySelectorAll('.ui-bar-forecast')[0]!;
    assert.equal(parseFloat(String(hatch.style.left)), 60);
    assert.equal(parseFloat(String(hatch.style.width)), 40);
  });
});

describe('E4-9 source text', () => {
  it('sdk: source, burn, limit and reset in one text', async () => {
    const page = await overview(rep(sdkFive(72)));
    assert.equal(textOf(page, 0), `laut SDK · Stand ${hm(EVENT)} · Burn 120k Tokens/h · Limit ca. ${hm(ETA)} · Reset ${hm(RESET)}`);
  });

  it('calibrated: estimate text keeps burn and limit', async () => {
    const page = await overview(rep(fiveWin({ used_tokens: 1_500_000, percent: 75, percent_source: 'calibrated', sdk: null })));
    assert.equal(text(pctOf(page, 0)), '75 %');
    assert.equal(textOf(page, 0), `geschätzt aus Tokens · Burn 120k Tokens/h · Limit ca. ${hm(ETA)} · Reset ${hm(RESET)}`);
  });

  it('none: dash, "Noch kein Event seit dem Reset" with a reset, "Noch kein Rate-Limit-Event" without, unknown limit kept', async () => {
    const none = { percent: null, percent_source: 'none', sdk: null, forecast: null };
    const withReset = await overview(rep(fiveWin(none)));
    assert.equal(text(pctOf(withReset, 0)), '—');
    assert.match(textOf(withReset, 0), /^Noch kein Event seit dem Reset/);
    assert.match(String(barOf(withReset, 0).getAttribute('aria-valuetext')), /Grenze unbekannt/);
    assert.equal(win(withReset, 0).querySelectorAll('.ui-bar-forecast').length, 0);
    assert.doesNotMatch(text(win(withReset, 0)), /NaN/);
    const never = await overview(rep(fiveWin({ ...none, resets_at: null })));
    assert.match(textOf(never, 0), /^Noch kein Rate-Limit-Event/);
  });
});

describe('E4-9 week reset with weekday', () => {
  const branches: [string, Record<string, unknown>][] = [
    ['with ETA', { forecast: { limit_tokens: 20_000_000, limit_source: 'sdk', eta: ETA } }],
    ['burn, forecast, no ETA', { forecast: { limit_tokens: 20_000_000, limit_source: 'sdk', eta: null } }],
    ['burn, no forecast', { forecast: null }],
    ['no burn', { burn_rate_per_min: 0 }],
  ];
  for (const [name, over] of branches) {
    it(`${name}: week names the weekday, 5 h window does not`, async () => {
      const page = await overview(rep(fiveWin(over), { ...over, window: 'seven_day', resets_at: WEEK_RESET }));
      assert.ok(textOf(page, 1).includes(`Reset ${dayHm(WEEK_RESET)}`), textOf(page, 1));
      assert.ok(textOf(page, 0).includes(`Reset ${hm(RESET)}`), textOf(page, 0));
      assert.ok(!textOf(page, 0).includes(`Reset ${dayHm(RESET)}`), textOf(page, 0));
    });
  }

  it('SDK source text and weekday combine in the week', async () => {
    const page = await overview(rep(sdkFive(40), { percent: 55, percent_source: 'sdk', sdk: { utilization: 0.55, resets_at: WEEK_RESET, event_at: EVENT, status: 'allowed' } }));
    assert.match(textOf(page, 1), new RegExp(`^laut SDK · Stand ${hm(EVENT)} · .*Reset ${dayHm(WEEK_RESET)}`));
  });
});

describe('E4-9 dispatch pause', () => {
  const FUTURE = '2026-10-30T13:30:00.000Z';
  const PAST = '2026-10-30T11:00:00.000Z';

  it('five_hour pause: 100 %, red, no hatch, pause text instead of burn text, chip 100 % red', async () => {
    const page = await overview(rep(sdkFive(60)), gateState(FUTURE));
    assert.equal(text(pctOf(page, 0)), '100 %');
    assert.equal(pctOf(page, 0).style.color, UI_RED);
    assert.equal(barOf(page, 0).getAttribute('aria-valuenow'), '100');
    assert.equal(win(page, 0).querySelectorAll('.ui-bar-forecast').length, 0);
    assert.equal(textOf(page, 0), `Limit erreicht · pausiert bis ${hm(FUTURE)}`);
    assert.equal(chip(page).text, '5h 100 %');
    assert.match(chip(page).tone, /tone-red/);
    // the week is untouched
    assert.equal(text(pctOf(page, 1)), '50 %');
    assert.doesNotMatch(textOf(page, 1), /pausiert/);
  });

  it('an SDK value above 100 % stays during the pause', async () => {
    const page = await overview(rep(sdkFive(103)), gateState(FUTURE));
    assert.equal(text(pctOf(page, 0)), '103 %');
    assert.equal(chip(page).text, '5h 103 %');
    assert.match(chip(page).tone, /tone-red/);
  });

  it('a pause without any SDK value (source none) still shows 100 %', async () => {
    const none = fiveWin({ percent: null, percent_source: 'none', sdk: null, forecast: null });
    const page = await overview(rep(none), gateState(FUTURE));
    assert.equal(text(pctOf(page, 0)), '100 %');
    assert.equal(textOf(page, 0), `Limit erreicht · pausiert bis ${hm(FUTURE)}`);
  });

  it('seven_day pause: week 100 % red with pause text, 5 h window and chip untouched', async () => {
    const page = await overview(rep(sdkFive(60)), gateState('2026-11-04T10:00:00.000Z', 'seven_day'));
    assert.equal(text(pctOf(page, 1)), '100 %');
    assert.equal(pctOf(page, 1).style.color, UI_RED);
    assert.equal(win(page, 1).querySelectorAll('.ui-bar-forecast').length, 0);
    assert.equal(textOf(page, 1), `Limit erreicht · pausiert bis ${hm('2026-11-04T10:00:00.000Z')}`);
    assert.equal(text(pctOf(page, 0)), '60 %');
    assert.doesNotMatch(textOf(page, 0), /pausiert/);
    assert.equal(chip(page).text, '5h 60 %');
  });

  it('gate in the past, gate without until or for an unknown window: no pause display', async () => {
    for (const s of [gateState(PAST), gateState(FUTURE, 'month')]) {
      const page = await overview(rep(sdkFive(60)), s);
      assert.doesNotMatch(text(win(page, 0)), /pausiert|Limit erreicht/);
      assert.doesNotMatch(text(win(page, 1)), /pausiert|Limit erreicht/);
      assert.equal(text(pctOf(page, 0)), '60 %');
      assert.equal(chip(page).text, '5h 60 %');
    }
    const noUntil = dashboardState();
    (noUntil.health as Record<string, unknown>).dispatch_gate = { reason: 'session_limit', window: 'five_hour', until: null };
    const page = await overview(rep(sdkFive(60)), noUntil);
    assert.doesNotMatch(text(win(page, 0)), /pausiert/);
    assert.equal(chip(page).text, '5h 60 %');
  });

  it('the pause disappears with the next state without a gate (panel and chip)', async () => {
    const page = await overview(rep(sdkFive(60)), gateState(FUTURE));
    assert.equal(chip(page).text, '5h 100 %');
    const cleared = dashboardState();
    (cleared.health as Record<string, unknown>).dispatch_gate = null;
    page.render(cleared);
    assert.equal(text(pctOf(page, 0)), '60 %');
    assert.doesNotMatch(textOf(page, 0), /pausiert/);
    assert.equal(chip(page).text, '5h 60 %');
    assert.doesNotMatch(chip(page).tone, /tone-red/);
    assert.match(textOf(page, 0), /^laut SDK/);
    // and a later gate shows up again
    page.render(gateState(FUTURE));
    assert.equal(text(pctOf(page, 0)), '100 %');
    assert.equal(chip(page).text, '5h 100 %');
  });

  it('tasks page: active five_hour gate turns the chip to 100 % red, a cleared gate restores it', async () => {
    const state = gateState(FUTURE);
    const page = renderPage(TASKS_HTML, state, { fetch: (u) => (u === '/api/v1/budget' ? rep(sdkFive(60)) : u === '/api/v1/state' ? state : {}) });
    await until(() => page.fetches.some((f) => f.url === '/api/v1/budget'), 3_000, 'budget fetch');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(chip(page as unknown as Page).text, '5h 100 %');
    assert.match(chip(page as unknown as Page).tone, /tone-red/);
    const cleared = dashboardState();
    (cleared.health as Record<string, unknown>).dispatch_gate = null;
    page.render(cleared);
    assert.equal(chip(page as unknown as Page).text, '5h 60 %');
  });
});

describe('E4-9 E4-6 states stay', () => {
  it('unknown limit without percent: dash, aria-valuetext, no hatch', async () => {
    const page = await overview(rep(fiveWin({ forecast: null })));
    assert.equal(text(pctOf(page, 0)), '—');
    assert.match(String(barOf(page, 0).getAttribute('aria-valuetext')), /Grenze unbekannt/);
    assert.equal(win(page, 0).querySelectorAll('.ui-bar-forecast').length, 0);
    assert.equal(chip(page).text, '5h —');
  });

  it('zero usage without an SDK value shows the empty text', async () => {
    const zero = (o: Record<string, unknown>) => ({ ...o, used_tokens: 0, burn_rate_per_min: 0 });
    const r = rep(zero(fiveWin()), zero({ window: 'seven_day', forecast: null, resets_at: WEEK_RESET, alert: false, by_role: {} }));
    const page = await overview(r);
    assert.equal(textOf(page, 0), 'Noch kein Verbrauch heute');
    assert.equal(textOf(page, 1), 'Noch kein Verbrauch heute');
    assert.equal(win(page, 0).querySelectorAll('.ui-bar-forecast').length, 0);
  });
});
