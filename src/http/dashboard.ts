import { ALERTS_CSS, ALERTS_JS } from './alerts.ts';
import { PIPELINE_CSS, PIPELINE_JS } from './pipeline.ts';
import { ACTIVITY_CSS, ACTIVITY_JS } from './overview-activity.ts';
import { BRAIN_CSS, BRAIN_JS, BRAIN_PANELS_HTML } from './overview-brain.ts';
import { HEAD_CSS, HEAD_JS } from './overview-head.ts';
import { TEAMS_CSS, TEAMS_JS } from './overview-teams.ts';
import { AURORA, page } from './ui/layout.ts';
import { SYSTEM_COLORS } from './ui/palette.ts';

const DASHBOARD_CSS = `
  /* Dispatch gate: new dispatches wait for an account-wide session limit (a notice, not an error). */
  .dispatch-gate { border-color: var(--amber-line); background: linear-gradient(180deg, var(--amber-dim), rgba(11, 17, 21, .8));
    display: flex; align-items: center; gap: 10px; padding: 12px 16px; color: var(--amber); font: 12.5px/1.6 var(--mono); overflow-wrap: anywhere; }
  .card-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  /* Matrix rain: a few faint glyph columns behind everything, disabled for small screens and reduced motion. */
  .rain { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden;
    mask-image: linear-gradient(to bottom, transparent, #000 15%, #000 55%, transparent 90%); }
  .rain span { position: absolute; top: 0; writing-mode: vertical-rl; text-orientation: upright; white-space: nowrap;
    font: 12px/1 var(--mono); letter-spacing: .35em; color: rgba(61, 220, 132, .06); transform: translateY(-110%);
    animation: fall linear infinite; }
  @keyframes fall { to { transform: translateY(110vh); } }
  @media (max-width: 640px), (prefers-reduced-motion: reduce) { .rain { display: none; } }


  /* System cards: host metrics, agent slots and the tracker API budget, coloured by utilisation (traffic light). */
  .syscards { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
  .sys-host { margin-left: auto; font-size: 12.5px; color: var(--fg-3); }
  .syscard { min-width: 0; display: flex; flex-direction: column; gap: 8px; padding: 14px 14px 10px; }
  .syscard:hover { border-color: var(--line-2); }
  .syscard-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .syscard-label { font-size: 13px; color: var(--fg-2); }
  .syscard-dot { background: var(--faint); }
  .syscard-value { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
  .syscard-value .mono { font: 500 26px var(--mono); color: var(--fg-strong); }
  .syscard-unit { font: 13px var(--mono); color: var(--fg-3); white-space: nowrap; }
  .syscard .ui-spark { width: 100%; }
  .syscard-sub { font-size: 12px; color: var(--fg-3); overflow-wrap: anywhere; }

  /* Running agents */
  .agents-section { border-color: var(--line-2); }
  .agents { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(360px, 100%), 1fr)); gap: 14px; }
  .agent { position: relative; display: flex; flex-direction: column; gap: 14px; min-width: 0; padding: 16px 16px 14px;
    border: 1px solid var(--line-2); border-radius: var(--radius); overflow: hidden;
    background: linear-gradient(160deg, var(--tone-dim) 0%, rgba(11, 17, 21, .96) 38%), var(--panel);
    box-shadow: var(--shadow); transition: border-color .25s var(--ease), transform .25s var(--ease), box-shadow .25s var(--ease); }
  .agent::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 2px;
    background: linear-gradient(90deg, var(--tone), transparent 75%); opacity: .85; transition: background .4s var(--ease); }
  .agent:hover { border-color: var(--tone-line); transform: translateY(-2px);
    box-shadow: var(--shadow), 0 0 0 1px var(--tone-dim), 0 18px 40px -24px var(--tone); }
  .agent.enter { animation: card-in .45s var(--ease) both; }
  .agent.leave { animation: card-out .3s var(--ease) both; pointer-events: none; }
  .agent.changed { animation: card-flash 1.1s var(--ease); }
  @keyframes card-in { from { opacity: 0; transform: translateY(8px) scale(.985); } }
  @keyframes card-out { to { opacity: 0; transform: scale(.97); } }
  @keyframes card-flash { 0% { box-shadow: 0 0 0 1px var(--tone), 0 0 28px -6px var(--tone); } 100% { box-shadow: var(--shadow); } }
  .agent-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .agent-head .tags { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
  /* Integration chips (e.g. Laravel Boost) sit above the card link so their tooltip shows. */
  .int-chips { display: contents; }
  .repos { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 0 0 14px; }
  .repos-label { font: 500 10px var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
  .repo-list { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
  .repo-chip { color: var(--text); text-decoration: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  a.repo-chip:hover { border-color: var(--cyan-line); color: var(--cyan); }
  .repo-chip.all { color: var(--muted); }
  .chip.flag-human { color: var(--red); border-color: var(--red-line); background: var(--red-dim); font-weight: 600; }
  .chip.flag-budget.near { color: var(--amber); border-color: var(--amber-line); }
  .chip.flag-budget.over { color: var(--red); border-color: var(--red-line); }
  .int-chip { position: relative; z-index: 2; display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px 1px 3px; cursor: help; }
  .int-chip.used { border-color: rgba(178, 159, 244, .55); color: #d9cffb; background: rgba(178, 159, 244, .12); }
  .int-chip.off { color: var(--muted); }
  .agent-id { position: relative; z-index: 2; font: 600 15px var(--mono); color: var(--text); letter-spacing: .02em; white-space: nowrap; }
  /* The title link covers the whole card (opens the agent detail view); the issue link stays on top of it. */
  .agent-link { color: inherit; }
  .agent-link:hover { color: inherit; text-decoration: none; }
  .agent-link::after { content: ""; position: absolute; inset: 0; z-index: 1; border-radius: inherit; }
  .agent-link:focus-visible { outline: none; }
  .agent:has(.agent-link:focus-visible) { outline: 2px solid var(--cyan); outline-offset: 2px; }
  .agent-open { font: 500 11px var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--muted); transition: color .2s var(--ease); }
  .agent:hover .agent-open { color: var(--cyan); }
  .agent-id:hover { color: var(--cyan); }
  .agent-title { font: 600 16.5px/1.35 var(--sans); color: #f0f6f3; letter-spacing: -.005em; overflow-wrap: anywhere;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .agent-repo { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px 12px; font: 12px var(--mono); color: var(--muted); min-width: 0; }
  .agent-repo span { overflow-wrap: anywhere; }
  .fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; margin: 0; }
  .fields dt, .k { font: 600 10px var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--muted); }
  .fields dd { margin: 3px 0 0; font: 500 13px var(--mono); color: var(--text); overflow-wrap: anywhere; }
  .fields dd.info { color: var(--cyan); }
  .activity-box { padding: 10px 12px; border-radius: var(--radius-sm); background: rgba(0, 0, 0, .28); border: 1px solid var(--line); min-width: 0; }
  .activity-line { margin-top: 3px; display: flex; flex-wrap: wrap; gap: 0 8px; font: 12.5px var(--mono); }
  .activity-line .ev { color: var(--text); overflow-wrap: anywhere; }
  .activity-line .age { color: var(--muted); }
  .activity-line .age.stale { color: var(--amber); }
  .activity-msg { margin-top: 4px; color: var(--text-2); font-size: 12.5px; overflow-wrap: anywhere;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .activity-msg:empty { display: none; }
  .agent-foot { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; padding-top: 12px; border-top: 1px dashed var(--line-2); margin-top: auto; }
  .agent-foot div { min-width: 0; }
  .agent-foot .v { display: block; margin-top: 2px; font: 600 13.5px var(--mono); font-variant-numeric: tabular-nums; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .agents-empty { display: flex; align-items: center; gap: 16px; padding: 26px 18px; border: 1px dashed var(--line-2); border-radius: var(--radius);
    background: repeating-linear-gradient(135deg, rgba(255, 255, 255, .012) 0 8px, transparent 8px 16px); }
  .agents-empty .big { font: 600 13px var(--mono); letter-spacing: .16em; color: var(--text-2); text-transform: uppercase; }
  .cursor { display: inline-block; width: 8px; height: 15px; background: var(--green); vertical-align: -2px; margin-left: 4px; animation: blink 1.1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }

  /* Lower area: activity stream */
  .lower { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; }
  .feed { list-style: none; margin: 0; padding: 10px 0; max-height: 360px; overflow-y: auto; border-radius: var(--radius-sm);
    background: rgba(0, 0, 0, .35); border: 1px solid var(--line); font: 12.5px/1.65 var(--mono); }
  .feed li { display: grid; grid-template-columns: 72px minmax(0, 9.5em) minmax(0, 1fr); gap: 12px; padding: 1px 14px; color: var(--muted);
    border-left: 2px solid transparent; }
  .feed li:nth-child(n+6) { opacity: .75; }
  .feed li:nth-child(n+16) { opacity: .55; }
  .feed li.latest { background: linear-gradient(90deg, rgba(61, 220, 132, .07), transparent 70%); border-left-color: var(--green); }
  .feed li.fresh { animation: feed-in .6s var(--ease); }
  @keyframes feed-in { from { background: rgba(61, 220, 132, .14); } }
  .feed .t { color: var(--faint); }
  .feed li.latest .t { color: var(--text-2); }
  .feed .who { color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .feed .what { color: var(--text-2); overflow-wrap: anywhere; }
  .feed .what.tone-green { color: var(--green); } .feed .what.tone-cyan { color: var(--cyan); }
  .feed .what.tone-amber { color: var(--amber); } .feed .what.tone-red { color: var(--red); }
  .feed li.latest .what:not([class*="tone-"]) { color: var(--text); }
  .feed .prompt { color: var(--green); padding: 2px 14px; display: block; }
  @media (max-width: 640px) {
    .feed li { grid-template-columns: 64px minmax(0, 1fr); gap: 2px 10px; }
    .feed .what { grid-column: 1 / -1; padding-left: 74px; }
  }

  /* Issue cards: the pipeline strip */
  .agent .pipe { margin: -2px 0; }
  .agent [hidden] { display: none; }

  .section-link { display: inline-flex; align-items: center; min-height: 44px; font-size: 13px; }
  .tasks-line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; margin: 0 0 14px; font-size: 13px; color: var(--muted); }
  .qrow { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 10px; }

  /* Logs drawer */
  .scrim { position: fixed; inset: 0; z-index: 40; background: rgba(2, 4, 5, .5);
    opacity: 0; visibility: hidden; transition: opacity .25s var(--ease), visibility 0s linear .25s; }
  .scrim.open { opacity: 1; visibility: visible; transition: opacity .25s var(--ease); }
  .drawer { position: fixed; top: 0; right: 0; bottom: 0; z-index: 50; width: min(760px, 100vw); display: flex; flex-direction: column;
    background: linear-gradient(180deg, #0a1014, #06090b); border-left: 1px solid var(--line-2); box-shadow: -30px 0 60px -30px #000;
    transform: translateX(100%); visibility: hidden; transition: transform .3s var(--ease), visibility 0s linear .3s; }
  .drawer.open { transform: none; visibility: visible; transition: transform .3s var(--ease); }
  .drawer-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px 18px 12px; border-bottom: 1px solid var(--line); }
  .drawer-head h2 { margin: 0 0 4px; color: var(--text); display: flex; align-items: center; gap: 8px; }
  .drawer-filters { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 18px; border-bottom: 1px solid var(--line); }
  .drawer-filters input[type="search"] { flex: 1 1 180px; }
  .drawer-filters select { flex: 0 1 220px; }
  .seg { display: inline-flex; border: 1px solid var(--line-2); border-radius: var(--radius-sm); overflow: hidden; }
  .seg button { border: 0; border-radius: 0; padding: 7px 10px; background: transparent; color: var(--muted); }
  .seg button + button { border-left: 1px solid var(--line-2); }
  .seg button[aria-pressed="true"] { background: var(--raise); color: var(--tone, var(--text)); }
  .logs { list-style: none; margin: 0; padding: 6px 0; flex: 1; overflow-y: auto; font: 12px/1.55 var(--mono); }
  .logs li { display: grid; grid-template-columns: 118px 44px minmax(0, 1fr); gap: 2px 12px; padding: 7px 18px; border-bottom: 1px solid rgba(24, 37, 44, .6); }
  .logs li:hover { background: rgba(255, 255, 255, .02); }
  .logs .t { color: var(--muted); white-space: nowrap; }
  .logs .sev { font-weight: 600; letter-spacing: .1em; color: var(--tone); }
  .logs .body { min-width: 0; }
  .logs .src { color: var(--text-2); overflow-wrap: anywhere; }
  .logs .src .ev { color: var(--cyan); }
  .logs .d { color: var(--text); overflow-wrap: anywhere; }
  .logs .note { padding: 18px; color: var(--muted); display: block; }
  .drawer-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--line); }
  .drawer-foot .actions { gap: 8px; }
  @media (max-width: 640px) {
    .logs li { grid-template-columns: auto 1fr; }
    .logs .body { grid-column: 1 / -1; }
    .agent-foot { grid-template-columns: repeat(2, minmax(0, 1fr)); row-gap: 10px; }
    .syscards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .budget-windows { grid-template-columns: minmax(0, 1fr); }
  }

  /* Budget: subscription windows, tokens per role, context hint */
  .ov-row { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 20px; margin: 18px 0; }
  .ov-row .budget { margin: 0; flex: 1 1 340px; min-width: 0; }
  .budget { margin: 18px 0; }
  .budget-windows { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .budget-window { padding: 12px 14px; border: 1px solid var(--line); border-radius: 14px; display: flex; flex-direction: column; gap: 8px; }
  .budget-window h3 { margin: 0; font: 600 13px var(--sans); color: var(--text-2); }
  .budget-value { font: 600 15px var(--mono); display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; }
  .budget-value .of { font-weight: 400; font-size: 12px; color: var(--muted); }
  .budget-meta { display: flex; flex-wrap: wrap; gap: 2px 14px; font: 11.5px var(--mono); color: var(--muted); }
  .budget-hint { margin: 0; font-size: 12px; color: var(--muted); }
  .budget-roles-title { margin: 14px 0 6px; font: 600 12.5px var(--sans); color: var(--text-2); }
  .budget-roles { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px 16px; }
  .budget-roles li { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; }
  .budget-roles .mono { color: var(--text-2); }
  .budget-context { margin: 12px 0 0; padding: 8px 12px; border: 1px solid var(--amber-line); border-radius: 12px;
    background: var(--amber-dim); color: var(--amber); font-size: 12.5px; display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; }
  .budget-context a { color: var(--amber); text-decoration: underline; }
`;

/**
 * Client-side dashboard: polls /api/v1/state and renders it as an agent control center. The activity
 * stream combines changes between snapshots with the per-issue events (/api/v1/<identifier>) and the
 * repository logs (/api/v1/history), which also feed the logs drawer. All tracker text is inserted with
 * textContent (issue titles and agent messages are untrusted).
 */
export const DASHBOARD_HTML = page({
  title: 'Symphony',
  nav: 'overview',
  aurora: AURORA.overview,
  pollNow: true,
  styles: PIPELINE_CSS + TEAMS_CSS + ALERTS_CSS + HEAD_CSS + ACTIVITY_CSS + BRAIN_CSS + DASHBOARD_CSS,
  body: `
  <div class="page-title ov-head">
    <div class="ov-title">
      <h1 id="page-title">Übersicht</h1>
      <p class="page-sub" id="ov-subtitle" aria-live="polite">noch kein Poll</p>
    </div>
    <div class="page-title-right ov-side">
      <div class="ov-chips" id="ov-chips" role="group" aria-label="Status"></div>
      <a class="btn" id="logs-open" href="/stats" aria-controls="logs-drawer" aria-expanded="false">
        <svg class="btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h6"/></svg>Logs</a>
    </div>
  </div>
  <section id="repositories" class="repos" aria-label="Repositories" hidden><span class="repos-label">Repositories</span><div class="repo-list" id="repo-list"></div></section>
  <section id="dispatch-gate" class="dispatch-gate" role="status" hidden>
    <span class="dot tone-amber"></span><span id="dispatch-gate-text"></span>
  </section>

  <section class="panel" id="system-panel" aria-labelledby="system-title">
    <div class="section-head"><h2 id="system-title">System</h2><span class="sys-host" id="system-host"></span></div>
    <div class="syscards" id="system-cards" role="group" aria-label="System"></div>
  </section>
  <div class="stats" id="stats" aria-label="Metrics"></div>

  <div class="ov-row">
    <section id="alerts" class="panel alerts" aria-labelledby="alerts-title">
      <div class="section-head"><h2 class="lbl" id="alerts-title">Alerts</h2><span class="alerts-badge" id="alerts-count" aria-live="polite" hidden>0</span></div>
      <ul class="alerts-list" id="alerts-list"></ul>
    </section>
    <section class="budget" id="budget" aria-labelledby="budget-title" hidden>
      <div class="section-head"><h2 id="budget-title">Budget</h2></div>
      <div id="budget-body"></div>
    </section>
  </div>

  <section class="agents-section teams-section" id="teams-section" aria-labelledby="teams-title">
    <div class="section-head"><h2 id="teams-title">Teams live <span class="count" id="teams-count"></span></h2><a class="teams-all" href="/tasks">Alle Tasks →</a></div>
    <div class="team-list" id="teams"></div>
  </section>

  <section class="agents-section" id="running-section" aria-labelledby="running-title">
    <div class="section-head">
      <h2 id="running-title">Running <span class="count" id="running-count"></span></h2>
    </div>
    <p class="tasks-line" id="tasks-line"><span id="tasks-line-text"></span> · <a class="section-link" href="/tasks">Alle Tasks</a></p>
    <div class="agents" id="running"></div>
    <div class="agents-empty" id="issues-empty" hidden>
      <span class="badge tone-gray"><span class="dot"></span><span>Idle</span></span>
      <div><div class="big">No agents running<span class="cursor" aria-hidden="true"></span></div>
        <div class="muted" id="issues-empty-sub">Waiting for issues in an active column.</div></div>
    </div>
  </section>

  <section class="panel act-section" id="tool-activity" aria-labelledby="tool-activity-title">
    <div class="section-head">
      <h2 class="lbl" id="tool-activity-title">Agent-Aktivität · letzte 30 min</h2>
      <div class="act-legend" id="tool-activity-legend"></div>
    </div>
    <div class="act-strip" id="tool-activity-strip" role="img" aria-label="Tool-Aufrufe der letzten 30 Minuten, farbig je Rolle"></div>
    <div class="act-axis" aria-hidden="true"><span>−30 min</span><span>−20 min</span><span>−10 min</span><span>jetzt</span></div>
  </section>

${BRAIN_PANELS_HTML}
  <div class="lower">
    <section aria-labelledby="activity-title">
      <div class="section-head">
        <h2 id="activity-title">Agent activity</h2>
        <span class="meta">live stream · newest first</span>
      </div>
      <ol class="feed" id="feed" aria-live="off"></ol>
    </section>
  </div>
`,
  after: `<div class="rain" id="rain" aria-hidden="true"></div>
<div class="scrim" id="logs-scrim"></div>
<aside class="drawer" id="logs-drawer" role="dialog" aria-modal="true" aria-labelledby="logs-title">
  <div class="drawer-head">
    <div><h2 id="logs-title"><span class="dot tone-cyan"></span>Logs</h2><div class="meta" id="logs-meta">Repository logs</div></div>
    <button class="btn btn-ghost" id="logs-close" type="button" aria-label="Close logs">Esc ✕</button>
  </div>
  <div class="drawer-filters">
    <select id="logs-repo" aria-label="Repository"><option value="">All repositories</option></select>
    <div class="seg" id="logs-sev" role="group" aria-label="Severity">
      <button type="button" data-sev="" aria-pressed="true">All</button>
      <button type="button" data-sev="info" class="tone-cyan" aria-pressed="false">Info</button>
      <button type="button" data-sev="ok" class="tone-green" aria-pressed="false">Ok</button>
      <button type="button" data-sev="warn" class="tone-amber" aria-pressed="false">Warn</button>
      <button type="button" data-sev="error" class="tone-red" aria-pressed="false">Error</button>
    </div>
    <input type="search" id="logs-q" placeholder="Filter issue, event, text…" aria-label="Filter log entries">
  </div>
  <ol class="logs" id="logs-list"></ol>
  <div class="drawer-foot">
    <span class="meta" id="logs-count"></span>
    <div class="actions">
      <a class="btn" id="logs-raw" href="#" target="_blank" rel="noopener" hidden>Raw log</a>
      <button class="btn" id="logs-reload" type="button">Reload</button>
      <a class="btn" href="/stats">Statistics ↗</a>
    </div>
  </div>
</aside>`,
  scripts: `
(() => {
${PIPELINE_JS}${TEAMS_JS}
${ALERTS_JS}${HEAD_JS}${ACTIVITY_JS}${BRAIN_JS}

  const $ = (id) => document.getElementById(id);
  const setText = (node, text) => { text = String(text ?? ''); if (node.textContent !== text) node.textContent = text; };
  const splitId = (identifier) => {
    const i = String(identifier).lastIndexOf('#');
    return i > 0 ? { repo: identifier.slice(0, i), num: identifier.slice(i) } : { repo: '', num: String(identifier) };
  };
  // owner/repo#12 -> repo#12, for the narrow columns of the activity stream.
  const shortId = (identifier) => { const p = splitId(identifier); return (p.repo.split('/').pop() || '') + p.num; };
  const fmtStamp = (iso) => (iso ? new Date(iso).toLocaleDateString([], { month: '2-digit', day: '2-digit' }) + ' ' + fmtClock(iso) : '—');
  const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

  // Visual state of a running agent, derived from its phase (the data model stays as it is).
  const PHASE_STATUS = {
    PreparingWorkspace: 'starting', BuildingPrompt: 'starting', LaunchingAgentProcess: 'starting', InitializingSession: 'starting',
    StreamingTurn: 'running', RunningChecks: 'checking', Finishing: 'finishing', Succeeded: 'completed',
    Failed: 'failed', TimedOut: 'failed', Stalled: 'failed', CanceledByReconciliation: 'stopping',
  };
  const STATUS = {
    running: ['Running', 'green', true], starting: ['Starting', 'cyan', true], checking: ['Running checks', 'cyan', true],
    finishing: ['Finishing', 'green', false], completed: ['Completed', 'green', false], failed: ['Failed', 'red', false],
    stopping: ['Stopping', 'amber', false],
    retrying: ['Retrying', 'amber', true], continuation: ['Continuation', 'cyan', true], session_limit: ['Session limit', 'amber', true],
    paused: ['Paused', 'gray', false], queued: ['New', 'cyan', false],
  };
  const agentStatus = (r) => (r.stopping ? 'stopping' : PHASE_STATUS[r.phase] || 'running');
  const phaseTone = (phase) => STATUS[PHASE_STATUS[phase] || 'running'][1];
  // Visual status of an issue card: running cards derive it from the agent phase, retries from the retry kind.
  function issueStatus(row) {
    if (row.status === 'running' && row.running) return agentStatus(row.running);
    if (row.status === 'retrying' && row.retry) {
      return row.retry.kind === 'continuation' ? 'continuation' : row.retry.kind === 'session_limit' && row.retry.limit ? 'session_limit' : 'retrying';
    }
    return row.status;
  }

  // ------------------------------------------------------------------ background

  (function rain() {
    const glyphs = '0123456789ABCDEF<>/{}[]=+*';
    const host = $('rain');
    const columns = Math.min(18, Math.round(window.innerWidth / 90));
    for (let i = 0; i < columns; i++) {
      let text = '';
      for (let j = 0; j < 18 + Math.floor(Math.random() * 18); j++) text += glyphs[Math.floor(Math.random() * glyphs.length)];
      const s = el('span', text);
      s.style.left = ((i + Math.random() * 0.6) / columns) * 100 + '%';
      s.style.animationDuration = 26 + Math.random() * 30 + 's';
      s.style.animationDelay = -Math.random() * 50 + 's';
      host.append(s);
    }
  })();

  // ------------------------------------------------------------------ header

  function renderRepositories(h) {
    const list = h.repositories;
    $('repositories').hidden = false;
    let nodes;
    if (Array.isArray(list) && list.length) {
      nodes = list.map((name) => {
        const a = el('a', name, 'chip repo-chip');
        a.href = 'https://github.com/' + name;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        return a;
      });
    } else {
      nodes = [el('span', 'all repositories on the board', 'chip repo-chip all')];
    }
    patchChildren($('repo-list'), nodes);
  }

  // ------------------------------------------------------------------ agent cards

  const cards = new Map();

  function field(dl, label, className) {
    const wrap = el('div');
    const dd = el('dd', null, className);
    wrap.append(el('dt', label), dd);
    dl.append(wrap);
    return dd;
  }
  function metric(foot, label) {
    const wrap = el('div');
    const v = el('span', null, 'v');
    wrap.append(el('span', label, 'k'), v);
    foot.append(wrap);
    return v;
  }

  function createCard() {
    const card = el('article', null, 'agent enter');
    card.addEventListener('animationend', (e) => { if (e.target === card) card.classList.remove('enter', 'changed'); });
    const head = el('div', null, 'agent-head');
    const tags = el('div', null, 'tags');
    const position = el('span', null, 'chip pos');
    const statusSlot = el('span');
    const attempt = el('span', null, 'chip');
    const integrations = el('span', null, 'int-chips');
    const flags = el('span', null, 'int-chips');
    tags.append(position, statusSlot, attempt, flags, integrations);
    const id = el('a', null, 'agent-id');
    head.append(tags, id);

    const titleWrap = el('div');
    const title = el('a', null, 'agent-link');
    const heading = el('h3', null, 'agent-title');
    heading.append(title);
    const repoLine = el('div', null, 'agent-repo');
    const repo = el('span');
    const branch = el('span');
    repoLine.append(repo, branch);
    titleWrap.append(heading, repoLine);

    const pipe = el('div');

    const dl = el('dl', null, 'fields');
    const refs = {
      card, position, statusSlot, attempt, flags, integrations, id, title, repo, branch, pipe, fields: dl,
      model: field(dl, 'Model', 'info'), phase: field(dl, 'Phase', 'info'),
    };

    const act = el('div', null, 'activity-box');
    refs.act = act;
    const line = el('div', null, 'activity-line');
    refs.event = el('span', null, 'ev');
    refs.age = el('span', null, 'age');
    line.append(refs.event, refs.age);
    refs.message = el('div', null, 'activity-msg');
    const actHead = el('div', null, 'qrow');
    actHead.append(el('span', 'Last activity', 'k'), el('span', 'Trace →', 'agent-open'));
    act.append(actHead, line, refs.message);

    const foot = el('div', null, 'agent-foot');
    refs.foot = foot;
    refs.turn = metric(foot, 'Turn');
    refs.runtime = metric(foot, 'Runtime');
    refs.tokens = metric(foot, 'Tokens');
    refs.cost = metric(foot, 'Est. cost');

    // Pause of a running issue (running cards only).
    refs.controls = el('div', null, 'card-actions');

    card.append(head, titleWrap, pipe, dl, act, refs.controls, foot);
    return refs;
  }

  function updateCard(refs, row, maxTurns) {
    const status = issueStatus(row);
    const [label, tone, pulse] = STATUS[status] || STATUS.queued;
    const className = 'agent tone-' + tone + ' is-' + status;
    const keep = [...refs.card.classList].filter((c) => c === 'enter' || c === 'changed').join(' ');
    if (refs.status !== undefined && refs.status !== status) {
      refs.card.classList.remove('changed');
      void refs.card.offsetWidth; // restart the flash animation
      refs.card.className = className + ' changed';
    } else {
      refs.card.className = className + (keep ? ' ' + keep : '');
    }
    if (refs.status !== status) refs.statusSlot.replaceChildren(badge(label, tone, pulse));
    refs.status = status;

    const r = row.running;
    const { repo, num } = splitId(row.issue_identifier);
    refs.card.setAttribute('aria-label', 'Issue ' + row.issue_identifier + ', ' + label);
    setText(refs.id, num);
    refs.id.title = row.issue_identifier;
    if (typeof row.issue_url === 'string' && /^https?:/.test(row.issue_url)) {
      if (refs.id.getAttribute('href') !== row.issue_url) { refs.id.href = row.issue_url; refs.id.target = '_blank'; refs.id.rel = 'noopener noreferrer'; }
    } else refs.id.removeAttribute('href');
    refs.position.hidden = row.position == null;
    setText(refs.position, row.position == null ? '' : '#' + row.position);
    const attempt = r ? r.attempt : row.retry ? row.retry.attempt : null;
    refs.attempt.hidden = !attempt;
    setText(refs.attempt, 'attempt ' + (attempt ?? ''));
    patchChildren(refs.flags, flagChips(row));
    patchChildren(refs.integrations, (r ? r.integrations || [] : []).map(integrationChip));
    setText(refs.title, row.title || row.issue_identifier);
    // Only tracked issues have a trace; a queued issue without one links nowhere yet.
    if (row.tracked) {
      const trace = '/issue?id=' + encodeURIComponent(row.issue_identifier);
      if (refs.title.getAttribute('href') !== trace) refs.title.href = trace;
    } else refs.title.removeAttribute('href');
    setText(refs.repo, row.repo && row.repo !== 'unknown' ? row.repo : repo);
    refs.branch.hidden = !(r && r.branch);
    setText(refs.branch, r && r.branch ? '⎇ ' + r.branch : '');

    renderPipeline(refs.pipe, row.stages, { compact: true, liveStatus: row.status });

    refs.fields.hidden = !r;
    refs.act.hidden = !r;
    refs.controls.hidden = !r || !!r.stopping;
    if (r && !r.stopping) patchChildren(refs.controls, [retryAllowed ? restartButton(row.issue_identifier, 'Pause') : el('div', RESTART_DISABLED, 'msg muted restart-off')]);
    refs.foot.hidden = !r;
    if (r) {
      setText(refs.model, r.model || '—');
      setText(refs.phase, r.phase);
      setText(refs.event, r.last_event || 'waiting for first event');
      setText(refs.age, r.last_event_at ? '· ' + ago(r.last_event_at) : '');
      refs.age.classList.toggle('stale', !!r.last_event_at && Date.now() - Date.parse(r.last_event_at) > 120000);
      setText(refs.message, r.stopping ? 'Stopping: ' + r.stopping : r.last_message);
      setText(refs.turn, pad2(r.turn_count) + (maxTurns ? ' / ' + pad2(maxTurns) : ''));
      setText(refs.runtime, fmtDuration(r.seconds_running));
      setText(refs.tokens, fmtCompact(r.tokens.total_tokens));
      setText(refs.cost, fmtUsd(r.cost_usd));
    }
  }

  /** Chips of a card for the board: the needs-human label and the share of the cost budget (agent.max_issue_cost_usd) spent. */
  function flagChips(row) {
    const chips = [];
    if ((row.labels || []).some((l) => String(l).trim().toLowerCase() === 'needs-human')) {
      const chip = el('span', 'needs human', 'chip flag-human');
      chip.title = 'A human must review or decide before the issue can progress (label needs-human)';
      chips.push(chip);
    }
    const b = row.budget;
    if (b && b.max_issue_cost_usd > 0) {
      const share = b.cost_usd / b.max_issue_cost_usd;
      const chip = el('span', '$' + b.cost_usd.toFixed(2) + ' / $' + b.max_issue_cost_usd.toFixed(2), 'chip flag-budget' + (share >= 1 ? ' over' : share >= 0.8 ? ' near' : ''));
      chip.title = 'Cost budget: ' + Math.round(share * 100) + '% of agent.max_issue_cost_usd used';
      chips.push(chip);
    }
    return chips;
  }

  /** Chip for an integration of the run (e.g. Laravel Boost): icon, use count, and the details as tooltip. */
  function integrationChip(x) {
    const ready = x.status === 'ready';
    const calls = x.usage ? x.usage.calls : 0;
    const chip = el('span', null, 'chip int-chip' + (ready ? (calls ? ' used' : '') : ' off'));
    const name = x.id === 'laravel-boost' ? 'Boost' : x.label;
    chip.append(integrationIcon(x.id, 14, !ready), el('span', ready ? name + (calls ? ' ×' + calls : '') : name + ' ✕'));
    const status = INTEGRATION_STATUS[x.status] ? INTEGRATION_STATUS[x.status][0] : x.status;
    const lines = [x.label + ': ' + status];
    for (const p of x.parts || []) {
      if (p.reason) lines.push(p.name + ': ' + p.reason);
      for (const w of p.warnings || []) lines.push('⚠ ' + p.name + ': ' + w);
    }
    if (ready) {
      const tools = countsText(x.usage.tool_calls), skills = countsText(x.usage.skill_calls);
      lines.push(calls ? 'Used ' + calls + '×' : 'Not used yet');
      if (tools) lines.push('Tools: ' + tools);
      if (skills) lines.push('Skills: ' + skills);
    }
    chip.title = lines.join('\\n');
    chip.setAttribute('aria-label', lines.join('. '));
    return chip;
  }

  function renderIssues(state) {
    const h = state.health;
    const rows = state.issues || [];
    const live = new Set();
    const running = [];
    // Only running issues get a card here; the dispatch plan (next, waiting, paused, blocked) lives on /tasks.
    for (const row of rows) {
      if (row.section !== 'running') continue;
      live.add(row.issue_id);
      let refs = cards.get(row.issue_id);
      if (!refs) { refs = createCard(); cards.set(row.issue_id, refs); }
      updateCard(refs, row, h.max_turns);
      running.push(refs.card);
    }
    for (const [id, refs] of cards) {
      if (live.has(id)) continue;
      cards.delete(id);
      refs.card.classList.remove('enter', 'changed');
      refs.card.classList.add('leave');
      setTimeout(() => refs.card.remove(), 320);
    }
    const host = $('running');
    running.forEach((card, i) => {
      const active = [...host.children].filter((c) => !c.classList.contains('leave'));
      if (active[i] !== card) host.insertBefore(card, active[i] || null);
    });
    setText($('running-count'), pad2(running.length));
    const queued = state.counts.queued ?? 0;
    setText($('tasks-line-text'), state.counts.running + (state.counts.running === 1 ? ' Slot belegt' : ' Slots belegt') + ' · ' + queued + ' in der Queue');
    $('issues-empty').hidden = running.length > 0;
    setText($('issues-empty-sub'), rows.length
      ? 'Nothing running right now · ' + queued + ' in the queue'
      : 'Waiting for issues in ' + (h.active_states && h.active_states.length ? h.active_states.join(', ') : 'an active column') +
        ' · next poll within ' + Math.round(h.poll_interval_ms / 1000) + 's');
  }

  // Per-identifier outcome of a control click (Retry, Pause, Resume); a poll rebuilds the rows, so the button state
  // is drawn from here.
  const restartStates = new Map();
  const RESTART_LABELS = { Retry: 'Retry now', Resume: 'Resume now', Pause: 'Pause' };
  // Route, busy label and success label of each control button.
  const CONTROL = {
    Retry: ['retry', 'Restarting…', 'Queued'],
    Resume: ['resume', 'Resuming…', 'Queued'],
    Pause: ['pause', 'Pausing…', 'Paused'],
  };
  const RESTART_DISABLED = 'Controls disabled: set SYMPHONY_ALLOW_REMOTE_CONTROL=true behind an authenticating proxy';
  // From /api/v1/state; false on a non-loopback bind without server.allow_remote_control.
  let retryAllowed = true;
  function restartButton(identifier, verb) {
    if (!retryAllowed) return el('div', RESTART_DISABLED, 'msg muted restart-off');
    const st = restartStates.get(identifier + ' ' + verb);
    const b = el('button', st ? st.label : RESTART_LABELS[verb], 'btn restart' + (st && st.cls ? ' ' + st.cls : ''));
    b.type = 'button';
    b.dataset.identifier = identifier;
    b.dataset.verb = verb;
    b.setAttribute('aria-label', RESTART_LABELS[verb] + ' ' + identifier);
    if (st && st.cls === 'is-busy') b.setAttribute('aria-busy', 'true');
    return b;
  }

  function paintRestart(identifier, verb) {
    const st = restartStates.get(identifier + ' ' + verb);
    for (const b of document.querySelectorAll('button.restart')) {
      if (b.dataset.identifier !== identifier || b.dataset.verb !== verb) continue;
      b.classList.remove('is-busy', 'is-done', 'is-failed');
      if (st && st.cls) b.classList.add(st.cls);
      if (st && st.cls === 'is-busy') b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
      b.textContent = st ? st.label : RESTART_LABELS[b.dataset.verb];
    }
  }

  async function restart(identifier, verb) {
    const key = identifier + ' ' + verb;
    const [action, busy, done] = CONTROL[verb] || CONTROL.Retry;
    const current = restartStates.get(key);
    if (current && current.cls === 'is-busy') return;
    restartStates.set(key, { cls: 'is-busy', label: busy });
    paintRestart(identifier, verb);
    let ok = false;
    let label = RESTART_LABELS[verb] + ' failed';
    try {
      const res = await fetch('/api/v1/' + encodeURIComponent(identifier) + '/' + action, { method: 'POST' });
      let body = null;
      try { body = await res.json(); } catch {}
      ok = res.ok;
      label = ok ? done : (body && body.error && body.error.message) || RESTART_LABELS[verb] + ' failed (' + res.status + ')';
    } catch {}
    restartStates.set(key, { cls: ok ? 'is-done' : 'is-failed', label });
    paintRestart(identifier, verb);
    $('announce').textContent = identifier + ': ' + label;
    setTimeout(load, 500);
    setTimeout(() => { restartStates.delete(key); paintRestart(identifier, verb); }, ok ? 1800 : 5000);
  }

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const b = target ? target.closest('button.restart') : null;
    if (b) restart(b.dataset.identifier, b.dataset.verb);
  });

  // ------------------------------------------------------------------ activity stream

  const MAX_ACTIVITY = 200;
  const activity = [];
  const seenActivity = new Set();
  let activityDirty = true;
  let previous = null;
  let previousRetries = null;
  let previousBlocked = null;
  const detailFetchedAt = new Map();

  function pushActivity(at, issue, text, tone, key) {
    if (!at) return;
    if (key) { if (seenActivity.has(key)) return; seenActivity.add(key); }
    activity.push({ at, ms: Date.parse(at), issue, text, tone, rendered: false });
    activityDirty = true;
  }
  const eventText = (event, message) => event + (message ? ' · ' + trunc(message, 160) : '');
  const eventKey = (issue, at, event) => 'ev|' + issue + '|' + at + '|' + event;

  function diffSnapshots(state) {
    const now = state.generated_at;
    const current = new Map(state.running.map((r) => [r.issue_id, r]));
    for (const r of state.running) {
      const p = previous ? previous.get(r.issue_id) : undefined;
      const id = r.issue_identifier;
      if (!p) pushActivity(r.started_at, id, 'started · ' + (r.state || '') + (r.role ? ' · ' + r.role : ''), 'green', 'start|' + id + '|' + r.started_at);
      else {
        if (p.phase !== r.phase) pushActivity(now, id, 'phase → ' + r.phase, phaseTone(r.phase));
        if (r.model && p.model !== r.model) pushActivity(now, id, 'model → ' + r.model, 'cyan');
        if (p.state !== r.state) pushActivity(now, id, 'column → ' + r.state, 'cyan');
        if (!p.stopping && r.stopping) pushActivity(now, id, 'stopping · ' + r.stopping, 'amber');
      }
      if (r.last_event && r.last_event_at) {
        pushActivity(r.last_event_at, id, eventText(r.last_event, r.last_message), null, eventKey(id, r.last_event_at, r.last_event));
      }
    }
    if (previous) {
      for (const p of previous.values()) {
        if (!current.has(p.issue_id)) { pushActivity(now, p.issue_identifier, 'session ended after ' + fmtDuration(p.seconds_running), 'gray'); scheduleHistory(1500); }
      }
    }
    const retries = new Set();
    for (const r of state.retrying) {
      const waiting = !!(r.limit && r.limit.waiting);
      const key = r.issue_id + '|' + r.attempt + '|' + r.kind + '|' + waiting;
      retries.add(key);
      if (previousRetries && !previousRetries.has(key)) {
        if (r.kind === 'session_limit' && r.limit) {
          pushActivity(now, r.issue_identifier, r.limit.scope === 'model' && r.limit.model
            ? 'model ' + r.limit.model + ' on hold · retry at ' + fmtClock(r.due_at)
            : waiting
            ? 'waiting for the session limit · retry at ' + fmtClock(r.due_at)
            : 'session limit: retry ' + r.limit.hits + ' of ' + r.limit.max_retries + ' queued', 'amber');
        } else {
          pushActivity(now, r.issue_identifier,
            (r.kind === 'continuation' ? 'continuation queued' : 'retry ' + pad2(r.attempt) + ' queued') + ' · in ' + fmtDuration(r.due_in_ms / 1000) +
            (r.error ? ' · ' + trunc(r.error, 120) : ''), r.kind === 'continuation' ? 'cyan' : 'amber');
        }
      }
    }
    const blocked = new Map((state.blocked || []).map((b) => [b.issue_id, b]));
    if (previousBlocked) {
      for (const b of blocked.values()) {
        if (!previousBlocked.has(b.issue_id)) pushActivity(now, b.issue_identifier, 'blocked · ' + b.reason, 'red');
      }
      for (const b of previousBlocked.values()) {
        if (!blocked.has(b.issue_id)) pushActivity(now, b.issue_identifier, 'unblocked', 'green');
      }
    }
    previous = current;
    previousRetries = retries;
    previousBlocked = blocked;
  }

  // The per-issue endpoint keeps the recent agent events with a message; fetch it when an agent reported something new.
  function fetchDetails(state) {
    for (const r of state.running) {
      if (!r.last_event_at || detailFetchedAt.get(r.issue_id) === r.last_event_at) continue;
      detailFetchedAt.set(r.issue_id, r.last_event_at);
      fetch('/api/v1/' + encodeURIComponent(r.issue_identifier), { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((detail) => {
          if (!detail) return;
          for (const e of detail.recent_events || []) pushActivity(e.at, r.issue_identifier, eventText(e.event, e.message), null, eventKey(r.issue_identifier, e.at, e.event));
          renderActivity();
        })
        .catch(() => {});
    }
    for (const id of detailFetchedAt.keys()) if (!state.running.some((r) => r.issue_id === id)) detailFetchedAt.delete(id);
  }

  const HISTORY_TONE = { ok: 'green', info: 'cyan', warn: 'amber', error: 'red' };
  function mergeHistory(entries) {
    for (const e of entries.slice(0, 40)) {
      if (e.event === 'run_started' || e.event === 'model_usage') continue; // starts come live from the snapshots
      pushActivity(e.ts, e.issue || e.repo || '—', e.event.replace(/_/g, ' ') + ' · ' + describeLogEntry(e), HISTORY_TONE[logSeverity(e)], 'log|' + e.ts + '|' + e.event + '|' + e.issue);
    }
    renderActivity();
  }

  function renderActivity() {
    if (!activityDirty) return;
    activityDirty = false;
    activity.sort((a, b) => b.ms - a.ms);
    if (activity.length > MAX_ACTIVITY) activity.length = MAX_ACTIVITY;
    const feed = $('feed');
    if (!activity.length) {
      feed.replaceChildren(el('li', '$ awaiting agent events …', 'prompt'));
      return;
    }
    feed.replaceChildren(...activity.slice(0, 60).map((a, i) => {
      const li = el('li', null, (i === 0 ? 'latest' : '') + (a.rendered ? '' : ' fresh'));
      a.rendered = true;
      const who = el('span', shortId(a.issue), 'who'); who.title = a.issue;
      li.append(el('span', fmtClock(a.at), 't'), who, el('span', a.text, 'what' + (a.tone ? ' tone-' + a.tone : '')));
      return li;
    }));
  }

  // ------------------------------------------------------------------ logs drawer

  const drawer = $('logs-drawer');
  const scrim = $('logs-scrim');
  const opener = $('logs-open');
  const logsState = { repo: '', sev: '', q: '', data: null, timer: null, lastFocus: null };

  function openLogs() {
    logsState.lastFocus = document.activeElement;
    drawer.classList.add('open');
    scrim.classList.add('open');
    opener.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
    setTimeout(() => $('logs-q').focus(), 60);
    loadLogs();
    clearInterval(logsState.timer);
    logsState.timer = setInterval(loadLogs, 10000);
  }
  function closeLogs() {
    drawer.classList.remove('open');
    scrim.classList.remove('open');
    opener.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    clearInterval(logsState.timer);
    if (logsState.lastFocus && logsState.lastFocus.focus) logsState.lastFocus.focus();
  }
  const isOpen = () => drawer.classList.contains('open');

  async function loadLogs() {
    const list = $('logs-list');
    try {
      const res = await fetch('/api/v1/history' + (logsState.repo ? '?repo=' + encodeURIComponent(logsState.repo) : ''), { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ? data.error.message : 'HTTP ' + res.status);
      logsState.data = data;
      if (!logsState.repo) mergeHistory(data.recent);
      const select = $('logs-repo');
      const options = [['', 'All repositories'], ...data.repositories_available.map((r) => [r.repo, r.repo])];
      select.replaceChildren(...options.map(([value, label]) => { const o = el('option', label); o.value = value; return o; }));
      select.value = logsState.repo;
      const raw = $('logs-raw');
      raw.hidden = !logsState.repo;
      raw.href = '/api/v1/history/raw?repo=' + encodeURIComponent(logsState.repo);
      setText($('logs-meta'), data.history_dir + ' · updated ' + fmtClock(data.generated_at));
      renderLogs();
    } catch (error) {
      logsState.data = null;
      list.replaceChildren(el('li', 'Cannot load the logs: ' + error.message, 'note'));
      setText($('logs-count'), '');
    }
  }

  function renderLogs() {
    const data = logsState.data;
    if (!data) return;
    const q = logsState.q.trim().toLowerCase();
    const rows = data.recent.filter((e) => {
      if (logsState.sev && logSeverity(e) !== logsState.sev) return false;
      if (!q) return true;
      return [e.issue, e.repo, e.event, e.title, describeLogEntry(e)].some((v) => v && String(v).toLowerCase().includes(q));
    });
    setText($('logs-count'), rows.length + ' of ' + data.recent.length + ' entries');
    const list = $('logs-list');
    if (!rows.length) { list.replaceChildren(el('li', data.recent.length ? 'No entries match the filter.' : 'The log is empty.', 'note')); return; }
    list.replaceChildren(...rows.map((e) => {
      const sev = logSeverity(e);
      const li = el('li', null, 'tone-' + SEVERITY_TONE[sev]);
      const body = el('div', null, 'body');
      const src = el('div', null, 'src');
      src.append(el('span', (logsState.repo ? '' : (e.repo || '') + ' ') + (e.issue ? splitId(e.issue).num : '—') + ' '), el('span', e.event.replace(/_/g, ' '), 'ev'));
      body.append(src, el('div', describeLogEntry(e), 'd'));
      li.append(el('time', fmtStamp(e.ts), 't'), el('span', sev === 'error' ? 'ERR' : sev.toUpperCase(), 'sev'), body);
      return li;
    }));
  }

  opener.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let "open in new tab" through
    e.preventDefault();
    openLogs();
  });
  $('logs-close').addEventListener('click', closeLogs);
  scrim.addEventListener('click', closeLogs);
  $('logs-reload').addEventListener('click', loadLogs);
  $('logs-repo').addEventListener('change', (e) => { logsState.repo = e.target.value; loadLogs(); });
  $('logs-q').addEventListener('input', (e) => { logsState.q = e.target.value; renderLogs(); });
  $('logs-sev').addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    logsState.sev = button.dataset.sev;
    for (const b of $('logs-sev').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === button));
    renderLogs();
  });
  document.addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    if (e.key === 'Escape') { e.preventDefault(); closeLogs(); return; }
    if (e.key !== 'Tab') return;
    const focusable = [...drawer.querySelectorAll('a[href], button, select, input')].filter((n) => !n.hidden && n.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!drawer.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  });

  // ------------------------------------------------------------------ tool calls (last 30 minutes)

  let activityData = null;
  async function loadToolActivity() {
    try {
      const res = await fetch('/api/v1/activity?minutes=30', { cache: 'no-store' });
      if (res.ok) {
        activityData = await res.json();
        renderActivityStrip($('tool-activity-strip'), activityData);
        renderActivityLegend($('tool-activity-legend'), actRoles(lastState || {}, activityData.events || []));
      }
    } catch {}
  }

  // ------------------------------------------------------------------ system cards
  // Host metrics from /api/v1/system (own 10 s interval, independent of the 2 s state polling) plus agent slots and the
  // tracker API budget from the last state. Slots and GitHub API have no server-side history: their sparklines come
  // from a client-side ring buffer filled every 10 s, so they grow from the moment the page was opened.

  let systemData = null;
  let lastState = null;
  const TREND_MAX = 360;
  const trend = { slots: [], github: [] };

  function pushTrend(key, value) {
    trend[key].push(typeof value === 'number' && Number.isFinite(value) ? value : null);
    while (trend[key].length > TREND_MAX) trend[key].shift();
  }

  function fmtGb(bytes) {
    return (bytes / 1073741824).toFixed(1);
  }

  function pct(used, total) {
    return typeof used === 'number' && typeof total === 'number' && total > 0 ? (used / total) * 100 : null;
  }

  const SYS_COLORS = ${JSON.stringify(SYSTEM_COLORS)};
  const GB = 1073741824;

  /** German thousands separator by hand (toLocaleString depends on the browser locale). */
  function fmtDe(n) {
    const digits = String(Math.round(n));
    let out = '';
    for (let i = 0; i < digits.length; i++) {
      if (i > 0 && (digits.length - i) % 3 === 0 && digits[i - 1] !== '-') out += '.';
      out += digits[i];
    }
    return out;
  }

  /** Process uptime: from one day "N d M h", else the usual duration. */
  function sysUptime(sec) {
    if (typeof sec !== 'number' || !Number.isFinite(sec)) return '—';
    return sec >= 86400 ? Math.floor(sec / 86400) + ' d ' + Math.floor((sec % 86400) / 3600) + ' h' : fmtDuration(sec);
  }

  /**
   * One card: label with traffic-light dot, value + unit, 5 px bar in the card colour (amber from 80 %, red from 95 %),
   * sparkline and a line of text. A null value shows "—" and nothing else.
   */
  function systemCard(o) {
    const { label, value, unit, pct: p, color, history, sub, title } = o;
    const empty = value === null || value === undefined;
    const tone = empty ? null : trafficTone(p);
    const box = el('article', null, 'syscard gi');
    if (title) box.setAttribute('title', title);
    const head = el('div', null, 'syscard-head');
    const dot = el('span', null, 'ui-dot syscard-dot');
    dot.setAttribute('aria-hidden', 'true');
    if (tone) dot.style.background = UI_TRAFFIC[tone];
    head.append(el('span', label, 'syscard-label'), dot);
    const val = el('div', null, 'syscard-value');
    val.append(el('span', empty ? '—' : value, 'mono'));
    if (!empty && unit) val.append(el('span', unit, 'syscard-unit'));
    box.append(head, val);
    if (empty) return box;
    if (tone) box.append(bar(p, { height: 5, color: tone === 'green' ? color : UI_TRAFFIC[tone] }));
    const spark = sparkline(history, color);
    if (spark) box.append(spark);
    if (sub) box.append(el('div', sub, 'syscard-sub'));
    return box;
  }

  function diskHistory(hist, name) {
    return hist.map((s) => {
      const d = (Array.isArray(s.disks) ? s.disks : []).find((v) => v.name === name);
      return d ? pct(d.used_bytes, d.total_bytes) : null;
    });
  }

  function diskCard(label, d, hist, sub) {
    const p = d ? pct(d.used_bytes, d.total_bytes) : null;
    return systemCard({
      label, value: p === null ? null : String(Math.round(d.used_bytes / GB)), unit: p === null ? null : '/ ' + Math.round(d.total_bytes / GB) + ' GB',
      pct: p, color: SYS_COLORS.disk, history: d ? diskHistory(hist, d.name) : [], sub: sub || (p === null ? null : Math.round(p) + ' % belegt'),
    });
  }

  /** Cards in fixed order: CPU, RAM, Disk · State, [Disk · Workspaces], Load, Agent-Slots, GitHub API, [GPU]. */
  function systemCards(system, state, trend) {
    const cur = system && system.current ? system.current : null;
    const hist = system && Array.isArray(system.history) ? system.history : [];
    const cards = [];
    const h = state && state.health ? state.health : null;
    const counts = state && state.counts ? state.counts : null;
    const cores = system && typeof system.cpu_count === 'number' && system.cpu_count > 0 ? system.cpu_count : null;

    const cpu = cur && typeof cur.cpu_percent === 'number' ? cur.cpu_percent : null;
    cards.push(systemCard({
      label: 'CPU', value: cpu === null ? null : String(Math.round(cpu)), unit: '%', pct: cpu, color: SYS_COLORS.cpu, history: hist.map((s) => s.cpu_percent),
      sub: (cores ? cores + ' Kerne' : '') + (cores && counts ? ' · ' : '') + (counts ? counts.running + ' Agents aktiv' : ''),
    }));

    const mem = cur && cur.memory ? cur.memory : null;
    const memPct = mem ? pct(mem.used_bytes, mem.total_bytes) : null;
    cards.push(systemCard({
      label: 'RAM', value: memPct === null ? null : fmtGb(mem.used_bytes), unit: memPct === null ? null : '/ ' + fmtGb(mem.total_bytes) + ' GB', pct: memPct,
      color: SYS_COLORS.ram, history: hist.map((s) => (s.memory ? pct(s.memory.used_bytes, s.memory.total_bytes) : null)),
      sub: memPct === null ? null : Math.round(memPct) + ' % belegt',
    }));

    const disks = cur && Array.isArray(cur.disks) ? cur.disks : [];
    const stateDisk = disks.find((d) => d.name === 'state') || disks[0] || null;
    const usage = system && system.usage ? system.usage : null;
    const usageParts = [];
    if (usage && typeof usage.workspaces_bytes === 'number') usageParts.push('Workspaces ' + Math.round(usage.workspaces_bytes / GB) + ' GB');
    if (usage && typeof usage.transcripts_bytes === 'number') usageParts.push('Transkripte ' + Math.round(usage.transcripts_bytes / GB) + ' GB');
    cards.push(diskCard('Disk · State', stateDisk, hist, usageParts.join(' · ')));
    const other = disks.find((d) => d !== stateDisk && stateDisk && (d.device !== null && d.device !== undefined && stateDisk.device !== null && stateDisk.device !== undefined
      ? d.device !== stateDisk.device : d.total_bytes !== stateDisk.total_bytes));
    if (other) cards.push(diskCard('Disk · Workspaces', other, hist));

    const load = cur && cur.load ? cur.load : null;
    const loadPct = load && cores ? (load.one / cores) * 100 : null;
    cards.push(systemCard({
      label: 'Load', value: load ? load.one.toFixed(2) : null, unit: '1 min', pct: loadPct, color: SYS_COLORS.load, history: hist.map((s) => (s.load ? s.load.one : null)),
      sub: load ? '5 min ' + load.five.toFixed(2) + ' · 15 min ' + load.fifteen.toFixed(2) : null,
    }));

    const max = h && typeof h.max_concurrent_agents === 'number' ? h.max_concurrent_agents : null;
    const slotsOk = counts && max !== null;
    cards.push(systemCard({
      label: 'Agent-Slots', value: slotsOk ? String(counts.running) : null, unit: '/ ' + max, pct: slotsOk && max > 0 ? (counts.running / max) * 100 : null,
      color: SYS_COLORS.slots, history: trend.slots,
      sub: slotsOk ? Math.max(0, max - counts.running) + ' frei · ' + (counts.queued ?? 0) + ' in der Queue' : null,
    }));

    const api = h && h.tracker_api ? h.tracker_api : null;
    cards.push(systemCard({
      label: 'GitHub API', value: api ? fmtDe(api.remaining) : null, unit: api ? '/ ' + fmtDe(api.limit) : null, pct: api && api.limit > 0 ? (1 - api.remaining / api.limit) * 100 : null,
      color: SYS_COLORS.github, history: trend.github,
      sub: h ? (h.last_tick_at ? 'Poll vor ' + fmtDuration((Date.now() - Date.parse(h.last_tick_at)) / 1000) + ' · ' + (h.last_tracker_error ? 'Fehler' : 'ok') : 'noch kein Poll') : null,
      title: api && api.reset_at ? 'Restbudget, zurückgesetzt um ' + fmtTime(api.reset_at) : null,
    }));

    if (system && system.gpu) {
      const g = system.gpu;
      const util = typeof g.utilization_percent === 'number' ? g.utilization_percent : null;
      const parts = [];
      if (typeof g.memory_used_mib === 'number' && typeof g.memory_total_mib === 'number') parts.push(g.memory_used_mib + ' / ' + g.memory_total_mib + ' MiB');
      if (typeof g.temperature_c === 'number') parts.push(g.temperature_c + ' °C');
      cards.push(systemCard({
        label: 'GPU', value: util === null ? null : String(Math.round(util)), unit: '%', pct: util, color: SYS_COLORS.cpu,
        history: hist.map((s) => (s.gpu ? s.gpu.utilization_percent : null)), sub: parts.join(' · ') || null,
      }));
    }
    return cards;
  }

  function renderSystemHost() {
    const host = systemData && systemData.host ? systemData.host : null;
    const node = $('system-host');
    if (node) node.textContent = host ? 'Host ' + host.hostname + ' · Container ' + (host.container || '—') + ' · seit ' + sysUptime(host.uptime_seconds) : '';
  }

  function renderSystemCards() {
    renderSystemHost();
    patchChildren($('system-cards'), systemCards(systemData, lastState, trend));
  }

  async function loadSystem() {
    try {
      const res = await fetch('/api/v1/system', { cache: 'no-store' });
      systemData = res.ok ? await res.json() : null;
    } catch {
      systemData = null;
    }
    const h = lastState && lastState.health;
    const api = h && h.tracker_api;
    pushTrend('slots', lastState && h && h.max_concurrent_agents > 0 ? (lastState.counts.running / h.max_concurrent_agents) * 100 : null);
    pushTrend('github', api && api.limit > 0 ? (1 - api.remaining / api.limit) * 100 : null);
    renderSystemCards();
  }

  // ------------------------------------------------------------------ budget
  // The subscription windows of GET /api/v1/budget (loaded by the shell, see onBudget below) plus the running
  // sessions above 70 % context from the last state.

  let budgetData = null;
  let budgetAnswer = null;
  const BUDGET_NO_LIMIT = '#6b7684';

  function mono(text) { return el('span', text, 'mono'); }

  function budgetWindow(w, title, label) {
    const box = el('div', null, 'budget-window');
    box.append(el('h3', title));
    const pct = budgetPercent(w);
    const value = el('div', null, 'budget-value');
    const meta = el('div', null, 'budget-meta');
    let barNode;
    if (pct === null) {
      value.append(mono(fmtCompact(w.used_tokens) + ' Tokens'));
      barNode = bar(100, { height: 8, color: BUDGET_NO_LIMIT });
      barNode.removeAttribute('aria-valuenow');
      barNode.setAttribute('aria-valuetext', fmtCompact(w.used_tokens) + ' Tokens, Grenze unbekannt');
    } else {
      const color = w.alert ? UI_TRAFFIC.red : UI_TRAFFIC[trafficTone(pct)];
      const of = el('span', null, 'of');
      of.append(mono(fmtCompact(w.used_tokens) + ' / ' + fmtCompact(w.forecast.limit_tokens)), el('span', ' Tokens'));
      value.append(mono(Math.round(pct) + ' %'), of);
      barNode = bar(pct, { height: 8, color, forecastPct: budgetForecastPercent(w, Date.now()) });
    }
    barNode.setAttribute('aria-label', label);
    const reset = Date.parse(w.resets_at || '');
    meta.append(el('span', Number.isFinite(reset) ? 'Reset in ' + fmtDuration((reset - Date.now()) / 1000) : 'Reset unbekannt'));
    meta.append(el('span', 'Burn-Rate ' + fmtInt(Math.round(w.burn_rate_per_min || 0)) + ' Tokens/min'));
    if (w.forecast && w.forecast.eta) meta.append(el('span', 'ETA ' + fmtStamp(w.forecast.eta)));
    box.append(value, barNode, meta);
    if (pct === null) box.append(el('p', 'Noch kein Limit-Treffer bekannt', 'budget-hint'));
    return box;
  }

  function budgetRoles(byRole) {
    const wrap = el('div', null, 'budget-roles-wrap');
    wrap.append(el('h3', 'Tokens je Rolle (5 h)', 'budget-roles-title'));
    const entries = Object.entries(byRole || {}).filter(([, n]) => typeof n === 'number' && n > 0).sort((a, b) => b[1] - a[1]);
    if (!entries.length) { wrap.append(el('p', 'Keine Tokens im 5-h-Fenster', 'budget-hint')); return wrap; }
    const list = el('ul', null, 'budget-roles');
    for (const [role, tokens] of entries) {
      const li = el('li');
      const name = uiOwn(UI_ROLE_NAMES, role) || role.charAt(0).toUpperCase() + role.slice(1);
      li.append(uiDot(uiOwn(UI_ROLE_COLORS, role) || UI_ROLE_COLORS.symphony), el('span', name), mono(fmtCompact(tokens)));
      list.append(li);
    }
    wrap.append(list);
    return wrap;
  }

  /** The hint for running sessions above 70 % context; null when there are none. */
  function budgetContext(state) {
    const hot = ((state && state.running) || []).filter((r) => r.context && typeof r.context.percent === 'number' && r.context.percent > 70);
    if (!hot.length) return null;
    const box = el('p', null, 'budget-context');
    const head = el('span');
    head.append(mono(String(hot.length)), el('span', (hot.length === 1 ? ' Session' : ' Sessions') + ' über 70 % Context'));
    box.append(head);
    for (const r of hot) {
      const item = el('span');
      item.append(link(r.issue_identifier, '/issue?id=' + encodeURIComponent(r.issue_identifier)), el('span', ' '), mono('(' + Math.round(r.context.percent) + ' %)'));
      box.append(item);
    }
    return box;
  }

  function budgetSection(report, state) {
    const windows = el('div', null, 'budget-windows');
    windows.append(budgetWindow(report.five_hour, '5 Stunden', '5-Stunden-Fenster'), budgetWindow(report.seven_day, '7 Tage', '7-Tage-Fenster'));
    const nodes = [windows, budgetRoles(report.five_hour.by_role)];
    const context = budgetContext(state);
    if (context) nodes.push(context);
    return nodes;
  }

  function renderBudget() {
    $('budget').hidden = !budgetData;
    if (budgetData) patchChildren($('budget-body'), budgetSection(budgetData, lastState));
  }

  // ------------------------------------------------------------------ polling

  let historyTimer = null;
  async function loadHistory() {
    try {
      const res = await fetch('/api/v1/history', { cache: 'no-store' });
      if (res.ok) mergeHistory((await res.json()).recent);
    } catch {}
  }
  function scheduleHistory(delay) {
    clearTimeout(historyTimer);
    historyTimer = setTimeout(loadHistory, delay);
  }

  function render(state) {
    lastState = state;
    renderSystemCards();
    renderBudget();
    const h = state.health;
    const list = alerts(state, budgetAnswer);
    renderAlerts(list, $('alerts-list'), $('alerts-count'));
    setLive(true);
    renderHead(state, Date.now(), true);
    renderActivityLegend($('tool-activity-legend'), actRoles(state, activityData ? activityData.events : []));
    renderRepositories(h);
    const gate = h.dispatch_gate;
    $('dispatch-gate').hidden = !gate;
    setText($('dispatch-gate-text'), gate
      ? 'Dispatch paused until ' + fmtStamp(gate.until) + ' · session limit (' + gate.window + ') · started by ' + gate.issue_identifier
      : '');

    const t = state.agent_totals;
    const running = state.counts.running;
    const queue = state.queue || [];
    const next = queue.filter((item) => item.status === 'next').length;
    const waiting = queue.filter((item) => item.status === 'waiting').length;
    const paused = queue.filter((item) => item.status === 'paused').length;
    const blocked = state.counts.blocked ?? 0;
    tiles('stats', [
      ['Running', pad2(running), 'active agents', { tone: running ? 'green' : 'gray', hero: true, pulse: running > 0, of: pad2(h.max_concurrent_agents) }],
      ['Up next', pad2(next), 'in start order', { tone: next ? 'cyan' : 'gray' }],
      ['Waiting', pad2(waiting + paused), waiting + ' waiting · ' + paused + ' paused', { tone: waiting + paused ? 'amber' : 'gray' }],
      ['Blocked', pad2(blocked), 'need a human or a blocker', { tone: blocked ? 'red' : 'gray' }],
      ['Tokens', fmtCompact(t.total_tokens), 'since start', { tone: 'cyan' }],
      ['Est. cost', fmtUsd(t.cost_usd), 'since start', { tone: 'cyan' }],
      ['Agent time', fmtDuration(t.seconds_running), 'since start', { tone: 'cyan' }],
    ]);

    retryAllowed = !state.controls || state.controls.retry !== false;
    setText($('teams-count'), pad2(renderTeams($('teams'), state, Date.now())));
    renderIssues(state);
    diffSnapshots(state);
    fetchDetails(state);
    renderActivity();
  }

  let loading = false, reloadAgain = false;
  async function load() {
    if (loading) { reloadAgain = true; return; }
    loading = true;
    const progress = $('progress');
    progress.classList.remove('tick');
    void progress.offsetWidth;
    progress.classList.add('tick');
    try {
      const res = await fetch('/api/v1/state', { cache: 'no-store' });
      render(await res.json());
    } catch (error) {
      lastState = null;
      renderSystemCards();
      renderBudget();
      setLive(false);
      renderHead(null, Date.now(), false);
      renderAlerts([{ kind: 'attention', at: new Date().toISOString(), title: 'Orchestrator nicht erreichbar', text: error.message, href: '/stats' }], $('alerts-list'), $('alerts-count'));
    }
    loading = false;
    if (reloadAgain) { reloadAgain = false; load(); }
  }

  shellHooks.afterPoll = load;

  renderActivity();
  onBudget((report, raw) => {
    budgetData = report;
    budgetAnswer = raw;
    renderBudget();
    if (lastState) renderAlerts(alerts(lastState, budgetAnswer), $('alerts-list'), $('alerts-count'));
  });
  load();
  loadHistory();
  loadToolActivity();
  brainBind($('brain-q'));
  loadBrain();
  loadSystem();
  live(load, pollEvery(load, 2000));
  setInterval(loadSystem, 10000);
  setInterval(loadHistory, 30000);
  setInterval(loadToolActivity, 30000);
  setInterval(loadBrain, 30000);
  setInterval(() => {
    tickTeams(Date.now());
    if (lastState) renderHead(lastState, Date.now(), true);
  }, 1000);
  // Tests load the page in a fake DOM and render a fixture through window.__render.
  if (window.__SYMPHONY_TEST__) window.__render = render;
})();
`,
});
