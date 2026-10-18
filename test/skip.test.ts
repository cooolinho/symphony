import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { skipCheckProblems, skipReason, stageSkip } from '../src/orchestrator/skip.ts';
import { roleFor } from '../src/workflow/roles.ts';
import { baseFront, makeIssue, makeWorkflow, tempDir } from './helpers.ts';

const BOARD = ['Backlog', 'Ready', 'In progress', 'Agent review', 'Blocked', 'In review', 'Done'];

function configOf(extra: Record<string, unknown> = {}) {
  const front = baseFront(tempDir('symphony-skip-'), {
    tracker: {
      kind: 'github_project',
      provider: { owner: 'acme', project_number: 1, token: 'test-token' },
      active_states: ['Ready', 'In progress', 'Agent review'],
      terminal_states: ['Done'],
    },
    roles: {
      analyst: { states: ['Ready'], read_only: true, result: 'analysis' },
      developer: { states: ['In progress'] },
      reviewer: { states: ['Agent review'], read_only: true },
    },
    pipeline: { analysis: 'when_unlabeled' },
    ...extra,
  });
  return makeWorkflow(front).config;
}

const issueIn = (state: string, labels: string[]) => makeIssue({ id: 'a', state, labels });

describe('skipReason', () => {
  const config = configOf({ pipeline: { analysis: 'when_unlabeled', profiles: { refactor: { skip: ['reviewer'] } } } });
  const role = (name: string) => config.roles?.find((candidate) => candidate.name === name) ?? assert.fail(`no role ${name}`);

  it('skips the analyst only when Type and Complexity are both set', () => {
    assert.match(skipReason({ labels: ['Type: bugfix', 'Complexity: S'] }, role('analyst'), config) ?? '', /already has Type and Complexity/);
    assert.match(skipReason({ labels: ['bug', 'Complexity: XL'] }, role('analyst'), config) ?? '', /already has/);
    assert.equal(skipReason({ labels: ['Type: bugfix'] }, role('analyst'), config), null);
    assert.equal(skipReason({ labels: ['Complexity: S'] }, role('analyst'), config), null);
    assert.equal(skipReason({ labels: ['Type: bugfix', 'Complexity: S', 'Complexity: L'] }, role('analyst'), config), null, 'conflicting labels count as unset');
    assert.equal(skipReason({ labels: [] }, role('analyst'), config), null);
  });

  it('runs the analyst for every issue with pipeline.analysis: always', () => {
    const always = configOf({ pipeline: { analysis: 'always' } });
    assert.equal(skipReason({ labels: ['Type: bugfix', 'Complexity: S'] }, always.roles?.[0] ?? assert.fail('no role'), always), null);
  });

  it('skips the roles the profile of the issue type lists', () => {
    assert.equal(skipReason({ labels: ['Type: refactor'] }, role('reviewer'), config), 'skipped by profile refactor');
    assert.equal(skipReason({ labels: ['Type: bugfix'] }, role('reviewer'), config), null);
    assert.equal(skipReason({ labels: ['Type: refactor'] }, role('developer'), config), null);
  });
});

describe('stageSkip', () => {
  const config = configOf();
  const analyst = roleFor({ state: 'Ready', description: null }, config.roles);

  it('targets the next active column', () => {
    const skip = stageSkip(issueIn('Ready', ['Type: bugfix', 'Complexity: S']), analyst, config, BOARD);
    assert.deepEqual(skip && { role: skip.role, target: skip.target, profile: skip.profile }, { role: 'analyst', target: 'In progress', profile: null });
  });

  it('runs the stage when nothing excludes it, the board order is unknown or no role is configured', () => {
    assert.equal(stageSkip(issueIn('Ready', []), analyst, config, BOARD), null);
    assert.equal(stageSkip(issueIn('Ready', ['Type: bugfix', 'Complexity: S']), analyst, config, null), null);
    assert.equal(stageSkip(issueIn('Ready', ['Type: bugfix', 'Complexity: S']), analyst, config, []), null);
    assert.equal(stageSkip(issueIn('Ready', ['Type: bugfix', 'Complexity: S']), null, config, BOARD), null);
  });

  it('runs the stage when the target column has an entry check or no needed stage follows', () => {
    const checked = configOf({ checks: { on_enter: { 'in progress': 'true' } } });
    assert.equal(stageSkip(issueIn('Ready', ['Type: bugfix', 'Complexity: S']), analyst, checked, BOARD), null);
    const all = configOf({ pipeline: { profiles: { default: { skip: ['analyst', 'developer', 'reviewer'] } } } });
    assert.equal(stageSkip(issueIn('Ready', []), analyst, all, BOARD), null);
  });
});

describe('skipCheckProblems', () => {
  it('reports skipping into a column with an entry check', () => {
    const config = configOf({
      checks: { on_enter: { 'Agent review': 'true' } },
      pipeline: { analysis: 'always', profiles: { bugfix: { skip: ['developer'] } } },
    });
    assert.deepEqual(skipCheckProblems(config, BOARD), [
      'pipeline.profiles.bugfix.skip: skipping developer moves issues from "In progress" to "Agent review" without a workspace, but checks.on_enter has a script for "Agent review"',
    ]);
  });

  it('accepts columns without checks and unknown board order', () => {
    const config = configOf({ checks: { on_enter: { 'In review': 'true' } } });
    assert.deepEqual(skipCheckProblems(config, BOARD), []);
    assert.deepEqual(skipCheckProblems(configOf({ checks: { on_enter: { 'In progress': 'true' } } }), null), []);
  });
});
