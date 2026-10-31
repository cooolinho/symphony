import assert from 'node:assert/strict';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { ALERTS_JS } from '../src/http/alerts.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { BRAIN_JS, BRAIN_PANELS_HTML } from '../src/http/overview-brain.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { createFakeDocument, parseHtml, run, type FakeElement } from './helpers/fake-dom.ts';
import { renderPage } from './helpers.ts';
import { dashboardState } from './helpers/page-fixtures.ts';

// E2-6 (#374): Brain panels on the overview.
const NOW = Date.parse('2026-10-31T12:00:00Z');
const vitals = {
  notes_by_status: { approved: 3, candidate: 2, deprecated: 1, none: 0 },
  links: 7, orphans: 2, broken_links: 1, candidates: 2, writes_today: 4, reads_today: 9,
  last_commit: { sha: 'abcdef1234', at: new Date(NOW - 5 * 60000).toISOString(), author: 'symphony' },
};
const access = [
  { at: '2026-10-31T11:00:00Z', role: 'developer', op: 'read', path_or_query: 'Notes/a.md', purpose: 'Kontext', result: 'ok' },
  { at: '2026-10-31T11:01:00Z', role: 'architect', op: 'search', path_or_query: 'inbox', purpose: '', result: 'ok' },
  { at: '2026-10-31T11:02:00Z', role: 'reviewer', op: 'write', path_or_query: 'Notes/b.md', purpose: 'Review', result: 'rejected', reason: 'window' },
];

type Answer = { ok: boolean; status: number; body?: unknown } | Error;
function setup(answer?: (url: string) => Answer | Promise<Answer>, data = { vitals, access }) {
  const urls: string[] = [];
  const root = parseHtml(BRAIN_PANELS_HTML);
  const fetch = async (url: string) => {
    urls.push(url);
    if (answer) {
      const a = await answer(url);
      if (a instanceof Error) throw a;
      return { ok: a.ok, status: a.status, json: async () => a.body ?? {} };
    }
    if (url.startsWith('/api/v1/brain/vitals')) return { ok: true, status: 200, json: async () => data.vitals };
    const q = new URL(url, 'http://x').searchParams;
    const role = q.get('role');
    const text = (q.get('q') ?? '').toLowerCase();
    const rows = data.access.filter((e) => (!role || e.role === role) && (!text || (e.path_or_query + ' ' + e.purpose).toLowerCase().includes(text)));
    return { ok: true, status: 200, json: async () => ({ access: rows, next_before: null }) };
  };
  const ctx = vm.createContext({ document: createFakeDocument(root), fetch, setTimeout: (fn: () => void) => (fn(), 1), clearTimeout: () => {} });
  for (const src of [BASE_JS, ALERTS_JS, BRAIN_JS]) vm.runInContext(src, ctx);
  const $ = (id: string) => root.querySelector(`#${id}`) as FakeElement;
  return { ctx, urls, $, root };
}
const rows = (s: ReturnType<typeof setup>) => s.$('brain-access-list').querySelectorAll('li.brain-acc');
const chips = (s: ReturnType<typeof setup>) => s.$('brain-roles').querySelectorAll('button.ui-fchip');

describe('Brain panel', () => {
  it('shows the tiles, status bars and the last commit', async () => {
    const s = setup();
    run(s.ctx, `Date.now = () => ${NOW}`);
    await run(s.ctx, 'loadBrain()');
    const tiles = s.$('brain-tiles');
    const labels = tiles.querySelectorAll('.ui-kpi-label').map((e) => e.textContent);
    assert.deepEqual(labels, ['Kandidaten', 'Links', 'Waisen', 'Writes heute', 'Reads heute']);
    assert.deepEqual(tiles.querySelectorAll('.ui-kpi-value').map((e) => e.textContent), ['2', '7', '2', '4', '9']);
    assert.match(tiles.querySelector('.brain-notes')!.textContent, /^6Notizen/);
    assert.deepEqual(tiles.querySelectorAll('.ui-bar').map((e) => e.getAttribute('aria-valuenow')), ['50', '33', '17', '0']);
    assert.equal(s.$('brain-commit').textContent, 'Letzter Commit vor 5 min von symphony');
    assert.equal(s.$('brain-commit').hidden, false);
    assert.equal(s.$('brain-panel').hidden, false);
    assert.equal(s.$('brain-access').hidden, false);
    assert.ok(DASHBOARD_HTML.includes('<a class="brain-open" href="/brain">Brain öffnen'));
  });

  it('omits the commit line without a last commit', async () => {
    const s = setup(undefined, { vitals: { ...vitals, last_commit: null as never }, access });
    await run(s.ctx, 'loadBrain()');
    assert.equal(s.$('brain-commit').hidden, true);
  });
});

describe('Zugriffe panel', () => {
  it('renders the rows with role colour, result chip and "Zweck fehlt"', async () => {
    const s = setup();
    await run(s.ctx, 'loadBrain()');
    assert.ok(s.urls.some((u) => u.startsWith('/api/v1/brain/access?') && u.includes('limit=50')));
    const r = rows(s);
    assert.equal(r.length, 3);
    assert.match(r[0]!.querySelector('.brain-time')!.textContent, /^\d\d:\d\d:\d\d$/);
    assert.equal(r[0]!.querySelector('.brain-op')!.textContent, 'read');
    assert.equal(r[0]!.querySelector('.brain-path')!.textContent, 'Notes/a.md');
    assert.equal(r[0]!.querySelector('.brain-purpose')!.textContent, 'Kontext');
    assert.equal(r[0]!.querySelector('.ui-chip')!.textContent, 'ok');
    assert.ok(r[0]!.querySelector('.ui-dot')!.style.background);
    const missing = r[1]!.querySelector('.brain-nopurpose')!;
    assert.equal(missing.textContent, 'Zweck fehlt');
    assert.ok(String(missing.style.color).length > 0);
    assert.equal(r[0]!.querySelector('.brain-nopurpose'), null);
    const rejected = r[2]!.querySelectorAll('.ui-chip').pop()!;
    assert.equal(rejected.textContent, 'abgewiesen');
    assert.equal(rejected.getAttribute('title'), 'window');
  });

  it('filters by role chip on the server and keeps all chips', async () => {
    const s = setup();
    await run(s.ctx, 'loadBrain()');
    assert.equal(chips(s).length, 3);
    assert.ok(chips(s).every((c) => c.getAttribute('aria-pressed') === 'false'));
    const dev = chips(s).find((c) => c.textContent.includes('Developer'))!;
    dev.click();
    await new Promise((r) => setImmediate(r));
    assert.ok(s.urls.at(-1)!.includes('role=developer'));
    assert.equal(rows(s).length, 1);
    assert.equal(chips(s).length, 3);
    assert.equal(chips(s).find((c) => c.textContent.includes('Developer'))!.getAttribute('aria-pressed'), 'true');
    chips(s).find((c) => c.textContent.includes('Developer'))!.click();
    await new Promise((r) => setImmediate(r));
    assert.ok(!s.urls.at(-1)!.includes('role='));
    assert.equal(rows(s).length, 3);
  });

  it('searches via q and keeps role and q on reload', async () => {
    const s = setup();
    await run(s.ctx, 'brainBind(document.getElementById("brain-q")); loadBrain()');
    const input = s.$('brain-q');
    input.value = 'inbox';
    input.dispatch('input');
    await new Promise((r) => setImmediate(r));
    assert.ok(s.urls.at(-1)!.includes('q=inbox'));
    assert.equal(rows(s).length, 1);
    chips(s).find((c) => c.textContent.includes('Architect'))!.click();
    await new Promise((r) => setImmediate(r));
    await run(s.ctx, 'loadBrain()');
    assert.ok(s.urls.at(-1)!.includes('role=architect') && s.urls.at(-1)!.includes('q=inbox'));
  });

  it('shows "Keine Treffer" when a filter matches nothing', async () => {
    const s = setup();
    await run(s.ctx, 'brainFilter.q = "zzz"; loadBrain()');
    assert.equal(s.$('brain-access-list').querySelector('.brain-empty')!.textContent, 'Keine Treffer');
  });

  it('keeps the result of the newer load when an older answer arrives late', async () => {
    let release: () => void = () => {};
    let n = 0;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup(async (url) => {
      if (url.startsWith('/api/v1/brain/vitals')) return { ok: true, status: 200, body: vitals };
      const mine = ++n;
      if (mine === 1) await gate;
      return { ok: true, status: 200, body: { access: mine === 1 ? access : access.slice(0, 1) } };
    });
    const first = run(s.ctx, 'loadBrain()');
    await run(s.ctx, 'loadBrain()');
    release();
    await first;
    assert.equal(rows(s).length, 1);
  });
});

describe('without Brain', () => {
  const hiddenAll = (s: ReturnType<typeof setup>) => ['brain-row', 'brain-panel', 'brain-access'].every((id) => s.$(id).hidden);
  for (const [name, answer] of [
    ['404 brain_disabled', { ok: false, status: 404, body: { error: { code: 'brain_disabled' } } }],
    ['network error', new Error('down')],
    ['invalid answer', { ok: true, status: 200, body: {} }],
  ] as const) {
    it(`hides both panels on ${name}`, async () => {
      const s = setup(() => answer);
      await run(s.ctx, 'loadBrain()');
      assert.ok(hiddenAll(s));
      assert.equal(s.$('brain-access-list').children.length, 0);
    });
  }

  it('hides a visible panel again when the next load fails', async () => {
    let up = true;
    const s = setup((url) => (up ? { ok: true, status: 200, body: url.includes('vitals') ? vitals : { access } } : new Error('down')));
    await run(s.ctx, 'loadBrain()');
    assert.equal(s.$('brain-panel').hidden, false);
    up = false;
    await run(s.ctx, 'loadBrain()');
    assert.ok(hiddenAll(s));
  });
});

describe('overview integration', () => {
  const settle = () => new Promise((r) => setImmediate(r));
  it('reloads every 30 s and shows the panels when the API answers', async () => {
    const page = renderPage(DASHBOARD_HTML, dashboardState(), {
      fetch: (url) => (url.startsWith('/api/v1/brain/vitals') ? vitals : url.startsWith('/api/v1/brain/access') ? { access } : dashboardState()),
    });
    await settle();
    assert.equal(page.$('brain-panel').hidden, false);
    assert.equal(page.$('brain-access-list').querySelectorAll('li.brain-acc').length, 3);
    const before = page.fetches.length;
    const tick = page.intervals.find((i) => i.ms === 30000 && i.fn.name === 'loadBrain');
    assert.ok(tick, 'an interval of 30 s reloads the Brain');
    await tick!.fn();
    assert.ok(page.fetches.slice(before).some((f) => f.url === '/api/v1/brain/vitals'));
    assert.ok(page.fetches.slice(before).some((f) => f.url.startsWith('/api/v1/brain/access')));
  });

  it('keeps the panels hidden when the Brain API is down', async () => {
    const page = renderPage(DASHBOARD_HTML, dashboardState(), {
      fetch: (url) => {
        if (url.includes('/brain/')) throw new Error('down');
        return dashboardState();
      },
    });
    await settle();
    assert.ok(['brain-row', 'brain-panel', 'brain-access'].every((id) => page.$(id).hidden));
  });
});
