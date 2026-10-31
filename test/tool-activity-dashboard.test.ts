import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { renderPage, until } from './helpers.ts';
import { dashboardState } from './helpers/page-fixtures.ts';

const ev = (at: string, role: string, issue = 'acme/app#1') => ({ at, role, issue });
const fixture = (events: unknown[]) => ({ generated_at: '2026-10-30T12:00:00.000Z', minutes: 30, since: '2026-10-30T11:30:00.000Z', events });
const THREE = fixture([ev('2026-10-30T11:45:10.000Z', 'developer'), ev('2026-10-30T11:45:40.000Z', 'developer'), ev('2026-10-30T11:50:00.000Z', 'reviewer')]);
const load = (data: unknown) => renderPage(DASHBOARD_HTML, dashboardState(), { fetch: (url) => (url.startsWith('/api/v1/activity') ? data : dashboardState()) });
const ticks = (page: ReturnType<typeof renderPage>) => page.query('line.act-tick');

describe('tool call chart on the overview', () => {
  it('draws one tick per call with the role class; same-minute ticks are offset', async () => {
    const page = load(THREE);
    await until(() => ticks(page).length === 3, 3_000, 'ticks');
    const cls = (t: { className: string }) => t.className;
    assert.equal(ticks(page).filter((t) => cls(t).includes('role-developer')).length, 2);
    assert.equal(ticks(page).filter((t) => cls(t).includes('role-reviewer')).length, 1);
    const dev = ticks(page).filter((t) => cls(t).includes('role-developer'));
    assert.notEqual(dev[0]!.getAttribute('x1'), dev[1]!.getAttribute('x1'));
  });

  it('lists each role in the legend and summarises the numbers in the aria-label', async () => {
    const page = load(THREE);
    await until(() => ticks(page).length === 3, 3_000, 'ticks');
    assert.deepEqual(page.query('#tool-activity-legend .act-key').map((k) => k.textContent), ['Developer 2', 'Reviewer 1']);
    const label = page.$('tool-activity-chart').getAttribute('aria-label') ?? '';
    for (const part of ['3 tool calls in 30 minutes', 'Developer 2', 'Reviewer 1']) assert.ok(label.includes(part), label);
    assert.equal(page.$('tool-activity-empty').hidden, true);
  });

  it('shows the empty text without events', async () => {
    const page = load(fixture([]));
    await until(() => page.fetches.some((f) => f.url.startsWith('/api/v1/activity')), 3_000, 'fetch');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(page.$('tool-activity-empty').hidden, false);
    assert.equal(page.$('tool-activity-empty').textContent, 'No activity in the last 30 minutes.');
    assert.equal(ticks(page).length, 0);
    assert.equal(page.query('#tool-activity-legend .act-key').length, 0);
  });

  it('reloads every 30 s and keeps the ticks when a reload fails', async () => {
    let fail = false;
    const page = renderPage(DASHBOARD_HTML, dashboardState(), {
      fetch: (url) => {
        if (!url.startsWith('/api/v1/activity')) return dashboardState();
        if (fail) throw new Error('down');
        return THREE;
      },
    });
    await until(() => ticks(page).length === 3, 3_000, 'ticks');
    const poll = page.intervals.find((i) => i.ms === 30_000 && i.fn.name === 'loadToolActivity');
    assert.ok(poll, 'a 30 s interval loads the chart');
    const count = () => page.fetches.filter((f) => f.url.startsWith('/api/v1/activity')).length;
    const before = count();
    fail = true;
    await poll.fn();
    assert.equal(count(), before + 1);
    assert.equal(ticks(page).length, 3);
  });

  it('inserts role names as text and falls back to the symphony colour class', async () => {
    const page = load(fixture([ev('2026-10-30T11:50:00.000Z', '<img src=x>')]));
    await until(() => ticks(page).length === 1, 3_000, 'tick');
    assert.ok(ticks(page)[0]!.className.includes('role-symphony'));
    assert.equal(page.query('#tool-activity-legend .act-key')[0]!.textContent, '<img src=x> 1');
  });
});
