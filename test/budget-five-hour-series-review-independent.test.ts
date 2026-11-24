import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { forecastBudget, type BudgetUsage } from '../src/budget/forecast.ts';
import { fiveHourSeries, type FiveHourRange } from '../src/budget/five-hour-series.ts';
import type { RateLimitRecord } from '../src/budget/rate-limit-log.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = new Date('2026-10-30T12:00:00Z');
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);
const iso = (offsetMs: number) => at(offsetMs).toISOString();
const secs = (offsetMs: number) => Math.floor(at(offsetMs).getTime() / 1000);

const event = (offset: number, info: Record<string, unknown>): RateLimitRecord => ({
  at: iso(offset), run_id: 'r', issue: 'acme/app#1', role: 'developer', model: null,
  rate_limit_info: { rateLimitType: 'five_hour', ...info },
});
/** SDK event with a utilisation share and an optional reset (offset relative to now). */
const sdk = (offset: number, utilization: number, resetOffset?: number) =>
  event(offset, {
    status: 'allowed',
    unifiedWindows: { five_hour: { utilization, ...(resetOffset === undefined ? {} : { resetsAt: secs(resetOffset) }) } },
  });
/** five_hour event without any SDK utilisation and without a reset. */
const noValue = (offset: number) => event(offset, { status: 'allowed' });
/** Rejected five_hour event without utilisation; the reset is a top-level `resetsAt`. */
const rejected = (offset: number, resetOffset?: number) =>
  event(offset, { status: 'rejected', ...(resetOffset === undefined ? {} : { resetsAt: secs(resetOffset) }) });
const use = (offset: number, tokens: number): BudgetUsage => ({ at: at(offset), tokens });

const series = (events: RateLimitRecord[], range: FiveHourRange, usage: BudgetUsage[] = []) => fiveHourSeries({ now, usage, events, range });
const percents = (window: { points: { percent: number }[] }) => window.points.map((p) => p.percent);
const forecast = (events: RateLimitRecord[], usage: BudgetUsage[]) => forecastBudget({ now, usage, events, window: 'five_hour' });

// A limit hit long before every range (8 days ago, no reset) calibrates a limit of 1000 tokens
// without producing a point in 'day' or 'week'.
const OLD_HIT = rejected(-8 * DAY);
const LIMIT_USAGE = use(-8 * DAY - MIN, 1000);

const RANGES = ['day', 'week'] as const;

describe('review 1: the source is chosen per point, not per series', () => {
  for (const range of RANGES) {
    it(`${range}: SDK values 60 and 130 stay although the current source is calibrated`, () => {
      const events = [OLD_HIT, sdk(-3 * HOUR, 0.6, -HOUR), sdk(-2 * HOUR, 1.3, -HOUR)];
      const usage = [LIMIT_USAGE, use(-3 * HOUR, 400), use(-150 * MIN, 600)]; // calibrated would give 40 and 100
      const f = forecast(events, usage);
      assert.equal(f.percent_source, 'calibrated');
      assert.equal(f.forecast?.limit_tokens, 1000);
      const result = series(events, range, usage);
      assert.equal(result.windows.length, 1);
      const window = result.windows[0]!;
      assert.deepEqual(percents(window), [60, 130]);
      assert.equal(window.over_limit, true);
      assert.deepEqual(window.peak, { at: iso(-2 * HOUR), percent: 130, rejected: false });
      assert.equal(window.over_limit_at, iso(-2 * HOUR));
      assert.equal(result.summary.over_limit, 1);
      assert.equal(result.summary.windows, 1);
      assert.equal(result.percent_source, 'sdk');
    });
  }

  it('the SDK percent is u times 100 with one decimal, values above 100 are kept', () => {
    const events = [OLD_HIT, sdk(-3 * HOUR, 0.4567, -HOUR), sdk(-2 * HOUR, 1.2349, -HOUR)];
    const usage = [LIMIT_USAGE, use(-3 * HOUR, 400)];
    assert.equal(forecast(events, usage).percent_source, 'calibrated');
    assert.deepEqual(percents(series(events, 'day', usage).windows[0]!), [45.7, 123.5]);
  });

  it('percent_source is calibrated when every point is calibrated: tokens in the rolling 5 h per limit tokens', () => {
    const events = [OLD_HIT, noValue(-3 * HOUR), noValue(-2 * HOUR)];
    const usage = [LIMIT_USAGE, use(-3 * HOUR, 400), use(-150 * MIN, 300)];
    const result = series(events, 'day', usage);
    assert.equal(result.percent_source, 'calibrated');
    assert.equal(result.windows.length, 1);
    assert.deepEqual(result.windows[0]!.points.map((p) => [p.at, p.percent, p.rejected]), [
      [iso(-3 * HOUR), 40, false],
      [iso(-2 * HOUR), 70, false],
    ]);
  });

  it('percent_source is mixed when SDK and calibrated points meet in one series', () => {
    const events = [OLD_HIT, sdk(-3 * HOUR, 0.6, -HOUR), noValue(-2 * HOUR)];
    const usage = [LIMIT_USAGE, use(-150 * MIN, 700)];
    const result = series(events, 'day', usage);
    assert.equal(result.percent_source, 'mixed');
    assert.equal(result.windows.length, 1);
    assert.deepEqual(percents(result.windows[0]!), [60, 70]);
  });

  it('percent_source is sdk when every point carries an SDK value', () => {
    assert.equal(series([sdk(-3 * HOUR, 0.2, 2 * HOUR), sdk(-HOUR, 0.4, 2 * HOUR)], 'day').percent_source, 'sdk');
  });

  it('percent_source is none without points', () => {
    for (const range of ['window', 'day', 'week'] as const) assert.equal(series([], range).percent_source, 'none');
  });

  it('an event without SDK value and without any known limit gives no point', () => {
    const result = series([noValue(-2 * HOUR)], 'day', [use(-3 * HOUR, 500)]);
    assert.equal(result.windows.flatMap((w) => w.points).length, 0);
    assert.equal(result.percent_source, 'none');
    assert.equal(result.summary.over_limit, 0);
  });

  it('day: a rejected event without limit knowledge counts as 100 percent', () => {
    const result = series([rejected(-2 * HOUR, 3 * HOUR)], 'day');
    assert.equal(result.windows.length, 1);
    assert.deepEqual(result.windows[0]!.points, [{ at: iso(-2 * HOUR), percent: 100, rejected: true }]);
    assert.equal(result.windows[0]!.over_limit, true);
    assert.equal(result.windows[0]!.peak.percent, 100);
    assert.deepEqual(result.summary, { windows: 1, over_limit: 1, paused_min: 120 });
  });

  it('a calibrated rejected point is at least 100 even with few tokens in its window', () => {
    const events = [OLD_HIT, rejected(-3 * HOUR), noValue(-2 * HOUR)];
    const usage = [LIMIT_USAGE, use(-150 * MIN, 300)];
    const points = series(events, 'day', usage).windows.flatMap((w) => w.points);
    assert.equal(points[0]!.rejected, true);
    assert.equal(points[0]!.percent, 100);
    assert.equal(points[0]!.at, iso(-3 * HOUR));
  });
});

describe('review 2: window borders in calibrated mode', () => {
  for (const range of RANGES) {
    it(`${range}: a falling rolling token sum alone does not start a new window`, () => {
      const events = [OLD_HIT, noValue(-4 * HOUR), noValue(-2 * HOUR), noValue(-HOUR)];
      // rolling 5 h: 800 at -4 h, then the 800 drop out -> 200, then +100 -> 300
      const usage = [LIMIT_USAGE, use(-8 * HOUR, 800), use(-3 * HOUR, 200), use(-90 * MIN, 100)];
      const result = series(events, range, usage);
      assert.equal(result.percent_source, 'calibrated');
      assert.equal(result.windows.length, 1);
      assert.deepEqual(percents(result.windows[0]!), [80, 20, 30]);
      assert.equal(result.windows[0]!.resets_at, null);
      assert.equal(result.summary.windows, 1);
    });
  }

  it('a fall between two SDK points without a shared resetsAt still starts a new window', () => {
    const result = series([sdk(-5 * HOUR, 0.8), sdk(-4 * HOUR, 0.2)], 'day');
    assert.deepEqual(result.windows.map(percents), [[80], [20]]);
    assert.equal(result.summary.windows, 2);
  });

  it('a fall between two SDK points with the same known resetsAt stays in the window', () => {
    const result = series([sdk(-3 * HOUR, 0.8, 2 * HOUR), sdk(-2 * HOUR, 0.5, 2 * HOUR)], 'day');
    assert.deepEqual(result.windows.map(percents), [[80, 50]]);
  });

  it('a calibrated point between SDK points does not separate windows by its fall', () => {
    const events = [OLD_HIT, sdk(-4 * HOUR, 0.8), noValue(-3 * HOUR), sdk(-2 * HOUR, 0.9)];
    const usage = [LIMIT_USAGE, use(-3 * HOUR, 300)];
    const result = series(events, 'day', usage);
    assert.equal(result.percent_source, 'mixed');
    assert.deepEqual(result.windows.map(percents), [[80, 30, 90]]);
  });

  it('a changed resetsAt starts a new window even when the percent rises', () => {
    const result = series([sdk(-3 * HOUR, 0.5, 2 * HOUR), sdk(-2 * HOUR, 0.6, 3 * HOUR)], 'day');
    assert.deepEqual(result.windows.map(percents), [[50], [60]]);
    assert.deepEqual(result.windows.map((w) => w.resets_at), [iso(2 * HOUR), iso(3 * HOUR)]);
  });

  it('a gap of exactly 5 h without a point starts a new window (SDK points without reset, rising)', () => {
    const result = series([sdk(-9 * HOUR, 0.2), sdk(-4 * HOUR, 0.3)], 'day');
    assert.deepEqual(result.windows.map(percents), [[20], [30]]);
    assert.equal(result.summary.windows, 2);
  });

  it('a gap just below 5 h stays in one window', () => {
    const result = series([sdk(-9 * HOUR, 0.2), sdk(-4 * HOUR - MIN, 0.3)], 'day');
    assert.deepEqual(result.windows.map(percents), [[20, 30]]);
    assert.equal(result.summary.windows, 1);
  });

  it('a gap of exactly 5 h also splits calibrated points', () => {
    const events = [OLD_HIT, noValue(-9 * HOUR), noValue(-4 * HOUR)];
    const usage = [LIMIT_USAGE, use(-9 * HOUR, 200), use(-6 * HOUR, 300)]; // 20, then 30
    const result = series(events, 'day', usage);
    assert.deepEqual(result.windows.map(percents), [[20], [30]]);
  });

  it('the gap rule works in the week range too', () => {
    const result = series([sdk(-3 * DAY, 0.2), sdk(-3 * DAY + 6 * HOUR, 0.3), sdk(-3 * DAY + 7 * HOUR, 0.4)], 'week');
    assert.deepEqual(result.windows.map(percents), [[20], [30, 40]]);
  });
});

describe('review 3: the forecast line meets 100 percent exactly at the ETA', () => {
  /** Value of the straight line from `forecast.from` to `forecast.to` at the instant `time`. */
  const lineAt = (f: { from: { at: string; percent: number }; to: { at: string; percent: number } }, time: string) => {
    const a = Date.parse(f.from.at);
    const b = Date.parse(f.to.at);
    return f.from.percent + ((f.to.percent - f.from.percent) * (Date.parse(time) - a)) / (b - a);
  };

  it('SDK: slow rate (u 0.85, 0.00065 per minute): eta unchanged and the line is at 100 at the eta', () => {
    const events = [sdk(-20 * MIN, 0.837, 4 * HOUR), sdk(0, 0.85, 4 * HOUR)];
    const f = forecast(events, []);
    assert.ok(f.forecast?.eta);
    const result = series(events, 'window');
    assert.ok(result.forecast !== null);
    assert.equal(result.forecast.eta, f.forecast.eta);
    assert.equal(result.forecast.from.percent, 85);
    assert.equal(result.forecast.to.at, f.resets_at);
    assert.equal(result.forecast.to.at, iso(4 * HOUR));
    assert.ok(Math.abs(lineAt(result.forecast, result.forecast.eta!) - 100) <= 0.2, `line at eta: ${lineAt(result.forecast, result.forecast.eta!)}`);
    assert.ok(result.forecast.to.percent > 100);
  });

  it('SDK: another rate (0.001125 per minute, rounded 0.0011) stays exact', () => {
    const events = [sdk(-25 * MIN, 0.8775, 4 * HOUR), sdk(-5 * MIN, 0.9, 4 * HOUR)];
    const f = forecast(events, []);
    assert.ok(f.forecast?.eta);
    const result = series(events, 'window');
    assert.ok(result.forecast !== null);
    assert.equal(result.forecast.eta, f.forecast.eta);
    assert.ok(Math.abs(lineAt(result.forecast, result.forecast.eta!) - 100) <= 0.2);
  });

  it('calibrated: the line also hits 100 at the eta (burn rate with rounding)', () => {
    const events = [OLD_HIT, event(-MIN, { status: 'allowed', resetsAt: secs(4 * HOUR) })];
    const usage = [LIMIT_USAGE, use(-2 * HOUR, 300), use(-10 * MIN, 610)]; // 910 of 1000, burn 20.33 per minute
    const f = forecast(events, usage);
    assert.equal(f.percent_source, 'calibrated');
    assert.ok(f.forecast?.eta);
    const result = series(events, 'window', usage);
    assert.ok(result.forecast !== null);
    assert.equal(result.forecast.eta, f.forecast.eta);
    assert.equal(result.forecast.from.percent, 91);
    assert.ok(Math.abs(lineAt(result.forecast, result.forecast.eta!) - 100) <= 0.2);
  });

  it('without an eta the slope stays utilization_rate_per_min (in percent) and the line is drawn to the reset', () => {
    const events = [sdk(-20 * MIN, 0.1, 2 * HOUR), sdk(-10 * MIN, 0.11, 2 * HOUR)];
    const f = forecast(events, []);
    assert.equal(f.forecast, null);
    const result = series(events, 'window');
    assert.ok(result.forecast !== null);
    assert.equal(result.forecast.eta, null);
    assert.equal(result.forecast.from.percent, 11);
    assert.equal(result.forecast.to.at, iso(2 * HOUR));
    assert.ok(Math.abs(result.forecast.rate_pct_per_min - f.utilization_rate_per_min! * 100) < 1e-9);
    assert.ok(Math.abs(result.forecast.to.percent - 23) <= 0.2); // 11 + 0.1 per minute * 120 minutes
  });

  it('a slope of zero or below still gives no forecast', () => {
    assert.equal(series([sdk(-20 * MIN, 0.5, 2 * HOUR), sdk(-10 * MIN, 0.5, 2 * HOUR)], 'window').forecast, null);
  });

  it('day and week carry no forecast even with an eta', () => {
    const events = [sdk(-20 * MIN, 0.837, 4 * HOUR), sdk(0, 0.85, 4 * HOUR)];
    assert.equal(series(events, 'day').forecast, null);
    assert.equal(series(events, 'week').forecast, null);
  });
});
