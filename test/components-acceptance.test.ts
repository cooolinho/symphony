import assert from 'node:assert/strict';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { ICONS_JS } from '../src/http/icons.ts';
import { BASE_JS } from '../src/http/styles.ts';
import * as componentsModule from '../src/http/ui/components.ts';
import { TOKENS_CSS } from '../src/http/ui/tokens.ts';
import { FakeElement, createDocument, domContext, run } from './helpers/fake-dom.ts';

// Acceptance tests for the building blocks of E1-2a (#335) and E1-9 (#380), derived from the issue text.
const { COMPONENTS_JS, COMPONENTS_CSS } = componentsModule;
const ctx = domContext(BASE_JS);
const make = (code: string): FakeElement => run(ctx, code);
const XSS = '<img src=x onerror=alert(1)>';
ctx.XSS = XSS;

const all = (root: FakeElement): FakeElement[] => [root, ...root.find(() => true)];
const SAFE_TAGS = ['article', 'div', 'span', 'h3', 'button', 'a', 'i', 'svg', 'path', 'circle', 'polyline'];
const noInjectedMarkup = (root: FakeElement): void => {
  assert.deepEqual(all(root).filter((e) => !SAFE_TAGS.includes(e.tagName)).map((e) => e.tagName), []);
  for (const e of all(root)) {
    for (const [k, v] of e.attributes) {
      assert.ok(!k.startsWith('on') && !k.startsWith('sc-'), k);
      if (k === 'class') assert.ok(!v.includes('<'), v);
    }
  }
};
const BUILDERS = {
  card: 'card({ title: XSS, meta: XSS, body: XSS })',
  kpi: 'kpi(XSS, XSS, { sub: XSS, color: XSS, size: XSS })',
  bar: 'bar(XSS, { height: XSS, color: XSS, forecastPct: 20, marker: { pct: 50, title: XSS } })',
  stackedBar: 'stackedBar([{ value: 2, label: XSS, color: XSS }])',
  chip: 'chip(XSS, { tone: XSS, mono: true, dot: XSS })',
  filterChip: 'filterChip(XSS, { color: XSS, pressed: true, count: XSS })',
  filterGroup: 'filterGroup(XSS, [filterChip(XSS)])',
  button: 'button(XSS, { size: XSS, tone: XSS, ariaLabel: XSS, href: XSS, icon: icon("refresh") })',
  segmented: 'segmented([{ value: XSS, label: XSS, count: XSS }], XSS, null, XSS)',
  tabs: 'tabs([{ id: XSS, label: XSS, count: XSS }], XSS)',
  sparkline: 'sparkline([1, 2], XSS)',
  ring: 'ring(50, { color: XSS, inner: XSS, label: XSS, size: XSS })',
  avatar: 'avatar(XSS, XSS, { size: 64, short: XSS })',
  eq: 'eq({ large: XSS })',
  icon: 'icon("developer", XSS)',
};

describe('E1-9 module and API', () => {
  it('exports the component sources as strings', () => {
    assert.equal(typeof COMPONENTS_JS, 'string');
    assert.equal(typeof COMPONENTS_CSS, 'string');
    assert.equal(typeof ICONS_JS, 'string');
  });

  it('every building block exists in the same script scope as el() and is available on all three pages', () => {
    for (const fn of Object.keys(BUILDERS)) {
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

  it('the sources use no innerHTML-like sinks, no string-built markup and no sc-camel attributes', () => {
    for (const src of [COMPONENTS_JS, ICONS_JS]) {
      for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'DOMParser', 'sc-camel']) assert.ok(!src.includes(bad), bad);
    }
  });

  it('no block sets innerHTML: the spying fake DOM throws on every HTML sink, and every block builds without it', () => {
    for (const [name, code] of Object.entries(BUILDERS)) {
      let node: FakeElement | undefined;
      assert.doesNotThrow(() => { node = make(code); }, name);
      assert.ok(node, name);
      noInjectedMarkup(node!);
    }
  });

  it('script-looking input stays text', () => {
    for (const name of ['card', 'kpi', 'chip', 'filterChip', 'segmented', 'tabs']) {
      assert.ok(make(BUILDERS[name as keyof typeof BUILDERS]).textContent.includes(XSS), name);
    }
    assert.equal(make(BUILDERS.button).tagName, 'button', 'a non-URL href stays a button');
    assert.equal(make(BUILDERS.stackedBar).getAttribute('aria-label'), '2 ' + XSS);
    const b = make(BUILDERS.bar);
    assert.equal(b.byClass('ui-bar-mark')[0]!.getAttribute('title'), XSS);
    assert.equal(b.children[0]!.style.background, undefined, 'an invalid colour never reaches a style');
  });
});

describe('E1-9 card', () => {
  it('renders title, meta and body given as text or node', () => {
    const c = make('card({ title: "T", meta: "M", body: "B" })');
    assert.ok(c.classList.contains('ui-card'));
    const text = c.textContent;
    for (const part of ['T', 'M', 'B']) assert.ok(text.includes(part), part);
    const withNode = make('(() => { const p = document.createElement("p"); p.textContent = "node"; return card({ title: "T", body: p }); })()');
    assert.equal(withNode.find((e) => e.tagName === 'p').length, 1);
    assert.ok(withNode.textContent.includes('node'));
  });

  it('does not collide with the page-local .card class', () => {
    const c = make('card({ title: "T", body: "B" })');
    assert.ok(!all(c).some((e) => e.classList.contains('card')));
  });
});

describe('E1-9 CSS', () => {
  it('the component CSS is delivered with the tokens and the hatch is a repeating-linear-gradient', () => {
    assert.ok(TOKENS_CSS.includes(COMPONENTS_CSS));
    assert.match(COMPONENTS_CSS, /repeating-linear-gradient\(135deg/);
  });

  it('transitions and animations in the component CSS only touch transform or opacity', () => {
    for (const m of COMPONENTS_CSS.matchAll(/transition\s*:\s*([^;}]*)/g)) {
      for (const part of m[1]!.split(',')) assert.match(part.trim(), /^(transform|opacity)\b/, part);
    }
    assert.ok(!/transition-property/.test(COMPONENTS_CSS));
    assert.ok(!/@keyframes/.test(COMPONENTS_CSS));
  });

  it('does not restyle the existing selectors', () => {
    const selectors = [...COMPONENTS_CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)].flatMap((m) => m[1]!.split(','));
    for (const s of selectors) {
      const sel = s.trim();
      assert.ok(!/(^|[\s>+~])\.(chip|card|stat|badge|btn|seg)\b/.test(sel) && !/(^|[\s>+~])(button|article|span|div|a)\s*$/.test(sel), sel);
    }
  });

  it('colours come from the tokens (no hard-coded hex colours in the component CSS)', () => {
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(COMPONENTS_CSS));
  });
});

describe('fake DOM helper', () => {
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
    assert.equal(child.tagName, 'span');
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
