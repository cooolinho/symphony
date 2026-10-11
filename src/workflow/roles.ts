import type { Issue } from '../tracker/types.ts';
import { parseIssueCommand } from './command.ts';
import type { ClaudeConfig } from './config.ts';
import { normalizeStateName } from './config.ts';

/** Name of the implicit role serving issues when `roles` is not set or no role serves the issue's state. */
export const DEFAULT_ROLE = 'default';

/** Claude settings a role may override for its sessions. */
export type RoleClaudeOverrides = Partial<
  Pick<ClaudeConfig, 'model' | 'effort' | 'allowedTools' | 'disallowedTools' | 'appendSystemPrompt' | 'maxBudgetUsd'>
>;

/** A column-scoped agent role (the `roles` front matter section). */
export interface RoleConfig {
  name: string;
  /** Active states this role serves, normalized (trimmed, lowercase). */
  states: string[];
  readOnly: boolean;
  /** Columns the agent may move the issue to (free-form names); null = unrestricted. */
  mayMoveTo: string[] | null;
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
  claude: RoleClaudeOverrides;
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
