import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BrainAccessLog, type BrainAccess } from '../src/brain/access-log.ts';
import { createVaultGit, initVaultGit, lastVaultCommit } from '../src/brain/git.ts';
import { BrainIndex, buildIndex, candidatesOf, vitalsCounts } from '../src/brain/index.ts';
import { Logger } from '../src/log.ts';
import { tempDir } from './helpers.ts';

const put = (vault: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(vault, rel), text);
};
const fm = (fields: Record<string, string>, body = ''): string =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n`;

function fixture(): string {
  const vault = path.join(tempDir(), 'vault');
  put(vault, 'Repos/acme-app/index.md', fm({ type: 'index', status: 'approved', repo: 'acme/app' }, '[[Decisions/a|Alias]]'));
  put(vault, 'Decisions/a.md', fm({ type: 'decision', status: 'approved', created: '2026-10-01' }, '[[b#Abschnitt]] and [[Lessons/fehlt]]'));
  put(vault, 'Lessons/b.md', fm({ type: 'lesson', status: 'candidate', repo: 'acme/app', issue: 'acme/app#1', role: 'developer', created: '2026-10-02' }, 'x'));
  put(vault, 'Inbox/c.md', fm({ type: 'note', status: 'candidate' }, 'self [[Inbox/c]]'));
  put(vault, '.obsidian/x.md', 'ignored [[nope]]');
  return vault;
}

describe('buildIndex', () => {
  it('finds links in all forms, orphans and broken links', async () => {
    const index = await buildIndex(fixture());
    assert.deepEqual([...index.notes.keys()].sort(), ['Decisions/a.md', 'Inbox/c.md', 'Lessons/b.md', 'Repos/acme-app/index.md']);
    assert.deepEqual(index.backlinks.get('Decisions/a.md'), ['Repos/acme-app/index.md']);
    assert.deepEqual(index.backlinks.get('Lessons/b.md'), ['Decisions/a.md']);
    assert.deepEqual(index.orphans, ['Inbox/c.md']);
    assert.deepEqual(index.broken, [{ from: 'Decisions/a.md', link: 'Lessons/fehlt.md' }]);
    assert.equal(index.links, 2);
    const b = index.notes.get('Lessons/b.md')!;
    assert.deepEqual([b.type, b.status, b.repo, b.issue, b.role, b.created], ['lesson', 'candidate', 'acme/app', 'acme/app#1', 'developer', '2026-10-02']);
  });

  it('survives broken YAML, ignores code fences and attachments, treats ambiguous names as broken', async () => {
    const vault = tempDir();
    put(vault, 'Inbox/bad.md', '---\nstatus: [oops\n---\n[[Inbox/ok]]');
    put(vault, 'Inbox/ok.md', fm({ status: 'candidate' }, '```\n[[Inbox/fence]]\n```\n![[bild.png]] [[dup]]'));
    put(vault, 'Lessons/dup.md', 'a');
    put(vault, 'Decisions/dup.md', 'b');
    const index = await buildIndex(vault);
    assert.equal(index.notes.get('Inbox/bad.md')!.status, null);
    assert.deepEqual(index.broken, [{ from: 'Inbox/ok.md', link: 'dup.md' }]);
    assert.equal(index.links, 1);
  });

  it('returns an empty index for a missing vault', async () => {
    const index = await buildIndex(path.join(tempDir(), 'nope'));
    assert.equal(index.notes.size, 0);
  });

  it('indexes 2,000 notes quickly', async () => {
    const vault = tempDir();
    const folders = ['Inbox', 'Decisions', 'Lessons', 'Issues'];
    for (let i = 0; i < 2000; i++) {
      const links = [1, 2, 3].map((n) => `[[${folders[(i + n) % 4]}/n${(i + n * 7) % 2000}]]`).join(' ');
      put(vault, `${folders[i % 4]}/n${i}.md`, fm({ type: 'note', status: 'candidate', created: '2026-10-01' }, links));
    }
    const started = performance.now();
    const index = await buildIndex(vault);
    const ms = performance.now() - started;
    assert.equal(index.notes.size, 2000);
    assert.ok(ms < 2000, `took ${ms} ms`);
  });
});

describe('candidatesOf and vitalsCounts', () => {
  it('lists candidates oldest first with a target', async () => {
    const vault = fixture();
    put(vault, 'Inbox/d.md', fm({ type: 'decision', status: 'candidate', target: 'Decisions/neu.md' }));
    const index = await buildIndex(vault);
    const list = candidatesOf(index);
    assert.deepEqual(list.map((c) => c.path), ['Lessons/b.md', 'Inbox/c.md', 'Inbox/d.md']);
    assert.deepEqual(list.map((c) => c.target), ['Lessons/', 'Inbox/', 'Decisions/neu.md']);
    assert.equal(list[0]!.title, 'b');
    assert.deepEqual(vitalsCounts(index).notes_by_status, { candidate: 3, approved: 2, deprecated: 0, none: 0 });
  });
});

describe('BrainIndex', () => {
  it('updates changed, deleted and new paths', async () => {
    const vault = fixture();
    const holder = new BrainIndex(Logger.silent());
    await holder.update(vault, ['Inbox/c.md']);
    await holder.rebuild(vault);
    put(vault, 'Inbox/c.md', fm({ status: 'candidate' }, '[[Lessons/b]]'));
    put(vault, 'Inbox/new.md', fm({ status: 'candidate' }, '[[gone]]'));
    fs.rmSync(path.join(vault, 'Decisions/a.md'));
    await holder.update(vault, ['Inbox/c.md', 'Inbox/new.md', 'Decisions/a.md']);
    const index = await holder.current(vault);
    assert.ok(!index.notes.has('Decisions/a.md'));
    assert.deepEqual(index.backlinks.get('Lessons/b.md'), ['Inbox/c.md']);
    assert.deepEqual(index.broken, [
      { from: 'Inbox/new.md', link: 'gone.md' },
      { from: 'Repos/acme-app/index.md', link: 'Decisions/a.md' },
    ]);
  });

  it('follows vault commits through onCommit, including a rename', async () => {
    const vault = fixture();
    await initVaultGit(vault);
    const holder = new BrainIndex(Logger.silent());
    await holder.rebuild(vault);
    const vaultGit = createVaultGit(vault, Logger.silent(), { onCommit: (_sha, paths) => holder.update(vault, paths) });
    fs.renameSync(path.join(vault, 'Inbox/c.md'), path.join(vault, 'Inbox/renamed.md'));
    assert.ok(await vaultGit.commitHumanChanges());
    const keys = [...(await holder.current(vault)).notes.keys()];
    assert.ok(keys.includes('Inbox/renamed.md'));
    assert.ok(!keys.includes('Inbox/c.md'));
    assert.equal((await lastVaultCommit(vault))?.author, 'human');
  });
});

describe('lastVaultCommit', () => {
  it('reads the last commit, null without a repository', async () => {
    const vault = fixture();
    assert.equal(await lastVaultCommit(vault), null);
    await initVaultGit(vault);
    const last = await lastVaultCommit(vault);
    assert.equal(last?.sha.length, 40);
    assert.equal(last?.author, 'symphony');
    assert.ok(!Number.isNaN(Date.parse(last!.at)));
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: vault });
  });
});

describe('BrainAccessLog.todayCounts', () => {
  const NOW = new Date('2026-10-30T12:00:00Z');
  const entry = (op: BrainAccess['op'], over: Partial<BrainAccess> = {}): BrainAccess => ({
    at: NOW.toISOString(), run: null, issue: null, role: null, op, path_or_query: 'x.md', purpose: '', result: 'ok', ...over,
  });
  it('counts successful reads and writes of the UTC day, in memory and after load', () => {
    const dir = path.join(tempDir(), 'brain');
    for (const target of [dir, null]) {
      const log = new BrainAccessLog(target, Logger.silent());
      for (const e of [entry('read'), entry('search'), entry('write'), entry('append'), entry('write', { result: 'rejected' }), entry('read', { at: '2026-10-29T23:59:00Z' })]) log.record(e);
      assert.deepEqual(log.todayCounts(NOW), { reads: 2, writes: 2 });
    }
    const loaded = new BrainAccessLog(dir, Logger.silent());
    loaded.load(NOW);
    assert.deepEqual(loaded.todayCounts(NOW), { reads: 2, writes: 2 });
  });
});
