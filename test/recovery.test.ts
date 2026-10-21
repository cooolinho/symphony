import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { interruptedLabels, interruptedTransition, statusUpdatedAt } from '../src/orchestrator/recovery.ts';
import type { TrackedResult } from '../src/tracker/types.ts';
import { parseResult, type ResultMeta } from '../src/workflow/results.ts';
import { makeWorkflow, tempDir, baseFront } from './helpers.ts';

const BOARD = ['Ready', 'In progress', 'Agent review', 'Blocked', 'In review', 'Done'];

const config = makeWorkflow(
  baseFront(tempDir(), {
    tracker: { kind: 'github_project', provider: { owner: 'acme', project_number: 1, token: 'test-token' }, active_states: ['Ready', 'In progress', 'Agent review'] },
    roles: {
      developer: { states: ['Ready', 'In progress'], result: 'implementation', may_move_to: ['In progress', 'Agent review', 'Blocked'], on_result: { done: 'Agent review' } },
      reviewer: {
        states: ['Agent review'],
        read_only: true,
        result: 'review',
        may_move_to: ['In review', 'In progress', 'Blocked'],
        on_result: { approved: 'In review', changes_needed: 'In progress' },
        on_round_limit: 'In review',
        on_check_failed: 'In progress',
      },
    },
    pipeline: { max_review_rounds: 2 },
  }),
).config;
const reviewer = config.roles?.find((role) => role.name === 'reviewer');
assert.ok(reviewer !== undefined);

let seq = 0;
/** A persisted review whose comment GitHub created at `at`. */
function review(verdict: 'approved' | 'changes_needed', at: string, meta: Partial<ResultMeta> = {}): TrackedResult {
  const parsed = parseResult('review', { verdict, summary: 's', ...(verdict === 'changes_needed' ? { findings: [{ severity: 'major', problem: 'p' }] } : {}) });
  assert.ok(parsed.ok);
  seq++;
  return {
    result: parsed.result,
    meta: { role: 'reviewer', run: `run-${seq}`, round: null, profile: null, workflow_hash: null, head_sha: null, checks: null, target: 'In review', created_at: at, ...meta },
    createdAt: new Date(at),
    url: `https://github.com/acme/app/issues/1#c${seq}`,
  };
}

const inReview = (updatedAt: string | null, state = 'Agent review') => ({ state, native_ref: updatedAt === null ? null : { status_updated_at: updatedAt } });

describe('interruptedTransition', () => {
  const approved = review('approved', '2026-10-18T10:00:05Z');

  it('a result whose column has not changed since: its target', () => {
    const found = interruptedTransition(inReview('2026-10-18T09:00:00Z'), reviewer, [approved]);
    assert.equal(found?.target, 'In review');
    assert.equal(found?.result, approved);
    assert.equal(found?.statusUpdatedAt, '2026-10-18T09:00:00.000Z');
  });

  const none: Array<[string, Parameters<typeof interruptedTransition>]> = [
    ['without status_updated_at', [inReview(null), reviewer, [approved]]],
    ['with an unparseable status_updated_at', [{ state: 'Agent review', native_ref: { status_updated_at: 'soon' } }, reviewer, [approved]]],
    ['without results', [inReview('2026-10-18T09:00:00Z'), reviewer, []]],
    ['without a role', [inReview('2026-10-18T09:00:00Z'), null, [approved]]],
    ['when the column moved after the comment', [inReview('2026-10-18T10:00:06Z'), reviewer, [approved]]],
    ['when the column moved in the same second as the comment', [inReview('2026-10-18T10:00:05.900Z'), reviewer, [review('approved', '2026-10-18T10:00:05.100Z')]]],
    ['when the newest result comes from another role', [inReview('2026-10-18T09:00:00Z'), reviewer, [approved, review('approved', '2026-10-18T10:00:09Z', { role: 'developer', target: 'Agent review' })]]],
    ['when the result leads to the current column', [inReview('2026-10-18T09:00:00Z', 'In review'), reviewer, [approved]]],
    ['when the result names no target', [inReview('2026-10-18T09:00:00Z'), reviewer, [review('approved', '2026-10-18T10:00:05Z', { target: null })]]],
  ];
  for (const [name, args] of none) it(`none ${name}`, () => assert.equal(interruptedTransition(...args), null));

  it('picks the newest result by the comment time, not by its meta', () => {
    const late = review('changes_needed', '2026-10-18T10:00:09Z', { target: 'In progress', created_at: '2026-10-18T08:00:00Z' });
    assert.equal(interruptedTransition(inReview('2026-10-18T09:00:00Z'), reviewer, [late, approved])?.target, 'In progress');
  });

  it('statusUpdatedAt reads native_ref', () => {
    assert.equal(statusUpdatedAt(inReview('2026-10-18T09:00:00Z'))?.toISOString(), '2026-10-18T09:00:00.000Z');
    assert.equal(statusUpdatedAt({ native_ref: { status_updated_at: 42 } }), null);
  });
});

describe('interruptedLabels', () => {
  const issue = { labels: [], description: null };
  const interrupted = (tracked: TrackedResult[]) => {
    const found = interruptedTransition(inReview('2026-10-18T09:00:00Z'), reviewer, tracked);
    assert.ok(found !== null);
    return found;
  };

  it('the round limit adds the limit label, counting a repeated comment of the interrupted run once', () => {
    const first = review('changes_needed', '2026-10-18T08:00:00Z', { target: 'In progress' });
    const limit = review('changes_needed', '2026-10-18T10:00:05Z', { run: 'r2', target: 'In review' });
    const repeated = { ...limit, createdAt: new Date('2026-10-18T10:00:04Z') };
    const tracked = [first, repeated, limit];
    assert.deepEqual(interruptedLabels(interrupted(tracked), tracked, reviewer, config, BOARD, issue), { add: ['needs-human'], remove: [] });
  });

  it('any other result removes it', () => {
    const tracked = [review('approved', '2026-10-18T10:00:05Z')];
    assert.deepEqual(interruptedLabels(interrupted(tracked), tracked, reviewer, config, BOARD, issue), { add: [], remove: ['needs-human'] });
  });

  it('a target the result does not route to (an on_check_failed fallback) changes no labels', () => {
    const tracked = [review('approved', '2026-10-18T10:00:05Z', { target: 'In progress' })];
    assert.deepEqual(interruptedLabels(interrupted(tracked), tracked, reviewer, config, BOARD, issue), { add: [], remove: [] });
  });
});
