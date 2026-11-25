// E1-1 (independent): the shell has no max-width anywhere and uses the --edge token as its side margin.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { CHANGES_HTML } from '../src/http/changes-page.ts';
import { AGENT_HTML } from '../src/http/issue-page.ts';
import { BRAIN_HTML } from '../src/http/brain-page.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { TASKS_HTML } from '../src/http/tasks-page.ts';
import { LAYOUT_CSS } from '../src/http/ui/layout.ts';
import { TOKENS_CSS } from '../src/http/ui/tokens.ts';

const PAGES: Record<string, string> = {
  overview: DASHBOARD_HTML, changes: CHANGES_HTML, issue: AGENT_HTML, brain: BRAIN_HTML, logs: LOGS_HTML, tasks: TASKS_HTML,
};

/** All top-level CSS rules (selector list + body) of a stylesheet, flattening @media blocks. */
const rules = (css: string): Array<{ sel: string; body: string; media: string }> => {
  const out: Array<{ sel: string; body: string; media: string }> = [];
  const walk = (src: string, media: string): void => {
    const re = /([^{}]+)\{([^{}]*)\}|([^{}]+)\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      if (m[1] !== undefined) { out.push({ sel: m[1].trim().replace(/\/\*[\s\S]*?\*\//g, '').trim(), body: m[2] ?? '', media }); continue; }
      // a block with nested rules (@media ...): find its matching brace
      const start = m.index + m[0].length;
      let depth = 1, i = start;
      while (i < src.length && depth) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++; }
      walk(src.slice(start, i - 1), (m[3] ?? '').trim());
      re.lastIndex = i;
    }
  };
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ''), '');
  return out;
};
const styleOf = (html: string): string => [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
const targets = (sel: string): boolean => sel.split(',').some((s) => /(^|[\s>+~])(main|\.shell-wrap)$/.test(s.trim()) || /^(main|\.shell-wrap)$/.test(s.trim()));

describe('E1-1 independent: full width, --edge', () => {
  for (const [name, html] of Object.entries(PAGES)) {
    describe(`page ${name}`, () => {
      it('no max-width 1440/1480 anywhere in the document', () => {
        assert.doesNotMatch(html, /max-width:\s*14(40|80)px/);
      });
      it('no max-width on main or .shell-wrap in any inline stylesheet', () => {
        const hits = rules(styleOf(html)).filter((r) => targets(r.sel) && /(^|[;\s])max-width\s*:\s*(?!none\b)/.test(r.body));
        assert.deepEqual(hits.map((h) => h.sel), []);
      });
      it('no rule resets main or .shell-wrap to fixed side padding or auto margins', () => {
        for (const r of rules(styleOf(html)).filter((x) => targets(x.sel))) {
          assert.doesNotMatch(r.body, /margin(-left|-right)?\s*:\s*[^;]*auto/, `${r.sel}: ${r.body}`);
          for (const m of r.body.matchAll(/padding-(left|right)\s*:\s*([^;]+)/g)) assert.match(m[2] ?? '', /var\(--edge\)/, `${r.sel}: ${m[0]}`);
        }
      });
      it('--edge is defined before the layout rules use it (tokens come first)', () => {
        const css = styleOf(html);
        assert.ok(css.indexOf('--edge: 16px') >= 0);
        assert.ok(css.indexOf('--edge: 16px') < css.indexOf('.shell-wrap {'));
      });
      it('--edge: exactly one 16px definition and one 12px override inside a max-width 640px query', () => {
        const css = styleOf(html);
        assert.equal(css.match(/--edge:\s*16px/g)?.length, 1);
        const defs = rules(css).filter((r) => /--edge\s*:/.test(r.body));
        assert.deepEqual(defs.map((d) => [d.sel, d.media, /--edge:\s*(\d+px)/.exec(d.body)?.[1]]),
          [[':root', '', '16px'], [':root', '@media (max-width: 640px)', '12px']]);
      });
    });
  }

  it('main uses --edge on both sides and keeps its 20px vertical padding', () => {
    const main = rules(TOKENS_CSS).find((r) => r.sel === 'main' && r.media === '' && /padding/.test(r.body));
    assert.ok(main);
    assert.match(main.body, /padding:\s*20px var\(--edge\)\s*;/);
  });
  it('.shell-wrap uses --edge on both sides and keeps 16px top / 48px bottom', () => {
    const w = rules(LAYOUT_CSS).find((r) => r.sel === '.shell-wrap' && r.media === '');
    assert.ok(w);
    assert.match(w.body, /padding:\s*16px var\(--edge\) 48px\s*;/);
  });
  it('--edge is not redefined outside the tokens (single source of truth)', () => {
    assert.doesNotMatch(LAYOUT_CSS, /--edge\s*:/);
  });

  it('no max-width 1440/1480 left in any src file', () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    for (const f of walk('src').filter((x) => /\.(ts|js|css|html)$/.test(x))) {
      assert.doesNotMatch(readFileSync(f, 'utf8'), /max-width:\s*14(40|80)px/, f);
    }
  });
  it('prefers-reduced-transparency blocks are still present in layout and tokens', () => {
    assert.match(LAYOUT_CSS, /@media \(prefers-reduced-transparency: reduce\)/);
    assert.match(TOKENS_CSS, /@media \(prefers-reduced-transparency: reduce\)/);
  });
});
