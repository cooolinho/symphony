import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { RateLimitRecord } from '../src/budget/rate-limit-log.ts';
import { startHttpServer, type HttpServerHandle } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, tempDir } from './helpers.ts';

// GET /api/v1/budget/five-hour (#605): the 5-hour utilisation over time next to the unchanged /api/v1/budget.

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date('2026-11-24T12:00:00Z');
const unix = (ms: number) => Math.floor((NOW.getTime() + ms) / 1000);
const five = (ago: number, u: number, reset: number, status = 'allowed'): RateLimitRecord => ({
  at: new Date(NOW.getTime() - ago).toISOString(), run_id: 'r1', issue: 'acme/app#9', role: 'developer', model: null,
  rate_limit_info: { rateLimitType: 'five_hour', status, resetsAt: unix(reset), unifiedWindows: { five_hour: { utilization: u, resetsAt: unix(reset) } } },
});

function raw(port: number, method: string, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GET /api/v1/budget/five-hour', () => {
  let server: HttpServerHandle;

  before(async () => {
    const logDir = tempDir();
    fs.mkdirSync(path.join(logDir, 'budget'));
    const lines = [
      five(20 * HOUR, 0.4, -16 * HOUR), five(17 * HOUR, 1.1, -16 * HOUR, 'rejected'),
      five(4 * HOUR, 0.2, 1 * HOUR), five(20 * MIN, 0.7, 1 * HOUR), five(0, 0.8, 1 * HOUR),
    ];
    fs.writeFileSync(path.join(logDir, 'budget', 'rate-limits.jsonl'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
    const clock = new ManualClock();
    clock.wall = NOW.getTime();
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))), runner: new FakeRunner(), logger: Logger.silent(), env: {},
      logDir, clock, timers: new ManualTimers(), createAdapter: () => new FakeTracker(),
    });
    server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
  });
  after(async () => {
    await server.close();
  });

  it('answers 200 for window, day and week with the range echoed', async () => {
    const counts: Record<string, number> = {};
    for (const range of ['window', 'day', 'week']) {
      const res = await raw(server.port, 'GET', `/api/v1/budget/five-hour?range=${range}`);
      assert.equal(res.status, 200, range);
      const body = JSON.parse(res.body);
      assert.equal(body.range, range);
      assert.ok(Array.isArray(body.windows));
      assert.equal(typeof body.summary.windows, 'number');
      counts[range] = body.windows.length;
    }
    assert.deepEqual(counts, { window: 1, day: 2, week: 2 });
  });

  it('day reports the over-limit window and its pause', async () => {
    const body = JSON.parse((await raw(server.port, 'GET', '/api/v1/budget/five-hour?range=day')).body);
    assert.deepEqual(body.summary, { windows: 2, over_limit: 1, paused_min: 60 });
    assert.equal(body.windows[0].peak.percent, 110);
  });

  it('without range it answers the current window', async () => {
    const body = JSON.parse((await raw(server.port, 'GET', '/api/v1/budget/five-hour')).body);
    assert.equal(body.range, 'window');
    assert.equal(body.to, new Date(unix(1 * HOUR) * 1000).toISOString());
  });

  it('an invalid range answers 400 bad_request', async () => {
    for (const range of ['month', 'WINDOW', '1']) {
      const res = await raw(server.port, 'GET', `/api/v1/budget/five-hour?range=${range}`);
      assert.equal(res.status, 400, range);
      assert.equal(JSON.parse(res.body).error.code, 'bad_request');
    }
  });

  it('rejects methods other than GET with 405', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await raw(server.port, method, '/api/v1/budget/five-hour?range=day')).status, 405, method);
  });

  it('/api/v1/budget keeps its format and shares forecast.eta with the window series', async () => {
    const budget = JSON.parse((await raw(server.port, 'GET', '/api/v1/budget')).body);
    assert.deepEqual(Object.keys(budget).sort(), ['five_hour', 'generated_at', 'seven_day']);
    const series = JSON.parse((await raw(server.port, 'GET', '/api/v1/budget/five-hour?range=window')).body);
    assert.equal(typeof budget.five_hour.forecast.eta, 'string');
    assert.equal(series.forecast.eta, budget.five_hour.forecast.eta);
  });
});
