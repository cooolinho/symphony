import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { TASKS_HTML } from '../src/http/tasks-page.ts';
import { renderPage, until } from './helpers.ts';
import { dashboardState } from './helpers/page-fixtures.ts';

// E4-5 (#357): the budget loader reloads the chip and the overview section every 30 s, and a slow older answer
// must not overwrite a newer one. Fires the recorded 30 s interval by hand (the harness never fires timers).

const win = (used: number, limit: number | null, extra: Record<string, unknown> = {}) => ({
  window: 'five_hour',
  used_tokens: used,
  burn_rate_per_min: 1000,
  resets_at: '2026-10-30T15:30:00.000Z',
  forecast: limit === null ? null : { limit_tokens: limit, limit_source: 'observed', eta: null },
  alert: false,
  by_role: {},
  ...extra,
});
const report = (used: number, limit: number | null, extra: Record<string, unknown> = {}) => ({
  five_hour: win(used, limit, extra),
  seven_day: { ...win(3_000_000, 30_000_000), window: 'seven_day' },
  generated_at: '2026-10-30T12:00:00.000Z',
});

const settle = () => new Promise((r) => setTimeout(r, 30));
const chipOf = (page: ReturnType<typeof renderPage>) => ({ text: page.$('shell-budget').textContent.trim(), cls: page.$('shell-budget').className });
const budgetFetches = (page: ReturnType<typeof renderPage>) => page.fetches.filter((f) => f.url === '/api/v1/budget').length;

async function fire(page: ReturnType<typeof renderPage>) {
  const timer = page.intervals.find((i) => i.ms === 30_000);
  assert.ok(timer, 'a 30 s interval is registered');
  const before = budgetFetches(page);
  timer.fn();
  await until(() => budgetFetches(page) > before, 3_000, 'reload fetch');
  await settle();
}

describe('E4-5 budget reload', () => {
  it('the chip follows new answers on every 30 s tick', async () => {
    const answers = [report(1_240_000, 2_000_000), report(1_700_000, 2_000_000), report(1_700_000, 2_000_000, { alert: true })];
    let n = 0;
    const page = renderPage(TASKS_HTML, undefined, { fetch: (u) => (u === '/api/v1/budget' ? answers[Math.min(n++, answers.length - 1)] : {}) });
    await until(() => budgetFetches(page) === 1);
    await settle();
    assert.equal(chipOf(page).text, '5 h 62 %');
    assert.doesNotMatch(chipOf(page).cls, /amber|red/);
    await fire(page);
    assert.equal(chipOf(page).text, '5 h 85 %');
    assert.match(chipOf(page).cls, /amber/);
    await fire(page);
    assert.match(chipOf(page).cls, /red/);
  });

  it('the chip falls back to "5 h —" when a reload fails and recovers on the next one', async () => {
    let mode: 'ok' | 'fail' = 'ok';
    const page = renderPage(TASKS_HTML, undefined, {
      fetch: (u) => {
        if (u !== '/api/v1/budget') return {};
        if (mode === 'fail') throw new Error('offline');
        return report(1_240_000, 2_000_000);
      },
    });
    await until(() => budgetFetches(page) === 1);
    await settle();
    assert.equal(chipOf(page).text, '5 h 62 %');
    mode = 'fail';
    await fire(page);
    assert.equal(chipOf(page).text, '5 h —');
    assert.doesNotMatch(chipOf(page).cls, /amber|red/);
    mode = 'ok';
    await fire(page);
    assert.equal(chipOf(page).text, '5 h 62 %');
  });

  it('a slow older answer does not overwrite a newer one', async () => {
    let release: (v: unknown) => void = () => {};
    let n = 0;
    const page = renderPage(TASKS_HTML, undefined, {
      fetch: (u) => {
        if (u !== '/api/v1/budget') return {};
        n++;
        if (n === 1) return new Promise((resolve) => (release = resolve)); // the first load hangs
        return report(1_700_000, 2_000_000); // the reload answers right away: 85 %
      },
    });
    await until(() => budgetFetches(page) === 1);
    await fire(page);
    assert.equal(chipOf(page).text, '5 h 85 %');
    release(report(200_000, 2_000_000)); // the old answer (10 %) arrives late
    await settle();
    assert.equal(chipOf(page).text, '5 h 85 %');
  });

  it('the overview section is redrawn from the new answer and does not fetch the budget twice per tick', async () => {
    let n = 0;
    const page = renderPage(DASHBOARD_HTML, dashboardState(), {
      fetch: (u) => {
        if (u === '/api/v1/budget') return n++ === 0 ? report(1_240_000, 2_000_000) : report(1_700_000, 2_000_000);
        if (u === '/api/v1/state') return dashboardState();
        if (u === '/api/v1/history') return { recent: [] };
        return {};
      },
    });
    await until(() => budgetFetches(page) >= 1);
    await settle();
    const bars = () => page.query('[role=progressbar]').map((b) => b.getAttribute('aria-valuenow'));
    const first = bars().join(',');
    assert.match(first, /6[23]/);
    const before = budgetFetches(page);
    await fire(page);
    assert.match(bars().join(','), /85/);
    assert.notEqual(bars().join(','), first);
    assert.equal(budgetFetches(page) - before, 1, 'one budget fetch per tick');
  });
});
