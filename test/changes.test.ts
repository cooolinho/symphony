import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { SymphonyError } from '../src/util/errors.ts';
import { changedFiles, diffStat } from '../src/workspace/changes.ts';
import { tempDir } from './helpers.ts';

// changedFiles(workspace, base): the whole branch diff against the base branch, for the security review trigger.

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd, encoding: 'utf8' }).trim();
}

function write(repo: string, name: string, content = 'x'): void {
  const file = path.join(repo, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function commit(repo: string, message: string): void {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
}

/** A repository on `main` with a feature branch checked out; `main` is the base ref the tests pass. */
function repository(): string {
  const repo = tempDir('symphony-changes-');
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, '.gitignore', 'vendor/\n');
  write(repo, 'app/Policies/PostPolicy.php', 'policy v1\n'.repeat(20));
  write(repo, 'README.md', 'readme\n');
  commit(repo, 'init');
  git(repo, 'checkout', '-q', '-b', 'symphony/issue-1');
  return repo;
}

describe('changedFiles', () => {
  it('lists nothing for a branch without changes', async () => {
    assert.deepEqual(await changedFiles(repository(), 'main'), []);
  });

  it('covers the whole branch: commits, uncommitted changes and untracked files, but not ignored ones', async () => {
    const repo = repository();
    write(repo, 'docs/guide.md');
    commit(repo, 'first commit');
    write(repo, 'routes/web.php');
    commit(repo, 'second commit');
    write(repo, 'README.md', 'changed\n');
    write(repo, 'config/auth.php');
    git(repo, 'add', 'config/auth.php');
    write(repo, 'notes.txt');
    write(repo, 'vendor/autoload.php');
    assert.deepEqual(await changedFiles(repo, 'main'), ['README.md', 'config/auth.php', 'docs/guide.md', 'notes.txt', 'routes/web.php']);
  });

  it('measures from the merge base: commits that only the base branch gained do not count', async () => {
    const repo = repository();
    write(repo, 'docs/guide.md');
    commit(repo, 'branch work');
    git(repo, 'checkout', '-q', 'main');
    write(repo, 'database/migrations/2026_create_posts.php');
    commit(repo, 'someone else merged a migration');
    git(repo, 'checkout', '-q', 'symphony/issue-1');
    assert.deepEqual(await changedFiles(repo, 'main'), ['docs/guide.md']);
  });

  it('names both ends of a renamed file, so moving a file out of a protected directory is still seen', async () => {
    const repo = repository();
    fs.mkdirSync(path.join(repo, 'src'));
    git(repo, 'mv', 'app/Policies/PostPolicy.php', 'src/PostPolicy.php');
    commit(repo, 'move the policy');
    assert.deepEqual(await changedFiles(repo, 'main'), ['app/Policies/PostPolicy.php', 'src/PostPolicy.php']);
  });

  it('lists a deleted file and keeps unusual names verbatim', async () => {
    const repo = repository();
    git(repo, 'rm', '-q', 'README.md');
    write(repo, 'docs/with space.md');
    write(repo, 'docs/ümlaut.md');
    assert.deepEqual(await changedFiles(repo, 'main'), ['README.md', 'docs/with space.md', 'docs/ümlaut.md']);
  });

  it('works with a remote-tracking base ref like origin/develop', async () => {
    const remote = repository();
    git(remote, 'checkout', '-q', 'main');
    const clone = tempDir('symphony-changes-clone-');
    git(clone, 'clone', '-q', remote, '.');
    git(clone, 'checkout', '-q', '-b', 'symphony/issue-2');
    write(clone, 'routes/api.php');
    commit(clone, 'add a route');
    assert.deepEqual(await changedFiles(clone, 'origin/main'), ['routes/api.php']);
    assert.deepEqual(await changedFiles(clone, 'origin/HEAD'), ['routes/api.php']);
  });

  it('throws paths_unverifiable for an unknown base ref', async () => {
    const repo = repository();
    await assert.rejects(changedFiles(repo, 'origin/develop'), (error: unknown) => {
      assert.ok(error instanceof SymphonyError);
      assert.equal(error.code, 'paths_unverifiable');
      assert.match(error.message, /changed against origin\/develop/);
      return true;
    });
  });

  it('throws paths_unverifiable for a directory that is no git checkout', async () => {
    const dir = tempDir('symphony-changes-plain-');
    write(dir, 'routes/web.php');
    await assert.rejects(changedFiles(dir, 'main'), (error: unknown) => error instanceof SymphonyError && error.code === 'paths_unverifiable');
  });
});

describe('diffStat', () => {
  it('counts lines and tells changed, new and deleted files apart', async () => {
    const repo = repository();
    write(repo, 'README.md', 'changed\nmore\n');
    write(repo, 'docs/guide.md', 'a\nb\nc\n');
    git(repo, 'rm', '-q', 'app/Policies/PostPolicy.php');
    commit(repo, 'change');
    assert.deepEqual(await diffStat(repo, 'main'), [
      { path: 'README.md', added: 2, deleted: 1, status: 'modified' },
      { path: 'app/Policies/PostPolicy.php', added: 0, deleted: 20, status: 'deleted' },
      { path: 'docs/guide.md', added: 3, deleted: 0, status: 'added' },
    ]);
  });

  it('reports a binary file with null counts', async () => {
    const repo = repository();
    fs.writeFileSync(path.join(repo, 'logo.png'), Buffer.from([0, 1, 2, 0, 255]));
    commit(repo, 'logo');
    assert.deepEqual(await diffStat(repo, 'main'), [{ path: 'logo.png', added: null, deleted: null, status: 'binary' }]);
  });

  it('reports a rename as one entry with the new path', async () => {
    const repo = repository();
    fs.mkdirSync(path.join(repo, 'src'));
    git(repo, 'mv', 'app/Policies/PostPolicy.php', 'src/PostPolicy.php');
    commit(repo, 'move');
    assert.deepEqual(await diffStat(repo, 'main'), [{ path: 'src/PostPolicy.php', added: 0, deleted: 0, status: 'renamed' }]);
  });

  it('measures from the merge base and includes uncommitted changes, but not untracked files', async () => {
    const repo = repository();
    git(repo, 'checkout', '-q', 'main');
    write(repo, 'only-main.txt');
    commit(repo, 'main moves on');
    git(repo, 'checkout', '-q', 'symphony/issue-1');
    write(repo, 'README.md', 'readme\nplus\n');
    write(repo, 'untracked.txt');
    assert.deepEqual(await diffStat(repo, 'main'), [{ path: 'README.md', added: 1, deleted: 0, status: 'modified' }]);
  });

  it('lists nothing for a branch without changes', async () => {
    assert.deepEqual(await diffStat(repository(), 'main'), []);
  });

  it('sums commits and uncommitted changes against the merge base, sorted by path', async () => {
    const repo = repository();
    write(repo, 'z-last.txt', '1\n2\n');
    write(repo, 'a-first.txt', '1\n');
    commit(repo, 'first');
    write(repo, 'z-last.txt', '1\n2\n3\n');
    git(repo, 'add', 'z-last.txt');
    write(repo, 'README.md', 'readme\nextra\n');
    assert.deepEqual(await diffStat(repo, 'main'), [
      { path: 'README.md', added: 1, deleted: 0, status: 'modified' },
      { path: 'a-first.txt', added: 1, deleted: 0, status: 'added' },
      { path: 'z-last.txt', added: 3, deleted: 0, status: 'added' },
    ]);
  });

  it('reports a rename with edits as renamed with the real counts', async () => {
    const repo = repository();
    fs.mkdirSync(path.join(repo, 'src'));
    git(repo, 'mv', 'app/Policies/PostPolicy.php', 'src/PostPolicy.php');
    write(repo, 'src/PostPolicy.php', `${'policy v1\n'.repeat(19)}policy v2\n`);
    commit(repo, 'move and edit');
    assert.deepEqual(await diffStat(repo, 'main'), [{ path: 'src/PostPolicy.php', added: 1, deleted: 1, status: 'renamed' }]);
  });

  it('reports added and deleted binary files as binary with null counts', async () => {
    const repo = repository();
    fs.writeFileSync(path.join(repo, 'old.bin'), Buffer.from([0, 1, 2, 3]));
    commit(repo, 'add binary');
    git(repo, 'checkout', '-q', '-b', 'symphony/issue-2');
    git(repo, 'rm', '-q', 'old.bin');
    fs.writeFileSync(path.join(repo, 'new.bin'), Buffer.from([9, 0, 8]));
    commit(repo, 'swap binary');
    assert.deepEqual(await diffStat(repo, 'symphony/issue-1'), [
      { path: 'new.bin', added: null, deleted: null, status: 'binary' },
      { path: 'old.bin', added: null, deleted: null, status: 'binary' },
    ]);
  });

  it('keeps unusual file names verbatim', async () => {
    const repo = repository();
    write(repo, 'docs/with space.md', 'a\n');
    write(repo, 'docs/ümlaut.md', 'a\nb\n');
    commit(repo, 'names');
    assert.deepEqual(await diffStat(repo, 'main'), [
      { path: 'docs/with space.md', added: 1, deleted: 0, status: 'added' },
      { path: 'docs/ümlaut.md', added: 2, deleted: 0, status: 'added' },
    ]);
  });

  it('works with a remote-tracking base ref like origin/develop', async () => {
    const repo = repository();
    git(repo, 'update-ref', 'refs/remotes/origin/develop', 'main');
    write(repo, 'docs/guide.md', 'a\n');
    commit(repo, 'work');
    assert.deepEqual(await diffStat(repo, 'origin/develop'), [{ path: 'docs/guide.md', added: 1, deleted: 0, status: 'added' }]);
  });

  it('throws paths_unverifiable when there is no common ancestor', async () => {
    const repo = repository();
    git(repo, 'checkout', '-q', '--orphan', 'unrelated');
    git(repo, 'rm', '-rfq', '.');
    write(repo, 'other.txt');
    commit(repo, 'unrelated root');
    git(repo, 'checkout', '-q', 'symphony/issue-1');
    await assert.rejects(diffStat(repo, 'unrelated'), (error: unknown) => error instanceof SymphonyError && error.code === 'paths_unverifiable');
  });

  it('throws paths_unverifiable when git cannot tell', async () => {
    for (const [dir, base] of [[repository(), 'origin/develop'], [tempDir('symphony-plain-'), 'main']] as const) {
      await assert.rejects(diffStat(dir, base), (error: unknown) => error instanceof SymphonyError && error.code === 'paths_unverifiable' && error.message.includes(`against ${base}`));
    }
  });
});
