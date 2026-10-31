import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BrainAccessLog } from '../src/brain/access-log.ts';
import { createVaultGit } from '../src/brain/git.ts';
import { createBrainWriteTools } from '../src/brain/tools.ts';
import { ensureVault } from '../src/brain/vault.ts';
import { brainCommitEntries, brainConflictEntry } from '../src/changes/brain.ts';
import { ChangeStore } from '../src/changes/store.ts';
import type { ChangeEntry } from '../src/changes/types.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import type { AgentToolContext } from '../src/tracker/types.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, baseFront, makeIssue, makeWorkflow, tempDir } from './helpers.ts';

// Independent acceptance tests of E6-2, derived from the issue text: brain changes from the vault git and the access log.

const NOW = new Date('2026-10-30T12:00:00Z');
const sh = (dir: string, ...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const commitAs = (dir: string, author: string, subject: string): string => {
  sh(dir, 'add', '-A');
  if (fs.existsSync(path.join(dir, '.obsidian'))) sh(dir, 'add', '-f', '.obsidian');
  sh(dir, '-c', `user.name=${author}`, '-c', `user.email=${author}@local`, 'commit', '-q', '-m', subject);
  return sh(dir, 'rev-parse', 'HEAD');
};
const put = (vault: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(vault, rel), text);
};
const note = (title: string, body = 'text', front = 'repo: acme/shop\nissue: acme/shop#7'): string => `---\ntype: lesson\n${front}\n---\n# ${title}\n${body}\n`;
const changedLines = (diff: string | null): string[] => (diff ?? '').split('\n').filter((l) => l.startsWith('+') || l.startsWith('-'));

async function newVault(): Promise<string> {
  const vault = path.join(tempDir(), 'vault');
  await ensureVault(vault, [], NOW);
  return vault;
}

describe('E6-2 (independent): one entry per path of a vault commit', () => {
  it('builds one brain entry per path with repo and issue from the frontmatter, title, role, time and file stats', async () => {
    const vault = await newVault();
    put(vault, 'Inbox/a.md', note('Alpha', 'l1\nl2\nl3'));
    put(vault, 'Inbox/b.md', note('Beta', 'x', 'repo: other/proj\nissue: other/proj#9'));
    const sha = commitAs(vault, 'symphony-reviewer', 'acme/shop#7 run1: two notes');
    const entries = await brainCommitEntries(vault, sha);
    assert.equal(entries.length, 2);
    const byPath = new Map(entries.map((e) => [e.files[0]!.path, e]));
    const a = byPath.get('Inbox/a.md')!;
    const b = byPath.get('Inbox/b.md')!;
    assert.ok(a && b);
    for (const e of entries) {
      assert.equal(e.type, 'brain');
      assert.equal(e.files.length, 1);
      assert.equal(e.role, 'reviewer');
      assert.equal(e.status, 'created');
      assert.equal(e.id, `brain:${sha}:${e.files[0]!.path}`);
      assert.ok(!Number.isNaN(Date.parse(e.at)));
      assert.ok(Math.abs(Date.parse(e.at) - Date.now()) < 120_000, e.at);
      assert.equal(e.files[0]!.deleted, 0);
    }
    assert.deepEqual([a.repo, a.issue, a.title], ['acme/shop', 'acme/shop#7', 'Alpha']);
    assert.deepEqual([b.repo, b.issue, b.title], ['other/proj', 'other/proj#9', 'Beta']);
    assert.ok(a.files[0]!.added! >= 4 && b.files[0]!.added! >= 1);
  });

  it('falls back to repo unknown without frontmatter', async () => {
    const vault = await newVault();
    put(vault, 'Inbox/plain.md', '# Plain\nno frontmatter\n');
    const [entry] = await brainCommitEntries(vault, commitAs(vault, 'symphony-developer', 'acme/shop#1 r: p'));
    assert.equal(entry!.repo, 'unknown');
    assert.equal(entry!.title, 'Plain');
  });

  it('limits the diff to 5 changed lines per file even for large multi-hunk changes, and takes it from the commit', async () => {
    const vault = await newVault();
    const original = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    put(vault, 'Inbox/big.md', note('Big', original));
    commitAs(vault, 'symphony-developer', 'acme/shop#7 r: first');
    const edited = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? `CHANGED ${i}` : `line ${i}`)).join('\n');
    put(vault, 'Inbox/big.md', note('Big', edited));
    const [entry] = await brainCommitEntries(vault, commitAs(vault, 'symphony-developer', 'acme/shop#7 r: second'));
    assert.equal(entry!.status, 'updated');
    const lines = changedLines(entry!.diff);
    assert.ok(lines.length >= 1 && lines.length <= 5, String(entry!.diff));
    assert.ok(lines.some((l) => l.includes('CHANGED')), 'excerpt shows the real change');
    assert.ok(entry!.files[0]!.added! > 5, 'file stats are not limited by the excerpt');
    assert.ok(entry!.files[0]!.deleted! > 5);
  });

  it('keeps the diff of every file within 5 changed lines in a multi-path commit', async () => {
    const vault = await newVault();
    put(vault, 'Inbox/a.md', note('A', Array.from({ length: 30 }, (_, i) => `a${i}`).join('\n')));
    put(vault, 'Inbox/b.md', note('B', Array.from({ length: 30 }, (_, i) => `b${i}`).join('\n')));
    const entries = await brainCommitEntries(vault, commitAs(vault, 'symphony-developer', 'acme/shop#7 r: p'));
    assert.equal(entries.length, 2);
    for (const e of entries) {
      assert.ok(changedLines(e.diff).length <= 5, String(e.diff));
      const other = e.files[0]!.path === 'Inbox/a.md' ? 'b' : 'a';
      assert.ok(!(e.diff ?? '').includes(`+${other}1`), 'diff of one path does not contain the other path');
    }
  });

  it('respects the paths option: only the given paths become entries', async () => {
    const vault = await newVault();
    put(vault, 'Inbox/a.md', note('A'));
    put(vault, 'Inbox/b.md', note('B'));
    const sha = commitAs(vault, 'symphony-developer', 'acme/shop#7 r: p');
    const entries = await brainCommitEntries(vault, sha, { paths: ['Inbox/b.md'] });
    assert.deepEqual(entries.map((e) => e.files[0]!.path), ['Inbox/b.md']);
  });
});

describe('E6-2 (independent): status', () => {
  it('derives created, updated, approved, rejected_candidate and human', async () => {
    const vault = await newVault();
    put(vault, 'Inbox/a.md', note('A', 'v1'));
    const s1 = commitAs(vault, 'symphony-developer', 'acme/shop#7 r: create');
    put(vault, 'Inbox/a.md', note('A', 'v2'));
    const s2 = commitAs(vault, 'symphony-developer', 'acme/shop#7 r: update');
    put(vault, 'Inbox/a.md', note('A', 'v3'));
    const s3 = commitAs(vault, 'human', 'approve: Inbox/a.md');
    put(vault, 'Inbox/a.md', note('A', 'v4'));
    const s4 = commitAs(vault, 'human', 'reject: Inbox/a.md');
    put(vault, 'Inbox/new-by-hand.md', note('Hand'));
    put(vault, 'Inbox/a.md', note('A', 'v5'));
    const s5 = commitAs(vault, 'human', 'Obsidian: 2 Dateien');
    const status = async (sha: string) => (await brainCommitEntries(vault, sha)).map((e) => e.status);
    assert.deepEqual(await status(s1), ['created']);
    assert.deepEqual(await status(s2), ['updated']);
    assert.deepEqual(await status(s3), ['approved']);
    assert.deepEqual(await status(s4), ['rejected_candidate']);
    assert.deepEqual((await status(s5)).sort(), ['human', 'human']);
  });

  it('records the role human for the author human and the role from symphony-<role>', async () => {
    const vault = await newVault();
    put(vault, 'Inbox/a.md', note('A'));
    const [h] = await brainCommitEntries(vault, commitAs(vault, 'human', 'Obsidian: 1 Datei'));
    assert.equal(h!.role, 'human');
    put(vault, 'Inbox/b.md', note('B'));
    const [d] = await brainCommitEntries(vault, commitAs(vault, 'symphony-architect', 'acme/shop#7 r: p'));
    assert.equal(d!.role, 'architect');
  });
});

describe('E6-2 (independent): .obsidian/ never appears', () => {
  it('drops .obsidian paths from the commit, also when only .obsidian changed', async () => {
    const vault = await newVault();
    put(vault, '.obsidian/workspace.json', '{"a":1}');
    const only = commitAs(vault, 'human', 'Obsidian: settings');
    assert.deepEqual(await brainCommitEntries(vault, only), []);
    put(vault, '.obsidian/workspace.json', '{"a":2}');
    put(vault, 'Inbox/a.md', note('A'));
    const mixed = commitAs(vault, 'human', 'Obsidian: mixed');
    const entries = await brainCommitEntries(vault, mixed);
    assert.deepEqual(entries.map((e) => e.files[0]!.path), ['Inbox/a.md']);
    for (const e of entries) assert.ok(!(e.diff ?? '').includes('.obsidian'));
  });

  it('gives no conflict entry for a rejected write below .obsidian/', () => {
    const line = {
      at: NOW.toISOString(), run: 'r2', issue: 'acme/shop#1', role: 'developer', op: 'write', path_or_query: '.obsidian/app.json', purpose: '',
      result: 'rejected', reason: 'window', clash_id: 'c9', other_run: 'r1', other_at: null,
    } as const;
    const clash = { id: 'c9', path: '.obsidian/app.json', runs: ['r1', 'r2'] as [string, string], at: [null, line.at] as [null, string], reason: 'window' as const, status: 'open' as const };
    assert.equal(brainConflictEntry(tempDir(), line, clash), null);
  });
});

describe('E6-2 (independent): conflicts from the access log', () => {
  function logWithStore(vault: string) {
    const store = new ChangeStore(null, Logger.silent());
    const access = new BrainAccessLog(null, Logger.silent(), {
      onClash: (line, clash) => {
        const entry = brainConflictEntry(vault, line, clash);
        if (entry !== null) store.append(entry);
      },
    });
    return { store, access };
  }
  const base = { at: NOW.toISOString(), run: 'run2', issue: 'acme/shop#3', role: 'tester', op: 'write', path_or_query: 'Inbox/a.md', purpose: '', result: 'ok' } as const;

  it('a rejected write with the reason window gives a conflict entry with role, run, reason and clash_id', async () => {
    const vault = await newVault();
    put(vault, 'Inbox/a.md', note('Alpha'));
    const { store, access } = logWithStore(vault);
    const clash = access.recordClash(base, { run: 'run1', at: null }, 'window');
    const [entry] = store.list({ type: 'brain' });
    assert.ok(entry);
    assert.deepEqual(
      [entry.type, entry.status, entry.role, entry.run, entry.reason, entry.clash_id, entry.issue, entry.repo, entry.title],
      ['brain', 'conflict', 'tester', 'run2', 'window', clash.id, 'acme/shop#3', 'acme/shop', 'Alpha'],
    );
    assert.deepEqual(entry.files.map((f) => f.path), ['Inbox/a.md']);
  });

  it('a real rejected brain_write (hash_mismatch) is a conflict and the first write stays created', async () => {
    const vault = await newVault();
    const store = new ChangeStore(null, Logger.silent());
    const access = new BrainAccessLog(null, Logger.silent(), {
      onClash: (line, clash) => {
        const e = brainConflictEntry(vault, line, clash);
        if (e !== null) store.append(e);
      },
    });
    const versioning = createVaultGit(vault, Logger.silent(), {
      onCommit: async (sha, paths) => {
        for (const e of await brainCommitEntries(vault, sha, { paths, known: (id) => store.has(id) })) store.append(e);
      },
    });
    const specs = createBrainWriteTools(vault, Logger.silent(), { now: () => NOW, versioning, access } as never);
    const run = (id: string, role: string, args: Record<string, unknown>) =>
      specs.find((s) => s.name === 'brain_write')!.execute({ purpose: 'p', ...args }, { issue: makeIssue({ id: 'a' }), role, runId: id } as AgentToolContext);
    assert.ok((await run('run1', 'developer', { path: 'Inbox/a.md', content: note('Alpha') })).ok);
    const rejected = await run('run2', 'reviewer', { path: 'Inbox/a.md', content: note('Alpha', 'other'), base_hash: '0'.repeat(64) });
    assert.equal(rejected.ok, false);
    const all: ChangeEntry[] = store.list({ type: 'brain', limit: 200 });
    assert.deepEqual(all.map((e) => e.status).sort(), ['conflict', 'created']);
    const conflict = all.find((e) => e.status === 'conflict')!;
    assert.equal(conflict.role, 'reviewer');
    assert.equal(conflict.run, 'run2');
    assert.equal(conflict.clash_id, access.clashes()[0]!.id);
    assert.ok(conflict.reason === 'hash_mismatch' || conflict.reason === 'window');
  });

  it('does not make conflict entries from other rejections (e.g. not_found) or successful lines', () => {
    const clash = { id: 'c1', path: 'Inbox/a.md', runs: [null, 'r'] as [null, string], at: [null, base.at] as [null, string], reason: 'window' as const, status: 'open' as const };
    assert.equal(brainConflictEntry(tempDir(), { ...base, result: 'rejected', reason: 'forbidden', clash_id: 'c1' } as never, clash), null);
    assert.equal(brainConflictEntry(tempDir(), { ...base, result: 'ok' }, clash), null);
  });

  it('a clash does not break recording when the listener throws', () => {
    const access = new BrainAccessLog(null, Logger.silent(), { onClash: () => { throw new Error('boom'); } });
    const clash = access.recordClash(base, { run: 'run1', at: null }, 'window');
    assert.ok(clash.id);
    assert.equal(access.clashes().length, 1);
  });
});

describe('E6-2 (independent): dedup and persistence', () => {
  it('brain entries survive a JSONL round trip with run, reason and clash_id, and code entries without the new fields still load', () => {
    const dir = tempDir();
    const first = new ChangeStore(dir, Logger.silent());
    const conflict: ChangeEntry = {
      id: 'brain:conflict:c1', type: 'brain', at: NOW.toISOString(), repo: 'acme/shop', issue: 'acme/shop#1', role: 'developer', title: 'A',
      files: [{ path: 'Inbox/a.md', added: 0, deleted: 0, status: 'modified' }], pr: null, diff: null, status: 'conflict', run: 'run2', reason: 'window', clash_id: 'c1',
    };
    const code: ChangeEntry = {
      id: 'code:acme/shop:abc', type: 'code', at: NOW.toISOString(), repo: 'acme/shop', issue: 'acme/shop#1', role: 'developer', title: 'x', files: [], pr: null, diff: null, status: 'committed',
    };
    assert.ok(first.append(conflict));
    assert.ok(first.append(code));
    const second = new ChangeStore(dir, Logger.silent());
    second.load();
    assert.equal(second.append(conflict), false);
    const loaded = second.list({ type: 'brain' })[0]!;
    assert.deepEqual([loaded.status, loaded.run, loaded.reason, loaded.clash_id], ['conflict', 'run2', 'window', 'c1']);
    assert.equal(second.list({ type: 'code' }).length, 1);
    assert.equal(second.list({ type: 'code' })[0]!.run, undefined);
  });

  it('known ids are skipped: a repeated hook call produces no duplicates (key sha + path)', async () => {
    const vault = await newVault();
    put(vault, 'Inbox/a.md', note('A'));
    put(vault, 'Inbox/b.md', note('B'));
    const sha = commitAs(vault, 'symphony-developer', 'acme/shop#7 r: p');
    const store = new ChangeStore(null, Logger.silent());
    for (let i = 0; i < 3; i++) for (const e of await brainCommitEntries(vault, sha, { known: (id) => store.has(id) })) store.append(e);
    assert.equal(store.list({ type: 'brain', limit: 200 }).length, 2);
    assert.deepEqual(await brainCommitEntries(vault, sha, { known: (id) => store.has(id) }), []);
    // the same path in another commit is another entry
    put(vault, 'Inbox/a.md', note('A', 'v2'));
    const sha2 = commitAs(vault, 'symphony-developer', 'acme/shop#7 r: p2');
    for (const e of await brainCommitEntries(vault, sha2, { known: (id) => store.has(id) })) store.append(e);
    assert.equal(store.list({ type: 'brain', limit: 200 }).length, 3);
  });
});

describe('E6-2 (independent): Orchestrator at startup', () => {
  function orchestratorFor(vault: string, logDir: string, enabled = true) {
    const root = tempDir();
    const workflow = new StaticWorkflow(makeWorkflow(baseFront(root, { brain: { enabled, path: vault } })));
    return new Orchestrator({
      workflow,
      runner: new FakeRunner(() => new Promise(() => undefined)),
      logger: Logger.silent(),
      env: {},
      logDir,
      clock: new ManualClock(),
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker([]),
    });
  }
  const brainCount = (o: Orchestrator) => o.listChanges({ type: 'brain', limit: 200 }).length;

  it('loads only the newest 200 vault commits, and a second load or a restart adds no duplicates', async () => {
    const vault = await newVault();
    for (let i = 0; i < 205; i++) {
      put(vault, `Inbox/n${i}.md`, note(`N${i}`));
      commitAs(vault, 'symphony-developer', `acme/shop#7 r: n${i}`);
    }
    const logDir = tempDir();
    const orchestrator = orchestratorFor(vault, logDir);
    await orchestrator.loadBrainChanges();
    assert.equal(brainCount(orchestrator), 200);
    const titles = new Set(orchestrator.listChanges({ type: 'brain', limit: 200 }).map((e) => e.title));
    assert.ok(titles.has('N204') && titles.has('N5'));
    assert.ok(!titles.has('N4') && !titles.has('N0'), 'the oldest commits (and the init commit) are not loaded');
    await orchestrator.loadBrainChanges();
    assert.equal(brainCount(orchestrator), 200);
    // restart with the persisted store: still no duplicates
    const again = orchestratorFor(vault, logDir);
    await again.loadBrainChanges();
    assert.equal(brainCount(again), 200);
  });

  it('keeps the entries of human commits and never lists .obsidian/ after the backfill', async () => {
    const vault = await newVault();
    put(vault, '.obsidian/app.json', '{}');
    put(vault, 'Inbox/h.md', note('H'));
    commitAs(vault, 'human', 'Obsidian: 2 Dateien');
    const orchestrator = orchestratorFor(vault, tempDir());
    await orchestrator.loadBrainChanges();
    const entries = orchestrator.listChanges({ type: 'brain', limit: 200 });
    assert.deepEqual(entries.map((e) => [e.status, e.files[0]!.path]), [['human', 'Inbox/h.md']]);
    for (const e of entries) for (const f of e.files) assert.ok(!f.path.startsWith('.obsidian'));
  });

  it('does not crash and adds nothing when the vault is not a git repository', async () => {
    const dir = tempDir();
    const orchestrator = orchestratorFor(dir, tempDir());
    await orchestrator.loadBrainChanges();
    assert.equal(brainCount(orchestrator), 0);
  });

  it('start() restores rejected writes of the access log as conflict entries, without .obsidian/ and without duplicates', async () => {
    const vault = await newVault();
    put(vault, 'Inbox/a.md', note('Alpha'));
    const logDir = tempDir();
    const clock = new ManualClock();
    const at = clock.now().toISOString();
    const line = (over: Record<string, unknown>) => JSON.stringify({
      at, run: 'run2', issue: 'acme/shop#3', role: 'tester', op: 'write', path_or_query: 'Inbox/a.md', purpose: '', result: 'rejected',
      reason: 'hash_mismatch', clash_id: 'clash-1', other_run: 'run1', other_at: null, ...over,
    });
    fs.mkdirSync(path.join(logDir, 'brain'), { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'brain', 'access.jsonl'),
      [line({}), line({ path_or_query: '.obsidian/app.json', clash_id: 'clash-2' }), line({ reason: 'window', clash_id: 'clash-3', path_or_query: 'Inbox/a.md' })].join('\n') + '\n',
    );
    for (let round = 0; round < 2; round++) {
      const orchestrator = orchestratorFor(vault, logDir);
      await orchestrator.start();
      try {
        const entries = orchestrator.listChanges({ type: 'brain', limit: 200 });
        assert.deepEqual(entries.map((e) => e.clash_id).sort(), ['clash-1', 'clash-3'], `round ${round}`);
        for (const e of entries) {
          assert.deepEqual([e.status, e.role, e.run], ['conflict', 'tester', 'run2']);
          assert.ok(e.reason === 'hash_mismatch' || e.reason === 'window');
          assert.equal(e.id, `brain:conflict:${e.clash_id}`);
        }
      } finally {
        await orchestrator.shutdown(100);
      }
    }
  });
});

describe('E6-2 (independent): init commit versus issue summary commits of author symphony', () => {
  it('skips the init commit "Vault angelegt" but records a later commit of author symphony', async () => {
    const vault = await newVault();
    const log = sh(vault, 'log', '--format=%H', '--reverse').split('\n');
    const initEntries = await brainCommitEntries(vault, log[0]!);
    assert.deepEqual(initEntries, [], 'the init commit gives no entries');
    put(vault, 'Issues/acme-shop-7.md', note('Summary of 7'));
    const sha = commitAs(vault, 'symphony', 'acme/shop#7: Zusammenfassung');
    const entries = await brainCommitEntries(vault, sha);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.type, 'brain');
    assert.equal(entries[0]!.status, 'created');
    assert.equal(entries[0]!.title, 'Summary of 7');
    assert.equal(entries[0]!.id, `brain:${sha}:Issues/acme-shop-7.md`);
  });
});
