// Independent checks of the masonry building block (#618), derived from the acceptance criteria only.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { MASONRY_CSS, MASONRY_JS } from '../src/http/ui/masonry.ts';

type Block = { selector: string; decls: Map<string, string>; media: string | null };

/** Minimal CSS reader: flat rules and one level of @media; whitespace tolerant. */
const parse = (css: string): Block[] => {
  const out: Block[] = [];
  const flat = (text: string, media: string | null): void => {
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const decls = new Map<string, string>();
      for (const d of m[2]!.split(';')) {
        const i = d.indexOf(':');
        if (i > 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim().replace(/\s+/g, ' '));
      }
      out.push({ selector: m[1]!.trim().replace(/\s+/g, ' '), decls, media });
    }
  };
  let rest = css;
  for (;;) {
    const at = rest.indexOf('@media');
    if (at < 0) break;
    const open = rest.indexOf('{', at);
    let depth = 1;
    let i = open + 1;
    while (depth > 0 && i < rest.length) depth += rest[i] === '{' ? 1 : rest[i] === '}' ? -1 : 0, i++;
    flat(rest.slice(0, at), null);
    flat(rest.slice(open + 1, i - 1), rest.slice(at + 6, open).trim());
    rest = rest.slice(i);
  }
  flat(rest, null);
  return out;
};

const blocks = parse(MASONRY_CSS);
const declsOf = (pred: (b: Block) => boolean): Map<string, string> => {
  const all = new Map<string, string>();
  for (const b of blocks.filter(pred)) for (const [k, v] of b.decls) all.set(k, v);
  return all;
};

interface Card {
  dataset: Record<string, string>;
  style: Record<string, string>;
}
const load = () => {
  const ctx = vm.createContext({ Math, Number, String });
  vm.runInContext(MASONRY_JS, ctx);
  return ctx as unknown as {
    masonrySpan: (h: number, g?: number, u?: number) => number;
    masonryApplySpan: (c: Card, s: number) => boolean;
  };
};
const newCard = (): Card => ({ dataset: {}, style: {} });

describe('masonry spec: CSS', () => {
  it('container selectors together carry every required grid declaration', () => {
    const d = declsOf((b) => /^\.masonry(\.[\w-]+)?$/.test(b.selector) && b.media === null);
    assert.equal(d.get('display'), 'grid');
    assert.equal(d.get('grid-template-columns'), 'repeat(auto-fill, minmax(min(380px, 100%), 1fr))');
    assert.equal(d.get('grid-auto-rows'), '4px');
    assert.equal(d.get('row-gap'), '0');
    assert.equal(d.get('column-gap'), '16px');
    assert.equal(d.get('grid-auto-flow'), 'row dense');
  });

  it('plain container (no activation class) stays a normal grid: no fixed 4 px rows', () => {
    const plain = blocks.find((b) => b.selector === '.masonry' && b.media === null);
    assert.ok(plain);
    assert.equal(plain.decls.get('display'), 'grid');
    assert.equal(plain.decls.has('grid-auto-rows'), false);
  });

  it('cards carry margin-bottom 16px, equal to column-gap', () => {
    const card = blocks.find((b) => b.decls.get('margin-bottom') === '16px');
    assert.ok(card);
    assert.match(card.selector, /^\.masonry\s*>\s*\*|\.masonry-card/);
  });

  it('.wide spans two columns, exclusively inside @media (min-width: 1220px)', () => {
    const wide = blocks.filter((b) => b.decls.get('grid-column') === 'span 2');
    assert.ok(wide.length >= 1);
    for (const w of wide) {
      assert.match(w.selector, /\.wide$/);
      assert.match(w.media ?? '', /^\(min-width:\s*1220px\)$/);
    }
    assert.equal(blocks.filter((b) => b.media === null && /\.wide/.test(b.selector)).length, 0);
  });

  it('avoids css columns and native masonry', () => {
    assert.doesNotMatch(MASONRY_CSS, /\bcolumn-count|(^|[;{\s])columns\s*:|masonry\s*;/);
  });
});

describe('masonry spec: span calculation', () => {
  const { masonrySpan } = load();

  it('matches the formula from the issue', () => {
    assert.equal(masonrySpan(100, 16, 4), 29);
    assert.equal(masonrySpan(84, 16, 4), 25);
    assert.equal(masonrySpan(0, 16, 4), 4);
  });

  it('rounds up, never down', () => {
    assert.equal(masonrySpan(85, 16, 4), 26);
    assert.equal(masonrySpan(82, 16, 4), 25);
    assert.equal(masonrySpan(0.1, 16, 4), 5);
  });

  it('honours gap and unit as parameters', () => {
    assert.equal(masonrySpan(100, 0, 10), 10);
    assert.equal(masonrySpan(100, 20, 10), 12);
    assert.equal(masonrySpan(33, 7, 8), 5);
  });

  it('defaults to 4 px unit and 16 px gap', () => {
    assert.equal(masonrySpan(100), 29);
    assert.equal(masonrySpan(0), 4);
  });

  it('is pure: same input, same output, no state change', () => {
    assert.equal(masonrySpan(321, 16, 4), masonrySpan(321, 16, 4));
    assert.equal(masonrySpan(321, 16, 4), 85);
  });
});

describe('masonry spec: applySpan', () => {
  it('first call writes grid-row-end and reports true', () => {
    const { masonryApplySpan } = load();
    const c = newCard();
    assert.equal(masonryApplySpan(c, 29), true);
    assert.equal(c.style['gridRowEnd'], 'span 29');
  });

  it('same value again does not write', () => {
    const { masonryApplySpan } = load();
    const c = newCard();
    masonryApplySpan(c, 29);
    let writes = 0;
    let value = c.style['gridRowEnd'];
    Object.defineProperty(c.style, 'gridRowEnd', {
      get: () => value,
      set: (v: string) => ((value = v), writes++),
    });
    assert.equal(masonryApplySpan(c, 29), false);
    assert.equal(masonryApplySpan(c, 29), false);
    assert.equal(writes, 0);
  });

  it('a changed value writes again, then is remembered', () => {
    const { masonryApplySpan } = load();
    const c = newCard();
    assert.equal(masonryApplySpan(c, 10), true);
    assert.equal(masonryApplySpan(c, 11), true);
    assert.equal(c.style['gridRowEnd'], 'span 11');
    assert.equal(masonryApplySpan(c, 11), false);
    assert.equal(masonryApplySpan(c, 10), true);
    assert.equal(c.style['gridRowEnd'], 'span 10');
  });

  it('remembers per card, not globally', () => {
    const { masonryApplySpan } = load();
    const a = newCard();
    const b = newCard();
    assert.equal(masonryApplySpan(a, 5), true);
    assert.equal(masonryApplySpan(b, 5), true);
    assert.equal(b.style['gridRowEnd'], 'span 5');
  });

  it('remembers the value in the dataset', () => {
    const { masonryApplySpan } = load();
    const c = newCard();
    masonryApplySpan(c, 7);
    assert.ok(Object.values(c.dataset).includes('7'));
  });
});

describe('masonry spec: constraints', () => {
  it('MASONRY_JS is a valid script and defines no clashing generic names', () => {
    assert.doesNotThrow(() => new vm.Script(MASONRY_JS));
    const ctx = vm.createContext({});
    vm.runInContext(MASONRY_JS, ctx);
    for (const k of Object.keys(ctx)) assert.match(k, /^(masonry|MASONRY_)/i, k);
  });

  it('is framework free: no innerHTML, observers, imports or requires', () => {
    assert.doesNotMatch(MASONRY_JS, /innerHTML|insertAdjacentHTML|MutationObserver|\brequire\(|\bimport\b/);
  });
});
