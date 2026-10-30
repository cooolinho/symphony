import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ClaudeAgentRunner, type QueryFn } from '../src/agent/claude.ts';
import { contextWindowSuffix } from '../src/agent/model-name.ts';
import type { AgentEvent, StartSessionParams } from '../src/agent/types.ts';
import { contextWindowFor, parsePricing, PricingStore } from '../src/costs/pricing.ts';
import { computeAnalytics } from '../src/history/analytics.ts';
import { HistoryLog, parseHistoryLine, readHistory } from '../src/history/history.ts';
import { Logger } from '../src/log.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { AsyncQueue } from '../src/util/async.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeIssue, makeWorkflow, tempDir, until } from './helpers.ts';

type Emit = (message: Record<string, unknown>) => void;

/** Stand-in for the SDK's query(): consumes the streaming input and replays scripted messages per turn. */
function fakeQuery(script: (turn: number, emit: Emit) => void): QueryFn {
  return ({ prompt, options }) => {
    const out = new AsyncQueue<SDKMessage>();
    const emit: Emit = (message) => {
      if (!out.closed) out.push(message as unknown as SDKMessage);
    };
    options?.abortController?.signal.addEventListener('abort', () => out.close());
    void (async () => {
      let turn = 0;
      for await (const _message of prompt as AsyncIterable<SDKUserMessage>) {
        turn += 1;
        script(turn, emit);
      }
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

const turnResult: Record<string, unknown> = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 1,
  result: 'done',
  total_cost_usd: 0.1,
  duration_ms: 10,
  duration_api_ms: 8,
  stop_reason: 'end_turn',
  usage: {},
  modelUsage: {},
  permission_denials: [],
  uuid: '00000000-0000-0000-0000-000000000000',
  session_id: 's',
};

const call = (id: string, usage: Record<string, number>, parent: string | null = null, model = 'claude-opus-5-5') => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { id, model, content: [{ type: 'text', text: 'x' }], usage: { output_tokens: 1, ...usage } },
});
const compact = (metadata?: Record<string, unknown>) => ({
  type: 'system',
  subtype: 'compact_boundary',
  ...(metadata === undefined ? {} : { compact_metadata: metadata }),
  uuid: 'u',
  session_id: 's',
});
const init = (model: string) => ({
  type: 'system',
  subtype: 'init',
  model,
  permissionMode: 'auto',
  claude_code_version: '3.0.0',
  apiKeySource: 'none',
  mcp_servers: [],
  plugins: [],
  skills: [],
});

function sessionParams(model: string | undefined, events: AgentEvent[], contextWindow?: (model: string) => number | null): StartSessionParams {
  const config = resolveConfig({ claude: model === undefined ? {} : { model } }, { workflowPath: '/w/WORKFLOW.md', env: {}, trackerDefaults }).claude;
  const issue = makeIssue({ id: 'a' });
  return {
    cwd: '/tmp',
    issue,
    config,
    tools: [{ name: 'get_issue', description: 'read', inputSchema: { id: z.string().optional() }, mutates: false, execute: async () => ({ ok: true, data: {} }) }],
    toolContext: () => ({ issue }),
    env: { PATH: '/usr/bin' },
    transcriptPath: null,
    logger: Logger.silent(),
    onEvent: (event) => events.push(event),
    signal: new AbortController().signal,
    ...(contextWindow ? { contextWindow } : {}),
  };
}

async function run(
  model: string | undefined,
  contextWindow: ((model: string) => number | null) | undefined,
  script: (turn: number, emit: Emit) => void,
  turns = 1,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const session = await new ClaudeAgentRunner({ query: fakeQuery((turn, emit) => { script(turn, emit); emit(turnResult); }) }).startSession(sessionParams(model, events, contextWindow));
  for (let i = 0; i < turns; i += 1) await session.runTurn('go');
  await session.stop();
  return events;
}

const contexts = (events: AgentEvent[]) => events.filter((e) => e.event === 'model_call' && e.context !== undefined).map((e) => e.context);

describe('contextWindowSuffix', () => {
  it('returns 1_000_000 for a [1m] suffix, ignoring case and surrounding blanks', () => {
    assert.equal(contextWindowSuffix('opus[1m]'), 1_000_000);
    assert.equal(contextWindowSuffix('claude-opus-5-5[1m]'), 1_000_000);
    assert.equal(contextWindowSuffix('OPUS[1M]'), 1_000_000);
    assert.equal(contextWindowSuffix('  sonnet[1m] '), 1_000_000);
  });

  it('returns null without such a suffix', () => {
    for (const model of ['opus', 'claude-opus-5-5', '', 'opus[1m]x', '[1m]opus', 'opus[]', 'opus[abc]']) {
      assert.equal(contextWindowSuffix(model), null, model);
    }
    assert.equal(contextWindowSuffix('opus[0m]'), null);
  });
});

describe('context_window in model-costs.yml', () => {
  it('the shipped file sets default 200000, so every model without its own entry gets 200k', () => {
    const shipped = parsePricing(fs.readFileSync(path.join(import.meta.dirname, '..', 'model-costs.yml'), 'utf8'), 'model-costs.yml');
    assert.equal(shipped.defaultContextWindow, 200_000);
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'something-unknown']) {
      assert.equal(contextWindowFor(shipped, model), 200_000, model);
    }
    assert.equal(contextWindowFor(shipped, 'opus[1m]'), 1_000_000);
    assert.equal(contextWindowFor(shipped, 'claude-sonnet-5-5[1m]'), 1_000_000);
  });

  it('is optional per entry: an entry without it falls back to default, and without default the window is unknown', () => {
    const withDefault = parsePricing('default: { input: 1, output: 2, context_window: 200000 }\nopus: { input: 1, output: 2 }', null);
    assert.equal(contextWindowFor(withDefault, 'claude-opus-5-5'), 200_000);
    const withoutDefault = parsePricing('default: { input: 1, output: 2 }\nopus: { input: 1, output: 2 }', null);
    assert.equal(contextWindowFor(withoutDefault, 'claude-opus-5-5'), null);
    assert.equal(contextWindowFor(withoutDefault, 'claude-unknown-1'), null);
    // the suffix still wins when the table knows nothing
    assert.equal(contextWindowFor(withoutDefault, 'claude-opus-5-5[1m]'), 1_000_000);
  });

  it('looks the entry up like a price: exact id before the longest contained key, and the entry beats default', () => {
    const table = parsePricing(
      [
        'default: { input: 1, output: 2, context_window: 200000 }',
        'opus: { input: 1, output: 2, context_window: 300000 }',
        'claude-opus-4-8: { input: 1, output: 2, context_window: 400000 }',
        'opus-mini: { input: 1, output: 2, context_window: 500000 }',
      ].join('\n'),
      null,
    );
    assert.equal(contextWindowFor(table, 'claude-opus-4-8'), 400_000);
    assert.equal(contextWindowFor(table, 'claude-opus-5-5'), 300_000);
    assert.equal(contextWindowFor(table, 'Claude-Opus-Mini-1'), 500_000);
    assert.equal(contextWindowFor(table, 'claude-sonnet-5-5'), 200_000);
  });

  it('rejects values that are not a positive whole number with invalid_model_costs', () => {
    for (const bad of ['0', '-5', '1.5', 'abc']) {
      assert.throws(() => parsePricing(`opus: { input: 1, output: 1, context_window: ${bad} }`, null), { code: 'invalid_model_costs' }, bad);
    }
    assert.throws(() => parsePricing('default: { input: 1, output: 1, context_window: -1 }', null), { code: 'invalid_model_costs' });
  });

  it('keeps pricing untouched by the new field', () => {
    const table = parsePricing('default: { input: 5, output: 25, context_window: 200000 }', null);
    assert.deepEqual(table.defaultPrice, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
  });

  it('applies a changed context_window on hot reload', () => {
    const dir = tempDir();
    const file = path.join(dir, 'model-costs.yml');
    fs.writeFileSync(file, 'default: { input: 5, output: 25, context_window: 200000 }\n');
    const store = new PricingStore(file, Logger.silent());
    assert.equal(contextWindowFor(store.current(), 'claude-opus-5-5'), 200_000);
    fs.writeFileSync(file, 'default: { input: 5, output: 25, context_window: 400000 }\n# edited\n');
    assert.equal(contextWindowFor(store.current(), 'claude-opus-5-5'), 400_000);
  });

  it('has no window at all for the built-in fallback without a file', () => {
    const store = new PricingStore(path.join(tempDir(), 'missing.yml'), Logger.silent());
    assert.equal(contextWindowFor(store.current(), 'claude-opus-5-5'), null);
  });
});

describe('context fill level of the claude runner', () => {
  it('computes percent from input + cache read + cache creation against 200k', async () => {
    const events = await run('opus', () => 200_000, (_t, emit) =>
      emit(call('m1', { input_tokens: 5_000, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 5_000 })),
    );
    const [context] = contexts(events);
    assert.equal(context?.tokens, 100_000);
    assert.equal(context?.window, 200_000);
    assert.equal(context?.percent, 50);
    assert.equal(context?.compacts, 0);
  });

  it('computes percent against 1M for a [1m] session model, whatever the resolver says', async () => {
    const events = await run('opus[1m]', () => 200_000, (_t, emit) => emit(call('m1', { input_tokens: 0, cache_read_input_tokens: 250_000 })));
    const [context] = contexts(events);
    assert.equal(context?.window, 1_000_000);
    assert.equal(context?.tokens, 250_000);
    assert.equal(context?.percent, 25);
  });

  it('takes the [1m] suffix from the init message when the configured model has none', async () => {
    const events = await run(undefined, () => 200_000, (_t, emit) => {
      emit(init('claude-opus-5-5[1m]'));
      emit(call('m1', { input_tokens: 100_000 }));
    });
    assert.equal(contexts(events)[0]?.window, 1_000_000);
    assert.equal(contexts(events)[0]?.percent, 10);
  });

  it('uses the plain 200k window when neither the session model nor config carry the suffix', async () => {
    const events = await run('sonnet', () => 200_000, (_t, emit) => {
      emit(init('claude-sonnet-5-5'));
      emit(call('m1', { input_tokens: 100_000 }, null, 'claude-sonnet-5-5'));
    });
    assert.equal(contexts(events)[0]?.window, 200_000);
    assert.equal(contexts(events)[0]?.percent, 50);
  });

  it('rounds the percent to one decimal', async () => {
    const events = await run('opus', () => 200_000, (_t, emit) => emit(call('m1', { input_tokens: 1_234 })));
    assert.equal(contexts(events)[0]?.percent, 0.6);
    const events2 = await run('opus', () => 300_000, (_t, emit) => emit(call('m1', { input_tokens: 100_000 })));
    assert.equal(contexts(events2)[0]?.percent, 33.3);
  });

  it('has window and percent null for an unknown model, but still reports the tokens', async () => {
    const events = await run('mystery', () => null, (_t, emit) =>
      emit(call('m1', { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 }, null, 'mystery-1')),
    );
    const [context] = contexts(events);
    assert.equal(context?.window, null);
    assert.equal(context?.percent, null);
    assert.equal(context?.peakPercent, null);
    assert.equal(context?.tokens, 60);
    assert.equal(context?.model, 'mystery-1');
  });

  it('has no percent without a resolver either', async () => {
    const events = await run('mystery', undefined, (_t, emit) => emit(call('m1', { input_tokens: 10 }, null, 'mystery-1')));
    assert.equal(contexts(events)[0]?.percent, null);
    assert.equal(contexts(events)[0]?.window, null);
  });

  it('asks the resolver with the model id of the call on every call, so a changed table applies', async () => {
    const asked: string[] = [];
    const events = await run('opus', (model) => { asked.push(model); return asked.length === 1 ? 200_000 : 400_000; }, (_t, emit) => {
      emit(call('m1', { input_tokens: 100_000 }));
      emit(call('m2', { input_tokens: 100_000 }));
    });
    assert.deepEqual(asked, ['claude-opus-5-5', 'claude-opus-5-5']);
    assert.deepEqual(contexts(events).map((c) => [c?.window, c?.percent]), [[200_000, 50], [400_000, 25]]);
  });

  it('uses the latest call, not a sum: tokens follow the last call, the peak stays', async () => {
    const events = await run('opus', () => 200_000, (_t, emit) => {
      emit(call('m1', { input_tokens: 20_000 }));
      emit(call('m2', { input_tokens: 160_000 }));
      emit(call('m3', { input_tokens: 40_000 }));
    });
    assert.deepEqual(contexts(events).map((c) => [c?.tokens, c?.percent, c?.peakPercent]), [
      [20_000, 10, 10],
      [160_000, 80, 80],
      [40_000, 20, 80],
    ]);
  });

  it('keeps the snapshot across turns and does not count subagent calls', async () => {
    const events = await run('opus', () => 200_000, (turn, emit) => {
      if (turn === 1) {
        emit(call('m1', { input_tokens: 50_000 }));
        emit(call('s1', { input_tokens: 190_000 }, 'toolu_sub'));
      } else {
        emit(call('m2', { input_tokens: 60_000 }));
      }
    }, 2);
    const all = contexts(events);
    assert.ok(all.every((c) => c?.tokens !== 190_000), 'the subagent call does not fill the session context');
    assert.equal(all.at(-2)?.tokens, 50_000);
    assert.equal(all.at(-1)?.tokens, 60_000);
    assert.equal(all.at(-1)?.peakPercent, 30);
  });

  it('counts every compact_boundary and remembers the pre_tokens of the latest one', async () => {
    const events = await run('opus', () => 200_000, (_t, emit) => {
      emit(call('m1', { input_tokens: 150_000 }));
      emit(compact({ trigger: 'auto', pre_tokens: 150_000 }));
      emit(call('m2', { input_tokens: 30_000 }));
      emit(compact({ trigger: 'manual', pre_tokens: 170_000 }));
    });
    const compacted = events.filter((e) => e.event === 'context_compacted');
    assert.deepEqual(compacted.map((e) => [e.context?.compacts, e.context?.preTokens]), [[1, 150_000], [2, 170_000]]);
    assert.equal(compacted[1]?.context?.window, 200_000);
    assert.equal(compacted[1]?.context?.peakPercent, 75);
    // the next call keeps counting
    const after = contexts(events);
    assert.equal(after.at(-1)?.compacts, 1, 'the call between the two compactions saw one compaction');
  });

  it('keeps compacts and pre_tokens on the following model calls', async () => {
    const events = await run('opus', () => 200_000, (_t, emit) => {
      emit(call('m1', { input_tokens: 150_000 }));
      emit(compact({ trigger: 'auto', pre_tokens: 150_000 }));
      emit(call('m2', { input_tokens: 30_000 }));
    });
    const last = contexts(events).at(-1);
    assert.equal(last?.compacts, 1);
    assert.equal(last?.preTokens, 150_000);
    assert.equal(last?.percent, 15);
  });

  it('counts a compaction before the first model call and survives missing metadata', async () => {
    const events = await run('opus', () => 200_000, (_t, emit) => {
      emit(compact());
      emit(call('m1', { input_tokens: 20_000 }));
    });
    const compacted = events.find((e) => e.event === 'context_compacted');
    assert.equal(compacted?.context?.compacts, 1);
    assert.equal(compacted?.context?.preTokens, null);
    assert.equal(contexts(events).at(-1)?.compacts, 1);
    assert.equal(contexts(events).at(-1)?.percent, 10);
  });

  it('treats usage without cache fields as zero for them', async () => {
    const events = await run('opus', () => 100_000, (_t, emit) => emit(call('m1', { input_tokens: 25_000 })));
    assert.equal(contexts(events)[0]?.tokens, 25_000);
    assert.equal(contexts(events)[0]?.percent, 25);
  });
});

describe('run_finished context fields in the history', () => {
  const PRICES = 'default: { input: 5, output: 25 }\n';
  function history() {
    const dir = tempDir();
    const file = path.join(dir, 'model-costs.yml');
    fs.writeFileSync(file, PRICES);
    const pricing = new PricingStore(file, Logger.silent());
    return { log: new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent()), pricing };
  }
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
    usage: { 'claude-opus-5-5': { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    claudeEstimateUsd: 0.5,
    ...overrides,
  });

  it('writes context_peak_percent and context_compacts, also when no compaction happened (0)', () => {
    const { log } = history();
    log.runFinished(finish('acme/app#1', 'r1', '2026-10-04T08:01:00Z', { contextPeakPercent: 87.3, contextCompacts: 0 }));
    const entry = readHistory(log.dir, 'acme/app').entries.find((e) => e.event === 'run_finished');
    assert.equal(entry?.fields.context_peak_percent, '87.3');
    assert.equal(entry?.fields.context_compacts, '0');
  });

  it('does not write a numeric peak when the window was unknown', () => {
    const { log } = history();
    log.runFinished(finish('acme/app#1', 'r1', '2026-10-04T08:01:00Z', { contextPeakPercent: null, contextCompacts: 0 }));
    const entry = readHistory(log.dir, 'acme/app').entries.find((e) => e.event === 'run_finished');
    const peak = entry?.fields.context_peak_percent;
    assert.ok(peak === undefined || peak === 'null' || peak === '', `unexpected peak ${peak}`);
    assert.equal(Number.isNaN(Number(peak ?? NaN)) || peak === '', true);
  });

  it('still reads and analyses run_finished lines written before the fields existed', () => {
    const { log, pricing } = history();
    const legacy =
      'ts=2026-10-04T08:01:00.000Z event=run_finished issue=acme/app#1 run=r0 outcome=handed_off state="In review" turns=2 model=claude-opus-5-5 ' +
      'input_tokens=1000 output_tokens=2000 cache_read_tokens=0 cache_write_tokens=0 total_tokens=3000 cost_usd=0.055 agent_seconds=60';
    const parsed = parseHistoryLine(legacy);
    assert.equal(parsed?.event, 'run_finished');
    assert.equal(parsed?.fields.context_peak_percent, undefined);

    log.runFinished(finish('acme/app#2', 'r2', '2026-10-04T09:01:00Z', { contextPeakPercent: 12.5, contextCompacts: 1 }));
    const file = fs.readdirSync(log.dir).find((f) => f.endsWith('.log')) as string;
    fs.appendFileSync(path.join(log.dir, file), `${legacy}\n`);
    const entries = readHistory(log.dir, 'acme/app').entries;
    assert.equal(entries.filter((e) => e.event === 'run_finished').length, 2);
    assert.doesNotThrow(() =>
      computeAnalytics(entries, pricing.current(), { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-31T00:00:00Z'), timeZone: 'UTC' } as never, new Date('2026-10-05T00:00:00Z')),
    );
  });
});

describe('context fill level in the orchestrator', () => {
  async function started(files: string) {
    const dir = tempDir();
    const costs = path.join(dir, 'model-costs.yml');
    fs.writeFileSync(costs, files);
    const pricing = new PricingStore(costs, Logger.silent());
    const history = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
    const tracker = new FakeTracker([makeIssue({ id: 'a' })]);
    tracker.issueRepository = () => 'acme/app';
    return { dir, costs, pricing, history, tracker };
  }

  it('shows a defined context in running[] before the first model call and logs 0 compacts in run_finished', async () => {
    const { pricing, history, tracker } = await started('default: { input: 5, output: 25, context_window: 200000 }\n');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner = new FakeRunner(async () => {
      await gate;
      tracker.set('a', { state: 'In review' });
      return { ok: true, turnId: '1', resultText: 'done' };
    });
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), { claude: { model: 'opus' } }))),
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => tracker,
      pricing,
      history,
    });
    await orchestrator.tickNow();
    await until(() => orchestrator.snapshot().running.length === 1, 3_000, 'running');
    const row = orchestrator.snapshot().running[0];
    assert.ok(row?.context, 'context is present before the first call');
    assert.equal(row?.context.tokens, 0);
    assert.equal(row?.context.compacts, 0);
    assert.equal(row?.context.percent, null);
    release();
    await until(() => orchestrator.snapshot().counts.claimed === 0 || orchestrator.snapshot().running.length === 0, 3_000, 'run ended');
    await until(() => readHistory(history.dir, 'acme/app').entries.some((e) => e.event === 'run_finished'), 3_000, 'run_finished');
    const finished = readHistory(history.dir, 'acme/app').entries.find((e) => e.event === 'run_finished');
    assert.equal(finished?.fields.context_compacts, '0');
  });

  it('hands the session a resolver that reads the live table: file value, [1m] suffix, unknown, hot reload', async () => {
    const { costs, pricing, history, tracker } = await started('default: { input: 5, output: 25, context_window: 200000 }\nhaiku: { input: 1, output: 5, context_window: 123000 }\n');
    const runner = new FakeRunner(async () => {
      tracker.set('a', { state: 'In review' });
      return { ok: true, turnId: '1', resultText: 'done' };
    });
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), { claude: { model: 'opus' } }))),
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => tracker,
      pricing,
      history,
    });
    await orchestrator.tickNow();
    await until(() => runner.sessions.length === 1, 3_000, 'session started');
    const resolve = runner.sessions[0]?.params.contextWindow;
    assert.equal(typeof resolve, 'function');
    assert.equal(resolve?.('claude-opus-5-5'), 200_000);
    assert.equal(resolve?.('claude-haiku-4-5'), 123_000);
    assert.equal(resolve?.('claude-opus-5-5[1m]'), 1_000_000);
    fs.writeFileSync(costs, 'default: { input: 5, output: 25 }\n# no window anymore\n');
    assert.equal(resolve?.('claude-opus-5-5'), null);
  });
});
