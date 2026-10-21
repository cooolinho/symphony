import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { blockedBucketColumns, derivePipeline, type PipelineInput, type StageSession } from '../src/orchestrator/pipeline.ts';
import type { PersistedResult } from '../src/orchestrator/stage-history.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import type { RoleConfig } from '../src/workflow/roles.ts';
import { internalResult, parseResult, type ResultMeta } from '../src/workflow/results.ts';
import { baseFront, makeWorkflow, tempDir } from './helpers.ts';

const ACTIVE = ['Ready', 'In progress', 'Agent review'];
const TERMINAL = ['Done'];
const BOARD = ['Backlog', 'Ready', 'In progress', 'Agent review', 'Blocked', 'In review', 'Done'];

/** The default WORKFLOW.md roles, resolved through the real config reader. */
function defaultRoles() {
  const front = baseFront(tempDir('symphony-pipeline-'), {
    tracker: {
      kind: 'github_project',
      provider: { owner: 'acme', project_number: 1, token: 'test-token' },
      active_states: ACTIVE,
      terminal_states: TERMINAL,
    },
    roles: {
      developer: { states: ['Ready', 'In progress'], may_move_to: ['In progress', 'Agent review', 'Blocked'] },
      reviewer: { states: ['Agent review'], read_only: true, may_move_to: ['In review', 'In progress', 'Blocked'] },
      auditor: { commands: ['refactoring'], states: ['Ready', 'In progress'], read_only: true, may_move_to: ['In progress', 'In review', 'Blocked'] },
    },
  });
  const roles = makeWorkflow(front).config.roles;
  assert.notEqual(roles, null);
  return roles;
}

function session(overrides: Partial<StageSession> & { run: string; role: string }): StageSession {
  return {
    attempt: null,
    state: 'Ready',
    model: null,
    effort: null,
    started_at: '2026-10-03T12:00:00.000Z',
    finished_at: null,
    outcome: null,
    ...overrides,
  };
}

function resultMeta(overrides: Partial<ResultMeta> & { role: string }): ResultMeta {
  return {
    run: null,
    round: 1,
    profile: null,
    workflow_hash: null,
    head_sha: null,
    checks: null,
    target: null,
    created_at: '2026-10-03T12:00:00.000Z',
    ...overrides,
  };
}

/** A persisted result of the agent kind `kind` with the verdict and the fields it needs. */
function persisted(kind: 'implementation' | 'review', verdict: string, meta: Partial<ResultMeta> & { role: string }): PersistedResult {
  const input = kind === 'review' && verdict === 'changes_needed'
    ? { verdict, summary: 'Needs work', findings: [{ severity: 'major', problem: 'Broken' }] }
    : { verdict, summary: 'Fine' };
  const parsed = parseResult(kind, input);
  assert.ok(parsed.ok, 'result parses');
  return { result: parsed.result, meta: resultMeta(meta) };
}

function derive(overrides: Partial<PipelineInput>) {
  return derivePipeline({
    issue: { state: 'Ready', description: null },
    roles: defaultRoles(),
    activeStates: ACTIVE,
    terminalStates: TERMINAL,
    boardColumns: BOARD,
    sessions: [],
    ...overrides,
  });
}

describe('derivePipeline', () => {
  it('derives developer → reviewer → In review → Done for a default issue in Ready', () => {
    const stages = derive({});
    assert.deepEqual(
      stages.map((stage) => [stage.id, stage.kind, stage.status]),
      [
        ['developer', 'agent', 'active'],
        ['reviewer', 'agent', 'pending'],
        ['human:in review', 'human', 'pending'],
        ['terminal:done', 'terminal', 'pending'],
      ],
    );
    assert.deepEqual(stages[0]?.columns, ['Ready', 'In progress']);
    assert.deepEqual(stages[2]?.label, 'In review');
  });

  it('marks earlier stages done and attributes sessions to their role', () => {
    const sessions = [
      session({ run: 'r1', role: 'developer', state: 'Ready', outcome: 'handed_off' }),
      session({ run: 'r2', role: 'reviewer', state: 'Agent review' }),
    ];
    const stages = derive({ issue: { state: 'Agent review', description: null }, sessions });
    assert.deepEqual(
      stages.map((stage) => [stage.id, stage.status, stage.sessions.length]),
      [
        ['developer', 'done', 1],
        ['reviewer', 'active', 1],
        ['human:in review', 'pending', 0],
        ['terminal:done', 'pending', 0],
      ],
    );
  });

  it('serves a /refactoring issue with the auditor instead of the developer', () => {
    const stages = derive({ issue: { state: 'In progress', description: '/refactoring src' } });
    assert.deepEqual(
      stages.map((stage) => stage.id),
      ['auditor', 'reviewer', 'human:in review', 'terminal:done'],
    );
    assert.equal(stages[0]?.status, 'active');
  });

  it('keeps a handed-off role done when the column moves backwards', () => {
    const sessions = [session({ run: 'r1', role: 'reviewer', state: 'Agent review', outcome: 'handed_off' })];
    const stages = derive({ issue: { state: 'In progress', description: null }, sessions });
    assert.equal(stages.find((stage) => stage.id === 'developer')?.status, 'active');
    assert.equal(stages.find((stage) => stage.id === 'reviewer')?.status, 'done');
  });

  it('uses the last session state for an issue parked outside the pipeline', () => {
    const sessions = [session({ run: 'r1', role: 'developer', state: 'In progress', outcome: 'stopped' })];
    const stages = derive({ issue: { state: 'Blocked', description: null }, sessions });
    assert.equal(stages.find((stage) => stage.id === 'developer')?.status, 'active');
    assert.equal(stages.find((stage) => stage.id === 'reviewer')?.status, 'pending');
  });

  it('marks every stage done for an issue in a terminal column', () => {
    const stages = derive({ issue: { state: 'Done', description: null } });
    assert.deepEqual(
      stages.map((stage) => stage.status),
      ['done', 'done', 'done', 'done'],
    );
  });

  it('orders by the configured states when the board columns are unknown', () => {
    const stages = derive({ boardColumns: null });
    assert.deepEqual(
      stages.map((stage) => stage.id),
      ['developer', 'reviewer', 'human:in review', 'terminal:done'],
    );
  });

  it('falls back to one default agent stage without roles', () => {
    const stages = derive({ roles: null });
    assert.deepEqual(
      stages.map((stage) => [stage.id, stage.kind]),
      [
        ['default', 'agent'],
        ['terminal:done', 'terminal'],
      ],
    );
    assert.deepEqual(stages[0]?.columns, ACTIVE);
  });

  it('shows the stages of skipped roles as skipped, unless a session already ran there', () => {
    const stages = derive({ issue: { state: 'In progress', description: null }, skip: ['reviewer'] });
    assert.deepEqual(
      stages.map((stage) => [stage.id, stage.status]),
      [
        ['developer', 'active'],
        ['reviewer', 'skipped'],
        ['human:in review', 'pending'],
        ['terminal:done', 'pending'],
      ],
    );
    const ran = derive({ issue: { state: 'In progress', description: null }, skip: ['reviewer'], sessions: [session({ run: 'r1', role: 'reviewer', state: 'Agent review' })] });
    assert.equal(ran.find((stage) => stage.id === 'reviewer')?.status, 'pending');
    assert.equal(derive({ skip: ['auditor'] }).find((stage) => stage.id === 'developer')?.status, 'active');
  });

  it('shows a skipped stage before the current one as skipped, not done', () => {
    const stages = derive({ issue: { state: 'Agent review', description: null }, skip: ['developer'] });
    assert.deepEqual(
      stages.map((stage) => [stage.id, stage.status]),
      [
        ['developer', 'skipped'],
        ['reviewer', 'active'],
        ['human:in review', 'pending'],
        ['terminal:done', 'pending'],
      ],
    );
  });

  it('shows a stage with a skipped marker as skipped, unless a session ran there', () => {
    const marker: PersistedResult = { result: internalResult('skipped', 'not needed for a bugfix'), meta: resultMeta({ role: 'developer', round: null }) };
    const stages = derive({ issue: { state: 'Agent review', description: null }, results: [marker] });
    const developer = stages.find((stage) => stage.id === 'developer');
    assert.equal(developer?.status, 'skipped');
    assert.equal(developer?.verdict, 'skipped');
    const ran = derive({
      issue: { state: 'Agent review', description: null },
      results: [marker],
      sessions: [session({ run: 'r1', role: 'developer', outcome: 'handed_off' })],
    });
    assert.equal(ran.find((stage) => stage.id === 'developer')?.status, 'done');
  });

  it('attaches the verdict and round of the results to stages and to the sessions that reported them', () => {
    const results = [
      persisted('review', 'approved', { role: 'reviewer', run: 'r3', round: 2, created_at: '2026-10-03T14:00:00.000Z' }),
      persisted('review', 'changes_needed', { role: 'reviewer', run: 'r2', round: 1, created_at: '2026-10-03T13:00:00.000Z' }),
      persisted('implementation', 'done', { role: 'developer', run: 'r1', round: null, created_at: '2026-10-03T12:00:00.000Z' }),
    ];
    const sessions = [
      session({ run: 'r1', role: 'developer', state: 'In progress', outcome: 'handed_off' }),
      session({ run: 'r2', role: 'reviewer', state: 'Agent review', outcome: 'handed_off' }),
      session({ run: 'r3', role: 'reviewer', state: 'Agent review', outcome: 'handed_off' }),
      session({ run: 'r4', role: 'reviewer', state: 'Agent review' }),
    ];
    const stages = derive({ issue: { state: 'In review', description: null }, sessions, results });
    const reviewer = stages.find((stage) => stage.id === 'reviewer');
    assert.deepEqual([reviewer?.verdict, reviewer?.round], ['approved', 2]);
    assert.deepEqual(
      reviewer?.sessions.map((s) => [s.run, s.verdict, s.round]),
      [
        ['r2', 'changes_needed', 1],
        ['r3', 'approved', 2],
        ['r4', null, null],
      ],
    );
    const developer = stages.find((stage) => stage.id === 'developer');
    assert.deepEqual([developer?.verdict, developer?.round, developer?.sessions[0]?.verdict], ['done', null, 'done']);
    assert.deepEqual([stages.at(-1)?.verdict, stages.at(-1)?.round], [null, null]);
  });

  it('keeps sessions of a role that is no longer derived as a trailing agent stage', () => {
    const sessions = [session({ run: 'r1', role: 'auditor', state: 'In progress', outcome: 'handed_off' })];
    const stages = derive({ issue: { state: 'In progress', description: null }, sessions });
    const auditor = stages.find((stage) => stage.id === 'auditor');
    assert.notEqual(auditor, undefined);
    assert.equal(auditor?.kind, 'agent');
    assert.equal(auditor?.status, 'done');
    assert.equal(auditor?.sessions.length, 1);
  });
});

/** The WORKFLOW.md shipped in the repository root. */
const shipped = path.join(import.meta.dirname, '..', 'WORKFLOW.md');
/** The board Testing is meant for: between In progress and Agent review. */
const BOARD_WITH_TESTING = ['Backlog', 'Ready', 'In progress', 'Testing', 'Documentation', 'Agent review', 'Blocked', 'In review', 'Done'];
/** This repository's own board, where Testing was added after Done. */
const BOARD_TESTING_LAST = ['Backlog', 'Ready', 'In progress', 'Documentation', 'Agent review', 'Blocked', 'In review', 'Done', 'Testing', 'Archive'];

describe('derivePipeline with the shipped workflow', () => {
  /** The shipped config, the test engineer stage off (the default) or on (the developer hands over to Testing). */
  async function shippedPipeline(stage: 'off' | 'on', overrides: Partial<PipelineInput> & Pick<PipelineInput, 'boardColumns'>) {
    const { definition } = await loadWorkflowFile(shipped);
    const config = resolveConfig(definition.config, {
      workflowPath: shipped,
      env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't', ...(stage === 'on' ? { SYMPHONY_AFTER_IMPLEMENTATION: 'Testing' } : {}) },
      trackerDefaults,
    });
    return derivePipeline({
      issue: { state: 'Agent review', description: null },
      roles: config.roles,
      activeStates: config.tracker.activeStates,
      terminalStates: config.tracker.terminalStates,
      sessions: [],
      ...overrides,
    });
  }
  const developed = [session({ run: 'r1', role: 'developer', state: 'In progress', outcome: 'handed_off' })];
  const ids = (stages: Array<{ id: string }>) => stages.map((stage) => stage.id);

  it('has no test engineer stage while the stage is off, so an issue past it never shows it as done', async () => {
    const stages = await shippedPipeline('off', { boardColumns: BOARD_WITH_TESTING, sessions: developed });
    assert.deepEqual(
      stages.map((stage) => [stage.id, stage.status]),
      [
        ['issue-analyst', 'done'],
        ['developer', 'done'],
        ['docs', 'skipped'],
        ['reviewer', 'active'],
        ['security-auditor', 'pending'],
        ['human:in review', 'pending'],
        ['terminal:done', 'pending'],
      ],
    );
    const done = await shippedPipeline('off', { boardColumns: BOARD_WITH_TESTING, issue: { state: 'Done', description: null }, sessions: developed });
    assert.deepEqual(ids(done), ['issue-analyst', 'developer', 'docs', 'reviewer', 'security-auditor', 'human:in review', 'terminal:done']);
  });

  it('keeps the In review stage of this repository\'s board, where Testing sits after Done, while the stage is off', async () => {
    const stages = await shippedPipeline('off', {
      boardColumns: BOARD_TESTING_LAST,
      issue: { state: 'In review', description: null },
      sessions: [...developed, session({ run: 'r2', role: 'reviewer', state: 'Agent review', outcome: 'handed_off' })],
    });
    assert.deepEqual(
      stages.map((stage) => [stage.id, stage.status]),
      [
        ['issue-analyst', 'done'],
        ['developer', 'done'],
        ['docs', 'skipped'],
        ['reviewer', 'done'],
        ['security-auditor', 'skipped'],
        ['human:in review', 'active'],
        ['terminal:done', 'pending'],
      ],
    );
  });

  it('shows the test engineer between the developer and the reviewer once the developer hands over to Testing', async () => {
    const tested = [...developed, session({ run: 'r2', role: 'test-engineer', state: 'Testing', outcome: 'handed_off' })];
    const stages = await shippedPipeline('on', { boardColumns: BOARD_WITH_TESTING, sessions: tested });
    assert.deepEqual(
      stages.map((stage) => [stage.id, stage.status]),
      [
        ['issue-analyst', 'done'],
        ['developer', 'done'],
        ['test-engineer', 'done'],
        ['docs', 'skipped'],
        ['reviewer', 'active'],
        ['security-auditor', 'pending'],
        ['human:in review', 'pending'],
        ['terminal:done', 'pending'],
      ],
    );
    assert.deepEqual(stages.find((stage) => stage.id === 'test-engineer')?.columns, ['Testing']);
    const waiting = await shippedPipeline('on', { boardColumns: BOARD_WITH_TESTING, issue: { state: 'Testing', description: null }, sessions: developed });
    assert.equal(waiting.find((stage) => stage.id === 'test-engineer')?.status, 'active');
  });

  it('shows the stage for an issue a human moved to Testing while it is off', async () => {
    const stages = await shippedPipeline('off', { boardColumns: BOARD_WITH_TESTING, issue: { state: 'Testing', description: null }, sessions: developed });
    assert.deepEqual(
      stages.map((stage) => [stage.id, stage.status]),
      [
        ['issue-analyst', 'done'],
        ['developer', 'done'],
        ['test-engineer', 'active'],
        ['docs', 'pending'],
        ['reviewer', 'pending'],
        ['security-auditor', 'pending'],
        ['human:in review', 'pending'],
        ['terminal:done', 'pending'],
      ],
    );
  });

  it('keeps the sessions of a test engineer that ran before the stage was switched off', async () => {
    const ran = [...developed, session({ run: 'r2', role: 'test-engineer', state: 'Testing', outcome: 'handed_off' })];
    const stages = await shippedPipeline('off', { boardColumns: BOARD_WITH_TESTING, sessions: ran });
    const tester = stages.find((stage) => stage.id === 'test-engineer');
    assert.equal(tester?.sessions.length, 1);
    assert.equal(tester?.status, 'done');
  });

  it('shows the stage when the issue\'s workflow profile routes the developer to Testing', async () => {
    const profile = { onResult: { developer: { done: 'Testing' } } };
    const routed = await shippedPipeline('off', { boardColumns: BOARD_WITH_TESTING, sessions: developed, profile });
    assert.deepEqual(ids(routed), ['issue-analyst', 'developer', 'test-engineer', 'docs', 'reviewer', 'security-auditor', 'human:in review', 'terminal:done']);
    // Without the profile the stage is off again.
    assert.deepEqual(ids(await shippedPipeline('off', { boardColumns: BOARD_WITH_TESTING, sessions: developed, profile: null })), ['issue-analyst', 'developer', 'docs', 'reviewer', 'security-auditor', 'human:in review', 'terminal:done']);
  });

  it('shows every later stage for a role that hands over with `next`', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const front = structuredClone(definition.config) as { roles: { developer: { on_result: Record<string, string> } } };
    front.roles.developer.on_result.done = 'next';
    const config = resolveConfig(front, {
      workflowPath: shipped,
      env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' },
      trackerDefaults,
    });
    const stages = derivePipeline({
      issue: { state: 'Ready', description: null },
      roles: config.roles,
      activeStates: config.tracker.activeStates,
      terminalStates: config.tracker.terminalStates,
      boardColumns: BOARD_WITH_TESTING,
      sessions: [],
    });
    assert.deepEqual(ids(stages), ['issue-analyst', 'developer', 'test-engineer', 'docs', 'reviewer', 'security-auditor', 'human:in review', 'terminal:done']);
  });
});

describe('derivePipeline with roles that move issues without results', () => {
  const BOARD_TESTING = ['Todo', 'Testing', 'Agent review', 'Blocked', 'In review', 'Done'];
  const reviewer = { states: ['Agent review'], read_only: true, result: 'review', may_move_to: ['In review', 'Todo', 'Blocked'], on_result: { approved: 'In review', changes_needed: 'Todo' } };
  const tester = { states: ['Testing'], result: 'test', may_move_to: ['Agent review', 'Todo', 'Blocked'], on_result: { passed: 'Agent review', failed: 'Todo' } };

  /** The `result-driven roles` suite of the orchestrator: a developer that hands off with `set_status`, a reviewer with results. */
  function pipelineOf(
    roles: Record<string, unknown>,
    active: string[],
    overrides: Partial<PipelineInput> = {},
    pick: (resolved: readonly RoleConfig[]) => readonly RoleConfig[] = (resolved) => resolved,
  ) {
    const front = baseFront(tempDir('symphony-pipeline-'), {
      tracker: { kind: 'github_project', provider: { owner: 'acme', project_number: 1, token: 'test-token' }, active_states: active, terminal_states: ['Done'] },
      roles,
    });
    const resolved = makeWorkflow(front).config.roles;
    assert.ok(resolved !== null);
    return derivePipeline({
      issue: { state: 'Todo', description: null },
      roles: pick(resolved),
      activeStates: active,
      terminalStates: ['Done'],
      boardColumns: BOARD_TESTING,
      sessions: [],
      ...overrides,
    });
  }
  const shape = (stages: ReturnType<typeof pipelineOf>) => stages.map((stage) => [stage.id, stage.status]);
  const developer = (mayMoveTo: string[] | null) => ({ states: ['Todo'], ...(mayMoveTo === null ? {} : { may_move_to: mayMoveTo }) });

  it('shows the reviewer and the In review stage for an issue in Todo, like a pipeline without a filter', () => {
    const stages = pipelineOf({ developer: developer(['Agent review', 'Blocked']), reviewer }, ['Todo', 'Agent review']);
    assert.deepEqual(shape(stages), [
      ['developer', 'active'],
      ['reviewer', 'pending'],
      ['human:in review', 'pending'],
      ['terminal:done', 'pending'],
    ]);
  });

  it('shows the reviewer as pending-then-done and the In review stage as active for an issue in In review', () => {
    const sessions = [session({ run: 'r1', role: 'developer', state: 'Todo', outcome: 'handed_off' }), session({ run: 'r2', role: 'reviewer', state: 'Agent review', outcome: 'handed_off' })];
    const stages = pipelineOf({ developer: developer(['Agent review', 'Blocked']), reviewer }, ['Todo', 'Agent review'], { issue: { state: 'In review', description: null }, sessions });
    assert.deepEqual(shape(stages), [
      ['developer', 'done'],
      ['reviewer', 'done'],
      ['human:in review', 'active'],
      ['terminal:done', 'pending'],
    ]);
  });

  it('shows the test engineer once a set_status developer may move issues to Testing', () => {
    const roles = { developer: developer(['Testing', 'Agent review', 'Blocked']), 'test-engineer': tester, reviewer };
    const sessions = [session({ run: 'r1', role: 'developer', state: 'Todo', outcome: 'handed_off' })];
    const stages = pipelineOf(roles, ['Todo', 'Testing', 'Agent review'], { issue: { state: 'Agent review', description: null }, sessions });
    assert.deepEqual(shape(stages), [
      ['developer', 'done'],
      ['test-engineer', 'done'],
      ['reviewer', 'active'],
      ['human:in review', 'pending'],
      ['terminal:done', 'pending'],
    ]);
  });

  it('shows the test engineer when the set_status developer is unrestricted', () => {
    const stages = pipelineOf({ developer: developer(null), 'test-engineer': tester, reviewer }, ['Todo', 'Testing', 'Agent review']);
    assert.deepEqual(stages.map((stage) => stage.id), ['developer', 'test-engineer', 'reviewer', 'human:in review', 'terminal:done']);
  });

  it('leaves the test engineer out when the set_status developer cannot move issues to Testing', () => {
    const stages = pipelineOf({ developer: developer(['Agent review', 'Blocked']), 'test-engineer': tester, reviewer }, ['Todo', 'Testing', 'Agent review']);
    assert.deepEqual(stages.map((stage) => stage.id), ['developer', 'reviewer', 'human:in review', 'terminal:done']);
  });

  it('shows a result role after a column that no role serves, because the implicit default role may move anywhere', () => {
    // A resolved config serves every active column, so take the developer out to leave Todo to the default role.
    const stages = pipelineOf({ developer: developer(['Agent review', 'Blocked']), 'test-engineer': tester, reviewer }, ['Todo', 'Testing', 'Agent review'], {}, (roles) =>
      roles.filter((role) => role.name !== 'developer'),
    );
    assert.deepEqual(stages.map((stage) => stage.id), ['default', 'test-engineer', 'reviewer', 'human:in review', 'terminal:done']);
  });

  it('ignores the moves of a role that serves other issues than this one (a command role)', () => {
    const roles = {
      developer: developer(['Agent review', 'Blocked']),
      auditor: { commands: ['refactoring'], states: ['Todo'], read_only: true },
      'test-engineer': tester,
      reviewer,
    };
    const stages = pipelineOf(roles, ['Todo', 'Testing', 'Agent review']);
    assert.deepEqual(stages.map((stage) => stage.id), ['developer', 'reviewer', 'human:in review', 'terminal:done']);
    // The /refactoring issue is served by the unrestricted auditor, which may move it to Testing.
    const commanded = pipelineOf(roles, ['Todo', 'Testing', 'Agent review'], { issue: { state: 'Todo', description: '/refactoring' } });
    assert.deepEqual(commanded.map((stage) => stage.id), ['auditor', 'test-engineer', 'reviewer', 'human:in review', 'terminal:done']);
  });
});

describe('blockedBucketColumns', () => {
  it('returns the shared Blocked column of the default roles', () => {
    assert.deepEqual(blockedBucketColumns(defaultRoles(), ACTIVE, TERMINAL), ['Blocked']);
  });

  it('is empty without roles', () => {
    assert.deepEqual(blockedBucketColumns(null, ACTIVE, TERMINAL), []);
  });
});
