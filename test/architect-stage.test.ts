import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { StartSessionParams, TurnResult } from '../src/agent/types.ts';
import { Logger } from '../src/log.ts';
import { CONTINUATION_DELAY_MS } from '../src/orchestrator/eligibility.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { derivePipeline } from '../src/orchestrator/pipeline.ts';
import { skipReason } from '../src/orchestrator/skip.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import type { ToolResult } from '../src/tracker/types.ts';
import { classify } from '../src/workflow/classify.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { profileFor } from '../src/workflow/profile.ts';
import { decodeMarker } from '../src/workflow/results.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, callTool, makeIssue, makeWorkflow, tempDir, until } from './helpers.ts';

// Acceptance tests of the architect stage (#204): the shipped WORKFLOW.md drives the real orchestrator, worker,
// report_result tool and prompt template on an in-memory board with scripted agent sessions.

const shipped = path.join(import.meta.dirname, '..', 'WORKFLOW.md');
const ISSUE = '7';
const IDENTIFIER = 'acme/app#7';
const BOARD = ['Backlog', 'Ready', 'Design', 'In progress', 'Testing', 'Agent review', 'Blocked', 'In review', 'Done'];
const ENV = { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' };

type Script = (params: StartSessionParams, report: (args: Record<string, unknown>) => Promise<ToolResult>) => Promise<void>;

interface Harness {
  orchestrator: Orchestrator;
  tracker: FakeTracker;
  runner: FakeRunner;
  timers: ManualTimers;
  reports: ToolResult[];
}

/** The shipped workflow (no clone hooks, no entry checks) serving one issue in `state` with these labels. */
async function harness(scripts: Script[], labels: string[], state = 'Ready', front: (config: Record<string, unknown>) => Record<string, unknown> = (config) => config): Promise<Harness> {
  const { definition } = await loadWorkflowFile(shipped);
  const root = tempDir();
  const config: Record<string, unknown> = {
    ...definition.config,
    workspace: { root },
    hooks: {},
    checks: {},
    tracker: { ...(definition.config.tracker as Record<string, unknown>), kind: 'github_project', provider: { owner: 'acme', project_number: 1, token: 'test-token' } },
  };
  const tracker = new FakeTracker([
    makeIssue({ id: ISSUE, state, labels, description: 'Add an invoice export', native_ref: { provider: 'github_project', repository: 'acme/app', number: 7, parent: null, sub_issues: [], base_branch: null, status_updated_at: '2026-01-01T00:00:00.000Z' } }),
  ]);
  tracker.statusOptions = async () => BOARD;
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
  const workflow = new StaticWorkflow(makeWorkflow(front(config), { prompt: definition.promptTemplate, env: ENV, dir: path.dirname(shipped) }));
  const orchestrator = new Orchestrator({ workflow, runner, logger: Logger.silent(), env: {}, logDir: null, clock: new ManualClock(), timers, createAdapter: () => tracker });
  return { orchestrator, tracker, runner, timers, reports };
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

const report = (args: Record<string, unknown>): Script => async (_params, send) => {
  await send(args);
};
const stateOf = (h: Harness): string | undefined => h.tracker.issues.get(ISSUE)?.state;
const comments = (h: Harness): string[] => (h.tracker.comments.get(ISSUE) ?? []).map((comment) => comment.body);
const roleOf = (h: Harness, session: number): string => /Your role: ([a-z ]+)/.exec(h.runner.sessions[session]?.turns[0] ?? '')?.[1] ?? '';
const stage = (h: Harness, id: string) => h.orchestrator.issueDetail(IDENTIFIER)?.pipeline.find((candidate) => candidate.id === id);

const ANALYSED = { verdict: 'ready', summary: 'Adds an invoice export.', components: ['src/export'], acceptance_criteria: ['The export lists every invoice'], plan: ['Add the exporter'] };
const DESIGN = {
  verdict: 'ready',
  summary: 'Extend the exporter module.',
  options: ['A new service', 'Extend the exporter'],
  decision: 'Extend the exporter: it already owns the CSV format',
  components: ['InvoiceExporter: writes the CSV rows', 'ExportCommand: wires it to the CLI'],
  interfaces: ['exportInvoices(list: Invoice[]): string'],
  migrations: [],
  compatibility: 'Existing exports are unchanged',
};
const IMPLEMENTED = { verdict: 'done', summary: 'Implemented.' };

describe('architect stage with the shipped WORKFLOW.md', () => {
  it('defines the Design column and a read-only architect role that reports a design', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const roles = (definition.config.roles ?? {}) as Record<string, Record<string, unknown>>;
    const architect = roles.architect;
    assert.deepEqual(architect?.states, ['Design']);
    assert.equal(architect?.read_only, true);
    assert.equal(architect?.result, 'design');
    assert.deepEqual(architect?.on_result, { ready: 'In progress', blocked: 'Blocked' });
    assert.equal(architect?.model_label, 'ignore');
    assert.deepEqual(architect?.may_move_to, ['In progress', 'Blocked']);
    assert.ok(((definition.config.tracker as Record<string, unknown>).active_states as string[]).includes('Design'));
  });

  it('sends a feature of complexity M through Design: an architect session runs and ready moves it to In progress', async () => {
    const h = await harness([report(ANALYSED), report(DESIGN), report(IMPLEMENTED)], ['Type: feature', 'Complexity: M']);
    await run(h);

    assert.deepEqual(h.tracker.statusCalls.slice(0, 2), ['Design', 'In progress']);
    assert.deepEqual([0, 1, 2].map((session) => roleOf(h, session)), ['issue analyst', 'architect', 'developer']);
    const architect = h.runner.sessions[1]!;
    assert.equal(architect.params.policy?.readOnly, true, 'the architect session is read-only');
    assert.doesNotMatch(architect.turns[0] ?? '', /Design of the architect/);
    assert.match(architect.turns[0] ?? '', /Analysis of the issue analyst/, 'the architect works from the analysis');

    const design = comments(h).map((body) => ({ body, marker: decodeMarker(body) })).find((entry) => entry.marker?.result.kind === 'design');
    assert.ok(design, 'the design comment was posted');
    assert.equal(design.marker?.meta.role, 'architect');
    assert.equal(design.marker?.meta.target, 'In progress');
    assert.match(design.body, /Design: ready/);
    assert.match(design.body, /\*\*Decision\*\*\nExtend the exporter: it already owns the CSV format/);
    assert.match(design.body, /\*\*Components\*\*\n- InvoiceExporter: writes the CSV rows\n- ExportCommand: wires it to the CLI/);
    assert.match(design.body, /\*\*Interfaces\*\*\n- exportInvoices/);
  });

  it('gives the developer the design of the architect in its prompt', async () => {
    const h = await harness([report(ANALYSED), report(DESIGN), report(IMPLEMENTED)], ['Type: feature', 'Complexity: L']);
    await run(h);

    const developer = h.runner.sessions[2]?.turns[0] ?? '';
    assert.match(developer, /Your role: developer/);
    assert.match(developer, /## Design of the architect/);
    assert.match(developer, /Decision: Extend the exporter: it already owns the CSV format/);
    assert.match(developer, /- InvoiceExporter: writes the CSV rows/);
    assert.match(developer, /- exportInvoices\(list: Invoice\[\]\): string/);
    assert.match(developer, /Compatibility: Existing exports are unchanged/);
  });

  it('skips Design for a bugfix of complexity S without a session: the analyst hands the issue straight to In progress', async () => {
    const h = await harness([report(ANALYSED), report(IMPLEMENTED)], ['Type: bugfix', 'Complexity: S']);
    await run(h);

    assert.equal(h.tracker.statusCalls[0], 'In progress');
    assert.deepEqual([0, 1].map((session) => roleOf(h, session)), ['issue analyst', 'developer']);
    assert.ok(h.runner.sessions.every((session) => !/Your role: architect/.test(session.turns[0] ?? '')), 'no architect session');
    assert.doesNotMatch(h.runner.sessions[1]?.turns[0] ?? '', /Design of the architect/);
  });

  it('skips Design for a bugfix of complexity M, and runs it for L and XL', async () => {
    const skipped = await harness([report(ANALYSED), report(IMPLEMENTED)], ['bug', 'Complexity: M']);
    await run(skipped);
    assert.equal(skipped.tracker.statusCalls[0], 'In progress');
    for (const complexity of ['L', 'XL']) {
      const h = await harness([report(ANALYSED), report(DESIGN), report(IMPLEMENTED)], ['bug', `Complexity: ${complexity}`]);
      await run(h);
      assert.deepEqual(h.tracker.statusCalls.slice(0, 2), ['Design', 'In progress'], complexity);
      assert.equal(roleOf(h, 1), 'architect', complexity);
    }
  });

  it('routes the analysis by the labels it sets: an unlabelled issue analysed as feature S skips Design, as bugfix L runs it', async () => {
    const small = await harness([report({ ...ANALYSED, type: 'feature', complexity: 'S' }), report(IMPLEMENTED)], []);
    await run(small);
    assert.equal(small.tracker.statusCalls[0], 'In progress');
    assert.equal(roleOf(small, 1), 'developer');

    const large = await harness([report({ ...ANALYSED, type: 'bugfix', complexity: 'L' }), report(DESIGN), report(IMPLEMENTED)], []);
    await run(large);
    assert.deepEqual(large.tracker.statusCalls.slice(0, 2), ['Design', 'In progress']);
  });

  it('runs Design for an issue without a usable Complexity label', async () => {
    for (const labels of [['Type: feature'], ['Type: feature', 'Complexity: huge'], ['Type: feature', 'Complexity: S', 'Complexity: L']]) {
      const h = await harness([report(ANALYSED), report(DESIGN), report(IMPLEMENTED)], labels);
      await run(h);
      assert.deepEqual(h.tracker.statusCalls.slice(0, 2), ['Design', 'In progress'], labels.join());
    }
  });

  it('skips an issue that arrives in Design with complexity S: a skipped result, stage_skipped, no session', async () => {
    const h = await harness([report(IMPLEMENTED)], ['Type: feature', 'Complexity: S'], 'Design');
    await h.orchestrator.tickNow();
    await until(() => stateOf(h) === 'In progress', 3_000, 'move to In progress');
    assert.equal(h.runner.sessions.length, 0, 'no session for the skipped stage');

    const marker = decodeMarker(comments(h)[0] ?? '');
    assert.equal(marker?.result.kind, 'skipped');
    assert.deepEqual([marker?.meta.role, marker?.meta.run, marker?.meta.target, marker?.meta.profile], ['architect', null, 'In progress', 'feature']);
    const skipped = h.orchestrator.issueTimeline(IDENTIFIER)?.events.find((event) => event.event === 'stage_skipped');
    assert.equal(skipped?.detail?.role, 'architect');
    assert.equal(skipped?.detail?.target, 'In progress');

    // The pipeline view shows Design as skipped, and the developer takes over with the next poll.
    assert.equal(stage(h, 'architect')?.status, 'skipped');
    await h.orchestrator.tickNow();
    await until(() => h.runner.sessions.length === 1, 3_000, 'developer session');
    assert.match(h.runner.sessions[0]?.turns[0] ?? '', /Your role: developer/);
    await h.orchestrator.shutdown(1_000);
  });

  it('starts the architect for an issue in Design with complexity M', async () => {
    const h = await harness([report(DESIGN), report(IMPLEMENTED)], ['Type: feature', 'Complexity: M'], 'Design');
    await run(h);
    assert.equal(roleOf(h, 0), 'architect');
    assert.equal(h.tracker.statusCalls[0], 'In progress');
    assert.equal(stage(h, 'architect')?.status === 'skipped', false);
  });

  it('shows Design as skipped in the pipeline view of an issue the profile leaves out, and as pending otherwise', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const config = resolveConfig(definition.config, { workflowPath: shipped, env: ENV, trackerDefaults });
    const status = (labels: string[]): string | undefined =>
      derivePipeline({
        issue: { state: 'Ready', description: null },
        roles: config.roles,
        activeStates: config.tracker.activeStates,
        terminalStates: config.tracker.terminalStates,
        boardColumns: BOARD,
        sessions: [],
        skip: (config.roles ?? []).filter((role) => skipReason({ labels }, role, config) !== null).map((role) => role.name),
        profile: profileFor(config.pipeline, classify(labels).type),
      }).find((candidate) => candidate.id === 'architect')?.status;
    assert.equal(status(['Type: bugfix', 'Complexity: M']), 'skipped');
    assert.equal(status(['Type: feature', 'Complexity: S']), 'skipped');
    assert.equal(status(['Type: feature', 'Complexity: M']), 'pending');
    assert.equal(status(['Type: bugfix', 'Complexity: L']), 'pending');
    assert.equal(status(['Type: bugfix']), 'pending', 'no complexity: the stage runs');
    assert.equal(status([]), 'pending', 'untyped and unlabelled');
  });

  it('moves the issue to Blocked when the architect is blocked, and refuses a ready design without components or interfaces', async () => {
    const blocked = await harness(
      [report(ANALYSED), report({ verdict: 'blocked', summary: 'Two valid approaches.', blockers: [{ description: 'Which storage should hold the exports?', needs: 'human' }] })],
      ['Type: feature', 'Complexity: L'],
    );
    await run(blocked);
    assert.equal(stateOf(blocked), 'Blocked');

    const generic = await harness(
      [report(ANALYSED), async (_params, send) => {
        const result = await send({ verdict: 'ready', summary: 'Do it somehow.' });
        assert.equal(result.ok, false);
        assert.match(JSON.stringify(result), /needs the chosen option in `decision`.*at least one entry in `components`.*at least one entry in `interfaces`/s);
      }],
      ['Type: feature', 'Complexity: L'],
    );
    await run(generic);
    assert.notEqual(stateOf(generic), 'In progress', 'the refused design did not hand the issue to the developer');
    assert.ok(comments(generic).every((body) => decodeMarker(body)?.result.kind !== 'design'));
  });

  it('keeps working with an older WORKFLOW.md that has no Design column: nothing routes to it', async () => {
    const h = await harness(
      [report(ANALYSED), report(IMPLEMENTED)],
      ['Type: feature', 'Complexity: L'],
      'Ready',
      (config) => {
        const { architect: _architect, ...roles } = config.roles as Record<string, Record<string, unknown>>;
        const tracker = config.tracker as Record<string, unknown>;
        const analyst = { ...roles['issue-analyst'], may_move_to: ['In progress', 'Blocked'] };
        return {
          ...config,
          roles: { ...roles, 'issue-analyst': analyst },
          tracker: { ...tracker, active_states: (tracker.active_states as string[]).filter((state) => state !== 'Design') },
          pipeline: { ...(config.pipeline as Record<string, unknown>), profiles: { bugfix: { on_result: { developer: { done: 'Testing' } } } } },
        };
      },
    );
    await run(h);
    assert.equal(h.tracker.statusCalls[0], 'In progress');
    assert.equal(roleOf(h, 1), 'developer');
  });
});
