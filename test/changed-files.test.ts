import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { changedFilesSince, filesOutside } from '../src/orchestrator/changed-files.ts';
import { tempDir } from './helpers.ts';

// The path rule of the test engineer (docs/configuration.md#the-test-engineer) against a real repository.

const TEST_PATHS = ['tests/**', 'test/**', '**/*.test.*', '**/*Test.php'];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd, encoding: 'utf8' }).trim();
}

function write(repo: string, name: string, content = 'x'): void {
  const file = path.join(repo, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function commit(repo: string, message: string): string {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

/** A repository with production code, a test and an ignored directory; returns the repository and its first commit. */
function repository(): { repo: string; start: string } {
  const repo = tempDir('symphony-changed-files-');
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, '.gitignore', 'vendor/\n');
  write(repo, 'src/app.ts', 'export const a = 1;\n');
  write(repo, 'src/lib/util.ts');
  write(repo, 'tests/app.test.ts');
  write(repo, 'docs/old name.md');
  return { repo, start: commit(repo, 'init') };
}

/** What the rule reports for the changes since `start`: the files outside the test paths. */
async function violations(repo: string, start: string): Promise<string[]> {
  return filesOutside(await changedFilesSince(repo, start), TEST_PATHS);
}

describe('changedFilesSince', () => {
  it('lists nothing for an untouched checkout', async () => {
    const { repo, start } = repository();
    assert.deepEqual(await changedFilesSince(repo, start), []);
  });

  it('lists committed, modified, staged and untracked files, but not ignored ones', async () => {
    const { repo, start } = repository();
    write(repo, 'tests/new.test.ts');
    commit(repo, 'add a test');
    write(repo, 'src/app.ts', 'export const a = 2;\n');
    write(repo, 'src/lib/util.ts', 'changed');
    git(repo, 'add', 'src/lib/util.ts');
    write(repo, 'tests/untracked.test.ts');
    write(repo, 'vendor/autoload.php');
    assert.deepEqual(await changedFilesSince(repo, start), ['src/app.ts', 'src/lib/util.ts', 'tests/new.test.ts', 'tests/untracked.test.ts']);
  });

  it('lists deleted files and both ends of a rename, so moving code out of src/ is seen', async () => {
    const { repo, start } = repository();
    fs.mkdirSync(path.join(repo, 'tests/moved'), { recursive: true });
    git(repo, 'mv', 'src/lib/util.ts', 'tests/moved/util.test.ts');
    fs.rmSync(path.join(repo, 'src/app.ts'));
    commit(repo, 'move and delete');
    assert.deepEqual(await changedFilesSince(repo, start), ['src/app.ts', 'src/lib/util.ts', 'tests/moved/util.test.ts']);
  });

  it('keeps names with spaces and non-ASCII characters verbatim', async () => {
    const { repo, start } = repository();
    write(repo, 'docs/old name.md', 'edited');
    write(repo, 'tests/Größe test.php');
    assert.deepEqual(await changedFilesSince(repo, start), ['docs/old name.md', 'tests/Größe test.php']);
  });

  it('forgets a change that was undone, committed or not', async () => {
    const { repo, start } = repository();
    write(repo, 'src/app.ts', 'broken');
    const broken = commit(repo, 'touch production code');
    assert.deepEqual(await changedFilesSince(repo, start), ['src/app.ts']);
    git(repo, 'checkout', start, '--', 'src/app.ts');
    commit(repo, 'undo');
    assert.notEqual(git(repo, 'rev-parse', 'HEAD'), broken);
    assert.deepEqual(await changedFilesSince(repo, start), []);
  });

  it('reports a base git does not know, or a directory that is no repository, as paths_unverifiable', async () => {
    const { repo } = repository();
    await assert.rejects(changedFilesSince(repo, 'f'.repeat(40)), { code: 'paths_unverifiable', message: /git could not list the files changed since ffffffffffff/ });
    await assert.rejects(changedFilesSince(tempDir('symphony-no-repo-'), 'f'.repeat(40)), { code: 'paths_unverifiable' });
  });
});

describe('the path rule: files outside pipeline.test_paths', () => {
  it('accepts a test engineer that only adds tests', async () => {
    const { repo, start } = repository();
    write(repo, 'tests/Feature/InvoiceTest.php');
    write(repo, 'src/new.test.ts');
    commit(repo, 'tests');
    write(repo, 'tests/app.test.ts', 'more');
    assert.deepEqual(await violations(repo, start), []);
  });

  it('names a committed change to src/', async () => {
    const { repo, start } = repository();
    write(repo, 'tests/new.test.ts');
    write(repo, 'src/app.ts', 'export const a = "fixed";\n');
    commit(repo, 'tests and a fix');
    assert.deepEqual(await violations(repo, start), ['src/app.ts']);
  });

  it('names uncommitted, untracked and deleted production files, and a config file', async () => {
    const { repo, start } = repository();
    write(repo, 'src/lib/util.ts', 'edited');
    write(repo, 'src/brand-new.ts');
    fs.rmSync(path.join(repo, 'src/app.ts'));
    write(repo, 'phpunit.xml');
    assert.deepEqual(await violations(repo, start), ['phpunit.xml', 'src/app.ts', 'src/brand-new.ts', 'src/lib/util.ts']);
  });

  it('measures against the commit the session started from, not an earlier one', async () => {
    const { repo } = repository();
    write(repo, 'src/app.ts', 'the developer fixes something');
    const sessionStart = commit(repo, 'developer');
    write(repo, 'tests/new.test.ts');
    commit(repo, 'test engineer');
    assert.deepEqual(await violations(repo, sessionStart), []);
  });
});
