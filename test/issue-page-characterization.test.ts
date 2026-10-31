import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/issue-page.ts';
import { renderPage } from './helpers.ts';
import { issueDetail } from './helpers/page-fixtures.ts';

// Characterization tests for the team view (E3-5a, #372): the trace, sessions, raw logs and controls that move into
// tabs and the sidebar must keep working. Text that the issue translates to German is not pinned here.

const AGENT_URL = 'http://127.0.0.1/issue?id=acme%2Fapp%231';
const opts = { url: AGENT_URL };
const event = (seq: number, name: string, level = 'info', message = 'msg ' + seq) => ({ seq, at: '2026-10-30T11:' + String(10 + (seq % 40)).padStart(2, '0') + ':00Z', kind: 'orchestrator', event: name, level, message, detail: {} });
const session = (run: string, over: Record<string, unknown> = {}) => ({ run, attempt: null, role: 'developer', state: 'In progress', model: null, effort: null, started_at: '2026-10-30T11:00:00Z', finished_at: '2026-10-30T11:30:00Z', outcome: 'handed_off', transcript: null, ...over });

describe('team view characterization: trace (#372)', () => {
  it('keeps every element id the trace logic and the sidebar blocks use', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail() }, opts);
    for (const id of ['timeline', 'filters', 'tl-q', 'earlier', 'jump', 'tl-follow', 'tl-meta', 'tl-count', 'expand-all', 'collapse-all', 'raw-toggle', 'rawlog', 'raw-sev', 'raw-q', 'raw-list', 'raw-count', 'raw-links',
      'runs', 'runs-count', 'int-section', 'milestones', 'life-kv', 'tok-total', 'tok-sub', 'tok-kv', 'tok-chart', 'cost-total', 'cost-sub', 'cost-kv', 'issue-section', 'ctx-kv', 'results-section', 'result-cards', 'results-count']) {
      page.$(id);
    }
  });

  it('lists events in the timeline and filters them to errors', () => {
    const events = [event(1, 'worker_restarted'), event(2, 'agent_error', 'error', 'boom')];
    const page = renderPage(AGENT_HTML, { detail: issueDetail(), events, dirty: true }, opts);
    assert.equal(page.$('timeline').querySelectorAll('li.item').length, 2);
    page.click(page.$('filters').querySelectorAll('button').find((b) => b.dataset.f === 'errors')!);
    const items = page.$('timeline').querySelectorAll('li.item');
    assert.equal(items.length, 1);
    assert.match(items[0]!.textContent, /boom/);
  });

  it('offers older events beyond the render limit and loads them on click', () => {
    const events = Array.from({ length: 450 }, (_, i) => event(i + 1, 'worker_restarted'));
    const page = renderPage(AGENT_HTML, { detail: issueDetail(), events, dirty: true }, opts);
    assert.equal(page.$('timeline').querySelectorAll('li.item').length, 400);
    assert.equal(page.$('earlier').hidden, false);
    assert.match(page.$('earlier').textContent, /50/);
    page.click(page.$('earlier'));
    assert.equal(page.$('timeline').querySelectorAll('li.item').length, 450);
    assert.equal(page.$('earlier').hidden, true);
  });

  it('opens the raw logs with one line per event and filters them by severity', () => {
    const events = [event(1, 'worker_restarted'), event(2, 'agent_error', 'error', 'boom')];
    const page = renderPage(AGENT_HTML, { detail: issueDetail(), events, dirty: true }, opts);
    assert.equal(page.$('rawlog').hidden, true);
    page.click(page.$('raw-toggle'));
    assert.equal(page.$('rawlog').hidden, false);
    assert.equal(page.$('raw-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(page.$('raw-list').querySelectorAll('li').length, 2);
    page.click(page.$('raw-sev').querySelectorAll('button').find((b) => b.dataset.sev === 'error')!);
    assert.equal(page.$('raw-list').querySelectorAll('li').length, 1);
  });
});

describe('team view characterization: sessions (#372)', () => {
  it('lists the sessions newest first, with a JSONL link only where a transcript exists', () => {
    const sessions = [session('r1', { transcript: '/t/r1.jsonl' }), session('r2', { role: 'reviewer' })];
    const page = renderPage(AGENT_HTML, { detail: issueDetail({ status: 'paused', running: null, sessions }) }, opts);
    const rows = page.$('runs').children;
    assert.equal(rows.length, 2);
    assert.match(rows[0]!.textContent, /r2/);
    assert.match(rows[1]!.textContent, /r1/);
    assert.equal(rows[0]!.querySelectorAll('a').length, 0);
    const [link] = rows[1]!.querySelectorAll('a');
    assert.equal(link!.href, '/api/v1/acme%2Fapp%231/transcript?run=r1&format=raw');
    assert.equal(page.$('runs-count').textContent, '02');
  });
});

describe('team view characterization: controls (#372)', () => {
  const paused = (controls: Record<string, unknown>) =>
    issueDetail({ status: 'paused', running: null, paused: { source: 'operator', paused_at: '2026-10-30T11:50:00Z', continuations: 0 }, controls });

  it('offers Force and Resume for a paused issue when controls are allowed', () => {
    const page = renderPage(AGENT_HTML, { detail: paused({ retry: true }) }, opts);
    const verbs = page.query('#head-actions button.restart').map((b) => b.dataset.verb);
    assert.deepEqual(verbs, ['Force', 'Resume']);
    assert.equal(page.query('#alert button.restart').length, 1);
  });

  it('shows no control button anywhere when controls are not allowed', () => {
    const page = renderPage(AGENT_HTML, { detail: paused({ retry: false }) }, opts);
    assert.equal(page.query('button.restart').length, 0);
    assert.match(page.$('alert').textContent, /Controls disabled/);
    const running = renderPage(AGENT_HTML, { detail: issueDetail({ controls: { retry: false } }) }, opts);
    assert.equal(running.query('button.restart').length, 0);
  });
});
