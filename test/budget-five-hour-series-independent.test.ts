import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { forecastBudget, type BudgetUsage } from '../src/budget/forecast.ts';
import { fiveHourSeries, isFiveHourRange, FIVE_HOUR_RANGES, type FiveHourRange } from '../src/budget/five-hour-series.ts';
import type { RateLimitRecord } from '../src/budget/rate-limit-log.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = new Date('2026-10-30T12:00:00Z');
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);
const iso = (offsetMs: number) => at(offsetMs).toISOString();
const secs = (offsetMs: number) => Math.floor(at(offsetMs).getTime() / 1000);

/** Event at `now + offset` (negative = past); `info` is merged over `rateLimitType: five_hour`. */
const event = (offset: number, info: Record<string, unknown>): RateLimitRecord => ({
  at: iso(offset), run_id: 'r', issue: 'acme/app#1', role: 'developer', model: null,
  rate_limit_info: { rateLimitType: 'five_hour', ...info },
});
/** SDK event with a utilisation share and a reset (offset relative to now). */
const sdk = (offset: number, utilization: number, resetOffset?: number, extra: Record<string, unknown> = {}) =>
  event(offset, {
    status: 'allowed',
    unifiedWindows: { five_hour: { utilization, ...(resetOffset === undefined ? {} : { resetsAt: secs(resetOffset) }) } },
    ...extra,
  });
/** Rejected five_hour event without any utilisation; the reset is a top-level `resetsAt`. */
const rejected = (offset: number, resetOffset?: number) =>
  event(offset, { status: 'rejected', ...(resetOffset === undefined ? {} : { resetsAt: secs(resetOffset) }) });
const use = (offset: number, tokens: number): BudgetUsage => ({ at: at(offset), tokens });

const series = (events: RateLimitRecord[], range: FiveHourRange, usage: BudgetUsage[] = []) => fiveHourSeries({ now, usage, events, range });
const percents = (window: { points: { percent: number }[] }) => window.points.map((p) => p.percent);

describe('FiveHourRange', () => {
  it('lists the three ranges and guards values', () => {
    assert.deepEqual([...FIVE_HOUR_RANGES].sort(), ['day', 'week', 'window']);
    for (const value of ['window', 'day', 'week']) assert.equal(isFiveHourRange(value), true);
    for (const value of ['hour', '', 'Day', null, undefined, 5, {}]) assert.equal(isFiveHourRange(value), false);
  });
});

describe('fiveHourSeries: empty and ranges', () => {
  it('without events there are no windows, no source, no forecast and a zero summary', () => {
    for (const range of ['window', 'day', 'week'] as const) {
      const result = series([], range);
      assert.equal(result.range, range);
      assert.equal(result.now, now.toISOString());
      assert.deepEqual(result.windows, []);
      assert.equal(result.percent_source, 'none');
      assert.equal(result.forecast, null);
      assert.deepEqual(result.summary, { windows: 0, over_limit: 0, paused_min: 0 });
    }
  });

  it('the bounds of day and week are now minus 24 h / 7 d until now', () => {
    const day = series([], 'day');
    assert.equal(day.from, iso(-DAY));
    assert.equal(day.to, iso(0));
    const week = series([], 'week');
    assert.equal(week.from, iso(-7 * DAY));
    assert.equal(week.to, iso(0));
  });

  it('the window range without a known reset covers now minus 5 h until now', () => {
    const result = series([sdk(-HOUR, 0.4, -30 * MIN)], 'window');
    assert.equal(result.from, iso(-5 * HOUR));
    assert.equal(result.to, iso(0));
  });

  it('the window range runs from reset minus 5 h to the reset and keeps only events inside', () => {
    const events = [sdk(-4 * HOUR, 0.9, 2 * HOUR), sdk(-2 * HOUR, 0.3, 2 * HOUR), sdk(-30 * MIN, 0.4, 2 * HOUR)];
    const result = series(events, 'window');
    assert.equal(result.from, iso(-3 * HOUR));
    assert.equal(result.to, iso(2 * HOUR));
    assert.equal(result.windows.length, 1);
    assert.deepEqual(percents(result.windows[0]!), [30, 40]);
  });

  it('events outside the range (too old, in the future) are ignored', () => {
    const events = [sdk(-25 * HOUR, 0.9, -20 * HOUR), sdk(-10 * HOUR, 0.2, -8 * HOUR), sdk(HOUR, 0.8, 3 * HOUR)];
    const day = series(events, 'day');
    assert.equal(day.windows.length, 1);
    assert.deepEqual(percents(day.windows[0]!), [20]);
    const week = series([sdk(-8 * DAY, 0.9, -8 * DAY + HOUR), sdk(-6 * DAY, 0.5, -6 * DAY + HOUR)], 'week');
    assert.deepEqual(week.windows.map(percents), [[50]]);
    assert.equal(week.windows[0]!.points[0]!.at, iso(-6 * DAY));
  });

  it('events of other limit types give no point', () => {
    const other = event(-HOUR, { rateLimitType: 'seven_day', status: 'allowed', utilization: 0.7, resetsAt: secs(2 * HOUR) });
    assert.deepEqual(series([other], 'day').windows, []);
  });

  it('a seven_day event with a five_hour entry in unifiedWindows counts, but is not rejected', () => {
    const mixed = event(-HOUR, { rateLimitType: 'seven_day', status: 'rejected', unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: secs(HOUR) } } });
    const result = series([mixed], 'day');
    assert.equal(result.windows.length, 1);
    assert.equal(result.windows[0]!.points[0]!.percent, 50);
    assert.equal(result.windows[0]!.points[0]!.rejected, false);
    assert.equal(result.windows[0]!.over_limit, false);
  });
});

describe('fiveHourSeries: SDK points and windows', () => {
  it('sorts events by time and converts the share to percent with one decimal', () => {
    const result = series([sdk(-2 * HOUR, 0.4567, 3 * HOUR), sdk(-3 * HOUR, 0.1234, 3 * HOUR)], 'day');
    assert.equal(result.percent_source, 'sdk');
    assert.equal(result.windows.length, 1);
    const [first, second] = result.windows[0]!.points;
    assert.deepEqual(first, { at: iso(-3 * HOUR), percent: 12.3, rejected: false });
    assert.deepEqual(second, { at: iso(-2 * HOUR), percent: 45.7, rejected: false });
  });

  it('events without a utilisation are skipped', () => {
    const noValue = event(-2 * HOUR, { status: 'allowed', resetsAt: secs(HOUR) });
    const result = series([sdk(-3 * HOUR, 0.2, HOUR), noValue, sdk(-HOUR, 0.3, HOUR)], 'day');
    assert.deepEqual(result.windows.map(percents), [[20, 30]]);
  });

  it('a changed resetsAt starts a new window even when the percent rises; a falling percent without it starts one too', () => {
    const events = [
      sdk(-20 * HOUR, 0.3, -17 * HOUR),
      sdk(-18 * HOUR, 0.6, -17 * HOUR),
      sdk(-12 * HOUR, 0.7, -7 * HOUR), // reset change, percent rises
      sdk(-3 * HOUR, 0.9, 2 * HOUR), // reset change, percent rises
      sdk(-HOUR, 1.12, 2 * HOUR),
    ];
    const result = series(events, 'day');
    assert.equal(result.percent_source, 'sdk');
    assert.deepEqual(result.windows.map(percents), [[30, 60], [70], [90, 112]]);
    assert.deepEqual(result.windows.map((w) => w.resets_at), [iso(-17 * HOUR), iso(-7 * HOUR), iso(2 * HOUR)]);
    assert.deepEqual(result.windows.map((w) => w.start), [iso(-20 * HOUR), iso(-12 * HOUR), iso(-3 * HOUR)]);
    assert.deepEqual(result.windows.map((w) => w.current), [false, false, true]);
  });

  it('values above 100 stay (112 is 112) and make the window over the limit', () => {
    const result = series([sdk(-3 * HOUR, 0.9, 2 * HOUR), sdk(-HOUR, 1.12, 2 * HOUR)], 'day');
    const window = result.windows[0]!;
    assert.deepEqual(percents(window), [90, 112]);
    assert.deepEqual(window.peak, { at: iso(-HOUR), percent: 112, rejected: false });
    assert.equal(window.over_limit, true);
    assert.equal(window.over_limit_at, iso(-HOUR));
    assert.deepEqual(result.summary, { windows: 1, over_limit: 1, paused_min: 0 });
  });

  it('exactly 100 percent without a rejected event is not over the limit', () => {
    const window = series([sdk(-2 * HOUR, 0.8, 2 * HOUR), sdk(-HOUR, 1.0, 2 * HOUR)], 'day').windows[0]!;
    assert.equal(window.peak.percent, 100);
    assert.equal(window.over_limit, false);
    assert.equal(window.over_limit_at, null);
    assert.equal(window.pause, null);
  });

  it('the over-limit moment is the earliest point above 100, not the peak', () => {
    const events = [sdk(-4 * HOUR, 0.9, 2 * HOUR), sdk(-3 * HOUR, 1.05, 2 * HOUR), sdk(-2 * HOUR, 1.2, 2 * HOUR), sdk(-HOUR, 1.1, 2 * HOUR)];
    const window = series(events, 'day').windows[0]!;
    // the fall 120 -> 110 has the same resetsAt: noise, same window
    assert.equal(window.points.length, 4);
    assert.equal(window.peak.percent, 120);
    assert.equal(window.over_limit_at, iso(-3 * HOUR));
  });

  it('the peak is the first point on a tie', () => {
    const window = series([sdk(-3 * HOUR, 0.5, 2 * HOUR), sdk(-2 * HOUR, 0.8, 2 * HOUR), sdk(-HOUR, 0.8, 2 * HOUR)], 'day').windows[0]!;
    assert.equal(window.peak.at, iso(-2 * HOUR));
  });

  it('noise: a falling percent with the same known resetsAt stays in the window', () => {
    const result = series([sdk(-3 * HOUR, 0.8, 2 * HOUR), sdk(-2 * HOUR, 0.75, 2 * HOUR), sdk(-HOUR, 0.9, 2 * HOUR)], 'day');
    assert.deepEqual(result.windows.map(percents), [[80, 75, 90]]);
    assert.equal(result.windows[0]!.peak.percent, 90);
  });

  it('a fall without a known resetsAt starts a new window', () => {
    const result = series([sdk(-5 * HOUR, 0.8), sdk(-4 * HOUR, 0.9), sdk(-3 * HOUR, 0.1), sdk(-2 * HOUR, 0.3)], 'day');
    assert.deepEqual(result.windows.map(percents), [[80, 90], [10, 30]]);
    assert.deepEqual(result.windows.map((w) => w.resets_at), [null, null]);
    assert.deepEqual(result.windows.map((w) => w.current), [false, false]);
  });

  it('a fall where only one side carries a resetsAt is not noise', () => {
    const result = series([sdk(-5 * HOUR, 0.8), sdk(-4 * HOUR, 0.2, 3 * HOUR)], 'day');
    assert.deepEqual(result.windows.map(percents), [[80], [20]]);
  });

  it('a point at or after the reset of its window starts a new window; the reset is the first known resetsAt', () => {
    const events = [
      sdk(-6 * HOUR, 0.2, -3 * HOUR),
      sdk(-5 * HOUR, 0.4), // unknown resetsAt, before the reset: same window
      sdk(-3 * HOUR, 0.5, -3 * HOUR), // exactly at the reset
      sdk(-2 * HOUR, 0.6, -3 * HOUR), // stale resetsAt, after the reset of window 2
    ];
    const result = series(events, 'day');
    assert.equal(result.windows[0]!.resets_at, iso(-3 * HOUR));
    assert.deepEqual(percents(result.windows[0]!), [20, 40]);
    assert.deepEqual(result.windows.map(percents), [[20, 40], [50], [60]]);
    assert.deepEqual(result.windows.map((w) => w.start), [iso(-6 * HOUR), iso(-3 * HOUR), iso(-2 * HOUR)]);
  });

  it('the current window is the one whose reset equals the forecast reset', () => {
    const events = [sdk(-8 * HOUR, 0.9, -3 * HOUR), sdk(-HOUR, 0.4, 4 * HOUR)];
    const result = series(events, 'day');
    assert.deepEqual(result.windows.map((w) => w.current), [false, true]);
    assert.equal(result.windows[1]!.resets_at, iso(4 * HOUR));
    assert.equal(forecastBudget({ now, usage: [], events, window: 'five_hour' }).resets_at, iso(4 * HOUR));
  });

  it('week lists every window as its own section', () => {
    const events = [sdk(-6 * DAY, 0.5, -6 * DAY + 4 * HOUR), sdk(-3 * DAY, 0.7, -3 * DAY + 4 * HOUR), sdk(-HOUR, 0.2, 3 * HOUR)];
    const result = series(events, 'week');
    assert.deepEqual(result.windows.map(percents), [[50], [70], [20]]);
    assert.equal(result.summary.windows, 3);
    assert.equal(result.windows[2]!.current, true);
  });
});

describe('fiveHourSeries: rejected and pause', () => {
  it('a rejected five_hour event without a utilisation counts as 100 percent and is flagged', () => {
    const result = series([rejected(-HOUR, 2 * HOUR)], 'day');
    const window = result.windows[0]!;
    assert.deepEqual(window.points, [{ at: iso(-HOUR), percent: 100, rejected: true }]);
    assert.equal(window.over_limit, true);
    assert.equal(window.over_limit_at, iso(-HOUR));
    assert.equal(result.percent_source, 'sdk');
  });

  it('a rejected event whose utilisation is below 100 is still 100; above stays', () => {
    const low = event(-2 * HOUR, { status: 'rejected', unifiedWindows: { five_hour: { utilization: 0.7, resetsAt: secs(HOUR) } } });
    const high = event(-HOUR, { status: 'rejected', unifiedWindows: { five_hour: { utilization: 1.08, resetsAt: secs(HOUR) } } });
    const points = series([low, high], 'day').windows[0]!.points;
    assert.deepEqual(points.map((p) => [p.percent, p.rejected]), [[100, true], [108, true]]);
  });

  it('the pause runs from the first rejected event to the reset of the window', () => {
    const events = [sdk(-4 * HOUR, 0.9, -HOUR), rejected(-3 * HOUR, -HOUR), rejected(-2 * HOUR, -HOUR)];
    const result = series(events, 'day');
    const window = result.windows[0]!;
    assert.deepEqual(window.pause, { from: iso(-3 * HOUR), to: iso(-HOUR) });
    assert.equal(window.over_limit, true);
    assert.equal(window.over_limit_at, iso(-3 * HOUR));
    assert.equal(result.summary.paused_min, 120);
  });

  it('a running pause counts only until now; paused_min sums the windows', () => {
    const events = [
      sdk(-12 * HOUR, 0.9, -6 * HOUR),
      rejected(-10 * HOUR, -6 * HOUR), // 240 min
      rejected(-2 * HOUR, HOUR), // pause to the reset in 1 h, counted until now: 120 min
      rejected(-HOUR, HOUR),
    ];
    const result = series(events, 'day');
    assert.equal(result.windows.length, 2);
    assert.deepEqual(result.windows[0]!.pause, { from: iso(-10 * HOUR), to: iso(-6 * HOUR) });
    assert.deepEqual(result.windows[1]!.pause, { from: iso(-2 * HOUR), to: iso(HOUR) });
    assert.equal(result.windows[1]!.current, true);
    assert.deepEqual(result.summary, { windows: 2, over_limit: 2, paused_min: 360 });
  });

  it('without a reset there is no pause', () => {
    const result = series([sdk(-3 * HOUR, 0.9), rejected(-2 * HOUR)], 'day');
    const window = result.windows[0]!;
    assert.equal(window.resets_at, null);
    assert.equal(window.pause, null);
    assert.equal(window.over_limit, true);
    assert.deepEqual(result.summary, { windows: 1, over_limit: 1, paused_min: 0 });
  });

  it('over_limit counts only the windows over the limit', () => {
    const events = [sdk(-10 * HOUR, 0.6, -6 * HOUR), sdk(-5 * HOUR, 1.3, -HOUR), sdk(-HOUR / 2, 0.2, 4 * HOUR)];
    const result = series(events, 'day');
    assert.deepEqual(result.windows.map((w) => w.over_limit), [false, true, false]);
    assert.deepEqual(result.summary, { windows: 3, over_limit: 1, paused_min: 0 });
  });
});

describe('fiveHourSeries: calibrated source', () => {
  // 1000 tokens before the hit at now − 4 h calibrate the limit; 300 at now − 2 h and 600 at now − 10 min follow.
  const usage = [use(-5 * HOUR - MIN, 1000), use(-2 * HOUR, 300), use(-10 * MIN, 600)];

  it('uses tokens per limit when no SDK utilisation is live; rejected points are at least 100', () => {
    const events = [rejected(-8 * HOUR), rejected(-4 * HOUR), event(-HOUR, { status: 'allowed' })];
    const f = forecastBudget({ now, usage, events, window: 'five_hour' });
    assert.equal(f.percent_source, 'calibrated');
    assert.equal(f.forecast?.limit_tokens, 1000);
    const result = series(events, 'day', usage);
    assert.equal(result.percent_source, 'calibrated');
    assert.equal(result.windows.length, 1);
    assert.deepEqual(result.windows[0]!.points.map((p) => [p.at, p.percent, p.rejected]), [
      [iso(-8 * HOUR), 100, true], // 0 tokens in its window, raised to 100
      [iso(-4 * HOUR), 100, true],
      [iso(-HOUR), 130, false], // (1000 + 300) / 1000
    ]);
    assert.equal(result.windows[0]!.over_limit, true);
    assert.equal(result.windows[0]!.over_limit_at, iso(-8 * HOUR));
    assert.equal(result.windows[0]!.pause, null);
    assert.equal(result.summary.over_limit, 1);
  });

  it('the window range forecasts with burn rate per limit (percent per minute)', () => {
    const events = [rejected(-4 * HOUR), event(-MIN, { status: 'allowed', resetsAt: secs(2 * HOUR) })];
    const f = forecastBudget({ now, usage, events, window: 'five_hour' });
    assert.equal(f.percent_source, 'calibrated');
    const result = series(events, 'window', usage);
    assert.equal(result.percent_source, 'calibrated');
    assert.equal(result.from, iso(-3 * HOUR));
    assert.equal(result.to, iso(2 * HOUR));
    assert.ok(result.forecast !== null);
    const slope = (f.burn_rate_per_min / f.forecast!.limit_tokens!) * 100;
    assert.equal(f.percent, 90);
    assert.deepEqual(result.forecast!.from, { at: iso(0), percent: 90 });
    assert.equal(result.forecast!.to.at, iso(2 * HOUR));
    assert.equal(result.forecast!.to.percent, Math.round((90 + slope * 120) * 10) / 10);
    assert.ok(Math.abs(result.forecast!.rate_pct_per_min - slope) < 1e-9);
    assert.equal(result.forecast!.eta, f.forecast!.eta);
  });
});

describe('fiveHourSeries: forecast', () => {
  const rising = [sdk(-20 * MIN, 0.5, 2 * HOUR), sdk(-10 * MIN, 0.6, 2 * HOUR)];

  it('eta equals forecastBudget(...).forecast.eta and the slope is the SDK rate in percent', () => {
    const f = forecastBudget({ now, usage: [], events: rising, window: 'five_hour' });
    assert.equal(f.forecast?.eta, iso(40 * MIN));
    const result = series(rising, 'window');
    assert.equal(result.percent_source, 'sdk');
    assert.ok(result.forecast !== null);
    assert.equal(result.forecast.eta, f.forecast?.eta);
    assert.ok(Math.abs(result.forecast.rate_pct_per_min - f.utilization_rate_per_min! * 100) < 1e-9);
    assert.deepEqual(result.forecast.from, { at: iso(0), percent: 60 });
    assert.equal(result.forecast.to.at, iso(2 * HOUR));
    // 60 % now, 1 percentage point per minute, 120 minutes to the reset
    assert.equal(result.forecast.to.percent, 180);
  });

  it('day and week carry no forecast', () => {
    assert.equal(series(rising, 'day').forecast, null);
    assert.equal(series(rising, 'week').forecast, null);
  });

  it('an eta after the reset (or none) is passed through as null while the line is still drawn', () => {
    const slow = [sdk(-20 * MIN, 0.10, 2 * HOUR), sdk(-10 * MIN, 0.11, 2 * HOUR)];
    const f = forecastBudget({ now, usage: [], events: slow, window: 'five_hour' });
    assert.equal(f.forecast, null);
    const result = series(slow, 'window');
    assert.ok(result.forecast !== null);
    assert.equal(result.forecast.eta, null);
    assert.equal(result.forecast.from.percent, 11);
    assert.ok(result.forecast.to.percent > 11);
  });

  it('a slope of zero or below gives no forecast', () => {
    assert.equal(series([sdk(-20 * MIN, 0.5, 2 * HOUR), sdk(-10 * MIN, 0.5, 2 * HOUR)], 'window').forecast, null);
  });

  it('without a slope (one event) there is no forecast, even with token use in sdk mode', () => {
    assert.equal(series([sdk(-10 * MIN, 0.5, 2 * HOUR)], 'window', [use(-5 * MIN, 900)]).forecast, null);
  });

  it('without a reset there is no forecast', () => {
    const past = [sdk(-20 * MIN, 0.5, -MIN), sdk(-10 * MIN, 0.6, -MIN)];
    assert.equal(series(past, 'window').forecast, null);
  });

  it('without a known percent there is no forecast', () => {
    assert.equal(series([event(-MIN, { status: 'allowed', resetsAt: secs(HOUR) })], 'window').forecast, null);
  });
});
