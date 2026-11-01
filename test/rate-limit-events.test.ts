import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { RATE_LIMIT_RETENTION_DAYS, RateLimitLog, type RateLimitRecord } from '../src/budget/rate-limit-log.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, baseFront, makeIssue, makeWorkflow, tempDir, until } from './helpers.ts';

const DAY = 24 * 60 * 60 * 1000;

function rec(at: Date, extra: Partial<RateLimitRecord> = {}): RateLimitRecord {
  return { at: at.toISOString(), run_id: 'run', issue: 'acme/app#1', role: 'default', model: null, rate_limit_info: { rateLimitType: 'five_hour' }, ...extra };
}

function memoryLogger(lines: string[]): Logger {
  return Logger.create({ sinks: [{ name: 'memory', write: (line: string) => lines.push(line) }], level: 'debug' } as never);
}

describe('rate-limit log (independent checks)', () => {
  it('retention is a 30 day constant', () => {
    assert.equal(RATE_LIMIT_RETENTION_DAYS, 30);
  });

  it('creates the missing directory on the first append and keeps write order', () => {
    const dir = path.join(tempDir(), 'nested', 'budget');
    const log = new RateLimitLog(dir, Logger.silent());
    const base = new Date('2026-10-30T08:00:00Z');
    const records = [3, 1, 2].map((n) => rec(new Date(base.getTime() + n * 60_000), { run_id: `r${n}` }));
    for (const r of records) log.append(r);
    assert.ok(fs.existsSync(path.join(dir, 'rate-limits.jsonl')));
    assert.deepEqual(log.readRateLimitEvents().map((r) => r.run_id), ['r3', 'r1', 'r2']);
  });

  it('stores every SDK field of rate_limit_info unchanged, including odd values', () => {
    const log = new RateLimitLog(path.join(tempDir(), 'budget'), Logger.silent());
    const info = { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1791221400, isUsingOverage: false, overageStatus: null, list: [1, 'a', { b: null }], 'weird key': 'ä"\n' };
    log.append(rec(new Date('2026-10-30T08:00:00Z'), { rate_limit_info: info, model: 'claude-opus' }));
    const [read] = log.readRateLimitEvents();
    assert.deepEqual(read!.rate_limit_info, info);
    assert.equal(read!.model, 'claude-opus');
    const raw = fs.readFileSync(log.file!, 'utf8');
    assert.equal(raw.trim().split('\n').length, 1, 'one JSON line, newlines in values are escaped');
  });

  it('since is inclusive and returns events in write order', () => {
    const log = new RateLimitLog(path.join(tempDir(), 'budget'), Logger.silent());
    const t = (h: number) => new Date(Date.UTC(2026, 9, 30, h));
    log.append(rec(t(9), { run_id: 'a' }));
    log.append(rec(t(10), { run_id: 'b' }));
    log.append(rec(t(11), { run_id: 'c' }));
    assert.deepEqual(log.readRateLimitEvents(t(10)).map((r) => r.run_id), ['b', 'c']);
    assert.deepEqual(log.readRateLimitEvents(t(12)), []);
  });

  it('prune keeps the 30 day boundary side correctly and leaves no tmp file', () => {
    const log = new RateLimitLog(path.join(tempDir(), 'budget'), Logger.silent());
    const now = new Date('2026-10-30T12:00:00Z');
    log.append(rec(new Date(now.getTime() - 31 * DAY), { run_id: 'old' }));
    log.append(rec(new Date(now.getTime() - 29 * DAY), { run_id: 'young' }));
    log.append(rec(now, { run_id: 'new' }));
    log.prune(now);
    assert.deepEqual(log.readRateLimitEvents().map((r) => r.run_id), ['young', 'new']);
    assert.deepEqual(fs.readdirSync(path.dirname(log.file!)), ['rate-limits.jsonl']);
  });

  it('prune of a file with only old lines leaves an empty log that can be appended to again', () => {
    const log = new RateLimitLog(path.join(tempDir(), 'budget'), Logger.silent());
    const now = new Date('2026-10-30T12:00:00Z');
    log.append(rec(new Date(now.getTime() - 40 * DAY)));
    assert.equal(log.prune(now), 1);
    assert.deepEqual(log.readRateLimitEvents(), []);
    log.append(rec(now, { run_id: 'again' }));
    assert.deepEqual(log.readRateLimitEvents().map((r) => r.run_id), ['again']);
  });

  it('a prune failure is logged and does not throw', () => {
    const dir = tempDir();
    const log = new RateLimitLog(path.join(dir, 'budget'), Logger.silent());
    fs.mkdirSync(log.file!, { recursive: true }); // the log file is a directory: reading fails with EISDIR
    const lines: string[] = [];
    const broken = new RateLimitLog(path.join(dir, 'budget'), memoryLogger(lines));
    assert.doesNotThrow(() => broken.prune(new Date()));
    assert.doesNotThrow(() => broken.pruneIfDue(new Date()));
    assert.doesNotThrow(() => broken.readRateLimitEvents());
    assert.ok(lines.some((l) => l.includes('prune')), 'the failure is logged');
  });
});

describe('orchestrator rate limits (independent checks)', () => {
  function build(options: { logDir: string | null; runner?: FakeRunner; issues?: ReturnType<typeof makeIssue>[] }) {
    const root = tempDir();
    const tracker = new FakeTracker(options.issues ?? []);
    const timers = new ManualTimers();
    const clock = new ManualClock();
    const workflow = new StaticWorkflow(makeWorkflow(baseFront(root)));
    const orchestrator = new Orchestrator({
      workflow,
      runner: options.runner ?? new FakeRunner(),
      logger: Logger.silent(),
      env: {},
      logDir: options.logDir,
      clock,
      timers,
      createAdapter: () => tracker,
    });
    return { orchestrator, clock, timers, tracker };
  }

  const emitter = (infos: unknown[]) =>
    new FakeRunner((turn, params) => {
      for (const info of infos) {
        (params.onEvent as (event: unknown) => void)({ event: 'rate_limit', timestamp: new Date(), pid: 1, threadId: 't', turnId: '1', sessionId: 't-1', turnCount: turn, rateLimits: info });
      }
      return new Promise(() => undefined);
    });

  it('starts with an empty object and no log file', () => {
    const logDir = tempDir();
    const s = build({ logDir });
    assert.deepEqual(s.orchestrator.snapshot().rate_limits, {});
    assert.equal(fs.existsSync(path.join(logDir, 'budget', 'rate-limits.jsonl')), false);
  });

  it('logs raw info with issue, run id and role; unknown type lands under a fallback key', async () => {
    const logDir = tempDir();
    const raw = { status: 'allowed', resetsAt: 1791221400, extra: { a: 1 } }; // no rateLimitType
    const typed = { rateLimitType: 'five_hour', status: 'allowed_warning', utilization: 0.9, surpassedThreshold: 0.8 };
    const s = build({ logDir, runner: emitter([raw, typed]), issues: [makeIssue({ id: 'a' })] });
    await s.orchestrator.tickNow();
    await until(() => Object.keys(s.orchestrator.snapshot().rate_limits as object).length === 2, 3_000, 'rate limits');
    const limits = s.orchestrator.snapshot().rate_limits as Record<string, RateLimitRecord>;
    assert.deepEqual(limits.five_hour!.rate_limit_info, typed);
    const other = Object.keys(limits).find((k) => k !== 'five_hour')!;
    assert.deepEqual(limits[other]!.rate_limit_info, raw);

    const lines = fs.readFileSync(path.join(logDir, 'budget', 'rate-limits.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as RateLimitRecord);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((l) => l.rate_limit_info), [raw, typed]);
    for (const line of lines) {
      assert.equal(line.issue, makeIssue({ id: 'a' }).identifier);
      assert.ok(line.run_id.length > 0);
      assert.ok(line.role.length > 0);
      assert.ok(!Number.isNaN(Date.parse(line.at)));
      assert.equal(line.at, new Date(line.at).toISOString());
    }
    assert.equal(lines[0]!.run_id, lines[1]!.run_id);
    assert.deepEqual(limits.five_hour, lines[1]);
    await s.orchestrator.shutdown(1_000);
  });

  it('keeps the in-memory map when there is no log directory', async () => {
    const s = build({ logDir: null, runner: emitter([{ rateLimitType: 'seven_day', status: 'allowed' }]), issues: [makeIssue({ id: 'a' })] });
    await s.orchestrator.tickNow();
    await until(() => 'seven_day' in (s.orchestrator.snapshot().rate_limits as object), 3_000, 'seven_day');
    await s.orchestrator.shutdown(1_000);
  });

  it('an unwritable log directory does not break the session or the state', async () => {
    const logDir = tempDir();
    fs.writeFileSync(path.join(logDir, 'budget'), 'a file where the directory should be');
    const s = build({ logDir, runner: emitter([{ rateLimitType: 'five_hour', status: 'allowed' }, { rateLimitType: 'five_hour', status: 'allowed_warning' }]), issues: [makeIssue({ id: 'a' })] });
    await s.orchestrator.tickNow();
    await until(() => {
      const l = s.orchestrator.snapshot().rate_limits as Record<string, RateLimitRecord>;
      return (l.five_hour?.rate_limit_info as { status?: string } | undefined)?.status === 'allowed_warning';
    }, 3_000, 'both events processed');
    assert.equal(s.orchestrator.snapshot().running.length, 1);
    await s.orchestrator.shutdown(1_000);
  });

  it('start() removes lines older than 30 days', async () => {
    const logDir = tempDir();
    const s = build({ logDir });
    const now = s.clock.now();
    const file = path.join(logDir, 'budget', 'rate-limits.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = JSON.stringify(rec(new Date(now.getTime() - 31 * DAY), { run_id: 'old' }));
    const young = JSON.stringify(rec(new Date(now.getTime() - 29 * DAY), { run_id: 'young' }));
    fs.writeFileSync(file, `${old}\n${young}\n`);
    await s.orchestrator.start();
    assert.equal(fs.readFileSync(file, 'utf8'), `${young}\n`);
    await s.orchestrator.shutdown(1_000);
  });

  it('a tick after more than a day rotates the log again', async () => {
    const logDir = tempDir();
    const s = build({ logDir });
    const file = path.join(logDir, 'budget', 'rate-limits.jsonl');
    await s.orchestrator.start();
    const now = s.clock.now();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(rec(new Date(now.getTime() - 20 * DAY), { run_id: 'aging' }))}\n`);
    s.clock.advance(5 * 60_000);
    await s.orchestrator.tickNow();
    assert.match(fs.readFileSync(file, 'utf8'), /aging/, 'not rotated within the day');
    s.clock.advance(11 * DAY + 1_000); // the line is now older than 30 days and the last rotation is over a day old
    await s.orchestrator.tickNow();
    assert.equal(fs.readFileSync(file, 'utf8'), '');
    await s.orchestrator.shutdown(1_000);
  });
});
