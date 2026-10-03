import { spawn } from 'node:child_process';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

const KILL_GRACE_MS = 3_000;

/** Process groups of agent sessions that may still have members; killed on orchestrator exit. */
const liveGroups = new Set<number>();

export function killProcessGroup(pid: number | null, signal: NodeJS.Signals): boolean {
  if (pid === null) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Last-resort cleanup for process exit paths; synchronous by design. */
export function killAllAgentProcessGroups(): void {
  for (const pid of liveGroups) killProcessGroup(pid, 'SIGKILL');
  liveGroups.clear();
}

export function forgetProcessGroup(pid: number | null): void {
  if (pid !== null) liveGroups.delete(pid);
}

/**
 * Spawns the Claude Code CLI as the leader of a new process group, so stopping a session also
 * stops every command it started. stderr is drained here (the SDK only reads stdout).
 */
export function processGroupSpawner(hooks: {
  onSpawn: (pid: number | null) => void;
  onStderr: (text: string) => void;
}): (options: SpawnOptions) => SpawnedProcess {
  return (options) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    const pid = child.pid ?? null;
    if (pid !== null) liveGroups.add(pid);
    hooks.onSpawn(pid);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => hooks.onStderr(chunk));

    const killGroup = (signal: NodeJS.Signals): boolean => {
      if (killProcessGroup(pid, signal)) return true;
      try {
        return child.kill(signal);
      } catch {
        return false;
      }
    };
    // The SDK aborts this signal only after its own stdin-EOF grace period.
    options.signal.addEventListener(
      'abort',
      () => {
        killGroup('SIGTERM');
        setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref();
      },
      { once: true },
    );

    return {
      stdin: child.stdin,
      stdout: child.stdout,
      get killed() {
        return child.killed;
      },
      get exitCode() {
        return child.exitCode;
      },
      get signalCode() {
        return child.signalCode;
      },
      kill: killGroup,
      on: child.on.bind(child) as SpawnedProcess['on'],
      once: child.once.bind(child) as SpawnedProcess['once'],
      off: child.off.bind(child) as SpawnedProcess['off'],
    };
  };
}
