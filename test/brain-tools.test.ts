import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { resolveVaultPath } from '../src/brain/paths.ts';
import { brainToolsFor, createBrainTools } from '../src/brain/tools.ts';
import { Logger } from '../src/log.ts';
import type { AgentToolSpec, ToolResult } from '../src/tracker/types.ts';
import { makeIssue, tempDir } from './helpers.ts';

function note(status: string, extra = '', body = 'Notes about caching.'): string {
  return `---\ntype: lesson\nstatus: ${status}\n${extra}---\n${body}\n`;
}

function vault(): string {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'Inbox'));
  fs.mkdirSync(path.join(dir, '.obsidian'));
  fs.writeFileSync(path.join(dir, '.obsidian', 'app.json'), '{}');
  return dir;
}

function put(dir: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

function toolsOf(dir: string, lines: string[] = []): Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> {
  const logger = Logger.create({ sinks: [{ name: 'memory', write: (line: string) => lines.push(line) }], level: 'debug' } as never);
  const out: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {};
  for (const spec of createBrainTools(dir, logger)) out[spec.name] = (args) => spec.execute({ purpose: 'test', ...args }, { issue: makeIssue({ id: 'a' }) });
  return out;
}

function data(result: ToolResult): any {
  assert.ok(result.ok, JSON.stringify(result));
  return result.data;
}

describe('resolveVaultPath', () => {
  it('rejects escapes, absolute paths and .obsidian', () => {
    const dir = vault();
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', '.obsidian/app.json', './.OBSIDIAN/app.json', 'Inbox\\x.md', '', '~/x']) {
      const result = resolveVaultPath(dir, bad);
      assert.equal(result.ok, false, bad);
      if (!result.ok) assert.notEqual(result.message, '');
    }
    assert.deepEqual(resolveVaultPath(dir, 'Inbox/a.md'), { ok: true, absolute: path.join(dir, 'Inbox', 'a.md'), relative: 'Inbox/a.md' });
    assert.deepEqual(resolveVaultPath(dir, '', { allowRoot: true }), { ok: true, absolute: path.resolve(dir), relative: '' });
  });

  it('rejects a symlink out of the vault', () => {
    const dir = vault();
    const outside = tempDir();
    fs.symlinkSync(outside, path.join(dir, 'Inbox', 'out'));
    assert.equal(resolveVaultPath(dir, 'Inbox/out').ok, false);
    fs.symlinkSync(path.join(dir, '.obsidian'), path.join(dir, 'Inbox', 'obs'));
    assert.equal(resolveVaultPath(dir, 'Inbox/obs/app.json').ok, false);
  });
});

describe('brain tools', () => {
  it('rejects path escapes in read and list', async () => {
    const tools = toolsOf(vault());
    for (const bad of ['../x', '/etc/passwd', '.obsidian/app.json']) {
      const result = await tools.brain_read!({ path: bad });
      assert.ok(!result.ok && result.error.category === 'rejected' && result.error.message !== '', bad);
    }
    const listed = await tools.brain_list!({ folder: '.obsidian' });
    assert.ok(!listed.ok && listed.error.category === 'rejected');
  });

  it('reads content, frontmatter and a SHA-256 hash', async () => {
    const dir = vault();
    const text = note('approved');
    put(dir, 'Inbox/a.md', text);
    put(dir, 'Inbox/plain.md', '# Plain\nno frontmatter');
    put(dir, 'Inbox/broken.md', '---\nfoo: [unclosed\n---\nbody');
    const tools = toolsOf(dir);
    const read = data(await tools.brain_read!({ path: 'Inbox/a.md' }));
    assert.equal(read.content, text);
    assert.equal(read.frontmatter.status, 'approved');
    assert.equal(read.hash, createHash('sha256').update(text).digest('hex'));
    assert.deepEqual(data(await tools.brain_read!({ path: 'Inbox/plain.md' })).frontmatter, {});
    assert.ok(data(await tools.brain_read!({ path: 'Inbox/broken.md' })).frontmatter_error);
    const missing = await tools.brain_read!({ path: 'Inbox/none.md' });
    assert.ok(!missing.ok && missing.error.category === 'not_found');
  });

  it('lists folders and files with type and status, without .obsidian', async () => {
    const dir = vault();
    put(dir, 'Inbox/note.md', note('candidate'));
    const tools = toolsOf(dir);
    const root = data(await tools.brain_list!({}));
    assert.deepEqual(root.entries, [{ name: 'Inbox', path: 'Inbox', kind: 'folder', type: null, status: null }]);
    const inbox = data(await tools.brain_list!({ folder: 'Inbox' }));
    assert.deepEqual(inbox.entries, [{ name: 'note.md', path: 'Inbox/note.md', kind: 'file', type: 'lesson', status: 'candidate' }]);
  });

  it('searches approved before candidate and never returns deprecated', async () => {
    const dir = vault();
    put(dir, 'Inbox/c.md', note('candidate', 'title: Caching candidate\n'));
    put(dir, 'Lessons/a.md', note('approved', 'repo: o/r\n'));
    put(dir, 'Lessons/d.md', note('deprecated', 'title: Caching old\n'));
    const tools = toolsOf(dir);
    const found = data(await tools.brain_search!({ query: 'Caching' }));
    assert.deepEqual(found.results.map((r: { path: string }) => r.path), ['Lessons/a.md', 'Inbox/c.md']);
    for (const hit of found.results) {
      assert.ok(hit.title && hit.status && hit.excerpt.includes('caching'));
    }
    assert.deepEqual(data(await tools.brain_search!({ query: 'caching', repo: 'O/R' })).results.map((r: { path: string }) => r.path), ['Lessons/a.md']);
    assert.equal(data(await tools.brain_search!({ query: 'caching', type: 'decision' })).results.length, 0);
  });

  it('returns at most 20 hits', async () => {
    const dir = vault();
    for (let i = 0; i < 25; i++) put(dir, `Lessons/n${i}.md`, note('approved'));
    const found = data(await toolsOf(dir).brain_search!({ query: 'caching' }));
    assert.equal(found.results.length, 20);
    assert.equal(found.total, 25);
  });

  it('warns without purpose and does not abort', async () => {
    const dir = vault();
    put(dir, 'Inbox/a.md', note('approved'));
    const lines: string[] = [];
    const spec = createBrainTools(
      dir,
      Logger.create({ sinks: [{ name: 'memory', write: (line: string) => lines.push(line) }], level: 'debug' } as never),
    ).find((s): s is AgentToolSpec => s.name === 'brain_read')!;
    const context = { issue: makeIssue({ id: 'a' }) };
    assert.ok((await spec.execute({ path: 'Inbox/a.md' }, context)).ok);
    assert.ok(lines.some((line) => line.includes('brain tool called without purpose')));
    lines.length = 0;
    await spec.execute({ path: 'Inbox/a.md', purpose: 'context' }, context);
    assert.ok(!lines.some((line) => line.includes('without purpose')));
  });

  it('brainToolsFor offers the tools by mode, and only when enabled', () => {
    const dir = vault();
    assert.deepEqual(brainToolsFor({ enabled: false, path: dir }, 'write', Logger.silent()), []);
    assert.deepEqual(brainToolsFor({ enabled: true, path: dir }, 'off', Logger.silent()), []);
    const names = (mode: 'read' | 'write') => brainToolsFor({ enabled: true, path: dir }, mode, Logger.silent()).map((t) => t.name);
    assert.deepEqual(names('read'), ['brain_search', 'brain_read', 'brain_list']);
    const tools = brainToolsFor({ enabled: true, path: dir }, 'write', Logger.silent());
    assert.deepEqual(tools.map((t) => t.name), ['brain_search', 'brain_read', 'brain_list', 'brain_write', 'brain_append']);
    assert.deepEqual(tools.map((t) => t.mutates), [false, false, false, true, true]);
  });
});
