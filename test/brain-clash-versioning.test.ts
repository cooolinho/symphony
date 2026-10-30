import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BrainAccessLog } from '../src/brain/access-log.ts';
import { createVaultGit } from '../src/brain/git.ts';
import { createBrainWriteTools } from '../src/brain/tools.ts';
import { ensureVault } from '../src/brain/vault.ts';
import { Logger } from '../src/log.ts';
import type { AgentToolContext, ToolResult } from '../src/tracker/types.ts';
import { makeIssue, tempDir } from './helpers.ts';

// E7-4 together with vault versioning (E7-3): the combination the worker uses in production.

const T0 = new Date('2026-10-30T12:00:00Z');
const MIN = 60_000;
const note = (body: string): string => `---\ntype: lesson\n---\n${body}\n`;
const commits = (dir: string): number => Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim());

type Call = (args: Record<string, unknown>) => Promise<ToolResult>;

async function setup() {
  const dir = path.join(tempDir(), 'vault');
  await ensureVault(dir, [], T0);
  const logDir = path.join(tempDir(), 'brain');
  const access = new BrainAccessLog(logDir, Logger.silent());
  const clock = { now: new Date(T0) };
  const versioning = createVaultGit(dir, Logger.silent());
  const specs = createBrainWriteTools(dir, Logger.silent(), { now: () => new Date(clock.now), access, clashWindowMs: 10 * MIN, versioning });
  const session = (run: string) => {
    const context: AgentToolContext = { issue: makeIssue({ id: 'a' }), role: 'developer', runId: run };
    const call = (name: string): Call => {
      const spec = specs.find((s) => s.name === name)!;
      return (args) => spec.execute({ purpose: 'p', ...args }, context);
    };
    return { write: call('brain_write'), append: call('brain_append') };
  };
  const rows = (): any[] =>
    fs
      .readFileSync(path.join(logDir, 'access.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l));
  return { dir, access, clock, session, rows };
}

const hashOf = (r: ToolResult): string => (r as { data: { hash: string } }).data.hash;
const errOf = (r: ToolResult): any => {
  assert.equal(r.ok, false, 'expected a rejection');
  return (r as Extract<ToolResult, { ok: false }>).error;
};

describe('E7-4 with vault versioning', () => {
  it('rejects another run within the window without a new commit, with one clash and a log line', async () => {
    const e = await setup();
    const a = e.session('run1');
    const b = e.session('run2');
    const first = await a.write({ path: 'Inbox/a.md', content: note('one') });
    assert.ok(first.ok);
    const before = commits(e.dir);
    e.clock.now = new Date(T0.getTime() + 5 * MIN);
    const second = await b.write({ path: 'Inbox/a.md', content: note('two'), base_hash: hashOf(first) });
    const err = errOf(second);
    assert.equal(err.details.reason, 'window');
    assert.equal(err.details.hash, hashOf(first));
    assert.equal(fs.readFileSync(path.join(e.dir, 'Inbox/a.md'), 'utf8').includes('two'), false);
    assert.equal(commits(e.dir), before, 'a rejected write makes no commit');
    const clashes = e.access.clashes();
    assert.equal(clashes.length, 1);
    assert.deepEqual(clashes[0]!.runs, ['run1', 'run2']);
    assert.equal(clashes[0]!.reason, 'window');
    assert.equal(clashes[0]!.status, 'open');
    const last = e.rows().at(-1);
    assert.equal(last.result, 'rejected');
    assert.equal(last.reason, 'window');
  });

  it('lets the same run write again at once, and another run after the window', async () => {
    const e = await setup();
    const a = e.session('run1');
    const b = e.session('run2');
    const first = await a.write({ path: 'Inbox/a.md', content: note('one') });
    const again = await a.write({ path: 'Inbox/a.md', content: note('two'), base_hash: hashOf(first as ToolResult) });
    assert.ok(again.ok, JSON.stringify(again));
    e.clock.now = new Date(T0.getTime() + 10 * MIN + 1);
    const other = await b.write({ path: 'Inbox/a.md', content: note('three'), base_hash: hashOf(again) });
    assert.ok(other.ok, JSON.stringify(other));
    assert.equal(e.access.clashes().length, 0);
    const oks = e.rows().filter((l) => l.result === 'ok' && l.op === 'write');
    assert.equal(oks.length, 3);
    for (const l of oks) assert.match(l.hash_after, /^[0-9a-f]{64}$/);
  });

  it('logs a stale base_hash after the window as hash_mismatch with a clash', async () => {
    const e = await setup();
    const a = e.session('run1');
    const b = e.session('run2');
    const first = await a.write({ path: 'Inbox/a.md', content: note('one') });
    e.clock.now = new Date(T0.getTime() + 11 * MIN);
    const err = errOf(await b.write({ path: 'Inbox/a.md', content: note('two'), base_hash: 'f'.repeat(64) }));
    assert.equal(err.details.reason, 'hash_mismatch');
    assert.equal(e.access.clashes().length, 1);
    assert.equal(e.access.clashes()[0]!.reason, 'hash_mismatch');
    assert.equal(e.rows().at(-1).hash_before, hashOf(first));
  });

  it('lets exactly one of two parallel writers of the same note win and records the loser as rejected', async () => {
    const e = await setup();
    const a = e.session('run1');
    const b = e.session('run2');
    const first = await a.write({ path: 'Inbox/a.md', content: note('one') });
    e.clock.now = new Date(T0.getTime() + 11 * MIN);
    const base = hashOf(first);
    const results = await Promise.all([
      a.write({ path: 'Inbox/a.md', content: note('from a'), base_hash: base }),
      b.write({ path: 'Inbox/a.md', content: note('from b'), base_hash: base }),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    const rejected = e.rows().filter((l) => l.result === 'rejected');
    assert.equal(rejected.length, 1);
    // Every rejection produces a clash (acceptance criterion), also when the versioning queue decides it.
    assert.equal(e.access.clashes().length, 1);
  });
});
