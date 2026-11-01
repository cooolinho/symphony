import type { FileStat } from '../workspace/changes.ts';

/** Entries loaded per repository at startup and kept in memory per repository. */
export const CHANGES_LOAD_LIMIT = 500;
/** Upper bound of one page of `ChangeStore.list`. */
export const CHANGES_PAGE_LIMIT = 200;
/** Page size of `ChangeStore.list` without `limit`. */
export const CHANGES_PAGE_DEFAULT = 50;

/** One changed file: lines added and deleted (null for a binary file) and how it changed. */
export type ChangeFile = FileStat;

/** The pull request of the change and the state of its checks. */
export interface ChangePullRequest {
  number: number;
  status: 'none' | 'pending' | 'success' | 'failure';
}

/**
 * `committed`: a commit of an agent session; `merged`: the merge of the issue's pull request. Brain values: `created`,
 * `updated`, `approved` (subject `approve:`), `rejected_candidate` (subject `reject:`), `human` (Obsidian commit) and
 * `conflict` (a rejected write).
 */
export type ChangeStatus = 'committed' | 'merged' | 'created' | 'updated' | 'approved' | 'rejected_candidate' | 'human' | 'conflict';

/** One change Symphony saw: a commit or merge (`code`), or a change to the brain (`brain`). */
export interface ChangeEntry {
  /**
   * Unique: `code:<repo>:<sha>` per commit, `code:<repo>:merge:<pull request>` (without one `code:<repo>:merge:<issue>:<at>`)
   * per merge, `brain:<sha>:<path>` per path of a vault commit, `brain:conflict:<clash id>` per rejected write.
   */
  id: string;
  type: 'code' | 'brain';
  /** ISO timestamp (UTC). */
  at: string;
  /** `owner/name`, or `unknown`. */
  repo: string;
  /** Issue identifier (`owner/name#123`). */
  issue: string;
  role: string;
  title: string;
  files: ChangeFile[];
  pr: ChangePullRequest | null;
  /** At most 5 changed lines per file; null when there is no excerpt. */
  diff: string | null;
  status: ChangeStatus;
  /** Brain: the run of the write (of the rejected write for `conflict`). */
  run?: string | null;
  /** Brain `conflict` only: `hash_mismatch` or `window`. */
  reason?: string;
  /** Brain `conflict` only: the clash of the access log. */
  clash_id?: string;
  /** Code: the branch of the commit or merge. Absent in entries recorded before the field existed. */
  branch?: string | null;
  /** Brain: the `status` of the note's frontmatter (as of the commit; of the current note for `conflict`). */
  note_status?: string | null;
  /** Brain `conflict` only: role and time of the earlier writer of the clash. */
  other_role?: string | null;
  other_at?: string | null;
  /** Brain `conflict` only, added when the page is built (never stored): state of the clash; null when it is no longer known. */
  clash_status?: 'open' | 'resolved' | null;
}

/** Filter and page of `ChangeStore.list`: `before` is the id of the last entry of the previous page. */
export interface ChangeFilter {
  type?: ChangeEntry['type'];
  repo?: string;
  issue?: string;
  before?: string;
  limit?: number;
}

/** Entries per type of everything matching `repo` and `issue`. */
export interface ChangeCounts {
  all: number;
  code: number;
  brain: number;
}

/** A file changed often in the last 7 days. */
export interface ChangeHotspot {
  path: string;
  repo: string;
  count: number;
}

/** A note changed often in the last 7 days: `count` changes, `clashes` rejected writes. */
export interface ChangeNoteHotspot {
  path: string;
  count: number;
  clashes: number;
}

/** "Today in numbers" and the hotspots of the last 7 days. */
export interface ChangeStats {
  /** `brain`: brain writes of the day (conflicts, i.e. rejected writes, excluded). */
  today: { commits: number; merges: number; files: number; added: number; deleted: number; brain: number };
  hotspots: ChangeHotspot[];
  /** Rejected writes whose clash is still open (any day). */
  conflicts_open: number;
  /** Notes with the most brain changes of the last 7 days. */
  note_hotspots: ChangeNoteHotspot[];
}

/** Query of one page of the feed. */
export type ChangesQuery = ChangeFilter;

/** One page of the feed (`GET /api/v1/changes`). */
export interface ChangesPage {
  entries: ChangeEntry[];
  /** Id of the last entry of `entries` when another page follows, else null. */
  next_before: string | null;
  counts: ChangeCounts;
  /** Only on the first page (no `before`), else null. */
  stats: ChangeStats | null;
}
