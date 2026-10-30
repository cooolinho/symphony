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

/** `committed`: a commit of an agent session; `merged`: the merge of the issue's pull request. Brain values follow in E6-2. */
export type ChangeStatus = 'committed' | 'merged';

/** One change Symphony saw: a commit or merge (`code`), or a change to the brain (`brain`, E6-2). */
export interface ChangeEntry {
  /** Unique: `code:<repo>:<sha>` per commit, `code:<repo>:merge:<pull request>` (without one `merge:<head sha>`) per merge. */
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
}

/** Filter and page of `ChangeStore.list`: `before` is the id of the last entry of the previous page. */
export interface ChangeFilter {
  type?: ChangeEntry['type'];
  repo?: string;
  issue?: string;
  before?: string;
  limit?: number;
}
