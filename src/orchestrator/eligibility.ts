import type { Issue } from '../tracker/types.ts';
import { normalizeStateName, type AgentConfig, type TrackerConfig } from '../workflow/config.ts';

export const CONTINUATION_DELAY_MS = 1_000;
const FAILURE_BASE_DELAY_MS = 10_000;

/** Failure retries: 10s, 20s, 40s, ... capped at agent.max_retry_backoff_ms. */
export function failureBackoffMs(attempt: number, maxBackoffMs: number): number {
  const exponent = Math.min(Math.max(attempt, 1) - 1, 40);
  return Math.min(FAILURE_BASE_DELAY_MS * 2 ** exponent, maxBackoffMs);
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

export function hasRequiredFields(issue: Partial<Issue>): boolean {
  return [issue.id, issue.identifier, issue.title, issue.state].every((value) => typeof value === 'string' && value.trim() !== '');
}

function priorityRank(priority: number | null): number {
  return priority !== null && Number.isInteger(priority) && priority >= 1 && priority <= 4 ? priority : Number.POSITIVE_INFINITY;
}

/** Priority 1..4 first (others and null after), then oldest created_at (null last), then identifier. */
export function sortForDispatch(issues: Issue[]): Issue[] {
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
