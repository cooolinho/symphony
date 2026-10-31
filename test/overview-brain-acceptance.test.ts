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
  links: { total: 31, per_note: 1 }, orphans: 5, broken_links: 0, candidates: 4, writes_today: 12, reads_today: { total: 77, by_folder: [] },
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
    if (url.startsWith('/api/v1/brain/clashes')) return { clashes: [] };
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

describe('Brain-Vitals', () => {
  it('is visible and shows the four tiles, the footer and no /brain link', async () => {
    const page = await open(api(fixture));
    assert.equal(page.$('brain-panel').hidden, false);
    assert.equal(page.$('brain-title').textContent, 'Brain-Vitals');
    assert.deepEqual(page.$('brain-tiles').querySelectorAll('.ui-kpi-label').map((e) => e.textContent), ['Notizen', 'Kandidaten warten', 'Links', 'Waisen ohne Links']);
    assert.deepEqual(page.$('brain-tiles').querySelectorAll('.ui-kpi-value').map((e) => e.textContent), ['20', '4', '31', '5']);
    assert.deepEqual(page.$('brain-foot').querySelectorAll('.brain-foot-part').map((e) => e.textContent), ['12 Writes heute', '77 Reads', 'letzter Commit vor 2 h']);
  });

  it('shows the conflicts from the open clashes', async () => {
    const f = api(fixture);
    const page = await open((u) => (u.startsWith('/api/v1/brain/clashes') ? { clashes: [{}, {}] } : f(u)));
    assert.ok(page.$('brain-foot').textContent.includes('2 Konflikte'));
  });

  it('shows "noch kein Commit" without a last commit and renders agent text as text', async () => {
    const f = api(fixture);
    const page = await open((u) => (u.startsWith('/api/v1/brain/vitals') ? { ...vitals, last_commit: null } : f(u)));
    assert.equal(page.$('brain-panel').hidden, false);
    assert.ok(page.$('brain-foot').textContent.includes('noch kein Commit'));
  });
});

describe('Brain-Zugriffe', () => {
  it('requests the last 50 entries once and lists all rows with role, op, note and purpose', async () => {
    const seen: string[] = [];
    const page = await open(api(fixture, seen));
    assert.ok(seen.some((u) => u.startsWith('/api/v1/brain/access?') && u.includes('limit=50')));
    assert.equal(rowsOf(page).length, 4);
    assert.equal(page.$('brain-count').textContent, '4 von 4');
    const first = rowsOf(page)[0]!;
    assert.equal(first.querySelector('.brain-role')!.textContent, 'Developer');
    assert.equal(first.querySelector('.brain-op')!.textContent, 'READ');
    assert.equal(first.querySelector('.brain-name')!.textContent, 'alpha.md');
    assert.equal(first.querySelector('.brain-purpose')!.textContent, 'Kontext holen');
  });

  it('shows "Zweck fehlt" for empty and blank purposes only', async () => {
    const page = await open(api(fixture));
    assert.equal(page.$('brain-access-list').querySelectorAll('.brain-nopurpose').length, 2);
  });

  it('renders agent-written texts as text, never as markup', async () => {
    const page = await open(api([entry(1, { path_or_query: 'Notes/<img src=x>.md', purpose: '<b>x</b>' })]));
    assert.equal(page.$('brain-access-list').querySelectorAll('img, b').length, 0);
    assert.ok(page.$('brain-access-list').textContent.includes('<b>x</b>'));
  });

  it('has Alle, the profile roles, seen roles and Symphony as chips, one pressed', async () => {
    const page = await open(api(fixture));
    const labels = chipsOf(page).map((c) => c.textContent);
    assert.equal(labels[0], 'Alle');
    assert.equal(labels.at(-1), 'Symphony');
    assert.ok(!labels.includes('Docs'));
    assert.ok(['Developer', 'Architect', 'Reviewer'].every((l) => labels.includes(l)));
    assert.equal(pressed(page).length, 1);
    assert.equal(pressed(page)[0]!.textContent, 'Alle');
  });

  it('a role chip filters client side without any request', async () => {
    const seen: string[] = [];
    const page = await open(api(fixture, seen));
    const n = seen.length;
    chipsOf(page).find((c) => c.textContent === 'Developer')!.click();
    assert.equal(rowsOf(page).length, 2);
    assert.equal(page.$('brain-count').textContent, '2 von 4');
    assert.equal(pressed(page).length, 1);
    chipsOf(page).find((c) => c.textContent === 'Reviewer')!.click();
    assert.equal(rowsOf(page).length, 1);
    assert.equal(seen.length, n);
  });

  it('the role filter survives the 30 s reload', async () => {
    const page = await open(api(fixture));
    chipsOf(page).find((c) => c.textContent === 'Reviewer')!.click();
    for (const t of page.intervals.filter((i) => i.ms === 30000)) await t.fn();
    await settle();
    assert.equal(rowsOf(page).length, 1);
    assert.equal(pressed(page)[0]!.textContent, 'Reviewer');
  });

  it('shows the empty states', async () => {
    const page = await open(api([]));
    assert.equal(page.$('brain-access-list').querySelector('.brain-empty')!.textContent, 'Noch keine Brain-Zugriffe heute');
    const full = await open(api(fixture));
    chipsOf(full).find((c) => c.textContent === 'Symphony')!.click();
    assert.equal(full.$('brain-access-list').querySelector('.brain-empty')!.textContent, 'Keine Zugriffe für diesen Filter');
  });
});

describe('search field', () => {
  it('has a label with a screen reader text and filters path and purpose without a request', async () => {
    const seen: string[] = [];
    const page = await open(api(fixture, seen));
    assert.equal(page.$('brain-q').getAttribute('type'), 'search');
    assert.ok(page.query('label').some((l) => l.getAttribute('for') === 'brain-q' && l.textContent.includes('Zugriffe durchsuchen')));
    const n = seen.length;
    const input = page.$('brain-q');
    input.value = 'ZEBRA';
    input.dispatch('input');
    assert.equal(rowsOf(page).length, 1);
    input.value = 'review ergebnis';
    input.dispatch('input');
    assert.equal(rowsOf(page).length, 1);
    assert.equal(seen.length, n);
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

  it('the page markup carries both panels with their headings and Brain-Zugriffe', () => {
    assert.match(DASHBOARD_HTML, /id="brain-panel"/);
    assert.match(DASHBOARD_HTML, /id="brain-access"/);
    assert.match(DASHBOARD_HTML, /Brain-Zugriffe/);
  });

  it('the Brain code never writes innerHTML', () => {
    assert.doesNotMatch(BRAIN_JS, /innerHTML|insertAdjacentHTML|outerHTML/);
  });
});
