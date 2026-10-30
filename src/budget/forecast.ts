import type { LimitWindow } from '../agent/rate-limit.ts';
import type { HistoryEntry } from '../history/history.ts';
import { rateLimitKey, type RateLimitRecord } from './rate-limit-log.ts';

export type BudgetWindow = Extract<LimitWindow, 'five_hour' | 'seven_day'>;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** Length of the rolling subscription windows. */
export const BUDGET_WINDOW_MS: Record<BudgetWindow, number> = { five_hour: 5 * HOUR_MS, seven_day: 7 * 24 * HOUR_MS };
/** The burn rate is the token use of this many last milliseconds, per minute. */
export const BURN_RATE_WINDOW_MS = 30 * MINUTE_MS;

const DEFAULT_ROLE = 'default';

/** Tokens a run used, booked at the time it finished. */
export interface BudgetUsage {
  at: Date;
  tokens: number;
  role?: string;
}

export interface BudgetForecast {
  window: BudgetWindow;
  /** Tokens in the rolling window (now − window, now]. */
  used_tokens: number;
  /** Tokens of the last 30 minutes / 30, one decimal. */
  burn_rate_per_min: number;
  /** `resetsAt` of the latest event of this type; null when missing, invalid or not in the future. */
  resets_at: string | null;
  /** Null without a known limit (no SDK utilisation and no `rejected` hit). */
  forecast: { limit_tokens: number; limit_source: 'sdk' | 'calibrated'; eta: string | null } | null;
  /** True when the ETA is set, i.e. the limit is reached before the reset. */
  alert: boolean;
  /** Tokens per role in the window. */
  by_role: Record<string, number>;
}

export interface BudgetReport {
  five_hour: BudgetForecast;
  seven_day: BudgetForecast;
  generated_at: string;
}

export interface BudgetAlert {
  window: BudgetWindow;
  eta: string;
  resets_at: string;
  used_tokens: number;
  limit_tokens: number;
}

/** Tokens with `from < at <= to`,. */
function sumTokens(usage: BudgetUsage[], from: number, to: number): number {
  let sum = 0;
  for (const item of usage) {
    const at = item.at.getTime();
    if (at > from && at <= to) sum += item.tokens;
  }
  return sum;
}

function infoField(info: unknown, key: string): unknown {
  return typeof info === 'object' && info !== null ? (info as Record<string, unknown>)[key] : undefined;
}

function resetTime(info: unknown): number | null {
  const value = infoField(info, 'resetsAt');
  if (typeof value === 'number' && Number.isFinite(value)) return value >= 1e12 ? value : value * 1000;
  if (typeof value === 'string' && value !== '') {
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : time;
  }
  return null;
}

/**
 * Consumption, burn rate, limit estimate and ETA of one rolling window. Pure: no I/O, no clock.
 * The limit comes from the SDK `utilization` (share in (0, 1]) of the latest event of this type, else it is
 * calibrated as the usage in the window at the time of the latest `rejected` event of this type.
 */
export function forecastBudget(input: { now: Date; usage: BudgetUsage[]; events: RateLimitRecord[]; window: BudgetWindow }): BudgetForecast {
  const { usage, window } = input;
  const now = input.now.getTime();
  const span = BUDGET_WINDOW_MS[window];
  const used = sumTokens(usage, now - span, now);
  const burn = sumTokens(usage, now - BURN_RATE_WINDOW_MS, now) / (BURN_RATE_WINDOW_MS / MINUTE_MS);

  const byRole: Record<string, number> = {};
  for (const item of usage) {
    const at = item.at.getTime();
    if (at > now - span && at <= now) {
      const role = item.role ?? DEFAULT_ROLE;
      byRole[role] = (byRole[role] ?? 0) + item.tokens;
    }
  }

  const events = input.events
    .filter((event) => rateLimitKey(event.rate_limit_info) === window)
    .map((event) => ({ event, time: Date.parse(event.at) }))
    .filter((item) => !Number.isNaN(item.time))
    .sort((a, b) => a.time - b.time);
  const last = events.at(-1);
  const resetMs = last === undefined ? null : resetTime(last.event.rate_limit_info);
  const resetsAt = resetMs !== null && resetMs > now ? resetMs : null;

  let limit: number | null = null;
  let source: 'sdk' | 'calibrated' = 'calibrated';
  const utilization = last === undefined ? undefined : infoField(last.event.rate_limit_info, 'utilization');
  if (last !== undefined && typeof utilization === 'number' && utilization > 0 && utilization <= 1) {
    limit = sumTokens(usage, last.time - span, last.time) / utilization;
    source = 'sdk';
  } else {
    const hit = events.findLast((item) => infoField(item.event.rate_limit_info, 'status') === 'rejected');
    if (hit !== undefined) limit = sumTokens(usage, hit.time - span, hit.time);
  }
  if (limit !== null && !(limit > 0)) limit = null;

  let forecast: BudgetForecast['forecast'] = null;
  if (limit !== null) {
    let eta: number | null = null;
    const remaining = limit - used;
    if (remaining <= 0) eta = now;
    else if (burn > 0) eta = now + (remaining / burn) * MINUTE_MS;
    if (eta !== null && (resetsAt === null || eta >= resetsAt)) eta = null;
    forecast = { limit_tokens: Math.round(limit), limit_source: source, eta: eta === null ? null : new Date(eta).toISOString() };
  }

  return {
    window,
    used_tokens: used,
    burn_rate_per_min: Math.round(burn * 10) / 10,
    resets_at: resetsAt === null ? null : new Date(resetsAt).toISOString(),
    forecast,
    alert: forecast?.eta != null,
    by_role: byRole,
  };
}

/** Token use per finished run from history entries (`run_finished` only); entries with an invalid time are skipped. */
export function usageFromHistory(entries: HistoryEntry[]): BudgetUsage[] {
  const usage: BudgetUsage[] = [];
  for (const entry of entries) {
    if (entry.event !== 'run_finished') continue;
    const at = new Date(entry.ts);
    if (Number.isNaN(at.getTime())) continue;
    usage.push({ at, tokens: Number(entry.fields.total_tokens) || 0, role: entry.fields.role ?? DEFAULT_ROLE });
  }
  return usage;
}

export function budgetReport(input: { now: Date; usage: BudgetUsage[]; events: RateLimitRecord[] }): BudgetReport {
  return {
    five_hour: forecastBudget({ ...input, window: 'five_hour' }),
    seven_day: forecastBudget({ ...input, window: 'seven_day' }),
    generated_at: input.now.toISOString(),
  };
}

/** The windows whose limit is forecast to be hit before the reset. */
export function budgetAlerts(report: BudgetReport): BudgetAlert[] {
  const alerts: BudgetAlert[] = [];
  for (const window of ['five_hour', 'seven_day'] as const) {
    const item = report[window];
    if (item.alert && item.forecast?.eta != null && item.resets_at !== null) {
      alerts.push({ window, eta: item.forecast.eta, resets_at: item.resets_at, used_tokens: item.used_tokens, limit_tokens: item.forecast.limit_tokens });
    }
  }
  return alerts;
}
