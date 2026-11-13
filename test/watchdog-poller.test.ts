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
import type { Diagnosis } from '../src/watchdog/decide.ts';
import { decodeWatchdogMarker } from '../src/watchdog/marker.ts';
import { WatchdogPoller } from '../src/watchdog/poller.ts';

const VIEWER = 'symphony-bot';
const NOW = new Date('2026-11-12T12:00:00Z');
const MISSING = '**Stage ended without a result.** The developer session for "In progress" ended without calling `report_result` (after 20 turns)';

function setup(mode: WatchdogMode, diagnosis: Partial<Diagnosis> = {}, promptText = 'Diagnose {{ issue.identifier }}: {{ block.kind }} from {{ block.from }}', reuseDir?: string) {
  const dir = reuseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-watchdog-'));
  const prompt = path.join(dir, 'watchdog.md');
  fs.writeFileSync(prompt, promptText);
  const config = resolveConfig(
    {
      tracker: { kind: 'github_project', active_states: ['Ready', 'In progress', 'Agent review'], terminal_states: ['Done'] },
      workspace: { root: path.join(dir, 'workspaces') },
      watchdog: { mode, prompt, settle_ms: 0 },
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
      comments.push({ author: VIEWER, body, createdAt: new Date(NOW), url: `https://example.test/c${comments.length + 1}` });
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
    now: () => NOW,
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
});
