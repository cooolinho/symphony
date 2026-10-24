import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ROOT, STATUS } from '../scripts/e2e/context.ts';
import {
  BUGFIX_PROFILE,
  COST_CEILING_USD,
  PIPELINE_COLUMNS,
  PIPELINE_FILES,
  PIPELINE_MARKER,
  PIPELINE_ROLE,
  PIPELINE_SCENARIO,
  PIPELINE_STATUS,
  pipelineConfigProblems,
  pipelineIssueBody,
  pipelineWorkflow,
  resultLabel,
} from '../scripts/e2e/pipeline.ts';
import { MODEL } from '../scripts/e2e/scenario.ts';
import { costByRole, pipelineRuns, verifyPipeline, type PipelineData, type PipelineResult } from '../scripts/e2e/verify-pipeline.ts';
import { observedPath, type TimelineEntry } from '../scripts/e2e/verify-roles.ts';
import { effectiveAgentLimits, NO_LIMIT_OVERRIDE, slotProblems } from '../src/orchestrator/limits.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { resolveConfig, type ServiceConfig } from '../src/workflow/config.ts';
import { parseWorkflow } from '../src/workflow/loader.ts';
import type { EffectiveWorkflow } from '../src/workflow/store.ts';
import { compilePrompt, renderPrompt } from '../src/workflow/template.ts';
import { nextStageProblems, unknownBoardColumns, validateDispatch } from '../src/workflow/validate.ts';
import { makeIssue, tempDir } from './helpers.ts';

const REPO = 'acme/e2e';
const ISSUES = [
  { key: 'P1', number: 21 },
  { key: 'P2', number: 22 },
  { key: 'P3', number: 23 },
];
const BOARD = ['Backlog', 'Ready', 'Design', 'In progress', 'Testing', 'Documentation', 'Agent review', 'Security review', 'Blocked', 'In review', 'Done'];

type Step = [kind: string, verdict: string, round: number | null, summary: string];

/** The results of the three issues as the issue texts ask for them, in the order the board records them. */
const FLOW: Record<string, Step[]> = {
  P1: [
    ['analysis', 'ready', null, 'E2E run P1 analyzed'],
    ['implementation', 'done', null, 'E2E run P1 developed'],
    ['test', 'failed', 1, 'E2E run P1 test failed'],
    ['implementation', 'done', null, 'E2E run P1 developed'],
    ['test', 'passed', 2, 'E2E run P1 test passed'],
    ['review', 'approved', 1, 'E2E run P1 approved'],
  ],
  P2: [
    ['analysis', 'ready', null, 'E2E run P2 analyzed'],
    ['implementation', 'done', null, 'E2E run P2 developed'],
    ['test', 'passed', 1, 'E2E run P2 test passed'],
    ['review', 'changes_needed', 1, 'E2E run P2 rejected'],
    ['implementation', 'done', null, 'E2E run P2 developed'],
    ['test', 'passed', 1, 'E2E run P2 test passed'],
    ['review', 'approved', 2, 'E2E run P2 approved'],
  ],
  P3: [['analysis', 'needs_info', null, 'E2E run P3 needs info']],
};

const ROLE_OF: Record<string, string> = { analysis: 'issue-analyst', implementation: 'developer', test: 'test-engineer', review: 'reviewer' };
const TARGET_OF: Record<string, string> = {
  'analysis:ready': 'In progress',
  'analysis:needs_info': 'Blocked',
  'implementation:done': 'Testing',
  'test:failed': 'In progress',
  'test:passed': 'Agent review',
  'review:changes_needed': 'In progress',
  'review:approved': 'In review',
};
const STATE_OF: Record<string, string> = { analysis: 'Ready', implementation: 'In progress', test: 'Testing', review: 'Agent review' };

/** Minutes after 10:00 UTC as an ISO timestamp. */
const at = (minute: number) => new Date(Date.UTC(2026, 9, 5, 10, 0, minute * 60)).toISOString();

function line(minute: number, event: string, fields: Record<string, string | number | boolean>): string {
  const pairs = Object.entries(fields).map(([key, value]) => `${key}=${typeof value === 'string' && /[\s"]/.test(value) ? JSON.stringify(value) : value}`);
  return [`ts=${at(minute)}`, `event=${event}`, `repo=${REPO}`, ...pairs].join(' ');
}

const started = (minute: number, number: number, run: string, role: string, state: string, model = 'sonnet') =>
  line(minute, 'run_started', { issue: `${REPO}#${number}`, run, title: 'E2E run', state, attempt: 'null', model, role });

const finished = (minute: number, number: number, run: string, role: string, outcome = 'handed_off', overrides: Record<string, string | number> = {}) =>
  line(minute, 'run_finished', {
    issue: `${REPO}#${number}`,
    run,
    outcome,
    role,
    state: 'x',
    reason: 'handed off',
    turns: 2,
    model: 'claude-sonnet-5-5',
    cost_usd: 0.1,
    started_at: at(minute - 1),
    ...overrides,
  });

const stageResult = (minute: number, number: number, run: string, step: Step) =>
  line(minute, 'stage_result', {
    issue: `${REPO}#${number}`,
    run,
    role: ROLE_OF[step[0]] as string,
    kind: step[0],
    verdict: step[1],
    ...(step[2] === null ? {} : { round: step[2] }),
    target: TARGET_OF[`${step[0]}:${step[1]}`] as string,
    ...(step[0] === 'analysis' ? {} : { profile: 'bugfix' }),
  });

const runId = (key: string, index: number) => `${key.toLowerCase()}-${index}`;

/** A recorded run in which everything went as planned: every result came from its own session, which handed off. */
function passingLog(): string[] {
  return ISSUES.flatMap(({ key, number }, issueIndex) =>
    (FLOW[key] as Step[]).flatMap((step, index) => {
      const minute = issueIndex + index * 2;
      const run = runId(key, index);
      return [
        started(minute, number, run, ROLE_OF[step[0]] as string, STATE_OF[step[0]] as string),
        stageResult(minute + 1, number, run, step),
        finished(minute + 1, number, run, ROLE_OF[step[0]] as string),
      ];
    }),
  );
}

function timeline(paths: Record<number, Array<string | null>>): TimelineEntry[] {
  return Object.entries(paths).flatMap(([number, statuses]) => statuses.map((status, index) => ({ at: at(index), number: Number(number), status })));
}

function passingTimeline(): TimelineEntry[] {
  return timeline({
    21: [null, 'Ready', 'Ready', 'In progress', 'Testing', 'In progress', 'In progress', 'Testing', 'Agent review', 'In review'],
    22: ['Ready', 'In progress', 'Testing', 'Agent review', 'In progress', 'Testing', 'Agent review', 'Agent review', 'In review'],
    23: ['Ready', 'Blocked'],
  });
}

/** The results `report_result` recorded in a run that followed the pipeline. */
function passingResults(): PipelineResult[] {
  return ISSUES.flatMap(({ key, number }) =>
    (FLOW[key] as Step[]).map(([kind, verdict, round, summary], index) => ({
      number,
      kind,
      verdict,
      summary: `${summary}\n\nWhat the stage found.`,
      role: ROLE_OF[kind] as string,
      run: runId(key, index),
      round,
      profile: kind === 'analysis' ? null : BUGFIX_PROFILE,
      target: TARGET_OF[`${kind}:${verdict}`] as string,
      openQuestions: verdict === 'needs_info' ? 1 : 0,
    })),
  );
}

function data(overrides: Partial<PipelineData> = {}): PipelineData {
  return {
    issues: ISSUES,
    historyLines: passingLog(),
    timeline: passingTimeline(),
    results: passingResults(),
    labels: { 21: ['model: sonnet', 'type: bugfix', 'complexity: s'], 22: ['model: sonnet', 'type: bugfix', 'complexity: s'], 23: ['model: sonnet'] },
    maxReviewRounds: 3,
    maxTestRounds: 2,
    limitLabel: 'needs-human',
    costCeilingUsd: COST_CEILING_USD,
    ...overrides,
  };
}

function failed(input: PipelineData): Record<string, string> {
  return Object.fromEntries(verifyPipeline(input).filter((c) => !c.ok).map((c) => [c.name, c.detail]));
}

/** The results of one issue replaced by `steps` (summary, kind, verdict, round and the rest as in the passing run). */
function withResults(number: number, edit: (own: PipelineResult[]) => PipelineResult[]): PipelineResult[] {
  return [...passingResults().filter((result) => result.number !== number), ...edit(passingResults().filter((result) => result.number === number))];
}

const NAMES = {
  path: 'Status path per issue',
  done: `No issue reached "${STATUS.done}"`,
  results: 'Stage results per issue (report_result)',
  markers: 'Markers in the result summaries',
  rounds: 'Rounds (results and stage_result lines agree, no round limit hit)',
  profile: 'Workflow profile of the bug issues',
  blocked: `Blocked analysis stops at "${PIPELINE_STATUS.blocked}"`,
  order: 'Sessions that handed off, in stage order',
  last: 'Last session handed off, none failed or stalled',
  roleCost: 'Every role ran and cost something',
  model: `Every run used ${MODEL}`,
  total: `Total cost below ${COST_CEILING_USD} USD`,
};

describe('e2e pipeline verification', () => {
  it('passes a recorded run that followed the pipeline', () => {
    const checks = verifyPipeline(data());
    assert.deepEqual(checks.filter((c) => !c.ok), []);
    assert.deepEqual(checks.map((c) => c.name), Object.values(NAMES));
    assert.match(checks.find((c) => c.name === NAMES.total)?.detail ?? '', /1\.4000 USD in 14 sessions/);
    assert.match(checks.find((c) => c.name === NAMES.path)?.detail ?? '', /P3: Blocked/);
  });

  it('derives the path from the timeline, without repeats and the start status', () => {
    assert.deepEqual(observedPath(passingTimeline(), 21), ['In progress', 'Testing', 'In progress', 'Testing', 'Agent review', 'In review']);
    assert.deepEqual(observedPath(passingTimeline(), 22), ['In progress', 'Testing', 'Agent review', 'In progress', 'Testing', 'Agent review', 'In review']);
    assert.deepEqual(observedPath(passingTimeline(), 23), ['Blocked']);
  });

  it('fails P1 without the failed test round', () => {
    const results = withResults(21, (own) => own.filter((result) => !(result.kind === 'test' && result.verdict === 'failed')).filter((_, index) => index !== 2));
    const recorded = timeline({
      21: ['Ready', 'In progress', 'Testing', 'Agent review', 'In review'],
      22: ['Ready', 'In progress', 'Testing', 'Agent review', 'In progress', 'Testing', 'Agent review', 'In review'],
      23: ['Ready', 'Blocked'],
    });
    const problems = failed(data({ results, timeline: recorded }));
    assert.match(problems[NAMES.path] ?? '', /P1: In progress → Testing → Agent review → In review, expected In progress → Testing → In progress → Testing → Agent review → In review/);
    assert.match(problems[NAMES.results] ?? '', /P1: analysis:ready, implementation:done, test:passed, review:approved, expected analysis:ready, implementation:done, test:failed,/);
    assert.doesNotMatch(problems[NAMES.results] ?? '', /P2|P3/);
  });

  it('fails P2 without the changes_needed review', () => {
    const results = withResults(22, (own) => own.filter((result) => result.verdict !== 'changes_needed' && result.round !== 2).slice(0, 4));
    const recorded = timeline({
      21: ['Ready', 'In progress', 'Testing', 'In progress', 'Testing', 'Agent review', 'In review'],
      22: ['Ready', 'In progress', 'Testing', 'Agent review', 'In review'],
      23: ['Ready', 'Blocked'],
    });
    const problems = failed(data({ results, timeline: recorded }));
    assert.match(problems[NAMES.path] ?? '', /P2: In progress → Testing → Agent review → In review, expected In progress → Testing → Agent review → In progress/);
    assert.match(problems[NAMES.results] ?? '', /P2: analysis:ready, implementation:done, test:passed, implementation:done, expected .*review:changes_needed.*review:approved/);
    assert.doesNotMatch(problems[NAMES.results] ?? '', /P1|P3/);
  });

  it('fails P3 when it continues past Blocked', () => {
    const results = [...passingResults(), { ...(passingResults().find((result) => result.number === 21 && result.kind === 'implementation') as PipelineResult), number: 23 }];
    const log = [...passingLog(), started(30, 23, 'p3-late', 'developer', 'In progress'), finished(31, 23, 'p3-late', 'developer')];
    const recorded = [...passingTimeline(), { at: at(30), number: 23, status: 'In progress' }, { at: at(31), number: 23, status: 'Testing' }];
    const problems = failed(data({ results, historyLines: log, timeline: recorded }));
    assert.match(problems[NAMES.blocked] ?? '', /P3: 1 result\(s\) after the analysis/);
    assert.match(problems[NAMES.blocked] ?? '', /P3: sessions issue-analyst, developer, expected issue-analyst only/);
    assert.match(problems[NAMES.blocked] ?? '', /P3: also in In progress, Testing/);
    assert.match(problems[NAMES.path] ?? '', /P3: Blocked → In progress → Testing, expected Blocked/);
    assert.match(problems[NAMES.results] ?? '', /P3: analysis:needs_info, implementation:done, expected analysis:needs_info/);
  });

  it('fails P3 without an open question or a hand-over to Blocked', () => {
    const results = withResults(23, (own) => own.map((result) => ({ ...result, openQuestions: 0, target: 'In progress' })));
    const detail = failed(data({ results }))[NAMES.blocked] ?? '';
    assert.match(detail, /P3: the analysis carries no open question/);
    assert.match(detail, /P3: the analysis handed over to In progress/);
  });

  it('fails when P3 is not blocked by its analysis', () => {
    const results = withResults(23, (own) => own.map((result) => ({ ...result, verdict: 'ready' })));
    assert.match(failed(data({ results }))[NAMES.blocked] ?? '', /P3: no analysis:needs_info result/);
  });

  it('fails when an issue reached Done, or was never seen', () => {
    const recorded = [...passingTimeline(), { at: at(40), number: 22, status: 'Done' }];
    assert.equal(failed(data({ timeline: recorded }))[NAMES.done], 'in "Done": P2');
    assert.equal(failed(data({ timeline: passingTimeline().filter((entry) => entry.number !== 23) }))[NAMES.done], 'never observed on the board: P3');
  });

  it('fails when an issue took another path or did not end in In review', () => {
    const problems = failed(
      data({
        timeline: timeline({
          21: ['Ready', 'In progress', 'Agent review', 'In review'],
          22: ['Ready', 'In progress', 'Testing', 'Agent review', 'In progress', 'Testing', 'Agent review'],
          23: ['Ready', 'In progress', 'Blocked'],
        }),
      }),
    );
    const detail = problems[NAMES.path] ?? '';
    assert.match(detail, /P1: In progress → Agent review → In review, expected/);
    assert.match(detail, /P2: In progress → Testing → Agent review → In progress → Testing → Agent review, expected .*→ In review/);
    assert.match(detail, /P3: In progress → Blocked, expected Blocked/);
  });

  it('fails when the results come in the wrong order', () => {
    const results = withResults(21, (own) => [own[0], own[2], own[1], ...own.slice(3)] as PipelineResult[]);
    assert.match(failed(data({ results }))[NAMES.results] ?? '', /P1: analysis:ready, test:failed, implementation:done, implementation:done, test:passed, review:approved, expected analysis:ready, implementation:done, test:failed/);
  });

  it('fails when a marker is missing from the summaries', () => {
    const results = passingResults().map((result) => (result.number === 22 && result.verdict === 'approved' ? { ...result, summary: 'Looks good to me.' } : result));
    const problems = failed(data({ results }));
    assert.equal(problems[NAMES.markers], 'P2: no review:approved result with "E2E run P2 approved"');
    assert.equal(problems[NAMES.results], undefined);
  });

  it('fails a marker that belongs to another issue', () => {
    const results = passingResults().map((result) => (result.number === 21 && result.kind === 'analysis' ? { ...result, summary: 'E2E run P2 analyzed' } : result));
    assert.equal(failed(data({ results }))[NAMES.markers], 'P1: no analysis:ready result with "E2E run P1 analyzed"');
  });

  it('fails when the result meta and the stage_result lines disagree on a round', () => {
    const log = passingLog().map((entry) => (entry.includes('run=p1-4') && entry.includes('event=stage_result') ? entry.replace('round=2', 'round=1') : entry));
    const detail = failed(data({ historyLines: log }))[NAMES.rounds] ?? '';
    assert.match(detail, /P1: stage_result lines .*test:passed:1.* differ from the results .*test:passed:2/);
    assert.doesNotMatch(detail, /P2|P3/);
  });

  it('fails when a result carries the wrong round', () => {
    const results = passingResults().map((result) => (result.number === 22 && result.verdict === 'approved' ? { ...result, round: 1 } : result));
    assert.match(failed(data({ results }))[NAMES.rounds] ?? '', /P2: result rounds .*review:approved:1, expected .*review:approved:2/);
  });

  it('fails when a stage_result line is missing', () => {
    const log = passingLog().filter((entry) => !(entry.includes('event=stage_result') && entry.includes('run=p2-3')));
    assert.match(failed(data({ historyLines: log }))[NAMES.rounds] ?? '', /P2: stage_result lines .* differ from the results/);
  });

  it('fails when a round limit was hit', () => {
    const results = passingResults().map((result) => (result.number === 21 && result.verdict === 'failed' ? { ...result, round: 2 } : result));
    assert.match(failed(data({ results }))[NAMES.rounds] ?? '', /P1: round limit reached by test:failed:2/);
    const review = passingResults().map((result) => (result.number === 22 && result.verdict === 'changes_needed' ? { ...result, round: 3 } : result));
    assert.match(failed(data({ results: review }))[NAMES.rounds] ?? '', /P2: round limit reached by review:changes_needed:3/);
    assert.match(failed(data({ labels: { ...data().labels, 22: ['type: bugfix', 'needs-human'] } }))[NAMES.rounds] ?? '', /P2: labelled "needs-human"/);
  });

  it('fails when a bug issue ran through the wrong profile or lacks the Type label', () => {
    const results = passingResults().map((result) => (result.number === 21 && result.kind === 'test' ? { ...result, profile: null } : result));
    assert.match(failed(data({ results }))[NAMES.profile] ?? '', /P1: profile test:failed none, test:passed none, expected bugfix/);
    const other = passingResults().map((result) => (result.number === 22 && result.kind === 'review' ? { ...result, profile: 'default' } : result));
    assert.match(failed(data({ results: other }))[NAMES.profile] ?? '', /P2: profile review:changes_needed default, review:approved default, expected bugfix/);
    const unlabelled = failed(data({ labels: { 21: ['model: sonnet'], 22: ['type: bugfix'], 23: [] } }))[NAMES.profile] ?? '';
    assert.equal(unlabelled, 'P1: no "Type: bugfix" label');
  });

  it('fails when the sessions did not hand off in stage order', () => {
    const log = passingLog().map((entry) => (entry.includes('run_finished') && entry.includes('run=p1-4') ? entry.replace('role=test-engineer', 'role=developer') : entry));
    const detail = failed(data({ historyLines: log }))[NAMES.order] ?? '';
    assert.match(detail, /P1: issue-analyst, developer, test-engineer, developer, developer, reviewer, expected issue-analyst, developer, test-engineer, developer, test-engineer, reviewer/);
    assert.doesNotMatch(detail, /P2|P3/);
  });

  it('fails when a session failed, stalled or was the last one without handing off', () => {
    const extra = (outcome: string) => [started(50, 21, 'p1-x', 'developer', 'In progress'), finished(51, 21, 'p1-x', 'developer', outcome)];
    assert.match(failed(data({ historyLines: [...passingLog(), ...extra('failed')] }))[NAMES.last] ?? '', /P1: developer failed/);
    assert.match(failed(data({ historyLines: [...passingLog(), ...extra('stalled')] }))[NAMES.last] ?? '', /P1: developer stalled/);
    const last = failed(data({ historyLines: [...passingLog(), ...extra('continuing')] }))[NAMES.last] ?? '';
    assert.match(last, /P1: last session continuing/);
    assert.doesNotMatch(last, /developer continuing/);
    const unfinished = failed(data({ historyLines: [...passingLog(), started(50, 22, 'p2-x', 'reviewer', 'Agent review')] }))[NAMES.last] ?? '';
    assert.doesNotMatch(unfinished, /P2/, 'a session that has not finished does not count as the last one');
  });

  it('fails when a run used another model than sonnet', () => {
    const log = passingLog().map((entry) => (entry.includes('run_finished') && entry.includes('run=p2-6') ? entry.replace('model=claude-sonnet-5-5', 'model=claude-opus-5-5') : entry));
    assert.equal(failed(data({ historyLines: log }))[NAMES.model], 'reviewer #22: sonnet → claude-opus-5-5');
    const requested = passingLog().map((entry) => (entry.includes('run_started') && entry.includes('run=p1-5') ? entry.replace('model=sonnet', 'model=opus') : entry));
    assert.equal(failed(data({ historyLines: requested }))[NAMES.model], 'reviewer #21: opus → claude-sonnet-5-5');
  });

  it('fails when a role cost nothing or never ran', () => {
    const free = passingLog().map((entry) => (entry.includes('run_finished') && entry.includes('role=reviewer') ? entry.replace('cost_usd=0.1', 'cost_usd=0') : entry));
    const problems = failed(data({ historyLines: free }));
    assert.equal(problems[NAMES.roleCost], 'reviewer cost 0.0000 USD');
    assert.equal(problems[NAMES.total], undefined);
    const withoutTests = passingLog().filter((entry) => !entry.includes('role=test-engineer'));
    assert.equal(failed(data({ historyLines: withoutTests }))[NAMES.roleCost], 'test-engineer never ran');
  });

  it('fails when the cost is zero or above the ceiling', () => {
    const free = passingLog().map((entry) => entry.replace('cost_usd=0.1', 'cost_usd=0'));
    const zero = failed(data({ historyLines: free }));
    assert.match(zero[NAMES.total] ?? '', /^0\.0000 USD in 14 sessions/);
    assert.equal(Object.hasOwn(zero, NAMES.roleCost), true);
    const expensive = failed(data({ costCeilingUsd: 1.4 }));
    assert.equal(expensive[`Total cost below 1.4 USD`], '1.4000 USD in 14 sessions');
    assert.equal(Object.keys(failed(data({ costCeilingUsd: 1.5 }))).length, 0);
  });

  it('fails everything on an empty run', () => {
    const problems = failed(data({ historyLines: [], timeline: [], results: [], labels: {} }));
    assert.deepEqual(Object.keys(problems), Object.values(NAMES));
  });

  it('rejects an issue that is not part of the scenario', () => {
    assert.throws(() => verifyPipeline(data({ issues: [{ key: 'X9', number: 99 }] })), /X9 is not an issue of the pipeline scenario/);
  });
});

describe('e2e pipeline cost per role', () => {
  it('reads the sessions of the log with role, models, turns and cost', () => {
    const runs = pipelineRuns(passingLog());
    assert.equal(runs.length, 14);
    assert.deepEqual(runs[0], {
      run: 'p1-0',
      issue: 21,
      role: 'issue-analyst',
      start: Date.parse(at(0)),
      end: Date.parse(at(1)),
      outcome: 'handed_off',
      requestedModel: 'sonnet',
      usedModel: 'claude-sonnet-5-5',
      turns: 2,
      costUsd: 0.1,
    });
  });

  it('sums sessions, turns and cost per role in stage order', () => {
    const costs = costByRole(pipelineRuns([...passingLog(), started(60, 21, 'x', 'auditor', 'Ready'), finished(61, 21, 'x', 'auditor')]));
    assert.deepEqual(
      costs.map((cost) => [cost.role, cost.runs, cost.turns]),
      [
        ['issue-analyst', 3, 6],
        ['developer', 4, 8],
        ['test-engineer', 4, 8],
        ['reviewer', 3, 6],
        ['auditor', 1, 2],
      ],
    );
    assert.deepEqual(costs[0]?.models, ['claude-sonnet-5-5']);
    assert.ok(Math.abs((costs[1]?.costUsd ?? 0) - 0.4) < 1e-9);
  });

  it('has no costs without sessions', () => {
    assert.deepEqual(costByRole([]), []);
    assert.deepEqual(pipelineRuns([]), []);
  });
});

describe('e2e pipeline scenario', () => {
  const source = fs.readFileSync(path.join(ROOT, 'WORKFLOW.md'), 'utf8');
  const env = { GITHUB_PROJECT_NUMBER: '7', GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: 'token' };
  const resolve = (overrides: NodeJS.ProcessEnv = {}, text = source): { config: ServiceConfig; promptTemplate: string } => {
    const runDir = tempDir('e2e-pipeline-');
    const { config: front, promptTemplate } = parseWorkflow(pipelineWorkflow(text, ROOT));
    const config = resolveConfig(front, { workflowPath: path.join(runDir, PIPELINE_FILES.workflow), env: { ...env, ...overrides }, trackerDefaults });
    return { config, promptTemplate };
  };

  it('defines a test loop, a review loop and a blocked analysis', () => {
    assert.deepEqual(PIPELINE_SCENARIO.map((issue) => [issue.key, issue.blockers, issue.profile]), [
      ['P1', [], 'bugfix'],
      ['P2', [], 'bugfix'],
      ['P3', [], null],
    ]);
    assert.deepEqual(
      PIPELINE_SCENARIO.map((issue) => issue.path),
      [
        ['In progress', 'Testing', 'In progress', 'Testing', 'Agent review', 'In review'],
        ['In progress', 'Testing', 'Agent review', 'In progress', 'Testing', 'Agent review', 'In review'],
        ['Blocked'],
      ],
    );
    for (const issue of PIPELINE_SCENARIO) {
      assert.deepEqual(issue.results.map((result) => [result.kind, result.verdict, result.round, result.marker]), FLOW[issue.key], issue.key);
      assert.deepEqual(issue.results.map(resultLabel), (FLOW[issue.key] as Step[]).map(([kind, verdict]) => `${kind}:${verdict}`));
    }
    assert.deepEqual(PIPELINE_COLUMNS, ['Ready', 'Design', 'In progress', 'Testing', 'Documentation', 'Agent review', 'Security review', 'In review', 'Blocked', 'Done']);
  });

  it('names the markers by issue', () => {
    assert.equal(PIPELINE_MARKER.testFailed('P1'), 'E2E run P1 test failed');
    assert.equal(PIPELINE_MARKER.needsInfo('P3'), 'E2E run P3 needs info');
  });

  it('writes issue texts with report_result instructions per role; only P1 gets a failed test case, only P2 a changes_needed finding', () => {
    const bodies = new Map(PIPELINE_SCENARIO.map((issue) => [issue.key, pipelineIssueBody(issue)]));
    for (const issue of PIPELINE_SCENARIO) {
      const body = bodies.get(issue.key) as string;
      for (const result of issue.results) assert.ok(body.includes(`\`${result.marker}\``), `${issue.key} asks for ${result.marker}`);
      assert.match(body, new RegExp(`## Role \`${PIPELINE_ROLE.analyst}\``));
      assert.match(body, /mcp__tracker__get_issue/);
      assert.match(body, /`report_result`/);
      assert.doesNotMatch(body, /set_status|set the status/);
      assert.match(body, /\*\*No code changes\.\*\*/);
    }
    const roles = (key: string) => [...(bodies.get(key) as string).matchAll(/## Role `([a-z-]+)`/g)].map((match) => match[1]);
    assert.deepEqual(roles('P1'), ['issue-analyst', 'developer', 'test-engineer', 'reviewer']);
    assert.deepEqual(roles('P2'), ['issue-analyst', 'developer', 'test-engineer', 'reviewer']);
    assert.deepEqual(roles('P3'), ['issue-analyst']);

    const has = (key: string, text: string) => (bodies.get(key) as string).includes(text);
    assert.deepEqual(['P1', 'P2', 'P3'].map((key) => has(key, 'the verdict `failed`')), [true, false, false]);
    assert.deepEqual(['P1', 'P2', 'P3'].map((key) => has(key, 'status `failed`')), [true, false, false]);
    assert.deepEqual(['P1', 'P2', 'P3'].map((key) => has(key, 'the verdict `changes_needed`')), [false, true, false]);
    assert.deepEqual(['P1', 'P2', 'P3'].map((key) => has(key, 'severity `major`')), [false, true, false]);
    assert.deepEqual(['P1', 'P2', 'P3'].map((key) => has(key, 'the verdict `needs_info`')), [false, false, true]);
    assert.deepEqual(['P1', 'P2', 'P3'].map((key) => has(key, 'open question')), [false, false, true]);
    assert.deepEqual(['P1', 'P2', 'P3'].map((key) => has(key, 'the type `bugfix`')), [true, true, false]);
    assert.match(bodies.get('P1') as string, /In round 1 call `report_result` with the verdict `failed`/);
    assert.match(bodies.get('P1') as string, /In any later round: Call `report_result` with the verdict `passed`/);
    assert.match(bodies.get('P2') as string, /In round 1 call `report_result` with the verdict `changes_needed`/);
    assert.match(bodies.get('P2') as string, /In any later round: Call `report_result` with the verdict `approved`/);
  });

  it('refuses a text for an issue of another scenario', () => {
    assert.throws(() => pipelineIssueBody({ key: 'R1', title: 'approval', blockers: [] }), /R1 is not an issue of the pipeline scenario/);
  });

  it('derives a valid workflow that keeps the shipped pipeline', () => {
    const { config } = resolve();
    assert.deepEqual(config.warnings, []);
    assert.deepEqual(config.tracker.activeStates, ['Ready', 'Design', 'In progress', 'Testing', 'Documentation', 'Agent review', 'Security review']);
    assert.deepEqual(config.tracker.terminalStates, ['Done']);
    assert.deepEqual(config.roles?.map((role) => role.name).slice(0, 6), ['issue-analyst', 'architect', 'developer', 'test-engineer', 'docs', 'reviewer']);
    const role = (name: string) => config.roles?.find((candidate) => candidate.name === name);
    assert.deepEqual(role('issue-analyst')?.onResult, { ready: 'next', needs_info: 'Blocked' });
    assert.deepEqual(role('developer')?.onResult, { done: 'Agent review', blocked: 'Blocked' });
    assert.deepEqual(role('test-engineer')?.onResult, { passed: 'Agent review', failed: 'In progress', blocked: 'Blocked' });
    assert.deepEqual(role('reviewer')?.onResult, { approved: 'In review', changes_needed: 'In progress', blocked: 'Blocked' });
    assert.deepEqual(role('developer')?.states, ['in progress']);
    assert.deepEqual(role('test-engineer')?.states, ['testing']);
    assert.equal(role('reviewer')?.readOnly, true);
    assert.equal(role('reviewer')?.onCheckFailed, 'In progress');
    assert.deepEqual([...config.pipeline.profiles.keys()], ['bugfix', 'feature', 'refactor', 'default']);
    for (const type of ['bugfix', 'feature', 'refactor']) assert.deepEqual(config.pipeline.profiles.get(type)?.onResult, { developer: { done: 'Testing' } }, type);
    assert.deepEqual(config.pipeline.profiles.get('default')?.onResult, {});
    for (const type of ['bugfix', 'feature', 'refactor']) assert.deepEqual(config.pipeline.profiles.get(type)?.skip, [], type);
    assert.equal(config.pipeline.maxReviewRounds, 3);
    assert.equal(config.pipeline.maxTestRounds, 2);
    assert.equal(config.pipeline.analysis, 'always');
    assert.equal(config.agent.maxConcurrentAgentsByState.get('agent review'), 2);
    assert.equal(config.agent.maxConcurrentAgentsByState.get('testing'), 1);
    assert.equal(config.tracker.provider.repositories, '$GITHUB_REPOSITORY', 'provider settings stay unresolved, as in WORKFLOW.md');
  });

  it('matches the roles, profile, limits and columns of the shipped WORKFLOW.md', () => {
    const shipped = resolveConfig(parseWorkflow(source).config, { workflowPath: path.join(ROOT, 'WORKFLOW.md'), env, trackerDefaults });
    const { config } = resolve();
    const transitions = (roles: ServiceConfig['roles']) =>
      roles?.map(({ name, states, readOnly, result, onResult, onCheckFailed, mayMoveTo, maxTurns }) => ({ name, states, readOnly, result, onResult, onCheckFailed, mayMoveTo, maxTurns }));
    assert.deepEqual(transitions(config.roles), transitions(shipped.roles));
    assert.deepEqual(config.pipeline, shipped.pipeline);
    assert.deepEqual(config.tracker.activeStates, shipped.tracker.activeStates);
    assert.deepEqual(config.agent.reservedSlotsByRole, shipped.agent.reservedSlotsByRole);
    assert.deepEqual(config.agent.maxConcurrentAgentsByState, shipped.agent.maxConcurrentAgentsByState);
  });

  it('pins every role to sonnet and drops the entry checks', () => {
    const { config } = resolve();
    assert.ok((config.roles ?? []).length >= 4);
    for (const role of config.roles ?? []) {
      assert.equal(role.claude.model, MODEL, role.name);
      assert.equal(role.claude.modelByComplexity, undefined, role.name);
    }
    assert.equal(config.claude.model, MODEL);
    assert.equal(config.checks.onEnter.size, 0);
    assert.equal(config.polling.intervalMs, 10_000);
    assert.equal(config.agent.maxIssueCostUsd, 4);
  });

  it('removes a complexity-based model from the roles', () => {
    const variant = source.replace('    claude: { model: sonnet, effort: medium }\n  # The architect decides', '    claude: { model: sonnet, effort: medium, model_by_complexity: { XL: opus } }\n  # The architect decides');
    assert.notEqual(variant, source);
    const { config } = resolve({}, variant);
    assert.equal(config.roles?.find((role) => role.name === 'issue-analyst')?.claude.modelByComplexity, undefined);
  });

  it('makes the paths absolute and switches Laravel Boost off', () => {
    const { config } = resolve({ HOME: '/home/e2e' });
    assert.deepEqual(config.claude.plugins, [path.join(ROOT, '.claude')]);
    assert.ok(config.hooks.afterCreate?.includes(path.join(ROOT, 'hooks', 'laravel-env.sh')), 'hooks call the scripts of the checkout');
    assert.doesNotMatch(config.hooks.afterCreate ?? '', /SYMPHONY_WORKFLOW_DIR/);
    assert.ok(path.isAbsolute(config.workspace.root));
    assert.deepEqual(config.integrations.laravel, { ...(config.integrations.laravel as object), boost: 'off' });
  });

  it('has no problems against the 8-column board, with the default slots', () => {
    const { config } = resolve();
    assert.deepEqual(unknownBoardColumns(config, BOARD), []);
    assert.deepEqual(nextStageProblems(config, BOARD), []);
    assert.deepEqual(slotProblems(config, effectiveAgentLimits(config, NO_LIMIT_OVERRIDE)), []);
    assert.deepEqual(pipelineConfigProblems(config, BOARD), []);
    assert.deepEqual(pipelineConfigProblems(config, BOARD.map((column) => column.toLowerCase())), []);
  });

  it('names the problems that would stall the run', () => {
    const { config } = resolve();
    assert.deepEqual(pipelineConfigProblems(config, BOARD.filter((column) => column !== 'Testing')), [
      `unknown board column "Testing" (valid: ${BOARD.filter((column) => column !== 'Testing').join(', ')})`,
    ]);
    const starved = pipelineConfigProblems(resolve({ SYMPHONY_MAX_CONCURRENT_AGENTS: '2' }).config, BOARD);
    assert.equal(starved.length, 1);
    assert.match(starved[0] ?? '', /role test-engineer never starts in Testing/);
  });

  it('passes the dispatch preflight of Symphony', () => {
    const { config } = resolve();
    const errors = validateDispatch({ config } as unknown as EffectiveWorkflow, null, { ...env });
    assert.deepEqual(errors, []);
  });

  it('renders the e2e prompt for every role', async () => {
    const { promptTemplate } = resolve();
    const issue = makeIssue({ id: '21', title: 'E2E run P1', description: pipelineIssueBody({ key: 'P1', title: 'test loop', blockers: [] }), state: 'Testing' });
    const results = { failed_cases: [{ criterion: 'c', test: 't' }], open_findings: [] };
    const prompt = await renderPrompt(compilePrompt(promptTemplate), { issue, attempt: null, role: PIPELINE_ROLE.tester, round: 2, results });
    assert.match(prompt, /You are the \*\*test-engineer\*\*/);
    assert.match(prompt, /Round 2\. Failed test cases: 1\./);
    assert.doesNotMatch(prompt, /Open findings/);
    assert.ok(prompt.includes('E2E run P1 test failed'), 'the issue text is part of the prompt');

    const reviewer = await renderPrompt(compilePrompt(promptTemplate), {
      issue,
      attempt: null,
      role: PIPELINE_ROLE.reviewer,
      round: 1,
      results: { failed_cases: [], open_findings: [{ severity: 'major', problem: 'p' }] },
    });
    assert.match(reviewer, /Round 1\. Open findings: 1\./);
    assert.doesNotMatch(reviewer, /Failed test cases/);
  });
});
