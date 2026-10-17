import { normalizeStateName } from '../workflow/config.ts';
import type { ResultMeta, StageResult } from '../workflow/results.ts';

/** A persisted stage result with its meta, as read back from an issue comment marker. */
export interface PersistedResult {
  result: StageResult;
  meta: ResultMeta;
}

export interface StageHistory {
  /** Results in `created_at` order, one per run, role and kind (duplicates dropped). */
  results: PersistedResult[];
  /** The newest result of each role. */
  latestByRole: ReadonlyMap<string, PersistedResult>;
  /** Reviews with the verdict `changes_needed` since the last `reset`. */
  reviewRounds: number;
  /** Tests with the verdict `failed` since the last `reset`. */
  testRounds: number;
  /** Column the newest result that moved the issue handed it to; null when none did since the last `reset`. */
  lastTarget: string | null;
  /** The column the issue should be in but is not, or null when the board matches the history. */
  pendingTransition(issueState: string): string | null;
}

function time(entry: PersistedResult): number {
  const at = Date.parse(entry.meta.created_at);
  return Number.isNaN(at) ? 0 : at;
}

/** Oldest first; ties and unparseable timestamps keep the input order. */
function ordered(results: readonly PersistedResult[]): PersistedResult[] {
  return results
    .map((entry, index) => ({ entry, index, at: time(entry) }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map(({ entry }) => entry);
}

/** Several markers of one run (retried comments, repeated reports) count once; results without a run never merge. */
function dedupe(results: readonly PersistedResult[]): PersistedResult[] {
  const seen = new Set<string>();
  return results.filter(({ result, meta }) => {
    if (meta.run === null) return true;
    const key = JSON.stringify([meta.run, meta.role, result.kind]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Derives the round counters and the last hand-off from the persisted results of one issue, in any order. */
export function buildStageHistory(persisted: readonly PersistedResult[]): StageHistory {
  const results = dedupe(ordered(persisted));
  const latestByRole = new Map<string, PersistedResult>();
  let reviewRounds = 0;
  let testRounds = 0;
  let lastTarget: string | null = null;
  for (const entry of results) {
    latestByRole.set(entry.meta.role, entry);
    if (entry.result.kind === 'reset') {
      reviewRounds = 0;
      testRounds = 0;
      lastTarget = null;
    }
    if (entry.result.kind === 'review' && entry.result.verdict === 'changes_needed') reviewRounds += 1;
    if (entry.result.kind === 'test' && entry.result.verdict === 'failed') testRounds += 1;
    if (entry.meta.target !== null) lastTarget = entry.meta.target;
  }
  return {
    results,
    latestByRole,
    reviewRounds,
    testRounds,
    lastTarget,
    pendingTransition: (issueState) =>
      lastTarget !== null && normalizeStateName(lastTarget) !== normalizeStateName(issueState) ? lastTarget : null,
  };
}
