export type LimitWindow = 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet';

export interface ParsedLimitMessage {
  /** The exhausted window, or null when the wording is not recognised. */
  window: LimitWindow | null;
  /** The next reset as an absolute instant, or null when it could not be read. */
  resetsAt: Date | null;
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const DAY_MS = 24 * 60 * 60 * 1000;

/** "[Oct 9[,] [at]] 7[:30][pm] [(Zone)]" at the start of the text after "resets". */
const RESET_PATTERN =
  /^(?:([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)?(?![\w:])\s*(?:\(([^)]*)\))?/i;

interface WallClock {
  year: number;
  /** 0-based month. */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * Reads Claude Code's limit message ("You've hit your session limit · resets 7:30pm (Europe/Berlin)").
 * Returns null when the text is not a limit message. Pure: `now` is always a parameter.
 */
export function parseLimitMessage(
  text: string,
  now: Date,
  options: { defaultZone?: string } = {},
): ParsedLimitMessage | null {
  const phrase = /hit\s+your\b(.*?)\blimit\b/i.exec(text);
  if (!phrase) return null;
  const window = windowOf(phrase[1] ?? '');

  const resets = /\bresets?\s+(.*)$/is.exec(text.slice(phrase.index + phrase[0].length));
  const reset = resets ? RESET_PATTERN.exec((resets[1] ?? '').trim()) : null;
  if (!reset) return { window, resetsAt: null };

  const time = readTime(reset[3], reset[4], reset[5]);
  const date = reset[1] === undefined ? null : readDate(reset[1], reset[2]);
  if (!time || (reset[1] !== undefined && !date)) return { window, resetsAt: null };

  const zone = reset[6]?.trim() || options.defaultZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    return { window, resetsAt: nextOccurrence(time, date, zone, now) };
  } catch (error) {
    if (error instanceof RangeError) return { window, resetsAt: null }; // unknown time zone
    throw error;
  }
}

function windowOf(wording: string): LimitWindow | null {
  const w = wording.toLowerCase();
  if (/\bopus\b/.test(w)) return 'seven_day_opus';
  if (/\bsonnet\b/.test(w)) return 'seven_day_sonnet';
  if (/\bweekly\b/.test(w)) return 'seven_day';
  if (/\bsession\b/.test(w)) return 'five_hour';
  return null;
}

function readTime(hourText: string | undefined, minuteText: string | undefined, meridiem: string | undefined) {
  if (hourText === undefined) return null;
  let hour = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  } else if (minuteText === undefined || hour > 23) {
    return null; // a bare number is not a time
  }
  return { hour, minute };
}

function readDate(monthText: string, dayText: string | undefined) {
  const name = monthText.toLowerCase();
  const month = MONTHS.findIndex((m) => m === name || m.slice(0, 3) === name || (m === 'september' && name === 'sept'));
  const day = Number(dayText);
  if (month < 0 || day < 1 || day > 31) return null;
  return { month, day };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock parts of an instant in a zone. Throws RangeError for an unknown zone. */
function wallClockOf(instant: number, zone: string): WallClock {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, format);
  }
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(instant)) parts[part.type] = Number(part.value);
  return {
    year: parts.year!,
    month: parts.month! - 1,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
  };
}

/** Offset of the zone from UTC at an instant, in ms. */
function offsetAt(instant: number, zone: string): number {
  const w = wallClockOf(instant, zone);
  // Whole minutes are enough; drop the sub-minute part of the instant.
  return Date.UTC(w.year, w.month, w.day, w.hour, w.minute) - Math.floor(instant / 60_000) * 60_000;
}

/** Instants showing the wall-clock time in the zone: two when ambiguous, one for a gap (the shifted time). */
function candidates(guess: number, zone: string): number[] {
  const before = offsetAt(guess - DAY_MS, zone);
  const after = offsetAt(guess + DAY_MS, zone);
  const valid = [...new Set([before, after])]
    .map((offset) => guess - offset)
    .filter((instant) => offsetAt(instant, zone) === guess - instant);
  // Gap: the hour does not exist, so shift it forward by the offset in effect before the gap.
  return (valid.length > 0 ? valid : [guess - before]).sort((a, b) => a - b);
}

function nextOccurrence(
  time: { hour: number; minute: number },
  date: { month: number; day: number } | null,
  zone: string,
  now: Date,
): Date | null {
  const today = wallClockOf(now.getTime(), zone);
  const nowMs = now.getTime();
  // A date can miss a year (Feb 29), so look ahead up to the next leap year.
  for (let step = 0; step < (date ? 9 : 2); step++) {
    let guess: number;
    if (date) {
      const year = today.year + step;
      guess = Date.UTC(year, date.month, date.day, time.hour, time.minute);
      if (new Date(guess).getUTCDate() !== date.day) continue; // e.g. Feb 29 in a common year
    } else {
      guess = Date.UTC(today.year, today.month, today.day + step, time.hour, time.minute);
    }
    const next = candidates(guess, zone).find((instant) => instant > nowMs);
    if (next !== undefined) return new Date(next);
  }
  return null;
}
