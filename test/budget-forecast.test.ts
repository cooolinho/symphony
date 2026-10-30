import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { budgetAlerts, forecastBudget, usageFromHistory, type BudgetUsage } from '../src/budget/forecast.ts';
import type { RateLimitRecord } from '../src/budget/rate-limit-log.ts';
import { HistoryLog } from '../src/history/history.ts';
import { PricingStore } from '../src/costs/pricing.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, tempDir } from './helpers.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const now = new Date('2026-10-30T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const use = (ms: number, tokens: number, role?: string): BudgetUsage => ({ at: ago(ms), tokens, role });
const event = (ms: number, info: Record<string, unknown>): RateLimitRecord => ({
  at: ago(ms).toISOString(), run_id: 'r', issue: 'acme/app#1', role: 'developer', model: null,
  rate_limit_info: { rateLimitType: 'five_hour', ...info },
});
const resets = (ms: number) => Math.floor((now.getTime() + ms) / 1000);
const run = (usage: BudgetUsage[], events: RateLimitRecord[], window: 'five_hour' | 'seven_day' = 'five_hour') => forecastBudget({ now, usage, events, window });

// 1000 tokens before the rejected hit at now − 4 h, then 600 tokens in the last 30 min.
const hitUsage = [use(5 * HOUR + MIN, 1000), use(10 * MIN, 600)];

describe('forecastBudget', () => {
  it('without a known hit the forecast is null but usage and burn rate are delivered', () => {
    const result = run([use(2 * HOUR, 300), use(10 * MIN, 90)], [event(HOUR, { status: 'allowed', resetsAt: resets(2 * HOUR) })]);
    assert.equal(result.forecast, null);
    assert.equal(result.alert, false);
    assert.equal(result.used_tokens, 390);
    assert.equal(result.burn_rate_per_min, 3);
    assert.equal(result.resets_at, new Date(now.getTime() + 2 * HOUR).toISOString());
  });

  it('a known hit gives limit, eta and an alert', () => {
    const result = run(hitUsage, [event(4 * HOUR, { status: 'rejected' }), event(MIN, { status: 'allowed', resetsAt: resets(2 * HOUR) })]);
    assert.equal(result.used_tokens, 600);
    assert.equal(result.burn_rate_per_min, 20);
    assert.deepEqual(result.forecast, { limit_tokens: 1000, limit_source: 'calibrated', eta: new Date(now.getTime() + 20 * MIN).toISOString() });
    assert.equal(result.alert, true);
  });

  it('an eta after the reset is null and raises no alert', () => {
    const result = run(hitUsage, [event(4 * HOUR, { status: 'rejected' }), event(MIN, { status: 'allowed', resetsAt: resets(10 * MIN) })]);
    assert.equal(result.forecast?.limit_tokens, 1000);
    assert.equal(result.forecast?.eta, null);
    assert.equal(result.alert, false);
  });

  it('a reset in the past is null and so is the eta', () => {
    const result = run(hitUsage, [event(4 * HOUR, { status: 'rejected', resetsAt: resets(-HOUR) })]);
    assert.equal(result.resets_at, null);
    assert.equal(result.forecast?.eta, null);
  });

  it('the burn rate covers only the last 30 minutes', () => {
    const result = run([use(31 * MIN, 300), use(29 * MIN, 600)], []);
    assert.equal(result.burn_rate_per_min, 20);
    assert.equal(result.used_tokens, 900);
  });

  it('the window is rolling and exclusive at its start; by_role sums per role', () => {
    const usage = [use(5 * HOUR, 100, 'developer'), use(6 * HOUR, 50), use(HOUR, 10, 'developer'), use(HOUR, 5, 'reviewer'), use(HOUR, 1)];
    const five = run(usage, []);
    assert.equal(five.used_tokens, 16);
    assert.deepEqual(five.by_role, { developer: 10, reviewer: 5, default: 1 });
    assert.equal(run(usage, [], 'seven_day').used_tokens, 166);
  });

  it('only events of the same rateLimitType calibrate', () => {
    const events = [event(4 * HOUR, { status: 'rejected', rateLimitType: 'seven_day', resetsAt: resets(HOUR) })];
    assert.equal(run(hitUsage, events).forecast, null);
    assert.equal(run(hitUsage, events, 'seven_day').forecast?.limit_tokens, 1000);
  });

  it('the SDK utilization wins over a rejected hit; invalid values are ignored', () => {
    const usage = [use(HOUR + MIN, 400), use(10 * MIN, 100)];
    const sdk = run(usage, [event(4 * HOUR, { status: 'rejected' }), event(HOUR, { utilization: 0.5, resetsAt: resets(3 * HOUR) })]);
    assert.equal(sdk.forecast?.limit_tokens, 800);
    assert.equal(sdk.forecast?.limit_source, 'sdk');
    for (const utilization of [0, 1.5]) {
      assert.equal(run(usage, [event(HOUR, { utilization })]).forecast, null);
    }
  });

  it('edge cases: no burn, limit reached, limit 0', () => {
    const hit = event(4 * HOUR, { status: 'rejected' });
    const reset = event(MIN, { status: 'allowed', resetsAt: resets(2 * HOUR) });
    const idle = run([use(5 * HOUR + MIN, 1000), use(2 * HOUR, 100)], [hit, reset]);
    assert.equal(idle.forecast?.eta, null);
    assert.equal(idle.alert, false);
    const over = run([use(5 * HOUR + MIN, 100), use(10 * MIN, 500)], [hit, reset]);
    assert.equal(over.forecast?.eta, now.toISOString());
    assert.equal(over.alert, true);
    assert.equal(run([use(10 * MIN, 5)], [hit, reset]).forecast, null);
  });
});

describe('usageFromHistory', () => {
  it('keeps run_finished lines only, defaults the role and skips invalid times', () => {
    const usage = usageFromHistory([
      { ts: '2026-10-30T11:00:00.000Z', event: 'run_finished', fields: { total_tokens: '120', role: 'reviewer' } },
      { ts: '2026-10-30T11:00:00.000Z', event: 'run_started', fields: { total_tokens: '5' } },
      { ts: 'garbage', event: 'run_finished', fields: { total_tokens: '7' } },
      { ts: '2026-10-30T11:30:00.000Z', event: 'run_finished', fields: {} },
    ]);
    assert.deepEqual(usage.map((u) => [u.tokens, u.role]), [[120, 'reviewer'], [0, 'default']]);
  });
});

describe('Orchestrator budget', () => {
  function build(withEvents: boolean) {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
    const history = new HistoryLog(path.join(dir, 'repositories'), new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent()), Logger.silent());
    const finish = (at: Date, tokens: number) =>
      history.runFinished({
        repo: 'acme/app', issue: 'acme/app#1', title: 'T', run: `r${at.getTime()}`, session: null, attempt: null, outcome: 'handed_off',
        state: 'In review', reason: 'done', turns: 1, startedAt: at, finishedAt: at, agentSeconds: 1,
        usage: { m: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }, claudeEstimateUsd: null,
      });
    finish(ago(5 * HOUR + MIN), 1000);
    finish(ago(10 * MIN), 600);
    const logDir = tempDir();
    if (withEvents) {
      fs.mkdirSync(path.join(logDir, 'budget'));
      const lines = [event(4 * HOUR, { status: 'rejected' }), event(MIN, { status: 'allowed', resetsAt: resets(2 * HOUR) })];
      fs.writeFileSync(path.join(logDir, 'budget', 'rate-limits.jsonl'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
    }
    const clock = new ManualClock();
    clock.wall = now.getTime();
    return new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))), runner: new FakeRunner(), logger: Logger.silent(), env: {},
      logDir, history, clock, timers: new ManualTimers(), createAdapter: () => new FakeTracker(),
    });
  }

  it('provides the alert for the dashboard', () => {
    const orchestrator = build(true);
    assert.equal(orchestrator.budget().five_hour.alert, true);
    const alerts = orchestrator.budgetAlerts();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.window, 'five_hour');
    assert.deepEqual(budgetAlerts(orchestrator.budget()), alerts);
  });

  it('has no alerts without events', () => {
    assert.deepEqual(build(false).budgetAlerts(), []);
  });
});
