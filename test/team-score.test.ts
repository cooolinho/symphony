import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { ROLE_COLORS } from '../src/http/ui/tokens.ts';
import { renderPage } from './helpers.ts';
import { issueDetail, scoreTeam, teamView } from './helpers/page-fixtures.ts';

// E3-4 (#366): the score (Partitur) of the team view under the stage.

const AGENT_URL = 'http://127.0.0.1/issue?id=acme%2Fapp%231';
type Obj = Record<string, any>;
const score = (team?: Obj, extra: Obj = {}) => renderPage(AGENT_HTML, { detail: issueDetail(), ...(team ? { team } : {}), ...extra }, { url: AGENT_URL });
const T = (iso: string) => Date.parse(iso);

describe('score of the team view', () => {
  it('shows one lane per seat without "Du"; hidden without blocks or team', () => {
    const team = scoreTeam();
    const page = score(team);
    assert.equal(page.$('score').hidden, false);
    assert.ok(page.$('score-title').textContent!.startsWith('Partitur'));
    assert.equal(page.query('#score-frame svg').length, 1);
    assert.deepEqual(page.query('#score g.score-lane').map((g) => g.getAttribute('data-role')), team.seats.map((s: Obj) => s.role).filter((r: string) => r !== 'you'));
    assert.equal(score(teamView()).$('score').hidden, true);
    assert.equal(score().$('score').hidden, true);
  });

  it('picks the tick distance from the duration and keeps a minimum width of 600', () => {
    const page = score(scoreTeam());
    const svg = page.query('#score-frame svg')[0]!;
    assert.equal(svg.getAttribute('data-tick-min'), '5');
    assert.ok(Number(svg.getAttribute('width')) >= 600);
    const short = scoreTeam();
    short.blocks = [short.blocks[0]];
    short.blocks[0].ended_at = '2026-10-30T11:05:00.000Z';
    short.handoffs = [];
    assert.equal(score(short).query('#score-frame svg')[0]!.getAttribute('width'), '600');
    const ticks = page.query('#score g.score-tick').map((g) => Number(g.getAttribute('data-t')));
    assert.ok(ticks.length >= 9);
    for (let i = 1; i < ticks.length; i++) assert.equal(ticks[i]! - ticks[i - 1]!, 300000);
    const longer = (end: string) => { const t = scoreTeam(); t.blocks[2].ended_at = end; return score(t).query('#score-frame svg')[0]!; };
    assert.equal(longer('2026-10-30T13:30:00.000Z').getAttribute('data-tick-min'), '15');
    const six = longer('2026-10-31T11:30:00.000Z');
    assert.equal(six.getAttribute('data-tick-min'), '60');
    assert.ok(Number(six.getAttribute('width')) > 600);
  });

  it('draws a block per session in the role colour with tool strokes capped per minute', () => {
    const page = score(scoreTeam());
    const blocks = page.query('#score g.score-block');
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0]!.querySelector('rect')!.getAttribute('fill'), ROLE_COLORS.developer);
    assert.equal(blocks[0]!.querySelectorAll('line.score-call').length, 30);
    const heavy = scoreTeam();
    heavy.blocks[1].tool_calls = 1000;
    heavy.blocks[1].ended_at = '2026-10-30T11:22:00.000Z';
    assert.ok(score(heavy).query('#score g.score-block')[1]!.querySelectorAll('line.score-call').length <= 20);
    const events = [1, 5, 9].map((m) => ({ kind: 'agent', event: 'tool_use', run: 'run-1', at: new Date(T('2026-10-30T11:00:00Z') + m * 60000).toISOString() }));
    const withEvents = score(scoreTeam(), { events }).query('#score g.score-block')[0]!;
    const lines = withEvents.querySelectorAll('line.score-call');
    assert.equal(lines.length, 3);
    const rect = withEvents.querySelector('rect')!;
    const left = Number(rect.getAttribute('x')), right = left + Number(rect.getAttribute('width'));
    for (const l of lines) assert.ok(Number(l.getAttribute('x1')) >= left && Number(l.getAttribute('x1')) <= right);
  });

  it('draws handoff arrows with verdict labels and tones, and a dashed line per new round', () => {
    const team = scoreTeam();
    let page = score(team);
    const hand = page.query('#score g.score-handoff');
    assert.equal(hand.length, 2);
    assert.deepEqual(hand.map((g) => g.querySelector('text')!.textContent), ['done', 'request_changes']);
    assert.ok(/tone-gray/.test(hand[0]!.className) && /tone-red/.test(hand[1]!.className));
    team.handoffs[0].verdict = 'approve';
    page = score(team);
    assert.ok(/tone-green/.test(page.query('#score g.score-handoff')[0]!.className));
    const rounds = page.query('#score g.score-round');
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0]!.getAttribute('data-round'), '2');
    assert.equal(rounds[0]!.querySelector('text')!.textContent, 'Runde 2');
    assert.match(AGENT_HTML, /\.score-round line \{[^}]*stroke-dasharray/);
  });

  it('shows the "Jetzt" line only while a session runs', () => {
    const live = score(scoreTeam({ live: true }));
    const now = live.query('#score g.score-now');
    assert.equal(now.length, 1);
    assert.equal(now[0]!.querySelector('text')!.textContent, 'Jetzt');
    const svg = live.query('#score-frame svg')[0]!;
    assert.equal(Number(now[0]!.querySelector('line')!.getAttribute('x1')), Number(svg.getAttribute('width')) - 40);
    assert.equal(score(scoreTeam()).query('#score g.score-now').length, 0);
    assert.equal(score(scoreTeam({ live: true }), { ended: true }).query('#score g.score-now').length, 0);
  });

  it('gives each block a title and aria-label with role, duration, model and verdict', () => {
    const page = score(scoreTeam({ live: true }));
    const blocks = page.query('#score g.score-block');
    const first = blocks[0]!;
    assert.equal(first.querySelector('title')!.textContent, first.getAttribute('aria-label'));
    for (const part of ['Developer', 'Dauer 20m 0s', 'Modell opus', 'Verdict done']) assert.ok(first.getAttribute('aria-label')!.includes(part), part);
    assert.ok(blocks[2]!.getAttribute('aria-label')!.includes('Verdict läuft'));
  });

  it('scrolls horizontally in its own frame and has a text alternative', () => {
    assert.match(AGENT_HTML, /\.score-frame \{[^}]*overflow-x: auto/);
    const page = score(scoreTeam());
    assert.equal(page.query('#score-frame svg')[0]!.getAttribute('aria-label'), 'Partitur: 3 Sessions, 2 Übergaben, Runde 2');
    assert.ok(page.$('score-meta').textContent!.includes('3 Sessions'));
  });

  it('rebuilds the svg only when the data changed', () => {
    const team = scoreTeam();
    const page = score(team);
    const first = page.query('#score-frame svg')[0];
    page.render({ detail: issueDetail(), team });
    assert.equal(page.query('#score-frame svg')[0], first);
    const changed = scoreTeam();
    changed.blocks[2].tool_calls = 40;
    page.render({ detail: issueDetail(), team: changed });
    assert.notEqual(page.query('#score-frame svg')[0], first);
  });

  it('renders roles and verdicts only as text', () => {
    const team = scoreTeam();
    team.blocks[0].role = '<img src=x>';
    team.handoffs[0].from = '<img src=x>';
    team.handoffs[0].verdict = '<img src=x>';
    const page = score(team);
    assert.equal(page.query('#score img').length, 0);
  });
});
