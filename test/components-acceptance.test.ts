import assert from 'node:assert/strict';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { BASE_JS } from '../src/http/styles.ts';
import * as componentsModule from '../src/http/ui/components.ts';
import { TOKENS_CSS } from '../src/http/ui/tokens.ts';
import { FakeElement, createDocument, domContext, run } from './helpers/fake-dom.ts';

// Independent acceptance tests for E1-2a (#335), derived from the issue text.
const { COMPONENTS_JS, COMPONENTS_CSS } = componentsModule;
const ctx = domContext(BASE_JS);
const make = (code: string): FakeElement => run(ctx, code);
const XSS = '<img src=x onerror=alert(1)>';
ctx.XSS = XSS;

const all = (root: FakeElement): FakeElement[] => [root, ...root.find(() => true)];
const noInjectedMarkup = (root: FakeElement): void => {
  assert.equal(all(root).filter((e) => !['ARTICLE', 'DIV', 'SPAN', 'H3', 'BUTTON'].includes(e.tagName)).length, 0);
};

describe('E1-2a module and API', () => {
  it('exports the component sources as strings', () => {
    assert.equal(typeof COMPONENTS_JS, 'string');
    assert.equal(typeof COMPONENTS_CSS, 'string');
  });

  it('the five functions exist in the same script scope as el() and are available on all three pages', () => {
    for (const fn of ['card', 'statTile', 'progressBar', 'chip', 'filterChip']) {
      assert.equal(run(ctx, `typeof ${fn}`), 'function', fn);
      for (const html of [DASHBOARD_HTML, AGENT_HTML, LOGS_HTML]) assert.match(html, new RegExp(`function ${fn}\\(`), fn);
    }
    assert.equal(run(ctx, 'typeof el'), 'function');
  });

  it('the inline scripts of every page still compile (no redeclaration clash with page-local names)', () => {
    for (const [name, html] of [['dashboard', DASHBOARD_HTML], ['agent', AGENT_HTML], ['logs', LOGS_HTML]] as const) {
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
      assert.ok(scripts.length > 0, name);
      for (const s of scripts) assert.doesNotThrow(() => new vm.Script(s, { filename: `${name}.js` }), name);
    }
  });

  it('does not use innerHTML-like sinks or string-built markup', () => {
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'DOMParser']) {
      assert.ok(!COMPONENTS_JS.includes(bad), bad);
    }
  });

  it('every component sets data only as text (script-looking input stays a text node)', () => {
    const spark = 'document.createElement("div")';
    const nodes = [
      make(`card({ title: XSS, meta: XSS, body: XSS })`),
      make(`statTile({ label: XSS, value: XSS, unit: XSS, tone: XSS, spark: ${spark} })`),
      make(`progressBar({ value: 1, max: 2, forecast: 1, tone: XSS })`),
      make(`chip({ text: XSS, tone: XSS, icon: XSS })`),
      make(`filterChip({ text: XSS, count: XSS, active: true })`),
    ];
    for (const n of nodes) noInjectedMarkup(n);
    assert.ok(nodes[0]!.textContent.includes(XSS));
    assert.ok(nodes[3]!.textContent.includes(XSS));
    // an untrusted tone must not leak into the class attribute
    assert.ok(!nodes[1]!.className.includes('<'));
    assert.ok(!nodes[2]!.className.includes('<'));
    assert.ok(!nodes[3]!.className.includes('<'));
  });
});

describe('E1-2a card', () => {
  it('renders title, meta and body given as text or node', () => {
    const c = make('card({ title: "T", meta: "M", body: "B" })');
    assert.ok(c.classList.contains('ui-card'));
    const text = c.textContent;
    for (const part of ['T', 'M', 'B']) assert.ok(text.includes(part), part);
    const withNode = make('(() => { const p = document.createElement("p"); p.textContent = "node"; return card({ title: "T", body: p }); })()');
    assert.equal(withNode.find((e) => e.tagName === 'P').length, 1);
    assert.ok(withNode.textContent.includes('node'));
  });

  it('does not collide with the page-local .card class', () => {
    const c = make('card({ title: "T", body: "B" })');
    assert.ok(!all(c).some((e) => e.classList.contains('card')));
  });
});

describe('E1-2a statTile', () => {
  it('shows label, value and optional unit; value 0 is rendered, not dropped', () => {
    const t = make('statTile({ label: "Runs", value: 0, tone: "cyan" })');
    assert.ok(t.textContent.includes('Runs'));
    assert.ok(t.textContent.includes('0'));
    assert.ok(t.classList.contains('tone-cyan'));
    const u = make('statTile({ label: "Cost", value: 7, unit: "USD" })');
    assert.ok(u.textContent.includes('7') && u.textContent.includes('USD'));
    assert.ok(!make('statTile({ label: "Cost", value: 7 })').textContent.includes('undefined'));
  });

  it('embeds the spark node only when given and keeps the existing .stat class free', () => {
    const none = make('statTile({ label: "L", value: 1 })');
    assert.equal(none.find((e) => e.tagName === 'SVG').length, 0);
    const withSpark = make('statTile({ label: "L", value: 1, spark: document.createElement("svg") })');
    assert.equal(withSpark.find((e) => e.tagName === 'SVG').length, 1);
    assert.ok(!all(none).some((e) => e.classList.contains('stat')));
  });

  it('two tones give two different tone classes', () => {
    const a = make('statTile({ label: "L", value: 1, tone: "green" })').className;
    const b = make('statTile({ label: "L", value: 1, tone: "red" })').className;
    assert.notEqual(a, b);
  });
});

describe('E1-2a progressBar', () => {
  const hatched = (n: FakeElement): FakeElement[] => all(n).filter((e) => /forecast|hatch/i.test(e.className));

  it('has a hatched element only with a forecast and it is rendered before (behind) the fill', () => {
    const withF = make('progressBar({ value: 4, max: 10, forecast: 7, tone: "green" })');
    const h = hatched(withF);
    assert.equal(h.length, 1);
    const fill = withF.children.find((e) => /fill/.test(e.className))!;
    assert.ok(fill, 'fill element');
    assert.ok(withF.children.indexOf(h[0]!) < withF.children.indexOf(fill));
    assert.equal(hatched(make('progressBar({ value: 4, max: 10, tone: "green" })')).length, 0);
    assert.equal(hatched(make('progressBar({ value: 4, max: 10, forecast: undefined })')).length, 0);
  });

  it('forecast and fill widths reflect value/max; the forecast is wider than the fill when larger', () => {
    const b = make('progressBar({ value: 2, max: 10, forecast: 6 })');
    const scale = (e: FakeElement): number => Number(/scaleX\(([\d.]+)\)/.exec(e.style.transform ?? "")![1]);
    const f = hatched(b)[0]!;
    const fill = b.children.find((e) => /fill/.test(e.className))!;
    assert.ok(Math.abs(scale(fill) - 0.2) < 1e-9);
    assert.ok(Math.abs(scale(f) - 0.6) < 1e-9);
  });

  it('clamps to 0..100 % and exposes progressbar ARIA', () => {
    const over = make('progressBar({ value: 50, max: 10, forecast: 99 })');
    const under = make('progressBar({ value: -5, max: 10 })');
    const zero = make('progressBar({ value: 5, max: 0 })');
    const nan = make('progressBar({ value: 5, max: NaN })');
    for (const n of [over, under, zero, nan]) {
      assert.equal(n.getAttribute('role'), 'progressbar');
      const now = Number(n.getAttribute('aria-valuenow'));
      assert.ok(now >= 0 && now <= 100, String(now));
      for (const e of n.children) {
        const m = /scaleX\(([\d.eE+-]+)\)/.exec(e.style.transform ?? "");
        assert.ok(m, 'scaleX set');
        const s = Number(m![1]);
        assert.ok(Number.isFinite(s) && s >= 0 && s <= 1, String(s));
      }
    }
    assert.equal(over.getAttribute('aria-valuenow'), '100');
    assert.equal(under.getAttribute('aria-valuenow'), '0');
    assert.equal(zero.getAttribute('aria-valuenow'), '0');
    assert.equal(nan.getAttribute('aria-valuenow'), '0');
  });
});

describe('E1-2a chip', () => {
  it('is a span, carries the tone, and icon is optional', () => {
    const c = make('chip({ text: "ok", tone: "green" })');
    assert.equal(c.tagName, 'SPAN');
    assert.ok(c.classList.contains('tone-green'));
    assert.equal(c.textContent, 'ok');
    const i = make('chip({ text: "ok", tone: "green", icon: "★" })');
    assert.equal(i.tagName, 'SPAN');
    assert.ok(i.textContent.includes('★') && i.textContent.includes('ok'));
  });

  it('is not interactive', () => {
    assert.equal(all(make('chip({ text: "x", tone: "red" })')).filter((e) => e.tagName === 'BUTTON').length, 0);
  });
});

describe('E1-2a filterChip', () => {
  it('is a real button with aria-pressed matching active, text and count', () => {
    const on = make('filterChip({ text: "Errors", count: 3, active: true, onToggle: () => {} })');
    const off = make('filterChip({ text: "Errors", count: 3, active: false, onToggle: () => {} })');
    assert.equal(on.tagName, 'BUTTON');
    assert.equal(off.tagName, 'BUTTON');
    assert.equal(on.getAttribute('type'), 'button');
    assert.equal(on.getAttribute('aria-pressed'), 'true');
    assert.equal(off.getAttribute('aria-pressed'), 'false');
    assert.ok(on.textContent.includes('Errors') && on.textContent.includes('3'));
  });

  it('a click calls onToggle once per click and keeps aria-pressed in sync with the reported state', () => {
    ctx.seen = [];
    const b = make('filterChip({ text: "A", count: 0, active: false, onToggle: (...a) => seen.push(a[0]) })');
    b.click();
    assert.equal(ctx.seen.length, 1);
    assert.equal(b.getAttribute('aria-pressed'), String(ctx.seen[0]));
    b.click();
    assert.equal(ctx.seen.length, 2);
    assert.equal(b.getAttribute('aria-pressed'), String(ctx.seen[1]));
    assert.notEqual(ctx.seen[0], ctx.seen[1]);
  });

  it('chips keep independent state and a missing onToggle does not throw', () => {
    const a = make('filterChip({ text: "A", count: 1, active: false })');
    const b = make('filterChip({ text: "B", count: 1, active: false })');
    assert.doesNotThrow(() => a.click());
    assert.equal(a.getAttribute('aria-pressed'), 'true');
    assert.equal(b.getAttribute('aria-pressed'), 'false');
  });
});

describe('E1-2a CSS', () => {
  const css = TOKENS_CSS;
  const decls = (src: string): string[] => [...src.matchAll(/transition\s*:\s*([^;}]*)/g)].map((m) => m[1]!);

  it('the component CSS is delivered with the tokens and the hatch is a repeating-linear-gradient', () => {
    assert.ok(css.includes(COMPONENTS_CSS));
    assert.match(COMPONENTS_CSS, /repeating-linear-gradient\(/);
  });

  it('transitions in the component CSS only animate transform or opacity', () => {
    const list = decls(COMPONENTS_CSS);
    assert.ok(list.length > 0);
    for (const t of list) {
      for (const part of t.split(',')) {
        assert.match(part.trim(), /^(transform|opacity)\b/, part);
      }
    }
    assert.ok(!/transition-property\s*:[^;}]*\b(width|height|left|top|all|background|color)\b/.test(COMPONENTS_CSS));
    assert.ok(!/@keyframes[^{]*\{[^]*?\b(width|height|left|top)\s*:/.test(COMPONENTS_CSS));
  });

  it('does not restyle the existing selectors', () => {
    const selectors = [...COMPONENTS_CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)].flatMap((m) => m[1]!.split(','));
    for (const s of selectors) {
      const sel = s.trim();
      assert.ok(!/(^|[\s>+~])\.(chip|card|stat|badge)\b/.test(sel) && !/(^|[\s>+~])(button|article|span|div)\s*$/.test(sel), sel);
    }
  });

  it('colours come from the tokens (no hard-coded hex colours in the component CSS)', () => {
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(COMPONENTS_CSS));
  });
});

describe('E1-2a fake DOM helper', () => {
  it('offers createElement, append, textContent, className, setAttribute and children', () => {
    const doc = createDocument();
    const root = doc.createElement('div');
    const child = doc.createElement('span');
    root.append(child);
    child.textContent = 'hi';
    child.className = 'a b';
    child.setAttribute('data-x', 1);
    assert.equal(root.children.length, 1);
    assert.equal(root.children[0], child);
    assert.equal(child.tagName, 'SPAN');
    assert.equal(root.textContent, 'hi');
    assert.equal(child.className, 'a b');
    assert.equal(child.getAttribute('data-x'), '1');
  });

  it('domContext shares one scope between several sources (reusable for E1-2b)', () => {
    const c = domContext('const a = 1;', 'const b = a + 1;');
    assert.equal(run(c, 'b'), 2);
    assert.equal(run(c, 'typeof document.createElement'), 'function');
  });
});
