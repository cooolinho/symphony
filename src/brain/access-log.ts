import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../log.ts';
import { errorMessage } from '../util/errors.ts';

/** Lines older than this many days are removed from the access log at startup. */
export const BRAIN_ACCESS_RETENTION_DAYS = 30;
/** Clashes of the last this many days are rebuilt from the log at startup. */
export const BRAIN_CLASH_LOOKBACK_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export type BrainAccessOp = 'read' | 'search' | 'list' | 'write' | 'append' | 'resolve';
export type BrainClashReason = 'window' | 'hash_mismatch';

/** One line of `access.jsonl`: one brain tool call. */
export interface BrainAccess {
  /** ISO timestamp. */
  at: string;
  run: string | null;
  issue: string | null;
  role: string | null;
  op: BrainAccessOp;
  path_or_query: string;
  /** Missing purpose is logged as an empty string. */
  purpose: string;
  result: 'ok' | 'rejected';
  /** `window`, `hash_mismatch` or the error category. */
  reason?: string;
  hash_before?: string;
  hash_after?: string;
  clash_id?: string;
  other_run?: string | null;
  other_at?: string | null;
}

export interface BrainClash {
  id: string;
  path: string;
  /** The earlier writer first, then the rejected run. */
  runs: [string | null, string | null];
  at: [string | null, string];
  reason: BrainClashReason;
  status: 'open' | 'resolved';
}

/** Called for every clash: when it is recorded and for each clash `load` restores. */
export type BrainClashListener = (line: BrainAccess, clash: BrainClash) => void;

interface LastWrite {
  run: string | null;
  at: string;
}

function parseLine(line: string): (BrainAccess & { time: number }) | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const entry = parsed as BrainAccess;
    if (typeof entry.at !== 'string') return null;
    const time = Date.parse(entry.at);
    return Number.isNaN(time) ? null : { ...entry, time };
  } catch {
    return null;
  }
}

/**
 * Append-only JSONL log of brain tool calls at `<dir>/access.jsonl` plus, in memory, the last successful writer per note
 * and the clash list. One instance is shared by all sessions. `dir === null` keeps everything in memory only. Never throws.
 */
export class BrainAccessLog {
  readonly file: string | null;
  readonly #logger: Logger;
  readonly #lastWrite = new Map<string, LastWrite>();
  #clashes: BrainClash[] = [];
  readonly #onClash: BrainClashListener | undefined;
  /** Successful reads and writes per UTC day (YYYY-MM-DD). */
  readonly #daily = new Map<string, { reads: number; writes: number }>();
  #failing = false;

  constructor(dir: string | null, logger: Logger, options: { onClash?: BrainClashListener } = {}) {
    this.file = dir === null ? null : path.join(dir, 'access.jsonl');
    this.#logger = logger;
    this.#onClash = options.onClash;
  }

  #notifyClash(line: BrainAccess, clash: BrainClash): void {
    try {
      this.#onClash?.(line, { ...clash, runs: [...clash.runs], at: [...clash.at] });
    } catch (error) {
      this.#logger.warn('brain clash listener failed', { clash: clash.id, error: errorMessage(error) });
    }
  }

  /** Prunes the file, then rebuilds the last-writer index and the clashes of the last 7 days from it. */
  load(now: Date): void {
    this.prune(now);
    this.#lastWrite.clear();
    this.#daily.clear();
    this.#clashes = [];
    if (this.file === null) return;
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return;
    }
    const since = now.getTime() - BRAIN_CLASH_LOOKBACK_DAYS * DAY_MS;
    for (const line of text.split('\n')) {
      const entry = parseLine(line);
      if (entry === null) continue;
      this.#count(entry);
      if (entry.result === 'ok' && (entry.op === 'write' || entry.op === 'append')) {
        this.#lastWrite.set(entry.path_or_query, { run: entry.run ?? null, at: entry.at });
      } else if (entry.result === 'rejected' && typeof entry.clash_id === 'string' && entry.time >= since) {
        if (entry.reason !== 'window' && entry.reason !== 'hash_mismatch') continue;
        const clash: BrainClash = {
          id: entry.clash_id,
          path: entry.path_or_query,
          runs: [entry.other_run ?? null, entry.run ?? null],
          at: [entry.other_at ?? null, entry.at],
          reason: entry.reason,
          status: 'open',
        };
        this.#clashes.push(clash);
        this.#notifyClash(entry, clash);
      } else if (entry.op === 'resolve' && typeof entry.clash_id === 'string') {
        const clash = this.#clashes.find((candidate) => candidate.id === entry.clash_id);
        if (clash !== undefined) clash.status = 'resolved';
      }
    }
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
      const limit = now.getTime() - BRAIN_ACCESS_RETENTION_DAYS * DAY_MS;
      const lines = text.split('\n').filter((line) => line !== '');
      const kept = lines.filter((line) => {
        const entry = parseLine(line);
        return entry !== null && entry.time >= limit;
      });
      const removed = lines.length - kept.length;
      if (removed === 0) return 0;
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, kept.map((line) => `${line}\n`).join(''));
      fs.renameSync(tmp, this.file);
      return removed;
    } catch (error) {
      this.#logger.warn('cannot prune the brain access log', { file: this.file, error: errorMessage(error) });
      return 0;
    }
  }

  /** Appends one line. */
  record(entry: BrainAccess): void {
    this.#count(entry);
    if (this.file === null) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
      this.#failing = false;
    } catch (error) {
      if (!this.#failing) this.#logger.warn('cannot write the brain access log', { file: this.file, error: errorMessage(error) });
      this.#failing = true;
    }
  }

  #count(entry: BrainAccess): void {
    if (entry.result !== 'ok' || typeof entry.at !== 'string') return;
    const reads = entry.op === 'read' || entry.op === 'search' || entry.op === 'list';
    const writes = entry.op === 'write' || entry.op === 'append';
    if (!reads && !writes) return;
    const day = entry.at.slice(0, 10);
    const counts = this.#daily.get(day) ?? { reads: 0, writes: 0 };
    if (reads) counts.reads++;
    else counts.writes++;
    this.#daily.set(day, counts);
  }

  /** Successful reads (read, search, list) and writes (write, append) of the UTC day of `now`. */
  todayCounts(now: Date): { reads: number; writes: number } {
    const counts = this.#daily.get(now.toISOString().slice(0, 10));
    return { reads: counts?.reads ?? 0, writes: counts?.writes ?? 0 };
  }

  /** Appends the line of a successful write and remembers the writer of the note. */
  recordWrite(entry: BrainAccess): void {
    this.#lastWrite.set(entry.path_or_query, { run: entry.run, at: entry.at });
    this.record(entry);
  }

  lastWrite(notePath: string): LastWrite | null {
    return this.#lastWrite.get(notePath) ?? null;
  }

  /** The last writer of the note when it is another run and wrote less than `windowMs` ago; null otherwise. */
  recentWriteByOtherRun(notePath: string, run: string | null, now: Date, windowMs: number): LastWrite | null {
    if (windowMs <= 0) return null;
    const last = this.#lastWrite.get(notePath);
    if (last === undefined) return null;
    if (run !== null && last.run === run) return null;
    return now.getTime() - Date.parse(last.at) < windowMs ? last : null;
  }

  /** Logs a rejected write and adds the clash to the list. */
  recordClash(entry: BrainAccess, other: { run: string | null; at: string | null }, reason: BrainClashReason): BrainClash {
    const clash: BrainClash = {
      id: randomUUID(),
      path: entry.path_or_query,
      runs: [other.run, entry.run],
      at: [other.at, entry.at],
      reason,
      status: 'open',
    };
    this.#clashes.push(clash);
    const line: BrainAccess = { ...entry, result: 'rejected', reason, clash_id: clash.id, other_run: other.run, other_at: other.at };
    this.record(line);
    this.#notifyClash(line, clash);
    return clash;
  }

  clashes(): BrainClash[] {
    return this.#clashes.map((clash) => ({ ...clash, runs: [...clash.runs], at: [...clash.at] }));
  }

  /** Marks a clash resolved and logs `op: resolve`; false for an unknown or already resolved id. */
  markResolved(id: string, now: Date = new Date()): boolean {
    const clash = this.#clashes.find((candidate) => candidate.id === id);
    if (clash === undefined || clash.status === 'resolved') return false;
    clash.status = 'resolved';
    this.record({
      at: now.toISOString(),
      run: null,
      issue: null,
      role: null,
      op: 'resolve',
      path_or_query: clash.path,
      purpose: '',
      result: 'ok',
      clash_id: id,
    });
    return true;
  }
}
