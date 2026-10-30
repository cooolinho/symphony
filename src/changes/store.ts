import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../log.ts';
import { errorMessage } from '../util/errors.ts';
import { CHANGES_LOAD_LIMIT, CHANGES_PAGE_DEFAULT, CHANGES_PAGE_LIMIT, type ChangeEntry, type ChangeFilter } from './types.ts';

/** File of a repository's changes below the store's directory: `owner/name` → `owner_name.jsonl`. */
export function changesFileName(repo: string): string {
  return `${repo.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`;
}

function parseEntry(line: string): ChangeEntry | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const entry = parsed as Partial<ChangeEntry>;
    if (typeof entry.id !== 'string' || typeof entry.repo !== 'string' || typeof entry.at !== 'string' || !Array.isArray(entry.files)) return null;
    return Number.isNaN(Date.parse(entry.at)) ? null : (entry as ChangeEntry);
  } catch {
    return null;
  }
}

/** Newest first: `at` descending, the id descending for the same time. */
function newestFirst(a: ChangeEntry, b: ChangeEntry): number {
  const diff = Date.parse(b.at) - Date.parse(a.at);
  if (diff !== 0) return diff;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * The changes Symphony recorded (commits and merges of agent sessions), in memory per repository (the newest
 * `CHANGES_LOAD_LIMIT`) and appended as JSONL to `<dir>/<owner>_<name>.jsonl`; `dir === null` keeps them in memory only.
 * Never throws: a write that fails is logged once and the entry stays in memory.
 */
export class ChangeStore {
  readonly dir: string | null;
  readonly #logger: Logger;
  /** By repository, in append order. */
  #entries = new Map<string, ChangeEntry[]>();
  #ids = new Set<string>();
  #failing = false;

  constructor(dir: string | null, logger: Logger) {
    this.dir = dir;
    this.#logger = logger;
  }

  /** Reads the newest `CHANGES_LOAD_LIMIT` readable lines of every file; unreadable lines are skipped. A missing directory is empty. */
  load(): void {
    if (this.dir === null) return;
    let files: string[];
    try {
      files = fs.readdirSync(this.dir).filter((name) => name.endsWith('.jsonl')).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#logger.warn('cannot read the change log', { dir: this.dir, error: errorMessage(error) });
      return;
    }
    for (const name of files) {
      const file = path.join(this.dir, name);
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (error) {
        this.#logger.warn('cannot read the change log', { file, error: errorMessage(error) });
        continue;
      }
      const entries: ChangeEntry[] = [];
      let skipped = 0;
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        const entry = parseEntry(line);
        if (entry === null) skipped++;
        else entries.push(entry);
      }
      if (skipped > 0) this.#logger.warn('skipped unreadable lines of the change log', { file, lines: skipped });
      for (const entry of entries.slice(-CHANGES_LOAD_LIMIT)) this.#remember(entry);
    }
  }

  has(id: string): boolean {
    return this.#ids.has(id);
  }

  /** Stores the entry and appends it to its repository's file; false (nothing written) when its id is known already. */
  append(entry: ChangeEntry): boolean {
    if (this.#ids.has(entry.id)) return false;
    this.#remember(entry);
    if (this.dir === null) return true;
    const file = path.join(this.dir, changesFileName(entry.repo));
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
      this.#failing = false;
    } catch (error) {
      if (!this.#failing) this.#logger.warn('cannot write the change log', { file, error: errorMessage(error) });
      this.#failing = true;
    }
    return true;
  }

  /**
   * One page of the entries matching `type`, `repo` and `issue`, newest first. `before` is the id of the last entry of
   * the previous page (an unknown id gives the first page); `limit` defaults to 50 and is kept between 1 and 200.
   */
  list(filter: ChangeFilter = {}): ChangeEntry[] {
    const limit = Math.min(CHANGES_PAGE_LIMIT, Math.max(1, Math.floor(filter.limit ?? CHANGES_PAGE_DEFAULT)));
    const sources = filter.repo !== undefined ? [this.#entries.get(filter.repo) ?? []] : [...this.#entries.values()];
    const matching = sources
      .flat()
      .filter((entry) => (filter.type === undefined || entry.type === filter.type) && (filter.issue === undefined || entry.issue === filter.issue))
      .sort(newestFirst);
    const start = filter.before === undefined ? 0 : matching.findIndex((entry) => entry.id === filter.before) + 1;
    return matching.slice(start, start + limit);
  }

  #remember(entry: ChangeEntry): void {
    if (this.#ids.has(entry.id)) return;
    const list = this.#entries.get(entry.repo) ?? [];
    list.push(entry);
    this.#ids.add(entry.id);
    while (list.length > CHANGES_LOAD_LIMIT) this.#ids.delete(list.shift()!.id);
    this.#entries.set(entry.repo, list);
  }
}
