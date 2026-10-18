import { execFile } from 'node:child_process';
import { SymphonyError, errorMessage } from '../util/errors.ts';
import { matchesAnyGlob } from '../workflow/glob.ts';

/** Upper bound for each git call; a repository that needs longer is treated like a failing one. */
const GIT_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 64 * 1024 * 1024;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

/** NUL-separated output (`-z`): file names stay verbatim, whatever characters they hold. */
function names(output: string): string[] {
  return output.split('\0').filter((name) => name !== '');
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
