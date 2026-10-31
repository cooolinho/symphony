import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ensureVault } from '../src/brain/vault.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, tempDir } from './helpers.ts';

// E6-2 (#369): approve / reject through the orchestrator create brain changes immediately.

const git = (dir: string, ...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const CANDIDATE = '---\ntype: lesson\nstatus: candidate\ncreated: 2026-10-20\nrepo: acme/app\n---\n# Kandidat\n';

async function setup(files: Record<string, string>) {
  const vault = path.join(tempDir(), 'vault');
  await ensureVault(vault, ['acme/app'], new Date('2026-10-01T00:00:00Z'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), text);
  }
  git(vault, '-c', 'user.name=t', '-c', 'user.email=t@local', 'add', '-A');
  git(vault, '-c', 'user.name=t', '-c', 'user.email=t@local', 'commit', '-q', '-m', 'fixture');
  const orchestrator = new Orchestrator({
    workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), { brain: { enabled: true, path: vault } }))),
    runner: new FakeRunner(),
    logger: Logger.silent(),
    env: {},
    logDir: tempDir(),
    timers: new ManualTimers(),
    createAdapter: () => new FakeTracker(),
  });
  await orchestrator.buildBrainIndex();
  return { orchestrator };
}

describe('brain changes of approve / reject', () => {
  it('records rejected_candidate immediately', async () => {
    const { orchestrator } = await setup({ 'Inbox/a.md': CANDIDATE });
    const result = await orchestrator.brainReject('Inbox/a.md');
    assert.ok(result?.ok);
    const entries = orchestrator.listChanges().filter((e) => e.type === 'brain' && e.status === 'rejected_candidate');
    assert.deepEqual(entries.map((e) => e.files[0]?.path), ['Inbox/a.md']);
  });

  it('records approved for the old and the new path of a move', async () => {
    const { orchestrator } = await setup({ 'Inbox/a.md': CANDIDATE });
    const result = await orchestrator.brainApprove('Inbox/a.md');
    assert.ok(result?.ok);
    const entries = orchestrator.listChanges().filter((e) => e.type === 'brain' && e.status === 'approved');
    assert.ok(entries.length >= 1);
    assert.ok(entries.every((e) => e.role === 'human'));
  });
});
