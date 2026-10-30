import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';
import { startHttpServer } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { collectActivity, type ActivitySource } from '../src/orchestrator/activity.ts';
import type { TimelineEvent } from '../src/orchestrator/orchestrator.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeIssue, makeWorkflow, tempDir, until } from './helpers.ts';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
let seq = 0;
const ev = (at: string, run: string | null, event = 'tool_use', kind: TimelineEvent['kind'] = 'agent'): TimelineEvent => ({
  seq: ++seq, at, kind, event, level: 'info', message: null, run, turn: 1, detail: null,
});

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

describe('collectActivity', () => {
  const sources = (): ActivitySource[] => [
    { identifier: 'acme/app#1', sessions: [{ run: 'r1', role: 'developer' }], timeline: [ev(ago(5), 'r1'), ev(ago(4), 'r1', 'message'), ev(ago(3), 'r1', 'x', 'lifecycle')] },
    { identifier: 'acme/app#2', sessions: [{ run: 'r2', role: 'reviewer' }], timeline: [ev(ago(31), 'r2'), ev(ago(10), 'r2')] },
  ];

  it('keeps the tool calls of the window, oldest first, with role and issue', () => {
    assert.deepEqual(collectActivity(sources(), NOW - 30 * 60_000, NOW), [
      { at: ago(10), role: 'reviewer', issue: 'acme/app#2' },
      { at: ago(5), role: 'developer', issue: 'acme/app#1' },
    ]);
  });

  it('falls back to symphony for an unknown run and counts an identifier once (first source wins)', () => {
    const live: ActivitySource = { identifier: 'acme/app#1', sessions: [], timeline: [ev(ago(2), 'unknown'), ev(ago(1), null)] };
    const snapshot: ActivitySource = { identifier: 'acme/app#1', sessions: [{ run: 'r1', role: 'developer' }], timeline: [ev(ago(2), 'r1'), ev(ago(1), 'r1')] };
    const out = collectActivity([live, snapshot], NOW - 30 * 60_000, NOW);
    assert.deepEqual(out.map((e) => e.role), ['symphony', 'symphony']);
  });
});

describe('GET /api/v1/activity', () => {
  it('serves the tool calls of a live issue, clamps minutes, allows only GET and loopback hosts', async () => {
    const runner = new FakeRunner((turn, params) => {
      for (const tool of ['A', 'B']) {
        params.onEvent({ event: 'tool_use', timestamp: new Date(), pid: 1, threadId: 't', turnId: '1', sessionId: 't-1', turnCount: turn, message: `${tool}: x`, detail: { tool } });
      }
      return new Promise(() => undefined);
    });
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: tempDir(),
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker([makeIssue({ id: 'live' })]),
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      await orchestrator.tickNow();
      await until(() => (orchestrator.issueTimeline('live')?.events ?? []).filter((e) => e.event === 'tool_use').length >= 2, 3_000, 'tool events');
      const res = await request(server.port, 'GET', '/api/v1/activity');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.minutes, 30);
      assert.ok(Number.isFinite(Date.parse(body.since)) && Number.isFinite(Date.parse(body.generated_at)));
      assert.deepEqual(body.events.map((e: { role: string; issue: string }) => [e.role, e.issue]), [['default', 'acme/app#live'], ['default', 'acme/app#live']]);
      assert.equal(JSON.parse((await request(server.port, 'GET', '/api/v1/activity?minutes=abc')).body).minutes, 30);
      assert.equal(JSON.parse((await request(server.port, 'GET', '/api/v1/activity?minutes=999')).body).minutes, 120);
      assert.equal((await request(server.port, 'POST', '/api/v1/activity')).status, 405);
      assert.equal((await request(server.port, 'GET', '/api/v1/activity', { host: 'evil.example:80' })).status, 403);
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });
});
