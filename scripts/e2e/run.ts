#!/usr/bin/env node
// End-to-end test of the orchestration on a real board: creates the scenario, runs Symphony, plays the
// reviewer who closes handed-off issues, then verifies concurrency and dependencies. See docs/e2e.md.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Issue } from '../../src/tracker/types.ts';
import { ROOT, STATUS, clock, closeIssue, loadBoard, loadContext, readItems, setStatus, sleep, type Board, type E2eContext } from './context.ts';
import { ROOT_COUNT, createScenario, dependencies, type RunRecord } from './scenario.ts';
import { verify } from './verify.ts';

const USAGE = `Usage: npm run e2e -- [options]

Creates nine test issues on the board, runs Symphony against them and checks that no more than
max_concurrent_agents agents run at once and that no issue starts before its dependencies are closed.
Uses WORKFLOW.md and .env of this checkout. Costs real Claude usage (about 0.05 USD per issue with Sonnet).

Options:
  --env-file <path>     dotenv file for Symphony and the test (default: .env next to WORKFLOW.md)
  --port <n>            dashboard/API port of the test instance (default: server.port, else 4000)
  --review-delay <s>    seconds an issue stays in "${STATUS.handoff}" before the simulated review closes it (default: 60)
  --timeout <min>       give up after this many minutes (default: 45)
  -h, --help            show this help
`;

const TICK_MS = 5_000;
const REVIEW_EVERY_TICKS = 3;

interface StateSnapshot {
  counts: { running: number };
  running: Array<{ issue_identifier: string }>;
}

function positiveNumber(value: string | undefined, fallback: number, option: string): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`--${option} must be a non-negative number (got ${value})`);
  return number;
}

async function fetchState(port: number): Promise<StateSnapshot | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/state`, { signal: AbortSignal.timeout(4_000) });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<StateSnapshot>;
    return body.counts !== undefined && Array.isArray(body.running) ? (body as StateSnapshot) : null;
  } catch {
    return null;
  }
}

async function portAnswers(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

const issueNumber = (identifier: string) => Number(identifier.split('#').at(-1));

/** Same decision as --dry-run: exactly the scenario issues are active, and only the free ones are dispatchable. */
function dispatchProblems(record: RunRecord, candidates: Issue[]): string[] {
  const problems: string[] = [];
  const numbers = new Set(record.issues.map((issue) => issue.number));
  for (const candidate of candidates) {
    if (!numbers.has(issueNumber(candidate.identifier))) problems.push(`${candidate.identifier} is active but not part of the test`);
  }
  for (const issue of record.issues) {
    const candidate = candidates.find((c) => issueNumber(c.identifier) === issue.number);
    const expected = dependencies(issue).length === 0;
    if (candidate === undefined) problems.push(`${issue.key} #${issue.number} is not in an active state`);
    else if (candidate.dispatchable !== expected) problems.push(`${issue.key} #${issue.number} dispatchable=${candidate.dispatchable}, expected ${expected}`);
  }
  return problems;
}

function startSymphony(context: E2eContext, port: number, runDir: string): ChildProcess {
  const output = fs.openSync(path.join(runDir, 'symphony.log'), 'a');
  const args = [path.join(ROOT, 'src', 'cli.ts'), context.workflowPath, '--port', String(port), '--log-dir', path.join(runDir, 'state')];
  if (context.envFile !== null) args.push('--env-file', context.envFile);
  return spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', output, output] });
}

async function stopSymphony(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGINT');
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  await exited;
  clearTimeout(timer);
}

/** Simulated review: an issue that stayed in the handoff status for `delayMs` is moved to Done and closed. */
class Reviewer {
  #firstSeen = new Map<number, number>();
  #context: E2eContext;
  #board: Board;
  #record: RunRecord;
  #delayMs: number;
  #log: (line: string) => void;

  constructor(context: E2eContext, board: Board, record: RunRecord, delayMs: number, log: (line: string) => void) {
    this.#context = context;
    this.#board = board;
    this.#record = record;
    this.#delayMs = delayMs;
    this.#log = log;
  }

  /** Reviews due issues; true once every test issue is closed. */
  async review(): Promise<boolean> {
    const items = await readItems(this.#context, this.#record.issues.map((issue) => issue.itemId));
    for (const item of items) {
      if (item.issueState !== 'OPEN' || item.status?.toLowerCase() !== STATUS.handoff.toLowerCase()) continue;
      const seen = this.#firstSeen.get(item.number) ?? Date.now();
      if (!this.#firstSeen.has(item.number)) {
        this.#firstSeen.set(item.number, seen);
        this.#log(`#${item.number} is in "${STATUS.handoff}"`);
      }
      if (Date.now() - seen < this.#delayMs) continue;
      const issue = this.#record.issues.find((candidate) => candidate.number === item.number);
      if (issue === undefined) continue;
      await setStatus(this.#context, this.#board, item.itemId, STATUS.done);
      const closedHere = await closeIssue(this.#context, issue.issueId);
      this.#log(`#${item.number} reviewed: "${STATUS.done}", ${closedHere ? 'closed' : 'closed by the board'}`);
    }
    return items.length === this.#record.issues.length && items.every((item) => item.issueState === 'CLOSED');
  }
}

/** Run directory once test issues are being created; failures after that leave issues on the board. */
let createdIn: string | null = null;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'env-file': { type: 'string' },
      port: { type: 'string' },
      'review-delay': { type: 'string' },
      timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const reviewDelayMs = positiveNumber(values['review-delay'], 60, 'review-delay') * 1000;
  const timeoutMs = positiveNumber(values.timeout, 45, 'timeout') * 60_000;

  const context = await loadContext({ envFile: values['env-file'] });
  const port = positiveNumber(values.port, context.config.server.port ?? 4000, 'port');
  const limit = context.config.agent.maxConcurrentAgents;
  const runDir = path.join(ROOT, 'logs', 'e2e', new Date().toISOString().replace(/[:.]/g, '-'));
  const say = (line: string) => console.log(`${clock()} ${line}`);
  const trace = (line: string) => fs.appendFileSync(path.join(runDir, 'trace.log'), `${new Date().toISOString()} ${line}\n`);
  const reviewLog = (line: string) => {
    fs.appendFileSync(path.join(runDir, 'reviewer.log'), `${new Date().toISOString()} ${line}\n`);
    say(line);
  };

  say(`board ${context.settings.owner}/projects/${context.settings.projectNumber}, repository ${context.repository}, limit ${limit} agents`);
  if (limit >= ROOT_COUNT) say(`note: the scenario has ${ROOT_COUNT} free issues, so with a limit of ${limit} none has to wait for a slot`);

  if (await portAnswers(port)) throw new Error(`port ${port} is in use; stop the running Symphony or pass --port`);
  const active = await context.adapter.fetchIssuesByStates(context.config.tracker.activeStates);
  if (active.length > 0) {
    throw new Error(`the board already has active issues (${active.map((issue) => issue.identifier).join(', ')}); Symphony would work on them too`);
  }
  const board = await loadBoard(context);

  fs.mkdirSync(runDir, { recursive: true });
  say(`run directory ${path.relative(ROOT, runDir)}`);
  createdIn = runDir;
  const record = await createScenario(context, board, say);
  fs.writeFileSync(path.join(runDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`);
  const problems = dispatchProblems(record, await context.adapter.fetchIssuesByStates(context.config.tracker.activeStates));
  if (problems.length > 0) throw new Error(`unexpected dispatch decisions, Symphony not started: ${problems.join('; ')}`);
  say(`dispatchable: ${record.issues.filter((issue) => dependencies(issue).length === 0).map((issue) => `#${issue.number}`).join(', ')}; all others wait`);

  const symphony = startSymphony(context, port, runDir);
  say(`Symphony started (pid ${symphony.pid}), dashboard http://127.0.0.1:${port}/`);
  let interrupted = false;
  process.on('SIGINT', () => {
    interrupted = true;
  });

  const reviewer = new Reviewer(context, board, record, reviewDelayMs, reviewLog);
  const deadline = Date.now() + timeoutMs;
  let lastRunning = '';
  let allClosed = false;
  try {
    for (let tick = 0; ; tick++) {
      if (interrupted) throw new Error('interrupted');
      if (symphony.exitCode !== null || symphony.signalCode !== null) {
        throw new Error(`Symphony exited early (${symphony.exitCode ?? symphony.signalCode}), see ${path.relative(ROOT, runDir)}/symphony.log`);
      }
      const state = await fetchState(port);
      if (state === null) {
        trace('api-unreachable');
      } else {
        const ids = state.running.map((row) => `#${issueNumber(row.issue_identifier)}`).join(',');
        trace(`running=${state.counts.running} ids=${ids}`);
        if (ids !== lastRunning) say(`running ${state.counts.running}/${limit}: ${ids || '–'}`);
        if (state.counts.running > limit) say(`WARNING: ${state.counts.running} agents running, limit is ${limit}`);
        lastRunning = ids;
      }
      if (tick % REVIEW_EVERY_TICKS === 0) {
        try {
          allClosed = await reviewer.review();
        } catch (error) {
          reviewLog(`review failed, retrying: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (allClosed && state?.counts.running === 0) break;
      if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 60_000} minutes`);
      await sleep(TICK_MS);
    }
  } finally {
    await stopSymphony(symphony);
  }
  say('all test issues closed, no agent running; Symphony stopped');
  return (await verify(context, runDir)) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`e2e: ${error instanceof Error ? error.message : String(error)}\n`);
    if (createdIn !== null) {
      process.stderr.write(`Test issues created so far stay on the board; details in ${path.relative(ROOT, createdIn)}\n`);
    }
    process.exit(1);
  },
);
