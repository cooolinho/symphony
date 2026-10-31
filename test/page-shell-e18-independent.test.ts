// E1-8 (independent): acceptance tests derived from the issue. They parse the rendered HTML into a tree, resolve the
// CSS for single elements ("computed styles" of a fake DOM) and run the shell script against a fake document.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { TOKENS_CSS } from '../src/http/ui/tokens.ts';
import { AURORA, LAYOUT_JS, breadcrumbs, page, pageHeader, panel, twoColumns } from '../src/http/ui/layout.ts';

// ---------------------------------------------------------------- tiny HTML parser + style resolver
interface Node {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
  parent: Node | null;
  text: string;
}
const VOID = new Set(['meta', 'link', 'br', 'input', 'img', 'hr', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon']);

function parse(html: string): { root: Node; css: string } {
  const root: Node = { tag: '#root', attrs: {}, children: [], parent: null, text: '' };
  let cur = root;
  let css = '';
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let skipUntil: string | null = null;
  let rawStart = 0;
  while ((m = re.exec(html))) {
    if (skipUntil) {
      if (m[1] && m[2]?.toLowerCase() === skipUntil) {
        if (skipUntil === 'style') css += html.slice(rawStart, m.index);
        skipUntil = null;
        cur = cur.parent ?? root;
      }
      continue;
    }
    if (m[4] !== undefined) { cur.text += m[4]; continue; }
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      let n: Node | null = cur;
      while (n && n.tag !== tag) n = n.parent;
      if (n?.parent) cur = n.parent;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (m[3] ?? '').matchAll(/([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      attrs[a[1] as string] = a[2] ?? a[3] ?? a[4] ?? '';
    }
    const node: Node = { tag, attrs, children: [], parent: cur, text: '' };
    cur.children.push(node);
    if (VOID.has(tag) || /\/\s*$/.test(m[3] ?? '')) continue;
    cur = node;
    if (tag === 'style' || tag === 'script') { skipUntil = tag; rawStart = re.lastIndex; }
  }
  return { root, css };
}

const walk = (n: Node): Node[] => n.children.flatMap((c) => [c, ...walk(c)]);
const classes = (n: Node): string[] => (n.attrs.class ?? '').split(/\s+/).filter(Boolean);
const textOf = (n: Node): string => n.text + n.children.map(textOf).join('');
const ancestors = (n: Node): Node[] => (n.parent ? [n.parent, ...ancestors(n.parent)] : []);

interface Rule { selector: string; decls: Map<string, string> }
function parseRules(css: string, viewport = 1280): Rule[] {
  const rules: Rule[] = [];
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const walkBlock = (text: string, inMedia: boolean): void => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const head = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith('@media')) {
        // only media queries that match the viewport width apply
        const max = /max-width:\s*(\d+)px/.exec(head);
        const min = /min-width:\s*(\d+)px/.exec(head);
        const applies = !head.includes('prefers-') && (max ? Number(max[1]) >= viewport : true) && (min ? Number(min[1]) <= viewport : true);
        if (applies && !inMedia) walkBlock(body, true);
      } else if (head.startsWith('@')) {
        // keyframes etc.: ignore
      } else {
        const decls = new Map<string, string>();
        for (const d of body.split(';')) {
          const k = d.indexOf(':');
          if (k > 0) decls.set(d.slice(0, k).trim().toLowerCase(), d.slice(k + 1).trim());
        }
        for (const sel of head.split(',')) rules.push({ selector: sel.trim(), decls });
      }
      i = j;
    }
  };
  walkBlock(flat, false);
  return rules;
}

function matchCompound(sel: string, n: Node): boolean {
  if (/:/.test(sel.replace(/\[[^\]]*\]/g, ''))) return false;
  const tag = /^[a-zA-Z][a-zA-Z0-9]*/.exec(sel)?.[0];
  if (tag && tag.toLowerCase() !== n.tag) return false;
  for (const m of sel.matchAll(/\.([-\w]+)/g)) if (!classes(n).includes(m[1] as string)) return false;
  for (const m of sel.matchAll(/#([-\w]+)/g)) if (n.attrs.id !== m[1]) return false;
  for (const m of sel.matchAll(/\[([-\w]+)(?:="([^"]*)")?\]/g)) {
    if (!((m[1] as string) in n.attrs)) return false;
    if (m[2] !== undefined && n.attrs[m[1] as string] !== m[2]) return false;
  }
  return true;
}
/** Matches a selector with descendant (space) and child (>) combinators; no sibling combinators or pseudo-classes. */
function matches(sel: string, n: Node): boolean {
  if (/[+~]/.test(sel.replace(/"[^"]*"/g, ''))) return false;
  const parts = sel.replace(/\s*>\s*/g, ' > ').trim().split(/\s+/);
  const test = (i: number, node: Node): boolean => {
    const part = parts[i] as string;
    if (part === '>') return false;
    if (!matchCompound(part, node)) return false;
    if (i === 0) return true;
    if (parts[i - 1] === '>') return !!node.parent && test(i - 2, node.parent);
    for (let a = node.parent; a; a = a.parent) if (test(i - 1, a)) return true;
    return false;
  };
  return test(parts.length - 1, n);
}
const specificity = (sel: string): number => {
  const s = sel.replace(/"[^"]*"/g, '');
  return (s.match(/#/g)?.length ?? 0) * 10000 + ((s.match(/\.|\[/g)?.length ?? 0) * 100) + (s.match(/(^|[\s>])[a-zA-Z]/g)?.length ?? 0);
};

/** Declarations that apply to a node: cascade by specificity and source order, then the inline style. */
function computed(n: Node, rules: Rule[]): Map<string, string> {
  const hit = rules.map((r, i) => ({ r, i, sp: specificity(r.selector) })).filter((x) => matches(x.r.selector, n)).sort((a, b) => a.sp - b.sp || a.i - b.i);
  const out = new Map<string, string>();
  for (const { r } of hit) for (const [k, v] of r.decls) out.set(k, v);
  for (const d of (n.attrs.style ?? '').split(';')) {
    const k = d.indexOf(':');
    if (k > 0) out.set(d.slice(0, k).trim().toLowerCase(), d.slice(k + 1).trim());
  }
  return out;
}
const norm = (v: string | undefined): string => (v ?? '').replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').replace(/\b0\./g, '.').trim().toLowerCase();

const tokenVars = new Map<string, string>([...TOKENS_CSS.matchAll(/(--[-\w]+):\s*([^;]+);/g)].map((m) => [m[1] as string, (m[2] as string).trim()]));
const resolveVar = (v: string | undefined): string => {
  const m = /^var\((--[-\w]+)\)$/.exec((v ?? '').trim());
  return norm(m ? tokenVars.get(m[1] as string) : v);
};

const shell = (o: Partial<Parameters<typeof page>[0]> = {}) => {
  const html = page({ title: 'T', nav: 'overview', aurora: AURORA.overview, body: '<p>x</p>', scripts: '', ...o });
  const { root, css } = parse(html);
  const rules = parseRules(css);
  const all = walk(root);
  return { html, root, rules, all, css, cs: (n: Node) => computed(n, rules) };
};
const byAttr = (all: Node[], k: string, v: string): Node[] => all.filter((n) => n.attrs[k] === v);

// ---------------------------------------------------------------- tests
describe('E1-8 independent: Wurzel, Aurora, Container', () => {
  it('Wurzel: Hülle um Kopfleiste und Inhalt mit den geforderten Styles', () => {
    const s = shell();
    const header = s.all.find((n) => n.tag === 'header') as Node;
    const rootEl = ancestors(header).find((a) => s.cs(a).get('position') === 'relative' && s.cs(a).has('min-height')) as Node;
    assert.ok(rootEl, 'Wurzelelement mit position: relative und min-height');
    const c = s.cs(rootEl);
    assert.equal(norm(c.get('min-height')), '100vh');
    assert.equal(norm(c.get('overflow')), 'hidden');
    assert.equal(resolveVar(c.get('background') ?? c.get('background-color')), '#070b16');
    assert.equal(norm(c.get('color')), 'var(--fg)');
    assert.equal(norm(c.get('font-size')), '14px');
    assert.equal(norm(c.get('line-height')), '1.5');
    assert.ok(tokenVars.has('--fg'));
  });

  it('Aurora: aria-hidden, pointer-events none, Kreise 480–660 px / Blur 90–110 / Deckkraft .16–.32', () => {
    for (const [name, html] of Object.entries({ dashboard: DASHBOARD_HTML, agent: AGENT_HTML, logs: LOGS_HTML })) {
      const { root, css } = parse(html);
      const rules = parseRules(css);
      const container = walk(root).find((n) => n.attrs['aria-hidden'] === 'true' && n.children.length >= 3 && n.children.every((k) => /blur\(/.test(k.attrs.style ?? ''))) as Node;
      assert.ok(container, `${name}: aria-hidden Aurora-Container mit Kreisen`);
      assert.equal(norm(computed(container, rules).get('pointer-events')), 'none', name);
      assert.ok(container.children.length >= 3 && container.children.length <= 4, name);
      for (const circle of container.children) {
        const c = computed(circle, rules);
        const size = parseFloat(c.get('width') ?? '');
        assert.ok(size >= 480 && size <= 660, `${name} size ${size}`);
        assert.equal(parseFloat(c.get('height') ?? ''), size);
        assert.equal(norm(c.get('border-radius')), '50%');
        const blur = Number(/blur\((\d+)px\)/.exec(c.get('filter') ?? '')?.[1]);
        assert.ok(blur >= 90 && blur <= 110, `${name} blur ${blur}`);
        const op = parseFloat(c.get('opacity') ?? '');
        assert.ok(op >= 0.16 && op <= 0.32, `${name} opacity ${op}`);
        assert.equal(norm(c.get('position')), 'absolute');
      }
    }
  });

  it('Aurora Übersicht: Farben, Größen, Positionen, Deckkraft wie in der Issue', () => {
    const { root, css } = parse(DASHBOARD_HTML);
    const rules = parseRules(css);
    const container = walk(root).find((n) => n.attrs['aria-hidden'] === 'true' && n.children.length >= 3 && /blur\(/.test(n.children[0]?.attrs.style ?? '')) as Node;
    const got = container.children.map((k) => {
      const c = computed(k, rules);
      return { color: norm(c.get('background') ?? c.get('background-color')), size: parseFloat(c.get('width') as string), op: parseFloat(c.get('opacity') as string),
        left: c.get('left'), right: c.get('right'), top: c.get('top') };
    });
    assert.deepEqual(got.map((g) => g.color), ['#0d9488', '#6d28d9', '#1d4ed8', '#be185d']);
    assert.deepEqual(got.map((g) => g.size), [620, 560, 520, 480]);
    assert.deepEqual(got.map((g) => g.op), [0.32, 0.3, 0.22, 0.18]);
    assert.deepEqual([got[0]?.left, got[0]?.top], ['-160px', '-200px']);
    assert.deepEqual([got[1]?.right, got[1]?.top], ['-120px', '-120px']);
    assert.deepEqual([got[2]?.left, got[2]?.top], ['30%', '640px']);
    assert.deepEqual([got[3]?.right, got[3]?.top], ['6%', '1180px']);
  });

  it('Aurora je Seite: Team- und Statistik-Farben, mindestens drei Kreise überall', () => {
    const colorsIn = (html: string): string[] => {
      const { root, css } = parse(html);
      const rules = parseRules(css);
      const container = walk(root).find((n) => n.attrs['aria-hidden'] === 'true' && n.children.length >= 3 && /blur\(/.test(n.children[0]?.attrs.style ?? '')) as Node;
      return container.children.map((k) => norm(computed(k, rules).get('background') ?? computed(k, rules).get('background-color')));
    };
    assert.deepEqual(colorsIn(AGENT_HTML), ['#059669', '#6d28d9', '#0e7490', '#be185d']);
    assert.ok(colorsIn(LOGS_HTML).length >= 3);
    // The other presets from the issue are exposed via AURORA and accepted by page().
    const expected: Record<string, string[]> = {
      changes: ['#0d9488', '#7c3aed', '#1d4ed8'], tasks: ['#0d9488', '#6d28d9', '#b45309'],
      brain: ['#7c3aed', '#0d9488', '#be185d'], stats: ['#1d4ed8', '#0d9488', '#7c3aed'],
    };
    for (const [key, list] of Object.entries(expected)) {
      const preset = (AURORA as unknown as Record<string, Array<{ color: string; size: number; opacity: number }>>)[key];
      assert.ok(preset && preset.length >= 3, `${key} preset`);
      assert.deepEqual(preset.map((p) => p.color), list, key);
      assert.deepEqual(colorsIn(page({ title: 't', nav: null, aurora: preset as never, body: '', scripts: '' })), list, key);
    }
    const brain = AURORA.brain;
    assert.deepEqual([brain[0]?.size, brain[0]?.opacity], [660, 0.32]);
  });

  it('page() nimmt die Kreise als Parameter {color,size,x,y,opacity}', () => {
    const custom = [
      { color: '#112233', size: 500, x: 'left 10px', y: 50, opacity: 0.2 },
      { color: '#223344', size: 550, x: 'right 20px', y: 80, opacity: 0.25 },
      { color: '#334455', size: 600, x: 'left 5%', y: 100, opacity: 0.3 },
    ];
    const s = shell({ aurora: custom as never });
    const container = s.all.find((n) => n.attrs['aria-hidden'] === 'true' && n.children.length === 3 && /blur/.test(n.children[0]?.attrs.style ?? '')) as Node;
    assert.ok(container);
    assert.deepEqual(container.children.map((k) => norm(s.cs(k).get('background'))), ['#112233', '#223344', '#334455']);
    assert.deepEqual(container.children.map((k) => parseFloat(s.cs(k).get('width') as string)), [500, 550, 600]);
  });

  it('Punktraster liegt über den Kreisen: radial-gradient 1px/1.5px, 22px Raster', () => {
    const s = shell();
    const grid = s.rules.find((r) => norm(r.decls.get('background-image') ?? r.decls.get('background')).includes('radial-gradient(rgba(255,255,255,.08) 1px,transparent 1.5px)'));
    assert.ok(grid, 'Regel mit Punktraster');
    assert.equal(norm(grid.decls.get('background-size')), '22px 22px');
    assert.equal(norm(grid.decls.get('pointer-events') ?? s.cs(s.all.find((n) => n.attrs['aria-hidden'] === 'true' && /blur/.test(n.children[0]?.attrs.style ?? '')) as Node).get('pointer-events')), 'none');
  });

  it('Container: max-width 1440, zentriert, Padding, Spalte, Gap 18', () => {
    const s = shell();
    const header = s.all.find((n) => n.tag === 'header') as Node;
    const wrap = ancestors(header).find((a) => norm(s.cs(a).get('max-width')) === '1440px') as Node;
    assert.ok(wrap, 'Container mit max-width 1440px');
    const c = s.cs(wrap);
    assert.equal(norm(c.get('margin')), '0 auto');
    assert.equal(norm(c.get('padding')), '16px 20px 48px');
    assert.equal(norm(c.get('display')), 'flex');
    assert.equal(norm(c.get('flex-direction')), 'column');
    assert.equal(norm(c.get('gap')), '18px');
    assert.ok(walk(wrap).some((n) => n.tag === 'main'), 'main liegt im Container');
  });
});

describe('E1-8 independent: Kopfleiste', () => {
  it('header.g: Radius 22, Padding, wrap, Gap; Logo-Link zu / mit weißem Fünf-Striche-Icon; Wortmarke', () => {
    const s = shell();
    const headers = s.all.filter((n) => n.tag === 'header');
    assert.equal(headers.length, 1);
    const header = headers[0] as Node;
    assert.ok(classes(header).includes('g'));
    const c = s.cs(header);
    assert.equal(norm(c.get('border-radius')), '22px');
    assert.equal(norm(c.get('padding')), '8px 10px 8px 14px');
    assert.equal(norm(c.get('flex-wrap')), 'wrap');
    assert.equal(norm(c.get('gap')), '10px 18px');
    const logo = walk(header).find((n) => n.tag === 'a' && n.attrs.href === '/' && walk(n).some((k) => k.tag === 'svg')) as Node;
    assert.ok(logo, 'Logo-Link zu /');
    const mark = walk(logo).find((n) => norm(s.cs(n).get('width')) === '36px') as Node;
    assert.ok(mark, '36-px-Marke');
    const mc = s.cs(mark);
    assert.equal(norm(mc.get('height')), '36px');
    assert.equal(norm(mc.get('border-radius')), '12px');
    assert.equal(norm(mc.get('background')), 'linear-gradient(140deg,#14b8a6,#7c3aed)');
    const svg = walk(mark).find((n) => n.tag === 'svg') as Node;
    const strokes = walk(svg).filter((n) => n.tag === 'path' || n.tag === 'line');
    assert.equal(strokes.length, 5, 'fünf Striche');
    assert.ok(/#fff|white|#ffffff/i.test(svg.attrs.stroke ?? svg.attrs.fill ?? '') || /color:\s*#fff/.test(mc.get('color') ?? '') || norm(mc.get('color')) === '#fff', 'weiß');
    const word = walk(logo).find((n) => textOf(n).trim() === 'Symphony' && n.children.length === 0) as Node;
    assert.ok(word, 'Wortmarke Symphony');
    const wc = s.cs(word);
    assert.match(`${wc.get('font') ?? ''} ${wc.get('font-size') ?? ''}`, /17px/);
    assert.match(`${wc.get('font') ?? ''} ${wc.get('font-weight') ?? ''}`, /600/);
  });

  it('Navigation: Hauptnavigation, fünf Links mit Icons, richtige hrefs, genau ein aria-current', () => {
    const hrefs = ['/', '/changes', '/tasks', '/brain', '/stats'];
    const labels = ['Übersicht', 'Changes', 'Tasks', 'Brain', 'Statistik'];
    const keys = ['overview', 'changes', 'tasks', 'brain', 'stats'] as const;
    for (const [i, key] of keys.entries()) {
      const s = shell({ nav: key });
      const navs = byAttr(s.all, 'aria-label', 'Hauptnavigation');
      assert.equal(navs.length, 1);
      const nav = navs[0] as Node;
      assert.equal(nav.tag, 'nav');
      const links = walk(nav).filter((n) => n.tag === 'a');
      assert.deepEqual(links.map((l) => l.attrs.href), hrefs);
      assert.deepEqual(links.map((l) => textOf(l).trim()), labels);
      for (const l of links) {
        assert.ok(classes(l).includes('nv'));
        const icon = walk(l).find((n) => n.tag === 'svg') as Node;
        assert.ok(icon, `Icon in ${l.attrs.href}`);
        assert.equal(icon.attrs.width, '16');
        assert.equal(icon.attrs.height, '16');
      }
      const current = links.filter((l) => 'aria-current' in l.attrs);
      assert.equal(current.length, 1, key);
      assert.equal(current[0]?.attrs['aria-current'], 'page');
      assert.equal(current[0]?.attrs.href, hrefs[i]);
      assert.equal(s.all.filter((n) => 'aria-current' in n.attrs).length, 1, 'auch außerhalb der Navigation nur einmal');
    }
  });

  it('Navigation: Mulde und Aktiv-Pill', () => {
    const s = shell();
    const nav = byAttr(s.all, 'aria-label', 'Hauptnavigation')[0] as Node;
    assert.equal(norm(s.cs(nav).get('flex')), '1 1 520px');
    const well = walk(nav).find((n) => n.tag !== 'a' && walk(n).some((k) => classes(k).includes('nv')) && norm(s.cs(n).get('background')) === 'rgba(0,0,0,.28)') as Node;
    assert.ok(well, 'Mulde rgba(0,0,0,.28)');
    const c = s.cs(well);
    assert.equal(norm(c.get('border-radius')), '999px');
    assert.equal(norm(c.get('padding')), '4px');
    assert.equal(norm(c.get('gap')), '4px');
    assert.equal(norm(c.get('overflow-x')), 'auto');
    assert.equal(norm(c.get('max-width')), '100%');
    const active = walk(nav).find((n) => n.attrs['aria-current'] === 'page') as Node;
    const pill = s.rules.find((r) => /aria-current/.test(r.selector) && /\.nv/.test(r.selector));
    assert.ok(pill, 'Regel für aktiven Punkt');
    assert.match(norm(pill.decls.get('background')), /^(#fff|#ffffff|rgba\(255,255,255,\.\d+\))$/);
    assert.ok(active);
  });

  it('Team-Ansicht: Übersicht hervorgehoben, aber ohne aria-current; Brotkrumen ohne aria-current', () => {
    const { root, css } = parse(AGENT_HTML);
    const all = walk(root);
    const nav = byAttr(all, 'aria-label', 'Hauptnavigation')[0] as Node;
    assert.equal(walk(nav).filter((n) => 'aria-current' in n.attrs).length, 0);
    const links = walk(nav).filter((n) => n.tag === 'a');
    const home = links.find((l) => l.attrs.href === '/') as Node;
    const others = links.filter((l) => l !== home);
    const rules = parseRules(css);
    const hl = (l: Node) => norm(computed(l, rules).get('background')) + '|' + classes(l).join(' ');
    // Übersicht carries an extra class the others do not have, and the white pill rule is bound to it.
    const extra = classes(home).filter((cl) => !others.every((o) => classes(o).includes(cl)) && !others.some((o) => classes(o).includes(cl)));
    assert.ok(extra.length >= 1, `Hervorhebungsklasse an Übersicht (${hl(home)})`);
    assert.ok(rules.some((r) => extra.some((cl) => r.selector.includes(`.${cl}`) && /rgba\(255, ?255, ?255|#fff/i.test(r.decls.get('background') ?? ''))), 'weißer Pill für die Klasse');
    assert.equal(all.filter((n) => 'aria-current' in n.attrs).length, 0, 'kein aria-current auf der Team-Seite');
  });

  it('Brotkrumen-Struktur', () => {
    const { root } = parse(breadcrumbs([{ label: 'Übersicht', href: '/' }, { label: 'Agent' }]));
    const nav = walk(root)[0] as Node;
    assert.equal(nav.tag, 'nav');
    assert.equal(nav.attrs['aria-label'], 'Brotkrumen');
    const links = walk(nav).filter((n) => n.tag === 'a');
    assert.equal(links.length, 1);
    assert.equal(links[0]?.attrs.href, '/');
    assert.equal(textOf(links[0] as Node).trim(), 'Übersicht');
    const last = walk(nav).find((n) => textOf(n).trim() === 'Agent' && n.children.length === 0) as Node;
    assert.ok(last);
    assert.ok(!ancestors(last).some((a) => a.tag === 'a' && nav.children.includes(a)), 'letztes Element ohne Link');
    assert.ok(!walk(nav).some((n) => 'aria-current' in n.attrs));
    const s = shell({ crumbs: [{ label: 'Übersicht', href: '/' }, { label: 'Agent' }] });
    const crumbNav = byAttr(s.all, 'aria-label', 'Brotkrumen')[0] as Node;
    assert.ok(crumbNav);
    assert.equal(norm(s.cs(crumbNav).get('font-size')), '13.5px');
    assert.equal(resolveVar(s.cs(crumbNav).get('color')), resolveVar('var(--fg-3)'));
    const lastEl = walk(crumbNav).find((n) => textOf(n).trim() === 'Agent' && n.children.length === 0) as Node;
    assert.equal(norm(s.cs(lastEl).get('color')), 'var(--fg-chip)');
    assert.ok(/›/.test(s.css), 'Trenner ›');
    assert.equal(shell().all.filter((n) => n.attrs['aria-label'] === 'Brotkrumen').length, 0, 'ohne crumbs keine Brotkrumen');
    assert.ok(AGENT_HTML.includes('aria-label="Brotkrumen"'));
  });

  it('Bei 390 px scrollt nur die Navigationsmulde horizontal', () => {
    const base = shell();
    const s = { ...base, rules: parseRules(base.css, 390), cs: (n: Node) => computed(n, parseRules(base.css, 390)) };
    const nav = byAttr(s.all, 'aria-label', 'Hauptnavigation')[0] as Node;
    const well = walk(nav).find((n) => norm(s.cs(n).get('overflow-x')) === 'auto') as Node;
    assert.ok(well, 'Mulde mit overflow-x: auto');
    assert.equal(norm(s.cs(well).get('max-width')), '100%');
    // Nothing else in the shell scrolls horizontally or forces a width wider than 390 px.
    const scrollers = s.all.filter((n) => ['auto', 'scroll'].includes(norm(s.cs(n).get('overflow-x'))) || ['auto', 'scroll'].includes(norm(s.cs(n).get('overflow'))));
    assert.deepEqual(scrollers.filter((n) => !['main', 'html', 'body'].includes(n.tag) && n !== well && !walk(well).includes(n)).map((n) => `${n.tag}.${classes(n).join('.')}`), []);
    for (const n of s.all.filter((k) => !classes(k).includes('aurora') && !ancestors(k).some((a) => a.attrs['aria-hidden'] === 'true'))) {
      for (const prop of ['width', 'min-width']) {
        const v = /^(\d+(?:\.\d+)?)px$/.exec(s.cs(n).get(prop) ?? '');
        if (v) assert.ok(Number(v[1]) <= 390, `${n.tag}.${classes(n).join('.')} ${prop} ${v[1]}`);
      }
    }
    const body = s.all.find((n) => n.tag === 'body') as Node;
    const rootEl = ancestors(s.all.find((n) => n.tag === 'header') as Node).find((a) => norm(s.cs(a).get('overflow')) === 'hidden');
    assert.ok(rootEl || norm(s.cs(body).get('overflow-x')) === 'hidden', 'Body hat keine horizontale Scrollbreite');
  });

  it('Kopfleiste rechts: 5-h-Chip, Versions-Chip, Uhr mit tabular-nums', () => {
    const s = shell();
    const header = s.all.find((n) => n.tag === 'header') as Node;
    const five = walk(header).find((n) => n.attrs.title === '5-h-Fenster') as Node;
    assert.ok(five);
    assert.equal(textOf(five).replace(/\s+/g, ' ').trim(), '5h —');
    const version = walk(header).find((n) => /^v\d+\.\d+\.\d+/.test(textOf(n).trim()) && n.children.length === 0) as Node;
    assert.ok(version, 'v<symphony_version>');
    const clock = walk(header).find((n) => /^[-\d]{2}:[-\d]{2}:[-\d]{2}$/.test(textOf(n).trim())) as Node;
    assert.ok(clock, 'Uhr');
    const cc = s.cs(clock);
    assert.match(`${cc.get('font') ?? ''} ${cc.get('font-size') ?? ''}`, /15px/);
    assert.match(`${cc.get('font') ?? ''} ${cc.get('font-family') ?? ''}`, /mono/);
    assert.equal(norm(cc.get('font-variant-numeric')), 'tabular-nums');
  });

  it('Jetzt pollen: nur auf Anforderung, mit aria-label, Icon; Übersicht fordert an', () => {
    assert.equal(shell().all.filter((n) => n.attrs['aria-label'] === 'Jetzt pollen').length, 0);
    const s = shell({ pollNow: true });
    const header = s.all.find((n) => n.tag === 'header') as Node;
    const btn = walk(header).filter((n) => n.attrs['aria-label'] === 'Jetzt pollen');
    assert.equal(btn.length, 1);
    assert.equal(btn[0]?.tag, 'button');
    assert.equal(btn[0]?.attrs.type, 'button');
    assert.ok(walk(btn[0] as Node).some((n) => n.tag === 'svg'), 'Refresh-Icon');
    const has = (html: string) => parse(html).root && walk(parse(html).root).some((n) => n.attrs['aria-label'] === 'Jetzt pollen');
    assert.equal(has(DASHBOARD_HTML), true);
    assert.equal(has(AGENT_HTML), false);
    assert.equal(has(LOGS_HTML), false);
  });

  it('nur .g blurt, nie ein .g in einem .g (Hülle, Panels, Seiten)', () => {
    const s = shell({ pollNow: true, crumbs: [{ label: 'A', href: '/' }, { label: 'B' }], body: twoColumns(panel({ title: 'A', children: '<p>a</p>' }), panel({ title: 'B', children: '<p>b</p>' })) });
    const check = (all: Node[], rules: Rule[], name: string): void => {
      for (const n of all) {
        if (classes(n).includes('g')) assert.ok(!ancestors(n).some((a) => classes(a).includes('g')), `${name}: .g in .g`);
      }
      const blurRules = rules.filter((r) => [...r.decls.keys()].some((k) => k.includes('backdrop-filter')));
      for (const r of blurRules) assert.ok(/(^|[^\w-])\.g\b|\.g(?![-\w])/.test(r.selector) || /:root|\.glass/.test(r.selector), `${name}: ${r.selector} blurt, ist aber nicht .g`);
    };
    check(s.all, s.rules, 'shell');
    for (const [name, html] of Object.entries({ dashboard: DASHBOARD_HTML, agent: AGENT_HTML, logs: LOGS_HTML })) {
      const { root, css } = parse(html);
      check(walk(root), parseRules(css), name);
    }
    // The aurora circles use filter: blur only, never backdrop-filter.
    const circles = s.all.filter((n) => /blur\(/.test(n.attrs.style ?? ''));
    assert.ok(circles.length >= 3);
    for (const c of circles) assert.ok(!/backdrop-filter/.test(c.attrs.style ?? ''));
  });
});

describe('E1-8 independent: Bausteine', () => {
  it('pageHeader: h1, Untertitel, rechter Slot, Styles', () => {
    const s = shell({ body: pageHeader({ title: 'Übersicht', subtitle: 'Untertitel', right: '<span id="chip">Chip</span>' }) });
    const h1 = s.all.filter((n) => n.tag === 'h1');
    assert.equal(h1.length, 1);
    assert.equal(textOf(h1[0] as Node), 'Übersicht');
    const c = s.cs(h1[0] as Node);
    assert.equal(norm(c.get('font-size')), '34px');
    assert.equal(norm(c.get('font-weight')), '600');
    assert.equal(norm(c.get('letter-spacing')), '-.02em');
    const sub = s.all.find((n) => textOf(n).trim() === 'Untertitel' && n.children.length === 0) as Node;
    assert.ok(sub);
    assert.equal(norm(s.cs(sub).get('font-size')), '15px');
    assert.equal(norm(s.cs(sub).get('color')), 'var(--fg-2)');
    const block = ancestors(h1[0] as Node).find((a) => norm(s.cs(a).get('align-items')) === 'flex-end') as Node;
    assert.ok(block);
    assert.equal(norm(s.cs(block).get('flex-wrap')), 'wrap');
    assert.equal(norm(s.cs(block).get('padding')), '6px 4px 0');
    assert.ok(walk(block).some((n) => n.attrs.id === 'chip'), 'rechter Slot im Titelblock');
    assert.equal(pageHeader({ title: 'x<y' }).includes('x&lt;y'), true, 'Titel escaped');
  });

  it('twoColumns: Flex-Raster mit 640er Hauptspalte und Seitenspalte sideWidth', () => {
    for (const w of [undefined, 360]) {
      const s = shell({ body: twoColumns('<i id="m"></i>', '<i id="s"></i>', w === undefined ? undefined : { sideWidth: w }) });
      const mainMarker = s.all.find((n) => n.attrs.id === 'm') as Node;
      const sideMarker = s.all.find((n) => n.attrs.id === 's') as Node;
      const mainCol = mainMarker.parent as Node;
      const sideCol = sideMarker.parent as Node;
      assert.equal(mainCol.parent, sideCol.parent);
      const grid = mainCol.parent as Node;
      const g = s.cs(grid);
      assert.equal(norm(g.get('display')), 'flex');
      assert.equal(norm(g.get('flex-wrap')), 'wrap');
      assert.equal(norm(g.get('gap')), '18px');
      assert.equal(norm(g.get('align-items')), 'flex-start');
      assert.equal(norm(s.cs(mainCol).get('flex')), '999 1 640px');
      assert.equal(norm(s.cs(sideCol).get('flex')), `1 1 ${w ?? 420}px`);
      for (const col of [mainCol, sideCol]) {
        const c = s.cs(col);
        assert.equal(norm(c.get('min-width')), '0');
        assert.equal(norm(c.get('display')), 'flex');
        assert.equal(norm(c.get('flex-direction')), 'column');
        assert.equal(norm(c.get('gap')), '18px');
      }
    }
  });

  it('panel: section.g, Padding 18, h2.lbl mit id und aria-labelledby, rechts Link/Zähler', () => {
    const s = shell({ body: panel({ title: 'Teams', right: '<a href="/tasks">Alle →</a>', children: '<p id="inner">x</p>' }) });
    const sec = s.all.find((n) => n.tag === 'section' && classes(n).includes('g')) as Node;
    assert.ok(sec);
    assert.equal(norm(s.cs(sec).get('padding')), '18px');
    const h2 = walk(sec).find((n) => n.tag === 'h2') as Node;
    assert.ok(classes(h2).includes('lbl'));
    assert.ok(h2.attrs.id);
    assert.equal(sec.attrs['aria-labelledby'], h2.attrs.id);
    assert.equal(textOf(h2), 'Teams');
    assert.ok(walk(sec).some((n) => n.tag === 'a' && n.attrs.href === '/tasks'));
    assert.ok(walk(sec).some((n) => n.attrs.id === 'inner'));
    // two panels get distinct ids
    const two = parse(panel({ title: 'A', children: '' }) + panel({ title: 'B', children: '' }));
    const ids = walk(two.root).filter((n) => n.tag === 'h2').map((n) => n.attrs.id);
    assert.equal(new Set(ids).size, 2);
    // ariaLabel is accepted and labels the section
    const labelled = parse(panel({ title: 'T', ariaLabel: 'Eigene Beschriftung', children: '' }));
    const sec2 = walk(labelled.root).find((n) => n.tag === 'section') as Node;
    assert.ok(sec2.attrs['aria-label'] === 'Eigene Beschriftung' || sec2.attrs['aria-labelledby']);
    // title is escaped
    assert.ok(panel({ title: '<b>', children: '' }).includes('&lt;b&gt;'));
  });

  it('Abschnittslink "Text →" 13 px', () => {
    const s = shell({ body: panel({ title: 'T', right: '<a class="x" href="/tasks">Alle Tasks →</a>', children: '' }) });
    // the shell offers a helper or style for section links; locate a rule with 13px used for panel links
    assert.ok(s.rules.some((r) => /link/.test(r.selector) && norm(r.decls.get('font-size')) === '13px'), 'Stil für Abschnittslinks 13 px');
  });
});

// ---------------------------------------------------------------- client script in a fake DOM
class El {
  className = '';
  _text = '';
  children: Array<El | string> = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<() => unknown>> = {};
  classList = {
    contains: (c: string) => this.className.split(/\s+/).includes(c),
    add: (c: string) => { this.className = `${this.className} ${c}`.trim(); },
    remove: (c: string) => { this.className = this.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
    toggle: (c: string) => (this.classList.contains(c) ? this.classList.remove(c) : this.classList.add(c)),
  };
  style: Record<string, string> = {};
  get textContent(): string { return this._text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
  set textContent(v: string) { this.children = []; this._text = String(v); }
  setAttribute(k: string, v: unknown): void { this.attrs[k] = String(v); }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  hasAttribute(k: string): boolean { return k in this.attrs; }
  addEventListener(t: string, fn: () => unknown): void { (this.listeners[t] ??= []).push(fn); }
  append(...n: Array<El | string>): void { this.children.push(...n); }
  appendChild(n: El): El { this.children.push(n); return n; }
  replaceChildren(...n: Array<El | string>): void { this._text = ''; this.children = n; }
  get spans(): El[] { return this.children.filter((c): c is El => typeof c !== 'string'); }
}

function boot(budget: unknown | Error, opts: { refresh?: { ok: boolean; body: unknown } | Error } = {}) {
  const ids = ['shell-live', 'shell-live-dot', 'shell-live-text', 'shell-budget', 'shell-clock', 'shell-poll', 'announce', 'shell-version'];
  const nodes = new Map<string, El>(ids.map((id) => [id, new El()]));
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const calls: Array<{ url: string; method: string }> = [];
  const win: Record<string, unknown> = {};
  const ctx = vm.createContext({
    document: {
      getElementById: (id: string) => nodes.get(id) ?? null,
      createElement: () => new El(),
      createElementNS: () => new El(),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      body: new El(),
      documentElement: new El(),
    },
    window: win,
    setInterval: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
    setTimeout: (fn: () => void) => { fn(); return 0; },
    clearInterval: () => {},
    clearTimeout: () => {},
    fetch: async (url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url === '/api/v1/budget') {
        if (budget instanceof Error) throw budget;
        return { ok: true, status: 200, json: async () => budget };
      }
      if (url === '/api/v1/refresh') {
        const r = opts.refresh ?? { ok: true, body: { queued: true } };
        if (r instanceof Error) throw r;
        return { ok: r.ok, status: r.ok ? 202 : 500, json: async () => r.body };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
    console,
    Date, Math, JSON, Number, String, Array, Object, Promise, Map, Set, Intl, Error, URL, isFinite, parseInt, parseFloat,
  });
  window_ctx(ctx, win);
  vm.runInContext(`${BASE_JS}\n${LAYOUT_JS}\n;globalThis.__api = { setLive: typeof setLive === 'function' ? setLive : null };`, ctx);
  return { ctx, nodes, timers, calls, el: (id: string) => nodes.get(id) as El };
}
function window_ctx(ctx: vm.Context, win: Record<string, unknown>): void { Object.assign(win, { document: ctx.document }); }
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const report = (used: number | null, limit = 100) => ({
  five_hour: { window: 'five_hour', used_tokens: used ?? 0, forecast: used === null ? null : { limit_tokens: limit, limit_source: 'sdk', eta: null }, alert: false, by_role: {} },
  seven_day: { window: 'seven_day', used_tokens: 0, forecast: null, alert: false, by_role: {} },
  generated_at: '2026-01-01T00:00:00.000Z',
});

describe('E1-8 independent: Client-Verhalten der Hülle', () => {
  it('LIVE nur bei erfolgreichem Poll, sonst OFFLINE grau', () => {
    const { ctx, el } = boot(new Error('x'));
    vm.runInContext('setLive(true)', ctx);
    assert.equal(el('shell-live-text').textContent, 'LIVE');
    assert.match(el('shell-live').className, /green/);
    assert.ok(el('shell-live-dot').className.split(/\s+/).includes('live'), 'pulsierender .live-Punkt');
    vm.runInContext('setLive(false)', ctx);
    assert.equal(el('shell-live-text').textContent, 'OFFLINE');
    assert.match(el('shell-live').className, /gray/);
    assert.ok(!el('shell-live-dot').className.split(/\s+/).includes('live'));
    vm.runInContext('setLive(true)', ctx);
    assert.equal(el('shell-live-text').textContent, 'LIVE', 'Umschalten zurück');
  });

  it('LIVE/OFFLINE im initialen HTML: OFFLINE bis zum ersten erfolgreichen Poll', () => {
    const s = shell();
    const live = s.all.find((n) => /OFFLINE|LIVE/.test(textOf(n)) && n.children.length === 0) as Node;
    assert.equal(textOf(live).trim(), 'OFFLINE');
  });

  it('5-h-Chip ohne Budget-Daten: "5h —"', async () => {
    for (const data of [new Error('offline'), { five_hour: { used_tokens: 0, forecast: null }, seven_day: {} }, {}, null]) {
      const { el } = boot(data as never);
      await flush();
      assert.equal(el('shell-budget').textContent.replace(/\s+/g, ' ').trim(), '5h —', JSON.stringify(data instanceof Error ? 'error' : data));
    }
  });

  it('5-h-Chip mit 62 % amber, mit 90 % rot, unter 50 % neutral, Grenzen 50/85', async () => {
    const tone = async (pct: number) => {
      const { el, calls } = boot(report(pct));
      await flush();
      assert.ok(calls.some((c) => c.url === '/api/v1/budget'), 'lädt /api/v1/budget');
      const chip = el('shell-budget');
      const span = chip.spans[0] as El | undefined;
      assert.ok(span, `Prozent-<span> bei ${pct}`);
      assert.equal(chip.textContent.replace(/\s+/g, ' ').trim(), `5h ${pct} %`);
      assert.equal(span.textContent.trim(), `${pct} %`);
      return span.className;
    };
    const cls62 = await tone(62);
    const cls90 = await tone(90);
    const cls10 = await tone(10);
    assert.match(cls62, /amber/);
    assert.match(cls90, /red/);
    assert.doesNotMatch(cls10, /amber|red/);
    assert.match(await tone(50), /amber/);
    assert.doesNotMatch(await tone(49), /amber|red/);
    assert.match(await tone(84), /amber/);
    assert.match(await tone(85), /red/);
    // the tone classes colour the percentage (amber / red) in the shell stylesheet
    const s = shell();
    const colorFor = (word: string) => s.rules.find((r) => r.selector.includes(word) && r.decls.has('color'))?.decls.get('color') ?? '';
    assert.match(colorFor('amber'), /amber/);
    assert.match(colorFor('red'), /red/);
    // chip title
    assert.equal(s.all.filter((n) => n.attrs.title === '5-h-Fenster').length, 1);
  });

  it('Uhr: HH:MM:SS, sekündlich aktualisiert', () => {
    const { el, timers } = boot(new Error('x'));
    assert.match(el('shell-clock').textContent, /^\d\d:\d\d:\d\d$/);
    assert.ok(timers.some((t) => t.ms === 1000), 'Sekundentakt');
    el('shell-clock').textContent = '';
    timers.find((t) => t.ms === 1000)?.fn();
    assert.match(el('shell-clock').textContent, /^\d\d:\d\d:\d\d$/);
  });

  it('Jetzt pollen: Klick sendet POST /api/v1/refresh', async () => {
    const { el, calls } = boot(new Error('x'));
    await flush();
    for (const fn of el('shell-poll').listeners.click ?? []) await fn();
    await flush();
    const refresh = calls.filter((c) => c.url === '/api/v1/refresh');
    assert.equal(refresh.length, 1);
    assert.equal(refresh[0]?.method, 'POST');
    // a failing request does not throw out of the handler
    const bad = boot(new Error('x'), { refresh: new Error('net') });
    await flush();
    for (const fn of bad.el('shell-poll').listeners.click ?? []) await fn();
    await flush();
  });
});

describe('E1-8 independent: Versions-Chip', () => {
  it('zeigt v<symphony_version> aus der gleichen Quelle wie /api/v1/state', async () => {
    const { SYMPHONY_VERSION } = await import('../src/version.ts');
    const s = shell();
    const chip = s.all.find((n) => textOf(n).trim() === `v${SYMPHONY_VERSION}` && n.children.length === 0);
    assert.ok(chip, `Chip v${SYMPHONY_VERSION}`);
    for (const html of [DASHBOARD_HTML, AGENT_HTML, LOGS_HTML]) assert.ok(html.includes(`v${SYMPHONY_VERSION}<`));
  });
});
