import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildStageHistory, docsBaseHead, type PersistedResult } from '../src/orchestrator/stage-history.ts';
import { resolveTransition } from '../src/orchestrator/transitions.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { parseResult, type ResultMeta } from '../src/workflow/results.ts';
import { unknownBoardColumns } from '../src/workflow/validate.ts';

/** The docs role hands a red entry check of Agent review back to the developer (#569): the shipped workflow and its documentation. */

const root = path.join(import.meta.dirname, '..');
const shippedPath = path.join(root, 'WORKFLOW.md');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');
const BOARD = ['Backlog', 'Ready', 'Design', 'In progress', 'Testing', 'Documentation', 'Agent review', 'Security review', 'Blocked', 'In review', 'Done'];
const ENV = { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' };

async function shipped() {
  const { definition } = await loadWorkflowFile(shippedPath);
  return resolveConfig(definition.config, { workflowPath: shippedPath, env: ENV, trackerDefaults });
}

describe('shipped WORKFLOW.md', () => {
  it('docs: on_check_failed is In progress and may_move_to lists it, next to Agent review and Blocked', async () => {
    const docs = (await shipped()).roles?.find((role) => role.name === 'docs');
    assert.ok(docs);
    assert.equal(docs.onCheckFailed, 'In progress');
    for (const column of ['Agent review', 'In progress', 'Blocked']) assert.ok(docs.mayMoveTo?.includes(column), column);
    assert.equal(docs.readOnly, false, 'the docs role is not read-only: the fallback is by role, not by read_only');
  });

  it('the board preflight accepts it, and a board without In progress is reported', async () => {
    const config = await shipped();
    assert.deepEqual(unknownBoardColumns(config, BOARD), []);
    assert.ok(unknownBoardColumns(config, BOARD.filter((column) => column !== 'In progress')).length > 0);
  });

  it('the test engineer still has no on_check_failed', async () => {
    const tester = (await shipped()).roles?.find((role) => role.result === 'test');
    assert.ok(tester);
    assert.equal(tester.onCheckFailed, null);
  });

  it('docs blocked still routes to Blocked and done to Agent review', async () => {
    const config = await shipped();
    const docs = config.roles?.find((role) => role.name === 'docs');
    assert.ok(docs);
    const route = (verdict: string) => {
      const outcome = resolveTransition({ role: docs, verdict, history: { reviewRounds: 0, testRounds: 0 }, profile: null, config, boardColumns: BOARD });
      assert.ok(outcome.ok, verdict);
      return outcome.target;
    };
    assert.deepEqual([route('done'), route('not_needed'), route('blocked')], ['Agent review', 'Agent review', 'Blocked']);
  });
});

describe('docs path rule baseline after the fallback', () => {
  const meta = (over: Partial<ResultMeta>): ResultMeta => ({ role: 'developer', run: 'r', round: null, profile: null, workflow_hash: null, head_sha: null, checks: null, target: null, created_at: '2026-11-09T10:00:00.000Z', ...over });
  const entry = (kind: 'implementation' | 'docs', args: Record<string, unknown>, over: Partial<ResultMeta>): PersistedResult => ({
    result: (parseResult(kind, args) as { ok: true; result: never }).result,
    meta: meta(over),
  });

  it('measures from the developer hand-off after the docs result that went back to In progress', () => {
    const history = buildStageHistory([
      entry('implementation', { verdict: 'done', summary: 's' }, { run: 'r1', head_sha: 'aaaaaaaaaaaa', created_at: '2026-11-09T10:00:00.000Z' }),
      entry('docs', { verdict: 'done', summary: 'd', files: ['docs/a.md'] }, { role: 'docs', run: 'r2', head_sha: 'bbbbbbbbbbbb', target: 'In progress', check_failed_for: 'Agent review', created_at: '2026-11-09T10:05:00.000Z' }),
      entry('implementation', { verdict: 'done', summary: 's2' }, { run: 'r3', head_sha: 'cccccccccccc', created_at: '2026-11-09T10:10:00.000Z' }),
    ]);
    assert.equal(docsBaseHead(history), 'cccccccccccc');
    assert.equal(history.checkFailures, 1, 'the docs hand-off counts as a check failure');
  });
});

describe('documentation of the docs fallback', () => {
  it('roles/developer.md names the latest result, not only the review', () => {
    assert.match(read('roles/developer.md'), /the latest result names the failed entry check/);
  });

  it('roles/docs.md: a red check in foreign files is no reason for blocked', () => {
    const text = read('roles/docs.md');
    assert.match(text, /on_check_failed/);
    assert.match(text, /no reason for `blocked`/);
  });

  it('docs/configuration.md and docs/results.md name the docs role for on_check_failed', () => {
    assert.match(read('docs/configuration.md'), /\| `on_check_failed` \|[^\n]*docs role/);
    assert.match(read('docs/results.md'), /`read_only` role or the docs role/);
  });
});
