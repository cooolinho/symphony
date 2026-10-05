#!/usr/bin/env node
// End-to-end test of the orchestration on a real board: creates the scenario, runs Symphony, plays the
// reviewer who closes handed-off issues, then verifies concurrency and dependencies. With --scenario roles it runs
// the developer → checks → reviewer → handoff lifecycle with a generated workflow instead. See docs/e2e.md.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Issue } from '../../src/tracker/types.ts';
import { ROOT, STATUS, clock, closeIssue, loadBoard, loadContext, readItems, setStatus, sleep, statusOption, type Board, type E2eContext } from './context.ts';
import { AGENT_REVIEW_LIMIT, ROLES_FILES, ROLES_SCENARIO, ROLE_STATUS, rolesIssueBody, writeRolesWorkflow } from './roles.ts';
import { ROOT_COUNT, createScenario, dependencies, type RunRecord, type ScenarioName } from './scenario.ts';
import { verify } from './verify.ts';

const USAGE = `Usage: npm run e2e -- [options]

Scenario "default": creates nine test issues on the board, runs Symphony against them and checks that no
more than max_concurrent_agents agents run at once and that no issue starts before its dependencies are closed.
Costs real Claude usage (about 0.05 USD per issue with Sonnet).

Scenario "roles": creates three test issues and runs Symphony with a workflow generated from WORKFLOW.md
(roles developer and reviewer, "${ROLE_STATUS.review}" as active column limited to ${AGENT_REVIEW_LIMIT} agent, an entry check
that fails once per issue). Checks the path ${STATUS.start} → ${ROLE_STATUS.progress} → ${ROLE_STATUS.review} → ${STATUS.handoff}
(one issue rejected once), denied transitions, check and handoff lines and the column limit.
The board needs the columns "${ROLE_STATUS.review}" and "${ROLE_STATUS.blocked}". About eight Sonnet sessions,
roughly 0.50–1 USD; the issues stay open in "${STATUS.handoff}".

Both use WORKFLOW.md and .env of this checkout and leave comment-only issues on the board.

Options:
  --scenario <name>     default | roles (default: default)
  --env-file <path>     dotenv file for Symphony and the test (default: .env next to WORKFLOW.md)
  --port <n>            dashboard/API port of the test instance (default: server.port, else 4000)
  --review-delay <s>    default scenario: seconds an issue stays in "${STATUS.handoff}" before the simulated
                        review closes it (default: 60)
  --timeout <min>       give up after this many minutes (default: 45)
  -h, --help            show this help
`;

const TICK_MS = 5_000;
/** The roles scenario reads the board every tick; a shorter tick catches brief stays in a column. */
const ROLES_TICK_MS = 3_000;
const REVIEW_EVERY_TICKS = 3;
const SCENARIOS: readonly ScenarioName[] = ['default', 'roles'];

interface StateSnapshot {
  counts: { running: number };
  running: Array<{ issue_identifier: string; state?: string }>;
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

/** Roles scenario: records every status change of the test issues; true once none is in an active state. */
class StatusRecorder {
  #last = new Map<number, string | null>();
  #context: E2eContext;
  #record: RunRecord;
  #file: string;
  #log: (line: string) => void;

  constructor(context: E2eContext, record: RunRecord, file: string, log: (line: string) => void) {
    this.#context = context;
    this.#record = record;
    this.#file = file;
    this.#log = log;
  }

  async poll(): Promise<boolean> {
    const items = await readItems(this.#context, this.#record.issues.map((issue) => issue.itemId));
    const at = new Date().toISOString();
    for (const item of items) {
      if (this.#last.has(item.number) && this.#last.get(item.number) === item.status) continue;
      this.#last.set(item.number, item.status);
      fs.appendFileSync(this.#file, `${JSON.stringify({ at, number: item.number, status: item.status })}\n`);
      const key = this.#record.issues.find((issue) => issue.number === item.number)?.key ?? '';
      this.#log(`${key} #${item.number} → ${item.status ?? 'No Status'}`);
    }
    const active = this.#context.config.tracker.activeStates.map((state) => state.toLowerCase());
    return items.length === this.#record.issues.length && items.every((item) => !active.includes((item.status ?? '').toLowerCase()));
  }
}

/** Run directory once test issues are being created; failures after that leave issues on the board. */
let createdIn: string | null = null;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string' },
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
  const scenario = (values.scenario ?? 'default') as ScenarioName;
  if (!SCENARIOS.includes(scenario)) throw new Error(`--scenario must be one of ${SCENARIOS.join(', ')} (got ${values.scenario})`);
  const roles = scenario === 'roles';
  const reviewDelayMs = positiveNumber(values['review-delay'], 60, 'review-delay') * 1000;
  const timeoutMs = positiveNumber(values.timeout, 45, 'timeout') * 60_000;

  const runDir = path.join(ROOT, 'logs', 'e2e', new Date().toISOString().replace(/[:.]/g, '-'));
  let context = await loadContext({ envFile: values['env-file'] });
  if (roles) {
    fs.mkdirSync(runDir, { recursive: true });
    context = await loadContext({ workflowPath: writeRolesWorkflow(ROOT, runDir), envFile: context.envFile ?? undefined });
  }
  const port = positiveNumber(values.port, context.config.server.port ?? 4000, 'port');
  const limit = context.config.agent.maxConcurrentAgents;
  const say = (line: string) => console.log(`${clock()} ${line}`);
  const trace = (line: string) => fs.appendFileSync(path.join(runDir, 'trace.log'), `${new Date().toISOString()} ${line}\n`);
  const reviewLog = (line: string) => {
    fs.appendFileSync(path.join(runDir, 'reviewer.log'), `${new Date().toISOString()} ${line}\n`);
    say(line);
  };

  say(`scenario ${scenario}, board ${context.settings.owner}/projects/${context.settings.projectNumber}, repository ${context.repository}, limit ${limit} agents`);
  if (roles) say(`workflow ${path.relative(ROOT, context.workflowPath)}, at most ${AGENT_REVIEW_LIMIT} agent in "${ROLE_STATUS.review}"`);
  else if (limit >= ROOT_COUNT) say(`note: the scenario has ${ROOT_COUNT} free issues, so with a limit of ${limit} none has to wait for a slot`);

  if (await portAnswers(port)) throw new Error(`port ${port} is in use; stop the running Symphony or pass --port`);
  const active = await context.adapter.fetchIssuesByStates(context.config.tracker.activeStates);
  if (active.length > 0) {
    throw new Error(`the board already has active issues (${active.map((issue) => issue.identifier).join(', ')}); Symphony would work on them too`);
  }
  const board = await loadBoard(context);
  if (roles) for (const status of Object.values(ROLE_STATUS)) statusOption(board, status);

  fs.mkdirSync(runDir, { recursive: true });
  say(`run directory ${path.relative(ROOT, runDir)}`);
  createdIn = runDir;
  const record = roles
    ? await createScenario(context, board, say, { name: 'roles', issues: ROLES_SCENARIO, body: rolesIssueBody })
    : await createScenario(context, board, say);
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
  const recorder = new StatusRecorder(context, record, path.join(runDir, ROLES_FILES.timeline), say);
  const deadline = Date.now() + timeoutMs;
  let lastRunning = '';
  let finished = false;
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
        const inReview = state.running.filter((row) => row.state?.toLowerCase() === ROLE_STATUS.review.toLowerCase()).length;
        trace(`running=${state.counts.running} ids=${ids} review=${inReview}`);
        if (roles && inReview > AGENT_REVIEW_LIMIT) say(`WARNING: ${inReview} agents in "${ROLE_STATUS.review}", limit is ${AGENT_REVIEW_LIMIT}`);
        if (ids !== lastRunning) say(`running ${state.counts.running}/${limit}: ${ids || '–'}`);
        if (state.counts.running > limit) say(`WARNING: ${state.counts.running} agents running, limit is ${limit}`);
        lastRunning = ids;
      }
      if (roles) {
        // Every tick: a short stay in a column must still show up in the timeline.
        try {
          finished = await recorder.poll();
        } catch (error) {
          say(`reading the board failed, retrying: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (tick % REVIEW_EVERY_TICKS === 0) {
        try {
          finished = await reviewer.review();
        } catch (error) {
          reviewLog(`review failed, retrying: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (finished && state?.counts.running === 0) break;
      if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 60_000} minutes`);
      await sleep(roles ? ROLES_TICK_MS : TICK_MS);
    }
  } finally {
    await stopSymphony(symphony);
  }
  say(roles ? 'no test issue active, no agent running; Symphony stopped' : 'all test issues closed, no agent running; Symphony stopped');
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
