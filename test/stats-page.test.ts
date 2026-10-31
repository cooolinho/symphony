import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHART_CSS } from '../src/http/charts.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { renderPage, until } from './helpers.ts';
import { analyticsFixture, entriesFixture } from './helpers/page-fixtures.ts';

// E9-1 (#365): the statistics page in the glass shell, rendered with fixture answers of /api/v1/history/analytics and /entries.
const developer = { ...analyticsFixture().by_role[0], role: 'developer' };
const answer = (url: string) => (url.startsWith('/api/v1/history/entries') ? entriesFixture() : analyticsFixture({ by_role: [developer] }));
const settled = (page: ReturnType<typeof renderPage>) => until(() => page.$('log-count').textContent === '1' && page.query('[data-body="kpi"] .ui-kpi').length > 0, 3000, 'the page to load');
const analyticsUrls = (page: ReturnType<typeof renderPage>) => page.fetches.map((f) => f.url).filter((u) => u.startsWith('/api/v1/history/analytics'));
const COLOR = /#[0-9a-f]{3,8}\b|rgba?\(/i;

describe('statistics page: sections', () => {
  it('uses glass panels, key figure tiles and chips, German headings and the title "Statistik"', async () => {
    const page = renderPage(LOGS_HTML, undefined, { url: 'http://127.0.0.1/stats', fetch: answer });
    await settled(page);
    assert.match(LOGS_HTML, /<title>Statistik · Symphony<\/title>/);
    const panels = [...page.query('[data-section]'), page.$('logs'), ...page.query('.filterbar')];
    assert.ok(panels.length >= 17);
    for (const panel of panels) assert.ok(panel.classList.contains('g'), `panel ${panel.id || panel.getAttribute('data-section')} is .g`);
    assert.ok(page.query('[data-body="kpi"] .ui-kpi').length >= 11);
    assert.ok(page.query('#issues-table .ui-chip').length >= 1, 'the result of an issue is a chip');
    for (const cls of ['stat', 'stats', 'kv', 'seg']) assert.equal(page.query('.' + cls).length, 0, `no .${cls} left`);
    const text = page.root.textContent;
    for (const heading of ['Kennzahlen', 'Aktivität', 'Geschätzte Kosten', 'Rollen', 'Run-Ergebnisse', 'Top-Runs', 'Auffälligkeiten', 'Issues', 'Log']) assert.ok(text.includes(heading), heading);
    assert.ok(!text.includes('Overview') && !text.includes('Needs attention'));
    assert.deepEqual(page.$('period').children.map((o) => o.textContent).slice(0, 3), ['Heute', 'Gestern', 'Letzte 7 Tage']);
  });

  it('draws roles in their role color and outcomes in the status tones', async () => {
    const page = renderPage(LOGS_HTML, undefined, { url: 'http://127.0.0.1/stats', fetch: answer });
    await settled(page);
    const fill = page.query('[data-body="roles"] .hbar .fill')[0]!;
    assert.match(fill.style.getPropertyValue('--sw'), /var\(--role-developer\)/);
    const colors = page.query('[data-body="outcomes"] .dist span').map((s) => s.style.getPropertyValue('--sw'));
    assert.ok(colors.includes('var(--st-run)'));
  });

  it('has no colour values or token duplicates in its own CSS', () => {
    assert.doesNotMatch(CHART_CSS, /:root/);
    assert.doesNotMatch(CHART_CSS, COLOR);
    const page = LOGS_HTML.slice(LOGS_HTML.indexOf('.filterbar {'));
    const css = page.slice(0, page.indexOf('</style>'));
    assert.ok(css.length > 0);
    assert.doesNotMatch(css, COLOR);
    assert.doesNotMatch(css, /\.seg\b|\.stat\b|\.kv\b|\.chip\b/);
  });

  it('shows the error state with a retry button when the statistics cannot be loaded', async () => {
    const page = renderPage(LOGS_HTML, undefined, { url: 'http://127.0.0.1/stats', fetch: (url) => { if (url.includes('analytics')) throw new Error('down'); return entriesFixture(); } });
    await until(() => page.root.textContent.includes('STATISTIK NICHT LADBAR'), 3000, 'the error');
    assert.ok(page.query('[data-body="kpi"] .ui-btn').some((b) => b.textContent === 'Erneut versuchen'));
  });
});

describe('statistics page: filters from the URL', () => {
  const url = 'http://127.0.0.1/stats?period=7d&repo=acme%2Fapp&model=claude-opus-5-5&effort=unknown';

  it('activates period, repository, model and effort and sends them to the API', async () => {
    const page = renderPage(LOGS_HTML, undefined, { url, fetch: answer });
    await settled(page);
    assert.equal(page.$('period').value, '7d');
    assert.equal(page.$('repo').value, 'acme/app');
    assert.equal(page.$('model').value, 'claude-opus-5-5');
    assert.equal(page.$('effort').value, 'unknown');
    const first = analyticsUrls(page)[0]!;
    for (const part of ['repo=acme%2Fapp', 'model=claude-opus-5-5', 'effort=unknown', 'from=', 'to=']) assert.ok(first.includes(part), part);
    assert.ok(page.fetches.some((f) => f.url.startsWith('/api/v1/history/entries') && f.url.includes('repo=acme%2Fapp')));
    assert.equal(page.query('#period-label button.ui-fchip[aria-pressed="true"]').length, 3);
  });

  it('removes a filter through its chip: gone from the URL, the others stay, the statistics reload', async () => {
    const page = renderPage(LOGS_HTML, undefined, { url, fetch: answer });
    await settled(page);
    const before = analyticsUrls(page).length;
    const repoChip = page.query('#period-label button.ui-fchip').find((b) => b.textContent.startsWith('Repository'))!;
    page.click(repoChip);
    await until(() => analyticsUrls(page).length > before, 3000, 'a reload');
    const reload = analyticsUrls(page).at(-1)!;
    assert.ok(!reload.includes('repo='));
    assert.ok(reload.includes('model=') && reload.includes('effort='));
  });

  it('takes a custom range from the URL and falls back to 30 days for an invalid period', async () => {
    const custom = renderPage(LOGS_HTML, undefined, { url: 'http://127.0.0.1/stats?period=custom&from=2026-10-01&to=2026-10-07', fetch: answer });
    await settled(custom);
    assert.equal(custom.$('period').value, 'custom');
    assert.equal(custom.$('from').value, '2026-10-01');
    assert.equal(custom.$('to').value, '2026-10-07');
    const invalid = renderPage(LOGS_HTML, undefined, { url: 'http://127.0.0.1/stats?period=xyz', fetch: answer });
    await settled(invalid);
    assert.equal(invalid.$('period').value, '30d');
  });
});

describe('statistics page: log entries', () => {
  it('lists the entries with event chips and offers the events as filter', async () => {
    const page = renderPage(LOGS_HTML, undefined, { url: 'http://127.0.0.1/stats', fetch: answer });
    await settled(page);
    assert.equal(page.$('log-count').textContent, '1');
    assert.equal(page.query('#entries tr').filter((r) => r.children.some((c) => c.tagName === 'td')).length, 1);
    assert.ok(page.query('#entries td .ui-chip').length >= 1);
    assert.ok(page.$('log-event').children.some((o) => o.value === 'run_finished'));
  });
});
