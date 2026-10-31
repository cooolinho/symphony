import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { startHttpServer } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { collectActivity, type ActivitySource } from '../src/orchestrator/activity.ts';
import { Orchestrator, type TimelineEvent } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, baseFront, makeIssue, makeWorkflow, renderPage, tempDir, until } from './helpers.ts';
import { dashboardState } from './helpers/page-fixtures.ts';

// Acceptance tests for "Agent-Aktivität der letzten 30 Minuten" (derived from the issue, not from the implementation).

const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
let seq = 0;
const tl = (at: string, run: string | null, event = 'tool_use', kind: TimelineEvent['kind'] = 'agent'): TimelineEvent => ({
  seq: ++seq, at, kind, event, level: 'info', message: null, run, turn: 1, detail: null,
});

function get(port: number, path: string, method = 'GET'): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: body.startsWith('{') ? JSON.parse(body) : body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('activity collection (two issues, three events, one older than 30 min)', () => {
  const sources: ActivitySource[] = [
    { identifier: 'acme/app#1', sessions: [{ run: 'a', role: 'developer' }], timeline: [tl(ago(40), 'a'), tl(ago(12), 'a')] },
    { identifier: 'acme/app#2', sessions: [{ run: 'b', role: 'reviewer' }], timeline: [tl(ago(3), 'b')] },
  ];

  it('returns exactly two entries { at, role, issue } for the events within the window', () => {
    const out = collectActivity(sources, NOW - 30 * 60_000, NOW);
    assert.deepEqual(out, [
      { at: ago(12), role: 'developer', issue: 'acme/app#1' },
      { at: ago(3), role: 'reviewer', issue: 'acme/app#2' },
    ]);
  });

  it('sorts across issues by time even when the sources are listed in another order', () => {
    const out = collectActivity([...sources].reverse(), NOW - 30 * 60_000, NOW);
    assert.deepEqual(out.map((e) => e.issue), ['acme/app#1', 'acme/app#2']);
  });

  it('includes an event exactly at the window start and drops one just before it', () => {
    const edge: ActivitySource = { identifier: 'x#1', sessions: [{ run: 'r', role: 'developer' }], timeline: [tl(ago(30), 'r'), tl(new Date(NOW - 30 * 60_000 - 1).toISOString(), 'r')] };
    assert.equal(collectActivity([edge], NOW - 30 * 60_000, NOW).length, 1);
  });

  it('ignores non-tool_use events, non-agent kinds, and unparsable timestamps', () => {
    const noisy: ActivitySource = {
      identifier: 'x#2',
      sessions: [{ run: 'r', role: 'developer' }],
      timeline: [tl(ago(1), 'r', 'message'), tl(ago(1), 'r', 'tool_use', 'lifecycle'), tl('not-a-date', 'r'), tl(ago(1), 'r')],
    };
    assert.equal(collectActivity([noisy], NOW - 30 * 60_000, NOW).length, 1);
  });

  it('returns an empty list without sources', () => {
    assert.deepEqual(collectActivity([], NOW - 30 * 60_000, NOW), []);
  });
});

describe('Orchestrator.activity / GET /api/v1/activity', () => {
  async function setup() {
    const clock = new ManualClock();
    clock.wall = Date.now() + 60_000; // the event is one minute old; a frozen clock must not lie before it
    const runner = new FakeRunner((turn, params) => {
      params.onEvent({ event: 'tool_use', timestamp: new Date(), pid: 1, threadId: 't', turnId: '1', sessionId: 't-1', turnCount: turn, message: 'Read: x', detail: { tool: 'Read' } });
      return new Promise(() => undefined);
    });
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: tempDir(),
      timers: new ManualTimers(),
      clock,
      createAdapter: () => new FakeTracker([makeIssue({ id: 'live' })]),
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    await orchestrator.tickNow();
    await until(() => (orchestrator.issueTimeline('live')?.events ?? []).some((e) => e.event === 'tool_use'), 3_000, 'tool_use event');
    return { clock, orchestrator, server };
  }

  it('drops events once they are older than the requested window and reports window metadata', async () => {
    const { clock, orchestrator, server } = await setup();
    try {
      const fresh = await get(server.port, '/api/v1/activity?minutes=30');
      assert.equal(fresh.status, 200);
      assert.equal(fresh.json.events.length, 1);
      assert.equal(fresh.json.events[0].issue, 'acme/app#live');
      assert.equal(typeof fresh.json.events[0].role, 'string');
      assert.ok(Number.isFinite(Date.parse(fresh.json.events[0].at)));
      assert.equal(Date.parse(fresh.json.generated_at) - Date.parse(fresh.json.since), 30 * 60_000);

      clock.advance(10 * 60_000);
      assert.equal((await get(server.port, '/api/v1/activity?minutes=30')).json.events.length, 1);
      assert.equal((await get(server.port, '/api/v1/activity?minutes=5')).json.events.length, 0, 'older than 5 min');
      clock.advance(25 * 60_000);
      assert.equal((await get(server.port, '/api/v1/activity?minutes=30')).json.events.length, 0, 'older than 30 min');
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });

  it('falls back to 30 minutes for missing, zero, negative or non-numeric minutes and caps huge values', async () => {
    const { orchestrator, server } = await setup();
    try {
      for (const q of ['', '?minutes=', '?minutes=0', '?minutes=-5', '?minutes=abc']) {
        assert.equal((await get(server.port, `/api/v1/activity${q}`)).json.minutes, 30, q);
      }
      const big = (await get(server.port, '/api/v1/activity?minutes=100000')).json.minutes;
      assert.ok(big > 30 && big <= 1440, `capped: ${big}`);
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });

  it('allows only GET', async () => {
    const { orchestrator, server } = await setup();
    try {
      for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await get(server.port, '/api/v1/activity', method)).status, 405, method);
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });

  it('does not shadow the per-issue routes', async () => {
    const { orchestrator, server } = await setup();
    try {
      assert.equal((await get(server.port, '/api/v1/live/timeline')).status, 200);
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });
});

describe('overview chart rendering', () => {
  const ev = (at: string, role: string, issue = 'acme/app#1') => ({ at, role, issue });
  const payload = (events: unknown[], minutes = 30) => ({
    generated_at: '2026-10-30T12:00:00.000Z', minutes, since: new Date(NOW - minutes * 60_000).toISOString(), events,
  });
  const open = (data: unknown | (() => unknown)) =>
    renderPage(DASHBOARD_HTML, dashboardState(), {
      fetch: (url) => (url.startsWith('/api/v1/activity') ? (typeof data === 'function' ? (data as () => unknown)() : data) : dashboardState()),
    });
  const lines = (page: ReturnType<typeof renderPage>) => page.query('#tool-activity-chart line').filter((l) => l.className.includes('role-'));
  const settle = () => new Promise((r) => setTimeout(r, 30));

  const data = payload([
    ev(ago(20), 'developer'), ev(ago(20), 'developer'), ev(ago(20), 'developer'), ev(ago(10), 'reviewer'), ev(ago(10), 'reviewer'),
  ]);

  it('has an svg with role="img", one stroke per call with a role class, inside the 30-minute viewBox', async () => {
    const page = open(data);
    await until(() => lines(page).length === 5, 3_000, 'strokes');
    const svg = page.$('tool-activity-chart');
    assert.equal(svg.tagName.toLowerCase(), 'svg');
    assert.equal(svg.getAttribute('role'), 'img');
    const width = Number((svg.getAttribute('viewBox') ?? '').split(/\s+/)[2]);
    assert.ok(width > 0);
    assert.equal(lines(page).filter((l) => l.className.includes('role-developer')).length, 3);
    assert.equal(lines(page).filter((l) => l.className.includes('role-reviewer')).length, 2);
    for (const l of lines(page)) {
      const x = Number(l.getAttribute('x1'));
      assert.ok(x >= 0 && x <= width, `x1 ${x} inside 0..${width}`);
      assert.equal(l.getAttribute('x1'), l.getAttribute('x2'), 'vertical');
    }
  });

  it('places later calls further right and keeps same-minute strokes apart', async () => {
    const page = open(data);
    await until(() => lines(page).length === 5, 3_000, 'strokes');
    const xs = (role: string) => lines(page).filter((l) => l.className.includes(`role-${role}`)).map((l) => Number(l.getAttribute('x1')));
    const dev = xs('developer');
    const rev = xs('reviewer');
    assert.equal(new Set(dev).size, 3, 'three same-minute strokes are distinct');
    assert.equal(new Set(rev).size, 2);
    assert.ok(Math.max(...dev) < Math.min(...rev), 'minute -20 is left of minute -10');
  });

  it('shows a legend entry per occurring role only, with colour swatch and name', async () => {
    const page = open(data);
    await until(() => lines(page).length === 5, 3_000, 'strokes');
    const keys = page.query('#tool-activity-legend .act-key');
    assert.equal(keys.length, 2);
    const text = keys.map((k) => k.textContent ?? '').join('|');
    assert.match(text, /Developer/);
    assert.match(text, /Reviewer/);
    assert.doesNotMatch(text, /Architect|Analyst/);
    assert.ok(keys.every((k) => k.className.includes('role-')), 'legend entries carry the role colour class');
  });

  it('puts the totals into the aria-label (total and per role) and hides the empty text', async () => {
    const page = open(data);
    await until(() => lines(page).length === 5, 3_000, 'strokes');
    const label = page.$('tool-activity-chart').getAttribute('aria-label') ?? '';
    assert.match(label, /5 tool calls in 30 minutes/);
    assert.match(label, /Developer 3/);
    assert.match(label, /Reviewer 2/);
    assert.equal(page.$('tool-activity-empty').hidden, true);
  });

  it('shows "No activity in the last 30 minutes." for an empty answer', async () => {
    const page = open(payload([]));
    await until(() => page.fetches.some((f) => f.url.startsWith('/api/v1/activity')), 3_000, 'fetch');
    await settle();
    assert.equal(page.$('tool-activity-empty').hidden, false);
    assert.equal(page.$('tool-activity-empty').textContent, 'No activity in the last 30 minutes.');
    assert.equal(lines(page).length, 0);
  });

  it('does not crash on a malformed answer and still renders the rest of the page', async () => {
    for (const bad of [null, {}, { events: 'nope' }]) {
      const page = open(bad);
      await until(() => page.fetches.some((f) => f.url.startsWith('/api/v1/activity')), 3_000, 'fetch');
      await settle();
      assert.equal(lines(page).length, 0);
      assert.ok(page.$('tool-activity-empty'));
    }
  });

  it('survives a failing first request', async () => {
    const page = open(() => { throw new Error('down'); });
    await until(() => page.fetches.some((f) => f.url.startsWith('/api/v1/activity')), 3_000, 'fetch');
    await settle();
    assert.equal(lines(page).length, 0);
  });

  it('requests /api/v1/activity?minutes=30 once on load and reloads on its own 30 s interval, leaving the 2 s poll alone', async () => {
    const page = open(data);
    await until(() => lines(page).length === 5, 3_000, 'strokes');
    assert.ok(page.fetches.some((f) => f.url === '/api/v1/activity?minutes=30'));
    assert.equal(page.fetches.filter((f) => f.url.startsWith('/api/v1/activity')).length, 1);
    const ms = page.intervals.map((i) => i.ms);
    assert.ok(ms.includes(30_000));
    assert.ok(ms.includes(2_000), 'the existing 2 s state poll is still there');
    const state = page.fetches.filter((f) => f.url.startsWith('/api/v1/state')).length;
    assert.ok(state >= 1);
  });

  it('replaces the strokes on a reload instead of accumulating them', async () => {
    let current: unknown = data;
    const page = open(() => current);
    await until(() => lines(page).length === 5, 3_000, 'strokes');
    current = payload([ev(ago(2), 'developer')]);
    const poll = page.intervals.find((i) => i.ms === 30_000 && i.fn.name === 'loadToolActivity')!;
    await poll.fn();
    assert.equal(lines(page).length, 1);
    assert.equal(page.query('#tool-activity-legend .act-key').length, 1);
    assert.match(page.$('tool-activity-chart').getAttribute('aria-label') ?? '', /1 tool call/);
    current = payload([]);
    await poll.fn();
    assert.equal(lines(page).length, 0);
    assert.equal(page.$('tool-activity-empty').hidden, false);
  });

  it('inserts role and issue text as text, never as HTML', async () => {
    const page = open(payload([ev(ago(1), '<b id="pwn">x</b>', '<i>#1</i>')]));
    await until(() => lines(page).length === 1, 3_000, 'stroke');
    const legend = page.query('#tool-activity-legend .act-key')[0]!;
    assert.ok((legend.textContent ?? '').includes('<b id="pwn">x</b>'));
    assert.equal(page.query('#tool-activity b').length, 0);
    assert.equal(page.query('#tool-activity i').length, 0);
  });
});
