import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentRunner, type QueryFn } from '../src/agent/claude.ts';
import type { AgentEvent, StartSessionParams, SubagentRun } from '../src/agent/types.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { applySubagent, emptySubagents, subagentsJson } from '../src/orchestrator/subagents.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { AsyncQueue } from '../src/util/async.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, baseFront, makeIssue, makeWorkflow, tempDir, until } from './helpers.ts';

// Acceptance tests for E3-1 subagent tracking (#329), derived from the issue: an Agent/Task tool_use starts a run,
// messages with parent_tool_use_id add tokens, the matching tool_result ends it, the orchestrator keeps the running and
// the last ten finished ones and /api/v1/state shows them.

type Emit = (message: Record<string, unknown>) => void;

/** Replays a recorded message stream for the first prompt. `end` closes the stream like a dying CLI process. */
function replay(script: (emit: Emit, end: () => void) => void): QueryFn {
  return ({ prompt, options }) => {
    const out = new AsyncQueue<SDKMessage>();
    const emit: Emit = (message) => {
      if (!out.closed) out.push(message as unknown as SDKMessage);
    };
    options?.abortController?.signal.addEventListener('abort', () => out.close());
    void (async () => {
      for await (const _ of prompt as AsyncIterable<SDKUserMessage>) script(emit, () => out.close());
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
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 1,
  result: 'done',
  total_cost_usd: 0.1,
  duration_ms: 1,
  duration_api_ms: 1,
  stop_reason: 'end_turn',
  usage: {},
  modelUsage: {},
  permission_denials: [],
  uuid: '00000000-0000-0000-0000-000000000000',
  session_id: 's',
};

function sessionParams(events: AgentEvent[]): StartSessionParams {
  const config = resolveConfig({ claude: { model: 'opus' } }, { workflowPath: '/w/WORKFLOW.md', env: {}, trackerDefaults }).claude;
  const issue = makeIssue({ id: 'a' });
  return {
    cwd: '/tmp',
    issue,
    config,
    tools: [],
    toolContext: () => ({ issue }),
    env: { PATH: '/usr/bin' },
    logger: Logger.silent(),
    signal: new AbortController().signal,
    onEvent: (event: AgentEvent) => void events.push(event),
    transcriptPath: null,
  } as unknown as StartSessionParams;
}

const call = (id: string, input: Record<string, unknown>, name = 'Agent') => ({ type: 'tool_use', id, name, input });
const fromAgent = (content: unknown[]) => ({ type: 'assistant', message: { id: 'main', content }, parent_tool_use_id: null });
const inner = (parent: string, id: string, usage: Record<string, number>, content: unknown[] = [{ type: 'text', text: 'x' }]) => ({
  type: 'assistant',
  message: { id, content, usage },
  parent_tool_use_id: parent,
});
const toolResult = (id: string, isError?: boolean, parent: string | null = null) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'r', ...(isError !== undefined ? { is_error: isError } : {}) }] },
  parent_tool_use_id: parent,
});

/** Last reported snapshot per tool_use_id, in order of first appearance. */
function latest(events: AgentEvent[]): Map<string, SubagentRun> {
  const runs = new Map<string, SubagentRun>();
  for (const event of events) if (event.subagent !== undefined) runs.set(event.subagent.toolUseId, event.subagent);
  return runs;
}

async function runStream(script: (emit: Emit, end: () => void) => void, events: AgentEvent[] = []) {
  const session = await new ClaudeAgentRunner({ query: replay(script) }).startSession(sessionParams(events));
  await session.runTurn('go');
  return { session, events };
}

describe('subagent tracking in the Claude runner (#329)', () => {
  it('two parallel subagents start, one ends: one running, one finished with its tokens', async () => {
    const { session, events } = await runStream((emit) => {
      emit(fromAgent([call('toolu_1', { subagent_type: 'Explore', description: 'Scan the repo' }), call('toolu_2', { subagent_type: 'Plan', description: 'Draft a plan' })]));
      emit(inner('toolu_1', 'm1', { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }));
      emit(inner('toolu_2', 'm2', { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }));
      emit(inner('toolu_1', 'm3', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));
      emit(toolResult('toolu_1', false));
      emit(resultMessage);
    });
    const runs = latest(events);
    const one = runs.get('toolu_1')!;
    const two = runs.get('toolu_2')!;
    assert.equal(one.status, 'ok');
    assert.equal(one.subagentType, 'Explore');
    assert.equal(one.description, 'Scan the repo');
    assert.ok(one.startedAt instanceof Date);
    assert.ok(one.endedAt instanceof Date);
    assert.ok(one.endedAt!.getTime() >= one.startedAt.getTime());
    assert.deepEqual(one.tokens, { inputTokens: 110, outputTokens: 25, cacheReadTokens: 30, cacheWriteTokens: 40 });
    assert.equal(two.status, 'running');
    assert.equal(two.subagentType, 'Plan');
    assert.equal(two.endedAt, null);
    assert.deepEqual(two.tokens, { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 });
    await session.stop();
  });

  it('the same message id is not counted twice and the last state of a streamed message wins', async () => {
    const { events } = await runStream((emit) => {
      emit(fromAgent([call('toolu_1', {})]));
      emit(inner('toolu_1', 'm1', { input_tokens: 5, output_tokens: 1 }));
      emit(inner('toolu_1', 'm1', { input_tokens: 5, output_tokens: 9 }));
      emit(toolResult('toolu_1'));
      emit(resultMessage);
    });
    const run = latest(events).get('toolu_1')!;
    assert.equal(run.tokens.inputTokens, 5);
    assert.equal(run.tokens.outputTokens, 9);
  });

  it('defaults the type and takes the start of the prompt as the description, on one line', async () => {
    const { events } = await runStream((emit) => {
      emit(fromAgent([call('toolu_t', { prompt: `Investigate\nthe   flaky test ${'x'.repeat(500)}` }, 'Task')]));
      emit(resultMessage);
    });
    const run = latest(events).get('toolu_t')!;
    assert.equal(run.subagentType, 'general-purpose');
    assert.ok(run.description.startsWith('Investigate'));
    assert.ok(!run.description.includes('\n'));
    assert.ok(run.description.length > 0 && run.description.length < 400);
  });

  it('prefers the description over the prompt', async () => {
    const { events } = await runStream((emit) => {
      emit(fromAgent([call('toolu_d', { description: 'short', prompt: 'long prompt text' })]));
      emit(resultMessage);
    });
    assert.equal(latest(events).get('toolu_d')!.description, 'short');
  });

  it('an is_error tool_result ends the run with status error', async () => {
    const { events } = await runStream((emit) => {
      emit(fromAgent([call('toolu_1', {})]));
      emit(toolResult('toolu_1', true));
      emit(resultMessage);
    });
    const run = latest(events).get('toolu_1')!;
    assert.equal(run.status, 'error');
    assert.ok(run.endedAt instanceof Date);
  });

  it('a tool_result of an inner tool of the subagent does not end it, and non-agent tool calls start no run', async () => {
    const { events } = await runStream((emit) => {
      emit(fromAgent([call('toolu_1', {}), call('toolu_bash', { command: 'ls' }, 'Bash')]));
      emit(inner('toolu_1', 'm1', { input_tokens: 1, output_tokens: 1 }, [call('toolu_inner', { command: 'ls' }, 'Bash')]));
      emit(toolResult('toolu_inner', false, 'toolu_1'));
      emit(toolResult('toolu_bash', false));
      emit(resultMessage);
    });
    const runs = latest(events);
    assert.deepEqual([...runs.keys()], ['toolu_1']);
    assert.equal(runs.get('toolu_1')!.status, 'running');
  });

  it('messages of a foreign parent_tool_use_id add no tokens to a subagent', async () => {
    const { events } = await runStream((emit) => {
      emit(fromAgent([call('toolu_1', {})]));
      emit(inner('toolu_unknown', 'm1', { input_tokens: 50, output_tokens: 50 }));
      emit({ type: 'assistant', message: { id: 'top', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 77, output_tokens: 7 } }, parent_tool_use_id: null });
      emit(resultMessage);
    });
    assert.equal(latest(events).get('toolu_1')!.tokens.inputTokens, 0);
  });

  it('leaves no subagent running once the session is stopped', async () => {
    const { session, events } = await runStream((emit) => {
      emit(fromAgent([call('toolu_1', {}), call('toolu_2', {})]));
      emit(toolResult('toolu_1'));
      emit(resultMessage);
    });
    await session.stop();
    const runs = latest(events);
    assert.equal(runs.get('toolu_1')!.status, 'ok');
    assert.notEqual(runs.get('toolu_2')!.status, 'running');
    assert.ok(runs.get('toolu_2')!.endedAt instanceof Date);
  });

  it('leaves no subagent running when the stream ends without a tool_result', async () => {
    const events: AgentEvent[] = [];
    const session = await new ClaudeAgentRunner({
      query: replay((emit, end) => {
        emit(fromAgent([call('toolu_1', {})]));
        end();
      }),
    }).startSession(sessionParams(events));
    await session.runTurn('go').catch(() => undefined);
    await session.stop();
    assert.notEqual(latest(events).get('toolu_1')!.status, 'running');
  });

  it('keeps counting agent_calls via the tool_use event, unchanged', async () => {
    const { events } = await runStream((emit) => {
      emit(fromAgent([call('toolu_1', { subagent_type: 'Explore' }), call('toolu_2', { subagent_type: 'Explore' }), call('toolu_3', {}, 'Task')]));
      emit(resultMessage);
    });
    const uses = events.filter((event) => event.event === 'tool_use');
    assert.equal(uses.length, 3);
    assert.deepEqual(uses.map((event) => event.detail?.agent), ['Explore', 'Explore', 'general-purpose']);
    assert.deepEqual(uses.map((event) => event.detail?.tool), ['Agent', 'Agent', 'Task']);
  });
});

describe('subagent board in the orchestrator (#329)', () => {
  const mkRun = (id: string, status: SubagentRun['status'] = 'running'): SubagentRun => ({
    toolUseId: id,
    subagentType: 'Explore',
    description: id,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    endedAt: status === 'running' ? null : new Date('2026-01-01T00:01:00Z'),
    status,
    tokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 },
  });

  it('keeps all running and only the last ten finished; the eleventh finished pushes the oldest out', () => {
    const board = emptySubagents();
    for (let i = 1; i <= 12; i++) applySubagent(board, mkRun(`r${i}`));
    for (let i = 1; i <= 11; i++) applySubagent(board, mkRun(`r${i}`, i % 2 === 0 ? 'error' : 'ok'));
    const json = subagentsJson(board);
    assert.deepEqual(json.running.map((run) => run.tool_use_id), ['r12']);
    assert.deepEqual(json.finished.map((run) => run.tool_use_id), ['r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11']);
    assert.equal(json.finished.length, 10);
  });

  it('exactly ten finished are all kept', () => {
    const board = emptySubagents();
    for (let i = 1; i <= 10; i++) applySubagent(board, mkRun(`r${i}`, 'ok'));
    assert.equal(subagentsJson(board).finished.length, 10);
    assert.equal(subagentsJson(board).finished[0]!.tool_use_id, 'r1');
  });

  it('a token update of a running subagent replaces its snapshot instead of adding a second entry', () => {
    const board = emptySubagents();
    applySubagent(board, mkRun('a'));
    applySubagent(board, { ...mkRun('a'), tokens: { inputTokens: 9, outputTokens: 9, cacheReadTokens: 9, cacheWriteTokens: 9 } });
    const json = subagentsJson(board);
    assert.equal(json.running.length, 1);
    assert.equal(json.running[0]!.tokens.total_tokens, 36);
    assert.equal(json.finished.length, 0);
  });

  it('GET /api/v1/state shows subagents { running, finished } per running issue; 11 finished keep the last 10', async () => {
    let live: Record<string, any> | null = null;
    let s: { orchestrator: Orchestrator; tracker: FakeTracker } | null = null;
    const runner = new FakeRunner((turn, params) => {
      const send = (event: string, fields: Record<string, unknown>) =>
        params.onEvent({ event, timestamp: new Date(), pid: 1, threadId: 't', turnId: '1', sessionId: 't-1', turnCount: 1, ...fields } as AgentEvent);
      for (let i = 1; i <= 11; i++) {
        send('subagent', { subagent: mkRun(`f${i}`) });
        send('subagent', { subagent: mkRun(`f${i}`, 'ok') });
      }
      send('subagent', { subagent: mkRun('still') });
      live = (s!.orchestrator.snapshot().running as unknown as Array<Record<string, any>>)[0] ?? null;
      s!.tracker.set('a', { state: 'In review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    });
    const root = tempDir();
    const tracker = new FakeTracker([makeIssue({ id: 'a' })]);
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(root))),
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: null,
      clock: new ManualClock(),
      timers: new ManualTimers(),
      createAdapter: () => tracker,
    });
    s = { orchestrator, tracker };
    await orchestrator.tickNow();
    await until(() => orchestrator.snapshot().running.length === 0 && runner.sessions.length === 1, 3_000, 'run finished');
    assert.ok(live !== null, 'a running row was captured');
    const row = live as Record<string, any>;
    assert.deepEqual(Object.keys(row.subagents).sort(), ['finished', 'running']);
    assert.deepEqual(row.subagents.running.map((run: any) => run.tool_use_id), ['still']);
    assert.deepEqual(row.subagents.finished.map((run: any) => run.tool_use_id), ['f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11']);
    for (const field of ['tool_use_id', 'subagent_type', 'description', 'status', 'started_at', 'ended_at', 'tokens']) {
      assert.ok(field in row.subagents.finished[0], field);
    }
    assert.equal(row.subagents.finished[0].status, 'ok');
    assert.equal(row.subagents.running[0].ended_at, null);
    assert.equal(typeof row.agent_calls, 'object');
  });
});
