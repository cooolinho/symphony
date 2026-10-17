import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planDispatch, planTime, type PlanInput, type PlanRetry } from '../src/orchestrator/dispatch-plan.ts';
import type { Issue } from '../src/tracker/types.ts';
import { baseFront, makeIssue, makeWorkflow, tempDir } from './helpers.ts';

const NOW = new Date('2026-10-03T12:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);

function input(overrides: Partial<PlanInput> = {}, front: Record<string, unknown> = {}): PlanInput {
  return {
    config: makeWorkflow(baseFront(tempDir(), front)).config,
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

function retry(issue: Issue, kind: PlanRetry['kind'], options: Partial<PlanRetry> = {}): PlanRetry {
  return { issue, kind, attempt: 1, dueAt: at(-1), due: true, limit: null, ...options };
}

/** [position, id, group, decision, reason code] per item: the shape most tests compare. */
const rows = (plan: ReturnType<typeof planDispatch>) => plan.map((item) => [item.position, item.issueId, item.group, item.decision, item.reason.code]);

describe('dispatch plan', () => {
  it('orders work in flight first: continuations, then due retries, then new candidates, each by priority', () => {
    const plan = planDispatch(
      input(
        {
          retries: [
            retry(makeIssue({ id: 'retry-p2', priority: 2 }), 'failure'),
            retry(makeIssue({ id: 'cont-p3', priority: 3 }), 'continuation', { dueAt: at(1_000) }),
            retry(makeIssue({ id: 'limit-p1', priority: 1 }), 'session_limit'),
            retry(makeIssue({ id: 'cont-p1', priority: 1 }), 'continuation', { dueAt: at(1_000) }),
          ],
          candidates: [makeIssue({ id: 'new-p4', priority: 4 }), makeIssue({ id: 'new-p1', priority: 1 })],
        },
        { agent: { max_concurrent_agents: 10 } },
      ),
    );
    assert.deepEqual(
      plan.map((item) => [item.position, item.issueId, item.kind]),
      [
        [1, 'cont-p1', 'continuation'],
        [2, 'cont-p3', 'continuation'],
        [3, 'limit-p1', 'session_limit'],
        [4, 'retry-p2', 'failure'],
        [5, 'new-p1', 'new'],
        [6, 'new-p4', 'new'],
      ],
    );
    assert.ok(plan.every((item) => item.decision === 'start' && item.reason.code === 'ready'));
    assert.deepEqual(plan.map((item) => item.reason.text).slice(0, 3), ['continues its session', 'continues its session', 'retry 1 starts now']);
    assert.equal(plan.at(-1)?.reason.text, 'starts at the next poll');
  });

  it('gives the slot of a continuation to the continuation, not to a new candidate with a higher priority', () => {
    const plan = planDispatch(
      input(
        {
          running: [{ state: 'Todo' }],
          retries: [retry(makeIssue({ id: 'cont', priority: 4 }), 'continuation', { dueAt: at(1_000) })],
          candidates: [makeIssue({ id: 'new', priority: 1 })],
        },
        { agent: { max_concurrent_agents: 2 } },
      ),
    );
    assert.deepEqual(rows(plan), [
      [1, 'cont', 'next', 'start', 'ready'],
      [2, 'new', 'next', 'wait', 'no_free_slot'],
    ]);
    assert.equal(plan[1]?.reason.text, 'waiting for a free slot (2/2 busy)');
  });

  it('hands out free slots in plan order and names the column limit', () => {
    const plan = planDispatch(
      input(
        {
          running: [{ state: 'Agent review' }],
          candidates: [
            makeIssue({ id: 'review', state: 'Agent review', priority: 1 }),
            makeIssue({ id: 'todo-1', priority: 2 }),
            makeIssue({ id: 'todo-2', priority: 3 }),
            makeIssue({ id: 'todo-3', priority: 4 }),
          ],
        },
        { agent: { max_concurrent_agents: 3, max_concurrent_agents_by_state: { 'agent review': 1 } }, tracker: { kind: 'github_project', active_states: ['Todo', 'Agent review'], provider: { owner: 'acme', project_number: 1, token: 't' } } },
      ),
    );
    assert.deepEqual(rows(plan), [
      [1, 'review', 'next', 'wait', 'column_limit'],
      [2, 'todo-1', 'next', 'start', 'ready'],
      [3, 'todo-2', 'next', 'start', 'ready'],
      [4, 'todo-3', 'next', 'wait', 'no_free_slot'],
    ]);
    assert.equal(plan[0]?.reason.text, 'Agent review limit 1/1');
    assert.equal(plan[3]?.reason.text, 'waiting for a free slot (3/3 busy)');
  });

  it('counts the column of a continuation against the column limit', () => {
    const plan = planDispatch(
      input(
        {
          retries: [retry(makeIssue({ id: 'cont', priority: 4 }), 'continuation')],
          candidates: [makeIssue({ id: 'new', priority: 1 })],
        },
        { agent: { max_concurrent_agents: 5, max_concurrent_agents_by_state: { todo: 1 } } },
      ),
    );
    assert.deepEqual(rows(plan), [
      [1, 'cont', 'next', 'start', 'ready'],
      [2, 'new', 'next', 'wait', 'column_limit'],
    ]);
    assert.equal(plan[1]?.reason.text, 'Todo limit 1/1');
  });

  it('names model holds, sub-issues and the dispatch gate; such an issue takes no slot', () => {
    const plan = planDispatch(
      input(
        {
          candidates: [
            makeIssue({ id: 'fable', priority: 1, labels: ['model: fable'] }),
            makeIssue({ id: 'wave', priority: 2 }),
            makeIssue({ id: 'plain', priority: 3 }),
          ],
          holds: new Map([['fable', { until: at(6 * 3600_000) }]]),
          waitingForSubIssues: (issue) => (issue.id === 'wave' ? ['acme/app#7', 'acme/app#8'] : []),
        },
        { agent: { max_concurrent_agents: 1 } },
      ),
    );
    assert.deepEqual(rows(plan), [
      [1, 'fable', 'next', 'wait', 'model_hold'],
      [2, 'wave', 'next', 'wait', 'waiting_for_sub_issues'],
      [3, 'plain', 'next', 'start', 'ready'],
    ]);
    assert.equal(plan[0]?.reason.text, 'model fable on hold until 2026-10-03 18:00 UTC');
    assert.equal(plan[0]?.model, 'fable');
    assert.equal(plan[1]?.reason.text, 'waiting for sub-issues acme/app#7, acme/app#8');

    // An ended hold no longer counts; the gate holds back new candidates only.
    const gated = planDispatch(
      input({
        candidates: [makeIssue({ id: 'fable', labels: ['model: fable'] })],
        retries: [retry(makeIssue({ id: 'retry' }), 'failure')],
        holds: new Map([['fable', { until: at(-1) }]]),
        gate: { until: at(3600_000), window: 'five_hour' },
      }),
    );
    assert.deepEqual(rows(gated), [
      [1, 'retry', 'next', 'start', 'ready'],
      [2, 'fable', 'next', 'wait', 'session_limit'],
    ]);
    assert.equal(gated[1]?.reason.text, 'new sessions paused until 2026-10-03 13:00 UTC: session limit (five hour)');
  });

  it('lists retries before their due time as waiting, soonest first, with backoff and session limit reasons', () => {
    const limit = { window: 'five_hour', scope: 'account' as const, model: null, waiting: true, hits: 4, maxRetries: 3 };
    const plan = planDispatch(
      input({
        retries: [
          retry(makeIssue({ id: 'reset' }), 'session_limit', { due: false, dueAt: at(2 * 3600_000), limit }),
          retry(makeIssue({ id: 'backoff' }), 'failure', { due: false, dueAt: at(20_000), attempt: 2 }),
          retry(makeIssue({ id: 'quick' }), 'session_limit', { due: false, dueAt: at(10_000), limit: { ...limit, waiting: false, hits: 1 } }),
          retry(makeIssue({ id: 'fable', labels: ['model: fable'] }), 'session_limit', {
            due: false,
            dueAt: at(3600_000),
            limit: { ...limit, scope: 'model', model: 'fable', window: 'seven_day_fable' },
          }),
        ],
      }),
    );
    assert.deepEqual(rows(plan), [
      [null, 'quick', 'waiting', 'wait', 'session_limit'],
      [null, 'backoff', 'waiting', 'wait', 'backoff'],
      [null, 'fable', 'waiting', 'wait', 'model_hold'],
      [null, 'reset', 'waiting', 'wait', 'session_limit'],
    ]);
    assert.deepEqual(
      plan.map((item) => item.reason.text),
      [
        'session limit: retry 1 of 3 at 2026-10-03 12:00 UTC',
        'retry 2 after a failure at 2026-10-03 12:00 UTC',
        'model fable on hold until 2026-10-03 13:00 UTC',
        'session limit (five hour): retry after the reset at 2026-10-03 14:00 UTC',
      ],
    );
    assert.deepEqual(plan[1]?.dueAt, at(20_000));
  });

  it('keeps a retry of an issue that left the active columns out of the slots', () => {
    const plan = planDispatch(
      input(
        {
          retries: [retry(makeIssue({ id: 'gone', state: 'Human Review' }), 'continuation', { dueAt: at(1_000) })],
          candidates: [makeIssue({ id: 'new' })],
        },
        { agent: { max_concurrent_agents: 1 } },
      ),
    );
    assert.deepEqual(rows(plan), [
      [1, 'new', 'next', 'start', 'ready'],
      [null, 'gone', 'waiting', 'wait', 'inactive'],
    ]);
    assert.equal(plan[1]?.reason.text, 'left the active columns ("Human Review"); released at 2026-10-03 12:00 UTC');
  });

  it('lists paused issues, then candidates that are blocked or miss a required label', () => {
    const plan = planDispatch(
      input(
        {
          paused: [{ issue: makeIssue({ id: 'paused', labels: ['ai'] }), continuations: 3 }],
          candidates: [
            makeIssue({ id: 'partly', labels: ['AI'] }),
            makeIssue({ id: 'unlabeled', labels: ['bug'] }),
            makeIssue({ id: 'blocked', labels: ['ai'], dispatchable: false, native_ref: { dispatch_note: 'blocked by acme/app#9' } }),
            makeIssue({ id: 'assigned', labels: ['ai'], dispatchable: false }),
            makeIssue({ id: 'done', labels: ['ai'], state: 'Done' }),
          ],
        },
        { tracker: { kind: 'github_project', required_labels: ['ai', 'ready'], provider: { owner: 'acme', project_number: 1, token: 't' } } },
      ),
    );
    // Same priority and age: the identifier decides; a candidate outside the active columns is not listed.
    assert.deepEqual(
      plan.map((item) => [item.issueId, item.group, item.reason.code, item.reason.text]),
      [
        ['paused', 'paused', 'paused', 'paused after 3 continuation sessions; change the issue on the board to resume'],
        ['assigned', 'blocked', 'blocked', 'not dispatchable'],
        ['blocked', 'blocked', 'blocked', 'blocked by acme/app#9'],
        ['partly', 'blocked', 'missing_label', 'missing required label ready'],
        ['unlabeled', 'blocked', 'missing_label', 'missing required labels ai, ready'],
      ],
    );
    assert.ok(plan.every((item) => item.position === null && item.decision === 'wait'));
  });

  it('formats reason times in UTC', () => {
    assert.equal(planTime(new Date('2026-10-03T18:00:59Z')), '2026-10-03 18:00 UTC');
  });
});
