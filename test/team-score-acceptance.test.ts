import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { ROLE_COLORS } from '../src/http/ui/tokens.ts';
import { renderPage } from './helpers.ts';
import { issueDetail, teamView } from './helpers/page-fixtures.ts';

// E3-4 (#366): acceptance tests of the score (Partitur), derived from the issue text and written independently of
// the developer's own tests. Fixture: two rounds, three sessions, two handoffs (all times before the frozen clock 12:00).

const URL_ = 'http://127.0.0.1/issue?id=acme%2Fapp%231';
type Obj = Record<string, any>;
const iso = (hhmm: string, day = '2026-10-30') => `${day}T${hhmm}:00.000Z`;

function team(over: { live?: boolean; blocks?: Obj[]; handoffs?: Obj[] } = {}): Obj {
  const blocks = over.blocks ?? [
    { role: 'developer', run: 'r1', started_at: iso('10:00'), ended_at: iso('10:30'), verdict: 'done', round: 1, model: 'opus', tool_calls: 12 },
    { role: 'reviewer', run: 'r2', started_at: iso('10:30'), ended_at: iso('10:45'), verdict: 'request_changes', round: 1, model: 'sonnet', tool_calls: 4 },
    { role: 'developer', run: 'r3', started_at: iso('10:50'), ended_at: over.live ? null : iso('11:20'), verdict: over.live ? null : 'done', round: 2, model: 'opus', tool_calls: 9 },
  ];
  const handoffs = over.handoffs ?? [
    { from: 'developer', to: 'reviewer', verdict: 'done', at: iso('10:30') },
    { from: 'reviewer', to: 'developer', verdict: 'request_changes', at: iso('10:45') },
  ];
  const base = teamView({ blocks, handoffs });
  if (!over.live) { base.active = null; base.subagents = { running: [], finished: [] }; }
  return base;
}
const page = (t?: Obj, extra: Obj = {}) => renderPage(AGENT_HTML, { detail: issueDetail(), ...(t ? { team: t } : {}), ...extra }, { url: URL_ });
const svgOf = (p: ReturnType<typeof page>) => p.query('#score svg')[0]!;
const num = (e: any, a: string) => Number(e.getAttribute(a));
const texts = (p: ReturnType<typeof page>, sel: string) => p.query(sel).map((e) => e.textContent);

describe('E3-4 score: section and svg', () => {
  it('is a section "Partitur" below the stage with an SVG-namespace svg', () => {
    const p = page(team());
    assert.ok(AGENT_HTML.indexOf('id="score"') > AGENT_HTML.indexOf('id="stage"'), 'score after stage in the markup');
    assert.equal(p.$('score').hidden, false);
    assert.match(p.$('score').textContent!, /Partitur/);
    const svg = svgOf(p);
    assert.equal(svg.tagName.toLowerCase(), 'svg');
    assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
    assert.match(AGENT_HTML, /createElementNS/);
    for (const el of p.query('#score svg rect, #score svg line, #score svg text')) assert.equal(el.namespaceURI, 'http://www.w3.org/2000/svg');
  });

  it('stays hidden without a team and with a team without sessions', () => {
    assert.equal(page().$('score').hidden, true);
    assert.equal(page(team({ blocks: [], handoffs: [] })).$('score').hidden, true);
    assert.equal(page(teamView()).query('#score svg').length, 0);
  });

  it('has one lane per role (no "you"), in the pipeline order of the seats, and puts blocks into their role lane', () => {
    const t = team();
    const p = page(t);
    const lanes = p.query('#score g.score-lane').map((g) => g.getAttribute('data-role'));
    assert.deepEqual(lanes, t.seats.map((s: Obj) => s.role).filter((r: string) => r !== 'you'));
    const y = (role: string) => num(p.query('#score g.score-lane').find((g) => g.getAttribute('data-role') === role)!.querySelector('rect'), 'y');
    assert.ok(y('developer') < y('reviewer'), 'developer lane above reviewer lane');
    for (const b of p.query('#score g.score-block')) {
      const r = num(b.querySelector('rect'), 'y');
      assert.ok(r >= y(b.getAttribute('data-role')!), 'block below the top of its lane');
      const next = lanes.indexOf(b.getAttribute('data-role')) + 1;
      if (next < lanes.length) assert.ok(r < y(lanes[next]!), 'block above the next lane');
    }
  });
});

describe('E3-4 score: time axis', () => {
  it('runs from the first session to the last end when nothing runs: first block starts at the left, last block ends at the right plot edge', () => {
    const p = page(team());
    const blocks = p.query('#score g.score-block').map((g) => g.querySelector('rect')!);
    const lefts = blocks.map((r) => num(r, 'x'));
    const rights = blocks.map((r) => num(r, 'x') + num(r, 'width'));
    assert.equal(Math.min(...lefts), lefts[0]);
    assert.ok(lefts[0]! < lefts[1]! && lefts[1]! < lefts[2]!, 'blocks in time order');
    // proportional: 30 min / 15 min / 30 min
    assert.ok(Math.abs(num(blocks[0], 'width') / num(blocks[1], 'width') - 2) < 0.05);
    assert.ok(Math.abs(num(blocks[0], 'width') - num(blocks[2], 'width')) < 0.5);
    assert.ok(Math.max(...rights) <= num(svgOf(p), 'width'));
    // gap of 5 min between block 2 and block 3
    const gap = lefts[2]! - rights[1]!;
    assert.ok(Math.abs(gap / (num(blocks[1], 'width') / 15) - 5) < 0.1, 'gap equals 5 minutes of width');
  });

  it('uses 5 min ticks up to one hour, 15 min up to some hours and 60 min for long runs', () => {
    const dur = (end: string, day?: string) => svgOf(page(team({ blocks: [{ role: 'developer', run: 'r1', started_at: iso('10:00'), ended_at: iso(end, day), verdict: 'done', round: 1, model: 'opus', tool_calls: 1 }], handoffs: [] }))).getAttribute('data-tick-min');
    assert.equal(dur('10:30'), '5');
    assert.equal(dur('11:00'), '5');
    assert.equal(dur('12:00'), '15');
    assert.equal(dur('06:00', '2026-10-31'), '60');
    assert.equal(dur('10:00', '2026-10-31'), '60');
  });

  it('draws tick marks with time labels at the chosen distance', () => {
    const p = page(team());
    const ticks = p.query('#score g.score-tick');
    assert.equal(svgOf(p).getAttribute('data-tick-min'), '15', '80 min -> 15 min marks');
    assert.ok(ticks.length >= 5 && ticks.length <= 6, `one marker per 15 min over 80 min, got ${ticks.length}`);
    const xs = ticks.map((g) => num(g.querySelector('line'), 'x1'));
    const step = xs[1]! - xs[0]!;
    assert.ok(step > 0);
    const first = p.query('#score g.score-block')[0]!.querySelector('rect')!;
    const pxPerMin = num(first, 'width') / 30;
    assert.ok(Math.abs(step / pxPerMin - 15) < 0.1, 'step corresponds to 15 minutes');
    for (let i = 1; i < xs.length; i++) assert.ok(Math.abs(xs[i]! - xs[i - 1]! - step) < 0.01, 'equidistant');
    for (const g of ticks) assert.match(g.querySelector('text')!.textContent!, /\d{1,2}:\d{2}/);
  });

  it('is at least 600 px wide for short runs and wider than 600 px for long runs', () => {
    const short = team({ blocks: [{ role: 'developer', run: 'r1', started_at: iso('10:00'), ended_at: iso('10:06'), verdict: 'done', round: 1, model: 'opus', tool_calls: 1 }], handoffs: [] });
    assert.ok(num(svgOf(page(short)), 'width') >= 600);
    const long = team({ blocks: [{ role: 'developer', run: 'r1', started_at: iso('10:00'), ended_at: iso('10:00', '2026-11-01'), verdict: 'done', round: 1, model: 'opus', tool_calls: 1 }], handoffs: [] });
    assert.ok(num(svgOf(page(long)), 'width') > 600);
    assert.ok(num(svgOf(page(team())), 'width') >= 600);
  });
});

describe('E3-4 score: blocks', () => {
  it('draws one block per session in the colour of its role', () => {
    const p = page(team());
    const blocks = p.query('#score g.score-block');
    assert.equal(blocks.length, 3);
    assert.deepEqual(blocks.map((b) => b.getAttribute('data-role')), ['developer', 'reviewer', 'developer']);
    assert.equal(blocks[0]!.querySelector('rect')!.getAttribute('fill'), ROLE_COLORS.developer);
    assert.equal(blocks[1]!.querySelector('rect')!.getAttribute('fill'), ROLE_COLORS.reviewer);
    assert.equal(blocks[2]!.querySelector('rect')!.getAttribute('fill'), ROLE_COLORS.developer);
    assert.notEqual(ROLE_COLORS.developer, ROLE_COLORS.reviewer);
  });

  it('draws one stroke per tool call inside the block when the density is low', () => {
    const p = page(team());
    const blocks = p.query('#score g.score-block');
    for (const [i, calls] of [12, 4, 9].entries()) {
      const rect = blocks[i]!.querySelector('rect')!;
      const lines = blocks[i]!.querySelectorAll('line');
      assert.equal(lines.length, calls, `block ${i}`);
      for (const l of lines) {
        assert.ok(num(l, 'x1') >= num(rect, 'x') && num(l, 'x1') <= num(rect, 'x') + num(rect, 'width'), 'stroke inside block');
      }
    }
  });

  it('draws no strokes for a block without tool calls and caps the density per minute', () => {
    const t = team();
    t.blocks[0].tool_calls = 0;
    t.blocks[1].tool_calls = 100000;
    const blocks = page(t).query('#score g.score-block');
    assert.equal(blocks[0]!.querySelectorAll('line').length, 0);
    // 15 min block; a sane cap is at most 20 calls per minute -> 300 strokes, far below 100000
    assert.ok(blocks[1]!.querySelectorAll('line').length <= 15 * 20);
    assert.ok(blocks[1]!.querySelectorAll('line').length > 0);
  });

  it('gives a block <title> and aria-label with role, duration, model and verdict', () => {
    const p = page(team());
    const [a, b] = p.query('#score g.score-block');
    for (const g of [a!, b!]) {
      assert.equal(g.querySelector('title')!.textContent, g.getAttribute('aria-label'));
    }
    const first = a!.getAttribute('aria-label')!;
    assert.match(first, /Developer/);
    assert.match(first, /30m/);
    assert.match(first, /opus/);
    assert.match(first, /done/);
    const second = b!.getAttribute('aria-label')!;
    assert.match(second, /Reviewer/);
    assert.match(second, /15m/);
    assert.match(second, /sonnet/);
    assert.match(second, /request_changes/);
  });

  it('shows a running session as open block without verdict in the tooltip', () => {
    const p = page(team({ live: true }));
    const last = p.query('#score g.score-block')[2]!;
    assert.match(last.getAttribute('aria-label')!, /Developer/);
    assert.match(last.getAttribute('aria-label')!, /opus/);
    assert.doesNotMatch(last.getAttribute('aria-label')!, /\bdone\b/);
  });
});

describe('E3-4 score: handoffs and rounds', () => {
  it('draws one arrow per handoff, from lane to lane, with the verdict as label', () => {
    const p = page(team());
    const hs = p.query('#score g.score-handoff');
    assert.equal(hs.length, 2);
    assert.deepEqual(hs.map((g) => g.querySelector('text')!.textContent), ['done', 'request_changes']);
    const laneY = (role: string) => num(p.query('#score g.score-lane').find((g) => g.getAttribute('data-role') === role)!.querySelector('rect'), 'y');
    const ln = (g: any) => g.querySelector('line');
    // developer -> reviewer goes down, reviewer -> developer goes up
    assert.ok(num(ln(hs[0]), 'y2') > num(ln(hs[0]), 'y1'));
    assert.ok(num(ln(hs[1]), 'y2') < num(ln(hs[1]), 'y1'));
    const lo = laneY('developer'), hi = laneY('reviewer');
    for (const g of hs) for (const a of ['y1', 'y2']) assert.ok(num(ln(g), a) >= lo && num(ln(g), a) <= hi + 40);
    // arrow x sits at the handoff time: after the first block, before the third block starts
    const blocks = p.query('#score g.score-block').map((g) => g.querySelector('rect')!);
    const x0 = num(ln(hs[0]), 'x1'), x1 = num(ln(hs[1]), 'x1');
    assert.ok(Math.abs(x0 - num(blocks[1], 'x')) < 1.5);
    assert.ok(Math.abs(x1 - (num(blocks[1], 'x') + num(blocks[1], 'width'))) < 1.5);
    assert.ok(x0 < x1);
  });

  it('colours approve green, request_changes red and everything else gray', () => {
    const cls = (verdict: string | null) => {
      const t = team();
      t.handoffs = [{ from: 'developer', to: 'reviewer', verdict, at: iso('10:30') }];
      return page(t).query('#score g.score-handoff')[0]!.className;
    };
    assert.match(cls('approve'), /tone-green/);
    assert.match(cls('request_changes'), /tone-red/);
    for (const v of ['done', 'ready', 'failed', 'whatever', null]) {
      assert.match(cls(v), /tone-gray/, String(v));
      assert.doesNotMatch(cls(v), /tone-(green|red)/, String(v));
    }
    assert.match(AGENT_HTML, /\.score-handoff\.tone-green[^{]*\{[^}]*var\(--green\)/);
    assert.match(AGENT_HTML, /\.score-handoff\.tone-red[^{]*\{[^}]*var\(--red\)/);
  });

  it('draws a dashed vertical line "Runde n" at a round change, none within round 1', () => {
    const p = page(team());
    const rounds = p.query('#score g.score-round');
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0]!.querySelector('text')!.textContent, 'Runde 2');
    const line = rounds[0]!.querySelector('line')!;
    assert.equal(num(line, 'x1'), num(line, 'x2'), 'vertical');
    assert.ok(num(line, 'y2') > num(line, 'y1'));
    const third = p.query('#score g.score-block')[2]!.querySelector('rect')!;
    assert.ok(Math.abs(num(line, 'x1') - num(third, 'x')) < 1.5, 'at the start of the first round-2 session');
    assert.match(AGENT_HTML, /\.score-round line \{[^}]*stroke-dasharray/);
    const one = team();
    one.blocks.forEach((b: Obj) => { b.round = 1; });
    assert.equal(page(one).query('#score g.score-round').length, 0);
  });

  it('draws one line per further round (three rounds -> Runde 2 and Runde 3)', () => {
    const t = team();
    t.blocks.push({ role: 'reviewer', run: 'r4', started_at: iso('11:20'), ended_at: iso('11:30'), verdict: 'request_changes', round: 2, model: 'sonnet', tool_calls: 2 });
    t.blocks.push({ role: 'developer', run: 'r5', started_at: iso('11:35'), ended_at: iso('11:50'), verdict: 'done', round: 3, model: 'opus', tool_calls: 2 });
    const p = page(t);
    assert.deepEqual(texts(p, '#score g.score-round text'), ['Runde 2', 'Runde 3']);
    assert.equal(svgOf(p).getAttribute('aria-label'), 'Partitur: 5 Sessions, 2 Übergaben, Runde 3');
  });
});

describe('E3-4 score: "Jetzt" line', () => {
  it('shows a labelled line at the right edge only while a session runs', () => {
    const p = page(team({ live: true }));
    const now = p.query('#score g.score-now');
    assert.equal(now.length, 1);
    assert.match(now[0]!.querySelector('text')!.textContent!, /Jetzt/);
    const x = num(now[0]!.querySelector('line'), 'x1');
    const width = num(svgOf(p), 'width');
    assert.ok(x <= width && x >= width - 60, `x=${x} near the right edge ${width}`);
    const rects = p.query('#score g.score-block rect');
    assert.ok(rects.every((r) => num(r, 'x') + num(r, 'width') <= x + 0.5), 'no block reaches beyond the now line');
    // the running block grows up to "now"
    const last = rects[2]!;
    assert.ok(Math.abs(num(last, 'x') + num(last, 'width') - x) < 1.5);
  });

  it('has no "Jetzt" line without a running session, for an ended run or a missing issue', () => {
    assert.equal(page(team()).query('#score g.score-now').length, 0);
    assert.equal(page(team({ live: true }), { ended: true }).query('#score g.score-now').length, 0);
    assert.equal(page(team()).query('#score').some((e) => /Jetzt/.test(e.textContent ?? '')), false);
  });
});

describe('E3-4 score: scrolling and text alternative', () => {
  it('keeps the score in its own horizontally scrolling frame', () => {
    assert.match(AGENT_HTML, /\.score-frame \{[^}]*overflow-x: auto/);
    const p = page(team());
    assert.ok(p.query('#score-frame svg').length === 1, 'svg lives in the frame');
    assert.equal(p.$('score-frame').parentElement !== null, true);
  });

  it('describes the graphic in words: sessions, handoffs, round', () => {
    assert.equal(svgOf(page(team())).getAttribute('aria-label'), 'Partitur: 3 Sessions, 2 Übergaben, Runde 2');
    const single = team({ blocks: [{ role: 'developer', run: 'r1', started_at: iso('10:00'), ended_at: iso('10:30'), verdict: 'done', round: 1, model: 'opus', tool_calls: 3 }], handoffs: [] });
    assert.equal(svgOf(page(single)).getAttribute('aria-label'), 'Partitur: 1 Sessions, 0 Übergaben, Runde 1');
  });
});

describe('E3-4 score: robustness', () => {
  it('rebuilds on changed data and removes the old svg (one svg only)', () => {
    const t = team();
    const p = page(t);
    const t2 = team();
    t2.blocks.push({ role: 'tester', run: 'r9', started_at: iso('11:21'), ended_at: iso('11:30'), verdict: 'passed', round: 2, model: 'sonnet', tool_calls: 1 });
    p.render({ detail: issueDetail(), team: t2 });
    assert.equal(p.query('#score svg').length, 1);
    assert.equal(p.query('#score g.score-block').length, 4);
    assert.equal(svgOf(p).getAttribute('aria-label'), 'Partitur: 4 Sessions, 2 Übergaben, Runde 2');
  });

  it('hides again and drops the svg content when the blocks vanish', () => {
    const p = page(team());
    p.render({ detail: issueDetail(), team: team({ blocks: [], handoffs: [] }) });
    assert.equal(p.$('score').hidden, true);
  });

  it('keeps unknown roles from breaking the score and escapes text', () => {
    const t = team();
    t.blocks[1].role = '<b>x</b>';
    t.handoffs = [{ from: '<b>x</b>', to: 'developer', verdict: '<script>1</script>', at: iso('10:45') }];
    const p = page(t);
    assert.equal(p.query('#score b').length, 0);
    assert.equal(p.query('#score script').length, 0);
    assert.equal(p.query('#score g.score-block').length, 3);
  });

  it('does not affect the stage', () => {
    const p = page(team({ live: true }));
    assert.equal(p.$('stage').hidden, false);
    assert.equal(p.query('#stage-seats .stage-seat').length, 8);
  });
});
