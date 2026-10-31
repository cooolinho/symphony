import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/issue-page.ts';
import { renderPage, until } from './helpers.ts';
import { changeEntry, issueDetail, scoreTeam } from './helpers/page-fixtures.ts';

// E3-8 (#387): the row of four panels below the columns of the team view (Ergebnisse, Context-Verlauf, Brain-Zugriffe,
// Changes) after the mockup. The page runs in the fake DOM; what the user sees is asserted.

const opts = { url: 'http://127.0.0.1/issue?id=acme%2Fapp%231' };
type Page = ReturnType<typeof renderPage>;
const session = (run: string, over: Record<string, unknown> = {}) => ({ run, attempt: null, role: 'developer', state: 'In progress', model: null, effort: null, started_at: '2026-10-30T11:00:00Z', finished_at: '2026-10-30T11:20:00Z', outcome: 'handed_off', transcript: `/t/${run}.jsonl`, ...over });
const result = (role: string, kind: string, verdict: string, round: number | null, summary: string) => ({ role, kind, verdict, round, target: 'In progress', summary, created_at: '2026-10-30T11:00:00Z', url: null, findings: [], blockers: [] });

describe('panel row (#387)', () => {
  it('puts the four panels as glass sections into one wrapping row after the columns', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail() }, opts);
    const row = page.$('panel-row');
    assert.deepEqual(row.children.map((c) => [c.tagName.toLowerCase(), c.id, c.classList.contains('g')]), [
      ['section', 'results-section', true], ['section', 'ctx-history', true], ['section', 'access-section', true], ['section', 'changes-section', true],
    ]);
    assert.ok(AGENT_HTML.indexOf('class="cols"') < AGENT_HTML.indexOf('id="panel-row"'));
    assert.match(AGENT_HTML, /\.panel-row \{ display: flex; flex-wrap: wrap; gap: 18px;/);
    assert.match(AGENT_HTML, /\.panel-row > \.g \{ flex: 1 1 320px; min-width: 0; padding: 18px; \}/);
  });
});

describe('panel Ergebnisse (#387)', () => {
  const results = [
    result('developer', 'implementation', 'implemented', 1, 'Tokens umgesetzt.'),
    result('tester', 'test', 'failed', 1, '2 Tests rot: test/http.test.ts:147 und :186'),
    result('reviewer', 'review', 'needs_human', 2, '<img src=x onerror=alert(1)>'),
    result('analyst', 'analysis', 'ready', null, 'Bereit.'),
  ];

  it('shows a .gi card per stage with role dot, "Rolle R<n>" and the verdict pill in the verdict colour', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail({ results }) }, opts);
    const cards = page.$('result-cards').querySelectorAll('li.res-card');
    assert.equal(cards.length, 4);
    for (const c of cards) assert.ok(c.classList.contains('gi'));
    assert.deepEqual(cards.map((c) => c.querySelector('.res-name')!.textContent), ['Developer R1', 'Tester R1', 'Reviewer R2', 'Analyst']);
    assert.deepEqual(cards.map((c) => c.querySelector('.res-pill')!.textContent), ['implemented', 'failed', 'needs human', 'ready']);
    assert.deepEqual(cards.map((c) => c.querySelector('.res-pill')!.style.color), ['#34d399', '#f87171', '#fbbf24', '#34d399']);
    assert.deepEqual(cards.map((c) => c.querySelector('.res-pill')!.style.borderColor), ['#34d399', '#f87171', '#fbbf24', '#34d399']);
    assert.ok(cards[0]!.querySelector('.ui-dot.res-dot'), 'role dot');
    assert.equal(cards[1]!.querySelector('.result-summary')!.textContent, '2 Tests rot: test/http.test.ts:147 und :186');
    assert.equal(page.$('result-cards').querySelectorAll('img').length, 0, 'summary is text');
    assert.equal(page.$('results-empty').hidden, true);
  });

  it('styles the card and the pill after the mockup', () => {
    assert.match(AGENT_HTML, /\.res-card \{ display: grid; gap: 6px; padding: 10px 12px;/);
    assert.match(AGENT_HTML, /\.res-name \{[^}]*font-weight: 500;/);
    assert.match(AGENT_HTML, /\.res-pill \{ flex: none; font: 11\.5px var\(--mono\); padding: 1px 8px; border-radius: 99px; border: 1px solid currentColor;/);
    assert.match(AGENT_HTML, /\.result-summary \{ font-size: 12\.5px; color: var\(--fg-2\);/);
  });

  it('says "Noch keine Stage abgeschlossen" without results', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail({ results: [] }) }, opts);
    assert.equal(page.$('results-section').hidden, false);
    assert.equal(page.$('result-cards').children.length, 0);
    assert.equal(page.$('results-empty').hidden, false);
    assert.equal(page.$('results-empty').textContent, 'Noch keine Stage abgeschlossen');
  });
});

describe('panel Context-Verlauf (#387)', () => {
  const call = (offset: number, at: string, tokens: number, over: Record<string, unknown> = {}) => ({
    type: 'model_call', offset, at: `2026-10-30T${at}Z`, message_id: `m${offset}`, model: 'claude-opus-5-5', cost_usd: 0.01, stop_reason: null, error: null, parent_tool_use_id: null, blocks: [],
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: tokens - 3000, cache_write_tokens: 2000 }, ...over,
  });
  const run1 = [call(1, '11:05:00', 40000), call(2, '11:10:00', 80000), call(3, '11:15:00', 95000), call(4, '11:15:30', 99000, { parent_tool_use_id: 'sub' }),
    { type: 'system', subtype: 'compact_boundary', offset: 5, at: '2026-10-30T11:16:00Z', text: 'compacted' }, call(6, '11:18:00', 30000)];
  const run3 = [call(1, '11:35:00', 20000), call(2, '11:45:00', 40000)];
  const tx = () => new Map([['run-1', { available: true, entries: run1, offset: 0, done: true, reason: null }], ['run-3', { available: true, entries: run3, offset: 0, done: false, reason: null }]]);
  const sessions = [session('run-1'), session('run-2', { role: 'reviewer', started_at: '2026-10-30T11:20:00Z', finished_at: '2026-10-30T11:30:00Z' }), session('run-3', { started_at: '2026-10-30T11:31:00Z', finished_at: null, outcome: null })];
  const ctxEntries = [{ ts: '2026-10-30T11:20:00Z', event: 'run_finished', issue: 'acme/app#1', run: 'run-1', role: 'developer', context_peak_percent: '95', context_compacts: '1' }];
  const live = () => {
    const detail = issueDetail({ sessions });
    detail.running.context = { tokens: 40000, window: 100000, percent: 40, compacts: 0 };
    return renderPage(AGENT_HTML, { detail, team: scoreTeam({ live: true }), tx: tx(), dirty: true, ctxEntries }, opts);
  };
  const svgOf = (page: Page) => page.$('ctx-chart').querySelector('svg')!;

  it('draws the context of the role with the most sessions as an SVG with a data-built aria-label', () => {
    const page = live();
    assert.equal(page.$('ctx-history-title').textContent, 'Context-Verlauf · Developer');
    const svg = svgOf(page);
    assert.equal(svg.getAttribute('viewBox'), '0 0 320 150');
    assert.equal(svg.getAttribute('role'), 'img');
    assert.equal(svg.getAttribute('aria-label'), 'Context-Füllstand des Developer: Runde 1 steigt bis 95 Prozent, Auto-Compact fällt auf 30 Prozent, Runde 2 steht bei 40 Prozent');
    assert.equal(page.$('ctx-empty').hidden, true);
  });

  it('has the base line, the dashed threshold line with its label, one line per round, the compact and the now dot', () => {
    const svg = svgOf(live());
    const base = svg.querySelector('line.ctx-base')!;
    assert.deepEqual([base.getAttribute('y1'), base.getAttribute('y2'), base.getAttribute('stroke')], ['140', '140', 'rgba(255,255,255,.15)']);
    const thr = svg.querySelector('line.ctx-thr')!;
    assert.equal(thr.getAttribute('stroke-dasharray'), '4 4');
    assert.equal(thr.getAttribute('stroke'), '#f87171');
    assert.equal(thr.getAttribute('y1'), '44', '80 % of the threshold');
    assert.equal(svg.querySelector('text.ctx-thr-label')!.textContent, 'Auto-Compact 80 %');
    const lines = svg.querySelectorAll('polyline');
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!.getAttribute('points')!.split(' ').length, 4, 'four main-conversation calls, the subagent call left out');
    assert.equal(lines[0]!.getAttribute('stroke-width'), '2');
    assert.notEqual(lines[0]!.getAttribute('stroke'), lines[1]!.getAttribute('stroke'), 'later rounds lighter');
    const compact = svg.querySelectorAll('circle.ctx-compact-dot');
    assert.equal(compact.length, 1);
    assert.deepEqual([compact[0]!.getAttribute('r'), compact[0]!.getAttribute('fill'), compact[0]!.getAttribute('cy')], ['4', '#f87171', '26']);
    assert.equal(svg.querySelector('text.ctx-compact-label')!.textContent, 'compact');
    const now = svg.querySelectorAll('circle.ctx-now-dot');
    assert.equal(now.length, 1);
    assert.equal(now[0]!.getAttribute('fill'), '#fbbf24');
    assert.equal(now[0]!.getAttribute('cy'), '92', '40 %');
    assert.deepEqual(svg.querySelectorAll('text.ctx-round-label').map((t) => t.textContent), ['R1', 'R2']);
    assert.match(AGENT_HTML, /\.ctx-thr-label, \.ctx-compact-label \{ font: 10px var\(--mono\); fill: #fca5a5; \}/);
    assert.match(AGENT_HTML, /\.ctx-round-label \{ font: 10px var\(--mono\); fill: var\(--fg-2\); \}/);
  });

  it('writes the caption with compacts, the current value and the trend', () => {
    const page = live();
    assert.equal(page.$('ctx-caption').textContent, 'R1: 1 Auto-Compact bei 95 % · R2 jetzt 40 %, Trend +2.0 %/min');
    assert.match(AGENT_HTML, /\.ctx-caption \{ margin-top: 8px; font-size: 12\.5px;/);
  });

  it('follows the role with the most sessions', () => {
    const reviewers = [session('a', { role: 'reviewer' }), session('b', { role: 'reviewer', started_at: '2026-10-30T11:30:00Z' }), session('c')];
    const entries = [{ ts: '2026-10-30T11:20:00Z', event: 'run_finished', issue: 'acme/app#1', run: 'a', role: 'reviewer', context_peak_percent: '30', context_compacts: '0' }];
    const page = renderPage(AGENT_HTML, { detail: issueDetail({ status: 'paused', running: null, sessions: reviewers }), ctxEntries: entries }, opts);
    assert.equal(page.$('ctx-history-title').textContent, 'Context-Verlauf · Reviewer');
    assert.match(svgOf(page).getAttribute('aria-label')!, /^Context-Füllstand des Reviewer: Runde 1 steigt bis 30 Prozent$/);
  });

  it('shows "Kein Context-Verlauf verfügbar" and no SVG without context data', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail({ status: 'paused', running: null, sessions: [session('run-1', { transcript: null })] }), ctxEntries: [] }, opts);
    assert.equal(page.$('ctx-chart').querySelectorAll('svg').length, 0);
    assert.equal(page.$('ctx-empty').hidden, false);
    assert.equal(page.$('ctx-empty').textContent, 'Kein Context-Verlauf verfügbar');
    assert.equal(page.$('ctx-caption').hidden, true);
  });
});

describe('panel Brain-Zugriffe (#387)', () => {
  const access = (i: number, over: Record<string, unknown> = {}) => ({ at: `2026-10-30T11:${String(50 - i).padStart(2, '0')}:00Z`, run: 'r', issue: 'acme/app#1', role: 'developer', op: 'read', path_or_query: `Notes/n${i}.md`, purpose: `Zweck ${i}`, result: 'ok', ...over });
  const nine = [access(0, { path_or_query: 'Decisions/Glass-Tokens', purpose: 'Rollenfarben prüfen' }), access(1, { op: 'write', path_or_query: 'Inbox/a.md' }), access(2, { op: 'search', path_or_query: 'ring gauge', purpose: '' }),
    access(3, { op: 'write', path_or_query: 'Inbox/b.md', result: 'rejected', reason: 'hash_mismatch' }), access(4, { op: 'list', path_or_query: '<img src=x>' }), access(5), access(6), access(7), access(8)];
  const fixture = (rows: unknown) => (url: string): unknown => {
    if (url.startsWith('/api/v1/brain/access?')) return rows;
    if (url.startsWith('/api/v1/changes?')) return { entries: [], counts: {}, next_before: null };
    if (url.endsWith('/team')) return scoreTeam();
    return issueDetail({ timeline_seq: 0 });
  };

  it('shows six rows with time, operation in its colour, note and purpose, then "alle <n> →" to the brain page', async () => {
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture({ access: nine, next_before: null }) });
    await until(() => page.$('access-list').children.length > 0, 3_000, 'access');
    assert.equal(page.$('access-title').textContent, 'Brain-Zugriffe · #1');
    assert.equal(page.$('access-link').textContent, 'Brain →');
    const rows = page.$('access-list').querySelectorAll('li.acc-row');
    assert.equal(rows.length, 6);
    assert.ok(rows[0]!.querySelector('time.acc-time')!.textContent.length >= 4);
    assert.deepEqual(rows.slice(0, 5).map((r) => r.querySelector('.acc-op')!.className), ['acc-op op-read', 'acc-op op-write', 'acc-op op-search', 'acc-op op-denied', 'acc-op op-other']);
    assert.equal(rows[0]!.querySelector('.acc-note')!.textContent, 'Decisions/Glass-Tokens');
    assert.equal(rows[0]!.querySelector('.acc-purpose')!.textContent, 'Rollenfarben prüfen');
    assert.equal(rows[2]!.querySelector('.acc-purpose')!.textContent, 'Zweck fehlt');
    assert.match(rows[3]!.className, /rejected/);
    assert.equal(rows[3]!.querySelector('.acc-purpose')!.textContent, 'abgewiesen · hash_mismatch');
    assert.equal(rows[3]!.querySelector('a.side-clash')!.getAttribute('href'), '/brain#clashes');
    assert.equal(page.query('#access-section img').length, 0, 'notes are text');
    const more = page.$('access-more');
    assert.equal(more.hidden, false);
    const link = more.querySelector('a')!;
    assert.equal(link.textContent, 'alle 9 →');
    assert.equal(link.getAttribute('href'), '/brain?issue=acme%2Fapp%231');
    assert.ok(page.fetches.some((f) => f.url === '/api/v1/brain/access?issue=acme%2Fapp%231&limit=100'));
  });

  it('styles the rows after the mockup and colours the operations', () => {
    assert.match(AGENT_HTML, /\.acc-row \{ display: grid; grid-template-columns: 62px 64px minmax\(0,1fr\); gap: 8px; padding: 8px 0; border-top: 1px solid rgba\(255,255,255,\.06\); font-size: 12\.5px;/);
    assert.match(AGENT_HTML, /\.acc-op\.op-read \{ color: var\(--op-read\); \} \.acc-op\.op-write \{ color: var\(--op-write\); \} \.acc-op\.op-search \{ color: var\(--op-search\); \} \.acc-op\.op-denied \{ color: var\(--op-denied\); \}/);
    assert.match(AGENT_HTML, /\.acc-note \{ font-weight: 500;/);
    assert.match(AGENT_HTML, /\.acc-purpose \{ font-style: italic; font-size: 12\.5px; color: var\(--fg-3\);/);
  });

  it('has no "alle" link with six accesses or fewer', async () => {
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture({ access: nine.slice(0, 6), next_before: null }) });
    await until(() => page.$('access-list').children.length === 6, 3_000, 'access');
    assert.equal(page.$('access-more').hidden, true);
  });

  it('says "Keine Brain-Zugriffe in diesem Issue" with a brain but without accesses', async () => {
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture({ access: [], next_before: null }) });
    await until(() => !page.$('access-section').hidden, 3_000, 'panel');
    assert.equal(page.$('access-empty').hidden, false);
    assert.equal(page.$('access-empty').textContent, 'Keine Brain-Zugriffe in diesem Issue');
  });

  it('hides the panel without a brain (404)', async () => {
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture({ __status: 404, error: { code: 'brain_disabled' } }) });
    await until(() => page.fetches.some((f) => f.url.startsWith('/api/v1/brain/access?')), 3_000, 'access call');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(page.$('access-section').hidden, true);
  });
});

describe('panel Changes (#387)', () => {
  const feed = (entries: unknown[], detail = issueDetail({ timeline_seq: 0 })) => (url: string): unknown => {
    if (url.startsWith('/api/v1/changes?')) return { entries, counts: {}, next_before: null };
    if (url.startsWith('/api/v1/brain/access?')) return { access: [], next_before: null };
    if (url.endsWith('/team')) return scoreTeam();
    return detail;
  };
  const load = async (entries: unknown[], detail?: Record<string, unknown>) => {
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: feed(entries, detail as never) });
    await until(() => page.$('changes-list').children.length > 0 || !page.$('changes-empty').hidden, 3_000, 'changes');
    return page;
  };

  it('shows the title with the number, "Alle →" and one row per file with path and +/− in their colours', async () => {
    const page = await load([changeEntry()]);
    assert.equal(page.$('changes-title').textContent, 'Changes · #1');
    assert.equal(page.$('changes-all').textContent, 'Alle →');
    assert.equal(page.$('changes-all').getAttribute('href'), '/changes?issue=acme%2Fapp%231');
    const rows = page.$('changes-list').querySelectorAll('li.chg-row');
    assert.deepEqual(rows.map((r) => [r.querySelector('.chg-path')!.textContent, r.querySelector('.chg-add')!.textContent, r.querySelector('.chg-del')!.textContent]), [['src/a.ts', '+10', '−0'], ['src/b.ts', '+2', '−3']]);
    assert.match(AGENT_HTML, /\.chg-row \{ display: grid; grid-template-columns: minmax\(0,1fr\) 92px;/);
    assert.match(AGENT_HTML, /\.chg-path \{ font-family: var\(--mono\);[^}]*text-overflow: ellipsis; white-space: nowrap;/);
    assert.match(AGENT_HTML, /\.chg-add \{ color: #6ee7b7; \}/);
    assert.match(AGENT_HTML, /\.chg-del \{ color: #fca5a5; \}/);
  });

  it('shows the pull request card with state and checks', async () => {
    const cases: Array<[string, string, string]> = [['pending', 'Checks laufen', '#fbbf24'], ['success', 'Checks grün', '#34d399'], ['failure', 'Checks rot', '#f87171']];
    for (const [status, text, color] of cases) {
      const page = await load([changeEntry({ pr: { number: 7, status } })]);
      const card = page.$('changes-pr');
      assert.ok(card.classList.contains('gi'));
      assert.equal(card.querySelector('.chg-pr-state')!.textContent, 'PR #7 · offen', status);
      assert.equal(card.querySelector('.chg-pr-checks')!.textContent, text);
      assert.equal(card.querySelector('.chg-pr-checks')!.style.color, color);
    }
    const merged = await load([changeEntry({ id: 'code:acme/app:merge:7', status: 'merged', pr: { number: 7, status: 'success' }, files: [] }), changeEntry()]);
    assert.equal(merged.$('changes-pr').querySelector('.chg-pr-state')!.textContent, 'PR #7 · gemerged');
  });

  it('says "noch keine PR" without a pull request, and "Noch keine Änderungen." without changes', async () => {
    const page = await load([changeEntry({ pr: null })]);
    assert.equal(page.$('changes-pr').textContent, 'noch keine PR');
    const empty = await load([]);
    assert.equal(empty.$('changes-empty').hidden, false);
    assert.equal(empty.$('changes-pr').textContent, 'noch keine PR');
  });

  it('caps the list at eight files and sums a path changed twice', async () => {
    const files = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ path: `src/f${from + i}.ts`, added: 1, deleted: 1, status: 'modified' }));
    const page = await load([changeEntry({ files: [...files(5, 0), { path: 'src/same.ts', added: 2, deleted: 0, status: 'modified' }] }), changeEntry({ id: 'x', files: [{ path: 'src/same.ts', added: 3, deleted: 1, status: 'modified' }, ...files(5, 5)] })]);
    const rows = page.$('changes-list').querySelectorAll('li.chg-row');
    assert.equal(rows.length, 8);
    const same = rows.find((r) => r.querySelector('.chg-path')!.textContent === 'src/same.ts')!;
    assert.equal(same.querySelector('.chg-add')!.textContent, '+5');
    assert.equal(same.querySelector('.chg-del')!.textContent, '−1');
  });
});
