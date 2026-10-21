import type { Issue, TrackerAdapter } from '../tracker/types.ts';
import { normalizeStateName, type AgentConfig, type TrackerConfig } from '../workflow/config.ts';
import type { RoleConfig } from '../workflow/roles.ts';
import { subIssueLimit } from './work-packages.ts';

export const CONTINUATION_DELAY_MS = 1_000;
/** Largest delay setTimeout honors (2^31-1 ms); Node fires longer timers after 1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;
const FAILURE_BASE_DELAY_MS = 10_000;

/** Failure retries: 10s, 20s, 40s, ... capped at agent.max_retry_backoff_ms. */
export function failureBackoffMs(attempt: number, maxBackoffMs: number): number {
  const exponent = Math.min(Math.max(attempt, 1) - 1, 40);
  return Math.min(FAILURE_BASE_DELAY_MS * 2 ** exponent, maxBackoffMs);
}

/** Margin after a session limit's reset before the waiting retry runs. */
export const SESSION_LIMIT_RESET_BUFFER_MS = 60_000;
/** Reset times further ahead than this are not trusted (the longest window is weekly). */
export const SESSION_LIMIT_MAX_WAIT_MS = 8 * 24 * 3600 * 1000;

/**
 * Delay until a session limit has reset, plus SESSION_LIMIT_RESET_BUFFER_MS; a reset in the past waits the buffer
 * only. Null when the reset time is unknown, invalid or more than SESSION_LIMIT_MAX_WAIT_MS ahead.
 */
export function sessionLimitWaitMs(resetsAt: Date | null, now: Date): number | null {
  if (resetsAt === null) return null;
  const ahead = resetsAt.getTime() - now.getTime();
  if (!Number.isFinite(ahead) || ahead > SESSION_LIMIT_MAX_WAIT_MS) return null;
  return Math.max(ahead, 0) + SESSION_LIMIT_RESET_BUFFER_MS;
}

export function isTerminalState(state: string, tracker: Pick<TrackerConfig, 'terminalStates'>): boolean {
  const normalized = normalizeStateName(state);
  return tracker.terminalStates.some((s) => normalizeStateName(s) === normalized);
}

/** Active means listed in active_states and not in terminal_states. */
export function isActiveState(state: string, tracker: Pick<TrackerConfig, 'activeStates' | 'terminalStates'>): boolean {
  const normalized = normalizeStateName(state);
  return tracker.activeStates.some((s) => normalizeStateName(s) === normalized) && !isTerminalState(state, tracker);
}

/** Every configured label must be present (case-insensitive); a blank configured label matches nothing. */
export function hasRequiredLabels(issue: Pick<Issue, 'labels'>, requiredLabels: string[]): boolean {
  const labels = new Set(issue.labels.map((label) => label.trim().toLowerCase()));
  return requiredLabels.every((label) => {
    const wanted = label.trim().toLowerCase();
    return wanted !== '' && labels.has(wanted);
  });
}

/** issue_routable: adapter-derived dispatchability plus required labels. */
export function isRoutable(issue: Pick<Issue, 'dispatchable' | 'labels'>, tracker: Pick<TrackerConfig, 'requiredLabels'>): boolean {
  return issue.dispatchable === true && hasRequiredLabels(issue, tracker.requiredLabels);
}

/**
 * Whether a running session of `role` goes on with `issue`: the issue is routable, or only its open sub-issues hold it
 * back (`TrackerAdapter.heldBySubIssues`) and the role may create sub-issues on this issue itself (`subIssueLimit`:
 * `max_sub_issues`, for an architect only on an issue it may split). So the work packages an architect files as
 * sub-issues do not stop the session that filed them before it reports its result. Any open sub-issue counts, also one a
 * human created, as long as nothing else holds the issue back. Only for a running session: a new one never starts while
 * the sub-issues are open.
 */
export function routableWhileRunning(
  issue: Issue,
  role: Pick<RoleConfig, 'maxSubIssues' | 'result'> | null,
  tracker: Pick<TrackerConfig, 'requiredLabels'>,
  adapter: Pick<TrackerAdapter, 'heldBySubIssues'>,
): boolean {
  if (isRoutable(issue, tracker)) return true;
  return subIssueLimit(role, issue) !== null && hasRequiredLabels(issue, tracker.requiredLabels) && adapter.heldBySubIssues?.(issue) === true;
}

/**
 * The open sub-issues an issue waits for: only for a role with `wait_for_sub_issues`, and only on trackers that know
 * sub-issues. Unlike `isRoutable`, this gates new sessions only; a running session is not stopped by it.
 */
export function waitingForSubIssues(
  issue: Issue,
  role: Pick<RoleConfig, 'waitForSubIssues'> | null,
  adapter: Pick<TrackerAdapter, 'openSubIssues'>,
): string[] {
  if (role?.waitForSubIssues !== true) return [];
  return adapter.openSubIssues?.(issue) ?? [];
}

export function hasRequiredFields(issue: Partial<Issue>): boolean {
  return [issue.id, issue.identifier, issue.title, issue.state].every((value) => typeof value === 'string' && value.trim() !== '');
}

function priorityRank(priority: number | null): number {
  return priority !== null && Number.isInteger(priority) && priority >= 1 && priority <= 4 ? priority : Number.POSITIVE_INFINITY;
}

/** Priority 1..4 first (others and null after), then oldest created_at (null last), then identifier. */
export function sortForDispatch<T extends Pick<Issue, 'priority' | 'created_at' | 'identifier'>>(issues: readonly T[]): T[] {
  return [...issues].sort((a, b) => {
    const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
    if (byPriority !== 0 && !Number.isNaN(byPriority)) return byPriority;
    const aCreated = a.created_at?.getTime() ?? Number.POSITIVE_INFINITY;
    const bCreated = b.created_at?.getTime() ?? Number.POSITIVE_INFINITY;
    if (aCreated !== bCreated) return aCreated < bCreated ? -1 : 1;
    if (a.identifier === b.identifier) return 0;
    return a.identifier < b.identifier ? -1 : 1;
  });
}

/** Concurrency limit for a state: the per-state override if configured, else the global limit. */
export function stateLimit(state: string, agent: Pick<AgentConfig, 'maxConcurrentAgents' | 'maxConcurrentAgentsByState'>): number {
  return agent.maxConcurrentAgentsByState.get(normalizeStateName(state)) ?? agent.maxConcurrentAgents;
}
