import { BUDGET_WINDOW_MS, forecastBudget, sumTokens, type BudgetUsage } from './forecast.ts';
import { isRejected, rateLimitKey, windowUtilization, type RateLimitRecord } from './rate-limit-log.ts';

/** Time range of the 5-hour chart: the current window, the last 24 hours or the last 7 days. */
export type FiveHourRange = 'window' | 'day' | 'week';
export const FIVE_HOUR_RANGES: readonly FiveHourRange[] = ['window', 'day', 'week'];

export function isFiveHourRange(value: unknown): value is FiveHourRange {
  return typeof value === 'string' && (FIVE_HOUR_RANGES as readonly string[]).includes(value);
}

/** One rate-limit event as a point of the chart: time and 5-hour utilisation in percent (may exceed 100). */
export interface FiveHourPoint {
  at: string;
  percent: number;
  /** A `rejected` event of type `five_hour`. */
  rejected: boolean;
}

/** One 5-hour window (one tooth of the saw). */
export interface FiveHourWindow {
  /** Time of the first point. */
  start: string;
  /** First known `resetsAt` of its points; null when none gives one. */
  resets_at: string | null;
  points: FiveHourPoint[];
  /** Highest point (the first on a tie). */
  peak: FiveHourPoint;
  /** Peak above 100 % or a `rejected` point. */
  over_limit: boolean;
  /** Earliest point above 100 % or rejected. */
  over_limit_at: string | null;
  /** Dispatch pause: first rejected point until the reset; null without rejected point or reset. */
  pause: { from: string; to: string } | null;
  /** The window `/api/v1/budget` reports (same reset). */
  current: boolean;
}

export interface FiveHourSeries {
  range: FiveHourRange;
  now: string;
  from: string;
  to: string;
  percent_source: 'sdk' | 'calibrated' | 'none';
  windows: FiveHourWindow[];
  /** Straight line from now to the reset with the slope of the current window; only for `window`. */
  forecast: { from: { at: string; percent: number }; to: { at: string; percent: number }; eta: string | null; rate_pct_per_min: number } | null;
  summary: { windows: number; over_limit: number; paused_min: number };
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const FIVE_HOURS = BUDGET_WINDOW_MS.five_hour;
const RANGE_MS: Record<Exclude<FiveHourRange, 'window'>, number> = { day: 24 * HOUR_MS, week: 7 * 24 * HOUR_MS };

const round1 = (value: number): number => Math.round(value * 10) / 10;
const iso = (ms: number): string => new Date(ms).toISOString();

interface RawPoint {
  time: number;
  percent: number;
  rejected: boolean;
  resetsAt: number | null;
}

function toWindow(points: RawPoint[], currentReset: number | null): FiveHourWindow {
  const resetMs = points.find((point) => point.resetsAt !== null)?.resetsAt ?? null;
  const out = points.map((point): FiveHourPoint => ({ at: iso(point.time), percent: point.percent, rejected: point.rejected }));
  let peak = out[0]!;
  for (const point of out) if (point.percent > peak.percent) peak = point;
  const over = out.find((point) => point.percent > 100 || point.rejected);
  const firstRejected = out.find((point) => point.rejected);
  return {
    start: out[0]!.at,
    resets_at: resetMs === null ? null : iso(resetMs),
    points: out,
    peak,
    over_limit: over !== undefined,
    over_limit_at: over?.at ?? null,
    pause: firstRejected !== undefined && resetMs !== null && resetMs > Date.parse(firstRejected.at) ? { from: firstRejected.at, to: iso(resetMs) } : null,
    current: resetMs !== null && currentReset !== null && resetMs === currentReset,
  };
}

/**
 * The 5-hour utilisation over time for the budget chart. Pure: no I/O, no clock.
 * Points come from the rate-limit events (`windowUtilization(info, 'five_hour')`, in percent, values above 100 kept), or,
 * when `/api/v1/budget` reports a calibrated percentage, from the tokens of the 5 hours before each event / the calibrated limit.
 * A new window starts when the reset changes, a point reaches the window's reset, or the utilisation falls (except between two
 * points with the same known reset). The forecast is the one of `forecastBudget` with the same input, so its ETA is the bar's.
 */
export function fiveHourSeries(input: { now: Date; usage: BudgetUsage[]; events: RateLimitRecord[]; range: FiveHourRange }): FiveHourSeries {
  const { usage, events, range } = input;
  const now = input.now.getTime();
  const f = forecastBudget({ now: input.now, usage, events, window: 'five_hour' });
  const currentReset = f.resets_at === null ? null : Date.parse(f.resets_at);

  let from: number;
  let to: number;
  if (range === 'window') {
    from = (currentReset ?? now) - FIVE_HOURS;
    to = currentReset ?? now;
  } else {
    from = now - RANGE_MS[range];
    to = now;
  }
  const until = Math.min(to, now);

  const mode: 'sdk' | 'calibrated' = f.percent_source === 'calibrated' ? 'calibrated' : 'sdk';
  const limit = f.forecast?.limit_tokens ?? null;
  const sorted = events
    .map((event) => ({ event, time: Date.parse(event.at) }))
    .filter((item) => !Number.isNaN(item.time) && item.time >= from && item.time <= until)
    .sort((a, b) => a.time - b.time);

  const raw: RawPoint[] = [];
  for (const { event, time } of sorted) {
    const info = event.rate_limit_info;
    const rejected = isRejected(info) && rateLimitKey(info) === 'five_hour';
    const util = windowUtilization(info, 'five_hour');
    let percent: number | null = null;
    if (mode === 'sdk') {
      if (util.utilization !== null) percent = round1(util.utilization * 100);
    } else if (limit !== null && limit > 0) {
      percent = round1((sumTokens(usage, time - FIVE_HOURS, time) / limit) * 100);
      if (rejected) percent = Math.max(percent, 100);
    }
    if (percent === null) continue;
    raw.push({ time, percent, rejected, resetsAt: util.resetsAt });
  }

  const groups: RawPoint[][] = [];
  let group: RawPoint[] | null = null;
  let groupReset: number | null = null;
  for (const point of raw) {
    let split = group === null;
    if (group !== null) {
      const prev = group[group.length - 1]!;
      if (point.resetsAt !== null && groupReset !== null && point.resetsAt !== groupReset) split = true;
      else if (groupReset !== null && point.time >= groupReset) split = true;
      else if (point.percent < prev.percent && !(point.resetsAt !== null && point.resetsAt === prev.resetsAt)) split = true;
    }
    if (split) {
      group = [];
      groups.push(group);
      groupReset = null;
    }
    group!.push(point);
    groupReset ??= point.resetsAt;
  }

  // `window` shows only the running window: one whose reset has passed is over, even when no newer event exists yet
  const windows = groups
    .map((points) => toWindow(points, currentReset))
    .filter((window) => range !== 'window' || window.resets_at === null || Date.parse(window.resets_at) > now);

  let forecast: FiveHourSeries['forecast'] = null;
  if (range === 'window' && f.percent !== null && currentReset !== null) {
    let slope: number | null = f.utilization_rate_per_min === null ? null : f.utilization_rate_per_min * 100;
    if (slope === null && mode === 'calibrated' && limit !== null && limit > 0) slope = (f.burn_rate_per_min / limit) * 100;
    if (slope !== null && slope > 0) {
      const minutes = (currentReset - now) / MINUTE_MS;
      forecast = {
        from: { at: iso(now), percent: f.percent },
        to: { at: iso(currentReset), percent: round1(f.percent + slope * minutes) },
        eta: f.forecast?.eta ?? null,
        rate_pct_per_min: Math.round(slope * 10000) / 10000,
      };
    }
  }

  let pausedMin = 0;
  for (const window of windows) {
    if (window.pause === null) continue;
    const end = Math.min(Date.parse(window.pause.to), now);
    pausedMin += Math.max(0, Math.round((end - Date.parse(window.pause.from)) / MINUTE_MS));
  }

  return {
    range,
    now: iso(now),
    from: iso(from),
    to: iso(to),
    percent_source: windows.length === 0 ? 'none' : mode,
    windows,
    forecast,
    summary: { windows: windows.length, over_limit: windows.filter((window) => window.over_limit).length, paused_min: pausedMin },
  };
}
