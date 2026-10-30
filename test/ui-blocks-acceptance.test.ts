import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { TOKENS_CSS } from '../src/http/ui/tokens.ts';

/*
 * Independent acceptance tests for the gauge, sparkline and avatar blocks (derived from the issue, not from the
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
const gauge = (o: Record<string, unknown>): Node_ => call('ringGauge(__o)', { __o: o });
const spark = (v: unknown, o?: Record<string, unknown>): Node_ => call('sparkline(__v, __o)', { __v: v, __o: o });
const avatar = (o: Record<string, unknown>): Node_ => call('avatar(__o)', { __o: o });
const valueOf = (g: Node_): Node_ => g.all().find((n) => n.classes.includes('gauge-value')) as Node_;

describe('ringGauge acceptance', () => {
  it('42 % sets --p to 42 and shows the number in monospace in the centre', () => {
    const g = gauge({ percent: 42, label: 'Context', tone: 'cyan' });
    assert.equal(g.props['--p'], '42');
    const v = valueOf(g);
    assert.ok(v, 'value element');
    assert.match(v.textContent, /^42\s*%$/);
    assert.ok(v.classes.includes('num') || v.classes.includes('mono'), 'monospace class');
    assert.ok(g.textContent.includes('Context'));
    assert.ok(g.classes.includes('tone-cyan'));
  });
  it('the value sits inside the ring element, not beside it', () => {
    const g = gauge({ percent: 10 });
    const ring = g.all().find((n) => n.classes.includes('gauge-ring')) as Node_;
    assert.ok(ring.all().includes(valueOf(g)));
  });
  it('null shows a dash and a gray ring without progress', () => {
    const g = gauge({ percent: null, label: 'Context' });
    assert.equal(valueOf(g).textContent, '—');
    assert.ok(g.classes.includes('tone-gray'));
    assert.ok(!g.classes.includes('tone-green'));
    assert.ok(['0', ''].includes(g.props['--p'] ?? ''));
    assert.ok(!valueOf(g).textContent.includes('%'));
  });
  it('null ignores a requested tone (stays gray)', () => {
    assert.ok(gauge({ percent: null, tone: 'red' }).classes.includes('tone-gray'));
  });
  it('NaN, undefined, strings and Infinity are treated as no data', () => {
    for (const percent of [NaN, undefined, 'abc', Infinity, -Infinity]) {
      const g = gauge({ percent });
      assert.equal(valueOf(g).textContent, '—', String(percent));
      assert.ok(g.classes.includes('tone-gray'), String(percent));
    }
  });
  it('clamps to 0–100 and keeps 0 and 100 as real values', () => {
    assert.equal(gauge({ percent: 250 }).props['--p'], '100');
    assert.equal(gauge({ percent: -3 }).props['--p'], '0');
    assert.equal(valueOf(gauge({ percent: 0 })).textContent, '0%');
    assert.equal(valueOf(gauge({ percent: 100 })).textContent, '100%');
    assert.ok(!gauge({ percent: 0 }).classes.includes('tone-gray'), '0 % is data, not empty');
  });
  it('works without options and without label', () => {
    assert.doesNotThrow(() => call('ringGauge()'));
    assert.doesNotThrow(() => call('ringGauge({})'));
    assert.equal(gauge({ percent: 5 }).withClass('gauge-label').length, 0);
  });
  it('treats the label as text', () => {
    const g = gauge({ percent: 5, label: '<b>x</b>' });
    assert.ok(g.textContent.includes('<b>x</b>'));
    assert.equal(g.all().filter((n) => n.tag === 'b').length, 0);
  });
});

describe('sparkline acceptance', () => {
  it('builds an svg in the SVG namespace with an aria-hidden attribute and a polyline with points', () => {
    const s = spark([1, 4, 2, 8], { width: 80, height: 24, tone: 'amber' });
    assert.equal(s.tag, 'svg');
    assert.equal(s.ns, SVG_NS);
    assert.equal(s.getAttribute('aria-hidden'), 'true');
    assert.equal(s.getAttribute('width'), '80');
    assert.equal(s.getAttribute('height'), '24');
    assert.ok((s.getAttribute('class') ?? '').includes('tone-amber'));
    const lines = s.all().filter((n) => n.tag === 'polyline');
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.ns, SVG_NS);
    const pts = (lines[0]?.getAttribute('points') ?? '').trim().split(/\s+/);
    assert.equal(pts.length, 4);
    for (const p of pts) assert.match(p, /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);
  });
  it('maps the maximum to the top and the minimum to the bottom (y grows downwards)', () => {
    const s = spark([0, 10], { width: 100, height: 20 });
    const [a, b] = (s.all()[0]?.getAttribute('points') ?? '').split(' ').map((p) => p.split(',').map(Number));
    assert.ok(a![1]! > b![1]!, 'low value has larger y');
    assert.ok(a![0]! < b![0]!, 'x increases');
  });
  it('empty, missing and invalid values give an empty svg without errors', () => {
    for (const v of [[], undefined, null, 'abc', 42, {}]) {
      let s: Node_ | undefined;
      assert.doesNotThrow(() => (s = spark(v)), String(v));
      assert.equal(s?.tag, 'svg');
      assert.equal(s?.getAttribute('aria-hidden'), 'true');
      assert.equal(s?.all().filter((n) => n.tag === 'polyline').length, 0, String(v));
    }
  });
  it('a single value and constant values yield finite points', () => {
    for (const v of [[3], [5, 5, 5], [0, 0]]) {
      const pts = spark(v).all().find((n) => n.tag === 'polyline')?.getAttribute('points') ?? '';
      assert.ok(pts.length > 0 && !/NaN|Infinity/.test(pts), JSON.stringify(v));
    }
  });
  it('works without options', () => {
    assert.doesNotThrow(() => spark([1, 2, 3]));
  });
});

describe('avatar acceptance', () => {
  it('shows a role-coloured circle with the initial; title and aria-label carry role and state', () => {
    const a = avatar({ role: 'tester', state: 'done', size: 40 });
    assert.ok(a.classes.includes('avatar'));
    assert.ok(a.classes.includes('role-tester'));
    assert.ok(a.textContent.includes('T'));
    for (const attr of ['title', 'aria-label']) {
      const v = (a.getAttribute(attr) ?? '').toLowerCase();
      assert.ok(v.includes('tester') && v.includes('done'), attr);
    }
  });
  it('playing has pulse ring and 3 equalizer bars; done, waiting, returned and skipped have neither', () => {
    const playing = avatar({ role: 'developer', state: 'playing' });
    assert.equal(playing.withClass('ring').length, 1);
    assert.ok(playing.withClass('ring')[0]?.classes.includes('ring-lg'));
    const eq = playing.withClass('eq');
    assert.equal(eq.length, 1);
    assert.equal(eq[0]?.kids.filter((k) => k.tag === 'i').length, 3);
    for (const state of ['done', 'waiting', 'returned', 'skipped']) {
      const a = avatar({ role: 'developer', state });
      assert.equal(a.withClass('ring').length + a.withClass('eq').length, 0, state);
      assert.ok(!a.classes.includes('av-playing'), state);
    }
  });
  it('every state gets its own distinguishing class', () => {
    const states = ['done', 'playing', 'waiting', 'returned', 'skipped'];
    const classes = states.map((s) => avatar({ role: 'docs', state: s }).classes.join(' '));
    assert.equal(new Set(classes).size, 5);
    for (const s of states) assert.ok(avatar({ role: 'docs', state: s }).classes.includes('av-' + s));
  });
  it('done shows a check mark, returned a cross, others neither', () => {
    const badgeText = (state: string): string => avatar({ role: 'analyst', state }).withClass('avatar-badge').map((n) => n.textContent).join('');
    assert.match(badgeText('done'), /[✓✔]/);
    assert.match(badgeText('returned'), /[✕✗✖×xX]/);
    for (const s of ['playing', 'waiting', 'skipped']) assert.equal(badgeText(s), '', s);
  });
  it('knows all pipeline roles', () => {
    for (const role of ['analyst', 'architect', 'developer', 'tester', 'docs', 'reviewer', 'security', 'symphony', 'human']) {
      const a = avatar({ role, state: 'done' });
      assert.ok(a.classes.includes('role-' + role), role);
      assert.ok(TOKENS_CSS.includes('.role-' + role), 'css for ' + role);
    }
  });
  it('falls back to a neutral look for unknown role, unknown state and missing options', () => {
    const a = avatar({ role: 'nobody', state: 'weird' });
    assert.ok(!a.classes.some((c) => c.startsWith('role-')));
    assert.ok(!a.classes.includes('av-playing'));
    assert.equal(a.withClass('ring').length, 0);
    assert.doesNotThrow(() => call('avatar()'));
    assert.doesNotThrow(() => call('avatar({})'));
  });
  it('applies the size via a CSS variable and ignores nonsense sizes', () => {
    assert.equal(avatar({ role: 'docs', state: 'done', size: 52 }).props['--av-size'], '52px');
    for (const size of ['big', NaN, -1, 0, 100000]) {
      const px = avatar({ role: 'docs', state: 'done', size }).props['--av-size'] ?? '';
      assert.match(px, /^\d+(\.\d+)?px$/);
      assert.ok(parseFloat(px) >= 8 && parseFloat(px) <= 256, String(size));
    }
  });
  it('treats role and state as text, never as markup', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const a = avatar({ role: payload, state: payload });
    assert.ok(a.all().every((n) => n.tag !== 'img'));
    assert.ok(!a.classes.some((c) => c.includes('<') || c.includes('=')), 'no raw markup in classes');
  });
});

describe('no innerHTML for the blocks', () => {
  it('the strict DOM would have thrown; additionally the block source has no innerHTML or insertAdjacentHTML', () => {
    const start = BASE_JS.indexOf('function ringGauge');
    const end = BASE_JS.indexOf('return root;', BASE_JS.indexOf('function avatar'));
    assert.ok(start > 0 && end > start);
    assert.doesNotMatch(BASE_JS.slice(start, end), /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  });
  it('the three blocks are available in every page that embeds BASE_JS', () => {
    for (const [name, html] of Object.entries({ dashboard: DASHBOARD_HTML, agent: AGENT_HTML, logs: LOGS_HTML })) {
      for (const fn of ['function ringGauge', 'function sparkline', 'function avatar']) assert.ok(html.includes(fn), `${name}: ${fn}`);
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
  it('the gauge ring is a conic-gradient driven by --p', () => {
    const css = bodies(TOKENS_CSS, (s) => /\.gauge/.test(s)).join(';');
    assert.match(css, /conic-gradient\([^;]*var\(--p\)/);
  });
  it('the gauge number is monospace', () => {
    const css = bodies(TOKENS_CSS, (s) => /gauge-value|\.num$/.test(s)).join(';');
    assert.match(css, /var\(--mono\)|monospace/);
  });
  it('avatar takes its colour from --role; waiting is dashed; skipped is greyed out; returned/done badges differ', () => {
    assert.match(bodies(TOKENS_CSS, (s) => s === '.avatar').join(';'), /var\(--role/);
    assert.match(bodies(TOKENS_CSS, (s) => /av-waiting/.test(s)).join(';'), /dashed/);
    assert.match(bodies(TOKENS_CSS, (s) => /av-skipped/.test(s)).join(';'), /grayscale|opacity/);
    const ret = bodies(TOKENS_CSS, (s) => /av-returned/.test(s)).join(';');
    assert.match(ret, /var\(--red\)/);
  });
  it('the playing avatar animates through the pulse and equalizer keyframes, and only these animate', () => {
    assert.match(bodies(TOKENS_CSS, (s) => s === '.ring' || s === '.ring-lg').join(';'), /pulse/);
    assert.match(bodies(TOKENS_CSS, (s) => /^\.eq i$/.test(s)).join(';'), /animation:[^;]*\beq\b/);
  });
  it('the animations touch only transform and opacity', () => {
    for (const name of ['pulse', 'pulse-lg', 'eq']) {
      const props = [...keyframeBody(name).matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]);
      assert.ok(props.length > 0, name);
      assert.ok(props.every((p) => p === 'transform' || p === 'opacity'), `${name}: ${props.join(',')}`);
    }
    // No transition on the new blocks may touch anything else.
    const own = bodies(TOKENS_CSS, (s) => /gauge|\.avatar|\.spark/.test(s)).join(';');
    for (const m of own.matchAll(/transition\s*:\s*([^;]+)/g)) assert.match(m[1] as string, /^(transform|opacity)\b/);
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
