import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { COMPONENTS_CSS, COMPONENTS_JS } from '../src/http/ui/components.ts';
import { TOKENS_CSS } from '../src/http/ui/tokens.ts';
import { FakeElement, createDocument, domContext, run } from './helpers/fake-dom.ts';

const ctx = domContext(BASE_JS);
const make = (code: string): FakeElement => run(ctx, code);
const first = (root: FakeElement, cls: string): FakeElement | undefined => root.byClass(cls)[0];

describe('fake DOM helper', () => {
  it('joins text, clears children, returns null for missing attributes and fires click listeners', () => {
    const doc = createDocument();
    const a = doc.createElement('div');
    a.append('x', doc.createElement('b'));
    a.children[0]!.textContent = 'y';
    assert.equal(a.textContent, 'xy');
    a.textContent = 'z';
    assert.equal(a.children.length, 0);
    assert.equal(a.textContent, 'z');
    assert.equal(a.getAttribute('nope'), null);
    let clicks = 0;
    a.addEventListener('click', () => clicks++);
    a.click();
    assert.equal(clicks, 1);
    assert.throws(() => { a.innerHTML = '<b>'; });
  });
});

describe('UI components wiring', () => {
  it('are part of BASE_JS, TOKENS_CSS and every page and define the five functions', () => {
    assert.ok(BASE_JS.includes(COMPONENTS_JS));
    assert.ok(TOKENS_CSS.includes(COMPONENTS_CSS));
    for (const html of [DASHBOARD_HTML, AGENT_HTML, LOGS_HTML]) {
      assert.ok(html.includes('function progressBar('));
      assert.ok(html.includes('.ui-bar-forecast'));
    }
    for (const fn of ['card', 'statTile', 'progressBar', 'chip', 'filterChip']) assert.equal(run(ctx, `typeof ${fn}`), 'function', fn);
  });

  it('never use innerHTML and render data as text', () => {
    for (const bad of ['innerHTML', 'insertAdjacentHTML', 'outerHTML']) assert.ok(!COMPONENTS_JS.includes(bad), bad);
    ctx.evil = '<img src=x onerror=alert(1)>';
    const c = make('card({ title: evil, meta: evil, body: evil })');
    assert.equal(first(c, 'ui-card-title')!.textContent, ctx.evil);
    assert.equal(c.find((e) => e.tagName === 'IMG').length, 0);
    const ch = make('chip({ text: evil, tone: "red" })');
    assert.equal(ch.textContent, ctx.evil);
    assert.equal(ch.find((e) => e.tagName === 'IMG').length, 0);
  });
});

describe('card', () => {
  it('renders title, meta and body', () => {
    const c = make('card({ title: "Runs", meta: "last 24h", body: document.createElement("p") })');
    assert.equal(c.tagName, 'ARTICLE');
    assert.ok(c.classList.contains('ui-card') && c.classList.contains('g'));
    assert.equal(first(c, 'ui-card-title')!.tagName, 'H3');
    assert.equal(first(c, 'ui-card-title')!.textContent, 'Runs');
    assert.equal(first(c, 'ui-card-meta')!.textContent, 'last 24h');
    assert.equal(first(c, 'ui-card-body')!.children[0]!.tagName, 'P');
    assert.equal(first(make('card({ body: "text" })'), 'ui-card-body')!.textContent, 'text');
  });
  it('omits head and body when empty', () => {
    const c = make('card({ body: "x" })');
    assert.equal(c.byClass('ui-card-head').length, 0);
    assert.equal(make('card({ title: "t" })').byClass('ui-card-body').length, 0);
  });
});

describe('statTile', () => {
  it('renders label, value, unit, tone and spark', () => {
    const t = make('statTile({ label: "Cost", value: 12, unit: "USD", tone: "green", spark: document.createElement("svg") })');
    assert.equal(t.tagName, 'DIV');
    for (const cls of ['ui-stat', 'gi', 'tone-green']) assert.ok(t.classList.contains(cls), cls);
    assert.equal(first(t, 'ui-stat-label')!.textContent, 'Cost');
    assert.equal(first(t, 'dot')!.tagName, 'SPAN');
    assert.equal(first(t, 'ui-stat-value')!.textContent, '12USD');
    assert.equal(first(t, 'ui-stat-unit')!.textContent, 'USD');
    assert.equal(first(t, 'ui-stat-spark')!.children[0]!.tagName, 'SVG');
  });
  it('handles missing spark, unknown tone and null value', () => {
    const t = make('statTile({ label: "L", value: null, tone: "pink" })');
    assert.ok(!t.className.includes('tone-'));
    assert.equal(t.byClass('dot').length, 0);
    assert.equal(t.byClass('ui-stat-spark').length, 0);
    assert.equal(t.byClass('ui-stat-unit').length, 0);
    assert.equal(first(t, 'ui-stat-value')!.textContent, '—');
  });
});

describe('progressBar', () => {
  it('draws the hatched forecast behind the fill only with a forecast', () => {
    const b = make('progressBar({ value: 5, max: 10, forecast: 8, tone: "amber" })');
    assert.ok(b.classList.contains('ui-bar') && b.classList.contains('tone-amber'));
    assert.equal(b.getAttribute('role'), 'progressbar');
    assert.equal(b.getAttribute('aria-valuenow'), '50');
    assert.equal(b.getAttribute('aria-valuemax'), '100');
    assert.equal(b.children[0]!.className, 'ui-bar-forecast');
    assert.equal(b.children[0]!.style.transform, 'scaleX(0.8)');
    assert.equal(b.children[1]!.className, 'ui-bar-fill');
    assert.equal(b.children[1]!.style.transform, 'scaleX(0.5)');
    for (const code of ['progressBar({ value: 5, max: 10 })', 'progressBar({ value: 5, max: 10, forecast: null })']) {
      const n = make(code);
      assert.equal(n.children.length, 1);
      assert.equal(n.byClass('ui-bar-forecast').length, 0);
      assert.equal(n.children[0]!.className, 'ui-bar-fill');
    }
  });
  it('clamps values', () => {
    assert.equal(make('progressBar({ value: 20, max: 10 })').children[0]!.style.transform, 'scaleX(1)');
    for (const code of ['progressBar({ value: 3, max: 0 })', 'progressBar({ value: NaN, max: 10 })']) {
      const n = make(code);
      assert.equal(n.children[0]!.style.transform, 'scaleX(0)');
      assert.equal(n.getAttribute('aria-valuenow'), '0');
    }
  });
});

describe('chip', () => {
  it('is a span with tone and optional icon', () => {
    const c = make('chip({ text: "Retry", tone: "amber", icon: "!" })');
    assert.equal(c.tagName, 'SPAN');
    assert.ok(c.classList.contains('ui-chip') && c.classList.contains('tone-amber'));
    assert.equal(first(c, 'ui-chip-text')!.textContent, 'Retry');
    assert.equal(first(c, 'ui-chip-icon')!.getAttribute('aria-hidden'), 'true');
    assert.equal(make('chip({ text: "x" })').byClass('ui-chip-icon').length, 0);
  });
});

describe('filterChip', () => {
  it('is a button with aria-pressed that toggles and calls onToggle', () => {
    ctx.calls = [];
    const b = make('filterChip({ text: "Errors", count: 1284, active: false, onToggle: (next) => calls.push(next) })');
    assert.equal(b.tagName, 'BUTTON');
    assert.equal(b.getAttribute('type'), 'button');
    assert.equal(b.getAttribute('aria-pressed'), 'false');
    assert.equal(first(b, 'ui-fchip-text')!.textContent, 'Errors');
    assert.equal(first(b, 'ui-fchip-count')!.textContent, '1,284');
    b.click();
    assert.equal(b.getAttribute('aria-pressed'), 'true');
    b.click();
    assert.equal(b.getAttribute('aria-pressed'), 'false');
    assert.deepEqual([...ctx.calls], [true, false]);
    assert.equal(make('filterChip({ text: "A", active: true })').getAttribute('aria-pressed'), 'true');
    assert.equal(make('filterChip({ text: "A", active: true })').byClass('ui-fchip-count').length, 0);
  });
});

describe('COMPONENTS_CSS', () => {
  const rules = [...COMPONENTS_CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
  it('only styles ui- classes, hatches only the forecast and animates only transform/opacity', () => {
    assert.ok(rules.length > 5);
    for (const r of rules) assert.ok(r.selector.includes('.ui-'), r.selector);
    const hatched = rules.filter((r) => r.body.includes('repeating-linear-gradient'));
    assert.equal(hatched.length, 1);
    assert.equal(hatched[0]!.selector, '.ui-bar-forecast');
    assert.ok(!COMPONENTS_CSS.includes('@keyframes'));
    for (const m of COMPONENTS_CSS.matchAll(/transition:([^;}]*)/g)) assert.match(m[1]!, /^\s*(transform|opacity)\b/);
  });
});
