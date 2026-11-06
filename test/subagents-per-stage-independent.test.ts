import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PricingStore } from '../src/costs/pricing.ts';
import { HistoryLog } from '../src/history/history.ts';
import { AGENT_HTML } from '../src/http/issue-page.ts';
import { startHttpServer } from '../src/http/server.ts';
import { buildTeamView, type TeamInput } from '../src/http/team.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { issueDetail, teamView } from './helpers/page-fixtures.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, baseFront, makeIssue, makeWorkflow, renderPage, tempDir, until } from './helpers.ts';

// E0-8 (independent): subagents per stage on the issue page and in the team API, derived from the issue text.

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const AGENT_URL = 'http://127.0.0.1/issue?id=acme%2Fapp%231';

const sub = (over: Obj = {}): Obj => ({
  tool_use_id: 'tu1', subagent_type: 'reviewer', description: 'Review diff', status: 'done', started_at: '2026-10-30T11:02:00.000Z', ended_at: '2026-10-30T11:04:00.000Z',
  context_tokens: 65819, tool_uses: 3, duration_ms: 110436, models: ['claude-opus-5-5'], reason: null,
  tokens: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 528688 }, ...over,
});
const block = (role: string, run: string, from: string, to: string | null, subagents: Obj[] | undefined, round: number | null = 1): Obj => {
  const b: Obj = { role, run, started_at: `2026-10-30T${from}:00.000Z`, ended_at: to === null ? null : `2026-10-30T${to}:00.000Z`, verdict: null, round, model: 'opus', tool_calls: 1 };
  if (subagents !== undefined) b.subagents = subagents;
  return b;
};
const page = (team: Obj) => renderPage(AGENT_HTML, { detail: issueDetail(), team }, { url: AGENT_URL });
const idle = (blocks: Obj[]) => teamView({ active: null, subagents: { running: [], finished: [] }, blocks });
const rowsOf = (p: ReturnType<typeof page>, role: string) => p.query(`#stage-subs-body .sub-stage[data-role="${role}"] .stage-subagent`);

describe('issue page: subagents per stage, also after the run (E0-8)', () => {
  it('lists every field of a persisted subagent of a finished run: type, description, status, duration, both token figures, model', () => {
    const p = page(idle([block('developer', 'run-1', '11:00', '11:10', [sub({ subagent_type: 'symphony:reviewer', description: 'Review the diff of #205', models: ['claude-opus-5-5', 'claude-sonnet-5-5'] })])]));
    const [row] = rowsOf(p, 'developer');
    assert.ok(row);
    const text = row.textContent ?? '';
    assert.ok(text.includes('symphony:reviewer'), text);
    assert.ok(text.includes('Review the diff of #205'), text);
    assert.ok(text.includes('claude-opus-5-5'), text);
    assert.ok(text.includes('claude-sonnet-5-5'), text);
    assert.ok(text.includes('fertig'), text);
    assert.ok(text.includes('1m 50s'), text);
    assert.ok(text.includes('66k'), text);
    assert.ok(text.includes('529k'), text);
    assert.ok(row.className.includes('is-done'));
    assert.equal(row.querySelector('.ring'), null);
  });

  it('keeps the developer review visible after the run, even when later stages ran after it (marktausschuss#205)', () => {
    const p = page(idle([
      block('developer', 'run-1', '11:00', '11:10', [sub({ tool_use_id: 'a' }), sub({ tool_use_id: 'b', subagent_type: 'Explore', description: 'Find callers' })]),
      block('reviewer', 'run-2', '11:10', '11:20', []),
      block('developer', 'run-3', '11:20', '11:30', []),
    ]));
    assert.equal(p.$('stage-subs').hidden, false);
    const names = rowsOf(p, 'developer').map((r) => r.querySelector('.sub-name')!.textContent);
    assert.deepEqual([...names].sort(), ['Explore', 'reviewer']);
    assert.ok(!(p.$('stage-subs-body').textContent ?? '').includes('Keine Session aktiv'));
  });

  it('shows the reason of an error subagent and renders it as text, not markup', () => {
    const reason = 'Agent terminated early due to an API error: weekly limit <img src=x onerror=1>';
    const p = page(idle([block('developer', 'run-1', '11:00', '11:10', [sub({ status: 'error', reason })])]));
    const [row] = rowsOf(p, 'developer');
    const right = row!.querySelector('.sub-right')!.textContent!;
    assert.ok(right.startsWith('Fehler: Agent terminated early'), right);
    assert.ok(right.includes('1m 50s') && right.includes('66k') && right.includes('529k'), right);
    assert.ok(row!.className.includes('is-error'));
    assert.equal(p.query('#stage-subs-body img').length, 0);
  });

  it('shows an error subagent without a reason as plain "Fehler" and a missing duration_ms from the timestamps', () => {
    const p = page(idle([block('developer', 'run-1', '11:00', '11:10', [sub({ status: 'error', reason: null, duration_ms: null })])]));
    const right = rowsOf(p, 'developer')[0]!.querySelector('.sub-right')!.textContent!;
    assert.ok(right.startsWith('Fehler'), right);
    assert.ok(!right.startsWith('Fehler:'), right);
    assert.ok(right.includes('2m 0s'), right);
  });

  it('shows the running run live board as before: first row running with pulse, text unchanged, pulse kept across polls', () => {
    const team = () => teamView({ blocks: [block('developer', 'run-1', '11:00', null, [])] });
    const p = page(team());
    const rows = rowsOf(p, 'developer');
    assert.ok(rows[0]!.className.includes('is-running'));
    assert.equal(rows[0]!.querySelector('.sub-name')!.textContent, 'Explore');
    assert.ok(rows[0]!.querySelector('.ring'));
    assert.ok(rows[0]!.querySelector('.sub-right')!.textContent!.includes('abgerechnet 12k'));
    assert.equal(rows[1]!.querySelector('.sub-name')!.textContent, 'Plan');
    assert.equal(p.$('stage-subs-meta').textContent, '1 laufen · 1 fertig');
    const ring = p.query('#stage-subs-body .ring')[0];
    const next = team();
    next.subagents.running[0].tokens.total_tokens = 99000;
    p.render({ detail: issueDetail(), team: next });
    assert.equal(p.query('#stage-subs-body .ring')[0], ring);
    assert.ok(rowsOf(p, 'developer')[0]!.querySelector('.sub-right')!.textContent!.includes('abgerechnet 99k'));
  });

  it('does not restart the pulse when a finished run is added or a persisted run polls unchanged', () => {
    const live = (extra: Obj[]) => teamView({ blocks: [...extra, block('developer', 'run-3', '11:58', null, [], 2)] });
    const p = page(live([]));
    const ring = p.query('#stage-subs-body .ring')[0];
    assert.ok(ring);
    p.render({ detail: issueDetail(), team: live([block('developer', 'run-1', '11:00', '11:10', [sub()])]) });
    assert.equal(rowsOf(p, 'developer').filter((r) => r.className.includes('is-running')).length, 1);
    const ring2 = p.query('#stage-subs-body .ring')[0];
    p.render({ detail: issueDetail(), team: live([block('developer', 'run-1', '11:00', '11:10', [sub()])]) });
    assert.equal(p.query('#stage-subs-body .ring')[0], ring2);
  });

  it('puts earlier runs of other stages below the live stage, one section per stage with at least one run', () => {
    const p = page(teamView({
      blocks: [block('architect', 'run-1', '10:00', '10:30', [sub({ subagent_type: 'Plan', description: 'Draft' })]), block('developer', 'run-2', '11:00', '11:10', [sub()]), block('developer', 'run-3', '11:58', null, [], 2)],
    }));
    const roles = p.query('#stage-subs-body .sub-stage').map((x) => x.dataset.role);
    assert.deepEqual(roles.slice().sort(), ['architect', 'developer']);
    assert.equal(roles[0], 'developer');
    assert.ok(rowsOf(p, 'architect')[0]!.textContent!.includes('Draft'));
    assert.equal(rowsOf(p, 'architect')[0]!.querySelector('.ring'), null);
  });

  it('lists several finished runs of one stage, newest first', () => {
    const p = page(idle([
      block('developer', 'run-1', '10:00', '10:10', [sub({ tool_use_id: 'old', description: 'First round review' })], 1),
      block('developer', 'run-3', '11:00', '11:10', [sub({ tool_use_id: 'new', description: 'Second round review' })], 2),
    ]));
    const tasks = rowsOf(p, 'developer').map((r) => r.querySelector('.sub-task')!.textContent);
    assert.deepEqual(tasks, ['Second round review', 'First round review']);
  });

  it('says "Diese Session hat (noch) keinen Subagent gestartet" for an active run without subagents', () => {
    const p = page(teamView({ subagents: { running: [], finished: [] }, blocks: [block('developer', 'run-1', '11:58', null, [])] }));
    const text = p.$('stage-subs-body').textContent ?? '';
    assert.ok(text.includes('Diese Session hat (noch) keinen Subagent gestartet'), text);
    assert.ok(!text.includes('Keine Subagents in dieser Session'));
    assert.ok(!text.includes('Keine Session aktiv'));
  });

  it('says "Keine Subagents in diesem Lauf" for a finished run without subagents, also for a block without the subagents field', () => {
    for (const subagents of [[], undefined]) {
      const p = page(idle([block('developer', 'run-1', '11:00', '11:10', subagents)]));
      const text = p.$('stage-subs-body').textContent ?? '';
      assert.ok(text.includes('Keine Subagents in diesem Lauf'), text);
      assert.ok(!text.includes('Diese Session hat'), text);
      assert.equal(rowsOf(p, 'developer').length, 0);
    }
  });

  it('renders no subagent block for a stage without runs, and no "Keine Session aktiv" without any run', () => {
    const p = page(idle([block('developer', 'run-1', '11:00', '11:10', [sub()])]));
    assert.deepEqual(p.query('#stage-subs-body .sub-stage').map((x) => x.dataset.role), ['developer']);
    for (const role of ['analyst', 'architect', 'tester', 'docs', 'reviewer', 'security']) assert.equal(p.query(`#stage-subs-body .sub-stage[data-role="${role}"]`).length, 0, role);
    const none = page(idle([]));
    assert.ok(!(none.$('stage-subs-body').textContent ?? '').includes('Keine Session aktiv'));
    assert.equal(none.query('#stage-subs-body .stage-subagent').length, 0);
    assert.equal(none.query('#stage-subs-body .stage-empty').length, 0);
  });

  it('clears the finished rows again when the data disappears on a later poll', () => {
    const p = page(idle([block('developer', 'run-1', '11:00', '11:10', [sub()])]));
    assert.equal(rowsOf(p, 'developer').length, 1);
    p.render({ detail: issueDetail(), team: idle([]) });
    assert.equal(p.query('#stage-subs-body .stage-subagent').length, 0);
  });
});

describe('buildTeamView: subagents per run (E0-8)', () => {
  const ts = (hm: string) => `2026-10-03T${hm}:00.000Z`;
  const input = (over: Partial<TeamInput> = {}): TeamInput => ({
    pipeline: [
      { id: 'developer', label: 'developer', kind: 'agent', columns: ['In progress'], status: 'done', verdict: null, round: null, sessions: [
        { run: 'd1', attempt: null, role: 'developer', state: 'x', model: 'sonnet', effort: null, started_at: ts('10:00'), finished_at: ts('10:10'), outcome: 'handed_off', verdict: null, round: 1 },
        { run: 'd2', attempt: null, role: 'developer', state: 'x', model: 'sonnet', effort: null, started_at: ts('10:30'), finished_at: ts('10:40'), outcome: 'handed_off', verdict: null, round: 2 },
      ] },
    ] as unknown as TeamInput['pipeline'],
    results: [], issueState: 'In review', running: null, timeline: [], now: Date.parse(ts('11:00')), roles: null,
    ...over,
  } as TeamInput);

  it('gives each block the subagents of its own run and an empty list otherwise', () => {
    const view = buildTeamView(input({ runSubagents: new Map([['d2', [sub() as never]]]) }));
    assert.deepEqual(view.blocks.map((b) => [b.run, b.subagents.length]), [['d1', 0], ['d2', 1]]);
    assert.deepEqual(buildTeamView(input()).blocks.map((b) => b.subagents), [[], []]);
  });

  it('does not alias the caller list and leaves the live board untouched', () => {
    const list = [sub() as never];
    const view = buildTeamView(input({ runSubagents: new Map([['d1', list]]) }));
    assert.notEqual(view.blocks[0]!.subagents, list);
    assert.deepEqual(view.subagents, { running: [], finished: [] });
  });
});

describe('GET /api/v1/<id>/team: subagents per run (E0-8)', () => {
  const request = (port: number, urlPath: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }).on('error', reject);
    });
  const teamPath = (id: string) => `/api/v1/${encodeURIComponent(`acme/app#${id}`)}/team`;
  const orchestratorFor = (logDir: string) =>
    new Orchestrator({ workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))), runner: new FakeRunner(() => new Promise(() => undefined)), logger: Logger.silent(), env: {}, logDir, timers: new ManualTimers(), createAdapter: () => new FakeTracker([]) });

  function writeArchive(logDir: string, id: string, subagentsOf: Record<string, unknown[] | undefined>) {
    const session = (run: string, role: string, start: string, end: string) => ({
      run, attempt: null, role, state: 'x', model: 'sonnet', effort: null, started_at: `2026-10-03T${start}:00.000Z`, finished_at: `2026-10-03T${end}:00.000Z`, outcome: 'handed_off', verdict: null, round: 1, transcript: null,
      ...(subagentsOf[run] ? { subagents: subagentsOf[run] } : {}),
    });
    const sessions = [session('d1', 'developer', '10:00', '10:10'), session('v1', 'reviewer', '10:11', '10:20')];
    const pipeline = [
      { id: 'developer', label: 'developer', kind: 'agent', columns: ['In progress'], status: 'done', sessions: sessions.slice(0, 1).map(({ transcript: _t, subagents: _s, ...rest }) => rest), verdict: null, round: null },
      { id: 'reviewer', label: 'reviewer', kind: 'agent', columns: ['Agent review'], status: 'done', sessions: sessions.slice(1).map(({ transcript: _t, subagents: _s, ...rest }) => rest), verdict: null, round: null },
      { id: 'terminal:done', label: 'Done', kind: 'terminal', columns: ['Done'], status: 'pending', sessions: [], verdict: null, round: null },
    ];
    fs.mkdirSync(path.join(logDir, 'issues'), { recursive: true });
    fs.writeFileSync(path.join(logDir, 'issues', `acme_app_${id}.json`), JSON.stringify({
      version: 2, pipeline, results: [], issue_id: id, issue_identifier: `acme/app#${id}`, issue_url: null, title: 'Old', repo: null, workspace_path: null, runs: 2, continuations: 0, last_error: null,
      archived_at: '2026-10-03T11:00:00.000Z', released: true, completed_before: false, timeline: [], next_seq: 1, sessions, run_trace: null, last_check: null,
    }));
  }

  it('delivers the persisted subagents of an archived issue per block, in the subagentJson shape; the live board stays empty', async () => {
    const logDir = tempDir();
    const error = sub({ tool_use_id: 'tu2', status: 'error', reason: 'API error: 529' });
    writeArchive(logDir, 'arch', { d1: [sub(), error] });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator: orchestratorFor(logDir), logger: Logger.silent() });
    try {
      const res = await request(server.port, teamPath('arch'));
      assert.equal(res.status, 200);
      const team = JSON.parse(res.body);
      assert.deepEqual(team.blocks.map((b: Obj) => [b.run, b.subagents.length]), [['d1', 2], ['v1', 0]]);
      assert.deepEqual(team.blocks[0].subagents, [sub(), error]);
      assert.equal(team.blocks[0].subagents[1].reason, 'API error: 529');
      assert.deepEqual(team.subagents, { running: [], finished: [] });
    } finally {
      await server.close();
    }
  });

  it('delivers an empty list for every block of an older archive without subagents', async () => {
    const logDir = tempDir();
    writeArchive(logDir, 'legacy', {});
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator: orchestratorFor(logDir), logger: Logger.silent() });
    try {
      const team = JSON.parse((await request(server.port, teamPath('legacy'))).body);
      assert.ok(team.blocks.length > 0);
      for (const b of team.blocks) assert.deepEqual(b.subagents, []);
    } finally {
      await server.close();
    }
  });

  it('delivers the subagents of a finished run of a live issue on its block while a later run is open', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
    const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
    const history = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
    const tracker = new FakeTracker([makeIssue({ id: 'a' })]);
    tracker.issueRepository = () => 'acme/app';
    const runner = new FakeRunner((turn, params) => {
      const send = (event: string, fields: Record<string, unknown>) =>
        (params.onEvent as (event: unknown) => void)({ event, timestamp: new Date(), pid: 1, threadId: 't', turnId: '1', sessionId: 't-1', turnCount: 1, ...fields });
      if (runner.sessions.length === 1) {
        send('subagent', {
          subagent: {
            toolUseId: 'x', subagentType: 'Explore', description: 'Find files', startedAt: new Date('2026-01-01T10:00:00Z'), endedAt: new Date('2026-01-01T10:01:00Z'), status: 'error', reason: 'API error: 529',
            tokens: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }, contextTokens: 100, toolUses: 2, durationMs: 60000, models: ['claude-opus-5-5'],
          },
        });
        return { ok: true, turnId: String(turn), resultText: 'done' };
      }
      return new Promise(() => undefined);
    });
    const timers = new ManualTimers();
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))), runner, logger: Logger.silent(), env: {}, logDir: null, clock: new ManualClock(), timers, createAdapter: () => tracker, pricing, history,
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      await orchestrator.tickNow();
      await until(() => orchestrator.snapshot().retrying.length === 1, 3_000, 'continuation retry');
      timers.fire(1_000);
      await until(() => runner.sessions.length === 2 && orchestrator.snapshot().running.length === 1, 3_000, 'second run open');
      const team = JSON.parse((await request(server.port, teamPath('a'))).body);
      const done = team.blocks.filter((b: Obj) => b.ended_at !== null);
      const open = team.blocks.filter((b: Obj) => b.ended_at === null);
      assert.equal(done.length, 1);
      assert.equal(open.length, 1);
      assert.deepEqual(done[0].subagents.map((x: Obj) => [x.tool_use_id, x.subagent_type, x.status, x.reason]), [['x', 'Explore', 'error', 'API error: 529']]);
      assert.equal(done[0].subagents[0].tokens.total_tokens, 14);
      assert.equal(done[0].subagents[0].context_tokens, 100);
      assert.equal(done[0].subagents[0].duration_ms, 60000);
      assert.deepEqual(done[0].subagents[0].models, ['claude-opus-5-5']);
      assert.deepEqual(open[0].subagents, []);
      assert.deepEqual(team.subagents.finished, []);
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });
});
