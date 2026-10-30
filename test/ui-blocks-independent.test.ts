import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ICON_NAMES } from '../src/http/icons.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { TOKENS_CSS } from '../src/http/ui/tokens.ts';
import { FakeElement, domContext, run } from './helpers/fake-dom.ts';

// Independent acceptance tests of E1-9, derived from the issue text (values of the mockup), not from the code.

const ctx = domContext(BASE_JS);
const make = (code: string): FakeElement => run(ctx, code);
const val = (code: string): any => run(ctx, code);
const cls = (e: FakeElement): string[] => e.className.split(/\s+/).filter(Boolean);
const norm = (s: string): string => s.replace(/\s+/g, '').replace(/(?<!\d)0\./g, '.').toLowerCase();
const attr = (e: FakeElement, k: string): string | null => e.getAttribute(k);
const tags = (e: FakeElement): string[] => e.descendants().map((d) => d.tagName);

/** All CSS (TOKENS_CSS includes the component CSS) without comments, with var(--x) resolved from :root. */
const css = TOKENS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const rootVars = new Map<string, string>();
for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) if (!rootVars.has(m[1]!)) rootVars.set(m[1]!, m[2]!.trim());
function resolve(v: string): string {
  let out = v;
  for (let i = 0; i < 6; i++) out = out.replace(/var\((--[\w-]+)(?:\s*,\s*[^)]*)?\)/g, (_, n) => rootVars.get(n) ?? `var(${n})`);
  return out;
}
/** Declarations (normalised, vars resolved) of every rule whose selector list contains the selector. */
function rules(selector: string): string {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1]!.split(',').some((s) => s.trim().replace(/\s+/g, ' ') === selector)) out.push(norm(resolve(m[2]!)));
  }
  assert.ok(out.length, `CSS rule ${selector} exists`);
  return out.join(';');
}
const has = (decl: string, wanted: string): boolean => decl.includes(norm(wanted));

describe('Chip', () => {
  it('is a nowrap pill 3x10, radius 999, 12px with the neutral border and ground', () => {
    const c = make(`chip('LIVE')`);
    assert.ok(c.textContent.includes('LIVE'));
    const r = rules('.ui-chip');
    for (const d of ['padding: 3px 10px', 'border-radius: 999px', 'font-size: 12px', 'white-space: nowrap',
      'rgba(255,255,255,.12)', 'rgba(255,255,255,.05)']) assert.ok(has(r, d), d);
  });
  it('tint LIVE #6ee7b7 / rgba(52,211,153,.4) / .1 from one colour', () => {
    const c = make(`chip('LIVE', { tone: '#34d399' })`);
    assert.equal(norm(String(c.style.borderColor)), 'rgba(52,211,153,.4)');
    assert.equal(norm(String(c.style.background)), 'rgba(52,211,153,.1)');
    assert.ok(String(c.style.color).length > 0, 'light text colour set');
    const named = make(`chip('LIVE', { tone: 'green' })`);
    assert.equal(norm(String(named.style.color)), '#6ee7b7');
    assert.equal(norm(String(named.style.borderColor)), 'rgba(52,211,153,.4)');
    assert.equal(norm(String(named.style.background)), 'rgba(52,211,153,.1)');
  });
  it('untinted chip carries no inline colours; mono adds the mono class; dot is 8px and in front', () => {
    const plain = make(`chip('x')`);
    assert.ok(!plain.style.borderColor && !plain.style.background);
    assert.ok(cls(make(`chip('x', { mono: true })`)).includes('mono'));
    assert.ok(!cls(plain).includes('mono'));
    const d = make(`chip('x', { dot: '#34d399' })`);
    const dot = d.children[0]!;
    assert.equal(dot.textContent, '');
    assert.ok(cls(dot).some((c) => c.includes('dot')));
    assert.equal(attr(dot, 'aria-hidden'), 'true');
    assert.ok(has(rules('.ui-dot'), 'width: 8px') && has(rules('.ui-dot'), 'height: 8px'));
  });
  it('text and hostile colour values never reach markup', () => {
    const c = make(`chip('<b>x</b>', { tone: 'red; background:url(x)' })`);
    assert.equal(c.textContent, '<b>x</b>');
    assert.ok(!String(c.style.color ?? '').includes('url'));
  });
});

describe('Button', () => {
  it('default is a real button type=button, 44px with min-width 44', () => {
    const b = make(`button('Go')`);
    assert.equal(b.tagName, 'button');
    assert.equal(attr(b, 'type'), 'button');
    assert.equal(b.textContent, 'Go');
    const r = rules('.ui-btn');
    for (const d of ['min-height: 44px', 'min-width: 44px', 'border-radius: 999px', 'rgba(255,255,255,.14)', 'rgba(255,255,255,.06)']) assert.ok(has(r, d), d);
    assert.ok(has(rules('.ui-btn:hover'), 'background: rgba(255,255,255,.12)'));
  });
  it('sizes 40, 38, 36 get their own height; 44 needs no modifier', () => {
    const classes = new Set<string>();
    for (const s of [44, 40, 38, 36]) {
      const b = make(`button('x', { size: ${s} })`);
      classes.add(b.className);
      if (s !== 44) {
        const mod = cls(b).find((c) => c.includes(String(s)));
        assert.ok(mod, `modifier for ${s}`);
        assert.ok(has(rules(`.ui-btn.${mod}`), `min-height: ${s}px`) || has(rules(`.${mod}`), `min-height: ${s}px`));
      }
    }
    assert.equal(classes.size, 4);
  });
  it('tones approve, danger and obsidian use the issue colours', () => {
    const find = (tone: string): string => {
      const b = make(`button('x', { tone: '${tone}' })`);
      const m = cls(b).find((c) => c.includes(tone));
      assert.ok(m, tone);
      return rules(`.ui-btn.${m}`);
    };
    const a = find('approve');
    assert.ok(has(a, 'color: #d1fae5') && has(a, 'border-color: rgba(52,211,153,.5)'));
    assert.ok(has(find('danger'), 'color: #fecaca'));
    const o = find('obsidian');
    assert.ok(has(o, 'background: rgba(167,139,250,.18)') && has(o, 'border-color: rgba(167,139,250,.55)') && has(o, 'color: #ede9fe'));
  });
  it('link variant is an <a> with the same button look; icon button requires aria-label', () => {
    const a = make(`button('Docs', { href: '/docs' })`);
    assert.equal(a.tagName, 'a');
    assert.equal(attr(a, 'href'), '/docs');
    assert.ok(cls(a).includes('ui-btn'));
    assert.throws(() => make(`button('', { icon: icon('refresh', 16) })`));
    assert.throws(() => make(`button(null, { icon: icon('refresh', 16) })`));
    const ib = make(`button('', { icon: icon('refresh', 16), ariaLabel: 'Refresh' })`);
    assert.equal(attr(ib, 'aria-label'), 'Refresh');
    assert.equal(ib.tagName, 'button');
    assert.ok(ib.descendants().some((d) => d.tagName === 'svg'));
  });
  it('does not accept javascript: links', () => {
    const a = make(`button('x', { href: 'javascript:alert(1)' })`);
    assert.notEqual(attr(a, 'href'), 'javascript:alert(1)');
  });
});

describe('Filter chip', () => {
  it('has min-height 36, 12.5px / 500 and the active sky colours', () => {
    const r = rules('.ui-fchip');
    assert.ok(has(r, 'min-height: 36px') && has(r, '12.5px'));
    assert.ok(/font:500|font-weight:500/.test(r));
    const a = rules('.ui-fchip[aria-pressed="true"]');
    for (const d of ['rgba(125,211,252,.16)', 'rgba(125,211,252,.55)', '#e0f2fe']) assert.ok(has(a, d), d);
  });
  it('is a button with aria-pressed that follows the click and calls onClick', () => {
    const calls: unknown[] = [];
    (ctx as any).spy = (v: unknown) => calls.push(v);
    const c = make(`filterChip('Failed', { pressed: false, onClick: (v) => spy(v) })`);
    assert.equal(c.tagName, 'button');
    assert.equal(attr(c, 'type'), 'button');
    assert.equal(attr(c, 'aria-pressed'), 'false');
    c.click();
    assert.equal(attr(c, 'aria-pressed'), 'true');
    c.click();
    assert.equal(attr(c, 'aria-pressed'), 'false');
    assert.equal(calls.length, 2);
    assert.equal(attr(make(`filterChip('x', { pressed: true })`), 'aria-pressed'), 'true');
    assert.equal(attr(make(`filterChip('x')`), 'aria-pressed'), 'false');
  });
  it('a group is role=group with aria-label', () => {
    const g = make(`filterGroup('Status filter', [filterChip('a'), filterChip('b')])`);
    assert.equal(attr(g, 'role'), 'group');
    assert.equal(attr(g, 'aria-label'), 'Status filter');
    assert.equal(g.descendants().filter((d) => d.tagName === 'button').length, 2);
  });
});

describe('Segmented', () => {
  const opts = `[{ value: 'a', label: 'Alpha', count: 3 }, { value: 'b', label: 'Beta' }]`;
  it('trough and active styles', () => {
    const t = rules('.ui-seg');
    assert.ok(has(t, 'rgba(0,0,0,.28)') && has(t, 'padding: 4px') && has(t, 'gap: 4px'));
    assert.ok(has(rules('.ui-seg-btn'), 'min-height: 44px'));
    const a = rules('.ui-seg-btn[aria-pressed="true"]');
    assert.ok(has(a, 'rgba(255,255,255,.92)') && has(a, '#0b1220'));
    const c = rules('.ui-seg-count');
    assert.ok(has(c, 'font-size: 12px') && has(c, 'opacity: .75'));
  });
  it('marks the value as pressed, moves it on click and reports the change', () => {
    const seen: string[] = [];
    (ctx as any).spy = (v: string) => seen.push(v);
    const s = make(`segmented(${opts}, 'a', (v) => spy(v))`);
    const btns = s.descendants().filter((d) => d.tagName === 'button');
    assert.equal(btns.length, 2);
    assert.deepEqual(btns.map((b) => attr(b, 'aria-pressed')), ['true', 'false']);
    assert.ok(btns.every((b) => attr(b, 'type') === 'button'));
    btns[1]!.click();
    assert.deepEqual(btns.map((b) => attr(b, 'aria-pressed')), ['false', 'true']);
    assert.deepEqual(seen, ['b']);
    assert.ok(btns[0]!.textContent.includes('Alpha') && btns[0]!.textContent.includes('3'));
    const count = btns[0]!.descendants().find((d) => cls(d).includes('mono'));
    assert.ok(count, 'count is monospace');
  });
});

describe('Tabs', () => {
  const items = `[{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }, { id: 'z', label: 'Z' }]`;
  it('has tablist/tab roles and aria-selected on the active tab', () => {
    const t = make(`tabs(${items}, 'y')`);
    assert.equal(attr(t, 'role'), 'tablist');
    const tabs = t.descendants().filter((d) => attr(d, 'role') === 'tab');
    assert.equal(tabs.length, 3);
    assert.deepEqual(tabs.map((x) => attr(x, 'aria-selected')), ['false', 'true', 'false']);
    const a = rules('.ui-tab[aria-selected="true"]');
    assert.ok(has(a, 'rgba(255,255,255,.12)'));
  });
  it('arrow keys switch the tab (with wrap around) and click selects', () => {
    const t = make(`tabs(${items}, 'x')`);
    const tabs = t.descendants().filter((d) => attr(d, 'role') === 'tab');
    const sel = () => tabs.map((x) => attr(x, 'aria-selected'));
    tabs[0]!.dispatch('keydown', { key: 'ArrowRight' });
    // the keydown may be handled on the tablist (bubbling) – dispatch there as a fallback
    if (sel()[1] !== 'true') t.dispatch('keydown', { key: 'ArrowRight', target: tabs[0] });
    assert.deepEqual(sel(), ['false', 'true', 'false']);
    t.dispatch('keydown', { key: 'ArrowRight', target: tabs[1] });
    assert.deepEqual(sel(), ['false', 'false', 'true']);
    t.dispatch('keydown', { key: 'ArrowRight', target: tabs[2] });
    assert.deepEqual(sel(), ['true', 'false', 'false']);
    t.dispatch('keydown', { key: 'ArrowLeft', target: tabs[0] });
    assert.deepEqual(sel(), ['false', 'false', 'true']);
    tabs[1]!.click();
    assert.deepEqual(sel(), ['false', 'true', 'false']);
  });
});

describe('Kpi', () => {
  it('is a .gi tile with value, label and optional sub', () => {
    const k = make(`kpi('1,234', 'Runs', { sub: 'last 24h', color: '#34d399' })`);
    assert.ok(cls(k).includes('gi'));
    assert.ok(k.textContent.includes('1,234') && k.textContent.includes('Runs') && k.textContent.includes('last 24h'));
    const no = make(`kpi(5, 'Runs')`);
    assert.ok(!no.textContent.includes('last 24h'));
    assert.ok(has(rules('.ui-kpi'), 'padding: 12px 14px'));
    const v = rules('.ui-kpi-value');
    assert.ok(has(v, 'var(--fs-kpi-24)') || has(v, '24px') || has(v, 'font:500'));
    assert.ok(rootVars.get('--fs-kpi-24') === '24px' && rootVars.get('--fs-kpi-26') === '26px' && rootVars.get('--fs-kpi-28') === '28px');
    assert.ok(has(rules('.ui-kpi-label'), '#aab6cc') && has(rules('.ui-kpi-label'), '12.5px'));
    assert.ok(has(rules('.ui-kpi-sub'), '#8b98b0') && has(rules('.ui-kpi-sub'), '12px'));
  });
  it('value uses the mono font', () => {
    const k = make(`kpi('7', 'x')`);
    const value = k.descendants().find((d) => d.textContent === '7')!;
    assert.ok(cls(value).includes('mono') || has(rules('.ui-kpi-value'), 'var(--mono)') || /mono/i.test(rules('.ui-kpi-value')));
  });
});

describe('Bar', () => {
  const root = (code: string) => make(code);
  it('is a progressbar with aria-valuenow, radius 99 and ground .08', () => {
    const b = root(`bar(42)`);
    assert.equal(attr(b, 'role'), 'progressbar');
    assert.equal(attr(b, 'aria-valuenow'), '42');
    assert.equal(attr(b, 'aria-valuemin'), '0');
    assert.equal(attr(b, 'aria-valuemax'), '100');
    const r = rules('.ui-bar');
    assert.ok(has(r, 'border-radius: 99px') && has(r, 'rgba(255,255,255,.08)'));
    assert.ok(b.descendants().some((d) => d.style.width === '42%'));
  });
  it('heights 5, 6, 8, 10 map to four different heights', () => {
    const seen = new Set<string>();
    for (const h of [5, 6, 8, 10]) {
      const b = root(`bar(50, { height: ${h} })`);
      const px = [b.className, ...cls(b)].map((c) => c).join(' ');
      const decl = cls(b).map((c) => { try { return rules(`.${c}`); } catch { return ''; } }).concat(String(b.style.height ?? '')).join(';');
      assert.ok(has(decl, `height: ${h}px`) || String(b.style.height) === `${h}px`, `height ${h} (${px})`);
      seen.add(decl);
    }
    assert.equal(seen.size, 4);
  });
  it('clamps pct to 0..100', () => {
    assert.equal(attr(root(`bar(150)`), 'aria-valuenow'), '100');
    assert.equal(attr(root(`bar(-5)`), 'aria-valuenow'), '0');
  });
  it('forecast draws a hatch from pct with width forecastPct; without it there is none', () => {
    const none = root(`bar(40, { color: '#34d399' })`);
    assert.ok(none.descendants().every((d) => !/forecast|hatch/.test(d.className)));
    assert.equal(none.descendants().length, 1);
    const f = root(`bar(40, { color: '#34d399', forecastPct: 25 })`);
    const hatch = f.descendants().find((d) => /forecast|hatch/.test(d.className));
    assert.ok(hatch);
    assert.equal(hatch!.style.left, '40%');
    assert.equal(hatch!.style.width, '25%');
    assert.equal(norm(hatch!.style.getPropertyValue('--hatch')), 'rgba(52,211,153,.45)');
    const rule = rules(`.${cls(hatch!).find((c) => /forecast|hatch/.test(c))}`);
    assert.ok(has(rule, 'repeating-linear-gradient(135deg') && has(rule, '0 4px') && has(rule, 'transparent 4px 8px'));
    assert.equal(root(`bar(40, { forecastPct: 0 })`).descendants().length, 1);
  });
  it('marker is a 2px #f87171 line with title at its position', () => {
    const m = root(`bar(30, { marker: { pct: 80, title: 'Limit 80%' } })`);
    const mark = m.descendants().find((d) => attr(d, 'title') === 'Limit 80%');
    assert.ok(mark);
    assert.equal(mark!.style.left, '80%');
    const r = rules(`.${cls(mark!)[0]}`);
    assert.ok(has(r, 'width: 2px') && has(r, '#f87171'));
    assert.equal(root(`bar(30)`).descendants().filter((d) => attr(d, 'title') !== null).length, 0);
  });
});

describe('Stacked bar', () => {
  const parts = `[{ value: 371, label: 'approved', color: '#34d399' }, { value: 17, label: 'Kandidaten', color: '#fbbf24' }, { value: 24, label: 'veraltet', color: '#94a3b8' }]`;
  it('is role=img with an aria-label naming every part, 10px high with coloured segments', () => {
    const s = make(`stackedBar(${parts})`);
    assert.equal(attr(s, 'role'), 'img');
    assert.equal(attr(s, 'aria-label'), '371 approved, 17 Kandidaten, 24 veraltet');
    assert.equal(s.children.length, 3);
    assert.deepEqual(s.children.map((c) => norm(String(c.style.background))), ['#34d399', '#fbbf24', '#94a3b8']);
    const widths = s.children.map((c) => parseFloat(String(c.style.width)));
    assert.ok(Math.abs(widths.reduce((a, b) => a + b, 0) - 100) < 0.1);
    assert.ok(widths[0]! > widths[2]! && widths[2]! > widths[1]!);
    assert.ok(has(rules('.ui-stack'), 'height: 10px'));
  });
  it('copes with empty and all-zero parts', () => {
    assert.equal(attr(make(`stackedBar([])`), 'role'), 'img');
    assert.doesNotThrow(() => make(`stackedBar([{ value: 0, label: 'a', color: '#34d399' }])`));
  });
});

describe('Sparkline', () => {
  it('draws an aria-hidden svg 100x24 with one round, non-scaling 1.6px polyline', () => {
    const s = make(`sparkline([1, 4, 2, 8], '#34d399')`);
    assert.equal(s.tagName, 'svg');
    assert.equal(s.namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(attr(s, 'viewBox'), '0 0 100 24');
    assert.equal(attr(s, 'preserveAspectRatio'), 'none');
    assert.equal(attr(s, 'aria-hidden'), 'true');
    const pl = s.descendants().filter((d) => d.tagName === 'polyline');
    assert.equal(pl.length, 1);
    assert.equal(attr(pl[0]!, 'stroke-width'), '1.6');
    assert.equal(attr(pl[0]!, 'vector-effect'), 'non-scaling-stroke');
    assert.equal(attr(pl[0]!, 'stroke-linejoin'), 'round');
    assert.equal(attr(pl[0]!, 'stroke'), '#34d399');
    const pts = attr(pl[0]!, 'points')!.split(' ').map((p) => p.split(',').map(Number));
    assert.equal(pts.length, 4);
    assert.ok(pts.every(([x, y]) => x! >= 0 && x! <= 100 && y! >= 0 && y! <= 24));
    assert.ok(pts[3]![1]! < pts[0]![1]!, 'higher value is higher up (smaller y)');
  });
  it('an empty series creates no svg', () => {
    for (const v of ['[]', 'null', 'undefined']) assert.ok(!val(`sparkline(${v}, '#34d399')`), v);
  });
});

describe('Ring', () => {
  it('uses conic-gradient, padding 5px, 96px by default, role=img and a labelled percent badge', () => {
    const r = make(`ring(71, { color: '#34d399', label: 'Developer playing, Context' })`);
    assert.equal(attr(r, 'role'), 'img');
    assert.ok(attr(r, 'aria-label')!.includes('71'));
    assert.ok(attr(r, 'aria-label')!.includes('Developer'));
    assert.equal(r.style.width, '96px');
    assert.equal(r.style.height, '96px');
    assert.equal(norm(String(r.style.background)), norm('conic-gradient(#34d399 0 71%, rgba(255,255,255,.1) 71% 100%)'));
    assert.ok(has(rules('.ui-ring'), 'padding: 5px'));
    assert.ok(r.textContent.includes('71%'));
  });
  it('size is respected and inner content is shown in the inner circle', () => {
    const r = make(`ring(10, { size: 64, inner: icon('developer', 26) })`);
    assert.equal(r.style.width, '64px');
    assert.ok(r.descendants().some((d) => d.tagName === 'svg'));
  });
  it('the badge is mono 11px, amber from 70 percent, sky below', () => {
    const lo = make(`ring(69, {})`);
    const hi = make(`ring(70, {})`);
    const badge = (e: FakeElement) => e.descendants().find((d) => d.textContent.endsWith('%') && d.children.length === 0)!;
    assert.ok(badge(lo) && badge(hi));
    assert.ok(cls(badge(hi)).includes('mono'));
    assert.notEqual(badge(lo).className, badge(hi).className);
    const base = rules(`.${cls(badge(hi)).find((c) => c.includes('pct'))}`);
    assert.ok(has(base, 'font-size: 11px'));
    const hotCls = cls(badge(hi)).filter((c) => !cls(badge(lo)).includes(c))[0]!;
    const hot = rules(`.ui-ring-pct.${hotCls}`);
    assert.ok(has(hot, '#3b2a06'));
    assert.ok(has(hot, '#fbbf24') || has(hot, '#fde68a') || has(hot, '#fcd34d'), 'amber tones');
    const sky = rules('.ui-ring-pct');
    assert.ok(has(sky, '#7dd3fc') || has(sky, '#e0f2fe'), 'sky tones');
    assert.ok(has(sky, 'bottom') && has(sky, 'left: 50%'), 'bottom centre');
  });
  it('null shows an em dash and no percentage; out-of-range values are clamped', () => {
    const n = make(`ring(null, {})`);
    assert.ok(n.textContent.includes('—'));
    assert.ok(!n.textContent.includes('%'));
    assert.equal(attr(n, 'role'), 'img');
    assert.ok(attr(n, 'aria-label'));
    assert.ok(!/NaN|null|undefined/.test(attr(n, 'aria-label')! + String(n.style.background)));
    assert.ok(make(`ring(250, {})`).textContent.includes('100%'));
  });
});

describe('Avatar', () => {
  const states = ['done', 'playing', 'waiting', 'returned', 'skipped'];
  const roles: Record<string, string> = { analyst: 'AN', architect: 'AR', developer: 'DE', tester: 'TE', docs: 'DO', reviewer: 'RE', security: 'SE' };
  it('30px shows the abbreviation for every role (mono, 600) and no role icon', () => {
    for (const [role, short] of Object.entries(roles)) {
      const a = make(`avatar('${role}', 'done', { size: 30 })`);
      assert.ok(a.textContent.includes(short), `${role} → ${short}`);
      assert.ok(!a.descendants().some((d) => d.tagName === 'svg'));
      assert.ok(cls(a).some((c) => c.includes('30')));
    }
    assert.ok(make(`avatar('subagent', 'done', { size: 30, short: 'EX' })`).textContent.includes('EX'));
    const face = rules('.ui-av-face');
    assert.ok(face.includes('600'), 'weight 600');
    assert.ok(/10(\.5)?px/.test(face), 'size 10-10.5px');
    assert.ok(/jetbrains|monospace|mono/i.test(face), 'mono font');
  });
  it('64 and 96 show the role icon at 26 and 34 px', () => {
    const svgOf = (code: string) => make(code).descendants().filter((d) => d.tagName === 'svg')[0]!;
    assert.equal(attr(svgOf(`avatar('developer', 'done', { size: 64 })`), 'width'), '26');
    assert.equal(attr(svgOf(`avatar('developer', 'done', { size: 96 })`), 'width'), '34');
    assert.equal(attr(svgOf(`avatar('human', 'waiting', { size: 64 })`), 'viewBox'), '0 0 24 24');
  });
  it('title is "Role · state" for each state', () => {
    for (const s of states) {
      const a = make(`avatar('developer', '${s}', { size: 30 })`);
      const title = attr(a, 'title')!;
      assert.ok(title.startsWith('Developer · '), title);
      assert.ok(title.split(' · ')[1]!.length > 0);
    }
    const titles = new Set(states.map((s) => attr(make(`avatar('developer', '${s}', {})`), 'title')));
    assert.equal(titles.size, 5);
  });
  it('the pulse ring and the equalizer exist only in state playing', () => {
    for (const size of [30, 64, 96]) {
      for (const s of states) {
        const a = make(`avatar('tester', '${s}', { size: ${size} })`);
        const ring = a.byClass('ring');
        const eq = a.byClass('eq');
        if (s === 'playing') {
          assert.equal(ring.length, 1, `ring ${size}`);
          assert.equal(eq.length, 1, `eq ${size}`);
          assert.equal(attr(eq[0]!, 'aria-hidden'), 'true');
        } else {
          assert.equal(ring.length, 0, `${s} ${size} no ring`);
          assert.equal(eq.length, 0, `${s} ${size} no eq`);
        }
      }
    }
  });
  it('playing: role colour tint .32, border c, glow 0 0 18px .6', () => {
    const a = make(`avatar('developer', 'playing', { size: 64 })`);
    assert.equal(norm(String(a.style.background)), 'rgba(52,211,153,.32)');
    assert.equal(norm(String(a.style.borderColor)), '#34d399');
    assert.equal(norm(String(a.style.boxShadow)), norm('0 0 18px rgba(52,211,153,.6)'));
  });
  it('waiting is dashed, returned is red with a cross badge, done has a 22px green check badge with a 2px #0b1222 border', () => {
    const w = rules('.ui-av.is-waiting');
    assert.ok(has(w, 'dashed'));
    const wa = make(`avatar('developer', 'waiting', { size: 64 })`);
    assert.ok(cls(wa).some((c) => c.includes('waiting')));
    const ret = rules('.ui-av.is-returned');
    assert.ok(has(ret, '#f87171') || has(ret, '#fca5a5') || has(ret, 'rgba(248,113,113'));
    const badge = (code: string) => make(code).descendants().filter((d) => cls(d).some((c) => c.includes('badge')));
    assert.equal(badge(`avatar('developer', 'returned', { size: 64 })`).length, 1);
    assert.equal(badge(`avatar('developer', 'done', { size: 64 })`).length, 1);
    for (const s of ['waiting', 'skipped', 'playing']) assert.equal(badge(`avatar('developer', '${s}', { size: 64 })`).length, 0, s);
    const b = rules('.ui-av-badge');
    assert.ok(has(b, 'width: 22px') && has(b, 'height: 22px') && has(b, '#34d399') && has(b, 'border: 2px solid #0b1222'));
    const x = badge(`avatar('developer', 'returned', { size: 64 })`)[0]!;
    assert.ok(x.descendants().some((d) => d.tagName === 'svg') || x.textContent.length > 0, 'cross glyph');
  });
  it('skipped differs from waiting and all five states give distinct classes', () => {
    const c = new Set(states.map((s) => make(`avatar('docs', '${s}', { size: 30 })`).className));
    assert.equal(c.size, 5);
  });
});

describe('Equalizer', () => {
  it('4 bars of 3x14 px, large 5 bars of 4x18 px, aria-hidden, currentColor', () => {
    const e = make(`eq()`);
    assert.equal(e.children.length, 4);
    assert.equal(attr(e, 'aria-hidden'), 'true');
    const l = make(`eq({ large: true })`);
    assert.equal(l.children.length, 5);
    assert.equal(attr(l, 'aria-hidden'), 'true');
    assert.ok(has(rules('.eq i'), 'width: 3px') && has(rules('.eq i'), 'height: 14px') && has(rules('.eq i'), 'currentColor'));
    assert.ok(has(rules('.eq-lg i'), 'width: 4px') && has(rules('.eq-lg i'), 'height: 18px'));
    assert.ok(cls(l).some((c) => c.includes('lg') || c.includes('large')));
  });
});

describe('Icons', () => {
  const nav = ['home', 'changes', 'tasks', 'brain', 'stats'];
  const roleIcons = ['analyst', 'architect', 'developer', 'tester', 'docs', 'reviewer', 'security', 'human'];
  const symbols = ['check', 'cross', 'search', 'refresh', 'logo'];
  const all = [...nav, ...roleIcons, ...symbols];
  const ds = (e: FakeElement) => e.descendants().map((d) => attr(d, 'd')).filter(Boolean) as string[];
  it('are all offered by ICON_NAMES', () => {
    for (const n of [...all, 'arrow']) assert.ok((ICON_NAMES as readonly string[]).includes(n), n);
  });
  it('every icon is an svg in the SVG namespace with the common attributes and aria-hidden', () => {
    for (const n of all) {
      const s = make(`icon('${n}', 20)`);
      assert.equal(s.tagName, 'svg', n);
      assert.equal(s.namespaceURI, 'http://www.w3.org/2000/svg', n);
      assert.equal(attr(s, 'viewBox'), '0 0 24 24', n);
      assert.equal(attr(s, 'fill'), 'none', n);
      assert.equal(attr(s, 'stroke'), 'currentColor', n);
      assert.equal(attr(s, 'stroke-linecap'), 'round', n);
      assert.equal(attr(s, 'aria-hidden'), 'true', n);
      const w = Number(attr(s, 'stroke-width'));
      if (n === 'logo') assert.equal(w, 2.2);
      else if (!['check', 'cross'].includes(n)) assert.ok(w >= 1.8 && w <= 1.9, `${n} stroke-width ${w}`);
      assert.ok(s.descendants().length >= 1, n);
    }
  });
  it('navigation icons use the issue paths', () => {
    assert.ok(['M3 11l9-7 9 7', 'M5 10v10h14V10'].every((p) => ds(make(`icon('home', 16)`)).includes(p)));
    const ch = make(`icon('changes', 16)`);
    assert.ok(ds(ch).includes('M6 8.5v4a5 5 0 0 0 5 5h4.5'));
    const circles = ch.descendants().filter((d) => d.tagName === 'circle').map((c) => [attr(c, 'cx'), attr(c, 'cy'), attr(c, 'r')].join(','));
    assert.deepEqual(circles.sort(), ['18,18,2.5', '6,6,2.5']);
    assert.equal(ds(make(`icon('tasks', 16)`)).length, 6);
    assert.ok(ds(make(`icon('brain', 16)`)).length >= 2);
    assert.ok(['M5 20V11', 'M12 20V4', 'M19 20v-7'].every((p) => ds(make(`icon('stats', 16)`)).includes(p)));
  });
  it('role icons: architect compass, developer code, others have shapes', () => {
    const ar = make(`icon('architect', 16)`);
    assert.ok(['M12 3l-7 18', 'M12 3l7 18', 'M7.5 15h9'].every((p) => ds(ar).includes(p)));
    assert.ok(ar.descendants().some((d) => d.tagName === 'circle'));
    assert.ok(ds(make(`icon('developer', 16)`)).length >= 3, '</> plus slash');
    for (const n of roleIcons) assert.ok(make(`icon('${n}', 16)`).descendants().length >= 1, n);
    const distinct = new Set(roleIcons.map((n) => ds(make(`icon('${n}', 16)`)).join('|') + make(`icon('${n}', 16)`).descendants().length));
    assert.equal(distinct.size, roleIcons.length, 'role icons differ');
  });
  it('logo has five vertical strokes with the issue paths', () => {
    const l = make(`icon('logo', 24)`);
    assert.deepEqual(ds(l), ['M4 10v4', 'M8 7v10', 'M12 4v16', 'M16 8v8', 'M20 11v2']);
  });
  it('the arrow is the text ↗, an unknown name gives no svg, size is applied', () => {
    const a = make(`icon('arrow', 16)`);
    assert.equal(a.textContent, '↗');
    assert.equal(a.tagName === 'svg', false);
    assert.ok(!val(`icon('does-not-exist', 16)`));
    const s = make(`icon('home', 40)`);
    assert.equal(attr(s, 'width'), '40');
    assert.equal(attr(s, 'height'), '40');
  });
});

describe('DOM construction rules', () => {
  const calls: Record<string, string> = {
    card: `card({ title: 'T', meta: 'm', body: 'b' })`,
    kpi: `kpi('1', 'l', { sub: 's' })`,
    bar: `bar(40, { forecastPct: 10, marker: { pct: 50, title: 't' } })`,
    stackedBar: `stackedBar([{ value: 1, label: 'a', color: '#34d399' }])`,
    chip: `chip('x', { tone: 'green', dot: true })`,
    filterChip: `filterChip('x', { color: '#34d399' })`,
    button: `button('x', { icon: icon('check', 16), tone: 'approve' })`,
    segmented: `segmented([{ value: 'a', label: 'A', count: 1 }], 'a', () => {})`,
    tabs: `tabs([{ id: 'a', label: 'A' }], 'a')`,
    sparkline: `sparkline([1, 2, 3], '#34d399')`,
    ring: `ring(50, { inner: icon('developer', 26) })`,
    avatar: `avatar('developer', 'playing', { size: 64 })`,
    eq: `eq({ large: true })`,
  };
  it('every block builds without ever touching innerHTML / outerHTML / insertAdjacentHTML (spy on the fake DOM)', () => {
    for (const [name, code] of Object.entries(calls)) {
      assert.doesNotThrow(() => make(code), name); // FakeElement throws on any of them
    }
    for (const n of ['home', 'changes', 'tasks', 'brain', 'stats', 'analyst', 'architect', 'developer', 'tester', 'docs', 'reviewer', 'security', 'human', 'check', 'cross', 'search', 'refresh', 'logo', 'arrow']) {
      assert.doesNotThrow(() => make(`icon('${n}', 16)`), n);
    }
  });
  it('hostile text is kept as text', () => {
    const evil = '<img src=x onerror=alert(1)>';
    (ctx as any).evil = evil;
    for (const code of [`chip(evil)`, `kpi(evil, evil, { sub: evil })`, `button(evil)`, `filterChip(evil)`,
      `segmented([{ value: 'a', label: evil }], 'a')`, `tabs([{ id: 'a', label: evil }], 'a')`, `card({ title: evil, body: evil })`]) {
      const e = make(code);
      assert.ok(e.textContent.includes(evil), code);
      assert.ok(!tags(e).includes('img'), code);
    }
  });
  it('component sources never assign innerHTML / outerHTML / insertAdjacentHTML and use no sc-camel attributes', () => {
    const files = ['src/http/ui/components.ts', 'src/http/icons.ts'];
    for (const f of files) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.ok(!/\.(innerHTML|outerHTML)\s*[+]?=/.test(src), `${f} innerHTML`);
      assert.ok(!/insertAdjacentHTML\s*\(/.test(src), `${f} insertAdjacentHTML`);
      assert.ok(!/sc-camel/.test(src), `${f} sc-camel`);
    }
    assert.ok(!/sc-camel/.test(BASE_JS));
    const dir = new URL('../src/http/ui/', import.meta.url);
    for (const f of readdirSync(dir)) assert.ok(!/sc-camel/.test(readFileSync(new URL(f, dir), 'utf8')), f);
  });
  it('SVG attributes are set with setAttribute on namespaced elements (createElementNS)', () => {
    for (const code of [`icon('home', 16)`, `sparkline([1, 2], '#34d399')`]) {
      const s = make(code);
      for (const d of [s, ...s.descendants()]) assert.equal(d.namespaceURI, 'http://www.w3.org/2000/svg', code);
      assert.ok(s.attributes.size >= 3);
    }
  });
});
