import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, mock } from 'node:test';
import { Logger } from '../src/log.ts';
import { acquireLock, describeHolder, releaseLock, UNREADABLE_LOCK_GRACE_MS } from '../src/workspace/lock.ts';
import { WorkspaceManager } from '../src/workspace/manager.ts';
import { baseFront, makeWorkflow, tempDir } from './helpers.ts';

/** Independent tests for issue #563 (empty/unreadable workspace lock files), derived from the issue text. */

const exists = (p: string) => fs.access(p).then(() => true, () => false);
const setAge = (p: string, ms: number) => {
  const t = new Date(Date.now() - ms);
  return fs.utimes(p, t, t);
};
const DEAD_PID = 2 ** 22 + 12345; // beyond the default pid_max, never alive

function enospcAfterCreate() {
  const real = fs.writeFile.bind(fs);
  return mock.method(fs, 'writeFile', async (p: string) => {
    await real(p, ''); // the file exists but stays empty
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  });
}

describe('lock: failed write leaves no file (#563)', () => {
  it('ENOSPC after creation: error is rethrown unchanged and the 0-byte file is gone', async () => {
    const lock = path.join(tempDir('lockind-'), 'a.lock');
    const stub = enospcAfterCreate();
    try {
      await assert.rejects(acquireLock(lock), (e: NodeJS.ErrnoException) => e.code === 'ENOSPC');
    } finally {
      stub.mock.restore();
    }
    assert.equal(await exists(lock), false);
  });

  it('after a failed write the next attempt acquires normally (no stuck state)', async () => {
    const lock = path.join(tempDir('lockind-'), 'a.lock');
    const stub = enospcAfterCreate();
    try {
      await assert.rejects(acquireLock(lock));
    } finally {
      stub.mock.restore();
    }
    const result = await acquireLock(lock);
    assert.equal(result.ok, true);
    if (result.ok) await result.release();
    assert.equal(await exists(lock), false);
  });

  it('a failure that is not EEXIST and where no file was created still rethrows (cleanup errors ignored)', async () => {
    const lock = path.join(tempDir('lockind-'), 'missing-dir', 'a.lock');
    await assert.rejects(acquireLock(lock), { code: 'ENOENT' });
  });

  it('a pre-existing lock of another host is not deleted by the failure path (EEXIST is no failure)', async () => {
    const lock = path.join(tempDir('lockind-'), 'a.lock');
    await fs.writeFile(lock, JSON.stringify({ pid: 1, hostname: 'elsewhere-host', instance: 'other' }));
    const result = await acquireLock(lock);
    assert.equal(result.ok, false);
    assert.equal(await exists(lock), true);
  });
});

describe('lock: unreadable files and the grace period (#563)', () => {
  it('reproduction: a fresh empty lock gives ok:false with holder null and is not deleted', async () => {
    const lock = path.join(tempDir('lockind-'), 'x.lock');
    await fs.writeFile(lock, '');
    const result = await acquireLock(lock);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.holder, null);
    assert.equal(await exists(lock), true);
  });

  it('an empty lock just inside the grace period still blocks', async () => {
    const lock = path.join(tempDir('lockind-'), 'x.lock');
    await fs.writeFile(lock, '');
    await setAge(lock, UNREADABLE_LOCK_GRACE_MS - 15_000);
    assert.equal((await acquireLock(lock)).ok, false);
  });

  it('the grace period is about a minute (not hours, not zero)', () => {
    assert.ok(UNREADABLE_LOCK_GRACE_MS >= 30_000 && UNREADABLE_LOCK_GRACE_MS <= 300_000);
  });

  for (const [name, content] of [
    ['empty', ''],
    ['truncated JSON', '{"pid": 12'],
    ['garbage', 'not json at all'],
    ['JSON of the wrong shape', '{"foo":1}'],
    ['JSON null', 'null'],
  ] as const) {
    it(`an old ${name} lock is reclaimed and the new holder is us`, async () => {
      const lock = path.join(tempDir('lockind-'), 'x.lock');
      await fs.writeFile(lock, content);
      await setAge(lock, UNREADABLE_LOCK_GRACE_MS + 30_000);
      const result = await acquireLock(lock);
      assert.equal(result.ok, true);
      const written = JSON.parse(await fs.readFile(lock, 'utf8'));
      assert.equal(written.pid, process.pid);
      assert.equal(written.hostname, os.hostname());
      if (result.ok) await result.release();
      assert.equal(await exists(lock), false);
    });
  }

  it('a reclaimed lock blocks a second acquirer (it is a real lock again)', async () => {
    const lock = path.join(tempDir('lockind-'), 'x.lock');
    await fs.writeFile(lock, '');
    await setAge(lock, UNREADABLE_LOCK_GRACE_MS + 30_000);
    assert.equal((await acquireLock(lock)).ok, true);
    // another instance holding a live-pid lock on this host must block us
    await fs.writeFile(lock, JSON.stringify({ pid: process.pid, hostname: os.hostname(), instance: 'someone-else' }));
    assert.equal((await acquireLock(lock)).ok, false);
  });
});

describe('lock: real holders still block (#563)', () => {
  it('live pid on this host blocks even when the file is very old', async () => {
    const lock = path.join(tempDir('lockind-'), 'x.lock');
    await fs.writeFile(lock, JSON.stringify({ pid: process.ppid, hostname: os.hostname(), instance: 'other', acquiredAt: 'x' }));
    await setAge(lock, 24 * 3600 * 1000);
    const result = await acquireLock(lock);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.holder?.instance, 'other');
    assert.equal(await exists(lock), true);
  });

  it('another host blocks even when the file is very old, even with a dead-looking pid', async () => {
    const lock = path.join(tempDir('lockind-'), 'x.lock');
    await fs.writeFile(lock, JSON.stringify({ pid: DEAD_PID, hostname: 'elsewhere-host', instance: 'other' }));
    await setAge(lock, 24 * 3600 * 1000);
    assert.equal((await acquireLock(lock)).ok, false);
    assert.equal(await exists(lock), true);
  });

  it('a dead pid on this host is still reclaimed immediately (unchanged behaviour)', async () => {
    const lock = path.join(tempDir('lockind-'), 'x.lock');
    await fs.writeFile(lock, JSON.stringify({ pid: DEAD_PID, hostname: os.hostname(), instance: 'other' }));
    assert.equal((await acquireLock(lock)).ok, true);
  });

  it('releaseLock never removes a foreign or unreadable lock', async () => {
    const dir = tempDir('lockind-');
    const foreign = path.join(dir, 'f.lock');
    const empty = path.join(dir, 'e.lock');
    await fs.writeFile(foreign, JSON.stringify({ pid: 1, hostname: 'elsewhere-host', instance: 'other' }));
    await fs.writeFile(empty, '');
    await releaseLock(foreign);
    await releaseLock(empty);
    assert.equal(await exists(foreign), true);
    assert.equal(await exists(empty), true);
  });
});

describe('lock: message names the file and the grace period (#563)', () => {
  it('describeHolder(null, path) contains the path and the seconds', () => {
    const text = describeHolder(null, '/ws/acme_app_7.lock');
    assert.ok(text.includes('/ws/acme_app_7.lock'));
    assert.match(text, /60/);
    assert.match(text, /reclaim/i);
  });

  it('describeHolder for a real holder is unchanged in substance', () => {
    const text = describeHolder({ pid: 42, hostname: 'h', instance: 'i', acquiredAt: 't' }, '/ws/x.lock');
    assert.match(text, /pid 42 on h/);
  });

  it('acquireLock reports the lock path on a blocked result so callers can name it', async () => {
    const lock = path.join(tempDir('lockind-'), 'x.lock');
    await fs.writeFile(lock, '');
    const result = await acquireLock(lock);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(describeHolder(result.holder, result.lockPath).includes(lock));
  });
});

describe('workspace manager: run is retried after the lock is reclaimed (#563)', () => {
  async function makeManager() {
    const root = tempDir('lockind-ws-');
    const config = makeWorkflow(baseFront(root)).config;
    const manager = new WorkspaceManager({ root, hooks: config.hooks, workflowDir: root }, { PATH: process.env.PATH }, Logger.silent());
    const target = await manager.pathFor('acme/app#258');
    return { manager, lockPath: `${target.path}.lock` };
  }

  it('fresh 0-byte lock blocks the issue; once old, the next attempt locks normally', async () => {
    const { manager, lockPath } = await makeManager();
    await fs.writeFile(lockPath, '');

    const blocked = await manager.lock('acme/app#258');
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.lockPath, lockPath);

    await setAge(lockPath, UNREADABLE_LOCK_GRACE_MS + 10_000);
    const retried = await manager.lock('acme/app#258');
    assert.equal(retried.ok, true);
    if (retried.ok) await retried.release();
    assert.equal(await exists(lockPath), false);

    const again = await manager.lock('acme/app#258');
    assert.equal(again.ok, true);
    if (again.ok) await again.release();
  });

  it('three issues with leftover empty locks are all reclaimed independently', async () => {
    const { manager } = await makeManager();
    for (const id of ['acme/app#258', 'acme/app#268', 'acme/app#269']) {
      const target = await manager.pathFor(id);
      await fs.writeFile(`${target.path}.lock`, '');
      await setAge(`${target.path}.lock`, UNREADABLE_LOCK_GRACE_MS + 10_000);
    }
    for (const id of ['acme/app#258', 'acme/app#268', 'acme/app#269']) {
      const result = await manager.lock(id);
      assert.equal(result.ok, true, id);
      if (result.ok) await result.release();
    }
  });
});
