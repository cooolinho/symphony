import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentRunner, type QueryFn } from '../src/agent/claude.ts';
import type { AgentEvent, StartSessionParams, SubagentRun } from '../src/agent/types.ts';
import { Logger } from '../src/log.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { AsyncQueue } from '../src/util/async.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { makeIssue } from './helpers.ts';

// Independent acceptance tests for E4-6 (#516), derived from the issue: subagent messages are attributed by `agent_id`,
// task events by `task_id`, `parent_tool_use_id` / `tool_use_id` is the fallback for older shapes, a nested run gets its
// own figures. Reference figures (marktausschuss#205 reviewer): context 65,819, billed 528,688, 12 tool uses, Bash 11.

type Msg = Record<string, unknown>;

function replay(messages: Msg[]): QueryFn {
  return ({ prompt, options }) => {
    const out = new AsyncQueue<SDKMessage>();
    options?.abortController?.signal.addEventListener('abort', () => out.close());
    void (async () => {
      for await (const _ of prompt as AsyncIterable<SDKUserMessage>) {
        for (const message of messages) if (!out.closed) out.push(message as unknown as SDKMessage);
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

const resultMessage: Msg = {
  type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'done', total_cost_usd: 0.1, duration_ms: 1, duration_api_ms: 1,
  stop_reason: 'end_turn', usage: {}, modelUsage: {}, permission_denials: [], uuid: '00000000-0000-0000-0000-000000000000', session_id: 's',
};

async function run(messages: Msg[]): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const config = resolveConfig({ claude: { model: 'opus' } }, { workflowPath: '/w/WORKFLOW.md', env: {}, trackerDefaults }).claude;
  const issue = makeIssue({ id: 'a' });
  const params = {
    cwd: '/tmp', issue, config, tools: [], toolContext: () => ({ issue }), env: { PATH: '/usr/bin' }, logger: Logger.silent(),
    signal: new AbortController().signal, onEvent: (event: AgentEvent) => void events.push(event), transcriptPath: null,
  } as unknown as StartSessionParams;
  const session = await new ClaudeAgentRunner({ query: replay([...messages, resultMessage]) }).startSession(params);
  await session.runTurn('go');
  await session.stop();
  return events;
}

const lastRun = (events: AgentEvent[], toolUseId: string): SubagentRun | undefined =>
  events.flatMap((event) => (event.subagent?.toolUseId === toolUseId ? [event.subagent] : [])).at(-1);
const billed = (r: SubagentRun | undefined) => r!.tokens.inputTokens + r!.tokens.outputTokens + r!.tokens.cacheReadTokens + r!.tokens.cacheWriteTokens;

const agentCall = (id: string, parent: string | null = null, agentId?: string): Msg => ({
  type: 'assistant',
  message: { id: `call_${id}`, content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: 'symphony:laravel-code-reviewer', description: `run ${id}` } }], usage: { input_tokens: 1, output_tokens: 1 } },
  parent_tool_use_id: parent,
  ...(agentId === undefined ? {} : { agent_id: agentId }),
});
const started = (taskId: string, toolUseId: string): Msg => ({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId, description: 'd', task_type: 'local_agent' });
const notify = (taskId: string | undefined, toolUseId: string | undefined, totalTokens: number, toolUses: number): Msg => ({
  type: 'system', subtype: 'task_notification', status: 'completed', output_file: '', summary: '',
  usage: { total_tokens: totalTokens, tool_uses: toolUses, duration_ms: 1000 },
  ...(taskId === undefined ? {} : { task_id: taskId }),
  ...(toolUseId === undefined ? {} : { tool_use_id: toolUseId }),
});
const progress = (taskId: string | undefined, toolUseId: string | undefined, totalTokens: number, toolUses: number): Msg => ({
  type: 'system', subtype: 'task_progress', description: 'd', usage: { total_tokens: totalTokens, tool_uses: toolUses, duration_ms: 500 },
  ...(taskId === undefined ? {} : { task_id: taskId }),
  ...(toolUseId === undefined ? {} : { tool_use_id: toolUseId }),
});
const toolResult = (toolUseId: string): Msg => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }] }, parent_tool_use_id: null });
/** An assistant message from inside a subagent with a text block only (tokens: in / out / cache read / cache write). */
const inner = (id: string, parent: string | null, agentId: string | undefined, usage: [number, number, number, number]): Msg => ({
  type: 'assistant',
  message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: usage[0], output_tokens: usage[1], cache_read_input_tokens: usage[2], cache_creation_input_tokens: usage[3] } },
  parent_tool_use_id: parent,
  ...(agentId === undefined ? {} : { agent_id: agentId }),
});
const tools = (id: string, parent: string | null, agentId: string | undefined, names: string[]): Msg => ({
  type: 'assistant',
  message: { id, model: 'claude-opus-5-5', content: names.map((name, i) => ({ type: 'tool_use', id: `${id}_${i}`, name, input: {} })), usage: { input_tokens: 1, output_tokens: 1 } },
  parent_tool_use_id: parent,
  ...(agentId === undefined ? {} : { agent_id: agentId }),
});

const OUTER = 'toolu_outer';

describe('E4-6 (#516): attribution by agent_id and task_id', () => {
  /** The #205 reviewer: two model calls (billed 528,688 together), 12 tool uses, context 65,819. */
  const reviewer = (shape: 'plain' | 'agent' | 'agent-only'): Msg[] => {
    const agentId = shape === 'plain' ? undefined : 't1';
    const parent = shape === 'agent-only' ? null : OUTER;
    return [
      agentCall(OUTER),
      started('t1', OUTER),
      inner('m1', parent, agentId, [2, 990, 451649, 10228]),
      progress('t1', OUTER, 30000, 6),
      inner('m2', parent, agentId, [2, 1588, 63392, 837]),
      notify('t1', OUTER, 65819, 12),
      toolResult(OUTER),
    ];
  };

  for (const shape of ['plain', 'agent', 'agent-only'] as const) {
    it(`gives context 65,819, billed 528,688 and 12 tool uses for the ${shape} shape`, async () => {
      const snap = lastRun(await run(reviewer(shape)), OUTER);
      assert.equal(snap?.status, 'ok');
      assert.equal(snap?.contextTokens, 65819);
      assert.equal(billed(snap), 528688);
      assert.equal(snap?.toolUses, 12);
      assert.deepEqual(snap?.models, ['claude-opus-5-5']);
    });
  }

  it('does not add a second subagent or notification events for the agent_id shapes', async () => {
    for (const shape of ['agent', 'agent-only'] as const) {
      const events = await run(reviewer(shape));
      const ids = new Set(events.flatMap((e) => (e.subagent ? [e.subagent.toolUseId] : [])));
      assert.deepEqual([...ids], [OUTER]);
      assert.equal(events.filter((e) => e.event === 'notification' && String(e.message).startsWith('system/task_')).length, 0);
    }
  });

  it('counts a message once per message id also when it arrives with agent_id', async () => {
    const snap = lastRun(await run([agentCall(OUTER), started('t1', OUTER), inner('m1', null, 't1', [2, 5, 0, 0]), inner('m1', null, 't1', [2, 9, 0, 0]), toolResult(OUTER)]), OUTER);
    assert.equal(snap?.tokens.outputTokens, 9);
    assert.equal(snap?.tokens.inputTokens, 2);
  });

  it('flags the 11 Bash and 1 SubagentHandback calls of the #205 session as subagent calls, with and without agent_id', async () => {
    for (const shape of ['plain', 'agent', 'agent-only'] as const) {
      const agentId = shape === 'plain' ? undefined : 't1';
      const parent = shape === 'agent-only' ? null : OUTER;
      const events = await run([
        agentCall(OUTER),
        started('t1', OUTER),
        tools('s1', parent, agentId, ['Bash', 'Bash', 'Bash']),
        tools('s2', parent, agentId, ['Bash', 'Bash', 'Bash', 'Bash', 'Bash', 'Bash', 'Bash', 'Bash']),
        tools('s3', parent, agentId, ['SubagentHandback']),
        tools('main', null, undefined, ['Bash']),
      ]);
      const uses = events.filter((e) => e.event === 'tool_use' && (e.detail as { tool?: string })?.tool !== 'Agent');
      const flagged = uses.filter((e) => e.detail?.subagent === true);
      assert.equal(flagged.filter((e) => e.detail?.tool === 'Bash').length, 11, shape);
      assert.equal(flagged.filter((e) => e.detail?.tool === 'SubagentHandback').length, 1, shape);
      const main = uses.filter((e) => e.detail?.subagent !== true);
      assert.equal(main.length, 1, shape);
      assert.ok(!('subagent' in (main[0]!.detail ?? {})), shape);
    }
  });

  it('keeps a message with agent_id and without parent_tool_use_id out of the context fill', async () => {
    const contexts = (events: AgentEvent[]) => events.flatMap((e) => (e.event === "model_call" && e.context ? [e.context.tokens] : []));
    const main: Msg = { type: 'assistant', parent_tool_use_id: null, message: { id: 'mm', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 100, output_tokens: 1 } } };
    const events = await run([agentCall(OUTER), started('t1', OUTER), main, inner('big', null, 't1', [999999, 1, 0, 0]), toolResult(OUTER)]);
    const seen = contexts(events);
    assert.ok(seen.length > 0, 'the main message reports a context');
    assert.ok(seen.every((tokens) => tokens <= 1000), `context stays at the main conversation: ${seen.join(',')}`);
    assert.ok(seen.includes(100), "the main message fills the context");
  });

  describe('fallback to parent_tool_use_id / tool_use_id', () => {
    it('uses parent_tool_use_id for an agent_id that is not known', async () => {
      const snap = lastRun(await run([agentCall(OUTER), inner('m1', OUTER, 'agent-never-announced', [2, 990, 0, 0]), toolResult(OUTER)]), OUTER);
      assert.equal(snap?.tokens.outputTokens, 990);
      assert.equal(snap?.tokens.inputTokens, 2);
    });

    it('uses parent_tool_use_id for old messages without agent_id and tool_use_id for old task events without a known task_id', async () => {
      const snap = lastRun(await run([agentCall(OUTER), inner('m1', OUTER, undefined, [2, 990, 0, 0]), notify(undefined, OUTER, 65819, 12), toolResult(OUTER)]), OUTER);
      assert.equal(snap?.tokens.outputTokens, 990);
      assert.equal(snap?.contextTokens, 65819);
      assert.equal(snap?.toolUses, 12);
    });

    it('does not crash or invent a run for a message with an unknown agent_id and no parent', async () => {
      const events = await run([agentCall(OUTER), inner('m1', null, 'ghost', [2, 990, 0, 0]), toolResult(OUTER)]);
      const snap = lastRun(events, OUTER);
      assert.equal(snap?.status, 'ok');
      assert.equal(snap?.tokens.outputTokens, 0);
      assert.deepEqual([...new Set(events.flatMap((e) => (e.subagent ? [e.subagent.toolUseId] : [])))], [OUTER]);
    });

    it('ignores an empty agent_id and uses the parent', async () => {
      const snap = lastRun(await run([agentCall(OUTER), inner('m1', OUTER, '', [2, 990, 0, 0]), toolResult(OUTER)]), OUTER);
      assert.equal(snap?.tokens.outputTokens, 990);
    });

    it('keeps a task event of an unknown tool call and an unknown task as a plain notification', async () => {
      const events = await run([agentCall(OUTER), progress('tX', 'toolu_other', 1, 1), progress('tY', undefined, 1, 1)]);
      assert.equal(events.filter((e) => e.event === 'notification' && e.message === 'system/task_progress').length, 2);
      assert.equal(lastRun(events, OUTER)?.contextTokens, null);
    });
  });

  describe('task events by task_id', () => {
    it('matches progress and notification without tool_use_id by the task_id learned from task_started', async () => {
      const events = await run([agentCall(OUTER), started('t1', OUTER), progress('t1', undefined, 30000, 6), notify('t1', undefined, 65819, 12), toolResult(OUTER)]);
      const snap = lastRun(events, OUTER);
      assert.equal(snap?.contextTokens, 65819);
      assert.equal(snap?.toolUses, 12);
      assert.equal(snap?.durationMs, 1000);
      assert.equal(events.filter((e) => e.event === 'notification' && String(e.message).startsWith('system/task_')).length, 0);
    });

    it('a notification with only a task_id still updates the run after the tool_result', async () => {
      const snap = lastRun(await run([agentCall(OUTER), started('t1', OUTER), toolResult(OUTER), notify('t1', undefined, 65819, 12)]), OUTER);
      assert.equal(snap?.status, 'ok');
      assert.equal(snap?.contextTokens, 65819);
      assert.equal(snap?.toolUses, 12);
    });

    it('learns the task_id from the first agent_id message when no task_started came', async () => {
      const snap = lastRun(await run([agentCall(OUTER), inner('m1', OUTER, 't1', [2, 990, 0, 0]), notify('t1', undefined, 65819, 12), toolResult(OUTER)]), OUTER);
      assert.equal(snap?.contextTokens, 65819);
      assert.equal(snap?.toolUses, 12);
    });
  });

  describe('concurrent and nested runs', () => {
    const A = 'toolu_a';
    const B = 'toolu_b';

    it('keeps two concurrent runs apart when their messages carry only agent_id', async () => {
      const events = await run([
        agentCall(A),
        agentCall(B),
        started('ta', A),
        started('tb', B),
        inner('a1', null, 'ta', [1, 10, 0, 0]),
        inner('b1', null, 'tb', [2, 20, 0, 0]),
        inner('a2', null, 'ta', [3, 30, 0, 0]),
        tools('b2', null, 'tb', ['Bash']),
        notify('ta', undefined, 111, 1),
        notify('tb', undefined, 222, 2),
        toolResult(A),
        toolResult(B),
      ]);
      const a = lastRun(events, A);
      const b = lastRun(events, B);
      assert.deepEqual([a?.tokens.inputTokens, a?.tokens.outputTokens, a?.contextTokens, a?.toolUses], [4, 40, 111, 1]);
      assert.deepEqual([b?.tokens.inputTokens, b?.tokens.outputTokens, b?.contextTokens, b?.toolUses], [3, 21, 222, 2]);
    });

    it('prefers agent_id over a misleading parent_tool_use_id (concurrent runs)', async () => {
      const events = await run([
        agentCall(A),
        agentCall(B),
        started('ta', A),
        started('tb', B),
        inner('x1', A, 'tb', [0, 77, 0, 0]), // says parent A, but is run B's message
        toolResult(A),
        toolResult(B),
      ]);
      assert.equal(lastRun(events, A)?.tokens.outputTokens, 0);
      assert.equal(lastRun(events, B)?.tokens.outputTokens, 77);
    });

    // The nested Agent call is made inside run A (its message carries A's agent_id); its own messages carry the nested
    // run's agent_id, even though the tool-use-id heuristic would still see the outer call as parent.
    const NESTED = 'toolu_nested';
    const nestedFlow = (nestedParent: string | null): Msg[] => [
      agentCall(A),
      started('ta', A),
      inner('a1', A, 'ta', [1, 10, 0, 0]),
      agentCall(NESTED, A, 'ta'),
      started('tn', NESTED),
      inner('n1', nestedParent, 'tn', [5, 50, 0, 0]),
      tools('n2', nestedParent, 'tn', ['Bash', 'Bash']),
      inner('a2', A, 'ta', [1, 11, 0, 0]),
      notify('tn', NESTED, 900, 3),
      toolResult(NESTED),
      notify('ta', A, 1200, 7),
      toolResult(A),
    ];

    for (const [label, parent] of [['the outer call as parent_tool_use_id', A], ['the nested call as parent_tool_use_id', NESTED], ['no parent_tool_use_id', null]] as const) {
      it(`attributes a nested run to its own subagent, not to the parent (nested messages with ${label})`, async () => {
        const events = await run(nestedFlow(parent));
        const outer = lastRun(events, A);
        const nested = lastRun(events, NESTED);
        // Own run: its tokens (5+1 in, 50+1 out), tool uses and status.
        assert.equal(nested?.status, 'ok');
        assert.equal(nested?.tokens.inputTokens, 6);
        assert.equal(nested?.tokens.outputTokens, 51);
        assert.equal(nested?.contextTokens, 900);
        assert.equal(nested?.toolUses, 3);
        // The parent only has its own calls: a1, a2 and the call that started the nested run (1 in, 1 out).
        assert.equal(outer?.tokens.inputTokens, 1 + 1 + 1);
        assert.equal(outer?.tokens.outputTokens, 10 + 11 + 1);
        assert.equal(outer?.contextTokens, 1200);
        assert.equal(outer?.toolUses, 7);
        assert.equal(outer?.status, 'ok');
      });
    }

    it('flags the calls of the nested run as subagent calls, not as main-thread calls', async () => {
      const events = await run(nestedFlow(null));
      const bash = events.filter((e) => e.event === 'tool_use' && e.detail?.tool === 'Bash');
      assert.equal(bash.length, 2);
      assert.ok(bash.every((e) => e.detail?.subagent === true));
    });

    it('ends the nested run on its own tool_result without ending the parent', async () => {
      const events = await run(nestedFlow(null).slice(0, 10)); // up to and including the nested tool_result
      assert.equal(lastRun(events, NESTED)?.status, 'ok');
      assert.equal(lastRun(events, A)?.status, 'error'); // closed only when the session stops: still running before
    });
  });
});
