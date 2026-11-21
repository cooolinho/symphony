import { SymphonyError, errorMessage } from '../util/errors.ts';
import { matchesAnyGlob } from '../workflow/glob.ts';
import { git, names } from '../workspace/git.ts';

/** A full or abbreviated object name, as `git rev-parse` prints it; anything else (an option, a ref expression) is no commit. */
const COMMIT_NAME = /^[0-9a-f]{7,64}$/i;

/** Whether `ancestor` is `descendant` or one of its ancestors; false when git cannot tell (an unknown commit). */
export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The commit the test engineer's changes are measured from. The developer's last hand-off (`handoff`, the commit its
 * implementation result recorded) when HEAD descends from it: everything up to there is the developer's, however the
 * workspace got to the branch, and a later session of the stage cannot forgive what an earlier one changed. Otherwise
 * the commit the session started from (`start`), which is also where a workspace that is not a git checkout leaves
 * it null. One exception: a session that started on the base branch (`startOnBase`, `start` is on `origin/<base>`) and
 * descends from the hand-off measures from `start`: what lies between is merged pull requests that `before_run`
 * fetched (a hand-off without an issue branch, a spike), not the engineer's work. Local commits of an earlier session
 * are not on `origin/<base>`, so they stay counted. Checked when the agent reports: the workspace may reach the branch only after the session started.
 */
export async function baselineCommit(cwd: string, handoff: string | null, start: string | null, startOnBase = false): Promise<string | null> {
  if (handoff !== null && COMMIT_NAME.test(handoff) && (await isAncestor(cwd, handoff, 'HEAD'))) {
    if (startOnBase && start !== null && COMMIT_NAME.test(start) && (await isAncestor(cwd, handoff, start))) return start;
    return handoff;
  }
  return start;
}

/**
 * The tree of `base` merged with the part of `baseRef` (e.g. `origin/develop`) that HEAD contains, as git would merge
 * them, without touching the workspace (`git merge-tree --write-tree`). Only what HEAD really merged counts: base
 * commits HEAD does not have are no change of the branch. Null when `baseRef` does not resolve, HEAD merged nothing of
 * it beyond `base`, the virtual merge conflicts, or git cannot tell: the caller then measures from `base` alone.
 */
export async function mergedWithBase(cwd: string, base: string, baseRef: string): Promise<string | null> {
  let merged: string;
  try {
    merged = (await git(cwd, ['merge-base', 'HEAD', `${baseRef}^{commit}`])).trim();
  } catch {
    return null;
  }
  if (!COMMIT_NAME.test(merged) || (await isAncestor(cwd, merged, base))) return null;
  try {
    const tree = (await git(cwd, ['merge-tree', '--write-tree', '--no-messages', base, merged])).split('\n')[0]?.trim() ?? '';
    return COMMIT_NAME.test(tree) ? tree : null;
  } catch {
    // Exit 1 = conflicts, else an old git or an unknown commit.
    return null;
  }
}

/** What `changedFilesSince` found: the files, and the base ref whose changes were left out (null when none were). */
export interface ChangedFiles {
  files: string[];
  excludedBase: string | null;
}

/**
 * The repository-relative paths that differ from the commit `base`: committed since (`base..HEAD`), changed in the working
 * tree or index, and untracked (ignored files stay out), sorted. Renames count as the deletion of the old and the
 * addition of the new path, so moving a file out of a protected directory is still seen. Throws `paths_unverifiable`
 * when git cannot tell.
 */
export async function changedFilesSince(cwd: string, base: string): Promise<string[]> {
  return (await ownChangedFiles(cwd, base, null)).files;
}

/**
 * {@link changedFilesSince}, but with `baseRef` (the pull request's base, `origin/<base>`) measured from the virtual
 * merge of `base` and `baseRef`: what came onto the branch by merging the base branch after `base` (a human,
 * `checks.integrate_base`) is not counted, while a conflict resolution or an own change inside such a merge still is.
 * Without `baseRef`, or when the virtual merge is not possible ({@link mergedWithBase}), it measures from `base`.
 */
export async function ownChangedFiles(cwd: string, base: string, baseRef: string | null): Promise<ChangedFiles> {
  try {
    const merged = baseRef === null ? null : await mergedWithBase(cwd, base, baseRef);
    const from = merged ?? base;
    const [committed, working, untracked] = await Promise.all([
      git(cwd, ['diff', '-z', '--no-renames', '--name-only', from, 'HEAD', '--']),
      git(cwd, ['diff', '-z', '--no-renames', '--name-only', from, '--']),
      git(cwd, ['ls-files', '-z', '--full-name', '--others', '--exclude-standard']),
    ]);
    const files = [...new Set([...names(committed), ...names(working), ...names(untracked)])].sort();
    return { files, excludedBase: merged === null ? null : baseRef };
  } catch (error) {
    throw new SymphonyError('paths_unverifiable', `git could not list the files changed since ${base.slice(0, 12)}: ${errorMessage(error)}`, { cause: error });
  }
}

/** The files among `files` that match none of `allowed`. */
export function filesOutside(files: readonly string[], allowed: readonly string[]): string[] {
  return files.filter((file) => !matchesAnyGlob(file, allowed));
}
