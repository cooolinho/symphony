import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ClaudeAgentRunner, type QueryFn } from '../src/agent/claude.ts';
import { readTranscript } from '../src/agent/transcript.ts';
import { boostToolPolicy } from '../src/laravel/boost.ts';
import type { AgentEvent, SessionExtensions, SessionPolicy, StartSessionParams } from '../src/agent/types.ts';
import { Logger } from '../src/log.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import type { AgentToolSpec } from '../src/tracker/types.ts';
import { AsyncQueue } from '../src/util/async.ts';
import type { LaravelConfig } from '../src/laravel/integration.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { makeIssue, tempDir, until } from './helpers.ts';

type Emit = (message: Record<string, unknown>) => void;
type Script = (prompt: string, options: Options, emit: Emit, end: () => void) => Promise<void> | void;

/** Stand-in for the SDK's query(): consumes the streaming input and replays scripted messages. */
function fakeQuery(
  script: Script,
  init: () => Promise<unknown> = async () => ({}),
  mcpServerStatus: () => Promise<Array<{ name: string; status: string }>> = async () => [],
) {
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
      mcpServerStatus,
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

function boostExtensions(): SessionExtensions {
  return { mcpServers: { 'laravel-boost': { command: 'php', args: ['artisan', 'boost:mcp'] } }, contextSections: [], additionalDirectories: [], env: {} };
}

const tool: AgentToolSpec = {
  name: 'get_issue',
  description: 'read',
  inputSchema: { id: z.string().optional() },
  mutates: false,
  execute: async () => ({ ok: true, data: {} }),
};

function params(
  overrides: {
    claude?: Record<string, unknown>;
    events?: AgentEvent[];
    signal?: AbortSignal;
    extensions?: SessionExtensions;
    logger?: Logger;
    policy?: SessionPolicy;
    toolTimeoutMs?: number;
    transcriptPath?: string;
    deniedAgents?: string[];
    contextWindow?: (model: string) => number | null;
  } = {},
): StartSessionParams {
  const config = resolveConfig({ claude: { model: 'opus', ...overrides.claude } }, { workflowPath: '/w/WORKFLOW.md', env: {}, trackerDefaults }).claude;
  const issue = makeIssue({ id: 'a' });
  return {
    cwd: '/tmp',
    issue,
    config,
    tools: [tool],
    toolContext: () => ({ issue }),
    env: { PATH: '/usr/bin' },
    logger: overrides.logger ?? Logger.silent(),
    signal: overrides.signal ?? new AbortController().signal,
    onEvent: (event) => overrides.events?.push(event),
    transcriptPath: overrides.transcriptPath ?? null,
    ...(overrides.extensions ? { extensions: overrides.extensions } : {}),
    ...(overrides.policy ? { policy: overrides.policy } : {}),
    ...(overrides.toolTimeoutMs !== undefined ? { toolTimeoutMs: overrides.toolTimeoutMs } : {}),
    ...(overrides.deniedAgents ? { deniedAgents: overrides.deniedAgents } : {}),
    ...(overrides.contextWindow ? { contextWindow: overrides.contextWindow } : {}),
  };
}

const READ_ONLY_DENY = ['Edit', 'Write', 'NotebookEdit', 'Bash(git commit:*)', 'Bash(git push:*)'];

/** Starts and stops a session, returning the SDK options it was built with. */
async function sessionOptions(overrides: Parameters<typeof params>[0]): Promise<Options> {
  const fake = fakeQuery(() => undefined);
  const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(params(overrides));
  await session.stop();
  return fake.options();
}

function serverExtensions(server: Partial<SessionExtensions['mcpServers'][string]>): SessionExtensions {
  return { mcpServers: { srv: { command: 'srv', args: [], ...server } }, contextSections: [], additionalDirectories: [], env: {} };
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
    assert.ok(events.some((e) => e.event === 'tool_use' && e.message === 'Bash: npm test' && e.detail?.tool === 'Bash'));
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
    assert.equal(options.strictMcpConfig, true);
    assert.equal(session.mcpStatus, undefined);
    assert.deepEqual(Object.keys(options.mcpServers ?? {}), ['tracker']);
    assert.equal(options.plugins, undefined);
    assert.equal(options.skills, undefined);
    assert.equal(options.additionalDirectories, undefined);
  });

  it('runs subagents and commands in the foreground unless claude.env allows background tasks', async () => {
    const options = await sessionOptions({});
    assert.equal(options.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
    const append = (options.systemPrompt as { append?: string }).append ?? '';
    assert.match(append, /never end a turn to wait for something/);
    const allowed = await sessionOptions({ claude: { env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0' } } });
    assert.equal(allowed.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '0');
  });

  it('reports the background tasks still running when a turn ends', async () => {
    let turn = 0;
    const fake = fakeQuery((_prompt, _options, emit) => {
      turn++;
      const tasks =
        turn === 1
          ? [
              { task_id: 'a1', task_type: 'local_agent', description: 'Review the diff' },
              { task_id: 'w1', task_type: 'monitor', description: 'Watch the log', ambient: true },
            ]
          : [];
      emit({ type: 'system', subtype: 'background_tasks_changed', tasks, uuid: 'u', session_id: 's' });
      emit(result(0.1, 10, 1));
    });
    const events: AgentEvent[] = [];
    const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(params({ events }));
    assert.deepEqual(await session.runTurn('first'), { ok: true, turnId: '1', resultText: 'all done', backgroundTasks: ['Review the diff'] });
    assert.deepEqual(await session.runTurn('second'), { ok: true, turnId: '2', resultText: 'all done' });
    await session.stop();
    const completed = events.filter((e) => e.event === 'turn_completed');
    assert.deepEqual(completed[0]?.detail?.background_tasks, ['Review the diff']);
    assert.equal(completed[1]?.detail?.background_tasks, undefined);
  });

  it('counts model calls live per model until the turn result replaces the totals', async () => {
    const call = (id: string, model: string, input: number, output: number) => ({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id, model, content: [{ type: 'text', text: 'Working…' }], usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } },
    });
    let turn = 0;
    const fake = fakeQuery((_prompt, _options, emit) => {
      turn++;
      if (turn === 1) {
        emit(call('m1', 'claude-fable-5-1', 100, 20));
        // The blocks of one response repeat the message with the same id and usage: counted once.
        emit(call('m1', 'claude-fable-5-1', 100, 20));
        emit(call('m2', 'claude-haiku-4-5', 30, 5));
        emit(result(0.5, 150, 25));
      } else {
        emit(call('m3', 'claude-fable-5-1', 200, 40));
        // A result without model usage keeps what the model calls counted.
        emit(result(1, 0, 0, { modelUsage: {} }));
      }
    });
    const events: AgentEvent[] = [];
    const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(params({ events }));
    await session.runTurn('first');
    await session.runTurn('second');
    await session.stop();

    const fable = (input: number, output: number) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: 10, cacheWriteTokens: 0 });
    const opus = { inputTokens: 150, outputTokens: 25, cacheReadTokens: 50, cacheWriteTokens: 0 };
    assert.deepEqual(events.filter((e) => e.event === 'model_call').map((e) => e.modelUsage), [
      { 'claude-fable-5-1': fable(100, 20) },
      { 'claude-fable-5-1': fable(100, 20) },
      { 'claude-fable-5-1': fable(100, 20), 'claude-haiku-4-5': { inputTokens: 30, outputTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 0 } },
      { 'claude-opus-5-5': opus, 'claude-fable-5-1': fable(200, 40) },
    ]);
    const completed = events.filter((e) => e.event === 'turn_completed');
    assert.deepEqual(completed[0]?.modelUsage, { 'claude-opus-5-5': opus });
    assert.deepEqual(completed[1]?.modelUsage, { 'claude-opus-5-5': opus, 'claude-fable-5-1': fable(200, 40) });
    assert.deepEqual(completed[1]?.usage, { inputTokens: 410, outputTokens: 65, totalTokens: 475 });
    assert.ok(!events.some((e) => e.event === 'model_call' && (e.message !== undefined || e.detail !== undefined)), 'model calls carry only the totals');
  });

  describe('context fill level', () => {
    const ctxCall = (id: string, input: number, read: number, create: number, parent: string | null = null) => ({
      type: 'assistant',
      parent_tool_use_id: parent,
      message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: read, cache_creation_input_tokens: create } },
    });
    const run = async (overrides: Parameters<typeof params>[0], script: (emit: (m: Record<string, unknown>) => void) => void): Promise<AgentEvent[]> => {
      const events: AgentEvent[] = [];
      const fake = fakeQuery((_prompt, _options, emit) => {
        script(emit as (m: Record<string, unknown>) => void);
        emit(result(0.1, 10, 1));
      });
      const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(params({ ...overrides, events }));
      await session.runTurn('go');
      await session.stop();
      return events;
    };
    const contexts = (events: AgentEvent[]) => events.filter((e) => e.context !== undefined).map((e) => e.context);

    it('relates input, cache read and cache creation of the latest call to a 200k window', async () => {
      const events = await run({ contextWindow: () => 200_000 }, (emit) => emit(ctxCall('m1', 10_000, 30_000, 10_000)));
      assert.deepEqual(contexts(events), [
        { model: 'claude-opus-5-5', window: 200_000, tokens: 50_000, percent: 25, peakPercent: 25, compacts: 0, preTokens: null },
      ]);
    });

    it('gives a [1m] model a 1M window ahead of the resolver', async () => {
      const events = await run({ claude: { model: 'opus[1m]' }, contextWindow: () => 200_000 }, (emit) => emit(ctxCall('m1', 10_000, 30_000, 10_000)));
      assert.equal(contexts(events)[0]?.window, 1_000_000);
      assert.equal(contexts(events)[0]?.percent, 5);
    });

    it('has no percent when no window can be determined', async () => {
      const events = await run({ contextWindow: () => null }, (emit) => emit(ctxCall('m1', 10, 20, 30)));
      assert.deepEqual(contexts(events)[0], { model: 'claude-opus-5-5', window: null, tokens: 60, percent: null, peakPercent: null, compacts: 0, preTokens: null });
    });

    it('counts compactions, remembers pre_tokens and keeps the peak', async () => {
      const events = await run({ contextWindow: () => 200_000 }, (emit) => {
        emit(ctxCall('m1', 0, 180_000, 0));
        emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 180_000 }, uuid: 'u', session_id: 's' });
        emit(ctxCall('m2', 0, 20_000, 0));
      });
      const compacted = events.filter((e) => e.event === 'context_compacted');
      assert.equal(compacted.length, 1);
      assert.equal(compacted[0]?.context?.compacts, 1);
      assert.equal(compacted[0]?.context?.preTokens, 180_000);
      const last = contexts(events).at(-1);
      assert.equal(last?.percent, 10);
      assert.equal(last?.peakPercent, 90);
      assert.equal(last?.compacts, 1);
    });

    it('ignores subagent calls', async () => {
      const events = await run({ contextWindow: () => 200_000 }, (emit) => {
        emit(ctxCall('m1', 0, 20_000, 0));
        emit(ctxCall('m2', 0, 150_000, 0, 'toolu_1'));
      });
      assert.equal(contexts(events).at(-1)?.tokens, 20_000);
    });
  });

  it('writes each turn prompt and the agent messages to the transcript, readable by the transcript reader', async () => {
    const fake = fakeQuery((_prompt, _options, emit) => {
      emit({ type: 'assistant', message: { id: 'm1', model: 'opus', content: [{ type: 'text', text: 'On it.' }] }, parent_tool_use_id: null });
      emit(result(0.1, 10, 1));
    });
    const transcriptPath = path.join(tempDir(), 'sessions', 'a.jsonl');
    const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(params({ transcriptPath }));
    await session.runTurn('Work on acme/app#a');
    await session.stop();
    // The write stream flushes asynchronously.
    await until(() => (readTranscript(transcriptPath, 0)?.entries.length ?? 0) === 3, 3_000, 'transcript lines');
    const entries = readTranscript(transcriptPath, 0)?.entries ?? [];
    assert.deepEqual(entries.map((e) => e.type), ['prompt', 'model_call', 'turn_result']);
    assert.ok(entries[0]?.type === 'prompt');
    assert.deepEqual([entries[0].turn, entries[0].text], [1, 'Work on acme/app#a']);
  });

  it('adds workspace extensions, plugins and skills to the session', async () => {
    const fake = fakeQuery((_prompt, _options, emit) => {
      emit({
        type: 'system',
        subtype: 'init',
        model: 'claude-opus-5-5',
        permissionMode: 'auto',
        claude_code_version: '3.0.0',
        apiKeySource: 'none',
        mcp_servers: [{ name: 'tracker', status: 'connected' }, { name: 'laravel-boost', status: 'failed' }],
        plugins: [{ name: 'symphony', path: '/srv/.claude' }],
        plugin_errors: [{ plugin: 'inline[1]', type: 'path-not-found', message: 'no such directory' }],
        skills: ['pest-testing', 'symphony:handoff'],
      });
      emit(result(0.1, 10, 1));
    }, undefined, async () => [{ name: 'laravel-boost', status: 'failed' }]);
    const lines: string[] = [];
    const logger = Logger.create({ sinks: [{ name: 'memory', write: (line) => lines.push(line) }], level: 'debug' });
    const events: AgentEvent[] = [];
    const extensions: SessionExtensions = {
      mcpServers: { 'laravel-boost': { command: 'php', args: ['/ws/laravel/artisan', 'boost:mcp'], env: { APP_ENV: 'local' } } },
      contextSections: ['# Laravel Boost\nUse search-docs.'],
      additionalDirectories: ['/ws/laravel'],
      env: { FOO: 'bar' },
    };
    const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(
      params({ claude: { plugins: ['/srv/.claude'], skills: 'all', append_system_prompt: 'Extra rules.' }, extensions, logger, events }),
    );
    await session.runTurn('go');
    await session.stop();

    const options = fake.options();
    assert.deepEqual(options.mcpServers?.['laravel-boost'], { type: 'stdio', command: 'php', args: ['/ws/laravel/artisan', 'boost:mcp'], env: { APP_ENV: 'local' } });
    assert.ok(options.mcpServers?.tracker !== undefined);
    assert.ok(options.allowedTools?.includes('mcp__laravel-boost'));
    assert.deepEqual(options.plugins, [{ type: 'local', path: '/srv/.claude' }]);
    assert.equal(options.skills, 'all');
    assert.deepEqual(options.additionalDirectories, ['/ws/laravel']);
    assert.equal(options.env?.FOO, 'bar');
    const append = (options.systemPrompt as { append?: string }).append ?? '';
    assert.ok(append.indexOf('# Laravel Boost') > 0 && append.indexOf('# Laravel Boost') < append.indexOf('Extra rules.'));

    assert.ok(lines.some((line) => line.includes('not connected') && line.includes('laravel-boost')));
    assert.ok(lines.some((line) => line.includes('plugin did not load') && line.includes('path-not-found')));
    const configured = events.find((event) => event.event === 'session_configured');
    assert.deepEqual(configured?.detail?.mcp_servers, ['tracker:connected', 'laravel-boost:failed']);
    assert.deepEqual(configured?.detail?.mcp_status, { 'laravel-boost': 'failed' });
    assert.deepEqual(session.mcpStatus, { 'laravel-boost': 'failed' });
    assert.deepEqual(configured?.detail?.plugins, ['symphony']);
    assert.equal(configured?.detail?.skills, 2);
    assert.deepEqual(configured?.detail?.skill_names, ['pest-testing', 'symphony:handoff']);
  });

  it('reports every tool call of a message and the skill a Skill call loads', async () => {
    const fake = fakeQuery((_prompt, _options, emit) => {
      emit({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Checking two things.' },
            { type: 'tool_use', name: 'mcp__laravel-boost__search-docs', input: { queries: ['validation'] } },
            { type: 'tool_use', name: 'Skill', input: { skill: 'pest-testing' } },
          ],
        },
        parent_tool_use_id: null,
      });
      emit(result(0.1, 10, 1));
    });
    const events: AgentEvent[] = [];
    const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(params({ events }));
    await session.runTurn('go');
    await session.stop();
    const calls = events.filter((event) => event.event === 'tool_use');
    assert.deepEqual(calls.map((event) => event.detail), [{ tool: 'mcp__laravel-boost__search-docs' }, { tool: 'Skill', skill: 'pest-testing' }]);
    assert.equal(calls[1]?.message, 'Skill: pest-testing');
    assert.equal(events.some((event) => event.event === 'assistant_message'), false, 'text next to tool calls is not a separate event');
  });

  it('passes claude.strict_mcp_config: false through', async () => {
    const fake = fakeQuery(() => undefined);
    const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(params({ claude: { strict_mcp_config: false } }));
    await session.stop();
    assert.equal(fake.options().strictMcpConfig, false);
  });

  it('waits for pending extension servers to connect without warning', async () => {
    const answers = ['pending', 'pending', 'connected'];
    let calls = 0;
    const fake = fakeQuery(() => undefined, undefined, async () => [{ name: 'laravel-boost', status: answers[Math.min(calls++, 2)] ?? 'connected' }]);
    const lines: string[] = [];
    const logger = Logger.create({ sinks: [{ name: 'memory', write: (line) => lines.push(line) }], level: 'debug' });
    const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(params({ extensions: boostExtensions(), logger }));
    await session.stop();
    assert.equal(calls, 3);
    assert.deepEqual(session.mcpStatus, { 'laravel-boost': 'connected' });
    assert.ok(!lines.some((line) => line.includes('not connected')));
  });

  it('stops waiting for a pending server after read_timeout_ms', async () => {
    const fake = fakeQuery(() => undefined, undefined, async () => [{ name: 'laravel-boost', status: 'pending' }]);
    const lines: string[] = [];
    const logger = Logger.create({ sinks: [{ name: 'memory', write: (line) => lines.push(line) }], level: 'debug' });
    const started = Date.now();
    const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(
      params({ claude: { read_timeout_ms: 200 }, extensions: boostExtensions(), logger }),
    );
    const elapsed = Date.now() - started;
    await session.stop();
    assert.ok(elapsed < 400, `poll took ${elapsed}ms`);
    assert.deepEqual(session.mcpStatus, { 'laravel-boost': 'pending' });
    assert.ok(lines.some((line) => line.includes('not connected') && line.includes('pending')));
  });

  it('bounds a status call that never answers by read_timeout_ms', async () => {
    const fake = fakeQuery(() => undefined, undefined, () => new Promise(() => undefined));
    const started = Date.now();
    const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(params({ claude: { read_timeout_ms: 100 }, extensions: boostExtensions() }));
    assert.ok(Date.now() - started < 300);
    await session.stop();
    assert.deepEqual(session.mcpStatus, { 'laravel-boost': 'pending' });
  });

  it('stops waiting for pending servers when the session is aborted', async () => {
    const controller = new AbortController();
    let calls = 0;
    const fake = fakeQuery(() => undefined, undefined, async () => {
      if (++calls === 2) controller.abort('issue moved to Done');
      return [{ name: 'laravel-boost', status: 'pending' }];
    });
    const started = Date.now();
    const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(
      params({ claude: { read_timeout_ms: 30_000 }, extensions: boostExtensions(), signal: controller.signal }),
    );
    assert.ok(Date.now() - started < 2_000);
    assert.equal(calls, 2);
    await session.stop();
  });

  it('records a status query failure without throwing', async () => {
    const fake = fakeQuery(() => undefined, undefined, async () => {
      throw new Error('control channel closed');
    });
    const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(params({ extensions: boostExtensions() }));
    await session.stop();
    assert.deepEqual(session.mcpStatus, { 'laravel-boost': 'pending' });
  });

  it('keeps the default tool rules without a policy and with default servers', async () => {
    const options = await sessionOptions({ extensions: serverExtensions({}) });
    assert.deepEqual(options.allowedTools, ['mcp__tracker__get_issue', 'mcp__srv']);
    assert.deepEqual(options.disallowedTools, ['AskUserQuestion']);
    const notReadOnly = await sessionOptions({ policy: { readOnly: false } });
    const noPolicy = await sessionOptions({});
    assert.deepEqual(notReadOnly.allowedTools, noPolicy.allowedTools);
    assert.deepEqual(notReadOnly.disallowedTools, noPolicy.disallowedTools);
  });

  it('bounds tracker tool calls by toolTimeoutMs unless claude.env sets MCP_TOOL_TIMEOUT', async () => {
    const timeoutOf = (options: Options) => (options.mcpServers?.tracker as { timeout?: number } | undefined)?.timeout;
    assert.equal(timeoutOf(await sessionOptions({})), undefined);
    assert.equal(timeoutOf(await sessionOptions({ toolTimeoutMs: 660_000 })), 660_000);
    const explicit = await sessionOptions({ toolTimeoutMs: 660_000, claude: { env: { MCP_TOOL_TIMEOUT: '900000' } } });
    assert.equal(timeoutOf(explicit), undefined);
    assert.equal(explicit.env?.MCP_TOOL_TIMEOUT, '900000');
  });

  it('denies the subagents a role or workspace does not allow, by rule and by hook', async () => {
    const events: AgentEvent[] = [];
    const options = await sessionOptions({ deniedAgents: ['symphony:laravel-filament-developer', 'laravel-filament-developer'], events });
    assert.ok(options.disallowedTools?.includes('Agent(symphony:laravel-filament-developer)'));
    assert.ok(options.disallowedTools?.includes('Agent(laravel-filament-developer)'));
    const matcher = options.hooks?.PreToolUse?.[0];
    assert.equal(matcher?.matcher, 'Agent|Task');
    const hook = matcher?.hooks[0];
    assert.ok(hook !== undefined);
    const call = (tool: string, input: unknown) =>
      hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 't1', session_id: 's', transcript_path: '', cwd: '/tmp' } as never, 't1', {
        signal: new AbortController().signal,
      });
    const denied = (await call('Agent', { subagent_type: 'symphony:laravel-filament-developer', prompt: 'x' })) as { hookSpecificOutput?: { permissionDecision?: string } };
    assert.equal(denied.hookSpecificOutput?.permissionDecision, 'deny');
    assert.equal(((await call('Task', { subagent_type: 'laravel-filament-developer' })) as typeof denied).hookSpecificOutput?.permissionDecision, 'deny');
    assert.deepEqual(await call('Agent', { subagent_type: 'symphony:laravel-code-reviewer' }), {});
    assert.deepEqual(await call('Agent', { prompt: 'no type: general-purpose' }), {});
    assert.ok(events.some((event) => event.event === 'approval_denied' && event.detail?.agent === 'symphony:laravel-filament-developer'));

    const open = await sessionOptions({});
    assert.equal(open.hooks, undefined);
    assert.ok(!open.disallowedTools?.some((rule) => rule.startsWith('Agent(')));
  });

  it('reports the subagent of an Agent tool call', async () => {
    const fake = fakeQuery((_prompt, _options, emit) => {
      emit({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Agent', input: { subagent_type: 'symphony:laravel-code-reviewer', description: 'Review the diff', prompt: 'x' } },
            { type: 'tool_use', name: 'Task', input: { description: 'Look around', prompt: 'y' } },
          ],
        },
        parent_tool_use_id: null,
      });
      emit(result(0.1, 10, 1));
    });
    const events: AgentEvent[] = [];
    const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(params({ events }));
    await session.runTurn('go');
    await session.stop();
    const calls = events.filter((event) => event.event === 'tool_use');
    assert.deepEqual(calls.map((event) => event.detail), [
      { tool: 'Agent', agent: 'symphony:laravel-code-reviewer' },
      { tool: 'Task', agent: 'general-purpose' },
    ]);
    assert.equal(calls[0]?.message, 'Agent: Review the diff');
  });

  it('tracks parallel subagents: tokens, end and session end', async () => {
    const usage = (input: number) => ({ input_tokens: input, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 });
    const inner = (parent: string, id: string, input: number) =>
      ({ type: 'assistant', message: { id, content: [{ type: 'text', text: 'x' }], usage: usage(input) }, parent_tool_use_id: parent });
    const fake = fakeQuery((_prompt, _options, emit) => {
      emit({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { subagent_type: 'Explore', description: 'Find files' } },
            { type: 'tool_use', id: 'toolu_b', name: 'Task', input: { prompt: `first line\n${'long '.repeat(100)}` } },
          ],
        },
        parent_tool_use_id: null,
      });
      emit(inner('toolu_a', 'm1', 10));
      emit(inner('toolu_a', 'm1', 10));
      emit(inner('toolu_a', 'm2', 20));
      emit(inner('toolu_b', 'm3', 7));
      emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }] }, parent_tool_use_id: 'toolu_a' });
      emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'done', is_error: false }] }, parent_tool_use_id: null });
      emit(result(0.1, 10, 1));
    });
    const events: AgentEvent[] = [];
    const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(params({ events }));
    await session.runTurn('go');
    const snapshots = (id: string) => events.flatMap((event) => (event.subagent?.toolUseId === id ? [event.subagent] : []));
    const [startA] = snapshots('toolu_a');
    assert.equal(startA?.subagentType, 'Explore');
    assert.equal(startA?.description, 'Find files');
    assert.equal(startA?.status, 'running');
    assert.ok(startA?.startedAt instanceof Date);
    const [startB] = snapshots('toolu_b');
    assert.equal(startB?.subagentType, 'general-purpose');
    assert.ok(startB?.description.startsWith('first line long long'));
    assert.equal(startB?.description.length, 200);
    const lastA = snapshots('toolu_a').at(-1);
    assert.equal(lastA?.status, 'ok');
    assert.ok(lastA?.endedAt instanceof Date);
    assert.deepEqual(lastA?.tokens, { inputTokens: 30, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 8 });
    assert.equal(snapshots('toolu_a').filter((run) => run.status !== 'running').length, 1);
    const beforeStop = snapshots('toolu_b').at(-1);
    assert.equal(beforeStop?.status, 'running');
    assert.equal(beforeStop?.tokens.inputTokens, 7);
    await session.stop();
    const lastB = snapshots('toolu_b').at(-1);
    assert.equal(lastB?.status, 'error');
    assert.ok(lastB?.endedAt instanceof Date);
    // Only start and end reach the timeline; token updates carry no message.
    assert.equal(events.filter((event) => event.event === 'subagent' && event.message !== undefined).length, 4);
    assert.equal(events.filter((event) => event.event === 'tool_use').length, 2);
  });

  it('marks a subagent whose tool result is an error', async () => {
    const fake = fakeQuery((_prompt, _options, emit) => {
      emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: {} }] }, parent_tool_use_id: null });
      emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'boom', is_error: true }] }, parent_tool_use_id: null });
      emit(result(0.1, 10, 1));
    });
    const events: AgentEvent[] = [];
    const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(params({ events }));
    await session.runTurn('go');
    await session.stop();
    assert.equal(events.filter((event) => event.subagent !== undefined).at(-1)?.subagent?.status, 'error');
  });

  it('adds the read-only deny rules', async () => {
    const options = await sessionOptions({ policy: { readOnly: true } });
    for (const rule of READ_ONLY_DENY) assert.ok(options.disallowedTools?.includes(rule), rule);
    assert.ok(options.disallowedTools?.includes('AskUserQuestion'));
  });

  it('denies git push in a read-only session even when the workflow allows it', async () => {
    const options = await sessionOptions({ claude: { allowed_tools: ['Bash(git push:*)'] }, policy: { readOnly: true } });
    assert.ok(options.allowedTools?.includes('Bash(git push:*)'));
    assert.ok(options.disallowedTools?.includes('Bash(git push:*)'));
    assert.equal(new Set(options.disallowedTools).size, options.disallowedTools?.length);
  });

  it('pre-approves only the listed tools of an extension server', async () => {
    const options = await sessionOptions({ extensions: serverExtensions({ autoApprove: ['a', 'b', 'a'] }) });
    assert.ok(options.allowedTools?.includes('mcp__srv__a'));
    assert.ok(options.allowedTools?.includes('mcp__srv__b'));
    assert.ok(!options.allowedTools?.includes('mcp__srv'));
    assert.equal(new Set(options.allowedTools).size, options.allowedTools?.length);
  });

  it('removes denied tools of an extension server', async () => {
    const options = await sessionOptions({ extensions: serverExtensions({ deny: ['x'] }) });
    assert.ok(options.disallowedTools?.includes('mcp__srv__x'));
    assert.ok(options.allowedTools?.includes('mcp__srv'));
  });

  it('maps the Laravel Boost tool policy into allowed and disallowed tools', async () => {
    const laravel = resolveConfig({}, { workflowPath: '/w/WORKFLOW.md', env: {}, trackerDefaults }).integrations.laravel as LaravelConfig;
    const policy = boostToolPolicy(laravel);
    const extensions: SessionExtensions = {
      mcpServers: { 'laravel-boost': { command: 'php', args: ['artisan', 'boost:mcp'], ...policy } },
      contextSections: [],
      additionalDirectories: [],
      env: {},
    };
    const options = await sessionOptions({ extensions });
    assert.ok(!options.allowedTools?.includes('mcp__laravel-boost'));
    for (const tool of ['application-info', 'database-query', 'search-docs']) assert.ok(options.allowedTools?.includes(`mcp__laravel-boost__${tool}`), tool);
    for (const tool of ['tinker', 'record-rule']) {
      assert.ok(options.disallowedTools?.includes(`mcp__laravel-boost__${tool}`), tool);
      assert.ok(!options.allowedTools?.includes(`mcp__laravel-boost__${tool}`), tool);
    }
  });

  it('refuses an extension server named like the tracker server', async () => {
    const fake = fakeQuery(() => undefined);
    const extensions: SessionExtensions = { mcpServers: { tracker: { command: 'x', args: [] } }, contextSections: [], additionalDirectories: [], env: {} };
    await assert.rejects(new ClaudeAgentRunner({ query: fake.fn }).startSession(params({ extensions })), { code: 'invalid_session_extensions' });
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

  describe('session limit', () => {
    const TEXT = "You've hit your session limit · resets 7:30pm (Europe/Berlin)";
    const limitEvent = (overrides: Record<string, unknown> = {}) => ({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1791221400, rateLimitType: 'five_hour', overageStatus: 'rejected', overageDisabledReason: 'out_of_credits', isUsingOverage: false, ...overrides },
    });
    const limitAssistant = (text = TEXT) => ({
      type: 'assistant',
      error: 'rate_limit',
      message: { model: '<synthetic>', content: [{ type: 'text', text }] },
    });
    const limitResult = (overrides: Record<string, unknown> = {}) =>
      result(0, 0, 0, { is_error: true, api_error_status: 429, terminal_reason: 'api_error', result: TEXT, ...overrides });

    async function run(script: Script) {
      const session = await new ClaudeAgentRunner({ query: fakeQuery(script).fn }).startSession(params());
      const outcome = await session.runTurn('go');
      await session.stop();
      return outcome;
    }

    it('classifies the three real messages with the event reset', async () => {
      const outcome = await run((_p, _o, emit) => {
        emit(limitEvent());
        emit(limitAssistant());
        emit(limitResult());
      });
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.equal(outcome.code, 'session_limit');
      assert.equal(outcome.message, `turn ended with an error: ${TEXT}`);
      assert.deepEqual(outcome.sessionLimit, {
        window: 'five_hour',
        scope: 'account',
        model: null,
        resetsAt: new Date('2026-10-05T17:30:00Z'),
        source: 'event',
        text: TEXT,
        overageDisabledReason: 'out_of_credits',
      });
    });

    it('classifies without the event, from the message text', async () => {
      const outcome = await run((_p, _o, emit) => {
        emit(limitAssistant());
        emit(limitResult());
      });
      assert.equal(outcome.ok === false && outcome.code, 'session_limit');
      const info = outcome.ok ? undefined : outcome.sessionLimit;
      assert.equal(info?.source, 'message');
      assert.equal(info?.window, 'five_hour');
      assert.ok(info?.resetsAt instanceof Date);
    });

    it('leaves resetsAt null when the time is unreadable', async () => {
      const text = "You've hit your session limit · resets soon";
      const outcome = await run((_p, _o, emit) => {
        emit(limitAssistant(text));
        emit(limitResult({ result: text }));
      });
      assert.equal(outcome.ok === false && outcome.code, 'session_limit');
      const info = outcome.ok ? undefined : outcome.sessionLimit;
      assert.equal(info?.resetsAt, null);
      assert.equal(info?.source, null);
    });

    it('falls back to the assistant text when the result text is empty', async () => {
      const outcome = await run((_p, _o, emit) => {
        emit(limitAssistant());
        emit(limitResult({ result: '', api_error_status: null }));
      });
      assert.equal(outcome.ok === false && outcome.code, 'session_limit');
      const info = outcome.ok ? undefined : outcome.sessionLimit;
      assert.equal(info?.text, TEXT);
      assert.equal(info?.window, 'five_hour');
    });

    describe('model limit (Fable)', () => {
      const FABLE = "You've reached your Fable limit. Switch to another model to continue.";
      // No transcript with this message exists yet, so every shape the SDK may use is covered.
      const shapes: Array<[string, Script]> = [
        [
          'failed result (as the session limit arrives today)',
          (_p, _o, emit) => {
            emit(limitEvent({ rateLimitType: 'seven_day', resetsAt: undefined }));
            emit(limitAssistant(FABLE));
            emit(limitResult({ result: FABLE }));
          },
        ],
        [
          'assistant rate_limit message with a failed result without text',
          (_p, _o, emit) => {
            emit(limitAssistant(FABLE));
            emit(result(0, 0, 0, { is_error: true, result: '' }));
          },
        ],
        ['successful result whose whole text is the limit message', (_p, _o, emit) => emit(result(0, 0, 0, { result: FABLE }))],
      ];
      for (const [name, script] of shapes) {
        it(`classifies a ${name} as a session limit of model fable`, async () => {
          const events: AgentEvent[] = [];
          const session = await new ClaudeAgentRunner({ query: fakeQuery(script).fn }).startSession(params({ events }));
          const outcome = await session.runTurn('go');
          await session.stop();
          assert.equal(outcome.ok, false);
          if (outcome.ok) return;
          assert.equal(outcome.code, 'session_limit');
          assert.equal(outcome.sessionLimit?.scope, 'model');
          assert.equal(outcome.sessionLimit?.model, 'fable');
          assert.equal(outcome.sessionLimit?.text, FABLE);
          // No turn_completed: it would count as a successful turn and lift the account-wide dispatch gate.
          assert.equal(events.some((event) => event.event === 'turn_completed'), false);
          const failed = events.find((event) => event.event === 'turn_failed');
          assert.deepEqual((failed?.detail?.session_limit as { scope?: string; model?: string } | undefined)?.model, 'fable');
        });
      }

      it('reports a successful limit turn with the limit text', async () => {
        const outcome = await run((_p, _o, emit) => emit(result(0, 0, 0, { result: FABLE })));
        assert.equal(outcome.ok === false && outcome.message, `turn ended with a usage limit: ${FABLE}`);
      });

      it('scopes a weekly Fable limit to the model even when the event says seven_day', async () => {
        const text = "You've hit your weekly Fable limit · resets Oct 9, 3pm (Europe/Berlin)";
        const outcome = await run((_p, _o, emit) => {
          emit(limitEvent({ rateLimitType: 'seven_day' }));
          emit(limitAssistant(text));
          emit(limitResult({ result: text }));
        });
        assert.equal(outcome.ok === false && outcome.code, 'session_limit');
        const info = outcome.ok ? undefined : outcome.sessionLimit;
        assert.equal(info?.window, 'seven_day');
        assert.equal(info?.scope, 'model');
        assert.equal(info?.model, 'fable');
      });

      it('scopes a seven_day_opus event without model wording to model opus', async () => {
        const outcome = await run((_p, _o, emit) => {
          emit(limitEvent({ rateLimitType: 'seven_day_opus' }));
          emit(limitResult({ result: 'Request rejected (429)' }));
        });
        const info = outcome.ok ? undefined : outcome.sessionLimit;
        assert.equal(info?.scope, 'model');
        assert.equal(info?.model, 'opus');
      });

      for (const text of [
        'I checked why the job failed: you hit your rate limit on the API. Added a retry with backoff.',
        `Done.\n\n${FABLE}`,
        `Summary: ${FABLE}`,
      ]) {
        it(`keeps a successful result that only mentions a limit as success (${JSON.stringify(text.slice(0, 30))})`, async () => {
          const events: AgentEvent[] = [];
          const session = await new ClaudeAgentRunner({ query: fakeQuery((_p, _o, emit) => emit(result(0, 0, 0, { result: text }))).fn }).startSession(
            params({ events }),
          );
          const outcome = await session.runTurn('go');
          await session.stop();
          assert.equal(outcome.ok, true);
          assert.ok(events.some((event) => event.event === 'turn_completed'));
        });
      }
    });

    it('keeps a bare 429 as turn_failed', async () => {
      const outcome = await run((_p, _o, emit) => emit(limitResult({ result: 'Request rejected (429)' })));
      assert.equal(outcome.ok === false && outcome.code, 'turn_failed');
      assert.equal(outcome.ok === false && outcome.sessionLimit, undefined);
    });

    it('keeps an event followed by an unrelated failure as turn_failed', async () => {
      const outcome = await run((_p, _o, emit) => {
        emit(limitEvent());
        emit(result(0, 0, 0, { subtype: 'error_during_execution', errors: ['tool crashed'] }));
      });
      assert.equal(outcome.ok === false && outcome.code, 'turn_failed');
    });

    it('classifies an event plus a 429 without limit text', async () => {
      const outcome = await run((_p, _o, emit) => {
        emit(limitEvent());
        emit(limitResult({ result: 'Request rejected (429)' }));
      });
      assert.equal(outcome.ok === false && outcome.code, 'session_limit');
    });

    it('does not leak a stale event into later turns', async () => {
      let turn = 0;
      const fake = fakeQuery((_p, _o, emit) => {
        turn += 1;
        if (turn === 1) {
          emit(limitEvent());
          emit({ type: 'system', subtype: 'api_retry' });
          emit(result(0, 0, 0));
        } else {
          emit(limitResult({ result: 'Request rejected (429)' }));
        }
      });
      const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(params());
      assert.equal((await session.runTurn('one')).ok, true);
      const second = await session.runTurn('two');
      assert.equal(second.ok === false && second.code, 'turn_failed');
      await session.stop();
    });

    it('ignores an event received between turns', async () => {
      let emitter: Emit | undefined;
      let turn = 0;
      const fake = fakeQuery((_p, _o, emit) => {
        emitter = emit;
        turn += 1;
        if (turn === 1) emit(result(0, 0, 0));
        else emit(limitResult({ result: 'Request rejected (429)' }));
      });
      const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(params());
      assert.equal((await session.runTurn('one')).ok, true);
      emitter?.(limitEvent());
      emitter?.(limitAssistant());
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = await session.runTurn('two');
      assert.equal(second.ok === false && second.code, 'turn_failed');
      await session.stop();
    });

    it('ignores allowed_warning events', async () => {
      const outcome = await run((_p, _o, emit) => {
        emit(limitEvent({ status: 'allowed_warning' }));
        emit(result(0, 0, 0));
      });
      assert.equal(outcome.ok, true);
    });
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
