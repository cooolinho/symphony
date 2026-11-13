import fs from 'node:fs';
import path from 'node:path';

/** The watchdog's sign of life in its state directory; the orchestrator reads it for `health.watchdog`. */
export const HEARTBEAT_FILE = 'heartbeat.json';
/** How often the watchdog writes it, independent of its ticks (a diagnosis may take minutes). */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** A heartbeat older than this means the watchdog no longer runs. */
export const HEARTBEAT_STALE_MS = 4 * HEARTBEAT_INTERVAL_MS;

export interface Heartbeat {
  pid: number;
  mode: string;
  model: string;
  started_at: string;
  updated_at: string;
  /** End of the newest pass over the blocked column; null before the first. */
  last_tick_at: string | null;
  /** Set when the watchdog stopped on a signal; null while it runs. */
  stopped_at: string | null;
}

/** `health.watchdog` of `/api/v1/state`. */
export interface WatchdogStatus {
  running: boolean;
  mode: string | null;
  started_at: string | null;
  updated_at: string | null;
  last_tick_at: string | null;
  stopped_at: string | null;
}

/** Writes the heartbeat atomically (temp file + rename); never throws. */
export function writeHeartbeat(stateDir: string, heartbeat: Heartbeat): boolean {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const file = path.join(stateDir, HEARTBEAT_FILE);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(heartbeat)}\n`);
    fs.renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * The watchdog's status from its heartbeat; null when no state directory is configured or the watchdog never wrote one
 * (it is not used here), so the dashboard shows nothing then.
 */
export function readWatchdogStatus(stateDir: string | null, now: Date): WatchdogStatus | null {
  if (stateDir === null) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(stateDir, HEARTBEAT_FILE), 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { running: false, mode: null, started_at: null, updated_at: null, last_tick_at: null, stopped_at: null };
  }
  const updatedAt = text(raw.updated_at);
  const updated = updatedAt === null ? Number.NaN : Date.parse(updatedAt);
  const stoppedAt = text(raw.stopped_at);
  return {
    running: stoppedAt === null && Number.isFinite(updated) && now.getTime() - updated <= HEARTBEAT_STALE_MS,
    mode: text(raw.mode),
    started_at: text(raw.started_at),
    updated_at: updatedAt,
    last_tick_at: text(raw.last_tick_at),
    stopped_at: stoppedAt,
  };
}
