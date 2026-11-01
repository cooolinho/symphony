import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/issue-page.ts';
import { ROLE_COLORS } from '../src/http/ui/tokens.ts';
import { renderPage } from './helpers.ts';
import { issueDetail, scoreTeam, scoreTeamFive, teamView } from './helpers/page-fixtures.ts';

// E3-4 (#366), E3-7 (#386): acceptance tests of the score (Partitur) after the mockup: panel, lane column, grid,
// stroke density, handoff colours, "Jetzt" line and robustness. Frozen clock 12:00 (UTC).

const URL_ = 'http://127.0.0.1/issue?id=acme%2Fapp%231';
type Obj = Record<string, any>;
const iso = (hhmm: string) => `2026-10-30T${hhmm}:00.000Z`;
const hm = (t: string) => new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const page = (t?: Obj, extra: Obj = {}) => renderPage(AGENT_HTML, { detail: issueDetail(), ...(t ? { team: t } : {}), ...extra }, { url: URL_ });
const num = (v: unknown) => parseFloat(String(v));
function rule(selector: string): string {
  const i = AGENT_HTML.indexOf('\n  ' + selector + ' {');
  assert.ok(i >= 0, 'rule ' + selector);
  return AGENT_HTML.slice(i, AGENT_HTML.indexOf('}', i) + 1);
}
const has = (selector: string, ...parts: string[]) => { const r = rule(selector); for (const p of parts) assert.ok(r.includes(p), selector + ': ' + p); };
/** A single block of `minutes` with `calls` tool calls, started 11:00. */
function single(calls: number, minutes: number): Obj {
  const t = scoreTeam();
  t.blocks = [{ ...t.blocks[0], tool_calls: calls, started_at: iso('11:00'), ended_at: new Date(Date.parse(iso('11:00')) + minutes * 60000).toISOString() }];
  t.handoffs = [];
  return t;
}

describe('E3-7 score: panel and head', () => {
  it('is a glass panel with 20px 22px padding below the stage', () => {
    assert.match(AGENT_HTML, /<section class="g score" id="score"/);
    assert.ok(AGENT_HTML.indexOf('id="score"') > AGENT_HTML.indexOf('id="stage"'));
    has('.score', 'padding: 20px 22px');
  });

  it('names the start of the first session in the .lbl head and shows the legend', () => {
    const p = page(scoreTeamFive());
    assert.ok(p.$('score-title').classList.contains('lbl'));
    assert.equal(p.$('score-title').textContent, 'Partitur · Ablauf seit ' + hm(iso('10:54')));
    assert.equal(page(scoreTeam()).$('score-title').textContent, 'Partitur · Ablauf seit ' + hm(iso('11:00')));
    assert.deepEqual(p.query('.score-legend li').map((li) => li.textContent), ['Block = Session', 'Striche = Tool-Aufrufe', 'Pfeil = Übergabe mit Verdict']);
    has('.score-legend', 'font-size: 12px', 'var(--fg-2)');
  });

  it('stays hidden without a team or without sessions and hides again when the blocks vanish', () => {
    assert.equal(page().$('score').hidden, true);
    assert.equal(page(teamView()).$('score').hidden, true);
    const p = page(scoreTeamFive());
    assert.equal(p.$('score').hidden, false);
    p.render({ detail: issueDetail(), team: { ...scoreTeamFive(), blocks: [], handoffs: [] } });
    assert.equal(p.$('score').hidden, true);
  });
});

describe('E3-7 score: scroll frame and lane column', () => {
  it('scrolls in its own frame with a minimum inner width of 760 px', () => {
    has('.score-frame', 'overflow-x: auto');
    has('.score-body', 'min-width: 760px');
    const p = page(scoreTeamFive());
    assert.equal(p.$('score-frame').getAttribute('tabindex'), '0');
    assert.equal(p.$('score-frame').getAttribute('aria-label'), 'Partitur: 5 Sessions, 4 Übergaben, Runde 2, horizontal scrollbar');
    assert.ok(p.$('score-axis').parentElement === p.$('score-frame'), 'the axis scrolls with the blocks');
  });

  it('has a fixed 120 px lane column with one 44 px row per role (dot 8 px, name 13 px)', () => {
    has('.score-lanes', 'width: 120px', 'flex: none');
    has('.score-lane', 'height: 44px', 'font-size: 13px', 'var(--fg-chip)');
    has('.score-dot', 'width: 8px', 'height: 8px');
    const t = scoreTeamFive();
    const p = page(t);
    const lanes = p.query('#score-lanes .score-lane');
    assert.deepEqual(lanes.map((l) => l.getAttribute('data-role')), t.seats.map((s: Obj) => s.role).filter((r: string) => r !== 'you'));
    assert.equal(lanes[2]!.querySelector('.score-dot')!.style.background, ROLE_COLORS.developer);
    assert.equal(lanes[2]!.textContent, 'Developer');
    assert.ok(!lanes.some((l) => l.textContent === 'Du'));
  });

  it('draws on a relative plot of lanes x 44 px with a left border', () => {
    has('.score-plot', 'position: relative', 'flex: 1', 'border-left: 1px solid rgba(255,255,255,.1)');
    const p = page(scoreTeamFive());
    assert.equal(p.$('score-plot').style.height, p.query('#score-lanes .score-lane').length * 44 + 'px');
  });
});

describe('E3-7 score: grid', () => {
  it('has vertical lines at 25/50/75 % and one horizontal line per lane bottom', () => {
    const p = page(scoreTeamFive());
    assert.deepEqual(p.query('#score .score-grid-v').map((g) => g.style.left), ['25%', '50%', '75%']);
    const lanes = p.query('#score-lanes .score-lane').length;
    assert.deepEqual(p.query('#score .score-grid-h').map((g) => g.style.top), Array.from({ length: lanes }, (_x, i) => (i + 1) * 44 - 1 + 'px'));
    has('.score-grid-v', 'rgba(255,255,255,.05)');
    has('.score-grid-h', 'rgba(255,255,255,.05)');
  });
});

describe('E3-7 score: stroke density', () => {
  const tick = (t: Obj) => page(t).query('#score .blk')[0]!;
  it('derives the --tick period from the tool calls per minute (4 to 14 px)', () => {
    assert.equal(tick(single(60, 10)).style.getPropertyValue('--tick'), '8px');
    assert.equal(tick(single(70, 10)).style.getPropertyValue('--tick'), '7px');
    assert.equal(tick(single(4, 4)).style.getPropertyValue('--tick'), '13px');
    assert.equal(tick(single(5, 10)).style.getPropertyValue('--tick'), '14px');
    assert.equal(tick(single(100000, 10)).style.getPropertyValue('--tick'), '4px');
    const quiet = tick(single(0, 10));
    assert.ok(quiet.classList.contains('quiet'));
    assert.equal(quiet.style.getPropertyValue('--tick'), '');
    assert.ok(num(tick(single(30, 10)).style.getPropertyValue('--tick')) < num(tick(single(10, 10)).style.getPropertyValue('--tick')), 'denser with more calls');
  });

  it('paints the strokes as ::before with a repeating gradient', () => {
    has('.blk::before', 'repeating-linear-gradient(90deg, rgba(255,255,255,.16) 0 1px, transparent 1px var(--tick, 7px))');
    has('.blk.quiet::before', 'content: none');
  });
});

describe('E3-7 score: handoff colours', () => {
  const colourOf = (verdict: string | null) => {
    const t = scoreTeamFive();
    t.handoffs = [{ from: 'developer', to: 'tester', verdict, at: iso('11:16') }];
    const h = page(t).query('#score .score-hand')[0]!;
    return [h.style.background, h.querySelector('.score-hand-label')!.textContent];
  };
  it('draws red verdicts in #f87171 and every other one in the sender colour', () => {
    for (const v of ['failed', 'request_changes', 'changes_needed', 'changes_requested', 'issues_found', 'blocked']) assert.deepEqual(colourOf(v), ['#f87171', v], v);
    for (const v of ['ready', 'approved', 'passed', 'implemented', 'done']) assert.deepEqual(colourOf(v), [ROLE_COLORS.developer, v], v);
    assert.deepEqual(colourOf(null), [ROLE_COLORS.developer, '—']);
  });

  it('has a 2 px line, a 5/5/7 px triangle and a 10.5 px mono label', () => {
    has('.score-hand', 'width: 2px');
    has('.score-arrow', 'border-left: 5px solid transparent', 'border-right: 5px solid transparent');
    has('.score-hand.down .score-arrow', 'border-top: 7px solid var(--c, currentColor)');
    has('.score-hand.up .score-arrow', 'border-bottom: 7px solid var(--c, currentColor)');
    has('.score-hand-label', '10.5px/1 var(--mono)');
  });

  it('skips handoffs within one lane or to an unknown lane', () => {
    const t = scoreTeamFive();
    t.handoffs.push({ from: 'developer', to: 'developer', verdict: 'done', at: iso('11:30') }, { from: 'ghost', to: 'developer', verdict: 'done', at: iso('11:30') });
    assert.equal(page(t).query('#score .score-hand').length, 4);
  });
});

describe('E3-7 score: "Jetzt" line', () => {
  it('draws the glowing line at the right edge only while a session runs', () => {
    assert.equal(page(scoreTeamFive({ live: true })).query('#score .score-now-line').length, 1);
    assert.equal(page(scoreTeamFive()).query('#score .score-now-line').length, 0);
    assert.equal(page(scoreTeamFive({ live: true }), { ended: true }).query('#score .score-now-line').length, 0);
    has('.score-now-line', 'right: 0', 'width: 2px', 'background: #34d399', 'box-shadow: 0 0 12px #34d399');
  });

  it('lets the running block reach the line and ends a finished issue with its last block', () => {
    const end = (b: any) => num(b.style.left) + num(b.style.width);
    const live = page(scoreTeamFive({ live: true })).query('#score .blk');
    assert.ok(Math.abs(end(live[4]) - 100) < 0.05);
    const done = page(scoreTeamFive()).query('#score .blk');
    assert.ok(Math.abs(end(done[4]) - 100) < 0.05);
  });
});

describe('E3-7 score: robustness', () => {
  it('renders roles and verdicts only as text', () => {
    const t = scoreTeamFive();
    t.blocks[1].role = '<img src=x>';
    t.blocks[2].verdict = '<b>x</b>';
    t.handoffs[0] = { from: '<img src=x>', to: 'developer', verdict: '<script>1</script>', at: iso('10:57') };
    const p = page(t);
    for (const tag of ['img', 'b', 'script']) assert.equal(p.query('#score ' + tag).length, 0, tag);
    assert.equal(p.query('#score .blk').length, 5);
  });

  it('gives an unknown role its own lane in the symphony colour', () => {
    const t = scoreTeamFive();
    t.blocks[1].role = 'ghost';
    const p = page(t);
    const lane = p.query('#score-lanes .score-lane').at(-1)!;
    assert.equal(lane.getAttribute('data-role'), 'ghost');
    assert.equal(lane.querySelector('.score-dot')!.style.background, ROLE_COLORS.symphony);
    assert.equal(p.query('#score .blk')[1]!.style.borderColor, ROLE_COLORS.symphony);
  });

  it('does not affect the stage', () => {
    const p = page(scoreTeamFive({ live: true }));
    assert.equal(p.$('stage').hidden, false);
    assert.equal(p.query('#stage-seats .stage-seat').length, 8);
  });
});
