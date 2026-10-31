import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/issue-page.ts';
import { renderPage } from './helpers.ts';
import { issueDetail, scoreTeam, scoreTeamFive } from './helpers/page-fixtures.ts';

// E3-7 (#386): independent checks derived from the acceptance criteria of the issue (not from the implementation).

const URL_ = 'http://127.0.0.1/issue?id=acme%2Fapp%231';
type Obj = Record<string, any>;
const page = (team: Obj, extra: Obj = {}) => renderPage(AGENT_HTML, { detail: issueDetail(), team, ...extra }, { url: URL_ });
const iso = (hhmm: string) => `2026-10-30T${hhmm}.000Z`;
const hm = (t: string) => new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const num = (v: unknown) => parseFloat(String(v));
/** All declaration blocks of rules whose selector list contains exactly this selector, joined. */
function rules(selector: string): string {
  const out: string[] = [];
  for (const m of AGENT_HTML.matchAll(/(^|\n)\s*([^{}\n@][^{}]*?)\s*\{([^{}]*)\}/g)) {
    if (m[2]!.split(',').map((s) => s.trim()).includes(selector)) out.push(m[3]!);
  }
  return out.join(' ');
}
const css = (selector: string) => rules(selector).replace(/\s+/g, ' ');

describe('#386 panel and scroll frame', () => {
  it('is a <section class="g"> with 20px 22px padding and a .lbl head with the start time', () => {
    assert.match(AGENT_HTML, /<section class="g[ "][^>]*id="score"/);
    assert.match(css('.score'), /padding:\s*20px 22px/);
    const p = page(scoreTeamFive());
    assert.ok(p.$('score-title').classList.contains('lbl'));
    assert.equal(p.$('score-title').textContent, 'Partitur · Ablauf seit ' + hm(iso('10:54:00')));
  });

  it('has the legend text in 12px --fg-2', () => {
    const p = page(scoreTeamFive());
    const legend = p.query('#score .score-legend li').map((l) => l.textContent).join(' · ');
    assert.equal(legend, 'Block = Session · Striche = Tool-Aufrufe · Pfeil = Übergabe mit Verdict');
    assert.match(css('.score-legend'), /font-size:\s*12px/);
    assert.match(css('.score-legend'), /color:\s*var\(--fg-2\)/);
  });

  it('scrolls horizontally in its frame with min-width 760px and a fixed 120px lane column', () => {
    assert.match(css('.score-frame'), /overflow-x:\s*auto/);
    assert.match(css('.score-body'), /min-width:\s*760px/);
    assert.match(css('.score-lanes'), /width:\s*120px/);
    assert.match(css('.score-lane'), /height:\s*44px/);
    assert.match(css('.score-lane'), /font-size:\s*13px/);
    assert.match(css('.score-lane'), /var\(--fg-chip\)/);
    assert.match(css('.score-dot'), /width:\s*8px/);
    assert.match(css('.score-plot'), /position:\s*relative/);
    assert.match(css('.score-plot'), /flex:\s*1/);
    assert.match(css('.score-plot'), /border-left:\s*1px solid rgba\(255,\s*255,\s*255,\s*\.1\)/);
  });

  it('sizes the plot to lanes x 44px and draws one row per role without "you"', () => {
    const t = scoreTeamFive();
    const p = page(t);
    const lanes = p.query('#score-lanes .score-lane');
    assert.equal(lanes.length, t.seats.filter((s: Obj) => s.role !== 'you').length);
    assert.equal(p.$('score-plot').style.height, lanes.length * 44 + 'px');
    for (const l of lanes) assert.ok(l.querySelector('.score-dot'));
  });
});

describe('#386 grid and rounds', () => {
  it('has vertical grid lines at 25/50/75 % and a horizontal line per lane in rgba(255,255,255,.05)', () => {
    const p = page(scoreTeamFive());
    assert.deepEqual(p.query('#score .score-grid-v').map((g) => g.style.left), ['25%', '50%', '75%']);
    assert.equal(p.query('#score .score-grid-h').length, p.query('#score-lanes .score-lane').length);
    assert.match(css('.score-grid-v'), /rgba\(255,\s*255,\s*255,\s*\.05\)/);
    assert.match(css('.score-grid-h'), /rgba\(255,\s*255,\s*255,\s*\.05\)/);
  });

  it('draws the dashed round line at the start of the first block of round 2', () => {
    const p = page(scoreTeamFive());
    const lines = p.query('#score .score-round');
    assert.equal(lines.length, 1);
    // 10:54 .. 11:34 = 40 min; round 2 starts 11:20 = 26 min = 65 %
    assert.ok(Math.abs(num(lines[0]!.style.left) - 65) < 0.05);
    assert.match(css('.score-round'), /top:\s*-6px/);
    assert.match(css('.score-round'), /border-left:\s*1px dashed rgba\(251,\s*191,\s*36,\s*\.6\)/);
    assert.match(css('.score-round-label'), /11px var\(--mono\)/);
    assert.match(css('.score-round-label'), /#fcd34d/i);
    assert.deepEqual(p.query('#score .score-round-label').map((l) => l.textContent), ['Runde 2']);
  });

  it('draws no round line for a single round', () => {
    const t = scoreTeamFive();
    for (const b of t.blocks) b.round = 1;
    assert.equal(page(t).query('#score .score-round').length, 0);
  });
});

describe('#386 blocks', () => {
  const blk = (p: ReturnType<typeof page>) => p.query('#score .blk');

  it('uses the .blk CSS from the issue', () => {
    const c = css('.blk');
    for (const re of [/position:\s*absolute/, /height:\s*30px/, /border-radius:\s*9px/, /padding:\s*0 10px/, /font:\s*500 12px/, /white-space:\s*nowrap/, /overflow:\s*hidden/, /var\(--fg-strong\)/]) assert.match(c, re);
  });

  it('positions blocks in percent of the total duration, top = lane x 44 + 7', () => {
    const t = scoreTeamFive();
    const p = page(t);
    const lanes = p.query('#score-lanes .score-lane').map((l) => l.getAttribute('data-role'));
    const total = Date.parse(iso('11:34:00')) - Date.parse(iso('10:54:00'));
    blk(p).forEach((b, i) => {
      const src = t.blocks[i];
      const s = Date.parse(src.started_at) - Date.parse(iso('10:54:00'));
      const e = Date.parse(src.ended_at) - Date.parse(iso('10:54:00'));
      assert.match(String(b.style.left), /%$/);
      assert.ok(Math.abs(num(b.style.left) - (s / total) * 100) < 0.05, 'left ' + i);
      assert.ok(Math.abs(num(b.style.width) - ((e - s) / total) * 100) < 0.05, 'width ' + i);
      assert.equal(b.style.top, lanes.indexOf(src.role) * 44 + 7 + 'px');
    });
  });

  it('colours: rgba(role,.24) with role border; failed red; running .42', () => {
    const p = page(scoreTeamFive());
    const [analyst, , , tester] = blk(p);
    assert.match(String(analyst!.style.background), /^rgba\(\d+,\s*\d+,\s*\d+,\s*\.24\)$/);
    assert.equal(tester!.style.background, 'rgba(248,113,113,.22)');
    assert.equal(tester!.style.borderColor, '#f87171');
    assert.equal(tester!.style.color, '#fecaca');
    const live = blk(page(scoreTeamFive({ live: true })));
    assert.match(String(live[4]!.style.background), /^rgba\(\d+,\s*\d+,\s*\d+,\s*\.42\)$/);
    assert.equal(live.filter((b) => b.classList.contains('failed')).length, 1);
  });

  it('labels with the verdict or "Runde n · spielt", hides text under 60 px', () => {
    const wide = (team: Obj) => {
      const p = renderPage(AGENT_HTML, undefined, { url: URL_ });
      (p.$('score-frame') as unknown as { clientWidth: number }).clientWidth = 1200;
      p.render({ detail: issueDetail(), team });
      return p;
    };
    assert.deepEqual(blk(wide(scoreTeamFive())).map((b) => b.textContent), ['ready', 'ready', 'done', 'failed', 'done']);
    assert.equal(blk(wide(scoreTeamFive({ live: true })))[4]!.textContent, 'Runde 2 · spielt');
    // minimal width: plot is >= 640px, a 1.5 % block is under 60 px
    const t = scoreTeamFive();
    t.blocks[0].ended_at = iso('10:54:30');
    const q = page(t);
    const first = blk(q)[0]!;
    assert.equal(first.textContent, '');
  });

  it('title = "<Rolle> R<n> · <Dauer> · <Modell> · <Verdict>"', () => {
    const b = blk(page(scoreTeamFive()));
    assert.equal(b[3]!.title, 'Tester R1 · 4m 0s · sonnet · failed');
    assert.equal(b[2]!.title, 'Developer R1 · 10m 0s · opus · done');
    assert.equal(b[4]!.title.split(' · ')[0], 'Developer R2');
  });

  it('--tick: 4..14 px, denser with more calls per minute', () => {
    const tick = (calls: number) => {
      const t = scoreTeam();
      t.blocks = [{ ...t.blocks[0], tool_calls: calls, started_at: iso('11:00:00'), ended_at: iso('11:10:00') }];
      t.handoffs = [];
      return num(page(t).query('#score .blk')[0]!.style.getPropertyValue('--tick'));
    };
    const vals = [10, 40, 80, 200, 5000].map(tick);
    for (const v of vals) assert.ok(v >= 4 && v <= 14, String(v));
    for (let i = 1; i < vals.length; i++) assert.ok(vals[i]! <= vals[i - 1]!);
    assert.ok(vals[0]! > vals.at(-1)!);
    assert.equal(vals.at(-1), 4);
    assert.match(css('.blk::before'), /repeating-linear-gradient\(90deg,\s*rgba\(255,\s*255,\s*255,\s*\.16\) 0 1px,\s*transparent 1px var\(--tick,\s*7px\)\)/);
  });
});

describe('#386 running block', () => {
  it('sets .now only on running blocks of a live session', () => {
    const live = page(scoreTeamFive({ live: true })).query('#score .blk');
    assert.deepEqual(live.map((b) => b.classList.contains('now')), [false, false, false, false, true]);
    assert.equal(page(scoreTeamFive()).query('#score .blk.now').length, 0);
  });

  it('::after has a fixed box-shadow 0 0 22px and its animation only changes opacity (.3 -> 1, 2.4s)', () => {
    const after = css('.blk.now::after');
    assert.match(after, /box-shadow:\s*0 0 22px/);
    const anim = after.match(/animation:\s*([\w-]+)\s+([\d.]+)s/);
    assert.ok(anim, 'animation declared');
    assert.equal(anim![2], '2.4');
    const kf = AGENT_HTML.match(new RegExp('@keyframes ' + anim![1] + ' \\{([\\s\\S]*?\\})\\s*\\}'))?.[1] ?? '';
    assert.match(kf, /opacity:\s*\.3/);
    assert.match(kf, /opacity:\s*1/);
    assert.doesNotMatch(kf, /box-shadow|transform|filter|width|height|left|top/);
    // no keyframes anywhere animate box-shadow
    for (const m of AGENT_HTML.matchAll(/@keyframes [\w-]+ \{([\s\S]*?\})\s*\}/g)) assert.doesNotMatch(m[1]!, /box-shadow/);
    // the running block itself has no animation on box-shadow
    assert.doesNotMatch(css('.blk.now'), /animation/);
    assert.doesNotMatch(css('.blk'), /animation|transition:[^;]*box-shadow/);
  });
});

describe('#386 handoffs', () => {
  it('2px line between lane centres, top = min(lane) x 44 + 37, height = |dlane| x 44 - 30', () => {
    const t = scoreTeamFive();
    const p = page(t);
    const lanes = p.query('#score-lanes .score-lane').map((l) => l.getAttribute('data-role'));
    const hands = p.query('#score .score-hand');
    assert.equal(hands.length, 4);
    hands.forEach((h, i) => {
      const a = lanes.indexOf(t.handoffs[i].from), z = lanes.indexOf(t.handoffs[i].to);
      assert.equal(h.style.top, Math.min(a, z) * 44 + 37 + 'px', 'top ' + i);
      assert.equal(h.style.height, Math.abs(z - a) * 44 - 30 + 'px', 'height ' + i);
    });
    assert.match(css('.score-hand'), /width:\s*2px/);
  });

  it('red verdicts are #f87171, ready/implemented use a non-red colour; label shows the verdict', () => {
    const p = page(scoreTeamFive());
    const hands = p.query('#score .score-hand');
    assert.equal(hands[3]!.style.background, '#f87171');
    for (const h of hands.slice(0, 3)) assert.notEqual(h.style.background, '#f87171');
    assert.deepEqual(p.query('#score .score-hand-label').map((l) => l.textContent), ['ready', 'ready', 'done', 'failed']);
    assert.match(css('.score-hand-label'), /10\.5px[^;]*var\(--mono\)/);
  });

  it('has a 5/5/7 px triangle at the target', () => {
    const arrows = css('.score-arrow') + ' ' + css('.score-hand.down .score-arrow') + ' ' + css('.score-hand.up .score-arrow');
    assert.match(arrows, /border-left:\s*5px solid transparent/);
    assert.match(arrows, /border-right:\s*5px solid transparent/);
    assert.match(arrows, /border-(top|bottom):\s*7px solid/);
    const p = page(scoreTeamFive());
    assert.equal(p.query('#score .score-arrow').length, 4);
  });
});

describe('#386 "Jetzt" line and time axis', () => {
  it('draws the glowing line only for a running session', () => {
    assert.equal(page(scoreTeamFive({ live: true })).query('#score .score-now-line').length, 1);
    assert.equal(page(scoreTeamFive()).query('#score .score-now-line').length, 0);
    const c = css('.score-now-line');
    assert.match(c, /width:\s*2px/);
    assert.match(c, /#34d399/i);
    assert.match(c, /box-shadow:\s*0 0 12px #34d399/i);
  });

  it('axis: Mono 11.5px --fg-3, margin-left 120px', () => {
    const c = css('.score-axis');
    assert.match(c, /11\.5px/);
    assert.match(c, /var\(--mono\)/);
    assert.match(c, /var\(--fg-3\)/);
    assert.match(c, /margin-left:\s*120px/);
  });

  it('axis: five marks, last one "jetzt HH:MM" in green only while running, else the end time', () => {
    const idle = page(scoreTeamFive()).query('#score-axis span');
    assert.equal(idle.length, 5);
    assert.equal(idle[0]!.textContent, hm(iso('10:54:00')));
    assert.equal(idle[4]!.textContent, hm(iso('11:34:00')));
    assert.ok(!idle.some((s) => /jetzt/.test(s.textContent)));
    const live = page(scoreTeamFive({ live: true })).query('#score-axis span');
    assert.equal(live.length, 5);
    assert.match(live[4]!.textContent, /^jetzt \d\d:\d\d$/);
    assert.equal(live.slice(0, 4).filter((s) => /jetzt/.test(s.textContent)).length, 0);
    assert.ok(live[4]!.classList.contains('now'), 'green class');
    assert.match(AGENT_HTML, /\.score-axis \.now\s*\{[^}]*color:\s*#(34d399|6ee7b7|4ade80|10b981)/i);
  });

  it('axis: a total duration under one minute is scaled to one minute', () => {
    const t = scoreTeam();
    t.blocks = [{ ...t.blocks[0], started_at: iso('11:00:00'), ended_at: iso('11:00:12') }];
    t.handoffs = [];
    const p = page(t);
    const marks = p.query('#score-axis span').map((s) => s.textContent);
    assert.equal(marks.length, 5);
    assert.equal(marks[4], hm(iso('11:01:00')));
    assert.equal(marks[0], hm(iso('11:00:00')));
    const b = p.query('#score .blk')[0]!;
    assert.ok(num(b.style.width) > 15 && num(b.style.width) < 25, String(b.style.width)); // 12 s of 60 s = 20 %
  });
});

describe('#386 robustness', () => {
  it('keeps the panel hidden without blocks', () => {
    const t = scoreTeamFive();
    t.blocks = [];
    t.handoffs = [];
    assert.equal(page(t).$('score').hidden, true);
  });

  it('keeps the frame keyboard-focusable and labelled', () => {
    const f = page(scoreTeamFive()).$('score-frame');
    assert.equal(f.getAttribute('tabindex'), '0');
    assert.ok(String(f.getAttribute('aria-label')).length > 0);
  });
});
