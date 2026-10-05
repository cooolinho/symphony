import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { PricingStore } from '../src/costs/pricing.ts';
import { HistoryLog } from '../src/history/history.ts';
import { startHttpServer, type HttpServerHandle } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeIssue, makeWorkflow, tempDir, until } from './helpers.ts';

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
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
    const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
    const historyLog = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
    historyLog.runFinished({
      repo: 'acme/app', issue: 'acme/app#1', title: 'First', run: 'r1', session: null, attempt: null, outcome: 'handed_off',
      state: 'In review', reason: 'done', turns: 1, startedAt: new Date('2026-10-04T08:00:00Z'), finishedAt: new Date('2026-10-04T08:01:00Z'),
      agentSeconds: 60, usage: { 'claude-opus-5-5': { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 } }, claudeEstimateUsd: null,
    });
    historyLog.note('other/repo', 'workspace_removed', { issue: 'other/repo#2', state: 'Done' });
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
      runner: new FakeRunner(),
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers,
      createAdapter: () => new FakeTracker(),
    });
    server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent(), history: { dir: historyLog.dir, pricing } });
  });

  after(async () => {
    await server.close();
  });

  it('serves the dashboard and the state snapshot', async () => {
    const page = await request(server.port, 'GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>Symphony<\/title>/);
    assert.match(page.body, /label: 'Role', render: \(r\) => r\.role/);

    const state = await request(server.port, 'GET', '/api/v1/state');
    assert.equal(state.status, 200);
    const body = JSON.parse(state.body);
    assert.deepEqual(Object.keys(body.counts), ['running', 'retrying', 'paused', 'claimed']);
    assert.deepEqual(Object.keys(body.agent_totals), ['input_tokens', 'output_tokens', 'total_tokens', 'seconds_running', 'cost_usd', 'claude_estimate_usd']);
    assert.ok(Array.isArray(body.running) && Array.isArray(body.retrying));
  });

  it('links the logs page from the dashboard and serves it', async () => {
    assert.match((await request(server.port, 'GET', '/')).body, /href="\/logs"/);
    const page = await request(server.port, 'GET', '/logs');
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>Symphony logs<\/title>/);
  });

  it('serves history statistics for all repositories or one, and the raw log', async () => {
    const all = JSON.parse((await request(server.port, 'GET', '/api/v1/history')).body);
    assert.deepEqual(all.repositories_available.map((r: { repo: string }) => r.repo), ['acme/app', 'other/repo']);
    assert.equal(all.totals.runs, 1);
    assert.equal(all.totals.total_tokens, 1500);
    assert.equal(all.totals.cost_usd, 0.0175);
    assert.deepEqual(all.models.map((m: { model: string }) => m.model), ['claude-opus-5-5']);

    const one = JSON.parse((await request(server.port, 'GET', '/api/v1/history?repo=other%2Frepo')).body);
    assert.equal(one.repo, 'other/repo');
    assert.equal(one.totals.runs, 0);
    assert.equal(one.recent[0].event, 'workspace_removed');

    const raw = await request(server.port, 'GET', '/api/v1/history/raw?repo=acme%2Fapp');
    assert.equal(raw.status, 200);
    assert.match(raw.headers['content-type'] ?? '', /text\/plain/);
    assert.match(raw.body, /event=run_finished repo=acme\/app issue=acme\/app#1/);
    assert.equal((await request(server.port, 'GET', '/api/v1/history/raw')).status, 400);
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

describe('issue details', () => {
  it('returns the last entry check as last_check', async () => {
    let checked = false;
    const runner = new FakeRunner(async (_turn, params) => {
      await params.tools.find((t) => t.name === 'set_status')!.execute({ status: 'Agent review' }, params.toolContext());
      checked = true;
      return new Promise((resolve) => params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: '1', code: 'turn_cancelled', message: 'cancelled' })));
    });
    const front = baseFront(tempDir(), {
      tracker: { kind: 'github_project', provider: { owner: 'acme', project_number: 1, token: 'test-token' }, active_states: ['Todo', 'Agent review'] },
      checks: { on_enter: { 'Agent review': 'exit 0' } },
    });
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(front)),
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker([makeIssue({ id: 'c' })]),
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      await orchestrator.tickNow();
      await until(() => checked, 5_000, 'entry check');
      const detail = JSON.parse((await request(server.port, 'GET', `/api/v1/${encodeURIComponent('acme/app#c')}`)).body);
      assert.equal(detail.last_check.target, 'Agent review');
      assert.equal(detail.last_check.ok, true);
      assert.equal(detail.last_check.result, 'passed');
      assert.equal(detail.last_check.exit_code, 0);
      assert.equal(typeof detail.last_check.duration_ms, 'number');
      assert.equal(typeof detail.last_check.finished_at, 'string');
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });
});
