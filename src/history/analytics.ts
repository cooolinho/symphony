import { bareModelName } from '../agent/model-name.ts';
import { costOf, priceFor, totalTokens, type ModelTokenUsage, type PricingTable } from '../costs/pricing.ts';
import { parseCounts, type HistoryEntry } from './history.ts';

/**
 * Analytics for the statistics page, aggregated on the server for one central filter. Every figure comes from
 * the repository logs: `run_finished` lines (outcome, attempt, timing), their `model_usage` lines (tokens per
 * model, priced with the current model-costs.yml exactly like computeHistoryStats) and `issue_paused` notes. Tool
 * usage comes from `tool_calls`, `skill_calls` and the integration fields of `run_finished` (runs logged before these
 * fields existed count as runs without tool calls).
 */
export interface AnalyticsFilter {
  /** Inclusive start; null = since the first logged run. */
  from: Date | null;
  /** Exclusive end; null = now. */
  to: Date | null;
  /** owner/name, compared case-insensitively; null = all repositories. */
  repo: string | null;
  /** Model id; keeps runs that used it and counts only its tokens and cost. Null = all models. */
  model: string | null;
  /** Effort requested for the run (`low` … `max`, `default`); null = all efforts. */
  effort?: string | null;
  /** IANA time zone for buckets, weekdays and hours (the browser's). */
  timeZone: string;
}

/** Order of the effort rows: Claude Code's default first, then the levels from low to max, then anything else. */
const EFFORT_ORDER = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];

function effortRank(effort: string): number {
  const index = EFFORT_ORDER.indexOf(effort);
  return index === -1 ? EFFORT_ORDER.length : index;
}

const byEffort = (a: string, b: string): number => effortRank(a) - effortRank(b) || a.localeCompare(b);

/** Effort of a run as logged; runs from before the effort was logged count as `unknown`. */
const UNKNOWN_EFFORT = 'unknown';

export type Granularity = 'hour' | 'day' | 'week' | 'month';

/** Thresholds of the "Needs attention" section, returned with the data so the page can show them. */
export const ATTENTION_RULES = {
  /** A run costs, takes or consumes at least this multiple of the period's average run. */
  factor: 3,
  /** Averages need at least this many runs in the period to mean anything. */
  minRuns: 5,
  /** Failed or retried runs of one issue in the period. */
  repeated: 3,
} as const;

/** Percentiles need enough runs; below these counts the page shows only average, min and max. */
const MEDIAN_MIN_RUNS = 3;
const PERCENTILE_MIN_RUNS = 20;
const TOP_LIMIT = 5;
const ATTENTION_LIMIT = 10;
/** Rows of the tool and skill rankings. */
const TOOL_LIMIT = 25;

/** Run duration histogram: upper bounds in seconds (the last bucket is open). */
const DURATION_BUCKETS: Array<{ label: string; max: number }> = [
  { label: '< 30s', max: 30 },
  { label: '30s–1m', max: 60 },
  { label: '1–5m', max: 300 },
  { label: '5–10m', max: 600 },
  { label: '10–30m', max: 1800 },
  { label: '30–60m', max: 3600 },
  { label: '> 1h', max: Infinity },
];

const SUCCESS = new Set(['handed_off', 'continuing']);
const FAILURE = new Set(['failed', 'session_limit', 'stalled']);
const STOPPED = new Set(['stopped', 'shutdown']);

interface UsagePart {
  model: string;
  usage: ModelTokenUsage;
  cost: number;
}

/** One finished run, joined with its model lines. */
interface Run {
  repo: string;
  issue: string;
  title: string;
  run: string;
  finishedAt: string;
  finishedMs: number;
  startedMs: number;
  outcome: string;
  state: string;
  seconds: number;
  /**
   * Model with the most tokens in the run (`model` of the run_finished line); for a run without logged usage
   * the requested model (`model_requested`, else the run_started line), so the run still shows under its model.
   */
  primaryModel: string | null;
  /** Effort requested for the run (`effort` of run_finished, else of run_started); null when not logged. */
  effort: string | null;
  /** Dispatched after a failed or stalled run of the same issue. */
  retry: boolean;
  parts: UsagePart[];
  /** Tool calls by tool name (built-in and `mcp__<server>__<tool>`). */
  tools: Record<string, number>;
  /** Skill tool calls by skill. */
  skills: Record<string, number>;
  /** Workspace integrations of the run (e.g. Laravel Boost) by id: status and attributed calls. */
  integrations: Map<string, { status: string; tools: Record<string, number>; skills: Record<string, number> }>;
}

interface Totals {
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_usd: number;
  agent_seconds: number;
  successful: number;
  failed: number;
  stopped: number;
  retries: number;
}

function emptyTotals(): Totals {
  return {
    runs: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
    total_tokens: 0, cost_usd: 0, agent_seconds: 0, successful: 0, failed: 0, stopped: 0, retries: 0,
  };
}

function addRun(target: Totals, run: Run): void {
  target.runs += 1;
  target.agent_seconds += run.seconds;
  for (const part of run.parts) addPart(target, part);
  if (SUCCESS.has(run.outcome)) target.successful += 1;
  else if (FAILURE.has(run.outcome)) target.failed += 1;
  else if (STOPPED.has(run.outcome)) target.stopped += 1;
  if (run.retry) target.retries += 1;
}

function addPart(target: Totals, part: UsagePart): void {
  target.input_tokens += part.usage.inputTokens;
  target.output_tokens += part.usage.outputTokens;
  target.cache_read_tokens += part.usage.cacheReadTokens;
  target.cache_write_tokens += part.usage.cacheWriteTokens;
  target.total_tokens += totalTokens(part.usage);
  target.cost_usd += part.cost;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const ratio = (a: number, b: number, digits = 4): number | null => (b > 0 ? round(a / b, digits) : null);

function tokensOf(run: Run): number {
  let sum = 0;
  for (const part of run.parts) sum += totalTokens(part.usage);
  return sum;
}

function costOfRun(run: Run): number {
  let sum = 0;
  for (const part of run.parts) sum += part.cost;
  return sum;
}

/** Totals plus the derived per-run figures, rounded for JSON. */
function summarize(totals: Totals) {
  return {
    ...totals,
    cost_usd: round(totals.cost_usd, 4),
    agent_seconds: round(totals.agent_seconds, 1),
    avg_run_seconds: ratio(totals.agent_seconds, totals.runs, 1),
    avg_cost_per_run: ratio(totals.cost_usd, totals.runs),
    avg_tokens_per_run: ratio(totals.total_tokens, totals.runs, 0),
    retry_rate: ratio(totals.retries, totals.runs),
    failure_rate: ratio(totals.failed, totals.runs),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Time zone helpers: buckets follow the wall clock of the requested zone.

const formatters = new Map<string, Intl.DateTimeFormat>();

/** True when Intl knows the zone. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
}

function localParts(ms: number, timeZone: string): LocalParts {
  let format = formatters.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    });
    formatters.set(timeZone, format);
  }
  const parts: Record<string, string> = {};
  for (const part of format.formatToParts(new Date(ms))) parts[part.type] = part.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const weekday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
  return { year, month, day, hour: Number(parts.hour) % 24, weekday };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Bucket key in the zone: `2026-10-05T14`, `2026-10-05`, the Monday `2026-10-05` of a week, or `2026-10`. */
function bucketKey(ms: number, granularity: Granularity, timeZone: string): string {
  const p = localParts(ms, timeZone);
  const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  if (granularity === 'hour') return `${date}T${pad(p.hour)}`;
  if (granularity === 'day') return date;
  if (granularity === 'month') return `${p.year}-${pad(p.month)}`;
  const monday = new Date(Date.UTC(p.year, p.month - 1, p.day - p.weekday));
  return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Coarser buckets for longer periods, so a chart never needs more than ~100 points. */
export function granularityFor(spanMs: number): Granularity {
  if (spanMs <= 2 * DAY) return 'hour';
  if (spanMs <= 92 * DAY) return 'day';
  if (spanMs <= 730 * DAY) return 'week';
  return 'month';
}

/** Every bucket key between two instants, in order, including empty ones. */
function bucketKeys(startMs: number, endMs: number, granularity: Granularity, timeZone: string): string[] {
  // Stepping by an hour (or three) visits every local hour/day even across DST changes; keys are deduplicated.
  const step = granularity === 'hour' ? HOUR : 3 * HOUR;
  const keys: string[] = [];
  let last = '';
  for (let ms = startMs; ms < endMs; ms += step) {
    const key = bucketKey(ms, granularity, timeZone);
    if (key !== last) keys.push(key);
    last = key;
  }
  const final = bucketKey(Math.max(startMs, endMs - 1), granularity, timeZone);
  if (final !== last) keys.push(final);
  return keys;
}

// ---------------------------------------------------------------------------------------------------------------

function usageFromFields(fields: Record<string, string>): ModelTokenUsage {
  return {
    inputTokens: Number(fields.input_tokens) || 0,
    outputTokens: Number(fields.output_tokens) || 0,
    cacheReadTokens: Number(fields.cache_read_tokens) || 0,
    cacheWriteTokens: Number(fields.cache_write_tokens) || 0,
  };
}

/** A logged field that is absent, empty or `null` → null. */
function fieldOrNull(value: string | undefined): string | null {
  return value === undefined || value === '' || value === 'null' ? null : value;
}

/**
 * Maps a requested model to the id Claude Code reported for it, so a run without logged usage lands in the same
 * row as the runs of that model: an alias (`opus`) becomes the reported id of its family with the most runs
 * (`claude-opus-5-5`); a full id, or an alias of a family that never reported usage (`fable` before its first
 * completed run), stays as it is.
 */
function requestedModelResolver(runsByModel: Map<string, number>): (requested: string) => string {
  const cache = new Map<string, string>();
  return (requested) => {
    let resolved = cache.get(requested);
    if (resolved === undefined) {
      const alias = bareModelName(requested);
      let best: { model: string; runs: number } | null = null;
      for (const [model, runs] of runsByModel) {
        const bare = bareModelName(model);
        if (bare !== alias && !bare.startsWith(`${alias}-`)) continue;
        if (best === null || runs > best.runs || (runs === best.runs && model < best.model)) best = { model, runs };
      }
      resolved = best?.model ?? requested;
      cache.set(requested, resolved);
    }
    return resolved;
  };
}

/** All finished runs in time order, joined with their model lines and marked as retries. */
function collectRuns(entries: HistoryEntry[], pricing: PricingTable): Run[] {
  const usageByRun = new Map<string, UsagePart[]>();
  // Requested model and effort of older runs, whose run_finished line does not carry them yet.
  const startByRun = new Map<string, { model: string | null; effort: string | null }>();
  const runsByModel = new Map<string, number>();
  for (const entry of entries) {
    if (entry.event === 'run_started') {
      if (entry.fields.run !== undefined) startByRun.set(entry.fields.run, { model: fieldOrNull(entry.fields.model), effort: fieldOrNull(entry.fields.effort) });
      continue;
    }
    if (entry.event !== 'model_usage') continue;
    const model = entry.fields.model ?? 'unknown';
    const usage = usageFromFields(entry.fields);
    const run = entry.fields.run ?? entry.ts;
    const parts = usageByRun.get(run) ?? [];
    parts.push({ model, usage, cost: costOf(usage, priceFor(pricing, model).price) });
    usageByRun.set(run, parts);
    runsByModel.set(model, (runsByModel.get(model) ?? 0) + 1);
  }
  const resolveRequested = requestedModelResolver(runsByModel);
  const lastOutcome = new Map<string, string>();
  const runs: Run[] = [];
  for (const entry of entries) {
    if (entry.event !== 'run_finished') continue;
    const finishedMs = Date.parse(entry.ts);
    if (!Number.isFinite(finishedMs)) continue;
    const issue = entry.fields.issue ?? 'unknown';
    const startedMs = Date.parse(entry.fields.started_at ?? '');
    const outcome = entry.fields.outcome ?? 'unknown';
    const start = startByRun.get(entry.fields.run ?? '');
    const parts = usageByRun.get(entry.fields.run ?? '') ?? [];
    const requested = fieldOrNull(entry.fields.model_requested) ?? start?.model ?? null;
    const model = fieldOrNull(entry.fields.model) ?? (parts.length === 0 && requested !== null ? resolveRequested(requested) : null);
    runs.push({
      repo: entry.fields.repo ?? 'unknown',
      issue,
      title: entry.fields.title ?? '',
      run: entry.fields.run ?? entry.ts,
      finishedAt: entry.ts,
      finishedMs,
      startedMs: Number.isFinite(startedMs) ? startedMs : finishedMs,
      outcome,
      state: entry.fields.state ?? '',
      seconds: Number(entry.fields.agent_seconds) || 0,
      primaryModel: model,
      effort: fieldOrNull(entry.fields.effort) ?? start?.effort ?? null,
      retry: FAILURE.has(lastOutcome.get(issue) ?? ''),
      parts,
      tools: parseCounts(entry.fields.tool_calls),
      skills: parseCounts(entry.fields.skill_calls),
      integrations: runIntegrations(entry.fields),
    });
    lastOutcome.set(issue, outcome);
  }
  return runs;
}

/** `integrations=laravel-boost:ready` with `integration_tools`/`integration_skills` (`<id>/<name>:<count>`) by integration id. */
function runIntegrations(fields: Record<string, string>): Run['integrations'] {
  const result: Run['integrations'] = new Map();
  for (const [id, status] of Object.entries(parseStatuses(fields.integrations))) result.set(id, { status, tools: {}, skills: {} });
  for (const kind of ['tools', 'skills'] as const) {
    for (const [key, count] of Object.entries(parseCounts(fields[`integration_${kind}`]))) {
      const slash = key.indexOf('/');
      if (slash <= 0) continue;
      const integration = result.get(key.slice(0, slash));
      if (integration === undefined) continue;
      const name = key.slice(slash + 1);
      integration[kind][name] = (integration[kind][name] ?? 0) + count;
    }
  }
  return result;
}

/** `laravel-boost:ready,other:off` → id → status. */
function parseStatuses(value: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (value ?? '').split(',')) {
    const at = part.lastIndexOf(':');
    if (at > 0) result[part.slice(0, at)] = part.slice(at + 1);
  }
  return result;
}

interface CallRow {
  calls: number;
  runs: number;
}

/** Adds the calls of one run to a ranking (`runs` counts the runs that called it). */
function addCalls(target: Map<string, CallRow>, calls: Record<string, number>): void {
  for (const [name, count] of Object.entries(calls)) {
    if (count <= 0) continue;
    const row = target.get(name) ?? { calls: 0, runs: 0 };
    row.calls += count;
    row.runs += 1;
    target.set(name, row);
  }
}

function ranking<K extends string>(rows: Map<string, CallRow>, key: K, limit = TOOL_LIMIT): Array<Record<K, string> & CallRow> {
  return [...rows]
    .sort((a, b) => b[1].calls - a[1].calls || b[1].runs - a[1].runs || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, row]) => ({ [key]: name, ...row }) as Record<K, string> & CallRow);
}

const sumCalls = (calls: Record<string, number>): number => Object.values(calls).reduce((sum, count) => sum + count, 0);

/**
 * Tool usage of the runs: calls per tool and skill, and per workspace integration (e.g. Laravel Boost) the runs
 * it was ready in, the runs that used it, and its calls per tool and skill.
 */
function toolStats(runs: Run[]) {
  const tools = new Map<string, CallRow>();
  const skills = new Map<string, CallRow>();
  const integrations = new Map<string, { runs: number; by_status: Record<string, number>; ready_runs: number; used_runs: number; calls: number; tools: Map<string, CallRow>; skills: Map<string, CallRow> }>();
  let calls = 0;
  let runsWithCalls = 0;
  for (const run of runs) {
    const runCalls = sumCalls(run.tools);
    calls += runCalls;
    if (runCalls > 0) runsWithCalls += 1;
    addCalls(tools, run.tools);
    addCalls(skills, run.skills);
    for (const [id, entry] of run.integrations) {
      let target = integrations.get(id);
      if (target === undefined) {
        target = { runs: 0, by_status: {}, ready_runs: 0, used_runs: 0, calls: 0, tools: new Map(), skills: new Map() };
        integrations.set(id, target);
      }
      const used = sumCalls(entry.tools) + sumCalls(entry.skills);
      target.runs += 1;
      target.by_status[entry.status] = (target.by_status[entry.status] ?? 0) + 1;
      if (entry.status === 'ready') target.ready_runs += 1;
      if (used > 0) target.used_runs += 1;
      target.calls += used;
      addCalls(target.tools, entry.tools);
      addCalls(target.skills, entry.skills);
    }
  }
  return {
    runs: runs.length,
    runs_with_calls: runsWithCalls,
    calls,
    avg_calls_per_run: ratio(calls, runsWithCalls, 1),
    distinct_tools: tools.size,
    tools: ranking(tools, 'tool').map((row) => {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(row.tool);
      return { ...row, server: mcp?.[1] ?? null, name: mcp?.[2] ?? row.tool };
    }),
    skills: ranking(skills, 'skill'),
    integrations: [...integrations]
      .sort((a, b) => b[1].runs - a[1].runs || a[0].localeCompare(b[0]))
      .map(([id, entry]) => ({
        id,
        runs: entry.runs,
        by_status: entry.by_status,
        ready_runs: entry.ready_runs,
        used_runs: entry.used_runs,
        use_rate: ratio(entry.used_runs, entry.ready_runs),
        calls: entry.calls,
        avg_calls_per_used_run: ratio(entry.calls, entry.used_runs, 1),
        tools: ranking(entry.tools, 'tool'),
        skills: ranking(entry.skills, 'skill'),
      })),
  };
}

/**
 * Repository, model and effort filter; with a model filter, each run keeps only that model's usage (a run
 * without logged usage matches by its requested model).
 */
function narrow(runs: Run[], filter: AnalyticsFilter): Run[] {
  const repo = filter.repo?.toLowerCase() ?? null;
  const model = filter.model;
  const effort = filter.effort ?? null;
  const result: Run[] = [];
  for (const run of runs) {
    if (repo !== null && run.repo.toLowerCase() !== repo) continue;
    if (effort !== null && (run.effort ?? UNKNOWN_EFFORT) !== effort) continue;
    if (model === null) {
      result.push(run);
      continue;
    }
    if (run.parts.length === 0) {
      if (run.primaryModel === model) result.push(run);
      continue;
    }
    const parts = run.parts.filter((part) => part.model === model);
    if (parts.length > 0) result.push({ ...run, parts });
  }
  return result;
}

function percentile(sorted: number[], p: number): number {
  // Nearest-rank on the sorted durations.
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] as number;
}

function runRef(run: Run) {
  return {
    issue: run.issue,
    repo: run.repo,
    title: run.title,
    run: run.run,
    finished_at: run.finishedAt,
    outcome: run.outcome,
    model: run.primaryModel,
    effort: run.effort,
    total_tokens: tokensOf(run),
    cost_usd: round(costOfRun(run), 4),
    agent_seconds: round(run.seconds, 1),
  };
}

/**
 * Everything the statistics page shows for one filter. `now` is the end of an open period (`to` = null).
 */
export function computeAnalytics(entries: HistoryEntry[], pricing: PricingTable, filter: AnalyticsFilter, now = new Date()) {
  const allRuns = collectRuns(entries, pricing);
  const scoped = narrow(allRuns, filter);
  const toMs = filter.to?.getTime() ?? now.getTime();
  const fromMs = filter.from?.getTime() ?? null;
  const inPeriod = (ms: number) => (fromMs === null || ms >= fromMs) && ms < toMs;
  const runs = scoped.filter((run) => inPeriod(run.finishedMs));

  const repoFilter = filter.repo?.toLowerCase() ?? null;
  const inScope = (entry: HistoryEntry) => repoFilter === null || (entry.fields.repo ?? '').toLowerCase() === repoFilter;
  const firstEntryMs = (() => {
    for (const entry of entries) if (inScope(entry)) return Date.parse(entry.ts);
    return null;
  })();

  // Period bounds: an open start begins with the first run in scope.
  const startMs = fromMs ?? scoped[0]?.finishedMs ?? null;

  // KPIs and the previous period of equal length (only when the logs cover all of it).
  const totals = emptyTotals();
  const issues = new Set<string>();
  const repos = new Set<string>();
  for (const run of runs) {
    addRun(totals, run);
    issues.add(run.issue);
    repos.add(run.repo);
  }
  // Paused issues are issue-level notes without model usage; a model filter cannot attribute them.
  const paused =
    filter.model === null
      ? entries.filter((entry) => entry.event === 'issue_paused' && inScope(entry) && inPeriod(Date.parse(entry.ts))).length
      : null;

  let previous: (ReturnType<typeof summarize> & { issues: number; from: string; to: string }) | null = null;
  if (fromMs !== null && firstEntryMs !== null && firstEntryMs <= fromMs - (toMs - fromMs)) {
    const prevFrom = fromMs - (toMs - fromMs);
    const prevTotals = emptyTotals();
    const prevIssues = new Set<string>();
    for (const run of scoped) {
      if (run.finishedMs < prevFrom || run.finishedMs >= fromMs) continue;
      addRun(prevTotals, run);
      prevIssues.add(run.issue);
    }
    previous = { ...summarize(prevTotals), issues: prevIssues.size, from: new Date(prevFrom).toISOString(), to: new Date(fromMs).toISOString() };
  }

  // Time series with contiguous buckets.
  const granularity = granularityFor(startMs === null ? 0 : toMs - startMs);
  const keys = startMs === null || runs.length === 0 ? [] : bucketKeys(startMs, toMs, granularity, filter.timeZone);
  const buckets = new Map(keys.map((key) => [key, { key, ...emptyTotals(), by_repo: {} as Record<string, { runs: number; total_tokens: number; cost_usd: number; agent_seconds: number }> }]));
  for (const run of runs) {
    const bucket = buckets.get(bucketKey(run.finishedMs, granularity, filter.timeZone));
    if (bucket === undefined) continue;
    addRun(bucket, run);
    const slot = (bucket.by_repo[run.repo] ??= { runs: 0, total_tokens: 0, cost_usd: 0, agent_seconds: 0 });
    slot.runs += 1;
    slot.total_tokens += tokensOf(run);
    slot.cost_usd += costOfRun(run);
    slot.agent_seconds += run.seconds;
  }
  const series = [...buckets.values()].map((bucket) => ({
    ...summarize(bucket),
    key: bucket.key,
    by_repo: Object.fromEntries(
      Object.entries(bucket.by_repo).map(([repo, v]) => [repo, { ...v, cost_usd: round(v.cost_usd, 4), agent_seconds: round(v.agent_seconds, 1) }]),
    ),
  }));

  // Models: runs = runs that used the model; agent time = runs where it was the primary model. A run without
  // logged usage counts under its requested model with zero tokens, so every model that ran is listed.
  const models = new Map<string, Totals & { model: string; price: string; runIds: Set<string>; primary_runs: number; primary_seconds: number }>();
  const modelRow = (id: string) => {
    let model = models.get(id);
    if (model === undefined) {
      model = { ...emptyTotals(), model: id, price: priceFor(pricing, id).key, runIds: new Set(), primary_runs: 0, primary_seconds: 0 };
      models.set(id, model);
    }
    return model;
  };
  for (const run of runs) {
    for (const part of run.parts) {
      const model = modelRow(part.model);
      model.runIds.add(run.run);
      addPart(model, part);
    }
    if (run.parts.length === 0 && run.primaryModel !== null) modelRow(run.primaryModel).runIds.add(run.run);
    const primary = run.primaryModel !== null ? models.get(run.primaryModel) : undefined;
    if (primary !== undefined) {
      primary.primary_runs += 1;
      primary.primary_seconds += run.seconds;
    }
  }

  // Efforts: the requested effort of each run, with the models it ran (by primary model).
  const efforts = new Map<string, Totals & { effort: string; models: Record<string, number> }>();
  for (const run of runs) {
    const key = run.effort ?? UNKNOWN_EFFORT;
    let effort = efforts.get(key);
    if (effort === undefined) {
      effort = { ...emptyTotals(), effort: key, models: {} };
      efforts.set(key, effort);
    }
    addRun(effort, run);
    if (run.primaryModel !== null) effort.models[run.primaryModel] = (effort.models[run.primaryModel] ?? 0) + 1;
  }
  const effortRows = [...efforts.values()]
    .map((effort) => ({
      ...summarize(effort),
      effort: effort.effort,
      models: effort.models,
      success_rate: ratio(effort.successful, effort.runs),
      cost_share: ratio(effort.cost_usd, totals.cost_usd),
      token_share: ratio(effort.total_tokens, totals.total_tokens),
    }))
    .sort((a, b) => byEffort(a.effort, b.effort));
  const modelRows = [...models.values()]
    .map(({ runIds, primary_seconds, successful: _s, failed: _f, stopped: _st, retries: _r, agent_seconds: _a, runs: _n, ...rest }) => {
      const runCount = runIds.size;
      const input = rest.input_tokens + rest.cache_read_tokens + rest.cache_write_tokens;
      return {
        ...rest,
        runs: runCount,
        cost_usd: round(rest.cost_usd, 4),
        agent_seconds: round(primary_seconds, 1),
        avg_run_seconds: ratio(primary_seconds, rest.primary_runs, 1),
        avg_cost_per_run: ratio(rest.cost_usd, runCount),
        avg_tokens_per_run: ratio(rest.total_tokens, runCount, 0),
        cost_per_million_tokens: ratio(rest.cost_usd * 1_000_000, rest.total_tokens),
        output_input_ratio: ratio(rest.output_tokens, input),
        cost_share: ratio(rest.cost_usd, totals.cost_usd),
        token_share: ratio(rest.total_tokens, totals.total_tokens),
      };
    })
    .sort((a, b) => b.cost_usd - a.cost_usd);

  // Repositories.
  const repoAgg = new Map<string, Totals & { repo: string; issues: Set<string>; last_at: string | null }>();
  // Issues.
  const issueAgg = new Map<string, Totals & { issue: string; repo: string; title: string; first_started_at: string | null; last_finished_at: string | null; last_outcome: string | null; last_state: string | null }>();
  for (const run of runs) {
    let repo = repoAgg.get(run.repo);
    if (repo === undefined) {
      repo = { ...emptyTotals(), repo: run.repo, issues: new Set(), last_at: null };
      repoAgg.set(run.repo, repo);
    }
    addRun(repo, run);
    repo.issues.add(run.issue);
    repo.last_at = run.finishedAt;

    let issue = issueAgg.get(run.issue);
    if (issue === undefined) {
      issue = { ...emptyTotals(), issue: run.issue, repo: run.repo, title: run.title, first_started_at: null, last_finished_at: null, last_outcome: null, last_state: null };
      issueAgg.set(run.issue, issue);
    }
    addRun(issue, run);
    issue.title = run.title || issue.title;
    issue.first_started_at ??= new Date(run.startedMs).toISOString();
    issue.last_finished_at = run.finishedAt;
    issue.last_outcome = run.outcome;
    issue.last_state = run.state;
  }
  const repositoryRows = [...repoAgg.values()]
    .map(({ issues: set, ...rest }) => ({ ...summarize(rest), repo: rest.repo, last_at: rest.last_at, issues: set.size }))
    .sort((a, b) => b.cost_usd - a.cost_usd);
  const issueRows = [...issueAgg.values()]
    .map((issue) => ({ ...summarize(issue), issue: issue.issue, repo: issue.repo, title: issue.title, first_started_at: issue.first_started_at, last_finished_at: issue.last_finished_at, last_outcome: issue.last_outcome, last_state: issue.last_state }))
    .sort((a, b) => ((a.last_finished_at ?? '') < (b.last_finished_at ?? '') ? 1 : -1));

  // Outcomes as logged.
  const byOutcome: Record<string, number> = {};
  for (const run of runs) byOutcome[run.outcome] = (byOutcome[run.outcome] ?? 0) + 1;

  // Durations.
  const sorted = runs.map((run) => run.seconds).sort((a, b) => a - b);
  const shortest = runs.reduce<Run | null>((best, run) => (best === null || run.seconds < best.seconds ? run : best), null);
  const longest = runs.reduce<Run | null>((best, run) => (best === null || run.seconds > best.seconds ? run : best), null);
  const histogram = DURATION_BUCKETS.map((bucket) => ({ label: bucket.label, max_seconds: Number.isFinite(bucket.max) ? bucket.max : null, runs: 0 }));
  for (const seconds of sorted) {
    const index = DURATION_BUCKETS.findIndex((bucket) => seconds < bucket.max);
    (histogram[index] as { runs: number }).runs += 1;
  }
  const durations = {
    runs: sorted.length,
    total_seconds: round(totals.agent_seconds, 1),
    avg_seconds: ratio(totals.agent_seconds, sorted.length, 1),
    min_seconds: sorted.length ? round(sorted[0] as number, 1) : null,
    max_seconds: sorted.length ? round(sorted.at(-1) as number, 1) : null,
    p50_seconds: sorted.length >= MEDIAN_MIN_RUNS ? round(percentile(sorted, 50), 1) : null,
    p90_seconds: sorted.length >= PERCENTILE_MIN_RUNS ? round(percentile(sorted, 90), 1) : null,
    p95_seconds: sorted.length >= PERCENTILE_MIN_RUNS ? round(percentile(sorted, 95), 1) : null,
    shortest: shortest === null ? null : runRef(shortest),
    longest: longest === null ? null : runRef(longest),
    histogram,
  };

  // Heatmap of run start times: [weekday Monday..Sunday][hour].
  const heatmap = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const run of runs) {
    const p = localParts(run.startedMs, filter.timeZone);
    (heatmap[p.weekday] as number[])[p.hour] = ((heatmap[p.weekday] as number[])[p.hour] ?? 0) + 1;
  }

  // Top runs and issues.
  const topBy = (value: (run: Run) => number) =>
    [...runs].filter((run) => value(run) > 0).sort((a, b) => value(b) - value(a)).slice(0, TOP_LIMIT).map(runRef);
  const top = {
    cost: topBy(costOfRun),
    tokens: topBy(tokensOf),
    duration: topBy((run) => run.seconds),
    retried: issueRows.filter((issue) => issue.retries > 0).sort((a, b) => b.retries - a.retries || b.runs - a.runs).slice(0, TOP_LIMIT)
      .map((issue) => ({ issue: issue.issue, repo: issue.repo, title: issue.title, retries: issue.retries, failed: issue.failed, runs: issue.runs, last_outcome: issue.last_outcome })),
  };

  // Needs attention: plain multiples of the period's average and repeated failures/retries.
  const attention: Array<{ kind: 'cost' | 'duration' | 'tokens' | 'failures' | 'retries'; issue: string; repo: string; title: string; run: string | null; at: string | null; value: number; average: number | null; factor: number | null }> = [];
  if (runs.length >= ATTENTION_RULES.minRuns) {
    const checks: Array<['cost' | 'duration' | 'tokens', (run: Run) => number]> = [['cost', costOfRun], ['duration', (run) => run.seconds], ['tokens', tokensOf]];
    for (const [kind, value] of checks) {
      const average = runs.reduce((sum, run) => sum + value(run), 0) / runs.length;
      if (average <= 0) continue;
      for (const run of runs) {
        const factor = value(run) / average;
        if (factor >= ATTENTION_RULES.factor) {
          attention.push({ kind, issue: run.issue, repo: run.repo, title: run.title, run: run.run, at: run.finishedAt, value: round(value(run), 4), average: round(average, 4), factor: round(factor, 1) });
        }
      }
    }
  }
  for (const issue of issueRows) {
    if (issue.failed >= ATTENTION_RULES.repeated) {
      attention.push({ kind: 'failures', issue: issue.issue, repo: issue.repo, title: issue.title, run: null, at: issue.last_finished_at, value: issue.failed, average: null, factor: null });
    }
    if (issue.retries >= ATTENTION_RULES.repeated) {
      attention.push({ kind: 'retries', issue: issue.issue, repo: issue.repo, title: issue.title, run: null, at: issue.last_finished_at, value: issue.retries, average: null, factor: null });
    }
  }
  attention.sort((a, b) => (b.factor ?? b.value) - (a.factor ?? a.value));

  const modelsAvailable = new Set<string>();
  const effortsAvailable = new Set<string>();
  for (const run of allRuns) {
    for (const part of run.parts) modelsAvailable.add(part.model);
    if (run.parts.length === 0 && run.primaryModel !== null) modelsAvailable.add(run.primaryModel);
    effortsAvailable.add(run.effort ?? UNKNOWN_EFFORT);
  }

  return {
    period: {
      from: fromMs === null ? null : new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      start: startMs === null ? null : new Date(startMs).toISOString(),
      time_zone: filter.timeZone,
      granularity,
    },
    filter: { repo: filter.repo, model: filter.model, effort: filter.effort ?? null },
    models_available: [...modelsAvailable].sort(),
    efforts_available: [...effortsAvailable].sort(byEffort),
    history: {
      first_at: firstEntryMs === null ? null : new Date(firstEntryMs).toISOString(),
      runs_logged: scoped.length,
    },
    totals: { ...summarize(totals), issues: issues.size, repositories: repos.size, paused },
    previous,
    series,
    models: modelRows,
    efforts: effortRows,
    repositories: repositoryRows,
    issues: issueRows,
    outcomes: {
      successful: totals.successful,
      failed: totals.failed,
      stopped: totals.stopped,
      retried: totals.retries,
      paused,
      by_outcome: byOutcome,
    },
    durations,
    tools: toolStats(runs),
    heatmap: { start_times: heatmap, max: Math.max(0, ...heatmap.flat()) },
    top,
    attention: { rules: ATTENTION_RULES, items: attention.slice(0, ATTENTION_LIMIT), total: attention.length },
  };
}

export type Analytics = ReturnType<typeof computeAnalytics>;

export interface EntriesFilter {
  from: Date | null;
  to: Date | null;
  repo: string | null;
  /** Substring of the issue identifier, case-insensitive (`#76` or `acme/app#76`). */
  issue: string | null;
  event: string | null;
  /** `outcome` of run_finished or `result` of checks_finished. */
  result: string | null;
  order: 'asc' | 'desc';
  limit: number;
}

/** Log entries for the statistics page, newest or oldest first; model_usage lines only when asked for. */
export function filterEntries(entries: HistoryEntry[], filter: EntriesFilter) {
  const fromMs = filter.from?.getTime() ?? null;
  const toMs = filter.to?.getTime() ?? null;
  const repo = filter.repo?.toLowerCase() ?? null;
  const issue = filter.issue?.toLowerCase() ?? null;
  const inWindow: HistoryEntry[] = [];
  const events = new Set<string>();
  const results = new Set<string>();
  for (const entry of entries) {
    const ms = Date.parse(entry.ts);
    if (fromMs !== null && !(ms >= fromMs)) continue;
    if (toMs !== null && !(ms < toMs)) continue;
    if (repo !== null && (entry.fields.repo ?? '').toLowerCase() !== repo) continue;
    if (entry.event !== 'model_usage') events.add(entry.event);
    const result = entry.fields.outcome ?? entry.fields.result;
    if (result !== undefined) results.add(result);
    inWindow.push(entry);
  }
  const matched = inWindow.filter((entry) => {
    if (filter.event === null ? entry.event === 'model_usage' : entry.event !== filter.event) return false;
    if (issue !== null && !(entry.fields.issue ?? '').toLowerCase().includes(issue)) return false;
    if (filter.result !== null && (entry.fields.outcome ?? entry.fields.result) !== filter.result) return false;
    return true;
  });
  const ordered = filter.order === 'asc' ? matched : [...matched].reverse();
  return {
    total: matched.length,
    truncated: matched.length > filter.limit,
    events_available: [...events].sort(),
    results_available: [...results].sort(),
    entries: ordered.slice(0, filter.limit).map((entry): Record<string, string> => ({ ts: entry.ts, event: entry.event, ...entry.fields })),
  };
}
