import type { LimitWindow } from '../agent/rate-limit.ts';
import type { HistoryEntry } from '../history/history.ts';
import { rateLimitKey, windowUtilization, type RateLimitRecord } from './rate-limit-log.ts';

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
  /** `resetsAt` of the event that gives `sdk`, else of the latest event that gives a reset for the window; null when missing or not in the future. */
  resets_at: string | null;
  /** Null without a known limit (no SDK utilisation and no `rejected` hit). */
  forecast: { limit_tokens: number; limit_source: 'sdk' | 'calibrated'; eta: string | null } | null;
  /** Utilisation the SDK reported in the latest event (of any type) for this window; null when unknown or its reset has passed. */
  sdk: { utilization: number; resets_at: string | null; event_at: string; status: 'allowed' | 'allowed_warning' | 'rejected' | null } | null;
  /** Utilisation in percent (SDK, else used / limit); may exceed 100; null when unknown. */
  percent: number | null;
  percent_source: 'sdk' | 'calibrated' | 'none';
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

/**
 * Consumption, burn rate, limit estimate and ETA of one rolling window. Pure: no I/O, no clock.
 * The SDK utilisation is the one of the latest event of any type (`unifiedWindows.<window>`, else the top level of an event
 * of this type) up to `now`; once its reset has passed it is unknown (null), not 0. The limit is then the tokens in the window
 * at that event / utilisation, else calibrated as the usage in the window at the latest `rejected` event of this type.
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

  const all = input.events
    .map((event) => ({ event, time: Date.parse(event.at) }))
    .filter((item) => !Number.isNaN(item.time))
    .sort((a, b) => a.time - b.time);
  const known = all
    .filter((item) => item.time <= now)
    .map((item) => ({ ...item, ...windowUtilization(item.event.rate_limit_info, window) }));
  const pick = known.findLast((item) => item.utilization !== null && item.resetsAt !== null);
  const live = pick !== undefined && pick.utilization !== null && pick.resetsAt !== null && pick.resetsAt > now ? pick : undefined;
  const status = infoField(live?.event.rate_limit_info, 'status');
  const sdk: BudgetForecast['sdk'] =
    live === undefined || live.utilization === null || live.resetsAt === null
      ? null
      : {
          utilization: live.utilization,
          resets_at: new Date(live.resetsAt).toISOString(),
          event_at: live.event.at,
          status: status === 'allowed' || status === 'allowed_warning' || status === 'rejected' ? status : null,
        };
  const resetMs = live?.resetsAt ?? known.findLast((item) => item.resetsAt !== null)?.resetsAt ?? null;
  const resetsAt = resetMs !== null && resetMs > now ? resetMs : null;

  let limit: number | null = null;
  let source: 'sdk' | 'calibrated' = 'calibrated';
  if (live !== undefined && sdk !== null && sdk.utilization > 0) {
    const tokens = sumTokens(usage, live.time - span, live.time);
    if (tokens > 0) {
      limit = tokens / sdk.utilization;
      source = 'sdk';
    }
  }
  if (limit === null) {
    const hit = all.findLast((item) => rateLimitKey(item.event.rate_limit_info) === window && infoField(item.event.rate_limit_info, 'status') === 'rejected');
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

  const round1 = (value: number): number => Math.round(value * 10) / 10;
  let percent: number | null = null;
  let percentSource: BudgetForecast['percent_source'] = 'none';
  if (sdk !== null) {
    percent = round1(sdk.utilization * 100);
    percentSource = 'sdk';
  } else if (forecast !== null) {
    percent = round1((used / forecast.limit_tokens) * 100);
    percentSource = 'calibrated';
  }

  return {
    window,
    used_tokens: used,
    burn_rate_per_min: Math.round(burn * 10) / 10,
    resets_at: resetsAt === null ? null : new Date(resetsAt).toISOString(),
    sdk,
    percent,
    percent_source: percentSource,
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
