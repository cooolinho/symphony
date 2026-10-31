import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BrainAccessLog } from '../src/brain/access-log.ts';
import { createVaultGit } from '../src/brain/git.ts';
import { createBrainWriteTools } from '../src/brain/tools.ts';
import { ensureVault } from '../src/brain/vault.ts';
import { brainCommitEntries, brainConflictEntry, recentVaultCommits } from '../src/changes/brain.ts';
import { ChangeStore } from '../src/changes/store.ts';
import type { ChangeEntry } from '../src/changes/types.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import type { AgentToolContext, ToolResult } from '../src/tracker/types.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, baseFront, makeIssue, makeWorkflow, tempDir } from './helpers.ts';

// Acceptance tests of E6-2 (brain changes from the vault git and the access log), with a temporary vault.

const NOW = new Date('2026-10-30T12:00:00Z');
const sh = (dir: string, ...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const note = (body: string, repo = 'acme/shop'): string => `---\ntype: lesson\nrepo: ${repo}\n---\n# Titel\n${body}\n`;
const lines = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join('\n');
const hashOf = (r: ToolResult): string => (r as { data: { hash: string } }).data.hash;

async function setup(opts: { hook?: boolean; clashWindowMs?: number } = {}) {
  const vault = path.join(tempDir(), 'vault');
  await ensureVault(vault, [], NOW);
  const store = new ChangeStore(null, Logger.silent());
  const clashes: ChangeEntry[] = [];
  const access = new BrainAccessLog(null, Logger.silent(), {
    onClash: (line, clash) => {
      const entry = brainConflictEntry(vault, line, clash);
      if (entry !== null) {
        store.append(entry);
        clashes.push(entry);
      }
    },
  });
  const hook = async (sha: string, paths: string[]) => {
    for (const e of await brainCommitEntries(vault, sha, { paths, known: (id) => store.has(id) })) store.append(e);
  };
  const versioning = createVaultGit(vault, Logger.silent(), opts.hook === false ? {} : { onCommit: hook });
  const specs = createBrainWriteTools(vault, Logger.silent(), {
    now: () => NOW,
    versioning,
    access,
    ...(opts.clashWindowMs !== undefined ? { clashWindowMs: opts.clashWindowMs } : {}),
  } as never);
  const session = (run: string, role = 'developer') => {
    const context = { issue: makeIssue({ id: 'a' }), role, runId: run } as AgentToolContext;
    return (name: string) => (args: Record<string, unknown>) => specs.find((s) => s.name === name)!.execute({ purpose: 'p', ...args }, context);
  };
  return { vault, store, access, versioning, session, clashes };
}

const brainEntries = (store: ChangeStore): ChangeEntry[] => store.list({ type: 'brain', limit: 200 }).reverse();

describe('E6-2 brain changes from the vault git', () => {
  it('creates one entry per path with all fields, then updated with a diff of at most 5 lines', async () => {
    const { store, session } = await setup();
    const write = session('run1')('brain_write');
    const created = await write({ path: 'Inbox/a.md', content: note(lines(3, 'one')) });
    const [first] = brainEntries(store);
    assert.ok(first);
    assert.match(first.id, /^brain:[0-9a-f]{40}:Inbox\/a\.md$/);
    assert.deepEqual([first.type, first.repo, first.role, first.title, first.status, first.run, first.pr], ['brain', 'acme/shop', 'developer', 'Titel', 'created', 'run1', null]);
    assert.equal(first.files.length, 1);
    assert.equal(first.files[0]!.path, 'Inbox/a.md');
    assert.ok(first.files[0]!.added! > 0 && first.files[0]!.deleted === 0);
    assert.ok(!Number.isNaN(Date.parse(first.at)));
    assert.ok(first.issue !== '');

    await write({ path: 'Inbox/a.md', content: note(lines(10, 'two')), base_hash: hashOf(created) });
    const second = brainEntries(store)[1]!;
    assert.equal(second.status, 'updated');
    const changed = second.diff!.split('\n').filter((l) => l.startsWith('+') || l.startsWith('-'));
    assert.ok(changed.length >= 1 && changed.length <= 5, second.diff!);
  });

  it('records a rejected write as a conflict with role, run, reason and clash id, once', async () => {
    const { store, session, access, vault, clashes } = await setup({ hook: false });
    await session('run1')('brain_write')({ path: 'Inbox/a.md', content: note('x') });
    const rejected = await session('run2', 'reviewer')('brain_write')({ path: 'Inbox/a.md', content: note('y'), base_hash: 'f'.repeat(64) });
    assert.equal(rejected.ok, false);
    const [clash] = access.clashes();
    assert.ok(clash);
    const entry = store.list({ type: 'brain' })[0]!;
    assert.deepEqual([entry.id, entry.status, entry.role, entry.run, entry.clash_id, entry.reason], [`brain:conflict:${clash.id}`, 'conflict', 'reviewer', 'run2', clash.id, clash.reason]);

    assert.equal(store.append(clashes[0]!), false);
    assert.equal(store.list({ type: 'brain' }).length, 1);
    assert.ok(fs.existsSync(vault));
  });

  it('restores the clash listener calls from the log file at startup', () => {
    const dir = tempDir();
    const first = new BrainAccessLog(dir, Logger.silent());
    const base = { at: NOW.toISOString(), run: 'run2', issue: 'acme/shop#1', role: 'developer', op: 'write', path_or_query: 'Inbox/a.md', purpose: '', result: 'ok' } as const;
    const clash = first.recordClash(base, { run: 'run1', at: null }, 'window');
    const seen: string[] = [];
    const second = new BrainAccessLog(dir, Logger.silent(), { onClash: (line, c) => seen.push(`${c.id}:${line.reason}:${line.clash_id}`) });
    second.load(NOW);
    assert.deepEqual(seen, [`${clash.id}:window:${clash.id}`]);
  });

  it('detects approve: and reject: commits and human commits', async () => {
    const { vault, session } = await setup({ hook: false });
    await session('run1')('brain_write')({ path: 'Inbox/a.md', content: note('x') });
    fs.writeFileSync(path.join(vault, 'Inbox/a.md'), note('approved'));
    sh(vault, '-c', 'user.name=human', '-c', 'user.email=h@local', 'commit', '-qam', 'approve: Inbox/a.md');
    const approve = await brainCommitEntries(vault, sh(vault, 'rev-parse', 'HEAD'));
    assert.deepEqual(approve.map((e) => [e.status, e.role]), [['approved', 'human']]);

    fs.writeFileSync(path.join(vault, 'Inbox/a.md'), note('rejected'));
    sh(vault, '-c', 'user.name=human', '-c', 'user.email=h@local', 'commit', '-qam', 'reject: Inbox/a.md');
    assert.equal((await brainCommitEntries(vault, sh(vault, 'rev-parse', 'HEAD')))[0]!.status, 'rejected_candidate');
  });

  it('records the Obsidian commit as human', async () => {
    const { vault, store, session, versioning } = await setup();
    fs.writeFileSync(path.join(vault, 'Inbox/h.md'), note('by hand'));
    await versioning.commitHumanChanges();
    void session;
    const [entry] = brainEntries(store);
    assert.deepEqual([entry!.status, entry!.role], ['human', 'human']);
  });

  it('never reports .obsidian/ and skips the init commit', async () => {
    const { vault } = await setup({ hook: false });
    fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
    fs.writeFileSync(path.join(vault, '.obsidian/x.json'), '{}');
    fs.writeFileSync(path.join(vault, 'Inbox/a.md'), note('x'));
    sh(vault, 'add', '-f', '.obsidian/x.json', 'Inbox/a.md');
    sh(vault, '-c', 'user.name=symphony-developer', '-c', 'user.email=d@local', 'commit', '-qm', 'acme/shop#1 run: p');
    const head = sh(vault, 'rev-parse', 'HEAD');
    assert.deepEqual((await brainCommitEntries(vault, head)).map((e) => e.files[0]!.path), ['Inbox/a.md']);
    assert.deepEqual((await brainCommitEntries(vault, head, { paths: ['.obsidian/x.json', 'Inbox/a.md'] })).map((e) => e.files[0]!.path), ['Inbox/a.md']);
    const [init] = await recentVaultCommits(vault);
    assert.deepEqual(await brainCommitEntries(vault, init!), []);
  });

  it('recentVaultCommits returns the newest commits, oldest first', async () => {
    const { vault, session } = await setup({ hook: false });
    const write = session('run1')('brain_write');
    await write({ path: 'Inbox/a.md', content: note('1') });
    await write({ path: 'Inbox/b.md', content: note('2') });
    const all = sh(vault, 'rev-list', 'HEAD').split('\n');
    assert.deepEqual(await recentVaultCommits(vault, 2), [all[1], all[0]]);
  });

  it('a hook that throws does not fail the write', async () => {
    const vault = path.join(tempDir(), 'vault');
    await ensureVault(vault, [], NOW);
    const versioning = createVaultGit(vault, Logger.silent(), { onCommit: () => Promise.reject(new Error('boom')) });
    const specs = createBrainWriteTools(vault, Logger.silent(), { now: () => NOW, versioning });
    const result = await specs.find((s) => s.name === 'brain_write')!.execute({ path: 'Inbox/a.md', content: note('x'), purpose: 'p' }, { issue: makeIssue({ id: 'a' }), role: 'developer' } as AgentToolContext);
    assert.ok(result.ok);
  });
});

describe('E6-2 Orchestrator.loadBrainChanges', () => {
  function orchestratorFor(vault: string, enabled = true) {
    const root = tempDir();
    const warnings: string[] = [];
    const logger = Logger.create({ sinks: [{ name: 'memory', write: (l: string) => warnings.push(l) }], level: 'warn' } as never);
    const workflow = new StaticWorkflow(makeWorkflow(baseFront(root, { brain: { enabled, path: vault } })));
    const orchestrator = new Orchestrator({
      workflow,
      runner: new FakeRunner(() => new Promise(() => undefined)),
      logger,
      env: {},
      logDir: tempDir(),
      clock: new ManualClock(),
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker([]),
    });
    return { orchestrator, warnings };
  }

  it('loads the vault commits once, without duplicates', async () => {
    const { vault, session } = await setup({ hook: false });
    const write = session('run1')('brain_write');
    for (const name of ['a', 'b', 'c']) await write({ path: `Inbox/${name}.md`, content: note(name) });
    const { orchestrator } = orchestratorFor(vault);
    await orchestrator.loadBrainChanges();
    const count = () => orchestrator.listChanges({ type: 'brain', limit: 200 }).length;
    assert.equal(count(), 3);
    await orchestrator.loadBrainChanges();
    assert.equal(count(), 3);
  });

  it('warns instead of throwing without a vault, and does nothing when disabled', async () => {
    const missing = path.join(tempDir(), 'none');
    const { orchestrator, warnings } = orchestratorFor(missing);
    await orchestrator.loadBrainChanges();
    assert.ok(warnings.some((l) => l.includes('cannot load the brain changes')));
    const off = orchestratorFor(missing, false);
    await off.orchestrator.loadBrainChanges();
    assert.deepEqual(off.warnings, []);
  });
});
