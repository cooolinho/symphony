import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { baselineCommit, changedFilesSince, filesOutside, isAncestor } from '../src/orchestrator/changed-files.ts';
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

describe('baselineCommit', () => {
  /** init → developer (production code, the hand-off) → human push; HEAD stays at `init` until the test checks out. */
  function branch() {
    const { repo, start } = repository();
    write(repo, 'src/app.ts', 'the developer implements');
    const handoff = commit(repo, 'developer');
    write(repo, 'docs/notes.md', 'a human adds a note');
    const human = commit(repo, 'human');
    return { repo, start, handoff, human };
  }

  it('is the developer\'s hand-off once HEAD descends from it, so a workspace that started on the base branch is not blamed', async () => {
    const { repo, start, handoff, human } = branch();
    git(repo, 'checkout', '-q', '--detach', start);
    // Started on the base branch: the hand-off is not there yet, so the session start is all there is.
    assert.equal(await baselineCommit(repo, handoff, start), start);
    // The engineer checks out the branch: everything up to the hand-off is the developer's.
    git(repo, 'checkout', '-q', '--detach', human);
    assert.equal(await baselineCommit(repo, handoff, start), handoff);
  });

  it('keeps measuring from the hand-off when a later session starts after an earlier one changed production code', async () => {
    const { repo, handoff } = branch();
    git(repo, 'checkout', '-q', '--detach', handoff);
    write(repo, 'src/app.ts', 'a first session "fixed" it');
    const firstSession = commit(repo, 'first session');
    assert.equal(await baselineCommit(repo, handoff, firstSession), handoff);
    assert.deepEqual(filesOutside(await changedFilesSince(repo, handoff), TEST_PATHS), ['src/app.ts']);
  });

  it('falls back to the session start without a hand-off, for one HEAD does not descend from, an unknown one and a non-commit', async () => {
    const { repo, start, handoff } = branch();
    git(repo, 'checkout', '-q', '--detach', start);
    write(repo, 'tests/other.test.ts');
    const rebased = commit(repo, 'rebased branch');
    assert.equal(await baselineCommit(repo, null, rebased), rebased);
    assert.equal(await baselineCommit(repo, handoff, rebased), rebased, 'the hand-off was rebased away');
    assert.equal(await baselineCommit(repo, 'f'.repeat(40), rebased), rebased, 'unknown to this clone');
    assert.equal(await baselineCommit(repo, '--output=/tmp/x', rebased), rebased, 'not a commit name');
    assert.equal(await baselineCommit(repo, 'HEAD', rebased), rebased, 'a ref expression is not a commit name');
    assert.equal(await baselineCommit(repo, handoff, null), null);
    assert.equal(await baselineCommit(tempDir('symphony-no-repo-'), handoff, rebased), rebased);
  });

  describe('a session that started on the base branch', () => {
    it('measures from its start, so fast-forwarded pull requests are not blamed', async () => {
      const { repo, start } = repository();
      write(repo, 'src/spike.ts', 'the developer\'s hand-off');
      const handoff = commit(repo, 'developer');
      write(repo, 'src/other.ts', 'a merged pull request');
      const merged = commit(repo, 'merged pr');
      git(repo, 'update-ref', 'refs/remotes/origin/main', merged);
      assert.equal(await baselineCommit(repo, handoff, merged, await isAncestor(repo, merged, 'origin/main')), merged);
      assert.equal(await baselineCommit(repo, handoff, start, true), handoff, 'a start before the hand-off is no ancestor of it');
    });

    it('keeps the hand-off when an earlier session committed locally, off origin/<base>', async () => {
      const { repo } = repository();
      write(repo, 'src/spike.ts', 'the developer');
      const handoff = commit(repo, 'developer');
      git(repo, 'update-ref', 'refs/remotes/origin/main', handoff);
      write(repo, 'src/app.ts', 'an earlier session "fixed" it');
      const local = commit(repo, 'earlier session');
      const onBase = await isAncestor(repo, local, 'origin/main');
      assert.equal(onBase, false);
      assert.equal(await baselineCommit(repo, handoff, local, onBase), handoff);
      assert.deepEqual(filesOutside(await changedFilesSince(repo, handoff), TEST_PATHS), ['src/app.ts']);
    });

    it('behaves as before for an unknown base ref', async () => {
      const { repo } = repository();
      write(repo, 'src/spike.ts');
      const handoff = commit(repo, 'developer');
      write(repo, 'src/other.ts');
      const head = commit(repo, 'more');
      const onBase = await isAncestor(repo, head, 'origin/nope');
      assert.equal(onBase, false);
      assert.equal(await baselineCommit(repo, handoff, head, onBase), handoff);
    });

    it('keeps the hand-off on the issue branch even when the start happens to be on origin/<base> (start does not descend from it)', async () => {
      const { repo, start, handoff, human } = branch();
      git(repo, 'update-ref', 'refs/remotes/origin/main', start);
      git(repo, 'checkout', '-q', '--detach', human);
      const onBase = await isAncestor(repo, start, 'origin/main');
      assert.equal(onBase, true);
      assert.equal(await baselineCommit(repo, handoff, start, onBase), handoff, 'a start before the hand-off cannot forgive the developer');
    });

    it('is the start when HEAD does not descend from the hand-off, whatever startOnBase says', async () => {
      const { repo, start, handoff } = branch();
      git(repo, 'checkout', '-q', '--detach', start);
      assert.equal(await baselineCommit(repo, handoff, start, true), start);
      assert.equal(await baselineCommit(repo, null, start, true), start);
    });

    it('stays at the hand-off when the session start is the hand-off itself', async () => {
      const { repo, handoff } = branch();
      git(repo, 'update-ref', 'refs/remotes/origin/main', handoff);
      assert.equal(await baselineCommit(repo, handoff, handoff, true), handoff);
    });
  });
});
