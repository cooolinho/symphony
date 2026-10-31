import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALERTS_JS } from '../src/http/alerts.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { FakeElement, domContext, run } from './helpers/fake-dom.ts';

// E2-4a (#354): alerts panel on the overview.
const ctx = domContext(BASE_JS, ALERTS_JS);
const T = (hm: string) => `2026-10-31T${hm}:00Z`;

const state = {
  health: { dispatch_errors: [], last_tick_at: T('10:30'), last_tracker_error: { at: T('10:00'), message: 'boom' } },
  model_holds: [{ model: 'fable', source: 'limit', since: T('09:00'), until: T('12:00'), text: 'Session limit', issue_identifier: 'acme/app#3' }],
};
const budget = {
  generated_at: T('11:00'),
  five_hour: { alert: true, resets_at: T('13:00'), forecast: { eta: T('12:00'), limit_tokens: 1 } },
  seven_day: { alert: false, resets_at: null, forecast: null },
};
const list = (s: unknown, b: unknown): any[] => {
  ctx.__s = s;
  ctx.__b = b;
  return JSON.parse(JSON.stringify(run(ctx, 'alerts(__s, __b)')));
};
const render = (l: unknown) => {
  const host = new FakeElement('ul');
  const count = new FakeElement('span');
  ctx.__l = l;
  ctx.__h = host;
  ctx.__c = count;
  run(ctx, 'renderAlerts(__l, __h, __c)');
  return { host, count };
};

describe('alerts(state, budget)', () => {
  it('builds attention, hold and budget entries, newest first', () => {
    const l = list(state, budget);
    assert.deepEqual(l.map((a) => a.kind), ['budget', 'attention', 'model_hold']);
    assert.deepEqual(l.map((a) => a.href), ['/stats', '/stats', '/issue?id=acme%2Fapp%233']);
    for (const a of l) assert.ok(a.at && a.title && a.text);
  });

  it('reports needs-human once per issue, linked to the issue page', () => {
    const row = { issue_identifier: 'acme/app#12', title: 'Hilfe', labels: ['Needs-Human '], updated_at: T('08:00') };
    const l = list({ health: {}, blocked: [row], issues: [row] }, null);
    assert.equal(l.length, 1);
    assert.equal(l[0].kind, 'needs_human');
    assert.equal(l[0].href, '/issue?id=acme%2Fapp%2312');
  });

  it('copes with missing fields', () => {
    assert.deepEqual(list({ health: {} }, null), []);
    assert.deepEqual(list({ health: { dispatch_errors: [] } }, undefined), []);
  });
});

describe('renderAlerts', () => {
  it('shows count, kind label, relative time, title, text and link', () => {
    const { host, count } = render(list(state, budget));
    assert.equal(count.textContent, '3');
    assert.equal(host.children.length, 3);
    const hold = host.children[2]!;
    assert.equal(hold.querySelector('.alert-kind')!.textContent, 'Model-Hold');
    assert.equal(hold.querySelector('a')!.href, '/issue?id=acme%2Fapp%233');
    assert.match(hold.textContent, /fable pausiert · Limit bis \d\d:\d\d/);
    assert.match(hold.querySelector('.alert-time')!.textContent, /^vor \d+ (min|h|d)$|^gerade eben$/);
  });

  it('shows "Alles ruhig" with a green dot when empty', () => {
    const { host, count } = render(list({ health: { dispatch_errors: [] }, issues: [], blocked: [], model_holds: [] }, null));
    assert.equal(count.textContent, '0');
    assert.equal(host.children.length, 1);
    assert.ok(host.children[0]!.querySelector('.gi.alerts-empty'));
    assert.equal(host.children[0]!.textContent, 'Alles ruhig');
    assert.ok(host.querySelector('.dot.tone-green'));
  });

  it('agoDe formats German relative times', () => {
    const f = (a: string | null, b: string) => run(ctx, `agoDe(${JSON.stringify(a)}, ${Date.parse(b)})`);
    assert.equal(f(T('10:00'), T('10:05')), 'vor 5 min');
    assert.equal(f(T('10:00'), T('10:00')), 'gerade eben');
    assert.equal(f(T('10:00'), T('12:00')), 'vor 2 h');
    assert.equal(f('2026-10-28T10:00:00Z', T('10:00')), 'vor 3 d');
    assert.equal(f(null, T('10:00')), '—');
  });
});

describe('overview page', () => {
  it('has the panel, aria-live counter and German texts; old sections are gone', () => {
    assert.match(DASHBOARD_HTML, /<h2 class="lbl" id="alerts-title">Alerts<\/h2><span class="alerts-badge" id="alerts-count" aria-live="polite" hidden>/);
    assert.doesNotMatch(DASHBOARD_HTML, /id="problems"|id="model-holds"|Needs attention|model-hold-list/);
    assert.match(DASHBOARD_HTML, /id="model-controls"/);
    assert.match(DASHBOARD_HTML, /renderModelControls\(state\)/);
    for (const t of ['Alles ruhig', 'An dich übergeben', 'Limit in Sicht', 'pausiert', 'vor ']) assert.ok(ALERTS_JS.includes(t), t);
    assert.ok(!ALERTS_JS.includes('innerHTML'));
  });
});
