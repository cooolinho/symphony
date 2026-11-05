import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentRunner, type QueryFn } from '../src/agent/claude.ts';
import type { AgentEvent, StartSessionParams } from '../src/agent/types.ts';
import { PricingStore } from '../src/costs/pricing.ts';
import { computeAnalytics, type AnalyticsFilter } from '../src/history/analytics.ts';
import { HistoryLog, parseCounts, readHistory } from '../src/history/history.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { copyToolUsage, countToolUse, emptyToolUsage } from '../src/orchestrator/tool-usage.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { AsyncQueue } from '../src/util/async.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, baseFront, makeIssue, makeWorkflow, renderPage, tempDir, until } from './helpers.ts';
import { analyticsFixture, entriesFixture } from './helpers/page-fixtures.ts';

// Independent acceptance tests for E0-6 (#487), derived from the issue: tool_calls stays the total, subagent_tool_calls
// counts the calls made inside subagents, the statistics show main-thread calls as the difference. Fixture: the
// marktausschuss#205 developer session with 112 tool calls (Bash 95), 11 Bash and 1 SubagentHandback of them in subagents.

/** The 112 calls of the #205 developer session: [tool, count, made inside a subagent]. Bash 84 + 11 = 95 in total. */
const SESSION: Array<[string, number, boolean]> = [
  ['Bash', 84, false],
  ['Read', 10, false],
  ['Edit', 4, false],
  ['Grep', 1, false],
  ['Agent', 1, false],
  ['Bash', 11, true],
  ['SubagentHandback', 1, true],
];
const TOTAL = 112;
const SUBAGENT = 12;

describe('E0-6: detail.subagent on tool_use events (Claude runner)', () => {
  type Emit = (message: Record<string, unknown>) => void;
  function replay(script: (emit: Emit) => void): QueryFn {
    return ({ prompt, options }) => {
      const out = new AsyncQueue<SDKMessage>();
      const emit: Emit = (message) => {
        if (!out.closed) out.push(message as unknown as SDKMessage);
      };
      options?.abortController?.signal.addEventListener('abort', () => out.close());
      void (async () => {
        for await (const _ of prompt as AsyncIterable<SDKUserMessage>) script(emit);
        out.close();
      })();
      const iterator = out[Symbol.asyncIterator]();
      return {
        next: () => iterator.next(),
        return: async () => {
          out.close();
          return { value: undefined, done: true };
        },
        throw: async (error: unknown) => {
          throw error;
        },
        [Symbol.asyncIterator]() {
          return this;
        },
        initializationResult: async () => ({}),
        mcpServerStatus: async () => [],
        interrupt: async () => undefined,
        close: () => out.close(),
      } as unknown as Query;
    };
  }
  const resultMessage = {
    type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'done', total_cost_usd: 0.1, duration_ms: 1, duration_api_ms: 1,
    stop_reason: 'end_turn', usage: {}, modelUsage: {}, permission_denials: [], uuid: '00000000-0000-0000-0000-000000000000', session_id: 's',
  };
  function params(events: AgentEvent[]): StartSessionParams {
    const config = resolveConfig({ claude: { model: 'opus' } }, { workflowPath: '/w/WORKFLOW.md', env: {}, trackerDefaults }).claude;
    const issue = makeIssue({ id: 'a' });
    return {
      cwd: '/tmp', issue, config, tools: [], toolContext: () => ({ issue }), env: { PATH: '/usr/bin' }, logger: Logger.silent(),
      signal: new AbortController().signal, onEvent: (event: AgentEvent) => void events.push(event), transcriptPath: null,
    } as unknown as StartSessionParams;
  }
  let seq = 0;
  const message = (parent: string | null, tools: string[]) => ({
    type: 'assistant',
    parent_tool_use_id: parent,
    message: {
      id: `msg_${++seq}`,
      content: tools.map((name) => ({ type: 'tool_use', id: `toolu_${++seq}`, name, input: name === 'Agent' ? { subagent_type: 'laravel-code-reviewer', description: 'review' } : {} })),
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });

  async function runSession(script: (emit: Emit) => void): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    const session = await new ClaudeAgentRunner({ query: replay(script) }).startSession(params(events));
    await session.runTurn('go');
    await session.stop();
    return events.filter((event) => event.event === 'tool_use');
  }

  it('flags exactly the 12 subagent calls of the #205 session; the 100 main-thread events carry no subagent key', async () => {
    const uses = await runSession((emit) => {
      // The main thread: one call per message, plus a message with parallel calls.
      for (const [tool, count, sub] of SESSION) {
        if (sub) continue;
        for (let i = 0; i < count; i++) emit(message(null, [tool]));
      }
      // The subagent (parent = the Agent call): parallel calls in one message and single ones.
      emit(message('toolu_reviewer', ['Bash', 'Bash', 'Bash']));
      for (let i = 0; i < 8; i++) emit(message('toolu_reviewer', ['Bash']));
      emit(message('toolu_reviewer', ['SubagentHandback']));
      emit(resultMessage);
    });
    assert.equal(uses.length, TOTAL);
    const flagged = uses.filter((event) => event.detail?.subagent === true);
    assert.equal(flagged.length, SUBAGENT);
    assert.equal(flagged.filter((event) => event.detail?.tool === 'Bash').length, 11);
    assert.equal(flagged.filter((event) => event.detail?.tool === 'SubagentHandback').length, 1);
    const main = uses.filter((event) => event.detail?.subagent !== true);
    assert.equal(main.length, TOTAL - SUBAGENT);
    assert.ok(main.every((event) => !('subagent' in (event.detail ?? {}))), 'main-thread events do not carry the key at all');
    assert.equal(main.filter((event) => event.detail?.tool === 'Bash').length, 84);
  });

  it('an assistant message with parent_tool_use_id undefined (not null) is not a subagent message', async () => {
    const uses = await runSession((emit) => {
      const m = message(null, ['Bash']) as Record<string, unknown>;
      delete m.parent_tool_use_id;
      emit(m);
      emit(resultMessage);
    });
    assert.equal(uses.length, 1);
    assert.ok(!('subagent' in (uses[0]!.detail ?? {})));
  });

  it('keeps skill and agent in the detail of a subagent call', async () => {
    const uses = await runSession((emit) => {
      emit({
        type: 'assistant',
        parent_tool_use_id: 'toolu_x',
        message: { id: 'm', content: [{ type: 'tool_use', id: 'toolu_s', name: 'Skill', input: { skill: 'pest-testing' } }], usage: { input_tokens: 1, output_tokens: 1 } },
      });
      emit(resultMessage);
    });
    assert.equal(uses[0]!.detail?.tool, 'Skill');
    assert.equal(uses[0]!.detail?.skill, 'pest-testing');
    assert.equal(uses[0]!.detail?.subagent, true);
  });
});

describe('E0-6: ToolUsage', () => {
  it('counts subagent calls in the total and separately; empty and copy handle the new record', () => {
    const usage = emptyToolUsage();
    assert.deepEqual(usage.subagentTools, {});
    countToolUse(usage, 'Bash', null);
    countToolUse(usage, 'Bash', null, null, true);
    countToolUse(usage, 'Bash', null, null, false);
    countToolUse(usage, 'SubagentHandback', null, null, true);
    assert.deepEqual(usage.tools, { Bash: 3, SubagentHandback: 1 });
    assert.deepEqual(usage.subagentTools, { Bash: 1, SubagentHandback: 1 });
    const copy = copyToolUsage(usage);
    assert.deepEqual(copy, usage);
    countToolUse(usage, 'Bash', null, null, true);
    assert.deepEqual(copy.subagentTools, { Bash: 1, SubagentHandback: 1 }, 'the copy is independent');
    assert.notEqual(copy.subagentTools, usage.subagentTools);
  });

  it('keeps counting skills and agents for subagent calls', () => {
    const usage = emptyToolUsage();
    countToolUse(usage, 'Skill', 'pest-testing', null, true);
    assert.deepEqual(usage.skills, { 'pest-testing': 1 });
    assert.deepEqual(usage.subagentTools, { Skill: 1 });
  });
});

describe('E0-6: orchestrator – run trace, live state and run_finished', () => {
  function build(session: (emit: (detail: Record<string, unknown>) => void) => void) {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
    const history = new HistoryLog(path.join(dir, 'repositories'), new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent()), Logger.silent());
    let live: Record<string, any> | null = null;
    let tracker: FakeTracker | null = null;
    let orchestrator: Orchestrator | null = null;
    const runner = new FakeRunner((turn, p) => {
      session((detail) =>
        (p.onEvent as (event: unknown) => void)({ event: 'tool_use', timestamp: new Date(), pid: 1, threadId: 't', turnId: '1', sessionId: 't-1', turnCount: 1, message: 'tool_use', detail }),
      );
      live = (orchestrator!.snapshot().running as unknown as Array<Record<string, any>>)[0] ?? null;
      tracker!.set('a', { state: 'In review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    });
    tracker = new FakeTracker([makeIssue({ id: 'a' })]);
    const root = tempDir();
    orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(root))),
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: null,
      clock: new ManualClock(),
      timers: new ManualTimers(),
      createAdapter: () => tracker!,
      history,
    });
    return { orchestrator, runner, history, live: () => live };
  }

  it('the #205 session: tool_calls keeps the total (112, Bash 95), subagent_tool_calls Bash 11 + SubagentHandback 1', async () => {
    const s = build((emit) => {
      for (const [tool, count, sub] of SESSION) for (let i = 0; i < count; i++) emit(sub ? { tool, subagent: true } : { tool });
    });
    await s.orchestrator.tickNow();
    await until(() => s.orchestrator.snapshot().running.length === 0 && s.runner.sessions.length === 1, 3_000, 'run finished');

    const finished = readHistory(s.history.dir, null).entries.find((entry) => entry.event === 'run_finished');
    const toolCalls = parseCounts(finished?.fields.tool_calls);
    assert.equal(toolCalls.Bash, 95);
    assert.equal(Object.values(toolCalls).reduce((a, b) => a + b, 0), TOTAL);
    assert.equal(finished?.fields.subagent_tool_calls, 'Bash:11,SubagentHandback:1');
    assert.deepEqual(parseCounts(finished?.fields.subagent_tool_calls), { Bash: 11, SubagentHandback: 1 });

    // Live state: next to tool_calls.
    const live = s.live()!;
    assert.deepEqual(live.subagent_tool_calls, { Bash: 11, SubagentHandback: 1 });
    assert.equal(live.tool_calls.Bash, 95);

    // Run trace of the issue detail.
    const detail = s.orchestrator.issueDetail('a') as { run_trace: { tool_calls: Record<string, number>; subagent_tool_calls: Record<string, number> } };
    assert.deepEqual(detail.run_trace.subagent_tool_calls, { Bash: 11, SubagentHandback: 1 });
    assert.equal(detail.run_trace.tool_calls.Bash, 95);
  });

  it('a run without delegation logs no subagent_tool_calls and exposes an empty record', async () => {
    const s = build((emit) => {
      emit({ tool: 'Bash' });
      emit({ tool: 'Edit' });
      emit({ tool: 'Bash', subagent: false });
    });
    await s.orchestrator.tickNow();
    await until(() => s.orchestrator.snapshot().running.length === 0 && s.runner.sessions.length === 1, 3_000, 'run finished');
    const finished = readHistory(s.history.dir, null).entries.find((entry) => entry.event === 'run_finished');
    assert.equal(finished?.fields.tool_calls, 'Bash:2,Edit:1');
    assert.equal('subagent_tool_calls' in (finished?.fields ?? {}), false);
    assert.deepEqual(s.live()!.subagent_tool_calls, {});
  });

  it('only detail.subagent === true counts as a subagent call', async () => {
    const s = build((emit) => {
      emit({ tool: 'Bash', subagent: 'true' });
      emit({ tool: 'Bash', subagent: 1 });
      emit({ tool: 'Bash', subagent: true });
    });
    await s.orchestrator.tickNow();
    await until(() => s.orchestrator.snapshot().running.length === 0 && s.runner.sessions.length === 1, 3_000, 'run finished');
    const finished = readHistory(s.history.dir, null).entries.find((entry) => entry.event === 'run_finished');
    assert.equal(finished?.fields.tool_calls, 'Bash:3');
    assert.equal(finished?.fields.subagent_tool_calls, 'Bash:1');
  });
});

describe('E0-6: repository log and statistics', () => {
  const PRICES = 'default: { input: 5, output: 25 }\n';
  function history() {
    const dir = tempDir();
    const file = path.join(dir, 'model-costs.yml');
    fs.writeFileSync(file, PRICES);
    const pricing = new PricingStore(file, Logger.silent());
    return { log: new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent()), pricing };
  }
  const usage = { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0 };
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
  const filter: AnalyticsFilter = { from: null, to: null, repo: null, model: null, timeZone: 'UTC' };
  const NOW = new Date('2026-10-06T00:00:00Z');
  const toolCalls205 = { Bash: 95, Read: 10, Edit: 4, Grep: 1, Agent: 1, SubagentHandback: 1 };
  const subagent205 = { Bash: 11, SubagentHandback: 1 };

  it('the log line carries tool_calls (total) and subagent_tool_calls in the name:n format; the sum is 112', () => {
    const h = history();
    h.log.runFinished(finish('acme/app#205', 'r1', '2026-10-04T10:00:00Z', { toolCalls: toolCalls205, subagentToolCalls: subagent205 }));
    const line = readHistory(h.log.dir, null).entries.find((entry) => entry.event === 'run_finished')!;
    assert.equal(line.fields.subagent_tool_calls, 'Bash:11,SubagentHandback:1');
    assert.equal(Object.values(parseCounts(line.fields.tool_calls)).reduce((a, b) => a + b, 0), TOTAL);
    assert.equal(parseCounts(line.fields.tool_calls).Bash, 95);
  });

  it('omits subagent_tool_calls when undefined or empty', () => {
    const h = history();
    h.log.runFinished(finish('acme/app#1', 'r1', '2026-10-04T10:00:00Z', { toolCalls: { Bash: 1 } }));
    h.log.runFinished(finish('acme/app#2', 'r2', '2026-10-04T11:00:00Z', { toolCalls: { Bash: 1 }, subagentToolCalls: {} }));
    for (const entry of readHistory(h.log.dir, null).entries.filter((e) => e.event === 'run_finished')) {
      assert.equal('subagent_tool_calls' in entry.fields, false);
    }
  });

  it('statistics: the #205 fixture gives 112 calls, 12 in subagents, 100 main-thread and 84 main-thread Bash calls', () => {
    const h = history();
    h.log.runFinished(finish('acme/app#205', 'r1', '2026-10-04T10:00:00Z', { toolCalls: toolCalls205, subagentToolCalls: subagent205 }));
    const a = computeAnalytics(readHistory(h.log.dir, null).entries, h.pricing.current(), filter, NOW);
    assert.equal(a.tools.calls, TOTAL, 'tool_calls stays the total');
    assert.equal(a.tools.subagent_calls, SUBAGENT);
    assert.equal(a.tools.main_calls, TOTAL - SUBAGENT);
    const row = (tool: string) => a.tools.tools.find((r) => r.tool === tool)!;
    assert.deepEqual([row('Bash').calls, row('Bash').subagent_calls, row('Bash').main_calls], [95, 11, 84]);
    assert.deepEqual([row('SubagentHandback').calls, row('SubagentHandback').subagent_calls, row('SubagentHandback').main_calls], [1, 1, 0]);
    assert.deepEqual([row('Read').calls, row('Read').subagent_calls, row('Read').main_calls], [10, 0, 10]);
  });

  it('older log lines without subagent_tool_calls parse as before: no subagent calls, main-thread = total', () => {
    const h = history();
    h.log.runFinished(finish('acme/app#1', 'r1', '2026-10-04T10:00:00Z', { toolCalls: { Bash: 5, Edit: 2 } }));
    const entries = readHistory(h.log.dir, null).entries;
    assert.equal('subagent_tool_calls' in entries.find((e) => e.event === 'run_finished')!.fields, false);
    const a = computeAnalytics(entries, h.pricing.current(), filter, NOW);
    assert.equal(a.tools.calls, 7);
    assert.equal(a.tools.subagent_calls, 0);
    assert.equal(a.tools.main_calls, 7);
    assert.deepEqual(a.tools.tools.map((r) => [r.tool, r.calls, r.subagent_calls, r.main_calls]), [['Bash', 5, 0, 5], ['Edit', 2, 0, 2]]);
  });

  it('a hand-written old and a new log line aggregate side by side; a subagent count above the total never gives a negative main-thread figure', () => {
    const h = history();
    h.log.runFinished(finish('acme/app#1', 'r1', '2026-10-04T10:00:00Z', { toolCalls: { Bash: 4 }, subagentToolCalls: { Bash: 9, Glob: 2 } }));
    h.log.runFinished(finish('acme/app#2', 'r2', '2026-10-05T10:00:00Z', { toolCalls: { Bash: 10 }, subagentToolCalls: { Bash: 3 } }));
    const a = computeAnalytics(readHistory(h.log.dir, null).entries, h.pricing.current(), filter, NOW);
    for (const r of a.tools.tools) assert.ok(r.main_calls >= 0, r.tool);
    assert.ok(a.tools.main_calls >= 0);
    const bash = a.tools.tools.find((r) => r.tool === 'Bash')!;
    assert.equal(bash.calls, 14);
    assert.equal(bash.subagent_calls, 12);
    assert.equal(bash.main_calls, 2);
  });

  it('subagent counts are summed over several runs and respect the period filter like the total', () => {
    const h = history();
    h.log.runFinished(finish('acme/app#1', 'r1', '2026-09-01T10:00:00Z', { toolCalls: { Bash: 50 }, subagentToolCalls: { Bash: 40 } }));
    h.log.runFinished(finish('acme/app#2', 'r2', '2026-10-04T10:00:00Z', { toolCalls: { Bash: 6 }, subagentToolCalls: { Bash: 2 } }));
    h.log.runFinished(finish('acme/app#3', 'r3', '2026-10-05T10:00:00Z', { toolCalls: { Bash: 4 } }));
    const a = computeAnalytics(readHistory(h.log.dir, null).entries, h.pricing.current(), { ...filter, from: new Date('2026-10-01T00:00:00Z') }, NOW);
    assert.equal(a.tools.calls, 10);
    assert.equal(a.tools.subagent_calls, 2);
    assert.equal(a.tools.main_calls, 8);
  });

  it('no tool data at all: zero subagent and main-thread calls', () => {
    const a = computeAnalytics([], history().pricing.current(), filter, NOW);
    assert.equal(a.tools.subagent_calls, 0);
    assert.equal(a.tools.main_calls, 0);
  });

  describe('statistics page', () => {
    async function load(tools: Record<string, unknown>) {
      const page = renderPage(LOGS_HTML, undefined, {
        url: 'http://127.0.0.1/stats',
        fetch: (u: string) => (u.startsWith('/api/v1/history/entries') ? entriesFixture() : analyticsFixture({ tools })),
      });
      await until(() => page.$('log-count').textContent === '1' && page.query('#summary-kpis .sum-card').length > 0, 3000, 'the page to load');
      return page;
    }
    const analyticsTools = (runs: Array<Record<string, unknown>>) => {
      const h = history();
      runs.forEach((overrides, i) => h.log.runFinished(finish(`acme/app#${i + 1}`, `r${i}`, `2026-10-0${i + 2}T10:00:00Z`, overrides)));
      return JSON.parse(JSON.stringify(computeAnalytics(readHistory(h.log.dir, null).entries, h.pricing.current(), filter, NOW).tools)) as Record<string, unknown>;
    };

    it('shows the main-thread figure 100 next to the 112 total and the subagent share, in the Tools section', async () => {
      const page = await load(analyticsTools([{ toolCalls: toolCalls205, subagentToolCalls: subagent205 }]));
      const text = page.query('[data-body="tools"]')[0]!.textContent;
      assert.match(text, /Tool-Aufrufe/);
      assert.match(text, /Hauptthread/);
      assert.match(text, /112/);
      assert.match(text, /100/);
      assert.match(text, /davon in Subagents: 12/);
      assert.match(text, /Subagent/);
    });

    it('does not break on tool data from before the field existed (no subagent_calls / main_calls keys)', async () => {
      const tools = analyticsTools([{ toolCalls: { Bash: 5, Edit: 2 } }]);
      delete tools.subagent_calls;
      delete tools.main_calls;
      for (const row of tools.tools as Array<Record<string, unknown>>) {
        delete row.subagent_calls;
        delete row.main_calls;
      }
      const page = await load(tools);
      const text = page.query('[data-body="tools"]')[0]!.textContent;
      assert.match(text, /Tool-Aufrufe/);
      assert.doesNotMatch(text, /NaN|undefined/);
      assert.doesNotMatch(text, /davon in Subagents/);
    });

    it('shows no subagent remark when no call ran in a subagent', async () => {
      const page = await load(analyticsTools([{ toolCalls: { Bash: 5, Edit: 2 } }]));
      const text = page.query('[data-body="tools"]')[0]!.textContent;
      assert.match(text, /Hauptthread/);
      assert.doesNotMatch(text, /davon in Subagents/);
      assert.doesNotMatch(text, /NaN|undefined/);
    });
  });
});

describe('E0-6: documentation', () => {
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, '..', file), 'utf8');

  it('docs/configuration.md#repository-logs lists subagent_tool_calls with its relation to tool_calls', () => {
    const doc = read('docs/configuration.md');
    const line = doc.split('\n').find((l) => l.includes('subagent_tool_calls'));
    assert.ok(line, 'subagent_tool_calls is documented');
    const row = doc.split('\n').find((l) => l.includes('`tool_calls`') && l.includes('run_finished'));
    assert.ok(row?.includes('subagent_tool_calls') || line.includes('tool_calls'), 'documented next to tool_calls');
    assert.match(line, /total|Summe|Gesamt/i);
  });
});
