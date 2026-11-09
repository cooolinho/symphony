import { bareModelName } from '../agent/model-name.ts';
import { costOf, priceFor, totalTokens, type ModelTokenUsage, type PricingTable } from '../costs/pricing.ts';
import { BUDGET_WINDOW_MS, forecastBudget } from '../budget/forecast.ts';
import { isRejected, windowUtilization, type RateLimitRecord } from '../budget/rate-limit-log.ts';
import { PANEL_LENSES, type PanelVoteCounts } from '../workflow/results.ts';
import { parseCounts, parseSubagents, type HistoryEntry, type LoggedSubagent } from './history.ts';

/**
 * Analytics for the statistics page, aggregated on the server for one central filter. Every figure comes from
 * the repository logs: `run_finished` lines (outcome, attempt, timing), their `model_usage` lines (tokens per
 * model, priced with the current model-costs.yml exactly like computeHistoryStats) and `issue_paused` notes. Tool
 * usage comes from `tool_calls`, `skill_calls`, `agent_calls`, `subagent_tool_calls` (the part of `tool_calls` made inside subagents; main-thread calls are the difference) and the integration fields of `run_finished` (runs logged before these
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
  /** Role that served the run (`unknown` = role not logged); null = all roles. */
  role?: string | null;
  /** Complexity of the issue (`S`/`M`/`L`/`XL`/`unknown`), from its newest `stage_result`; null = all. */
  complexity?: string | null;
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

/** Role of a run as logged; runs from before the role was logged on every finish line count as `unknown`. */
const UNKNOWN_ROLE = 'unknown';

/** Profile of a stage result logged without one (the issue ran on the pipeline's default route). */
const DEFAULT_PROFILE = 'default';

/** Complexity of an issue without a `stage_result` that names one. */
const UNKNOWN_COMPLEXITY = 'unknown';

/** `target` values of a stage result that end the pipeline at the human: the issue counts as finished. */
const FINISHED_TARGETS = new Set(['in review', 'done']);

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
  /** Role that served the run (`role` of run_finished, else of run_started); null when not logged. */
  role: string | null;
  /** Peak context fill of the run in percent (`context_peak_percent`); null when not logged (older history). */
  contextPeakPercent: number | null;
  /** Auto-compacts of the run (`context_compacts`); null when not logged. */
  contextCompacts: number | null;
  /** Dispatched after a failed or stalled run of the same issue. */
  retry: boolean;
  parts: UsagePart[];
  /** Tokens of all models of the run, before a model filter narrows `parts`. */
  billedTokens: number;
  /** Persisted subagent runs (`subagents` of run_finished); empty for older lines. */
  subagents: LoggedSubagent[];
  /** Tool calls by tool name (built-in and `mcp__<server>__<tool>`). */
  tools: Record<string, number>;
  /** The part of `tools` called inside subagents (`subagent_tool_calls`); empty for older lines. */
  subagentTools: Record<string, number>;
  /** Skill tool calls by skill. */
  skills: Record<string, number>;
  /** Agent tool calls by subagent (`subagent_type`). */
  agents: Record<string, number>;
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

/** A logged numeric field; absent, empty, `null` or non-numeric → null (never 0). */
function numberOrNull(value: string | undefined): number | null {
  const text = fieldOrNull(value);
  if (text === null) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
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
  // Requested model, effort and role of older runs, whose run_finished line does not carry them yet.
  const startByRun = new Map<string, { model: string | null; effort: string | null; role: string | null }>();
  const runsByModel = new Map<string, number>();
  for (const entry of entries) {
    if (entry.event === 'run_started') {
      if (entry.fields.run !== undefined) startByRun.set(entry.fields.run, { model: fieldOrNull(entry.fields.model), effort: fieldOrNull(entry.fields.effort), role: fieldOrNull(entry.fields.role) });
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
      role: fieldOrNull(entry.fields.role) ?? start?.role ?? null,
      contextPeakPercent: numberOrNull(entry.fields.context_peak_percent),
      contextCompacts: numberOrNull(entry.fields.context_compacts),
      retry: FAILURE.has(lastOutcome.get(issue) ?? ''),
      parts,
      billedTokens: parts.reduce((sum, part) => sum + totalTokens(part.usage), 0),
      subagents: parseSubagents(entry.fields.subagents),
      tools: parseCounts(entry.fields.tool_calls),
      subagentTools: parseCounts(entry.fields.subagent_tool_calls),
      skills: parseCounts(entry.fields.skill_calls),
      agents: parseCounts(entry.fields.agent_calls),
      integrations: runIntegrations(entry.fields),
    });
    lastOutcome.set(issue, outcome);
  }
  return runs;
}

/** One role's part in an issue's pipeline. */
interface RoleShare {
  runs: number;
  total_tokens: number;
  cost_usd: number;
  agent_seconds: number;
}

/** Per-role shares of an issue, most expensive role first, rounded for JSON. */
function roleShares(roles: Map<string, RoleShare>): Record<string, RoleShare> {
  return Object.fromEntries(
    [...roles.entries()]
      .sort((a, b) => b[1].cost_usd - a[1].cost_usd || a[0].localeCompare(b[0]))
      .map(([role, v]) => [role, { ...v, cost_usd: round(v.cost_usd, 4), agent_seconds: round(v.agent_seconds, 1) }]),
  );
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
 * Tool usage of the runs: calls per tool, skill and subagent, and per workspace integration (e.g. Laravel Boost) the runs
 * it was ready in, the runs that used it, and its calls per tool and skill.
 */
function toolStats(runs: Run[]) {
  const tools = new Map<string, CallRow>();
  const subagentTools = new Map<string, CallRow>();
  const skills = new Map<string, CallRow>();
  const agents = new Map<string, CallRow>();
  const integrations = new Map<string, { runs: number; by_status: Record<string, number>; ready_runs: number; used_runs: number; calls: number; tools: Map<string, CallRow>; skills: Map<string, CallRow> }>();
  let calls = 0;
  let subagentCalls = 0;
  let runsWithCalls = 0;
  for (const run of runs) {
    const runCalls = sumCalls(run.tools);
    calls += runCalls;
    subagentCalls += sumCalls(run.subagentTools);
    if (runCalls > 0) runsWithCalls += 1;
    addCalls(tools, run.tools);
    addCalls(subagentTools, run.subagentTools);
    addCalls(skills, run.skills);
    addCalls(agents, run.agents);
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
    subagent_calls: subagentCalls,
    main_calls: Math.max(0, calls - subagentCalls),
    avg_calls_per_run: ratio(calls, runsWithCalls, 1),
    distinct_tools: tools.size,
    tools: ranking(tools, 'tool').map((row) => {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(row.tool);
      const subagentRow = subagentTools.get(row.tool)?.calls ?? 0;
      return { ...row, subagent_calls: subagentRow, main_calls: Math.max(0, row.calls - subagentRow), server: mcp?.[1] ?? null, name: mcp?.[2] ?? row.tool };
    }),
    skills: ranking(skills, 'skill'),
    agents: ranking(agents, 'agent'),
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
 * Repository, complexity, model and effort filter; with a model filter, each run keeps only that model's usage (a run
 * without logged usage matches by its requested model).
 */
function narrow(runs: Run[], filter: AnalyticsFilter, complexityOf: (issue: string) => string): Run[] {
  const repo = filter.repo?.toLowerCase() ?? null;
  const model = filter.model;
  const effort = filter.effort ?? null;
  const complexity = filter.complexity?.toLowerCase() ?? null;
  const result: Run[] = [];
  for (const run of runs) {
    if (repo !== null && run.repo.toLowerCase() !== repo) continue;
    if (complexity !== null && complexityOf(run.issue).toLowerCase() !== complexity) continue;
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
    role: run.role ?? UNKNOWN_ROLE,
    total_tokens: tokensOf(run),
    cost_usd: round(costOfRun(run), 4),
    agent_seconds: round(run.seconds, 1),
  };
}

/** One `stage_result` line, typed. */
interface StageResultEntry {
  repo: string;
  issue: string;
  run: string | null;
  role: string;
  kind: string;
  verdict: string;
  round: number | null;
  profile: string;
  complexity: string | null;
  /** Board column the result hands the issue to (`target`); null when not logged. */
  target: string | null;
  /** Confirmed/refuted findings (review/security results with verification, E3-4); null when the line does not carry them. */
  findingsConfirmed: number | null;
  findingsRefuted: number | null;
  /** Mutation score (percent) of a test result; null when the line carries none. */
  mutationScore: number | null;
  /** Panel votes of a security result (L/XL); null when the line carries none or a broken count. */
  panel: PanelVoteCounts | null;
  ms: number;
}

function panelOf(fields: Record<string, string>): PanelVoteCounts | null {
  const candidates = numberOrNull(fields.panel_candidates);
  if (candidates === null || !Number.isInteger(candidates) || candidates < 0) return null;
  const lenses = (value: string | undefined) => {
    const counts = parseCounts(value);
    return { reachability: counts.reachability ?? 0, impact: counts.impact ?? 0, defenses: counts.defenses ?? 0 };
  };
  return { candidates, confirmed: lenses(fields.panel_confirmed), refuted: lenses(fields.panel_refuted), singleRefuted: numberOrNull(fields.panel_single_refuted) ?? 0 };
}

function stageResultOf(entry: HistoryEntry): StageResultEntry {
  const fields = entry.fields;
  const round = Number(fields.round);
  return {
    repo: fields.repo ?? 'unknown',
    issue: fields.issue ?? 'unknown',
    run: fields.run ?? null,
    role: fields.role ?? UNKNOWN_ROLE,
    kind: fields.kind ?? 'unknown',
    verdict: fields.verdict ?? 'unknown',
    round: fields.round !== undefined && Number.isFinite(round) ? round : null,
    profile: fields.profile ?? DEFAULT_PROFILE,
    complexity: fieldOrNull(fields.complexity),
    target: fieldOrNull(fields.target),
    findingsConfirmed: numberOrNull(fields.findings_confirmed),
    findingsRefuted: numberOrNull(fields.findings_refuted),
    mutationScore: numberOrNull(fields.mutation_score),
    panel: panelOf(fields),
    ms: Date.parse(entry.ts),
  };
}

const count = (record: Record<string, number>, key: string): void => {
  record[key] = (record[key] ?? 0) + 1;
};

/**
 * Stage results (`stage_result` lines) of the period and scope: the verdict distribution per role and per profile.
 * A repository filter applies as everywhere; with a model or effort filter only results of the runs that pass it
 * count. A profile row also carries the runs, tokens and cost of its issues (the issues whose results name the
 * profile), so profiles compare by cost per issue.
 */
function stageResultStats(entries: HistoryEntry[], inScope: (entry: HistoryEntry) => boolean, inPeriod: (ms: number) => boolean, scopedRuns: Run[], runs: Run[], narrowed: boolean) {
  const keep = narrowed ? new Set(scopedRuns.map((run) => run.run)) : null;
  const results = entries
    .filter((entry) => entry.event === 'stage_result' && inScope(entry))
    .map(stageResultOf)
    .filter((result) => keep === null || (result.run !== null && keep.has(result.run)));
  const inWindow = results.filter((result) => inPeriod(result.ms));

  const roles = new Map<string, { role: string; results: number; issues: Set<string>; verdicts: Record<string, number> }>();
  const profiles = new Map<string, { profile: string; results: number; issues: Set<string>; verdicts: Record<string, number>; by_complexity: Record<string, number>; max_round: number }>();
  for (const result of inWindow) {
    const role = roles.get(result.role) ?? { role: result.role, results: 0, issues: new Set<string>(), verdicts: {} };
    roles.set(result.role, role);
    role.results += 1;
    role.issues.add(result.issue);
    count(role.verdicts, `${result.kind}:${result.verdict}`);

    const profile = profiles.get(result.profile) ?? { profile: result.profile, results: 0, issues: new Set<string>(), verdicts: {}, by_complexity: {}, max_round: 0 };
    profiles.set(result.profile, profile);
    profile.results += 1;
    profile.issues.add(result.issue);
    count(profile.verdicts, `${result.kind}:${result.verdict}`);
    count(profile.by_complexity, result.complexity ?? 'unknown');
    profile.max_round = Math.max(profile.max_round, result.round ?? 0);
  }

  // Issue → profile of its newest result (results come oldest first), then the issue's runs in the period.
  const issueProfile = new Map<string, string>();
  for (const result of results) issueProfile.set(result.issue, result.profile);
  const costs = new Map<string, Totals>();
  for (const run of runs) {
    const profile = issueProfile.get(run.issue);
    if (profile === undefined || !profiles.has(profile)) continue;
    const totals = costs.get(profile) ?? emptyTotals();
    costs.set(profile, totals);
    addRun(totals, run);
  }
  const by_profile = [...profiles.values()]
    .map(({ issues, ...rest }) => {
      const totals = costs.get(rest.profile) ?? emptyTotals();
      return {
        ...rest,
        issues: issues.size,
        runs: totals.runs,
        total_tokens: totals.total_tokens,
        cost_usd: round(totals.cost_usd, 4),
        agent_seconds: round(totals.agent_seconds, 1),
        avg_cost_per_issue: ratio(totals.cost_usd, issues.size),
      };
    })
    .sort((a, b) => b.results - a.results || a.profile.localeCompare(b.profile));
  const verdicts_by_role = [...roles.values()]
    .map(({ issues, ...rest }) => ({ ...rest, issues: issues.size }))
    .sort((a, b) => b.results - a.results || a.role.localeCompare(b.role));
  return { by_profile, verdicts_by_role, total: inWindow.length };
}


/** Order of the complexity values: S, M, L, XL, anything else, `unknown` last. */
const COMPLEXITY_ORDER = ['S', 'M', 'L', 'XL'];

function complexityRank(complexity: string): number {
  if (complexity === UNKNOWN_COMPLEXITY) return COMPLEXITY_ORDER.length + 1;
  const index = COMPLEXITY_ORDER.indexOf(complexity);
  return index === -1 ? COMPLEXITY_ORDER.length : index;
}

const byComplexity = (a: string, b: string): number => complexityRank(a) - complexityRank(b) || a.localeCompare(b);

/** Issue → complexity of its newest non-null `stage_result` (upper-cased); `run_finished` carries no complexity. */
function issueComplexities(entries: HistoryEntry[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of entries) {
    if (entry.event !== 'stage_result') continue;
    const complexity = fieldOrNull(entry.fields.complexity);
    if (complexity !== null) result.set(entry.fields.issue ?? 'unknown', complexity.toUpperCase());
  }
  return result;
}

/**
 * Subagent evaluation (E0-9): one row per role × primary model of the runs in scope.
 *
 * - Delegating run: the sum of its `agent_calls` is above 0. `delegation_rate` = delegating runs / runs.
 * - Main-thread Bash: max(0, `tool_calls`.Bash − `subagent_tool_calls`.Bash) per run; median needs ${MEDIAN_MIN_RUNS} runs, p90 ${PERCENTILE_MIN_RUNS}.
 * - Token share: Σ persisted subagent tokens / Σ billed tokens of the runs (all models of the run, even with a model
 *   filter), capped at 1, null without billed tokens. The session's `model_usage` already contains the subagents' calls.
 * - Finished issue: an issue with a `stage_result` in the period whose `target` is In review or Done (the hand-over to
 *   the human). Cost per finished issue = all roles' runs on those issues in the period / finished issues; the
 *   `own_` variant counts only the row's runs.
 * - Returns: `review:changes_needed` and `test:failed` results on the issues the row's runs worked on (they come from
 *   reviewer and tester runs, so they are attributed by issue, not by the run named in the result), per issue.
 * - Findings (E3-4): sums of the optional `findings_confirmed`/`findings_refuted` of the row's issues; null when absent.
 */
/** The newest mutation score per issue (test results of L/XL issues in Laravel apps), newest first. */
function mutationScores(results: StageResultEntry[]) {
  const latest = new Map<string, StageResultEntry>();
  for (const result of results) {
    if (result.mutationScore === null) continue;
    const key = `${result.repo}\u0000${result.issue}`;
    const known = latest.get(key);
    if (known === undefined || result.ms >= known.ms) latest.set(key, result);
  }
  return [...latest.values()]
    .sort((a, b) => b.ms - a.ms)
    .map((result) => ({ issue: result.issue, repo: result.repo, complexity: result.complexity, mutation_score: result.mutationScore as number, at: new Date(result.ms).toISOString() }));
}

/** Security panel (E3-5 follow-up): panel candidates, votes per lens and candidates refuted by exactly one lens, summed over all security results in scope. */
function securityPanel(results: StageResultEntry[]) {
  const panels = results.flatMap((result) => (result.panel === null ? [] : [result.panel]));
  const note =
    'Panel-Kandidaten = Security-Kandidaten (findings und refuted) mit Panel-Stimmen (L/XL), summiert über alle Security-Ergebnisse im Zeitraum. Je Lens: Stimmen bestätigt/widerlegt. Von genau einer Lens widerlegt = Kandidaten mit genau einer widerlegenden Stimme; die hätte eine Regel mit PANEL_MAX_REFUTING_VOTES = 1 behalten. Leer ohne Ergebnisse mit Panel-Stimmen.';
  if (panels.length === 0) return { note, results: 0, candidates: null as number | null, refuted_by_one_lens: null as number | null, lenses: [] as Array<{ lens: string; confirmed: number; refuted: number }> };
  return {
    note,
    results: panels.length,
    candidates: panels.reduce((sum, panel) => sum + panel.candidates, 0) as number | null,
    refuted_by_one_lens: panels.reduce((sum, panel) => sum + panel.singleRefuted, 0) as number | null,
    lenses: PANEL_LENSES.map((lens) => ({
      lens: lens as string,
      confirmed: panels.reduce((sum, panel) => sum + panel.confirmed[lens], 0),
      refuted: panels.reduce((sum, panel) => sum + panel.refuted[lens], 0),
    })),
  };
}

function subagentEvaluation(runs: Run[], pipelineRuns: Run[], results: StageResultEntry[]) {
  const finished = new Set<string>();
  const returns = new Map<string, { review: number; test: number }>();
  const findings = new Map<string, { confirmed: number | null; refuted: number | null }>();
  for (const result of results) {
    if (result.target !== null && FINISHED_TARGETS.has(result.target.toLowerCase())) finished.add(result.issue);
    if (result.kind === 'review' && result.verdict === 'changes_needed') {
      const slot = returns.get(result.issue) ?? { review: 0, test: 0 };
      slot.review += 1;
      returns.set(result.issue, slot);
    } else if (result.kind === 'test' && result.verdict === 'failed') {
      const slot = returns.get(result.issue) ?? { review: 0, test: 0 };
      slot.test += 1;
      returns.set(result.issue, slot);
    }
    if (result.findingsConfirmed !== null || result.findingsRefuted !== null) {
      const slot = findings.get(result.issue) ?? { confirmed: null, refuted: null };
      if (result.findingsConfirmed !== null) slot.confirmed = (slot.confirmed ?? 0) + result.findingsConfirmed;
      if (result.findingsRefuted !== null) slot.refuted = (slot.refuted ?? 0) + result.findingsRefuted;
      findings.set(result.issue, slot);
    }
  }
  const pipelineCost = new Map<string, number>();
  for (const run of pipelineRuns) pipelineCost.set(run.issue, (pipelineCost.get(run.issue) ?? 0) + costOfRun(run));

  interface Group {
    role: string;
    model: string;
    runs: Run[];
    delegating: number;
    agents: Map<string, CallRow>;
    bash: number[];
  }
  const groups = new Map<string, Group>();
  for (const run of runs) {
    const role = run.role ?? UNKNOWN_ROLE;
    const model = run.primaryModel ?? 'unknown';
    const key = `${role}\u0000${model}`;
    const group: Group = groups.get(key) ?? { role, model, runs: [], delegating: 0, agents: new Map<string, CallRow>(), bash: [] as number[] };
    groups.set(key, group);
    group.runs.push(run);
    if (sumCalls(run.agents) > 0) group.delegating += 1;
    addCalls(group.agents, run.agents);
    group.bash.push(Math.max(0, (run.tools.Bash ?? 0) - (run.subagentTools.Bash ?? 0)));
  }

  const rows = [...groups.values()].map((group) => {
    const issues = new Set(group.runs.map((run) => run.issue));
    const finishedIssues = [...issues].filter((issue) => finished.has(issue));
    let billed = 0;
    let subagentTokens = 0;
    let cost = 0;
    let ownFinishedCost = 0;
    let reviewReturns = 0;
    let testReturns = 0;
    for (const run of group.runs) {
      billed += run.billedTokens;
      for (const sub of run.subagents) subagentTokens += sub.tokens;
      cost += costOfRun(run);
      if (finished.has(run.issue)) ownFinishedCost += costOfRun(run);
    }
    let confirmed: number | null = null;
    let refuted: number | null = null;
    for (const issue of issues) {
      reviewReturns += returns.get(issue)?.review ?? 0;
      testReturns += returns.get(issue)?.test ?? 0;
      const found = findings.get(issue);
      if (found?.confirmed != null) confirmed = (confirmed ?? 0) + found.confirmed;
      if (found?.refuted != null) refuted = (refuted ?? 0) + found.refuted;
    }
    const allStagesCost = finishedIssues.reduce((sum, issue) => sum + (pipelineCost.get(issue) ?? 0), 0);
    const sorted = [...group.bash].sort((a, b) => a - b);
    const bashTotal = sorted.reduce((sum, n) => sum + n, 0);
    return {
      role: group.role,
      model: group.model,
      runs: group.runs.length,
      runs_with_subagent: group.delegating,
      delegation_rate: ratio(group.delegating, group.runs.length) ?? 0,
      subagent_calls: [...group.agents.values()].reduce((sum, row) => sum + row.calls, 0),
      agents: ranking(group.agents, 'agent'),
      main_bash: {
        total: bashTotal,
        avg: ratio(bashTotal, sorted.length, 2),
        p50: sorted.length >= MEDIAN_MIN_RUNS ? percentile(sorted, 50) : null,
        p90: sorted.length >= PERCENTILE_MIN_RUNS ? percentile(sorted, 90) : null,
      },
      billed_tokens: billed,
      subagent_tokens: subagentTokens,
      subagent_token_share: billed > 0 ? round(Math.min(1, subagentTokens / billed), 4) : null,
      issues: issues.size,
      finished_issues: finishedIssues.length,
      cost_usd: round(cost, 4),
      own_cost_per_finished_issue: ratio(ownFinishedCost, finishedIssues.length),
      cost_per_finished_issue: ratio(allStagesCost, finishedIssues.length),
      returns: {
        review_changes_needed: reviewReturns,
        test_failed: testReturns,
        total: reviewReturns + testReturns,
        per_issue: ratio(reviewReturns + testReturns, issues.size) ?? 0,
      },
      findings: { confirmed, refuted },
    };
  });
  rows.sort((a, b) => a.role.localeCompare(b.role) || b.runs - a.runs || a.model.localeCompare(b.model));
  return {
    note: 'Delegierender Run: mindestens ein Agent-Aufruf. Bash im Hauptthread = Bash-Aufrufe minus die der Subagents. Token-Anteil = Tokens der Subagents / abgerechnete Tokens der Runs (die Subagents sind darin enthalten, der Anteil ist höchstens 100 %). Fertiges Issue = ein Stage-Ergebnis mit Ziel In review oder Done im Zeitraum; Kosten je fertigem Issue summieren alle Rollen (alle Stages), „eigene“ nur die Runs der Zeile. Rückläufer = Agent-review-Ergebnisse changes_needed und Testing-Ergebnisse failed auf den Issues der Zeile, je Issue. Findings bestätigt/widerlegt = Summe von findings_confirmed/findings_refuted der Review- und Security-Ergebnisse auf den Issues der Zeile (L/XL oder mit Verifikation); leer ohne solche Ergebnisse.',
    rules: { median_min_runs: MEDIAN_MIN_RUNS, percentile_min_runs: PERCENTILE_MIN_RUNS },
    rows,
    mutation_scores: mutationScores(results),
    security_panel: securityPanel(results),
  };
}

/**
 * Everything the statistics page shows for one filter. `now` is the end of an open period (`to` = null).
 */
/** Peak of a rolling 5-hour window per day (tokens and the SDK's `five_hour` utilization in percent), rate-limit hits per day, auto-compacts and average context per role. */
function budgetHistory(scoped: Run[], runs: Run[], rateLimits: RateLimitRecord[], inPeriod: (ms: number) => boolean, startMs: number | null, toMs: number, timeZone: string) {
  const days = new Map<string, { date: string; peak_5h_tokens: number; limit_hits: number; peak_5h_percent: number | null }>();
  if (startMs !== null) for (const date of bucketKeys(startMs, toMs, 'day', timeZone)) days.set(date, { date, peak_5h_tokens: 0, limit_hits: 0, peak_5h_percent: null });

  // Window (t - 5 h, t] ending at each run_finished; runs before the period still fill the window.
  const sorted = [...scoped].sort((a, b) => a.finishedMs - b.finishedMs);
  let left = 0;
  let sum = 0;
  for (const run of sorted) {
    sum += tokensOf(run);
    while ((sorted[left] as Run).finishedMs <= run.finishedMs - BUDGET_WINDOW_MS.five_hour) {
      sum -= tokensOf(sorted[left] as Run);
      left += 1;
    }
    if (!inPeriod(run.finishedMs)) continue;
    const day = days.get(bucketKey(run.finishedMs, 'day', timeZone));
    if (day !== undefined) day.peak_5h_tokens = Math.max(day.peak_5h_tokens, sum);
  }

  for (const event of rateLimits) {
    const ms = Date.parse(event.at);
    if (!Number.isFinite(ms) || !inPeriod(ms)) continue;
    const day = days.get(bucketKey(ms, 'day', timeZone));
    if (day === undefined) continue;
    if (isRejected(event.rate_limit_info)) day.limit_hits += 1;
    const utilization = windowUtilization(event.rate_limit_info, 'five_hour').utilization;
    if (utilization !== null) day.peak_5h_percent = Math.max(day.peak_5h_percent ?? 0, round(utilization * 100, 1));
  }

  const compacts = new Map<string, number>();
  const context = new Map<string, { sum: number; n: number }>();
  for (const run of runs) {
    const role = run.role ?? UNKNOWN_ROLE;
    if (run.contextCompacts !== null) compacts.set(role, (compacts.get(role) ?? 0) + run.contextCompacts);
    if (run.contextPeakPercent !== null) {
      const slot = context.get(role) ?? { sum: 0, n: 0 };
      slot.sum += run.contextPeakPercent;
      slot.n += 1;
      context.set(role, slot);
    }
  }
  const sortedRecord = (map: Map<string, number>): Record<string, number> =>
    Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  return {
    days: [...days.values()],
    compacts_by_role: sortedRecord(compacts),
    avg_context_by_role: sortedRecord(new Map([...context.entries()].map(([role, v]) => [role, round(v.sum / v.n, 1)]))),
  };
}

/**
 * Additions for the statistics page next to `budget`: the calibrated 5-hour limit (the same calibration as the
 * forecast, over all runs of the account), the rate-limit hits of the period with time and model, and the role and
 * round with the most auto-compacts (round of the run's `stage_result`). `peak_source` says whether the days carry the SDK utilization (`sdk`) or only tokens.
 */
function budgetInsights(allRuns: Run[], runs: Run[], entries: HistoryEntry[], rateLimits: RateLimitRecord[], inPeriod: (ms: number) => boolean, toMs: number, days: Array<{ peak_5h_percent: number | null }>) {
  const limit = forecastBudget({
    now: new Date(toMs),
    usage: allRuns.map((run) => ({ at: new Date(run.finishedMs), tokens: tokensOf(run), role: run.role ?? undefined })),
    events: rateLimits,
    window: 'five_hour',
  }).forecast?.limit_tokens ?? null;

  const limit_hits = rateLimits
    .filter((event) => isRejected(event.rate_limit_info) && inPeriod(Date.parse(event.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((event) => ({ at: event.at, model: event.model, role: event.role }));

  const rounds = new Map<string, number | null>();
  for (const entry of entries) {
    if (entry.event !== 'stage_result') continue;
    const result = stageResultOf(entry);
    if (result.run !== null) rounds.set(result.run, result.round);
  }
  const groups = new Map<string, { role: string; round: number | null; compacts: number }>();
  for (const run of runs) {
    if (run.contextCompacts === null || run.contextCompacts <= 0) continue;
    const role = run.role ?? UNKNOWN_ROLE;
    const round = rounds.get(run.run) ?? null;
    const key = `${role}\u0000${round ?? ''}`;
    const slot = groups.get(key) ?? { role, round, compacts: 0 };
    slot.compacts += run.contextCompacts;
    groups.set(key, slot);
  }
  const top_compact = [...groups.values()].sort((a, b) => b.compacts - a.compacts || a.role.localeCompare(b.role) || (a.round ?? -1) - (b.round ?? -1))[0] ?? null;

  const peak_source: 'sdk' | 'tokens' = days.some((day) => day.peak_5h_percent !== null) ? 'sdk' : 'tokens';
  return { limit_5h_tokens: limit, limit_hits, top_compact, peak_source };
}

export function computeAnalytics(entries: HistoryEntry[], pricing: PricingTable, filter: AnalyticsFilter, now = new Date(), rateLimits: RateLimitRecord[] = []) {
  const allRuns = collectRuns(entries, pricing);
  const issueComplexity = issueComplexities(entries);
  const complexityOf = (issue: string) => issueComplexity.get(issue) ?? UNKNOWN_COMPLEXITY;
  const scopedAllRoles = narrow(allRuns, filter, complexityOf);
  const roleFilter = filter.role ?? null;
  const scoped = roleFilter === null ? scopedAllRoles : scopedAllRoles.filter((run) => (run.role ?? UNKNOWN_ROLE) === roleFilter);
  const toMs = filter.to?.getTime() ?? now.getTime();
  const fromMs = filter.from?.getTime() ?? null;
  const inPeriod = (ms: number) => (fromMs === null || ms >= fromMs) && ms < toMs;
  const runs = scoped.filter((run) => inPeriod(run.finishedMs));
  const pipelineRuns = scopedAllRoles.filter((run) => inPeriod(run.finishedMs));

  const repoFilter = filter.repo?.toLowerCase() ?? null;
  const complexityFilter = filter.complexity?.toLowerCase() ?? null;
  const inScope = (entry: HistoryEntry) =>
    (repoFilter === null || (entry.fields.repo ?? '').toLowerCase() === repoFilter) &&
    (complexityFilter === null || complexityOf(entry.fields.issue ?? 'unknown').toLowerCase() === complexityFilter);
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
  const issueAgg = new Map<string, Totals & { issue: string; repo: string; title: string; first_started_at: string | null; last_finished_at: string | null; last_outcome: string | null; last_state: string | null; roles: Map<string, RoleShare> }>();
  // Roles: runs, tokens, cost, agent time and outcomes per role, with the issues that role worked on.
  const roleAgg = new Map<string, Totals & { role: string; issues: Set<string>; by_outcome: Record<string, number> }>();
  for (const run of runs) {
    const roleKey = run.role ?? UNKNOWN_ROLE;
    let role = roleAgg.get(roleKey);
    if (role === undefined) {
      role = { ...emptyTotals(), role: roleKey, issues: new Set(), by_outcome: {} };
      roleAgg.set(roleKey, role);
    }
    addRun(role, run);
    role.issues.add(run.issue);
    role.by_outcome[run.outcome] = (role.by_outcome[run.outcome] ?? 0) + 1;

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
      issue = { ...emptyTotals(), issue: run.issue, repo: run.repo, title: run.title, first_started_at: null, last_finished_at: null, last_outcome: null, last_state: null, roles: new Map() };
      issueAgg.set(run.issue, issue);
    }
    addRun(issue, run);
    const share = issue.roles.get(roleKey) ?? { runs: 0, total_tokens: 0, cost_usd: 0, agent_seconds: 0 };
    share.runs += 1;
    share.total_tokens += tokensOf(run);
    share.cost_usd += costOfRun(run);
    share.agent_seconds += run.seconds;
    issue.roles.set(roleKey, share);
    issue.title = run.title || issue.title;
    issue.first_started_at ??= new Date(run.startedMs).toISOString();
    issue.last_finished_at = run.finishedAt;
    issue.last_outcome = run.outcome;
    issue.last_state = run.state;
  }
  const repositoryRows = [...repoAgg.values()]
    .map(({ issues: set, ...rest }) => ({ ...summarize(rest), repo: rest.repo, last_at: rest.last_at, issues: set.size }))
    .sort((a, b) => b.cost_usd - a.cost_usd);
  const roleRows = [...roleAgg.values()]
    .map(({ issues: set, by_outcome, ...rest }) => ({
      ...summarize(rest),
      role: rest.role,
      issues: set.size,
      success_rate: ratio(rest.successful, rest.runs),
      cost_share: ratio(rest.cost_usd, totals.cost_usd),
      token_share: ratio(rest.total_tokens, totals.total_tokens),
      time_share: ratio(rest.agent_seconds, totals.agent_seconds),
      by_outcome,
    }))
    .sort((a, b) => b.cost_usd - a.cost_usd || a.role.localeCompare(b.role));
  const issueRows = [...issueAgg.values()]
    .map(({ roles, ...issue }) => ({ ...summarize(issue), roles: roleShares(roles), issue: issue.issue, repo: issue.repo, title: issue.title, first_started_at: issue.first_started_at, last_finished_at: issue.last_finished_at, last_outcome: issue.last_outcome, last_state: issue.last_state }))
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
    // Most expensive issue pipelines: all runs of an issue summed across its roles.
    pipelines: issueRows.filter((issue) => issue.cost_usd > 0).sort((a, b) => b.cost_usd - a.cost_usd || b.runs - a.runs).slice(0, TOP_LIMIT)
      .map((issue) => ({ issue: issue.issue, repo: issue.repo, title: issue.title, cost_usd: issue.cost_usd, total_tokens: issue.total_tokens, agent_seconds: issue.agent_seconds, runs: issue.runs, roles: issue.roles, last_outcome: issue.last_outcome })),
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

  const stageStats = stageResultStats(entries, inScope, inPeriod, scoped, runs, filter.model !== null || (filter.effort ?? null) !== null || roleFilter !== null);

  const rolesAvailable = new Set<string>();
  const complexitiesAvailable = new Set<string>();
  const modelsAvailable = new Set<string>();
  const effortsAvailable = new Set<string>();
  for (const run of allRuns) {
    for (const part of run.parts) modelsAvailable.add(part.model);
    if (run.parts.length === 0 && run.primaryModel !== null) modelsAvailable.add(run.primaryModel);
    effortsAvailable.add(run.effort ?? UNKNOWN_EFFORT);
    rolesAvailable.add(run.role ?? UNKNOWN_ROLE);
    complexitiesAvailable.add(complexityOf(run.issue));
  }
  const stageResultsInScope = entries
    .filter((entry) => entry.event === 'stage_result' && inScope(entry))
    .map(stageResultOf)
    .filter((result) => inPeriod(result.ms));

  const budget = budgetHistory(scoped, runs, rateLimits, inPeriod, startMs, toMs, filter.timeZone);
  return {
    period: {
      from: fromMs === null ? null : new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      start: startMs === null ? null : new Date(startMs).toISOString(),
      time_zone: filter.timeZone,
      granularity,
    },
    filter: { repo: filter.repo, model: filter.model, effort: filter.effort ?? null, role: roleFilter, complexity: filter.complexity ?? null },
    models_available: [...modelsAvailable].sort(),
    efforts_available: [...effortsAvailable].sort(byEffort),
    roles_available: [...rolesAvailable].sort(),
    complexities_available: [...complexitiesAvailable].sort(byComplexity),
    history: {
      first_at: firstEntryMs === null ? null : new Date(firstEntryMs).toISOString(),
      runs_logged: scoped.length,
    },
    totals: { ...summarize(totals), issues: issues.size, repositories: repos.size, paused },
    previous,
    series,
    models: modelRows,
    efforts: effortRows,
    by_role: roleRows,
    budget,
    budget_insights: budgetInsights(allRuns, runs, entries, rateLimits, inPeriod, toMs, budget.days),
    by_profile: stageStats.by_profile,
    verdicts_by_role: stageStats.verdicts_by_role,
    stage_results: stageStats.total,
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
    subagent_evaluation: subagentEvaluation(runs, pipelineRuns, stageResultsInScope),
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
