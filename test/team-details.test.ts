import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/issue-page.ts';
import { renderPage } from './helpers.ts';
import type { FakeElement } from './helpers/fake-dom.ts';
import { issueDetail, scoreTeam } from './helpers/page-fixtures.ts';

// E3-8 (#387): the Details section of the team view with the tab pill (Execution-Trace, Sessions, Transkript) and the
// trace rows time · kind · text. The page runs in the fake DOM; what the user sees is asserted.

const URL = 'http://127.0.0.1/issue?id=acme%2Fapp%231';
const opts = { url: URL };
type Page = ReturnType<typeof renderPage>;
const session = (run: string, over: Record<string, unknown> = {}) => ({ run, attempt: null, role: 'developer', state: 'In progress', model: null, effort: null, started_at: '2026-10-30T11:00:00Z', finished_at: '2026-10-30T11:30:00Z', outcome: 'handed_off', transcript: null, ...over });
const selected = (page: Page) => page.query('#tabs button[role="tab"]').filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.dataset.id);
const shown = (page: Page) => ['trace', 'sessions', 'transcript'].filter((id) => !page.$('panel-' + id).hidden);

describe('details section and tab pill (#387)', () => {
  it('wraps the tabs into a glass section labelled Details with the tab pill', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail() }, opts);
    const tabs = page.$('tabs');
    const section = tabs.closest('section.details')!;
    assert.ok(section.classList.contains('g'));
    assert.equal(section.tagName.toLowerCase(), 'section');
    assert.equal(section.getAttribute('aria-label'), 'Details');
    assert.ok(tabs.classList.contains('tabs-pill'));
    assert.match(AGENT_HTML, /\.details \{ padding: 14px 18px 18px;/);
    assert.match(AGENT_HTML, /\.tabs-pill \{ display: inline-flex; flex-wrap: wrap; padding: 4px; gap: 4px; border-radius: 999px; background: rgba\(0,0,0,\.25\);/);
    assert.match(AGENT_HTML, /\.tabs-pill \.ui-tab\[aria-selected="true"\] \{ background: rgba\(255,255,255,\.12\); color: #fff; \}/);
  });

  it('names the tabs Execution-Trace, Sessions (<n>) and Transkript', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail({ status: 'paused', running: null, sessions: [session('r1'), session('r2')] }) }, opts);
    assert.deepEqual(page.query('#tabs button[role="tab"]').map((t) => t.textContent.trim()), ['Execution-Trace', 'Sessions (2)', 'Transkript']);
    assert.equal(page.$('runs-count').textContent, '(2)');
  });

  it('starts on the trace and switches on click without a reload, with the tab in the URL fragment', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail() }, opts);
    assert.deepEqual(selected(page), ['trace']);
    const loads = page.fetches.length;
    page.click(page.$('tab-transcript'));
    assert.deepEqual(selected(page), ['transcript']);
    assert.deepEqual(shown(page), ['transcript']);
    assert.equal(page.location.hash, '#transcript');
    assert.equal(page.location.pathname, '/issue');
    assert.equal(page.fetches.length, loads, 'no request for a tab change');
    page.click(page.$('tab-sessions'));
    assert.equal(page.location.hash, '#sessions');
    assert.deepEqual(shown(page), ['sessions']);
    page.click(page.$('tab-trace'));
    assert.equal(page.location.hash, '#trace');
    assert.deepEqual(shown(page), ['trace']);
  });

  it('opens the tab of the URL fragment, also the old #transkript', () => {
    for (const [hash, id] of [['#sessions', 'sessions'], ['#transcript', 'transcript'], ['#transkript', 'transcript'], ['#trace', 'trace']] as const) {
      const page = renderPage(AGENT_HTML, { detail: issueDetail() }, { url: URL + hash });
      assert.deepEqual(selected(page), [id], hash);
      assert.deepEqual(shown(page), [id], hash);
    }
    const old = renderPage(AGENT_HTML, { detail: issueDetail() }, { url: URL + '#transkript' });
    assert.equal(old.location.hash, '#transcript', 'the old fragment is rewritten');
  });
});

describe('trace rows (#387)', () => {
  const tool = (offset: number, id: string, name: string, input: Record<string, unknown>, at = '11:10:00') => ({
    type: 'model_call', offset, at: `2026-10-30T${at}Z`, message_id: `m${offset}`, model: 'claude-opus-5-5', usage: null, cost_usd: null, stop_reason: null, error: null, parent_tool_use_id: null,
    blocks: [{ type: 'tool_use', id, name, input: JSON.stringify(input) }],
  });
  const entries = [
    tool(1, 't1', 'Edit', { file_path: 'src/http/ui/tokens.ts', old_string: 'a', new_string: 'b' }),
    tool(2, 't2', 'mcp__brain__brain_read', { path: 'Decisions/Glass-Tokens', purpose: 'Rollenfarben prüfen' }),
    tool(3, 't3', 'Agent', { subagent_type: 'Explore', description: 'liest test/http.test.ts', prompt: 'x' }),
    { type: 'model_call', offset: 4, at: '2026-10-30T11:11:00Z', message_id: 'm4', model: 'claude-opus-5-5', cost_usd: 0.09, stop_reason: null, error: null, parent_tool_use_id: null, blocks: [],
      usage: { input_tokens: 200, output_tokens: 1400, cache_read_tokens: 16000, cache_write_tokens: 2000 } },
  ];
  const events = [
    { seq: 1, at: '2026-10-30T11:20:00Z', kind: 'orchestrator', event: 'phase', run: 'rt', level: 'info', message: '', detail: { from: 'In progress', to: 'Testing' } },
    { seq: 2, at: '2026-10-30T11:30:00Z', kind: 'lifecycle', event: 'run_finished', run: 'rt', level: 'error', message: 'failed: 2 Tests rot', detail: { outcome: 'failed', reason: '2 Tests rot', next_role: 'developer', turns: 4 } },
  ];
  const render = () => {
    const sessions = [session('r1', { transcript: '/t/r1.jsonl' }), session('rt', { role: 'tester', started_at: '2026-10-30T11:20:00Z' })];
    const team = scoreTeam({}, { blocks: [{ role: 'tester', run: 'rt', started_at: '2026-10-30T11:20:00Z', ended_at: '2026-10-30T11:30:00Z', verdict: 'failed', round: 1, model: 'sonnet', tool_calls: 3 }] });
    const tx = new Map([['r1', { available: true, entries, offset: 0, done: true, reason: null }]]);
    return renderPage(AGENT_HTML, { detail: issueDetail({ status: 'paused', running: null, sessions }), team, tx, events, dirty: true }, opts);
  };
  const row = (page: Page, kind: string): FakeElement[] => page.$('timeline').querySelectorAll('li.item.kind-' + kind);
  const text = (li: FakeElement) => li.querySelector('.text')!.textContent;

  it('lays out every row as time · kind · text', () => {
    const page = render();
    const items = page.$('timeline').querySelectorAll('li.item');
    assert.ok(items.length >= 6);
    for (const li of items) {
      assert.deepEqual(li.children.slice(0, 2).map((c) => [c.tagName.toLowerCase(), c.className]), [['time', 'when'], ['span', 'kind']]);
      assert.ok(li.querySelector('.card .text'));
    }
    assert.match(AGENT_HTML, /\.item \{ display: grid; grid-template-columns: 76px 96px minmax\(0, 1fr\); gap: 10px; padding: 9px 4px; border-top: 1px solid rgba\(255, 255, 255, \.06\); font-size: 13px; align-items: baseline;/);
    assert.match(AGENT_HTML, /\.item \.when \{ font-family: var\(--mono\); color: var\(--fg-2\);/);
    assert.match(AGENT_HTML, /\.item \.kind \{ font: 11px var\(--mono\); letter-spacing: \.08em;/);
    assert.match(AGENT_HTML, /\.item \.text \{ font-family: var\(--mono\); color: #dbe3f0; overflow-wrap: anywhere; \}/);
  });

  it('names the kind and builds the text of each row', () => {
    const page = render();
    assert.equal(row(page, 'tool')[0]!.querySelector('.kind')!.textContent, 'TOOL');
    assert.equal(text(row(page, 'tool')[0]!), 'Edit src/http/ui/tokens.ts');
    const [brain] = row(page, 'brain');
    assert.equal(brain!.querySelector('.kind')!.textContent, 'BRAIN');
    assert.equal(text(brain!), 'brain_read Decisions/Glass-Tokens · Zweck: Rollenfarben prüfen');
    assert.equal(row(page, 'subagent')[0]!.querySelector('.kind')!.textContent, 'SUBAGENT');
    assert.equal(text(row(page, 'subagent')[0]!), 'Explore gestartet: liest test/http.test.ts');
    const models = row(page, 'model').map(text);
    assert.ok(models.includes('opus · 18.2k in / 1.4k out · $0.09'), models.join(' | '));
    assert.equal(row(page, 'result')[0]!.querySelector('.kind')!.textContent, 'RESULT');
    assert.equal(text(row(page, 'result')[0]!), 'Tester R1: failed → Developer');
    assert.ok(row(page, 'phase').map(text).includes('In progress → Testing'));
  });

  it('colours the kinds with the trace tokens', () => {
    for (const kind of ['tool', 'brain', 'subagent', 'model', 'result']) assert.ok(AGENT_HTML.includes(`.kind-${kind} .kind { color: var(--trace-${kind}); }`), kind);
    assert.ok(AGENT_HTML.includes('.kind-phase .kind { color: var(--gray); }'));
    assert.ok(AGENT_HTML.includes('--trace-subagent: #6ee7b7;'), 'SUBAGENT green #6ee7b7');
  });

  it('keeps expand-all and the filters on the new rows', () => {
    const page = render();
    page.click(page.$('expand-all'));
    assert.equal(row(page, 'tool')[0]!.querySelector('button.toggle')!.getAttribute('aria-expanded'), 'true');
    assert.match(row(page, 'tool')[0]!.textContent, /old_string/);
    page.click(page.$('filters').querySelectorAll('button').find((b) => b.dataset.f === 'phase')!);
    assert.deepEqual(page.$('timeline').querySelectorAll('li.item').map((li) => li.className.split(' ')[1]), ['kind-phase']);
  });
});
