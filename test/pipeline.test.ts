import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { blockedBucketColumns, derivePipeline, type PipelineInput, type StageSession } from '../src/orchestrator/pipeline.ts';
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

describe('blockedBucketColumns', () => {
  it('returns the shared Blocked column of the default roles', () => {
    assert.deepEqual(blockedBucketColumns(defaultRoles(), ACTIVE, TERMINAL), ['Blocked']);
  });

  it('is empty without roles', () => {
    assert.deepEqual(blockedBucketColumns(null, ACTIVE, TERMINAL), []);
  });
});
