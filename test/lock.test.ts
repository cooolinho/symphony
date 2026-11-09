import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, mock } from 'node:test';
import { acquireLock, describeHolder, INSTANCE_ID, UNREADABLE_LOCK_GRACE_MS } from '../src/workspace/lock.ts';
import { tempDir } from './helpers.ts';

const exists = (p: string) => fs.access(p).then(() => true, () => false);
const age = (p: string, ms: number) => fs.utimes(p, new Date(Date.now() - ms), new Date(Date.now() - ms));

describe('workspace lock', () => {
  it('a fresh empty lock file still blocks', async () => {
    const lock = path.join(tempDir('lock-'), 'x.lock');
    await fs.writeFile(lock, '');
    assert.deepEqual(await acquireLock(lock), { ok: false, holder: null, lockPath: lock });
  });

  it('an empty lock file older than the grace period is reclaimed', async () => {
    const lock = path.join(tempDir('lock-'), 'x.lock');
    await fs.writeFile(lock, '');
    await age(lock, UNREADABLE_LOCK_GRACE_MS + 5000);
    const result = await acquireLock(lock);
    assert.equal(result.ok, true);
    assert.equal(JSON.parse(await fs.readFile(lock, 'utf8')).instance, INSTANCE_ID);
  });

  it('an old unreadable (invalid JSON) lock file is reclaimed', async () => {
    const lock = path.join(tempDir('lock-'), 'x.lock');
    await fs.writeFile(lock, '{"pid":');
    await age(lock, UNREADABLE_LOCK_GRACE_MS + 5000);
    assert.equal((await acquireLock(lock)).ok, true);
  });

  it('a lock of a live process on this host blocks regardless of age', async () => {
    const lock = path.join(tempDir('lock-'), 'x.lock');
    await fs.writeFile(lock, JSON.stringify({ pid: process.ppid, hostname: os.hostname(), instance: 'other' }));
    await age(lock, UNREADABLE_LOCK_GRACE_MS * 10);
    const result = await acquireLock(lock);
    assert.equal(result.ok, false);
  });

  it('a lock of another host blocks regardless of age', async () => {
    const lock = path.join(tempDir('lock-'), 'x.lock');
    await fs.writeFile(lock, JSON.stringify({ pid: 1, hostname: 'elsewhere-host', instance: 'other' }));
    await age(lock, UNREADABLE_LOCK_GRACE_MS * 10);
    assert.equal((await acquireLock(lock)).ok, false);
  });

  it('a failed write (ENOSPC) leaves no lock file and rethrows', async () => {
    const lock = path.join(tempDir('lock-'), 'x.lock');
    const real = fs.writeFile.bind(fs);
    const stub = mock.method(fs, 'writeFile', async (p: string, ...rest: unknown[]) => {
      await real(p, '');
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    });
    try {
      await assert.rejects(acquireLock(lock), { code: 'ENOSPC' });
    } finally {
      stub.mock.restore();
    }
    assert.equal(await exists(lock), false);
  });

  it('describeHolder names the file and the grace period for an unreadable lock', () => {
    const text = describeHolder(null, '/w/x.lock');
    assert.match(text, /\/w\/x\.lock/);
    assert.match(text, /60 s/);
  });
});
