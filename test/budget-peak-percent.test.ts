import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PricingStore } from '../src/costs/pricing.ts';
import { computeAnalytics, type AnalyticsFilter } from '../src/history/analytics.ts';
import { HistoryLog, readHistory } from '../src/history/history.ts';
import { startHttpServer, type HttpServerHandle } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, tempDir } from './helpers.ts';

// E4-11 (#468): independent tests for the daily SDK peak (peak_5h_percent) and peak_source, derived from the issue.
const PER_RUN = 1000 + 2000 + 100_000 + 10_000;
const usage = { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 100_000, cacheWriteTokens: 10_000 };
const NOW = new Date('2026-10-20T00:00:00Z');

function setup() {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
  const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
  return { dir, pricing, log: new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent()) };
}
const finish = (issue: string, at: string, over: Record<string, unknown> = {}) => ({
  repo: 'acme/app', issue, title: `T ${issue}`, run: `r-${issue}-${at}`, session: null, attempt: null, outcome: 'handed_off' as const, state: 'In review', reason: 'done',
  turns: 1, startedAt: new Date(new Date(at).getTime() - 60_000), finishedAt: new Date(at), agentSeconds: 60, usage: { 'claude-opus-5-5': usage }, claudeEstimateUsd: null, ...over,
});
const filter = (over: Partial<AnalyticsFilter> = {}): AnalyticsFilter => ({ from: null, to: null, repo: null, model: null, timeZone: 'UTC', ...over });
const period = (from: string, to: string, over: Partial<AnalyticsFilter> = {}) => filter({ from: new Date(from), to: new Date(to), ...over });
const ev = (at: unknown, info: unknown) => ({ at, run_id: 'x', issue: 'acme/app#1', role: 'developer', model: null, rate_limit_info: info });
const win = (at: string, utilization: unknown, type = 'five_hour', status = 'allowed') =>
  ev(at, { status, rateLimitType: type, unifiedWindows: { five_hour: { utilization } } });

function analyze(runs: Array<[string, string, Record<string, unknown>?]>, events: unknown[], f: AnalyticsFilter) {
  const h = setup();
  for (const [issue, at, over] of runs) h.log.runFinished(finish(issue, at, over));
  return computeAnalytics(readHistory(h.log.dir, null).entries, h.pricing.current(), f, NOW, events as never);
}
const percents = (a: ReturnType<typeof analyze>) => Object.fromEntries(a.budget.days.map((d) => [d.date, d.peak_5h_percent]));
const P = period('2026-10-03T00:00:00Z', '2026-10-06T00:00:00Z');

describe('budget peak percent: daily maximum', () => {
  it('takes the maximum regardless of the event order', () => {
    const asc = analyze([], [win('2026-10-03T08:00:00Z', 0.72), win('2026-10-03T09:00:00Z', 0.9)], P);
    const desc = analyze([], [win('2026-10-03T09:00:00Z', 0.9), win('2026-10-03T08:00:00Z', 0.72)], P);
    assert.equal(asc.budget.days[0]!.peak_5h_percent, 90);
    assert.equal(desc.budget.days[0]!.peak_5h_percent, 90);
  });

  it('keeps separate maxima per day', () => {
    const a = analyze([], [win('2026-10-03T08:00:00Z', 0.2), win('2026-10-04T08:00:00Z', 0.6), win('2026-10-04T09:00:00Z', 0.5)], P);
    assert.deepEqual(percents(a), { '2026-10-03': 20, '2026-10-04': 60, '2026-10-05': null });
  });

  it('counts the five_hour window of a seven_day event (0.3 gives exactly 30)', () => {
    const a = analyze([], [win('2026-10-03T08:00:00Z', 0.3, 'seven_day')], P);
    assert.equal(a.budget.days[0]!.peak_5h_percent, 30);
  });

  it('falls back to the top-level utilization of a five_hour event without unifiedWindows', () => {
    const a = analyze([], [ev('2026-10-03T08:00:00Z', { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.55 })], P);
    assert.equal(a.budget.days[0]!.peak_5h_percent, 55);
  });

  it('prefers unifiedWindows.five_hour over the top-level value', () => {
    const a = analyze([], [ev('2026-10-03T08:00:00Z', { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.1, unifiedWindows: { five_hour: { utilization: 0.4 } } })], P);
    assert.equal(a.budget.days[0]!.peak_5h_percent, 40);
  });

  it('ignores the top-level utilization of a seven_day event without unifiedWindows', () => {
    const a = analyze([], [ev('2026-10-03T08:00:00Z', { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.5 })], P);
    assert.equal(a.budget.days[0]!.peak_5h_percent, null);
    assert.equal(a.budget_insights.peak_source, 'tokens');
  });

  it('keeps values above 100 (1.01 gives 101, 1.5 gives 150)', () => {
    const a = analyze([], [win('2026-10-03T08:00:00Z', 1.01, 'five_hour', 'rejected'), win('2026-10-04T08:00:00Z', 1.5)], P);
    assert.equal(a.budget.days[0]!.peak_5h_percent, 101);
    assert.equal(a.budget.days[1]!.peak_5h_percent, 150);
  });

  it('reports 0 for a utilization of 0, not null', () => {
    const a = analyze([], [win('2026-10-03T08:00:00Z', 0)], P);
    assert.equal(a.budget.days[0]!.peak_5h_percent, 0);
    assert.equal(a.budget_insights.peak_source, 'sdk');
  });

  it('keeps null and the old token peak on a day without an event', () => {
    const a = analyze([['acme/app#1', '2026-10-04T10:00:00Z']], [win('2026-10-03T08:00:00Z', 0.5)], P);
    assert.equal(a.budget.days[1]!.peak_5h_percent, null);
    assert.equal(a.budget.days[1]!.peak_5h_tokens, PER_RUN);
    assert.equal(a.budget.days[1]!.limit_hits, 0);
  });

  it('counts a rejected five_hour event as a hit and as at least 100 %', () => {
    const a = analyze([], [ev('2026-10-03T08:00:00Z', { status: 'rejected', rateLimitType: 'five_hour' })], P);
    assert.equal(a.budget.days[0]!.limit_hits, 1);
    assert.ok((a.budget.days[0]!.peak_5h_percent ?? 0) >= 100);
  });

  it('does not count a non-rejected event as a limit hit although it carries a percent', () => {
    const a = analyze([], [win('2026-10-03T08:00:00Z', 0.8)], P);
    assert.equal(a.budget.days[0]!.limit_hits, 0);
    assert.equal(a.budget.days[0]!.peak_5h_percent, 80);
  });

  it('ignores events outside the period and with unusable payloads without throwing', () => {
    const a = analyze([], [
      win('2026-10-02T23:59:59Z', 0.9), win('2026-10-06T00:00:00Z', 0.9), win('not a date', 0.9), ev(null, {}),
      win('2026-10-03T08:00:00Z', 'high'), win('2026-10-03T08:00:00Z', -0.5), win('2026-10-03T08:00:00Z', null),
      ev('2026-10-03T08:00:00Z', null), ev('2026-10-03T08:00:00Z', 'oops'), ev('2026-10-03T08:00:00Z', []), ev('2026-10-03T08:00:00Z', { unifiedWindows: 5 }),
    ], P);
    assert.deepEqual(percents(a), { '2026-10-03': null, '2026-10-04': null, '2026-10-05': null });
    assert.equal(a.budget_insights.peak_source, 'tokens');
  });

  it('puts the event into the day of the filter time zone (day boundary, both directions)', () => {
    const at = '2026-10-03T22:30:00Z'; // 2026-10-04 00:30 in Berlin
    const berlin = analyze([], [win(at, 0.5)], period('2026-10-03T00:00:00Z', '2026-10-06T00:00:00Z', { timeZone: 'Europe/Berlin' }));
    assert.equal(berlin.budget.days.find((d) => d.date === '2026-10-04')!.peak_5h_percent, 50);
    assert.equal(berlin.budget.days.find((d) => d.date === '2026-10-03')!.peak_5h_percent, null);
    const la = analyze([], [win('2026-10-04T03:00:00Z', 0.5)], period('2026-10-03T00:00:00Z', '2026-10-06T00:00:00Z', { timeZone: 'America/Los_Angeles' }));
    assert.equal(la.budget.days.find((d) => d.date === '2026-10-03')!.peak_5h_percent, 50);
    assert.equal(la.budget.days.find((d) => d.date === '2026-10-04')!.peak_5h_percent, null);
  });

  it('works for an open period (no from) as well', () => {
    const a = analyze([['acme/app#1', '2026-10-03T10:00:00Z']], [win('2026-10-03T11:00:00Z', 0.35)], filter());
    assert.equal(a.budget.days.find((d) => d.date === '2026-10-03')!.peak_5h_percent, 35);
    assert.equal(a.budget_insights.peak_source, 'sdk');
  });
});

describe('budget peak percent: account-wide and peak_source', () => {
  const runs: Array<[string, string, Record<string, unknown>?]> = [['acme/app#1', '2026-10-03T10:00:00Z'], ['other/repo#2', '2026-10-03T11:00:00Z', { repo: 'other/repo' }]];
  const f = period('2026-10-03T00:00:00Z', '2026-10-04T00:00:00Z');

  it('is not narrowed by the repository filter, while the tokens are', () => {
    const events = [win('2026-10-03T11:30:00Z', 0.8, 'seven_day')];
    const all = analyze(runs, events, f);
    const one = analyze(runs, events, { ...f, repo: 'acme/app' });
    assert.equal(all.budget.days[0]!.peak_5h_percent, 80);
    assert.equal(one.budget.days[0]!.peak_5h_percent, 80);
    assert.equal(all.budget.days[0]!.peak_5h_tokens, 2 * PER_RUN);
    assert.equal(one.budget.days[0]!.peak_5h_tokens, PER_RUN);
    assert.equal(one.budget_insights.peak_source, 'sdk');
  });

  it('is not narrowed by a model filter either', () => {
    const a = analyze(runs, [win('2026-10-03T11:30:00Z', 0.8)], { ...f, model: 'does-not-exist' });
    assert.equal(a.budget.days[0]!.peak_5h_percent, 80);
  });

  it('peak_source is tokens without events and sdk with one SDK day, limit_5h_tokens unchanged', () => {
    const none = analyze(runs, [], f);
    assert.equal(none.budget_insights.peak_source, 'tokens');
    const some = analyze(runs, [win('2026-10-03T11:30:00Z', 0.2)], f);
    assert.equal(some.budget_insights.peak_source, 'sdk');
    assert.equal(some.budget_insights.limit_5h_tokens, none.budget_insights.limit_5h_tokens);
    assert.deepEqual(some.budget_insights.limit_hits, none.budget_insights.limit_hits);
    assert.deepEqual(some.budget_insights.top_compact, none.budget_insights.top_compact);
  });

  it('peak_source follows the period: an SDK event outside it does not count', () => {
    const a = analyze(runs, [win('2026-10-10T11:30:00Z', 0.2)], f);
    assert.equal(a.budget_insights.peak_source, 'tokens');
  });

  it('an SDK-only day leaves the old fields and compacts untouched', () => {
    const base = analyze(runs, [], f);
    const withSdk = analyze(runs, [win('2026-10-03T11:30:00Z', 0.2)], f);
    assert.deepEqual(withSdk.budget.days.map(({ peak_5h_percent, ...rest }) => rest), base.budget.days.map(({ peak_5h_percent, ...rest }) => rest));
    assert.deepEqual(withSdk.budget.compacts_by_role, base.budget.compacts_by_role);
    assert.deepEqual(withSdk.budget.avg_context_by_role, base.budget.avg_context_by_role);
  });
});

describe('budget peak percent: API', () => {
  let server: HttpServerHandle;
  let logDir = '';
  const hour = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const get = (p: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.port, path: p }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
  const analytics = async () => JSON.parse((await get(`/api/v1/history/analytics?from=${encodeURIComponent(hour(-48))}&to=${encodeURIComponent(hour(24))}`)).body);

  before(async () => {
    const h = setup();
    h.log.runFinished(finish('acme/app#1', hour(-3)));
    logDir = tempDir();
    fs.mkdirSync(path.join(logDir, 'budget'));
    fs.writeFileSync(path.join(logDir, 'budget', 'rate-limits.jsonl'), `${JSON.stringify(win(hour(-2), 0.64))}\n`);
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))), runner: new FakeRunner(), logger: Logger.silent(), env: {}, logDir,
      timers: new ManualTimers(), createAdapter: () => new FakeTracker(),
    });
    server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent(), history: { dir: h.log.dir, pricing: h.pricing } });
  });
  after(async () => { await server.close(); });

  it('serves peak_5h_percent per day and peak_source in budget_insights', async () => {
    const raw = await analytics();
    assert.ok(raw.budget.days.every((d: object) => 'peak_5h_percent' in d));
    assert.ok(raw.budget.days.some((d: { peak_5h_percent: number | null }) => d.peak_5h_percent === 64));
    assert.ok(raw.budget.days.some((d: { peak_5h_percent: number | null }) => d.peak_5h_percent === null));
    assert.equal(raw.budget_insights.peak_source, 'sdk');
    assert.ok(['limit_5h_tokens', 'limit_hits', 'top_compact', 'peak_source'].every((k) => k in raw.budget_insights));
  });

  it('picks up a new event after caching', async () => {
    await analytics();
    fs.appendFileSync(path.join(logDir, 'budget', 'rate-limits.jsonl'), `${JSON.stringify(win(hour(-1), 0.77))}\n`);
    const raw = await analytics();
    assert.ok(raw.budget.days.some((d: { peak_5h_percent: number | null }) => d.peak_5h_percent === 77));
  });
});

describe('budget peak percent: documentation', () => {
  it('docs/usage.md describes peak_5h_percent and peak_source', () => {
    const doc = fs.readFileSync(path.join(import.meta.dirname, '..', 'docs', 'usage.md'), 'utf8');
    assert.ok(doc.includes('peak_5h_percent'));
    assert.ok(doc.includes('peak_source'));
    assert.ok(doc.includes('unifiedWindows.five_hour.utilization'));
  });
});
