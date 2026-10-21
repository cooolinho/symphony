import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { effectiveAgentLimits, limitsJson, NO_LIMIT_OVERRIDE, slotProblems } from '../src/orchestrator/limits.ts';
import type { ServiceConfig } from '../src/workflow/config.ts';
import { baseFront, makeWorkflow, tempDir } from './helpers.ts';

/** The shipped pipeline: a developer and a reviewer with a reserved slot each, and the optional test engineer between them. */
function configOf(agent: Record<string, unknown>, roles: Record<string, unknown> = {}): ServiceConfig {
  return makeWorkflow(
    baseFront(tempDir('symphony-limits-'), {
      agent,
      tracker: {
        kind: 'github_project',
        provider: { owner: 'acme', project_number: 1, token: 'test-token' },
        active_states: ['Ready', 'Testing', 'Agent review'],
        terminal_states: ['Done'],
      },
      roles: {
        developer: { states: ['Ready'], result: 'implementation', on_result: { done: 'Testing', blocked: 'Blocked' }, may_move_to: ['Testing', 'Blocked'] },
        'test-engineer': { states: ['Testing'], result: 'test', on_result: { passed: 'Agent review', failed: 'Ready' }, may_move_to: ['Agent review', 'Ready', 'Blocked'] },
        reviewer: { states: ['Agent review'], read_only: true, result: 'review', on_result: { approved: 'In review', changes_needed: 'Ready' }, may_move_to: ['In review', 'Ready', 'Blocked'] },
        ...roles,
      },
    }),
  ).config;
}

const problems = (config: ServiceConfig) => slotProblems(config, effectiveAgentLimits(config, NO_LIMIT_OVERRIDE));

describe('slotProblems', () => {
  it('names a role that results lead to and whose column the other reservations keep without a slot', () => {
    const config = configOf({ max_concurrent_agents: 2, reserved_slots_by_role: { developer: 1, reviewer: 1 } });
    assert.deepEqual(problems(config), [
      'role test-engineer never starts in Testing: the reservations of the other roles (developer 1 + reviewer 1 = 2) take every one of the 2 agent slots; raise the limit or reserve a slot for test-engineer',
    ]);
    assert.deepEqual(limitsJson(config, NO_LIMIT_OVERRIDE).slot_problems, problems(config));
  });

  it('is silent once a third slot is free, the role has its own reservation or nothing is reserved', () => {
    assert.deepEqual(problems(configOf({ max_concurrent_agents: 3, reserved_slots_by_role: { developer: 1, reviewer: 1 } })), []);
    assert.deepEqual(problems(configOf({ max_concurrent_agents: 3, reserved_slots_by_role: { developer: 1, reviewer: 1, 'test-engineer': 1 } })), []);
    assert.deepEqual(problems(configOf({ max_concurrent_agents: 2 })), []);
  });

  it('stays silent while the reservations exceed the limit and are ignored', () => {
    // developer 1 + reviewer 1 + test-engineer 1 = 3 > 2: the reservations are ignored, so every role gets a slot.
    assert.deepEqual(problems(configOf({ max_concurrent_agents: 2, reserved_slots_by_role: { developer: 1, reviewer: 1, 'test-engineer': 1 } })), []);
  });

  it('is silent at a limit of 0, which pauses new dispatches anyway', () => {
    assert.deepEqual(problems(configOf({ max_concurrent_agents: 0, reserved_slots_by_role: { developer: 1, reviewer: 1 } })), []);
  });

  it('leaves out a command role that no result leads to', () => {
    // The planner gets no slot either, but it serves /plan issues only and no result routes to its column.
    const config = configOf(
      { max_concurrent_agents: 3, reserved_slots_by_role: { developer: 1, reviewer: 1, 'test-engineer': 1 } },
      { planner: { states: ['Ready'], commands: ['plan'], read_only: true } },
    );
    assert.deepEqual(problems(config), []);
  });

  it('follows the dashboard override of the limit and the reservations', () => {
    const config = configOf({ max_concurrent_agents: 3, reserved_slots_by_role: { developer: 1, reviewer: 1 } });
    const lowered = { ...NO_LIMIT_OVERRIDE, maxConcurrentAgents: 2 };
    assert.equal(limitsJson(config, lowered).slot_problems.length, 1);
    assert.deepEqual(limitsJson(config, NO_LIMIT_OVERRIDE).slot_problems, []);
  });
});
