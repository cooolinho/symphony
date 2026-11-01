import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/issue-page.ts';
import { renderPage } from './helpers.ts';
import { issueDetail } from './helpers/page-fixtures.ts';

// More characterization tests for the team view (E3-5a, #372): behaviour of the trace that must survive the move into
// the tab panels. Selectors are ids and attributes only, not text the issue translates.

const opts = { url: 'http://127.0.0.1/issue?id=acme%2Fapp%231' };
const event = (seq: number, name: string, level = 'info', message = 'msg ' + seq) => ({ seq, at: '2026-10-30T11:' + String(10 + (seq % 40)).padStart(2, '0') + ':00Z', kind: 'orchestrator', event: name, level, message, detail: {} });

describe('team view characterization: trace controls (#372)', () => {
  it('expands every long error on expand-all and folds them again on collapse-all', () => {
    const long = 'boom '.repeat(100);
    const events = [event(1, 'agent_error', 'error', long), event(2, 'agent_error', 'error', long + 'x')];
    const page = renderPage(AGENT_HTML, { detail: issueDetail(), events, dirty: true }, opts);
    const open = () => page.$('timeline').querySelectorAll('li.item button[aria-expanded="true"]').length;
    assert.equal(open(), 0);
    page.click(page.$('expand-all'));
    assert.equal(open(), 2);
    page.click(page.$('collapse-all'));
    assert.equal(open(), 0);
  });

  it('shows the jump button off the bottom and scrolls to the end on click', () => {
    const events = Array.from({ length: 30 }, (_, i) => event(i + 1, 'worker_restarted'));
    const page = renderPage(AGENT_HTML, { detail: issueDetail(), events, dirty: true }, opts);
    const list = page.$('timeline');
    list.scrollHeight = 5000;
    list.clientHeight = 400;
    list.scrollTop = 0;
    list.dispatch('scroll', {});
    assert.equal(page.$('jump').hidden, false);
    page.click(page.$('jump'));
    assert.equal(list.scrollTop, 5000);
    assert.equal(page.$('jump').hidden, true);
  });

  it('hides the jump button while the timeline is at the bottom', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail(), events: [event(1, 'worker_restarted')], dirty: true }, opts);
    const list = page.$('timeline');
    list.scrollHeight = 500;
    list.clientHeight = 400;
    list.scrollTop = 100;
    list.dispatch('scroll', {});
    assert.equal(page.$('jump').hidden, true);
  });

  it('filters the raw logs by text and reports the count', () => {
    const events = [event(1, 'worker_restarted', 'info', 'alpha'), event(2, 'agent_error', 'error', 'beta'), event(3, 'worker_restarted', 'info', 'alpha two')];
    const page = renderPage(AGENT_HTML, { detail: issueDetail(), events, dirty: true }, opts);
    page.click(page.$('raw-toggle'));
    assert.equal(page.$('raw-list').querySelectorAll('li').length, 3);
    const q = page.$('raw-q');
    q.value = 'alpha';
    q.dispatch('input', { target: q });
    assert.equal(page.$('raw-list').querySelectorAll('li').length, 2);
    assert.match(page.$('raw-list').textContent, /alpha two/);
    assert.doesNotMatch(page.$('raw-list').textContent, /beta/);
  });

  it('closes the raw logs again on a second click', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail(), events: [event(1, 'worker_restarted')], dirty: true }, opts);
    page.click(page.$('raw-toggle'));
    page.click(page.$('raw-toggle'));
    assert.equal(page.$('rawlog').hidden, true);
    assert.equal(page.$('raw-toggle').getAttribute('aria-expanded'), 'false');
  });

  it('puts untrusted event text into the timeline as text, never as markup', () => {
    const events = [event(1, 'agent_error', 'error', '<img src=x onerror=alert(1)>')];
    const page = renderPage(AGENT_HTML, { detail: issueDetail(), events, dirty: true }, opts);
    assert.equal(page.$('timeline').querySelectorAll('img').length, 0);
    assert.match(page.$('timeline').textContent, /<img src=x/);
  });
});

describe('team view characterization: controls (#372)', () => {
  it('offers no Retry/Resume/Force on a failed or retrying issue without control_allowed, and keeps head actions empty', () => {
    const paused = { source: 'operator', paused_at: '2026-10-30T11:50:00Z', continuations: 0 };
    for (const status of ['paused', 'retrying']) {
      const page = renderPage(AGENT_HTML, { detail: issueDetail({ status, running: null, paused: status === 'paused' ? paused : null, controls: { retry: false } }) }, opts);
      assert.equal(page.query('button.restart').length, 0, status);
    }
  });

  it('a control button is only ever rendered with controls.retry true', () => {
    const paused = { source: 'operator', paused_at: '2026-10-30T11:50:00Z', continuations: 0 };
    const allowed = renderPage(AGENT_HTML, { detail: issueDetail({ status: 'paused', running: null, paused, controls: { retry: true } }) }, opts);
    assert.ok(allowed.query('button.restart').length > 0);
    const denied = renderPage(AGENT_HTML, { detail: issueDetail({ status: 'paused', running: null, paused, controls: { retry: false } }) }, opts);
    assert.equal(denied.query('button.restart').length, 0);
  });
});
