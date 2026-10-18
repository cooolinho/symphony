import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { securityNeeded } from '../src/orchestrator/security.ts';
import { resolveTransition, type TransitionOutcome } from '../src/orchestrator/transitions.ts';
import { buildStageHistory } from '../src/orchestrator/stage-history.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { DEFAULTS, resolveConfig } from '../src/workflow/config.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { LOOP_VERDICTS } from '../src/workflow/results.ts';
import { changedFiles } from '../src/workspace/changes.ts';
import { tempDir } from './helpers.ts';

// Acceptance tests of #206 (security auditor stage), derived from the issue text: the changed-files lookup against a
// real git repository, the OR-combined triggers, the config defaults, the shipped WORKFLOW.md role, the round limit.

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd, encoding: 'utf8' }).trim();

function write(repo: string, name: string, content = 'x\n'): void {
  const file = path.join(repo, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function repository(): string {
  const repo = tempDir('symphony-sec-accept-');
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'app/Policies/PostPolicy.php', 'class PostPolicy {}\n'.repeat(30));
  write(repo, 'README.md', 'readme\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'checkout', '-q', '-b', 'symphony/issue-206');
  return repo;
}

const resolve = (front: Record<string, unknown>) =>
  resolveConfig(front, { workflowPath: '/srv/WORKFLOW.md', env: {}, trackerDefaults });

const LARAVEL_DEFAULTS = ['app/Policies/**', 'app/Http/Middleware/**', 'config/auth.php', 'routes/**', 'database/migrations/**'];

describe('changedFiles(workspace, base)', () => {
  it('lists committed, staged, unstaged and untracked files of the branch against the base', async () => {
    const repo = repository();
    write(repo, 'docs/a.md');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'docs');
    write(repo, 'README.md', 'changed\n');
    write(repo, 'routes/web.php');
    git(repo, 'add', 'routes/web.php');
    write(repo, 'untracked.txt');
    assert.deepEqual(await changedFiles(repo, 'main'), ['README.md', 'docs/a.md', 'routes/web.php', 'untracked.txt']);
  });

  it('is empty for a branch without changes', async () => {
    assert.deepEqual(await changedFiles(repository(), 'main'), []);
  });

  it('reports a renamed file under both names, so moving a policy out of app/Policies is still seen', async () => {
    const repo = repository();
    fs.mkdirSync(path.join(repo, 'app/Support'), { recursive: true });
    git(repo, 'mv', 'app/Policies/PostPolicy.php', 'app/Support/PostPolicy.php');
    git(repo, 'commit', '-q', '-m', 'move');
    const files = await changedFiles(repo, 'main');
    assert.ok(files.includes('app/Policies/PostPolicy.php'), files.join(','));
    assert.ok(files.includes('app/Support/PostPolicy.php'), files.join(','));
  });

  it('sees an untracked file in a new directory', async () => {
    const repo = repository();
    write(repo, 'database/migrations/2026_01_01_create_x.php');
    assert.deepEqual(await changedFiles(repo, 'main'), ['database/migrations/2026_01_01_create_x.php']);
  });

  it('does not count commits that only the base branch gained', async () => {
    const repo = repository();
    git(repo, 'checkout', '-q', 'main');
    write(repo, 'config/auth.php');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'main moves on');
    git(repo, 'checkout', '-q', 'symphony/issue-206');
    write(repo, 'docs/only.md');
    assert.deepEqual(await changedFiles(repo, 'main'), ['docs/only.md']);
  });

  it('rejects for a directory that is not a git repository', async () => {
    await assert.rejects(changedFiles(tempDir('symphony-nogit-'), 'main'));
  });

  it('rejects for an unknown base ref', async () => {
    await assert.rejects(changedFiles(repository(), 'origin/does-not-exist'));
  });
});

describe('securityNeeded triggers', () => {
  const none = { risk: false, labels: [] as string[], securityPaths: LARAVEL_DEFAULTS };
  const files = (list: string[]) => ({ changedFiles: async () => list });

  it('a policy diff needs the review', async () => {
    const decision = await securityNeeded({ ...none, ...files(['app/Policies/PostPolicy.php', 'README.md']) });
    assert.equal(decision.needed, true);
    assert.match(decision.reason, /PostPolicy\.php/);
  });

  it('every default path alone triggers', async () => {
    for (const file of ['app/Http/Middleware/Auth.php', 'config/auth.php', 'routes/web.php', 'routes/api/v1.php', 'database/migrations/2026_x.php']) {
      assert.equal((await securityNeeded({ ...none, ...files([file]) })).needed, true, file);
    }
  });

  it('a docs-only diff is skipped', async () => {
    const decision = await securityNeeded({ ...none, ...files(['README.md', 'docs/usage.md', 'docs/deep/guide.md']) });
    assert.equal(decision.needed, false);
  });

  it('an empty diff is skipped', async () => {
    assert.equal((await securityNeeded({ ...none, ...files([]) })).needed, false);
  });

  it('the analysis risk alone triggers, with a docs-only diff', async () => {
    assert.equal((await securityNeeded({ ...none, risk: true, ...files(['README.md']) })).needed, true);
  });

  it('a security label alone triggers, case-insensitively', async () => {
    for (const label of ['security', 'Security', ' SECURITY ']) {
      assert.equal((await securityNeeded({ ...none, labels: ['bug', label], ...files(['README.md']) })).needed, true, label);
    }
  });

  it('other labels do not trigger', async () => {
    assert.equal((await securityNeeded({ ...none, labels: ['bug', 'docs'], ...files(['README.md']) })).needed, false);
  });

  it('an empty security_paths list turns the path trigger off', async () => {
    assert.equal((await securityNeeded({ ...none, securityPaths: [], ...files(['app/Policies/PostPolicy.php']) })).needed, false);
  });

  it('an explicit security_paths list is used instead of the defaults', async () => {
    const facts = { ...none, securityPaths: ['src/auth/**'] };
    assert.equal((await securityNeeded({ ...facts, ...files(['app/Policies/PostPolicy.php']) })).needed, false);
    assert.equal((await securityNeeded({ ...facts, ...files(['src/auth/login.ts']) })).needed, true);
  });

  it('fails safe when the changed files cannot be determined, and says why', async () => {
    const decision = await securityNeeded({
      ...none,
      changedFiles: async () => {
        throw new Error('fatal: bad revision origin/gone');
      },
    });
    assert.equal(decision.needed, true);
    assert.match(decision.reason, /bad revision origin\/gone|could not/);
  });

  it('works end to end with the real changedFiles of a git repository', async () => {
    const repo = repository();
    write(repo, 'docs/x.md');
    assert.equal((await securityNeeded({ ...none, changedFiles: () => changedFiles(repo, 'main') })).needed, false);
    write(repo, 'app/Policies/CommentPolicy.php');
    assert.equal((await securityNeeded({ ...none, changedFiles: () => changedFiles(repo, 'main') })).needed, true);
    assert.equal((await securityNeeded({ ...none, changedFiles: () => changedFiles(tempDir('symphony-nogit-'), 'main') })).needed, true);
  });
});

describe('configuration', () => {
  const base = { tracker: { kind: 'github', active_states: ['Ready'], terminal_states: ['Done'] } };

  it('security_paths defaults to the Laravel paths', () => {
    assert.deepEqual(resolve(base).pipeline.securityPaths, LARAVEL_DEFAULTS);
    assert.deepEqual(DEFAULTS.securityPaths, LARAVEL_DEFAULTS);
  });

  it('an explicit list replaces the defaults and [] disables them', () => {
    assert.deepEqual(resolve({ ...base, pipeline: { security_paths: ['x/**'] } }).pipeline.securityPaths, ['x/**']);
    assert.deepEqual(resolve({ ...base, pipeline: { security_paths: [] } }).pipeline.securityPaths, []);
  });

  it('max_security_rounds has a default of at least 1, can be set and rejects 0', () => {
    assert.ok(resolve(base).pipeline.maxSecurityRounds >= 1);
    assert.equal(resolve({ ...base, pipeline: { max_security_rounds: 5 } }).pipeline.maxSecurityRounds, 5);
    assert.throws(() => resolve({ ...base, pipeline: { max_security_rounds: 0 } }));
  });
});

describe('the shipped WORKFLOW.md', () => {
  const load = async () => {
    const { definition } = await loadWorkflowFile(path.resolve(import.meta.dirname, '../WORKFLOW.md'));
    return resolveConfig(definition.config, { workflowPath: path.resolve(import.meta.dirname, '../WORKFLOW.md'), env: {}, trackerDefaults });
  };

  it('defines the security-auditor role as specified', async () => {
    const config = await load();
    const role = config.roles?.find((candidate) => candidate.name === 'security-auditor');
    assert.ok(role, 'role security-auditor');
    assert.deepEqual(role.states.map((state) => state.toLowerCase()), ['security review']);
    assert.equal(role.readOnly, true);
    assert.equal(role.result, 'security');
    assert.equal(role.onResult.passed, 'In review');
    assert.equal(role.onResult.issues_found, 'In progress');
    assert.equal(role.onResult.blocked, 'Blocked');
  });

  it('has Security review in active_states and in the reviewer may_move_to', async () => {
    const config = await load();
    assert.ok(config.tracker.activeStates.includes('Security review'));
    const reviewer = config.roles?.find((candidate) => candidate.result === 'review');
    assert.ok(reviewer);
    assert.ok((reviewer.mayMoveTo ?? []).includes('Security review'), (reviewer.mayMoveTo ?? []).join(','));
    assert.ok((reviewer.mayMoveTo ?? []).includes('In review'));
  });

  it('routes the reviewer approval to Security review when the flag holds and to In review otherwise', async () => {
    const config = await load();
    const reviewer = config.roles?.find((candidate) => candidate.result === 'review');
    assert.ok(reviewer);
    const board = ['Backlog', 'Ready', 'Design', 'In progress', 'Testing', 'Documentation', 'Agent review', 'Security review', 'Blocked', 'In review', 'Done'];
    const approve = (flag: boolean): TransitionOutcome =>
      resolveTransition({
        role: reviewer,
        verdict: 'approved',
        history: { reviewRounds: 0, testRounds: 0, securityRounds: 0 },
        profile: null,
        flags: { 'security-auditor': flag },
        config,
        boardColumns: board,
      });
    const needed = approve(true);
    assert.ok(needed.ok, JSON.stringify(needed));
    assert.equal(needed.target, 'Security review');
    const skipped = approve(false);
    assert.ok(skipped.ok, JSON.stringify(skipped));
    assert.equal(skipped.target, 'In review');
  });

  it('limits security issues_found rounds: Blocked with the limit label at the limit, none before', async () => {
    const config = await load();
    const auditor = config.roles?.find((candidate) => candidate.name === 'security-auditor');
    assert.ok(auditor);
    const max = config.pipeline.maxSecurityRounds;
    const board = ['Backlog', 'Ready', 'Design', 'In progress', 'Testing', 'Documentation', 'Agent review', 'Security review', 'Blocked', 'In review', 'Done'];
    const issues = (done: number): TransitionOutcome =>
      resolveTransition({ role: auditor, verdict: 'issues_found', history: { reviewRounds: 0, testRounds: 0, securityRounds: done }, profile: null, config, boardColumns: board });
    const before = issues(max - 2 < 0 ? 0 : max - 2);
    if (max > 1) {
      assert.ok(before.ok);
      assert.equal(before.target, 'In progress');
      assert.equal(before.limitReached, false);
      assert.deepEqual(before.labels.remove, [config.pipeline.limitLabel]);
    }
    const at = issues(max - 1);
    assert.ok(at.ok, JSON.stringify(at));
    assert.equal(at.limitReached, true);
    assert.equal(at.target, 'Blocked');
    assert.deepEqual(at.labels.add, [config.pipeline.limitLabel]);
    const passed = resolveTransition({ role: auditor, verdict: 'passed', history: { reviewRounds: 0, testRounds: 0, securityRounds: max - 1 }, profile: null, config, boardColumns: board });
    assert.ok(passed.ok);
    assert.equal(passed.target, 'In review');
    assert.equal(passed.limitReached, false);
  });
});

describe('security rounds in the stage history', () => {
  it('security is a loop kind whose loop verdict is issues_found', () => {
    assert.equal(LOOP_VERDICTS.security, 'issues_found');
  });

  it('an empty history has zero security rounds', () => {
    assert.equal(buildStageHistory([]).securityRounds, 0);
  });
});
