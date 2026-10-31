import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentRunner, type QueryFn } from '../src/agent/claude.ts';
import { brainToolsFor } from '../src/brain/tools.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { AsyncQueue } from '../src/util/async.ts';
import { commandSkills } from '../src/workflow/command.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { compilePrompt, issueTemplateValue, renderPrompt } from '../src/workflow/template.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, baseFront, makeIssue, makeWorkflow, tempDir, until } from './helpers.ts';

// Independent acceptance tests for the role switch `brain: off | read | write` (E7-5), derived from the issue.

const shipped = path.join(import.meta.dirname, '..', 'WORKFLOW.md');
const READ_TOOLS = ['brain_list', 'brain_read', 'brain_search', 'brain_vitals'];
const WRITE_TOOLS = ['brain_append', 'brain_write'];
const env = { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' };

function vault(): string {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'Repos'), { recursive: true });
  return dir;
}

describe('role switch: tools handed to the worker session', () => {
  async function sessionFor(roleBrain: string | undefined, brain: Record<string, unknown> | undefined) {
    const dir = vault();
    const rootDir = tempDir();
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const role = { states: ['Todo', 'In Progress'], ...(roleBrain === undefined ? {} : { brain: roleBrain }) };
    const workflow = new StaticWorkflow(makeWorkflow(baseFront(rootDir, { roles: { dev: role }, ...(brain === undefined ? {} : { brain: { path: dir, ...brain } }) })));
    const orchestrator = new Orchestrator({
      workflow,
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: null,
      clock: new ManualClock(),
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker([makeIssue({ id: 'a' })]),
    });
    await orchestrator.tickNow();
    await until(() => runner.sessions.length === 1, 3_000, 'one session');
    return { params: runner.sessions[0]!.params, dir, rootDir };
  }
  const names = (tools: Array<{ name: string }> | undefined) => (tools ?? []).map((t) => t.name).sort();

  it('brain: off gives no brain tools', async () => {
    assert.deepEqual(names((await sessionFor('off', { enabled: true })).params.brainTools), []);
  });

  it('a role without the field defaults to off', async () => {
    assert.deepEqual(names((await sessionFor(undefined, { enabled: true })).params.brainTools), []);
  });

  it('brain: read gives exactly brain_search, brain_read, brain_list', async () => {
    assert.deepEqual(names((await sessionFor('read', { enabled: true })).params.brainTools), READ_TOOLS);
  });

  it('brain: write gives all five tools', async () => {
    assert.deepEqual(names((await sessionFor('write', { enabled: true })).params.brainTools), [...READ_TOOLS, ...WRITE_TOOLS].sort());
  });

  it('brain.enabled: false (or no brain section) overrides every role mode', async () => {
    for (const mode of ['read', 'write']) {
      assert.deepEqual(names((await sessionFor(mode, { enabled: false })).params.brainTools), []);
      assert.deepEqual(names((await sessionFor(mode, undefined)).params.brainTools), []);
    }
  });

  it('the session working directory is not the vault and not inside or above it', async () => {
    const { params, dir } = await sessionFor('write', { enabled: true });
    const cwd = path.resolve(params.cwd);
    const vaultDir = path.resolve(dir);
    assert.ok(cwd !== vaultDir && !cwd.startsWith(vaultDir + path.sep) && !vaultDir.startsWith(cwd + path.sep), cwd);
    const mounted = (params.extensions?.additionalDirectories ?? []).map((d) => path.resolve(d));
    for (const extra of mounted) assert.ok(extra !== vaultDir && !extra.startsWith(vaultDir + path.sep), extra);
  });
});

describe('role switch: Claude session options', () => {
  function fakeQuery() {
    let captured: Options | undefined;
    const fn: QueryFn = ({ prompt, options }) => {
      captured = options;
      const out = new AsyncQueue<SDKMessage>();
      void (async () => {
        for await (const message of prompt as AsyncIterable<SDKUserMessage>) void message;
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

  async function optionsFor(mode: 'off' | 'read' | 'write', vaultDir: string, additional: string[] = ['/ws/laravel']): Promise<Options> {
    const config = resolveConfig({ claude: { model: 'opus' } }, { workflowPath: '/w/WORKFLOW.md', env: {}, trackerDefaults }).claude;
    const issue = makeIssue({ id: 'a' });
    const fake = fakeQuery();
    const session = await new ClaudeAgentRunner({ query: fake.fn }).startSession({
      cwd: '/tmp/ws/issue-1',
      issue,
      config,
      tools: [],
      toolContext: () => ({ issue }),
      env: { PATH: '/usr/bin' },
      logger: Logger.silent(),
      signal: new AbortController().signal,
      onEvent: () => undefined,
      transcriptPath: null,
      extensions: { mcpServers: {}, contextSections: [], additionalDirectories: additional, env: {} },
      brainTools: brainToolsFor({ enabled: true, path: vaultDir }, mode, Logger.silent()),
    });
    await session.stop();
    return fake.options();
  }

  const brainAllowed = (options: Options) => (options.allowedTools ?? []).filter((n) => n.startsWith('mcp__brain__')).sort();

  it('off registers no brain server and allows no mcp__brain__ tool', async () => {
    const options = await optionsFor('off', vault());
    assert.equal(options.mcpServers?.brain, undefined);
    assert.deepEqual(brainAllowed(options), []);
  });

  it('read registers the server with the three read tools only', async () => {
    const options = await optionsFor('read', vault());
    assert.ok(options.mcpServers?.brain !== undefined);
    assert.deepEqual(brainAllowed(options), READ_TOOLS.map((n) => `mcp__brain__${n}`));
  });

  it('write registers the server with all five tools', async () => {
    const options = await optionsFor('write', vault());
    assert.ok(options.mcpServers?.brain !== undefined);
    assert.deepEqual(brainAllowed(options), [...READ_TOOLS, ...WRITE_TOOLS].sort().map((n) => `mcp__brain__${n}`));
  });

  it('the vault path is in no session option as a directory (additionalDirectories, cwd), in any mode', async () => {
    for (const mode of ['off', 'read', 'write'] as const) {
      const dir = vault();
      const options = await optionsFor(mode, dir);
      assert.ok(!(options.additionalDirectories ?? []).some((d) => path.resolve(d) === path.resolve(dir) || path.resolve(d).startsWith(path.resolve(dir) + path.sep)), mode);
      assert.notEqual(options.cwd, dir);
      const dirs = JSON.stringify([options.additionalDirectories ?? [], options.cwd]);
      assert.ok(!dirs.includes(dir), mode);
    }
  });
});

describe('role switch: configuration', () => {
  const front = (extra: Record<string, unknown>) => ({
    tracker: { kind: 'github', active_states: ['In progress'] },
    ...extra,
  });
  const resolve = (extra: Record<string, unknown>) => resolveConfig(front(extra), { workflowPath: '/w/WORKFLOW.md', env, trackerDefaults });
  const role = (brain: unknown) => ({ roles: { reviewer: { states: ['In progress'], ...(brain === undefined ? {} : { brain }) } } });

  it('accepts off, read and write; default is off', () => {
    const mode = (brain?: unknown) => resolve(role(brain)).roles?.find((r) => r.name === 'reviewer')?.brain;
    assert.equal(mode(), 'off');
    for (const value of ['off', 'read', 'write']) assert.equal(mode(value), value);
  });

  it('rejects an invalid value with an error naming the field', () => {
    for (const bad of ['rw', 'WRITE', true, 1, '']) assert.throws(() => resolve(role(bad)), /roles\.reviewer\.brain/);
  });

  it('rejects a vault under, equal to or above workspace.root when enabled', () => {
    const root = path.join(os.tmpdir(), 'sym-ws-root');
    for (const vaultPath of [root, path.join(root, 'brain'), path.dirname(root)]) {
      assert.throws(() => resolve({ workspace: { root }, brain: { enabled: true, path: vaultPath } }), /workspace\.root/, vaultPath);
    }
    assert.doesNotThrow(() => resolve({ workspace: { root }, brain: { enabled: true, path: path.join(os.tmpdir(), 'sym-vault-elsewhere') } }));
  });

  it('a sibling directory with a common name prefix is not an overlap', () => {
    const root = path.join(os.tmpdir(), 'sym-ws');
    assert.doesNotThrow(() => resolve({ workspace: { root }, brain: { enabled: true, path: `${root}-brain` } }));
  });
});

describe('role switch: shipped WORKFLOW.md and prompt section', () => {
  async function config() {
    const { definition } = await loadWorkflowFile(shipped);
    return resolveConfig(definition.config, { workflowPath: shipped, env, trackerDefaults });
  }

  async function render(role: string, scope: Record<string, unknown>): Promise<string> {
    const { definition } = await loadWorkflowFile(shipped);
    const template = compilePrompt(definition.promptTemplate, definition.partials);
    assert.equal(template.parseError, null);
    const issue = makeIssue({
      id: 'PVTI_1',
      identifier: 'acme/app#42',
      title: 'Add invoices',
      state: 'In progress',
      native_ref: { provider: 'github_project', repository: 'acme/app', number: 42, parent: null, sub_issues: [], base_branch: null },
    });
    return renderPrompt(template, { issue: issueTemplateValue(issue, commandSkills([])), attempt: null, role, agents: [], ...scope });
  }

  it('sets the shipped defaults per role', async () => {
    const cfg = await config();
    const mode = (name: string) => cfg.roles?.find((r) => r.name === name)?.brain;
    for (const name of ['issue-analyst', 'architect', 'reviewer']) assert.equal(mode(name), 'write', name);
    for (const name of ['developer', 'test-engineer', 'security-auditor']) assert.equal(mode(name), 'read', name);
    assert.equal(mode('docs'), 'off');
  });

  it('shows no brain section when the mode is off or unset, for every shipped role', async () => {
    const cfg = await config();
    for (const r of cfg.roles ?? []) {
      for (const scope of [{}, { brain: 'off', brain_index: 'Repos/acme-app/index.md' }]) {
        const text = await render(r.name, scope);
        assert.ok(!/Knowledge vault|brain_search|mcp__brain__|base_hash/.test(text), r.name);
      }
    }
  });

  it('shows the section for read and write in every shipped role that has brain', async () => {
    const cfg = await config();
    const index = 'Repos/acme-app/index.md';
    for (const r of (cfg.roles ?? []).filter((x) => x.brain !== 'off')) {
      const text = await render(r.name, { brain: r.brain, brain_index: index });
      for (const part of [index, 'brain_search', 'brain_read', 'brain_list', 'purpose', 'candidate']) assert.ok(text.includes(part), `${r.name}: ${part}`);
      assert.equal(text.includes('base_hash'), r.brain === 'write', r.name);
      assert.equal(text.includes('brain_write'), r.brain === 'write', r.name);
      assert.equal(text.includes('brain_append'), r.brain === 'write', r.name);
    }
  });

  it('tells the agent to read the repository index first, search the topic and tag every call with a purpose', async () => {
    const text = await render('developer', { brain: 'read', brain_index: 'Repos/acme-app/index.md' });
    assert.match(text, /start[\s\S]{0,200}Repos\/acme-app\/index\.md/);
    assert.match(text, /brain_search/);
    assert.match(text, /[Ee]very brain call carries a `purpose`/);
    assert.match(text, /candidate/);
  });

  it('write roles get the lesson criteria and the base_hash instruction; read roles do not', async () => {
    const write = await render('reviewer', { brain: 'write', brain_index: 'Repos/acme-app/index.md' });
    assert.match(write, /lesson/i);
    assert.match(write, /repeatable/);
    assert.match(write, /base_hash/);
    const read = await render('developer', { brain: 'read', brain_index: 'Repos/acme-app/index.md' });
    assert.ok(!/base_hash/.test(read));
    assert.ok(!/brain_write|brain_append/.test(read));
  });

  it('works without a repository index path (falls back to brain_list)', async () => {
    const text = await render('developer', { brain: 'read', brain_index: null });
    assert.ok(text.includes('brain_list'));
    assert.ok(!text.includes('null'));
  });

  it('the section is English', async () => {
    const partial = fs.readFileSync(path.join(import.meta.dirname, '..', 'roles', 'brain.md'), 'utf8');
    assert.ok(!/[äöüß]/i.test(partial));
    assert.ok(!/\b(und|nicht|oder|Wissen)\b/.test(partial));
  });

  it('the vault is never reachable by file tools: the section says tools only', async () => {
    const text = await render('reviewer', { brain: 'write', brain_index: 'Repos/acme-app/index.md' });
    assert.match(text, /never with file tools or the shell/);
  });
});

describe('role switch: docs', () => {
  const docs = fs.readFileSync(path.join(import.meta.dirname, '..', 'docs', 'configuration.md'), 'utf8');

  it('docs/configuration.md describes the role field brain under roles', () => {
    const roles = docs.slice(docs.indexOf('\n## `roles`') >= 0 ? docs.indexOf('\n## `roles`') : docs.search(/\n#+ .*roles/i));
    const row = roles.split('\n').find((line) => /^\|\s*`brain`/.test(line));
    assert.ok(row, 'table row for brain');
    for (const word of ['off', 'read', 'write', 'brain_search', 'brain_write', 'brain_append']) assert.ok(row!.includes(word), word);
  });
});
