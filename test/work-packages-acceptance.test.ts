import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { StartSessionParams, TurnResult } from '../src/agent/types.ts';
import { PIPELINE_JS } from '../src/http/pipeline.ts';
import { Logger } from '../src/log.ts';
import { createGuard, guardTools, toolsForRole } from '../src/orchestrator/guard.ts';
import { CONTINUATION_DELAY_MS } from '../src/orchestrator/eligibility.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { derivePipeline, type StageSession } from '../src/orchestrator/pipeline.ts';
import { RESULT_TOOL, createResultTool, type ResultToolParams } from '../src/orchestrator/result-tool.ts';
import { buildStageHistory, resultsTemplateValue, type PersistedResult } from '../src/orchestrator/stage-history.ts';
import { resolveTransition } from '../src/orchestrator/transitions.ts';
import { dryRunPlan, planLines } from '../src/service.ts';
import { applyDispatchRules, isHeldBySubIssues, openSubIssuesOf, type LinkedIssue } from '../src/tracker/github-project/normalize.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import type { AgentToolSpec, Issue, ToolResult } from '../src/tracker/types.ts';
import { classify } from '../src/workflow/classify.ts';
import { resolveConfig, type ServiceConfig } from '../src/workflow/config.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { profileFor } from '../src/workflow/profile.ts';
import { RESULT_VERDICTS, decodeMarker, parseResult, renderResultComment, type ResultMeta } from '../src/workflow/results.ts';
import type { RoleConfig } from '../src/workflow/roles.ts';
import { compilePrompt, EMPTY_RESULTS, issueTemplateValue, renderPrompt } from '../src/workflow/template.ts';
import { nextStageProblems, unknownBoardColumns } from '../src/workflow/validate.ts';
import { WorkspaceManager } from '../src/workspace/manager.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, baseFront, callTool, makeIssue, makeWorkflow, tempDir, until } from './helpers.ts';

/**
 * Acceptance tests for "work packages as sub-issues" (#211), derived from the issue and its refined acceptance
 * criteria, not from the implementation: an XL feature with several work packages is split by the architect into
 * sub-issues, the parent waits for all of them and gets an integration review of the base branch, conflicts go back
 * through `auto_merge.on_conflict`, a normal issue is unchanged. The GitHub adapter cases are in `github-adapter.test.ts`.
 */

const root = path.join(import.meta.dirname, '..');
const shippedPath = path.join(root, 'WORKFLOW.md');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

const BOARD = ['Backlog', 'Ready', 'Design', 'In progress', 'Testing', 'Documentation', 'Agent review', 'Security review', 'Blocked', 'In review', 'Done'];
const ENV = { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' };

async function shipped(extraEnv: NodeJS.ProcessEnv = {}) {
  const { definition } = await loadWorkflowFile(shippedPath);
  const config = resolveConfig(definition.config, { workflowPath: shippedPath, env: { ...ENV, ...extraEnv }, trackerDefaults });
  return { definition, config };
}

function roleNamed(config: ServiceConfig, name: string): RoleConfig {
  const role = config.roles?.find((candidate) => candidate.name === name);
  assert.ok(role, `role ${name}`);
  return role;
}

describe('WORKFLOW.md with the work-package settings (preflight and routing)', () => {
  it('gives the architect room for three packages, files them in Ready and keeps the hand-off free of an entry check', async () => {
    const { config } = await shipped();
    const architect = roleNamed(config, 'architect');
    assert.ok((architect.maxSubIssues ?? 0) >= 3, 'max_sub_issues covers the three packages of the acceptance criteria');
    assert.equal(architect.maxSubIssues, 5);
    assert.equal(architect.subIssueStatus, 'Ready');
    assert.equal(architect.runChecks, false, 'nothing changes in the architect workspace, so no entry check before Agent review');
    assert.equal(architect.readOnly, true);
    assert.equal(architect.result, 'design');
    assert.equal(architect.onResult.split, 'Agent review');
    assert.equal(architect.onResult.ready, 'In progress');
    assert.ok(architect.mayMoveTo?.includes('Agent review'), 'the role may move the issue to the target of split');
    assert.ok(config.tracker.activeStates.includes('Ready'), 'sub_issue_status is an existing, active column');
    const xl = makeIssue({ id: '7', labels: ['Type: feature', 'Complexity: XL'], native_ref: { parent: null, sub_issues: [] } });
    const guarded = toolsForRole([{ name: 'create_sub_issue', description: '', inputSchema: {}, mutates: true, createsSubIssues: true, execute: async () => ({ ok: true, data: {} }) }], architect, xl);
    assert.deepEqual(guarded.map((tool) => tool.name), ['create_sub_issue'], 'max_sub_issues grants the tool on an issue it may split');
  });

  it('takes the limit from SYMPHONY_ARCHITECT_MAX_SUB_ISSUES', async () => {
    assert.equal(roleNamed((await shipped({ SYMPHONY_ARCHITECT_MAX_SUB_ISSUES: '8' })).config, 'architect').maxSubIssues, 8);
  });

  it('only the architect and the roles that already filed sub-issues create them; the reviewer and the developer do not', async () => {
    const { config } = await shipped();
    for (const name of ['issue-analyst', 'developer', 'test-engineer', 'reviewer']) assert.equal(roleNamed(config, name).maxSubIssues, null, name);
  });

  it('passes the board preflight: every column it names exists, and `next` still resolves', async () => {
    const { config } = await shipped();
    assert.deepEqual(unknownBoardColumns(config, BOARD), []);
    assert.deepEqual(nextStageProblems(config, BOARD), []);
    assert.deepEqual(
      unknownBoardColumns(config, BOARD.filter((column) => column !== 'Agent review')).filter((problem) => problem.includes('Agent review')).length > 0,
      true,
      'a board without the split target is reported',
    );
  });

  it('routes a split to the integration review in every profile, and the review verdicts like any review', async () => {
    const { config } = await shipped();
    const history = { reviewRounds: 0, testRounds: 0 };
    for (const type of ['feature', 'bugfix', 'refactor', null] as const) {
      const profile = profileFor(config.pipeline, type);
      const route = (role: string, verdict: string) => {
        const outcome = resolveTransition({ role: roleNamed(config, role), verdict, history, profile, config, boardColumns: BOARD });
        assert.ok(outcome.ok, `${type}: ${role} ${verdict}`);
        return outcome.target;
      };
      assert.equal(route('architect', 'split'), 'Agent review', `${type}: past the developer and the test engineer`);
      assert.equal(route('architect', 'ready'), 'In progress', `${type}: a ready design still goes to the developer`);
      assert.equal(route('architect', 'blocked'), 'Blocked', type ?? 'untyped');
      assert.equal(route('reviewer', 'approved'), 'In review', type ?? 'untyped');
      assert.equal(route('reviewer', 'changes_needed'), 'In progress', `${type}: the integration review hands the findings to the issue's developer`);
      assert.equal(route('reviewer', 'blocked'), 'Blocked', type ?? 'untyped');
    }
  });

  it('keeps a split out of reach of the other result kinds and of a role without sub-issues', async () => {
    assert.ok(RESULT_VERDICTS.design.includes('split'));
    for (const [kind, verdicts] of Object.entries(RESULT_VERDICTS)) if (kind !== 'design') assert.ok(!(verdicts as readonly string[]).includes('split'), kind);
    const { definition } = await loadWorkflowFile(shippedPath);
    const roles = structuredClone(definition.config.roles) as Record<string, Record<string, unknown>>;
    delete roles.architect?.max_sub_issues;
    assert.throws(
      () => resolveConfig({ ...definition.config, roles }, { workflowPath: shippedPath, env: ENV, trackerDefaults }),
      /roles\.architect\.on_result\.split needs roles\.architect\.max_sub_issues/,
    );
  });
});

describe('the stage history for the integration review', () => {
  let clock = 0;
  const persisted = (kind: 'design' | 'implementation' | 'reset' | 'review', input: Record<string, unknown>, meta: Partial<ResultMeta> = {}): PersistedResult => {
    clock += 1;
    const role = kind === 'design' ? 'architect' : kind === 'implementation' ? 'developer' : 'reviewer';
    const parsed = kind === 'reset' ? null : parseResult(kind, input);
    if (parsed !== null) assert.ok(parsed.ok, JSON.stringify(parsed));
    const result = parsed !== null && parsed.ok ? parsed.result : (input as never);
    return {
      result,
      meta: { role, run: `run-${clock}`, round: null, profile: null, workflow_hash: null, head_sha: null, checks: null, target: null, created_at: new Date(Date.UTC(2026, 9, 18, 9, 0, clock)).toISOString(), ...meta },
    };
  };
  const SPLIT = { verdict: 'split', summary: 'Two packages.', decision: 'Split by format', components: ['CsvWriter'], interfaces: ['Writer'], work_packages: ['CSV writer: rows', 'PDF writer: pages'] };
  const DONE = { verdict: 'done', summary: 'Glue fixed.' };

  it('hands the packages and the commit of the split design to the reviewer', () => {
    const value = resultsTemplateValue(buildStageHistory([persisted('design', SPLIT, { head_sha: 'a1b2c3d4e5f6a7b8' })]));
    assert.equal(value.design?.verdict, 'split');
    assert.deepEqual(value.design?.work_packages, ['CSV writer: rows', 'PDF writer: pages']);
    assert.equal(value.design?.head_sha, 'a1b2c3d4e5f6a7b8');
    assert.equal(value.implementation, null, 'no implementation of its own: the review is an integration review');
  });

  it('knows an implementation of the issue itself, whatever its verdict, so a later glue pull request is reviewed as one', () => {
    const history = (...entries: PersistedResult[]) => resultsTemplateValue(buildStageHistory(entries)).implementation;
    assert.equal(history(persisted('design', SPLIT)), null);
    assert.equal(history(persisted('design', SPLIT), persisted('implementation', DONE, { head_sha: 'cafe' }))?.verdict, 'done');
    assert.equal(history(persisted('design', SPLIT), persisted('implementation', { verdict: 'blocked', summary: 'x', blockers: [{ description: 'no token', needs: 'access' }] }))?.verdict, 'blocked');
    assert.equal(history(persisted('implementation', DONE, { head_sha: 'first' }), persisted('implementation', DONE, { head_sha: 'second' }))?.head_sha, 'second', 'the newest one');
  });

  it('keeps the implementation across a reset: a reset starts the rounds again, it does not undo a pull request', () => {
    const value = resultsTemplateValue(buildStageHistory([persisted('implementation', DONE), persisted('reset', { schema: 'symphony.result/v1', kind: 'reset', verdict: 'reset', summary: 'reset', blockers: [], follow_ups: [] })]));
    assert.equal(value.implementation?.verdict, 'done');
  });

  it('forgets the design at a reset, so the integration review does not list stale packages', () => {
    const value = resultsTemplateValue(buildStageHistory([persisted('design', SPLIT), persisted('reset', { schema: 'symphony.result/v1', kind: 'reset', verdict: 'reset', summary: 'reset', blockers: [], follow_ups: [] })]));
    assert.equal(value.design, null);
  });
});

describe('the result comment and the dashboard know the split verdict', () => {
  const split = {
    verdict: 'split',
    summary: 'Three packages.',
    decision: 'Split by format',
    components: ['CsvWriter'],
    interfaces: ['Writer'],
    work_packages: ['CSV writer: rows', 'PDF writer: pages', 'CLI: wires both'],
  };

  it('renders the packages in order and survives the marker round trip without the issue context', () => {
    const parsed = parseResult('design', split);
    assert.ok(parsed.ok);
    const meta: ResultMeta = { role: 'architect', run: 'r1', round: null, profile: 'feature', workflow_hash: null, head_sha: 'abc', checks: null, target: 'Agent review', created_at: '2026-10-18T10:00:00.000Z' };
    const comment = renderResultComment(parsed.result, meta);
    assert.match(comment, /Design: split/);
    assert.match(comment, /1\. CSV writer: rows\n2\. PDF writer: pages\n3\. CLI: wires both/);
    const decoded = decodeMarker(comment);
    assert.equal(decoded?.result.kind, 'design');
    assert.equal(decoded?.result.verdict, 'split');
    assert.equal(decoded?.meta.target, 'Agent review');
  });

  it('gives every verdict of every result kind a tone in the pipeline view (a missing one would fall back to muted)', () => {
    const tones = /const PIPE_VERDICT_TONE = \{([\s\S]*?)\};/.exec(PIPELINE_JS)?.[1] ?? '';
    const known = new Set([...tones.matchAll(/\b([a-z_]+):\s*'(?:good|warn|bad|muted)'/g)].map((match) => match[1]));
    const missing = Object.values(RESULT_VERDICTS)
      .flat()
      .filter((verdict) => !known.has(verdict));
    assert.deepEqual([...new Set(missing)], []);
  });
});

describe('the pipeline view of a split issue', () => {
  async function stages(state: string, results: PersistedResult[], sessions: StageSession[]) {
    const { config } = await shipped();
    return derivePipeline({
      issue: { state, description: null },
      roles: config.roles,
      activeStates: config.tracker.activeStates,
      terminalStates: config.tracker.terminalStates,
      boardColumns: BOARD,
      sessions,
      skip: [],
      results,
      profile: profileFor(config.pipeline, 'feature'),
    });
  }
  const session = (role: string, state: string, run: string): StageSession => ({ run, attempt: null, role, state, model: null, effort: null, started_at: '2026-10-18T09:00:00.000Z', finished_at: '2026-10-18T09:05:00.000Z', outcome: 'handed_off' });
  const result = (kind: 'design' | 'implementation' | 'test' | 'review', role: string, input: Record<string, unknown>, target: string, run: string, second: number): PersistedResult => {
    const parsed = parseResult(kind, input);
    assert.ok(parsed.ok, JSON.stringify(parsed));
    return { result: parsed.result, meta: { role, run, round: null, profile: null, workflow_hash: null, head_sha: null, checks: null, target, created_at: new Date(Date.UTC(2026, 9, 18, 9, 0, second)).toISOString() } };
  };
  const status = (all: Awaited<ReturnType<typeof stages>>, id: string) => all.find((stage) => stage.id === id)?.status;
  const SPLIT = { verdict: 'split', summary: 's', decision: 'd', components: ['c'], interfaces: ['i'], work_packages: ['A', 'B'] };

  it('shows the developer and the test engineer as skipped while the issue waits in Agent review', async () => {
    const all = await stages('Agent review', [result('design', 'architect', SPLIT, 'Agent review', 'r1', 1)], [session('issue-analyst', 'Ready', 'r0'), session('architect', 'Design', 'r1')]);
    assert.deepEqual([status(all, 'issue-analyst'), status(all, 'architect'), status(all, 'developer'), status(all, 'test-engineer'), status(all, 'reviewer')], ['done', 'done', 'skipped', 'skipped', 'active']);
  });

  it('does not mark a stage skipped that really ran (the glue fix after a changes_needed integration review)', async () => {
    const all = await stages(
      'Agent review',
      [
        result('design', 'architect', SPLIT, 'Agent review', 'r1', 1),
        result('implementation', 'developer', { verdict: 'done', summary: 'glue' }, 'Testing', 'r3', 3),
        result('test', 'test-engineer', { verdict: 'passed', summary: 'ok', cases: [{ criterion: 'c', test: 't', status: 'passed' }] }, 'Agent review', 'r4', 4),
      ],
      [session('architect', 'Design', 'r1'), session('reviewer', 'Agent review', 'r2'), session('developer', 'In progress', 'r3'), session('test-engineer', 'Testing', 'r4')],
    );
    assert.equal(status(all, 'developer'), 'done');
    assert.equal(status(all, 'test-engineer'), 'done');
  });

  it('shows Testing as pending again once the integration review sent the issue back to its developer', async () => {
    const changes = { verdict: 'changes_needed', summary: 'PDF missing', findings: [{ severity: 'major', file: 'src/Pdf.ts', problem: 'missing', fix: 'add it' }] };
    const results = [result('design', 'architect', SPLIT, 'Agent review', 'r1', 1), result('review', 'reviewer', changes, 'In progress', 'r2', 2)];
    const running = { ...session('developer', 'In progress', 'r3'), finished_at: null, outcome: null };
    const all = await stages('In progress', results, [session('architect', 'Design', 'r1'), session('reviewer', 'Agent review', 'r2'), running]);
    assert.deepEqual([status(all, 'developer'), status(all, 'test-engineer')], ['active', 'pending']);
    // Also when the developer hands the issue to Blocked: Testing still lies ahead.
    const blocked = await stages('Blocked', results, [session('architect', 'Design', 'r1'), session('reviewer', 'Agent review', 'r2'), session('developer', 'In progress', 'r3')]);
    assert.equal(status(blocked, 'test-engineer'), 'pending');
  });

  it('leaves the stages of an ordinary feature as they were: the design goes on to the developer, nothing is skipped', async () => {
    const ready = { ...SPLIT, verdict: 'ready', work_packages: [] };
    const all = await stages('In progress', [result('design', 'architect', ready, 'In progress', 'r1', 1)], [session('issue-analyst', 'Ready', 'r0'), session('architect', 'Design', 'r1')]);
    assert.deepEqual(all.filter((stage) => stage.status === 'skipped').map((stage) => stage.id), []);
    assert.equal(status(all, 'developer'), 'active');
  });

  it('does not skip anything when an agent hands the issue to Blocked', async () => {
    const blocked = { verdict: 'blocked', summary: 'which database?', blockers: [{ description: 'which database?', needs: 'human' }], components: [], interfaces: [] };
    const all = await stages('Blocked', [result('design', 'architect', blocked, 'Blocked', 'r1', 1)], [session('issue-analyst', 'Ready', 'r0'), session('architect', 'Design', 'r1')]);
    assert.deepEqual(all.filter((stage) => stage.status === 'skipped').map((stage) => stage.id), []);
  });
});

describe('the split verdict through report_result (refusals leave the issue untouched)', () => {
  const PACKAGES = ['Export: CSV writer: rows', 'Export: PDF writer: pages', 'Export: CLI command: wires both'];
  const SPLIT = {
    verdict: 'split',
    summary: 'Three packages.',
    decision: 'Split along the output formats',
    components: ['CsvExporter', 'PdfExporter', 'ExportCommand'],
    interfaces: ['interface Exporter { export(rows): Buffer }'],
    work_packages: PACKAGES,
  };
  const READY = { ...SPLIT, verdict: 'ready' };

  function subIssues(count: number): LinkedIssue[] {
    return Array.from({ length: count }, (_, i) => ({ identifier: `acme/app#${8 + i}`, title: PACKAGES[i] ?? `P${i}`, state: 'OPEN', state_reason: null }));
  }

  function setup(options: { labels?: string[]; parent?: boolean; subs?: number; maxSubIssues?: number | null } = {}) {
    const dir = tempDir('symphony-split-');
    const maxSubIssues = options.maxSubIssues === undefined ? 5 : options.maxSubIssues;
    const front = baseFront(dir, {
      tracker: {
        kind: 'github_project',
        provider: { owner: 'acme', project_number: 1, token: 'test-token' },
        active_states: ['Design', 'In progress', 'Agent review'],
      },
      roles: {
        architect: {
          states: ['Design'],
          read_only: true,
          result: 'design',
          run_checks: false,
          ...(maxSubIssues !== null ? { max_sub_issues: maxSubIssues, sub_issue_status: 'Ready' } : {}),
          may_move_to: ['In progress', 'Agent review', 'Blocked'],
          on_result: { ready: 'In progress', ...(maxSubIssues !== null ? { split: 'Agent review' } : {}), blocked: 'Blocked' },
        },
        developer: { states: ['In progress'], result: 'implementation', may_move_to: ['Agent review', 'Blocked'], on_result: { done: 'Agent review' } },
        reviewer: { states: ['Agent review'], read_only: true, result: 'review', may_move_to: ['In review', 'In progress', 'Blocked'], on_result: { approved: 'In review', changes_needed: 'In progress' } },
      },
    });
    const config = makeWorkflow(front).config;
    const workspacePath = path.join(dir, 'ws');
    fs.mkdirSync(workspacePath);
    const manager = new WorkspaceManager({ root: dir, hooks: config.hooks, workflowDir: dir }, { PATH: process.env.PATH }, Logger.silent());
    const role = roleNamed(config, 'architect');
    const tracker = new FakeTracker([
      makeIssue({
        id: '7',
        identifier: 'acme/app#7',
        state: 'Design',
        labels: options.labels ?? ['Type: feature', 'Complexity: XL'],
        native_ref: {
          provider: 'github_project',
          repository: 'acme/app',
          number: 7,
          parent: options.parent === true ? { identifier: 'acme/app#6', title: 'Billing', state: 'OPEN', state_reason: null } : null,
          sub_issues: subIssues(options.subs ?? 3),
          base_branch: null,
        },
      }),
    ]);
    const current = (): Issue => tracker.issues.get('7') as Issue;
    const guard = createGuard({ role, config, workspace: { path: workspacePath, key: 'ws', createdNow: false }, issue: () => ({ id: '7', identifier: 'acme/app#7' }), manager, signal: new AbortController().signal, onEvent: () => undefined });
    const params: ResultToolParams = {
      role,
      history: { reviewRounds: 0, testRounds: 0 },
      profile: null,
      flags: {},
      config,
      boardColumns: null,
      adapter: tracker,
      issue: current,
      runId: 'run-1',
      meta: { workflowHash: 'f'.repeat(64), headSha: async () => 'abc123def456abc1', now: () => new Date('2026-10-18T12:00:00Z') },
    };
    const tool = guardTools(toolsForRole(tracker.agentToolSpecs(), role, current(), createResultTool(params)), guard).find((spec) => spec.name === RESULT_TOOL);
    assert.ok(tool);
    const report = (args: Record<string, unknown>) => tool.execute(args, { issue: current() });
    const untouched = () => {
      assert.deepEqual(tracker.statusCalls, [], 'the issue did not move');
      assert.deepEqual((tracker.comments.get('7') ?? []).filter((comment) => decodeMarker(comment.body) !== null), [], 'no result comment');
    };
    return { report, tracker, untouched };
  }

  const refusal = (result: ToolResult): string => {
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.ok === false && result.error.category, 'invalid_result');
    return result.ok === false ? result.error.message : '';
  };
  const target = (result: ToolResult): unknown => {
    assert.ok(result.ok, JSON.stringify(result));
    return (result.data as Record<string, unknown>).target;
  };

  it('splits an XL issue with three packages that each have a sub-issue, to Agent review', async () => {
    const { report, tracker } = setup();
    assert.equal(target(await report(SPLIT)), 'Agent review');
    assert.deepEqual(tracker.statusCalls, ['Agent review']);
  });

  it('reads the complexity from the label whatever its case', async () => {
    for (const labels of [['complexity: xl'], ['Complexity: XL'], ['COMPLEXITY:XL', 'Type: bug']]) {
      assert.equal(target(await setup({ labels }).report(SPLIT)), 'Agent review', labels.join());
    }
  });

  it('refuses a split below XL, without a usable complexity label and for conflicting labels, and the issue stays put', async () => {
    for (const labels of [['Complexity: L'], ['Complexity: M'], ['Complexity: S'], [], ['Type: feature'], ['Complexity: XL', 'Complexity: M'], ['Complexity: huge']]) {
      const { report, untouched } = setup({ labels });
      assert.match(refusal(await report(SPLIT)), /only for an issue of complexity XL/, labels.join() || 'no labels');
      untouched();
    }
  });

  it('refuses a split of a sub-issue: a work package is not split again', async () => {
    const { report, untouched } = setup({ parent: true });
    assert.match(refusal(await report(SPLIT)), /not available for a sub-issue/);
    untouched();
  });

  it('refuses fewer than two packages, even with sub-issues', async () => {
    for (const work_packages of [[], ['Only one']]) {
      const { report, untouched } = setup({ subs: 3 });
      assert.match(refusal(await report({ ...SPLIT, work_packages })), /at least two entries in `work_packages`/);
      untouched();
    }
  });

  it('refuses a split while a package has no sub-issue (nothing would wait for it), and accepts it once the architect filed it', async () => {
    const { report, untouched, tracker } = setup({ subs: 2 });
    assert.match(refusal(await report(SPLIT)), /has 2 sub-issue\(s\) for 3 work packages/);
    untouched();
    tracker.set('7', { native_ref: { ...tracker.issues.get('7')?.native_ref, sub_issues: subIssues(3) } });
    assert.equal(target(await report(SPLIT)), 'Agent review');
  });

  it('refuses more packages than max_sub_issues allows, and a role without the setting', async () => {
    assert.match(refusal(await setup({ maxSubIssues: 2 }).report(SPLIT)), /at most 2 sub-issues/);
    assert.match(refusal(await setup({ maxSubIssues: null }).report(SPLIT)), /needs a role that creates sub-issues/);
  });

  it('keeps the flow as before when the design is ready: the developer implements, packages or not', async () => {
    for (const labels of [['Complexity: XL'], ['Complexity: L'], ['Complexity: S'], []]) {
      assert.equal(target(await setup({ labels, subs: 0 }).report(READY)), 'In progress', labels.join() || 'no labels');
    }
    assert.equal(target(await setup({ subs: 0 }).report({ ...READY, work_packages: PACKAGES })), 'In progress', 'ready with packages listed is still a ready design');
    assert.equal(target(await setup({ parent: true, subs: 0 }).report(READY)), 'In progress', 'a sub-issue designs for its developer');
  });

  it('lets the agent fix a refused split in the same session', async () => {
    const { report, tracker } = setup({ labels: ['Complexity: L'] });
    refusal(await report(SPLIT));
    assert.equal(target(await report(READY)), 'In progress');
    assert.deepEqual(tracker.statusCalls, ['In progress']);
  });
});

describe('the classification used by the split rules', () => {
  it('reads Complexity: XL case-insensitively and ignores conflicting labels', () => {
    assert.equal(classify(['complexity: xl']).complexity, 'XL');
    assert.equal(classify(['Complexity: XL', 'Complexity: L']).complexity, null);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Prompts (shipped WORKFLOW.md): the architect offers the split only where it applies, the reviewer switches modes.
// ---------------------------------------------------------------------------------------------------------------------

interface PromptOptions {
  role: string;
  number?: number;
  labels?: string[];
  parent?: LinkedIssue | null;
  subIssues?: LinkedIssue[];
  base?: string | null;
  results?: Record<string, unknown>;
}

async function prompt(options: PromptOptions): Promise<string> {
  const { definition } = await loadWorkflowFile(shippedPath);
  const number = options.number ?? 7;
  const issue = makeIssue({
    id: String(number),
    identifier: `acme/app#${number}`,
    title: 'Invoice export',
    description: 'Export invoices as CSV and PDF.',
    state: 'Agent review',
    labels: options.labels ?? ['Type: feature', 'Complexity: XL'],
    native_ref: { provider: 'github_project', repository: 'acme/app', number, parent: options.parent ?? null, sub_issues: options.subIssues ?? [], base_branch: options.base ?? null },
  });
  const template = compilePrompt(definition.promptTemplate);
  assert.equal(template.parseError, null);
  return renderPrompt(template, {
    issue: issueTemplateValue(issue, new Map()),
    attempt: null,
    role: options.role,
    agents: [],
    result_required: true,
    round: 1,
    test_paths: ['tests/**'],
    results: { ...EMPTY_RESULTS, ...options.results },
  });
}

const sub = (number: number, title: string, state: 'OPEN' | 'CLOSED', reason: string | null): LinkedIssue => ({ identifier: `acme/app#${number}`, title, state, state_reason: reason });
const CLOSED_SUBS = [sub(8, 'CSV writer', 'CLOSED', 'COMPLETED'), sub(9, 'PDF writer', 'CLOSED', 'NOT_PLANNED'), sub(10, 'CLI command', 'CLOSED', 'DUPLICATE')];
const ANALYSIS = {
  type: 'feature',
  complexity: 'XL',
  summary: 'Export invoices.',
  components: ['src/export'],
  acceptance_criteria: ['Invoices can be exported as CSV', 'Invoices can be exported as PDF'],
  risks: [],
  docs_needed: false,
  open_questions: [],
  plan: [],
  refactoring_goals: [],
};
const DESIGN = {
  verdict: 'split',
  summary: 'Split by output format.',
  decision: 'One package per format',
  components: ['CsvExporter'],
  interfaces: ['interface Exporter { export(rows): Buffer }'],
  migrations: [],
  compatibility: null,
  options: [],
  work_packages: ['CSV writer: rows', 'PDF writer: pages', 'CLI command: wires both'],
  head_sha: 'abcdef0123456789abcdef0123456789abcdef01',
};

describe('the architect prompt', () => {
  it('offers the split, create_sub_issue and the sub-issue rules for an XL issue that is no sub-issue', async () => {
    const text = await prompt({ role: 'architect', base: 'develop' });
    assert.match(text, /## Work packages \(complexity XL\)/);
    assert.match(text, /`create_sub_issue`/);
    assert.match(text, /`split`/);
    assert.match(text, /`blocked_by`/);
    assert.match(text, /`Type: …` label and a `Complexity: …` label/);
    assert.match(text, /Part of #7/);
    assert.match(text, /`develop`/, 'the base the packages merge into');
  });

  it('says nothing about packages for every other issue (small, medium, large, unclassified, and a sub-issue)', async () => {
    const parent = sub(6, 'Billing', 'OPEN', null);
    const cases: Array<[string, Partial<PromptOptions>]> = [
      ['S', { labels: ['Type: feature', 'Complexity: S'] }],
      ['M', { labels: ['Type: feature', 'Complexity: M'] }],
      ['L', { labels: ['Type: feature', 'Complexity: L'] }],
      ['no complexity', { labels: ['Type: feature'] }],
      ['XL sub-issue', { parent }],
    ];
    for (const [name, extra] of cases) {
      const text = await prompt({ role: 'architect', ...extra });
      assert.doesNotMatch(text, /Work packages \(complexity XL\)/, name);
      assert.doesNotMatch(text, /create_sub_issue/, name);
      assert.doesNotMatch(text, /`split`/, name);
      assert.match(text, /`ready` \(the design is complete\) or `blocked`/, name);
    }
  });
});

describe('the reviewer prompt: integration mode', () => {
  const integration = (extra: Partial<PromptOptions> = {}) => prompt({ role: 'reviewer', subIssues: CLOSED_SUBS, base: 'develop', results: { analysis: ANALYSIS, design: DESIGN, implementation: null }, ...extra });

  it('lists every package with its state and the reason a closed one was closed', async () => {
    const text = await integration();
    assert.match(text, /reviewer \(integration review\)/);
    assert.match(text, /acme\/app#8 "CSV writer": closed as completed/);
    assert.match(text, /acme\/app#9 "PDF writer": closed as not planned/);
    assert.match(text, /acme\/app#10 "CLI command": closed as duplicate/);
  });

  it('does not approve missing work silently: a package closed as not planned or duplicate is a finding when a criterion needs it', async () => {
    const text = await integration();
    assert.match(text, /closed as not planned or as a duplicate did not deliver its part/);
    assert.match(text, /`major` finding/);
    assert.match(text, /Never approve missing work silently/);
  });

  it('reviews the integrated base branch against the acceptance criteria of the parent, not a pull request', async () => {
    const text = await integration();
    assert.match(text, /Invoices can be exported as CSV/);
    assert.match(text, /Invoices can be exported as PDF/);
    assert.match(text, /origin\/<base>/);
    assert.match(text, /`develop`/);
    assert.match(text, /abcdef012345/, 'the commit the design was made at');
    assert.match(text, /abcdef0123456789abcdef0123456789abcdef01\.\.origin\/<base>/, 'the range the packages brought in');
    assert.match(text, /This issue has no pull request of its own/);
    assert.doesNotMatch(text, /git diff origin\/<base>\.\.\.HEAD/);
  });

  it('states the entry check on the base branch and where each verdict goes', async () => {
    const text = await integration();
    assert.match(text, /entry check of "In review" runs on this checkout/);
    assert.match(text, /tip of `origin\/<base>`/);
    assert.match(text, /`approved` moves the issue to "In review"/);
    assert.match(text, /`changes_needed` hands it to this issue's developer/);
    assert.match(text, /`symphony\/issue-7`/, 'the branch the fix goes on');
  });

  it('works without a configured base branch and without a recorded design', async () => {
    const text = await integration({ base: null, results: { analysis: ANALYSIS, implementation: null } });
    assert.match(text, /integration review/);
    assert.match(text, /the default branch/);
    assert.match(text, /acme\/app#9 "PDF writer": closed as not planned/);
    assert.doesNotMatch(text, /Planned packages/);
  });

  it('switches only when the issue has sub-issues and no implementation of its own', async () => {
    const reviewer = (extra: Partial<PromptOptions>) => prompt({ role: 'reviewer', base: 'develop', results: { analysis: ANALYSIS, implementation: null }, ...extra });
    assert.match(await reviewer({ subIssues: CLOSED_SUBS }), /integration review/);
    for (const [name, text] of [
      ['no sub-issues', await reviewer({ subIssues: [] })],
      ['sub-issues and an implementation of its own', await reviewer({ subIssues: CLOSED_SUBS, results: { analysis: ANALYSIS, design: DESIGN, implementation: { verdict: 'done', summary: 'glue', head_sha: 'abc' } } })],
    ] as const) {
      assert.doesNotMatch(text, /reviewer \(integration review\)/, name);
      assert.doesNotMatch(text, /This issue has no pull request of its own/, name);
      assert.match(text, /## Your role: reviewer\n/, name);
      assert.match(text, /git diff origin\/<base>\.\.\.HEAD/, name);
    }
  });

  it('leaves every other role alone, whatever sub-issues the issue has', async () => {
    for (const role of ['developer', 'test-engineer', 'issue-analyst']) {
      const text = await prompt({ role, subIssues: CLOSED_SUBS, results: { analysis: ANALYSIS, implementation: null } });
      assert.doesNotMatch(text, /integration review/, role);
    }
  });

  it('keeps a normal pull-request review unchanged: the diff against the base, the pull request, the checklist', async () => {
    const text = await prompt({ role: 'reviewer', labels: ['Type: feature', 'Complexity: M'], base: 'develop', results: { analysis: ANALYSIS, implementation: { verdict: 'done', summary: 's', head_sha: 'abc' } } });
    assert.match(text, /## Your role: reviewer\n/);
    assert.match(text, /Call `get_issue`: read the issue, all comments and the linked pull request/);
    assert.match(text, /git diff origin\/<base>\.\.\.HEAD/);
    assert.match(text, /`changes_needed` sends it back to the developer/);
    assert.doesNotMatch(text, /Work packages/);
  });
});

describe('the prompts of a work package (a sub-issue runs the normal pipeline on its own branch)', () => {
  const parent = sub(7, 'Invoice export', 'OPEN', null);

  it('tells the developer of a package its own branch and that the change is scoped to the sub-issue', async () => {
    const text = await prompt({ role: 'developer', number: 8, labels: ['Type: feature', 'Complexity: M'], parent, base: 'develop', results: { analysis: ANALYSIS } });
    assert.match(text, /Parent issue: acme\/app#7 \("Invoice export"\)\. This is a sub-issue: keep the change scoped to it\./);
    assert.match(text, /Work on the branch `symphony\/issue-8`/);
    assert.doesNotMatch(text, /symphony\/issue-7/);
    assert.doesNotMatch(text, /split this issue into work packages/);
  });

  it('gives the reviewer of a package a normal pull-request review', async () => {
    const text = await prompt({ role: 'reviewer', number: 8, labels: ['Type: feature', 'Complexity: M'], parent, base: 'develop', results: { analysis: ANALYSIS, implementation: { verdict: 'done', summary: 's', head_sha: 'abc' } } });
    assert.match(text, /git diff origin\/<base>\.\.\.HEAD/);
    assert.doesNotMatch(text, /integration review\)/);
  });
});

describe('the developer prompt after an integration review', () => {
  const findings = [{ severity: 'major', file: 'src/export/PdfExporter.ts', line: null, problem: 'The PDF export is missing', fix: 'Add the PdfExporter' }];

  it('tells the issue\'s own developer that the packages are merged and only the findings are left', async () => {
    const text = await prompt({ role: 'developer', subIssues: CLOSED_SUBS, results: { analysis: ANALYSIS, design: DESIGN, implementation: null, open_findings: findings } });
    assert.match(text, /An architect split this issue into work packages/);
    assert.match(text, /fix only those/);
    assert.match(text, /The PDF export is missing/);
    assert.match(text, /Work on the branch `symphony\/issue-7`/);
    assert.doesNotMatch(text, /Implement this design/);
  });

  it('keeps the usual wording for a ready design', async () => {
    const text = await prompt({ role: 'developer', results: { analysis: ANALYSIS, design: { ...DESIGN, verdict: 'ready', work_packages: [] } } });
    assert.match(text, /Implement this design/);
    assert.doesNotMatch(text, /split this issue into work packages/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The before_run hook: the workspace of the integration review is at the tip of origin/<base> for the entry check.
// ---------------------------------------------------------------------------------------------------------------------

describe('before_run of the shipped WORKFLOW.md: edge cases of the base-branch sync', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  /** A bare remote with `main` and `release/1.0`, a workspace cloned on `branch`, then one package merged into both branches. */
  function setup(branch: string) {
    const dir = tempDir('symphony-sync-');
    const origin = path.join(dir, 'origin.git');
    const seed = path.join(dir, 'seed');
    const workspace = path.join(dir, 'workspace');
    git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
    git(dir, 'clone', '--quiet', origin, seed);
    fs.writeFileSync(path.join(seed, 'a.txt'), 'a\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '--quiet', '-m', 'first');
    git(seed, 'push', '--quiet', 'origin', 'HEAD:main', 'HEAD:release/1.0');
    git(dir, 'clone', '--quiet', '--branch', branch, origin, workspace);
    const merge = (name: string) => {
      fs.writeFileSync(path.join(seed, name), `${name}\n`);
      git(seed, 'add', '.');
      git(seed, 'commit', '--quiet', '-m', `package ${name}`);
      git(seed, 'push', '--quiet', 'origin', 'HEAD:main', 'HEAD:release/1.0');
      return git(seed, 'rev-parse', 'HEAD');
    };
    return { workspace, merge };
  }

  async function hook(): Promise<string> {
    const { definition } = await loadWorkflowFile(shippedPath);
    return String((definition.config.hooks as Record<string, unknown>).before_run);
  }
  const run = async (cwd: string, env: Record<string, string>) =>
    execFileSync('bash', ['-lc', await hook()], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  it('follows several packages merged one after the other, on a base branch with a slash in its name', async () => {
    const { workspace, merge } = setup('release/1.0');
    merge('b.txt');
    const tip = merge('c.txt');
    await run(workspace, { SYMPHONY_BASE_BRANCH: 'release/1.0' });
    assert.equal(git(workspace, 'rev-parse', 'HEAD'), tip);
    assert.equal(fs.existsSync(path.join(workspace, 'c.txt')), true);
  });

  it('does not fail the hook (and does not rewrite history) when the local base branch cannot fast-forward', async () => {
    const { workspace, merge } = setup('main');
    fs.writeFileSync(path.join(workspace, 'local.txt'), 'local\n');
    git(workspace, 'add', '.');
    git(workspace, 'commit', '--quiet', '-m', 'a local commit');
    const local = git(workspace, 'rev-parse', 'HEAD');
    merge('b.txt');
    await run(workspace, { SYMPHONY_BASE_BRANCH: 'main' });
    assert.equal(git(workspace, 'rev-parse', 'HEAD'), local, 'the diverged checkout stays as it is');
  });

  it('does not touch uncommitted changes that the merge would overwrite', async () => {
    const { workspace, merge } = setup('main');
    merge('b.txt');
    fs.writeFileSync(path.join(workspace, 'b.txt'), 'my own b\n');
    await run(workspace, { SYMPHONY_BASE_BRANCH: 'main' });
    assert.equal(fs.readFileSync(path.join(workspace, 'b.txt'), 'utf8'), 'my own b\n');
  });

  it('leaves a detached HEAD alone', async () => {
    const { workspace, merge } = setup('main');
    git(workspace, 'checkout', '--quiet', '--detach');
    const before = git(workspace, 'rev-parse', 'HEAD');
    merge('b.txt');
    await run(workspace, { SYMPHONY_BASE_BRANCH: 'main' });
    assert.equal(git(workspace, 'rev-parse', 'HEAD'), before);
  });

  it('does not move a workspace whose branch is not the base branch', async () => {
    const { workspace, merge } = setup('release/1.0');
    merge('b.txt');
    await run(workspace, { SYMPHONY_BASE_BRANCH: 'main' });
    assert.equal(fs.existsSync(path.join(workspace, 'b.txt')), false, 'release/1.0 is not the configured base, so it is left alone');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The orchestrator with the shipped WORKFLOW.md on a board that treats sub-issues like the GitHub adapter.
// ---------------------------------------------------------------------------------------------------------------------

const PARENT = '7';
const PARENT_ID = 'acme/app#7';
const SCENARIO_ENV = { ...ENV, SYMPHONY_MAX_CONCURRENT_AGENTS: '8' };

function ref(number: number, parent: LinkedIssue | null = null): Record<string, unknown> {
  return { provider: 'github_project', repository: 'acme/app', number, parent, sub_issues: [], base_branch: null, status_updated_at: '2026-01-01T00:00:00.000Z' };
}

function parentIssue(state: string, labels = ['Type: feature', 'Complexity: XL']): Issue {
  return makeIssue({ id: PARENT, title: 'Invoice export', state, labels, description: 'Export invoices as CSV and PDF.', native_ref: ref(7) });
}

/** A package that already exists as a sub-issue of the parent, in a column no role serves (so no session starts for it). */
function packageIssue(number: number, title: string, state = 'Blocked'): Issue {
  return makeIssue({
    id: String(number),
    title,
    state,
    labels: ['Type: feature', 'Complexity: M'],
    native_ref: ref(number, { identifier: PARENT_ID, title: 'Invoice export', state: 'OPEN', state_reason: null }),
  });
}

class Board extends FakeTracker {
  readonly closed = new Map<string, string>();
  #next = 8;

  constructor(issues: Issue[]) {
    super(issues);
    this.statusOptions = async () => BOARD;
    this.openSubIssues = (issue) => openSubIssuesOf(issue).map((entry) => entry.identifier);
    this.#next = Math.max(8, ...issues.map((issue) => Number(issue.id) + 1));
  }

  heldBySubIssues(issue: Issue): boolean {
    return isHeldBySubIssues(issue);
  }

  close(id: string, reason = 'COMPLETED'): void {
    this.closed.set(id, reason);
    this.set(id, { state: 'Done' });
  }

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
        sub_issues: this.subIssues(issue.id).map((child) => ({ identifier: child.identifier, title: child.title, state: this.closed.has(child.id) ? 'CLOSED' : 'OPEN', state_reason: this.closed.get(child.id) ?? null })),
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
        const open = this.subIssues(parent.id).filter((child) => !this.closed.has(child.id));
        const title = String(args.title);
        const existing = open.find((child) => child.title === title);
        if (existing !== undefined) return { ok: true, data: { created: false, number: existing.native_ref?.number } };
        if (open.length >= max) return { ok: false, error: { category: 'limit_reached', message: `limit ${max}` } };
        const number = this.#next++;
        const blockers = Array.isArray(args.blocked_by) ? args.blocked_by.map(Number) : [];
        const child = makeIssue({
          id: String(number),
          title,
          description: typeof args.body === 'string' ? args.body : null,
          state: context.subIssueStatus ?? 'Backlog',
          labels: Array.isArray(args.labels) ? args.labels.map((label) => String(label).toLowerCase()) : [],
          blocked_by: blockers.map((blocker) => ({ id: String(blocker), identifier: `acme/app#${blocker}`, state: 'OPEN' })),
          native_ref: ref(number, { identifier: parent.identifier, title: parent.title, state: 'OPEN', state_reason: null }),
        });
        this.issues.set(child.id, child);
        return { ok: true, data: { created: true, number, status: child.state } };
      },
    };
    return [...super.agentToolSpecs(), createSubIssue];
  }
}

type Script = (context: { turn: number; params: StartSessionParams; report(args: Record<string, unknown>): Promise<ToolResult> }) => Promise<TurnResult | void>;

interface Harness {
  orchestrator: Orchestrator;
  board: Board;
  runner: FakeRunner;
  timers: ManualTimers;
  clock: ManualClock;
  workflow: StaticWorkflow;
  reports: ToolResult[];
}

const working = (turn: number, params: StartSessionParams): Promise<TurnResult> =>
  new Promise((resolve) => {
    const stopped = () => resolve({ ok: false, turnId: String(turn), code: 'turn_cancelled', message: 'cancelled' });
    if (params.signal.aborted) stopped();
    else params.signal.addEventListener('abort', stopped);
  });

/** The workspace's first commit, made with fixed dates: the same in every workspace, so a design made at it can be seeded. */
const INIT_COMMIT = [
  'git init -q',
  'git config user.email symphony@example.com',
  'git config user.name Symphony',
  'GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z git commit -q --no-gpg-sign --allow-empty -m init',
].join('\n');
const INIT_SHA = (() => {
  const dir = tempDir('symphony-init-');
  execFileSync('bash', ['-c', INIT_COMMIT], { cwd: dir, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
})();

/** The architect's `split` result on the parent, made at the workspace's first commit, as the board keeps it. */
function seedSplitDesign(board: FakeTracker): void {
  const parsed = parseResult('design', SPLIT);
  assert.ok(parsed.ok);
  const meta: ResultMeta = { role: 'architect', run: 'r0', round: null, profile: 'feature', workflow_hash: null, head_sha: INIT_SHA, checks: null, target: 'Agent review', created_at: '2026-01-01T01:00:00.000Z' };
  board.comments.set(PARENT, [{ author: board.viewer, createdAt: new Date(meta.created_at), body: renderResultComment(parsed.result, meta), url: 'https://github.com/acme/app/issues/7#issuecomment-1' }]);
}

/** The sessions of an issue run its scripts in order (every turn calls the script of the session); an unscripted session works until stopped. */
async function harness(issues: Issue[], scripts: Record<string, Script[]> = {}): Promise<Harness> {
  const { definition } = await loadWorkflowFile(shippedPath);
  const config: Record<string, unknown> = {
    ...definition.config,
    workspace: { root: tempDir() },
    hooks: { after_create: INIT_COMMIT },
    checks: {},
    tracker: { ...(definition.config.tracker as Record<string, unknown>), kind: 'github_project', provider: { owner: 'acme', project_number: 1, token: 'test-token' } },
  };
  const board = new Board(issues);
  const reports: ToolResult[] = [];
  const queues = new Map(Object.entries(scripts).map(([id, list]) => [id, [...list]]));
  const assigned = new Map<StartSessionParams, Script | null>();
  const runner = new FakeRunner(async (turn, params): Promise<TurnResult> => {
    if (!assigned.has(params)) assigned.set(params, queues.get(params.issue.id)?.shift() ?? null);
    const script = assigned.get(params) ?? null;
    if (script === null) return working(turn, params);
    const report = async (args: Record<string, unknown>) => {
      const result = await callTool(params, 'report_result', args);
      reports.push(result);
      return result;
    };
    const outcome = await script({ turn, params, report });
    return outcome ?? { ok: true, turnId: String(turn), resultText: 'done' };
  });
  const timers = new ManualTimers();
  const clock = new ManualClock();
  const workflow = new StaticWorkflow(makeWorkflow(config, { prompt: definition.promptTemplate, env: SCENARIO_ENV, dir: root }));
  const orchestrator = new Orchestrator({ workflow, runner, logger: Logger.silent(), env: {}, logDir: null, clock, timers, createAdapter: () => board });
  return { orchestrator, board, runner, timers, clock, workflow, reports };
}

const sessionsOf = (h: Harness, id: string) => h.runner.sessions.filter((session) => session.params.issue.id === id);
const roleOf = (session: { turns: string[] } | undefined): string => /## Your role: ([a-z ()-]+)/.exec(session?.turns[0] ?? '')?.[1]?.trim() ?? '';
const blockedReason = (h: Harness, id = PARENT) => h.orchestrator.snapshot().blocked.find((row) => row.issue_id === id)?.reason;
const stateOf = (h: Harness, id = PARENT) => h.board.issues.get(id)?.state;
const dataOf = (result: ToolResult | undefined): Record<string, unknown> => {
  assert.ok(result?.ok, JSON.stringify(result));
  return result.data as Record<string, unknown>;
};

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

const PACKAGES = [
  { title: 'Export: CSV writer', body: 'Rows as CSV.\n\nPart of #7', labels: ['Type: feature', 'Complexity: M'] },
  { title: 'Export: PDF writer', body: 'One PDF per invoice.\n\nPart of #7', labels: ['Type: feature', 'Complexity: M'] },
  { title: 'Export: CLI command', body: 'Wires both.\n\nBlocked by #8, #9\n\nPart of #7', labels: ['Type: feature', 'Complexity: S'], blocked_by: [8, 9] },
];
const SPLIT = {
  verdict: 'split',
  summary: 'Three packages.',
  decision: 'Split along the output formats',
  options: ['One developer', 'One package per format'],
  components: ['CsvExporter', 'PdfExporter', 'ExportCommand'],
  interfaces: ['interface Exporter { export(rows): Buffer }'],
  work_packages: ['Export: CSV writer: rows', 'Export: PDF writer: pages', 'Export: CLI command: wires both'],
};

describe('orchestrator: an XL feature split into three work packages', () => {
  it('creates three sub-issues in Ready, keeps the architect running across reconciliation and a reminder turn and parks the parent in the integration review', async () => {
    const created: ToolResult[] = [];
    let filed: () => void = () => undefined;
    const packagesFiled = new Promise<void>((resolve) => (filed = resolve));
    let proceed: () => void = () => undefined;
    const reconciled = new Promise<void>((resolve) => (proceed = resolve));
    const architect: Script = async ({ turn, params, report }) => {
      if (turn === 1) {
        for (const pkg of PACKAGES) created.push(await callTool(params, 'create_sub_issue', pkg));
        filed();
        await reconciled;
        // The turn ends without a result: the reminder turn happens while the three packages are open.
        return;
      }
      await report(SPLIT);
    };
    const h = await harness([parentIssue('Design')], { [PARENT]: [architect] });
    await h.orchestrator.tickNow();
    await packagesFiled;

    // Three open sub-issues now: a reconciliation must not stop the session that filed them.
    assert.deepEqual(created.map((result) => [dataOf(result).created, dataOf(result).status]), [[true, 'Ready'], [true, 'Ready'], [true, 'Ready']]);
    assert.equal(h.board.subIssues(PARENT).length, 3, 'exactly three sub-issues');
    assert.equal(h.board.issues.get(PARENT)?.state, 'Design');
    await h.orchestrator.tickNow();
    assert.equal(sessionsOf(h, PARENT)[0]?.stopped, false, 'reconciliation left the architect running');
    assert.ok(h.orchestrator.snapshot().running.some((row) => row.issue_id === PARENT));
    proceed();
    await until(() => h.reports.length === 1, 3_000, 'the split result');

    assert.deepEqual(h.board.subIssues(PARENT).map((child) => child.title), PACKAGES.map((pkg) => pkg.title));
    assert.deepEqual(h.board.subIssues(PARENT)[2]?.blocked_by.map((blocker) => blocker.identifier), ['acme/app#8', 'acme/app#9'], 'the command waits for both writers');
    assert.deepEqual(h.board.subIssues(PARENT)[0]?.blocked_by, []);

    // One architect session with a second turn after the packages existed; its result is recorded and moves the parent.
    assert.equal(sessionsOf(h, PARENT).length, 1);
    assert.equal(sessionsOf(h, PARENT)[0]?.turns.length, 2, 'the continuation turn ran while the packages were open');
    assert.equal(dataOf(h.reports[0]).target, 'Agent review');
    assert.equal(stateOf(h), 'Agent review');
    assert.deepEqual(h.board.statusCalls, ['Agent review']);
    const markers = (h.board.comments.get(PARENT) ?? []).map((comment) => decodeMarker(comment.body)).filter((marker) => marker !== null);
    assert.deepEqual(markers.map((marker) => [marker.result.kind, marker.result.verdict]), [['design', 'split']]);

    // Each package runs its own pipeline in its own workspace; the dependent one waits for the two it builds on.
    await h.orchestrator.tickNow();
    await until(() => sessionsOf(h, '8').length === 1 && sessionsOf(h, '9').length === 1, 3_000, 'the analysts of the writers');
    assert.equal(sessionsOf(h, '10').length, 0);
    assert.equal(roleOf(sessionsOf(h, '8')[0]), 'issue analyst');
    assert.equal(new Set([PARENT, '8', '9'].map((id) => sessionsOf(h, id)[0]?.params.cwd)).size, 3);
    // The parent gets no developer or test engineer session: the claim is released without a pause, and nothing starts
    // while the packages are open.
    await continueWith(h);
    await h.orchestrator.tickNow();
    assert.deepEqual(sessionsOf(h, PARENT).map(roleOf), ['architect']);
    assert.equal(h.orchestrator.snapshot().paused.length, 0);
    assert.equal(blockedReason(h), 'waiting for sub-issues acme/app#8, acme/app#9, acme/app#10');
    await h.orchestrator.shutdown(1_000);
  });

  it('gives the parent no session, no forced start and a waiting line until the third package is closed, then reviews the integrated branch', async () => {
    const approve: Script = async ({ report }) => {
      await report({ verdict: 'approved', summary: 'All three packages are on develop and meet the acceptance criteria.', checked: ['Completeness: OK', 'acme/app#8: completed', 'acme/app#9: completed', 'acme/app#10: completed'] });
    };
    const issues = [parentIssue('Agent review'), packageIssue(8, 'Export: CSV writer'), packageIssue(9, 'Export: PDF writer'), packageIssue(10, 'Export: CLI command')];
    const h = await harness(issues, { [PARENT]: [approve] });
    seedSplitDesign(h.board);

    await h.orchestrator.tickNow();
    const waiting = 'waiting for sub-issues acme/app#8, acme/app#9, acme/app#10';
    assert.equal(sessionsOf(h, PARENT).length, 0);
    assert.equal(blockedReason(h), waiting);
    assert.deepEqual(await h.orchestrator.forceStart(PARENT_ID), { ok: false, reason: 'blocked', message: waiting });
    const config = h.workflow.current.config;
    const board = await h.board.fetchIssuesByStates(config.tracker.activeStates);
    const item = dryRunPlan(board, config, h.board, new Map(), h.clock.now()).find((entry) => entry.issueId === PARENT);
    assert.equal(item?.group, 'blocked');
    assert.match(planLines(item!, board.find((issue) => issue.id === PARENT)!).join('\n'), /waiting for sub-issues acme\/app#8, acme\/app#9, acme\/app#10/);

    // Closed one by one: two closed are still not enough, whatever the reason.
    h.board.close('8');
    await h.orchestrator.tickNow();
    assert.equal(sessionsOf(h, PARENT).length, 0);
    assert.equal(blockedReason(h), 'waiting for sub-issues acme/app#9, acme/app#10');
    h.board.close('9', 'NOT_PLANNED');
    await h.orchestrator.tickNow();
    assert.equal(sessionsOf(h, PARENT).length, 0, 'no dispatch before the third closes');
    assert.equal(blockedReason(h), 'waiting for sub-issues acme/app#10');
    assert.equal((await h.orchestrator.forceStart(PARENT_ID)).ok, false);

    h.board.close('10', 'DUPLICATE');
    await h.orchestrator.tickNow();
    await until(() => sessionsOf(h, PARENT).length === 1, 3_000, 'the integration review');
    assert.equal(blockedReason(h), undefined);
    const text = sessionsOf(h, PARENT)[0]?.turns[0] ?? '';
    assert.equal(roleOf(sessionsOf(h, PARENT)[0]), 'reviewer (integration review)');
    assert.match(text, /acme\/app#8 "Export: CSV writer": closed as completed\n- acme\/app#9 "Export: PDF writer": closed as not planned\n- acme\/app#10 "Export: CLI command": closed as duplicate/);

    // approved goes through the review transitions to In review; the claim is released without a pause.
    await until(() => h.reports.length === 1, 3_000, 'the review result');
    assert.equal(dataOf(h.reports[0]).target, 'In review');
    assert.equal(stateOf(h), 'In review');
    await until(() => !h.orchestrator.snapshot().running.some((row) => row.issue_id === PARENT), 3_000, 'the session to end');
    assert.equal(h.orchestrator.snapshot().paused.length, 0);
    await h.orchestrator.shutdown(1_000);
  });

  it('routes changes_needed of the integration review to the issue\'s own developer, whose pull request gets a normal review', async () => {
    const issues = [parentIssue('Agent review'), packageIssue(8, 'Export: CSV writer'), packageIssue(9, 'Export: PDF writer')];
    for (const id of ['8', '9']) issues[Number(id) - 7] = { ...(issues[Number(id) - 7] as Issue) };
    const integration: Script = async ({ report }) => {
      await report({
        verdict: 'changes_needed',
        summary: 'The PDF export is missing: acme/app#9 was closed as not planned.',
        findings: [{ severity: 'major', file: 'src/export/PdfExporter.ts', problem: 'No PDF export (acme/app#9 not planned)', fix: 'Add the PdfExporter' }],
        checked: ['Completeness: finding 1'],
      });
    };
    const fix: Script = async ({ report }) => {
      await report({ verdict: 'done', summary: 'Added the PdfExporter.', changed_files: ['src/export/PdfExporter.ts'] });
    };
    const h = await harness(issues, { [PARENT]: [integration, fix] });
    h.board.close('8');
    h.board.close('9', 'NOT_PLANNED');
    await h.orchestrator.tickNow();
    await until(() => h.reports.length === 1, 3_000, 'the integration review');
    assert.equal(dataOf(h.reports[0]).target, 'In progress');
    assert.equal(stateOf(h), 'In progress');
    await until(() => !h.orchestrator.snapshot().running.some((row) => row.issue_id === PARENT), 3_000, 'the review session to end');
    await until(() => h.orchestrator.snapshot().retrying.some((retry) => retry.issue_id === PARENT && retry.kind === 'continuation'), 3_000, 'continuation');
    h.timers.fire(CONTINUATION_DELAY_MS);
    await until(() => sessionsOf(h, PARENT).length === 2, 3_000, 'the developer');
    assert.equal(roleOf(sessionsOf(h, PARENT)[1]), 'developer');
    assert.match(sessionsOf(h, PARENT)[1]?.turns[0] ?? '', /PdfExporter/);
    await h.orchestrator.shutdown(1_000);
  });
});

describe('orchestrator: the sub-issue gate does not change for anything but the architect that filed the packages', () => {
  it('still stops a running developer when a human adds an open sub-issue to its issue', async () => {
    const h = await harness([makeIssue({ id: '3', identifier: 'acme/app#3', title: 'Fix', state: 'In progress', labels: ['Type: feature', 'Complexity: M'], native_ref: ref(3) })]);
    await h.orchestrator.tickNow();
    await until(() => h.runner.sessions.length === 1, 3_000, 'the developer session');
    assert.equal(h.runner.sessions[0]?.stopped, false);
    h.board.issues.set('30', makeIssue({ id: '30', title: 'Added by a human', state: 'Backlog', native_ref: ref(30, { identifier: 'acme/app#3', title: 'Fix', state: 'OPEN', state_reason: null }) }));
    await h.orchestrator.tickNow();
    await until(() => h.runner.sessions[0]?.stopped === true, 3_000, 'the developer to be stopped');
    await until(() => !h.orchestrator.snapshot().running.some((row) => row.issue_id === '3'), 3_000, 'the developer to leave the running list');
    await h.orchestrator.shutdown(1_000);
  });

  it('still stops a running architect when something else than its sub-issues holds the issue back', async () => {
    const h = await harness([parentIssue('Design')]);
    await h.orchestrator.tickNow();
    await until(() => h.runner.sessions.length === 1, 3_000, 'the architect session');
    // An open blocker appears next to an open sub-issue: the sub-issues are no longer the only reason.
    h.board.issues.set('8', packageIssue(8, 'Export: CSV writer', 'Ready'));
    h.board.set(PARENT, { blocked_by: [{ id: '99', identifier: 'acme/app#99', state: 'OPEN' }] });
    await h.orchestrator.tickNow();
    await until(() => h.runner.sessions[0]?.stopped === true, 3_000, 'the architect to be stopped');
    await h.orchestrator.shutdown(1_000);
  });

  it('does not start an architect for an issue that already has an open sub-issue (the wait applies to new sessions)', async () => {
    const h = await harness([parentIssue('Design'), packageIssue(8, 'Filed by a human')]);
    await h.orchestrator.tickNow();
    assert.equal(sessionsOf(h, PARENT).length, 0);
    assert.equal(blockedReason(h), 'waiting for sub-issues acme/app#8');
    await h.orchestrator.shutdown(1_000);
  });

  it('does not let a sub-issue split again: its architect is refused the split and reports ready', async () => {
    const refusals: ToolResult[] = [];
    const architect: Script = async ({ report }) => {
      refusals.push(await report(SPLIT));
      await report({ ...SPLIT, verdict: 'ready', work_packages: [] });
    };
    const issue = makeIssue({ id: '12', identifier: 'acme/app#12', title: 'A package', state: 'Design', labels: ['Type: feature', 'Complexity: XL'], native_ref: ref(12, { identifier: PARENT_ID, title: 'Invoice export', state: 'OPEN', state_reason: null }) });
    const h = await harness([issue], { '12': [architect] });
    await h.orchestrator.tickNow();
    await until(() => stateOf(h, '12') === 'In progress', 3_000, 'the package to go to the developer');
    assert.equal(refusals[0]?.ok, false);
    assert.equal(h.board.subIssues('12').length, 0);
    assert.match(sessionsOf(h, '12')[0]?.turns[0] ?? '', /`ready` \(the design is complete\) or `blocked`/);
    await h.orchestrator.shutdown(1_000);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Documentation: the flow, the decision against an integration-engineer role, and the READMEs.
// ---------------------------------------------------------------------------------------------------------------------

describe('docs: work packages as sub-issues', () => {
  const section = (file: string, heading: RegExp): string => {
    const lines = read(file).split('\n');
    const start = lines.findIndex((line) => /^#{1,6} /.test(line) && heading.test(line));
    assert.notEqual(start, -1, `${file}: no heading ${heading}`);
    const level = /^#+/.exec(lines[start] ?? '')?.[0].length ?? 1;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const h = /^(#+) /.exec(lines[i] ?? '');
      if (h && (h[1]?.length ?? 99) <= level) {
        end = i;
        break;
      }
    }
    return lines.slice(start, end).join('\n');
  };

  it('explains why work packages as sub-issues replace an integration-engineer role', () => {
    const text = section('docs/concepts/multi-agent.md', /integration engineer/i);
    assert.match(text, /integration-engineer role/i);
    assert.match(text, /second writer/i, 'no second writer on one branch');
    assert.match(text, /worktrees?/i, 'no worktrees');
    assert.match(text, /on_conflict/, 'conflicts surface at merge through on_conflict');
    assert.match(text, /entry checks?/i, 'the existing reviewer plus entry checks verify the integration');
    assert.match(text, /reviewer/i);
    assert.match(text, /base branch/i);
    assert.match(text, /one role fewer/i);
  });

  it('documents the split verdict and its refusals next to the other verdicts of a design', () => {
    const results = read('docs/results.md');
    assert.match(results, /\| `design` \| `ready`, `split`, `blocked` \|/);
    const packages = section('docs/results.md', /^#+ Work packages/);
    for (const rule of [/XL/, /sub-issue/, /max_sub_issues/, /invalid_result/, /work_packages/]) assert.match(packages, rule);
    assert.match(read('docs/configuration.md'), /`design`: `ready`, `split`, `blocked`/);
  });

  it('documents the flow for the user: split, parallel packages, waiting, conflicts, integration review, outcomes', () => {
    const text = section('docs/usage.md', /Work packages for very large changes/);
    for (const part of [/`split`/, /sub-issue/, /Ready/, /Blocked by #/, /never split again/, /waiting for sub-issues/, /Start now/, /not planned/, /on_conflict/, /integration review/i, /`approved`/, /`changes_needed`/, /In progress/, /SYMPHONY_ARCHITECT_MAX_SUB_ISSUES/]) {
      assert.match(text, part);
    }
    const configuration = section('docs/configuration.md', /^#+ Work packages \(`split`\)/);
    for (const part of [/Complexity/, /max_sub_issues/, /sub_issue_status: Ready/, /run_checks: false/, /respect_sub_issues/, /results\.implementation/, /origin\/<base>/, /before_run/, /changes_needed/, /In progress/, /on_conflict/]) {
      assert.match(configuration, part);
    }
  });

  it('references only documentation anchors that exist (WORKFLOW.md, .env.example)', () => {
    const slug = (heading: string): string =>
      [...heading.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '').toLowerCase()].filter((char) => /[\p{L}\p{N}_\- ]/u.test(char)).join('').replace(/ /g, '-');
    const anchorsOf = (file: string): Set<string> => new Set([...read(file).matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)].map((match) => slug(match[1] ?? '')));
    const problems: string[] = [];
    for (const file of ['WORKFLOW.md', '.env.example']) {
      for (const match of read(file).matchAll(/\b(docs\/[\w./-]+\.md)#([\w-]+)/g)) {
        const [, target = '', fragment = ''] = match;
        if (!fs.existsSync(path.join(root, target))) problems.push(`${file}: ${target} does not exist`);
        else if (!anchorsOf(target).has(fragment)) problems.push(`${file}: no heading #${fragment} in ${target}`);
      }
    }
    assert.deepEqual(problems, []);
    assert.match(read('WORKFLOW.md'), /docs\/usage\.md#work-packages-for-very-large-changes/, 'the architect role points at the documentation of the flow');
  });

  it('documents the default of the limit as the shipped workflow has it', async () => {
    const { config } = await shipped();
    const limit = String(roleNamed(config, 'architect').maxSubIssues);
    assert.match(read('docs/usage.md'), new RegExp(`SYMPHONY_ARCHITECT_MAX_SUB_ISSUES\`, default ${limit}`));
    assert.match(read('.env.example'), new RegExp(`^SYMPHONY_ARCHITECT_MAX_SUB_ISSUES=${limit}$`, 'm'));
  });

  it('mentions the feature in both READMEs under Features, with the same links', () => {
    const features = (file: string, heading: RegExp): string => {
      const text = read(file);
      const start = text.search(heading);
      assert.ok(start >= 0, file);
      return text.slice(start, start + 5 + text.slice(start + 5).search(/^## /m));
    };
    const english = features('README.md', /^## ✨ Features/m);
    const german = features('README.de.md', /^## ✨ Features/m);
    assert.match(english, /Work packages/);
    assert.match(german, /Arbeitspakete/);
    const targets = (text: string) => [...text.matchAll(/\]\(((?:docs\/)[^)\s]*work-packages[^)\s]*)\)/g)].map((match) => match[1]);
    assert.deepEqual(targets(english), targets(german));
    assert.ok(targets(english).length >= 2, 'the details and the reason');
    assert.ok(targets(english).some((target) => target?.startsWith('docs/concepts/multi-agent.md#')));
  });

  it('leaves the prescribed section structure of README.md in place, in the prescribed order', () => {
    const headings = [...read('README.md').matchAll(/^## (.+?)\s*$/gm)].map((match) => match[1] ?? '');
    const wanted = ['✨ Features', '🚀 Getting started', '📋 Usage', '📁 Project structure', '📚 Documentation', '🔗 References', '📄 License'];
    const found = headings.filter((heading) => wanted.includes(heading));
    assert.deepEqual(found, wanted);
    assert.equal([...read('README.de.md').matchAll(/^## (.+?)\s*$/gm)].length, headings.length, 'README.de.md mirrors the sections');
  });
});
