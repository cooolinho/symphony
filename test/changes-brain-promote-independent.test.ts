import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ensureVault } from '../src/brain/vault.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, tempDir } from './helpers.ts';

// E6-2 (#369), independent: approve / reject of a candidate (commit subjects `approve:` / `reject:`, author `human`)
// show up as brain changes immediately, one entry per path, and a later backfill adds no duplicates.

const sh = (dir: string, ...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const CANDIDATE = '---\ntype: lesson\nstatus: candidate\ncreated: 2026-10-20\nrepo: acme/app\n---\n# Kandidat\nzeile\n';

async function setup(files: Record<string, string>) {
  const vault = path.join(tempDir(), 'vault');
  await ensureVault(vault, ['acme/app'], new Date('2026-10-01T00:00:00Z'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), text);
  }
  sh(vault, '-c', 'user.name=t', '-c', 'user.email=t@local', 'add', '-A');
  sh(vault, '-c', 'user.name=t', '-c', 'user.email=t@local', 'commit', '-q', '-m', 'fixture');
  const make = () =>
    new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), { brain: { enabled: true, path: vault } }))),
      runner: new FakeRunner(),
      logger: Logger.silent(),
      env: {},
      logDir: tempDir(),
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker(),
    });
  const orchestrator = make();
  await orchestrator.buildBrainIndex();
  return { vault, orchestrator, make };
}

const brain = (o: Orchestrator) => o.listChanges({ type: 'brain', limit: 200 });

describe('E6-2 (independent): approve / reject through the orchestrator', () => {
  it('reject: an entry rejected_candidate for the note, author human, id sha:path, at the commit', async () => {
    const { vault, orchestrator } = await setup({ 'Inbox/a.md': CANDIDATE });
    const result = await orchestrator.brainReject('Inbox/a.md');
    assert.ok(result?.ok);
    const sha = sh(vault, 'rev-parse', 'HEAD');
    assert.match(sh(vault, 'log', '-1', '--format=%s'), /^reject:/);
    const entries = brain(orchestrator).filter((e) => e.status === 'rejected_candidate');
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(entry!.id, `brain:${sha}:Inbox/a.md`);
    assert.equal(entry!.role, 'human');
    assert.equal(entry!.repo, 'acme/app');
    assert.equal(entry!.title, 'Kandidat');
    assert.deepEqual(entry!.files.map((f) => f.path), ['Inbox/a.md']);
  });

  it('approve with a move: git sees a rename, so one approved entry for the new path; no entry without a path of the commit; diff at most 5 lines', async () => {
    const { vault, orchestrator } = await setup({ 'Inbox/a.md': CANDIDATE });
    const result = await orchestrator.brainApprove('Inbox/a.md');
    assert.ok(result?.ok);
    assert.match(sh(vault, 'log', '-1', '--format=%s'), /^approve:/);
    const sha = sh(vault, 'rev-parse', 'HEAD');
    const touched = sh(vault, 'show', '--format=', '--name-only', '--no-renames', sha).split('\n').sort();
    assert.equal(touched.length, 2, `a move touches two paths: ${touched.join(', ')}`);
    const entries = brain(orchestrator).filter((e) => e.id.startsWith(`brain:${sha}:`));
    assert.ok(entries.length >= 1 && entries.length <= touched.length);
    const paths = entries.map((e) => e.id.slice(`brain:${sha}:`.length));
    assert.ok(paths.includes('Lessons/a.md'), `new path is covered: ${paths.join(', ')}`);
    for (const p of paths) assert.ok(touched.includes(p));
    assert.equal(new Set(paths).size, paths.length);
    for (const e of entries) {
      assert.equal(e.status, 'approved');
      assert.equal(e.role, 'human');
      assert.ok((e.diff ?? '').split('\n').filter((l) => /^[+-][^+-]/.test(l)).length <= 5);
      for (const f of e.files) assert.ok(!f.path.startsWith('.obsidian'));
    }
  });

  it('a restart (backfill) after approve / reject adds no duplicates and keeps the statuses', async () => {
    const { orchestrator, make } = await setup({ 'Inbox/a.md': CANDIDATE, 'Inbox/b.md': CANDIDATE.replace('Kandidat', 'Zweiter') });
    assert.ok((await orchestrator.brainApprove('Inbox/a.md'))?.ok);
    assert.ok((await orchestrator.brainReject('Inbox/b.md'))?.ok);
    const before = brain(orchestrator).filter((e) => e.status === 'approved' || e.status === 'rejected_candidate').map((e) => `${e.id}|${e.status}`).sort();
    assert.ok(before.length >= 2);
    await orchestrator.loadBrainChanges();
    const promoted = (o: Orchestrator) => brain(o).filter((e) => e.status === 'approved' || e.status === 'rejected_candidate').map((e) => `${e.id}|${e.status}`).sort();
    assert.deepEqual(promoted(orchestrator), before, 'same orchestrator: no duplicates');
    assert.equal(new Set(brain(orchestrator).map((e) => e.id)).size, brain(orchestrator).length);
    const fresh = make();
    await fresh.loadBrainChanges();
    assert.deepEqual(promoted(fresh), before, 'fresh orchestrator backfill yields the same ids and statuses as the live hook');
    assert.equal(new Set(brain(fresh).map((e) => e.id)).size, brain(fresh).length);
  });
});
