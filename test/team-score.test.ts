import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/issue-page.ts';
import { ROLE_COLORS } from '../src/http/ui/tokens.ts';
import { renderPage } from './helpers.ts';
import type { FakeElement } from './helpers/fake-dom.ts';
import { issueDetail, scoreTeam, scoreTeamFive } from './helpers/page-fixtures.ts';

// E3-4 (#366), E3-7 (#386): the score (Partitur) of the team view under the stage, laid out like the mockup.

const AGENT_URL = 'http://127.0.0.1/issue?id=acme%2Fapp%231';
type Obj = Record<string, any>;
const score = (team?: Obj, extra: Obj = {}) => renderPage(AGENT_HTML, { detail: issueDetail(), ...(team ? { team } : {}), ...extra }, { url: AGENT_URL });
/** Renders with a frame of `width` px, so the 60-px text rule sees a real plot width. */
function wide(team: Obj, width: number, extra: Obj = {}) {
  const page = renderPage(AGENT_HTML, undefined, { url: AGENT_URL });
  (page.$('score-frame') as unknown as { clientWidth: number }).clientWidth = width;
  page.render({ detail: issueDetail(), team, ...extra });
  return page;
}
/** HH:MM of an ISO time in the local zone, as the page writes it. */
const hm = (iso: string) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const at = (t: string) => `2026-10-30T${t}.000Z`;
const num = (v: unknown) => parseFloat(String(v));
const blocks = (page: ReturnType<typeof score>) => page.query('#score .blk');
const text = (e: FakeElement) => e.querySelector('span')!.textContent;
/** Body of `@keyframes name { ... }` up to its closing double brace. */
const keyframes = (name: string) => AGENT_HTML.match(new RegExp('@keyframes ' + name + ' \\{([\\s\\S]*?\\})\\s*\\}'))?.[1] ?? '';
/** The declaration block of the stylesheet rule with exactly this selector. */
function rule(selector: string): string {
  const i = AGENT_HTML.indexOf('\n  ' + selector + ' {');
  assert.ok(i >= 0, 'rule ' + selector);
  return AGENT_HTML.slice(i, AGENT_HTML.indexOf('}', i) + 1);
}

describe('score: blocks, rounds, handoffs (five blocks, four handoffs)', () => {
  it('places the blocks in percent of the total duration and on their lane', () => {
    const page = score(scoreTeamFive());
    const all = blocks(page);
    assert.equal(all.length, 5);
    const expected = [[0, 7.5, 7], [7.5, 22.5, 51], [30, 25, 95], [55, 10, 139], [65, 35, 95]];
    all.forEach((b, i) => {
      const [left, width, top] = expected[i]!;
      assert.ok(Math.abs(num(b.style.left) - left!) < 0.05, 'left ' + i + ' ' + String(b.style.left));
      assert.ok(Math.abs(num(b.style.width) - width!) < 0.05, 'width ' + i + ' ' + String(b.style.width));
      assert.match(String(b.style.left), /%$/);
      assert.match(String(b.style.width), /%$/);
      assert.equal(b.style.top, top + 'px');
    });
    assert.equal(all[2]!.style.background, 'rgba(52,211,153,.24)');
    assert.equal(all[2]!.style.borderColor, ROLE_COLORS.developer);
    assert.equal(all[2]!.style.color ?? '', '');
    assert.ok(all[3]!.classList.contains('failed'));
    assert.equal(all[3]!.style.background, 'rgba(248,113,113,.22)');
    assert.equal(all[3]!.style.borderColor, '#f87171');
    assert.equal(all[3]!.style.color, '#fecaca');
    assert.equal(all.filter((b) => b.classList.contains('failed')).length, 1);
    const css = rule('.blk');
    for (const part of ['position: absolute', 'height: 30px', 'border-radius: 9px', 'padding: 0 10px', '500 12px', 'white-space: nowrap', 'overflow: hidden', 'var(--fg-strong)']) assert.ok(css.includes(part), part);
  });

  it('draws one dashed line at the start of round 2 with its label to the right', () => {
    const page = score(scoreTeamFive());
    const rounds = page.query('#score .score-round');
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0]!.getAttribute('data-round'), '2');
    assert.equal(rounds[0]!.style.left, '65.00%');
    const labels = page.query('#score .score-round-label');
    assert.deepEqual(labels.map((l) => l.textContent), ['Runde 2']);
    assert.equal(labels[0]!.style.left, 'calc(65.00% + 6px)');
    assert.ok(rule('.score-round').includes('top: -6px') && rule('.score-round').includes('border-left: 1px dashed rgba(251,191,36,.6)'));
    assert.ok(rule('.score-round-label').includes('11px var(--mono)') && rule('.score-round-label').includes('#fcd34d'));
    const one = scoreTeamFive();
    one.blocks[4].round = 1;
    assert.equal(score(one).query('#score .score-round').length, 0);
    const three = scoreTeamFive();
    three.blocks.push({ ...three.blocks[3], run: 'run-6', round: 3, started_at: at('11:34:00'), ended_at: at('11:38:00') });
    assert.deepEqual(score(three).query('#score .score-round-label').map((l) => l.textContent), ['Runde 2', 'Runde 3']);
  });

  it('labels a block with its verdict, hides the text below 60 px and keeps the title', () => {
    let page = wide(scoreTeamFive(), 1100);
    assert.deepEqual(blocks(page).map(text), ['ready', 'ready', 'done', 'failed', 'done']);
    page = wide(scoreTeamFive({ live: true }), 1100);
    assert.equal(text(blocks(page)[4]!), 'Runde 2 · spielt');
    // Without a measured frame the plot is 640 px: the analyst block (7.5 % = 48 px) loses its text.
    page = score(scoreTeamFive());
    assert.equal(text(blocks(page)[0]!), '');
    assert.equal(text(blocks(page)[3]!), 'failed');
    const narrow = scoreTeamFive();
    narrow.blocks[0].ended_at = at('10:55:00');
    const b = blocks(wide(narrow, 760))[0]!;
    assert.equal(text(b), '');
    assert.ok(b.title.startsWith('Analyst R1 · 1m 0s'));
  });

  it('gives each block the title "<Rolle> R<n> · <Dauer> · <Modell> · <Verdict>"', () => {
    const all = blocks(score(scoreTeamFive()));
    assert.equal(all[2]!.title, 'Developer R1 · 10m 0s · opus · done');
    assert.equal(all[3]!.title, 'Tester R1 · 4m 0s · sonnet · failed');
    for (const b of all) assert.equal(b.getAttribute('aria-label'), b.title);
    const live = blocks(score(scoreTeamFive({ live: true })));
    assert.equal(live[4]!.title, 'Developer R2 · 40m 0s · opus · läuft');
  });

  it('draws the four handoffs between the lane centres in their verdict colour', () => {
    const page = score(scoreTeamFive());
    const hands = page.query('#score .score-hand');
    assert.deepEqual(hands.map((h) => h.style.left), ['calc(7.50% - 1px)', 'calc(30.00% - 1px)', 'calc(55.00% - 1px)', 'calc(65.00% - 1px)']);
    assert.deepEqual(hands.map((h) => [h.style.top, h.style.height]), [['37px', '14px'], ['81px', '14px'], ['125px', '14px'], ['125px', '14px']]);
    assert.deepEqual(hands.map((h) => (h.classList.contains('down') ? 'down' : 'up')), ['down', 'down', 'down', 'up']);
    assert.deepEqual(hands.map((h) => h.style.background), [ROLE_COLORS.analyst, ROLE_COLORS.architect, ROLE_COLORS.developer, '#f87171']);
    assert.deepEqual(hands.map((h) => h.style.getPropertyValue('--c')), [ROLE_COLORS.analyst, ROLE_COLORS.architect, ROLE_COLORS.developer, '#f87171']);
    const labels = page.query('#score .score-hand-label');
    assert.deepEqual(labels.map((l) => l.textContent), ['ready', 'ready', 'done', 'failed']);
    assert.deepEqual(labels.map((l) => l.style.color), hands.map((h) => h.style.background));
    assert.equal(page.query('#score .score-hand .score-arrow').length, 4);
  });
});

describe('score: running block', () => {
  it('sets .now only on the open block of a running session', () => {
    const live = blocks(score(scoreTeamFive({ live: true })));
    assert.deepEqual(live.map((b) => b.classList.contains('now')), [false, false, false, false, true]);
    assert.equal(live[4]!.style.background, 'rgba(52,211,153,.42)');
    assert.equal(live[4]!.style.getPropertyValue('--glow'), 'rgba(52,211,153,.55)');
    assert.equal(blocks(score(scoreTeamFive())).filter((b) => b.classList.contains('now')).length, 0);
    assert.equal(blocks(score(scoreTeamFive({ live: true }), { ended: true })).filter((b) => b.classList.contains('now')).length, 0);
  });

  it('pulses the glow layer with opacity only', () => {
    const after = rule('.blk.now::after');
    assert.ok(after.includes('box-shadow: 0 0 22px var(--glow, transparent)'));
    assert.ok(after.includes('animation: score-glow 2.4s'));
    const body = keyframes('score-glow');
    assert.match(body, /opacity: \.3/);
    assert.match(body, /opacity: 1/);
    assert.doesNotMatch(body, /box-shadow|transform|filter/);
    for (const [, name] of AGENT_HTML.matchAll(/@keyframes ([\w-]+) \{/g)) assert.doesNotMatch(keyframes(name!), /box-shadow/, name!);
  });
});

describe('score: time axis', () => {
  it('shows five marks from start to end time when nothing runs', () => {
    const axis = score(scoreTeamFive()).query('#score-axis span');
    assert.deepEqual(axis.map((s) => s.textContent), ['10:54', '11:04', '11:14', '11:24', '11:34'].map((t) => hm(at(t + ':00'))));
    assert.equal(axis[4]!.classList.contains('now'), false);
  });

  it('ends with a green "jetzt HH:MM" only while a session runs', () => {
    const axis = score(scoreTeamFive({ live: true })).query('#score-axis span');
    assert.equal(axis.length, 5);
    assert.equal(axis[0]!.textContent, hm(at('10:54:00')));
    assert.equal(axis[4]!.textContent, 'jetzt ' + hm(at('12:00:00')));
    assert.ok(axis[4]!.classList.contains('now'));
    assert.equal(axis.filter((s) => s.classList.contains('now')).length, 1);
    const ended = score(scoreTeamFive({ live: true }), { ended: true }).query('#score-axis span');
    assert.ok(!String(ended[4]!.textContent).startsWith('jetzt'));
    const css = rule('.score-axis');
    for (const part of ['margin-left: 120px', '12px var(--mono)', 'var(--fg-3)']) assert.ok(css.includes(part), part);
    assert.ok(rule('.score-axis .now').includes('#6ee7b7'));
    // The marks sit at 0/25/50/75 % so they line up with the grid lines; the last one is right-aligned.
    assert.deepEqual(axis.slice(0, 4).map((s) => String(s.style.left)), ['0%', '25%', '50%', '75%']);
    assert.ok(rule('.score-axis span:last-child').includes('right: 0'));
  });

  it('spans at least one minute so a short block stays visible', () => {
    const team = scoreTeam();
    team.blocks = [{ ...team.blocks[0], started_at: at('11:00:00'), ended_at: at('11:00:10') }];
    team.handoffs = [];
    const page = score(team);
    assert.deepEqual(page.query('#score-axis span').map((s) => s.textContent), ['11:00:00', '11:00:15', '11:00:30', '11:00:45', '11:01:00'].map((t) => hm(at(t))));
    const b = blocks(page)[0]!;
    assert.ok(Math.abs(num(b.style.width) - 16.67) < 0.01, String(b.style.width));
    assert.equal(b.style.left, '0.00%');
  });
});

describe('score: caching', () => {
  it('rebuilds the plot only when the data changed', () => {
    const team = scoreTeamFive();
    const page = score(team);
    const first = blocks(page)[0];
    page.render({ detail: issueDetail(), team });
    assert.equal(blocks(page)[0], first);
    const changed = scoreTeamFive();
    changed.blocks[2].tool_calls = 40;
    page.render({ detail: issueDetail(), team: changed });
    assert.notEqual(blocks(page)[0], first);
  });
});
