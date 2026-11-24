import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { renderPage, until } from './helpers.ts';
import { dashboardState } from './helpers/page-fixtures.ts';
import type { FakeElement } from './helpers/fake-dom.ts';

// #605 review round, independent panel tests: gate pause only on a running window, 24 h / 7 days text line with a drawn gate pause,
// peak label with one decimal below +1 %. Clock of renderPage: 2026-10-30T12:00:00Z.

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-10-30T12:00:00Z');
const RESET_MS = Date.parse('2026-10-30T13:31:00Z');
const START_MS = RESET_MS - 5 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const hm = (ms: number | string) => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const text = (n: { textContent: string }) => n.textContent.replace(/\s+/g, ' ').trim();

type Pt = { at: string; percent: number; rejected: boolean };
const pt = (ms: number, percent: number, rejected = false): Pt => ({ at: iso(ms), percent, rejected });

interface WinOpts { start: number; points: Array<[number, number] | [number, number, boolean]>; over?: number | null; pause?: [number, number] | null; current?: boolean; reset?: number }
function makeWindow(o: WinOpts) {
  const points = o.points.map((p) => pt(p[0], p[1], p[2] ?? false));
  const peak = points.reduce((a, b) => (b.percent > a.percent ? b : a));
  return {
    start: iso(o.start),
    resets_at: iso(o.reset ?? o.start + 5 * HOUR),
    points,
    peak,
    over_limit: o.over != null,
    over_limit_at: o.over != null ? iso(o.over) : null,
    pause: o.pause ? { from: iso(o.pause[0]), to: iso(o.pause[1]) } : null,
    current: o.current ?? false,
  };
}
function makeSeries(range: 'window' | 'day' | 'week', windows: Array<ReturnType<typeof makeWindow>>, forecast: unknown = null, summary?: { windows: number; over_limit: number; paused_min: number }) {
  const span = range === 'window' ? [RESET_MS - 5 * HOUR, RESET_MS] : range === 'day' ? [NOW - 24 * HOUR, NOW] : [NOW - 7 * 24 * HOUR, NOW];
  return {
    range,
    now: iso(NOW),
    from: iso(span[0]!),
    to: iso(span[1]!),
    percent_source: 'sdk' as const,
    windows,
    forecast,
    summary: summary ?? { windows: windows.length, over_limit: windows.filter((w) => w.over_limit).length, paused_min: 0 },
  };
}

function report() {
  const win = (name: string, reset: string) => ({
    window: name,
    used_tokens: 700_000,
    burn_rate_per_min: 1500,
    resets_at: reset,
    forecast: { limit_tokens: 1_000_000, limit_source: 'sdk', eta: null },
    alert: false,
    by_role: { developer: 300_000, reviewer: 100_000 },
  });
  return { five_hour: win('five_hour', iso(RESET_MS)), seven_day: win('seven_day', '2026-11-03T10:00:00.000Z'), generated_at: iso(NOW) };
}

interface Setup { series?: Partial<Record<'window' | 'day' | 'week', unknown>>; state?: unknown }
const FIVE = '/api/v1/budget/five-hour';
const rangeOf = (url: string) => new URL(url, 'http://x').searchParams.get('range');
const seriesFetches = (page: { fetches: Array<{ url: string }> }) => page.fetches.filter((f) => f.url.startsWith(FIVE));
const settle = () => new Promise((r) => setTimeout(r, 40));

async function open(s: Setup = {}) {
  const state = s.state ?? dashboardState();
  const page = renderPage(DASHBOARD_HTML, state, {
    fetch: (url) => {
      if (url === '/api/v1/budget') return report();
      if (url.startsWith(FIVE)) {
        const r = rangeOf(url) as 'window' | 'day' | 'week';
        const body = s.series?.[r];
        return body === undefined ? makeSeries(r, []) : body;
      }
      if (url === '/api/v1/state') return state;
      if (url === '/api/v1/history') return { recent: [] };
      return {};
    },
  });
  await until(() => seriesFetches(page).length > 0, 3_000, 'five-hour fetch');
  await settle();
  return page;
}
type Page = Awaited<ReturnType<typeof open>>;
const root = (p: Page) => p.$('budget').querySelector('.b5h')!;
const tx = (p: Page) => text(root(p).querySelector('.b5h-text')!);
const svg = (p: Page) => root(p).querySelector('svg')!;
const all = (p: Page, sel: string) => svg(p).querySelectorAll(sel);
async function switchTo(p: Page, label: string) {
  const b = root(p).querySelectorAll('.ui-seg-btn').find((x) => text(x).replace(/\s/g, '') === label.replace(/\s/g, ''));
  assert.ok(b, `segment button ${label}`);
  p.click(b);
  await settle();
}
const num = (el: FakeElement, k: string) => Number(el.getAttribute(k));
const numbers = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

/** x(t) of the plot, derived from the first and the last vertex of the (single) amber utilisation path for the points at t0 and t1. */
function xOf(p: Page, t0: number, t1: number): (t: number) => number {
  const d = all(p, 'path.b5h-line')[0]!.getAttribute('d')!;
  const n = numbers(d);
  assert.ok(n.length >= 4, `path ${d}`);
  const x0 = n[0]!;
  const x1 = n[n.length - 2]!;
  assert.ok(x1 > x0, 'path runs left to right');
  const perMs = (x1 - x0) / (t1 - t0);
  return (t: number) => x0 + (t - t0) * perMs;
}

const gateState = (until: string, window = 'five_hour') => {
  const s = dashboardState();
  (s.health as Record<string, unknown>).dispatch_gate = { reason: 'session_limit', window, until, issue_identifier: 'acme/app#1' };
  return s;
};

const TOL = 2.5; // px

// An old window: started 12 h ago, last point 8 h ago, reset 3 h ago. The gap up to now is empty.
const OLD_START = NOW - 12 * HOUR;
const OLD_LAST = NOW - 8 * HOUR;
const oldWindow = () => makeWindow({ start: OLD_START, reset: NOW - 3 * HOUR, current: false, points: [[OLD_START, 5], [NOW - 10 * HOUR, 30], [OLD_LAST, 45]] });
// A window running now: last point 1 h ago, reset in 2 h.
const RUN_START = NOW - 3 * HOUR;
const RUN_LAST = NOW - HOUR;
const runWindow = (extra: Partial<WinOpts> = {}) => makeWindow({ start: RUN_START, reset: NOW + 2 * HOUR, current: true, points: [[RUN_START, 5], [NOW - 2 * HOUR, 30], [RUN_LAST, 45]], ...extra });
const UNTIL = NOW + 2 * HOUR;

describe('#605 review A: gate pause only on a running window', () => {
  for (const [range, label] of [['day', '24 h'], ['week', '7 Tage']] as const) {
    it(`${range}: no running window (only an old one): the hatch starts at now, the gap stays empty`, async () => {
      const page = await open({ state: gateState(iso(UNTIL)), series: { [range]: makeSeries(range, [oldWindow()]) } });
      await switchTo(page, label);
      const x = xOf(page, OLD_START, OLD_LAST);
      const rects = all(page, 'rect.b5h-pause');
      assert.equal(rects.length, 1, 'the running gate is drawn');
      const left = num(rects[0]!, 'x');
      assert.ok(left >= x(NOW) - TOL, `hatch starts at ${left}, now is at ${x(NOW)}, last point at ${x(OLD_LAST)}`);
      assert.ok(left > x(OLD_LAST) + TOL, 'hatch does not begin at the old last point');
      assert.ok(left > x(NOW - 3 * HOUR) + TOL, 'hatch does not cover the gap after the old reset');
      // no more than "until" − now of width (clipping at the plot edge is allowed)
      assert.ok(num(rects[0]!, 'width') <= (UNTIL - NOW) * ((x(OLD_LAST) - x(OLD_START)) / (OLD_LAST - OLD_START)) + TOL, 'width limited to the time until the gate ends');
    });

    it(`${range}: running window (current): the hatch starts at its last point`, async () => {
      const page = await open({ state: gateState(iso(UNTIL)), series: { [range]: makeSeries(range, [oldWindow(), runWindow()]) } });
      await switchTo(page, label);
      const d = all(page, 'path.b5h-line').map((e) => numbers(e.getAttribute('d')!));
      assert.ok(d.length >= 2, 'one section per window');
      const run = d[d.length - 1]!;
      const x0 = run[0]!;
      const x1 = run[run.length - 2]!;
      const x = (t: number) => x0 + ((t - RUN_START) * (x1 - x0)) / (RUN_LAST - RUN_START);
      const rects = all(page, 'rect.b5h-pause');
      assert.equal(rects.length, 1);
      assert.ok(Math.abs(num(rects[0]!, 'x') - x(RUN_LAST)) <= TOL, `hatch at ${num(rects[0]!, 'x')}, last point at ${x(RUN_LAST)}`);
      assert.ok(num(rects[0]!, 'x') < x(NOW) - 0.5 * TOL, 'hatch begins before now, not at now');
    });
  }

  it('day: fallback "latest window with resets_at > now" counts as running without current flag', async () => {
    const w = makeWindow({ start: RUN_START, reset: NOW + 2 * HOUR, current: false, points: [[RUN_START, 5], [NOW - 2 * HOUR, 30], [RUN_LAST, 45]] });
    const page = await open({ state: gateState(iso(UNTIL)), series: { day: makeSeries('day', [oldWindow(), w]) } });
    await switchTo(page, '24 h');
    const d = numbers(all(page, 'path.b5h-line').at(-1)!.getAttribute('d')!);
    const x0 = d[0]!;
    const x1 = d[d.length - 2]!;
    const xRun = (t: number) => x0 + ((t - RUN_START) * (x1 - x0)) / (RUN_LAST - RUN_START);
    const rects = all(page, 'rect.b5h-pause');
    assert.equal(rects.length, 1);
    assert.ok(Math.abs(num(rects[0]!, 'x') - xRun(RUN_LAST)) <= TOL, 'begins at the last point of the window that is still open');
  });

  it('day: without gate no hatch for an old window (counter-check)', async () => {
    const page = await open({ series: { day: makeSeries('day', [oldWindow()]) } });
    await switchTo(page, '24 h');
    assert.ok(all(page, 'path.b5h-line').length >= 1, 'graph rendered');
    assert.equal(all(page, 'rect.b5h-pause').length, 0);
  });

  it('day: a gate that has ended draws no hatch next to an old window', async () => {
    const page = await open({ state: gateState(iso(NOW - HOUR)), series: { day: makeSeries('day', [oldWindow()]) } });
    await switchTo(page, '24 h');
    assert.ok(all(page, 'path.b5h-line').length >= 1, 'graph rendered');
    assert.equal(all(page, 'rect.b5h-pause').length, 0);
  });

  it('window range: gate on the running window is drawn and named in the text', async () => {
    const page = await open({ state: gateState(iso(RESET_MS)), series: { window: makeSeries('window', [makeWindow({ start: START_MS, current: true, points: [[START_MS, 0], [START_MS + 90 * MIN, 20], [NOW - 30 * MIN, 45]] })]) } });
    const x = xOf(page, START_MS, NOW - 30 * MIN);
    const rects = all(page, 'rect.b5h-pause');
    assert.equal(rects.length, 1);
    assert.ok(Math.abs(num(rects[0]!, 'x') - x(NOW - 30 * MIN)) <= TOL, `hatch at ${num(rects[0]!, 'x')}, last point at ${x(NOW - 30 * MIN)}`);
    assert.ok(tx(page).includes(`pausiert bis ${hm(RESET_MS)}`), tx(page));
  });
});

describe('#605 review B: text line 24 h / 7 days counts a drawn gate pause', () => {
  const day = (runW: ReturnType<typeof makeWindow>, summary: { windows: number; over_limit: number; paused_min: number }) =>
    makeSeries('day', [oldWindow(), runW], null, summary);
  const base = { windows: 2, over_limit: 0, paused_min: 0 };
  const overAt = NOW - HOUR;

  it('no gate: line exactly from the summary ("nie über Limit" at 0)', async () => {
    const page = await open({ series: { day: day(runWindow(), base) } });
    await switchTo(page, '24 h');
    assert.equal(tx(page), '2 Fenster · nie über Limit');
  });

  it('five_hour gate on the running window without own pause: +1 over limit, minutes from pause start to now added', async () => {
    const page = await open({ state: gateState(iso(UNTIL)), series: { day: day(runWindow(), { windows: 2, over_limit: 1, paused_min: 60 }) } });
    await switchTo(page, '24 h');
    assert.equal(all(page, 'rect.b5h-pause').length, 1, 'the pause is drawn');
    assert.equal(tx(page), '2 Fenster · 2× über Limit · 120 min pausiert');
  });

  it('five_hour gate with summary at zero: "nie über Limit" turns into "1× über Limit" and the pause minutes (1 h since the last point)', async () => {
    const page = await open({ state: gateState(iso(UNTIL)), series: { day: day(runWindow(), base) } });
    await switchTo(page, '24 h');
    assert.equal(tx(page), '2 Fenster · 1× über Limit · 60 min pausiert');
    assert.ok(!tx(page).includes('nie über Limit'));
  });

  it('7 days: same addition', async () => {
    const page = await open({ state: gateState(iso(UNTIL)), series: { week: makeSeries('week', [oldWindow(), runWindow()], null, { windows: 2, over_limit: 1, paused_min: 60 }) } });
    await switchTo(page, '7 Tage');
    assert.equal(tx(page), '2 Fenster · 2× über Limit · 120 min pausiert');
  });

  it('running window already over the limit (no own pause): over-limit count is not counted twice, minutes from the overshoot', async () => {
    const w = runWindow({ over: overAt, points: [[RUN_START, 5], [NOW - 2 * HOUR, 30], [overAt, 104]] });
    const page = await open({ state: gateState(iso(UNTIL)), series: { day: day(w, { windows: 2, over_limit: 1, paused_min: 0 }) } });
    await switchTo(page, '24 h');
    assert.equal(all(page, 'rect.b5h-pause').length, 1);
    assert.equal(tx(page), '2 Fenster · 1× über Limit · 60 min pausiert');
  });

  it('running window with its own pause: the gate is not added a second time', async () => {
    const w = runWindow({ over: overAt, pause: [overAt, UNTIL], points: [[RUN_START, 5], [NOW - 2 * HOUR, 30], [overAt, 104, true]] });
    const page = await open({ state: gateState(iso(UNTIL)), series: { day: day(w, { windows: 2, over_limit: 1, paused_min: 60 }) } });
    await switchTo(page, '24 h');
    assert.equal(tx(page), '2 Fenster · 1× über Limit · 60 min pausiert');
  });

  it('seven_day gate does not change the line', async () => {
    const page = await open({ state: gateState(iso(UNTIL), 'seven_day'), series: { day: day(runWindow(), base) } });
    await switchTo(page, '24 h');
    assert.equal(tx(page), '2 Fenster · nie über Limit');
    assert.equal(all(page, 'rect.b5h-pause').length, 0);
  });

  it('gate with until in the past does not change the line', async () => {
    const page = await open({ state: gateState(iso(NOW - 10 * MIN)), series: { day: day(runWindow(), { windows: 2, over_limit: 1, paused_min: 60 }) } });
    await switchTo(page, '24 h');
    assert.equal(tx(page), '2 Fenster · 1× über Limit · 60 min pausiert');
  });
});

describe('#605 review C: peak label', () => {
  const peakWin = (peak: number) => makeWindow({ start: START_MS, current: true, over: NOW - 30 * MIN, points: [[START_MS, 0], [START_MS + 70 * MIN, 55], [NOW - 30 * MIN, peak]] });
  const labelFor = async (peak: number, range: 'window' | 'day' = 'window') => {
    const w = peakWin(peak);
    const page = await open({ series: { [range]: makeSeries(range, [w]) } });
    if (range === 'day') await switchTo(page, '24 h');
    return all(page, 'text.b5h-peak-lbl').map(text);
  };

  it('112 % is labelled "+12 %"', async () => {
    assert.deepEqual(await labelFor(112), ['+12 %']);
  });
  it('exactly 1 percentage point over (101 %) is labelled "+1 %"', async () => {
    assert.deepEqual(await labelFor(101), ['+1 %']);
  });
  it('100.3 % is labelled with one decimal, German format "+0,3 %", not "+0 %"', async () => {
    const l = await labelFor(100.3);
    assert.deepEqual(l, ['+0,3 %']);
  });
  it('100.5 % is labelled "+0,5 %"', async () => {
    assert.deepEqual(await labelFor(100.5), ['+0,5 %']);
  });
  it('24 h: 100.3 % is labelled "+0,3 %" as well, 118 % "+18 %"', async () => {
    assert.deepEqual(await labelFor(100.3, 'day'), ['+0,3 %']);
    assert.deepEqual(await labelFor(118, 'day'), ['+18 %']);
  });
  it('7 days: peak dot but no label, also for 100.3 %', async () => {
    const week = makeSeries('week', [makeWindow({ start: NOW - 30 * HOUR, current: false, over: NOW - 26 * HOUR, points: [[NOW - 30 * HOUR, 10], [NOW - 28 * HOUR, 60], [NOW - 26 * HOUR, 100.3]] })]);
    const page = await open({ series: { week } });
    await switchTo(page, '7 Tage');
    assert.equal(all(page, 'circle.b5h-peak').length, 1);
    assert.equal(all(page, 'text.b5h-peak-lbl').length, 0);
  });
  it('below the limit: neither dot nor label', async () => {
    const page = await open({ series: { window: makeSeries('window', [peakWin(99.8)].map((w) => ({ ...w, over_limit: false, over_limit_at: null }))) } });
    assert.ok(all(page, 'path.b5h-line').length >= 1, 'graph rendered');
    assert.equal(all(page, 'text.b5h-peak-lbl').length, 0);
    assert.equal(all(page, 'circle.b5h-peak').length, 0);
  });
});
