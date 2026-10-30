import assert from 'node:assert/strict';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { TEAMS_CSS, TEAMS_JS } from '../src/http/overview-teams.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { FakeElement, scriptContext, run } from './helpers/fake-dom.ts';

const NOW = 1_000_000;
const stage = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  id, label: id, kind: 'agent', columns: [id], status, sessions: [], verdict: null, round: null, ...over,
});
const stages = (active: string, over: Record<string, Record<string, unknown>> = {}) => [
  stage('analyst', 'done', { round: 1 }),
  stage('architect', 'done', over.architect),
  stage('developer', active === 'developer' ? 'active' : 'done', over.developer),
  stage('tester', active === 'tester' ? 'active' : 'pending', over.tester),
  { id: 'human:in review', label: 'In review', kind: 'human', columns: ['In review'], status: 'pending', sessions: [], verdict: null, round: null },
  { id: 'terminal:done', label: 'Done', kind: 'terminal', columns: ['Done'], status: 'pending', sessions: [], verdict: null, round: null },
];
const runRow = (over: Record<string, unknown> = {}) => ({
  role: 'developer', session_id: 's1', last_event: 'tool_use', last_message: 'Editing files', seconds_running: 65,
  context: { tokens: 1, window: 2, percent: 42.4, compacts: 0 }, subagents: { running: [], finished: [] }, ...over,
});
const issue = (n: number, running: unknown, st = stages('developer')) => ({
  issue_id: 'id' + n, issue_identifier: 'acme/app#' + n, title: 'Titel ' + n, repo: 'acme/app', state: 'In progress',
  section: running ? 'running' : 'next', stages: st, running,
});
const setup = () => {
  const ctx = scriptContext(BASE_JS, TEAMS_JS);
  const host: FakeElement = run(ctx, 'document.createElement("div")');
  ctx.host = host;
  return { ctx, host, render: (state: unknown, now = NOW) => { ctx.state = state; ctx.now = now; return run(ctx, 'renderTeams(host, state, now)'); } };
};

describe('overview teams', () => {
  it('renders one link row per running issue with avatars in order', () => {
    const { host, render } = setup();
    const n = render({ issues: [issue(12, runRow(), stages('developer', { developer: { round: 2 } })), issue(13, runRow()), issue(14, null)] });
    assert.equal(n, 2);
    const rows = host.byClass('team-row');
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.tagName, 'a');
    assert.equal(rows[0]!.getAttribute('href'), '/issue?id=' + encodeURIComponent('acme/app#12'));
    assert.equal(rows[0]!.byClass('team-num')[0]!.textContent, '#12');
    assert.equal(rows[0]!.byClass('team-title')[0]!.textContent, 'Titel 12');
    assert.equal(rows[0]!.byClass('team-meta')[0]!.textContent, 'acme/app · In progress · Runde 2');
    const labels = rows[0]!.byClass('ui-av').map((a) => a.getAttribute('aria-label')!.split(' ·')[0]);
    assert.deepEqual(labels, ['Analyst', 'Architect', 'Developer', 'Tester']);
  });

  it('maps stage states to avatar states', () => {
    const { ctx } = setup();
    const st = (s: unknown, r: unknown) => { ctx.s = s; ctx.r = r; return run(ctx, 'teamAvatarState(s, r)'); };
    assert.equal(st(stage('a', 'skipped'), null), 'skipped');
    assert.equal(st(stage('a', 'done'), null), 'done');
    assert.equal(st(stage('a', 'done', { verdict: 'changes_needed' }), null), 'returned');
    assert.equal(st(stage('a', 'active'), { role: 'a', session_id: null }), 'waiting');
    assert.equal(st(stage('a', 'active'), { role: 'a', session_id: 's' }), 'playing');
    assert.equal(st(stage('a', 'pending'), null), 'waiting');
  });

  it('pulses only the avatar of an issue with a session', () => {
    const { host, render } = setup();
    render({ issues: [
      issue(1, runRow()),
      issue(2, runRow({ role: 'tester', session_id: null, context: null }), stages('tester')),
    ] });
    const rows = host.byClass('team-row');
    assert.equal(host.byClass('is-playing').length, 1);
    assert.equal(host.byClass('eq').length, 1);
    assert.equal(rows[0]!.byClass('is-playing').length, 1);
    assert.equal(rows[1]!.byClass('is-playing').length, 0);
    assert.equal(rows[1]!.byClass('team-action')[0]!.textContent, 'Wartet auf Session');
    assert.equal(rows[1]!.byClass('team-ctx')[0]!.textContent, '—');
    assert.equal(rows[1]!.byClass('ui-bar').length, 0);
  });

  it('truncates the action to 80 characters and falls back to last_event', () => {
    const { host, render } = setup();
    render({ issues: [issue(1, runRow({ last_message: 'x'.repeat(120) }))] });
    const t = host.byClass('team-action')[0]!.textContent;
    assert.equal(t.length, 80);
    assert.ok(t.endsWith('…'));
    render({ issues: [issue(1, runRow({ last_message: '' }))] });
    assert.equal(host.byClass('team-action')[0]!.textContent, 'tool_use');
  });

  it('shows context, live run time and subagents', () => {
    const { host, render, ctx } = setup();
    render({ issues: [issue(1, runRow({ subagents: { running: [{}], finished: [{}, {}] } }))] });
    const bars = host.byClass('ui-bar');
    assert.equal(bars.length, 1);
    assert.equal(bars[0]!.getAttribute('aria-valuenow'), '42');
    assert.equal(host.byClass('team-ctx')[0]!.textContent, '42 %');
    assert.equal(host.byClass('team-time')[0]!.textContent, '01:05');
    run(ctx, `tickTeams(${NOW + 5000})`);
    assert.equal(host.byClass('team-time')[0]!.textContent, '01:10');
    assert.equal(host.byClass('team-subs')[0]!.textContent, '1/3 Subagents');
  });

  it('shows the empty state', () => {
    const { host, render } = setup();
    assert.equal(render({ issues: [] }), 0);
    assert.equal(host.textContent, 'Kein Team arbeitet gerade.');
    assert.equal(render({ issues: [issue(1, null)] }), 0);
    assert.equal(host.textContent, 'Kein Team arbeitet gerade.');
  });

  it('keeps the focus ring in the styles', () => {
    assert.match(TEAMS_CSS, /\.team-row:focus-visible\s*\{[^}]*outline/);
  });

  it('renders 20 issues in under 50 ms with a single replaceChildren', () => {
    const { host, render } = setup();
    let calls = 0;
    const orig = host.replaceChildren.bind(host);
    host.replaceChildren = (...n) => { calls++; orig(...n); };
    const issues = Array.from({ length: 20 }, (_, i) => issue(i + 1, runRow(), [
      ...['analyst', 'architect', 'developer', 'tester', 'reviewer', 'docs', 'security'].map((id) => stage(id, id === 'developer' ? 'active' : 'pending')),
    ]));
    const state = { issues };
    const t0 = performance.now();
    render(state);
    const ms = performance.now() - t0;
    assert.ok(ms < 50, `took ${ms} ms`);
    assert.equal(calls, 1);
    assert.equal(host.byClass('team-row').length, 20);
    render(state, NOW + 1000);
    assert.equal(calls, 1);
  });

  it('is wired into the dashboard and the page script compiles', () => {
    for (const s of ['id="teams-section"', 'id="teams"', 'renderTeams(', 'tickTeams(']) assert.ok(DASHBOARD_HTML.includes(s), s);
    const m = /<script>([\s\S]*)<\/script>/.exec(DASHBOARD_HTML);
    assert.ok(m);
    assert.doesNotThrow(() => new vm.Script(m[1]!));
  });
});
