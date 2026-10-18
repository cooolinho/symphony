// Checks of the roles scenario: a pure function over the repository log lines and the recorded status timelines.
import { parseHistoryLine, type HistoryEntry } from '../../src/history/history.ts';
import { STATUS } from './context.ts';
import { ROLE_STATUS, expectedResults } from './roles.ts';

export interface Check {
  ok: boolean;
  name: string;
  detail: string;
}

/** One observed board status of an issue (a line of timeline.jsonl). */
export interface TimelineEntry {
  at: string;
  number: number;
  status: string | null;
}

export interface RolesData {
  issues: Array<{ key: string; number: number; rejectOnce: boolean }>;
  /** Lines of the repository log of the run. */
  historyLines: string[];
  timeline: TimelineEntry[];
  agentReviewLimit: number;
  /** Highest number of agents running in `Agent review` seen in the API trace. */
  polledReviewPeak: number;
  /** Stage results recorded on the issues (`report_result` comments), oldest first. */
  results: Array<{ number: number; kind: string; verdict: string }>;
}

const same = (a: string | null | undefined, b: string) => (a ?? '').trim().toLowerCase() === b.toLowerCase();
const numberOf = (identifier: string | undefined) => Number(identifier?.split('#').at(-1));

/**
 * Expected board path after the start status. A result role has no `set_status`, so the developer's first
 * `report_result` moves the issue straight from the start status to `Agent review`; only `changes_needed` sends it
 * through `In progress`.
 */
export function expectedPath(rejectOnce: boolean): string[] {
  const rejection = rejectOnce ? [ROLE_STATUS.progress, ROLE_STATUS.review] : [];
  return [ROLE_STATUS.review, ...rejection, STATUS.handoff];
}

/** Statuses of an issue in order, without repeats and without the leading start status. */
export function observedPath(timeline: TimelineEntry[], number: number): string[] {
  const path: string[] = [];
  for (const entry of timeline) {
    if (entry.number !== number || entry.status === null) continue;
    if (!same(path.at(-1), entry.status)) path.push(entry.status);
  }
  if (same(path[0], STATUS.start)) path.shift();
  return path;
}

interface RoleRun {
  issue: number;
  role: string;
  start: number;
  end: number | null;
  outcome: string | null;
  nextRole: string | null;
  /** When the run's own result moved the issue to another column (`stage_result` with a target). */
  movedAt: number | null;
}

function roleRuns(entries: HistoryEntry[]): RoleRun[] {
  const runs = new Map<string, RoleRun>();
  for (const { event, ts, fields } of entries) {
    if (event !== 'run_started' && event !== 'run_finished' && event !== 'stage_result') continue;
    const run = runs.get(fields.run ?? '') ?? {
      issue: numberOf(fields.issue),
      role: fields.role ?? 'default',
      start: Date.parse(fields.started_at ?? ts),
      end: null,
      outcome: null,
      nextRole: null,
      movedAt: null,
    };
    if (event === 'stage_result') {
      if (fields.target !== undefined) run.movedAt = Date.parse(ts);
    } else if (event === 'run_started') {
      run.start = Date.parse(ts);
      run.role = fields.role ?? 'default';
    } else {
      run.end = Date.parse(ts);
      run.outcome = fields.outcome ?? null;
      run.nextRole = fields.next_role ?? null;
    }
    runs.set(fields.run ?? '', run);
  }
  return [...runs.values()].sort((a, b) => a.start - b.start);
}

/**
 * Highest number of runs in their column at the same time. Like Symphony's column limit, a run counts until its own
 * result moved the issue on (the rest of its turn holds no slot of the column), else until it ended or until `now`.
 */
function peakOverlap(runs: RoleRun[], now: number): number {
  const events = runs.flatMap((run) => [
    { at: run.start, delta: 1 },
    { at: run.movedAt ?? run.end ?? now, delta: -1 },
  ]);
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let current = 0;
  let peak = 0;
  for (const event of events) peak = Math.max(peak, (current += event.delta));
  return peak;
}

export function verifyRoles(data: RolesData): Check[] {
  const entries = data.historyLines.map(parseHistoryLine).filter((entry): entry is HistoryEntry => entry !== null);
  const runs = roleRuns(entries);
  const checks: Check[] = [];

  const wrongPath = data.issues.flatMap((issue) => {
    const observed = observedPath(data.timeline, issue.number);
    const expected = expectedPath(issue.rejectOnce);
    const ok = observed.length === expected.length && observed.every((status, index) => same(status, expected[index] as string));
    return ok ? [] : [`${issue.key}: ${observed.join(' → ') || '(nothing)'}, expected ${expected.join(' → ')}`];
  });
  checks.push({
    ok: wrongPath.length === 0,
    name: 'Status path per issue',
    detail: wrongPath.join('; ') || data.issues.map((issue) => `${issue.key}: ${observedPath(data.timeline, issue.number).join(' → ')}`).join('; '),
  });

  const done = data.issues.filter((issue) => data.timeline.some((entry) => entry.number === issue.number && same(entry.status, STATUS.done)));
  checks.push({
    ok: done.length === 0,
    name: `No issue reached "${STATUS.done}"`,
    detail: done.length === 0 ? 'none' : `in "${STATUS.done}": ${done.map((issue) => issue.key).join(', ')}`,
  });

  const reviewChecks = entries.filter((entry) => entry.event === 'checks_finished' && same(entry.fields.target, ROLE_STATUS.review));
  const wrongChecks = data.issues.flatMap((issue) => {
    const own = reviewChecks.filter((entry) => numberOf(entry.fields.issue) === issue.number);
    const failed = own.filter((entry) => entry.fields.result !== 'passed');
    const ok = failed.length === 1 && own[0] === failed[0] && own.length > failed.length;
    return ok ? [] : [`${issue.key}: ${own.map((entry) => entry.fields.result).join(', ') || 'no check'}`];
  });
  checks.push({
    ok: wrongChecks.length === 0,
    name: `One denied entry check per issue, then passed ("${ROLE_STATUS.review}")`,
    detail: wrongChecks.join('; ') || `${reviewChecks.length} checks`,
  });

  const wrongResults = data.issues.flatMap((issue) => {
    const observed = data.results.filter((result) => result.number === issue.number).map((result) => `${result.kind}:${result.verdict}`);
    const expected = expectedResults(issue.rejectOnce);
    return observed.join(',') === expected.join(',') ? [] : [`${issue.key}: ${observed.join(', ') || '(nothing)'}, expected ${expected.join(', ')}`];
  });
  checks.push({
    ok: wrongResults.length === 0,
    name: 'Stage results per issue (report_result)',
    detail: wrongResults.join('; ') || data.issues.map((issue) => `${issue.key}: ${expectedResults(issue.rejectOnce).length} results`).join('; '),
  });

  const count = (event: string, match: (entry: HistoryEntry) => boolean = () => true) =>
    entries.filter((entry) => entry.event === event && match(entry)).length;
  const counts = {
    checks_finished: count('checks_finished'),
    handed_off: count('run_finished', (entry) => entry.fields.outcome === 'handed_off'),
  };
  const missingHandoffs = data.issues.flatMap((issue) => {
    const own = runs.filter((run) => run.issue === issue.number);
    const toReviewer = own.some((run) => run.role === 'developer' && run.outcome === 'handed_off' && run.nextRole === 'reviewer');
    const back = own.some((run) => run.role === 'reviewer' && run.outcome === 'handed_off' && run.nextRole === 'developer');
    const last = own.filter((run) => run.end !== null).at(-1);
    const final = last?.role === 'reviewer' && last.outcome === 'handed_off' && last.nextRole === null;
    return [
      ...(toReviewer ? [] : [`${issue.key}: no developer → reviewer handoff`]),
      ...(issue.rejectOnce && !back ? [`${issue.key}: no reviewer → developer handoff`] : []),
      ...(final ? [] : [`${issue.key}: last run is not the reviewer's handoff`]),
    ];
  });
  checks.push({
    ok: Object.values(counts).every((n) => n > 0) && missingHandoffs.length === 0,
    name: 'Repository log has checks_finished and handed_off',
    detail: [Object.entries(counts).map(([event, n]) => `${event} ${n}`).join(', '), ...missingHandoffs].join('; '),
  });

  const reviewerRuns = runs.filter((run) => run.role === 'reviewer');
  const lastSeen = Math.max(0, ...entries.map((entry) => Date.parse(entry.ts)).filter(Number.isFinite));
  const peak = peakOverlap(reviewerRuns, lastSeen);
  checks.push({
    ok: reviewerRuns.length > 0 && peak <= data.agentReviewLimit && data.polledReviewPeak <= data.agentReviewLimit,
    name: `At most ${data.agentReviewLimit} agent(s) in "${ROLE_STATUS.review}"`,
    detail: `peak ${peak} of ${reviewerRuns.length} reviewer runs in the history, ${data.polledReviewPeak} in the API trace`,
  });

  return checks;
}
