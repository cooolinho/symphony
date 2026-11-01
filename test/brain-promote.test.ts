import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createVaultGit } from '../src/brain/git.ts';
import { BrainIndex } from '../src/brain/index.ts';
import { parseNote } from '../src/brain/note.ts';
import { approveCandidate, rejectCandidate, revertDecision, targetPath, type PromoteOptions } from '../src/brain/promote.ts';
import { ensureVault } from '../src/brain/vault.ts';
import { Logger } from '../src/log.ts';
import { tempDir } from './helpers.ts';

const NOW = new Date('2026-10-31T09:00:00Z');
const sh = (dir: string, ...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const candidate = (extra = ''): string => `---\ntype: lesson\nstatus: candidate\ncreated: 2026-10-20\n${extra}---\n# X\n\nBody.\n`;

async function setup(files: Record<string, string>): Promise<{ dir: string; options: PromoteOptions; index: BrainIndex }> {
  const dir = path.join(tempDir(), 'vault');
  await ensureVault(dir, ['acme/shop'], NOW);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const index = new BrainIndex(Logger.silent());
  const git = createVaultGit(dir, Logger.silent(), { onCommit: (_sha, paths) => index.update(dir, paths) });
  await git.commitHumanChanges();
  await index.rebuild(dir);
  return { dir, index, options: { vault: dir, git, index: () => index.current(dir), logger: Logger.silent(), now: () => NOW } };
}

const read = (dir: string, rel: string) => parseNote(fs.readFileSync(path.join(dir, rel), 'utf8')).frontmatter;

describe('targetPath', () => {
  it('takes target as folder, folder without slash or full path, else the type folder', () => {
    assert.equal(targetPath({ type: 'lesson' }, 'Inbox/x.md'), 'Lessons/x.md');
    assert.equal(targetPath({ type: 'decision', target: 'Decisions/' }, 'Inbox/x.md'), 'Decisions/x.md');
    assert.equal(targetPath({ type: 'decision', target: 'Decisions/Arch' }, 'Inbox/x.md'), 'Decisions/Arch/x.md');
    assert.equal(targetPath({ type: 'decision', target: 'Decisions/custom.md' }, 'Inbox/x.md'), 'Decisions/custom.md');
    assert.equal(targetPath({ type: 'index', repo: 'acme/shop' }, 'Inbox/x.md'), 'Repos/acme-shop/x.md');
    assert.equal(targetPath({ type: 'note' }, 'Inbox/x.md'), 'Inbox/x.md');
  });
});

describe('approveCandidate', () => {
  it('moves to the type folder, sets approved and updated, commits as human and updates the index', async () => {
    const { dir, options, index } = await setup({ 'Inbox/x.md': candidate() });
    const result = await approveCandidate(options, 'Inbox/x.md');
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.path, 'Lessons/x.md');
    assert.equal(result.previousPath, 'Inbox/x.md');
    assert.equal(result.sha, sh(dir, 'rev-parse', 'HEAD'));
    assert.equal(fs.existsSync(path.join(dir, 'Inbox/x.md')), false);
    const fm = read(dir, 'Lessons/x.md');
    assert.equal(fm.status, 'approved');
    assert.equal(fm.updated, '2026-10-31');
    assert.equal(fm.created, '2026-10-20');
    assert.equal(sh(dir, 'log', '-1', '--format=%an|%s|%b'), 'human|approve: Inbox/x.md|Lessons/x.md');
    const notes = (await index.current(dir)).notes;
    assert.equal(notes.has('Inbox/x.md'), false);
    assert.equal(notes.get('Lessons/x.md')?.status, 'approved');
  });

  it('follows target and adds -2 on a collision', async () => {
    const { dir, options } = await setup({ 'Inbox/x.md': candidate('target: Decisions/\n'), 'Decisions/x.md': '---\ntype: decision\nstatus: approved\n---\nOld.\n' });
    // Decisions/x.md makes the name x.md ambiguous already; the new file gets a free, unique name.
    const result = await approveCandidate(options, 'Inbox/x.md');
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.path, 'Decisions/x-2.md');
    assert.equal(fs.readFileSync(path.join(dir, 'Decisions/x.md'), 'utf8'), '---\ntype: decision\nstatus: approved\n---\nOld.\n');
  });

  it('takes a full target path and rejects a target outside the vault', async () => {
    const { options } = await setup({ 'Inbox/x.md': candidate('target: Decisions/custom.md\n'), 'Inbox/y.md': candidate('target: ../y.md\n') });
    const custom = await approveCandidate(options, 'Inbox/x.md');
    assert.ok(custom.ok && custom.path === 'Decisions/custom.md', JSON.stringify(custom));
    const outside = await approveCandidate(options, 'Inbox/y.md');
    assert.ok(!outside.ok && outside.reason === 'invalid_target', JSON.stringify(outside));
  });

  it('refuses a file name that would not be unique, without any change', async () => {
    const { dir, options } = await setup({ 'Inbox/x.md': candidate(), 'Agents/x.md': '---\ntype: agent\n---\nA.\n' });
    const commits = sh(dir, 'rev-list', '--count', 'HEAD');
    const before = fs.readFileSync(path.join(dir, 'Inbox/x.md'), 'utf8');
    const result = await approveCandidate(options, 'Inbox/x.md');
    assert.ok(!result.ok && result.reason === 'name_not_unique', JSON.stringify(result));
    assert.match(result.message, /Agents\/x\.md/);
    assert.equal(fs.readFileSync(path.join(dir, 'Inbox/x.md'), 'utf8'), before);
    assert.equal(sh(dir, 'rev-list', '--count', 'HEAD'), commits);
  });

  it('only takes candidates and checks the path like the tools', async () => {
    const { options } = await setup({ 'Lessons/a.md': '---\ntype: lesson\nstatus: approved\n---\nA.\n' });
    for (const fn of [approveCandidate, rejectCandidate]) {
      const approved = await fn(options, 'Lessons/a.md');
      assert.ok(!approved.ok && approved.reason === 'not_candidate', JSON.stringify(approved));
      const missing = await fn(options, 'Inbox/none.md');
      assert.ok(!missing.ok && missing.reason === 'not_found', JSON.stringify(missing));
      for (const bad of ['../x.md', '.obsidian/x.md', 'Inbox/x.txt', '/etc/x.md']) {
        const result = await fn(options, bad);
        assert.ok(!result.ok && result.reason === 'invalid_path', bad);
      }
    }
  });

  it('commits manual changes first, so the approve commit only holds the note', async () => {
    const { dir, options } = await setup({ 'Inbox/x.md': candidate() });
    fs.writeFileSync(path.join(dir, 'Inbox/other.md'), '---\ntype: note\n---\nManual.\n');
    assert.ok((await approveCandidate(options, 'Inbox/x.md')).ok);
    assert.equal(sh(dir, 'show', '--name-only', '--no-renames', '--format=', 'HEAD'), 'Inbox/x.md\nLessons/x.md');
    assert.equal(sh(dir, 'log', '-1', '--skip=1', '--format=%an|%s'), 'human|Obsidian: 1 Dateien');
  });
});

describe('rejectCandidate', () => {
  it('sets deprecated and updated, leaves the file in place and commits reject: <path>', async () => {
    const { dir, options } = await setup({ 'Inbox/x.md': candidate() });
    const result = await rejectCandidate(options, 'Inbox/x.md');
    assert.ok(result.ok && result.path === 'Inbox/x.md' && result.previousPath === 'Inbox/x.md', JSON.stringify(result));
    assert.equal(read(dir, 'Inbox/x.md').status, 'deprecated');
    assert.equal(read(dir, 'Inbox/x.md').updated, '2026-10-31');
    assert.equal(sh(dir, 'log', '-1', '--format=%an|%s'), 'human|reject: Inbox/x.md');
  });
});

describe('revertDecision', () => {
  it('reverts the approve commit: the candidate is back at its old path', async () => {
    const { dir, options, index } = await setup({ 'Inbox/x.md': candidate() });
    const original = fs.readFileSync(path.join(dir, 'Inbox/x.md'), 'utf8');
    assert.ok((await approveCandidate(options, 'Inbox/x.md')).ok);
    const result = await revertDecision(options, 'Lessons/x.md');
    assert.ok(result.ok && result.path === 'Inbox/x.md' && result.previousPath === 'Lessons/x.md', JSON.stringify(result));
    assert.equal(fs.readFileSync(path.join(dir, 'Inbox/x.md'), 'utf8'), original);
    assert.equal(fs.existsSync(path.join(dir, 'Lessons/x.md')), false);
    assert.equal(sh(dir, 'log', '-1', '--format=%an|%s'), 'human|Revert "approve: Inbox/x.md"');
    assert.equal((await index.current(dir)).notes.get('Inbox/x.md')?.status, 'candidate');
  });

  it('reverts the reject commit: the note is a candidate again, as a new commit (E7-8)', async () => {
    const { dir, options, index } = await setup({ 'Inbox/x.md': candidate() });
    const original = fs.readFileSync(path.join(dir, 'Inbox/x.md'), 'utf8');
    assert.ok((await rejectCandidate(options, 'Inbox/x.md')).ok);
    const count = Number(sh(dir, 'rev-list', '--count', 'HEAD'));
    const result = await revertDecision(options, 'Inbox/x.md');
    assert.ok(result.ok && result.path === 'Inbox/x.md' && result.previousPath === 'Inbox/x.md', JSON.stringify(result));
    assert.equal(fs.readFileSync(path.join(dir, 'Inbox/x.md'), 'utf8'), original);
    assert.equal(sh(dir, 'log', '-1', '--format=%an|%s'), 'human|Revert "reject: Inbox/x.md"');
    assert.equal(Number(sh(dir, 'rev-list', '--count', 'HEAD')), count + 1);
    assert.equal((await index.current(dir)).notes.get('Inbox/x.md')?.status, 'candidate');
  });

  it('answers no_approve_commit, not_found and revert_conflict', async () => {
    const { dir, options } = await setup({ 'Inbox/x.md': candidate(), 'Lessons/plain.md': '---\ntype: lesson\n---\nP.\n' });
    const none = await revertDecision(options, 'Lessons/plain.md');
    assert.ok(!none.ok && none.reason === 'no_approve_commit', JSON.stringify(none));
    const missing = await revertDecision(options, 'Lessons/none.md');
    assert.ok(!missing.ok && missing.reason === 'not_found', JSON.stringify(missing));
    assert.ok((await approveCandidate(options, 'Inbox/x.md')).ok);
    // A human changed the same frontmatter lines in Obsidian since the approve.
    const file = path.join(dir, 'Lessons/x.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('status: approved', 'status: deprecated'));
    const conflict = await revertDecision(options, 'Lessons/x.md');
    assert.ok(!conflict.ok && conflict.reason === 'revert_conflict', JSON.stringify(conflict));
    assert.equal(sh(dir, 'status', '--porcelain'), '');
  });
});
