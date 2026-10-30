/**
 * Page shell shared by every dashboard page: the aurora background (blurred colour circles plus a dot grid), the
 * floating glass header (logo, LIVE badge, main navigation with icons, 5 h chip, version, clock, optional "Jetzt pollen"
 * button, poll progress strip) and optional breadcrumbs. page() builds the complete HTML document around a page's own
 * markup, CSS and script. pageHeader(), breadcrumbs(), twoColumns(), panel() and sectionLink() are pure markup builders.
 *
 * The aurora circles are plain filter-blurred elements (no backdrop-filter); the header is the only glass element the
 * shell adds (.g) and the shell never nests a .g in a .g, so a page stays within four stacked blur layers. LIVE, the
 * 5 h chip and the clock are set on the client (setLive(), loadBudget(), a one-second timer).
 */

import { BASE_JS } from '../styles.ts';
import { SYMPHONY_VERSION } from '../../version.ts';
import { TOKENS_CSS } from './tokens.ts';

export type NavKey = 'overview' | 'changes' | 'tasks' | 'brain' | 'stats';

// The icons move to the shared icon module of #380 once it is merged.
const svg = (size: number, sw: number, inner: string): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const LOGO_ICON = svg(20, 2.2, '<path d="M4 10v4"/><path d="M8 7v10"/><path d="M12 4v16"/><path d="M16 8v8"/><path d="M20 11v2"/>').replace('stroke="currentColor"', 'stroke="#fff"');
const REFRESH_ICON = svg(16, 1.9, '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>');
const NAV_ICONS: Record<NavKey, string> = {
  overview: svg(16, 1.9, '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>'),
  changes: svg(16, 1.9, '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v4a5 5 0 0 0 5 5h4.5"/>'),
  tasks: svg(16, 1.9, '<path d="M4 6h2"/><path d="M4 12h2"/><path d="M4 18h2"/><path d="M10 6h10"/><path d="M10 12h10"/><path d="M10 18h10"/>'),
  brain: svg(16, 1.9, '<path d="M12 5a3 3 0 0 0-5.6-1.5A3.5 3.5 0 0 0 4 9a3.5 3.5 0 0 0 .5 6.3A3 3 0 0 0 10 17.5 2.5 2.5 0 0 0 12 20z"/><path d="M12 5a3 3 0 0 1 5.6-1.5A3.5 3.5 0 0 1 20 9a3.5 3.5 0 0 1-.5 6.3A3 3 0 0 1 14 17.5 2.5 2.5 0 0 1 12 20z"/>'),
  stats: svg(16, 1.9, '<path d="M5 20V11"/><path d="M12 20V4"/><path d="M19 20v-7"/>'),
};

/** Main navigation; Changes, Tasks and Brain link to routes that are served later (E1-4). */
export const NAV_ITEMS: ReadonlyArray<{ key: NavKey; label: string; href: string; icon: string }> = [
  { key: 'overview', label: 'Übersicht', href: '/', icon: NAV_ICONS.overview },
  { key: 'changes', label: 'Changes', href: '/changes', icon: NAV_ICONS.changes },
  { key: 'tasks', label: 'Tasks', href: '/tasks', icon: NAV_ICONS.tasks },
  { key: 'brain', label: 'Brain', href: '/brain', icon: NAV_ICONS.brain },
  { key: 'stats', label: 'Statistik', href: '/stats', icon: NAV_ICONS.stats },
];

export interface AuroraCircle {
  /** #rrggbb */
  color: string;
  /** Diameter in px, 480–660. */
  size: number;
  /** Horizontal anchor: 'left' or 'right' plus a length in px or %, e.g. 'left -160px', 'right 6%'. */
  x: string;
  /** Distance from the top in px. */
  y: number;
  /** 0.16–0.32 */
  opacity: number;
  /** Blur radius in px, 90–110 (default 110). */
  blur?: number;
}

export type AuroraPage = 'overview' | 'team' | 'changes' | 'tasks' | 'brain' | 'stats';

const c = (color: string, size: number, x: string, y: number, opacity: number, blur = 110): AuroraCircle => ({ color, size, x, y, opacity, blur });

/** Aurora circles per page (mockup values). */
export const AURORA: Record<AuroraPage, ReadonlyArray<AuroraCircle>> = {
  overview: [c('#0d9488', 620, 'left -160px', -200, 0.32, 90), c('#6d28d9', 560, 'right -120px', -120, 0.3, 100),
    c('#1d4ed8', 520, 'left 30%', 640, 0.22), c('#be185d', 480, 'right 6%', 1180, 0.18)],
  team: [c('#059669', 640, 'left 18%', -260, 0.3), c('#6d28d9', 560, 'right -140px', 120, 0.28),
    c('#0e7490', 520, 'left -160px', 900, 0.26), c('#be185d', 480, 'right 10%', 1400, 0.16)],
  changes: [c('#0d9488', 600, 'right -120px', -200, 0.28, 100), c('#7c3aed', 560, 'left -180px', 260, 0.26),
    c('#1d4ed8', 500, 'right 20%', 1000, 0.2)],
  tasks: [c('#0d9488', 620, 'left -160px', -220, 0.3, 100), c('#6d28d9', 520, 'right -100px', 300, 0.28),
    c('#b45309', 480, 'left 40%', 760, 0.16)],
  brain: [c('#7c3aed', 660, 'right -180px', -240, 0.32), c('#0d9488', 540, 'left -160px', 200, 0.26),
    c('#be185d', 480, 'left 45%', 900, 0.18)],
  stats: [c('#1d4ed8', 620, 'left 25%', -280, 0.28), c('#0d9488', 520, 'right -120px', 420, 0.24),
    c('#7c3aed', 480, 'left -140px', 640, 0.22)],
};

/** Validates the circles and renders them as blurred <i> elements. Throws a RangeError for values outside the mockup ranges. */
export function auroraHtml(circles: ReadonlyArray<AuroraCircle>): string {
  if (!Array.isArray(circles) || circles.length < 3 || circles.length > 4) throw new RangeError('aurora needs 3 to 4 circles');
  return circles.map((circle) => {
    const blur = circle.blur ?? 110;
    if (!/^#[0-9a-fA-F]{6}$/.test(circle.color)) throw new RangeError(`aurora color: ${circle.color}`);
    if (!(circle.size >= 480 && circle.size <= 660)) throw new RangeError(`aurora size: ${circle.size}`);
    if (!(circle.opacity >= 0.16 && circle.opacity <= 0.32)) throw new RangeError(`aurora opacity: ${circle.opacity}`);
    if (!(blur >= 90 && blur <= 110)) throw new RangeError(`aurora blur: ${blur}`);
    if (!Number.isFinite(circle.y)) throw new RangeError(`aurora y: ${circle.y}`);
    const m = /^(left|right) (-?\d+(?:\.\d+)?(?:px|%))$/.exec(circle.x);
    if (!m) throw new RangeError(`aurora x: ${circle.x}`);
    return `<i style="width:${circle.size}px;height:${circle.size}px;${m[1]}:${m[2]};top:${circle.y}px;background:${circle.color};opacity:${circle.opacity};filter:blur(${blur}px)"></i>`;
  }).join('');
}

export interface Crumb {
  label: string;
  /** Link target; the last crumb (the current page) has none. */
  href?: string;
}

export interface PageOptions {
  /** Document title (escaped). */
  title: string;
  /** Active main navigation entry, null on pages outside the navigation (e.g. the agent detail view). */
  nav: NavKey | null;
  /** Entry highlighted as a pill without aria-current; only used when nav is null (the team view highlights Übersicht). */
  navHighlight?: NavKey;
  /** Aurora circles (3 to 4), see AURORA for the per-page presets. */
  aurora: ReadonlyArray<AuroraCircle>;
  /** Shows the "Jetzt pollen" button in the header. */
  pollNow?: boolean;
  /** Breadcrumbs, rendered only when set. */
  crumbs?: ReadonlyArray<Crumb>;
  /** Content of <main id="main">. */
  body: string;
  /** Markup after </main> (overlays such as drawers). */
  after?: string;
  /** The page script; runs after BASE_JS and LAYOUT_JS inside the same function scope (they stay out of the global scope). */
  scripts: string;
  /** Page CSS, appended to the tokens and the shell CSS. */
  styles?: string;
}

export const LAYOUT_CSS = `
  .shell-root { position: relative; min-height: 100vh; overflow: hidden; background: var(--bg); color: var(--fg); font-size: 14px; line-height: 1.5; }

  /* Aurora: blurred colour circles behind the page, a dot grid on top. Only .g blurs. */
  .aurora { position: absolute; inset: 0; z-index: 0; pointer-events: none; }
  .aurora > i { position: absolute; display: block; border-radius: 50%; }
  .aurora::after { content: ""; position: absolute; inset: 0; background-image: radial-gradient(rgba(255, 255, 255, .08) 1px, transparent 1.5px);
    background-size: 22px 22px; }

  .shell-wrap { position: relative; z-index: 1; max-width: 1440px; margin: 0 auto; padding: 16px 20px 48px;
    display: flex; flex-direction: column; gap: 18px; }
  .shell-main { max-width: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 18px; min-width: 0; }

  /* Floating glass header */
  .shell-head { position: relative; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; padding: 8px 10px 8px 14px; border-radius: 22px; }
  .brand { display: inline-flex; align-items: center; gap: 10px; min-height: 44px; flex: none; color: var(--fg-strong); }
  .brand:hover { text-decoration: none; color: var(--fg-strong); }
  .brand-mark { width: 36px; height: 36px; border-radius: 12px; display: grid; place-items: center; flex: none; color: #fff;
    background: linear-gradient(140deg, #14b8a6, #7c3aed); }
  .brand-name { font: 600 17px var(--sans); letter-spacing: -.01em; }
  .sh-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 12px; white-space: nowrap;
    border: 1px solid rgba(255, 255, 255, .12); background: rgba(255, 255, 255, .05); color: var(--fg-chip); }
  .shell-live.tone-green { color: #6ee7b7; border-color: rgba(52, 211, 153, .4); background: rgba(52, 211, 153, .1); }
  .shell-live.tone-green .dot { background: var(--green); }
  .shell-live.tone-gray { color: var(--gray); }
  .shell-live.tone-gray .dot { background: var(--gray); }
  .shell-nav { flex: 1 1 520px; display: flex; justify-content: center; min-width: 0; }
  .shell-well { display: flex; gap: 4px; padding: 4px; border-radius: 999px; background: rgba(0, 0, 0, .28); border: 1px solid rgba(255, 255, 255, .08);
    overflow-x: auto; max-width: 100%; overscroll-behavior-x: contain; scrollbar-width: none; }
  .nv { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 16px; border-radius: 999px; flex: none;
    color: var(--fg-2); font: 500 14px var(--sans); white-space: nowrap; transition: opacity .2s var(--ease); }
  .nv svg { flex: none; }
  .nv:hover { color: var(--fg-strong); background: rgba(255, 255, 255, .06); text-decoration: none; }
  .nv[aria-current="page"], .nv.on { background: rgba(255, 255, 255, .92); color: #0b1220; font-weight: 600; }
  .nv[aria-current="page"]:hover, .nv.on:hover { color: #0b1220; background: #fff; }
  .shell-meta { display: flex; align-items: center; gap: 8px; flex: none; margin-left: auto; }
  .budget-pct.tone-amber { color: var(--amber); }
  .budget-pct.tone-red { color: var(--red); }
  .shell-clock { font: 15px var(--mono); font-variant-numeric: tabular-nums; color: var(--fg); padding: 0 6px; min-width: 8ch; text-align: right; }
  .shell-poll { width: 44px; height: 44px; padding: 0; justify-content: center; border-radius: 999px; }
  .shell-poll.is-busy svg { animation: spin .8s linear infinite; }
  .progress { position: absolute; left: 20px; right: 20px; bottom: -1px; height: 1px; overflow: hidden; pointer-events: none; }
  .progress::after { content: ""; position: absolute; top: 0; bottom: 0; left: 0; width: 30%; transform: translateX(-100%); opacity: 0;
    background: linear-gradient(90deg, transparent, var(--green), transparent); }
  .progress.tick::after { animation: sweep .9s var(--ease); }
  @keyframes sweep { 0% { transform: translateX(-100%); opacity: 0; } 20% { opacity: .9; } 100% { transform: translateX(333%); opacity: 0; } }

  /* Page title block */
  .page-title { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px; padding: 6px 4px 0; }
  .page-title h1 { margin: 0; font-size: 34px; font-weight: 600; letter-spacing: -.02em; line-height: 1.15; }
  .page-sub { margin: 4px 0 0; font-size: 15px; color: var(--fg-2); }
  .page-title-right { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }

  /* Breadcrumbs */
  .crumbs { padding: 0 4px; font-size: 13.5px; color: var(--fg-3); }
  .crumbs ol { display: flex; flex-wrap: wrap; align-items: center; gap: 0 8px; margin: 0; padding: 0; list-style: none; }
  .crumbs li { display: inline-flex; align-items: center; gap: 8px; min-width: 0; overflow-wrap: anywhere; }
  .crumbs li + li::before { content: "›"; }
  .crumbs a { display: inline-flex; align-items: center; min-height: 44px; color: inherit; }
  .crumb-current { color: var(--fg-chip); }

  /* Two-column grid and panels */
  .cols { display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-start; }
  .col-main { flex: 999 1 640px; min-width: 0; display: flex; flex-direction: column; gap: 18px; }
  .col-side { flex: 1 1 420px; min-width: 0; display: flex; flex-direction: column; gap: 18px; }
  .shell-panel { padding: 18px; }
  .panel-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
  .panel-head h2 { margin: 0; }
  .panel-link { font-size: 13px; }

  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); border: 0; }

  @media (max-width: 640px) {
    .shell-wrap { padding-left: 12px; padding-right: 12px; }
    .shell-head { gap: 6px 10px; }
    .shell-nav { order: 3; flex-basis: 100%; }
    .shell-version { display: none; }
  }
  @media (prefers-reduced-transparency: reduce) {
    .aurora { display: none; }
  }
`;

/** Shell client code: LIVE badge, 5 h chip, clock and the poll button. Runs in the page's script scope after BASE_JS. */
export const LAYOUT_JS = `
  // Pages set shellHooks.afterPoll to reload their data after "Jetzt pollen".
  const shellHooks = { afterPoll: null };
  // LIVE badge: green with a pulsing dot after a fresh poll, gray OFFLINE after a failed one.
  function setLive(fresh) {
    const live = document.getElementById('shell-live');
    if (!live) return;
    live.className = 'sh-chip shell-live ' + (fresh ? 'tone-green' : 'tone-gray');
    const dot = document.getElementById('shell-live-dot');
    if (dot) dot.className = fresh ? 'dot live' : 'dot';
    const text = document.getElementById('shell-live-text');
    if (text) text.textContent = fresh ? 'LIVE' : 'OFFLINE';
  }
  // 5 h chip: share of the 5 h token limit already used; amber from 50 %, red from 85 %.
  function fiveHourChip(report) {
    const f = report && report.five_hour && report.five_hour.forecast;
    const limit = f && Number(f.limit_tokens);
    if (!(limit > 0)) return { pct: null, tone: null };
    const pct = Math.round((Number(report.five_hour.used_tokens) || 0) / limit * 100);
    return { pct, tone: pct >= 85 ? 'red' : pct >= 50 ? 'amber' : null };
  }
  function setBudget(report) {
    const node = document.getElementById('shell-budget');
    if (!node) return;
    const chip = fiveHourChip(report);
    if (chip.pct === null) { node.textContent = '5h —'; return; }
    const pct = document.createElement('span');
    pct.className = 'budget-pct' + (chip.tone ? ' tone-' + chip.tone : '');
    pct.textContent = chip.pct + ' %';
    node.replaceChildren('5h ', pct);
  }
  async function loadBudget() {
    try {
      const res = await fetch('/api/v1/budget');
      if (!res.ok) throw new Error('budget ' + res.status);
      setBudget(await res.json());
    } catch { setBudget(null); }
  }
  loadBudget();
  setInterval(loadBudget, 60000);
  (function clock() {
    const node = document.getElementById('shell-clock');
    if (!node) return;
    const tick = () => {
      const now = new Date().toISOString();
      node.textContent = fmtClock(now);
      node.setAttribute('datetime', now);
    };
    tick();
    setInterval(tick, 1000);
  })();
  (function pollButton() {
    const button = document.getElementById('shell-poll');
    if (!button) return;
    button.addEventListener('click', async () => {
      if (button.classList.contains('is-busy')) return;
      button.classList.add('is-busy');
      button.setAttribute('aria-busy', 'true');
      let message = 'Poll fehlgeschlagen';
      try {
        const res = await fetch('/api/v1/refresh', { method: 'POST' });
        const body = await res.json();
        if (res.ok) message = body && body.coalesced ? 'Poll bereits eingereiht' : 'Poll eingereiht';
      } catch {}
      button.classList.remove('is-busy');
      button.removeAttribute('aria-busy');
      const announce = document.getElementById('announce');
      if (announce) announce.textContent = message;
      setTimeout(() => { if (shellHooks.afterPoll) shellHooks.afterPoll(); }, 500);
    });
  })();
`;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"']/g, (ch) => ESCAPES[ch] as string);
}

function navHtml(active: NavKey | null, highlight?: NavKey): string {
  const links = NAV_ITEMS.map((item) => {
    const current = item.key === active ? ' aria-current="page"' : '';
    const on = active === null && item.key === highlight;
    return `<a class="nv${on ? ' on' : ''}" href="${item.href}"${current}>${item.icon}${escapeHtml(item.label)}</a>`;
  });
  return `<nav class="shell-nav" aria-label="Hauptnavigation"><div class="shell-well">${links.join('')}</div></nav>`;
}

/** Breadcrumb trail; the last crumb is the current page: plain text, no link, no aria-current. */
export function breadcrumbs(crumbs: ReadonlyArray<Crumb>): string {
  const items = crumbs.map((crumb, i) => {
    const label = escapeHtml(crumb.label);
    if (i === crumbs.length - 1) return `<li><span class="crumb-current" id="crumb-current">${label}</span></li>`;
    return crumb.href ? `<li><a href="${escapeHtml(crumb.href)}">${label}</a></li>` : `<li><span>${label}</span></li>`;
  });
  return `<nav class="crumbs" aria-label="Brotkrumen"><ol>${items.join('')}</ol></nav>`;
}

/** Title block: h1, subtitle and a slot on the right for chips or controls (trusted HTML). */
export function pageHeader(o: { title: string; subtitle?: string; right?: string }): string {
  const sub = o.subtitle ? `<p class="page-sub">${escapeHtml(o.subtitle)}</p>` : '';
  const right = o.right ? `<div class="page-title-right">${o.right}</div>` : '';
  return `<div class="page-title"><div><h1>${escapeHtml(o.title)}</h1>${sub}</div>${right}</div>`;
}

/** Two-column grid: a wide main column and a side column of sideWidth px (default 420) that wraps below on narrow screens. */
export function twoColumns(main: string, side: string, opts: { sideWidth?: number } = {}): string {
  const width = opts.sideWidth ?? 420;
  if (!Number.isInteger(width) || width <= 0) throw new RangeError(`sideWidth: ${width}`);
  const style = width === 420 ? '' : ` style="flex: 1 1 ${width}px"`;
  return `<div class="cols"><div class="col-main">${main}</div><div class="col-side"${style}>${side}</div></div>`;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Glass panel with a labelled head; right is a link or counter (trusted HTML), children the content (trusted HTML). */
export function panel(o: { title: string; id?: string; right?: string; children: string; ariaLabel?: string }): string {
  const id = o.id ?? `panel-${slug(o.title)}`;
  const label = o.ariaLabel ? `aria-label="${escapeHtml(o.ariaLabel)}"` : `aria-labelledby="${escapeHtml(id)}"`;
  return `<section class="g shell-panel" ${label}><div class="panel-head"><h2 class="lbl" id="${escapeHtml(id)}">${escapeHtml(o.title)}</h2>${o.right ?? ''}</div>${o.children}</section>`;
}

/** Section link in the panel head: "Text →". */
export function sectionLink(label: string, href: string): string {
  return `<a class="panel-link" href="${escapeHtml(href)}">${escapeHtml(label)} →</a>`;
}

/** Builds the complete HTML document of a page inside the shared shell. */
export function page(opts: PageOptions): string {
  const aurora = auroraHtml(opts.aurora);
  const poll = opts.pollNow
    ? `\n    <button class="btn shell-poll" id="shell-poll" type="button" aria-label="Jetzt pollen" title="Jetzt pollen">${REFRESH_ICON}</button>`
    : '';
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(opts.title)}</title>
<style>${TOKENS_CSS}${LAYOUT_CSS}${opts.styles ?? ''}</style>
</head>
<body>
<div class="shell-root">
<div class="aurora" aria-hidden="true">${aurora}</div>
<div class="shell-wrap">
<header class="shell-head g">
  <a class="brand" href="/" aria-label="Symphony – Übersicht">
    <span class="brand-mark" aria-hidden="true">${LOGO_ICON}</span>
    <span class="brand-name">Symphony</span>
  </a>
  <span class="sh-chip shell-live tone-gray" id="shell-live"><span class="dot" id="shell-live-dot"></span><span id="shell-live-text">OFFLINE</span></span>
  ${navHtml(opts.nav, opts.navHighlight)}
  <div class="shell-meta">
    <span class="sh-chip mono" id="shell-budget" title="5-h-Fenster">5h —</span>
    <span class="sh-chip mono shell-version" id="shell-version" title="Symphony-Version">v${escapeHtml(SYMPHONY_VERSION)}</span>
    <time class="shell-clock mono" id="shell-clock" aria-label="Uhr" title="Uhr">--:--:--</time>${poll}
  </div>
  <div class="progress" id="progress" aria-hidden="true"></div>
</header>
${opts.crumbs ? breadcrumbs(opts.crumbs) + '\n' : ''}<p class="sr-only" id="announce" aria-live="polite"></p>
<main id="main" class="shell-main">${opts.body}</main>
</div>
${opts.after ?? ''}
</div>
<script>
(() => {
${BASE_JS}
${LAYOUT_JS}
${opts.scripts}
})();
</script>
</body>
</html>
`;
}
