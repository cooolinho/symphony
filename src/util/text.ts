/** Keeps the first `max` characters, marking the cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Keeps the last `max` characters, marking the cut. Useful for process output. */
export function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `…${text.slice(text.length - max + 1)}`;
}

/** Collapses whitespace so a value fits on one log line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The finite-number entries of a plain object; null when `value` is no object or has none. */
export function numericEntries(value: unknown): Record<string, number> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]));
  return entries.length === 0 ? null : Object.fromEntries(entries);
}
