import fs from 'node:fs/promises';
import type { BrainAccessLog, BrainClash, BrainClashVersions } from './access-log.ts';
import { hashOf } from './common.ts';
import { noteBefore } from './git.ts';
import { resolveVaultWritePath } from './paths.ts';

/** A clash with the versions for the comparison: the note when the write was rejected, the rejected content, the note now. */
export type BrainClashView = BrainClash & BrainClashVersions & { current: { content: string; hash: string } | null };

async function currentNote(vault: string, relative: string): Promise<{ content: string; hash: string } | null> {
  const target = resolveVaultWritePath(vault, relative);
  if (!target.ok) return null;
  try {
    const buffer = await fs.readFile(target.absolute);
    return { content: buffer.toString('utf8'), hash: hashOf(buffer) };
  } catch {
    return null;
  }
}

/**
 * The clashes for GET /api/v1/brain/clashes, newest first. `base` and `attempted` come from the stored versions; a clash
 * without them (logged before they were kept) takes `base` from git (last commit of the note before the rejection).
 */
export async function listClashes(access: BrainAccessLog, vault: string, status: BrainClash['status'] | null): Promise<BrainClashView[]> {
  const clashes = access
    .clashes()
    .filter((clash) => status === null || clash.status === status)
    .sort((a, b) => (a.at[1] < b.at[1] ? 1 : a.at[1] > b.at[1] ? -1 : 0));
  return Promise.all(
    clashes.map(async (clash) => {
      const versions = access.clashVersions(clash.id);
      const base = versions.base ?? (await noteBefore(vault, clash.path, clash.at[1]));
      return { ...clash, base, attempted: versions.attempted, current: await currentNote(vault, clash.path) };
    }),
  );
}
