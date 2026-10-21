import { SymphonyError, errorMessage } from '../util/errors.ts';
import { matchesAnyGlob } from '../workflow/glob.ts';
import { git, names } from '../workspace/git.ts';

/** A full or abbreviated object name, as `git rev-parse` prints it; anything else (an option, a ref expression) is no commit. */
const COMMIT_NAME = /^[0-9a-f]{7,64}$/i;

/** Whether `ancestor` is `descendant` or one of its ancestors; false when git cannot tell (an unknown commit). */
async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
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
 * it null. Checked when the agent reports: the workspace may reach the branch only after the session started.
 */
export async function baselineCommit(cwd: string, handoff: string | null, start: string | null): Promise<string | null> {
  if (handoff !== null && COMMIT_NAME.test(handoff) && (await isAncestor(cwd, handoff, 'HEAD'))) return handoff;
  return start;
}

/**
 * The repository-relative paths that differ from the commit `base`: committed since (`base..HEAD`), changed in the working
 * tree or index, and untracked (ignored files stay out), sorted. Renames count as the deletion of the old and the
 * addition of the new path, so moving a file out of a protected directory is still seen. Throws `paths_unverifiable`
 * when git cannot tell.
 */
export async function changedFilesSince(cwd: string, base: string): Promise<string[]> {
  try {
    const [committed, working, untracked] = await Promise.all([
      git(cwd, ['diff', '-z', '--no-renames', '--name-only', `${base}..HEAD`, '--']),
      git(cwd, ['diff', '-z', '--no-renames', '--name-only', base, '--']),
      git(cwd, ['ls-files', '-z', '--full-name', '--others', '--exclude-standard']),
    ]);
    return [...new Set([...names(committed), ...names(working), ...names(untracked)])].sort();
  } catch (error) {
    throw new SymphonyError('paths_unverifiable', `git could not list the files changed since ${base.slice(0, 12)}: ${errorMessage(error)}`, { cause: error });
  }
}

/** The files among `files` that match none of `allowed`. */
export function filesOutside(files: readonly string[], allowed: readonly string[]): string[] {
  return files.filter((file) => !matchesAnyGlob(file, allowed));
}
