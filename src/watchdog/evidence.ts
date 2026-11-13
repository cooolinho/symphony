import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseHistoryLine, repositoryFileName, type HistoryEntry } from '../history/history.ts';
import type { IssueComment } from '../tracker/types.ts';
import { truncate } from '../util/text.ts';
import { workspaceKey } from '../workspace/manager.ts';

/** What the diagnosis session gets handed (prompt variable `evidence`); every text is bounded. */
export interface Evidence {
  history: string;
  log: string;
  state: string;
  github_status: string;
  git: string;
  transcripts: Array<{ file: string; excerpt: string }>;
  comments: Array<{ author: string; created_at: string; body: string }>;
}

const HISTORY_LINES = 40;
const LOG_LINES = 80;
const LOG_TAIL_BYTES = 4 * 1024 * 1024;
const LOG_WINDOW_MS = 30 * 60_000;
const TRANSCRIPTS = 2;
const TRANSCRIPT_EXCERPT = 8_000;
const COMMENTS = 15;
const COMMENT_MAX = 3_000;
const STATE_MAX = 6_000;
const FETCH_TIMEOUT_MS = 10_000;

/** Reads the last `bytes` of a file as lines; [] when it cannot be read. */
function tailLines(file: string, bytes: number): string[] {
  try {
    const { size } = fs.statSync(file);
    const start = Math.max(0, size - bytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8').split('\n');
      if (start > 0) lines.shift();
      return lines.filter((line) => line.trim() !== '');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

/** The repository log of `repo`, parsed; [] when there is none. */
export function readRepositoryHistory(logDir: string, repo: string | null): { lines: string[]; entries: HistoryEntry[] } {
  if (repo === null) return { lines: [], entries: [] };
  const lines = tailLines(path.join(logDir, 'repositories', repositoryFileName(repo)), LOG_TAIL_BYTES);
  const entries: HistoryEntry[] = [];
  const kept: string[] = [];
  for (const line of lines) {
    const entry = parseHistoryLine(line);
    if (entry === null) continue;
    entries.push(entry);
    kept.push(line);
  }
  return { lines: kept, entries };
}

export function historyExcerpt(lines: readonly string[], entries: readonly HistoryEntry[], identifier: string): string {
  const own = lines.filter((_, index) => entries[index]?.fields.issue === identifier);
  return own.slice(-HISTORY_LINES).join('\n');
}

/** Orchestrator log lines of the issue, plus warnings and errors within half an hour of the block. */
export function logExcerpt(file: string | null, identifier: string, blockedAt: Date | null): string {
  if (file === null) return '';
  const lines = tailLines(file, LOG_TAIL_BYTES);
  const at = blockedAt?.getTime() ?? null;
  const picked = lines.filter((line) => {
    if (line.includes(identifier)) return true;
    if (at === null || !/level=(warn|error)/.test(line)) return false;
    const ts = Date.parse(/^ts=(\S+)/.exec(line)?.[1] ?? '');
    return Number.isFinite(ts) && Math.abs(ts - at) <= LOG_WINDOW_MS;
  });
  return picked.slice(-LOG_LINES).join('\n');
}

type Json = Record<string, unknown>;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'object' && part !== null && typeof (part as Json).text === 'string' ? (part as Json).text : '')).join('\n');
  return '';
}

/**
 * The parts of a transcript that explain a block: failed tool calls, error results, API retries and the last
 * `report_result` / `add_comment` / `set_status` call. Bounded to TRANSCRIPT_EXCERPT characters, newest kept.
 */
export function transcriptExcerpt(lines: readonly string[]): string {
  const out: string[] = [];
  let lastHandOff: string | null = null;
  for (const line of lines) {
    let record: Json;
    try {
      record = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    const message = record.message as Json | undefined;
    if (message === undefined) continue;
    const at = typeof record.at === 'string' ? record.at : '';
    const inner = message.message as Json | undefined;
    const content = Array.isArray(inner?.content) ? (inner.content as Json[]) : [];
    if (message.type === 'assistant') {
      for (const block of content) {
        if (block.type === 'tool_use' && typeof block.name === 'string' && /report_result|add_comment|set_status/.test(block.name)) {
          lastHandOff = `${at} ${block.name} ${truncate(JSON.stringify(block.input), 2_000)}`;
        }
      }
    } else if (message.type === 'user') {
      for (const block of content) {
        if (block.type === 'tool_result' && block.is_error === true) out.push(`${at} tool error: ${truncate(textOf(block.content), 600)}`);
      }
    } else if (message.type === 'result' && (message.is_error === true || message.subtype !== 'success')) {
      out.push(`${at} result ${String(message.subtype)}: ${truncate(textOf(message.result), 600)}`);
    } else if (message.type === 'system' && message.subtype === 'api_retry') {
      out.push(`${at} api retry: ${truncate(JSON.stringify(message), 300)}`);
    }
  }
  if (lastHandOff !== null) out.push(`last hand-off call: ${lastHandOff}`);
  const text = out.join('\n');
  return text.length <= TRANSCRIPT_EXCERPT ? text : `…\n${text.slice(-TRANSCRIPT_EXCERPT)}`;
}

/** Excerpts of the newest transcripts of the issue (`sessions/<workspace key>/*.jsonl`). */
export function transcriptExcerpts(logDir: string, identifier: string): Array<{ file: string; excerpt: string }> {
  const dir = path.join(logDir, 'sessions', workspaceKey(identifier));
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
  return files.slice(-TRANSCRIPTS).map((name) => {
    const file = path.join(dir, name);
    return { file, excerpt: transcriptExcerpt(tailLines(file, 32 * 1024 * 1024)) || '(no errors recorded)' };
  });
}

/** Removes Symphony's hidden markers, so the session never quotes one back. */
export function stripMarkers(text: string): string {
  return text.replace(/<!--\s*symphony:[\s\S]*?-->/gi, '').trim();
}

export function commentEvidence(comments: readonly IssueComment[]): Evidence['comments'] {
  return comments.slice(-COMMENTS).map((comment) => ({
    author: comment.author ?? 'ghost',
    created_at: comment.createdAt.toISOString(),
    body: truncate(stripMarkers(comment.body), COMMENT_MAX),
  }));
}

async function fetchJson(fetchFn: typeof fetch, url: string): Promise<unknown> {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** `/api/v1/state`, or null when the orchestrator cannot be reached. */
export async function readOrchestratorState(fetchFn: typeof fetch, apiUrl: string | null): Promise<Json | null> {
  if (apiUrl === null) return null;
  try {
    return (await fetchJson(fetchFn, `${apiUrl}/api/v1/state`)) as Json;
  } catch {
    return null;
  }
}

/** The part of the state that concerns the issue: health, its rows, holds. */
export function stateExcerpt(state: Json | null, identifier: string): string {
  if (state === null) return '(orchestrator not reachable)';
  const mine = (rows: unknown) => (Array.isArray(rows) ? rows.filter((row) => JSON.stringify(row).includes(identifier)) : []);
  const excerpt = {
    health: state.health,
    counts: state.counts,
    model_holds: state.model_holds,
    blocked: mine(state.blocked),
    running: mine(state.running),
    retrying: mine(state.retrying),
    paused: mine(state.paused),
  };
  return truncate(JSON.stringify(excerpt, null, 2), STATE_MAX);
}

/** True when the orchestrator holds the model family (a usage limit or the operator): the watchdog waits then too. */
export function modelHeld(state: Json | null, model: string): boolean {
  const holds = state?.model_holds;
  if (!Array.isArray(holds)) return false;
  const family = model.toLowerCase();
  return holds.some((hold) => typeof hold === 'object' && hold !== null && String((hold as Json).model ?? '').toLowerCase().includes(family));
}

/** Incidents of githubstatus.com created or updated in the last 24 hours. */
export async function githubStatus(fetchFn: typeof fetch, now: Date): Promise<string> {
  try {
    const body = (await fetchJson(fetchFn, 'https://www.githubstatus.com/api/v2/incidents.json')) as { incidents?: Json[] };
    const since = now.getTime() - 24 * 3_600_000;
    const recent = (body.incidents ?? []).filter((incident) => Date.parse(String(incident.updated_at ?? incident.created_at)) >= since);
    if (recent.length === 0) return 'no incidents in the last 24 hours';
    return recent
      .map((incident) => `${String(incident.name)}: ${String(incident.status)} (created ${String(incident.created_at)}, resolved ${String(incident.resolved_at ?? 'not yet')})`)
      .join('\n');
  } catch (error) {
    return `githubstatus.com not reachable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function run(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['--no-optional-locks', ...args], { cwd, timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve(error === null ? stdout.trim() : `git ${args.join(' ')} failed: ${(stderr || error.message).trim()}`);
    });
  });
}

/** Files changed in the workspace between `base` and HEAD; null when git cannot tell. */
export function changedSince(workspace: string | null, base: string): Promise<string[] | null> {
  if (workspace === null || !fs.existsSync(path.join(workspace, '.git'))) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('git', ['--no-optional-locks', 'diff', '--name-only', base, 'HEAD'], { cwd: workspace, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(error === null ? stdout.split('\n').filter((line) => line.trim() !== '') : null);
    });
  });
}

/** Branch, local changes and the newest commits of the workspace; '' without one. */
export async function gitState(workspace: string | null): Promise<string> {
  if (workspace === null || !fs.existsSync(path.join(workspace, '.git'))) return '';
  const [status, log] = await Promise.all([run(workspace, ['status', '-sb']), run(workspace, ['log', '--oneline', '-8', '--decorate'])]);
  return truncate(`${status}\n\n${log}`, 4_000);
}
