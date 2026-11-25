import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BRAIN_HTML } from '../src/http/brain-page.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { renderPage } from './helpers.ts';

// E5-1 (#619), independent acceptance tests: section "Zugriffe" on /brain. Derived from the issue, not from the code.
// The frozen clock of renderPage is 2026-10-30T12:00:00Z.

type Obj = Record<string, any>;
type Page = ReturnType<typeof renderPage>;

const vitals = {
  notes_by_status: { candidate: 0, approved: 1, deprecated: 0, none: 0 }, notes: { total: 1 }, links: { total: 1, per_note: 1 },
  orphans: 0, broken_links: 0, candidates: 0, writes_today: 1, reads_today: { total: 1, by_folder: [] },
  clashes: { week: { total: 0, resolved: 0 } }, commits: { total: 1 }, clash_window_min: 10, path: '/srv/brain', last_commit: null,
  obsidian_url: null, folders: [],
};

const acc = (over: Obj): Obj => ({ at: '2026-10-30T09:00:00Z', role: 'developer', issue: 'acme/app#12', op: 'read', path_or_query: 'Lessons/x.md', purpose: 'Kontext', result: 'ok', ...over });

interface Opts { access?: unknown | (() => unknown); vitals?: unknown; candidates?: unknown; state?: unknown }
function open(opts: Opts = {}): Page {
  const fetch = (url: string): unknown => {
    if (url.includes('/brain/vitals')) return opts.vitals ?? vitals;
    if (url.includes('/brain/candidates')) return opts.candidates ?? { candidates: [] };
    if (url.includes('/brain/clashes')) return { clashes: [] };
    if (url.includes('/brain/access')) return typeof opts.access === 'function' ? (opts.access as () => unknown)() : opts.access ?? { access: [] };
    if (url.includes('/api/v1/state')) return opts.state ?? {};
    return {};
  };
  return renderPage(BRAIN_HTML, undefined, { fetch });
}
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
async function openSettled(opts: Opts = {}): Promise<Page> { const p = open(opts); await settle(); return p; }

const rows = (p: Page) => p.query('#zugriffe-list li.row');
const chipLabels = (p: Page) => p.query('#zugriffe-roles button').map((b) => b.textContent);
const chip = (p: Page, label: string) => p.query('#zugriffe-roles button').find((b) => b.textContent === label)!;
const count = (p: Page) => p.query('#zugriffe-count')[0]!.textContent;
const search = (p: Page, q: string) => { const i = p.query('#zugriffe-q')[0]!; i.value = q; i.dispatch('input'); };
const names = (p: Page) => rows(p).map((r) => r.querySelector('.brain-name')!.textContent);
const accessRequests = (p: Page) => p.fetches.filter((f) => f.url.includes('/brain/access'));

describe('E5-1 /brain: section Zugriffe, structure', () => {
  it('has section#zugriffe with aria-labelledby pointing at a heading "Zugriffe", placed after candidates and graph', () => {
    const p = open();
    const section = p.query('#zugriffe')[0]!;
    assert.equal(section.tagName.toLowerCase(), 'section');
    const labelledby = section.getAttribute('aria-labelledby');
    assert.ok(labelledby, 'aria-labelledby set');
    assert.equal(p.$(labelledby!).textContent.trim(), 'Zugriffe');
    const at = (id: string) => BRAIN_HTML.indexOf(`id="${id}"`);
    assert.ok(at('zugriffe') > 0 && at('candidates') > 0 && at('graph') > 0);
    assert.ok(at('zugriffe') > at('candidates'), 'after the candidates');
    assert.ok(at('zugriffe') > at('graph'), 'after the graph');
  });

  it('sits inside #brain-main (hidden with the Brain off) and has chips container, search input and list', () => {
    const p = open();
    const main = p.query('#brain-main')[0]!;
    assert.ok(main.querySelector('#zugriffe'));
    assert.ok(p.query('#zugriffe #zugriffe-roles').length === 1);
    assert.ok(p.query('#zugriffe #zugriffe-q').length === 1);
    assert.ok(p.query('#zugriffe #zugriffe-list').length === 1);
  });

  it('loads exactly /api/v1/brain/access?limit=50, once per load', async () => {
    const p = await openSettled({ access: { access: [acc({})] } });
    assert.deepEqual(accessRequests(p).map((f) => f.url), ['/api/v1/brain/access?limit=50']);
    assert.equal(count(p), '1 von 1');
  });
});

describe('E5-1 /brain: list rendering', () => {
  it('renders each access with time, role and #issue, operation, note name, folder and purpose', async () => {
    const p = await openSettled({ access: { access: [acc({ role: 'architect', issue: 'cooolinho/symphony#619', op: 'write', path_or_query: 'Issues/619.md', purpose: 'Design festhalten' })] } });
    const r = rows(p)[0]!;
    assert.match(r.querySelector('.brain-time')!.textContent, /^\d\d:\d\d:\d\d$/);
    assert.match(r.querySelector('.brain-role')!.textContent, /Architect #619/);
    assert.equal(r.querySelector('.brain-op')!.textContent, 'WRITE');
    assert.equal(r.querySelector('.brain-name')!.textContent, '619.md');
    assert.ok(r.querySelector('.brain-folder')!.textContent.includes('Issues/'));
    assert.equal(r.querySelector('.brain-purpose')!.textContent, 'Design festhalten');
  });

  it('groups by day, newest day first, labelled Heute / Gestern / plain date', async () => {
    const p = await openSettled({
      access: { access: [
        acc({ at: '2026-10-30T09:00:00Z', path_or_query: 'a/heute.md' }),
        acc({ at: '2026-10-29T09:00:00Z', path_or_query: 'a/gestern.md' }),
        acc({ at: '2026-10-25T09:00:00Z', path_or_query: 'a/alt.md' }),
      ] },
    });
    const days = p.query('#zugriffe-list .brain-day').map((d) => d.textContent);
    assert.equal(days.length, 3);
    assert.ok(days[0]!.startsWith('Heute'));
    assert.ok(days[1]!.startsWith('Gestern'));
    assert.ok(!days[2]!.startsWith('Heute') && !days[2]!.startsWith('Gestern'));
    assert.deepEqual(names(p), ['heute.md', 'gestern.md', 'alt.md']);
  });

  it('shows "Zweck fehlt" for a missing or blank purpose and ABGEWIESEN for a rejected access', async () => {
    const p = await openSettled({ access: { access: [
      acc({ purpose: undefined, path_or_query: 'a/1.md' }),
      acc({ purpose: '   ', path_or_query: 'a/2.md' }),
      acc({ result: 'rejected', reason: 'window', op: 'write', path_or_query: 'a/3.md' }),
    ] } });
    assert.equal(rows(p)[0]!.querySelector('.brain-purpose')!.textContent, 'Zweck fehlt');
    assert.equal(rows(p)[1]!.querySelector('.brain-purpose')!.textContent, 'Zweck fehlt');
    assert.equal(rows(p)[2]!.querySelector('.brain-op')!.textContent, 'ABGEWIESEN');
  });

  it('renders a search access as a quoted query', async () => {
    const p = await openSettled({ access: { access: [acc({ op: 'search', path_or_query: 'caching strategie' })] } });
    const r = rows(p)[0]!;
    assert.equal(r.querySelector('.brain-op')!.textContent, 'SEARCH');
    assert.ok(r.querySelector('.brain-name')!.textContent.includes('caching strategie'));
  });

  it('renders markup in paths and purposes as text, not as elements', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const p = await openSettled({ access: { access: [acc({ path_or_query: `Lessons/${evil}.md`, purpose: `<b>${evil}</b>` })] } });
    assert.equal(p.query('#zugriffe-list img').length, 0);
    assert.equal(p.query('#zugriffe-list b').length, 0);
    assert.ok(rows(p)[0]!.querySelector('.brain-purpose')!.textContent.includes(evil));
  });

  it('renders every one of 50 rows and ignores non-object entries without crashing', async () => {
    const list: unknown[] = Array.from({ length: 50 }, (_, i) => acc({ path_or_query: `n/${i}.md`, at: `2026-10-30T10:${String(i).padStart(2, '0')}:00Z` }));
    list.splice(10, 0, null, 'x', 7);
    const p = await openSettled({ access: { access: list } });
    assert.equal(rows(p).length, 50);
    assert.equal(count(p), '50 von 50');
  });
});

describe('E5-1 /brain: filter chips and search', () => {
  const data = [
    acc({ role: 'developer', path_or_query: 'Lessons/dev-note.md', purpose: 'Alpha' }),
    acc({ role: 'reviewer', path_or_query: 'Lessons/rev-note.md', purpose: 'Beta' }),
    acc({ role: 'architect', path_or_query: 'Lessons/arch-note.md', purpose: 'Alpha zwei' }),
    acc({ role: null, issue: null, path_or_query: 'Lessons/sys-note.md', purpose: 'Gamma' }),
  ];

  it('offers Alle, one chip per role seen in the rows and Symphony; Alle is pressed first', async () => {
    const p = await openSettled({ access: { access: data } });
    const labels = chipLabels(p);
    for (const l of ['Alle', 'Developer', 'Reviewer', 'Architect', 'Symphony']) assert.ok(labels.includes(l), `chip ${l} in ${labels.join(',')}`);
    assert.equal(chip(p, 'Alle').getAttribute('aria-pressed'), 'true');
  });

  it('hides rows of other roles and adapts the counter; Alle restores everything; no extra request', async () => {
    const p = await openSettled({ access: { access: data } });
    const before = p.fetches.length;
    chip(p, 'Developer').click();
    assert.deepEqual(names(p), ['dev-note.md']);
    assert.equal(count(p), '1 von 4');
    assert.equal(chip(p, 'Developer').getAttribute('aria-pressed'), 'true');
    assert.equal(chip(p, 'Alle').getAttribute('aria-pressed'), 'false');
    chip(p, 'Alle').click();
    assert.equal(rows(p).length, 4);
    assert.equal(count(p), '4 von 4');
    assert.equal(p.fetches.length, before, 'no request while filtering');
  });

  it('the Symphony chip shows the rows without a role', async () => {
    const p = await openSettled({ access: { access: data } });
    chip(p, 'Symphony').click();
    assert.deepEqual(names(p), ['sys-note.md']);
  });

  it('search matches path and purpose, case-insensitively, trimmed, without a request', async () => {
    const p = await openSettled({ access: { access: data } });
    const before = p.fetches.length;
    search(p, '  ALPHA ');
    assert.deepEqual(names(p).sort(), ['arch-note.md', 'dev-note.md']);
    assert.equal(count(p), '2 von 4');
    search(p, 'rev-note');
    assert.deepEqual(names(p), ['rev-note.md']);
    search(p, '');
    assert.equal(rows(p).length, 4);
    assert.equal(p.fetches.length, before);
  });

  it('combines role filter and search', async () => {
    const p = await openSettled({ access: { access: data } });
    chip(p, 'Architect').click();
    search(p, 'alpha');
    assert.deepEqual(names(p), ['arch-note.md']);
    search(p, 'beta');
    assert.equal(rows(p).length, 0);
    assert.equal(count(p), '0 von 4');
    assert.ok(p.query('#zugriffe-list .brain-empty').some((e) => e.textContent === 'Keine Zugriffe für diesen Filter'));
  });

  it('shows pipeline roles from the state as chips even without rows', async () => {
    const p = await openSettled({
      access: { access: [acc({ role: 'developer' })] },
      state: { pipeline_config: { roles: [{ name: 'tester' }, { name: 'developer' }] } },
    });
    const labels = chipLabels(p);
    assert.ok(labels.includes('Tester'), `Tester chip in ${labels.join(',')}`);
    assert.equal(labels.filter((l) => l === 'Developer').length, 1, 'no duplicate chips');
  });
});

describe('E5-1 /brain: polling, empty state, Brain off, errors', () => {
  it('keeps role filter and search text across the 15 s poll and shows new rows', async () => {
    let n = 0;
    const p = await openSettled({
      access: () => ({ access: [
        acc({ role: 'reviewer', path_or_query: 'a/keep.md', purpose: 'treffer' }),
        acc({ role: 'developer', path_or_query: 'a/other.md', purpose: 'treffer' }),
        ...(++n > 1 ? [acc({ role: 'reviewer', path_or_query: 'a/new.md', purpose: 'treffer' })] : []),
      ] }),
    });
    chip(p, 'Reviewer').click();
    search(p, 'treffer');
    assert.deepEqual(names(p), ['keep.md']);
    const poll = p.intervals.find((i) => i.ms === 15000);
    assert.ok(poll, 'a 15 s poll is registered');
    await poll!.fn();
    await settle();
    assert.equal(accessRequests(p).length, 2);
    assert.deepEqual(names(p).sort(), ['keep.md', 'new.md']);
    assert.equal(chip(p, 'Reviewer').getAttribute('aria-pressed'), 'true');
    assert.equal(count(p), '2 von 3');
  });

  it('keeps the last rows when a poll fails', async () => {
    let n = 0;
    const p = await openSettled({ access: () => (++n > 1 ? { __status: 500 } : { access: [acc({ path_or_query: 'a/stay.md' })] }) });
    assert.deepEqual(names(p), ['stay.md']);
    await p.intervals.find((i) => i.ms === 15000)!.fn();
    await settle();
    assert.deepEqual(names(p), ['stay.md']);
    assert.equal(p.query('#brain-main')[0]!.hidden, false);
  });

  it('shows an empty line for no accesses, with counter 0 von 0', async () => {
    const p = await openSettled({ access: { access: [] } });
    assert.equal(rows(p).length, 0);
    assert.equal(count(p), '0 von 0');
    assert.ok(p.query('#zugriffe-list .brain-empty').length >= 1);
  });

  it('shows the empty line for today above older days when only older rows exist', async () => {
    const p = await openSettled({ access: { access: [acc({ at: '2026-10-20T09:00:00Z', path_or_query: 'a/old.md' })] } });
    assert.equal(rows(p).length, 1);
    assert.ok(p.query('#zugriffe-list .brain-empty').some((e) => /Noch keine Brain-Zugriffe heute/.test(e.textContent)));
  });

  it('leaves the other sections intact when the access request fails (HTTP 500 or 404)', async () => {
    for (const status of [500, 404]) {
      const p = await openSettled({ access: { __status: status }, candidates: { candidates: [] } });
      assert.equal(p.query('#brain-main')[0]!.hidden, false, `main visible at ${status}`);
      assert.equal(p.query('#brain-off')[0]!.hidden, true, `off hidden at ${status}`);
      assert.equal(p.query('#brain-error')[0]!.hidden, true, `no error banner at ${status}`);
      assert.equal(rows(p).length, 0);
    }
  });

  it('stays off with the Brain off (404 on vitals or candidates): #brain-off shown, section hidden with #brain-main', async () => {
    for (const o of [{ vitals: { __status: 404 } }, { candidates: { __status: 404 } }]) {
      const p = await openSettled(o);
      assert.equal(p.query('#brain-off')[0]!.hidden, false);
      assert.equal(p.query('#brain-main')[0]!.hidden, true);
      assert.equal(p.query('#brain-main #zugriffe').length, 1);
      assert.equal(rows(p).length, 0);
    }
  });
});

describe('E5-1 overview card stays unchanged', () => {
  it('still has the Brain access card with search field, role chips and list', () => {
    const p = renderPage(DASHBOARD_HTML);
    assert.ok(p.query('#brain-access').length === 1);
    assert.ok(p.query('#brain-access #brain-roles').length === 1);
    const q = p.query('#brain-access #brain-q')[0]!;
    assert.ok(q, 'search field');
    assert.equal(q.getAttribute('placeholder'), 'Notiz oder Zweck suchen');
    assert.ok(p.query('#brain-access #brain-access-list').length === 1);
    assert.ok(p.query('#brain-access #brain-count').length === 1);
  });

  it('the overview still loads 50 accesses and renders them with the shared logic', async () => {
    const list = Array.from({ length: 50 }, (_, i) => acc({ path_or_query: `n/${i}.md`, at: `2026-10-30T10:${String(i).padStart(2, '0')}:00Z` }));
    const fetch = (url: string): unknown => {
      if (url.includes('/brain/vitals')) return vitals;
      if (url.includes('/brain/access')) return { access: list, next_before: null };
      if (url.includes('/brain/clashes')) return { clashes: [] };
      return {};
    };
    const p = renderPage(DASHBOARD_HTML, undefined, { fetch });
    await settle();
    assert.ok(p.fetches.some((f) => f.url === '/api/v1/brain/access?limit=50'));
    assert.equal(p.query('#brain-access-list li.row').length, 50);
  });
});
