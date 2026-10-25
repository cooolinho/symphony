import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { PricingStore } from '../src/costs/pricing.ts';
import { HistoryLog } from '../src/history/history.ts';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { BOOST_ICON_URI } from '../src/http/icons.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { startHttpServer, type HttpServerHandle } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeIssue, makeWorkflow, tempDir, until } from './helpers.ts';

/** Raw request so tests can set the Host header freely. */
function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('dashboard pages', () => {
  it('ship inline scripts that parse and the Laravel Boost icon', () => {
    for (const [name, html] of Object.entries({ dashboard: DASHBOARD_HTML, agent: AGENT_HTML, logs: LOGS_HTML })) {
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] as string);
      assert.ok(scripts.length > 0, name);
      for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script, { filename: `${name}.js` }), name);
      assert.ok(html.includes(BOOST_ICON_URI), `${name} embeds the Boost icon`);
    }
    assert.match(BOOST_ICON_URI, /^data:image\/svg\+xml;base64,/);
    assert.match(Buffer.from(BOOST_ICON_URI.split(',')[1] as string, 'base64').toString('utf8'), /^<svg [^>]*viewBox="0 0 64 64"/);
  });
});

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
    historyLog.stageResult({
      repo: 'acme/app', issue: 'acme/app#1', run: 'r1', role: 'developer', kind: 'implementation', verdict: 'done', round: null, target: 'Agent review',
      profile: 'bugfix', complexity: 'S', findings: 0, at: new Date('2026-10-04T08:01:00Z'),
    });
    historyLog.stageResult({
      repo: 'acme/app', issue: 'acme/app#1', run: 'r2', role: 'reviewer', kind: 'review', verdict: 'approved', round: 1, target: 'In review',
      profile: 'bugfix', complexity: 'S', findings: 0, at: new Date('2026-10-04T08:05:00Z'),
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
    assert.match(page.body, /AGENT ORCHESTRATOR/);
    // Issues render as cards with the pipeline topology strip in separate sections (Running, Up next, Waiting,
    // Paused), each with a count and hidden when empty; blocked issues collapse into a details panel.
    assert.match(page.body, /renderPipeline\(refs\.pipe, row\.stages/);
    // Stages show the verdict and round of their newest result; skipped stages stay marked as skipped.
    assert.match(page.body, /pipeVerdict\(stage\.verdict, stage\.round\)/);
    assert.match(page.body, /\.pipe-verdict\.vd-warn/);
    assert.match(page.body, /\.pipe-node\.st-skipped/);
    assert.match(page.body, /state\.issues/);
    assert.doesNotMatch(page.body, /Issues in flight/);
    for (const name of ['running', 'next', 'waiting', 'paused']) {
      assert.match(page.body, new RegExp(`<div class="agents[^"]*" id="${name}"></div>`));
      assert.match(page.body, new RegExp(`<span class="count" id="${name}-count"></span>`));
    }
    for (const name of ['next', 'waiting', 'paused']) assert.match(page.body, new RegExp(`<section class="agents-section queue-section" id="${name}-section"[^>]*hidden>`));
    assert.match(page.body, /const SECTIONS = \['running', 'next', 'waiting', 'paused'\]/);
    assert.match(page.body, /\$\(name \+ '-section'\)\.hidden = ordered\.length === 0/);
    // Up next is numbered and every waiting card names its reason; the board age sits next to Up next.
    assert.match(page.body, /setText\(refs\.position, row\.position == null \? '' : '#' \+ row\.position\)/);
    assert.match(page.body, /why\.append\(reasonChip\(row\.reason\)\)/);
    assert.match(page.body, /'in start order · board as of ' \+ ago\(state\.board_fetched_at\)/);
    assert.doesNotMatch(page.body, /Waiting for a free agent slot or the next poll/);
    // Reason chips show the UTC times of the reason texts in local time.
    assert.ok(page.body.includes(String.raw`const UTC_TIME = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC/g;`));
    assert.match(page.body, /id="blocked-section"/);
    assert.match(page.body, /setText\(refs\.model, r\.model/);
    assert.match(page.body, /setText\(refs\.phase, r\.phase/);
    assert.match(page.body, /id="refresh"/);
    assert.match(page.body, /Retry now/);
    assert.match(page.body, /Resume now/);
    assert.match(page.body, /'\/api\/v1\/' \+ encodeURIComponent\(identifier\) \+ '\/' \+ action/);
    for (const route of ["'retry'", "'resume'", "'pause'", "'force'"]) assert.ok(page.body.includes(route), route);
    // Start now: a button on waiting, queued and paused cards, a confirmation when every slot is taken, forced slots in the bar.
    assert.match(page.body, /Force: 'Start now'/);
    assert.match(page.body, /restartButton\(row\.issue_identifier, 'Force'\)/);
    assert.match(page.body, /' busy\. Start ' \+ splitId\(identifier\)\.num \+ ' in an extra slot\?'/);
    assert.match(page.body, /', ' \+ forced \+ ' forced'/);
    assert.match(page.body, /'\/api\/v1\/models\/' \+ encodeURIComponent\(model\)/);
    assert.match(page.body, /restartButton\(row\.issue_identifier, 'Pause'\)/);
    assert.match(page.body, /paused by operator/);
    assert.match(page.body, /model_controls/);
    assert.match(page.body, /limit\.resets_at/);
    assert.match(page.body, /waiting for reset/);
    assert.match(page.body, /Session limit/);
    assert.match(page.body, /Extra usage is off because credits are used up/);
    // The dispatch gate is an amber status notice, hidden unless health.dispatch_gate is set.
    assert.match(page.body, /<section id="dispatch-gate" class="dispatch-gate" role="status" hidden>/);
    assert.match(page.body, /\$\('dispatch-gate'\)\.hidden = !gate/);
    assert.match(page.body, /'Dispatch paused until ' \+ fmtStamp\(gate\.until\) \+ ' · session limit \(' \+ gate\.window \+ '\) · started by ' \+ gate\.issue_identifier/);
    // Model holds: a notice per held model, and waiting cards name the model they wait for.
    assert.match(page.body, /<section id="model-holds" class="dispatch-gate model-holds" role="status" hidden>/);
    assert.match(page.body, /'Model ' \+ hold\.model \+ ' on hold until ' \+ fmtStamp\(hold\.until\)/);
    assert.match(page.body, /'Waiting for model ' \+ hold\.model \+ ' \(limit until ' \+ fmtStamp\(hold\.until\) \+ '\)'/);
    assert.doesNotMatch(page.body, /\bonclick=/);
    // Agent slots: − / value / + at the slot bar, Reset to WORKFLOW.md, and the note when lowered below the running count.
    assert.match(page.body, /<div class="slot-settings" id="slot-settings" role="group" aria-label="Agent slots" hidden><\/div>/);
    assert.match(page.body, /fetch\('\/api\/v1\/settings\/agents', init\)/);
    assert.match(page.body, /'Reset to WORKFLOW\.md \(' \+ total\.workflow \+ '\)'/);
    assert.match(page.body, /' running, limit ' \+ total\.effective \+ ': no new starts until '/);

    const state = await request(server.port, 'GET', '/api/v1/state');
    assert.equal(state.status, 200);
    const body = JSON.parse(state.body);
    assert.deepEqual(Object.keys(body.counts), ['running', 'forced', 'retrying', 'paused', 'claimed', 'queued', 'blocked']);
    assert.ok(Array.isArray(body.issues) && Array.isArray(body.blocked) && Array.isArray(body.queue));
    assert.deepEqual(Object.keys(body.pipeline_config), ['board_columns', 'roles', 'blocked_states']);
    assert.deepEqual(Object.keys(body.agent_totals), ['input_tokens', 'output_tokens', 'total_tokens', 'seconds_running', 'cost_usd', 'claude_estimate_usd']);
    assert.ok(Array.isArray(body.running) && Array.isArray(body.retrying));
    assert.deepEqual(Object.keys(body), [
      'generated_at',
      'counts',
      'issues',
      'queue',
      'blocked',
      'board_fetched_at',
      'pipeline_config',
      'running',
      'retrying',
      'paused',
      'model_holds',
      'model_controls',
      'limits',
      'agent_totals',
      'rate_limits',
      'health',
      'controls',
    ]);
    assert.deepEqual(body.model_holds, []);
    assert.equal(body.health.dispatch_gate, null);
  });

  it('links the logs page from the dashboard and serves it', async () => {
    const dashboard = (await request(server.port, 'GET', '/')).body;
    assert.match(dashboard, /href="\/logs"/);
    // The Logs button opens a drawer fed by the history API; the link stays as a fallback.
    assert.match(dashboard, /role="dialog"[^>]*aria-labelledby="logs-title"/);
    assert.match(dashboard, /fetch\('\/api\/v1\/history'/);
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

  it('serves analytics and log entries for one period, repository and model', async () => {
    const page = (await request(server.port, 'GET', '/logs')).body;
    assert.match(page, /\/api\/v1\/history\/analytics\?/);
    assert.match(page, /\/api\/v1\/history\/entries\?/);
    assert.match(page, /data-body="roles"/);
    assert.match(page, /Most expensive issue pipelines/);

    const week = '/api/v1/history/analytics?from=2026-09-28T00:00:00Z&to=2026-10-05T00:00:00Z&tz=Europe%2FBerlin';
    const a = JSON.parse((await request(server.port, 'GET', week)).body);
    assert.equal(a.totals.runs, 1);
    assert.equal(a.totals.cost_usd, 0.0175);
    assert.equal(a.period.time_zone, 'Europe/Berlin');
    assert.equal(a.period.granularity, 'day');
    assert.deepEqual(a.repositories_available, ['acme/app', 'other/repo']);
    assert.deepEqual(a.models_available, ['claude-opus-5-5']);
    assert.deepEqual(a.efforts_available, ['unknown']);
    assert.deepEqual(a.by_role.map((r: { role: string; runs: number }) => [r.role, r.runs]), [['default', 1]]);
    assert.equal(a.top.pipelines.length, 1);
    // Stage results by profile and the verdicts per role (the stage_result lines of the seeded history).
    assert.equal(a.stage_results, 2);
    assert.deepEqual(a.by_profile.map((p: { profile: string; results: number; issues: number; runs: number; verdicts: object }) => [p.profile, p.results, p.issues, p.runs, p.verdicts]), [
      ['bugfix', 2, 1, 1, { 'implementation:done': 1, 'review:approved': 1 }],
    ]);
    assert.deepEqual(a.verdicts_by_role.map((r: { role: string; verdicts: object }) => [r.role, r.verdicts]), [
      ['developer', { 'implementation:done': 1 }],
      ['reviewer', { 'review:approved': 1 }],
    ]);
    assert.equal(a.filter.effort, null);
    // A second identical request is served from the cache with the same figures.
    assert.deepEqual(JSON.parse((await request(server.port, 'GET', week)).body).series, a.series);
    const effort = JSON.parse((await request(server.port, 'GET', `${week}&effort=high`)).body);
    assert.equal(effort.totals.runs, 0);
    assert.equal(effort.filter.effort, 'high');

    const empty = JSON.parse((await request(server.port, 'GET', '/api/v1/history/analytics?repo=other%2Frepo&model=claude-opus-5-5')).body);
    assert.equal(empty.totals.runs, 0);
    assert.deepEqual(empty.repositories_available, ['acme/app', 'other/repo']);

    assert.equal((await request(server.port, 'GET', '/api/v1/history/analytics?from=yesterday')).status, 400);
    assert.equal((await request(server.port, 'GET', '/api/v1/history/analytics?from=2026-10-05T00:00:00Z&to=2026-10-01T00:00:00Z')).status, 400);

    const log = JSON.parse((await request(server.port, 'GET', '/api/v1/history/entries?repo=other%2Frepo&limit=5')).body);
    assert.deepEqual(log.entries.map((e: { event: string }) => e.event), ['workspace_removed']);
    const runs = JSON.parse((await request(server.port, 'GET', '/api/v1/history/entries?result=handed_off&order=asc')).body);
    assert.deepEqual(runs.entries.map((e: { issue: string }) => e.issue), ['acme/app#1']);
  });

  it('serves the agent detail view and links the agent cards to it', async () => {
    const page = await request(server.port, 'GET', '/agent?id=acme%2Fapp%231');
    assert.equal(page.status, 200);
    assert.match(page.body, /AGENT TRACE/);
    assert.match(page.body, /Back to agents/);
    assert.match(page.body, /id="timeline"/);
    // Pipeline topology section and the Issue sidebar (labels, blockers, sub-issues).
    assert.match(page.body, /id="pipe-section"/);
    assert.match(page.body, /renderPipeline\(\$\('pipeline'\)/);
    assert.match(page.body, /id="issue-section"/);
    // Stage results: one card per result with its verdict, round, findings and the link to the comment.
    assert.match(page.body, /id="results-section"/);
    assert.match(page.body, /id="result-cards"/);
    assert.match(page.body, /function renderResults\(\)/);
    assert.match(page.body, /pipeVerdict\(r\.verdict, r\.round\)/);
    assert.match(page.body, /'Comment ↗'/);
    assert.match(page.body, /'\/timeline\?after='/);
    assert.match(page.body, /'\/transcript\?run='/);
    assert.match(page.body, /Waiting for limit/);
    assert.match(page.body, /Session limit reached/);
    assert.match(page.body, /Resets at/);
    assert.match(page.body, /API \+ '\/' \+ action/);
    assert.match(page.body, /restartButton\('Pause'\)/);
    assert.match(page.body, /Paused by operator/);
    assert.match(page.body, /Resume now/);
    assert.match(page.body, /session_limit: \['⏳ Session limit', 'amber', 'session limit'\]/);
    assert.match(page.body, /SESSION LIMIT · RETRY/);
    assert.match(page.body, /WAITING FOR RESET/);
    assert.match(page.body, /worker_restarted/);
    assert.match(page.body, /worker_forced/);
    assert.match(page.body, /restartButton\('Force'\)/);
    assert.match(page.body, /' in an extra slot\?'/);
    assert.equal((await request(server.port, 'HEAD', '/agent')).status, 200);
    const dashboard = (await request(server.port, 'GET', '/')).body;
    assert.match(dashboard, /'\/agent\?id=' \+ encodeURIComponent\(row\.issue_identifier\)/);
    // Cards flag needs-human issues and show the spent share of the cost budget.
    assert.match(dashboard, /function flagChips\(row\)/);
    assert.match(dashboard, /'needs human'/);
    assert.match(dashboard, /row\.budget/);
  });

  it('returns a JSON 404 for unknown issues and routes', async () => {
    const unknown = await request(server.port, 'GET', `/api/v1/${encodeURIComponent('acme/app#404')}`);
    assert.equal(unknown.status, 404);
    assert.equal(JSON.parse(unknown.body).error.code, 'issue_not_found');
    for (const sub of ['timeline', 'transcript']) {
      const missing = await request(server.port, 'GET', `/api/v1/${encodeURIComponent('acme/app#404')}/${sub}`);
      assert.equal(missing.status, 404);
      assert.equal(JSON.parse(missing.body).error.code, 'issue_not_found');
    }
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
  it('returns the entry gate with a running and a finished check', async () => {
    const workspaceRoot = tempDir();
    const runner = new FakeRunner(async (_turn, params) => {
      void params.tools.find((t) => t.name === 'set_status')!.execute({ status: 'Agent review' }, params.toolContext());
      return new Promise((resolve) => params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: '1', code: 'turn_cancelled', message: 'cancelled' })));
    });
    const front = baseFront(workspaceRoot, {
      tracker: { kind: 'github_project', provider: { owner: 'acme', project_number: 1, token: 'test-token' }, active_states: ['Todo', 'Agent review'] },
      checks: {
        on_enter: {
          'Agent review': [
            { name: 'lint', command: 'exit 0' },
            { name: 'ci', command: 'while [ ! -f "$SYMPHONY_WORKSPACE/go" ]; do sleep 0.02; done; exit 0', timeout_ms: 30000 },
          ],
        },
      },
    });
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(front)),
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker([makeIssue({ id: 'g' })]),
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    const detailOf = async () => JSON.parse((await request(server.port, 'GET', `/api/v1/${encodeURIComponent('acme/app#g')}`)).body);
    try {
      await orchestrator.tickNow();
      await until(() => orchestrator.issueDetail('acme/app#g')?.gate?.checks[1]?.status === 'running', 5_000, 'running check');
      let detail = await detailOf();
      assert.equal(detail.gate.target, 'Agent review');
      assert.equal(detail.gate.finished_at, null);
      const [lint, ci] = detail.gate.checks;
      assert.equal(lint.name, 'lint');
      assert.equal(lint.status, 'passed');
      assert.equal(typeof lint.duration_ms, 'number');
      assert.equal(lint.cached, false);
      assert.equal(lint.output, null);
      assert.equal(ci.name, 'ci');
      assert.equal(typeof ci.started_at, 'string');
      assert.ok(ci.duration_ms >= 0);
      assert.equal(ci.timeout_ms, 30000);
      fs.writeFileSync(path.join(orchestrator.issueDetail('acme/app#g')!.workspace.path as string, 'go'), '');
      await until(() => orchestrator.issueDetail('acme/app#g')?.gate?.finished_at != null, 5_000, 'finished gate');
      detail = await detailOf();
      assert.deepEqual(detail.gate.checks.map((c: { status: string }) => c.status), ['passed', 'passed']);
      assert.equal(detail.last_check.target, 'Agent review');
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });

  it('returns gate: null without an entry gate', async () => {
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
      runner: new FakeRunner(async () => ({ ok: true, turnId: '1', resultText: '' })),
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker([makeIssue({ id: 'n' })]),
    });
    await orchestrator.tickNow();
    const detail = orchestrator.issueDetail('acme/app#n');
    assert.equal(detail?.gate, null);
    assert.equal(detail?.last_check, null);
    await orchestrator.shutdown(1_000);
  });

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

describe('agent trace API', () => {
  it('serves the timeline incrementally and the session transcript, normalized or raw', async () => {
    const runner = new FakeRunner((turn, params) => {
      fs.mkdirSync(path.dirname(params.transcriptPath as string), { recursive: true });
      fs.appendFileSync(params.transcriptPath as string, `${JSON.stringify({ at: new Date().toISOString(), prompt: { turn, text: 'Work on acme/app#t' } })}\n`);
      params.onEvent({ event: 'tool_use', timestamp: new Date(), pid: 1, threadId: 't', turnId: '1', sessionId: 't-1', turnCount: turn, message: 'Bash: ls', detail: { tool: 'Bash' } });
      return new Promise(() => undefined);
    });
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: tempDir(),
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker([makeIssue({ id: 't' })]),
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    const base = `/api/v1/${encodeURIComponent('acme/app#t')}`;
    try {
      await orchestrator.tickNow();
      await until(() => (orchestrator.issueTimeline('t')?.events ?? []).some((e) => e.event === 'tool_use'), 3_000, 'tool event');
      const timeline = JSON.parse((await request(server.port, 'GET', `${base}/timeline`)).body);
      assert.equal(timeline.issue_identifier, 'acme/app#t');
      assert.equal(timeline.events[0].event, 'run_dispatched');
      const after = JSON.parse((await request(server.port, 'GET', `${base}/timeline?after=${timeline.latest_seq}`)).body);
      assert.deepEqual(after.events, []);

      const transcript = JSON.parse((await request(server.port, 'GET', `${base}/transcript`)).body);
      assert.equal(transcript.available, true);
      assert.deepEqual(transcript.entries.map((e: { type: string }) => e.type), ['prompt']);
      const next = JSON.parse((await request(server.port, 'GET', `${base}/transcript?run=${transcript.run}&from=${transcript.next_offset}`)).body);
      assert.deepEqual(next.entries, []);
      const raw = await request(server.port, 'GET', `${base}/transcript?run=${transcript.run}&format=raw`);
      assert.equal(raw.status, 200);
      assert.match(raw.headers['content-type'] ?? '', /text\/plain/);
      assert.match(raw.body, /"prompt":\{"turn":1,"text":"Work on acme\/app#t"\}/);
      assert.equal((await request(server.port, 'GET', `${base}/transcript?run=nope&format=raw`)).status, 404);
      assert.equal((await request(server.port, 'POST', `${base}/timeline`)).status, 405);
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });
});

describe('POST /api/v1/<identifier>/retry', () => {
  const base = `/api/v1/${encodeURIComponent('acme/app#a')}/retry`;

  it('restarts a waiting worker and reports why others cannot be restarted', async () => {
    let mode: 'fail' | 'hang' = 'fail';
    const runner = new FakeRunner((turn, params) =>
      mode === 'hang'
        ? new Promise((resolve) => params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: String(turn), code: 'turn_cancelled', message: 'cancelled' })))
        : { ok: false, turnId: String(turn), code: 'turn_failed', message: 'boom' },
    );
    const timers = new ManualTimers();
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), { agent: { max_turns: 1 } }))),
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers,
      createAdapter: () => new FakeTracker([makeIssue({ id: 'a' })]),
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    const state = async () => JSON.parse((await request(server.port, 'GET', '/api/v1/state')).body);
    try {
      const unknown = await request(server.port, 'POST', `/api/v1/${encodeURIComponent('acme/app#zzz')}/retry`);
      assert.equal(unknown.status, 404);
      assert.equal(JSON.parse(unknown.body).error.code, 'issue_not_found');

      await orchestrator.tickNow();
      await until(() => orchestrator.snapshot().retrying.length === 1, 3_000, 'waiting');
      mode = 'hang';
      const queued = await request(server.port, 'POST', base);
      assert.equal(queued.status, 202);
      const body = JSON.parse(queued.body);
      assert.equal(body.queued, true);
      assert.equal(body.issue_identifier, 'acme/app#a');
      assert.equal(body.previous, 'retrying');
      assert.equal(typeof body.requested_at, 'string');
      timers.fire(0);
      await until(() => orchestrator.snapshot().running.length === 1, 3_000, 'dispatched');
      assert.equal((await state()).running.length, 1);
      assert.deepEqual((await state()).controls, { retry: true });
      const detail = JSON.parse((await request(server.port, 'GET', `/api/v1/${encodeURIComponent('acme/app#a')}`)).body);
      assert.deepEqual(detail.controls, { retry: true });

      const running = await request(server.port, 'POST', base);
      assert.equal(running.status, 409);
      assert.equal(JSON.parse(running.body).error.code, 'running');
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });

  it('maps every refusal of restartWorker and guards the route', async () => {
    let reason: string = 'not_waiting';
    let calls = 0;
    const orchestrator = {
      restartWorker: async () => {
        calls++;
        return { ok: false, reason };
      },
    } as unknown as Orchestrator;
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      for (const [r, status, code] of [['not_waiting', 409, 'not_waiting'], ['stopping', 409, 'stopping'], ['not_found', 404, 'issue_not_found']] as const) {
        reason = r;
        const res = await request(server.port, 'POST', base);
        assert.equal(res.status, status);
        assert.equal(JSON.parse(res.body).error.code, code);
      }
      const get = await request(server.port, 'GET', base);
      assert.equal(get.status, 405);
      assert.equal(get.headers.allow, 'POST');
      assert.equal((await request(server.port, 'POST', base, { origin: 'https://evil.example' })).status, 403);
      assert.equal(JSON.parse((await request(server.port, 'POST', base, { origin: 'https://evil.example' })).body).error.code, 'forbidden_origin');
      assert.equal((await request(server.port, 'POST', base, { host: 'evil.example' })).status, 403);
      assert.equal(calls, 3);
    } finally {
      await server.close();
    }
  });

  const remoteOrchestrator = () => {
    const counts = { restart: 0, refresh: 0 };
    const orchestrator = {
      restartWorker: async () => {
        counts.restart++;
        return { ok: true, issueIdentifier: 'acme/app#a', previous: 'retrying' };
      },
      requestRefresh: () => {
        counts.refresh++;
        return { queued: true, coalesced: false };
      },
      snapshot: () => ({}),
      issueDetail: () => ({ issue_identifier: 'acme/app#a' }),
    } as unknown as Orchestrator;
    return { orchestrator, counts };
  };
  const detailPath = `/api/v1/${encodeURIComponent('acme/app#a')}`;

  it('is disabled on a non-loopback bind unless remote control is allowed', async () => {
    const { orchestrator, counts } = remoteOrchestrator();
    const server = await startHttpServer({ host: '0.0.0.0', port: 0, orchestrator, logger: Logger.silent() });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const res = await request(server.port, 'POST', base, { origin });
      assert.equal(res.status, 403);
      const error = JSON.parse(res.body).error;
      assert.equal(error.code, 'control_disabled');
      assert.match(error.message, /server\.allow_remote_control/);
      assert.match(error.message, /SYMPHONY_ALLOW_REMOTE_CONTROL/);
      assert.equal(counts.restart, 0);
      const state = await request(server.port, 'GET', '/api/v1/state');
      assert.equal(state.status, 200);
      assert.deepEqual(JSON.parse(state.body).controls, { retry: false });
      assert.deepEqual(JSON.parse((await request(server.port, 'GET', detailPath)).body).controls, { retry: false });
      // Refresh is unchanged: allowed without an Origin, refused with a foreign one.
      assert.equal((await request(server.port, 'POST', '/api/v1/refresh')).status, 202);
      assert.equal((await request(server.port, 'POST', '/api/v1/refresh', { origin: 'https://evil.example' })).status, 403);
      assert.equal(counts.refresh, 1);
    } finally {
      await server.close();
    }
  });

  it('requires a matching Origin when remote control is allowed on a non-loopback bind', async () => {
    const { orchestrator, counts } = remoteOrchestrator();
    const server = await startHttpServer({ host: '0.0.0.0', port: 0, orchestrator, logger: Logger.silent(), allowRemoteControl: true });
    try {
      const missing = await request(server.port, 'POST', base);
      assert.equal(missing.status, 403);
      assert.equal(JSON.parse(missing.body).error.code, 'forbidden_origin');
      assert.match(JSON.parse(missing.body).error.message, /Origin/);
      const foreign = await request(server.port, 'POST', base, { origin: 'https://evil.example' });
      assert.equal(foreign.status, 403);
      assert.equal(JSON.parse(foreign.body).error.code, 'forbidden_origin');
      assert.equal(counts.restart, 0);

      // Behind a proxy the browser sends the public origin and the proxy forwards the public Host.
      const proxied = await request(server.port, 'POST', base, { host: 'symphony.example', origin: 'https://symphony.example' });
      assert.equal(proxied.status, 202);
      assert.equal(JSON.parse(proxied.body).issue_identifier, 'acme/app#a');
      const direct = await request(server.port, 'POST', base, { origin: `http://127.0.0.1:${server.port}` });
      assert.equal(direct.status, 202);
      assert.equal(counts.restart, 2);

      assert.deepEqual(JSON.parse((await request(server.port, 'GET', '/api/v1/state')).body).controls, { retry: true });
      assert.deepEqual(JSON.parse((await request(server.port, 'GET', detailPath)).body).controls, { retry: true });
      assert.equal((await request(server.port, 'POST', '/api/v1/refresh')).status, 202);
    } finally {
      await server.close();
    }
  });
});

describe('operator pause routes', () => {
  const issuePath = (action: string) => `/api/v1/${encodeURIComponent('acme/app#a')}/${action}`;

  /** A fake orchestrator whose control methods answer with `results[name]` and count their calls. */
  const fakeOrchestrator = (results: Record<string, unknown>) => {
    const calls: string[] = [];
    const method = (name: string) => async (key: string) => {
      calls.push(`${name} ${key}`);
      return results[name];
    };
    const orchestrator = {
      pauseIssue: method('pauseIssue'),
      resumeIssue: method('resumeIssue'),
      holdModel: method('holdModel'),
      releaseModel: method('releaseModel'),
      restartWorker: method('restartWorker'),
      forceStart: method('forceStart'),
      snapshot: () => ({}),
    } as unknown as Orchestrator;
    return { orchestrator, calls };
  };

  it('force-starts an issue with 202 and maps its refusals', async () => {
    const results: Record<string, unknown> = {
      forceStart: { ok: true, issueIdentifier: 'acme/app#a', previous: 'queued', slots: { running: 4, forced: 1, limit: 3 } },
    };
    const { orchestrator, calls } = fakeOrchestrator(results);
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      const started = await request(server.port, 'POST', issuePath('force'));
      assert.equal(started.status, 202);
      const body = JSON.parse(started.body);
      assert.deepEqual([body.started, body.issue_identifier, body.previous, body.slots], [true, 'acme/app#a', 'queued', { running: 4, forced: 1, limit: 3 }]);
      assert.deepEqual(calls, ['forceStart acme/app#a']);
      const refusals = [
        ['running', 409, 'running'],
        ['blocked', 409, 'blocked'],
        ['not_eligible', 409, 'not_eligible'],
        ['model_held', 409, 'model_held'],
        ['invalid_workflow', 409, 'invalid_workflow'],
        ['stopping', 409, 'stopping'],
        ['not_found', 404, 'issue_not_found'],
        ['tracker_error', 502, 'tracker_error'],
        ['spawn_failed', 500, 'spawn_failed'],
      ] as const;
      for (const [reason, status, code] of refusals) {
        results.forceStart = { ok: false, reason, message: `refused: ${reason}`, model: 'opus' };
        const res = await request(server.port, 'POST', issuePath('force'));
        assert.equal(res.status, status, reason);
        assert.deepEqual(JSON.parse(res.body).error, { code, message: `refused: ${reason}` });
      }
      assert.equal((await request(server.port, 'GET', issuePath('force'))).status, 405);
    } finally {
      await server.close();
    }
  });

  it('pauses and resumes issues and models with 202', async () => {
    const { orchestrator, calls } = fakeOrchestrator({
      pauseIssue: { ok: true, issueIdentifier: 'acme/app#a', previous: 'running' },
      resumeIssue: { ok: true, issueIdentifier: 'acme/app#a' },
      holdModel: { ok: true, model: 'fable', issues: 2 },
      releaseModel: { ok: true, model: 'fable', issues: 1 },
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      const paused = await request(server.port, 'POST', issuePath('pause'));
      assert.equal(paused.status, 202);
      assert.equal(JSON.parse(paused.body).previous, 'running');
      assert.equal((await request(server.port, 'POST', issuePath('resume'))).status, 202);
      const hold = await request(server.port, 'POST', '/api/v1/models/fable/hold');
      assert.equal(hold.status, 202);
      assert.deepEqual([JSON.parse(hold.body).model, JSON.parse(hold.body).stopped], ['fable', 2]);
      const release = await request(server.port, 'POST', '/api/v1/models/fable/release');
      assert.equal(release.status, 202);
      assert.equal(JSON.parse(release.body).requeued, 1);
      assert.deepEqual(calls, ['pauseIssue acme/app#a', 'resumeIssue acme/app#a', 'holdModel fable', 'releaseModel fable']);
      assert.equal((await request(server.port, 'GET', issuePath('pause'))).status, 405);
      assert.equal((await request(server.port, 'GET', '/api/v1/models/fable/hold')).status, 405);
    } finally {
      await server.close();
    }
  });

  it('maps refusals to 409, 404 and 400', async () => {
    const results: Record<string, unknown> = {};
    const { orchestrator } = fakeOrchestrator(results);
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    const expect = async (path: string, status: number, code: string) => {
      const res = await request(server.port, 'POST', path);
      assert.equal(res.status, status, path);
      assert.equal(JSON.parse(res.body).error.code, code, path);
    };
    try {
      for (const [reason, status, code] of [['already_paused', 409, 'already_paused'], ['stopping', 409, 'stopping'], ['not_found', 404, 'issue_not_found']] as const) {
        results.pauseIssue = { ok: false, reason };
        await expect(issuePath('pause'), status, code);
      }
      for (const [reason, status, code] of [['not_paused', 409, 'not_paused'], ['stopping', 409, 'stopping'], ['not_found', 404, 'issue_not_found']] as const) {
        results.resumeIssue = { ok: false, reason };
        await expect(issuePath('resume'), status, code);
      }
      for (const [reason, status, code] of [['unknown_model', 400, 'unknown_model'], ['already_paused', 409, 'already_paused'], ['stopping', 409, 'stopping']] as const) {
        results.holdModel = { ok: false, reason };
        await expect('/api/v1/models/gpt/hold', status, code);
      }
      results.releaseModel = { ok: false, reason: 'not_paused' };
      await expect('/api/v1/models/fable/release', 409, 'not_paused');
    } finally {
      await server.close();
    }
  });

  it('guards every control route like retry', async () => {
    const { orchestrator, calls } = fakeOrchestrator({});
    const routes = [issuePath('pause'), issuePath('resume'), '/api/v1/models/fable/hold', '/api/v1/models/fable/release', issuePath('retry'), issuePath('force')];
    const local = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    const remote = await startHttpServer({ host: '0.0.0.0', port: 0, orchestrator, logger: Logger.silent() });
    const proxied = await startHttpServer({ host: '0.0.0.0', port: 0, orchestrator, logger: Logger.silent(), allowRemoteControl: true });
    try {
      for (const route of routes) {
        const foreign = await request(local.port, 'POST', route, { origin: 'https://evil.example' });
        assert.equal(foreign.status, 403, route);
        assert.equal(JSON.parse(foreign.body).error.code, 'forbidden_origin');
        const disabled = await request(remote.port, 'POST', route, { origin: `http://127.0.0.1:${remote.port}` });
        assert.equal(disabled.status, 403, route);
        assert.equal(JSON.parse(disabled.body).error.code, 'control_disabled');
        const missing = await request(proxied.port, 'POST', route);
        assert.equal(missing.status, 403, route);
        assert.equal(JSON.parse(missing.body).error.code, 'forbidden_origin');
      }
      assert.deepEqual(calls, []);
    } finally {
      await Promise.all([local.close(), remote.close(), proxied.close()]);
    }
  });

  it('pauses a running issue end to end and lists it as paused', async () => {
    const runner = new FakeRunner((turn, params) => new Promise((resolve) => params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: String(turn), code: 'turn_cancelled', message: 'cancelled' }))));
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), { agent: { max_turns: 1 } }))),
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker([makeIssue({ id: 'a' })]),
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      await orchestrator.tickNow();
      await until(() => orchestrator.snapshot().running[0]?.phase === 'StreamingTurn', 3_000, 'streaming');
      assert.equal((await request(server.port, 'POST', issuePath('pause'))).status, 202);
      await until(() => orchestrator.snapshot().running.length === 0, 3_000, 'stopped');
      const state = JSON.parse((await request(server.port, 'GET', '/api/v1/state')).body);
      assert.equal(state.issues[0].section, 'paused');
      assert.equal(state.paused[0].source, 'operator');
      assert.equal(JSON.parse((await request(server.port, 'POST', issuePath('pause'))).body).error.code, 'already_paused');
      assert.equal((await request(server.port, 'POST', issuePath('resume'))).status, 202);
      assert.equal(JSON.parse((await request(server.port, 'POST', issuePath('resume'))).body).error.code, 'not_paused');
      assert.equal((await request(server.port, 'POST', '/api/v1/models/nope/hold')).status, 400);
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });
});

describe('agent settings routes', () => {
  const route = '/api/v1/settings/agents';
  const json = { 'content-type': 'application/json' };
  const setup = (front: Record<string, unknown> = {}) =>
    new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), { agent: { max_concurrent_agents: 2, max_concurrent_agents_by_state: { todo: 1 } }, ...front }))),
      runner: new FakeRunner(),
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker(),
    });

  it('changes and resets the slots and reports them under limits', async () => {
    const orchestrator = setup();
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      const before = JSON.parse((await request(server.port, 'GET', '/api/v1/state')).body).limits;
      assert.deepEqual(before.max_concurrent_agents, { effective: 2, workflow: 2, override: null });
      assert.deepEqual(before.by_state.Todo, { effective: 1, workflow: 1, override: null });
      assert.equal(before.override_active, false);

      const put = await request(server.port, 'PUT', route, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ max_concurrent_agents: 3, max_concurrent_agents_by_state: { Todo: 2 } }));
      assert.equal(put.status, 200);
      const body = JSON.parse(put.body);
      assert.equal(body.changed, true);
      assert.deepEqual(body.limits.max_concurrent_agents, { effective: 3, workflow: 2, override: 3 });
      assert.deepEqual(body.limits.by_state.Todo, { effective: 2, workflow: 1, override: 2 });
      const state = JSON.parse((await request(server.port, 'GET', '/api/v1/state')).body);
      assert.equal(state.limits.override_active, true);
      assert.equal(state.health.max_concurrent_agents, 3);

      const reset = await request(server.port, 'DELETE', route, json);
      assert.equal(reset.status, 200);
      assert.deepEqual(JSON.parse(reset.body).limits.max_concurrent_agents, { effective: 2, workflow: 2, override: null });
      assert.equal((await request(server.port, 'POST', route, json, '{}')).status, 405);
      assert.equal((await request(server.port, 'GET', route)).status, 405);
    } finally {
      await server.close();
    }
  });

  it('answers 400 for invalid values, 415 without JSON and 413 for a large body', async () => {
    const orchestrator = setup();
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    const expect = async (body: string, status: number, code: string, headers: Record<string, string> = json) => {
      const res = await request(server.port, 'PUT', route, headers, body);
      assert.equal(res.status, status, body.slice(0, 80));
      const error = JSON.parse(res.body).error;
      assert.equal(error.code, code, body.slice(0, 80));
      return error.message as string;
    };
    try {
      assert.match(await expect(JSON.stringify({ max_concurrent_agents: 51 }), 400, 'invalid_settings'), /0 to 50/);
      assert.match(await expect(JSON.stringify({ max_concurrent_agents_by_state: { Todo: 0 } }), 400, 'invalid_settings'), /1 to 50/);
      assert.match(await expect(JSON.stringify({ max_concurrent_agents_by_state: { Done: 1 } }), 400, 'invalid_settings'), /not an active column/);
      assert.match(await expect('{nope', 400, 'bad_request'), /not valid JSON/);
      assert.match(await expect('', 400, 'invalid_settings'), /JSON object/);
      await expect('max_concurrent_agents=3', 415, 'unsupported_media_type', { 'content-type': 'application/x-www-form-urlencoded' });
      await expect('{"max_concurrent_agents":3}', 415, 'unsupported_media_type', { 'content-type': 'text/plain' });
      await expect('{"max_concurrent_agents":3}', 415, 'unsupported_media_type', {});
      assert.equal((await request(server.port, 'DELETE', route)).status, 415);
      await expect(JSON.stringify({ max_concurrent_agents: 3, pad: 'x'.repeat(20_000) }), 413, 'payload_too_large');
      assert.equal(orchestrator.snapshot().limits.override_active, false, 'nothing changed');
    } finally {
      await server.close();
    }
  });

  it('changes reserved slots and refuses a limit below their sum with 400', async () => {
    const orchestrator = setup({
      agent: { max_concurrent_agents: 3, reserved_slots_by_role: { developer: 1, reviewer: 1 } },
      tracker: { kind: 'github_project', provider: { owner: 'acme', project_number: 1, token: 't' }, active_states: ['Ready', 'Agent review'] },
      roles: { developer: { states: ['Ready'] }, reviewer: { states: ['Agent review'], read_only: true } },
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      const before = JSON.parse((await request(server.port, 'GET', '/api/v1/state')).body).limits;
      assert.deepEqual(before.reserved_slots_by_role.reviewer, { effective: 1, workflow: 1, override: null, running: 0 });
      assert.equal(before.reservation_problem, null);

      const low = await request(server.port, 'PUT', route, json, JSON.stringify({ max_concurrent_agents: 1 }));
      assert.equal(low.status, 400);
      assert.deepEqual(JSON.parse(low.body).error, {
        code: 'invalid_settings',
        message: 'the limit of 1 agent slot is below the reserved slots (developer 1 + reviewer 1 = 2); lower the reservations first',
      });
      assert.equal(orchestrator.snapshot().limits.override_active, false, 'nothing changed');

      const put = await request(server.port, 'PUT', route, json, JSON.stringify({ reserved_slots_by_role: { developer: 2 } }));
      assert.equal(put.status, 200);
      assert.deepEqual(JSON.parse(put.body).limits.reserved_slots_by_role.developer, { effective: 2, workflow: 1, override: 2, running: 0 });
      const unknownRole = await request(server.port, 'PUT', route, json, JSON.stringify({ reserved_slots_by_role: { tester: 1 } }));
      assert.equal(unknownRole.status, 400);
      assert.match(JSON.parse(unknownRole.body).error.message, /tester is not a role/);
    } finally {
      await server.close();
    }
  });

  it('uses the shared control guard', async () => {
    const orchestrator = setup();
    const local = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    const remote = await startHttpServer({ host: '0.0.0.0', port: 0, orchestrator, logger: Logger.silent() });
    const proxied = await startHttpServer({ host: '0.0.0.0', port: 0, orchestrator, logger: Logger.silent(), allowRemoteControl: true });
    const put = JSON.stringify({ max_concurrent_agents: 4 });
    try {
      for (const method of ['PUT', 'DELETE']) {
        // Node's client sends a DELETE body without a length, which breaks the kept-alive connection.
        const body = method === 'PUT' ? put : undefined;
        const foreign = await request(local.port, method, route, { ...json, origin: 'https://evil.example' }, body);
        assert.equal(foreign.status, 403, method);
        assert.equal(JSON.parse(foreign.body).error.code, 'forbidden_origin');
        const disabled = await request(remote.port, method, route, { ...json, origin: `http://127.0.0.1:${remote.port}` }, body);
        assert.equal(disabled.status, 403, method);
        assert.equal(JSON.parse(disabled.body).error.code, 'control_disabled');
        const missing = await request(proxied.port, method, route, json, body);
        assert.equal(missing.status, 403, method);
        assert.equal(JSON.parse(missing.body).error.code, 'forbidden_origin');
      }
      assert.equal(orchestrator.snapshot().limits.override_active, false);
      const allowed = await request(proxied.port, 'PUT', route, { ...json, host: 'symphony.example', origin: 'https://symphony.example' }, put);
      assert.equal(allowed.status, 200);
      assert.equal(orchestrator.snapshot().limits.max_concurrent_agents.override, 4);
    } finally {
      await Promise.all([local.close(), remote.close(), proxied.close()]);
    }
  });
});
