import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';
import { BRAIN_HTML } from '../src/http/brain-page.ts';
import { startHttpServer } from '../src/http/server.ts';
import { CONTROLS_OFF } from '../src/http/tasks-page.ts';
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
