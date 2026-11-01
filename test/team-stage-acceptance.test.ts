import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/issue-page.ts';
import { renderPage, until } from './helpers.ts';
import { issueDetail } from './helpers/page-fixtures.ts';

// Independent acceptance tests for E3-3 (#356): the stage of the team view. The fixture is built here from the
// documented /team shape (seats, active, subagents), not taken from the developer's helper. Adapted to the mockup
// layout of E3-6 (#385): stage title with the issue number, .floor edge, #stage-spot spotlight, tool-name trace
// chips, Auto-Compact mark instead of compact strokes, subagent avatars with a pulse ring.

const URL_ = 'http://127.0.0.1/issue?id=acme%2Fapp%231';
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const seat = (role: string, status: string, verdict: string | null = null, duration_ms: number | null = null, model: string | null = null): Obj => ({ role, status, verdict, duration_ms, model });
const tool = (n: string): Obj => ({ tool: n, message: `${n} call`, at: '2026-10-30T11:59:00.000Z' });
const sub = (type: string, description: string, status: string, started: string, ended: string | null, total: number): Obj => ({
  tool_use_id: `${type}-${started}`, subagent_type: type, description, status, started_at: started, ended_at: ended,
  tokens: { input_tokens: total, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: total },
});

function team(over: Obj = {}): Obj {
  return {
    seats: [
      seat('analyst', 'done', 'ready', 61_000, 'haiku'),
      seat('developer', 'playing', null, 90_000, 'opus'),
      seat('tester', 'returned', 'failed', 125_000, 'sonnet'),
      seat('docs', 'skipped'),
      seat('reviewer', 'waiting'),
      seat('you', 'waiting'),
    ],
    active: {
      role: 'developer', action: 'Reading the file', recent_tools: ['t1', 't2', 't3', 't4', 't5', 't6'].map(tool),
      context: { tokens: 84_000, window: 200_000, percent: 42, compacts: 3 }, turn: 17, model: 'opus',
      tokens: { input_tokens: 500_000, output_tokens: 250_000, total_tokens: 750_000 }, cost_usd: 2.5,
    },
    subagents: {
      running: [sub('Explore', 'Look around', 'running', '2026-10-30T11:58:00.000Z', null, 5_000)],
      finished: [sub('Plan', 'Draft', 'done', '2026-10-30T11:50:00.000Z', '2026-10-30T11:52:00.000Z', 7_000)],
    },
    blocks: [],
    handoffs: [],
    ...over,
  };
}
const IDLE = { active: null, subagents: { running: [], finished: [] } };
const page = (t?: Obj) => renderPage(AGENT_HTML, { detail: issueDetail(), ...(t ? { team: t } : {}) }, { url: URL_ });
const seatOf = (p: ReturnType<typeof page>, role: string) => p.query('#stage-seats .stage-seat').find((li) => li.getAttribute('data-role') === role)!;
const txt = (p: ReturnType<typeof page>, id: string) => p.$(id).textContent ?? '';

describe('E3-3 stage: seats', () => {
  it('has a "Bühne" section above Pipeline, with a stage edge line', () => {
    const p = page(team());
    assert.equal(p.$('stage').hidden, false);
    assert.equal(p.$('stage-title').textContent, 'Bühne · das Team von #1');
    const html = AGENT_HTML;
    assert.ok(html.indexOf('id="stage"') < html.indexOf('id="pipe-section"'), 'stage comes before the pipeline section');
    assert.ok(html.indexOf('id="stage"') > html.indexOf('id="hero"'), 'stage comes after the hero');
    // The stage edge is drawn as a 2px line behind the seats.
    assert.match(html, /\.floor\s*\{[^}]*height:\s*2px/);
  });

  it('keeps the API order and puts "Du" last', () => {
    const t = team();
    const p = page(t);
    assert.deepEqual(p.query('#stage-seats .stage-seat').map((li) => li.getAttribute('data-role')), t.seats.map((s: Obj) => s.role));
    assert.equal(p.query('#stage-seats .stage-seat').at(-1)!.querySelector('.stage-name')!.textContent, 'Du');
  });

  it('does not reorder the seats the API sends', () => {
    const t = team({ seats: [seat('reviewer', 'done'), seat('analyst', 'done'), seat('you', 'waiting')] });
    assert.deepEqual(page(t).query('#stage-seats .stage-seat').map((li) => li.getAttribute('data-role')), ['reviewer', 'analyst', 'you']);
  });

  it('renders one avatar per seat, the active one as its context ring', () => {
    const p = page(team());
    assert.equal(p.query('#stage-seats .stage-seat').length, 6);
    for (const li of p.query('#stage-seats .stage-seat')) {
      const active = li.className.includes('is-active');
      assert.equal(li.querySelectorAll(active ? '.ui-ring' : '.ui-av').length, 1, li.getAttribute('data-role') ?? '');
    }
  });

  it('shows a check for done, a red cross for returned, none for waiting/skipped', () => {
    const p = page(team());
    assert.ok(seatOf(p, 'analyst').querySelector('.ui-av-badge'));
    assert.equal(seatOf(p, 'analyst').querySelector('.ui-av-badge.is-x'), null);
    assert.ok(seatOf(p, 'tester').querySelector('.ui-av-badge.is-x'));
    assert.equal(seatOf(p, 'reviewer').querySelector('.ui-av-badge'), null);
    assert.equal(seatOf(p, 'docs').querySelector('.ui-av-badge'), null);
  });

  it('draws waiting dashed and skipped greyed out', () => {
    const p = page(team());
    assert.ok(seatOf(p, 'reviewer').querySelector('.ui-av.is-waiting'));
    assert.ok(seatOf(p, 'docs').querySelector('.ui-av.is-skipped') || /is-skipped/.test(seatOf(p, 'docs').className));
    assert.match(AGENT_HTML, /\.ui-av\.is-waiting\s*\{[^}]*dashed/);
    assert.match(AGENT_HTML, /\.stage-seat\.is-skipped \.ui-av\s*\{[^}]*dashed #5b6678/);
  });

  it('puts role, verdict, duration and model into the title; missing values are "—"', () => {
    const p = page(team());
    const title = seatOf(p, 'analyst').getAttribute('title')!;
    for (const part of ['Analyst', 'ready', '1m 1s', 'haiku']) assert.ok(title.includes(part), `${part} in "${title}"`);
    const tester = seatOf(p, 'tester').getAttribute('title')!;
    for (const part of ['failed', '2m 5s', 'sonnet']) assert.ok(tester.includes(part), `${part} in "${tester}"`);
    const docs = seatOf(p, 'docs').getAttribute('title')!;
    assert.ok((docs.match(/—/g) ?? []).length >= 3, `three placeholders in "${docs}"`);
    assert.ok(seatOf(p, 'you').getAttribute('title')!.includes('Du'));
  });

  it('keeps no seat list without a /team answer and with a malformed one', () => {
    assert.equal(page().$('stage').hidden, true);
    assert.equal(page({ nonsense: true }).$('stage').hidden, true);
  });
});

describe('E3-3 stage: active seat', () => {
  it('has exactly one active seat with one pulse ring, one equalizer and one 42 % context ring', () => {
    const p = page(team());
    assert.equal(p.query('#stage-seats li.is-active').length, 1);
    assert.equal(seatOf(p, 'developer').className.includes('is-active'), true);
    assert.equal(p.query('#stage-seats .ring').length, 1);
    assert.equal(p.query('#stage .eq').length, 1);
    assert.equal(seatOf(p, 'developer').querySelectorAll('.ring').length, 1);
    assert.equal(p.query('#stage .ui-ring').length, 1);
    assert.equal(p.query('#stage .ui-ring-pct')[0]!.textContent, '42%');
    assert.ok(seatOf(p, 'developer').querySelector('.ui-ring'));
  });

  it('is larger than the other seats (96 px ring around a 64 px avatar)', () => {
    const p = page(team());
    assert.match(AGENT_HTML, /\.stage-gauge\s*\{[^}]*width:\s*96px[^}]*height:\s*96px/);
    const ringEl = seatOf(p, 'developer').querySelector('.ui-ring')!;
    assert.match(`${ringEl.style.width ?? ''}${ringEl.getAttribute('style') ?? ''}`, /96/);
    for (const li of p.query('#stage-seats .stage-seat').filter((x) => !x.className.includes('is-active'))) assert.equal(li.querySelector('.ui-ring'), null);
  });

  it('has a soft spotlight made of a radial-gradient', () => {
    assert.match(String(page(team()).$('stage-spot').style.background), /^radial-gradient\(/);
  });

  it('shows "—" for an unknown context percent and rounds fractions', () => {
    const t = team();
    t.active.context.percent = null;
    assert.equal(page(t).query('#stage .ui-ring-pct')[0]!.textContent, '—');
    const f = team();
    f.active.context.percent = 41.6;
    assert.equal(page(f).query('#stage .ui-ring-pct')[0]!.textContent, '42%');
    const z = team();
    z.active.context.percent = 0;
    assert.equal(page(z).query('#stage .ui-ring-pct')[0]!.textContent, '0%');
  });

  it('never animates a second seat even if the API reports two as playing', () => {
    const t = team();
    t.seats[2].status = 'playing';
    const p = page(t);
    assert.equal(p.query('#stage-seats .ring').length, 1);
    assert.equal(p.query('#stage .eq').length, 1);
    assert.equal(p.query('#stage-seats li.is-active').length, 1);
  });

  it('moves ring and pulse when a later render changes the context and the active role', () => {
    const p = page(team());
    const t2 = team();
    t2.active.context.percent = 77;
    p.render({ detail: issueDetail(), team: t2 });
    assert.equal(p.query('#stage .ui-ring').length, 1);
    assert.equal(p.query('#stage .ui-ring-pct')[0]!.textContent, '77%');
    const t3 = team();
    t3.seats[1].status = 'done';
    t3.seats[4].status = 'playing';
    t3.active.role = 'reviewer';
    p.render({ detail: issueDetail(), team: t3 });
    assert.equal(p.query('#stage-seats li.is-active').length, 1);
    assert.ok(seatOf(p, 'reviewer').className.includes('is-active'));
    assert.equal(seatOf(p, 'developer').querySelector('.ring'), null);
    assert.equal(p.query('#stage-seats .ring').length, 1);
  });
});

describe('E3-3 stage: fields', () => {
  it('"Jetzt" shows the newest call as the action and the last four tool calls as a trace, oldest first', () => {
    const p = page(team());
    assert.ok(txt(p, 'stage-now-body').includes('t6 call'));
    const chips = p.query('#stage-now-body .ui-chip').map((c) => c.textContent);
    assert.deepEqual(chips, ['t3', 't4', 't5', 't6']);
  });

  it('"Jetzt" shows fewer tool calls when there are fewer, and a placeholder without any', () => {
    const t = team();
    t.active.recent_tools = [tool('only')];
    assert.deepEqual(page(t).query('#stage-now-body .ui-chip').map((c) => c.textContent), ['only']);
    const e = team();
    e.active.recent_tools = [];
    const p = page(e);
    assert.equal(p.query('#stage-now-body .ui-chip').length, 0);
    assert.ok(txt(p, 'stage-now-body').includes('Reading the file'));
  });

  it('"Session" shows a context bar with the Auto-Compact mark, turn, duration, model and tokens', () => {
    const p = page(team());
    assert.equal(p.query('#stage-session-body .ui-bar')[0]!.getAttribute('aria-valuenow'), '42');
    assert.equal(p.query('#stage-session-body .ui-bar-mark').length, 1);
    const s = txt(p, 'stage-session-body');
    for (const part of ['17', 'opus', '750', '42']) assert.ok(s.includes(part), `${part} in "${s}"`);
    assert.match(s, /Dauer/);
    assert.match(s, /Turn/);
    assert.match(s, /Modell/);
    assert.match(s, /Tokens/);
  });

  it('"Session" handles a missing window and percent', () => {
    const t = team();
    t.active.context = { tokens: null, window: null, percent: null, compacts: 0 };
    const p = page(t);
    assert.equal(p.query('#stage-session-body .ui-bar-mark').length, 1);
    assert.ok(txt(p, 'stage-session-body').includes('—'));
  });

  it('"Subagents": running ones pulse, finished ones are still, with type, description, duration and tokens', () => {
    const p = page(team());
    const run = p.query('#stage-subs-body .stage-subagent.is-running');
    const done = p.query('#stage-subs-body .stage-subagent.is-done');
    assert.equal(run.length, 1);
    assert.equal(done.length, 1);
    assert.equal(run[0]!.querySelectorAll('.ring').length, 1);
    assert.equal(done[0]!.querySelectorAll('.ring').length, 0);
    assert.equal(p.query('#stage-subs-body .ring').length, 1);
    assert.ok((run[0]!.textContent ?? '').includes('Explore') && (run[0]!.textContent ?? '').includes('Look around'));
    assert.ok((done[0]!.textContent ?? '').includes('Plan') && (done[0]!.textContent ?? '').includes('Draft'));
    assert.ok((done[0]!.textContent ?? '').includes('fertig'), done[0]!.textContent ?? '');
    assert.ok((run[0]!.textContent ?? '').includes('2m 0s'), run[0]!.textContent ?? '');
    assert.match(done[0]!.textContent ?? '', /7,000|7(\.0)?k/);
    assert.match(run[0]!.textContent ?? '', /5,000|5(\.0)?k/);
  });

  it('"Subagents" says so when a live session has none', () => {
    const p = page(team({ subagents: { running: [], finished: [] } }));
    assert.equal(p.query('#stage-subs-body .stage-subagent').length, 0);
    assert.ok(txt(p, 'stage-subs-body').trim().length > 0);
  });

  it('animates only through the shared .ring / .eq / .live; no stage rule runs an animation of its own', () => {
    const css = AGENT_HTML.match(/<style[^>]*>([\s\S]*?)<\/style>/g)?.join('\n') ?? AGENT_HTML;
    const stageRules = css.split('}').filter((r) => /\.(stage|seats|floor|spot|sub-)[-\s{.:]/.test(r) && /animation\s*:/.test(r));
    assert.deepEqual(stageRules, []);
  });
});

describe('E3-3 stage: no session', () => {
  it('animates no seat and shows "Keine Session" in all three fields', () => {
    const p = page(team(IDLE));
    for (const sel of ['.ring', '.eq', '.is-playing', '.is-active', '.ui-ring', '.pulse']) assert.equal(p.query(`#stage ${sel}`).length, 0, sel);
    for (const id of ['stage-now-body', 'stage-session-body', 'stage-subs-body']) assert.ok(txt(p, id).includes('Keine Session'), id);
  });

  it('shows no animation even if the API still says a seat is playing', () => {
    const t = team(IDLE);
    t.seats.forEach((s: Obj) => { if (s.status === 'waiting') s.status = 'playing'; });
    const p = page(t);
    for (const sel of ['.ring', '.eq', '.is-playing', '.is-active', '.pulse']) assert.equal(p.query(`#stage ${sel}`).length, 0, sel);
    assert.equal(p.query('#stage-seats .stage-seat').length, 6);
  });

  it('switches from live to "Keine Session" and back on later renders', () => {
    const p = page(team());
    assert.equal(p.query('#stage-seats .ring').length, 1);
    p.render({ detail: issueDetail(), team: team(IDLE) });
    assert.equal(p.query('#stage .ring').length, 0);
    assert.equal(p.query('#stage .eq').length, 0);
    assert.ok(txt(p, 'stage-now-body').includes('Keine Session'));
    p.render({ detail: issueDetail(), team: team() });
    assert.equal(p.query('#stage-seats .ring').length, 1);
    assert.equal(p.query('#stage .ui-ring-pct')[0]!.textContent, '42%');
    assert.ok(!txt(p, 'stage-now-body').includes('Keine Session'));
  });
});

describe('E3-3 stage: 390 px', () => {
  const cols = (n: number) => {
    const t = team();
    t.seats = Array.from({ length: n }, (_, i) => seat(i === n - 1 ? 'you' : `role${i}`, 'waiting'));
    return page(t).$('stage-seats').style.getPropertyValue('--seats');
  };

  it('has one column per seat on wide screens', () => {
    assert.equal(cols(8), '8');
    assert.equal(cols(6), '6');
  });

  it('arranges eight seats in two rows of four in a narrow-viewport media query', () => {
    const m = AGENT_HTML.match(/@media \(max-width: (\d+)px\) \{\s*\.seats \{[^}]*repeat\(4, minmax\(0, 1fr\)\)[^}]*\}/);
    assert.ok(m, 'media query with .seats repeat(4, …)');
    assert.ok(Number(m[1]) >= 390, `breakpoint ${m[1]} covers 390 px`);
  });

  it('does not let the stage create a horizontal scroll', () => {
    assert.match(AGENT_HTML, /\.stage\s*\{[^}]*overflow:\s*hidden/);
    assert.match(AGENT_HTML, /\.stage-seat\s*\{[^}]*min-width:\s*0/);
    assert.match(AGENT_HTML, /\.stage-field\s*\{[^}]*min-width:\s*0/);
    assert.match(AGENT_HTML, /\.seats\s*\{[^}]*minmax\(0,\s*1fr\)/);
    // The fixed 96 px gauge shrinks on phones so that four columns fit in 390 px.
    const small = AGENT_HTML.match(/@media \(max-width: (\d+)px\) \{[^@]*?\.stage-gauge[^}]*width:\s*(\d+)px/);
    assert.ok(small && Number(small[1]) >= 390 && Number(small[2]) * 4 <= 390, 'gauge shrinks for 390 px');
  });
});

describe('E3-3 stage: polling and safety', () => {
  const handler = (mode: 'ok' | 'throw' | '404' | 'html') => (url: string): unknown => {
    if (url.endsWith('/team')) {
      if (mode === 'throw') throw new Error('network down');
      if (mode === '404') return { error: 'not found' };
      if (mode === 'html') return issueDetail();
      return team();
    }
    if (url.includes('/timeline')) return { events: [], latest_seq: 0, first_seq: 1 };
    if (url.includes('/transcript')) return { available: false, reason: 'none', entries: [], next_offset: 0, more: false };
    return issueDetail();
  };

  it('loads /team through the page poll and shows the stage', async () => {
    const p = renderPage(AGENT_HTML, undefined, { url: URL_, fetch: handler('ok') });
    await until(() => p.$('stage').hidden === false, 3000, 'stage visible');
    assert.ok(p.fetches.some((f) => f.url === '/api/v1/acme%2Fapp%231/team' && f.method === 'GET'));
    assert.equal(p.query('#stage-seats .stage-seat').length, 6);
  });

  for (const mode of ['throw', '404', 'html'] as const) {
    it(`a failing /team (${mode}) leaves the rest of the page working and the stage hidden`, async () => {
      const p = renderPage(AGENT_HTML, undefined, { url: URL_, fetch: handler(mode) });
      await until(() => p.fetches.some((f) => f.url.endsWith('/team')) && (p.$('hero-title').textContent ?? '') === 'Issue one', 3000, 'hero');
      assert.equal(p.$('stage').hidden, true);
      assert.notEqual(p.$('stage-seats').children.length > 0, true);
    });
  }

  it('adds no timer and no event source for the stage', () => {
    const start = AGENT_HTML.indexOf('stage (Bühne)');
    assert.ok(start > 0);
    const block = AGENT_HTML.slice(start, AGENT_HTML.indexOf('render + interactions', start));
    assert.doesNotMatch(block, /setInterval|setTimeout|EventSource/);
  });

  it('inserts agent text as text, never as markup', () => {
    const t = team();
    t.active.action = '<img src=x onerror=alert(1)>';
    t.active.recent_tools[5].message = '<script>alert(2)</script>';
    t.subagents.running[0].description = '<b onclick=x>bold</b>';
    t.subagents.running[0].subagent_type = '<i>type</i>';
    t.seats[0].verdict = '<u>v</u>';
    t.active.model = '<s>m</s>';
    const p = page(t);
    for (const sel of ['img', 'script', 'b[onclick]', 'u', 's']) assert.equal(p.query(`#stage ${sel}`).length, 0, sel);
    assert.ok(txt(p, 'stage-now-body').includes('<script>alert(2)</script>'));
    assert.ok(txt(p, 'stage-subs-body').includes('<b onclick=x>bold</b>'));
    assert.ok(txt(p, 'stage-session-body').includes('<s>m</s>'));
    assert.ok(txt(p, 'stage-subs-body').includes('<i>type</i>'));
  });

  it('uses no innerHTML in the stage code', () => {
    const start = AGENT_HTML.indexOf('stage (Bühne)');
    const block = AGENT_HTML.slice(start, AGENT_HTML.indexOf('render + interactions', start));
    assert.doesNotMatch(block, /innerHTML|insertAdjacentHTML|outerHTML/);
  });

  it('keeps the existing page controls (Pause, Force, filter) in the page', () => {
    const p = page(team());
    for (const id of ['hero-title', 'pipe-section', 'filters', 'raw-toggle', 'rawlog', 'raw-list']) assert.ok(p.$(id), id);
  });
});

describe('E3-3 stage: round 2 (review fixes)', () => {
  it('shows "Keine Session" in all three fields and animates nothing once the run has ended', () => {
    const p = renderPage(AGENT_HTML, { detail: issueDetail(), team: team(), ended: true }, { url: URL_ });
    for (const sel of ['.ring', '.eq', '.is-playing', '.is-active', '.ui-ring', '.pulse']) assert.equal(p.query(`#stage ${sel}`).length, 0, sel);
    for (const id of ['stage-now-body', 'stage-session-body', 'stage-subs-body']) assert.ok(txt(p, id).includes('Keine Session'), id);
  });

  it('shows "Keine Session" and animates nothing for an untracked issue', () => {
    const p = renderPage(AGENT_HTML, { detail: null, notFound: true, team: team() }, { url: URL_ });
    for (const sel of ['.ring', '.eq', '.is-playing', '.pulse']) assert.equal(p.query(`#stage ${sel}`).length, 0, sel);
  });

  it('leaves room for the percent badge below the active gauge', () => {
    assert.match(AGENT_HTML, /\.stage-seat\.is-active \.stage-spot\s*\{[^}]*margin-bottom:\s*\d+px/);
  });

  it('keeps the running subagent row (and its pulse) in place across polls while its numbers update', () => {
    const p = page(team());
    const dot = () => p.query('#stage-subs-body .sub-av .ring');
    assert.equal(dot().length, 1);
    const before = dot()[0]!;
    const t = team();
    t.subagents.running[0].tokens.total_tokens = 9_000;
    p.render({ detail: issueDetail(), team: t });
    assert.equal(dot().length, 1);
    assert.equal(dot()[0], before, 'pulsing dot is the same node, so the animation does not restart');
    assert.ok(txt(p, 'stage-subs-body').includes('Explore'));
  });

  it('stops the pulse when the running subagent finishes', () => {
    const p = page(team());
    assert.equal(p.query('#stage-subs-body .sub-av .ring').length, 1);
    const t = team();
    const done = { ...t.subagents.running[0], status: 'done', ended_at: '2026-10-30T11:59:00.000Z' };
    t.subagents = { running: [], finished: [done, ...t.subagents.finished] };
    p.render({ detail: issueDetail(), team: t });
    assert.equal(p.query('#stage-subs-body .sub-av .ring').length, 0);
    assert.ok(txt(p, 'stage-subs-body').includes('Plan'));
  });
});
