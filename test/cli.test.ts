import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { tempDir } from './helpers.ts';

const CLI = path.resolve(import.meta.dirname, '../src/cli.ts');

function run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...options.env };
  return spawnSync(process.execPath, [CLI, ...args], { cwd: options.cwd ?? tempDir(), env, encoding: 'utf8', timeout: 20_000 });
}

describe('cli', () => {
  it('prints usage with --help', () => {
    const result = run(['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: symphony/);
  });

  it('fails when ./WORKFLOW.md is missing', () => {
    const result = run([]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no WORKFLOW\.md/);
  });

  it('fails for a nonexistent explicit workflow path', () => {
    const result = run(['/nonexistent/WORKFLOW.md']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /workflow file not found/);
  });

  it('rejects bad options with a usage error', () => {
    assert.equal(run(['--port', 'abc']).status, 2);
    assert.equal(run(['--bogus']).status, 2);
  });

  it('reads .env next to the workflow and reports validation problems in a dry run', () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, 'WORKFLOW.md'),
      '---\ntracker:\n  kind: github_project\n  provider:\n    project_number: $GITHUB_PROJECT_NUMBER\n    repositories: $GITHUB_REPOSITORY\n    token: $GITHUB_TOKEN\nclaude:\n  model: $CLAUDE_MODEL\n---\nHi',
    );
    fs.writeFileSync(path.join(dir, '.env'), 'GITHUB_PROJECT_NUMBER=10\nGITHUB_REPOSITORY=acme/app\nCLAUDE_MODEL=opus\n');
    const result = run(['--dry-run'], { cwd: dir });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Env file: +.*\.env/);
    assert.match(result.stdout, /model opus/);
    assert.match(result.stdout, /tracker\.provider\.token references \$GITHUB_TOKEN/);
  });

  it('fails startup cleanly when validation fails', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'WORKFLOW.md'), '---\ntracker:\n  kind: jira\n---\nHi');
    const result = run([], { cwd: dir });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /startup failed.*not supported/);
  });
});
