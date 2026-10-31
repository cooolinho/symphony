import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { startHttpServer } from '../src/http/server.ts';
import { TASKS_HTML } from '../src/http/tasks-page.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, renderPage, tempDir } from './helpers.ts';
import { dashboardState, issueRow } from './helpers/page-fixtures.ts';

// Independent tests of E5-2 (#370), derived from the issue: slot controls and model holds moved to the head of /tasks,
// the overview keeps one compact line. The first block characterizes the unchanged endpoints (green on the base commit too).

type Obj = Record<string, any>;
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
const text = (n: { textContent: string }) => n.textContent;

function request(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: method === 'GET' ? {} : { 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

describe('endpoints stay unchanged (characterization, E5-2)', () => {
  const setup = () =>
    new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), { agent: { max_concurrent_agents: 2, max_concurrent_agents_by_state: { todo: 1 } } }))),
      runner: new FakeRunner(),
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker(),
    });

  it('PUT sets the total, a column limit and a reservation; DELETE resets them', async () => {
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator: setup(), logger: Logger.silent() });
    try {
      const limits = async () => JSON.parse((await request(server.port, 'GET', '/api/v1/state')).body).limits;
      const put = (body: unknown) => request(server.port, 'PUT', '/api/v1/settings/agents', body);
      assert.equal((await put({ max_concurrent_agents: 4 })).status, 200);
      assert.deepEqual((await limits()).max_concurrent_agents, { effective: 4, workflow: 2, override: 4 });
      assert.equal((await put({ max_concurrent_agents_by_state: { Todo: 3 } })).status, 200);
      assert.equal((await limits()).by_state.Todo.effective, 3);
      assert.equal((await put({ max_concurrent_agents_by_state: { Todo: null } })).status, 200);
      assert.equal((await limits()).by_state.Todo.override, null);
      assert.equal((await limits()).override_active, true);
      const del = await request(server.port, 'DELETE', '/api/v1/settings/agents');
      assert.equal(del.status, 200);
      const after = await limits();
      assert.deepEqual(after.max_concurrent_agents, { effective: 2, workflow: 2, override: null });
      assert.equal(after.override_active, false);
      assert.equal((await put({ max_concurrent_agents: -1 })).status >= 400, true);
    } finally {
      await server.close();
    }
  });

  it('POST /models/<family>/hold and /release pause and resume a model, other methods are refused', async () => {
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator: setup(), logger: Logger.silent() });
    try {
      assert.equal((await request(server.port, 'POST', '/api/v1/models/fable/hold')).status, 202);
      const state = JSON.parse((await request(server.port, 'GET', '/api/v1/state')).body);
      assert.equal(state.model_controls.find((m: Obj) => m.model === 'fable')?.paused, true);
      assert.equal((await request(server.port, 'POST', '/api/v1/models/fable/release')).status, 202);
      assert.equal((await request(server.port, 'GET', '/api/v1/models/fable/hold')).status, 405);
      assert.equal((await request(server.port, 'POST', '/api/v1/models/nope/hold')).status, 400);
    } finally {
      await server.close();
    }
  });
});

describe('tasks page head: slot controls (E5-2)', () => {
  const limits = (over: Obj = {}): Obj => ({
    ...dashboardState().limits,
    override_active: true,
    max_concurrent_agents: { effective: 3, workflow: 10, override: 3 },
    by_state: {
      'In progress': { effective: 2, workflow: 4, override: 2 },
      Review: { effective: null, workflow: null, override: null },
    },
    reserved_slots_by_role: { reviewer: { effective: 1, workflow: 1, override: null, running: 0 } },
    ...over,
  });
  const open = async (over: Obj = {}, opts: Obj = {}) => {
    const state = dashboardState({ limits: limits(), ...over });
    const p = renderPage(TASKS_HTML, state, { fetch: () => ({ entries: [] }), ...opts });
    await settle();
    p.render(state);
    return p;
  };
  const stepByLabel = (p: Awaited<ReturnType<typeof open>>, label: string) => p.query('button.task-slot-step').find((b) => b.getAttribute('aria-label') === label);
  const posts = (p: Awaited<ReturnType<typeof open>>) => p.fetches.filter((f) => f.url === '/api/v1/settings/agents');

  it('renders the total, every column and every reserved role with −, value and +', async () => {
    const p = await open();
    const root = p.$('task-slots');
    assert.equal(root.hidden, false);
    const items = p.query('#task-slots .task-slot-item');
    const withLabel = (needle: string) => items.find((i) => text(i).startsWith(needle))!;
    for (const [needle, minus, plus] of [
      ['Slots gesamt', 'Weniger Agent-Slots', 'Mehr Agent-Slots'],
      ['In progress', 'Limit von In progress senken', 'Limit von In progress erhöhen'],
      ['reviewer reserviert', 'Weniger Slots für reviewer reservieren', 'Einen Slot mehr für reviewer reservieren'],
    ] as const) {
      const item = withLabel(needle);
      assert.ok(item, needle);
      const labels = item.querySelectorAll('button').map((b: any) => b.getAttribute('aria-label'));
      assert.ok(labels.includes(minus), minus);
      assert.ok(labels.includes(plus), plus);
      assert.equal(item.querySelectorAll('b').length, 1, `${needle} shows one value`);
    }
    assert.match(text(withLabel('Slots gesamt')), /3/);
    assert.match(text(withLabel('reviewer')), /reviewer reserviert/);
    assert.match(text(withLabel('Review')), /–/, 'an unlimited column shows a dash');
  });

  it('sends the unchanged bodies for the total, a column, an unset column and a role', async () => {
    const p = await open();
    const cases: Array<[string, Obj]> = [
      ['Weniger Agent-Slots', { max_concurrent_agents: 2 }],
      ['Mehr Agent-Slots', { max_concurrent_agents: 4 }],
      ['Limit von In progress senken', { max_concurrent_agents_by_state: { 'In progress': 1 } }],
      ['Limit 1 für Review setzen', { max_concurrent_agents_by_state: { Review: 1 } }],
      ['Weniger Slots für reviewer reservieren', { reserved_slots_by_role: { reviewer: 0 } }],
    ];
    for (const [label, body] of cases) {
      const before = posts(p).length;
      p.click(stepByLabel(p, label)!);
      await settle();
      assert.equal(posts(p).length, before + 1, label);
      assert.deepEqual(posts(p).at(-1), { url: '/api/v1/settings/agents', method: 'PUT', body }, label);
    }
  });

  it('keeps − disabled at the lower bounds and + at the upper bound, and a disabled click sends nothing', async () => {
    const p = await open({
      limits: limits({
        max_concurrent_agents: { effective: 0, workflow: 10, override: 0 },
        by_state: { 'In progress': { effective: 1, workflow: 1, override: null } },
        reserved_slots_by_role: { reviewer: { effective: 0, workflow: 0, override: null, running: 0 } },
      }),
    });
    for (const label of ['Weniger Agent-Slots', 'Limit von In progress senken', 'Weniger Slots für reviewer reservieren']) {
      const b = stepByLabel(p, label)!;
      assert.equal(b.disabled, true, label);
      p.click(b);
    }
    assert.equal(posts(p).length, 0);
    const top = await open({ limits: limits({ max_concurrent_agents: { effective: 50, workflow: 10, override: 50 } }) });
    assert.equal(stepByLabel(top, 'Mehr Agent-Slots')!.disabled, true);
  });

  it('resets with DELETE and no body, only while an override is active', async () => {
    const p = await open();
    const reset = p.query('button.task-slot-reset');
    assert.equal(reset.length, 1);
    assert.match(text(reset[0]!), /^Auf WORKFLOW\.md zurücksetzen/);
    p.click(reset[0]!);
    await settle();
    assert.deepEqual(posts(p).at(-1), { url: '/api/v1/settings/agents', method: 'DELETE' });
    const plain = await open({ limits: limits({ override_active: false, max_concurrent_agents: { effective: 10, workflow: 10, override: null }, by_state: {}, reserved_slots_by_role: {} }) });
    assert.equal(plain.query('button.task-slot-reset').length, 0);
    assert.match(text(plain.$('task-slots')), /Slots gesamt\D*10/);
  });

  it('shows the override hint and the × to fall back to WORKFLOW.md per entry', async () => {
    const p = await open({ limits: limits({ reserved_slots_by_role: { reviewer: { effective: 2, workflow: 1, override: 2, running: 0 } } }) });
    assert.match(text(p.$('task-slots')), /hier gesetzt/);
    p.click(stepByLabel(p, 'WORKFLOW.md-Reservierung für reviewer verwenden')!);
    await settle();
    assert.deepEqual(posts(p).at(-1)!.body, { reserved_slots_by_role: { reviewer: null } });
  });

  it('shows the values and no buttons at all when control is not allowed, and says so', async () => {
    const p = await open({ controls: { retry: false } });
    assert.equal(p.query('#task-slots button').length, 0);
    assert.equal(p.$('tasks-controls-off').hidden, false);
    const t = text(p.$('task-slots'));
    assert.match(t, /Slots gesamt\s*3/);
    assert.match(t, /In progress\s*2/);
    assert.match(t, /reviewer reserviert\s*1/);
    p.click(p.$('task-slots'));
    assert.equal(posts(p).length, 0);
    const on = await open();
    assert.equal(on.$('tasks-controls-off').hidden, true);
    assert.ok(on.query('#task-slots button').length > 0);
  });

  it('reacts to a state that withdraws control: buttons vanish on the next render', async () => {
    const p = await open();
    assert.ok(p.query('button.task-slot-step').length > 0);
    p.render(dashboardState({ limits: limits(), controls: { retry: false } }));
    assert.equal(p.query('button.task-slot-step').length, 0);
    assert.equal(p.query('button.task-slot-reset').length, 0);
  });

  it('announces success and failure in German through the aria-live region', async () => {
    assert.match(TASKS_HTML, /id="announce"[^>]*aria-live="polite"/);
    const ok = await open();
    ok.click(stepByLabel(ok, 'Mehr Agent-Slots')!);
    await settle();
    assert.equal(text(ok.$('announce')), 'Agent-Slots: gespeichert');
    const failing = await open({}, { fetch: (url: string) => { if (url === '/api/v1/settings/agents') throw new Error('offline'); return { entries: [] }; } });
    failing.click(stepByLabel(failing, 'Mehr Agent-Slots')!);
    await settle();
    assert.equal(text(failing.$('announce')), 'Agent-Slots: fehlgeschlagen');
  });

  it('warns about a total of 0, below the running count and about all-reserved slots', async () => {
    const zero = await open({ limits: limits({ max_concurrent_agents: { effective: 0, workflow: 10, override: 0 } }), counts: { ...dashboardState().counts, running: 0 } });
    assert.match(text(zero.$('task-slots')), /Limit 0: neue Starts pausiert/);
    const one = await open({ limits: limits({ max_concurrent_agents: { effective: 2, workflow: 10, override: 2 } }), counts: { ...dashboardState().counts, running: 3 } });
    assert.match(text(one.$('task-slots')), /3 laufen, Limit 2: keine neuen Starts, bis 2 fertig sind/);
    const all = await open({
      limits: limits({
        max_concurrent_agents: { effective: 2, workflow: 2, override: null },
        reserved_slots_by_role: { reviewer: { effective: 2, workflow: 2, override: null, running: 0 }, developer: { effective: 0, workflow: 0, override: null, running: 0 } },
      }),
    });
    assert.match(text(all.$('task-slots')), /Alle Slots reserviert: developer starten nur mit mehr Slots/);
  });

  it('hides the group without limits', async () => {
    const p = await open({ limits: null });
    assert.equal(p.$('task-slots').hidden, true);
  });

  it('puts the steering area into the head, above the columns', () => {
    const slots = TASKS_HTML.indexOf('id="task-slots"');
    const holds = TASKS_HTML.indexOf('id="task-holds"');
    const grid = TASKS_HTML.indexOf('class="tasks-grid"');
    assert.ok(slots > TASKS_HTML.indexOf('id="tasks-meta"'), 'after the title');
    assert.ok(slots < grid && holds < grid, 'before the grid');
    assert.match(TASKS_HTML, /id="task-slots"[^>]*aria-label="Agent-Slots"/);
  });
});

describe('tasks page head: model holds (E5-2)', () => {
  const until = '2026-10-30T14:00:00Z';
  const hold = (over: Obj = {}) => ({ model: 'opus', source: 'limit', until, since: '2026-10-30T11:00:00Z', issue_identifier: 'acme/app#2', text: 'weekly limit', ...over });
  const open = async (over: Obj = {}) => {
    const state = dashboardState(over);
    const p = renderPage(TASKS_HTML, state, { fetch: () => ({ entries: [] }) });
    await settle();
    p.render(state);
    return p;
  };

  it('lists family, reason and reset time of every held model, and nothing else', async () => {
    const p = await open({
      model_controls: [{ model: 'opus', paused: false, limit_until: until }, { model: 'sonnet', paused: true, limit_until: null }, { model: 'haiku', paused: false, limit_until: null }],
      model_holds: [hold()],
    });
    const items = p.query('#task-hold-list li');
    assert.equal(items.length, 3);
    assert.match(text(items[0]!), /opus.*weekly limit · ausgelöst von acme\/app#2.*Reset /);
    assert.match(text(items[1]!), /sonnet.*vom Operator pausiert.*bis zur Freigabe/);
    assert.match(text(items[2]!), /haiku.*läuft/);
    assert.doesNotMatch(text(items[2]!), /Reset/);
  });

  it('falls back to "Modell-Limit" without hold text and escapes hostile text', async () => {
    const p = await open({
      model_controls: [{ model: 'opus', paused: false, limit_until: until }],
      model_holds: [hold({ text: '', issue_identifier: null })],
    });
    assert.match(text(p.query('#task-hold-list li')[0]!), /Modell-Limit/);
    const evil = await open({
      model_controls: [{ model: 'opus', paused: false, limit_until: until }],
      model_holds: [hold({ text: '<img src=x onerror=alert(1)>' })],
    });
    assert.equal(evil.query('#task-hold-list img').length, 0);
    assert.match(text(evil.query('#task-hold-list li')[0]!), /<img src=x/);
  });

  it('shows no empty block without models', async () => {
    const p = await open({ model_controls: [], model_holds: [] });
    assert.equal(p.$('task-holds').hidden, true);
    assert.equal(p.query('#task-hold-list li').length, 0);
  });

  it('offers Pausieren/Fortsetzen only with control and posts to the unchanged hold routes', async () => {
    const p = await open({ model_controls: [{ model: 'opus', paused: false, limit_until: null }, { model: 'sonnet', paused: true, limit_until: null }] });
    const [pause, resume] = p.query('button.task-model');
    assert.equal(text(pause!), 'Pausieren');
    assert.equal(text(resume!), 'Fortsetzen');
    p.click(pause!);
    await settle();
    assert.deepEqual(p.fetches.at(-1), { url: '/api/v1/models/opus/hold', method: 'POST' });
    assert.equal(text(p.$('announce')), 'Modell opus: pausiert');
    p.click(resume!);
    await settle();
    assert.deepEqual(p.fetches.at(-1), { url: '/api/v1/models/sonnet/release', method: 'POST' });
    assert.equal(text(p.$('announce')), 'Modell sonnet: fortgesetzt');
    const off = await open({ controls: { retry: false }, model_controls: [{ model: 'opus', paused: false, limit_until: until }], model_holds: [hold()] });
    assert.equal(off.query('button.task-model').length, 0);
    assert.equal(off.query('#task-hold-list li').length, 1, 'the list itself stays visible');
  });
});

describe('overview after the move (E5-2)', () => {
  const render = (issues: unknown[], over: Obj = {}) => renderPage(DASHBOARD_HTML, dashboardState({ issues, ...over }));

  it('has none of the moved sections, scripts or endpoints any more', () => {
    assert.doesNotMatch(DASHBOARD_HTML, /id="(slot-settings|slots|model-controls|model-holds|next-section|waiting-section|paused-section|blocked-section)"/);
    for (const gone of ['renderSlotSettings', 'changeSlots', 'slotButton', 'renderBlocked', 'renderModelControls', 'symphony.blockedOpen', '/api/v1/settings/agents', '/api/v1/models/', 'slot-reset', 'slot-control']) {
      assert.ok(!DASHBOARD_HTML.includes(gone), gone);
    }
  });

  it('keeps one compact line "n Slots belegt · m in der Queue · Alle Tasks" linking to /tasks', () => {
    assert.match(DASHBOARD_HTML, /<a class="section-link" href="\/tasks">Alle Tasks<\/a>/);
    const p = render([issueRow()], { counts: { ...dashboardState().counts, running: 2, queued: 7 } });
    assert.equal(text(p.$('tasks-line-text')), '2 Slots belegt · 7 in der Queue');
    assert.match(text(p.$('tasks-line')), /Alle Tasks$/);
    const one = render([], { counts: { ...dashboardState().counts, running: 1, queued: 1 } });
    assert.equal(text(one.$('tasks-line-text')), '1 Slot belegt · 1 in der Queue');
    const none = render([], { counts: { ...dashboardState().counts, running: 0, queued: 0 } });
    assert.equal(text(none.$('tasks-line-text')), '0 Slots belegt · 0 in der Queue');
  });

  it('updates the line on the next state', () => {
    const p = render([], { counts: { ...dashboardState().counts, running: 1, queued: 1 } });
    p.render(dashboardState({ issues: [], counts: { ...dashboardState().counts, running: 4, queued: 9 } }));
    assert.equal(text(p.$('tasks-line-text')), '4 Slots belegt · 9 in der Queue');
  });

  it('draws cards only for running issues; next, waiting and paused rows stay on /tasks', () => {
    const next = issueRow({ issue_id: '2', issue_identifier: 'acme/app#2', section: 'next', status: 'queued', running: null, position: 1 });
    const wait = issueRow({ issue_id: '3', issue_identifier: 'acme/app#3', section: 'waiting', status: 'retrying', running: null });
    const pause = issueRow({ issue_id: '4', issue_identifier: 'acme/app#4', section: 'paused', status: 'paused', running: null });
    const p = render([issueRow(), next, wait, pause], { counts: { ...dashboardState().counts, running: 1, queued: 1 } });
    assert.equal(p.$('running').children.length, 1);
    assert.equal(p.query('button.restart').filter((b) => ['Retry now', 'Start now', 'Resume now'].includes(text(b))).length, 0);
  });

  it('still serves the Tasks page with the steering area', async () => {
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
      runner: new FakeRunner(),
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker(),
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      const res = await request(server.port, 'GET', '/tasks');
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('id="task-slots"') && res.body.includes('id="task-hold-list"'));
      assert.ok(res.body.includes('Auf WORKFLOW.md zurücksetzen'));
    } finally {
      await server.close();
    }
  });
});
