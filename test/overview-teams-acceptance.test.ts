import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { TEAMS_CSS, TEAMS_JS } from '../src/http/overview-teams.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { FakeElement, scriptContext, run } from './helpers/fake-dom.ts';

// Independent acceptance tests for E2-3 "Teams live": derived from the issue text, not from the implementation.

const NOW = 5_000_000;
type Rec = Record<string, unknown>;

const agent = (id: string, status: string, over: Rec = {}): Rec => ({
  id, label: id, kind: 'agent', columns: [id], status, sessions: [], verdict: null, round: null, ...over,
});
const human: Rec = { id: 'human:in review', label: 'In review', kind: 'human', columns: ['In review'], status: 'pending', sessions: [], verdict: null, round: null };
const terminal: Rec = { id: 'terminal:done', label: 'Done', kind: 'terminal', columns: ['Done'], status: 'pending', sessions: [], verdict: null, round: null };

const runInfo = (over: Rec = {}): Rec => ({
  role: 'developer', session_id: 'sess-1', last_event: 'assistant', last_message: 'Schreibe Tests', seconds_running: 125,
  context: { tokens: 10, window: 100, percent: 37, compacts: 0 }, subagents: { running: [], finished: [] }, ...over,
});

const pipeline = (active: string): Rec[] => [
  agent('analyst', 'done'), agent('architect', 'done'),
  agent('developer', active === 'developer' ? 'active' : 'done'),
  agent('tester', active === 'tester' ? 'active' : 'pending'),
  human, terminal,
];

const issue = (n: number, running: Rec | null, stages: Rec[] = pipeline('developer'), over: Rec = {}): Rec => ({
  issue_id: 'gid-' + n, issue_identifier: 'acme/app#' + n, title: 'Titel ' + n, repo: 'acme/app', state: 'In progress',
  section: running ? 'running' : 'next', stages, running, ...over,
});

function setup() {
  const ctx = scriptContext(BASE_JS, TEAMS_JS);
  const host: FakeElement = run(ctx, 'document.createElement("div")');
  ctx.host = host;
  const render = (state: unknown, now = NOW) => {
    ctx.state = state;
    ctx.now = now;
    return run(ctx, 'renderTeams(host, state, now)');
  };
  return { ctx, host, render };
}

const avatarStates = (row: FakeElement) =>
  row.byClass('ui-av').map((a) => {
    const m = /\bis-(done|playing|waiting|returned|skipped)\b/.exec(a.className);
    return m ? m[1] : '?';
  });

describe('overview teams (acceptance)', () => {
  it('one row per running entry with number, title, repo, column and round', () => {
    const { host, render } = setup();
    const stages = pipeline('developer');
    stages[2] = agent('developer', 'active', { round: 3 });
    render({ issues: [issue(7, runInfo(), stages, { state: 'In progress' }), issue(8, null), issue(9, runInfo())] });
    const rows = host.byClass('team-row');
    assert.equal(rows.length, 2);
    const text = rows[0]!.textContent;
    assert.match(text, /7/);
    assert.ok(text.includes('Titel 7'), text);
    assert.ok(text.includes('acme/app'), text);
    assert.ok(text.includes('In progress'), text);
    assert.match(text, /3/); // Runde
    assert.ok(!host.textContent.includes('Titel 8'));
    assert.ok(host.textContent.includes('Titel 9'));
  });

  it('avatars cover all agent roles in pipeline order, no human/terminal stages', () => {
    const { host, render } = setup();
    render({ issues: [issue(1, runInfo())] });
    const row = host.byClass('team-row')[0]!;
    const names = row.byClass('ui-av').map((a) => a.getAttribute('aria-label')!.toLowerCase());
    assert.equal(names.length, 4);
    ['analyst', 'architect', 'developer', 'tester'].forEach((r, i) => assert.ok(names[i]!.includes(r), `${i}: ${names[i]}`));
  });

  it('shows the states done, playing, waiting, returned and skipped', () => {
    const { host, render } = setup();
    const stages = [
      agent('analyst', 'done'),
      agent('architect', 'skipped'),
      agent('developer', 'active'),
      agent('reviewer', 'done', { verdict: 'changes_needed', sessions: [{}] }),
      agent('tester', 'pending'),
      human, terminal,
    ];
    render({ issues: [issue(1, runInfo(), stages)] });
    assert.deepEqual(avatarStates(host.byClass('team-row')[0]!), ['done', 'skipped', 'playing', 'returned', 'waiting']);
  });

  it('only the active avatar pulses with equalizer, and only while a session runs', () => {
    const { host, render } = setup();
    render({ issues: [
      issue(1, runInfo()),
      issue(2, runInfo({ role: 'tester', session_id: null, context: null }), pipeline('tester')),
      issue(3, runInfo({ role: 'tester', session_id: '' }), pipeline('tester')),
    ] });
    const rows = host.byClass('team-row');
    assert.equal(host.byClass('is-playing').length, 1);
    assert.equal(rows[0]!.byClass('is-playing').length, 1);
    assert.equal(rows[0]!.byClass('is-playing')[0]!.getAttribute('aria-label')!.toLowerCase().includes('developer'), true);
    assert.equal(rows[0]!.byClass('eq').length, 1);
    assert.equal(rows[1]!.byClass('is-playing').length, 0);
    assert.equal(rows[1]!.byClass('eq').length, 0);
    assert.equal(rows[2]!.byClass('is-playing').length, 0);
  });

  it('shows the action next to the avatars from last_message, falling back to last_event', () => {
    const { host, render } = setup();
    render({ issues: [issue(1, runInfo({ last_message: 'Liest src/foo.ts', last_event: 'tool_use' }))] });
    assert.ok(host.textContent.includes('Liest src/foo.ts'));
    render({ issues: [issue(1, runInfo({ last_message: null, last_event: 'tool_use' }))] });
    assert.ok(host.textContent.includes('tool_use'));
  });

  it('truncates the action to at most 80 characters', () => {
    const { host, render } = setup();
    const exact = 'a'.repeat(80);
    render({ issues: [issue(1, runInfo({ last_message: exact }))] });
    assert.ok(host.textContent.includes(exact), '80 chars stay intact');
    const long = 'b'.repeat(200);
    render({ issues: [issue(1, runInfo({ last_message: long }))] });
    const longest = Math.max(0, ...(host.textContent.match(/b+/g) ?? []).map((s) => s.length));
    assert.ok(longest > 0 && longest <= 80, `longest run ${longest}`);
    assert.ok(!host.textContent.includes('b'.repeat(81)));
  });

  it('renders messages as text, not markup', () => {
    const { host, render } = setup();
    render({ issues: [issue(1, runInfo({ last_message: '<img src=x onerror=alert(1)>' }), pipeline('developer'), { title: '<b>fett</b>' })] });
    assert.ok(host.textContent.includes('<b>fett</b>'));
    assert.equal(host.find((e) => e.tagName.toLowerCase() === 'img' || e.tagName.toLowerCase() === 'b').length, 0);
  });

  it('context bar shows percent, and an em dash instead of a bar for null', () => {
    const { host, render } = setup();
    render({ issues: [
      issue(1, runInfo({ context: { tokens: 1, window: 2, percent: 62, compacts: 0 } })),
      issue(2, runInfo({ context: null })),
      issue(3, runInfo({ context: { tokens: null, window: null, percent: null, compacts: 0 } })),
    ] });
    const rows = host.byClass('team-row');
    assert.equal(rows[0]!.byClass('ui-bar').length, 1);
    assert.equal(rows[0]!.byClass('ui-bar')[0]!.getAttribute('aria-valuenow'), '62');
    assert.ok(rows[0]!.textContent.includes('62'));
    for (const i of [1, 2]) {
      assert.equal(rows[i]!.byClass('ui-bar').length, 0, 'row ' + i);
      assert.ok(rows[i]!.textContent.includes('—'), 'row ' + i);
    }
  });

  it('formats the run time as mm:ss and keeps counting live', () => {
    const { host, ctx, render } = setup();
    render({ issues: [issue(1, runInfo({ seconds_running: 125 })), issue(2, runInfo({ seconds_running: 3 }))] });
    const rows = host.byClass('team-row');
    assert.ok(rows[0]!.textContent.includes('02:05'), rows[0]!.textContent);
    assert.ok(rows[1]!.textContent.includes('00:03'), rows[1]!.textContent);
    run(ctx, `tickTeams(${NOW + 60_000})`);
    assert.ok(rows[0]!.textContent.includes('03:05'), rows[0]!.textContent);
    assert.ok(rows[1]!.textContent.includes('01:03'), rows[1]!.textContent);
  });

  it('keeps the run time live across a re-render with unchanged data', () => {
    const { host, render } = setup();
    render({ issues: [issue(1, runInfo({ seconds_running: 10 }))] });
    render({ issues: [issue(1, runInfo({ seconds_running: 12 }))] }, NOW + 2000);
    assert.ok(host.textContent.includes('00:12'), host.textContent);
  });

  it('shows the subagent count as running/total', () => {
    const { host, render } = setup();
    render({ issues: [
      issue(1, runInfo({ subagents: { running: [{ id: 'a' }], finished: [{ id: 'b' }, { id: 'c' }] } })),
      issue(2, runInfo({ subagents: { running: [], finished: [] } })),
    ] });
    const rows = host.byClass('team-row');
    assert.match(rows[0]!.textContent, /1\s*\/\s*3\s*Subagents/);
    assert.match(rows[1]!.textContent, /0\s*\/\s*0\s*Subagents/);
  });

  it('every row is one link to /issue?id=… with the encoded identifier', () => {
    const { host, render } = setup();
    render({ issues: [issue(5, runInfo()), issue(6, runInfo(), pipeline('developer'), { issue_identifier: 'acme/app#6 &x' })] });
    const rows = host.byClass('team-row');
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.tagName.toLowerCase(), 'a');
      assert.ok(r.getAttribute('href')!.startsWith('/issue?id='));
    }
    assert.equal(rows[0]!.getAttribute('href'), '/issue?id=' + encodeURIComponent('acme/app#5'));
    assert.equal(rows[1]!.getAttribute('href'), '/issue?id=' + encodeURIComponent('acme/app#6 &x'));
    // no nested links
    for (const r of rows) assert.equal(r.find((e) => e.tagName.toLowerCase() === 'a').length, 0);
  });

  it('has a visible keyboard focus style for the row', () => {
    assert.match(TEAMS_CSS, /\.team-row:focus-visible\s*\{[^}]*(outline|box-shadow)/);
    assert.doesNotMatch(TEAMS_CSS, /\.team-row[^{]*\{[^}]*outline:\s*(none|0)/);
  });

  it('empty state: "Kein Team arbeitet gerade." and it is replaced once a team runs', () => {
    const { host, render } = setup();
    render({ issues: [] });
    assert.equal(host.textContent, 'Kein Team arbeitet gerade.');
    render({ issues: [issue(1, null)] });
    assert.equal(host.textContent, 'Kein Team arbeitet gerade.');
    render({ issues: [issue(1, runInfo())] });
    assert.ok(!host.textContent.includes('Kein Team arbeitet gerade.'));
    assert.equal(host.byClass('team-row').length, 1);
    render({ issues: [] });
    assert.equal(host.byClass('team-row').length, 0);
    assert.equal(host.textContent, 'Kein Team arbeitet gerade.');
  });

  it('a state without issues array does not throw', () => {
    const { host, render } = setup();
    assert.doesNotThrow(() => render({}));
    assert.equal(host.textContent, 'Kein Team arbeitet gerade.');
  });

  it('renders 20 running issues in under 50 ms using one replaceChildren call', () => {
    const { host, render } = setup();
    let calls = 0;
    const orig = host.replaceChildren.bind(host);
    host.replaceChildren = (...n) => { calls++; orig(...n); };
    const roles = ['analyst', 'architect', 'developer', 'tester', 'reviewer', 'docs', 'security'];
    const issues = Array.from({ length: 20 }, (_, i) =>
      issue(i + 1, runInfo({ subagents: { running: [{}], finished: [{}] } }), [
        ...roles.map((r) => agent(r, r === 'developer' ? 'active' : 'pending')), human, terminal,
      ]));
    const t0 = performance.now();
    render({ issues });
    const ms = performance.now() - t0;
    assert.ok(ms < 50, `took ${ms} ms`);
    assert.equal(calls, 1);
    assert.equal(host.byClass('team-row').length, 20);
    // a changed state still replaces in a single step
    issues[0]!.title = 'neu';
    render({ issues });
    assert.equal(calls, 2);
  });

  it('is part of the overview page: section "Teams" above Running, wired into the render cycle', () => {
    assert.match(DASHBOARD_HTML, /<h2[^>]*>\s*Teams\b/);
    assert.ok(DASHBOARD_HTML.indexOf('>Teams') < DASHBOARD_HTML.indexOf('>Running'), 'Teams before Running');
    assert.ok(DASHBOARD_HTML.includes('renderTeams('));
    assert.ok(DASHBOARD_HTML.includes('.team-row'));
  });
});
