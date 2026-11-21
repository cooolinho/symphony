import { execFile } from 'node:child_process';

/** One git call of the base integration; long enough for a fetch or push over a slow link. */
const GIT_TIMEOUT_MS = 120_000;

/** What integrating `origin/<base>` into the issue branch did (`checks.integrate_base`). */
export type IntegrateResult =
  /** The branch already contains `origin/<base>`: nothing to do. */
  | { kind: 'up_to_date'; base: string }
  /** `origin/<base>` was merged cleanly and the merge commit pushed. */
  | { kind: 'merged'; base: string; sha: string }
  /** The merge conflicts: it was aborted, the workspace is as before. */
  | { kind: 'conflict'; base: string; files: string[] }
  /** Git failed (fetch, push, dirty tree, detached HEAD, ...): an environment problem, not the code's. */
  | { kind: 'error'; base: string | null; message: string };

export interface IntegrateOptions {
  /** The pull request's base branch; null = the remote's default branch (`origin/HEAD`). */
  base: string | null;
  /** Environment of the git calls (SSH agent, GIT_SSH_COMMAND, ...); default: this process's. */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

interface GitOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function run(cwd: string, args: string[], options: IntegrateOptions): Promise<GitOutcome> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, encoding: 'utf8', env: options.env ?? process.env, signal: options.signal, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ ok: error === null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
    );
  });
}

function firstLine(outcome: GitOutcome): string {
  const text = `${outcome.stderr}\n${outcome.stdout}`.trim();
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? 'no output';
}

/**
 * Merges `origin/<base>` into the workspace's branch before the gated checks run, so they test what the merge will
 * contain and a conflict reaches the developer before a long CI run, not at the auto-merge. Mechanical: no agent, no
 * conflict resolution. Never throws; a conflict leaves the workspace as it was (`git merge --abort`).
 */
export async function integrateBase(cwd: string, options: IntegrateOptions): Promise<IntegrateResult> {
  let base = options.base?.trim() || null;
  if (base === null) {
    const head = await run(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], options);
    base = head.ok ? head.stdout.trim().replace(/^origin\//, '') || null : null;
    if (base === null) return { kind: 'error', base: null, message: 'cannot tell the base branch (no base_branch, no origin/HEAD)' };
  }

  const branch = await run(cwd, ['symbolic-ref', '--short', 'HEAD'], options);
  if (!branch.ok) return { kind: 'error', base, message: 'the workspace is on a detached HEAD, there is no branch to integrate into' };
  const name = branch.stdout.trim();
  if (name === base) return { kind: 'up_to_date', base };

  const status = await run(cwd, ['status', '--porcelain', '--untracked-files=no'], options);
  if (!status.ok) return { kind: 'error', base, message: `git status failed: ${firstLine(status)}` };
  if (status.stdout.trim() !== '') return { kind: 'error', base, message: 'the workspace has uncommitted changes to tracked files' };

  const fetch = await run(cwd, ['fetch', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], options);
  if (!fetch.ok) return { kind: 'error', base, message: `git fetch origin ${base} failed: ${firstLine(fetch)}` };

  const contained = await run(cwd, ['merge-base', '--is-ancestor', `origin/${base}`, 'HEAD'], options);
  if (contained.ok) return { kind: 'up_to_date', base };

  const merge = await run(
    cwd,
    ['merge', '--no-edit', '--no-ff', '-m', `Merge origin/${base} into ${name}`, `origin/${base}`],
    options,
  );
  if (!merge.ok) {
    const unmerged = await run(cwd, ['diff', '--name-only', '--diff-filter=U'], options);
    const files = unmerged.ok ? unmerged.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '') : [];
    await run(cwd, ['merge', '--abort'], options);
    if (files.length === 0) return { kind: 'error', base, message: `git merge origin/${base} failed: ${firstLine(merge)}` };
    return { kind: 'conflict', base, files };
  }

  const push = await run(cwd, ['push', '--quiet', 'origin', `HEAD:refs/heads/${name}`], options);
  if (!push.ok) {
    // Keep the workspace in step with the remote: the next attempt merges again.
    await run(cwd, ['reset', '--quiet', '--hard', 'HEAD@{1}'], options);
    return { kind: 'error', base, message: `git push of the merge failed: ${firstLine(push)}` };
  }
  const sha = await run(cwd, ['rev-parse', 'HEAD'], options);
  return { kind: 'merged', base, sha: sha.stdout.trim() };
}

/** The message a conflict sends back to the developer (the check output of `integrate-base`). */
export function conflictOutput(result: Extract<IntegrateResult, { kind: 'conflict' }>, branch: string | null = null): string {
  const into = branch === null ? 'the issue branch' : `\`${branch}\``;
  return [
    `origin/${result.base} no longer merges cleanly into ${into}. Conflicting files:`,
    ...result.files.map((file) => `- ${file}`),
    '',
    `Merge origin/${result.base} into the branch, resolve the conflicts, run the checks again and hand off.`,
  ].join('\n');
}
