import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Logger } from '../src/log.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { SymphonyError } from '../src/util/errors.ts';
import { loadEnvFile } from '../src/util/env.ts';
import { DEFAULTS, resolveConfig } from '../src/workflow/config.ts';
import { loadWorkflowFile, parseWorkflow } from '../src/workflow/loader.ts';
import { WorkflowStore } from '../src/workflow/store.ts';
import { compilePrompt, renderPrompt } from '../src/workflow/template.ts';
import { makeIssue, tempDir } from './helpers.ts';
import { issueTemplateValue } from '../src/workflow/template.ts';

const resolve = (front: Record<string, unknown>, env: NodeJS.ProcessEnv = {}, dir = '/srv/flows') =>
  resolveConfig(front, { workflowPath: path.join(dir, 'WORKFLOW.md'), env, trackerDefaults });

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof SymphonyError ? error.code : 'other';
  }
  return undefined;
}

describe('workflow loader', () => {
  it('splits YAML front matter from the trimmed prompt body', () => {
    const def = parseWorkflow('---\npolling:\n  interval_ms: 5000\n---\n\n  Do {{ issue.title }}  \n\n');
    assert.deepEqual(def.config, { polling: { interval_ms: 5000 } });
    assert.equal(def.promptTemplate, 'Do {{ issue.title }}');
  });

  it('treats a file without front matter as prompt only', () => {
    const def = parseWorkflow('Just a prompt\n');
    assert.deepEqual(def.config, {});
    assert.equal(def.promptTemplate, 'Just a prompt');
  });

  it('handles CRLF line endings and a BOM', () => {
    const def = parseWorkflow('﻿---\r\nagent:\r\n  max_turns: 3\r\n---\r\nBody\r\n');
    assert.deepEqual(def.config, { agent: { max_turns: 3 } });
    assert.equal(def.promptTemplate, 'Body');
  });

  it('rejects front matter that is not a map', () => {
    assert.equal(codeOf(() => parseWorkflow('---\n- a\n- b\n---\nx')), 'workflow_front_matter_not_a_map');
  });

  it('rejects invalid YAML and an unclosed front matter block', () => {
    assert.equal(codeOf(() => parseWorkflow('---\nfoo: [unclosed\n---\nx')), 'workflow_parse_error');
    assert.equal(codeOf(() => parseWorkflow('---\nfoo: 1\nno closing line')), 'workflow_parse_error');
  });

  it('reports a missing file with a typed error', async () => {
    await assert.rejects(loadWorkflowFile('/nonexistent/WORKFLOW.md'), (error: unknown) => {
      return error instanceof SymphonyError && error.code === 'missing_workflow_file';
    });
  });
});

describe('config layer', () => {
  it('applies defaults for omitted settings', () => {
    const config = resolve({ tracker: { kind: 'github_project' } });
    assert.equal(config.polling.intervalMs, 30_000);
    assert.equal(config.hooks.timeoutMs, 60_000);
    assert.equal(config.agent.maxConcurrentAgents, 10);
    assert.equal(config.agent.maxTurns, 20);
    assert.equal(config.agent.maxRetryBackoffMs, 300_000);
    assert.equal(config.claude.turnTimeoutMs, 3_600_000);
    assert.equal(config.claude.stallTimeoutMs, 300_000);
    assert.equal(config.claude.permissionMode, 'auto');
    assert.deepEqual(config.claude.settingSources, ['project']);
    assert.equal(config.workspace.root, path.join(os.tmpdir(), DEFAULTS.workspaceRootName));
    assert.equal(config.server.port, null);
  });

  it('uses the adapter-documented state defaults', () => {
    const config = resolve({ tracker: { kind: 'github_project' } });
    assert.deepEqual(config.tracker.activeStates, ['Todo', 'In Progress']);
    assert.deepEqual(config.tracker.terminalStates, ['Done']);
  });

  it('resolves whole-value $VAR references, treating unset variables as omitted', () => {
    const config = resolve(
      { claude: { model: '$CLAUDE_MODEL', fallback_model: '${UNSET_MODEL}' }, server: { port: '$SYMPHONY_PORT' } },
      { CLAUDE_MODEL: 'opus', SYMPHONY_PORT: '4000' },
    );
    assert.equal(config.claude.model, 'opus');
    assert.equal(config.claude.fallbackModel, null);
    assert.equal(config.server.port, 4000);
  });

  it('supports ${NAME:-default} references, and an empty default means omitted', () => {
    const front = {
      agent: { max_turns: '${SYMPHONY_MAX_TURNS:-7}', max_continuations: '${SYMPHONY_MAX_CONTINUATIONS:-}' },
      workspace: { cleanup_terminal: '${SYMPHONY_CLEANUP_TERMINAL:-true}' },
      polling: { interval_ms: '${SYMPHONY_POLL_INTERVAL_MS:-30000}' },
    };
    const defaults = resolve(front);
    assert.equal(defaults.agent.maxTurns, 7);
    assert.equal(defaults.agent.maxContinuations, null);
    assert.equal(defaults.workspace.cleanupTerminal, true);
    const set = resolve(front, { SYMPHONY_MAX_TURNS: '5', SYMPHONY_MAX_CONTINUATIONS: '2', SYMPHONY_CLEANUP_TERMINAL: 'false', SYMPHONY_POLL_INTERVAL_MS: '' });
    assert.equal(set.agent.maxTurns, 5);
    assert.equal(set.agent.maxContinuations, 2);
    assert.equal(set.workspace.cleanupTerminal, false);
    assert.equal(set.polling.intervalMs, 30_000);
  });

  it('parses ${NAME:-default} written as plain YAML', () => {
    const def = parseWorkflow('---\nagent:\n  max_turns: ${SYMPHONY_MAX_TURNS:-5}   # comment\n  max_continuations: ${X:-}\n---\nHi');
    assert.deepEqual(def.config, { agent: { max_turns: '${SYMPHONY_MAX_TURNS:-5}', max_continuations: '${X:-}' } });
  });

  it('leaves hook scripts and tracker.provider untouched', () => {
    const config = resolve(
      { tracker: { kind: 'github_project', provider: { token: '$GITHUB_TOKEN' } }, hooks: { before_run: '$SETUP' } },
      { GITHUB_TOKEN: 'secret', SETUP: 'echo hi' },
    );
    assert.equal(config.tracker.provider.token, '$GITHUB_TOKEN');
    assert.equal(config.hooks.beforeRun, '$SETUP');
  });

  it('expands ~ and $VAR in workspace.root and resolves relative paths against the workflow directory', () => {
    assert.equal(resolve({ workspace: { root: '~/ws' } }, { HOME: '/home/me' }).workspace.root, '/home/me/ws');
    assert.equal(resolve({ workspace: { root: '$BASE/ws' } }, { BASE: '/data' }).workspace.root, '/data/ws');
    assert.equal(resolve({ workspace: { root: 'ws' } }).workspace.root, '/srv/flows/ws');
  });

  it('normalizes per-state limits and ignores invalid entries', () => {
    const config = resolve({ agent: { max_concurrent_agents_by_state: { ' In Progress ': 2, Todo: 0, Review: 'x' } } });
    assert.deepEqual([...config.agent.maxConcurrentAgentsByState], [['in progress', 2]]);
    assert.equal(config.warnings.filter((w) => w.includes('max_concurrent_agents_by_state')).length, 2);
  });

  it('lists every invalid value in one invalid_config error', () => {
    assert.throws(
      () => resolve({ agent: { max_turns: 0 }, hooks: { timeout_ms: -5 }, claude: { permission_mode: 'yolo' } }),
      (error: unknown) =>
        error instanceof SymphonyError &&
        error.code === 'invalid_config' &&
        error.message.includes('agent.max_turns') &&
        error.message.includes('hooks.timeout_ms') &&
        error.message.includes('claude.permission_mode'),
    );
  });

  it('warns about the codex section and unknown keys', () => {
    const config = resolve({ codex: { command: 'codex app-server' }, extension_x: {} });
    assert.equal(config.warnings.length, 2);
  });
});

describe('prompt templates', () => {
  const issue = issueTemplateValue(makeIssue({ id: '7', labels: ['bug'] }));

  it('renders issue fields and attempt', async () => {
    const template = compilePrompt('{{ issue.identifier }} {{ issue.labels | join: "," }}{% if attempt %} retry {{ attempt }}{% endif %}');
    assert.equal(await renderPrompt(template, { issue, attempt: null }), 'acme/app#7 bug');
    assert.equal(await renderPrompt(template, { issue, attempt: 2 }), 'acme/app#7 bug retry 2');
  });

  it('fails on unknown variables and unknown filters', async () => {
    await assert.rejects(renderPrompt(compilePrompt('{{ issue.nope }}'), { issue, attempt: null }), { code: 'template_render_error' });
    await assert.rejects(renderPrompt(compilePrompt('{{ missing }}'), { issue, attempt: null }), { code: 'template_render_error' });
    const unknownFilter = compilePrompt('{{ issue.title | shout }}');
    const code = unknownFilter.parsed === null ? 'template_parse_error' : 'template_render_error';
    await assert.rejects(renderPrompt(unknownFilter, { issue, attempt: null }), { code });
  });

  it('drops "Model: …" labels with the without_model_labels filter', async () => {
    const template = compilePrompt('{{ issue.labels | without_model_labels | join: "," }}');
    const labeled = issueTemplateValue(makeIssue({ id: '8', labels: ['bug', 'model: opus', 'ui'] }));
    assert.equal(await renderPrompt(template, { issue: labeled, attempt: null }), 'bug,ui');
  });

  it('keeps model labels out of the shipped WORKFLOW.md prompt', async () => {
    const { definition } = await loadWorkflowFile(path.resolve(import.meta.dirname, '../WORKFLOW.md'));
    const template = compilePrompt(definition.promptTemplate);
    const render = (labels: string[]) =>
      renderPrompt(template, {
        issue: issueTemplateValue(makeIssue({ id: '12', labels, native_ref: { number: 12, parent: null, sub_issues: [] } })),
        attempt: null,
      });
    const mixed = await render(['bug', 'model: sonnet']);
    assert.match(mixed, /^- Labels: bug$/m);
    assert.doesNotMatch(mixed, /model: sonnet/);
    assert.doesNotMatch(await render(['model: opus']), /Labels:/);
  });

  it('reports parse errors when rendering', async () => {
    const broken = compilePrompt('{% if issue.title %}unclosed');
    assert.notEqual(broken.parseError, null);
    await assert.rejects(renderPrompt(broken, { issue, attempt: null }), { code: 'template_parse_error' });
  });
});

describe('env file', () => {
  it('fills in unset variables and keeps values already set in the environment', () => {
    const dir = tempDir();
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'GITHUB_REPOSITORY=acme/app\nCLAUDE_MODEL=opus\n# comment\nGITHUB_TOKEN="from-file"\n');
    const loaded = loadEnvFile(file, { GITHUB_TOKEN: 'from-shell' });
    assert.equal(loaded.env.GITHUB_REPOSITORY, 'acme/app');
    assert.equal(loaded.env.CLAUDE_MODEL, 'opus');
    assert.equal(loaded.env.GITHUB_TOKEN, 'from-shell');
    assert.deepEqual(loaded.shadowed, ['GITHUB_TOKEN']);
  });
});

describe('workflow store', () => {
  it('reloads changes and keeps the last good version when a reload is invalid', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'WORKFLOW.md');
    fs.writeFileSync(file, '---\npolling:\n  interval_ms: 1000\n---\nPrompt A');
    const store = await WorkflowStore.open(file, { env: {}, logger: Logger.silent() });
    assert.equal(store.current.config.polling.intervalMs, 1000);

    fs.writeFileSync(file, '---\npolling:\n  interval_ms: 2000\n---\nPrompt B');
    await store.refreshIfChanged();
    assert.equal(store.current.config.polling.intervalMs, 2000);
    assert.equal(store.current.version, 2);
    assert.equal(store.current.prompt.source, 'Prompt B');

    fs.writeFileSync(file, '---\npolling: [broken\n---\nPrompt C');
    await store.refreshIfChanged();
    assert.equal(store.current.config.polling.intervalMs, 2000);
    assert.equal(store.lastError?.code, 'workflow_parse_error');

    fs.writeFileSync(file, '---\npolling:\n  interval_ms: 3000\n---\nPrompt D');
    await store.refreshIfChanged();
    assert.equal(store.lastError, null);
    assert.equal(store.current.config.polling.intervalMs, 3000);
    store.close();
  });

  it('uses the default prompt for an empty body', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'WORKFLOW.md');
    fs.writeFileSync(file, '---\nagent:\n  max_turns: 2\n---\n');
    const store = await WorkflowStore.open(file, { env: {}, logger: Logger.silent() });
    assert.match(store.current.prompt.source, /You are working on an issue/);
    store.close();
  });
});
