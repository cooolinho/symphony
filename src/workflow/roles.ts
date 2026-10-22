import type { Issue } from '../tracker/types.ts';
import { parseIssueCommand, type PluginAgent } from './command.ts';
import type { ClaudeConfig } from './config.ts';
import { normalizeStateName } from './config.ts';
import type { AgentResultKind } from './results.ts';

/** Name of the implicit role serving issues when `roles` is not set or no role serves the issue's state. */
export const DEFAULT_ROLE = 'default';

/** Claude settings a role may override for its sessions. */
export type RoleClaudeOverrides = Partial<
  Pick<ClaudeConfig, 'model' | 'effort' | 'allowedTools' | 'disallowedTools' | 'appendSystemPrompt' | 'maxBudgetUsd'>
> & {
  /** Model to use for each complexity level; entries can override the role's model for specific levels. */
  modelByComplexity?: Partial<Record<'S' | 'M' | 'L' | 'XL', string | null>>;
};

/** `on_result` target meaning the next active stage of the pipeline in board order. */
export const NEXT_STAGE = 'next';

/** Whether a `Model:` issue label picks the model of a role's sessions. */
export type ModelLabelPolicy = 'apply' | 'ignore';

/** Whether an `Effort:` issue label picks the effort of a role's sessions. */
export type EffortLabelPolicy = 'apply' | 'ignore';

/** A column-scoped agent role (the `roles` front matter section). */
export interface RoleConfig {
  name: string;
  /** Active states this role serves, normalized (trimmed, lowercase). */
  states: string[];
  readOnly: boolean;
  /** Columns the agent may move the issue to (free-form names); null = unrestricted. */
  mayMoveTo: string[] | null;
  /** Kind of the stage result this role reports; null = the role reports none (no result-driven transitions). */
  result: AgentResultKind | null;
  /** Target per verdict of `result`: a column name or `next` (`NEXT_STAGE`). Targets other than `next` are in `mayMoveTo`. */
  onResult: Readonly<Record<string, string>>;
  /** Column for an issue whose entry check fails for a role that cannot fix it; null = none configured. */
  onCheckFailed: string | null;
  /** Column for a session that ends without a result; `Blocked` by default when `result` is set, else null. */
  onMissingResult: string | null;
  /**
   * Column for a loop verdict (review `changes_needed`, test `failed`, security `issues_found`) at the round limit; null = the blocked column.
   * Only for roles whose `result` is `review`, `test` or `security`.
   */
  onRoundLimit: string | null;
  /** `ignore` keeps a `Model:` issue label from changing the role's model. */
  modelLabel: ModelLabelPolicy;
  /** `ignore` keeps an `Effort:` issue label from changing the role's effort. */
  effortLabel: EffortLabelPolicy;
  /** Turn limit for sessions of this role; null uses `agent.max_turns`. */
  maxTurns: number | null;
  /**
   * Issue commands (`/refactoring`) this role serves; null = the role serves issues without a command.
   * A role with commands is picked only for an issue whose first line is one of them.
   */
  commands: string[] | null;
  /** False skips the `checks.on_enter` scripts for this role's status changes (`may_move_to` still applies). */
  runChecks: boolean;
  /**
   * Sub-issues this role may have open under its issue at once, counting the sub-issues of those (`create_sub_issue`
   * with `parent`); null = the role gets no `create_sub_issue` tool.
   */
  maxSubIssues: number | null;
  /**
   * Board column for the sub-issues this role creates, overriding `tracker.provider.sub_issue_status`; null keeps
   * the provider's column. May be an active column, so the sub-issues start without a human (never a terminal one).
   */
  subIssueStatus: string | null;
  /**
   * True holds the role's issues back while any of their sub-issues is open: a running session is not stopped, but
   * it ends after its turn once sub-issues are open, and the issue is dispatched again when all of them are closed.
   */
  waitForSubIssues: boolean;
  /**
   * Plugin subagents (`agents/<name>.md`, names without the plugin prefix) the role may call; null = every one the
   * session may use. Read-only roles never get subagents that can edit files.
   */
  agents: string[] | null;
  claude: RoleClaudeOverrides;
}

/** Columns named by a role's result-driven transitions (without `next`, which depends on the board order). */
export function resultTargets(role: Pick<RoleConfig, 'onResult' | 'onCheckFailed' | 'onMissingResult' | 'onRoundLimit'>): string[] {
  const targets = [...Object.values(role.onResult), role.onCheckFailed, role.onMissingResult, role.onRoundLimit];
  return targets.filter((target): target is string => target !== null && target !== NEXT_STAGE);
}

/**
 * The role serving `issue`, or null when none does. With a command in the description, a role that lists the command
 * and serves the issue's state (compared case-insensitively) wins; otherwise the role without commands that serves it.
 */
export function roleFor(issue: Pick<Issue, 'state' | 'description'>, roles: readonly RoleConfig[] | null): RoleConfig | null {
  if (roles === null) return null;
  const key = normalizeStateName(issue.state);
  const command = parseIssueCommand(issue.description)?.name;
  if (command !== undefined) {
    const commanded = roles.find((role) => role.commands?.includes(command) === true && role.states.includes(key));
    if (commanded !== undefined) return commanded;
  }
  return roles.find((role) => role.commands === null && role.states.includes(key)) ?? null;
}

/** Template and log name of `role`: its name, or `default` for the implicit role. */
export function roleName(role: RoleConfig | null): string {
  return role?.name ?? DEFAULT_ROLE;
}

/** Plugin subagents a session may call, and the ones it must not. */
export interface SessionAgents {
  allowed: PluginAgent[];
  denied: PluginAgent[];
}

/**
 * Splits the plugin subagents for a session of `role`. A subagent is allowed when the role lists it (or lists none),
 * it does not edit files in a read-only role, and its name does not start with an integration's prefix
 * (`laravel-`) unless that integration found its project type in the workspace (`activePrefixes`).
 */
export function sessionAgents(
  agents: readonly PluginAgent[],
  role: RoleConfig | null,
  scopedPrefixes: readonly string[],
  activePrefixes: readonly string[],
): SessionAgents {
  const result: SessionAgents = { allowed: [], denied: [] };
  for (const agent of agents) {
    const listed = role?.agents == null || role.agents.includes(agent.name);
    const writable = role?.readOnly !== true || agent.readOnly;
    const scoped = scopedPrefixes.filter((prefix) => agent.name.startsWith(prefix));
    const inScope = scoped.length === 0 || scoped.some((prefix) => activePrefixes.includes(prefix));
    (listed && writable && inScope ? result.allowed : result.denied).push(agent);
  }
  return result;
}
