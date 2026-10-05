import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { childEnvironment } from '../src/agent/env.ts';
import { Logger } from '../src/log.ts';
import { SymphonyError } from '../src/util/errors.ts';
import type { HooksConfig } from '../src/workflow/config.ts';
import { runProcess } from '../src/workspace/hooks.ts';
import { WorkspaceManager, describeFailure, workspaceKey } from '../src/workspace/manager.ts';
import { tempDir } from './helpers.ts';

function hooks(overrides: Partial<HooksConfig> = {}): HooksConfig {
  return { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 5_000, ...overrides };
}

function manager(root: string, hookConfig: HooksConfig = hooks(), env: NodeJS.ProcessEnv = process.env): WorkspaceManager {
  return new WorkspaceManager({ root, hooks: hookConfig, workflowDir: root }, env, Logger.silent());
}

const issue = { id: 'PVTI_1', identifier: 'acme/app#1' };

describe('workspace keys', () => {
  it('keeps identifiers that are already safe', () => {
    assert.equal(workspaceKey('ABC-123'), 'ABC-123');
    assert.equal(workspaceKey('v1.2_rc'), 'v1.2_rc');
  });

  it('sanitizes other characters and appends a 64-bit hash of the original', () => {
    const key = workspaceKey('acme/app#1');
    assert.match(key, /^acme_app_1-[0-9a-f]{16}$/);
    assert.equal(workspaceKey('acme/app#1'), key);
  });

  it('gives distinct keys to identifiers that sanitize to the same text', () => {
    assert.notEqual(workspaceKey('a/b'), workspaceKey('a#b'));
    assert.notEqual(workspaceKey('a/b'), workspaceKey('a_b'));
  });

  it('never yields . or .. and caps very long identifiers', () => {
    assert.match(workspaceKey('.'), /^\.-[0-9a-f]{16}$/);
    assert.match(workspaceKey('..'), /^\.\.-[0-9a-f]{16}$/);
    assert.ok(workspaceKey('x'.repeat(400)).length <= 217);
  });
});

describe('workspace manager', () => {
  it('creates the workspace, runs after_create only once, and reuses it', async () => {
    const root = tempDir();
    const workspaces = manager(root, hooks({ afterCreate: 'echo created >> marker.txt' }));
    const first = await workspaces.ensure(issue);
    assert.equal(first.createdNow, true);
    assert.equal(path.dirname(first.path), fs.realpathSync(root));
    const second = await workspaces.ensure(issue);
    assert.equal(second.createdNow, false);
    assert.equal(second.path, first.path);
    assert.equal(fs.readFileSync(path.join(first.path, 'marker.txt'), 'utf8'), 'created\n');
  });

  it('removes a half-created workspace when after_create fails', async () => {
    const root = tempDir();
    const workspaces = manager(root, hooks({ afterCreate: 'echo boom >&2; exit 3' }));
    await assert.rejects(workspaces.ensure(issue), (error: unknown) => {
      return error instanceof SymphonyError && error.code === 'hook_failed' && error.message.includes('code 3');
    });
    assert.equal(fs.existsSync(path.join(root, workspaceKey(issue.identifier))), false);
  });

  it('refuses a non-directory at the workspace path', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, workspaceKey(issue.identifier)), 'not a dir');
    await assert.rejects(manager(root).ensure(issue), { code: 'workspace_path_conflict' });
  });

  it('runs hooks in the workspace with SYMPHONY_* and adapter variables', async () => {
    const root = tempDir();
    const workspaces = manager(root, hooks({ beforeRun: 'printf "%s|%s|%s|%s" "$PWD" "$SYMPHONY_ISSUE_IDENTIFIER" "$SYMPHONY_ISSUE_REPOSITORY" "$SYMPHONY_HOOK" > env.txt' }));
    const workspace = await workspaces.ensure(issue);
    const result = await workspaces.runHook('before_run', workspace, { ...issue, env: { SYMPHONY_ISSUE_REPOSITORY: 'acme/app' } });
    assert.equal(result?.ok, true);
    assert.equal(fs.readFileSync(path.join(workspace.path, 'env.txt'), 'utf8'), `${workspace.path}|acme/app#1|acme/app|before_run`);
  });

  it('times out hooks and kills them', async () => {
    const root = tempDir();
    const workspaces = manager(root, hooks({ beforeRun: 'sleep 30', timeoutMs: 200 }));
    const workspace = await workspaces.ensure(issue);
    const started = Date.now();
    const result = await workspaces.runHook('before_run', workspace, issue);
    assert.equal(result?.ok, false);
    assert.equal(result?.timedOut, true);
    assert.ok(Date.now() - started < 5_000);
  });

  it('kills a process group when its abort signal fires', async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 100);
    const result = await runProcess('bash', ['-c', 'sleep 30 & wait'], { cwd: tempDir(), env: process.env, timeoutMs: 30_000, signal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, false);
    assert.equal(result.error, 'aborted');
    assert.equal(describeFailure(result), 'was aborted');
    assert.ok(Date.now() - started < 5_000);
  });

  it('runs a command directly with its arguments', async () => {
    const result = await runProcess('printf', ['%s|%s', 'a b', '$HOME'], { cwd: tempDir(), env: process.env, timeoutMs: 5_000 });
    assert.equal(result.ok, true);
    assert.equal(result.output, 'a b|$HOME');
  });

  it('ignores before_remove failures and still removes the workspace', async () => {
    const root = tempDir();
    const workspaces = manager(root, hooks({ beforeRemove: 'exit 1' }));
    const workspace = await workspaces.ensure(issue);
    assert.equal(await workspaces.remove(issue), true);
    assert.equal(fs.existsSync(workspace.path), false);
    assert.equal(await workspaces.remove(issue), false);
  });

  it('strips tracker secrets and Claude nesting markers from child environments', () => {
    const env = childEnvironment({ GITHUB_TOKEN: 's', GH_TOKEN: 's', MY_TOKEN: 's', CLAUDECODE: '1', PATH: '/bin' }, ['GITHUB_TOKEN', 'GH_TOKEN', 'MY_TOKEN']);
    assert.deepEqual(env, { PATH: '/bin' });
  });
});

describe('workspace lock', () => {
  const write = (file: string, info: object) => fs.writeFileSync(file, JSON.stringify(info));

  it('acquires atomically, blocks a second acquire and releases only its own lock', async () => {
    const root = tempDir();
    const m = manager(root);
    const first = await m.lock(issue.identifier);
    assert.ok(first.ok);
    const file = path.join(fs.realpathSync(root), `${workspaceKey(issue.identifier)}.lock`);
    const content = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(content.pid, process.pid);
    assert.equal(typeof content.instance, 'string');
    assert.equal(typeof content.hostname, 'string');
    await first.release();
    assert.ok(!fs.existsSync(file));

    write(file, { pid: process.pid, hostname: 'other-host', instance: 'foreign', acquiredAt: 'x' });
    const second = await m.lock(issue.identifier);
    assert.ok(!second.ok);
    assert.equal(second.holder?.instance, 'foreign');
    assert.ok(fs.existsSync(file));
  });

  it('treats a live pid on this host as held and a dead pid as stale', async () => {
    const root = tempDir();
    const m = manager(root);
    const file = path.join(fs.realpathSync(root), `${workspaceKey(issue.identifier)}.lock`);
    const os = await import('node:os');
    write(file, { pid: process.ppid, hostname: os.hostname(), instance: 'foreign', acquiredAt: 'x' });
    assert.ok(!(await m.lock(issue.identifier)).ok);
    write(file, { pid: 2 ** 22 + 12345, hostname: os.hostname(), instance: 'foreign', acquiredAt: 'x' });
    const reclaimed = await m.lock(issue.identifier);
    assert.ok(reclaimed.ok);
    await reclaimed.release();
  });

  it('is deleted together with the workspace and stays out of git status', async () => {
    const root = tempDir();
    const m = manager(root);
    const lock = await m.lock(issue.identifier);
    const ws = await m.ensure(issue);
    assert.deepEqual(fs.readdirSync(ws.path), []);
    assert.ok(fs.existsSync(`${ws.path}.lock`));
    assert.ok(lock.ok);
    await m.remove(issue);
    assert.ok(!fs.existsSync(`${ws.path}.lock`));
  });
});
