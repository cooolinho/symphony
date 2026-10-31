import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BrainAccessLog, type BrainAccess } from '../src/brain/access-log.ts';
import { createVaultGit, initVaultGit, lastVaultCommit } from '../src/brain/git.ts';
import { BrainIndex, buildIndex, candidatesOf, deriveIndex, foldersOf, graphAround, vitalsCounts, type IndexedNote } from '../src/brain/index.ts';
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

describe('Index und Issue-Zusammenfassung', () => {
  it('Zaun-Arten werden nicht vermischt', async () => {
    const vault = tempDir();
    put(vault, 'a.md', '```\n~~~\n[[im-zaun]]\n```\n[[danach]]');
    const index = await buildIndex(vault);
    assert.deepEqual(index.notes.get('a.md')!.links, ['danach.md']);
  });

  it('ein Commit der Zusammenfassung mit Hook aktualisiert den Index', async () => {
    const { ensureVault } = await import('../src/brain/vault.ts');
    const { writeIssueSummary } = await import('../src/brain/issue-summary.ts');
    const dir = path.join(tempDir(), 'vault');
    await ensureVault(dir, ['acme/app'], new Date('2026-10-30T00:00:00Z'));
    const brainIndex = new BrainIndex(Logger.silent());
    await brainIndex.rebuild(dir);
    const versioning = createVaultGit(dir, Logger.silent(), { onCommit: (_sha, paths) => brainIndex.update(dir, paths) });
    const issue = { repo: 'acme/app', identifier: 'acme/app#7', number: '7', title: 'T', description: 'x', pullRequest: null, pullRequestUrl: null };
    await writeIssueSummary(issue, [], null, { vaultPath: dir, versioning });
    await brainIndex.current(dir);
    assert.ok((await brainIndex.current(dir)).notes.has('Issues/acme-app/7.md'));
  });
});

describe('foldersOf and the candidate preview (E7-7a)', () => {
  it('counts notes per status recursively per folder, the root counts nowhere', async () => {
    const vault = path.join(tempDir(), 'vault');
    put(vault, 'Inbox/a.md', fm({ status: 'candidate' }));
    put(vault, 'Repos/acme-app/index.md', fm({ status: 'approved' }));
    put(vault, 'Repos/acme-app/x.md', fm({ status: 'deprecated' }));
    put(vault, 'README.md', fm({ status: 'approved' }));
    const folders = foldersOf(await buildIndex(vault));
    assert.deepEqual(folders.map((f) => f.path), ['Inbox', 'Repos', 'Repos/acme-app']);
    const repos = folders[1]!;
    assert.deepEqual(repos.notes_by_status, { candidate: 0, approved: 1, deprecated: 1, none: 0 });
    assert.equal(repos.total, 2);
    assert.deepEqual(folders[2], { ...repos, path: 'Repos/acme-app' });
    assert.equal(folders[0]!.notes_by_status.candidate, 1);
  });

  it('keeps at most 10 lines of the body as preview, for candidates only', async () => {
    const vault = path.join(tempDir(), 'vault');
    const body = '\n\n' + Array.from({ length: 15 }, (_, i) => `Zeile ${i + 1}`).join('\n');
    put(vault, 'Inbox/a.md', fm({ status: 'candidate' }, body));
    put(vault, 'Lessons/b.md', fm({ status: 'approved' }, body));
    const index = await buildIndex(vault);
    const preview = candidatesOf(index)[0]!.preview;
    assert.equal(preview.split('\n').length, 10);
    assert.ok(preview.startsWith('Zeile 1\n'));
    assert.ok(!preview.includes('status:'));
    assert.equal(index.notes.get('Lessons/b.md')!.preview, undefined);
  });
});

describe('graphAround (E7-7b)', () => {
  async function graphFixture() {
    const vault = fixture();
    put(vault, 'Agents/dev.md', fm({ status: 'approved' }, 'see [[Repos/acme-app/index]]'));
    return buildIndex(vault);
  }
  const paths = (graph: { nodes: { path: string }[] }) => graph.nodes.map((n) => n.path);

  it('walks links and backlinks up to the depth, broken links as missing nodes', async () => {
    const index = await graphFixture();
    const one = graphAround(index, 'Repos/acme-app/index.md', 1)!;
    assert.deepEqual(paths(one), ['Repos/acme-app/index.md', 'Agents/dev.md', 'Decisions/a.md']);
    assert.deepEqual(one.nodes.map((n) => n.depth), [0, 1, 1]);
    const two = graphAround(index, 'Repos/acme-app/index.md')!;
    assert.equal(two.depth, 2);
    assert.equal(two.truncated, false);
    assert.deepEqual(paths(two), ['Repos/acme-app/index.md', 'Agents/dev.md', 'Decisions/a.md', 'Lessons/b.md', 'Lessons/fehlt.md']);
    assert.deepEqual(two.nodes[0], { path: 'Repos/acme-app/index.md', title: 'index', status: 'approved', type: 'index', missing: false, depth: 0 });
    assert.deepEqual(two.nodes.at(-1), { path: 'Lessons/fehlt.md', title: 'fehlt', status: null, type: null, missing: true, depth: 2 });
    assert.deepEqual(two.edges, [
      { from: 'Agents/dev.md', to: 'Repos/acme-app/index.md', broken: false },
      { from: 'Decisions/a.md', to: 'Lessons/b.md', broken: false },
      { from: 'Decisions/a.md', to: 'Lessons/fehlt.md', broken: true },
      { from: 'Repos/acme-app/index.md', to: 'Decisions/a.md', broken: false },
    ]);
  });

  it('finds the root without .md and in another case; null for an unknown root', async () => {
    const index = await graphFixture();
    assert.equal(graphAround(index, 'repos/ACME-app/index')!.root, 'Repos/acme-app/index.md');
    assert.equal(graphAround(index, '/Repos/acme-app/index.md')!.root, 'Repos/acme-app/index.md');
    assert.equal(graphAround(index, 'Repos/nope/index.md'), null);
    assert.equal(graphAround(index, ''), null);
  });

  it('stops at the node limit and keeps only edges between kept nodes', () => {
    const notes = new Map<string, IndexedNote>();
    const empty = { type: null, status: null, repo: null, issue: null, role: null, created: null, updated: null, target: null };
    notes.set('Repos/x/index.md', { ...empty, title: 'x', links: Array.from({ length: 200 }, (_, i) => `Lessons/n${String(i).padStart(3, '0')}.md`) });
    for (let i = 0; i < 200; i++) notes.set(`Lessons/n${String(i).padStart(3, '0')}.md`, { ...empty, title: `n${i}`, links: [] });
    const graph = graphAround(deriveIndex(notes), 'Repos/x/index.md')!;
    assert.equal(graph.nodes.length, 150);
    assert.equal(graph.truncated, true);
    assert.equal(graph.edges.length, 149);
    const kept = new Set(paths(graph));
    assert.ok(graph.edges.every((e) => kept.has(e.from) && kept.has(e.to)));
    assert.equal(graphAround(deriveIndex(notes), 'Repos/x/index.md', 2, 201)!.truncated, false);
  });
});
