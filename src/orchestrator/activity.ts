import type { TimelineEvent } from './orchestrator.ts';

export const ACTIVITY_DEFAULT_MINUTES = 30;
export const ACTIVITY_MAX_MINUTES = 120;

/** One issue's timeline with the sessions that map a timeline `run` to a role. */
export interface ActivitySource {
  identifier: string;
  timeline: readonly TimelineEvent[];
  sessions: ReadonlyArray<{ run: string; role: string }>;
}

/** One tool call of an agent. */
export interface ActivityEvent {
  at: string;
  role: string;
  issue: string;
}

/**
 * The `tool_use` events of all sources within `[sinceMs, untilMs]`, oldest first. The role comes from the session of
 * the event's run ('symphony' when none matches).
 * An issue and run count once (the first source wins), so a re-claimed issue keeps the calls of both claims.
 */
export function collectActivity(sources: Iterable<ActivitySource>, sinceMs: number, untilMs: number): ActivityEvent[] {
  const seen = new Set<string>();
  const found: Array<ActivityEvent & { ms: number }> = [];
  for (const source of sources) {
    const own = new Set<string>();
    const roles = new Map(source.sessions.map((session) => [session.run, session.role]));
    for (const event of source.timeline) {
      if (event.kind !== 'agent' || event.event !== 'tool_use') continue;
      const run = `${source.identifier}\0${event.run ?? ''}`;
      if (seen.has(run)) continue;
      own.add(run);
      const ms = Date.parse(event.at);
      if (!Number.isFinite(ms) || ms < sinceMs || ms > untilMs) continue;
      found.push({ at: event.at, role: (event.run !== null ? roles.get(event.run) : undefined) ?? 'symphony', issue: source.identifier, ms });
    }
    for (const run of own) seen.add(run);
  }
  found.sort((a, b) => a.ms - b.ms);
  return found.map(({ at, role, issue }) => ({ at, role, issue }));
}
