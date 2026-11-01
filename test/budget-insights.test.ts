import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PricingStore } from '../src/costs/pricing.ts';
import { computeAnalytics, type AnalyticsFilter } from '../src/history/analytics.ts';
import { HistoryLog, readHistory } from '../src/history/history.ts';
import { Logger } from '../src/log.ts';
import { tempDir } from './helpers.ts';

// E9-3 (#392): budget_insights next to budget.
const usage = { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 100_000, cacheWriteTokens: 10_000 };
const PER_RUN = 113_000;
const NOW = new Date('2026-10-20T00:00:00Z');

function setup() {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
  const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
  return { pricing, log: new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent()) };
}
const finish = (issue: string, run: string, at: string, over: Record<string, unknown> = {}) => ({
  repo: 'acme/app', issue, title: `T ${issue}`, run, session: null, attempt: null, outcome: 'handed_off' as const, state: 'In review', reason: 'done',
  turns: 1, startedAt: new Date(new Date(at).getTime() - 60_000), finishedAt: new Date(at), agentSeconds: 60, usage: { 'claude-opus-5-5': usage }, claudeEstimateUsd: null, ...over,
});
const filter: AnalyticsFilter = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-10T00:00:00Z'), repo: null, model: null, timeZone: 'UTC' };
const event = (at: string, model: string | null = 'claude-opus-5-5') => ({ at, run_id: 'x', issue: 'acme/app#1', role: 'developer', model, rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } });

describe('budget insights', () => {
  it('lists the rejected events of the period ascending and calibrates the limit like the forecast', () => {
    const h = setup();
    h.log.runFinished(finish('acme/app#1', 'r1', '2026-10-03T10:00:00Z'));
    h.log.runFinished(finish('acme/app#1', 'r2', '2026-10-03T11:00:00Z'));
    const events = [event('2026-10-03T12:00:00Z'), event('2026-10-02T10:00:00Z'), event('2026-09-01T10:00:00Z'),
      { ...event('2026-10-04T10:00:00Z'), rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' } }];
    const a = computeAnalytics(readHistory(h.log.dir, null).entries, h.pricing.current(), filter, NOW, events as never);
    assert.deepEqual(a.budget_insights.limit_hits.map((x) => x.at), ['2026-10-02T10:00:00Z', '2026-10-03T12:00:00Z']);
    assert.equal(a.budget_insights.limit_hits[1]!.model, 'claude-opus-5-5');
    assert.equal(a.budget_insights.limit_hits.length, a.budget.days.reduce((n, d) => n + d.limit_hits, 0));
    assert.equal(a.budget_insights.limit_5h_tokens, 2 * PER_RUN);
  });

  it('has no limit without a hit and keeps the three keys of budget', () => {
    const h = setup();
    h.log.runFinished(finish('acme/app#1', 'r1', '2026-10-03T10:00:00Z'));
    const a = computeAnalytics(readHistory(h.log.dir, null).entries, h.pricing.current(), filter, NOW, []);
    assert.equal(a.budget_insights.limit_5h_tokens, null);
    assert.deepEqual(a.budget_insights.limit_hits, []);
    assert.equal(a.budget_insights.top_compact, null);
    assert.deepEqual(Object.keys(a.budget).sort(), ['avg_context_by_role', 'compacts_by_role', 'days']);
  });

  it('finds the role and round with the most auto-compacts', () => {
    const h = setup();
    h.log.runFinished(finish('acme/app#1', 'r1', '2026-10-03T10:00:00Z', { role: 'developer', contextCompacts: 1 }));
    h.log.runFinished(finish('acme/app#1', 'r2', '2026-10-03T11:00:00Z', { role: 'developer', contextCompacts: 2 }));
    h.log.runFinished(finish('acme/app#2', 'r3', '2026-10-03T12:00:00Z', { role: 'reviewer', contextCompacts: 2 }));
    for (const [run, round] of [['r1', 1], ['r2', 2]] as const) {
      h.log.stageResult({ repo: 'acme/app', issue: 'acme/app#1', run, role: 'developer', kind: 'implementation', verdict: 'done', round, target: null, profile: 'default', complexity: null, findings: 0, at: new Date('2026-10-03T12:30:00Z') } as never);
    }
    const a = computeAnalytics(readHistory(h.log.dir, null).entries, h.pricing.current(), filter, NOW, []);
    assert.deepEqual(a.budget_insights.top_compact, { role: 'developer', round: 2, compacts: 2 });
  });

  it('reports round null without a stage result', () => {
    const h = setup();
    h.log.runFinished(finish('acme/app#1', 'r1', '2026-10-03T10:00:00Z', { role: 'developer', contextCompacts: 3 }));
    const a = computeAnalytics(readHistory(h.log.dir, null).entries, h.pricing.current(), filter, NOW, []);
    assert.deepEqual(a.budget_insights.top_compact, { role: 'developer', round: null, compacts: 3 });
  });
});
