import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { ROLE_COLORS } from '../src/http/ui/palette.ts';
import { TASKS_HTML } from '../src/http/tasks-page.ts';
import { renderPage } from './helpers.ts';
import { dashboardState, issueRow } from './helpers/page-fixtures.ts';

// Acceptance tests of E5-1 (#364), derived from the issue text and not from the implementation.

type Obj = Record<string, any>;
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
const text = (n: { textContent: string }) => n.textContent;
const ALL_CODES = ['ready', 'no_free_slot', 'column_limit', 'reserved_for_role', 'backoff', 'session_limit', 'model_hold', 'waiting_for_sub_issues', 'inactive', 'paused', 'blocked', 'missing_label'];
const COLUMNS = ['running', 'next', 'waiting', 'paused', 'blocked', 'done'];

const row = (n: number, over: Obj = {}): Obj => issueRow({ issue_id: String(n), issue_identifier: `acme/app#${n}`, title: `Titel ${n}`, ...over });
const queued = (n: number, section: string, over: Obj = {}): Obj => row(n, { section, status: 'queued', running: null, stages: [], ...over });

function state(over: Obj = {}): Obj {
  return dashboardState({
    issues: [
      row(1),
      queued(2, 'next', { position: 1, priority: 2, reason: { code: 'ready', text: 'x' } }),
      queued(3, 'waiting', { retry: { attempt: 1, due_in_ms: 5000, kind: 'failure' }, reason: { code: 'backoff', text: 'x' } }),
      queued(4, 'paused', { paused: { source: 'operator' }, reason: { code: 'paused', text: 'x' } }),
    ],
    blocked: [{ issue_id: '5', issue_identifier: 'acme/app#5', title: 'Titel 5', repo: 'acme/app', state: 'Todo', reason: 'x', reason_code: 'blocked' }],
    retrying: [{ issue_id: '5' }],
    ...over,
  });
}

const finished = (n: number, ts: string, over: Obj = {}): Obj => ({ ts, event: 'run_finished', issue: `acme/app#${n}`, run: `run${n}`, title: `Erledigt ${n}`, repo: 'acme/app', outcome: 'handed_off', state: 'Done', ...over });
const withHistory = (entries: Obj[], results: Obj[] = [], s: Obj = state()) => (url: string) => {
  if (url.includes('event=run_finished')) return { entries };
  if (url.includes('event=stage_result')) return { entries: results };
  if (url.includes('/history/')) return { entries: [] };
  return s;
};

describe('tasks page acceptance (E5-1)', () => {
  it('has six sections with headings in the specified order, all in one grid', () => {
    const headings = [...TASKS_HTML.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1]);
    assert.deepEqual(headings, ['Läuft', 'Als Nächstes', 'Wartet', 'Pausiert', 'Blockiert', 'Kürzlich erledigt']);
    assert.match(TASKS_HTML, /display:\s*grid/);
    assert.match(TASKS_HTML, /@media \(max-width: (3[89]\d|[4-6]\d\d)px\)/, 'a media query at or below 640px collapses the grid');
    assert.match(TASKS_HTML, /@media \(max-width: 640px\)[^}]*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  });

  it('shows the empty texts "Nichts läuft" and "Nichts wartet" before any data arrives', () => {
    // pre-rendered HTML, no script involved
    assert.ok(TASKS_HTML.includes('Nichts läuft'));
    assert.ok(TASKS_HTML.includes('Nichts wartet'));
  });

  it('keeps all six columns visible with distinct empty texts for an idle orchestrator', async () => {
    const p = renderPage(TASKS_HTML, dashboardState(), { fetch: withHistory([], [], dashboardState()) });
    await settle();
    const texts = new Set<string>();
    for (const c of COLUMNS) {
      assert.equal(p.query(`#col-${c} .task-card`).length, 0, c);
      assert.equal(p.query(`#col-${c} button`).length, 0, c);
      const empty = p.query(`#col-${c} .task-empty`);
      assert.equal(empty.length, 1, `empty text in ${c}`);
      assert.ok(text(empty[0]!).length > 3);
      texts.add(text(empty[0]!));
    }
    assert.equal(texts.size, 6, 'each column has its own empty text');
    assert.ok([...texts].includes('Nichts läuft'));
    assert.ok([...texts].includes('Nichts wartet'));
  });

  it('removes the empty text again once a column gets a card, and restores it afterwards', () => {
    const p = renderPage(TASKS_HTML, state());
    for (const c of COLUMNS.filter((c) => c !== 'done')) {
      assert.equal(p.query(`#col-${c} .task-card`).length, 1, c);
      assert.equal(p.query(`#col-${c} .task-empty`).length, 0, c);
    }
    p.render(dashboardState());
    for (const c of COLUMNS.filter((c) => c !== 'done')) assert.equal(p.query(`#col-${c} .task-empty`).length, 1, c);
  });

  it('shows a German chip with the code as title for each of the 12 PlanReasonCodes', () => {
    const issues = ALL_CODES.map((code, i) => queued(100 + i, 'waiting', { reason: { code, text: `engl-${code}` } }));
    const p = renderPage(TASKS_HTML, state({ issues, blocked: [], retrying: [] }));
    const labels = new Set<string>();
    for (const [i, code] of ALL_CODES.entries()) {
      const card = p.query('#col-waiting .task-card')[i]!;
      const chip = card.querySelectorAll('.ui-chip').find((c) => c.getAttribute('title') === code);
      assert.ok(chip, `chip with title ${code}`);
      const label = text(chip);
      assert.notEqual(label, code, `${code} is translated`);
      assert.ok(!label.includes('engl-'), `${code} does not use the English server text`);
      assert.ok(!label.includes('_'), `${code} is not a raw code`);
      labels.add(label);
    }
    assert.equal(labels.size, ALL_CODES.length, 'every code has its own text');
  });

  it('shows the reason chip on cards of every column that carries a reason', () => {
    const p = renderPage(TASKS_HTML, state());
    assert.ok(p.query('#col-next .ui-chip').some((c) => c.getAttribute('title') === 'ready'));
    assert.ok(p.query('#col-waiting .ui-chip').some((c) => c.getAttribute('title') === 'backoff'));
    assert.ok(p.query('#col-paused .ui-chip').some((c) => c.getAttribute('title') === 'paused'));
  });

  it('shows the reason chip on blocked cards (real blocked[] rows carry reason as text and reason_code as code)', () => {
    const codes = ['blocked', 'missing_label'];
    const blocked = codes.map((code, i) => ({ issue_id: String(50 + i), issue_identifier: `acme/app#${50 + i}`, title: `Blockiert ${i}`, repo: 'acme/app', state: 'Todo', reason: `english text ${code}`, reason_code: code, blocked_by: [], labels: [], updated_at: null, tracked: false }));
    const p = renderPage(TASKS_HTML, state({ issues: [], blocked, retrying: [] }));
    const cards = p.query('#col-blocked .task-card');
    assert.equal(cards.length, 2);
    for (const [i, code] of codes.entries()) {
      const chip = cards[i]!.querySelectorAll('.ui-chip').find((c) => c.getAttribute('title') === code);
      assert.ok(chip, `reason chip with title ${code} on the blocked card`);
      assert.ok(!text(chip).includes('english'), 'German text, not the server text');
    }
  });

  it('card shows number, title link to /issue?id=, repo and priority or queue position', () => {
    const p = renderPage(TASKS_HTML, state({ issues: [queued(7, 'next', { position: 3, priority: 1, repo: 'zeta/lib', issue_identifier: 'zeta/lib#7', reason: { code: 'ready', text: 'x' } }), queued(8, 'waiting', { priority: 4, reason: { code: 'backoff', text: 'x' } })], blocked: [], retrying: [] }));
    const next = p.query('#col-next .task-card')[0]!;
    assert.ok(text(next).includes('#7'));
    assert.ok(text(next).includes('zeta/lib'));
    assert.match(text(next), /3/, 'queue position');
    const link = next.querySelectorAll('a').find((a) => text(a) === 'Titel 7')!;
    assert.ok(link, 'title is a link');
    assert.equal(link.getAttribute('href'), '/issue?id=zeta%2Flib%237');
    const waiting = p.query('#col-waiting .task-card')[0]!;
    assert.ok(text(waiting).includes('#8'));
    assert.match(text(waiting), /4/, 'priority');
  });

  it('colours the role chip with the palette colour of the responsible role', () => {
    const issues = [
      row(1, { running: { ...row(1).running, role: 'developer' } }),
      row(2, { running: { ...row(2).running, role: 'tester', issue_identifier: 'acme/app#2' } }),
    ];
    const p = renderPage(TASKS_HTML, state({ issues, blocked: [], retrying: [] }));
    const [a, b] = p.query('#col-running .task-role');
    assert.ok(a && b);
    assert.equal(String(a.style.color).toLowerCase(), ROLE_COLORS.developer);
    assert.equal(String(b.style.color).toLowerCase(), ROLE_COLORS.tester);
  });

  it('shows exactly the specified action per column, one button per card', () => {
    const p = renderPage(TASKS_HTML, state());
    const expected: Record<string, string> = { running: 'Pausieren', next: 'Jetzt starten', waiting: 'Erneut versuchen', paused: 'Fortsetzen', blocked: 'Erneut versuchen' };
    for (const [col, label] of Object.entries(expected)) {
      const buttons = p.query(`#col-${col} button`);
      assert.equal(buttons.length, 1, col);
      assert.equal(text(buttons[0]!), label, col);
    }
    assert.equal(p.query('#col-done button').length, 0);
  });

  it('wait/blocked cards without a retry entry get no "Erneut versuchen" button', () => {
    const s = state({
      issues: [queued(3, 'waiting', { retry: null, reason: { code: 'inactive', text: 'x' } })],
      blocked: [{ issue_id: '5', issue_identifier: 'acme/app#5', title: 'Titel 5', repo: 'acme/app', state: 'Todo', reason: 'x', reason_code: 'blocked' }],
      retrying: [],
    });
    const p = renderPage(TASKS_HTML, s);
    assert.equal(p.query('#col-waiting .task-card').length, 1);
    assert.equal(p.query('#col-blocked .task-card').length, 1);
    assert.equal(p.query('#col-waiting button').length, 0);
    assert.equal(p.query('#col-blocked button').length, 0);
  });

  it('posts each action to the existing endpoint POST /api/v1/<id>/<verb> without new routes', async () => {
    const p = renderPage(TASKS_HTML, state(), { fetch: withHistory([]) });
    for (const [col, verb, n] of [['running', 'pause', 1], ['next', 'force', 2], ['waiting', 'retry', 3], ['paused', 'resume', 4], ['blocked', 'retry', 5]] as const) {
      p.click(p.query(`#col-${col} button`)[0]!);
      await settle();
      const posts = p.fetches.filter((f) => f.method === 'POST');
      assert.equal(posts.at(-1)!.url, `/api/v1/acme%2Fapp%23${n}/${verb}`, col);
    }
    for (const f of p.fetches) {
      if (f.method === 'GET') assert.match(f.url, /^\/api\/v1\/(state|history\/entries)/, f.url);
    }
  });

  it('renders no button at all when controls.retry is false, but keeps the cards', () => {
    const p = renderPage(TASKS_HTML, state({ controls: { retry: false } }));
    assert.equal(p.query('button').length, 0);
    assert.equal(p.query('.tasks-grid .task-card').length, 5);
    // and the buttons come back when the state allows control again
    p.render(state({ controls: { retry: true } }));
    assert.equal(p.query('.tasks-grid button').length, 5);
    p.render(state({ controls: { retry: false } }));
    assert.equal(p.query('.tasks-grid button').length, 0);
  });

  it('treats a missing controls object like the overview: buttons are rendered', () => {
    const s = state();
    delete s.controls;
    const p = renderPage(TASKS_HTML, s);
    assert.equal(p.query('.tasks-grid button').length, 5);
  });

  it('reports a successful action in the aria-live region', async () => {
    const p = renderPage(TASKS_HTML, state(), { fetch: withHistory([]) });
    const live = p.$('announce');
    assert.equal(live.getAttribute('aria-live'), 'polite');
    p.click(p.query('#col-paused button')[0]!);
    await settle();
    assert.ok(text(live).includes('acme/app#4'));
    assert.ok(text(live).length > 'acme/app#4'.length);
  });

  it('reports a failed action in the aria-live region instead of throwing', async () => {
    const p = renderPage(TASKS_HTML, state(), { fetch: (u, init) => { if (init.method === 'POST') throw new Error('boom'); return u.includes('/history/') ? { entries: [] } : state(); } });
    const live = p.$('announce');
    p.click(p.query('#col-running button')[0]!);
    await settle();
    assert.ok(text(live).includes('acme/app#1'));
    assert.match(text(live), /fehl/i);
  });

  it('lists only the last 10 finished issues with number, title, repo, time and verdict', async () => {
    const entries: Obj[] = [];
    for (let n = 1; n <= 14; n++) entries.push(finished(200 + n, `2026-10-30T08:${String(n).padStart(2, '0')}:00.000Z`));
    const p = renderPage(TASKS_HTML, state(), { fetch: withHistory(entries, [{ run: 'run214', verdict: 'approved' }]) });
    await settle();
    const cards = p.query('#col-done .task-card');
    assert.equal(cards.length, 10);
    assert.equal(text(p.$('col-done-count')), '10');
    const nums = cards.map((c) => text(c.querySelector('.task-num')!));
    assert.ok(nums.includes('#214'));
    assert.ok(!nums.includes('#201') && !nums.includes('#204'), 'older ones are cut off');
    const newest = cards.find((c) => text(c).includes('#214'))!;
    assert.ok(text(newest).includes('Erledigt 214'));
    assert.ok(text(newest).includes('acme/app'));
    assert.ok(text(newest).includes('approved'), 'verdict');
    assert.equal(newest.querySelectorAll('a').find((a) => text(a) === 'Erledigt 214')!.getAttribute('href'), '/issue?id=acme%2Fapp%23214');
    assert.match(text(newest), /\d{1,2}:\d{2}/, 'a time');
  });

  it('shows fewer than 10 finished issues when the history has fewer, and the empty text for none', async () => {
    const few = renderPage(TASKS_HTML, state(), { fetch: withHistory([finished(300, '2026-10-30T08:00:00.000Z'), finished(301, '2026-10-30T09:00:00.000Z')]) });
    await settle();
    assert.equal(few.query('#col-done .task-card').length, 2);
    assert.equal(few.query('#col-done .task-empty').length, 0);
    const none = renderPage(TASKS_HTML, state(), { fetch: withHistory([]) });
    await settle();
    assert.equal(none.query('#col-done .task-card').length, 0);
    assert.equal(none.query('#col-done .task-empty').length, 1);
  });

  it('falls back to a text when the history answers history_disabled', async () => {
    const p = renderPage(TASKS_HTML, undefined, { fetch: (u) => { if (u.includes('/history/')) throw new Error('history_disabled'); return state(); } });
    await settle();
    assert.equal(p.query('#col-done .task-card').length, 0);
    assert.equal(p.query('#col-done .task-empty').length, 1);
    assert.equal(p.query('#col-running .task-card').length, 1, 'the other columns still render');
  });

  it('merge entries and run_finished entries both count as finished (no crash on entries without verdict)', async () => {
    const e = [finished(400, '2026-10-30T08:00:00.000Z', { outcome: 'failed', state: 'In progress' }), finished(401, '2026-10-30T09:00:00.000Z', { outcome: 'stopped' })];
    const p = renderPage(TASKS_HTML, state(), { fetch: withHistory(e) });
    await settle();
    const cards = p.query('#col-done .task-card');
    assert.equal(cards.length, 2);
    for (const c of cards) assert.ok(c.querySelectorAll('.ui-chip').length >= 1, 'each finished card shows an outcome');
  });

  it('polls every 2 s via pollEvery and attaches to the live events', () => {
    assert.match(TASKS_HTML, /pollEvery\(\s*\w+,\s*2000\s*\)/);
    assert.match(TASKS_HTML, /\blive\(/);
  });

  it('does not rebuild unchanged cards on an identical state, but updates changed ones', () => {
    const p = renderPage(TASKS_HTML, state());
    const next = p.query('#col-next .task-card')[0];
    const running = p.query('#col-running .task-card')[0];
    p.render(state());
    assert.equal(p.query('#col-next .task-card')[0], next);
    assert.equal(p.query('#col-running .task-card')[0], running);
    p.render(state({ issues: [row(1), queued(2, 'next', { position: 1, title: 'Neuer Titel', reason: { code: 'ready', text: 'x' } })] }));
    assert.ok(text(p.query('#col-next .task-card')[0]!).includes('Neuer Titel'));
  });

  it('moves a card to another column when its section changes', () => {
    const p = renderPage(TASKS_HTML, state());
    p.render(state({ issues: [queued(2, 'paused', { paused: { source: 'operator' }, reason: { code: 'paused', text: 'x' } })], blocked: [], retrying: [] }));
    assert.equal(p.query('#col-next .task-card').length, 0);
    assert.equal(p.query('#col-paused .task-card').length, 1);
    assert.equal(text(p.query('#col-paused button')[0]!), 'Fortsetzen');
    assert.equal(p.query('#col-next .task-empty').length, 1);
  });

  it('the overview links to /tasks and keeps its queue and blocked sections', () => {
    assert.match(DASHBOARD_HTML, /<a[^>]*href="\/tasks"[^>]*>\s*Alle Tasks\s*<\/a>/);
    for (const id of ['next-section', 'waiting-section', 'paused-section', 'blocked-section']) assert.ok(DASHBOARD_HTML.includes(`id="${id}"`), id);
    for (const label of ['Retry', 'Resume']) assert.ok(DASHBOARD_HTML.includes(`restartButton(row.issue_identifier, '${label}')`), label);
  });
});
