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
  it('is a valid script without forbidden APIs (innerHTML, MutationObserver)', () => {
    assert.doesNotThrow(() => new vm.Script(MASONRY_JS));
    assert.doesNotMatch(MASONRY_JS + MASONRY_CSS, /innerHTML|MutationObserver/);
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

describe('masonryMount', () => {
  class RO {
    static instances: RO[] = [];
    observed = new Set<FakeElement>();
    observes = 0;
    unobserves = 0;
    cb: (entries: unknown[], ro: RO) => void;
    constructor(cb: (entries: unknown[], ro: RO) => void) {
      this.cb = cb;
      RO.instances.push(this);
    }
    observe(el: FakeElement): void {
      this.observed.add(el);
      this.observes++;
    }
    unobserve(el: FakeElement): void {
      this.observed.delete(el);
      this.unobserves++;
    }
    disconnect(): void {}
    fire(entries: unknown[]): void {
      this.cb(entries, this);
    }
  }
  const entry = (card: FakeElement, h: number) => ({ target: card, borderBoxSize: [{ blockSize: h }] });
  const setup = (n: number, hiddenIdx: number[] = [], withRO = true) => {
    RO.instances = [];
    const box = new FakeElement('div');
    box.className = 'masonry';
    const cards: FakeElement[] = [];
    for (let i = 0; i < n; i++) {
      const c = new FakeElement('div');
      c.hidden = hiddenIdx.includes(i);
      box.appendChild(c);
      cards.push(c);
    }
    const ctx = scriptContext(MASONRY_JS);
    if (withRO) ctx.ResizeObserver = RO;
    ctx.box = box;
    const handle = run(ctx, 'masonryMount(box)') as { refresh(): void };
    return { box, cards, handle, ro: RO.instances[0]! };
  };
  const countWrites = (card: FakeElement): { n: number } => {
    const count = { n: 0 };
    let v: unknown = '';
    Object.defineProperty(card.style, 'gridRowEnd', {
      get: () => v,
      set: (x) => {
        count.n++;
        v = x;
      },
      configurable: true,
    });
    return count;
  };

  it('creates one observer, observes visible cards only, activates the grid', () => {
    const { box, cards, handle, ro } = setup(3, [1]);
    assert.equal(RO.instances.length, 1);
    assert.deepEqual([...ro.observed], [cards[0], cards[2]]);
    assert.ok(box.classList.contains('masonry-on'));
    handle.refresh();
    assert.equal(ro.observes, 2);
  });

  it('callback applies span from borderBoxSize, else from the rect', () => {
    const { cards, ro } = setup(2);
    ro.fire([entry(cards[0]!, 100)]);
    assert.equal(cards[0]!.style.gridRowEnd, 'span 29');
    cards[1]!.getBoundingClientRect = () => ({ height: 84 }) as never;
    ro.fire([{ target: cards[1] }]);
    assert.equal(cards[1]!.style.gridRowEnd, 'span 25');
  });

  it('writes once for equal heights, again for a changed one', () => {
    const { cards, ro } = setup(1);
    const w = countWrites(cards[0]!);
    ro.fire([entry(cards[0]!, 100)]);
    ro.fire([entry(cards[0]!, 100)]);
    assert.equal(w.n, 1);
    ro.fire([entry(cards[0]!, 120)]);
    assert.equal(w.n, 2);
  });

  it('hidden cards are released and observed again once shown', () => {
    const { cards, handle, ro } = setup(1);
    ro.fire([entry(cards[0]!, 100)]);
    cards[0]!.hidden = true;
    handle.refresh();
    assert.equal(ro.unobserves, 1);
    assert.equal(cards[0]!.dataset.masonrySpan, undefined);
    cards[0]!.hidden = false;
    handle.refresh();
    assert.ok(ro.observed.has(cards[0]!));
    ro.fire([entry(cards[0]!, 100)]);
    assert.equal(cards[0]!.style.gridRowEnd, 'span 29');
    assert.ok(rule('.masonry > [hidden]').includes('display: none'));
  });

  it('removed cards are unobserved, new cards observed', () => {
    const { box, cards, handle, ro } = setup(2);
    box.removeChild(cards[0]!);
    handle.refresh();
    assert.equal(ro.unobserves, 1);
    assert.ok(!ro.observed.has(cards[0]!));
    const fresh = new FakeElement('div');
    box.appendChild(fresh);
    handle.refresh();
    assert.ok(ro.observed.has(fresh));
  });

  it('releases a removed card on its own callback without writing', () => {
    const { box, cards, ro } = setup(1);
    const w = countWrites(cards[0]!);
    box.removeChild(cards[0]!);
    ro.fire([entry(cards[0]!, 100)]);
    assert.equal(ro.unobserves, 1);
    assert.equal(w.n, 0);
  });

  it('without ResizeObserver: no error, no class, no span', () => {
    const { box, cards, handle } = setup(2, [], false);
    assert.ok(!box.classList.contains('masonry-on'));
    for (const c of cards) {
      assert.equal(c.style.gridRowEnd, undefined);
      assert.equal(c.dataset.masonrySpan, undefined);
    }
    assert.doesNotThrow(() => handle.refresh());
  });

  it('has no transition or animation', () => {
    assert.doesNotMatch(MASONRY_CSS + MASONRY_JS, /transition|animation/);
  });
});
