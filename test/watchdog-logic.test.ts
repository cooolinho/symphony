import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { FileSink } from '../src/log.ts';
import { humanFeedback, type PersistedResult } from '../src/orchestrator/stage-history.ts';
import type { IssueComment } from '../src/tracker/types.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import type { ResultMeta, StageResult } from '../src/workflow/results.ts';
import type { RoleConfig } from '../src/workflow/roles.ts';
import { classifyBlock, roleColumn } from '../src/watchdog/case.ts';
import { decide, type DecideInput, type Diagnosis } from '../src/watchdog/decide.ts';
import { decodeWatchdogMarker, encodeWatchdogMarker, isWatchdogResume, watchdogEntries, type WatchdogMarker } from '../src/watchdog/marker.ts';

const VIEWER = 'symphony-bot';
const ACTIVE = ['Ready', 'Design', 'In progress', 'Testing', 'Documentation', 'Agent review', 'Security review'];

function marker(over: Partial<WatchdogMarker> = {}): WatchdogMarker {
  return { action: 'resume', cause: 'infra_transient', target: 'In progress', attempt: 1, blocked_at: null, prompt_hash: 'abc', created_at: '2026-11-12T10:00:00.000Z', ...over };
}

function comment(body: string, at: string, author: string | null = VIEWER): IssueComment {
  return { author, body, createdAt: new Date(at), url: `https://example.test/c/${at}` };
}

function result(role: string, verdict: string, at: string, over: Partial<ResultMeta> = {}, blockers: StageResult['blockers'] = []): PersistedResult {
  const meta: ResultMeta = { role, run: `run-${at}`, round: null, profile: null, workflow_hash: null, head_sha: null, checks: null, target: 'Blocked', created_at: at, ...over };
  return { result: { schema: 'symphony.result/v1', kind: 'implementation', verdict, summary: 'sum', blockers, follow_ups: [] } as unknown as StageResult, meta, url: 'https://example.test/r' };
}

function role(name: string, states: string[]): RoleConfig {
  return { name, states: states.map((s) => s.toLowerCase()) } as unknown as RoleConfig;
}

const ROLES = [role('issue-analyst', ['Ready']), role('developer', ['In progress']), role('docs', ['Documentation']), role('reviewer', ['Agent review'])];

describe('watchdog marker', () => {
  it('round-trips and rejects foreign text', () => {
    const m = marker();
    assert.deepEqual(decodeWatchdogMarker(`text\n${encodeWatchdogMarker(m)}`), m);
    assert.equal(decodeWatchdogMarker('<!-- symphony:watchdog:v1 not_base64 -->'), null);
    assert.equal(decodeWatchdogMarker('no marker'), null);
  });

  it('counts only markers from the own account', () => {
    const body = encodeWatchdogMarker(marker());
    const entries = watchdogEntries([comment(body, '2026-11-12T10:00:00Z'), comment(body, '2026-11-12T10:01:00Z', 'someone')], VIEWER);
    assert.equal(entries.length, 1);
  });

  it('only resume markers count as feedback', () => {
    assert.equal(isWatchdogResume(encodeWatchdogMarker(marker())), true);
    assert.equal(isWatchdogResume(encodeWatchdogMarker(marker({ action: 'escalate' }))), false);
  });
});

describe('humanFeedback with watchdog comments', () => {
  it('passes the watchdog resume comment of the own account to the next agent', () => {
    const results = [result('developer', 'blocked', '2026-11-12T09:00:00.000Z')];
    const comments = [
      comment(`Do X\n${encodeWatchdogMarker(marker())}`, '2026-11-12T10:00:00Z'),
      comment(`Escalated\n${encodeWatchdogMarker(marker({ action: 'escalate' }))}`, '2026-11-12T10:01:00Z'),
      comment('other bot text', '2026-11-12T10:02:00Z'),
    ];
    const feedback = humanFeedback(comments, VIEWER, results);
    assert.equal(feedback.length, 1);
    assert.match(feedback[0]?.body ?? '', /Do X/);
  });
});

describe('classifyBlock', () => {
  const base = { comments: [], viewer: VIEWER, history: [], issueIdentifier: 'o/r#1', blockedColumns: ['Blocked'], activeStates: ACTIVE, roles: ROLES, blockedAt: null };

  it('reads a blocking result: role, column and blockers', () => {
    const block = classifyBlock({ ...base, results: [result('developer', 'blocked', '2026-11-12T09:00:00.000Z', {}, [{ description: 'no access', needs: 'access' }])] });
    assert.equal(block.kind, 'result');
    assert.equal(block.from, 'In progress');
    assert.deepEqual(block.blockers, [{ needs: 'access', description: 'no access' }]);
  });

  it('tells a failed entry check and a round limit apart', () => {
    assert.equal(classifyBlock({ ...base, results: [result('developer', 'done', '2026-11-12T09:00:00.000Z', { check_failed_for: 'Agent review' })] }).kind, 'check_failed');
    assert.equal(classifyBlock({ ...base, results: [result('reviewer', 'changes_needed', '2026-11-12T09:00:00.000Z')] }).kind, 'round_limit');
  });

  it('prefers a newer "Stage ended without a result" comment', () => {
    const body = '**Stage ended without a result.** The docs session for "Documentation" ended without calling `report_result`';
    const block = classifyBlock({
      ...base,
      results: [result('developer', 'blocked', '2026-11-12T08:00:00.000Z')],
      comments: [comment(body, '2026-11-12T09:00:00Z')],
    });
    assert.equal(block.kind, 'missing_result');
    assert.equal(block.from, 'Documentation');
    assert.equal(block.role, 'docs');
  });

  it('falls back to the last run of the repository log, else unknown', () => {
    const history = [{ ts: '2026-11-12T09:00:00Z', event: 'run_finished', fields: { issue: 'o/r#1', state: 'in progress', role: 'developer' } }];
    const block = classifyBlock({ ...base, results: [], history });
    assert.equal(block.kind, 'free_text');
    assert.equal(block.from, 'In progress');
    assert.equal(classifyBlock({ ...base, results: [] }).kind, 'unknown');
  });

  it('ignores a marker older than the block', () => {
    const block = classifyBlock({ ...base, results: [result('developer', 'blocked', '2026-11-01T09:00:00.000Z')], blockedAt: new Date('2026-11-12T09:00:00Z') });
    assert.equal(block.kind, 'unknown');
  });

  it('roleColumn names the active column a role serves', () => {
    assert.equal(roleColumn('reviewer', ROLES, ACTIVE), 'Agent review');
    assert.equal(roleColumn('nobody', ROLES, ACTIVE), null);
  });
});

describe('decide', () => {
  const now = new Date('2026-11-12T12:00:00Z');
  const diagnosis = (over: Partial<Diagnosis> = {}): Diagnosis => ({
    cause: 'infra_transient',
    evidence: ['githubstatus incident resolved 11:50'],
    cause_gone: true,
    comment: 'go on',
    target_column: 'In progress',
    confidence: 'high',
    ...over,
  });
  const input = (over: Partial<DecideInput> = {}): DecideInput => ({
    diagnosis: diagnosis(),
    block: { kind: 'result', from: 'In progress', role: 'developer', blockers: [], summary: '', checkFailedFor: null, commentUrl: null },
    entries: [],
    humanComments: [],
    config: { maxResumes: 2, cooldownMs: 600_000 },
    activeStates: ACTIVE,
    firstColumn: 'Ready',
    docsColumns: ['Documentation'],
    reviewColumns: ['Agent review'],
    blockedByAnalysis: false,
    docsPathRuleBroken: false,
    manualMerge: false,
    now,
    ...over,
  });
  const resumeAt = (at: string) => ({ marker: marker({ created_at: at }), comment: comment(encodeWatchdogMarker(marker()), at) });

  it('resumes a gone infrastructure cause into the recommended column', () => {
    assert.deepEqual(decide(input()), { action: 'resume', target: 'In progress', attempt: 1, reason: 'cause infra_transient is gone' });
  });

  it('waits while the outage holds, escalates human causes', () => {
    assert.equal(decide(input({ diagnosis: diagnosis({ cause_gone: false }) })).action, 'wait');
    for (const cause of ['needs_access', 'needs_human', 'round_limit', 'unknown'] as const) {
      assert.equal(decide(input({ diagnosis: diagnosis({ cause }) })).action, 'escalate', cause);
    }
  });

  it('needs high confidence for an answered question', () => {
    assert.equal(decide(input({ diagnosis: diagnosis({ cause: 'question_answered', confidence: 'medium' }) })).action, 'escalate');
    assert.equal(decide(input({ diagnosis: diagnosis({ cause: 'question_answered' }) })).action, 'resume');
  });

  it('escalates after max_resumes since the last human comment, which restarts the count', () => {
    const entries = [resumeAt('2026-11-12T09:00:00Z'), resumeAt('2026-11-12T10:00:00Z')];
    assert.equal(decide(input({ entries })).action, 'escalate');
    const human = [comment('please retry', '2026-11-12T10:30:00Z', 'cooolinho')];
    assert.equal(decide(input({ entries, humanComments: human })).action, 'resume');
  });

  it('waits for the cooldown', () => {
    assert.equal(decide(input({ entries: [resumeAt('2026-11-12T11:55:00Z')] })).action, 'wait');
  });

  it('guards the target column', () => {
    assert.equal(decide(input({ diagnosis: diagnosis({ target_column: 'Done' }) })).action, 'escalate');
    assert.equal(decide(input({ diagnosis: diagnosis({ target_column: 'Ready' }) })).action, 'escalate');
    assert.equal(decide(input({ diagnosis: diagnosis({ target_column: 'Ready' }), blockedByAnalysis: true })).action, 'resume');
    assert.equal(decide(input({ diagnosis: diagnosis({ target_column: 'Documentation' }), docsPathRuleBroken: true })).action, 'escalate');
    assert.equal(decide(input({ diagnosis: diagnosis({ target_column: 'Agent review', confidence: 'medium' }) })).action, 'escalate');
    assert.equal(decide(input({ diagnosis: diagnosis({ target_column: 'Agent review', confidence: 'medium' }), manualMerge: true })).action, 'resume');
  });

  it('falls back to the column the issue was blocked from', () => {
    const decision = decide(input({ diagnosis: diagnosis({ target_column: null }), block: { ...input().block, from: 'Testing' } }));
    assert.equal(decision.action === 'resume' && decision.target, 'Testing');
  });
});

describe('watchdog config', () => {
  const resolve = (watchdog: unknown) =>
    resolveConfig({ tracker: { kind: 'github_project' }, ...(watchdog === undefined ? {} : { watchdog }) }, { workflowPath: '/srv/wf/WORKFLOW.md', env: {}, trackerDefaults });

  it('has safe defaults', () => {
    const { watchdog } = resolve(undefined);
    assert.equal(watchdog.mode, 'observe');
    assert.equal(watchdog.maxResumes, 2);
    assert.equal(watchdog.model, 'fable');
    assert.equal(watchdog.prompt, '/srv/wf/roles/watchdog.md');
    assert.equal(watchdog.apiUrl, null);
  });

  it('reads every key and rejects unknown ones', () => {
    const { watchdog } = resolve({ mode: 'act', interval_ms: 5000, max_resumes: 1, api_url: 'http://symphony:4000/', claude: { model: 'opus', effort: 'max', max_budget_usd: 2 } });
    assert.equal(watchdog.mode, 'act');
    assert.equal(watchdog.apiUrl, 'http://symphony:4000');
    assert.equal(watchdog.model, 'opus');
    assert.equal(watchdog.maxBudgetUsd, 2);
    assert.throws(() => resolve({ bogus: 1 }), /watchdog\.bogus/);
    assert.throws(() => resolve({ mode: 'yolo' }), /watchdog\.mode/);
  });
});

describe('FileSink rotation', () => {
  it('rotates to <file>.1 past the size limit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-log-'));
    const file = path.join(dir, 'symphony.log');
    const sink = new FileSink(file, () => {}, 100);
    for (let i = 0; i < 5; i++) sink.write('x'.repeat(40));
    await sink.close();
    assert.equal(fs.existsSync(`${file}.1`), true);
    assert.ok(fs.statSync(file).size <= 100);
  });
});
