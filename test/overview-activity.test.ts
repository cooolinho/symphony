import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ACTIVITY_CSS, ACTIVITY_JS } from '../src/http/overview-activity.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { FakeElement, scriptContext, run } from './helpers/fake-dom.ts';
import { renderPage } from './helpers.ts';
import { dashboardState } from './helpers/page-fixtures.ts';

// E2-8 (#383): activity strip with legend and time axis.
const ctx = scriptContext(BASE_JS, ACTIVITY_JS);
const data = (events: unknown[]) => ({ generated_at: '2026-10-31T12:00:00Z', since: '2026-10-31T11:30:00Z', minutes: 30, events });
const ev = (at: string, role = 'developer', extra: Record<string, unknown> = {}) => ({ at, role, issue: 'acme/app#1', ...extra });
const strip = (d: unknown) => {
  const host = new FakeElement('div');
  ctx.__d = d; ctx.__h = host;
  run(ctx, 'renderActivityStrip(__h, __d)');
  return host;
};
const bars = (h: FakeElement) => h.querySelectorAll('span.act-bar');

describe('activity strip', () => {
  it('positions a bar by its timestamp', () => {
    const h = strip(data([ev('2026-10-31T11:45:00Z'), ev('2026-10-31T11:30:00Z'), ev('2026-10-31T12:00:00Z')]));
    assert.deepEqual(bars(h).map((b) => b.style.left), ['50.00%', '0.00%', '100.00%']);
  });

  it('colours a bar by role; unknown roles get the symphony colour', () => {
    const h = strip(data([ev('2026-10-31T11:45:00Z', 'developer'), ev('2026-10-31T11:46:00Z', 'reviewer'), ev('2026-10-31T11:47:00Z', 'zzz')]));
    assert.deepEqual(bars(h).map((b) => b.style.background), ['#34d399', '#f472b6', '#94a3b8']);
  });

  it('takes the height from the tool duration, 20 px by default, within 8–42 px', () => {
    const at = '2026-10-31T11:45:00Z';
    const h = strip(data([ev(at), ev(at, 'developer', { duration_ms: 0 }), ev(at, 'developer', { duration_ms: 10000 }), ev(at, 'developer', { duration_ms: 999999 })]));
    assert.deepEqual(bars(h).map((b) => b.style.height), ['20px', '8px', '18px', '42px']);
  });

  it('skips events with an invalid timestamp', () => {
    assert.equal(bars(strip(data([ev('nope'), ev('2026-10-31T11:45:00Z')]))).length, 1);
  });

  it('shows the empty text instead of bars without events', () => {
    for (const d of [data([]), null, {}]) {
      const h = strip(d);
      assert.equal(bars(h).length, 0);
      assert.equal(h.children.length, 1);
      assert.equal(h.querySelector('.act-empty')!.textContent, 'Keine Tool-Aufrufe in den letzten 30 Minuten');
    }
  });

  it('thins 1000 calls to 400 bars evenly, keeping the oldest, within 50 ms', () => {
    const events = Array.from({ length: 1000 }, (_, i) => ev(new Date(Date.parse('2026-10-31T11:30:00Z') + i * 1799).toISOString()));
    const t0 = performance.now();
    const h = strip(data(events));
    assert.ok(performance.now() - t0 < 50, 'rendering stays under 50 ms');
    const list = bars(h);
    assert.equal(list.length, 400);
    assert.equal(list[0]!.style.left, '0.00%');
    ctx.__e = data(events);
    const thinned = Array.from(run(ctx, 'actBars(__e)')) as { left: number }[];
    const left = (i: number) => (Date.parse(events[Math.floor((i * 1000) / 400)]!.at) - Date.parse('2026-10-31T11:30:00Z')) / 18e3;
    for (const i of [0, 1, 199, 399]) assert.ok(Math.abs(thinned[i]!.left - left(i)) < 1e-6, String(i));
    assert.equal(bars(strip(data(events.slice(0, 400)))).length, 400);
  });
});

describe('activity legend', () => {
  const legend = (roles: string[]) => {
    const host = new FakeElement('div');
    ctx.__h = host; ctx.__r = roles;
    run(ctx, 'renderActivityLegend(__h, __r)');
    return host;
  };
  it('lists every role of the profile with a dot and its name', () => {
    const keys = legend(['analyst', 'developer', 'reviewer']).querySelectorAll('.act-key');
    assert.deepEqual(keys.map((k) => k.textContent), ['Analyst', 'Developer', 'Reviewer']);
    for (const k of keys) assert.equal(k.querySelectorAll('.ui-dot').length, 1);
  });

  it('adds roles seen in events but missing from the profile, once, after the profile roles', () => {
    ctx.__s = { pipeline_config: { roles: [{ name: 'analyst' }, { name: 'developer' }] } };
    ctx.__e = [ev('x', 'tester'), ev('x', 'developer'), ev('x', 'tester')];
    assert.deepEqual(Array.from(run(ctx, 'actRoles(__s, __e)')), ['analyst', 'developer', 'tester']);
    assert.deepEqual(Array.from(run(ctx, 'actRoles(null, [])')), []);
  });

  it('writes role names as text', () => {
    const host = legend(['<img src=x>']);
    assert.equal(host.querySelectorAll('.act-key')[0]!.textContent, '<img src=x>');
    assert.equal(host.querySelectorAll('img').length, 0);
  });
});

describe('activity panel on the page', () => {
  it('has the heading, legend, img strip with aria-label and the four axis labels', () => {
    const page = renderPage(DASHBOARD_HTML, dashboardState());
    assert.equal(page.$('tool-activity-title').textContent, 'Agent-Aktivität · letzte 30 min');
    const s = page.$('tool-activity-strip');
    assert.equal(s.getAttribute('role'), 'img');
    assert.equal(s.getAttribute('aria-label'), 'Tool-Aufrufe der letzten 30 Minuten, farbig je Rolle');
    const axis = page.query('#tool-activity .act-axis')[0]!;
    assert.deepEqual(axis.children.map((c) => c.textContent), ['−30 min', '−20 min', '−10 min', 'jetzt']);
    assert.equal(axis.getAttribute('aria-hidden'), 'true');
    for (const v of ['height: 54px', 'width: 3px', 'justify-content: space-between', 'rgba(255, 255, 255, .1)', 'bottom: 0', 'flex-wrap: wrap']) assert.ok(ACTIVITY_CSS.includes(v), v);
  });

  it('shows the legend of the profile roles even without activity', () => {
    const page = renderPage(DASHBOARD_HTML, dashboardState());
    page.render(dashboardState({ pipeline_config: { roles: [{ name: 'analyst' }, { name: 'developer' }, { name: 'reviewer' }] } }));
    assert.deepEqual(page.query('#tool-activity-legend .act-key').map((k) => k.textContent), ['Analyst', 'Developer', 'Reviewer']);
  });
});
