import { truncate } from '../util/text.ts';
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

/** Upper bound for a summary in the prompt's `results.latest`; the full text stays in the issue comment. */
export const PROMPT_SUMMARY_LIMIT = 1500;

/** The `results` prompt variable: what a session needs from the stage history, compact. */
export interface ResultsTemplateValue {
  /** The newest result of each role, oldest first. */
  latest: Array<{
    role: string;
    kind: string;
    verdict: string;
    summary: string;
    round: number | null;
    target: string | null;
    created_at: string;
  }>;
  /** Findings of the newest review when it asked for changes; empty after an approval or without a review. */
  open_findings: Array<{ severity: string; file: string | null; line: number | null; problem: string; fix: string | null }>;
  /** Failed cases of the newest test when it failed; empty otherwise. */
  failed_cases: Array<{ criterion: string; test: string }>;
  /**
   * The newest test since the last reset, whatever its verdict; null without one. Its summary says why the failed cases
   * failed, its commands how to run the tests again.
   */
  test: { verdict: string; summary: string; round: number | null; commands: string[] } | null;
}

/** The newest result of a kind since the last `reset`. */
function newest(history: StageHistory, kind: string): PersistedResult | undefined {
  for (let i = history.results.length - 1; i >= 0; i--) {
    const entry = history.results[i] as PersistedResult;
    if (entry.result.kind === 'reset') return undefined;
    if (entry.result.kind === kind) return entry;
  }
  return undefined;
}

/** The prompt view of a stage history (the `results` variable). */
export function resultsTemplateValue(history: StageHistory): ResultsTemplateValue {
  const review = newest(history, 'review')?.result;
  const testEntry = newest(history, 'test');
  const test = testEntry?.result;
  return {
    latest: [...history.latestByRole.values()]
      .filter(({ result }) => result.kind !== 'reset')
      .map((entry) => ({
        role: entry.meta.role,
        kind: entry.result.kind,
        verdict: entry.result.verdict,
        summary: truncate(entry.result.summary, PROMPT_SUMMARY_LIMIT),
        round: entry.meta.round,
        target: entry.meta.target,
        created_at: entry.meta.created_at,
      })),
    open_findings:
      review?.kind === 'review' && review.verdict === 'changes_needed'
        ? review.findings.map((finding) => ({
            severity: finding.severity,
            file: finding.file ?? null,
            line: finding.line ?? null,
            problem: finding.problem,
            fix: finding.fix ?? null,
          }))
        : [],
    failed_cases:
      test?.kind === 'test' && test.verdict === 'failed'
        ? test.cases.filter((c) => c.status === 'failed').map((c) => ({ criterion: c.criterion, test: c.test }))
        : [],
    test:
      test?.kind === 'test'
        ? { verdict: test.verdict, summary: truncate(test.summary, PROMPT_SUMMARY_LIMIT), round: testEntry?.meta.round ?? null, commands: test.commands }
        : null,
  };
}

/** One persisted result as `GET /api/v1/<id>` and the issue archive show it: the envelope without the kind-specific fields. */
export interface ResultRow {
  role: string;
  run: string | null;
  kind: string;
  verdict: string;
  summary: string;
  round: number | null;
  target: string | null;
  head_sha: string | null;
  created_at: string;
}

/** The results as JSON rows, deduplicated and oldest first; the full result stays in the issue comment. */
export function resultRows(results: readonly PersistedResult[]): ResultRow[] {
  return buildStageHistory(results).results.map(({ result, meta }) => ({
    role: meta.role,
    run: meta.run,
    kind: result.kind,
    verdict: result.verdict,
    summary: truncate(result.summary, PROMPT_SUMMARY_LIMIT),
    round: meta.round,
    target: meta.target,
    head_sha: meta.head_sha,
    created_at: meta.created_at,
  }));
}
