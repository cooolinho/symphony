// E1-1: shell uses the full window width; side margin comes from the --edge token.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LAYOUT_CSS, page, AURORA } from '../src/http/ui/layout.ts';
import { TOKENS_CSS } from '../src/http/ui/tokens.ts';

const html = page({ title: 't', nav: 'overview', aurora: AURORA.overview, body: '', scripts: '' });
const ruleOf = (css: string, selector: string): string => {
  const at = css.indexOf(`\n  ${selector} {`);
  assert.ok(at >= 0, `${selector} rule`);
  return css.slice(at, css.indexOf('}', at));
};
const mediaOf = (css: string, query: string): string => {
  const at = css.indexOf(`@media (${query}) {`);
  assert.ok(at >= 0, query);
  return css.slice(at, css.indexOf('\n  }', at));
};

describe('E1-1: --edge, no max-width', () => {
  it('no 1440/1480 max-width left', () => {
    for (const s of [LAYOUT_CSS, TOKENS_CSS, html]) {
      assert.ok(!s.includes('max-width: 1440px'));
      assert.ok(!s.includes('max-width: 1480px'));
    }
  });
  it('--edge 16px in :root, 12px at <= 640px', () => {
    assert.ok(ruleOf(TOKENS_CSS, ':root').includes('--edge: 16px'));
    assert.ok(mediaOf(TOKENS_CSS, 'max-width: 640px').includes('--edge: 12px'));
  });
  it('.shell-wrap and main use --edge without max-width', () => {
    for (const r of [ruleOf(LAYOUT_CSS, '.shell-wrap'), ruleOf(TOKENS_CSS, 'main')]) {
      assert.ok(r.includes('var(--edge)'));
      assert.ok(!r.includes('max-width'));
    }
  });
  it('no fixed 12px side padding overrides', () => {
    for (const css of [LAYOUT_CSS, TOKENS_CSS]) {
      const m = mediaOf(css, 'max-width: 640px');
      assert.ok(!/padding-(left|right): 12px/.test(m));
    }
  });
  it('prefers-reduced-transparency unchanged', () => {
    assert.ok(LAYOUT_CSS.includes('@media (prefers-reduced-transparency: reduce)'));
    assert.ok(TOKENS_CSS.includes('@media (prefers-reduced-transparency: reduce)'));
    assert.ok(mediaOf(LAYOUT_CSS, 'prefers-reduced-transparency: reduce').includes('.aurora { display: none; }'));
  });
});
