import { spawn } from 'node:child_process';
import { tail } from '../util/text.ts';

export type HookName = 'after_create' | 'before_run' | 'after_run' | 'before_remove';

export interface HookResult {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** Combined stdout/stderr, truncated to the last OUTPUT_LIMIT characters. */
  output: string;
  durationMs: number;
  error: string | null;
}

const OUTPUT_LIMIT = 16_000;
const KILL_GRACE_MS = 2_000;

/**
 * Runs a hook script with `bash -lc` in the workspace directory, in its own process group so a
 * timeout kills everything the script started.
 */
export function runShellScript(
  script: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<HookResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let settled = false;
    const append = (chunk: Buffer | string) => {
      output = tail(output + chunk.toString(), OUTPUT_LIMIT);
    };

    const child = spawn('bash', ['-lc', script], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref();
    }, options.timeoutMs);

    const finish = (result: Omit<HookResult, 'output' | 'durationMs' | 'timedOut'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, timedOut, output, durationMs: Date.now() - started });
    };
    child.on('error', (error) => finish({ ok: false, exitCode: null, signal: null, error: error.message }));
    // 'close' waits for the output pipes too, so background jobs must redirect their output.
    child.on('close', (code, signal) => finish({ ok: code === 0 && !timedOut, exitCode: code, signal, error: null }));
  });
}
