import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BrainAccessLog, type BrainAccess } from '../src/brain/access-log.ts';
import { createBrainTools, createBrainWriteTools } from '../src/brain/tools.ts';
import { Logger } from '../src/log.ts';
import type { AgentToolContext, ToolResult } from '../src/tracker/types.ts';
import { makeIssue, tempDir } from './helpers.ts';

const NOW = new Date('2026-10-30T12:00:00Z');
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;
const line = (over: Partial<BrainAccess>): string =>
  `${JSON.stringify({ at: ago(0), run: 'run1', issue: 'a/b#1', role: 'developer', op: 'write', path_or_query: 'Inbox/a.md', purpose: '', result: 'ok', ...over })}\n`;
const rows = (file: string): any[] =>
  fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));

describe('BrainAccessLog', () => {
  it('logs every tool call, a missing purpose as an empty string', async () => {
    const vaultDir = tempDir();
    fs.mkdirSync(path.join(vaultDir, 'Inbox'));
    const log = new BrainAccessLog(path.join(tempDir(), 'brain'), Logger.silent());
    const context: AgentToolContext = { issue: makeIssue({ id: 'a' }), role: 'developer', runId: 'run1' };
    const specs = [...createBrainTools(vaultDir, Logger.silent(), log), ...createBrainWriteTools(vaultDir, Logger.silent(), { access: log, now: () => NOW })];
    const call = (name: string, args: Record<string, unknown>): Promise<ToolResult> => specs.find((s) => s.name === name)!.execute(args, context);
    const content = '---\ntype: note\n---\nBody.\n';
    const created = await call('brain_write', { path: 'Inbox/a.md', content, purpose: 'p' });
    assert.ok(created.ok);
    const hash = (created as any).data.hash;
    await call('brain_read', { path: 'Inbox/a.md', purpose: 'p' });
    await call('brain_search', { query: 'body' });
    await call('brain_list', { folder: 'Inbox', purpose: 'p' });
    await call('brain_append', { path: 'Inbox/a.md', heading: 'H', text: 'more', base_hash: hash, purpose: 'p' });
    const lines = rows(log.file!);
    assert.deepEqual(lines.map((l) => l.op), ['write', 'read', 'search', 'list', 'append']);
    for (const l of lines) {
      assert.equal(l.run, 'run1');
      assert.equal(l.role, 'developer');
      assert.equal(l.result, 'ok');
      assert.equal(typeof l.at, 'string');
      assert.equal(typeof l.issue, 'string');
    }
    assert.equal(lines[0].hash_after, hash);
    assert.equal(lines[0].hash_before, undefined);
    assert.equal(lines[4].hash_before, hash);
    assert.equal(lines[2].purpose, '');
    assert.equal(lines[2].path_or_query, 'body');
    assert.equal(lines[1].path_or_query, 'Inbox/a.md');
    assert.equal(lines[0].purpose, 'p');
    const missing = await call('brain_read', { path: 'Inbox/nope.md' });
    assert.equal(missing.ok, false);
    const last = rows(log.file!).at(-1);
    assert.equal(last.result, 'rejected');
    assert.equal(last.reason, 'not_found');
  });

  it('derives the clashes of the last 7 days at startup and resolves them', () => {
    const dir = tempDir();
    const file = path.join(dir, 'access.jsonl');
    fs.writeFileSync(
      file,
      line({ at: ago(10 * DAY), result: 'rejected', reason: 'window', clash_id: 'old', other_run: 'run0', other_at: ago(10 * DAY + 1000), run: 'run2' }) +
        line({ at: ago(3 * DAY), result: 'rejected', reason: 'window', clash_id: 'c1', other_run: 'run1', other_at: ago(3 * DAY + 60000), run: 'run2' }),
    );
    const log = new BrainAccessLog(dir, Logger.silent());
    log.load(NOW);
    const clashes = log.clashes();
    assert.equal(clashes.length, 1);
    assert.deepEqual(clashes[0], { id: 'c1', path: 'Inbox/a.md', runs: ['run1', 'run2'], at: [ago(3 * DAY + 60000), ago(3 * DAY)], reason: 'window', status: 'open' });
    assert.equal(log.markResolved('unknown'), false);
    assert.equal(log.markResolved('c1', NOW), true);
    assert.equal(log.markResolved('c1', NOW), false);
    assert.equal(log.clashes()[0]!.status, 'resolved');
    const last = rows(file).at(-1);
    assert.equal(last.op, 'resolve');
    assert.equal(last.clash_id, 'c1');
    const again = new BrainAccessLog(dir, Logger.silent());
    again.load(NOW);
    assert.equal(again.clashes()[0]!.status, 'resolved');
  });

  it('rebuilds the last writer from the file', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'access.jsonl'), line({ at: ago(2 * 60_000) }));
    const log = new BrainAccessLog(dir, Logger.silent());
    log.load(NOW);
    assert.equal(log.recentWriteByOtherRun('Inbox/a.md', 'run2', NOW, 600_000)?.run, 'run1');
    assert.equal(log.recentWriteByOtherRun('Inbox/a.md', 'run1', NOW, 600_000), null);
    assert.equal(log.recentWriteByOtherRun('Inbox/a.md', 'run2', NOW, 60_000), null);
    assert.equal(log.recentWriteByOtherRun('Inbox/a.md', 'run2', NOW, 0), null);
  });

  it('removes lines older than 30 days and unreadable ones at startup', () => {
    const dir = tempDir();
    const file = path.join(dir, 'access.jsonl');
    const fresh = line({ at: ago(DAY), op: 'read', path_or_query: 'x.md' });
    fs.writeFileSync(file, line({ at: ago(31 * DAY) }) + 'not json\n' + fresh);
    const log = new BrainAccessLog(dir, Logger.silent());
    assert.equal(log.prune(NOW), 2);
    assert.equal(fs.readFileSync(file, 'utf8'), fresh);
    assert.equal(new BrainAccessLog(path.join(dir, 'none'), Logger.silent()).prune(NOW), 0);
    log.load(NOW);
    assert.equal(fs.readFileSync(file, 'utf8'), fresh);
  });

  it('works in memory without a log directory', () => {
    const log = new BrainAccessLog(null, Logger.silent());
    assert.equal(log.file, null);
    const entry: BrainAccess = { at: NOW.toISOString(), run: 'run2', issue: null, role: null, op: 'write', path_or_query: 'a.md', purpose: '', result: 'rejected' };
    log.record(entry);
    const clash = log.recordClash(entry, { run: 'run1', at: ago(1000) }, 'window');
    assert.equal(log.clashes().length, 1);
    assert.equal(log.markResolved(clash.id), true);
    log.load(NOW);
  });
});
