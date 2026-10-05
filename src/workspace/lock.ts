import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';

export interface LockInfo {
  pid: number;
  hostname: string;
  instance: string;
  acquiredAt: string;
}

export type LockResult = { ok: true; release: () => Promise<void> } | { ok: false; holder: LockInfo | null };

/** Identifies this process; a lock is ours only while the file still carries this id. */
export const INSTANCE_ID = randomUUID();

export function describeHolder(holder: LockInfo | null): string {
  if (holder === null) return 'an unreadable lock file';
  return `pid ${holder.pid} on ${holder.hostname} (instance ${holder.instance}, since ${holder.acquiredAt})`;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readLock(lockPath: string): Promise<LockInfo | null | 'missing'> {
  let text: string;
  try {
    text = await fs.readFile(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return null;
  }
  try {
    const value = JSON.parse(text) as Partial<LockInfo>;
    if (typeof value.pid === 'number' && typeof value.hostname === 'string' && typeof value.instance === 'string') {
      return { pid: value.pid, hostname: value.hostname, instance: value.instance, acquiredAt: String(value.acquiredAt ?? '') };
    }
  } catch {
    // fall through: unreadable content
  }
  return null;
}

/** Same host and a dead pid. Another host, or an unreadable file, counts as held. */
function isStale(holder: LockInfo | null): boolean {
  return holder !== null && holder.hostname === os.hostname() && holder.instance !== INSTANCE_ID && !isAlive(holder.pid);
}

/** Removes the lock file only if this instance's id is still the one inside. */
export async function releaseLock(lockPath: string): Promise<void> {
  const current = await readLock(lockPath);
  if (current === 'missing' || current === null || current.instance !== INSTANCE_ID) return;
  await fs.rm(lockPath, { force: true });
}

/** Atomically creates `lockPath` (flag wx), reclaiming it from a dead process on this host. */
export async function acquireLock(lockPath: string): Promise<LockResult> {
  const info: LockInfo = { pid: process.pid, hostname: os.hostname(), instance: INSTANCE_ID, acquiredAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // writeFile with wx creates and writes in one handle, closed before we report success.
      await fs.writeFile(lockPath, JSON.stringify(info), { flag: 'wx' });
      return { ok: true, release: () => releaseLock(lockPath) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = await readLock(lockPath);
    if (holder === 'missing') continue;
    // Our own instance (e.g. a leftover from an earlier attempt) is not a conflict either.
    if (holder !== null && holder.instance === INSTANCE_ID) {
      await fs.writeFile(lockPath, JSON.stringify(info));
      return { ok: true, release: () => releaseLock(lockPath) };
    }
    if (!isStale(holder)) return { ok: false, holder };
    await fs.rm(lockPath, { force: true });
  }
  return { ok: false, holder: null };
}
