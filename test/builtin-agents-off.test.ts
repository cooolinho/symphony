import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentRunner, type QueryFn } from '../src/agent/claude.ts';
import type { SessionExtensions, StartSessionParams } from '../src/agent/types.ts';
import { parseSubagents } from '../src/history/history.ts';
import { Logger } from '../src/log.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { AsyncQueue } from '../src/util/async.ts';
import { commandSkills } from '../src/workflow/command.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { compilePrompt, issueTemplateValue, renderPrompt } from '../src/workflow/template.ts';
import { makeIssue } from './helpers.ts';

/**
 * Switch off the built-in agents (E4-3): derived from the acceptance criteria of the issue, not from the
 * implementation. The SDK-side behaviour ("subagent_type is required", the content of init.agents) needs a live
 * session and is checked in the PR; here: the env that reaches the SDK, the shipped prompts, the history fallback
 * and the docs.
 */

const root = path.join(import.meta.dirname, '..');
const BUILT_IN = ['claude', 'Explore', 'general-purpose', 'Plan', 'statusline-setup'];
const FLAG = 'CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS';

/** The options the SDK query is called with for a session started with the given config and extensions. */
async function queryOptions(claude: Record<string, unknown> = {}, extensions?: SessionExtensions): Promise<Options> {
  let captured: Options | undefined;
  const fn: QueryFn = ({ prompt, options }) => {
    captured = options;
    const out = new AsyncQueue<SDKMessage>();
    options?.abortController?.signal.addEventListener('abort', () => out.close());
    void (async () => {
      for await (const _ of prompt as AsyncIterable<SDKUserMessage>) void _;
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
  const config = resolveConfig({ claude: { model: 'opus', ...claude } }, { workflowPath: '/w/WORKFLOW.md', env: {}, trackerDefaults }).claude;
  const issue = makeIssue({ id: 'a' });
  const startParams: StartSessionParams = {
    cwd: '/tmp',
    issue,
    config,
    tools: [],
    toolContext: () => ({ issue }),
    env: { PATH: '/usr/bin', KEEP_ME: 'yes' },
    logger: Logger.silent(),
    signal: new AbortController().signal,
    onEvent: () => undefined,
    transcriptPath: null,
    ...(extensions ? { extensions } : {}),
  };
  const session = await new ClaudeAgentRunner({ query: fn }).startSession(startParams);
  await session.stop();
  assert.ok(captured, 'the SDK query was never called');
  return captured;
}

describe('built-in agents off: session env', () => {
  it('sets the flag to "1" by default', async () => {
    const options = await queryOptions();
    assert.equal(options.env?.[FLAG], '1');
  });

  it('keeps the other session defaults and the process env', async () => {
    const options = await queryOptions();
    assert.equal(options.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
    assert.equal(options.env?.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, '1');
    assert.equal(options.env?.CLAUDE_CODE_FORK_SUBAGENT, '0');
    assert.equal(options.env?.KEEP_ME, 'yes');
  });

  it('lets claude.env bring the built-ins back with "0", leaving the other defaults alone', async () => {
    const options = await queryOptions({ env: { [FLAG]: '0' } });
    assert.equal(options.env?.[FLAG], '0');
    assert.equal(options.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
  });

  it('lets an unrelated claude.env key through without touching the flag', async () => {
    const options = await queryOptions({ env: { SOMETHING_ELSE: 'x' } });
    assert.equal(options.env?.SOMETHING_ELSE, 'x');
    assert.equal(options.env?.[FLAG], '1');
  });

  it('lets claude.env win over the env of the session extensions', async () => {
    const extensions: SessionExtensions = { mcpServers: {}, contextSections: [], additionalDirectories: [], env: { [FLAG]: '0' } };
    assert.equal((await queryOptions({}, extensions)).env?.[FLAG], '0');
    assert.equal((await queryOptions({ env: { [FLAG]: '1' } }, extensions)).env?.[FLAG], '1');
  });

  it('does not deny or add any built-in agent through the tool lists (they are off at the SDK, not filtered)', async () => {
    const options = await queryOptions();
    for (const name of BUILT_IN) assert.ok(!options.disallowedTools?.includes(`Agent(${name})`), name);
  });
});

describe('built-in agents off: the shipped prompts always name the agent type', () => {
  const shipped = path.join(root, 'WORKFLOW.md');
  const toolbox = path.join(root, '.claude');
  const agent = (name: string) => ({ name: `symphony:${name}`, description: `The ${name}.` });
  const ALL = ['explorer', 'laravel-architect', 'laravel-database-engineer', 'laravel-filament-developer', 'laravel-test-engineer', 'laravel-code-reviewer', 'test-designer'];

  async function render(role: string, labels: string[]): Promise<string> {
    const issue = makeIssue({ id: 'PVTI_1', identifier: 'acme/app#42', title: 'Add invoices', description: 'Create an invoice resource.', state: 'In progress', url: 'https://github.com/acme/app/issues/42', labels });
    const { definition } = await loadWorkflowFile(shipped);
    const template = compilePrompt(definition.promptTemplate, definition.partials);
    assert.equal(template.parseError, null);
    return renderPrompt(template, { issue: issueTemplateValue(issue, commandSkills([toolbox])), attempt: null, role, agents: ALL.map(agent), round: 1, test_paths: ['tests/**'] });
  }

  async function roleNames(): Promise<string[]> {
    const { definition } = await loadWorkflowFile(shipped);
    const roles = (definition.config as { roles?: Record<string, unknown> }).roles ?? {};
    return Object.keys(roles);
  }

  it('renders every shipped role without naming a built-in agent', async () => {
    const roles = await roleNames();
    assert.ok(roles.length >= 7, roles.join());
    for (const role of roles) {
      for (const labels of [['feature', 'complexity: m'], ['feature', 'complexity: l']]) {
        const prompt = await render(role, labels);
        assert.doesNotMatch(prompt, /general-purpose|statusline-setup|\bExplore\b/, `${role} names a built-in agent`);
        assert.doesNotMatch(prompt, /`(claude|Plan)`/, `${role} names a built-in agent`);
        assert.doesNotMatch(prompt, /\{%|\{\{/, `${role}: Liquid left over`);
      }
    }
  });

  it('names the type with a qualified agent name wherever a role tells the agent to delegate', async () => {
    for (const role of ['developer', 'architect', 'analyst', 'planner', 'autopilot', 'auditor']) {
      const prompt = await render(role, ['feature', 'complexity: m']);
      const start = prompt.indexOf('When to delegate:');
      assert.ok(start >= 0, role);
      const bullets = prompt.slice(start).split('\n').slice(1).filter((line, i, all) => all.slice(0, i + 1).every((l) => l.startsWith('- ')));
      assert.ok(bullets.length > 0, role);
      for (const bullet of bullets) assert.match(bullet, /`symphony:[a-z-]+`|\(symphony:/, `${role}: "${bullet}" names no agent type`);
    }
  });

  it('tells the test engineer to pass the designer as subagent_type at complexity L', async () => {
    const prompt = await render('test-engineer', ['feature', 'complexity: l']);
    assert.match(prompt, /`subagent_type`: `symphony:test-designer`/);
  });

  it('introduces the Agent tool together with subagent_type and the qualified list', async () => {
    for (const role of ['developer', 'architect', 'reviewer']) {
      const prompt = await render(role, ['feature', 'complexity: m']);
      assert.match(prompt, /subagent_type/, role);
      assert.ok(prompt.includes('`symphony:explorer`'), role);
    }
  });
});

describe('built-in agents off: history keeps the general-purpose fallback', () => {
  const entry = (type: string) => ({ type, description: 'd', status: 'ok', started_at: '2026-01-01T00:00:00.000Z', ended_at: null, duration_ms: 1, context_tokens: null, tokens: 2, tool_uses: 1, models: [] });

  it('parses old log lines with general-purpose next to new ones unchanged', () => {
    const parsed = parseSubagents(JSON.stringify([entry('general-purpose'), entry('Explore'), entry('symphony:explorer')]));
    assert.deepEqual(parsed.map((s) => s.type), ['general-purpose', 'Explore', 'symphony:explorer']);
    assert.equal(parsed[0]?.tokens, 2);
    assert.equal(parsed[0]?.status, 'ok');
  });
});

describe('built-in agents off: docs', () => {
  const docs = fs.readFileSync(path.join(root, 'docs', 'agent-claude.md'), 'utf8');
  const subagents = docs.slice(docs.search(/^#+ .*subagents/im));

  it('documents the default, the five built-ins, the override and the denied plugin agents in the subagents section', () => {
    assert.ok(docs.search(/^#+ .*subagents/im) >= 0, 'no subagents heading');
    assert.ok(subagents.includes(FLAG));
    for (const name of BUILT_IN) assert.ok(subagents.includes(`\`${name}\``), name);
    assert.match(subagents, /subagent_type is required/);
    assert.match(subagents, /claude\.env/);
    assert.match(subagents, /init\.agents/);
    assert.match(subagents, /denies|denied/);
  });
});
