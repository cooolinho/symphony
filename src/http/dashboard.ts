import { PIPELINE_CSS, PIPELINE_JS } from './pipeline.ts';
import { TEAMS_CSS, TEAMS_JS } from './overview-teams.ts';
import { page } from './ui/layout.ts';

const DASHBOARD_CSS = `
  /* Dispatch gate: new dispatches wait for an account-wide session limit (a notice, not an error). */
  .dispatch-gate { border-color: var(--amber-line); background: linear-gradient(180deg, var(--amber-dim), rgba(11, 17, 21, .8));
    display: flex; align-items: center; gap: 10px; padding: 12px 16px; color: var(--amber); font: 12.5px/1.6 var(--mono); overflow-wrap: anywhere; }
  /* Model holds: one model hit its own limit; its issues wait, the other models keep running. */
  .model-holds { align-items: flex-start; }
  .model-holds ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
  /* Pause / Resume per model family in use. */
  .model-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 10px 16px; font: 12px var(--mono); color: var(--muted); }
  .model-controls .model-control-item { display: inline-flex; align-items: center; gap: 8px; }
  .model-controls .model-control-item b { color: var(--text); font-weight: 600; }
  .card-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  /* Matrix rain: a few faint glyph columns behind everything, disabled for small screens and reduced motion. */
  .rain { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden;
    mask-image: linear-gradient(to bottom, transparent, #000 15%, #000 55%, transparent 90%); }
  .rain span { position: absolute; top: 0; writing-mode: vertical-rl; text-orientation: upright; white-space: nowrap;
    font: 12px/1 var(--mono); letter-spacing: .35em; color: rgba(61, 220, 132, .06); transform: translateY(-110%);
    animation: fall linear infinite; }
  @keyframes fall { to { transform: translateY(110vh); } }
  @media (max-width: 640px), (prefers-reduced-motion: reduce) { .rain { display: none; } }

  /* Page head: system info and the page actions (poll, logs drawer). */
  .page-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 24px; }
  .sysinfo { display: flex; flex-wrap: wrap; gap: 6px 22px; margin: 0; align-items: center; }
  .sysinfo div { display: flex; flex-direction: column; min-width: 0; }
  .sysinfo dt { font: 500 10px var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
  .sysinfo dd { margin: 1px 0 0; font: 500 12.5px var(--mono); color: var(--text); white-space: nowrap; }

  /* Running agents */
  .agents-section { border-color: var(--line-2); }
  .slots { display: flex; align-items: center; gap: 10px; font: 500 11px var(--mono); color: var(--muted); letter-spacing: .08em; }
  .slots-bar { display: flex; gap: 3px; }
  .slots-bar i { width: 14px; height: 6px; border-radius: 2px; background: var(--line-2); transition: background .3s var(--ease), box-shadow .3s var(--ease); }
  .slots-bar i.on { background: var(--green); box-shadow: 0 0 8px -2px var(--green); }
  /* A slot kept free for a role (agent.reserved_slots_by_role) that runs fewer sessions than reserved. */
  .slots-bar i.reserved { background: transparent; box-shadow: inset 0 0 0 1px var(--cyan-line); }
  /* An extra slot of a session started with Start now, beyond the limit. */
  .slots-bar i.forced { background: var(--amber); box-shadow: 0 0 8px -2px var(--amber); }
  /* Agent slots set on the dashboard: − / value / + for the total, each active column and each role's reserved slots. */
  .slot-settings { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; margin: 0 0 14px; font: 12px var(--mono); color: var(--muted); }
  .slot-item { display: inline-flex; align-items: center; gap: 6px; }
  .slot-item b { min-width: 2ch; color: var(--text); font-weight: 600; text-align: center; }
  .slot-control { justify-content: center; min-width: 28px; padding: 2px 6px; }
  .slot-control:disabled { opacity: .4; cursor: default; }
  .slot-override, .slot-note { color: var(--amber); }
  .slot-error { color: var(--red); }
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

  /* Lower area: activity stream next to the queues */
  .lower { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; }
  @media (min-width: 1100px) { .lower { grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr); } }
  .side { display: grid; gap: 20px; align-content: start; min-width: 0; }
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

  /* Issue cards: the pipeline strip and the status box of waiting issues */
  .agent .pipe { margin: -2px 0; }
  .agent [hidden] { display: none; }
  /* Dispatch plan: Up next is numbered in start order; every waiting card names its reason. */
  .queue-section[hidden] { display: none; }
  .agents.compact { grid-template-columns: repeat(auto-fill, minmax(min(320px, 100%), 1fr)); }
  .chip.pos { color: var(--text); border-color: var(--cyan-line); background: var(--cyan-dim); font-weight: 600; }
  .chip.reason { white-space: normal; overflow-wrap: anywhere; color: var(--tone, var(--text-2));
    border-color: var(--tone-line, var(--line-2)); background: var(--tone-dim, var(--panel-2)); }

  /* Blocked issues (a collapsed details panel) and other queue-style lists */
  details.blocked-section summary { list-style: none; cursor: pointer; }
  details.blocked-section summary::-webkit-details-marker { display: none; }
  details.blocked-section summary .chev { display: inline-block; font-style: normal; transition: transform .2s var(--ease); color: var(--muted); }
  details.blocked-section[open] summary .chev { transform: rotate(90deg); }
  details.blocked-section .section-head { margin-bottom: 0; }
  details.blocked-section[open] .section-head { margin-bottom: 14px; }
  .queue { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  .qitem { display: grid; gap: 6px; padding: 10px 12px; border: 1px solid var(--line); border-left: 2px solid var(--tone); border-radius: var(--radius-sm);
    background: rgba(0, 0, 0, .22); transition: border-color .2s var(--ease); }
  .qitem:hover { border-color: var(--tone-line); border-left-color: var(--tone); }
  .qrow { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 10px; }
  .qrow .id { font: 600 13px var(--mono); overflow-wrap: anywhere; }
  .qmeta { display: flex; flex-wrap: wrap; gap: 4px 14px; font: 11.5px var(--mono); color: var(--muted); }
  .qmeta b { color: var(--text); font-weight: 600; }
  .qitem .msg { font-size: 12.5px; }
  .qitem button.restart { justify-self: start; }
  .clear { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
  .clear .muted { font-size: 12.5px; }

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
    .sysinfo { gap: 6px 16px; }
  }
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
  styles: PIPELINE_CSS + TEAMS_CSS + DASHBOARD_CSS,
  body: `
  <div class="page-head">
    <dl class="sysinfo" aria-live="polite">
      <div><dt>System</dt><dd id="sys-status"><span class="badge tone-gray"><span class="dot"></span><span>Connecting</span></span></dd></div>
      <div><dt>Workflow</dt><dd id="sys-workflow">—</dd></div>
      <div><dt>Polling</dt><dd id="sys-interval">—</dd></div>
      <div><dt>Last poll</dt><dd id="sys-lastpoll">—</dd></div>
    </dl>
    <div class="actions">
      <a class="btn" id="logs-open" href="/stats" aria-controls="logs-drawer" aria-expanded="false">
        <svg class="btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h6"/></svg>Logs</a>
      <button class="btn btn-primary" id="refresh" type="button">
        <svg class="btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg><span id="refresh-label">Poll now</span></button>
    </div>
  </div>
  <section id="repositories" class="repos" aria-label="Repositories" hidden><span class="repos-label">Repositories</span><div class="repo-list" id="repo-list"></div></section>
  <section id="problems" class="problems" role="alert" hidden>
    <h2><span class="dot tone-red"></span>Needs attention</h2>
    <ul id="problem-list"></ul>
  </section>
  <section id="dispatch-gate" class="dispatch-gate" role="status" hidden>
    <span class="dot tone-amber"></span><span id="dispatch-gate-text"></span>
  </section>
  <section id="model-holds" class="dispatch-gate model-holds" role="status" hidden>
    <span class="dot tone-amber"></span><ul id="model-hold-list"></ul>
  </section>
  <section id="model-controls" class="panel model-controls" aria-label="Models" hidden></section>

  <div class="stats" id="stats" aria-label="Metrics"></div>

  <section class="agents-section teams-section" id="teams-section" aria-labelledby="teams-title">
    <div class="section-head"><h2 id="teams-title">Teams <span class="count" id="teams-count"></span></h2></div>
    <div class="team-list" id="teams"></div>
  </section>

  <section class="agents-section" id="running-section" aria-labelledby="running-title">
    <div class="section-head">
      <h2 id="running-title">Running <span class="count" id="running-count"></span></h2>
      <div class="slots" id="slots" aria-hidden="true"></div>
    </div>
    <div class="slot-settings" id="slot-settings" role="group" aria-label="Agent slots" hidden></div>
    <div class="agents" id="running"></div>
    <div class="agents-empty" id="issues-empty" hidden>
      <span class="badge tone-gray"><span class="dot"></span><span>Idle</span></span>
      <div><div class="big">No agents running<span class="cursor" aria-hidden="true"></span></div>
        <div class="muted" id="issues-empty-sub">Waiting for issues in an active column.</div></div>
    </div>
  </section>
  <section class="agents-section queue-section" id="next-section" aria-labelledby="next-title" hidden>
    <div class="section-head">
      <h2 id="next-title">Up next <span class="count" id="next-count"></span></h2>
      <span class="meta" id="next-meta"></span>
    </div>
    <div class="agents compact" id="next"></div>
  </section>
  <section class="agents-section queue-section" id="waiting-section" aria-labelledby="waiting-title" hidden>
    <div class="section-head">
      <h2 id="waiting-title">Waiting <span class="count" id="waiting-count"></span></h2>
      <span class="meta">backoff, session limits and model holds · soonest first</span>
    </div>
    <div class="agents compact" id="waiting"></div>
  </section>
  <section class="agents-section queue-section" id="paused-section" aria-labelledby="paused-title" hidden>
    <div class="section-head">
      <h2 id="paused-title">Paused <span class="count" id="paused-count"></span></h2>
      <span class="meta">by the operator, after agent.max_continuations, or at agent.max_issue_cost_usd</span>
    </div>
    <div class="agents compact" id="paused"></div>
  </section>

  <div class="lower">
    <section aria-labelledby="activity-title">
      <div class="section-head">
        <h2 id="activity-title">Agent activity</h2>
        <span class="meta">live stream · newest first</span>
      </div>
      <ol class="feed" id="feed" aria-live="off"></ol>
    </section>
    <div class="side">
      <details class="panel blocked-section" id="blocked-section">
        <summary>
          <div class="section-head">
            <h2 id="blocked-title"><span class="chev" aria-hidden="true">▸</span>Blocked <span class="count" id="blocked-count"></span></h2>
            <span class="meta" id="blocked-meta"></span>
          </div>
        </summary>
        <div id="blocked"></div>
      </details>
    </div>
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

  function renderHeader(h, problems, online) {
    setLive(online);
    let status;
    if (!online) status = badge('Offline', 'red', false);
    else if (h.stopping) status = badge('Shutting down', 'amber', false);
    else if (problems.length) status = badge('Degraded', 'amber', true);
    else status = badge('Online', 'green', true);
    const holder = $('sys-status');
    const current = holder.firstChild;
    if (!current || current.className !== status.className || current.textContent !== status.textContent) holder.replaceChildren(status);
    if (!h) return;
    setText($('sys-workflow'), 'v' + h.workflow_version);
    setText($('sys-interval'), 'every ' + Math.round(h.poll_interval_ms / 1000) + 's');
    const last = $('sys-lastpoll');
    setText(last, h.last_tick_at ? ago(h.last_tick_at) : 'never');
    const stale = h.last_tick_at && Date.now() - Date.parse(h.last_tick_at) > Math.max(3 * h.poll_interval_ms, 30000);
    last.style.color = stale ? 'var(--amber)' : '';
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

    // Status box of waiting issues (retrying, paused, queued): meta line, message, Retry/Resume button.
    refs.info = el('div', null, 'activity-box');

    const foot = el('div', null, 'agent-foot');
    refs.foot = foot;
    refs.turn = metric(foot, 'Turn');
    refs.runtime = metric(foot, 'Runtime');
    refs.tokens = metric(foot, 'Tokens');
    refs.cost = metric(foot, 'Est. cost');

    // Pause of a running issue (hidden on the other cards; their status box carries their buttons).
    refs.controls = el('div', null, 'card-actions');

    card.append(head, titleWrap, pipe, dl, act, refs.controls, refs.info, foot);
    return refs;
  }

  // Tone of the reason chip per dispatch plan reason code (docs/usage.md#dispatch-order).
  const REASON_TONE = {
    ready: 'green', no_free_slot: 'cyan', reserved_for_role: 'cyan', column_limit: 'amber', backoff: 'amber', session_limit: 'amber', model_hold: 'amber',
    waiting_for_sub_issues: 'gray', inactive: 'gray', paused: 'gray',
  };
  // Reason texts carry UTC times (the same text as --dry-run); the chip shows them in local time, the tooltip as sent.
  const UTC_TIME = /(\\d{4}-\\d{2}-\\d{2}) (\\d{2}:\\d{2}) UTC/g;
  function reasonChip(reason) {
    const text = reason.text.replace(UTC_TIME, (_, day, time) => fmtStamp(day + 'T' + time + ':00Z'));
    const chip = el('span', text, 'chip reason tone-' + (REASON_TONE[reason.code] || 'gray'));
    chip.title = reason.code + ': ' + reason.text;
    return chip;
  }

  /** Meta line, message and action of a waiting issue card (status box children, diffed by patchChildren). */
  function infoChildren(row) {
    const nodes = [];
    if (row.reason) {
      const why = el('div', null, 'qmeta');
      why.append(reasonChip(row.reason));
      if (row.priority != null) { const p = el('span', 'priority '); p.append(el('b', 'P' + row.priority)); why.append(p); }
      const m = el('span', 'model '); m.append(el('b', row.model || 'default')); why.append(m);
      nodes.push(why);
    }
    const meta = el('div', null, 'qmeta');
    nodes.push(meta);
    if (row.status === 'retrying' && row.retry) {
      const r = row.retry;
      // The issue's own model, else the model whose limit it hit (an issue on the default model is never held).
      const hold = row.model_hold || (r.limit && r.limit.scope === 'model' && r.limit.model ? { model: r.limit.model, until: r.due_at } : null);
      if (hold) {
        // The reason chip already names the hold.
        if (!row.reason || row.reason.code !== 'model_hold') {
          meta.append(...modelHoldBits(hold));
          nodes.push(el('div', waitingForModel(hold), 'msg'));
        }
        if (r.limit && r.limit.text) nodes.push(el('div', r.limit.text, 'msg'));
      } else if (r.kind === 'session_limit' && r.limit) {
        meta.append(...sessionLimitBits(r));
        nodes.push(el('div', r.limit.text || r.error || '—', 'msg'));
        if (r.limit.overage_disabled_reason === 'out_of_credits') {
          nodes.push(el('div', 'Extra usage is off because credits are used up. Top up' + (retryAllowed ? ', then press Retry now.' : '.'), 'msg'));
        }
      } else {
        const attempt = el('span', 'attempt '); attempt.append(el('b', pad2(r.attempt)));
        const due = el('span', 'next in '); due.append(el('b', fmtDuration(r.due_in_ms / 1000)));
        meta.append(attempt, due);
        // A requeued retry's error is its reason, already in the chip.
        const text = r.error && (!row.reason || r.error !== row.reason.text) ? r.error : r.kind === 'continuation' ? 'Continues the session after a clean exit.' : '';
        if (text) nodes.push(el('div', text, 'msg'));
      }
      // Up next starts it with the next free slot anyway; Retry now skips a wait, Start now also the slot limits.
      nodes.push(actions([...(row.section !== 'next' ? [restartButton(row.issue_identifier, 'Retry')] : []), ...forceButtons(row)], row.issue_identifier));
    } else if (row.status === 'paused' && row.paused) {
      if (row.paused.source === 'operator') {
        meta.append(el('span', 'paused by operator'), el('span', ago(row.paused.paused_at)));
        nodes.push(el('div', 'Board changes do not lift this pause; it ends with Resume, Done or leaving the board.', 'msg'));
      } else if (row.paused.source === 'budget') {
        meta.append(el('span', 'cost budget used up'), el('span', '$' + row.paused.cost_usd.toFixed(2) + ' of $' + row.paused.max_issue_cost_usd.toFixed(2)), el('span', ago(row.paused.paused_at)));
        nodes.push(el('div', 'Board changes do not lift this pause; it ends with Resume, a higher agent.max_issue_cost_usd, Done or leaving the board.', 'msg'));
      } else {
        const cont = el('span', 'paused after '); cont.append(el('b', row.paused.continuations), ' continuations');
        meta.append(cont, el('span', ago(row.paused.paused_at)));
        nodes.push(el('div', 'Resume: change the issue on the board (status, comment or labels)' + (retryAllowed ? ', or press Resume now.' : '.'), 'msg'));
      }
      if (retryAllowed) {
        const box = el('div', null, 'card-actions');
        box.append(restartButton(row.issue_identifier, 'Resume'), ...forceButtons(row));
        nodes.push(box);
      } else nodes.push(restartButton(row.issue_identifier, 'Resume'));
    } else {
      if (row.model_hold && (!row.reason || row.reason.code !== 'model_hold')) {
        meta.append(...modelHoldBits(row.model_hold));
        nodes.push(el('div', waitingForModel(row.model_hold), 'msg'));
      } else if (row.dispatch_note) {
        nodes.push(el('div', row.dispatch_note, 'msg'));
      }
      if (row.status === 'queued') nodes.push(actions(forceButtons(row), row.issue_identifier));
    }
    return nodes.filter((node) => node.childNodes.length > 0);
  }

  // Start now never starts an issue whose model is held or that waits for its sub-issues: the button would only fail.
  const UNFORCEABLE = new Set(['model_hold', 'waiting_for_sub_issues']);
  function forceButtons(row) {
    if (!retryAllowed || row.model_hold || (row.reason && UNFORCEABLE.has(row.reason.code))) return [];
    return [restartButton(row.issue_identifier, 'Force')];
  }

  /** Buttons of a card that can be paused: the given ones, then Pause (or the controls-disabled notice once). */
  function actions(buttons, identifier) {
    const box = el('div', null, 'card-actions');
    if (!retryAllowed) {
      if (buttons.length === 0) box.append(el('div', RESTART_DISABLED, 'msg muted restart-off'));
      else box.append(...buttons);
      return box;
    }
    box.append(...buttons, restartButton(identifier, 'Pause'));
    return box;
  }

  // A waiting issue whose model is on hold: it starts when the hold ends, never on another model.
  function waitingForModel(hold) {
    if (!hold.until) return 'Waiting for model ' + hold.model + ' (paused by the operator)';
    return 'Waiting for model ' + hold.model + ' (limit until ' + fmtStamp(hold.until) + ')';
  }
  function modelHoldBits(hold) {
    const model = el('span', 'waiting for model '); model.append(el('b', hold.model));
    if (!hold.until) return [model, el('span', 'paused by the operator')];
    const until = el('span', 'until '); until.append(el('b', fmtStamp(hold.until)));
    return [model, until];
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
    refs.info.hidden = !!r;
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
    } else {
      patchChildren(refs.info, infoChildren(row));
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

  // Dashboard sections in page order; each row of state.issues names its own (running, then the dispatch plan).
  const SECTIONS = ['running', 'next', 'waiting', 'paused'];

  function renderIssues(state) {
    const h = state.health;
    const rows = state.issues || [];
    const live = new Set();
    const bySection = Object.fromEntries(SECTIONS.map((name) => [name, []]));
    for (const row of rows) {
      live.add(row.issue_id);
      let refs = cards.get(row.issue_id);
      if (!refs) { refs = createCard(); cards.set(row.issue_id, refs); }
      updateCard(refs, row, h.max_turns);
      (bySection[row.section] || bySection.next).push(refs.card);
    }
    for (const [id, refs] of cards) {
      if (live.has(id)) continue;
      cards.delete(id);
      refs.card.classList.remove('enter', 'changed');
      refs.card.classList.add('leave');
      setTimeout(() => refs.card.remove(), 320);
    }
    for (const name of SECTIONS) {
      const host = $(name);
      const ordered = bySection[name];
      ordered.forEach((card, i) => {
        const active = [...host.children].filter((c) => !c.classList.contains('leave'));
        if (active[i] !== card) host.insertBefore(card, active[i] || null);
      });
      setText($(name + '-count'), pad2(ordered.length));
      if (name !== 'running') $(name + '-section').hidden = ordered.length === 0;
    }
    setText($('next-meta'), state.board_fetched_at ? 'in start order · board as of ' + ago(state.board_fetched_at) : 'in start order · board not fetched yet');

    const running = state.counts.running;
    // Sessions started with Start now run in an extra slot each: "04 / 03 agents, 1 forced".
    const forced = state.counts.forced || 0;
    const slotted = running - forced;
    const max = h.max_concurrent_agents;
    slotUse = { slotted, max };
    // Reserved slots a role does not use yet stay free for it: "developer 1/1 · reviewer 0/1 reserved · 1 free".
    const reservations = state.limits && !state.limits.reservation_problem
      ? Object.entries(state.limits.reserved_slots_by_role || {}).filter(([, r]) => r.effective > 0)
      : [];
    let unused = 0;
    for (const [, r] of reservations) unused += Math.max(r.effective - r.running, 0);
    const free = Math.max(max - slotted - unused, 0);
    const bar = el('div', null, 'slots-bar');
    for (let i = 0; i < Math.min(max, 24); i++) bar.append(el('i', null, i < slotted ? 'on' : i < slotted + unused ? 'reserved' : ''));
    for (let i = 0; i < Math.min(forced, 8); i++) bar.append(el('i', null, 'forced'));
    const slots = $('slots');
    const agents = pad2(running) + ' / ' + pad2(max) + ' agents' + (forced > 0 ? ', ' + forced + ' forced' : '');
    const slotText = reservations.length > 0
      ? agents + ' · ' + reservations.map(([role, r]) => role + ' ' + Math.min(r.running, r.effective) + '/' + r.effective).join(' · ') + ' reserved · ' + free + ' free'
      : agents + ' · ' + free + ' free slot' + (free === 1 ? '' : 's');
    slots.replaceChildren(bar, el('span', slotText));
    $('issues-empty').hidden = bySection.running.length > 0;
    setText($('issues-empty-sub'), rows.length
      ? 'Nothing running right now · ' + (rows.length) + ' issue' + (rows.length === 1 ? '' : 's') + ' below'
      : 'Waiting for issues in ' + (h.active_states && h.active_states.length ? h.active_states.join(', ') : 'an active column') +
        ' · next poll within ' + Math.round(h.poll_interval_ms / 1000) + 's');
  }

  // ------------------------------------------------------------------ queues

  // Keep the <ul> and only swap the items that changed.
  function patchList(id, list) {
    const host = $(id);
    const current = host.firstElementChild;
    if (current && current.tagName === 'UL') patchChildren(current, [...list.children]);
    else host.replaceChildren(list);
  }

  const traceLink = (identifier) => link('trace →', '/issue?id=' + encodeURIComponent(identifier));

  function emptyState(id, text, tone, sub) {
    const box = el('div', null, 'clear');
    box.append(badge(text, tone, false), el('div', sub, 'muted'));
    patchChildren($(id), [box]);
  }

  const WINDOW_WORDS = { five_hour: 'five hour', seven_day: 'seven day', seven_day_opus: 'seven day Opus', seven_day_sonnet: 'seven day Sonnet' };
  const windowWords = (w) => WINDOW_WORDS[w] || String(w || '').replace(/_/g, ' ');

  // Per-identifier outcome of a control click (Retry, Pause, Resume); a poll rebuilds the rows, so the button state
  // is drawn from here.
  const restartStates = new Map();
  const RESTART_LABELS = { Retry: 'Retry now', Resume: 'Resume now', Pause: 'Pause', Force: 'Start now' };
  // Route, busy label and success label of each control button.
  const CONTROL = {
    Retry: ['retry', 'Restarting…', 'Queued'],
    Force: ['force', 'Starting…', 'Started'],
    Resume: ['resume', 'Resuming…', 'Queued'],
    Pause: ['pause', 'Pausing…', 'Paused'],
  };
  const RESTART_DISABLED = 'Controls disabled: set SYMPHONY_ALLOW_REMOTE_CONTROL=true behind an authenticating proxy';
  // From /api/v1/state; false on a non-loopback bind without server.allow_remote_control.
  let retryAllowed = true;
  // Sessions holding a slot and the limit, from the last state; Start now asks first when no slot is free.
  let slotUse = { slotted: 0, max: 0 };

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
    if (verb === 'Force' && slotUse.slotted >= slotUse.max) {
      const question = 'All ' + slotUse.max + ' slot' + (slotUse.max === 1 ? ' is' : 's are') + ' busy. Start ' + splitId(identifier).num + ' in an extra slot?';
      if (!window.confirm(question)) return;
    }
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

  // Pause / Resume of a model family (POST /api/v1/models/<model>/hold or /release).
  const modelStates = new Map();
  async function controlModel(model, hold) {
    if (modelStates.get(model) === 'busy') return;
    modelStates.set(model, 'busy');
    let label = 'failed';
    try {
      const res = await fetch('/api/v1/models/' + encodeURIComponent(model) + '/' + (hold ? 'hold' : 'release'), { method: 'POST' });
      let body = null;
      try { body = await res.json(); } catch {}
      label = res.ok ? (hold ? 'paused' : 'resumed') : (body && body.error && body.error.message) || 'failed (' + res.status + ')';
    } catch {}
    modelStates.delete(model);
    $('announce').textContent = 'Model ' + model + ': ' + label;
    setTimeout(load, 300);
  }

  function renderModelControls(state) {
    const models = state.model_controls || [];
    const host = $('model-controls');
    host.hidden = models.length === 0;
    const nodes = [el('span', 'Models')];
    for (const m of models) {
      const item = el('span', null, 'model-control-item');
      const name = el('b', m.model);
      item.append(name, el('span', m.paused ? 'paused by operator' : m.limit_until ? 'limit until ' + fmtStamp(m.limit_until) : 'running'));
      if (retryAllowed) {
        const b = el('button', m.paused ? 'Resume' : 'Pause', 'btn model-control');
        b.type = 'button';
        b.dataset.model = m.model;
        b.dataset.hold = m.paused ? '0' : '1';
        b.setAttribute('aria-label', (m.paused ? 'Resume' : 'Pause') + ' model ' + m.model);
        if (modelStates.get(m.model) === 'busy') b.setAttribute('aria-busy', 'true');
        item.append(b);
      }
      nodes.push(item);
    }
    if (!retryAllowed && models.length > 0) nodes.push(el('span', RESTART_DISABLED, 'muted restart-off'));
    patchChildren(host, nodes);
  }

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const b = target ? target.closest('button.restart') : null;
    if (b) restart(b.dataset.identifier, b.dataset.verb);
    const m = target ? target.closest('button.model-control') : null;
    if (m) controlModel(m.dataset.model, m.dataset.hold === '1');
  });

  // Agent slots set on the dashboard (PUT /api/v1/settings/agents; DELETE resets to WORKFLOW.md).
  let slotBusy = false;
  let slotError = '';
  async function changeSlots(method, body) {
    if (slotBusy) return;
    slotBusy = true;
    let label = 'failed';
    try {
      const init = { method, headers: { 'content-type': 'application/json' } };
      if (body !== null) init.body = JSON.stringify(body);
      const res = await fetch('/api/v1/settings/agents', init);
      let data = null;
      try { data = await res.json(); } catch {}
      label = res.ok ? (method === 'DELETE' ? 'reset to WORKFLOW.md' : 'saved') : (data && data.error && data.error.message) || 'failed (' + res.status + ')';
      slotError = res.ok ? '' : label;
    } catch {
      slotError = label;
    }
    slotBusy = false;
    if (slotError) setTimeout(() => { slotError = ''; }, 8000);
    $('announce').textContent = 'Agent slots: ' + label;
    setTimeout(load, 300);
  }

  function slotButton(text, label, body, disabled) {
    const b = el('button', text, 'btn slot-control');
    b.type = 'button';
    b.dataset.body = JSON.stringify(body);
    b.setAttribute('aria-label', label);
    if (disabled || slotBusy) b.disabled = true;
    return b;
  }

  function renderSlotSettings(state) {
    const limits = state.limits;
    const host = $('slot-settings');
    host.hidden = !limits;
    if (!limits) return;
    const total = limits.max_concurrent_agents;
    // Forced sessions run beside the limit; only the others hold its slots.
    const running = state.counts.running - (state.counts.forced || 0);
    const nodes = [];
    const item = el('span', null, 'slot-item');
    item.append(el('span', 'Slots'));
    if (retryAllowed) item.append(slotButton('−', 'Fewer agent slots', { max_concurrent_agents: Math.min(total.effective - 1, limits.max) }, total.effective <= 0));
    item.append(el('b', total.effective));
    if (retryAllowed) item.append(slotButton('+', 'More agent slots', { max_concurrent_agents: total.effective + 1 }, total.effective >= limits.max));
    if (total.override !== null && total.override !== total.workflow) item.append(el('span', 'set here · WORKFLOW.md ' + total.workflow, 'slot-override'));
    else if (total.override !== null) item.append(el('span', 'set here', 'slot-override'));
    nodes.push(item);
    for (const [column, v] of Object.entries(limits.by_state || {})) {
      const col = el('span', null, 'slot-item');
      col.append(el('span', column));
      if (retryAllowed && v.effective !== null) {
        col.append(slotButton('−', 'Lower the limit of ' + column, { max_concurrent_agents_by_state: { [column]: Math.min(v.effective - 1, limits.max) } }, v.effective <= 1));
      }
      col.append(el('b', v.effective === null ? '–' : v.effective));
      if (retryAllowed) {
        col.append(v.effective === null
          ? slotButton('+', 'Set a limit of 1 for ' + column, { max_concurrent_agents_by_state: { [column]: 1 } }, false)
          : slotButton('+', 'Raise the limit of ' + column, { max_concurrent_agents_by_state: { [column]: v.effective + 1 } }, v.effective >= limits.max));
      }
      if (v.override !== null) {
        col.append(el('span', 'set here · WORKFLOW.md ' + (v.workflow === null ? 'none' : v.workflow), 'slot-override'));
        if (retryAllowed) col.append(slotButton('×', 'Use the WORKFLOW.md limit of ' + column, { max_concurrent_agents_by_state: { [column]: null } }, false));
      }
      nodes.push(col);
    }
    for (const [role, r] of Object.entries(limits.reserved_slots_by_role || {})) {
      const res = el('span', null, 'slot-item');
      res.append(el('span', role + ' reserved'));
      if (retryAllowed) res.append(slotButton('−', 'Reserve fewer slots for ' + role, { reserved_slots_by_role: { [role]: r.effective - 1 } }, r.effective <= 0));
      res.append(el('b', r.effective));
      if (retryAllowed) res.append(slotButton('+', 'Reserve one more slot for ' + role, { reserved_slots_by_role: { [role]: r.effective + 1 } }, r.effective >= limits.max));
      if (r.override !== null) {
        res.append(el('span', 'set here · WORKFLOW.md ' + r.workflow, 'slot-override'));
        if (retryAllowed) res.append(slotButton('×', 'Use the WORKFLOW.md reservation of ' + role, { reserved_slots_by_role: { [role]: null } }, false));
      }
      nodes.push(res);
    }
    if (retryAllowed && limits.override_active) {
      const reset = el('button', 'Reset to WORKFLOW.md (' + total.workflow + ')', 'btn slot-reset');
      reset.type = 'button';
      if (slotBusy) reset.disabled = true;
      nodes.push(reset);
    }
    const reservedRoles = Object.entries(limits.reserved_slots_by_role || {});
    let reservedSum = 0;
    for (const [, r] of reservedRoles) reservedSum += r.effective;
    const unreserved = reservedRoles.filter(([, r]) => r.effective === 0).map(([role]) => role);
    if (!limits.reservation_problem && reservedSum > 0 && reservedSum >= total.effective && total.effective > 0 && unreserved.length > 0) {
      nodes.push(el('span', 'every slot is reserved: ' + unreserved.join(', ') + ' start only with more slots', 'slot-note'));
    }
    if (total.effective === 0) {
      nodes.push(el('span', 'limit 0: new dispatches paused' + (running > 0 ? ', ' + running + ' running keep working' : ''), 'slot-note'));
    } else if (running > total.effective) {
      const finish = running - total.effective + 1;
      nodes.push(el('span', running + ' running, limit ' + total.effective + ': no new starts until ' + (finish === 1 ? 'one finishes' : finish + ' finish'), 'slot-note'));
    }
    if (!retryAllowed) nodes.push(el('span', RESTART_DISABLED, 'muted restart-off'));
    if (slotError) nodes.push(el('span', slotError, 'slot-error'));
    patchChildren(host, nodes);
  }

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const step = target ? target.closest('button.slot-control') : null;
    if (step && !step.disabled) changeSlots('PUT', JSON.parse(step.dataset.body));
    const reset = target ? target.closest('button.slot-reset') : null;
    if (reset && !reset.disabled) changeSlots('DELETE', null);
  });

  function sessionLimitBits(r) {
    const limit = r.limit;
    const bits = [];
    if (limit.waiting) {
      bits.push(el('span', 'waiting for reset'));
      const resets = el('span', 'resets '); resets.append(el('b', fmtStamp(limit.resets_at)));
      if (limit.window) resets.append(' (' + windowWords(limit.window) + ')');
      bits.push(resets);
      const at = el('span', 'retry at '); at.append(el('b', fmtStamp(r.due_at)), ' (in ' + fmtDuration(r.due_in_ms / 1000) + ')');
      bits.push(at);
    } else {
      if (limit.hits <= limit.max_retries) {
        const n = el('span', 'retry '); n.append(el('b', limit.hits), ' of ' + limit.max_retries);
        bits.push(n);
      } else bits.push(el('span', 'retrying with backoff'));
      const due = el('span', 'next in '); due.append(el('b', fmtDuration(r.due_in_ms / 1000)));
      bits.push(due);
    }
    return bits;
  }

  // Blocked issues (collapsed by default); the open state survives polls and reloads via localStorage.
  const blockedDetails = $('blocked-section');
  try { blockedDetails.open = localStorage.getItem('symphony.blockedOpen') === '1'; } catch {}
  blockedDetails.addEventListener('toggle', () => {
    try { localStorage.setItem('symphony.blockedOpen', blockedDetails.open ? '1' : '0'); } catch {}
  });

  function renderBlocked(state) {
    const rows = state.blocked || [];
    setText($('blocked-count'), pad2(rows.length));
    setText($('blocked-meta'), state.board_fetched_at ? 'board as of ' + fmtClock(state.board_fetched_at) : '');
    if (!rows.length) return emptyState('blocked', 'None', 'green', 'No blocked issues on the board.');
    const list = el('ul', null, 'queue');
    for (const r of rows) {
      const li = el('li', null, 'qitem tone-red');
      const row = el('div', null, 'qrow');
      const id = link(r.issue_identifier, r.issue_url); id.classList.add('id');
      row.append(id, badge(r.state || 'Blocked', 'red', false));
      li.append(row);
      if (r.title) li.append(el('div', r.title, 'msg'));
      const meta = el('div', null, 'qmeta');
      // The blocker list below already carries a "blocked by …" reason, with the blockers' states.
      const hasBlockers = r.blocked_by && r.blocked_by.length;
      if (!(hasBlockers && /^blocked by/.test(r.reason))) meta.append(el('span', r.reason));
      if (r.tracked) meta.append(traceLink(r.issue_identifier));
      if (meta.childNodes.length) li.append(meta);
      if (hasBlockers) {
        const blockers = el('div', null, 'qmeta');
        blockers.append(el('span', 'blocked by'));
        for (const b of r.blocked_by) blockers.append(el('b', (b.identifier || b.id || 'unknown') + (b.state ? ' (' + b.state + ')' : '')));
        li.append(blockers);
      }
      list.append(li);
    }
    patchList('blocked', list);
  }

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
    const h = state.health;
    const problems = [];
    if (h.workflow_error) problems.push('WORKFLOW.md: ' + h.workflow_error.message);
    for (const e of h.dispatch_errors) if (!h.workflow_error || !e.startsWith('WORKFLOW.md')) problems.push(e);
    if (h.last_tracker_error) problems.push('Tracker: ' + h.last_tracker_error.message);
    if (h.pricing_error) problems.push('model-costs.yml: ' + h.pricing_error);
    if (state.limits && state.limits.reservation_problem) problems.push('Agent slots: ' + state.limits.reservation_problem);
    if (state.limits) for (const p of state.limits.slot_problems || []) problems.push('Agent slots: ' + p);
    $('problems').hidden = problems.length === 0;
    $('problem-list').replaceChildren(...problems.map((p) => el('li', p)));
    renderHeader(h, problems, true);
    renderRepositories(h);
    const gate = h.dispatch_gate;
    $('dispatch-gate').hidden = !gate;
    setText($('dispatch-gate-text'), gate
      ? 'Dispatch paused until ' + fmtStamp(gate.until) + ' · session limit (' + gate.window + ') · started by ' + gate.issue_identifier
      : '');
    const holds = state.model_holds || [];
    $('model-holds').hidden = holds.length === 0;
    $('model-hold-list').replaceChildren(...holds.map((hold) => el('li', hold.source === 'operator'
      ? 'Model ' + hold.model + ' paused by the operator since ' + fmtStamp(hold.since) + ' · its issues wait, none runs on another model'
      : 'Model ' + hold.model + ' on hold until ' + fmtStamp(hold.until) + (hold.issue_identifier ? ' · hit by ' + hold.issue_identifier : '') +
        (hold.text ? ' · ' + hold.text : ''))));

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
    renderModelControls(state);
    renderSlotSettings(state);
    setText($('teams-count'), pad2(renderTeams($('teams'), state, Date.now())));
    renderIssues(state);
    renderBlocked(state);
    diffSnapshots(state);
    fetchDetails(state);
    renderActivity();
  }

  async function load() {
    const progress = $('progress');
    progress.classList.remove('tick');
    void progress.offsetWidth;
    progress.classList.add('tick');
    try {
      const res = await fetch('/api/v1/state', { cache: 'no-store' });
      render(await res.json());
    } catch (error) {
      renderHeader(null, [], false);
      setText($('sys-lastpoll'), 'unreachable');
      $('problems').hidden = false;
      $('problem-list').replaceChildren(el('li', 'orchestrator unreachable: ' + error.message));
    }
  }

  const refresh = $('refresh');
  const refreshLabel = $('refresh-label');
  refresh.addEventListener('click', async () => {
    if (refresh.classList.contains('is-busy')) return;
    refresh.classList.remove('is-done', 'is-failed');
    refresh.classList.add('is-busy');
    refresh.setAttribute('aria-busy', 'true');
    refreshLabel.textContent = 'Polling…';
    let outcome = 'failed';
    try {
      const res = await fetch('/api/v1/refresh', { method: 'POST' });
      const body = await res.json();
      outcome = res.ok ? (body.coalesced ? 'Already queued' : 'Poll queued') : 'failed';
    } catch {}
    refresh.classList.remove('is-busy');
    refresh.removeAttribute('aria-busy');
    refresh.classList.add(outcome === 'failed' ? 'is-failed' : 'is-done');
    refreshLabel.textContent = outcome === 'failed' ? 'Poll failed' : outcome;
    $('announce').textContent = refreshLabel.textContent;
    setTimeout(load, 500);
    setTimeout(() => { refresh.classList.remove('is-done', 'is-failed'); refreshLabel.textContent = 'Poll now'; }, 1800);
  });

  renderActivity();
  load();
  loadHistory();
  setInterval(load, 2000);
  setInterval(() => tickTeams(Date.now()), 1000);
  setInterval(loadHistory, 30000);
})();
`,
});
