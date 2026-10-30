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
 * the event's run ('symphony' when none matches). An identifier counts once: the first source wins.
 */
export function collectActivity(sources: Iterable<ActivitySource>, sinceMs: number, untilMs: number): ActivityEvent[] {
  const seen = new Set<string>();
  const found: Array<ActivityEvent & { ms: number }> = [];
  for (const source of sources) {
    if (seen.has(source.identifier)) continue;
    seen.add(source.identifier);
    const roles = new Map(source.sessions.map((session) => [session.run, session.role]));
    for (const event of source.timeline) {
      if (event.kind !== 'agent' || event.event !== 'tool_use') continue;
      const ms = Date.parse(event.at);
      if (!Number.isFinite(ms) || ms < sinceMs || ms > untilMs) continue;
      found.push({ at: event.at, role: (event.run !== null ? roles.get(event.run) : undefined) ?? 'symphony', issue: source.identifier, ms });
    }
  }
  found.sort((a, b) => a.ms - b.ms);
  return found.map(({ at, role, issue }) => ({ at, role, issue }));
}
