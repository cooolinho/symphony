import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { TEAMS_JS } from '../src/http/overview-teams.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { FakeElement, scriptContext, run } from './helpers/fake-dom.ts';

// Independent tests for the second round of E2-3: live action updates without a rebuild, code-point-safe
// truncation, and the wiring next to the SSE live updates.

const NOW = 5_000_000;
type Rec = Record<string, unknown>;

const agent = (id: string, status: string): Rec => ({
  id, label: id, kind: 'agent', columns: [id], status, sessions: [], verdict: null, round: null,
});
const runInfo = (over: Rec = {}): Rec => ({
  role: 'developer', session_id: 's1', last_event: 'assistant', last_message: 'erste Aktion', seconds_running: 10,
  context: { tokens: 1, window: 100, percent: 5, compacts: 0 }, subagents: { running: [], finished: [] }, ...over,
});
const issue = (n: number, running: Rec): Rec => ({
  issue_id: 'gid-' + n, issue_identifier: 'acme/app#' + n, title: 'Titel ' + n, repo: 'acme/app', state: 'In progress',
  section: 'running', running,
  stages: [agent('analyst', 'done'), agent('developer', 'active'), agent('tester', 'pending')],
});

function setup() {
  const ctx = scriptContext(BASE_JS, TEAMS_JS);
  const host: FakeElement = run(ctx, 'document.createElement("div")');
  ctx.host = host;
  let calls = 0;
  const orig = host.replaceChildren.bind(host);
  host.replaceChildren = (...n) => { calls++; orig(...n); };
  const render = (state: unknown, now = NOW) => {
    ctx.state = state;
    ctx.now = now;
    return run(ctx, 'renderTeams(host, state, now)');
  };
  return { host, render, replaces: () => calls };
}

describe('overview teams: live updates (round 2)', () => {
  it('updates only the action text when just last_message changes: no rebuild, same nodes, avatar keeps its element', () => {
    const { host, render, replaces } = setup();
    render({ issues: [issue(1, runInfo())] });
    const row = host.byClass('team-row')[0]!;
    const av = row.byClass('is-playing')[0]!;
    const action = row.byClass('team-action')[0]!;
    assert.equal(action.textContent, 'erste Aktion');
    assert.equal(replaces(), 1);

    render({ issues: [issue(1, runInfo({ last_message: 'zweite Aktion' }))] }, NOW + 2000);
    assert.equal(replaces(), 1, 'no DOM replacement for a text-only change');
    assert.equal(host.byClass('team-row')[0], row, 'same row element');
    assert.equal(host.byClass('is-playing')[0], av, 'pulsing avatar not recreated');
    assert.equal(action.textContent, 'zweite Aktion');
    assert.equal(action.getAttribute('title'), 'zweite Aktion');
  });

  it('falls back to last_event in the live update and truncates there as well', () => {
    const { host, render, replaces } = setup();
    render({ issues: [issue(1, runInfo())] });
    render({ issues: [issue(1, runInfo({ last_message: '', last_event: 'tool_use' }))] });
    assert.equal(host.byClass('team-action')[0]!.textContent, 'tool_use');
    render({ issues: [issue(1, runInfo({ last_message: 'x'.repeat(300) }))] });
    const t = host.byClass('team-action')[0]!.textContent;
    assert.equal(Array.from(t).length, 80);
    assert.ok(t.endsWith('…'));
    assert.equal(replaces(), 1);
  });

  it('still rebuilds when the structure changes (session ends)', () => {
    const { host, render, replaces } = setup();
    render({ issues: [issue(1, runInfo())] });
    assert.equal(host.byClass('is-playing').length, 1);
    render({ issues: [issue(1, runInfo({ session_id: null }))] });
    assert.equal(replaces(), 2);
    assert.equal(host.byClass('is-playing').length, 0);
    assert.equal(host.byClass('team-action')[0]!.textContent, 'Wartet auf Session');
  });

  it('keeps the live clock anchored when only the action text changes', () => {
    const { host, render } = setup();
    render({ issues: [issue(1, runInfo({ seconds_running: 65 }))] });
    render({ issues: [issue(1, runInfo({ seconds_running: 67, last_message: 'neu' }))] }, NOW + 2000);
    assert.equal(host.byClass('team-time')[0]!.textContent, '01:07');
  });

  it('truncates by code points: astral characters at the cut are never split', () => {
    const { host, render } = setup();
    const msg = 'a'.repeat(78) + '😀😀😀😀';
    render({ issues: [issue(1, runInfo({ last_message: msg }))] });
    const t = host.byClass('team-action')[0]!.textContent;
    assert.ok(t.endsWith('…'));
    assert.equal(Array.from(t).length, 80);
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(t), 'no lone surrogate');
    assert.equal(t, 'a'.repeat(78) + '😀…');
  });

  it('keeps an 80-code-point message with emoji intact', () => {
    const { host, render } = setup();
    const msg = '😀'.repeat(80);
    render({ issues: [issue(1, runInfo({ last_message: msg }))] });
    assert.equal(host.byClass('team-action')[0]!.textContent, msg);
  });

  it('is wired next to the SSE live updates: render calls renderTeams, a 1 s ticker runs tickTeams', () => {
    assert.match(DASHBOARD_HTML, /live\(load, pollEvery\(load, 2000\)\)/);
    assert.match(DASHBOARD_HTML, /setInterval\(\(\) => tickTeams\(Date\.now\(\)\), 1000\)/);
    assert.match(DASHBOARD_HTML, /renderTeams\(\$\('teams'\), state, Date\.now\(\)\)/);
    assert.ok(!DASHBOARD_HTML.includes('<<<<<<<') && !DASHBOARD_HTML.includes('>>>>>>>'));
  });
});
