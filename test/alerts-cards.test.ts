import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALERTS_CSS, ALERTS_JS } from '../src/http/alerts.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { FakeElement, scriptContext, run } from './helpers/fake-dom.ts';
import { renderPage } from './helpers.ts';
import { dashboardState } from './helpers/page-fixtures.ts';

// E2-8 (#383): alert cards with coloured border and kind label.
const ctx = scriptContext(BASE_JS, ALERTS_JS);
const T = (hm: string) => `2026-10-31T${hm}:00Z`;
const clock = (iso: string): string => { const d = new Date(iso); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

const state = {
  health: { dispatch_errors: [], last_tick_at: T('10:30'), last_tracker_error: { at: T('10:00'), message: 'boom' } },
  brain_clashes: [
    { id: 'c1', path: 'notes/api.md', status: 'open', at: [T('09:00'), T('09:03')], roles: ['reviewer', 'developer'], issues: ['acme/app#4', 'acme/app#5'] },
    { id: 'c2', path: 'old.md', status: 'resolved', at: [T('08:00'), T('08:01')] },
  ],
  issues: [{ issue_identifier: 'acme/app#12', title: 'Hilfe', labels: ['needs-human'], updated_at: T('08:00'), review_rounds: 3 }],
  model_holds: [{ model: 'fable', source: 'limit', since: T('07:00'), until: T('12:00'), text: 'x', issue_identifier: 'acme/app#3' }],
};
const budget = { generated_at: T('11:00'), five_hour: { alert: true, resets_at: T('13:00'), forecast: { eta: T('12:00') } }, seven_day: { alert: false } };
const list = (s: unknown, b: unknown = null): any[] => { ctx.__s = s; ctx.__b = b; return JSON.parse(JSON.stringify(run(ctx, 'alerts(__s, __b)'))); };
const render = (l: unknown) => {
  const host = new FakeElement('ul');
  const badge = new FakeElement('span');
  ctx.__l = l; ctx.__h = host; ctx.__c = badge;
  run(ctx, 'renderAlerts(__l, __h, __c)');
  return { host, badge };
};

describe('alert cards', () => {
  const all = list(state, budget);
  const byKind = (k: string) => all.find((a) => a.kind === k);

  it('builds the five kinds, newest first, ignoring resolved clashes', () => {
    assert.deepEqual(all.map((a) => a.kind), ['budget', 'attention', 'clash', 'needs_human', 'model_hold']);
  });

  it('writes the texts of the issue', () => {
    assert.equal(byKind('clash').text, 'Developer (#5) wollte 3 min nach Reviewer (#4) schreiben – abgewiesen, Hash passt nicht. Beide Fassungen prüfen.');
    assert.equal(byKind('clash').title, 'notes/api.md');
    assert.equal(byKind('budget').text, `Beim aktuellen Verbrauch ist das Limit gegen ${clock(T('12:00'))} erreicht, Reset um ${clock(T('13:00'))}.`);
    assert.equal(byKind('needs_human').text, 'Nach 3 Review-Runden an dich übergeben.');
    assert.equal(byKind('model_hold').text, `fable pausiert · Limit bis ${clock(T('12:00'))}`);
  });

  it('needs-human text copes with 1 and without review rounds', () => {
    const row = (n: unknown) => ({ health: {}, issues: [{ issue_identifier: 'a#1', title: 't', labels: ['needs-human'], review_rounds: n }] });
    assert.equal(list(row(1))[0].text, 'Nach 1 Review-Runde an dich übergeben.');
    assert.equal(list(row(null))[0].text, 'An dich übergeben.');
    assert.equal(list(row(undefined))[0].text, 'An dich übergeben.');
  });

  it('links each kind to its target', () => {
    assert.deepEqual(
      Object.fromEntries(all.map((a) => [a.kind, a.href])),
      { budget: '/stats', attention: '/stats', clash: '/brain', needs_human: '/issue?id=acme%2Fapp%2312', model_hold: '/issue?id=acme%2Fapp%233' },
    );
  });

  it('renders a link card .gi per alert with label, time, title and text; red for clash/attention, amber for the rest', () => {
    const { host } = render(all);
    const cards = host.querySelectorAll('a.gi.alert');
    assert.equal(cards.length, 5);
    const expect: Record<string, [string, string]> = {
      clash: ['Write-Clash', 'alert-red'], attention: ['Fehler', 'alert-red'],
      budget: ['Limit-Prognose', 'alert-amber'], needs_human: ['needs-human', 'alert-amber'], model_hold: ['Model-Hold', 'alert-amber'],
    };
    all.forEach((a, i) => {
      const card = cards[i]!;
      assert.equal(card.querySelector('.alert-kind')!.textContent, expect[a.kind]![0]);
      assert.ok(card.classList.contains(expect[a.kind]![1]), a.kind);
      assert.ok(card.querySelector('.lbl'));
      assert.ok(card.querySelector('.alert-time'));
      assert.equal(card.querySelector('.alert-title')!.textContent, a.title);
      assert.equal(card.querySelector('.alert-text')!.textContent, a.text);
      assert.equal(card.getAttribute('href'), a.href);
    });
  });

  it('has the border and label colours of the issue in the CSS', () => {
    const css = ALERTS_CSS.replace(/\s+/g, '');
    for (const v of ['rgba(248,113,113,0.4)', 'rgba(251,191,36,0.35)', '#fca5a5', '#fcd34d', 'rgba(248,113,113,0.2)', '#fecaca', 'padding:12px14px', 'flex:11340px']) {
      assert.ok(css.includes(v), v);
    }
  });
});

describe('alerts badge and empty state', () => {
  it('shows the number in the badge and hides it at 0', () => {
    const { badge } = render(list(state, budget));
    assert.equal(badge.textContent, '5');
    assert.equal(badge.hidden, false);
    const none = render([]);
    assert.equal(none.badge.textContent, '0');
    assert.equal(none.badge.hidden, true);
  });

  it('shows one calm card with a green dot', () => {
    const { host } = render([]);
    assert.equal(host.children.length, 1);
    assert.ok(host.querySelector('.gi.alerts-empty'));
    assert.ok(host.querySelector('.dot.tone-green'));
    assert.equal(host.textContent, 'Alles ruhig');
  });
});

describe('alerts and budget on the page', () => {
  it('sit in one wrapping row; the alerts panel grows from 340 px', () => {
    const page = renderPage(DASHBOARD_HTML, dashboardState());
    const row = page.query('.ov-row')[0]!;
    assert.deepEqual([...row.children].map((c) => c.id), ['alerts', 'budget']);
    assert.match(DASHBOARD_HTML, /\.ov-row \{[^}]*flex-wrap: wrap/);
    assert.match(DASHBOARD_HTML, /#alerts \{ flex: 1 1 340px/);
    assert.equal(page.$('alerts-title').textContent, 'Alerts');
  });

  it('shows a clash card and the clash chip once the state carries brain_clashes', () => {
    const page = renderPage(DASHBOARD_HTML, dashboardState());
    page.render(dashboardState({ brain_clashes: state.brain_clashes }));
    assert.equal(page.$('alerts-count').textContent, '1');
    assert.match(page.$('alerts-list').textContent, /Write-Clash/);
    assert.match(page.$('ov-chips').textContent, /1 Write-Clash/);
  });
});
