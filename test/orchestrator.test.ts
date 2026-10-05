import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PricingStore } from '../src/costs/pricing.ts';
import { HistoryLog, readHistory } from '../src/history/history.ts';
import type { WorkspaceIntegration } from '../src/integrations/types.ts';
import { Logger } from '../src/log.ts';
import { failureBackoffMs, sortForDispatch } from '../src/orchestrator/eligibility.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import type { ToolResult } from '../src/tracker/types.ts';
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

function setup(
  options: {
    issues?: ReturnType<typeof makeIssue>[];
    front?: Record<string, unknown>;
    runner?: FakeRunner;
    prompt?: string;
    logger?: Logger;
    integrations?: WorkspaceIntegration[];
  } = {},
): Setup {
  const root = tempDir();
  const tracker = new FakeTracker(options.issues ?? []);
  const runner = options.runner ?? new FakeRunner();
  const timers = new ManualTimers();
  const clock = new ManualClock();
  const workflow = new StaticWorkflow(
    makeWorkflow(baseFront(root, options.front), {
      ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
      ...(options.integrations !== undefined ? { integrations: options.integrations } : {}),
    }),
  );
  const orchestrator = new Orchestrator({
    workflow,
    runner,
    logger: options.logger ?? Logger.silent(),
    env: {},
    logDir: null,
    clock,
    timers,
    createAdapter: () => tracker,
    ...(options.integrations !== undefined ? { integrations: options.integrations } : {}),
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

  it('runs each issue on the model its "Model:" label names, else on claude.model', async () => {
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const s = setup({
      runner,
      front: { claude: { model: 'opus', fallback_model: 'sonnet' } },
      issues: [
        makeIssue({ id: 'labeled', labels: ['bug', 'model: sonnet'] }),
        makeIssue({ id: 'plain', labels: ['bug'] }),
        makeIssue({ id: 'unknown', labels: ['model: gpt-4'] }),
      ],
    });
    await s.orchestrator.tickNow();
    await until(() => runner.sessions.length === 3, 3_000, 'three sessions');
    const configs = Object.fromEntries(runner.sessions.map((session) => [session.params.issue.id, session.params.config]));
    assert.deepEqual(
      Object.fromEntries(Object.entries(configs).map(([id, config]) => [id, [config.model, config.fallbackModel]])),
      { labeled: ['sonnet', null], plain: ['opus', 'sonnet'], unknown: ['opus', 'sonnet'] },
    );
    const models = Object.fromEntries(snapshot(s).running.map((row) => [row.issue_id, row.model]));
    assert.deepEqual(models, { labeled: 'sonnet', plain: 'opus', unknown: 'opus' });
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

describe('workspace integrations', () => {
  it('hands the session the extensions of an injected integration', async () => {
    const seen: Array<{ config: unknown; workspacePath: string }> = [];
    const fake: WorkspaceIntegration<{ greeting: string }> = {
      id: 'fake',
      configKey: 'fake_section',
      resolveConfig: (raw) => ({ config: { greeting: String(raw.greeting ?? 'none') }, errors: [], warnings: [] }),
      prepare: async (config, ctx) => {
        seen.push({ config, workspacePath: ctx.workspacePath });
        return { mcpServers: {}, contextSections: [`fake says ${config.greeting}`], additionalDirectories: ['/fake'], env: { FAKE: '1' } };
      },
    };
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const s = setup({ runner, front: { fake_section: { greeting: 'hello' } }, integrations: [fake], issues: [makeIssue({ id: 'a' })] });
    assert.deepEqual(s.workflow.current.config.integrations, { fake: { greeting: 'hello' } });
    assert.deepEqual(s.workflow.current.config.warnings, []);
    await s.orchestrator.tickNow();
    await until(() => runner.sessions.length === 1, 3_000, 'one session');
    assert.deepEqual(runner.sessions[0]!.params.extensions, {
      mcpServers: {},
      contextSections: ['fake says hello'],
      additionalDirectories: ['/fake'],
      env: { FAKE: '1' },
    });
    assert.deepEqual(seen.map((entry) => entry.config), [{ greeting: 'hello' }]);
    assert.equal(seen[0]!.workspacePath, runner.sessions[0]!.params.cwd);
  });
});

describe('roles', () => {
  const rolesFront = {
    tracker: {
      kind: 'github_project',
      provider: { owner: 'acme', project_number: 1, token: 'test-token' },
      active_states: ['Todo', 'Agent review'],
    },
    agent: { max_turns: 3, max_continuations: 5 },
    claude: { model: 'sonnet', allowed_tools: ['Read'] },
    roles: {
      developer: { states: ['Todo'] },
      reviewer: {
        states: ['Agent review'],
        read_only: true,
        max_turns: 6,
        claude: { model: 'opus', allowed_tools: ['Grep'], append_system_prompt: 'Review only.' },
      },
    },
  };
  const rolePrompt = 'Act as {{ role }} on {{ issue.identifier }}';

  it('runs a role with its model, read-only policy, overrides and turn limit', async () => {
    const s = setup({ front: rolesFront, prompt: rolePrompt, issues: [makeIssue({ id: 'r', state: 'Agent review' })] });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'continuation retry');
    const session = s.runner.sessions[0];
    assert.equal(session?.params.config.model, 'opus');
    assert.equal(session?.params.policy?.readOnly, true);
    assert.deepEqual(session?.params.config.allowedTools, ['Read', 'Grep']);
    assert.equal(session?.params.config.appendSystemPrompt, 'Review only.');
    assert.equal(session?.turns.length, 6);
    assert.equal(session?.turns[0], 'Act as reviewer on acme/app#r');
  });

  it('lets a "Model:" label override the role model', async () => {
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const s = setup({
      runner,
      front: rolesFront,
      prompt: rolePrompt,
      issues: [makeIssue({ id: 'r', state: 'Agent review', labels: ['model: sonnet'] }), makeIssue({ id: 'd' })],
    });
    await s.orchestrator.tickNow();
    await until(() => runner.sessions.length === 2, 3_000, 'two sessions');
    const byId = Object.fromEntries(runner.sessions.map((session) => [session.params.issue.id, session]));
    assert.equal(byId.r?.params.config.model, 'sonnet');
    assert.equal(byId.r?.params.policy?.readOnly, true);
    assert.equal(byId.d?.params.config.model, 'sonnet');
    assert.equal(byId.d?.params.policy?.readOnly, false);
    assert.deepEqual(byId.d?.params.config.allowedTools, ['Read']);
    assert.equal(byId.d?.turns[0], 'Act as developer on acme/app#d');
  });

  it('shows the role of each run in the snapshot and the issue detail', async () => {
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const s = setup({
      runner,
      front: rolesFront,
      prompt: rolePrompt,
      issues: [makeIssue({ id: 'r', state: 'Agent review' }), makeIssue({ id: 'd' })],
    });
    await s.orchestrator.tickNow();
    await until(() => runner.sessions.length === 2, 3_000, 'two sessions');
    const roles = Object.fromEntries(snapshot(s).running.map((row) => [row.issue_id, row.role]));
    assert.deepEqual(roles, { r: 'reviewer', d: 'developer' });
    const detail = s.orchestrator.issueDetail('acme/app#r');
    assert.equal(detail?.role, 'reviewer');
    assert.equal(detail?.running?.role, 'reviewer');
  });

  it('uses the implicit default role without roles and tags agent events with run_id and role', async () => {
    const lines: string[] = [];
    const logger = Logger.create({ sinks: [{ name: 'memory', write: (line) => lines.push(line) }], level: 'debug' });
    const s = setup({ logger, prompt: rolePrompt, front: { agent: { max_turns: 2 } }, issues: [makeIssue({ id: 'a' })] });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'continuation retry');
    const session = s.runner.sessions[0];
    assert.equal(session?.turns[0], 'Act as default on acme/app#a');
    assert.equal(session?.params.policy?.readOnly, false);
    assert.equal(session?.turns.length, 2);
    const event = lines.find((line) => line.includes('agent session_started'));
    assert.match(event ?? '', /run_id=[0-9a-f]{12}/);
    assert.match(event ?? '', /role=default/);
  });

  describe('role switches', () => {
    const switchFront = {
      tracker: {
        kind: 'github_project',
        provider: { owner: 'acme', project_number: 1, token: 'test-token' },
        active_states: ['Ready', 'In progress', 'Agent review'],
      },
      agent: { max_turns: 3, max_continuations: 6 },
      roles: { developer: { states: ['Ready', 'In progress'] }, reviewer: { states: ['Agent review'], read_only: true } },
    };

    function withHistory(front: Record<string, unknown>, runner: FakeRunner, issues: ReturnType<typeof makeIssue>[]) {
      const dir = tempDir();
      fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
      const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
      const history = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
      const tracker = new FakeTracker(issues);
      tracker.issueRepository = () => 'acme/app';
      const timers = new ManualTimers();
      const orchestrator = new Orchestrator({
        workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), front), { prompt: rolePrompt })),
        runner,
        logger: Logger.silent(),
        env: {},
        logDir: null,
        clock: new ManualClock(),
        timers,
        createAdapter: () => tracker,
        pricing,
        history,
      });
      const finished = () => readHistory(history.dir, 'acme/app').entries.filter((e) => e.event === 'run_finished');
      return { orchestrator, tracker, runner, timers, history, finished };
    }

    it('ends the session when the issue moves to another role and starts the next role in a fresh session', async () => {
      const runner = new FakeRunner();
      const s = withHistory(switchFront, runner, [makeIssue({ id: 'a', state: 'Ready' })]);
      runner.script = (turn) => {
        if (runner.sessions.length === 1) s.tracker.set('a', { state: 'Agent review' });
        return { ok: true, turnId: String(turn), resultText: 'done' };
      };
      await s.orchestrator.tickNow();
      await until(() => s.orchestrator.snapshot().retrying.length === 1, 3_000, 'continuation retry');
      assert.equal(runner.sessions[0]?.turns.length, 1);
      assert.equal(runner.sessions[0]?.stopped, true);
      assert.equal(s.orchestrator.snapshot().retrying[0]?.kind, 'continuation');

      s.timers.fire(1_000);
      await until(() => runner.sessions.length === 2 && s.orchestrator.snapshot().retrying.length === 1, 3_000, 'reviewer session');
      const reviewer = runner.sessions[1];
      assert.equal(reviewer?.turns[0], 'Act as reviewer on acme/app#a');
      assert.equal(reviewer?.params.policy?.readOnly, true);
      assert.equal(reviewer?.turns.length, 3);

      const [developerRun, reviewerRun] = s.finished();
      assert.match(
        fs.readFileSync(s.history.fileFor('acme/app'), 'utf8'),
        /event=run_finished .*outcome=handed_off role=developer next_role=reviewer state="Agent review"/,
      );
      assert.equal(developerRun?.fields.reason, 'role changed (developer → reviewer)');
      assert.equal(reviewerRun?.fields.outcome, 'continuing');
      assert.equal(reviewerRun?.fields.role, undefined);
      assert.equal(reviewerRun?.fields.next_role, undefined);
    });

    it('keeps one session when the issue moves to another column of the same role', async () => {
      const runner = new FakeRunner();
      const s = withHistory(switchFront, runner, [makeIssue({ id: 'a', state: 'Ready' })]);
      runner.script = (turn) => {
        s.tracker.set('a', { state: 'In progress' });
        return { ok: true, turnId: String(turn), resultText: 'done' };
      };
      await s.orchestrator.tickNow();
      await until(() => s.orchestrator.snapshot().retrying.length === 1, 3_000, 'continuation retry');
      assert.equal(runner.sessions.length, 1);
      assert.equal(runner.sessions[0]?.turns.length, 3);
      assert.equal(s.finished()[0]?.fields.outcome, 'continuing');
    });

    it('counts role switches as continuations and pauses developer↔reviewer ping-pong', async () => {
      const runner = new FakeRunner();
      const s = withHistory({ ...switchFront, agent: { max_turns: 3, max_continuations: 2 } }, runner, [makeIssue({ id: 'a', state: 'Ready' })]);
      runner.script = (turn, params) => {
        s.tracker.set('a', { state: params.policy?.readOnly ? 'In progress' : 'Agent review' });
        return { ok: true, turnId: String(turn), resultText: 'done' };
      };
      await s.orchestrator.tickNow();
      await until(() => s.orchestrator.snapshot().retrying.length === 1, 3_000, 'first handoff');
      s.timers.fire(1_000);
      await until(() => runner.sessions.length === 2 && s.orchestrator.snapshot().retrying.length === 1, 3_000, 'reviewer session');
      s.timers.fire(1_000);
      await until(() => runner.sessions.length === 3 && s.orchestrator.snapshot().retrying.length === 1, 3_000, 'developer session');
      s.timers.fire(1_000);
      await until(() => s.orchestrator.snapshot().counts.paused === 1, 3_000, 'paused');

      assert.deepEqual(runner.sessions.map((session) => session.turns[0]), [
        'Act as developer on acme/app#a',
        'Act as reviewer on acme/app#a',
        'Act as developer on acme/app#a',
      ]);
      assert.ok(runner.sessions.every((session) => session.turns.length === 1));
      assert.deepEqual(
        s.finished().map((e) => [e.fields.outcome, e.fields.role, e.fields.next_role]),
        [
          ['handed_off', 'developer', 'reviewer'],
          ['handed_off', 'reviewer', 'developer'],
          ['handed_off', 'developer', 'reviewer'],
        ],
      );
    });
  });
});

describe('transition guard', () => {
  it('gates set_status: denies Done, keeps the column on a failed check and moves after a passing one', async () => {
    const front = {
      tracker: {
        kind: 'github_project',
        provider: { owner: 'acme', project_number: 1, token: 'test-token' },
        active_states: ['Todo', 'Agent review'],
      },
      agent: { max_turns: 2 },
      roles: {
        developer: { states: ['Todo'], may_move_to: ['Agent review', 'Blocked'] },
        reviewer: { states: ['Agent review'], read_only: true },
      },
      checks: { on_enter: { 'Agent review': 'test -f ready || { echo "tests failed"; exit 1; }' } },
    };
    const results: ToolResult[] = [];
    const states: string[] = [];
    const runner = new FakeRunner(async (turn, params) => {
      const setStatus = params.tools.find((t) => t.name === 'set_status');
      const call = async (status: string) => {
        const result = await setStatus!.execute({ status }, params.toolContext());
        results.push(result);
        states.push(s.tracker.issues.get('g')!.state);
      };
      await call('Done');
      await call('Agent review');
      fs.writeFileSync(path.join(params.cwd, 'ready'), '');
      await call('Agent review');
      return { ok: true, turnId: String(turn), resultText: 'done' };
    });
    const s = setup({ front, runner, issues: [makeIssue({ id: 'g' })] });
    await s.orchestrator.tickNow();
    await until(() => results.length === 3, 5_000, 'three set_status calls');

    const [done, failed, passed] = results;
    assert.equal(done?.ok === false ? done.error.category : null, 'transition_denied');
    assert.match(done?.ok === false ? done.error.message : '', /Allowed targets: "Agent review", "Blocked"/);
    assert.equal(failed?.ok === false ? failed.error.category : null, 'check_failed');
    assert.match(failed?.ok === false ? failed.error.message : '', /tests failed/);
    assert.deepEqual(passed, { ok: true, data: { previous_status: 'Todo', status: 'Agent review', note: 'Checks passed — end your turn now.' } });
    assert.deepEqual(states, ['Todo', 'Todo', 'Agent review']);
    assert.deepEqual(s.tracker.statusCalls, ['Agent review']);
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
    const s = setup({
      front: { polling: { interval_ms: 7_000 }, agent: { max_concurrent_agents: 1 } },
      issues: [makeIssue({ id: 'a', priority: 1 })],
    });
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
    assert.equal(snapshot(s).retrying[0]?.attempt, 1);
    assert.equal(snapshot(s).retrying[0]?.kind, 'failure');
    assert.ok(s.timers.delays().includes(7_000));
    assert.ok(!s.timers.delays().includes(20_000));
  });

  it('requeues a continuation with no free slot as a continuation after one poll interval', async () => {
    const s = setup({
      front: { polling: { interval_ms: 7_000 }, agent: { max_concurrent_agents: 1, max_turns: 1 } },
      issues: [makeIssue({ id: 'a', priority: 1 })],
    });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying[0]?.kind === 'continuation', 3_000, 'continuation retry');

    s.runner.script = () => new Promise(() => undefined);
    s.tracker.issues.set('b', makeIssue({ id: 'b', priority: 2 }));
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running.length === 1, 3_000, 'b running');
    s.timers.fire(1_000);
    await until(() => snapshot(s).retrying[0]?.error === 'no available orchestrator slots', 3_000, 'requeue');
    const retry = snapshot(s).retrying[0];
    assert.equal(retry?.kind, 'continuation');
    assert.equal(retry?.attempt, 1);
    assert.ok(s.timers.delays().includes(7_000));
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

  it('does not count workspace preparation as a stall', async () => {
    const s = setup({
      runner: hanging(),
      front: {
        claude: { stall_timeout_ms: 60_000 },
        hooks: { before_run: 'while [ ! -f "$SYMPHONY_WORKSPACE/go" ]; do sleep 0.02; done' },
      },
      issues: [makeIssue({ id: 'a' })],
    });
    const workspace = path.join(fs.realpathSync(s.root), workspaceKey('acme/app#a'));
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running[0]?.phase === 'PreparingWorkspace' && fs.existsSync(workspace), 3_000, 'preparing');
    s.clock.advance(120_000);
    await s.orchestrator.tickNow();
    assert.equal(snapshot(s).running[0]?.stopping, null);

    fs.writeFileSync(path.join(workspace, 'go'), '');
    await until(() => snapshot(s).running[0]?.phase === 'StreamingTurn', 3_000, 'streaming');
    s.clock.advance(30_000);
    await s.orchestrator.tickNow();
    assert.equal(snapshot(s).running[0]?.stopping, null, 'stall time counts from the end of preparation');
    s.clock.advance(31_000);
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'stall retry');
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

describe('board column preflight', () => {
  const BOARD = ['Backlog', 'Todo', 'Agent review', 'In review', 'Done'];
  const front = (reviewState: string) => ({
    tracker: {
      kind: 'github_project',
      provider: { owner: 'acme', project_number: 1, token: 'test-token' },
      active_states: ['Todo', reviewState],
      terminal_states: ['Done'],
    },
    roles: { developer: { states: ['Todo'] }, reviewer: { states: [reviewState], may_move_to: ['in review'] } },
  });

  it('blocks dispatch on an unknown column and clears the error after a reload', async () => {
    const s = setup({ front: front('Agent Reviw'), issues: [makeIssue({ id: 'a' })] });
    s.tracker.statusOptions = async () => {
      s.tracker.calls.statusOptions++;
      return BOARD;
    };
    await s.orchestrator.tickNow();
    assert.equal(s.runner.sessions.length, 0);
    assert.match(snapshot(s).health.dispatch_errors.join(), /unknown board column "Agent Reviw" \(valid: Backlog, Todo, Agent review/);
    await s.orchestrator.tickNow();
    assert.equal(s.tracker.calls.statusOptions, 1, 'fetched once per workflow version');

    const fixed = makeWorkflow(baseFront(s.root, front('agent REVIEW')));
    s.workflow.current = { ...fixed, version: 2 };
    await s.orchestrator.tickNow();
    assert.deepEqual(snapshot(s).health.dispatch_errors, []);
    await until(() => s.runner.sessions.length === 1, 3_000, 'dispatch after fix');
  });

  it('reports a failed options fetch as a tracker error, not a validation error', async () => {
    const s = setup({ issues: [makeIssue({ id: 'a' })] });
    s.tracker.statusOptions = async () => {
      throw new Error('board unreachable');
    };
    await s.orchestrator.tickNow();
    assert.deepEqual(snapshot(s).health.dispatch_errors, []);
    assert.equal(s.tracker.calls.byStates, 1);
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

describe('workspace lock', () => {
  it('starts no hooks or session when another instance holds the workspace', async () => {
    const s = setup({ issues: [makeIssue({ id: 'a' })] });
    const root = fs.realpathSync(s.root);
    fs.writeFileSync(
      path.join(root, `${workspaceKey('acme/app#a')}.lock`),
      JSON.stringify({ pid: process.pid, hostname: 'other-host', instance: 'foreign', acquiredAt: 'x' }),
    );
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).counts.claimed === 0 && snapshot(s).counts.running === 0, 3_000, 'claim released');
    assert.equal(s.runner.sessions.length, 0);
    assert.ok(!fs.existsSync(path.join(root, workspaceKey('acme/app#a'))), 'no workspace created');
    assert.equal(snapshot(s).retrying.length, 0);
  });
});

describe('run history', () => {
  it('logs run start and finish with tokens, model and cost to the repository log', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\nopus: { input: 4, output: 20 }\n');
    const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
    const history = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
    const runner = new FakeRunner((turn, params) => {
      params.onEvent({
        event: 'turn_completed', timestamp: new Date(), pid: 1, threadId: 'thread-9', turnId: '1', sessionId: 'thread-9-1', turnCount: 1,
        usage: { inputTokens: 1_100_000, outputTokens: 100_000, totalTokens: 1_200_000 },
        modelUsage: { 'claude-opus-5-5': { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 100_000, cacheWriteTokens: 0 } },
        costUsd: 9.99,
      });
      s.tracker.set('a', { state: 'In review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    });
    const root = tempDir();
    const tracker = new FakeTracker([makeIssue({ id: 'a' })]);
    tracker.issueRepository = () => 'acme/app';
    const s = {
      tracker,
      orchestrator: new Orchestrator({
        workflow: new StaticWorkflow(makeWorkflow(baseFront(root, { claude: { model: 'opus' } }))),
        runner,
        logger: Logger.silent(),
        env: {},
        logDir: null,
        timers: new ManualTimers(),
        createAdapter: () => tracker,
        pricing,
        history,
      }),
    };
    await s.orchestrator.tickNow();
    await until(() => s.orchestrator.snapshot().retrying.length === 1, 3_000, 'run finished');

    const entries = readHistory(history.dir, 'acme/app').entries;
    assert.deepEqual(entries.map((e) => e.event), ['run_started', 'run_finished', 'model_usage']);
    const finished = entries[1]?.fields ?? {};
    assert.equal(finished.issue, 'acme/app#a');
    assert.equal(finished.outcome, 'handed_off');
    assert.equal(finished.state, 'In review');
    assert.equal(finished.model, 'claude-opus-5-5');
    assert.equal(finished.session, 'thread-9');
    assert.equal(finished.total_tokens, '1200000');
    // 1M input × $4 + 0.1M output × $20 + 0.1M cache reads × $0.40 (10% of input) = $6.04
    assert.equal(finished.cost_usd, '6.04');
    assert.equal(finished.claude_estimate_usd, '9.99');
    assert.equal(s.orchestrator.snapshot().agent_totals.cost_usd, 6.04);
    assert.equal(entries[0]?.fields.model, 'opus');
    assert.equal(finished.mcp_unavailable, undefined);
  });

  it('tells the agent about unavailable MCP servers on turn 1 and records them in run_finished', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
    const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
    const history = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
    const tracker = new FakeTracker([makeIssue({ id: 'a' })]);
    tracker.issueRepository = () => 'acme/app';
    const runner = new FakeRunner((turn) => {
      if (turn === 2) tracker.set('a', { state: 'In review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    });
    runner.mcpStatus = { 'laravel-boost': 'failed', other: 'connected' };
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), { agent: { max_turns: 3 } }))),
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => tracker,
      pricing,
      history,
    });
    await orchestrator.tickNow();
    await until(() => orchestrator.snapshot().retrying.length === 1, 3_000, 'run finished');

    const [first, second] = runner.sessions[0]?.turns ?? [];
    assert.ok(first?.startsWith('MCP server `laravel-boost` is unavailable (failed); do not call its tools.\n\n'));
    assert.match(first ?? '', /Work on acme\/app#a/);
    assert.ok(!first?.includes('`other`'));
    assert.ok(!second?.includes('MCP server'));
    const finished = readHistory(history.dir, 'acme/app').entries.find((entry) => entry.event === 'run_finished');
    assert.equal(finished?.fields.mcp_unavailable, 'laravel-boost');
  });

  it('adds no MCP note when every added server connected', async () => {
    const runner = new FakeRunner(() => new Promise(() => undefined));
    runner.mcpStatus = { 'laravel-boost': 'connected' };
    const s = setup({ runner, issues: [makeIssue({ id: 'a' })] });
    await s.orchestrator.tickNow();
    await until(() => (runner.sessions[0]?.turns.length ?? 0) === 1, 3_000, 'turn 1');
    assert.ok(!runner.sessions[0]?.turns[0]?.includes('MCP server'));
    assert.match(runner.sessions[0]?.turns[0] ?? '', /^Work on acme\/app#a/);
  });

  it('logs the model a "Model:" label picked when the run starts', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
    const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
    const history = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
    const tracker = new FakeTracker([makeIssue({ id: 'a', labels: ['bug', 'model: sonnet-5-5'] })]);
    tracker.issueRepository = () => 'acme/app';
    const runner = new FakeRunner((turn) => {
      tracker.set('a', { state: 'In review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    });
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), { claude: { model: 'opus' } }))),
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => tracker,
      pricing,
      history,
    });
    await orchestrator.tickNow();
    await until(() => orchestrator.snapshot().retrying.length === 1, 3_000, 'run finished');

    const started = readHistory(history.dir, 'acme/app').entries.find((entry) => entry.event === 'run_started');
    assert.equal(started?.fields.model, 'claude-sonnet-5-5');
    assert.equal(started?.fields.role, 'default');
    assert.equal(runner.sessions[0]?.params.config.model, 'claude-sonnet-5-5');
  });

  describe('final commit and MCP tool usage', () => {
    const toolUse = (params: { onEvent: (event: never) => void }, tool: string) =>
      (params.onEvent as (event: unknown) => void)({
        event: 'tool_use', timestamp: new Date(), pid: 1, threadId: 't', turnId: '1', sessionId: 't-1', turnCount: 1, message: `${tool}: x`, detail: { tool },
      });

    async function run(initGit: boolean) {
      const dir = tempDir();
      fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
      const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
      const history = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
      const tracker = new FakeTracker([makeIssue({ id: 'a' })]);
      tracker.issueRepository = () => 'acme/app';
      const runner = new FakeRunner((turn, params) => {
        if (initGit) {
          const git = (...args: string[]) =>
            execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd: params.cwd, encoding: 'utf8' });
          git('init', '-q', '-b', 'feature');
          git('commit', '-q', '--allow-empty', '-m', 'init');
        }
        toolUse(params, 'mcp__laravel-boost__database-schema');
        toolUse(params, 'mcp__laravel-boost__database-schema');
        toolUse(params, 'Bash');
        toolUse(params, 'Edit');
        tracker.set('a', { state: 'In review' });
        return { ok: true, turnId: String(turn), resultText: 'done' };
      });
      const orchestrator = new Orchestrator({
        workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
        runner,
        logger: Logger.silent(),
        env: {},
        logDir: null,
        timers: new ManualTimers(),
        createAdapter: () => tracker,
        pricing,
        history,
      });
      await orchestrator.tickNow();
      await until(() => orchestrator.snapshot().retrying.length === 1, 3_000, 'run finished');
      const finished = readHistory(history.dir, 'acme/app').entries.find((e) => e.event === 'run_finished');
      return { fields: finished?.fields ?? {}, orchestrator, cwd: runner.sessions[0]?.params.cwd ?? '' };
    }

    it('records head_sha, branch and counts only MCP tools for a git workspace', async () => {
      const { fields, orchestrator, cwd } = await run(true);
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
      assert.equal(fields.head_sha, sha);
      assert.equal(fields.branch, 'feature');
      assert.equal(fields.mcp_tool_calls, 'laravel-boost:2');
      const detail = orchestrator.issueDetail('a') as { run_trace: { head_sha: string; branch: string; mcp_tool_calls: Record<string, number> } };
      assert.deepEqual(detail.run_trace, { head_sha: sha, branch: 'feature', mcp_tool_calls: { 'laravel-boost': 2 } });
    });

    it('omits head_sha and branch for a non-git workspace', async () => {
      const { fields } = await run(false);
      assert.equal('head_sha' in fields, false);
      assert.equal('branch' in fields, false);
      assert.equal(fields.mcp_tool_calls, 'laravel-boost:2');
    });
  });
});
