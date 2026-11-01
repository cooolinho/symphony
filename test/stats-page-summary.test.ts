import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHART_CSS } from '../src/http/charts.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { renderPage, until } from './helpers.ts';
import { analyticsFixture, entriesFixture } from './helpers/page-fixtures.ts';

// E9-3 (#392): title block, period segment and KPI row of the statistics page.
const load = async (over: Record<string, unknown> = {}, url = 'http://127.0.0.1/stats') => {
  const page = renderPage(LOGS_HTML, undefined, {
    url,
    fetch: (u: string) => (u.startsWith('/api/v1/history/entries') ? entriesFixture() : analyticsFixture(over)),
  });
  await until(() => page.$('log-count').textContent === '1' && page.query('#summary-kpis .sum-card').length > 0, 3000, 'the page to load');
  return page;
};
const card = (page: Awaited<ReturnType<typeof load>>, key: string) => page.query(`#summary-kpis [data-kpi="${key}"]`)[0]!;
const totals = (over: Record<string, unknown>) => ({ ...analyticsFixture().totals, ...over });
const previous = (over: Record<string, unknown>) => ({ ...analyticsFixture().totals, from: '2026-10-16T00:00:00.000Z', to: '2026-10-23T00:00:00.000Z', ...over });
const hitLabel = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

describe('statistics page: title block and period segment', () => {
  it('shows title, subtitle and the segment with 7 days as the default', async () => {
    const page = await load();
    assert.equal(page.query('h1')[0]!.textContent, 'Statistik');
    assert.ok(page.root.textContent.includes('Kosten, Tokens und Budgets über die Zeit'));
    const seg = page.$('period-seg');
    assert.equal(seg.getAttribute('role'), 'group');
    assert.equal(seg.getAttribute('aria-label'), 'Zeitraum');
    assert.deepEqual(seg.querySelectorAll('button').map((b) => b.textContent), ['Heute', '7 Tage', '30 Tage']);
    assert.deepEqual(seg.querySelectorAll('button').map((b) => b.getAttribute('aria-pressed')), ['false', 'true', 'false']);
    assert.equal(page.$('period').value, '7d');
    assert.equal(page.$('h-role-summary').textContent, 'Rollen · 7 Tage');
  });

  it('writes the period to the URL on click, reloads with the new range and keeps the repository', async () => {
    const page = await load({}, 'http://127.0.0.1/stats?repo=acme%2Fapp');
    const before = page.fetches.filter((f) => f.url.startsWith('/api/v1/history/analytics')).length;
    page.click(page.$('period-seg').querySelectorAll('button')[2]!);
    await until(() => page.fetches.filter((f) => f.url.startsWith('/api/v1/history/analytics')).length > before, 3000, 'a reload');
    assert.match(String(page.location.search), /period=30d/);
    assert.match(String(page.location.search), /repo=acme%2Fapp/);
    assert.ok(page.fetches.filter((f) => f.url.startsWith('/api/v1/history/analytics')).at(-1)!.url.includes('repo=acme%2Fapp'));
    await until(() => page.$('period-seg').querySelectorAll('button')[2]!.getAttribute('aria-pressed') === 'true', 3000, 'the pressed segment');
  });

  it('presses no segment button for periods the segment does not offer', async () => {
    const page = await load({}, 'http://127.0.0.1/stats?period=14d');
    assert.ok(page.$('period-seg').querySelectorAll('button').every((b) => b.getAttribute('aria-pressed') === 'false'));
  });
});

describe('statistics page: KPI row', () => {
  it('shows five glass cards with the change against the previous period colored by direction', async () => {
    const page = await load({ totals: totals({ cost_usd: 8, total_tokens: 38_400_000 }), previous: previous({ cost_usd: 10, total_tokens: 30_000_000 }) });
    const cards = page.query('#summary-kpis .sum-card');
    assert.equal(cards.length, 5);
    assert.ok(cards.every((c) => c.classList.contains('g')));
    const cost = card(page, 'cost').querySelector('.sum-delta')!;
    assert.equal(cost.textContent, '−20 % zur Vorperiode');
    assert.ok(cost.classList.contains('is-down'));
    const tokens = card(page, 'tokens');
    assert.ok(tokens.textContent.includes('38.4M'));
    assert.equal(tokens.querySelector('.sum-delta')!.textContent, '+28 % zur Vorperiode');
    assert.ok(tokens.querySelector('.sum-delta')!.classList.contains('is-up'));
  });

  it('shows no change without a previous period', async () => {
    const page = await load({ previous: null });
    assert.equal(page.query('#summary-kpis .sum-delta').length, 0);
  });

  it('counts returns from the verdicts of the roles', async () => {
    const page = await load({
      totals: totals({ runs: 4, successful: 1, failed: 0 }),
      verdicts_by_role: [{ role: 'reviewer', verdicts: { 'review:changes_needed': 1 } }, { role: 'tester', verdicts: { 'test:failed': 1, 'test:passed': 5 } }],
    });
    assert.equal(card(page, 'runs').querySelector('.sum-sub')!.textContent, '1 ok · 2 Rückgaben · 0 Fehler');
  });

  it('shows "keine" for no limit hits and the times of the hits otherwise', async () => {
    const days = [{ date: '2026-10-29', peak_5h_tokens: 100, limit_hits: 0 }];
    const none = await load({ budget: { days, compacts_by_role: {}, avg_context_by_role: {} }, budget_insights: { limit_5h_tokens: null, limit_hits: [], top_compact: null } });
    const sub = card(none, 'limits').querySelector('.sum-sub')!;
    assert.equal(sub.textContent, 'keine');
    assert.ok(sub.classList.contains('is-none'));
    const a = '2026-10-29T15:40:00', b = '2026-10-31T14:05:00';
    const hits = await load({
      budget: { days: [{ date: '2026-10-29', peak_5h_tokens: 100, limit_hits: 1 }, { date: '2026-10-31', peak_5h_tokens: 100, limit_hits: 1 }], compacts_by_role: {}, avg_context_by_role: {} },
      budget_insights: { limit_5h_tokens: 1000, limit_hits: [{ at: new Date(a).toISOString(), model: null, role: 'developer' }, { at: new Date(b).toISOString(), model: null, role: 'developer' }], top_compact: null },
    });
    const hit = card(hits, 'limits');
    assert.ok(hit.textContent.includes('2'));
    assert.equal(hit.querySelector('.sum-sub')!.textContent, `${hitLabel(new Date(a).toISOString())} · ${hitLabel(new Date(b).toISOString())}`);
    assert.ok(hit.querySelector('.sum-sub')!.classList.contains('is-hit'));
  });

  it('names the most frequent role and round of the auto-compacts', async () => {
    const page = await load({
      budget: { days: [], compacts_by_role: { developer: 3 }, avg_context_by_role: {} },
      budget_insights: { limit_5h_tokens: null, limit_hits: [], top_compact: { role: 'developer', round: 2, compacts: 3 } },
    });
    assert.equal(card(page, 'compacts').querySelector('.sum-sub')!.textContent, 'meist developer, Runde 2');
  });

  it('renders without budget and budget_insights', async () => {
    const page = await load();
    assert.equal(card(page, 'limits').querySelector('.sum-sub')!.textContent, 'keine');
    assert.equal(card(page, 'compacts').querySelector('.sum-sub')!.textContent, 'keine');
  });
});

describe('statistics page: existing panels', () => {
  it('gives every panel title the .lbl class and charts the text colors of #379', async () => {
    const page = await load();
    const titles = page.query('h2.ui-card-title');
    assert.ok(titles.length >= 10);
    assert.ok(titles.every((t) => t.classList.contains('lbl')));
    const text = titles.map((t) => t.textContent).join('|');
    for (const title of ['Geschätzte Kosten', 'Modelle', 'Repositories', 'Auffälligkeiten', 'Issues', 'Log']) assert.ok(text.includes(title), title);
    for (const old of ['var(--text)', 'var(--text-2)', 'var(--muted)']) assert.ok(!CHART_CSS.includes(old), old);
  });
});
