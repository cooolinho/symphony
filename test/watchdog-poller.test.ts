import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { AgentRunner, StartSessionParams } from '../src/agent/types.ts';
import { Logger } from '../src/log.ts';
import { humanFeedback } from '../src/orchestrator/stage-history.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import type { Issue, IssueComment, TrackerAdapter } from '../src/tracker/types.ts';
import { resolveConfig, type WatchdogMode } from '../src/workflow/config.ts';
import type { BaseReader } from '../src/watchdog/base.ts';
import type { Diagnosis } from '../src/watchdog/decide.ts';
import { decodeWatchdogMarker } from '../src/watchdog/marker.ts';
import { WatchdogPoller } from '../src/watchdog/poller.ts';

const VIEWER = 'symphony-bot';
const NOW = new Date('2026-11-12T12:00:00Z');
const MISSING = '**Stage ended without a result.** The developer session for "In progress" ended without calling `report_result` (after 20 turns)';

interface SetupOptions {
  readBase?: BaseReader | null;
  clock?: { now: Date };
  watchdog?: Record<string, unknown>;
}

function setup(
  mode: WatchdogMode,
  diagnosis: Partial<Diagnosis> = {},
  promptText = 'Diagnose {{ issue.identifier }}: {{ block.kind }} from {{ block.from }}',
  reuseDir?: string,
  options: SetupOptions = {},
) {
  const dir = reuseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-watchdog-'));
  const prompt = path.join(dir, 'watchdog.md');
  fs.writeFileSync(prompt, promptText);
  const config = resolveConfig(
    {
      tracker: { kind: 'github_project', active_states: ['Ready', 'In progress', 'Agent review'], terminal_states: ['Done'] },
      workspace: { root: path.join(dir, 'workspaces') },
      watchdog: { mode, prompt, settle_ms: 0, ...options.watchdog },
    },
    { workflowPath: path.join(dir, 'WORKFLOW.md'), env: {}, trackerDefaults },
  );
  const issue: Issue = {
    id: 'item-1',
    native_ref: { status_updated_at: '2026-11-12T11:00:00.000Z' },
    identifier: 'o/r#7',
    title: 'Fix it',
    description: 'desc',
    priority: null,
    state: 'Blocked',
    branch_name: null,
    url: 'https://example.test/7',
    assignee_id: null,
    labels: [],
    blocked_by: [],
    dispatchable: true,
    created_at: null,
    updated_at: null,
  };
  const comments: IssueComment[] = [{ author: VIEWER, body: MISSING, createdAt: new Date('2026-11-12T11:00:00Z'), url: 'https://example.test/c1' }];
  const moves: string[] = [];
  const labels: string[] = [];
  const adapter = {
    kind: 'fake',
    fetchIssuesByStates: async () => [issue],
    fetchIssuesByIds: async () => [issue],
    agentToolSpecs: () => [],
    issueRepository: () => 'o/r',
    readComments: async () => [...comments],
    viewerLogin: async () => VIEWER,
    readResults: async () => [],
    postComment: async (_issue: Issue, body: string) => {
      comments.push({ author: VIEWER, body, createdAt: new Date(options.clock?.now ?? NOW), url: `https://example.test/c${comments.length + 1}` });
      return { url: null };
    },
    setStatus: async (_issue: Issue, column: string) => {
      moves.push(column);
      return { previous: 'Blocked', status: column };
    },
    addLabels: async (_issue: Issue, names: string[]) => {
      labels.push(...names);
      return { added: names, created: [], unknown: [] };
    },
  } satisfies TrackerAdapter;
  const prompts: string[] = [];
  const sessions: StartSessionParams[] = [];
  const runner: AgentRunner = {
    startSession: async (params) => {
      sessions.push(params);
      return {
        threadId: 't',
        pid: null,
        runTurn: async (text) => {
          prompts.push(text);
          const tool = params.tools.find((spec) => spec.name === 'report_diagnosis');
          await tool?.execute(
            { cause: 'missing_result', evidence: ['commits pushed'], cause_gone: true, comment: 'Finish the result.', target_column: 'In progress', confidence: 'high', ...diagnosis },
            params.toolContext(),
          );
          params.onEvent({ event: 'turn_completed', timestamp: new Date(), pid: null, threadId: 't', turnId: '1', sessionId: 't-1', turnCount: 1, costUsd: 0.42 });
          return { ok: true, turnId: '1', resultText: '' };
        },
        stop: async () => {},
      };
    },
  };
  const poller = new WatchdogPoller({
    config: () => config,
    adapter,
    runner,
    logger: Logger.silent(),
    env: { GITHUB_TOKEN: 'secret', PATH: '/bin' },
    secretNames: ['GITHUB_TOKEN'],
    logDir: path.join(dir, 'state'),
    stateDir: path.join(dir, 'watchdog'),
    fetch: (async () => new Response('{}', { status: 503 })) as typeof fetch,
    now: () => options.clock?.now ?? NOW,
    readBase: options.readBase ?? null,
  });
  return { poller, issue, config, comments, moves, labels, prompts, sessions, dir };
}

describe('WatchdogPoller', () => {
  it('diagnoses a stage without result, comments with a marker and moves it back (mode act)', async () => {
    const t = setup('act');
    const event = await t.poller.handle(t.issue, t.config);
    assert.equal(event?.decision, 'resume');
    assert.equal(event?.cost_usd, 0.42);
    assert.deepEqual(t.moves, ['In progress']);
    assert.equal(t.prompts[0], 'Diagnose o/r#7: missing_result from In progress');
    const posted = t.comments.at(-1)?.body ?? '';
    assert.match(posted, /Finish the result\./);
    assert.equal(decodeWatchdogMarker(posted)?.action, 'resume');
    assert.equal(decodeWatchdogMarker(posted)?.blocked_at, '2026-11-12T11:00:00.000Z');
    // The session never sees the tracker token, and only gets read tools.
    assert.equal(t.sessions[0]?.env.GITHUB_TOKEN, undefined);
    assert.deepEqual(t.sessions[0]?.config.allowedTools, ['Read', 'Grep', 'Glob']);
    assert.equal(t.sessions[0]?.config.permissionMode, 'dontAsk');
    assert.equal(t.sessions[0]?.config.model, 'fable');
    // The events log has the decision.
    const events = fs.readFileSync(path.join(t.dir, 'watchdog', 'events.jsonl'), 'utf8').trim().split('\n');
    assert.equal(JSON.parse(events[0] ?? '{}').decision, 'resume');
  });

  it('handles one block once, also after a restart (marker on the issue)', async () => {
    const t = setup('act');
    await t.poller.handle(t.issue, t.config);
    assert.equal(await t.poller.handle(t.issue, t.config), null);
    const again = setup('act');
    again.comments.push(...t.comments.slice(1));
    assert.equal(await again.poller.handle(again.issue, again.config), null);
    assert.equal(again.sessions.length, 0);
  });

  it('the resume comment reaches the next agent as human feedback', async () => {
    const t = setup('act');
    await t.poller.handle(t.issue, t.config);
    const blocking = {
      result: { schema: 'symphony.result/v1', kind: 'implementation', verdict: 'blocked', summary: 's', blockers: [], follow_ups: [] },
      meta: { role: 'developer', run: 'r', round: null, profile: null, workflow_hash: null, head_sha: null, checks: null, target: 'Blocked', created_at: '2026-11-12T10:00:00.000Z' },
    } as unknown as Parameters<typeof humanFeedback>[2][number];
    const feedback = humanFeedback(t.comments, VIEWER, [blocking]);
    assert.equal(feedback.length, 1);
    assert.match(feedback[0]?.body ?? '', /Finish the result/);
  });

  it('escalates a human cause with the limit label and does not move', async () => {
    const t = setup('act', { cause: 'needs_access', cause_gone: false, target_column: null });
    const event = await t.poller.handle(t.issue, t.config);
    assert.equal(event?.decision, 'escalate');
    assert.deepEqual(t.moves, []);
    assert.deepEqual(t.labels, ['needs-human']);
    assert.equal(decodeWatchdogMarker(t.comments.at(-1)?.body ?? '')?.action, 'escalate');
  });

  it('mode comment posts the diagnosis but moves nothing; mode observe writes nothing', async () => {
    const comment = setup('comment');
    await comment.poller.handle(comment.issue, comment.config);
    assert.deepEqual(comment.moves, []);
    assert.equal(decodeWatchdogMarker(comment.comments.at(-1)?.body ?? '')?.action, 'comment');
    const observe = setup('observe');
    const event = await observe.poller.handle(observe.issue, observe.config);
    assert.equal(event?.decision, 'resume');
    assert.equal(observe.comments.length, 1);
    assert.deepEqual(observe.moves, []);
  });

  it('remembers observed blocks across a restart, but acts on them after a switch to act', async () => {
    const first = setup('observe');
    assert.equal((await first.poller.handle(first.issue, first.config))?.decision, 'resume');
    assert.equal(JSON.parse(fs.readFileSync(path.join(first.dir, 'watchdog', 'events.jsonl'), 'utf8').trim()).mode, 'observe');
    const restarted = setup('observe', {}, undefined, first.dir);
    assert.equal(await restarted.poller.handle(restarted.issue, restarted.config), null);
    assert.equal(restarted.sessions.length, 0);
    const acting = setup('act', {}, undefined, first.dir);
    assert.equal((await acting.poller.handle(acting.issue, acting.config))?.decision, 'resume');
    assert.deepEqual(acting.moves, ['In progress']);
  });

  it('does not remember a failed session or a wait across a restart', async () => {
    const first = setup('observe', { cause: 'infra_transient', cause_gone: false });
    assert.equal((await first.poller.handle(first.issue, first.config))?.decision, 'wait');
    const restarted = setup('observe', {}, undefined, first.dir);
    assert.equal((await restarted.poller.handle(restarted.issue, restarted.config))?.decision, 'resume');
  });

  it('a prompt that does not render fails the diagnosis before a session starts', async () => {
    const t = setup('act', {}, '{{ no_such_variable }}');
    await assert.rejects(() => t.poller.handle(t.issue, t.config), /template/);
    assert.equal(t.sessions.length, 0);
  });

  it('renders the shipped roles/watchdog.md', async () => {
    const t = setup('act', {}, fs.readFileSync(path.join(import.meta.dirname, '..', 'roles', 'watchdog.md'), 'utf8'));
    await t.poller.handle(t.issue, t.config);
    assert.match(t.prompts[0] ?? '', /## Your role: Blocked watchdog/);
    assert.match(t.prompts[0] ?? '', /How it was blocked: \*\*missing_result\*\* by the role `developer`, from the column "In progress"/);
  });
  describe('re-check of an environment escalation', () => {
    const BROKEN: Partial<Diagnosis> = { cause: 'environment', cause_gone: false, target_column: null, comment: 'The test env on develop is broken.' };
    const FIXED: Partial<Diagnosis> = { cause: 'environment', cause_gone: true, target_column: 'In progress', comment: 'develop is fixed, run the tests again.' };

    function scenario(mode: WatchdogMode = 'act', watchdog: Record<string, unknown> = {}, reuseDir?: string) {
      const diagnosis: Partial<Diagnosis> = { ...BROKEN };
      const clock = { now: new Date(NOW) };
      const head = { sha: 'aaaaaaa1111', rollup: 'failed' as 'passed' | 'failed' | 'pending' | 'unknown' };
      let reads = 0;
      const readBase: BaseReader = async (_repo, branch) => {
        reads += 1;
        return { branch: branch ?? 'develop', sha: head.sha, rollup: head.rollup };
      };
      const t = setup(mode, diagnosis, undefined, reuseDir, { readBase, clock, watchdog });
      const later = (minutes: number) => {
        clock.now = new Date(clock.now.getTime() + minutes * 60_000);
      };
      return { ...t, diagnosis, clock, head, later, reads: () => reads };
    }

    it('records the base head with an escalation and does not re-check while the base has not moved', async () => {
      const t = scenario();
      const first = await t.poller.handle(t.issue, t.config);
      assert.equal(first?.decision, 'escalate');
      assert.equal(first?.recheck, 0);
      assert.equal(first?.base_sha, 'aaaaaaa1111');
      const marker = decodeWatchdogMarker(t.comments.at(-1)?.body ?? '');
      assert.equal(marker?.decision, 'escalate');
      assert.equal(marker?.base_sha, 'aaaaaaa1111');
      assert.match(t.comments.at(-1)?.body ?? '', /re-checked once `develop` moves \(2 left\)/);
      Object.assign(t.diagnosis, FIXED);
      t.head.rollup = 'passed';
      t.later(30);
      assert.equal(await t.poller.handle(t.issue, t.config), null);
      assert.equal(t.sessions.length, 1);
      assert.deepEqual(t.moves, []);
    });

    it('re-checks once the base branch moved and its checks are green, and resumes', async () => {
      const t = scenario();
      await t.poller.handle(t.issue, t.config);
      Object.assign(t.diagnosis, FIXED);
      t.head.sha = 'bbbbbbb2222';
      t.head.rollup = 'passed';
      t.later(30);
      const event = await t.poller.handle(t.issue, t.config);
      assert.equal(event?.decision, 'resume');
      assert.equal(event?.recheck, 1);
      assert.equal(event?.base_sha, 'bbbbbbb2222');
      assert.deepEqual(t.moves, ['In progress']);
      assert.equal(decodeWatchdogMarker(t.comments.at(-1)?.body ?? '')?.recheck, 1);
      assert.match(t.comments.at(-1)?.body ?? '', /re-check 1\/2/);
    });

    it('waits while the new base head is red or its checks still run, and within the cooldown', async () => {
      const t = scenario();
      await t.poller.handle(t.issue, t.config);
      t.head.sha = 'bbbbbbb2222';
      t.later(5);
      assert.equal(await t.poller.handle(t.issue, t.config), null, 'cooldown');
      t.later(30);
      assert.equal(await t.poller.handle(t.issue, t.config), null, 'red');
      t.head.rollup = 'pending';
      t.later(30);
      assert.equal(await t.poller.handle(t.issue, t.config), null, 'pending');
      assert.equal(t.sessions.length, 1);
      t.head.rollup = 'unknown';
      t.later(30);
      assert.equal((await t.poller.handle(t.issue, t.config))?.recheck, 1, 'no signal: the moved head alone is the reason');
    });

    it('stops after watchdog.max_rechecks follow-up diagnoses', async () => {
      const t = scenario('act', { max_rechecks: 1 });
      await t.poller.handle(t.issue, t.config);
      t.head.sha = 'bbbbbbb2222';
      t.head.rollup = 'passed';
      t.later(30);
      const second = await t.poller.handle(t.issue, t.config);
      assert.equal(second?.decision, 'escalate');
      assert.equal(second?.recheck, 1);
      assert.doesNotMatch(t.comments.at(-1)?.body ?? '', /re-checked once/);
      t.head.sha = 'ccccccc3333';
      t.later(30);
      assert.equal(await t.poller.handle(t.issue, t.config), null);
      assert.equal(t.sessions.length, 2);
    });

    it('max_rechecks 0 keeps one diagnosis per block', async () => {
      const t = scenario('act', { max_rechecks: 0 });
      await t.poller.handle(t.issue, t.config);
      t.head.sha = 'bbbbbbb2222';
      t.head.rollup = 'passed';
      t.later(30);
      assert.equal(await t.poller.handle(t.issue, t.config), null);
      assert.equal(t.reads(), 1, 'no base read once the block is settled');
    });

    it('never re-checks a human cause', async () => {
      const t = scenario();
      Object.assign(t.diagnosis, { cause: 'needs_access' });
      await t.poller.handle(t.issue, t.config);
      t.head.sha = 'bbbbbbb2222';
      t.head.rollup = 'passed';
      t.later(30);
      assert.equal(await t.poller.handle(t.issue, t.config), null);
      assert.equal(t.sessions.length, 1);
    });

    it('counts re-checks across a restart, from the markers (act) and from events.jsonl (observe)', async () => {
      const act = scenario('act', { max_rechecks: 1 });
      await act.poller.handle(act.issue, act.config);
      act.head.sha = 'bbbbbbb2222';
      act.head.rollup = 'passed';
      act.later(30);
      assert.equal((await act.poller.handle(act.issue, act.config))?.recheck, 1);
      // A new process sees only the comments: both diagnoses are there, the limit is reached.
      const restarted = scenario('act', { max_rechecks: 1 });
      restarted.comments.push(...act.comments.slice(1));
      restarted.head.sha = 'ccccccc3333';
      restarted.head.rollup = 'passed';
      restarted.later(120);
      assert.equal(await restarted.poller.handle(restarted.issue, restarted.config), null);
      assert.equal(restarted.sessions.length, 0);

      const observe = scenario('observe');
      await observe.poller.handle(observe.issue, observe.config);
      const again = scenario('observe', {}, observe.dir);
      again.later(30);
      assert.equal(await again.poller.handle(again.issue, again.config), null, 'base unchanged after the restart');
      again.head.sha = 'bbbbbbb2222';
      again.head.rollup = 'passed';
      again.later(30);
      assert.equal((await again.poller.handle(again.issue, again.config))?.recheck, 1);
    });

    it('the shipped roles/watchdog.md tells the session about the re-check', async () => {
      const shipped = fs.readFileSync(path.join(import.meta.dirname, '..', 'roles', 'watchdog.md'), 'utf8');
      const diagnosis: Partial<Diagnosis> = { ...BROKEN };
      const clock = { now: new Date(NOW) };
      const head = { sha: 'aaaaaaa1111' };
      const t = setup('act', diagnosis, shipped, undefined, { clock, readBase: async () => ({ branch: 'develop', sha: head.sha, rollup: 'passed' }) });
      await t.poller.handle(t.issue, t.config);
      assert.match(t.prompts[0] ?? '', /Base branch: `develop` at aaaaaaa1111 \(checks: passed\)/);
      assert.doesNotMatch(t.prompts[0] ?? '', /Re-check/);
      head.sha = 'bbbbbbb2222';
      clock.now = new Date(NOW.getTime() + 30 * 60_000);
      await t.poller.handle(t.issue, t.config);
      assert.match(t.prompts[1] ?? '', /\*\*Re-check 1 of 2\.\*\* An earlier diagnosis of this block escalated with the cause `environment`; since then develop moved from aaaaaaa to bbbbbbb/);
    });

    it('re-checks an escalation written before re-checks existed only on green base checks', async () => {
      const t = scenario();
      const legacy = { action: 'escalate', cause: 'environment', target: null, attempt: 0, blocked_at: '2026-11-12T11:00:00.000Z', prompt_hash: 'old', created_at: '2026-11-12T11:05:00.000Z' };
      t.comments.push({ author: VIEWER, body: `old\n<!-- symphony:watchdog:v1 ${Buffer.from(JSON.stringify(legacy)).toString('base64url')} -->`, createdAt: new Date('2026-11-12T11:05:00Z'), url: 'https://example.test/old' });
      assert.equal(await t.poller.handle(t.issue, t.config), null, 'red base');
      t.head.rollup = 'passed';
      t.later(30);
      Object.assign(t.diagnosis, FIXED);
      const event = await t.poller.handle(t.issue, t.config);
      assert.equal(event?.recheck, 1);
      assert.deepEqual(t.moves, ['In progress']);
    });
  });
});
