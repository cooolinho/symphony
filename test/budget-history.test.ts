import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PricingStore } from '../src/costs/pricing.ts';
import { computeAnalytics, type AnalyticsFilter } from '../src/history/analytics.ts';
import { HistoryLog, readHistory } from '../src/history/history.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { startHttpServer, type HttpServerHandle } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, renderPage, tempDir, until } from './helpers.ts';
import { analyticsFixture, entriesFixture } from './helpers/page-fixtures.ts';

// E9-2 (#371): independent edge-case tests for the budget history (computation, API, page).
const PER_RUN = 1000 + 2000 + 100_000 + 10_000;
const usage = { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 100_000, cacheWriteTokens: 10_000 };
const NOW = new Date('2026-10-20T00:00:00Z');

function setup() {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
  const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
  return { dir, pricing, log: new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent()) };
}
const finish = (issue: string, run: string, at: string, over: Record<string, unknown> = {}) => ({
  repo: 'acme/app', issue, title: `T ${issue}`, run, session: null, attempt: null, outcome: 'handed_off' as const, state: 'In review', reason: 'done',
  turns: 1, startedAt: new Date(new Date(at).getTime() - 60_000), finishedAt: new Date(at), agentSeconds: 60, usage: { 'claude-opus-5-5': usage }, claudeEstimateUsd: null, ...over,
});
const filter = (over: Partial<AnalyticsFilter> = {}): AnalyticsFilter => ({ from: null, to: null, repo: null, model: null, timeZone: 'UTC', ...over });
const event = (at: string, status: unknown = 'rejected') => ({ at, run_id: 'x', issue: 'acme/app#1', role: 'developer', model: null, rate_limit_info: { status, rateLimitType: 'five_hour' } });
const period = (from: string, to: string, over: Partial<AnalyticsFilter> = {}) => filter({ from: new Date(from), to: new Date(to), ...over });

function analyze(runs: Array<[string, string, Record<string, unknown>?]>, events: unknown[], f: AnalyticsFilter) {
  const h = setup();
  for (const [issue, at, over] of runs) h.log.runFinished(finish(issue, `r-${at}`, at, over));
  return computeAnalytics(readHistory(h.log.dir, null).entries, h.pricing.current(), f, NOW, events as never);
}
const peaks = (a: ReturnType<typeof analyze>) => Object.fromEntries(a.budget.days.map((d) => [d.date, d.peak_5h_tokens]));

describe('budget history: computation', () => {
  it('excludes a run exactly 5 hours back from the window, includes one just inside', () => {
    const edge = analyze([['acme/app#1', '2026-10-03T08:00:00Z'], ['acme/app#1', '2026-10-03T13:00:00Z']], [], period('2026-10-03T00:00:00Z', '2026-10-04T00:00:00Z'));
    assert.equal(edge.budget.days[0]!.peak_5h_tokens, PER_RUN);
    const inside = analyze([['acme/app#1', '2026-10-03T08:00:00Z'], ['acme/app#1', '2026-10-03T12:59:00Z']], [], period('2026-10-03T00:00:00Z', '2026-10-04T00:00:00Z'));
    assert.equal(inside.budget.days[0]!.peak_5h_tokens, 2 * PER_RUN);
  });

  it('takes the highest window of the day, not the day total', () => {
    const a = analyze(
      [['acme/app#1', '2026-10-03T01:00:00Z'], ['acme/app#1', '2026-10-03T02:00:00Z'], ['acme/app#1', '2026-10-03T03:00:00Z'], ['acme/app#1', '2026-10-03T20:00:00Z']],
      [], period('2026-10-03T00:00:00Z', '2026-10-04T00:00:00Z'),
    );
    assert.equal(a.budget.days[0]!.peak_5h_tokens, 3 * PER_RUN);
  });

  it('lets a window reach across midnight and across the start of the period', () => {
    const a = analyze([['acme/app#1', '2026-10-03T22:00:00Z'], ['acme/app#1', '2026-10-04T01:00:00Z']], [], period('2026-10-03T00:00:00Z', '2026-10-05T00:00:00Z'));
    assert.deepEqual(peaks(a), { '2026-10-03': PER_RUN, '2026-10-04': 2 * PER_RUN });
    const cut = analyze([['acme/app#1', '2026-10-03T22:00:00Z'], ['acme/app#1', '2026-10-04T01:00:00Z']], [], period('2026-10-04T00:00:00Z', '2026-10-05T00:00:00Z'));
    assert.deepEqual(peaks(cut), { '2026-10-04': 2 * PER_RUN });
  });

  it('lists every day of the period, days without usage with 0 peak and 0 hits', () => {
    const a = analyze([['acme/app#1', '2026-10-01T10:00:00Z'], ['acme/app#1', '2026-10-05T10:00:00Z']], [], period('2026-10-01T00:00:00Z', '2026-10-06T00:00:00Z'));
    assert.deepEqual(a.budget.days.map((d) => d.date), ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
    assert.deepEqual(a.budget.days[2], { date: '2026-10-03', peak_5h_tokens: 0, limit_hits: 0 });
  });

  it('counts only rejected events inside the period, per day, and survives odd event payloads', () => {
    const events = [
      event('2026-10-02T10:00:00Z'), event('2026-10-02T23:59:59Z'), event('2026-10-03T00:00:01Z'),
      event('2026-10-02T11:00:00Z', 'allowed'), event('2026-10-02T12:00:00Z', 'allowed_warning'),
      event('2026-09-30T10:00:00Z'), event('2026-10-09T10:00:00Z'),
      { ...event('2026-10-02T13:00:00Z'), rate_limit_info: null }, { ...event('2026-10-02T13:00:00Z'), rate_limit_info: 'rejected' },
    ];
    const a = analyze([['acme/app#1', '2026-10-02T09:00:00Z']], events, period('2026-10-01T00:00:00Z', '2026-10-04T00:00:00Z'));
    assert.deepEqual(a.budget.days.map((d) => [d.date, d.limit_hits]), [['2026-10-01', 0], ['2026-10-02', 2], ['2026-10-03', 1]]);
  });

  it('shows a hit on a day without any run', () => {
    const a = analyze([['acme/app#1', '2026-10-01T09:00:00Z']], [event('2026-10-02T09:00:00Z')], period('2026-10-01T00:00:00Z', '2026-10-03T00:00:00Z'));
    assert.deepEqual(a.budget.days[1], { date: '2026-10-02', peak_5h_tokens: 0, limit_hits: 1 });
  });

  it('assigns days in the time zone of the filter', () => {
    const at = '2026-10-03T22:30:00Z'; // 2026-10-04 00:30 in Berlin (CEST)
    const berlin = analyze([['acme/app#1', at]], [event(at)], period('2026-10-03T22:00:00Z', '2026-10-05T22:00:00Z', { timeZone: 'Europe/Berlin' }));
    const day = berlin.budget.days.find((d) => d.date === '2026-10-04')!;
    assert.deepEqual(day, { date: '2026-10-04', peak_5h_tokens: PER_RUN, limit_hits: 1 });
    assert.ok(!berlin.budget.days.some((d) => d.date === '2026-10-03' && (d.peak_5h_tokens > 0 || d.limit_hits > 0)));
    const utc = analyze([['acme/app#1', at]], [event(at)], period('2026-10-03T00:00:00Z', '2026-10-05T00:00:00Z'));
    assert.deepEqual(utc.budget.days.find((d) => d.date === '2026-10-03'), { date: '2026-10-03', peak_5h_tokens: PER_RUN, limit_hits: 1 });
  });

  it('applies the repository filter to the tokens but not to the account-wide limit hits', () => {
    const runs: Array<[string, string, Record<string, unknown>?]> = [
      ['acme/app#1', '2026-10-03T10:00:00Z'], ['other/repo#2', '2026-10-03T11:00:00Z', { repo: 'other/repo' }],
    ];
    const events = [event('2026-10-03T11:30:00Z')];
    const all = analyze(runs, events, period('2026-10-03T00:00:00Z', '2026-10-04T00:00:00Z'));
    const one = analyze(runs, events, period('2026-10-03T00:00:00Z', '2026-10-04T00:00:00Z', { repo: 'acme/app' }));
    assert.deepEqual(all.budget.days, [{ date: '2026-10-03', peak_5h_tokens: 2 * PER_RUN, limit_hits: 1 }]);
    assert.deepEqual(one.budget.days, [{ date: '2026-10-03', peak_5h_tokens: PER_RUN, limit_hits: 1 }]);
  });

  it('sums compacts and averages context per role over runs in the period only', () => {
    const a = analyze(
      [
        ['acme/app#1', '2026-10-03T10:00:00Z', { role: 'developer', contextPeakPercent: 50, contextCompacts: 2 }],
        ['acme/app#1', '2026-10-03T20:00:00Z', { role: 'developer', contextPeakPercent: 80, contextCompacts: 1 }],
        ['acme/app#2', '2026-10-03T21:00:00Z', { role: 'developer' }], // old run without context fields: neither 0 % nor a count
        ['acme/app#3', '2026-10-03T22:00:00Z', { role: 'tester' }],
        ['acme/app#4', '2026-09-20T10:00:00Z', { role: 'developer', contextPeakPercent: 99, contextCompacts: 9 }], // before the period
      ],
      [], period('2026-10-03T00:00:00Z', '2026-10-04T00:00:00Z'),
    );
    assert.deepEqual(a.budget.compacts_by_role, { developer: 3 });
    assert.deepEqual(a.budget.avg_context_by_role, { developer: 65 });
    assert.ok(!('tester' in a.budget.avg_context_by_role), 'a role without data has no 0 %');
  });

  it('has an empty budget for history without any context field and without events', () => {
    const a = analyze([['acme/app#1', '2026-10-03T10:00:00Z', { role: 'developer' }]], [], period('2026-10-03T00:00:00Z', '2026-10-04T00:00:00Z'));
    assert.deepEqual(a.budget.compacts_by_role, {});
    assert.deepEqual(a.budget.avg_context_by_role, {});
    assert.deepEqual(a.budget.days, [{ date: '2026-10-03', peak_5h_tokens: PER_RUN, limit_hits: 0 }]);
  });
});

describe('budget history: API and cache', () => {
  let server: HttpServerHandle;
  let limitFile: string;
  const get = (url: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.port, path: url }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
  const hour = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const analytics = async () => {
    // Bounded period (cached); ends in the future so the events lie inside it.
    const res = await get(`/api/v1/history/analytics?from=${encodeURIComponent(hour(-48))}&to=${encodeURIComponent(hour(24))}`);
    assert.equal(res.status, 200);
    return JSON.parse(res.body) as { budget: { days: Array<{ date: string; limit_hits: number }> } };
  };
  const hits = (a: Awaited<ReturnType<typeof analytics>>) => a.budget.days.reduce((n, d) => n + d.limit_hits, 0);

  before(async () => {
    const h = setup();
    h.log.runFinished(finish('acme/app#1', 'r1', hour(-3), { role: 'developer', contextPeakPercent: 42, contextCompacts: 2 }));
    const logDir = tempDir();
    fs.mkdirSync(path.join(logDir, 'budget'));
    limitFile = path.join(logDir, 'budget', 'rate-limits.jsonl');
    fs.writeFileSync(limitFile, `${JSON.stringify(event(hour(-2)))}\n`);
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))), runner: new FakeRunner(), logger: Logger.silent(), env: {}, logDir,
      timers: new ManualTimers(), createAdapter: () => new FakeTracker(),
    });
    server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent(), history: { dir: h.log.dir, pricing: h.pricing } });
  });
  after(async () => { await server.close(); });

  it('serves budget with days, compacts and context from the history and the rate-limit log', async () => {
    const a = await analytics();
    assert.equal(hits(a), 1);
    const raw = JSON.parse((await get(`/api/v1/history/analytics?from=${encodeURIComponent(hour(-48))}&to=${encodeURIComponent(hour(24))}`)).body);
    assert.deepEqual(Object.keys(raw.budget).sort(), ['avg_context_by_role', 'compacts_by_role', 'days']);
    assert.deepEqual(Object.keys(raw.budget.days[0]).sort(), ['date', 'limit_hits', 'peak_5h_tokens']);
    assert.deepEqual(raw.budget.compacts_by_role, { developer: 2 });
    assert.deepEqual(raw.budget.avg_context_by_role, { developer: 42 });
    assert.ok(raw.budget.days.some((d: { peak_5h_tokens: number }) => d.peak_5h_tokens === PER_RUN));
  });

  it('does not serve stale hits from the cache after a new rate-limit event', async () => {
    const before = hits(await analytics());
    fs.appendFileSync(limitFile, `${JSON.stringify(event(hour(-1)))}\n`);
    assert.equal(hits(await analytics()), before + 1);
  });
});

describe('budget history: page', () => {
  const base = analyticsFixture().by_role[0];
  const load = async (budget: object | undefined, roles: object[]) => {
    const over: Record<string, unknown> = { by_role: roles };
    if (budget !== undefined) over.budget = budget;
    const page = renderPage(LOGS_HTML, undefined, {
      url: 'http://127.0.0.1/stats',
      fetch: (url: string) => (url.startsWith('/api/v1/history/entries') ? entriesFixture() : analyticsFixture(over)),
    });
    await until(() => page.$('log-count').textContent === '1' && page.query('[data-body="kpi"] .ui-kpi').length > 0, 3000, 'the page to load');
    return page;
  };
  const contextOf = (page: Awaited<ReturnType<typeof load>>, role: string) => {
    const col = page.query('#roles-table th').findIndex((th) => th.textContent === 'Ø Context');
    assert.ok(col >= 0);
    const row = page.query('#roles-table tr').find((tr) => tr.children[0]?.textContent.includes(role));
    assert.ok(row, `row ${role}`);
    return row.children[col]!.textContent;
  };

  it('marks exactly the days with limit hits, none when there are no hits', async () => {
    const days = [0, 1, 2, 3].map((i) => ({ date: `2026-10-0${i + 1}`, peak_5h_tokens: 1000 * (i + 1), limit_hits: i === 0 || i === 2 ? 2 : 0 }));
    const page = await load({ days, compacts_by_role: {}, avg_context_by_role: {} }, [{ ...base, role: 'developer' }]);
    assert.deepEqual(page.query('[data-body="budget"] [data-mark]').map((m) => m.getAttribute('data-mark')), ['0', '2']);
    const clean = await load({ days: days.map((d) => ({ ...d, limit_hits: 0 })), compacts_by_role: {}, avg_context_by_role: {} }, [{ ...base, role: 'developer' }]);
    assert.equal(clean.query('[data-body="budget"] [data-mark]').length, 0);
    assert.equal(clean.query('[data-body="budget"] svg').length > 0, true);
  });

  it('shows hits even when no tokens were used (marked day, no empty state)', async () => {
    const page = await load({ days: [{ date: '2026-10-01', peak_5h_tokens: 0, limit_hits: 1 }], compacts_by_role: {}, avg_context_by_role: {} }, [{ ...base, role: 'developer' }]);
    assert.equal(page.query('[data-body="budget"] [data-mark]').length, 1);
  });

  it('draws one compacts bar per role, including a role with 0 compacts', async () => {
    const page = await load({ days: [], compacts_by_role: { developer: 4, reviewer: 0 }, avg_context_by_role: {} }, [{ ...base, role: 'developer' }]);
    const bars = page.query('[data-body="compacts"] .hbar');
    assert.equal(bars.length, 2);
    assert.ok(bars[0]!.textContent.includes('developer') && bars[0]!.textContent.includes('4'));
    assert.ok(bars[1]!.textContent.includes('reviewer'));
    assert.match(bars[1]!.querySelector('.fill')!.style.getPropertyValue('--sw'), /var\(--role-reviewer\)/);
  });

  it('shows Ø Context per role with a dash only for roles without data', async () => {
    const page = await load({ days: [], compacts_by_role: {}, avg_context_by_role: { developer: 65 } }, [{ ...base, role: 'developer' }, { ...base, role: 'tester' }]);
    assert.equal(contextOf(page, 'developer'), '65%');
    assert.equal(contextOf(page, 'tester'), '—');
  });

  it('survives budget with null/missing parts without an error', async () => {
    const page = await load({ days: [], compacts_by_role: {}, avg_context_by_role: {} }, [{ ...base, role: 'developer' }]);
    assert.ok(page.query('[data-body="budget"]')[0]!.textContent.includes('KEINE DATEN'));
    assert.ok(page.query('[data-body="compacts"]')[0]!.textContent.includes('KEINE DATEN'));
    assert.equal(contextOf(page, 'developer'), '—');
  });
});
