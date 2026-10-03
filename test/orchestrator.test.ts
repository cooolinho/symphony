import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Logger } from '../src/log.ts';
import { failureBackoffMs, sortForDispatch } from '../src/orchestrator/eligibility.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { workspaceKey } from '../src/workspace/manager.ts';
import {
  FakeRunner,
  FakeTracker,
  ManualClock,
  ManualTimers,
  StaticWorkflow,
  baseFront,
  makeIssue,
  makeWorkflow,
  tempDir,
  until,
} from './helpers.ts';

interface Setup {
  orchestrator: Orchestrator;
  tracker: FakeTracker;
  runner: FakeRunner;
  timers: ManualTimers;
  clock: ManualClock;
  root: string;
  workflow: StaticWorkflow;
}

function setup(options: { issues?: ReturnType<typeof makeIssue>[]; front?: Record<string, unknown>; runner?: FakeRunner } = {}): Setup {
  const root = tempDir();
  const tracker = new FakeTracker(options.issues ?? []);
  const runner = options.runner ?? new FakeRunner();
  const timers = new ManualTimers();
  const clock = new ManualClock();
  const workflow = new StaticWorkflow(makeWorkflow(baseFront(root, options.front)));
  const orchestrator = new Orchestrator({
    workflow,
    runner,
    logger: Logger.silent(),
    env: {},
    logDir: null,
    clock,
    timers,
    createAdapter: () => tracker,
  });
  return { orchestrator, tracker, runner, timers, clock, root, workflow };
}

const snapshot = (s: Setup) => s.orchestrator.snapshot();

describe('dispatch ordering and eligibility', () => {
  it('sorts by priority 1-4, then oldest creation, then identifier', () => {
    const sorted = sortForDispatch([
      makeIssue({ id: 'none', priority: null, created_at: new Date('2020-01-01') }),
      makeIssue({ id: 'p9', priority: 9, created_at: new Date('2019-01-01') }),
      makeIssue({ id: 'p2-new', priority: 2, created_at: new Date('2026-02-01') }),
      makeIssue({ id: 'p2-old', priority: 2, created_at: new Date('2026-01-01') }),
      makeIssue({ id: 'p1', priority: 1, created_at: null }),
    ]);
    assert.deepEqual(sorted.map((i) => i.id), ['p1', 'p2-old', 'p2-new', 'p9', 'none']);
  });

  it('computes failure backoff from 10s, doubling, capped', () => {
    assert.deepEqual([1, 2, 3, 4].map((a) => failureBackoffMs(a, 300_000)), [10_000, 20_000, 40_000, 80_000]);
    assert.equal(failureBackoffMs(10, 300_000), 300_000);
    assert.equal(failureBackoffMs(3, 15_000), 15_000);
  });

  it('dispatches in priority order up to the concurrency limit, skipping ineligible issues', async () => {
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const s = setup({
      runner,
      front: { agent: { max_concurrent_agents: 2 }, tracker: { kind: 'github_project', required_labels: ['ai'], provider: { owner: 'acme', project_number: 1, token: 't' } } },
      issues: [
        makeIssue({ id: 'low', priority: 3, labels: ['ai'] }),
        makeIssue({ id: 'high', priority: 1, labels: ['ai'] }),
        makeIssue({ id: 'blocked', priority: 1, labels: ['ai'], dispatchable: false }),
        makeIssue({ id: 'unlabeled', priority: 1 }),
        makeIssue({ id: 'later', priority: 4, labels: ['AI'] }),
        makeIssue({ id: 'done', priority: 1, labels: ['ai'], state: 'Done' }),
      ],
    });
    await s.orchestrator.tickNow();
    await until(() => runner.sessions.length === 2, 3_000, 'two sessions');
    // Running rows keep dispatch order; session start order depends on filesystem timing.
    assert.deepEqual(snapshot(s).running.map((r) => r.issue_id), ['high', 'low']);
  });

  it('honours per-state concurrency limits', async () => {
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const s = setup({
      runner,
      front: { agent: { max_concurrent_agents_by_state: { todo: 1 } } },
      issues: [makeIssue({ id: 'a' }), makeIssue({ id: 'b' }), makeIssue({ id: 'c', state: 'In Progress' })],
    });
    await s.orchestrator.tickNow();
    await until(() => runner.sessions.length === 2, 3_000, 'two sessions');
    assert.deepEqual(snapshot(s).running.map((r) => r.issue_id).sort(), ['a', 'c']);
  });
});

describe('worker lifecycle and retries', () => {
  it('runs turns while the issue stays active, then schedules a 1s continuation retry', async () => {
    const s = setup({ front: { agent: { max_turns: 3 } }, issues: [makeIssue({ id: 'a' })] });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'continuation retry');
    const session = s.runner.sessions[0];
    assert.equal(session?.turns.length, 3);
    assert.match(session?.turns[0] ?? '', /Work on acme\/app#a/);
    assert.match(session?.turns[1] ?? '', /still in the active state "Todo".*turn 2 of at most 3/s);
    assert.equal(session?.stopped, true);
    const retry = snapshot(s).retrying[0];
    assert.equal(retry?.attempt, 1);
    assert.equal(retry?.kind, 'continuation');
    assert.ok(s.timers.delays().includes(1_000));
  });

  it('stops after a turn once the agent moves the issue out of the active states', async () => {
    const s = setup({ issues: [makeIssue({ id: 'a' })] });
    s.runner.script = (turn) => {
      s.tracker.set('a', { state: 'Human Review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    };
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'retry');
    assert.equal(s.runner.sessions[0]?.turns.length, 1);

    // The continuation retry finds the issue no longer active and releases the claim.
    s.timers.fire(1_000);
    await until(() => snapshot(s).counts.claimed === 0, 3_000, 'claim released');
    assert.equal(snapshot(s).retrying.length, 0);
  });

  it('retries failures with exponential backoff and re-dispatches with the attempt number', async () => {
    const s = setup({ issues: [makeIssue({ id: 'a' })] });
    s.runner.script = (turn) => ({ ok: false, turnId: String(turn), code: 'turn_failed', message: 'boom' });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'first retry');
    assert.equal(snapshot(s).retrying[0]?.attempt, 1);
    assert.match(snapshot(s).retrying[0]?.error ?? '', /worker exited: turn_failed: boom/);
    assert.ok(s.timers.delays().includes(10_000));

    s.timers.fire(10_000);
    await until(() => s.runner.sessions.length === 2 && snapshot(s).retrying.length === 1, 3_000, 'second retry');
    assert.equal(snapshot(s).retrying[0]?.attempt, 2);
    assert.ok(s.timers.delays().includes(20_000));
  });

  it('requeues a retry when no slot is free', async () => {
    const s = setup({ front: { agent: { max_concurrent_agents: 1 } }, issues: [makeIssue({ id: 'a', priority: 1 })] });
    s.runner.script = (turn) => ({ ok: false, turnId: String(turn), code: 'turn_failed', message: 'boom' });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'retry');

    // Another issue takes the only slot before the retry fires.
    s.runner.script = () => new Promise(() => undefined);
    s.tracker.issues.set('b', makeIssue({ id: 'b', priority: 2 }));
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running.length === 1, 3_000, 'b running');
    s.timers.fire(10_000);
    await until(() => snapshot(s).retrying[0]?.error === 'no available orchestrator slots', 3_000, 'requeue');
    assert.equal(snapshot(s).retrying[0]?.attempt, 2);
  });

  it('releases the claim when a retried issue has disappeared', async () => {
    const s = setup({ issues: [makeIssue({ id: 'a' })] });
    s.runner.script = (turn) => ({ ok: false, turnId: String(turn), code: 'turn_failed', message: 'boom' });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'retry');
    s.tracker.issues.delete('a');
    s.timers.fire(10_000);
    await until(() => snapshot(s).counts.claimed === 0, 3_000, 'released');
  });
});

describe('reconciliation', () => {
  async function running(s: Setup, id: string) {
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running.some((r) => r.issue_id === id && r.phase === 'StreamingTurn'), 3_000, `${id} streaming`);
  }

  const hanging = () =>
    new FakeRunner((_turn, params) => new Promise((resolve) => params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: '1', code: 'turn_cancelled', message: 'cancelled' }))));

  it('stops a run and removes its workspace when the issue becomes terminal', async () => {
    const s = setup({ runner: hanging(), issues: [makeIssue({ id: 'a' })] });
    await running(s, 'a');
    const workspace = path.join(fs.realpathSync(s.root), workspaceKey('acme/app#a'));
    assert.ok(fs.existsSync(workspace));

    s.tracker.set('a', { state: 'Done' });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).counts.claimed === 0 && !fs.existsSync(workspace), 3_000, 'cleanup');
    assert.equal(snapshot(s).retrying.length, 0);
  });

  it('stops a run without cleanup when the issue leaves the active states', async () => {
    const s = setup({ runner: hanging(), issues: [makeIssue({ id: 'a' })] });
    await running(s, 'a');
    s.tracker.set('a', { state: 'Human Review' });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).counts.claimed === 0, 3_000, 'released');
    assert.ok(fs.existsSync(path.join(fs.realpathSync(s.root), workspaceKey('acme/app#a'))));
  });

  it('updates the running snapshot while the issue stays active, and keeps workers when refresh fails', async () => {
    const s = setup({ runner: hanging(), issues: [makeIssue({ id: 'a' })] });
    await running(s, 'a');
    s.tracker.set('a', { state: 'In Progress', title: 'Renamed' });
    await s.orchestrator.tickNow();
    assert.equal(snapshot(s).running[0]?.state, 'In Progress');
    assert.equal(snapshot(s).running[0]?.title, 'Renamed');

    s.tracker.failNext = new Error('network down');
    await s.orchestrator.tickNow();
    assert.equal(snapshot(s).running.length, 1);
    assert.equal(snapshot(s).running[0]?.stopping, null);
  });

  it('kills stalled runs and schedules a retry', async () => {
    const s = setup({ runner: hanging(), front: { claude: { stall_timeout_ms: 60_000 } }, issues: [makeIssue({ id: 'a' })] });
    await running(s, 'a');
    s.clock.advance(61_000);
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'stall retry');
    assert.match(snapshot(s).retrying[0]?.error ?? '', /stalled: no agent activity/);
  });
});

describe('observability', () => {
  it('accumulates token and cost deltas from absolute session totals', async () => {
    const runner = new FakeRunner((turn, params) => {
      const usage = turn === 1 ? { inputTokens: 100, outputTokens: 10, totalTokens: 110 } : { inputTokens: 250, outputTokens: 30, totalTokens: 280 };
      params.onEvent({ event: 'turn_completed', timestamp: new Date(), pid: 1, threadId: 't', turnId: String(turn), sessionId: `t-${turn}`, turnCount: turn, usage, costUsd: turn * 0.5 });
      return { ok: true, turnId: String(turn), resultText: '' };
    });
    const s = setup({ runner, front: { agent: { max_turns: 2 } }, issues: [makeIssue({ id: 'a' })] });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'finished');
    const totals = snapshot(s).agent_totals;
    assert.deepEqual([totals.input_tokens, totals.output_tokens, totals.total_tokens, totals.cost_usd], [250, 30, 280, 1]);
  });

  it('serves per-issue details for running issues and null for unknown ones', async () => {
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const s = setup({ runner, issues: [makeIssue({ id: 'a' })] });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running[0]?.turn_count === 1, 3_000, 'first turn');
    const detail = s.orchestrator.issueDetail('acme/app#a');
    assert.equal(detail?.status, 'running');
    assert.equal(detail?.running?.turn_count, 1);
    assert.equal(s.orchestrator.issueDetail('nope'), null);
  });

  it('skips dispatch but keeps reconciling when validation fails', async () => {
    const s = setup({ issues: [makeIssue({ id: 'a' })] });
    s.workflow.lastError = { code: 'workflow_parse_error', message: 'bad yaml', at: new Date() };
    await s.orchestrator.tickNow();
    assert.equal(s.runner.sessions.length, 0);
    assert.match(snapshot(s).health.dispatch_errors.join(), /bad yaml/);
  });
});

describe('continuation limit and terminal cleanup', () => {
  it('pauses an issue that stays active after max_continuations sessions and resumes it when it changes', async () => {
    const s = setup({ front: { agent: { max_turns: 1, max_continuations: 1 } }, issues: [makeIssue({ id: 'a' })] });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'first continuation retry');

    s.timers.fire(1_000);
    await until(() => s.runner.sessions.length === 2 && snapshot(s).retrying.length === 1, 3_000, 'continuation session');

    s.timers.fire(1_000);
    await until(() => snapshot(s).counts.paused === 1, 3_000, 'paused');
    assert.deepEqual([snapshot(s).counts.running, snapshot(s).counts.retrying, snapshot(s).counts.claimed], [0, 0, 1]);
    assert.equal(snapshot(s).paused[0]?.continuations, 1);
    assert.equal(s.orchestrator.issueDetail('a')?.status, 'paused');

    // Unchanged on the tracker: stays paused, nothing new starts.
    await s.orchestrator.tickNow();
    assert.equal(s.runner.sessions.length, 2);
    assert.equal(snapshot(s).counts.paused, 1);

    // A human comments (updated_at changes): the issue resumes in the same tick.
    s.tracker.set('a', { updated_at: new Date('2026-10-04T08:00:00Z') });
    await s.orchestrator.tickNow();
    await until(() => s.runner.sessions.length === 3, 3_000, 'resumed session');
    assert.equal(snapshot(s).counts.paused, 0);
  });

  it('releases a paused issue that leaves the active states', async () => {
    const s = setup({ front: { agent: { max_turns: 1, max_continuations: 0 } }, issues: [makeIssue({ id: 'a' })] });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'retry');
    s.timers.fire(1_000);
    await until(() => snapshot(s).counts.paused === 1, 3_000, 'paused');
    s.tracker.set('a', { state: 'In review' });
    await s.orchestrator.tickNow();
    assert.equal(snapshot(s).counts.claimed, 0);
  });

  it('keeps workspaces of terminal issues when cleanup_terminal is false', async () => {
    const runner = new FakeRunner((_turn, params) => new Promise((resolve) => params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: '1', code: 'turn_cancelled', message: 'cancelled' }))));
    const s = setup({ runner, front: { workspace: { cleanup_terminal: false } }, issues: [makeIssue({ id: 'a' })] });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running[0]?.phase === 'StreamingTurn', 3_000, 'streaming');
    s.tracker.set('a', { state: 'Done' });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).counts.claimed === 0, 3_000, 'released');
    assert.ok(fs.existsSync(path.join(fs.realpathSync(s.root), workspaceKey('acme/app#a'))));
  });
});

describe('workspace cleanup after release', () => {
  it('deletes the workspace of a finished issue once it reaches Done, within one tick', async () => {
    const s = setup({ issues: [makeIssue({ id: 'a' })] });
    s.runner.script = (turn) => {
      s.tracker.set('a', { state: 'In review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    };
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'continuation retry');
    s.timers.fire(1_000);
    await until(() => snapshot(s).counts.claimed === 0, 3_000, 'released');
    const workspace = path.join(fs.realpathSync(s.root), workspaceKey('acme/app#a'));
    assert.ok(fs.existsSync(workspace), 'workspace kept while In review');

    await s.orchestrator.tickNow();
    assert.ok(fs.existsSync(workspace), 'still kept on the next tick');

    s.tracker.set('a', { state: 'Done' });
    await s.orchestrator.tickNow();
    await until(() => !fs.existsSync(workspace), 3_000, 'workspace removed');
  });
});
