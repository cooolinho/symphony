import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { renderPage, until } from './helpers.ts';
import { issueDetail, teamView } from './helpers/page-fixtures.ts';

// E3-3 (#356) and E3-6 (#385): the stage (Bühne) of the team view on the agent page, after the mockup.

const AGENT_URL = 'http://127.0.0.1/issue?id=acme%2Fapp%231';
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const stage = (team?: Obj, detail: Obj = issueDetail()) => renderPage(AGENT_HTML, { detail, ...(team ? { team } : {}) }, { url: AGENT_URL });
const seatOf = (page: ReturnType<typeof stage>, role: string) => page.query('#stage-seats .stage-seat').find((s) => s.getAttribute('data-role') === role)!;
const sub = (page: ReturnType<typeof stage>, role: string) => seatOf(page, role).querySelector('.stage-sub')!.textContent;
const NO_SESSION = { active: null, subagents: { running: [], finished: [] } };
const rule = (selector: string): string => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = AGENT_HTML.match(new RegExp(`\\n\\s*${esc} \\{([^}]*)\\}`));
  assert.ok(m, `rule ${selector}`);
  return m[1]!.replace(/\s+/g, ' ');
};

describe('E3-6 stage: section, head and legend', () => {
  it('is a glass section with relative position, hidden overflow and the mockup padding', () => {
    assert.match(AGENT_HTML, /<section class="g stage" id="stage"/);
    const css = rule('.stage');
    for (const part of ['position: relative', 'overflow: hidden', 'padding: 20px 22px 22px']) assert.ok(css.includes(part), part);
  });

  it('is titled "Bühne · das Team von #<nr>" and has the legend spielt, fertig, Rückgabe, wartet', () => {
    const page = stage(teamView());
    assert.equal(page.$('stage').hidden, false);
    assert.equal(page.$('stage-title').textContent, 'Bühne · das Team von #1');
    assert.ok(page.$('stage-title').className.includes('lbl'));
    assert.deepEqual(page.query('.stage-legend li').map((li) => li.textContent), ['spielt', 'fertig', 'Rückgabe', 'wartet']);
    assert.match(rule('.stage-legend'), /font-size: 12px/);
    assert.match(rule('.stage-legend .lg-done'), /#94a3b8/);
    assert.match(rule('.stage-legend .lg-wait'), /dashed/);
    assert.equal(stage().$('stage').hidden, true, 'hidden without a /team answer');
  });
});

describe('E3-6 stage: seats', () => {
  it('shows the roles in pipeline order with "Du" last as a rounded square with the person icon', () => {
    const team = teamView();
    const page = stage(team);
    const seats = page.query('#stage-seats .stage-seat');
    assert.deepEqual(seats.map((s) => s.getAttribute('data-role')), team.seats.map((s: Obj) => s.role));
    const you = seats.at(-1)!;
    assert.equal(you.querySelector('.stage-name')!.textContent, 'Du');
    assert.ok(you.querySelector('.ui-av.is-you'));
    assert.ok(you.querySelector('.ui-av svg'), 'person icon');
    assert.match(rule('.stage-seat .ui-av.is-you'), /border-radius: 18px/);
    assert.equal(sub(page, 'you'), 'In review · Merge');
    const merged = teamView();
    merged.seats.at(-1).status = 'done';
    assert.equal(sub(stage(merged), 'you'), 'Done');
  });

  it('lays the seats out as one grid column each (8 by default), four columns without an edge up to 900 px', () => {
    const page = stage(teamView());
    assert.equal(page.$('stage-seats').style.getPropertyValue('--seats'), '8');
    assert.match(rule('.seats'), /grid-template-columns: repeat\(var\(--seats, 8\), minmax\(0, 1fr\)\); gap: 18px 8px/);
    const narrow = AGENT_HTML.match(/@media \(max-width: 900px\) \{([^@]*?)\n {2}\}/);
    assert.ok(narrow, '900 px query');
    assert.match(narrow[1]!, /\.seats \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); \}/);
    assert.match(narrow[1]!, /\.floor, \.spot \{ display: none; \}/);
    const three = teamView({ seats: teamView().seats.slice(-3) });
    assert.equal(stage(three).$('stage-seats').style.getPropertyValue('--seats'), '3');
  });

  it('tints finished seats dark per role with a role border and a green check badge', () => {
    const page = stage(teamView());
    const av = seatOf(page, 'analyst').querySelector('.ui-av')!;
    assert.equal(av.style.background, '#0d2433');
    assert.equal(av.style.borderColor, 'rgba(56,189,248,.6)');
    assert.equal(seatOf(page, 'architect').querySelector('.ui-av')!.style.background, '#1d1838');
    assert.ok(av.querySelector('.ui-av-badge'));
    assert.equal(av.querySelector('.ui-av-badge.is-x'), null);
    assert.equal(sub(page, 'analyst'), 'ready · 3m 0s · sonnet');
  });

  it('marks a returned seat with a red cross, the #2a1414 ground and "R<n> failed · wartet auf R<n+1>"', () => {
    const page = stage(teamView());
    const seat = seatOf(page, 'tester');
    assert.ok(seat.className.includes('is-returned'));
    assert.ok(seat.querySelector('.ui-av-badge.is-x'));
    assert.equal(seat.querySelector('.ui-av')!.style.background, '#2a1414');
    assert.equal(sub(page, 'tester'), 'R1 failed · wartet auf R2');
    assert.match(rule('.stage-seat.is-returned .stage-sub'), /#fca5a5/);
  });

  it('draws waiting seats dashed without a badge, with docs and security texts, and skipped ones in #5b6678', () => {
    const page = stage(teamView());
    assert.ok(seatOf(page, 'reviewer').querySelector('.ui-av.is-waiting'));
    assert.equal(seatOf(page, 'reviewer').querySelector('.ui-av-badge'), null);
    assert.equal(sub(page, 'reviewer'), 'wartet');
    assert.equal(sub(page, 'security'), 'wartet · bei Sicherheitsbezug');
    const docsWaiting = teamView();
    docsWaiting.seats[4].status = 'waiting';
    assert.equal(sub(stage(docsWaiting), 'docs'), 'wartet · nur bei Doku-Bedarf');
    assert.equal(sub(page, 'docs'), 'übersprungen');
    assert.match(rule('.stage-seat.is-skipped .ui-av'), /color: #5b6678; border: 1px dashed #5b6678/);
    assert.equal(seatOf(page, 'docs').querySelector('.ui-av-badge'), null);
  });

  it('maps configured role names to the palette by their result kind', () => {
    const team = teamView();
    team.seats[0].role = 'issue-analyst';
    team.seats[6].role = 'security-auditor';
    const page = stage(team);
    assert.equal(seatOf(page, 'issue-analyst').getAttribute('data-key'), 'analyst');
    assert.equal(seatOf(page, 'issue-analyst').querySelector('.stage-name')!.textContent, 'Analyst');
    assert.equal(sub(page, 'security-auditor'), 'wartet · bei Sicherheitsbezug');
  });

  it('keeps 96 px seat frames with 64 px circles', () => {
    assert.match(rule('.stage-spot'), /height: 96px/);
    assert.equal(stage(teamView()).query('#stage-seats .ui-av-64').length, 7);
  });
});

describe('E3-6 stage: active seat', () => {
  it('has one 96 px ring with role="img" and an aria-label naming the role and the context', () => {
    const page = stage(teamView());
    const seat = seatOf(page, 'developer');
    assert.ok(seat.className.includes('is-active'));
    assert.equal(page.query('#stage .stage-gauge').length, 1);
    const ring = seat.querySelector('.stage-gauge .ui-ring')!;
    assert.equal(ring.getAttribute('role'), 'img');
    assert.equal(ring.getAttribute('aria-label'), 'Developer spielt, Context 42 Prozent');
    assert.equal(ring.style.width, '96px');
    assert.equal(ring.style.boxShadow, '0 0 44px rgba(52,211,153,.45)');
    assert.equal(ring.querySelector('.ui-ring-pct')!.textContent, '42%');
    assert.ok(ring.querySelector('.ui-ring-in svg'), 'role icon inside');
  });

  it('pulses in the role colour at inset -9px, shows a large equalizer and the light role name', () => {
    const page = stage(teamView());
    const seat = seatOf(page, 'developer');
    const pulse = seat.querySelector('.stage-gauge .ring.ring-lg')!;
    assert.equal(pulse.style.color, '#34d399');
    assert.match(rule('.stage-gauge > .ring'), /inset: -9px/);
    assert.equal(seat.querySelectorAll('.eq.eq-lg').length, 1);
    assert.equal(seat.querySelector('.stage-name')!.style.color, '#d1fae5');
    assert.equal(page.query('#stage .ring').length, 2, 'the seat pulse plus the running subagent');
    assert.equal(page.query('#stage-seats .ring').length, 1);
  });

  it('says "spielt · Runde <n> · <Dauer>" with the issue round', () => {
    assert.equal(sub(stage(teamView()), 'developer'), 'spielt · Runde 1 · 1m 0s');
    assert.equal(sub(stage(teamView(), issueDetail({ rounds: { current: 2, max: 3 } })), 'developer'), 'spielt · Runde 2 · 1m 0s');
  });

  it('turns amber from 70 % and says "unbekannt" without a percent', () => {
    const hot = teamView();
    hot.active.context.percent = 75;
    assert.ok(stage(hot).query('#stage .ui-ring-pct')[0]!.className.includes('hot'));
    const none = teamView();
    none.active.context.percent = null;
    const ring = stage(none).query('#stage .stage-gauge .ui-ring')[0]!;
    assert.equal(ring.getAttribute('aria-label'), 'Developer spielt, Context unbekannt');
    assert.equal(ring.querySelector('.ui-ring-pct')!.textContent, '—');
  });

  it('keeps ring, pulse and equalizer nodes across renders and swaps only the ring when the percent changes', () => {
    const page = stage(teamView());
    const ring = page.query('#stage .stage-gauge .ui-ring')[0];
    const pulse = page.query('#stage-seats .ring')[0];
    page.render({ detail: issueDetail(), team: teamView() });
    assert.equal(page.query('#stage .stage-gauge .ui-ring')[0], ring, 'same percent, same ring');
    const next = teamView();
    next.active.context.percent = 77;
    page.render({ detail: issueDetail(), team: next });
    assert.notEqual(page.query('#stage .stage-gauge .ui-ring')[0], ring);
    assert.equal(page.query('#stage-seats .ring')[0], pulse, 'the pulse keeps running');
    assert.equal(page.query('#stage .ui-ring-pct')[0]!.textContent, '77%');
  });

  it('has no active seat, ring, equalizer or spotlight without a running session', () => {
    for (const state of [{ team: teamView(NO_SESSION) }, { team: teamView(), ended: true }, { team: teamView(), detail: null, notFound: true }]) {
      const page = renderPage(AGENT_HTML, { detail: issueDetail(), ...state }, { url: AGENT_URL });
      for (const sel of ['.stage-gauge', '.ring', '.eq', '.ui-ring', '.is-active']) assert.equal(page.query(`#stage ${sel}`).length, 0, sel);
      assert.equal(page.$('stage-spot').hidden, true);
    }
  });
});

describe('E3-6 stage: edge and spotlight', () => {
  it('runs the edge from the finished seats to the active one in their colours, then the base colour', () => {
    const page = stage(teamView());
    const bg = String(page.$('stage-floor').style.background);
    const order = ['#38bdf8', '#a78bfa', '#34d399', 'rgba(255,255,255,.14)'].map((c) => bg.indexOf(c));
    assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]!)), bg);
    assert.ok(!bg.includes('#f87171') && !bg.includes('#fbbf24'), 'nothing after the active seat');
    // Seat 3 of 8 sits at ((2.5 / 8) * 100 - 6) / 88 = 28.69 % of the edge.
    assert.ok(bg.includes('#34d399 28.69%, rgba(255,255,255,.14) 28.69%'), bg);
    const css = rule('.floor');
    for (const part of ['top: 47px', 'left: 6%', 'right: 6%', 'height: 2px']) assert.ok(css.includes(part), part);
  });

  it('ends at the last finished seat without a session', () => {
    const bg = String(stage(teamView(NO_SESSION)).$('stage-floor').style.background);
    assert.ok(bg.includes('#f87171 42.9%, rgba(255,255,255,.14) 42.9%'), bg);
    const fresh = teamView({ ...NO_SESSION, seats: teamView().seats.map((s: Obj) => ({ ...s, status: 'waiting' })) });
    assert.equal(stage(fresh).$('stage-floor').style.background, 'rgba(255,255,255,.14)');
  });

  it('lights the active seat column with a 320×420 spotlight in its colour', () => {
    const spot = stage(teamView()).$('stage-spot');
    assert.equal(spot.hidden, false);
    assert.equal(spot.getAttribute('aria-hidden'), 'true');
    assert.equal(spot.style.left, 'calc(31.25% - 160px)');
    assert.equal(spot.style.background, 'radial-gradient(closest-side, rgba(52,211,153,.22), transparent)');
    const css = rule('.spot');
    assert.ok(css.includes('width: 320px') && css.includes('height: 420px'), css);
  });
});

describe('E3-6 stage: loading and safety', () => {
  it('loads /team with the poll and survives a failing /team', async () => {
    const handler = (failTeam: boolean) => (url: string): unknown => {
      if (url.includes('/team')) { if (failTeam) throw new Error('boom'); return teamView(); }
      if (url.includes('/timeline')) return { events: [], latest_seq: 0, first_seq: 1 };
      if (url.includes('/transcript')) return { available: false, reason: 'none', entries: [], next_offset: 0, more: false };
      return issueDetail();
    };
    const ok = renderPage(AGENT_HTML, undefined, { url: AGENT_URL, fetch: handler(false) });
    await until(() => ok.fetches.some((f) => f.url === '/api/v1/acme%2Fapp%231/team') && ok.$('stage').hidden === false);
    const bad = renderPage(AGENT_HTML, undefined, { url: AGENT_URL, fetch: handler(true) });
    await until(() => bad.fetches.some((f) => f.url === '/api/v1/acme%2Fapp%231/team') && (bad.$('hero-title').textContent ?? '') === 'Issue one');
    assert.equal(bad.$('stage').hidden, true);
  });

  it('inserts foreign text as text only', () => {
    const team = teamView();
    team.active.recent_tools[3].message = 'Edit: <img src=x onerror=alert(1)>';
    team.seats[0].verdict = '<u>v</u>';
    const page = stage(team);
    assert.ok((page.$('stage-now-body').textContent ?? '').includes('<img src=x onerror=alert(1)>'));
    assert.equal(page.query('#stage img, #stage u').length, 0);
  });
});
