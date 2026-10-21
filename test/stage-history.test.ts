import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROMPT_SUMMARY_LIMIT, analysisFlagsSecurity, buildStageHistory, implementationHead, refactoringGoals, resultRows, resultsTemplateValue, type PersistedResult } from '../src/orchestrator/stage-history.ts';
import { internalResult, parseResult, type ResultMeta, type StageResult } from '../src/workflow/results.ts';

let clock = 0;

function entry(
  kind: 'review' | 'test' | 'security' | 'implementation' | 'reset',
  verdict: string,
  over: Partial<ResultMeta> = {},
): PersistedResult {
  const result =
    kind === 'reset'
      ? internalResult('reset', 'reset')
      : ({ schema: 'symphony.result/v1', kind, verdict, summary: 's', blockers: [], follow_ups: [] } as unknown as StageResult);
  clock += 1;
  const meta: ResultMeta = {
    role: kind === 'implementation' ? 'developer' : kind === 'test' ? 'tester' : kind === 'security' ? 'security-auditor' : 'reviewer',
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

  it('counts issues_found of the security review as its own rounds, and a reset clears them', () => {
    const history = buildStageHistory([
      entry('security', 'issues_found'),
      entry('review', 'changes_needed'),
      entry('security', 'passed'),
      entry('security', 'issues_found'),
      entry('security', 'blocked'),
    ]);
    assert.deepEqual([history.securityRounds, history.reviewRounds, history.testRounds], [2, 1, 0]);
    const reset = buildStageHistory([entry('security', 'issues_found'), entry('reset', 'reset'), entry('security', 'issues_found')]);
    assert.equal(reset.securityRounds, 1);
    assert.equal(buildStageHistory([entry('security', 'issues_found'), entry('reset', 'reset')]).securityRounds, 0);
    assert.equal(buildStageHistory([]).securityRounds, 0);
  });

  it('counts duplicate markers of one security run once', () => {
    const history = buildStageHistory([entry('security', 'issues_found', { run: 'r1' }), entry('security', 'issues_found', { run: 'r1' })]);
    assert.equal(history.securityRounds, 1);
  });

  it('forgets the target at a reset', () => {
    const history = buildStageHistory([entry('review', 'approved', { target: 'In review' }), entry('reset', 'reset')]);
    assert.equal(history.lastTarget, null);
  });
});

describe('implementationHead', () => {
  const head = (...entries: PersistedResult[]) => implementationHead(buildStageHistory(entries));

  it('is the head of the newest finished implementation', () => {
    assert.equal(head(entry('implementation', 'done', { head_sha: 'a'.repeat(40) }), entry('implementation', 'done', { head_sha: 'b'.repeat(40) })), 'b'.repeat(40));
  });

  it('skips implementations that recorded no head, blocked ones and the results of other roles', () => {
    assert.equal(
      head(
        entry('implementation', 'done', { head_sha: 'a'.repeat(40) }),
        entry('implementation', 'done', { head_sha: null }),
        entry('implementation', 'blocked', { head_sha: 'c'.repeat(40) }),
        entry('test', 'failed', { head_sha: 'd'.repeat(40) }),
        entry('review', 'changes_needed', { head_sha: 'e'.repeat(40) }),
      ),
      'a'.repeat(40),
    );
  });

  it('is null without a finished implementation', () => {
    assert.equal(head(), null);
    assert.equal(head(entry('implementation', 'done', { head_sha: null }), entry('review', 'approved', { head_sha: 'a'.repeat(40) })), null);
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

describe('resultsTemplateValue: the analysis for the later stages', () => {
  function analysed(input: Record<string, unknown>): PersistedResult {
    const parsed = parseResult('analysis', input);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
    clock += 1;
    return {
      result: parsed.result,
      meta: {
        role: 'issue-analyst',
        run: `run-${clock}`,
        round: null,
        profile: null,
        workflow_hash: null,
        head_sha: null,
        checks: null,
        target: 'In progress',
        created_at: new Date(Date.UTC(2026, 9, 18, 10, 0, clock)).toISOString(),
      },
    };
  }
  const READY = {
    verdict: 'ready',
    summary: 'One component.',
    type: 'feature',
    complexity: 'M',
    components: ['src/invoices'],
    acceptance_criteria: ['Lists every invoice'],
    risks: { security: false, data_migration: true, breaking_change: true },
    docs_needed: true,
    plan: ['Add the exporter', 'Test it'],
  };

  it('hands the newest analysis on: criteria, components, risks that apply, docs and plan', () => {
    const value = resultsTemplateValue(buildStageHistory([analysed({ verdict: 'needs_info', summary: 'Unclear.', open_questions: ['Which format?'] }), analysed(READY)]));
    assert.deepEqual(value.analysis, {
      verdict: 'ready',
      summary: 'One component.',
      type: 'feature',
      complexity: 'M',
      components: ['src/invoices'],
      acceptance_criteria: ['Lists every invoice'],
      risks: ['data migration', 'breaking change'],
      docs_needed: true,
      open_questions: [],
      plan: ['Add the exporter', 'Test it'],
      refactoring_goals: [],
    });
  });

  it('hands the refactoring goals of the newest analysis on, and none without an analysis or goals in the newest one', () => {
    const goals = ['The parsing code exists once', 'No public signature changes'];
    const history = buildStageHistory([analysed({ ...READY, type: 'refactor', refactoring_goals: goals })]);
    assert.deepEqual(resultsTemplateValue(history).analysis?.refactoring_goals, goals);
    assert.deepEqual(refactoringGoals(history), goals);
    assert.deepEqual(refactoringGoals(buildStageHistory([analysed({ ...READY, refactoring_goals: goals }), analysed({ ...READY })])), []);
    assert.deepEqual(refactoringGoals(buildStageHistory([])), []);
    assert.deepEqual(refactoringGoals({}), []);
  });

  it('is empty without an analysis, and forgets it at a reset', () => {
    assert.equal(resultsTemplateValue(buildStageHistory([])).analysis, null);
    assert.equal(resultsTemplateValue(buildStageHistory([analysed(READY), entry('reset', 'reset')])).analysis, null);
  });

  it('leaves out what the analysis did not report', () => {
    const value = resultsTemplateValue(buildStageHistory([analysed({ verdict: 'ready', summary: 'Small.' })]));
    assert.deepEqual([value.analysis?.type, value.analysis?.complexity, value.analysis?.docs_needed, value.analysis?.risks, value.analysis?.plan], [null, null, null, [], []]);
  });
});

describe('resultsTemplateValue: the security findings for the developer', () => {
  function audited(input: Record<string, unknown>): PersistedResult {
    const parsed = parseResult('security', input);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
    clock += 1;
    return {
      result: parsed.result,
      meta: {
        role: 'security-auditor',
        run: `run-${clock}`,
        round: 1,
        profile: null,
        workflow_hash: null,
        head_sha: null,
        checks: null,
        target: 'In progress',
        created_at: new Date(Date.UTC(2026, 9, 18, 10, 0, clock)).toISOString(),
      },
    };
  }
  const FOUND = {
    verdict: 'issues_found',
    summary: 'The policy is bypassed.',
    findings: [{ severity: 'blocker', file: 'app/Policies/PostPolicy.php', line: 12, problem: 'Any user may update', fix: 'Compare the owner' }, { severity: 'nit', problem: 'Naming' }],
  };

  it('lists the findings of the newest security review while it found issues', () => {
    const value = resultsTemplateValue(buildStageHistory([audited(FOUND)]));
    assert.deepEqual(value.security_findings, [
      { severity: 'blocker', file: 'app/Policies/PostPolicy.php', line: 12, problem: 'Any user may update', fix: 'Compare the owner' },
      { severity: 'nit', file: null, line: null, problem: 'Naming', fix: null },
    ]);
    assert.deepEqual(value.open_findings, [], 'the review findings are a separate list');
  });

  it('is empty after a pass, without a security review, and after a reset', () => {
    assert.deepEqual(resultsTemplateValue(buildStageHistory([audited(FOUND), audited({ verdict: 'passed', summary: 'Fixed.' })])).security_findings, []);
    assert.deepEqual(resultsTemplateValue(buildStageHistory([])).security_findings, []);
    assert.deepEqual(resultsTemplateValue(buildStageHistory([audited(FOUND), entry('reset', 'reset')])).security_findings, []);
  });

  it('shows the security review among the latest results', () => {
    const latest = resultsTemplateValue(buildStageHistory([audited(FOUND)])).latest;
    assert.deepEqual(latest.map((item) => [item.role, item.kind, item.verdict]), [['security-auditor', 'security', 'issues_found']]);
  });
});

describe('analysisFlagsSecurity', () => {
  function analysed(security: boolean | undefined): PersistedResult {
    const parsed = parseResult('analysis', { verdict: 'ready', summary: 'x', ...(security === undefined ? {} : { risks: { security } }) });
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
    clock += 1;
    return {
      result: parsed.result,
      meta: { role: 'issue-analyst', run: `run-${clock}`, round: null, profile: null, workflow_hash: null, head_sha: null, checks: null, target: null, created_at: new Date(Date.UTC(2026, 9, 18, 10, 0, clock)).toISOString() },
    };
  }

  it('reads risks.security of the newest analysis since the last reset', () => {
    assert.equal(analysisFlagsSecurity(buildStageHistory([analysed(true)])), true);
    assert.equal(analysisFlagsSecurity(buildStageHistory([analysed(true), analysed(false)])), false, 'the newest analysis wins');
    assert.equal(analysisFlagsSecurity(buildStageHistory([analysed(false), analysed(true)])), true);
    assert.equal(analysisFlagsSecurity(buildStageHistory([analysed(undefined)])), false);
    assert.equal(analysisFlagsSecurity(buildStageHistory([analysed(true), entry('reset', 'reset')])), false);
    assert.equal(analysisFlagsSecurity(buildStageHistory([])), false);
  });
});

describe('resultsTemplateValue: the design for the developer', () => {
  function designed(input: Record<string, unknown>): PersistedResult {
    const parsed = parseResult('design', input);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
    clock += 1;
    return {
      result: parsed.result,
      meta: {
        role: 'architect',
        run: `run-${clock}`,
        round: null,
        profile: null,
        workflow_hash: null,
        head_sha: null,
        checks: null,
        target: 'In progress',
        created_at: new Date(Date.UTC(2026, 9, 18, 10, 0, clock)).toISOString(),
      },
    };
  }
  const READY = {
    verdict: 'ready',
    summary: 'Extend the exporter.',
    options: ['New service', 'Extend the exporter'],
    decision: 'Extend the exporter',
    components: ['InvoiceExporter: writes the CSV'],
    interfaces: ['exportInvoices(list): string'],
    migrations: ['add invoices.exported_at'],
    compatibility: 'Existing exports are unchanged',
  };

  it('hands the newest design on: decision, components, interfaces, migrations, compatibility and options', () => {
    const value = resultsTemplateValue(buildStageHistory([designed({ verdict: 'blocked', summary: 'Open.', blockers: [{ description: 'Which database?', needs: 'human' }] }), designed(READY)]));
    assert.deepEqual(value.design, {
      verdict: 'ready',
      summary: 'Extend the exporter.',
      decision: 'Extend the exporter',
      components: ['InvoiceExporter: writes the CSV'],
      interfaces: ['exportInvoices(list): string'],
      migrations: ['add invoices.exported_at'],
      compatibility: 'Existing exports are unchanged',
      options: ['New service', 'Extend the exporter'],
      work_packages: [],
      head_sha: null,
    });
  });

  it('is empty without a design, and forgets it at a reset', () => {
    assert.equal(resultsTemplateValue(buildStageHistory([])).design, null);
    assert.equal(resultsTemplateValue(buildStageHistory([designed(READY), entry('reset', 'reset')])).design, null);
  });
});

describe('resultRows: the rows of the agent page', () => {
  it('carry the comment link, the findings of a review and the blockers of a blocked result', () => {
    const review = parseResult('review', { verdict: 'changes_needed', summary: 'Fix it.', findings: [{ severity: 'major', file: 'src/a.ts', line: 7, problem: 'Wrong', fix: 'Right' }, { severity: 'nit', problem: 'Typo' }] });
    const blocked = parseResult('implementation', { verdict: 'blocked', summary: 'Stuck.', blockers: [{ description: 'No token', needs: 'access' }] });
    assert.ok(review.ok && blocked.ok);
    const first = entry('review', 'approved');
    const rows = resultRows([
      { ...first, result: review.result, url: 'https://github.com/acme/app/issues/1#issuecomment-1' },
      { ...entry('implementation', 'done'), result: blocked.result },
    ]);
    assert.deepEqual(rows[0]?.findings, [
      { severity: 'major', file: 'src/a.ts', line: 7, problem: 'Wrong', fix: 'Right' },
      { severity: 'nit', file: null, line: null, problem: 'Typo', fix: null },
    ]);
    assert.equal(rows[0]?.url, 'https://github.com/acme/app/issues/1#issuecomment-1');
    assert.deepEqual([rows[1]?.url, rows[1]?.findings, rows[1]?.blockers], [null, [], [{ description: 'No token', needs: 'access' }]]);
  });
});
