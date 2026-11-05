import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Logger } from '../src/log.ts';
import { computeAnalytics, type AnalyticsFilter } from '../src/history/analytics.ts';
import { HistoryLog, readHistory } from '../src/history/history.ts';
import { PricingStore } from '../src/costs/pricing.ts';
import { createGuard, guardTools, toolsForRole } from '../src/orchestrator/guard.ts';
import { pestMutationAvailability } from '../src/orchestrator/mutation.ts';
import { RESULT_TOOL, createResultTool, type ResultToolParams } from '../src/orchestrator/result-tool.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import type { Issue, ToolResult } from '../src/tracker/types.ts';
import { decodeMarker, encodeMarker, parseResult, renderResultMarkdown } from '../src/workflow/results.ts';
import { WorkspaceManager } from '../src/workspace/manager.ts';
import { FakeTracker, baseFront, makeIssue, makeWorkflow, renderPage, tempDir, until } from './helpers.ts';
import { analyticsFixture, entriesFixture } from './helpers/page-fixtures.ts';

// E3-7 (#508): independent tests derived from the issue: RED at base per new case, mutation score, availability.

const TESTER = {
  states: ['Testing'],
  result: 'test',
  may_move_to: ['Documentation', 'Agent review', 'In progress', 'Blocked'],
  on_result: { passed: 'Agent review', failed: 'In progress' },
};

function tester(labels: string[], mutation?: ResultToolParams['mutation']) {
  const root = tempDir('symphony-e37-');
  const front = baseFront(root, {
    tracker: {
      kind: 'github_project',
      provider: { owner: 'acme', project_number: 1, token: 'test-token' },
      active_states: ['Testing'],
    },
    roles: { tester: TESTER },
    pipeline: { max_review_rounds: 3, max_test_rounds: 2 },
    checks: { timeout_ms: 10_000, on_enter: {} },
  });
  const config = makeWorkflow(front).config;
  const workspacePath = path.join(root, 'ws');
  fs.mkdirSync(workspacePath);
  const manager = new WorkspaceManager({ root, hooks: config.hooks, workflowDir: root }, { PATH: process.env.PATH }, Logger.silent());
  const role = config.roles?.find((r) => r.name === 'tester');
  assert.ok(role);
  const tracker = new FakeTracker([makeIssue({ id: '1', state: 'Testing', labels })]);
  const current = (): Issue => tracker.issues.get('1')!;
  const guard = createGuard({
    role,
    config,
    workspace: { path: workspacePath, key: 'ws', createdNow: false },
    issue: () => ({ id: '1', identifier: 'acme/app#1' }),
    manager,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  const params: ResultToolParams = {
    role,
    history: { reviewRounds: 0, testRounds: 0 },
    profile: null,
    flags: {},
    config,
    boardColumns: null,
    adapter: tracker,
    issue: current,
    runId: 'run-1',
    meta: { workflowHash: 'f'.repeat(64), headSha: async () => 'abc123def456abc1', now: () => new Date('2026-10-18T12:00:00Z') },
    ...(mutation !== undefined ? { mutation } : {}),
  };
  const tools = guardTools(toolsForRole(tracker.agentToolSpecs(), role, current(), createResultTool(params)), guard);
  const tool = tools.find((spec) => spec.name === RESULT_TOOL)!;
  assert.ok(tool);
  return {
    tracker,
    report: (args: Record<string, unknown>) => tool.execute(args, { issue: current() }),
    comments: () => (tracker.comments.get('1') ?? []).map((c) => c.body),
  };
}

const ok = (r: ToolResult) => {
  assert.ok(r.ok, r.ok ? '' : `${r.error.category}: ${r.error.message}`);
  return r.data as Record<string, unknown>;
};
const refused = (r: ToolResult) => {
  assert.ok(!r.ok, 'expected a refusal');
  return r.error;
};

const RED = { command: 'vendor/bin/pest --filter=Foo', output: 'FAILED  Tests\\Feature\\FooTest' };
const kase = (name: string, over: Record<string, unknown> = {}) => ({ criterion: `crit ${name}`, test: `tests/${name}.php`, status: 'passed', ...over });
const passed = (cases: unknown[], over: Record<string, unknown> = {}) => ({ verdict: 'passed', summary: 'Tested.', cases, ...over });

function laravelApp(root: string, pest: string | null, dir = '.') {
  const app = path.join(root, dir);
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'artisan'), '');
  fs.writeFileSync(path.join(app, 'composer.json'), JSON.stringify({ require: { 'laravel/framework': '^12.0' } }));
  if (pest !== null) fs.writeFileSync(path.join(app, 'composer.lock'), JSON.stringify({ packages: [{ name: 'pestphp/pest', version: pest }], 'packages-dev': [] }));
  return root;
}

describe('E3-7 report_result: RED at base for new cases', () => {
  it('accepts L and XL when every new case has red_at_base (output optional)', async () => {
    for (const size of ['L', 'XL']) {
      const t = tester([`Complexity: ${size}`]);
      ok(await t.report(passed([kase('a', { red_at_base: RED }), kase('b', { red_at_base: { command: 'pest b' } })])));
      assert.equal(t.comments().length, 1);
      assert.match(t.comments()[0]!, /RED at base/);
    }
  });

  it('refuses one new case without red_at_base and names exactly that case; nothing is recorded', async () => {
    const t = tester(['Complexity: XL']);
    const e = refused(await t.report(passed([kase('first', { red_at_base: RED }), kase('second'), kase('third', { red_at_base: RED })])));
    assert.equal(e.category, 'invalid_result');
    assert.match(e.message, /red_at_base/);
    assert.match(e.message, /second/);
    assert.doesNotMatch(e.message, /first/);
    assert.doesNotMatch(e.message, /third/);
    assert.equal(t.comments().length, 0);
    assert.deepEqual(t.tracker.statusCalls, []);
  });

  it('also refuses a failed verdict whose new case lacks red_at_base, and an explicit existing:false', async () => {
    const t = tester(['Complexity: L']);
    const failed = { verdict: 'failed', summary: 'x', cases: [kase('a', { status: 'failed' })] };
    assert.equal(refused(await t.report(failed)).category, 'invalid_result');
    assert.equal(refused(await t.report(passed([kase('a', { existing: false })]))).category, 'invalid_result');
  });

  it('accepts a retry after the refusal', async () => {
    const t = tester(['Complexity: L']);
    refused(await t.report(passed([kase('a')])));
    ok(await t.report(passed([kase('a', { red_at_base: RED })])));
  });

  it('rejects malformed red_at_base (no command, empty command, unknown key)', () => {
    for (const bad of [{ output: 'x' }, { command: '' }, { command: 'x', extra: 1 }, 'pest']) {
      assert.equal(parseResult('test', passed([kase('a', { red_at_base: bad })])).ok, false, JSON.stringify(bad));
    }
  });

  it('S, M and unlabelled issues do not need red_at_base and may carry it', async () => {
    for (const labels of [['Complexity: S'], ['Complexity: M'], []]) {
      ok(await tester(labels).report(passed([kase('a')])));
      ok(await tester(labels).report(passed([kase('a', { red_at_base: RED })], { mutation_score: 40, mutation_command: 'pest --mutate --covered-only' })));
    }
  });

  it('keeps red_at_base in the stored marker and in the rendered comment', async () => {
    const t = tester(['Complexity: L']);
    ok(await t.report(passed([kase('a', { red_at_base: RED })])));
    const marker = decodeMarker(t.comments()[0]!);
    assert.ok(marker !== null && marker.result.kind === 'test');
    assert.deepEqual(marker.result.cases[0]?.red_at_base, RED);
    assert.match(t.comments()[0]!, /vendor\/bin\/pest --filter=Foo/);
  });
});

describe('E3-7 report_result: mutation score', () => {
  const CMD = 'vendor/bin/pest --mutate --covered-only';
  const cases = () => [kase('a', { red_at_base: RED })];
  const facts = (driver: string, pest: string | null = 'v3.8.0', dir = '.') => ({ workspace: laravelApp(tempDir('symphony-e37-ws-'), pest, dir), php: async () => driver });

  it('refuses an L/XL passed result without score where Pest 3 and a driver are available', async () => {
    for (const driver of ['pcov', 'xdebug']) {
      const e = refused(await tester(['Complexity: XL'], facts(driver)).report(passed(cases())));
      assert.equal(e.category, 'invalid_result');
      assert.match(e.message, /mutation_score/);
      assert.match(e.message, /--mutate --covered-only/);
    }
  });

  it('accepts the score together with the command, shows it in the comment, and keeps it in the marker', async () => {
    const t = tester(['Complexity: L'], facts('pcov'));
    ok(await t.report(passed(cases(), { mutation_score: 91.3, mutation_command: CMD })));
    assert.match(t.comments()[0]!, /91\.3/);
    const marker = decodeMarker(t.comments()[0]!);
    assert.ok(marker !== null && marker.result.kind === 'test');
    assert.equal(marker.result.mutation_score, 91.3);
    assert.equal(marker.result.mutation_command, CMD);
  });

  it('accepts the boundary scores 0 and 100 and refuses values outside 0..100 and a score without command', async () => {
    for (const score of [0, 100]) ok(await tester(['Complexity: L'], facts('pcov')).report(passed(cases(), { mutation_score: score, mutation_command: CMD })));
    for (const score of [-0.1, 100.1]) assert.equal(refused(await tester(['Complexity: L'], facts('pcov')).report(passed(cases(), { mutation_score: score, mutation_command: CMD }))).category, 'invalid_result');
    assert.equal(refused(await tester(['Complexity: L'], facts('pcov')).report(passed(cases(), { mutation_score: 80 }))).category, 'invalid_result');
    assert.equal(refused(await tester(['Complexity: L'], facts('pcov')).report(passed(cases(), { mutation_score: 80, mutation_command: '  ' }))).category, 'invalid_result');
  });

  it('a blank mutation_problem is refused and does not replace the score', async () => {
    const e = refused(await tester(['Complexity: L'], facts('pcov')).report(passed(cases(), { mutation_problem: '   ' })));
    assert.equal(e.category, 'invalid_result');
  });

  it('does not require a score without a driver, with Pest 2, without Pest, or without a Laravel app', async () => {
    const unavailable = [facts(''), facts('pcov', 'v2.36.0'), facts('pcov', null), { workspace: tempDir('symphony-e37-empty-'), php: async () => 'pcov' }];
    for (const f of unavailable) ok(await tester(['Complexity: XL'], f).report(passed(cases())));
  });

  it('does not require a score when PHP detection throws', async () => {
    const f = { ...facts('pcov'), php: async () => { throw new Error('php missing'); } };
    ok(await tester(['Complexity: XL'], f).report(passed(cases())));
  });

  it('does not require a score at S/M even when mutation testing is available', async () => {
    for (const label of ['Complexity: S', 'Complexity: M']) ok(await tester([label], facts('pcov')).report(passed([kase('a')])));
  });

  it('does not ask for a score on a blocked result', async () => {
    const blocked = { verdict: 'blocked', summary: 'no db', blockers: [{ description: 'no db', needs: 'infra' }], cases: [] };
    ok(await tester(['Complexity: XL'], facts('pcov')).report(blocked));
  });

  it('finds an app in a subdirectory and Pest in the second of two apps', async () => {
    const root = tempDir('symphony-e37-ws-');
    laravelApp(root, null, 'old');
    laravelApp(root, '3.0.0', 'web');
    const r = await pestMutationAvailability({ workspace: root, php: async () => 'xdebug' });
    assert.equal(r.available, true);
    if (r.available) assert.equal(r.app, 'web');
  });

  it('ignores artisan apps inside vendor and node_modules', async () => {
    const root = tempDir('symphony-e37-ws-');
    laravelApp(root, '3.0.0', 'vendor');
    laravelApp(root, '3.0.0', 'node_modules');
    assert.equal((await pestMutationAvailability({ workspace: root, php: async () => 'pcov' })).available, false);
  });

  it('reads the real php binary from PATH by default (a stub reporting xdebug)', async () => {
    const bin = tempDir('symphony-e37-bin-');
    fs.writeFileSync(path.join(bin, 'php'), '#!/bin/sh\necho xdebug\n', { mode: 0o755 });
    const before = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${before}`;
    try {
      const r = await pestMutationAvailability({ workspace: laravelApp(tempDir('symphony-e37-ws-'), '3.1.0') });
      assert.equal(r.available, true);
    } finally {
      process.env.PATH = before;
    }
  });

  it('never throws for a missing workspace', async () => {
    const r = await pestMutationAvailability({ workspace: path.join(tempDir('symphony-e37-'), 'nope'), php: async () => 'pcov' });
    assert.equal(r.available, false);
  });
});

describe('E3-7 result contract: optional at S/M, strict at L/XL', () => {
  it('parses a bare test result without the new fields (no context)', () => {
    assert.equal(parseResult('test', passed([kase('a')])).ok, true);
  });

  it('renders mutation score and RED proof of a parsed result and round-trips the marker', () => {
    const parsed = parseResult('test', passed([kase('a', { red_at_base: RED })], { mutation_score: 66.7, mutation_command: 'pest --mutate --covered-only' }));
    assert.ok(parsed.ok);
    const meta = { role: 'tester', run: 'run-1', round: 1, profile: 'standard', workflow_hash: 'f'.repeat(64), head_sha: 'a'.repeat(40), checks: null, target: 'Agent review', created_at: '2026-10-18T10:00:05.000Z' } as never;
    const body = renderResultMarkdown(parsed.result, meta);
    assert.match(body, /66\.7/);
    assert.match(body, /pest --mutate --covered-only/);
    assert.ok(decodeMarker(encodeMarker(parsed.result, meta)) !== null);
  });
});

describe('E3-7 analytics: mutation score per issue (E0-9)', () => {
  const NOW = new Date('2026-10-06T00:00:00Z');
  const filter: AnalyticsFilter = { from: null, to: null, repo: null, model: null, timeZone: 'UTC' };
  function log() {
    const dir = tempDir();
    const file = path.join(dir, 'model-costs.yml');
    fs.writeFileSync(file, 'default: { input: 5, output: 25 }\n');
    const pricing = new PricingStore(file, Logger.silent());
    return { log: new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent()), pricing };
  }
  const line = (repo: string, issue: string, at: string, over: Record<string, unknown> = {}) => ({
    repo, issue, run: null, role: 'tester', kind: 'test', verdict: 'passed', round: null, target: null, profile: 'feature', complexity: 'XL', findings: 0, at: new Date(at), ...over,
  });

  it('keeps scores of equal issue numbers in different repositories apart, ignores lines without score, orders newest first, keeps 0', () => {
    const h = log();
    h.log.stageResult(line('acme/app', 'acme/app#1', '2026-10-03T10:00:00Z', { mutationScore: 0 }));
    h.log.stageResult(line('other/repo', 'other/repo#1', '2026-10-03T12:00:00Z', { mutationScore: 55.5, complexity: 'L' }));
    h.log.stageResult(line('acme/app', 'acme/app#2', '2026-10-03T13:00:00Z'));
    h.log.stageResult(line('acme/app', 'acme/app#3', '2026-10-03T14:00:00Z', { kind: 'review', verdict: 'approved' }));
    const entries = readHistory(h.log.dir, null).entries;
    const lines = entries.filter((e) => e.event === 'stage_result');
    assert.equal(lines.length, 4);
    assert.equal(lines.filter((e) => e.fields.mutation_score !== undefined).length, 2, 'only lines with a score carry the field (0 included)');
    const scores = computeAnalytics(entries, h.pricing.current(), filter, NOW).subagent_evaluation.mutation_scores;
    assert.deepEqual(scores.map((s) => [s.repo, s.issue, s.mutation_score, s.complexity]), [['other/repo', 'other/repo#1', 55.5, 'L'], ['acme/app', 'acme/app#1', 0, 'XL']]);
  });

  it('is an empty list without any score', () => {
    const h = log();
    h.log.stageResult(line('acme/app', 'acme/app#1', '2026-10-03T10:00:00Z'));
    assert.deepEqual(computeAnalytics(readHistory(h.log.dir, null).entries, h.pricing.current(), filter, NOW).subagent_evaluation.mutation_scores, []);
  });
});

describe('E3-7 statistics page: mutation score per issue', () => {
  const open = async (scores: unknown[]) => {
    const base = analyticsFixture();
    const over = { subagent_evaluation: { ...base.subagent_evaluation, mutation_scores: scores } };
    const page = renderPage(LOGS_HTML, undefined, {
      url: 'http://127.0.0.1/stats',
      fetch: (u: string) => (u.startsWith('/api/v1/history/entries') ? entriesFixture() : analyticsFixture(over)),
    });
    await until(() => page.$('log-count').textContent === '1' && page.query('[data-body="kpi"] .ui-kpi').length > 0, 3000, 'the page to load');
    return page;
  };

  it('lists issue, complexity and score', async () => {
    const page = await open([{ issue: 'acme/app#7', repo: 'acme/app', complexity: 'XL', mutation_score: 83.5, at: '2026-10-30T10:00:00.000Z' }]);
    const text = page.query('[data-body="mutation-scores"]').map((n) => n.textContent).join(' ');
    assert.match(text, /acme\/app#7/);
    assert.match(text, /83\.5/);
    assert.match(text, /XL/);
  });

  it('shows no block without scores', async () => {
    const page = await open([]);
    const nodes = page.query('[data-body="mutation-scores"]');
    assert.ok(nodes.every((n) => (n as { hidden?: boolean }).hidden === true || n.textContent.trim() === ''));
  });
});

describe('E3-7 documentation', () => {
  const read = (f: string) => fs.readFileSync(f, 'utf8');
  it('docs/results.md documents the fields and the rule; docs/docker.md notes Xdebug/PCOV', () => {
    const results = read('docs/results.md');
    for (const term of ['red_at_base', 'mutation_score', '--mutate --covered-only']) assert.ok(results.includes(term), term);
    const docker = read('docs/docker.md');
    assert.match(docker, /Xdebug/);
    assert.match(docker, /PCOV/i);
  });
});
