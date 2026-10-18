import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../log.ts';
import { errorMessage } from '../util/errors.ts';
import type { TimelineEvent } from './orchestrator.ts';
import type { PipelineStage } from './pipeline.ts';
import type { ResultRow } from './stage-history.ts';

/**
 * The debugging context of a finished issue claim, as the orchestrator kept it while the issue was claimed:
 * timeline, sessions (with their transcript files), the trace of the last run and the last entry check.
 * JSON-safe, so it can be written to disk and served again after a restart.
 */
export interface ArchivedIssue {
  /** Written as 2; version 1 files (without `results`, verdicts and rounds) are read and upgraded in {@link upgrade}. */
  version: 2;
  /** Board fields of the issue when it was archived; absent in archives from before the pipeline view. */
  issue_meta?: Record<string, unknown> | null;
  /** The issue's pipeline stages when it was archived; absent in archives from before the pipeline view. */
  pipeline?: PipelineStage[];
  issue_id: string;
  issue_identifier: string;
  issue_url: string | null;
  title: string;
  repo: string | null;
  workspace_path: string | null;
  runs: number;
  continuations: number;
  last_error: string | null;
  /** When the orchestrator released the issue, or wrote this snapshot while the issue was still claimed. */
  archived_at: string;
  /** True once the issue was released (not just snapshotted after a run). */
  released: boolean;
  completed_before: boolean;
  timeline: TimelineEvent[];
  next_seq: number;
  sessions: Array<{
    run: string;
    attempt: number | null;
    role: string;
    state: string;
    model: string | null;
    effort: string | null;
    started_at: string;
    finished_at: string | null;
    outcome: string | null;
    transcript: string | null;
  }>;
  /** The issue's stage results (see {@link ResultRow}); empty in archives from before the multi-agent pipeline. */
  results: ResultRow[];
  run_trace: Record<string, unknown> | null;
  last_check: Record<string, unknown> | null;
}

/** Reads an archive of version 1 or 2 as version 2: fields version 1 lacks get their empty value. */
function upgrade(parsed: Partial<Omit<ArchivedIssue, 'version'>> & { version?: number }): ArchivedIssue | null {
  if ((parsed.version !== 1 && parsed.version !== 2) || typeof parsed.issue_identifier !== 'string') return null;
  if (!Array.isArray(parsed.timeline) || !Array.isArray(parsed.sessions)) return null;
  const issue = { ...parsed, version: 2 } as ArchivedIssue;
  if (!Array.isArray(issue.results)) issue.results = [];
  if (Array.isArray(issue.pipeline)) {
    for (const stage of issue.pipeline) {
      stage.verdict ??= null;
      stage.round ??= null;
      for (const session of stage.sessions) {
        session.verdict ??= null;
        session.round ??= null;
      }
    }
  }
  return issue;
}

/** Archive file of an issue: `owner/name#12` → `owner_name_12.json`. */
export function archiveFileName(identifier: string): string {
  return `${identifier.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

/** Archived issues kept in memory (bounded, newest wins). */
const DEFAULT_MEMORY_LIMIT = 200;

/**
 * Keeps the details of finished issues so the agent detail view works after the orchestrator released them:
 * in memory (bounded) and, with a directory, as one JSON file per issue under `<logDir>/issues/`, which also
 * survives a restart. Disk errors are logged once and never fail the caller.
 */
export class IssueArchive {
  readonly dir: string | null;
  #logger: Logger;
  #limit: number;
  #byIdentifier = new Map<string, ArchivedIssue>();
  #failing = false;

  constructor(dir: string | null, logger: Logger, limit = DEFAULT_MEMORY_LIMIT) {
    this.dir = dir;
    this.#logger = logger;
    this.#limit = limit;
  }

  fileFor(identifier: string): string | null {
    return this.dir === null ? null : path.join(this.dir, archiveFileName(identifier));
  }

  /** Stores the issue in memory and, when a directory is set, on disk (atomic replace). */
  save(issue: ArchivedIssue): void {
    this.#remember(issue);
    const file = this.fileFor(issue.issue_identifier);
    if (file === null) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(issue));
      fs.renameSync(tmp, file);
      this.#failing = false;
    } catch (error) {
      if (!this.#failing) this.#logger.warn('cannot write the issue archive', { file, error: errorMessage(error) });
      this.#failing = true;
    }
  }

  /** The archived issue for an identifier or issue id; from memory, else from disk (by identifier). Null when unknown. */
  get(key: string): ArchivedIssue | null {
    const inMemory = this.#byIdentifier.get(key);
    if (inMemory !== undefined) return inMemory;
    for (const issue of this.#byIdentifier.values()) if (issue.issue_id === key) return issue;
    const file = this.fileFor(key);
    if (file === null) return null;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    try {
      const issue = upgrade(JSON.parse(text) as Parameters<typeof upgrade>[0]);
      if (issue === null) {
        this.#logger.warn('ignoring an unreadable issue archive', { file });
        return null;
      }
      this.#remember(issue);
      return issue;
    } catch (error) {
      this.#logger.warn('ignoring an unreadable issue archive', { file, error: errorMessage(error) });
      return null;
    }
  }

  #remember(issue: ArchivedIssue): void {
    this.#byIdentifier.delete(issue.issue_identifier);
    this.#byIdentifier.set(issue.issue_identifier, issue);
    while (this.#byIdentifier.size > this.#limit) this.#byIdentifier.delete(this.#byIdentifier.keys().next().value as string);
  }
}
