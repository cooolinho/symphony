import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { renderPage, until } from './helpers.ts';
import { analyticsFixture, entriesFixture } from './helpers/page-fixtures.ts';

// E9-3 (#392): role table with average context and compacts.
const base = analyticsFixture().by_role[0];
const roles = [
  { ...base, role: 'reviewer', total_tokens: 1000 },
  { ...base, role: 'developer', total_tokens: 9000 },
  { ...base, role: 'tester', total_tokens: 5000 },
];
const load = async (budget?: object) => {
  const over: Record<string, unknown> = { by_role: roles };
  if (budget) over.budget = budget;
  const page = renderPage(LOGS_HTML, undefined, {
    url: 'http://127.0.0.1/stats',
    fetch: (u: string) => (u.startsWith('/api/v1/history/entries') ? entriesFixture() : analyticsFixture(over)),
  });
  await until(() => page.$('log-count').textContent === '1' && page.query('#role-summary tr').length > 1, 3000, 'the page to load');
  return page;
};
const rows = (page: Awaited<ReturnType<typeof load>>) => page.query('#role-summary tr').slice(1);

describe('statistics page: role table', () => {
  it('has the columns, sorts by tokens and colors the dot by role', async () => {
    const page = await load();
    assert.deepEqual(page.query('#role-summary th').map((t) => t.textContent), ['Rolle', 'Runs', 'Tokens', 'Kosten', 'Ø Context', 'Compacts']);
    assert.deepEqual(rows(page).map((r) => r.children[0]!.textContent), ['developer', 'tester', 'reviewer']);
    assert.match(rows(page)[0]!.querySelector('.rs-dot')!.style.background as string, /var\(--role-developer\)/);
  });

  it('marks the average context amber from 60 %, shows a dash without snapshots and the compacts', async () => {
    const page = await load({ days: [], compacts_by_role: { developer: 4 }, avg_context_by_role: { developer: 65, tester: 40 } });
    const [dev, tester, reviewer] = rows(page);
    assert.equal(dev!.children[4]!.textContent, '65 %');
    assert.ok(dev!.querySelector('.rs-ctx')!.classList.contains('is-high'));
    assert.equal(tester!.children[4]!.textContent, '40 %');
    assert.ok(!tester!.querySelector('.rs-ctx')!.classList.contains('is-high'));
    assert.equal(reviewer!.children[4]!.textContent, '—');
    assert.equal(dev!.children[5]!.textContent, '4');
    assert.equal(tester!.children[5]!.textContent, '—');
  });

  it('keeps the old roles table', async () => {
    const page = await load({ days: [], compacts_by_role: {}, avg_context_by_role: { developer: 40 } });
    assert.ok(page.query('#roles-table tr').length > 1);
    assert.ok(page.query('#roles-table td').some((td) => td.textContent === '40%'));
  });
});
