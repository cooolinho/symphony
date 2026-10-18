#!/usr/bin/env node
// Merges a Symphony history (repository logs, session transcripts, issue archives) into another state directory
// without dropping what is already there. scripts/push-history.sh ships this file into the server container and runs
// it there, so it imports node: modules only (the image has no scripts/). See docs/docker.md.
//
//   node merge-history.ts --from <incoming-state> --into <state> [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

export interface MergeOptions {
  from: string;
  into: string;
  dryRun: boolean;
}

export interface MergeSummary {
  /** Incoming log files with the number of lines the target lacked. */
  logs: Array<{ file: string; added: number }>;
  sessions: { copied: number; completed: number; present: number };
  issues: { written: number; kept: number; unreadable: string[] };
}

/** Non-empty lines of a file; empty when it does not exist. */
function readLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
}

function tsOf(line: string): string {
  return /^ts=(\S+)/.exec(line)?.[1] ?? '';
}

/** Writes via a temporary file and rename, so a crash never leaves a half-written file. */
function writeAtomic(file: string, data: string | NodeJS.ArrayBufferView): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.merge`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function listNames(dir: string, suffix: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith(suffix)).sort();
}

/** Files below dir, relative to it; empty when dir does not exist. */
function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}

/**
 * Repository logs are append-only, one `ts=… event=…` line per event: the union of both files, each line once,
 * ordered by `ts` (stable, so lines of the same instant keep the target's order before the incoming ones).
 */
export function mergeLogs(options: MergeOptions): MergeSummary['logs'] {
  const result: MergeSummary['logs'] = [];
  const from = path.join(options.from, 'repositories');
  const into = path.join(options.into, 'repositories');
  for (const name of listNames(from, '.log')) {
    const target = readLines(path.join(into, name));
    const seen = new Set(target);
    const merged = [...seen];
    for (const line of readLines(path.join(from, name))) {
      if (seen.has(line)) continue;
      seen.add(line);
      merged.push(line);
    }
    const added = seen.size - new Set(target).size;
    result.push({ file: name, added });
    if (added === 0 || options.dryRun) continue;
    merged.sort((a, b) => (tsOf(a) < tsOf(b) ? -1 : tsOf(a) > tsOf(b) ? 1 : 0));
    writeAtomic(path.join(into, name), `${merged.join('\n')}\n`);
  }
  return result;
}

/**
 * Transcripts are named after the session start (ms) and only appended to: a missing file is copied, a larger
 * incoming one replaces the shorter copy (it was transferred while the session still ran), anything else stays.
 */
export function mergeSessions(options: MergeOptions): MergeSummary['sessions'] {
  const result = { copied: 0, completed: 0, present: 0 };
  const from = path.join(options.from, 'sessions');
  const into = path.join(options.into, 'sessions');
  for (const rel of listFiles(from)) {
    const source = path.join(from, rel);
    const target = path.join(into, rel);
    const exists = fs.existsSync(target);
    if (exists && fs.statSync(target).size >= fs.statSync(source).size) {
      result.present++;
      continue;
    }
    if (exists) result.completed++;
    else result.copied++;
    if (!options.dryRun) writeAtomic(target, fs.readFileSync(source));
  }
  return result;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function archivedAt(issue: Record<string, unknown> | null): number {
  const value = issue === null ? NaN : Date.parse(String(issue.archived_at));
  return Number.isNaN(value) ? -Infinity : value;
}

/**
 * Points every `transcript` path (sessions and pipeline stages) at `<to>/sessions/` when its file came along in
 * `<from>/sessions/`. Archives hold absolute paths of the machine that wrote them; a transcript is
 * `<workspace key>/<start>.jsonl` below the sessions directory, so the last two segments identify it.
 */
export function rewriteTranscripts(value: unknown, from: string, to: string): void {
  if (Array.isArray(value)) {
    for (const item of value) rewriteTranscripts(item, from, to);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    if (key === 'transcript' && typeof item === 'string') {
      const rel = item.split('/').slice(-2).join('/');
      if (fs.existsSync(path.join(from, 'sessions', rel))) record[key] = path.join(to, 'sessions', rel);
    } else {
      rewriteTranscripts(item, from, to);
    }
  }
}

/**
 * An issue archive holds the last claim of an issue: the newer `archived_at` wins as a whole, the server's copy on
 * a tie. Incoming transcript paths are rewritten to the target directory first.
 */
export function mergeIssues(options: MergeOptions): MergeSummary['issues'] {
  const result = { written: 0, kept: 0, unreadable: [] as string[] };
  const from = path.join(options.from, 'issues');
  const into = path.join(options.into, 'issues');
  for (const name of listNames(from, '.json')) {
    const incoming = readJson(path.join(from, name));
    if (incoming === null) {
      result.unreadable.push(name);
      continue;
    }
    const target = path.join(into, name);
    if (fs.existsSync(target) && archivedAt(readJson(target)) >= archivedAt(incoming)) {
      result.kept++;
      continue;
    }
    result.written++;
    if (options.dryRun) continue;
    rewriteTranscripts(incoming, options.from, options.into);
    writeAtomic(target, JSON.stringify(incoming));
  }
  return result;
}

/** What the merge must have achieved; one message per violation, empty when everything arrived. */
export function verifyMerge(options: MergeOptions): string[] {
  const problems: string[] = [];
  for (const name of listNames(path.join(options.from, 'repositories'), '.log')) {
    const target = new Set(readLines(path.join(options.into, 'repositories', name)));
    const missing = readLines(path.join(options.from, 'repositories', name)).filter((line) => !target.has(line)).length;
    if (missing > 0) problems.push(`repositories/${name}: ${missing} lines missing`);
  }
  for (const rel of listFiles(path.join(options.from, 'sessions'))) {
    const target = path.join(options.into, 'sessions', rel);
    if (!fs.existsSync(target) || fs.statSync(target).size < fs.statSync(path.join(options.from, 'sessions', rel)).size) {
      problems.push(`sessions/${rel}: missing or shorter`);
    }
  }
  for (const name of listNames(path.join(options.from, 'issues'), '.json')) {
    const incoming = readJson(path.join(options.from, 'issues', name));
    if (incoming === null) continue;
    const target = readJson(path.join(options.into, 'issues', name));
    if (target === null || archivedAt(target) < archivedAt(incoming)) problems.push(`issues/${name}: missing or older`);
  }
  return problems;
}

export function mergeHistory(options: MergeOptions): MergeSummary {
  return { logs: mergeLogs(options), sessions: mergeSessions(options), issues: mergeIssues(options) };
}

export function formatSummary(summary: MergeSummary, dryRun: boolean): string {
  const grown = summary.logs.filter((log) => log.added > 0);
  const lines = grown.length === 0
    ? ['Repository logs: no new lines']
    : ['Repository logs:', ...grown.map((log) => `  +${log.added} lines  ${log.file}`)];
  const s = summary.sessions;
  lines.push(`Transcripts:     +${s.copied} new, ${s.completed} completed, ${s.present} already there`);
  const i = summary.issues;
  lines.push(`Issue archives:  ${i.written} taken over, ${i.kept} newer or equal on the server`);
  if (i.unreadable.length > 0) lines.push(`                 skipped (unreadable): ${i.unreadable.join(', ')}`);
  return `${dryRun ? 'Would merge (dry run, nothing written):\n' : ''}${lines.join('\n')}\n`;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { from: { type: 'string' }, into: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
  });
  if (values.from === undefined || values.into === undefined) {
    process.stderr.write('Usage: node scripts/merge-history.ts --from <incoming-state> --into <state> [--dry-run]\n');
    process.exit(2);
  }
  const options: MergeOptions = {
    from: path.resolve(values.from),
    into: path.resolve(values.into),
    dryRun: values['dry-run'],
  };
  process.stdout.write(formatSummary(mergeHistory(options), options.dryRun));
  if (!options.dryRun) {
    const problems = verifyMerge(options);
    if (problems.length > 0) {
      process.stderr.write(`merge-history: verification failed:\n${problems.map((problem) => `  ${problem}`).join('\n')}\n`);
      process.exit(1);
    }
    process.stdout.write('Verified: every incoming line, transcript and archive is on the target.\n');
  }
}
