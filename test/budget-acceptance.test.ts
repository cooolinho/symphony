import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { budgetAlerts, budgetReport, forecastBudget, type BudgetUsage } from '../src/budget/forecast.ts';
import type { RateLimitRecord } from '../src/budget/rate-limit-log.ts';
import { PricingStore } from '../src/costs/pricing.ts';
import { HistoryLog } from '../src/history/history.ts';
import { startHttpServer, type HttpServerHandle } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, tempDir } from './helpers.ts';

// Acceptance tests for E4-4 (#338), derived from the issue's criteria.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date('2026-11-02T08:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const use = (ms: number, tokens: number, role?: string): BudgetUsage => ({ at: ago(ms), tokens, role });
const ev = (ms: number, type: string, info: Record<string, unknown> = {}): RateLimitRecord => ({
  at: ago(ms).toISOString(), run_id: 'r1', issue: 'acme/app#9', role: 'developer', model: null,
  rate_limit_info: { rateLimitType: type, ...info },
});
const unix = (ms: number) => Math.floor((NOW.getTime() + ms) / 1000);

describe('forecastBudget: rolling window usage', () => {
  it('sums tokens in (now - 5h, now] for five_hour and (now - 7d, now] for seven_day', () => {
    const usage = [use(6 * HOUR, 100), use(5 * HOUR, 200), use(5 * HOUR - 1, 300), use(1, 400), use(-MIN, 999), use(7 * DAY, 50), use(6 * DAY, 25)];
    const five = forecastBudget({ now: NOW, usage, events: [], window: 'five_hour' });
    const seven = forecastBudget({ now: NOW, usage, events: [], window: 'seven_day' });
    assert.equal(five.window, 'five_hour');
    assert.equal(seven.window, 'seven_day');
    assert.equal(five.used_tokens, 700);
    assert.equal(seven.used_tokens, 100 + 200 + 300 + 400 + 25);
  });

  it('is pure: same input gives the same result and does not mutate the input', () => {
    const usage = [use(HOUR, 10), use(MIN, 20)];
    const events = [ev(2 * HOUR, 'five_hour', { status: 'rejected', resetsAt: unix(HOUR) })];
    const snapshot = JSON.stringify({ usage, events });
    const a = forecastBudget({ now: NOW, usage, events, window: 'five_hour' });
    const b = forecastBudget({ now: NOW, usage, events, window: 'five_hour' });
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify({ usage, events }), snapshot);
  });

  it('returns zeros and null without any input', () => {
    const result = forecastBudget({ now: NOW, usage: [], events: [], window: 'seven_day' });
    assert.equal(result.used_tokens, 0);
    assert.equal(result.burn_rate_per_min, 0);
    assert.equal(result.resets_at, null);
    assert.equal(result.forecast, null);
    assert.equal(result.alert, false);
    assert.deepEqual(result.by_role, {});
  });

  it('by_role sums per role inside the window only', () => {
    const usage = [use(HOUR, 100, 'developer'), use(2 * HOUR, 50, 'developer'), use(3 * HOUR, 70, 'reviewer'), use(6 * HOUR, 999, 'developer')];
    const five = forecastBudget({ now: NOW, usage, events: [], window: 'five_hour' });
    assert.deepEqual(five.by_role, { developer: 150, reviewer: 70 });
    const seven = forecastBudget({ now: NOW, usage, events: [], window: 'seven_day' });
    assert.deepEqual(seven.by_role, { developer: 1149, reviewer: 70 });
  });
});

describe('forecastBudget: burn rate', () => {
  it('is the tokens of the last 30 minutes divided by 30', () => {
    const result = forecastBudget({ now: NOW, usage: [use(45 * MIN, 5000), use(31 * MIN, 5000), use(20 * MIN, 150), use(5 * MIN, 450)], events: [], window: 'five_hour' });
    assert.equal(result.burn_rate_per_min, 20);
    assert.equal(result.used_tokens, 10600);
  });

  it('is the same for the seven_day window', () => {
    const result = forecastBudget({ now: NOW, usage: [use(DAY, 100000), use(10 * MIN, 300)], events: [], window: 'seven_day' });
    assert.equal(result.burn_rate_per_min, 10);
  });

  it('is 0 without recent usage', () => {
    assert.equal(forecastBudget({ now: NOW, usage: [use(HOUR, 500)], events: [], window: 'five_hour' }).burn_rate_per_min, 0);
  });
});

describe('forecastBudget: limit and ETA', () => {
  it('without a rejected hit or SDK utilisation: forecast null, but usage and burn rate are delivered', () => {
    const result = forecastBudget({
      now: NOW, usage: [use(HOUR, 600), use(10 * MIN, 300)],
      events: [ev(HOUR, 'five_hour', { status: 'allowed', resetsAt: unix(2 * HOUR) }), ev(30 * MIN, 'five_hour', { status: 'allowed_warning' })],
      window: 'five_hour',
    });
    assert.equal(result.forecast, null);
    assert.equal(result.alert, false);
    assert.equal(result.used_tokens, 900);
    assert.equal(result.burn_rate_per_min, 10);
  });

  it('calibrates the limit as the usage in the window at the time of the rejected hit', () => {
    // At the hit (now - 3h) the five-hour window held 500 + 700 = 1200 tokens; the token before that is out of the window.
    const usage = [use(9 * HOUR, 9999), use(3 * HOUR + 4 * HOUR, 0), use(4 * HOUR + 30 * MIN, 500), use(3 * HOUR + 10 * MIN, 700), use(20 * MIN, 600)];
    const events = [ev(3 * HOUR, 'five_hour', { status: 'rejected' }), ev(10 * MIN, 'five_hour', { status: 'allowed', resetsAt: unix(3 * HOUR) })];
    const result = forecastBudget({ now: NOW, usage, events, window: 'five_hour' });
    assert.equal(result.forecast?.limit_tokens, 1200 + 0);
    assert.equal(result.forecast?.limit_source, 'calibrated');
    // used now: 700 (3h10 ago) + 600 + 500 (4h30 ago) = 1800 > limit => already exceeded
    assert.equal(result.used_tokens, 1800);
  });

  it('uses the LAST rejected hit of the same type', () => {
    const usage = [use(4 * HOUR, 1000), use(2 * HOUR, 500), use(30 * MIN, 1000)];
    const events = [ev(3 * HOUR, 'five_hour', { status: 'rejected' }), ev(HOUR, 'five_hour', { status: 'rejected' }), ev(10 * MIN, 'five_hour', { status: 'allowed', resetsAt: unix(HOUR) })];
    // hit at now-1h: window (now-6h, now-1h] holds 1000 + 500; the earlier hit at now-3h would give only 1000
    const result = forecastBudget({ now: NOW, usage, events: [...events].reverse(), window: 'five_hour' });
    assert.equal(result.forecast?.limit_tokens, 1500);
  });

  it('computes ETA = now + (limit - used) / burn and sets alert when before the reset', () => {
    // limit 1000 (calibrated at now - 5h30m), used 400 now, burn 10/min (300 in last 30 min) => remaining 600 => 60 min
    const usage = [use(6 * HOUR, 1000), use(2 * HOUR, 100), use(10 * MIN, 300)];
    const events = [ev(5 * HOUR + 30 * MIN, 'five_hour', { status: 'rejected' }), ev(5 * MIN, 'five_hour', { status: 'allowed', resetsAt: unix(2 * HOUR) })];
    const result = forecastBudget({ now: NOW, usage, events, window: 'five_hour' });
    assert.equal(result.used_tokens, 400);
    assert.equal(result.burn_rate_per_min, 10);
    assert.equal(result.forecast?.limit_tokens, 1000);
    assert.equal(result.forecast?.eta, iso(60 * MIN));
    assert.equal(result.resets_at, iso(2 * HOUR));
    assert.equal(result.alert, true);
  });

  it('ETA after the reset is null and there is no alert (limit still reported)', () => {
    const usage = [use(6 * HOUR, 1000), use(2 * HOUR, 100), use(10 * MIN, 300)];
    const events = [ev(5 * HOUR + 30 * MIN, 'five_hour', { status: 'rejected' }), ev(5 * MIN, 'five_hour', { status: 'allowed', resetsAt: unix(30 * MIN) })];
    const result = forecastBudget({ now: NOW, usage, events, window: 'five_hour' });
    assert.equal(result.forecast?.limit_tokens, 1000);
    assert.equal(result.forecast?.eta, null);
    assert.equal(result.alert, false);
    assert.equal(result.resets_at, iso(30 * MIN));
  });

  it('without a reset time there is no ETA and no alert', () => {
    const usage = [use(6 * HOUR, 1000), use(10 * MIN, 300)];
    const result = forecastBudget({ now: NOW, usage, events: [ev(5 * HOUR + 30 * MIN, 'five_hour', { status: 'rejected' })], window: 'five_hour' });
    assert.equal(result.forecast?.eta, null);
    assert.equal(result.alert, false);
  });

  it('burn rate 0 never divides by zero: ETA null, no alert', () => {
    const usage = [use(6 * HOUR, 1000), use(2 * HOUR, 100)];
    const events = [ev(5 * HOUR + 30 * MIN, 'five_hour', { status: 'rejected', resetsAt: unix(2 * HOUR) })];
    const result = forecastBudget({ now: NOW, usage, events, window: 'five_hour' });
    assert.equal(result.burn_rate_per_min, 0);
    assert.equal(result.forecast?.eta, null);
    assert.equal(result.alert, false);
  });

  it('usage above the limit never yields a negative / past ETA', () => {
    const usage = [use(6 * HOUR, 100), use(10 * MIN, 600)];
    const events = [ev(5 * HOUR + 30 * MIN, 'five_hour', { status: 'rejected', resetsAt: unix(2 * HOUR) })];
    const result = forecastBudget({ now: NOW, usage, events, window: 'five_hour' });
    const eta = result.forecast?.eta;
    if (eta != null) assert.ok(Date.parse(eta) >= NOW.getTime(), 'eta is not in the past');
    assert.equal(result.alert, eta != null);
  });

  it('alert is true exactly when the ETA is set', () => {
    const usage = [use(6 * HOUR, 1000), use(10 * MIN, 300)];
    for (const resetMin of [10, 40, 59, 61, 120, 600]) {
      const events = [ev(5 * HOUR + 30 * MIN, 'five_hour', { status: 'rejected', resetsAt: unix(resetMin * MIN) })];
      const result = forecastBudget({ now: NOW, usage, events, window: 'five_hour' });
      assert.equal(result.alert, result.forecast?.eta != null, `reset in ${resetMin} min`);
    }
  });

  it('only events of the same rateLimitType count (seven_day hit does not calibrate five_hour)', () => {
    const usage = [use(6 * HOUR, 1000), use(10 * MIN, 300)];
    const events = [ev(5 * HOUR, 'seven_day', { status: 'rejected', resetsAt: unix(DAY) })];
    assert.equal(forecastBudget({ now: NOW, usage, events, window: 'five_hour' }).forecast, null);
    assert.equal(forecastBudget({ now: NOW, usage, events, window: 'seven_day' }).forecast?.limit_tokens, 1000);
  });

  it('works for the seven_day window with its own reset', () => {
    const usage = [use(6 * DAY, 10000), use(2 * DAY, 1000), use(10 * MIN, 600)];
    const events = [ev(5 * DAY + 12 * HOUR, 'seven_day', { status: 'rejected', resetsAt: unix(3 * DAY) })];
    const result = forecastBudget({ now: NOW, usage, events, window: 'seven_day' });
    // hit window (now-12.5d, now-5.5d] holds 10000
    assert.equal(result.forecast?.limit_tokens, 10000);
    assert.equal(result.used_tokens, 11600);
    assert.equal(result.resets_at, iso(3 * DAY));
    assert.equal(result.forecast?.eta, iso(0), 'usage is already above the limit, so the limit is reached before the reset');
    assert.equal(result.alert, true);
  });

  it('ignores the SDK utilisation when absent or unusable and falls back to calibration', () => {
    const usage = [use(6 * HOUR, 1000), use(10 * MIN, 300)];
    for (const utilization of [0, 1.5, -1, 'x', null]) {
      const events = [ev(5 * HOUR + 30 * MIN, 'five_hour', { status: 'rejected', utilization, resetsAt: unix(HOUR * 3) })];
      const result = forecastBudget({ now: NOW, usage, events, window: 'five_hour' });
      assert.equal(result.forecast?.limit_source, 'calibrated', `utilization ${String(utilization)}`);
      assert.equal(result.forecast?.limit_tokens, 1000);
    }
  });

  it('prefers the SDK utilisation when the event carries it', () => {
    const usage = [use(HOUR, 400), use(10 * MIN, 300)];
    const events = [ev(5 * MIN, 'five_hour', { status: 'allowed_warning', utilization: 0.5, resetsAt: unix(5 * HOUR) })];
    const result = forecastBudget({ now: NOW, usage, events, window: 'five_hour' });
    assert.equal(result.forecast?.limit_source, 'sdk');
    // usage at the event time: 700 (the 5 min old event is after both uses) => limit 1400
    assert.equal(result.forecast?.limit_tokens, 1400);
  });
});

describe('budgetReport and budgetAlerts', () => {
  it('report has five_hour, seven_day and generated_at', () => {
    const report = budgetReport({ now: NOW, usage: [use(MIN, 10, 'developer')], events: [] });
    assert.deepEqual(Object.keys(report).sort(), ['five_hour', 'generated_at', 'seven_day']);
    assert.equal(report.generated_at, NOW.toISOString());
    assert.equal(report.five_hour.window, 'five_hour');
    assert.deepEqual(report.seven_day.by_role, { developer: 10 });
  });

  it('alerts list only windows with an alert', () => {
    const usage = [use(6 * HOUR, 1000), use(10 * MIN, 300)];
    const events = [ev(5 * HOUR + 30 * MIN, 'five_hour', { status: 'rejected', resetsAt: unix(2 * HOUR) })];
    const alerts = budgetAlerts(budgetReport({ now: NOW, usage, events }));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.window, 'five_hour');
    assert.deepEqual(budgetAlerts(budgetReport({ now: NOW, usage, events: [] })), []);
  });
});

function raw(port: number, method: string, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function buildOrchestrator(options: { history: boolean; events: boolean }) {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
  const logDir = tempDir();
  const clock = new ManualClock();
  clock.wall = NOW.getTime();
  let history: HistoryLog | undefined;
  if (options.history) {
    history = new HistoryLog(path.join(dir, 'repositories'), new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent()), Logger.silent());
    const finish = (at: Date, tokens: number, role: string) =>
      history!.runFinished({
        repo: 'acme/app', issue: 'acme/app#1', title: 'T', run: `r${at.getTime()}`, session: null, attempt: null, outcome: 'handed_off',
        state: 'In review', reason: 'done', turns: 1, startedAt: at, finishedAt: at, agentSeconds: 1, role,
        usage: { m: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }, claudeEstimateUsd: null,
      });
    finish(ago(6 * HOUR), 1000, 'developer');
    finish(ago(2 * HOUR), 100, 'reviewer');
    finish(ago(10 * MIN), 300, 'developer');
  }
  if (options.events) {
    fs.mkdirSync(path.join(logDir, 'budget'));
    const lines = [ev(5 * HOUR + 30 * MIN, 'five_hour', { status: 'rejected' }), ev(5 * MIN, 'five_hour', { status: 'allowed', resetsAt: unix(2 * HOUR) })];
    fs.writeFileSync(path.join(logDir, 'budget', 'rate-limits.jsonl'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  }
  return new Orchestrator({
    workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))), runner: new FakeRunner(), logger: Logger.silent(), env: {},
    logDir, history, clock, timers: new ManualTimers(), createAdapter: () => new FakeTracker(),
  });
}

describe('GET /api/v1/budget with history and rate-limit events', () => {
  let server: HttpServerHandle;
  let orchestrator: Orchestrator;

  before(async () => {
    orchestrator = buildOrchestrator({ history: true, events: true });
    server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
  });
  after(async () => {
    await server.close();
  });

  it('answers 200 with usage per window, by_role, forecast, alert and generated_at', async () => {
    const res = await raw(server.port, 'GET', '/api/v1/budget');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(Object.keys(body).sort(), ['five_hour', 'generated_at', 'seven_day']);
    assert.equal(body.generated_at, NOW.toISOString());
    assert.equal(body.five_hour.used_tokens, 400);
    assert.equal(body.five_hour.burn_rate_per_min, 10);
    assert.deepEqual(body.five_hour.by_role, { developer: 300, reviewer: 100 });
    assert.equal(body.five_hour.forecast.limit_tokens, 1000);
    assert.equal(typeof body.five_hour.forecast.eta, 'string');
    assert.equal(body.five_hour.alert, true);
    assert.equal(body.five_hour.resets_at, iso(2 * HOUR));
    assert.equal(body.seven_day.used_tokens, 1400);
    assert.deepEqual(body.seven_day.by_role, { developer: 1300, reviewer: 100 });
    assert.equal(body.seven_day.forecast, null);
    assert.equal(body.seven_day.alert, false);
  });

  it('the orchestrator provides the alert for the dashboard', () => {
    const alerts = orchestrator.budgetAlerts();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.window, 'five_hour');
  });

  it('rejects methods other than GET with 405', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      assert.equal((await raw(server.port, method, '/api/v1/budget')).status, 405, method);
    }
  });
});

describe('GET /api/v1/budget without history and events', () => {
  let server: HttpServerHandle;

  before(async () => {
    server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator: buildOrchestrator({ history: false, events: false }), logger: Logger.silent() });
  });
  after(async () => {
    await server.close();
  });

  it('answers 200 with empty values instead of an error', async () => {
    const res = await raw(server.port, 'GET', '/api/v1/budget');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    for (const window of ['five_hour', 'seven_day']) {
      assert.equal(body[window].used_tokens, 0);
      assert.equal(body[window].forecast, null);
      assert.equal(body[window].alert, false);
      assert.deepEqual(body[window].by_role, {});
    }
  });
});
