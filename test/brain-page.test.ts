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

// E7-7a (#375), E7-8 (#391): the Brain page (title block, vitals, candidate review, structure, graph, clashes).

type Obj = Record<string, any>;

function vitals(over: Obj = {}): Obj {
  return {
    notes_by_status: { candidate: 2, approved: 6, deprecated: 2, none: 0 },
    notes: { total: 10, candidate: 2, approved: 6, deprecated: 2, none: 0 },
    links: { total: 23, per_note: 2.3 }, orphans: 1, broken_links: 3, candidates: 2, writes_today: 4,
    reads_today: { total: 9, by_folder: [{ folder: 'Repos', reads: 6, pct: 62 }, { folder: 'Lessons', reads: 3, pct: 33 }] },
    clashes: { week: { total: 3, resolved: 1 } }, commits: { total: 1234 }, clash_window_min: 10, path: '/srv/brain',
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
    if (url.includes('/brain/candidates')) return typeof opts.candidates === 'function' ? opts.candidates() : opts.candidates ?? { candidates: [cand('a'), cand('b')] };
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
      for (const part of ['id="candidates"', 'Kandidaten-Review', 'Struktur', 'Write-Clashes']) assert.ok(res.body.includes(part), part);
      assert.ok(!res.body.includes('Diese Seite kommt in Kürze'));
    } finally {
      await server.close();
    }
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
  id, path: 'Lessons/x.md', runs: ['run-a', 'run-b'], roles: ['architect', 'developer'], issues: ['acme/app#7', 'acme/app#9'],
  at: ['2026-10-30T10:00:00Z', '2026-10-30T10:01:00Z'], reason: 'hash_mismatch', status: 'open',
  base: { content: 'a\nb\nc', hash: 'h0' }, attempted: { content: 'a\nb\nc' }, current: { content: 'a\nx\nc', hash: 'h1' }, ...over,
});
const vitalsTwoRepos = () => vitals({ folders: [...vitals().folders, { path: 'Repos/beta', notes_by_status: { candidate: 0, approved: 1, deprecated: 0, none: 0 }, total: 1 }] });


const pad = (n: number) => String(n).padStart(2, '0');
const hmOf = (iso: string) => `${pad(new Date(iso).getHours())}:${pad(new Date(iso).getMinutes())}`;
const fresh = (p: ReturnType<typeof renderPage>) => until(() => p.query('#brain-vitals .ui-kpi').length > 0);

describe('Brain page title block (E7-8)', () => {
  it('shows h1, the subtitle with vault path and commit count (de-DE) and the Obsidian link only for a safe URL', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ vitals: vitals({ obsidian_url: 'https://brain.lan' }) }) });
    await fresh(p);
    assert.equal(text(p.query('h1')[0]!), 'Brain');
    const sub = p.$('brain-sub');
    assert.equal(text(sub), 'Das gemeinsame Gedächtnis der Agents · Vault /srv/brain · 1.234 Commits');
    assert.equal(text(sub.querySelectorAll('code')[0]!), '/srv/brain');
    const a = p.query('#brain-open a')[0]!;
    assert.equal(text(a), 'In Obsidian öffnen ↗');
    assert.ok(a.classList.contains('ui-btn-obsidian') && a.classList.contains('ui-btn-40'));
    assert.equal(a.getAttribute('href'), 'https://brain.lan');
    assert.equal(a.getAttribute('target'), '_blank');
    assert.match(a.getAttribute('rel') ?? '', /noopener/);
    for (const url of [null, 'javascript:alert(1)']) {
      const q = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ vitals: vitals({ obsidian_url: url }) }) });
      await fresh(q);
      assert.equal(q.query('#brain-open a').length, 0, String(url));
    }
  });

  it('uses the Obsidian tone of the mockup', () => {
    assert.match(BRAIN_HTML, /\.ui-btn\.ui-btn-obsidian \{ background: rgba\(167, ?139, ?250, ?0?\.18\); border-color: rgba\(167, ?139, ?250, ?0?\.55\); color: var\(--violet-100\); \}/);
    assert.match(BRAIN_HTML, /--violet-100: #ede9fe/i);
  });
});

describe('Brain page vitals (E7-8)', () => {
  it('renders the notes card over two columns with the stacked bar, legend and four tiles', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch() });
    await fresh(p);
    const section = p.$('brain-vitals');
    assert.equal(section.tagName.toLowerCase(), 'section');
    assert.ok(section.classList.contains('g'));
    assert.equal(section.getAttribute('aria-label'), 'Vitalwerte');
    const notes = p.query('#brain-vitals .br-notes')[0]!;
    assert.equal(text(notes.querySelectorAll('.br-notes-label')[0]!), 'Notizen');
    assert.equal(text(notes.querySelectorAll('.br-notes-value')[0]!), '10');
    const stack = notes.querySelectorAll('.ui-stack')[0]!;
    assert.equal(stack.getAttribute('role'), 'img');
    assert.equal(stack.getAttribute('aria-label'), '6 approved, 2 Kandidaten, 2 veraltet');
    assert.deepEqual(stack.querySelectorAll('.ui-stack-part').map((s) => s.style.background), ['#34d399', '#fbbf24', '#64748b']);
    assert.deepEqual(notes.querySelectorAll('.br-legend-item').map(text), ['6 approved', '2 Kandidaten', '2 veraltet']);
    assert.equal(notes.querySelectorAll('.br-legend .ui-dot').length, 3);
    const tiles = p.query('#brain-vitals .ui-kpi');
    assert.deepEqual(tiles.map((t) => text(t.querySelectorAll('.ui-kpi-label')[0]!)), ['Links', 'Waisen', 'Kaputte Links', 'Writes / Reads heute']);
    assert.deepEqual(tiles.map((t) => text(t.querySelectorAll('.ui-kpi-value')[0]!)), ['23', '1', '3', '4 / 9']);
    assert.deepEqual(tiles.map((t) => text(t.querySelectorAll('.ui-kpi-sub')[0]!)), ['2,3 je Notiz', 'ohne ein- und ausgehende Links', 'Ziel fehlt', '62 % der Reads aus Repos/']);
    assert.deepEqual(tiles.slice(0, 3).map((t) => t.querySelectorAll('.ui-kpi-value')[0]!.style.color), ['#38bdf8', '#a78bfa', '#f87171']);
  });

  it('says "keine Reads heute" without reads', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ vitals: vitals({ reads_today: { total: 0, by_folder: [] } }) }) });
    await fresh(p);
    assert.equal(text(p.query('#brain-vitals .ui-kpi')[3]!.querySelectorAll('.ui-kpi-sub')[0]!), 'keine Reads heute');
  });

  it('lays out the grid as in the mockup', () => {
    assert.match(BRAIN_HTML, /\.br-vitals \{ display: grid; grid-template-columns: repeat\(auto-fit, minmax\(160px, 1fr\)\); gap: 12px;/);
    assert.match(BRAIN_HTML, /\.br-notes \{ grid-column: span 2;/);
    assert.match(BRAIN_HTML, /\.br-notes-label \{ font-size: 13px;/);
    assert.match(BRAIN_HTML, /\.br-notes-value \{ font: 500 26px\/1\.2 var\(--mono\)/);
    assert.match(BRAIN_HTML, /\.ui-stack \{ display: flex; height: 10px;/);
    assert.match(BRAIN_HTML, /\.br-legend \{[^}]*font-size: 12px;/);
  });
});

describe('Brain page candidate review (E7-8)', () => {
  it('shows head, intro and cards with role, issue, age, German type name, target path and excerpt', async () => {
    const long = 'x'.repeat(300);
    const list = [
      cand('a', { type: 'lesson' }), cand('b', { type: 'index', target: 'Repos/acme-app/' }), cand('c', { type: 'decision', target: 'Decisions/x.md' }),
      cand('d', { type: 'agent', target: 'Agents/' }), cand('e', { type: 'note', target: 'Inbox/', preview: long }),
    ];
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ candidates: { candidates: list } }) });
    await until(() => p.query('#brain-candidates .br-cand').length === 5);
    assert.equal(text(p.$('candidates-title')), 'Kandidaten-Review');
    assert.ok(p.$('candidates-title').classList.contains('lbl'));
    assert.equal(text(p.$('brain-cand-count')), '5 offen von 5');
    assert.equal(text(p.query('#candidates .br-intro')[0]!), 'Neue Notizen der Agents. Erst nach dem Befördern bevorzugen Agents sie beim Lesen.');
    const cards = p.query('#brain-candidates .br-cand');
    for (const c of cards) assert.equal(c.tagName.toLowerCase(), 'article');
    assert.ok(cards.every((c) => c.classList.contains('gi')));
    assert.deepEqual(cards.map((c) => text(c.querySelectorAll('.br-type')[0]!)), ['Lesson', 'Repo-Wissen', 'Entscheidung', 'Agent-Notiz', 'Sonstiges']);
    assert.deepEqual(cards.map((c) => text(c.querySelectorAll('.br-target')[0]!)), ['Inbox/ → Lessons/', 'Inbox/ → Repos/acme-app/', 'Inbox/ → Decisions/', 'Inbox/ → Agents/', 'Inbox/ → Inbox/']);
    const meta = cards[0]!.querySelectorAll('.br-meta')[0]!;
    assert.ok(text(meta).startsWith('Developer#7vor '), text(meta));
    assert.equal(meta.querySelectorAll('.br-role')[0]!.style.color, '#34d399');
    assert.equal(meta.querySelectorAll('a')[0]!.getAttribute('href'), '/issue?id=acme%2Fapp%237');
    assert.equal(text(cards[0]!.querySelectorAll('.br-title')[0]!), 'Titel a');
    assert.equal(text(cards[0]!.querySelectorAll('.br-excerpt')[0]!), '# a zeile');
    const cut = text(cards[4]!.querySelectorAll('.br-excerpt')[0]!);
    assert.equal(cut, 'x'.repeat(200) + '…');
  });

  it('gives the age as "vor 4 min", "vor 1 h" and "vor 2 Tagen"', async () => {
    const at = (ms: number) => new Date(Date.parse('2026-10-30T12:00:00Z') - ms).toISOString();
    const list = [cand('a', { created: at(4 * 60_000 + 5000) }), cand('b', { created: at(3600_000 + 5000) }), cand('c', { created: at(2 * 86400_000 + 5000) })];
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ candidates: { candidates: list } }) });
    await until(() => p.query('#brain-candidates .br-cand').length === 3);
    assert.deepEqual(p.query('#brain-candidates .br-age').map(text).sort(), ['vor 1 h', 'vor 2 Tagen', 'vor 4 min']);
  });

  it('sorts the oldest first', async () => {
    const list = [cand('new', { created: '2026-10-20' }), cand('none', { created: null }), cand('old', { created: '2026-10-01' })];
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ candidates: { candidates: list } }) });
    await until(() => p.query('#brain-candidates .br-cand').length === 3);
    assert.deepEqual(p.query('#brain-candidates .br-cand').map((c) => c.dataset.path), ['Inbox/old.md', 'Inbox/new.md', 'Inbox/none.md']);
  });

  it('shows the 40 px buttons only with control, the edit link only with a URL', async () => {
    const on = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ vitals: vitals({ obsidian_url: 'obsidian://open?vault=b' }) }) });
    await until(() => on.query('#brain-candidates .br-cand').length === 2);
    const card = on.query('#brain-candidates .br-cand')[0]!;
    const actions = card.querySelectorAll('.br-actions')[0]!.children;
    assert.deepEqual(actions.map(text), ['Befördern', 'In Obsidian bearbeiten ↗', 'Verwerfen']);
    assert.ok(actions.every((b) => b.classList.contains('ui-btn-40')));
    assert.ok(actions[0]!.classList.contains('ui-btn-approve') && actions[1]!.classList.contains('ui-btn-obsidian') && actions[2]!.classList.contains('ui-btn-danger'));
    assert.equal(actions[1]!.getAttribute('href'), 'obsidian://open?vault=b&file=Inbox%2Fa');
    assert.equal(on.$('brain-controls-off').hidden, true);

    const noUrl = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch() });
    await until(() => noUrl.query('#brain-candidates .br-cand').length === 2);
    assert.deepEqual(noUrl.query('#brain-candidates .br-cand')[0]!.querySelectorAll('.br-actions')[0]!.children.map(text), ['Befördern', 'Verwerfen']);

    const off = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ state: dashboardState({ controls: { retry: false } }), vitals: vitals({ obsidian_url: 'https://b.lan' }) }) });
    await until(() => off.query('#brain-candidates .br-cand').length === 2);
    assert.equal(off.query('#brain-candidates button').length, 0);
    assert.equal(off.query('#brain-candidates a').filter((a) => text(a).includes('Obsidian')).length, 0);
    assert.equal(off.$('brain-controls-off').hidden, false);
    assert.ok(text(off.$('brain-controls-off')).includes(CONTROLS_OFF));
  });

  it('after "Befördern" the card shows "Befördert · approved" and "Rückgängig", the counter counts down; undo posts revert on the new path', async () => {
    let approved = false;
    const p = renderPage(BRAIN_HTML, undefined, {
      fetch: brainFetch({
        candidates: () => ({ candidates: approved ? [cand('b')] : [cand('a'), cand('b')] }),
        post: (url: string) => {
          if (url.endsWith('/approve')) { approved = true; return { path: 'Lessons/a.md', previous_path: 'Inbox/a.md', hash: 'h', sha: 's' }; }
          approved = false;
          return { path: 'Inbox/a.md', previous_path: 'Lessons/a.md', hash: 'h', sha: 's2' };
        },
      }),
    });
    await until(() => p.query('#brain-candidates .br-cand').length === 2);
    assert.equal(text(p.$('brain-cand-count')), '2 offen von 2');
    p.click(button(p, '#brain-candidates .br-cand', 'Befördern')!);
    await until(() => p.query('#brain-candidates .is-decided').length === 1);
    assert.equal(p.fetches.find((f) => f.method === 'POST')!.url, '/api/v1/brain/candidates/Inbox%2Fa.md/approve');
    const card = p.query('#brain-candidates .is-decided')[0]!;
    assert.equal(card.dataset.path, 'Inbox/a.md');
    assert.equal(text(card.querySelectorAll('.ui-chip').at(-1)!), 'Befördert · approved');
    assert.equal(card.querySelectorAll('.ui-chip').at(-1)!.style.color, CHIP_TONES.green.text);
    const undo = card.querySelectorAll('button')[0]!;
    assert.equal(text(undo), 'Rückgängig');
    assert.ok(undo.classList.contains('ui-btn-36'));
    await until(() => text(p.$('brain-cand-count')) === '1 offen von 2');
    p.click(undo);
    await until(() => p.fetches.filter((f) => f.method === 'POST').length === 2);
    assert.equal(p.fetches.filter((f) => f.method === 'POST')[1]!.url, '/api/v1/brain/candidates/Lessons%2Fa.md/revert');
    await until(() => p.query('#brain-candidates .is-decided').length === 0 && text(p.$('brain-cand-count')) === '2 offen von 2');
  });

  it('rejects after a confirmation and shows "Verworfen · deprecated"', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ post: () => ({ path: 'Inbox/a.md', previous_path: 'Inbox/a.md', hash: 'h', sha: 's' }) }) });
    await until(() => p.query('#brain-candidates .br-cand').length === 2);
    p.click(button(p, '#brain-candidates .br-cand', 'Verwerfen')!);
    await until(() => p.query('#brain-candidates .is-decided').length === 1);
    assert.equal(p.confirms.length, 1);
    assert.equal(p.fetches.find((f) => f.method === 'POST')!.url, '/api/v1/brain/candidates/Inbox%2Fa.md/reject');
    const card = p.query('#brain-candidates .is-decided')[0]!;
    assert.ok(text(card).includes('Verworfen · deprecated'));
    assert.equal(card.querySelectorAll('.ui-chip').at(-1)!.style.color, CHIP_TONES.red.text);
    p.click(card.querySelectorAll('button')[0]!);
    await until(() => p.fetches.filter((f) => f.method === 'POST').length === 2);
    assert.equal(p.fetches.filter((f) => f.method === 'POST')[1]!.url, '/api/v1/brain/candidates/Inbox%2Fa.md/revert');
  });

  it('shows a failure at the card and keeps it open', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ post: () => ({ __status: 409, error: { code: 'not_candidate', message: 'kein Kandidat' } }) }) });
    await until(() => p.query('#brain-candidates .br-cand').length === 2);
    p.click(button(p, '#brain-candidates .br-cand', 'Befördern')!);
    await until(() => text(p.query('#brain-candidates .br-msg')[0]!) !== '');
    const msg = text(p.query('#brain-candidates .br-msg')[0]!);
    assert.ok(msg.includes('409') && msg.includes('kein Kandidat'), msg);
    assert.equal(p.query('#brain-candidates .is-decided').length, 0);

    const denied = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ post: () => ({ __status: 403, error: { code: 'forbidden', message: 'x' } }) }) });
    await until(() => denied.query('#brain-candidates .br-cand').length === 2);
    denied.click(button(denied, '#brain-candidates .br-cand', 'Befördern')!);
    await until(() => text(denied.query('#brain-candidates .br-msg')[0]!) !== '');
    assert.equal(text(denied.query('#brain-candidates .br-msg')[0]!), CONTROLS_OFF);
  });

  it('shows the empty state', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ candidates: { candidates: [] } }) });
    await until(() => text(p.$('brain-candidates')) !== '');
    assert.equal(text(p.$('brain-candidates')), 'Keine Kandidaten offen – alles gesichtet');
    assert.equal(text(p.$('brain-cand-count')), '0 offen von 0');
  });

  it('escapes note content', async () => {
    const title = '<img src=x onerror=1>';
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ candidates: { candidates: [cand('a', { title, preview: title, type: title })] } }) });
    await until(() => p.query('#brain-candidates .br-cand').length === 1);
    assert.equal(p.query('#brain-candidates img').length, 0);
    assert.ok(text(p.query('#brain-candidates .br-title')[0]!).includes(title));
  });

  it('styles the card as in the mockup', () => {
    assert.match(BRAIN_HTML, /\.br-cands \{ flex: 999 1 620px;/);
    assert.match(BRAIN_HTML, /\.br-cand \{ padding: 14px 16px;/);
    assert.match(BRAIN_HTML, /\.br-title \{ margin: 0; font: 600 15px/);
    assert.match(BRAIN_HTML, /\.br-target \{ font: 500 12px var\(--mono\); color: var\(--fg-3\);/);
    assert.match(BRAIN_HTML, /\.br-excerpt \{ margin: 0; font-size: 13px;[^}]*color: var\(--fg-chip\);/);
    assert.match(BRAIN_HTML, /\.br-intro \{[^}]*font-size: 13px; color: var\(--fg-3\);/);
    assert.match(BRAIN_HTML, /\.br-count \{ font: 500 12px var\(--mono\);/);
    assert.match(BRAIN_HTML, /\.br-type\.ui-chip \{ font-size: 11px; \}/);
  });
});

describe('Brain page structure (E7-8)', () => {
  it('lists the seven entries with colours, counts and descriptions', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch() });
    await until(() => p.query('#brain-folders .br-row').length > 0);
    assert.equal(text(p.$('folders-title')), 'Struktur');
    const rows = p.query('#brain-folders .br-row');
    assert.equal(rows.length, 7);
    const cell = (r: (typeof rows)[number], cls: string) => r.querySelectorAll('.' + cls)[0]!;
    assert.deepEqual(rows.map((r) => text(cell(r, 'br-row-path'))), ['README.md', 'Inbox/', 'Repos/<repo>/', 'Decisions/', 'Lessons/', 'Issues/<repo>/', 'Agents/<rolle>.md']);
    assert.deepEqual(rows.map((r) => text(cell(r, 'br-row-desc'))), [
      'Regeln für Menschen und Agents', 'Kandidaten, warten auf Review', 'Wissen je Repository, Einstieg index.md', 'Entscheidungen im ADR-Stil',
      'Gelerntes aus Fehlern und Reviews', 'Zusammenfassungen nach dem Merge, von Symphony', 'Gedächtnis je Rolle',
    ]);
    assert.deepEqual(rows.map((r) => text(cell(r, 'br-row-count'))), ['', '2', '2', '0', '0', '0', '0']);
    assert.deepEqual(rows.slice(1).map((r) => cell(r, 'br-row-path').style.color), ['#fbbf24', '#38bdf8', '#a78bfa', '#34d399', '#94a3b8', '#f9a8d4']);
    assert.match(BRAIN_HTML, /\.br-row \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto;[^}]*padding: 8px 0; border-top: 1px solid rgba\(255, 255, 255, \.06\); \}/);
    assert.match(BRAIN_HTML, /\.br-row-path \{ font: 500 13px var\(--mono\);/);
    assert.match(BRAIN_HTML, /\.br-row-count \{ font: 500 12\.5px var\(--mono\);/);
    assert.match(BRAIN_HTML, /\.br-row-desc \{ grid-column: 1 \/ -1; font-size: 12px; color: var\(--fg-3\); \}/);
  });
});

describe('Brain page disabled (E7-8)', () => {
  it('shows only the title block with the notice and the link to docs/brain.md', async () => {
    const gone = { __status: 404, error: { code: 'brain_disabled', message: 'x' } };
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ vitals: gone, candidates: gone, clashes: gone }) });
    await until(() => p.$('brain-off').hidden === false);
    assert.equal(text(p.query('h1')[0]!), 'Brain');
    const off = p.$('brain-off');
    assert.ok(text(off).startsWith('Das Brain ist nicht aktiviert (brain.enabled)'), text(off));
    assert.equal(text(off.querySelectorAll('code')[0]!), 'brain.enabled');
    const a = off.querySelectorAll('a')[0]!;
    assert.equal(text(a), 'docs/brain.md');
    assert.match(a.getAttribute('href') ?? '', /\/docs\/brain\.md$/);
    assert.equal(p.$('brain-main').hidden, true);
    assert.equal(text(p.$('brain-sub')), 'Das gemeinsame Gedächtnis der Agents');
    assert.equal(p.query('#brain-open a').length, 0);
  });
});

describe('Brain page graph (E7-8)', () => {
  it('offers a select only with two or more repositories and loads the graph with depth 2', async () => {
    const one = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch() });
    await until(() => one.query('#brain-graph svg').length === 1);
    assert.equal(one.$('brain-graph-root').hidden, true);
    assert.equal(text(one.$('graph-title')), 'Graph · Ausschnitt acme-app');
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ vitals: vitalsTwoRepos() }) });
    await until(() => p.query('#brain-graph svg').length === 1);
    assert.equal(p.$('brain-graph-root').hidden, false);
    const options = p.query('#brain-graph-root option');
    assert.deepEqual(options.map(text), ['acme-app', 'beta']);
    assert.ok(p.fetches.some((f) => f.url === '/api/v1/brain/graph?root=Repos%2Facme-app%2Findex.md&depth=2'));
    const select = p.$('brain-graph-root');
    select.value = 'Repos/beta/index.md';
    select.dispatch('change');
    await until(() => p.fetches.some((f) => f.url === '/api/v1/brain/graph?root=Repos%2Fbeta%2Findex.md&depth=2'));
    await until(() => text(p.$('brain-graph-repo')) === 'beta');
  });

  it('draws an img with folder colours, the root at r 13 and the broken link red and dashed', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch() });
    await until(() => p.query('#brain-graph svg').length === 1);
    const svg = p.query('#brain-graph svg')[0]!;
    assert.equal(svg.getAttribute('viewBox'), '0 0 360 220');
    assert.equal(svg.getAttribute('role'), 'img');
    assert.equal(svg.getAttribute('aria-label'), 'Ausschnitt des Notiz-Graphen rund um Repos/acme-app/index');
    const circles = p.query('#brain-graph circle');
    assert.ok(circles.every((c) => c.classList.contains('node')));
    const byTitle = new Map(circles.map((c) => [text(c.querySelectorAll('title')[0]!), c]));
    assert.equal(byTitle.get('Repos/acme-app/index.md')!.getAttribute('fill'), '#38bdf8');
    assert.equal(byTitle.get('Repos/acme-app/index.md')!.getAttribute('r'), '13');
    assert.equal(byTitle.get('Inbox/a.md')!.getAttribute('fill'), '#fbbf24');
    assert.equal(byTitle.get('Lessons/b.md')!.getAttribute('fill'), '#34d399');
    const missing = byTitle.get('Lessons/fehlt.md')!;
    assert.equal(missing.getAttribute('fill'), 'none');
    assert.equal(missing.getAttribute('stroke'), '#f87171');
    for (const c of circles) assert.ok(Number(c.getAttribute('r')) >= 5 && Number(c.getAttribute('r')) <= 13);
    const broken = p.query('#brain-graph line.br-edge-broken');
    assert.equal(broken.length, 1);
    assert.equal(broken[0]!.getAttribute('stroke'), '#f87171');
    assert.equal(broken[0]!.getAttribute('stroke-width'), '1.5');
    assert.equal(broken[0]!.getAttribute('stroke-dasharray'), '3 3');
    const plain = p.query('#brain-graph line').filter((l) => !l.classList.contains('br-edge-broken'));
    assert.equal(plain.length, 2);
    for (const l of plain) assert.deepEqual([l.getAttribute('stroke'), l.getAttribute('stroke-width'), l.getAttribute('stroke-dasharray')], ['rgba(255,255,255,.18)', '1', null]);
    const labels = p.query('#brain-graph text');
    assert.equal(labels[0]!.getAttribute('font-size'), '11');
    assert.equal(text(labels[0]!), 'Acme App');
    const legend = text(p.$('brain-graph-legend'));
    for (const part of ['Repos', 'Decisions', 'Lessons', 'Inbox', 'Agents', 'Issues', 'kaputter Link']) assert.ok(legend.includes(part), part);
    assert.equal(p.query('#brain-graph-legend .br-legend-dash').length, 1);
  });

  it('colours Decisions, Agents and Issues nodes and labels the root and the four biggest neighbours', async () => {
    const root = 'Repos/acme-app/index.md';
    const near = ['Decisions/a.md', 'Agents/developer.md', 'Issues/acme-app/1.md', 'Lessons/l.md', 'Inbox/i.md', 'Repos/acme-app/x.md'];
    const nodes = [{ path: root, title: 'Acme App', status: 'approved', type: 'index', missing: false, depth: 0 }, ...near.map((n) => ({ path: n, title: n, status: 'approved', type: null, missing: false, depth: 1 }))];
    const edges = near.map((n) => ({ from: root, to: n, broken: false }));
    edges.push({ from: 'Decisions/a.md', to: 'Agents/developer.md', broken: false });
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ graph: graphBody({ nodes, edges }) }) });
    await until(() => p.query('#brain-graph svg').length === 1);
    const fill = new Map(p.query('#brain-graph circle').map((c) => [text(c.querySelectorAll('title')[0]!), c.getAttribute('fill')]));
    assert.equal(fill.get('Decisions/a.md'), '#a78bfa');
    assert.equal(fill.get('Agents/developer.md'), '#f472b6');
    assert.equal(fill.get('Issues/acme-app/1.md'), '#94a3b8');
    const labels = p.query('#brain-graph text');
    assert.equal(labels.length, 5);
    assert.deepEqual(labels.slice(1).map((l) => l.getAttribute('font-size')), ['10', '10', '10', '10']);
    const names = labels.map(text);
    assert.deepEqual(names, ['Acme App', 'Agents/developer.…', 'Decisions/a.md', 'Inbox/i.md', 'Issues/acme-app/1…'], 'the two notes with two links, then by path');
    assert.ok(!names.includes('Lessons/l.md'));
  });

  it('groups notes two links away by folder ("Inbox (40)") and draws at most 24 nodes', async () => {
    const root = 'Repos/acme-app/index.md';
    const nodes: Obj[] = [{ path: root, title: 'Acme App', status: 'approved', type: 'index', missing: false, depth: 0 }, { path: 'Lessons/b.md', title: 'B', status: 'approved', type: 'lesson', missing: false, depth: 1 }];
    const edges: Obj[] = [{ from: root, to: 'Lessons/b.md', broken: false }];
    for (let i = 0; i < 40; i++) {
      nodes.push({ path: `Inbox/n${i}.md`, title: `n${i}`, status: 'candidate', type: 'lesson', missing: false, depth: 2 });
      edges.push({ from: 'Lessons/b.md', to: `Inbox/n${i}.md`, broken: false });
    }
    const grouped = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ graph: graphBody({ nodes, edges }) }) });
    await until(() => grouped.query('#brain-graph svg').length === 1);
    assert.equal(grouped.query('#brain-graph circle').length, 3);
    assert.ok(grouped.query('#brain-graph text').map(text).includes('Inbox (40)'));
    const group = grouped.query('#brain-graph circle.br-node-group')[0]!;
    assert.equal(group.getAttribute('fill'), '#fbbf24');
    assert.equal(grouped.query('#brain-graph line').length, 2);

    const many: Obj[] = [nodes[0]!];
    const manyEdges: Obj[] = [];
    for (let i = 0; i < 40; i++) {
      many.push({ path: `Lessons/m${String(i).padStart(2, '0')}.md`, title: `m${i}`, status: 'approved', type: 'lesson', missing: false, depth: 1 });
      manyEdges.push({ from: root, to: `Lessons/m${String(i).padStart(2, '0')}.md`, broken: false });
    }
    const capped = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ graph: graphBody({ nodes: many, edges: manyEdges }) }) });
    await until(() => capped.query('#brain-graph svg').length === 1);
    assert.equal(capped.query('#brain-graph circle').length, 24);
    assert.equal(capped.query('#brain-graph line').length, 23);
    assert.ok(text(capped.$('brain-graph-text')).includes('höchstens 24 Knoten'));
  });

  it('has a text alternative with the numbers', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch() });
    await until(() => p.$('brain-graph-text').hidden === false);
    assert.equal(text(p.$('brain-graph-text')), '4 Knoten, 3 Kanten, 1 kaputte Links');
  });

  it('shows "Keine Links" without edges, without a repository or without an index note', async () => {
    const lonely = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ graph: graphBody({ nodes: graphBody().nodes.slice(0, 1), edges: [] }) }) });
    await until(() => text(lonely.$('brain-graph')) !== '');
    assert.equal(text(lonely.$('brain-graph')), 'Keine Links');
    assert.equal(lonely.query('#brain-graph svg').length, 0);
    const none = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ vitals: vitals({ folders: [] }) }) });
    await until(() => text(none.$('brain-graph')) !== '');
    assert.equal(text(none.$('brain-graph')), 'Keine Links');
    assert.ok(!none.fetches.some((f) => f.url.includes('/brain/graph')));
    const gone = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ graph: { __status: 404, error: { code: 'root_not_found', message: 'x' } } }) });
    await until(() => text(gone.$('brain-graph')) !== '');
    assert.equal(text(gone.$('brain-graph')), 'Keine Links');
  });
});

describe('Brain page write clashes (E7-8)', () => {
  it('describes a hash clash with roles, issues and times, and a window clash with the protection window', async () => {
    const window = clash('c2', { reason: 'window', roles: ['tester', 'reviewer'], issues: ['acme/app#3', 'acme/app#4'] });
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ clashes: { clashes: [clash('c1'), window] } }) });
    await until(() => p.query('#brain-clashes .br-clash').length === 2);
    const [hash, win] = p.query('#brain-clashes .br-clash');
    const t0 = hmOf('2026-10-30T10:00:00Z'), t1 = hmOf('2026-10-30T10:01:00Z');
    assert.equal(text(hash!.querySelectorAll('.br-clash-path')[0]!), 'Lessons/x.md');
    assert.equal(text(hash!.querySelectorAll('.br-clash-time')[0]!), t1);
    assert.equal(text(hash!.querySelectorAll('.br-clash-text')[0]!),
      `Architect #7 schrieb um ${t0}, Developer #9 um ${t1} mit altem Hash. Der zweite Schreibvorgang wurde abgewiesen; Developer hat die aktuelle Fassung zurückbekommen.`);
    assert.equal(text(win!.querySelectorAll('.br-clash-text')[0]!),
      `Tester #3 schrieb um ${t0}, Reviewer #4 um ${t1} innerhalb des Schutzfensters von 10 min. Der zweite Schreibvorgang wurde abgewiesen; Reviewer hat die aktuelle Fassung zurückbekommen.`);
    assert.ok(p.$('clashes').classList.contains('has-open'));
    assert.ok(p.$('clashes').classList.contains('g'));
    assert.equal(text(p.$('brain-clash-week')), 'Diese Woche: 3 Clashes, 1 gelöst · Schutzfenster 10 min');
  });

  it('leaves out the issue without one and names an unknown writer', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ clashes: { clashes: [clash('c1', { issues: undefined, roles: [null, 'developer'], at: [null, '2026-10-30T10:01:00Z'] })] } }) });
    await until(() => p.query('#brain-clashes .br-clash').length === 1);
    const t = text(p.query('#brain-clashes .br-clash-text')[0]!);
    assert.ok(t.startsWith('Unbekannte Rolle schrieb um —, Developer um '), t);
    assert.ok(!t.includes('#'), t);
  });

  it('toggles the comparison with "Fassungen vergleichen" (38 px) and marks the differences', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ clashes: { clashes: [clash('c1')] } }) });
    await until(() => p.query('#brain-clashes .br-diff').length === 1);
    const wrap = p.query('#brain-clashes .br-diff-wrap')[0]!;
    assert.equal(wrap.hidden, true);
    const compare = button(p, '#brain-clashes .br-clash', 'Fassungen vergleichen')!;
    assert.ok(compare.classList.contains('ui-btn-38'));
    assert.equal(compare.getAttribute('aria-expanded'), 'false');
    p.click(compare);
    assert.equal(wrap.hidden, false);
    assert.equal(compare.getAttribute('aria-expanded'), 'true');
    const grid = p.query('#brain-clashes .br-diff')[0]!;
    const cells = grid.querySelectorAll('.br-cell').filter((c) => !c.classList.contains('br-cell-head'));
    assert.deepEqual(cells.map(text), ['a', 'a', 'b', 'x', 'c', 'c']);
    assert.deepEqual(grid.querySelectorAll('.br-del').map(text), ['b']);
    assert.deepEqual(grid.querySelectorAll('.br-add').map(text), ['x']);
    assert.deepEqual(grid.querySelectorAll('.br-cell-head').map(text), ['Abgewiesene Fassung', 'Aktuelle Fassung']);
    p.click(compare);
    assert.equal(wrap.hidden, true);
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
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ clashes: { clashes: [clash('c1', { path: evil, roles: [evil, evil], attempted: { content: evil }, current: { content: 'x' } })] } }) });
    await until(() => p.query('#brain-clashes .br-clash').length === 1);
    assert.equal(p.query('#brain-clashes img').length, 0);
    assert.ok(p.query('#brain-clashes .br-del').map(text).includes(evil));
  });

  it('offers "Als gelöst markieren" (38 px) only with control allowed and resolves via POST', async () => {
    let resolved = false;
    const p = renderPage(BRAIN_HTML, undefined, {
      fetch: brainFetch({
        clashes: () => ({ clashes: [clash('c/1', { status: resolved ? 'resolved' : 'open' })] }),
        post: () => { resolved = true; return { id: 'c/1', status: 'resolved' }; },
      }),
    });
    await until(() => p.query('#brain-clashes .br-clash').length === 1);
    const b = button(p, '#brain-clashes .br-clash', 'Als gelöst markieren')!;
    assert.ok(b.classList.contains('ui-btn-38'));
    assert.equal(p.$('brain-clash-controls-off').hidden, true);
    p.click(b);
    await until(() => p.fetches.some((f) => f.method === 'POST'));
    assert.equal(p.fetches.find((f) => f.method === 'POST')!.url, '/api/v1/brain/clashes/c%2F1/resolve');
    await until(() => text(p.$('brain-clashes')) === 'Keine offenen Clashes');
    assert.equal(p.$('clashes').classList.contains('has-open'), false);
    assert.equal(p.$('brain-clashes-resolved').hidden, false);
    const done = p.query('#brain-clashes-resolved .br-clash')[0]!;
    assert.deepEqual(done.querySelectorAll('button').map(text), ['Fassungen vergleichen']);
    assert.ok(text(done).includes('gelöst'));

    const off = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ state: dashboardState({ controls: { retry: false } }), clashes: { clashes: [clash('c1')] } }) });
    await until(() => off.query('#brain-clashes .br-clash').length === 1);
    assert.deepEqual(off.query('#brain-clashes button').map(text), ['Fassungen vergleichen']);
    assert.equal(off.$('brain-clash-controls-off').hidden, false);
  });

  it('shows a failed resolve at the card', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ clashes: { clashes: [clash('c1')] }, post: () => ({ __status: 500, error: { code: 'boom', message: 'kaputt' } }) }) });
    await until(() => p.query('#brain-clashes .br-clash').length === 1);
    p.click(button(p, '#brain-clashes .br-clash', 'Als gelöst markieren')!);
    await until(() => text(p.query('#brain-clashes .br-msg')[0]!) !== '');
    assert.ok(text(p.query('#brain-clashes .br-msg')[0]!).includes('kaputt'));
  });

  it('says "Keine offenen Clashes" without a red border and "Schutzfenster aus" for a window of 0', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: brainFetch({ vitals: vitals({ clash_window_min: 0, clashes: { week: { total: 1, resolved: 1 } } }) }) });
    await until(() => text(p.$('brain-clashes')) !== '');
    assert.equal(text(p.$('brain-clashes')), 'Keine offenen Clashes');
    assert.equal(p.$('clashes').classList.contains('has-open'), false);
    assert.equal(p.$('brain-clashes-resolved').hidden, true);
    assert.equal(text(p.$('brain-clash-week')), 'Diese Woche: 1 Clash, 1 gelöst · Schutzfenster aus');
  });

  it('styles the panel as in the mockup', () => {
    assert.match(BRAIN_HTML, /\.br-clashes\.has-open \{ border-color: rgba\(248, 113, 113, \.35\); \}/);
    assert.match(BRAIN_HTML, /\.br-clashes \.lbl \{ color: #fca5a5; \}/);
    assert.match(BRAIN_HTML, /\.br-clash \{[^}]*border-color: rgba\(248, 113, 113, \.4\);/);
    assert.match(BRAIN_HTML, /\.br-clash-text \{ margin: 0; font-size: 12\.5px;/);
    assert.match(BRAIN_HTML, /\.br-week \{ margin: 12px 0 0; font-size: 12px; color: var\(--fg-3\); \}/);
    assert.match(BRAIN_HTML, /\.br-side \{ flex: 1 1 380px;/);
  });
});

describe('Brain page motion (E7-7b, E7-8)', () => {
  const start = BRAIN_HTML.indexOf('#brain-sub code {');
  const brainCss = BRAIN_HTML.slice(start, BRAIN_HTML.indexOf('</style>', start));

  it('animates only transform and opacity: the nodes breathe', () => {
    assert.match(brainCss, /\.node \{ animation: breathe 4s ease-in-out infinite; \}/);
    assert.match(BRAIN_HTML, /@keyframes breathe \{ 0%, 100% \{ opacity: \.75; \} 50% \{ opacity: 1; \} \}/);
    assert.equal([...brainCss.matchAll(/transition:/g)].length, 0);
    const frames = /@keyframes br-in\s*\{([\s\S]*?\})\s*\}/.exec(brainCss)?.[1] ?? '';
    assert.ok(frames !== '');
    for (const prop of frames.matchAll(/([a-z-]+)\s*:/g)) assert.ok(['opacity', 'transform'].includes(prop[1]!), prop[1]!);
  });

  it('turns animations off under prefers-reduced-motion', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?\})\s*\}/.exec(brainCss)?.[1] ?? '';
    assert.match(reduced, /\.node \{ animation: none; \}/);
    assert.match(reduced, /\.br-clash \{ animation: none; \}/);
  });
});
