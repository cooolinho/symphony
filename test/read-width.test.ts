// E1-2: reading width (--read-width) for running text inside cards; cards and page stay full width.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/issue-page.ts';
import { CHANGES_HTML } from '../src/http/changes-page.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { BRAIN_HTML } from '../src/http/brain-page.ts';
import { TASKS_HTML } from '../src/http/tasks-page.ts';
import { COMPONENTS_CSS } from '../src/http/ui/components.ts';
import { LAYOUT_CSS } from '../src/http/ui/layout.ts';
import { TOKENS_CSS } from '../src/http/ui/tokens.ts';

const ruleOf = (css: string, selector: string): string => {
  const at = css.indexOf(`\n  ${selector} {`);
  assert.ok(at >= 0, `${selector} rule`);
  return css.slice(at, css.indexOf('}', at));
};
const READ = 'max-width: var(--read-width)';
const pages = [AGENT_HTML, CHANGES_HTML, LOGS_HTML, BRAIN_HTML, TASKS_HTML];

describe('E1-2: Lesebreite', () => {
  it('token --read-width: 120ch in :root', () => {
    assert.ok(ruleOf(TOKENS_CSS, ':root').includes('--read-width: 120ch'));
  });
  it('running text rules use the reading width', () => {
    const want: Array<[string, string[]]> = [
      [AGENT_HTML, ['.item .card', '.logs .d', '.alert .reason']],
      [CHANGES_HTML, ['.chg-title', '.chg-meta', '.chg-files', '.chg-diff']],
      [LOGS_HTML, ['.note', '.bh-text', '#footer']],
      [BRAIN_HTML, ['.br-excerpt']],
    ];
    for (const [html, selectors] of want) for (const s of selectors) assert.ok(ruleOf(html, s).includes(READ), s);
  });
  it('cards, page and main stay full width', () => {
    for (const [css, s] of [[LAYOUT_CSS, '.shell-wrap'], [TOKENS_CSS, 'main'], [CHANGES_HTML, '.chg'], [CHANGES_HTML, '.chg-feed']] as const) {
      assert.ok(!ruleOf(css, s).includes('max-width'), s);
    }
    for (const html of pages) {
      assert.ok(!/(\.chg-feed|\.details|\.ui-card|\.panel|section|\.g)\s*\{[^}]*--read-width/.test(html));
    }
  });
  it('--read-width only in max-width declarations', () => {
    for (const s of [...pages, TOKENS_CSS, COMPONENTS_CSS, LAYOUT_CSS]) {
      for (const m of s.matchAll(/([\w-]+):\s*var\(--read-width\)/g)) assert.equal(m[1], 'max-width');
    }
  });
  it('.ui-seg scrolls inside itself instead of overflowing', () => {
    const seg = ruleOf(COMPONENTS_CSS, '.ui-seg');
    assert.ok(seg.includes('max-width: 100%') && seg.includes('overflow-x: auto'));
    assert.ok(ruleOf(COMPONENTS_CSS, '.ui-seg-btn').includes('flex: none'));
  });
});
