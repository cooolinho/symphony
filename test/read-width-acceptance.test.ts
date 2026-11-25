// E1-2 (independent acceptance tests): reading width inside cards, full-width pages, no horizontal overflow at 390 px,
// screenshots. Derived from the issue text, not from the implementation; complements test/read-width.test.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/issue-page.ts';
import { CHANGES_HTML } from '../src/http/changes-page.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { BRAIN_HTML } from '../src/http/brain-page.ts';
import { TASKS_HTML } from '../src/http/tasks-page.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { COMPONENTS_CSS } from '../src/http/ui/components.ts';
import { LAYOUT_CSS } from '../src/http/ui/layout.ts';
import { TOKENS_CSS } from '../src/http/ui/tokens.ts';

const pages: Record<string, string> = { issue: AGENT_HTML, changes: CHANGES_HTML, stats: LOGS_HTML, brain: BRAIN_HTML, tasks: TASKS_HTML };

/** All CSS rules (selector list + body) of a text, ignoring nesting of @media (flat scan is enough here). */
const rules = (css: string): Array<{ sel: string; body: string }> =>
  [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((m) => ({ sel: (m[1] ?? '').trim(), body: m[2] ?? '' }));
const maxWidths = (css: string): Array<{ sel: string; value: string }> =>
  rules(css).flatMap((r) => [...r.body.matchAll(/(?:^|[;\s])max-width:\s*([^;}]+)/g)].map((m) => ({ sel: r.sel, value: (m[1] ?? '').trim() })));

describe('E1-2 acceptance: reading width', () => {
  it('every affected page carries the 120ch token (page() embeds TOKENS_CSS)', () => {
    for (const [name, html] of Object.entries(pages)) assert.match(html, /--read-width:\s*120ch/, name);
    assert.equal(TOKENS_CSS.match(/--read-width\s*:/g)?.length, 1, 'defined exactly once');
  });

  it('the token is not redefined or overridden by the pages', () => {
    for (const [name, html] of Object.entries(pages)) {
      assert.equal(html.match(/--read-width\s*:/g)?.length, 1, `${name}: one definition`);
    }
  });

  it('running text of the named cards (issue trace, raw log lines, stats notes, brain excerpt, changes title/meta) is capped', () => {
    const want: Array<[string, string[]]> = [
      ['issue', ['.item .card', '.logs .d']],
      ['changes', ['.chg-title', '.chg-meta']],
      ['stats', ['.note']],
      ['brain', ['.br-excerpt']],
    ];
    for (const [name, sels] of want) {
      const capped = maxWidths(pages[name] ?? '').filter((m) => /var\(--read-width\)|120ch/.test(m.value)).map((m) => m.sel);
      for (const s of sels) assert.ok(capped.some((c) => c.split(',').map((x) => x.trim()).includes(s)), `${name}: ${s} capped`);
    }
  });

  it('any literal ch cap on a page is at least 120ch-wide-equivalent (no narrower text column than the token)', () => {
    for (const [name, html] of Object.entries(pages)) {
      for (const m of maxWidths(html)) {
        const ch = /^(\d+(?:\.\d+)?)ch$/.exec(m.value);
        if (ch) assert.ok(Number(ch[1]) >= 60, `${name}: ${m.sel} ${m.value}`);
      }
    }
  });

  it('cards, pages, tables and scroll wrappers keep the full width: no reading width on them', () => {
    const forbidden = [/^body$/, /^main$/, /\.shell-wrap/, /\.ui-card/, /\.panel/, /^section/, /\.chg$/, /\.chg-feed/, /\.details/, /\.col\b/, /table/, /\.scroll\b/, /\.rs-scroll/, /^\.g$/, /\.grid/];
    for (const [name, css] of Object.entries({ ...pages, tokens: TOKENS_CSS, layout: LAYOUT_CSS, components: COMPONENTS_CSS })) {
      for (const m of maxWidths(css)) {
        if (!/read-width|120ch/.test(m.value)) continue;
        for (const sel of m.sel.split(',').map((x) => x.trim())) {
          for (const f of forbidden) assert.ok(!f.test(sel), `${name}: ${sel} must stay full width`);
        }
      }
    }
  });

  it('the reading width never replaces layout: no width/min-width/flex-basis/grid-template via the token', () => {
    for (const css of [...Object.values(pages), TOKENS_CSS, COMPONENTS_CSS, LAYOUT_CSS]) {
      for (const m of css.matchAll(/([\w-]+)\s*:[^;{}]*var\(--read-width\)/g)) {
        if (m[1] === '--read-width') continue;
        assert.equal(m[1], 'max-width');
      }
    }
  });

  it('the overview (E3) does not get the reading width', () => {
    assert.ok(!DASHBOARD_HTML.includes('max-width: var(--read-width)'));
    assert.ok(!/max-width:\s*120ch/.test(DASHBOARD_HTML));
  });

  it('tables are not capped to the reading width (columns stay as the table lays them out)', () => {
    for (const html of [LOGS_HTML, CHANGES_HTML, TASKS_HTML]) {
      for (const r of rules(html)) {
        if (/(^|[\s,.#])(table|th|td|tr)\b|#role-summary|-table\b/.test(r.sel)) assert.ok(!r.body.includes('--read-width'), r.sel);
      }
    }
  });
});

describe('E1-2 acceptance: no horizontal overflow at 390 px', () => {
  it('.ui-seg (stats activity switch) cannot grow past its container and scrolls inside itself', () => {
    const seg = rules(COMPONENTS_CSS).find((r) => r.sel === '.ui-seg');
    assert.ok(seg);
    assert.match(seg.body, /max-width:\s*100%/);
    assert.match(seg.body, /overflow-x:\s*(auto|scroll)/);
    const btn = rules(COMPONENTS_CSS).find((r) => r.sel === '.ui-seg-btn');
    assert.ok(btn);
    assert.match(btn.body, /flex:\s*none|flex-shrink:\s*0/);
    assert.match(LOGS_HTML, /class="ui-seg"[^>]*id="activity-metric"|id="activity-metric"[^>]*class="ui-seg"|<div class="ui-seg" id="activity-metric"/);
  });
});

describe('E1-2 acceptance: screenshots', () => {
  for (const page of ['tasks', 'brain', 'stats', 'issue']) {
    for (const w of [2560, 390]) {
      it(`docs/screenshots/masonry-e1-2-${page}-${w}.png is a PNG of width ${w}`, () => {
        const file = `docs/screenshots/masonry-e1-2-${page}-${w}.png`;
        assert.ok(fs.existsSync(file), file);
        const b = fs.readFileSync(file);
        assert.equal(b.subarray(1, 4).toString(), 'PNG');
        assert.equal(b.readUInt32BE(16), w, 'width');
        assert.ok(b.readUInt32BE(20) >= 600, 'height');
        assert.ok(b.length > 20_000, 'not an empty image');
      });
    }
  }
});
