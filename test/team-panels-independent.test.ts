import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/issue-page.ts';
import { ROLE_COLORS, TRACE_COLORS } from '../src/http/ui/tokens.ts';
import { renderPage, until } from './helpers.ts';
import type { FakeElement } from './helpers/fake-dom.ts';
import { brainChangeEntry, changeEntry, issueDetail, scoreTeam } from './helpers/page-fixtures.ts';

// E3-8 (#387), independent acceptance tests derived from the issue text: the row of four panels below the score and the
// Details section with tab pill and trace rows. The page runs in the fake DOM; the user-visible result is asserted.

const ID = 'acme/app#1';
const opts = { url: 'http://127.0.0.1/issue?id=' + encodeURIComponent(ID) };
type Page = ReturnType<typeof renderPage>;
const session = (run: string, over: Record<string, unknown> = {}) => ({ run, attempt: null, role: 'developer', state: 'In progress', model: null, effort: null, started_at: '2026-10-30T11:00:00Z', finished_at: '2026-10-30T11:20:00Z', outcome: 'handed_off', transcript: `/t/${run}.jsonl`, ...over });
const result = (role: string, verdict: string, round: number | null, summary: string) => ({ role, kind: 'implementation', verdict, round, target: 'In progress', summary, created_at: '2026-10-30T11:00:00Z', url: null, findings: [], blockers: [] });
const text = (e: FakeElement | null) => (e ? e.textContent.replace(/\s+/g, ' ').trim() : '');

describe('independent: panel row below the score (#387)', () => {
  it('holds exactly four glass sections titled Ergebnisse, Context-Verlauf, Brain-Zugriffe and Changes, between columns and Details', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail() }, opts);
    const row = page.$('panel-row');
    const sections = row.querySelectorAll('section.g');
    assert.equal(sections.length, 4);
    const titles = sections.map((s) => text(s.querySelector('h2')));
    assert.match(titles[0]!, /^Ergebnisse/);
    assert.match(titles[1]!, /^Context-Verlauf · /);
    assert.match(titles[2]!, /^Brain-Zugriffe · #1/);
    assert.match(titles[3]!, /^Changes · #1/);
    const at = (needle: string) => AGENT_HTML.indexOf(needle);
    assert.ok(at('class="cols"') < at('id="panel-row"'), 'row after the columns');
    assert.ok(at('id="panel-row"') < at('aria-label="Details"'), 'row before Details');
  });

  it('styles the row with wrap, gap 18px and panels of flex 1 1 320px, min-width 0 and padding 18px', () => {
    assert.match(AGENT_HTML, /flex-wrap:\s*wrap/);
    assert.match(AGENT_HTML, /gap:\s*18px/);
    assert.match(AGENT_HTML, /flex:\s*1 1 320px;\s*min-width:\s*0;\s*padding:\s*18px/);
  });
});

describe('independent: panel Ergebnisse (#387)', () => {
  const colorOf = (verdict: string) => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail({ results: [result('developer', verdict, 1, 'x')] }) }, opts);
    const pill = page.$('result-cards').querySelector('.res-pill')!;
    assert.equal(pill.style.borderColor, pill.style.color, `border and text share the colour for ${verdict}`);
    assert.ok(pill.style.color, `colour for ${verdict}`);
    return pill.style.color;
  };

  it('maps every verdict family to one colour: green, red, amber', () => {
    const green = ['ready', 'implemented', 'approved'].map(colorOf);
    const red = ['failed', 'changes_requested'].map(colorOf);
    const amber = ['needs_human', 'needs_info'].map(colorOf);
    assert.equal(new Set(green).size, 1, green.join());
    assert.equal(new Set(red).size, 1, red.join());
    assert.equal(new Set(amber).size, 1, amber.join());
    assert.equal(new Set([green[0], red[0], amber[0]]).size, 3, 'three different colours');
  });

  it('renders one .gi card per stage with "Rolle R<n>", mono pill and the summary as plain text', () => {
    const results = [result('developer', 'implemented', 1, 'Fertig <b>fett</b>'), result('tester', 'failed', 1, '2 Tests rot: test/http.test.ts:147 und :186'), result('developer', 'implemented', 2, 'Zweite Runde')];
    const page = renderPage(AGENT_HTML, { detail: issueDetail({ results }) }, opts);
    const cards = page.$('result-cards').querySelectorAll('.gi');
    assert.equal(cards.length, 3);
    const names = cards.map((c) => text(c));
    assert.match(names[0]!, /Developer R1/);
    assert.match(names[1]!, /Tester R1/);
    assert.match(names[2]!, /Developer R2/);
    assert.ok(names[1]!.includes('2 Tests rot: test/http.test.ts:147 und :186'));
    assert.ok(names[0]!.includes('Fertig <b>fett</b>'), 'markup stays text');
    assert.equal(page.$('result-cards').querySelectorAll('b').length, 0);
  });

  it('shows "Noch keine Stage abgeschlossen" and no card without results', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail({ results: [] }) }, opts);
    assert.equal(page.$('result-cards').querySelectorAll('.gi').length, 0);
    assert.ok(text(page.$('results-section')).includes('Noch keine Stage abgeschlossen'));
    assert.equal(page.$('results-empty').hidden, false);
  });

  it('hides the empty text once a result exists', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail({ results: [result('developer', 'ready', 1, 'ok')] }) }, opts);
    assert.equal(page.$('results-empty').hidden, true);
  });
});

describe('independent: panel Context-Verlauf (#387)', () => {
  const call = (offset: number, at: string, tokens: number, over: Record<string, unknown> = {}) => ({
    type: 'model_call', offset, at: `2026-10-30T${at}Z`, message_id: `m${offset}`, model: 'claude-opus-5-5', cost_usd: 0.01, stop_reason: null, error: null, parent_tool_use_id: null, blocks: [],
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: tokens - 3000, cache_write_tokens: 2000 }, ...over,
  });
  const compact = (offset: number, at: string) => ({ type: 'system', subtype: 'compact_boundary', offset, at: `2026-10-30T${at}Z`, text: 'compacted' });
  const sessions = [session('run-1'), session('run-2', { role: 'reviewer', started_at: '2026-10-30T11:20:00Z', finished_at: '2026-10-30T11:30:00Z' }), session('run-3', { started_at: '2026-10-30T11:31:00Z', finished_at: null, outcome: null })];
  const run1 = [call(1, '11:05:00', 50000), call(2, '11:10:00', 90000), compact(3, '11:12:00'), call(4, '11:15:00', 25000)];
  const run3 = [call(1, '11:35:00', 20000), call(2, '11:45:00', 60000)];
  const live = (threshold = 75, first = run1) => {
    const detail = issueDetail({ sessions });
    detail.running.context = { tokens: 60000, window: 100000, percent: 60, compacts: 0 };
    const tx = new Map([['run-1', { available: true, entries: first, offset: 0, done: true, reason: null }], ['run-3', { available: true, entries: run3, offset: 0, done: false, reason: null }]]);
    const team = scoreTeam({ live: true }, { compact_threshold: threshold });
    return renderPage(AGENT_HTML, { detail, team, tx, dirty: true, ctxEntries: [] }, opts);
  };
  const svgOf = (page: Page) => page.$('ctx-chart').querySelector('svg')!;

  it('builds the aria-label from the data of the two rounds', () => {
    const svg = svgOf(live());
    assert.equal(svg.getAttribute('role'), 'img');
    assert.equal(svg.getAttribute('viewBox'), '0 0 320 150');
    assert.equal(svg.getAttribute('aria-label'), 'Context-Füllstand des Developer: Runde 1 steigt bis 90 Prozent, Auto-Compact fällt auf 25 Prozent, Runde 2 steht bei 60 Prozent');
  });

  it('draws base line at y 140, a dashed red threshold line at the configured threshold with its label', () => {
    const svg = svgOf(live(75));
    const base = svg.querySelector('line.ctx-base')!;
    assert.equal(base.getAttribute('y1'), '140');
    assert.equal(base.getAttribute('stroke'), 'rgba(255,255,255,.15)');
    const thr = svg.querySelector('line.ctx-thr')!;
    assert.equal(thr.getAttribute('stroke-dasharray'), '4 4');
    assert.match(thr.getAttribute('stroke')!, /^#(f87171|ef4444|fca5a5|dc2626)$/i);
    assert.equal(text(svg.querySelector('text.ctx-thr-label')), 'Auto-Compact 75 %');
    const higher = live(95);
    assert.ok(Number(svgOf(higher).querySelector('line.ctx-thr')!.getAttribute('y1')) < Number(thr.getAttribute('y1')), 'a higher threshold sits higher');
  });

  it('places the compact dot above the now dot and the threshold between the 90 % peak and the 60 % now value', () => {
    const svg = svgOf(live(75));
    const cdot = svg.querySelectorAll('circle.ctx-compact-dot');
    assert.equal(cdot.length, 1);
    assert.equal(cdot[0]!.getAttribute('r'), '4');
    assert.equal(text(svg.querySelector('text.ctx-compact-label')), 'compact');
    const now = svg.querySelectorAll('circle.ctx-now-dot');
    assert.equal(now.length, 1);
    assert.match(now[0]!.getAttribute('fill')!, /^#(fbbf24|f59e0b|fcd34d)$/i);
    const ty = Number(svg.querySelector('line.ctx-thr')!.getAttribute('y1'));
    assert.ok(Number(cdot[0]!.getAttribute('cy')) < ty, '90 % above the 75 % line');
    assert.ok(Number(now[0]!.getAttribute('cy')) > ty, '60 % below the 75 % line');
  });

  it('draws one 2px polyline per round in the role colour, later rounds lighter', () => {
    const lines = svgOf(live()).querySelectorAll('polyline');
    assert.equal(lines.length, 2);
    for (const l of lines) assert.equal(l.getAttribute('stroke-width'), '2');
    assert.equal(lines[0]!.getAttribute('stroke'), ROLE_COLORS.developer);
    assert.notEqual(lines[1]!.getAttribute('stroke'), lines[0]!.getAttribute('stroke'));
    assert.deepEqual(svgOf(live()).querySelectorAll('text.ctx-round-label').map(text), ['R1', 'R2']);
  });

  it('writes the caption "R1: <n> Auto-Compact bei <max> % · R2 jetzt <k> %, Trend <±n> %/min"', () => {
    const cap = text(live().$('ctx-caption'));
    assert.match(cap, /^R1: 1 Auto-Compact bei 90 % · R2 jetzt 60 %, Trend [+−-]\d+(\.\d+)? %\/min$/);
  });

  it('uses the plural "Auto-Compacts" for two compacts in round 1', () => {
    const two = [call(1, '11:05:00', 50000), call(2, '11:08:00', 92000), compact(3, '11:09:00'), call(4, '11:10:00', 30000), call(5, '11:12:00', 88000), compact(6, '11:13:00'), call(7, '11:15:00', 20000)];
    const cap = text(live(75, two).$('ctx-caption'));
    assert.match(cap, /^R1: 2 Auto-Compacts bei 92 %/);
    assert.equal(svgOf(live(75, two)).querySelectorAll('circle.ctx-compact-dot').length, 2);
  });

  it('shows "Kein Context-Verlauf verfügbar" and no SVG without context data', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail({ status: 'paused', running: null, sessions: [session('run-1', { transcript: null })] }), ctxEntries: [] }, opts);
    assert.equal(page.$('ctx-chart').querySelectorAll('svg').length, 0);
    assert.ok(text(page.$('ctx-history')).includes('Kein Context-Verlauf verfügbar'));
    assert.equal(page.query('#ctx-history svg').length, 0);
  });

  it('names the role with the most sessions in the title', () => {
    const many = [session('a', { role: 'tester' }), session('b', { role: 'tester', started_at: '2026-10-30T11:30:00Z' }), session('c')];
    const entries = [{ ts: '2026-10-30T11:20:00Z', event: 'run_finished', issue: ID, run: 'a', role: 'tester', context_peak_percent: '41', context_compacts: '0' }];
    const page = renderPage(AGENT_HTML, { detail: issueDetail({ status: 'paused', running: null, sessions: many }), ctxEntries: entries }, opts);
    assert.equal(text(page.$('ctx-history-title')), 'Context-Verlauf · Tester');
    assert.match(svgOf(page).getAttribute('aria-label')!, /^Context-Füllstand des Tester: /);
  });
});

describe('independent: panel Brain-Zugriffe (#387)', () => {
  const access = (i: number, over: Record<string, unknown> = {}) => ({ at: `2026-10-30T11:${String(50 - i).padStart(2, '0')}:00Z`, run: 'r', issue: ID, role: 'developer', op: 'read', path_or_query: `Notes/n${i}.md`, purpose: `Zweck ${i}`, result: 'ok', ...over });
  const fixture = (rows: unknown) => (url: string): unknown => {
    if (url.startsWith('/api/v1/brain/access?')) return rows;
    if (url.startsWith('/api/v1/changes?')) return { entries: [], counts: {}, next_before: null };
    if (url.endsWith('/team')) return scoreTeam();
    return issueDetail({ timeline_seq: 0 });
  };
  const load = async (rows: unknown, rowCount: number) => {
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture(rows) });
    await until(() => page.$('access-list').children.length >= Math.min(rowCount, 1) && !page.$('access-section').hidden, 3_000, 'access');
    return page;
  };

  it('limits to six rows and links "alle <n> →" to the brain page with the issue filter', async () => {
    const page = await load({ access: Array.from({ length: 7 }, (_, i) => access(i)), next_before: null }, 7);
    assert.equal(page.$('access-list').children.length, 6);
    const more = page.$('access-section').querySelectorAll('a').find((a) => /^alle \d+ →$/.test(text(a)))!;
    assert.ok(more, 'link alle <n> →');
    assert.equal(text(more), 'alle 7 →');
    assert.match(more.getAttribute('href')!, /^\/brain\?issue=/);
    assert.equal(decodeURIComponent(more.getAttribute('href')!.split('issue=')[1]!), ID);
  });

  it('has no "alle" link at exactly six rows and offers "Brain →" in the head', async () => {
    const page = await load({ access: Array.from({ length: 6 }, (_, i) => access(i)), next_before: null }, 6);
    assert.equal(page.$('access-list').children.length, 6);
    const links = page.$('access-section').querySelectorAll('a').filter((a) => !a.hidden && /^alle/.test(text(a)));
    assert.equal(links.length, 0);
    const head = page.$('access-section').querySelectorAll('a').find((a) => text(a) === 'Brain →')!;
    assert.ok(head);
    assert.match(head.getAttribute('href')!, /^\/brain/);
  });

  it('shows time, operation, note over purpose; data is inserted as text', async () => {
    const page = await load({ access: [access(0, { path_or_query: '<script>x</script>', purpose: '<i>Zweck</i>', op: 'search' })], next_before: null }, 1);
    const row = page.$('access-list').children[0]!;
    const t = text(row);
    assert.ok(t.includes('<script>x</script>'));
    assert.ok(t.includes('<i>Zweck</i>'));
    assert.match(t, /search/);
    assert.equal(page.$('access-section').querySelectorAll('script').length + page.$('access-section').querySelectorAll('i').length, 0);
  });

  it('colours read, write and search differently', async () => {
    const page = await load({ access: [access(0, { op: 'read' }), access(1, { op: 'write' }), access(2, { op: 'search' })], next_before: null }, 3);
    const ops = page.$('access-list').children.map((r) => r.querySelector('.acc-op')!.className);
    assert.equal(new Set(ops).size, 3, ops.join('|'));
  });

  it('says "Keine Brain-Zugriffe in diesem Issue" for a brain without accesses', async () => {
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture({ access: [], next_before: null }) });
    await until(() => !page.$('access-section').hidden, 3_000, 'panel');
    assert.ok(text(page.$('access-section')).includes('Keine Brain-Zugriffe in diesem Issue'));
  });

  it('hides the whole panel without a brain', async () => {
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture({ __status: 404, error: { code: 'brain_disabled' } }) });
    await until(() => page.fetches.some((f) => f.url.startsWith('/api/v1/brain/access?')), 3_000, 'call');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(page.$('access-section').hidden, true);
  });
});

describe('independent: panel Changes (#387)', () => {
  const load = async (entries: unknown[], detail: Record<string, unknown> = issueDetail({ timeline_seq: 0 })) => {
    const page = renderPage(AGENT_HTML, undefined, {
      ...opts,
      fetch: (url: string): unknown => {
        if (url.startsWith('/api/v1/changes?')) return { entries, counts: {}, next_before: null };
        if (url.startsWith('/api/v1/brain/access?')) return { access: [], next_before: null };
        if (url.endsWith('/team')) return scoreTeam();
        return detail;
      },
    });
    await until(() => page.fetches.some((f) => f.url.startsWith('/api/v1/changes?')), 3_000, 'changes call');
    await new Promise((r) => setTimeout(r, 30));
    return page;
  };

  it('links "Alle →" to /changes filtered by the issue', async () => {
    const page = await load([changeEntry()]);
    const all = page.$('changes-section').querySelectorAll('a').find((a) => text(a) === 'Alle →')!;
    assert.ok(all);
    assert.match(all.getAttribute('href')!, /^\/changes\?issue=/);
  });

  it('shows per file the path and +n / −m with the specified colours', async () => {
    const page = await load([changeEntry({ files: [{ path: 'src/deep/very/long/file.ts', added: 12, deleted: 4, status: 'modified' }] })]);
    const row = page.$('changes-list').children[0]!;
    assert.ok(text(row).includes('src/deep/very/long/file.ts'));
    const plus = row.descendants().find((d) => text(d) === '+12')!;
    const minus = row.descendants().find((d) => text(d) === '−4')!;
    assert.ok(plus && minus);
    assert.match(AGENT_HTML, /#6ee7b7/);
    assert.match(AGENT_HTML, /minmax\(0,\s*1fr\) 92px/);
  });

  it('keeps brain notes out of the file rows', async () => {
    const page = await load([brainChangeEntry(), changeEntry({ files: [{ path: 'src/only.ts', added: 1, deleted: 0, status: 'modified' }] })]);
    const rows = page.$('changes-list').children;
    assert.equal(rows.length, 1);
    assert.ok(text(rows[0]!).includes('src/only.ts'));
  });

  it('shows the PR footer card with number and open state plus the check status', async () => {
    const colours = new Map<string, string>();
    for (const [status, label] of [['pending', 'Checks laufen'], ['success', 'Checks grün'], ['failure', 'Checks rot']] as const) {
      const page = await load([changeEntry({ pr: { number: 12, status } })]);
      const card = page.$('changes-pr');
      assert.ok(card.classList.contains('gi'), 'footer card is a .gi');
      const t = text(card);
      assert.ok(t.includes('PR #12 · offen'), t);
      assert.ok(t.includes(label), `${status}: ${t}`);
      const el = card.descendants().find((d) => text(d).startsWith(label))!;
      colours.set(status, String(el.style.color));
    }
    assert.equal(new Set(colours.values()).size, 3, 'amber, green and red differ: ' + [...colours.values()].join());
    assert.ok([...colours.values()].every(Boolean));
  });

  it('says "noch keine PR" when the issue has no pull request', async () => {
    const page = await load([changeEntry({ pr: null })], issueDetail({ timeline_seq: 0, pull_request: null }));
    assert.ok(text(page.$('changes-pr')).includes('noch keine PR'));
  });
});

describe('independent: Details section and tab pill (#387)', () => {
  const sel = (page: Page) => page.query('#tabs button[role="tab"]').filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => text(t));
  const mk = (n: number) => Array.from({ length: n }, (_, i) => session('r' + i, { started_at: `2026-10-30T11:0${i}:00Z` }));

  it('is a glass section labelled Details with padding 14px 18px 18px and the tablist inside', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail() }, opts);
    const section = page.query('section[aria-label="Details"]')[0]!;
    assert.ok(section.classList.contains('g'));
    assert.ok(section.contains(page.$('tabs')));
    assert.ok(section.contains(page.$('timeline')));
    assert.ok(section.contains(page.$('runs')));
    assert.ok(section.contains(page.$('transcript')));
    assert.match(AGENT_HTML, /padding:\s*14px 18px 18px/);
    assert.match(AGENT_HTML, /rgba\(0,\s*0,\s*0,\s*\.25\)/);
    assert.match(AGENT_HTML, /rgba\(255,\s*255,\s*255,\s*\.12\)/);
  });

  it('labels the tabs and counts the sessions, also for zero and many', () => {
    for (const n of [0, 1, 5]) {
      const page = renderPage(AGENT_HTML, { detail: issueDetail({ status: 'paused', running: null, sessions: mk(n) }) }, opts);
      assert.deepEqual(page.query('#tabs button[role="tab"]').map((t) => text(t)), ['Execution-Trace', `Sessions (${n})`, 'Transkript'], String(n));
    }
  });

  it('selects the trace by default and each tab by click or by URL fragment', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail() }, opts);
    assert.deepEqual(sel(page), ['Execution-Trace']);
    page.click(page.query('#tabs button[role="tab"]').find((t) => text(t).startsWith('Sessions'))!);
    assert.match(sel(page)[0]!, /^Sessions/);
    assert.equal(page.location.hash, '#sessions');
    page.click(page.query('#tabs button[role="tab"]').find((t) => text(t) === 'Transkript')!);
    assert.equal(page.location.hash, '#transcript');
    for (const [hash, label] of [['#trace', 'Execution-Trace'], ['#sessions', 'Sessions (0)'], ['#transcript', 'Transkript']] as const) {
      const p = renderPage(AGENT_HTML, { detail: issueDetail({ status: 'paused', running: null, sessions: [] }) }, { url: opts.url + hash });
      assert.deepEqual(sel(p), [label], hash);
    }
  });

  it('switches without a new request and without leaving the page', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail() }, opts);
    const before = page.fetches.length;
    const path = page.location.pathname;
    for (const id of ['tab-sessions', 'tab-transcript', 'tab-trace']) page.click(page.$(id));
    assert.equal(page.location.pathname, path);
    assert.equal(page.location.search, new URL(opts.url).search);
    assert.ok(page.fetches.length - before <= 1, 'a tab change may fetch a transcript but not reload');
  });

  it('shows exactly one tab panel and keeps aria-selected and tabindex consistent', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail() }, opts);
    page.click(page.$('tab-sessions'));
    const tabs = page.query('#tabs button[role="tab"]');
    for (const t of tabs) assert.equal(t.getAttribute('tabindex'), t.getAttribute('aria-selected') === 'true' ? '0' : '-1');
    assert.deepEqual(['panel-trace', 'panel-sessions', 'panel-transcript'].map((id) => page.$(id).hidden), [true, false, true]);
  });

  it('supports arrow keys on the tablist', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail() }, opts);
    page.$('tabs').dispatch('keydown', { key: 'ArrowRight', target: page.$('tab-trace'), preventDefault() {} });
    assert.match(sel(page)[0]!, /^Sessions/);
  });
});

describe('independent: trace rows (#387)', () => {
  const sub = (offset: number, name: string, input: Record<string, unknown>) => ({
    type: 'model_call', offset, at: `2026-10-30T11:1${offset}:00Z`, message_id: `m${offset}`, model: 'claude-opus-5-5', usage: null, cost_usd: null, stop_reason: null, error: null, parent_tool_use_id: null,
    blocks: [{ type: 'tool_use', id: 't' + offset, name, input: JSON.stringify(input) }],
  });
  const entries = [
    sub(1, 'Bash', { command: 'npm test' }),
    sub(2, 'mcp__brain__brain_read', { path: 'Decisions/Rollen', purpose: 'Farben klären' }),
    sub(3, 'Agent', { subagent_type: 'Explore', description: 'liest src/a.ts', prompt: 'x' }),
  ];
  const render = () => {
    const sessions = [session('r1')];
    const tx = new Map([['r1', { available: true, entries, offset: 0, done: true, reason: null }]]);
    return renderPage(AGENT_HTML, { detail: issueDetail({ status: 'paused', running: null, sessions }), team: scoreTeam(), tx, events: [], dirty: true }, opts);
  };
  const rows = (page: Page, kind: string) => page.$('timeline').querySelectorAll('li.item.kind-' + kind);

  it('renders three cells per row: time, kind label, text', () => {
    const page = render();
    const items = page.$('timeline').querySelectorAll('li.item');
    assert.ok(items.length >= 3);
    const row = rows(page, 'tool')[0]!;
    assert.equal(text(row.querySelector('.kind')), 'TOOL');
    assert.ok(text(row.querySelector('.text')).startsWith('Bash'));
    assert.ok(text(row.querySelector('.text')).includes('npm test'));
    assert.match(text(row.querySelector('.when, time')), /\d/);
  });

  it('writes the BRAIN row as "brain_read <path> · Zweck: <purpose>"', () => {
    const [b] = rows(render(), 'brain');
    assert.equal(text(b!.querySelector('.kind')), 'BRAIN');
    assert.equal(text(b!.querySelector('.text')), 'brain_read Decisions/Rollen · Zweck: Farben klären');
  });

  it('writes the SUBAGENT row as "<Typ> gestartet: <Beschreibung>"', () => {
    const [s] = rows(render(), 'subagent');
    assert.equal(text(s!.querySelector('.kind')), 'SUBAGENT');
    assert.equal(text(s!.querySelector('.text')), 'Explore gestartet: liest src/a.ts');
  });

  it('colours the kinds TOOL sky, BRAIN amber, SUBAGENT #6ee7b7, MODEL violet, RESULT red and PHASE gray', () => {
    assert.equal(TRACE_COLORS.subagent, '#6ee7b7');
    const css = AGENT_HTML;
    for (const kind of ['tool', 'brain', 'subagent', 'model', 'result']) {
      assert.match(css, new RegExp(`\\.kind-${kind} \\.kind \\{ color: var\\(--trace-${kind}\\)`), kind);
      assert.ok(css.includes(`--trace-${kind}: ${TRACE_COLORS[kind as keyof typeof TRACE_COLORS]};`), `token ${kind}`);
    }
    assert.match(css, /\.kind-phase \.kind \{ color: var\(--gray\)/);
    const hues = Object.values(TRACE_COLORS);
    assert.equal(new Set(hues).size, hues.filter((h, i) => hues.indexOf(h) === i).length);
    assert.notEqual(TRACE_COLORS.tool, TRACE_COLORS.brain);
    assert.notEqual(TRACE_COLORS.model, TRACE_COLORS.result);
  });

  it('uses the specified row grid, mono text colour and wrapping', () => {
    assert.match(AGENT_HTML, /grid-template-columns:\s*76px 96px minmax\(0,\s*1fr\)/);
    assert.match(AGENT_HTML, /gap:\s*10px;\s*padding:\s*9px 4px/);
    assert.match(AGENT_HTML, /font-size:\s*13px;\s*align-items:\s*baseline/);
    assert.match(AGENT_HTML, /letter-spacing:\s*\.08em/);
    assert.match(AGENT_HTML, /#dbe3f0/);
    assert.match(AGENT_HTML, /overflow-wrap:\s*anywhere/);
  });
});

describe('independent: functions stay reachable inside the Details tabs (#387)', () => {
  it('keeps filter, search, expand/collapse and raw logs in the trace tab', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail() }, opts);
    const panel = page.$('panel-trace');
    for (const id of ['filters', 'expand-all', 'collapse-all', 'raw-toggle', 'rawlog', 'raw-list', 'timeline']) assert.ok(panel.contains(page.$(id)), id);
    assert.ok(panel.querySelectorAll('input[type="search"]').length >= 1);
  });

  it('keeps the session list in the sessions tab and the session choice in the transcript tab', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail({ status: 'paused', running: null, sessions: [session('r1'), session('r2')] }) }, opts);
    assert.ok(page.$('panel-sessions').contains(page.$('runs')));
    assert.ok(page.$('panel-transcript').contains(page.$('tx-run')));
    assert.equal(page.$('runs').children.length, 2);
  });

  it('toggles the raw logs with the button', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail() }, opts);
    assert.equal(page.$('rawlog').hidden, true);
    page.click(page.$('raw-toggle'));
    assert.equal(page.$('rawlog').hidden, false);
    assert.equal(page.$('raw-toggle').getAttribute('aria-expanded'), 'true');
  });

  it('offers Force and Resume for a paused issue only with controls allowed', () => {
    const paused = (controls: Record<string, unknown>) => issueDetail({ status: 'paused', running: null, paused: { source: 'operator', paused_at: '2026-10-30T11:50:00Z', continuations: 0 }, controls });
    const allowed = renderPage(AGENT_HTML, { detail: paused({ retry: true }) }, opts);
    assert.deepEqual(allowed.query('button.restart').map((b) => b.dataset.verb).filter((v, i, a) => a.indexOf(v) === i).sort(), ['Force', 'Resume']);
    const denied = renderPage(AGENT_HTML, { detail: paused({ retry: false }) }, opts);
    assert.equal(denied.query('button.restart').length, 0);
    const runDenied = renderPage(AGENT_HTML, { detail: issueDetail({ controls: { retry: false } }) }, opts);
    assert.equal(runDenied.query('button.restart').length, 0);
  });
});
