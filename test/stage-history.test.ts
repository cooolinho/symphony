import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildStageHistory, type PersistedResult } from '../src/orchestrator/stage-history.ts';
import { internalResult, type ResultMeta, type StageResult } from '../src/workflow/results.ts';

let clock = 0;

function entry(
  kind: 'review' | 'test' | 'implementation' | 'reset',
  verdict: string,
  over: Partial<ResultMeta> = {},
): PersistedResult {
  const result =
    kind === 'reset'
      ? internalResult('reset', 'reset')
      : ({ schema: 'symphony.result/v1', kind, verdict, summary: 's', blockers: [], follow_ups: [] } as unknown as StageResult);
  clock += 1;
  const meta: ResultMeta = {
    role: kind === 'implementation' ? 'developer' : kind === 'test' ? 'tester' : 'reviewer',
    run: `run-${clock}`,
    round: null,
    profile: null,
    workflow_hash: null,
    head_sha: null,
    checks: null,
    target: null,
    created_at: new Date(Date.UTC(2026, 9, 18, 10, 0, clock)).toISOString(),
    ...over,
  };
  return { result, meta };
}

describe('buildStageHistory', () => {
  const cases: { name: string; build: () => PersistedResult[]; review: number; test: number }[] = [
    { name: 'empty', build: () => [], review: 0, test: 0 },
    {
      name: 'counts changes_needed and failed only',
      build: () => [entry('review', 'changes_needed'), entry('review', 'approved'), entry('test', 'failed'), entry('test', 'passed')],
      review: 1,
      test: 1,
    },
    {
      name: 'reset restarts the counters',
      build: () => [entry('review', 'changes_needed'), entry('test', 'failed'), entry('reset', 'reset'), entry('review', 'changes_needed')],
      review: 1,
      test: 0,
    },
    {
      name: 'duplicate markers of one run count once',
      build: () => [
        entry('review', 'changes_needed', { run: 'r1' }),
        entry('review', 'changes_needed', { run: 'r1' }),
        entry('review', 'changes_needed', { run: 'r2' }),
      ],
      review: 2,
      test: 0,
    },
    {
      name: 'results without a run never merge',
      build: () => [entry('review', 'changes_needed', { run: null }), entry('review', 'changes_needed', { run: null })],
      review: 2,
      test: 0,
    },
    {
      name: 'orders by created_at, not input order',
      build: () => [entry('reset', 'reset'), entry('review', 'changes_needed', { created_at: '2000-01-01T00:00:00.000Z' })],
      review: 0,
      test: 0,
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const history = buildStageHistory(c.build());
      assert.equal(history.reviewRounds, c.review);
      assert.equal(history.testRounds, c.test);
    });
  }

  it('tracks the latest result per role', () => {
    const first = entry('review', 'changes_needed');
    const second = entry('review', 'approved');
    const history = buildStageHistory([second, first, entry('implementation', 'done')]);
    assert.equal(history.latestByRole.get('reviewer'), second);
    assert.equal(history.latestByRole.get('developer')?.result.kind, 'implementation');
  });

  it('derives lastTarget and the pending transition', () => {
    const rows: { target: string | null; state: string; last: string | null; pending: string | null }[] = [
      { target: null, state: 'In progress', last: null, pending: null },
      { target: 'Agent review', state: 'Agent review', last: 'Agent review', pending: null },
      { target: 'Agent review', state: ' agent review ', last: 'Agent review', pending: null },
      { target: 'In review', state: 'Agent review', last: 'In review', pending: 'In review' },
    ];
    for (const row of rows) {
      const history = buildStageHistory([entry('review', 'approved', { target: row.target })]);
      assert.equal(history.lastTarget, row.last);
      assert.equal(history.pendingTransition(row.state), row.pending);
    }
  });

  it('forgets the target at a reset', () => {
    const history = buildStageHistory([entry('review', 'approved', { target: 'In review' }), entry('reset', 'reset')]);
    assert.equal(history.lastTarget, null);
  });
});
