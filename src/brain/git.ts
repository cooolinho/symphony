import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../log.ts';
import { hashOf } from './common.ts';
import { errorMessage } from '../util/errors.ts';
import { git, names } from '../workspace/git.ts';
import type { BrainVersioning, BrainWriteEntry } from './write.ts';

/** Called after every vault commit (agent and human); for the indexer (E7-6a) and the changes (E6-2). */
export type VaultCommitHook = (sha: string, paths: string[]) => void | Promise<void>;

export interface VaultGitOptions {
  onCommit?: VaultCommitHook;
}

export interface VaultGit extends BrainVersioning {
  /** Commits changes made outside Symphony (Obsidian) as one `human` commit; the sha, or null when there is nothing to take over. */
  commitHumanChanges(): Promise<string | null>;
  /** Commits `path` as the system author `symphony` with `subject`; null when the file has no change. The caller holds `serial`. */
  commitAs(path: string, subject: string): Promise<string | null>;
  /** Commits `paths` (added, changed or removed) as `human`; null when nothing changed. The caller holds `serial`. */
  commitHuman(paths: string[], subject: string, body: string | null): Promise<string | null>;
  /** Reverts commit `sha` as `human` (`git revert --no-edit`); aborts and throws on a conflict. The caller holds `serial`. */
  revert(sha: string, paths: string[]): Promise<string>;
}

const EXCLUDE_OBSIDIAN = ':(exclude).obsidian';
const MAX_SUBJECT_PURPOSE = 200;

/** One queue per vault, shared by every session of the process. */
const queues = new Map<string, Promise<unknown>>();

function serialFor<T>(vault: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(vault);
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  queues.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

/** `git -c …` options that set author and committer without touching any git config. */
function authorArgs(name: string, email: string): string[] {
  return ['-c', `user.name=${name}`, '-c', `user.email=${email}`, '-c', 'commit.gpgsign=false'];
}

export function agentAuthor(role: string | null): { name: string; email: string } {
  const slug = (role ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const name = `symphony-${slug === '' ? 'agent' : slug}`;
  return { name, email: `${name}@local` };
}

export function commitMessage(entry: BrainWriteEntry): { subject: string; body: string } {
  const purpose = (entry.purpose ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_SUBJECT_PURPOSE);
  return { subject: `${entry.issue} ${entry.run ?? '-'}: ${purpose === '' ? '(kein Zweck)' : purpose}`, body: entry.path };
}

async function headSha(vault: string): Promise<string> {
  return (await git(vault, ['rev-parse', 'HEAD'])).trim();
}

async function commit(vault: string, author: { name: string; email: string }, subject: string, body: string | null, pathspec: string[]): Promise<string> {
  const args = [...authorArgs(author.name, author.email), 'commit', '-q', '--no-verify', '-m', subject];
  if (body !== null) args.push('-m', body);
  await git(vault, [...args, '--', ...pathspec]);
  return headSha(vault);
}

async function resetQuietly(vault: string, pathspec: string[]): Promise<void> {
  try {
    await git(vault, ['reset', '-q', '--', ...pathspec]);
  } catch {
    // best effort: the original error is the one that matters
  }
}

/** Creates the repository with a first commit of the vault structure; false when `.git` exists already. */
export async function initVaultGit(root: string): Promise<boolean> {
  try {
    await fs.stat(path.join(root, '.git'));
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await serialFor(root, async () => {
    await git(root, ['init', '-q', '-b', 'main']);
    await git(root, ['add', '-A', '--', '.', EXCLUDE_OBSIDIAN]);
    await git(root, [...authorArgs('symphony', 'symphony@local'), 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'Vault angelegt']);
  });
  return true;
}

/** The last commit of the vault repository; null without its own `.git`, without a commit or on an error. */
export async function lastVaultCommit(vault: string): Promise<{ sha: string; at: string; author: string } | null> {
  try {
    await fs.stat(path.join(vault, '.git'));
    const [sha, at, author] = (await git(vault, ['log', '-1', '--format=%H%x00%aI%x00%an'])).trim().split('\0');
    return sha && at && author ? { sha, at, author } : null;
  } catch {
    return null;
  }
}

/** The number of commits of the vault repository (`git rev-list --count HEAD`); null without its own `.git` or on an error. */
export async function vaultCommitCount(vault: string): Promise<number | null> {
  try {
    await fs.stat(path.join(vault, '.git'));
    const count = Number.parseInt((await git(vault, ['rev-list', '--count', 'HEAD'])).trim(), 10);
    return Number.isNaN(count) ? null : count;
  } catch {
    return null;
  }
}

/**
 * The newest commit touching `file` whose subject starts with one of `prefixes` and whose body is `file` (the path a
 * promotion wrote to); null when there is none or on an error. `prefix` is the one that matched.
 */
export async function lastCommitWithSubject(vault: string, file: string, prefixes: string[]): Promise<{ sha: string; subject: string; prefix: string } | null> {
  try {
    for (const record of (await git(vault, ['log', '--format=%H%x00%s%x00%b%x1e', '--', file])).split('\x1e')) {
      const [sha, subject, body] = record.trim().split('\0');
      const prefix = prefixes.find((candidate) => subject?.startsWith(candidate));
      if (sha && subject && prefix !== undefined && body?.trim() === file) return { sha, subject, prefix };
    }
    return null;
  } catch {
    return null;
  }
}

/** The note `file` as committed last before `atIso`; null when it did not exist then or on an error. */
export async function noteBefore(vault: string, file: string, atIso: string): Promise<{ content: string; hash: string } | null> {
  try {
    const sha = (await git(vault, ['rev-list', '-1', `--before=${atIso}`, 'HEAD', '--', file])).trim();
    if (sha === '') return null;
    const content = await git(vault, ['show', `${sha}:${file}`]);
    return { content, hash: hashOf(Buffer.from(content)) };
  } catch {
    return null;
  }
}

export function createVaultGit(vaultPath: string, logger: Logger, options: VaultGitOptions = {}): VaultGit {
  const notify = async (sha: string, paths: string[]): Promise<void> => {
    try {
      await options.onCommit?.(sha, paths);
    } catch (error) {
      logger.warn('brain onCommit hook failed', { sha, error: errorMessage(error) });
    }
  };

  // Callers hold the queue already (`serial`); this must not enter it again.
  const humanCommit = async (): Promise<string | null> => {
    const status = await git(vaultPath, ['status', '--porcelain', '-z', '--untracked-files=all', '--', '.', EXCLUDE_OBSIDIAN]);
    if (status.trim() === '') return null;
    try {
      await git(vaultPath, ['add', '-A', '--', '.', EXCLUDE_OBSIDIAN]);
      const paths = names(await git(vaultPath, ['diff', '--cached', '--name-only', '--no-renames', '-z']));
      if (paths.length === 0) return null;
      const sha = await commit(vaultPath, { name: 'human', email: 'human@local' }, `Obsidian: ${paths.length} Dateien`, null, ['.', EXCLUDE_OBSIDIAN]);
      await notify(sha, paths);
      return sha;
    } catch (error) {
      await resetQuietly(vaultPath, ['.']);
      throw error;
    }
  };

  const agentCommit = async (entry: BrainWriteEntry): Promise<string> => {
    try {
      await git(vaultPath, ['add', '--', entry.path]);
      const staged = names(await git(vaultPath, ['diff', '--cached', '--name-only', '-z', '--', entry.path]));
      if (staged.length === 0) return await headSha(vaultPath);
      const message = commitMessage(entry);
      const author = agentAuthor(entry.role);
      const sha = await commit(vaultPath, author, message.subject, message.body, [entry.path]);
      await notify(sha, [entry.path]);
      return sha;
    } catch (error) {
      await resetQuietly(vaultPath, [entry.path]);
      throw error;
    }
  };

  const systemCommit = async (file: string, subject: string): Promise<string | null> => {
    try {
      await git(vaultPath, ['add', '--', file]);
      const staged = names(await git(vaultPath, ['diff', '--cached', '--name-only', '-z', '--', file]));
      if (staged.length === 0) return null;
      const sha = await commit(vaultPath, { name: 'symphony', email: 'symphony@local' }, subject, file, [file]);
      await notify(sha, [file]);
      return sha;
    } catch (error) {
      await resetQuietly(vaultPath, [file]);
      throw error;
    }
  };

  const pathsCommit = async (paths: string[], subject: string, body: string | null): Promise<string | null> => {
    try {
      await git(vaultPath, ['add', '-A', '--', ...paths]);
      const staged = names(await git(vaultPath, ['diff', '--cached', '--name-only', '--no-renames', '-z', '--', ...paths]));
      if (staged.length === 0) return null;
      const sha = await commit(vaultPath, { name: 'human', email: 'human@local' }, subject, body, paths);
      await notify(sha, paths);
      return sha;
    } catch (error) {
      await resetQuietly(vaultPath, paths);
      throw error;
    }
  };

  const revert = async (sha: string, paths: string[]): Promise<string> => {
    try {
      await git(vaultPath, [...authorArgs('human', 'human@local'), 'revert', '--no-edit', sha]);
    } catch (error) {
      try {
        await git(vaultPath, ['revert', '--abort']);
      } catch {
        // best effort: the original error is the one that matters
      }
      throw error;
    }
    const head = await headSha(vaultPath);
    await notify(head, paths);
    return head;
  };

  return {
    serial: (fn) => serialFor(vaultPath, fn),
    beforeWrite: async () => {
      await humanCommit();
    },
    commitWrite: (entry) => agentCommit(entry),
    commitAs: systemCommit,
    commitHumanChanges: () => serialFor(vaultPath, humanCommit),
    commitHuman: pathsCommit,
    revert,
  };
}
