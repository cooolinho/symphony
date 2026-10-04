#!/usr/bin/env node
// Checks a finished e2e run: concurrency limit, dependencies, model, no code changes, completeness.
// Usage: node scripts/e2e/verify.ts <run-dir> [--env-file <path>]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseHistoryLine, repositoryFileName } from '../../src/history/history.ts';
import { clock, loadContext, type E2eContext } from './context.ts';
import { MODEL, ROOT_COUNT, dependencies, doneMarker, type RunRecord } from './scenario.ts';

interface Run {
  number: number;
  start: Date;
  end: Date | null;
  /** Model Symphony asked for (from the label). */
  requestedModel: string | null;
  /** Model that actually answered. */
  usedModel: string | null;
  outcome: string | null;
  turns: string | null;
  costUsd: number;
}

interface IssueDetail {
  state: string;
  closedAt: string | null;
  blockedBy: { nodes: Array<{ number: number }> };
  comments: { nodes: Array<{ body: string }> };
}

interface RepositoryDetail {
  pullRequests: { nodes: Array<{ number: number; createdAt: string; headRefName: string }> };
  refs: { nodes: Array<{ name: string }> };
  [alias: `i${number}`]: IssueDetail;
}

/** Runs of the history log, sorted by start. */
export function readRuns(historyFile: string): Run[] {
  const runs = new Map<string, Run>();
  const lines = fs.existsSync(historyFile) ? fs.readFileSync(historyFile, 'utf8').split('\n') : [];
  for (const entry of lines.map(parseHistoryLine)) {
    if (entry === null || (entry.event !== 'run_started' && entry.event !== 'run_finished')) continue;
    const { fields } = entry;
    const id = fields.run ?? '';
    const run = runs.get(id) ?? {
      number: Number(fields.issue?.split('#').at(-1)),
      start: new Date(fields.started_at ?? entry.ts),
      end: null,
      requestedModel: null,
      usedModel: null,
      outcome: null,
      turns: null,
      costUsd: 0,
    };
    if (entry.event === 'run_started') {
      run.start = new Date(entry.ts);
      run.requestedModel = fields.model ?? null;
    } else {
      run.end = new Date(entry.ts);
      run.usedModel = fields.model ?? null;
      run.outcome = fields.outcome ?? null;
      run.turns = fields.turns ?? null;
      run.costUsd = Number(fields.cost_usd ?? 0);
    }
    runs.set(id, run);
  }
  return [...runs.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Highest number of runs active at the same time. */
function peakOverlap(runs: Run[]): number {
  const events = runs.flatMap((run) => [
    { at: run.start.getTime(), delta: 1 },
    { at: (run.end ?? new Date()).getTime(), delta: -1 },
  ]);
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let current = 0;
  let peak = 0;
  for (const event of events) peak = Math.max(peak, (current += event.delta));
  return peak;
}

function tracePeak(traceFile: string): number {
  if (!fs.existsSync(traceFile)) return 0;
  return Math.max(0, ...[...fs.readFileSync(traceFile, 'utf8').matchAll(/running=(\d+)/g)].map((match) => Number(match[1])));
}

function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length))) ?? [];
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd()).join('\n');
}

export async function verify(context: E2eContext, runDir: string, out: (line: string) => void = console.log): Promise<boolean> {
  const record = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')) as RunRecord;
  const runs = readRuns(path.join(runDir, 'state', 'repositories', repositoryFileName(record.repository)));
  const byKey = new Map(record.issues.map((issue) => [issue.key, issue]));
  const keyOf = (number: number) => record.issues.find((issue) => issue.number === number)?.key ?? `#${number}`;

  const [owner, name] = record.repository.split('/');
  const { repository } = await context.github.gql<{ repository: RepositoryDetail }>(
    `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        ${record.issues.map((issue) => `i${issue.number}: issue(number: ${issue.number}) { ...detail }`).join('\n')}
        pullRequests(first: 50, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { number createdAt headRefName } }
        refs(refPrefix: "refs/heads/", query: "symphony/issue-", first: 100) { nodes { name } }
      }
    }
    fragment detail on Issue {
      state closedAt blockedBy(first: 20) { nodes { number } } comments(first: 50) { nodes { body } }
    }`,
    { owner, name },
  );
  const detail = (number: number): IssueDetail => {
    const issue = repository[`i${number}`];
    if (issue === undefined) throw new Error(`issue #${number} not found in ${record.repository}`);
    return issue;
  };
  const closedAt = (key: string) => detail(byKey.get(key)?.number ?? 0).closedAt;

  const checks: Array<{ ok: boolean; name: string; detail: string }> = [];

  const limit = context.config.agent.maxConcurrentAgents;
  const expectedPeak = Math.min(limit, ROOT_COUNT);
  const peak = peakOverlap(runs);
  const polledPeak = tracePeak(path.join(runDir, 'trace.log'));
  checks.push({
    ok: peak === expectedPeak && polledPeak <= limit,
    name: `At most ${limit} agents at once`,
    detail: `peak ${peak} in the history (expected ${expectedPeak}), ${polledPeak} in the API trace`,
  });

  const early = runs.flatMap((run) => {
    const issue = record.issues.find((candidate) => candidate.number === run.number);
    return (issue === undefined ? [] : dependencies(issue)).flatMap((key) => {
      const closed = closedAt(key);
      return closed !== null && new Date(closed) < run.start ? [] : [`${issue?.key} started ${clock(run.start)}, ${key} closed ${clock(closed)}`];
    });
  });
  const relationDrift = record.issues.filter((issue) => {
    const actual = detail(issue.number).blockedBy.nodes.map((node) => keyOf(node.number));
    return actual.sort().join(',') !== [...issue.relationships].sort().join(',');
  });
  checks.push({
    ok: early.length === 0 && relationDrift.length === 0 && runs.length > 0,
    name: 'No issue started before all its dependencies were closed',
    detail: [
      ...early,
      ...relationDrift.map((issue) => `relationships of ${issue.key} differ from the scenario`),
    ].join('; ') || `${runs.length} runs checked`,
  });

  const wrongModel = runs.filter((run) => run.requestedModel !== MODEL || !(run.usedModel ?? '').includes(MODEL));
  checks.push({
    ok: wrongModel.length === 0 && runs.length > 0,
    name: `Every run used ${MODEL}`,
    detail: wrongModel.map((run) => `${keyOf(run.number)}: ${run.requestedModel} → ${run.usedModel}`).join('; ') ||
      [...new Set(runs.map((run) => run.usedModel))].join(', '),
  });

  const numbers = new Set(record.issues.map((issue) => issue.number));
  const pullRequests = repository.pullRequests.nodes.filter((pr) => new Date(pr.createdAt) >= new Date(record.startedAt));
  const branches = repository.refs.nodes.filter((ref) => numbers.has(Number(ref.name.split('-').at(-1))));
  checks.push({
    ok: pullRequests.length === 0 && branches.length === 0,
    name: 'No code changes',
    detail: `pull requests: ${pullRequests.map((pr) => `#${pr.number}`).join(', ') || 'none'}, issue branches: ${branches.map((ref) => ref.name).join(', ') || 'none'}`,
  });

  const unfinished = record.issues.filter(
    (issue) =>
      detail(issue.number).state !== 'CLOSED' || !detail(issue.number).comments.nodes.some((comment) => comment.body.includes(doneMarker(issue.key))),
  );
  checks.push({
    ok: unfinished.length === 0,
    name: 'Every issue commented and closed',
    detail: unfinished.length === 0 ? `${record.issues.length}/${record.issues.length}` : `missing: ${unfinished.map((issue) => issue.key).join(', ')}`,
  });

  const rows = [['Issue', 'Dependencies (closed)', 'Start', 'End', 'Outcome', 'Turns', 'USD']];
  for (const issue of record.issues) {
    const own = runs.filter((run) => run.number === issue.number);
    const deps = dependencies(issue).map((key) => `${key} ${clock(closedAt(key))}${key === issue.textBlocker ? ' (text)' : ''}`);
    rows.push([
      `${issue.key} #${issue.number}`,
      deps.join(', ') || '–',
      own.map((run) => clock(run.start)).join(', ') || '–',
      own.map((run) => clock(run.end)).join(', ') || '–',
      own.map((run) => run.outcome ?? 'running').join(', ') || '–',
      own.map((run) => run.turns ?? '–').join(', ') || '–',
      own.reduce((sum, run) => sum + run.costUsd, 0).toFixed(4),
    ]);
  }
  out('');
  out(table(rows));
  out('');
  for (const check of checks) out(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}: ${check.detail}`);
  out(`\n${runs.length} runs, ${runs.reduce((sum, run) => sum + run.costUsd, 0).toFixed(4)} USD (model-costs.yml), times in UTC`);
  return checks.every((check) => check.ok);
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'env-file': { type: 'string' } } });
  const runDir = positionals[0];
  if (runDir === undefined) {
    process.stderr.write('Usage: node scripts/e2e/verify.ts <run-dir> [--env-file <path>]\n');
    process.exit(2);
  }
  loadContext({ envFile: values['env-file'] })
    .then((context) => verify(context, path.resolve(runDir)))
    .then(
      (ok) => process.exit(ok ? 0 : 1),
      (error: unknown) => {
        process.stderr.write(`e2e verify: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      },
    );
}
