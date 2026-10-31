import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildChangesPage, changeCounts } from '../src/changes/feed.ts';
import type { ChangeEntry } from '../src/changes/types.ts';
import { CHANGES_HTML } from '../src/http/changes-page.ts';
import { startHttpServer } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, renderPage, tempDir, until } from './helpers.ts';
import { brainChangeEntry, changeEntry, changesFixture, dashboardState } from './helpers/page-fixtures.ts';

// Independent tests for #376 (Brain entries and candidate actions in the Changes feed), derived from the issue text only.

type Page = ReturnType<typeof renderPage>;
type Obj = Record<string, unknown>;
const NOW = '2026-10-30T12:00:00Z';

const CAND = { path: 'Inbox/idea.md', title: 'Idee' };
const note = (over: Obj = {}) => brainChangeEntry(over);
const conflict = (reason: string, id = `brain:conflict:${reason}`) => note({ id, status: 'conflict', reason, clash_id: id, diff: null, title: 'Abgewiesen ' + reason });

interface Opts {
  entries?: unknown[];
  candidates?: () => unknown;
  controls?: unknown;
  noControlsKey?: boolean;
  post?: () => unknown;
  url?: string;
  counts?: unknown;
  stats?: unknown;
  confirm?: boolean;
  noBrain?: boolean;
}
function open(o: Opts = {}): Page {
  const state = dashboardState(o.noControlsKey ? {} : { controls: o.controls ?? { retry: true } });
  if (o.noControlsKey) delete (state as Obj).controls;
  return renderPage(CHANGES_HTML, undefined, {
    url: o.url ?? 'http://127.0.0.1/changes',
    ...(o.confirm === undefined ? {} : { confirm: o.confirm }),
    fetch: (u, init) => {
      if (init.method === 'POST') return o.post ? o.post() : {};
      if (u.startsWith('/api/v1/state')) return state;
      if (u.startsWith('/api/v1/brain/vitals')) return o.noBrain ? { __status: 404, error: { code: 'brain_disabled' } } : { obsidian_url: null };
      if (u.startsWith('/api/v1/brain/candidates')) return o.candidates ? o.candidates() : { candidates: [CAND] };
      return changesFixture({ entries: o.entries ?? [], ...(o.counts ? { counts: o.counts } : {}), ...(o.stats ? { stats: o.stats } : {}) });
    },
  });
}
const cards = (p: Page) => p.query('.chg');
const cardOf = (p: Page, id: string) => cards(p).find((c) => c.dataset.id === id)!;
const buttonLabels = (p: Page) => p.query('button').map((b) => b.textContent).filter((t) => t === 'Befördern' || t === 'Verwerfen');
const feedLoaded = (p: Page, n: number) => until(() => cards(p).length === n, 3_000, `feed with ${n} cards`);
const changesCalls = (p: Page) => p.fetches.filter((f) => f.url.startsWith('/api/v1/changes'));

describe('#376 Brain entries: content', () => {
  it('shows title, path, role, issue and the kind chip for every status', async () => {
    const statuses: Array<[string, string]> = [
      ['created', 'Notiz neu'], ['updated', 'Notiz geändert'], ['approved', 'Befördert'], ['rejected_candidate', 'Verworfen'], ['human', 'Notiz geändert'], ['conflict', 'Schreiben abgewiesen'],
    ];
    const entries = statuses.map(([status], i) =>
      note({ id: `n${i}`, status, title: `Titel ${status}`, files: [{ path: `Area/${status}.md`, added: 1, deleted: 0, status: 'added' }], ...(status === 'conflict' ? { reason: 'window', diff: null } : {}) }),
    );
    const p = open({ entries, candidates: () => ({ candidates: [] }) });
    await feedLoaded(p, 6);
    statuses.forEach(([status, label], i) => {
      const c = cardOf(p, `n${i}`);
      assert.equal(c.querySelector('.chg-kind')!.textContent, label, status);
      assert.ok(c.textContent.includes(`Titel ${status}`));
      if (status !== 'conflict') assert.ok(c.textContent.includes('Area'));
      assert.ok(c.textContent.includes('developer'));
      assert.ok(c.textContent.includes('acme/app#1'));
    });
  });

  it('renders the diff excerpt in monospace with + green and - red, at most 5 lines', async () => {
    const diff = 'Inbox/idea.md\n' + ['+a', '-b', '+c', '-d', '+e', '+f', '-g', '+h'].join('\n');
    const p = open({ entries: [note({ diff })], candidates: () => ({ candidates: [] }) });
    await feedLoaded(p, 1);
    const block = p.query('.chg-diff')[0]!;
    assert.ok(/mono/.test(String(block.className)), 'monospace class');
    const shown = block.textContent;
    assert.ok(!shown.includes('Inbox/idea.md'), 'path header line is not part of the excerpt');
    assert.ok(!shown.includes('+h'), 'line 8 is cut off');
    assert.equal(p.query('.chg-dl-add').length + p.query('.chg-dl-del').length, 5);
    assert.equal(p.query('.chg-dl-add').length, 3);
    assert.equal(p.query('.chg-dl-del').length, 2);
    for (const l of p.query('.chg-dl-add')) assert.match(l.textContent, /^\+/);
    for (const l of p.query('.chg-dl-del')) assert.match(l.textContent, /^[-−]/);
  });

  it('renders no empty diff block for an entry without a diff or with an empty one', async () => {
    const p = open({ entries: [note({ id: 'a', diff: null }), note({ id: 'b', diff: '' }), note({ id: 'c', diff: 'only/header.md' })], candidates: () => ({ candidates: [] }) });
    await feedLoaded(p, 3);
    assert.equal(p.query('.chg-diff').length, 0);
  });

  it('treats vault text as text, never as markup', async () => {
    const p = open({
      entries: [note({ title: '<img src=x onerror=alert(1)>', diff: '+<script>alert(1)</script>' })],
      candidates: () => ({ candidates: [] }),
    });
    await feedLoaded(p, 1);
    assert.equal(p.query('img').length, 0);
    assert.equal(p.query('script').filter((s) => s.textContent.includes('alert')).length, 0);
    assert.ok(cards(p)[0]!.textContent.includes('<img src=x onerror=alert(1)>'));
  });
});

describe('#376 Conflicts', () => {
  it('shows conflicts in red with reason; other entries stay neutral', async () => {
    const entries = [conflict('hash_mismatch'), conflict('window'), note({ id: 'plain' }), changeEntry({ id: 'code1' })];
    const p = open({ entries, candidates: () => ({ candidates: [] }) });
    await feedLoaded(p, 4);
    for (const reason of ['hash_mismatch', 'window']) {
      const c = cardOf(p, `brain:conflict:${reason}`);
      assert.ok(c.classList.contains('chg-conflict'), `${reason} is red`);
      assert.match(c.querySelector('.chg-meta')!.textContent, reason === 'window' ? /Schutzfenster/ : /Hash-Konflikt/);
      assert.equal(c.querySelector('.chg-status')!.textContent, 'Konflikt');
    }
    assert.ok(!cardOf(p, 'plain').classList.contains('chg-conflict'));
    assert.ok(!cardOf(p, 'code1').classList.contains('chg-conflict'));
  });

  it('does not crash on a conflict with an unknown or missing reason', async () => {
    const p = open({ entries: [conflict('weird_reason', 'x1'), note({ id: 'x2', status: 'conflict', diff: null })], candidates: () => ({ candidates: [] }) });
    await feedLoaded(p, 2);
    assert.match(cardOf(p, 'x1').querySelector('.chg-meta')!.textContent, /Hash-Konflikt/);
    assert.ok(cardOf(p, 'x2').classList.contains('chg-conflict'));
  });
});

describe('#376 Candidate actions', () => {
  const MIXED = [
    changeEntry({ id: 'code1' }),
    note({ id: 'cand' }),
    note({ id: 'other', title: 'Andere', files: [{ path: 'Decisions/other.md', added: 1, deleted: 0, status: 'added' }], status: 'approved' }),
    note({ id: 'cf', status: 'conflict', reason: 'hash_mismatch', diff: null }), // conflict on the path of the candidate
  ];

  it('shows Befördern/Verwerfen only at the candidate entry (not code, other notes, conflicts)', async () => {
    const p = open({ entries: MIXED });
    await feedLoaded(p, 4);
    await until(() => buttonLabels(p).length > 0, 3_000, 'buttons');
    assert.deepEqual(buttonLabels(p), ['Befördern', 'Verwerfen']);
    const inCand = cardOf(p, 'cand').querySelectorAll('button').map((b) => b.textContent);
    assert.deepEqual(inCand, ['Befördern', 'Verwerfen']);
    for (const id of ['code1', 'other', 'cf']) assert.equal(cardOf(p, id).querySelectorAll('button').length, 0, id);
  });

  it('shows no buttons when controls are not allowed, but with controls absent they are allowed (as on the other pages)', async () => {
    const off = open({ entries: MIXED, controls: { retry: false } });
    await feedLoaded(off, 4);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(buttonLabels(off).length, 0);
    assert.equal(cards(off).length, 4, 'feed still renders');

    const absent = open({ entries: MIXED, noControlsKey: true });
    await feedLoaded(absent, 4);
    await until(() => buttonLabels(absent).length === 2, 3_000, 'buttons without controls key');
  });

  it('shows no buttons when the note is no candidate any more', async () => {
    const p = open({ entries: MIXED, candidates: () => ({ candidates: [{ path: 'Other/else.md', title: 'x' }] }) });
    await feedLoaded(p, 4);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(buttonLabels(p).length, 0);
  });

  it('shows no buttons and no error when the candidate list cannot be loaded (500, broken JSON, network)', async () => {
    for (const candidates of [() => ({ __status: 500, error: { code: 'x' } }), () => 'not-an-object', () => { throw new Error('offline'); }]) {
      const p = open({ entries: MIXED, candidates });
      await feedLoaded(p, 4);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(buttonLabels(p).length, 0);
      assert.doesNotMatch(p.root.textContent, /konnten nicht geladen werden/);
    }
  });

  it('approve: POST to the URL-encoded path, then the chip changes without reloading the feed', async () => {
    let approved = false;
    const p = open({
      entries: MIXED,
      candidates: () => ({ candidates: approved ? [] : [CAND] }),
      post: () => { approved = true; return {}; },
    });
    await until(() => buttonLabels(p).length === 2, 3_000, 'buttons');
    const before = changesCalls(p).length;
    p.click(cardOf(p, 'cand').querySelectorAll('button').find((b) => b.textContent === 'Befördern')!);
    await until(() => cardOf(p, 'cand').querySelector('.chg-status')!.textContent === 'approved', 3_000, 'chip');
    const posts = p.fetches.filter((f) => f.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.url, '/api/v1/brain/candidates/Inbox%2Fidea.md/approve');
    assert.equal(changesCalls(p).length, before, 'the feed is not loaded again');
    assert.equal(buttonLabels(p).length, 0, 'no buttons remain');
  });

  it('reject: asks for confirmation, then POSTs to /reject', async () => {
    const p = open({ entries: MIXED });
    await until(() => buttonLabels(p).length === 2, 3_000, 'buttons');
    p.click(cardOf(p, 'cand').querySelectorAll('button').find((b) => b.textContent === 'Verwerfen')!);
    await until(() => p.fetches.some((f) => f.method === 'POST'), 3_000, 'post');
    assert.equal(p.confirms.length, 1);
    assert.equal(p.fetches.find((f) => f.method === 'POST')!.url, '/api/v1/brain/candidates/Inbox%2Fidea.md/reject');
  });

  it('reject declined in the dialog sends nothing', async () => {
    const p = open({ entries: MIXED, confirm: false });
    await until(() => buttonLabels(p).length === 2, 3_000, 'buttons');
    p.click(cardOf(p, 'cand').querySelectorAll('button').find((b) => b.textContent === 'Verwerfen')!);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(p.confirms.length, 1);
    assert.equal(p.fetches.filter((f) => f.method === 'POST').length, 0);
  });

  it('on failure (HTTP error or network error) a message appears at the entry, the feed is not reloaded and the buttons work again', async () => {
    for (const post of [() => ({ __status: 409, error: { code: 'not_candidate', message: 'kein Kandidat' } }), () => { throw new Error('offline'); }]) {
      const p = open({ entries: MIXED, post });
      await until(() => buttonLabels(p).length === 2, 3_000, 'buttons');
      const before = changesCalls(p).length;
      const approve = () => cardOf(p, 'cand').querySelectorAll('button').find((b) => b.textContent === 'Befördern')!;
      p.click(approve());
      await until(() => /Fehlgeschlagen/.test(cardOf(p, 'cand').textContent), 3_000, 'error message');
      assert.equal(changesCalls(p).length, before, 'no reload after a failure');
      assert.ok(cardOf(p, 'cand').querySelectorAll('button').every((b) => !b.disabled), 'buttons enabled again');
      // a second attempt is possible
      p.click(approve());
      await until(() => p.fetches.filter((f) => f.method === 'POST').length === 2, 3_000, 'retry');
    }
  });
});

describe('#376 Filter, counter and stats', () => {
  const BRAIN_ONLY = [note({ id: 'b1' }), note({ id: 'b2', status: 'approved' }), conflict('window')];

  it('?type=brain asks the API for type=brain, shows no code cards and the counter from counts.brain', async () => {
    const p = open({ entries: BRAIN_ONLY, url: 'http://127.0.0.1/changes?type=brain', counts: { all: 9, code: 6, brain: 3 } });
    await feedLoaded(p, 3);
    assert.match(changesCalls(p)[0]!.url, /type=brain/);
    assert.equal(p.query('.chg-file').length, 0, 'no code file rows');
    const chips = p.query('#changes-types .ui-seg-btn');
    assert.match(chips[0]!.textContent, /Alle\s*9/);
    assert.match(chips[1]!.textContent, /Code\s*6/);
    assert.match(chips[2]!.textContent, /Brain\s*3/);
  });

  it('clicking the Brain filter chip requests type=brain and keeps it in the URL', async () => {
    const p = open({ entries: [changeEntry()], counts: { all: 3, code: 2, brain: 1 } });
    await feedLoaded(p, 1);
    p.click(p.query('#changes-types .ui-seg-btn')[2]!);
    await until(() => changesCalls(p).some((c) => /type=brain/.test(c.url)), 3_000, 'brain request');
    assert.match(String(p.location.search), /type=brain/);
  });

  it('shows the brain writes of today as a tile next to the existing tiles', async () => {
    const stats = { today: { commits: 2, merges: 1, files: 4, added: 12, deleted: 3, brain: 7 }, hotspots: [], conflicts_open: 0, note_hotspots: [] };
    const p = open({ entries: [changeEntry()], stats });
    await feedLoaded(p, 1);
    const text = p.$('changes-today').textContent;
    assert.match(text, /Brain-Änderungen/);
    assert.match(text, /7/);
    for (const t of ['Code-Commits', 'PRs gemerged', 'Konflikte offen']) assert.ok(text.includes(t), t);
  });

  it('copes with an older server whose stats.today has no brain field', async () => {
    const stats = { today: { commits: 2, merges: 1, files: 4, added: 12, deleted: 3 }, hotspots: [] };
    const p = open({ entries: [changeEntry()], stats });
    await feedLoaded(p, 1);
    assert.doesNotMatch(p.$('changes-today').textContent, /undefined|NaN/);
  });

  it('without brain: counter 0, no error text, no buttons, brain filter shows the empty message', async () => {
    const gone = () => ({ __status: 404, error: { code: 'brain_disabled' } });
    const p = open({ entries: [changeEntry()], candidates: gone, noBrain: true, counts: { all: 1, code: 1, brain: 0 } });
    await feedLoaded(p, 1);
    assert.equal(p.query('#changes-types .ui-seg-btn').length, 2, 'no Brain segment');
    assert.doesNotMatch(p.root.textContent, /konnten nicht geladen werden|Fehler/i);
    assert.equal(buttonLabels(p).length, 0);

    const empty = open({ entries: [], candidates: gone, noBrain: true, url: 'http://127.0.0.1/changes?type=brain', counts: { all: 1, code: 1, brain: 0 } });
    await until(() => /Noch keine Änderungen für diesen Filter/.test(empty.$('changes-feed').textContent), 3_000, 'empty message');
    assert.equal(empty.query('#changes-types .ui-seg-btn').length, 2);
  });
});

describe('#376 Backend: stats and counts with real brain entries', () => {
  const E = (id: string, at: string, over: Partial<ChangeEntry> = {}): ChangeEntry => ({
    id, type: 'code', at, repo: 'acme/app', issue: 'acme/app#1', role: 'developer', title: id,
    files: [{ path: 'a.ts', added: 2, deleted: 1, status: 'modified' }], pr: null, diff: null, status: 'committed', ...over,
  });
  const B = (id: string, at: string, status: ChangeEntry['status'], over: Partial<ChangeEntry> = {}): ChangeEntry =>
    E(id, at, { type: 'brain', status, files: [{ path: 'Inbox/n.md', added: 3, deleted: 0, status: 'added' }], ...over });
  const store = (rows: ChangeEntry[]) => ({
    list: () => rows.slice().sort((a, b) => (a.id < b.id ? 1 : -1)),
    matching: (q: { type?: string; repo?: string }) => rows.filter((r) => (!q.type || r.type === q.type) && (!q.repo || r.repo === q.repo)),
  });

  it('exposes today.brain counting created/updated/approved/rejected/human of today, not conflicts and not other days', () => {
    const rows = [
      E('c1', '2026-10-30T09:00:00Z'),
      B('b1', '2026-10-30T09:10:00Z', 'created'),
      B('b2', '2026-10-30T09:20:00Z', 'updated'),
      B('b3', '2026-10-30T09:30:00Z', 'approved'),
      B('b4', '2026-10-30T09:40:00Z', 'rejected_candidate'),
      B('b5', '2026-10-30T09:50:00Z', 'human'),
      B('b6', '2026-10-30T10:00:00Z', 'conflict'),
      B('b7', '2026-10-29T10:00:00Z', 'created'),
    ];
    const page = buildChangesPage(store(rows) as never, { limit: 50 } as never, new Date(NOW), 'UTC');
    assert.equal(page.stats!.today.brain, 5);
    assert.equal(page.stats!.today.commits, 1);
    assert.equal(page.stats!.today.files, 1);
    assert.deepEqual([page.stats!.today.added, page.stats!.today.deleted], [2, 1]);
    assert.deepEqual(page.stats!.hotspots.map((h) => h.path), ['a.ts']);
    assert.deepEqual(page.counts, { all: 8, code: 1, brain: 7 });
  });

  it('without any brain entries today.brain is 0 and the counter 0', () => {
    const page = buildChangesPage(store([E('c1', '2026-10-30T09:00:00Z')]) as never, { limit: 50 } as never, new Date(NOW), 'UTC');
    assert.equal(page.stats!.today.brain, 0);
    assert.equal(page.counts.brain, 0);
    assert.deepEqual(changeCounts([]), { all: 0, code: 0, brain: 0 });
  });

  it('does not report brain writes in the stats of later pages (stats only on the first page)', () => {
    const rows = [E('c1', '2026-10-30T09:00:00Z'), B('b1', '2026-10-30T09:10:00Z', 'created'), B('b0', '2026-10-30T09:05:00Z', 'created')];
    const first = buildChangesPage(store(rows) as never, { limit: 1 } as never, new Date(NOW), 'UTC');
    assert.ok(first.stats);
    const second = buildChangesPage(store(rows) as never, { limit: 1, before: first.next_before! } as never, new Date(NOW), 'UTC');
    assert.equal(second.stats, null);
  });
});

describe('#376 HTTP: seeded brain entries over the real server', () => {
  function request(port: number, urlPath: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }).on('error', reject);
    });
  }
  const row = (id: string, at: string, over: Obj = {}) => ({
    id, type: 'code', at, repo: 'acme/app', issue: 'acme/app#1', role: 'developer', title: id,
    files: [{ path: 'a.ts', added: 3, deleted: 1, status: 'modified' }], pr: null, diff: null, status: 'committed', ...over,
  });

  it('GET /api/v1/changes counts brain writes of today in stats and keeps the repo filter; candidates 404 without brain', async () => {
    const logDir = tempDir();
    fs.mkdirSync(path.join(logDir, 'changes'), { recursive: true });
    const brain = (id: string, repo: string, status: string) => row(id, '2026-10-30T10:00:00Z', { type: 'brain', repo, status, files: [{ path: 'Inbox/n.md', added: 1, deleted: 0, status: 'added' }], diff: 'Inbox/n.md\n+x' });
    const rows = [row('app-1', '2026-10-30T09:00:00Z'), brain('app-b1', 'acme/app', 'created'), brain('app-b2', 'acme/app', 'conflict'), brain('lib-b1', 'acme/lib', 'approved')];
    fs.writeFileSync(path.join(logDir, 'changes', 'acme_app.jsonl'), rows.filter((r) => r.repo === 'acme/app').map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(logDir, 'changes', 'acme_lib.jsonl'), rows.filter((r) => r.repo === 'acme/lib').map((r) => JSON.stringify(r)).join('\n') + '\n');
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
      const all = JSON.parse((await request(server.port, '/api/v1/changes?tz=UTC')).body);
      assert.equal(all.stats.today.brain, 2, 'app created + lib approved; the conflict is not counted');
      assert.equal(all.stats.today.commits, 1);
      assert.deepEqual(all.counts, { all: 4, code: 1, brain: 3 });
      const app = JSON.parse((await request(server.port, '/api/v1/changes?tz=UTC&repo=acme%2Fapp')).body);
      assert.equal(app.stats.today.brain, 1);
      const onlyBrain = JSON.parse((await request(server.port, '/api/v1/changes?tz=UTC&type=brain')).body);
      assert.ok(onlyBrain.entries.every((e: { type: string }) => e.type === 'brain'));
      assert.equal(onlyBrain.entries.length, 3);
      const cand = await request(server.port, '/api/v1/brain/candidates');
      assert.equal(cand.status, 404);
      assert.equal(JSON.parse(cand.body).error.code, 'brain_disabled');
    } finally {
      await orchestrator.shutdown(1_000);
      await server.close();
    }
  });
});
