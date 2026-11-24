// Unabhängige Tests zu #604 (Board-Link im Dashboard-Kopf), abgeleitet aus Issue und Akzeptanzkriterien.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { after, describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/issue-page.ts';
import { BRAIN_HTML } from '../src/http/brain-page.ts';
import { CHANGES_HTML } from '../src/http/changes-page.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { startHttpServer, type HttpServerHandle } from '../src/http/server.ts';
import { TASKS_HTML } from '../src/http/tasks-page.ts';
import { LAYOUT_CSS } from '../src/http/ui/layout.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import type { BoardLink } from '../src/tracker/types.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, tempDir } from './helpers.ts';

const BOARD: BoardLink = { title: 'Symphony Pipeline', url: 'https://github.com/orgs/acme/projects/7' };
const PAGES: Array<[string, string, string]> = [
  ['Übersicht', '/', DASHBOARD_HTML],
  ['Changes', '/changes', CHANGES_HTML],
  ['Tasks', '/tasks', TASKS_HTML],
  ['Brain', '/brain', BRAIN_HTML],
  ['Logs', '/stats', LOGS_HTML],
  ['Issue', '/issue?id=acme%2Fapp%231', AGENT_HTML],
];

function request(port: number, path: string, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .request({ host: '127.0.0.1', port, path, method }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject)
      .end();
  });
}

const servers: HttpServerHandle[] = [];
after(async () => {
  for (const s of servers) await s.close();
});

async function boot(board?: () => Promise<BoardLink | null>) {
  const tracker = new FakeTracker();
  if (board !== undefined) tracker.board = board;
  const orchestrator = new Orchestrator({
    workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
    runner: new FakeRunner(),
    logger: Logger.silent(),
    env: {},
    logDir: tempDir(),
    timers: new ManualTimers(),
    createAdapter: () => tracker,
  });
  await orchestrator.tickNow();
  const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
  servers.push(server);
  return { orchestrator, server };
}

function headerChip(html: string): string {
  const meta = /<div class="shell-meta">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  return /<a [^>]*id="shell-board"[^>]*>[\s\S]*?<\/a>/.exec(meta)?.[0] ?? '';
}

describe('#604 Board link: every dashboard page carries the header slot', () => {
  for (const [name, , html] of PAGES) {
    it(`${name}: slot sits in shell-meta before the version chip, exactly once`, () => {
      const meta = /<div class="shell-meta">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
      assert.ok(meta.length > 0, 'shell-meta missing');
      const occurrences = html.split('<!--shell-board-->').length - 1;
      assert.equal(occurrences, 1);
      assert.ok(meta.includes('<!--shell-board-->'));
      assert.ok(meta.indexOf('<!--shell-board-->') < meta.indexOf('shell-version'));
    });
  }
});

describe('#604 Board link: served pages', () => {
  it('every page shows an accessible new-tab link to the board URL', async () => {
    const { server } = await boot(async () => BOARD);
    for (const [name, path] of PAGES) {
      const res = await request(server.port, path);
      assert.equal(res.status, 200, name);
      const a = headerChip(res.body);
      assert.notEqual(a, '', `${name}: no board link in the header`);
      assert.match(a, /class="[^"]*\bsh-chip\b[^"]*"/, name);
      assert.ok(a.includes(`href="${BOARD.url}"`), name);
      assert.match(a, /target="_blank"/, name);
      assert.match(a, /rel="[^"]*noopener[^"]*"/, name);
      assert.match(a, /rel="[^"]*noreferrer[^"]*"/, name);
      assert.match(a, /title="Symphony Pipeline auf GitHub öffnen"/, name);
      assert.match(a, /aria-label="[^"]*Symphony Pipeline[^"]*"/, name);
      assert.match(a, />\s*Board/, name);
    }
  });

  it('HEAD still works', async () => {
    const { server } = await boot(async () => BOARD);
    assert.equal((await request(server.port, '/', 'HEAD')).status, 200);
  });

  it('a board title with markup cannot break out of the attributes', async () => {
    const evil = '"><script>alert(1)</script>';
    const { server } = await boot(async () => ({ title: evil, url: BOARD.url }));
    const res = await request(server.port, '/tasks');
    assert.ok(!res.body.includes(evil));
    const a = headerChip(res.body);
    assert.ok(a.includes('&lt;script&gt;'));
    assert.ok(!/<a [^>]*id="shell-board"[^>]*>[^<]*<script/.test(res.body));
  });

  it('a non-https URL from the tracker produces no link on any page', async () => {
    for (const url of ['http://github.com/orgs/acme/projects/7', 'javascript:alert(1)', 'data:text/html,x', '//github.com/x', '']) {
      const { server } = await boot(async () => ({ title: 'x', url }));
      for (const [name, path] of PAGES) {
        const res = await request(server.port, path);
        assert.equal(res.status, 200, name);
        assert.equal(headerChip(res.body), '', `${name} ${url}`);
        assert.ok(!res.body.includes('id="shell-board"'), `${name} ${url}`);
        assert.ok(!res.body.includes('<!--shell-board-->'), `${name} ${url}`);
        assert.ok(!res.body.includes('javascript:alert(1)'), `${name} ${url}`);
      }
    }
  });

  it('without a board method the pages render like the shell without the slot', async () => {
    const { server } = await boot(undefined);
    for (const [name, path, html] of PAGES) {
      const res = await request(server.port, path);
      assert.equal(res.body, html.replace('<!--shell-board-->', ''), name);
    }
  });

  it('a failed first load is retried on a later poll and then shows the link', async () => {
    let calls = 0;
    const { orchestrator, server } = await boot(async () => {
      if (++calls === 1) throw new Error('transient');
      return BOARD;
    });
    assert.equal(orchestrator.snapshot().tracker.board, null);
    assert.equal(headerChip((await request(server.port, '/')).body), '');
    await orchestrator.tickNow();
    assert.deepEqual(orchestrator.snapshot().tracker.board, BOARD);
    assert.notEqual(headerChip((await request(server.port, '/')).body), '');
  });
});

describe('#604 /api/v1/state', () => {
  it('exposes tracker.board with title and url, null when unknown', async () => {
    const known = await boot(async () => BOARD);
    const state = JSON.parse((await request(known.server.port, '/api/v1/state')).body) as { tracker: { board: BoardLink | null } };
    assert.deepEqual(state.tracker, { board: BOARD });
    for (const board of [undefined, async () => null]) {
      const unknown = await boot(board);
      const s = JSON.parse((await request(unknown.server.port, '/api/v1/state')).body) as { tracker: { board: BoardLink | null } };
      assert.deepEqual(s.tracker, { board: null });
    }
  });
});

describe('#604 layout CSS', () => {
  it('uses the sh-chip look and is not hidden on narrow screens', () => {
    assert.match(LAYOUT_CSS, /\.sh-chip \{[^}]*white-space: nowrap/);
    const media = /@media \(max-width: 640px\) \{([\s\S]*?)\n  \}/.exec(LAYOUT_CSS)?.[1] ?? '';
    assert.ok(media.length > 0);
    assert.ok(!/shell-board[^{]*\{[^}]*display:\s*none/.test(media));
    assert.ok(!/\.sh-chip[^{]*\{[^}]*display:\s*none/.test(media));
  });
});

describe('#604 documentation', () => {
  const usage = readFileSync(new URL('../docs/usage.md', import.meta.url), 'utf8');

  it('docs/usage.md names the board link in the dashboard section and the API field', () => {
    const section = usage.slice(usage.indexOf('## Dashboard and API'));
    assert.match(section, /Board ↗/);
    assert.match(section, /tracker\.board/);
    assert.match(section, /target="_blank"/);
  });

  it('the board paragraph does not tear the sentence "It listens on the address from `SYMPHONY_HOST`" apart', () => {
    const at = usage.indexOf('It listens on the address');
    assert.ok(at > 0);
    const rest = usage.slice(at + 'It listens on the address'.length);
    assert.match(rest, /^\s*from `SYMPHONY_HOST`/);
  });
});
