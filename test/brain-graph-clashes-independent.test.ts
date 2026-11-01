import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildIndex, graphAround, vitalsCounts } from '../src/brain/index.ts';
import { BRAIN_HTML } from '../src/http/brain-page.ts';
import { startHttpServer } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, renderPage, tempDir, until } from './helpers.ts';
import { dashboardState } from './helpers/page-fixtures.ts';

// E7-7b (#378), independent tests derived from the issue text: GET /api/v1/brain/graph, section #graph, section #clashes.
// Adjusted for E7-8 (#391): folder colours instead of status colours, role="img" without node preview, mockup clash texts.

type Obj = Record<string, any>;

const put = (vault: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(vault, rel), text);
};
const note = (status: string | null, body = ''): string => `---\n${status === null ? 'type: note' : `status: ${status}`}\n---\n${body}\n`;

/** A vault: index -> a, b; a -> c; c -> d; d -> e; b -> missing; z links back to the index (a backlink). */
function chainVault(): string {
  const vault = path.join(tempDir(), 'vault');
  put(vault, 'Repos/acme-app/index.md', note('approved', '# App\n[[Lessons/a]] [[Lessons/b]]'));
  put(vault, 'Lessons/a.md', note('candidate', '# A\n[[Lessons/c]]'));
  put(vault, 'Lessons/b.md', note('deprecated', '# B\n[[Lessons/gibtsnicht]]'));
  put(vault, 'Lessons/c.md', note('approved', '# C\n[[Lessons/d]]'));
  put(vault, 'Lessons/d.md', note('approved', '# D\n[[Lessons/e]]'));
  put(vault, 'Lessons/e.md', note('approved', '# E'));
  put(vault, 'Lessons/z.md', note(null, '# Z\n[[Repos/acme-app/index]]'));
  return vault;
}

describe('graphAround (independent)', () => {
  it('reaches exactly the notes within the depth, in both link directions', async () => {
    const index = await buildIndex(chainVault());
    const paths = (depth: number) => graphAround(index, 'Repos/acme-app/index.md', depth)!.nodes.map((n) => n.path).sort();
    assert.deepEqual(paths(1), ['Lessons/a.md', 'Lessons/b.md', 'Lessons/z.md', 'Repos/acme-app/index.md']);
    assert.deepEqual(paths(2), [...paths(1), 'Lessons/c.md', 'Lessons/gibtsnicht.md'].sort());
    assert.deepEqual(paths(3), [...paths(2), 'Lessons/d.md'].sort());
  });

  it('marks broken links as missing nodes with a broken edge and nothing else as missing', async () => {
    const index = await buildIndex(chainVault());
    const g = graphAround(index, 'Repos/acme-app/index.md', 3)!;
    assert.deepEqual(g.nodes.filter((n) => n.missing).map((n) => n.path), ['Lessons/gibtsnicht.md']);
    assert.deepEqual(g.edges.filter((e) => e.broken), [{ from: 'Lessons/b.md', to: 'Lessons/gibtsnicht.md', broken: true }]);
    const real = g.nodes.find((n) => n.path === 'Lessons/a.md')!;
    assert.equal(real.missing, false);
    assert.equal(real.status, 'candidate');
    assert.equal(real.title, 'A');
    assert.equal(g.nodes.find((n) => n.path === 'Lessons/z.md')!.status, null);
  });

  it('keeps every edge between nodes of the graph and counts broken links like the vitals', async () => {
    const index = await buildIndex(chainVault());
    const g = graphAround(index, 'Repos/acme-app/index.md', 3)!;
    const have = new Set(g.nodes.map((n) => n.path));
    for (const e of g.edges) assert.ok(have.has(e.from) && have.has(e.to), `${e.from} -> ${e.to}`);
    assert.equal(new Set(g.nodes.map((n) => n.path)).size, g.nodes.length, 'no duplicate nodes');
    assert.equal(g.edges.filter((e) => e.broken).length, vitalsCounts(index).broken_links);
  });

  it('starts at the root, then orders by distance', async () => {
    const index = await buildIndex(chainVault());
    const g = graphAround(index, 'Repos/acme-app/index.md', 3)!;
    assert.equal(g.nodes[0]!.path, 'Repos/acme-app/index.md');
    assert.equal(g.nodes[0]!.depth, 0);
    const depths = g.nodes.map((n) => n.depth);
    assert.deepEqual(depths, [...depths].sort((a, b) => a - b));
    assert.equal(g.nodes.find((n) => n.path === 'Lessons/d.md')!.depth, 3);
  });

  it('accepts the root without .md and in another case; returns null for an unknown root', async () => {
    const index = await buildIndex(chainVault());
    assert.equal(graphAround(index, 'repos/ACME-app/Index', 1)!.root, 'Repos/acme-app/index.md');
    assert.equal(graphAround(index, 'Repos/nix/index.md', 2), null);
    assert.equal(graphAround(index, '', 2), null);
    assert.equal(graphAround(index, '../../etc/passwd', 2), null);
  });

  it('cuts at the node limit with truncated and does not cut at exactly the limit', async () => {
    const vault = path.join(tempDir(), 'vault');
    put(vault, 'Repos/r/index.md', note('approved', Array.from({ length: 10 }, (_, i) => `[[Lessons/n${i}]]`).join(' ')));
    for (let i = 0; i < 10; i++) put(vault, `Lessons/n${i}.md`, note('approved'));
    const index = await buildIndex(vault);
    const cut = graphAround(index, 'Repos/r/index.md', 2, 5)!;
    assert.equal(cut.nodes.length, 5);
    assert.equal(cut.truncated, true);
    const exact = graphAround(index, 'Repos/r/index.md', 2, 11)!;
    assert.equal(exact.nodes.length, 11);
    assert.equal(exact.truncated, false);
    const defaultLimit = graphAround((await buildIndexWith(vault, 200)), 'Repos/r/index.md', 2)!;
    assert.equal(defaultLimit.nodes.length, 150);
    assert.equal(defaultLimit.truncated, true);
  });

  it('is isolated from notes without a connection to the root', async () => {
    const vault = chainVault();
    put(vault, 'Lessons/island.md', note('approved', '# Island\n[[Lessons/island2]]'));
    put(vault, 'Lessons/island2.md', note('approved'));
    const g = graphAround(await buildIndex(vault), 'Repos/acme-app/index.md', 3)!;
    assert.ok(!g.nodes.some((n) => n.path.includes('island')));
  });

  it('gives a note without any link a graph of one node and no edges', async () => {
    const vault = path.join(tempDir(), 'vault');
    put(vault, 'Repos/r/index.md', note('approved', 'nothing'));
    const g = graphAround(await buildIndex(vault), 'Repos/r/index.md', 2)!;
    assert.equal(g.nodes.length, 1);
    assert.deepEqual(g.edges, []);
    assert.equal(g.truncated, false);
  });
});

async function buildIndexWith(vault: string, extra: number) {
  for (let i = 10; i < extra; i++) put(vault, `Lessons/n${i}.md`, note('approved'));
  put(vault, 'Repos/r/index.md', note('approved', Array.from({ length: extra }, (_, i) => `[[Lessons/n${i}]]`).join(' ')));
  return buildIndex(vault);
}

function call(port: number, method: string, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function serve(brain: Obj | null) {
  const orchestrator = new Orchestrator({
    workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), brain ? { brain } : {}))),
    runner: new FakeRunner(), logger: Logger.silent(), env: {}, logDir: null, timers: new ManualTimers(), createAdapter: () => new FakeTracker(),
  });
  await orchestrator.buildBrainIndex();
  return startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
}

describe('GET /api/v1/brain/graph (independent)', () => {
  it('uses depth 2 by default and honours depth 1..3', async () => {
    const server = await serve({ enabled: true, path: chainVault() });
    try {
      const paths = async (query: string) => {
        const res = await call(server.port, 'GET', `/api/v1/brain/graph?root=Repos/acme-app/index.md${query}`);
        assert.equal(res.status, 200, query);
        const body = JSON.parse(res.body);
        return { body, paths: body.nodes.map((n: Obj) => n.path) as string[] };
      };
      const def = await paths('');
      assert.equal(def.body.depth, 2);
      assert.ok(def.paths.includes('Lessons/c.md') && !def.paths.includes('Lessons/d.md'));
      assert.ok(!(await paths('&depth=1')).paths.includes('Lessons/c.md'));
      assert.ok((await paths('&depth=3')).paths.includes('Lessons/d.md'));
      assert.ok(!(await paths('&depth=3')).paths.includes('Lessons/e.md'));
    } finally {
      await server.close();
    }
  });

  it('reports a broken link as a missing node and a broken edge, with node fields path, title, status', async () => {
    const server = await serve({ enabled: true, path: chainVault() });
    try {
      const body = JSON.parse((await call(server.port, 'GET', '/api/v1/brain/graph?root=Repos%2Facme-app%2Findex.md&depth=2')).body);
      const missing = body.nodes.filter((n: Obj) => n.missing === true);
      assert.equal(missing.length, 1);
      assert.equal(missing[0].path, 'Lessons/gibtsnicht.md');
      const a = body.nodes.find((n: Obj) => n.path === 'Lessons/a.md');
      assert.equal(a.title, 'A');
      assert.equal(a.status, 'candidate');
      assert.equal(a.missing, false);
      assert.ok(body.edges.some((e: Obj) => e.to === 'Lessons/gibtsnicht.md' && e.broken === true));
      assert.ok(body.edges.some((e: Obj) => e.from === 'Lessons/a.md' && e.to === 'Lessons/c.md' && !e.broken));
      assert.equal(typeof body.truncated, 'boolean');
    } finally {
      await server.close();
    }
  });

  it('never returns more than 150 nodes', async () => {
    const vault = path.join(tempDir(), 'vault');
    put(vault, 'Repos/big/index.md', note('approved', Array.from({ length: 300 }, (_, i) => `[[Lessons/n${i}]] [[Lessons/ghost${i}]]`).join(' ')));
    for (let i = 0; i < 300; i++) put(vault, `Lessons/n${i}.md`, note('approved', `[[Lessons/m${i}]]`));
    const server = await serve({ enabled: true, path: vault });
    try {
      for (const depth of [1, 2, 3]) {
        const body = JSON.parse((await call(server.port, 'GET', `/api/v1/brain/graph?root=Repos/big/index.md&depth=${depth}`)).body);
        assert.ok(body.nodes.length <= 150, `depth ${depth}: ${body.nodes.length}`);
        assert.equal(body.truncated, true);
        const have = new Set(body.nodes.map((n: Obj) => n.path));
        assert.ok(body.edges.every((e: Obj) => have.has(e.from) && have.has(e.to)));
      }
    } finally {
      await server.close();
    }
  });

  it('rejects bad parameters with 400 and unknown roots with 404, never with 500', async () => {
    const server = await serve({ enabled: true, path: chainVault() });
    try {
      const root = 'root=Repos/acme-app/index.md';
      for (const url of [`/api/v1/brain/graph`, `/api/v1/brain/graph?root=`, `/api/v1/brain/graph?${root}&depth=0`, `/api/v1/brain/graph?${root}&depth=4`, `/api/v1/brain/graph?${root}&depth=1.5`, `/api/v1/brain/graph?${root}&depth=-1`, `/api/v1/brain/graph?${root}&depth=abc`]) {
        const res = await call(server.port, 'GET', url);
        assert.equal(res.status, 400, url);
        assert.ok(JSON.parse(res.body).error.message.length > 0, url);
      }
      for (const bad of ['Repos/none/index.md', '../../etc/passwd', '%2e%2e%2fsecret', 'Lessons/gibtsnicht.md']) {
        const res = await call(server.port, 'GET', `/api/v1/brain/graph?root=${bad}`);
        assert.equal(res.status, 404, bad);
        assert.equal(JSON.parse(res.body).error.code, 'root_not_found');
      }
      for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await call(server.port, method, `/api/v1/brain/graph?${root}`)).status, 405, method);
    } finally {
      await server.close();
    }
  });

  it('answers 404 brain_disabled when the brain is off', async () => {
    const server = await serve(null);
    try {
      const res = await call(server.port, 'GET', '/api/v1/brain/graph?root=Repos/x/index.md');
      assert.equal(res.status, 404);
      assert.equal(JSON.parse(res.body).error.code, 'brain_disabled');
    } finally {
      await server.close();
    }
  });
});

// ---- page ----

const GRAPH = {
  root: 'Repos/acme-app/index.md', depth: 2, truncated: false,
  nodes: [
    { path: 'Repos/acme-app/index.md', title: 'App', status: 'approved', type: 'index', missing: false, depth: 0 },
    { path: 'Lessons/a.md', title: 'Alpha', status: 'candidate', type: 'lesson', missing: false, depth: 1 },
    { path: 'Lessons/old.md', title: 'Alt', status: 'deprecated', type: 'lesson', missing: false, depth: 1 },
    { path: 'Lessons/fehlt.md', title: 'fehlt', status: null, type: null, missing: true, depth: 1 },
    { path: 'Lessons/deep.md', title: 'Deep', status: 'approved', type: 'lesson', missing: false, depth: 2 },
  ],
  edges: [
    { from: 'Repos/acme-app/index.md', to: 'Lessons/a.md', broken: false },
    { from: 'Repos/acme-app/index.md', to: 'Lessons/old.md', broken: false },
    { from: 'Repos/acme-app/index.md', to: 'Lessons/fehlt.md', broken: true },
    { from: 'Lessons/a.md', to: 'Lessons/deep.md', broken: false },
  ],
};

const folder = (p: string) => ({ path: p, notes_by_status: { candidate: 0, approved: 1, deprecated: 0, none: 0 }, total: 1 });
const VITALS = {
  notes_by_status: { candidate: 1, approved: 2, deprecated: 1, none: 0 }, notes: { total: 4, candidate: 1, approved: 2, deprecated: 1, none: 0 },
  links: { total: 3, per_note: 0.8 }, orphans: 0, broken_links: 1, candidates: 1, writes_today: 0, reads_today: { total: 0, by_folder: [] },
  clashes: { week: { total: 0, resolved: 0 } }, commits: { total: 1 }, clash_window_min: 10, path: '/vault',
  last_commit: null, obsidian_url: null, folders: [folder('Repos'), folder('Repos/acme-app'), folder('Repos/beta')],
};

const clash = (id: string, over: Obj = {}): Obj => ({
  id, path: 'Lessons/x.md', runs: ['run-first', 'run-second'], roles: ['architect', 'developer'], at: ['2026-10-30T10:00:00Z', '2026-10-30T10:05:00Z'],
  reason: 'hash_mismatch', status: 'open', attempted: { content: 'eins\nzwei\ndrei' }, current: { content: 'eins\nZWEI\ndrei' }, ...over,
});

function fetcher(opts: Obj = {}): (url: string, init: { method: string; body?: unknown }) => unknown {
  return (url, init) => {
    if (init.method === 'POST') return opts.post?.(url) ?? { id: 'x', status: 'resolved' };
    if (url.includes('/state')) return opts.state ?? dashboardState({ controls: { retry: true } });
    if (url.includes('/brain/vitals')) return VITALS;
    if (url.includes('/brain/candidates')) return { candidates: [] };
    if (url.includes('/brain/graph')) return typeof opts.graph === 'function' ? opts.graph(url) : opts.graph ?? GRAPH;
    if (url.includes('/brain/clashes')) return typeof opts.clashes === 'function' ? opts.clashes() : opts.clashes ?? { clashes: [] };
    return {};
  };
}
const text = (n: { textContent: string }) => n.textContent;
const circleOf = (p: ReturnType<typeof renderPage>, notePath: string) =>
  p.query('#brain-graph circle').find((c) => text(c.querySelectorAll('title')[0]!) === notePath)!;

describe('Brain page: section #graph (independent)', () => {
  it('has sections with the ids graph and clashes', () => {
    assert.match(BRAIN_HTML, /<section[^>]*id="graph"/);
    assert.match(BRAIN_HTML, /<section[^>]*id="clashes"/);
  });

  it('loads the graph for the first repository and offers a root per repository', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher() });
    await until(() => p.query('#brain-graph svg').length === 1);
    const graphFetch = p.fetches.find((f) => f.url.includes('/brain/graph'))!;
    assert.ok(decodeURIComponent(graphFetch.url).includes('root=Repos/acme-app/index'));
    assert.ok(graphFetch.url.includes('depth=2'));
    const options = p.query('#graph option');
    assert.equal(options.length, 2);
    assert.deepEqual(options.map(text), ['acme-app', 'beta']);
  });

  it('switching the repository reloads the graph for the other root', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher() });
    await until(() => p.query('#brain-graph svg').length === 1);
    const select = p.$('brain-graph-root');
    (select as any).value = 'Repos/beta/index.md';
    select.dispatch('change', {});
    await until(() => p.fetches.some((f) => decodeURIComponent(f.url).includes('root=Repos/beta/index')));
  });

  it('draws one circle per node and one line per edge in the SVG, without an external library', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher() });
    await until(() => p.query('#brain-graph svg').length === 1);
    assert.equal(p.query('#brain-graph svg circle').length, GRAPH.nodes.length);
    assert.equal(p.query('#brain-graph svg line').length, GRAPH.edges.length);
    assert.ok(!/<script[^>]+src=/i.test(BRAIN_HTML));
  });

  it('colours nodes by folder: different folders get different fills, the same folder the same fill', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher() });
    await until(() => p.query('#brain-graph svg').length === 1);
    const fillOf = (notePath: string) => circleOf(p, notePath).getAttribute('fill');
    assert.notEqual(fillOf('Repos/acme-app/index.md'), fillOf('Lessons/a.md'));
    assert.equal(fillOf('Lessons/a.md'), fillOf('Lessons/old.md'), 'same folder, same colour');
    assert.equal(fillOf('Lessons/deep.md'), fillOf('Lessons/a.md'));
  });

  it('draws a broken link red and dashed, other links neither', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher() });
    await until(() => p.query('#brain-graph svg').length === 1);
    const lines = p.query('#brain-graph svg line');
    const dashed = lines.filter((l) => (l.getAttribute('stroke-dasharray') ?? '') !== '');
    assert.equal(dashed.length, 1);
    const red = (dashed[0]!.getAttribute('stroke') ?? '').toLowerCase();
    assert.match(red, /^#(f8|ef|dc|fc|f4|e1)[0-9a-f]{4}$|red|rgb\(2/);
    const normal = lines.filter((l) => (l.getAttribute('stroke-dasharray') ?? '') === '');
    assert.equal(normal.length, 3);
    for (const l of normal) assert.notEqual((l.getAttribute('stroke') ?? '').toLowerCase(), red);
    assert.equal((circleOf(p, 'Lessons/fehlt.md').getAttribute('stroke') ?? '').toLowerCase(), red);
  });

  it('is one image for assistive technology; each node names its path in a <title>', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher() });
    await until(() => p.query('#brain-graph svg').length === 1);
    assert.equal(p.query('#brain-graph svg')[0]!.getAttribute('role'), 'img');
    assert.deepEqual(p.query('#brain-graph circle').map((c) => text(c.querySelectorAll('title')[0]!)).sort(), GRAPH.nodes.map((n) => n.path).sort());
    assert.equal(p.query('#brain-graph [tabindex]').length, 0);
  });

  it('gives the text alternative with the numbers of nodes, edges and broken links', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher() });
    await until(() => p.query('#brain-graph svg').length === 1);
    const t = text(p.$('brain-graph-text'));
    assert.equal(p.$('brain-graph-text').hidden, false);
    assert.match(t, /\b5\b.*Knoten/);
    assert.match(t, /\b4\b.*Kanten/);
    assert.match(t, /\b1\b.*kaputte/i);
    assert.equal(p.query('#brain-graph svg')[0]!.getAttribute('aria-label'), 'Ausschnitt des Notiz-Graphen rund um Repos/acme-app/index');
  });

  it('shows "Keine Links" for a graph without edges', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ graph: { ...GRAPH, nodes: GRAPH.nodes.slice(0, 1), edges: [] } }) });
    await until(() => text(p.$('brain-graph')) !== '');
    assert.equal(text(p.$('brain-graph')), 'Keine Links');
    assert.equal(p.query('#brain-graph svg').length, 0);
  });

  it('writes graph data only as text (no HTML injection through titles)', async () => {
    const evil = '<img src=x onerror=1>';
    const graph = { ...GRAPH, nodes: GRAPH.nodes.map((n, i) => (i === 1 ? { ...n, title: evil } : n)) };
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ graph }) });
    await until(() => p.query('#brain-graph svg').length === 1);
    assert.equal(p.query('#graph img').length, 0);
    assert.ok(p.query('#brain-graph text').map(text).some((t) => t.startsWith('<img')));
  });
});

describe('Brain page: section #clashes (independent)', () => {
  it('shows path, both roles, both times and the reason for an open clash', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ clashes: { clashes: [clash('k1')] } }) });
    await until(() => p.query('#brain-clashes .br-clash').length === 1);
    const t = text(p.query('#brain-clashes .br-clash')[0]!);
    for (const part of ['Lessons/x.md', 'Architect', 'Developer']) assert.ok(t.includes(part), part);
    assert.ok(/10:00/.test(t) || /1[0-2]:00/.test(t), 'first time shown: ' + t);
    assert.ok(/10:05/.test(t) || /1[0-2]:05/.test(t), 'second time shown: ' + t);
    assert.ok(/Hash|Schutz|hash/.test(t), 'reason shown');
  });

  it('shows the window reason differently from the hash reason', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ clashes: { clashes: [clash('k1'), clash('k2', { reason: 'window' })] } }) });
    await until(() => p.query('#brain-clashes .br-clash').length === 2);
    const [a, b] = p.query('#brain-clashes .br-clash').map(text);
    assert.notEqual(a!.replace(/k\d/g, ''), b!.replace(/k\d/g, ''));
  });

  it('copes with a missing run, role or time', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ clashes: { clashes: [clash('k1', { runs: [null, 'run-second'], roles: [null, null], at: [null, '2026-10-30T10:05:00Z'] })] } }) });
    await until(() => p.query('#brain-clashes .br-clash').length === 1);
    const t = text(p.query('#brain-clashes .br-clash')[0]!);
    assert.ok(t.includes('Unbekannte Rolle'));
    assert.ok(!t.includes('null') && !t.includes('undefined'));
  });

  it('shows the two versions side by side with only the changed line marked', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ clashes: { clashes: [clash('k1')] } }) });
    await until(() => p.query('#brain-clashes .br-diff').length === 1);
    const grid = p.query('#brain-clashes .br-diff')[0]!;
    const cells = grid.querySelectorAll('.br-cell').filter((c) => !c.classList.contains('br-cell-head'));
    assert.deepEqual(cells.map(text), ['eins', 'eins', 'zwei', 'ZWEI', 'drei', 'drei']);
    assert.deepEqual(grid.querySelectorAll('.br-del').map(text), ['zwei']);
    assert.deepEqual(grid.querySelectorAll('.br-add').map(text), ['ZWEI']);
    assert.equal(grid.querySelectorAll('.br-cell-head').length, 2);
  });

  it('marks nothing when the versions are identical', async () => {
    const same = { content: 'a\nb\nc' };
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ clashes: { clashes: [clash('k1', { attempted: same, current: same })] } }) });
    await until(() => p.query('#brain-clashes .br-diff').length === 1);
    const grid = p.query('#brain-clashes .br-diff')[0]!;
    assert.equal(grid.querySelectorAll('.br-del').length, 0);
    assert.equal(grid.querySelectorAll('.br-add').length, 0);
  });

  it('diffs by line: a block of added lines and a block of removed lines', async () => {
    const p = renderPage(BRAIN_HTML, undefined, {
      fetch: fetcher({ clashes: { clashes: [clash('k1', { attempted: { content: 'kopf\nalt1\nalt2\nmitte\nende' }, current: { content: 'kopf\nmitte\nneu1\nneu2\nneu3\nende' } })] } }),
    });
    await until(() => p.query('#brain-clashes .br-diff').length === 1);
    const grid = p.query('#brain-clashes .br-diff')[0]!;
    assert.deepEqual(grid.querySelectorAll('.br-del').map(text), ['alt1', 'alt2']);
    assert.deepEqual(grid.querySelectorAll('.br-add').map(text), ['neu1', 'neu2', 'neu3']);
    const left = grid.querySelectorAll('.br-cell').filter((c) => !c.classList.contains('br-cell-head') && !c.classList.contains('br-add') && !c.classList.contains('br-gap'));
    for (const unchanged of ['kopf', 'mitte', 'ende']) assert.ok(left.some((c) => text(c) === unchanged), unchanged);
  });

  it('does not hang on a large diff', async () => {
    const big = (tag: string) => Array.from({ length: 3000 }, (_, i) => (i % 7 === 0 ? `${tag}${i}` : `zeile ${i}`)).join('\n');
    const started = Date.now();
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ clashes: { clashes: [clash('k1', { attempted: { content: big('a') }, current: { content: big('b') } })] } }) });
    await until(() => p.query('#brain-clashes .br-clash').length === 1, 20_000);
    assert.ok(Date.now() - started < 15_000);
  });

  it('shows "gelöst" only with control_allowed and posts to the resolve route', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ clashes: { clashes: [clash('k1')] } }) });
    await until(() => p.query('#brain-clashes .br-clash button').length === 2);
    const b = p.query('#brain-clashes .br-clash button').find((x) => /gelöst/.test(text(x)))!;
    p.click(b);
    await until(() => p.fetches.some((f) => f.method === 'POST'));
    const post = p.fetches.find((f) => f.method === 'POST')!;
    assert.equal(post.url, '/api/v1/brain/clashes/k1/resolve');

    for (const controls of [{ retry: false }, { retry: false, pause: false }]) {
      const off = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ state: dashboardState({ controls }), clashes: { clashes: [clash('k1')] } }) });
      await until(() => off.query('#brain-clashes .br-clash').length === 1);
      assert.ok(!off.query('#brain-clashes button').some((x) => /gelöst/.test(text(x))));
      assert.ok(!off.fetches.some((f) => f.method === 'POST'));
    }
  });

  it('moves a resolved clash into the collapsed list below and leaves open ones above', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ clashes: { clashes: [clash('open1'), clash('done1', { status: 'resolved' }), clash('done2', { status: 'resolved' })] } }) });
    await until(() => p.query('#brain-clashes .br-clash').length === 1);
    assert.equal(p.query('#brain-clashes .br-clash')[0]!.dataset.id, 'open1');
    const details = p.$('brain-clashes-resolved');
    assert.equal(details.tagName.toLowerCase(), 'details');
    assert.equal(details.open, false);
    assert.deepEqual(details.querySelectorAll('.br-clash').map((c) => c.dataset.id).sort(), ['done1', 'done2']);
    assert.ok(!details.querySelectorAll('button').some((x) => /gelöst/.test(text(x))));
  });

  it('shows "Keine offenen Clashes" when there are no open clashes, also when only resolved ones exist', async () => {
    const none = renderPage(BRAIN_HTML, undefined, { fetch: fetcher() });
    await until(() => text(none.$('brain-clashes')) !== '');
    assert.equal(text(none.$('brain-clashes')), 'Keine offenen Clashes');
    const onlyDone = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ clashes: { clashes: [clash('d', { status: 'resolved' })] } }) });
    await until(() => text(onlyDone.$('brain-clashes')) !== '');
    assert.equal(text(onlyDone.$('brain-clashes')), 'Keine offenen Clashes');
    assert.equal(onlyDone.query('#brain-clashes-resolved .br-clash').length, 1);
  });

  it('inserts note contents as text only', async () => {
    const evil = '<script>alert(1)</script><b>x</b>';
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ clashes: { clashes: [clash('k1', { attempted: { content: evil }, current: { content: 'ok' } })] } }) });
    await until(() => p.query('#brain-clashes .br-clash').length === 1);
    assert.equal(p.query('#brain-clashes b').length, 0);
    assert.equal(p.query('#brain-clashes script').length, 0);
  });
});

describe('Brain page: motion (independent)', () => {
  const start = BRAIN_HTML.indexOf('<style');
  const css = BRAIN_HTML.slice(start, BRAIN_HTML.indexOf('</style>', start));
  const LAYOUT = /\b(width|height|top|left|right|bottom|margin[a-z-]*|padding[a-z-]*|max-height|flex[a-z-]*|grid[a-z-]*|font-size|border-width|inset)\b/;

  it('no transition or keyframe touches a layout property or uses "all"', () => {
    for (const m of css.matchAll(/transition:\s*([^;}]+)/g)) {
      const value = m[1]!.trim();
      assert.ok(!/\ball\b/.test(value), value);
      assert.ok(!LAYOUT.test(value), value);
    }
    for (const m of css.matchAll(/transition-property:\s*([^;}]+)/g)) assert.ok(!/\ball\b|width|height|top|left/.test(m[1]!), m[1]!);
    for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
      const props = [...m[2]!.matchAll(/([a-z-]+)\s*:/g)].map((x) => x[1]!);
      for (const prop of props) assert.ok(['opacity', 'transform'].includes(prop), `${m[1]}: ${prop}`);
    }
  });

  it('every animation and transition has a reduced-motion override', () => {
    const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map((m) => m[1]).join('\n');
    assert.notEqual(reduced, '');
    for (const m of css.matchAll(/([^{}]+)\{[^{}]*\b(?:animation|transition)\s*:\s*(?!none)[^;}]+/g)) {
      const selector = m[1]!.trim().split(/\s*,\s*/).pop()!;
      if (selector.startsWith('@') || selector.includes('prefers')) continue;
      if (!/\.br-|#brain|#graph|#clashes/.test(selector)) continue;
      assert.ok(reduced.includes(selector.replace(/:(hover|focus-visible)\b.*/, '')), `no reduced-motion rule for ${selector}`);
    }
  });
});
