import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentRunner, type QueryFn } from '../src/agent/claude.ts';
import { Logger } from '../src/log.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { AsyncQueue } from '../src/util/async.ts';
import { commandSkills } from '../src/workflow/command.ts';
import { DEFAULTS, resolveConfig } from '../src/workflow/config.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { compilePrompt, issueTemplateValue, renderPrompt } from '../src/workflow/template.ts';
import { makeIssue } from './helpers.ts';

// #564: agent Bash calls got Claude Code's 120 s default, so a full test run was killed (error signature 7a3d71bf).
// Sessions now start with a longer but finite BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS; claude.env overrides them.

const root = path.join(import.meta.dirname, '..');
const CLAUDE_DEFAULT_MS = 120_000;

async function sessionEnv(claude: Record<string, unknown> = {}): Promise<Record<string, string | undefined>> {
  let captured: Options | undefined;
  const fn: QueryFn = ({ prompt, options }) => {
    captured = options;
    const out = new AsyncQueue<SDKMessage>();
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
    } as unknown as ReturnType<QueryFn>;
  };
  const config = resolveConfig({ claude: { model: 'opus', ...claude } }, { workflowPath: '/w/WORKFLOW.md', env: {}, trackerDefaults }).claude;
  const issue = makeIssue({ id: 'a' });
  const session = await new ClaudeAgentRunner({ query: fn }).startSession({
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
  });
  await session.stop();
  return captured?.env ?? {};
}

describe('agent Bash timeout (#564)', () => {
  it('starts sessions with a default above Claude Code’s 2 minutes and a larger maximum, both finite and below turn_timeout_ms', async () => {
    const env = await sessionEnv();
    const def = Number(env.BASH_DEFAULT_TIMEOUT_MS);
    const max = Number(env.BASH_MAX_TIMEOUT_MS);
    assert.ok(Number.isInteger(def) && def > CLAUDE_DEFAULT_MS, `BASH_DEFAULT_TIMEOUT_MS=${env.BASH_DEFAULT_TIMEOUT_MS}`);
    assert.ok(Number.isInteger(max) && max >= def, `BASH_MAX_TIMEOUT_MS=${env.BASH_MAX_TIMEOUT_MS}`);
    assert.ok(Number.isFinite(max), 'a hanging command must still end');
    assert.ok(max < DEFAULTS.turnTimeoutMs, 'the Bash maximum stays below claude.turn_timeout_ms');
    // a 260–350 s suite (entry-check durations of the affected repository) fits into one call
    assert.ok(def >= 350_000);
    assert.equal(env.BASH_DEFAULT_TIMEOUT_MS, '600000');
    assert.equal(env.BASH_MAX_TIMEOUT_MS, '1200000');
  });

  it('lets claude.env override each value on its own', async () => {
    const onlyDefault = await sessionEnv({ env: { BASH_DEFAULT_TIMEOUT_MS: '300000' } });
    assert.equal(onlyDefault.BASH_DEFAULT_TIMEOUT_MS, '300000');
    assert.equal(onlyDefault.BASH_MAX_TIMEOUT_MS, '1200000');
    const onlyMax = await sessionEnv({ env: { BASH_MAX_TIMEOUT_MS: '1800000' } });
    assert.equal(onlyMax.BASH_DEFAULT_TIMEOUT_MS, '600000');
    assert.equal(onlyMax.BASH_MAX_TIMEOUT_MS, '1800000');
  });

  it('keeps the other session defaults (foreground only, no fork) when claude.env sets the Bash timeouts', async () => {
    const env = await sessionEnv({ env: { BASH_DEFAULT_TIMEOUT_MS: '900000', BASH_MAX_TIMEOUT_MS: '900000' } });
    assert.equal(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
    assert.equal(env.CLAUDE_CODE_FORK_SUBAGENT, '0');
    assert.equal(env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS, '1');
  });

  it('does not change the checks timeout or the stall timeout defaults', () => {
    const config = resolveConfig({}, { workflowPath: '/w/WORKFLOW.md', env: {}, trackerDefaults });
    assert.equal(config.claude.stallTimeoutMs, 300_000);
    assert.equal(config.claude.turnTimeoutMs, 3_600_000);
    assert.ok(config.checks.timeoutMs < config.claude.turnTimeoutMs);
  });

  it('keeps the shipped WORKFLOW.md valid without a claude.env that shortens the Bash timeouts', async () => {
    const { definition } = await loadWorkflowFile(path.join(root, 'WORKFLOW.md'));
    const config = resolveConfig(definition.config, { workflowPath: path.join(root, 'WORKFLOW.md'), env: {}, trackerDefaults });
    const env = config.claude.env;
    assert.equal(env.BASH_DEFAULT_TIMEOUT_MS, undefined);
    assert.equal(env.BASH_MAX_TIMEOUT_MS, undefined);
    assert.ok(1_200_000 < config.claude.turnTimeoutMs);
  });
});

async function renderRole(role: string, labels: string[], attempt: number | null = null): Promise<string> {
  const { definition } = await loadWorkflowFile(path.join(root, 'WORKFLOW.md'));
  const template = compilePrompt(definition.promptTemplate, definition.partials);
  assert.equal(template.parseError, null);
  const issue = makeIssue({ id: 'PVTI_1', identifier: 'acme/app#42', title: 'Do it', description: 'Do it.', state: 'In progress', labels });
  return renderPrompt(template, {
    issue: issueTemplateValue(issue, commandSkills([path.join(root, '.claude')])),
    attempt,
    role,
    agents: [],
    project_types: ['laravel'],
  });
}

describe('role prompts tell agents to run the full suite in one Bash call (#564)', () => {
  const TYPES: Array<[string, string[]]> = [
    ['bugfix', ['bug', 'complexity: s']],
    ['feature', ['feature', 'complexity: m']],
    ['refactor', ['refactor', 'complexity: m']],
  ];
  for (const role of ['developer', 'test-engineer']) {
    for (const [name, labels] of TYPES) {
      it(`${role} prompt for a ${name} names one call, the timeout parameter and output filtering`, async () => {
        const prompt = await renderRole(role, labels);
        assert.match(prompt, /full (test )?suite/i);
        assert.match(prompt, /one Bash call/i);
        assert.match(prompt, /`timeout`/);
        assert.match(prompt, /1200000/);
        assert.match(prompt, /\| tail/);
      });
    }
  }
});

describe('Bash timeout documentation (#564)', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
  for (const rel of ['docs/configuration.md', 'docs/agent-claude.md', 'WORKFLOW.md']) {
    it(`${rel} names both variables, their defaults and the claude.env override`, () => {
      const text = read(rel);
      assert.match(text, /BASH_DEFAULT_TIMEOUT_MS/);
      assert.match(text, /BASH_MAX_TIMEOUT_MS/);
      assert.match(text, /600000/);
      assert.match(text, /1200000/);
      assert.match(text, /claude\.env|env:/);
    });
  }

  it('docs/agent-claude.md documents the error signature and the stall interaction', () => {
    const text = read('docs/agent-claude.md');
    assert.match(text, /7a3d71bf/);
    assert.match(text, /stall_timeout_ms/);
  });
});
