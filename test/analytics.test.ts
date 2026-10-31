import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { costOf, priceFor, PricingStore } from '../src/costs/pricing.ts';
import { computeAnalytics, filterEntries, granularityFor, type AnalyticsFilter } from '../src/history/analytics.ts';
import { computeHistoryStats, HistoryLog, readHistory } from '../src/history/history.ts';
import { Logger } from '../src/log.ts';
import { tempDir } from './helpers.ts';

const PRICES = `
default: { input: 5, output: 25 }
opus: { input: 4, output: 20, cache_read: 0.2 }
haiku: { input: 1, output: 5 }
`;

describe('statistics analytics', () => {
  function history() {
    const dir = tempDir();
    const file = path.join(dir, 'model-costs.yml');
    fs.writeFileSync(file, PRICES);
    const pricing = new PricingStore(file, Logger.silent());
    return { log: new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent()), pricing };
  }
  const usage = { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 100_000, cacheWriteTokens: 10_000 };
  const finish = (issue: string, run: string, at: string, overrides: Record<string, unknown> = {}) => ({
    repo: 'acme/app',
    issue,
    title: `Title of ${issue}`,
    run,
    session: 'thread-1',
    attempt: null,
    outcome: 'handed_off' as const,
    state: 'In review',
    reason: 'done',
    turns: 2,
    startedAt: new Date(new Date(at).getTime() - 60_000),
    finishedAt: new Date(at),
    agentSeconds: 60,
    usage: { 'claude-opus-5-5': usage },
    claudeEstimateUsd: null,
    ...overrides,
  });
  const filter = (overrides: Partial<AnalyticsFilter> = {}): AnalyticsFilter => ({
    from: null, to: null, repo: null, model: null, timeZone: 'UTC', ...overrides,
  });
  const NOW = new Date('2026-10-06T00:00:00Z');

  function seed() {
    const h = history();
    // Previous week (Sep 26 – Oct 2) and the current one (Oct 3 – Oct 5).
    h.log.runFinished(finish('acme/app#1', 'r0', '2026-09-28T09:00:00Z'));
    h.log.runFinished(finish('acme/app#1', 'r1', '2026-10-03T10:00:00Z', { outcome: 'failed', state: 'In progress' }));
    h.log.runFinished(finish('acme/app#1', 'r2', '2026-10-04T10:00:00Z', { agentSeconds: 120, usage: { 'claude-opus-5-5': usage, 'claude-haiku-4-5': usage } }));
    h.log.runFinished({ ...finish('other/repo#3', 'r3', '2026-10-05T11:00:00Z', { outcome: 'stopped', state: 'Todo', agentSeconds: 30 }), repo: 'other/repo' });
    h.log.note('acme/app', 'issue_paused', { issue: 'acme/app#1', state: 'In progress', continuations: 3 });
    return { ...h, entries: readHistory(h.log.dir, null).entries };
  }

  describe('budget history', () => {
    const event = (at: string, status: string) => ({ at, run_id: 'x', issue: 'acme/app#1', role: 'developer', model: null, rate_limit_info: { status, rateLimitType: 'five_hour' } });
    const per = 1000 + 2000 + 100_000 + 10_000;

    function seedBudget() {
      const h = history();
      h.log.runFinished(finish('acme/app#1', 'b1', '2026-10-03T10:00:00Z', { role: 'developer', contextPeakPercent: 40, contextCompacts: 1 }));
      h.log.runFinished(finish('acme/app#1', 'b2', '2026-10-03T12:00:00Z', { role: 'developer', contextPeakPercent: 60, contextCompacts: 2 }));
      h.log.runFinished(finish('acme/app#2', 'b3', '2026-10-04T08:00:00Z', { role: 'reviewer', contextPeakPercent: 30, contextCompacts: 0 }));
      h.log.runFinished(finish('acme/app#3', 'b4', '2026-10-04T09:00:00Z', { role: 'tester' }));
      return readHistory(h.log.dir, null).entries;
    }

    it('computes the 5-hour peak and the limit hits per day, compacts and average context per role', () => {
      const events = [event('2026-10-04T09:30:00Z', 'rejected'), event('2026-10-03T11:00:00Z', 'allowed_warning'), event('2026-10-06T01:00:00Z', 'rejected')];
      const a = computeAnalytics(seedBudget(), history().pricing.current(), filter({ from: new Date('2026-10-03T00:00:00Z'), to: new Date('2026-10-05T00:00:00Z') }), NOW, events);
      assert.deepEqual(a.budget.days, [
        { date: '2026-10-03', peak_5h_tokens: 2 * per, limit_hits: 0 },
        { date: '2026-10-04', peak_5h_tokens: 2 * per, limit_hits: 1 },
      ]);
      assert.deepEqual(a.budget.compacts_by_role, { developer: 3, reviewer: 0 });
      assert.deepEqual(a.budget.avg_context_by_role, { developer: 50, reviewer: 30 });
    });

    it('copes without events and with history that has no context fields', () => {
      const s = seed();
      const a = computeAnalytics(s.entries, s.pricing.current(), filter({ from: new Date('2026-10-03T00:00:00Z'), to: new Date('2026-10-06T00:00:00Z') }), NOW);
      assert.equal(a.budget.days.length, 3);
      assert.ok(a.budget.days.every((d) => d.limit_hits === 0));
      assert.ok(a.budget.days.some((d) => d.peak_5h_tokens > 0));
      assert.deepEqual(a.budget.avg_context_by_role, {});
      assert.deepEqual(computeAnalytics([], s.pricing.current(), filter(), NOW).budget, { days: [], compacts_by_role: {}, avg_context_by_role: {} });
    });
  });

  describe('stage results', () => {
    const result = (issue: string, role: string, kind: string, verdict: string, at: string, over: Record<string, unknown> = {}) => ({
      repo: 'acme/app', issue, run: null, role, kind, verdict, round: null, target: null, profile: 'bugfix', complexity: 'S', findings: 0, at: new Date(at), ...over,
    });

    function seedResults() {
      const h = history();
      h.log.runFinished(finish('acme/app#1', 'r1', '2026-10-03T10:00:00Z', { role: 'developer' }));
      h.log.runFinished(finish('acme/app#2', 'r2', '2026-10-03T11:00:00Z', { role: 'developer' }));
      h.log.stageResult(result('acme/app#1', 'developer', 'implementation', 'done', '2026-10-03T10:00:00Z', { run: 'r1' }));
      h.log.stageResult(result('acme/app#1', 'reviewer', 'review', 'changes_needed', '2026-10-03T10:30:00Z', { round: 1, findings: 2 }));
      h.log.stageResult(result('acme/app#1', 'reviewer', 'review', 'approved', '2026-10-04T10:30:00Z', { round: 2 }));
      h.log.stageResult(result('acme/app#2', 'developer', 'implementation', 'done', '2026-10-03T11:00:00Z', { run: 'r2', profile: 'feature', complexity: 'L' }));
      h.log.stageResult(result('acme/app#3', 'developer', 'implementation', 'done', '2026-10-03T12:00:00Z', { profile: null, complexity: null }));
      h.log.stageResult({ ...result('other/repo#4', 'reviewer', 'review', 'approved', '2026-10-03T12:00:00Z'), repo: 'other/repo' });
      return readHistory(h.log.dir, null).entries;
    }

    it('groups the results by profile, with the verdicts, complexities and the cost of its issues', () => {
      const a = computeAnalytics(seedResults(), history().pricing.current(), filter({ repo: 'acme/app' }), NOW);
      assert.equal(a.stage_results, 5);
      assert.deepEqual(a.by_profile.map((row) => [row.profile, row.results, row.issues]), [['bugfix', 3, 1], ['default', 1, 1], ['feature', 1, 1]]);
      const bugfix = a.by_profile[0];
      assert.deepEqual(bugfix?.verdicts, { 'implementation:done': 1, 'review:changes_needed': 1, 'review:approved': 1 });
      assert.deepEqual(bugfix?.by_complexity, { S: 3 });
      assert.equal(bugfix?.max_round, 2);
      // The runs of acme/app#1 are attributed to its profile.
      assert.deepEqual([bugfix?.runs, bugfix?.cost_usd, bugfix?.avg_cost_per_issue], [1, 0.114, 0.114]);
      assert.deepEqual(a.by_profile[1]?.by_complexity, { unknown: 1 });
    });

    it('counts the verdicts per role', () => {
      const a = computeAnalytics(seedResults(), history().pricing.current(), filter(), NOW);
      assert.deepEqual(
        a.verdicts_by_role.map((row) => [row.role, row.results, row.issues, row.verdicts]),
        [
          ['developer', 3, 3, { 'implementation:done': 3 }],
          ['reviewer', 3, 2, { 'review:changes_needed': 1, 'review:approved': 2 }],
        ],
      );
    });

    it('follows the period and the model filter, and is empty without stage_result lines', () => {
      const entries = seedResults();
      const pricing = history().pricing.current();
      assert.equal(computeAnalytics(entries, pricing, filter({ from: new Date('2026-10-04T00:00:00Z') }), NOW).stage_results, 1);
      // A model filter keeps only the results of runs that used the model: here the two with a run id.
      assert.equal(computeAnalytics(entries, pricing, filter({ model: 'claude-opus-5-5' }), NOW).stage_results, 2);
      assert.equal(computeAnalytics(entries, pricing, filter({ model: 'claude-haiku-4-5' }), NOW).stage_results, 0);
      const none = computeAnalytics(seed().entries, pricing, filter(), NOW);
      assert.deepEqual([none.by_profile, none.verdicts_by_role, none.stage_results], [[], [], 0]);
    });
  });

  it('aggregates tool calls, skills, subagents and the use of integrations such as Laravel Boost', () => {
    const h = history();
    const boost = (status: string, tools: Record<string, number>, skills: Record<string, number> = {}) => [{ id: 'laravel-boost', status, tools, skills }];
    h.log.runFinished(finish('acme/app#1', 'r1', '2026-10-03T10:00:00Z', {
      toolCalls: { Bash: 4, 'mcp__laravel-boost__search-docs': 2, Skill: 1 },
      skillCalls: { 'pest-testing': 1 },
      integrations: boost('ready', { 'search-docs': 2 }, { 'pest-testing': 1 }),
    }));
    h.log.runFinished(finish('acme/app#2', 'r2', '2026-10-04T10:00:00Z', {
      toolCalls: { Bash: 1, Edit: 2 },
      agentCalls: { 'symphony:laravel-code-reviewer': 2, 'general-purpose': 1 },
      integrations: boost('ready', {}),
    }));
    h.log.runFinished(finish('acme/app#3', 'r3', '2026-10-05T10:00:00Z', { toolCalls: { 'mcp__laravel-boost__search-docs': 1 }, integrations: boost('unavailable', {}) }));
    // Logged before tool calls were recorded.
    h.log.runFinished(finish('acme/app#4', 'r4', '2026-10-05T11:00:00Z'));
    const a = computeAnalytics(readHistory(h.log.dir, null).entries, h.pricing.current(), filter(), NOW);

    assert.equal(a.tools.runs, 4);
    assert.equal(a.tools.runs_with_calls, 3);
    assert.equal(a.tools.calls, 11);
    assert.equal(a.tools.avg_calls_per_run, 3.7);
    assert.equal(a.tools.distinct_tools, 4);
    assert.deepEqual(a.tools.tools, [
      { tool: 'Bash', calls: 5, runs: 2, server: null, name: 'Bash' },
      { tool: 'mcp__laravel-boost__search-docs', calls: 3, runs: 2, server: 'laravel-boost', name: 'search-docs' },
      { tool: 'Edit', calls: 2, runs: 1, server: null, name: 'Edit' },
      { tool: 'Skill', calls: 1, runs: 1, server: null, name: 'Skill' },
    ]);
    assert.deepEqual(a.tools.skills, [{ skill: 'pest-testing', calls: 1, runs: 1 }]);
    assert.deepEqual(a.tools.agents, [
      { agent: 'symphony:laravel-code-reviewer', calls: 2, runs: 1 },
      { agent: 'general-purpose', calls: 1, runs: 1 },
    ]);
    assert.deepEqual(a.tools.integrations, [{
      id: 'laravel-boost',
      runs: 3,
      by_status: { ready: 2, unavailable: 1 },
      ready_runs: 2,
      used_runs: 1,
      use_rate: 0.5,
      calls: 3,
      avg_calls_per_used_run: 3,
      tools: [{ tool: 'search-docs', calls: 2, runs: 1 }],
      skills: [{ skill: 'pest-testing', calls: 1, runs: 1 }],
    }]);

    const none = computeAnalytics([], h.pricing.current(), filter(), NOW);
    assert.deepEqual(none.tools, { runs: 0, runs_with_calls: 0, calls: 0, avg_calls_per_run: null, distinct_tools: 0, tools: [], skills: [], agents: [], integrations: [] });
  });

  it('breaks runs down by effort, filters by it and lists runs without usage under their requested model', () => {
    const h = history();
    h.log.runStarted({ repo: 'acme/app', issue: 'acme/app#7', title: 'Old', state: 'Todo', attempt: null, model: 'sonnet', effort: 'medium', run: 'r7', at: new Date('2026-10-03T09:00:00Z') });
    // Logged before run_finished carried effort and model: joined through run_started; stopped before any usage.
    h.log.runFinished(finish('acme/app#7', 'r7', '2026-10-03T10:00:00Z', { outcome: 'stopped', usage: {} }));
    h.log.runFinished(finish('acme/app#8', 'r8', '2026-10-04T10:00:00Z', { effort: 'high', modelRequested: 'opus' }));
    h.log.runFinished(finish('acme/app#8', 'r9', '2026-10-04T11:00:00Z', { effort: 'high', modelRequested: 'opus', outcome: 'failed' }));
    h.log.runFinished(finish('acme/app#9', 'r10', '2026-10-05T10:00:00Z', { effort: null, modelRequested: 'fable', usage: {} }));
    // Requested as the alias of a family that did report usage: lands in that family's row.
    h.log.runFinished(finish('acme/app#9', 'r11', '2026-10-05T12:00:00Z', { effort: 'low', modelRequested: 'opus', usage: {}, outcome: 'stopped' }));
    // Nothing about the effort anywhere.
    h.log.runFinished(finish('acme/app#1', 'r0', '2026-09-28T09:00:00Z'));
    const entries = readHistory(h.log.dir, null).entries;
    const a = computeAnalytics(entries, h.pricing.current(), filter(), NOW);

    assert.deepEqual(a.efforts_available, ['default', 'low', 'medium', 'high', 'unknown']);
    assert.deepEqual(a.efforts.map((e) => [e.effort, e.runs, e.failed, e.models]), [
      ['default', 1, 0, { fable: 1 }],
      ['low', 1, 0, { 'claude-opus-5-5': 1 }],
      ['medium', 1, 0, { sonnet: 1 }],
      ['high', 2, 1, { 'claude-opus-5-5': 2 }],
      ['unknown', 1, 0, { 'claude-opus-5-5': 1 }],
    ]);
    const high = a.efforts[3];
    assert.equal(high?.total_tokens, 2 * (1000 + 2000 + 100_000 + 10_000));
    assert.equal(high?.success_rate, 0.5);
    assert.equal(high?.avg_run_seconds, 60);
    assert.equal(high?.cost_usd, 2 * (a.efforts[4]?.cost_usd ?? 0));

    // Runs without logged usage appear under the model they were started with, with zero tokens.
    assert.deepEqual(a.models_available, ['claude-opus-5-5', 'fable', 'sonnet']);
    const fable = a.models.find((m) => m.model === 'fable');
    assert.deepEqual([fable?.runs, fable?.total_tokens, fable?.cost_usd, fable?.agent_seconds, fable?.price], [1, 0, 0, 60, 'default']);
    const opus = a.models.find((m) => m.model === 'claude-opus-5-5');
    assert.deepEqual([opus?.runs, opus?.total_tokens, opus?.agent_seconds], [4, 3 * (1000 + 2000 + 100_000 + 10_000), 240]);

    const onlyHigh = computeAnalytics(entries, h.pricing.current(), filter({ effort: 'high' }), NOW);
    assert.equal(onlyHigh.totals.runs, 2);
    assert.equal(onlyHigh.filter.effort, 'high');
    assert.ok(onlyHigh.top.cost.length === 2 && onlyHigh.top.cost.every((r) => r.effort === 'high'));
    const onlyFable = computeAnalytics(entries, h.pricing.current(), filter({ model: 'fable' }), NOW);
    assert.deepEqual(onlyFable.issues.map((i) => i.issue), ['acme/app#9']);
    assert.equal(onlyFable.totals.total_tokens, 0);
    assert.equal(computeAnalytics(entries, h.pricing.current(), filter({ effort: 'max' }), NOW).totals.runs, 0);
  });

  it('breaks runs down by role and sums each issue across its roles; logs without a role count as unknown', () => {
    const h = history();
    // Old line: no role on run_finished, taken from run_started when it is there.
    h.log.runStarted({ repo: 'acme/app', issue: 'acme/app#1', title: 'Old', state: 'Ready', attempt: null, model: 'opus', role: 'developer', run: 'r1', at: new Date('2026-10-04T08:00:00Z') });
    h.log.runFinished(finish('acme/app#1', 'r1', '2026-10-04T09:00:00Z'));
    h.log.runFinished(finish('acme/app#1', 'r2', '2026-10-04T10:00:00Z', { role: 'developer', nextRole: 'reviewer' }));
    h.log.runFinished(finish('acme/app#1', 'r3', '2026-10-04T11:00:00Z', { role: 'reviewer', outcome: 'failed' }));
    h.log.runFinished(finish('acme/app#2', 'r4', '2026-10-04T12:00:00Z', { role: 'reviewer', usage: {} }));
    h.log.runFinished(finish('acme/app#3', 'r5', '2026-10-04T13:00:00Z', { role: 'developer', usage: {} }));
    const entries = readHistory(h.log.dir, null).entries;
    // Drop the role of the first finish line and of a run without a start line, as in logs from before it was written.
    const stripped = entries.map((entry) => {
      if (entry.event !== 'run_finished' || (entry.fields.run !== 'r1' && entry.fields.run !== 'r5')) return entry;
      const { role: _role, ...fields } = entry.fields;
      return { ...entry, fields };
    });
    const a = computeAnalytics(stripped, h.pricing.current(), filter(), NOW);

    assert.deepEqual(a.by_role.map((r) => [r.role, r.runs, r.issues, r.failed]), [['developer', 2, 1, 0], ['reviewer', 2, 2, 1], ['unknown', 1, 1, 0]]);
    const developer = a.by_role[0];
    assert.equal(developer?.total_tokens, 2 * (1000 + 2000 + 100_000 + 10_000));
    assert.equal(developer?.agent_seconds, 120);
    assert.deepEqual(developer?.by_outcome, { handed_off: 2 });
    assert.deepEqual(a.by_role[1]?.by_outcome, { failed: 1, handed_off: 1 });
    assert.ok(Math.abs(a.by_role.reduce((sum, r) => sum + r.cost_usd, 0) - a.totals.cost_usd) < 1e-3);
    assert.ok(Math.abs(a.by_role.reduce((sum, r) => sum + (r.cost_share ?? 0), 0) - 1) < 1e-3);

    // Pipeline cost of an issue = all its runs across roles.
    const first = a.issues.find((i) => i.issue === 'acme/app#1');
    assert.equal(first?.cost_usd, a.totals.cost_usd);
    assert.deepEqual(Object.keys(first?.roles ?? {}), ['developer', 'reviewer']);
    assert.equal(first?.roles.developer?.runs, 2);
    assert.equal(first?.roles.reviewer?.cost_usd, a.by_role[1]?.cost_usd);
    assert.deepEqual(a.top.pipelines.map((p) => [p.issue, p.runs, p.cost_usd]), [['acme/app#1', 3, first?.cost_usd]]);
    assert.ok(a.top.cost.every((r) => ['developer', 'reviewer', 'unknown'].includes(r.role)));

    // Only logs without any role line.
    const bare = stripped.filter((entry) => entry.event !== 'run_started').map((entry) => {
      const { role: _role, ...fields } = entry.fields;
      return { ...entry, fields };
    });
    const old = computeAnalytics(bare, h.pricing.current(), filter(), NOW);
    assert.deepEqual(old.by_role.map((r) => [r.role, r.runs]), [['unknown', 5]]);
    assert.deepEqual(computeAnalytics([], h.pricing.current(), filter(), NOW).by_role, []);
  });

  it('aggregates a period with the existing prices and compares it with the previous one', () => {
    const { entries, pricing } = seed();
    const a = computeAnalytics(entries, pricing.current(), filter({ from: new Date('2026-09-29T00:00:00Z'), to: new Date('2026-10-06T00:00:00Z') }), NOW);
    const opus = costOf(usage, priceFor(pricing.current(), 'claude-opus-5-5').price);
    const haiku = costOf(usage, priceFor(pricing.current(), 'claude-haiku-4-5').price);

    assert.equal(a.totals.runs, 3);
    assert.equal(a.totals.issues, 2);
    assert.equal(a.totals.total_tokens, 4 * 113_000);
    assert.equal(a.totals.cost_usd, Math.round((3 * opus + haiku) * 10_000) / 10_000);
    assert.equal(a.totals.agent_seconds, 210);
    assert.deepEqual([a.totals.successful, a.totals.failed, a.totals.stopped, a.totals.retries], [1, 1, 1, 1]);
    assert.equal(a.period.granularity, 'day');
    assert.deepEqual(a.series.map((b) => [b.key, b.runs]), [
      ['2026-09-29', 0], ['2026-09-30', 0], ['2026-10-01', 0], ['2026-10-02', 0], ['2026-10-03', 1], ['2026-10-04', 1], ['2026-10-05', 1],
    ]);
    // Nothing logged before the previous period started, so it is not compared.
    assert.equal(a.previous, null);

    // The same totals as the existing statistics for the same runs.
    const stats = computeHistoryStats(entries.filter((e) => e.ts >= '2026-09-29'), pricing.current());
    assert.equal(a.totals.cost_usd, stats.totals.cost_usd);
    assert.equal(a.totals.total_tokens, stats.totals.total_tokens);

    const short = computeAnalytics(entries, pricing.current(), filter({ from: new Date('2026-10-04T00:00:00Z'), to: new Date('2026-10-06T00:00:00Z') }), NOW);
    assert.equal(short.period.granularity, 'hour');
    assert.equal(short.series.length, 48);
    assert.equal(short.previous?.runs, 1);
    assert.equal(short.previous?.from, '2026-10-02T00:00:00.000Z');
  });

  it('filters by repository and model, counting only the chosen model', () => {
    const { entries, pricing } = seed();
    const repo = computeAnalytics(entries, pricing.current(), filter({ repo: 'OTHER/repo' }), NOW);
    assert.equal(repo.totals.runs, 1);
    assert.deepEqual(repo.repositories.map((r) => r.repo), ['other/repo']);

    const haiku = computeAnalytics(entries, pricing.current(), filter({ model: 'claude-haiku-4-5' }), NOW);
    assert.equal(haiku.totals.runs, 1);
    assert.equal(haiku.totals.total_tokens, 113_000);
    assert.equal(haiku.totals.paused, null);
    assert.deepEqual(haiku.models.map((m) => [m.model, m.runs]), [['claude-haiku-4-5', 1]]);
    assert.deepEqual(haiku.models_available, ['claude-haiku-4-5', 'claude-opus-5-5']);
  });

  it('derives models, issues, outcomes, durations, heatmap and top runs from the logged runs', () => {
    const { entries, pricing } = seed();
    // The paused note is written with the real clock, so the open period ends a day from now.
    const a = computeAnalytics(entries, pricing.current(), filter(), new Date(Date.now() + 86_400_000));
    assert.equal(a.totals.runs, 4);
    assert.equal(a.totals.paused, 1);
    const opus = a.models.find((m) => m.model === 'claude-opus-5-5');
    assert.equal(opus?.runs, 4);
    assert.equal(opus?.price, 'opus');
    assert.equal(opus?.avg_tokens_per_run, 113_000);
    const issue = a.issues.find((i) => i.issue === 'acme/app#1');
    assert.deepEqual([issue?.runs, issue?.failed, issue?.retries, issue?.last_outcome], [3, 1, 1, 'handed_off']);
    assert.deepEqual(a.outcomes.by_outcome, { handed_off: 2, failed: 1, stopped: 1 });
    assert.equal(a.durations.min_seconds, 30);
    assert.equal(a.durations.max_seconds, 120);
    assert.equal(a.durations.p50_seconds, 60);
    assert.equal(a.durations.p90_seconds, null);
    assert.equal(a.durations.histogram.find((b) => b.label === '1–5m')?.runs, 3);
    assert.equal(a.heatmap.max, 1);
    // Oct 3, 2026 is a Saturday; the run started at 09:59 UTC.
    assert.equal(a.heatmap.start_times[5]?.[9], 1);
    assert.equal(a.top.duration[0]?.run, 'r2');
    assert.equal(a.top.retried[0]?.issue, 'acme/app#1');
    assert.equal(a.attention.items.length, 0);
  });

  it('flags runs far above the average with a transparent threshold', () => {
    const h = history();
    for (let i = 0; i < 6; i++) h.log.runFinished(finish(`acme/app#${i}`, `r${i}`, `2026-10-0${i + 1}T10:00:00Z`));
    h.log.runFinished(finish('acme/app#9', 'r9', '2026-10-05T12:00:00Z', { agentSeconds: 3600 }));
    const a = computeAnalytics(readHistory(h.log.dir, null).entries, h.pricing.current(), filter(), NOW);
    assert.deepEqual(a.attention.items.map((x) => [x.kind, x.issue]), [['duration', 'acme/app#9']]);
    assert.equal(a.attention.rules.factor, 3);
  });

  it('returns no buckets for an empty period', () => {
    const { entries, pricing } = seed();
    const a = computeAnalytics(entries, pricing.current(), filter({ from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-01-08T00:00:00Z') }), NOW);
    assert.equal(a.totals.runs, 0);
    assert.deepEqual(a.series, []);
    assert.equal(a.totals.avg_run_seconds, null);
  });

  it('picks coarser buckets for longer periods', () => {
    const day = 86_400_000;
    assert.equal(granularityFor(day), 'hour');
    assert.equal(granularityFor(30 * day), 'day');
    assert.equal(granularityFor(365 * day), 'week');
    assert.equal(granularityFor(1000 * day), 'month');
  });

  it('filters log entries by period, issue, event and result', () => {
    const { entries } = seed();
    const base = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-05T11:30:00Z'), repo: null, issue: null, event: null, result: null, order: 'desc' as const, limit: 2 };
    const page = filterEntries(entries, base);
    assert.equal(page.total, 3);
    assert.equal(page.truncated, true);
    assert.equal(page.entries[0]?.run, 'r3');
    assert.equal(page.entries.some((e) => e.event === 'model_usage'), false);
    assert.deepEqual(filterEntries(entries, { ...base, result: 'failed', limit: 10 }).entries.map((e) => e.run), ['r1']);
    assert.deepEqual(filterEntries(entries, { ...base, issue: '#3', limit: 10, order: 'asc' }).entries.map((e) => e.issue), ['other/repo#3']);
    assert.equal(filterEntries(entries, { ...base, event: 'model_usage', limit: 10 }).total, 4);
  });
});
