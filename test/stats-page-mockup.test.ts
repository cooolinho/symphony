import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { renderPage, until } from './helpers.ts';
import { analyticsFixture, entriesFixture } from './helpers/page-fixtures.ts';

// E9-3 (#392): independent acceptance tests of the statistics page after the mockup, derived from the issue text.

type Page = ReturnType<typeof renderPage>;
type El = ReturnType<Page['$']>;

const analyticsUrls = (page: Page) => page.fetches.map((f) => f.url).filter((u) => u.startsWith('/api/v1/history/analytics'));
const load = async (over: Record<string, unknown> = {}, url = 'http://127.0.0.1/stats') => {
  const page = renderPage(LOGS_HTML, undefined, {
    url,
    fetch: (u: string) => (u.startsWith('/api/v1/history/entries') ? entriesFixture() : analyticsFixture(over)),
  });
  await until(() => page.$('log-count').textContent === '1' && page.$('summary-kpis').children.length > 0, 3000, 'the page to load');
  return page;
};
const totals = (over: Record<string, unknown>) => ({ ...analyticsFixture().totals, ...over });
const previous = (over: Record<string, unknown>) => ({ ...analyticsFixture().totals, ...over });
const kpis = (page: Page) => page.$('summary-kpis').children;
const kpiByLabel = (page: Page, label: string) => {
  const found = kpis(page).find((c) => c.textContent.includes(label));
  assert.ok(found, `KPI card "${label}"`);
  return found;
};
const days = (n: number, peaks: (i: number) => number, hits: number[] = []) => Array.from({ length: n }, (_, i) => ({
  date: new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10), peak_5h_tokens: peaks(i), limit_hits: hits.includes(i) ? 1 : 0,
}));
const budget = (d: object[], extra: object = {}) => ({ days: d, compacts_by_role: {}, avg_context_by_role: {}, ...extra });
const insights = (over: object = {}) => ({ limit_5h_tokens: 1000, limit_hits: [], top_compact: null, ...over });
const wd = (date: string) => new Date(date + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '');

/** All descendants of an element, depth first. */
const descendants = (el: El): El[] => el.children.flatMap((c: El) => [c, ...descendants(c)]);
/** The innermost descendant whose text matches. */
const byText = (el: El, re: RegExp): El | undefined => descendants(el).find((d) => re.test(d.textContent) && d.children.every((c: El) => !re.test(c.textContent)));
const spanDays = (url: string) => { const q = new URL(url, 'http://x').searchParams; return (Date.parse(q.get('to')!) - Date.parse(q.get('from')!)) / 86_400_000; };

const css = LOGS_HTML.match(/<style[^>]*>([\s\S]*?)<\/style>/g)?.join('\n') ?? '';
const flat = css.replace(/\s+/g, ' ');
/** Value of a CSS property for an element from the class-only rules of the page (highest specificity, later wins). */
const declOf = (el: El, prop: string): string | null => {
  const classes = new Set(el.className.split(/\s+/).filter(Boolean));
  let best: { spec: number; value: string } | null = null;
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const sel of m[1]!.split(',').map((x) => x.trim())) {
      if (!/^(\.[\w-]+)+$/.test(sel)) continue;
      const need = sel.slice(1).split('.');
      if (!need.every((c) => classes.has(c))) continue;
      const v = new RegExp('(?:^|[;\\s])' + prop + ':\\s*([^;]+)').exec(m[2]!);
      if (v && (!best || need.length >= best.spec)) best = { spec: need.length, value: v[1]!.trim() };
    }
  }
  return best?.value ?? null;
};
/** Value of a property from an id rule such as `#summary-kpis` or `#role-summary th`. */
const idDecl = (selector: string, prop: string): string | null => {
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1]!.split(',').map((x) => x.trim().replace(/\s+/g, ' ')).includes(selector)) continue;
    const v = new RegExp('(?:^|[;\\s])' + prop + ':\\s*([^;]+)').exec(m[2]!);
    if (v) return v[1]!.trim();
  }
  return null;
};

describe('E9-3 title block and period segment', () => {
  it('title block: h1, subtitle and the three-button segment', async () => {
    const page = await load();
    assert.equal(page.query('h1').length, 1);
    assert.equal(page.query('h1')[0]!.textContent, 'Statistik');
    assert.ok(page.root.textContent.includes('Kosten, Tokens und Budgets über die Zeit'));
    const seg = page.query('[role="group"]').find((g) => g.getAttribute('aria-label') === 'Zeitraum' && g.querySelectorAll('button').length === 3);
    assert.ok(seg, 'segment with aria-label Zeitraum');
    assert.deepEqual(seg.querySelectorAll('button').map((b) => b.textContent), ['Heute', '7 Tage', '30 Tage']);
  });

  it('requests 7 days without ?period (same range as ?period=7d) and marks the 7-day button', async () => {
    const page = await load();
    const explicit = await load({}, 'http://127.0.0.1/stats?period=7d');
    assert.ok(analyticsUrls(page).length > 0);
    assert.equal(analyticsUrls(page)[0], analyticsUrls(explicit)[0]);
    const span = spanDays(analyticsUrls(page)[0]!);
    assert.ok(span > 6 && span <= 7, `about 7 days, got ${span}`);
    assert.deepEqual(page.$('period-seg').querySelectorAll('button').map((b) => b.getAttribute('aria-pressed')), ['false', 'true', 'false']);
    assert.equal(page.$('period').value, '7d');
  });

  it('takes ?period=today and ?period=30d from the URL', async () => {
    const today = await load({}, 'http://127.0.0.1/stats?period=today');
    assert.ok(spanDays(analyticsUrls(today)[0]!) <= 1);
    assert.deepEqual(today.$('period-seg').querySelectorAll('button').map((b) => b.getAttribute('aria-pressed')), ['true', 'false', 'false']);
    const month = await load({}, 'http://127.0.0.1/stats?period=30d');
    const span = spanDays(analyticsUrls(month)[0]!);
    assert.ok(span > 29 && span <= 30, `about 30 days, got ${span}`);
    assert.deepEqual(month.$('period-seg').querySelectorAll('button').map((b) => b.getAttribute('aria-pressed')), ['false', 'false', 'true']);
  });

  it('keeps an invalid period at 30d (existing behavior)', async () => {
    const bogus = await load({}, 'http://127.0.0.1/stats?period=bogus');
    const month = await load({}, 'http://127.0.0.1/stats?period=30d');
    assert.equal(analyticsUrls(bogus)[0], analyticsUrls(month)[0]);
    assert.equal(bogus.$('period').value, '30d');
  });

  it('click on "Heute" writes ?period=today, reloads with it and keeps repo, model and effort', async () => {
    const page = await load({}, 'http://127.0.0.1/stats?period=30d&repo=acme%2Fapp&model=claude-opus-5-5&effort=high');
    const count = analyticsUrls(page).length;
    page.click(page.$('period-seg').querySelectorAll('button')[0]!);
    await until(() => analyticsUrls(page).length > count, 3000, 'reload');
    const search = String(page.location.search);
    assert.match(search, /period=today/);
    assert.doesNotMatch(search, /period=30d/);
    assert.match(search, /repo=acme%2Fapp/);
    assert.match(search, /model=claude-opus-5-5/);
    assert.match(search, /effort=high/);
    const last = analyticsUrls(page).at(-1)!;
    assert.ok(spanDays(last) <= 1, 'range of one day');
    assert.match(last, /repo=acme%2Fapp/);
    assert.equal(page.$('period').value, 'today');
  });

  it('click on "7 Tage" from the 30-day view writes ?period=7d', async () => {
    const page = await load({}, 'http://127.0.0.1/stats?period=30d');
    const count = analyticsUrls(page).length;
    page.click(page.$('period-seg').querySelectorAll('button')[1]!);
    await until(() => analyticsUrls(page).length > count, 3000, 'reload');
    assert.match(String(page.location.search), /period=7d/);
  });

  it('the period applies to the heading of the role panel', async () => {
    assert.equal((await load({}, 'http://127.0.0.1/stats?period=today')).query('h2').find((h) => h.textContent.startsWith('Rollen ·'))!.textContent, 'Rollen · Heute');
    assert.equal((await load({}, 'http://127.0.0.1/stats?period=30d')).query('h2').find((h) => h.textContent.startsWith('Rollen ·'))!.textContent, 'Rollen · 30 Tage');
  });

  it('the filter bar with the repository, model and effort filters is still there', async () => {
    const page = await load();
    for (const id of ['period', 'repo', 'model', 'effort']) assert.ok(page.document.getElementById(id), `#${id}`);
  });
});

describe('E9-3 KPI row', () => {
  it('layout: auto-fit grid of 180px, gap 12px, five .g cards with radius 18 and padding 16px 18px', async () => {
    const page = await load();
    const row = page.$('summary-kpis');
    const grid = declOf(row, 'grid-template-columns') ?? idDecl('#summary-kpis', 'grid-template-columns') ?? '';
    assert.match(grid, /repeat\(auto-fit, minmax\(180px, 1fr\)\)/);
    assert.equal(declOf(row, 'gap') ?? idDecl('#summary-kpis', 'gap'), '12px');
    const cards = kpis(page);
    assert.equal(cards.length, 5);
    assert.ok(cards.every((c) => c.classList.contains('g')));
    for (const c of cards) {
      assert.equal(declOf(c, 'border-radius'), '18px');
      assert.equal(declOf(c, 'padding'), '16px 18px');
    }
  });

  it('five cards with the labels in order; label 13px --fg-2, value 28px', async () => {
    const page = await load();
    ['Kosten (geschätzt)', 'Tokens', 'Runs', 'Limit-Treffer', 'Auto-Compacts'].forEach((l, i) => assert.ok(kpis(page)[i]!.textContent.includes(l), l));
    assert.match(flat, /font-size: 13px; color: var\(--fg-2\)/);
    assert.match(flat, /--fs-kpi-28: 28px/);
    assert.ok(kpis(page).every((c) => c.classList.contains('ui-kpi-28') || descendants(c).some((d) => d.classList.contains('ui-kpi-28'))));
  });

  it('cost "$8.00" with -20 % in green, tokens compact "38.4M" with +28 % in amber, delta 12.5px', async () => {
    const page = await load({ totals: totals({ cost_usd: 8, total_tokens: 38_400_000 }), previous: previous({ cost_usd: 10, total_tokens: 30_000_000 }) });
    const cost = kpiByLabel(page, 'Kosten (geschätzt)');
    assert.ok(cost.textContent.includes('$8'));
    const cd = byText(cost, /zur Vorperiode/)!;
    assert.ok(cd, 'delta line');
    assert.match(cd.textContent, /^[−-]20 % zur Vorperiode$/);
    assert.match(declOf(cd, 'color') ?? '', /var\(--green\)|#4ade80/);
    assert.equal(declOf(cd, 'font-size'), '12.5px');
    const tokens = kpiByLabel(page, 'Tokens');
    assert.ok(tokens.textContent.includes('38.4M'));
    const td = byText(tokens, /zur Vorperiode/)!;
    assert.equal(td.textContent, '+28 % zur Vorperiode');
    assert.match(declOf(td, 'color') ?? '', /var\(--amber\)|#fbbf24/);
  });

  it('an increase of cost is amber; no change shows 0 % and is neither green nor amber', async () => {
    const up = await load({ totals: totals({ cost_usd: 15 }), previous: previous({ cost_usd: 10 }) });
    const d = byText(kpiByLabel(up, 'Kosten'), /zur Vorperiode/)!;
    assert.equal(d.textContent, '+50 % zur Vorperiode');
    assert.match(declOf(d, 'color') ?? '', /var\(--amber\)|#fbbf24/);
    const same = await load({ totals: totals({ cost_usd: 10 }), previous: previous({ cost_usd: 10 }) });
    const z = byText(kpiByLabel(same, 'Kosten'), /zur Vorperiode/)!;
    assert.match(z.textContent, /^[±+−-]?0 % zur Vorperiode$/);
    assert.doesNotMatch(declOf(z, 'color') ?? '', /var\(--green\)|var\(--amber\)/);
  });

  it('no delta without a previous period; a previous value of 0 gives no NaN/Infinity', async () => {
    const none = await load({ previous: null });
    assert.ok(!none.$('summary-kpis').textContent.includes('Vorperiode'));
    const zero = await load({ totals: totals({ cost_usd: 5, total_tokens: 100 }), previous: previous({ cost_usd: 0, total_tokens: 0 }) });
    assert.ok(!/NaN|Infinity/.test(zero.$('summary-kpis').textContent));
  });

  it('runs: "<ok> ok · <n> Rückgaben · <m> Fehler" in --fg-2', async () => {
    const page = await load({
      totals: totals({ runs: 10, successful: 7, failed: 2 }),
      verdicts_by_role: [{ role: 'reviewer', verdicts: { 'review:changes_needed': 2 } }, { role: 'security', verdicts: { 'security:issues_found': 1 } }],
    });
    const line = byText(kpiByLabel(page, 'Runs'), /ok · /)!;
    assert.equal(line.textContent, '7 ok · 3 Rückgaben · 2 Fehler');
    assert.match(declOf(line, 'color') ?? '', /var\(--fg-2\)|#aab6cc/);
  });

  it('limit hits: 0 -> "keine" in --fg-3', async () => {
    const page = await load({ budget: budget(days(7, () => 100)), budget_insights: insights() });
    const card = kpiByLabel(page, 'Limit-Treffer');
    const none = byText(card, /^keine$/)!;
    assert.ok(none, '"keine"');
    assert.match(declOf(none, 'color') ?? '', /var\(--fg-3\)|#8b98b0/);
    assert.ok(card.textContent.includes('0'));
  });

  it('limit hits: weekday and time of every hit in #fca5a5', async () => {
    const a = new Date('2026-10-15T15:40:00'), b = new Date('2026-10-17T14:05:00');
    const page = await load({
      budget: budget(days(7, () => 100, [1, 3])),
      budget_insights: insights({ limit_hits: [{ at: a.toISOString(), model: null, role: 'developer' }, { at: b.toISOString(), model: null, role: 'developer' }] }),
    });
    const card = kpiByLabel(page, 'Limit-Treffer');
    const short = (d: Date) => d.toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '');
    const line = byText(card, /15:40/)!;
    assert.ok(line, 'times line');
    assert.equal(line.textContent, `${short(a)} 15:40 · ${short(b)} 14:05`);
    assert.match(declOf(line, 'color') ?? '', /var\(--red-300\)|#fca5a5/);
    assert.ok(card.textContent.includes('2'));
    assert.ok(!card.textContent.includes('keine'));
  });

  it('auto-compacts: sum and "meist <Rolle>, Runde <n>" in --fg-2', async () => {
    const page = await load({
      budget: budget([], { compacts_by_role: { developer: 5, tester: 1 } }),
      budget_insights: insights({ limit_5h_tokens: null, top_compact: { role: 'developer', round: 3, compacts: 4 } }),
    });
    const card = kpiByLabel(page, 'Auto-Compacts');
    const line = byText(card, /meist/)!;
    assert.equal(line.textContent, 'meist developer, Runde 3');
    assert.match(declOf(line, 'color') ?? '', /var\(--fg-2\)|#aab6cc/);
    assert.ok(card.textContent.includes('6'));
  });

  it('renders with an older analytics response (no budget, budget_insights or verdicts)', async () => {
    const o = analyticsFixture();
    delete o.budget; delete o.budget_insights; delete o.verdicts_by_role;
    const page = renderPage(LOGS_HTML, undefined, { url: 'http://127.0.0.1/stats', fetch: (u: string) => (u.startsWith('/api/v1/history/entries') ? entriesFixture() : o) });
    await until(() => page.$('log-count').textContent === '1' && kpis(page).length > 0, 3000, 'page');
    assert.equal(kpis(page).length, 5);
    assert.ok(!/undefined|NaN/.test(page.$('summary-kpis').textContent));
  });
});

describe('E9-3 budget history', () => {
  const panel = (page: Page) => page.query('section').find((s) => s.textContent.includes('Budget-Historie · Spitze im 5-h-Fenster je Tag'))!;

  it('panel with title, legend (Spitze, Limit getroffen) and flex 999 1 620px', async () => {
    const page = await load({ budget: budget(days(7, (i) => 100 + i * 100)), budget_insights: insights() });
    const p = panel(page);
    assert.ok(p, 'panel with the title');
    assert.ok(p.textContent.includes('Spitze'));
    assert.ok(p.textContent.includes('Limit getroffen'));
    assert.equal(declOf(p, 'flex') ?? idDecl('#' + p.id, 'flex'), '999 1 620px');
  });

  it('diagram: role=img, one column per day, exact aria-label with the limit days', async () => {
    const d = days(7, (i) => 200 + i * 100, [2, 4]);
    const page = await load({ budget: budget(d), budget_insights: insights({ limit_hits: [{ at: '2026-10-03T10:00:00.000Z', model: 'claude-opus-5-5', role: 'developer' }, { at: '2026-10-05T10:00:00.000Z', model: 'claude-opus-5-5', role: 'developer' }] }) });
    const chart = panel(page).querySelector('[role="img"]')!;
    assert.ok(chart, 'role=img');
    const label = chart.getAttribute('aria-label')!;
    assert.ok(label.startsWith('Spitzenauslastung des 5-Stunden-Fensters der letzten 7 Tage; am '), label);
    assert.ok(label.endsWith(' wurde das Limit erreicht'), label);
    assert.ok(label.includes(wd(d[2]!.date)) && label.includes(wd(d[4]!.date)), label);
    assert.equal(chart.querySelectorAll('.bh-col').length, 7);
  });

  it('percent over the bar, height proportional to the percentage, limit days red, others sky', async () => {
    const d = days(4, (i) => [250, 500, 1000, 750][i]!, [2]);
    const page = await load({ budget: budget(d), budget_insights: insights({ limit_hits: [{ at: '2026-10-03T10:00:00.000Z', model: 'claude-opus-5-5', role: 'developer' }] }) });
    const cols = panel(page).querySelectorAll('.bh-col');
    assert.deepEqual(cols.map((c) => c.querySelector('.bh-pct')!.textContent), ['25 %', '50 %', '100 %', '75 %']);
    const bars = cols.map((c) => c.querySelector('.bh-bar')!);
    const h = bars.map((b) => parseFloat(String(b.style.height)));
    assert.ok(h.every((x) => x > 0));
    assert.ok(Math.abs(h[1]! / h[0]! - 2) < 0.1, `50 % is twice 25 %: ${h}`);
    assert.ok(Math.abs(h[3]! / h[0]! - 3) < 0.15, `75 % is thrice 25 %: ${h}`);
    assert.ok(h[2]! > h[3]!);
    assert.deepEqual(bars.map((b) => b.classList.contains('is-hit')), [false, false, true, false]);
    assert.match(declOf(bars[0]!, 'border') ?? '', /var\(--sky-300\)|#7dd3fc/);
    assert.match(declOf(bars[0]!, 'background') ?? '', /22%|\.22/);
    assert.match(declOf(bars[2]!, 'border-color') ?? '', /var\(--red-400\)|#f87171/);
    assert.match(declOf(bars[2]!, 'background') ?? '', /28%|\.28/);
    assert.equal(declOf(bars[0]!, 'max-width'), '54px');
    assert.equal(declOf(bars[0]!, 'border-radius'), '10px 10px 4px 4px');
    const pct = cols.map((c) => c.querySelector('.bh-pct')!);
    assert.equal(declOf(pct[0]!, 'font'), '12px var(--mono)');
    assert.match(declOf(pct[0]!, 'color') ?? '', /var\(--sky-300\)|#7dd3fc/);
    assert.match(flat, /\.bh-col\.is-hit \.bh-pct \{[^}]*var\(--red-400\)/);
  });

  it('grid: gap 14px, height 220px, align-items end, base line .12; dashed 100 % line, mono 11px label', async () => {
    const page = await load({ budget: budget(days(7, () => 500)), budget_insights: insights() });
    const grid = panel(page).querySelector('.bh-grid')!;
    assert.equal(declOf(grid, 'gap'), '14px');
    assert.equal(declOf(grid, 'height'), '220px');
    assert.equal(declOf(grid, 'align-items'), 'end');
    assert.match(declOf(grid, 'border-bottom') ?? '', /12%|\.12/);
    assert.match(String(grid.style.gridTemplateColumns), /repeat\(7,/);
    const line = panel(page).querySelector('.bh-limit')!;
    assert.ok(line.textContent.includes('100 %'));
    assert.match(declOf(line, 'border-top') ?? '', /dashed/);
    assert.match(declOf(line, 'border-top') ?? '', /60%|\.6/);
    assert.equal(idDecl('.bh-limit span', 'font'), '11px var(--mono)');
    assert.ok(line.children.length > 0, 'label element inside the line');
  });

  it('7 days: weekday (de-DE) under every column, Mono 12px centred', async () => {
    const d = days(7, () => 500);
    const page = await load({ budget: budget(d), budget_insights: insights() });
    const labels = panel(page).querySelectorAll('.bh-day');
    assert.deepEqual(labels.map((x) => x.textContent), d.map((x) => wd(x.date)));
    assert.equal(declOf(labels[0]!, 'font'), '12px var(--mono)');
    assert.equal(declOf(labels[0]!, 'text-align'), 'center');
  });

  it('30 days: date instead of weekday, only at every fifth day', async () => {
    const page = await load({ budget: budget(days(30, () => 500)), budget_insights: insights() });
    const labels = panel(page).querySelectorAll('.bh-day').map((x) => x.textContent);
    assert.equal(labels.length, 30);
    labels.forEach((l, i) => {
      if (i % 5 === 0) assert.match(l, /^\d{2}\.\d{2}\.?$/, `day ${i}`);
      else assert.equal(l, '', `day ${i}`);
    });
    assert.match(panel(page).querySelector('[role="img"]')!.getAttribute('aria-label')!, /der letzten 30 Tage/);
  });

  it('text below: one hit with the model of the session, several models, none', async () => {
    const one = await load({ budget: budget(days(7, () => 500, [3])), budget_insights: insights({ limit_hits: [{ at: '2026-10-04T10:00:00.000Z', model: 'claude-opus-5-5', role: 'developer' }] }) });
    assert.equal(byText(panel(one), /Limit-Treffer in diesem Zeitraum/)!.textContent,
      '1 Limit-Treffer in diesem Zeitraum, alle nach Opus-Sessions. Die Prognose kalibriert sich an diesen Treffern.');
    const mixed = await load({ budget: budget(days(7, () => 500, [1, 3])), budget_insights: insights({ limit_hits: [{ at: '2026-10-02T10:00:00.000Z', model: 'claude-opus-5-5', role: 'developer' }, { at: '2026-10-04T10:00:00.000Z', model: 'claude-sonnet-5-5', role: 'developer' }] }) });
    assert.equal(byText(panel(mixed), /Limit-Treffer in diesem Zeitraum/)!.textContent, '2 Limit-Treffer in diesem Zeitraum. Die Prognose kalibriert sich an diesen Treffern.');
    const none = await load({ budget: budget(days(7, () => 500)), budget_insights: insights() });
    const t = byText(panel(none), /^Kein Limit-Treffer in diesem Zeitraum\.$/)!;
    assert.ok(t, 'no-hit text');
    assert.equal(declOf(t, 'font-size'), '13px');
    assert.match(declOf(t, 'color') ?? '', /var\(--fg-2\)|#aab6cc/);
  });

  it('empty state: "Noch keine Budget-Daten" without budget and with only empty days', async () => {
    const none = await load({});
    assert.ok(panel(none).textContent.includes('Noch keine Budget-Daten'));
    assert.equal(panel(none).querySelectorAll('.bh-col').length, 0);
    const zero = await load({ budget: budget(days(7, () => 0)) });
    assert.ok(panel(zero).textContent.includes('Noch keine Budget-Daten'));
  });
});

describe('E9-3 role table', () => {
  const base = analyticsFixture().by_role[0];
  const roles = [
    { ...base, role: 'reviewer', runs: 2, total_tokens: 1_000, cost_usd: 0.5 },
    { ...base, role: 'developer', runs: 9, total_tokens: 2_500_000, cost_usd: 12.34 },
    { ...base, role: 'tester', runs: 4, total_tokens: 50_000, cost_usd: 1.2 },
    { ...base, role: 'analyst', runs: 1, total_tokens: 700_000, cost_usd: 3 },
  ];
  const loadRoles = (b?: object, url?: string) => load({ by_role: roles, ...(b ? { budget: b } : {}) }, url);
  const section = (page: Page) => page.query('section').find((s) => /Rollen ·/.test(s.textContent))!;
  const tableOf = (page: Page) => section(page).querySelector('table')!;
  const bodyRows = (page: Page) => tableOf(page).querySelectorAll('tr').filter((r) => r.querySelectorAll('td').length > 0);

  it('panel "Rollen · 7 Tage" with a table, column heads in order and flex 1 1 380px', async () => {
    const page = await loadRoles();
    assert.ok(section(page).textContent.includes('Rollen · 7 Tage'));
    assert.deepEqual(tableOf(page).querySelectorAll('th').map((t) => t.textContent), ['Rolle', 'Runs', 'Tokens', 'Kosten', 'Ø Context', 'Compacts']);
    assert.equal(declOf(section(page), 'flex') ?? idDecl('#' + section(page).id, 'flex'), '1 1 380px');
  });

  it('rows sorted by tokens, descending', async () => {
    const page = await loadRoles();
    assert.deepEqual(bodyRows(page).map((r) => r.querySelectorAll('td')[0]!.textContent), ['developer', 'analyst', 'tester', 'reviewer']);
  });

  it('numbers: runs, compact tokens, dollar cost', async () => {
    const page = await loadRoles();
    const dev = bodyRows(page)[0]!.querySelectorAll('td');
    assert.equal(dev[1]!.textContent, '9');
    assert.equal(dev[2]!.textContent, '2.5M');
    assert.equal(dev[3]!.textContent, '$12.34');
  });

  it('role has a colour dot; table 13px in an overflow-x:auto wrapper; head --fg-3/500; numbers mono right-aligned; row lines .06', async () => {
    const page = await loadRoles();
    const first = bodyRows(page)[0]!.querySelectorAll('td')[0]!;
    const dot = first.querySelector('.rs-dot')!;
    assert.ok(dot, 'colour dot');
    assert.match(String(dot.style.background), /var\(--role-developer\)|#/);
    const wrapper = tableOf(page).parentElement!;
    assert.equal(declOf(wrapper, 'overflow-x'), 'auto');
    assert.equal(idDecl('#role-summary', 'font-size'), '13px');
    assert.equal(idDecl('#role-summary th', 'font-size'), '13px');
    assert.match(idDecl('#role-summary th', 'color') ?? '', /var\(--fg-3\)/);
    assert.equal(idDecl('#role-summary th', 'font-weight'), '500');
    const num = tableOf(page).querySelectorAll('th')[1]!;
    assert.ok(num.classList.contains('num'), 'numeric head cell');
    assert.equal(idDecl('#role-summary td.num', 'text-align'), 'right');
    assert.equal(idDecl('#role-summary td.num', 'font-family'), 'var(--mono)');
    assert.ok(bodyRows(page)[0]!.querySelectorAll('td')[1]!.classList.contains('num'));
    assert.match(idDecl('#role-summary td', 'border-bottom') ?? '', /1px solid .*6%/);
  });

  it('Ø Context: "<n> %", amber from 60 % (incl. exactly 60), else --fg-2, "—" without snapshots', async () => {
    const page = await loadRoles({ days: [], compacts_by_role: {}, avg_context_by_role: { developer: 60, analyst: 59.4, tester: 82.6 } });
    const ctx = Object.fromEntries(bodyRows(page).map((r) => { const td = r.querySelectorAll('td'); return [td[0]!.textContent, td[4]!]; }));
    assert.equal(ctx.developer!.textContent, '60 %');
    assert.equal(ctx.analyst!.textContent, '59 %');
    assert.equal(ctx.tester!.textContent, '83 %');
    assert.equal(ctx.reviewer!.textContent, '—');
    const colorOf = (td: El) => declOf(byText(td, /%/) ?? td, 'color') ?? '';
    assert.match(colorOf(ctx.developer!), /var\(--amber-300\)|#fcd34d/);
    assert.match(colorOf(ctx.tester!), /var\(--amber-300\)|#fcd34d/);
    assert.match(colorOf(ctx.analyst!), /var\(--fg-2\)|#aab6cc/);
  });

  it('Compacts column behind Ø Context shows the auto-compacts of the role', async () => {
    const page = await loadRoles({ days: [], compacts_by_role: { developer: 7, tester: 2 }, avg_context_by_role: { developer: 70 } });
    const cmp = Object.fromEntries(bodyRows(page).map((r) => { const td = r.querySelectorAll('td'); return [td[0]!.textContent, td[5]!.textContent]; }));
    assert.equal(cmp.developer, '7');
    assert.equal(cmp.tester, '2');
    assert.ok(cmp.reviewer === '—' || cmp.reviewer === '0', String(cmp.reviewer));
  });

  it('works without budget data (all "—")', async () => {
    const page = await loadRoles();
    assert.ok(bodyRows(page).every((r) => r.querySelectorAll('td')[4]!.textContent === '—'));
  });

  it('the existing roles table #roles-table is unchanged', async () => {
    const page = await loadRoles({ days: [], compacts_by_role: {}, avg_context_by_role: { developer: 40 } });
    const old = page.$('roles-table');
    assert.ok(old.querySelectorAll('th').some((t) => t.textContent.includes('Ø Context')));
    assert.ok(old.querySelectorAll('td').some((td) => td.textContent === '40%'));
  });
});

describe('E9-3 existing analytics sections below', () => {
  it('all former panels are .g panels with .lbl titles and keep their content areas', async () => {
    const page = await load();
    const heads = page.query('h2').filter((h) => h.parentElement!.classList.contains('ui-card-head'));
    assert.ok(heads.length >= 12);
    assert.ok(heads.every((h) => h.classList.contains('lbl')), heads.filter((h) => !h.classList.contains('lbl')).map((h) => h.textContent).join(','));
    const all = page.query('h2').map((h) => h.textContent).join('|');
    for (const t of ['Geschätzte Kosten', 'Modelle', 'Repositories', 'Auffälligkeiten']) assert.ok(all.includes(t), t);
    for (const body of ['cost', 'tokens', 'models', 'roles', 'repos', 'attention', 'issues']) {
      const el = page.query(`[data-body="${body}"]`)[0]!;
      assert.ok(el, body);
      let n: El | null = el;
      while (n && !n.classList.contains('g')) n = n.parentElement;
      assert.ok(n, `${body} lies in a .g panel`);
    }
  });

  it('the new sections come first, the old panels follow below', async () => {
    const page = await load();
    const titles = page.query('h2').map((h) => h.textContent);
    const iBudget = titles.findIndex((t) => t.startsWith('Budget-Historie'));
    const iRoles = titles.findIndex((t) => t.startsWith('Rollen ·'));
    const iCost = titles.findIndex((t) => t.startsWith('Geschätzte Kosten'));
    const iRepos = titles.findIndex((t) => t === 'Repositories');
    assert.ok(iBudget >= 0 && iRoles >= 0 && iBudget < iCost && iRoles < iCost && iCost < iRepos, titles.join('|'));
  });

  it('the sort and view controls of the old sections are kept', async () => {
    const page = await load();
    for (const id of ['model-sort', 'repo-sort', 'issue-sort', 'cost-mode', 'activity-metric']) assert.ok(page.document.getElementById(id), id);
  });
});
