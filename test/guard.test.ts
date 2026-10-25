import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { Logger } from '../src/log.ts';
import { CHECK_OUTPUT_LIMIT, CHECK_PASSED_NOTE, createGuard, entryChecksFor, fitCheckOutput, guardTools, parseCheckSteps, passedOutput, toolsForRole, type CheckCache, type CheckRecord, type GateRun, type GuardDecision, type GuardParams } from '../src/orchestrator/guard.ts';
import type { AgentToolContext, AgentToolSpec, ToolResult } from '../src/tracker/types.ts';
import { WorkspaceManager } from '../src/workspace/manager.ts';
import { baseFront, makeIssue, makeWorkflow, tempDir } from './helpers.ts';

const ROLES = {
  developer: { states: ['Todo', 'In progress'], may_move_to: ['In progress', 'Agent review', 'Blocked', 'Done'] },
  reviewer: { states: ['Agent review'], may_move_to: ['In review', 'In progress'] },
};

function setup(options: { checks?: Record<string, string>; timeoutMs?: number; roles?: boolean; role?: string; extraRoles?: Record<string, unknown> } = {}) {
  const root = tempDir('symphony-guard-');
  const front = baseFront(root, {
    tracker: {
      kind: 'github_project',
      provider: { owner: 'acme', project_number: 1, token: 'test-token' },
      active_states: ['Todo', 'In progress', 'Agent review'],
    },
    ...(options.roles === false ? {} : { roles: { ...ROLES, ...options.extraRoles } }),
    checks: { timeout_ms: options.timeoutMs ?? 10_000, on_enter: options.checks ?? {} },
  });
  const config = makeWorkflow(front).config;
  const workspacePath = path.join(root, 'ws');
  fs.mkdirSync(workspacePath);
  const manager = new WorkspaceManager({ root, hooks: config.hooks, workflowDir: root }, { PATH: process.env.PATH }, Logger.silent());
  const controller = new AbortController();
  const events: string[] = [];
  const params: GuardParams = {
    role: config.roles?.find((r) => r.name === (options.role ?? 'developer')) ?? null,
    config,
    workspace: { path: workspacePath, key: 'ws', createdNow: false },
    issue: () => ({ id: '1', identifier: 'acme/app#1' }),
    manager,
    signal: controller.signal,
    onEvent: (event) => events.push(event),
  };
  return { params, guard: createGuard(params), controller, events, workspacePath };
}

const denied = (decision: GuardDecision) => (decision.allow ? null : decision);

describe('transition guard', () => {
  it('denies terminal targets and targets outside may_move_to, listing the allowed ones', async () => {
    const { guard, events } = setup();
    const done = denied(await guard('done'));
    assert.equal(done?.category, 'transition_denied');
    assert.match(done?.message ?? '', /terminal/);
    assert.match(done?.message ?? '', /Allowed targets: "In progress", "Agent review", "Blocked"\./);
    const review = denied(await guard('In review'));
    assert.equal(review?.category, 'transition_denied');
    assert.match(review?.message ?? '', /role developer may not move issues to "In review"/);
    assert.deepEqual(await guard('agent review'), { allow: true, note: null });
    assert.deepEqual(events, ['transition_denied', 'transition_denied']);
  });

  it('without roles only terminal targets are denied', async () => {
    const { guard } = setup({ roles: false });
    assert.deepEqual(await guard('Anything'), { allow: true, note: null });
    const done = denied(await guard('Done'));
    assert.equal(done?.category, 'transition_denied');
    assert.match(done?.message ?? '', /any column except the terminal ones \("Done"\)/);
  });

  it('allows a gated move when the check exits 0, with role and target in its environment', async () => {
    const { guard, events } = setup({
      checks: { 'Agent review': 'test "$SYMPHONY_ROLE" = developer && test "$SYMPHONY_TARGET_STATE" = "Agent review" && test "$SYMPHONY_HOOK" = "check:Agent review"' },
    });
    const decision = await guard('Agent review');
    assert.ok(decision.allow);
    assert.equal(decision.note, CHECK_PASSED_NOTE);
    assert.deepEqual([decision.check?.target, decision.check?.role, decision.check?.result, decision.check?.exitCode], ['Agent review', 'developer', 'passed', 0]);
    assert.deepEqual(events, ['checks_started', 'checks_finished']);
  });

  it('skips the entry check for a role with run_checks false, but still enforces may_move_to', async () => {
    const auditor = { commands: ['refactoring'], states: ['Todo', 'In progress'], run_checks: false, may_move_to: ['In review', 'Blocked'] };
    const checks = { 'In review': 'echo "tests failed"; exit 1' };
    const skipping = setup({ checks, extraRoles: { auditor }, role: 'auditor' });
    assert.deepEqual(await skipping.guard('In review'), { allow: true, note: null });
    assert.deepEqual(skipping.events, ['checks_skipped']);
    assert.equal(denied(await skipping.guard('Agent review'))?.category, 'transition_denied');
    assert.equal(denied(await skipping.guard('Done'))?.category, 'transition_denied');

    // The same script still gates the reviewer.
    const gated = setup({ checks, role: 'reviewer' });
    assert.equal(denied(await gated.guard('In review'))?.category, 'check_failed');
    assert.deepEqual(gated.events, ['checks_started', 'checks_finished']);
  });

  it('without a workspace: moves without a check pass, a move that needs one is a check_error', async () => {
    const { params } = setup({ checks: { 'Agent review': 'exit 0' } });
    const guard = createGuard({ ...params, workspace: null });
    assert.deepEqual(await guard('Blocked'), { allow: true, note: null });
    const review = denied(await guard('Agent review'));
    assert.equal(review?.category, 'check_error');
    assert.match(review?.message ?? '', /there is no workspace to run it in/);
    assert.equal(denied(await guard('In review'))?.category, 'transition_denied');
  });

  it('entryChecksFor names the scripts a move runs, none for a role with run_checks false', () => {
    const auditor = { commands: ['refactoring'], states: ['Todo', 'In progress'], run_checks: false, may_move_to: ['In review', 'Blocked'] };
    const { params } = setup({ checks: { 'In review': 'exit 0' }, extraRoles: { auditor }, role: 'auditor' });
    const reviewer = params.config.roles?.find((role) => role.name === 'reviewer') ?? null;
    assert.deepEqual(entryChecksFor('in review', reviewer, params.config), [{ name: null, command: 'exit 0', timeoutMs: 10_000 }]);
    assert.deepEqual(entryChecksFor('In progress', reviewer, params.config), []);
    assert.deepEqual(entryChecksFor('In review', params.role, params.config), []);
  });

  it('adds the integration check environment', async () => {
    const { params } = setup({ checks: { 'Agent review': 'test "$EXTRA" = yes' } });
    const guard = createGuard({ ...params, checkEnv: async () => ({ EXTRA: 'yes' }) });
    assert.equal((await guard('Agent review')).allow, true);
  });

  it('returns check_failed with the output tail when the check exits 1', async () => {
    const { guard } = setup({ checks: { 'agent review': 'head -c 7000 /dev/zero | tr "\\0" x; echo; echo "3 tests failed"; exit 1' } });
    const decision = denied(await guard('Agent review'));
    assert.equal(decision?.category, 'check_failed');
    assert.match(decision?.message ?? '', /3 tests failed/);
    assert.match(decision?.message ?? '', /Fix the problems and call set_status again/);
    assert.ok((decision?.message.length ?? 0) < 6_300);
  });

  it('names the tool the agent called in its denials', async () => {
    const failed = denied(await setup({ checks: { 'Agent review': 'exit 1' } }).guard('Agent review', 'report_result'));
    assert.match(failed?.message ?? '', /Fix the problems and call report_result again\.$/);
    const slow = denied(await setup({ checks: { 'Agent review': 'sleep 5' }, timeoutMs: 200 }).guard('Agent review', 'report_result'));
    assert.match(slow?.message ?? '', /Call report_result again once/);
    const broken = denied(await setup({ checks: { 'Agent review': 'exit 2' } }).guard('Agent review', 'report_result'));
    assert.match(broken?.message ?? '', /describe the problem in an issue comment and end your turn without calling report_result again\.$/);
    assert.doesNotMatch(broken?.message ?? '', /Blocked/);
  });

  it('returns check_timeout for a check that runs into checks.timeout_ms, without sending the issue to Blocked', async () => {
    const slow = denied(await setup({ checks: { 'Agent review': 'sleep 5' }, timeoutMs: 200 }).guard('Agent review'));
    assert.equal(slow?.category, 'check_timeout');
    assert.match(slow?.message ?? '', /timed out after \d+s \(checks\.timeout_ms\)/);
    assert.match(slow?.message ?? '', /do not move the issue to Blocked/);
    assert.match(slow?.message ?? '', /Call set_status again once/);
  });

  it('returns check_error for other exit codes, aborts and unexpected errors', async () => {
    const exit2 = denied(await setup({ checks: { 'Agent review': 'exit 2' } }).guard('Agent review'));
    assert.equal(exit2?.category, 'check_error');
    assert.match(exit2?.message ?? '', /exited with code 2/);
    assert.match(exit2?.message ?? '', /do not change code; describe the problem in an issue comment and move the issue to Blocked/);

    const aborted = setup({ checks: { 'Agent review': 'sleep 5' } });
    const pending = aborted.guard('Agent review');
    setTimeout(() => aborted.controller.abort('moved to Done'), 100);
    const started = Date.now();
    assert.equal(denied(await pending)?.category, 'check_error');
    assert.ok(Date.now() - started < 4_000);

    const { params } = setup({ checks: { 'Agent review': 'exit 0' } });
    const broken = createGuard({ ...params, manager: { runScript: () => Promise.reject(new Error('boom')) } });
    const error = denied(await broken('Agent review'));
    assert.equal(error?.category, 'check_error');
    assert.match(error?.message ?? '', /boom/);
  });

  it('runs a check inside whileChecking, reports its result and the denied transitions', async () => {
    const { params } = setup({ checks: { 'Agent review': 'exit 1' } });
    const phases: string[] = [];
    const whileChecking: GuardParams['whileChecking'] = async (run) => {
      phases.push('RunningChecks');
      try {
        return await run();
      } finally {
        phases.push('restored');
      }
    };
    const checks: CheckRecord[] = [];
    const denials: string[] = [];
    const guard = createGuard({
      ...params,
      headSha: async () => 'abc123',
      whileChecking,
      onCheckFinished: (check) => checks.push(check),
      onDenied: (target) => denials.push(target),
    });
    assert.equal(denied(await guard('Done'))?.category, 'transition_denied');
    assert.equal(denied(await guard('Agent review'))?.category, 'check_failed');
    assert.deepEqual(phases, ['RunningChecks', 'restored']);
    assert.deepEqual(denials, ['Done']);
    assert.deepEqual(
      checks.map((c) => [c.target, c.role, c.sha, c.exitCode, c.ok, c.result, c.timedOut]),
      [['Agent review', 'developer', 'abc123', 1, false, 'check_failed', false]],
    );

    phases.length = 0;
    const failing = createGuard({ ...params, manager: { runScript: () => Promise.reject(new Error('boom')) }, whileChecking });
    assert.equal(denied(await failing('Agent review'))?.category, 'check_error');
    assert.deepEqual(phases, ['RunningChecks', 'restored'], 'the phase is restored when the check throws');
  });

  it('runs the checks of one session one after the other', async () => {
    const { guard, workspacePath } = setup({ checks: { 'Agent review': 'echo start >> log; sleep 0.2; echo end >> log' } });
    const results = await Promise.all([guard('Agent review'), guard('Agent review')]);
    assert.ok(results.every((r) => r.allow));
    assert.deepEqual(fs.readFileSync(path.join(workspacePath, 'log'), 'utf8').trim().split('\n'), ['start', 'end', 'start', 'end']);
  });
});

describe('check cache', () => {
  function cached(exitCode = 0) {
    const env = setup({ checks: { 'Agent review': '' } });
    const counter = path.join(path.dirname(env.workspacePath), 'count');
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: env.workspacePath, stdio: 'ignore' });
    git('init', '-q');
    fs.writeFileSync(path.join(env.workspacePath, 'a.txt'), 'a');
    git('add', '.');
    git('commit', '-qm', 'one');
    const make = (script: string) => {
      const config = { ...env.params.config, checks: { ...env.params.config.checks, onEnter: new Map([['agent review', [{ name: null, command: script, timeoutMs: 10_000 }]]]) } };
      return createGuard({ ...env.params, config, cache });
    };
    const cache: CheckCache = new Map();
    const script = `echo x >> ${counter}; exit ${exitCode}`;
    const runs = () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').trim().split('\n').length : 0);
    return { ...env, cache, git, make, script, runs };
  }

  it('runs the script once for the same clean HEAD and script', async () => {
    const { make, script, runs } = cached();
    const guard = make(script);
    const first = await guard('Agent review');
    assert.ok(first.allow);
    assert.equal(first.note, CHECK_PASSED_NOTE);
    const second = await guard('Agent review');
    assert.equal(second.allow && second.note?.startsWith('cached result for '), true);
    assert.equal(runs(), 1);
    assert.ok(second.allow && first.check !== undefined);
    assert.equal(second.check, first.check, 'a cached pass carries the record of the check that ran');
  });

  it('re-runs after a new commit, a changed script or a dirty tree', async () => {
    const { make, script, runs, git, workspacePath } = cached();
    const guard = make(script);
    await guard('Agent review');
    git('commit', '-q', '--allow-empty', '-m', 'two');
    await guard('Agent review');
    assert.equal(runs(), 2);
    await make(`${script}; true`)('Agent review');
    assert.equal(runs(), 3);
    fs.writeFileSync(path.join(workspacePath, 'b.txt'), 'dirty');
    await guard('Agent review');
    await guard('Agent review');
    assert.equal(runs(), 5);
  });

  it('never caches failures', async () => {
    const { make, script, runs, cache } = cached(1);
    const guard = make(script);
    assert.equal((await guard('Agent review')).allow, false);
    assert.equal((await guard('Agent review')).allow, false);
    assert.equal(runs(), 2);
    assert.equal(cache.size, 0);
  });

  it('runs the check when the workspace is not a git repository', async () => {
    const env = setup({ checks: { 'Agent review': '' } });
    const counter = path.join(path.dirname(env.workspacePath), 'count');
    const script = `echo x >> ${counter}`;
    const config = { ...env.params.config, checks: { ...env.params.config.checks, onEnter: new Map([['agent review', [{ name: null, command: script, timeoutMs: 10_000 }]]]) } };
    const guard = createGuard({ ...env.params, config, cache: new Map() });
    await guard('Agent review');
    await guard('Agent review');
    assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 2);
  });
});

describe('named entry checks', () => {
  function named(entries: Array<{ name: string | null; command: string }>, extra: Partial<GuardParams> = {}, timeoutMs = 10_000) {
    const env = setup({ checks: { 'Agent review': 'exit 0' } });
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: env.workspacePath, stdio: 'ignore' });
    git('init', '-q');
    fs.writeFileSync(path.join(env.workspacePath, 'a.txt'), 'a');
    git('add', '.');
    git('commit', '-qm', 'one');
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: env.workspacePath, encoding: 'utf8' }).trim();
    const log = path.join(path.dirname(env.workspacePath), 'ran');
    const checks = entries.map((entry) => ({ ...entry, command: `echo ${entry.name ?? 'plain'} >> ${log}; ${entry.command}`, timeoutMs }));
    const config = { ...env.params.config, checks: { ...env.params.config.checks, onEnter: new Map([['agent review', checks]]) } };
    const statuses: string[] = [];
    const cache: CheckCache = new Map();
    const guard = createGuard({
      ...env.params,
      config,
      cache,
      pendingDelayMs: 0,
      reportStatus: async (report) => {
        statuses.push(`${report.name}:${report.state}:${report.sha === sha ? 'head' : report.sha}`);
      },
      ...extra,
    });
    const ran = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
    return { ...env, guard, statuses, ran, sha, cache };
  }

  it('runs the checks in order and reports each named one as pending, then its result', async () => {
    const { guard, statuses, ran, events } = named([
      { name: 'ci', command: 'sleep 0.1; exit 0' },
      { name: 'prod-smoke', command: 'sleep 0.1; exit 0' },
      { name: null, command: 'exit 0' },
    ]);
    const decision = await guard('Agent review');
    assert.ok(decision.allow);
    assert.equal(decision.note, CHECK_PASSED_NOTE);
    assert.equal(decision.check?.result, 'passed');
    assert.equal(decision.check?.name, null, 'several checks are summarized');
    assert.deepEqual(ran(), ['ci', 'prod-smoke', 'plain']);
    assert.deepEqual(statuses, ['ci:pending:head', 'ci:success:head', 'prod-smoke:pending:head', 'prod-smoke:success:head']);
    assert.deepEqual(events, ['checks_started', 'checks_finished', 'checks_started', 'checks_finished', 'checks_started', 'checks_finished']);
  });

  it('runs every check after a failure and names all failures in one answer', async () => {
    const { guard, statuses, ran } = named([
      { name: 'ci', command: 'echo "pint failed"; exit 1' },
      { name: 'prod-smoke', command: 'echo "smoke failed"; exit 1' },
      { name: 'docs', command: 'exit 0' },
    ]);
    const decision = denied(await guard('Agent review'));
    assert.equal(decision?.category, 'check_failed');
    assert.deepEqual(ran(), ['ci', 'prod-smoke', 'docs']);
    assert.match(decision?.message ?? '', /The entry check for "Agent review" \(ci, prod-smoke\) failed/);
    assert.match(decision?.message ?? '', /== ci: failed \(exit 1, \d+s\) ==\npint failed/);
    assert.match(decision?.message ?? '', /== prod-smoke: failed \(exit 1, \d+s\) ==\nsmoke failed/);
    assert.equal(decision?.failed?.check.result, 'check_failed');
    assert.deepEqual(
      statuses.filter((status) => !status.includes('pending')),
      ['ci:failure:head', 'prod-smoke:failure:head', 'docs:success:head'],
    );
  });

  describe('gate state', () => {
    const gates = () => {
      const seen: GateRun[] = [];
      return { seen, onGateUpdate: (gate: GateRun) => seen.push(gate) };
    };

    it('goes from pending over running to its result', async () => {
      const { seen, onGateUpdate } = gates();
      const { guard, sha } = named([{ name: 'ci', command: 'exit 0' }, { name: 'docs', command: 'exit 78' }], { onGateUpdate });
      assert.ok((await guard('Agent review')).allow);
      assert.deepEqual(seen[0]?.checks.map((c) => c.status), ['pending', 'pending']);
      assert.equal(seen[0]?.finishedAt, null);
      assert.equal(seen[0]?.target, 'Agent review');
      assert.equal(seen[0]?.sha, sha);
      const running = seen.find((g) => g.checks[0]?.status === 'running');
      assert.ok(running?.checks[0]?.startedAt instanceof Date);
      assert.equal(running?.checks[1]?.status, 'pending');
      const last = seen[seen.length - 1]!;
      assert.deepEqual(last.checks.map((c) => c.status), ['passed', 'skipped']);
      assert.notEqual(last.finishedAt, null);
      assert.equal(last.checks[0]?.timeoutMs, 10_000);
    });

    it('keeps the steps and host load of a passed check in the gate run and the history event, not in the tool answer', async () => {
      const { seen, onGateUpdate } = gates();
      const finished: Array<Record<string, unknown> | undefined> = [];
      const script = "echo lots of noise; echo 'host load at end (1/5/15 min): 0.50 1.25 2.00, 4 CPUs'; echo 'steps:'; echo '  style  12s  ok'; echo '  tests  1m 5s  ok'";
      const { guard } = named([{ name: 'ci', command: script }], {
        onGateUpdate,
        onEvent: (event, _message, detail) => {
          if (event === 'checks_finished') finished.push(detail);
        },
      });
      const decision = await guard('Agent review');
      assert.ok(decision.allow);
      assert.equal(decision.allow && decision.note, CHECK_PASSED_NOTE);
      const output = seen[seen.length - 1]!.checks[0]?.output ?? '';
      assert.match(output, /^host load at end/);
      assert.match(output, /tests {2}1m 5s {2}ok/);
      assert.doesNotMatch(output, /noise/);
      assert.deepEqual(finished[0]?.steps, [
        { name: 'style', duration_s: 12, result: 'ok' },
        { name: 'tests', duration_s: 65, result: 'ok' },
      ]);
      assert.deepEqual(finished[0]?.load, { '1m': 0.5, '5m': 1.25, '15m': 2, cpus: 4 });
    });

    it('keeps only the short end of the output of a passed check without a steps block', async () => {
      const { seen, onGateUpdate } = gates();
      const finished: Array<Record<string, unknown> | undefined> = [];
      const { guard } = named([{ name: 'ci', command: 'seq 1 500' }, { name: 'quiet', command: 'true' }], {
        onGateUpdate,
        onEvent: (event, _message, detail) => {
          if (event === 'checks_finished') finished.push(detail);
        },
      });
      assert.ok((await guard('Agent review')).allow);
      const [loud, quiet] = seen[seen.length - 1]!.checks;
      assert.ok((loud?.output ?? '').length <= 400);
      assert.match(loud?.output ?? '', /500$/);
      assert.equal(quiet?.output, null);
      assert.equal(finished[0]?.steps, undefined);
      assert.equal(finished[0]?.load, undefined);
    });

    it('shows the kept output again for a cached result', async () => {
      const { seen, onGateUpdate } = gates();
      const { guard } = named([{ name: 'ci', command: 'echo remembered' }], { onGateUpdate });
      assert.ok((await guard('Agent review')).allow);
      assert.ok((await guard('Agent review')).allow);
      const last = seen[seen.length - 1]!.checks[0];
      assert.deepEqual([last?.cached, last?.output], [true, 'remembered']);
    });

    it('keeps the output of a check that ran into the timeout in the gate run', async () => {
      const { seen, onGateUpdate } = gates();
      const { guard } = named([{ name: 'ci', command: 'echo step-one-done; sleep 5' }], { onGateUpdate }, 500);
      assert.equal(denied(await guard('Agent review'))?.category, 'check_timeout');
      const last = seen[seen.length - 1]!;
      assert.equal(last.checks[0]?.status, 'check_timeout');
      assert.match(last.checks[0]?.output ?? '', /step-one-done/);
    });

    it('keeps only the end of a long output of a check that ran into the timeout', async () => {
      const { seen, onGateUpdate } = gates();
      const { guard } = named([{ name: 'ci', command: 'yes x | head -c 40000; echo the-last-step-line; sleep 5' }], { onGateUpdate }, 1500);
      assert.equal(denied(await guard('Agent review'))?.category, 'check_timeout');
      const check = seen[seen.length - 1]!.checks[0]!;
      assert.equal(check.status, 'check_timeout');
      assert.ok((check.output ?? '').length <= CHECK_OUTPUT_LIMIT);
      assert.ok((check.output ?? '').length > 1000);
      assert.ok((check.output ?? '').endsWith('the-last-step-line'), 'the end of the output survives');
    });

    it('gives a timed-out check its own output next to checks that passed or have no output', async () => {
      const { seen, onGateUpdate } = gates();
      const { guard } = named(
        [
          { name: 'a', command: 'echo passed-output' },
          { name: 'b', command: 'echo b-before-timeout; sleep 5' },
        ],
        { onGateUpdate },
        1500,
      );
      assert.equal(denied(await guard('Agent review'))?.category, 'check_timeout');
      const last = seen[seen.length - 1]!;
      assert.deepEqual(last.checks.map((c) => c.status), ['passed', 'check_timeout']);
      assert.equal(last.checks[0]?.output, 'passed-output', 'a passed check keeps the end of its output');
      assert.match(last.checks[1]?.output ?? '', /b-before-timeout/);
      assert.notEqual(last.finishedAt, null);
    });

    it('keeps the steps block a script prints on SIGTERM in the gate run of a timeout', async () => {
      const { seen, onGateUpdate } = gates();
      const script = "trap 'echo steps:; echo \"  php artisan test  1s  timed out (aborted)\"; exit 143' TERM; echo step-one-done; sleep 5 & wait";
      const { guard } = named([{ name: 'ci', command: script }], { onGateUpdate }, 1500);
      assert.equal(denied(await guard('Agent review'))?.category, 'check_timeout');
      const output = seen[seen.length - 1]!.checks[0]?.output ?? '';
      assert.match(output, /step-one-done/);
      assert.ok(output.endsWith('  php artisan test  1s  timed out (aborted)'), output);
    });

    it('gives each failed check the output share the agent gets', async () => {
      const { seen, onGateUpdate } = gates();
      const { guard } = named(
        [
          { name: 'a', command: 'yes x | head -c 10000; exit 1' },
          { name: 'b', command: 'echo bbb; exit 1' },
        ],
        { onGateUpdate },
      );
      const decision = denied(await guard('Agent review'));
      const last = seen[seen.length - 1]!;
      assert.deepEqual(last.checks.map((c) => [c.status, c.exitCode]), [['check_failed', 1], ['check_failed', 1]]);
      assert.ok((last.checks[0]?.output ?? '').length <= CHECK_OUTPUT_LIMIT / 2);
      assert.ok((last.checks[0]?.output ?? '').length > 100);
      assert.equal(last.checks[1]?.output, 'bbb');
      for (const check of last.checks) assert.ok(decision?.message.includes(check.output ?? '?'));
    });

    it('keeps a single failure output whole up to the limit', async () => {
      const { seen, onGateUpdate } = gates();
      const { guard } = named([{ name: 'ci', command: 'yes x | head -c 10000; exit 1' }], { onGateUpdate });
      await guard('Agent review');
      const output = seen[seen.length - 1]!.checks[0]!.output ?? '';
      assert.equal(output.length, CHECK_OUTPUT_LIMIT);
    });

    it('stops at a broken check and leaves the rest pending', async () => {
      const { seen, onGateUpdate } = gates();
      const { guard } = named([{ name: 'a', command: 'echo oops; exit 2' }, { name: 'b', command: 'exit 0' }], { onGateUpdate });
      assert.equal(denied(await guard('Agent review'))?.category, 'check_error');
      const last = seen[seen.length - 1]!;
      assert.deepEqual(last.checks.map((c) => c.status), ['check_error', 'pending']);
      assert.match(last.checks[0]?.output ?? '', /oops/);
      assert.notEqual(last.finishedAt, null);
    });

    it('marks reused results as cached', async () => {
      const { seen, onGateUpdate } = gates();
      const { guard, cache } = named([{ name: 'a', command: 'exit 0' }, { name: 'b', command: 'exit 0' }], { onGateUpdate });
      assert.ok((await guard('Agent review')).allow);
      assert.deepEqual(seen[seen.length - 1]?.checks.map((c) => c.cached), [false, false]);
      seen.length = 0;
      assert.ok((await guard('Agent review')).allow);
      assert.equal(seen.length, 1, 'all cached: one finished snapshot');
      assert.deepEqual(seen[0]?.checks.map((c) => [c.status, c.cached]), [['passed', true], ['passed', true]]);
      assert.notEqual(seen[0]?.finishedAt, null);
      cache.delete([...cache.keys()][1]!);
      seen.length = 0;
      assert.ok((await guard('Agent review')).allow);
      assert.deepEqual(seen[seen.length - 1]?.checks.map((c) => c.cached), [true, false]);
    });
  });

  it('names a single failing check in the message', async () => {
    const { guard } = named([{ name: 'ci', command: 'echo broken; exit 1' }]);
    const decision = denied(await guard('Agent review'));
    assert.match(decision?.message ?? '', /The entry check for "ci" for "Agent review" failed, so the issue was not moved\.\n\nbroken\n/);
  });

  it('keeps every failed check\'s section when the output must be shortened', () => {
    const output = `== ci: failed (exit 1, 8m12s) ==\n${'a'.repeat(3000)}\nci tail\n\n== prod-smoke: failed (exit 1, 9m07s) ==\n${'b'.repeat(3000)}\nsmoke tail`;
    const fitted = fitCheckOutput(output, 1000);
    assert.ok(fitted.length <= 1000, String(fitted.length));
    assert.match(fitted, /^== ci: failed \(exit 1, 8m12s\) ==\n…?a+\nci tail\n\n== prod-smoke: failed \(exit 1, 9m07s\) ==\n…?b+\nsmoke tail$/);
    assert.equal(fitCheckOutput('one check\nfailed', 6), '…ailed', 'a single output keeps its end');
    assert.equal(fitCheckOutput(output, 100_000), output.split('\n\n').map((part) => part.trim()).join('\n\n'));
  });

  it('stops at an environment problem and reports it as an error, with the end of its output', async () => {
    const { guard, ran, statuses } = named([
      { name: 'ci', command: 'echo "environment: git fetch origin failed"; exit 2' },
      { name: 'prod-smoke', command: 'exit 0' },
    ]);
    const decision = denied(await guard('Agent review'));
    assert.equal(decision?.category, 'check_error');
    assert.match(decision?.message ?? '', /The entry check for "ci" for "Agent review" could not run properly \(exited with code 2\)\.\n\nThe end of its output:\n\nenvironment: git fetch origin failed\n\n.*\(quote the output\)/s);
    assert.deepEqual(ran(), ['ci']);
    assert.deepEqual(statuses, ['ci:pending:head', 'ci:error:head']);
  });

  it('passes a check that exits 78 as skipped, without a status unless one was pending', async () => {
    const quick = named([{ name: 'prod-smoke', command: 'exit 78' }], { pendingDelayMs: 60_000 });
    const decision = await quick.guard('Agent review');
    assert.ok(decision.allow);
    assert.equal(decision.check?.result, 'skipped');
    assert.deepEqual(quick.statuses, []);

    const slow = named([{ name: 'prod-smoke', command: 'sleep 0.1; exit 78' }]);
    assert.ok((await slow.guard('Agent review')).allow);
    assert.deepEqual(slow.statuses, ['prod-smoke:pending:head', 'prod-smoke:success:head']);
  });

  it('caches each check: a re-entry runs only the one that did not pass, and reports the cached passes again', async () => {
    const env = named([
      { name: 'ci', command: 'exit 0' },
      { name: 'prod-smoke', command: `test -f ${path.join(tempDir('flag-'), 'missing')}` },
    ]);
    assert.equal((await env.guard('Agent review')).allow, false);
    assert.deepEqual(env.ran(), ['ci', 'prod-smoke']);
    env.statuses.length = 0;
    assert.equal((await env.guard('Agent review')).allow, false);
    assert.deepEqual(env.ran(), ['ci', 'prod-smoke', 'prod-smoke'], 'ci comes from the cache');
    assert.equal(env.statuses[0], 'ci:success:head');
    assert.equal(env.cache.size, 1);
  });

  it('reports nothing for plain scripts, and a failing report never changes the decision', async () => {
    const plain = named([{ name: null, command: 'exit 0' }]);
    assert.ok((await plain.guard('Agent review')).allow);
    assert.deepEqual(plain.statuses, []);

    const broken = named([{ name: 'ci', command: 'exit 0' }], {
      reportStatus: async () => {
        throw new Error('HTTP 422');
      },
    });
    assert.ok((await broken.guard('Agent review')).allow);
    assert.ok(broken.events.includes('check_status_failed'));
  });
});

describe('guardTools', () => {
  const issue = makeIssue({ id: '1' });
  const spec = (calls: string[]): AgentToolSpec => ({
    name: 'set_status',
    description: '',
    inputSchema: {},
    mutates: true,
    transitionTarget: (args) => (typeof args.status === 'string' ? args.status : null),
    execute: async (args): Promise<ToolResult> => {
      calls.push(String(args.status));
      return { ok: true, data: { status: args.status } };
    },
  });

  it('does not run the tool on a denial and adds the guard note on success', async () => {
    const calls: string[] = [];
    const other: AgentToolSpec = { name: 'get_issue', description: '', inputSchema: {}, mutates: false, execute: async () => ({ ok: true, data: 1 }) };
    const tools = guardTools([spec(calls), other], async (target) =>
      target === 'Done' ? { allow: false, category: 'transition_denied', message: 'no' } : { allow: true, note: target === 'Gated' ? 'end your turn' : null },
    );
    assert.equal(tools[1], other);
    const [setStatus] = tools;
    assert.deepEqual(await setStatus?.execute({ status: 'Done' }, { issue }), { ok: false, error: { category: 'transition_denied', message: 'no' } });
    assert.deepEqual(calls, []);
    assert.deepEqual(await setStatus?.execute({ status: 'Gated' }, { issue }), { ok: true, data: { status: 'Gated', note: 'end your turn' } });
    assert.deepEqual(await setStatus?.execute({ status: 'Open' }, { issue }), { ok: true, data: { status: 'Open' } });
    assert.deepEqual(calls, ['Gated', 'Open']);
  });

  it('hands the allowed move to the tool, and only for a call the guard allowed', async () => {
    const seen: AgentToolContext[] = [];
    const check: CheckRecord = {
      target: 'Gated',
      name: null,
      role: 'developer',
      sha: 'abc123',
      exitCode: 0,
      timedOut: false,
      durationMs: 1200,
      ok: true,
      result: 'passed',
      finishedAt: new Date('2026-10-18T10:00:00Z'),
    };
    const targets: Array<[string, string | undefined]> = [];
    const [tool] = guardTools(
      [
        {
          name: 'report_result',
          description: '',
          inputSchema: {},
          mutates: true,
          transitionTarget: (args) => (typeof args.target === 'string' ? args.target : null),
          execute: async (_args, context) => {
            seen.push(context);
            return { ok: true, data: { note: 'own note' } };
          },
        },
      ],
      async (target, toolName) => {
        targets.push([target, toolName]);
        return target === 'Gated' ? { allow: true, note: CHECK_PASSED_NOTE, check } : { allow: true, note: null };
      },
    );
    const forged = { issue, transition: { target: 'Gated', check: null } };
    assert.deepEqual(await tool?.execute({ target: 'Gated' }, forged), { ok: true, data: { note: 'own note' } }, "the tool's own note wins");
    await tool?.execute({ target: 'Open' }, { issue });
    await tool?.execute({}, forged);
    assert.deepEqual(targets, [['Gated', 'report_result'], ['Open', 'report_result']]);
    assert.deepEqual(seen[0]?.transition, {
      target: 'Gated',
      check: { result: 'passed', ok: true, exit_code: 0, timed_out: false, duration_ms: 1200, sha: 'abc123', finished_at: '2026-10-18T10:00:00.000Z' },
    });
    assert.deepEqual(seen[1]?.transition, { target: 'Open', check: null });
    assert.equal(seen[2]?.transition, undefined, 'a call without a target never carries a transition');
  });
});

describe('guardTools: precheck', () => {
  const issue = makeIssue({ id: '1' });

  it('stops a refused call before the guard and the tool, and lets the others through', async () => {
    const order: string[] = [];
    const [tool] = guardTools(
      [
        {
          name: 'report_result',
          description: '',
          inputSchema: {},
          mutates: true,
          transitionTarget: (args) => (typeof args.target === 'string' ? args.target : null),
          precheck: async (args) => {
            order.push(`precheck ${String(args.target)}`);
            return args.refuse === true ? { ok: false, error: { category: 'invalid_result', message: 'not yours' } } : null;
          },
          execute: async () => {
            order.push('execute');
            return { ok: true, data: 1 };
          },
        },
      ],
      async (target) => {
        order.push(`guard ${target}`);
        return { allow: true, note: null };
      },
    );
    assert.deepEqual(await tool?.execute({ target: 'Gated', refuse: true }, { issue }), { ok: false, error: { category: 'invalid_result', message: 'not yours' } });
    assert.deepEqual(order, ['precheck Gated'], 'no entry check ran');
    assert.deepEqual(await tool?.execute({ target: 'Gated' }, { issue }), { ok: true, data: 1 });
    assert.deepEqual(order.slice(1), ['precheck Gated', 'guard Gated', 'execute']);
    await tool?.execute({ refuse: true }, { issue });
    assert.deepEqual(order.slice(4), ['execute'], 'a call without a target skips the precheck');
  });
});

describe('toolsForRole', () => {
  const tool = (name: string, createsSubIssues?: boolean): AgentToolSpec => ({
    name,
    description: '',
    inputSchema: {},
    mutates: true,
    ...(createsSubIssues !== undefined ? { createsSubIssues } : {}),
    execute: async () => ({ ok: true, data: null }),
  });
  const specs = [tool('get_issue'), tool('create_sub_issue', true)];
  const roles = setup({ extraRoles: { auditor: { commands: ['refactoring'], states: ['Todo'], max_sub_issues: 5 } } }).params.config.roles ?? [];
  const named = (role: string | null) => toolsForRole(specs, roles.find((r) => r.name === role) ?? null, makeIssue({ id: '1' })).map((t) => t.name);

  it('offers create_sub_issue only to a role with max_sub_issues', () => {
    assert.deepEqual(named('auditor'), ['get_issue', 'create_sub_issue']);
    assert.deepEqual(named('developer'), ['get_issue']);
    assert.deepEqual(named('reviewer'), ['get_issue']);
    assert.deepEqual(named(null), ['get_issue']);
  });

  it('gives a role with result report_result instead of the status tools', () => {
    const setStatus: AgentToolSpec = { ...tool('set_status'), transitionTarget: (args) => String(args.status) };
    const report: AgentToolSpec = { ...tool('report_result'), transitionTarget: () => null };
    const all = [tool('get_issue'), setStatus, tool('add_comment')];
    const withResult = setup({ extraRoles: { reviewer: { states: ['Agent review'], read_only: true, result: 'review' } } }).params.config.roles ?? [];
    const reviewer = withResult.find((r) => r.name === 'reviewer') ?? null;
    assert.equal(reviewer?.readOnly, true);
    assert.deepEqual(toolsForRole(all, reviewer, makeIssue({ id: '1' }), report).map((t) => t.name), ['get_issue', 'add_comment', 'report_result']);
    assert.deepEqual(toolsForRole(all, reviewer, makeIssue({ id: '1' })).map((t) => t.name), ['get_issue', 'add_comment'], 'never set_status, even before report_result is wired');
    const developer = withResult.find((r) => r.name === 'developer') ?? null;
    assert.deepEqual(toolsForRole(all, developer, makeIssue({ id: '1' }), report).map((t) => t.name), ['get_issue', 'set_status', 'add_comment'], 'roles without result keep set_status');
    assert.deepEqual(toolsForRole(all, null, makeIssue({ id: '1' }), report).map((t) => t.name), ['get_issue', 'set_status', 'add_comment']);
  });
});

describe('parseCheckSteps and passedOutput', () => {
  const output = ['noise', 'host load at end (1/5/15 min): unknown, unknown CPUs', 'steps:', '  php -l  0s  ok', '  tests  2m 3s  timed out (aborted)'].join('\n');

  it('reads steps with minutes, results with spaces and unknown load', () => {
    assert.deepEqual(parseCheckSteps(output), {
      steps: [
        { name: 'php -l', duration_s: 0, result: 'ok' },
        { name: 'tests', duration_s: 123, result: 'timed out (aborted)' },
      ],
      load: { '1m': null, '5m': null, '15m': null, cpus: null },
    });
  });

  it('returns nothing for output of another script', () => {
    assert.deepEqual(parseCheckSteps('all good\nsteps are fine'), {});
  });

  it('starts at the host load line and cuts to the limit', () => {
    assert.equal(passedOutput(output), output.slice(output.indexOf('host load')));
    assert.equal(passedOutput(' \n'), '');
    assert.equal(passedOutput('x'.repeat(1000)).length, 400);
  });
});
