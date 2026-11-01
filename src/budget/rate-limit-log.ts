import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../log.ts';
import { errorMessage } from '../util/errors.ts';

/** Lines older than this many days are removed from the rate-limit log. */
export const RATE_LIMIT_RETENTION_DAYS = 30;
/** Minimum time between two rotations of the log. */
export const RATE_LIMIT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One line of `rate-limits.jsonl`: where a `rate_limit_event` came from plus the raw SDK object. */
export interface RateLimitRecord {
  /** ISO timestamp. */
  at: string;
  run_id: string;
  issue: string;
  role: string;
  model: string | null;
  /** The `rate_limit_info` object of the SDK, unchanged. */
  rate_limit_info: unknown;
}

/** The `rateLimitType` of a raw `rate_limit_info` (five_hour, seven_day, ...); `unknown` when missing. */
export function rateLimitKey(info: unknown): string {
  if (typeof info === 'object' && info !== null) {
    const type = (info as { rateLimitType?: unknown }).rateLimitType;
    if (typeof type === 'string' && type !== '') return type;
  }
  return 'unknown';
}

/** True when the raw `rate_limit_info` reports a rejected request (`status === 'rejected'`), i.e. a limit hit. */
export function isRejected(info: unknown): boolean {
  return typeof info === 'object' && info !== null && (info as { status?: unknown }).status === 'rejected';
}

/** Epoch ms of a `resetsAt` value: numbers >= 1e12 are ms, smaller ones seconds, non-empty strings are parsed as dates; else null. */
export function resetTimeMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value >= 1e12 ? value : value * 1000;
  if (typeof value === 'string' && value !== '') {
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : time;
  }
  return null;
}

/** Utilisation (1 = limit reached, may exceed 1) and reset (epoch ms) of one window; null for what is missing or unusable. */
export interface WindowUtilization {
  utilization: number | null;
  resetsAt: number | null;
}

function field(obj: unknown, key: string): unknown {
  return typeof obj === 'object' && obj !== null && !Array.isArray(obj) ? (obj as Record<string, unknown>)[key] : undefined;
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Utilisation and reset of `window` from a raw `rate_limit_info`. Never throws.
 * Source is `unifiedWindows.<window>`, else the top level when `rateLimitType` is the window.
 * Values above 1 are kept. A `rejected` of this window counts as at least 1.0 and may take the top-level `resetsAt`.
 */
export function windowUtilization(info: unknown, window: string): WindowUtilization {
  if (!isObject(info)) return { utilization: null, resetsAt: null };
  const own = field(field(info, 'unifiedWindows'), window);
  const source = isObject(own) ? own : rateLimitKey(info) === window ? info : null;
  let utilization: number | null = null;
  let resetsAt: number | null = null;
  if (source !== null) {
    const value = field(source, 'utilization');
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) utilization = value;
    resetsAt = resetTimeMs(field(source, 'resetsAt'));
  }
  if (isRejected(info) && rateLimitKey(info) === window) {
    utilization = Math.max(utilization ?? 1, 1);
    resetsAt ??= resetTimeMs(field(info, 'resetsAt'));
  }
  return { utilization, resetsAt };
}

function timeOf(line: string): number | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const at = (parsed as { at?: unknown }).at;
    if (typeof at !== 'string') return null;
    const time = Date.parse(at);
    return Number.isNaN(time) ? null : time;
  } catch {
    return null;
  }
}

/** Append-only JSONL log of rate-limit events at `<dir>/rate-limits.jsonl`; `dir === null` disables it. Never throws. */
export class RateLimitLog {
  readonly file: string | null;
  readonly #logger: Logger;
  #failing = false;
  #lastPruneAt: number | null = null;

  constructor(dir: string | null, logger: Logger) {
    this.file = dir === null ? null : path.join(dir, 'rate-limits.jsonl');
    this.#logger = logger;
  }

  append(record: RateLimitRecord): void {
    if (this.file === null) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`);
      this.#failing = false;
    } catch (error) {
      if (!this.#failing) this.#logger.warn('cannot write the rate-limit log', { file: this.file, error: errorMessage(error) });
      this.#failing = true;
    }
  }

  /** The events in write order, from `since` on when given. Missing file or unreadable lines are skipped. */
  readRateLimitEvents(since?: Date): RateLimitRecord[] {
    if (this.file === null) return [];
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const events: RateLimitRecord[] = [];
    for (const line of text.split('\n')) {
      const time = timeOf(line);
      if (time === null || (since !== undefined && time < since.getTime())) continue;
      events.push(JSON.parse(line) as RateLimitRecord);
    }
    return events;
  }

  /** Drops lines older than the retention (and unreadable ones). Returns the number of removed lines. */
  prune(now: Date): number {
    if (this.file === null) return 0;
    try {
      let text: string;
      try {
        text = fs.readFileSync(this.file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
      }
      const limit = now.getTime() - RATE_LIMIT_RETENTION_DAYS * DAY_MS;
      const lines = text.split('\n').filter((line) => line !== '');
      const kept = lines.filter((line) => {
        const time = timeOf(line);
        return time !== null && time >= limit;
      });
      const removed = lines.length - kept.length;
      if (removed === 0) return 0;
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, kept.map((line) => `${line}\n`).join(''));
      fs.renameSync(tmp, this.file);
      return removed;
    } catch (error) {
      this.#logger.warn('cannot prune the rate-limit log', { file: this.file, error: errorMessage(error) });
      return 0;
    }
  }

  /** Prunes when it has not happened yet or the last pruning is at least a day old. */
  pruneIfDue(now: Date): void {
    if (this.#lastPruneAt !== null && now.getTime() - this.#lastPruneAt < RATE_LIMIT_PRUNE_INTERVAL_MS) return;
    this.#lastPruneAt = now.getTime();
    this.prune(now);
  }
}
