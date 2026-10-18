import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Logger } from '../src/log.ts';
import { createGuard, guardTools, toolsForRole } from '../src/orchestrator/guard.ts';
import { RESULT_RECORDED_NOTE, RESULT_TOOL, createResultTool, type ResultToolParams } from '../src/orchestrator/result-tool.ts';
import { buildStageHistory } from '../src/orchestrator/stage-history.ts';
import type { Issue, StatusChange, ToolResult } from '../src/tracker/types.ts';
import { decodeMarker, toolInputShape } from '../src/workflow/results.ts';
import { WorkspaceManager } from '../src/workspace/manager.ts';
import { FakeTracker, baseFront, makeIssue, makeWorkflow, tempDir } from './helpers.ts';

const ROLES = {
  developer: { states: ['Todo', 'In progress'], result: 'implementation', may_move_to: ['Agent review', 'Blocked'], on_result: { done: 'Agent review' } },
  reviewer: {
    states: ['Agent review'],
    read_only: true,
    result: 'review',
    may_move_to: ['In review', 'In progress', 'Blocked'],
    on_result: { approved: 'In review', changes_needed: 'In progress' },
    on_round_limit: 'In review',
  },
  planner: { states: ['Todo'], commands: ['plan'], result: 'analysis', may_move_to: ['In progress', 'Blocked'], on_result: { ready: 'next' } },
};

const APPROVED = { verdict: 'approved', summary: 'Looks good.', findings: [{ severity: 'nit', problem: 'Typo in a comment' }] };
const CHANGES = { verdict: 'changes_needed', summary: 'Two problems.', findings: [{ severity: 'major', file: 'src/a.ts', line: 3, problem: 'Off by one' }] };

interface SetupOptions {
  checks?: Record<string, string>;
  timeoutMs?: number;
  role?: string;
  history?: ResultToolParams['history'];
  labels?: string[];
  reviewer?: Record<string, unknown>;
}

function setup(options: SetupOptions = {}) {
  const root = tempDir('symphony-result-');
  const front = baseFront(root, {
    tracker: {
      kind: 'github_project',
      provider: { owner: 'acme', project_number: 1, token: 'test-token' },
      active_states: ['Todo', 'In progress', 'Agent review'],
    },
    roles: { ...ROLES, reviewer: { ...ROLES.reviewer, ...options.reviewer } },
    pipeline: { max_review_rounds: 3 },
    checks: { timeout_ms: options.timeoutMs ?? 10_000, on_enter: options.checks ?? {} },
  });
  const config = makeWorkflow(front).config;
  const workspacePath = path.join(root, 'ws');
  fs.mkdirSync(workspacePath);
  const manager = new WorkspaceManager({ root, hooks: config.hooks, workflowDir: root }, { PATH: process.env.PATH }, Logger.silent());
  const role = config.roles?.find((r) => r.name === (options.role ?? 'reviewer'));
  assert.ok(role);
  const tracker = new FakeTracker([makeIssue({ id: '1', state: 'Agent review', labels: options.labels ?? [] })]);
  const current = (): Issue => {
    const issue = tracker.issues.get('1');
    assert.ok(issue);
    return issue;
  };
  const events: string[] = [];
  const guard = createGuard({
    role,
    config,
    workspace: { path: workspacePath, key: 'ws', createdNow: false },
    issue: () => ({ id: '1', identifier: 'acme/app#1' }),
    manager,
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  const params: ResultToolParams = {
    role,
    history: options.history ?? { reviewRounds: 0, testRounds: 0 },
    profile: null,
    flags: {},
    config,
    boardColumns: null,
    adapter: tracker,
    issue: current,
    runId: 'run-1',
    meta: { workflowHash: 'f'.repeat(64), headSha: async () => 'abc123def456abc1', now: () => new Date('2026-10-18T12:00:00Z') },
  };
  const unguarded = createResultTool(params);
  const tools = guardTools(toolsForRole(tracker.agentToolSpecs(), role, unguarded), guard);
  const tool = tools.find((spec) => spec.name === RESULT_TOOL);
  assert.ok(tool);
  const report = (args: Record<string, unknown>) => tool.execute(args, { issue: current() });
  const markers = () => (tracker.comments.get('1') ?? []).map((comment) => decodeMarker(comment.body));
  return { tracker, tools, tool, unguarded, report, markers, events, workspacePath, params, current };
}

function data(result: ToolResult): Record<string, unknown> {
  assert.ok(result.ok, result.ok ? '' : `${result.error.category}: ${result.error.message}`);
  return result.data as Record<string, unknown>;
}

function error(result: ToolResult): { category: string; message: string } {
  assert.ok(!result.ok, 'expected a tool error');
  return result.error;
}

describe('report_result', () => {
  it('replaces set_status for the role and advertises the result schema of its kind', () => {
    const { tools, unguarded } = setup();
    assert.deepEqual(tools.map((spec) => spec.name), [RESULT_TOOL], 'the fake tracker offers only set_status');
    assert.deepEqual(Object.keys(unguarded.inputSchema), Object.keys(toolInputShape('review')));
    assert.match(unguarded.description, /approved, changes_needed, blocked/);
    assert.equal(unguarded.mutates, true);
  });

  it('records the result after the entry check passed: comment with marker, move, note', async () => {
    const { report, tracker, markers, events } = setup({ checks: { 'In review': 'test "$SYMPHONY_ROLE" = reviewer' } });
    const result = data(await report(APPROVED));
    assert.equal(result.note, RESULT_RECORDED_NOTE);
    assert.equal(result.target, 'In review');
    assert.equal(result.status, 'In review');
    assert.equal(result.previous_status, 'Agent review');
    assert.equal(result.round, 1);
    assert.equal(result.checks, 'passed');
    assert.equal(result.comment_url, 'https://github.com/acme/app/issues/1#issuecomment-1');
    assert.deepEqual(events, ['checks_started', 'checks_finished']);
    assert.deepEqual(tracker.statusCalls, ['In review']);

    const [comment] = tracker.comments.get('1') ?? [];
    assert.match(comment?.body ?? '', /^### ✅ Review: approved/);
    const [marker] = markers();
    assert.equal(marker?.result.kind, 'review');
    assert.equal(marker?.result.verdict, 'approved');
    assert.deepEqual(
      { ...marker?.meta, checks: { ...marker?.meta.checks, duration_ms: 0, finished_at: '' } },
      {
        role: 'reviewer',
        run: 'run-1',
        round: 1,
        profile: null,
        workflow_hash: 'f'.repeat(64),
        head_sha: 'abc123def456abc1',
        checks: { result: 'passed', ok: true, exit_code: 0, timed_out: false, duration_ms: 0, sha: null, finished_at: '' },
        target: 'In review',
        created_at: '2026-10-18T12:00:00.000Z',
      },
    );
  });

  it('records a move without an entry check with checks null', async () => {
    const { report, tracker, markers } = setup();
    const result = data(await report(CHANGES));
    assert.equal(result.target, 'In progress');
    assert.equal(result.checks, null);
    assert.deepEqual(tracker.statusCalls, ['In progress']);
    assert.equal(markers()[0]?.meta.checks, null);
    assert.equal(markers()[0]?.meta.round, 1);
  });

  it('on check_failed writes no marker, returns the check output and records once the check passes', async () => {
    const { report, tracker, markers, workspacePath } = setup({ checks: { 'In review': 'test -f fixed || { echo "3 tests failed"; exit 1; }' } });
    const failed = error(await report(APPROVED));
    assert.equal(failed.category, 'check_failed');
    assert.match(failed.message, /3 tests failed/);
    assert.match(failed.message, /call report_result again/);
    assert.equal(tracker.comments.get('1'), undefined);
    assert.deepEqual(tracker.statusCalls, []);

    fs.writeFileSync(path.join(workspacePath, 'fixed'), '');
    assert.equal(data(await report(APPROVED)).target, 'In review');
    assert.equal(markers().length, 1);
    assert.equal(markers()[0]?.meta.round, 1, 'the failed check did not count as a round');
    assert.equal(buildStageHistory(markers().filter((m) => m !== null)).reviewRounds, 0);
  });

  it('on check_timeout writes nothing and tells the agent to call report_result once more', async () => {
    const { report, tracker } = setup({ checks: { 'In review': 'sleep 5' }, timeoutMs: 200 });
    const timedOut = error(await report(APPROVED));
    assert.equal(timedOut.category, 'check_timeout');
    assert.match(timedOut.message, /Call report_result again once/);
    assert.equal(tracker.comments.get('1'), undefined);
    assert.deepEqual(tracker.statusCalls, []);
  });

  it('rejects an invalid result with every problem, before the guard runs', async () => {
    const { report, tracker, events } = setup({ checks: { 'In review': 'exit 0', 'In progress': 'exit 0' } });
    const inconsistent = error(await report({ verdict: 'changes_needed', summary: 'Needs work.' }));
    assert.equal(inconsistent.category, 'invalid_result');
    assert.match(inconsistent.message, /The review result is invalid/);
    assert.match(inconsistent.message, /verdict "changes_needed" needs at least one entry in `findings`/);

    const malformed = error(await report({ verdict: 'passed', summary: '', colour: 'red' }));
    assert.equal(malformed.category, 'invalid_result');
    assert.match(malformed.message, /`verdict`/);
    assert.match(malformed.message, /`summary`/);
    assert.match(malformed.message, /unknown field\(s\): `colour`/);

    assert.deepEqual(events, [], 'no entry check ran');
    assert.equal(tracker.comments.get('1'), undefined);
    assert.deepEqual(tracker.statusCalls, []);
  });

  it('a second call in the same run returns the stored result without a second comment', async () => {
    const { report, tracker, events } = setup({ checks: { 'In review': 'exit 0' } });
    const first = data(await report(APPROVED));
    const second = data(await report(CHANGES));
    assert.deepEqual(second, { ...first, already_recorded: true });
    assert.equal(tracker.comments.get('1')?.length, 1);
    assert.deepEqual(tracker.statusCalls, ['In review']);
    assert.deepEqual(events, ['checks_started', 'checks_finished'], 'the repeated call ran no check');
  });

  it('parallel calls record one result', async () => {
    const { report, tracker } = setup({ checks: { 'In review': 'sleep 0.1' } });
    const results = await Promise.all([report(APPROVED), report(APPROVED)]);
    assert.deepEqual(results.map((result) => data(result).already_recorded === true), [false, true]);
    assert.equal(tracker.comments.get('1')?.length, 1);
    assert.deepEqual(tracker.statusCalls, ['In review']);
  });

  it('returns status_failed when the move fails after the comment, and keeps it for the run', async () => {
    const { report, tracker, markers } = setup({ checks: { 'In review': 'exit 0' } });
    let attempts = 0;
    tracker.setStatus = async () => {
      attempts++;
      throw new Error('GitHub is down');
    };
    const failed = error(await report(APPROVED));
    assert.equal(failed.category, 'status_failed');
    assert.match(failed.message, /The review result was recorded \(https:\/\/github\.com\/acme\/app\/issues\/1#issuecomment-1\)/);
    assert.match(failed.message, /moving the issue to "In review" failed: GitHub is down/);
    assert.match(failed.message, /Do not report again/);
    assert.equal(markers().length, 1);
    assert.equal(markers()[0]?.meta.target, 'In review', 'the next run finds the pending move in the marker');

    assert.deepEqual(error(await report(APPROVED)), failed);
    assert.equal(markers().length, 1);
    assert.equal(attempts, 1);
  });

  it('records nothing when the comment cannot be posted, so the agent can report again', async () => {
    const { report, tracker } = setup();
    const post = tracker.postComment.bind(tracker);
    tracker.postComment = async () => {
      throw new Error('rate limited');
    };
    const failed = error(await report(APPROVED));
    assert.equal(failed.category, 'comment_failed');
    assert.match(failed.message, /rate limited/);
    assert.deepEqual(tracker.statusCalls, []);

    tracker.postComment = post;
    assert.equal(data(await report(APPROVED)).already_recorded, undefined);
    assert.equal(tracker.comments.get('1')?.length, 1);
    assert.deepEqual(tracker.statusCalls, ['In review']);
  });

  it('moving to the auto-merge column reports auto_merge like set_status', async () => {
    const { report, tracker } = setup({ checks: { 'In review': 'exit 0' } });
    const moved: string[] = [];
    tracker.setStatus = async (issue, column): Promise<StatusChange> => {
      moved.push(column);
      return {
        previous: issue.state,
        status: 'Done',
        autoMerge: { merged: true, pull_request: 42, status: 'Done', reason: 'merged pull request #42' },
      };
    };
    const result = data(await report(APPROVED));
    assert.deepEqual(moved, ['In review']);
    assert.equal(result.status, 'Done');
    assert.deepEqual(result.auto_merge, { merged: true, pull_request: 42, status: 'Done', reason: 'merged pull request #42' });
  });

  it('at the round limit moves to on_round_limit and adds the limit label; a later result removes it', async () => {
    const limit = setup({ history: { reviewRounds: 2, testRounds: 0 } });
    const result = data(await limit.report(CHANGES));
    assert.equal(result.target, 'In review');
    assert.equal(result.round, 3);
    assert.deepEqual(result.labels, { added: ['needs-human'], removed: [] });
    assert.deepEqual(limit.current().labels, ['needs-human']);
    assert.equal(limit.markers()[0]?.meta.round, 3);

    const next = setup({ history: { reviewRounds: 3, testRounds: 0 }, labels: ['needs-human'] });
    next.tracker.repositoryLabels.add('needs-human');
    assert.deepEqual(data(await next.report(APPROVED)).labels, { added: [], removed: ['needs-human'] });
    assert.deepEqual(next.current().labels, []);
  });

  it('reports label failures as warnings; the result and the move stand', async () => {
    const { report, tracker } = setup({ history: { reviewRounds: 2, testRounds: 0 } });
    tracker.addLabels = async () => {
      throw new Error('label service unavailable');
    };
    const result = data(await report(CHANGES));
    assert.deepEqual(tracker.statusCalls, ['In review']);
    assert.deepEqual(result.warnings, ['could not add label(s) needs-human: label service unavailable']);
    assert.equal(result.note, RESULT_RECORDED_NOTE);
  });

  it('writes nothing without the guard, or for a target the guard did not allow', async () => {
    const { unguarded, current, tracker } = setup();
    const direct = error(await unguarded.execute(APPROVED, { issue: current() }));
    assert.equal(direct.category, 'tool_error');
    assert.match(direct.message, /without the transition guard's approval for "In review"/);
    const elsewhere = error(await unguarded.execute(APPROVED, { issue: current(), transition: { target: 'In progress', check: null } }));
    assert.equal(elsewhere.category, 'tool_error');
    assert.equal(tracker.comments.get('1'), undefined);
    assert.deepEqual(tracker.statusCalls, []);
  });

  it('returns transition_error when the configuration cannot route the verdict', async () => {
    const { report, tracker, events } = setup({ role: 'planner' });
    const failed = error(await report({ verdict: 'ready', summary: 'Clear enough.' }));
    assert.equal(failed.category, 'transition_error');
    assert.match(failed.message, /cannot route this analysis result: .*roles\.planner\.on_result\.ready/);
    assert.deepEqual(events, []);
    assert.equal(tracker.comments.get('1'), undefined);
  });

  it('records the reused pass of a cached check in the meta', async () => {
    const { unguarded, current, markers } = setup();
    // A guard stub standing in for a cache hit: the record of the check that ran earlier comes with the decision.
    const record = { target: 'Agent review', role: 'developer', sha: 'abc123', exitCode: 0, timedOut: false, durationMs: 900, ok: true, result: 'passed' as const, finishedAt: new Date('2026-10-18T11:00:00Z') };
    const [cached] = guardTools([unguarded], async () => ({ allow: true, note: 'cached result for abc123', check: record }));
    const result = data((await cached?.execute(APPROVED, { issue: current() })) ?? { ok: false, error: { category: 'missing', message: '' } });
    assert.equal(result.checks, 'passed');
    assert.equal(result.note, RESULT_RECORDED_NOTE, "the tool's note wins over the guard's");
    assert.deepEqual(markers()[0]?.meta.checks, {
      result: 'passed',
      ok: true,
      exit_code: 0,
      timed_out: false,
      duration_ms: 900,
      sha: 'abc123',
      finished_at: '2026-10-18T11:00:00.000Z',
    });
  });

  describe('on_check_failed', () => {
    const FAILING = { 'In review': 'echo "lint failed"; exit 1' };

    it('moves a read-only role to on_check_failed, keeps the verdict and notes the failed check in the summary', async () => {
      const { report, tracker, markers } = setup({ checks: FAILING, reviewer: { on_check_failed: 'In progress' } });
      const result = data(await report(APPROVED));
      assert.equal(result.target, 'In progress');
      assert.equal(result.status, 'In progress');
      assert.equal(result.checks, 'check_failed');
      assert.equal(result.check_failed_for, 'In review');
      assert.deepEqual(tracker.statusCalls, ['In progress']);
      const [marker] = markers();
      assert.equal(marker?.result.verdict, 'approved');
      assert.equal(marker?.meta.target, 'In progress');
      assert.equal(marker?.meta.checks?.ok, false);
      assert.match(marker?.result.summary ?? '', /^Looks good\.\n\n\*\*Entry check failed\.\*\*[^\n]*"In review"[^\n]*"In progress"[^\n]*\n\n {4}lint failed$/);
      assert.deepEqual(data(await report(CHANGES)).already_recorded, true, 'a run still reports once');
    });

    it('keeps the summary within its limit with a long summary and long check output', async () => {
      const { report, markers } = setup({ checks: { 'In review': 'yes "a long line of check output" | head -n 400; exit 1' }, reviewer: { on_check_failed: 'In progress' } });
      data(await report({ ...APPROVED, summary: 'x'.repeat(3_900) }));
      const summary = markers()[0]?.result.summary ?? '';
      assert.ok(summary.length <= 4000, `${summary.length}`);
      assert.match(summary, /Entry check failed/);
    });

    it('leaves the round limit label alone when the redirect replaces the move', async () => {
      const { report, tracker, current } = setup({
        checks: { 'In review': 'exit 1' },
        history: { reviewRounds: 2, testRounds: 0 },
        reviewer: { on_check_failed: 'Blocked' },
      });
      const result = data(await report(CHANGES));
      assert.equal(result.target, 'Blocked', 'the third changes_needed leads to on_round_limit, whose check failed');
      assert.deepEqual(current().labels, []);
      assert.deepEqual(tracker.statusCalls, ['Blocked']);
    });

    it('applies the check of the fallback column too', async () => {
      const { report, tracker } = setup({ checks: { ...FAILING, 'In progress': 'echo "dirty tree"; exit 1' }, reviewer: { on_check_failed: 'In progress' } });
      const failed = error(await report(APPROVED));
      assert.equal(failed.category, 'check_failed');
      assert.match(failed.message, /"In progress"[\s\S]*dirty tree/);
      assert.deepEqual(tracker.statusCalls, []);
      assert.equal(tracker.comments.get('1'), undefined);
    });

    it('does nothing for a failed check when the fallback is the column that failed', async () => {
      const { report, tracker } = setup({ checks: { 'In progress': 'exit 1' }, reviewer: { on_check_failed: 'In progress' } });
      assert.equal(error(await report(CHANGES)).category, 'check_failed');
      assert.deepEqual(tracker.statusCalls, []);
    });

    it('is not used by a role that is not read-only, nor for check_timeout or check_error', async () => {
      const developer = setup({ role: 'developer', checks: { 'Agent review': 'exit 1' }, reviewer: { on_check_failed: 'In progress' } });
      assert.equal(error(await developer.report({ verdict: 'done', summary: 'Done.' })).category, 'check_failed');
      const broken = setup({ checks: { 'In review': 'exit 7' }, reviewer: { on_check_failed: 'In progress' } });
      assert.equal(error(await broken.report(APPROVED)).category, 'check_error');
      assert.deepEqual(broken.tracker.statusCalls, []);
    });

    it('refuses a fallback the tool did not expect', async () => {
      const { unguarded, current, tracker } = setup({ reviewer: { on_check_failed: 'In progress' } });
      const check = { result: 'check_failed', ok: false, exit_code: 1, timed_out: false, duration_ms: 1, sha: null, finished_at: '' };
      const forged = await unguarded.execute(APPROVED, { issue: current(), transition: { target: 'Blocked', check: null, checkFailed: { target: 'In review', output: '', check } } });
      assert.equal(error(forged).category, 'tool_error');
      assert.deepEqual(tracker.statusCalls, []);
    });
  });

  it('refuses a role without result', () => {
    const { params } = setup();
    assert.throws(() => createResultTool({ ...params, role: { ...params.role, result: null } }), /reports no result/);
  });
});
