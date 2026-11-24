import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { renderPage, until } from './helpers.ts';
import { dashboardState } from './helpers/page-fixtures.ts';
import type { FakeElement } from './helpers/fake-dom.ts';

// #605 independent panel tests: 5-h utilisation graph in the Context-Budget panel. Clock of renderPage: 2026-10-30T12:00:00Z.

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-10-30T12:00:00Z');
const RESET_MS = Date.parse('2026-10-30T13:31:00Z');
const START_MS = RESET_MS - 5 * HOUR;
const ETA_MS = Date.parse('2026-10-30T13:10:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const hm = (ms: number | string) => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const wd = (ms: number) => `${new Date(ms).toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '')} ${hm(ms)}`;
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

// --- window fixtures
const underWindow = () => makeWindow({ start: START_MS, current: true, points: [[START_MS, 0], [START_MS + 90 * MIN, 20], [START_MS + 180 * MIN, 45], [NOW, 70]] });
const forecastWithEta = { from: { at: iso(NOW), percent: 70 }, to: { at: iso(RESET_MS), percent: 109 }, eta: iso(ETA_MS), rate_pct_per_min: 30 / 70 };
const forecastNoEta = { from: { at: iso(NOW), percent: 70 }, to: { at: iso(RESET_MS), percent: 90 }, eta: null, rate_pct_per_min: 0.2 };
const OVER_AT = Date.parse('2026-10-30T10:49:00Z');
const overWindow = () => makeWindow({ start: START_MS, current: true, over: OVER_AT, pause: [OVER_AT, RESET_MS], points: [[START_MS, 0], [START_MS + 70 * MIN, 55], [OVER_AT, 112.4, true]] });

function weekWindows() {
  const from = NOW - 7 * 24 * HOUR;
  return Array.from({ length: 21 }, (_v, i) => {
    const start = from + i * 8 * HOUR;
    const over = i % 3 === 0;
    return makeWindow({
      start,
      current: false,
      over: over ? start + 4 * HOUR : null,
      pause: over ? [start + 4 * HOUR, start + 5 * HOUR] : null,
      points: [[start, 10], [start + 2 * HOUR, 60], [start + 4 * HOUR, over ? 105 : 80]],
    });
  });
}
function dayWindows() {
  const a = NOW - 20 * HOUR;
  const b = NOW - 12 * HOUR;
  const c = NOW - 5 * HOUR;
  return [
    makeWindow({ start: a, points: [[a, 5], [a + 2 * HOUR, 50], [a + 4 * HOUR, 80]] }),
    makeWindow({ start: b, over: b + 4 * HOUR, pause: [b + 4 * HOUR, b + 5 * HOUR], points: [[b, 10], [b + 2 * HOUR, 60], [b + 4 * HOUR, 118, true]] }),
    makeWindow({ start: c, current: false, points: [[c, 0], [c + 2 * HOUR, 30], [c + 4 * HOUR, 40]] }),
  ];
}

// --- budget report (format of test/budget-panel-acceptance.test.ts)
function report(eta: string | null = iso(ETA_MS)) {
  const win = (name: string, reset: string, e: string | null) => ({
    window: name,
    used_tokens: 700_000,
    burn_rate_per_min: 1500,
    resets_at: reset,
    forecast: { limit_tokens: 1_000_000, limit_source: 'sdk', eta: e },
    alert: false,
    by_role: { developer: 300_000, reviewer: 100_000 },
  });
  return { five_hour: win('five_hour', iso(RESET_MS), eta), seven_day: win('seven_day', '2026-11-03T10:00:00.000Z', null), generated_at: iso(NOW) };
}

interface Setup { series?: Partial<Record<'window' | 'day' | 'week', unknown>>; eta?: string | null; state?: unknown }
const FIVE = '/api/v1/budget/five-hour';
const rangeOf = (url: string) => new URL(url, 'http://x').searchParams.get('range');
const seriesFetches = (page: { fetches: Array<{ url: string }> }) => page.fetches.filter((f) => f.url.startsWith(FIVE));

async function open(s: Setup = {}) {
  const state = s.state ?? dashboardState();
  const page = renderPage(DASHBOARD_HTML, state, {
    fetch: (url) => {
      if (url === '/api/v1/budget') return report(s.eta === undefined ? iso(ETA_MS) : s.eta);
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
const settle = () => new Promise((r) => setTimeout(r, 40));
type Page = Awaited<ReturnType<typeof open>>;
const root = (p: Page) => p.$('budget').querySelector('.b5h')!;
const tx = (p: Page) => text(root(p).querySelector('.b5h-text')!);
const svg = (p: Page) => root(p).querySelector('svg')!;
const all = (p: Page, sel: string) => svg(p).querySelectorAll(sel);
const segBtn = (p: Page, label: string) => {
  const b = root(p).querySelectorAll('.ui-seg-btn').find((x) => text(x).replace(/\s/g, '') === label.replace(/\s/g, ''));
  assert.ok(b, `segment button ${label}`);
  return b;
};
async function switchTo(p: Page, label: string) {
  p.click(segBtn(p, label));
  await settle();
}
const legend = (p: Page) => text(root(p).querySelector('.b5h-legend')!);

/** Value of a paint property: attribute, inline style or the CSS rule of the class in the page. */
function paint(el: FakeElement, prop: string): string {
  const camel = prop.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
  const direct = el.getAttribute(prop) ?? (typeof el.style[camel] === 'string' ? (el.style[camel] as string) : '') ?? '';
  if (direct) return direct.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  const styleAttr = el.getAttribute('style') ?? '';
  const inline = new RegExp(`${prop}\\s*:\\s*([^;]+)`).exec(styleAttr);
  if (inline) return inline[1]!.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  for (const cls of el.className.split(/\s+/).filter(Boolean)) {
    const rule = new RegExp(`\\.${cls}(?![\\w-])[^{}]*\\{([^}]*)\\}`, 'g');
    for (const m of DASHBOARD_HTML.matchAll(rule)) {
      const decl = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;}]+)`).exec(m[1]!);
      if (decl) return decl[1]!.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}
const num = (el: FakeElement, k: string) => Number(el.getAttribute(k));
const firstPoint = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).slice(0, 2).map(Number) as [number, number];

function hover(p: Page, x: number) {
  const hit = all(p, 'rect.b5h-hit')[0];
  assert.ok(hit, 'rect.b5h-hit');
  for (const type of ['pointermove', 'mousemove']) hit.dispatch(type, { offsetX: x, clientX: x, offsetY: 10, clientY: 10, bubbles: true });
}
const tipText = (p: Page) => text(root(p).querySelector('.b5h-tip')!);

describe('#605 panel frame', () => {
  it('sits directly below the 5-h bar, before the week bar, with head, plot, legend, text', async () => {
    const page = await open({ series: { window: makeSeries('window', [underWindow()], forecastWithEta) } });
    const b5h = root(page);
    assert.ok(b5h, 'div.b5h in the panel');
    assert.ok(b5h.classList.contains('b5h'));
    const order = page.$('budget').descendants();
    const bars = order.filter((e) => e.classList.contains('ui-bar'));
    const at = order.indexOf(b5h);
    assert.ok(order.indexOf(bars[0]!) < at, 'after the 5-h bar');
    assert.ok(at < order.indexOf(bars[1]!), 'before the week bar');
    assert.deepEqual(b5h.children.map((c) => c.classList[Symbol.iterator]().next().value), ['b5h-head', 'b5h-plot', 'b5h-legend', 'b5h-text']);
    assert.equal(text(b5h.querySelector('.b5h-head .lbl')!), 'Auslastung 5-h-Fenster');
    const plot = b5h.querySelector('.b5h-plot')!;
    const s = plot.querySelector('svg')!;
    assert.equal(s.getAttribute('role'), 'img');
    assert.equal(s.getAttribute('aria-label'), 'Verlauf der 5-h-Auslastung');
    assert.ok(plot.querySelector('.b5h-tip'));
  });

  it('keeps bars, week, tokens per role of the panel', async () => {
    const page = await open({ series: { window: makeSeries('window', [underWindow()]) } });
    assert.equal(page.query('.budget-win').length, 2);
    assert.ok(text(page.$('budget')).includes('Tokens je Rolle'));
    assert.ok(text(page.$('budget')).includes('70 %'));
  });

  it('segmented control: aria-label Zeitraum, Fenster / 24 h / 7 Tage, Fenster pressed by default', async () => {
    const page = await open({ series: { window: makeSeries('window', [underWindow()]) } });
    const seg = root(page).querySelector('.b5h-head .ui-seg')!;
    assert.ok(seg, 'segmented');
    assert.equal(seg.getAttribute('aria-label'), 'Zeitraum');
    const btns = seg.querySelectorAll('.ui-seg-btn');
    assert.deepEqual(btns.map((b) => text(b).replace(/\s+/g, ' ')), ['Fenster', '24 h', '7 Tage']);
    assert.deepEqual(btns.map((b) => b.getAttribute('aria-pressed')), ['true', 'false', 'false']);
  });
});

describe('#605 loading and switching', () => {
  const full = () => ({
    window: makeSeries('window', [underWindow()], forecastWithEta),
    day: makeSeries('day', dayWindows(), null, { windows: 3, over_limit: 1, paused_min: 60 }),
    week: makeSeries('week', weekWindows(), null, { windows: 21, over_limit: 7, paused_min: 516 }),
  });

  it('initial load fetches range=window once', async () => {
    const page = await open({ series: full() });
    assert.deepEqual(seriesFetches(page).map((f) => rangeOf(f.url)), ['window']);
  });

  it('switching loads the range exactly once; clicking the active range does not load', async () => {
    const page = await open({ series: full() });
    await switchTo(page, '24 h');
    assert.deepEqual(seriesFetches(page).map((f) => rangeOf(f.url)), ['window', 'day']);
    assert.deepEqual(root(page).querySelectorAll('.ui-seg-btn').map((b) => b.getAttribute('aria-pressed')), ['false', 'true', 'false']);
    await switchTo(page, '24 h');
    assert.equal(seriesFetches(page).length, 2, 'active range click: no fetch');
    await switchTo(page, '7 Tage');
    assert.deepEqual(seriesFetches(page).map((f) => rangeOf(f.url)), ['window', 'day', 'week']);
    await switchTo(page, '7 Tage');
    assert.equal(seriesFetches(page).length, 3);
    await switchTo(page, 'Fenster');
    assert.deepEqual(seriesFetches(page).map((f) => rangeOf(f.url)), ['window', 'day', 'week', 'window']);
    assert.deepEqual(root(page).querySelectorAll('.ui-seg-btn').map((b) => b.getAttribute('aria-pressed')), ['true', 'false', 'false']);
  });

  it('the graph reloads together with every budget poll, not more often', async () => {
    const page = await open({ series: full() });
    const budgetCount = () => page.fetches.filter((f) => f.url === '/api/v1/budget').length;
    const b0 = budgetCount();
    const s0 = seriesFetches(page).length;
    for (const i of page.intervals) await i.fn();
    page.render(dashboardState());
    await settle();
    const dBudget = budgetCount() - b0;
    assert.ok(dBudget >= 1, 'a budget poll happens');
    assert.equal(seriesFetches(page).length - s0, dBudget, 'one graph load per budget load');
    assert.ok(seriesFetches(page).slice(s0).every((f) => rangeOf(f.url) === 'window'), 'active range reloaded');
  });

  it('the switched range is kept for the next poll', async () => {
    const page = await open({ series: full() });
    await switchTo(page, '24 h');
    const s0 = seriesFetches(page).length;
    for (const i of page.intervals) await i.fn();
    page.render(dashboardState());
    await settle();
    const polled = seriesFetches(page).slice(s0);
    if (polled.length) assert.ok(polled.every((f) => rangeOf(f.url) === 'day'));
    assert.ok(text(root(page).querySelector('.b5h-text')!).startsWith('3 Fenster'));
  });
});

describe('#605 100-% limit line and colours', () => {
  for (const range of ['window', 'day', 'week'] as const) {
    it(`${range}: dashed red limit line with label is visible while all data stays below 100 %`, async () => {
      const w = range === 'window' ? [underWindow()] : range === 'day' ? [dayWindows()[0]!, dayWindows()[2]!] : weekWindows().filter((x) => !x.over_limit);
      const page = await open({ series: { [range]: makeSeries(range, w) } });
      if (range !== 'window') await switchTo(page, range === 'day' ? '24 h' : '7 Tage');
      const line = all(page, 'line.b5h-limit');
      assert.equal(line.length, 1);
      assert.equal(paint(line[0]!, 'stroke'), 'var(--red)');
      assert.equal(paint(line[0]!, 'stroke-dasharray'), '6 4');
      assert.equal(line[0]!.getAttribute('y1'), line[0]!.getAttribute('y2'), 'horizontal');
      const lbl = all(page, 'text.b5h-limit-lbl');
      assert.equal(lbl.length, 1);
      assert.equal(text(lbl[0]!), '5-h-Limit');
    });
  }

  it('below 100 %: amber line and area, no red section, no overshoot label', async () => {
    const page = await open({ series: { window: makeSeries('window', [underWindow()], forecastNoEta) } });
    assert.ok(all(page, 'path.b5h-line').length >= 1, 'utilisation line drawn');
    assert.ok(all(page, 'path.b5h-area').length >= 1, 'area drawn');
    assert.equal(paint(all(page, 'path.b5h-line')[0]!, 'stroke'), 'var(--amber)');
    assert.equal(all(page, 'path.b5h-line-over').length, 0);
    assert.equal(all(page, 'path.b5h-area-over').length, 0);
    assert.equal(all(page, 'text.b5h-peak-lbl').length, 0);
    assert.equal(all(page, 'rect.b5h-pause').length, 0);
  });

  it('the 112 % peak lies above the 100 % line, inside the drawing area (y grows downwards)', async () => {
    const page = await open({ series: { window: makeSeries('window', [overWindow()]) } });
    const limitY = num(all(page, 'line.b5h-limit')[0]!, 'y1');
    const peak = all(page, 'circle.b5h-peak')[0]!;
    assert.ok(num(peak, 'cy') < limitY, 'peak above the 100 % line');
    assert.ok(num(peak, 'cy') >= 0, 'peak inside the drawing area (axis reaches beyond 112 %)');
  });

  it('above 100 %: red line and area, amber part stays, peak dot with "+12 %"', async () => {
    const page = await open({ series: { window: makeSeries('window', [overWindow()]) } });
    assert.ok(all(page, 'path.b5h-line').length >= 1, 'amber part below the limit');
    assert.ok(all(page, 'path.b5h-line-over').length >= 1);
    assert.ok(all(page, 'path.b5h-area-over').length >= 1);
    assert.equal(paint(all(page, 'path.b5h-line-over')[0]!, 'stroke'), 'var(--red)');
    assert.equal(all(page, 'circle.b5h-peak').length, 1);
    assert.deepEqual(all(page, 'text.b5h-peak-lbl').map(text), ['+12 %']);
  });

  it('24 h: red section and "+18 %" label only for the exceeding window', async () => {
    const page = await open({ series: { window: makeSeries('window', []), day: makeSeries('day', dayWindows(), null, { windows: 3, over_limit: 1, paused_min: 60 }) } });
    await switchTo(page, '24 h');
    assert.ok(all(page, 'path.b5h-line-over').length >= 1);
    assert.deepEqual(all(page, 'text.b5h-peak-lbl').map(text), ['+18 %']);
  });

  it('7 days: peak dots for the exceeding windows, but no "+n %" label', async () => {
    const page = await open({ series: { week: makeSeries('week', weekWindows(), null, { windows: 21, over_limit: 7, paused_min: 516 }) } });
    await switchTo(page, '7 Tage');
    assert.ok(all(page, 'path.b5h-line-over').length >= 1);
    assert.ok(all(page, 'circle.b5h-peak').length >= 7);
    assert.equal(all(page, 'text.b5h-peak-lbl').length, 0);
  });

  it('no hard-coded hex colours in the graph, colours come from shell tokens', async () => {
    const page = await open({ series: { window: makeSeries('window', [overWindow()], forecastWithEta) } });
    const html = svg(page).outerHTML.replace(/url\(#[\w-]+\)/g, '');
    assert.ok(all(page, 'path.b5h-line-over').length >= 1, 'graph rendered');
    assert.doesNotMatch(html, /#[0-9a-fA-F]{3,8}(?![\w-])/);
    assert.ok(html.includes('var(--red)') || paint(all(page, 'line.b5h-limit')[0]!, 'stroke') === 'var(--red)');
    assert.equal(paint(all(page, 'path.b5h-line')[0]!, 'stroke'), 'var(--amber)');
    assert.doesNotMatch(root(page).querySelector('.b5h-legend')!.outerHTML, /#[0-9a-fA-F]{3,8}(?![\w-])/);
  });
});

describe('#605 pauses', () => {
  it('a pause is drawn as hatched rect (fill url(#b5h-hatch)) with the pattern defined', async () => {
    const page = await open({ series: { window: makeSeries('window', [overWindow()]) } });
    const rects = all(page, 'rect.b5h-pause');
    assert.equal(rects.length, 1);
    assert.match(paint(rects[0]!, 'fill'), /url\(#b5h-hatch\)/);
    assert.ok(svg(page).querySelector('#b5h-hatch'), 'pattern #b5h-hatch');
    assert.ok(num(rects[0]!, 'width') > 0);
  });

  it('week: one pause rect per paused window', async () => {
    const page = await open({ series: { week: makeSeries('week', weekWindows(), null, { windows: 21, over_limit: 7, paused_min: 516 }) } });
    await switchTo(page, '7 Tage');
    assert.equal(all(page, 'rect.b5h-pause').length, 7);
  });

  const gateState = (until: string, window = 'five_hour') => {
    const s = dashboardState();
    (s.health as Record<string, unknown>).dispatch_gate = { reason: 'session_limit', window, until, issue_identifier: 'acme/app#1' };
    return s;
  };
  const noPauseOver = () => makeWindow({ start: START_MS, current: true, over: OVER_AT, points: [[START_MS, 0], [OVER_AT, 112.4, true]] });

  it('running five_hour gate pause on a window without pause: hatch drawn and named in the text', async () => {
    const page = await open({ state: gateState(iso(RESET_MS)), series: { window: makeSeries('window', [noPauseOver()]) } });
    assert.equal(all(page, 'rect.b5h-pause').length, 1);
    assert.ok(tx(page).includes(`pausiert bis ${hm(RESET_MS)}`), tx(page));
  });

  it('gate pause also for a window without exceeding (pause from the last point)', async () => {
    const until = Date.parse('2026-10-30T13:20:00Z');
    const page = await open({ state: gateState(iso(until)), series: { window: makeSeries('window', [underWindow()]) } });
    assert.equal(all(page, 'rect.b5h-pause').length, 1);
    assert.ok(tx(page).includes(`pausiert bis ${hm(until)}`), tx(page));
  });

  it('a seven_day gate does not draw a five-hour pause', async () => {
    const page = await open({ state: gateState(iso(RESET_MS), 'seven_day'), series: { window: makeSeries('window', [underWindow()]) } });
    assert.ok(all(page, 'path.b5h-line').length >= 1, 'graph rendered');
    assert.equal(all(page, 'rect.b5h-pause').length, 0);
    assert.ok(!tx(page).includes('pausiert'));
  });

  it('a finished gate (until in the past) draws nothing', async () => {
    const page = await open({ state: gateState(iso(NOW - HOUR)), series: { window: makeSeries('window', [underWindow()]) } });
    assert.ok(all(page, 'path.b5h-line').length >= 1, 'graph rendered');
    assert.equal(all(page, 'rect.b5h-pause').length, 0);
  });
});

describe('#605 window range: now, forecast, eta marker', () => {
  it('now line with label "jetzt", dashed forecast, eta marker with the eta of /api/v1/budget', async () => {
    const page = await open({ series: { window: makeSeries('window', [underWindow()], forecastWithEta) } });
    assert.equal(all(page, 'line.b5h-now').length, 1);
    assert.deepEqual(all(page, 'text.b5h-now-lbl').map(text), ['jetzt']);
    const fc = all(page, 'path.b5h-forecast');
    assert.ok(fc.length >= 1);
    assert.ok(paint(fc[0]!, 'stroke-dasharray') !== '' && paint(fc[0]!, 'stroke-dasharray') !== 'none', 'forecast is dashed');
    assert.equal(all(page, 'circle.b5h-eta').length, 1);
    assert.deepEqual(all(page, 'text.b5h-eta-lbl').map(text), [`Limit ca. ${hm(ETA_MS)}`]);
    assert.ok(text(page.$('budget')).includes(`Limit ca. ${hm(ETA_MS)}`), 'bar text carries the same time');
    assert.equal(all(page, 'line.b5h-reset').length, 0);
  });

  it('forecast without eta: forecast line but no eta marker', async () => {
    const page = await open({ eta: null, series: { window: makeSeries('window', [underWindow()], forecastNoEta) } });
    assert.ok(all(page, 'path.b5h-forecast').length >= 1);
    assert.equal(all(page, 'circle.b5h-eta').length, 0);
    assert.equal(all(page, 'text.b5h-eta-lbl').length, 0);
  });

  it('no forecast: neither forecast line nor eta marker', async () => {
    const page = await open({ eta: null, series: { window: makeSeries('window', [underWindow()], null) } });
    assert.ok(all(page, 'path.b5h-line').length >= 1);
    assert.equal(all(page, 'path.b5h-forecast').length, 0);
    assert.equal(all(page, 'circle.b5h-eta').length, 0);
  });
});

describe('#605 24 h / 7 days: sections and reset lines', () => {
  it('24 h: every window its own line section, dotted reset lines, no now line', async () => {
    const page = await open({ series: { day: makeSeries('day', dayWindows(), null, { windows: 3, over_limit: 1, paused_min: 60 }) } });
    await switchTo(page, '24 h');
    const resets = all(page, 'line.b5h-reset');
    assert.ok(resets.length >= 2 && resets.length <= 3, `reset lines: ${resets.length}`);
    assert.ok(paint(resets[0]!, 'stroke-dasharray') !== '' && paint(resets[0]!, 'stroke-dasharray') !== 'none', 'dotted');
    assert.equal(all(page, 'line.b5h-now').length, 0);
    assert.equal(all(page, 'path.b5h-forecast').length, 0);
    assert.equal(all(page, 'circle.b5h-eta').length, 0);
    assert.ok(all(page, 'path.b5h-line').length >= 2, 'separate sections for the windows below the limit');
  });

  it('7 days: reset lines for 21 windows', async () => {
    const page = await open({ series: { week: makeSeries('week', weekWindows(), null, { windows: 21, over_limit: 7, paused_min: 516 }) } });
    await switchTo(page, '7 Tage');
    const n = all(page, 'line.b5h-reset').length;
    assert.ok(n >= 20 && n <= 21, `reset lines: ${n}`);
    assert.equal(all(page, 'line.b5h-now').length, 0);
  });
});

describe('#605 legend', () => {
  const entries = (p: Page) => root(p).querySelectorAll('.b5h-legend .b5h-sw');
  it('window with forecast: Auslastung, Prognose, 5-h-Limit (100 %), über Limit, pausiert, no Reset', async () => {
    const page = await open({ series: { window: makeSeries('window', [underWindow()], forecastWithEta) } });
    const t = legend(page);
    for (const l of ['Auslastung', 'Prognose', '5-h-Limit (100 %)', 'über Limit', 'pausiert']) assert.ok(t.includes(l), `${l} in ${t}`);
    assert.ok(!t.includes('Reset'));
    assert.ok(entries(page).some((e) => e.classList.contains('line')));
    assert.ok(entries(page).some((e) => e.classList.contains('dash') && e.classList.contains('red')));
    assert.ok(entries(page).some((e) => e.classList.contains('dash') && !e.classList.contains('red')), 'forecast swatch');
    assert.ok(entries(page).some((e) => e.classList.contains('box') && e.classList.contains('red')));
    assert.ok(entries(page).some((e) => e.classList.contains('hatch')));
    assert.ok(!entries(page).some((e) => e.classList.contains('dot')));
  });
  it('window without forecast: no Prognose entry', async () => {
    const page = await open({ eta: null, series: { window: makeSeries('window', [underWindow()], null) } });
    assert.ok(legend(page).includes('Auslastung'));
    assert.ok(!legend(page).includes('Prognose'));
  });
  for (const [range, label] of [['day', '24 h'], ['week', '7 Tage']] as const) {
    it(`${range}: Reset entry, no Prognose entry`, async () => {
      const page = await open({ series: { [range]: makeSeries(range, range === 'day' ? dayWindows() : weekWindows()) } });
      await switchTo(page, label);
      const t = legend(page);
      for (const l of ['Auslastung', '5-h-Limit (100 %)', 'über Limit', 'pausiert', 'Reset']) assert.ok(t.includes(l), `${l} in ${t}`);
      assert.ok(!t.includes('Prognose'));
      assert.ok(entries(page).some((e) => e.classList.contains('dot')));
    });
  }
});

describe('#605 text line', () => {
  it('forecast with eta: limit time and minutes before reset', async () => {
    const page = await open({ series: { window: makeSeries('window', [underWindow()], forecastWithEta) } });
    assert.equal(tx(page), `Fenster ${hm(START_MS)}–${hm(RESET_MS)} · bei aktuellem Tempo Limit ca. ${hm(ETA_MS)}, 21 min vor dem Reset`);
  });

  it('exceeded window: limit time, peak and pause until, red span', async () => {
    const page = await open({ series: { window: makeSeries('window', [overWindow()]) } });
    assert.equal(tx(page), `Fenster ${hm(START_MS)}–${hm(RESET_MS)} · Limit überschritten um ${hm(OVER_AT)} (Spitze 112 %) · pausiert bis ${hm(RESET_MS)}`);
    const red = root(page).querySelector('.b5h-text .b5h-red')!;
    assert.ok(red, 'span.b5h-red');
    assert.match(text(red), /^Limit überschritten um/);
    assert.ok(text(red).includes('(Spitze 112 %)'));
    assert.ok(!text(red).includes('pausiert'));
  });

  it('forecast without eta: reicht bis zum Reset', async () => {
    const page = await open({ eta: null, series: { window: makeSeries('window', [underWindow()], forecastNoEta) } });
    assert.equal(tx(page), `Fenster ${hm(START_MS)}–${hm(RESET_MS)} · reicht bei aktuellem Tempo bis zum Reset`);
  });

  it('no forecast: Reset time', async () => {
    const page = await open({ eta: null, series: { window: makeSeries('window', [underWindow()], null) } });
    assert.equal(tx(page), `Fenster ${hm(START_MS)}–${hm(RESET_MS)} · Reset ${hm(RESET_MS)}`);
  });

  it('7 days: "21 Fenster · 7× über Limit · 516 min pausiert" with red span for the count', async () => {
    const page = await open({ series: { week: makeSeries('week', weekWindows(), null, { windows: 21, over_limit: 7, paused_min: 516 }) } });
    await switchTo(page, '7 Tage');
    assert.equal(tx(page), '21 Fenster · 7× über Limit · 516 min pausiert');
    const red = root(page).querySelector('.b5h-text .b5h-red')!;
    assert.ok(red, 'span.b5h-red');
    assert.ok(text(red).includes('7×'));
  });

  it('24 h: counts come from the summary', async () => {
    const page = await open({ series: { day: makeSeries('day', dayWindows(), null, { windows: 3, over_limit: 1, paused_min: 60 }) } });
    await switchTo(page, '24 h');
    assert.equal(tx(page), '3 Fenster · 1× über Limit · 60 min pausiert');
  });

  it('never over the limit: "n Fenster · nie über Limit", without red span', async () => {
    const ws = [dayWindows()[0]!, dayWindows()[2]!];
    const page = await open({ series: { day: makeSeries('day', ws, null, { windows: 2, over_limit: 0, paused_min: 0 }) } });
    await switchTo(page, '24 h');
    assert.equal(tx(page), '2 Fenster · nie über Limit');
    assert.equal(root(page).querySelectorAll('.b5h-text .b5h-red').length, 0);
  });
});

describe('#605 tooltip', () => {
  it('over 100 %: time, percent and "(über Limit)" at the peak', async () => {
    const page = await open({ series: { window: makeSeries('window', [overWindow()]) } });
    const cx = num(all(page, 'circle.b5h-peak')[0]!, 'cx');
    hover(page, cx);
    assert.equal(tipText(page), `${hm(OVER_AT)} · 112 % (über Limit)`);
  });

  it('below 100 %: time and percent without suffix at the first point', async () => {
    const page = await open({ series: { window: makeSeries('window', [underWindow()]) } });
    const first = firstPoint(all(page, 'path.b5h-line')[0]!.getAttribute('d')!);
    hover(page, first[0]);
    assert.equal(tipText(page), `${hm(START_MS)} · 0 %`);
  });

  it('7 days: weekday before the time', async () => {
    const page = await open({ series: { week: makeSeries('week', weekWindows(), null, { windows: 21, over_limit: 7, paused_min: 516 }) } });
    await switchTo(page, '7 Tage');
    const peak = all(page, 'circle.b5h-peak')[0]!;
    const w0 = weekWindows()[0]!;
    hover(page, num(peak, 'cx'));
    assert.equal(tipText(page).replace('.', ''), `${wd(Date.parse(w0.peak.at))} · 105 % (über Limit)`.replace('.', ''));
  });

  it('far from every point: no tooltip text', async () => {
    const page = await open({ series: { window: makeSeries('window', [underWindow()]) } });
    hover(page, -1000);
    const tip = root(page).querySelector('.b5h-tip')!;
    assert.ok(text(tip) === '' || tip.hidden || String(tip.style.display) === 'none', `tip: ${text(tip)}`);
  });
});

describe('#605 empty state and malformed answers', () => {
  const emptyOk = (p: Page) => {
    assert.equal(root(p).querySelectorAll('p.b5h-empty').length, 1);
    assert.equal(text(root(p).querySelector('p.b5h-empty')!), 'Noch keine Auslastung im Zeitraum');
    assert.equal(root(p).querySelectorAll('.b5h-text').length, 0, 'no text line');
    assert.equal(root(p).querySelectorAll('rect.b5h-hit').length, 0, 'no plot');
    assert.equal(root(p).querySelectorAll('.ui-seg-btn').length, 3, 'switch stays');
    assert.ok(legend(p).includes('5-h-Limit'), 'legend stays');
  };
  it('no windows: empty text replaces plot and text line', async () => {
    const page = await open({ series: { window: makeSeries('window', []) } });
    emptyOk(page);
  });
  it('empty 24 h range after switching, and back to data', async () => {
    const page = await open({ series: { window: makeSeries('window', [underWindow()]), day: makeSeries('day', []) } });
    assert.equal(root(page).querySelectorAll('p.b5h-empty').length, 0);
    await switchTo(page, '24 h');
    emptyOk(page);
    await switchTo(page, 'Fenster');
    assert.equal(root(page).querySelectorAll('p.b5h-empty').length, 0);
    assert.ok(all(page, 'path.b5h-line').length >= 1);
  });
  it('answer for another range (range mismatch) shows the empty state', async () => {
    const page = await open({ series: { window: makeSeries('day', dayWindows()) } });
    emptyOk(page);
  });
  it('answer without windows array shows the empty state', async () => {
    const page = await open({ series: { window: { range: 'window', now: iso(NOW) } } });
    emptyOk(page);
  });
});
