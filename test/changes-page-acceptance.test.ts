import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CHANGES_HTML } from '../src/http/changes-page.ts';
import { startHttpServer } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, renderPage, tempDir, until } from './helpers.ts';
import { changeEntry, changesFixture, dashboardState } from './helpers/page-fixtures.ts';

// Independent acceptance tests for E6-3a (#358), written from the issue text: GET /api/v1/changes and the Changes page.

type Row = Record<string, unknown>;
interface Reply {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function request(port: number, method: string, urlPath: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

const NOW = '2026-10-30T12:00:00Z';

function row(id: string, at: string, over: Row = {}): Row {
  return {
    id, type: 'code', at, repo: 'acme/app', issue: 'acme/app#1', role: 'developer', title: id,
    files: [{ path: 'a.ts', added: 3, deleted: 1, status: 'modified' }], pr: null, diff: null, status: 'committed', ...over,
  };
}

/** Starts the real server on seeded JSONL files (one array of rows per repository file name). */
async function withServer(files: Record<string, Row[]>, run: (port: number) => Promise<void>): Promise<void> {
  const logDir = tempDir();
  fs.mkdirSync(path.join(logDir, 'changes'), { recursive: true });
  for (const [name, rows] of Object.entries(files)) {
    fs.writeFileSync(path.join(logDir, 'changes', name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  const orchestrator = new Orchestrator({
    workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
    runner: new FakeRunner(),
    logger: Logger.silent(),
    env: {},
    logDir,
    timers: new ManualTimers(),
    clock: { now: () => new Date(NOW), monotonicMs: () => 0 },
    createAdapter: () => new FakeTracker([]),
  });
  const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
  try {
    await run(server.port);
  } finally {
    await orchestrator.shutdown(1_000);
    await server.close();
  }
}

const getJson = async (port: number, query: string) => {
  const reply = await request(port, 'GET', `/api/v1/changes?${query}`);
  assert.equal(reply.status, 200, reply.body);
  return JSON.parse(reply.body) as {
    entries: Array<{ id: string; type: string; repo: string; issue: string }>;
    next_before: string | null;
    counts: { all: number; code: number; brain: number };
    stats: null | { today: { commits: number; merges: number; files: number; added: number; deleted: number }; hotspots: Array<{ path: string; repo: string; count: number }> };
  };
};
const ids = (page: { entries: Array<{ id: string }> }) => page.entries.map((e) => e.id);

describe('GET /api/v1/changes (#358 acceptance)', () => {
  const app = [
    row('app-1', '2026-10-30T09:01:00Z'),
    row('app-2', '2026-10-30T09:02:00Z', { issue: 'acme/app#2' }),
    row('app-3', '2026-10-30T09:03:00Z', { type: 'brain', role: 'brain', status: 'committed', files: [{ path: 'brain/n.md', added: 1, deleted: 0, status: 'added' }] }),
    row('app-4', '2026-10-30T09:04:00Z'),
    row('app-5', '2026-10-30T09:05:00Z', { status: 'merged', pr: { number: 9, status: 'success' } }),
  ];
  const lib = [row('lib-1', '2026-10-30T09:06:00Z', { repo: 'acme/lib', issue: 'acme/lib#7' })];
  const files = { 'acme_app.jsonl': app, 'acme_lib.jsonl': lib };

  it('answers with entries (newest first), next_before, counts and stats', async () => {
    await withServer(files, async (port) => {
      const reply = await request(port, 'GET', '/api/v1/changes?tz=UTC');
      assert.equal(reply.status, 200);
      assert.match(String(reply.headers['content-type']), /application\/json/);
      const page = JSON.parse(reply.body);
      for (const key of ['entries', 'next_before', 'counts', 'stats']) assert.ok(key in page, `field ${key}`);
      assert.deepEqual(ids(page), ['lib-1', 'app-5', 'app-4', 'app-3', 'app-2', 'app-1']);
      assert.equal(page.next_before, null);
      assert.deepEqual(page.counts, { all: 6, code: 5, brain: 1 });
      assert.ok(page.stats && typeof page.stats === 'object');
    });
  });

  it('filters by type=code and type=brain, while the counts keep all three numbers', async () => {
    await withServer(files, async (port) => {
      const code = await getJson(port, 'type=code&tz=UTC');
      assert.deepEqual(ids(code), ['lib-1', 'app-5', 'app-4', 'app-2', 'app-1']);
      assert.ok(code.entries.every((e) => e.type === 'code'));
      assert.deepEqual(code.counts, { all: 6, code: 5, brain: 1 });
      const brain = await getJson(port, 'type=brain&tz=UTC');
      assert.deepEqual(ids(brain), ['app-3']);
      assert.deepEqual(brain.counts, { all: 6, code: 5, brain: 1 });
    });
  });

  it('filters by repo and issue; counts follow repo and issue', async () => {
    await withServer(files, async (port) => {
      const repo = await getJson(port, `repo=${encodeURIComponent('acme/lib')}&tz=UTC`);
      assert.deepEqual(ids(repo), ['lib-1']);
      assert.deepEqual(repo.counts, { all: 1, code: 1, brain: 0 });
      const both = await getJson(port, `repo=${encodeURIComponent('acme/app')}&type=code&tz=UTC`);
      assert.deepEqual(ids(both), ['app-5', 'app-4', 'app-2', 'app-1']);
      assert.deepEqual(both.counts, { all: 5, code: 4, brain: 1 });
      const issue = await getJson(port, `issue=${encodeURIComponent('acme/app#2')}&tz=UTC`);
      assert.deepEqual(ids(issue), ['app-2']);
      const none = await getJson(port, `repo=${encodeURIComponent('nope/none')}&tz=UTC`);
      assert.deepEqual(none.entries, []);
      assert.equal(none.next_before, null);
      assert.deepEqual(none.counts, { all: 0, code: 0, brain: 0 });
    });
  });

  it('pages with before/next_before without gaps or duplicates, one entry at a time and in pairs', async () => {
    await withServer(files, async (port) => {
      for (const size of [1, 2, 4]) {
        const seen: string[] = [];
        let before: string | null = null;
        let guard = 0;
        do {
          const page = await getJson(port, `limit=${size}&tz=UTC${before === null ? '' : `&before=${encodeURIComponent(before)}`}`);
          assert.ok(page.entries.length <= size);
          assert.ok(page.entries.length > 0);
          seen.push(...ids(page));
          before = page.next_before;
          if (before !== null) assert.equal(before, page.entries.at(-1)!.id, 'next_before is the id of the last entry of the page');
          assert.ok(++guard < 20, 'paging terminates');
        } while (before !== null);
        assert.deepEqual(seen, ['lib-1', 'app-5', 'app-4', 'app-3', 'app-2', 'app-1'], `limit ${size}`);
      }
    });
  });

  it('next_before is null on an exactly full last page and set on a full page with more behind it', async () => {
    await withServer(files, async (port) => {
      assert.equal((await getJson(port, 'limit=6&tz=UTC')).next_before, null);
      assert.notEqual((await getJson(port, 'limit=5&tz=UTC')).next_before, null);
    });
  });

  it('paging keeps the filter: type=code over several pages', async () => {
    await withServer(files, async (port) => {
      const first = await getJson(port, 'type=code&limit=3&tz=UTC');
      assert.deepEqual(ids(first), ['lib-1', 'app-5', 'app-4']);
      const second = await getJson(port, `type=code&limit=3&tz=UTC&before=${encodeURIComponent(first.next_before!)}`);
      assert.deepEqual(ids(second), ['app-2', 'app-1']);
      assert.equal(second.next_before, null);
      assert.deepEqual(second.counts, first.counts, 'counts do not depend on the page');
    });
  });

  it('delivers stats only on the first page; with before they are empty (null)', async () => {
    await withServer(files, async (port) => {
      const first = await getJson(port, 'limit=2&tz=UTC');
      assert.ok(first.stats);
      const second = await getJson(port, `limit=2&tz=UTC&before=${encodeURIComponent(first.next_before!)}`);
      assert.equal(second.stats, null);
    });
  });

  it('computes today and hotspots from all entries, not only the page, for the day in the time zone', async () => {
    const old = row('old', '2026-10-20T09:00:00Z', { files: [{ path: 'ancient.ts', added: 50, deleted: 50, status: 'modified' }] });
    const yesterday = row('y', '2026-10-29T08:00:00Z', { files: [{ path: 'a.ts', added: 7, deleted: 7, status: 'modified' }] });
    await withServer({ 'acme_app.jsonl': [old, yesterday, ...app] }, async (port) => {
      const page = await getJson(port, 'limit=1&tz=UTC');
      assert.equal(page.entries.length, 1);
      const stats = page.stats!;
      // today (UTC 2026-10-30): app-1, app-2, app-4 are code commits, app-5 is a merge, brain app-3 is not a code change
      assert.equal(stats.today.commits, 3);
      assert.equal(stats.today.merges, 1);
      assert.equal(stats.today.added, 9);
      assert.equal(stats.today.deleted, 3);
      assert.ok(stats.today.files >= 1);
      const a = stats.hotspots.find((h) => h.path === 'a.ts');
      assert.ok(a, 'a.ts is a hotspot');
      assert.ok(a.count >= 4, `a.ts changed in 4+ commits within 7 days, got ${a.count}`);
      assert.ok(!stats.hotspots.some((h) => h.path === 'ancient.ts'), 'older than 7 days is not a hotspot');
      assert.ok(stats.hotspots.length <= 10);
      // Asia/Tokyo (UTC+9): "now" is 21:00 on the 30th, the commits of 09:xx UTC are 18:xx the same day
      const tokyo = await getJson(port, 'limit=1&tz=Asia%2FTokyo');
      assert.equal(tokyo.stats!.today.commits, 3);
      // Pacific/Kiritimati (UTC+14): "now" is already the 31st, so nothing happened today
      const kiri = await getJson(port, 'limit=1&tz=Pacific%2FKiritimati');
      assert.equal(kiri.stats!.today.commits, 0);
      // Pacific/Pago_Pago (UTC-11): "now" is 01:00 on the 30th, the commits of 09:xx UTC are still the 29th
      const pago = await getJson(port, 'limit=1&tz=Pacific%2FPago_Pago');
      assert.equal(pago.stats!.today.commits, 0);
    });
  });

  it('limits hotspots to the 10 most changed files, most changed first', async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 14; i++) {
      for (let k = 0; k <= i; k++) {
        rows.push(row(`h-${i}-${k}`, `2026-10-28T10:${String(i).padStart(2, '0')}:${String(k).padStart(2, '0')}Z`, { files: [{ path: `f${String(i).padStart(2, '0')}.ts`, added: 1, deleted: 0, status: 'modified' }] }));
      }
    }
    await withServer({ 'acme_app.jsonl': rows }, async (port) => {
      const stats = (await getJson(port, 'limit=5&tz=UTC')).stats!;
      assert.equal(stats.hotspots.length, 10);
      assert.deepEqual(stats.hotspots.map((h) => h.count), [14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);
      assert.equal(stats.hotspots[0]!.path, 'f13.ts');
    });
  });

  it('counts are not limited to one page of 200', async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 260; i++) rows.push(row(`bulk-${String(i).padStart(4, '0')}`, new Date(Date.UTC(2026, 9, 29, 0, 0, i)).toISOString()));
    await withServer({ 'acme_app.jsonl': rows }, async (port) => {
      const page = await getJson(port, 'limit=500&tz=UTC');
      assert.ok(page.entries.length <= 200, 'a page never holds more than 200 entries');
      assert.ok(page.entries.length >= 199);
      assert.deepEqual(page.counts, { all: 260, code: 260, brain: 0 });
      const seen = new Set(ids(page));
      let before = page.next_before;
      assert.notEqual(before, null);
      while (before !== null) {
        const next = await getJson(port, `limit=500&tz=UTC&before=${encodeURIComponent(before)}`);
        for (const id of ids(next)) assert.ok(!seen.has(id), `duplicate ${id}`);
        for (const id of ids(next)) seen.add(id);
        before = next.next_before;
      }
      assert.equal(seen.size, 260);
    });
  });

  it('defaults to a page of 50', async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 70; i++) rows.push(row(`d-${String(i).padStart(3, '0')}`, new Date(Date.UTC(2026, 9, 29, 0, 0, i)).toISOString()));
    await withServer({ 'acme_app.jsonl': rows }, async (port) => {
      const page = await getJson(port, 'tz=UTC');
      assert.equal(page.entries.length, 50);
      assert.notEqual(page.next_before, null);
    });
  });

  it('tolerates a non-numeric or non-positive limit and ignores an invalid time zone', async () => {
    await withServer(files, async (port) => {
      for (const limit of ['abc', '0', '-3', '']) {
        const reply = await request(port, 'GET', `/api/v1/changes?limit=${limit}&tz=UTC`);
        assert.ok(reply.status === 200 || reply.status === 400, `limit=${limit}: ${reply.status}`);
        if (reply.status === 200) assert.ok(JSON.parse(reply.body).entries.length >= 1);
      }
      const tz = await request(port, 'GET', '/api/v1/changes?tz=Not%2FAZone');
      assert.ok(tz.status === 200 || tz.status === 400);
    });
  });

  it('rejects an unknown type with 400', async () => {
    await withServer(files, async (port) => {
      for (const type of ['x', 'all', 'CODE']) {
        const reply = await request(port, 'GET', `/api/v1/changes?type=${type}`);
        assert.equal(reply.status, 400, `type=${type}`);
        assert.ok(JSON.parse(reply.body).error);
      }
    });
  });

  it('allows only GET (405 with Allow) and rejects foreign Host headers like the other routes', async () => {
    await withServer(files, async (port) => {
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const reply = await request(port, method, '/api/v1/changes');
        assert.equal(reply.status, 405, method);
        assert.match(String(reply.headers.allow), /GET/);
      }
      const foreign = await request(port, 'GET', '/api/v1/changes', { host: 'evil.example' });
      assert.equal(foreign.status, 403);
      const other = await request(port, 'GET', '/api/v1/budget', { host: 'evil.example' });
      assert.equal(other.status, foreign.status, 'same check as the other routes');
      const loopback = await request(port, 'GET', '/api/v1/changes', { host: 'localhost' });
      assert.equal(loopback.status, 200);
    });
  });

  it('is an empty feed without any recorded change', async () => {
    await withServer({}, async (port) => {
      const page = await getJson(port, 'tz=UTC');
      assert.deepEqual(page.entries, []);
      assert.equal(page.next_before, null);
      assert.deepEqual(page.counts, { all: 0, code: 0, brain: 0 });
      assert.ok(page.stats === null || (page.stats.today.commits === 0 && page.stats.hotspots.length === 0));
    });
  });

  it('serves the /changes page itself', async () => {
    await withServer(files, async (port) => {
      const reply = await request(port, 'GET', '/changes?type=code');
      assert.equal(reply.status, 200);
      assert.match(reply.body, /changes-feed/);
      assert.match(reply.body, /<select/);
    });
  });
});

describe('Changes page render (#358 acceptance)', () => {
  const stateFor = (u: string, repos: string[] = ['acme/app', 'acme/lib']) => (u.startsWith('/api/v1/state') ? dashboardState({ health: { repositories: repos } }) : undefined);
  const open = (data: (u: string) => unknown, url = 'http://127.0.0.1/changes') =>
    renderPage(CHANGES_HTML, undefined, { url, fetch: (u) => stateFor(u) ?? data(u) });
  const changesCalls = (page: ReturnType<typeof renderPage>) => page.fetches.filter((f) => f.url.startsWith('/api/v1/changes'));
  const sel = (page: ReturnType<typeof renderPage>) => page.$('changes-repo') as unknown as { value: string };

  it('has the chips Alle/Code/Brain with counts and a <select> for repositories', async () => {
    const page = open(() => changesFixture());
    await until(() => page.query('.chg').length === 1, 3_000, 'feed');
    const chips = page.query('#changes-types .ui-fchip');
    assert.equal(chips.length, 3);
    assert.match(chips[0]!.textContent, /Alle\s*3/);
    assert.match(chips[1]!.textContent, /Code\s*2/);
    assert.match(chips[2]!.textContent, /Brain\s*1/);
    assert.equal(page.query('select').length, 1);
    assert.deepEqual(page.query('#changes-repo option').map((o) => o.textContent), ['Alle Repositories', 'acme/app', 'acme/lib']);
  });

  it('without a filter in the URL "Alle" is active and no type/repo is requested', async () => {
    const page = open(() => changesFixture());
    await until(() => changesCalls(page).length > 0, 3_000, 'request');
    const chips = page.query('#changes-types .ui-fchip');
    assert.deepEqual(chips.map((c) => c.getAttribute('aria-pressed')), ['true', 'false', 'false']);
    assert.doesNotMatch(changesCalls(page)[0]!.url, /type=|repo=/);
    assert.equal(sel(page).value, '');
  });

  it('takes type and repo from the URL on load and requests them', async () => {
    const page = open(() => changesFixture(), 'http://127.0.0.1/changes?type=brain&repo=acme%2Flib');
    await until(() => changesCalls(page).length > 0, 3_000, 'request');
    assert.deepEqual(page.query('#changes-types .ui-fchip').map((c) => c.getAttribute('aria-pressed')), ['false', 'false', 'true']);
    assert.equal(sel(page).value, 'acme/lib');
    const url = changesCalls(page)[0]!.url;
    assert.match(url, /type=brain/);
    assert.match(url, /repo=acme%2Flib/);
  });

  it('ignores an unknown type in the URL', async () => {
    const page = open(() => changesFixture(), 'http://127.0.0.1/changes?type=bogus');
    await until(() => changesCalls(page).length > 0, 3_000, 'request');
    assert.deepEqual(page.query('#changes-types .ui-fchip').map((c) => c.getAttribute('aria-pressed')), ['true', 'false', 'false']);
    assert.doesNotMatch(changesCalls(page)[0]!.url, /type=bogus/);
  });

  it('a chip click and a repository change reload the feed from the first page with the new filter', async () => {
    const page = open(() => changesFixture({ next_before: 'code:acme/app:abc' }));
    await until(() => page.query('.chg').length === 1, 3_000, 'feed');
    const n = changesCalls(page).length;
    page.click(page.query('#changes-types .ui-fchip')[1]!);
    await until(() => changesCalls(page).length > n, 3_000, 'reload after chip');
    const afterChip = changesCalls(page).at(-1)!.url;
    assert.match(afterChip, /type=code/);
    assert.doesNotMatch(afterChip, /before=/);
    const m = changesCalls(page).length;
    sel(page).value = 'acme/lib';
    page.$('changes-repo').dispatch('change');
    await until(() => changesCalls(page).length > m, 3_000, 'reload after select');
    const afterSelect = changesCalls(page).at(-1)!.url;
    assert.match(afterSelect, /repo=acme%2Flib/);
    assert.match(afterSelect, /type=code/, 'the chip filter stays');
    assert.doesNotMatch(afterSelect, /before=/);
  });

  it('renders a feed entry with time, repo, issue link, role, title, files with bars, PR chip and status chip', async () => {
    const page = open(() =>
      changesFixture({
        entries: [
          changeEntry({
            role: 'developer', title: 'Add feed', status: 'committed', pr: { number: 42, status: 'pending' },
            files: [
              { path: 'src/big.ts', added: 40, deleted: 10, status: 'modified' },
              { path: 'src/small.ts', added: 5, deleted: 0, status: 'added' },
              { path: 'img.png', added: null, deleted: null, status: 'binary' },
            ],
          }),
        ],
      }),
    );
    await until(() => page.query('.chg').length === 1, 3_000, 'entry');
    const card = page.query('.chg')[0]!;
    const text = card.textContent;
    assert.match(text, /acme\/app/);
    assert.match(text, /acme\/app#1/);
    assert.match(text, /Add feed/);
    assert.match(text, /developer/i);
    assert.match(text, /src\/big\.ts/);
    assert.match(text, /\+40/);
    assert.match(text, /[−-]10/);
    assert.match(text, /committed/);
    assert.equal(card.querySelector('a')!.getAttribute('href'), '/issue?id=acme%2Fapp%231');
    assert.ok(card.querySelector('time') || /\d{1,2}[:.]\d{2}/.test(text), 'a time is shown');
    // bars: width proportional to the numbers, the largest file does not exceed 100 %
    const widths = (cls: string) => card.querySelectorAll(cls).map((b) => parseFloat(String(b.style.width)));
    const add = widths('.chg-bar-add');
    const del = widths('.chg-bar-del');
    assert.ok(add.length >= 2 && del.length >= 2);
    assert.ok(add[0]! > add[1]!, 'more added lines give a wider bar');
    assert.ok(add[0]! <= 100 && add[0]! + del[0]! <= 100.5, 'the bar never overflows');
    assert.ok(del[0]! > 0 && del[1] === 0);
    // numbers are monospace
    assert.ok(card.querySelectorAll('.mono').some((n) => /\+40/.test(n.textContent)));
    // PR chip with number
    assert.match(card.querySelector('.chg-pr')!.textContent, /#42/);
  });

  it('colours the PR chip by check status: success green, pending amber, failure red', async () => {
    const tone = async (status: string) => {
      const page = open(() => changesFixture({ entries: [changeEntry({ pr: { number: 3, status } })] }));
      await until(() => page.query('.chg-pr').length === 1, 3_000, `pr ${status}`);
      const chip = page.query('.chg-pr')[0]!;
      return { color: chip.style.color, background: chip.style.background };
    };
    const [ok, pending, failure] = [await tone('success'), await tone('pending'), await tone('failure')];
    assert.ok(ok.color && pending.color && failure.color, 'every status is coloured');
    assert.notEqual(ok.color, pending.color);
    assert.notEqual(pending.color, failure.color);
    assert.notEqual(ok.color, failure.color);
  });

  it('shows the status chip merged vs committed differently', async () => {
    const page = open(() => changesFixture({ entries: [changeEntry({ status: 'merged' }), changeEntry({ id: 'code:acme/app:2', status: 'committed' })] }));
    await until(() => page.query('.chg').length === 2, 3_000, 'entries');
    assert.deepEqual(page.query('.chg-status').map((c) => c.textContent), ['merged', 'committed']);
  });

  it('colours the role by the shared role palette (different roles give different markup)', async () => {
    const page = open(() => changesFixture({ entries: [changeEntry({ role: 'developer' }), changeEntry({ id: 'x2', role: 'tester' })] }));
    await until(() => page.query('.chg').length === 2, 3_000, 'entries');
    const [a, b] = page.query('.chg');
    const roleChip = (card: typeof a) => card!.querySelectorAll('.ui-chip').find((c) => /developer|tester/.test(c.textContent))!;
    assert.ok(roleChip(a) && roleChip(b));
    assert.ok(roleChip(a).style.color, 'the role has a colour');
    assert.notEqual(roleChip(a).style.color, roleChip(b).style.color);
  });

  it('escapes every entry text (title, repo, issue, path) and builds no markup from it', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const page = open(() =>
      changesFixture({
        entries: [changeEntry({ title: evil, repo: evil, issue: `${evil}#1`, role: evil, files: [{ path: evil, added: 1, deleted: 1, status: 'modified' }] })],
      }),
    );
    await until(() => page.query('.chg').length === 1, 3_000, 'entry');
    assert.equal(page.query('img').length, 0);
    assert.ok(page.query('.chg')[0]!.textContent.includes(evil));
    const link = page.query('.chg a')[0]!.getAttribute('href')!;
    assert.ok(link.startsWith('/issue?id='));
    assert.ok(!link.includes('<'), 'the issue id in the link is URL-encoded');
  });

  it('renders brain entries with a note instead of a PR chip, without promote/discard actions', async () => {
    const page = open(() =>
      changesFixture({
        entries: [changeEntry({ id: 'brain:1', type: 'brain', pr: null, role: 'brain', title: 'Learned a thing', files: [{ path: 'brain/thing.md', added: 4, deleted: 0, status: 'added' }], diff: '+a fact' })],
      }),
    );
    await until(() => page.query('.chg').length === 1, 3_000, 'brain entry');
    const card = page.query('.chg')[0]!;
    assert.match(card.textContent, /Learned a thing/);
    assert.equal(card.querySelectorAll('.chg-pr').length, 0);
    assert.equal(card.querySelectorAll('button').length, 0, 'no actions before E6-3b');
    assert.doesNotMatch(card.textContent, /Befördern|Verwerfen|promote|discard/i);
  });

  it('shows "Mehr laden" only with next_before, and a click appends the next page using that id', async () => {
    const none = open(() => changesFixture({ next_before: null }));
    await until(() => none.query('.chg').length === 1, 3_000, 'feed');
    assert.equal(none.query('#changes-more button').length, 0);

    const page = open((u) =>
      u.includes('before=') ? changesFixture({ entries: [changeEntry({ id: 'code:acme/app:2', title: 'Second page' })], next_before: null }) : changesFixture({ next_before: 'cursor-1' }),
    );
    await until(() => page.query('#changes-more button').length === 1, 3_000, 'more');
    assert.match(page.query('#changes-more button')[0]!.textContent, /Mehr laden/);
    page.click(page.query('#changes-more button')[0]!);
    await until(() => page.query('.chg').length === 2, 3_000, 'second page appended');
    assert.match(changesCalls(page).at(-1)!.url, /before=cursor-1/);
    assert.match(page.$('changes-feed').textContent, /Add feed/, 'the first page stays');
    assert.match(page.$('changes-feed').textContent, /Second page/);
    assert.equal(page.query('#changes-more button').length, 0);
  });

  it('shows "Noch keine Änderungen." for an empty feed, without a more button', async () => {
    const page = open(() => changesFixture({ entries: [], next_before: null, counts: { all: 0, code: 0, brain: 0 }, stats: { today: { commits: 0, merges: 0, files: 0, added: 0, deleted: 0 }, hotspots: [] } }));
    await until(() => /Noch keine Änderungen\./.test(page.$('changes-feed').textContent), 3_000, 'empty');
    assert.equal(page.query('.chg').length, 0);
    assert.equal(page.query('#changes-more button').length, 0);
  });

  it('shows "Heute in Zahlen" and the hotspots with their counts from stats', async () => {
    const page = open(() =>
      changesFixture({
        stats: {
          today: { commits: 11, merges: 2, files: 17, added: 123, deleted: 45 },
          hotspots: [{ path: 'src/hot.ts', repo: 'acme/app', count: 9 }, { path: 'src/warm.ts', repo: 'acme/app', count: 4 }],
        },
      }),
    );
    await until(() => /src\/hot\.ts/.test(page.$('changes-hotspots').textContent), 3_000, 'hotspots');
    const today = page.$('changes-today').textContent;
    for (const n of ['11', '2', '17', '123', '45']) assert.ok(today.includes(n), `today shows ${n}: ${today}`);
    assert.match(page.root.textContent, /Heute in Zahlen/);
    assert.match(page.root.textContent, /Hotspots/);
    const items = page.query('#changes-hotspots li');
    assert.equal(items.length, 2);
    assert.match(items[0]!.textContent, /src\/hot\.ts/);
    assert.match(items[0]!.textContent, /9/);
    assert.match(items[1]!.textContent, /4/);
  });

  it('keeps the side figures when a further page (stats null) is appended', async () => {
    const page = open((u) =>
      u.includes('before=') ? changesFixture({ entries: [changeEntry({ id: 'c2' })], next_before: null, stats: null }) : changesFixture({ next_before: 'cursor-1' }),
    );
    await until(() => page.query('#changes-more button').length === 1, 3_000, 'more');
    page.click(page.query('#changes-more button')[0]!);
    await until(() => page.query('.chg').length === 2, 3_000, 'appended');
    assert.match(page.$('changes-hotspots').textContent, /src\/a\.ts/);
  });

  it("disables \"Mehr laden\" on click, so a double click loads the next page only once without duplicates", async () => {
    const page = open((u) =>
      u.includes("before=") ? changesFixture({ entries: [changeEntry({ id: "code:acme/app:2", title: "Second page" })], next_before: null }) : changesFixture({ next_before: "cursor-1" }),
    );
    await until(() => page.query("#changes-more button").length === 1, 3_000, "more");
    const more = page.query("#changes-more button")[0]! as unknown as { disabled?: boolean };
    page.click(more as never);
    assert.equal(more.disabled, true, "the button is disabled right after the click");
    // a real browser does not dispatch clicks on a disabled button
    if (!more.disabled) page.click(more as never);
    await until(() => page.query(".chg").length === 2, 3_000, "second page appended");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(changesCalls(page).filter((f) => f.url.includes("before=")).length, 1);
    assert.equal(page.query(".chg").length, 2, "no entry appears twice");
  });

  it("keeps the loaded entries when a further page fails, shows the error and a retry in #changes-more", async () => {
    let failing = true;
    const page = open((u) => {
      if (!u.includes("before=")) return changesFixture({ next_before: "cursor-1" });
      if (failing) throw new Error("boom");
      return changesFixture({ entries: [changeEntry({ id: "code:acme/app:2", title: "Second page" })], next_before: null });
    });
    await until(() => page.query("#changes-more button").length === 1, 3_000, "more");
    page.click(page.query("#changes-more button")[0]!);
    await until(() => /boom/.test(page.$("changes-more").textContent), 3_000, "error in more");
    assert.equal(page.query(".chg").length, 1, "the first page stays in the feed");
    assert.match(page.$("changes-feed").textContent, /Add feed/);
    assert.doesNotMatch(page.$("changes-feed").textContent, /boom/);
    const retry = page.query("#changes-more button");
    assert.equal(retry.length, 1, "a retry button is offered");
    failing = false;
    page.click(retry[0]!);
    await until(() => page.query(".chg").length === 2, 3_000, "retry appended");
    const calls = changesCalls(page).filter((f) => f.url.includes("before="));
    assert.equal(calls.length, 2);
    assert.match(calls[1]!.url, /before=cursor-1/);
    assert.equal(page.query("#changes-more button").length, 0);
    assert.match(page.$("changes-hotspots").textContent, /src\/a\.ts/, "the side figures stay");
  });

  it('shows a message and no crash when the API fails', async () => {
    const page = renderPage(CHANGES_HTML, undefined, {
      url: 'http://127.0.0.1/changes',
      fetch: (u) => {
        if (u.startsWith('/api/v1/state')) return dashboardState();
        throw new Error('boom');
      },
    });
    await until(() => page.$('changes-feed').textContent.length > 0, 3_000, 'error text');
    assert.equal(page.query('.chg').length, 0);
  });
});

describe('Changes page: issue filter from the URL (#377)', () => {
  it('passes ?issue= to the API and keeps it when the type changes', async () => {
    const page = renderPage(CHANGES_HTML, undefined, { url: 'http://127.0.0.1/changes?issue=acme%2Fapp%231', fetch: () => changesFixture() });
    await until(() => page.fetches.some((f) => f.url.startsWith('/api/v1/changes?')), 3_000, 'first load');
    assert.ok(page.fetches.find((f) => f.url.startsWith('/api/v1/changes?'))!.url.includes('issue=acme%2Fapp%231'));
    page.query('button[data-type="code"]')[0]!.click();
    await until(() => page.fetches.filter((f) => f.url.startsWith('/api/v1/changes?')).length > 1, 3_000, 'second load');
    assert.ok(page.fetches.filter((f) => f.url.startsWith('/api/v1/changes?')).at(-1)!.url.includes('issue=acme%2Fapp%231'));
  });
});
