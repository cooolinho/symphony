import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { budgetAlerts, forecastBudget, type BudgetUsage } from '../src/budget/forecast.ts';
import type { RateLimitRecord } from '../src/budget/rate-limit-log.ts';

// Independent tests for E4-8 (ETA and alert from the slope of the SDK utilisation), derived from the issue.
const MIN = 60_000;
const HOUR = 60 * MIN;
const now = new Date('2026-10-30T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const use = (ms: number, tokens: number): BudgetUsage => ({ at: ago(ms), tokens });
const resets = (ms: number) => Math.floor((now.getTime() + ms) / 1000);
const rec = (ms: number, info: Record<string, unknown>): RateLimitRecord => ({
  at: ago(ms).toISOString(), run_id: 'r', issue: 'acme/app#1', role: 'developer', model: null,
  rate_limit_info: { rateLimitType: 'five_hour', ...info },
});
const unified = (ms: number, windows: Record<string, number>, reset = 2 * HOUR, type = 'five_hour') =>
  rec(ms, {
    rateLimitType: type, status: 'allowed', resetsAt: resets(reset),
    unifiedWindows: Object.fromEntries(Object.entries(windows).map(([key, utilization]) => [key, { utilization, resetsAt: resets(reset) }])),
  });
const five = (ms: number, utilization: number, reset = 2 * HOUR) => unified(ms, { five_hour: utilization }, reset);
const run = (usage: BudgetUsage[], events: RateLimitRecord[], window: 'five_hour' | 'seven_day' = 'five_hour') => forecastBudget({ now, usage, events, window });
const etaMs = (result: ReturnType<typeof run>) => Date.parse(result.forecast!.eta!);

describe('E4-8 slope of the SDK utilisation', () => {
  it('0.70 twenty minutes ago and 0.80 now: 0.005 per minute, eta in 40 minutes, alert', () => {
    const result = run([], [five(20 * MIN, 0.7), five(0, 0.8)]);
    assert.equal(result.utilization_rate_per_min, 0.005);
    assert.ok(Math.abs(etaMs(result) - (now.getTime() + 40 * MIN)) < 1000);
    assert.equal(result.alert, true);
  });

  it('is independent of the order of the events', () => {
    const result = run([], [five(0, 0.8), five(20 * MIN, 0.7)]);
    assert.equal(result.utilization_rate_per_min, 0.005);
    assert.equal(result.alert, true);
  });

  it('the rate is rounded to four decimals', () => {
    const result = run([], [five(3 * MIN, 0.5), five(0, 0.6)]);
    assert.equal(result.utilization_rate_per_min, 0.0333);
  });

  it('the same events with the reset in 30 minutes: eta null, no alert (eta would be in 40)', () => {
    const result = run([], [five(20 * MIN, 0.7, 30 * MIN), five(0, 0.8, 30 * MIN)]);
    assert.equal(result.forecast?.eta ?? null, null);
    assert.equal(result.alert, false);
  });

  it('a single event gives neither slope nor eta', () => {
    const result = run([], [five(0, 0.8)]);
    assert.equal(result.utilization_rate_per_min, null);
    assert.equal(result.forecast?.eta ?? null, null);
    assert.equal(result.alert, false);
  });

  it('no events: no slope, no forecast', () => {
    const result = run([], []);
    assert.equal(result.utilization_rate_per_min, null);
    assert.equal(result.forecast, null);
    assert.equal(result.alert, false);
  });

  it('a reset inside the 30 minutes (utilisation falls) gives no slope and no eta', () => {
    const result = run([], [five(25 * MIN, 0.9), five(10 * MIN, 0.1), five(0, 0.2)]);
    assert.equal(result.utilization_rate_per_min, null);
    assert.equal(result.forecast?.eta ?? null, null);
    assert.equal(result.alert, false);
  });

  it('only the last 30 minutes count: an older event is ignored, one on the boundary too', () => {
    assert.equal(run([], [five(45 * MIN, 0.1), five(0, 0.8)]).utilization_rate_per_min, null);
    // 0.5 at -10 min, 0.6 now = 0.01/min; the event at exactly -30 min must not drag the slope down
    const result = run([], [five(30 * MIN, 0.1), five(10 * MIN, 0.5), five(0, 0.6)]);
    assert.equal(result.utilization_rate_per_min, 0.01);
  });

  it('a fall before the 30 minutes does not matter', () => {
    const result = run([], [five(50 * MIN, 0.9), five(20 * MIN, 0.1), five(0, 0.3)]);
    assert.equal(result.utilization_rate_per_min, 0.01);
  });

  it('events in the future are ignored', () => {
    const result = run([], [five(-5 * MIN, 0.99), five(0, 0.8)]);
    assert.equal(result.utilization_rate_per_min, null);
  });

  it('events without a utilisation for this window do not count', () => {
    const noWindow = rec(10 * MIN, { status: 'allowed', resetsAt: resets(2 * HOUR) });
    const sevenOnly = unified(15 * MIN, { seven_day: 0.2 });
    const result = run([], [noWindow, sevenOnly, five(20 * MIN, 0.7), five(0, 0.8)]);
    assert.equal(result.utilization_rate_per_min, 0.005);
    assert.equal(run([], [noWindow, sevenOnly, five(0, 0.8)]).utilization_rate_per_min, null);
  });

  it('each window has its own slope', () => {
    const events = [unified(20 * MIN, { five_hour: 0.7, seven_day: 0.1 }), unified(0, { five_hour: 0.8, seven_day: 0.12 })];
    assert.equal(run([], events, 'five_hour').utilization_rate_per_min, 0.005);
    assert.equal(run([], events, 'seven_day').utilization_rate_per_min, 0.001);
  });

  it('seven_day gets an eta from its own slope', () => {
    const events = [unified(20 * MIN, { seven_day: 0.7 }, 3 * HOUR, 'seven_day'), unified(0, { seven_day: 0.8 }, 3 * HOUR, 'seven_day')];
    const result = run([], events, 'seven_day');
    assert.ok(Math.abs(etaMs(result) - (now.getTime() + 40 * MIN)) < 1000);
    assert.equal(result.alert, true);
  });

  it('a utilisation in the top level of an event of this type counts as well', () => {
    const top = (ms: number, utilization: number) => rec(ms, { status: 'allowed_warning', utilization, resetsAt: resets(2 * HOUR) });
    const result = run([], [top(20 * MIN, 0.7), top(0, 0.8)]);
    assert.equal(result.utilization_rate_per_min, 0.005);
    assert.equal(result.alert, true);
  });

  it('a flat utilisation gives no eta', () => {
    const result = run([], [five(20 * MIN, 0.5), five(0, 0.5)]);
    assert.equal(result.forecast?.eta ?? null, null);
    assert.equal(result.alert, false);
  });
});

describe('E4-8 eta from the utilisation', () => {
  it('utilisation 1.01 gives eta = now and an alert', () => {
    const result = run([], [five(0, 1.01, HOUR)]);
    assert.equal(result.forecast!.eta, now.toISOString());
    assert.equal(result.alert, true);
  });

  it('utilisation exactly 1 gives eta = now', () => {
    const result = run([], [five(0, 1, HOUR)]);
    assert.equal(result.forecast!.eta, now.toISOString());
    assert.equal(result.alert, true);
  });

  it('utilisation 1 with a slope still gives now, not a later time', () => {
    const result = run([], [five(10 * MIN, 0.9, HOUR), five(0, 1, HOUR)]);
    assert.equal(result.forecast!.eta, now.toISOString());
  });

  it('the eta uses the utilisation of the newest event', () => {
    // 0.2 -> 0.4 in 10 min = 0.02/min; 0.6 left / 0.02 = 30 min
    const result = run([], [five(10 * MIN, 0.2), five(0, 0.4)]);
    assert.ok(Math.abs(etaMs(result) - (now.getTime() + 30 * MIN)) < 1000);
  });

  it('the eta does not depend on tokens: slope without any tokens still gives an eta', () => {
    const result = run([], [five(20 * MIN, 0.7), five(0, 0.8)]);
    assert.ok(result.forecast, 'forecast exists');
    assert.equal(result.alert, true);
    assert.equal(result.used_tokens, 0);
  });

  it('with tokens the eta still comes from the SDK slope, not from the token burn', () => {
    // token burn alone would hit the limit fast (limit 1000 from 0.5 at 500 tokens, 400 burned in 30 min => ~ 75 min left)
    // SDK slope 0.01/min from 0.5: 50 min
    const usage = [use(HOUR, 500), use(10 * MIN, 400)];
    const events = [five(10 * MIN, 0.4), five(0, 0.5)];
    const result = run(usage, events);
    assert.ok(Math.abs(etaMs(result) - (now.getTime() + 50 * MIN)) < 1000);
    assert.equal(result.utilization_rate_per_min, 0.01);
  });

  it('with an SDK utilisation and no slope, tokens do not produce an eta', () => {
    const usage = [use(HOUR, 500), use(10 * MIN, 5000)];
    const result = run(usage, [five(0, 0.5)]);
    assert.equal(result.forecast?.eta ?? null, null);
    assert.equal(result.alert, false);
  });

  it('alert is true exactly when the eta is set', () => {
    const cases = [
      [five(20 * MIN, 0.7), five(0, 0.8)],
      [five(20 * MIN, 0.7, 30 * MIN), five(0, 0.8, 30 * MIN)],
      [five(0, 0.8)],
      [five(0, 1.2)],
      [],
    ];
    for (const events of cases) {
      const result = run([], events);
      assert.equal(result.alert, (result.forecast?.eta ?? null) !== null);
    }
  });
});

describe('E4-8 fallback without SDK utilisation', () => {
  const hitUsage = [use(5 * HOUR + MIN, 1000), use(10 * MIN, 600)];
  const fallbackEvents = [rec(4 * HOUR, { status: 'rejected' }), rec(MIN, { status: 'allowed', resetsAt: resets(2 * HOUR) })];

  it('keeps the token calculation and the calibrated source', () => {
    const result = run(hitUsage, fallbackEvents);
    assert.deepEqual(result.forecast, { limit_tokens: 1000, limit_source: 'calibrated', eta: new Date(now.getTime() + 20 * MIN).toISOString() });
    assert.equal(result.utilization_rate_per_min, null);
    assert.equal(result.burn_rate_per_min, 20);
    assert.equal(result.percent_source, 'calibrated');
    assert.equal(result.alert, true);
  });

  it('the reset in 10 minutes still suppresses the token eta', () => {
    const result = run(hitUsage, [rec(4 * HOUR, { status: 'rejected' }), rec(MIN, { status: 'allowed', resetsAt: resets(10 * MIN) })]);
    assert.equal(result.forecast?.eta, null);
    assert.equal(result.alert, false);
  });

  it('every report field is still present', () => {
    const result = run(hitUsage, fallbackEvents);
    for (const key of ['window', 'used_tokens', 'burn_rate_per_min', 'utilization_rate_per_min', 'resets_at', 'sdk', 'percent', 'percent_source', 'forecast', 'alert', 'by_role']) {
      assert.ok(key in result, key);
    }
  });
});

describe('E4-8 budgetAlerts', () => {
  const report = (five_hour: ReturnType<typeof run>, seven_day: ReturnType<typeof run>) => ({ five_hour, seven_day, generated_at: now.toISOString() });

  it('an SDK eta gives an alert with percent and source sdk', () => {
    const sdk = run([], [five(20 * MIN, 0.7), five(0, 0.8)]);
    const alerts = budgetAlerts(report(sdk, run([], [], 'seven_day')));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.window, 'five_hour');
    assert.equal(alerts[0]!.source, 'sdk');
    assert.equal(alerts[0]!.percent, 80);
    assert.equal(alerts[0]!.eta, sdk.forecast!.eta);
    assert.equal(alerts[0]!.resets_at, sdk.resets_at);
  });

  it('SDK source keeps the token values when there are tokens', () => {
    const usage = [use(HOUR, 500), use(10 * MIN, 100)];
    const alerts = budgetAlerts(report(run(usage, [five(10 * MIN, 0.4), five(0, 0.5)]), run([], [], 'seven_day')));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.source, 'sdk');
    assert.equal(alerts[0]!.used_tokens, 600);
    assert.equal(typeof alerts[0]!.limit_tokens, 'number');
  });

  it('a calibrated eta gives an alert with source calibrated and the token values', () => {
    const hitUsage = [use(5 * HOUR + MIN, 1000), use(10 * MIN, 600)];
    const events = [rec(4 * HOUR, { status: 'rejected' }), rec(MIN, { status: 'allowed', resetsAt: resets(2 * HOUR) })];
    const alerts = budgetAlerts(report(run(hitUsage, events), run([], [], 'seven_day')));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.source, 'calibrated');
    assert.equal(alerts[0]!.limit_tokens, 1000);
    assert.equal(alerts[0]!.used_tokens, 600);
    assert.equal(alerts[0]!.percent, 60);
  });

  it('no eta gives no alert', () => {
    const quiet = run([], [five(20 * MIN, 0.7, 30 * MIN), five(0, 0.8, 30 * MIN)]);
    assert.deepEqual(budgetAlerts(report(quiet, run([], [], 'seven_day'))), []);
  });
});
