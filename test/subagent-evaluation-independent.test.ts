import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PricingStore } from '../src/costs/pricing.ts';
import { computeAnalytics, type AnalyticsFilter } from '../src/history/analytics.ts';
import { HistoryLog, readHistory, type HistoryEntry } from '../src/history/history.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { startHttpServer, type HttpServerHandle } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, renderPage, tempDir, until } from './helpers.ts';
import { analyticsFixture, entriesFixture } from './helpers/page-fixtures.ts';

// E0-9 (#490): independent tests of the subagent evaluation, derived from the issue's acceptance criteria.

const PRICES = `
default: { input: 5, output: 25 }
opus: { input: 4, output: 20 }
sonnet: { input: 3, output: 15 }
haiku: { input: 1, output: 5 }
`;
// 1000 + 2000 + 3000 + 4000 billed tokens per run (input + output + cache read + cache write).
const usage = { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 3000, cacheWriteTokens: 4000 };
const PER_RUN = 10_000;
const NOW = new Date('2026-11-01T00:00:00Z');

function history() {
  const dir = tempDir();
  const file = path.join(dir, 'model-costs.yml');
  fs.writeFileSync(file, PRICES);
  const pricing = new PricingStore(file, Logger.silent());
  return { log: new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent()), pricing };
}
type H = ReturnType<typeof history>;

const finish = (repo: string, n: number, run: string, at: string, over: Record<string, unknown> = {}) => ({
  repo,
  issue: `${repo}#${n}`,
  title: `Issue ${n}`,
  run,
  session: 's',
  attempt: null,
  outcome: 'handed_off' as const,
  state: 'In review',
  reason: 'done',
  turns: 1,
  startedAt: new Date(new Date(at).getTime() - 60_000),
  finishedAt: new Date(at),
  agentSeconds: 60,
  usage: { 'claude-opus-5-5': usage },
  claudeEstimateUsd: null,
  ...over,
});
const sub = (tokens: number, type = 'Explore') => ({
  toolUseId: `t-${type}-${tokens}`, subagentType: type, description: 'd', startedAt: new Date('2026-10-20T10:00:00Z'), endedAt: null,
  status: 'ok' as const, tokens: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  contextTokens: null, toolUses: null, durationMs: null, models: ['claude-haiku-4-5'],
});
const stage = (repo: string, n: number, role: string, kind: string, verdict: string, at: string, over: Record<string, unknown> = {}) => ({
  repo, issue: `${repo}#${n}`, run: null, role, kind, verdict, round: null, target: null, profile: 'feature', complexity: null, findings: 0, at: new Date(at), ...over,
});
const filter = (over: Partial<AnalyticsFilter> = {}): AnalyticsFilter => ({ from: null, to: null, repo: null, model: null, timeZone: 'UTC', ...over });
const entriesOf = (h: H) => readHistory(h.log.dir, null).entries;
const evalOf = (h: H, over: Partial<AnalyticsFilter> = {}) => computeAnalytics(entriesOf(h), h.pricing.current(), filter(over), NOW).subagent_evaluation;
const rowOf = (section: ReturnType<typeof evalOf>, role: string, model: string) => {
  const row = section.rows.find((r) => r.role === role && r.model === model);
  assert.ok(row, `row ${role} × ${model}`);
  return row;
};

describe('subagent evaluation (independent)', () => {
  it('delegation rate per role × model: delegating runs, calls per subagent type', () => {
    const h = history();
    // architect on opus: 10 runs, 4 delegating; developer on sonnet: 5 runs, none; developer on opus: 2 of 3.
    for (let i = 1; i <= 10; i += 1) {
      h.log.runFinished(finish('acme/app', i, `a${i}`, '2026-10-21T10:00:00Z', { role: 'architect', agentCalls: i <= 4 ? { Explore: i, Plan: 1 } : undefined }));
    }
    for (let i = 1; i <= 5; i += 1) {
      h.log.runFinished(finish('acme/app', 20 + i, `s${i}`, '2026-10-21T11:00:00Z', { role: 'developer', usage: { 'claude-sonnet-5-5': usage } }));
    }
    h.log.runFinished(finish('acme/app', 40, 'o1', '2026-10-21T12:00:00Z', { role: 'developer', agentCalls: { Explore: 3 } }));
    h.log.runFinished(finish('acme/app', 41, 'o2', '2026-10-21T12:00:00Z', { role: 'developer', agentCalls: { 'symphony:laravel-code-reviewer': 1 } }));
    h.log.runFinished(finish('acme/app', 42, 'o3', '2026-10-21T12:00:00Z', { role: 'developer' }));
    const section = evalOf(h);

    const architect = rowOf(section, 'architect', 'claude-opus-5-5');
    assert.equal(architect.runs, 10);
    assert.equal(architect.runs_with_subagent, 4);
    assert.equal(architect.delegation_rate, 0.4);
    // Explore 1+2+3+4 = 10 calls in 4 runs, Plan 4 calls in 4 runs.
    const explore = architect.agents.find((a) => a.agent === 'Explore');
    const plan = architect.agents.find((a) => a.agent === 'Plan');
    assert.deepEqual([explore?.calls, explore?.runs], [10, 4]);
    assert.deepEqual([plan?.calls, plan?.runs], [4, 4]);

    const sonnet = rowOf(section, 'developer', 'claude-sonnet-5-5');
    assert.equal(sonnet.runs, 5);
    assert.equal(sonnet.runs_with_subagent, 0);
    assert.equal(sonnet.delegation_rate, 0);
    assert.deepEqual(sonnet.agents, []);

    const opus = rowOf(section, 'developer', 'claude-opus-5-5');
    assert.equal(opus.runs, 3);
    assert.equal(opus.runs_with_subagent, 2);
    assert.ok(Math.abs(opus.delegation_rate - 2 / 3) < 0.001);
    assert.equal(section.rows.length, 3);
  });

  it('main-thread Bash: tool_calls minus subagent_tool_calls, median and p90 (nearest rank), null below the minimum run count', () => {
    const h = history();
    // 30 runs; main-thread Bash i - i%3 ... use explicit: total = 2i, subagent = i → main = i (1..30).
    for (let i = 1; i <= 30; i += 1) {
      h.log.runFinished(finish('acme/app', i, `p${i}`, '2026-10-21T10:00:00Z', { role: 'developer', toolCalls: { Bash: 2 * i, Read: 5 }, subagentToolCalls: { Bash: i } }));
    }
    const row = rowOf(evalOf(h), 'developer', 'claude-opus-5-5');
    assert.equal(row.main_bash.total, 465);
    assert.equal(row.main_bash.avg, 15.5);
    assert.equal(row.main_bash.p50, 15);
    assert.equal(row.main_bash.p90, 27);

    // Two runs: neither median nor p90.
    const small = history();
    small.log.runFinished(finish('acme/app', 1, 'a', '2026-10-21T10:00:00Z', { role: 'developer', toolCalls: { Bash: 4 } }));
    small.log.runFinished(finish('acme/app', 2, 'b', '2026-10-21T10:00:00Z', { role: 'developer', toolCalls: { Bash: 9 } }));
    const few = rowOf(evalOf(small), 'developer', 'claude-opus-5-5').main_bash;
    assert.equal(few.p50, null);
    assert.equal(few.p90, null);
    assert.equal(few.total, 13);

    // Three runs: a median, still no p90.
    small.log.runFinished(finish('acme/app', 3, 'c', '2026-10-21T10:00:00Z', { role: 'developer', toolCalls: { Bash: 1 } }));
    const three = rowOf(evalOf(small), 'developer', 'claude-opus-5-5').main_bash;
    assert.equal(three.p50, 4);
    assert.equal(three.p90, null);
  });

  it('clamps main-thread Bash at 0 when the subagents report more than the total', () => {
    const h = history();
    h.log.runFinished(finish('acme/app', 1, 'a', '2026-10-21T10:00:00Z', { role: 'developer', toolCalls: { Bash: 2 }, subagentToolCalls: { Bash: 7 } }));
    const row = rowOf(evalOf(h), 'developer', 'claude-opus-5-5');
    assert.equal(row.main_bash.total, 0);
    assert.equal(row.main_bash.avg, 0);
  });

  it('token share: persisted subagent tokens over billed tokens, null without billed tokens, never above 1', () => {
    const h = history();
    h.log.runFinished(finish('acme/app', 1, 'a', '2026-10-21T10:00:00Z', { role: 'developer', agentCalls: { Explore: 2 }, subagents: [sub(1000), sub(1500, 'Plan')] }));
    h.log.runFinished(finish('acme/app', 2, 'b', '2026-10-21T11:00:00Z', { role: 'developer' }));
    const row = rowOf(evalOf(h), 'developer', 'claude-opus-5-5');
    assert.equal(row.billed_tokens, 2 * PER_RUN);
    assert.equal(row.subagent_tokens, 2500);
    assert.equal(row.subagent_token_share, 0.125);

    // A run without logged usage but with a subagent: no billed tokens → null, not NaN/Infinity.
    const bare = history();
    bare.log.runFinished(finish('acme/app', 1, 'a', '2026-10-21T10:00:00Z', { role: 'developer', usage: {}, subagents: [sub(500)] }));
    const noUsage = rowOf(evalOf(bare), 'developer', 'unknown');
    assert.equal(noUsage.subagent_token_share, null);
    assert.doesNotMatch(JSON.stringify(evalOf(bare)), /NaN|Infinity/);

    // Subagent tokens beyond the billed total are capped.
    const over = history();
    over.log.runFinished(finish('acme/app', 1, 'a', '2026-10-21T10:00:00Z', { role: 'developer', subagents: [sub(PER_RUN * 3)] }));
    assert.ok(rowOf(evalOf(over), 'developer', 'claude-opus-5-5').subagent_token_share! <= 1);
  });

  it('returns per issue: Agent review changes_needed and Testing failed, divided by the issues of the row', () => {
    const h = history();
    // Developer worked on #1, #2, #3, #4; reviews sent #1 back twice and #2 once; one test failure on #2.
    for (let n = 1; n <= 4; n += 1) h.log.runFinished(finish('acme/app', n, `d${n}`, '2026-10-21T10:00:00Z', { role: 'developer' }));
    h.log.stageResult(stage('acme/app', 1, 'reviewer', 'review', 'changes_needed', '2026-10-21T11:00:00Z'));
    h.log.stageResult(stage('acme/app', 1, 'reviewer', 'review', 'changes_needed', '2026-10-21T12:00:00Z'));
    h.log.stageResult(stage('acme/app', 2, 'reviewer', 'review', 'changes_needed', '2026-10-21T11:00:00Z'));
    h.log.stageResult(stage('acme/app', 2, 'tester', 'test', 'failed', '2026-10-21T13:00:00Z'));
    // Not returns: approvals and passes.
    h.log.stageResult(stage('acme/app', 3, 'reviewer', 'review', 'approved', '2026-10-21T11:00:00Z'));
    h.log.stageResult(stage('acme/app', 4, 'tester', 'test', 'passed', '2026-10-21T11:00:00Z'));
    const row = rowOf(evalOf(h), 'developer', 'claude-opus-5-5');
    assert.equal(row.issues, 4);
    assert.deepEqual(row.returns, { review_changes_needed: 3, test_failed: 1, total: 4, per_issue: 1 });
  });

  it('cost per finished issue sums the stages of the issue and ignores unfinished issues', () => {
    const h = history();
    // Issue #1 finishes (In review); its developer run costs the same as its reviewer run. Issue #2 never does.
    h.log.runFinished(finish('acme/app', 1, 'd1', '2026-10-21T10:00:00Z', { role: 'developer' }));
    h.log.runFinished(finish('acme/app', 1, 'r1', '2026-10-21T11:00:00Z', { role: 'reviewer' }));
    h.log.runFinished(finish('acme/app', 2, 'd2', '2026-10-21T10:00:00Z', { role: 'developer' }));
    h.log.stageResult(stage('acme/app', 1, 'reviewer', 'review', 'approved', '2026-10-21T11:30:00Z', { target: 'In review' }));
    const row = rowOf(evalOf(h), 'developer', 'claude-opus-5-5');
    // opus: 1000*4 + 2000*20 + 3000*4(default cache read) ... compare by ratio instead of the price list.
    const runCost = row.cost_usd / 2;
    assert.equal(row.issues, 2);
    assert.equal(row.finished_issues, 1);
    assert.ok(Math.abs(row.cost_per_finished_issue! - 2 * runCost) < 1e-3);
    assert.ok(Math.abs(row.own_cost_per_finished_issue! - runCost) < 1e-3);
    // The reviewer row has the issue as finished, too.
    assert.equal(rowOf(evalOf(h), 'reviewer', 'claude-opus-5-5').finished_issues, 1);
  });

  it('leaves room for confirmed and refuted findings and does not fail when the fields are absent', () => {
    const h = history();
    h.log.runFinished(finish('acme/app', 1, 'd1', '2026-10-21T10:00:00Z', { role: 'developer' }));
    const row = rowOf(evalOf(h), 'developer', 'claude-opus-5-5');
    assert.ok(row.findings && typeof row.findings === 'object');
    assert.equal(row.findings.confirmed, null);
    assert.equal(row.findings.refuted, null);
  });

  it('a fixture without any subagent fields yields zeros and nulls, not errors or NaN', () => {
    // Hand-written old-style lines: no tool_calls, subagent_tool_calls, agent_calls, subagents; no stage_result.
    const entries: HistoryEntry[] = [
      { ts: '2026-10-21T10:00:00.000Z', event: 'run_finished', fields: { repo: 'acme/app', issue: 'acme/app#1', run: 'r1', outcome: 'handed_off', started_at: '2026-10-21T09:59:00.000Z', agent_seconds: '60', model_usage: JSON.stringify({ 'claude-opus-5-5': usage }) } },
      { ts: '2026-10-21T11:00:00.000Z', event: 'run_finished', fields: { repo: 'acme/app', issue: 'acme/app#2', run: 'r2', outcome: 'failed' } },
    ];
    const pricing = history().pricing.current();
    const section = computeAnalytics(entries, pricing, filter(), NOW).subagent_evaluation;
    assert.ok(section.rows.length >= 1);
    for (const row of section.rows) {
      assert.equal(row.runs_with_subagent, 0);
      assert.equal(row.delegation_rate, 0);
      assert.equal(row.subagent_calls, 0);
      assert.deepEqual(row.agents, []);
      assert.equal(row.subagent_tokens, 0);
      assert.equal(row.finished_issues, 0);
      assert.equal(row.cost_per_finished_issue, null);
      assert.equal(row.returns.total, 0);
      assert.equal(row.returns.per_issue, 0);
      assert.equal(row.findings.confirmed, null);
    }
    assert.doesNotMatch(JSON.stringify(section), /NaN|Infinity/);
    assert.deepEqual(computeAnalytics([], pricing, filter(), NOW).subagent_evaluation.rows, []);
  });

  it('filters: role, repository, period and complexity narrow the section', () => {
    const h = history();
    h.log.runFinished(finish('acme/app', 1, 'a1', '2026-10-21T10:00:00Z', { role: 'developer', agentCalls: { Explore: 1 } }));
    h.log.runFinished(finish('acme/app', 2, 'a2', '2026-10-22T10:00:00Z', { role: 'developer' }));
    h.log.runFinished(finish('acme/app', 3, 'a3', '2026-10-23T10:00:00Z', { role: 'architect' }));
    h.log.runFinished(finish('other/repo', 4, 'b1', '2026-10-24T10:00:00Z', { role: 'developer' }));
    h.log.stageResult(stage('acme/app', 1, 'developer', 'implementation', 'done', '2026-10-21T10:30:00Z', { complexity: 'S' }));
    h.log.stageResult(stage('acme/app', 2, 'developer', 'implementation', 'done', '2026-10-22T10:30:00Z', { complexity: 'M' }));
    h.log.stageResult(stage('acme/app', 3, 'architect', 'design', 'ready', '2026-10-23T10:30:00Z', { complexity: 'M' }));
    const total = (s: ReturnType<typeof evalOf>) => s.rows.reduce((n, r) => n + r.runs, 0);

    assert.equal(total(evalOf(h)), 4);
    // role
    assert.deepEqual(evalOf(h, { role: 'architect' }).rows.map((r) => [r.role, r.runs]), [['architect', 1]]);
    assert.deepEqual(evalOf(h, { role: 'nobody' }).rows, []);
    // repository
    assert.equal(total(evalOf(h, { repo: 'other/repo' })), 1);
    assert.equal(total(evalOf(h, { repo: 'acme/app' })), 3);
    // period
    assert.equal(total(evalOf(h, { from: new Date('2026-10-22T00:00:00Z'), to: new Date('2026-10-24T00:00:00Z') })), 2);
    assert.equal(total(evalOf(h, { from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-11-02T00:00:00Z') })), 0);
    // complexity (per issue, from its stage results)
    assert.equal(total(evalOf(h, { complexity: 'S' })), 1);
    assert.equal(total(evalOf(h, { complexity: 'M' })), 2);
    assert.equal(total(evalOf(h, { complexity: 'unknown' })), 1);
    assert.equal(total(evalOf(h, { complexity: 'XL' })), 0);
    // combined
    assert.deepEqual(evalOf(h, { role: 'developer', complexity: 'S' }).rows.map((r) => [r.role, r.runs, r.runs_with_subagent]), [['developer', 1, 1]]);
    // the response echoes the filter
    const a = computeAnalytics(entriesOf(h), h.pricing.current(), filter({ role: 'developer', complexity: 'M' }), NOW);
    assert.equal(a.filter.role, 'developer');
    assert.equal(a.filter.complexity, 'M');
  });

  it('without role and complexity filter the existing sections are unchanged', () => {
    const h = history();
    h.log.runFinished(finish('acme/app', 1, 'a1', '2026-10-21T10:00:00Z', { role: 'developer' }));
    h.log.runFinished(finish('acme/app', 2, 'a2', '2026-10-21T11:00:00Z', { role: 'reviewer' }));
    const base = computeAnalytics(entriesOf(h), h.pricing.current(), filter(), NOW);
    const withNulls = computeAnalytics(entriesOf(h), h.pricing.current(), filter({ role: null, complexity: null }), NOW);
    assert.deepEqual(withNulls, base);
    assert.equal(base.totals.runs, 2);
    assert.deepEqual(base.by_role.map((r) => r.role).sort(), ['developer', 'reviewer']);
  });

  it('newest non-null complexity of an issue wins', () => {
    const h = history();
    h.log.runFinished(finish('acme/app', 1, 'a1', '2026-10-21T10:00:00Z', { role: 'developer' }));
    h.log.stageResult(stage('acme/app', 1, 'architect', 'design', 'ready', '2026-10-21T08:00:00Z', { complexity: 'S' }));
    h.log.stageResult(stage('acme/app', 1, 'developer', 'implementation', 'done', '2026-10-21T10:30:00Z', { complexity: 'XL' }));
    h.log.stageResult(stage('acme/app', 1, 'reviewer', 'review', 'approved', '2026-10-21T11:30:00Z', { complexity: null }));
    const total = (c: string) => evalOf(h, { complexity: c }).rows.reduce((n, r) => n + r.runs, 0);
    assert.equal(total('XL'), 1);
    assert.equal(total('S'), 0);
  });
});

describe('subagent evaluation API (independent)', () => {
  let server: HttpServerHandle;
  before(async () => {
    const h = history();
    h.log.runFinished(finish('acme/app', 1, 'a1', '2026-10-21T10:00:00Z', { role: 'developer', agentCalls: { Explore: 2 }, subagents: [sub(2000)], toolCalls: { Bash: 5 }, subagentToolCalls: { Bash: 2 } }));
    h.log.runFinished(finish('acme/app', 2, 'a2', '2026-10-21T11:00:00Z', { role: 'architect' }));
    h.log.stageResult(stage('acme/app', 1, 'developer', 'implementation', 'done', '2026-10-21T10:30:00Z', { complexity: 'M' }));
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
      runner: new FakeRunner(),
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker(),
    });
    server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent(), history: { dir: h.log.dir, pricing: h.pricing } });
  });
  after(async () => {
    await server.close();
  });

  const get = (query: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.port, path: `/api/v1/history/analytics?${query}` }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
  const base = 'from=2026-10-20T00:00:00Z&to=2026-10-30T00:00:00Z&tz=UTC';
  const rows = (res: { body: string }) => JSON.parse(res.body).subagent_evaluation.rows as Array<{ role: string; runs: number }>;

  it('returns subagent_evaluation and honours role and complexity (the cache key includes them)', async () => {
    const all = await get(base);
    assert.equal(all.status, 200);
    assert.deepEqual(rows(all).map((r) => r.role).sort(), ['architect', 'developer']);
    const dev = rows(await get(`${base}&role=developer`));
    assert.deepEqual(dev.map((r) => r.role), ['developer']);
    // Same period, other role: not served from the cache entry above.
    const arch = rows(await get(`${base}&role=architect`));
    assert.deepEqual(arch.map((r) => r.role), ['architect']);
    const m = await get(`${base}&complexity=M`);
    assert.deepEqual(rows(m).map((r) => r.role), ['developer']);
    assert.equal(JSON.parse(m.body).filter.complexity, 'M');
    assert.deepEqual(rows(await get(`${base}&complexity=unknown`)).map((r) => r.role), ['architect']);
    // And back to the unfiltered request.
    assert.equal(rows(await get(base)).length, 2);
    const row = JSON.parse(dev.length ? (await get(`${base}&role=developer`)).body : '{}').subagent_evaluation.rows[0];
    assert.equal(row.runs_with_subagent, 1);
    assert.equal(row.delegation_rate, 1);
    assert.equal(row.subagent_tokens, 2000);
  });

  it('answers invalid role and complexity values without a 500', async () => {
    for (const query of ['role=nobody', 'complexity=ZZ', 'role=', 'complexity=', 'role=%00%ff', 'role=a&role=b', `role=${'x'.repeat(5000)}`]) {
      const res = await get(`${base}&${query}`);
      assert.ok(res.status < 500, `${query.slice(0, 20)} → ${res.status}`);
      if (res.status === 200) assert.ok(Array.isArray(JSON.parse(res.body).subagent_evaluation.rows));
    }
    assert.deepEqual(rows(await get(`${base}&role=nobody`)), []);
  });
});

describe('subagent evaluation page (independent)', () => {
  const section = {
    note: 'Definition des fertigen Issues und des Token-Anteils.',
    rules: { median_min_runs: 3, percentile_min_runs: 20 },
    rows: [
      {
        role: 'architect', model: 'claude-opus-5-5', runs: 170, runs_with_subagent: 19, delegation_rate: 0.1118, subagent_calls: 30,
        agents: [{ agent: 'Explore', calls: 25, runs: 17 }],
        main_bash: { total: 100, avg: 0.59, p50: 0, p90: 3 },
        billed_tokens: 1000, subagent_tokens: 250, subagent_token_share: 0.25, issues: 40, finished_issues: 10,
        cost_usd: 12, own_cost_per_finished_issue: 0.5, cost_per_finished_issue: 1.5,
        returns: { review_changes_needed: 4, test_failed: 2, total: 6, per_issue: 0.15 }, findings: { confirmed: null, refuted: null },
      },
      {
        role: 'developer', model: 'claude-sonnet-5-5', runs: 252, runs_with_subagent: 0, delegation_rate: 0, subagent_calls: 0, agents: [],
        main_bash: { total: 0, avg: 0, p50: 0, p90: 0 }, billed_tokens: 0, subagent_tokens: 0, subagent_token_share: null, issues: 0, finished_issues: 0,
        cost_usd: 0, own_cost_per_finished_issue: null, cost_per_finished_issue: null,
        returns: { review_changes_needed: 0, test_failed: 0, total: 0, per_issue: 0 }, findings: { confirmed: null, refuted: null },
      },
    ],
  };
  const load = async (over: Record<string, unknown> = {}, url = 'http://127.0.0.1/stats') => {
    const page = renderPage(LOGS_HTML, undefined, {
      url,
      fetch: (u: string) => (u.startsWith('/api/v1/history/entries') ? entriesFixture() : analyticsFixture(over)),
    });
    await until(() => page.$('log-count').textContent === '1' && page.$('summary-kpis').children.length > 0, 3000, 'the page to load');
    return page;
  };

  it('shows one table row per role × model with delegation, subagent calls, Bash, token share and returns', async () => {
    const page = await load({ subagent_evaluation: section });
    const rows = page.query('#subagent-eval-table tr');
    assert.equal(rows.length, 3, 'header and two rows');
    const architect = rows[1]!.textContent ?? '';
    assert.match(architect, /architect/);
    assert.match(architect, /claude-opus-5-5/);
    assert.match(architect, /170/);
    assert.match(architect, /19/);
    assert.match(architect, /Explore/);
    assert.match(architect, /25/);
    const developer = rows[2]!.textContent ?? '';
    assert.match(developer, /claude-sonnet-5-5/);
    assert.match(developer, /252/);
    assert.doesNotMatch(rows.map((r) => r.textContent).join(''), /NaN|undefined|null/);
    assert.match(page.query('[data-body="subagent-eval"]')[0]?.textContent ?? '', /Definition des fertigen Issues/);
  });

  it('exports the section as JSON together with the active filters', async () => {
    const page = await load({ subagent_evaluation: section, filter: { repo: 'acme/app', model: null, effort: null, role: 'architect', complexity: 'M' } });
    const link = page.query('#subagent-eval-export')[0] as unknown as { hidden: boolean; href: string; download?: string; hasAttribute(n: string): boolean };
    assert.equal(link.hidden, false);
    assert.ok(link.hasAttribute('download'));
    assert.ok(link.href.startsWith('data:application/json'));
    const payload = JSON.parse(decodeURIComponent(link.href.slice(link.href.indexOf(',') + 1)));
    assert.deepEqual(payload.subagent_evaluation.rows.map((r: { role: string }) => r.role), ['architect', 'developer']);
    assert.equal(payload.filter.role, 'architect');
    assert.equal(payload.filter.complexity, 'M');
    assert.equal(payload.filter.repo, 'acme/app');
  });

  it('renders rows whose optional fields are absent (no findings, no agents) without failing', async () => {
    const lean = { ...section, rows: section.rows.map((r) => { const { findings, ...rest } = r; void findings; return rest; }) };
    const page = await load({ subagent_evaluation: lean });
    assert.equal(page.query('#subagent-eval-table tr').length, 3);
  });

  it('shows an empty state instead of a table when there is no section or no row', async () => {
    const none = await load({ subagent_evaluation: { ...section, rows: [] } });
    assert.equal(none.query('#subagent-eval-table').length, 0);
    const old = analyticsFixture();
    delete old.subagent_evaluation;
    const page = renderPage(LOGS_HTML, old);
    assert.equal(page.query('#subagent-eval-table').length, 0);
  });

  it('offers role and complexity filters, reads them from the URL and sends them to the API', async () => {
    const page = await load(
      { subagent_evaluation: section, roles_available: ['architect', 'developer'], complexities_available: ['S', 'M', 'unknown'] },
      'http://127.0.0.1/stats?role=architect&complexity=M',
    );
    assert.equal(page.query('#role').length, 1);
    assert.equal(page.query('#complexity').length, 1);
    const call = page.fetches.map((f) => f.url).find((u) => u.startsWith('/api/v1/history/analytics'))!;
    const params = new URL(call, 'http://x').searchParams;
    assert.equal(params.get('role'), 'architect');
    assert.equal(params.get('complexity'), 'M');
    const roleOptions = page.query('#role option').map((o) => (o as unknown as { value: string }).value);
    assert.ok(roleOptions.includes('architect') && roleOptions.includes('developer'));
  });
});
