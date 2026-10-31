/**
 * Page shell shared by every dashboard page: the aurora background, the floating glass header (logo, LIVE badge,
 * main navigation, 5 h chip, version, clock, poll progress strip) and optional breadcrumbs. page() builds the
 * complete HTML document around a page's own markup, CSS and script.
 *
 * The aurora is one fixed layer of soft radial gradients without images or blur; the header is the only blurred
 * element the shell adds (.g), so a page stays within four stacked blur layers. LIVE and the clock are set on the
 * client (setLive() and a one-second timer); the 5 h chip shows the budget of GET /api/v1/budget (loaded on every page, refreshed every 30 s; onBudget() hands the report to the page script).
 */

import { BASE_JS } from '../styles.ts';
import { SYMPHONY_VERSION } from '../../version.ts';
import { TOKENS_CSS } from './tokens.ts';

export type NavKey = 'overview' | 'changes' | 'tasks' | 'brain' | 'stats';

/** Main navigation. */
export const NAV_ITEMS: ReadonlyArray<{ key: NavKey; label: string; href: string }> = [
  { key: 'overview', label: 'Übersicht', href: '/' },
  { key: 'changes', label: 'Changes', href: '/changes' },
  { key: 'tasks', label: 'Tasks', href: '/tasks' },
  { key: 'brain', label: 'Brain', href: '/brain' },
  { key: 'stats', label: 'Statistik', href: '/stats' },
];

export interface Crumb {
  label: string;
  /** Link target; the last crumb (the current page) has none. */
  href?: string;
}

export interface PageOptions {
  /** Document title (escaped). */
  title: string;
  /** Active main navigation entry, null on pages outside the navigation (e.g. the issue detail view). */
  nav: NavKey | null;
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
  /* Aurora: one fixed layer of soft colour fields behind the page, no images and no blur. */
  .aurora { position: fixed; inset: 0; z-index: 0; pointer-events: none;
    background: radial-gradient(1100px 600px at 12% -10%, rgba(167, 139, 250, .14), transparent 60%),
      radial-gradient(900px 500px at 110% 0%, rgba(56, 189, 248, .11), transparent 60%),
      radial-gradient(900px 600px at 50% 120%, rgba(52, 211, 153, .08), transparent 60%); }

  /* Floating glass header */
  .shell-head { position: sticky; top: 12px; z-index: 20; width: calc(100% - 40px); max-width: 1440px; margin: 12px auto 0;
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; padding: 8px 12px 8px 10px; border-radius: 20px; }
  .brand { display: inline-flex; align-items: center; gap: 10px; min-height: 44px; flex: none; color: var(--fg-strong); }
  .brand:hover { text-decoration: none; color: var(--fg-strong); }
  .brand-mark { width: 36px; height: 36px; border-radius: 11px; display: grid; place-items: center; flex: none; color: var(--green);
    border: 1px solid var(--green-line); background: linear-gradient(145deg, rgba(52, 211, 153, .18), rgba(52, 211, 153, .03));
    box-shadow: 0 0 18px -6px rgba(52, 211, 153, .55); }
  .brand-name { font: 600 16px var(--sans); letter-spacing: -.01em; }
  .shell-nav { display: flex; gap: 4px; flex: 1 1 auto; min-width: 0; overflow-x: auto; overscroll-behavior-x: contain;
    scrollbar-width: thin; padding: 2px; }
  .nv { display: inline-flex; align-items: center; min-height: 44px; padding: 0 16px; border-radius: 999px; flex: none;
    color: var(--fg-2); font: 500 13.5px var(--sans); white-space: nowrap; transition: opacity .2s var(--ease); }
  .nv:hover { color: var(--fg-strong); background: rgba(255, 255, 255, .06); text-decoration: none; }
  .nv[aria-current="page"] { background: var(--fg); color: var(--bg); font-weight: 600; }
  .nv[aria-current="page"]:hover { color: var(--bg); background: var(--fg-strong); }
  .shell-meta { display: flex; align-items: center; gap: 8px; flex: none; margin-left: auto; }
  .shell-budget.tone-amber, .shell-budget.tone-red { color: var(--tone); border-color: var(--tone-line); background: var(--tone-dim); }
  .shell-clock { min-width: 8ch; text-align: right; font-size: 13px; color: var(--fg-2); }
  .progress { position: absolute; left: 20px; right: 20px; bottom: -1px; height: 1px; overflow: hidden; pointer-events: none; }
  .progress::after { content: ""; position: absolute; top: 0; bottom: 0; left: 0; width: 30%; transform: translateX(-100%); opacity: 0;
    background: linear-gradient(90deg, transparent, var(--green), transparent); }
  .progress.tick::after { animation: sweep .9s var(--ease); }
  @keyframes sweep { 0% { transform: translateX(-100%); opacity: 0; } 20% { opacity: .9; } 100% { transform: translateX(333%); opacity: 0; } }

  /* Breadcrumbs */
  .crumbs { width: calc(100% - 40px); max-width: 1440px; margin: 8px auto 0; font: 500 12.5px var(--sans); color: var(--fg-3); }
  .crumbs ol { display: flex; flex-wrap: wrap; align-items: center; gap: 0 8px; margin: 0; padding: 0; list-style: none; }
  .crumbs li { display: inline-flex; align-items: center; gap: 8px; min-width: 0; overflow-wrap: anywhere; }
  .crumbs li + li::before { content: "›"; color: var(--fg-mute); }
  .crumbs a { display: inline-flex; align-items: center; min-height: 44px; color: var(--fg-2); }
  .crumbs [aria-current="page"] { color: var(--fg); }

  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); border: 0; }

  @media (max-width: 640px) {
    .shell-head { width: calc(100% - 24px); top: 8px; margin-top: 8px; gap: 6px 10px; }
    .shell-nav { order: 3; flex-basis: 100%; }
    .crumbs { width: calc(100% - 24px); }
    .shell-version { display: none; }
  }
  @media (prefers-reduced-transparency: reduce) {
    .aurora { display: none; }
  }
`;

/** Shell client code: setLive() for the LIVE badge and the clock. Runs in the page's script scope after BASE_JS. */
export const LAYOUT_JS = `
  // LIVE badge: green and pulsing after a fresh poll, gray after a failed one.
  function setLive(fresh) {
    const live = document.getElementById('shell-live');
    if (!live) return;
    live.className = 'badge ' + (fresh ? 'tone-green pulse' : 'tone-gray');
    const label = fresh ? 'Live: verbunden' : 'Live: keine Verbindung';
    live.title = label;
    const text = document.getElementById('shell-live-text');
    if (text) text.textContent = label;
  }
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

  // 5 h chip and budget loader: one GET /api/v1/budget on load and every 30 s, shared by the chip and the page script.
  /** used / limit in percent, null without a window, a forecast or a positive limit. */
  function budgetPercent(w) {
    const limit = w && w.forecast && w.forecast.limit_tokens;
    return typeof limit === 'number' && limit > 0 && typeof w.used_tokens === 'number' ? (w.used_tokens / limit) * 100 : null;
  }
  /** Extra share of the limit (percent) the burn rate adds until the ETA, else until the reset; 0 when it cannot be told. */
  function budgetForecastPercent(w, now) {
    const limit = w && w.forecast && w.forecast.limit_tokens;
    if (!(typeof limit === 'number' && limit > 0) || !(w.burn_rate_per_min > 0)) return 0;
    const horizon = Date.parse(w.forecast.eta || w.resets_at || '');
    if (!Number.isFinite(horizon)) return 0;
    return ((w.burn_rate_per_min * Math.max(0, horizon - now)) / 60000 / limit) * 100;
  }
  /** Text, tone (red on alert, amber from 80 %, else null) and title of the 5 h chip. */
  function budgetChip(report) {
    const w = report && report.five_hour;
    if (!w) return { text: '5 h —', tone: null, title: '5-Stunden-Budget: keine Daten' };
    const pct = budgetPercent(w);
    if (pct === null) return { text: '5 h —', tone: null, title: '5-Stunden-Budget: ' + fmtInt(w.used_tokens) + ' Tokens, noch kein Limit-Treffer bekannt' };
    const tone = w.alert === true ? 'red' : pct >= 80 ? 'amber' : null;
    return { text: '5 h ' + Math.round(pct) + ' %', tone, title: '5-Stunden-Budget: ' + fmtInt(w.used_tokens) + ' von ' + fmtInt(w.forecast.limit_tokens) + ' Tokens' };
  }
  let budgetReport = null;
  const budgetListeners = [];
  /** Registers fn(report | null), called after every load; right away when a report is already there. */
  function onBudget(fn) {
    budgetListeners.push(fn);
    if (budgetReport) fn(budgetReport);
  }
  function paintBudgetChip(report) {
    const node = document.getElementById('shell-budget');
    if (!node) return;
    const chip = budgetChip(report);
    node.className = 'chip mono shell-budget' + (chip.tone ? ' tone-' + chip.tone : '');
    node.textContent = chip.text;
    node.setAttribute('title', chip.title);
  }
  const isBudgetWindow = (w) => !!w && typeof w === 'object' && typeof w.used_tokens === 'number';
  async function loadBudget() {
    let report = null;
    try {
      const res = await fetch('/api/v1/budget', { cache: 'no-store' });
      const body = res.ok ? await res.json() : null;
      if (body && isBudgetWindow(body.five_hour) && isBudgetWindow(body.seven_day)) report = body;
    } catch {}
    budgetReport = report;
    paintBudgetChip(report);
    for (const fn of budgetListeners) fn(report);
  }
  loadBudget();
  setInterval(loadBudget, 30000);
`;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"']/g, (c) => ESCAPES[c] as string);
}

function navHtml(active: NavKey | null): string {
  const links = NAV_ITEMS.map((item) => {
    const current = item.key === active ? ' aria-current="page"' : '';
    return `<a class="nv" href="${item.href}"${current}>${escapeHtml(item.label)}</a>`;
  });
  return `<nav class="shell-nav" aria-label="Hauptnavigation">${links.join('')}</nav>`;
}

function crumbsHtml(crumbs: ReadonlyArray<Crumb>): string {
  const items = crumbs.map((crumb, i) => {
    const label = escapeHtml(crumb.label);
    if (i === crumbs.length - 1) return `<li><span id="crumb-current" aria-current="page">${label}</span></li>`;
    return crumb.href ? `<li><a href="${escapeHtml(crumb.href)}">${label}</a></li>` : `<li><span>${label}</span></li>`;
  });
  return `<nav class="crumbs" aria-label="Brotkrumen"><ol>${items.join('')}</ol></nav>`;
}

/** Builds the complete HTML document of a page inside the shared shell. */
export function page(opts: PageOptions): string {
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
<div class="aurora" aria-hidden="true"></div>
<header class="shell-head g">
  <a class="brand" href="/" aria-label="Symphony – Übersicht">
    <span class="brand-mark" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,12 6,12 8.5,6 11.5,18 14.5,4 17,15 19,12 22,12"/></svg></span>
    <span class="brand-name">Symphony</span>
  </a>
  <span class="badge tone-gray" id="shell-live" title="Live: Verbindung wird aufgebaut"><span class="dot"></span><span aria-hidden="true">Live</span><span class="sr-only" id="shell-live-text">Live: Verbindung wird aufgebaut</span></span>
  ${navHtml(opts.nav)}
  <div class="shell-meta">
    <span class="chip mono shell-budget" id="shell-budget" title="5-Stunden-Budget">5 h —</span>
    <span class="chip mono shell-version" id="shell-version" title="Symphony-Version">v${escapeHtml(SYMPHONY_VERSION)}</span>
    <time class="shell-clock mono" id="shell-clock" aria-label="Uhr" title="Uhr">--:--:--</time>
  </div>
  <div class="progress" id="progress" aria-hidden="true"></div>
</header>
${opts.crumbs ? crumbsHtml(opts.crumbs) + '\n' : ''}<p class="sr-only" id="announce" aria-live="polite"></p>
<main id="main">${opts.body}</main>
${opts.after ?? ''}
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
