import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import type { FakeElement } from './helpers/fake-dom.ts';
import { renderPage, until } from './helpers.ts';
import { dashboardState, issueRow } from './helpers/page-fixtures.ts';

// E2-8 (#383), independent acceptance tests derived from the issue text: title block, alerts panel, activity strip.
// Everything goes through the rendered overview page (fake DOM, frozen clock 2026-10-30T12:00:00Z) and its CSS.
const NOW = Date.parse('2026-10-30T12:00:00Z');
const iso = (offsetSeconds: number): string => new Date(NOW + offsetSeconds * 1000).toISOString();
const clock = (t: string): string => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const css = DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf('<style'), DASHBOARD_HTML.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
/** Declarations of the first CSS rule whose selector list contains `selector` exactly (whitespace-normalised). */
const rules = (selector: string): string[] => {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1]!.split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (sels.includes(selector)) out.push(m[2]!.replace(/\s+/g, ' '));
  }
  return out;
};
const decl = (selector: string): string => rules(selector).join(' ');

const running = (n: number) => Array.from({ length: n }, (_, i) => issueRow({ issue_id: String(i + 1), issue_identifier: `acme/app#${i + 1}` }));
const queueNext = (n: number) => Array.from({ length: n }, (_, i) => ({ issue_identifier: `acme/app#${50 + i}`, status: 'next', kind: 'new' }));
const health = (over: Record<string, unknown> = {}) => ({ ...dashboardState().health, last_tick_at: iso(-12), ...over });
const subtitle = (state: Record<string, unknown>): string => renderPage(DASHBOARD_HTML, state).$('ov-subtitle').textContent;
const chipTexts = (state: Record<string, unknown>): string[] => renderPage(DASHBOARD_HTML, state).query('#ov-chips .ui-chip').map((c) => c.textContent);

describe('E2-8 title block', () => {
  it('has exactly one h1 "Übersicht"', () => {
    const page = renderPage(DASHBOARD_HTML, dashboardState());
    const h1 = page.query('h1');
    assert.equal(h1.length, 1);
    assert.equal(h1[0]!.textContent, 'Übersicht');
  });

  it('subtitle: plural, "n Teams spielen · m warten auf einen Slot · letzter Poll vor s s"', () => {
    assert.equal(subtitle(dashboardState({ issues: running(2), queue: queueNext(3), health: health() })), '2 Teams spielen · 3 warten auf einen Slot · letzter Poll vor 12 s');
    assert.equal(subtitle(dashboardState({ issues: [], queue: [], health: health() })), '0 Teams spielen · 0 warten auf einen Slot · letzter Poll vor 12 s');
  });

  it('subtitle: singular "1 Team spielt" and "1 wartet auf einen Slot"', () => {
    assert.equal(subtitle(dashboardState({ issues: running(1), queue: queueNext(1), health: health() })), '1 Team spielt · 1 wartet auf einen Slot · letzter Poll vor 12 s');
    assert.equal(subtitle(dashboardState({ issues: running(1), queue: queueNext(2), health: health() })), '1 Team spielt · 2 warten auf einen Slot · letzter Poll vor 12 s');
    assert.equal(subtitle(dashboardState({ issues: running(3), queue: queueNext(1), health: health() })), '3 Teams spielen · 1 wartet auf einen Slot · letzter Poll vor 12 s');
  });

  it('subtitle: "noch kein Poll" without a poll', () => {
    assert.equal(subtitle(dashboardState({ issues: [], queue: [], health: health({ last_tick_at: null }) })), '0 Teams spielen · 0 warten auf einen Slot · noch kein Poll');
  });

  it('subtitle counts only running issues, not idle ones', () => {
    const idle = issueRow({ issue_id: '9', issue_identifier: 'acme/app#9', running: null, status: 'queued' });
    assert.match(subtitle(dashboardState({ issues: [...running(1), idle], queue: [], health: health() })), /^1 Team spielt · /);
  });

  it('chips: Tracker ok and Workflow gültig with a dot, no clash chip', () => {
    const page = renderPage(DASHBOARD_HTML, dashboardState({ health: health() }));
    const chips = page.query('#ov-chips .ui-chip');
    assert.deepEqual(chips.map((c) => c.textContent), ['Tracker ok', 'Workflow gültig']);
    for (const c of chips) assert.equal(c.querySelectorAll('.ui-dot').length, 1, 'a dot per chip');
  });

  it('chips: tracker error turns the tracker chip red, the workflow chip stays', () => {
    const ok = renderPage(DASHBOARD_HTML, dashboardState({ health: health() })).query('#ov-chips .ui-chip');
    const bad = renderPage(DASHBOARD_HTML, dashboardState({ health: health({ last_tracker_error: { at: iso(-5), message: 'HTTP 502' } }) })).query('#ov-chips .ui-chip');
    assert.deepEqual(bad.map((c) => c.textContent), ['Tracker Fehler', 'Workflow gültig']);
    assert.notEqual(bad[0]!.style.color, ok[0]!.style.color, 'tracker chip changes colour');
    assert.equal(bad[1]!.style.color, ok[1]!.style.color, 'workflow chip keeps its colour');
    assert.match(String(bad[0]!.style.color), /^#(fca5a5|f87171|fecaca)$/i, 'red');
    assert.match(String(ok[0]!.style.color), /^#(6ee7b7|34d399|d1fae5)$/i, 'green');
  });

  it('chips: workflow error shows "Workflow ungültig"', () => {
    assert.deepEqual(chipTexts(dashboardState({ health: health({ workflow_error: { message: 'bad yaml' } }) })), ['Tracker ok', 'Workflow ungültig']);
  });

  it('chips: write-clash chip only for n > 0, amber, singular/plural', () => {
    const clash = (id: string, status = 'open') => ({ id, path: `n/${id}.md`, status, at: [iso(-600), iso(-420)], roles: ['reviewer', 'developer'], issues: ['acme/app#4', 'acme/app#5'] });
    assert.equal(chipTexts(dashboardState({ health: health() })).length, 2);
    assert.equal(chipTexts(dashboardState({ health: health(), brain_clashes: [] })).length, 2);
    assert.deepEqual(chipTexts(dashboardState({ health: health(), brain_clashes: [clash('a')] })), ['Tracker ok', 'Workflow gültig', '1 Write-Clash']);
    const two = renderPage(DASHBOARD_HTML, dashboardState({ health: health(), brain_clashes: [clash('a'), clash('b')] })).query('#ov-chips .ui-chip');
    assert.equal(two[2]!.textContent, '2 Write-Clashes');
    assert.match(String(two[2]!.style.color), /^#(fcd34d|fbbf24|fde68a)$/i, 'amber');
    assert.equal(two[2]!.querySelectorAll('.ui-dot').length, 1);
  });

  it('action bar has the "Jetzt pollen" button which still posts /api/v1/refresh', () => {
    const page = renderPage(DASHBOARD_HTML, dashboardState(), { fetch: () => ({ ok: true, coalesced: false }) });
    assert.equal(page.$('refresh').textContent.trim(), 'Jetzt pollen');
    page.click(page.$('refresh'));
    assert.ok(page.fetches.some((f) => f.url === '/api/v1/refresh' && f.method === 'POST'));
  });
});

describe('E2-8 alerts panel', () => {
  const state = dashboardState({
    health: health({ last_tracker_error: { at: iso(-300), message: 'tracker kaputt' } }),
    brain_clashes: [{ id: 'c1', path: 'notes/api.md', status: 'open', at: [iso(-3600), iso(-3420)], roles: ['reviewer', 'developer'], issues: ['acme/app#4', 'acme/app#5'] }],
    issues: [issueRow({ issue_id: '12', issue_identifier: 'acme/app#12', title: 'Hilfe nötig', labels: ['needs-human'], running: null, review_rounds: 3, updated_at: iso(-7200) })],
    model_holds: [{ model: 'fable', source: 'limit', since: iso(-1800), until: iso(3600), text: 'x', issue_identifier: null }],
  });
  const budget = { generated_at: iso(-60), five_hour: { alert: true, resets_at: iso(7200), forecast: { eta: iso(1800) } }, seven_day: { alert: false } };
  const load = (s: unknown, b: unknown = budget) => renderPage(DASHBOARD_HTML, s as Record<string, unknown>, { fetch: (url) => (url.startsWith('/api/v1/budget') ? b : s) });
  const cards = (page: ReturnType<typeof renderPage>): FakeElement[] => page.query('#alerts-list a.gi');
  const labelOf = (c: FakeElement): string => c.querySelector('.lbl')!.textContent;

  it('panel head: .lbl "Alerts" and a count badge', () => {
    const page = load(state);
    assert.equal(page.$('alerts-title').textContent, 'Alerts');
    assert.ok(page.$('alerts-title').classList.contains('lbl'));
    assert.equal(page.$('alerts-count').textContent, String(page.query('#alerts-list li').length));
    assert.ok(!page.$('alerts-count').hidden);
  });

  it('shows cards for write clash, needs-human, model hold and attention error, each a link with kind label', async () => {
    const page = load(state);
    const list = cards(page);
    const byLabel = new Map(list.map((c) => [labelOf(c), c]));
    assert.ok(byLabel.has('Write-Clash'), [...byLabel.keys()].join(','));
    assert.ok(byLabel.has('needs-human'));
    assert.ok(byLabel.has('Model-Hold'));
    assert.equal(byLabel.get('Write-Clash')!.getAttribute('href'), '/brain');
    assert.equal(byLabel.get('needs-human')!.getAttribute('href'), '/issue?id=' + encodeURIComponent('acme/app#12'));
    for (const c of list) assert.equal(c.tagName.toLowerCase(), 'a', 'the whole card is the link');
    assert.equal(page.$('alerts-count').textContent, String(list.length));
  });

  it('texts follow the issue wording', () => {
    const page = load(state);
    const text = (label: string) => cards(page).find((c) => labelOf(c) === label)!.textContent;
    assert.match(text('Write-Clash'), /Developer \(#5\) wollte 3 min nach Reviewer \(#4\) schreiben – abgewiesen, Hash passt nicht\. Beide Fassungen prüfen\./);
    assert.match(text('needs-human'), /Nach 3 Review-Runden an dich übergeben\./);
    assert.match(text('Model-Hold'), new RegExp(`fable pausiert · Limit bis ${clock(iso(3600))}`));
  });

  it('limit forecast text and link (budget alert)', async () => {
    const page = load(state);
    await until(() => cards(page).some((c) => /Limit gegen/.test(c.textContent)), 3000, 'forecast card');
    const card = cards(page).find((c) => /Limit gegen/.test(c.textContent))!;
    assert.match(card.textContent, new RegExp(`Beim aktuellen Verbrauch ist das Limit gegen ${clock(iso(1800))} erreicht, Reset um ${clock(iso(7200))}\\.`));
    assert.equal(card.getAttribute('href'), '/stats');
    assert.equal(labelOf(card), 'Limit-Prognose');
  });

  it('every card has head row (label + time), title and text parts', () => {
    const page = load(state);
    for (const c of cards(page)) {
      assert.equal(c.querySelectorAll('.lbl').length, 1);
      assert.ok(c.children.length >= 3, 'head, title, text');
      assert.ok(c.children[0]!.querySelector('.lbl'), 'kind label in the first row');
    }
  });

  it('empty state: one .gi card with a green dot and "Alles ruhig", no badge', () => {
    const page = renderPage(DASHBOARD_HTML, dashboardState({ health: health() }));
    const items = page.query('#alerts-list li');
    assert.equal(items.length, 1);
    const card = items[0]!.querySelector('.gi')!;
    assert.ok(card, 'a .gi card');
    assert.equal(card.textContent, 'Alles ruhig');
    assert.ok(card.querySelector('.tone-green') || card.querySelector('.ui-dot'), 'a green dot');
    assert.ok(page.$('alerts-count').hidden, 'badge hidden at 0');
  });

  it('badge goes back to hidden when the alerts disappear on the next render', () => {
    const page = load(state);
    assert.ok(!page.$('alerts-count').hidden);
    page.render(dashboardState({ health: health() }));
    assert.ok(page.$('alerts-count').hidden);
    assert.equal(page.query('#alerts-list li')[0]!.textContent, 'Alles ruhig');
  });

  it('resolved clashes do not make a card', () => {
    const page = renderPage(DASHBOARD_HTML, dashboardState({ health: health(), brain_clashes: [{ id: 'r', path: 'a.md', status: 'resolved', at: [iso(-100), iso(-50)] }] }));
    assert.equal(page.query('#alerts-list li')[0]!.textContent, 'Alles ruhig');
  });

  it('CSS: panel flex 1 1 340px, wraps in one row with the budget panel', () => {
    assert.match(decl('#alerts'), /flex:\s*1 1 340px/);
    const page = renderPage(DASHBOARD_HTML, dashboardState());
    const row = page.$('alerts').parentNode!;
    assert.ok(row.contains(page.$('budget')), 'alerts and budget share a parent');
    const cls = row.className.split(/\s+/).filter(Boolean);
    assert.ok(cls.some((c) => /flex:[^;]*|display:\s*flex/.test(decl('.' + c)) && /flex-wrap:\s*wrap/.test(decl('.' + c))), 'row is a wrapping flex container');
  });

  it('CSS: badge 24 px round, rgba(248,113,113,.2), #fecaca, mono 12 px', () => {
    const d = decl('.alerts-badge');
    assert.match(d, /width:\s*24px/);
    assert.match(d, /height:\s*24px/);
    assert.match(d, /border-radius:\s*(50%|999px|12px)/);
    assert.match(d, /rgba\(248,\s*113,\s*113,\s*0?\.2\)/);
    assert.match(d, /#fecaca/i);
    assert.match(d, /12px var\(--mono\)/);
  });

  it('CSS: card padding 12px 14px, red/amber borders and label colours', () => {
    assert.match(decl('.alert'), /padding:\s*12px 14px/);
    assert.match(decl('.alert-red'), /rgba\(248,\s*113,\s*113,\s*0?\.4\)/);
    assert.match(decl('.alert-red .alert-kind'), /#fca5a5/i);
    assert.match(decl('.alert-amber'), /rgba\(251,\s*191,\s*36,\s*0?\.35\)/);
    assert.match(decl('.alert-amber .alert-kind'), /#fcd34d/i);
  });

  it('cards carry the tone class of their kind (clash and attention red; forecast, needs-human, hold amber)', async () => {
    const page = load(state);
    await until(() => cards(page).some((c) => /Limit gegen/.test(c.textContent)), 3000, 'forecast card');
    const tone = (c: FakeElement) => (c.classList.contains('alert-red') ? 'red' : c.classList.contains('alert-amber') ? 'amber' : 'none');
    const by = Object.fromEntries(cards(page).map((c) => [labelOf(c), tone(c)]));
    assert.equal(by['Write-Clash'], 'red');
    assert.equal(by['Limit-Prognose'], 'amber');
    assert.equal(by['needs-human'], 'amber');
    assert.equal(by['Model-Hold'], 'amber');
    const attention = cards(page).find((c) => /tracker kaputt/.test(c.textContent))!;
    assert.equal(tone(attention), 'red', 'needs-attention error is red like a clash');
  });

  it('CSS: time Mono 12px --fg-3, title 500, text 13px --fg-2, empty text 13px', () => {
    assert.match(decl('.alert-time'), /12px var\(--mono\)/);
    assert.match(decl('.alert-time'), /--fg-3/);
    assert.match(decl('.alert-title'), /font-weight:\s*500/);
    assert.match(decl('.alert-text'), /font-size:\s*13px/);
    assert.match(decl('.alert-text'), /--fg-2/);
    assert.match(decl('.alerts-empty'), /font-size:\s*13px/);
  });
});

describe('E2-8 activity strip', () => {
  const events = (list: Array<{ at: string; role: string }>) => ({ generated_at: iso(0), since: iso(-1800), minutes: 30, events: list.map((e) => ({ ...e, issue: 'acme/app#1' })) });
  const load = (data: unknown, over: Record<string, unknown> = {}) =>
    renderPage(DASHBOARD_HTML, dashboardState(over), { fetch: (url) => (url.startsWith('/api/v1/activity') ? data : dashboardState(over)) });
  const strip = (p: ReturnType<typeof renderPage>) => p.$('tool-activity-strip');
  const bars = (p: ReturnType<typeof renderPage>) => p.query('#tool-activity-strip span');
  const ready = async (p: ReturnType<typeof renderPage>) => { await until(() => p.fetches.some((f) => f.url.startsWith('/api/v1/activity')), 3000, 'activity fetch'); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };

  it('panel title and strip semantics', () => {
    const page = renderPage(DASHBOARD_HTML, dashboardState());
    assert.equal(page.$('tool-activity-title').textContent, 'Agent-Aktivität · letzte 30 min');
    assert.equal(strip(page).getAttribute('role'), 'img');
    assert.equal(strip(page).getAttribute('aria-label'), 'Tool-Aufrufe der letzten 30 Minuten, farbig je Rolle');
  });

  it('axis below: −30 min, −20 min, −10 min, jetzt', () => {
    const page = renderPage(DASHBOARD_HTML, dashboardState());
    const axis = page.query('#tool-activity .act-axis')[0]!;
    assert.deepEqual(axis.children.map((c) => c.textContent), ['−30 min', '−20 min', '−10 min', 'jetzt']);
  });

  it('bars are 3 px spans positioned by time in percent, coloured by role', async () => {
    const page = load(events([{ at: iso(-900), role: 'developer' }, { at: iso(-1800), role: 'reviewer' }, { at: iso(0), role: 'analyst' }]));
    await ready(page);
    const list = bars(page);
    assert.equal(list.length, 3);
    const left = list.map((b) => parseFloat(String(b.style.left)));
    assert.ok(Math.abs(left[0]! - 50) < 0.5, `developer at 50 %, got ${left[0]}`);
    assert.ok(Math.abs(left[1]! - 0) < 0.5);
    assert.ok(Math.abs(left[2]! - 100) < 0.5);
    assert.deepEqual(list.map((b) => b.style.background), ['#34d399', '#f472b6', '#38bdf8']);
    assert.ok(list.every((b) => /^\d+px$/.test(String(b.style.height)) && parseInt(String(b.style.height), 10) >= 8 && parseInt(String(b.style.height), 10) <= 42));
    assert.equal(list.every((b) => b.tagName.toLowerCase() === 'span'), true);
  });

  it('default bar height is 20 px without a duration', async () => {
    const page = load(events([{ at: iso(-600), role: 'developer' }]));
    await ready(page);
    assert.equal(bars(page)[0]!.style.height, '20px');
  });

  it('legend lists every role of the profile, also those without calls', async () => {
    const roles = ['analyst', 'architect', 'developer', 'tester', 'reviewer'].map((name) => ({ name, states: [], read_only: false, commands: [] }));
    const page = load(events([{ at: iso(-600), role: 'developer' }]), { pipeline_config: { board_columns: null, roles, blocked_states: [] } });
    await ready(page);
    const keys = page.query('#tool-activity-legend .act-key').map((k) => k.textContent.toLowerCase());
    for (const r of ['analyst', 'architect', 'developer', 'tester', 'reviewer']) assert.ok(keys.some((k) => k.includes(r)), `legend has ${r}: ${keys.join('|')}`);
    for (const k of page.query('#tool-activity-legend .act-key')) assert.equal(k.querySelectorAll('.ui-dot').length, 1, 'dot + name');
  });

  it('legend is in the panel head next to the title', () => {
    const page = renderPage(DASHBOARD_HTML, dashboardState());
    assert.equal(page.$('tool-activity-legend').parentNode, page.$('tool-activity-title').parentNode);
  });

  it('no calls: empty text instead of an empty strip', async () => {
    const page = load(events([]));
    await ready(page);
    assert.equal(bars(page).filter((b) => /act-bar/.test(b.className)).length, 0);
    assert.equal(strip(page).textContent, 'Keine Tool-Aufrufe in den letzten 30 Minuten');
  });

  it('1000 calls are thinned to 400 bars, evenly spread over the window', async () => {
    const list = Array.from({ length: 1000 }, (_, i) => ({ at: iso(-1800 + (i * 1799) / 999), role: 'developer' }));
    const page = load(events(list));
    await ready(page);
    const b = bars(page);
    assert.equal(b.length, 400);
    const lefts = b.map((x) => parseFloat(String(x.style.left)));
    assert.ok(lefts[0]! < 1);
    assert.ok(lefts[399]! > 98, `last sampled bar near the end: ${lefts[399]}`);
    const gaps = lefts.slice(1).map((v, i) => v - lefts[i]!);
    assert.ok(Math.max(...gaps) < 0.5, 'no big hole in the sample');
  });

  it('exactly 400 calls are all drawn, 401 are thinned to 400', async () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ at: iso(-1800 + i * 4), role: 'tester' }));
    const a = load(events(mk(400))); await ready(a);
    assert.equal(bars(a).length, 400);
    const b = load(events(mk(401))); await ready(b);
    assert.equal(bars(b).length, 400);
  });

  it('CSS: strip 54 px with a faint bottom line; bars 3 px, radius 2, absolute, bottom 0', () => {
    const s = decl('.act-strip');
    assert.match(s, /height:\s*54px/);
    assert.match(s, /border-bottom:[^;]*rgba\(255,\s*255,\s*255,\s*0?\.1\)/);
    const b = decl('.act-bar');
    assert.match(b, /position:\s*absolute/);
    assert.match(b, /bottom:\s*0/);
    assert.match(b, /width:\s*3px/);
    assert.match(b, /border-radius:\s*2px/);
  });

  it('CSS: axis mono 11.5px --fg-3 space-between; legend 12px --fg-2 gap 12px wrap; dot 8px; empty text 12.5px --fg-3', () => {
    const a = decl('.act-axis');
    assert.match(a, /justify-content:\s*space-between/);
    assert.match(a, /11\.5px var\(--mono\)/);
    assert.match(a, /--fg-3/);
    const l = decl('.act-legend');
    assert.match(l, /flex-wrap:\s*wrap/);
    assert.match(l, /gap:[^;]*12px/);
    assert.match(l, /font-size:\s*12px/);
    assert.match(l, /--fg-2/);
    assert.match(decl('.act-key .ui-dot'), /width:\s*8px/);
    const e = decl('.act-empty');
    assert.match(e, /12\.5px/);
    assert.match(e, /--fg-3/);
  });
});
