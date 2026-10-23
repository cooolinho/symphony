import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { StartSessionParams, TurnResult } from '../src/agent/types.ts';
import { Logger } from '../src/log.ts';
import { CONTINUATION_DELAY_MS } from '../src/orchestrator/eligibility.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import type { Issue, ToolResult } from '../src/tracker/types.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { encodeMarker, parseResult } from '../src/workflow/results.ts';
import { roleFor, roleName } from '../src/workflow/roles.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, callTool, makeIssue, makeWorkflow, tempDir, until } from './helpers.ts';

// Independent acceptance tests of the issue analyst stage (#198), derived from the issue: the shipped WORKFLOW.md drives the
// real orchestrator, worker, report_result tool and prompt template on an in-memory board with scripted agent sessions.

const shipped = path.join(import.meta.dirname, '..', 'WORKFLOW.md');
const ISSUE = '7';
const BOARD = ['Backlog', 'Ready', 'Design', 'In progress', 'Testing', 'Documentation', 'Agent review', 'Security review', 'Blocked', 'In review', 'Done'];
const ENV = { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' };

type Script = (params: StartSessionParams, report: (args: Record<string, unknown>) => Promise<ToolResult>) => Promise<void>;

interface Harness {
  orchestrator: Orchestrator;
  tracker: FakeTracker;
  runner: FakeRunner;
  timers: ManualTimers;
  reports: ToolResult[];
  /** The labels of the issue at every status change, with the target column. */
  moves: Array<{ target: string; labels: string[] }>;
}

/** The shipped workflow (no clone hooks, no entry checks) serving one issue in Ready with these labels. */
async function harness(scripts: Script[], labels: string[], options: { addLabelsFails?: boolean; description?: string | null } = {}): Promise<Harness> {
  const { definition } = await loadWorkflowFile(shipped);
  const root = tempDir();
  const front: Record<string, unknown> = {
    ...definition.config,
    workspace: { root },
    hooks: {},
    checks: {},
    tracker: { ...(definition.config.tracker as Record<string, unknown>), kind: 'github_project', provider: { owner: 'acme', project_number: 1, token: 'test-token' } },
  };
  const tracker = new FakeTracker([
    makeIssue({ id: ISSUE, state: 'Ready', labels, description: options.description ?? 'Add an invoice export', native_ref: { provider: 'github_project', repository: 'acme/app', number: 7, parent: null, sub_issues: [], base_branch: null, status_updated_at: '2026-01-01T00:00:00.000Z' } }),
  ]);
  tracker.statusOptions = async () => BOARD;
  const moves: Harness['moves'] = [];
  const setStatus = tracker.setStatus.bind(tracker);
  tracker.setStatus = async (target, column) => {
    moves.push({ target: column, labels: [...(tracker.issues.get(ISSUE)?.labels ?? [])] });
    return setStatus(target, column);
  };
  if (options.addLabelsFails) {
    tracker.addLabels = async () => {
      throw new Error('label API down');
    };
  }
  const reports: ToolResult[] = [];
  const planned = [...scripts];
  const assigned = new Map<StartSessionParams, Script | undefined>();
  const runner = new FakeRunner(async (turn, params): Promise<TurnResult> => {
    if (!assigned.has(params)) assigned.set(params, planned.shift());
    if (turn === 1) {
      await assigned.get(params)?.(params, async (args) => {
        const result = await callTool(params, 'report_result', args);
        reports.push(result);
        return result;
      });
    }
    return { ok: true, turnId: String(turn), resultText: 'done' };
  });
  const timers = new ManualTimers();
  const workflow = new StaticWorkflow(makeWorkflow(front, { prompt: definition.promptTemplate, partials: definition.partials, env: ENV, dir: path.dirname(shipped) }));
  const orchestrator = new Orchestrator({
    workflow,
    runner,
    logger: Logger.silent(),
    env: {},
    logDir: null,
    clock: new ManualClock(),
    timers,
    createAdapter: () => tracker,
  });
  return { orchestrator, tracker, runner, timers, reports, moves };
}

/** Polls the board once, then fires the continuation after every hand-off until the issue rests (released, paused or retrying). */
async function run(h: Harness): Promise<void> {
  await h.orchestrator.tickNow();
  for (;;) {
    await until(() => {
      const { running, retrying, claimed, paused } = h.orchestrator.snapshot().counts;
      return running === 0 && (retrying === 1 || claimed === 0 || paused > 0);
    }, 5_000, 'the pipeline to rest');
    if (h.orchestrator.snapshot().retrying[0]?.kind !== 'continuation') return;
    const sessions = h.runner.sessions.length;
    h.timers.fire(CONTINUATION_DELAY_MS);
    await until(() => h.runner.sessions.length > sessions || h.orchestrator.snapshot().counts.claimed === 0, 5_000, 'the continuation');
  }
}

const analyse = (args: Record<string, unknown>): Script => async (_params, report) => {
  await report(args);
};
const issueOf = (h: Harness): Issue => h.tracker.issues.get(ISSUE)!;
const comments = (h: Harness) => (h.tracker.comments.get(ISSUE) ?? []).map((comment) => comment.body);
const labelsOf = (h: Harness) => issueOf(h).labels.map((label) => label.toLowerCase()).sort();

const READY = {
  verdict: 'ready',
  summary: 'Adds an invoice export to the existing exporter module.',
  type: 'feature',
  complexity: 'L',
  components: ['src/export'],
  acceptance_criteria: ['The export lists every invoice', 'An empty list exports a header only'],
  risks: { breaking_change: true },
  docs_needed: true,
  plan: ['Add the exporter', 'Cover it with tests'],
};

describe('issue analyst stage with the shipped WORKFLOW.md', () => {
  it('shows the human comment that sent the issue back in the analyst prompt (bandenhub#67)', async () => {
    const h = await harness([analyse(READY)], ['feature']);
    const earlier = parseResult('analysis', READY);
    assert.ok(earlier.ok);
    const meta = { role: 'issue-analyst', run: 'old', round: null, profile: null, workflow_hash: null, head_sha: null, checks: null, target: 'Design', created_at: '2026-01-01T00:00:10.000Z' };
    h.tracker.comments.set(ISSUE, [
      { author: 'symphony-bot', createdAt: new Date('2026-01-01T00:00:10.000Z'), body: `### Analysis\n\n${encodeMarker(earlier.result, meta)}`, url: 'u-1' },
      { author: 'symphony-bot', createdAt: new Date('2026-01-01T00:00:20.000Z'), body: 'Symphony merged #5 into develop', url: 'u-2' },
      { author: 'cooolinho', createdAt: new Date('2026-01-01T00:00:30.000Z'), body: 'Behebe folgende Findings: the export drops the header', url: 'u-3' },
    ]);
    await run(h);
    const prompt = h.runner.sessions[0]?.turns[0] ?? '';
    assert.match(prompt, /## Newest human comments[\s\S]*### cooolinho, 2026-01-01T00:00:30\.000Z \(u-3\)\n\nBehebe folgende Findings: the export drops the header/);
    assert.doesNotMatch(prompt, /Symphony merged #5/);
  });

  it('serves Ready with the issue-analyst; the developer serves only In progress', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const config = resolveConfig(definition.config, { workflowPath: shipped, env: ENV, trackerDefaults });
    const named = (state: string) => roleName(roleFor({ state, description: 'Add an invoice export' }, config.roles));
    assert.equal(named('Ready'), 'issue-analyst');
    assert.equal(named('In progress'), 'developer');
    const developer = config.roles?.find((role) => role.name === 'developer');
    assert.deepEqual(developer?.states, ['in progress']);
    const analyst = config.roles?.find((role) => role.name === 'issue-analyst');
    assert.equal(analyst?.readOnly, true);
    assert.equal(analyst?.result, 'analysis');
    assert.deepEqual(analyst?.onResult, { ready: 'next', needs_info: 'Blocked' });
    assert.equal(analyst?.maxTurns, 3);
    assert.equal(analyst?.claude.model, 'sonnet');
    assert.equal(analyst?.modelLabel, 'ignore');
  });

  it('an unlabelled issue gets Type: and Complexity: before it moves on, and the developer receives the analysis', async () => {
    const architect: Script = async (_params, report) => {
      await report({ verdict: 'ready', summary: 'Extend the exporter.', decision: 'Add an InvoiceExporter next to the existing ones.', components: ['src/export/invoice.ts'], interfaces: ['exportInvoices(list): string'] });
    };
    const dev: Script = async (_params, report) => {
      await report({ verdict: 'done', summary: 'Implemented.' });
    };
    const h = await harness([analyse(READY), architect, dev], []);
    await run(h);

    assert.deepEqual(labelsOf(h), ['complexity: l', 'type: feature']);
    // A feature of complexity L is a larger change: the analysis leads to Design, the architect hands it on to In progress.
    assert.equal(h.moves[0]?.target, 'Design');
    assert.equal(h.moves[1]?.target, 'In progress');
    assert.deepEqual([...(h.moves[0]?.labels ?? [])].sort(), ['complexity: l', 'type: feature'], 'both labels exist when the status changes');

    const analyst = h.runner.sessions[0]!;
    assert.match(analyst.turns[0] ?? '', /issue analyst/i);
    assert.equal(analyst.params.policy?.readOnly, true, 'the analyst session is read-only');

    assert.match(h.runner.sessions[1]!.turns[0] ?? '', /Your role: architect/);
    const developer = h.runner.sessions[2]!;
    assert.match(developer.turns[0] ?? '', /Your role: developer/);
    assert.match(developer.turns[0] ?? '', /Analysis of the issue analyst/);
    assert.match(developer.turns[0] ?? '', /Adds an invoice export to the existing exporter module\./);
    assert.match(developer.turns[0] ?? '', /An empty list exports a header only/);
    assert.match(developer.turns[0] ?? '', /src\/export/);
    assert.match(developer.turns[0] ?? '', /Add the exporter/);
    assert.notEqual(developer.params.policy?.readOnly, true);
  });

  it('needs_info moves the issue to Blocked and the open questions are in the comment', async () => {
    const h = await harness(
      [analyse({ verdict: 'needs_info', summary: 'The export format is not specified.', open_questions: ['Which CSV dialect should be used?', 'Do archived invoices belong in the export?'] })],
      [],
    );
    await run(h);

    assert.deepEqual(h.tracker.statusCalls, ['Blocked']);
    assert.equal(issueOf(h).state, 'Blocked');
    const body = comments(h).at(-1) ?? '';
    assert.match(body, /Which CSV dialect should be used\?/);
    assert.match(body, /Do archived invoices belong in the export\?/);
    assert.equal(h.runner.sessions.length, 1, 'no developer session starts for a blocked issue');
  });

  it('needs_info without an open question is refused: nothing is recorded, no label is set and the issue is not moved on', async () => {
    const h = await harness([analyse({ verdict: 'needs_info', summary: 'Unclear.' })], []);
    await run(h);

    assert.equal(h.reports[0]?.ok, false);
    assert.deepEqual(h.tracker.statusCalls.filter((target) => target === 'In progress'), []);
    assert.ok(comments(h).every((body) => !body.includes('symphony:result:v1')), 'no result comment was recorded');
    assert.deepEqual(issueOf(h).labels, []);
  });

  it('an existing human Type: label is not overwritten, a missing Complexity: is still added', async () => {
    const h = await harness([analyse({ ...READY, type: 'feature' }), async () => {}], ['Type: refactor']);
    await run(h);

    const labels = labelsOf(h);
    assert.ok(labels.includes('type: refactor'));
    assert.ok(!labels.includes('type: feature'), `the analysis must not add a second type (${labels.join(', ')})`);
    assert.equal(labels.filter((label) => label.startsWith('type:')).length, 1);
    assert.ok(labels.includes('complexity: l'));
  });

  it('existing human Type: and Complexity: labels are kept untouched', async () => {
    const h = await harness([analyse({ ...READY, type: 'refactor', complexity: 'XL' }), async () => {}], ['Type: bugfix', 'Complexity: S']);
    await run(h);

    assert.deepEqual(issueOf(h).labels, ['Type: bugfix', 'Complexity: S']);
    assert.equal(h.moves[0]?.target, 'In progress');
  });

  it('an existing bug label counts as a type: the analysis adds no Type: label', async () => {
    const h = await harness([analyse({ ...READY, type: 'feature', complexity: 'M' }), async () => {}], ['bug']);
    await run(h);

    const labels = labelsOf(h);
    assert.ok(!labels.includes('type: feature'));
    assert.ok(labels.includes('bug'));
    assert.ok(labels.includes('complexity: m'));
  });

  it('a failing label update does not undo the recorded result or the move', async () => {
    const h = await harness([analyse(READY), async () => {}], [], { addLabelsFails: true });
    await run(h);

    assert.equal(h.tracker.statusCalls[0], 'Design');
    assert.equal(comments(h).length >= 1, true, 'the analysis comment was posted');
    assert.deepEqual(issueOf(h).labels, []);
  });

  it('an analysis without type or complexity moves the issue on and adds no labels', async () => {
    const h = await harness([analyse({ verdict: 'ready', summary: 'Small change.' }), async () => {}], []);
    await run(h);

    // Without a complexity the issue cannot be judged small: it goes through Design.
    assert.equal(h.tracker.statusCalls[0], 'Design');
    assert.deepEqual(issueOf(h).labels, []);
  });
});
