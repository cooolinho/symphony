import { execFile } from 'node:child_process';

/** Upper bound for each git call that lists changed files; a repository that needs longer is treated like a failing one. */
export const GIT_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 64 * 1024 * 1024;

/** Runs `git <args>` in `cwd` and resolves with its stdout; rejects on a non-zero exit, a timeout or a missing git. */
export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

/** NUL-separated output (`-z`): file names stay verbatim, whatever characters they hold. */
export function names(output: string): string[] {
  return output.split('\0').filter((name) => name !== '');
}
