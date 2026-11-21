/**
 * Delay before the continuation of a run whose hand-off entry check timed out or found its lock busy. Starting again
 * after the usual 1 s would rerun the check at once on the same overloaded host (or queue behind the same lock), so
 * consecutive check timeouts of a claim wait 5 min, 10 min, 20 min, then 30 min each.
 */
export const CHECK_TIMEOUT_BASE_DELAY_MS = 5 * 60_000;
export const CHECK_TIMEOUT_MAX_DELAY_MS = 30 * 60_000;

/** `hits`: consecutive runs of the claim that ended on a timed-out (or busy) entry check, including this one. */
export function checkTimeoutBackoffMs(hits: number): number {
  const exponent = Math.min(Math.max(hits, 1) - 1, 20);
  return Math.min(CHECK_TIMEOUT_BASE_DELAY_MS * 2 ** exponent, CHECK_TIMEOUT_MAX_DELAY_MS);
}
