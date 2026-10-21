import { SymphonyError, errorMessage } from '../util/errors.ts';
import { git, names } from './git.ts';

/**
 * The repository-relative paths the branch changes against `base` (a ref such as `origin/develop`): what was committed
 * since the branch left `base` (the merge base of HEAD and `base`, so commits that only `base` gained do not count),
 * changed in the working tree or index, and untracked (ignored files stay out), sorted. Renames count as the deletion of
 * the old and the addition of the new path, so moving a file out of a protected directory is still seen. Bounded by a
 * timeout per git call. Throws `paths_unverifiable` when git cannot tell (not a repository, unknown `base`, timeout).
 */
export async function changedFiles(workspace: string, base: string): Promise<string[]> {
  try {
    const mergeBase = (await git(workspace, ['merge-base', 'HEAD', base])).trim();
    if (mergeBase === '') throw new Error(`HEAD and ${base} have no common ancestor`);
    const [tracked, untracked] = await Promise.all([
      git(workspace, ['diff', '-z', '--no-renames', '--name-only', mergeBase, '--']),
      git(workspace, ['ls-files', '-z', '--full-name', '--others', '--exclude-standard']),
    ]);
    return [...new Set([...names(tracked), ...names(untracked)])].sort();
  } catch (error) {
    throw new SymphonyError('paths_unverifiable', `git could not list the files changed against ${base}: ${errorMessage(error)}`, { cause: error });
  }
}
