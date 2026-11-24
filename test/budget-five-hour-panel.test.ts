import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { renderPage, until } from './helpers.ts';
import type { FakeElement } from './helpers/fake-dom.ts';
import { dashboardState } from './helpers/page-fixtures.ts';

// #605: the 5 h utilisation chart below the 5 h bar of "Context-Budget · heute". Clock of renderPage: 2026-10-30T12:00:00Z.

const NOW = '2026-10-30T12:00:00.000Z';
const RESET = '2026-10-30T14:00:00.000Z';
const FROM = '2026-10-30T09:00:00.000Z';
const ETA = '2026-10-30T13:00:00.000Z';
const MIN = 60_000;
const t = (iso: string, min: number) => new Date(Date.parse(iso) + min * MIN).toISOString();
const hm = (iso: string) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const text = (n: { textContent: string }) => n.textContent.replace(/\s+/g, ' ').trim();

function budget(eta: string | null = ETA, percent = 80) {
  const w = (window: string) => ({
    window, used_tokens: 1_000_000, burn_rate_per_min: 2000, utilization_rate_per_min: 0.005, resets_at: RESET,
    forecast: { limit_tokens: null, limit_source: 'sdk', eta }, sdk: null, percent, percent_source: 'sdk', alert: eta !== null, by_role: {},
  });
  return { five_hour: w('five_hour'), seven_day: { ...w('seven_day'), forecast: null, alert: false, percent: 20 }, generated_at: NOW };
}

interface Pt { at: string; percent: number; rejected?: boolean }
function win(points: Pt[], o: { resets_at?: string; pause?: { from: string; to: string } | null; current?: boolean } = {}) {
  const pts = points.map((p) => ({ rejected: false, ...p }));
  const peak = pts.reduce((a, b) => (b.percent > a.percent ? b : a));
  const over = pts.find((p) => p.percent > 100 || p.rejected);
  return { start: pts[0]!.at, resets_at: o.resets_at ?? RESET, points: pts, peak, over_limit: !!over, over_limit_at: over?.at ?? null, pause: o.pause ?? null, current: o.current ?? true };
}
const rising = (to: number, minutes = 180) => Array.from({ length: 10 }, (_, i) => ({ at: t(FROM, ((i + 1) * minutes) / 10), percent: Math.round(((i + 1) * to) / 10) }));

function windowSeries(windows: unknown[], forecast: unknown = null) {
  return { range: 'window', now: NOW, from: FROM, to: RESET, percent_source: windows.length ? 'sdk' : 'none', windows, forecast, summary: { windows: windows.length, over_limit: 0, paused_min: 0 } };
}
const FORECAST = windowSeries([win(rising(80))], { from: { at: NOW, percent: 80 }, to: { at: RESET, percent: 140 }, eta: ETA, rate_pct_per_min: 0.5 });
const OVER_AT = t(FROM, 109);
const OVER = windowSeries([
  win([...rising(98, 100), { at: OVER_AT, percent: 112, rejected: true }, { at: t(FROM, 150), percent: 112 }], { pause: { from: OVER_AT, to: RESET } }),
]);
function rangeSeries(range: 'day' | 'week', over: boolean) {
  const start = new Date(Date.parse(NOW) - (range === 'day' ? 24 : 168) * 60 * MIN).toISOString();
  const windows = [0, 6, 12].map((h, i) => {
    const s = t(start, h * 60 + 30);
    const top = over && i === 1 ? 112 : 60;
    return win([{ at: s, percent: 10 }, { at: t(s, 120), percent: top - 20 }, { at: t(s, 240), percent: top, rejected: over && i === 1 }], {
      resets_at: t(s, 300), current: false, pause: over && i === 1 ? { from: t(s, 240), to: t(s, 300) } : null,
    });
  });
  return { range, now: NOW, from: start, to: NOW, percent_source: 'sdk', windows, forecast: null, summary: over ? { windows: 21, over_limit: 7, paused_min: 516 } : { windows: 3, over_limit: 0, paused_min: 0 } };
}

async function overview(series: Record<string, unknown>, opts: { report?: unknown; state?: Record<string, unknown> } = {}) {
  const state = opts.state ?? dashboardState();
  const page = renderPage(DASHBOARD_HTML, state, {
    fetch: (url) => {
      if (url.startsWith('/api/v1/budget/five-hour')) {
        const range = new URL(url, 'http://x').searchParams.get('range') ?? '';
        return series[range] ?? { __status: 500 };
      }
      if (url === '/api/v1/budget') return opts.report ?? budget();
      if (url === '/api/v1/state') return state;
      if (url === '/api/v1/history') return { recent: [] };
      return {};
    },
  });
  await until(() => page.fetches.some((f) => f.url.startsWith('/api/v1/budget/five-hour')), 3_000, 'five-hour fetch');
  await new Promise((r) => setTimeout(r, 30));
  return page;
}
const chart = (page: { query(s: string): FakeElement[] }) => page.query('.b5h')[0]!;
const fiveFetches = (page: { fetches: { url: string }[] }) => page.fetches.filter((f) => f.url.startsWith('/api/v1/budget/five-hour')).map((f) => f.url);

describe('#605 chart below the 5 h bar', () => {
  it('sits between the 5 h bar and the week, shows percent ticks up to 125 % and stays the same node', async () => {
    const page = await overview({ window: FORECAST });
    const body = page.$('budget-body');
    const host = chart(page);
    assert.equal(body.children[1], host);
    assert.equal(body.children[0]!.getAttribute('data-window'), 'five_hour');
    assert.equal(body.children[2]!.getAttribute('data-window'), 'seven_day');
    const svg = host.querySelector('svg')!;
    assert.equal(svg.getAttribute('role'), 'img');
    const ticks = host.querySelectorAll('text.b5h-tick').map(text);
    for (const v of ['0%', '25%', '50%', '75%', '100%', '125%']) assert.ok(ticks.includes(v), v);
    assert.equal(host.querySelectorAll('path.b5h-line').length, 1);
    page.render(dashboardState());
    assert.equal(page.$('budget-body').children[1], host);
  });

  it('colours and type come from tokens, no hex colour in the chart code', async () => {
    const { BUDGET_CHART_CSS, BUDGET_CHART_JS } = await import('../src/http/budget-chart.ts');
    assert.doesNotMatch(BUDGET_CHART_CSS + BUDGET_CHART_JS, /#[0-9a-f]{3,6}\b/i);
    assert.match(BUDGET_CHART_CSS, /\.b5h-line \{[^}]*var\(--amber\)/);
    assert.match(BUDGET_CHART_CSS, /\.b5h-line-over \{[^}]*var\(--red\)/);
  });
});

describe('#605 limit line, over-limit section, pauses', () => {
  it('the dashed red 100 % line with "5-h-Limit" shows below the limit too', async () => {
    const page = await overview({ window: FORECAST });
    const host = chart(page);
    const limit = host.querySelectorAll('line.b5h-limit');
    assert.equal(limit.length, 1);
    assert.equal(text(host.querySelector('text.b5h-limit-lbl')!), '5-h-Limit');
    assert.match(DASHBOARD_HTML, /\.b5h-limit \{[^}]*stroke: var\(--red\)[^}]*stroke-dasharray/);
  });

  it('no red section, no peak label and no hatch without an overshoot', async () => {
    const host = chart(await overview({ window: FORECAST }));
    assert.equal(host.querySelectorAll('.b5h-line-over').length, 0);
    assert.equal(host.querySelectorAll('.b5h-area-over').length, 0);
    assert.equal(host.querySelectorAll('.b5h-peak-lbl').length, 0);
    assert.equal(host.querySelectorAll('rect.b5h-pause').length, 0);
  });

  it('above 100 %: red line and area, "+12 %" at the peak, hatched pause', async () => {
    const host = chart(await overview({ window: OVER }));
    assert.equal(host.querySelectorAll('path.b5h-line-over').length, 1);
    assert.equal(host.querySelectorAll('path.b5h-area-over').length, 1);
    assert.equal(host.querySelectorAll('circle.b5h-peak').length, 1);
    assert.equal(text(host.querySelector('text.b5h-peak-lbl')!), '+12 %');
    assert.equal(host.querySelectorAll('rect.b5h-pause').length, 1);
    assert.equal(host.querySelector('rect.b5h-pause')!.getAttribute('class'), 'b5h-pause');
  });

  it('a window over the limit only by a rejected event at 100 % gets the peak dot, no "+0 %"', async () => {
    const host = chart(await overview({ window: windowSeries([win([...rising(90, 100), { at: OVER_AT, percent: 100, rejected: true }], { pause: { from: OVER_AT, to: RESET } })]) }));
    assert.equal(host.querySelectorAll('circle.b5h-peak').length, 1);
    assert.equal(host.querySelectorAll('text.b5h-peak-lbl').length, 0);
  });

  it('week: the peak keeps only its dot', async () => {
    const page = await overview({ window: FORECAST, week: rangeSeries('week', true) });
    page.click(chart(page).querySelectorAll('.ui-seg-btn')[2]!);
    await until(() => chart(page).querySelectorAll('circle.b5h-peak').length > 0, 3_000, 'week drawn');
    assert.equal(chart(page).querySelectorAll('text.b5h-peak-lbl').length, 0);
  });
});

describe('#605 range switch, now, forecast, limit marker', () => {
  it('Fenster is the default; a switch loads exactly once more with the new range', async () => {
    const page = await overview({ window: FORECAST, day: rangeSeries('day', true) });
    const buttons = chart(page).querySelectorAll('.ui-seg-btn');
    assert.deepEqual(buttons.map(text), ['Fenster', '24 h', '7 Tage']);
    assert.equal(buttons[0]!.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(fiveFetches(page), ['/api/v1/budget/five-hour?range=window']);
    page.render(dashboardState());
    assert.equal(fiveFetches(page).length, 1, 'a state render does not reload the chart');
    page.click(buttons[1]!);
    await until(() => chart(page).querySelectorAll('line.b5h-reset').length > 0, 3_000, 'day drawn');
    assert.deepEqual(fiveFetches(page), ['/api/v1/budget/five-hour?range=window', '/api/v1/budget/five-hour?range=day']);
    page.click(buttons[1]!);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fiveFetches(page).length, 2, 'clicking the selected range again does not reload');
    assert.equal(buttons[1]!.getAttribute('aria-pressed'), 'true');
    assert.equal(buttons[0]!.getAttribute('aria-pressed'), 'false');
  });

  it('Fenster shows "jetzt", the dashed forecast and "Limit ca. HH:MM" equal to forecast.eta of /api/v1/budget and the bar text', async () => {
    const page = await overview({ window: FORECAST });
    const host = chart(page);
    assert.equal(host.querySelectorAll('line.b5h-now').length, 1);
    assert.equal(text(host.querySelector('text.b5h-now-lbl')!), 'jetzt');
    assert.ok(host.querySelectorAll('path.b5h-forecast').length >= 1);
    assert.equal(host.querySelectorAll('line.b5h-reset').length, 0);
    const label = text(host.querySelector('text.b5h-eta-lbl')!);
    assert.equal(label, 'Limit ca. ' + hm(ETA));
    const barText = text(page.query('.budget-win-text')[0]!);
    assert.ok(barText.includes('Limit ca. ' + hm(ETA)), barText);
  });

  it('no limit marker without an ETA in the budget report', async () => {
    const host = chart(await overview({ window: FORECAST }, { report: budget(null) }));
    assert.equal(host.querySelectorAll('.b5h-eta-lbl').length, 0);
  });

  it('no limit marker once the window is over the limit (the text line says so instead)', async () => {
    const host = chart(await overview({ window: OVER }, { report: budget(NOW, 112) }));
    assert.equal(host.querySelectorAll('circle.b5h-eta').length + host.querySelectorAll('.b5h-eta-lbl').length, 0);
    assert.equal(host.querySelectorAll('text.b5h-peak-lbl').length, 1);
  });

  it('legend: Prognose only in Fenster, Reset only in 24 h / 7 Tage', async () => {
    const page = await overview({ window: FORECAST, day: rangeSeries('day', false) });
    const legend = () => chart(page).querySelector('.b5h-legend')!.children.map(text);
    assert.deepEqual(legend(), ['Auslastung', 'Prognose', '5-h-Limit (100 %)', 'über Limit', 'pausiert']);
    page.click(chart(page).querySelectorAll('.ui-seg-btn')[1]!);
    await until(() => legend().includes('Reset'), 3_000, 'day legend');
    assert.deepEqual(legend(), ['Auslastung', '5-h-Limit (100 %)', 'über Limit', 'pausiert', 'Reset']);
  });
});

describe('#605 text line', () => {
  it('forecast: limit time and minutes before the reset', async () => {
    const host = chart(await overview({ window: FORECAST }));
    assert.equal(text(host.querySelector('.b5h-text')!), `Fenster ${hm(FROM)}–${hm(RESET)} · bei aktuellem Tempo Limit ca. ${hm(ETA)}, 60 min vor dem Reset`);
  });

  it('over the limit: time of the overshoot, peak and pause end, in red', async () => {
    const host = chart(await overview({ window: OVER }, { report: budget(NOW, 112) }));
    assert.equal(text(host.querySelector('.b5h-text')!), `Fenster ${hm(FROM)}–${hm(RESET)} · Limit überschritten um ${hm(OVER_AT)} (Spitze 112 %) · pausiert bis ${hm(RESET)}`);
    assert.equal(text(host.querySelector('.b5h-text .b5h-red')!), `Limit überschritten um ${hm(OVER_AT)} (Spitze 112 %)`);
  });

  it('a running gate pause without a pause in the history is drawn and named', async () => {
    const state = dashboardState();
    const gateUntil = '2026-10-30T13:30:00.000Z';
    (state.health as Record<string, unknown>).dispatch_gate = { reason: 'session_limit', window: 'five_hour', until: gateUntil, issue_identifier: 'acme/app#1' };
    const host = chart(await overview({ window: FORECAST }, { state }));
    assert.equal(host.querySelectorAll('rect.b5h-pause').length, 1);
    assert.ok(text(host.querySelector('.b5h-text')!).endsWith('· pausiert bis ' + hm(gateUntil)));
  });

  it('24 h: windows, overshoots and paused minutes; resets dotted', async () => {
    const page = await overview({ window: FORECAST, day: rangeSeries('day', true) });
    page.click(chart(page).querySelectorAll('.ui-seg-btn')[1]!);
    await until(() => chart(page).querySelectorAll('line.b5h-reset').length > 0, 3_000, 'day drawn');
    const host = chart(page);
    assert.equal(text(host.querySelector('.b5h-text')!), '21 Fenster · 7× über Limit · 516 min pausiert');
    assert.equal(text(host.querySelector('.b5h-text .b5h-red')!), '7× über Limit');
    assert.equal(host.querySelectorAll('line.b5h-reset').length, 3);
    assert.equal(host.querySelectorAll('path.b5h-line').length, 3, 'one tooth per window');
    assert.equal(host.querySelectorAll('line.b5h-now').length, 0);
  });

  it('24 h without overshoot: "nie über Limit"', async () => {
    const page = await overview({ window: FORECAST, day: rangeSeries('day', false) });
    page.click(chart(page).querySelectorAll('.ui-seg-btn')[1]!);
    await until(() => text(chart(page).querySelector('.b5h-text') ?? { textContent: '' }).startsWith('3 Fenster'), 3_000, 'day text');
    assert.equal(text(chart(page).querySelector('.b5h-text')!), '3 Fenster · nie über Limit');
  });
});

describe('#605 tooltip and empty state', () => {
  it('hovering a point shows its time and percent, above 100 % with "(über Limit)"', async () => {
    const host = chart(await overview({ window: OVER }));
    const hit = host.querySelector('rect.b5h-hit')!;
    const tip = host.querySelector('.b5h-tip')!;
    assert.equal(tip.hidden, true);
    const x = 34 + ((Date.parse(OVER_AT) - Date.parse(FROM)) / (Date.parse(RESET) - Date.parse(FROM))) * (600 - 42);
    hit.dispatch('mousemove', { offsetX: x });
    assert.equal(tip.hidden, false);
    assert.equal(text(tip), `${hm(OVER_AT)} · 112 % (über Limit)`);
    hit.dispatch('mousemove', { offsetX: 34 + 558 / 300 * 18 });
    assert.equal(text(tip), `${hm(t(FROM, 20))} · 20 %`);
    hit.dispatch('mouseleave');
    assert.equal(tip.hidden, true);
  });

  it('7 Tage: the tooltip names the weekday', async () => {
    const week = rangeSeries('week', false);
    const page = await overview({ window: FORECAST, week });
    page.click(chart(page).querySelectorAll('.ui-seg-btn')[2]!);
    await until(() => chart(page).querySelectorAll('line.b5h-reset').length > 0, 3_000, 'week drawn');
    const pt = week.windows[0]!.points[0]!;
    const x = 34 + ((Date.parse(pt.at) - Date.parse(week.from)) / (Date.parse(week.to) - Date.parse(week.from))) * 558;
    chart(page).querySelector('rect.b5h-hit')!.dispatch('mousemove', { offsetX: x });
    const day = new Date(pt.at).toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '');
    assert.equal(text(chart(page).querySelector('.b5h-tip')!), `${day} ${hm(pt.at)} · 10 %`);
  });

  it('without points: "Noch keine Auslastung im Zeitraum" instead of an empty plot', async () => {
    const host = chart(await overview({ window: windowSeries([]) }));
    assert.equal(text(host.querySelector('.b5h-empty')!), 'Noch keine Auslastung im Zeitraum');
    assert.equal(host.querySelectorAll('svg').length, 0);
    assert.equal(host.querySelectorAll('.b5h-text').length, 0);
    assert.equal(host.querySelectorAll('.ui-seg-btn').length, 3);
  });

  it('an answer of another shape (the budget report) or an error shows the empty state, no exception', async () => {
    const page = await overview({ window: budget() as unknown as Record<string, unknown> });
    assert.equal(chart(page).querySelectorAll('.b5h-empty').length, 1);
    const failed = await overview({});
    assert.equal(chart(failed).querySelectorAll('.b5h-empty').length, 1);
  });
});

describe('#605 review round: running gate and peak label', () => {
  const gated = (until: string) => {
    const state = dashboardState();
    (state.health as Record<string, unknown>).dispatch_gate = { reason: 'session_limit', window: 'five_hour', until, issue_identifier: 'acme/app#1' };
    return state;
  };

  it('24 h: a gate without a running window is hatched from now, not over the gap, and the text counts it', async () => {
    const state = gated('2026-10-30T13:30:00.000Z');
    const page = await overview({ window: FORECAST, day: rangeSeries('day', false) }, { state });
    page.click(chart(page).querySelectorAll('.ui-seg-btn')[1]!);
    await until(() => chart(page).querySelectorAll('line.b5h-reset').length > 0, 3_000, 'day drawn');
    const host = chart(page);
    const rects = host.querySelectorAll('rect.b5h-pause');
    assert.equal(rects.length, 1);
    // the last window ended 6.5 h ago: the hatch starts at now (right edge of the 24 h plot), the gap stays empty
    assert.ok(Number(rects[0]!.getAttribute('x')) >= 590, String(rects[0]!.getAttribute('x')));
    assert.equal(text(host.querySelector('.b5h-text')!), '3 Fenster · 1× über Limit · 0 min pausiert');
  });

  it('24 h: a gate on the running window adds its minutes and overshoot to the text line', async () => {
    const state = gated('2026-10-30T13:30:00.000Z');
    const day = rangeSeries('day', false);
    const running = win([{ at: t(NOW, -120), percent: 50 }, { at: t(NOW, -60), percent: 90 }], { resets_at: '2026-10-30T13:30:00.000Z', current: true });
    const series = { ...day, windows: [...day.windows, running], summary: { windows: 4, over_limit: 0, paused_min: 0 } };
    const page = await overview({ window: FORECAST, day: series }, { state });
    page.click(chart(page).querySelectorAll('.ui-seg-btn')[1]!);
    await until(() => chart(page).querySelectorAll('line.b5h-reset').length > 0, 3_000, 'day drawn');
    const host = chart(page);
    assert.equal(host.querySelectorAll('rect.b5h-pause').length, 1);
    assert.equal(text(host.querySelector('.b5h-text')!), '4 Fenster · 1× über Limit · 60 min pausiert');
  });

  it('a peak just above 100 % is labelled with one decimal, not "+0 %"', async () => {
    const series = windowSeries([win([...rising(90, 100), { at: t(FROM, 120), percent: 100.3 }])]);
    const host = chart(await overview({ window: series }, { report: budget(null, 100.3) }));
    assert.equal(text(host.querySelector('text.b5h-peak-lbl')!), '+0,3 %');
  });
});
