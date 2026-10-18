import os from 'node:os';
import path from 'node:path';
import type { EffortLevel, PermissionMode, SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { bareModelName, modelForLabelValue } from '../agent/model-name.ts';
import { defaultIntegrations } from '../integrations/registry.ts';
import type { WorkspaceIntegration } from '../integrations/types.ts';
import { resolveEnvReference } from '../util/env.ts';
import { SymphonyError, errorMessage } from '../util/errors.ts';
import { resolveConfigPath } from '../util/paths.ts';
import { COMPLEXITIES, ISSUE_TYPES, type IssueComplexity } from './classify.ts';
import { COMMAND_NAME } from './command.ts';
import { globProblem } from './glob.ts';
import { isPlainObject } from './loader.ts';
import { DEFAULT_PROFILE, type WorkflowProfile } from './profile.ts';
import { Reader, parseInteger } from './reader.ts';
import { NEXT_STAGE, resultTargets, type ModelLabelPolicy, type RoleClaudeOverrides, type RoleConfig } from './roles.ts';
import { AGENT_RESULT_KINDS, isLoopKind, LOOP_VERDICTS, RESULT_VERDICTS, type AgentResultKind } from './results.ts';

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

/** Deterministic entry checks (the `checks` section): bash scripts run before an issue enters a gated column. */
export interface ChecksConfig {
  timeoutMs: number;
  retries: number;
  /** Keys are normalized column names (trimmed, lowercase); values are bash scripts. */
  onEnter: ReadonlyMap<string, string>;
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
  /**
   * Cost cap in USD for one issue across all its stages (runs of every role, from the repository history, plus the
   * running run). When reached, the next session does not start and the issue is paused. null = unlimited.
   */
  maxIssueCostUsd: number | null;
  /** Retries per issue after the first session-limit failure before waiting for the reset; 0 = wait right away. */
  maxSessionLimitRetries: number;
  /** How long a model limit without a known reset holds its model (no session of that model starts meanwhile). */
  modelHoldMs: number;
  /** Keys are normalized state names (trimmed, lowercase). */
  maxConcurrentAgentsByState: ReadonlyMap<string, number>;
  /**
   * Slots kept free for a role (`roles` names) while it runs fewer sessions than reserved; only positive counts of
   * configured roles. Ignored while their sum exceeds `maxConcurrentAgents` (see `activeReservations`).
   */
  reservedSlotsByRole: ReadonlyMap<string, number>;
  /** Liquid template for continuation turns; null uses the built-in text. */
  continuationPrompt: string | null;
}

export type PermissionRequestPolicy = 'approve' | 'deny';

/** Permission settings a model may override (`claude.by_model.<model>`), e.g. for a model without auto mode. */
export type ModelClaudeOverrides = Partial<Pick<ClaudeConfig, 'permissionMode' | 'onPermissionRequest' | 'allowedTools' | 'disallowedTools'>>;

/** Claude Code session settings (the `claude` front matter section, replacing the spec's `codex`). */
export interface ClaudeConfig {
  model: string | null;
  fallbackModel: string | null;
  effort: EffortLevel | null;
  permissionMode: PermissionMode;
  onPermissionRequest: PermissionRequestPolicy;
  allowedTools: string[];
  disallowedTools: string[];
  /** Permission overrides per model family or version; keys are bare model names ("haiku", "haiku-4-5"). */
  byModel: ReadonlyMap<string, ModelClaudeOverrides>;
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

/** When the analysis stage runs: see `PipelineConfig.analysis`. */
export type AnalysisPolicy = 'always' | 'when_unlabeled';
export const ANALYSIS_POLICIES: readonly AnalysisPolicy[] = ['always', 'when_unlabeled'];

/** The `pipeline` section: limits and classification shared by the result-driven roles. */
export interface PipelineConfig {
  /** Review rounds (review → changes needed → fix) before the issue is handed to a human. */
  maxReviewRounds: number;
  /** Test rounds (test failed → fix) before the issue is handed to a human. */
  maxTestRounds: number;
  /** Security rounds (security review found issues → fix) before the issue is handed to a human. */
  maxSecurityRounds: number;
  /** Label put on an issue that hit a round limit. */
  limitLabel: string;
  /** Issue label (normalized: trimmed, lowercase) → change type. */
  typeLabels: ReadonlyMap<string, string>;
  /** Type of an issue without a label in `typeLabels`. */
  defaultType: string;
  /**
   * Whether the analysis stage (the role whose `result` is `analysis`) runs for every issue (`always`) or only for
   * issues without a `Type:` or without a `Complexity:` label (`when_unlabeled`); a labelled issue passes it without
   * a session (see `stageSkip`).
   */
  analysis: AnalysisPolicy;
  /**
   * Workflow profiles by name: an issue type (`bugfix`, `feature`, `refactor`) or `default` (see `profileFor`). Each
   * skips stages and overrides transitions for issues of that type.
   */
  profiles: ReadonlyMap<string, WorkflowProfile>;
  /**
   * Path globs (see `glob.ts`) that mark test, documentation and security-relevant files. `testPaths` is all a role with
   * `result: test` may change (`report_result` refuses a result otherwise). A changed file matching `securityPaths` sends
   * the reviewer's approval to the security review (a role with `result: security`); `[]` turns that trigger off.
   * `docsPaths` is used by a later pipeline stage.
   */
  testPaths: string[];
  docsPaths: string[];
  securityPaths: string[];
}

export interface ServerConfig {
  port: number | null;
  host: string;
  /** Allow restarting workers (POST /api/v1/<identifier>/retry) on a non-loopback bind. */
  allowRemoteControl: boolean;
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
  checks: ChecksConfig;
  agent: AgentConfig;
  claude: ClaudeConfig;
  /** Resolved config of each workspace integration, keyed by integration id (e.g. `laravel`). */
  integrations: Readonly<Record<string, unknown>>;
  /** Column-scoped roles; null without a `roles` section (one implicit `default` role). */
  roles: RoleConfig[] | null;
  pipeline: PipelineConfig;
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
  /** Workspace integrations whose front matter sections are resolved too; defaults to the registry. */
  integrations?: readonly WorkspaceIntegration[];
}

export const DEFAULTS = {
  pollIntervalMs: 30_000,
  hookTimeoutMs: 60_000,
  maxConcurrentAgents: 10,
  maxTurns: 20,
  maxRetryBackoffMs: 300_000,
  maxSessionLimitRetries: 3,
  modelHoldMs: 3_600_000,
  turnTimeoutMs: 3_600_000,
  readTimeoutMs: 30_000,
  stallTimeoutMs: 300_000,
  maxReviewRounds: 3,
  maxTestRounds: 2,
  maxSecurityRounds: 2,
  /** `pipeline.test_paths` when unset: the usual places of test files (Laravel, Node, Jest/Vitest). */
  testPaths: ['tests/**', 'test/**', '**/*.test.*', '**/*Test.php'],
  /** `pipeline.security_paths` when unset: the places of a Laravel app where authorization, authentication and the schema live. */
  securityPaths: ['app/Policies/**', 'app/Http/Middleware/**', 'config/auth.php', 'routes/**', 'database/migrations/**'],
  pipelineLimitLabel: 'needs-human',
  pipelineDefaultType: 'feature',
  /** Column for a session that ends without the result its role has to report. */
  onMissingResult: 'Blocked',
  serverHost: '127.0.0.1',
  workspaceRootName: 'symphony_workspaces',
} as const;

const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'];
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const SETTING_SOURCES: readonly SettingSource[] = ['user', 'project', 'local'];
const CORE_TOP_LEVEL: readonly string[] = ['tracker', 'polling', 'workspace', 'hooks', 'checks', 'agent', 'claude', 'roles', 'pipeline', 'server'];
const ROLE_KEYS = new Set([
  'states',
  'read_only',
  'may_move_to',
  'result',
  'on_result',
  'on_check_failed',
  'on_missing_result',
  'on_round_limit',
  'model_label',
  'max_turns',
  'commands',
  'run_checks',
  'max_sub_issues',
  'sub_issue_status',
  'wait_for_sub_issues',
  'agents',
  'claude',
]);
/** GitHub allows 100 sub-issues per issue. */
const MAX_SUB_ISSUES_LIMIT = 100;
const PIPELINE_KEYS = new Set([
  'profiles',
  'max_review_rounds',
  'max_test_rounds',
  'max_security_rounds',
  'limit_label',
  'type_labels',
  'default_type',
  'analysis',
  'test_paths',
  'docs_paths',
  'security_paths',
]);
const PROFILE_KEYS = new Set(['skip', 'skip_when', 'on_result', 'max_review_rounds', 'max_test_rounds']);
const ROLE_CLAUDE_KEYS = new Set(['model', 'effort', 'allowed_tools', 'disallowed_tools', 'append_system_prompt', 'max_budget_usd', 'model_by_complexity']);
const MODEL_CLAUDE_KEYS = new Set(['permission_mode', 'on_permission_request', 'allowed_tools', 'disallowed_tools']);

export function normalizeStateName(state: string): string {
  return state.trim().toLowerCase();
}

function readRoles(reader: Reader, raw: Record<string, unknown>, activeStates: string[], terminalStates: string[]): RoleConfig[] | null {
  if (raw.roles === undefined || raw.roles === null) return null;
  if (!isPlainObject(raw.roles)) {
    reader.errors.push('roles must be a map');
    return null;
  }
  const roles: RoleConfig[] = [];
  /** Who serves a (command, state) pair; the command is '' for roles without commands. */
  const owners = new Map<string, string>();
  /** States served by roles without commands: these must cover every active state. */
  const plainStates = new Set<string>();
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
    const commands = readRoleCommands(reader, value, field);
    const states: string[] = [];
    const statesValue = reader.stringList(value, 'states', `${field}.states`);
    if (statesValue === null && value.states === undefined) reader.errors.push(`${field}.states is required`);
    for (const state of statesValue ?? []) {
      const key = normalizeStateName(state);
      if (key === '' || states.includes(key)) continue;
      states.push(key);
      if (!active.has(key)) reader.errors.push(`${field}.states: ${JSON.stringify(state)} is not in tracker.active_states`);
      if (commands === null) plainStates.add(key);
      for (const command of commands ?? ['']) {
        const owner = owners.get(`${command}\u0000${key}`);
        if (owner !== undefined) {
          const scope = command === '' ? '' : ` for /${command}`;
          reader.errors.push(`state ${JSON.stringify(state)} belongs to more than one role${scope} (${owner}, ${name})`);
        } else {
          owners.set(`${command}\u0000${key}`, name);
        }
      }
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
    const maxSubIssues = readMaxSubIssues(reader, value, field);
    const subIssueStatus = reader.string(value, 'sub_issue_status', `${field}.sub_issue_status`)?.trim() || null;
    if (subIssueStatus !== null) {
      if (maxSubIssues === null) reader.errors.push(`${field}.sub_issue_status needs ${field}.max_sub_issues (only then the role creates sub-issues)`);
      if (terminalStates.some((state) => normalizeStateName(state) === normalizeStateName(subIssueStatus))) {
        reader.errors.push(`${field}.sub_issue_status must not be a terminal state (got ${JSON.stringify(subIssueStatus)})`);
      }
    }
    const readOnly = reader.bool(value, 'read_only', `${field}.read_only`, false);
    const transitions = readRoleTransitions(reader, value, field, terminalStates);
    roles.push({
      name,
      states,
      readOnly,
      mayMoveTo: mergeTargets(mayMoveTo, transitions),
      ...transitions,
      modelLabel: reader.oneOf<ModelLabelPolicy>(value, 'model_label', `${field}.model_label`, ['apply', 'ignore'], readOnly && transitions.result !== null ? 'ignore' : 'apply'),
      maxTurns:
        maxTurnsValue === undefined || maxTurnsValue === null
          ? null
          : reader.int(value, 'max_turns', `${field}.max_turns`, 0, 1) || null,
      commands,
      runChecks: reader.bool(value, 'run_checks', `${field}.run_checks`, true),
      maxSubIssues,
      subIssueStatus,
      waitForSubIssues: reader.bool(value, 'wait_for_sub_issues', `${field}.wait_for_sub_issues`, false),
      agents: readRoleAgents(reader, value, field),
      claude,
    });
  }
  for (const state of activeStates) {
    if (!plainStates.has(normalizeStateName(state))) reader.errors.push(`active state ${JSON.stringify(state)} has no role`);
  }
  return roles;
}

type RoleTransitions = Pick<RoleConfig, 'result' | 'onResult' | 'onCheckFailed' | 'onMissingResult' | 'onRoundLimit'>;

/**
 * `result`, `on_result`, `on_check_failed`, `on_missing_result` and `on_round_limit` of a role. Verdicts must belong to
 * the result kind and no target may be a terminal column; `on_missing_result` defaults to `Blocked` once the role has a
 * `result`; `on_round_limit` needs a result kind with a round limit (`review`, `test`, `security`).
 */
function readRoleTransitions(reader: Reader, raw: Record<string, unknown>, field: string, terminalStates: string[]): RoleTransitions {
  const result = reader.oneOf<AgentResultKind>(raw, 'result', `${field}.result`, AGENT_RESULT_KINDS, null);
  const terminal = new Set(terminalStates.map(normalizeStateName));
  /** A column name, trimmed; null (with an error) when empty, terminal or `next` where only a column is allowed. */
  const column = (value: string, path: string, allowNext: boolean): string | null => {
    const name = value.trim();
    if (name === '') reader.errors.push(`${path} must not be empty`);
    else if (name.toLowerCase() === NEXT_STAGE) {
      if (allowNext) return NEXT_STAGE;
      reader.errors.push(`${path} must be a column name (${NEXT_STAGE} is only for on_result)`);
    } else if (terminal.has(normalizeStateName(name))) reader.errors.push(`${path} must not be a terminal state (got ${JSON.stringify(name)})`);
    else return name;
    return null;
  };

  const onResult: Record<string, string> = {};
  const onResultRaw = raw.on_result;
  if (onResultRaw !== undefined && onResultRaw !== null) {
    if (!isPlainObject(onResultRaw)) {
      reader.errors.push(`${field}.on_result must be a map of verdicts to columns`);
    } else {
      if (result === null) reader.errors.push(`${field}.on_result needs ${field}.result (the kind whose verdicts it maps)`);
      const verdicts: readonly string[] = result === null ? [] : RESULT_VERDICTS[result];
      for (const [verdict, value] of Object.entries(onResultRaw)) {
        const path = `${field}.on_result.${verdict}`;
        if (result !== null && !verdicts.includes(verdict)) {
          reader.errors.push(`${path}: ${JSON.stringify(verdict)} is not a verdict of result ${result} (allowed: ${verdicts.join(', ')})`);
        } else if (typeof value !== 'string') {
          reader.errors.push(`${path} must be a column name or ${NEXT_STAGE}`);
        } else {
          const target = column(value, path, true);
          if (target !== null) onResult[verdict] = target;
        }
      }
    }
  }
  const optionalColumn = (key: string): string | null => {
    const value = reader.string(raw, key, `${field}.${key}`);
    return value === null ? null : column(value, `${field}.${key}`, false);
  };
  const onCheckFailed = optionalColumn('on_check_failed');
  const onMissingResult = optionalColumn('on_missing_result');
  if (onMissingResult !== null && result === null) reader.errors.push(`${field}.on_missing_result needs ${field}.result`);
  const onRoundLimit = optionalColumn('on_round_limit');
  if (onRoundLimit !== null && !isLoopKind(result)) {
    reader.errors.push(`${field}.on_round_limit needs ${field}.result ${Object.keys(LOOP_VERDICTS).join(' or ')} (the kinds with a round limit)`);
  }
  return {
    result,
    onResult,
    onCheckFailed,
    onMissingResult: result === null ? null : (onMissingResult ?? DEFAULTS.onMissingResult),
    onRoundLimit: isLoopKind(result) ? onRoundLimit : null,
  };
}

/**
 * `may_move_to` plus the columns the result-driven transitions name, so the guard, the board check and the pipeline
 * view see them. A role without `may_move_to` stays unrestricted (null): the targets only extend a list.
 */
function mergeTargets(mayMoveTo: string[] | null, transitions: RoleTransitions): string[] | null {
  if (mayMoveTo === null) return null;
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const entry of [...mayMoveTo, ...resultTargets(transitions)]) {
    const column = entry.trim();
    if (column === '' || seen.has(normalizeStateName(column))) continue;
    seen.add(normalizeStateName(column));
    merged.push(column);
  }
  return merged;
}

/** The `pipeline` section; every key is optional. Unknown keys are ignored with a warning. */
function readPipeline(reader: Reader, raw: Record<string, unknown>, roles: RoleConfig[] | null, terminalStates: string[]): PipelineConfig {
  const section = reader.section(raw, 'pipeline');
  for (const key of Object.keys(section)) {
    if (!PIPELINE_KEYS.has(key)) reader.warnings.push(`unknown key pipeline.${key} ignored (known: ${[...PIPELINE_KEYS].join(', ')})`);
  }
  const typeLabels = new Map<string, string>();
  const typeLabelsRaw = section.type_labels;
  if (typeLabelsRaw !== undefined && typeLabelsRaw !== null) {
    if (!isPlainObject(typeLabelsRaw)) {
      reader.errors.push('pipeline.type_labels must be a map of labels to types');
    } else {
      for (const [label, type] of Object.entries(typeLabelsRaw)) {
        const key = label.trim().toLowerCase();
        if (typeof type !== 'string' || type.trim() === '') reader.errors.push(`pipeline.type_labels.${label} must be a non-empty string`);
        else if (key === '') reader.errors.push('pipeline.type_labels labels must not be empty');
        else typeLabels.set(key, type.trim());
      }
    }
  }
  const nonEmpty = (key: string, fallback: string): string => {
    const value = reader.string(section, key, `pipeline.${key}`)?.trim();
    if (value === '') reader.errors.push(`pipeline.${key} must not be empty`);
    return value || fallback;
  };
  /** A list of path globs: unset = `fallback`, an explicit list is used as it is (an empty one allows no path). */
  const globs = (key: 'test_paths' | 'docs_paths' | 'security_paths', fallback: readonly string[]): string[] => {
    const list = reader.stringList(section, key, `pipeline.${key}`);
    if (list === null) return [...fallback];
    list.forEach((glob, index) => {
      const problem = globProblem(glob);
      if (problem !== null) reader.errors.push(`pipeline.${key}[${index}] ${JSON.stringify(glob)} ${problem}`);
    });
    return list.map((glob) => glob.trim());
  };
  const analysis = reader.oneOf(section, 'analysis', 'pipeline.analysis', ANALYSIS_POLICIES, 'always');
  if (analysis === 'when_unlabeled' && !(roles ?? []).some((role) => role.result === 'analysis')) {
    reader.errors.push('pipeline.analysis: when_unlabeled needs a role with `result: analysis`');
  }
  return {
    maxReviewRounds: reader.int(section, 'max_review_rounds', 'pipeline.max_review_rounds', DEFAULTS.maxReviewRounds, 1),
    maxTestRounds: reader.int(section, 'max_test_rounds', 'pipeline.max_test_rounds', DEFAULTS.maxTestRounds, 1),
    maxSecurityRounds: reader.int(section, 'max_security_rounds', 'pipeline.max_security_rounds', DEFAULTS.maxSecurityRounds, 1),
    limitLabel: nonEmpty('limit_label', DEFAULTS.pipelineLimitLabel),
    typeLabels,
    defaultType: nonEmpty('default_type', DEFAULTS.pipelineDefaultType),
    analysis,
    profiles: readProfiles(reader, section.profiles, roles, terminalStates),
    testPaths: globs('test_paths', DEFAULTS.testPaths),
    docsPaths: globs('docs_paths', []),
    securityPaths: globs('security_paths', DEFAULTS.securityPaths),
  };
}

/**
 * `pipeline.profiles`: a map of issue type (or `default`) to `{skip, skip_when, on_result, max_review_rounds,
 * max_test_rounds}`. `skip` lists role names; `skip_when` skips a role's stage only for some issues (see
 * {@link readSkipWhen}); `on_result` maps a role name and verdict of its result kind to a column or `next`: never a
 * terminal column, and one in the role's `may_move_to` when it sets one.
 */
function readProfiles(reader: Reader, raw: unknown, roles: RoleConfig[] | null, terminalStates: string[]): ReadonlyMap<string, WorkflowProfile> {
  const profiles = new Map<string, WorkflowProfile>();
  if (raw === undefined || raw === null) return profiles;
  if (!isPlainObject(raw)) {
    reader.errors.push('pipeline.profiles must be a map of issue types to profiles');
    return profiles;
  }
  const terminal = new Set(terminalStates.map(normalizeStateName));
  const known = roles === null ? 'none: set roles' : roles.map((role) => role.name).join(', ') || 'none';
  const names: readonly string[] = [...ISSUE_TYPES, DEFAULT_PROFILE];
  for (const [name, value] of Object.entries(raw)) {
    const field = `pipeline.profiles.${name}`;
    if (!names.includes(name)) {
      reader.errors.push(`${field}: unknown profile (allowed: ${names.join(', ')})`);
      continue;
    }
    if (!isPlainObject(value)) {
      reader.errors.push(`${field} must be a map`);
      continue;
    }
    for (const key of Object.keys(value)) {
      if (!PROFILE_KEYS.has(key)) reader.errors.push(`${field}.${key}: unknown key (allowed: ${[...PROFILE_KEYS].join(', ')})`);
    }
    const skip: string[] = [];
    for (const entry of reader.stringList(value, 'skip', `${field}.skip`) ?? []) {
      const role = entry.trim();
      if (roles?.some((candidate) => candidate.name === role) !== true) {
        reader.errors.push(`${field}.skip: unknown role ${JSON.stringify(entry)} (roles: ${known})`);
      } else if (!skip.includes(role)) {
        skip.push(role);
      }
    }
    const skipWhen = readSkipWhen(reader, value.skip_when, `${field}.skip_when`, roles, known);
    const onResult: Record<string, Record<string, string>> = {};
    const onResultRaw = value.on_result;
    if (onResultRaw !== undefined && onResultRaw !== null) {
      if (!isPlainObject(onResultRaw)) {
        reader.errors.push(`${field}.on_result must be a map of roles to verdicts`);
      } else {
        for (const [roleKey, verdictsRaw] of Object.entries(onResultRaw)) {
          const path = `${field}.on_result.${roleKey}`;
          const role = roles?.find((candidate) => candidate.name === roleKey.trim());
          if (role === undefined) {
            reader.errors.push(`${path}: unknown role (roles: ${known})`);
          } else if (role.result === null) {
            reader.errors.push(`${path}: role ${role.name} reports no result (roles.${role.name}.result is not set)`);
          } else if (!isPlainObject(verdictsRaw)) {
            reader.errors.push(`${path} must be a map of verdicts to columns`);
          } else {
            const verdicts: readonly string[] = RESULT_VERDICTS[role.result];
            const targets: Record<string, string> = {};
            for (const [verdict, target] of Object.entries(verdictsRaw)) {
              const targetPath = `${path}.${verdict}`;
              const column = typeof target === 'string' ? target.trim() : null;
              if (!verdicts.includes(verdict)) {
                reader.errors.push(`${targetPath}: ${JSON.stringify(verdict)} is not a verdict of result ${role.result} (allowed: ${verdicts.join(', ')})`);
              } else if (column === null) {
                reader.errors.push(`${targetPath} must be a column name or ${NEXT_STAGE}`);
              } else if (column === '') {
                reader.errors.push(`${targetPath} must not be empty`);
              } else if (column.toLowerCase() === NEXT_STAGE) {
                targets[verdict] = NEXT_STAGE;
              } else if (terminal.has(normalizeStateName(column))) {
                reader.errors.push(`${targetPath} must not be a terminal state (got ${JSON.stringify(column)})`);
              } else if (role.mayMoveTo !== null && !role.mayMoveTo.some((allowed) => normalizeStateName(allowed) === normalizeStateName(column))) {
                reader.errors.push(`${targetPath}: "${column}" is not in roles.${role.name}.may_move_to (add it there)`);
              } else {
                targets[verdict] = column;
              }
            }
            onResult[role.name] = targets;
          }
        }
      }
    }
    const rounds = (key: 'max_review_rounds' | 'max_test_rounds'): number | null =>
      value[key] === undefined || value[key] === null ? null : reader.int(value, key, `${field}.${key}`, 1, 1);
    profiles.set(name, { name, skip, skipWhen, onResult, maxReviewRounds: rounds('max_review_rounds'), maxTestRounds: rounds('max_test_rounds') });
  }
  return profiles;
}

/**
 * `skip_when` of a profile: a map of role name to a condition. The vocabulary is fixed: the only key is `complexity`,
 * a list of `S`, `M`, `L`, `XL`; the role's stage is skipped for issues with one of these complexities. An issue
 * without a usable `Complexity:` label never matches. Unknown roles, keys and values are errors.
 */
function readSkipWhen(reader: Reader, raw: unknown, field: string, roles: RoleConfig[] | null, known: string): Record<string, readonly IssueComplexity[]> {
  const skipWhen: Record<string, readonly IssueComplexity[]> = {};
  if (raw === undefined || raw === null) return skipWhen;
  if (!isPlainObject(raw)) {
    reader.errors.push(`${field} must be a map of roles to conditions`);
    return skipWhen;
  }
  for (const [roleKey, condition] of Object.entries(raw)) {
    const path = `${field}.${roleKey}`;
    const role = roles?.find((candidate) => candidate.name === roleKey.trim());
    if (role === undefined) {
      reader.errors.push(`${path}: unknown role (roles: ${known})`);
      continue;
    }
    if (!isPlainObject(condition)) {
      reader.errors.push(`${path} must be a map (allowed key: complexity)`);
      continue;
    }
    for (const key of Object.keys(condition)) {
      if (key !== 'complexity') reader.errors.push(`${path}.${key}: unknown condition (allowed: complexity)`);
    }
    const values = reader.stringList(condition, 'complexity', `${path}.complexity`);
    if (values === null || values.length === 0) {
      if (values !== null || condition.complexity === undefined || condition.complexity === null) {
        reader.errors.push(`${path}.complexity must list at least one of ${COMPLEXITIES.join(', ')}`);
      }
      continue;
    }
    const complexities: IssueComplexity[] = [];
    for (const entry of values) {
      const complexity = entry.trim().toUpperCase() as IssueComplexity;
      if (!COMPLEXITIES.includes(complexity)) reader.errors.push(`${path}.complexity: unknown value ${JSON.stringify(entry)} (allowed: ${COMPLEXITIES.join(', ')})`);
      else if (!complexities.includes(complexity)) complexities.push(complexity);
    }
    if (complexities.length > 0) skipWhen[role.name] = complexities;
  }
  return skipWhen;
}

/** `commands` of a role: null when omitted; each entry is a skill-style name without the leading slash. */
function readRoleCommands(reader: Reader, raw: Record<string, unknown>, field: string): string[] | null {
  const list = reader.stringList(raw, 'commands', `${field}.commands`);
  if (list === null) return null;
  const commands: string[] = [];
  for (const entry of list) {
    const command = entry.trim().replace(/^\//, '').toLowerCase();
    if (!COMMAND_NAME.test(command)) reader.errors.push(`${field}.commands: ${JSON.stringify(entry)} is not a command name (lowercase letters, digits and dashes)`);
    else if (!commands.includes(command)) commands.push(command);
  }
  if (list.length === 0) reader.errors.push(`${field}.commands must list at least one command`);
  return commands;
}

/** `agents` of a role: null when omitted (every plugin agent); `[]` allows none. Names come without the plugin prefix. */
function readRoleAgents(reader: Reader, raw: Record<string, unknown>, field: string): string[] | null {
  const list = reader.stringList(raw, 'agents', `${field}.agents`);
  if (list === null) return null;
  const agents: string[] = [];
  for (const entry of list) {
    const name = entry.trim();
    if (!COMMAND_NAME.test(name)) reader.errors.push(`${field}.agents: ${JSON.stringify(entry)} is not an agent name (lowercase letters, digits and dashes, without the plugin prefix)`);
    else if (!agents.includes(name)) agents.push(name);
  }
  return agents;
}

function readMaxSubIssues(reader: Reader, raw: Record<string, unknown>, field: string): number | null {
  if (raw.max_sub_issues === undefined || raw.max_sub_issues === null) return null;
  const value = reader.int(raw, 'max_sub_issues', `${field}.max_sub_issues`, 0, 1);
  if (value > MAX_SUB_ISSUES_LIMIT) {
    reader.errors.push(`${field}.max_sub_issues must be at most ${MAX_SUB_ISSUES_LIMIT} (got ${value})`);
    return null;
  }
  return value || null;
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
  const modelByComplexityRaw = raw.model_by_complexity;
  if (modelByComplexityRaw !== undefined && modelByComplexityRaw !== null) {
    if (isPlainObject(modelByComplexityRaw)) {
      const modelByComplexity: Partial<Record<'S' | 'M' | 'L' | 'XL', string | null>> = {};
      for (const [level, value] of Object.entries(modelByComplexityRaw)) {
        const levelPath = `${field}.model_by_complexity.${level}`;
        if (!['S', 'M', 'L', 'XL'].includes(level)) {
          reader.errors.push(`${levelPath}: ${JSON.stringify(level)} is not a valid complexity level (S, M, L, XL)`);
          continue;
        }
        if (value === null) {
          modelByComplexity[level as 'S' | 'M' | 'L' | 'XL'] = null;
        } else {
          const modelValue = reader.string({ [level]: value }, level, levelPath);
          if (modelValue === null || modelValue.trim() === '') {
            reader.errors.push(`${levelPath} must not be empty`);
            continue;
          }
          const validModel = modelForLabelValue(modelValue);
          if (validModel === null) {
            reader.errors.push(`${levelPath}: ${JSON.stringify(modelValue)} is not a valid model name`);
            continue;
          }
          modelByComplexity[level as 'S' | 'M' | 'L' | 'XL'] = validModel;
        }
      }
      if (Object.keys(modelByComplexity).length > 0) claude.modelByComplexity = modelByComplexity;
    } else {
      reader.errors.push(`${field}.model_by_complexity must be a map of complexity levels to model names`);
    }
  }
  return claude;
}

/**
 * `claude.by_model`: permission overrides per model. A key names a model like the `Model:` issue labels do ("haiku",
 * "haiku-4-5", "claude-haiku-4-5") and is stored without the "claude-" prefix.
 */
function readByModel(reader: Reader, claudeRaw: Record<string, unknown>): Map<string, ModelClaudeOverrides> {
  const byModel = new Map<string, ModelClaudeOverrides>();
  const raw = claudeRaw.by_model;
  if (raw === undefined || raw === null) return byModel;
  if (!isPlainObject(raw)) {
    reader.errors.push('claude.by_model must be a map of model names to settings');
    return byModel;
  }
  for (const [name, value] of Object.entries(raw)) {
    const field = `claude.by_model.${name}`;
    const model = modelForLabelValue(name);
    if (model === null) {
      reader.errors.push(`${field}: ${JSON.stringify(name)} is not a model name (e.g. haiku, sonnet-5-5, claude-opus-5-5)`);
      continue;
    }
    if (!isPlainObject(value)) {
      reader.errors.push(`${field} must be a map`);
      continue;
    }
    for (const key of Object.keys(value)) {
      if (!MODEL_CLAUDE_KEYS.has(key)) reader.errors.push(`${field}.${key} is not a known key (allowed: ${[...MODEL_CLAUDE_KEYS].join(', ')})`);
    }
    const key = bareModelName(model);
    if (byModel.has(key)) {
      reader.errors.push(`${field} names the same model as another claude.by_model entry (${key})`);
      continue;
    }
    const overrides: ModelClaudeOverrides = {};
    const permissionMode = reader.oneOf(value, 'permission_mode', `${field}.permission_mode`, PERMISSION_MODES, null);
    if (permissionMode !== null) overrides.permissionMode = permissionMode;
    const onPermissionRequest = reader.oneOf(value, 'on_permission_request', `${field}.on_permission_request`, ['approve', 'deny'] as const, null);
    if (onPermissionRequest !== null) overrides.onPermissionRequest = onPermissionRequest;
    const allowedTools = reader.stringList(value, 'allowed_tools', `${field}.allowed_tools`);
    if (allowedTools !== null) overrides.allowedTools = allowedTools;
    const disallowedTools = reader.stringList(value, 'disallowed_tools', `${field}.disallowed_tools`);
    if (disallowedTools !== null) overrides.disallowedTools = disallowedTools;
    byModel.set(key, overrides);
  }
  return byModel;
}

/**
 * Replaces whole-value `$NAME` references (strings and list items) with environment values;
 * unset or empty variables make the setting count as omitted. Hooks and check scripts (`checks.on_enter`, shell code)
 * and `tracker.provider` (resolved by the adapter, which must know secret variable names) are left alone.
 */
export function substituteEnvReferences(value: unknown, env: NodeJS.ProcessEnv, path: string[] = []): unknown {
  if (path[0] === 'hooks' || (path[0] === 'checks' && path[1] === 'on_enter') || (path[0] === 'tracker' && path[1] === 'provider')) {
    return value;
  }
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
  const integrationList = options.integrations ?? defaultIntegrations();
  const knownTopLevel = new Set([...CORE_TOP_LEVEL, ...integrationList.map((integration) => integration.configKey)]);

  for (const key of Object.keys(raw)) {
    if (key === 'codex') {
      reader.warnings.push('the codex section is ignored: this implementation runs Claude Code (configure the claude section)');
    } else if (!knownTopLevel.has(key)) {
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

  // checks
  const checksRaw = reader.section(raw, 'checks');
  const onEnter = new Map<string, string>();
  const onEnterRaw = checksRaw.on_enter;
  if (onEnterRaw !== undefined && onEnterRaw !== null) {
    if (!isPlainObject(onEnterRaw)) {
      reader.errors.push('checks.on_enter must be a map of column names to scripts');
    } else {
      for (const [column, script] of Object.entries(onEnterRaw)) {
        const key = normalizeStateName(column);
        if (typeof script !== 'string') reader.errors.push(`checks.on_enter.${column} must be a string`);
        else if (key === '') reader.errors.push('checks.on_enter column names must not be empty');
        else if (script.trim() !== '') onEnter.set(key, script);
      }
    }
  }
  const checks: ChecksConfig = {
    timeoutMs: reader.int(checksRaw, 'timeout_ms', 'checks.timeout_ms', hooks.timeoutMs, 1),
    retries: reader.int(checksRaw, 'retries', 'checks.retries', 0, 0),
    onEnter,
  };
  if (checks.retries > 3) reader.errors.push(`checks.retries must be between 0 and 3 (got ${checks.retries})`);

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
  const reserved = new Map<string, number>();
  const reservedRaw = agentRaw.reserved_slots_by_role;
  if (reservedRaw !== undefined && reservedRaw !== null) {
    if (!isPlainObject(reservedRaw)) {
      reader.warnings.push('agent.reserved_slots_by_role is not a map; ignored');
    } else {
      for (const [role, count] of Object.entries(reservedRaw)) {
        const parsed = parseInteger(count);
        if (parsed === null || parsed < 0) reader.warnings.push(`agent.reserved_slots_by_role.${role} ignored: needs an integer of 0 or more`);
        else if (parsed > 0) reserved.set(role, parsed);
      }
    }
  }
  const agent: AgentConfig = {
    // 0 is allowed and pauses all new dispatches.
    maxConcurrentAgents: reader.int(agentRaw, 'max_concurrent_agents', 'agent.max_concurrent_agents', DEFAULTS.maxConcurrentAgents, 0),
    maxTurns: reader.int(agentRaw, 'max_turns', 'agent.max_turns', DEFAULTS.maxTurns, 1),
    maxRetryBackoffMs: reader.int(agentRaw, 'max_retry_backoff_ms', 'agent.max_retry_backoff_ms', DEFAULTS.maxRetryBackoffMs, 1),
    maxConcurrentAgentsByState: byState,
    reservedSlotsByRole: reserved,
    maxContinuations:
      agentRaw.max_continuations === undefined || agentRaw.max_continuations === null
        ? null
        : reader.int(agentRaw, 'max_continuations', 'agent.max_continuations', 0, 0),
    maxIssueCostUsd: reader.number(agentRaw, 'max_issue_cost_usd', 'agent.max_issue_cost_usd'),
    maxSessionLimitRetries: reader.int(agentRaw, 'max_session_limit_retries', 'agent.max_session_limit_retries', DEFAULTS.maxSessionLimitRetries, 0),
    modelHoldMs: reader.int(agentRaw, 'model_hold_ms', 'agent.model_hold_ms', DEFAULTS.modelHoldMs, 1),
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
    byModel: readByModel(reader, claudeRaw),
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

  // Only an explicit value is checked, so configs without a checks section are unaffected.
  if (checksRaw.timeout_ms !== undefined && checksRaw.timeout_ms !== null && checks.timeoutMs >= claude.turnTimeoutMs) {
    reader.errors.push(
      `checks.timeout_ms (${checks.timeoutMs}) must be less than claude.turn_timeout_ms (${claude.turnTimeoutMs})`,
    );
  }

  // workspace integrations (e.g. laravel)
  const integrations: Record<string, unknown> = {};
  for (const integration of integrationList) {
    const section = reader.section(raw, integration.configKey);
    const result = integration.resolveConfig(section, { workflowDir, env: options.env, hookTimeoutMs: hooks.timeoutMs });
    reader.errors.push(...result.errors);
    reader.warnings.push(...result.warnings);
    integrations[integration.id] = result.config;
  }

  // roles
  const roles = readRoles(reader, raw, activeStates, terminalStates);
  for (const role of reserved.keys()) {
    if (roles?.some((known) => known.name === role) === true) continue;
    reserved.delete(role);
    reader.warnings.push(
      roles === null
        ? `agent.reserved_slots_by_role.${role} ignored: reservations need a roles section`
        : `agent.reserved_slots_by_role.${role} ignored: not a role (roles: ${roles.map((known) => known.name).join(', ')})`,
    );
  }
  if (roles !== null && agent.maxContinuations === null) {
    reader.warnings.push(
      'roles is set while agent.max_continuations is unlimited: role switches without a recorded result count as continuations, so set a limit',
    );
  }

  const pipeline = readPipeline(reader, raw, roles, terminalStates);

  // server (HTTP extension)
  const serverRaw = reader.section(raw, 'server');
  const portValue = serverRaw.port;
  const server: ServerConfig = {
    port: portValue === undefined || portValue === null ? null : reader.int(serverRaw, 'port', 'server.port', 0, 0),
    host: reader.string(serverRaw, 'host', 'server.host')?.trim() || DEFAULTS.serverHost,
    allowRemoteControl: reader.bool(serverRaw, 'allow_remote_control', 'server.allow_remote_control', false),
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
    checks,
    agent,
    claude,
    integrations,
    roles,
    pipeline,
    server,
    warnings: reader.warnings,
  };
}
