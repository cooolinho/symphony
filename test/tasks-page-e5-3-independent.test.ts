import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TASKS_CSS, TASKS_HTML } from '../src/http/tasks-page.ts';
import { CHIP_TONES, ROLE_COLORS } from '../src/http/ui/palette.ts';
import { renderPage } from './helpers.ts';
import { dashboardState, issueRow } from './helpers/page-fixtures.ts';

// E5-3 (#389), independent acceptance tests derived from the issue text only: title block, glass pill, six columns, cards.

type Obj = Record<string, any>;
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
const text = (n: { textContent: string }) => n.textContent;
const hm = (iso: string) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const UNTIL = '2026-10-30T15:45:00Z';
const hex = (v: unknown) => String(v).toLowerCase();

const base = dashboardState();
const withSlots = (total: number, running = 0, over: Obj = {}): Obj =>
  dashboardState({
    limits: { ...base.limits, max_concurrent_agents: { effective: total, workflow: 10, override: null }, max: 50 },
    counts: { ...base.counts, running, forced: 0 },
    ...over,
  });
const open = (state: Obj) => renderPage(TASKS_HTML, state, { fetch: (url) => (url.includes('/history/') ? { entries: [] } : state) });
const pillButtons = (p: ReturnType<typeof open>) => p.query('#task-pill button');
const byLabel = (p: ReturnType<typeof open>, l: string) => pillButtons(p).find((b) => b.getAttribute('aria-label') === l)!;
const isDisabled = (b: any) => b.disabled === true || b.hasAttribute?.('disabled') === true;

const row = (n: number, over: Obj = {}): Obj => issueRow({ issue_id: String(n), issue_identifier: `org/repo#${n}`, title: `Task ${n}`, repo: 'org/repo', ...over });
const queued = (n: number, section: string, code: string, over: Obj = {}): Obj =>
  row(n, { section, status: section === 'paused' ? 'paused' : 'queued', running: null, stages: [], reason: { code, text: `en-${code}` }, ...over });

describe('E5-3 independent: title block', () => {
  it('h1 "Tasks" with the subtitle, no old meta line', () => {
    assert.match(TASKS_HTML, /<h1>\s*Tasks\s*<\/h1>/);
    assert.ok(TASKS_HTML.includes('Was läuft, was als Nächstes startet und warum ein Issue wartet'));
    assert.ok(!TASKS_HTML.includes('Slot frei in'));
  });
});

describe('E5-3 independent: glass pill', () => {
  it('is a .g element with label "Agent-Slots" and styles from the mockup', () => {
    const p = open(withSlots(3, 1));
    const pill = p.$('task-pill');
    assert.ok(pill.classList.contains('g'));
    assert.match(text(pill), /Agent-Slots/);
    const css = (sel: string) => TASKS_CSS.match(new RegExp(`${sel.replace(/\./g, '\\.')} \\{([^}]*)\\}`))![1]!;
    const pillCss = css('.task-pill');
    assert.match(pillCss, /border-radius: 999px/);
    assert.match(pillCss, /padding: 8px 12px/);
    assert.match(pillCss, /gap: 10px 16px/);
    assert.match(pillCss, /flex-wrap: wrap/);
    assert.match(css('.task-slot-count'), /18px/);
    assert.match(css('.task-slot-count'), /min-width: 44px/);
    assert.match(css('.task-slot-count'), /text-align: center/);
    assert.match(css('.task-pill-label'), /13px/);
    assert.match(css('.task-pill-label'), /--fg-2/);
  });

  it('shows "<occupied> / <total>" with aria-live=polite between the − and + buttons', () => {
    const p = open(withSlots(4, 2));
    const count = [...p.query('#task-pill [aria-live]')];
    assert.equal(count.length, 1);
    assert.equal(count[0]!.getAttribute('aria-live'), 'polite');
    assert.equal(text(count[0]!), '2 / 4');
    const order = p.query('#task-pill button, #task-pill [aria-live]');
    assert.equal(order.length, 3);
    assert.equal(order[0]!.getAttribute('aria-label'), 'Einen Slot weniger');
    assert.equal(order[1], count[0]);
    assert.equal(order[2]!.getAttribute('aria-label'), 'Einen Slot mehr');
    assert.equal(text(order[0]!), '−');
    assert.equal(text(order[2]!), '+');
  });

  it('bounds 1..8: − disabled at 1, + disabled at 8, both enabled in between', () => {
    for (const [total, dec, inc] of [[1, true, false], [2, false, false], [7, false, false], [8, false, true]] as const) {
      const p = open(withSlots(total));
      assert.equal(isDisabled(byLabel(p, 'Einen Slot weniger')), dec, `− at ${total}`);
      assert.equal(isDisabled(byLabel(p, 'Einen Slot mehr')), inc, `+ at ${total}`);
    }
  });

  it('a click on + / − sends PUT /api/v1/settings/agents with the new total', async () => {
    const p = open(withSlots(5));
    p.click(byLabel(p, 'Einen Slot mehr'));
    await settle();
    let put = p.fetches.filter((f) => f.method === 'PUT').at(-1)!;
    assert.equal(put.url, '/api/v1/settings/agents');
    assert.deepEqual(put.body, { max_concurrent_agents: 6 });
    const q = open(withSlots(5));
    q.click(byLabel(q, 'Einen Slot weniger'));
    await settle();
    put = q.fetches.filter((f) => f.method === 'PUT').at(-1)!;
    assert.deepEqual(put.body, { max_concurrent_agents: 4 });
  });

  it('a disabled button at the bound sends nothing', async () => {
    const p = open(withSlots(1));
    p.click(byLabel(p, 'Einen Slot weniger'));
    await settle();
    assert.equal(p.fetches.filter((f) => f.method === 'PUT').length, 0);
    const q = open(withSlots(8));
    q.click(byLabel(q, 'Einen Slot mehr'));
    await settle();
    assert.equal(q.fetches.filter((f) => f.method === 'PUT').length, 0);
  });

  it('chips: one amber chip per model hold and one green chip with the active models joined by " · "', () => {
    const s = withSlots(3, 1, {
      model_holds: [{ model: 'opus', source: 'limit', since: '2026-10-30T11:00:00Z', until: UNTIL, text: 'x', issue_identifier: 'org/repo#1', repo: 'org/repo' }],
      model_controls: [
        { model: 'opus', paused: false, paused_since: null, limit_until: UNTIL },
        { model: 'sonnet', paused: false, paused_since: null, limit_until: null },
        { model: 'haiku', paused: false, paused_since: null, limit_until: null },
      ],
    });
    const p = open(s);
    const chips = p.query('#task-pill .ui-chip');
    assert.equal(chips.length, 2);
    assert.equal(text(chips[0]!), `Opus pausiert · Limit bis ${hm(UNTIL)}`);
    assert.equal(hex(chips[0]!.style.color), hex(CHIP_TONES.amber.text));
    assert.equal(text(chips[1]!), 'Sonnet · Haiku aktiv');
    assert.equal(hex(chips[1]!.style.color), hex(CHIP_TONES.green.text));
  });

  it('without holds only the green chip', () => {
    const p = open(withSlots(3, 0, { model_controls: [{ model: 'sonnet', paused: false, paused_since: null, limit_until: null }] }));
    const chips = p.query('#task-pill .ui-chip');
    assert.equal(chips.length, 1);
    assert.equal(text(chips[0]!), 'Sonnet aktiv');
    assert.equal(hex(chips[0]!.style.color), hex(CHIP_TONES.green.text));
  });

  it('two holds give two amber chips; the chips follow a refresh', () => {
    const hold = (model: string) => ({ model, source: 'limit', since: '2026-10-30T11:00:00Z', until: UNTIL, text: 'x', issue_identifier: null, repo: 'org/repo' });
    const p = open(withSlots(3));
    p.render(withSlots(3, 0, { model_holds: [hold('opus'), hold('sonnet')] }));
    assert.deepEqual(p.query('#task-pill .ui-chip').map(text), [`Opus pausiert · Limit bis ${hm(UNTIL)}`, `Sonnet pausiert · Limit bis ${hm(UNTIL)}`]);
    p.render(withSlots(3));
    assert.equal(p.query('#task-pill .ui-chip').length, 0);
  });

  it('without controlAllowed the pill is display only: no buttons, count and chips stay', () => {
    const s = withSlots(3, 1, { controls: { retry: false }, model_controls: [{ model: 'sonnet', paused: false, paused_since: null, limit_until: null }] });
    const p = open(s);
    assert.equal(pillButtons(p).length, 0);
    assert.equal(text(p.$('task-slot-count')), '1 / 3');
    assert.equal(p.query('#task-pill .ui-chip').length, 1);
    assert.equal(p.query('button').length, 0, 'no button anywhere on the page');
    // control comes back on the next state
    p.render(withSlots(3, 1));
    assert.equal(pillButtons(p).length, 2);
  });
});

describe('E5-3 independent: columns', () => {
  const sections = (p: ReturnType<typeof open>) => p.query('section.g');
  it('six <section class="g"> in order with aria-label, dot colour and counter', () => {
    const p = open(dashboardState());
    const cols = sections(p);
    assert.deepEqual(cols.map((c) => c.getAttribute('aria-label')), ['Läuft', 'Als Nächstes', 'Wartet', 'Pausiert', 'Blockiert', 'Kürzlich erledigt']);
    const colours = cols.map((c) => /--col:\s*(#[0-9a-fA-F]{6})/.exec(c.getAttribute('style') ?? '')?.[1]?.toLowerCase());
    assert.deepEqual(colours, ['#34d399', '#7dd3fc', '#fbbf24', '#fbbf24', '#f87171', '#c4b5fd']);
    for (const c of cols) assert.equal(c.querySelectorAll('.task-count').length, 1);
  });

  it('grid and column CSS follow the mockup values', () => {
    const css = (sel: string) => TASKS_CSS.match(new RegExp(`${sel.replace(/\./g, '\\.')} \\{([^}]*)\\}`))![1]!;
    assert.match(css('.tasks-grid'), /repeat\(auto-fit, minmax\(230px, 1fr\)\)/);
    assert.match(css('.tasks-grid'), /gap: 14px/);
    assert.match(css('.tasks-grid'), /align-items: start/);
    assert.match(css('.task-col'), /padding: 14px/);
    assert.match(css('.task-col'), /gap: 10px/);
    assert.match(css('.task-count'), /12px/);
    assert.match(css('.task-count'), /--mono/);
    assert.match(css('.task-count'), /--fg-3/);
    assert.match(css('.task-empty'), /12\.5px/);
    assert.match(css('.task-empty'), /--fg-3/);
    assert.match(css('.tasks-grid .card:hover'), /rgba\(255, 255, 255, \.18\)/);
    assert.match(css('.tasks-grid .card'), /padding: 12px/);
    assert.match(css('.tasks-grid .card'), /gap: 8px/);
    assert.match(css('.task-reason'), /padding: 5px 10px/);
    assert.match(css('.task-reason'), /border-radius: 10px/);
    assert.match(css('.task-reason'), /align-self: flex-start/);
  });

  it('empty columns stay visible with the empty text in the specified wording', async () => {
    const p = open(dashboardState({ counts: { ...base.counts, running: 0 } }));
    await settle();
    const empties = sections(p).map((c) => c.querySelectorAll('.task-empty').map(text));
    assert.deepEqual(empties, [['Nichts läuft'], ['Nichts in der Warteschlange'], ['Nichts wartet'], ['Nichts pausiert'], ['Nichts blockiert'], ['Noch nichts erledigt']]);
    assert.deepEqual(sections(p).map((c) => text(c.querySelector('.task-count')!)), ['00', '00', '00', '00', '00', '00']);
    assert.equal(p.query('article').length, 0);
  });

  it('a column with cards loses its empty text; counters match the card number', () => {
    const s = dashboardState({
      issues: [row(1), queued(2, 'next', 'ready', { position: 1 }), queued(3, 'next', 'ready', { position: 2 }), queued(4, 'paused', 'paused', { paused: { source: 'operator' } })],
    });
    const p = open(s);
    const [run, next, wait, paused] = sections(p);
    assert.equal(run!.querySelectorAll('article').length, 1);
    assert.equal(next!.querySelectorAll('article').length, 2);
    assert.equal(text(next!.querySelector('.task-count')!).replace(/^0/, ''), '2');
    assert.equal(wait!.querySelectorAll('article').length, 0);
    assert.equal(paused!.querySelectorAll('article').length, 1);
    assert.equal(run!.querySelectorAll('.task-empty').length, 0);
    assert.equal(wait!.querySelectorAll('.task-empty').length, 1);
  });
});

describe('E5-3 independent: cards', () => {
  it('article.gi.card: number, P label, title link to /issue?id=, repo, reason chip, owner', () => {
    const p = open(dashboardState({ issues: [queued(12, 'next', 'ready', { position: 1, priority: 1, title: 'Hallo Welt' })] }));
    const card = p.query('article')[0]!;
    assert.ok(card.classList.contains('gi') && card.classList.contains('card'));
    assert.equal(card.textContent.includes('#12'), true);
    assert.ok(/P1 · Platz 1/.test(card.textContent));
    const link = card.querySelectorAll('a')[0]!;
    assert.equal(link.getAttribute('href'), '/issue?id=' + encodeURIComponent('org/repo#12'));
    assert.equal(text(link), 'Hallo Welt');
    assert.ok(card.textContent.includes('org/repo'));
    assert.ok(card.textContent.includes('Startet, sobald ein Slot frei ist'));
  });

  it('priority label only in the form "P<n>"; none when the issue has no priority', () => {
    const p = open(dashboardState({ issues: [row(1, { priority: 3 }), queued(2, 'paused', 'paused', { priority: null, paused: { source: 'operator' } })] }));
    const [a, b] = p.query('article');
    assert.ok(/P3/.test(a!.textContent));
    assert.ok(!/P\d/.test(b!.textContent), b!.textContent);
  });

  it('"Platz n" only in Als Nächstes, ranked by position', () => {
    const p = open(dashboardState({ issues: [queued(2, 'next', 'ready', { position: 2, priority: 2 }), queued(1, 'next', 'ready', { position: 1, priority: 1 }), row(3, { priority: 1 })] }));
    const cards = p.query('section.g')[1]!.querySelectorAll('article');
    assert.ok(cards[0]!.textContent.includes('#1') && cards[0]!.textContent.includes('P1 · Platz 1'));
    assert.ok(cards[1]!.textContent.includes('#2') && cards[1]!.textContent.includes('P2 · Platz 2'));
    assert.ok(!p.query('section.g')[0]!.querySelectorAll('article')[0]!.textContent.includes('Platz'));
  });

  it('Running reason: "<Rolle> <spielt|prüft|liest> · Runde <n> · <Dauer>"', () => {
    const run = (n: number, role: string, rounds: number) => {
      const r = row(n, { review_rounds: rounds });
      return { ...r, running: { ...r.running, issue_identifier: `org/repo#${n}`, role, seconds_running: 75 } };
    };
    const p = open(dashboardState({ issues: [run(1, 'developer', 0), run(2, 'reviewer', 2), run(3, 'analyst', 0)] }));
    const reasons = p.query('section.g')[0]!.querySelectorAll('.task-reason').map(text);
    assert.match(reasons[0]!, /^Developer spielt · Runde 1 · 1m 15s$/);
    assert.match(reasons[1]!, /^Reviewer prüft · Runde 3 · 1m 15s$/);
    assert.match(reasons[2]!, /^Analyst liest · Runde 1 · /);
  });

  it('Wartet reasons: model limit, retry with reason code, blocker merge', () => {
    const s = dashboardState({
      issues: [
        queued(1, 'next', 'model_hold', { position: 1, model_hold: { model: 'opus', source: 'limit', until: UNTIL } }),
        queued(2, 'waiting', 'backoff', { retry: { attempt: 1, due_in_ms: 5 * 60_000, due_at: UNTIL, kind: 'failure', limit: null } }),
        queued(3, 'next', 'waiting_for_sub_issues', { position: 2 }),
      ],
    });
    const p = open(s);
    const reasons = p.query('section.g')[2]!.querySelectorAll('.task-reason').map(text);
    assert.ok(reasons.includes(`Modell-Limit: Opus pausiert bis ${hm(UNTIL)}`), reasons.join('|'));
    assert.ok(reasons.includes('Retry in 5 min · backoff'), reasons.join('|'));
    assert.ok(reasons.includes('Wartet auf Blocker-Merge'), reasons.join('|'));
    assert.equal(p.query('section.g')[1]!.querySelectorAll('article').length, 0, 'those rows are not in Als Nächstes');
  });

  it('Als Nächstes: slot text, and "Wartet auf Slot in <Spalte>" for a column limit', () => {
    const p = open(dashboardState({ issues: [queued(1, 'next', 'ready', { position: 1 }), queued(2, 'next', 'column_limit', { position: 2, state: 'In review' })] }));
    const reasons = p.query('section.g')[1]!.querySelectorAll('.task-reason').map(text);
    assert.deepEqual(reasons, ['Startet, sobald ein Slot frei ist', 'Wartet auf Slot in In review']);
  });

  it('Pausiert reasons: operator pause and needs-human', () => {
    const p = open(dashboardState({
      issues: [
        queued(1, 'paused', 'paused', { paused: { source: 'operator' } }),
        queued(2, 'paused', 'paused', { paused: { source: 'operator' }, labels: ['needs-human'], review_rounds: 4 }),
      ],
    }));
    assert.deepEqual(p.query('section.g')[3]!.querySelectorAll('.task-reason').map(text), ['Von dir pausiert', 'needs-human nach 4 Review-Runden']);
  });

  it('Blockiert: "Blocked by #n[, #m] (<Kurztitel des ersten>)"', () => {
    const s = dashboardState({
      issues: [queued(7, 'next', 'ready', { position: 1, title: 'Erster Blocker' })],
      blocked: [
        { issue_id: '20', issue_identifier: 'org/repo#20', title: 'B', repo: 'org/repo', state: 'Todo', reason: 'x', reason_code: 'blocked', blocked_by: [{ id: '7', identifier: 'org/repo#7', state: 'Todo' }] },
        { issue_id: '21', issue_identifier: 'org/repo#21', title: 'C', repo: 'org/repo', state: 'Todo', reason: 'x', reason_code: 'blocked', blocked_by: [{ id: '7', identifier: 'org/repo#7', state: 'Todo' }, { id: '8', identifier: 'org/repo#8', state: 'Todo' }] },
      ],
    });
    const p = open(s);
    assert.deepEqual(p.query('section.g')[4]!.querySelectorAll('.task-reason').map(text), ['Blocked by #7 (Erster Blocker)', 'Blocked by #7, #8 (Erster Blocker)']);
  });

  it('owner: Mensch #e8eef9 and Symphony #94a3b8 with the dot colour', () => {
    const s = dashboardState({
      issues: [queued(1, 'paused', 'paused', { paused: { source: 'operator' } })],
      blocked: [{ issue_id: '20', issue_identifier: 'org/repo#20', title: 'B', repo: 'org/repo', state: 'Todo', reason: 'x', reason_code: 'blocked', blocked_by: [{ id: '7', identifier: 'org/repo#7', state: 'Todo' }] }],
    });
    const p = open(s);
    const paused = p.query('section.g')[3]!.querySelectorAll('article')[0]!;
    const blocked = p.query('section.g')[4]!.querySelectorAll('article')[0]!;
    assert.ok(paused.textContent.includes('Mensch'));
    assert.ok(blocked.textContent.includes('Symphony'));
    const dotColour = (a: any) => a.querySelectorAll('span').map((s: any) => hex(s.style.background)).filter(Boolean);
    assert.ok(dotColour(paused).includes(ROLE_COLORS.human), dotColour(paused).join());
    assert.ok(dotColour(blocked).includes(ROLE_COLORS.symphony), dotColour(blocked).join());
  });

  it('actions: pause / start (place 1 only) / retry (retry only) / resume, none for blocked and done; POST to the existing routes', async () => {
    const r = row(1);
    const s = dashboardState({
      issues: [
        { ...r, running: { ...r.running, issue_identifier: 'org/repo#1', role: 'developer' } },
        queued(2, 'next', 'ready', { position: 1 }),
        queued(3, 'next', 'ready', { position: 2 }),
        queued(4, 'waiting', 'backoff', { retry: { attempt: 1, due_in_ms: 60_000, due_at: UNTIL, kind: 'failure', limit: null } }),
        queued(5, 'waiting', 'waiting_for_sub_issues'),
        queued(6, 'paused', 'paused', { paused: { source: 'operator' } }),
      ],
      blocked: [{ issue_id: '20', issue_identifier: 'org/repo#20', title: 'B', repo: 'org/repo', state: 'Todo', reason: 'x', reason_code: 'blocked', blocked_by: [{ id: '2', identifier: 'org/repo#2', state: 'Todo' }] }],
    });
    const p = renderPage(TASKS_HTML, s, { fetch: (url) => (url.includes('event=run_finished') ? { entries: [{ ts: '2026-10-30T10:00:00Z', event: 'run_finished', issue: 'org/repo#99', title: 'Fertig', repo: 'org/repo', state: 'Done', outcome: 'handed_off', cost_usd: '1', agent_seconds: '10' }] } : url.includes('/history/') ? { entries: [] } : s) });
    await settle();
    p.render(s);
    const btn = (i: number) => p.query('section.g')[i]!.querySelectorAll('button').map(text);
    assert.deepEqual(btn(0), ['Pausieren']);
    assert.deepEqual(btn(1), ['Jetzt starten']);
    assert.deepEqual(btn(2), ['Jetzt erneut']);
    assert.deepEqual(btn(3), ['Fortsetzen']);
    assert.deepEqual(btn(4), []);
    assert.deepEqual(btn(5), []);
    assert.equal(p.query('section.g')[5]!.querySelectorAll('article').length, 1, 'the finished card is there');
    const post = async (i: number) => { p.click(p.query('section.g')[i]!.querySelectorAll('button')[0]!); await settle(); return p.fetches.filter((f) => f.method === 'POST').at(-1)!.url; };
    assert.equal(await post(0), '/api/v1/org%2Frepo%231/pause');
    assert.equal(await post(1), '/api/v1/org%2Frepo%232/force');
    assert.equal(await post(2), '/api/v1/org%2Frepo%234/retry');
    assert.equal(await post(3), '/api/v1/org%2Frepo%236/resume');
  });

  it('without controlAllowed no button in any column, cards stay', () => {
    const s = dashboardState({ controls: { retry: false }, issues: [row(1), queued(2, 'next', 'ready', { position: 1 }), queued(3, 'paused', 'paused', { paused: { source: 'operator' } })] });
    const p = open(s);
    assert.equal(p.query('button').length, 0);
    assert.equal(p.query('article').length, 3);
  });

  it('Kürzlich erledigt: last 10 from the history with "gemerged <HH:MM>" and "<n> Review-Runde(n) · $<Kosten> · <Dauer>"', async () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      ts: `2026-10-30T09:${String(10 + i).padStart(2, '0')}:00Z`, event: 'run_finished', issue: `org/repo#${300 + i}`, title: `Done ${i}`, repo: 'org/repo', state: 'Done',
      outcome: 'handed_off', cost_usd: '0.50', agent_seconds: '120', role: 'reviewer',
    }));
    const results = [{ issue: 'org/repo#311', kind: 'review', verdict: 'approved' }];
    const p = renderPage(TASKS_HTML, dashboardState(), { fetch: (url) => (url.includes('event=run_finished') ? { entries } : url.includes('event=stage_result') ? { entries: results } : dashboardState()) });
    await settle();
    const cards = p.query('section.g')[5]!.querySelectorAll('article');
    assert.equal(cards.length, 10);
    assert.equal(text(p.query('section.g')[5]!.querySelector('.task-count')!), '10');
    const newest = cards[0]!;
    assert.ok(newest.textContent.includes('#311'), 'newest first');
    assert.ok(/gemerged \d{2}:\d{2}/.test(newest.textContent), newest.textContent);
    assert.ok(newest.textContent.includes('1 Review-Runde · $0.50 · 2m 0s'), newest.textContent);
    assert.ok(cards[1]!.textContent.includes('0 Review-Runden'), cards[1]!.textContent);
    assert.equal(newest.querySelectorAll('a')[0]!.getAttribute('href'), '/issue?id=' + encodeURIComponent('org/repo#311'));
    assert.equal(newest.querySelectorAll('button').length, 0);
  });

  it('shows no slot forecast anywhere', () => {
    const p = open(dashboardState({ issues: [queued(1, 'next', 'ready', { position: 1 }), queued(2, 'next', 'column_limit', { position: 2 })] }));
    assert.ok(!/Slot frei in|ca\. \d+ min/.test(p.root.textContent));
  });

  it('every PlanReasonCode renders a card with a non-empty German reason (no raw server text)', () => {
    const codes = ['ready', 'no_free_slot', 'column_limit', 'reserved_for_role', 'backoff', 'session_limit', 'model_hold', 'waiting_for_sub_issues', 'inactive', 'paused', 'blocked', 'missing_label'];
    for (const code of codes) {
      for (const section of ['next', 'waiting']) {
        const p = open(dashboardState({ issues: [queued(1, section, code, { position: 1 })] }));
        const reason = p.query('article .task-reason');
        assert.equal(reason.length, 1, `${section}/${code}`);
        assert.ok(text(reason[0]!).trim().length > 3, `${section}/${code}`);
        assert.ok(!text(reason[0]!).includes('en-'), `${section}/${code}: ${text(reason[0]!)}`);
      }
    }
  });
});
