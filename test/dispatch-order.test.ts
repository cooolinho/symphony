import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planDispatch, type PlanInput, type PlanRetry } from '../src/orchestrator/dispatch-plan.ts';
import { sortForDispatch } from '../src/orchestrator/eligibility.ts';
import type { Issue } from '../src/tracker/types.ts';
import { baseFront, makeIssue, makeWorkflow, tempDir } from './helpers.ts';

const BOARD = ['Ready', 'Design', 'In progress', 'Testing', 'Documentation', 'Agent review', 'Security review'];
const NOW = new Date('2026-10-03T12:00:00Z');
const tracker = { kind: 'github_project', active_states: BOARD, provider: { owner: 'acme', project_number: 1, token: 't' } };

const configOf = (agent: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) =>
  makeWorkflow(baseFront(tempDir(), { tracker, agent }), { env }).config;

function input(overrides: Partial<PlanInput>, agent: Record<string, unknown>): PlanInput {
  return {
    config: configOf(agent),
    now: NOW,
    running: [],
    retries: [],
    paused: [],
    candidates: [],
    holds: new Map(),
    gate: null,
    waitingForSubIssues: () => [],
    ...overrides,
  };
}

const retry = (issue: Issue, kind: PlanRetry['kind']): PlanRetry => ({ issue, kind, attempt: 1, dueAt: new Date(NOW.getTime() - 1), due: true, limit: null });

const issues = () => [
  makeIssue({ id: 'ready-p1-old', state: 'Ready', priority: 1, created_at: new Date('2025-01-01') }),
  makeIssue({ id: 'progress-p2', state: 'In progress', priority: 2, created_at: new Date('2026-01-01') }),
  makeIssue({ id: 'review-p3-new', state: 'agent review', priority: 3, created_at: new Date('2026-06-01') }),
  makeIssue({ id: 'review-p3-old', state: ' Agent Review ', priority: 3, created_at: new Date('2026-05-01') }),
  makeIssue({ id: 'review-p1', state: 'Agent review', priority: 1, created_at: new Date('2026-07-01') }),
  makeIssue({ id: 'security', state: 'Security review', priority: null, created_at: null }),
  makeIssue({ id: 'elsewhere', state: 'Backlog', priority: 1, created_at: new Date('2020-01-01') }),
];

describe('sortForDispatch', () => {
  it('priority (default): priority, then age, then identifier; the column does not count', () => {
    const ids = sortForDispatch(issues(), { activeStates: BOARD }).map((i) => i.id);
    assert.deepEqual(ids, ['elsewhere', 'ready-p1-old', 'review-p1', 'progress-p2', 'review-p3-old', 'review-p3-new', 'security']);
    assert.deepEqual(sortForDispatch(issues(), { order: 'priority', activeStates: BOARD }).map((i) => i.id), ids);
    assert.deepEqual(sortForDispatch(issues()).map((i) => i.id), ids);
  });

  it('column_first: rightmost column first (normalized names), then priority, age and identifier; unknown states last', () => {
    const ids = sortForDispatch(issues(), { order: 'column_first', activeStates: BOARD }).map((i) => i.id);
    assert.deepEqual(ids, ['security', 'review-p1', 'review-p3-old', 'review-p3-new', 'progress-p2', 'ready-p1-old', 'elsewhere']);
  });

  it('column_first without active states falls back to the priority order', () => {
    const ids = sortForDispatch(issues(), { order: 'column_first' }).map((i) => i.id);
    assert.deepEqual(ids, sortForDispatch(issues()).map((i) => i.id));
  });

  it('breaks ties inside a column by identifier', () => {
    const same = { state: 'Testing', priority: 2, created_at: new Date('2026-01-01') };
    const ids = sortForDispatch([makeIssue({ id: 'b', ...same }), makeIssue({ id: 'a', ...same })], { order: 'column_first', activeStates: BOARD }).map((i) => i.id);
    assert.deepEqual(ids, ['a', 'b']);
  });
});

describe('agent.dispatch_order', () => {
  it('defaults to priority', () => {
    assert.equal(configOf().agent.dispatchOrder, 'priority');
  });

  it('reads column_first, also through ${SYMPHONY_DISPATCH_ORDER:-priority}', () => {
    assert.equal(configOf({ dispatch_order: 'column_first' }).agent.dispatchOrder, 'column_first');
    const fromEnv = (env: NodeJS.ProcessEnv) => configOf({ dispatch_order: '${SYMPHONY_DISPATCH_ORDER:-priority}' }, env).agent.dispatchOrder;
    assert.equal(fromEnv({ SYMPHONY_DISPATCH_ORDER: 'column_first' }), 'column_first');
    assert.equal(fromEnv({}), 'priority');
  });

  it('rejects an unknown value', () => {
    assert.throws(() => configOf({ dispatch_order: 'newest' }), /agent\.dispatch_order must be one of priority, column_first/);
  });
});

describe('planDispatch with dispatch_order', () => {
  const candidates = () => [
    makeIssue({ id: 'ready-p1', state: 'Ready', priority: 1, created_at: new Date('2025-01-01') }),
    makeIssue({ id: 'review-p4', state: 'Agent review', priority: 4, created_at: new Date('2026-09-01') }),
  ];

  it('column_first: an Agent review issue gets the free slot before an older p1 Ready issue', () => {
    const plan = planDispatch(input({ candidates: candidates() }, { max_concurrent_agents: 1, dispatch_order: 'column_first' }));
    assert.deepEqual(
      plan.map((item) => [item.position, item.issueId, item.decision, item.reason.code]),
      [
        [1, 'review-p4', 'start', 'ready'],
        [2, 'ready-p1', 'wait', 'no_free_slot'],
      ],
    );
  });

  it('priority: the older p1 Ready issue keeps the slot (unchanged behaviour)', () => {
    const plan = planDispatch(input({ candidates: candidates() }, { max_concurrent_agents: 1 }));
    assert.deepEqual(
      plan.map((item) => [item.position, item.issueId, item.decision]),
      [
        [1, 'ready-p1', 'start'],
        [2, 'review-p4', 'wait'],
      ],
    );
  });

  it('column_first sorts due retries by column too; continuations stay ahead of failure retries', () => {
    const plan = planDispatch(
      input(
        {
          retries: [
            retry(makeIssue({ id: 'fail-ready', state: 'Ready', priority: 1 }), 'failure'),
            retry(makeIssue({ id: 'fail-security', state: 'Security review', priority: 4 }), 'failure'),
            retry(makeIssue({ id: 'cont-ready', state: 'Ready', priority: 1 }), 'continuation'),
            retry(makeIssue({ id: 'cont-review', state: 'Agent review', priority: 4 }), 'continuation'),
          ],
        },
        { max_concurrent_agents: 10, dispatch_order: 'column_first' },
      ),
    );
    assert.deepEqual(plan.map((item) => item.issueId), ['cont-review', 'cont-ready', 'fail-security', 'fail-ready']);
  });

  it('column_first keeps column limits: a review at its limit takes no slot, the Ready issue gets it', () => {
    const plan = planDispatch(
      input(
        { running: [{ state: 'Agent review' }], candidates: candidates() },
        { max_concurrent_agents: 2, dispatch_order: 'column_first', max_concurrent_agents_by_state: { 'Agent review': 1 } },
      ),
    );
    assert.deepEqual(
      plan.map((item) => [item.issueId, item.decision, item.reason.code]),
      [
        ['review-p4', 'wait', 'column_limit'],
        ['ready-p1', 'start', 'ready'],
      ],
    );
  });
});
