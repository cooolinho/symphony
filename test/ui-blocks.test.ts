import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COMPONENTS_CSS } from '../src/http/ui/components.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { TOKENS_CSS } from '../src/http/ui/tokens.ts';
import { FakeElement, domContext, run } from './helpers/fake-dom.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ctx = domContext(BASE_JS);
const make = (code: string): FakeElement => run(ctx, code);
const has = (e: FakeElement, ...cls: string[]): boolean => cls.every((c) => e.classList.contains(c));
const first = (root: FakeElement, cls: string): FakeElement | undefined => root.byClass(cls)[0];
const tags = (root: FakeElement, tag: string): FakeElement[] => root.find((e) => e.tagName === tag);

/** Rule bodies of a stylesheet whose selector list contains exactly the given selector (whitespace normalised). */
function rule(css: string, selector: string): string {
  const out: string[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1]!.split(',').some((s) => s.trim().replace(/\s+/g, ' ') === selector)) out.push(m[2]!.replace(/\s+/g, ' '));
  }
  assert.ok(out.length, `rule ${selector}`);
  return out.join(';');
}

describe('sparkline', () => {
  it('is an aria-hidden svg 0 0 100 24 with one 1.6 px non-scaling polyline', () => {
    const s = make('sparkline([1, 3, 2], "#7dd3fc")');
    assert.equal(s.tagName, 'svg');
    assert.equal(s.namespaceURI, SVG_NS);
    assert.equal(s.getAttribute('viewBox'), '0 0 100 24');
    assert.equal(s.getAttribute('preserveAspectRatio'), 'none');
    assert.equal(s.getAttribute('aria-hidden'), 'true');
    assert.equal(s.getAttribute('class'), 'ui-spark');
    assert.equal(s.children.length, 1);
    const line = s.children[0]!;
    assert.equal(line.tagName, 'polyline');
    assert.equal(line.namespaceURI, SVG_NS);
    assert.equal(line.getAttribute('stroke'), '#7dd3fc');
    assert.equal(line.getAttribute('stroke-width'), '1.6');
    assert.equal(line.getAttribute('vector-effect'), 'non-scaling-stroke');
    assert.equal(line.getAttribute('stroke-linejoin'), 'round');
    assert.equal(line.getAttribute('fill'), 'none');
    const pts = line.getAttribute('points')!.split(' ').map((p) => p.split(',').map(Number));
    assert.equal(pts.length, 3);
    for (const [x, y] of pts) assert.ok(x! >= 0 && x! <= 100 && y! >= 0 && y! <= 24, `${x},${y}`);
    assert.ok(pts[1]![1]! < pts[0]![1]!, 'the maximum is drawn at the top');
  });
  it('handles constant and single values; no colour uses currentColor', () => {
    assert.ok(!make('sparkline([5, 5, 5])').children[0]!.getAttribute('points')!.includes('NaN'));
    assert.equal(make('sparkline([7])').children[0]!.getAttribute('points')!.split(' ').length, 2);
    assert.equal(make('sparkline([1, 2], "red")').children[0]!.getAttribute('stroke'), 'currentColor');
  });
  it('an empty series gives no svg', () => {
    for (const v of ['[]', 'undefined', '[NaN]', '"abc"', '[null, "1"]']) assert.equal(run(ctx, `sparkline(${v})`), null, v);
  });
  it('CSS: block, full width, 24 px high', () => assert.match(rule(COMPONENTS_CSS, '.ui-spark'), /display: block; width: 100%; height: 24px/));
});

describe('ring', () => {
  it('draws a conic-gradient of pct around the inner icon with a percentage badge and an aria-label', () => {
    const r = make('ring(71, { color: "#fbbf24", inner: icon("developer", 34), label: "Developer playing, Context" })');
    assert.ok(has(r, 'ui-ring'));
    assert.equal(r.getAttribute('role'), 'img');
    assert.equal(r.getAttribute('aria-label'), 'Developer playing, Context, 71 percent');
    assert.equal(r.style.width, '96px');
    assert.equal(r.style.height, '96px');
    assert.equal(r.style.background, 'conic-gradient(#fbbf24 0 71%, rgba(255,255,255,.1) 71% 100%)');
    const inner = first(r, 'ui-ring-in')!;
    assert.equal(inner.children[0]!.tagName, 'svg');
    const badge = first(r, 'ui-ring-pct')!;
    assert.ok(has(badge, 'mono', 'hot'));
    assert.equal(badge.textContent, '71%');
  });
  it('below 70 % the badge is sky and the default ring colour too', () => {
    const r = make('ring(42)');
    assert.ok(!has(first(r, 'ui-ring-pct')!, 'hot'));
    assert.equal(r.style.background, 'conic-gradient(var(--sky-300) 0 42%, rgba(255,255,255,.1) 42% 100%)');
    assert.match(make('ring(70)').style.background as string, /^conic-gradient\(var\(--amber-400\) 0 70%/);
    assert.equal(r.getAttribute('aria-label'), '42 percent');
  });
  it('null shows a dash without progress', () => {
    for (const v of ['null', 'NaN', 'undefined', '"50"']) {
      const r = make(`ring(${v}, { label: "Context" })`);
      assert.ok(has(r, 'is-empty'), v);
      assert.equal(first(r, 'ui-ring-pct')!.textContent, '—');
      assert.match(r.style.background as string, / 0 0%, /);
      assert.equal(r.getAttribute('aria-label'), 'Context, no data');
    }
  });
  it('clamps and takes a size', () => {
    assert.equal(first(make('ring(250)'), 'ui-ring-pct')!.textContent, '100%');
    assert.equal(first(make('ring(-3)'), 'ui-ring-pct')!.textContent, '0%');
    assert.equal(make('ring(10, { size: 64 })').style.width, '64px');
    assert.equal(make('ring(10, { size: "x" })').style.width, '96px');
  });
  it('CSS: padding 5 px, badge mono 11 px; hot amber on #3b2a06, else sky', () => {
    assert.ok(rule(COMPONENTS_CSS, '.ui-ring').includes('padding: 5px'));
    const pct = rule(COMPONENTS_CSS, '.ui-ring-pct');
    for (const v of ['font-size: 11px', 'left: 50%', 'transform: translateX(-50%)', 'border: 1px solid var(--sky-300)', 'color: var(--sky-100)']) assert.ok(pct.includes(v), v);
    const hot = rule(COMPONENTS_CSS, '.ui-ring-pct.hot');
    for (const v of ['background: var(--ink-amber)', 'border-color: var(--amber-400)', 'color: var(--amber-200)']) assert.ok(hot.includes(v), v);
    assert.match(TOKENS_CSS, /--ink-amber: #3b2a06;/);
  });
});

describe('avatar', () => {
  const STATES = ['done', 'playing', 'waiting', 'returned', 'skipped'];

  it('in all five states: classes, role, title "Role · state", short name; ring and equalizer only when playing', () => {
    for (const st of STATES) {
      const a = make(`avatar("developer", "${st}")`);
      assert.equal(a.tagName, 'span');
      assert.ok(has(a, 'ui-av', 'ui-av-30', 'is-' + st), st);
      assert.equal(a.getAttribute('role'), 'img');
      assert.equal(a.getAttribute('title'), 'Developer · ' + st);
      assert.equal(a.getAttribute('aria-label'), 'Developer · ' + st);
      assert.equal(first(a, 'ui-av-face')!.textContent, 'DE');
      assert.equal(a.byClass('ring').length, st === 'playing' ? 1 : 0, st);
      assert.equal(a.byClass('eq').length, st === 'playing' ? 1 : 0, st);
      assert.equal(a.byClass('ui-av-badge').length, 0, 'no badge at 30 px');
    }
  });
  it('playing glows in the role colour with pulse ring and equalizer', () => {
    const a = make('avatar("developer", "playing")');
    assert.equal(a.style.background, 'rgba(52,211,153,.32)');
    assert.equal(a.style.borderColor, '#34d399');
    assert.equal(a.style.boxShadow, '0 0 18px rgba(52,211,153,.6)');
    const ring = first(a, 'ring')!;
    assert.equal(ring.style.color, '#34d399');
    assert.equal(ring.getAttribute('aria-hidden'), 'true');
    assert.equal(tags(first(a, 'eq')!, 'i').length, 4);
    assert.equal(first(a, 'eq')!.style.color, '#34d399');
  });
  it('done is tinted; waiting, returned and skipped are styled by CSS only', () => {
    const d = make('avatar("developer", "done")');
    assert.equal(d.style.background, 'rgba(52,211,153,.16)');
    assert.equal(d.style.color, '#34d399');
    assert.equal(d.style.borderColor, 'rgba(52,211,153,.55)');
    for (const st of ['waiting', 'returned', 'skipped']) assert.equal(make(`avatar("developer", "${st}")`).style.background, undefined, st);
  });
  it('64 / 96 px show the role icon (26 / 34 px); done gets a check badge, returned a cross badge', () => {
    const d = make('avatar("analyst", "done", { size: 64 })');
    assert.ok(has(d, 'ui-av-64'));
    assert.equal(d.children[0]!.tagName, 'svg');
    assert.equal(d.children[0]!.getAttribute('width'), '26');
    const badge = first(d, 'ui-av-badge')!;
    assert.equal(badge.children[0]!.tagName, 'svg');
    assert.equal(badge.children[0]!.getAttribute('width'), '12');
    assert.equal(badge.children[0]!.children[0]!.getAttribute('d'), 'M5 12.5l4.5 4.5L19 7.5');
    const r = make('avatar("tester", "returned", { size: 96 })');
    assert.equal(r.children[0]!.getAttribute('width'), '34');
    const x = first(r, 'ui-av-badge')!;
    assert.ok(has(x, 'is-x'));
    assert.equal(x.children[0]!.getAttribute('width'), '11');
    for (const st of ['waiting', 'skipped', 'playing']) assert.equal(make(`avatar("tester", "${st}", { size: 96 })`).byClass('ui-av-badge').length, 0, st);
    assert.ok(has(first(make('avatar("tester", "playing", { size: 96 })'), 'ring')!, 'ring-lg'));
  });
  it('knows the short names of all roles; subagents take a given short name', () => {
    const want = { analyst: 'AN', architect: 'AR', developer: 'DE', tester: 'TE', docs: 'DO', reviewer: 'RE', security: 'SE', symphony: 'SY', human: 'HU' };
    for (const [role, short] of Object.entries(want)) assert.equal(first(make(`avatar("${role}", "done")`), 'ui-av-face')!.textContent, short, role);
    const ex = make('avatar("explore", "playing", { short: "EX" })');
    assert.equal(first(ex, 'ui-av-face')!.textContent, 'EX');
    assert.equal(ex.style.borderColor, '#94a3b8');
    assert.equal(ex.getAttribute('title'), 'Explore · playing');
    assert.equal(first(make('avatar("trace", "done")'), 'ui-av-face')!.textContent, 'TR');
  });
  it('falls back for unknown state and size; treats the role as text', () => {
    assert.ok(has(make('avatar("developer", "dancing")'), 'is-waiting'));
    assert.ok(has(make('avatar("developer", "done", { size: "x" })'), 'ui-av-30'));
    const a = make('avatar("<img src=x onerror=alert(1)>", "done")');
    assert.equal(a.find((e) => e.tagName === 'img').length, 0);
    assert.equal(a.getAttribute('title'), '<img src=x onerror=alert(1)> · done');
  });
  it('CSS: short name mono 10.5 px / 600, waiting / skipped dashed, returned red, badge 22 px with a 2 px #0b1222 rim', () => {
    assert.match(rule(COMPONENTS_CSS, '.ui-av-face'), /font: 600 10\.5px\/1 var\(--mono\)/);
    assert.match(rule(COMPONENTS_CSS, '.ui-av.is-waiting'), /dashed/);
    const sk = rule(COMPONENTS_CSS, '.ui-av.is-skipped');
    assert.ok(sk.includes('dashed') && sk.includes('var(--fg-mute)'));
    const ret = rule(COMPONENTS_CSS, '.ui-av.is-returned');
    assert.ok(ret.includes('var(--red-300)'));
    assert.match(ret, /rgba\(248, 113, 113/);
    const badge = rule(COMPONENTS_CSS, '.ui-av-badge');
    for (const v of ['width: 22px', 'height: 22px', 'background: var(--green-400)', 'border: 2px solid var(--ink-ring)']) assert.ok(badge.includes(v), v);
    assert.match(TOKENS_CSS, /--ink-ring: #0b1222;/);
    assert.ok(rule(COMPONENTS_CSS, '.ui-av-badge.is-x').includes('background: var(--red-400)'));
  });
});

describe('eq', () => {
  it('has 4 bars, large 5; aria-hidden', () => {
    const e = make('eq()');
    assert.equal(e.tagName, 'span');
    assert.equal(e.className, 'eq');
    assert.equal(e.getAttribute('aria-hidden'), 'true');
    assert.equal(e.children.length, 4);
    assert.ok(e.children.every((c) => c.tagName === 'i'));
    const l = make('eq({ large: true })');
    assert.ok(has(l, 'eq', 'eq-lg'));
    assert.equal(l.children.length, 5);
  });
  it('CSS: 3×14 px bars (large 4×18) in currentColor; keyframes only touch transform and opacity', () => {
    assert.match(rule(TOKENS_CSS, '.eq i'), /width: 3px; height: 14px;[^;]*; background: currentColor/);
    assert.match(rule(TOKENS_CSS, '.eq-lg i'), /width: 4px; height: 18px/);
    for (const name of ['eq', 'pulse']) {
      const at = TOKENS_CSS.indexOf('@keyframes ' + name + ' ');
      assert.ok(at >= 0, name);
      const body = TOKENS_CSS.slice(at, TOKENS_CSS.indexOf('}\n', at) + 1);
      for (const m of body.matchAll(/([\w-]+)\s*:/g)) assert.match(m[1]!, /^(transform|opacity)$/, `${name}: ${m[1]}`);
    }
  });
});
