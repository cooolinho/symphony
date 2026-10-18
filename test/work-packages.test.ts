import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { StartSessionParams, TurnResult } from '../src/agent/types.ts';
import { Logger } from '../src/log.ts';
import { CONTINUATION_DELAY_MS, failureBackoffMs, routableWhileRunning } from '../src/orchestrator/eligibility.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { dryRunPlan, planLines } from '../src/service.ts';
import { applyDispatchRules, isHeldBySubIssues, openSubIssuesOf, type LinkedIssue } from '../src/tracker/github-project/normalize.ts';
import type { AgentToolSpec, Issue, ToolResult } from '../src/tracker/types.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { decodeMarker } from '../src/workflow/results.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, callTool, makeIssue, makeWorkflow, tempDir, until } from './helpers.ts';

// Work packages as sub-issues (#211): the shipped WORKFLOW.md drives the real orchestrator, worker, report_result tool
// and prompt template on an in-memory board that treats sub-issues like the GitHub adapter, with scripted sessions.

const shipped = path.join(import.meta.dirname, '..', 'WORKFLOW.md');
const BOARD = ['Backlog', 'Ready', 'Design', 'In progress', 'Testing', 'Agent review', 'Blocked', 'In review', 'Done'];
// Six slots: the analysts of the packages run next to the stages of the parent.
const ENV = { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't', SYMPHONY_MAX_CONCURRENT_AGENTS: '6' };
const PARENT = '7';
const PARENT_ID = 'acme/app#7';

/** `native_ref` of an issue as the GitHub adapter reads it. */
function ref(number: number, parent: LinkedIssue | null = null): Record<string, unknown> {
  return { provider: 'github_project', repository: 'acme/app', number, parent, sub_issues: [], base_branch: null, status_updated_at: '2026-01-01T00:00:00.000Z' };
}

/** The XL feature of the scenarios, in `state`. */
function feature(state = 'Design', complexity = 'XL'): Issue {
  return makeIssue({
    id: PARENT,
    title: 'Invoice export',
    state,
    labels: ['Type: feature', `Complexity: ${complexity}`],
    description: 'Export invoices as CSV and PDF, from the CLI.',
    native_ref: ref(7),
  });
}

/**
 * An in-memory board that treats sub-issues like the GitHub adapter: an issue lists its sub-issues with their live
 * state (`native_ref.sub_issues`), and open sub-issues and open blockers hold it back through the adapter's own
 * `applyDispatchRules` (`respect_sub_issues`, `respect_blockers`). `create_sub_issue` files a sub-issue under the
 * session's issue in the role's column, like the GitHub tool.
 */
class SubIssueBoard extends FakeTracker {
  /** Why a closed issue was closed, by issue id; an issue without an entry is open. */
  readonly closed = new Map<string, string>();
  #next = 8;

  constructor(issues: Issue[]) {
    super(issues);
    this.statusOptions = async () => BOARD;
    this.openSubIssues = (issue) => openSubIssuesOf(issue).map((sub) => sub.identifier);
  }

  heldBySubIssues(issue: Issue): boolean {
    return isHeldBySubIssues(issue);
  }

  /** Closes an issue as a merged pull request (or a human) does: GitHub closes it, the board moves it to Done. */
  close(id: string, reason = 'COMPLETED'): void {
    this.closed.set(id, reason);
    this.set(id, { state: 'Done' });
  }

  /** The sub-issues of the issue `id`, oldest first. */
  subIssues(id: string): Issue[] {
    const identifier = this.issues.get(id)?.identifier;
    return [...this.issues.values()].filter((issue) => (issue.native_ref?.parent as LinkedIssue | null)?.identifier === identifier);
  }

  #view(issue: Issue): Issue {
    const stateOf = (identifier: string | null) => {
      const target = [...this.issues.values()].find((candidate) => candidate.identifier === identifier);
      return target !== undefined && this.closed.has(target.id) ? 'CLOSED' : 'OPEN';
    };
    const view: Issue = {
      ...issue,
      blocked_by: issue.blocked_by.map((blocker) => ({ ...blocker, state: stateOf(blocker.identifier) })),
      native_ref: {
        ...issue.native_ref,
        issue_state: this.closed.has(issue.id) ? 'CLOSED' : 'OPEN',
        sub_issues: this.subIssues(issue.id).map((sub) => ({
          identifier: sub.identifier,
          title: sub.title,
          state: this.closed.has(sub.id) ? 'CLOSED' : 'OPEN',
          state_reason: this.closed.get(sub.id) ?? null,
        })),
      },
    };
    applyDispatchRules(view, { open: !this.closed.has(issue.id), assigned: true }, { assignee: null, respectBlockers: true, respectSubIssues: true });
    return view;
  }

  override async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    return (await super.fetchIssuesByStates(states)).map((issue) => this.#view(issue));
  }

  override async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    return (await super.fetchIssuesByIds(ids)).map((issue) => this.#view(issue));
  }

  override agentToolSpecs(): AgentToolSpec[] {
    const createSubIssue: AgentToolSpec = {
      name: 'create_sub_issue',
      description: 'Create a sub-issue of the session issue.',
      inputSchema: {},
      mutates: true,
      createsSubIssues: true,
      execute: async (args, context): Promise<ToolResult> => {
        const max = context.maxSubIssues;
        if (max === undefined) return { ok: false, error: { category: 'not_allowed', message: 'this role may not create sub-issues' } };
        const parent = this.issues.get(context.issue.id) as Issue;
        const open = this.subIssues(parent.id).filter((sub) => !this.closed.has(sub.id));
        const title = String(args.title);
        const existing = open.find((sub) => sub.title === title);
        if (existing !== undefined) return { ok: true, data: { created: false, number: existing.native_ref?.number, status: existing.state } };
        if (open.length >= max) return { ok: false, error: { category: 'limit_reached', message: `limit ${max}` } };
        const number = this.#next++;
        const blockers = Array.isArray(args.blocked_by) ? args.blocked_by.map(Number) : [];
        const sub = makeIssue({
          id: String(number),
          title,
          description: typeof args.body === 'string' ? args.body : null,
          state: context.subIssueStatus ?? 'Backlog',
          labels: Array.isArray(args.labels) ? args.labels.map((label) => String(label).toLowerCase()) : [],
          blocked_by: blockers.map((blocker) => ({ id: String(blocker), identifier: `acme/app#${blocker}`, state: 'OPEN' })),
          created_at: new Date(Date.UTC(2026, 0, 2, 0, 0, number)),
          native_ref: ref(number, { identifier: parent.identifier, title: parent.title, state: 'OPEN', state_reason: null }),
        });
        this.issues.set(sub.id, sub);
        return { ok: true, data: { created: true, number, identifier: sub.identifier, status: sub.state, remaining: max - open.length - 1 } };
      },
    };
    return [...super.agentToolSpecs(), createSubIssue];
  }
}

interface StageContext {
  turn: number;
  params: StartSessionParams;
  report(args: Record<string, unknown>): Promise<ToolResult>;
}

/** What a session does in its first turn; a returned turn result replaces the normal end of the turn. */
type Script = (context: StageContext) => Promise<TurnResult | void>;

interface Harness {
  orchestrator: Orchestrator;
  tracker: SubIssueBoard;
  runner: FakeRunner;
  timers: ManualTimers;
  clock: ManualClock;
  workflow: StaticWorkflow;
  reports: ToolResult[];
}

/** A turn that works until Symphony stops the session (a package's pipeline that runs on until its issue is closed). */
const working = (turn: number, params: StartSessionParams): Promise<TurnResult> =>
  new Promise((resolve) => {
    const stopped = () => resolve({ ok: false, turnId: String(turn), code: 'turn_cancelled', message: 'cancelled' });
    if (params.signal.aborted) stopped();
    else params.signal.addEventListener('abort', stopped);
  });

/**
 * The shipped workflow (no clone hooks, no entry checks) on a `SubIssueBoard`. The sessions of an issue run its scripts
 * in order; a session without a script works until Symphony stops it.
 */
async function harness(issues: Issue[], scripts: Record<string, Script[]>): Promise<Harness> {
  const { definition } = await loadWorkflowFile(shipped);
  const config: Record<string, unknown> = {
    ...definition.config,
    workspace: { root: tempDir() },
    hooks: {},
    checks: {},
    tracker: { ...(definition.config.tracker as Record<string, unknown>), kind: 'github_project', provider: { owner: 'acme', project_number: 1, token: 'test-token' } },
  };
  const tracker = new SubIssueBoard(issues);
  const reports: ToolResult[] = [];
  const queues = new Map(Object.entries(scripts).map(([id, list]) => [id, [...list]]));
  const assigned = new Map<StartSessionParams, Script | null>();
  const runner = new FakeRunner(async (turn, params): Promise<TurnResult> => {
    if (!assigned.has(params)) assigned.set(params, queues.get(params.issue.id)?.shift() ?? null);
    const script = assigned.get(params) ?? null;
    if (script === null) return working(turn, params);
    if (turn === 1) {
      const report = async (args: Record<string, unknown>) => {
        const result = await callTool(params, 'report_result', args);
        reports.push(result);
        return result;
      };
      const outcome = await script({ turn, params, report });
      if (outcome !== undefined) return outcome;
    }
    return { ok: true, turnId: String(turn), resultText: 'done' };
  });
  const timers = new ManualTimers();
  const clock = new ManualClock();
  const workflow = new StaticWorkflow(makeWorkflow(config, { prompt: definition.promptTemplate, env: ENV, dir: path.dirname(shipped) }));
  const orchestrator = new Orchestrator({ workflow, runner, logger: Logger.silent(), env: {}, logDir: null, clock, timers, createAdapter: () => tracker });
  return { orchestrator, tracker, runner, timers, clock, workflow, reports };
}

const sessionsOf = (h: Harness, id: string) => h.runner.sessions.filter((session) => session.params.issue.id === id);
const roleOf = (session: { turns: string[] } | undefined): string => /## Your role: ([a-z ()-]+)/.exec(session?.turns[0] ?? '')?.[1]?.trim() ?? '';
const stateOf = (h: Harness, id = PARENT): string | undefined => h.tracker.issues.get(id)?.state;
const blockedReason = (h: Harness, id = PARENT) => h.orchestrator.snapshot().blocked.find((row) => row.issue_id === id)?.reason;
const dataOf = (result: ToolResult | undefined): Record<string, unknown> => {
  assert.ok(result?.ok, JSON.stringify(result));
  return result.data as Record<string, unknown>;
};

const PACKAGES = [
  { title: 'Export: CSV writer', body: 'Writes the invoice rows as CSV.\n\nPart of #7', labels: ['Type: feature', 'Complexity: M'] },
  { title: 'Export: PDF writer', body: 'Renders one PDF per invoice.\n\nPart of #7', labels: ['Type: feature', 'Complexity: M'] },
  { title: 'Export: CLI command', body: 'Wires both writers to `export:invoices`.\n\nBlocked by #8, #9\n\nPart of #7', labels: ['Type: feature', 'Complexity: S'], blocked_by: [8, 9] },
];

const SPLIT = {
  verdict: 'split',
  summary: 'Three packages: two writers that run in parallel, then the command that wires them.',
  decision: 'Split along the output formats: each writer stands alone behind the Exporter interface',
  options: ['One developer for everything', 'One package per output format plus the command'],
  components: ['CsvExporter: writes the rows', 'PdfExporter: renders the invoices', 'ExportCommand: picks the exporter'],
  interfaces: ['interface Exporter { export(invoices: Invoice[]): Buffer }'],
  work_packages: ['Export: CSV writer: the CSV rows', 'Export: PDF writer: one PDF per invoice', 'Export: CLI command: wires both writers'],
};

const files = (params: StartSessionParams, packages: typeof PACKAGES) => Promise.all(packages.map((pkg) => callTool(params, 'create_sub_issue', pkg)));

/** Fires the continuation of the issue's last session and waits until it started the next one or released the claim. */
async function continueWith(h: Harness, id = PARENT): Promise<void> {
  await until(() => h.orchestrator.snapshot().retrying.some((retry) => retry.issue_id === id && retry.kind === 'continuation'), 3_000, `continuation of ${id}`);
  const sessions = sessionsOf(h, id).length;
  h.timers.fire(CONTINUATION_DELAY_MS);
  const claimed = () => {
    const snapshot = h.orchestrator.snapshot();
    return [...snapshot.retrying, ...snapshot.running].some((row) => row.issue_id === id);
  };
  await until(() => sessionsOf(h, id).length > sessions || !claimed(), 3_000, `the next stage of ${id}`);
}

describe('work packages as sub-issues (#211)', () => {
  it('splits an XL feature into three sub-issues, waits for all of them, then reviews the integrated base branch', async () => {
    let filed: () => void = () => undefined;
    const subIssuesFiled = new Promise<void>((resolve) => (filed = resolve));
    let proceed: () => void = () => undefined;
    const reconciled = new Promise<void>((resolve) => (proceed = resolve));
    const created: ToolResult[] = [];

    const architect: Script = async ({ params, report }) => {
      for (const pkg of PACKAGES) created.push(await callTool(params, 'create_sub_issue', pkg));
      filed();
      // The sub-issues are open from here on; the test reconciles before the architect reports.
      await reconciled;
      await report(SPLIT);
    };
    const integrationReview: Script = async ({ report }) => {
      await report({
        verdict: 'changes_needed',
        summary: 'The CSV writer and the command are merged; the PDF export is missing because acme/app#9 was closed as not planned.',
        findings: [{ severity: 'major', file: 'src/export/PdfExporter.ts', problem: 'The PDF export of the acceptance criteria is missing (acme/app#9 closed as not planned)', fix: 'Add the PdfExporter behind the Exporter interface' }],
        checked: ['Completeness: finding 1', 'acme/app#8: completed', 'acme/app#9: not planned', 'acme/app#10: completed'],
      });
    };
    const glueFix: Script = async ({ report }) => {
      await report({ verdict: 'done', summary: 'Added the PdfExporter behind the Exporter interface.', changed_files: ['src/export/PdfExporter.ts'] });
    };
    const prReview: Script = async ({ report }) => {
      await report({ verdict: 'approved', summary: 'The PDF export is in and the command picks it.' });
    };
    const h = await harness([feature()], { [PARENT]: [architect, integrationReview, glueFix, prReview] });

    // The architect files the packages in the middle of its turn; a reconciliation then must not stop its session.
    await h.orchestrator.tickNow();
    await subIssuesFiled;
    assert.deepEqual(created.map((result) => [dataOf(result).created, dataOf(result).number, dataOf(result).status]), [[true, 8, 'Ready'], [true, 9, 'Ready'], [true, 10, 'Ready']]);
    await h.orchestrator.tickNow();
    const architectSession = sessionsOf(h, PARENT)[0];
    assert.equal(roleOf(architectSession), 'architect');
    assert.equal(architectSession?.stopped, false, 'reconciliation left the architect running');
    assert.ok(h.orchestrator.snapshot().running.some((row) => row.issue_id === PARENT));
    assert.deepEqual(architectSession?.params.toolContext().maxSubIssues, 5);
    assert.equal(architectSession?.params.toolContext().subIssueStatus, 'Ready');
    proceed();

    // The split is recorded and moves the parent straight to Agent review; the claim is released without a pause.
    await until(() => h.reports.length === 1, 3_000, 'the split');
    assert.deepEqual([dataOf(h.reports[0]).verdict, dataOf(h.reports[0]).target, dataOf(h.reports[0]).status], ['split', 'Agent review', 'Agent review']);
    await continueWith(h);
    assert.equal(sessionsOf(h, PARENT).length, 1);
    assert.equal(h.orchestrator.snapshot().paused.length, 0);
    assert.equal(h.orchestrator.snapshot().retrying.some((retry) => retry.issue_id === PARENT), false);
    assert.deepEqual(h.tracker.statusCalls, ['Agent review']);

    const design = (h.tracker.comments.get(PARENT) ?? []).map((comment) => ({ body: comment.body, marker: decodeMarker(comment.body) })).find((entry) => entry.marker?.result.kind === 'design');
    assert.equal(design?.marker?.result.verdict, 'split');
    assert.equal(design?.marker?.meta.target, 'Agent review');
    assert.match(design?.body ?? '', /### 🧩 Design: split/);
    assert.match(design?.body ?? '', /\*\*Work packages\*\*\n1\. Export: CSV writer: the CSV rows\n2\. Export: PDF writer: one PDF per invoice\n3\. Export: CLI command: wires both writers/);

    // Three sub-issues in Ready, the command blocked by both writers; each package runs its own pipeline.
    const subs = h.tracker.subIssues(PARENT);
    assert.deepEqual(subs.map((sub) => [sub.identifier, sub.title, sub.state]), [
      ['acme/app#8', 'Export: CSV writer', 'Ready'],
      ['acme/app#9', 'Export: PDF writer', 'Ready'],
      ['acme/app#10', 'Export: CLI command', 'Ready'],
    ]);
    assert.deepEqual(subs[2]?.blocked_by.map((blocker) => blocker.identifier), ['acme/app#8', 'acme/app#9']);
    assert.deepEqual(subs[0]?.labels, ['type: feature', 'complexity: m']);
    await h.orchestrator.tickNow();
    await until(() => sessionsOf(h, '8').length === 1 && sessionsOf(h, '9').length === 1, 3_000, 'the analysts of the writers');
    assert.equal(sessionsOf(h, '10').length, 0, 'the command waits for both writers');
    for (const id of ['8', '9']) {
      const session = sessionsOf(h, id)[0];
      assert.equal(roleOf(session), 'issue analyst');
      assert.match(session?.turns[0] ?? '', /- Parent issue: acme\/app#7 \("Invoice export"\)\. This is a sub-issue: keep the change scoped to it\./);
    }
    const workspaces = new Set([PARENT, '8', '9'].map((id) => sessionsOf(h, id)[0]?.params.cwd));
    assert.equal(workspaces.size, 3, 'every package has its own workspace');

    // The parent gets no session while any sub-issue is open: queue, force start and dry run say why.
    const waiting = 'waiting for sub-issues acme/app#8, acme/app#9, acme/app#10';
    assert.equal(blockedReason(h), waiting);
    assert.deepEqual(await h.orchestrator.forceStart(PARENT_ID), { ok: false, reason: 'blocked', message: waiting });
    const config = h.workflow.current.config;
    const board = await h.tracker.fetchIssuesByStates(config.tracker.activeStates);
    const plan = dryRunPlan(board, config, h.tracker, new Map(), h.clock.now());
    const item = plan.find((entry) => entry.issueId === PARENT);
    assert.equal(item?.group, 'blocked');
    assert.deepEqual(planLines(item!, board.find((issue) => issue.id === PARENT)!), [
      '  blocked     acme/app#7  [Agent review]  Invoice export',
      `              ↳ ${waiting}`,
    ]);

    // Closed one by one: no session for the parent before the third one closes.
    h.tracker.close('8');
    await h.orchestrator.tickNow();
    assert.equal(blockedReason(h), 'waiting for sub-issues acme/app#9, acme/app#10');
    h.tracker.close('9', 'NOT_PLANNED');
    await h.orchestrator.tickNow();
    await until(() => sessionsOf(h, '10').length === 1, 3_000, 'the command starts once both writers are closed');
    assert.equal(blockedReason(h), 'waiting for sub-issues acme/app#10');
    assert.equal(sessionsOf(h, PARENT).length, 1);
    h.tracker.close('10');
    await h.orchestrator.tickNow();
    await until(() => sessionsOf(h, PARENT).length === 2, 3_000, 'the integration review');

    // The integration review: the packages with their state, the design's packages, no pull request to diff.
    const integration = sessionsOf(h, PARENT)[1]?.turns[0] ?? '';
    assert.equal(roleOf(sessionsOf(h, PARENT)[1]), 'reviewer (integration review)');
    assert.match(integration, /- acme\/app#8 "Export: CSV writer": closed as completed\n- acme\/app#9 "Export: PDF writer": closed as not planned\n- acme\/app#10 "Export: CLI command": closed as completed/);
    assert.match(integration, /Planned packages:\n1\. Export: CSV writer: the CSV rows/);
    assert.match(integration, /Never approve missing work silently/);
    assert.doesNotMatch(integration, /git diff origin\/<base>\.\.\.HEAD/);
    await until(() => h.reports.length === 2, 3_000, 'the integration review result');
    assert.equal(dataOf(h.reports[1]).target, 'In progress');

    // changes_needed goes to the parent's own developer, whose pull request then gets a normal review.
    await continueWith(h);
    const developer = sessionsOf(h, PARENT)[2]?.turns[0] ?? '';
    assert.equal(roleOf(sessionsOf(h, PARENT)[2]), 'developer');
    assert.match(developer, /An architect split this issue into work packages/);
    assert.match(developer, /1\. \[major\] src\/export\/PdfExporter\.ts — The PDF export of the acceptance criteria is missing/);
    assert.match(developer, /Work on the branch `symphony\/issue-7`/);
    await until(() => h.reports.length === 3, 3_000, 'the implementation');
    await continueWith(h);
    const review = sessionsOf(h, PARENT)[3]?.turns[0] ?? '';
    assert.equal(roleOf(sessionsOf(h, PARENT)[3]), 'reviewer');
    assert.match(review, /git diff origin\/<base>\.\.\.HEAD/);
    assert.doesNotMatch(review, /integration review/);
    await until(() => stateOf(h) === 'In review', 3_000, 'In review');
    assert.deepEqual(h.tracker.statusCalls, ['Agent review', 'In progress', 'Agent review', 'In review']);
    assert.deepEqual(sessionsOf(h, PARENT).map(roleOf), ['architect', 'reviewer (integration review)', 'developer', 'reviewer']);
    await h.orchestrator.shutdown(1_000);
  });

  it('shows the developer and test stages of a split issue as skipped while it waits for its packages', async () => {
    const architect: Script = async ({ params, report }) => {
      await files(params, PACKAGES.slice(0, 2));
      await report({ ...SPLIT, work_packages: SPLIT.work_packages.slice(0, 2) });
    };
    const h = await harness([feature()], { [PARENT]: [architect] });
    await h.orchestrator.tickNow();
    await until(() => h.reports.length === 1, 3_000, 'the split');
    const pipeline = h.orchestrator.issueDetail(PARENT_ID)?.pipeline ?? [];
    const status = (id: string) => pipeline.find((stage) => stage.id === id);
    assert.deepEqual([status('architect')?.status, status('architect')?.verdict], ['done', 'split']);
    assert.equal(status('developer')?.status, 'skipped');
    assert.equal(status('reviewer')?.status, 'active');
    await h.orchestrator.shutdown(1_000);
  });

  it('refuses a split that the issue does not allow, and lets the developer implement the design as before', async () => {
    const ready = { ...SPLIT, verdict: 'ready', work_packages: [] };
    const refusals: ToolResult[] = [];
    const tryToSplit: Script = async ({ params, report }) => {
      refusals.push(await report(SPLIT));
      assert.equal(h.tracker.subIssues(params.issue.id).length, 0);
      await report(ready);
    };
    const h = await harness([feature('Design', 'L')], { [PARENT]: [tryToSplit] });
    await h.orchestrator.tickNow();
    await until(() => stateOf(h) === 'In progress', 3_000, 'In progress');
    assert.equal(refusals[0]?.ok === false && refusals[0].error.category, 'invalid_result');
    assert.match(JSON.stringify(refusals[0]), /verdict \\"split\\" is only for an issue of complexity XL, and this one has complexity L/);
    // An L issue's architect is not told about work packages, and the design hands the issue to the developer.
    const prompt = sessionsOf(h, PARENT)[0]?.turns[0] ?? '';
    assert.doesNotMatch(prompt, /## Work packages \(complexity XL\)/);
    assert.match(prompt, /no work packages and no implementation steps/);
    assert.deepEqual(h.tracker.statusCalls, ['In progress']);
    await h.orchestrator.shutdown(1_000);
  });

  it('does not split a work package again: a sub-issue of complexity XL gets no split', async () => {
    const parent = { identifier: 'acme/app#6', title: 'Billing', state: 'OPEN', state_reason: null };
    const refusals: ToolResult[] = [];
    const tryToSplit: Script = async ({ report }) => {
      refusals.push(await report(SPLIT));
      await report({ ...SPLIT, verdict: 'ready', work_packages: [] });
    };
    const h = await harness([{ ...feature(), native_ref: ref(7, parent) }], { [PARENT]: [tryToSplit] });
    await h.orchestrator.tickNow();
    await until(() => stateOf(h) === 'In progress', 3_000, 'In progress');
    assert.match(JSON.stringify(refusals[0]), /not available for a sub-issue: a work package is not split again/);
    const prompt = sessionsOf(h, PARENT)[0]?.turns[0] ?? '';
    assert.doesNotMatch(prompt, /## Work packages \(complexity XL\)/);
    assert.doesNotMatch(prompt, /`split`/);
    await h.orchestrator.shutdown(1_000);
  });

  it('refuses a split before every work package is a sub-issue, and records it once they are', async () => {
    const outcomes: ToolResult[] = [];
    const architect: Script = async ({ params, report }) => {
      outcomes.push(await report(SPLIT));
      await files(params, PACKAGES.slice(0, 2));
      outcomes.push(await report(SPLIT));
      await files(params, PACKAGES.slice(2));
      outcomes.push(await report(SPLIT));
    };
    const h = await harness([feature()], { [PARENT]: [architect] });
    await h.orchestrator.tickNow();
    await until(() => outcomes.length === 3, 3_000, 'three reports');
    assert.match(JSON.stringify(outcomes[0]), /needs one sub-issue per work package, but acme\/app#7 has 0 sub-issue\(s\) for 3 work packages/);
    assert.match(JSON.stringify(outcomes[1]), /has 2 sub-issue\(s\) for 3 work packages/);
    assert.equal(outcomes[0]?.ok === false && outcomes[0].error.category, 'invalid_result');
    assert.equal(dataOf(outcomes[2]).target, 'Agent review');
    assert.equal((h.tracker.comments.get(PARENT) ?? []).filter((comment) => decodeMarker(comment.body)?.result.kind === 'design').length, 1, 'only the accepted split was posted');
    await h.orchestrator.shutdown(1_000);
  });

  it('resumes an architect that was interrupted after filing the packages once they are closed, without filing them again', async () => {
    const crash: Script = async ({ params, turn }) => {
      await files(params, PACKAGES.slice(0, 2));
      return { ok: false, turnId: String(turn), code: 'turn_failed', message: 'the agent process exited' };
    };
    const resume: Script = async ({ params, report }) => {
      assert.match(params.issue.description ?? '', /Export invoices/);
      await report({ ...SPLIT, work_packages: SPLIT.work_packages.slice(0, 2) });
    };
    const h = await harness([feature()], { [PARENT]: [crash, resume] });
    await h.orchestrator.tickNow();
    await until(() => h.orchestrator.snapshot().retrying.some((retry) => retry.issue_id === PARENT && retry.kind === 'failure'), 3_000, 'the failure retry');

    // The retry finds the parent held by its packages: the claim is released, and the parent stays in Design.
    h.timers.fire(failureBackoffMs(1, h.workflow.current.config.agent.maxRetryBackoffMs));
    await until(() => !h.orchestrator.snapshot().retrying.some((retry) => retry.issue_id === PARENT), 3_000, 'claim released');
    await h.orchestrator.tickNow();
    assert.equal(stateOf(h), 'Design');
    assert.equal(sessionsOf(h, PARENT).length, 1);
    assert.equal(blockedReason(h), 'waiting for sub-issues acme/app#8, acme/app#9');

    h.tracker.close('8');
    h.tracker.close('9');
    await h.orchestrator.tickNow();
    await until(() => h.reports.length === 1, 3_000, 'the resumed split');
    assert.equal(roleOf(sessionsOf(h, PARENT)[1]), 'architect');
    assert.match(sessionsOf(h, PARENT)[1]?.turns[0] ?? '', /- Sub-issues: acme\/app#8 "Export: CSV writer" \(closed\), acme\/app#9 "Export: PDF writer" \(closed\)/);
    assert.equal(h.tracker.subIssues(PARENT).length, 2, 'no package was filed twice');
    assert.equal(dataOf(h.reports[0]).target, 'Agent review');
    // Nothing is open any more: the integration review starts with the next stage.
    await continueWith(h);
    await until(() => sessionsOf(h, PARENT).length === 3, 3_000, 'the integration review');
    assert.equal(roleOf(sessionsOf(h, PARENT)[2]), 'reviewer (integration review)');
    await h.orchestrator.shutdown(1_000);
  });
});

describe('routableWhileRunning: the sub-issue gate for a running session', () => {
  const tracker = { requiredLabels: [] as string[] };
  const held = (value: boolean) => ({ heldBySubIssues: () => value });
  const issue = (overrides: Partial<Issue> = {}) => makeIssue({ id: 'x', dispatchable: false, ...overrides });

  it('keeps a session of a role that creates sub-issues when only its open sub-issues hold the issue back', () => {
    assert.equal(routableWhileRunning(issue(), { maxSubIssues: 5 }, tracker, held(true)), true);
  });

  it('stops every other session as before', () => {
    assert.equal(routableWhileRunning(issue(), { maxSubIssues: null }, tracker, held(true)), false, 'a role without max_sub_issues');
    assert.equal(routableWhileRunning(issue(), null, tracker, held(true)), false, 'the default role');
    assert.equal(routableWhileRunning(issue(), { maxSubIssues: 5 }, tracker, held(false)), false, 'held back by something else too');
    assert.equal(routableWhileRunning(issue(), { maxSubIssues: 5 }, tracker, {}), false, 'a tracker without sub-issues');
    assert.equal(routableWhileRunning(issue(), { maxSubIssues: 5 }, { requiredLabels: ['ai'] }, held(true)), false, 'a required label is missing');
  });

  it('lets a routable issue go on whatever the role', () => {
    assert.equal(routableWhileRunning(issue({ dispatchable: true }), null, tracker, {}), true);
  });
});

describe('before_run of the shipped WORKFLOW.md: a workspace on the base branch follows it', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  /** A remote with `main` (its default branch) and `develop`, a workspace cloned on `branch`, then one more commit on both branches upstream. */
  function setup(branch: string) {
    const dir = tempDir('symphony-git-');
    const origin = path.join(dir, 'origin.git');
    const seed = path.join(dir, 'seed');
    const workspace = path.join(dir, 'workspace');
    git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
    git(dir, 'clone', '--quiet', origin, seed);
    fs.writeFileSync(path.join(seed, 'a.txt'), 'a\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '--quiet', '-m', 'first');
    git(seed, 'push', '--quiet', 'origin', 'HEAD:main', 'HEAD:develop');
    git(dir, 'clone', '--quiet', '--branch', branch, origin, workspace);
    fs.writeFileSync(path.join(seed, 'b.txt'), 'b\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '--quiet', '-m', 'a merged package');
    git(seed, 'push', '--quiet', 'origin', 'HEAD:main', 'HEAD:develop');
    return { workspace, tip: git(seed, 'rev-parse', 'HEAD') };
  }

  async function beforeRun(): Promise<string> {
    const { definition } = await loadWorkflowFile(shipped);
    return String((definition.config.hooks as Record<string, unknown>).before_run);
  }

  const run = async (cwd: string, env: Record<string, string>) =>
    execFileSync('bash', ['-lc', await beforeRun()], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  it('fast-forwards a clean checkout of SYMPHONY_BASE_BRANCH to origin/<base>', async () => {
    const { workspace, tip } = setup('develop');
    await run(workspace, { SYMPHONY_BASE_BRANCH: 'develop' });
    assert.equal(git(workspace, 'rev-parse', 'HEAD'), tip);
  });

  it('follows the default branch when no base branch is configured', async () => {
    const { workspace, tip } = setup('main');
    await run(workspace, { SYMPHONY_BASE_BRANCH: '' });
    assert.equal(git(workspace, 'rev-parse', 'HEAD'), tip);
  });

  it('leaves an issue branch alone', async () => {
    const { workspace, tip } = setup('develop');
    git(workspace, 'checkout', '--quiet', '-b', 'symphony/issue-7');
    const before = git(workspace, 'rev-parse', 'HEAD');
    await run(workspace, { SYMPHONY_BASE_BRANCH: 'develop' });
    assert.equal(git(workspace, 'rev-parse', 'HEAD'), before);
    assert.notEqual(before, tip);
    assert.equal(git(workspace, 'rev-parse', 'origin/develop'), tip, 'the fetch still ran');
  });
});
