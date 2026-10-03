import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ClaudeAgentRunner, type QueryFn } from '../src/agent/claude.ts';
import type { AgentEvent, StartSessionParams } from '../src/agent/types.ts';
import { Logger } from '../src/log.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import type { AgentToolSpec } from '../src/tracker/types.ts';
import { AsyncQueue } from '../src/util/async.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { makeIssue } from './helpers.ts';

type Emit = (message: Record<string, unknown>) => void;
type Script = (prompt: string, options: Options, emit: Emit, end: () => void) => Promise<void> | void;

/** Stand-in for the SDK's query(): consumes the streaming input and replays scripted messages. */
function fakeQuery(script: Script, init: () => Promise<unknown> = async () => ({})) {
  let captured: Options | undefined;
  const fn: QueryFn = ({ prompt, options }) => {
    captured = options;
    const out = new AsyncQueue<SDKMessage>();
    const emit: Emit = (message) => {
      if (!out.closed) out.push(message as unknown as SDKMessage);
    };
    options?.abortController?.signal.addEventListener('abort', () => out.close());
    void (async () => {
      for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
        await script(String(message.message.content), options as Options, emit, () => out.close());
      }
      out.close();
    })();
    const iterator = out[Symbol.asyncIterator]();
    const query = {
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
      initializationResult: init,
      interrupt: async () => undefined,
      close: () => out.close(),
    };
    return query as unknown as Query;
  };
  return { fn, options: () => captured as Options };
}

function result(costUsd: number, input: number, output: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 2,
    result: 'all done',
    total_cost_usd: costUsd,
    duration_ms: 10,
    duration_api_ms: 8,
    stop_reason: 'end_turn',
    usage: {},
    modelUsage: {
      'claude-opus-5-5': { inputTokens: input, outputTokens: output, cacheReadInputTokens: 50, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: costUsd, contextWindow: 0, maxOutputTokens: 0 },
    },
    permission_denials: [],
    uuid: '00000000-0000-0000-0000-000000000000',
    session_id: 's',
    ...overrides,
  };
}

const tool: AgentToolSpec = {
  name: 'get_issue',
  description: 'read',
  inputSchema: { id: z.string().optional() },
  mutates: false,
  execute: async () => ({ ok: true, data: {} }),
};

function params(overrides: { claude?: Record<string, unknown>; events?: AgentEvent[]; signal?: AbortSignal } = {}): StartSessionParams {
  const config = resolveConfig({ claude: { model: 'opus', ...overrides.claude } }, { workflowPath: '/w/WORKFLOW.md', env: {}, trackerDefaults }).claude;
  const issue = makeIssue({ id: 'a' });
  return {
    cwd: '/tmp',
    issue,
    config,
    tools: [tool],
    toolContext: () => ({ issue }),
    env: { PATH: '/usr/bin' },
    logger: Logger.silent(),
    signal: overrides.signal ?? new AbortController().signal,
    onEvent: (event) => overrides.events?.push(event),
    transcriptPath: null,
  };
}

describe('claude agent runner', () => {
  it('runs several turns on one live session and reports absolute usage totals', async () => {
    let turn = 0;
    const fake = fakeQuery((_prompt, _options, emit) => {
      turn++;
      emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] }, parent_tool_use_id: null });
      emit(result(turn * 0.25, turn * 100, turn * 20));
    });
    const events: AgentEvent[] = [];
    const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(params({ events }));

    assert.deepEqual(await session.runTurn('first'), { ok: true, turnId: '1', resultText: 'all done' });
    assert.deepEqual(await session.runTurn('continue'), { ok: true, turnId: '2', resultText: 'all done' });
    await session.stop();

    const completed = events.filter((e) => e.event === 'turn_completed');
    assert.deepEqual(completed.map((e) => e.usage), [
      { inputTokens: 150, outputTokens: 20, totalTokens: 170 },
      { inputTokens: 250, outputTokens: 40, totalTokens: 290 },
    ]);
    assert.equal(completed[1]?.sessionId, `${session.threadId}-2`);
    assert.ok(events.some((e) => e.event === 'tool_use' && e.message === 'Bash: npm test'));
    assert.equal(events[0]?.event, 'session_started');

    const options = fake.options();
    assert.equal(options.cwd, '/tmp');
    assert.equal(options.sessionId, session.threadId);
    assert.equal(options.model, 'opus');
    assert.equal(options.permissionMode, 'auto');
    assert.ok(options.allowedTools?.includes('mcp__tracker__get_issue'));
    assert.ok(options.disallowedTools?.includes('AskUserQuestion'));
    assert.ok(options.mcpServers?.tracker !== undefined);
    assert.equal(options.env?.PATH, '/usr/bin');
    assert.deepEqual(options.settingSources, ['project']);
  });

  it('maps failed results to turn_failed', async () => {
    const fake = fakeQuery((_p, _o, emit) => emit(result(0, 0, 0, { subtype: 'error_during_execution', errors: ['tool crashed'] })));
    const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(params());
    const outcome = await session.runTurn('go');
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.code, 'turn_failed');
    assert.match(outcome.ok === false ? outcome.message : '', /tool crashed/);
    await session.stop();
  });

  it('times out turns that go silent', async () => {
    const fake = fakeQuery(() => undefined);
    const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(params({ claude: { turn_timeout_ms: 50 } }));
    const outcome = await session.runTurn('go');
    assert.equal(outcome.ok === false && outcome.code, 'turn_timeout');
    await session.stop();
  });

  it('reports an agent exit in the middle of a turn', async () => {
    const fake = fakeQuery((_p, _o, _emit, end) => end());
    const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(params());
    const outcome = await session.runTurn('go');
    assert.equal(outcome.ok === false && outcome.code, 'port_exit');
    await session.stop();
  });

  it('cancels the running turn when the orchestrator aborts', async () => {
    const controller = new AbortController();
    const fake = fakeQuery(() => new Promise(() => undefined));
    const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(params({ signal: controller.signal }));
    const pending = session.runTurn('go');
    controller.abort('issue moved to Done');
    const outcome = await pending;
    assert.equal(outcome.ok === false && outcome.code, 'turn_cancelled');
    await session.stop();
  });

  it('answers questions automatically and applies the permission policy', async () => {
    const decisions: string[] = [];
    const events: AgentEvent[] = [];
    const fake = fakeQuery(async (_p, options, emit) => {
      const ask = await options.canUseTool?.('AskUserQuestion', {}, { signal: new AbortController().signal } as never);
      const bash = await options.canUseTool?.('Bash', { command: 'curl example.com' }, { signal: new AbortController().signal } as never);
      decisions.push(String(ask?.behavior), String(bash?.behavior));
      emit(result(0, 0, 0));
    });
    const deny = await new ClaudeAgentRunner({ query: fake.fn }).startSession(params({ events }));
    await deny.runTurn('go');
    await deny.stop();
    const approve = await new ClaudeAgentRunner({ query: fake.fn }).startSession(params({ claude: { on_permission_request: 'approve' } }));
    await approve.runTurn('go');
    await approve.stop();
    assert.deepEqual(decisions, ['deny', 'deny', 'deny', 'allow']);
    assert.ok(events.some((e) => e.event === 'turn_input_required'));
    assert.ok(events.some((e) => e.event === 'approval_denied'));
  });

  it('fails startup when the handshake does not finish in time', async () => {
    const fake = fakeQuery(() => undefined, () => new Promise(() => undefined));
    await assert.rejects(
      new ClaudeAgentRunner({ query: fake.fn }).startSession(params({ claude: { read_timeout_ms: 50 } })),
      { code: 'response_timeout' },
    );
  });

  it('refuses a relative working directory', async () => {
    const fake = fakeQuery(() => undefined);
    await assert.rejects(new ClaudeAgentRunner({ query: fake.fn }).startSession({ ...params(), cwd: 'relative/dir' }), {
      code: 'invalid_workspace_cwd',
    });
  });
});
