import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TASKS_CSS, TASKS_HTML } from '../src/http/tasks-page.ts';
import { renderPage } from './helpers.ts';
import { dashboardState } from './helpers/page-fixtures.ts';

// E5-3 (#389): title block and glass pill of the Tasks page (slot controller 1..8, model-hold chips).

type Obj = Record<string, any>;
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
const text = (n: { textContent: string }) => n.textContent;
const hm = (iso: string) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const limits = (effective: number, over: Obj = {}): Obj => ({
  ...dashboardState().limits,
  max_concurrent_agents: { effective, workflow: 10, override: null },
  max: 50,
  ...over,
});
const open = (over: Obj = {}) => renderPage(TASKS_HTML, dashboardState(over), { fetch: () => ({ entries: [] }) });
const label = (n: any) => n.getAttribute('aria-label');
const step = (p: ReturnType<typeof open>, name: string) => p.query('#task-pill button').find((b) => label(b) === name)!;

describe('tasks page title block (E5-3)', () => {
  it('has h1 "Tasks", the subtitle and the glass pill in the title row', () => {
    assert.match(TASKS_HTML, /<h1>Tasks<\/h1>/);
    assert.match(TASKS_HTML, /<p class="page-sub">Was läuft, was als Nächstes startet und warum ein Issue wartet<\/p>/);
    assert.match(TASKS_HTML, /<div class="page-title-right"><div class="g task-pill" id="task-pill" role="group" aria-label="Agent-Slots">/);
    assert.ok(!TASKS_HTML.includes('id="tasks-meta"'));
  });

  it('styles the pill: radius 999, padding 8px 12px, gap 10px 16px, wrap; label 13px; count mono 18px, min-width 44px, centred', () => {
    const rule = (sel: string) => TASKS_CSS.match(new RegExp(`${sel.replace('.', '\\.')} \\{([^}]*)\\}`))![1]!;
    assert.match(rule('.task-pill'), /flex-wrap: wrap/);
    assert.match(rule('.task-pill'), /gap: 10px 16px/);
    assert.match(rule('.task-pill'), /padding: 8px 12px/);
    assert.match(rule('.task-pill'), /border-radius: 999px/);
    assert.match(rule('.task-pill-label'), /font-size: 13px/);
    assert.match(rule('.task-pill-label'), /var\(--fg-2/);
    assert.match(rule('.task-slot-count'), /font: 18px var\(--mono\)/);
    assert.match(rule('.task-slot-count'), /min-width: 44px/);
    assert.match(rule('.task-slot-count'), /text-align: center/);
  });

  it('shows "<occupied> / <total>" in an aria-live region (forced sessions do not count)', () => {
    assert.equal(open().$('task-slot-count').getAttribute('aria-live'), 'polite');
    assert.match(TASKS_HTML, /id="task-slot-count" aria-live="polite"/);
    const p = open({ limits: limits(3), counts: { ...dashboardState().counts, running: 3, forced: 1 } });
    assert.equal(text(p.$('task-slot-count')), '2 / 3');
    p.render(dashboardState({ limits: limits(4), counts: { ...dashboardState().counts, running: 4, forced: 0 } }));
    assert.equal(text(p.$('task-slot-count')), '4 / 4');
  });

  it('keeps the live count node when the text does not change', () => {
    const p = open({ limits: limits(3) });
    const node = p.$('task-slot-count');
    p.render(dashboardState({ limits: limits(3) }));
    assert.equal(p.$('task-slot-count'), node);
  });

  it('has − and + with aria-labels around the count and disables them at 1 and 8', async () => {
    const p = open({ limits: limits(3) });
    assert.deepEqual(p.query('#task-pill button').map(label), ['Einen Slot weniger', 'Einen Slot mehr']);
    assert.deepEqual(p.query('#task-pill button').map(text), ['−', '+']);
    assert.equal(step(p, 'Einen Slot weniger').disabled, false);
    assert.equal(step(p, 'Einen Slot mehr').disabled, false);
    p.click(step(p, 'Einen Slot mehr'));
    assert.deepEqual(p.fetches.at(-1), { url: '/api/v1/settings/agents', method: 'PUT', body: { max_concurrent_agents: 4 } });
    await settle();
    p.render(dashboardState({ limits: limits(3) }));
    p.click(step(p, 'Einen Slot weniger'));
    assert.deepEqual(p.fetches.at(-1)!.body, { max_concurrent_agents: 2 });
    await settle();

    const low = open({ limits: limits(1) });
    assert.equal(step(low, 'Einen Slot weniger').disabled, true);
    assert.equal(step(low, 'Einen Slot mehr').disabled, false);
    const n = low.fetches.length;
    low.click(step(low, 'Einen Slot weniger'));
    assert.equal(low.fetches.length, n, 'a disabled click sends nothing');

    const high = open({ limits: limits(8) });
    assert.equal(step(high, 'Einen Slot mehr').disabled, true);
    assert.equal(step(high, 'Einen Slot weniger').disabled, false);
    assert.equal(text(high.$('task-slot-count')), '1 / 8');
  });

  it('shows a total above 8 and steps down to 8 at most', () => {
    const p = open({ limits: limits(10) });
    assert.equal(text(p.$('task-slot-count')), '1 / 10');
    assert.equal(step(p, 'Einen Slot mehr').disabled, true);
    p.click(step(p, 'Einen Slot weniger'));
    assert.deepEqual(p.fetches.at(-1)!.body, { max_concurrent_agents: 8 });
  });

  it('shows an amber chip per model hold and one green chip with the active models', () => {
    const until = '2026-10-30T14:00:00Z';
    const p = open({
      model_controls: [{ model: 'opus', paused: false, limit_until: until }, { model: 'sonnet', paused: false, limit_until: null }, { model: 'haiku', paused: false, limit_until: null }],
      model_holds: [{ model: 'opus', source: 'limit', until, since: '2026-10-30T11:00:00Z', issue_identifier: 'acme/app#2', text: 'weekly limit' }],
    });
    const chips = p.query('#task-pill-chips .ui-chip');
    assert.deepEqual(chips.map(text), [`Opus pausiert · Limit bis ${hm(until)}`, 'Sonnet · Haiku aktiv']);
    assert.match(String(chips[0]!.style.color), /^#/);
    const amber = chips[0]!.style.borderColor;
    const green = chips[1]!.style.borderColor;
    assert.notEqual(amber, green);
    assert.match(String(amber), /251,191,36/);
    assert.match(String(green), /52,211,153/);
  });

  it('shows only the green chip without holds, and no chip without models', () => {
    const p = open({ model_controls: [{ model: 'opus', paused: false, limit_until: null }, { model: 'sonnet', paused: false, limit_until: null }], model_holds: [] });
    assert.deepEqual(p.query('#task-pill-chips .ui-chip').map(text), ['Opus · Sonnet aktiv']);
    assert.equal(open().query('#task-pill-chips .ui-chip').length, 0);
  });

  it('shows an operator pause without a time', () => {
    const p = open({
      model_controls: [{ model: 'opus', paused: true, limit_until: null }],
      model_holds: [{ model: 'opus', source: 'operator', until: null, since: '2026-10-30T11:00:00Z', issue_identifier: null, text: 'paused by the operator' }],
    });
    assert.deepEqual(p.query('#task-pill-chips .ui-chip').map(text), ['Opus pausiert']);
  });

  it('is display only without control: count and chips stay, buttons go, the notice shows', () => {
    const p = open({
      controls: { retry: false },
      limits: limits(3),
      model_controls: [{ model: 'opus', paused: false, limit_until: null }],
    });
    assert.equal(p.query('#task-pill button').length, 0);
    assert.equal(text(p.$('task-slot-count')), '1 / 3');
    assert.deepEqual(p.query('#task-pill-chips .ui-chip').map(text), ['Opus aktiv']);
    assert.equal(p.$('tasks-controls-off').hidden, false);
    const on = open({ limits: limits(3) });
    assert.equal(on.query('#task-pill button').length, 2);
    on.render(dashboardState({ limits: limits(3), controls: { retry: false } }));
    assert.equal(on.query('#task-pill button').length, 0);
  });

  it('falls back to the dispatcher maximum without limits and shows no buttons', () => {
    const p = open({ limits: null });
    assert.equal(text(p.$('task-slot-count')), '1 / 10');
    assert.equal(p.query('#task-pill button').length, 0);
  });

  it('keeps the error state visible when the orchestrator is unreachable', async () => {
    const p = renderPage(TASKS_HTML, undefined, { fetch: (url: string) => { if (url.includes('/state')) throw new Error('down'); return { entries: [] }; } });
    await settle();
    assert.equal(p.$('tasks-error').hidden, false);
    assert.equal(text(p.$('tasks-error')), 'Orchestrator nicht erreichbar');
    p.render(dashboardState());
    assert.equal(p.$('tasks-error').hidden, true);
  });

  it('keeps column limits, reservations and the model pause in the details block', () => {
    const p = open({
      limits: limits(3, { by_state: { 'In progress': { effective: 2, workflow: 4, override: 2 } } }),
      model_controls: [{ model: 'opus', paused: false, limit_until: null }],
    });
    assert.equal(p.$('task-more').hidden, false);
    assert.equal(p.$('task-more').tagName.toLowerCase(), 'details');
    assert.ok(p.query('#task-more button.task-slot-step').length >= 2);
    assert.equal(p.query('#task-more button.task-model').length, 1);
    assert.equal(open({ limits: null, model_controls: [] }).$('task-more').hidden, true);
  });
});
