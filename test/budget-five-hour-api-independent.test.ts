import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startHttpServer, type HttpServerHandle } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import type { RateLimitRecord } from '../src/budget/rate-limit-log.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, tempDir } from './helpers.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const now = new Date('2026-10-30T12:00:00Z');
const secs = (offset: number) => Math.floor((now.getTime() + offset) / 1000);
const sdk = (offset: number, utilization: number, resetOffset: number): RateLimitRecord => ({
  at: new Date(now.getTime() + offset).toISOString(), run_id: 'r', issue: 'acme/app#1', role: 'developer', model: null,
  rate_limit_info: { rateLimitType: 'five_hour', status: 'allowed', unifiedWindows: { five_hour: { utilization, resetsAt: secs(resetOffset) } } },
});

function get(port: number, method: string, urlPath: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
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
      sdk(-30 * HOUR, 0.9, -26 * HOUR), // outside day
      sdk(-10 * HOUR, 1.12, -6 * HOUR), // previous window, over the limit
      sdk(-20 * MIN, 0.5, 2 * HOUR),
      sdk(-10 * MIN, 0.6, 2 * HOUR),
    ];
    fs.writeFileSync(path.join(logDir, 'budget', 'rate-limits.jsonl'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
    const clock = new ManualClock();
    clock.wall = now.getTime();
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))), runner: new FakeRunner(), logger: Logger.silent(), env: {},
      logDir, clock, timers: new ManualTimers(), createAdapter: () => new FakeTracker(),
    });
    server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
  });

  after(async () => {
    await server.close();
  });

  const json = async (query: string) => {
    const res = await get(server.port, 'GET', `/api/v1/budget/five-hour${query}`);
    assert.equal(res.status, 200, res.body);
    assert.match(String(res.headers['content-type']), /application\/json/);
    return JSON.parse(res.body);
  };

  it('answers range=window with the 5 h window up to the reset and a forecast', async () => {
    const body = await json('?range=window');
    assert.equal(body.range, 'window');
    assert.equal(body.now, now.toISOString());
    assert.equal(body.from, new Date(now.getTime() - 3 * HOUR).toISOString());
    assert.equal(body.to, new Date(now.getTime() + 2 * HOUR).toISOString());
    assert.equal(body.percent_source, 'sdk');
    assert.equal(body.windows.length, 1);
    assert.deepEqual(body.windows[0].points.map((p: { percent: number }) => p.percent), [50, 60]);
    assert.equal(body.windows[0].current, true);
    assert.ok(body.forecast);
    assert.deepEqual(Object.keys(body).sort(), ['forecast', 'from', 'now', 'percent_source', 'range', 'summary', 'to', 'windows']);
  });

  it('without range the answer is the window range', async () => {
    const body = await json('');
    assert.equal(body.range, 'window');
    assert.deepEqual(body, await json('?range=window'));
  });

  it('answers range=day with every window of the last 24 h and no forecast', async () => {
    const body = await json('?range=day');
    assert.equal(body.range, 'day');
    assert.equal(body.from, new Date(now.getTime() - 24 * HOUR).toISOString());
    assert.equal(body.to, now.toISOString());
    assert.equal(body.forecast, null);
    assert.deepEqual(body.windows.map((w: { points: { percent: number }[] }) => w.points.map((p) => p.percent)), [[112], [50, 60]]);
    assert.deepEqual(body.windows.map((w: { over_limit: boolean }) => w.over_limit), [true, false]);
    assert.deepEqual(body.summary, { windows: 2, over_limit: 1, paused_min: 0 });
  });

  it('answers range=week with the last 7 days and no forecast', async () => {
    const body = await json('?range=week');
    assert.equal(body.range, 'week');
    assert.equal(body.from, new Date(now.getTime() - 7 * 24 * HOUR).toISOString());
    assert.equal(body.forecast, null);
    assert.equal(body.windows.length, 3);
    assert.equal(body.summary.windows, 3);
  });

  it('the eta equals the one of /api/v1/budget; that endpoint keeps its format', async () => {
    const budget = JSON.parse((await get(server.port, 'GET', '/api/v1/budget')).body);
    assert.deepEqual(Object.keys(budget).sort(), ['five_hour', 'generated_at', 'seven_day']);
    assert.equal(budget.five_hour.window, 'five_hour');
    assert.equal(budget.five_hour.percent, 60);
    assert.equal(budget.five_hour.percent_source, 'sdk');
    assert.ok(budget.five_hour.forecast?.eta, 'the fixture has an eta');
    const body = await json('?range=window');
    assert.equal(body.forecast.eta, budget.five_hour.forecast.eta);
    assert.equal(body.forecast.eta, new Date(now.getTime() + 40 * MIN).toISOString());
  });

  it('rejects an invalid range with 400 bad_request', async () => {
    for (const query of ['?range=hour', '?range=7d', '?range=DAY']) {
      const res = await get(server.port, 'GET', `/api/v1/budget/five-hour${query}`);
      assert.equal(res.status, 400, query);
      assert.deepEqual(JSON.parse(res.body), { error: { code: 'bad_request', message: 'range must be window, day or week' } }, query);
    }
  });

  it('allows GET only', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      assert.equal((await get(server.port, method, '/api/v1/budget/five-hour?range=window')).status, 405, method);
    }
  });
});

describe('five-hour endpoint documentation', () => {
  it('is listed in the endpoint comment of server.ts and in docs/usage.md', () => {
    const root = path.resolve(import.meta.dirname, '..');
    for (const file of ['src/http/server.ts', 'docs/usage.md']) {
      assert.ok(fs.readFileSync(path.join(root, file), 'utf8').includes('/api/v1/budget/five-hour'), file);
    }
  });
});
