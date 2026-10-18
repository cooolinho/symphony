import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Logger } from '../src/log.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { SymphonyError } from '../src/util/errors.ts';
import { loadEnvFile } from '../src/util/env.ts';
import type { LaravelConfig } from '../src/laravel/integration.ts';
import { DEFAULTS, resolveConfig, type ServiceConfig } from '../src/workflow/config.ts';
import { roleFor, sessionAgents, type RoleConfig } from '../src/workflow/roles.ts';
import { pluginAgents } from '../src/workflow/command.ts';
import { loadWorkflowFile, parseWorkflow } from '../src/workflow/loader.ts';
import { type EffectiveWorkflow, WorkflowStore } from '../src/workflow/store.ts';
import { nextActiveColumn, nextStageProblems, unknownBoardColumns, validateDispatch } from '../src/workflow/validate.ts';
import { compilePrompt, renderPrompt } from '../src/workflow/template.ts';
import { makeIssue, tempDir } from './helpers.ts';
import { issueTemplateValue } from '../src/workflow/template.ts';

const resolve = (front: Record<string, unknown>, env: NodeJS.ProcessEnv = {}, dir = '/srv/flows') =>
  resolveConfig(front, { workflowPath: path.join(dir, 'WORKFLOW.md'), env, trackerDefaults });

const laravelOf = (config: ServiceConfig) => config.integrations.laravel as LaravelConfig;

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
    assert.equal(config.server.host, '127.0.0.1');
    assert.equal(config.server.allowRemoteControl, false);
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
      agent: { max_turns: '${SYMPHONY_MAX_TURNS:-7}', max_continuations: '${SYMPHONY_MAX_CONTINUATIONS:-}', max_session_limit_retries: '${SYMPHONY_MAX_SESSION_LIMIT_RETRIES:-3}' },
      workspace: { cleanup_terminal: '${SYMPHONY_CLEANUP_TERMINAL:-true}' },
      polling: { interval_ms: '${SYMPHONY_POLL_INTERVAL_MS:-30000}' },
    };
    const defaults = resolve(front);
    assert.equal(defaults.agent.maxTurns, 7);
    assert.equal(defaults.agent.maxContinuations, null);
    assert.equal(defaults.agent.maxSessionLimitRetries, 3);
    assert.equal(resolve(front, { SYMPHONY_MAX_SESSION_LIMIT_RETRIES: '' }).agent.maxSessionLimitRetries, 3);
    assert.equal(resolve(front, { SYMPHONY_MAX_SESSION_LIMIT_RETRIES: '0' }).agent.maxSessionLimitRetries, 0);
    assert.equal(defaults.workspace.cleanupTerminal, true);
    const set = resolve(front, { SYMPHONY_MAX_TURNS: '5', SYMPHONY_MAX_CONTINUATIONS: '2', SYMPHONY_CLEANUP_TERMINAL: 'false', SYMPHONY_POLL_INTERVAL_MS: '' });
    assert.equal(set.agent.maxTurns, 5);
    assert.equal(set.agent.maxContinuations, 2);
    assert.equal(resolve(front, { SYMPHONY_MAX_SESSION_LIMIT_RETRIES: '5' }).agent.maxSessionLimitRetries, 5);
    assert.equal(set.workspace.cleanupTerminal, false);
    assert.equal(set.polling.intervalMs, 30_000);
  });

  it('reads the server bind address and remote control from the environment', () => {
    const front = { server: { host: '${SYMPHONY_HOST:-127.0.0.1}', allow_remote_control: '${SYMPHONY_ALLOW_REMOTE_CONTROL:-false}' } };
    const defaults = resolve(front);
    assert.equal(defaults.server.host, '127.0.0.1');
    assert.equal(defaults.server.allowRemoteControl, false);
    const set = resolve(front, { SYMPHONY_HOST: '0.0.0.0', SYMPHONY_ALLOW_REMOTE_CONTROL: 'true' });
    assert.equal(set.server.host, '0.0.0.0');
    assert.equal(set.server.allowRemoteControl, true);
    assert.throws(() => resolve(front, { SYMPHONY_ALLOW_REMOTE_CONTROL: 'yes' }), /server\.allow_remote_control must be true or false/);
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

  it('defaults agent.max_session_limit_retries to 3 and rejects negative or non-integer values', () => {
    assert.equal(resolve({}).agent.maxSessionLimitRetries, 3);
    for (const value of [-1, 'abc']) {
      assert.throws(
        () => resolve({ agent: { max_session_limit_retries: value } }),
        (error: unknown) =>
          error instanceof SymphonyError && error.code === 'invalid_config' && error.message.includes('agent.max_session_limit_retries'),
      );
    }
  });

  it('leaves agent.max_issue_cost_usd unlimited by default and rejects values that are not positive', () => {
    assert.equal(resolve({}).agent.maxIssueCostUsd, null);
    assert.equal(resolve({ agent: { max_issue_cost_usd: 12.5 } }).agent.maxIssueCostUsd, 12.5);
    for (const value of [0, -1, 'abc']) {
      assert.throws(
        () => resolve({ agent: { max_issue_cost_usd: value } }),
        (error: unknown) => error instanceof SymphonyError && error.code === 'invalid_config' && error.message.includes('agent.max_issue_cost_usd'),
      );
    }
  });

  it('defaults agent.model_hold_ms to one hour and rejects values below 1', () => {
    assert.equal(resolve({}).agent.modelHoldMs, 3_600_000);
    assert.equal(resolve({ agent: { model_hold_ms: 600_000 } }).agent.modelHoldMs, 600_000);
    for (const value of [0, -1, 'abc']) {
      assert.throws(
        () => resolve({ agent: { model_hold_ms: value } }),
        (error: unknown) => error instanceof SymphonyError && error.code === 'invalid_config' && error.message.includes('agent.model_hold_ms'),
      );
    }
  });

  it('parses checks with defaults, normalized columns and literal $VAR scripts', () => {
    assert.deepEqual(resolve({ hooks: { timeout_ms: 90_000 } }).checks, { timeoutMs: 90_000, retries: 0, onEnter: new Map() });
    const config = resolve(
      { checks: { timeout_ms: 5000, retries: 2, on_enter: { ' Agent Review ': 'bash "$SYMPHONY_WORKFLOW_DIR/c.sh"' } } },
      { SYMPHONY_WORKFLOW_DIR: 'x' },
    );
    assert.equal(config.checks.timeoutMs, 5000);
    assert.equal(config.checks.retries, 2);
    assert.deepEqual([...config.checks.onEnter], [['agent review', 'bash "$SYMPHONY_WORKFLOW_DIR/c.sh"']]);
    assert.equal(resolve({ checks: { on_enter: { Done: '$SETUP' } } }, { SETUP: 'x' }).checks.onEnter.get('done'), '$SETUP');
  });

  it('takes checks.timeout_ms from an environment reference', () => {
    const front = { checks: { timeout_ms: '${CHECKS_TIMEOUT:-1800000}' } };
    assert.equal(resolve(front, {}).checks.timeoutMs, 1_800_000);
    assert.equal(resolve(front, { CHECKS_TIMEOUT: '2400000' }).checks.timeoutMs, 2_400_000);
  });

  it('rejects invalid checks values', () => {
    const message = (front: Record<string, unknown>) => {
      try {
        resolve(front);
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    };
    assert.match(message({ checks: { retries: 4 } }), /checks\.retries/);
    assert.match(message({ checks: { retries: -1 } }), /checks\.retries/);
    assert.match(message({ checks: { on_enter: { Review: 5 } } }), /checks\.on_enter\.Review must be a string/);
    assert.match(message({ checks: { timeout_ms: 3_600_000 } }), /checks\.timeout_ms/);
    assert.match(message({ claude: { turn_timeout_ms: 1000 }, checks: { timeout_ms: 1000 } }), /checks\.timeout_ms/);
  });

  it('warns about the codex section and unknown keys', () => {
    const config = resolve({ codex: { command: 'codex app-server' }, extension_x: {} });
    assert.equal(config.warnings.length, 2);
  });

  it('defaults the laravel section to Boost on auto with host php and composer', () => {
    const config = resolve({ hooks: { timeout_ms: 90_000 } });
    assert.deepEqual(laravelOf(config), {
      boost: 'auto',
      php: 'php',
      composer: 'composer',
      installDependencies: true,
      timeoutMs: 90_000,
      env: { APP_ENV: 'local' },
      agentEnv: {},
      allowTinker: false,
      denyTools: ['record-rule'],
    });
    assert.deepEqual(config.claude.plugins, []);
    assert.equal(config.claude.skills, null);
    assert.deepEqual(config.warnings, []);
  });

  it('keeps bare laravel commands as PATH lookups and resolves path-like ones', () => {
    const config = resolve(
      {
        laravel: {
          boost: 'off',
          php: './bin/php-in-docker',
          composer: '${SYMPHONY_COMPOSER:-composer2}',
          install_dependencies: false,
          timeout_ms: 5000,
          env: { DB_CONNECTION: 'sqlite', APP_DEBUG: true },
        },
      },
      { HOME: '/home/me' },
    );
    assert.equal(laravelOf(config).boost, 'off');
    assert.equal(laravelOf(config).php, '/srv/flows/bin/php-in-docker');
    assert.equal(laravelOf(config).composer, 'composer2');
    assert.equal(laravelOf(config).installDependencies, false);
    assert.equal(laravelOf(config).timeoutMs, 5000);
    assert.deepEqual(laravelOf(config).env, { APP_ENV: 'local', DB_CONNECTION: 'sqlite', APP_DEBUG: 'true' });
    assert.equal(laravelOf(resolve({ laravel: { php: '~/bin/php' } }, { HOME: '/home/me' })).php, '/home/me/bin/php');
    assert.equal(laravelOf(resolve({ laravel: { env: { APP_ENV: 'testing' } } })).env.APP_ENV, 'testing');
  });

  it('reads the Laravel Boost agent env and tool settings', () => {
    const defaults = laravelOf(resolve({}));
    assert.deepEqual(defaults.agentEnv, {});
    assert.equal(defaults.allowTinker, false);
    assert.deepEqual(defaults.denyTools, ['record-rule']);
    const config = laravelOf(resolve({ laravel: { agent_env: { FOO: 'bar', N: 1 }, allow_tinker: true, deny_tools: ['search-docs', ' record-rule ', ''] } }));
    assert.deepEqual(config.agentEnv, { FOO: 'bar', N: '1' });
    assert.equal(config.allowTinker, true);
    assert.deepEqual(config.denyTools, ['search-docs', 'record-rule']);
    assert.deepEqual(laravelOf(resolve({ laravel: { deny_tools: [] } })).denyTools, []);
  });

  it('resolves claude.plugins against the workflow directory and parses claude.skills', () => {
    const config = resolve({ claude: { plugins: ['./.claude', '/opt/plugins/x', ''], skills: 'all' } });
    assert.deepEqual(config.claude.plugins, ['/srv/flows/.claude', '/opt/plugins/x']);
    assert.equal(config.claude.skills, 'all');
    assert.deepEqual(resolve({ claude: { skills: ['pest-testing'] } }).claude.skills, ['pest-testing']);
  });

  it('parses claude.by_model, normalizing model names, and defaults to no overrides', () => {
    assert.equal(resolve({ claude: {} }).claude.byModel.size, 0);
    const { byModel } = resolve({
      claude: {
        by_model: {
          Haiku: { permission_mode: 'acceptEdits', allowed_tools: ['Bash', 'Write'], disallowed_tools: ['WebFetch'], on_permission_request: 'approve' },
          'claude-sonnet-5-5': {},
        },
      },
    }).claude;
    assert.deepEqual([...byModel.keys()], ['haiku', 'sonnet-5-5']);
    assert.deepEqual(byModel.get('haiku'), {
      permissionMode: 'acceptEdits',
      onPermissionRequest: 'approve',
      allowedTools: ['Bash', 'Write'],
      disallowedTools: ['WebFetch'],
    });
    assert.deepEqual(byModel.get('sonnet-5-5'), {});
  });

  it('rejects invalid claude.by_model entries', () => {
    const message = (byModel: unknown): string => {
      try {
        resolve({ claude: { by_model: byModel } });
      } catch (error) {
        return error instanceof SymphonyError && error.code === 'invalid_config' ? error.message : String(error);
      }
      return '';
    };
    assert.match(message(['haiku']), /claude\.by_model must be a map/);
    assert.match(message({ hiku: {} }), /claude\.by_model\.hiku: "hiku" is not a model name/);
    assert.match(message({ haiku: 'acceptEdits' }), /claude\.by_model\.haiku must be a map/);
    assert.match(message({ haiku: { permissionMode: 'acceptEdits' } }), /claude\.by_model\.haiku\.permissionMode is not a known key/);
    assert.match(message({ haiku: { permission_mode: 'yolo' } }), /claude\.by_model\.haiku\.permission_mode must be one of/);
    assert.match(message({ haiku: { allowed_tools: 'Bash' } }), /claude\.by_model\.haiku\.allowed_tools must be a list of strings/);
    assert.match(message({ haiku: {}, 'claude-haiku': {} }), /claude\.by_model\.claude-haiku names the same model/);
  });

  it('rejects invalid laravel and skills values', () => {
    assert.throws(
      () =>
        resolve({
          laravel: { boost: 'always', env: ['x'], agent_env: 'x', allow_tinker: 'yes', deny_tools: 'tinker' },
          claude: { skills: 'some' },
        }),
      (error: unknown) =>
        error instanceof SymphonyError &&
        error.code === 'invalid_config' &&
        error.message.includes('laravel.boost') &&
        error.message.includes('laravel.env') &&
        error.message.includes('laravel.agent_env') &&
        error.message.includes('laravel.allow_tinker') &&
        error.message.includes('laravel.deny_tools') &&
        error.message.includes('claude.skills'),
    );
  });

  it('blocks dispatch when a claude.plugins entry is not a directory', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, '.claude'));
    const workflow = (plugins: string[]) =>
      ({ config: resolve({ tracker: { kind: 'github_project' }, claude: { plugins } }, {}, dir) }) as unknown as EffectiveWorkflow;
    const pluginErrors = (plugins: string[]) =>
      validateDispatch(workflow(plugins), null, {}).filter((error) => error.includes('claude.plugins'));
    assert.deepEqual(pluginErrors(['./.claude']), []);
    assert.deepEqual(pluginErrors(['./missing']), [`claude.plugins entry ${path.join(dir, 'missing')} is not a directory`]);
  });
});

describe('prompt templates', () => {
  const issue = issueTemplateValue(makeIssue({ id: '7', labels: ['bug'] }));

  it('renders issue fields and attempt', async () => {
    const template = compilePrompt('{{ issue.identifier }} {{ issue.labels | join: "," }}{% if attempt %} retry {{ attempt }}{% endif %}');
    assert.equal(await renderPrompt(template, { issue, attempt: null }), 'acme/app#7 bug');
    assert.equal(await renderPrompt(template, { issue, attempt: 2 }), 'acme/app#7 bug retry 2');
  });

  it('renders the role of the run', async () => {
    const template = compilePrompt('{% if role == "reviewer" %}Review{% else %}Work{% endif %} as {{ role }}');
    assert.equal(await renderPrompt(template, { issue, attempt: null, role: 'reviewer' }), 'Review as reviewer');
    assert.equal(await renderPrompt(template, { issue, attempt: null, role: 'developer' }), 'Work as developer');
    assert.equal(await renderPrompt(template, { issue, attempt: null, role: 'default' }), 'Work as default');
  });

  it('defines the stage-history variables for callers without a session', async () => {
    const template = compilePrompt('{{ result_required }} {{ round }} {{ results.latest.size }} {{ results.open_findings.size }} {{ results.failed_cases.size }}');
    assert.equal(await renderPrompt(template, { issue, attempt: null }), 'false 1 0 0 0');
    assert.equal(await renderPrompt(template, { issue, attempt: null, result_required: true, round: 3 }), 'true 3 0 0 0');
  });

  it('fails on unknown variables and unknown filters', async () => {
    await assert.rejects(renderPrompt(compilePrompt('{{ issue.nope }}'), { issue, attempt: null }), { code: 'template_render_error' });
    await assert.rejects(renderPrompt(compilePrompt('{{ missing }}'), { issue, attempt: null }), { code: 'template_render_error' });
    const unknownFilter = compilePrompt('{{ issue.title | shout }}');
    const code = unknownFilter.parsed === null ? 'template_parse_error' : 'template_render_error';
    await assert.rejects(renderPrompt(unknownFilter, { issue, attempt: null }), { code });
  });

  it('exposes the command of the description when a skill of that name exists, else null', async () => {
    const template = compilePrompt('{% if issue.command %}{{ issue.command.skill }}|{{ issue.command.name }}|{{ issue.command.args }}{% else %}none{% endif %}');
    const skills = new Map([['refactoring', 'symphony:refactoring']]);
    const render = (description: string | null, known?: ReadonlyMap<string, string>) =>
      renderPrompt(template, { issue: issueTemplateValue(makeIssue({ id: '10', description }), known), attempt: null });
    assert.equal(await render('/refactoring app/Filament\n\nmore', skills), 'symphony:refactoring|refactoring|app/Filament');
    assert.equal(await render('/refactoring', skills), 'symphony:refactoring|refactoring|');
    assert.equal(await render('/refactoring'), 'none');
    assert.equal(await render('/login returns 500', skills), 'none');
    assert.equal(await render(null, skills), 'none');
  });

  it('drops "Model: …" labels with the without_model_labels filter', async () => {
    const template = compilePrompt('{{ issue.labels | without_model_labels | join: "," }}');
    const labeled = issueTemplateValue(makeIssue({ id: '8', labels: ['bug', 'model: opus', 'ui'] }));
    assert.equal(await renderPrompt(template, { issue: labeled, attempt: null }), 'bug,ui');
  });

  it('drops "Model: …" and "Effort: …" labels with the without_agent_labels filter', async () => {
    const template = compilePrompt('{{ issue.labels | without_agent_labels | join: "," }}');
    const labeled = issueTemplateValue(makeIssue({ id: '9', labels: ['bug', 'Effort: high', 'model: opus', 'ui', 'side-effort: x'] }));
    assert.equal(await renderPrompt(template, { issue: labeled, attempt: null }), 'bug,ui,side-effort: x');
  });

  it('keeps model labels out of the shipped WORKFLOW.md prompt', async () => {
    const { definition } = await loadWorkflowFile(path.resolve(import.meta.dirname, '../WORKFLOW.md'));
    const template = compilePrompt(definition.promptTemplate);
    const render = (labels: string[]) =>
      renderPrompt(template, {
        issue: issueTemplateValue(makeIssue({ id: '12', labels, native_ref: { number: 12, parent: null, sub_issues: [], base_branch: null } })),
        attempt: null,
        role: 'default',
      });
    const mixed = await render(['bug', 'model: sonnet']);
    assert.match(mixed, /^- Labels: bug$/m);
    assert.doesNotMatch(mixed, /model: sonnet/);
    assert.doesNotMatch(await render(['model: opus']), /Labels:/);
    const withEffort = await render(['bug', 'Effort: high', 'model: sonnet']);
    assert.match(withEffort, /^- Labels: bug$/m);
    assert.doesNotMatch(withEffort, /effort: high/i);
    assert.doesNotMatch(await render(['effort: low']), /Labels:/);
  });

  it('reads the default effort of the shipped WORKFLOW.md from CLAUDE_EFFORT', async () => {
    const workflowPath = path.resolve(import.meta.dirname, '../WORKFLOW.md');
    const { definition } = await loadWorkflowFile(workflowPath);
    const effortOf = (env: Record<string, string>) =>
      resolveConfig(definition.config, { workflowPath, env, trackerDefaults }).claude.effort;
    assert.equal(effortOf({}), null);
    assert.equal(effortOf({ CLAUDE_EFFORT: '' }), null);
    assert.equal(effortOf({ CLAUDE_EFFORT: 'medium' }), 'medium');
    assert.throws(() => effortOf({ CLAUDE_EFFORT: 'hi' }), /claude\.effort must be one of/);
  });

  it('loads the .claude toolbox as a plugin and Laravel Boost on auto in the shipped WORKFLOW.md', async () => {
    const workflowPath = path.resolve(import.meta.dirname, '../WORKFLOW.md');
    const { definition } = await loadWorkflowFile(workflowPath);
    const config = resolveConfig(definition.config, { workflowPath, env: {}, trackerDefaults });
    const toolbox = path.resolve(import.meta.dirname, '../.claude');
    assert.deepEqual(config.claude.plugins, [toolbox]);
    assert.equal(config.claude.skills, 'all');
    // Haiku has no auto mode; without this entry its sessions fall back to "default" and deny every Bash and Write call.
    assert.deepEqual(config.claude.byModel.get('haiku'), { permissionMode: 'acceptEdits', allowedTools: ['Bash', 'Read', 'Write', 'Edit'] });
    assert.equal(config.claude.permissionMode, 'auto');
    assert.equal(JSON.parse(fs.readFileSync(path.join(toolbox, '.claude-plugin', 'plugin.json'), 'utf8')).name, 'symphony');
    for (const dir of ['skills', 'agents', 'commands', 'hooks']) assert.ok(fs.statSync(path.join(toolbox, dir)).isDirectory(), dir);
    assert.deepEqual(laravelOf(config), {
      boost: 'auto',
      php: 'php',
      composer: 'composer',
      installDependencies: true,
      timeoutMs: 600_000,
      env: { APP_ENV: 'local' },
      agentEnv: {},
      allowTinker: false,
      denyTools: ['record-rule'],
    });
    assert.deepEqual(config.warnings, []);
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

describe('roles config', () => {
  const base = { tracker: { kind: 'github', active_states: ['Ready', 'In progress', 'Agent review'] } };
  const valid = {
    developer: { states: ['Ready', 'In progress'], may_move_to: ['In progress', 'Agent review'] },
    reviewer: { states: ['Agent review'], read_only: true, max_turns: 6, claude: { model: 'opus' } },
  };
  const messageOf = (front: Record<string, unknown>): string => {
    try {
      resolve(front);
    } catch (error) {
      return (error as Error).message;
    }
    return '';
  };

  it('is null without a roles section', () => {
    assert.equal(resolve(base).roles, null);
  });

  it('parses roles and finds them case-insensitively with roleFor', () => {
    const roles = resolve({ ...base, roles: valid }).roles;
    assert.ok(roles);
    assert.equal(roleFor({ state: 'in PROGRESS', description: null }, roles)?.name, 'developer');
    assert.deepEqual(roles[0]?.states, ['ready', 'in progress']);
    assert.equal(roles[0]?.readOnly, false);
    assert.equal(roles[0]?.maxTurns, null);
    assert.equal(roles[1]?.readOnly, true);
    assert.equal(roles[1]?.maxTurns, 6);
    assert.equal(roles[1]?.mayMoveTo, null);
    assert.deepEqual(roles[1]?.claude, { model: 'opus' });
    assert.equal(roleFor({ state: 'Done', description: null }, roles), null);
    assert.equal(roleFor({ state: 'Ready', description: null }, null), null);
  });

  it('reads agent.reserved_slots_by_role for configured roles and ignores the rest with a warning', () => {
    assert.deepEqual([...resolve({ ...base, roles: valid }).agent.reservedSlotsByRole], [], 'default: no reservations');
    const config = resolve({
      ...base,
      roles: valid,
      agent: { reserved_slots_by_role: { developer: 1, reviewer: '2', tester: 1, Developer: 1, planner: -1, analyst: 'x', auditor: 0 } },
    });
    assert.deepEqual([...config.agent.reservedSlotsByRole], [['developer', 1], ['reviewer', 2]]);
    const warnings = config.warnings.filter((w) => w.includes('reserved_slots_by_role'));
    assert.equal(warnings.length, 4);
    assert.ok(warnings.includes('agent.reserved_slots_by_role.tester ignored: not a role (roles: developer, reviewer)'), warnings.join('\n'));
    assert.ok(warnings.some((w) => w.startsWith('agent.reserved_slots_by_role.planner ignored: needs an integer')));

    const noRoles = resolve({ ...base, agent: { reserved_slots_by_role: { developer: 1 } } });
    assert.equal(noRoles.agent.reservedSlotsByRole.size, 0);
    assert.ok(noRoles.warnings.includes('agent.reserved_slots_by_role.developer ignored: reservations need a roles section'));
    const notMap = resolve({ ...base, roles: valid, agent: { reserved_slots_by_role: [1] } });
    assert.equal(notMap.agent.reservedSlotsByRole.size, 0);
    assert.ok(notMap.warnings.includes('agent.reserved_slots_by_role is not a map; ignored'));
  });

  it('rejects a role state that is not active', () => {
    const message = messageOf({ ...base, roles: { ...valid, extra: { states: ['Blocked'] } } });
    assert.match(message, /roles\.extra\.states: "Blocked" is not in tracker\.active_states/);
  });

  it('rejects a state in more than one role', () => {
    const message = messageOf({ ...base, roles: { ...valid, extra: { states: ['ready'] } } });
    assert.match(message, /belongs to more than one role \(developer, extra\)/);
  });

  it('rejects an active state without a role', () => {
    const message = messageOf({ ...base, roles: { developer: valid.developer } });
    assert.match(message, /active state "Agent review" has no role/);
  });

  it('rejects unknown keys under a role and its claude block', () => {
    const message = messageOf({
      ...base,
      roles: { ...valid, reviewer: { ...valid.reviewer, bogus: 1, claude: { model: 'opus', permission_mode: 'auto' } } },
    });
    assert.match(message, /roles\.reviewer\.bogus is not a known key/);
    assert.match(message, /roles\.reviewer\.claude\.permission_mode is not a known key/);
  });

  it('rejects invalid value types', () => {
    assert.match(messageOf({ ...base, roles: 'x' }), /roles must be a map/);
    const message = messageOf({
      ...base,
      roles: {
        developer: { states: 'Ready', read_only: 'maybe', max_turns: 0, may_move_to: [1], claude: { effort: 'huge' } },
        reviewer: valid.reviewer,
      },
    });
    assert.match(message, /roles\.developer\.states must be a list of strings/);
    assert.match(message, /roles\.developer\.read_only must be true or false/);
    assert.match(message, /roles\.developer\.max_turns must be an integer >= 1/);
    assert.match(message, /roles\.developer\.may_move_to must be a list of strings/);
    assert.match(message, /roles\.developer\.claude\.effort must be one of/);
  });

  it('reports several errors in one invalid_config', () => {
    const front = { ...base, roles: { developer: { states: ['Blocked'], bogus: true } } };
    assert.equal(codeOf(() => resolve(front)), 'invalid_config');
    const message = messageOf(front);
    assert.match(message, /not in tracker\.active_states/);
    assert.match(message, /bogus is not a known key/);
    assert.match(message, /has no role/);
  });

  it('warns when roles is set with unlimited max_continuations', () => {
    const warning = /agent\.max_continuations is unlimited/;
    assert.ok(resolve({ ...base, roles: valid }).warnings.some((w) => warning.test(w)));
    const limited = resolve({ ...base, roles: valid, agent: { max_continuations: 3 } });
    assert.ok(!limited.warnings.some((w) => warning.test(w)));
    assert.ok(!resolve(base).warnings.some((w) => warning.test(w)));
  });

  describe('commands', () => {
    const auditor = { commands: ['/Refactoring', 'audit'], states: ['Ready', 'In progress'], run_checks: false, max_sub_issues: 20, read_only: true };
    const withAuditor = { ...base, roles: { ...valid, auditor } };
    const roles = () => resolve(withAuditor).roles ?? [];

    it('parses commands, run_checks and max_sub_issues, with defaults for roles that omit them', () => {
      const [developer, reviewer, found] = roles();
      assert.deepEqual([developer?.commands, developer?.runChecks, developer?.maxSubIssues], [null, true, null]);
      assert.deepEqual([reviewer?.commands, reviewer?.runChecks, reviewer?.maxSubIssues], [null, true, null]);
      assert.deepEqual(found?.commands, ['refactoring', 'audit']);
      assert.equal(found?.runChecks, false);
      assert.equal(found?.maxSubIssues, 20);
    });

    it('lets a command role share states with a role without commands', () => {
      assert.equal(messageOf(withAuditor), '');
    });

    it('picks the command role only for an issue that starts with its command', () => {
      const pick = (state: string, description: string | null) => roleFor({ state, description }, roles())?.name ?? null;
      assert.equal(pick('Ready', '/refactoring app/Filament'), 'auditor');
      assert.equal(pick('in PROGRESS', '\n/audit'), 'auditor');
      assert.equal(pick('Ready', 'Please do /refactoring'), 'developer');
      assert.equal(pick('Ready', '/unknown thing'), 'developer');
      assert.equal(pick('Ready', null), 'developer');
      // No command role serves "Agent review": the reviewer takes the issue.
      assert.equal(pick('Agent review', '/refactoring'), 'reviewer');
      assert.equal(pick('Done', '/refactoring'), null);
    });

    it('keeps the old behaviour for configs without commands', () => {
      const plain = resolve({ ...base, roles: valid }).roles ?? [];
      assert.equal(roleFor({ state: 'Ready', description: '/refactoring' }, plain)?.name, 'developer');
    });

    it('rejects two roles that serve the same command and state, but not the same state for different commands', () => {
      const twin = { commands: ['refactoring'], states: ['ready'] };
      assert.match(messageOf({ ...base, roles: { ...valid, auditor, twin } }), /state "ready" belongs to more than one role for \/refactoring \(auditor, twin\)/);
      assert.equal(messageOf({ ...base, roles: { ...valid, auditor, other: { commands: ['other'], states: ['ready'] } } }), '');
    });

    it('still requires a role without commands for every active state', () => {
      const message = messageOf({ ...base, roles: { reviewer: valid.reviewer, auditor } });
      assert.match(message, /active state "Ready" has no role/);
      assert.match(message, /active state "In progress" has no role/);
    });

    it('rejects invalid commands, run_checks and max_sub_issues', () => {
      const invalid = (extra: Record<string, unknown>) => messageOf({ ...base, roles: { ...valid, auditor: { ...auditor, ...extra } } });
      assert.match(invalid({ commands: [] }), /roles\.auditor\.commands must list at least one command/);
      assert.match(invalid({ commands: ['Not A Name'] }), /roles\.auditor\.commands: "Not A Name" is not a command name/);
      assert.match(invalid({ commands: 'refactoring' }), /roles\.auditor\.commands must be a list of strings/);
      assert.match(invalid({ run_checks: 'sometimes' }), /roles\.auditor\.run_checks must be true or false/);
      assert.match(invalid({ max_sub_issues: 0 }), /roles\.auditor\.max_sub_issues must be an integer >= 1/);
      assert.match(invalid({ max_sub_issues: 101 }), /roles\.auditor\.max_sub_issues must be at most 100 \(got 101\)/);
      assert.equal(invalid({ max_sub_issues: 100 }), '');
    });

    it('parses sub_issue_status and wait_for_sub_issues, off by default', () => {
      const autopilot = { commands: ['auto-code'], states: ['Ready', 'In progress'], max_sub_issues: 5, sub_issue_status: ' Ready ', wait_for_sub_issues: true };
      const found = resolve({ ...base, roles: { ...valid, autopilot } }).roles?.find((role) => role.name === 'autopilot');
      assert.deepEqual([found?.subIssueStatus, found?.waitForSubIssues], ['Ready', true]);
      const [developer, , audit] = roles();
      assert.deepEqual([developer?.subIssueStatus, developer?.waitForSubIssues], [null, false]);
      assert.deepEqual([audit?.subIssueStatus, audit?.waitForSubIssues], [null, false]);
    });

    it('rejects a sub_issue_status without max_sub_issues or in a terminal state', () => {
      const invalid = (extra: Record<string, unknown>) =>
        messageOf({ ...base, tracker: { ...base.tracker, terminal_states: ['Done'] }, roles: { ...valid, auditor: { ...auditor, ...extra } } });
      assert.match(invalid({ sub_issue_status: 'Ready', max_sub_issues: undefined }), /roles\.auditor\.sub_issue_status needs roles\.auditor\.max_sub_issues/);
      assert.match(invalid({ sub_issue_status: 'done' }), /roles\.auditor\.sub_issue_status must not be a terminal state \(got "done"\)/);
      assert.match(invalid({ wait_for_sub_issues: 'yes' }), /roles\.auditor\.wait_for_sub_issues must be true or false/);
      assert.equal(invalid({ sub_issue_status: 'Ready', wait_for_sub_issues: true }), '');
    });

    it('checks a role sub_issue_status against the board columns', () => {
      const config = resolve({ ...base, roles: { ...valid, auditor: { ...auditor, sub_issue_status: 'Redy' } } });
      assert.deepEqual(unknownBoardColumns(config, ['Ready', 'In progress', 'Agent review']), [
        'unknown board column "Redy" (valid: Ready, In progress, Agent review)',
      ]);
    });
  });
});

describe('result-driven roles and the pipeline section', () => {
  const base = { tracker: { kind: 'github', active_states: ['Ready', 'In progress', 'Agent review', 'Docs'], terminal_states: ['Done'] } };
  const roles = {
    developer: { states: ['Ready', 'In progress'], may_move_to: ['In progress', 'Agent review'] },
    reviewer: {
      states: ['Agent review'],
      read_only: true,
      result: 'review',
      may_move_to: ['In review'],
      on_result: { approved: 'In review', changes_needed: 'In progress' },
      on_check_failed: 'In progress',
    },
    docs: { states: ['Docs'] },
  };
  const messageOf = (front: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): string => {
    try {
      resolve(front, env);
    } catch (error) {
      return (error as Error).message;
    }
    return '';
  };
  const withReviewer = (overrides: Record<string, unknown>) => ({ ...base, roles: { ...roles, reviewer: { ...roles.reviewer, ...overrides } } });
  const reviewerOf = (front: Record<string, unknown>) => resolve(front).roles?.find((role) => role.name === 'reviewer');

  it('loads the shipped WORKFLOW.md without warnings about the new keys', async () => {
    const { definition } = await loadWorkflowFile(path.resolve(import.meta.dirname, '../WORKFLOW.md'));
    const config = resolve(definition.config, { CLAUDE_EFFORT: '' });
    assert.ok(!config.warnings.some((warning) => /pipeline/.test(warning)), config.warnings.join('\n'));
    const transitions = (name: string) => {
      const role = config.roles?.find((candidate) => candidate.name === name);
      return [role?.result, role?.onResult, role?.onCheckFailed, role?.onMissingResult, role?.onRoundLimit];
    };
    // The issue analyst, the architect, the developer, the test engineer and the reviewer hand off with report_result; every other role keeps the neutral values.
    assert.deepEqual(transitions('issue-analyst'), ['analysis', { ready: 'next', needs_info: 'Blocked' }, null, 'Blocked', null]);
    assert.deepEqual(transitions('architect'), ['design', { ready: 'In progress', blocked: 'Blocked' }, null, 'Blocked', null]);
    assert.deepEqual(transitions('developer'), ['implementation', { done: 'Agent review', blocked: 'Blocked' }, null, 'Blocked', null]);
    assert.deepEqual(transitions('test-engineer'), ['test', { passed: 'Agent review', failed: 'In progress', blocked: 'Blocked' }, null, 'Blocked', null]);
    assert.deepEqual(
      transitions('reviewer'),
      ['review', { approved: 'In review', changes_needed: 'In progress', blocked: 'Blocked' }, 'In progress', 'Blocked', null],
    );
    assert.equal(config.pipeline.maxReviewRounds, 3);
    assert.equal(config.pipeline.maxTestRounds, 2);
    for (const role of config.roles ?? []) {
      if (['issue-analyst', 'architect', 'developer', 'test-engineer', 'reviewer'].includes(role.name)) continue;
      assert.deepEqual([role.result, role.onResult, role.onCheckFailed, role.onMissingResult, role.onRoundLimit], [null, {}, null, null, null], role.name);
    }
  });

  it('gives roles without the new keys neutral values and the pipeline section its defaults', () => {
    const config = resolve({ ...base, roles });
    const developer = config.roles?.[0];
    assert.deepEqual([developer?.result, developer?.onMissingResult, developer?.modelLabel], [null, null, 'apply']);
    assert.deepEqual(developer?.mayMoveTo, ['In progress', 'Agent review']);
    assert.deepEqual(
      { ...config.pipeline, typeLabels: [...config.pipeline.typeLabels], profiles: [...config.pipeline.profiles] },
      {
        maxReviewRounds: 3,
        maxTestRounds: 2,
        limitLabel: 'needs-human',
        typeLabels: [],
        defaultType: 'feature',
        analysis: 'always',
        profiles: [],
        testPaths: ['tests/**', 'test/**', '**/*.test.*', '**/*Test.php'],
        docsPaths: [],
        securityPaths: [],
      },
    );
  });

  it('needs only result for a minimal role', () => {
    const minimal = { ...base, roles: { ...roles, reviewer: { states: ['Agent review'], result: 'review' } } };
    const reviewer = reviewerOf(minimal);
    assert.equal(reviewer?.result, 'review');
    assert.equal(reviewer?.modelLabel, 'apply', 'only read-only roles ignore the model label by default');
    assert.deepEqual(reviewer?.onResult, {});
    assert.equal(reviewer?.onMissingResult, 'Blocked');
    assert.equal(reviewer?.mayMoveTo, null, 'a role without may_move_to stays unrestricted');
    assert.equal(reviewerOf({ ...base, roles: { ...roles, reviewer: { states: ['Agent review'], result: 'review', read_only: true } } })?.modelLabel, 'ignore');
  });

  it('reads result, on_result, on_check_failed, on_missing_result and model_label', () => {
    const reviewer = reviewerOf(withReviewer({ on_missing_result: 'Docs', model_label: 'apply', on_result: { approved: 'next', blocked: 'Docs' } }));
    assert.equal(reviewer?.result, 'review');
    assert.deepEqual(reviewer?.onResult, { approved: 'next', blocked: 'Docs' });
    assert.equal(reviewer?.onCheckFailed, 'In progress');
    assert.equal(reviewer?.onMissingResult, 'Docs');
    assert.equal(reviewer?.modelLabel, 'apply');
    assert.equal(reviewerOf({ ...base, roles: { ...roles, reviewer: { states: ['Agent review'], model_label: 'ignore' } } })?.modelLabel, 'ignore');
  });

  it('reads on_round_limit for review and test roles only', () => {
    const reviewer = reviewerOf(withReviewer({ on_round_limit: ' In review ' }));
    assert.equal(reviewer?.onRoundLimit, 'In review');
    assert.equal(reviewerOf(withReviewer({}))?.onRoundLimit, null);
    assert.deepEqual(reviewerOf(withReviewer({ may_move_to: ['Blocked'], on_round_limit: 'Docs' }))?.mayMoveTo, ['Blocked', 'In review', 'In progress', 'Docs']);
    const testerOf = (extra: Record<string, unknown>) => resolve({ ...base, roles: { ...roles, docs: { states: ['Docs'], result: 'test', ...extra } } });
    assert.equal(testerOf({ on_round_limit: 'Blocked' }).roles?.find((role) => role.name === 'docs')?.onRoundLimit, 'Blocked');
    assert.match(
      messageOf({ ...base, roles: { ...roles, docs: { states: ['Docs'], result: 'docs', on_round_limit: 'Blocked' } } }),
      /roles\.docs\.on_round_limit needs roles\.docs\.result review or test \(the kinds with a round limit\)/,
    );
    assert.match(messageOf(withReviewer({ on_round_limit: 'Done' })), /roles\.reviewer\.on_round_limit must not be a terminal state/);
    assert.match(messageOf(withReviewer({ on_round_limit: 'next' })), /roles\.reviewer\.on_round_limit must be a column name \(next is only for on_result\)/);
  });

  it('merges the targets into mayMoveTo without duplicates and leaves next out', () => {
    const reviewer = reviewerOf(withReviewer({ on_missing_result: 'blocked', on_result: { approved: 'In Review', changes_needed: 'next', blocked: 'Docs' } }));
    assert.deepEqual(reviewer?.mayMoveTo, ['In review', 'Docs', 'In progress', 'blocked']);
  });

  it('rejects a verdict that does not belong to the result kind', () => {
    const message = messageOf(withReviewer({ on_result: { passed: 'In review' } }));
    assert.match(message, /roles\.reviewer\.on_result\.passed: "passed" is not a verdict of result review \(allowed: approved, changes_needed, blocked\)/);
  });

  it('rejects an unknown result kind, and on_result or on_missing_result without result', () => {
    assert.match(messageOf(withReviewer({ result: 'tests' })), /roles\.reviewer\.result must be one of analysis, design/);
    assert.match(messageOf(withReviewer({ result: 'skipped' })), /roles\.reviewer\.result must be one of/, 'internal kinds are not for roles');
    const noResult = messageOf({ ...base, roles: { ...roles, docs: { states: ['Docs'], on_result: { done: 'Done' }, on_missing_result: 'Blocked' } } });
    assert.match(noResult, /roles\.docs\.on_result needs roles\.docs\.result/);
    assert.match(noResult, /roles\.docs\.on_result\.done/);
    assert.match(noResult, /roles\.docs\.on_missing_result needs roles\.docs\.result/);
  });

  it('rejects terminal targets with the field path', () => {
    const message = messageOf(withReviewer({ on_result: { approved: 'done' }, on_check_failed: 'Done', on_missing_result: 'DONE' }));
    assert.match(message, /roles\.reviewer\.on_result\.approved must not be a terminal state \(got "done"\)/);
    assert.match(message, /roles\.reviewer\.on_check_failed must not be a terminal state/);
    assert.match(message, /roles\.reviewer\.on_missing_result must not be a terminal state/);
  });

  it('rejects empty targets, next outside on_result and malformed values', () => {
    const message = messageOf(withReviewer({ on_result: { approved: ' ', blocked: 3 }, on_check_failed: 'next', on_missing_result: '' }));
    assert.match(message, /roles\.reviewer\.on_result\.approved must not be empty/);
    assert.match(message, /roles\.reviewer\.on_result\.blocked must be a column name or next/);
    assert.match(message, /roles\.reviewer\.on_check_failed must be a column name \(next is only for on_result\)/);
    assert.match(message, /roles\.reviewer\.on_missing_result must not be empty/);
    assert.match(messageOf(withReviewer({ on_result: ['approved'] })), /roles\.reviewer\.on_result must be a map of verdicts to columns/);
    assert.match(messageOf(withReviewer({ model_label: 'sometimes' })), /roles\.reviewer\.model_label must be one of apply, ignore/);
  });

  describe('board checks', () => {
    const board = ['Backlog', 'Ready', 'In progress', 'Agent review', 'Docs', 'Blocked', 'In review', 'Done'];

    it('checks result targets against the board, even for a role without may_move_to', () => {
      const config = resolve({ ...base, roles: { ...roles, reviewer: { states: ['Agent review'], result: 'review', on_result: { approved: 'Shipped' }, on_check_failed: 'Nope' } } });
      assert.deepEqual(unknownBoardColumns(config, board), [
        `unknown board column "Shipped" (valid: ${board.join(', ')})`,
        `unknown board column "Nope" (valid: ${board.join(', ')})`,
      ]);
      assert.deepEqual(unknownBoardColumns(resolve({ ...base, roles }), board), []);
    });

    it('resolves next to the next active column in board order', () => {
      const config = resolve(withReviewer({ may_move_to: ['In review', 'Docs'], on_result: { approved: 'next' } }));
      const reviewer = config.roles?.find((role) => role.name === 'reviewer');
      assert.ok(reviewer);
      assert.equal(nextActiveColumn(reviewer, config.tracker.activeStates, board), 'Docs');
      assert.equal(nextActiveColumn(reviewer, config.tracker.activeStates, ['Docs', 'Agent review']), null);
      assert.deepEqual(nextStageProblems(config, board), []);
    });

    it('reports a next stage outside may_move_to, but not for an unrestricted role', () => {
      assert.deepEqual(nextStageProblems(resolve(withReviewer({ on_result: { approved: 'next' } })), board), [
        'roles.reviewer.on_result.approved: "next" leads to "Docs", which is not in roles.reviewer.may_move_to (add it there)',
      ]);
      assert.deepEqual(nextStageProblems(resolve(withReviewer({ may_move_to: undefined, on_result: { approved: 'next' } })), board), []);
    });

    it('reports next without a known board order or without a later stage', () => {
      const config = resolve(withReviewer({ on_result: { approved: 'next' } }));
      assert.match(nextStageProblems(config, null).join(), /roles\.reviewer\.on_result\.approved: "next" needs the board's column order/);
      assert.match(nextStageProblems(config, ['Docs', 'Agent review']).join(), /roles\.reviewer\.on_result\.approved: "next" has no later active stage/);
      assert.deepEqual(nextStageProblems(resolve({ ...base, roles }), null), []);
    });
  });

  describe('pipeline section', () => {
    it('reads every key', () => {
      const { pipeline } = resolve({
        ...base,
        pipeline: {
          max_review_rounds: 5,
          max_test_rounds: '4',
          limit_label: 'stuck',
          type_labels: { Bug: 'bug', ' Chore ': 'maintenance' },
          default_type: 'chore',
          test_paths: ['test/**', '**/*.spec.ts'],
          docs_paths: ['docs/**'],
          security_paths: ['src/auth/**'],
        },
      });
      assert.equal(pipeline.maxReviewRounds, 5);
      assert.equal(pipeline.maxTestRounds, 4);
      assert.equal(pipeline.limitLabel, 'stuck');
      assert.deepEqual([...pipeline.typeLabels], [['bug', 'bug'], ['chore', 'maintenance']]);
      assert.equal(pipeline.defaultType, 'chore');
      assert.deepEqual([pipeline.testPaths, pipeline.docsPaths, pipeline.securityPaths], [['test/**', '**/*.spec.ts'], ['docs/**'], ['src/auth/**']]);
    });

    it('keeps an explicit test_paths list as it is and validates the globs', () => {
      const testPaths = (list: unknown) => resolve({ ...base, pipeline: { test_paths: list } }).pipeline.testPaths;
      assert.deepEqual(testPaths([' spec/** ', '**/*.{spec,test}.ts']), ['spec/**', '**/*.{spec,test}.ts']);
      assert.deepEqual(testPaths([]), [], 'an empty list allows no path at all');
      const message = messageOf({ ...base, pipeline: { test_paths: ['', '/abs/**', '../up/**', 'a/{b', '**/*.test.*'], docs_paths: ['{x,{y}}'] } });
      assert.match(message, /pipeline\.test_paths\[0\] "" must not be empty/);
      assert.match(message, /pipeline\.test_paths\[1\] "\/abs\/\*\*" must be relative to the repository root/);
      assert.match(message, /pipeline\.test_paths\[2\] "\.\.\/up\/\*\*" must not contain "\.\." segments/);
      assert.match(message, /pipeline\.test_paths\[3\] "a\/\{b" unclosed "\{"/);
      assert.match(message, /pipeline\.docs_paths\[0\] "\{x,\{y\}\}" nested braces are not supported/);
      assert.doesNotMatch(message, /test_paths\[4\]/);
    });

    it('resolves $VAR references in the limits and falls back to the defaults for unset ones', () => {
      const front = { ...base, pipeline: { max_review_rounds: '$REVIEW_ROUNDS', max_test_rounds: '$TEST_ROUNDS', limit_label: '$LIMIT_LABEL', docs_paths: ['$DOCS_GLOB'] } };
      const set = resolve(front, { REVIEW_ROUNDS: '6', TEST_ROUNDS: '1', LIMIT_LABEL: 'help', DOCS_GLOB: 'manual/**' }).pipeline;
      assert.deepEqual([set.maxReviewRounds, set.maxTestRounds, set.limitLabel, set.docsPaths], [6, 1, 'help', ['manual/**']]);
      const unset = resolve(front, {}).pipeline;
      assert.deepEqual([unset.maxReviewRounds, unset.maxTestRounds, unset.limitLabel, unset.docsPaths], [3, 2, 'needs-human', []]);
      assert.match(messageOf(front, { REVIEW_ROUNDS: '0' }), /pipeline\.max_review_rounds must be an integer >= 1 \(got "0"\)/);
      assert.match(messageOf(front, { REVIEW_ROUNDS: 'many' }), /pipeline\.max_review_rounds must be an integer >= 1/);
    });

    it('rejects invalid limits and malformed values with the field path', () => {
      const message = messageOf({
        ...base,
        pipeline: { max_review_rounds: 0, max_test_rounds: -1, limit_label: ' ', default_type: 3, type_labels: { bug: '' }, test_paths: 'test/**' },
      });
      assert.match(message, /pipeline\.max_review_rounds must be an integer >= 1 \(got 0\)/);
      assert.match(message, /pipeline\.max_test_rounds must be an integer >= 1 \(got -1\)/);
      assert.match(message, /pipeline\.limit_label must not be empty/);
      assert.match(message, /pipeline\.default_type must be a string/);
      assert.match(message, /pipeline\.type_labels\.bug must be a non-empty string/);
      assert.match(message, /pipeline\.test_paths must be a list of strings/);
      assert.match(messageOf({ ...base, pipeline: { type_labels: ['bug'] } }), /pipeline\.type_labels must be a map of labels to types/);
      assert.match(messageOf({ ...base, pipeline: 'x' }), /pipeline must be a map/);
    });

    it('reads pipeline.analysis and requires an analysis role for when_unlabeled', () => {
      const read = (analysis: unknown, extra: Record<string, unknown> = {}) => ({ ...base, roles: { ...roles, ...extra }, pipeline: { analysis } });
      assert.equal(resolve({ ...base, roles }).pipeline.analysis, 'always');
      assert.equal(resolve(read('when_unlabeled', { docs: { states: ['Docs'], result: 'analysis' } })).pipeline.analysis, 'when_unlabeled');
      assert.match(messageOf(read('sometimes')), /pipeline\.analysis must be one of always, when_unlabeled \(got "sometimes"\)/);
      assert.match(messageOf(read('when_unlabeled')), /pipeline\.analysis: when_unlabeled needs a role with `result: analysis`/);
    });

    describe('profiles', () => {
      const tester = { states: ['Testing'], result: 'test', may_move_to: ['Agent review', 'In progress', 'Blocked'] };
      const front = (profiles: unknown, testerRole: Record<string, unknown> = tester) => ({
        tracker: { ...base.tracker, active_states: [...base.tracker.active_states, 'Testing'] },
        roles: { ...roles, tester: testerRole },
        pipeline: { profiles },
      });
      const profiles = (value: unknown) => resolve(front(value)).pipeline.profiles;

      it('reads skip, on_result and the round limits per issue type and default', () => {
        const read = profiles({
          bugfix: { skip: ['tester', ' docs '], max_review_rounds: 2, max_test_rounds: '1' },
          default: { on_result: { tester: { failed: 'In progress', passed: 'next' } } },
          refactor: {},
        });
        assert.deepEqual(
          [...read].map(([name, profile]) => [name, profile]),
          [
            ['bugfix', { name: 'bugfix', skip: ['tester', 'docs'], skipWhen: {}, onResult: {}, maxReviewRounds: 2, maxTestRounds: 1 }],
            ['default', { name: 'default', skip: [], skipWhen: {}, onResult: { tester: { failed: 'In progress', passed: 'next' } }, maxReviewRounds: null, maxTestRounds: null }],
            ['refactor', { name: 'refactor', skip: [], skipWhen: {}, onResult: {}, maxReviewRounds: null, maxTestRounds: null }],
          ],
        );
        assert.equal(profiles(undefined).size, 0);
      });

      it('reads skip_when per role with a fixed complexity vocabulary', () => {
        const read = profiles({
          bugfix: { skip_when: { tester: { complexity: ['S', ' m ', 's'] } } },
          feature: { skip_when: { tester: { complexity: ['xl'] } } },
        });
        assert.deepEqual(read.get('bugfix')?.skipWhen, { tester: ['S', 'M'] });
        assert.deepEqual(read.get('feature')?.skipWhen, { tester: ['XL'] });
      });

      it('rejects unknown roles, conditions and complexity values in skip_when, naming the field', () => {
        const message = messageOf(
          front({
            bugfix: { skip_when: { qa: { complexity: ['S'] }, tester: { complexity: ['S', 'XXL', 'huge'], labels: ['x'] } } },
            feature: { skip_when: { tester: { type: ['bugfix'] }, docs: 'S', developer: { complexity: [] } } },
            refactor: { skip_when: ['tester'] },
            default: { skip_when: { tester: { complexity: 'S' } } },
          }),
        );
        assert.match(message, /pipeline\.profiles\.bugfix\.skip_when\.qa: unknown role \(roles: developer, reviewer, docs, tester\)/);
        assert.match(message, /pipeline\.profiles\.bugfix\.skip_when\.tester\.complexity: unknown value "XXL" \(allowed: S, M, L, XL\)/);
        assert.match(message, /pipeline\.profiles\.bugfix\.skip_when\.tester\.complexity: unknown value "huge"/);
        assert.match(message, /pipeline\.profiles\.bugfix\.skip_when\.tester\.labels: unknown condition \(allowed: complexity\)/);
        assert.match(message, /pipeline\.profiles\.feature\.skip_when\.tester\.type: unknown condition \(allowed: complexity\)/);
        assert.match(message, /pipeline\.profiles\.feature\.skip_when\.tester\.complexity must list at least one of S, M, L, XL/);
        assert.match(message, /pipeline\.profiles\.feature\.skip_when\.docs must be a map \(allowed key: complexity\)/);
        assert.match(message, /pipeline\.profiles\.feature\.skip_when\.developer\.complexity must list at least one/);
        assert.match(message, /pipeline\.profiles\.refactor\.skip_when must be a map of roles to conditions/);
        assert.match(message, /pipeline\.profiles\.default\.skip_when\.tester\.complexity must be a list of strings/);
      });

      it('checks `next` against every column a skip_when stage can lead to', () => {
        const board = ['Ready', 'In progress', 'Docs', 'Agent review', 'Done'];
        const chain = (mayMoveTo: string[]) =>
          resolve({
            tracker: { kind: 'github', active_states: ['In progress', 'Docs', 'Agent review'], terminal_states: ['Done'] },
            roles: {
              developer: { states: ['In progress'], result: 'implementation', may_move_to: mayMoveTo, on_result: { done: 'next' } },
              docs: { states: ['Docs'], result: 'docs', may_move_to: ['Agent review'], on_result: { done: 'next' } },
              reviewer: { states: ['Agent review'] },
            },
            pipeline: { profiles: { feature: { skip_when: { docs: { complexity: ['S'] } } } } },
          });
        assert.deepEqual(nextStageProblems(chain(['Docs', 'Agent review']), board), []);
        // Docs is skipped for S: `next` may lead to Agent review, which the developer must be allowed to move to as well.
        assert.deepEqual(nextStageProblems(chain(['Docs']), board), [
          'roles.developer.on_result.done: "next" leads to "Agent review", which is not in roles.developer.may_move_to (add it there) (profile feature)',
        ]);
      });

      it('rejects unknown roles in skip and on_result', () => {
        const message = messageOf(front({ bugfix: { skip: ['tester', 'qa'], on_result: { qa: { passed: 'next' } } } }));
        assert.match(message, /pipeline\.profiles\.bugfix\.skip: unknown role "qa" \(roles: developer, reviewer, docs, tester\)/);
        assert.match(message, /pipeline\.profiles\.bugfix\.on_result\.qa: unknown role/);
        assert.doesNotMatch(message, /unknown role "tester"/);
        assert.match(messageOf({ ...base, pipeline: { profiles: { bugfix: { skip: ['developer'] } } } }), /skip: unknown role "developer" \(roles: none: set roles\)/);
      });

      it('validates profile names, keys, verdicts, targets and limits', () => {
        const message = messageOf(
          front({
            hotfix: {},
            bugfix: { skip: 'tester', skp: [], max_test_rounds: 0 },
            feature: { on_result: { tester: { passed: 'Done', exploded: 'In progress', failed: 'Docs' }, developer: { done: 'next' }, reviewer: 'x' } },
            refactor: { on_result: [] },
            default: 'x',
          }),
        );
        assert.match(message, /pipeline\.profiles\.hotfix: unknown profile \(allowed: bugfix, feature, refactor, default\)/);
        assert.match(message, /pipeline\.profiles\.bugfix\.skip must be a list of strings/);
        assert.match(message, /pipeline\.profiles\.bugfix\.skp: unknown key/);
        assert.match(message, /pipeline\.profiles\.bugfix\.max_test_rounds must be an integer >= 1 \(got 0\)/);
        assert.match(message, /pipeline\.profiles\.feature\.on_result\.tester\.passed must not be a terminal state \(got "Done"\)/);
        assert.match(message, /pipeline\.profiles\.feature\.on_result\.tester\.exploded: "exploded" is not a verdict of result test/);
        assert.match(message, /pipeline\.profiles\.feature\.on_result\.tester\.failed: "Docs" is not in roles\.tester\.may_move_to/);
        assert.match(message, /pipeline\.profiles\.feature\.on_result\.developer: role developer reports no result/);
        assert.match(message, /pipeline\.profiles\.feature\.on_result\.reviewer must be a map of verdicts to columns/);
        assert.match(message, /pipeline\.profiles\.refactor\.on_result must be a map of roles to verdicts/);
        assert.match(message, /pipeline\.profiles\.default must be a map/);
        assert.match(messageOf({ ...base, pipeline: { profiles: ['bugfix'] } }), /pipeline\.profiles must be a map of issue types to profiles/);
      });

      it('checks the profile targets against the board and `next` against the skipped stages', () => {
        const config = resolve(front({ bugfix: { on_result: { tester: { failed: 'Nowhere' } } } }, { states: ['Testing'], result: 'test' }));
        assert.ok(unknownBoardColumns(config, ['Ready', 'In progress', 'Agent review', 'Docs', 'Testing', 'Done']).some((problem) => problem.includes('"Nowhere"')));

        const board = ['Ready', 'In progress', 'Docs', 'Agent review', 'Done'];
        const chain = (skip: string[], mayMoveTo = ['Docs', 'Agent review']) =>
          resolve({
            tracker: { kind: 'github', active_states: ['In progress', 'Docs', 'Agent review'], terminal_states: ['Done'] },
            roles: {
              developer: { states: ['In progress'], result: 'implementation', may_move_to: mayMoveTo, on_result: { done: 'next' } },
              docs: { states: ['Docs'], result: 'docs', may_move_to: ['Agent review'], on_result: { done: 'next' } },
              reviewer: { states: ['Agent review'] },
            },
            pipeline: { profiles: { bugfix: { skip } } },
          });
        assert.deepEqual(nextStageProblems(chain(['docs']), board), []);
        assert.deepEqual(nextStageProblems(chain(['docs'], ['Docs']), board), [
          'roles.developer.on_result.done: "next" leads to "Agent review", which is not in roles.developer.may_move_to (add it there) (profile bugfix)',
        ]);
        assert.deepEqual(nextStageProblems(chain(['reviewer']), board), [
          'roles.docs.on_result.done: "next" has no later active stage after docs on the board (profile bugfix)',
        ]);
      });
    });

    it('is a known top-level key and warns about unknown pipeline keys', () => {
      const warnings = resolve({ ...base, pipeline: { profile: {} } }).warnings;
      assert.ok(!warnings.some((warning) => /unknown top-level key "pipeline"/.test(warning)));
      assert.ok(warnings.some((warning) => warning.startsWith('unknown key pipeline.profile ignored')), warnings.join('\n'));
      assert.deepEqual(resolve({ ...base, pipeline: { profiles: {} } }).warnings, []);
      assert.deepEqual(resolve(base).warnings, [], 'a config without pipeline has no warnings');
    });
  });
});

describe('command skills in dispatch validation', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, '.claude', 'skills', 'refactoring'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'skills', 'refactoring', 'SKILL.md'), '---\nname: refactoring\n---\n');
  const roles = (commands: string[]) => ({
    developer: { states: ['Todo'] },
    auditor: { commands, states: ['Todo'] },
  });
  const errors = (commands: string[]) =>
    validateDispatch(
      {
        config: resolve({ tracker: { kind: 'github_project', active_states: ['Todo'] }, claude: { plugins: ['./.claude'] }, roles: roles(commands) }, {}, dir),
      } as unknown as EffectiveWorkflow,
      null,
      {},
    ).filter((error) => error.includes('commands'));

  it('accepts a command that has a skill in claude.plugins', () => {
    assert.deepEqual(errors(['refactoring']), []);
  });

  it('blocks dispatch when a role command has no skill', () => {
    assert.deepEqual(errors(['refactoring', 'missing']), [
      'roles.auditor.commands: no skill for /missing in claude.plugins (expected skills/missing/SKILL.md)',
    ]);
  });
});

describe('role subagents', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'agents', 'laravel-architect.md'), '---\nname: laravel-architect\ndescription: Plans.\ndisallowedTools: Edit, Write, NotebookEdit\n---\n');
  fs.writeFileSync(path.join(dir, '.claude', 'agents', 'laravel-filament-developer.md'), '---\nname: laravel-filament-developer\ndescription: Builds.\n---\n');
  fs.writeFileSync(path.join(dir, '.claude', 'agents', 'reader.md'), '---\nname: reader\ndescription: Reads.\ntools: Read, Grep\n---\n');
  const front = (reviewer: Record<string, unknown>) => ({
    tracker: { kind: 'github_project', active_states: ['Todo', 'Agent review'] },
    claude: { plugins: ['./.claude'] },
    roles: { developer: { states: ['Todo'] }, reviewer: { states: ['Agent review'], read_only: true, ...reviewer } },
  });
  const errors = (reviewer: Record<string, unknown>) =>
    validateDispatch({ config: resolve(front(reviewer), {}, dir) } as unknown as EffectiveWorkflow, null, {}).filter((error) => error.includes('agents'));

  it('reads the plugin subagents with their read-only flag', () => {
    assert.deepEqual(pluginAgents([path.join(dir, '.claude')]), [
      { name: 'laravel-architect', qualified: '.claude:laravel-architect', description: 'Plans.', readOnly: true },
      { name: 'laravel-filament-developer', qualified: '.claude:laravel-filament-developer', description: 'Builds.', readOnly: false },
      { name: 'reader', qualified: '.claude:reader', description: 'Reads.', readOnly: true },
    ]);
  });

  it('parses roles.<role>.agents: unset means all, an empty list none', () => {
    const roles = resolve(front({ agents: [] }), {}, dir).roles ?? [];
    assert.equal(roles.find((role) => role.name === 'developer')?.agents, null);
    assert.deepEqual(roles.find((role) => role.name === 'reviewer')?.agents, []);
    assert.throws(() => resolve(front({ agents: ['kit:reader'] }), {}, dir), /roles\.reviewer\.agents: "kit:reader" is not an agent name/);
  });

  it('blocks dispatch for unknown subagents and editing subagents in a read-only role', () => {
    assert.deepEqual(errors({ agents: ['laravel-architect', 'reader'] }), []);
    assert.deepEqual(errors({ agents: ['laravel-filament-developer', 'missing'] }), [
      'roles.reviewer.agents: laravel-filament-developer can edit files, but the role is read-only',
      'roles.reviewer.agents: no subagent missing in claude.plugins (expected agents/missing.md)',
    ]);
  });

  it('splits the subagents by role list, read-only policy and integration prefix', () => {
    const agents = pluginAgents([path.join(dir, '.claude')]);
    const role = (overrides: Partial<RoleConfig>) => ({ name: 'r', states: [], readOnly: false, mayMoveTo: null, result: null, onResult: {}, onCheckFailed: null, onMissingResult: null, onRoundLimit: null, modelLabel: 'apply' as const, maxTurns: null, commands: null, runChecks: true, maxSubIssues: null, subIssueStatus: null, waitForSubIssues: false, agents: null, claude: {}, ...overrides });
    const names = (split: { allowed: Array<{ name: string }>; denied: Array<{ name: string }> }) => [split.allowed.map((a) => a.name), split.denied.map((a) => a.name)];
    assert.deepEqual(names(sessionAgents(agents, null, ['laravel-'], ['laravel-'])), [['laravel-architect', 'laravel-filament-developer', 'reader'], []]);
    assert.deepEqual(names(sessionAgents(agents, null, ['laravel-'], [])), [['reader'], ['laravel-architect', 'laravel-filament-developer']]);
    assert.deepEqual(names(sessionAgents(agents, role({ readOnly: true }), ['laravel-'], ['laravel-'])), [['laravel-architect', 'reader'], ['laravel-filament-developer']]);
    assert.deepEqual(names(sessionAgents(agents, role({ agents: ['laravel-architect'] }), ['laravel-'], ['laravel-'])), [['laravel-architect'], ['laravel-filament-developer', 'reader']]);
    assert.deepEqual(names(sessionAgents(agents, role({ agents: [] }), [], [])), [[], ['laravel-architect', 'laravel-filament-developer', 'reader']]);
  });
});
