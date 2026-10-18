import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Logger } from '../src/log.ts';
import { createGuard, guardTools, toolsForRole } from '../src/orchestrator/guard.ts';
import { RESULT_RECORDED_NOTE, RESULT_TOOL, classificationLabels, createResultTool, type ResultToolParams } from '../src/orchestrator/result-tool.ts';
import { buildStageHistory } from '../src/orchestrator/stage-history.ts';
import { changedFiles } from '../src/workspace/changes.ts';
import type { Issue, StatusChange, ToolResult } from '../src/tracker/types.ts';
import { decodeMarker, parseResult, toolInputShape } from '../src/workflow/results.ts';
import { WorkspaceManager } from '../src/workspace/manager.ts';
import { FakeTracker, baseFront, makeIssue, makeWorkflow, tempDir } from './helpers.ts';

const ROLES = {
  developer: { states: ['Todo', 'In progress'], result: 'implementation', may_move_to: ['Documentation', 'Agent review', 'Blocked'], on_result: { done: 'Agent review' } },
  docs: { states: ['Documentation'], result: 'docs', may_move_to: ['Agent review', 'Blocked'], on_result: { done: 'Agent review', not_needed: 'Agent review' } },
  reviewer: {
    states: ['Agent review'],
    read_only: true,
    result: 'review',
    may_move_to: ['Security review', 'In review', 'In progress', 'Blocked'],
    on_result: { approved: 'In review', changes_needed: 'In progress' },
    on_round_limit: 'In review',
  },
  auditor: {
    states: ['Security review'],
    read_only: true,
    result: 'security',
    may_move_to: ['In review', 'In progress', 'Blocked'],
    on_result: { passed: 'In review', issues_found: 'In progress' },
    on_check_failed: 'In progress',
  },
  planner: { states: ['Todo'], commands: ['plan'], result: 'analysis', may_move_to: ['In progress', 'Blocked'], on_result: { ready: 'next' } },
  analyst: { states: ['Ready'], read_only: true, result: 'analysis', may_move_to: ['In progress', 'Blocked'], on_result: { ready: 'In progress', needs_info: 'Blocked' } },
  tester: {
    states: ['Testing'],
    result: 'test',
    may_move_to: ['Documentation', 'Agent review', 'In progress', 'Blocked'],
    on_result: { passed: 'Agent review', failed: 'In progress' },
  },
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
  /** Column the issue is in; default `Agent review`. */
  state?: string;
  pathRule?: ResultToolParams['pathRule'];
  security?: ResultToolParams['security'];
  docs?: ResultToolParams['docs'];
}

function setup(options: SetupOptions = {}) {
  const root = tempDir('symphony-result-');
  const front = baseFront(root, {
    tracker: {
      kind: 'github_project',
      provider: { owner: 'acme', project_number: 1, token: 'test-token' },
      active_states: ['Todo', 'Ready', 'In progress', 'Testing', 'Documentation', 'Agent review', 'Security review'],
    },
    roles: { ...ROLES, reviewer: { ...ROLES.reviewer, ...options.reviewer } },
    pipeline: { max_review_rounds: 3, max_test_rounds: 2 },
    checks: { timeout_ms: options.timeoutMs ?? 10_000, on_enter: options.checks ?? {} },
  });
  const config = makeWorkflow(front).config;
  const workspacePath = path.join(root, 'ws');
  fs.mkdirSync(workspacePath);
  const manager = new WorkspaceManager({ root, hooks: config.hooks, workflowDir: root }, { PATH: process.env.PATH }, Logger.silent());
  const role = config.roles?.find((r) => r.name === (options.role ?? 'reviewer'));
  assert.ok(role);
  const tracker = new FakeTracker([makeIssue({ id: '1', state: options.state ?? 'Agent review', labels: options.labels ?? [] })]);
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
    ...(options.pathRule !== undefined ? { pathRule: options.pathRule } : {}),
    ...(options.security !== undefined ? { security: options.security } : {}),
    ...(options.docs !== undefined ? { docs: options.docs } : {}),
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

describe('report_result: the documentation stage after the developer finished', () => {
  const facts = (files: string[] | Error, over: Partial<NonNullable<ResultToolParams['docs']>> = {}) => {
    const calls: number[] = [];
    return {
      calls,
      docs: {
        docsNeeded: false,
        docsPaths: ['docs/**', 'README*.md'],
        triggerPaths: ['.env.example', 'config/**'],
        changedFiles: async () => {
          calls.push(1);
          if (files instanceof Error) throw files;
          return files;
        },
        ...over,
      },
    };
  };
  const DONE = { verdict: 'done', summary: 'Implemented.' };

  it('a changed .env.example without a docs change sends the hand-off to Documentation', async () => {
    const { docs } = facts(['.env.example', 'src/a.ts']);
    const { report, tracker, markers } = setup({ role: 'developer', state: 'In progress', docs });
    const result = data(await report(DONE));
    assert.deepEqual([result.target, tracker.statusCalls], ['Documentation', ['Documentation']]);
    assert.match(String(result.reason), /documentation needed: 1 changed file\(s\) match pipeline\.docs_trigger_paths/);
    assert.equal(markers()[0]?.meta.target, 'Documentation');
  });

  it('goes to Agent review without a trigger, or when the docs changed already', async () => {
    for (const files of [['src/a.ts'], ['.env.example', 'docs/usage.md']]) {
      const { docs } = facts(files);
      const { report, tracker } = setup({ role: 'developer', state: 'In progress', docs });
      const result = data(await report(DONE));
      assert.deepEqual([result.target, tracker.statusCalls], ['Agent review', ['Agent review']], files.join());
      assert.match(String(result.reason), /documentation not needed/);
    }
  });

  it('docs_needed of the analysis sends it to Documentation without asking git; a passed test does the same', async () => {
    const { docs, calls } = facts(['src/a.ts'], { docsNeeded: true });
    assert.equal(data(await setup({ role: 'developer', state: 'In progress', docs }).report(DONE)).target, 'Documentation');
    assert.equal(calls.length, 0);
    const tested = setup({ role: 'tester', state: 'Testing', docs: facts(['config/app.php']).docs });
    assert.equal(data(await tested.report({ verdict: 'passed', summary: 'Tested.', cases: [{ criterion: 'c', test: 't', status: 'passed' }] })).target, 'Documentation');
  });

  it('fails safe when git cannot list the files', async () => {
    const { docs } = facts(new Error('no base'));
    const result = data(await setup({ role: 'developer', state: 'In progress', docs }).report(DONE));
    assert.equal(result.target, 'Documentation');
    assert.match(String(result.reason), /could not be determined \(no base\), documenting to be safe/);
  });

  it('keeps the configured target without facts, and for other verdicts', async () => {
    assert.equal(data(await setup({ role: 'developer', state: 'In progress' }).report(DONE)).target, 'Agent review');
    const { docs, calls } = facts(['.env.example']);
    const blocked = setup({ role: 'developer', state: 'In progress', docs });
    assert.equal(data(await blocked.report({ verdict: 'blocked', summary: 'Stuck.', blockers: [{ description: 'x', needs: 'human' }] })).target, 'Blocked');
    assert.equal(calls.length, 0);
  });

  it('the docs result leads to Agent review', async () => {
    const { report, tracker } = setup({ role: 'docs', state: 'Documentation' });
    assert.equal(data(await report({ verdict: 'done', summary: 'Documented.', files: ['docs/usage.md'] })).target, 'Agent review');
    assert.deepEqual(tracker.statusCalls, ['Agent review']);
  });

  it('refuses a docs result with changes outside pipeline.docs_paths, naming the files', async () => {
    const pathRule = {
      allowed: ['docs/**', 'README*.md'],
      setting: 'pipeline.docs_paths',
      guidance: 'Code belongs to the developer.',
      changedFiles: async () => ({ base: 'abc123def4567890', files: ['docs/usage.md', 'src/a.ts'] }),
    };
    const { report, tracker } = setup({ role: 'docs', state: 'Documentation', pathRule });
    const refused = error(await report({ verdict: 'done', summary: 'Documented.', files: ['docs/usage.md'] }));
    assert.equal(refused.category, 'invalid_result');
    assert.match(refused.message, /may only change files matching `pipeline\.docs_paths` \(docs\/\*\*, README\*\.md\)/);
    assert.match(refused.message, /- src\/a\.ts/);
    assert.doesNotMatch(refused.message, /- docs\/usage\.md/);
    assert.match(refused.message, /Code belongs to the developer\./);
    assert.deepEqual(tracker.statusCalls, []);
  });
});

describe('report_result: the security review after the reviewer approved', () => {
  const facts = (files: string[] | Error, over: Partial<NonNullable<ResultToolParams['security']>> = {}) => {
    const calls: number[] = [];
    return {
      calls,
      security: {
        risk: false,
        securityPaths: ['app/Policies/**', 'routes/**', 'database/migrations/**'],
        changedFiles: async () => {
          calls.push(1);
          if (files instanceof Error) throw files;
          return files;
        },
        ...over,
      },
    };
  };

  it('sends an approval for a diff that touches a policy to Security review: no entry check of In review, the marker names the column', async () => {
    const { security } = facts(['README.md', 'app/Policies/PostPolicy.php']);
    const { report, tracker, markers } = setup({ security, checks: { 'In review': 'echo "must not run"; exit 1' } });
    const result = data(await report(APPROVED));
    assert.deepEqual([result.target, result.status, result.checks], ['Security review', 'Security review', null]);
    assert.match(String(result.reason), /→ "Security review" \(on_result\.approved, security review needed: 1 changed file\(s\) match pipeline\.security_paths: app\/Policies\/PostPolicy\.php\)/);
    assert.deepEqual(tracker.statusCalls, ['Security review']);
    assert.equal(markers()[0]?.meta.target, 'Security review');
  });

  it('sends an approval for a docs-only diff straight to In review and says why', async () => {
    const { security } = facts(['README.md', 'docs/usage.md']);
    const { report, tracker } = setup({ security });
    const result = data(await report(APPROVED));
    assert.equal(result.target, 'In review');
    assert.match(String(result.reason), /security review not needed: no trigger \(none of 2 changed file\(s\) matches pipeline\.security_paths\)/);
    assert.deepEqual(tracker.statusCalls, ['In review']);
  });

  it('runs the entry check of the column the approval leads to: In review when no audit is needed', async () => {
    const { security } = facts(['README.md']);
    const { report, tracker } = setup({ security, checks: { 'In review': 'echo "2 tests failed"; exit 1' } });
    const failed = error(await report(APPROVED));
    assert.equal(failed.category, 'check_failed');
    assert.deepEqual(tracker.statusCalls, []);
  });

  it('is triggered by the security label alone, without asking git', async () => {
    const { security, calls } = facts(['README.md']);
    const { report } = setup({ security, labels: ['feature', 'Security'] });
    const result = data(await report(APPROVED));
    assert.deepEqual([result.target, calls.length], ['Security review', 0]);
    assert.match(String(result.reason), /the issue carries the "security" label/);
  });

  it('is triggered by a security risk in the analysis alone', async () => {
    const { security } = facts(['README.md']);
    const { report } = setup({ security: { ...security, risk: true } });
    const result = data(await report(APPROVED));
    assert.equal(result.target, 'Security review');
    assert.match(String(result.reason), /the analysis flags a security risk/);
  });

  it('does not treat area:security as the security label', async () => {
    const { security } = facts(['README.md']);
    const { report } = setup({ security, labels: ['area:security'] });
    assert.equal(data(await report(APPROVED)).target, 'In review');
  });

  it('turns the path trigger off with an empty security_paths', async () => {
    const { security, calls } = facts(['app/Policies/PostPolicy.php'], { securityPaths: [] });
    const { report } = setup({ security });
    assert.deepEqual([data(await report(APPROVED)).target, calls.length], ['In review', 0]);
  });

  it('fails safe: when the changed files cannot be determined the issue goes to Security review, and the reason says why', async () => {
    const { security } = facts(new Error('git could not list the files changed against origin/develop: unknown revision'));
    const { report } = setup({ security });
    const result = data(await report(APPROVED));
    assert.equal(result.target, 'Security review');
    assert.match(String(result.reason), /changed files could not be determined \(git could not list the files changed against origin\/develop: unknown revision\), reviewing to be safe/);
  });

  it('keeps the approval on In review where nothing looks the conditions up', async () => {
    const { report } = setup({});
    assert.equal(data(await report(APPROVED)).target, 'In review');
  });

  it('looks the files up only for an approval', async () => {
    const { security, calls } = facts(['app/Policies/PostPolicy.php']);
    const { report } = setup({ security });
    assert.equal(data(await report(CHANGES)).target, 'In progress');
    assert.equal(calls.length, 0);
  });

  it('measures a real branch against its base: a policy goes to Security review, a docs change does not', async () => {
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd, encoding: 'utf8' });
    for (const [file, target] of [['app/Policies/PostPolicy.php', 'Security review'], ['docs/guide.md', 'In review']] as const) {
      const setupResult = setup({});
      const { workspacePath, params, report } = setupResult;
      git(workspacePath, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(workspacePath, 'README.md'), 'x');
      git(workspacePath, 'add', '-A');
      git(workspacePath, 'commit', '-q', '-m', 'init');
      git(workspacePath, 'checkout', '-q', '-b', 'symphony/issue-1');
      fs.mkdirSync(path.dirname(path.join(workspacePath, file)), { recursive: true });
      fs.writeFileSync(path.join(workspacePath, file), 'y');
      git(workspacePath, 'add', '-A');
      git(workspacePath, 'commit', '-q', '-m', 'change');
      params.security = { risk: false, securityPaths: ['app/Policies/**'], changedFiles: () => changedFiles(workspacePath, 'main') };
      assert.equal(data(await report(APPROVED)).target, target, file);
    }
  });

  it('routes the security auditor: passed to In review, issues_found to the developer, the last round to Blocked with needs-human', async () => {
    const passed = setup({ role: 'auditor', state: 'Security review' });
    assert.equal(data(await passed.report({ verdict: 'passed', summary: 'No findings.' })).target, 'In review');
    const found = { verdict: 'issues_found', summary: 'IDOR.', findings: [{ severity: 'major', file: 'app/Http/PostController.php', line: 9, problem: 'No scope', fix: 'Scope to the user' }] };
    const first = setup({ role: 'auditor', state: 'Security review', history: { reviewRounds: 0, testRounds: 0, securityRounds: 0 } });
    const round = data(await first.report(found));
    assert.deepEqual([round.target, round.round], ['In progress', 1]);
    assert.equal(first.markers()[0]?.meta.round, 1);
    const last = setup({ role: 'auditor', state: 'Security review', history: { reviewRounds: 0, testRounds: 0, securityRounds: 1 } });
    const limit = data(await last.report(found));
    assert.deepEqual([limit.target, limit.round, limit.labels], ['Blocked', 2, { added: ['needs-human'], removed: [] }]);
  });

  it('sends an entry check failure of In review back to the developer for the auditor, like for the reviewer', async () => {
    const { report, tracker, markers } = setup({ role: 'auditor', state: 'Security review', checks: { 'In review': 'echo "lint failed"; exit 1' } });
    const result = data(await report({ verdict: 'passed', summary: 'Clean.' }));
    assert.deepEqual([result.target, result.check_failed_for], ['In progress', 'In review']);
    assert.deepEqual(tracker.statusCalls, ['In progress']);
    assert.equal(markers()[0]?.result.verdict, 'passed');
  });
});

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
    const { report, tracker, markers, params } = setup({ checks: { 'In review': 'exit 0' } });
    let attempts = 0;
    tracker.setStatus = async () => {
      attempts++;
      throw new Error('GitHub is down');
    };
    const failed = error(await report(APPROVED));
    assert.equal(failed.category, 'status_failed');
    assert.match(failed.message, /The review result was recorded \(https:\/\/github\.com\/acme\/app\/issues\/1#issuecomment-1\)/);
    assert.match(failed.message, /moving the issue to "In review" failed: GitHub is down/);
    assert.match(failed.message, /Do not report again: end your turn now\. The issue stays in "Agent review" for now; Symphony completes the move later without running this stage again\./);
    assert.equal(markers().length, 1);
    assert.equal(markers()[0]?.meta.target, 'In review', 'the marker keeps the move that did not happen');

    assert.deepEqual(error(await report(APPROVED)), failed);
    assert.equal(markers().length, 1);
    assert.equal(attempts, 1);
    assert.equal(params.onMoved, undefined);
  });

  it('reports the move to onMoved, and a failed move only to onRecorded; the labels stay without the move', async () => {
    const calls: string[] = [];
    const moved = setup();
    const tool = createResultTool({ ...moved.params, onRecorded: () => calls.push('recorded'), onMoved: () => calls.push('moved') });
    data(await tool.execute(APPROVED, { issue: moved.current(), transition: { target: 'In review', check: null } }));
    assert.deepEqual(calls, ['recorded', 'moved']);

    calls.length = 0;
    const failing = setup({ history: { reviewRounds: 2, testRounds: 0 } });
    failing.tracker.setStatus = async () => {
      throw new Error('GitHub is down');
    };
    const limited = createResultTool({ ...failing.params, onRecorded: () => calls.push('recorded'), onMoved: () => calls.push('moved') });
    const failed = error(await limited.execute(CHANGES, { issue: failing.current(), transition: { target: 'In review', check: null } }));
    assert.equal(failed.category, 'status_failed');
    assert.deepEqual(calls, ['recorded']);
    assert.deepEqual(failing.current().labels, [], 'no limit label on an issue the round limit did not move');
  });

  it('records nothing for an issue that left the role\'s columns during the session', async () => {
    const { report, tracker, events } = setup({ checks: { 'In review': 'exit 0' } });
    tracker.set('1', { state: 'In progress' });
    const moved = error(await report(APPROVED));
    assert.equal(moved.category, 'issue_moved');
    assert.match(moved.message, /The issue was moved to "In progress" while you worked[\s\S]*not recorded[\s\S]*Do not report again: end your turn now/);
    assert.deepEqual(events, ['checks_started', 'checks_finished'], 'the column is confirmed after the check, right before writing');
    assert.equal(tracker.comments.get('1'), undefined);
    assert.deepEqual(tracker.statusCalls, []);

    const removed = setup();
    const issue = removed.current();
    removed.tracker.issues.delete('1');
    const tool = createResultTool({ ...removed.params, issue: () => issue });
    const gone = error(await tool.execute(APPROVED, { issue, transition: { target: 'In review', check: null } }));
    assert.equal(gone.category, 'issue_moved');
    assert.match(gone.message, /is no longer visible on the tracker/);
  });

  it('records nothing when the column cannot be confirmed, so the agent can report again', async () => {
    const { report, tracker } = setup();
    tracker.failNext = new Error('GitHub is down');
    const failed = error(await report(APPROVED));
    assert.equal(failed.category, 'tracker_error');
    assert.match(failed.message, /could not read the issue's column[\s\S]*GitHub is down[\s\S]*Call report_result again/);
    assert.equal(tracker.comments.get('1'), undefined);
    assert.deepEqual(tracker.statusCalls, []);
    assert.equal(data(await report(APPROVED)).target, 'In review');
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

  describe('path rule (test engineer)', () => {
    const PASSED = { verdict: 'passed', summary: 'Every criterion has a passing test.', cases: [{ criterion: 'Totals add up', test: 'tests/TotalTest.php', status: 'passed' }] };
    const FAILED = { verdict: 'failed', summary: 'The total ignores discounts.', cases: [{ criterion: 'Totals add up', test: 'tests/TotalTest.php', status: 'failed' }] };
    const ALLOWED = ['tests/**', '**/*Test.php'];

    /** A rule whose changed files can be edited between calls; `calls` counts the lookups. */
    function rule(initial: string[]) {
      const state = { files: initial, base: '0123456789abcdef0123', calls: 0, failure: null as Error | null };
      const pathRule = {
        allowed: ALLOWED,
        changedFiles: async () => {
          state.calls++;
          if (state.failure !== null) throw state.failure;
          return { base: state.base, files: state.files };
        },
      };
      return { state, pathRule };
    }

    it('refuses a result with changes to src/ with invalid_result, naming the files, before any entry check', async () => {
      const { state, pathRule } = rule(['src/Total.php', 'tests/TotalTest.php', 'app/Models/Invoice.php']);
      const { report, tracker, events } = setup({ role: 'tester', state: 'Testing', pathRule, checks: { 'Agent review': 'echo checked >> "$SYMPHONY_WORKFLOW_DIR/checks.log"' } });
      const refused = error(await report(PASSED));
      assert.equal(refused.category, 'invalid_result');
      assert.match(refused.message, /The test result is invalid: role tester may only change files matching `pipeline\.test_paths` \(tests\/\*\*, \*\*\/\*Test\.php\)/);
      assert.match(refused.message, /but 2 file\(s\) that differ from commit 0123456789ab \(the developer's last hand-off, else where your session started\) are outside them/);
      assert.match(refused.message, /- src\/Total\.php\n- app\/Models\/Invoice\.php/);
      assert.doesNotMatch(refused.message, /tests\/TotalTest\.php\n/, 'files inside the paths are not listed');
      assert.match(refused.message, /Nothing was recorded\. Undo the changes you made yourself[\s\S]*git checkout 0123456789ab -- <file>/);
      assert.match(refused.message, /Leave a file alone that you did not change[\s\S]*describe it in an issue comment and end your turn/);
      assert.deepEqual(events, [], 'the entry check of Agent review did not run');
      assert.deepEqual(tracker.statusCalls, []);
      assert.equal(tracker.comments.get('1'), undefined);

      state.files = ['tests/TotalTest.php'];
      assert.equal(data(await report(PASSED)).target, 'Agent review');
      assert.deepEqual(tracker.statusCalls, ['Agent review']);
    });

    it('applies to every verdict: failed and blocked results may not leave production changes behind either', async () => {
      const { pathRule } = rule(['src/Total.php']);
      const { report, tracker } = setup({ role: 'tester', state: 'Testing', pathRule });
      assert.equal(error(await report(FAILED)).category, 'invalid_result');
      assert.equal(error(await report({ verdict: 'blocked', summary: 'No database.', blockers: [{ description: 'No test database', needs: 'infra' }] })).category, 'invalid_result');
      assert.deepEqual(tracker.statusCalls, []);
    });

    it('lets a result through that only touches the allowed paths', async () => {
      const { pathRule } = rule(['tests/Feature/TotalTest.php', 'app/Domain/OrderTest.php']);
      const { report, tracker, markers } = setup({ role: 'tester', state: 'Testing', pathRule });
      const result = data(await report(FAILED));
      assert.equal(result.target, 'In progress');
      assert.equal(result.round, 1);
      assert.deepEqual(tracker.statusCalls, ['In progress']);
      assert.equal(markers()[0]?.result.verdict, 'failed');
    });

    it('checks the input first: an invalid result is reported as before, without looking at the files', async () => {
      const { state, pathRule } = rule(['src/Total.php']);
      const { report } = setup({ role: 'tester', state: 'Testing', pathRule });
      const refused = error(await report({ verdict: 'failed', summary: 'No failed case.' }));
      assert.match(refused.message, /verdict "failed" needs at least one case/);
      assert.equal(state.calls, 0);
    });

    it('lists the first files and counts the rest', async () => {
      const { pathRule } = rule(Array.from({ length: 30 }, (_, i) => `src/file-${String(i).padStart(2, '0')}.php`));
      const { report } = setup({ role: 'tester', state: 'Testing', pathRule });
      const message = error(await report(PASSED)).message;
      assert.match(message, /30 file\(s\)/);
      assert.match(message, /- src\/file-24\.php\n- … and 5 more\n/);
      assert.doesNotMatch(message, /file-25/);
    });

    it('fails closed when git cannot tell, with a message that is not about the change; a later call may succeed', async () => {
      const { state, pathRule } = rule(['tests/TotalTest.php']);
      const { report, tracker } = setup({ role: 'tester', state: 'Testing', pathRule });
      state.failure = new Error('git could not list the files changed since 0123456789ab');
      const unknown = error(await report(PASSED));
      assert.equal(unknown.category, 'tool_error');
      assert.match(unknown.message, /could not check which files you changed \(git could not list[^)]*\), so nothing was recorded[\s\S]*not a problem with your change/);
      assert.deepEqual(tracker.statusCalls, []);
      state.failure = null;
      assert.equal(data(await report(PASSED)).target, 'Agent review');
    });

    it('does not look again once the result is recorded', async () => {
      const { state, pathRule } = rule(['tests/TotalTest.php']);
      const { report } = setup({ role: 'tester', state: 'Testing', pathRule });
      data(await report(PASSED));
      const looked = state.calls;
      state.files = ['src/Total.php'];
      assert.equal(data(await report(FAILED)).already_recorded, true);
      assert.equal(state.calls, looked);
    });

    it('is not applied to a role without a rule', async () => {
      const { report } = setup();
      assert.equal(data(await report(APPROVED)).target, 'In review');
    });

    it('routes the verdicts of the test kind: failed to the developer, the second failed round to Blocked with needs-human', async () => {
      const first = setup({ role: 'tester', state: 'Testing' });
      assert.equal(data(await first.report(FAILED)).target, 'In progress');
      const second = setup({ role: 'tester', state: 'Testing', history: { reviewRounds: 0, testRounds: 1 } });
      const limit = data(await second.report(FAILED));
      assert.equal(limit.target, 'Blocked');
      assert.equal(limit.round, 2);
      assert.deepEqual(second.current().labels, ['needs-human']);
    });
  });

  it('refuses a role without result', () => {
    const { params } = setup();
    assert.throws(() => createResultTool({ ...params, role: { ...params.role, result: null } }), /reports no result/);
  });
});

describe('classificationLabels', () => {
  const analysis = (input: Record<string, unknown>) => {
    const parsed = parseResult('analysis', { verdict: 'ready', summary: 'Analysed.', ...input });
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
    return parsed.result;
  };

  it('adds Type: and Complexity: for an issue without either', () => {
    assert.deepEqual(classificationLabels(analysis({ type: 'bugfix', complexity: 'S' }), ['area:agent']), ['Type: bugfix', 'Complexity: S']);
  });

  it('maps the aliases of the type and ignores case and whitespace', () => {
    for (const [reported, label] of [['bug', 'bugfix'], ['Enhancement', 'feature'], [' Feature ', 'feature'], ['refactoring', 'refactor']] as const) {
      assert.deepEqual(classificationLabels(analysis({ type: reported }), []), [`Type: ${label}`], reported);
    }
  });

  it('adds nothing for a type the labels do not know, or for fields the analysis did not report', () => {
    assert.deepEqual(classificationLabels(analysis({ type: 'docs' }), []), []);
    assert.deepEqual(classificationLabels(analysis({}), []), []);
  });

  it('never overwrites a human label: Type:, Complexity:, or an alias such as bug and feature', () => {
    assert.deepEqual(classificationLabels(analysis({ type: 'feature', complexity: 'L' }), ['Type: bugfix']), ['Complexity: L']);
    assert.deepEqual(classificationLabels(analysis({ type: 'feature', complexity: 'L' }), ['Complexity: S']), ['Type: feature']);
    assert.deepEqual(classificationLabels(analysis({ type: 'refactor', complexity: 'L' }), ['bug', 'Complexity: S']), []);
    assert.deepEqual(classificationLabels(analysis({ type: 'bugfix' }), ['feature']), []);
  });

  it('leaves an issue alone whose own Type: or Complexity: labels are unusable (unknown value, conflict)', () => {
    assert.deepEqual(classificationLabels(analysis({ type: 'feature', complexity: 'M' }), ['Type: banana', 'Complexity: S', 'Complexity: L']), []);
  });

  it('only applies to an analysis', () => {
    const parsed = parseResult('review', APPROVED);
    assert.ok(parsed.ok);
    assert.deepEqual(classificationLabels(parsed.result, []), []);
  });
});

describe('report_result of an analysis', () => {
  const analysisTool = (labels: string[] = []) => setup({ role: 'analyst', state: 'Ready', labels });

  it('sets the missing Type: and Complexity: labels before the status change, and reports them', async () => {
    const { report, tracker, current } = analysisTool();
    const order: string[] = [];
    const setStatus = tracker.setStatus.bind(tracker);
    tracker.setStatus = async (issue, column) => {
      order.push(`status:${current().labels.join(',')}`);
      return setStatus(issue, column);
    };
    const result = data(await report({ verdict: 'ready', summary: 'Clear.', type: 'bugfix', complexity: 'M' }));
    assert.deepEqual(order, ['status:type: bugfix,complexity: m']);
    assert.equal(result.target, 'In progress');
    assert.deepEqual(result.labels, { added: ['Type: bugfix', 'Complexity: M'], removed: [] });
  });

  it('leaves labels a human set alone', async () => {
    const { report, current } = analysisTool(['Type: refactor', 'Complexity: XL']);
    const result = data(await report({ verdict: 'ready', summary: 'Clear.', type: 'bugfix', complexity: 'S' }));
    assert.equal(result.labels, undefined);
    assert.deepEqual(current().labels, ['Type: refactor', 'Complexity: XL']);
  });

  it('records the result when a label cannot be added: a warning, the move stands', async () => {
    const { report, tracker } = analysisTool();
    tracker.addLabels = async () => {
      throw new Error('label API down');
    };
    const result = data(await report({ verdict: 'ready', summary: 'Clear.', type: 'bugfix', complexity: 'M' }));
    assert.equal(result.target, 'In progress');
    assert.match(String((result.warnings as string[])[0]), /could not add label\(s\) Type: bugfix, Complexity: M: label API down/);
  });

  it('adds nothing for a repeated call', async () => {
    const { report, current } = analysisTool();
    await report({ verdict: 'ready', summary: 'Clear.', type: 'bugfix' });
    assert.equal(data(await report({ verdict: 'ready', summary: 'Clear.', type: 'bugfix', complexity: 'XL' })).already_recorded, true);
    assert.deepEqual(current().labels, ['type: bugfix']);
  });
});

describe('report_result of a refactor review', () => {
  const GOALS = ['The parsing code exists once', 'No public signature changes'];
  const analysed = (goals: string[], run = 'run-0') => {
    const parsed = parseResult('analysis', { verdict: 'ready', summary: 'Analysed.', type: 'refactor', refactoring_goals: goals });
    assert.ok(parsed.ok);
    return {
      result: parsed.result,
      meta: { role: 'analyst', run, round: null, profile: null, workflow_hash: null, head_sha: null, checks: null, target: 'In progress', created_at: '2026-10-18T10:00:00.000Z' },
    };
  };
  const reviewTool = (labels: string[], goals: string[] | null = GOALS) =>
    setup({ labels, history: { ...buildStageHistory(goals === null ? [] : [analysed(goals)]) } });

  it('refuses an approval that does not confirm every goal, names the missing ones and records nothing', async () => {
    const { report, tracker, unguarded } = reviewTool(['Type: refactor']);
    const failure = error(await report({ ...APPROVED, confirmed_goals: [GOALS[0]] }));
    assert.equal(failure.category, 'invalid_result');
    assert.match(failure.message, /needs every refactoring goal in `confirmed_goals`/);
    assert.ok(failure.message.includes(`"${GOALS[1]}"`) && !failure.message.includes(`"${GOALS[0]}"`), failure.message);
    assert.deepEqual(tracker.statusCalls, []);
    assert.equal(tracker.comments.get('1'), undefined);
    assert.equal(await unguarded.transitionTarget?.({ ...APPROVED }), null, 'no move is planned for the refused result');
    assert.equal(error(await report(APPROVED)).category, 'invalid_result');
  });

  it('records an approval that confirms every goal and keeps the goals in the stored result', async () => {
    const { report, tracker, markers } = reviewTool(['type: refactor']);
    const result = data(await report({ ...APPROVED, confirmed_goals: GOALS.map((goal) => ` ${goal.toUpperCase()} `) }));
    assert.equal(result.target, 'In review');
    assert.deepEqual(tracker.statusCalls, ['In review']);
    const [marker] = markers();
    assert.ok(marker?.result.kind === 'review');
    assert.deepEqual(marker.result.confirmed_goals, GOALS.map((goal) => goal.toUpperCase()));
    assert.match(tracker.comments.get('1')?.[0]?.body ?? '', /\*\*Confirmed goals\*\*/);
  });

  it('does not touch changes_needed reviews', async () => {
    const { report } = reviewTool(['Type: refactor']);
    assert.equal(data(await report(CHANGES)).target, 'In progress');
  });

  it('does not apply to other issue types, to untyped issues or to refactors without goals', async () => {
    for (const [labels, goals] of [[['Type: feature'], GOALS], [['bug'], GOALS], [[], GOALS], [['Type: refactor'], []], [['Type: refactor'], null]] as const) {
      const { report } = reviewTool([...labels], goals === null ? null : [...goals]);
      assert.equal(data(await report(APPROVED)).target, 'In review', `${labels.join() || 'untyped'} / ${goals === null ? 'no analysis' : goals.length}`);
    }
  });

  it('uses the goals of the newest analysis', async () => {
    const older = analysed(['An old goal'], 'run-0');
    const newer = { ...analysed(GOALS, 'run-1'), meta: { ...analysed(GOALS).meta, run: 'run-1', created_at: '2026-10-18T11:00:00.000Z' } };
    const { report } = setup({ labels: ['Type: refactor'], history: { ...buildStageHistory([newer, older]) } });
    assert.match(error(await report(APPROVED)).message, /The parsing code exists once/);
  });

  it('works without results in the history (older callers)', async () => {
    const { report } = setup({ labels: ['Type: refactor'] });
    assert.equal(data(await report(APPROVED)).target, 'In review');
  });
});
