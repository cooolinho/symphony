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

// E2-6 (#374), E2-9 (#384): Brain panels on the overview.
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
  { at: '2026-10-31T11:03:00Z', role: null, op: 'list', path_or_query: 'x.md', purpose: 'Sync', result: 'ok' },
];

type Answer = { ok: boolean; status: number; body?: unknown } | Error;
function setup(answer?: (url: string) => Answer | Promise<Answer>, data: { vitals: unknown; access: unknown[]; clashes?: unknown } = { vitals, access }) {
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
    if (url.startsWith('/api/v1/brain/clashes')) return { ok: true, status: 200, json: async () => data.clashes ?? { clashes: [] } };
    return { ok: true, status: 200, json: async () => ({ access: data.access, next_before: null }) };
  };
  const ctx = vm.createContext({ document: createFakeDocument(root), fetch, setTimeout: (fn: () => void) => (fn(), 1), clearTimeout: () => {} });
  for (const src of [BASE_JS, ALERTS_JS, BRAIN_JS]) vm.runInContext(src, ctx);
  run(ctx, `Date.now = () => ${NOW}`);
  const $ = (id: string) => root.querySelector(`#${id}`) as FakeElement;
  return { ctx, urls, $, root };
}
type S = ReturnType<typeof setup>;
const rows = (s: S) => s.$('brain-access-list').querySelectorAll('li.row');
const chips = (s: S) => s.$('brain-roles').querySelectorAll('button.ui-fchip');
const chip = (s: S, text: string) => chips(s).find((c) => c.textContent.includes(text))!;
const withRows = (list: unknown[]) => setup(undefined, { vitals, access: list });
const dayText = (d: number) => new Date(d).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });

describe('Brain-Vitals', () => {
  it('shows four tiles with de-DE numbers and the colours of the mockup', async () => {
    const s = setup(undefined, { vitals: { ...vitals, notes_by_status: { approved: 1000, candidate: 284, deprecated: 0, none: 0 }, links: 1284 }, access });
    await run(s.ctx, 'loadBrain()');
    const tiles = s.$('brain-tiles');
    assert.deepEqual(tiles.querySelectorAll('.ui-kpi-label').map((e) => e.textContent), ['Notizen', 'Kandidaten warten', 'Links', 'Waisen ohne Links']);
    const values = tiles.querySelectorAll('.ui-kpi-value');
    assert.deepEqual(values.map((e) => e.textContent), ['1.284', '2', '1.284', '2']);
    assert.deepEqual(values.map((e) => e.style.color || ''), ['', '#fbbf24', '#7dd3fc', '#c4b5fd']);
    assert.equal(s.$('brain-title').textContent, 'Brain-Vitals');
    assert.equal(s.$('brain-panel').hidden, false);
    assert.equal(s.$('brain-access').hidden, false);
  });

  it('shows the Obsidian button only for a valid obsidian_url', async () => {
    const s = setup(undefined, { vitals: { ...vitals, obsidian_url: 'obsidian://open?vault=b' }, access });
    await run(s.ctx, 'loadBrain()');
    const a = s.$('brain-obsidian').querySelector('a.ui-btn.ui-btn-36')!;
    assert.equal(a.textContent, 'In Obsidian öffnen ↗');
    assert.equal(a.getAttribute('href'), 'obsidian://open?vault=b');
    for (const url of [null, 'javascript:x']) {
      const t = setup(undefined, { vitals: { ...vitals, obsidian_url: url }, access });
      await run(t.ctx, 'loadBrain()');
      assert.equal(t.$('brain-obsidian').children.length, 0);
    }
  });

  it('builds the footer and shows conflicts only when there are some', async () => {
    const parts = (s: S) => s.$('brain-foot').querySelectorAll('.brain-foot-part').map((e) => e.textContent);
    const s = setup();
    await run(s.ctx, 'loadBrain()');
    assert.deepEqual(parts(s), ['4 Writes heute', '9 Reads', 'letzter Commit vor 5 min']);
    const one = setup(undefined, { vitals, access, clashes: { clashes: [{}] } });
    await run(one.ctx, 'loadBrain()');
    assert.deepEqual(parts(one), ['4 Writes heute', '9 Reads', '1 Konflikt', 'letzter Commit vor 5 min']);
    const two = setup(undefined, { vitals, access, clashes: { clashes: [{}, {}] } });
    await run(two.ctx, 'loadBrain()');
    assert.equal(parts(two)[2], '2 Konflikte');
    const none = setup(undefined, { vitals: { ...vitals, last_commit: null }, access });
    await run(none.ctx, 'loadBrain()');
    assert.deepEqual(parts(none), ['4 Writes heute', '9 Reads', 'noch kein Commit']);
  });

  it('keeps the panels when only the clash request fails', async () => {
    const s = setup((url) => (url.includes('clashes') ? new Error('down') : { ok: true, status: 200, body: url.includes('vitals') ? vitals : url.includes('clashes') ? { clashes: [] } : { access } }));
    await run(s.ctx, 'loadBrain()');
    assert.equal(s.$('brain-panel').hidden, false);
    assert.equal(s.$('brain-foot').querySelectorAll('.brain-foot-part').length, 3);
  });
});

describe('Brain-Zugriffe', () => {
  it('orders the chips: Alle, profile roles without Docs, seen roles, Symphony; exactly one is pressed', async () => {
    const s = setup();
    run(s.ctx, `brainSetProfile({ pipeline_config: { roles: [{ name: 'developer' }, { name: 'docs' }, { name: 'reviewer' }] } })`);
    await run(s.ctx, 'loadBrain()');
    assert.deepEqual(chips(s).map((c) => c.textContent), ['Alle', 'Developer', 'Reviewer', 'Architect', 'Symphony']);
    assert.deepEqual(chips(s).map((c) => c.getAttribute('aria-pressed')), ['true', 'false', 'false', 'false', 'false']);
    assert.equal(s.$('brain-roles').querySelector('[role=group]')!.getAttribute('aria-label'), 'Nach Rolle filtern');
    assert.equal(s.$('brain-count').textContent, '4 von 4');
  });

  it('filters on the loaded rows without a request', async () => {
    const s = setup();
    await run(s.ctx, 'loadBrain()');
    const before = s.urls.length;
    chip(s, 'Developer').click();
    assert.equal(rows(s).length, 1);
    assert.equal(s.$('brain-count').textContent, '1 von 4');
    assert.deepEqual(chips(s).map((c) => c.getAttribute('aria-pressed')).filter((v) => v === 'true').length, 1);
    assert.equal(chip(s, 'Developer').getAttribute('aria-pressed'), 'true');
    chip(s, 'Developer').click();
    assert.equal(chip(s, 'Developer').getAttribute('aria-pressed'), 'true');
    chip(s, 'Symphony').click();
    assert.equal(rows(s).length, 1);
    assert.equal(rows(s)[0]!.querySelector('.brain-name')!.textContent, 'x.md');
    chip(s, 'Alle').click();
    assert.equal(rows(s).length, 4);
    assert.equal(s.urls.length, before);
    assert.ok(s.urls.every((u) => !u.includes('role=') && !u.includes('q=')));
  });

  it('searches path and purpose case-insensitively and keeps filter and search on reload', async () => {
    const s = setup();
    await run(s.ctx, 'brainBind(document.getElementById("brain-q")); loadBrain()');
    const input = s.$('brain-q');
    const before = s.urls.length;
    input.value = 'KONTEXT';
    input.dispatch('input');
    assert.equal(rows(s).length, 1);
    input.value = 'notes/a';
    input.dispatch('input');
    assert.equal(rows(s).length, 1);
    assert.equal(s.urls.length, before);
    chip(s, 'Developer').click();
    await run(s.ctx, 'loadBrain()');
    assert.equal(rows(s).length, 1);
    assert.equal(chip(s, 'Developer').getAttribute('aria-pressed'), 'true');
  });

  it('has a labelled search field', async () => {
    const s = setup();
    const input = s.$('brain-q');
    assert.equal(input.getAttribute('type'), 'search');
    assert.equal(input.getAttribute('placeholder'), 'Notiz oder Zweck suchen');
    const label = s.root.querySelector('label.brain-search')!;
    assert.equal(label.querySelector('span.sr')!.textContent, 'Zugriffe durchsuchen');
    assert.ok(label.querySelector('svg'));
  });

  it('colours the operations', async () => {
    const mk = (op: string, extra = {}) => ({ at: '2026-10-31T11:00:00Z', role: 'developer', op, path_or_query: 'a.md', purpose: 'p', result: 'ok', ...extra });
    const s = withRows([mk('read'), mk('write'), mk('append'), mk('search'), mk('list'), mk('write', { result: 'rejected' })]);
    await run(s.ctx, 'loadBrain()');
    const ops = s.$('brain-access-list').querySelectorAll('.brain-op');
    assert.deepEqual(ops.map((o) => [o.textContent, o.style.color]), [
      ['READ', '#7dd3fc'], ['WRITE', '#fbbf24'], ['APPEND', '#fbbf24'], ['SEARCH', '#c4b5fd'], ['LIST', '#94a3b8'], ['ABGEWIESEN', '#f87171'],
    ]);
  });

  it('renders three columns with role, issue, folder and purpose', async () => {
    const mk = (path: string, extra = {}) => ({ at: '2026-10-31T11:00:00Z', role: 'developer', issue: 'acme/app#331', op: 'read', path_or_query: path, purpose: 'Grund', result: 'ok', ...extra });
    const s = withRows([mk('Notes/a.md'), mk('zebra', { op: 'search' }), mk('Inbox/x.md'), mk('Issues/acme-app/12.md'), mk('Lessons/a.md', { purpose: '   ' })]);
    await run(s.ctx, 'loadBrain()');
    const r = rows(s);
    assert.equal(r[0]!.children.length, 3);
    assert.equal(r[0]!.querySelector('.brain-role')!.textContent, 'Developer #331');
    assert.ok(r[0]!.querySelector('.brain-role .ui-dot'));
    assert.equal(r[0]!.querySelector('.brain-name')!.textContent, 'a.md');
    assert.equal(r[0]!.querySelector('.brain-name')!.getAttribute('title'), 'Notes/a.md');
    assert.equal(r[0]!.querySelector('.brain-folder')!.textContent, 'Notes/');
    assert.equal(r[0]!.querySelector('.brain-purpose')!.textContent, 'Grund');
    assert.match(r[0]!.querySelector('.brain-time')!.textContent, /^\d\d:\d\d:\d\d$/);
    assert.equal(r[1]!.querySelector('.brain-name')!.textContent, '„zebra“');
    assert.equal(r[1]!.querySelector('.brain-folder')!.textContent, 'Suche');
    assert.equal(r[2]!.querySelector('.brain-folder')!.textContent, 'Inbox/ · Kandidat');
    assert.equal(r[3]!.querySelector('.brain-folder')!.textContent, 'Issues/acme-app/ · approved');
    const missing = r[4]!.querySelector('.brain-nopurpose')!;
    assert.equal(missing.textContent, 'Zweck fehlt');
    assert.equal(r[0]!.querySelector('.brain-nopurpose'), null);
  });

  it('groups by day with Heute, Gestern and a plain date', async () => {
    const mk = (ms: number) => ({ at: new Date(ms).toISOString(), role: 'developer', op: 'read', path_or_query: 'a.md', purpose: 'p', result: 'ok' });
    const s = withRows([mk(NOW - 3600e3), mk(NOW - 24 * 3600e3), mk(NOW - 72 * 3600e3)]);
    await run(s.ctx, 'loadBrain()');
    assert.deepEqual(s.$('brain-access-list').querySelectorAll('.brain-day').map((e) => e.textContent), [
      'Heute · ' + dayText(NOW), 'Gestern · ' + dayText(NOW - 24 * 3600e3), dayText(NOW - 72 * 3600e3),
    ]);
  });

  it('shows the empty states', async () => {
    const s = withRows([]);
    await run(s.ctx, 'loadBrain()');
    assert.equal(s.$('brain-access-list').querySelector('.brain-empty')!.textContent, 'Noch keine Brain-Zugriffe heute');
    assert.equal(s.$('brain-count').textContent, '0 von 0');
    const t = setup();
    await run(t.ctx, 'brainBind(document.getElementById("brain-q")); loadBrain()');
    t.$('brain-q').value = 'zzz';
    t.$('brain-q').dispatch('input');
    assert.equal(t.$('brain-access-list').querySelector('.brain-empty')!.textContent, 'Keine Zugriffe für diesen Filter');
  });

  it('keeps the result of the newer load when an older answer arrives late', async () => {
    let release: () => void = () => {};
    let n = 0;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup(async (url) => {
      if (url.startsWith('/api/v1/brain/vitals')) return { ok: true, status: 200, body: vitals };
      if (url.startsWith('/api/v1/brain/clashes')) return { ok: true, status: 200, body: { clashes: [] } };
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
      fetch: (url) => (url.startsWith('/api/v1/brain/vitals') ? vitals : url.startsWith('/api/v1/brain/access') ? { access } : url.startsWith('/api/v1/brain/clashes') ? { clashes: [] } : dashboardState()),
    });
    await settle();
    assert.equal(page.$('brain-panel').hidden, false);
    assert.equal(page.$('brain-access-list').querySelectorAll('li.row').length, 4);
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
