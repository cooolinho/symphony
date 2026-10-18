import { normalizeStateName, type AgentConfig, type ServiceConfig, type TrackerConfig } from '../workflow/config.ts';
import { resultTargets, type RoleConfig } from '../workflow/roles.ts';
import { isActiveState } from './eligibility.ts';

/** Highest agent slot count (total and per column) the dashboard accepts. */
export const MAX_SLOTS = 50;

export type AgentLimits = Pick<AgentConfig, 'maxConcurrentAgents' | 'maxConcurrentAgentsByState' | 'reservedSlotsByRole'>;

/**
 * Agent slots set on the dashboard (`settings` in the runtime state file). They take precedence over `WORKFLOW.md`
 * and survive its reloads; null and missing columns fall back to it.
 */
export interface AgentLimitOverride {
  maxConcurrentAgents: number | null;
  /** Keys are normalized column names (trimmed, lowercase). */
  byState: ReadonlyMap<string, number>;
  /** Reserved slots by role name; 0 removes a `WORKFLOW.md` reservation. */
  reservedByRole: ReadonlyMap<string, number>;
}

export const NO_LIMIT_OVERRIDE: AgentLimitOverride = { maxConcurrentAgents: null, byState: new Map(), reservedByRole: new Map() };

export function hasLimitOverride(override: AgentLimitOverride): boolean {
  return override.maxConcurrentAgents !== null || override.byState.size > 0 || override.reservedByRole.size > 0;
}

type LimitConfig = { agent: AgentLimits; roles: readonly Pick<RoleConfig, 'name'>[] | null };

/**
 * The limits in force: dashboard override, else `WORKFLOW.md`. Slot counting, the dispatch plan and the snapshot read
 * this. Reservations keep positive counts of configured roles only (an override may name a role `WORKFLOW.md` dropped).
 */
export function effectiveAgentLimits(config: LimitConfig, override: AgentLimitOverride): AgentLimits {
  const { agent } = config;
  const byState = new Map(agent.maxConcurrentAgentsByState);
  for (const [state, limit] of override.byState) byState.set(state, limit);
  const reserved = new Map(agent.reservedSlotsByRole);
  for (const [role, count] of override.reservedByRole) reserved.set(role, count);
  for (const [role, count] of reserved) {
    if (count <= 0 || config.roles?.some((known) => known.name === role) !== true) reserved.delete(role);
  }
  return {
    maxConcurrentAgents: override.maxConcurrentAgents ?? agent.maxConcurrentAgents,
    maxConcurrentAgentsByState: byState,
    reservedSlotsByRole: reserved,
  };
}

/** `config` with the effective agent limits in place of the `WORKFLOW.md` ones. */
export function withAgentLimits(config: ServiceConfig, override: AgentLimitOverride): ServiceConfig {
  if (!hasLimitOverride(override)) return config;
  return { ...config, agent: { ...config.agent, ...effectiveAgentLimits(config, override) } };
}

const slotWord = (count: number) => `${count} agent slot${count === 1 ? '' : 's'}`;

function reservedSum(reserved: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const count of reserved.values()) sum += count;
  return sum;
}

/** `developer 1 + reviewer 1 = 2` */
function reservedText(reserved: ReadonlyMap<string, number>): string {
  const parts = [...reserved].map(([role, count]) => `${role} ${count}`);
  return parts.length === 1 ? parts[0] ?? '' : `${parts.join(' + ')} = ${reservedSum(reserved)}`;
}

/**
 * Why the reservations are ignored: their sum exceeds the total. Null while they fit, and at a total of 0 (it pauses
 * new dispatches anyway).
 */
export function reservationProblem(limits: AgentLimits): string | null {
  const sum = reservedSum(limits.reservedSlotsByRole);
  if (limits.maxConcurrentAgents === 0 || sum <= limits.maxConcurrentAgents) return null;
  return `reserved slots ignored: the reservations (${reservedText(limits.reservedSlotsByRole)}) exceed the limit of ${slotWord(limits.maxConcurrentAgents)}`;
}

/** The reservations the dispatch applies: none while `reservationProblem` names one. */
export function activeReservations(limits: AgentLimits): ReadonlyMap<string, number> {
  return reservationProblem(limits) === null ? limits.reservedSlotsByRole : new Map();
}

/**
 * The slots a session of `role` must leave free: the unused reservations of every other role
 * (Σ max(0, reserved − running)), and those roles in reservation order.
 */
export function heldForOtherRoles(
  role: string,
  reserved: ReadonlyMap<string, number>,
  running: ReadonlyMap<string, number>,
): { slots: number; roles: string[] } {
  let slots = 0;
  const roles: string[] = [];
  for (const [other, count] of reserved) {
    const unused = count - (running.get(other) ?? 0);
    if (other === role || unused <= 0) continue;
    slots += unused;
    roles.push(other);
  }
  return { slots, roles };
}

/**
 * Roles that results lead issues to (the `on_result`, `on_check_failed`, `on_missing_result` and `on_round_limit` targets
 * of any role) but that never start a session: the reservations of the other roles keep every slot free, so an issue
 * waits in the column forever. That is the optional test engineer with the shipped 2 slots, reserved for the developer and
 * the reviewer. One line per role. None while the reservations are ignored (`reservationProblem`) and at a limit of 0,
 * which pauses new dispatches anyway.
 */
export function slotProblems(config: Pick<ServiceConfig, 'roles' | 'tracker'>, limits: AgentLimits): string[] {
  const { roles } = config;
  const total = limits.maxConcurrentAgents;
  if (roles === null || total === 0 || reservationProblem(limits) !== null) return [];
  const columns = activeColumns(config.tracker);
  const problems: string[] = [];
  const reported = new Set<string>();
  for (const target of new Set(roles.flatMap((role) => resultTargets(role)))) {
    const key = normalizeStateName(target);
    const role = roles.find((candidate) => candidate.commands === null && candidate.states.includes(key));
    const column = columns.get(key);
    if (role === undefined || column === undefined || reported.has(role.name)) continue;
    const held = heldForOtherRoles(role.name, limits.reservedSlotsByRole, new Map());
    if (held.slots < total) continue;
    reported.add(role.name);
    const others = new Map([...limits.reservedSlotsByRole].filter(([name]) => name !== role.name && held.roles.includes(name)));
    problems.push(
      `role ${role.name} never starts in ${column}: the reservations of the other roles (${reservedText(others)}) take every one of the ${slotWord(total)}; ` +
        `raise the limit or reserve a slot for ${role.name}`,
    );
  }
  return problems;
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
 * `reserved_slots_by_role` lists every configured role with its running sessions (`running`, by role name);
 * `reservation_problem` says why the reservations are ignored; `slot_problems` names the roles that never get a slot.
 */
export function limitsJson(config: ServiceConfig, override: AgentLimitOverride, running: ReadonlyMap<string, number> = new Map()) {
  const effective = effectiveAgentLimits(config, override);
  const byState: Record<string, LimitValue> = {};
  for (const [key, name] of activeColumns(config.tracker)) {
    byState[name] = {
      effective: effective.maxConcurrentAgentsByState.get(key) ?? null,
      workflow: config.agent.maxConcurrentAgentsByState.get(key) ?? null,
      override: override.byState.get(key) ?? null,
    };
  }
  const reserved: Record<string, LimitValue & { effective: number; workflow: number; running: number }> = {};
  for (const role of config.roles ?? []) {
    reserved[role.name] = {
      effective: effective.reservedSlotsByRole.get(role.name) ?? 0,
      workflow: config.agent.reservedSlotsByRole.get(role.name) ?? 0,
      override: override.reservedByRole.get(role.name) ?? null,
      running: running.get(role.name) ?? 0,
    };
  }
  return {
    max_concurrent_agents: {
      effective: effective.maxConcurrentAgents,
      workflow: config.agent.maxConcurrentAgents,
      override: override.maxConcurrentAgents,
    },
    by_state: byState,
    reserved_slots_by_role: reserved,
    reservation_problem: reservationProblem(effective),
    slot_problems: slotProblems(config, effective),
    override_active: hasLimitOverride(override),
    max: MAX_SLOTS,
  };
}

/** Effective limits for the history log and messages, columns by their `WORKFLOW.md` spelling where active. */
export function limitsSummary(config: ServiceConfig, override: AgentLimitOverride) {
  const effective = effectiveAgentLimits(config, override);
  const columns = activeColumns(config.tracker);
  return {
    max_concurrent_agents: effective.maxConcurrentAgents,
    max_concurrent_agents_by_state: Object.fromEntries(
      [...effective.maxConcurrentAgentsByState].map(([key, limit]) => [columns.get(key) ?? key, limit]),
    ),
    reserved_slots_by_role: Object.fromEntries(effective.reservedSlotsByRole),
  };
}

export type LimitUpdateResult = { ok: true; override: AgentLimitOverride } | { ok: false; message: string };

const isSlotCount = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= MAX_SLOTS;

const UPDATE_FIELDS = ['max_concurrent_agents', 'max_concurrent_agents_by_state', 'reserved_slots_by_role'];

/**
 * Applies the body of `PUT /api/v1/settings/agents` to `current`. Fields left out keep their value; `null` removes
 * an override (the total, one column or one role). Total: integer 0–50 (0 pauses new dispatches); per column: integer
 * 1–50 for an active column; per role: integer 0–50 for a configured role. A change of the total or the reservations
 * that leaves fewer slots than reserved is refused.
 */
export function applyLimitUpdate(
  current: AgentLimitOverride,
  body: unknown,
  config: Pick<ServiceConfig, 'tracker' | 'agent' | 'roles'>,
): LimitUpdateResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, message: 'the body must be a JSON object' };
  const fields = body as Record<string, unknown>;
  const unknown = Object.keys(fields).filter((key) => !UPDATE_FIELDS.includes(key));
  if (unknown.length > 0) return { ok: false, message: `unknown field ${unknown[0]}; use ${UPDATE_FIELDS.join(', ')}` };
  if (!UPDATE_FIELDS.some((key) => key in fields)) {
    return { ok: false, message: 'set max_concurrent_agents, max_concurrent_agents_by_state and/or reserved_slots_by_role' };
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
    const columns = activeColumns(config.tracker);
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
  const reservedByRole = new Map(current.reservedByRole);
  if ('reserved_slots_by_role' in fields) {
    const raw = fields.reserved_slots_by_role;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, message: 'reserved_slots_by_role must be an object of role name to slot count' };
    }
    const roles = (config.roles ?? []).map((role) => role.name);
    for (const [role, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!roles.includes(role)) {
        return { ok: false, message: roles.length === 0 ? 'reserved slots need a roles section in WORKFLOW.md' : `${role} is not a role; use one of ${roles.join(', ')}` };
      }
      if (value === null) {
        reservedByRole.delete(role);
      } else if (isSlotCount(value, 0)) {
        reservedByRole.set(role, value);
      } else {
        return { ok: false, message: `the reserved slots of ${role} must be an integer from 0 to ${MAX_SLOTS}, or null` };
      }
    }
  }
  const override: AgentLimitOverride = { maxConcurrentAgents: total, byState, reservedByRole };
  if ('max_concurrent_agents' in fields || 'reserved_slots_by_role' in fields) {
    const effective = effectiveAgentLimits(config, override);
    if (reservationProblem(effective) !== null) {
      return {
        ok: false,
        message: `the limit of ${slotWord(effective.maxConcurrentAgents)} is below the reserved slots (${reservedText(effective.reservedSlotsByRole)}); lower the reservations first`,
      };
    }
  }
  return { ok: true, override };
}

/** A stored override, with out-of-range values dropped (the file may have been edited by hand). */
export function limitOverrideOf(value: unknown): AgentLimitOverride {
  if (value === null || typeof value !== 'object') return NO_LIMIT_OVERRIDE;
  const raw = value as { max_concurrent_agents?: unknown; max_concurrent_agents_by_state?: unknown; reserved_slots_by_role?: unknown };
  const byState = new Map<string, number>();
  const states = raw.max_concurrent_agents_by_state;
  if (states !== null && typeof states === 'object' && !Array.isArray(states)) {
    for (const [state, limit] of Object.entries(states as Record<string, unknown>)) {
      const key = normalizeStateName(state);
      if (key !== '' && isSlotCount(limit, 1)) byState.set(key, limit);
    }
  }
  const reservedByRole = new Map<string, number>();
  const roles = raw.reserved_slots_by_role;
  if (roles !== null && typeof roles === 'object' && !Array.isArray(roles)) {
    for (const [role, count] of Object.entries(roles as Record<string, unknown>)) {
      if (role !== '' && isSlotCount(count, 0)) reservedByRole.set(role, count);
    }
  }
  return { maxConcurrentAgents: isSlotCount(raw.max_concurrent_agents, 0) ? raw.max_concurrent_agents : null, byState, reservedByRole };
}

export function limitOverrideJson(override: AgentLimitOverride) {
  return {
    max_concurrent_agents: override.maxConcurrentAgents,
    max_concurrent_agents_by_state: Object.fromEntries(override.byState),
    // Left out while empty: the file stays as it was before reservations existed.
    ...(override.reservedByRole.size > 0 ? { reserved_slots_by_role: Object.fromEntries(override.reservedByRole) } : {}),
  };
}

function sameMap(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

export function sameLimitOverride(a: AgentLimitOverride, b: AgentLimitOverride): boolean {
  return a.maxConcurrentAgents === b.maxConcurrentAgents && sameMap(a.byState, b.byState) && sameMap(a.reservedByRole, b.reservedByRole);
}
