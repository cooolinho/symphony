import { normalizeStateName, type AgentConfig, type ServiceConfig, type TrackerConfig } from '../workflow/config.ts';
import { isActiveState } from './eligibility.ts';

/** Highest agent slot count (total and per column) the dashboard accepts. */
export const MAX_SLOTS = 50;

export type AgentLimits = Pick<AgentConfig, 'maxConcurrentAgents' | 'maxConcurrentAgentsByState'>;

/**
 * Agent slots set on the dashboard (`settings` in the runtime state file). They take precedence over `WORKFLOW.md`
 * and survive its reloads; null and missing columns fall back to it.
 */
export interface AgentLimitOverride {
  maxConcurrentAgents: number | null;
  /** Keys are normalized column names (trimmed, lowercase). */
  byState: ReadonlyMap<string, number>;
}

export const NO_LIMIT_OVERRIDE: AgentLimitOverride = { maxConcurrentAgents: null, byState: new Map() };

export function hasLimitOverride(override: AgentLimitOverride): boolean {
  return override.maxConcurrentAgents !== null || override.byState.size > 0;
}

/** The limits in force: dashboard override, else `WORKFLOW.md`. Slot counting, the dispatch plan and the snapshot read this. */
export function effectiveAgentLimits(agent: AgentLimits, override: AgentLimitOverride): AgentLimits {
  const byState = new Map(agent.maxConcurrentAgentsByState);
  for (const [state, limit] of override.byState) byState.set(state, limit);
  return { maxConcurrentAgents: override.maxConcurrentAgents ?? agent.maxConcurrentAgents, maxConcurrentAgentsByState: byState };
}

/** `config` with the effective agent limits in place of the `WORKFLOW.md` ones. */
export function withAgentLimits(config: ServiceConfig, override: AgentLimitOverride): ServiceConfig {
  if (!hasLimitOverride(override)) return config;
  return { ...config, agent: { ...config.agent, ...effectiveAgentLimits(config.agent, override) } };
}

/** The active columns by normalized name, spelled as in `WORKFLOW.md`. */
function activeColumns(tracker: Pick<TrackerConfig, 'activeStates' | 'terminalStates'>): Map<string, string> {
  const columns = new Map<string, string>();
  for (const state of tracker.activeStates) {
    if (isActiveState(state, tracker)) columns.set(normalizeStateName(state), state);
  }
  return columns;
}

interface LimitValue {
  effective: number | null;
  workflow: number | null;
  override: number | null;
}

/**
 * The `limits` key of the snapshot: total and per active column, each with the effective value, the `WORKFLOW.md`
 * value and the dashboard override. A column without a limit of its own has `effective: null` (only the total applies).
 */
export function limitsJson(config: ServiceConfig, override: AgentLimitOverride) {
  const effective = effectiveAgentLimits(config.agent, override);
  const byState: Record<string, LimitValue> = {};
  for (const [key, name] of activeColumns(config.tracker)) {
    byState[name] = {
      effective: effective.maxConcurrentAgentsByState.get(key) ?? null,
      workflow: config.agent.maxConcurrentAgentsByState.get(key) ?? null,
      override: override.byState.get(key) ?? null,
    };
  }
  return {
    max_concurrent_agents: {
      effective: effective.maxConcurrentAgents,
      workflow: config.agent.maxConcurrentAgents,
      override: override.maxConcurrentAgents,
    },
    by_state: byState,
    override_active: hasLimitOverride(override),
    max: MAX_SLOTS,
  };
}

/** Effective limits for the history log and messages, columns by their `WORKFLOW.md` spelling where active. */
export function limitsSummary(config: ServiceConfig, override: AgentLimitOverride) {
  const effective = effectiveAgentLimits(config.agent, override);
  const columns = activeColumns(config.tracker);
  return {
    max_concurrent_agents: effective.maxConcurrentAgents,
    max_concurrent_agents_by_state: Object.fromEntries(
      [...effective.maxConcurrentAgentsByState].map(([key, limit]) => [columns.get(key) ?? key, limit]),
    ),
  };
}

export type LimitUpdateResult = { ok: true; override: AgentLimitOverride } | { ok: false; message: string };

const isSlotCount = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= MAX_SLOTS;

/**
 * Applies the body of `PUT /api/v1/settings/agents` to `current`. Fields left out keep their value; `null` removes
 * an override (the total, or one column). Total: integer 0–50 (0 pauses new dispatches); per column: integer 1–50
 * for an active column.
 */
export function applyLimitUpdate(
  current: AgentLimitOverride,
  body: unknown,
  tracker: Pick<TrackerConfig, 'activeStates' | 'terminalStates'>,
): LimitUpdateResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, message: 'the body must be a JSON object' };
  const fields = body as Record<string, unknown>;
  const unknown = Object.keys(fields).filter((key) => key !== 'max_concurrent_agents' && key !== 'max_concurrent_agents_by_state');
  if (unknown.length > 0) return { ok: false, message: `unknown field ${unknown[0]}; use max_concurrent_agents and max_concurrent_agents_by_state` };
  if (!('max_concurrent_agents' in fields) && !('max_concurrent_agents_by_state' in fields)) {
    return { ok: false, message: 'set max_concurrent_agents and/or max_concurrent_agents_by_state' };
  }
  let total = current.maxConcurrentAgents;
  if ('max_concurrent_agents' in fields) {
    const value = fields.max_concurrent_agents;
    if (value !== null && !isSlotCount(value, 0)) {
      return { ok: false, message: `max_concurrent_agents must be an integer from 0 to ${MAX_SLOTS} (0 pauses new dispatches), or null` };
    }
    total = value;
  }
  const byState = new Map(current.byState);
  if ('max_concurrent_agents_by_state' in fields) {
    const raw = fields.max_concurrent_agents_by_state;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, message: 'max_concurrent_agents_by_state must be an object of column name to limit' };
    }
    const columns = activeColumns(tracker);
    for (const [state, value] of Object.entries(raw as Record<string, unknown>)) {
      const key = normalizeStateName(state);
      if (!columns.has(key)) return { ok: false, message: `${state} is not an active column; use one of ${[...columns.values()].join(', ')}` };
      if (value === null) {
        byState.delete(key);
      } else if (isSlotCount(value, 1)) {
        byState.set(key, value);
      } else {
        return { ok: false, message: `the limit of ${state} must be an integer from 1 to ${MAX_SLOTS}, or null` };
      }
    }
  }
  return { ok: true, override: { maxConcurrentAgents: total, byState } };
}

/** A stored override, with out-of-range values dropped (the file may have been edited by hand). */
export function limitOverrideOf(value: unknown): AgentLimitOverride {
  if (value === null || typeof value !== 'object') return NO_LIMIT_OVERRIDE;
  const raw = value as { max_concurrent_agents?: unknown; max_concurrent_agents_by_state?: unknown };
  const byState = new Map<string, number>();
  const states = raw.max_concurrent_agents_by_state;
  if (states !== null && typeof states === 'object' && !Array.isArray(states)) {
    for (const [state, limit] of Object.entries(states as Record<string, unknown>)) {
      const key = normalizeStateName(state);
      if (key !== '' && isSlotCount(limit, 1)) byState.set(key, limit);
    }
  }
  return { maxConcurrentAgents: isSlotCount(raw.max_concurrent_agents, 0) ? raw.max_concurrent_agents : null, byState };
}

export function limitOverrideJson(override: AgentLimitOverride) {
  return {
    max_concurrent_agents: override.maxConcurrentAgents,
    max_concurrent_agents_by_state: Object.fromEntries(override.byState),
  };
}

export function sameLimitOverride(a: AgentLimitOverride, b: AgentLimitOverride): boolean {
  if (a.maxConcurrentAgents !== b.maxConcurrentAgents || a.byState.size !== b.byState.size) return false;
  for (const [state, limit] of a.byState) if (b.byState.get(state) !== limit) return false;
  return true;
}
