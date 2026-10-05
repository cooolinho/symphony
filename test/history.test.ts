import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { costOf, estimateCost, parsePricing, priceFor, PricingStore } from '../src/costs/pricing.ts';
import { computeHistoryStats, HistoryLog, parseHistoryLine, readHistory } from '../src/history/history.ts';
import { Logger } from '../src/log.ts';
import { tempDir } from './helpers.ts';

const PRICES = `
default:
  input: 5
  output: 25
opus:
  input: 4
  output: 20
  cache_read: 0.2
claude-opus-4-8:
  input: 5
  output: 25
haiku: { input: 1, output: 5 }
`;

describe('model costs', () => {
  const table = parsePricing(PRICES, 'model-costs.yml');

  it('matches exact ids first, then the longest contained name, then default', () => {
    assert.equal(priceFor(table, 'claude-opus-4-8').key, 'claude-opus-4-8');
    assert.equal(priceFor(table, 'claude-opus-5-5').key, 'opus');
    assert.equal(priceFor(table, 'Claude-Haiku-4-5').key, 'haiku');
    assert.equal(priceFor(table, 'claude-sonnet-5-5').key, 'default');
  });

  it('prices input, output and cache tokens per million, with cache defaults from the input price', () => {
    const haiku = priceFor(table, 'claude-haiku-4-5').price;
    assert.deepEqual(haiku, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 400_000 };
    assert.equal(costOf(usage, priceFor(table, 'claude-opus-5-5').price), 4 + 2 + 0.4 + 2);
    assert.equal(estimateCost(table, { 'claude-opus-5-5': usage, 'claude-haiku-4-5': { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }), 9.4);
  });

  it('rejects entries without prices and keeps the last good table on a bad edit', () => {
    assert.throws(() => parsePricing('opus: 5', null), { code: 'invalid_model_costs' });
    assert.throws(() => parsePricing('opus:\n  input: 1', null), /opus.output is required/);
    const dir = tempDir();
    const file = path.join(dir, 'model-costs.yml');
    fs.writeFileSync(file, PRICES);
    const store = new PricingStore(file, Logger.silent());
    assert.equal(priceFor(store.current(), 'claude-opus-5-5').price.input, 4);
    fs.writeFileSync(file, 'opus: [broken\n# changed size');
    assert.equal(priceFor(store.current(), 'claude-opus-5-5').price.input, 4);
    assert.notEqual(store.lastError, null);
  });

  it('falls back to the built-in default without a file', () => {
    const store = new PricingStore(path.join(tempDir(), 'missing.yml'), Logger.silent());
    assert.equal(priceFor(store.current(), 'claude-opus-5-5').key, 'default');
  });
});

describe('repository history', () => {
  function history() {
    const dir = tempDir();
    const file = path.join(dir, 'model-costs.yml');
    fs.writeFileSync(file, PRICES);
    const pricing = new PricingStore(file, Logger.silent());
    return { log: new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent()), pricing };
  }
  const usage = { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 100_000, cacheWriteTokens: 10_000 };
  const finish = (issue: string, run: string, at: string, overrides = {}) => ({
    repo: 'acme/app',
    issue,
    title: `Title of ${issue}`,
    run,
    session: 'thread-1',
    attempt: null,
    outcome: 'handed_off' as const,
    state: 'In review',
    reason: 'issue left the active states ("In review")',
    turns: 2,
    startedAt: new Date(new Date(at).getTime() - 60_000),
    finishedAt: new Date(at),
    agentSeconds: 60,
    usage: { 'claude-opus-5-5': usage },
    claudeEstimateUsd: 0.5,
    ...overrides,
  });

  it('logs head_sha, branch and mcp_tool_calls only when present', () => {
    const { log } = history();
    log.runFinished(finish('acme/app#1', 'r1', '2026-10-04T08:01:00Z', { headSha: 'abc123', branch: 'symphony/issue-1', mcpToolCalls: { 'laravel-boost': 2, tracker: 1 } }));
    log.runFinished(finish('acme/app#2', 'r2', '2026-10-04T09:01:00Z', { headSha: null, branch: null, mcpToolCalls: {} }));
    const [first, second] = readHistory(log.dir, 'acme/app').entries.filter((e) => e.event === 'run_finished');
    assert.equal(first?.fields.head_sha, 'abc123');
    assert.equal(first?.fields.branch, 'symphony/issue-1');
    assert.equal(first?.fields.mcp_tool_calls, 'laravel-boost:2,tracker:1');
    for (const key of ['head_sha', 'branch', 'mcp_tool_calls']) assert.equal(key in (second?.fields ?? {}), false);
  });

  it('records the role of a run in run_started', () => {
    const { log } = history();
    log.runStarted({ repo: 'acme/app', issue: 'acme/app#1', title: 'Review', state: 'Agent review', attempt: null, model: 'opus', role: 'reviewer', run: 'r1', at: new Date('2026-10-04T08:00:00Z') });
    const started = parseHistoryLine(fs.readFileSync(log.fileFor('acme/app'), 'utf8').trim());
    assert.equal(started?.fields.role, 'reviewer');
  });

  it('adds integration fields to run_started', () => {
    const { log } = history();
    log.runStarted({ repo: 'acme/app', issue: 'acme/app#1', title: 'T', state: 'Ready', attempt: null, model: null, run: 'r1', at: new Date('2026-10-04T08:00:00Z'), extra: { laravel: 'laravel/:v13.1.0', boost: 'ready' } });
    const started = parseHistoryLine(fs.readFileSync(log.fileFor('acme/app'), 'utf8').trim());
    assert.equal(started?.fields.laravel, 'laravel/:v13.1.0');
    assert.equal(started?.fields.boost, 'ready');
  });

  it('appends key=value lines per repository with running totals', () => {
    const { log } = history();
    log.runStarted({ repo: 'acme/app', issue: 'acme/app#1', title: 'Fix "quotes" and = signs', state: 'Ready', attempt: null, model: 'opus', run: 'r1', at: new Date('2026-10-04T08:00:00Z') });
    log.runFinished(finish('acme/app#1', 'r1', '2026-10-04T08:01:00Z'));
    log.runFinished(finish('acme/app#2', 'r2', '2026-10-04T09:01:00Z'));
    log.note('other/repo', 'workspace_removed', { issue: 'other/repo#7', state: 'Done' });

    assert.deepEqual(fs.readdirSync(log.dir).sort(), ['acme_app.log', 'other_repo.log']);
    const lines = fs.readFileSync(log.fileFor('acme/app'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 5);
    const started = parseHistoryLine(lines[0] as string);
    assert.equal(started?.event, 'run_started');
    assert.equal(started?.fields.title, 'Fix "quotes" and = signs');
    assert.equal(started?.fields.role, 'default');
    const second = parseHistoryLine(lines[3] as string);
    assert.equal(second?.event, 'run_finished');
    assert.equal(second?.fields.repo_runs, '2');
    assert.equal(second?.fields.repo_tokens, String(2 * 113_000));
    assert.equal(second?.fields.model, 'claude-opus-5-5');
    assert.equal(second?.fields.mcp_unavailable, undefined);
    const modelLine = parseHistoryLine(lines[4] as string);
    assert.equal(modelLine?.event, 'model_usage');
    assert.equal(modelLine?.fields.price, 'opus');
  });

  it('lists unavailable MCP servers in run_finished', () => {
    const { log } = history();
    log.runFinished(finish('acme/app#1', 'r1', '2026-10-04T08:01:00Z', { mcpUnavailable: ['laravel-boost', 'docs'] }));
    log.runFinished(finish('acme/app#1', 'r2', '2026-10-04T08:05:00Z', { mcpUnavailable: [] }));
    const [first, second] = readHistory(log.dir, 'acme/app').entries.filter((e) => e.event === 'run_finished');
    assert.equal(first?.fields.mcp_unavailable, 'laravel-boost,docs');
    assert.equal(second?.fields.mcp_unavailable, undefined);
  });

  it('continues the running totals from an existing file', () => {
    const { log, pricing } = history();
    log.runFinished(finish('acme/app#1', 'r1', '2026-10-04T08:01:00Z'));
    const again = new HistoryLog(log.dir, pricing, Logger.silent());
    again.runFinished(finish('acme/app#1', 'r2', '2026-10-04T08:05:00Z'));
    const last = readHistory(log.dir, 'acme/app').entries.filter((e) => e.event === 'run_finished').at(-1);
    assert.equal(last?.fields.repo_runs, '2');
  });

  it('computes statistics per model, repository, issue and day with the current prices', () => {
    const { log, pricing } = history();
    log.runFinished(finish('acme/app#1', 'r1', '2026-10-03T10:00:00Z'));
    log.runFinished(finish('acme/app#1', 'r2', '2026-10-04T10:00:00Z', { outcome: 'failed', state: 'In progress', usage: { 'claude-opus-5-5': usage, 'claude-haiku-4-5': usage } }));
    log.runFinished({ ...finish('other/repo#3', 'r3', '2026-10-04T11:00:00Z'), repo: 'other/repo' });
    const { entries } = readHistory(log.dir, null);
    const stats = computeHistoryStats(entries, pricing.current());

    assert.equal(stats.totals.runs, 3);
    assert.equal(stats.totals.issues, 2);
    assert.equal(stats.totals.repositories, 2);
    assert.equal(stats.totals.total_tokens, 4 * 113_000);
    assert.equal(stats.totals.agent_seconds, 180);
    const opusCost = costOf(usage, priceFor(pricing.current(), 'claude-opus-5-5').price);
    const haikuCost = costOf(usage, priceFor(pricing.current(), 'claude-haiku-4-5').price);
    assert.equal(stats.totals.cost_usd, Math.round((3 * opusCost + haikuCost) * 10_000) / 10_000);
    assert.deepEqual(stats.models.map((m) => [m.model, m.runs, m.price]), [['claude-opus-5-5', 3, 'opus'], ['claude-haiku-4-5', 1, 'haiku']]);
    assert.deepEqual(stats.repositories.map((r) => [r.repo, r.runs, r.issues]), [['acme/app', 2, 1], ['other/repo', 1, 1]]);
    const issue = stats.issues.find((i) => i.issue === 'acme/app#1');
    assert.equal(issue?.runs, 2);
    assert.equal(issue?.last_outcome, 'failed');
    assert.equal(stats.days.length, 2);
    assert.equal(stats.recent[0]?.event, 'run_finished');
    assert.equal(stats.recent.some((r) => r.event === 'model_usage'), false);

    const filtered = computeHistoryStats(readHistory(log.dir, 'other/repo').entries, pricing.current());
    assert.equal(filtered.totals.runs, 1);
  });
});
