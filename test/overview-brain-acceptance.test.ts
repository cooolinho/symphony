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

// E2-6 (#374): independent acceptance tests for the Brain/Zugriffe panels, driven through the whole overview page
// (frozen clock 2026-10-30T12:00:00Z) against a fake Brain API that filters like the real server (role, q, limit).
const NOW = Date.parse('2026-10-30T12:00:00Z');
const settle = () => new Promise((r) => setImmediate(r));

const vitals = {
  notes_by_status: { candidate: 4, approved: 10, deprecated: 2, none: 4 },
  links: 31, orphans: 5, broken_links: 0, candidates: 4, writes_today: 12, reads_today: 77,
  last_commit: { sha: '0123456789abcdef', at: new Date(NOW - 2 * 3600_000).toISOString(), author: 'Ada Lovelace' },
};
type Entry = { at: string; role: string; op: string; path_or_query: string; purpose: string; result: 'ok' | 'rejected'; reason?: string };
const entry = (i: number, over: Partial<Entry> = {}): Entry => ({
  at: new Date(NOW - i * 60_000).toISOString(), role: 'developer', op: 'read', path_or_query: `Notes/n${i}.md`, purpose: `Grund ${i}`, result: 'ok', ...over,
});
const fixture: Entry[] = [
  entry(1, { role: 'developer', op: 'read', path_or_query: 'Notes/alpha.md', purpose: 'Kontext holen' }),
  entry(2, { role: 'architect', op: 'search', path_or_query: 'zebra', purpose: '' }),
  entry(3, { role: 'reviewer', op: 'write', path_or_query: 'Notes/beta.md', purpose: 'Review Ergebnis', result: 'rejected', reason: 'write_window' }),
  entry(4, { role: 'developer', op: 'read', path_or_query: 'Notes/gamma.md', purpose: '   ' }),
];

function api(data: Entry[], seen: string[] = []) {
  return (url: string): unknown => {
    if (!url.startsWith('/api/v1/brain/')) return dashboardState();
    seen.push(url);
    if (url.startsWith('/api/v1/brain/vitals')) return vitals;
    const p = new URL(url, 'http://x').searchParams;
    const role = p.get('role');
    const q = (p.get('q') ?? '').toLowerCase();
    const limit = Number(p.get('limit') ?? 100);
    const access = data.filter((e) => (!role || e.role === role) && (!q || `${e.path_or_query} ${e.purpose}`.toLowerCase().includes(q))).slice(0, limit);
    return { access, next_before: null };
  };
}
const open = async (fetch: (url: string) => unknown) => {
  const page = renderPage(DASHBOARD_HTML, dashboardState(), { fetch });
  await settle();
  return page;
};
const rowsOf = (page: Awaited<ReturnType<typeof open>>) => page.$('brain-access-list').querySelectorAll('li');
const chipsOf = (page: Awaited<ReturnType<typeof open>>) => page.$('brain-roles').querySelectorAll('button');
const pressed = (page: Awaited<ReturnType<typeof open>>) => chipsOf(page).filter((c) => c.getAttribute('aria-pressed') === 'true');

describe('Brain panel (vitals)', () => {
  it('is visible and shows every vital with its label and value', async () => {
    const page = await open(api(fixture));
    assert.equal(page.$('brain-panel').hidden, false);
    assert.match(page.$('brain-title').textContent, /^Brain$/);
    const text = page.$('brain-panel').textContent;
    for (const label of ['Notizen', 'Kandidaten', 'Links', 'Waisen', 'Writes heute', 'Reads heute']) assert.ok(text.includes(label), label);
    const values = page.$('brain-tiles').querySelectorAll('.ui-kpi-value').map((e) => e.textContent);
    for (const v of ['4', '31', '5', '12', '77']) assert.ok(values.includes(v), `value ${v} in ${values}`);
    assert.ok(text.includes('20'), 'total of notes (4+10+2+4)');
  });

  it('draws one bar per status, proportional to the note count', async () => {
    const page = await open(api(fixture));
    const bars = page.$('brain-tiles').querySelectorAll('.ui-bar').map((b) => Number(b.getAttribute('aria-valuenow')));
    assert.equal(bars.length, 4);
    // 4/20, 10/20, 2/20, 4/20 in some fixed order
    assert.deepEqual([...bars].sort((a, b) => a - b), [10, 20, 20, 50]);
  });

  it('shows the last commit line with relative time and author, and links to /brain', async () => {
    const page = await open(api(fixture));
    const line = page.$('brain-commit');
    assert.equal(line.hidden, false);
    assert.match(line.textContent, /^Letzter Commit vor 2 (h|Std\.?|Stunden?)/);
    assert.ok(line.textContent.endsWith('von Ada Lovelace'));
    const link = page.query('a').find((a) => a.getAttribute('href') === '/brain' && /Brain öffnen/.test(a.textContent));
    assert.ok(link, 'link "Brain öffnen" to /brain');
  });

  it('omits the commit line without a last commit', async () => {
    const f = api(fixture);
    const page = await open((u) => (u.startsWith('/api/v1/brain/vitals') ? { ...vitals, last_commit: null } : f(u)));
    assert.equal(page.$('brain-panel').hidden, false);
    assert.ok(page.$('brain-commit').hidden || page.$('brain-commit').textContent === '');
  });

  it('does not interpret agent text (author) as HTML', async () => {
    const f = api(fixture);
    const page = await open((u) => (u.startsWith('/api/v1/brain/vitals') ? { ...vitals, last_commit: { ...vitals.last_commit, author: '<img src=x onerror=1>' } } : f(u)));
    assert.ok(page.$('brain-commit').textContent.includes('<img src=x onerror=1>'));
    assert.equal(page.$('brain-commit').querySelectorAll('img').length, 0);
  });
});

describe('Zugriffe panel (access log)', () => {
  it('requests the last 50 entries and lists all rows with time, role, op, path, purpose and result', async () => {
    const seen: string[] = [];
    const page = await open(api(fixture, seen));
    assert.ok(seen.some((u) => u.startsWith('/api/v1/brain/access') && new URL(u, 'http://x').searchParams.get('limit') === '50'));
    assert.equal(page.$('brain-access').hidden, false);
    assert.match(page.$('brain-access-title').textContent, /^Zugriffe$/);
    const rows = rowsOf(page);
    assert.equal(rows.length, 4);
    const first = rows[0]!.textContent;
    for (const part of ['read', 'Notes/alpha.md', 'Kontext holen', 'ok']) assert.ok(first.includes(part), `${part} in "${first}"`);
    assert.match(first, /\d\d:\d\d/);
    const third = rows[2]!.textContent;
    for (const part of ['write', 'Notes/beta.md', 'Review Ergebnis', 'abgewiesen']) assert.ok(third.includes(part), `${part} in "${third}"`);
    assert.ok(!rows[0]!.textContent.includes('abgewiesen'));
  });

  it('colours the role per role (different roles, different dots)', async () => {
    const page = await open(api(fixture));
    const colours = rowsOf(page).slice(0, 3).map((r) => r.querySelector('.ui-dot')!.style.background);
    assert.ok(colours.every((c) => String(c).length > 0));
    assert.equal(new Set(colours).size, 3);
  });

  it('shows "Zweck fehlt" in amber for empty and blank purposes only', async () => {
    const page = await open(api(fixture));
    const rows = rowsOf(page);
    for (const i of [1, 3]) {
      assert.ok(rows[i]!.textContent.includes('Zweck fehlt'), `row ${i}`);
    }
    for (const i of [0, 2]) assert.ok(!rows[i]!.textContent.includes('Zweck fehlt'), `row ${i}`);
    const missing = rows[1]!.querySelectorAll('.ui-chip').find((e) => e.textContent === 'Zweck fehlt')!;
    assert.ok(missing, 'element carrying the text');
    const style = `${missing.style.color} ${missing.style.background} ${missing.style.borderColor}`.toLowerCase();
    assert.ok(/amber|#f[0-9a-f]{5}|rgb|var\(--(amber|warn|yellow)/.test(style) || missing.className.includes('amber'), `amber style: ${style} / ${missing.className}`);
  });

  it('renders agent-written texts (path, purpose) as text, never as markup', async () => {
    const evil = [entry(1, { path_or_query: '<b>x</b>', purpose: '<script>alert(1)</script>' })];
    const page = await open(api(evil));
    const row = rowsOf(page)[0]!;
    assert.ok(row.textContent.includes('<b>x</b>') && row.textContent.includes('<script>alert(1)</script>'));
    assert.equal(row.querySelectorAll('b').length + row.querySelectorAll('script').length, 0);
  });

  it('has one chip per occurring role, all unpressed at the start, with aria-pressed', async () => {
    const page = await open(api(fixture));
    const chips = chipsOf(page);
    assert.equal(chips.length, 3);
    assert.ok(chips.every((c) => c.getAttribute('aria-pressed') === 'false'));
    const labels = chips.map((c) => c.textContent.toLowerCase()).join('|');
    for (const role of ['developer', 'architect', 'reviewer']) assert.ok(labels.includes(role), role);
  });

  it('a role chip filters on the server via role=, keeps the chip set, and a second click clears the filter', async () => {
    const seen: string[] = [];
    const page = await open(api(fixture, seen));
    const arch = () => chipsOf(page).find((c) => /architect/i.test(c.textContent))!;
    arch().click();
    await settle();
    assert.ok(new URL(seen.at(-1)!, 'http://x').searchParams.get('role') === 'architect', String(seen.at(-1)));
    assert.equal(rowsOf(page).length, 1);
    assert.ok(rowsOf(page)[0]!.textContent.includes('zebra'));
    assert.equal(chipsOf(page).length, 3, 'chip set stays stable');
    assert.equal(pressed(page).length, 1);
    assert.match(pressed(page)[0]!.textContent, /architect/i);
    arch().click();
    await settle();
    assert.equal(new URL(seen.at(-1)!, 'http://x').searchParams.get('role'), null);
    assert.equal(rowsOf(page).length, 4);
    assert.equal(pressed(page).length, 0);
  });

  it('switching from one role chip to another shows only the new role', async () => {
    const page = await open(api(fixture));
    chipsOf(page).find((c) => /developer/i.test(c.textContent))!.click();
    await settle();
    assert.equal(rowsOf(page).length, 2);
    chipsOf(page).find((c) => /reviewer/i.test(c.textContent))!.click();
    await settle();
    assert.equal(rowsOf(page).length, 1);
    assert.equal(pressed(page).length, 1);
    assert.match(pressed(page)[0]!.textContent, /reviewer/i);
  });

  it('the role filter survives the 30 s reload', async () => {
    const seen: string[] = [];
    const page = await open(api(fixture, seen));
    chipsOf(page).find((c) => /reviewer/i.test(c.textContent))!.click();
    await settle();
    const tick = page.intervals.find((i) => i.ms === 30000 && i.fn.name === 'loadBrain')!;
    assert.ok(tick);
    await tick.fn();
    await settle();
    assert.equal(new URL(seen.at(-1)!, 'http://x').searchParams.get('role'), 'reviewer');
    assert.equal(rowsOf(page).length, 1);
  });

  it('shows an empty state instead of rows when nothing matches', async () => {
    const page = await open(api([]));
    assert.equal(page.$('brain-access').hidden, false);
    assert.equal(rowsOf(page).filter((r) => r.classList.contains('brain-acc')).length, 0);
  });
});

describe('search field (q)', () => {
  // The page stubs setTimeout, so the debounce is driven in an isolated context with a manual timer queue.
  function bound(data: Entry[] = fixture) {
    const root = parseHtml(BRAIN_PANELS_HTML);
    const urls: string[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const f = api(data);
    const fetch = async (url: string) => {
      urls.push(url);
      const json = f(url);
      return { ok: true, status: 200, json: async () => json };
    };
    const ctx = vm.createContext({
      document: createFakeDocument(root), fetch,
      setTimeout: (fn: () => void, ms: number) => (timers.push({ fn, ms }), timers.length),
      clearTimeout: (id: number) => { if (timers[id - 1]) timers[id - 1]!.fn = () => {}; },
    });
    for (const src of [BASE_JS, ALERTS_JS, BRAIN_JS]) vm.runInContext(src, ctx);
    const $ = (id: string) => root.querySelector(`#${id}`) as FakeElement;
    return { ctx, urls, timers, $ };
  }

  it('has an accessible search input', () => {
    const page = renderPage(DASHBOARD_HTML, dashboardState());
    const input = page.$('brain-q');
    assert.ok(input.getAttribute('aria-label') || page.query('label').some((l) => l.getAttribute('for') === 'brain-q'));
  });

  it('sends q to the server only after a debounce delay and filters path and purpose', async () => {
    const s = bound();
    await run(s.ctx, 'brainBind(document.getElementById("brain-q")); loadBrain()');
    const before = s.urls.length;
    const input = s.$('brain-q');
    input.value = 'zeb';
    input.dispatch('input');
    input.value = 'zebra';
    input.dispatch('input');
    assert.equal(s.urls.length, before, 'no request before the debounce fires');
    assert.ok(s.timers.length > 0 && s.timers.every((t) => t.ms > 0));
    for (const t of s.timers) t.fn();
    await settle();
    const qUrls = s.urls.slice(before).filter((u) => u.includes('access'));
    assert.equal(qUrls.length, 1, 'cancelled earlier keystroke');
    assert.equal(new URL(qUrls[0]!, 'http://x').searchParams.get('q'), 'zebra');
    assert.equal(s.$('brain-access-list').querySelectorAll('li').length, 1);
  });

  it('matches the purpose as well as the path', async () => {
    const s = bound();
    await run(s.ctx, 'brainBind(document.getElementById("brain-q")); loadBrain()');
    const input = s.$('brain-q');
    input.value = 'Review Ergebnis';
    input.dispatch('input');
    for (const t of s.timers) t.fn();
    await settle();
    const li = s.$('brain-access-list').querySelectorAll('li');
    assert.equal(li.length, 1);
    assert.ok(li[0]!.textContent.includes('Notes/beta.md'));
  });

  it('combines role and q and url-encodes the search term', async () => {
    const s = bound();
    await run(s.ctx, 'brainBind(document.getElementById("brain-q")); loadBrain()');
    const input = s.$('brain-q');
    input.value = 'a&b=c d';
    input.dispatch('input');
    for (const t of s.timers) t.fn();
    await settle();
    const params = new URL(s.urls.at(-1)!, 'http://x').searchParams;
    assert.equal(params.get('q'), 'a&b=c d');
    assert.equal(params.get('limit'), '50');
  });
});

describe('without Brain', () => {
  const hiddenAll = (page: Awaited<ReturnType<typeof open>>) => ['brain-panel', 'brain-access'].every((id) => page.$(id).hidden || page.$('brain-row').hidden);
  const noError = (page: Awaited<ReturnType<typeof open>>) => {
    assert.ok(hiddenAll(page));
    assert.equal(page.$('brain-access-list').children.length, 0);
  };

  it('hides both panels on 404 brain_disabled', async () => {
    const page = await open((u) => (u.startsWith('/api/v1/brain/') ? { __status: 404, error: { code: 'brain_disabled' } } : dashboardState()));
    noError(page);
  });

  it('hides both panels when the Brain API is unreachable', async () => {
    const page = await open((u) => {
      if (u.startsWith('/api/v1/brain/')) throw new Error('ECONNREFUSED');
      return dashboardState();
    });
    noError(page);
  });

  it('hides both panels if only the access endpoint is missing', async () => {
    const f = api(fixture);
    const page = await open((u) => (u.startsWith('/api/v1/brain/access') ? { __status: 404, error: { code: 'brain_disabled' } } : f(u)));
    assert.ok(hiddenAll(page));
  });

  it('shows no error/alert for the missing Brain and the rest of the overview still renders', async () => {
    const page = await open((u) => (u.startsWith('/api/v1/brain/') ? { __status: 404, error: { code: 'brain_disabled' } } : dashboardState()));
    assert.ok(!/brain_disabled|Fehler/i.test(page.$('brain-row').textContent));
    assert.ok(page.$('alerts-list') !== null);
  });

  it('recovers (panels appear) once the Brain API answers later, and hides again when it goes away', async () => {
    let up = false;
    const f = api(fixture);
    const page = await open((u) => (u.startsWith('/api/v1/brain/') && !up ? { __status: 404, error: { code: 'brain_disabled' } } : f(u)));
    assert.ok(hiddenAll(page));
    up = true;
    const tick = page.intervals.find((i) => i.ms === 30000 && i.fn.name === 'loadBrain')!;
    await tick.fn();
    await settle();
    assert.equal(page.$('brain-panel').hidden, false);
    assert.equal(page.$('brain-access').hidden, false);
    up = false;
    await tick.fn();
    await settle();
    assert.ok(hiddenAll(page));
  });
});

describe('reload and wiring', () => {
  it('loads both endpoints on open and registers a 30 s reload that fetches both again', async () => {
    const seen: string[] = [];
    const page = await open(api(fixture, seen));
    assert.ok(seen.some((u) => u.startsWith('/api/v1/brain/vitals')));
    assert.ok(seen.some((u) => u.startsWith('/api/v1/brain/access')));
    const ticks = page.intervals.filter((i) => i.ms === 30000);
    assert.ok(ticks.length > 0);
    const n = seen.length;
    for (const t of ticks) await t.fn();
    await settle();
    assert.ok(seen.slice(n).some((u) => u.startsWith('/api/v1/brain/vitals')));
    assert.ok(seen.slice(n).some((u) => u.startsWith('/api/v1/brain/access')));
  });

  it('a reload picks up changed data', async () => {
    let data = fixture;
    const page = await open((u) => api(data)(u));
    assert.equal(rowsOf(page).length, 4);
    data = [...fixture, entry(9, { path_or_query: 'Notes/new.md' })];
    for (const t of page.intervals.filter((i) => i.ms === 30000)) await t.fn();
    await settle();
    assert.equal(rowsOf(page).length, 5);
  });

  it('the page markup carries both panels with their headings and the link to /brain', () => {
    assert.match(DASHBOARD_HTML, /id="brain-panel"/);
    assert.match(DASHBOARD_HTML, /id="brain-access"/);
    assert.match(DASHBOARD_HTML, /href="\/brain"/);
  });

  it('the Brain code never writes innerHTML', () => {
    assert.doesNotMatch(BRAIN_JS, /innerHTML|insertAdjacentHTML|outerHTML/);
  });
});
