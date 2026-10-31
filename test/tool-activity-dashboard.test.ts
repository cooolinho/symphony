import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { renderPage, until } from './helpers.ts';
import { dashboardState } from './helpers/page-fixtures.ts';

const ev = (at: string, role: string, issue = 'acme/app#1') => ({ at, role, issue });
const fixture = (events: unknown[]) => ({ generated_at: '2026-10-30T12:00:00.000Z', minutes: 30, since: '2026-10-30T11:30:00.000Z', events });
const THREE = fixture([ev('2026-10-30T11:45:10.000Z', 'developer'), ev('2026-10-30T11:45:40.000Z', 'developer'), ev('2026-10-30T11:50:00.000Z', 'reviewer')]);
const load = (data: unknown) => renderPage(DASHBOARD_HTML, dashboardState(), { fetch: (url) => (url.startsWith('/api/v1/activity') ? data : dashboardState()) });
const bars = (page: ReturnType<typeof renderPage>) => page.query('#tool-activity-strip span.act-bar');

describe('activity strip on the overview', () => {
  it('draws one bar per call, positioned by time and coloured by role', async () => {
    const page = load(THREE);
    await until(() => bars(page).length === 3, 3_000, 'bars');
    assert.deepEqual(bars(page).map((b) => b.style.left), ['50.56%', '52.22%', '66.67%']);
    assert.equal(bars(page)[0]!.style.background, '#34d399');
    assert.equal(bars(page)[2]!.style.background, '#f472b6');
  });

  it('lists the roles in the legend and removes the empty text', async () => {
    const page = load(THREE);
    await until(() => bars(page).length === 3, 3_000, 'bars');
    const names = page.query('#tool-activity-legend .act-key').map((k) => k.textContent);
    assert.ok(names.includes('Developer') && names.includes('Reviewer'), names.join());
    assert.equal(page.query('#tool-activity-strip .act-empty').length, 0);
  });

  it('shows the empty text without events', async () => {
    const page = load(fixture([]));
    await until(() => page.fetches.some((f) => f.url.startsWith('/api/v1/activity')), 3_000, 'fetch');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(page.query('#tool-activity-strip .act-empty')[0]!.textContent, 'Keine Tool-Aufrufe in den letzten 30 Minuten');
    assert.equal(bars(page).length, 0);
  });

  it('reloads every 30 s and keeps the bars when a reload fails', async () => {
    let fail = false;
    const page = renderPage(DASHBOARD_HTML, dashboardState(), {
      fetch: (url) => {
        if (!url.startsWith('/api/v1/activity')) return dashboardState();
        if (fail) throw new Error('down');
        return THREE;
      },
    });
    await until(() => bars(page).length === 3, 3_000, 'bars');
    const poll = page.intervals.find((i) => i.ms === 30_000 && i.fn.name === 'loadToolActivity');
    assert.ok(poll, 'a 30 s interval loads the strip');
    const count = () => page.fetches.filter((f) => f.url.startsWith('/api/v1/activity')).length;
    const before = count();
    fail = true;
    await poll.fn();
    assert.equal(count(), before + 1);
    assert.equal(bars(page).length, 3);
  });

  it('inserts role names as text and falls back to the symphony colour', async () => {
    const page = load(fixture([ev('2026-10-30T11:50:00.000Z', '<img src=x>')]));
    await until(() => bars(page).length === 1, 3_000, 'bar');
    assert.equal(bars(page)[0]!.style.background, '#94a3b8');
    assert.ok(page.query('#tool-activity-legend .act-key').some((k) => k.textContent === '<img src=x>'));
    assert.equal(page.query('#tool-activity img').length, 0);
  });
});
