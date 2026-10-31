import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { ALERTS_JS } from '../src/http/alerts.ts';
import { HEAD_JS } from '../src/http/overview-head.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { FakeElement, scriptContext, run } from './helpers/fake-dom.ts';
import { renderPage } from './helpers.ts';
import { dashboardState } from './helpers/page-fixtures.ts';

// E2-8 (#383): title block of the overview.
const NOW = Date.parse('2026-10-31T12:00:00Z');
const ctx = scriptContext(BASE_JS, ALERTS_JS, HEAD_JS);
const call = (expr: string, state: unknown, now = NOW) => { ctx.__s = state; ctx.__n = now; return run(ctx, expr); };
const sub = (state: unknown, now = NOW): string => call('headSubtitle(__s, __n)', state, now);
const chips = (state: unknown): FakeElement[] => Array.from(call('headChips(__s)', state));
const running = (n: number) => Array.from({ length: n }, (_, i) => ({ issue_identifier: 'a#' + i, running: { role: 'developer' } }));
const next = (n: number) => Array.from({ length: n }, () => ({ status: 'next' }));
const tick = (s: number) => ({ last_tick_at: new Date(NOW - s * 1000).toISOString() });

describe('headSubtitle', () => {
  it('uses plural for 0 and 2+, singular for 1', () => {
    assert.equal(sub({ issues: [], queue: [], health: tick(12) }), '0 Teams spielen · 0 warten auf einen Slot · letzter Poll vor 12 s');
    assert.equal(sub({ issues: running(1), queue: next(1), health: tick(3) }), '1 Team spielt · 1 wartet auf einen Slot · letzter Poll vor 3 s');
    assert.equal(sub({ issues: running(2), queue: next(3), health: tick(0) }), '2 Teams spielen · 3 warten auf einen Slot · letzter Poll vor 0 s');
  });

  it('counts only running issues and queue entries with status next', () => {
    const q = [{ status: 'next' }, { status: 'waiting' }, { status: 'paused' }];
    assert.match(sub({ issues: [...running(1), { issue_identifier: 'x#9', running: null }], queue: q, health: tick(1) }), /^1 Team spielt · 1 wartet/);
  });

  it('says "noch kein Poll" without a poll', () => {
    assert.match(sub({ issues: [], queue: [], health: {} }), / · noch kein Poll$/);
    assert.match(sub({}), / · noch kein Poll$/);
  });
});

describe('headChips', () => {
  const text = (c: FakeElement) => c.textContent;
  it('shows Tracker ok and Workflow gültig in green with a dot, and no clash chip', () => {
    const list = chips({ health: { workflow_version: 3 } });
    assert.deepEqual(list.map(text), ['Tracker ok', 'Workflow gültig']);
    for (const c of list) assert.equal(c.querySelectorAll('.ui-dot').length, 1);
    assert.equal(list[0]!.style.color, list[1]!.style.color);
    assert.equal(list[1]!.title, 'v3');
  });

  it('turns red on a tracker or workflow error and carries the message as tooltip', () => {
    const list = chips({ health: { last_tracker_error: { at: 'x', message: 'tracker down' }, workflow_error: { message: 'wf broken' } } });
    assert.deepEqual(list.map(text), ['Tracker Fehler', 'Workflow ungültig']);
    assert.equal(list[0]!.title, 'tracker down');
    assert.equal(list[1]!.title, 'wf broken');
    const ok = chips({ health: {} });
    assert.notEqual(list[0]!.style.color, ok[0]!.style.color);
  });

  it('shows the write-clash chip in amber only for open clashes', () => {
    const clash = (status: string) => ({ id: status, path: 'a.md', status, at: ['2026-10-31T11:00:00Z', '2026-10-31T11:03:00Z'] });
    assert.equal(chips({ health: {} }).length, 2);
    assert.equal(chips({ health: {}, brain_clashes: [clash('resolved')] }).length, 2);
    const one = chips({ health: {}, brain_clashes: [clash('open'), clash('resolved')] });
    assert.equal(one.length, 3);
    assert.equal(text(one[2]!), '1 Write-Clash');
    assert.equal(text(chips({ health: {}, brain_clashes: [clash('open'), clash('open')] })[2]!), '2 Write-Clashes');
    assert.equal(one[2]!.querySelectorAll('.ui-dot').length, 1);
    assert.notEqual(one[2]!.style.color, one[0]!.style.color);
  });
});

describe('title block on the page', () => {
  it('has exactly one h1 "Übersicht", subtitle, chips and the Jetzt-pollen button; the sysinfo list is gone', () => {
    const page = renderPage(DASHBOARD_HTML, dashboardState());
    const h1 = page.query('h1');
    assert.equal(h1.length, 1);
    assert.equal(h1[0]!.textContent, 'Übersicht');
    assert.match(page.$('ov-subtitle').textContent, /Teams? spiel.* · .* · (letzter Poll vor \d+ s|noch kein Poll)/);
    assert.match(page.$('ov-chips').textContent, /Tracker ok/);
    assert.match(DASHBOARD_HTML, /id="shell-poll"[^>]*aria-label="Jetzt pollen"/);
    assert.equal(page.query('dl.sysinfo').length, 0);
  });

  it('shows a notice and no chips when the state cannot be loaded', async () => {
    const page = renderPage(DASHBOARD_HTML, undefined, { fetch: () => { throw new Error('refused'); } });
    await new Promise((r) => setImmediate(r));
    assert.equal(page.$('ov-subtitle').textContent, 'Orchestrator nicht erreichbar');
    assert.equal(page.$('ov-chips').children.length, 0);
  });

  it('marks a stale poll in the subtitle', () => {
    const c = scriptContext(BASE_JS, ALERTS_JS, HEAD_JS);
    const sub = run(c, 'document.createElement("p")');
    sub.id = 'ov-subtitle';
    const box = run(c, 'document.createElement("div")');
    box.id = 'ov-chips';
    c.document.getElementById = (id: string) => (id === 'ov-subtitle' ? sub : box);
    c.s = { issues: [], queue: [], health: { ...tick(200), poll_interval_ms: 5000 } };
    c.n = NOW;
    run(c, 'renderHead(s, n, true)');
    assert.ok(sub.classList.contains('is-stale'));
    c.s = { issues: [], queue: [], health: { ...tick(10), poll_interval_ms: 5000 } };
    run(c, 'renderHead(s, n, true)');
    assert.ok(!sub.classList.contains('is-stale'));
  });
});
