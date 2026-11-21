import type { IssueComment } from '../tracker/types.ts';

/** What the watchdog did with a blocked issue, recorded in its comment. */
export type WatchdogAction = 'resume' | 'escalate' | 'comment';

/** The watchdog's record of one diagnosis, hidden in its comment as `<!-- symphony:watchdog:v1 <base64url JSON> -->`. */
export interface WatchdogMarker {
  action: WatchdogAction;
  /** The diagnosed cause (`Diagnosis.cause`). */
  cause: string;
  /** Column the issue was moved to; null when it stayed in the blocked column. */
  target: string | null;
  /** Resume number since the last human comment (1-based); 0 for a comment or an escalation. */
  attempt: number;
  /** When the issue entered the blocked column (`status_updated_at`), so one block is handled once. */
  blocked_at: string | null;
  /** sha256 (first 12 hex digits) of the prompt file the diagnosis ran with. */
  prompt_hash: string;
  created_at: string;
  /**
   * The rule decision behind the comment: `resume` or `escalate` (in mode `comment` the action alone does not tell);
   * null in markers written before re-checks existed, then derived from `action`.
   */
  decision: 'resume' | 'escalate' | null;
  /** Number of the diagnosis within this block: 0 for the first, 1.. for re-checks after the base branch moved. */
  recheck: number;
  /** Head of the repository's base branch when the diagnosis ran; null when unknown. */
  base_sha: string | null;
}

const PATTERN = /<!-- symphony:watchdog:v1 ([A-Za-z0-9_-]+) -->/;

export function encodeWatchdogMarker(marker: WatchdogMarker): string {
  return `<!-- symphony:watchdog:v1 ${Buffer.from(JSON.stringify(marker), 'utf8').toString('base64url')} -->`;
}

export function decodeWatchdogMarker(text: string): WatchdogMarker | null {
  const match = PATTERN.exec(text);
  if (match === null) return null;
  try {
    const value = JSON.parse(Buffer.from(match[1] as string, 'base64url').toString('utf8')) as Partial<WatchdogMarker>;
    if (value.action !== 'resume' && value.action !== 'escalate' && value.action !== 'comment') return null;
    if (typeof value.cause !== 'string' || typeof value.created_at !== 'string') return null;
    return {
      action: value.action,
      cause: value.cause,
      target: typeof value.target === 'string' ? value.target : null,
      attempt: typeof value.attempt === 'number' ? value.attempt : 0,
      blocked_at: typeof value.blocked_at === 'string' ? value.blocked_at : null,
      prompt_hash: typeof value.prompt_hash === 'string' ? value.prompt_hash : '',
      created_at: value.created_at,
      decision: value.decision === 'resume' || value.decision === 'escalate' ? value.decision : value.action === 'comment' ? null : value.action,
      recheck: typeof value.recheck === 'number' && Number.isInteger(value.recheck) && value.recheck >= 0 ? value.recheck : 0,
      base_sha: typeof value.base_sha === 'string' && value.base_sha !== '' ? value.base_sha : null,
    };
  } catch {
    return null;
  }
}

/** True when the comment carries a watchdog marker whose action hands the issue back to an agent. */
export function isWatchdogResume(body: string): boolean {
  return decodeWatchdogMarker(body)?.action === 'resume';
}

/** A watchdog comment with its marker, only from Symphony's own account (others cannot fake one). */
export interface WatchdogEntry {
  marker: WatchdogMarker;
  comment: IssueComment;
}

export function watchdogEntries(comments: readonly IssueComment[], viewer: string): WatchdogEntry[] {
  const entries: WatchdogEntry[] = [];
  for (const comment of comments) {
    if (comment.author !== viewer) continue;
    const marker = decodeWatchdogMarker(comment.body);
    if (marker !== null) entries.push({ marker, comment });
  }
  return entries;
}

/** The watchdog comments of one block (`blocked_at`), oldest first; [] for a block without a known start. */
export function blockEntries(entries: readonly WatchdogEntry[], blockedAt: string | null): WatchdogEntry[] {
  if (blockedAt === null) return [];
  return entries.filter((entry) => entry.marker.blocked_at === blockedAt);
}
