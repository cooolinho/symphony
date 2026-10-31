import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { renderPage, until } from './helpers.ts';
import { analyticsFixture, entriesFixture } from './helpers/page-fixtures.ts';

// E9-1 (#365): regression for the review finding "Agentenzenzeit".
const fetcher = (url: string) => (url.startsWith('/api/v1/history/entries') ? entriesFixture() : analyticsFixture());

describe('stats page: visible texts', () => {
  it('spells "Agentenzeit" correctly everywhere on the rendered page', async () => {
    const page = renderPage(LOGS_HTML, undefined, { url: 'http://127.0.0.1/stats', fetch: fetcher });
    await until(() => page.$('log-count').textContent === '1' && page.query('[data-body="kpi"] .ui-kpi').length > 0, 3000, 'the page to load');
    assert.ok(page.query('[data-body="kpi"] .ui-kpi').some((k) => k.textContent.includes('Agentenzeit')));
    assert.doesNotMatch(LOGS_HTML, /Agentenzenzeit/);
  });
});
