/**
 * Design tokens and base CSS of the dashboard pages: a navy "glass" theme with semantic colors
 * (green = running/healthy, cyan = information, amber = retry/warning, red = error, gray = waiting),
 * role colors, system font stacks (monospace for numbers, no external requests), glass panels (.g / .gi),
 * a visible focus ring and the reduced-motion / reduced-transparency media queries.
 * Animations and transitions only touch transform and opacity.
 */
export const TOKENS_CSS = `
  :root {
    --bg: #070b16; --bg-2: #0a1020; --panel: #111a2c; --panel-2: #152036; --raise: #1a2640;
    --line: rgba(148, 163, 184, .14); --line-2: rgba(148, 163, 184, .24); --text: #e2e8f0; --text-2: #cbd5e1; --muted: #94a3b8; --faint: #8291a8;
    --cyan: #4fd1e8; --cyan-dim: rgba(79, 209, 232, .1); --cyan-line: rgba(79, 209, 232, .3);
    --amber: #f5b544; --amber-dim: rgba(245, 181, 68, .1); --amber-line: rgba(245, 181, 68, .35);
    --red: #ff5f6d; --red-dim: rgba(255, 95, 109, .1); --red-line: rgba(255, 95, 109, .4);
    --gray: #94a3b8; --gray-dim: rgba(148, 163, 184, .1); --gray-line: rgba(148, 163, 184, .3);
    /* Role colors. */
    --role-analyst: #38bdf8; --role-architect: #a78bfa; --role-developer: #34d399; --role-tester: #fbbf24;
    --role-docs: #cbd5e1; --role-reviewer: #f472b6; --role-security: #fb923c; --role-symphony: #94a3b8;
    /* Status tones: running, warning, error, waiting. */
    --st-run: var(--green); --st-warn: var(--amber); --st-error: var(--red); --st-wait: var(--gray);
    /* Glass. */
    --glass: rgba(17, 26, 44, .62); --glass-in: rgba(255, 255, 255, .035); --glass-line: rgba(148, 163, 184, .16);
    --glass-blur: 16px; --solid: #111a2c; --focus: #7dd3fc;
    /* Legacy names, kept for page-specific styles. */
    --accent: var(--cyan); --ok: var(--green); --warn: var(--amber); --bad: var(--red); --chip: var(--raise);
    --sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, "Cascadia Code", Consolas, "Liberation Mono", monospace;
    --radius: 10px; --radius-sm: 6px;
    --ease: cubic-bezier(.2, .7, .2, 1);
    --shadow: 0 1px 0 rgba(255, 255, 255, .02) inset, 0 12px 32px -18px rgba(0, 0, 0, .9);
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html { background: var(--bg); }
  body { margin: 0; min-height: 100vh; background: radial-gradient(1100px 600px at 12% -10%, rgba(167, 139, 250, .10), transparent 60%),
      radial-gradient(900px 500px at 110% 0%, rgba(56, 189, 248, .08), transparent 60%),
      radial-gradient(900px 600px at 50% 120%, rgba(52, 211, 153, .06), transparent 60%), var(--bg);
    color: var(--text); font: 14px/1.5 var(--sans); -webkit-font-smoothing: antialiased; overflow-x: hidden; }
  .mono, code, kbd { font-family: var(--mono); font-variant-ligatures: none; }
  .num { font-family: var(--mono); font-variant-numeric: tabular-nums; }
  a { color: var(--cyan); text-decoration: none; }
  a:hover { color: #8be6f5; text-decoration: underline; text-underline-offset: 3px; }
  a:focus-visible, button:focus-visible, select:focus-visible, input:focus-visible, textarea:focus-visible,
  summary:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  :focus:not(:focus-visible) { outline: none; }

  /* Glass panels: .g for large panels, .gi for inner tiles. Keep the number of blurred layers low. */
  .g { background: var(--glass); border: 1px solid var(--glass-line); border-radius: var(--radius); box-shadow: var(--shadow);
    -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(140%); backdrop-filter: blur(var(--glass-blur)) saturate(140%); }
  .gi { background: var(--glass-in); border: 1px solid var(--glass-line); border-radius: var(--radius-sm);
    -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
  h1, h2, h3 { margin: 0; font-weight: 600; }
  ::selection { background: rgba(61, 220, 132, .25); }

  /* Top bar */
  .topbar { position: sticky; top: 0; z-index: 20; border-bottom: 1px solid var(--line);
    background: rgba(7, 11, 22, .82); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); }
  .topbar-inner { max-width: 1480px; margin: 0 auto; padding: 14px 20px; display: flex; flex-wrap: wrap; gap: 14px 28px;
    align-items: center; justify-content: space-between; }
  .brand { display: flex; align-items: center; gap: 12px; min-width: 0; color: inherit; }
  .brand:hover { text-decoration: none; color: inherit; }
  .brand-mark { width: 34px; height: 34px; border-radius: 8px; display: grid; place-items: center; flex: none;
    border: 1px solid var(--green-line); background: linear-gradient(145deg, rgba(61, 220, 132, .16), rgba(61, 220, 132, .02));
    box-shadow: 0 0 18px -6px rgba(61, 220, 132, .55); color: var(--green); font: 600 15px var(--mono); }
  .brand-text { display: flex; flex-direction: column; line-height: 1.15; min-width: 0; }
  .brand-name { font: 700 15px var(--mono); letter-spacing: .32em; color: #eaf4ef; }
  .brand-sub { font: 500 10.5px var(--mono); letter-spacing: .26em; color: var(--green); opacity: .8; margin-top: 3px; }
  .brand-page { font: 500 10.5px var(--mono); letter-spacing: .2em; color: var(--muted); margin-left: 4px; }
  .sysinfo { display: flex; flex-wrap: wrap; gap: 6px 22px; margin: 0; align-items: center; }
  .sysinfo div { display: flex; flex-direction: column; min-width: 0; }
  .sysinfo dt { font: 500 10px var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
  .sysinfo dd { margin: 1px 0 0; font: 500 12.5px var(--mono); color: var(--text); white-space: nowrap; }
  .topbar .actions a { min-height: 44px; display: inline-flex; align-items: center; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .progress { position: absolute; left: 0; right: 0; bottom: -1px; height: 1px; overflow: hidden; pointer-events: none; }
  .progress::after { content: ""; position: absolute; top: 0; bottom: 0; left: 0; width: 30%; transform: translateX(-100%); opacity: 0;
    background: linear-gradient(90deg, transparent, var(--green), transparent); }
  .progress.tick::after { animation: sweep .9s var(--ease); }
  @keyframes sweep { 0% { transform: translateX(-100%); opacity: 0; } 20% { opacity: .9; } 100% { transform: translateX(333%); opacity: 0; } }

  /* Controls */
  button, .btn, select, input[type="search"] { font: 500 12px var(--mono); letter-spacing: .08em; color: var(--text);
    background: var(--panel-2); border: 1px solid var(--line-2); border-radius: var(--radius-sm); padding: 7px 12px;
    min-height: 44px; }
  button, .btn { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; text-transform: uppercase; white-space: nowrap; }
  input[type="search"] { letter-spacing: 0; min-width: 0; }
  select { cursor: pointer; letter-spacing: .02em; max-width: 100%; }
  button:hover, .btn:hover, select:hover, input[type="search"]:hover { border-color: var(--faint); background: var(--raise); color: #fff; text-decoration: none; }
  .btn-primary { border-color: var(--green-line); color: var(--green); background: var(--green-dim); }
  .btn-primary:hover { border-color: var(--green); color: #b8f5d2; background: rgba(61, 220, 132, .18); box-shadow: 0 0 16px -6px rgba(61, 220, 132, .6); }
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
  .role-security { --role: var(--role-security); } .role-symphony { --role: var(--role-symphony); }
  [class*="tone-"] .dot, .dot[class*="tone-"] { background: var(--tone); box-shadow: 0 0 8px -1px var(--tone); }
  .pulse .dot::after, .dot.pulse::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: var(--tone, var(--green));
    animation: pulse 1.8s var(--ease) infinite; }
  @keyframes pulse { 0% { transform: scale(1); opacity: .7; } 80%, 100% { transform: scale(3); opacity: 0; } }
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
  .meta, .muted { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
  .msg { color: var(--text-2); overflow-wrap: anywhere; }
  .empty { color: var(--muted); padding: 6px 0; }

  /* Problems */
  .problems { border-color: var(--red-line); background: linear-gradient(180deg, rgba(255, 95, 109, .07), rgba(17, 26, 44, .8)); }
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
  .stat.hero { border-color: var(--green-line); background: linear-gradient(135deg, rgba(61, 220, 132, .09), rgba(17, 26, 44, .85) 70%); }
  .stat.hero .value { color: var(--green); text-shadow: 0 0 22px rgba(61, 220, 132, .3); }

  /* Tables (logs page) */
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; border-top: 1px solid var(--line); vertical-align: top; }
  th { font: 600 10.5px var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); border-top: none; white-space: nowrap; }
  tr:hover td { background: rgba(255, 255, 255, .015); }
  td.num, th.num { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.nowrap { white-space: nowrap; }

  @media (max-width: 640px) {
    .topbar-inner, main { padding-left: 12px; padding-right: 12px; }
    main { gap: 14px; }
    section, .panel { padding: 13px; }
    .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .stat .value { font-size: 19px; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
  }
  @media (prefers-reduced-transparency: reduce) {
    .g, .gi, section, .panel, .stat, .topbar { background: var(--solid) !important; -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }
    body { background: var(--bg); }
  }
`;
