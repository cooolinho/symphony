import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { describe, it } from 'node:test';
import { BOARD_COLUMNS, mergeBoardColumns, missingBoardColumns, type StatusOption } from '../src/repo-init/board.ts';
import { runRepoInit } from '../src/repo-init/main.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { unknownBoardColumns } from '../src/workflow/validate.ts';
import { tempDir } from './helpers.ts';

const shipped = path.join(import.meta.dirname, '..', 'WORKFLOW.md');
const option = (name: string, id = `id-${name}`): StatusOption => ({ id, name, color: 'BLUE', description: `${name} column` });
const KANBAN = ['Backlog', 'Ready', 'In progress', 'In review', 'Done'].map((name) => option(name));

describe('repo-init board columns', () => {
  it('covers every column the shipped WORKFLOW.md references', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const config = resolveConfig(definition.config, {
      workflowPath: shipped,
      env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' },
      trackerDefaults,
    });
    assert.deepEqual(unknownBoardColumns(config, BOARD_COLUMNS), []);
  });

  it('finds the missing columns case-insensitively, in board order', () => {
    assert.deepEqual(missingBoardColumns([]), [...BOARD_COLUMNS]);
    assert.deepEqual(missingBoardColumns(KANBAN), ['Design', 'Testing', 'Documentation', 'Agent review', 'Security review', 'Blocked']);
    assert.deepEqual(missingBoardColumns(BOARD_COLUMNS.map((name) => option(name.toUpperCase()))), []);
  });

  it('inserts the missing columns at their place and keeps the existing options untouched', () => {
    const merged = mergeBoardColumns(KANBAN);
    assert.deepEqual(merged.map((entry) => entry.name), [...BOARD_COLUMNS]);
    for (const existing of KANBAN) assert.deepEqual(merged.find((entry) => entry.name === existing.name), existing);
    assert.deepEqual(merged.find((entry) => entry.name === 'Design'), { name: 'Design', color: 'GRAY', description: '' });
  });

  it('keeps a custom order and extra columns, and puts a missing first column in front', () => {
    const board = ['Ready', 'Waiting', 'Done', 'In progress'].map((name) => option(name));
    const names = mergeBoardColumns(board).map((entry) => entry.name);
    assert.equal(names[0], 'Backlog');
    assert.ok(names.includes('Waiting'));
    assert.ok(names.indexOf('Design') === names.indexOf('Ready') + 1);
    assert.equal(names.length, BOARD_COLUMNS.length + 1);
    assert.deepEqual(mergeBoardColumns([]).map((entry) => entry.name), [...BOARD_COLUMNS]);
  });
});

/** Fake GitHub GraphQL endpoint with one board. */
function fakeGraphql(options: StatusOption[]) {
  const mutations: Array<Record<string, unknown>> = [];
  const fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    if (/^\s*mutation/.test(body.query)) {
      mutations.push(body.variables);
      return Response.json({ data: { updateProjectV2Field: { projectV2Field: { id: 'F1', options: [] } } } });
    }
    assert.equal(body.variables.owner, 'acme');
    assert.equal(body.variables.number, 7);
    return Response.json({
      data: {
        repositoryOwner: {
          projectV2: { title: 'Acme board', url: 'https://github.com/orgs/acme/projects/7', field: { __typename: 'ProjectV2SingleSelectField', id: 'F1', name: 'Status', options } },
        },
      },
    });
  };
  return { fetch, mutations };
}

async function run(answers: string[], env: NodeJS.ProcessEnv, fetch: typeof globalThis.fetch, argv = ['--task', 'board']) {
  const input = new PassThrough();
  input.end(answers.map((answer) => `${answer}\n`).join(''));
  let text = '';
  const output = new Writable({
    write(chunk, _encoding, done) {
      text += String(chunk);
      done();
    },
  });
  const code = await runRepoInit({ argv, env, rootDir: tempDir(), input, output, fetch });
  return { code, text };
}

describe('repo-init --task board', () => {
  const env = { GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't', GITHUB_PROJECT_NUMBER: 'https://github.com/orgs/acme/projects/7' };

  it('adds the missing columns after confirmation, sending the ids of the existing ones', async () => {
    const github = fakeGraphql(KANBAN);
    const result = await run(['y'], env, github.fetch);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /Missing: Design, Testing, Documentation, Agent review, Security review, Blocked/);
    assert.match(result.text, /✓ added/);
    assert.equal(github.mutations.length, 1);
    const sent = github.mutations[0]?.options as StatusOption[];
    assert.deepEqual(sent.map((entry) => entry.name), [...BOARD_COLUMNS]);
    assert.equal(sent.find((entry) => entry.name === 'Ready')?.id, 'id-Ready');
    assert.equal(sent.find((entry) => entry.name === 'Design')?.id, undefined);
  });

  it('changes nothing when declined or when all columns are there', async () => {
    const declined = fakeGraphql(KANBAN);
    assert.match((await run(['n'], env, declined.fetch)).text, /Cancelled; nothing changed\./);
    assert.equal(declined.mutations.length, 0);
    const complete = fakeGraphql(BOARD_COLUMNS.map((name) => option(name)));
    assert.match((await run([], env, complete.fetch)).text, /All columns are there\./);
    assert.equal(complete.mutations.length, 0);
  });

  it('skips without a board number and rejects unknown tasks', async () => {
    const github = fakeGraphql([]);
    const skipped = await run([], { GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' }, github.fetch);
    assert.equal(skipped.code, 0);
    assert.match(skipped.text, /Skipped: GITHUB_PROJECT_NUMBER is not set/);
    const unknown = await run([], env, github.fetch, ['--task', 'nope']);
    assert.equal(unknown.code, 2);
  });
});
