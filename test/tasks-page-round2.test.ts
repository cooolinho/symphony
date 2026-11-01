import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TASKS_HTML } from '../src/http/tasks-page.ts';
import { renderPage } from './helpers.ts';
import { dashboardState, issueRow } from './helpers/page-fixtures.ts';

// Follow-up tests of E5-1 (#364) for the review fixes: stable cards while the retry countdown ticks,
// date on older "Kürzlich erledigt" entries.

type Obj = Record<string, any>;
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
const text = (n: { textContent: string }) => n.textContent;

const waitingRow = (dueIn: number, attempt = 1): Obj => issueRow({
  issue_id: '3', issue_identifier: 'acme/app#3', title: 'Titel 3', section: 'waiting', status: 'retrying', running: null, stages: [],
  retry: { attempt, due_in_ms: dueIn, due_at: '2026-10-31T10:00:00.000Z', kind: 'failure' }, reason: { code: 'backoff', text: 'x' },
});
const blockedRow = { issue_id: '5', issue_identifier: 'acme/app#5', title: 'Titel 5', repo: 'acme/app', state: 'Todo', reason: 'x', reason_code: 'blocked' };
const st = (over: Obj = {}) => dashboardState({ issues: [waitingRow(60000)], blocked: [blockedRow], retrying: [{ issue_id: '5', attempt: 1, due_in_ms: 60000, due_at: '2026-10-31T10:00:00.000Z', kind: 'failure' }], ...over });

describe('tasks page: review fixes (E5-1)', () => {
  it('keeps the waiting card and its button (focus) when only the retry countdown ticks', () => {
    const p = renderPage(TASKS_HTML, st());
    const card = p.query('#col-waiting .task-card')[0]!;
    const btn = p.query('#col-waiting button')[0]!;
    assert.equal(text(btn), 'Jetzt erneut');
    p.render(st({ issues: [waitingRow(58000)] }));
    assert.equal(p.query('#col-waiting .task-card')[0], card);
    assert.equal(p.query('#col-waiting button')[0], btn);
  });

  it('keeps the blocked card (which has no button) when only the retrying entry countdown ticks', () => {
    const p = renderPage(TASKS_HTML, st());
    const card = p.query('#col-blocked .task-card')[0]!;
    assert.equal(p.query('#col-blocked button').length, 0);
    p.render(st({ retrying: [{ issue_id: '5', attempt: 1, due_in_ms: 1000, due_at: '2026-10-31T10:00:00.000Z', kind: 'failure' }] }));
    assert.equal(p.query('#col-blocked .task-card')[0], card);
  });

  it('still rebuilds the waiting card when the retry minute count changes', () => {
    const p = renderPage(TASKS_HTML, st());
    const card = p.query('#col-waiting .task-card')[0]!;
    p.render(st({ issues: [waitingRow(120000, 2)] }));
    const now = p.query('#col-waiting .task-card')[0]!;
    assert.notEqual(now, card);
    assert.match(text(now), /Retry in 2 min · backoff/);
  });

  it('shows date and time for older finished entries, only the time for today', async () => {
    const NOW = new Date(2026, 9, 30, 15, 0, 0);
    const today = new Date(2026, 9, 30, 12, 34, 56);
    const old = new Date(2026, 0, 5, 7, 8, 9);
    const fin = (n: number, d: Date): Obj => ({ ts: d.toISOString(), event: 'run_finished', issue: `acme/app#${n}`, run: `r${n}`, title: `E${n}`, repo: 'acme/app', outcome: 'handed_off', state: 'Done' });
    const fetch = (url: string) => {
      if (url.includes('event=run_finished')) return { entries: [fin(90, today), fin(91, old)] };
      if (url.includes('/history/')) return { entries: [] };
      return dashboardState({ issues: [], blocked: [], retrying: [] });
    };
    const p = renderPage(TASKS_HTML, dashboardState({ issues: [], blocked: [], retrying: [] }), { fetch, now: NOW.getTime() });
    await settle();
    const cards = p.query('#col-done .task-card');
    assert.equal(cards.length, 2);
    const oldText = text(cards.find((c) => text(c).includes('#91'))!);
    const todayText = text(cards.find((c) => text(c).includes('#90'))!);
    assert.ok(oldText.includes(old.toLocaleString()), `older entry shows full date: ${oldText}`);
    assert.ok(!todayText.includes(today.toLocaleString()), `today shows only the time: ${todayText}`);
    assert.match(todayText, /gemerged 12:34/);
  });
});
