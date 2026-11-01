import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { RATE_LIMIT_PRUNE_INTERVAL_MS, RateLimitLog, rateLimitKey, resetTimeMs, windowUtilization, type RateLimitRecord } from '../src/budget/rate-limit-log.ts';
import { Logger } from '../src/log.ts';
import { tempDir } from './helpers.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-30T12:00:00.000Z');

function record(at: Date, info: unknown = { rateLimitType: 'five_hour', status: 'allowed' }): RateLimitRecord {
  return { at: at.toISOString(), run_id: 'r1', issue: 'acme/app#1', role: 'default', model: 'opus', rate_limit_info: info };
}

function memoryLogger(lines: string[]): Logger {
  return Logger.create({ sinks: [{ name: 'memory', write: (line: string) => lines.push(line) }], level: 'debug' } as never);
}

describe('RateLimitLog', () => {
  it('appends events as JSON lines with the raw rate_limit_info and reads them back', () => {
    const log = new RateLimitLog(path.join(tempDir(), 'budget'), Logger.silent());
    const raw = { status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: 1791221400, utilization: 0.81, extra: { nested: true } };
    const first = record(new Date('2026-10-30T10:00:00Z'), raw);
    const second = record(new Date('2026-10-30T12:00:00Z'), { rateLimitType: 'seven_day', status: 'allowed' });
    log.append(first);
    log.append(second);
    assert.deepEqual(log.readRateLimitEvents(), [first, second]);
    const lines = fs.readFileSync(log.file!, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual((JSON.parse(lines[0]!) as RateLimitRecord).rate_limit_info, raw);
    assert.deepEqual(Object.keys(JSON.parse(lines[0]!)), ['at', 'run_id', 'issue', 'role', 'model', 'rate_limit_info']);
  });

  it('filters by since, skips broken lines and tolerates a missing file or no directory', () => {
    const log = new RateLimitLog(path.join(tempDir(), 'budget'), Logger.silent());
    assert.deepEqual(log.readRateLimitEvents(), []);
    log.append(record(new Date('2026-10-30T10:00:00Z')));
    fs.appendFileSync(log.file!, 'kaputt\n');
    const later = record(new Date('2026-10-30T12:00:00Z'));
    log.append(later);
    assert.deepEqual(log.readRateLimitEvents(new Date('2026-10-30T11:00:00Z')), [later]);
    assert.equal(log.readRateLimitEvents().length, 2);

    const off = new RateLimitLog(null, Logger.silent());
    off.append(later);
    assert.equal(off.file, null);
    assert.deepEqual(off.readRateLimitEvents(), []);
  });

  it('prunes lines older than 30 days byte-exactly and drops unreadable lines', () => {
    const log = new RateLimitLog(path.join(tempDir(), 'budget'), Logger.silent());
    fs.mkdirSync(path.dirname(log.file!), { recursive: true });
    const keep = JSON.stringify(record(new Date(NOW.getTime() - 29 * DAY)));
    fs.writeFileSync(log.file!, `${JSON.stringify(record(new Date(NOW.getTime() - 31 * DAY)))}\n${keep}\nkaputt\n`);
    assert.equal(log.prune(NOW), 2);
    assert.equal(fs.readFileSync(log.file!, 'utf8'), `${keep}\n`);
    assert.equal(log.prune(NOW), 0);
    assert.equal(new RateLimitLog(path.join(tempDir(), 'none'), Logger.silent()).prune(NOW), 0);
  });

  it('pruneIfDue rotates at most once a day', () => {
    const log = new RateLimitLog(path.join(tempDir(), 'budget'), Logger.silent());
    log.pruneIfDue(NOW);
    log.append(record(new Date(NOW.getTime() - 31 * DAY)));
    log.pruneIfDue(new Date(NOW.getTime() + 3_600_000));
    assert.equal(log.readRateLimitEvents().length, 1);
    log.pruneIfDue(new Date(NOW.getTime() + RATE_LIMIT_PRUNE_INTERVAL_MS));
    assert.equal(log.readRateLimitEvents().length, 0);
  });

  it('logs a write failure once and does not throw', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'budget'), 'a file, not a directory');
    const lines: string[] = [];
    const log = new RateLimitLog(path.join(dir, 'budget'), memoryLogger(lines));
    log.append(record(NOW));
    log.append(record(NOW));
    assert.equal(lines.filter((line) => line.includes('cannot write the rate-limit log')).length, 1);
    assert.doesNotThrow(() => log.prune(NOW));
  });

  it('keys events by rateLimitType with a fallback', () => {
    assert.equal(rateLimitKey({ rateLimitType: 'seven_day' }), 'seven_day');
    assert.equal(rateLimitKey({ status: 'allowed' }), 'unknown');
    assert.equal(rateLimitKey(null), 'unknown');
  });
});

describe('windowUtilization', () => {
  const warning = { status: 'allowed_warning', resetsAt: 1793782800, rateLimitType: 'seven_day', utilization: 0.77, surpassedThreshold: 0.75, unifiedWindows: { five_hour: { utilization: 0, resetsAt: 1793497800 }, seven_day: { utilization: 0.77, resetsAt: 1793782800 } } };
  const rejected = { status: 'rejected', resetsAt: 1793537400, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1.01, resetsAt: 1793537400 }, seven_day: { utilization: 0.91, resetsAt: 1793782800 } } };
  const none = { utilization: null, resetsAt: null };

  it('reads the real payloads per window, values above 1 are kept', () => {
    assert.deepEqual(windowUtilization(warning, 'five_hour'), { utilization: 0, resetsAt: 1793497800000 });
    assert.equal(windowUtilization(warning, 'seven_day').utilization, 0.77);
    assert.equal(windowUtilization(rejected, 'five_hour').utilization, 1.01);
    assert.equal(windowUtilization(rejected, 'seven_day').utilization, 0.91);
  });

  it('uses the top level without unifiedWindows, only for the matching rateLimitType', () => {
    const info = { rateLimitType: 'five_hour', utilization: 0.5, resetsAt: 1793497800 };
    assert.deepEqual(windowUtilization(info, 'five_hour'), { utilization: 0.5, resetsAt: 1793497800000 });
    assert.deepEqual(windowUtilization(info, 'seven_day'), none);
    assert.deepEqual(windowUtilization({ ...info, unifiedWindows: 'text' }, 'five_hour').utilization, 0.5);
  });

  it('a rejected without utilisation counts as 1 for its own window only', () => {
    const info = { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1793537400 };
    assert.deepEqual(windowUtilization(info, 'five_hour'), { utilization: 1, resetsAt: 1793537400000 });
    assert.deepEqual(windowUtilization(info, 'seven_day'), none);
  });

  it('is defensive and never throws', () => {
    for (const info of [null, undefined, 'x', 3, []]) assert.deepEqual(windowUtilization(info, 'five_hour'), none);
    const base = { rateLimitType: 'seven_day' };
    assert.deepEqual(windowUtilization({ ...base, unifiedWindows: { five_hour: {} } }, 'five_hour'), none);
    for (const utilization of [Infinity, NaN, '0.5', -1, null]) assert.equal(windowUtilization({ ...base, unifiedWindows: { five_hour: { utilization, resetsAt: 1 } } }, 'five_hour').utilization, null);
    assert.equal(windowUtilization({ ...base, unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 'soon' } } }, 'five_hour').resetsAt, null);
    assert.equal(windowUtilization({ ...base, unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1793497800000 } } }, 'five_hour').resetsAt, 1793497800000);
  });

  it('resetTimeMs tells seconds, milliseconds and ISO strings apart', () => {
    assert.equal(resetTimeMs(1793497800), 1793497800000);
    assert.equal(resetTimeMs(1793497800000), 1793497800000);
    assert.equal(resetTimeMs('2026-10-30T12:00:00Z'), Date.parse('2026-10-30T12:00:00Z'));
    assert.equal(resetTimeMs(''), null);
    assert.equal(resetTimeMs(NaN), null);
  });
});
