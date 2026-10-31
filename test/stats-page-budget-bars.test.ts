import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { renderPage, until } from './helpers.ts';
import { analyticsFixture, entriesFixture } from './helpers/page-fixtures.ts';

// E9-3 (#392): budget history as columns per day.
const load = async (over: Record<string, unknown>) => {
  const page = renderPage(LOGS_HTML, undefined, {
    url: 'http://127.0.0.1/stats',
    fetch: (u: string) => (u.startsWith('/api/v1/history/entries') ? entriesFixture() : analyticsFixture(over)),
  });
  await until(() => page.$('log-count').textContent === '1' && page.query('#summary-kpis .sum-card').length > 0, 3000, 'the page to load');
  return page;
};
const run = (n: number, hits: number[] = []) => Array.from({ length: n }, (_, i) => {
  const date = new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10);
  return { date, peak_5h_tokens: 500 + i * 10, limit_hits: hits.includes(i) ? 1 : 0 };
});
const budget = (days: object[]) => ({ days, compacts_by_role: {}, avg_context_by_role: {} });
const insights = (over: object = {}) => ({ limit_5h_tokens: 1000, limit_hits: [], top_compact: null, ...over });
const weekday = (date: string) => new Date(date + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '');

describe('statistics page: budget history columns', () => {
  it('draws one column per day with percent, weekday and red limit columns', async () => {
    const days = run(7, [2, 3]);
    const page = await load({ budget: budget(days), budget_insights: insights({ limit_hits: [
      { at: '2026-10-03T10:00:00.000Z', model: 'claude-opus-5-5', role: 'developer' }, { at: '2026-10-04T10:00:00.000Z', model: 'claude-opus-5-5', role: 'developer' }] }) });
    const cols = page.query('#bh-chart .bh-col');
    assert.equal(cols.length, 7);
    assert.deepEqual(page.query('#bh-chart .bh-day').map((d) => d.textContent), days.map((d) => weekday(d.date)));
    assert.deepEqual(cols.map((c) => c.querySelector('.bh-bar')!.classList.contains('is-hit')), days.map((_, i) => i === 2 || i === 3));
    assert.equal(cols[0]!.querySelector('.bh-pct')!.textContent, '50 %');
    assert.ok(page.query('#bh-chart .bh-limit')[0]!.textContent.includes('100 %'));
    const chart = page.$('bh-chart');
    assert.equal(chart.getAttribute('role'), 'img');
    const label = chart.getAttribute('aria-label')!;
    assert.ok(label.startsWith('Spitzenauslastung des 5-Stunden-Fensters der letzten 7 Tage; am '));
    assert.ok(label.endsWith('wurde das Limit erreicht') && label.includes(weekday(days[2]!.date)));
    assert.equal(page.query('#bh-panel .bh-text')[0]!.textContent,
      '2 Limit-Treffer in diesem Zeitraum, alle nach Opus-Sessions. Die Prognose kalibriert sich an diesen Treffern.');
  });

  it('shows the date at every fifth day for 30 days', async () => {
    const page = await load({ budget: budget(run(30)), budget_insights: insights() });
    const labels = page.query('#bh-chart .bh-day').map((d) => d.textContent);
    assert.equal(labels.length, 30);
    labels.forEach((l, i) => assert.equal(l === '', i % 5 !== 0, `day ${i}`));
    assert.equal(labels[0], '01.10.');
    assert.equal(page.query('#bh-panel .bh-text')[0]!.textContent, 'Kein Limit-Treffer in diesem Zeitraum.');
    assert.match(page.$('bh-chart').getAttribute('aria-label')!, /der letzten 30 Tage/);
  });

  it('relates to the highest peak without a calibrated limit', async () => {
    const page = await load({ budget: budget(run(3)), budget_insights: insights({ limit_5h_tokens: null }) });
    assert.equal(page.query('#bh-chart .bh-limit').length, 0);
    assert.ok(page.query('[data-body="budget-bars"]')[0]!.textContent.includes('Noch kein Limit kalibriert'));
  });

  it('shows the empty state without peaks and without budget, and keeps the old chart', async () => {
    const empty = await load({ budget: budget([{ date: '2026-10-30', peak_5h_tokens: 0, limit_hits: 0 }]) });
    assert.ok(empty.query('[data-body="budget-bars"]')[0]!.textContent.includes('Noch keine Budget-Daten'));
    const none = await load({});
    assert.ok(none.query('[data-body="budget-bars"]')[0]!.textContent.includes('Noch keine Budget-Daten'));
    const page = await load({ budget: budget(run(3)), budget_insights: insights() });
    assert.ok(page.query('[data-body="budget"] svg').length > 0);
  });
});
