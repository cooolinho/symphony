import os from 'node:os';
import path from 'node:path';
import type { EffortLevel, PermissionMode, SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { resolveEnvReference } from '../util/env.ts';
import { SymphonyError, errorMessage } from '../util/errors.ts';
import { resolveConfigPath } from '../util/paths.ts';
import { isPlainObject } from './loader.ts';
import { Reader, parseInteger } from './reader.ts';
import type { RoleClaudeOverrides, RoleConfig } from './roles.ts';

export interface TrackerConfig {
  kind: string | null;
  /** Adapter-owned settings, preserved verbatim (unknown keys included). */
  provider: Record<string, unknown>;
  requiredLabels: string[];
  activeStates: string[];
  terminalStates: string[];
}

export interface HooksConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export interface AgentConfig {
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  /**
   * Continuation sessions allowed while an issue stays active after normal runs; when reached,
   * the issue is paused until it changes on the tracker. null = unlimited (spec behavior).
   */
  maxContinuations: number | null;
  /** Keys are normalized state names (trimmed, lowercase). */
  maxConcurrentAgentsByState: ReadonlyMap<string, number>;
  /** Liquid template for continuation turns; null uses the built-in text. */
  continuationPrompt: string | null;
}

export type PermissionRequestPolicy = 'approve' | 'deny';

/** Claude Code session settings (the `claude` front matter section, replacing the spec's `codex`). */
export interface ClaudeConfig {
  model: string | null;
  fallbackModel: string | null;
  effort: EffortLevel | null;
  permissionMode: PermissionMode;
  onPermissionRequest: PermissionRequestPolicy;
  allowedTools: string[];
  disallowedTools: string[];
  settingSources: SettingSource[];
  /** Only MCP servers Symphony passes load (no repo .mcp.json, user/plugin servers or claude.ai connectors). */
  strictMcpConfig: boolean;
  sandbox: Record<string, unknown> | null;
  executable: string | null;
  appendSystemPrompt: string | null;
  maxBudgetUsd: number | null;
  persistSession: boolean;
  env: Record<string, string>;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
  /** Local Claude Code plugin directories (absolute) loaded into every session. */
  plugins: string[];
  /** Skills to enable ('all' or names); null leaves Claude Code's default. */
  skills: 'all' | string[] | null;
}

export type BoostMode = 'auto' | 'off';

/** Laravel workspaces (the `laravel` section): Laravel Boost for detected Laravel apps. */
export interface LaravelConfig {
  /** auto: use Boost for Laravel apps that require laravel/boost; off: never. */
  boost: BoostMode;
  /** PHP command: a bare name is looked up on PATH, a value with a slash or `~` is a resolved path. */
  php: string;
  /** Composer command, resolved like `php`. */
  composer: string;
  /** Run `composer install` when vendor/ is missing or composer.lock changed since the last install. */
  installDependencies: boolean;
  /** Limit for each php or composer step. */
  timeoutMs: number;
  /** Environment for composer, artisan and the Boost MCP server, on top of the agent's environment. */
  env: Record<string, string>;
}

export interface ServerConfig {
  port: number | null;
  host: string;
}

export interface ServiceConfig {
  workflowPath: string;
  workflowDir: string;
  tracker: TrackerConfig;
  polling: { intervalMs: number };
  workspace: {
    root: string;
    /** Delete workspaces of issues that reach a terminal state (spec behavior: true). */
    cleanupTerminal: boolean;
  };
  hooks: HooksConfig;
  agent: AgentConfig;
  claude: ClaudeConfig;
  laravel: LaravelConfig;
  /** Column-scoped roles; null without a `roles` section (one implicit `default` role). */
  roles: RoleConfig[] | null;
  server: ServerConfig;
  /** Non-fatal findings (ignored keys, ignored per-state limits) for operator logs. */
  warnings: string[];
}

export interface TrackerDefaults {
  activeStates: string[];
  terminalStates: string[];
}

export interface ResolveOptions {
  workflowPath: string;
  env: NodeJS.ProcessEnv;
  /** Adapter-documented state defaults for a tracker kind, if the kind is supported. */
  trackerDefaults: (kind: string) => TrackerDefaults | undefined;
}

export const DEFAULTS = {
  pollIntervalMs: 30_000,
  hookTimeoutMs: 60_000,
  maxConcurrentAgents: 10,
  maxTurns: 20,
  maxRetryBackoffMs: 300_000,
  turnTimeoutMs: 3_600_000,
  readTimeoutMs: 30_000,
  stallTimeoutMs: 300_000,
  serverHost: '127.0.0.1',
  workspaceRootName: 'symphony_workspaces',
} as const;

const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'];
const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const SETTING_SOURCES: readonly SettingSource[] = ['user', 'project', 'local'];
const KNOWN_TOP_LEVEL = new Set(['tracker', 'polling', 'workspace', 'hooks', 'agent', 'claude', 'laravel', 'roles', 'server']);
const ROLE_KEYS = new Set(['states', 'read_only', 'may_move_to', 'max_turns', 'claude']);
const ROLE_CLAUDE_KEYS = new Set(['model', 'effort', 'allowed_tools', 'disallowed_tools', 'append_system_prompt', 'max_budget_usd']);
const BOOST_MODES: readonly BoostMode[] = ['auto', 'off'];
/** Boost only registers its commands in the local environment (or with debug on); a fresh clone has no .env. */
const LARAVEL_DEFAULT_ENV: Readonly<Record<string, string>> = { APP_ENV: 'local' };

export function normalizeStateName(state: string): string {
  return state.trim().toLowerCase();
}

function readRoles(reader: Reader, raw: Record<string, unknown>, activeStates: string[]): RoleConfig[] | null {
  if (raw.roles === undefined || raw.roles === null) return null;
  if (!isPlainObject(raw.roles)) {
    reader.errors.push('roles must be a map');
    return null;
  }
  const roles: RoleConfig[] = [];
  const owners = new Map<string, string>();
  const active = new Set(activeStates.map(normalizeStateName));
  for (const [name, value] of Object.entries(raw.roles)) {
    const field = `roles.${name}`;
    if (!isPlainObject(value)) {
      reader.errors.push(`${field} must be a map`);
      continue;
    }
    for (const key of Object.keys(value)) {
      if (!ROLE_KEYS.has(key)) reader.errors.push(`${field}.${key} is not a known key (allowed: ${[...ROLE_KEYS].join(', ')})`);
    }
    const states: string[] = [];
    const statesValue = reader.stringList(value, 'states', `${field}.states`);
    if (statesValue === null && value.states === undefined) reader.errors.push(`${field}.states is required`);
    for (const state of statesValue ?? []) {
      const key = normalizeStateName(state);
      if (key === '' || states.includes(key)) continue;
      states.push(key);
      if (!active.has(key)) reader.errors.push(`${field}.states: ${JSON.stringify(state)} is not in tracker.active_states`);
      const owner = owners.get(key);
      if (owner !== undefined) reader.errors.push(`state ${JSON.stringify(state)} belongs to more than one role (${owner}, ${name})`);
      else owners.set(key, name);
    }
    if (statesValue !== null && states.length === 0) reader.errors.push(`${field}.states must list at least one state`);

    const mayMoveTo = reader.stringList(value, 'may_move_to', `${field}.may_move_to`);
    const maxTurnsValue = value.max_turns;
    const claudeRaw = value.claude;
    let claude: RoleClaudeOverrides = {};
    if (claudeRaw !== undefined && claudeRaw !== null) {
      if (isPlainObject(claudeRaw)) claude = readRoleClaude(reader, claudeRaw, `${field}.claude`);
      else reader.errors.push(`${field}.claude must be a map`);
    }
    roles.push({
      name,
      states,
      readOnly: reader.bool(value, 'read_only', `${field}.read_only`, false),
      mayMoveTo: mayMoveTo === null ? null : mayMoveTo.map((entry) => entry.trim()).filter((entry) => entry !== ''),
      maxTurns:
        maxTurnsValue === undefined || maxTurnsValue === null
          ? null
          : reader.int(value, 'max_turns', `${field}.max_turns`, 0, 1) || null,
      claude,
    });
  }
  for (const state of activeStates) {
    if (!owners.has(normalizeStateName(state))) reader.errors.push(`active state ${JSON.stringify(state)} has no role`);
  }
  return roles;
}

function readRoleClaude(reader: Reader, raw: Record<string, unknown>, field: string): RoleClaudeOverrides {
  for (const key of Object.keys(raw)) {
    if (!ROLE_CLAUDE_KEYS.has(key)) reader.errors.push(`${field}.${key} is not a known key (allowed: ${[...ROLE_CLAUDE_KEYS].join(', ')})`);
  }
  const claude: RoleClaudeOverrides = {};
  const model = reader.string(raw, 'model', `${field}.model`)?.trim();
  if (model) claude.model = model;
  const effort = reader.oneOf(raw, 'effort', `${field}.effort`, EFFORT_LEVELS, null);
  if (effort !== null) claude.effort = effort;
  const allowedTools = reader.stringList(raw, 'allowed_tools', `${field}.allowed_tools`);
  if (allowedTools !== null) claude.allowedTools = allowedTools;
  const disallowedTools = reader.stringList(raw, 'disallowed_tools', `${field}.disallowed_tools`);
  if (disallowedTools !== null) claude.disallowedTools = disallowedTools;
  const appendSystemPrompt = reader.script(raw, 'append_system_prompt', `${field}.append_system_prompt`);
  if (appendSystemPrompt !== null) claude.appendSystemPrompt = appendSystemPrompt;
  const maxBudgetUsd = reader.number(raw, 'max_budget_usd', `${field}.max_budget_usd`);
  if (maxBudgetUsd !== null) claude.maxBudgetUsd = maxBudgetUsd;
  return claude;
}

/**
 * Replaces whole-value `$NAME` references (strings and list items) with environment values;
 * unset or empty variables make the setting count as omitted. Hook scripts (shell code) and
 * `tracker.provider` (resolved by the adapter, which must know secret variable names) are left alone.
 */
export function substituteEnvReferences(value: unknown, env: NodeJS.ProcessEnv, path: string[] = []): unknown {
  if (path[0] === 'hooks' || (path[0] === 'tracker' && path[1] === 'provider')) return value;
  if (typeof value === 'string') return resolveEnvReference(value, env);
  if (Array.isArray(value)) {
    return value.map((item) => substituteEnvReferences(item, env, path)).filter((item) => item !== undefined);
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const resolved = substituteEnvReferences(item, env, [...path, key]);
      if (resolved !== undefined) result[key] = resolved;
    }
    return result;
  }
  return value;
}

/**
 * Builds the typed config from front matter: `$VAR` references, defaults, `~` path expansion,
 * coercion and validation. Throws `invalid_config` listing every invalid value.
 */
export function resolveConfig(front: Record<string, unknown>, options: ResolveOptions): ServiceConfig {
  const raw = substituteEnvReferences(front, options.env) as Record<string, unknown>;
  const reader = new Reader();
  const workflowPath = path.resolve(options.workflowPath);
  const workflowDir = path.dirname(workflowPath);

  for (const key of Object.keys(raw)) {
    if (key === 'codex') {
      reader.warnings.push('the codex section is ignored: this implementation runs Claude Code (configure the claude section)');
    } else if (!KNOWN_TOP_LEVEL.has(key)) {
      reader.warnings.push(`unknown top-level key ${JSON.stringify(key)} ignored`);
    }
  }

  // tracker
  const trackerRaw = reader.section(raw, 'tracker');
  const kind = reader.string(trackerRaw, 'kind', 'tracker.kind')?.trim() || null;
  let provider: Record<string, unknown> = {};
  if (trackerRaw.provider !== undefined && trackerRaw.provider !== null) {
    if (isPlainObject(trackerRaw.provider)) provider = trackerRaw.provider;
    else reader.errors.push('tracker.provider must be a map');
  }
  const defaults = kind ? options.trackerDefaults(kind) : undefined;
  const activeStates = reader.stringList(trackerRaw, 'active_states', 'tracker.active_states') ?? defaults?.activeStates ?? [];
  const terminalStates =
    reader.stringList(trackerRaw, 'terminal_states', 'tracker.terminal_states') ?? defaults?.terminalStates ?? [];
  const requiredLabels = reader.stringList(trackerRaw, 'required_labels', 'tracker.required_labels') ?? [];

  // polling
  const pollingRaw = reader.section(raw, 'polling');
  const intervalMs = reader.int(pollingRaw, 'interval_ms', 'polling.interval_ms', DEFAULTS.pollIntervalMs, 1);

  // workspace
  const workspaceRaw = reader.section(raw, 'workspace');
  const cleanupTerminal = reader.bool(workspaceRaw, 'cleanup_terminal', 'workspace.cleanup_terminal', true);
  let root = path.join(os.tmpdir(), DEFAULTS.workspaceRootName);
  const rootValue = reader.string(workspaceRaw, 'root', 'workspace.root');
  if (rootValue !== null && rootValue.trim() !== '') {
    try {
      root = resolveConfigPath(rootValue.trim(), workflowDir, options.env, 'workspace.root');
    } catch (error) {
      reader.errors.push(errorMessage(error));
    }
  }

  // hooks
  const hooksRaw = reader.section(raw, 'hooks');
  const hooks: HooksConfig = {
    afterCreate: reader.script(hooksRaw, 'after_create', 'hooks.after_create'),
    beforeRun: reader.script(hooksRaw, 'before_run', 'hooks.before_run'),
    afterRun: reader.script(hooksRaw, 'after_run', 'hooks.after_run'),
    beforeRemove: reader.script(hooksRaw, 'before_remove', 'hooks.before_remove'),
    timeoutMs: reader.int(hooksRaw, 'timeout_ms', 'hooks.timeout_ms', DEFAULTS.hookTimeoutMs, 1),
  };

  // agent
  const agentRaw = reader.section(raw, 'agent');
  const byState = new Map<string, number>();
  const byStateRaw = agentRaw.max_concurrent_agents_by_state;
  if (byStateRaw !== undefined && byStateRaw !== null) {
    if (!isPlainObject(byStateRaw)) {
      reader.warnings.push('agent.max_concurrent_agents_by_state is not a map; ignored');
    } else {
      for (const [state, limit] of Object.entries(byStateRaw)) {
        const parsed = parseInteger(limit);
        const key = normalizeStateName(state);
        if (parsed === null || parsed <= 0 || key === '') {
          reader.warnings.push(`agent.max_concurrent_agents_by_state.${state} ignored: needs a positive integer`);
        } else {
          byState.set(key, parsed);
        }
      }
    }
  }
  const agent: AgentConfig = {
    // 0 is allowed and pauses all new dispatches.
    maxConcurrentAgents: reader.int(agentRaw, 'max_concurrent_agents', 'agent.max_concurrent_agents', DEFAULTS.maxConcurrentAgents, 0),
    maxTurns: reader.int(agentRaw, 'max_turns', 'agent.max_turns', DEFAULTS.maxTurns, 1),
    maxRetryBackoffMs: reader.int(agentRaw, 'max_retry_backoff_ms', 'agent.max_retry_backoff_ms', DEFAULTS.maxRetryBackoffMs, 1),
    maxConcurrentAgentsByState: byState,
    maxContinuations:
      agentRaw.max_continuations === undefined || agentRaw.max_continuations === null
        ? null
        : reader.int(agentRaw, 'max_continuations', 'agent.max_continuations', 0, 0),
    continuationPrompt: reader.script(agentRaw, 'continuation_prompt', 'agent.continuation_prompt'),
  };

  // claude
  const claudeRaw = reader.section(raw, 'claude');
  let executable: string | null = null;
  const executableValue = reader.string(claudeRaw, 'executable', 'claude.executable');
  if (executableValue !== null && executableValue.trim() !== '') {
    try {
      executable = resolveConfigPath(executableValue.trim(), workflowDir, options.env, 'claude.executable');
    } catch (error) {
      reader.errors.push(errorMessage(error));
    }
  }
  let sandbox: Record<string, unknown> | null = null;
  if (claudeRaw.sandbox !== undefined && claudeRaw.sandbox !== null) {
    if (isPlainObject(claudeRaw.sandbox)) sandbox = claudeRaw.sandbox;
    else reader.errors.push('claude.sandbox must be a map');
  }
  const claudeEnv = reader.stringMap(claudeRaw, 'env', 'claude.env');
  const plugins: string[] = [];
  for (const entry of reader.stringList(claudeRaw, 'plugins', 'claude.plugins') ?? []) {
    if (entry.trim() === '') continue;
    try {
      plugins.push(resolveConfigPath(entry.trim(), workflowDir, options.env, 'claude.plugins'));
    } catch (error) {
      reader.errors.push(errorMessage(error));
    }
  }
  let skills: 'all' | string[] | null = null;
  if (claudeRaw.skills === 'all') skills = 'all';
  else if (claudeRaw.skills !== undefined && claudeRaw.skills !== null) {
    if (typeof claudeRaw.skills === 'string') reader.errors.push('claude.skills must be "all" or a list of skill names');
    else skills = reader.stringList(claudeRaw, 'skills', 'claude.skills');
  }
  const settingSources = reader.stringList(claudeRaw, 'setting_sources', 'claude.setting_sources') ?? ['project'];
  for (const source of settingSources) {
    if (!(SETTING_SOURCES as readonly string[]).includes(source)) {
      reader.errors.push(`claude.setting_sources entries must be one of ${SETTING_SOURCES.join(', ')} (got ${JSON.stringify(source)})`);
    }
  }
  const claude: ClaudeConfig = {
    model: reader.string(claudeRaw, 'model', 'claude.model')?.trim() || null,
    fallbackModel: reader.string(claudeRaw, 'fallback_model', 'claude.fallback_model')?.trim() || null,
    effort: reader.oneOf(claudeRaw, 'effort', 'claude.effort', EFFORT_LEVELS, null),
    permissionMode: reader.oneOf(claudeRaw, 'permission_mode', 'claude.permission_mode', PERMISSION_MODES, 'auto'),
    onPermissionRequest: reader.oneOf(claudeRaw, 'on_permission_request', 'claude.on_permission_request', ['approve', 'deny'] as const, 'deny'),
    allowedTools: reader.stringList(claudeRaw, 'allowed_tools', 'claude.allowed_tools') ?? [],
    disallowedTools: reader.stringList(claudeRaw, 'disallowed_tools', 'claude.disallowed_tools') ?? [],
    settingSources: settingSources as SettingSource[],
    strictMcpConfig: reader.bool(claudeRaw, 'strict_mcp_config', 'claude.strict_mcp_config', true),
    sandbox,
    executable,
    appendSystemPrompt: reader.script(claudeRaw, 'append_system_prompt', 'claude.append_system_prompt'),
    maxBudgetUsd: reader.number(claudeRaw, 'max_budget_usd', 'claude.max_budget_usd'),
    persistSession: reader.bool(claudeRaw, 'persist_session', 'claude.persist_session', true),
    env: claudeEnv,
    turnTimeoutMs: reader.int(claudeRaw, 'turn_timeout_ms', 'claude.turn_timeout_ms', DEFAULTS.turnTimeoutMs, 1),
    readTimeoutMs: reader.int(claudeRaw, 'read_timeout_ms', 'claude.read_timeout_ms', DEFAULTS.readTimeoutMs, 1),
    // <= 0 disables stall detection.
    stallTimeoutMs: reader.int(claudeRaw, 'stall_timeout_ms', 'claude.stall_timeout_ms', DEFAULTS.stallTimeoutMs, Number.MIN_SAFE_INTEGER),
    plugins,
    skills,
  };

  // laravel
  const laravelRaw = reader.section(raw, 'laravel');
  const command = (key: 'php' | 'composer'): string => {
    const value = reader.string(laravelRaw, key, `laravel.${key}`)?.trim() || key;
    // Bare names stay PATH lookups; only path-like values are resolved against the workflow directory.
    if (!value.includes('/') && !value.startsWith('~')) return value;
    try {
      return resolveConfigPath(value, workflowDir, options.env, `laravel.${key}`);
    } catch (error) {
      reader.errors.push(errorMessage(error));
      return key;
    }
  };
  const laravel: LaravelConfig = {
    boost: reader.oneOf(laravelRaw, 'boost', 'laravel.boost', BOOST_MODES, 'auto'),
    php: command('php'),
    composer: command('composer'),
    installDependencies: reader.bool(laravelRaw, 'install_dependencies', 'laravel.install_dependencies', true),
    timeoutMs: reader.int(laravelRaw, 'timeout_ms', 'laravel.timeout_ms', hooks.timeoutMs, 1),
    env: { ...LARAVEL_DEFAULT_ENV, ...reader.stringMap(laravelRaw, 'env', 'laravel.env') },
  };

  // roles
  const roles = readRoles(reader, raw, activeStates);
  if (roles !== null && agent.maxContinuations === null) {
    reader.warnings.push(
      'roles is set while agent.max_continuations is unlimited: role switches count as continuations, so set a limit',
    );
  }

  // server (HTTP extension)
  const serverRaw = reader.section(raw, 'server');
  const portValue = serverRaw.port;
  const server: ServerConfig = {
    port: portValue === undefined || portValue === null ? null : reader.int(serverRaw, 'port', 'server.port', 0, 0),
    host: reader.string(serverRaw, 'host', 'server.host')?.trim() || DEFAULTS.serverHost,
  };
  if (server.port !== null && server.port > 65_535) reader.errors.push('server.port must be <= 65535');

  if (reader.errors.length > 0) {
    throw new SymphonyError('invalid_config', reader.errors.join('; '));
  }

  return {
    workflowPath,
    workflowDir,
    tracker: { kind, provider, requiredLabels, activeStates, terminalStates },
    polling: { intervalMs },
    workspace: { root, cleanupTerminal },
    hooks,
    agent,
    claude,
    laravel,
    roles,
    server,
    warnings: reader.warnings,
  };
}
