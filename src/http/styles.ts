/**
 * Shared look of the dashboard pages: a dark "control center" theme with semantic colors
 * (green = running/healthy, cyan = information, amber = retry/warning, red = error, gray = inactive),
 * a sans-serif UI font with monospace for technical values, and a faint CSS-only grid/scanline backdrop.
 */
export const BASE_CSS = `
  :root {
    --bg: #05080a; --bg-2: #080d10; --panel: #0b1115; --panel-2: #0f171c; --raise: #131e24;
    --line: #18252c; --line-2: #22343d; --text: #d5e1dc; --text-2: #9fb0aa; --muted: #6b7d78; --faint: #3b4b47;
    --green: #3ddc84; --green-dim: rgba(61, 220, 132, .12); --green-line: rgba(61, 220, 132, .35);
    --cyan: #4fd1e8; --cyan-dim: rgba(79, 209, 232, .1); --cyan-line: rgba(79, 209, 232, .3);
    --amber: #f5b544; --amber-dim: rgba(245, 181, 68, .1); --amber-line: rgba(245, 181, 68, .35);
    --red: #ff5f6d; --red-dim: rgba(255, 95, 109, .1); --red-line: rgba(255, 95, 109, .4);
    --gray: #7d8b88; --gray-dim: rgba(125, 139, 136, .1); --gray-line: rgba(125, 139, 136, .3);
    /* Legacy names, kept for page-specific styles. */
    --accent: var(--cyan); --ok: var(--green); --warn: var(--amber); --bad: var(--red); --chip: var(--raise);
    --sans: "Inter", "Geist", "Segoe UI Variable", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: "JetBrains Mono", "Geist Mono", "SF Mono", ui-monospace, "Cascadia Code", Menlo, Consolas, monospace;
    --radius: 10px; --radius-sm: 6px;
    --ease: cubic-bezier(.2, .7, .2, 1);
    --shadow: 0 1px 0 rgba(255, 255, 255, .02) inset, 0 12px 32px -18px rgba(0, 0, 0, .9);
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html { background: var(--bg); }
  body { margin: 0; min-height: 100vh; background: radial-gradient(1200px 600px at 15% -10%, rgba(61, 220, 132, .06), transparent 60%),
      radial-gradient(900px 500px at 110% 0%, rgba(79, 209, 232, .04), transparent 60%), var(--bg);
    color: var(--text); font: 14px/1.5 var(--sans); -webkit-font-smoothing: antialiased; overflow-x: hidden; }
  /* Backdrop: a faint grid that fades out toward the bottom, plus barely visible scanlines. */
  body::before, body::after { content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 0; }
  body::before { background-image: linear-gradient(rgba(61, 220, 132, .035) 1px, transparent 1px),
      linear-gradient(90deg, rgba(61, 220, 132, .035) 1px, transparent 1px);
    background-size: 44px 44px; mask-image: linear-gradient(to bottom, #000 0, rgba(0, 0, 0, .5) 40%, transparent 85%); }
  body::after { background: repeating-linear-gradient(to bottom, rgba(255, 255, 255, .012) 0 1px, transparent 1px 3px); }
  body > * { position: relative; z-index: 1; }

  .mono, code, kbd { font-family: var(--mono); font-variant-ligatures: none; }
  .num { font-family: var(--mono); font-variant-numeric: tabular-nums; }
  a { color: var(--cyan); text-decoration: none; transition: color .15s var(--ease); }
  a:hover { color: #8be6f5; text-decoration: underline; text-underline-offset: 3px; }
  :focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; border-radius: 4px; }
  h1, h2, h3 { margin: 0; font-weight: 600; }
  ::selection { background: rgba(61, 220, 132, .25); }

  /* Top bar */
  .topbar { position: sticky; top: 0; z-index: 20; border-bottom: 1px solid var(--line);
    background: linear-gradient(to bottom, rgba(8, 13, 16, .94), rgba(5, 8, 10, .9)); backdrop-filter: blur(10px); }
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
  .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .progress { position: absolute; left: 0; right: 0; bottom: -1px; height: 1px; overflow: hidden; pointer-events: none; }
  .progress::after { content: ""; position: absolute; top: 0; bottom: 0; width: 30%; left: -30%; opacity: 0;
    background: linear-gradient(90deg, transparent, var(--green), transparent); }
  .progress.tick::after { animation: sweep .9s var(--ease); }
  @keyframes sweep { 0% { left: -30%; opacity: 0; } 20% { opacity: .9; } 100% { left: 100%; opacity: 0; } }

  /* Controls */
  button, .btn, select, input[type="search"] { font: 500 12px var(--mono); letter-spacing: .08em; color: var(--text);
    background: var(--panel-2); border: 1px solid var(--line-2); border-radius: var(--radius-sm); padding: 7px 12px;
    transition: border-color .15s var(--ease), background .15s var(--ease), color .15s var(--ease), box-shadow .15s var(--ease); }
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
  [class*="tone-"] .dot, .dot[class*="tone-"] { background: var(--tone); box-shadow: 0 0 8px -1px var(--tone); }
  .pulse .dot::after, .dot.pulse::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: var(--tone, var(--green));
    animation: pulse 1.8s var(--ease) infinite; }
  @keyframes pulse { 0% { transform: scale(1); opacity: .7; } 80%, 100% { transform: scale(3); opacity: 0; } }
  .badge { display: inline-flex; align-items: center; gap: 7px; padding: 3px 9px 3px 8px; border-radius: 999px;
    border: 1px solid var(--tone-line, var(--line-2)); background: var(--tone-dim, transparent); color: var(--tone, var(--text-2));
    font: 600 10.5px var(--mono); letter-spacing: .14em; text-transform: uppercase; white-space: nowrap; }
  .chip { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line-2); background: var(--panel-2);
    color: var(--text-2); font: 500 11px var(--mono); white-space: nowrap; }

  /* Layout */
  main { max-width: 1480px; margin: 0 auto; padding: 20px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; }
  section, .panel { background: linear-gradient(180deg, rgba(15, 23, 28, .78), rgba(11, 17, 21, .78)); border: 1px solid var(--line);
    border-radius: var(--radius); padding: 16px; min-width: 0; box-shadow: var(--shadow); }
  .section-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; margin-bottom: 14px; }
  h2, .eyebrow { font: 600 11px var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--text-2); margin: 0 0 10px; }
  .section-head h2 { margin: 0; display: flex; align-items: center; gap: 10px; }
  h2 .count { color: var(--muted); font-weight: 500; letter-spacing: .06em; }
  .meta, .muted { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
  .msg { color: var(--text-2); overflow-wrap: anywhere; }
  .empty { color: var(--muted); padding: 6px 0; }

  /* Problems */
  .problems { border-color: var(--red-line); background: linear-gradient(180deg, rgba(255, 95, 109, .07), rgba(11, 17, 21, .8)); }
  .problems h2 { color: var(--red); display: flex; align-items: center; gap: 8px; }
  .problems ul { margin: 0; padding-left: 18px; }
  .problems li { color: #ffc2c7; font: 12.5px/1.6 var(--mono); overflow-wrap: anywhere; }

  /* Metric tiles */
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .stat { position: relative; overflow: hidden; min-width: 0; padding: 12px 14px 12px 16px; border: 1px solid var(--line);
    border-radius: var(--radius); background: rgba(11, 17, 21, .8); transition: border-color .2s var(--ease); }
  .stat::before { content: ""; position: absolute; left: 0; top: 12px; bottom: 12px; width: 2px; border-radius: 2px; background: var(--tone, var(--faint)); opacity: .8; }
  .stat:hover { border-color: var(--line-2); }
  .stat .label { font: 600 10.5px var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--muted); display: flex; align-items: center; gap: 7px; }
  .stat .value { font: 600 22px/1.2 var(--mono); font-variant-numeric: tabular-nums; color: #eef6f2; margin-top: 6px; letter-spacing: -.01em; overflow-wrap: anywhere; }
  .stat .value .of { color: var(--muted); font-weight: 500; font-size: 15px; }
  .stat .sub { color: var(--muted); font-size: 11.5px; margin-top: 2px; }
  .stat.hero { border-color: var(--green-line); background: linear-gradient(135deg, rgba(61, 220, 132, .09), rgba(11, 17, 21, .85) 70%); }
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
    *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
  }
`;

/** Client helpers shared by both pages (plain functions, no framework). */
export const BASE_JS = `
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };
  const link = (text, url) => {
    if (typeof url === 'string' && (/^https?:\\/\\//.test(url) || url.startsWith('/'))) {
      const a = el('a', text); a.href = url;
      if (!url.startsWith('/')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      return a;
    }
    return el('span', text);
  };
  // Numbers use one format everywhere (1,284 / 12.9K / $4.20); dates follow the browser locale.
  const fmtInt = (n) => (n ?? 0).toLocaleString('en-US');
  const fmtCompact = (n) => {
    n = n ?? 0;
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e4) return (n / 1e3).toFixed(1) + 'K';
    return fmtInt(n);
  };
  const fmtUsd = (n) => '$' + (n ?? 0).toFixed((n ?? 0) >= 100 ? 0 : 2);
  const fmtDuration = (s) => {
    s = Math.max(0, Math.round(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? h + 'h ' + m + 'm' : m ? m + 'm ' + sec + 's' : sec + 's';
  };
  const ago = (iso) => (iso ? fmtDuration((Date.now() - Date.parse(iso)) / 1000) + ' ago' : '—');
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
  const fmtClock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '--:--:--');
  const pad2 = (n) => String(n ?? 0).padStart(2, '0');

  /** Status dot + label pill; tone is one of green, cyan, amber, red, gray. */
  function badge(text, tone, pulse) {
    const b = el('span', null, 'badge tone-' + tone + (pulse ? ' pulse' : ''));
    b.append(el('span', null, 'dot'), el('span', text));
    return b;
  }

  // Entries of the per-repository logs (/api/v1/history): one-line description and severity.
  const OUTCOMES = {
    handed_off: 'Handed off', continuing: 'Continuing', failed: 'Failed',
    stopped: 'Stopped', stalled: 'Stalled', shutdown: 'Shutdown', session_limit: 'Session limit',
  };
  function describeLogEntry(entry) {
    switch (entry.event) {
      case 'run_started':
        return 'Started in "' + entry.state + '"' + (entry.attempt && entry.attempt !== 'null' ? ' (attempt ' + entry.attempt + ')' : '') +
          (entry.model && entry.model !== 'default' ? ' · ' + entry.model : '');
      case 'run_finished':
        return (OUTCOMES[entry.outcome] || entry.outcome) + ' → "' + entry.state + '" · ' + entry.turns + ' turn(s) · ' +
          fmtCompact(Number(entry.total_tokens)) + ' tokens · ' + fmtUsd(Number(entry.cost_usd)) + ' · ' +
          fmtDuration(Number(entry.agent_seconds)) + (entry.model && entry.model !== 'null' ? ' · ' + entry.model : '') +
          (entry.outcome === 'failed' || entry.outcome === 'stalled' ? ' · ' + entry.reason : '');
      case 'issue_paused':
        return 'Paused after ' + entry.continuations + ' continuation session(s) in "' + entry.state + '"';
      case 'session_limit_wait':
        return 'Waiting for the session limit to reset · retry at ' + fmtTime(entry.retry_at);
      case 'worker_restarted':
        return 'Restarted by the operator' + (entry.previous ? ' (was ' + entry.previous + ')' : '');
      case 'workspace_removed':
        return 'Workspace removed ("' + entry.state + '")';
      default:
        return entry.event;
    }
  }
  function logSeverity(entry) {
    if (entry.event === 'run_finished') {
      if (entry.outcome === 'failed' || entry.outcome === 'stalled') return 'error';
      if (entry.outcome === 'stopped' || entry.outcome === 'shutdown' || entry.outcome === 'session_limit') return 'warn';
      return 'ok';
    }
    if (entry.event === 'issue_paused' || entry.event === 'session_limit_wait') return 'warn';
    return 'info';
  }
  const SEVERITY_TONE = { ok: 'green', info: 'cyan', warn: 'amber', error: 'red' };

  function table(id, columns, rows, emptyText) {
    const t = document.getElementById(id);
    t.replaceChildren();
    if (!rows.length) { const td = el('td', emptyText, 'empty'); const tr = el('tr'); tr.append(td); t.append(tr); return; }
    const head = el('tr');
    for (const c of columns) head.append(el('th', c.label, c.className));
    t.append(head);
    for (const row of rows) {
      const tr = el('tr');
      for (const c of columns) {
        const td = el('td', null, c.className);
        const value = c.render(row);
        if (value instanceof Node) td.append(value); else td.textContent = value ?? '';
        tr.append(td);
      }
      t.append(tr);
    }
  }

  /** Replaces only the children that changed, so running animations and focus survive a refresh. */
  function patchChildren(host, nodes) {
    nodes.forEach((node, i) => {
      const old = host.children[i];
      if (!old) host.append(node);
      else if (old.outerHTML !== node.outerHTML) host.replaceChild(node, old);
    });
    while (host.children.length > nodes.length) host.lastElementChild.remove();
  }

  /** Metric tiles: [label, value, sub, options] with options { tone, hero, pulse, of }. */
  function tiles(id, items) {
    patchChildren(document.getElementById(id), items.map(([label, value, sub, opts]) => {
      opts = opts || {};
      const box = el('div', null, 'stat' + (opts.tone ? ' tone-' + opts.tone : '') + (opts.hero ? ' hero' : ''));
      const head = el('div', null, 'label');
      if (opts.tone) { const d = el('span', null, 'dot' + (opts.pulse ? ' pulse' : '')); head.append(d); }
      head.append(el('span', label));
      const v = el('div', value, 'value');
      if (opts.of !== undefined) v.append(el('span', ' / ' + opts.of, 'of'));
      box.append(head, v);
      if (sub) box.append(el('div', sub, 'sub'));
      return box;
    }));
  }
`;
