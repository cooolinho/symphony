import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';
import { sessionClaudeConfig, effectiveCompactWindow } from '../src/agent/model.ts';
import { ClaudeAgentRunner } from '../src/agent/claude.ts';
import { PricingStore } from '../src/costs/pricing.ts';
import { HistoryLog, readHistory } from '../src/history/history.ts';
import { AGENT_HTML } from '../src/http/issue-page.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { startHttpServer } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { SymphonyError } from '../src/util/errors.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeIssue, makeWorkflow, renderPage, tempDir, until } from './helpers.ts';
import { analyticsFixture, entriesFixture, issueDetail, scoreTeam } from './helpers/page-fixtures.ts';

// #571, independent acceptance tests derived from the issue text: claude.auto_compact_window and its role override reach
// Claude Code as CLAUDE_CODE_AUTO_COMPACT_WINDOW, the dashboards show the real threshold.

const resolve = (front: Record<string, unknown>) => resolveConfig(front, { workflowPath: '/srv/WORKFLOW.md', env: {}, trackerDefaults });
const base = { tracker: { kind: 'github_project' } };
const invalid = (error: unknown, pattern: RegExp) => error instanceof SymphonyError && error.code === 'invalid_config' && pattern.test(error.message);
const roleFront = (value: unknown, global?: unknown) => ({
  ...base,
  tracker: { kind: 'github', active_states: ['In progress'] },
  ...(global !== undefined ? { claude: { auto_compact_window: global } } : {}),
  roles: { architect: { states: ['In progress'], claude: { auto_compact_window: value } } },
});

describe('#571 config: claude.auto_compact_window', () => {
  it('defaults to auto (null) without a claude section and without the key', () => {
    assert.equal(resolve(base).claude.autoCompactWindow, null);
    assert.equal(resolve({ ...base, claude: { model: 'opus' } }).claude.autoCompactWindow, null);
  });

  it('accepts both ends of the range, 100000 and 1000000', () => {
    assert.equal(resolve({ ...base, claude: { auto_compact_window: 100000 } }).claude.autoCompactWindow, 100000);
    assert.equal(resolve({ ...base, claude: { auto_compact_window: 1000000 } }).claude.autoCompactWindow, 1000000);
  });

  it('rejects values outside the range, non-integers and other types with a config error naming the key', () => {
    for (const bad of [0, -1, 99999, 1000001, 2000000, 100000.5, 'big', '', '1e5x', true, [200000], { n: 1 }]) {
      assert.throws(() => resolve({ ...base, claude: { auto_compact_window: bad } }), (e: unknown) => invalid(e, /claude\.auto_compact_window must be auto or an integer from 100000 to 1000000/), JSON.stringify(bad));
    }
  });
});

describe('#571 config: roles.<name>.claude.auto_compact_window', () => {
  const architect = (config: ReturnType<typeof resolve>) => config.roles?.find((r) => r.name === 'architect')?.claude.autoCompactWindow;

  it('is a known role key (no unknown-key error) and is parsed, at both ends of the range', () => {
    assert.equal(architect(resolve(roleFront(400000))), 400000);
    assert.equal(architect(resolve(roleFront(100000))), 100000);
    assert.equal(architect(resolve(roleFront(1000000))), 1000000);
  });

  it('is left unset for auto', () => {
    assert.equal(architect(resolve(roleFront('auto'))) ?? null, null);
  });

  it('rejects invalid role values with the role field in the message', () => {
    for (const bad of [50, 99999, 1000001, 150000.5, 'big']) {
      assert.throws(() => resolve(roleFront(bad)), (e: unknown) => invalid(e, /roles\.architect\.claude\.auto_compact_window must be auto or an integer from 100000 to 1000000/), JSON.stringify(bad));
    }
  });

  it('role value replaces the global one in the session config; a role without a value keeps the global one', () => {
    const config = resolve({ ...roleFront(400000, 200000), roles: { architect: { states: ['In progress'], claude: { auto_compact_window: 400000 } }, developer: { states: ['Todo'] } }, tracker: { kind: 'github', active_states: ['In progress', 'Todo'] } });
    const roles = Object.fromEntries((config.roles ?? []).map((r) => [r.name, r.claude]));
    assert.equal(sessionClaudeConfig(config.claude, null, null, roles.architect).autoCompactWindow, 400000);
    assert.equal(sessionClaudeConfig(config.claude, null, null, roles.developer).autoCompactWindow, 200000);
    assert.equal(effectiveCompactWindow(config.claude, roles.architect), 400000);
    assert.equal(effectiveCompactWindow(config.claude, roles.developer), 200000);
  });

  it('a role window without a global one applies to that role only', () => {
    const config = resolve(roleFront(300000));
    assert.equal(config.claude.autoCompactWindow, null);
    assert.equal(effectiveCompactWindow(config.claude, config.roles?.[0]?.claude), 300000);
    assert.equal(effectiveCompactWindow(config.claude, {}), null);
  });
});

describe('#571 WORKFLOW.md', () => {
  it('suggests 200000 globally and 400000 for the architect, and the shipped file is valid', async () => {
    const { definition } = await loadWorkflowFile(path.join(import.meta.dirname, '..', 'WORKFLOW.md'));
    const front = definition.config as { claude?: Record<string, unknown>; roles?: Record<string, { claude?: Record<string, unknown> }> };
    assert.equal(front.claude?.auto_compact_window, 200000);
    assert.equal(front.roles?.architect?.claude?.auto_compact_window, 400000);
    const config = resolveConfig(definition.config, { workflowPath: '/srv/WORKFLOW.md', env: {}, trackerDefaults });
    assert.equal(config.claude.autoCompactWindow, 200000);
    assert.equal(config.roles?.find((r) => r.name === 'architect')?.claude.autoCompactWindow, 400000);
  });
});

describe('#571 documentation', () => {
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, '..', file), 'utf8');
  it('documents the key in configuration.md (claude + roles table) and the stats card / marks in usage.md', () => {
    const configuration = read('docs/configuration.md');
    assert.ok((configuration.match(/auto_compact_window/g) ?? []).length >= 3, 'claude table, roles, run_finished');
    assert.ok(configuration.includes('CLAUDE_CODE_AUTO_COMPACT_WINDOW'));
    assert.match(configuration, /100000/);
    const usage = read('docs/usage.md');
    assert.match(usage, /auto_compact_window/);
    assert.match(usage, /compact_threshold/);
  });
});

// --------------------------------------------------------------------------------------------------------------------
// Session env

describe('#571 session env', () => {
  const envOf = async (claude: Record<string, unknown>, roleOverrides?: Parameters<typeof sessionClaudeConfig>[3]) => {
    const raw = resolve({ ...base, claude: { model: 'opus', ...claude } }).claude;
    const config = sessionClaudeConfig(raw, null, null, roleOverrides);
    let captured: Record<string, string | undefined> | undefined;
    const issue = makeIssue({ id: 'a' });
    const runner = new ClaudeAgentRunner({
      query: (({ options }: { options?: { env?: Record<string, string | undefined> } }) => {
        captured = options?.env;
        const it = { next: async () => ({ value: undefined, done: true }), return: async () => ({ value: undefined, done: true }), throw: async (e: unknown) => { throw e; }, [Symbol.asyncIterator]() { return this; }, initializationResult: async () => ({}), mcpServerStatus: async () => [], interrupt: async () => undefined, close: () => undefined };
        return it;
      }) as never,
    });
    const session = await runner.startSession({
      cwd: '/tmp', issue, config, tools: [], toolContext: () => ({ issue }), env: { PATH: '/usr/bin', KEEP: 'yes' }, logger: Logger.silent(), signal: new AbortController().signal, onEvent: () => undefined, transcriptPath: null,
    });
    await session.stop();
    return captured ?? {};
  };

  it('sets nothing for auto and when the key is absent, keeps the rest of the env', async () => {
    const none = await envOf({});
    assert.equal(none.CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined);
    assert.equal('CLAUDE_CODE_AUTO_COMPACT_WINDOW' in none, false);
    assert.equal(none.KEEP, 'yes');
    assert.equal('CLAUDE_CODE_AUTO_COMPACT_WINDOW' in (await envOf({ auto_compact_window: 'auto' })), false);
  });

  it('sets the number as a string for the global value and for the role override', async () => {
    assert.equal((await envOf({ auto_compact_window: 200000 })).CLAUDE_CODE_AUTO_COMPACT_WINDOW, '200000');
    assert.equal((await envOf({ auto_compact_window: 200000 }, { autoCompactWindow: 400000 })).CLAUDE_CODE_AUTO_COMPACT_WINDOW, '400000');
    assert.equal((await envOf({}, { autoCompactWindow: 100000 })).CLAUDE_CODE_AUTO_COMPACT_WINDOW, '100000');
  });

  it('an explicit claude.env value wins over both the global and the role window, other env keys stay', async () => {
    const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000', OTHER: 'x' };
    const result = await envOf({ auto_compact_window: 200000, env }, { autoCompactWindow: 400000 });
    assert.equal(result.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '500000');
    assert.equal(result.OTHER, 'x');
  });
});

// --------------------------------------------------------------------------------------------------------------------
// Orchestrator: dispatch, run_finished log and team API

describe('#571 orchestrator', () => {
  const front = (root: string) => baseFront(root, {
    tracker: { kind: 'github_project', provider: { owner: 'acme', project_number: 1, token: 'test-token' }, active_states: ['Todo', 'Agent review'] },
    agent: { max_turns: 3, max_continuations: 5 },
    claude: { model: 'sonnet', auto_compact_window: 200000 },
    roles: { developer: { states: ['Todo'] }, reviewer: { states: ['Agent review'], read_only: true, claude: { auto_compact_window: 400000 } } },
  });
  const orchestrator = (root: string, runner: FakeRunner, tracker: FakeTracker, extra: Record<string, unknown> = {}) =>
    new Orchestrator({ workflow: new StaticWorkflow(makeWorkflow(front(root))), runner, logger: Logger.silent(), env: {}, logDir: tempDir(), timers: new ManualTimers(), createAdapter: () => tracker, ...extra });

  it('hands the effective window per role to the session config and logs it in run_finished', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
    const history = new HistoryLog(path.join(dir, 'repositories'), new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent()), Logger.silent());
    const tracker = new FakeTracker([makeIssue({ id: 'd', identifier: 'acme/app#1' }), makeIssue({ id: 'r', identifier: 'acme/app#2', state: 'Agent review' })]);
    tracker.issueRepository = () => 'acme/app';
    const runner = new FakeRunner((turn, params) => {
      if (turn >= 2) {
        tracker.set('d', { state: 'In review' });
        tracker.set('r', { state: 'In review' });
      }
      void params;
      return { ok: true, turnId: String(turn), resultText: 'done' };
    });
    const orch = orchestrator(tempDir(), runner, tracker, { logDir: null, history });
    await orch.tickNow();
    await until(() => readHistory(history.dir, 'acme/app').entries.filter((e) => e.event === 'run_finished').length >= 2, 5_000, 'both runs finished');
    const windows = runner.sessions.map((s) => s.params.config.autoCompactWindow).sort();
    assert.deepEqual(windows, [200000, 400000]);
    const finished = readHistory(history.dir, 'acme/app').entries.filter((e) => e.event === 'run_finished');
    const byRole = Object.fromEntries(finished.map((e) => [e.fields.role, e.fields.auto_compact_window]));
    assert.deepEqual(byRole, { developer: '200000', reviewer: '400000' });
  });

  it('logs auto when no window is configured', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
    const history = new HistoryLog(path.join(dir, 'repositories'), new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent()), Logger.silent());
    const tracker = new FakeTracker([makeIssue({ id: 'a' })]);
    tracker.issueRepository = () => 'acme/app';
    const runner = new FakeRunner((turn) => {
      if (turn >= 2) tracker.set('a', { state: 'In review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    });
    const orch = new Orchestrator({ workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))), runner, logger: Logger.silent(), env: {}, logDir: null, timers: new ManualTimers(), createAdapter: () => tracker, history });
    await orch.tickNow();
    await until(() => readHistory(history.dir, 'acme/app').entries.some((e) => e.event === 'run_finished'), 5_000, 'run finished');
    assert.equal(runner.sessions[0]?.params.config.autoCompactWindow, null);
    assert.equal(readHistory(history.dir, 'acme/app').entries.find((e) => e.event === 'run_finished')?.fields.auto_compact_window, 'auto');
  });

  it('serves compact_window and compact_windows per role in the team API, compact_threshold unchanged', async () => {
    const tracker = new FakeTracker([makeIssue({ id: 'live' })]);
    const orch = orchestrator(tempDir(), new FakeRunner(() => new Promise(() => undefined)), tracker);
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator: orch, logger: Logger.silent() });
    try {
      await orch.tickNow();
      const body = await new Promise<string>((ok, fail) => {
        http.get({ host: '127.0.0.1', port: server.port, path: `/api/v1/${encodeURIComponent('acme/app#live')}/team` }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (text += c));
          res.on('end', () => ok(text));
        }).on('error', fail);
      });
      const team = JSON.parse(body);
      assert.equal(team.compact_window, 200000);
      assert.deepEqual(team.compact_windows, { developer: 200000, reviewer: 400000 });
      assert.equal(team.compact_threshold, 80);
    } finally {
      await server.close();
    }
  });
});

// --------------------------------------------------------------------------------------------------------------------
// Team view mark

describe('#571 team view: compact mark', () => {
  const opts = { url: 'http://127.0.0.1/issue?id=acme%2Fapp%231' };
  const session = (run: string, over: Record<string, unknown> = {}) => ({ run, attempt: null, role: 'developer', state: 'In progress', model: null, effort: null, started_at: '2026-10-30T11:00:00Z', finished_at: null, outcome: null, transcript: `/t/${run}.jsonl`, ...over });
  const page = (team: Record<string, unknown>, contextWindow = 1_000_000) => {
    const detail = issueDetail({ sessions: [session('run-3')] });
    detail.running.context = { tokens: 100000, window: contextWindow, percent: 10, compacts: 0 };
    const call = (offset: number, at: string, tokens: number) => ({
      type: 'model_call', offset, at: `2026-10-30T${at}Z`, message_id: `m${offset}`, model: 'claude-opus-5-5', cost_usd: 0.01, stop_reason: null, error: null, parent_tool_use_id: null, blocks: [],
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: tokens - 3000, cache_write_tokens: 2000 },
    });
    const tx = new Map([['run-3', { available: true, entries: [call(1, '11:35:00', 20000), call(2, '11:45:00', 40000)], offset: 0, done: false, reason: null }]]);
    return renderPage(AGENT_HTML, { detail, team: scoreTeam({ live: true }, team), tx, dirty: true, ctxEntries: [] }, opts);
  };
  const label = (p: ReturnType<typeof page>) => p.$('ctx-chart').querySelector('svg')!.querySelector('text.ctx-thr-label')!.textContent;

  it('puts the mark at window / model window of the role', () => {
    assert.equal(label(page({ compact_windows: { developer: 200000 }, compact_window: null })), 'Auto-Compact 20 %');
    assert.equal(label(page({ compact_windows: { developer: 400000 } })), 'Auto-Compact 40 %');
  });

  it('role window beats the global window; a role not listed falls back to the global window', () => {
    assert.equal(label(page({ compact_windows: { developer: 200000 }, compact_window: 500000 })), 'Auto-Compact 20 %');
    assert.equal(label(page({ compact_windows: { architect: 400000 }, compact_window: 500000 })), 'Auto-Compact 50 %');
  });

  it('keeps budget.compact_threshold without any window, with null windows and on old team payloads', () => {
    assert.equal(label(page({ compact_windows: {}, compact_window: null })), 'Auto-Compact 80 %');
    assert.equal(label(page({ compact_windows: { developer: null }, compact_window: null })), 'Auto-Compact 80 %');
    assert.equal(label(page({ compact_threshold: 65 })), 'Auto-Compact 65 %');
  });

  it('is relative to the model window of the session and never exceeds 100 %', () => {
    assert.equal(label(page({ compact_windows: { developer: 200000 } }, 400000)), 'Auto-Compact 50 %');
    assert.equal(label(page({ compact_windows: { developer: 400000 } }, 200000)), 'Auto-Compact 100 %');
  });

  it('keeps the context percent of the session relative to the model window, only the mark moves', () => {
    const p = page({ compact_windows: { developer: 100000 } });
    const text = p.$('stage-session-body').textContent;
    assert.match(text, /84k \/ 200k · 42 %/, text);
    assert.match(text, /Auto-Compact ab ca\. 50 %/, text);
  });
});

// --------------------------------------------------------------------------------------------------------------------
// Stats card

describe('#571 stats card: Auto-Compacts je Rolle', () => {
  const developer = { ...analyticsFixture().by_role[0], role: 'developer' };
  const days = [{ date: '2026-10-30', peak_5h_tokens: 1500, limit_hits: 0 }];
  const load = async (budget: object) => {
    const p = renderPage(LOGS_HTML, undefined, {
      url: 'http://127.0.0.1/stats',
      fetch: (url: string) => (url.startsWith('/api/v1/history/entries') ? entriesFixture() : analyticsFixture({ by_role: [developer], budget })),
    });
    await until(() => p.$('log-count').textContent === '1' && p.query('[data-body="kpi"] .ui-kpi').length > 0, 3000, 'the page to load');
    return p;
  };
  const body = (p: Awaited<ReturnType<typeof load>>) => p.query('[data-body="compacts"]')[0]!;

  it('shows the hint with the configured windows when every role has 0 compacts', async () => {
    const p = await load({ days, compacts_by_role: { developer: 0, architect: 0 }, compact_windows_by_role: { developer: 200000, architect: 400000 }, avg_context_by_role: {} });
    assert.equal(p.query('[data-body="compacts"] .hbar').length, 0);
    const text = body(p).textContent;
    assert.ok(text.includes('Kein Run hat verdichtet'), text);
    assert.ok(text.includes('Auto-Compact-Fenster'), text);
    assert.ok(text.includes('developer') && text.includes('200') && text.includes('architect') && text.includes('400'), text);
  });

  it('says auto when no window was logged', async () => {
    const p = await load({ days, compacts_by_role: { developer: 0 }, avg_context_by_role: {} });
    assert.ok(body(p).textContent.includes('Kein Run hat verdichtet'));
    assert.match(body(p).textContent, /auto/);
  });

  it('draws bars, not the hint, as soon as one role compacted', async () => {
    const p = await load({ days, compacts_by_role: { developer: 2, architect: 0 }, compact_windows_by_role: { developer: 200000 }, avg_context_by_role: {} });
    assert.ok(p.query('[data-body="compacts"] .hbar').length >= 1);
    assert.ok(!body(p).textContent.includes('Kein Run hat verdichtet'));
  });

  it('keeps the no-data message when no run logged context data', async () => {
    const p = await load({ days, compacts_by_role: {}, compact_windows_by_role: { developer: 200000 }, avg_context_by_role: {} });
    assert.ok(body(p).textContent.includes('Context-Daten'), body(p).textContent);
    assert.ok(!body(p).textContent.includes('Kein Run hat verdichtet'));
  });
});
