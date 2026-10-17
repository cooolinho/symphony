import { chooseModel } from '../agent/model.ts';
import { modelFamilyOf } from '../agent/rate-limit.ts';
import type { Issue } from '../tracker/types.ts';
import { normalizeStateName, type ServiceConfig } from '../workflow/config.ts';
import { roleFor, roleName } from '../workflow/roles.ts';
import { hasRequiredFields, hasRequiredLabels, isActiveState, sortForDispatch } from './eligibility.ts';
import { activeReservations, heldForOtherRoles } from './limits.ts';

/**
 * Why an issue starts or waits. `ready` starts with the next pass; every other code is a wait.
 * docs/usage.md#dispatch-order lists the codes and their texts.
 */
export type PlanReasonCode =
  | 'ready'
  | 'no_free_slot'
  | 'column_limit'
  | 'reserved_for_role'
  | 'backoff'
  | 'session_limit'
  | 'model_hold'
  | 'waiting_for_sub_issues'
  | 'inactive'
  | 'paused'
  | 'blocked'
  | 'missing_label';

export interface PlanReason {
  code: PlanReasonCode;
  text: string;
}

/** `next`: started in `position` order as slots allow. `waiting`: not before `dueAt`. `blocked`: needs a board change. */
export type PlanGroup = 'next' | 'waiting' | 'paused' | 'blocked';

/** What would start: a continuation or retry of a claimed issue, or a new board candidate. */
export type PlanKind = 'continuation' | 'failure' | 'session_limit' | 'new' | 'paused';

/** The board fields the plan reads of an issue. */
export type PlanIssue = Pick<Issue, 'id' | 'identifier' | 'state' | 'priority' | 'created_at' | 'labels' | 'description'>;

export interface PlanRetry {
  issue: PlanIssue;
  kind: 'continuation' | 'failure' | 'session_limit';
  attempt: number;
  dueAt: Date;
  /**
   * Competes for a slot now: a continuation (it keeps the slot its session just left), a retry past its due time,
   * or one that already waited for a slot. Everything else waits for `dueAt`.
   */
  due: boolean;
  limit: { window: string | null; scope: 'account' | 'model'; model: string | null; waiting: boolean; hits: number; maxRetries: number } | null;
}

export interface PlanPaused {
  issue: PlanIssue;
  /** `operator`: paused from the dashboard; `continuations`: held back after agent.max_continuations. */
  source: 'continuations' | 'operator';
  continuations: number;
}

export interface PlanInput {
  config: Pick<ServiceConfig, 'agent' | 'tracker' | 'roles' | 'claude'>;
  now: Date;
  /** Board column and role name (`roleName`) of every running session (they hold a slot each). */
  running: ReadonlyArray<{ state: string; role?: string }>;
  retries: readonly PlanRetry[];
  paused: readonly PlanPaused[];
  /** Board candidates in active columns that are not claimed (running, retrying or paused). */
  candidates: readonly Issue[];
  /** Model holds by family; ended holds are ignored. `until: null` is an operator hold without an end. */
  holds: ReadonlyMap<string, { until: Date | null }>;
  /** New sessions wait while a worker waits for an account-wide session limit. */
  gate: { until: Date; window: string } | null;
  /** Open sub-issues a candidate waits for (roles with `wait_for_sub_issues`); empty when it waits for none. */
  waitingForSubIssues: (issue: Issue) => string[];
}

export interface PlanItem {
  issueId: string;
  identifier: string;
  state: string;
  group: PlanGroup;
  /** 1-based dispatch order within `next`; null for the other groups. */
  position: number | null;
  kind: PlanKind;
  decision: 'start' | 'wait';
  reason: PlanReason;
  /** When a waiting retry is due; null for new candidates, paused and blocked issues. */
  dueAt: Date | null;
  /** The model a session would run with (label, role, claude.model); null = Claude Code default. */
  model: string | null;
  priority: number | null;
}

/** A time in reason texts: the same for every reader (dashboard, logs, --dry-run), so in UTC. */
export function planTime(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const WINDOW_WORDS: Record<string, string> = { five_hour: 'five hour', seven_day: 'seven day' };
const windowWords = (window: string | null) => (window === null ? 'unknown window' : (WINDOW_WORDS[window] ?? window.replace(/_/g, ' ')));

/** The model a session for the issue would run with, as the orchestrator chooses it: label, else role, else claude.model. */
export function plannedModel(issue: Pick<Issue, 'state' | 'description' | 'labels'>, config: Pick<ServiceConfig, 'roles' | 'claude'>): string | null {
  return chooseModel(issue.labels, roleFor(issue, config.roles)?.claude.model ?? config.claude.model).model;
}

/** Why an issue of a held model waits: the end of a limit hold, or the operator's release. */
function holdReason(hold: { model: string; until: Date | null }): PlanReason {
  return {
    code: 'model_hold',
    text: hold.until === null ? `model ${hold.model} paused by the operator` : `model ${hold.model} on hold until ${planTime(hold.until)}`,
  };
}

function retryKindRank(retry: PlanRetry): number {
  return retry.kind === 'continuation' ? 0 : 1;
}

/** Why a retry that is not due yet waits. */
function waitingRetryReason(retry: PlanRetry): PlanReason {
  const at = planTime(retry.dueAt);
  const limit = retry.limit;
  if (retry.kind === 'session_limit' && limit !== null) {
    if (limit.scope === 'model' && limit.model !== null) return { code: 'model_hold', text: `model ${limit.model} on hold until ${at}` };
    if (limit.waiting) return { code: 'session_limit', text: `session limit (${windowWords(limit.window)}): retry after the reset at ${at}` };
    if (limit.hits <= limit.maxRetries) return { code: 'session_limit', text: `session limit: retry ${limit.hits} of ${limit.maxRetries} at ${at}` };
    return { code: 'session_limit', text: `session limit, reset time unknown: retry at ${at}` };
  }
  return { code: 'backoff', text: `retry ${retry.attempt} after a failure at ${at}` };
}

/**
 * The dispatch plan: everything Symphony could start, in the order it starts it, with the reason each issue waits.
 * The tick, the retry timers, --dry-run and the dashboard all read this one function.
 *
 * Order rule: work in flight first (continuations, then due retries), then new candidates; each group by
 * `sortForDispatch`. A continuation keeps the slot its session left, so no new candidate takes it in the gap.
 * Slots are handed out walking that order; an issue that waits for a hold, a column limit or sub-issues takes none.
 * Reserved slots (`agent.reserved_slots_by_role`) stay free for their role: an issue of role R starts only while the
 * free slots exceed the unused reservations of the other roles.
 */
export function planDispatch(input: PlanInput): PlanItem[] {
  const { config, now } = input;
  const max = config.agent.maxConcurrentAgents;
  let busy = input.running.length;
  const inState = new Map<string, number>();
  const byRole = new Map<string, number>();
  for (const entry of input.running) {
    const key = normalizeStateName(entry.state);
    inState.set(key, (inState.get(key) ?? 0) + 1);
    if (entry.role !== undefined) byRole.set(entry.role, (byRole.get(entry.role) ?? 0) + 1);
  }
  const reserved = activeReservations(config.agent);
  const holdOf = (issue: PlanIssue): { model: string; until: Date | null } | null => {
    const family = modelFamilyOf(plannedModel(issue, config));
    const hold = family === null ? undefined : input.holds.get(family);
    if (family === null || hold === undefined) return null;
    return hold.until === null || hold.until.getTime() > now.getTime() ? { model: family, until: hold.until } : null;
  };

  /** Hands out a slot, or names what is missing: a column limit, else a free slot, else one not reserved for other roles. */
  const claimSlot = (issue: PlanIssue): PlanReason | null => {
    const { state } = issue;
    const key = normalizeStateName(state);
    const columnLimit = config.agent.maxConcurrentAgentsByState.get(key);
    const used = inState.get(key) ?? 0;
    if (columnLimit !== undefined && used >= columnLimit) return { code: 'column_limit', text: `${state} limit ${used}/${columnLimit}` };
    if (busy >= max) return { code: 'no_free_slot', text: `waiting for a free slot (${Math.min(busy, max)}/${max} busy)` };
    const role = roleName(roleFor(issue, config.roles));
    const held = heldForOtherRoles(role, reserved, byRole);
    const free = max - busy;
    if (free <= held.slots) {
      const slots = free === 1 ? 'the free slot is' : `the ${free} free slots are`;
      return { code: 'reserved_for_role', text: `${slots} reserved for ${held.roles.join(', ')}` };
    }
    busy++;
    inState.set(key, used + 1);
    byRole.set(role, (byRole.get(role) ?? 0) + 1);
    return null;
  };

  const items: PlanItem[] = [];
  const item = (issue: PlanIssue, group: PlanGroup, kind: PlanKind, reason: PlanReason, dueAt: Date | null): PlanItem => ({
    issueId: issue.id,
    identifier: issue.identifier,
    state: issue.state,
    group,
    position: null,
    kind,
    decision: reason.code === 'ready' ? 'start' : 'wait',
    reason,
    dueAt,
    model: plannedModel(issue, config),
    priority: issue.priority,
  });

  // A claimed issue that left the active columns is released when its retry fires: it holds no slot.
  const active = (retry: PlanRetry) => retry.issue.state === '' || isActiveState(retry.issue.state, config.tracker);

  // Up next, in flight first: continuations, then due retries.
  const due = input.retries.filter((retry) => retry.due && active(retry));
  const byIssue = new Map(due.map((retry) => [retry.issue.id, retry]));
  const inFlight = sortForDispatch(due.map((retry) => retry.issue)).sort(
    (a, b) => retryKindRank(byIssue.get(a.id) as PlanRetry) - retryKindRank(byIssue.get(b.id) as PlanRetry),
  );
  for (const issue of inFlight) {
    const retry = byIssue.get(issue.id) as PlanRetry;
    const hold = holdOf(issue);
    const reason: PlanReason =
      hold !== null
        ? holdReason(hold)
        : (claimSlot(issue) ?? {
            code: 'ready',
            text: retry.kind === 'continuation' ? 'continues its session' : `retry ${retry.attempt} starts now`,
          });
    items.push(item(issue, 'next', retry.kind, reason, retry.dueAt));
  }

  // Then new candidates. Not dispatchable or without a required label: blocked until the board changes.
  const blocked: PlanItem[] = [];
  for (const issue of sortForDispatch(input.candidates)) {
    if (!hasRequiredFields(issue) || !isActiveState(issue.state, config.tracker)) continue;
    if (!issue.dispatchable) {
      const note = issue.native_ref?.dispatch_note;
      blocked.push(item(issue, 'blocked', 'new', { code: 'blocked', text: typeof note === 'string' && note !== '' ? note : 'not dispatchable' }, null));
      continue;
    }
    const required = config.tracker.requiredLabels;
    if (!hasRequiredLabels(issue, required)) {
      const missing = required.filter((label) => !issue.labels.some((have) => have.trim().toLowerCase() === label.trim().toLowerCase()));
      blocked.push(item(issue, 'blocked', 'new', { code: 'missing_label', text: `missing required label${missing.length === 1 ? '' : 's'} ${missing.join(', ')}` }, null));
      continue;
    }
    const subIssues = input.waitingForSubIssues(issue);
    const hold = holdOf(issue);
    let reason: PlanReason | null;
    if (subIssues.length > 0) reason = { code: 'waiting_for_sub_issues', text: `waiting for sub-issues ${subIssues.join(', ')}` };
    else if (hold !== null) reason = holdReason(hold);
    else if (input.gate !== null) {
      reason = { code: 'session_limit', text: `new sessions paused until ${planTime(input.gate.until)}: session limit (${windowWords(input.gate.window)})` };
    } else reason = claimSlot(issue);
    items.push(item(issue, 'next', 'new', reason ?? { code: 'ready', text: 'starts at the next poll' }, null));
  }
  items.forEach((entry, index) => (entry.position = index + 1));

  // Waiting for a time: backoff, session limits, model holds; soonest first.
  const waiting = input.retries.filter((retry) => !retry.due || !active(retry)).sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  for (const retry of waiting) {
    // An operator hold has no end: the retry waits for the release, whatever its own due time says.
    const hold = holdOf(retry.issue);
    const reason: PlanReason = !active(retry)
      ? { code: 'inactive', text: `left the active columns ("${retry.issue.state}"); released at ${planTime(retry.dueAt)}` }
      : hold !== null && hold.until === null
        ? holdReason(hold)
        : waitingRetryReason(retry);
    items.push(item(retry.issue, 'waiting', retry.kind, reason, retry.dueAt));
  }

  for (const paused of input.paused) {
    const text =
      paused.source === 'operator'
        ? 'paused by operator; press Resume to continue'
        : `paused after ${paused.continuations} continuation session${paused.continuations === 1 ? '' : 's'}; change the issue on the board to resume`;
    items.push(item(paused.issue, 'paused', 'paused', { code: 'paused', text }, null));
  }
  return [...items, ...blocked];
}
