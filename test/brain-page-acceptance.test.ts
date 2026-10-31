import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BrainIndex, buildIndex, candidatesOf, foldersOf } from '../src/brain/index.ts';
import { ensureVault } from '../src/brain/vault.ts';
import { BRAIN_HTML } from '../src/http/brain-page.ts';
import { startHttpServer } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, renderPage, tempDir, until } from './helpers.ts';
import { dashboardState } from './helpers/page-fixtures.ts';

// E7-7a (#375), independent acceptance tests derived from the issue text: Brain page, brain.obsidian_url, folder counts, candidate preview.

type Obj = Record<string, any>;

const put = (vault: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(vault, rel), text);
};
const note = (fields: Record<string, string>, body = ''): string => `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n`;

function call(port: number, method: string, url: string, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: body === undefined ? {} : { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const text = (n: { textContent: string }) => n.textContent;

describe('brain.obsidian_url config', () => {
  const base = { tracker: { kind: 'github-project' } };
  const env = { HOME: '/home/u' };

  it('is empty by default and when set to blanks', () => {
    assert.equal(resolveConfig(base, { workflowPath: '/srv/flows/WORKFLOW.md', env, trackerDefaults }).brain.obsidianUrl, '');
    assert.equal(resolveConfig({ ...base, brain: { obsidian_url: '   ' } }, { workflowPath: '/srv/flows/WORKFLOW.md', env, trackerDefaults }).brain.obsidianUrl, '');
  });

  it('accepts http, https and obsidian URLs', () => {
    for (const url of ['http://brain.lan:8080/', 'https://brain.example.com/vault', 'obsidian://open?vault=brain']) {
      assert.equal(resolveConfig({ ...base, brain: { obsidian_url: url } }, { workflowPath: '/srv/flows/WORKFLOW.md', env, trackerDefaults }).brain.obsidianUrl, url);
    }
  });

  it('rejects dangerous or unsupported values and non-strings', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'ftp://x', 'brain.lan', 'https://', 42]) {
      assert.throws(() => resolveConfig({ ...base, brain: { obsidian_url: bad } }, { workflowPath: '/srv/flows/WORKFLOW.md', env, trackerDefaults }), /brain\.obsidian_url/, String(bad));
    }
  });

  it('keeps the other brain keys working and unknown keys flagged', () => {
    const cfg = resolveConfig({ ...base, brain: { enabled: true, clash_window_ms: 5, obsidian_url: 'https://b.lan' } }, { workflowPath: '/srv/flows/WORKFLOW.md', env, trackerDefaults });
    assert.equal(cfg.brain.enabled, true);
    assert.equal(cfg.brain.clashWindowMs, 5);
    assert.throws(() => resolveConfig({ ...base, brain: { obsidian_urls: 'https://b.lan' } }, { workflowPath: '/srv/flows/WORKFLOW.md', env, trackerDefaults }), /brain\.obsidian_urls/);
  });
});

describe('foldersOf and preview', () => {
  function vault(): string {
    const v = path.join(tempDir(), 'vault');
    put(v, 'README.md', note({ status: 'approved' }, 'root'));
    put(v, 'Inbox/a.md', note({ status: 'candidate' }, 'a'));
    put(v, 'Inbox/b.md', note({ status: 'candidate' }, 'b'));
    put(v, 'Repos/acme-app/index.md', note({ status: 'approved' }, 'i'));
    put(v, 'Repos/acme-app/old.md', note({ status: 'deprecated' }, 'o'));
    put(v, 'Repos/acme-app/deep/er/x.md', 'no frontmatter at all');
    put(v, '.obsidian/hidden.md', note({ status: 'approved' }));
    return v;
  }

  it('counts recursively per status, with parents, sorted, ignoring root notes and dot folders', async () => {
    const folders = foldersOf(await buildIndex(vault()));
    assert.deepEqual(folders.map((f) => f.path), ['Inbox', 'Repos', 'Repos/acme-app', 'Repos/acme-app/deep', 'Repos/acme-app/deep/er']);
    const by = Object.fromEntries(folders.map((f) => [f.path, f]));
    assert.deepEqual(by['Inbox']!.notes_by_status, { candidate: 2, approved: 0, deprecated: 0, none: 0 });
    assert.equal(by['Inbox']!.total, 2);
    assert.deepEqual(by['Repos']!.notes_by_status, { candidate: 0, approved: 1, deprecated: 1, none: 1 });
    assert.equal(by['Repos']!.total, 3);
    assert.deepEqual(by['Repos/acme-app/deep/er']!.notes_by_status, { candidate: 0, approved: 0, deprecated: 0, none: 1 });
    for (const f of folders) assert.equal(f.total, Object.values(f.notes_by_status).reduce((a, b) => a + b, 0), f.path);
    for (const f of folders) assert.ok(!f.path.endsWith('/') && !f.path.startsWith('.'), f.path);
  });

  it('gives an empty list for an empty vault', async () => {
    assert.deepEqual(foldersOf(await buildIndex(path.join(tempDir(), 'empty'))), []);
  });

  it('keeps at most the first 10 body lines of a candidate, without frontmatter', async () => {
    const v = path.join(tempDir(), 'vault');
    const lines = Array.from({ length: 25 }, (_, i) => `zeile ${i + 1}`);
    put(v, 'Inbox/long.md', note({ status: 'candidate', title: 'Lang' }, `\n\n${lines.join('\n')}`));
    put(v, 'Inbox/crlf.md', '---\r\nstatus: candidate\r\n---\r\nA\r\nB\r\n');
    put(v, 'Inbox/huge.md', note({ status: 'candidate' }, 'x'.repeat(10_000)));
    put(v, 'Lessons/ok.md', note({ status: 'approved' }, 'secret body'));
    const index = await buildIndex(v);
    const cands = candidatesOf(index);
    const long = cands.find((c) => c.path === 'Inbox/long.md')!;
    assert.deepEqual(long.preview.split('\n'), lines.slice(0, 10));
    assert.ok(!long.preview.includes('status:') && !long.preview.includes('---'));
    const crlf = cands.find((c) => c.path === 'Inbox/crlf.md')!;
    assert.ok(!crlf.preview.includes('\r'));
    assert.ok(crlf.preview.includes('A') && crlf.preview.includes('B') && !crlf.preview.includes('status'));
    assert.ok(cands.find((c) => c.path === 'Inbox/huge.md')!.preview.length <= 2000);
    assert.ok(!cands.some((c) => c.path === 'Lessons/ok.md'));
    assert.equal(index.notes.get('Lessons/ok.md')!.preview, undefined);
  });
});

describe('Brain API and page against a real vault', () => {
  async function start(obsidianUrl: string | null, extra: (vault: string) => void = () => {}) {
    const vault = path.join(tempDir(), 'vault');
    await ensureVault(vault, ['acme/app'], new Date('2026-10-01T00:00:00Z'));
    const body = Array.from({ length: 14 }, (_, i) => `zeile ${i + 1}`).join('\n');
    put(vault, 'Inbox/neu.md', note({ type: 'lesson', status: 'candidate', created: '2026-10-05', title: 'Neu', target: 'Lessons/neu.md' }, body));
    put(vault, 'Inbox/alt.md', note({ type: 'decision', status: 'candidate', created: '2026-10-02', title: 'Alt', repo: 'acme/app', issue: '12', role: 'developer' }, 'kurz'));
    extra(vault);
    const brain: Obj = { enabled: true, path: vault, ...(obsidianUrl === null ? {} : { obsidian_url: obsidianUrl }) };
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), { brain }))),
      runner: new FakeRunner(), logger: Logger.silent(), env: {}, logDir: null, timers: new ManualTimers(), createAdapter: () => new FakeTracker(),
    });
    await orchestrator.buildBrainIndex();
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    return { vault, server };
  }

  it('hands brain.obsidian_url to the client through /api/v1/brain/vitals', async () => {
    for (const [configured, expected] of [['https://brain.lan', 'https://brain.lan'], [null, null], ['', null]] as const) {
      const { server } = await start(configured);
      try {
        const res = await call(server.port, 'GET', '/api/v1/brain/vitals');
        assert.equal(res.status, 200);
        assert.equal(JSON.parse(res.body).obsidian_url, expected);
      } finally {
        await server.close();
      }
    }
  });

  it('serves a preview of at most 10 lines per candidate, oldest first', async () => {
    const { server } = await start(null);
    try {
      const body = JSON.parse((await call(server.port, 'GET', '/api/v1/brain/candidates')).body);
      assert.deepEqual(body.candidates.map((c: Obj) => c.path), ['Inbox/alt.md', 'Inbox/neu.md']);
      const neu = body.candidates[1];
      assert.equal(neu.preview.split('\n').length, 10);
      assert.equal(neu.target, 'Lessons/neu.md');
      assert.equal(body.candidates[0].preview, 'kurz');
    } finally {
      await server.close();
    }
  });

  it('renders the real API output and a promotion moves the folder counts', async () => {
    const { server, vault } = await start('obsidian://open?vault=brain');
    try {
      const get = async (url: string) => JSON.parse((await call(server.port, 'GET', url)).body);
      // the page needs synchronous answers: pre-fetch the real bodies
      const vitals = await get('/api/v1/brain/vitals');
      const candidates = await get('/api/v1/brain/candidates');
      const real = renderPage(BRAIN_HTML, undefined, {
        fetch: (url, init) => {
          if (init.method === 'POST') return { path: 'Lessons/neu.md', previous_path: 'Inbox/neu.md', hash: 'h', sha: 's' };
          if (url.includes('/state')) return dashboardState({ controls: { retry: true } });
          if (url.includes('/brain/vitals')) return vitals;
          if (url.includes('/brain/candidates')) return candidates;
          return {};
        },
      });
      await until(() => real.query('#brain-candidates .br-cand').length === 2);
      const cards = real.query('#brain-candidates .br-cand');
      assert.deepEqual(cards.map((c) => c.dataset.path), ['Inbox/alt.md', 'Inbox/neu.md']);
      const first = text(cards[0]!);
      for (const part of ['Alt', 'decision', 'acme/app', '12', 'developer', 'Inbox/alt.md']) assert.ok(first.includes(part), part);
      assert.ok(text(cards[1]!).includes('Lessons/neu.md'), 'target path of the frontmatter');
      assert.ok(text(real.$('brain-folders')).includes('Inbox'));
      assert.equal(real.query('#brain-open a').length, 1);
      assert.equal(real.query('#brain-open a')[0]!.getAttribute('href'), 'obsidian://open?vault=brain');

      // server side: the promotion the button triggers moves the note and the folder counts follow
      const before = (await get('/api/v1/brain/vitals')).folders.find((f: Obj) => f.path === 'Inbox');
      assert.equal(before.notes_by_status.candidate, 2);
      const res = await call(server.port, 'POST', '/api/v1/brain/candidates/Inbox%2Fneu.md/approve', '{}');
      assert.equal(res.status, 200, res.body);
      const moved = JSON.parse(res.body).path;
      assert.ok(fs.existsSync(path.join(vault, moved)));
      assert.ok(!fs.existsSync(path.join(vault, 'Inbox/neu.md')));
      assert.match(fs.readFileSync(path.join(vault, moved), 'utf8'), /status: approved/);
      const after = await get('/api/v1/brain/vitals');
      assert.equal(after.folders.find((f: Obj) => f.path === 'Inbox').notes_by_status.candidate, 1);
      const lessons = after.folders.find((f: Obj) => f.path === path.posix.dirname(moved));
      assert.equal(lessons.notes_by_status.approved >= 1, true);
      assert.deepEqual((await get('/api/v1/brain/candidates')).candidates.map((c: Obj) => c.path), ['Inbox/alt.md']);
    } finally {
      await server.close();
    }
  });

  it('renders the real graph around the repository index with the broken link (E7-7b)', async () => {
    const { server } = await start(null, (vault) => {
      put(vault, 'Repos/acme-app/index.md', note({ type: 'index', status: 'approved', repo: 'acme/app' }, '# Acme\n[[Inbox/alt]] [[Lessons/gibtsnicht]]'));
    });
    try {
      const get = async (url: string) => JSON.parse((await call(server.port, 'GET', url)).body);
      const vitals = await get('/api/v1/brain/vitals');
      const candidates = await get('/api/v1/brain/candidates');
      const clashes = await get('/api/v1/brain/clashes');
      const graphs = new Map<string, unknown>();
      for (const f of vitals.folders as Obj[]) {
        const m = /^Repos\/([^/]+)$/.exec(f.path);
        if (m) {
          const url = `/api/v1/brain/graph?root=${encodeURIComponent(`Repos/${m[1]}/index.md`)}&depth=2`;
          graphs.set(url, await get(url));
        }
      }
      assert.ok(graphs.size >= 1);
      const real = renderPage(BRAIN_HTML, undefined, {
        fetch: (url) => {
          if (url.includes('/state')) return dashboardState({ controls: { retry: true } });
          if (url.includes('/brain/vitals')) return vitals;
          if (url.includes('/brain/candidates')) return candidates;
          if (url.includes('/brain/clashes')) return clashes;
          if (url.includes('/brain/graph')) return graphs.get(url) ?? { __status: 404, error: { code: 'root_not_found', message: 'x' } };
          return {};
        },
      });
      await until(() => real.query('#brain-graph svg').length === 1);
      const paths = real.query('#brain-graph g.br-node').map((n) => n.dataset.path);
      for (const p of ['Repos/acme-app/index.md', 'Inbox/alt.md', 'Lessons/gibtsnicht.md']) assert.ok(paths.includes(p), p);
      assert.equal(real.query('#brain-graph g.br-node-missing')[0]!.dataset.path, 'Lessons/gibtsnicht.md');
      assert.equal(real.query('#brain-graph line.br-edge-broken').length, 1);
      assert.match(text(real.$('brain-graph-text')), /1 kaputte Links/);
      assert.equal(text(real.$('brain-clashes')), 'Keine Konflikte');
    } finally {
      await server.close();
    }
  });

  it('serves /brain as HTML for GET only', async () => {
    const { server } = await start(null);
    try {
      const res = await call(server.port, 'GET', '/brain');
      assert.equal(res.status, 200);
      assert.ok(res.body.startsWith('<!doctype html>') || res.body.toLowerCase().includes('<html'));
      for (const part of ['id="candidates"', 'Kandidaten', 'Ordner', 'Das Brain ist nicht aktiviert (brain.enabled in WORKFLOW.md).', 'Keine Kandidaten. Alles ist gesichtet.']) {
        assert.ok(res.body.includes(part), part);
      }
      assert.ok(!res.body.includes('Diese Seite kommt in Kürze'));
    } finally {
      await server.close();
    }
  });
});

describe('Brain page behaviour (fake fetch)', () => {
  const vitals = (over: Obj = {}): Obj => ({
    notes_by_status: { candidate: 1, approved: 3, deprecated: 0, none: 0 },
    links: 0, orphans: 0, broken_links: 0, candidates: 1, writes_today: 0, reads_today: 0, last_commit: null, obsidian_url: null,
    folders: [{ path: 'Inbox', notes_by_status: { candidate: 1, approved: 0, deprecated: 0, none: 0 }, total: 1 }],
    ...over,
  });
  const cand = (over: Obj = {}): Obj => ({ path: 'Inbox/a b.md', title: 'T', type: 'lesson', repo: 'acme/app', issue: '7', role: 'developer', created: '2026-10-29', target: 'Lessons/', preview: 'p', ...over });
  const fetcher = (o: Obj = {}) => (url: string, init: { method: string }) => {
    if (init.method === 'POST') return o.post ? o.post(url) : { path: 'Lessons/a b.md' };
    if (url.includes('/state')) return o.state ?? dashboardState({ controls: { retry: true } });
    if (url.includes('/brain/vitals')) return o.vitals ?? vitals();
    if (url.includes('/brain/candidates')) return o.candidates ?? { candidates: [cand()] };
    return {};
  };
  const btn = (p: ReturnType<typeof renderPage>, label: string) => p.query('#brain-candidates button').find((b) => text(b) === label)!;

  it('offers the buttons without a controls object and hides them with controls.retry false', async () => {
    const noControls = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ state: { ...dashboardState(), controls: undefined } }) });
    await until(() => noControls.query('#brain-candidates .br-cand').length === 1);
    assert.equal(noControls.query('#brain-candidates button').length, 2);
    const off = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ state: dashboardState({ controls: { retry: false } }) }) });
    await until(() => off.query('#brain-candidates .br-cand').length === 1);
    assert.equal(off.query('#brain-candidates button').length, 0);
  });

  it('url-encodes spaces and slashes of the path in every action', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher() });
    await until(() => p.query('#brain-candidates .br-cand').length === 1);
    p.click(btn(p, 'Befördern'));
    await until(() => p.query('#brain-undo button').length === 1);
    assert.equal(p.fetches.find((f) => f.method === 'POST')!.url, '/api/v1/brain/candidates/Inbox%2Fa%20b.md/approve');
    p.click(p.query('#brain-undo button')[0]!);
    await until(() => p.fetches.filter((f) => f.method === 'POST').length === 2);
    assert.equal(p.fetches.filter((f) => f.method === 'POST')[1]!.url, '/api/v1/brain/candidates/Lessons%2Fa%20b.md/revert');
  });

  it('does not reject when the confirmation is declined', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher(), confirm: false });
    await until(() => p.query('#brain-candidates .br-cand').length === 1);
    p.click(btn(p, 'Verwerfen'));
    await new Promise((r) => setImmediate(r));
    assert.equal(p.fetches.filter((f) => f.method === 'POST').length, 0);
  });

  it('shows the rejected hint at the entry and keeps the entry listed', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ post: () => ({ __status: 409, error: { code: 'rejected', message: 'Notiz nicht gültig' } }) }) });
    await until(() => p.query('#brain-candidates .br-cand').length === 1);
    p.click(btn(p, 'Befördern'));
    await until(() => text(p.query('#brain-candidates .br-msg')[0]!) !== '');
    assert.ok(text(p.query('#brain-candidates .br-msg')[0]!).includes('Notiz nicht gültig'));
    assert.equal(p.query('#brain-candidates .br-cand').length, 1);
    assert.equal(p.query('#brain-undo button').length, 0);
  });

  it('reloads the candidate list after reject', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher() });
    await until(() => p.query('#brain-candidates .br-cand').length === 1);
    const gets = () => p.fetches.filter((f) => f.method === 'GET' && f.url.includes('/brain/candidates')).length;
    const before = gets();
    p.click(btn(p, 'Verwerfen'));
    await until(() => gets() > before);
    assert.equal(p.fetches.find((f) => f.method === 'POST')!.url, '/api/v1/brain/candidates/Inbox%2Fa%20b.md/reject');
  });

  it('links to the base URL for the https edit link and appends file= with ? for a bare obsidian URL', async () => {
    const https = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ vitals: vitals({ obsidian_url: 'https://brain.lan/' }) }) });
    await until(() => https.query('#brain-candidates .br-cand').length === 1);
    const a = https.query('#brain-candidates a').find((x) => text(x) === 'In Obsidian bearbeiten')!;
    assert.ok(a.getAttribute('href')!.startsWith('https://brain.lan/'));
    assert.equal(a.getAttribute('target'), '_blank');
    assert.match(a.getAttribute('rel') ?? '', /noopener/);
    const obs = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ vitals: vitals({ obsidian_url: 'obsidian://vault/brain' }) }) });
    await until(() => obs.query('#brain-candidates .br-cand').length === 1);
    const href = obs.query('#brain-candidates a').find((x) => text(x) === 'In Obsidian bearbeiten')!.getAttribute('href')!;
    assert.ok(href.startsWith('obsidian://vault/brain') && href.includes('file=') && href.includes(encodeURIComponent('Inbox/a b')), href);
  });

  it('never renders unsafe URLs as a link', async () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'JaVaScRiPt:alert(1)']) {
      const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ vitals: vitals({ obsidian_url: bad }) }) });
      await until(() => p.query('#brain-candidates .br-cand').length === 1);
      assert.equal(p.query('a').filter((a) => /^(javascript|data):/i.test(a.getAttribute('href') ?? '')).length, 0, bad);
      assert.equal(p.query('#brain-open a').length, 0, bad);
    }
  });

  it('computes status bar shares and survives all-zero vitals and an empty folder list', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({
      vitals: vitals({ notes_by_status: { candidate: 0, approved: 0, deprecated: 0, none: 0 }, candidates: 0, folders: [] }),
      candidates: { candidates: [] },
    }) });
    await until(() => text(p.$('brain-candidates')) !== '');
    assert.equal(text(p.$('brain-candidates')), 'Keine Kandidaten. Alles ist gesichtet.');
    assert.equal(p.$('brain-off').hidden, true);
    assert.ok(p.query('#brain-vitals .ui-kpi').length > 0);

    const half = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ vitals: vitals({ notes_by_status: { candidate: 1, approved: 1, deprecated: 2, none: 0 } }) }) });
    await until(() => half.query('#brain-status .ui-stack').length === 1);
    const t = text(half.$('brain-status'));
    assert.ok(t.includes('50') || (half.query('#brain-status .ui-stack')[0]!.getAttribute('aria-label') ?? '').includes('2'), t);
  });

  it('shows an error text instead of the brain notice for non-404 failures', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ vitals: { __status: 500, error: { code: 'x' } } }) });
    await until(() => p.$('brain-error').hidden === false);
    assert.equal(p.$('brain-off').hidden, true);
    assert.ok(text(p.$('brain-error')).length > 0);
  });

  it('shows the notice when only one of the two routes answers 404', async () => {
    const gone = { __status: 404, error: { code: 'brain_disabled' } };
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ candidates: gone }) });
    await until(() => p.$('brain-off').hidden === false);
    assert.equal(text(p.$('brain-off')), 'Das Brain ist nicht aktiviert (brain.enabled in WORKFLOW.md).');
    assert.equal(p.query('#brain-candidates .br-cand').length, 0);
  });

  it('hides the controls when /api/v1/state fails', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ state: { __status: 500, error: {} } }) });
    await until(() => p.query('#brain-candidates .br-cand').length === 1);
    assert.equal(p.query('#brain-candidates button').length, 0);
  });

  it('escapes titles, paths, types, repos and folder names', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({
      candidates: { candidates: [cand({ title: evil, path: `Inbox/${evil}.md`, type: evil, repo: evil, role: evil, target: evil, issue: evil, preview: evil })] },
      vitals: vitals({ folders: [{ path: evil, notes_by_status: { candidate: 0, approved: 1, deprecated: 0, none: 0 }, total: 1 }] }),
    }) });
    await until(() => p.query('#brain-candidates .br-cand').length === 1);
    assert.equal(p.query('img').length, 0);
    assert.ok(text(p.$('brain-folders')).includes(evil));
  });

  it('links the issue only for numeric issue numbers', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ candidates: { candidates: [cand({ issue: '7' }), cand({ path: 'Inbox/z.md', issue: 'javascript:1' })] } }) });
    await until(() => p.query('#brain-candidates .br-cand').length === 2);
    const hrefs = p.query('#brain-candidates a').map((a) => a.getAttribute('href') ?? '');
    assert.ok(hrefs.some((h) => h.startsWith('/issue?id=')));
    assert.ok(!hrefs.some((h) => h.startsWith('javascript')));
  });

  it('builds the folder tree with nesting and per-status counts', async () => {
    const f = (p: string, c: number, a: number, d: number) => ({ path: p, notes_by_status: { candidate: c, approved: a, deprecated: d, none: 0 }, total: c + a + d });
    const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher({ vitals: vitals({ folders: [f('Repos', 0, 3, 1), f('Repos/a', 0, 2, 0), f('Repos/b', 0, 1, 1), f('Repos/b/deep', 0, 0, 1), f('Inbox', 4, 0, 0)] }) }) });
    await until(() => p.query('#brain-folders .br-folder').length > 0);
    const root = p.query('#brain-folders details').filter((d) => text(d.querySelectorAll('summary')[0]!).includes('Repos'))[0]!;
    const sum = text(root.querySelectorAll('summary')[0]!);
    assert.ok(sum.includes('4') && sum.includes('approved 3') && sum.includes('deprecated 1'), sum);
    const t = text(root);
    for (const name of ['a', 'b', 'deep']) assert.ok(t.includes(name), name);
    assert.ok(text(p.$('brain-folders')).includes('candidate 4'));
  });
});
