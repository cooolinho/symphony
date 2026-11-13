import type { PersistedResult } from '../orchestrator/stage-history.ts';
import { buildStageHistory } from '../orchestrator/stage-history.ts';
import type { HistoryEntry } from '../history/history.ts';
import type { IssueComment } from '../tracker/types.ts';
import { normalizeStateName } from '../workflow/config.ts';
import type { RoleConfig } from '../workflow/roles.ts';

/** How the issue got into the blocked column (see docs/watchdog.md). */
export type BlockKind = 'result' | 'round_limit' | 'check_failed' | 'missing_result' | 'free_text' | 'unknown';

export interface BlockCase {
  kind: BlockKind;
  /** The active column the issue was blocked from; null when it cannot be told. */
  from: string | null;
  /** The role whose session blocked it; null when unknown. */
  role: string | null;
  /** The blocking result's blockers (`needs`, description); empty without a result. */
  blockers: Array<{ needs: string; description: string }>;
  /** The blocking result's summary or the plain comment's text; '' when none. */
  summary: string;
  /** Column whose entry check failed (`check_failed`), else null. */
  checkFailedFor: string | null;
  /** URL of the comment that explains the block; null when none was found. */
  commentUrl: string | null;
}

const MISSING_RESULT = /\*\*Stage ended without a result\.\*\* The (\S+) session for "([^"]+)"/;

function isIn(columns: readonly string[], state: string | null): boolean {
  return state !== null && columns.some((column) => normalizeStateName(column) === normalizeStateName(state));
}

/** The first active column a role serves, in the spelling of `activeStates`. */
export function roleColumn(roleName: string, roles: readonly RoleConfig[] | null, activeStates: readonly string[]): string | null {
  const role = roles?.find((candidate) => candidate.name === roleName);
  if (role === undefined) return null;
  return activeStates.find((state) => role.states.includes(normalizeStateName(state))) ?? null;
}

/**
 * Works out why and from where an issue is blocked: the newest result marker that sent it to the blocked column, else the
 * newest "Stage ended without a result" comment, else the newest `run_finished` line of the repository log. Only
 * evidence newer than `blockedAt` minus a grace counts when `blockedAt` is known (an older marker belongs to an older block).
 */
export function classifyBlock(input: {
  results: readonly PersistedResult[];
  comments: readonly IssueComment[];
  viewer: string;
  history: readonly HistoryEntry[];
  issueIdentifier: string;
  blockedColumns: readonly string[];
  activeStates: readonly string[];
  roles: readonly RoleConfig[] | null;
  blockedAt: Date | null;
}): BlockCase {
  const since = input.blockedAt === null ? Number.NEGATIVE_INFINITY : input.blockedAt.getTime() - 10 * 60_000;
  const history = buildStageHistory(input.results);
  const blocking = history.results.findLast(
    (entry) => entry.result.kind !== 'reset' && isIn(input.blockedColumns, entry.meta.target) && Date.parse(entry.meta.created_at) >= since,
  );
  const missing = input.comments.findLast((comment) => comment.author === input.viewer && MISSING_RESULT.test(comment.body) && comment.createdAt.getTime() >= since);
  const blockingAt = blocking === undefined ? Number.NEGATIVE_INFINITY : Date.parse(blocking.meta.created_at);

  if (missing !== undefined && missing.createdAt.getTime() > blockingAt) {
    const match = MISSING_RESULT.exec(missing.body) as RegExpExecArray;
    const from = input.activeStates.find((state) => normalizeStateName(state) === normalizeStateName(match[2] as string)) ?? (match[2] as string);
    return { kind: 'missing_result', from, role: match[1] as string, blockers: [], summary: missing.body, checkFailedFor: null, commentUrl: missing.url };
  }
  if (blocking !== undefined) {
    const { result, meta } = blocking;
    const kind: BlockKind = meta.check_failed_for != null ? 'check_failed' : result.verdict === 'blocked' || result.verdict === 'needs_info' ? 'result' : 'round_limit';
    return {
      kind,
      from: roleColumn(meta.role, input.roles, input.activeStates),
      role: meta.role,
      blockers: result.blockers.map((blocker) => ({ needs: blocker.needs, description: blocker.description })),
      summary: result.summary,
      checkFailedFor: meta.check_failed_for ?? null,
      commentUrl: blocking.url ?? null,
    };
  }
  const run = input.history.findLast((entry) => entry.event === 'run_finished' && entry.fields.issue === input.issueIdentifier);
  if (run !== undefined) {
    const state = run.fields.state ?? null;
    const from = state === null ? null : (input.activeStates.find((active) => normalizeStateName(active) === normalizeStateName(state)) ?? null);
    const note = input.comments.findLast((comment) => comment.createdAt.getTime() >= since && comment.author === input.viewer);
    return { kind: 'free_text', from, role: run.fields.role ?? null, blockers: [], summary: note?.body ?? '', checkFailedFor: null, commentUrl: note?.url ?? null };
  }
  return { kind: 'unknown', from: null, role: null, blockers: [], summary: '', checkFailedFor: null, commentUrl: null };
}
