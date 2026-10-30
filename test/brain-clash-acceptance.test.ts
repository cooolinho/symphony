import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BrainAccessLog } from '../src/brain/access-log.ts';
import { brainToolsFor } from '../src/brain/tools.ts';
import { Logger } from '../src/log.ts';
import type { AgentToolContext, ToolResult } from '../src/tracker/types.ts';
import { makeWorkflow, makeIssue, tempDir } from './helpers.ts';

// Acceptance tests for E7-4 (access log and clash detection), derived from the issue text.

const T0 = new Date('2026-10-30T12:00:00Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOTE = (body: string): string => `---\ntype: note\n---\n${body}\n`;

interface Env {
  vault: string;
  logDir: string;
  log: BrainAccessLog;
  clock: { now: Date };
  /** A session of the given run: the same shared log, a fresh set of tools (as the worker does per session). */
  session: (run: string | null, role?: string) => Record<string, (args: Record<string, unknown>) => Promise<ToolResult>>;
}

function env(options: { windowMs?: number; log?: BrainAccessLog; logDir?: string; vault?: string } = {}): Env {
  const vault = options.vault ?? tempDir();
  fs.mkdirSync(path.join(vault, 'Inbox'), { recursive: true });
  const logDir = options.logDir ?? path.join(tempDir(), 'brain');
  const log = options.log ?? new BrainAccessLog(logDir, Logger.silent());
  const clock = { now: new Date(T0) };
  const session = (run: string | null, role = 'developer') => {
    const context = { issue: makeIssue({ id: 'a' }), role, ...(run !== null ? { runId: run } : {}) } as AgentToolContext;
    const specs = brainToolsFor(
      { enabled: true, path: vault, ...(options.windowMs !== undefined ? { clashWindowMs: options.windowMs } : {}) },
      Logger.silent(),
      { access: log, now: () => new Date(clock.now) },
    );
    const tools: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {};
    for (const spec of specs) tools[spec.name] = (args) => spec.execute(args, context);
    return tools;
  };
  return { vault, logDir, log, clock, session };
}

const rows = (logDir: string): any[] =>
  fs
    .readFileSync(path.join(logDir, 'access.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l));

function data(result: ToolResult): any {
  assert.ok(result.ok, JSON.stringify(result));
  return result.data;
}

function rejection(result: ToolResult): { category: string; details: any } {
  assert.equal(result.ok, false, 'expected a rejection');
  return (result as Extract<ToolResult, { ok: false }>).error as never;
}

const readFile = (e: Env, rel: string): string => fs.readFileSync(path.join(e.vault, rel), 'utf8');

describe('E7-4 access log: one line per call', () => {
  it('logs read, search, list, write and append with the documented fields', async () => {
    const e = env();
    const s = e.session('run1');
    const created = data(await s.brain_write!({ path: 'Inbox/a.md', content: NOTE('hello'), purpose: 'why write' }));
    await s.brain_read!({ path: 'Inbox/a.md', purpose: 'why read' });
    await s.brain_search!({ query: 'hello', purpose: 'why search' });
    await s.brain_list!({ folder: 'Inbox', purpose: 'why list' });
    data(await s.brain_append!({ path: 'Inbox/a.md', heading: 'More', text: 'x', base_hash: created.hash, purpose: 'why append' }));

    const lines = rows(e.logDir);
    assert.deepEqual(lines.map((l) => l.op), ['write', 'read', 'search', 'list', 'append']);
    assert.deepEqual(lines.map((l) => l.purpose), ['why write', 'why read', 'why search', 'why list', 'why append']);
    assert.deepEqual(lines.map((l) => l.path_or_query), ['Inbox/a.md', 'Inbox/a.md', 'hello', 'Inbox', 'Inbox/a.md']);
    for (const l of lines) {
      assert.equal(l.run, 'run1');
      assert.equal(l.role, 'developer');
      assert.ok(typeof l.issue === 'string' && l.issue !== '');
      assert.ok(!Number.isNaN(Date.parse(l.at)));
      assert.equal(l.result, 'ok');
    }
    // The injected clock is used by the write tools.
    assert.equal(lines[0].at, T0.toISOString());
    assert.equal(lines[0].hash_after, created.hash);
    assert.equal(lines[4].hash_before, created.hash);
    assert.match(lines[4].hash_after, /^[0-9a-f]{64}$/);
    assert.notEqual(lines[4].hash_after, created.hash);
  });

  it('logs a missing purpose as an empty string, for reads and writes', async () => {
    const e = env();
    const s = e.session('run1');
    await s.brain_write!({ path: 'Inbox/a.md', content: NOTE('x') });
    await s.brain_read!({ path: 'Inbox/a.md' });
    await s.brain_list!({});
    for (const l of rows(e.logDir)) assert.strictEqual(l.purpose, '');
  });

  it('logs failed calls as rejected with a reason', async () => {
    const e = env();
    const s = e.session('run1');
    assert.equal((await s.brain_read!({ path: 'Inbox/missing.md', purpose: 'p' })).ok, false);
    assert.equal((await s.brain_read!({ path: '../etc/passwd', purpose: 'p' })).ok, false);
    const lines = rows(e.logDir);
    assert.equal(lines.length, 2);
    for (const l of lines) {
      assert.equal(l.op, 'read');
      assert.equal(l.result, 'rejected');
      assert.ok(typeof l.reason === 'string' && l.reason !== '');
    }
  });

  it('creates <logDir>/brain/access.jsonl below the log directory', async () => {
    const base = tempDir();
    const log = new BrainAccessLog(path.join(base, 'brain'), Logger.silent());
    const e = env({ log });
    await e.session('run1').brain_list!({ purpose: 'p' });
    assert.ok(fs.existsSync(path.join(base, 'brain', 'access.jsonl')));
  });
});

describe('E7-4 window clash', () => {
  async function seeded(windowMs?: number) {
    const e = env(windowMs !== undefined ? { windowMs } : {});
    const first = data(await e.session('runA').brain_write!({ path: 'Inbox/n.md', content: NOTE('v1'), purpose: 'seed' }));
    return { e, hash: first.hash as string, original: readFile(e, 'Inbox/n.md') };
  }

  it('rejects brain_write of another run within the window with reason window, current version and hash, and writes nothing', async () => {
    const { e, hash, original } = await seeded();
    e.clock.now = new Date(T0.getTime() + 5 * MIN);
    // The base_hash is correct: only the window can reject.
    const result = rejection(await e.session('runB').brain_write!({ path: 'Inbox/n.md', content: NOTE('v2'), base_hash: hash, purpose: 'p' }));
    assert.equal(result.category, 'rejected');
    assert.equal(result.details.reason, 'window');
    assert.equal(result.details.hash, hash);
    assert.equal(result.details.content, original);
    assert.equal(readFile(e, 'Inbox/n.md'), original);

    const last = rows(e.logDir).at(-1);
    assert.equal(last.op, 'write');
    assert.equal(last.run, 'runB');
    assert.equal(last.result, 'rejected');
    assert.equal(last.reason, 'window');
  });

  it('rejects brain_append of another run within the window', async () => {
    const { e, hash, original } = await seeded();
    e.clock.now = new Date(T0.getTime() + MIN);
    const result = rejection(await e.session('runB').brain_append!({ path: 'Inbox/n.md', heading: 'H', text: 'x', base_hash: hash, purpose: 'p' }));
    assert.equal(result.details.reason, 'window');
    assert.equal(result.details.hash, hash);
    assert.equal(readFile(e, 'Inbox/n.md'), original);
    assert.equal(rows(e.logDir).at(-1).op, 'append');
  });

  it('checks the window before the hash', async () => {
    const { e, original } = await seeded();
    const result = rejection(await e.session('runB').brain_write!({ path: 'Inbox/n.md', content: NOTE('v2'), base_hash: 'f'.repeat(64), purpose: 'p' }));
    assert.equal(result.details.reason, 'window');
    assert.equal(readFile(e, 'Inbox/n.md'), original);
  });

  it('lets the same run write its own note again at once, repeatedly', async () => {
    const { e, hash } = await seeded();
    const s = e.session('runA');
    const second = data(await s.brain_write!({ path: 'Inbox/n.md', content: NOTE('v2'), base_hash: hash, purpose: 'p' }));
    const third = data(await s.brain_append!({ path: 'Inbox/n.md', heading: 'H', text: 'more', base_hash: second.hash, purpose: 'p' }));
    data(await s.brain_write!({ path: 'Inbox/n.md', content: NOTE('v3'), base_hash: third.hash, purpose: 'p' }));
    assert.match(readFile(e, 'Inbox/n.md'), /v3/);
    assert.equal(e.log.clashes().length, 0);
  });

  it('lets the same run write again even when a new session (tools) is created for it', async () => {
    const { e, hash } = await seeded();
    data(await e.session('runA').brain_write!({ path: 'Inbox/n.md', content: NOTE('v2'), base_hash: hash, purpose: 'p' }));
    assert.match(readFile(e, 'Inbox/n.md'), /v2/);
  });

  it('lets another run write after the window has passed (injected clock)', async () => {
    const { e, hash } = await seeded();
    e.clock.now = new Date(T0.getTime() + 10 * MIN + 1);
    data(await e.session('runB').brain_write!({ path: 'Inbox/n.md', content: NOTE('v2'), base_hash: hash, purpose: 'p' }));
    assert.match(readFile(e, 'Inbox/n.md'), /v2/);
    assert.equal(e.log.clashes().length, 0);
  });

  it('still rejects shortly before the end of the window', async () => {
    const { e, hash } = await seeded();
    e.clock.now = new Date(T0.getTime() + 10 * MIN - 1000);
    assert.equal(rejection(await e.session('runB').brain_write!({ path: 'Inbox/n.md', content: NOTE('v2'), base_hash: hash })).details.reason, 'window');
  });

  it('measures the window from the latest successful write', async () => {
    const { e, hash } = await seeded();
    e.clock.now = new Date(T0.getTime() + 8 * MIN);
    const second = data(await e.session('runA').brain_write!({ path: 'Inbox/n.md', content: NOTE('v2'), base_hash: hash }));
    // 12 minutes after the first write, but only 4 after the second.
    e.clock.now = new Date(T0.getTime() + 12 * MIN);
    assert.equal(rejection(await e.session('runB').brain_write!({ path: 'Inbox/n.md', content: NOTE('v3'), base_hash: second.hash })).details.reason, 'window');
  });

  it('uses brain.clash_window_ms (a short window expires sooner, 0 turns the check off)', async () => {
    const short = await seeded(1000);
    short.e.clock.now = new Date(T0.getTime() + 2000);
    data(await short.e.session('runB').brain_write!({ path: 'Inbox/n.md', content: NOTE('v2'), base_hash: short.hash }));

    const off = await seeded(0);
    data(await off.e.session('runB').brain_write!({ path: 'Inbox/n.md', content: NOTE('v2'), base_hash: off.hash }));
    assert.equal(off.e.log.clashes().length, 0);

    const long = await seeded(60 * MIN);
    long.e.clock.now = new Date(T0.getTime() + 30 * MIN);
    assert.equal(rejection(await long.e.session('runB').brain_write!({ path: 'Inbox/n.md', content: NOTE('v2'), base_hash: long.hash })).details.reason, 'window');
  });

  it('does not treat reads, other notes or rejected writes as a write window', async () => {
    const { e, hash } = await seeded();
    // another note is free
    data(await e.session('runB').brain_write!({ path: 'Inbox/other.md', content: NOTE('o') }));
    // runB was rejected on n.md; that does not start a window for runB there.
    e.clock.now = new Date(T0.getTime() + 11 * MIN);
    rejection(await e.session('runB').brain_write!({ path: 'Inbox/n.md', content: NOTE('x'), base_hash: 'f'.repeat(64) }));
    const current = data(await e.session('runC').brain_read!({ path: 'Inbox/n.md' }));
    assert.equal(current.hash, hash);
    // reading never blocks a writer
    data(await e.session('runC').brain_write!({ path: 'Inbox/n.md', content: NOTE('c'), base_hash: hash }));
  });

  it('shares the log across sessions: two parallel writers of one note, exactly one wins', async () => {
    const { e, hash } = await seeded();
    e.clock.now = new Date(T0.getTime() + 20 * MIN);
    const [a, b] = await Promise.all([
      e.session('runB').brain_write!({ path: 'Inbox/n.md', content: NOTE('from B'), base_hash: hash }),
      e.session('runC').brain_write!({ path: 'Inbox/n.md', content: NOTE('from C'), base_hash: hash }),
    ]);
    assert.equal([a, b].filter((r) => r.ok).length, 1);
    const loser = rejection(a.ok ? b : a);
    assert.ok(loser.details.reason === 'window' || loser.details.reason === 'hash_mismatch');
    assert.equal(e.log.clashes().length, 1);
  });
});

describe('E7-4 hash_mismatch', () => {
  it('rejects a write with another content hash, logs it and creates one clash', async () => {
    const e = env();
    const created = data(await e.session('runA').brain_write!({ path: 'Inbox/n.md', content: NOTE('v1'), purpose: 'seed' }));
    // same run, so the window is not involved
    const before = readFile(e, 'Inbox/n.md');
    const result = rejection(await e.session('runA').brain_write!({ path: 'Inbox/n.md', content: NOTE('v2'), base_hash: 'a'.repeat(64), purpose: 'p' }));
    assert.equal(result.category, 'rejected');
    assert.equal(result.details.reason, 'hash_mismatch');
    assert.equal(result.details.hash, created.hash);
    assert.equal(result.details.content, before);
    assert.equal(readFile(e, 'Inbox/n.md'), before);

    const last = rows(e.logDir).at(-1);
    assert.equal(last.op, 'write');
    assert.equal(last.result, 'rejected');
    assert.equal(last.reason, 'hash_mismatch');
    assert.equal(last.path_or_query, 'Inbox/n.md');

    const clashes = e.log.clashes();
    assert.equal(clashes.length, 1);
    assert.equal(clashes[0]!.reason, 'hash_mismatch');
    assert.equal(clashes[0]!.path, 'Inbox/n.md');
    assert.equal(clashes[0]!.status, 'open');
  });

  it('rejects a stale brain_append hash and logs it', async () => {
    const e = env();
    data(await e.session('runA').brain_write!({ path: 'Inbox/n.md', content: NOTE('v1') }));
    const result = rejection(await e.session('runA').brain_append!({ path: 'Inbox/n.md', heading: 'H', text: 'x', base_hash: 'b'.repeat(64) }));
    assert.equal(result.details.reason, 'hash_mismatch');
    const last = rows(e.logDir).at(-1);
    assert.equal(last.op, 'append');
    assert.equal(last.reason, 'hash_mismatch');
    assert.equal(e.log.clashes().length, 1);
  });

  it('rejects after the window passed when another run changed the file in between', async () => {
    const e = env();
    const first = data(await e.session('runA').brain_write!({ path: 'Inbox/n.md', content: NOTE('v1') }));
    e.clock.now = new Date(T0.getTime() + 30 * MIN);
    data(await e.session('runB').brain_write!({ path: 'Inbox/n.md', content: NOTE('v2'), base_hash: first.hash }));
    e.clock.now = new Date(T0.getTime() + 60 * MIN);
    // runA still holds the old hash
    const result = rejection(await e.session('runA').brain_write!({ path: 'Inbox/n.md', content: NOTE('v3'), base_hash: first.hash }));
    assert.equal(result.details.reason, 'hash_mismatch');
    assert.match(readFile(e, 'Inbox/n.md'), /v2/);
  });
});

describe('E7-4 clash objects', () => {
  it('creates a clash {path, runs [a, b], at [t1, t2], reason, status open} per window rejection', async () => {
    const e = env();
    const first = data(await e.session('runA').brain_write!({ path: 'Inbox/n.md', content: NOTE('v1') }));
    e.clock.now = new Date(T0.getTime() + 3 * MIN);
    rejection(await e.session('runB').brain_write!({ path: 'Inbox/n.md', content: NOTE('v2'), base_hash: first.hash }));

    const clashes = e.log.clashes();
    assert.equal(clashes.length, 1);
    const clash = clashes[0]!;
    assert.ok(typeof clash.id === 'string' && clash.id !== '');
    assert.equal(clash.path, 'Inbox/n.md');
    assert.deepEqual(clash.runs, ['runA', 'runB']);
    assert.deepEqual(clash.at, [T0.toISOString(), new Date(T0.getTime() + 3 * MIN).toISOString()]);
    assert.equal(clash.reason, 'window');
    assert.equal(clash.status, 'open');
  });

  it('creates one clash per rejection with distinct ids', async () => {
    const e = env();
    const first = data(await e.session('runA').brain_write!({ path: 'Inbox/n.md', content: NOTE('v1') }));
    rejection(await e.session('runB').brain_write!({ path: 'Inbox/n.md', content: NOTE('v2'), base_hash: first.hash }));
    rejection(await e.session('runC').brain_write!({ path: 'Inbox/n.md', content: NOTE('v3'), base_hash: first.hash }));
    const ids = new Set(e.log.clashes().map((c) => c.id));
    assert.equal(ids.size, 2);
  });

  it('derives the clash list from the log of the last 7 days at startup', async () => {
    const e = env();
    const first = data(await e.session('runA').brain_write!({ path: 'Inbox/n.md', content: NOTE('v1') }));
    rejection(await e.session('runB').brain_write!({ path: 'Inbox/n.md', content: NOTE('v2'), base_hash: first.hash }));
    rejection(await e.session('runA').brain_write!({ path: 'Inbox/n.md', content: NOTE('v2'), base_hash: 'c'.repeat(64) }));
    const before = e.log.clashes();
    assert.equal(before.length, 2);

    const within = new BrainAccessLog(e.logDir, Logger.silent());
    within.load(new Date(T0.getTime() + 6 * DAY));
    assert.deepEqual(
      within.clashes().map((c) => ({ path: c.path, runs: c.runs, at: c.at, reason: c.reason, status: c.status })).sort((x, y) => x.reason.localeCompare(y.reason)),
      before.map((c) => ({ path: c.path, runs: c.runs, at: c.at, reason: c.reason, status: c.status })).sort((x, y) => x.reason.localeCompare(y.reason)),
    );

    const stale = new BrainAccessLog(e.logDir, Logger.silent());
    stale.load(new Date(T0.getTime() + 8 * DAY));
    assert.equal(stale.clashes().length, 0);
    // 8 days is still inside the 30-day retention: the lines stay in the file
    assert.ok(rows(e.logDir).length >= 3);
  });

  it('markResolved(id) sets resolved, logs op resolve and survives a restart', async () => {
    const e = env();
    const first = data(await e.session('runA').brain_write!({ path: 'Inbox/n.md', content: NOTE('v1') }));
    rejection(await e.session('runB').brain_write!({ path: 'Inbox/n.md', content: NOTE('v2'), base_hash: first.hash }));
    const id = e.log.clashes()[0]!.id;
    const linesBefore = rows(e.logDir).length;

    e.log.markResolved(id);

    assert.equal(e.log.clashes().find((c) => c.id === id)!.status, 'resolved');
    const lines = rows(e.logDir);
    assert.equal(lines.length, linesBefore + 1);
    assert.equal(lines.at(-1).op, 'resolve');

    const restarted = new BrainAccessLog(e.logDir, Logger.silent());
    restarted.load(new Date(T0.getTime() + DAY));
    assert.equal(restarted.clashes().length, 1);
    assert.equal(restarted.clashes()[0]!.status, 'resolved');
  });
});

describe('E7-4 rotation at startup', () => {
  const line = (at: Date, over: Record<string, unknown> = {}): string =>
    `${JSON.stringify({ at: at.toISOString(), run: 'r', issue: 'o/r#1', role: 'developer', op: 'read', path_or_query: 'Inbox/a.md', purpose: '', result: 'ok', ...over })}\n`;

  it('removes lines older than 30 days and keeps newer ones unchanged', () => {
    const dir = path.join(tempDir(), 'brain');
    fs.mkdirSync(dir, { recursive: true });
    const old1 = line(new Date(T0.getTime() - 31 * DAY));
    const old2 = line(new Date(T0.getTime() - 45 * DAY), { op: 'write' });
    const keep1 = line(new Date(T0.getTime() - 29 * DAY));
    const keep2 = line(new Date(T0.getTime() - 1 * DAY), { op: 'search', path_or_query: 'q' });
    fs.writeFileSync(path.join(dir, 'access.jsonl'), old1 + keep1 + old2 + keep2);
    new BrainAccessLog(dir, Logger.silent()).load(T0);
    assert.equal(fs.readFileSync(path.join(dir, 'access.jsonl'), 'utf8'), keep1 + keep2);
  });

  it('does not fail without a file, and appends still work afterwards', async () => {
    const dir = path.join(tempDir(), 'brain');
    const log = new BrainAccessLog(dir, Logger.silent());
    assert.doesNotThrow(() => log.load(T0));
    const e = env({ log, logDir: dir });
    await e.session('runA').brain_list!({ purpose: 'p' });
    assert.equal(rows(dir).length, 1);
  });

  it('keeps writes of the last 30 days effective for the window after a restart', async () => {
    const e = env();
    const first = data(await e.session('runA').brain_write!({ path: 'Inbox/n.md', content: NOTE('v1') }));
    const restarted = new BrainAccessLog(e.logDir, Logger.silent());
    restarted.load(new Date(T0.getTime() + 2 * MIN));
    const e2 = env({ log: restarted, logDir: e.logDir, vault: e.vault });
    e2.clock.now = new Date(T0.getTime() + 2 * MIN);
    assert.equal(rejection(await e2.session('runB').brain_write!({ path: 'Inbox/n.md', content: NOTE('v2'), base_hash: first.hash })).details.reason, 'window');
  });
});

describe('E7-4 robustness', () => {
  it('works without a log directory (in memory) and never throws', async () => {
    const log = new BrainAccessLog(null, Logger.silent());
    const e = env({ log });
    const first = data(await e.session('runA').brain_write!({ path: 'Inbox/n.md', content: NOTE('v1') }));
    assert.equal(rejection(await e.session('runB').brain_write!({ path: 'Inbox/n.md', content: NOTE('v2'), base_hash: first.hash })).details.reason, 'window');
    assert.doesNotThrow(() => log.load(T0));
  });

  it('a log that cannot be written never breaks the tools', async () => {
    const blocker = path.join(tempDir(), 'blocker');
    fs.writeFileSync(blocker, 'a file where the log directory should be');
    const log = new BrainAccessLog(path.join(blocker, 'brain'), Logger.silent());
    const e = env({ log });
    const s = e.session('runA');
    const first = data(await s.brain_write!({ path: 'Inbox/n.md', content: NOTE('v1') }));
    data(await s.brain_read!({ path: 'Inbox/n.md' }));
    data(await s.brain_write!({ path: 'Inbox/n.md', content: NOTE('v2'), base_hash: first.hash }));
  });

  it('without a run id a write is still logged (run null)', async () => {
    const e = env();
    data(await e.session(null).brain_write!({ path: 'Inbox/n.md', content: NOTE('v1') }));
    assert.equal(rows(e.logDir)[0].run, null);
  });

  it('keeps the tools off when the brain is disabled', () => {
    assert.deepEqual(brainToolsFor({ enabled: false, path: tempDir() }, Logger.silent(), { access: new BrainAccessLog(null, Logger.silent()) }), []);
  });
});

describe('E7-4 configuration brain.clash_window_ms', () => {
  const base = { tracker: { kind: 'github-project' } };
  it('defaults to 600000 and accepts non-negative integers only', () => {
    assert.equal(makeWorkflow(base).config.brain.clashWindowMs, 600_000);
    assert.equal(makeWorkflow({ ...base, brain: { clash_window_ms: 120_000 } }).config.brain.clashWindowMs, 120_000);
    assert.equal(makeWorkflow({ ...base, brain: { clash_window_ms: 0 } }).config.brain.clashWindowMs, 0);
    assert.throws(() => makeWorkflow({ ...base, brain: { clash_window_ms: -5 } }), /clash_window_ms/);
    assert.throws(() => makeWorkflow({ ...base, brain: { clash_window_ms: 1.5 } }), /clash_window_ms/);
    assert.throws(() => makeWorkflow({ ...base, brain: { clash_window_ms: 'soon' } }), /clash_window_ms/);
  });

  it('is described in docs/configuration.md with its default', () => {
    const doc = fs.readFileSync(path.join(import.meta.dirname, '..', 'docs', 'configuration.md'), 'utf8');
    const row = doc.split('\n').find((l) => l.includes('`clash_window_ms`'));
    assert.ok(row, 'docs/configuration.md must describe clash_window_ms');
    assert.match(row!, /600000/);
  });
});
