import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ROOT, STATUS } from '../scripts/e2e/context.ts';
import { AGENT_REVIEW_LIMIT, CHECK_SCRIPT, ROLES_FILES, ROLES_MARKER, ROLES_SCENARIO, ROLE_STATUS, expectedResults, rolesIssueBody, rolesWorkflow } from '../scripts/e2e/roles.ts';
import { expectedPath, observedPath, verifyRoles, type RolesData, type TimelineEntry } from '../scripts/e2e/verify-roles.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { parseWorkflow } from '../src/workflow/loader.ts';
import { compilePrompt, renderPrompt } from '../src/workflow/template.ts';
import { makeIssue, tempDir } from './helpers.ts';

const REPO = 'acme/e2e';
const ISSUES = [
  { key: 'R1', number: 11, rejectOnce: false },
  { key: 'R2', number: 12, rejectOnce: true },
  { key: 'R3', number: 13, rejectOnce: false },
];

/** Minutes after 10:00 UTC as an ISO timestamp. */
const at = (minute: number) => new Date(Date.UTC(2026, 9, 5, 10, 0, minute * 60)).toISOString();

function line(minute: number, event: string, fields: Record<string, string | number | boolean>): string {
  const pairs = Object.entries(fields).map(([key, value]) => `${key}=${typeof value === 'string' && /\s/.test(value) ? JSON.stringify(value) : value}`);
  return [`ts=${at(minute)}`, `event=${event}`, `repo=${REPO}`, ...pairs].join(' ');
}

const started = (minute: number, number: number, run: string, role: string, state: string) =>
  line(minute, 'run_started', { issue: `${REPO}#${number}`, run, title: 'E2E run', state, attempt: 'null', model: 'sonnet', role });

const finished = (minute: number, number: number, run: string, outcome: string, roles?: [string, string]) =>
  line(minute, 'run_finished', {
    issue: `${REPO}#${number}`,
    run,
    outcome,
    ...(roles === undefined ? {} : { role: roles[0], next_role: roles[1] }),
    state: 'x',
    reason: 'handed off',
    turns: 1,
    cost_usd: 0.05,
    started_at: at(minute - 1),
  });

const check = (minute: number, number: number, run: string, result: string) =>
  line(minute, 'checks_finished', {
    issue: `${REPO}#${number}`,
    run,
    role: 'developer',
    target: ROLE_STATUS.review,
    ok: result === 'passed',
    result,
    exit_code: result === 'passed' ? 0 : 1,
    duration_ms: 12,
  });

/** A recorded run in which everything went as planned: R2 is rejected once, reviewers never overlap. */
function passingLog(): string[] {
  return [
    started(0, 11, 'a1', 'developer', 'Ready'),
    started(0, 12, 'b1', 'developer', 'Ready'),
    check(1, 11, 'a1', 'check_failed'),
    check(1, 12, 'b1', 'check_failed'),
    check(2, 11, 'a1', 'passed'),
    check(2, 12, 'b1', 'passed'),
    finished(2, 11, 'a1', 'handed_off', ['developer', 'reviewer']),
    finished(2, 12, 'b1', 'handed_off', ['developer', 'reviewer']),
    started(3, 11, 'a2', 'reviewer', 'Agent review'),
    started(3, 13, 'c1', 'developer', 'Ready'),
    finished(4, 11, 'a2', 'handed_off'),
    started(5, 12, 'b2', 'reviewer', 'Agent review'),
    check(5, 13, 'c1', 'check_failed'),
    check(6, 13, 'c1', 'passed'),
    finished(6, 13, 'c1', 'handed_off', ['developer', 'reviewer']),
    finished(7, 12, 'b2', 'handed_off', ['reviewer', 'developer']),
    started(7, 13, 'c2', 'reviewer', 'Agent review'),
    started(7, 12, 'b3', 'developer', 'In progress'),
    finished(8, 13, 'c2', 'handed_off'),
    finished(8, 12, 'b3', 'handed_off', ['developer', 'reviewer']),
    started(9, 12, 'b4', 'reviewer', 'Agent review'),
    finished(10, 12, 'b4', 'handed_off'),
  ];
}

function timeline(paths: Record<number, Array<string | null>>): TimelineEntry[] {
  return Object.entries(paths).flatMap(([number, statuses]) =>
    statuses.map((status, index) => ({ at: at(index), number: Number(number), status })),
  );
}

function passingTimeline(): TimelineEntry[] {
  return timeline({
    11: [null, 'Ready', 'In progress', 'In progress', 'Agent review', 'In review'],
    12: ['Ready', 'In progress', 'Agent review', 'In progress', 'Agent review', 'Agent review', 'In review'],
    13: ['Ready', 'In progress', 'Agent review', 'In review'],
  });
}

/** The results `report_result` recorded in a run that followed the lifecycle. */
function passingResults(): RolesData['results'] {
  return ISSUES.flatMap((issue) =>
    expectedResults(issue.rejectOnce).map((entry) => {
      const [kind = '', verdict = ''] = entry.split(':');
      return { number: issue.number, kind, verdict };
    }),
  );
}

function data(overrides: Partial<RolesData> = {}): RolesData {
  return {
    results: passingResults(),
    issues: ISSUES,
    historyLines: passingLog(),
    timeline: passingTimeline(),
    agentReviewLimit: AGENT_REVIEW_LIMIT,
    polledReviewPeak: 1,
    ...overrides,
  };
}

function failed(input: RolesData): Record<string, string> {
  return Object.fromEntries(verifyRoles(input).filter((c) => !c.ok).map((c) => [c.name, c.detail]));
}

describe('e2e roles verification', () => {
  it('passes a recorded run that followed the lifecycle', () => {
    const checks = verifyRoles(data());
    assert.deepEqual(checks.filter((c) => !c.ok), []);
    assert.equal(checks.length, 6);
    assert.match(checks.find((c) => c.name.startsWith('Repository log'))?.detail ?? '', /checks_finished 6, handed_off 8/);
  });

  it('derives the path from the timeline, without repeats and the start status', () => {
    assert.deepEqual(observedPath(passingTimeline(), 12), expectedPath(true));
    assert.deepEqual(observedPath(passingTimeline(), 11), [ROLE_STATUS.progress, ROLE_STATUS.review, STATUS.handoff]);
    assert.deepEqual(observedPath([], 11), []);
  });

  it('fails when an issue skipped a column, was not rejected or did not end in In review', () => {
    const problems = failed(
      data({
        timeline: timeline({
          11: ['Ready', 'Agent review', 'In review'],
          12: ['Ready', 'In progress', 'Agent review', 'In review'],
          13: ['Ready', 'In progress', 'Agent review'],
        }),
      }),
    );
    const detail = problems['Status path per issue'] ?? '';
    assert.match(detail, /R1: Agent review → In review/);
    assert.match(detail, /R2: In progress → Agent review → In review, expected/);
    assert.match(detail, /R3: In progress → Agent review, expected/);
  });

  it('fails when an issue reached Done', () => {
    const recorded = [...passingTimeline(), { at: at(20), number: 13, status: 'Done' }];
    const problems = failed(data({ timeline: recorded }));
    assert.equal(problems[`No issue reached "${STATUS.done}"`], 'in "Done": R3');
  });

  it('fails without exactly one denied check before a passing one', () => {
    const log = passingLog()
      .filter((entry) => !(entry.includes('#13') && entry.includes('check_failed')))
      .concat(check(9, 12, 'b3', 'check_failed'));
    const problems = failed(data({ historyLines: log }));
    const detail = problems[`One denied entry check per issue, then passed ("${ROLE_STATUS.review}")`] ?? '';
    assert.match(detail, /R2: check_failed, passed, check_failed/);
    assert.match(detail, /R3: passed/);
    assert.doesNotMatch(detail, /R1/);
  });

  it('fails when the results are not the ones the lifecycle records', () => {
    const name = 'Stage results per issue (report_result)';
    assert.deepEqual(expectedResults(true), ['implementation:done', 'review:changes_needed', 'implementation:done', 'review:approved']);
    const dropped = passingResults().filter((result) => !(result.number === 12 && result.verdict === 'changes_needed'));
    assert.match(failed(data({ results: dropped }))[name] ?? '', /R2: implementation:done, implementation:done, review:approved, expected implementation:done, review:changes_needed/);
    const early = passingResults().filter((result) => result.number !== 13);
    assert.match(failed(data({ results: early }))[name] ?? '', /R3: \(nothing\), expected implementation:done, review:approved/);
    assert.deepEqual(Object.keys(failed(data({ results: [] }))), [name]);
  });

  it('fails when the log lacks checks_finished or a handoff', () => {
    const log = passingLog().filter((entry) => !entry.includes('checks_finished') && !(entry.includes('run=b2') && entry.includes('run_finished')));
    const detail = failed(data({ historyLines: log }))['Repository log has checks_finished and handed_off'] ?? '';
    assert.match(detail, /checks_finished 0/);
    assert.match(detail, /R2: no reviewer → developer handoff/);
  });

  it('fails when the last run of an issue is not the reviewer handing off', () => {
    const log = passingLog().filter((entry) => !entry.includes('run=b4'));
    const detail = failed(data({ historyLines: log }))['Repository log has checks_finished and handed_off'] ?? '';
    assert.match(detail, /R2: last run is not the reviewer's handoff/);
  });

  it('fails when reviewer runs overlap beyond the Agent review limit', () => {
    const log = [...passingLog(), started(3, 13, 'c9', 'reviewer', 'Agent review'), finished(4, 13, 'c9', 'continuing')];
    const name = `At most ${AGENT_REVIEW_LIMIT} agent(s) in "${ROLE_STATUS.review}"`;
    assert.match(failed(data({ historyLines: log }))[name] ?? '', /peak 2 of 5 reviewer runs/);
    assert.match(failed(data({ polledReviewPeak: 2 }))[name] ?? '', /2 in the API trace/);
  });

  it('fails everything on an empty run', () => {
    const problems = failed(data({ historyLines: [], timeline: [], polledReviewPeak: 0, results: [] }));
    assert.equal(Object.keys(problems).length, 5);
  });
});

describe('e2e roles scenario', () => {
  const source = fs.readFileSync(path.join(ROOT, 'WORKFLOW.md'), 'utf8');
  const env = { GITHUB_PROJECT_NUMBER: '7', GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: 'token' };

  it('derives a valid workflow with roles, the entry check and the Agent review limit', async () => {
    const runDir = tempDir('e2e-roles-');
    const { config: front, promptTemplate } = parseWorkflow(rolesWorkflow(source, ROOT));
    const config = resolveConfig(front, { workflowPath: path.join(runDir, ROLES_FILES.workflow), env, trackerDefaults });

    assert.deepEqual(config.tracker.activeStates, [STATUS.start, ROLE_STATUS.progress, ROLE_STATUS.review]);
    assert.deepEqual(config.tracker.terminalStates, [STATUS.done]);
    assert.deepEqual(config.roles?.map((role) => [role.name, role.states]), [
      ['developer', ['ready', 'in progress']],
      ['reviewer', ['agent review']],
    ]);
    assert.deepEqual(config.roles?.map((role) => [role.name, role.result, role.onResult]), [
      ['developer', 'implementation', { done: ROLE_STATUS.review, blocked: ROLE_STATUS.blocked }],
      ['reviewer', 'review', { approved: STATUS.handoff, changes_needed: ROLE_STATUS.progress, blocked: ROLE_STATUS.blocked }],
    ]);
    assert.equal(config.roles?.find((role) => role.name === 'reviewer')?.onCheckFailed, ROLE_STATUS.progress);
    assert.equal(config.pipeline.maxReviewRounds, 3);
    assert.equal(config.checks.onEnter.get('agent review'), `bash "$SYMPHONY_WORKFLOW_DIR/${ROLES_FILES.check}"`);
    assert.equal(config.agent.maxConcurrentAgentsByState.get('agent review'), AGENT_REVIEW_LIMIT);
    assert.ok(config.agent.maxContinuations !== null);
    assert.deepEqual(config.claude.plugins, [path.join(ROOT, '.claude')]);
    assert.equal(config.tracker.provider.repositories, '$GITHUB_REPOSITORY', 'provider settings stay unresolved, as in WORKFLOW.md');

    const issue = makeIssue({ id: '12', title: 'E2E run', description: 'Do this', state: 'Agent review' });
    const prompt = await renderPrompt(compilePrompt(promptTemplate), { issue, attempt: null, role: 'reviewer', round: 2 });
    assert.match(prompt, /You are the \*\*reviewer\*\*/);
    assert.match(prompt, /Review round 2\./);
    assert.match(prompt, /Do this/);
  });

  it('writes issue texts with report_result instructions for both roles; only R2 gets changes_needed', () => {
    const bodies = new Map(ROLES_SCENARIO.map((issue) => [issue.key, rolesIssueBody(issue)]));
    for (const [key, body] of bodies) {
      assert.match(body, /## Role `developer`/);
      assert.match(body, /## Role `reviewer`/);
      assert.ok(body.includes(ROLES_MARKER.developed(key)));
      assert.ok(body.includes(ROLES_MARKER.approved(key)));
      assert.equal(body.includes(ROLES_MARKER.rejected(key)), key === 'R2');
      assert.equal(body.includes('`changes_needed`'), key === 'R2');
      assert.match(body, /`report_result` with the verdict `done`/);
      assert.doesNotMatch(body, /set_status|set the status/);
    }
  });

  it('check script fails once per issue and passes afterwards', () => {
    const dir = tempDir('e2e-roles-check-');
    const script = path.join(dir, ROLES_FILES.check);
    fs.writeFileSync(script, CHECK_SCRIPT);
    const run = (identifier: string) =>
      spawnSync('bash', [script], { env: { ...process.env, SYMPHONY_WORKFLOW_DIR: dir, SYMPHONY_ISSUE_IDENTIFIER: identifier }, encoding: 'utf8' });
    assert.equal(run('acme/e2e#11').status, 1);
    assert.equal(run('acme/e2e#11').status, 0);
    assert.equal(run('acme/e2e#12').status, 1);
    assert.ok(fs.existsSync(path.join(dir, ROLES_FILES.markers, 'acme_e2e_11')));
  });
});
