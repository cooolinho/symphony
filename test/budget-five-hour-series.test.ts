import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fiveHourSeries, isFiveHourRange, type FiveHourRange } from '../src/budget/five-hour-series.ts';
import { forecastBudget, type BudgetUsage } from '../src/budget/forecast.ts';
import type { RateLimitRecord } from '../src/budget/rate-limit-log.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const now = new Date('2026-11-24T12:00:00Z');
const at = (ms: number) => new Date(now.getTime() - ms).toISOString();
const sec = (ms: number) => Math.floor((now.getTime() + ms) / 1000);
const rec = (ago: number, info: Record<string, unknown>): RateLimitRecord => ({ at: at(ago), run_id: 'r', issue: 'acme/app#1', role: 'developer', model: null, rate_limit_info: info });
/** An event `ago` ms before now with five_hour utilisation `u` and the reset `reset` ms from now. */
const five = (ago: number, u: number, reset = 2 * HOUR, status = 'allowed') =>
  rec(ago, { rateLimitType: 'five_hour', status, resetsAt: sec(reset), unifiedWindows: { five_hour: { utilization: u, resetsAt: sec(reset) } } });
const rejected = (ago: number, reset = 2 * HOUR) => rec(ago, { rateLimitType: 'five_hour', status: 'rejected', resetsAt: sec(reset) });
const run = (events: RateLimitRecord[], range: FiveHourRange = 'day', usage: BudgetUsage[] = []) => fiveHourSeries({ now, usage, events, range });

describe('isFiveHourRange', () => {
  it('accepts window, day and week only', () => {
    for (const value of ['window', 'day', 'week']) assert.equal(isFiveHourRange(value), true);
    for (const value of ['month', '', null, 1]) assert.equal(isFiveHourRange(value), false);
  });
});

describe('fiveHourSeries', () => {
  it('an empty range has no windows, no forecast and percent_source none', () => {
    for (const range of ['window', 'day', 'week'] as const) {
      const series = run([], range);
      assert.deepEqual(series.windows, []);
      assert.equal(series.forecast, null);
      assert.equal(series.percent_source, 'none');
      assert.deepEqual(series.summary, { windows: 0, over_limit: 0, paused_min: 0 });
    }
  });

  it('events outside the range give no points', () => {
    const series = run([five(30 * HOUR, 0.5, -26 * HOUR)], 'day');
    assert.equal(series.windows.length, 0);
    assert.equal(run([five(30 * HOUR, 0.5, -26 * HOUR)], 'week').windows.length, 1);
  });

  it('a change of the reset starts a new window', () => {
    const series = run([five(8 * HOUR, 0.2, -4 * HOUR), five(7 * HOUR, 0.4, -4 * HOUR), five(3 * HOUR, 0.6, 2 * HOUR), five(1 * HOUR, 0.7, 2 * HOUR)]);
    assert.equal(series.windows.length, 2);
    assert.deepEqual(series.windows.map((w) => w.points.map((p) => p.percent)), [[20, 40], [60, 70]]);
    assert.equal(series.windows[0]!.resets_at, new Date(sec(-4 * HOUR) * 1000).toISOString());
    assert.equal(series.windows[0]!.current, false);
    assert.equal(series.windows[1]!.current, true);
  });

  it('a fall of the utilisation without the same reset starts a new window', () => {
    const noReset = (ago: number, u: number) => rec(ago, { rateLimitType: 'five_hour', status: 'allowed', unifiedWindows: { five_hour: { utilization: u } } });
    const series = run([noReset(6 * HOUR, 0.5), noReset(5 * HOUR, 0.8), noReset(4 * HOUR, 0.1), noReset(3 * HOUR, 0.3)]);
    assert.deepEqual(series.windows.map((w) => w.points.map((p) => p.percent)), [[50, 80], [10, 30]]);
  });

  it('a dip with the same known reset stays in the window', () => {
    const series = run([five(3 * HOUR, 0.5), five(2 * HOUR, 0.49), five(1 * HOUR, 0.6)]);
    assert.equal(series.windows.length, 1);
    assert.equal(series.windows[0]!.points.length, 3);
  });

  it('keeps values above 100 % and marks the window over the limit at its first point above 100', () => {
    const series = run([five(3 * HOUR, 0.9), five(2 * HOUR, 1.05), five(1 * HOUR, 1.12)]);
    const window = series.windows[0]!;
    assert.equal(window.peak.percent, 112);
    assert.equal(window.peak.at, at(1 * HOUR));
    assert.equal(window.over_limit, true);
    assert.equal(window.over_limit_at, at(2 * HOUR));
    assert.equal(window.pause, null);
    assert.equal(series.summary.over_limit, 1);
  });

  it('a window up to 100 % is not over the limit', () => {
    const window = run([five(2 * HOUR, 0.9), five(1 * HOUR, 1)]).windows[0]!;
    assert.equal(window.over_limit, false);
    assert.equal(window.over_limit_at, null);
  });

  it('a rejected event without utilisation counts as 100 % and over the limit', () => {
    const window = run([five(2 * HOUR, 0.8), rejected(1 * HOUR)]).windows[0]!;
    assert.deepEqual(window.points.map((p) => [p.percent, p.rejected]), [[80, false], [100, true]]);
    assert.equal(window.over_limit, true);
    assert.equal(window.over_limit_at, at(1 * HOUR));
  });

  it('the pause runs from the first rejected event to the reset; paused minutes stop at now', () => {
    const series = run([five(8 * HOUR, 0.7, -4 * HOUR), rejected(7 * HOUR, -4 * HOUR), rejected(6 * HOUR, -4 * HOUR), five(2 * HOUR, 0.9, 1 * HOUR), rejected(1 * HOUR, 1 * HOUR)]);
    assert.equal(series.windows.length, 2);
    assert.deepEqual(series.windows[0]!.pause, { from: at(7 * HOUR), to: new Date(sec(-4 * HOUR) * 1000).toISOString() });
    assert.deepEqual(series.windows[1]!.pause, { from: at(1 * HOUR), to: new Date(sec(1 * HOUR) * 1000).toISOString() });
    // 3 h of the closed pause plus 1 h of the running one (until now, not until the reset)
    assert.equal(series.summary.paused_min, 240);
    assert.equal(series.summary.over_limit, 2);
  });

  it('window: from reset − 5 h to the reset, only the current window', () => {
    const series = run([five(8 * HOUR, 0.6, -4 * HOUR), five(2 * HOUR, 0.4), five(0, 0.5)], 'window');
    assert.equal(series.to, new Date(sec(2 * HOUR) * 1000).toISOString());
    assert.equal(Date.parse(series.to) - Date.parse(series.from), 5 * HOUR);
    assert.equal(series.windows.length, 1);
    assert.equal(series.windows[0]!.current, true);
    assert.equal(series.percent_source, 'sdk');
  });

  it('window: after the reset has passed, the old window is not shown as the running one', () => {
    const series = run([five(3 * HOUR, 0.9, -1 * HOUR), rejected(2 * HOUR, -1 * HOUR)], 'window');
    assert.deepEqual(series.windows, []);
    assert.equal(series.summary.over_limit, 0);
    assert.equal(run([five(3 * HOUR, 0.9, -1 * HOUR), rejected(2 * HOUR, -1 * HOUR)], 'day').windows.length, 1);
  });

  it('window: the forecast uses the slope of the bar and its ETA is forecast.eta', () => {
    const events = [five(20 * MIN, 0.7), five(0, 0.8)];
    const series = run(events, 'window');
    const bar = forecastBudget({ now, usage: [], events, window: 'five_hour' });
    assert.ok(bar.forecast?.eta);
    assert.equal(series.forecast!.eta, bar.forecast!.eta);
    assert.equal(series.forecast!.rate_pct_per_min, 0.5);
    assert.deepEqual(series.forecast!.from, { at: now.toISOString(), percent: 80 });
    assert.equal(series.forecast!.to.at, bar.resets_at);
    assert.ok(series.forecast!.to.percent > 100);
  });

  it('no forecast without a slope or outside window', () => {
    assert.equal(run([five(0, 0.8)], 'window').forecast, null);
    assert.equal(run([five(20 * MIN, 0.7), five(0, 0.8)], 'day').forecast, null);
  });

  it('calibrated: percent from the tokens before each event and the calibrated limit', () => {
    const usage: BudgetUsage[] = [
      { at: new Date(now.getTime() - 4 * HOUR), tokens: 500 },
      { at: new Date(now.getTime() - 3 * HOUR), tokens: 500 },
      { at: new Date(now.getTime() - 10 * MIN), tokens: 250 },
    ];
    // a rejected event 2 h ago calibrates the limit to the 1000 tokens before it
    const series = run([rejected(2 * HOUR, -1 * HOUR)], 'day', usage);
    assert.equal(series.percent_source, 'calibrated');
    assert.deepEqual(series.windows[0]!.points.map((p) => p.percent), [100]);
  });
});
