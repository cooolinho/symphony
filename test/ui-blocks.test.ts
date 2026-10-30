import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BASE_JS } from '../src/http/styles.ts';
import { TOKENS_CSS } from '../src/http/ui/tokens.ts';
import { FakeElement, scriptContext } from './helpers/fake-dom.ts';

const ctx = scriptContext(BASE_JS) as unknown as {
  ringGauge(o: object): FakeElement;
  sparkline(v?: unknown, o?: object): FakeElement;
  avatar(o: object): FakeElement;
};
const SVG = 'http://www.w3.org/2000/svg';
const value = (g: FakeElement): FakeElement => g.find((e) => e.classList.contains('gauge-value'))[0] as FakeElement;

describe('ringGauge', () => {
  it('sets --p, a monospace number and the label for 42 %', () => {
    const g = ctx.ringGauge({ percent: 42, label: 'Context' });
    assert.equal(g.style.getPropertyValue('--p'), '42');
    assert.equal(value(g).textContent, '42%');
    assert.ok(value(g).classList.contains('num'));
    assert.ok(g.textContent.includes('Context'));
    assert.ok((g.getAttribute('aria-label') as string).includes('42%'));
    assert.ok(g.classList.contains('tone-green'));
  });
  it('applies tones with a fallback and clamps the percentage', () => {
    assert.ok(ctx.ringGauge({ percent: 1, tone: 'amber' }).classList.contains('tone-amber'));
    assert.ok(ctx.ringGauge({ percent: 1, tone: 'nope' }).classList.contains('tone-green'));
    assert.equal(ctx.ringGauge({ percent: 150 }).style.getPropertyValue('--p'), '100');
    assert.equal(ctx.ringGauge({ percent: -5 }).style.getPropertyValue('--p'), '0');
  });
  it('shows a dash and a gray ring for null and NaN', () => {
    for (const percent of [null, NaN]) {
      const g = ctx.ringGauge({ percent, label: 'X' });
      assert.equal(value(g).textContent, '—');
      assert.ok(g.classList.contains('tone-gray') && g.classList.contains('is-empty'));
      assert.equal(g.style.getPropertyValue('--p'), '0');
      assert.ok((g.getAttribute('aria-label') as string).endsWith('no data'));
    }
  });
});

describe('sparkline', () => {
  it('creates an aria-hidden svg with a polyline inside the viewBox', () => {
    const s = ctx.sparkline([1, 3, 2], { width: 100, height: 20, tone: 'cyan' });
    assert.equal(s.tagName, 'svg');
    assert.equal(s.namespaceURI, SVG);
    assert.equal(s.getAttribute('aria-hidden'), 'true');
    assert.equal(s.getAttribute('viewBox'), '0 0 100 20');
    assert.ok((s.getAttribute('class') as string).includes('tone-cyan'));
    assert.equal(s.children.length, 1);
    const line = s.children[0] as FakeElement;
    assert.equal(line.tagName, 'polyline');
    assert.equal(line.namespaceURI, SVG);
    const pts = (line.getAttribute('points') as string).split(' ').map((p) => p.split(',').map(Number));
    assert.equal(pts.length, 3);
    for (const [x, y] of pts) {
      assert.ok(x! >= 0 && x! <= 100 && y! >= 0 && y! <= 20);
    }
  });
  it('handles constant, single and empty input without NaN or errors', () => {
    assert.ok(!(ctx.sparkline([5, 5, 5]).children[0]?.getAttribute('points') as string).includes('NaN'));
    assert.equal((ctx.sparkline([7]).children[0]?.getAttribute('points') as string).split(' ').length, 2);
    for (const v of [[], undefined, [NaN]]) assert.equal(ctx.sparkline(v).children.length, 0);
  });
});

describe('avatar', () => {
  it('playing carries pulse ring and equalizer, with role, title and aria-label', () => {
    const a = ctx.avatar({ role: 'developer', state: 'playing' });
    for (const c of ['avatar', 'role-developer', 'av-playing']) assert.ok(a.classList.contains(c), c);
    assert.equal(a.find((e) => e.classList.contains('ring')).length, 1);
    const eq = a.find((e) => e.classList.contains('eq'))[0] as FakeElement;
    assert.equal(eq.children.length, 3);
    assert.equal(a.getAttribute('title'), 'Developer · playing');
    assert.equal(a.getAttribute('aria-label'), 'Developer · playing');
    assert.equal(a.getAttribute('role'), 'img');
  });
  it('done has a check and no pulse; returned has a cross', () => {
    const a = ctx.avatar({ role: 'developer', state: 'done' });
    assert.ok(!a.classList.contains('av-playing'));
    assert.equal(a.find((e) => e.classList.contains('ring') || e.classList.contains('eq')).length, 0);
    assert.equal(a.find((e) => e.classList.contains('avatar-badge'))[0]?.textContent, '✓');
    const r = ctx.avatar({ role: 'tester', state: 'returned' });
    assert.equal(r.find((e) => e.classList.contains('avatar-badge'))[0]?.textContent, '✕');
  });
  it('maps waiting and skipped, falls back for unknown state, role and size', () => {
    assert.ok(ctx.avatar({ role: 'docs', state: 'waiting' }).classList.contains('av-waiting'));
    assert.ok(ctx.avatar({ role: 'docs', state: 'skipped' }).classList.contains('av-skipped'));
    assert.ok(ctx.avatar({ role: 'docs', state: 'bogus' }).classList.contains('av-waiting'));
    const u = ctx.avatar({ role: 'ghost', state: 'done' });
    assert.ok(!(u.getAttribute('class') as string).includes('role-'));
    assert.equal(ctx.avatar({ role: 'docs', state: 'done', size: 48 }).style.getPropertyValue('--av-size'), '48px');
    assert.equal(ctx.avatar({ role: 'docs', state: 'done', size: 'x' }).style.getPropertyValue('--av-size'), '36px');
  });
  it('treats the role as text, never as markup', () => {
    const a = ctx.avatar({ role: '<img src=x onerror=alert(1)>', state: 'done' });
    assert.ok((a.getAttribute('aria-label') as string).includes('<img src=x onerror=alert(1)>'));
    assert.equal(a.find((e) => e.classList.contains('avatar-face'))[0]?.children.length, 0);
  });
});

describe('block sources and styles', () => {
  it('the block code does not use innerHTML', () => {
    const start = BASE_JS.indexOf('const SVG_NS');
    const end = BASE_JS.indexOf('return root;', BASE_JS.indexOf('function avatar'));
    assert.ok(start > 0 && end > start);
    assert.ok(!BASE_JS.slice(start, end).includes('innerHTML'));
  });
  it('avatar and gauge styles add no animation of their own; reduced motion stops all', () => {
    const start = TOKENS_CSS.indexOf('/* Gauge, sparkline, avatar */');
    const section = TOKENS_CSS.slice(start, TOKENS_CSS.indexOf('@media (max-width: 640px)'));
    assert.ok(start > 0 && !/animation|transition|@keyframes/.test(section));
    assert.match(TOKENS_CSS, /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation: none !important/);
    for (const name of ['pulse-lg', 'eq']) {
      const body = (TOKENS_CSS.match(new RegExp(`@keyframes ${name} \\{([^\\n]*)\\}\\s*\\n`)) as RegExpMatchArray)[1] as string;
      assert.ok(body && !/(^|[^-\w])(left|top|width|height|margin|color|background)\s*:/.test(body), name);
    }
  });
});
