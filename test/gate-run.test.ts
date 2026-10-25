import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { startHttpServer } from '../src/http/server.ts';
import { HistoryLog, readHistory } from '../src/history/history.ts';
import { PricingStore } from '../src/costs/pricing.ts';
import { Logger } from '../src/log.ts';
import { CHECK_OUTPUT_LIMIT, CHECK_PASSED_NOTE, createGuard, type CheckCache, type GateRun, type GuardDecision, type GuardParams } from '../src/orchestrator/guard.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { WorkspaceManager } from '../src/workspace/manager.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, callTool, makeIssue, makeWorkflow, tempDir, until } from './helpers.ts';

// Acceptance tests of #301 (entry gate on the agent page), derived from the issue text: guard state, API, page.

const ROLES = {
  developer: { states: ['Todo', 'In progress'], may_move_to: ['In progress', 'Agent review', 'Blocked', 'Done'] },
  reviewer: { states: ['Agent review'], may_move_to: ['In review', 'In progress'] },
};

interface Entry {
  name: string | null;
  command: string;
  timeoutMs?: number;
}

function gateGuard(entries: Entry[], extra: Partial<GuardParams> = {}) {
  const root = tempDir('symphony-gate-');
  const front = baseFront(root, {
    tracker: { kind: 'github_project', provider: { owner: 'acme', project_number: 1, token: 'test-token' }, active_states: ['Todo', 'In progress', 'Agent review'] },
    roles: ROLES,
    checks: { timeout_ms: 10_000, on_enter: { 'Agent review': 'exit 0' } },
  });
  const config = makeWorkflow(front).config;
  const workspacePath = path.join(root, 'ws');
  fs.mkdirSync(workspacePath);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: workspacePath, stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(workspacePath, 'a.txt'), 'a');
  git('add', '.');
  git('commit', '-qm', 'one');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspacePath, encoding: 'utf8' }).trim();
  const manager = new WorkspaceManager({ root, hooks: config.hooks, workflowDir: root }, { PATH: process.env.PATH }, Logger.silent());
  const checks = entries.map((entry) => ({ name: entry.name, command: entry.command, timeoutMs: entry.timeoutMs ?? 10_000 }));
  const cache: CheckCache = new Map();
  const seen: GateRun[] = [];
  const guard = createGuard({
    role: config.roles?.find((r) => r.name === 'developer') ?? null,
    config: { ...config, checks: { ...config.checks, onEnter: new Map([['agent review', checks]]) } },
    workspace: { path: workspacePath, key: 'ws', createdNow: false },
    issue: () => ({ id: '1', identifier: 'acme/app#1' }),
    manager,
    signal: new AbortController().signal,
    cache,
    pendingDelayMs: 0,
    onGateUpdate: (gate) => seen.push(gate),
    ...extra,
  });
  return { guard, seen, sha, cache };
}

const denied = (decision: GuardDecision) => (decision.allow ? null : decision);

describe('guard: gate snapshots', () => {
  it('lists all checks as pending first and only ever moves a check forward, one running at a time', async () => {
    const { guard, seen, sha } = gateGuard([
      { name: 'a', command: 'exit 0' },
      { name: 'b', command: 'exit 0' },
      { name: 'c', command: 'exit 0' },
    ]);
    assert.ok((await guard('Agent review')).allow);
    assert.ok(seen.length >= 4);
    assert.deepEqual(seen[0]?.checks.map((c) => [c.name, c.status]), [['a', 'pending'], ['b', 'pending'], ['c', 'pending']]);
    assert.equal(seen[0]?.target, 'Agent review');
    assert.equal(seen[0]?.sha, sha);
    const rank = { pending: 0, running: 1, passed: 2 } as const;
    for (const gate of seen) assert.ok(gate.checks.filter((c) => c.status === 'running').length <= 1);
    for (let i = 1; i < seen.length; i++) {
      seen[i]!.checks.forEach((c, index) => assert.ok(rank[c.status as keyof typeof rank] >= rank[seen[i - 1]!.checks[index]!.status as keyof typeof rank], `check ${index} went backward at snapshot ${i}`));
    }
    const last = seen[seen.length - 1]!;
    assert.deepEqual(last.checks.map((c) => c.status), ['passed', 'passed', 'passed']);
    assert.notEqual(last.finishedAt, null);
    for (const c of last.checks) assert.equal(typeof c.durationMs, 'number');
    // Only the last snapshot of a passing gate is finished.
    assert.ok(seen.slice(0, -1).every((g) => g.finishedAt === null || g.checks.every((c) => c.status !== 'pending')));
  });

  it('publishes snapshots, not the live state', async () => {
    const { guard, seen } = gateGuard([{ name: 'a', command: 'exit 0' }]);
    await guard('Agent review');
    assert.equal(seen[0]?.checks[0]?.status, 'pending', 'the first snapshot stays pending');
    assert.equal(seen[0]?.finishedAt, null);
    assert.notEqual(seen[0], seen[seen.length - 1]);
  });

  it('reports the timeout of every check, including those not started yet', async () => {
    const { guard, seen } = gateGuard([
      { name: 'a', command: 'exit 0', timeoutMs: 5_000 },
      { name: 'b', command: 'exit 0', timeoutMs: 7_000 },
    ]);
    await guard('Agent review');
    assert.deepEqual(seen[0]?.checks.map((c) => c.timeoutMs), [5_000, 7_000]);
  });

  it('marks a timed out check without output and leaves the rest pending', async () => {
    const { guard, seen } = gateGuard([
      { name: 'slow', command: 'sleep 5', timeoutMs: 300 },
      { name: 'after', command: 'exit 0' },
    ]);
    assert.equal(denied(await guard('Agent review'))?.category, 'check_timeout');
    const last = seen[seen.length - 1]!;
    assert.deepEqual(last.checks.map((c) => c.status), ['check_timeout', 'pending']);
    assert.equal(last.checks[0]?.output, null);
    assert.notEqual(last.finishedAt, null);
  });

  it('keeps the output of a single failing check exactly as the agent gets it, capped at the limit and from the end', async () => {
    const { guard, seen } = gateGuard([{ name: 'ci', command: 'echo HEADMARK; yes filler | head -c 20000; echo TAILMARK; exit 1' }]);
    const decision = denied(await guard('Agent review'));
    assert.equal(decision?.category, 'check_failed');
    const output = seen[seen.length - 1]!.checks[0]!.output ?? '';
    assert.ok(output.length <= CHECK_OUTPUT_LIMIT);
    assert.ok(output.endsWith('TAILMARK'));
    assert.ok(!output.includes('HEADMARK'));
    assert.ok(decision?.message.includes(output), 'the agent message contains the same tail');
  });

  it('shows short output unshortened and an empty output as an empty string', async () => {
    const { guard, seen } = gateGuard([{ name: 'ci', command: 'echo short; exit 1' }]);
    await guard('Agent review');
    assert.equal(seen[seen.length - 1]!.checks[0]!.output, 'short');
    const quiet = gateGuard([{ name: 'ci', command: 'exit 1' }]);
    await quiet.guard('Agent review');
    assert.equal(quiet.seen[quiet.seen.length - 1]!.checks[0]!.output, '');
  });

  it('keeps passed checks with the end of their output and exposes the exit code of failures', async () => {
    const { guard, seen } = gateGuard([
      { name: 'ok', command: 'echo fine; exit 0' },
      { name: 'bad', command: 'echo nope; exit 3' },
    ]);
    const decision = denied(await guard('Agent review'));
    assert.equal(decision?.category, 'check_error');
    const last = seen[seen.length - 1]!;
    assert.equal(last.checks[0]?.output, 'fine');
    assert.equal(last.checks[0]?.exitCode, 0);
    assert.equal(last.checks[1]?.status, 'check_error');
    assert.equal(last.checks[1]?.exitCode, 3);
    assert.match(last.checks[1]?.output ?? '', /nope/);
  });

  it('flags only reused checks as cached and reports an all-cached gate as finished', async () => {
    const { guard, seen, cache } = gateGuard([
      { name: 'a', command: 'exit 0' },
      { name: 'b', command: 'exit 0' },
    ]);
    await guard('Agent review');
    assert.ok(seen.every((g) => g.checks.every((c) => !c.cached)));
    seen.length = 0;
    await guard('Agent review');
    assert.ok(seen.length >= 1);
    const all = seen[seen.length - 1]!;
    assert.deepEqual(all.checks.map((c) => [c.status, c.cached]), [['passed', true], ['passed', true]]);
    assert.notEqual(all.finishedAt, null);
    cache.delete([...cache.keys()][0]!);
    seen.length = 0;
    await guard('Agent review');
    const mixed = seen[seen.length - 1]!;
    assert.deepEqual(mixed.checks.map((c) => c.cached), [false, true]);
    assert.deepEqual(mixed.checks.map((c) => c.status), ['passed', 'passed']);
  });

  it('reports no gate for a move without checks and for a denied move', async () => {
    const { guard, seen } = gateGuard([{ name: 'a', command: 'exit 0' }]);
    assert.ok((await guard('In progress')).allow);
    assert.equal(denied(await guard('Done'))?.category, 'transition_denied');
    assert.equal(seen.length, 0);
  });

  const STEPS_SCRIPT = "echo build-noise; echo 'host load at end (1/5/15 min): 1.00 2.00 3.00, 8 CPUs'; echo 'steps:'; echo '  Pint (changed files)  3s  ok'; echo '  phpunit tests  2m 10s  ok'";

  it('keeps the steps block of a passed check in gate.checks[].output, cut from the host load line on', async () => {
    const { guard, seen } = gateGuard([{ name: 'ci', command: STEPS_SCRIPT }]);
    const decision = await guard('Agent review');
    assert.ok(decision.allow);
    const out = seen[seen.length - 1]!.checks[0]!.output ?? '';
    assert.ok(out.startsWith('host load at end (1/5/15 min): 1.00 2.00 3.00, 8 CPUs'));
    assert.ok(out.includes('Pint (changed files)  3s  ok'));
    assert.ok(out.endsWith('phpunit tests  2m 10s  ok'));
    assert.ok(!out.includes('build-noise'));
    assert.ok(out.length <= 400);
  });

  it('keeps the output of a skipped check too', async () => {
    const { guard, seen } = gateGuard([{ name: 'docs', command: 'echo no app here; exit 78' }, { name: 'quiet', command: 'exit 78' }]);
    assert.ok((await guard('Agent review')).allow);
    const [docs, quiet] = seen[seen.length - 1]!.checks;
    assert.deepEqual([docs?.status, docs?.output], ['skipped', 'no app here']);
    assert.deepEqual([quiet?.status, quiet?.output], ['skipped', null]);
  });

  it('starts at steps: when there is no host load line, and at the earlier of the two when both exist', async () => {
    const onlySteps = gateGuard([{ name: 'ci', command: "echo noise; echo 'steps:'; echo '  tests  4s  ok'" }]);
    await onlySteps.guard('Agent review');
    assert.equal(onlySteps.seen[onlySteps.seen.length - 1]!.checks[0]!.output, 'steps:\n  tests  4s  ok');
    const both = gateGuard([{ name: 'ci', command: "echo noise; echo 'steps:'; echo '  tests  4s  ok'; echo 'host load at end (1/5/15 min): 0.1 0.2 0.3, 2 CPUs'" }]);
    await both.guard('Agent review');
    assert.ok((both.seen[both.seen.length - 1]!.checks[0]!.output ?? '').startsWith('steps:'));
  });

  it('caps a long steps block at a few hundred characters, keeping the end', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `echo '  step number ${i}  ${i}s  ok'`).join('; ');
    const { guard, seen } = gateGuard([{ name: 'ci', command: `echo 'host load at end (1/5/15 min): 1 2 3, 4 CPUs'; echo 'steps:'; ${lines}` }]);
    assert.ok((await guard('Agent review')).allow);
    const out = seen[seen.length - 1]!.checks[0]!.output ?? '';
    assert.ok(out.length > 0 && out.length <= 500, `length ${out.length}`);
    assert.ok(out.endsWith('step number 39  39s  ok'));
  });

  it('keeps the tool answer for a passed check at the note, without any output', async () => {
    const { guard } = gateGuard([{ name: 'ci', command: STEPS_SCRIPT }, { name: 'lint', command: 'echo lint-noise' }]);
    const decision = await guard('Agent review');
    assert.ok(decision.allow);
    assert.equal(decision.allow && decision.note, CHECK_PASSED_NOTE);
    const answer = JSON.stringify(decision.allow ? decision.note : decision);
    assert.ok(!answer.includes('host load') && !answer.includes('lint-noise') && !answer.includes('steps:'));
  });

  it('leaves the output of a failed check as it was: the tail up to the limit, not cut at steps:', async () => {
    const { guard, seen } = gateGuard([{ name: 'ci', command: "echo HEADMARK; echo 'host load at end (1/5/15 min): 1 2 3, 4 CPUs'; echo 'steps:'; echo '  tests  4s  failed'; exit 1" }]);
    const decision = denied(await guard('Agent review'));
    assert.equal(decision?.category, 'check_failed');
    const out = seen[seen.length - 1]!.checks[0]!.output ?? '';
    assert.ok(out.startsWith('HEADMARK'), 'the whole short output of a failure is kept');
    assert.ok(decision?.message.includes(out));
  });

  it('treats exit 78 as skipped', async () => {
    const { guard, seen } = gateGuard([{ name: 'docs', command: 'exit 78' }, { name: 'ci', command: 'exit 0' }]);
    assert.ok((await guard('Agent review')).allow);
    assert.deepEqual(seen[seen.length - 1]!.checks.map((c) => c.status), ['skipped', 'passed']);
  });
});

// ---------------------------------------------------------------- API

function request(port: number, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: urlPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function gateOrchestrator(commands: Array<{ name: string; command: string; timeout_ms?: number }>, script: ConstructorParameters<typeof FakeRunner>[0], extra: { history?: HistoryLog } = {}) {
  const front = baseFront(tempDir(), {
    tracker: { kind: 'github_project', provider: { owner: 'acme', project_number: 1, token: 'test-token' }, active_states: ['Todo', 'Agent review'] },
    checks: { on_enter: { 'Agent review': commands } },
  });
  return new Orchestrator({
    workflow: new StaticWorkflow(makeWorkflow(front)),
    runner: new FakeRunner(script),
    logger: Logger.silent(),
    env: {},
    logDir: null,
    timers: new ManualTimers(),
    createAdapter: () => new FakeTracker([makeIssue({ id: 'g' })]),
    ...extra,
  });
}

describe('API and repository log: a passed check with steps', () => {
  const script = "echo noise; echo 'host load at end (1/5/15 min): 0.50 1.25 2.00, 4 CPUs'; echo 'steps:'; echo '  Pint  3s  ok'; echo '  tests  1m 5s  timed out (aborted)'";

  it('serves the kept output in the gate, and writes steps and load to checks_finished', async () => {
    const dir = tempDir();
    const history = new HistoryLog(path.join(dir, 'repositories'), new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent()), Logger.silent());
    let answer: unknown = null;
    const orchestrator = gateOrchestrator(
      [{ name: 'ci', command: script }],
      async (_turn, params) => {
        answer = await callTool(params, 'set_status', { status: 'Agent review' });
        return { ok: true, turnId: '1', resultText: 'done' };
      },
      { history },
    );
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      await orchestrator.tickNow();
      await until(() => orchestrator.issueDetail('acme/app#g')?.gate?.finished_at != null, 5_000, 'finished gate');
      const detail = JSON.parse((await request(server.port, `/api/v1/${encodeURIComponent('acme/app#g')}`)).body);
      const [ci] = detail.gate.checks;
      assert.equal(ci.status, 'passed');
      assert.ok(ci.output.startsWith('host load at end'));
      assert.match(ci.output, /tests {2}1m 5s {2}timed out \(aborted\)$/);
      assert.ok(!ci.output.includes('noise'));
      assert.ok(!JSON.stringify(answer).includes('host load'), 'the tool answer carries no output');
      assert.ok(JSON.stringify(answer).includes(CHECK_PASSED_NOTE));
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
    const finished = readHistory(history.dir, null).entries.filter((entry) => entry.event === 'checks_finished');
    assert.ok(finished.length >= 1);
    const fields = finished[0]!.fields;
    assert.equal(fields.result, 'passed');
    assert.deepEqual(JSON.parse(fields.steps ?? 'null'), [
      { name: 'Pint', duration_s: 3, result: 'ok' },
      { name: 'tests', duration_s: 65, result: 'timed out (aborted)' },
    ]);
    assert.deepEqual(JSON.parse(fields.load ?? 'null'), { '1m': 0.5, '5m': 1.25, '15m': 2, cpus: 4 });
  });

  it('writes checks_finished without steps and load for other output', async () => {
    const dir = tempDir();
    const history = new HistoryLog(path.join(dir, 'repositories'), new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent()), Logger.silent());
    const orchestrator = gateOrchestrator(
      [{ name: 'ci', command: 'echo all good; echo steps are fine' }],
      async (_turn, params) => {
        await callTool(params, 'set_status', { status: 'Agent review' });
        return { ok: true, turnId: '1', resultText: 'done' };
      },
      { history },
    );
    try {
      await orchestrator.tickNow();
      await until(() => orchestrator.issueDetail('acme/app#g')?.gate?.finished_at != null, 5_000, 'finished gate');
      assert.equal(orchestrator.issueDetail('acme/app#g')?.gate?.checks[0]?.output, 'all good\nsteps are fine');
    } finally {
      await orchestrator.shutdown(1_000);
    }
    const [entry] = readHistory(history.dir, null).entries.filter((e) => e.event === 'checks_finished');
    assert.equal(entry?.fields.result, 'passed');
    assert.equal('steps' in (entry?.fields ?? {}) || 'load' in (entry?.fields ?? {}), false);
  });
});

describe('API: GET /api/v1/<identifier> gate', () => {
  it('serves a failed check with the output the agent got, and a fresh gate after a second move', async () => {
    let first: unknown = null;
    const orchestrator = gateOrchestrator(
      [
        { name: 'lint', command: 'exit 0' },
        { name: 'ci', command: 'if [ -f "$SYMPHONY_WORKSPACE/fixed" ]; then exit 0; fi; echo "HEADMARK"; yes filler | head -c 20000; echo "TAILMARK"; exit 1' },
      ],
      async (_turn, params) => {
        first = await callTool(params, 'set_status', { status: 'Agent review' });
        return { ok: true, turnId: '1', resultText: 'done' };
      },
    );
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      await orchestrator.tickNow();
      await until(() => orchestrator.issueDetail('acme/app#g')?.gate?.finished_at != null, 5_000, 'finished gate');
      const detail = JSON.parse((await request(server.port, `/api/v1/${encodeURIComponent('acme/app#g')}`)).body);
      assert.equal(detail.gate.target, 'Agent review');
      assert.match(detail.gate.sha ?? 'null-sha', /^([0-9a-f]{7,40}|null-sha)$/);
      const [lint, ci] = detail.gate.checks;
      assert.deepEqual([lint.name, lint.status, lint.cached, lint.output], ['lint', 'passed', false, null]);
      assert.deepEqual([ci.name, ci.status, ci.exit_code], ['ci', 'check_failed', 1]);
      assert.equal(typeof ci.timeout_ms, 'number');
      assert.equal(typeof ci.duration_ms, 'number');
      assert.ok(ci.output.length <= CHECK_OUTPUT_LIMIT);
      assert.ok(ci.output.endsWith('TAILMARK'));
      const message = JSON.stringify(first);
      assert.ok(message.includes(JSON.stringify(ci.output).slice(1, -1)), 'the tool result to the agent contains the gate output');
      assert.equal(detail.last_check.result, 'check_failed');
      assert.equal(detail.last_check.target, 'Agent review');
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });

  it('shows pending checks of a running gate with their timeouts and keeps last_check unset until one finishes', async () => {
    const orchestrator = gateOrchestrator(
      [
        { name: 'first', command: 'while [ ! -f "$SYMPHONY_WORKSPACE/go" ]; do sleep 0.02; done; exit 0', timeout_ms: 20000 },
        { name: 'second', command: 'exit 0', timeout_ms: 40000 },
      ],
      async (_turn, params) => {
        void callTool(params, 'set_status', { status: 'Agent review' });
        return new Promise((resolve) => params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: '1', code: 'turn_cancelled', message: 'cancelled' })));
      },
    );
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      await orchestrator.tickNow();
      await until(() => orchestrator.issueDetail('acme/app#g')?.gate?.checks[0]?.status === 'running', 5_000, 'first check running');
      const detail = JSON.parse((await request(server.port, `/api/v1/${encodeURIComponent('acme/app#g')}`)).body);
      assert.equal(detail.gate.finished_at, null);
      assert.deepEqual(detail.gate.checks.map((c: { name: string; status: string; timeout_ms: number }) => [c.name, c.status, c.timeout_ms]), [['first', 'running', 20000], ['second', 'pending', 40000]]);
      assert.equal(detail.gate.checks[1].started_at, null);
      assert.equal(detail.gate.checks[1].duration_ms, null);
      assert.equal(detail.gate.checks[1].output, null);
      assert.equal(detail.last_check, null);
      const a = detail.gate.checks[0].duration_ms as number;
      await new Promise((r) => setTimeout(r, 120));
      const again = JSON.parse((await request(server.port, `/api/v1/${encodeURIComponent('acme/app#g')}`)).body);
      assert.ok(again.gate.checks[0].duration_ms > a, 'the running time is computed per request');
      fs.writeFileSync(path.join(orchestrator.issueDetail('acme/app#g')!.workspace.path as string, 'go'), '');
      await until(() => orchestrator.issueDetail('acme/app#g')?.gate?.finished_at != null, 5_000, 'finished gate');
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });

  it('starts a fresh gate on the next move', async () => {
    const results: unknown[] = [];
    const orchestrator = gateOrchestrator([{ name: 'ci', command: 'if [ -f "$SYMPHONY_WORKSPACE/fixed" ]; then exit 0; fi; exit 1' }], async (_turn, params) => {
      results.push(await callTool(params, 'set_status', { status: 'Agent review' }));
      fs.writeFileSync(path.join(orchestrator.issueDetail('acme/app#g')!.workspace.path as string, 'fixed'), '');
      results.push(await callTool(params, 'set_status', { status: 'Agent review' }));
      return { ok: true, turnId: '1', resultText: 'done' };
    });
    try {
      await orchestrator.tickNow();
      await until(() => results.length === 2, 5_000, 'two moves');
      await until(() => orchestrator.issueDetail('acme/app#g')?.gate?.finished_at != null, 5_000, 'finished gate');
      const gate = orchestrator.issueDetail('acme/app#g')?.gate;
      assert.equal(gate?.checks.length, 1);
      assert.equal(gate?.checks[0]?.status, 'passed');
      assert.equal(gate?.checks[0]?.output, null);
    } finally {
      await orchestrator.shutdown(1_000);
    }
  });

  it('returns gate: null and an unchanged last_check for an issue without checks', async () => {
    const front = baseFront(tempDir(), {
      tracker: { kind: 'github_project', provider: { owner: 'acme', project_number: 1, token: 'test-token' }, active_states: ['Todo'] },
    });
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(front)),
      runner: new FakeRunner(async (_turn, params) => {
        await callTool(params, 'set_status', { status: 'In progress' });
        return { ok: true, turnId: '1', resultText: 'done' };
      }),
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker([makeIssue({ id: 'n' })]),
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      await orchestrator.tickNow();
      await until(() => orchestrator.snapshot().counts.running === 0, 5_000, 'run end');
      const detail = JSON.parse((await request(server.port, `/api/v1/${encodeURIComponent('acme/app#n')}`)).body);
      assert.equal(detail.gate, null);
      assert.equal(detail.last_check, null);
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });
});

// ---------------------------------------------------------------- page

class Node {
  tag: string;
  text: string;
  className: string;
  children: Node[] = [];
  hidden = false;
  open = false;
  constructor(tag: string, text?: string | null, className?: string) {
    this.tag = tag;
    this.text = text ?? '';
    this.className = className ?? '';
  }
  append(...items: Array<Node | string>): void {
    for (const item of items) this.children.push(typeof item === 'string' ? new Node('#text', item) : item);
  }
  get all(): string {
    return [this.text, ...this.children.map((c) => c.all)].filter((t) => t !== '').join(' ');
  }
  querySelector(tag: string): Node | null {
    return this.find((n) => n.tag === tag && n !== this)[0] ?? null;
  }
  find(predicate: (node: Node) => boolean): Node[] {
    return [...(predicate(this) ? [this] : []), ...this.children.flatMap((c) => c.find(predicate))];
  }
}

function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `${from} exists`);
  return source.slice(start, source.indexOf(to, start) + to.length);
}

function renderGate(detail: unknown, previous: Node[] = []) {
  const nodes = new Map<string, Node>();
  nodes.set('gate-checks', new Node('ul'));
  nodes.get('gate-checks')!.children = previous;
  const node = (id: string) => nodes.get(id) ?? nodes.set(id, new Node('div')).get(id)!;
  const context = vm.createContext({
    el: (tag: string, text?: string | null, cls?: string) => new Node(tag, text, cls),
    $: node,
    setText: (n: Node, text: string) => {
      n.text = text;
    },
    patchChildren: (host: Node, children: Node[]) => {
      host.children = children;
    },
    S: { detail },
  });
  // The real formatters and the real gate renderer of the page.
  vm.runInContext(between(BASE_JS, 'const fmtDuration = ', '};\n'), context);
  vm.runInContext(between(BASE_JS, 'const fmtClock = ', ';\n'), context);
  vm.runInContext(between(AGENT_HTML, 'const fmtMs = ', ';\n'), context);
  vm.runInContext(between(AGENT_HTML, 'const GATE_STATUS', '};\n'), context);
  const start = AGENT_HTML.indexOf('function renderGate(');
  assert.notEqual(start, -1);
  vm.runInContext(AGENT_HTML.slice(start, AGENT_HTML.indexOf('\n  }\n', start) + 5), context);
  vm.runInContext('renderGate()', context);
  return { section: node('gate-section'), meta: node('gate-meta'), rows: node('gate-checks').children };
}

const check = (over: Record<string, unknown>) => ({ name: 'x', status: 'passed', started_at: null, duration_ms: 1000, timeout_ms: 60000, cached: false, exit_code: 0, output: null, ...over });
const gate = (checks: unknown[], over: Record<string, unknown> = {}) => ({ target: 'Agent review', role: 'developer', sha: '0123456789abcdef', started_at: '2026-10-25T10:00:00Z', finished_at: null, checks, ...over });

describe('agent page: entry checks section', () => {
  it('has the section markup, hidden until there is a gate', () => {
    assert.match(AGENT_HTML, /id="gate-section"[^>]*hidden/);
    assert.match(AGENT_HTML, /id="gate-checks"/);
    assert.match(AGENT_HTML, /renderGate\(\);/);
  });

  it('lists the checks in order with name and state, elapsed time against the timeout, and the commit', () => {
    const { section, meta, rows } = renderGate({
      gate: gate([
        check({ name: 'lint', status: 'passed', duration_ms: 3000 }),
        check({ name: 'ci', status: 'running', started_at: '2026-10-25T10:00:01Z', duration_ms: 12000, timeout_ms: 120000, exit_code: null }),
        check({ name: 'smoke', status: 'pending', duration_ms: null, exit_code: null }),
      ]),
    });
    assert.equal(section.hidden, false);
    assert.match(meta.text, /Agent review/);
    assert.match(meta.text, /0123456789ab/);
    assert.equal(rows.length, 3);
    assert.match(rows[0]!.all, /lint/);
    assert.match(rows[0]!.all, /passed/);
    assert.match(rows[1]!.all, /ci/);
    assert.match(rows[1]!.all, /running/);
    assert.match(rows[1]!.all, /12\.0s \/ 2m 0s/);
    assert.match(rows[2]!.all, /smoke/);
    assert.match(rows[2]!.all, /pending/);
    assert.doesNotMatch(rows[2]!.all, /\d+(\.\d)?s/);
  });

  it('shows every status of a finished gate with its own wording', () => {
    const { rows } = renderGate({
      gate: gate(
        [
          check({ name: 'a', status: 'skipped' }),
          check({ name: 'b', status: 'check_failed', exit_code: 1, output: 'x' }),
          check({ name: 'c', status: 'check_timeout', exit_code: null }),
          check({ name: 'd', status: 'check_error', exit_code: 2, output: 'y' }),
          check({ name: 'e', status: 'pending', duration_ms: null, exit_code: null }),
        ],
        { finished_at: '2026-10-25T10:01:00Z' },
      ),
    });
    assert.match(rows[0]!.all, /skipped/);
    assert.match(rows[1]!.all, /failed/);
    assert.match(rows[2]!.all, /timed out/);
    assert.match(rows[3]!.all, /error/);
    assert.match(rows[4]!.all, /not run/);
  });

  it('renders the output of failed checks as text, never as markup, and an empty output as a placeholder', () => {
    const evil = '<img src=x onerror=alert(1)> & "quotes"\nline two';
    const { rows } = renderGate({
      gate: gate([check({ name: 'ci', status: 'check_failed', exit_code: 1, output: evil }), check({ name: 'q', status: 'check_failed', exit_code: 1, output: '' })], { finished_at: '2026-10-25T10:01:00Z' }),
    });
    const pre = rows[0]!.find((n) => n.tag === 'pre');
    assert.equal(pre.length, 1);
    assert.equal(pre[0]!.text, evil);
    assert.equal(pre[0]!.children.length, 0);
    const empty = rows[1]!.find((n) => n.tag === 'pre');
    assert.equal(empty.length, 1);
    assert.notEqual(empty[0]!.text, '');
  });

  it('shows no output block for passed, running or timed out checks', () => {
    const { rows } = renderGate({ gate: gate([check({ status: 'passed' }), check({ status: 'running', exit_code: null }), check({ status: 'check_timeout', exit_code: null })]) });
    for (const row of rows) assert.equal(row.find((n) => n.tag === 'pre').length, 0);
  });

  it('folds the output of passed and skipped checks into a details element, as text', () => {
    const out = 'host load at end (1/5/15 min): 1 2 3, 4 CPUs\nsteps:\n  <b>tests</b>  4s  ok';
    const { rows } = renderGate({
      gate: gate([check({ name: 'a', status: 'passed', output: out }), check({ name: 'b', status: 'skipped', exit_code: 78, output: 'not applicable' })], { finished_at: '2026-10-25T10:01:00Z' }),
    });
    for (const [index, text] of [out, 'not applicable'].entries()) {
      const details = rows[index]!.find((n) => n.tag === 'details');
      assert.equal(details.length, 1, 'the output sits in a collapsed details element');
      const pre = details[0]!.find((n) => n.tag === 'pre');
      assert.equal(pre.length, 1);
      assert.equal(pre[0]!.text, text);
      assert.equal(pre[0]!.children.length, 0);
      assert.equal(rows[index]!.children.filter((n) => n.tag === 'pre').length, 0, 'not shown outside of the details element');
    }
  });

  it('keeps a details element open across a refresh', () => {
    const detail = { gate: gate([check({ name: 'a', status: 'passed', output: 'steps:' }), check({ name: 'b', status: 'passed', output: 'x' })], { finished_at: '2026-10-25T10:01:00Z' }) };
    const first = renderGate(detail).rows;
    first[0]!.querySelector('details')!.open = true;
    const again = renderGate(detail, first).rows;
    assert.equal(again[0]!.querySelector('details')!.open, true, 'the opened output stays open');
    assert.equal(again[1]!.querySelector('details')!.open, false);
  });

  it('shows no details element for a passed check without output, and keeps failed output outside of one', () => {
    const { rows } = renderGate({
      gate: gate([check({ status: 'passed', output: null }), check({ status: 'check_failed', exit_code: 1, output: 'boom' })], { finished_at: '2026-10-25T10:01:00Z' }),
    });
    assert.equal(rows[0]!.find((n) => n.tag === 'details' || n.tag === 'pre').length, 0);
    assert.equal(rows[1]!.find((n) => n.tag === 'details').length, 0);
    assert.equal(rows[1]!.children.filter((n) => n.tag === 'pre').length, 1);
  });

  it('labels cached checks "from cache" and nothing else', () => {
    const { rows } = renderGate({ gate: gate([check({ name: 'a', cached: true }), check({ name: 'b', cached: false })], { finished_at: '2026-10-25T10:01:00Z' }) });
    assert.match(rows[0]!.all, /from cache/);
    assert.doesNotMatch(rows[1]!.all, /cache/);
  });

  it('stays hidden and empty without a gate, so only "Last check" shows', () => {
    for (const detail of [{ gate: null, last_check: { target: 'Agent review' } }, {}, null]) {
      const { section, rows, meta } = renderGate(detail);
      assert.equal(section.hidden, true);
      assert.equal(rows.length, 0);
      assert.equal(meta.text, '');
    }
  });

  it('keeps the "Last check" line of the context in the page', () => {
    assert.match(AGENT_HTML, /Last check/);
  });
});
