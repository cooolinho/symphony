import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { ICONS_JS } from '../src/http/icons.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { COMPONENTS_CSS, COMPONENTS_JS } from '../src/http/ui/components.ts';
import { TOKENS_CSS } from '../src/http/ui/tokens.ts';

/*
 * Acceptance tests for the ring gauge, sparkline, avatar, equalizer and icons (derived from the issue, not from the
 * implementation). Own strict mini DOM: innerHTML throws, and className on SVG elements throws (in a browser it is
 * a read-only SVGAnimatedString, so code must use setAttribute('class')).
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

class Node_ {
  kids: Node_[] = [];
  attrs: Record<string, string> = {};
  props: Record<string, string> = {};
  text = '';
  tag: string;
  ns: string;
  constructor(tag: string, ns: string) {
    this.tag = tag;
    this.ns = ns;
  }
  style = { setProperty: (k: string, v: unknown) => void (this.props[k] = String(v)) };
  get className(): string {
    if (this.ns === SVG_NS) throw new Error('className is read-only on SVG elements');
    return this.attrs.class ?? '';
  }
  set className(v: string) {
    if (this.ns === SVG_NS) throw new Error('className is read-only on SVG elements');
    this.attrs.class = v;
  }
  get classes(): string[] {
    return (this.attrs.class ?? '').split(/\s+/).filter(Boolean);
  }
  get textContent(): string {
    return this.text + this.kids.map((k) => k.textContent).join('');
  }
  set textContent(v: string) {
    this.kids = [];
    this.text = String(v);
  }
  set innerHTML(_v: string) {
    throw new Error('innerHTML is forbidden');
  }
  insertAdjacentHTML(): void {
    throw new Error('insertAdjacentHTML is forbidden');
  }
  setAttribute(k: string, v: unknown): void {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string): string | null {
    return k in this.attrs ? (this.attrs[k] as string) : null;
  }
  append(...n: (Node_ | string)[]): void {
    for (const x of n) {
      if (typeof x === 'string') this.text += x;
      else this.kids.push(x);
    }
  }
  appendChild(n: Node_): Node_ {
    this.kids.push(n);
    return n;
  }
  all(): Node_[] {
    return this.kids.flatMap((k) => [k, ...k.all()]);
  }
  withClass(c: string): Node_[] {
    return this.all().filter((n) => n.classes.includes(c));
  }
}

const ctx = vm.createContext({
  document: {
    createElement: (t: string) => new Node_(t, 'http://www.w3.org/1999/xhtml'),
    createElementNS: (ns: string, t: string) => new Node_(t, ns),
  },
});
vm.runInContext(BASE_JS, ctx);
const call = (expr: string, scope: Record<string, unknown> = {}): Node_ => {
  Object.assign(ctx, scope);
  return vm.runInContext(expr, ctx) as Node_;
};
const XSS = '<img src=x onerror=alert(1)>';
const ring = (pct: unknown, o?: Record<string, unknown>): Node_ => call('ring(__p, __o)', { __p: pct, __o: o });
const spark = (v: unknown, c?: unknown): Node_ | null => call('sparkline(__v, __c)', { __v: v, __c: c });
const avatar = (role: unknown, state: unknown, o?: Record<string, unknown>): Node_ => call('avatar(__r, __s, __o)', { __r: role, __s: state, __o: o });
const badgeOf = (r: Node_): Node_ => r.withClass('ui-ring-pct')[0] as Node_;

describe('ring acceptance', () => {
  it('71 % with the developer icon: conic-gradient, icon inside the inner circle, amber badge, aria-label', () => {
    const r = call('ring(71, { color: "#fbbf24", inner: icon("developer", 34), label: "Developer playing, Context" })');
    assert.equal(r.attrs.role, 'img');
    assert.equal(r.attrs['aria-label'], 'Developer playing, Context, 71 percent');
    assert.equal((r.style as Record<string, unknown>).background, 'conic-gradient(#fbbf24 0 71%, rgba(255,255,255,.1) 71% 100%)');
    const inner = r.withClass('ui-ring-in')[0] as Node_;
    assert.equal(inner.kids[0]?.tag, 'svg');
    assert.equal(inner.kids[0]?.ns, SVG_NS);
    assert.equal(badgeOf(r).textContent, '71%');
    assert.ok(badgeOf(r).classes.includes('hot'));
  });
  it('null, NaN, Infinity and strings show a dash and no progress', () => {
    for (const v of [null, NaN, Infinity, '80', undefined]) {
      const r = ring(v);
      assert.equal(badgeOf(r).textContent, '—', String(v));
      assert.ok(r.classes.includes('is-empty'));
      assert.match(String((r.style as Record<string, unknown>).background), /^conic-gradient\([^ ]+ 0 0%, rgba\(255,255,255,\.1\) 0% 100%\)$/);
    }
  });
  it('the badge is sky below 70 % and amber from 70 %; 0 and 100 are real values', () => {
    assert.ok(!badgeOf(ring(69)).classes.includes('hot'));
    assert.ok(badgeOf(ring(70)).classes.includes('hot'));
    assert.equal(badgeOf(ring(0)).textContent, '0%');
    assert.equal(badgeOf(ring(100)).textContent, '100%');
  });
  it('treats the label and a text inner as text', () => {
    const r = ring(5, { label: XSS, inner: XSS });
    assert.equal(r.all().filter((n) => n.tag === 'img').length, 0);
    assert.ok(r.attrs['aria-label']?.startsWith(XSS));
    assert.ok(r.textContent.includes(XSS));
  });
});

describe('sparkline acceptance', () => {
  it('an svg in the SVG namespace (class via setAttribute) with one polyline', () => {
    const s = spark([3, 1, 4, 1, 5], '#34d399') as Node_;
    assert.equal(s.ns, SVG_NS);
    assert.equal(s.attrs.class, 'ui-spark');
    assert.equal(s.attrs.viewBox, '0 0 100 24');
    assert.equal(s.attrs['aria-hidden'], 'true');
    const line = s.kids[0] as Node_;
    assert.equal(line.tag, 'polyline');
    assert.equal(line.attrs['vector-effect'], 'non-scaling-stroke');
    assert.equal(line.attrs['stroke-width'], '1.6');
    assert.equal((line.attrs.points ?? '').split(' ').length, 5);
  });
  it('maps the maximum to the top', () => {
    const [a, b] = ((spark([0, 10]) as Node_).kids[0]?.attrs.points ?? '').split(' ').map((p) => p.split(',').map(Number));
    assert.ok((a as number[])[1]! > (b as number[])[1]!);
  });
  it('an empty or invalid series gives no svg', () => {
    for (const v of [[], undefined, null, [NaN, Infinity], 'abc', {}]) assert.equal(spark(v), null, String(v));
  });
});

describe('avatar acceptance', () => {
  const STATES = ['done', 'playing', 'waiting', 'returned', 'skipped'];
  it('every state has its own class and title "Role · state"; ring and equalizer only when playing', () => {
    for (const st of STATES) {
      const a = avatar('reviewer', st);
      assert.ok(a.classes.includes('is-' + st), st);
      assert.equal(a.attrs.title, 'Reviewer · ' + st);
      assert.equal(a.withClass('ring').length, st === 'playing' ? 1 : 0, st);
      assert.equal(a.withClass('eq').length, st === 'playing' ? 1 : 0, st);
    }
  });
  it('at 64 / 96 px done shows a check badge, returned a cross badge, the others none', () => {
    for (const size of [64, 96]) {
      for (const st of STATES) {
        const badges = avatar('security', st, { size }).withClass('ui-av-badge');
        assert.equal(badges.length, st === 'done' || st === 'returned' ? 1 : 0, `${size} ${st}`);
        if (st === 'returned') assert.ok(badges[0]?.classes.includes('is-x'));
      }
    }
  });
  it('every role has an icon at 64 px and a short name at 30 px', () => {
    for (const role of ['analyst', 'architect', 'developer', 'tester', 'docs', 'reviewer', 'security', 'symphony', 'human']) {
      const big = avatar(role, 'done', { size: 64 });
      assert.equal(big.kids[0]?.tag, 'svg', role);
      assert.equal(big.kids[0]?.attrs.width, '26', role);
      assert.equal(avatar(role, 'done').withClass('ui-av-face')[0]?.textContent.length, 2, role);
    }
  });
  it('role, state and short name are text, never markup', () => {
    const a = avatar(XSS, XSS, { short: XSS });
    assert.equal(a.all().filter((n) => n.tag === 'img').length, 0);
    assert.ok(a.classes.includes('is-waiting'));
    assert.ok(!a.attrs.class?.includes('<'));
  });
});

describe('no innerHTML for the blocks', () => {
  it('the strict DOM would have thrown; additionally the block sources have no innerHTML-like sinks', () => {
    for (const src of [COMPONENTS_JS, ICONS_JS]) assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML|document\.write|DOMParser|sc-camel/);
  });
  it('the blocks are available in every page that embeds BASE_JS', () => {
    for (const [name, html] of Object.entries({ dashboard: DASHBOARD_HTML, agent: AGENT_HTML, logs: LOGS_HTML })) {
      for (const fn of ['function ring(', 'function sparkline(', 'function avatar(', 'function eq(', 'function icon(']) assert.ok(html.includes(fn), `${name}: ${fn}`);
    }
  });
});

// --- CSS ------------------------------------------------------------------------------------------------------

/** Rule bodies whose selector list contains a selector matching the predicate. */
function bodies(css: string, pick: (selector: string) => boolean): string[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if ((m[1] as string).split(',').some((s) => pick(s.trim()))) out.push(m[2] as string);
  }
  return out;
}
const keyframeBody = (name: string): string => {
  const at = TOKENS_CSS.indexOf('@keyframes ' + name + ' ');
  assert.ok(at >= 0, 'keyframes ' + name);
  let depth = 0;
  for (let i = TOKENS_CSS.indexOf('{', at); i < TOKENS_CSS.length; i++) {
    if (TOKENS_CSS[i] === '{') depth++;
    if (TOKENS_CSS[i] === '}' && --depth === 0) return TOKENS_CSS.slice(TOKENS_CSS.indexOf('{', at) + 1, i);
  }
  throw new Error('unbalanced');
};

describe('CSS of the blocks', () => {
  it('the playing avatar animates through the pulse and equalizer keyframes, which touch only transform and opacity', () => {
    assert.match(bodies(TOKENS_CSS, (s) => s === '.ring' || s === '.ring-lg').join(';'), /pulse/);
    assert.match(bodies(TOKENS_CSS, (s) => /^\.eq i$/.test(s)).join(';'), /animation:[^;]*\beq\b/);
    for (const name of ['pulse', 'pulse-lg', 'eq']) {
      const props = [...keyframeBody(name).matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]);
      assert.ok(props.length > 0, name);
      assert.ok(props.every((p) => p === 'transform' || p === 'opacity'), `${name}: ${props.join(',')}`);
    }
  });
  it('the ring, avatar and spark rules live in COMPONENTS_CSS; the old gauge / avatar rules are gone', () => {
    for (const sel of ['.ui-ring', '.ui-ring-pct.hot', '.ui-av.is-waiting', '.ui-av.is-returned', '.ui-av.is-skipped', '.ui-av-badge', '.ui-spark']) {
      assert.ok(bodies(COMPONENTS_CSS, (s) => s === sel).length > 0, sel);
    }
    assert.equal(bodies(TOKENS_CSS, (s) => /^\.(gauge|avatar|av-|spark)/.test(s)).length, 0);
  });
  it('prefers-reduced-motion stops all animations', () => {
    const at = TOKENS_CSS.indexOf('@media (prefers-reduced-motion: reduce)');
    assert.ok(at >= 0);
    const block = TOKENS_CSS.slice(at, TOKENS_CSS.indexOf('@media', at + 10) > 0 ? TOKENS_CSS.indexOf('@media', at + 10) : undefined);
    assert.match(block, /\*[^{]*\{[^}]*animation:\s*none\s*!important/);
  });
});

describe('embedding in the pages', () => {
  it('the inline scripts still parse with the new blocks (no duplicate top-level declarations, e.g. SVG_NS next to charts.ts)', () => {
    for (const [name, html] of Object.entries({ dashboard: DASHBOARD_HTML, agent: AGENT_HTML, logs: LOGS_HTML })) {
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] as string);
      assert.ok(scripts.length > 0, name);
      for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script, { filename: `${name}.js` }), name);
    }
  });
});
