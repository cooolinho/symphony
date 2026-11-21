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
import { baseState, entryChecksOn, rollupChecks } from '../src/watchdog/base.ts';
import { decide, planRecheck, type BaseState, type DecideInput, type Diagnosis, type PriorDiagnosis } from '../src/watchdog/decide.ts';
import { decodeWatchdogMarker, encodeWatchdogMarker, isWatchdogResume, watchdogEntries, type WatchdogMarker } from '../src/watchdog/marker.ts';

const VIEWER = 'symphony-bot';
const ACTIVE = ['Ready', 'Design', 'In progress', 'Testing', 'Documentation', 'Agent review', 'Security review'];

function marker(over: Partial<WatchdogMarker> = {}): WatchdogMarker {
  return { action: 'resume', cause: 'infra_transient', target: 'In progress', attempt: 1, blocked_at: null, prompt_hash: 'abc', created_at: '2026-11-12T10:00:00.000Z', decision: 'resume', recheck: 0, base_sha: null, ...over };
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

  it('reads markers written before re-checks: decision from the action, re-check 0, no base head', () => {
    const old = { action: 'escalate', cause: 'environment', target: null, attempt: 0, blocked_at: null, prompt_hash: 'x', created_at: '2026-11-12T10:00:00.000Z' };
    const decoded = decodeWatchdogMarker(`<!-- symphony:watchdog:v1 ${Buffer.from(JSON.stringify(old)).toString('base64url')} -->`);
    assert.equal(decoded?.decision, 'escalate');
    assert.equal(decoded?.recheck, 0);
    assert.equal(decoded?.base_sha, null);
    const comment = decodeWatchdogMarker(`<!-- symphony:watchdog:v1 ${Buffer.from(JSON.stringify({ ...old, action: 'comment' })).toString('base64url')} -->`);
    assert.equal(comment?.decision, null);
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
    fixable_in_target: false,
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

  describe('fixable in the target column', () => {
    // bandenhub#337: a path-rule refusal after a human merged develop; the developer hands off again.
    const holds = (over: Partial<Diagnosis> = {}) => diagnosis({ cause: 'environment', cause_gone: false, fixable_in_target: true, target_column: 'In progress', ...over });

    it('resumes a cause that still holds when the target column can fix it with high confidence', () => {
      assert.deepEqual(decide(input({ diagnosis: holds() })), { action: 'resume', target: 'In progress', attempt: 1, reason: 'cause environment can be fixed in "In progress"' });
      assert.equal(decide(input({ diagnosis: holds({ cause: 'missing_result' }) })).action, 'resume');
    });

    it('escalates it below high confidence or when it is not fixable there', () => {
      assert.equal(decide(input({ diagnosis: holds({ confidence: 'medium' }) })).action, 'escalate');
      assert.deepEqual(decide(input({ diagnosis: holds({ fixable_in_target: false }) })), { action: 'escalate', reason: 'cause environment still holds' });
      assert.equal(decide(input({ diagnosis: holds({ target_column: null }) })).action, 'escalate');
      assert.equal(decide(input({ diagnosis: holds({ cause: 'infra_transient', fixable_in_target: false }) })).action, 'wait');
    });

    it('keeps the loop protection and the column rules', () => {
      const entries = [resumeAt('2026-11-12T09:00:00Z'), resumeAt('2026-11-12T10:00:00Z')];
      assert.equal(decide(input({ diagnosis: holds(), entries })).action, 'escalate');
      assert.equal(decide(input({ diagnosis: holds({ target_column: 'Ready' }) })).action, 'escalate');
    });

    it('never resumes the human causes', () => {
      for (const cause of ['needs_access', 'needs_human', 'unknown'] as const) {
        assert.equal(decide(input({ diagnosis: holds({ cause }) })).action, 'escalate', cause);
      }
    });

    it('resumes a round limit once per issue, only when fixable with high confidence', () => {
      const limit = (over: Partial<Diagnosis> = {}) => holds({ cause: 'round_limit', ...over });
      assert.equal(decide(input({ diagnosis: limit() })).action, 'resume');
      assert.equal(decide(input({ diagnosis: limit({ fixable_in_target: false }) })).action, 'escalate');
      assert.equal(decide(input({ diagnosis: limit({ confidence: 'medium' }) })).action, 'escalate');
      const earlier = { marker: marker({ cause: 'round_limit' }), comment: comment(encodeWatchdogMarker(marker({ cause: 'round_limit' })), '2026-11-10T10:00:00Z') };
      assert.deepEqual(decide(input({ diagnosis: limit(), entries: [earlier] })), { action: 'escalate', reason: 'a round limit was already resumed once on this issue' });
      const otherCause = { marker: marker({ cause: 'environment' }), comment: comment(encodeWatchdogMarker(marker()), '2026-11-10T10:00:00Z') };
      assert.equal(decide(input({ diagnosis: limit(), entries: [otherCause] })).action, 'resume');
    });
  });
});

describe('planRecheck', () => {
  const now = new Date('2026-11-21T12:00:00Z');
  const config = { maxRechecks: 2, cooldownMs: 600_000 };
  const prior = (over: Partial<PriorDiagnosis> = {}): PriorDiagnosis => ({
    decision: 'escalate',
    cause: 'environment',
    recheck: 0,
    baseSha: 'aaa111',
    at: new Date('2026-11-21T11:00:00Z'),
    ...over,
  });
  const base = (over: Partial<BaseState> = {}): BaseState => ({ branch: 'develop', sha: 'bbb222', checks: 'passed', ...over });
  const plan = (p: PriorDiagnosis | null, b: BaseState | null = base(), over: Partial<typeof config> = {}) => {
    let reads = 0;
    return planRecheck({ prior: p, config: { ...config, ...over }, now, readBase: async () => (reads++, b) }).then((result) => ({ ...result, reads }));
  };

  it('diagnoses a new block without reading the base', async () => {
    assert.deepEqual(await plan(null), { action: 'diagnose', recheck: 0, reason: 'first diagnosis of the block', reads: 0 });
  });

  it('re-checks an environment or infra escalation once the base moved', async () => {
    const result = await plan(prior());
    assert.equal(result.action, 'diagnose');
    assert.equal(result.action === 'diagnose' && result.recheck, 1);
    assert.match(result.reason, /develop moved from aaa111 to bbb222/);
    assert.equal((await plan(prior({ cause: 'infra_transient', recheck: 1 }))).action, 'diagnose');
  });

  it('does not re-check without a base change, a green base, or within the cooldown', async () => {
    assert.equal((await plan(prior(), base({ sha: 'aaa111' }))).action, 'later');
    assert.equal((await plan(prior(), base({ checks: 'failed' }))).action, 'later');
    assert.equal((await plan(prior(), base({ checks: 'pending' }))).action, 'later');
    assert.equal((await plan(prior(), null)).action, 'later');
    const fresh = await plan(prior({ at: new Date('2026-11-21T11:55:00Z') }));
    assert.deepEqual(fresh, { action: 'later', reason: 'cooldown since the last diagnosis', reads: 0 });
    assert.equal((await plan(prior(), base({ checks: 'unknown' }))).action, 'diagnose');
    // No head recorded (older diagnosis): only green checks are a reason.
    assert.equal((await plan(prior({ baseSha: null }), base({ checks: 'unknown' }))).action, 'later');
    assert.equal((await plan(prior({ baseSha: null }))).action, 'diagnose');
  });

  it('is final for other causes and decisions, and after max_rechecks', async () => {
    assert.equal((await plan(prior({ cause: 'needs_human' }))).action, 'final');
    assert.equal((await plan(prior({ decision: 'resume' }))).action, 'final');
    assert.equal((await plan(prior({ decision: null }))).action, 'final');
    const limit = await plan(prior({ recheck: 2 }));
    assert.deepEqual(limit, { action: 'final', reason: '2 re-checks done (watchdog.max_rechecks 2)', reads: 0 });
    assert.equal((await plan(prior(), base(), { maxRechecks: 0 })).action, 'final');
  });
});

describe('base branch checks', () => {
  const entry = (sha: string, ok: boolean, result = ok ? 'passed' : 'check_failed') => ({ ts: '2026-11-21T10:00:00Z', event: 'checks_finished', fields: { sha, ok: String(ok), result } });

  it('maps GitHub status rollups', () => {
    assert.equal(rollupChecks('SUCCESS'), 'passed');
    assert.equal(rollupChecks('FAILURE'), 'failed');
    assert.equal(rollupChecks('ERROR'), 'failed');
    assert.equal(rollupChecks('PENDING'), 'pending');
    assert.equal(rollupChecks(null), 'unknown');
  });

  it('falls back to Symphony entry checks on the base commit', () => {
    assert.equal(entryChecksOn([entry('abc', true), entry('def', false)], 'abc'), 'passed');
    assert.equal(entryChecksOn([entry('abc', true), entry('abc', false)], 'abc'), 'failed');
    assert.equal(entryChecksOn([entry('abc', false, 'skipped')], 'abc'), null);
    assert.equal(baseState({ branch: 'develop', sha: 'abc', rollup: 'unknown' }, [entry('abc', false)])?.checks, 'failed');
    assert.equal(baseState({ branch: 'develop', sha: 'abc', rollup: 'passed' }, [entry('abc', false)])?.checks, 'passed');
    assert.equal(baseState(null, []), null);
  });
});

describe('watchdog config', () => {
  const resolve = (watchdog: unknown) =>
    resolveConfig({ tracker: { kind: 'github_project' }, ...(watchdog === undefined ? {} : { watchdog }) }, { workflowPath: '/srv/wf/WORKFLOW.md', env: {}, trackerDefaults });

  it('has safe defaults', () => {
    const { watchdog } = resolve(undefined);
    assert.equal(watchdog.mode, 'observe');
    assert.equal(watchdog.maxResumes, 2);
    assert.equal(watchdog.maxRechecks, 2);
    assert.equal(watchdog.model, 'fable');
    assert.equal(watchdog.prompt, '/srv/wf/roles/watchdog.md');
    assert.equal(watchdog.apiUrl, null);
  });

  it('reads every key and rejects unknown ones', () => {
    const { watchdog } = resolve({ mode: 'act', interval_ms: 5000, max_resumes: 1, max_rechecks: 0, api_url: 'http://symphony:4000/', claude: { model: 'opus', effort: 'max', max_budget_usd: 2 } });
    assert.equal(watchdog.mode, 'act');
    assert.equal(watchdog.maxRechecks, 0);
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
