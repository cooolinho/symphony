import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentRunner, SUBAGENT_CONTEXT_MAX, subagentContext, type QueryFn } from '../src/agent/claude.ts';
import type { StartSessionParams, SubagentContext } from '../src/agent/types.ts';
import { Logger } from '../src/log.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { AsyncQueue } from '../src/util/async.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { makeIssue, tempDir } from './helpers.ts';

// Acceptance tests for E2-4 "issue context for every subagent (SubagentStart)" (#498), derived from the issue:
// a SubagentStart callback hook returns additionalContext for symphony:* agents only, bounded in length, next to the PreToolUse hook.

/** Captures the SDK options of the started session; the stream stays idle. */
function capture(): { fn: QueryFn; options: () => Options } {
  let captured: Options | undefined;
  const fn: QueryFn = ({ prompt, options }) => {
    captured = options;
    const out = new AsyncQueue<SDKMessage>();
    options?.abortController?.signal.addEventListener('abort', () => out.close());
    void (async () => {
      for await (const _ of prompt as AsyncIterable<SDKUserMessage>) {
        // no turn is run
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
  return { fn, options: () => captured as Options };
}

interface Setup {
  cwd?: string;
  id?: string;
  title?: string;
  readOnly?: boolean;
  deniedAgents?: string[];
  subagentContext?: SubagentContext;
}

async function optionsFor(setup: Setup = {}): Promise<Options> {
  const config = resolveConfig({ claude: { model: 'opus' } }, { workflowPath: '/w/WORKFLOW.md', env: {}, trackerDefaults }).claude;
  const issue = makeIssue({ id: setup.id ?? 'a', ...(setup.title !== undefined ? { title: setup.title } : {}) });
  const params: StartSessionParams = {
    cwd: setup.cwd ?? '/tmp',
    issue,
    config,
    tools: [],
    toolContext: () => ({ issue }),
    env: { PATH: '/usr/bin' },
    logger: Logger.silent(),
    signal: new AbortController().signal,
    onEvent: () => undefined,
    transcriptPath: null,
    ...(setup.readOnly !== undefined ? { policy: { readOnly: setup.readOnly } } : {}),
    ...(setup.deniedAgents ? { deniedAgents: setup.deniedAgents } : {}),
    ...(setup.subagentContext ? { subagentContext: setup.subagentContext } : {}),
  };
  const fake = capture();
  const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(params);
  await session.stop();
  return fake.options();
}

type Output = { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };

async function fire(options: Options, input: Record<string, unknown>): Promise<Output> {
  const hooks = options.hooks?.SubagentStart ?? [];
  assert.equal(hooks.length, 1, 'exactly one SubagentStart matcher');
  assert.equal(hooks[0]?.hooks.length, 1);
  const hook = hooks[0]?.hooks[0];
  assert.ok(hook !== undefined);
  return (await hook({ hook_event_name: 'SubagentStart', agent_id: 'a1', session_id: 's', transcript_path: '', cwd: '/tmp', ...input } as never, undefined, {
    signal: new AbortController().signal,
  })) as Output;
}

const contextOf = async (options: Options, agentType: unknown = 'symphony:explorer') => (await fire(options, { agent_type: agentType })).hookSpecificOutput?.additionalContext ?? '';

const BASE = { identifier: 'o/r#7', title: 'Title', cwd: '/w', readOnly: false, role: 'developer', acceptanceCriteria: [] as string[], rules: [] as string[] };
const LAST = 'Answer with `file:line` for every claim about the code.';

describe('E2-4: SubagentStart hook registration', () => {
  it('is registered without denied agents and there is no PreToolUse hook then', async () => {
    const options = await optionsFor({});
    assert.equal(options.hooks?.SubagentStart?.length, 1);
    assert.equal(options.hooks?.PreToolUse, undefined);
  });

  it('is registered next to the PreToolUse hook, and both work in one session', async () => {
    const options = await optionsFor({ deniedAgents: ['symphony:a', 'a'] });
    assert.deepEqual(Object.keys(options.hooks ?? {}).sort(), ['PreToolUse', 'SubagentStart']);
    assert.equal(options.hooks?.PreToolUse?.[0]?.matcher, 'Agent|Task');
    const pre = options.hooks?.PreToolUse?.[0]?.hooks[0];
    assert.ok(pre !== undefined);
    const denied = (await pre({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'symphony:a' }, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: '/tmp' } as never, 't', {
      signal: new AbortController().signal,
    })) as { hookSpecificOutput?: { permissionDecision?: string } };
    assert.equal(denied.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(await contextOf(options), /file:line/);
  });
});

describe('E2-4: content of the injected context', () => {
  it('names issue, title, role, read-only, absolute workspace, existing rules (in order) and the file:line instruction', async () => {
    const cwd = tempDir();
    assert.ok(path.isAbsolute(cwd));
    fs.mkdirSync(path.join(cwd, '.ai', 'rules'), { recursive: true });
    for (const file of ['CLAUDE.md', 'AGENTS.md', path.join('.ai', 'rules', 'index.md')]) fs.writeFileSync(path.join(cwd, file), '#');
    const options = await optionsFor({ cwd, id: 'x1', title: 'Export invoices', readOnly: true, subagentContext: { role: 'reviewer', acceptanceCriteria: ['First criterion', 'Second criterion'] } });
    const issue = makeIssue({ id: 'x1', title: 'Export invoices' });
    const output = await fire(options, { agent_type: 'symphony:laravel-code-reviewer' });
    assert.equal(output.hookSpecificOutput?.hookEventName, 'SubagentStart');
    const text = output.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(text.includes(`${issue.identifier}: Export invoices`), text);
    assert.match(text, /Role of the session: reviewer\. Read-only/);
    assert.ok(text.includes(cwd));
    const positions = ['CLAUDE.md', 'AGENTS.md', path.join('.ai', 'rules', 'index.md')].map((file) => text.indexOf(path.join(cwd, file)));
    assert.ok(positions.every((position) => position >= 0), text);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'rule files in the order CLAUDE.md, AGENTS.md, .ai/rules/index.md');
    assert.ok(text.includes('- First criterion\n- Second criterion'), text);
    assert.ok(text.endsWith(LAST));
  });

  it('says the session may change the workspace for a writing role', async () => {
    const text = await contextOf(await optionsFor({ readOnly: false, subagentContext: { role: 'developer', acceptanceCriteria: [] } }));
    assert.match(text, /Role of the session: developer\./);
    assert.ok(!text.includes('Read-only'), text);
    assert.match(text, /may change the workspace/);
  });

  it('lists only the rule files that exist; AGENTS.md alone is enough', async () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '#');
    const text = await contextOf(await optionsFor({ cwd }));
    assert.ok(text.includes(path.join(cwd, 'AGENTS.md')));
    assert.ok(!text.includes('CLAUDE.md'));
    assert.ok(!text.includes('index.md'));
    assert.ok(!text.includes('No CLAUDE.md'));
  });

  it('points at nothing and says so when the workspace has no rule files', async () => {
    const text = await contextOf(await optionsFor({ cwd: tempDir() }));
    assert.match(text, /No CLAUDE\.md, AGENTS\.md or \.ai\/rules\/index\.md/);
    assert.ok(text.endsWith(LAST));
  });

  it('leaves the criteria section out for an empty list or an absent subagentContext, without error', async () => {
    for (const subagentContext of [undefined, { role: 'developer', acceptanceCriteria: [] }]) {
      const text = await contextOf(await optionsFor({ ...(subagentContext ? { subagentContext } : {}) }));
      assert.ok(!text.includes('Acceptance criteria'), text);
      assert.ok(text.includes(makeIssue({ id: 'a' }).identifier));
    }
  });

  it('collapses multi-line criteria and the title to one line each', () => {
    const text = subagentContext({ ...BASE, title: 'Line one\nline two', acceptanceCriteria: ['alpha\n  beta\n\ngamma'] });
    assert.ok(text.includes('- alpha beta gamma'), text);
    assert.ok(text.includes('o/r#7: Line one line two.'), text);
  });

  it('each session injects its own issue and workspace', async () => {
    const [one, two] = [await optionsFor({ id: 'one', cwd: tempDir() }), await optionsFor({ id: 'two', cwd: tempDir() })];
    const [a, b] = [await contextOf(one), await contextOf(two)];
    assert.ok(a.includes(makeIssue({ id: 'one' }).identifier));
    assert.ok(b.includes(makeIssue({ id: 'two' }).identifier));
    assert.notEqual(a, b);
  });
});

describe('E2-4: other agents and events get nothing', () => {
  const types: unknown[] = ['general-purpose', 'Explore', 'Plan', 'fork', 'explorer', 'laravel-architect', 'other-plugin:explorer', 'Symphony:explorer', 'xsymphony:explorer', ' symphony:explorer', '', undefined, null, 42, { agent_type: 'symphony:x' }];
  for (const type of types) {
    it(`agent_type ${JSON.stringify(type) ?? 'undefined'} gets {}`, async () => {
      assert.deepEqual(await fire(await optionsFor({ subagentContext: { role: 'developer', acceptanceCriteria: ['x'] } }), { agent_type: type }), {});
    });
  }

  it('input without agent_type, and other hook events, get {}', async () => {
    const options = await optionsFor({});
    assert.deepEqual(await fire(options, {}), {});
    for (const event of ['PreToolUse', 'SubagentStop', 'SessionStart', 'UserPromptSubmit']) {
      assert.deepEqual(await fire(options, { hook_event_name: event, agent_type: 'symphony:explorer' }), {}, event);
    }
  });

  it('a symphony:* agent still gets it', async () => {
    for (const type of ['symphony:explorer', 'symphony:laravel-code-reviewer', 'symphony:test-designer']) assert.notEqual(await contextOf(await optionsFor({}), type), '');
  });
});

describe('E2-4: the context is bounded', () => {
  it('SUBAGENT_CONTEXT_MAX is a positive finite limit', () => {
    assert.ok(Number.isInteger(SUBAGENT_CONTEXT_MAX) && SUBAGENT_CONTEXT_MAX > 0 && SUBAGENT_CONTEXT_MAX <= 10_000);
  });

  it('never exceeds the limit for any number of long criteria, always ends with the instruction, and counts the left-out ones', () => {
    for (let count = 0; count <= 80; count += 1) {
      const criteria = Array.from({ length: count }, (_, i) => `${i}:${'x'.repeat(500)}`);
      const text = subagentContext({ ...BASE, acceptanceCriteria: criteria });
      assert.ok(text.length <= SUBAGENT_CONTEXT_MAX, `${count} criteria: ${text.length}`);
      assert.ok(text.endsWith(LAST), `${count}`);
      const kept = text.split('\n').filter((line) => /^- \d+:/.test(line)).length;
      const more = /^- … (\d+) more in the issue$/m.exec(text);
      if (kept === count) assert.equal(more, null, `${count}: nothing left out, no marker`);
      else assert.equal(Number(more?.[1]), count - kept, `${count}: marker counts the dropped criteria`);
      // the earliest criteria are the ones kept
      for (let i = 0; i < kept; i += 1) assert.ok(text.includes(`- ${i}:`), `${count}: criterion ${i}`);
    }
  });

  it('keeps a short list complete and marks a single criterion as cut at 400 characters', () => {
    const short = subagentContext({ ...BASE, acceptanceCriteria: ['a', 'b', 'c'] });
    assert.ok(short.includes('- a\n- b\n- c'));
    assert.ok(!short.includes('more in the issue'));
    const long = subagentContext({ ...BASE, acceptanceCriteria: ['y'.repeat(1000)] });
    const line = long.split('\n').find((candidate) => candidate.startsWith('- y')) ?? '';
    assert.ok(line.length <= 402, String(line.length));
    assert.ok(line.endsWith('…'));
  });

  it('keeps the fixed lines when only the criteria overflow', () => {
    const text = subagentContext({ ...BASE, rules: ['/w/CLAUDE.md'], acceptanceCriteria: Array.from({ length: 60 }, () => 'z'.repeat(400)) });
    for (const part of ['o/r#7', '/w', 'developer', '/w/CLAUDE.md']) assert.ok(text.includes(part), part);
  });

  it('holds the limit for a huge title and a huge workspace path', () => {
    const text = subagentContext({ ...BASE, title: 'T'.repeat(10_000), cwd: `/${'d'.repeat(10_000)}`, rules: [`/${'d'.repeat(10_000)}/CLAUDE.md`], acceptanceCriteria: ['c'] });
    assert.ok(text.length <= SUBAGENT_CONTEXT_MAX);
    assert.ok(text.endsWith(LAST));
  });

  it('the hook output obeys the limit too', async () => {
    const options = await optionsFor({ subagentContext: { role: 'developer', acceptanceCriteria: Array.from({ length: 200 }, (_, i) => `${i} ${'w'.repeat(300)}`) } });
    const text = await contextOf(options);
    assert.ok(text.length <= SUBAGENT_CONTEXT_MAX && text.length > 0);
    assert.match(text, /more in the issue/);
  });
});

describe('E2-4: documentation', () => {
  it('docs/agent-claude.md#subagents describes hook, limit and exclusions', () => {
    const doc = fs.readFileSync(path.join(import.meta.dirname, '..', 'docs', 'agent-claude.md'), 'utf8');
    const section = doc.slice(doc.indexOf('### Subagents'));
    assert.ok(section.includes('SubagentStart'));
    assert.ok(section.includes('4000'));
    assert.ok(section.includes('SUBAGENT_CONTEXT_MAX'));
    assert.match(section, /file:line/);
    assert.match(section, /symphony:\*/);
  });
});
