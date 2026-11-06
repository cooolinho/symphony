import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentRunner, type QueryFn } from '../src/agent/claude.ts';
import type { SessionExtensions, SessionPolicy, StartSessionParams } from '../src/agent/types.ts';
import { Logger } from '../src/log.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { AsyncQueue } from '../src/util/async.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { makeIssue } from './helpers.ts';

// Acceptance tests for E4-4 "deny forks before any upgrade" (#513), derived from the issue: Agent(fork) is in every
// session's disallowedTools, CLAUDE_CODE_FORK_SUBAGENT=0 is in the default env and claude.env can override the variable.

const FORK_RULE = 'Agent(fork)';
const FORK_ENV = 'CLAUDE_CODE_FORK_SUBAGENT';

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
  claude?: Record<string, unknown>;
  policy?: SessionPolicy;
  deniedAgents?: string[];
  extensions?: SessionExtensions;
}

async function optionsFor(setup: Setup = {}): Promise<Options> {
  const config = resolveConfig({ claude: { model: 'opus', ...setup.claude } }, { workflowPath: '/w/WORKFLOW.md', env: {}, trackerDefaults }).claude;
  const issue = makeIssue({ id: 'a' });
  const params: StartSessionParams = {
    cwd: '/tmp',
    issue,
    config,
    tools: [],
    toolContext: () => ({ issue }),
    env: { PATH: '/usr/bin' },
    logger: Logger.silent(),
    signal: new AbortController().signal,
    onEvent: () => undefined,
    transcriptPath: null,
    ...(setup.policy ? { policy: setup.policy } : {}),
    ...(setup.deniedAgents ? { deniedAgents: setup.deniedAgents } : {}),
    ...(setup.extensions ? { extensions: setup.extensions } : {}),
  };
  const fake = capture();
  const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession(params);
  await session.stop();
  return fake.options();
}

function count(rules: string[] | undefined, rule: string): number {
  return (rules ?? []).filter((r) => r === rule).length;
}

describe('E4-4: fork subagents are denied in every session', () => {
  const roles: Array<[string, Setup]> = [
    ['writing role with denied agents', { policy: { readOnly: false }, deniedAgents: ['symphony:laravel-filament-developer', 'symphony:laravel-code-reviewer'] }],
    ['writing role without policy', {}],
    ['read-only role with denied agents', { policy: { readOnly: true }, deniedAgents: ['symphony:laravel-filament-developer'] }],
    ['read-only role without denied agents', { policy: { readOnly: true } }],
    ['role without agents (empty denied list)', { deniedAgents: [] }],
    ['role without agents (no denied list at all)', { policy: { readOnly: false } }],
    ['role with allowed/denied tool config', { claude: { disallowedTools: ['WebFetch'], allowedTools: ['Read'] } }],
  ];

  for (const [name, setup] of roles) {
    it(`${name}: Agent(fork) is denied exactly once and the variable is 0`, async () => {
      const options = await optionsFor(setup);
      assert.equal(count(options.disallowedTools, FORK_RULE), 1, JSON.stringify(options.disallowedTools));
      assert.equal(options.env?.[FORK_ENV], '0');
    });
  }

  it('keeps the other deny rules next to the fork rule', async () => {
    const readOnly = await optionsFor({ policy: { readOnly: true }, deniedAgents: ['symphony:a'] });
    for (const rule of ['AskUserQuestion', 'Edit', 'Write', 'Bash(git push:*)', 'Agent(symphony:a)', FORK_RULE]) {
      assert.ok(readOnly.disallowedTools?.includes(rule), rule);
    }
    assert.equal(new Set(readOnly.disallowedTools).size, readOnly.disallowedTools?.length);
    const writing = await optionsFor({ policy: { readOnly: false }, deniedAgents: ['symphony:a'] });
    assert.ok(writing.disallowedTools?.includes('Agent(symphony:a)'));
    assert.ok(!writing.disallowedTools?.includes('Edit'));
  });

  it('does not duplicate the rule when claude.disallowedTools already lists it', async () => {
    const options = await optionsFor({ claude: { disallowedTools: [FORK_RULE] } });
    assert.equal(count(options.disallowedTools, FORK_RULE), 1);
  });

  it('does not deny plain agents without a denied list (only the fork)', async () => {
    const options = await optionsFor({});
    assert.deepEqual(
      (options.disallowedTools ?? []).filter((rule) => rule.startsWith('Agent')),
      [FORK_RULE],
    );
  });

  it('keeps the other session env defaults next to the fork variable', async () => {
    const options = await optionsFor({});
    assert.equal(options.env?.PATH, '/usr/bin');
    assert.equal(options.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
    assert.equal(options.env?.[FORK_ENV], '0');
  });

  it('lets claude.env override the variable and keeps the deny rule', async () => {
    const options = await optionsFor({ claude: { env: { [FORK_ENV]: '1' } } });
    assert.equal(options.env?.[FORK_ENV], '1');
    assert.equal(count(options.disallowedTools, FORK_RULE), 1);
  });

  it('an unrelated claude.env entry does not touch the variable', async () => {
    const options = await optionsFor({ claude: { env: { FOO: 'bar' } } });
    assert.equal(options.env?.FOO, 'bar');
    assert.equal(options.env?.[FORK_ENV], '0');
  });
});

describe('E4-4: docs/agent-claude.md#subagents', () => {
  const doc = readFileSync(new URL('../docs/agent-claude.md', import.meta.url), 'utf8');
  const start = doc.search(/^#{2,4} Subagents/m);
  const section = start === -1 ? '' : doc.slice(start).split(/\n## /)[0] ?? '';

  it('has a subagents section', () => {
    assert.notEqual(start, -1);
  });

  it('documents the deny rule, the variable and the reason', () => {
    assert.match(section, /Agent\(fork\)/);
    assert.match(section, /CLAUDE_CODE_FORK_SUBAGENT/);
    assert.match(section, /0\.3\.302/);
    assert.match(section, /bypass/i);
    assert.match(section, /claude\.env/);
  });
});
