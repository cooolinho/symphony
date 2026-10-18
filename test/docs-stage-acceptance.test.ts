import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { docsNeeded } from '../src/orchestrator/docs.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { DEFAULTS, resolveConfig } from '../src/workflow/config.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { changedFiles } from '../src/workspace/changes.ts';
import { tempDir } from './helpers.ts';

// Acceptance tests of #207 (documentation stage), derived from the issue text: the trigger against a real git
// repository, the configuration defaults and the shipped WORKFLOW.md role.

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd, encoding: 'utf8' }).trim();

function write(repo: string, name: string): void {
  const file = path.join(repo, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x\n');
}

function repository(): string {
  const repo = tempDir('symphony-docs-accept-');
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'README.md');
  write(repo, 'src/app.ts');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'checkout', '-q', '-b', 'symphony/issue-207');
  return repo;
}

const resolve = (front: Record<string, unknown>) =>
  resolveConfig(front, { workflowPath: '/srv/WORKFLOW.md', env: {}, trackerDefaults });

const base = { tracker: { kind: 'github', active_states: ['Ready'], terminal_states: ['Done'] } };

describe('docsNeeded against a real git repository', () => {
  const facts = (repo: string, over: Record<string, unknown> = {}) => ({
    docsNeeded: false,
    docsPaths: DEFAULTS.docsPaths,
    triggerPaths: DEFAULTS.docsTriggerPaths,
    changedFiles: () => changedFiles(repo, 'main'),
    ...over,
  });

  it('a new .env.example without docs activates the stage', async () => {
    const repo = repository();
    write(repo, '.env.example');
    write(repo, 'src/app.ts');
    assert.equal((await docsNeeded(facts(repo))).needed, true);
  });

  it('a committed .env.example change plus a docs change skips the stage', async () => {
    const repo = repository();
    write(repo, '.env.example');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'env');
    assert.equal((await docsNeeded(facts(repo))).needed, true);
    write(repo, 'docs/configuration.md');
    assert.equal((await docsNeeded(facts(repo))).needed, false);
  });

  it('a code-only change is skipped', async () => {
    const repo = repository();
    write(repo, 'src/other.ts');
    assert.equal((await docsNeeded(facts(repo))).needed, false);
  });

  it('nested config files and WORKFLOW.md trigger', async () => {
    const repo = repository();
    write(repo, 'config/deep/nested.php');
    assert.equal((await docsNeeded(facts(repo))).needed, true);
    const other = repository();
    write(other, 'WORKFLOW.md');
    assert.equal((await docsNeeded(facts(other))).needed, true);
  });

  it('docs_needed activates the stage with an unrelated diff', async () => {
    const repo = repository();
    write(repo, 'src/other.ts');
    assert.equal((await docsNeeded(facts(repo, { docsNeeded: true }))).needed, true);
  });

  it('git failure (no repository) fails safe to needed', async () => {
    const decision = await docsNeeded(facts(tempDir('symphony-nogit-')));
    assert.equal(decision.needed, true);
  });

  it('custom trigger and docs paths replace the defaults', async () => {
    const repo = repository();
    write(repo, 'settings/app.ini');
    assert.equal((await docsNeeded(facts(repo))).needed, false);
    assert.equal((await docsNeeded(facts(repo, { triggerPaths: ['settings/**'] }))).needed, true);
    write(repo, 'manual/guide.md');
    assert.equal((await docsNeeded(facts(repo, { triggerPaths: ['settings/**'], docsPaths: ['manual/**'] }))).needed, false);
  });
});

describe('configuration', () => {
  it('defaults: triggers .env.example, config/**, WORKFLOW.md; docs_paths is non-empty', () => {
    const pipeline = resolve(base).pipeline;
    assert.deepEqual(pipeline.docsTriggerPaths, ['.env.example', 'config/**', 'WORKFLOW.md']);
    assert.ok(pipeline.docsPaths.length > 0);
    assert.ok(pipeline.docsPaths.includes('docs/**'));
  });

  it('explicit lists replace the defaults, [] disables', () => {
    const pipeline = resolve({ ...base, pipeline: { docs_paths: ['manual/**'], docs_trigger_paths: [] } }).pipeline;
    assert.deepEqual(pipeline.docsPaths, ['manual/**']);
    assert.deepEqual(pipeline.docsTriggerPaths, []);
  });
});

describe('the shipped WORKFLOW.md', () => {
  const file = path.resolve(import.meta.dirname, '../WORKFLOW.md');
  const load = async () => {
    const { definition } = await loadWorkflowFile(file);
    return resolveConfig(definition.config, { workflowPath: file, env: {}, trackerDefaults });
  };

  it('has a docs role in Documentation with result docs, haiku, going to Agent review', async () => {
    const config = await load();
    const role = config.roles?.find((candidate) => candidate.name === 'docs');
    assert.ok(role, 'role docs');
    assert.deepEqual(role.states.map((state) => state.toLowerCase()), ['documentation']);
    assert.equal(role.result, 'docs');
    assert.equal(role.claude.model, 'haiku');
    assert.equal(role.onResult.done, 'Agent review');
    assert.equal(role.readOnly, false);
  });

  it('places Documentation among the active states, before Agent review', async () => {
    const states = (await load()).tracker.activeStates;
    const docs = states.indexOf('Documentation');
    assert.ok(docs >= 0);
    assert.ok(states.indexOf('Testing') < docs && docs < states.indexOf('Agent review'), states.join(','));
  });
});
