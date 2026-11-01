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
    return await fileStats(workspace, ['diff', from]);
  } catch (error) {
    throw new SymphonyError('paths_unverifiable', `git could not measure the changes against ${base}: ${errorMessage(error)}`, { cause: error });
  }
}

/**
 * The files of a diff command (`['diff', <from>]` or `['show', '--format=', <sha>]`) with lines added and deleted and
 * their status, sorted by path; renames are one entry with the new path, binary files have null counts.
 */
export async function fileStats(workspace: string, command: string[]): Promise<FileStat[]> {
  const [numstat, nameStatus] = await Promise.all([
    git(workspace, [...command, '-z', '--numstat', '--diff-filter=ADMR', '-M', '--']),
    git(workspace, [...command, '-z', '--name-status', '--diff-filter=ADMR', '-M', '--']),
  ]);
  const statuses = parseNameStatus(nameStatus);
  return [...parseNumstat(numstat)]
    .map(([path, counts]): FileStat => {
      if (counts === null) return { path, added: null, deleted: null, status: 'binary' };
      return { path, added: counts.added, deleted: counts.deleted, status: statuses.get(path) ?? 'modified' };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** One commit of a session: subject, committer date (ISO, UTC), the files it changed and an excerpt of its diff. */
export interface CommitStat {
  sha: string;
  subject: string;
  at: string;
  files: FileStat[];
  diff: string | null;
}

/** Commits `commitStats` reports per call without `max`. */
export const COMMIT_STATS_MAX = 20;

/**
 * The commits HEAD gained since `since` (the HEAD a session started from), without merge commits and without what
 * `base` (a ref such as `origin/develop`) already has, oldest first: at most the newest `max` (default 20). Without
 * `since` it lists what HEAD has beyond `base`, and nothing when `base` does not resolve either. Throws
 * `paths_unverifiable` when git cannot tell (not a repository, unknown `since`, timeout).
 */
export async function commitStats(workspace: string, options: { since: string | null; base: string; max?: number }): Promise<CommitStat[]> {
  try {
    const baseKnown = await git(workspace, ['rev-parse', '--verify', '--quiet', `${options.base}^{commit}`]).then(
      () => true,
      () => false,
    );
    if (options.since === null && !baseKnown) return [];
    const range = options.since === null ? ['HEAD'] : [`${options.since}..HEAD`];
    const listed = await git(workspace, [
      'rev-list',
      '--no-merges',
      `--max-count=${options.max ?? COMMIT_STATS_MAX}`,
      ...range,
      ...(baseKnown ? ['--not', options.base] : []),
      '--',
    ]);
    const shas = listed.split('\n').filter((sha) => sha !== '').reverse();
    const commits: CommitStat[] = [];
    for (const sha of shas) {
      const [meta, files, patch] = await Promise.all([
        git(workspace, ['show', '-s', '--format=%cI%n%s', sha]),
        fileStats(workspace, ['show', '--format=', sha]),
        git(workspace, ['-c', 'core.quotePath=false', 'show', '--format=', '-U0', '--no-color', '--no-ext-diff', sha]),
      ]);
      const [date = '', ...subject] = meta.replace(/\n+$/, '').split('\n');
      const time = Date.parse(date);
      commits.push({ sha, subject: subject.join(' '), at: Number.isNaN(time) ? new Date(0).toISOString() : new Date(time).toISOString(), files, diff: diffExcerpt(patch) });
    }
    return commits;
  } catch (error) {
    throw new SymphonyError('paths_unverifiable', `git could not list the commits since ${options.since ?? options.base}: ${errorMessage(error)}`, { cause: error });
  }
}

/** Changed lines per file in `diffExcerpt`. */
const EXCERPT_LINES = 5;
const EXCERPT_LINE_CHARS = 200;
const EXCERPT_FILES = 50;
const EXCERPT_CHARS = 16_000;

/**
 * An excerpt of a unified diff (`git show -U0`): per file its path, then at most 5 added or removed lines (each cut to
 * 200 characters), files separated by an empty line; binary files and files without changed lines are left out, at most
 * 50 files and 16 000 characters. Null when nothing is left.
 */
export function diffExcerpt(unifiedDiff: string): string | null {
  const blocks: string[] = [];
  let file: { path: string; lines: string[] } | null = null;
  let inHunk = false;
  const flush = () => {
    if (file !== null && file.lines.length > 0) blocks.push([file.path, ...file.lines].join('\n'));
    file = null;
  };
  for (const line of unifiedDiff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      if (blocks.length >= EXCERPT_FILES) break;
      const header = / b\/(.*)$/.exec(line);
      file = { path: header?.[1] ?? line.slice('diff --git '.length), lines: [] };
      inHunk = false;
      continue;
    }
    if (file === null) continue;
    if (!inHunk) {
      if (line.startsWith('+++ ') && line !== '+++ /dev/null') file.path = line.slice(4).replace(/^b\//, '');
      else if (line.startsWith('--- ') && line !== '--- /dev/null') file.path = line.slice(4).replace(/^a\//, '');
      else if (line.startsWith('@@')) inHunk = true;
      continue;
    }
    if (line.startsWith('@@')) continue;
    if ((line.startsWith('+') || line.startsWith('-')) && file.lines.length < EXCERPT_LINES) file.lines.push(line.slice(0, EXCERPT_LINE_CHARS));
  }
  flush();
  if (blocks.length === 0) return null;
  const text = blocks.join('\n\n');
  return text.length > EXCERPT_CHARS ? text.slice(0, EXCERPT_CHARS) : text;
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
