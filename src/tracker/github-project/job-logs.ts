import { restBase } from './statuses.ts';

/**
 * The end of the logs of failing GitHub Actions jobs, for `get_issue` only (agents have no token and no `gh`, so this is
 * how they read why a CI job is red). Never called by the merge gate or the poll loop.
 */

/** Logs are loaded for at most this many failing jobs per `get_issue` call. */
export const MAX_JOB_LOGS = 3;
/** Lines kept before (and including) the last `##[error]` line. */
export const LOG_TAIL_LINES = 80;
/** Characters kept at most (the cut note comes on top). */
export const LOG_TAIL_CHARS = 6000;

export interface JobLogOptions {
  fetch: typeof fetch;
  endpoint: string;
  token: string;
  timeoutMs: number;
}

export interface JobLog {
  log_tail: string | null;
  log_error?: string;
}

/** `{repository, jobId}` of a GitHub Actions job URL (`…/<owner>/<repo>/actions/runs/<run>/job/<job>`); null otherwise. */
export function actionsJobOf(url: string | null): { repository: string; jobId: string } | null {
  if (url === null) return null;
  const [, owner, repo, jobId] = /\/([^/]+)\/([^/]+)\/actions\/runs\/\d+\/job\/(\d+)(?:[/?#]|$)/.exec(url) ?? [];
  return owner === undefined || repo === undefined || jobId === undefined ? null : { repository: `${owner}/${repo}`, jobId };
}

const TIMESTAMP = /^﻿?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;
const CLEANUP = /Post job cleanup/;
const ERROR = /##\[error\]/;

/**
 * Cleans a raw job log: drops timestamps and ANSI codes, cuts at `Post job cleanup`, keeps the last
 * `LOG_TAIL_LINES` lines up to and including the last `##[error]` line and at most `LOG_TAIL_CHARS` characters. A cut
 * is noted in the first line.
 */
export function logTail(raw: string): string {
  let lines = raw.split(/\r?\n/).map((line) => line.replace(TIMESTAMP, '').replace(ANSI, ''));
  const cleanup = lines.findIndex((line) => CLEANUP.test(line));
  if (cleanup !== -1) lines = lines.slice(0, cleanup);
  while (lines.length > 0 && (lines.at(-1) ?? '').trim() === '') lines.pop();
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ERROR.test(lines[i] ?? '')) {
      end = i + 1;
      break;
    }
  }
  const total = lines.length;
  let kept = lines.slice(Math.max(0, end - LOG_TAIL_LINES), end);
  let text = kept.join('\n');
  while (text.length > LOG_TAIL_CHARS && kept.length > 1) {
    kept = kept.slice(1);
    text = kept.join('\n');
  }
  if (text.length > LOG_TAIL_CHARS) text = text.slice(text.length - LOG_TAIL_CHARS);
  const cut = kept.length < total || text.length < kept.join('\n').length;
  return cut ? `[log cut: last ${kept.length} of ${total} lines${end < total ? ' up to the last ##[error]' : ''}]\n${text}` : text;
}

/** Loads and cleans one job's log (`GET /repos/{repo}/actions/jobs/{id}/logs`, following the redirect). Never throws. */
export async function fetchJobLog(options: JobLogOptions, repository: string, jobId: string): Promise<JobLog> {
  try {
    const response = await options.fetch(`${restBase(options.endpoint)}/repos/${repository}/actions/jobs/${jobId}/logs`, {
      headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/vnd.github+json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const hint = response.status === 403 ? ' (the token needs "Actions: read")' : response.status === 404 || response.status === 410 ? ' (log not found or expired)' : '';
      return { log_tail: null, log_error: `HTTP ${response.status}${hint}` };
    }
    return { log_tail: logTail(await response.text()) };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? `timeout after ${options.timeoutMs} ms` : error instanceof Error ? error.message : String(error);
    return { log_tail: null, log_error: reason.slice(0, 200) };
  }
}

/**
 * Adds `log_tail` (or `log_tail: null` with `log_error`) to the failing checks that are GitHub Actions jobs; the first
 * `MAX_JOB_LOGS` of them are loaded, later ones say they were skipped. Other checks stay as they are. Never throws.
 */
export async function withJobLogs<T extends { url: string | null }>(options: JobLogOptions, failing: readonly T[]): Promise<Array<T & Partial<JobLog>>> {
  let loaded = 0;
  return Promise.all(
    failing.map(async (check): Promise<T & Partial<JobLog>> => {
      const job = actionsJobOf(check.url);
      if (job === null) return check;
      if (loaded >= MAX_JOB_LOGS) return { ...check, log_tail: null, log_error: `not loaded: only the first ${MAX_JOB_LOGS} failing jobs get a log` };
      loaded++;
      return { ...check, ...(await fetchJobLog(options, job.repository, job.jobId)) };
    }),
  );
}
