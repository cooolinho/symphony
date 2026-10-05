import fs from 'node:fs';
import path from 'node:path';
import {
  addUsage,
  costOf,
  emptyUsage,
  estimateCost,
  priceFor,
  totalTokens,
  type ModelTokenUsage,
  type PricingStore,
  type PricingTable,
} from '../costs/pricing.ts';
import { formatValue, type Logger } from '../log.ts';
import { errorMessage } from '../util/errors.ts';
import { DEFAULT_ROLE } from '../workflow/roles.ts';

/** How a run ended: handed off (left the active states), continuing (still active), or stopped early. */
export type RunOutcome = 'handed_off' | 'continuing' | 'failed' | 'stopped' | 'stalled' | 'shutdown';

export interface RunStart {
  repo: string;
  issue: string;
  title: string;
  state: string;
  attempt: number | null;
  /** Model requested for the run: a "Model: <model>" issue label, else the role's model, else claude.model; null = Claude Code default. */
  model: string | null;
  /** Role serving the issue's column; absent means the implicit `default` role. */
  role?: string;
  run: string;
  at: Date;
}

export interface RunFinish {
  repo: string;
  issue: string;
  title: string;
  run: string;
  session: string | null;
  attempt: number | null;
  outcome: RunOutcome;
  state: string;
  reason: string;
  turns: number;
  startedAt: Date;
  finishedAt: Date;
  agentSeconds: number;
  /** Per-model token totals of the run's session. */
  usage: Record<string, ModelTokenUsage>;
  /** Claude Code's own cost estimate, kept for comparison with model-costs.yml. */
  claudeEstimateUsd: number | null;
  /** Final commit and branch of a git workspace; null when unknown. */
  headSha?: string | null;
  branch?: string | null;
  /** `tool_use` events per MCP server. */
  mcpToolCalls?: Record<string, number>;
}

interface RepoTotals {
  runs: number;
  tokens: number;
  costUsd: number;
  agentSeconds: number;
}

/** One parsed line of a repository log. */
export interface HistoryEntry {
  ts: string;
  event: string;
  fields: Record<string, string>;
}

const PAIR = /([A-Za-z_][A-Za-z0-9_.-]*)=("(?:[^"\\]|\\.)*"|\S*)/g;

/** Log file name for a repository: `owner/name` → `owner_name.log`. */
export function repositoryFileName(repo: string): string {
  return `${repo.replace(/\//g, '_').replace(/[^A-Za-z0-9._-]/g, '_')}.log`;
}

export function parseHistoryLine(line: string): HistoryEntry | null {
  const fields: Record<string, string> = {};
  for (const match of line.matchAll(PAIR)) {
    const raw = match[2] ?? '';
    try {
      fields[match[1] as string] = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
    } catch {
      fields[match[1] as string] = raw;
    }
  }
  const { ts, event } = fields;
  if (ts === undefined || event === undefined) return null;
  delete fields.ts;
  delete fields.event;
  return { ts, event, fields };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** The model that consumed the most tokens in a run. */
function primaryModel(usage: Record<string, ModelTokenUsage>): string | null {
  let best: string | null = null;
  let bestTokens = -1;
  for (const [model, tokens] of Object.entries(usage)) {
    const count = totalTokens(tokens);
    if (count > bestTokens) {
      best = model;
      bestTokens = count;
    }
  }
  return best;
}

/**
 * Continuous per-repository history: `<dir>/<owner>_<name>.log`, one `key=value` line per event.
 * A finished run writes a summary line (with running repository totals) and one line per model.
 */
export class HistoryLog {
  readonly dir: string;
  #pricing: PricingStore;
  #logger: Logger;
  #totals = new Map<string, RepoTotals>();
  #failing = false;

  constructor(dir: string, pricing: PricingStore, logger: Logger) {
    this.dir = dir;
    this.#pricing = pricing;
    this.#logger = logger;
  }

  fileFor(repo: string): string {
    return path.join(this.dir, repositoryFileName(repo));
  }

  runStarted(start: RunStart): void {
    this.#append(start.repo, start.at, 'run_started', {
      issue: start.issue,
      run: start.run,
      title: start.title,
      state: start.state,
      attempt: start.attempt,
      model: start.model ?? 'default',
      role: start.role ?? DEFAULT_ROLE,
    });
  }

  runFinished(finish: RunFinish): void {
    const pricing = this.#pricing.current();
    const sum = emptyUsage();
    for (const usage of Object.values(finish.usage)) addUsage(sum, usage);
    const tokens = totalTokens(sum);
    const cost = estimateCost(pricing, finish.usage);

    const totals = this.#totalsFor(finish.repo);
    totals.runs += 1;
    totals.tokens += tokens;
    totals.costUsd += cost;
    totals.agentSeconds += finish.agentSeconds;

    this.#append(finish.repo, finish.finishedAt, 'run_finished', {
      issue: finish.issue,
      run: finish.run,
      session: finish.session,
      title: finish.title,
      outcome: finish.outcome,
      state: finish.state,
      reason: finish.reason,
      attempt: finish.attempt,
      turns: finish.turns,
      model: primaryModel(finish.usage),
      models: Object.keys(finish.usage).join(',') || null,
      input_tokens: sum.inputTokens,
      output_tokens: sum.outputTokens,
      cache_read_tokens: sum.cacheReadTokens,
      cache_write_tokens: sum.cacheWriteTokens,
      total_tokens: tokens,
      cost_usd: round(cost, 4),
      claude_estimate_usd: finish.claudeEstimateUsd === null ? null : round(finish.claudeEstimateUsd, 4),
      agent_seconds: round(finish.agentSeconds, 1),
      head_sha: finish.headSha ?? undefined,
      branch: finish.branch ?? undefined,
      mcp_tool_calls: formatToolCalls(finish.mcpToolCalls),
      started_at: finish.startedAt,
      repo_runs: totals.runs,
      repo_tokens: totals.tokens,
      repo_cost_usd: round(totals.costUsd, 4),
      repo_agent_seconds: round(totals.agentSeconds, 1),
    });
    for (const [model, usage] of Object.entries(finish.usage)) {
      const { price, key } = priceFor(pricing, model);
      this.#append(finish.repo, finish.finishedAt, 'model_usage', {
        issue: finish.issue,
        run: finish.run,
        model,
        price: key,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_read_tokens: usage.cacheReadTokens,
        cache_write_tokens: usage.cacheWriteTokens,
        total_tokens: totalTokens(usage),
        cost_usd: round(costOf(usage, price), 4),
      });
    }
  }

  /** Other noteworthy events for the repository history (paused issue, removed workspace, …). */
  note(repo: string, event: string, fields: Record<string, unknown>): void {
    this.#append(repo, new Date(), event, fields);
  }

  /** Running totals, read from the existing file the first time a repository is written. */
  #totalsFor(repo: string): RepoTotals {
    let totals = this.#totals.get(repo);
    if (totals === undefined) {
      totals = { runs: 0, tokens: 0, costUsd: 0, agentSeconds: 0 };
      for (const entry of readEntries(this.fileFor(repo))) {
        if (entry.event !== 'run_finished') continue;
        totals.runs += 1;
        totals.tokens += Number(entry.fields.total_tokens) || 0;
        totals.costUsd += Number(entry.fields.cost_usd) || 0;
        totals.agentSeconds += Number(entry.fields.agent_seconds) || 0;
      }
      this.#totals.set(repo, totals);
    }
    return totals;
  }

  #append(repo: string, at: Date, event: string, fields: Record<string, unknown>): void {
    let line = `ts=${at.toISOString()} event=${event} repo=${formatValue(repo)}`;
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      line += ` ${key}=${formatValue(value)}`;
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.fileFor(repo), `${line}\n`);
      this.#failing = false;
    } catch (error) {
      if (!this.#failing) this.#logger.warn('cannot write the repository log', { file: this.fileFor(repo), error: errorMessage(error) });
      this.#failing = true;
    }
  }
}

function formatToolCalls(calls: Record<string, number> | undefined): string | undefined {
  const parts = Object.entries(calls ?? {}).map(([server, count]) => `${server}:${count}`);
  return parts.length === 0 ? undefined : parts.join(',');
}

function readEntries(file: string): HistoryEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries: HistoryEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const entry = parseHistoryLine(line);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

export interface HistoryFile {
  repo: string;
  file: string;
  bytes: number;
}

/** Repository logs in a directory, with the repository taken from the lines themselves. */
export function listHistoryFiles(dir: string): HistoryFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.log'));
  } catch {
    return [];
  }
  const files: HistoryFile[] = [];
  for (const name of names.sort()) {
    const file = path.join(dir, name);
    const first = readEntries(file)[0];
    const repo = first?.fields.repo ?? name.replace(/\.log$/, '');
    files.push({ repo, file, bytes: fs.statSync(file).size });
  }
  return files;
}

export function readHistory(dir: string, repo: string | null): { files: HistoryFile[]; entries: HistoryEntry[] } {
  const files = listHistoryFiles(dir).filter((f) => repo === null || f.repo.toLowerCase() === repo.toLowerCase());
  const entries = files.flatMap((f) => readEntries(f.file)).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { files, entries };
}

interface Aggregate {
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_usd: number;
  agent_seconds: number;
}

function emptyAggregate(): Aggregate {
  return { runs: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0, cost_usd: 0, agent_seconds: 0 };
}

function addTokens(target: Aggregate, usage: ModelTokenUsage, cost: number): void {
  target.input_tokens += usage.inputTokens;
  target.output_tokens += usage.outputTokens;
  target.cache_read_tokens += usage.cacheReadTokens;
  target.cache_write_tokens += usage.cacheWriteTokens;
  target.total_tokens += totalTokens(usage);
  target.cost_usd += cost;
}

function finish<T extends Aggregate>(value: T): T {
  return { ...value, cost_usd: round(value.cost_usd, 4), agent_seconds: round(value.agent_seconds, 1) };
}

function localDate(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function usageFromFields(fields: Record<string, string>): ModelTokenUsage {
  return {
    inputTokens: Number(fields.input_tokens) || 0,
    outputTokens: Number(fields.output_tokens) || 0,
    cacheReadTokens: Number(fields.cache_read_tokens) || 0,
    cacheWriteTokens: Number(fields.cache_write_tokens) || 0,
  };
}

/**
 * Statistics for the logs page. Costs are recomputed from the logged per-model tokens with the
 * current model-costs.yml, so every figure follows the current price mapping.
 */
export function computeHistoryStats(entries: HistoryEntry[], pricing: PricingTable, recentLimit = 200) {
  // Per-run usage from the model lines.
  const runUsage = new Map<string, Array<{ model: string; usage: ModelTokenUsage; cost: number }>>();
  const models = new Map<string, Aggregate & { model: string; price: string; runIds: Set<string> }>();
  for (const entry of entries) {
    if (entry.event !== 'model_usage') continue;
    const model = entry.fields.model ?? 'unknown';
    const usage = usageFromFields(entry.fields);
    const { price, key } = priceFor(pricing, model);
    const cost = costOf(usage, price);
    const run = entry.fields.run ?? `${entry.ts}`;
    runUsage.set(run, [...(runUsage.get(run) ?? []), { model, usage, cost }]);
    let aggregate = models.get(model);
    if (aggregate === undefined) {
      aggregate = { ...emptyAggregate(), model, price: key, runIds: new Set() };
      models.set(model, aggregate);
    }
    aggregate.runIds.add(run);
    addTokens(aggregate, usage, cost);
  }

  const totals = { ...emptyAggregate(), issues: 0, repositories: 0, first_at: null as string | null, last_at: null as string | null };
  const repos = new Map<string, Aggregate & { repo: string; issues: Set<string>; last_at: string | null }>();
  const issues = new Map<string, Aggregate & { issue: string; repo: string; title: string; first_started_at: string | null; last_finished_at: string | null; last_outcome: string | null; last_state: string | null }>();
  const days = new Map<string, Aggregate & { date: string }>();

  for (const entry of entries) {
    totals.first_at ??= entry.ts;
    totals.last_at = entry.ts;
    if (entry.event !== 'run_finished') continue;
    const repo = entry.fields.repo ?? 'unknown';
    const issueKey = entry.fields.issue ?? 'unknown';
    const seconds = Number(entry.fields.agent_seconds) || 0;
    const parts = runUsage.get(entry.fields.run ?? '') ?? [];

    let repoAgg = repos.get(repo);
    if (repoAgg === undefined) {
      repoAgg = { ...emptyAggregate(), repo, issues: new Set(), last_at: null };
      repos.set(repo, repoAgg);
    }
    let issueAgg = issues.get(issueKey);
    if (issueAgg === undefined) {
      issueAgg = { ...emptyAggregate(), issue: issueKey, repo, title: '', first_started_at: null, last_finished_at: null, last_outcome: null, last_state: null };
      issues.set(issueKey, issueAgg);
    }
    const date = localDate(entry.ts);
    let dayAgg = days.get(date);
    if (dayAgg === undefined) {
      dayAgg = { ...emptyAggregate(), date };
      days.set(date, dayAgg);
    }

    for (const target of [totals, repoAgg, issueAgg, dayAgg]) {
      target.runs += 1;
      target.agent_seconds += seconds;
      for (const part of parts) addTokens(target, part.usage, part.cost);
    }
    repoAgg.issues.add(issueKey);
    repoAgg.last_at = entry.ts;
    issueAgg.title = entry.fields.title ?? issueAgg.title;
    issueAgg.first_started_at ??= entry.fields.started_at ?? entry.ts;
    issueAgg.last_finished_at = entry.ts;
    issueAgg.last_outcome = entry.fields.outcome ?? null;
    issueAgg.last_state = entry.fields.state ?? null;
  }
  totals.issues = issues.size;
  totals.repositories = repos.size;

  return {
    totals: finish(totals),
    models: [...models.values()]
      .map(({ runIds, ...rest }) => finish({ ...rest, runs: runIds.size }))
      .sort((a, b) => b.cost_usd - a.cost_usd),
    repositories: [...repos.values()]
      .map(({ issues: set, ...rest }) => finish({ ...rest, issues: set.size }))
      .sort((a, b) => b.cost_usd - a.cost_usd),
    issues: [...issues.values()].map((value) => finish(value)).sort((a, b) => ((a.last_finished_at ?? '') < (b.last_finished_at ?? '') ? 1 : -1)),
    days: [...days.values()].map((value) => finish(value)).sort((a, b) => (a.date < b.date ? 1 : -1)),
    recent: entries
      .filter((entry) => entry.event !== 'model_usage')
      .slice(-recentLimit)
      .reverse()
      .map((entry) => ({ ts: entry.ts, event: entry.event, ...entry.fields })),
  };
}

export type HistoryStats = ReturnType<typeof computeHistoryStats>;
