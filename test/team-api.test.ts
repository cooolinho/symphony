import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';
import { startHttpServer } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeIssue, makeWorkflow, tempDir, until } from './helpers.ts';

function request(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const make = (logDir: string, issues: ReturnType<typeof makeIssue>[], runner = new FakeRunner(() => new Promise(() => undefined))) =>
  new Orchestrator({
    workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
    runner,
    logger: Logger.silent(),
    env: {},
    logDir,
    timers: new ManualTimers(),
    createAdapter: () => new FakeTracker(issues),
  });

const teamPath = (id: string) => `/api/v1/${encodeURIComponent(`acme/app#${id}`)}/team`;

function writeArchive(logDir: string, id: string) {
  const s = (run: string, role: string, start: string, end: string, verdict: string, round: number) => ({
    run, attempt: null, role, state: 'x', model: 'sonnet', effort: null, started_at: `2026-10-03T${start}:00.000Z`, finished_at: `2026-10-03T${end}:00.000Z`, outcome: 'handed_off', verdict, round,
  });
  const stage = (sid: string, kind: string, columns: string[], status: string, sessions: unknown[] = []) => ({ id: sid, label: sid, kind, columns, status, sessions, verdict: null, round: null });
  const ev = (seq: number, run: string, at: string) => ({ seq, at: `2026-10-03T${at}:00.000Z`, kind: 'agent', event: 'tool_use', level: 'info', message: 'Bash: ls', run, turn: 1, detail: { tool: 'Bash' } });
  const pipeline = [
    stage('developer', 'agent', ['In progress'], 'done', [s('d1', 'developer', '10:00', '10:10', 'implemented', 1), s('d2', 'developer', '10:30', '10:40', 'implemented', 2)]),
    stage('reviewer', 'agent', ['Agent review'], 'done', [s('v1', 'reviewer', '10:11', '10:20', 'changes_needed', 1)]),
    stage('human:in review', 'human', ['In review'], 'active'),
    stage('terminal:done', 'terminal', ['Done'], 'pending'),
  ];
  fs.mkdirSync(path.join(logDir, 'issues'), { recursive: true });
  fs.writeFileSync(
    path.join(logDir, 'issues', `acme_app_${id}.json`),
    JSON.stringify({
      version: 2, pipeline, results: [], issue_id: id, issue_identifier: `acme/app#${id}`, issue_url: null, title: 'Old', repo: null, workspace_path: null, runs: 3, continuations: 0, last_error: null,
      archived_at: '2026-10-03T11:00:00.000Z', released: true, completed_before: false, timeline: [ev(1, 'd1', '10:01'), ev(2, 'd1', '10:02'), ev(3, 'v1', '10:12'), ev(4, 'd2', '10:31')], next_seq: 5, sessions: [], run_trace: null, last_check: null,
    }),
  );
}

describe('GET /api/v1/<id>/team', () => {
  it('serves a running issue: active session with recent tools, own block, only GET, loopback Host only', async () => {
    const runner = new FakeRunner((turn, params) => {
      for (const tool of ['A', 'B', 'C', 'D', 'E']) {
        params.onEvent({ event: 'tool_use', timestamp: new Date(), pid: 1, threadId: 't', turnId: '1', sessionId: 't-1', turnCount: turn, message: `${tool}: x`, detail: { tool } });
      }
      return new Promise(() => undefined);
    });
    const orchestrator = make(tempDir(), [makeIssue({ id: 'live' })], runner);
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      await orchestrator.tickNow();
      await until(() => (orchestrator.issueTimeline('live')?.events ?? []).filter((e) => e.event === 'tool_use').length >= 5, 3_000, 'tool events');
      const res = await request(server.port, 'GET', teamPath('live'));
      assert.equal(res.status, 200);
      const team = JSON.parse(res.body);
      assert.deepEqual(Object.keys(team).sort(), ['active', 'blocks', 'handoffs', 'seats', 'subagents']);
      assert.equal(team.active.role, 'default');
      assert.deepEqual(team.active.recent_tools.map((x: { tool: string }) => x.tool), ['B', 'C', 'D', 'E']);
      for (const key of ['action', 'context', 'turn', 'model', 'tokens', 'cost_usd']) assert.ok(key in team.active, key);
      assert.deepEqual(team.seats.map((x: { role: string }) => x.role), ['default', 'you']);
      assert.equal(team.seats[0].status, 'playing');
      assert.equal(team.blocks.length, 1);
      assert.equal(team.blocks[0].tool_calls, 5);
      assert.equal(team.blocks[0].ended_at, null);
      assert.deepEqual(team.handoffs, []);
      assert.deepEqual(Object.keys(team.subagents).sort(), ['finished', 'running']);
      // the same guards as the other API routes
      assert.equal((await request(server.port, 'GET', teamPath('live'), { host: 'evil.example:80' })).status, 403);
      const post = await request(server.port, 'POST', teamPath('live'));
      assert.equal(post.status, 405);
      assert.equal((await request(server.port, 'DELETE', teamPath('live'))).status, 405);
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });

  it('serves an archived issue with two rounds: blocks, handoffs, no active session, empty subagents', async () => {
    const logDir = tempDir();
    writeArchive(logDir, 'old');
    const orchestrator = make(logDir, []);
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      const res = await request(server.port, 'GET', teamPath('old'));
      assert.equal(res.status, 200);
      const team = JSON.parse(res.body);
      assert.equal(team.active, null);
      assert.deepEqual(team.subagents, { running: [], finished: [] });
      assert.deepEqual(team.blocks.map((b: { role: string; tool_calls: number; round: number }) => [b.role, b.round, b.tool_calls]), [
        ['developer', 1, 2],
        ['reviewer', 1, 1],
        ['developer', 2, 1],
      ]);
      assert.deepEqual(team.handoffs.map((h: { from: string; to: string; verdict: string }) => [h.from, h.to, h.verdict]), [
        ['developer', 'reviewer', 'implemented'],
        ['reviewer', 'developer', 'changes_needed'],
      ]);
      assert.deepEqual(team.seats.map((x: { role: string }) => x.role), ['developer', 'reviewer', 'you']);
      assert.equal(team.seats[0].status, 'done');
      assert.equal(team.seats.at(-1).status, 'waiting');
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });

  it('answers 404 issue_not_found for an unknown issue, like /timeline', async () => {
    const orchestrator = make(tempDir(), []);
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      const team = await request(server.port, 'GET', teamPath('nope'));
      const timeline = await request(server.port, 'GET', teamPath('nope').replace(/team$/, 'timeline'));
      assert.equal(team.status, 404);
      assert.equal(team.status, timeline.status);
      assert.equal(JSON.parse(team.body).error.code, 'issue_not_found');
      assert.equal(JSON.parse(team.body).error.code, JSON.parse(timeline.body).error.code);
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });
});
