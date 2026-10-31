import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHART_CSS, CHART_JS } from '../src/http/charts.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { renderPage, until } from './helpers.ts';
import { analyticsFixture, entriesFixture } from './helpers/page-fixtures.ts';

// E9-1 (#365), independent acceptance tests derived from the issue: panels, token colours, no duplicated CSS,
// filters in the URL, German texts.
const fetcher = (url: string) => (url.startsWith('/api/v1/history/entries') ? entriesFixture() : analyticsFixture());
const open = async (url = 'http://127.0.0.1/stats') => {
  const page = renderPage(LOGS_HTML, undefined, { url, fetch: fetcher });
  await until(() => page.$('log-count').textContent === '1' && page.query('[data-body="kpi"] .ui-kpi').length > 0, 3000, 'the page to load');
  return page;
};
const COLOR = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i;
const styles = (html: string) => [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]!);

describe('stats page acceptance: panels, tiles, chips', () => {
  it('every section heading of the page is a glass panel title with a German name', async () => {
    const page = await open();
    const titles = page.query('.ui-card-title').map((t) => t.textContent.replace(/\s+\d+$/, ''));
    for (const t of ['Kennzahlen', 'Aktivität', 'Geschätzte Kosten', 'Tokens', 'Modelle', 'Effort', 'Rollen', 'Tools', 'Repositories', 'Run-Ergebnisse', 'Top-Runs', 'Auffälligkeiten', 'Issues', 'Log']) {
      assert.ok(titles.includes(t), `panel "${t}" in ${JSON.stringify(titles)}`);
    }
    for (const section of page.query('[data-section]')) assert.ok(section.classList.contains('g'), 'section is .g');
    for (const section of page.query('main section')) assert.ok(section.classList.contains('g') || section.id === 'problems', `no plain <section> left: ${section.id}`);
  });

  it('shows the key figures as tiles with the known figures', async () => {
    const page = await open();
    const labels = page.query('[data-body="kpi"] .ui-kpi').map((k) => k.textContent);
    for (const l of ['Runs', 'Tokens', 'Erfolgreich', 'Fehlgeschlagen']) assert.ok(labels.some((t) => t.includes(l)), l);
    assert.equal(page.query('table.stat, .stat, .stats').length, 0);
  });

  it('nests no glass panel in a glass panel (blur boundary)', async () => {
    const page = await open();
    for (const g of page.query('.g')) {
      let p = g.parentElement as any;
      while (p) { assert.ok(!p.classList?.contains('g'), 'nested .g'); p = p.parentElement; }
    }
  });

  it('keeps the section and element hooks the other tests rely on', async () => {
    const page = await open();
    for (const id of ['period', 'from', 'to', 'apply', 'repo', 'model', 'effort', 'reload', 'period-label', 'activity-metric', 'cost-mode', 'model-sort', 'repo-sort', 'issue-sort', 'logs']) {
      assert.ok(page.$(id), `#${id}`);
    }
    for (const body of ['kpi', 'roles', 'outcomes']) assert.ok(page.query(`[data-body="${body}"]`).length === 1, body);
  });
});

describe('stats page acceptance: token colours, no duplicated CSS', () => {
  it('charts.ts has no own :root, no literal colours', () => {
    assert.doesNotMatch(CHART_CSS, /:root/);
    assert.doesNotMatch(CHART_CSS, COLOR);
    assert.doesNotMatch(CHART_JS, /#[0-9a-f]{6}\b|rgba?\(/i);
  });

  it('the page-own CSS does not repeat token or component rules', () => {
    const all = styles(LOGS_HTML).join('\n');
    const css = all.slice(all.indexOf('.filterbar {'));
    assert.ok(css.length > 0);
    assert.doesNotMatch(css, COLOR);
    assert.doesNotMatch(css, /--[a-z-]+\s*:/, 'no custom property definitions');
    assert.doesNotMatch(css, /(^|[\s,}])(\.seg|\.stat|\.stats|\.kv|\.chip|\.badge|\.panel)\b/m);
  });

  it('role bars use the role colour token, outcome bars the status tokens', async () => {
    const dev = { ...analyticsFixture().by_role[0], role: 'developer' };
    const page = renderPage(LOGS_HTML, undefined, { url: 'http://127.0.0.1/stats', fetch: (u: string) => (u.startsWith('/api/v1/history/entries') ? entriesFixture() : analyticsFixture({ by_role: [dev] })) });
    await until(() => page.query('[data-body="roles"] .hbar .fill').length > 0, 3000, 'roles');
    assert.match(page.query('[data-body="roles"] .hbar .fill')[0]!.style.getPropertyValue('--sw'), /var\(--role-developer\)/);
    await until(() => page.query('[data-body="outcomes"] span').length > 0, 3000, 'outcomes');
    const used = page.query('[data-body="outcomes"] [style]').map((e) => e.getAttribute('style') ?? '').join(' ');
    assert.doesNotMatch(used, COLOR);
  });
});

describe('stats page acceptance: filters and URL', () => {
  it('every filter value from the URL is active at load and sent to the API', async () => {
    const page = await open('http://127.0.0.1/stats?period=14d&repo=acme%2Fapp&model=claude-opus-5-5&effort=unknown');
    assert.equal(page.$('period').value, '14d');
    assert.equal(page.$('repo').value, 'acme/app');
    assert.equal(page.$('model').value, 'claude-opus-5-5');
    assert.equal(page.$('effort').value, 'unknown');
    const url = page.fetches.map((f) => f.url).find((u) => u.startsWith('/api/v1/history/analytics'))!;
    for (const p of ['repo=acme%2Fapp', 'model=claude-opus-5-5', 'effort=unknown']) assert.ok(url.includes(p), p);
  });

  it('applying a changed filter puts it into the URL and reloads the statistics', async () => {
    const page = await open('http://127.0.0.1/stats?period=7d');
    const before = page.fetches.filter((f) => f.url.startsWith('/api/v1/history/analytics')).length;
    page.$('repo').value = 'acme/app';
    page.$('repo').dispatch('change');
    await until(() => page.fetches.filter((f) => f.url.startsWith('/api/v1/history/analytics')).length > before, 3000, 'a reload');
    const reload = page.fetches.filter((f) => f.url.startsWith('/api/v1/history/analytics')).at(-1)!.url;
    assert.ok(reload.includes('repo=acme%2Fapp'));
    page.$('period').value = '90d';
    page.$('period').dispatch('change');
    await until(() => page.fetches.filter((f) => f.url.startsWith('/api/v1/history/analytics')).length > before + 1, 3000, 'a second reload');
    assert.ok(page.fetches.filter((f) => f.url.startsWith('/api/v1/history/analytics')).at(-1)!.url.includes('repo=acme%2Fapp'), 'repo stays when the period changes');
  });

  it('a custom range keeps from and to in the URL and the inputs', async () => {
    const page = await open('http://127.0.0.1/stats?period=custom&from=2026-09-01&to=2026-09-30');
    assert.equal(page.$('from').value, '2026-09-01');
    assert.equal(page.$('to').value, '2026-09-30');
    const url = page.fetches.map((f) => f.url).find((u) => u.startsWith('/api/v1/history/analytics'))!;
    assert.ok(url.includes('from=') && url.includes('to='));
  });
});

describe('stats page acceptance: German texts', () => {
  it('title, period options and labels are German', async () => {
    const page = await open();
    assert.match(LOGS_HTML, /<title>Statistik · Symphony<\/title>/);
    const opts = page.$('period').children.map((o) => o.textContent);
    for (const o of ['Heute', 'Gestern', 'Letzte 30 Tage', 'Gesamter Zeitraum']) assert.ok(opts.includes(o), o);
    const text = page.root.textContent;
    for (const en of ['Last 30 days', 'Overview', 'Needs attention', 'Apply', 'Reload', 'Most expensive']) assert.ok(!text.includes(en), `English "${en}" left`);
  });
});
