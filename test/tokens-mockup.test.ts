// Independent acceptance tests for #379 (E1-7): the literal values of the issue against the generated CSS.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import { AGENT_HTML } from '../src/http/issue-page.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { TOKENS_CSS, rgba } from '../src/http/ui/tokens.ts';

const CSS = TOKENS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const squash = (s: string): string => s.replace(/\s+/g, ' ').replace(/\s*([:;,{}()])\s*/g, '$1').replace(/(^|[^\d])0\./g, '$1.').toLowerCase();
const FLAT = squash(CSS);
/** Top-level CSS (no @media blocks, no @keyframes): only the unconditional rules. */
const TOP = squash(CSS.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "").replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, ""));

/** Body of the first rule whose selector list (outside @media) contains `selector`, flattened. */
function ruleBody(selector: string, within = TOP): string {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const bodies: string[] = [];
  for (const m of within.matchAll(re)) {
    const sels = (m[1] as string).split(',').map((s) => s.replace(/^.*;/, '').replace(/^@media[^{]*/, '').trim());
    if (sels.includes(squash(selector))) bodies.push(m[2] as string);
  }
  assert.ok(bodies.length > 0, `rule for ${selector} exists`);
  return bodies.join(';');
}
const has = (hay: string, needle: string): void => assert.ok(hay.includes(squash(needle)), `expected "${needle}" in "${hay}"`);

function mediaBlock(prelude: string): string {
  const start = CSS.indexOf(prelude);
  assert.ok(start >= 0, `${prelude} exists`);
  const open = CSS.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < CSS.length; i++) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}' && --depth === 0) return squash(CSS.slice(open + 1, i));
  }
  throw new Error('unbalanced');
}

function keyframeBody(name: string): string {
  const m = new RegExp(`@keyframes\\s+${name}\\s*\\{`).exec(CSS);
  assert.ok(m, `@keyframes ${name} exists`);
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < CSS.length; i++) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}' && --depth === 0) return squash(CSS.slice(m.index + m[0].length, i));
  }
  throw new Error('unbalanced');
}

const rootVar = (name: string): string => {
  const m = ruleBody(':root').match(new RegExp(`(?:^|;)--${name}:([^;]+)`));
  assert.ok(m, `--${name} defined in :root`);
  return m[1] as string;
};

describe('#379 glass surfaces', () => {
  it('.g carries the exact mockup values incl. -webkit- prefix', () => {
    const b = ruleBody('.g');
    has(b, 'background: rgba(255,255,255,.055)');
    has(b, 'border: 1px solid rgba(255,255,255,.1)');
    has(b, 'border-radius: 20px');
    has(b, '-webkit-backdrop-filter: blur(24px) saturate(150%)');
    has(b, ';backdrop-filter: blur(24px) saturate(150%)');
    has(b, 'box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 24px 48px -24px rgba(0,0,0,.7)');
  });

  it('.gi: lighter fill, border .07, 14px, no blur', () => {
    const b = ruleBody('.gi');
    has(b, 'background: rgba(255,255,255,.035)');
    has(b, 'border: 1px solid rgba(255,255,255,.07)');
    has(b, 'border-radius: 14px');
    assert.ok(!/backdrop-filter/.test(b), '.gi has no backdrop-filter');
  });

  it('.row:hover and .well', () => {
    has(ruleBody('.row:hover'), 'background: rgba(255,255,255,.035)');
    const w = ruleBody('.well');
    has(w, 'background: rgba(0,0,0,.28)');
    has(w, 'border: 1px solid rgba(255,255,255,.08)');
    assert.ok(!/backdrop-filter/.test(w), '.well has no blur');
  });

  it('page ground is #070b16', () => {
    assert.equal(rootVar('bg').trim(), '#070b16');
    has(ruleBody('html'), 'background: var(--bg)');
  });

  it('reduced transparency: .g becomes #111a2c without blur (also other blurred selectors)', () => {
    const block = mediaBlock('@media (prefers-reduced-transparency: reduce)');
    const m = /\.g[^{]*\{([^}]*)\}/.exec(block);
    assert.ok(m, '.g in the reduced-transparency block');
    const body = m[1] as string;
    assert.ok(/#111a2c|var\(--solid\)/.test(body), body);
    if (body.includes('var(--solid)')) assert.equal(rootVar('solid').trim(), '#111a2c');
    assert.ok(/backdrop-filter:none/.test(body), 'blur switched off');
    assert.ok(/-webkit-backdrop-filter:none/.test(body), 'webkit blur switched off');
    // every selector that blurs outside the media query is covered inside it
    const outside = squash(CSS.replace(/@media[^{]*\{([^{}]*\{[^{}]*\})*[^{}]*\}/g, ''));
    for (const m2 of outside.matchAll(/([^{};]+)\{([^{}]*backdrop-filter:blur[^{}]*)\}/g)) {
      for (const sel of (m2[1] as string).split(',').map((s) => s.trim())) {
        assert.ok(block.includes(sel), `blurred selector ${sel} covered by reduced-transparency`);
      }
    }
  });

  it('reduced motion: animation none !important on * and *::after', () => {
    const block = mediaBlock('@media (prefers-reduced-motion: reduce)');
    const m = /([^{}]+)\{([^}]*)\}/.exec(block);
    assert.ok(m);
    const sels = (m[1] as string).split(',').map((s) => s.trim());
    assert.ok(sels.includes('*'), 'selector *');
    assert.ok(sels.includes('*::after'), 'selector *::after');
    assert.ok(/animation:none!important/.test((m[2] as string).replace(/\s+/g, '')), m[2] as string);
  });
});

describe('#379 colours', () => {
  it('text variables, links, focus ring', () => {
    const want: Record<string, string> = {
      fg: '#e8eef9', 'fg-strong': '#f4f7fc', 'fg-2': '#aab6cc', 'fg-3': '#8b98b0', 'fg-chip': '#c9d4e6',
      'fg-label': '#9aa8c0', 'fg-mute': '#5b6678', 'fg-faint': '#7c879b',
    };
    for (const [k, v] of Object.entries(want)) assert.equal(rootVar(k).trim(), v, `--${k}`);
    const linkColor = ruleBody('a').match(/color:([^;]+)/)?.[1] as string;
    assert.ok(linkColor === '#7dd3fc' || linkColor === 'var(--link)', linkColor);
    if (linkColor.startsWith('var')) assert.equal(rootVar('link').trim(), '#7dd3fc');
    const hover = ruleBody('a:hover');
    assert.ok(/#bae6fd|var\(--link-hover\)/.test(hover));
    if (hover.includes('--link-hover')) assert.equal(rootVar('link-hover').trim(), '#bae6fd');
    const focus = ruleBody(':focus-visible');
    assert.ok(/outline:2px solid (#7dd3fc|var\(--focus\))/.test(focus), focus);
    if (focus.includes('--focus')) assert.equal(rootVar('focus').trim(), '#7dd3fc');
    has(focus, 'outline-offset: 2px');
  });

  it('role colours (+ human) as variables', () => {
    const roles: Record<string, string> = {
      analyst: '#38bdf8', architect: '#a78bfa', developer: '#34d399', tester: '#fbbf24', docs: '#cbd5e1',
      reviewer: '#f472b6', security: '#fb923c', symphony: '#94a3b8', human: '#e8eef9',
    };
    for (const [k, v] of Object.entries(roles)) assert.equal(rootVar(`role-${k}`).trim(), v, k);
  });

  it('rgba(hex, alpha) helper: avatar and score steps', () => {
    assert.equal(rgba('#38bdf8', .16).replace(/\s/g, '').replace('0.', '.'), 'rgba(56,189,248,.16)');
    for (const a of [.16, .32, .55, .6, .24, .42]) {
      assert.equal(rgba('#a78bfa', a).replace(/\s/g, '').replace('0.', '.'), `rgba(167,139,250,${String(a).replace(/^0/, '')})`);
    }
    assert.equal(rgba('#000000', 1).replace(/\s/g, ''), 'rgba(0,0,0,1)');
    assert.equal(rgba('#ffffff', 0).replace(/\s/g, ''), 'rgba(255,255,255,0)');
    assert.equal(rgba('#E8EEF9', .5).replace(/\s/g, '').replace('0.', '.'), 'rgba(232,238,249,.5)');
    assert.throws(() => rgba('nope', .5));
    assert.throws(() => rgba('#12345', .5));
  });

  it('status scales carry the exact hex values', () => {
    const present = (hex: string): void => assert.ok(FLAT.includes(hex), `${hex} in tokens`);
    for (const h of ['#34d399', '#6ee7b7', '#d1fae5', '#fbbf24', '#fcd34d', '#fde68a', '#f87171', '#fca5a5', '#fecaca',
      '#c4b5fd', '#ddd6fe', '#7dd3fc', '#e0f2fe', '#64748b', '#94a3b8']) present(h);
    // each scale value is bound to a named variable (green/amber/red/violet/sky/gray)
    const root = ruleBody(':root');
    for (const [name, hexes] of Object.entries({
      green: ['#34d399', '#6ee7b7', '#d1fae5'], amber: ['#fbbf24', '#fcd34d', '#fde68a'], red: ['#f87171', '#fca5a5', '#fecaca'],
      violet: ['#c4b5fd', '#ddd6fe'], sky: ['#7dd3fc', '#e0f2fe'], gray: ['#64748b', '#94a3b8'],
    })) {
      for (const h of hexes) assert.ok(new RegExp(`--${name}-\\d+:${h};`).test(root), `--${name}-N: ${h}`);
    }
  });

  it('operation and trace colours', () => {
    const ops = { read: '#7dd3fc', write: '#fbbf24', search: '#c4b5fd', denied: '#f87171' };
    for (const [k, v] of Object.entries(ops)) assert.equal(rootVar(`op-${k}`).trim(), v, k);
    const trace = { tool: '#7dd3fc', brain: '#fbbf24', subagent: '#6ee7b7', model: '#c4b5fd', result: '#f87171' };
    for (const [k, v] of Object.entries(trace)) assert.equal(rootVar(`trace-${k}`).trim(), v, k);
  });

  it('task tones: text and background', () => {
    const tones: Record<string, [string, string]> = {
      run: ['#d1fae5', 'rgba(52,211,153,.14)'], next: ['#e0f2fe', 'rgba(125,211,252,.14)'],
      wait: ['#fde68a', 'rgba(251,191,36,.12)'], pause: ['#fde68a', 'rgba(251,191,36,.12)'],
      block: ['#fecaca', 'rgba(248,113,113,.13)'], done: ['#ddd6fe', 'rgba(196,181,253,.12)'],
    };
    for (const [k, [fg, bg]] of Object.entries(tones)) {
      assert.equal(rootVar(`task-${k}`).trim(), fg, `task-${k}`);
      assert.equal(rootVar(`task-${k}-bg`).trim(), bg, `task-${k}-bg`);
    }
  });
});

describe('#379 typography', () => {
  it('system font stacks, no web-font request', () => {
    assert.equal(rootVar('sans').trim(), 'inter,system-ui,-apple-system,"segoe ui",sans-serif'.replace('"segoe ui"', '"segoe ui"'));
    assert.equal(rootVar('mono').trim(), '"jetbrains mono",ui-monospace,menlo,monospace');
    assert.ok(!/@font-face|@import|url\(/i.test(CSS));
  });

  it('body 14px/1.5, h1 34px/600/-.02em, subtitle 15px --fg-2', () => {
    has(ruleBody('body'), 'font: 14px/1.5 var(--sans)');
    const h1 = ruleBody('h1');
    assert.ok(/font-size:(34px|var\(--fs-h1\))/.test(h1), h1);
    if (h1.includes('--fs-h1')) assert.equal(rootVar('fs-h1').trim(), '34px');
    has(h1, 'letter-spacing: -.02em');
    assert.ok(/font-weight:600/.test(h1));
    const sub = ruleBody('.subtitle');
    has(sub, 'font-size: 15px');
    has(sub, 'color: var(--fg-2)');
  });

  it('team view h1 is 30px', () => {
    assert.ok(/--fs-h1-team:30px/.test(ruleBody(':root')) || /team[^{]*\{[^}]*font-size:30px/.test(FLAT));
  });

  it('.lbl: mono 11px/500, .12em, uppercase, --fg-label', () => {
    const b = ruleBody('.lbl');
    assert.ok(/font:500 11px(\/[\d.]+)? var\(--mono\)/.test(b), b);
    has(b, 'letter-spacing: .12em');
    has(b, 'text-transform: uppercase');
    has(b, 'color: var(--fg-label)');
  });

  it('.mono uses tabular-nums and the mono stack', () => {
    const b = ruleBody('.mono');
    has(b, 'font-variant-numeric: tabular-nums');
    has(b, 'font-family: var(--mono)');
  });

  it('KPI sizes 22/24/26/28 and meta 12 / 12.5 are available', () => {
    const root = ruleBody(':root');
    for (const n of [22, 24, 26, 28]) assert.ok(new RegExp(`:${n}px`).test(root), `${n}px KPI size`);
    assert.ok(/:12px/.test(root) && /:12\.5px|:12\.5px/.test(root.replace('0.', '.')));
  });
});

describe('#379 animations', () => {
  it('pulse: 1.8s ease-out infinite, scale 1 -> 2, opacity .65 -> 0', () => {
    const k = keyframeBody('pulse');
    assert.ok(/(0%|from)\{[^}]*scale\(1\)[^}]*opacity:\.65/.test(k) || /(0%|from)\{[^}]*opacity:\.65[^}]*scale\(1\)/.test(k), k);
    assert.ok(/(100%|to)\{[^}]*scale\(2\)[^}]*opacity:0/.test(k) || /(100%|to)\{[^}]*opacity:0[^}]*scale\(2\)/.test(k), k);
    assert.ok(/animation:pulse 1\.8s ease-out infinite/.test(FLAT), 'a rule uses pulse 1.8s ease-out infinite');
  });

  it('pulse-lg reaches scale 1.7', () => {
    const k = keyframeBody('pulse-lg');
    assert.ok(/scale\(1\.7\)/.test(k), k);
    assert.ok(/scale\(1\)/.test(k) && /opacity:\.65/.test(k) && /opacity:0/.test(k), k);
  });

  it('eq: scaleY .3 -> 1, 1s ease-in-out infinite, origin bottom, delays -.3/-.6/-.15/-.45', () => {
    const k = keyframeBody('eq');
    assert.ok(/scaley\(\.3\)/.test(k) && /scaley\(1\)/.test(k), k);
    const i = ruleBody('.eq i');
    has(i, 'transform-origin: bottom');
    assert.ok(/animation:eq 1s ease-in-out infinite/.test(i), i);
    const delays: Record<number, string> = { 2: '-.3s', 3: '-.6s', 4: '-.15s', 5: '-.45s' };
    for (const [n, d] of Object.entries(delays)) {
      assert.ok(new RegExp(`\\.eq i:nth-child\\(${n}\\)\\{[^}]*animation-delay:${d.replace('.', '\\.')}`).test(FLAT), `bar ${n} delay ${d}`);
    }
  });

  it('breathe: 4s, opacity .75 -> 1', () => {
    const k = keyframeBody('breathe');
    assert.ok(/opacity:\.75/.test(k) && /opacity:1/.test(k), k);
    assert.ok(/animation:breathe 4s/.test(FLAT));
  });

  it('every keyframe animates only transform and opacity', () => {
    const names = [...CSS.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1] as string);
    assert.ok(names.length >= 4);
    for (const n of ['pulse', 'pulse-lg', 'eq', 'breathe']) assert.ok(names.includes(n), n);
    for (const n of names) {
      const props = [...keyframeBody(n).matchAll(/([a-z-]+):/g)].map((m) => m[1]);
      for (const p of props) assert.ok(p === 'transform' || p === 'opacity', `@keyframes ${n} animates ${p}`);
    }
  });

  it('.live::after dot, .ring inset -5px 2px currentColor, .eq 3x14, .eq-lg 4x18', () => {
    const live = ruleBody('.live::after');
    assert.ok(/animation:pulse/.test(live), live);
    const ring = ruleBody('.ring');
    has(ring, 'inset: -5px');
    has(ring, 'border: 2px solid currentcolor');
    has(ruleBody('.eq i'), 'width: 3px');
    has(ruleBody('.eq i'), 'height: 14px');
    has(ruleBody('.eq-lg i'), 'width: 4px');
    has(ruleBody('.eq-lg i'), 'height: 18px');
    has(ruleBody('.eq'), 'height: 14px');
    has(ruleBody('.eq-lg'), 'height: 18px');
  });
});

describe('#379 hygiene and contrast', () => {
  it('tokens.ts contains no http(s):// outside comments, no innerHTML, no @import/url()', () => {
    const src = fs.readFileSync(new URL('../src/http/ui/tokens.ts', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
    assert.ok(!/https?:\/\//.test(code));
    assert.ok(!/innerHTML/.test(src));
    assert.ok(!/@import|url\(|@font-face/.test(code));
    assert.ok(!/https?:\/\//.test(CSS));
  });

  const lin = (v: number): number => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const lum = (hex: string): number => {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  };
  const ratio = (a: string, b: string): number => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number]; return (x + .05) / (y + .05); };

  it('WCAG function sanity: black/white 21:1', () => {
    assert.ok(Math.abs(ratio('#000000', '#ffffff') - 21) < 1e-9);
    assert.ok(Math.abs(ratio('#777777', '#777777') - 1) < 1e-9);
  });

  it('--fg and --fg-2 reach 4.5:1 on the effective panel ground #1a1f2c (values from the CSS)', () => {
    for (const v of ['fg', 'fg-2']) assert.ok(ratio(rootVar(v).trim(), '#1a1f2c') >= 4.5, `--${v}`);
    assert.ok(ratio('#aab6cc', '#1a1f2c') >= 4.5);
    // also on the opaque reduced-transparency ground
    assert.ok(ratio(rootVar('fg-2').trim(), '#111a2c') >= 4.5);
  });

  it('--fg-3 is only used for text >= 12px in tokens and pages', () => {
    for (const [name, css] of [['tokens', CSS], ['dashboard', DASHBOARD_HTML], ['agent', AGENT_HTML], ['logs', LOGS_HTML]] as const) {
      const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*var\(--fg-3\)[^{}]*)\}/g)) {
        const body = m[2] as string;
        if (/--fg-3\s*:/.test(body)) continue;
        const size = /(?:font-size:\s*|font:\s*(?:[\w.]+\s+)*?)(\d+(?:\.\d+)?)px/.exec(body);
        const resolved = size ? Number(size[1]) : /font-size:\s*var\(--fs-meta(-lg)?\)/.test(body) ? 12 : null;
        assert.ok(resolved === null || resolved >= 12, `${name}: ${(m[1] as string).trim()} uses --fg-3 at ${resolved}px`);
      }
    }
  });
});
