import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { REASON_LABELS, TASKS_CSS, TASKS_HTML, TASK_COLUMNS } from '../src/http/tasks-page.ts';
import { ROLE_COLORS } from '../src/http/ui/palette.ts';
import { renderPage } from './helpers.ts';
import { dashboardState, issueRow } from './helpers/page-fixtures.ts';

// E5-3 (#389): the six glass columns and their cards, derived from the issue text.

type Obj = Record<string, any>;
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
const text = (n: { textContent: string }) => n.textContent;
const hm = (iso: string) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const UNTIL = '2026-10-30T14:05:00Z';

const row = (n: number, over: Obj = {}): Obj => issueRow({ issue_id: String(n), issue_identifier: `acme/app#${n}`, title: `Titel ${n}`, ...over });
const queued = (n: number, section: string, code: string, over: Obj = {}): Obj =>
  row(n, { section, status: section === 'paused' ? 'paused' : 'queued', running: null, stages: [], reason: { code, text: `engl-${code}` }, ...over });
const running = (n: number, role: string, over: Obj = {}): Obj => {
  const base = row(n);
  return row(n, { running: { ...base.running, issue_identifier: `acme/app#${n}`, role, seconds_running: 125 }, ...over });
};

function state(over: Obj = {}): Obj {
  return dashboardState({
    issues: [
      running(1, 'developer', { priority: 2, review_rounds: 1 }),
      queued(7, 'next', 'ready', { position: 1, priority: 1, title: 'Ein sehr langer Titel der gekürzt werden muss damit er passt' }),
      queued(8, 'next', 'column_limit', { position: 2, state: 'Review' }),
      queued(9, 'next', 'model_hold', { position: 3, model_hold: { model: 'opus', source: 'limit', until: UNTIL } }),
      queued(10, 'next', 'waiting_for_sub_issues', { position: 4 }),
      queued(3, 'waiting', 'backoff', { retry: { attempt: 1, due_in_ms: 100000, due_at: UNTIL, kind: 'failure', limit: null } }),
      queued(4, 'paused', 'paused', { paused: { source: 'operator' } }),
      queued(5, 'paused', 'paused', { paused: { source: 'continuations', continuations: 3 }, labels: ['needs-human'], review_rounds: 3 }),
    ],
    blocked: [
      { issue_id: '20', issue_identifier: 'acme/app#20', title: 'Blockiert', repo: 'acme/app', state: 'Todo', reason: 'x', reason_code: 'blocked', blocked_by: [{ id: '7', identifier: 'acme/app#7', state: 'Todo' }, { id: '8', identifier: 'acme/app#8', state: null }, { id: '6', identifier: 'acme/app#6', state: 'Done' }] },
      { issue_id: '21', issue_identifier: 'acme/app#21', title: 'Ohne Label', repo: 'acme/app', state: 'Todo', reason: 'x', reason_code: 'missing_label', blocked_by: [] },
    ],
    ...over,
  });
}
const finished = (n: number, ts: string, over: Obj = {}): Obj => ({ ts, event: 'run_finished', issue: `acme/app#${n}`, run: `r${n}`, title: `Erledigt ${n}`, repo: 'acme/app', outcome: 'handed_off', state: 'Done', role: 'reviewer', cost_usd: '0.25', agent_seconds: '60', ...over });
const fetchWith = (entries: Obj[], results: Obj[], s: Obj) => (url: string) => {
  if (url.includes('event=run_finished')) return { entries };
  if (url.includes('event=stage_result')) return { entries: results };
  return url.includes('/history/') ? { entries: [] } : s;
};
const col = (p: ReturnType<typeof renderPage>, key: string) => p.query(`#col-${key} .task-card`);
const reasons = (p: ReturnType<typeof renderPage>, key: string) => p.query(`#col-${key} .task-reason`).map(text);

describe('tasks page columns (E5-3)', () => {
  it('has six glass sections with aria-labels and colours in the specified order', () => {
    const sections = [...TASKS_HTML.matchAll(/<section class="g task-col" aria-label="([^"]+)" style="--col: (#[0-9a-f]{6})">/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(sections, [['Läuft', '#34d399'], ['Als Nächstes', '#7dd3fc'], ['Wartet', '#fbbf24'], ['Pausiert', '#fbbf24'], ['Blockiert', '#f87171'], ['Kürzlich erledigt', '#c4b5fd']]);
    assert.deepEqual(TASK_COLUMNS.map((c) => c.color), ['#34d399', '#7dd3fc', '#fbbf24', '#fbbf24', '#f87171', '#c4b5fd']);
  });

  it('styles the grid (auto-fit 230px, gap 14, start), the column (padding 14, gap 10) and the head', () => {
    const rule = (sel: string) => TASKS_CSS.match(new RegExp(`${sel.replace(/\./g, '\\.')} \\{([^}]*)\\}`))![1]!;
    assert.match(rule('.tasks-grid'), /grid-template-columns: repeat\(auto-fit, minmax\(230px, 1fr\)\)/);
    assert.match(rule('.tasks-grid'), /gap: 14px/);
    assert.match(rule('.tasks-grid'), /align-items: start/);
    assert.doesNotMatch(TASKS_CSS, /@media[^{]*\{\s*\.tasks-grid/);
    assert.match(rule('.task-col'), /padding: 14px/);
    assert.match(rule('.task-col'), /gap: 10px/);
    assert.match(rule('.task-col h2'), /font: 600 14px/);
    assert.match(rule('.task-col-dot'), /background: var\(--col\)/);
    assert.match(rule('.task-count'), /font: 12px var\(--mono\)/);
    assert.match(rule('.task-count'), /var\(--fg-3/);
  });

  it('styles the card: padding 12, gap 8, hover border, head, title, repo, reason chip, owner', () => {
    const rule = (sel: string) => TASKS_CSS.match(new RegExp(`${sel.replace(/\./g, '\\.')} \\{([^}]*)\\}`))![1]!;
    assert.match(rule('.tasks-grid .card'), /padding: 12px/);
    assert.match(rule('.tasks-grid .card'), /gap: 8px/);
    assert.match(rule('.tasks-grid .card:hover'), /border-color: rgba\(255, 255, 255, \.18\)/);
    assert.match(rule('.task-num'), /font: 12\.5px var\(--mono\)/);
    assert.match(rule('.task-num'), /--fg-label/);
    assert.match(rule('.task-place'), /font: 11px var\(--mono\)/);
    assert.match(rule('.task-title'), /font-size: 14px; font-weight: 600/);
    assert.match(rule('.task-title'), /--fg-strong/);
    assert.match(rule('.task-repo'), /font: 11\.5px var\(--mono\)/);
    assert.match(rule('.task-reason'), /align-self: flex-start/);
    assert.match(rule('.task-reason'), /padding: 5px 10px/);
    assert.match(rule('.task-reason'), /border-radius: 10px/);
    assert.match(rule('.task-reason'), /font-size: 12px/);
    assert.match(rule('.task-owner'), /font-size: 12px/);
    assert.match(rule('.task-empty'), /font-size: 12\.5px/);
    assert.match(rule('.task-empty'), /--fg-3/);
  });

  it('counts the cards per column; "next" rows that wait for a model or blockers move to "Wartet"', () => {
    const p = renderPage(TASKS_HTML, state());
    const counts = Object.fromEntries(TASK_COLUMNS.map((c) => [c.key, text(p.$(`col-${c.key}-count`))]));
    assert.deepEqual(counts, { running: '01', next: '02', waiting: '03', paused: '02', blocked: '02', done: '00' });
    assert.deepEqual(col(p, 'waiting').map((c) => text(c.querySelector('.task-num')!)), ['#9', '#10', '#3']);
  });

  it('draws the card as article.gi.card with number, right label, title link, repo, reason, owner', () => {
    const p = renderPage(TASKS_HTML, state());
    const card = col(p, 'next')[0]!;
    assert.equal(card.tagName.toLowerCase(), 'article');
    assert.ok(card.classList.contains('gi') && card.classList.contains('card'));
    assert.equal(text(card.querySelector('.task-num')!), '#7');
    assert.equal(text(card.querySelector('.task-place')!), 'P1 · Platz 1');
    const link = card.querySelector('a.task-title')!;
    assert.equal(link.getAttribute('href'), '/issue?id=acme%2Fapp%237');
    assert.match(text(link), /^Ein sehr langer Titel/);
    assert.equal(text(card.querySelector('.task-repo')!), 'acme/app');
    assert.ok(card.querySelector('.task-reason')!.classList.contains('task-tone-next'));
    assert.equal(text(col(p, 'next')[1]!.querySelector('.task-place')!), 'Platz 2');
    assert.equal(text(col(p, 'running')[0]!.querySelector('.task-place')!), 'P2');
    assert.ok(col(p, 'running')[0]!.querySelector('.task-reason')!.classList.contains('task-tone-run'));
  });

  it('writes the reason text per column and PlanReasonCode', () => {
    const p = renderPage(TASKS_HTML, state());
    assert.deepEqual(reasons(p, 'running'), ['Developer spielt · Runde 2 · 2m 5s']);
    assert.deepEqual(reasons(p, 'next'), ['Startet, sobald ein Slot frei ist', 'Wartet auf Slot in Review']);
    assert.deepEqual(reasons(p, 'waiting'), [`Modell-Limit: Opus pausiert bis ${hm(UNTIL)}`, 'Wartet auf Blocker-Merge', 'Retry in 2 min · backoff']);
    assert.deepEqual(reasons(p, 'paused'), ['Von dir pausiert', 'needs-human nach 3 Review-Runden']);
    assert.deepEqual(reasons(p, 'blocked'), ['Blocked by #7, #8 (Ein sehr langer Titel der gekür…)', 'Pflicht-Label fehlt']);
  });

  it('covers every PlanReasonCode with a German text and no raw code or server text', () => {
    const codes = Object.keys(REASON_LABELS).filter((c) => c !== 'column');
    const issues = codes.map((code, i) => queued(100 + i, i % 2 ? 'next' : 'waiting', code, { position: i }));
    const p = renderPage(TASKS_HTML, state({ issues, blocked: [] }));
    for (const c of p.query('.task-reason')) {
      assert.ok(!text(c).includes('engl-'), text(c));
      assert.ok(text(c).length > 5, text(c));
    }
    assert.equal(p.query('.task-reason').length, codes.length);
    assert.equal(p.query('.task-reason').map((c) => c.getAttribute('title')).sort().join(), [...codes].sort().join());
  });

  it('says reading, reviewing or playing depending on the role, and the model-limit text from a retry', () => {
    const issues = [
      running(1, 'analyst'), running(2, 'reviewer'), running(3, 'tester'), running(4, 'developer'),
      queued(5, 'waiting', 'model_hold', { retry: { attempt: 1, due_in_ms: 1000, due_at: UNTIL, kind: 'session_limit', limit: { model: 'sonnet' } } }),
      queued(6, 'waiting', 'model_hold', { model_hold: { model: 'opus', source: 'operator', until: null } }),
      queued(7, 'waiting', 'session_limit', { retry: { attempt: 1, due_in_ms: 1, due_at: UNTIL, kind: 'session_limit', limit: null } }),
    ];
    const p = renderPage(TASKS_HTML, state({ issues, blocked: [] }));
    assert.deepEqual(reasons(p, 'running').map((t) => t.split(' · ')[0]), ['Analyst liest', 'Reviewer prüft', 'Tester prüft', 'Developer spielt']);
    assert.deepEqual(reasons(p, 'waiting'), [`Modell-Limit: Sonnet pausiert bis ${hm(UNTIL)}`, 'Opus von dir pausiert', 'Retry in 1 min · session_limit']);
  });

  it('shows the owner: Mensch for paused, Symphony for waiting and blockers, the role for running', () => {
    const p = renderPage(TASKS_HTML, state());
    const owner = (key: string, i = 0) => text(col(p, key)[i]!.querySelector('.task-owner')!);
    assert.equal(owner('paused'), 'Mensch');
    assert.equal(owner('waiting'), 'Symphony');
    assert.equal(owner('blocked'), 'Symphony');
    assert.equal(owner('blocked', 1), 'Mensch');
    assert.equal(owner('running'), 'Developer');
    const dot = (key: string) => String(col(p, key)[0]!.querySelector('.task-owner-dot')!.style.background).toLowerCase();
    assert.equal(dot('paused'), ROLE_COLORS.human);
    assert.equal(dot('waiting'), ROLE_COLORS.symphony);
    assert.equal(dot('running'), ROLE_COLORS.developer);
  });

  it('offers the action per column: pause, start (place 1 only), again (retry only), resume; none for blocked and done', async () => {
    const p = renderPage(TASKS_HTML, state(), { fetch: fetchWith([finished(50, '2026-10-30T10:00:00Z')], [], state()) });
    await settle();
    p.render(state());
    const labels = (key: string) => p.query(`#col-${key} button`).map(text);
    assert.deepEqual(labels('running'), ['Pausieren']);
    assert.deepEqual(labels('next'), ['Jetzt starten']);
    assert.equal(col(p, 'next')[1]!.querySelectorAll('button').length, 0, 'place 2 has no button');
    assert.deepEqual(labels('waiting'), ['Jetzt erneut'], 'only the retry card');
    assert.deepEqual(labels('paused'), ['Fortsetzen', 'Fortsetzen']);
    assert.equal(p.query('#col-blocked button').length, 0);
    assert.equal(p.query('#col-done button').length, 0);
    assert.equal(p.query('#col-done .task-card').length, 1);
    p.click(p.query('#col-waiting button')[0]!);
    await settle();
    assert.equal(p.fetches.filter((f) => f.method === 'POST').at(-1)!.url, '/api/v1/acme%2Fapp%233/retry');
    p.click(p.query('#col-next button')[0]!);
    await settle();
    assert.equal(p.fetches.filter((f) => f.method === 'POST').at(-1)!.url, '/api/v1/acme%2Fapp%237/force');
  });

  it('renders no button in any column without control', () => {
    const p = renderPage(TASKS_HTML, state({ controls: { retry: false } }));
    assert.equal(p.query('.tasks-grid button').length, 0);
    assert.equal(p.query('.tasks-grid .task-card').length, 10);
  });

  it('shows the finished column from the history: rounds, cost, duration, "gemerged <HH:MM>", owner', async () => {
    const entries = [
      finished(50, '2026-10-30T10:00:00Z', { cost_usd: '0.15', agent_seconds: '30' }),
      finished(50, '2026-10-30T09:00:00Z', { cost_usd: '0.25', agent_seconds: '90' }),
      finished(51, '2026-10-30T08:00:00Z', { state: 'In review', cost_usd: '1.5', agent_seconds: '3700' }),
    ];
    const results = [{ issue: 'acme/app#50', kind: 'review', verdict: 'rejected' }, { issue: 'acme/app#50', kind: 'review', verdict: 'approved' }, { issue: 'acme/app#50', kind: 'implementation', verdict: 'done' }, { issue: 'acme/app#51', kind: 'review', verdict: 'approved' }];
    const p = renderPage(TASKS_HTML, undefined, { fetch: fetchWith(entries, results, state()) });
    await settle();
    const cards = col(p, 'done');
    assert.equal(cards.length, 2);
    assert.equal(text(p.$('col-done-count')), '02');
    assert.equal(text(cards[0]!.querySelector('.task-reason')!), '2 Review-Runden · $0.40 · 2m 0s');
    assert.match(text(cards[0]!.querySelector('.task-place')!), /^gemerged \d{2}:\d{2}$/);
    assert.ok(cards[0]!.querySelector('.task-reason')!.classList.contains('task-tone-done'));
    assert.equal(text(cards[0]!.querySelector('.task-owner')!), 'Reviewer');
    assert.equal(text(cards[1]!.querySelector('.task-reason')!), '1 Review-Runde · $1.50 · 1h 1m');
    assert.ok(!text(cards[1]!.querySelector('.task-place')!).startsWith('gemerged'), 'not merged: In review');
    assert.equal(cards[0]!.querySelector('a.task-title')!.getAttribute('href'), '/issue?id=acme%2Fapp%2350');
  });

  it('shows the last 10 finished issues only', async () => {
    const entries = Array.from({ length: 14 }, (_, i) => finished(200 + i, `2026-10-30T08:${String(10 + i)}:00Z`));
    const p = renderPage(TASKS_HTML, undefined, { fetch: fetchWith(entries, [], state()) });
    await settle();
    assert.equal(col(p, 'done').length, 10);
  });

  it('shows the empty text of every empty column, 12.5px, and keeps them visible', async () => {
    const empty = dashboardState();
    const p = renderPage(TASKS_HTML, empty, { fetch: fetchWith([], [], empty) });
    await settle();
    p.render(empty);
    const texts: string[] = [];
    for (const c of TASK_COLUMNS) {
      const e = p.query(`#col-${c.key} .task-empty`);
      assert.equal(e.length, 1, c.key);
      assert.equal(p.query(`#col-${c.key} .task-card`).length, 0, c.key);
      texts.push(text(e[0]!));
    }
    assert.deepEqual(texts, ['Nichts läuft', 'Nichts in der Warteschlange', 'Nichts wartet', 'Nichts pausiert', 'Nichts blockiert', 'Noch nichts erledigt']);
  });

  it('has no slot forecast', async () => {
    const p = renderPage(TASKS_HTML, state());
    assert.ok(!TASKS_HTML.includes('Slot frei in'));
    assert.ok(!text(p.$('col-next')).includes('Slot frei in'));
    assert.ok(!text(p.$('col-waiting')).includes('Slot frei in'));
  });

  it('rebuilds a card when its text changes (the duration ticks) and keeps it otherwise', () => {
    const p = renderPage(TASKS_HTML, state());
    const first = col(p, 'running')[0];
    p.render(state());
    assert.equal(col(p, 'running')[0], first);
    const later = state();
    later.issues[0].running.seconds_running = 190;
    p.render(later);
    assert.notEqual(col(p, 'running')[0], first);
    assert.equal(text(p.query('#col-running .task-reason')[0]!), 'Developer spielt · Runde 2 · 3m 10s');
  });

  it('truncates the blocker title to 32 characters and omits the brackets for an unknown title', () => {
    const blocked = [{ issue_id: '30', issue_identifier: 'acme/app#30', title: 'x', repo: 'acme/app', state: 'Todo', reason: 'x', reason_code: 'blocked', blocked_by: [{ id: '99', identifier: 'other/lib#99', state: 'Todo' }] }];
    const p = renderPage(TASKS_HTML, state({ blocked }));
    assert.deepEqual(reasons(p, 'blocked'), ['Blocked by #99']);
  });
});
