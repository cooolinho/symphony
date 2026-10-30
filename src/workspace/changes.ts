import { SymphonyError, errorMessage } from '../util/errors.ts';
import { git, names } from './git.ts';

async function mergeBaseOf(workspace: string, base: string): Promise<string> {
  const mergeBase = (await git(workspace, ['merge-base', 'HEAD', base])).trim();
  if (mergeBase === '') throw new Error(`HEAD and ${base} have no common ancestor`);
  return mergeBase;
}

/**
 * The repository-relative paths the branch changes against `base` (a ref such as `origin/develop`): what was committed
 * since the branch left `base` (the merge base of HEAD and `base`, so commits that only `base` gained do not count),
 * changed in the working tree or index, and untracked (ignored files stay out), sorted. Renames count as the deletion of
 * the old and the addition of the new path, so moving a file out of a protected directory is still seen. Bounded by a
 * timeout per git call. Throws `paths_unverifiable` when git cannot tell (not a repository, unknown `base`, timeout).
 */
export async function changedFiles(workspace: string, base: string): Promise<string[]> {
  try {
    const mergeBase = await mergeBaseOf(workspace, base);
    const [tracked, untracked] = await Promise.all([
      git(workspace, ['diff', '-z', '--no-renames', '--name-only', mergeBase, '--']),
      git(workspace, ['ls-files', '-z', '--full-name', '--others', '--exclude-standard']),
    ]);
    return [...new Set([...names(tracked), ...names(untracked)])].sort();
  } catch (error) {
    throw new SymphonyError('paths_unverifiable', `git could not list the files changed against ${base}: ${errorMessage(error)}`, { cause: error });
  }
}

/** One file of the branch diff: lines added and deleted (null for a binary file) and how it changed. */
export interface FileStat {
  path: string;
  added: number | null;
  deleted: number | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'binary';
}

/**
 * The files the branch changes against the merge base of HEAD and `base`, with lines added and deleted, sorted by path:
 * commits plus uncommitted changes to tracked files (untracked files are not part of `git diff`). A rename is one entry
 * with the new path, a binary file has `added` and `deleted` null and the status `binary`. Throws `paths_unverifiable`
 * when git cannot tell (not a repository, unknown `base`, no merge base, timeout).
 */
export async function diffStat(workspace: string, base: string): Promise<FileStat[]> {
  try {
    const from = await mergeBaseOf(workspace, base);
    const [numstat, nameStatus] = await Promise.all([
      git(workspace, ['diff', '-z', '--numstat', '--diff-filter=ADMR', '-M', from, '--']),
      git(workspace, ['diff', '-z', '--name-status', '--diff-filter=ADMR', '-M', from, '--']),
    ]);
    const statuses = parseNameStatus(nameStatus);
    return [...parseNumstat(numstat)]
      .map(([path, counts]): FileStat => {
        if (counts === null) return { path, added: null, deleted: null, status: 'binary' };
        return { path, added: counts.added, deleted: counts.deleted, status: statuses.get(path) ?? 'modified' };
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  } catch (error) {
    throw new SymphonyError('paths_unverifiable', `git could not measure the changes against ${base}: ${errorMessage(error)}`, { cause: error });
  }
}

/** `--numstat -z`: `<a>\t<d>\t<path>\0`, for a rename `<a>\t<d>\t\0<old>\0<new>\0`. Maps the (new) path to its counts, null for binary. */
function parseNumstat(output: string): Map<string, { added: number; deleted: number } | null> {
  const tokens = output.split('\0');
  const result = new Map<string, { added: number; deleted: number } | null>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '') continue;
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(token);
    if (match === null) throw new Error(`unexpected numstat entry: ${token}`);
    let file = match[3]!;
    if (file === '') {
      file = tokens[i + 2] ?? '';
      i += 2;
    }
    result.set(file, match[1] === '-' || match[2] === '-' ? null : { added: Number(match[1]), deleted: Number(match[2]) });
  }
  return result;
}

/** `--name-status -z`: `<S>\0<path>\0`, for a rename `R<score>\0<old>\0<new>\0`. Maps the (new) path to its status. */
function parseNameStatus(output: string): Map<string, FileStat['status']> {
  const tokens = output.split('\0');
  const result = new Map<string, FileStat['status']>();
  for (let i = 0; i < tokens.length; i++) {
    const letter = tokens[i]![0];
    if (letter === undefined) continue;
    if (letter === 'R') {
      result.set(tokens[i + 2] ?? '', 'renamed');
      i += 2;
    } else {
      result.set(tokens[i + 1] ?? '', letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified');
      i += 1;
    }
  }
  return result;
}
