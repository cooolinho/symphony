import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { AgentEvent, StartSessionParams } from '../src/agent/types.ts';
import { PricingStore } from '../src/costs/pricing.ts';
import { HistoryLog, repositoryFileName } from '../src/history/history.ts';
import { Logger } from '../src/log.ts';
import { CONTINUATION_DELAY_MS } from '../src/orchestrator/eligibility.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import type { Issue, ToolResult } from '../src/tracker/types.ts';
import { parseWorkflow } from '../src/workflow/loader.ts';
import { ROOT } from '../scripts/e2e/context.ts';
import { COST_CEILING_USD, PIPELINE_SCENARIO, pipelineIssueBody, pipelineWorkflow } from '../scripts/e2e/pipeline.ts';
import type { E2eContext } from '../scripts/e2e/context.ts';
import { verify } from '../scripts/e2e/verify.ts';
import type { TimelineEntry } from '../scripts/e2e/verify-roles.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, callTool, makeIssue, makeWorkflow, tempDir, until } from './helpers.ts';

// Independent acceptance tests of #202 (live e2e scenario for the bugfix pipeline). A live run needs a board and tokens,
// so the run is replayed here: the real orchestrator, worker, transition guard and report_result tool serve the
// *generated* pipeline workflow on an in-memory board, and scripted "agents" do what the issue texts tell the role to do.
// What the replay leaves behind (repository log, status timeline, results, labels) goes through the e2e verification
// (`verify.ts <run-dir>`), exactly as the files of a live run would.

const source = fs.readFileSync(path.join(ROOT, 'WORKFLOW.md'), 'utf8');
const BOARD = ['Backlog', 'Ready', 'Design', 'In progress', 'Testing', 'Agent review', 'Blocked', 'In review', 'Done'];
const REPO = 'acme/app';
const NUMBERS: Record<string, number> = { P1: 21, P2: 22, P3: 23 };

/** The text between the heading of `role` in an issue text and the next heading, or the closing rules. */
function sectionOf(body: string, role: string): string {
  const start = body.indexOf(`## Role \`${role}\``);
  assert.notEqual(start, -1, `the issue text has a section for ${role}`);
  const rest = body.slice(start + 1);
  const next = rest.search(/\n## Role |\nNot allowed:/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** The part of a role section that applies in `round`: sections that branch on the round name "In round 1" and "In any later round". */
function clauseFor(section: string, round: number): string {
  const later = section.indexOf('In any later round');
  const first = section.indexOf('In round 1');
  if (later === -1 || first === -1) return section;
  return round === 1 ? section.slice(first, later) : section.slice(later);
}

const quoted = (text: string, pattern: RegExp): string[] => [...text.matchAll(pattern)].map((match) => match[1] as string);

/** The `report_result` input a careful agent builds from the instructions of its section. */
function inputFrom(clause: string): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const verdict = clause.match(/verdict `(\w+)`/)?.[1];
  const summary = clause.match(/summary `([^`]+)`/)?.[1];
  assert.ok(verdict !== undefined && summary !== undefined, `the instructions name a verdict and a summary: ${clause}`);
  input.verdict = verdict;
  input.summary = summary;
  const type = clause.match(/type `(\w+)`/)?.[1];
  if (type !== undefined) input.type = type;
  const complexity = clause.match(/complexity `(\w+)`/)?.[1];
  if (complexity !== undefined) input.complexity = complexity;
  const criteria = quoted(clause, /acceptance criterion: `([^`]+)`/g);
  if (criteria.length > 0) input.acceptance_criteria = criteria;
  const questions = quoted(clause, /open question: `([^`]+)`/g);
  if (questions.length > 0) input.open_questions = questions;
  const caseMatch = clause.match(/case: criterion `([^`]+)`, test `([^`]+)`, status `(\w+)`/);
  if (caseMatch !== null) input.cases = [{ criterion: caseMatch[1], test: caseMatch[2], status: caseMatch[3] }];
  const finding = clause.match(/finding: severity `(\w+)`, file `([^`]+)`, line (\d+), problem `([^`]+)`, fix `([^`]+)`/);
  if (finding !== null) input.findings = [{ severity: finding[1], file: finding[2], line: Number(finding[3]), problem: finding[4], fix: finding[5] }];
  return input;
}

interface Replay {
  /** What `report_result` answered, per issue number, in order. */
  reports: Array<{ number: number; role: string; round: number; input: Record<string, unknown>; result: ToolResult }>;
  tracker: FakeTracker;
  history: HistoryLog;
  timeline: TimelineEntry[];
  config: ReturnType<typeof makeWorkflow>['config'];
  runner: FakeRunner;
}

interface ReplayOptions {
  /** Changes what the scripted agent of a session reports, for experiments; return null for the instructions of the issue text. */
  decide?: (context: { number: number; role: string; round: number; instructed: Record<string, unknown> }) => Record<string, unknown> | null;
  /** Cost of every session (USD), model it reports. */
  costUsd?: number;
  model?: string;
}

/** Serves the three scenario issues with the generated workflow until nothing is active, running or waiting for a retry. */
async function replay(options: ReplayOptions = {}): Promise<Replay> {
  const workspaceRoot = tempDir('e2e-pipeline-ws-');
  const stateDir = tempDir('e2e-pipeline-state-');
  fs.writeFileSync(path.join(stateDir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
  const history = new HistoryLog(path.join(stateDir, 'repositories'), new PricingStore(path.join(stateDir, 'model-costs.yml'), Logger.silent()), Logger.silent());

  // The generated workflow as the scenario writes it; only what needs a real board, clone or install is replaced.
  const generated = parseWorkflow(pipelineWorkflow(source, ROOT));
  const front = structuredClone(generated.config) as Record<string, any>;
  const tracker = {
    kind: 'github_project',
    provider: { owner: 'acme', project_number: 1, token: 'test-token' },
    active_states: front.tracker.active_states,
    terminal_states: front.tracker.terminal_states,
  };
  // Instead of the shipped clone: a git checkout with one commit, which the test engineer's path rule measures from.
  const hooks = { after_create: ['git init -q', 'git config user.email symphony@example.com', 'git config user.name Symphony', 'git commit -q --allow-empty -m init'].join('\n') };
  Object.assign(front, { tracker, workspace: { root: workspaceRoot }, hooks });
  delete front.server;
  delete front.laravel;
  const workflow = makeWorkflow(front, { prompt: generated.promptTemplate });

  const fake = new FakeTracker(
    PIPELINE_SCENARIO.map((spec) =>
      makeIssue({
        id: String(NUMBERS[spec.key]),
        title: `[E2E run] ${spec.key} – ${spec.title}`,
        description: pipelineIssueBody(spec),
        state: 'Ready',
        labels: ['model: sonnet'],
        native_ref: { status_updated_at: '2026-01-01T00:00:00.000Z' },
      }),
    ),
  );
  fake.statusOptions = async () => BOARD;
  fake.repositoryLabels = new Set(['Model: sonnet']);

  const timeline: TimelineEntry[] = [];
  const stamp = (id: string, status: string) => timeline.push({ at: new Date().toISOString(), number: Number(id), status });
  for (const id of fake.issues.keys()) stamp(id, 'Ready');
  const set = fake.set.bind(fake);
  fake.set = (id, patch) => {
    const before = fake.issues.get(id)?.state;
    set(id, patch);
    if (patch.state !== undefined && patch.state !== before) stamp(id, patch.state);
  };

  const reports: Replay['reports'] = [];
  const model = options.model ?? 'claude-sonnet-5-5';
  const runner: FakeRunner = new FakeRunner(async (turn, params: StartSessionParams) => {
    if (turn === 1) {
      const prompt = runner.sessions.find((session) => session.params === params)?.turns[0] ?? '';
      const role = prompt.match(/You are the \*\*(.+?)\*\*/)?.[1] as string;
      const round = Number(prompt.match(/Round (\d+)\./)?.[1]);
      assert.ok(role !== undefined && Number.isInteger(round), `the prompt names the role and the round: ${prompt.slice(0, 200)}`);
      const number = Number(params.issue.id);
      const instructed = inputFrom(clauseFor(sectionOf(params.issue.description ?? '', role), round));
      const input = options.decide?.({ number, role, round, instructed }) ?? instructed;
      const event: Partial<AgentEvent> = {
        event: 'model_call',
        // model-costs.yml of the replay prices output at 25 USD per million tokens, so the tokens set the cost of a session.
        modelUsage: { [model]: { inputTokens: 0, outputTokens: Math.round(((options.costUsd ?? 0.15) / 25) * 1_000_000), cacheReadTokens: 0, cacheWriteTokens: 0 } },
        costUsd: options.costUsd ?? 0.15,
      };
      params.onEvent({ timestamp: new Date(), pid: 4242, threadId: 'thread-1', turnId: '1', sessionId: null, turnCount: 1, ...event } as AgentEvent);
      const result = await callTool(params, 'report_result', input);
      reports.push({ number, role, round, input, result });
    }
    return { ok: true, turnId: String(turn), resultText: 'done' };
  });

  const timers = new ManualTimers();
  const orchestrator = new Orchestrator({
    workflow: new StaticWorkflow(workflow),
    runner,
    logger: Logger.silent(),
    env: {},
    logDir: null,
    clock: new ManualClock(),
    timers,
    createAdapter: () => fake,
    history,
  });

  const counts = () => orchestrator.snapshot().counts;
  const activeStates = workflow.config.tracker.activeStates.map((state) => state.toLowerCase());
  const waiting = () => [...fake.issues.values()].filter((issue) => activeStates.includes(issue.state.toLowerCase()));
  for (let round = 0; round < 60; round++) {
    await orchestrator.tickNow();
    // Let the sessions of this tick hand off; continuations (the next stage of a hand-off) fire as they are scheduled.
    for (let step = 0; step < 60; step++) {
      await until(() => counts().running === 0, 5_000, 'the running sessions to end');
      if (orchestrator.snapshot().retrying.length === 0) break;
      const sessions = runner.sessions.length;
      timers.fire(CONTINUATION_DELAY_MS);
      await until(() => runner.sessions.length > sessions || counts().running > 0 || orchestrator.snapshot().retrying.length === 0, 5_000, 'the continuation');
    }
    if (counts().running === 0 && orchestrator.snapshot().retrying.length === 0 && waiting().length === 0) break;
  }
  assert.equal(waiting().length, 0, `no issue is left in an active column: ${waiting().map((issue) => `${issue.identifier} ${issue.state}`).join(', ')}`);
  await orchestrator.shutdown(1_000);
  return { reports, tracker: fake, history, timeline, config: workflow.config, runner };
}

/** The files of a finished live run, written from the replay: run.json, the repository log and the timeline. */
function runDirOf(run: Replay, scenario: 'pipeline' | 'roles' = 'pipeline'): string {
  const dir = tempDir('e2e-pipeline-run-');
  fs.mkdirSync(path.join(dir, 'state', 'repositories'), { recursive: true });
  const lines = fs
    .readdirSync(run.history.dir)
    .flatMap((file) => fs.readFileSync(path.join(run.history.dir, file), 'utf8').split('\n'))
    .filter((line) => line !== '');
  fs.writeFileSync(path.join(dir, 'state', 'repositories', repositoryFileName(REPO)), `${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'timeline.jsonl'), run.timeline.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  fs.writeFileSync(
    path.join(dir, 'run.json'),
    JSON.stringify({
      scenario,
      startedAt: '2026-01-01T00:00:00.000Z',
      repository: REPO,
      issues: PIPELINE_SCENARIO.map((spec) => ({
        key: spec.key,
        number: NUMBERS[spec.key],
        issueId: `I_${spec.key}`,
        itemId: String(NUMBERS[spec.key]),
        relationships: [],
        textBlocker: null,
      })),
    }),
  );
  return dir;
}

/** A context whose tracker is the replay's board and whose GitHub has no pull request and no branch. */
function contextOf(run: Replay, github: { pullRequests?: unknown[]; refs?: unknown[] } = {}): E2eContext {
  return {
    workflowPath: path.join(ROOT, 'WORKFLOW.md'),
    envFile: null,
    config: run.config,
    repository: REPO,
    adapter: run.tracker,
    github: { gql: async () => ({ repository: { pullRequests: { nodes: github.pullRequests ?? [] }, refs: { nodes: github.refs ?? [] } } }) },
  } as unknown as E2eContext;
}

async function verifyRun(run: Replay, context = contextOf(run)): Promise<{ ok: boolean; output: string }> {
  const lines: string[] = [];
  const ok = await verify(context, runDirOf(run), (line) => lines.push(line));
  return { ok, output: lines.join('\n') };
}

const issueOf = (run: Replay, key: string): Issue => run.tracker.issues.get(String(NUMBERS[key])) as Issue;

/** `role verdict` of the reports of an issue, in order. */
const reported = (run: Replay, key: string) =>
  run.reports.filter((report) => report.number === NUMBERS[key]).map((report) => `${report.role} ${report.input.verdict}`);

describe('#202 pipeline scenario replayed through the real orchestrator', () => {
  it('serves P1, P2 and P3 along the paths the issue promises, and every report_result of the issue texts is accepted', async () => {
    const run = await replay();
    const refused = run.reports.filter((report) => !report.result.ok);
    assert.deepEqual(refused.map((report) => [report.number, report.role, JSON.stringify(report.result)]), [], 'no report_result was refused');

    assert.deepEqual(reported(run, 'P1'), [
      'issue-analyst ready',
      'developer done',
      'test-engineer failed',
      'developer done',
      'test-engineer passed',
      'reviewer approved',
    ]);
    assert.deepEqual(reported(run, 'P2'), [
      'issue-analyst ready',
      'developer done',
      'test-engineer passed',
      'reviewer changes_needed',
      'developer done',
      'test-engineer passed',
      'reviewer approved',
    ]);
    assert.deepEqual(reported(run, 'P3'), ['issue-analyst needs_info']);

    assert.equal(issueOf(run, 'P1').state, 'In review');
    assert.equal(issueOf(run, 'P2').state, 'In review');
    assert.equal(issueOf(run, 'P3').state, 'Blocked');
  });

  it('moves the issues through exactly the columns of the acceptance criteria', async () => {
    const run = await replay();
    const path = (key: string) => run.timeline.filter((entry) => entry.number === NUMBERS[key]).map((entry) => entry.status);
    assert.deepEqual(path('P1'), ['Ready', 'In progress', 'Testing', 'In progress', 'Testing', 'Agent review', 'In review']);
    assert.deepEqual(path('P2'), ['Ready', 'In progress', 'Testing', 'Agent review', 'In progress', 'Testing', 'Agent review', 'In review']);
    assert.deepEqual(path('P3'), ['Ready', 'Blocked']);
    assert.ok(!run.timeline.some((entry) => entry.status === 'Done'), 'no issue reaches Done');
  });

  it('records the rounds the issue promises: one failed test round in P1, one changes_needed review round in P2', async () => {
    const run = await replay();
    const recorded = async (key: string) =>
      (await run.tracker.readResults(issueOf(run, key))).map(({ result, meta }) => [meta.role, result.kind, result.verdict, meta.round, meta.profile ?? null, meta.target]);
    // The analysis runs before the issue has a type, so it carries no profile; every later stage runs through bugfix.
    assert.deepEqual(await recorded('P1'), [
      ['issue-analyst', 'analysis', 'ready', null, 'default', 'In progress'],
      ['developer', 'implementation', 'done', null, 'bugfix', 'Testing'],
      ['test-engineer', 'test', 'failed', 1, 'bugfix', 'In progress'],
      ['developer', 'implementation', 'done', null, 'bugfix', 'Testing'],
      ['test-engineer', 'test', 'passed', 2, 'bugfix', 'Agent review'],
      ['reviewer', 'review', 'approved', 1, 'bugfix', 'In review'],
    ]);
    assert.deepEqual(await recorded('P2'), [
      ['issue-analyst', 'analysis', 'ready', null, 'default', 'In progress'],
      ['developer', 'implementation', 'done', null, 'bugfix', 'Testing'],
      ['test-engineer', 'test', 'passed', 1, 'bugfix', 'Agent review'],
      ['reviewer', 'review', 'changes_needed', 1, 'bugfix', 'In progress'],
      ['developer', 'implementation', 'done', null, 'bugfix', 'Testing'],
      ['test-engineer', 'test', 'passed', 1, 'bugfix', 'Agent review'],
      ['reviewer', 'review', 'approved', 2, 'bugfix', 'In review'],
    ]);
    const p3 = await recorded('P3');
    assert.deepEqual(p3.map((row) => [row[0], row[1], row[2], row[3], row[5]]), [['issue-analyst', 'analysis', 'needs_info', null, 'Blocked']]);
  });

  it('gives the bug issues their Type label from the analysis and neither a round-limit label nor a needs-human label', async () => {
    const run = await replay();
    for (const key of ['P1', 'P2']) {
      assert.ok(issueOf(run, key).labels.includes('type: bugfix'), `${key} labels: ${issueOf(run, key).labels.join(', ')}`);
      assert.ok(!issueOf(run, key).labels.includes('needs-human'), key);
    }
    assert.ok(!issueOf(run, 'P3').labels.includes('type: bugfix'));
  });

  it('runs every session with sonnet, and the analyst of the blocked issue is its only session', async () => {
    const run = await replay();
    assert.ok(run.runner.sessions.length >= 14);
    for (const session of run.runner.sessions) assert.equal(session.params.config.model, 'sonnet', `${session.params.issue.identifier}`);
    const p3 = run.runner.sessions.filter((session) => session.params.issue.id === String(NUMBERS.P3));
    assert.equal(p3.length, 1, 'P3 has no developer run');
    assert.equal(run.runner.sessions.length, 14, 'P1 six sessions, P2 seven, P3 one');
  });

  it('passes the e2e verification (verify.ts <run-dir>) with the files such a run leaves behind', async () => {
    const run = await replay();
    const { ok, output } = await verifyRun(run);
    assert.deepEqual(
      output.split('\n').filter((line) => line.startsWith('FAIL')),
      [],
      output,
    );
    assert.equal(ok, true, output);
    assert.match(output, /PASS {2}Status path per issue/);
    assert.match(output, /PASS {2}No code changes: pull requests: none, issue branches: none/);
    // The per-role cost table lists the four roles of the pipeline in stage order.
    const roles = output.split('\n').filter((line) => /^(issue-analyst|developer|test-engineer|reviewer) /.test(line));
    assert.deepEqual(roles.map((line) => line.split(/\s+/)[0]), ['issue-analyst', 'developer', 'test-engineer', 'reviewer']);
    assert.match(roles[0] as string, /^issue-analyst\s+3\s+/);
    assert.match(roles[1] as string, /^developer\s+4\s+/);
    assert.match(roles[2] as string, /^test-engineer\s+4\s+/);
    assert.match(roles[3] as string, /^reviewer\s+3\s+/);
    assert.match(output, new RegExp(`ceiling ${COST_CEILING_USD} USD`));
  });

  it('keeps the cost of the three issues below the ceiling and the per-issue cap of the generated workflow', async () => {
    const run = await replay({ costUsd: 0.15 });
    assert.equal(run.config.agent.maxIssueCostUsd, 4);
    assert.equal((await verifyRun(run)).ok, true);
    // 14 sessions at 0.15 USD each would still be below the ceiling; one at 0.5 USD each is not.
    const expensive = await replay({ costUsd: 0.5 });
    const { ok, output } = await verifyRun(expensive);
    assert.equal(ok, false);
    assert.match(output, /FAIL {2}Total cost below 6 USD/);
  });

  it('fails the verification of a replay with a non-sonnet answer, and of one in which P1 never failed a test', async () => {
    const opus = await verifyRun(await replay({ model: 'claude-opus-5-5' }));
    assert.equal(opus.ok, false);
    assert.match(opus.output, /FAIL {2}Every run used sonnet/);

    // A tester that passes right away leaves P1 without its failed test round: the verifier must notice.
    const forgiving = await replay({
      decide: ({ number, role, instructed }) =>
        number === NUMBERS.P1 && role === 'test-engineer'
          ? { verdict: 'passed', summary: 'E2E run P1 test passed', cases: [{ criterion: 'c', test: 't', status: 'passed' }] }
          : instructed,
    });
    const result = await verifyRun(forgiving);
    assert.equal(result.ok, false, result.output);
    assert.match(result.output, /FAIL {2}Status path per issue/);
    assert.match(result.output, /FAIL {2}Stage results per issue/);
  });

  it('fails the verification when the test issues left a pull request or an issue branch behind', async () => {
    const run = await replay();
    const withPr = await verifyRun(run, contextOf(run, { pullRequests: [{ number: 9, createdAt: '2026-12-31T00:00:00Z', headRefName: 'symphony/issue-21' }] }));
    assert.equal(withPr.ok, false);
    assert.match(withPr.output, /FAIL {2}No code changes: pull requests: #9/);
    const withBranch = await verifyRun(run, contextOf(run, { refs: [{ name: 'symphony/issue-22' }] }));
    assert.equal(withBranch.ok, false);
    assert.match(withBranch.output, /FAIL {2}No code changes: .*issue branches: symphony\/issue-22/);
  });
});

describe('#202 sessions of the replay see what the issue texts tell them to look at', () => {
  const promptsOf = (run: Replay, key: string) =>
    run.runner.sessions.filter((session) => session.params.issue.id === String(NUMBERS[key])).map((session) => session.turns[0] as string);
  const roleOf = (prompt: string) => prompt.match(/You are the \*\*(.+?)\*\*/)?.[1];
  const roundOf = (prompt: string) => Number(prompt.match(/Round (\d+)\./)?.[1]);

  it('names the test round in the prompts of the test engineer: 1 for the failing run, 2 after the failed round', async () => {
    const run = await replay();
    const tests = promptsOf(run, 'P1').filter((prompt) => roleOf(prompt) === 'test-engineer');
    assert.deepEqual(tests.map(roundOf), [1, 2]);
    const p2 = promptsOf(run, 'P2').filter((prompt) => roleOf(prompt) === 'test-engineer');
    assert.deepEqual(p2.map(roundOf), [1, 1], 'a rejected review does not make the next test run a later round');
  });

  it('names the review round in the prompts of the reviewer: 1 in P1, 1 then 2 in P2', async () => {
    const run = await replay();
    assert.deepEqual(promptsOf(run, 'P1').filter((prompt) => roleOf(prompt) === 'reviewer').map(roundOf), [1]);
    assert.deepEqual(promptsOf(run, 'P2').filter((prompt) => roleOf(prompt) === 'reviewer').map(roundOf), [1, 2]);
  });

  it('hands the failed test case to the developer of P1, and the finding to the developer of P2, in the second run', async () => {
    const run = await replay();
    const developers = (key: string) => promptsOf(run, key).filter((prompt) => roleOf(prompt) === 'developer');
    assert.equal(developers('P1').length, 2);
    assert.doesNotMatch(developers('P1')[0] as string, /Failed test cases|Open findings/);
    assert.match(developers('P1')[1] as string, /Failed test cases: 1\./);
    assert.equal(developers('P2').length, 2);
    assert.doesNotMatch(developers('P2')[0] as string, /Failed test cases|Open findings/);
    assert.match(developers('P2')[1] as string, /Open findings: 1\./);
  });

  it('puts the issue text of the role into every prompt, and only the tracker tools into every session', async () => {
    const run = await replay();
    for (const session of run.runner.sessions) {
      const prompt = session.turns[0] as string;
      assert.ok(prompt.includes(`## Role \`${roleOf(prompt)}\``), `${session.params.issue.identifier} ${roleOf(prompt)}: the section of the role is in the prompt`);
      assert.deepEqual(session.params.tools.map((tool) => tool.name), ['report_result']);
    }
  });
});
