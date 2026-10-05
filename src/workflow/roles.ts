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
  claude: RoleClaudeOverrides;
}

/** The role serving `state` (compared case-insensitively), or null when none does. */
export function roleFor(state: string, roles: readonly RoleConfig[] | null): RoleConfig | null {
  if (roles === null) return null;
  const key = normalizeStateName(state);
  return roles.find((role) => role.states.includes(key)) ?? null;
}

/** Template and log name of `role`: its name, or `default` for the implicit role. */
export function roleName(role: RoleConfig | null): string {
  return role?.name ?? DEFAULT_ROLE;
}
