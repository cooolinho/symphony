import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { startHttpServer, type HttpServerHandle } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, tempDir } from './helpers.ts';

/** Raw request so tests can set the Host header freely. */
function request(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('http extension', () => {
  let server: HttpServerHandle;
  const timers = new ManualTimers();

  before(async () => {
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
      runner: new FakeRunner(),
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers,
      createAdapter: () => new FakeTracker(),
    });
    server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
  });

  after(async () => {
    await server.close();
  });

  it('serves the dashboard and the state snapshot', async () => {
    const page = await request(server.port, 'GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>Symphony<\/title>/);

    const state = await request(server.port, 'GET', '/api/v1/state');
    assert.equal(state.status, 200);
    const body = JSON.parse(state.body);
    assert.deepEqual(Object.keys(body.counts), ['running', 'retrying', 'paused', 'claimed']);
    assert.deepEqual(Object.keys(body.agent_totals), ['input_tokens', 'output_tokens', 'total_tokens', 'seconds_running', 'cost_usd']);
    assert.ok(Array.isArray(body.running) && Array.isArray(body.retrying));
  });

  it('returns a JSON 404 for unknown issues and routes', async () => {
    const unknown = await request(server.port, 'GET', `/api/v1/${encodeURIComponent('acme/app#404')}`);
    assert.equal(unknown.status, 404);
    assert.equal(JSON.parse(unknown.body).error.code, 'issue_not_found');
    const route = await request(server.port, 'GET', '/nope');
    assert.equal(route.status, 404);
  });

  it('queues a refresh with 202 and coalesces repeats', async () => {
    const first = await request(server.port, 'POST', '/api/v1/refresh');
    assert.equal(first.status, 202);
    assert.deepEqual(JSON.parse(first.body).operations, ['poll', 'reconcile']);
    const second = await request(server.port, 'POST', '/api/v1/refresh');
    assert.equal(JSON.parse(second.body).coalesced, true);
    assert.ok(timers.delays().includes(0));
  });

  it('rejects unsupported methods, foreign Host headers and cross-origin refreshes', async () => {
    const wrongMethod = await request(server.port, 'DELETE', '/api/v1/state');
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.allow, 'GET');
    const rebinding = await request(server.port, 'GET', '/api/v1/state', { host: 'evil.example:80' });
    assert.equal(rebinding.status, 403);
    const crossOrigin = await request(server.port, 'POST', '/api/v1/refresh', { origin: 'https://evil.example' });
    assert.equal(crossOrigin.status, 403);
  });
});
