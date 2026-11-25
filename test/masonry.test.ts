import assert from 'node:assert/strict';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { MASONRY_CSS, MASONRY_JS } from '../src/http/ui/masonry.ts';
import { FakeElement, run, scriptContext } from './helpers/fake-dom.ts';

const rule = (selector: string): string => {
  const start = MASONRY_CSS.indexOf(selector + ' {');
  assert.ok(start >= 0, selector);
  return MASONRY_CSS.slice(start, MASONRY_CSS.indexOf('}', start));
};

describe('MASONRY_CSS', () => {
  it('container is a dense grid with 16 px column gap and no row gap', () => {
    const r = rule('.masonry');
    for (const d of [
      'display: grid',
      'grid-template-columns: repeat(auto-fill, minmax(min(380px, 100%), 1fr))',
      'row-gap: 0',
      'column-gap: 16px',
      'grid-auto-flow: row dense',
    ]) assert.ok(r.includes(d), d);
  });

  it('4 px rows apply only with the activation class (plain grid without spans)', () => {
    assert.ok(rule('.masonry.masonry-on').includes('grid-auto-rows: 4px'));
    assert.doesNotMatch(rule('.masonry'), /grid-auto-rows/);
  });

  it('cards have margin-bottom 16px', () => {
    assert.ok(rule('.masonry > *').includes('margin-bottom: 16px'));
  });

  it('.wide spans two columns only from 1220 px', () => {
    assert.match(MASONRY_CSS, /@media \(min-width: 1220px\) \{\s*\.masonry > \.wide \{ grid-column: span 2; \}\s*\}/);
    const without = MASONRY_CSS.replace(/@media[\s\S]*?\}\s*\}/, '');
    assert.doesNotMatch(without, /grid-column: span 2/);
  });

  it('uses neither columns nor grid-template-rows: masonry', () => {
    assert.doesNotMatch(MASONRY_CSS, /(^|[\s;{])columns\s*:/);
    assert.doesNotMatch(MASONRY_CSS, /grid-template-rows/);
  });
});

describe('MASONRY_JS', () => {
  it('is a valid script without forbidden APIs', () => {
    assert.doesNotThrow(() => new vm.Script(MASONRY_JS));
    assert.doesNotMatch(MASONRY_JS + MASONRY_CSS, /innerHTML|ResizeObserver/);
    const names = [...MASONRY_JS.matchAll(/^function\s+(\w+)/gm)].map((m) => m[1]!);
    assert.ok(names.length >= 2);
    for (const n of names) assert.match(n, /^masonry/);
  });

  it('has no side effects on load', () => {
    assert.doesNotThrow(() => scriptContext(MASONRY_JS));
  });

  it('masonrySpan computes ceil((height + gap) / unit)', () => {
    const ctx = scriptContext(MASONRY_JS);
    const span = (code: string): number => run(ctx, code);
    assert.equal(span('masonrySpan(100, 16, 4)'), 29);
    assert.equal(span('masonrySpan(101, 16, 4)'), 30);
    assert.equal(span('masonrySpan(100.5, 16, 4)'), 30);
    assert.equal(span('masonrySpan(0, 16, 4)'), 4);
    assert.equal(span('masonrySpan(100)'), 29);
    assert.equal(span('masonrySpan(100, 12, 8)'), 14);
    assert.equal(span('masonrySpan(-5)'), 4);
    assert.equal(span('masonrySpan(NaN)'), 4);
    assert.equal(span('masonrySpan(100, 16, 0)'), 29);
  });

  it('masonryApplySpan writes only on change and reports it', () => {
    const ctx = scriptContext(MASONRY_JS);
    const card = new FakeElement('div');
    ctx.card = card;
    assert.equal(run(ctx, 'masonryApplySpan(card, 29)'), true);
    assert.equal(card.style.gridRowEnd, 'span 29');
    assert.equal(card.dataset.masonrySpan, '29');
    card.style.gridRowEnd = 'x';
    assert.equal(run(ctx, 'masonryApplySpan(card, 29)'), false);
    assert.equal(card.style.gridRowEnd, 'x');
    assert.equal(run(ctx, 'masonryApplySpan(card, 30)'), true);
    assert.equal(card.style.gridRowEnd, 'span 30');
    for (const bad of ['0', '-1', '2.5', 'NaN']) {
      assert.equal(run(ctx, `masonryApplySpan(card, ${bad})`), false);
    }
    assert.equal(card.style.gridRowEnd, 'span 30');
  });
});
