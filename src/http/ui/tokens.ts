/**
 * Design tokens and base CSS of the dashboard pages: a navy "glass" theme with semantic colors
 * (green = running/healthy, cyan = information, amber = retry/warning, red = error, gray = waiting),
 * role colors, system font stacks (monospace for numbers, no external requests), glass panels (.g / .gi),
 * a visible focus ring, the pulse ring and equalizer and the reduced-motion / reduced-transparency media queries.
 * Animations and transitions only touch transform and opacity.
 *
 * All colour values come from the approved mockup (symphony-glass-dashboard.html) and live once in the typed
 * tables of palette.ts (text, roles, status scales, operations, trace kinds, task tones, ink), re-exported here;
 * TOKENS_CSS interpolates them. The building blocks (COMPONENTS_CSS) are embedded below.
 */

import { COMPONENTS_CSS } from './components.ts';
import { INK, OP_COLORS, ROLE_COLORS, SCALES, TASK_TONES, TEXT, TRACE_COLORS, rgba } from './palette.ts';

export { CHIP_TONES, INK, OP_COLORS, ROLE_COLORS, SCALES, TASK_TONES, TEXT, TRACE_COLORS, rgba } from './palette.ts';

const textVars = Object.entries({ fg: TEXT.fg, 'fg-strong': TEXT.fgStrong, 'fg-2': TEXT.fg2, 'fg-3': TEXT.fg3, 'fg-chip': TEXT.fgChip,
  'fg-label': TEXT.fgLabel, 'fg-mute': TEXT.fgMute, 'fg-faint': TEXT.fgFaint, link: TEXT.link, 'link-hover': TEXT.linkHover })
  .map(([k, v]) => `--${k}: ${v};`).join(' ');
const roleVars = Object.entries(ROLE_COLORS).map(([k, v]) => `--role-${k}: ${v};`).join(' ');
const opVars = Object.entries(OP_COLORS).map(([k, v]) => `--op-${k}: ${v};`).join(' ');
const traceVars = Object.entries(TRACE_COLORS).map(([k, v]) => `--trace-${k}: ${v};`).join(' ');
const scaleVars = Object.entries(SCALES).map(([name, steps]) =>
  Object.entries(steps).map(([step, v]) => `--${name}-${step}: ${v};`).join(' ')).join(' ');
const inkVars = Object.entries(INK).map(([k, v]) => `--ink-${k}: ${v};`).join(' ');
const taskVars = Object.entries(TASK_TONES).map(([k, t]) => `--task-${k}: ${t.fg}; --task-${k}-bg: ${t.bg};`).join(' ');

export const TOKENS_CSS = `
  :root {
    --bg: #070b16; --bg-2: #0a1020; --panel: #111a2c; --panel-2: #152036; --raise: #1a2640;
    --line: rgba(148, 163, 184, .14); --line-2: rgba(148, 163, 184, .24);
    /* Text, links (mockup values). Legacy names below map onto them. */
    ${textVars}
    --text: ${TEXT.fg}; --text-2: ${TEXT.fgChip}; --muted: ${TEXT.fgLabel}; --faint: ${TEXT.fgFaint};
    --green: ${SCALES.green[400]}; --green-dim: ${rgba(SCALES.green[400], .12)}; --green-line: ${rgba(SCALES.green[400], .35)};
    --cyan: ${SCALES.sky[300]}; --cyan-dim: ${rgba(SCALES.sky[300], .1)}; --cyan-line: ${rgba(SCALES.sky[300], .3)};
    --amber: ${SCALES.amber[400]}; --amber-dim: ${rgba(SCALES.amber[400], .1)}; --amber-line: ${rgba(SCALES.amber[400], .35)};
    --red: ${SCALES.red[400]}; --red-dim: ${rgba(SCALES.red[400], .1)}; --red-line: ${rgba(SCALES.red[400], .4)};
    --violet: ${SCALES.violet[300]};
    --gray: ${SCALES.gray[400]}; --gray-dim: ${rgba(SCALES.gray[400], .1)}; --gray-line: ${rgba(SCALES.gray[400], .3)};
    /* Status scales, operations, trace kinds, task tones. */
    ${scaleVars}
    ${opVars}
    ${traceVars}
    ${taskVars}
    /* Ink: dark grounds and text on light grounds (segment, badges). */
    ${inkVars}
    /* Role colors (analyst .. symphony, human). */
    ${roleVars}
    /* Status tones: running, warning, error, waiting. */
    --st-run: var(--green); --st-warn: var(--amber); --st-error: var(--red); --st-wait: var(--gray);
    /* Glass. */
    --glass: rgba(255, 255, 255, .055); --glass-in: rgba(255, 255, 255, .035); --glass-line: rgba(255, 255, 255, .1);
    --glass-blur: 24px; --solid: #111a2c; --focus: ${TEXT.link};
    --radius-g: 20px; --radius-gi: 14px;
    --fs-h1: 34px; --fs-h1-team: 30px; --fs-kpi-22: 22px; --fs-kpi-24: 24px; --fs-kpi-26: 26px; --fs-kpi-28: 28px;
    --fs-meta: 12px; --fs-meta-lg: 12.5px;
    /* Legacy names, kept for page-specific styles. */
    --accent: var(--cyan); --ok: var(--green); --warn: var(--amber); --bad: var(--red); --chip: var(--raise);
        --sans: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: "JetBrains Mono", ui-monospace, Menlo, monospace;
    --radius: 10px; --radius-sm: 6px;
    --ease: cubic-bezier(.2, .7, .2, 1);
    --shadow: 0 1px 0 rgba(255, 255, 255, .02) inset, 0 12px 32px -18px rgba(0, 0, 0, .9);
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html { background: var(--bg); }
  body { margin: 0; min-height: 100vh; background: var(--bg);
    color: var(--text); font: 14px/1.5 var(--sans); -webkit-font-smoothing: antialiased; overflow-x: hidden; }
  body > * { position: relative; z-index: 1; }
  .mono, code, kbd { font-family: var(--mono); font-variant-ligatures: none; font-variant-numeric: tabular-nums; }
  .num { font-family: var(--mono); font-variant-numeric: tabular-nums; }
  a { color: var(--link); text-decoration: none; }
  a:hover { color: var(--link-hover); text-decoration: underline; text-underline-offset: 3px; }
  :focus-visible, a:focus-visible, button:focus-visible, select:focus-visible, input:focus-visible, textarea:focus-visible,
  summary:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  :focus:not(:focus-visible) { outline: none; }

  /* Glass panels: .g for large panels, .gi for inner tiles. Keep the number of blurred layers low. */
  .g { background: rgba(255, 255, 255, .055); border: 1px solid rgba(255, 255, 255, .1); border-radius: 20px;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .08), 0 24px 48px -24px rgba(0, 0, 0, .7);
    -webkit-backdrop-filter: blur(24px) saturate(150%); backdrop-filter: blur(24px) saturate(150%); }
  .gi { background: rgba(255, 255, 255, .035); border: 1px solid rgba(255, 255, 255, .07); border-radius: 14px; }
  .well { background: rgba(0, 0, 0, .28); border: 1px solid rgba(255, 255, 255, .08); }
  .row:hover { background: rgba(255, 255, 255, .035); }
  h1, h2, h3 { margin: 0; font-weight: 600; }
  h1 { font-size: var(--fs-h1); letter-spacing: -.02em; }
  .subtitle { font-size: 15px; color: var(--fg-2); }
  .lbl { font: 500 11px/1.3 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--fg-label); }
  .kpi { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: var(--fs-kpi-24); }
  ::selection { background: ${rgba(SCALES.green[400], .25)}; }

  .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }

  /* Controls */
  button, .btn, select, input[type="search"] { font: 500 12px var(--mono); letter-spacing: .08em; color: var(--text);
    background: var(--panel-2); border: 1px solid var(--line-2); border-radius: var(--radius-sm); padding: 7px 12px;
    min-height: 44px; }
  button, .btn { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; text-transform: uppercase; white-space: nowrap; }
  input[type="search"] { letter-spacing: 0; min-width: 0; }
  select { cursor: pointer; letter-spacing: .02em; max-width: 100%; }
  button:hover, .btn:hover, select:hover, input[type="search"]:hover { border-color: var(--faint); background: var(--raise); color: #fff; text-decoration: none; }
  .btn-primary { border-color: var(--green-line); color: var(--green); background: var(--green-dim); }
  .btn-primary:hover { border-color: var(--green); color: #b8f5d2; background: ${rgba(SCALES.green[400], .18)}; box-shadow: 0 0 16px -6px ${rgba(SCALES.green[400], .6)}; }
  .btn-icon { width: 13px; height: 13px; flex: none; }
  .btn.is-busy .btn-icon { animation: spin .8s linear infinite; }
  .btn.is-done { border-color: var(--green); color: #b8f5d2; }
  .btn.is-failed { border-color: var(--red-line); color: var(--red); background: var(--red-dim); }
  @keyframes spin { to { transform: rotate(360deg); } }
  .btn-ghost { background: transparent; border-color: transparent; color: var(--text-2); }

  /* Status dots and badges */
  .dot { display: inline-block; flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--gray); position: relative; }
  .tone-green { --tone: var(--green); --tone-dim: var(--green-dim); --tone-line: var(--green-line); }
  .tone-cyan { --tone: var(--cyan); --tone-dim: var(--cyan-dim); --tone-line: var(--cyan-line); }
  .tone-amber { --tone: var(--amber); --tone-dim: var(--amber-dim); --tone-line: var(--amber-line); }
  .tone-red { --tone: var(--red); --tone-dim: var(--red-dim); --tone-line: var(--red-line); }
  .tone-gray { --tone: var(--gray); --tone-dim: var(--gray-dim); --tone-line: var(--gray-line); }
  .role-analyst { --role: var(--role-analyst); } .role-architect { --role: var(--role-architect); }
  .role-developer { --role: var(--role-developer); } .role-tester { --role: var(--role-tester); }
  .role-docs { --role: var(--role-docs); } .role-reviewer { --role: var(--role-reviewer); }
  .role-security { --role: var(--role-security); } .role-symphony { --role: var(--role-symphony); } .role-human { --role: var(--role-human); }
  [class*="tone-"] .dot, .dot[class*="tone-"] { background: var(--tone); box-shadow: 0 0 8px -1px var(--tone); }
  .pulse .dot::after, .dot.pulse::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: var(--tone, var(--green));
    animation: pulse 1.8s ease-out infinite; }
  @keyframes pulse { 0% { transform: scale(1); opacity: .65; } 100% { transform: scale(2); opacity: 0; } }
  @keyframes pulse-lg { 0% { transform: scale(1); opacity: .65; } 100% { transform: scale(1.7); opacity: 0; } }
  @keyframes eq { 0%, 100% { transform: scaleY(.3); } 50% { transform: scaleY(1); } }
  @keyframes breathe { 0%, 100% { opacity: .75; } 50% { opacity: 1; } }
  .live { position: relative; }
  .live::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: inherit; animation: pulse 1.8s ease-out infinite; }
  .ring { position: absolute; inset: -5px; border-radius: 50%; border: 2px solid currentColor; pointer-events: none;
    animation: pulse 1.8s ease-out infinite; }
  .ring-lg { animation-name: pulse-lg; }
  .eq { display: inline-flex; align-items: flex-end; gap: 2px; height: 14px; }
  .eq i { display: block; width: 3px; height: 14px; border-radius: 2px; background: currentColor; transform-origin: bottom;
    animation: eq 1s ease-in-out infinite; }
  .eq i:nth-child(2) { animation-delay: -.3s; } .eq i:nth-child(3) { animation-delay: -.6s; }
  .eq i:nth-child(4) { animation-delay: -.15s; } .eq i:nth-child(5) { animation-delay: -.45s; }
  .eq-lg { gap: 3px; height: 18px; }
  .eq-lg i { width: 4px; height: 18px; }
  .breathe { animation: breathe 4s ease-in-out infinite; }
  .badge { display: inline-flex; align-items: center; gap: 7px; padding: 3px 9px 3px 8px; border-radius: 999px;
    border: 1px solid var(--tone-line, var(--line-2)); background: var(--tone-dim, transparent); color: var(--tone, var(--text-2));
    font: 600 10.5px var(--mono); letter-spacing: .14em; text-transform: uppercase; white-space: nowrap; }
  .chip { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line-2); background: var(--panel-2);
    color: var(--text-2); font: 500 11px var(--mono); white-space: nowrap; }

  /* Workspace integrations (e.g. Laravel Boost): icon, dimmed when the integration is not available. */
  .int-icon { display: inline-block; flex: none; vertical-align: middle; border-radius: 4px; }
  .int-icon.glyph { display: inline-grid; place-items: center; background: var(--raise); color: var(--text-2); font: 600 10px var(--mono); }
  .int-icon.dim { filter: grayscale(1); opacity: .45; }

  /* Layout */
  main { max-width: 1480px; margin: 0 auto; padding: 20px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; }
  section, .panel { background: linear-gradient(180deg, rgba(21, 32, 54, .78), rgba(17, 26, 44, .78)); border: 1px solid var(--line);
    border-radius: var(--radius); padding: 16px; min-width: 0; box-shadow: var(--shadow); }
  .section-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; margin-bottom: 14px; }
  h2, .eyebrow { font: 600 11px var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--text-2); margin: 0 0 10px; }
  .section-head h2 { margin: 0; display: flex; align-items: center; gap: 10px; }
  h2 .count { color: var(--muted); font-weight: 500; letter-spacing: .06em; }
  .meta, .muted { color: var(--fg-3); font-size: var(--fs-meta); overflow-wrap: anywhere; }
  .msg { color: var(--text-2); overflow-wrap: anywhere; }
  .empty { color: var(--muted); padding: 6px 0; }

  /* Problems */
  .problems { border-color: var(--red-line); background: linear-gradient(180deg, ${rgba(SCALES.red[400], .07)}, rgba(17, 26, 44, .8)); }
  .problems h2 { color: var(--red); display: flex; align-items: center; gap: 8px; }
  .problems ul { margin: 0; padding-left: 18px; }
  .problems li { color: #ffc2c7; font: 12.5px/1.6 var(--mono); overflow-wrap: anywhere; }

  /* Metric tiles */
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .stat { position: relative; overflow: hidden; min-width: 0; padding: 12px 14px 12px 16px; border: 1px solid var(--line);
    border-radius: var(--radius); background: rgba(17, 26, 44, .8); }
  .stat::before { content: ""; position: absolute; left: 0; top: 12px; bottom: 12px; width: 2px; border-radius: 2px; background: var(--tone, var(--faint)); opacity: .8; }
  .stat:hover { border-color: var(--line-2); }
  .stat .label { font: 600 10.5px var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--muted); display: flex; align-items: center; gap: 7px; }
  .stat .value { font: 600 22px/1.2 var(--mono); font-variant-numeric: tabular-nums; color: #eef6f2; margin-top: 6px; letter-spacing: -.01em; overflow-wrap: anywhere; }
  .stat .value .of { color: var(--muted); font-weight: 500; font-size: 15px; }
  .stat .sub { color: var(--muted); font-size: 11.5px; margin-top: 2px; }
  .stat.hero { border-color: var(--green-line); background: linear-gradient(135deg, ${rgba(SCALES.green[400], .09)}, rgba(17, 26, 44, .85) 70%); }
  .stat.hero .value { color: var(--green); text-shadow: 0 0 22px ${rgba(SCALES.green[400], .3)}; }

  /* Tables (logs page) */
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; border-top: 1px solid var(--line); vertical-align: top; }
  th { font: 600 10.5px var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); border-top: none; white-space: nowrap; }
  tr:hover td { background: rgba(255, 255, 255, .015); }
  td.num, th.num { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.nowrap { white-space: nowrap; }

  ${COMPONENTS_CSS}

  @media (max-width: 640px) {
    main { padding-left: 12px; padding-right: 12px; }
    main { gap: 14px; }
    section, .panel { padding: 13px; }
    .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .stat .value { font-size: 19px; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
  }
  @media (prefers-reduced-transparency: reduce) {
    .g, .gi, section, .panel, .stat { background: var(--solid) !important; -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }
    body { background: var(--bg); }
  }
`;
