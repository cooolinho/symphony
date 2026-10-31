import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/issue-page.ts';
import { renderPage, until } from './helpers.ts';
import type { FakeElement } from './helpers/fake-dom.ts';
import { issueDetail, scoreTeam } from './helpers/page-fixtures.ts';

// Team view (E3-5a, #372): main column with stage, score and the tabs Trace, Sessions, Transkript; sidebar with
// Ergebnisse and Context-Verlauf. The page runs in the fake DOM; what the user sees is asserted.

const AGENT_URL = 'http://127.0.0.1/issue?id=acme%2Fapp%231';
const opts = { url: AGENT_URL };
const session = (run: string, over: Record<string, unknown> = {}) => ({ run, attempt: null, role: 'developer', state: 'In progress', model: null, effort: null, started_at: '2026-10-30T11:00:00Z', finished_at: '2026-10-30T11:30:00Z', outcome: 'handed_off', transcript: null, ...over });
const finished = (run: string, pct: string, compacts: string, over: Record<string, string> = {}) => ({ ts: '2026-10-30T11:30:00Z', event: 'run_finished', issue: 'acme/app#1', run, role: 'developer', context_peak_percent: pct, context_compacts: compacts, ...over });
const inside = (node: FakeElement, selector: string) => node.closest(selector) !== null;

describe('team view: layout (#372)', () => {
  it('puts stage, score and tabs into the main column and the sidebar blocks into the side column', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail() }, opts);
    assert.ok(AGENT_HTML.indexOf('class="col-main"') < AGENT_HTML.indexOf('class="col-side'));
    for (const id of ['stage', 'score', 'tabs', 'pipe-section', 'gate-section']) assert.ok(inside(page.$(id), '.col-main'), id);
    for (const id of ['results-section', 'ctx-history', 'tok-kv', 'cost-kv', 'life-kv', 'ctx-kv', 'issue-section', 'int-section', 'access-section', 'changes-section']) assert.ok(inside(page.$(id), '.col-side'), id);
  });

  it('lets the sidebar wrap below the main column on narrow screens (390 px)', () => {
    assert.match(AGENT_HTML, /\.cols \{ display: flex; flex-wrap: wrap/);
    assert.match(AGENT_HTML, /\.col-main \{ flex: 999 1 640px/);
  });

  it('keeps the trace controls in the Trace panel and the session list in the Sessions panel', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail() }, opts);
    for (const id of ['timeline', 'filters', 'tl-q', 'earlier', 'jump', 'expand-all', 'collapse-all', 'raw-toggle', 'rawlog', 'raw-sev', 'raw-q', 'raw-list']) assert.ok(inside(page.$(id), '#panel-trace'), id);
    assert.ok(inside(page.$('runs'), '#panel-sessions'));
  });

  it('is served from issue-page.ts; agent-page.ts is gone', () => {
    assert.equal(fs.existsSync(new URL('../src/http/agent-page.ts', import.meta.url)), false);
    assert.equal(typeof AGENT_HTML, 'string');
  });
});

describe('team view: tabs (#372)', () => {
  const selected = (page: ReturnType<typeof renderPage>) => ['trace', 'sessions', 'transkript'].filter((id) => page.$('tab-' + id).getAttribute('aria-selected') === 'true');
  const visible = (page: ReturnType<typeof renderPage>) => ['trace', 'sessions', 'transkript'].filter((id) => !page.$('panel-' + id).hidden);

  it('has three real tab buttons with aria-controls', () => {
    const tabs = renderPage(AGENT_HTML, undefined, opts).query('button[role="tab"]');
    assert.deepEqual(tabs.map((t) => t.dataset.id), ['trace', 'sessions', 'transkript']);
    assert.deepEqual(tabs.map((t) => t.textContent.trim().split(' ')[0]), ['Trace', 'Sessions', 'Transkript']);
    for (const t of tabs) assert.equal(t.getAttribute('aria-controls'), 'panel-' + t.dataset.id);
  });

  it('selects Trace without a hash and for an unknown one', () => {
    for (const url of [AGENT_URL, AGENT_URL + '#foo']) {
      const page = renderPage(AGENT_HTML, { detail: issueDetail() }, { url });
      assert.deepEqual(selected(page), ['trace'], url);
      assert.deepEqual(visible(page), ['trace'], url);
      assert.equal(page.$('tab-sessions').getAttribute('aria-selected'), 'false');
      assert.equal(page.$('tab-trace').getAttribute('tabindex'), '0');
      assert.equal(page.$('tab-sessions').getAttribute('tabindex'), '-1');
    }
  });

  it('selects the tab named by the hash', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail() }, { url: AGENT_URL + '#sessions' });
    assert.deepEqual(selected(page), ['sessions']);
    assert.deepEqual(visible(page), ['sessions']);
  });

  it('switches on click and writes the tab into the hash', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail() }, opts);
    page.click(page.$('tab-transkript'));
    assert.deepEqual(selected(page), ['transkript']);
    assert.deepEqual(visible(page), ['transkript']);
    assert.equal(page.location.hash, '#transkript');
    assert.equal(page.location.pathname, '/issue');
  });

  it('moves with the arrow keys', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail() }, opts);
    page.$('tab-trace').dispatch('keydown', { bubbles: true, key: 'ArrowRight', preventDefault: () => {} });
    assert.deepEqual(selected(page), ['sessions']);
    page.$('tab-sessions').dispatch('keydown', { bubbles: true, key: 'End', preventDefault: () => {} });
    assert.deepEqual(selected(page), ['transkript']);
    page.$('tab-transkript').dispatch('keydown', { bubbles: true, key: 'ArrowRight', preventDefault: () => {} });
    assert.deepEqual(selected(page), ['trace']);
  });
});

describe('team view: sidebar Ergebnisse (#372)', () => {
  const long = 'Lange Zusammenfassung '.repeat(14) + '<img src=x onerror=alert(1)>';
  const results = [
    { role: 'developer', kind: 'implementation', verdict: 'done', round: null, target: 'Agent review', summary: 'Fertig.', created_at: '2026-10-30T11:00:00Z', url: 'javascript:alert(1)', findings: [], blockers: [] },
    { role: 'reviewer', kind: 'review', verdict: 'changes_needed', round: 2, target: 'In progress', summary: long, created_at: '2026-10-30T11:10:00Z', url: 'https://github.com/acme/app/issues/1#issuecomment-2', findings: [{ severity: 'major', file: 'src/a.ts', line: 3, problem: 'Guard fehlt', fix: null }], blockers: [] },
  ];

  it('shows one row per result with role, verdict chip, round, short summary and the comment link', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail({ results }) }, opts);
    assert.equal(page.$('results-section').hidden, false);
    assert.equal(page.$('results-count').textContent, '2');
    const rows = page.$('result-cards').children;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.tagName.toLowerCase(), 'li');
    assert.equal(rows[0]!.querySelector('b')!.textContent, 'developer');
    assert.equal(rows[1]!.querySelector('b')!.textContent, 'reviewer');
    assert.equal(rows[1]!.querySelector('.ui-chip')!.textContent, 'changes needed');
    assert.match(rows[1]!.textContent, /Runde 2/);
    assert.doesNotMatch(rows[0]!.textContent, /Runde/);
    const summary = rows[1]!.querySelector('.result-summary')!.textContent;
    assert.ok(summary.endsWith('…') && summary.length <= 140, summary);
    assert.equal(rows[0]!.querySelectorAll('a').length, 0, 'a javascript: URL is never linked');
    const [link] = rows[1]!.querySelectorAll('a');
    assert.equal(link!.textContent, 'Kommentar ↗');
    assert.equal(link!.href, results[1]!.url);
    assert.match(link!.rel, /noopener/);
    assert.match(rows[1]!.className, /vd-warn/);
  });

  it('folds findings into a details element and inserts text as text', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail({ results }) }, opts);
    const rows = page.$('result-cards').children;
    const more = rows[1]!.querySelector('details.result-more')!;
    assert.equal(more.querySelector('summary')!.textContent, '1 Finding');
    assert.match(more.textContent, /Guard fehlt/);
    assert.equal(rows[0]!.querySelector('details'), null);
    assert.equal(page.$('result-cards').querySelectorAll('img').length, 0);
  });

  it('is hidden without results', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail({ results: [] }) }, opts);
    assert.equal(page.$('results-section').hidden, true);
  });
});

describe('team view: sidebar Context-Verlauf (#372)', () => {
  it('draws a bar per developer round with its peak and a compact marker', () => {
    const ctxEntries = [finished('run-1', '45', '0'), finished('run-3', '82', '2')];
    const page = renderPage(AGENT_HTML, { detail: issueDetail(), team: scoreTeam(), ctxEntries }, opts);
    const rows = page.$('ctx-runs').querySelectorAll('li.ctx-run');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.querySelector('.ctx-round')!.textContent), ['R1', 'R2']);
    assert.deepEqual(rows.map((r) => r.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')), ['45', '82']);
    assert.equal(rows[1]!.querySelector('.ctx-pct')!.textContent, '82 %');
    const marks = page.$('ctx-runs').querySelectorAll('.ctx-compact');
    assert.equal(marks.length, 1);
    assert.equal(marks[0]!.title, '2 Auto-Compacts');
    assert.equal(page.$('ctx-empty').hidden, true);
  });

  it('shows — without data, and skips runs without a logged peak', () => {
    for (const ctxEntries of [null, [], [finished('run-1', 'null', '0'), finished('run-3', '', '')]]) {
      const page = renderPage(AGENT_HTML, { detail: issueDetail(), ctxEntries }, opts);
      assert.equal(page.$('ctx-runs').children.length, 0, JSON.stringify(ctxEntries));
      assert.equal(page.$('ctx-empty').hidden, false);
      assert.equal(page.$('ctx-empty').textContent, '—');
    }
  });

  it('loads the run_finished lines of exactly this issue once, and again only after another finished session', async () => {
    let detail = issueDetail({ timeline_seq: 0, sessions: [session('run-1')] });
    const entries = { entries: [finished('run-1', '45', '1'), finished('run-1', '90', '0', { issue: 'acme/app#10' }), finished('run-2', '50', '0', { role: 'reviewer' })] };
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: (url) => (url.startsWith('/api/v1/history/entries') ? entries : url.endsWith('/team') ? scoreTeam() : detail) });
    await until(() => page.$('ctx-runs').children.length > 0, 3_000, 'context rows');
    const loads = () => page.fetches.filter((f) => f.url.startsWith('/api/v1/history/entries?'));
    assert.equal(loads().length, 1);
    const url = loads()[0]!.url;
    for (const part of ['issue=acme%2Fapp%231', 'event=run_finished', 'order=asc']) assert.ok(url.includes(part), url);
    const rows = page.$('ctx-runs').querySelectorAll('li.ctx-run');
    assert.equal(rows.length, 1, 'neither #10 nor the reviewer');
    assert.equal(rows[0]!.querySelector('.ctx-pct')!.textContent, '45 %');

    const poll = page.intervals.find((i) => i.ms === 2000 && i.fn.name === 'poll')!.fn;
    const before = page.fetches.length;
    await poll();
    await until(() => page.fetches.length > before, 3_000, 'second poll');
    await new Promise((r) => setImmediate(r));
    assert.equal(loads().length, 1, 'no new finished session, no new load');

    detail = issueDetail({ timeline_seq: 0, sessions: [session('run-1'), session('run-2')] });
    await poll();
    await until(() => loads().length === 2, 3_000, 'reload after a finished session');
  });
});

describe('team view: Transkript tab (#372)', () => {
  const sessions = [session('r1', { transcript: '/t/r1.jsonl' }), session('r2', { role: 'reviewer', transcript: null })];
  const entries = [
    { type: 'prompt', offset: 0, at: '2026-10-30T11:00:00Z', text: 'Bitte umsetzen', truncated: false, length: 14, turn: 1 },
    { type: 'model_call', offset: 50, at: '2026-10-30T11:00:05Z', message_id: 'm1', model: 'opus', usage: null, cost_usd: null, blocks: [{ type: 'text', text: 'Erledigt', truncated: false, length: 8 }] },
  ];

  it('lists the transcript items of the chosen session with a JSONL link', () => {
    const tx = new Map([['r1', { available: true, entries, offset: 0, done: true, reason: null }]]);
    const page = renderPage(AGENT_HTML, { detail: issueDetail({ status: 'paused', running: null, sessions }), tx, dirty: true, tab: 'transkript', txRun: 'r1' }, opts);
    assert.equal(page.$('panel-transkript').hidden, false);
    const labels = page.$('transcript').querySelectorAll('li.item .label').map((l) => l.textContent);
    assert.ok(labels.includes('PROMPT · TURN 1'), labels.join());
    assert.ok(labels.includes('ASSISTANT RESPONSE'), labels.join());
    assert.equal(page.$('tx-run').value, 'r1');
    const [link] = page.$('tx-links').querySelectorAll('a');
    assert.equal(link!.textContent, 'Transkript (JSONL) ↗');
    assert.ok(link!.href.endsWith('/transcript?run=r1&format=raw'), link!.href);
  });

  it('says so for a session without a transcript', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail({ status: 'paused', running: null, sessions }), tab: 'transkript', txRun: 'r2' }, opts);
    assert.match(page.$('transcript').textContent, /Kein Transkript/);
    assert.equal(page.$('tx-links').querySelectorAll('a').length, 0);
  });
});

describe('team view: German texts (#372)', () => {
  it('names the sections in German and keeps Trace, Sessions and Transkript', () => {
    for (const text of ['Ergebnisse', 'Context-Verlauf', 'Trace', 'Sessions', 'Transkript', 'Alles aufklappen', 'Raw-Logs anzeigen', 'Lebenszyklus', 'Run-Kontext']) assert.ok(AGENT_HTML.includes(text), text);
    for (const text of ['Execution timeline', 'Stage results', 'Expand all', 'Show raw logs', 'Agent lifecycle', 'Token usage']) assert.ok(!AGENT_HTML.includes(text), text);
  });

  it('shows no control without control_allowed', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail({ status: 'paused', running: null, paused: { source: 'operator', paused_at: '2026-10-30T11:50:00Z', continuations: 0 }, controls: { retry: false } }) }, opts);
    assert.equal(page.query('#head-actions button.restart').length, 0);
    assert.equal(page.query('#alert button.restart').length, 0);
    assert.match(page.$('alert').textContent, /Controls disabled/);
  });
});
