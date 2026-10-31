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

export type BrainAccessOp = 'read' | 'search' | 'list' | 'write' | 'append' | 'resolve' | 'vitals';
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

/** The note as it was when the write was rejected (`base`) and the content the run tried to write (`attempted`). */
export interface BrainClashVersions {
  base: { content: string; hash: string } | null;
  attempted: { content: string } | null;
}

export interface BrainAccessQuery {
  /** Exact role (case-insensitive). */
  role?: string | null;
  /** Substring of `path_or_query` or `purpose` (case-insensitive). */
  q?: string | null;
  /** `next_before` of the previous page: only lines before this line number. */
  before?: number | null;
  limit?: number | null;
}

export interface BrainAccessPage {
  /** Newest first; `purpose` is always a string. */
  access: BrainAccess[];
  /** Cursor of the next page; null on the last page. */
  next_before: number | null;
}

export const BRAIN_ACCESS_PAGE_DEFAULT = 100;
export const BRAIN_ACCESS_PAGE_MAX = 500;

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
  readonly #versions = new Map<string, BrainClashVersions>();
  /** Sidecars with the versions of each clash; null without a log dir. */
  readonly #clashDir: string | null;
  /** Successful reads and writes per UTC day (YYYY-MM-DD). */
  readonly #daily = new Map<string, { reads: number; writes: number }>();
  #failing = false;

  constructor(dir: string | null, logger: Logger, options: { onClash?: BrainClashListener } = {}) {
    this.file = dir === null ? null : path.join(dir, 'access.jsonl');
    this.#clashDir = dir === null ? null : path.join(dir, 'clashes');
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
    this.#loadVersions(now);
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

  /** Reads the clash sidecars of the last 7 days; deletes older and unreadable ones. */
  #loadVersions(now: Date): void {
    this.#versions.clear();
    if (this.#clashDir === null) return;
    let files: string[];
    try {
      files = fs.readdirSync(this.#clashDir);
    } catch {
      return;
    }
    const since = now.getTime() - BRAIN_CLASH_LOOKBACK_DAYS * DAY_MS;
    for (const name of files) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.#clashDir, name);
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { id?: unknown; at?: unknown } & BrainClashVersions;
        const time = typeof parsed.at === 'string' ? Date.parse(parsed.at) : NaN;
        if (typeof parsed.id === 'string' && !Number.isNaN(time) && time >= since) {
          this.#versions.set(parsed.id, { base: parsed.base ?? null, attempted: parsed.attempted ?? null });
          continue;
        }
      } catch {
        // unreadable: removed below
      }
      try {
        fs.rmSync(file, { force: true });
      } catch (error) {
        this.#logger.warn('cannot remove an old brain clash file', { file, error: errorMessage(error) });
      }
    }
  }

  /**
   * One page of the log, newest first, read from the file on every call. `before` and `next_before` are line numbers of
   * the file (append-only; they only shift when the startup prune removes lines).
   */
  readAccess(query: BrainAccessQuery = {}): BrainAccessPage {
    const limit = Math.min(Math.max(1, Math.floor(query.limit ?? BRAIN_ACCESS_PAGE_DEFAULT)), BRAIN_ACCESS_PAGE_MAX);
    if (this.file === null) return { access: [], next_before: null };
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#logger.warn('cannot read the brain access log', { file: this.file, error: errorMessage(error) });
      return { access: [], next_before: null };
    }
    const role = query.role?.trim().toLowerCase() || null;
    const q = query.q?.trim().toLowerCase() || null;
    const lines = text.split('\n');
    const access: BrainAccess[] = [];
    let start = lines.length - 1;
    if (query.before !== null && query.before !== undefined) start = Math.min(start, query.before - 1);
    for (let number = start; number >= 0; number--) {
      const parsed = parseLine(lines[number] ?? '');
      if (parsed === null) continue;
      const { time: _time, ...entry } = parsed;
      const purpose = typeof entry.purpose === 'string' ? entry.purpose : '';
      if (role !== null && (typeof entry.role !== 'string' || entry.role.trim().toLowerCase() !== role)) continue;
      if (q !== null && !String(entry.path_or_query ?? '').toLowerCase().includes(q) && !purpose.toLowerCase().includes(q)) continue;
      if (access.length === limit) return { access, next_before: number + 1 };
      access.push({ ...entry, purpose });
    }
    return { access, next_before: null };
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
    const reads = entry.op === 'read' || entry.op === 'search' || entry.op === 'list' || entry.op === 'vitals';
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

  /** Logs a rejected write, adds the clash to the list and keeps its versions in `<dir>/clashes/<id>.json`. */
  recordClash(
    entry: BrainAccess,
    other: { run: string | null; at: string | null },
    reason: BrainClashReason,
    versions: BrainClashVersions = { base: null, attempted: null },
  ): BrainClash {
    const clash: BrainClash = {
      id: randomUUID(),
      path: entry.path_or_query,
      runs: [other.run, entry.run],
      at: [other.at, entry.at],
      reason,
      status: 'open',
    };
    this.#clashes.push(clash);
this.#versions.set(clash.id, versions);
    this.#writeVersions(clash, versions);
    const line: BrainAccess = { ...entry, result: 'rejected', reason, clash_id: clash.id, other_run: other.run, other_at: other.at };
    this.record(line);
    this.#notifyClash(line, clash);
    return clash;
  }

  #writeVersions(clash: BrainClash, versions: BrainClashVersions): void {
    if (this.#clashDir === null) return;
    const file = path.join(this.#clashDir, `${clash.id}.json`);
    try {
      fs.mkdirSync(this.#clashDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ id: clash.id, path: clash.path, at: clash.at[1], ...versions }));
    } catch (error) {
      this.#logger.warn('cannot write the brain clash versions', { file, error: errorMessage(error) });
    }
  }

  /** The stored versions of a clash; both null when none were kept (e.g. a clash from before they were stored). */
  clashVersions(id: string): BrainClashVersions {
    return this.#versions.get(id) ?? { base: null, attempted: null };
  }

  clash(id: string): BrainClash | null {
    return this.clashes().find((clash) => clash.id === id) ?? null;
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
