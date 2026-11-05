import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { renderPage, until } from './helpers.ts';
import { analyticsFixture, entriesFixture } from './helpers/page-fixtures.ts';

// E4-11 (#468): independent tests for the budget history columns drawn from peak_5h_percent.
const load = async (over: Record<string, unknown>) => {
  const page = renderPage(LOGS_HTML, undefined, {
    url: 'http://127.0.0.1/stats',
    fetch: (u: string) => (u.startsWith('/api/v1/history/entries') ? entriesFixture() : analyticsFixture(over)),
  });
  await until(() => page.$('log-count').textContent === '1' && page.query('#summary-kpis .sum-card').length > 0, 3000, 'the page to load');
  return page;
};
type Day = { date: string; peak_5h_tokens: number; limit_hits: number; peak_5h_percent: number | null };
const days = (percents: Array<number | null>, tokens = 500, hits: number[] = []): Day[] => percents.map((p, i) => ({
  date: new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10), peak_5h_tokens: tokens, limit_hits: hits.includes(i) ? 1 : 0, peak_5h_percent: p,
}));
const budget = (d: Day[]) => ({ days: d, compacts_by_role: {}, avg_context_by_role: {} });
const insights = (over: object = {}) => ({ limit_5h_tokens: 1000, limit_hits: [], top_compact: null, ...over });
const sdkPage = (d: Day[], over: object = {}) => load({ budget: budget(d), budget_insights: insights({ peak_source: 'sdk', ...over }) });
const barOf = (col: { querySelector(s: string): { style: Record<string, unknown>; classList: { contains(c: string): boolean } } | null }) => col.querySelector('.bh-bar')!;

describe('statistics page: budget peak from the SDK', () => {
  it('draws the bar height from the percent on the 0 to 100 axis (180 px = 100 %)', async () => {
    const page = await sdkPage(days([0, 50, 100, 150, 25]));
    const cols = page.query('#bh-chart .bh-col');
    assert.deepEqual(cols.map((c) => String(barOf(c).style.height)), ['0px', '90px', '180px', '180px', '45px']);
  });

  it('shows the real number above 100 in label and tooltip even though the bar is capped', async () => {
    const page = await sdkPage(days([101, 150, 40]));
    const cols = page.query('#bh-chart .bh-col');
    assert.equal(cols[0]!.querySelector('.bh-pct')!.textContent, 'Spitze 101 %');
    assert.equal(cols[1]!.querySelector('.bh-pct')!.textContent, 'Spitze 150 %');
    assert.ok(cols[0]!.getAttribute('title')!.includes('101 %'));
    assert.ok(cols[1]!.getAttribute('title')!.includes('150 %'));
    assert.equal(String(barOf(cols[0]!).style.height), '180px');
  });

  it('labels every SDK day with the percent, not with tokens or the calibrated limit', async () => {
    const page = await sdkPage(days([72, 90], 900), { limit_5h_tokens: 1000 });
    const labels = page.query('#bh-chart .bh-pct').map((p) => p.textContent);
    assert.equal(labels[0], 'Spitze 72 %');
    assert.equal(labels[1], 'Spitze 90 %');
  });

  it('works without a calibrated limit when SDK data exist (no calibration note, 100 % line present)', async () => {
    const page = await sdkPage(days([40, 60]), { limit_5h_tokens: null });
    assert.equal(page.query('#bh-chart .bh-limit').length, 1);
    assert.ok(!page.query('[data-body="budget-bars"]')[0]!.textContent.includes('Noch kein Limit kalibriert'));
    assert.equal(String(barOf(page.query('#bh-chart .bh-col')[1]!).style.height), '108px');
  });

  it('marks days without an SDK value as estimated (dashed bar and tooltip) and draws them from tokens', async () => {
    const page = await sdkPage(days([80, null, null], 500));
    const cols = page.query('#bh-chart .bh-col');
    assert.ok(!barOf(cols[0]!).classList.contains('is-estimate'));
    for (const col of cols.slice(1)) {
      assert.ok(barOf(col).classList.contains('is-estimate'));
      assert.ok(col.getAttribute('title')!.includes('geschätzt'));
      assert.equal(col.querySelector('.bh-pct')!.textContent, '50 %'); // 500 of 1000 tokens
      assert.equal(String(barOf(col).style.height), '90px');
    }
  });

  it('does not mark a day without SDK value and without tokens as estimated', async () => {
    const page = await sdkPage(days([80, null], 0).map((d, i) => (i === 1 ? { ...d, peak_5h_tokens: 0 } : { ...d, peak_5h_tokens: 500 })));
    const col = page.query('#bh-chart .bh-col')[1]!;
    assert.ok(!barOf(col).classList.contains('is-estimate'));
    assert.equal(String(barOf(col).style.height), '0px');
  });

  it('keeps the limit markers: hit days are red, with and without SDK value', async () => {
    const page = await sdkPage(days([100, null, 30, 20], 500, [0, 1, 3]));
    const cols = page.query('#bh-chart .bh-col');
    assert.deepEqual(cols.map((c) => barOf(c).classList.contains('is-hit')), [true, true, false, true]);
    assert.deepEqual(cols.map((c) => c.classList.contains('is-hit')), [true, true, false, true]);
    assert.ok(page.$('bh-chart').getAttribute('aria-label')!.includes('wurde das Limit erreicht'));
  });

  it('states the source on the card: SDK, and the estimate only when fallback days exist', async () => {
    const mixed = await sdkPage(days([80, null]));
    const mixedSource = mixed.query('#bh-panel .bh-source')[0]!.textContent;
    assert.ok(mixedSource.includes('laut SDK') && mixedSource.includes('aus Tokens geschätzt'));
    const pure = await sdkPage(days([80, 60]));
    const pureSource = pure.query('#bh-panel .bh-source')[0]!.textContent;
    assert.ok(pureSource.includes('laut SDK'));
    assert.ok(!pureSource.includes('aus Tokens geschätzt'));
    assert.equal(pure.query('#bh-chart .bh-bar.is-estimate').length, 0);
  });

  it('names the highest peak of the period in the text line and keeps the hit sentence', async () => {
    const page = await sdkPage(days([30, 101, 60, 101]), {});
    const text = page.query('#bh-panel .bh-text')[0]!.textContent;
    assert.ok(text.startsWith('Höchste Spitze laut SDK: 101 %'), text);
    assert.ok(text.includes('Kein Limit-Treffer in diesem Zeitraum.'));
  });

  it('shows the token description without peak_source and keeps the token view', async () => {
    const page = await load({ budget: budget(days([null, null, null], 500)), budget_insights: insights({ peak_source: 'tokens' }) });
    assert.ok(page.query('#bh-panel .bh-source')[0]!.textContent.includes('aus Tokens geschätzt'));
    assert.ok(!page.query('#bh-panel .bh-source')[0]!.textContent.includes('laut SDK'));
    assert.equal(page.query('#bh-chart .bh-bar.is-estimate').length, 0);
    assert.equal(page.query('#bh-chart .bh-pct')[0]!.textContent, '50 %');
    assert.ok(!page.query('#bh-panel .bh-text')[0]!.textContent.includes('Höchste Spitze'));
  });

  it('still shows the empty state when neither tokens, hits nor percent exist', async () => {
    const page = await sdkPage(days([null, null], 0));
    assert.ok(page.query('[data-body="budget-bars"]')[0]!.textContent.includes('Noch keine Budget-Daten'));
  });

  it('leaves the older chart (data-body budget) in place with percent fields on the days', async () => {
    const page = await sdkPage(days([80, 60, 40]));
    assert.ok(page.query('[data-body="budget"] svg').length > 0);
  });
});
