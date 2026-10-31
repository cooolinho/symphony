import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';
import { BRAIN_HTML } from '../src/http/brain-page.ts';
import { startHttpServer } from '../src/http/server.ts';
import { CONTROLS_OFF } from '../src/http/tasks-page.ts';
import { CHIP_TONES } from '../src/http/ui/palette.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, renderPage, tempDir, until } from './helpers.ts';
import { dashboardState } from './helpers/page-fixtures.ts';

// E7-7a (#375): the Brain page (vitals, candidate review, folder tree).

type Obj = Record<string, any>;

function vitals(over: Obj = {}): Obj {
  return {
    notes_by_status: { candidate: 2, approved: 6, deprecated: 2, none: 0 },
    links: 12, orphans: 1, broken_links: 3, candidates: 2, writes_today: 4, reads_today: 9,
    last_commit: { sha: 'abcdef0123456789', at: '2026-10-30T11:00:00Z', author: 'human' },
    obsidian_url: null,
    folders: [
      { path: 'Inbox', notes_by_status: { candidate: 2, approved: 0, deprecated: 0, none: 0 }, total: 2 },
      { path: 'Repos', notes_by_status: { candidate: 0, approved: 1, deprecated: 1, none: 0 }, total: 2 },
      { path: 'Repos/acme-app', notes_by_status: { candidate: 0, approved: 1, deprecated: 1, none: 0 }, total: 2 },
    ],
    ...over,
  };
}
const cand = (name: string, over: Obj = {}): Obj => ({
  path: `Inbox/${name}.md`, title: `Titel ${name}`, type: 'lesson', repo: 'acme/app', issue: '7', role: 'developer',
  created: '2026-10-01', target: 'Lessons/', preview: `# ${name}\nzeile`, ...over,
});

function brainFetch(opts: Obj = {}): (url: string, init: { method: string; body?: unknown }) => unknown {
  return (url, init) => {
    if (init.method === 'POST') return opts.post?.(url) ?? { path: 'Lessons/a.md', previous_path: 'Inbox/a.md', hash: 'h', sha: 's' };
    if (url.includes('/state')) return opts.state ?? dashboardState({ controls: { retry: true } });
    if (url.includes('/brain/vitals')) return opts.vitals ?? vitals();
    if (url.includes('/brain/candidates')) return opts.candidates ?? { candidates: [cand('a'), cand('b')] };
    if (url.includes('/brain/graph')) return typeof opts.graph === 'function' ? opts.graph(url) : opts.graph ?? graphBody();
    if (url.includes('/brain/clashes')) return typeof opts.clashes === 'function' ? opts.clashes() : opts.clashes ?? { clashes: [] };
    return {};
  };
}
const text = (n: { textContent: string }) => n.textContent;
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
const button = (p: ReturnType<typeof renderPage>, scope: string, label: string) => p.query(`${scope} button`).find((b) => text(b) === label);

function request(port: number, path: string): Promise<{ status: number; body: string; type: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, type: String(res.headers['content-type']) }));
    }).on('error', reject);
  });
}

describe('GET /brain', () => {
  it('serves the page, no longer the placeholder', async () => {
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
      runner: new FakeRunner(), logger: Logger.silent(), env: {}, logDir: null, timers: new ManualTimers(), createAdapter: () => new FakeTracker(),
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      const res = await request(server.port, '/brain');
      assert.equal(res.status, 200);
      assert.match(res.type, /text\/html/);
      for (const part of ['id="candidates"', 'Kandidaten', 'Ordner']) assert.ok(res.body.includes(part), part);
      assert.ok(!res.body.includes('Diese Seite kommt in Kürze'));
    } finally {
      await server.close();
    }
  });
});

describe('Brain page (E7-7a)', () => {
  it('shows vitals tiles and a status bar naming the three statuses', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch() });
    await until(() => p.query('#brain-vitals .ui-kpi').length > 0);
    const tiles = p.query('#brain-vitals .ui-kpi').map(text).join('|');
    for (const part of ['Notizen', 'Kaputte Links', 'Schreibzugriffe heute', 'abcdef0']) assert.ok(tiles.includes(part), part);
    const label = p.query('#brain-status .ui-stack')[0]!.getAttribute('aria-label') ?? '';
    for (const s of ['approved', 'candidate', 'deprecated']) assert.ok(label.includes(s), s);
  });

  it('renders "In Obsidian öffnen" only for a safe URL', async () => {
    const withUrl = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ vitals: vitals({ obsidian_url: 'https://brain.lan' }) }) });
    await until(() => withUrl.query('#brain-open a').length > 0);
    const a = withUrl.query('#brain-open a')[0]!;
    assert.equal(a.getAttribute('href'), 'https://brain.lan');
    assert.equal(a.getAttribute('target'), '_blank');
    assert.match(a.getAttribute('rel') ?? '', /noopener/);
    for (const url of [null, 'javascript:alert(1)']) {
      const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ vitals: vitals({ obsidian_url: url }) }) });
      await until(() => p.query('#brain-vitals .ui-kpi').length > 0);
      assert.equal(p.query('#brain-open a').length, 0, String(url));
    }
  });

  it('lists candidates in API order with their fields and a preview', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch() });
    await until(() => p.query('#brain-candidates .br-cand').length === 2);
    const cards = p.query('#brain-candidates .br-cand');
    assert.deepEqual(cards.map((c) => c.dataset.path), ['Inbox/a.md', 'Inbox/b.md']);
    const first = text(cards[0]!);
    for (const part of ['Titel a', 'Inbox/a.md', 'lesson', 'acme/app', '#7', 'developer', 'Lessons/', 'vor ']) assert.ok(first.includes(part), part);
    assert.equal(cards[0]!.querySelectorAll('details.br-preview').length, 1);
    assert.equal(p.$('candidates').tagName.toLowerCase(), 'section');
  });

  it('shows the buttons only when control is allowed, the edit link only with a URL', async () => {
    const on = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ vitals: vitals({ obsidian_url: 'obsidian://open?vault=b' }) }) });
    await until(() => on.query('#brain-candidates .br-cand').length === 2);
    const card = on.query('#brain-candidates .br-cand')[0]!;
    assert.deepEqual(card.querySelectorAll('button').map(text), ['Befördern', 'Verwerfen']);
    const edit = card.querySelectorAll('a').find((a) => text(a) === 'In Obsidian bearbeiten')!;
    assert.equal(edit.getAttribute('href'), 'obsidian://open?vault=b&file=Inbox%2Fa');
    assert.equal(edit.getAttribute('target'), '_blank');
    assert.equal(on.$('brain-controls-off').hidden, true);

    const noUrl = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch() });
    await until(() => noUrl.query('#brain-candidates .br-cand').length === 2);
    assert.ok(!noUrl.query('#brain-candidates a').some((a) => text(a) === 'In Obsidian bearbeiten'));

    const off = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ state: dashboardState({ controls: { retry: false } }), vitals: vitals({ obsidian_url: 'https://b.lan' }) }) });
    await until(() => off.query('#brain-candidates .br-cand').length === 2);
    assert.equal(off.query('#brain-candidates button').length, 0);
    assert.equal(off.query('#brain-candidates a').filter((a) => text(a).includes('Obsidian')).length, 0);
    assert.equal(off.$('brain-controls-off').hidden, false);
    assert.ok(text(off.$('brain-controls-off')).includes(CONTROLS_OFF));
  });

  it('promotes with an encoded path, offers "Rückgängig" and reverts the new path', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch() });
    await until(() => p.query('#brain-candidates .br-cand').length === 2);
    const before = p.fetches.filter((f) => f.url.includes('/brain/candidates') && f.method === 'GET').length;
    p.click(button(p, '#brain-candidates .br-cand', 'Befördern')!);
    await until(() => p.query('#brain-undo button').length === 1);
    const post = p.fetches.find((f) => f.method === 'POST')!;
    assert.equal(post.url, '/api/v1/brain/candidates/Inbox%2Fa.md/approve');
    assert.equal(text(p.query('#brain-undo button')[0]!), 'Rückgängig');
    assert.ok(text(p.$('brain-undo')).includes('Lessons/a.md'));
    await until(() => p.fetches.filter((f) => f.url.includes('/brain/candidates') && f.method === 'GET').length > before);
    p.click(p.query('#brain-undo button')[0]!);
    await until(() => p.fetches.filter((f) => f.method === 'POST').length === 2);
    assert.equal(p.fetches.filter((f) => f.method === 'POST')[1]!.url, '/api/v1/brain/candidates/Lessons%2Fa.md/revert');
  });

  it('rejects after a confirmation', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch() });
    await until(() => p.query('#brain-candidates .br-cand').length === 2);
    p.click(button(p, '#brain-candidates .br-cand', 'Verwerfen')!);
    await until(() => p.fetches.some((f) => f.method === 'POST'));
    assert.equal(p.confirms.length, 1);
    assert.equal(p.fetches.find((f) => f.method === 'POST')!.url, '/api/v1/brain/candidates/Inbox%2Fa.md/reject');
  });

  it('shows a failure at the entry', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ post: () => ({ __status: 409, error: { code: 'not_candidate', message: 'kein Kandidat' } }) }) });
    await until(() => p.query('#brain-candidates .br-cand').length === 2);
    p.click(button(p, '#brain-candidates .br-cand', 'Befördern')!);
    await until(() => text(p.query('#brain-candidates .br-msg')[0]!) !== '');
    const msg = text(p.query('#brain-candidates .br-msg')[0]!);
    assert.ok(msg.includes('409') && msg.includes('kein Kandidat'), msg);
    assert.equal(p.query('#brain-undo button').length, 0);

    const denied = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ post: () => ({ __status: 403, error: { code: 'forbidden', message: 'x' } }) }) });
    await until(() => denied.query('#brain-candidates .br-cand').length === 2);
    denied.click(button(denied, '#brain-candidates .br-cand', 'Befördern')!);
    await until(() => text(denied.query('#brain-candidates .br-msg')[0]!) !== '');
    assert.equal(text(denied.query('#brain-candidates .br-msg')[0]!), CONTROLS_OFF);
  });

  it('renders the folder tree with counts per status', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch() });
    await until(() => p.query('#brain-folders .br-folder').length > 0);
    const repos = p.query('#brain-folders details.br-folder')[0]!;
    assert.equal(repos.querySelectorAll('summary').length >= 1, true);
    const summary = text(repos.querySelectorAll('summary')[0]!);
    for (const part of ['Repos', '2', 'approved 1', 'deprecated 1']) assert.ok(summary.includes(part), part);
    assert.ok(text(repos).includes('acme-app'));
    assert.ok(text(p.$('brain-folders')).includes('Inbox'));
  });

  it('says so without a brain (404 brain_disabled)', async () => {
    const gone = { __status: 404, error: { code: 'brain_disabled', message: 'x' } };
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ vitals: gone, candidates: gone }) });
    await until(() => p.$('brain-off').hidden === false);
    assert.equal(text(p.$('brain-off')), 'Das Brain ist nicht aktiviert (brain.enabled in WORKFLOW.md).');
    assert.equal(p.$('brain-main').hidden, true);
  });

  it('shows the empty state', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ candidates: { candidates: [] } }) });
    await until(() => text(p.$('brain-candidates')) !== '');
    assert.equal(text(p.$('brain-candidates')), 'Keine Kandidaten. Alles ist gesichtet.');
  });

  it('escapes note content', async () => {
    const title = '<img src=x onerror=1>';
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ candidates: { candidates: [cand('a', { title, preview: title })] } }) });
    await until(() => p.query('#brain-candidates .br-cand').length === 1);
    assert.equal(p.query('#brain-candidates img').length, 0);
    assert.ok(text(p.query('#brain-candidates .br-title')[0]!).includes(title));
  });
});

// E7-7b (#378): graph around a repository index and the write clashes with a side-by-side comparison.

function graphBody(over: Obj = {}): Obj {
  return {
    root: 'Repos/acme-app/index.md', depth: 2, truncated: false,
    nodes: [
      { path: 'Repos/acme-app/index.md', title: 'Acme App', status: 'approved', type: 'index', missing: false, depth: 0 },
      { path: 'Inbox/a.md', title: 'Titel a', status: 'candidate', type: 'lesson', missing: false, depth: 1 },
      { path: 'Lessons/b.md', title: 'B', status: null, type: 'lesson', missing: false, depth: 1 },
      { path: 'Lessons/fehlt.md', title: 'fehlt', status: null, type: null, missing: true, depth: 2 },
    ],
    edges: [
      { from: 'Inbox/a.md', to: 'Lessons/fehlt.md', broken: true },
      { from: 'Repos/acme-app/index.md', to: 'Inbox/a.md', broken: false },
      { from: 'Repos/acme-app/index.md', to: 'Lessons/b.md', broken: false },
    ],
    ...over,
  };
}
const clash = (id: string, over: Obj = {}): Obj => ({
  id, path: 'Lessons/x.md', runs: ['run-a', 'run-b'], roles: ['architect', 'developer'],
  at: ['2026-10-30T10:00:00Z', '2026-10-30T10:01:00Z'], reason: 'hash_mismatch', status: 'open',
  base: { content: 'a\nb\nc', hash: 'h0' }, attempted: { content: 'a\nb\nc' }, current: { content: 'a\nx\nc', hash: 'h1' }, ...over,
});
const vitalsTwoRepos = () => vitals({ folders: [...vitals().folders, { path: 'Repos/beta', notes_by_status: { candidate: 0, approved: 1, deprecated: 0, none: 0 }, total: 1 }] });

describe('Brain page graph (E7-7b)', () => {
  it('offers one root per repository and loads its graph with depth 2', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ vitals: vitalsTwoRepos() }) });
    await until(() => p.query('#brain-graph svg').length === 1);
    const options = p.query('#brain-graph-root option');
    assert.deepEqual(options.map(text), ['acme-app', 'beta']);
    assert.deepEqual(options.map((o) => o.getAttribute('value')), ['Repos/acme-app/index.md', 'Repos/beta/index.md']);
    assert.ok(p.fetches.some((f) => f.url === '/api/v1/brain/graph?root=Repos%2Facme-app%2Findex.md&depth=2'));
    const select = p.$('brain-graph-root');
    select.value = 'Repos/beta/index.md';
    select.dispatch('change');
    await until(() => p.fetches.some((f) => f.url === '/api/v1/brain/graph?root=Repos%2Fbeta%2Findex.md&depth=2'));
  });

  it('draws nodes in status colours and the broken link red and dashed', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch() });
    await until(() => p.query('#brain-graph svg').length === 1);
    const nodes = p.query('#brain-graph g.br-node');
    assert.deepEqual(nodes.map((n) => n.dataset.path), ['Repos/acme-app/index.md', 'Inbox/a.md', 'Lessons/b.md', 'Lessons/fehlt.md']);
    const fill = (i: number) => nodes[i]!.querySelectorAll('circle')[0]!.getAttribute('fill');
    assert.equal(fill(0), CHIP_TONES.green.c);
    assert.equal(fill(1), CHIP_TONES.amber.c);
    assert.notEqual(fill(2), fill(0));
    const broken = p.query('#brain-graph line.br-edge-broken');
    assert.equal(broken.length, 1);
    assert.equal(broken[0]!.getAttribute('stroke'), CHIP_TONES.red.c);
    assert.ok(broken[0]!.getAttribute('stroke-dasharray'));
    assert.equal(p.query('#brain-graph line.br-edge').length, 3);
    const missing = p.query('#brain-graph g.br-node-missing');
    assert.equal(missing.length, 1);
    const ring = missing[0]!.querySelectorAll('circle')[0]!;
    assert.equal(ring.getAttribute('fill'), 'none');
    assert.equal(ring.getAttribute('stroke'), CHIP_TONES.red.c);
    assert.ok(ring.getAttribute('stroke-dasharray'));
    for (const n of nodes) assert.equal(n.getAttribute('role'), 'button');
  });

  it('has a text alternative with the numbers', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch() });
    await until(() => p.$('brain-graph-text').hidden === false);
    const summary = text(p.$('brain-graph-text'));
    assert.equal(summary, '4 Knoten, 3 Kanten, 1 kaputte Links');
    assert.ok((p.query('#brain-graph svg')[0]!.getAttribute('aria-label') ?? '').includes(summary));
    const cut = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ graph: graphBody({ truncated: true }) }) });
    await until(() => cut.$('brain-graph-text').hidden === false);
    assert.ok(text(cut.$('brain-graph-text')).includes('gekürzt auf 4 Knoten'));
  });

  it('opens the preview of a node on click and on Enter', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ vitals: vitals({ obsidian_url: 'obsidian://open?vault=b' }) }) });
    await until(() => p.query('#brain-graph g.br-node').length === 4);
    assert.equal(p.$('brain-graph-preview').hidden, true);
    p.click(p.query('#brain-graph g.br-node')[1]!);
    const preview = p.$('brain-graph-preview');
    assert.equal(preview.hidden, false);
    for (const part of ['Titel a', 'Inbox/a.md', 'candidate', '2 Links im Ausschnitt', 'zeile']) assert.ok(text(preview).includes(part), part);
    assert.equal(preview.querySelectorAll('a')[0]!.getAttribute('href'), 'obsidian://open?vault=b&file=Inbox%2Fa');
    p.query('#brain-graph g.br-node-missing')[0]!.dispatch('keydown', { key: 'Enter' });
    assert.ok(text(preview).includes('Ziel fehlt – verlinkt von Inbox/a.md'));
    assert.equal(preview.querySelectorAll('a').length, 0);
  });

  it('shows "Keine Links" without edges, without a repository or without an index note', async () => {
    const lonely = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ graph: graphBody({ nodes: graphBody().nodes.slice(0, 1), edges: [] }) }) });
    await until(() => text(lonely.$('brain-graph')) !== '');
    assert.equal(text(lonely.$('brain-graph')), 'Keine Links');
    assert.equal(lonely.query('#brain-graph svg').length, 0);
    assert.equal(lonely.$('brain-graph-text').hidden, true);
    const none = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ vitals: vitals({ folders: [] }) }) });
    await until(() => text(none.$('brain-graph')) !== '');
    assert.equal(text(none.$('brain-graph')), 'Keine Links');
    assert.ok(!none.fetches.some((f) => f.url.includes('/brain/graph')));
    const gone = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ graph: { __status: 404, error: { code: 'root_not_found', message: 'x' } } }) });
    await until(() => text(gone.$('brain-graph')) !== '');
    assert.equal(text(gone.$('brain-graph')), 'Keine Links');
  });
});

describe('Brain page write clashes (E7-7b)', () => {
  it('shows an open clash with path, runs, roles, times and reason', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ clashes: { clashes: [clash('c1')] } }) });
    await until(() => p.query('#brain-clashes .br-clash').length === 1);
    const card = p.query('#brain-clashes .br-clash')[0]!;
    assert.equal(card.dataset.id, 'c1');
    for (const part of ['Lessons/x.md', 'run-a', 'run-b', 'architect', 'developer', 'Hash-Konflikt', 'abgewiesen']) assert.ok(text(card).includes(part), part);
    assert.equal(p.$('clashes').tagName.toLowerCase(), 'section');
  });

  it('compares both versions side by side with the differences marked', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ clashes: { clashes: [clash('c1')] } }) });
    await until(() => p.query('#brain-clashes .br-diff').length === 1);
    const grid = p.query('#brain-clashes .br-diff')[0]!;
    const cells = grid.querySelectorAll('.br-cell').filter((c) => !c.classList.contains('br-cell-head'));
    assert.deepEqual(cells.map(text), ['a', 'a', 'b', 'x', 'c', 'c']);
    assert.deepEqual(grid.querySelectorAll('.br-del').map(text), ['b']);
    assert.deepEqual(grid.querySelectorAll('.br-add').map(text), ['x']);
    assert.ok(!cells[0]!.classList.contains('br-del') && !cells[0]!.classList.contains('br-add'));
    const heads = grid.querySelectorAll('.br-cell-head').map(text);
    assert.deepEqual(heads, ['Abgewiesene Fassung', 'Aktuelle Fassung']);
    assert.equal(p.query('#brain-clashes details.br-diff-wrap')[0]!.open, true);
  });

  it('marks inserted and removed lines against a gap', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ clashes: { clashes: [clash('c1', { attempted: { content: 'a\nneu\nb' }, current: { content: 'a\nb\nende' } })] } }) });
    await until(() => p.query('#brain-clashes .br-diff').length === 1);
    const grid = p.query('#brain-clashes .br-diff')[0]!;
    assert.deepEqual(grid.querySelectorAll('.br-del').map(text), ['neu']);
    assert.deepEqual(grid.querySelectorAll('.br-add').map(text), ['ende']);
    assert.equal(grid.querySelectorAll('.br-gap').length, 2);
  });

  it('inserts note contents as text only', async () => {
    const evil = '<img src=x onerror=1>';
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ clashes: { clashes: [clash('c1', { path: evil, attempted: { content: evil }, current: { content: 'x' } })] } }) });
    await until(() => p.query('#brain-clashes .br-clash').length === 1);
    assert.equal(p.query('#brain-clashes img').length, 0);
    assert.ok(p.query('#brain-clashes .br-del').map(text).includes(evil));
  });

  it('offers "gelöst" only with control allowed and resolves via POST', async () => {
    let resolved = false;
    const p = renderPage(BRAIN_HTML, undefined, {
      fetch: brainFetch({
        clashes: () => ({ clashes: [clash('c/1', { status: resolved ? 'resolved' : 'open' })] }),
        post: () => { resolved = true; return { id: 'c/1', status: 'resolved' }; },
      }),
    });
    await until(() => p.query('#brain-clashes .br-clash button').length === 1);
    const b = p.query('#brain-clashes .br-clash button')[0]!;
    assert.ok(text(b).includes('gelöst'));
    assert.equal(p.$('brain-clash-controls-off').hidden, true);
    const before = p.fetches.filter((f) => f.url.includes('/brain/clashes') && f.method === 'GET').length;
    p.click(b);
    await until(() => p.fetches.some((f) => f.method === 'POST'));
    assert.equal(p.fetches.find((f) => f.method === 'POST')!.url, '/api/v1/brain/clashes/c%2F1/resolve');
    await until(() => text(p.$('brain-clashes')) === 'Keine Konflikte');
    assert.ok(p.fetches.filter((f) => f.url.includes('/brain/clashes') && f.method === 'GET').length > before);
    assert.equal(p.$('brain-clashes-resolved').hidden, false);
    assert.equal(p.query('#brain-clashes-resolved .br-clash').length, 1);

    const off = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ state: dashboardState({ controls: { retry: false } }), clashes: { clashes: [clash('c1')] } }) });
    await until(() => off.query('#brain-clashes .br-clash').length === 1);
    assert.equal(off.query('#brain-clashes button').length, 0);
    assert.equal(off.$('brain-clash-controls-off').hidden, false);
    assert.ok(text(off.$('brain-clash-controls-off')).includes(CONTROLS_OFF));
  });

  it('shows a failed resolve at the card', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ clashes: { clashes: [clash('c1')] }, post: () => ({ __status: 500, error: { code: 'boom', message: 'kaputt' } }) }) });
    await until(() => p.query('#brain-clashes .br-clash button').length === 1);
    p.click(p.query('#brain-clashes .br-clash button')[0]!);
    await until(() => text(p.query('#brain-clashes .br-msg')[0]!) !== '');
    assert.ok(text(p.query('#brain-clashes .br-msg')[0]!).includes('kaputt'));
  });

  it('lists resolved clashes collapsible below, without a button', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ clashes: { clashes: [clash('c1'), clash('c2', { status: 'resolved' })] } }) });
    await until(() => p.query('#brain-clashes .br-clash').length === 1);
    const details = p.$('brain-clashes-resolved');
    assert.equal(details.tagName.toLowerCase(), 'details');
    assert.equal(details.hidden, false);
    assert.equal(details.open, false);
    assert.equal(text(details.querySelectorAll('summary')[0]!), 'Gelöste Clashes (1)');
    const card = details.querySelectorAll('.br-clash')[0]!;
    assert.equal(card.dataset.id, 'c2');
    assert.equal(card.querySelectorAll('button').length, 0);
    assert.ok(text(card).includes('gelöst'));
  });

  it('shows "Keine Konflikte" without clashes', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch() });
    await until(() => text(p.$('brain-clashes')) !== '');
    assert.equal(text(p.$('brain-clashes')), 'Keine Konflikte');
    assert.equal(p.$('brain-clashes-resolved').hidden, true);
  });
});

describe('Brain page motion (E7-7b)', () => {
  const start = BRAIN_HTML.indexOf('.br-head {');
  const brainCss = BRAIN_HTML.slice(start, BRAIN_HTML.indexOf('</style>', start));

  it('animates only transform and opacity', () => {
    assert.ok(brainCss.includes('.br-node'));
    const transitions = [...brainCss.matchAll(/transition:\s*([^;}]+)/g)].map((m) => m[1]!.trim());
    assert.ok(transitions.length > 0);
    for (const t of transitions) assert.match(t, /^(none|(transform|opacity)\b[^,]*(,\s*(transform|opacity)\b[^,]*)*)$/, t);
    const frames = /@keyframes br-in\s*\{([\s\S]*?\})\s*\}/.exec(brainCss)?.[1] ?? '';
    assert.ok(frames !== '');
    for (const prop of frames.matchAll(/([a-z-]+)\s*:/g)) assert.ok(['opacity', 'transform'].includes(prop[1]!), prop[1]!);
  });

  it('turns transitions and animations off under prefers-reduced-motion', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?\})\s*\}/.exec(brainCss)?.[1] ?? '';
    assert.match(reduced, /\.br-node circle \{ transition: none; \}/);
    assert.match(reduced, /\.br-clash \{ animation: none; \}/);
  });
});
