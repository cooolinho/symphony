import assert from 'node:assert/strict';
import http from 'node:http';
import { after, describe, it } from 'node:test';
import { startHttpServer, type HttpServerHandle } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { AURORA, BOARD_SLOT, LAYOUT_CSS, boardChip, fillBoardSlot, page } from '../src/http/ui/layout.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import type { BoardLink } from '../src/tracker/types.ts';
import { isHttpsUrl } from '../src/util/text.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, tempDir } from './helpers.ts';

const BOARD: BoardLink = { title: 'Pipeline', url: 'https://github.com/users/acme/projects/12' };
const PATHS = ['/', '/changes', '/tasks', '/brain', '/stats', '/issue?id=acme%2Fapp%231'];

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

const shell = page({ aurora: AURORA.overview, title: 't', nav: 'overview', body: '', scripts: '' });

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

describe('isHttpsUrl', () => {
  it('accepts only parsable https URLs', () => {
    assert.equal(isHttpsUrl('https://github.com/orgs/acme/projects/3'), true);
    for (const bad of ['http://github.com/x', 'javascript:alert(1)', '', 'not a url', null, undefined, 5]) assert.equal(isHttpsUrl(bad), false, String(bad));
  });
});

describe('board chip', () => {
  it('renders a new-tab link with a safe rel for users and orgs URLs', () => {
    for (const url of ['https://github.com/users/acme/projects/12', 'https://github.com/orgs/acme/projects/3']) {
      const html = fillBoardSlot(shell, { title: 'Pipeline', url });
      const a = /<a class="sh-chip shell-board"[^>]*>/.exec(html)?.[0] ?? '';
      assert.ok(a.includes(`href="${url}"`), a);
      assert.ok(a.includes('target="_blank"') && a.includes('rel="noopener noreferrer"'), a);
      assert.ok(a.includes('title="Pipeline auf GitHub öffnen"'), a);
      assert.match(a, /aria-label="Board[^"]*"/);
      assert.ok(html.indexOf('id="shell-board"') < html.indexOf('id="shell-version"'));
      assert.ok(!html.includes(BOARD_SLOT));
    }
  });

  it('is absent without a usable URL and leaves the page otherwise unchanged', () => {
    assert.equal(fillBoardSlot(shell, null), shell.replace(BOARD_SLOT, ''));
    assert.ok(!fillBoardSlot(shell, null).includes('id="shell-board"'));
    for (const url of ['http://github.com/x', 'javascript:alert(1)', '', 'nope']) assert.equal(boardChip({ title: 'x', url }), '', url);
  });

  it('falls back to a generic title', () => {
    const a = boardChip({ title: '  ', url: BOARD.url });
    assert.ok(a.includes('title="Board auf GitHub öffnen"'));
    assert.ok(a.includes('aria-label="Board auf GitHub öffnen (neuer Tab)"'));
  });

  it('escapes title and URL and keeps $-patterns literal', () => {
    const a = boardChip({ title: '<b>"x"</b> $& $\'', url: 'https://github.com/a"b' });
    assert.ok(!a.includes('<b>'));
    assert.ok(a.includes('&lt;b&gt;&quot;x&quot;&lt;/b&gt;'));
    assert.ok(a.includes('href="https://github.com/a&quot;b"'));
    const html = fillBoardSlot(shell, { title: "$& $'", url: BOARD.url });
    assert.ok(html.includes('$&amp; $&#39;'));
  });

  it('stays visible on narrow screens', () => {
    const media = /@media \(max-width: 640px\) \{([\s\S]*?)\n  \}/.exec(LAYOUT_CSS)?.[1] ?? '';
    assert.ok(media.length > 0);
    assert.ok(!media.includes('shell-board'));
  });
});

describe('board link through orchestrator and HTTP', () => {
  it('shows the chip exactly once in the header of every page and in /api/v1/state', async () => {
    const { server } = await boot(async () => BOARD);
    for (const path of PATHS) {
      const res = await get(server.port, path);
      assert.equal(res.status, 200, path);
      assert.equal((res.body.match(/id="shell-board"/g) ?? []).length, 1, path);
      assert.ok(!res.body.includes(BOARD_SLOT), path);
      const meta = /<div class="shell-meta">([\s\S]*?)<\/div>/.exec(res.body)?.[1] ?? '';
      assert.ok(meta.includes('id="shell-board"'), path);
    }
    const state = JSON.parse((await get(server.port, '/api/v1/state')).body) as { tracker: { board: BoardLink | null } };
    assert.deepEqual(state.tracker.board, BOARD);
  });

  it('loads the link once per workflow version', async () => {
    let calls = 0;
    const { orchestrator } = await boot(async () => (++calls, BOARD));
    await orchestrator.tickNow();
    assert.equal(calls, 1);
    assert.deepEqual(orchestrator.boardLink(), BOARD);
    assert.deepEqual(orchestrator.snapshot().tracker.board, BOARD);
  });

  it('shows no link and no error for a tracker without board, with a failing board and with a non-https URL', async () => {
    const cases: Array<(() => Promise<BoardLink | null>) | undefined> = [
      undefined,
      async () => {
        throw new Error('boom');
      },
      async () => null,
    ];
    for (const board of cases) {
      const { orchestrator, server } = await boot(board);
      for (const path of PATHS) {
        const res = await get(server.port, path);
        assert.equal(res.status, 200, path);
        assert.ok(!res.body.includes('id="shell-board"'), path);
        assert.ok(!res.body.includes(BOARD_SLOT), path);
      }
      const snap = orchestrator.snapshot();
      assert.equal(snap.tracker.board, null);
      assert.deepEqual(snap.health.dispatch_errors, []);
      assert.equal(snap.health.last_tracker_error, null);
    }
  });
});
