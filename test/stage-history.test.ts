import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROMPT_SUMMARY_LIMIT, buildStageHistory, resultsTemplateValue, type PersistedResult } from '../src/orchestrator/stage-history.ts';
import { internalResult, parseResult, type ResultMeta, type StageResult } from '../src/workflow/results.ts';

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

describe('resultsTemplateValue: the test result for the developer and the test engineer', () => {
  /** A persisted test result as `report_result` records it. */
  function tested(input: Record<string, unknown>, over: Partial<ResultMeta> = {}): PersistedResult {
    const parsed = parseResult('test', input);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
    clock += 1;
    return {
      result: parsed.result,
      meta: {
        role: 'test-engineer',
        run: `run-${clock}`,
        round: 1,
        profile: null,
        workflow_hash: null,
        head_sha: null,
        checks: null,
        target: 'In progress',
        created_at: new Date(Date.UTC(2026, 9, 18, 10, 0, clock)).toISOString(),
        ...over,
      },
    };
  }
  const FAILED = {
    verdict: 'failed',
    summary: 'The total ignores discounts.',
    cases: [
      { criterion: 'Totals add up', test: 'tests/TotalTest.php::adds', status: 'passed' },
      { criterion: 'A discount lowers the total', test: 'tests/TotalTest.php::discount', status: 'failed' },
    ],
    commands: ['php artisan test --filter=Total'],
  };
  const PASSED = { verdict: 'passed', summary: 'All good.', cases: [{ criterion: 'A discount lowers the total', test: 'tests/TotalTest.php::discount', status: 'passed' }] };

  it('hands a failed test to the developer: the failed cases, the summary, the commands and the round', () => {
    const value = resultsTemplateValue(buildStageHistory([tested(FAILED)]));
    assert.deepEqual(value.failed_cases, [{ criterion: 'A discount lowers the total', test: 'tests/TotalTest.php::discount' }]);
    assert.deepEqual(value.test, { verdict: 'failed', summary: 'The total ignores discounts.', round: 1, commands: ['php artisan test --filter=Total'] });
    assert.deepEqual(value.latest.map((latest) => [latest.role, latest.kind, latest.verdict]), [['test-engineer', 'test', 'failed']]);
  });

  it('has no failed cases after a passing run, but still the test result', () => {
    const value = resultsTemplateValue(buildStageHistory([tested(FAILED), tested(PASSED, { round: 2, target: 'Agent review' })]));
    assert.deepEqual(value.failed_cases, []);
    assert.deepEqual([value.test?.verdict, value.test?.round], ['passed', 2]);
  });

  it('is empty without a test, and forgets it at a reset', () => {
    assert.equal(resultsTemplateValue(buildStageHistory([])).test, null);
    assert.equal(resultsTemplateValue(buildStageHistory([entry('review', 'approved')])).test, null);
    const reset = resultsTemplateValue(buildStageHistory([tested(FAILED), entry('reset', 'reset')]));
    assert.deepEqual([reset.test, reset.failed_cases], [null, []]);
  });

  it('cuts a long summary like the other prompt summaries', () => {
    const value = resultsTemplateValue(buildStageHistory([tested({ ...FAILED, summary: 'x'.repeat(3000) })]));
    assert.equal(value.test?.summary.length, PROMPT_SUMMARY_LIMIT);
  });
});
