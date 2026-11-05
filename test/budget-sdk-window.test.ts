import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { budgetAlerts, budgetReport, forecastBudget, type BudgetUsage } from '../src/budget/forecast.ts';
import { windowUtilization, type RateLimitRecord } from '../src/budget/rate-limit-log.ts';

// Independent acceptance tests for E4-7 (#464): SDK utilisation per window from `unifiedWindows`.
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = new Date('2026-11-01T12:00:00Z');
const nowSec = Math.floor(now.getTime() / 1000);
const at = (ms: number) => new Date(now.getTime() - ms).toISOString();
const sec = (offsetMs: number) => nowSec + Math.floor(offsetMs / 1000);
const rec = (ms: number, info: Record<string, unknown>): RateLimitRecord => ({ at: at(ms), run_id: 'r', issue: 'acme/app#1', role: 'developer', model: null, rate_limit_info: info });
const use = (ms: number, tokens: number, role?: string): BudgetUsage => ({ at: new Date(now.getTime() - ms), tokens, role });
const calc = (events: RateLimitRecord[], usage: BudgetUsage[] = [], window: 'five_hour' | 'seven_day' = 'five_hour') => forecastBudget({ now, usage, events, window });

// Shapes of the real payloads from the issue, with the resets moved relative to `now`.
const warning = (fiveUtil: number, sevenUtil = 0.77) => ({
  status: 'allowed_warning', resetsAt: sec(3 * DAY), rateLimitType: 'seven_day', utilization: sevenUtil, surpassedThreshold: 0.75,
  unifiedWindows: { five_hour: { utilization: fiveUtil, resetsAt: sec(2 * HOUR) }, seven_day: { utilization: sevenUtil, resetsAt: sec(3 * DAY) } },
});
const rejected = (resetsAt: number) => ({
  status: 'rejected', resetsAt, rateLimitType: 'five_hour', overageStatus: 'rejected',
  unifiedWindows: {
    five_hour: { utilization: 1.01, resetsAt }, seven_day: { utilization: 0.91, resetsAt: sec(3 * DAY) },
    seven_day_overage_included: { utilization: 0.7, resetsAt: sec(3 * DAY) },
  },
});

describe('windowUtilization helper', () => {
  it('reads unifiedWindows of a window other than rateLimitType, keeps values above 1', () => {
    const info = rejected(1793537400);
    assert.deepEqual(windowUtilization(info, 'five_hour'), { utilization: 1.01, resetsAt: 1793537400 * 1000 });
    assert.equal(windowUtilization(info, 'seven_day').utilization, 0.91);
    assert.equal(windowUtilization(info, 'seven_day').resetsAt, sec(3 * DAY) * 1000);
  });

  it('does not throw for any garbage and returns null fields', () => {
    const garbage: unknown[] = [null, undefined, 1, 'a', true, [], {}, { unifiedWindows: 'x' }, { unifiedWindows: [] }, { unifiedWindows: { five_hour: null } }, { unifiedWindows: { five_hour: { utilization: NaN, resetsAt: Infinity } } }];
    for (const info of garbage) {
      const result = windowUtilization(info, 'five_hour');
      assert.equal(result.utilization, null, JSON.stringify(info));
      assert.equal(result.resetsAt, null, JSON.stringify(info));
    }
  });

  it('top level is used only when rateLimitType matches and unifiedWindows is missing', () => {
    assert.equal(windowUtilization({ rateLimitType: 'five_hour', utilization: 0.3, resetsAt: 1793497800 }, 'five_hour').utilization, 0.3);
    assert.equal(windowUtilization({ rateLimitType: 'seven_day', utilization: 0.3, resetsAt: 1793497800 }, 'five_hour').utilization, null);
    assert.equal(windowUtilization({ utilization: 0.3, resetsAt: 1793497800 }, 'five_hour').utilization, null);
  });

  it('distinguishes seconds from milliseconds', () => {
    const base = { rateLimitType: 'seven_day' };
    assert.equal(windowUtilization({ ...base, unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1793497800 } } }, 'five_hour').resetsAt, 1793497800000);
    assert.equal(windowUtilization({ ...base, unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1793497800000 } } }, 'five_hour').resetsAt, 1793497800000);
  });
});

describe('forecastBudget: SDK utilisation (acceptance)', () => {
  it('a seven_day event with unifiedWindows.five_hour 0.72 gives five_hour 72 % from the SDK', () => {
    const ev = rec(5 * MIN, warning(0.72));
    const result = calc([ev]);
    assert.equal(result.percent, 72);
    assert.equal(result.percent_source, 'sdk');
    assert.equal(result.sdk?.event_at, ev.at);
    assert.equal(result.sdk?.utilization, 0.72);
    assert.equal(result.sdk?.status, 'allowed_warning');
    assert.equal(result.sdk?.resets_at, new Date(sec(2 * HOUR) * 1000).toISOString());
    assert.equal(result.resets_at, result.sdk?.resets_at);
    assert.equal(calc([ev], [], 'seven_day').percent, 77);
  });

  it('the newest event wins regardless of type and array order', () => {
    const older = rec(3 * HOUR, { rateLimitType: 'five_hour', status: 'allowed_warning', utilization: 0.9, resetsAt: sec(2 * HOUR) });
    const newer = rec(MIN, warning(0.3));
    assert.equal(calc([older, newer]).percent, 30);
    assert.equal(calc([newer, older]).percent, 30);
  });

  it('a newer event without data for the window does not hide an older one', () => {
    const older = rec(HOUR, warning(0.4));
    const newer = rec(MIN, { rateLimitType: 'seven_day', status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.8, resetsAt: sec(3 * DAY) } } });
    assert.equal(calc([older, newer]).percent, 40);
    assert.equal(calc([older, newer], [], 'seven_day').percent, 80);
  });

  it('rejected five_hour with 1.01 gives at least 100 % until its reset', () => {
    const result = calc([rec(MIN, rejected(sec(HOUR)))]);
    assert.ok(result.percent !== null && result.percent >= 100);
    assert.equal(result.percent, 101);
    assert.equal(result.percent_source, 'sdk');
    assert.equal(result.sdk?.status, 'rejected');
  });

  it('rejected without any utilisation gives 100 % for its window only', () => {
    const ev = rec(MIN, { status: 'rejected', rateLimitType: 'five_hour', resetsAt: sec(HOUR) });
    const five = calc([ev]);
    assert.equal(five.percent, 100);
    assert.equal(five.percent_source, 'sdk');
    const seven = calc([ev], [], 'seven_day');
    assert.equal(seven.sdk, null);
    assert.notEqual(seven.percent_source, 'sdk');
  });

  it('a rejected stays at 100 % during a pause even when tokens leave the rolling window', () => {
    const ev = rec(HOUR, { status: 'rejected', rateLimitType: 'five_hour', resetsAt: sec(HOUR) });
    const result = calc([ev], [use(5 * HOUR + 30 * MIN, 1000)]);
    assert.equal(result.used_tokens, 0);
    assert.equal(result.percent, 100);
    assert.equal(result.percent_source, 'sdk');
  });

  it('after the reset the event value is unknown, neither the old value nor 0', () => {
    const ev = rec(2 * HOUR, rejected(sec(-MIN)));
    const result = calc([ev], [use(3 * HOUR, 500)]);
    assert.equal(result.sdk, null);
    assert.equal(result.resets_at, null);
    assert.notEqual(result.percent_source, 'sdk');
    assert.notEqual(result.percent, 101);
    assert.notEqual(result.percent, 0);
    // The token limit derived from this event is not used any more.
    assert.notEqual(result.forecast?.limit_source, 'sdk');
  });

  it('after the reset a seven_day event for five_hour is unknown as well', () => {
    const ev = rec(3 * HOUR, { ...warning(0.72), unifiedWindows: { five_hour: { utilization: 0.72, resetsAt: sec(-MIN) }, seven_day: { utilization: 0.77, resetsAt: sec(3 * DAY) } } });
    const result = calc([ev]);
    assert.equal(result.sdk, null);
    assert.equal(result.percent, null);
    assert.equal(result.percent_source, 'none');
    assert.equal(calc([ev], [], 'seven_day').percent, 77);
  });

  it('survives garbage in unifiedWindows and falls back to calibration', () => {
    const hit = rec(4 * HOUR, { rateLimitType: 'five_hour', status: 'rejected' });
    const usage = [use(5 * HOUR + MIN, 1000), use(10 * MIN, 600)];
    const garbage: unknown[] = [undefined, 'oops', { five_hour: { resetsAt: sec(HOUR) } }, { five_hour: { utilization: 0.5, resetsAt: 'tomorrow' } }, { five_hour: 7 }];
    for (const unifiedWindows of garbage) {
      const result = calc([hit, rec(MIN, { rateLimitType: 'seven_day', status: 'allowed', unifiedWindows })], usage);
      assert.equal(result.sdk, null, JSON.stringify(unifiedWindows));
      assert.equal(result.percent_source, 'calibrated', JSON.stringify(unifiedWindows));
      assert.equal(result.forecast?.limit_source, 'calibrated');
      assert.equal(result.forecast?.limit_tokens, 1000);
      assert.equal(result.percent, 60);
    }
  });

  it('without SDK data and without a hit: percent null, source none', () => {
    const result = calc([rec(MIN, { rateLimitType: 'five_hour', status: 'allowed' })], [use(HOUR, 10)]);
    assert.equal(result.sdk, null);
    assert.equal(result.percent, null);
    assert.equal(result.percent_source, 'none');
    assert.equal(result.forecast, null);
    assert.deepEqual(calc([]).sdk, null);
  });

  it('the SDK limit is tokens in the window at the event time / utilisation', () => {
    const ev = rec(HOUR, warning(0.5));
    // 400 tokens within 5 h before the event; 100 more afterwards; 50 too old to count at the event.
    const usage = [use(7 * HOUR, 50), use(2 * HOUR, 400), use(10 * MIN, 100)];
    const result = calc([ev], usage);
    assert.equal(result.forecast?.limit_tokens, 800);
    assert.equal(result.forecast?.limit_source, 'sdk');
    assert.equal(result.used_tokens, 500);
  });

  it('a limit above 100 % still yields a limit and a percent above 100', () => {
    const result = calc([rec(MIN, { ...rejected(sec(HOUR)) })], [use(HOUR, 505)]);
    assert.equal(result.percent, 101);
    assert.equal(result.forecast?.limit_source, 'sdk');
    assert.equal(result.forecast?.limit_tokens, 500);
  });

  it('calibrated percent is used / limit', () => {
    const result = calc([rec(4 * HOUR, { rateLimitType: 'five_hour', status: 'rejected' })], [use(5 * HOUR + MIN, 1000), use(10 * MIN, 500)]);
    assert.equal(result.percent_source, 'calibrated');
    assert.equal(result.percent, 50);
  });

  it('keeps used_tokens, burn rate, by_role and alert in shape and meaning', () => {
    const ev = rec(MIN, warning(0.72));
    const result = calc([ev], [use(2 * HOUR, 300, 'developer'), use(10 * MIN, 90, 'tester'), use(20 * MIN, 30)]);
    assert.equal(result.window, 'five_hour');
    assert.equal(result.used_tokens, 420);
    assert.equal(result.burn_rate_per_min, 4);
    assert.deepEqual(result.by_role, { developer: 300, tester: 90, default: 30 });
    assert.equal(typeof result.alert, 'boolean');
    assert.ok('forecast' in result && 'resets_at' in result);
  });

  it('budgetReport and budgetAlerts carry the new fields for both windows', () => {
    const report = budgetReport({ now, usage: [], events: [rec(MIN, warning(0.72))] });
    assert.equal(report.five_hour.percent, 72);
    assert.equal(report.seven_day.percent, 77);
    assert.equal(report.seven_day.percent_source, 'sdk');
    assert.deepEqual(budgetAlerts(report), []);
    const json = JSON.parse(JSON.stringify(report));
    assert.equal(json.five_hour.sdk.event_at, report.five_hour.sdk?.event_at);
  });
});
