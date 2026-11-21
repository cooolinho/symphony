import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { createGuard, INTEGRATE_BASE_CHECK, type CheckRecord, type GuardDecision } from '../src/orchestrator/guard.ts';
import { conflictOutput, integrateBase, type IntegrateResult } from '../src/orchestrator/integrate-base.ts';
import { Logger } from '../src/log.ts';
import { WorkspaceManager } from '../src/workspace/manager.ts';
import { baseFront, makeWorkflow, tempDir } from './helpers.ts';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** A bare `origin` with `develop`, a clone on `symphony/issue-1`, and a second clone that lands commits on develop. */
function repos() {
  const root = tempDir('symphony-integrate-');
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const work = path.join(root, 'work');
  fs.mkdirSync(seed);
  git(root, 'init', '-q', '--bare', '-b', 'develop', origin);
  git(seed, 'init', '-q', '-b', 'develop');
  fs.writeFileSync(path.join(seed, 'CHANGELOG.md'), '# Changelog\n\n- one\n');
  fs.writeFileSync(path.join(seed, 'app.txt'), 'app\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'one');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'develop');
  git(root, 'clone', '-q', '-b', 'develop', origin, work);
  git(work, 'switch', '-q', '-c', 'symphony/issue-1');
  const land = (file: string, content: string) => {
    git(seed, 'pull', '-q', '--ff-only', 'origin', 'develop');
    fs.writeFileSync(path.join(seed, file), content);
    git(seed, 'commit', '-qam', `change ${file}`);
    git(seed, 'push', '-q', 'origin', 'develop');
  };
  const commit = (file: string, content: string) => {
    fs.writeFileSync(path.join(work, file), content);
    git(work, 'add', '.');
    git(work, 'commit', '-qm', `work ${file}`);
    git(work, 'push', '-q', 'origin', 'symphony/issue-1');
  };
  return { origin, work, land, commit };
}

describe('integrateBase', () => {
  it('does nothing when the branch already contains origin/<base>', async () => {
    const { work, commit } = repos();
    commit('feature.txt', 'f\n');
    const result = await integrateBase(work, { base: 'develop', env: ENV });
    assert.deepEqual(result, { kind: 'up_to_date', base: 'develop' });
  });

  it('merges a moved base cleanly and pushes the merge commit', async () => {
    const { origin, work, land, commit } = repos();
    commit('feature.txt', 'f\n');
    land('app.txt', 'app v2\n');
    const result = await integrateBase(work, { base: 'develop', env: ENV });
    assert.equal(result.kind, 'merged');
    const sha = (result as Extract<IntegrateResult, { kind: 'merged' }>).sha;
    assert.equal(git(origin, 'rev-parse', 'refs/heads/symphony/issue-1'), sha);
    assert.equal(fs.readFileSync(path.join(work, 'app.txt'), 'utf8'), 'app v2\n');
    assert.equal(git(work, 'status', '--porcelain'), '');
  });

  it('reports the conflicting files and leaves the workspace as it was', async () => {
    const { origin, work, land, commit } = repos();
    commit('CHANGELOG.md', '# Changelog\n\n- one\n- mine\n');
    const before = git(work, 'rev-parse', 'HEAD');
    land('CHANGELOG.md', '# Changelog\n\n- one\n- theirs\n');
    const result = await integrateBase(work, { base: 'develop', env: ENV });
    assert.deepEqual(result, { kind: 'conflict', base: 'develop', files: ['CHANGELOG.md'] });
    assert.equal(git(work, 'rev-parse', 'HEAD'), before);
    assert.equal(git(work, 'status', '--porcelain'), '');
    assert.equal(git(origin, 'rev-parse', 'refs/heads/symphony/issue-1'), before);
    assert.match(conflictOutput(result as Extract<IntegrateResult, { kind: 'conflict' }>), /- CHANGELOG\.md/);
  });

  it('refuses a workspace with uncommitted changes to tracked files', async () => {
    const { work, land } = repos();
    land('app.txt', 'app v2\n');
    fs.writeFileSync(path.join(work, 'app.txt'), 'dirty\n');
    const result = await integrateBase(work, { base: 'develop', env: ENV });
    assert.equal(result.kind, 'error');
  });

  it('treats a workspace on the base branch itself as up to date', async () => {
    const { work } = repos();
    git(work, 'switch', '-q', 'develop');
    assert.deepEqual(await integrateBase(work, { base: 'develop', env: ENV }), { kind: 'up_to_date', base: 'develop' });
  });

  it('reports an error instead of throwing when the fetch fails', async () => {
    const { origin, work, land } = repos();
    land('app.txt', 'app v2\n');
    fs.renameSync(origin, `${origin}.gone`);
    const result = await integrateBase(work, { base: 'develop', env: ENV });
    assert.equal(result.kind, 'error');
  });
});

describe('guard: checks.integrate_base', () => {
  function guardWith(result: IntegrateResult, integrateColumns: string[] = ['Agent review']) {
    const root = tempDir('symphony-integrate-guard-');
    const front = baseFront(root, {
      tracker: { kind: 'github_project', provider: { owner: 'acme', project_number: 1, token: 'test-token' }, active_states: ['In progress', 'Agent review'] },
      roles: {
        developer: { states: ['In progress'], may_move_to: ['Agent review', 'Blocked'] },
        reviewer: { states: ['Agent review'], may_move_to: ['In progress'] },
      },
      checks: { timeout_ms: 10_000, on_enter: { 'Agent review': 'echo ran-the-check; exit 0' }, integrate_base: integrateColumns },
    });
    const config = makeWorkflow(front).config;
    const workspacePath = path.join(root, 'ws');
    fs.mkdirSync(workspacePath);
    const manager = new WorkspaceManager({ root, hooks: config.hooks, workflowDir: root }, { PATH: process.env.PATH }, Logger.silent());
    const events: Array<[string, Record<string, unknown>]> = [];
    const finished: CheckRecord[] = [];
    let calls = 0;
    const guard = createGuard({
      role: config.roles?.find((r) => r.name === 'developer') ?? null,
      config,
      workspace: { path: workspacePath, key: 'ws', createdNow: false },
      issue: () => ({ id: '1', identifier: 'acme/app#1' }),
      manager,
      signal: new AbortController().signal,
      pendingDelayMs: 0,
      onEvent: (event, _message, detail) => events.push([event, detail]),
      onCheckFinished: (record) => finished.push(record),
      integrateBase: async () => {
        calls++;
        return result;
      },
    });
    return { guard, events, finished, calls: () => calls, config };
  }

  const denied = (decision: GuardDecision) => (decision.allow ? null : decision);

  it('parses the columns and rejects one without entry checks', () => {
    const { config } = guardWith({ kind: 'up_to_date', base: 'develop' });
    assert.deepEqual([...(config.checks.integrateBase ?? [])], ['agent review']);
    const root = tempDir('symphony-integrate-config-');
    assert.throws(
      () => makeWorkflow(baseFront(root, { checks: { on_enter: { 'Agent review': 'exit 0' }, integrate_base: ['In review'] } })),
      /checks\.integrate_base: "in review" has no checks/,
    );
  });

  it('sends a conflict back as a failed check before the column checks run', async () => {
    const { guard, events, finished } = guardWith({ kind: 'conflict', base: 'develop', files: ['CHANGELOG.md', 'app/Models/Announcement.php'] });
    const decision = denied(await guard('Agent review'));
    assert.equal(decision?.category, 'check_failed');
    assert.equal(decision?.failed?.check.name, INTEGRATE_BASE_CHECK);
    assert.match(decision?.message ?? '', /CHANGELOG\.md/);
    assert.match(decision?.message ?? '', /app\/Models\/Announcement\.php/);
    assert.equal(finished.at(-1)?.result, 'check_failed');
    assert.ok(!events.some(([event]) => event === 'checks_started'), 'the column checks must not run after a conflict');
  });

  it('runs the column checks after a clean merge and logs it', async () => {
    const { guard, events } = guardWith({ kind: 'merged', base: 'develop', sha: 'abc123' });
    assert.ok((await guard('Agent review')).allow);
    assert.ok(events.some(([event, detail]) => event === 'base_integrated' && detail.sha === 'abc123'));
    assert.ok(events.some(([event]) => event === 'checks_started'));
  });

  it('runs the column checks when git fails, and logs why the merge was skipped', async () => {
    const { guard, events } = guardWith({ kind: 'error', base: 'develop', message: 'git fetch origin develop failed: offline' });
    assert.ok((await guard('Agent review')).allow);
    assert.ok(events.some(([event, detail]) => event === 'base_integration_skipped' && String(detail.reason).includes('offline')));
  });

  it('leaves columns outside checks.integrate_base alone', async () => {
    const { guard, calls } = guardWith({ kind: 'conflict', base: 'develop', files: ['a'] }, []);
    assert.ok((await guard('Agent review')).allow);
    assert.equal(calls(), 0);
  });
});
