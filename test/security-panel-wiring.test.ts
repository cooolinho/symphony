import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { StartSessionParams, TurnResult } from '../src/agent/types.ts';
import { Logger } from '../src/log.ts';
import { CONTINUATION_DELAY_MS } from '../src/orchestrator/eligibility.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import type { ToolResult } from '../src/tracker/types.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { PANEL_LENSES } from '../src/workflow/results.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, callTool, makeIssue, makeWorkflow, tempDir, until } from './helpers.ts';

// The `panel` flag of the worker (role.result === 'security' && refutation-judge allowed) reaches report_result: a real
// security-auditor session at Complexity L runs through Orchestrator -> worker -> report_result (#549).

const shipped = path.join(import.meta.dirname, '..', 'WORKFLOW.md');
const ISSUE = '7';
const BOARD = ['Backlog', 'Ready', 'Design', 'In progress', 'Testing', 'Documentation', 'Agent review', 'Security review', 'Blocked', 'In review', 'Done'];
const ENV = { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' };

type Script = (params: StartSessionParams, report: (args: Record<string, unknown>) => Promise<ToolResult>) => Promise<void>;

const vote = (lens: string) => ({ lens, verdict: 'confirmed', evidence: `app/Http/PostController.php:12 ${lens}` });
const finding = (votes?: unknown[]) => ({
  severity: 'major',
  file: 'app/Http/PostController.php',
  line: 12,
  problem: 'Mass assignment of is_admin',
  fix: 'Use validated()',
  verification: { status: 'confirmed', evidence: 'app/Http/PostController.php:12 shows it', ...(votes === undefined ? {} : { votes }) },
});
const issuesFound = (findings: unknown[]) => ({ verdict: 'issues_found', summary: 'Audit.', findings });

async function harness(script: Script, options: { agents?: string[] } = {}) {
  const { definition } = await loadWorkflowFile(shipped);
  const roles = definition.config.roles as Record<string, Record<string, unknown>>;
  const front: Record<string, unknown> = {
    ...definition.config,
    workspace: { root: tempDir() },
    hooks: {},
    checks: {},
    tracker: { ...(definition.config.tracker as Record<string, unknown>), kind: 'github_project', provider: { owner: 'acme', project_number: 1, token: 'test-token' } },
    ...(options.agents ? { roles: { ...roles, 'security-auditor': { ...roles['security-auditor'], agents: options.agents } } } : {}),
  };
  const tracker = new FakeTracker([
    makeIssue({
      id: ISSUE,
      state: 'Security review',
      labels: ['feature', 'complexity: l'],
      native_ref: { provider: 'github_project', repository: 'acme/app', number: 7, parent: null, sub_issues: [], base_branch: 'develop', status_updated_at: '2026-01-01T00:00:00.000Z' },
    }),
  ]);
  tracker.statusOptions = async () => BOARD;
  const reports: ToolResult[] = [];
  const runner = new FakeRunner(async (turn, params): Promise<TurnResult> => {
    if (turn === 1) {
      await script(params, async (args) => {
        const result = await callTool(params, 'report_result', args);
        reports.push(result);
        return result;
      });
    }
    return { ok: true, turnId: String(turn), resultText: 'done' };
  });
  const timers = new ManualTimers();
  const workflow = new StaticWorkflow(makeWorkflow(front, { prompt: definition.promptTemplate, partials: definition.partials, env: ENV, dir: path.dirname(shipped) }));
  const orchestrator = new Orchestrator({ workflow, runner, logger: Logger.silent(), env: {}, logDir: null, clock: new ManualClock(), timers, createAdapter: () => tracker });
  await orchestrator.tickNow();
  for (;;) {
    await until(() => {
      const { running, retrying, claimed, paused } = orchestrator.snapshot().counts;
      return running === 0 && (retrying === 1 || claimed === 0 || paused > 0);
    }, 5_000, 'the pipeline to rest');
    if (orchestrator.snapshot().retrying[0]?.kind !== 'continuation') break;
    const sessions = runner.sessions.length;
    timers.fire(CONTINUATION_DELAY_MS);
    await until(() => runner.sessions.length > sessions || orchestrator.snapshot().counts.claimed === 0, 5_000, 'the continuation');
  }
  return { tracker, runner, reports };
}

describe('security panel wiring in the worker (#549)', () => {
  it('L security session with refutation-judge allowed: a confirmed finding without votes is refused, three votes are recorded', async () => {
    const h = await harness(async (_params, report) => {
      await report(issuesFound([finding()]));
      await report(issuesFound([finding(PANEL_LENSES.map(vote))]));
    });
    const refused = h.reports[0]!;
    const accepted = h.reports[1]!;
    assert.equal(refused.ok, false);
    assert.ok(!refused.ok && refused.error.category === 'invalid_result', JSON.stringify(refused));
    assert.match(JSON.stringify(refused), /three panel votes/);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal(h.tracker.statusCalls[0], 'In progress');
    assert.match(h.runner.sessions[0]!.turns[0]!, /Panel review/);
    assert.match(h.runner.sessions[0]!.turns[0]!, /symphony:refutation-judge/);
    assert.ok(!h.runner.sessions[0]!.params.deniedAgents?.includes('refutation-judge'));
  });

  it('the same session with agents: [] accepts the result without votes (E3-4)', async () => {
    const h = await harness(
      async (_params, report) => {
        await report(issuesFound([finding()]));
      },
      { agents: [] },
    );
    assert.equal(h.reports[0]!.ok, true, JSON.stringify(h.reports[0]!));
    assert.equal(h.tracker.statusCalls[0], 'In progress');
    assert.ok(h.runner.sessions[0]!.params.deniedAgents?.includes('refutation-judge'));
    assert.doesNotMatch(h.runner.sessions[0]!.turns[0]!, /Panel review/);
    assert.match(h.runner.sessions[0]!.turns[0]!, /A finding without a confirmed verification is refused/);
  });
});
