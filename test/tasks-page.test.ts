import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { startHttpServer, type HttpServerHandle } from '../src/http/server.ts';
import { REASON_LABELS, TASKS_CSS, TASKS_HTML, TASK_COLUMNS } from '../src/http/tasks-page.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, renderPage, tempDir } from './helpers.ts';
import { dashboardState, issueRow } from './helpers/page-fixtures.ts';

function request(port: number, method: string, path: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

type Obj = Record<string, any>;
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
const row = (n: number, over: Obj = {}): Obj => issueRow({ issue_id: String(n), issue_identifier: `acme/app#${n}`, title: `Issue ${n}`, ...over });

function fixture(over: Obj = {}): Obj {
  return dashboardState({
    issues: [
      row(1),
      row(2, { section: 'next', status: 'queued', running: null, position: 1, priority: 2, reason: { code: 'no_free_slot', text: 'x' } }),
      row(3, { section: 'waiting', status: 'retrying', running: null, retry: { attempt: 2, due_in_ms: 60000, kind: 'failure' }, reason: { code: 'backoff', text: 'x' } }),
      row(4, { section: 'paused', status: 'paused', running: null, paused: { source: 'operator' }, reason: { code: 'paused', text: 'x' } }),
    ],
    blocked: [{ issue_id: '5', issue_identifier: 'acme/app#5', title: 'Issue 5', repo: 'acme/app', state: 'Todo', reason: 'x', reason_code: 'blocked' }],
    retrying: [{ issue_id: '5' }],
    ...over,
  });
}

const historyFetch = (finished: Obj[], results: Obj[] = []) => (url: string) => {
  if (url.includes('event=run_finished')) return { entries: finished };
  if (url.includes('event=stage_result')) return { entries: results };
  return url.includes('/state') ? fixture() : {};
};

const text = (n: { textContent: string }) => n.textContent;

describe('tasks page (E5-1)', () => {
  it('has six columns in order and a one-column layout at 640px', () => {
    const titles = [...TASKS_HTML.matchAll(/<h2 id="col-\w+-title">([^<]+)<\/h2>/g)].map((m) => m[1]);
    assert.deepEqual(titles, ['Läuft', 'Als Nächstes', 'Wartet', 'Pausiert', 'Blockiert', 'Kürzlich erledigt']);
    assert.equal((TASKS_HTML.match(/class="task-col"/g) ?? []).length, 6);
    assert.ok(TASKS_CSS.includes('repeat(6'));
    assert.match(TASKS_CSS, /@media \(max-width: 640px\) \{ \.tasks-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  });

  it('covers every plan reason code with a German text', () => {
    assert.equal(Object.keys(REASON_LABELS).length, 13);
    for (const label of Object.values(REASON_LABELS)) assert.ok(label.length > 3);
  });

  it('shows the empty text in every empty column, counters at 00', async () => {
    const p = renderPage(TASKS_HTML, dashboardState(), { fetch: historyFetch([]) });
    await settle();
    p.render(dashboardState());
    for (const c of TASK_COLUMNS) {
      const empties = p.query(`#col-${c.key} .task-empty`);
      assert.equal(empties.length, 1, c.key);
      assert.equal(text(empties[0]!), c.empty);
      assert.equal(text(p.$(`col-${c.key}-count`)), '00');
    }
  });

  it('renders one card per column with the right action and posts to the existing routes', async () => {
    const p = renderPage(TASKS_HTML, fixture(), { fetch: historyFetch([]) });
    const expected: Array<[string, string, string]> = [
      ['running', 'Pausieren', 'pause'], ['next', 'Jetzt starten', 'force'], ['waiting', 'Erneut versuchen', 'retry'],
      ['paused', 'Fortsetzen', 'resume'], ['blocked', 'Erneut versuchen', 'retry'],
    ];
    const ids = [1, 2, 3, 4, 5];
    for (const [i, [col, label, verb]] of expected.entries()) {
      assert.equal(p.query(`#col-${col} .task-card`).length, 1, col);
      const buttons = p.query(`#col-${col} button`);
      assert.equal(buttons.length, 1, col);
      assert.equal(text(buttons[0]!), label);
      p.click(buttons[0]!);
      await settle();
      const post = p.fetches.filter((f) => f.method === 'POST').at(-1)!;
      assert.equal(post.url, `/api/v1/acme%2Fapp%23${ids[i]}/${verb}`);
    }
  });

  it('shows number, title link, repo, place, reason chip with code title and role', () => {
    const p = renderPage(TASKS_HTML, fixture());
    const card = p.query('#col-next .task-card')[0]!;
    assert.ok(text(card).includes('#2'));
    const link = p.query('#col-next .task-title')[0]!;
    assert.equal(link.getAttribute('href'), '/issue?id=acme%2Fapp%232');
    assert.ok(text(card).includes('acme/app'));
    assert.ok(text(card).includes('Platz 1'));
    const chip = p.query('#col-next .ui-chip').find((c) => text(c).includes('Kein freier Slot'))!;
    assert.equal(chip.getAttribute('title'), 'no_free_slot');
    assert.ok(text(p.query('#col-running .task-role')[0]!).length > 0);
    assert.ok(text(p.query('#col-waiting .task-note')[0]!).includes('Versuch 2'));
  });

  it('offers no button for waiting without retry and next on model hold', () => {
    const state = fixture({
      issues: [
        row(3, { section: 'waiting', status: 'queued', running: null, retry: null, reason: { code: 'inactive', text: 'x' } }),
        row(2, { section: 'next', status: 'queued', running: null, position: 1, reason: { code: 'model_hold', text: 'x' } }),
      ],
      blocked: [],
      retrying: [],
    });
    const p = renderPage(TASKS_HTML, state);
    assert.equal(p.query('.tasks-grid button').length, 0);
  });

  it('renders no buttons without controls.retry and shows the notice', () => {
    const p = renderPage(TASKS_HTML, fixture({ controls: { retry: false } }));
    assert.equal(p.query('.tasks-grid button').length, 0);
    assert.equal(p.query('.tasks-grid .task-card').length, 5);
    assert.ok(!p.$('tasks-controls-off').hidden);
    const on = renderPage(TASKS_HTML, fixture());
    assert.ok(on.$('tasks-controls-off').hidden);
  });

  it('announces the result of an action in the aria-live region', async () => {
    const p = renderPage(TASKS_HTML, fixture(), { fetch: historyFetch([]) });
    assert.equal(p.$('announce').getAttribute('aria-live'), 'polite');
    p.click(p.query('#col-running button')[0]!);
    await settle();
    assert.equal(text(p.$('announce')), 'acme/app#1: Pausiert');
  });

  it('lists the last 10 finished issues, newest first, one per issue, without active ones', async () => {
    const finished: Obj[] = [];
    for (let n = 10; n < 22; n++) finished.push({ ts: `2026-10-30T10:${String(n).padStart(2, '0')}:00.000Z`, event: 'run_finished', issue: `acme/app#${n}`, run: `r${n}`, title: `T${n}`, repo: 'acme/app', outcome: 'handed_off', state: 'Done' });
    finished.push({ ts: '2026-10-30T09:00:00.000Z', event: 'run_finished', issue: 'acme/app#21', run: 'old', title: 'T21', repo: 'acme/app', outcome: 'failed', state: 'Todo' });
    finished.push({ ts: '2026-10-30T11:59:00.000Z', event: 'run_finished', issue: 'acme/app#1', run: 'act', title: 'Issue 1', repo: 'acme/app', outcome: 'continuing', state: 'In progress' });
    const p = renderPage(TASKS_HTML, undefined, { fetch: (u) => (u.includes('event=run_finished') ? { entries: finished } : u.includes('event=stage_result') ? { entries: [{ run: 'r21', verdict: 'approved' }] } : fixture()) });
    await settle();
    const cards = p.query('#col-done .task-card');
    assert.equal(cards.length, 10);
    assert.ok(text(cards[0]!).includes('#21'));
    assert.ok(text(cards[0]!).includes('approved'));
    assert.ok(text(cards[0]!).includes('→ Done'));
    assert.ok(!p.query('#col-done .task-title').some((t) => text(t) === 'Issue 1'));
    assert.equal(new Set(p.query('#col-done .task-num').map(text)).size, 10);
  });

  it('shows a text instead of crashing when the history is unreachable', async () => {
    const p = renderPage(TASKS_HTML, undefined, { fetch: (u) => { if (u.includes('/history/')) throw new Error('down'); return fixture(); } });
    await settle();
    assert.equal(text(p.query('#col-done .task-empty')[0]!), 'History nicht erreichbar');
    assert.equal(p.query('#col-running .task-card').length, 1);
  });

  it('does not rebuild a card when an identical state is rendered again', () => {
    const p = renderPage(TASKS_HTML, fixture());
    const first = p.query('#col-next .task-card')[0];
    p.render(fixture());
    assert.equal(p.query('#col-next .task-card')[0], first);
  });

  it('polls every 2 s and attaches to the live events', () => {
    assert.ok(TASKS_HTML.includes('pollEvery(taskLoad, 2000)'));
    assert.ok(TASKS_HTML.includes('live(taskLoad'));
  });

  it('is linked from the overview, whose queue, blocked and slot sections moved here (E5-2)', () => {
    assert.ok(DASHBOARD_HTML.includes('<a class="section-link" href="/tasks">Alle Tasks</a>'));
    assert.doesNotMatch(DASHBOARD_HTML, /id="(slot-settings|slots|model-controls|next-section|waiting-section|paused-section|blocked-section)"/);
  });

  describe('GET /tasks', () => {
    let server: HttpServerHandle;
    before(async () => {
      const orchestrator = new Orchestrator({
        workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
        runner: new FakeRunner(),
        logger: Logger.silent(),
        env: {},
        logDir: null,
        timers: new ManualTimers(),
        createAdapter: () => new FakeTracker(),
      });
      server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    });
    after(async () => { await server.close(); });

    it('serves the page with the six columns', async () => {
      const res = await request(server.port, 'GET', '/tasks');
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'] ?? '', /text\/html/);
      assert.ok(res.body.includes('href="/tasks" aria-current="page"'));
      for (const c of TASK_COLUMNS) assert.ok(res.body.includes(`>${c.title}</h2>`), c.title);
      assert.ok(!res.body.includes('Diese Seite kommt in Kürze.'));
    });
  });
});

describe('Steuerung im Kopf (E5-2)', () => {
  const limits = (over: Obj = {}): Obj => ({ ...dashboardState().limits, override_active: true, max_concurrent_agents: { effective: 3, workflow: 10, override: 3 }, ...over });
  const open = async (over: Obj = {}) => {
    const p = renderPage(TASKS_HTML, fixture(over), { fetch: historyFetch([]) });
    await settle();
    p.render(fixture(over));
    return p;
  };
  const last = (p: Awaited<ReturnType<typeof open>>) => p.fetches.at(-1)!;

  it('lets the operator step the total, reset to WORKFLOW.md and announces the result', async () => {
    const p = await open({ limits: limits() });
    assert.equal(p.$('task-slots').hidden, false);
    assert.equal(text(p.query('#task-slots button.task-slot-reset')[0]!), 'Auf WORKFLOW.md zurücksetzen (10)');
    assert.match(text(p.$('task-slots')), /Slots gesamt/);
    const more = p.query('button.task-slot-step').find((b) => b.getAttribute('aria-label') === 'Mehr Agent-Slots')!;
    p.click(more);
    assert.deepEqual(last(p), { url: '/api/v1/settings/agents', method: 'PUT', body: { max_concurrent_agents: 4 } });
    await settle();
    assert.equal(text(p.$('announce')), 'Agent-Slots: gespeichert');
    const again = await open({ limits: limits() });
    again.click(again.query('button.task-slot-reset')[0]!);
    assert.deepEqual([last(again).url, last(again).method], ['/api/v1/settings/agents', 'DELETE']);
    await settle();
    assert.equal(text(again.$('announce')), 'Agent-Slots: auf WORKFLOW.md zurückgesetzt');
  });

  it('steps columns and reserved roles with the unchanged request bodies', async () => {
    const p = await open({
      limits: limits({
        by_state: { 'In progress': { effective: 2, workflow: 4, override: 2 } },
        reserved_slots_by_role: { reviewer: { effective: 1, workflow: 0, override: 1, running: 0 } },
      }),
    });
    const click = async (label: string) => { p.click(p.query('button.task-slot-step').find((b) => b.getAttribute('aria-label') === label)!); await settle(); };
    await click('Limit von In progress erhöhen');
    assert.deepEqual(last(p).body, { max_concurrent_agents_by_state: { 'In progress': 3 } });
    await click('WORKFLOW.md-Limit für In progress verwenden');
    assert.deepEqual(last(p).body, { max_concurrent_agents_by_state: { 'In progress': null } });
    await click('Einen Slot mehr für reviewer reservieren');
    assert.deepEqual(last(p).body, { reserved_slots_by_role: { reviewer: 2 } });
    await click('WORKFLOW.md-Reservierung für reviewer verwenden');
    assert.deepEqual(last(p).body, { reserved_slots_by_role: { reviewer: null } });
    assert.match(text(p.$('task-slots')), /reviewer reserviert/);
  });

  it('shows the values but no buttons without control_allowed', async () => {
    const p = await open({ limits: limits(), controls: { retry: false }, model_controls: [{ model: 'opus', paused: false, limit_until: null }] });
    assert.equal(p.query('button.task-slot-step').length, 0);
    assert.equal(p.query('button.task-slot-reset').length, 0);
    assert.equal(p.query('button.task-model').length, 0);
    assert.match(text(p.$('task-slots')), /Slots gesamt\s*3/);
    assert.equal(p.$('tasks-controls-off').hidden, false);
    assert.equal(p.query('#task-hold-list li').length, 1);
  });

  it('warns when the limit is lowered below the running count and counts forced sessions', async () => {
    const low = await open({ limits: limits({ max_concurrent_agents: { effective: 1, workflow: 10, override: 1 } }), counts: { ...dashboardState().counts, running: 3 } });
    assert.match(text(low.$('task-slots')), /3 laufen, Limit 1: keine neuen Starts, bis 3 fertig sind/);
    const forced = await open({ counts: { ...dashboardState().counts, running: 2, forced: 1 } });
    assert.match(text(forced.$('task-slots')), /02 \/ 10 belegt, 1 erzwungen/);
  });

  it('hides the slot group without limits and the model block without models', async () => {
    const p = await open({ limits: null });
    assert.equal(p.$('task-slots').hidden, true);
    assert.equal(p.$('task-holds').hidden, true);
  });

  it('lists family, reason and reset time of a held model and posts pause and resume', async () => {
    const until = '2026-10-30T14:00:00Z';
    const hold = { model: 'opus', source: 'limit', until, since: '2026-10-30T11:00:00Z', issue_identifier: 'acme/app#2', text: 'weekly limit' };
    const p = await open({ model_controls: [{ model: 'opus', paused: false, limit_until: until }], model_holds: [hold] });
    assert.equal(p.$('task-holds').hidden, false);
    const [li] = p.query('#task-hold-list li');
    assert.match(text(li!), /opus.*weekly limit · ausgelöst von acme\/app#2.*Reset /);
    p.click(p.query('button.task-model')[0]!);
    assert.deepEqual(last(p), { url: '/api/v1/models/opus/hold', method: 'POST' });
    await settle();
    assert.equal(text(p.$('announce')), 'Modell opus: pausiert');
    const paused = await open({ model_controls: [{ model: 'opus', paused: true, limit_until: null }] });
    assert.match(text(paused.query('#task-hold-list li')[0]!), /vom Operator pausiert.*bis zur Freigabe/);
    assert.equal(text(paused.query('button.task-model')[0]!), 'Fortsetzen');
    paused.click(paused.query('button.task-model')[0]!);
    assert.equal(last(paused).url, '/api/v1/models/opus/release');
  });

  it('uses German texts only', () => {
    for (const old of ['Reset to WORKFLOW.md', 'More agent slots', 'set here', 'Fewer agent slots']) assert.ok(!TASKS_HTML.includes(old), old);
  });
});
