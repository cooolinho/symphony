import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Logger } from '../src/log.ts';
import { createGuard, guardTools, toolsForRole } from '../src/orchestrator/guard.ts';
import { RESULT_TOOL, createResultTool, type ResultToolParams } from '../src/orchestrator/result-tool.ts';
import { interruptedLabels, interruptedTransition } from '../src/orchestrator/recovery.ts';
import { buildStageHistory, type PersistedResult } from '../src/orchestrator/stage-history.ts';
import type { Issue, ToolResult, TrackedResult } from '../src/tracker/types.ts';
import { decodeMarker, encodeMarker, internalResult, parseResult, type ResultMeta } from '../src/workflow/results.ts';
import { WorkspaceManager } from '../src/workspace/manager.ts';
import { FakeTracker, baseFront, makeIssue, makeWorkflow, tempDir } from './helpers.ts';

/** Independent tests for `pipeline.max_check_failures` (issue #303): derived from the issue, not from the implementation. */

const ROLES = {
  developer: { states: ['Todo', 'In progress'], result: 'implementation', may_move_to: ['Agent review', 'Blocked'], on_result: { done: 'Agent review' } },
  reviewer: {
    states: ['Agent review'],
    read_only: true,
    result: 'review',
    may_move_to: ['In review', 'In progress', 'Blocked', 'Needs a human'],
    on_result: { approved: 'In review', changes_needed: 'In progress' },
    on_check_failed: 'In progress',
  },
};
const FAILING = { 'In review': 'echo "phpstan broke"; exit 1' };
const APPROVED = { verdict: 'approved', summary: 'Looks good.' };

function meta(over: Partial<ResultMeta> = {}): ResultMeta {
  return { role: 'reviewer', run: 'run-x', round: null, profile: null, workflow_hash: null, head_sha: null, checks: null, target: null, created_at: '2026-10-18T10:00:00.000Z', ...over };
}

let clock = 0;
function persisted(kind: 'review' | 'security' | 'reset', verdict: string, over: Partial<ResultMeta> = {}): PersistedResult {
  clock += 1;
  const result =
    kind === 'reset'
      ? internalResult('reset', 'reset')
      : (parseResult(kind, kind === 'review' && verdict === 'changes_needed' ? { verdict, summary: 's', findings: [{ severity: 'major', problem: 'p' }] } : { verdict, summary: 's' }) as { ok: true; result: never }).result;
  return { result, meta: meta({ run: `run-${clock}`, created_at: new Date(Date.UTC(2026, 9, 18, 10, 0, clock)).toISOString(), ...over }) };
}

interface Options {
  history?: ResultToolParams['history'];
  reviewer?: Record<string, unknown>;
  pipeline?: Record<string, unknown>;
  checks?: Record<string, string>;
}

function setup(options: Options = {}) {
  const root = tempDir('symphony-maxcf-');
  const front = baseFront(root, {
    tracker: {
      kind: 'github_project',
      provider: { owner: 'acme', project_number: 1, token: 'test-token' },
      active_states: ['Todo', 'In progress', 'Agent review'],
    },
    roles: { ...ROLES, reviewer: { ...ROLES.reviewer, ...options.reviewer } },
    pipeline: { max_review_rounds: 3, ...options.pipeline },
    checks: { timeout_ms: 10_000, on_enter: options.checks ?? FAILING },
  });
  const config = makeWorkflow(front).config;
  const workspacePath = path.join(root, 'ws');
  fs.mkdirSync(workspacePath);
  const manager = new WorkspaceManager({ root, hooks: config.hooks, workflowDir: root }, { PATH: process.env.PATH }, Logger.silent());
  const role = config.roles?.find((r) => r.name === 'reviewer');
  assert.ok(role);
  const tracker = new FakeTracker([makeIssue({ id: '1', state: 'Agent review' })]);
  const current = (): Issue => {
    const issue = tracker.issues.get('1');
    assert.ok(issue);
    return issue;
  };
  const guard = createGuard({
    role,
    config,
    workspace: { path: workspacePath, key: 'ws', createdNow: false },
    issue: () => ({ id: '1', identifier: 'acme/app#1' }),
    manager,
    signal: new AbortController().signal,
    onEvent: () => undefined,
  });
  const params: ResultToolParams = {
    role,
    history: options.history ?? buildStageHistory([]),
    profile: null,
    flags: {},
    config,
    boardColumns: null,
    adapter: tracker,
    issue: current,
    runId: 'run-new',
    meta: { workflowHash: 'f'.repeat(64), headSha: async () => 'abc123def456abc1', now: () => new Date('2026-10-18T12:00:00Z') },
  };
  const tools = guardTools(toolsForRole(tracker.agentToolSpecs(), role, current(), createResultTool(params)), guard);
  const tool = tools.find((spec) => spec.name === RESULT_TOOL);
  assert.ok(tool);
  const report = (args: Record<string, unknown>): Promise<ToolResult> => tool.execute(args, { issue: current() });
  const markers = () => (tracker.comments.get('1') ?? []).map((comment) => decodeMarker(comment.body));
  return { tracker, report, markers, current, config, role };
}

function data(result: ToolResult): Record<string, unknown> {
  assert.ok(result.ok, result.ok ? '' : `${result.error.category}: ${result.error.message}`);
  return result.data as Record<string, unknown>;
}

/** History of `n` earlier hand-offs over on_check_failed, each from another run (the roles and result kinds alternate). */
function earlier(n: number, failedFor = 'In review'): PersistedResult[] {
  return Array.from({ length: n }, (_, i) =>
    i % 3 === 1
      ? persisted('security', 'passed', { role: 'auditor', target: 'In progress', check_failed_for: failedFor })
      : persisted('review', 'approved', { role: 'reviewer', target: 'In progress', check_failed_for: failedFor }),
  );
}

describe('max_check_failures: configuration', () => {
  const resolve = (pipeline: Record<string, unknown>) => setup({ pipeline }).config.pipeline.maxCheckFailures;

  it('defaults to 3', () => {
    assert.equal(resolve({}), 3);
  });
  it('takes an explicit integer', () => {
    assert.equal(resolve({ max_check_failures: 1 }), 1);
    assert.equal(resolve({ max_check_failures: 7 }), 7);
  });
  it('rejects values below 1 and non-integers', () => {
    for (const bad of [0, -1, 1.5, 'many']) {
      assert.throws(() => resolve({ max_check_failures: bad }), /pipeline\.max_check_failures/, `value ${String(bad)}`);
    }
  });
});

describe('max_check_failures: marker', () => {
  const result = (parseResult('review', APPROVED) as { ok: true; result: never }).result;

  it('round-trips check_failed_for through the marker', () => {
    const decoded = decodeMarker(encodeMarker(result, meta({ check_failed_for: 'In review', target: 'In progress' })));
    assert.equal(decoded?.meta.check_failed_for, 'In review');
    assert.deepEqual(decoded?.result, result);
  });
  it('round-trips a null check_failed_for', () => {
    assert.equal(decodeMarker(encodeMarker(result, meta({ check_failed_for: null })))?.meta.check_failed_for ?? null, null);
  });
  it('still reads a marker from before the field existed', () => {
    const old = { ...(result as object), meta: meta() };
    const decoded = decodeMarker(`<!-- symphony:result:v1 ${Buffer.from(JSON.stringify(old)).toString('base64url')} -->`);
    assert.ok(decoded !== null);
    assert.equal(decoded.meta.check_failed_for ?? null, null);
    assert.equal(buildStageHistory([{ result: decoded.result, meta: decoded.meta }]).checkFailures, 0);
  });
});

describe('max_check_failures: counting in buildStageHistory', () => {
  it('is 0 without hand-offs over on_check_failed', () => {
    assert.equal(buildStageHistory([]).checkFailures, 0);
    assert.equal(buildStageHistory([persisted('review', 'approved'), persisted('review', 'changes_needed')]).checkFailures, 0);
  });
  it('counts each marked hand-off, across rounds, roles and result kinds', () => {
    const history = buildStageHistory([
      persisted('review', 'approved', { check_failed_for: 'In review' }),
      persisted('review', 'changes_needed'),
      persisted('security', 'passed', { role: 'auditor', check_failed_for: 'In review' }),
      persisted('review', 'changes_needed'),
      persisted('review', 'approved', { check_failed_for: 'Done' }),
    ]);
    assert.equal(history.checkFailures, 3);
  });
  it('is not touched by the round counters', () => {
    const history = buildStageHistory([persisted('review', 'changes_needed'), persisted('review', 'approved', { check_failed_for: 'In review' })]);
    assert.deepEqual([history.reviewRounds, history.checkFailures], [1, 1]);
  });
  it('counts a run reported twice once', () => {
    const history = buildStageHistory([persisted('review', 'approved', { run: 'r1', check_failed_for: 'In review' }), persisted('review', 'approved', { run: 'r1', check_failed_for: 'In review' })]);
    assert.equal(history.checkFailures, 1);
  });
  it('starts again after a reset', () => {
    const history = buildStageHistory([...earlier(2), persisted('reset', 'reset'), ...earlier(1)]);
    assert.equal(history.checkFailures, 1);
    assert.equal(buildStageHistory([...earlier(2), persisted('reset', 'reset')]).checkFailures, 0);
  });
});

describe('max_check_failures: report_result', () => {
  const LABEL = 'needs-human';

  it('sends the 1st and 2nd hand-off to on_check_failed without a label', async () => {
    for (const n of [0, 1]) {
      const { report, tracker, current, markers } = setup({ history: buildStageHistory(earlier(n)) });
      const result = data(await report(APPROVED));
      assert.equal(result.target, 'In progress', `after ${n} earlier`);
      assert.deepEqual(tracker.statusCalls, ['In progress']);
      assert.deepEqual(current().labels, []);
      assert.equal(markers()[0]?.meta.check_failed_for, 'In review');
      assert.equal(markers()[0]?.meta.target, 'In progress');
    }
  });

  it('sends the 3rd to Blocked with needs-human when on_round_limit is not set, and names the failing check in the comment', async () => {
    const { report, tracker, current, markers } = setup({ history: buildStageHistory(earlier(2)) });
    const result = data(await report(APPROVED));
    assert.equal(result.target, 'Blocked');
    assert.deepEqual(tracker.statusCalls, ['Blocked']);
    assert.deepEqual(current().labels, [LABEL]);
    const [marker] = markers();
    assert.equal(marker?.meta.target, 'Blocked');
    assert.equal(marker?.meta.check_failed_for, 'In review');
    assert.match(marker?.result.summary ?? '', /In review/);
    assert.match(marker?.result.summary ?? '', /phpstan broke/);
    assert.equal(marker?.result.verdict, 'approved');
    assert.ok(tracker.comments.get('1')?.length === 1);
  });

  it('uses on_round_limit instead of Blocked when set', async () => {
    const { report, tracker, current } = setup({ history: buildStageHistory(earlier(2)), reviewer: { on_round_limit: 'Needs a human' } });
    assert.equal(data(await report(APPROVED)).target, 'Needs a human');
    assert.deepEqual(tracker.statusCalls, ['Needs a human']);
    assert.deepEqual(current().labels, [LABEL]);
  });

  it('counts hand-offs of different rounds (review rounds in between) together', async () => {
    const history = buildStageHistory([
      persisted('review', 'approved', { check_failed_for: 'In review' }),
      persisted('review', 'changes_needed'),
      persisted('review', 'approved', { check_failed_for: 'In review' }),
    ]);
    assert.equal(history.reviewRounds, 1);
    const { report, current } = setup({ history });
    assert.equal(data(await report(APPROVED)).target, 'Blocked');
    assert.deepEqual(current().labels, [LABEL]);
  });

  it('does not count hand-offs from before a reset', async () => {
    const { report, current } = setup({ history: buildStageHistory([...earlier(2), persisted('reset', 'reset')]) });
    assert.equal(data(await report(APPROVED)).target, 'In progress');
    assert.deepEqual(current().labels, []);
  });

  it('honours a configured limit: with max_check_failures 1 the first hand-off already goes to a human', async () => {
    const { report, current } = setup({ pipeline: { max_check_failures: 1 } });
    assert.equal(data(await report(APPROVED)).target, 'Blocked');
    assert.deepEqual(current().labels, [LABEL]);
  });

  it('honours a configured limit: with max_check_failures 2 the second goes to a human, the first does not', async () => {
    const first = setup({ pipeline: { max_check_failures: 2 } });
    assert.equal(data(await first.report(APPROVED)).target, 'In progress');
    const second = setup({ pipeline: { max_check_failures: 2 }, history: buildStageHistory(earlier(1)) });
    assert.equal(data(await second.report(APPROVED)).target, 'Blocked');
  });

  it('does not touch a hand-off whose check passes, however many failures came before', async () => {
    const { report, tracker, current, markers } = setup({ history: buildStageHistory(earlier(5)), checks: {} });
    assert.equal(data(await report(APPROVED)).target, 'In review');
    assert.deepEqual(tracker.statusCalls, ['In review']);
    assert.deepEqual(current().labels, []);
    assert.equal(markers()[0]?.meta.check_failed_for ?? null, null);
  });

  it('does not stamp check_failed_for on a verdict that the round limit redirects without a failed check', async () => {
    const { report, markers } = setup({ history: buildStageHistory(earlier(1)), checks: {} });
    data(await report({ verdict: 'changes_needed', summary: 'x', findings: [{ severity: 'major', problem: 'p' }] }));
    assert.equal(markers()[0]?.meta.check_failed_for ?? null, null);
  });

  it('counts across sessions end to end: three failing hand-offs make 2x In progress, then Blocked with needs-human', async () => {
    const written: PersistedResult[] = [];
    const targets: unknown[] = [];
    let labels: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = setup({ history: buildStageHistory(written) });
      targets.push(data(await s.report(APPROVED)).target);
      labels = s.current().labels;
      const [marker] = s.markers();
      assert.ok(marker);
      // Each round gets its own run id, as in production.
      written.push({ result: marker.result, meta: { ...marker.meta, run: `run-${i}`, created_at: new Date(Date.UTC(2026, 9, 18, 10, 0, i)).toISOString() } });
    }
    assert.deepEqual(targets, ['In progress', 'In progress', 'Blocked']);
    assert.deepEqual(labels, [LABEL]);
  });
});

describe('max_check_failures: recovery of an interrupted hand-off', () => {
  const BOARD = ['Ready', 'In progress', 'Agent review', 'Blocked', 'In review', 'Done'];
  const { config, role } = setup();
  const tracked = (entry: PersistedResult, n: number): TrackedResult => ({
    result: entry.result,
    meta: entry.meta,
    createdAt: new Date(entry.meta.created_at),
    url: `https://github.com/acme/app/issues/1#c${n}`,
  });
  const issue = { labels: [] as string[], description: null };

  function interrupted(list: TrackedResult[]) {
    const found = interruptedTransition({ state: 'Agent review', native_ref: { status_updated_at: '2026-10-17T00:00:00Z' } }, role, list);
    assert.ok(found !== null);
    return found;
  }

  it('the 3rd failed-check hand-off whose move did not happen still gets needs-human when recovered', () => {
    const list = [
      ...earlier(2),
      persisted('review', 'approved', { target: 'Blocked', check_failed_for: 'In review', created_at: '2026-10-18T11:00:00.000Z' }),
    ].map(tracked);
    const labels = interruptedLabels(interrupted(list), list, role, config, BOARD, issue);
    assert.deepEqual(labels.add, ['needs-human']);
  });

  it('an interrupted 1st failed-check hand-off (to on_check_failed) gets no label change', () => {
    const list = [persisted('review', 'approved', { target: 'In progress', check_failed_for: 'In review', created_at: '2026-10-18T11:00:00.000Z' })].map(tracked);
    assert.deepEqual(interruptedLabels(interrupted(list), list, role, config, BOARD, issue), { add: [], remove: [] });
  });
});
