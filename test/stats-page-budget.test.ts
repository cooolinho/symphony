import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { renderPage, until } from './helpers.ts';
import { analyticsFixture, entriesFixture } from './helpers/page-fixtures.ts';

// E9-2 (#371): budget history on the statistics page.
const developer = { ...analyticsFixture().by_role[0], role: 'developer' };
const days = [
  { date: '2026-10-29', peak_5h_tokens: 0, limit_hits: 0 },
  { date: '2026-10-30', peak_5h_tokens: 1500, limit_hits: 1 },
];
const load = async (budget?: object) => {
  const over: Record<string, unknown> = { by_role: [developer] };
  if (budget !== undefined) over.budget = budget;
  const page = renderPage(LOGS_HTML, undefined, {
    url: 'http://127.0.0.1/stats',
    fetch: (url: string) => (url.startsWith('/api/v1/history/entries') ? entriesFixture() : analyticsFixture(over)),
  });
  await until(() => page.$('log-count').textContent === '1' && page.query('[data-body="kpi"] .ui-kpi').length > 0, 3000, 'the page to load');
  return page;
};
const contextCell = (page: Awaited<ReturnType<typeof load>>) => {
  const index = page.query('#roles-table th').findIndex((th) => th.textContent === 'Ø Context');
  assert.ok(index >= 0, 'column Ø Context');
  return page.query('#roles-table tr')[1]!.children[index]!.textContent;
};

describe('statistics page: budget history', () => {
  it('marks the day with a limit hit in red and describes the chart', async () => {
    const page = await load({ days, compacts_by_role: {}, avg_context_by_role: {} });
    const marks = page.query('[data-body="budget"] [data-mark]');
    assert.equal(marks.length, 1);
    assert.equal(marks[0]!.getAttribute('data-mark'), '1');
    assert.match(marks[0]!.getAttribute('style') ?? '', /var\(--red\)/);
    assert.ok(page.root.textContent.includes('5-h-Spitze je Tag'));
    assert.match(page.query('[data-body="budget"] svg')[0]!.getAttribute('aria-label') ?? '', /5-h-Spitze je Tag/);
  });

  it('draws the auto-compacts per role in the role color', async () => {
    const page = await load({ days, compacts_by_role: { developer: 3 }, avg_context_by_role: {} });
    const bar = page.query('[data-body="compacts"] .hbar')[0]!;
    assert.ok(bar.textContent.includes('developer') && bar.textContent.includes('3'));
    assert.match(bar.querySelector('.fill')!.style.getPropertyValue('--sw'), /var\(--role-developer\)/);
  });

  it('shows the average context in percent, or a dash without data', async () => {
    assert.equal(contextCell(await load({ days, compacts_by_role: {}, avg_context_by_role: {} })), '—');
    assert.equal(contextCell(await load({ days, compacts_by_role: {}, avg_context_by_role: { developer: 40 } })), '40%');
  });

  it('shows "keine Daten" without usage, hits and compacts, and survives an answer without budget', async () => {
    const empty = await load({ days: [{ date: '2026-10-30', peak_5h_tokens: 0, limit_hits: 0 }], compacts_by_role: {}, avg_context_by_role: {} });
    assert.ok(empty.query('[data-body="budget"]')[0]!.textContent.includes('KEINE DATEN'));
    assert.ok(empty.query('[data-body="compacts"]')[0]!.textContent.includes('KEINE DATEN'));
    const none = await load();
    assert.ok(none.query('[data-body="budget"]')[0]!.textContent.includes('KEINE DATEN'));
    assert.equal(contextCell(none), '—');
    assert.ok(none.query('#roles-table tr').length > 1);
  });
});
