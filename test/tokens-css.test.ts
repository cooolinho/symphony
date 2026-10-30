import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { TOKENS_CSS } from '../src/http/ui/tokens.ts';

const PAGES = { dashboard: DASHBOARD_HTML, agent: AGENT_HTML, logs: LOGS_HTML };

interface Rule {
  media: string;
  selector: string;
  body: string;
}

/** Minimal CSS parser: flattens rules (one level of @media / @keyframes nesting) with their media prelude. */
function parseCss(css: string): { rules: Rule[]; keyframes: Map<string, string> } {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const keyframes = new Map<string, string>();
  const readBlock = (open: number): number => {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return i;
    }
    throw new Error('unbalanced braces');
  };
  const walk = (from: number, to: number, media: string): void => {
    let i = from;
    while (i < to) {
      const open = src.indexOf('{', i);
      if (open < 0 || open >= to) break;
      const prelude = src.slice(i, open).trim();
      const close = readBlock(open);
      const inner = src.slice(open + 1, close);
      if (prelude.startsWith('@keyframes')) keyframes.set(prelude.split(/\s+/)[1] as string, inner);
      else if (prelude.startsWith('@media')) walk(open + 1, close, prelude);
      else rules.push({ media, selector: prelude, body: inner });
      i = close + 1;
    }
  };
  walk(0, src.length, '');
  return { rules, keyframes };
}

const { rules, keyframes } = parseCss(TOKENS_CSS);
const declsOf = (selector: string, media = ''): string =>
  rules.filter((r) => r.media === media && r.selector.split(',').map((s) => s.trim()).includes(selector)).map((r) => r.body).join(';');

function rootVar(name: string): string {
  const match = declsOf(':root').match(new RegExp(`--${name}:\\s*([^;]+);`));
  assert.ok(match, `--${name} defined in :root`);
  return (match[1] as string).trim();
}

function rgb(hex: string): [number, number, number] {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  assert.ok(m, `${hex} is a 6-digit hex color`);
  const n = parseInt(m[1] as string, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
function over(fg: [number, number, number], alpha: number, bg: [number, number, number]): [number, number, number] {
  return [0, 1, 2].map((i) => Math.round(fg[i]! * alpha + bg[i]! * (1 - alpha))) as [number, number, number];
}

describe('TOKENS_CSS module', () => {
  it('replaces BASE_CSS: styles.ts keeps only BASE_JS and the pages embed the tokens', () => {
    const styles = fs.readFileSync('src/http/styles.ts', 'utf8');
    assert.doesNotMatch(styles, /BASE_CSS/);
    assert.ok(BASE_JS.length > 0);
    for (const file of ['dashboard', 'agent-page', 'logs-page', 'pipeline']) {
      assert.doesNotMatch(fs.readFileSync(`src/http/${file}.ts`, 'utf8'), /BASE_CSS/, file);
    }
    for (const [name, html] of Object.entries(PAGES)) {
      assert.ok(html.includes(TOKENS_CSS), `${name} embeds TOKENS_CSS`);
      assert.ok(html.includes('--role-analyst: #38bdf8'), `${name} ships the role tokens`);
    }
  });

  it('defines every CSS variable the pages use (no dangling var() without fallback)', () => {
    for (const [name, html] of Object.entries(PAGES)) {
      const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1] as string).join('\n');
      const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1] as string));
      // Variables set from inline style attributes / scripts count as defined too.
      for (const m of html.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1] as string);
      const missing = new Set<string>();
      for (const m of css.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
        if (m[2] === ',') continue; // has a fallback
        if (!defined.has(m[1] as string)) missing.add(m[1] as string);
      }
      assert.deepEqual([...missing], [], `${name}: undefined CSS variables`);
    }
  });

  it('keeps the legacy variables and classes the page CSS depends on', () => {
    const rootDecls = declsOf(':root');
    for (const v of ['bg', 'panel', 'panel-2', 'raise', 'line', 'line-2', 'text', 'text-2', 'muted', 'faint', 'green', 'green-dim',
      'green-line', 'cyan', 'amber', 'red', 'gray', 'accent', 'ok', 'warn', 'bad', 'chip', 'sans', 'mono']) {
      assert.match(rootDecls, new RegExp(`--${v}:`), `--${v}`);
    }
    for (const cls of ['.tone-green', '.tone-cyan', '.tone-amber', '.tone-red', '.tone-gray', '.badge', '.btn', '.stat', '.topbar', '.dot', '.pulse', '.chip']) {
      assert.ok(TOKENS_CSS.includes(cls), cls);
    }
  });

  it('stacks body children above the fixed background layers (dashboard .rain, z-index 0)', () => {
    const decls = declsOf('body > *');
    assert.match(decls, /position:\s*relative/);
    const z = decls.match(/z-index:\s*(\d+)/);
    assert.ok(z && Number(z[1]) >= 1, 'body > * has z-index >= 1');
    const rain = DASHBOARD_HTML.match(/\.rain\s*\{[^}]*z-index:\s*(\d+)/);
    assert.ok(rain, 'dashboard defines .rain with z-index');
    assert.ok(Number(z[1]) > Number(rain[1]), 'panels sit above .rain');
  });

  it('uses the navy ground #070b16', () => {
    assert.equal(rootVar('bg').toLowerCase(), '#070b16');
    assert.match(declsOf('html'), /background:\s*var\(--bg\)/);
  });

  it('defines .g and .gi as blurred glass panels, with the -webkit- prefix', () => {
    for (const sel of ['.g', '.gi']) {
      const d = declsOf(sel);
      assert.match(d, /(^|[;\s])backdrop-filter:\s*blur\(/, `${sel} backdrop-filter`);
      assert.match(d, /-webkit-backdrop-filter:\s*blur\(/, `${sel} -webkit-backdrop-filter`);
      assert.match(d, /background:/, `${sel} background`);
      assert.match(d, /border:/, `${sel} border`);
    }
  });

  it('defines the role colors as CSS variables', () => {
    const roles: Record<string, string> = { analyst: '#38bdf8', architect: '#a78bfa', developer: '#34d399', tester: '#fbbf24',
      docs: '#cbd5e1', reviewer: '#f472b6', security: '#fb923c', symphony: '#94a3b8' };
    for (const [role, hex] of Object.entries(roles)) {
      assert.equal(rootVar(`role-${role}`).toLowerCase(), hex, role);
      assert.match(declsOf(`.role-${role}`), new RegExp(`--role:\\s*var\\(--role-${role}\\)`), `.role-${role}`);
    }
  });

  it('defines status tones: green running, amber warning, red error, gray waiting', () => {
    assert.match(rootVar('st-run'), /--green/);
    assert.match(rootVar('st-warn'), /--amber/);
    assert.match(rootVar('st-error'), /--red/);
    assert.match(rootVar('st-wait'), /--gray/);
    // The referenced base colors must exist and be distinct hues.
    const green = rootVar('green'), amber = rootVar('amber'), red = rootVar('red'), gray = rootVar('gray');
    assert.equal(new Set([green, amber, red, gray]).size, 4);
    for (const t of ['green', 'amber', 'red', 'gray']) {
      const d = declsOf(`.tone-${t}`);
      assert.match(d, new RegExp(`--tone:\\s*var\\(--${t}\\)`), `.tone-${t} --tone`);
      assert.match(d, new RegExp(`--tone-dim:\\s*var\\(--${t}-dim\\)`), `.tone-${t} --tone-dim`);
      assert.match(d, new RegExp(`--tone-line:\\s*var\\(--${t}-line\\)`), `.tone-${t} --tone-line`);
      rootVar(`${t}-dim`);
      rootVar(`${t}-line`);
    }
  });

  it('uses system font stacks and loads no external resources', () => {
    const sans = rootVar('sans'), mono = rootVar('mono');
    assert.match(sans, /system-ui/);
    assert.match(sans, /sans-serif\s*$/);
    assert.match(mono, /monospace\s*$/);
    assert.match(mono, /ui-monospace|Menlo|Consolas/);
    assert.match(declsOf('body'), /font:[^;]*var\(--sans\)/);
    assert.match(declsOf('.num'), /font-family:\s*var\(--mono\)/);
    assert.match(declsOf('.num'), /tabular-nums/);
    assert.doesNotMatch(TOKENS_CSS, /https?:\/\/|@import|@font-face|url\(|\/\//);
  });

  it('shows a visible focus ring on all focusable elements', () => {
    const focusRules = rules.filter((r) => r.media === '' && /:focus-visible/.test(r.selector));
    assert.ok(focusRules.length > 0);
    const selectors = focusRules.flatMap((r) => r.selector.split(',').map((s) => s.trim()));
    for (const sel of ['a:focus-visible', 'button:focus-visible', 'select:focus-visible', 'input:focus-visible', '[tabindex]:focus-visible']) {
      assert.ok(selectors.includes(sel), sel);
    }
    const ring = focusRules.map((r) => r.body).join(';');
    assert.match(ring, /outline:\s*([2-9]|\d{2,})px solid\s+var\(--focus\)/);
    // Contrast of the ring color against the navy ground (WCAG 1.4.11: >= 3:1).
    assert.ok(contrast(rgb(rootVar('focus')), rgb(rootVar('bg'))) >= 3);
    // Nothing may suppress the outline of a focus-visible element.
    for (const r of rules) {
      if (/outline:\s*(none|0)\b/.test(r.body)) assert.match(r.selector, /:focus:not\(:focus-visible\)/, `outline removed by "${r.selector}"`);
    }
  });

  it('stops all animations and transitions under prefers-reduced-motion', () => {
    const media = rules.filter((r) => r.media === '@media (prefers-reduced-motion: reduce)');
    assert.ok(media.length > 0, 'media query defined');
    const universal = media.find((r) => r.selector.split(',').map((s) => s.trim()).includes('*'));
    assert.ok(universal, 'applies to *');
    assert.match(universal.selector, /::before/);
    assert.match(universal.selector, /::after/);
    assert.match(universal.body, /animation:\s*none\s*!important/);
    assert.match(universal.body, /transition:\s*none\s*!important/);
    // The old "almost stop" trick must be gone.
    assert.doesNotMatch(universal.body, /\.001ms|0\.01ms|1ms/);
  });

  it('makes panels opaque #111a2c without blur under prefers-reduced-transparency', () => {
    const media = rules.filter((r) => r.media === '@media (prefers-reduced-transparency: reduce)');
    assert.ok(media.length > 0, 'media query defined');
    const sels = media.flatMap((r) => r.selector.split(',').map((s) => s.trim()));
    for (const sel of ['.g', '.gi']) assert.ok(sels.includes(sel), sel);
    const body = media.map((r) => r.body).join(';');
    assert.match(body, /backdrop-filter:\s*none/);
    assert.match(body, /-webkit-backdrop-filter:\s*none/);
    assert.match(body, /background:\s*(var\(--solid\)|#111a2c)/);
    assert.equal(rootVar('solid').toLowerCase(), '#111a2c');
    // Every element carrying a blur must be covered (not only .g/.gi, also the sticky topbar).
    const blurred = rules.filter((r) => r.media === '' && /backdrop-filter/.test(r.body)).flatMap((r) => r.selector.split(',').map((s) => s.trim()));
    for (const sel of blurred) assert.ok(sels.includes(sel), `${sel} loses its blur under reduced transparency`);
  });

  it('keeps body text at >= 4.5:1 on the glass surfaces', () => {
    const bg = rgb(rootVar('bg'));
    const solid = rgb(rootVar('solid'));
    const glass = rootVar('glass').match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
    assert.ok(glass);
    const glassOverBg = over([+glass[1]!, +glass[2]!, +glass[3]!], +glass[4]!, bg);
    // Worst case: brightest aurora tint (alpha .10) under the glass.
    const tinted = over([167, 139, 250], 0.1, bg);
    const glassOverTint = over([+glass[1]!, +glass[2]!, +glass[3]!], +glass[4]!, tinted);
    const surfaces: Record<string, [number, number, number]> = {
      bg, solid, glassOverBg, glassOverTint, panel: rgb(rootVar('panel')), 'panel-2': rgb(rootVar('panel-2')), raise: rgb(rootVar('raise')),
    };
    for (const text of ['text', 'text-2', 'muted']) {
      for (const [surface, color] of Object.entries(surfaces)) {
        const ratio = contrast(rgb(rootVar(text)), color);
        assert.ok(ratio >= 4.5, `--${text} on ${surface} is ${ratio.toFixed(2)}:1`);
      }
    }
    // --faint is used as text color by the pages: at least on the main panel surfaces.
    for (const surface of ['bg', 'solid', 'glassOverBg', 'panel'] as const) {
      const ratio = contrast(rgb(rootVar('faint')), surfaces[surface]!);
      assert.ok(ratio >= 4.5, `--faint on ${surface} is ${ratio.toFixed(2)}:1`);
    }
    // Link color must be readable too.
    assert.ok(contrast(rgb(rootVar('cyan')), solid) >= 4.5);
  });

  it('gives buttons and navigation links a touch target of at least 44px', () => {
    const controls = rules.filter((r) => r.media === '' && /(^|,)\s*(button|\.btn|select)\s*(,|$)/.test(r.selector) && /min-height/.test(r.body));
    assert.ok(controls.length > 0);
    const sel = controls.flatMap((r) => r.selector.split(',').map((s) => s.trim()));
    for (const s of ['button', '.btn', 'select']) assert.ok(sel.includes(s), s);
    assert.match(controls.map((r) => r.body).join(';'), /min-height:\s*44px/);
    const nav = declsOf('.topbar .actions a');
    assert.match(nav, /min-height:\s*44px/);
    assert.match(nav, /display:\s*inline-flex/);
  });

  it('animates only transform and opacity', () => {
    assert.ok(keyframes.size > 0);
    for (const [name, body] of keyframes) {
      const props = [...body.matchAll(/([\w-]+)\s*:[^;}]+/g)].map((m) => m[1] as string);
      assert.ok(props.length > 0, name);
      for (const p of props) assert.ok(['transform', 'opacity'].includes(p), `@keyframes ${name} animates ${p}`);
    }
    // sweep used to animate "left".
    assert.ok(keyframes.has('sweep'));
    assert.doesNotMatch(keyframes.get('sweep') as string, /left/);
    for (const r of rules) {
      for (const m of r.body.matchAll(/(?:^|[;\s])transition(?:-property)?:\s*([^;]+)/g)) {
        const props = (m[1] as string).replace(/!important/, '').split(',').map((part) => part.trim().split(/\s+/)[0] as string);
        for (const p of props) assert.ok(['none', 'transform', 'opacity'].includes(p), `"${r.selector}" transitions ${p}`);
      }
    }
  });

  it('keeps the CSS well-formed (balanced braces, every rule terminated)', () => {
    const stripped = TOKENS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal((stripped.match(/{/g) ?? []).length, (stripped.match(/}/g) ?? []).length);
    assert.doesNotMatch(TOKENS_CSS, /var\(--[\w-]*\s[\w-]*\)/);
  });
});
