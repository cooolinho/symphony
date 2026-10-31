import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createVaultGit } from '../src/brain/git.ts';
import { createBrainWriteTools } from '../src/brain/tools.ts';
import { ensureVault } from '../src/brain/vault.ts';
import { Logger } from '../src/log.ts';
import type { AgentToolContext, ToolResult } from '../src/tracker/types.ts';
import { makeIssue, tempDir } from './helpers.ts';

const NOW = new Date('2026-10-30T12:00:00Z');
const note = (body = 'Body.'): string => `---\ntype: lesson\n---\n${body}\n`;
const sh = (dir: string, ...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@local'];

async function setup(options: { context?: Partial<AgentToolContext>; onCommit?: (sha: string, paths: string[]) => void | Promise<void> } = {}) {
  const dir = path.join(tempDir(), 'vault');
  await ensureVault(dir, ['acme/shop'], NOW);
  const lines: string[] = [];
  const logger = Logger.create({ sinks: [{ name: 'memory', write: (line: string) => lines.push(line) }], level: 'debug' } as never);
  const context: AgentToolContext = { issue: makeIssue({ id: 'a' }), role: 'developer', runId: 'run1', ...options.context };
  const vaultGit = createVaultGit(dir, logger, options.onCommit ? { onCommit: options.onCommit } : {});
  const tools: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {};
  for (const spec of createBrainWriteTools(dir, logger, { now: () => NOW, versioning: vaultGit })) {
    tools[spec.name] = (args) => spec.execute({ purpose: 'p', ...args }, context);
  }
  return { dir, tools, lines, context, logger };
}

const hashOf = (result: ToolResult): string => (result as { data: { hash: string } }).data.hash;

describe('vault git', () => {
  it('ensureVault inits a repo with .gitignore and one first commit, without .obsidian', async () => {
    const dir = path.join(tempDir(), 'vault');
    fs.mkdirSync(path.join(dir, '.obsidian'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.obsidian', 'app.json'), '{}');
    await ensureVault(dir, ['acme/shop'], NOW);
    assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '.obsidian/workspace*.json\n.trash/\n');
    assert.equal(sh(dir, 'log', '--format=%an'), 'symphony');
    const files = sh(dir, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n');
    for (const f of ['README.md', '.gitignore', 'Kandidaten-Review.base', 'Neueste Lessons.base', 'Repos/acme-shop/index.md']) assert.ok(files.includes(f), f);
    assert.ok(!files.some((f) => f.startsWith('.obsidian')));
    await ensureVault(dir, ['acme/shop'], NOW);
    assert.equal(sh(dir, 'rev-list', '--count', 'HEAD'), '1');
  });

  it('commits a write with role as author, run and purpose in the message', async () => {
    const { dir, tools, context } = await setup();
    const result = await tools.brain_write!({ path: 'Inbox/x.md', content: note(), purpose: 'why  it\nmatters' });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(sh(dir, 'log', '-1', '--format=%an|%ae|%cn|%s|%b'), `symphony-developer|symphony-developer@local|symphony-developer|${context.issue.identifier} run1: why it matters|Inbox/x.md`);
    assert.equal(sh(dir, 'status', '--porcelain'), '');
  });

  it('falls back to agent / - when role and run are missing', async () => {
    const { dir, tools } = await setup({ context: { role: undefined, runId: undefined } });
    assert.ok((await tools.brain_write!({ path: 'Inbox/x.md', content: note(), purpose: '' })).ok);
    assert.match(sh(dir, 'log', '-1', '--format=%an|%s'), /^symphony-agent\|.* -: \(kein Zweck\)$/);
  });

  it('commits manual changes as human before the agent write, except .obsidian', async () => {
    const calls: [string, string[]][] = [];
    const { dir, tools } = await setup({ onCommit: (s, p) => void calls.push([s, p]) });
    const first = await tools.brain_write!({ path: 'Inbox/a.md', content: note('one') });
    fs.writeFileSync(path.join(dir, 'Inbox/a.md'), 'edited by hand\n');
    fs.writeFileSync(path.join(dir, 'Inbox/b.md'), 'new\n');
    fs.mkdirSync(path.join(dir, '.obsidian'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.obsidian/workspace.json'), '{}');
    fs.writeFileSync(path.join(dir, '.obsidian/app.json'), '{}');
    const second = await tools.brain_write!({ path: 'Inbox/c.md', content: note('c') });
    assert.ok(first.ok && second.ok);
    assert.equal(sh(dir, 'log', '-2', '--format=%an|%ae|%s', '--skip=0').split('\n').join(' // '), `symphony-developer|symphony-developer@local|${makeIssue({ id: 'a' }).identifier} run1: test // human|human@local|Obsidian: 2 Dateien`.replace('test', 'p'));
    assert.deepEqual(sh(dir, 'show', '--name-only', '--format=', 'HEAD~1').split('\n').sort(), ['Inbox/a.md', 'Inbox/b.md']);
    assert.equal(sh(dir, 'ls-files', '.obsidian'), '');
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[1]![1].sort(), ['Inbox/a.md', 'Inbox/b.md']);
    assert.deepEqual(calls[2]![1], ['Inbox/c.md']);
  });

  it('makes no human commit without manual changes', async () => {
    const { dir, tools } = await setup();
    await tools.brain_write!({ path: 'Inbox/a.md', content: note() });
    await tools.brain_write!({ path: 'Inbox/b.md', content: note() });
    assert.equal(sh(dir, 'log', '--format=%an').split('\n').filter((a) => a === 'human').length, 0);
  });

  it('takes over a manual edit of the target file as human commit before overwriting it', async () => {
    const { dir, tools } = await setup();
    await tools.brain_write!({ path: 'Inbox/a.md', content: note('one') });
    fs.writeFileSync(path.join(dir, 'Inbox/a.md'), note('manual'));
    const manual = fs.readFileSync(path.join(dir, 'Inbox/a.md'), 'utf8');
    const hash = createHash('sha256').update(manual).digest('hex');
    assert.ok((await tools.brain_write!({ path: 'Inbox/a.md', content: note('two'), base_hash: hash })).ok);
    assert.equal(sh(dir, 'log', '-2', '--format=%an'), 'symphony-developer\nhuman');
    assert.equal(sh(dir, 'show', 'HEAD~1:Inbox/a.md'), manual.trim());
    assert.equal(sh(dir, 'status', '--porcelain'), '');
  });

  it('serializes parallel writes into one commit each', async () => {
    const { dir, tools, logger } = await setup();
    const other = createBrainWriteTools(dir, logger, { now: () => NOW, versioning: createVaultGit(dir, logger) });
    const ctx: AgentToolContext = { issue: makeIssue({ id: 'b' }), role: 'tester', runId: 'run2' };
    const before = sh(dir, 'rev-parse', 'HEAD');
    const results = await Promise.all([
      tools.brain_write!({ path: 'Inbox/a.md', content: note('a') }),
      other[0]!.execute({ path: 'Inbox/b.md', content: note('b'), purpose: 'q' }, ctx),
      tools.brain_write!({ path: 'Inbox/c.md', content: note('c') }),
    ]);
    assert.ok(results.every((r) => r.ok));
    const shas = sh(dir, 'rev-list', `${before}..HEAD`).split('\n');
    assert.equal(shas.length, 3);
    const files = shas.map((s) => sh(dir, 'show', '--name-only', '--format=', s)).sort();
    assert.deepEqual(files, ['Inbox/a.md', 'Inbox/b.md', 'Inbox/c.md']);
    assert.equal(sh(dir, 'status', '--porcelain'), '');
  });

  it('git revert HEAD restores the previous version; history is linear', async () => {
    const { dir, tools } = await setup();
    const first = await tools.brain_write!({ path: 'Inbox/a.md', content: note('one') });
    const firstText = fs.readFileSync(path.join(dir, 'Inbox/a.md'), 'utf8');
    await tools.brain_write!({ path: 'Inbox/a.md', content: note('two'), base_hash: hashOf(first) });
    assert.notEqual(fs.readFileSync(path.join(dir, 'Inbox/a.md'), 'utf8'), firstText);
    sh(dir, ...IDENTITY, 'revert', '--no-edit', 'HEAD');
    assert.equal(fs.readFileSync(path.join(dir, 'Inbox/a.md'), 'utf8'), firstText);
    assert.ok(sh(dir, 'log', '--format=%P').split('\n').every((p) => p.split(' ').length <= 1));
  });

  it('logs a failing onCommit hook and still succeeds', async () => {
    const { tools, lines } = await setup({
      onCommit: () => {
        throw new Error('hook boom');
      },
    });
    assert.ok((await tools.brain_write!({ path: 'Inbox/a.md', content: note() })).ok);
    assert.ok(lines.some((l) => l.includes('onCommit') && l.includes('hook boom')));
  });

  it('rejects on a git error, logs it and restores the vault', async () => {
    const { dir, tools, lines } = await setup();
    const created = await tools.brain_write!({ path: 'Inbox/a.md', content: note('one') });
    const before = fs.readFileSync(path.join(dir, 'Inbox/a.md'), 'utf8');
    fs.writeFileSync(path.join(dir, '.git/index.lock'), '');
    const newNote = await tools.brain_write!({ path: 'Inbox/new.md', content: note() });
    const existing = await tools.brain_write!({ path: 'Inbox/a.md', content: note('two'), base_hash: hashOf(created) });
    for (const r of [newNote, existing]) {
      assert.equal(r.ok, false);
      assert.equal((r as { error: { category: string } }).error.category, 'rejected');
    }
    assert.ok(lines.some((l) => l.includes('error') && l.includes('vault commit failed')));
    fs.rmSync(path.join(dir, '.git/index.lock'));
    assert.equal(fs.existsSync(path.join(dir, 'Inbox/new.md')), false);
    assert.equal(fs.readFileSync(path.join(dir, 'Inbox/a.md'), 'utf8'), before);
    assert.ok((await tools.brain_write!({ path: 'Inbox/new.md', content: note() })).ok);
    assert.equal(sh(dir, 'status', '--porcelain'), '');
  });
});

describe('vault git: human commits and revert (E7-6b)', () => {
  it('commitHuman commits added and removed paths as human and calls onCommit with both', async () => {
    const calls: [string, string[]][] = [];
    const { dir, logger } = await setup();
    const vaultGit = createVaultGit(dir, logger, { onCommit: (sha, paths) => void calls.push([sha, paths]) });
    fs.writeFileSync(path.join(dir, 'Inbox/x.md'), note());
    await vaultGit.serial(() => vaultGit.commitHuman(['Inbox/x.md'], 'add', null));
    fs.renameSync(path.join(dir, 'Inbox/x.md'), path.join(dir, 'Lessons/x.md'));
    const sha = await vaultGit.serial(() => vaultGit.commitHuman(['Inbox/x.md', 'Lessons/x.md'], 'approve: Inbox/x.md', 'Lessons/x.md'));
    assert.equal(sha, sh(dir, 'rev-parse', 'HEAD'));
    assert.equal(sh(dir, 'log', '-1', '--format=%an|%ae|%s|%b'), 'human|human@local|approve: Inbox/x.md|Lessons/x.md');
    assert.deepEqual(calls.at(-1), [sha, ['Inbox/x.md', 'Lessons/x.md']]);
    assert.equal(sh(dir, 'status', '--porcelain'), '');
    assert.equal(await vaultGit.serial(() => vaultGit.commitHuman(['Lessons/x.md'], 'nothing', null)), null);
  });

  it('revert takes a commit back as human; a conflict aborts and leaves the tree clean', async () => {
    const calls: string[][] = [];
    const { dir, logger } = await setup();
    const vaultGit = createVaultGit(dir, logger, { onCommit: (_sha, paths) => void calls.push(paths) });
    fs.writeFileSync(path.join(dir, 'Inbox/x.md'), note('One.'));
    await vaultGit.serial(() => vaultGit.commitHuman(['Inbox/x.md'], 'add', null));
    fs.writeFileSync(path.join(dir, 'Inbox/x.md'), note('Two.'));
    const changed = (await vaultGit.serial(() => vaultGit.commitHuman(['Inbox/x.md'], 'change', null)))!;
    const sha = await vaultGit.serial(() => vaultGit.revert(changed, ['Inbox/x.md']));
    assert.equal(sh(dir, 'log', '-1', '--format=%an|%s'), 'human|Revert "change"');
    assert.equal(sha, sh(dir, 'rev-parse', 'HEAD'));
    assert.equal(fs.readFileSync(path.join(dir, 'Inbox/x.md'), 'utf8'), note('One.'));
    assert.deepEqual(calls.at(-1), ['Inbox/x.md']);

    fs.writeFileSync(path.join(dir, 'Inbox/x.md'), note('Three.'));
    await vaultGit.serial(() => vaultGit.commitHuman(['Inbox/x.md'], 'three', null));
    const head = sh(dir, 'rev-parse', 'HEAD');
    await assert.rejects(vaultGit.serial(() => vaultGit.revert(changed, ['Inbox/x.md'])));
    assert.equal(sh(dir, 'rev-parse', 'HEAD'), head);
    assert.equal(sh(dir, 'status', '--porcelain'), '');
  });
});
