import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { StartSessionParams, TurnResult } from '../src/agent/types.ts';
import { PricingStore } from '../src/costs/pricing.ts';
import { HistoryLog, readHistory } from '../src/history/history.ts';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { startHttpServer, type HttpServerHandle } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { CONTINUATION_DELAY_MS } from '../src/orchestrator/eligibility.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import type { ToolResult } from '../src/tracker/types.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, baseFront, callTool, makeIssue, makeWorkflow, renderPage, tempDir, until } from './helpers.ts';
import { dashboardState, issueDetail, issueRow } from './helpers/page-fixtures.ts';
import type { FakeElement } from './helpers/fake-dom.ts';

// Acceptance tests of #212, derived from the issue: the agent page of a bugfix issue shows every stage with its
// verdict, /api/v1/history/analytics returns by_profile, and every stage result lands in the history log.

const ISSUE = '7';
const IDENTIFIER = `acme/app#${ISSUE}`;
const BOARD = ['Backlog', 'Ready', 'In progress', 'Agent review', 'Blocked', 'In review', 'Done'];

const FRONT = {
  tracker: {
    kind: 'github_project',
    provider: { owner: 'acme', project_number: 1, token: 'test-token' },
    active_states: ['Ready', 'In progress', 'Agent review'],
    terminal_states: ['Done'],
  },
  agent: { max_turns: 2, max_continuations: 2, max_issue_cost_usd: 50 },
  roles: {
    developer: {
      states: ['Ready', 'In progress'],
      result: 'implementation',
      may_move_to: ['In progress', 'Agent review', 'Blocked'],
      on_result: { done: 'Agent review', blocked: 'Blocked' },
    },
    reviewer: {
      states: ['Agent review'],
      read_only: true,
      result: 'review',
      may_move_to: ['In review', 'In progress', 'Blocked'],
      on_result: { approved: 'In review', changes_needed: 'In progress', blocked: 'Blocked' },
      on_round_limit: 'In review',
    },
  },
  pipeline: { max_review_rounds: 3, profiles: { bugfix: { max_review_rounds: 3 } } },
};

type Report = (args: Record<string, unknown>) => Promise<ToolResult>;

function request(port: number, method: string, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const getJson = async (port: number, urlPath: string) => {
  const res = await request(port, 'GET', urlPath);
  assert.equal(res.status, 200, `${urlPath}: ${res.body}`);
  return JSON.parse(res.body);
};

describe('bugfix issue through developer → reviewer, observed from outside', () => {
  let server: HttpServerHandle;
  let historyDir: string;
  let tracker: FakeTracker;
  const reports: ToolResult[] = [];

  before(async () => {
    const root = tempDir();
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
    const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
    const history = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
    historyDir = history.dir;

    tracker = new FakeTracker([
      makeIssue({ id: ISSUE, state: 'Ready', labels: ['bug', 'Complexity: M'], native_ref: { status_updated_at: '2026-01-01T00:00:00.000Z' } }),
    ]);
    tracker.statusOptions = async () => BOARD;
    tracker.issueRepository = () => 'acme/app';

    // Round 1: implementation done, review asks for changes; round 2: implementation done, review approves.
    const script: Array<Record<string, unknown>> = [
      { verdict: 'done', summary: 'Fixed the crash.' },
      { verdict: 'changes_needed', summary: 'One guard is missing.', findings: [{ severity: 'major', file: 'src/app.ts', line: 12, problem: 'Missing null guard', fix: 'Add the guard' }] },
      { verdict: 'done', summary: 'Added the guard.' },
      { verdict: 'approved', summary: 'Looks good now.' },
    ];
    const assigned = new Map<StartSessionParams, Record<string, unknown> | undefined>();
    const runner = new FakeRunner(async (turn, params): Promise<TurnResult> => {
      if (!assigned.has(params)) assigned.set(params, script.shift());
      const args = assigned.get(params);
      if (turn === 1 && args !== undefined) reports.push(await callTool(params, 'report_result', args));
      return { ok: true, turnId: String(turn), resultText: 'done' };
    });
    const timers = new ManualTimers();
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(root, FRONT), { prompt: '{{ role }}' })),
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: null,
      clock: new ManualClock(),
      timers,
      createAdapter: () => tracker,
      history,
    });
    server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent(), history: { dir: history.dir, pricing } });

    await orchestrator.tickNow();
    const resting = () => {
      const { running, retrying, claimed } = orchestrator.snapshot().counts;
      return running === 0 && (retrying === 1 || claimed === 0);
    };
    for (let i = 0; i < 10; i++) {
      await until(resting, 5_000, 'the pipeline to rest');
      if (orchestrator.snapshot().retrying[0]?.kind !== 'continuation') break;
      const sessions = runner.sessions.length;
      timers.fire(CONTINUATION_DELAY_MS);
      await until(() => runner.sessions.length > sessions || orchestrator.snapshot().counts.claimed === 0, 5_000, 'the next session');
    }
    await until(() => reports.length === 4 && orchestrator.snapshot().counts.running === 0, 5_000, 'all four results');
  });

  after(async () => {
    await server.close();
  });

  it('records all four results and ends in review', () => {
    assert.deepEqual(reports.map((r) => r.ok), [true, true, true, true]);
    assert.equal(tracker.issues.get(ISSUE)?.state, 'In review');
  });

  it('agent page data: every stage of the issue with its verdict, round, target, summary and comment link', async () => {
    const detail = await getJson(server.port, `/api/v1/${encodeURIComponent(IDENTIFIER)}`);
    const rows = detail.results as Array<Record<string, any>>;
    assert.deepEqual(
      rows.map((r) => [r.role, r.kind, r.verdict, r.round, r.target]),
      [
        ['developer', 'implementation', 'done', null, 'Agent review'],
        ['reviewer', 'review', 'changes_needed', 1, 'In progress'],
        ['developer', 'implementation', 'done', null, 'Agent review'],
        ['reviewer', 'review', 'approved', 2, 'In review'],
      ],
    );
    assert.deepEqual(rows.map((r) => r.summary), ['Fixed the crash.', 'One guard is missing.', 'Added the guard.', 'Looks good now.']);
    for (const row of rows) {
      assert.match(String(row.url), /^https?:\/\//, 'every result links to its comment');
      assert.ok(!Number.isNaN(Date.parse(row.created_at)));
    }
    assert.equal(new Set(rows.map((r) => r.url)).size, 4, 'one distinct comment per result');
    assert.deepEqual(rows[1]!.findings, [{ severity: 'major', file: 'src/app.ts', line: 12, problem: 'Missing null guard', fix: 'Add the guard' }]);
    assert.deepEqual(rows[0]!.findings, []);
    assert.deepEqual(rows[3]!.blockers ?? [], []);
  });

  it('the agent page is served with the results section', async () => {
    const page = await request(server.port, 'GET', '/issue');
    assert.equal(page.status, 200);
    assert.match(page.body, /Stage results/);
    assert.match(page.body, /id="result-cards"/);
  });

  it('writes one stage_result line per result, with role, kind, verdict, round, target, profile and complexity', () => {
    const lines = readHistory(historyDir, null).entries.filter((entry) => entry.event === 'stage_result');
    assert.equal(lines.length, 4);
    assert.deepEqual(
      lines.map((l) => [l.fields.role, l.fields.kind, l.fields.verdict, l.fields.round ?? null, l.fields.target]),
      [
        ['developer', 'implementation', 'done', null, 'Agent review'],
        ['reviewer', 'review', 'changes_needed', '1', 'In progress'],
        ['developer', 'implementation', 'done', null, 'Agent review'],
        ['reviewer', 'review', 'approved', '2', 'In review'],
      ],
    );
    for (const line of lines) {
      assert.equal(line.fields.profile, 'bugfix');
      assert.equal(line.fields.complexity, 'M');
      assert.equal(line.fields.issue, IDENTIFIER);
      assert.equal(line.fields.repo, 'acme/app');
    }
  });

  it('GET /api/v1/history/analytics returns by_profile with the verdict distribution of the bugfix profile', async () => {
    const a = await getJson(server.port, '/api/v1/history/analytics');
    assert.ok(Array.isArray(a.by_profile), 'by_profile is an array');
    const bugfix = (a.by_profile as Array<Record<string, any>>).find((p) => p.profile === 'bugfix');
    assert.ok(bugfix, JSON.stringify(a.by_profile));
    assert.equal(bugfix.results, 4);
    assert.equal(bugfix.issues, 1);
    assert.deepEqual(bugfix.verdicts, { 'implementation:done': 2, 'review:changes_needed': 1, 'review:approved': 1 });
    assert.deepEqual(bugfix.by_complexity, { M: 4 });
    assert.equal(bugfix.max_round, 2);
  });

  it('analytics: verdict distribution per role, and repository scoping', async () => {
    const a = await getJson(server.port, '/api/v1/history/analytics');
    const byRole = Object.fromEntries((a.verdicts_by_role as Array<Record<string, any>>).map((r) => [r.role, r.verdicts]));
    assert.deepEqual(byRole, {
      developer: { 'implementation:done': 2 },
      reviewer: { 'review:changes_needed': 1, 'review:approved': 1 },
    });
    // Another repository sees none of it, but still gets the (empty) field.
    const other = await getJson(server.port, '/api/v1/history/analytics?repo=other%2Frepo');
    assert.deepEqual(other.by_profile, []);
    const own = await getJson(server.port, '/api/v1/history/analytics?repo=acme%2Fapp');
    assert.equal(own.by_profile[0].profile, 'bugfix');
  });
});

describe('analytics by_profile: empty and legacy history', () => {
  it('returns an empty by_profile for a history without stage_result lines', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
    const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
    const history = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
    history.note('acme/app', 'workspace_removed', { issue: 'acme/app#1', state: 'Done' });
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
      runner: new FakeRunner(),
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker(),
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent(), history: { dir: history.dir, pricing } });
    try {
      const a = await getJson(server.port, '/api/v1/history/analytics');
      assert.deepEqual(a.by_profile, []);
    } finally {
      await server.close();
    }
  });
});

// The page scripts run in a fake DOM (renderPage); what the user sees (text, classes, links) is asserted.
const AGENT_URL = 'http://127.0.0.1/issue?id=acme%2Fapp%231';
const agentPage = (detail: unknown) => renderPage(AGENT_HTML, { detail }, { url: AGENT_URL });
const links = (node: FakeElement) => node.querySelectorAll('a');

describe('agent page: renderResults', () => {
  const bugfixResults = [
    { role: 'developer', kind: 'implementation', verdict: 'done', round: null, target: 'Agent review', summary: 'Fixed the crash.', created_at: '2026-10-18T05:00:00Z', url: 'https://github.com/acme/app/issues/7#issuecomment-1', findings: [], blockers: [] },
    { role: 'reviewer', kind: 'review', verdict: 'changes_needed', round: 1, target: 'In progress', summary: 'One guard is missing.', created_at: '2026-10-18T05:10:00Z', url: 'https://github.com/acme/app/issues/7#issuecomment-2', findings: [{ severity: 'major', file: 'src/app.ts', line: 12, problem: 'Missing null guard', fix: 'Add the guard' }], blockers: [] },
    { role: 'developer', kind: 'implementation', verdict: 'blocked', round: null, target: 'Blocked', summary: 'Stuck.', created_at: '2026-10-18T05:20:00Z', url: null, findings: [], blockers: [{ description: 'No token', needs: 'access' }] },
    { role: 'reviewer', kind: 'review', verdict: 'approved', round: 2, target: 'In review', summary: 'Good.', created_at: '2026-10-18T05:30:00Z', url: 'javascript:alert(1)', findings: [], blockers: [] },
  ];

  const render = (results: unknown[] | undefined) => {
    const page = agentPage(results === undefined ? null : issueDetail({ results }));
    return { cards: page.$('result-cards').children, section: page.$('results-section'), count: page.$('results-count') };
  };

  it('shows a card per stage result, in order, with role, verdict and round', () => {
    const { cards, section, count } = render(bugfixResults);
    assert.equal(section.hidden, false);
    assert.equal(count.textContent, '4');
    assert.equal(cards.length, 4);
    const texts = cards.map((c) => c.textContent);
    assert.match(texts[0]!, /developer.*implementation.*done/);
    assert.match(texts[1]!, /reviewer.*review.*changes needed · round 1/);
    assert.match(texts[2]!, /developer.*blocked/);
    assert.match(texts[3]!, /reviewer.*approved · round 2/);
    for (const [i, c] of cards.entries()) assert.ok(c.textContent.includes(String(bugfixResults[i]!.summary)), `summary of card ${i}`);
  });

  it('tones the card by verdict', () => {
    const { cards } = render(bugfixResults);
    assert.match(cards[0]!.className, /vd-good/);
    assert.match(cards[1]!.className, /vd-warn/);
    assert.match(cards[2]!.className, /vd-bad/);
    assert.match(cards[3]!.className, /vd-good/);
  });

  it('lists findings with severity, location, problem and fix, and blockers with what they need', () => {
    const { cards } = render(bugfixResults);
    assert.match(cards[1]!.textContent, /major/);
    assert.match(cards[1]!.textContent, /src\/app\.ts:12/);
    assert.match(cards[1]!.textContent, /Missing null guard/);
    assert.match(cards[1]!.textContent, /Add the guard/);
    assert.match(cards[2]!.textContent, /access/);
    assert.match(cards[2]!.textContent, /No token/);
  });

  it('links to the result comment only for http(s) URLs', () => {
    const { cards } = render(bugfixResults);
    assert.equal(links(cards[1]!).length, 1);
    assert.equal(links(cards[1]!)[0]!.href, 'https://github.com/acme/app/issues/7#issuecomment-2');
    assert.equal(links(cards[2]!).length, 0, 'no URL, no link');
    assert.equal(links(cards[3]!).length, 0, 'a javascript: URL is never linked');
  });

  it('hides the section without results, and for an archive row from before the fields existed', () => {
    assert.equal(render([]).section.hidden, true);
    assert.equal(render(undefined).section.hidden, true);
    const legacy = { role: 'developer', kind: 'implementation', verdict: 'done', round: null, target: 'Agent review', summary: 'Old.', created_at: '2026-10-01T00:00:00Z' };
    const { cards } = render([legacy]);
    assert.equal(cards.length, 1);
    assert.equal(links(cards[0]!).length, 0);
  });
});

describe('dashboard card: flagChips', () => {
  const chips = (row: Record<string, unknown>): FakeElement[] => {
    const page = renderPage(DASHBOARD_HTML, dashboardState({ issues: [issueRow(row)] }));
    return page.$('running').querySelectorAll('.chip.flag-human, .chip.flag-budget');
  };

  it('shows a needs human badge for the needs-human label, whatever its case', () => {
    for (const label of ['needs-human', 'Needs-Human', ' needs-human ']) {
      const result = chips({ labels: ['bug', label], budget: null });
      assert.equal(result.length, 1, label);
      assert.match(result[0]!.textContent, /needs human/);
    }
    assert.equal(chips({ labels: ['bug'], budget: null }).length, 0);
    assert.equal(chips({ labels: undefined, budget: undefined }).length, 0);
  });

  it('shows the budget used against the cap, and warns near and over it', () => {
    const [ok] = chips({ labels: [], budget: { cost_usd: 1, max_issue_cost_usd: 10 } });
    assert.equal(ok!.textContent, '$1.00 / $10.00');
    assert.doesNotMatch(ok!.className, /near|over/);
    const [near] = chips({ labels: [], budget: { cost_usd: 8.5, max_issue_cost_usd: 10 } });
    assert.match(near!.className, /near/);
    const [over] = chips({ labels: [], budget: { cost_usd: 12, max_issue_cost_usd: 10 } });
    assert.match(over!.className, /over/);
  });

  it('shows no budget chip without a cap', () => {
    assert.equal(chips({ labels: [], budget: null }).length, 0);
    assert.equal(chips({ labels: [], budget: { cost_usd: 3, max_issue_cost_usd: 0 } }).length, 0);
  });
});

describe('agent page: renderGate', () => {
  const gate = {
    target: 'In review',
    role: 'developer',
    sha: 'abcdef0123456789abcdef',
    started_at: '2026-10-25T10:00:00Z',
    finished_at: null,
    checks: [
      { name: 'lint', status: 'passed', started_at: null, duration_ms: 3000, timeout_ms: 60000, cached: true, exit_code: 0, output: null },
      { name: 'ci', status: 'running', started_at: '2026-10-25T10:00:01Z', duration_ms: 12000, timeout_ms: 120000, cached: false, exit_code: null, output: null },
      { name: 'docs', status: 'check_failed', started_at: '2026-10-25T10:00:02Z', duration_ms: 900, timeout_ms: 60000, cached: false, exit_code: 1, output: '<b>boom</b>' },
      { name: 'smoke', status: 'pending', started_at: null, duration_ms: null, timeout_ms: 60000, cached: false, exit_code: null, output: null },
    ],
  };

  const render = (detail: Record<string, unknown> | null) => {
    const page = agentPage(detail === null ? null : issueDetail(detail));
    return { rows: page.$('gate-checks').children, section: page.$('gate-section'), meta: page.$('gate-meta') };
  };

  it('lists every check with its state, elapsed time against the timeout and the cache flag', () => {
    const { rows, section, meta } = render({ gate });
    assert.equal(section.hidden, false);
    assert.match(meta.textContent, /In review · abcdef012345 · running/);
    assert.equal(rows.length, 4);
    assert.match(rows[0]!.textContent, /lint.*passed.*3\.0s.*from cache/);
    assert.match(rows[1]!.textContent, /ci.*running.*12\.0s \/ 2m/);
    assert.ok(rows[1]!.className.includes('tone-cyan'));
    assert.match(rows[3]!.textContent, /smoke.*pending/);
  });

  it('shows the output of a failed check as plain text', () => {
    const { rows } = render({ gate });
    assert.ok(rows[2]!.className.includes('tone-red'));
    assert.match(rows[2]!.textContent, /failed \(exit 1\)/);
    const pre = rows[2]!.querySelectorAll('pre');
    assert.equal(pre.length, 1);
    assert.equal(pre[0]!.textContent, '<b>boom</b>');
    assert.equal(pre[0]!.children.length, 0);
  });

  it('marks checks that never ran in a finished gate', () => {
    const { rows, meta } = render({ gate: { ...gate, finished_at: '2026-10-25T10:01:00Z' } });
    assert.match(meta.textContent, /finished/);
    assert.match(rows[3]!.textContent, /not run/);
  });

  it('is hidden without a gate', () => {
    for (const detail of [{ gate: null }, null]) {
      const { rows, section } = render(detail);
      assert.equal(section.hidden, true);
      assert.equal(rows.length, 0);
    }
  });
});

describe('dashboard: repositories bar', () => {
  const render = (repositories: unknown) => {
    const page = renderPage(DASHBOARD_HTML, dashboardState({ health: { ...dashboardState().health, repositories } }));
    return page;
  };

  it('renders one text-only link per repository', () => {
    const page = render(['acme/app', 'other/<img onerror=x>']);
    const chips = page.$('repo-list').children;
    assert.equal(chips.length, 2);
    assert.equal(chips[0]!.textContent, 'acme/app');
    assert.equal(chips[0]!.href, 'https://github.com/acme/app');
    assert.equal(chips[1]!.textContent, 'other/<img onerror=x>');
    assert.equal(chips[1]!.children.length, 0);
    assert.equal(page.$('repositories').hidden, false);
  });

  it('says all repositories without a restriction', () => {
    const chips = render(null).$('repo-list').children;
    assert.equal(chips.length, 1);
    assert.equal(chips[0]!.textContent, 'all repositories on the board');
  });

  it('ships the bar and wraps the chips', () => {
    assert.match(DASHBOARD_HTML, /id="repositories"/);
    assert.match(DASHBOARD_HTML, /\.repo-list \{[^}]*flex-wrap: wrap/);
  });
});
