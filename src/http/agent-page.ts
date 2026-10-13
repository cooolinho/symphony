import { PIPELINE_CSS, PIPELINE_JS } from './pipeline.ts';
import { BASE_CSS, BASE_JS } from './styles.ts';

const AGENT_CSS = `
  /* Pipeline section: the topology strip plus one summary row per agent stage. */
  .pipe-section .pipe { justify-content: flex-start; }
  .pipe-rows { margin-top: 12px; display: grid; gap: 6px; }
  .pipe-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; padding: 7px 10px; font: 12px var(--mono);
    border: 1px solid var(--line); border-left: 2px solid var(--tone, var(--faint)); border-radius: var(--radius-sm); background: rgba(0, 0, 0, .2); }
  .pipe-row b { color: var(--text); font-weight: 600; }
  .pipe-row .muted { overflow-wrap: anywhere; }

  /* Issue sidebar section: labels, blockers, sub-issues. */
  .issue-labels { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .issue-labels:empty { display: none; }
  .issue-note { margin-top: 10px; font: 12px var(--mono); color: var(--amber); overflow-wrap: anywhere; }
`;

const AGENT_PAGE_CSS = `
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); border: 0; }
  .back { display: inline-flex; align-items: center; gap: 8px; font: 600 11px var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--text-2); width: max-content; }
  .back:hover { color: var(--green); text-decoration: none; }

  /* Header */
  .hero { position: relative; overflow: hidden; border-color: var(--line-2); padding: 18px 20px;
    background: linear-gradient(160deg, var(--tone-dim, transparent) 0%, rgba(11, 17, 21, .96) 42%), var(--panel); }
  .hero::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 2px; background: linear-gradient(90deg, var(--tone, var(--faint)), transparent 75%); }
  .hero-top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
  .hero-top .tags { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .hero-id { font: 600 13px var(--mono); letter-spacing: .14em; color: var(--text-2); text-transform: uppercase; }
  .hero-id b { color: var(--text); font-size: 15px; letter-spacing: .04em; }
  .hero h1 { margin: 12px 0 4px; font: 600 22px/1.3 var(--sans); color: #f0f6f3; letter-spacing: -.01em; overflow-wrap: anywhere; }
  .hero-repo { display: flex; flex-wrap: wrap; gap: 4px 14px; font: 12.5px var(--mono); color: var(--muted); }
  .hero-repo span { overflow-wrap: anywhere; }
  .hero-meta { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 4px 10px; font: 500 13px var(--mono); color: var(--cyan); }
  .hero-meta .sep { color: var(--faint); }
  .hero-meta .role { color: var(--text); }
  .hero-metrics { margin-top: 16px; padding-top: 14px; border-top: 1px dashed var(--line-2); display: grid; gap: 12px 18px;
    grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); }
  .hero-metrics div { min-width: 0; }
  .k { font: 600 10px var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--muted); display: block; }
  .v { display: block; margin-top: 3px; font: 600 15px var(--mono); font-variant-numeric: tabular-nums; color: var(--text); overflow-wrap: anywhere; }
  .v.small { font-size: 12.5px; font-weight: 500; color: var(--text-2); }
  .live-line { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 4px 10px; font: 12.5px var(--mono); color: var(--text-2); min-width: 0; }
  .live-line .ev { color: var(--text); }
  .live-line .age { color: var(--muted); }
  .live-line .msg { flex-basis: 100%; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

  /* Alert (failure, retry, pause) */
  .alert { border-color: var(--tone-line); background: linear-gradient(180deg, var(--tone-dim), rgba(11, 17, 21, .85)); display: grid; gap: 8px; }
  .alert h2 { color: var(--tone); margin: 0; display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .alert .reason { font: 13px/1.55 var(--mono); color: var(--text); overflow-wrap: anywhere; white-space: pre-wrap; max-height: 9.5em; overflow: auto; }
  .alert .sub { font: 12px var(--mono); color: var(--text-2); display: flex; flex-wrap: wrap; gap: 4px 16px; }
  .alert .sub b { color: var(--text); font-weight: 600; }
  .alert .actions { margin-top: 2px; }
  .notice { font: 12.5px var(--mono); color: var(--text-2); padding: 10px 14px; border: 1px dashed var(--line-2); border-radius: var(--radius-sm); background: rgba(0, 0, 0, .2); }

  /* Layout: timeline dominant, summary on the side */
  .trace { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; align-items: start; }
  @media (min-width: 1100px) { .trace { grid-template-columns: minmax(0, 2.1fr) minmax(300px, 1fr); } .side { position: sticky; top: 86px; } }
  .side { display: grid; gap: 16px; min-width: 0; }
  .side section { padding: 14px 16px; }
  .side h2 { margin-bottom: 12px; }
  .kv { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7px 14px; margin: 0; font: 12.5px var(--mono); }
  .kv dt { color: var(--muted); white-space: nowrap; }
  .kv dd { margin: 0; color: var(--text); text-align: right; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .kv dd.info { color: var(--cyan); }
  .kv .rule { grid-column: 1 / -1; border-top: 1px dashed var(--line-2); margin: 3px 0; }
  .milestones { list-style: none; margin: 0 0 12px; padding: 0; display: grid; gap: 6px; font: 12.5px var(--mono); }
  .milestones li { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; align-items: center; gap: 8px; color: var(--text-2); }
  .milestones .t { color: var(--muted); font-variant-numeric: tabular-nums; }
  .big { font: 600 24px/1.2 var(--mono); font-variant-numeric: tabular-nums; color: #eef6f2; }
  .big-sub { font: 11.5px var(--mono); color: var(--muted); margin: 2px 0 12px; }
  .chart { position: relative; margin-top: 12px; }
  .chart svg { display: block; width: 100%; height: 64px; }
  .chart .bar { fill: var(--cyan); opacity: .75; }
  .chart .bar.hot { opacity: 1; }
  .chart .axis { stroke: var(--line-2); stroke-width: 1; }
  .chart .cap { display: flex; justify-content: space-between; font: 10.5px var(--mono); color: var(--muted); margin-top: 4px; }
  .tip { position: absolute; z-index: 5; pointer-events: none; transform: translate(-50%, -100%); margin-top: -6px; padding: 5px 8px; border-radius: 5px;
    background: #0d151a; border: 1px solid var(--line-2); font: 11px var(--mono); color: var(--text); white-space: nowrap; box-shadow: var(--shadow); }
  /* Integrations (e.g. Laravel Boost): what the session got and what the agent used. */
  #int-title { display: flex; align-items: center; gap: 8px; }
  .int-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; }
  .int-head b { font: 600 13px var(--mono); color: var(--text); }
  .int-text { font-size: 12.5px; color: var(--text-2); margin: 0 0 4px; overflow-wrap: anywhere; }
  .int-sub { font: 600 10px var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--muted); margin: 12px 0 6px; }
  .int-warn { font: 12px var(--mono); color: var(--amber); margin-top: 6px; overflow-wrap: anywhere; }
  .runs { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  .runs li { display: grid; gap: 3px; padding: 8px 10px; border: 1px solid var(--line); border-left: 2px solid var(--tone, var(--faint)); border-radius: var(--radius-sm); background: rgba(0, 0, 0, .2); font: 12px var(--mono); }
  .runs .row { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
  .runs .muted { font-size: 11.5px; }

  /* Timeline */
  .tl-head { display: grid; gap: 10px; margin-bottom: 12px; }
  .tl-head .section-head { margin: 0; }
  .tl-tools { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .tl-tools input[type="search"] { flex: 1 1 160px; }
  .seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--line-2); border-radius: var(--radius-sm); overflow: hidden; }
  .seg button { border: 0; border-radius: 0; padding: 7px 10px; background: transparent; color: var(--muted); }
  .seg button + button { border-left: 1px solid var(--line-2); }
  .seg button[aria-pressed="true"] { background: var(--raise); color: var(--tone, var(--text)); }
  .seg button .n { color: var(--faint); margin-left: 4px; }
  .tl-wrap { position: relative; }
  .timeline { list-style: none; margin: 0; padding: 6px 4px 6px 0; max-height: 76vh; overflow-y: auto; overscroll-behavior: contain;
    border-radius: var(--radius-sm); background: rgba(0, 0, 0, .22); border: 1px solid var(--line); }
  .timeline > li.note { padding: 18px; color: var(--muted); font: 12.5px var(--mono); }
  .item { --rail: 98px; position: relative; display: grid; grid-template-columns: var(--rail) minmax(0, 1fr); padding: 0 12px 0 0; content-visibility: auto; contain-intrinsic-size: auto 44px; }
  .item::before { content: ""; position: absolute; left: calc(var(--rail) - 12px); top: 0; bottom: 0; width: 1px; background: var(--line-2); }
  .item .when { padding: 9px 22px 0 12px; text-align: right; font: 11.5px var(--mono); color: var(--faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .item .mark { position: absolute; left: calc(var(--rail) - 17px); top: 10px; width: 11px; height: 11px; display: grid; place-items: center;
    font: 10px/1 var(--mono); color: var(--tone, var(--gray)); background: var(--bg-2); border-radius: 50%; }
  .item .mark.dot::after { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--tone, var(--gray)); box-shadow: 0 0 6px -1px var(--tone, transparent); }
  .item .card { min-width: 0; margin: 4px 0; padding: 6px 10px; border-radius: var(--radius-sm); border: 1px solid transparent; }
  .item.boxed .card { border-color: var(--line); background: rgba(15, 23, 28, .55); }
  .item.boxed .card:hover { border-color: var(--line-2); }
  .item.err .card { border-color: var(--red-line); background: linear-gradient(90deg, var(--red-dim), rgba(15, 23, 28, .6) 70%); }
  .item.warn .card { border-color: var(--amber-line); }
  .item.fresh .card { animation: item-in 1.6s var(--ease); }
  @keyframes item-in { from { background: rgba(61, 220, 132, .13); border-color: var(--green-line); } }
  .item.focus .card { box-shadow: 0 0 0 1px var(--cyan); }
  .item.sub { --rail: 122px; }
  .head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; min-width: 0; }
  .head button.toggle { all: unset; cursor: pointer; display: inline-flex; align-items: baseline; gap: 8px; min-width: 0; }
  .head button.toggle:focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; border-radius: 3px; }
  .head .caret { font: 10px var(--mono); color: var(--muted); width: 8px; display: inline-block; transition: transform .15s var(--ease); }
  .head [aria-expanded="true"] .caret { transform: rotate(90deg); }
  .label { font: 600 10.5px var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--tone, var(--text-2)); white-space: nowrap; }
  .name { font: 600 12.5px var(--mono); color: var(--text); overflow-wrap: anywhere; }
  .chips { display: inline-flex; flex-wrap: wrap; gap: 4px 6px; }
  .chips .chip { font-size: 10.5px; padding: 0 7px; }
  .chip.tone-green, .chip.tone-red, .chip.tone-amber, .chip.tone-cyan { color: var(--tone); border-color: var(--tone-line); background: var(--tone-dim); }
  .line { font: 12.5px/1.55 var(--mono); color: var(--text-2); overflow-wrap: anywhere; }
  .phase .line { color: var(--text); }
  .phase .arrow { color: var(--cyan); padding: 0 6px; }
  .preview { margin-top: 3px; font: 12.5px/1.5 var(--sans); color: var(--text-2); overflow-wrap: anywhere;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .preview.mono { font-family: var(--mono); font-size: 12px; }
  .errline { margin-top: 5px; font: 12px/1.5 var(--mono); color: #ffc2c7; overflow-wrap: anywhere; white-space: pre-wrap; max-height: 6em; overflow: hidden; }
  .body { margin-top: 8px; display: grid; gap: 8px; }
  .pane { min-width: 0; }
  .pane .k { margin-bottom: 4px; display: flex; justify-content: space-between; gap: 8px; }
  pre.code { margin: 0; padding: 10px 12px; max-height: 420px; overflow: auto; border-radius: var(--radius-sm); background: #05090b; border: 1px solid var(--line);
    font: 12px/1.55 var(--mono); color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 2; }
  pre.code.err { border-color: var(--red-line); color: #ffd0d4; }
  .j-k { color: var(--cyan); } .j-s { color: #a8e6c1; } .j-n { color: var(--amber); } .j-b { color: #c9a7ff; }
  .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 6px 14px; font: 12px var(--mono); }
  .metrics .k { font-size: 9.5px; }
  .metrics .v { font-size: 12.5px; margin-top: 1px; }
  .run-sep .card { padding-top: 10px; }
  .run-sep .name { font-size: 13px; }
  .tl-foot { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; margin-top: 10px; }
  .jump { position: absolute; right: 16px; bottom: 14px; z-index: 3; box-shadow: var(--shadow); }
  .earlier { width: 100%; justify-content: center; margin-bottom: 4px; }

  /* Raw logs */
  .rawlog { margin-top: 14px; }
  .rawlog .tl-tools { margin-bottom: 8px; }
  .logs { list-style: none; margin: 0; padding: 6px 0; max-height: 52vh; overflow-y: auto; border-radius: var(--radius-sm); background: #030607; border: 1px solid var(--line); font: 12px/1.55 var(--mono); }
  .logs li { display: grid; grid-template-columns: 96px 46px minmax(0, 11em) minmax(0, 13em) minmax(0, 1fr); gap: 2px 12px; padding: 2px 14px; color: var(--text-2); }
  .logs li:hover { background: rgba(255, 255, 255, .025); }
  .logs .t { color: var(--muted); white-space: nowrap; }
  .logs .sev { font-weight: 600; letter-spacing: .08em; color: var(--tone); }
  .logs .who { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .logs .ev { color: var(--cyan); overflow-wrap: anywhere; }
  .logs .d { color: var(--text); overflow-wrap: anywhere; }
  .logs .note { display: block; padding: 14px; color: var(--muted); }

  @media (max-width: 640px) {
    .hero { padding: 14px; }
    .hero h1 { font-size: 18px; }
    .item { --rail: 18px; }
    .item.sub { --rail: 30px; }
    .item .when { display: none; }
    .item .mark { left: 2px; }
    .item.sub .mark { left: 14px; }
    .item::before { left: 7px; }
    .item .head .t-inline { display: inline; }
    .timeline { max-height: 70vh; }
    .logs li { grid-template-columns: auto auto minmax(0, 1fr); }
    .logs .who { display: none; }
    .logs .d { grid-column: 1 / -1; }
  }
  .t-inline { display: none; font: 11px var(--mono); color: var(--faint); }
`;

/**
 * Agent detail view (`/agent?id=<identifier>`): an execution trace of one claimed issue. It polls
 * /api/v1/<identifier> (state, sessions, usage), /timeline (orchestrator and agent events, incremental by
 * `seq`) and /transcript (prompts, model calls, tool calls and results of each session, incremental by byte
 * offset) on the dashboard's 2 s interval. Bodies of prompts, responses and tool payloads are only put into
 * the DOM when an item is expanded. All agent and tracker text is inserted with textContent (untrusted).
 */
export const AGENT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Agent · Symphony</title>
<style>${BASE_CSS}${PIPELINE_CSS}${AGENT_CSS}${AGENT_PAGE_CSS}</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/" aria-label="Symphony agent orchestrator">
      <span class="brand-mark" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,12 6,12 8.5,6 11.5,18 14.5,4 17,15 19,12 22,12"/></svg></span>
      <span class="brand-text"><span class="brand-name">SYMPHONY</span><span class="brand-sub">AGENT TRACE</span></span>
    </a>
    <dl class="sysinfo" aria-live="polite">
      <div><dt>Connection</dt><dd id="sys-status"><span class="badge tone-gray"><span class="dot"></span><span>Connecting</span></span></dd></div>
      <div><dt>Updated</dt><dd id="sys-updated">—</dd></div>
    </dl>
    <div class="actions">
      <a class="btn" href="/">Dashboard</a>
      <a class="btn" href="/logs">Logs</a>
    </div>
  </div>
  <div class="progress" id="progress" aria-hidden="true"></div>
</header>
<p class="sr-only" id="announce" aria-live="polite"></p>
<main>
  <a class="back" href="/" id="back">← Back to agents</a>

  <section class="hero tone-gray" id="hero" aria-labelledby="hero-title">
    <div class="hero-top">
      <div class="tags"><span id="state-slot"><span class="badge tone-gray"><span class="dot"></span><span>Loading</span></span></span><span class="chip" id="attempt" hidden></span></div>
      <div class="hero-id" id="hero-id">Agent</div>
    </div>
    <h1 id="hero-title">Loading agent trace…</h1>
    <div class="hero-repo"><span id="hero-repo"></span><span id="hero-branch" hidden></span><a id="hero-issue" hidden target="_blank" rel="noopener noreferrer">Open issue ↗</a></div>
    <div class="hero-meta" id="hero-meta"></div>
    <div class="hero-metrics" id="hero-metrics"></div>
    <div class="live-line" id="live-line" hidden><span class="k">Now</span><span class="ev" id="live-ev"></span><span class="age" id="live-age"></span><span class="msg" id="live-msg"></span></div>
  </section>

  <section class="pipe-section" id="pipe-section" aria-labelledby="pipe-title" hidden>
    <div class="section-head"><h2 id="pipe-title">Pipeline</h2></div>
    <div id="pipeline"></div>
    <div class="pipe-rows" id="pipe-rows"></div>
  </section>

  <section class="alert" id="alert" role="alert" hidden></section>
  <div class="notice" id="notice" hidden></div>

  <div class="trace" id="trace">
    <section aria-labelledby="tl-title">
      <div class="tl-head">
        <div class="section-head">
          <h2 id="tl-title">Execution timeline <span class="count" id="tl-count"></span></h2>
          <div class="actions">
            <button type="button" id="expand-all">Expand all</button>
            <button type="button" id="collapse-all">Collapse</button>
          </div>
        </div>
        <div class="tl-tools">
          <div class="seg" id="filters" role="group" aria-label="Event filter">
            <button type="button" data-f="all" aria-pressed="true">All<span class="n"></span></button>
            <button type="button" data-f="lifecycle" class="tone-green" aria-pressed="false">Lifecycle<span class="n"></span></button>
            <button type="button" data-f="phase" class="tone-cyan" aria-pressed="false">Phases<span class="n"></span></button>
            <button type="button" data-f="model" class="tone-cyan" aria-pressed="false">Model<span class="n"></span></button>
            <button type="button" data-f="tools" class="tone-green" aria-pressed="false">Tools<span class="n"></span></button>
            <button type="button" data-f="errors" class="tone-red" aria-pressed="false">Errors<span class="n"></span></button>
          </div>
          <input type="search" id="tl-q" placeholder="Search events, tools, text…" aria-label="Search the timeline">
        </div>
        <div class="meta" id="tl-meta"></div>
      </div>
      <div class="tl-wrap">
        <button type="button" class="earlier" id="earlier" hidden></button>
        <ol class="timeline" id="timeline" aria-live="off"><li class="note">$ loading trace …</li></ol>
        <button type="button" class="btn-primary jump" id="jump" hidden>↓ Latest</button>
      </div>
      <div class="tl-foot">
        <span class="meta" id="tl-follow">Following live events</span>
        <button type="button" id="raw-toggle" aria-expanded="false" aria-controls="rawlog">Show raw logs</button>
      </div>
      <div class="rawlog" id="rawlog" hidden>
        <div class="tl-tools">
          <div class="seg" id="raw-sev" role="group" aria-label="Severity">
            <button type="button" data-sev="" aria-pressed="true">All</button>
            <button type="button" data-sev="debug" class="tone-gray" aria-pressed="false">Debug</button>
            <button type="button" data-sev="info" class="tone-cyan" aria-pressed="false">Info</button>
            <button type="button" data-sev="warn" class="tone-amber" aria-pressed="false">Warn</button>
            <button type="button" data-sev="error" class="tone-red" aria-pressed="false">Error</button>
          </div>
          <input type="search" id="raw-q" placeholder="Filter event or message…" aria-label="Filter raw logs">
        </div>
        <ol class="logs" id="raw-list"></ol>
        <div class="tl-foot"><span class="meta" id="raw-count"></span><span class="actions" id="raw-links"></span></div>
      </div>
    </section>

    <aside class="side" aria-label="Agent summary">
      <section aria-labelledby="int-title" id="int-section" hidden>
        <h2 id="int-title"><span>Integrations</span></h2>
        <div id="int-body"></div>
      </section>
      <section aria-labelledby="life-title">
        <h2 id="life-title">Agent lifecycle</h2>
        <ul class="milestones" id="milestones"></ul>
        <dl class="kv" id="life-kv"></dl>
      </section>
      <section aria-labelledby="tok-title">
        <h2 id="tok-title">Token usage</h2>
        <div class="big" id="tok-total">—</div>
        <div class="big-sub" id="tok-sub"></div>
        <dl class="kv" id="tok-kv"></dl>
        <div class="chart" id="tok-chart" hidden></div>
      </section>
      <section aria-labelledby="cost-title">
        <h2 id="cost-title">Estimated cost</h2>
        <div class="big" id="cost-total">—</div>
        <div class="big-sub" id="cost-sub"></div>
        <dl class="kv" id="cost-kv"></dl>
      </section>
      <section aria-labelledby="runs-title">
        <h2 id="runs-title">Sessions <span class="count" id="runs-count"></span></h2>
        <ul class="runs" id="runs"></ul>
      </section>
      <section aria-labelledby="issue-title" id="issue-section" hidden>
        <h2 id="issue-title">Issue</h2>
        <div class="issue-labels" id="issue-labels"></div>
        <dl class="kv" id="issue-kv"></dl>
        <div id="issue-extra"></div>
      </section>
      <section aria-labelledby="ctx-title">
        <h2 id="ctx-title">Run context</h2>
        <dl class="kv" id="ctx-kv"></dl>
      </section>
    </aside>
  </div>
</main>

<script>
(() => {
${BASE_JS}
${PIPELINE_JS}

  const $ = (id) => document.getElementById(id);
  const setText = (node, text) => { text = String(text ?? ''); if (node.textContent !== text) node.textContent = text; };
  const ID = new URLSearchParams(location.search).get('id') || '';
  const API = '/api/v1/' + encodeURIComponent(ID);
  const POLL_MS = 2000;
  const RENDER_LIMIT = 400;
  const splitId = (identifier) => {
    const i = String(identifier).lastIndexOf('#');
    return i > 0 ? { repo: identifier.slice(0, i), num: identifier.slice(i) } : { repo: '', num: String(identifier) };
  };
  const oneLine = (s, n) => { s = String(s || '').slice(0, (n || 240) * 2).replace(/\\s+/g, ' ').trim(); return s.length > (n || 240) ? s.slice(0, (n || 240) - 1) + '…' : s; };
  const fmtCost = (n) => (n === null || n === undefined ? 'N/A' : n > 0 && n < 1 ? '$' + n.toFixed(4) : fmtUsd(n));
  const fmtMs = (ms) => (ms === null || ms === undefined ? 'N/A' : ms < 1000 ? Math.round(ms) + 'ms' : ms < 60000 ? (ms / 1000).toFixed(1) + 's' : fmtDuration(ms / 1000));
  const fmtStamp = (iso) => (iso ? new Date(iso).toLocaleDateString([], { month: '2-digit', day: '2-digit' }) + ' ' + fmtClock(iso) : '—');
  const callTokens = (u) => (u ? u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens : 0);

  // Same phase → status mapping as the dashboard cards.
  const PHASE_STATUS = {
    PreparingWorkspace: 'starting', BuildingPrompt: 'starting', LaunchingAgentProcess: 'starting', InitializingSession: 'starting',
    StreamingTurn: 'running', RunningChecks: 'checking', Finishing: 'finishing', Succeeded: 'completed',
    Failed: 'failed', TimedOut: 'failed', Stalled: 'failed', CanceledByReconciliation: 'stopping',
  };
  const STATUS = {
    running: ['Running', 'green', true], starting: ['Starting', 'cyan', true], checking: ['Running checks', 'cyan', true],
    finishing: ['Finishing', 'green', false], completed: ['✓ Completed', 'green', false], failed: ['✕ Failed', 'red', false],
    stopping: ['Stopping', 'amber', false],
  };
  const WINDOW_WORDS = { five_hour: 'five hour', seven_day: 'seven day', seven_day_opus: 'seven day Opus', seven_day_sonnet: 'seven day Sonnet' };
  const windowWords = (w) => WINDOW_WORDS[w] || String(w || '').replace(/_/g, ' ');
  const OUTCOME = {
    handed_off: ['✓ Completed', 'green', 'handed off'], continuing: ['✓ Session done', 'green', 'continues'],
    failed: ['✕ Failed', 'red', 'failed'], stalled: ['✕ Stalled', 'red', 'stalled'],
    stopped: ['■ Stopped', 'amber', 'stopped'], shutdown: ['■ Shut down', 'amber', 'shutdown'], session_limit: ['⏳ Session limit', 'amber', 'session limit'],
  };

  const S = {
    detail: null, fetchedAt: 0, notFound: false, ended: false, online: true,
    events: [], seq: 0, firstSeq: 1,
    tx: new Map(), // run → { offset, entries, available, reason, done }
    items: [], filter: 'all', q: '', expanded: new Set(), collapsed: new Set(), limit: RENDER_LIMIT,
    rendered: false, nodes: new Map(), listSig: '', unseen: 0, known: new Set(), fresh: new Set(),
    rawOpen: false, rawSev: '', rawQ: '',
  };

  // ------------------------------------------------------------------ data loading (one poll loop)

  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    const body = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, body };
  }

  async function loadTranscript(session) {
    let t = S.tx.get(session.run);
    if (!t) { t = { offset: 0, entries: [], available: null, reason: null, done: false }; S.tx.set(session.run, t); }
    if (t.done || !session.transcript) return false;
    let changed = false;
    for (let i = 0; i < 8; i++) {
      const r = await getJson(API + '/transcript?run=' + encodeURIComponent(session.run) + '&from=' + t.offset);
      if (!r.ok || !r.body) return changed;
      t.available = r.body.available;
      t.reason = r.body.reason;
      if (!r.body.available) return changed;
      if (r.body.entries.length) { t.entries.push(...r.body.entries); changed = true; }
      t.offset = r.body.next_offset;
      if (!r.body.more) break;
    }
    if (session.finished_at && t.available) t.done = true;
    return changed;
  }

  let polling = false;
  async function poll() {
    if (polling || !ID) return;
    polling = true;
    const progress = $('progress');
    progress.classList.remove('tick'); void progress.offsetWidth; progress.classList.add('tick');
    try {
      const r = await getJson(API);
      S.online = true;
      if (r.status === 404) {
        if (S.detail) S.ended = true; else S.notFound = true;
      } else if (!r.ok || !r.body) {
        throw new Error(r.body && r.body.error ? r.body.error.message : 'HTTP ' + r.status);
      } else {
        S.detail = r.body; S.fetchedAt = Date.now(); S.ended = false; S.notFound = false;
        if (r.body.timeline_seq > S.seq) {
          const t = await getJson(API + '/timeline?after=' + S.seq);
          if (t.ok && t.body) {
            S.dirty = true;
            S.events.push(...t.body.events);
            S.seq = t.body.latest_seq;
            S.firstSeq = t.body.first_seq;
            if (S.events.length > 4000) S.events.splice(0, S.events.length - 4000);
          }
        }
        for (const session of r.body.sessions) if (await loadTranscript(session)) S.dirty = true;
      }
    } catch (error) {
      S.online = false;
      S.error = error.message;
    }
    polling = false;
    render();
  }

  // ------------------------------------------------------------------ timeline model
  // Every item: { key, at, ms, order, type, cat, tone, level, err, sig, title, ... }. New event types only need
  // an entry in describeEvent (orchestrator/agent events) or in fromTranscript (transcript lines).

  const COVERED_BY_TRANSCRIPT = new Set(['assistant_message', 'tool_use', 'tool_result', 'tracker_tool']);
  const CATEGORY = {
    run_dispatched: 'lifecycle', run_finished: 'lifecycle', retry_scheduled: 'lifecycle', issue_paused: 'lifecycle',
    session_limit_wait: 'lifecycle', worker_restarted: 'lifecycle',
    session_started: 'lifecycle', session_configured: 'lifecycle', startup_failed: 'lifecycle', agent_exited: 'lifecycle',
    phase: 'phase',
    turn_started: 'model', turn_completed: 'model', turn_failed: 'model', turn_cancelled: 'model', turn_timeout: 'model',
    assistant_message: 'model', api_retry: 'model', rate_limit: 'model', agent_error: 'model',
    tool_use: 'tools', tool_result: 'tools', tracker_tool: 'tools', approval_auto_approved: 'tools', approval_denied: 'tools',
    permission_denied: 'tools', turn_input_required: 'tools', transition_denied: 'tools',
    checks_started: 'tools', checks_cached: 'tools', checks_skipped: 'tools', checks_finished: 'tools',
  };
  const label = (event) => String(event).replace(/_/g, ' ');

  function describeEvent(e) {
    const d = e.detail || {};
    const base = { key: 'e' + e.seq, at: e.at, ms: Date.parse(e.at), order: e.seq, run: e.run, cat: CATEGORY[e.event] || (String(e.event).startsWith('checks') ? 'tools' : 'other'),
      level: e.level, err: e.level === 'error' || e.level === 'warn', tone: e.level === 'error' ? 'red' : e.level === 'warn' ? 'amber' : 'gray',
      type: 'event', title: label(e.event).toUpperCase(), name: '', line: e.message || '', chips: [], sig: String(e.seq) };
    switch (e.event) {
      case 'run_dispatched':
        return { ...base, type: 'run', tone: 'green', glyph: '●', title: d.continuation ? 'CONTINUATION SESSION' : d.attempt ? 'RETRY ATTEMPT ' + d.attempt : 'AGENT STARTED',
          name: (d.role || '') + ' · ' + (d.state || ''), line: 'Run ' + e.run + (d.model ? ' · model ' + d.model : ' · Claude Code default model') + (d.model_label ? ' (label ' + d.model_label + ')' : '') +
            (d.effort ? ' · effort ' + d.effort + (d.effort_label ? ' (label ' + d.effort_label + ')' : '') : '') };
      case 'run_finished': {
        const o = OUTCOME[d.outcome] || [d.outcome, 'gray'];
        const failed = d.outcome === 'failed' || d.outcome === 'stalled';
        const limited = d.outcome === 'session_limit';
        return { ...base, type: 'finish', tone: o[1], glyph: failed ? '✕' : limited ? '⏳' : '■', err: failed, title: 'RUN ' + String(o[2] || d.outcome).toUpperCase(),
          name: d.next_role ? '→ ' + d.next_role : '', line: failed ? '' : d.reason || '', errText: failed ? d.reason : '',
          chips: [[pad2(d.turns) + ' turns'], [fmtCompact(d.tokens && d.tokens.total_tokens) + ' tokens'], [fmtCost(d.cost_usd)], [fmtDuration(d.agent_seconds)]] };
      }
      case 'retry_scheduled':
        if (d.kind === 'session_limit') {
          const lim = d.limit || {};
          return { ...base, type: 'event', tone: 'amber', glyph: '⏳', err: false,
            title: lim.waiting ? 'WAITING FOR RESET' : 'SESSION LIMIT · RETRY ' + lim.hits + '/' + lim.max_retries,
            line: (lim.text ? lim.text + ' · ' : '') + 'retry at ' + fmtStamp(d.due_at) };
        }
        return { ...base, type: 'event', tone: d.kind === 'failure' ? 'amber' : 'cyan', glyph: '↻', title: d.kind === 'failure' ? 'RETRY #' + d.attempt + ' SCHEDULED' : 'CONTINUATION QUEUED',
          err: false, line: (d.error ? 'Reason: ' + d.error + ' · ' : '') + 'next attempt ' + fmtStamp(d.due_at) };
      case 'session_limit_wait':
        return { ...base, tone: 'amber', glyph: '⏳', title: 'WAITING FOR SESSION LIMIT', err: false,
          line: 'Resets at ' + fmtStamp(d.resets_at) + (d.window ? ' (' + windowWords(d.window) + ')' : '') + ' · retry at ' + fmtStamp(d.retry_at) };
      case 'worker_restarted':
        return { ...base, tone: 'cyan', glyph: '↻', title: 'WORKER RESTARTED', err: false, line: e.message || '' };
      case 'issue_paused':
        return { ...base, tone: 'gray', glyph: '⏸', title: 'PAUSED', err: false };
      case 'phase':
        return { ...base, type: 'phase', cat: 'phase', tone: 'cyan', glyph: '◇', title: 'PHASE', from: d.from, to: d.to, line: '' };
      case 'session_configured':
        return { ...base, tone: 'cyan', glyph: '◆', title: 'SESSION CONFIGURED', name: d.model || '', line: e.message || '' };
      case 'turn_started':
        return { ...base, tone: 'cyan', glyph: '▸', title: 'TURN ' + (e.turn || '') + ' STARTED', line: '' };
      case 'turn_completed':
      case 'turn_failed': {
        const failed = e.event === 'turn_failed';
        const u = d.usage;
        return { ...base, type: 'turn', tone: failed ? 'red' : 'green', glyph: failed ? '✕' : '✓', err: failed, title: 'TURN ' + (e.turn || '') + (failed ? ' FAILED' : ' COMPLETED'),
          line: failed ? '' : e.message || '', errText: failed ? e.message : '',
          chips: [u ? [fmtInt(u.total_tokens) + ' tokens (session)'] : null, d.cost_usd !== undefined ? [fmtCost(d.cost_usd) + ' (session)'] : null, d.duration_ms !== undefined ? [fmtMs(d.duration_ms)] : null].filter(Boolean) };
      }
      case 'tracker_tool': {
        const ok = d.ok !== false;
        return { ...base, type: 'tool', cat: 'tools', tone: ok ? 'green' : 'red', glyph: ok ? '●' : '✕', err: !ok, title: ok ? 'TOOL CALL' : 'TOOL FAILED', name: 'tracker.' + (d.tool || '?'),
          line: ok ? e.message : '', errText: ok ? '' : e.message, chips: [[ok ? 'success' : 'failed', ok ? 'green' : 'red'], d.duration_ms !== undefined ? [fmtMs(d.duration_ms)] : null].filter(Boolean) };
      }
      case 'tool_use':
        return { ...base, type: 'event', cat: 'tools', tone: 'green', glyph: '◆', title: 'TOOL CALL', name: d.tool || '', line: e.message || '' };
      case 'assistant_message':
        return { ...base, type: 'event', tone: 'green', glyph: '●', title: 'ASSISTANT RESPONSE', line: e.message || '' };
      case 'checks_finished':
        return { ...base, tone: d.ok === false ? 'red' : 'green', glyph: d.ok === false ? '✕' : '✓', err: d.ok === false, errText: d.ok === false ? e.message : '', line: d.ok === false ? '' : e.message };
      default:
        return { ...base, glyph: base.err ? '!' : '·', errText: base.err ? e.message : '', line: base.err ? '' : base.line };
    }
  }

  function fromTranscript(run, entries, out) {
    const results = new Map();
    for (const x of entries) if (x.type === 'tool_result') results.set(x.tool_use_id, x);
    let prevAt = null;
    let group = null;
    const usedResults = new Set();
    const k = (x, suffix) => 'x' + run + ':' + x.offset + (suffix === undefined ? '' : ':' + suffix);
    for (const x of entries) {
      const ms = Date.parse(x.at);
      const common = { at: x.at, ms, order: 1e9 + x.offset, run };
      if (x.type === 'model_call') {
        const id = x.message_id || String(x.offset);
        if (!group || group.id !== id) {
          group = { id, item: { ...common, key: 'm' + run + ':' + id, type: 'model', cat: 'model', tone: 'cyan', glyph: '◇', title: 'MODEL INVOCATION',
            model: x.model, usage: x.usage, cost: x.cost_usd, wait: prevAt === null ? null : ms - prevAt, sub: !!x.parent_tool_use_id, err: !!x.error, errText: x.error ? 'API error: ' + x.error : '', level: x.error ? 'error' : 'info' } };
          out.push(group.item);
        } else {
          group.item.usage = x.usage || group.item.usage;
          group.item.cost = x.cost_usd ?? group.item.cost;
        }
        x.blocks.forEach((b, i) => {
          const sub = !!x.parent_tool_use_id;
          if (b.type === 'text' && b.text.trim()) {
            out.push({ ...common, key: k(x, i), type: 'response', cat: 'model', tone: 'green', glyph: '●', title: sub ? 'SUBAGENT RESPONSE' : 'ASSISTANT RESPONSE', text: b.text, truncated: b.truncated, length: b.length, sub, level: 'info' });
          } else if (b.type === 'thinking' && b.text.trim()) {
            out.push({ ...common, key: k(x, i), type: 'thinking', cat: 'model', tone: 'gray', glyph: '◌', title: 'THINKING', text: b.text, truncated: b.truncated, length: b.length, sub, level: 'debug' });
          } else if (b.type === 'tool_use') {
            const res = results.get(b.id);
            if (res) usedResults.add(b.id);
            const failed = !!(res && res.is_error);
            const status = !res ? 'running' : failed ? 'failed' : 'success';
            out.push({ ...common, key: 't' + run + ':' + (b.id || x.offset + ':' + i), type: 'toolcall', cat: 'tools', sub,
              tone: status === 'running' ? 'amber' : failed ? 'red' : 'green', glyph: status === 'running' ? '◐' : failed ? '✕' : '●',
              title: failed ? 'TOOL FAILED' : 'TOOL CALL', name: b.name, input: b.input, inputTruncated: b.truncated, result: res || null, status,
              duration: res ? Date.parse(res.at) - ms : null, err: failed, errText: failed ? res.text : '', level: failed ? 'warn' : 'info' });
          }
        });
      } else {
        group = null;
        if (x.type === 'prompt' || x.type === 'user_message') {
          out.push({ ...common, key: k(x), type: 'prompt', cat: 'model', tone: 'gray', glyph: '◆', title: x.type === 'prompt' ? 'PROMPT' + (x.turn ? ' · TURN ' + x.turn : '') : 'USER MESSAGE',
            text: x.text, truncated: x.truncated, length: x.length, level: 'info' });
        } else if (x.type === 'system' && x.subtype === 'compact_boundary') {
          out.push({ ...common, key: k(x), type: 'event', cat: 'model', tone: 'cyan', glyph: '⇣', title: 'CONTEXT COMPACTION', line: x.text, level: 'info', chips: [] });
        }
      }
      prevAt = ms;
    }
    for (const x of entries) {
      if (x.type !== 'tool_result' || usedResults.has(x.tool_use_id)) continue;
      out.push({ at: x.at, ms: Date.parse(x.at), order: 1e9 + x.offset, run, key: 'xr' + run + ':' + x.offset, type: 'event', cat: 'tools', tone: x.is_error ? 'red' : 'green',
        glyph: x.is_error ? '✕' : '●', title: 'TOOL RESULT', line: x.is_error ? '' : oneLine(x.text, 200), errText: x.is_error ? x.text : '', err: x.is_error, chips: [], level: x.is_error ? 'warn' : 'info' });
    }
  }

  function buildItems() {
    const out = [];
    const withTx = new Set();
    for (const [run, t] of S.tx) if (t.available && t.entries.length) { withTx.add(run); fromTranscript(run, t.entries, out); }
    for (const e of S.events) {
      if (e.kind === 'agent' && withTx.has(e.run) && COVERED_BY_TRANSCRIPT.has(e.event)) continue;
      out.push(describeEvent(e));
    }
    for (const it of out) {
      it.text = it.text ?? '';
      it.sig = it.sig || [it.status, it.usage ? callTokens(it.usage) : '', it.cost, it.result ? 1 : 0].join('|');
    }
    out.sort((a, b) => a.ms - b.ms || a.order - b.order);
    return out;
  }

  const matches = (it) => {
    if (S.filter === 'errors' ? !it.err : S.filter !== 'all' && it.cat !== S.filter) return false;
    if (!S.q) return true;
    it.hay ??= [it.title, it.name, it.line, it.model, it.errText, it.text && it.text.slice(0, 4000), it.input && it.input.slice(0, 2000)].filter(Boolean).join(' ').toLowerCase();
    return it.hay.includes(S.q);
  };

  // ------------------------------------------------------------------ timeline rendering

  function jsonPre(text, className) {
    const pre = el('pre', null, 'code' + (className ? ' ' + className : ''));
    let parsed = false;
    try { JSON.parse(text); parsed = true; } catch {}
    if (!parsed || text.length > 200000) { pre.textContent = text; return pre; }
    // Light JSON highlighting: keys, strings, numbers, literals.
    const re = /("(?:\\\\.|[^"\\\\])*")(\\s*:)?|\\b(true|false|null)\\b|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) pre.append(text.slice(last, m.index));
      if (m[1]) { pre.append(el('span', m[1], m[2] ? 'j-k' : 'j-s')); if (m[2]) pre.append(m[2]); }
      else pre.append(el('span', m[0], m[3] ? 'j-b' : 'j-n'));
      last = re.lastIndex;
    }
    pre.append(text.slice(last));
    return pre;
  }

  function pane(title, node, extra) {
    const p = el('div', null, 'pane');
    const k = el('div', null, 'k');
    k.append(el('span', title));
    if (extra) k.append(el('span', extra));
    p.append(k, node);
    return p;
  }
  const sizeNote = (it) => (it.truncated ? 'first ' + fmtInt(it.text.length) + ' of ' + fmtInt(it.length) + ' chars' : fmtInt(it.text.length) + ' chars');

  /** The expandable part, built only when the item is open. */
  function buildBody(it) {
    const body = el('div', null, 'body');
    if (it.type === 'prompt' || it.type === 'response' || it.type === 'thinking') {
      body.append(pane(it.type === 'prompt' ? 'Prompt' : it.type === 'thinking' ? 'Thinking' : 'Response', jsonPre(it.text), sizeNote(it)));
    } else if (it.type === 'toolcall') {
      body.append(pane('Arguments', jsonPre(it.input || '{}'), it.inputTruncated ? 'truncated' : ''));
      if (it.result) {
        body.append(pane(it.result.is_error ? 'Error' : 'Result', jsonPre(it.result.text || '(empty)', it.result.is_error ? 'err' : ''), sizeNote(it.result)));
      } else body.append(el('div', 'Waiting for the tool result…', 'line'));
    } else if (it.type === 'model') {
      const m = el('div', null, 'metrics');
      const u = it.usage;
      const add = (k, v) => { const d = el('div'); d.append(el('span', k, 'k'), el('span', v, 'v')); m.append(d); };
      add('Model', it.model || 'N/A');
      add('Input', u ? fmtInt(u.input_tokens) : 'N/A');
      add('Cache read', u ? fmtInt(u.cache_read_tokens) : 'N/A');
      add('Cache write', u ? fmtInt(u.cache_write_tokens) : 'N/A');
      add('Output', u ? fmtInt(u.output_tokens) : 'N/A');
      add('Total', u ? fmtInt(callTokens(u)) : 'N/A');
      add('Est. cost', fmtCost(it.cost));
      add('Since prev. step', fmtMs(it.wait));
      body.append(m);
    } else if (it.errText) {
      body.append(pane('Details', jsonPre(it.errText, 'err')));
    }
    return body;
  }
  const expandable = (it) => ['prompt', 'response', 'thinking', 'toolcall', 'model'].includes(it.type) || (it.errText && it.errText.length > 300);
  const isOpen = (it) => S.expanded.has(it.key);

  function buildItem(it, fresh) {
    const li = el('li', null, 'item tone-' + it.tone + (it.type === 'phase' ? ' phase' : ' boxed') + (it.err ? (it.level === 'error' || it.tone === 'red' ? ' err' : ' warn') : '') +
      (it.sub ? ' sub' : '') + (it.type === 'run' ? ' run-sep' : '') + (fresh ? ' fresh' : ''));
    li.dataset.key = it.key;
    li.append(el('time', fmtClock(it.at), 'when'));
    const mark = el('span', it.glyph === '●' ? '' : it.glyph, 'mark' + (it.glyph === '●' ? ' dot' : ''));
    mark.setAttribute('aria-hidden', 'true');
    li.append(mark);
    const card = el('div', null, 'card');
    const head = el('div', null, 'head');
    const open = isOpen(it);
    let titleHost = head;
    if (expandable(it)) {
      const b = el('button', null, 'toggle');
      b.type = 'button';
      b.setAttribute('aria-expanded', String(open));
      b.append(el('span', '▸', 'caret'));
      head.append(b);
      titleHost = b;
    }
    titleHost.append(el('span', fmtClock(it.at), 't-inline'), el('span', it.title, 'label'));
    if (it.type === 'model') {
      titleHost.append(el('span', it.model || 'model N/A', 'name'));
      const chips = el('span', null, 'chips');
      chips.append(el('span', it.usage ? fmtInt(callTokens(it.usage)) + ' tokens' : 'tokens N/A', 'chip'));
      if (it.usage) chips.append(el('span', '↑' + fmtCompact(it.usage.input_tokens + it.usage.cache_read_tokens + it.usage.cache_write_tokens) + ' ↓' + fmtCompact(it.usage.output_tokens), 'chip'));
      if (it.cost !== null && it.cost !== undefined) chips.append(el('span', fmtCost(it.cost), 'chip'));
      if (it.wait !== null) chips.append(el('span', '~' + fmtMs(it.wait), 'chip'));
      head.append(chips);
    } else if (it.type === 'toolcall') {
      const owner = toolIntegration(it);
      if (owner) { const icon = integrationIcon(owner.id, 14); icon.title = owner.label; icon.removeAttribute('aria-hidden'); icon.alt = owner.label; titleHost.append(icon); }
      titleHost.append(el('span', it.name, 'name'));
      const chips = el('span', null, 'chips');
      chips.append(el('span', it.status, 'chip tone-' + (it.status === 'running' ? 'amber' : it.status === 'failed' ? 'red' : 'green')));
      if (it.duration !== null) chips.append(el('span', fmtMs(it.duration), 'chip'));
      head.append(chips);
    } else if (it.type === 'phase') {
      const line = el('span', null, 'line');
      line.append(el('span', it.from || '?'), el('span', '→', 'arrow'), el('span', it.to || '?'));
      head.append(line);
    } else {
      if (it.name) titleHost.append(el('span', it.name, 'name'));
      if (it.chips && it.chips.length) {
        const chips = el('span', null, 'chips');
        for (const [text, tone] of it.chips) chips.append(el('span', text, 'chip' + (tone ? ' tone-' + tone : '')));
        head.append(chips);
      }
    }
    card.append(head);
    if (it.type === 'prompt' || it.type === 'response' || it.type === 'thinking') {
      if (!open) card.append(el('div', oneLine(it.text, 320), 'preview' + (it.type === 'prompt' ? ' mono' : '')));
    } else if (it.type === 'toolcall') {
      if (!open && !it.err) card.append(el('div', oneLine(it.input, 200), 'preview mono'));
    } else if (it.line) card.append(el('div', it.line, 'line'));
    if (it.err && it.errText && !open) card.append(el('div', it.errText.length > 600 ? it.errText.slice(0, 600) + '…' : it.errText, 'errline'));
    if (open) card.append(buildBody(it));
    li.append(card);
    return li;
  }

  function setOpen(key, open) {
    if (open) S.expanded.add(key); else S.expanded.delete(key);
    const it = S.items.find((x) => x.key === key);
    const node = S.nodes.get(key);
    if (!it || !node) return;
    const li = buildItem(it, false);
    node.li.replaceWith(li);
    S.nodes.set(key, { li, sig: it.sig + (open ? '+' : '-') });
  }

  function renderTimeline() {
    const list = $('timeline');
    const counts = { all: 0, lifecycle: 0, phase: 0, model: 0, tools: 0, errors: 0 };
    for (const it of S.items) { counts.all++; if (counts[it.cat] !== undefined) counts[it.cat]++; if (it.err) counts.errors++; }
    for (const b of $('filters').querySelectorAll('button')) setText(b.querySelector('.n'), counts[b.dataset.f] ? counts[b.dataset.f] : '');
    setText($('tl-count'), S.items.length ? fmtInt(S.items.length) + ' events' : '');

    const visible = S.items.filter(matches);
    const shown = visible.slice(-S.limit);
    const earlier = $('earlier');
    earlier.hidden = visible.length <= shown.length;
    setText(earlier, 'Show ' + fmtInt(Math.min(RENDER_LIMIT, visible.length - shown.length)) + ' earlier events (' + fmtInt(visible.length - shown.length) + ' hidden)');

    const sig = shown.map((it) => it.key + '~' + it.sig + (isOpen(it) ? '+' : '-')).join(',');
    if (sig === S.listSig) return;
    S.listSig = sig;

    // Keep the reader's place: remember the first visible item and its offset.
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    let anchor = null;
    if (!atBottom) {
      for (const li of list.children) {
        if (li.offsetTop + li.offsetHeight > list.scrollTop) { anchor = { key: li.dataset.key, delta: li.offsetTop - list.scrollTop }; break; }
      }
    }

    const next = new Map();
    let added = 0;
    const nodes = shown.map((it) => {
      const wanted = it.sig + (isOpen(it) ? '+' : '-');
      const old = S.nodes.get(it.key);
      if (old && old.sig === wanted) { next.set(it.key, old); return old.li; }
      const fresh = S.fresh.delete(it.key);
      if (fresh) added++;
      const li = buildItem(it, fresh);
      next.set(it.key, { li, sig: wanted });
      return li;
    });
    S.nodes = next;
    if (!nodes.length) {
      list.replaceChildren(el('li', S.items.length ? 'No events match the filter.' : S.detail || S.ended ? '$ no events recorded yet …' : '$ loading trace …', 'note'));
    } else list.replaceChildren(...nodes);

    if (!S.rendered || atBottom) list.scrollTop = list.scrollHeight;
    else if (anchor) {
      const keep = S.nodes.get(anchor.key);
      if (keep) list.scrollTop = keep.li.offsetTop - anchor.delta;
    }
    if (S.rendered && !atBottom && added) S.unseen += added;
    if (atBottom) S.unseen = 0;
    updateJump();
    S.rendered = S.rendered || S.items.length > 0;
  }

  function updateJump() {
    const list = $('timeline');
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    if (atBottom) S.unseen = 0;
    $('jump').hidden = atBottom;
    setText($('jump'), S.unseen ? '↓ ' + S.unseen + ' new' : '↓ Latest');
    setText($('tl-follow'), atBottom ? (isRunning() ? 'Following live events' : 'At the latest event') : 'Paused following · scroll to the bottom to follow');
  }

  // ------------------------------------------------------------------ header, alert, summary

  const isRunning = () => !!(S.detail && S.detail.running && !S.ended);
  const lastEvent = (name, run) => { for (let i = S.events.length - 1; i >= 0; i--) { const e = S.events[i]; if (e.event === name && (!run || e.run === run)) return e; } return null; };
  const liveRuntime = () => (isRunning() ? S.detail.running.seconds_running + (Date.now() - S.fetchedAt) / 1000 : null);

  function deriveState() {
    const d = S.detail;
    if (!d && S.notFound) return ['Not tracked', 'gray', false];
    if (!d || S.ended || d.status === 'finished') {
      const fin = lastEvent('run_finished');
      if (fin) { const o = OUTCOME[fin.detail.outcome] || ['Ended', 'gray']; return [o[0], o[1], false]; }
      return [d && d.status === 'finished' ? 'Finished' : 'Ended', 'gray', false];
    }
    if (d.status === 'running') return STATUS[PHASE_STATUS[d.running.phase] || 'running'];
    if (d.status === 'stopping') return STATUS.stopping;
    if (d.status === 'retrying' && d.retry && d.retry.kind === 'session_limit' && d.retry.limit) {
      return d.retry.limit.waiting ? ['⏳ Waiting for limit', 'amber', true] : ['⏳ Session limit #' + d.retry.limit.hits, 'amber', true];
    }
    if (d.status === 'retrying') return d.retry && d.retry.kind === 'continuation' ? ['Continuing', 'cyan', false] : ['↻ Retrying #' + (d.retry ? d.retry.attempt : ''), 'amber', true];
    if (d.status === 'paused') return ['⏸ Paused', 'gray', false];
    return ['Claimed', 'gray', false];
  }

  function totals() {
    const d = S.detail;
    if (isRunning()) {
      const r = d.running;
      return { tokens: r.tokens, cost: r.cost_usd, claude: r.claude_estimate_usd, turns: r.turn_count, runtime: liveRuntime(), model: r.model, live: true };
    }
    const fin = lastEvent('run_finished');
    if (!fin) return null;
    const f = fin.detail;
    return { tokens: f.tokens, cost: f.cost_usd, claude: null, turns: f.turns, runtime: f.agent_seconds, model: f.model, live: false };
  }

  let lastStateLabel = '';
  function renderHeader() {
    const d = S.detail;
    const [labelText, tone, pulse] = deriveState();
    const hero = $('hero');
    hero.className = 'hero tone-' + tone;
    const slot = $('state-slot');
    if (lastStateLabel !== labelText + tone) {
      slot.replaceChildren(badge(labelText, tone, pulse));
      if (lastStateLabel) $('announce').textContent = 'Agent state: ' + labelText;
      lastStateLabel = labelText + tone;
    }
    const identifier = (d && d.issue_identifier) || ID;
    const { repo, num } = splitId(identifier);
    const idBox = $('hero-id');
    idBox.replaceChildren(el('span', 'Agent '), el('b', num));
    document.title = num + ' · ' + labelText.replace(/^[^A-Za-z]+/, '') + ' · Symphony';
    setText($('hero-title'), (d && d.title) || identifier);
    setText($('hero-repo'), (d && d.repo && d.repo !== 'unknown' ? d.repo : repo) || '');
    const run = isRunning() ? d.running : null;
    const branch = (run && run.branch) || (d && d.run_trace && d.run_trace.branch);
    $('hero-branch').hidden = !branch;
    setText($('hero-branch'), branch ? '⎇ ' + branch : '');
    const issueLink = $('hero-issue');
    const url = d && d.issue_url;
    issueLink.hidden = !(typeof url === 'string' && /^https?:/.test(url));
    if (!issueLink.hidden && issueLink.getAttribute('href') !== url) issueLink.href = url;
    const attempt = $('attempt');
    const att = d && d.attempts && d.attempts.current_retry_attempt;
    attempt.hidden = !att;
    setText(attempt, 'attempt ' + (att || ''));

    const sessions = (d && d.sessions) || [];
    const lastSession = sessions[sessions.length - 1];
    const t = totals();
    const meta = [];
    meta.push(['role', (d && d.role) || (lastSession && lastSession.role) || 'role N/A']);
    meta.push(['', (t && t.model) || (lastSession && lastSession.model) || 'model N/A']);
    const effort = (run && run.effort) || (lastSession && lastSession.effort);
    if (effort) meta.push(['', 'effort ' + effort]);
    meta.push(['', run ? run.phase : d && d.status === 'retrying' ? 'waiting for retry' : d && d.status === 'paused' ? 'paused' : d && d.status === 'finished' ? 'finished' : S.ended ? 'ended' : '—']);
    if (run && run.state) meta.push(['', 'column ' + run.state]);
    const metaBox = $('hero-meta');
    const metaNodes = [];
    meta.forEach(([cls, text], i) => { if (i) metaNodes.push(el('span', '·', 'sep')); metaNodes.push(el('span', text, cls)); });
    patchChildren(metaBox, metaNodes);

    tilesInto($('hero-metrics'), [
      ['Runtime', t && t.runtime !== null ? fmtDuration(t.runtime) : 'N/A'],
      ['Turn', t ? pad2(t.turns) : 'N/A'],
      ['Tokens', t && t.tokens ? fmtCompact(t.tokens.total_tokens) : 'N/A'],
      ['Est. cost', t ? fmtCost(t.cost) : 'N/A'],
      ['Sessions', pad2(sessions.length)],
      ['Started', lastSession ? fmtClock(lastSession.started_at) : '—'],
    ]);

    const live = $('live-line');
    live.hidden = !run;
    if (run) {
      setText($('live-ev'), run.last_event ? label(run.last_event) : 'waiting for first event');
      setText($('live-age'), run.last_event_at ? '· ' + ago(run.last_event_at) : '');
      setText($('live-msg'), run.stopping ? 'Stopping: ' + run.stopping : run.last_message);
    }
  }

  function tilesInto(host, items) {
    patchChildren(host, items.map(([k, v, cls]) => { const d = el('div'); d.append(el('span', k, 'k'), el('span', v, 'v' + (cls ? ' ' + cls : ''))); return d; }));
  }

  function lastErrorItem() {
    for (let i = S.items.length - 1; i >= 0; i--) if (S.items[i].err && (S.items[i].tone === 'red' || S.items[i].level === 'error')) return S.items[i];
    return null;
  }

  // Outcome of the last restart click; the alert is rebuilt every second, so the button is drawn from here.
  let restartState = null;
  const RESTART_LABELS = { Retry: 'Retry now', Resume: 'Resume now' };
  const RESTART_DISABLED = 'Restart disabled: set SYMPHONY_ALLOW_REMOTE_CONTROL=true behind an authenticating proxy';
  // controls.retry from /api/v1/<identifier>; false on a non-loopback bind without server.allow_remote_control.
  const retryAllowed = () => !S.detail || !S.detail.controls || S.detail.controls.retry !== false;

  function restartButton(verb) {
    if (!retryAllowed()) return el('span', RESTART_DISABLED, 'muted restart-off');
    const b = el('button', restartState ? restartState.label : RESTART_LABELS[verb], 'btn restart' + (restartState && restartState.cls ? ' ' + restartState.cls : ''));
    b.type = 'button';
    b.setAttribute('aria-label', RESTART_LABELS[verb] + ' ' + ID);
    if (restartState && restartState.cls === 'is-busy') b.setAttribute('aria-busy', 'true');
    return b;
  }

  async function restart() {
    if (restartState && restartState.cls === 'is-busy') return;
    restartState = { cls: 'is-busy', label: 'Restarting…' };
    renderAlert();
    let ok = false;
    let label = 'Restart failed';
    try {
      const res = await fetch(API + '/retry', { method: 'POST' });
      let body = null;
      try { body = await res.json(); } catch {}
      ok = res.ok;
      label = ok ? 'Queued' : (body && body.error && body.error.message) || 'Restart failed (' + res.status + ')';
    } catch {}
    restartState = { cls: ok ? 'is-done' : 'is-failed', label };
    renderAlert();
    $('announce').textContent = ID + ': ' + label;
    setTimeout(poll, 500);
    setTimeout(() => { restartState = null; renderAlert(); }, ok ? 1800 : 5000);
  }

  document.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('button.restart')) restart();
  });

  function sessionLimitSpec(d) {
    const r = d.retry;
    const limit = r.limit;
    const sub = [];
    if (limit.window) sub.push(['Window', windowWords(limit.window)]);
    if (limit.resets_at) sub.push(['Resets at', fmtStamp(limit.resets_at)]);
    sub.push(['Retry at', fmtStamp(r.due_at) + ' (in ' + fmtDuration(Math.max(0, Date.parse(r.due_at) - Date.now()) / 1000) + ')']);
    sub.push(['Retries', limit.waiting ? 'used up' : limit.hits <= limit.max_retries ? limit.hits + ' of ' + limit.max_retries : 'backoff']);
    if (limit.text && r.error && r.error !== limit.text) sub.push(['Queue', r.error]);
    if (limit.overage_disabled_reason === 'out_of_credits') sub.push(['Credits', 'Extra usage is off because credits are used up. Top up' + (retryAllowed() ? ', then press Retry now.' : '.')]);
    return { tone: 'amber', title: '⏳ Session limit reached', reason: limit.text || r.error || 'unknown', sub, restart: 'Retry' };
  }

  function renderAlert() {
    const box = $('alert');
    const d = S.detail;
    let spec = null;
    const fin = lastEvent('run_finished');
    const failedRun = fin && (fin.detail.outcome === 'failed' || fin.detail.outcome === 'stalled');
    const errItem = lastErrorItem();
    if (d && !S.ended && d.status === 'retrying' && d.retry && d.retry.kind === 'session_limit' && d.retry.limit) {
      spec = sessionLimitSpec(d);
    } else if (d && !S.ended && d.status === 'retrying' && d.retry && d.retry.kind === 'failure') {
      spec = { tone: 'amber', title: '↻ Retry #' + d.retry.attempt, reason: d.retry.error || d.last_error || 'unknown error',
        sub: [['Next attempt', fmtStamp(d.retry.due_at) + ' (in ' + fmtDuration(Math.max(0, Date.parse(d.retry.due_at) - Date.now()) / 1000) + ')']] };
    } else if (d && !S.ended && d.status === 'stopping') {
      spec = { tone: 'amber', title: '■ Stopping', reason: d.running && d.running.stopping, sub: [] };
    } else if (d && !S.ended && d.status === 'paused') {
      spec = { tone: 'gray', title: '⏸ Agent paused', reason: 'Still active after ' + (d.paused ? d.paused.continuations : '?') + ' continuation session(s). Change the issue on the board (status, comment or labels) to resume' + (retryAllowed() ? ', or press Resume now.' : '.'), sub: [], restart: 'Resume' };
    } else if (failedRun && !isRunning()) {
      spec = { tone: 'red', title: '✕ Agent failed', reason: fin.detail.reason, sub: [] };
    } else if (isRunning() && d.last_error && d.attempts.current_retry_attempt) {
      spec = { tone: 'amber', title: 'Retry attempt ' + d.attempts.current_retry_attempt + ' running', reason: 'Previous failure: ' + d.last_error, sub: [] };
    }
    if (!spec) { box.hidden = true; box.replaceChildren(); return; }
    if (errItem && spec.tone !== 'gray') {
      if (errItem.type === 'toolcall' || errItem.title.startsWith('TOOL')) spec.sub.push(['Failed tool', errItem.name || '?']);
      spec.sub.push(['Last error at', fmtClock(errItem.at)]);
    }
    box.hidden = false;
    box.className = 'alert tone-' + spec.tone;
    const h = el('h2', spec.title);
    const nodes = [h, el('div', spec.reason || '', 'reason')];
    if (spec.sub.length) {
      const sub = el('div', null, 'sub');
      for (const [k, v] of spec.sub) { const s = el('span', k + ' '); s.append(el('b', v)); sub.append(s); }
      nodes.push(sub);
    }
    const showDetails = errItem && spec.tone !== 'gray';
    if (showDetails || spec.restart) {
      const actions = el('div', null, 'actions');
      if (showDetails) {
        const b = el('button', 'View details');
        b.type = 'button';
        b.dataset.goto = errItem.key;
        actions.append(b);
      }
      if (spec.restart) actions.append(restartButton(spec.restart));
      nodes.push(actions);
    }
    patchChildren(box, nodes);
  }

  function kv(host, rows) {
    const nodes = [];
    for (const row of rows) {
      if (row === '-') { const r = el('div', null, 'rule'); nodes.push(r); continue; }
      const [k, v, cls] = row;
      nodes.push(el('dt', k), el('dd', v ?? 'N/A', cls));
    }
    patchChildren(host, nodes);
  }

  function renderSummary() {
    const d = S.detail;
    const t = totals();
    const sessions = (d && d.sessions) || [];
    const first = S.events.find((e) => e.event === 'run_dispatched');
    const lastSession = sessions[sessions.length - 1];
    const run = isRunning() ? d.running : null;
    const ms = [];
    const [stateLabel, stateTone] = deriveState();
    const mile = (tone, k, v) => { const li = el('li'); li.append(el('span', null, 'dot tone-' + tone), el('span', k), el('span', v, 't')); ms.push(li); };
    if (first) mile('gray', 'First session', fmtStamp(first.at));
    if (lastSession) mile('cyan', 'Session started', fmtStamp(lastSession.started_at));
    if (run && run.last_event_at) mile('green', 'Last activity', fmtClock(run.last_event_at));
    if (lastSession && lastSession.finished_at) mile(stateTone, 'Session ended', fmtStamp(lastSession.finished_at));
    mile(stateTone, 'Current', run ? run.phase : stateLabel.replace(/^[^A-Za-z]+/, ''));
    patchChildren($('milestones'), ms);

    const tools = S.items.filter((it) => it.type === 'toolcall' || (it.type === 'tool') || (it.cat === 'tools' && it.title === 'TOOL CALL'));
    const failedTools = tools.filter((it) => it.err).length;
    const models = S.items.filter((it) => it.type === 'model');
    kv($('life-kv'), [
      ['Runtime', t && t.runtime !== null ? fmtDuration(t.runtime) : 'N/A'],
      ['Turns', t ? String(t.turns) : 'N/A'],
      ['Model calls', models.length ? fmtInt(models.length) : S.tx.size ? '0' : 'N/A'],
      ['Tool calls', fmtInt(tools.length) + (failedTools ? ' (' + failedTools + ' failed)' : '')],
      ['Sessions', String(sessions.length)],
      '-',
      ['Tokens', t && t.tokens ? fmtCompact(t.tokens.total_tokens) : 'N/A'],
      ['Cost', t ? fmtCost(t.cost) : 'N/A'],
    ]);

    // Tokens
    setText($('tok-total'), t && t.tokens ? fmtInt(t.tokens.total_tokens) : 'N/A');
    setText($('tok-sub'), t ? (t.live ? 'current session · reported at each turn end' : 'last session') : 'no token data yet');
    const rows = [
      ['Input (incl. cache)', t && t.tokens ? fmtInt(t.tokens.input_tokens) : 'N/A'],
      ['Output', t && t.tokens ? fmtInt(t.tokens.output_tokens) : 'N/A'],
      ['Total', t && t.tokens ? fmtInt(t.tokens.total_tokens) : 'N/A'],
    ];
    const byModel = d && d.usage_by_model ? Object.entries(d.usage_by_model) : [];
    if (byModel.length) {
      rows.push('-');
      for (const [model, u] of byModel) {
        rows.push([model, fmtCompact(u.total_tokens), 'info']);
        rows.push(['  uncached in / out', fmtCompact(u.input_tokens) + ' / ' + fmtCompact(u.output_tokens)]);
        rows.push(['  cache read / write', fmtCompact(u.cache_read_tokens) + ' / ' + fmtCompact(u.cache_write_tokens)]);
      }
    }
    kv($('tok-kv'), rows);
    renderChart(models);

    // Cost
    setText($('cost-total'), t ? fmtCost(t.cost) : 'N/A');
    setText($('cost-sub'), t ? (t.live ? 'current session · priced with model-costs.yml' : 'last session · priced with model-costs.yml') : 'no cost data yet');
    const costRows = [];
    for (const [model, u] of byModel) costRows.push([model, fmtCost(u.cost_usd), 'info']);
    if (t && t.claude !== null && t.claude !== undefined) costRows.push(["Claude Code's estimate", fmtCost(t.claude)]);
    const priced = models.filter((m) => m.cost !== null && m.cost !== undefined);
    if (priced.length) {
      const run0 = lastSession && lastSession.run;
      const inRun = priced.filter((m) => m.run === run0);
      if (costRows.length) costRows.push('-');
      costRows.push(['Model calls (this session)', fmtCost(inRun.reduce((s, m) => s + m.cost, 0))]);
      costRows.push(['Model calls (all sessions)', fmtCost(priced.reduce((s, m) => s + m.cost, 0))]);
    }
    kv($('cost-kv'), costRows.length ? costRows : [['Breakdown', 'N/A']]);

    // Sessions
    setText($('runs-count'), pad2(sessions.length));
    const runNodes = sessions.slice().reverse().map((s) => {
      const o = s.outcome ? OUTCOME[s.outcome] || [s.outcome, 'gray', s.outcome] : null;
      const tone = o ? o[1] : run && run.started_at === s.started_at ? 'green' : 'cyan';
      const li = el('li', null, 'tone-' + tone);
      const row = el('div', null, 'row');
      row.append(el('span', s.run), el('span', o ? o[2] : isRunning() && s === lastSession ? 'running' : '—'));
      li.append(row, el('div', s.role + ' · ' + s.state + (s.attempt ? ' · attempt ' + s.attempt : '') + (s.model ? ' · ' + s.model : '') + (s.effort ? ' · effort ' + s.effort : ''), 'muted'),
        el('div', fmtStamp(s.started_at) + (s.finished_at ? ' → ' + fmtClock(s.finished_at) : ''), 'muted'));
      if (s.transcript) {
        const a = el('a', 'Transcript (JSONL) ↗');
        a.href = API + '/transcript?run=' + encodeURIComponent(s.run) + '&format=raw';
        a.target = '_blank'; a.rel = 'noopener';
        li.append(a);
      } else li.append(el('div', 'no transcript', 'muted'));
      return li;
    });
    patchChildren($('runs'), runNodes.length ? runNodes : [el('li', 'No sessions recorded.', 'muted')]);

    // Context
    const trace = d && d.run_trace;
    const check = d && d.last_check;
    const mcp = trace && trace.mcp_tool_calls ? Object.entries(trace.mcp_tool_calls).map(([k, v]) => k + ' ' + v).join(', ') : '';
    kv($('ctx-kv'), [
      ['Identifier', (d && d.issue_identifier) || ID],
      ['Workspace', d && d.workspace ? d.workspace.path : null],
      ['Branch', trace && trace.branch],
      ['HEAD', trace && trace.head_sha ? trace.head_sha.slice(0, 12) : null],
      ['Session', run && run.session_id],
      ['PID', run && run.pid !== null ? String(run.pid) : null],
      ['MCP calls', mcp || '—'],
      ['Runs / continuations', d ? d.attempts.runs + ' / ' + d.attempts.continuations : null],
      ['Last check', check ? (check.ok ? '✓ ' : '✕ ') + check.target + ' · ' + fmtMs(check.duration_ms) : '—', check ? (check.ok ? '' : 'info') : ''],
    ]);
  }

  // ------------------------------------------------------------------ pipeline and issue sections

  /** The topology strip plus one summary row per agent stage (sessions newest first in the tooltip). */
  function renderPipelineSection() {
    const d = S.detail;
    const stages = (d && d.pipeline) || [];
    $('pipe-section').hidden = !stages.length;
    if (!stages.length) return;
    renderPipeline($('pipeline'), stages, { liveStatus: d.status === 'stopping' ? 'running' : d.status });
    const rows = stages.filter((st) => st.kind === 'agent').map((st) => {
      const last = st.sessions[st.sessions.length - 1];
      const tone = st.status === 'done' ? 'green' : st.status === 'active' ? (isRunning() ? 'green' : 'cyan') : 'gray';
      const row = el('div', null, 'pipe-row tone-' + tone);
      row.append(el('b', st.label));
      const outcome = last && last.outcome ? (OUTCOME[last.outcome] || [null, null, last.outcome])[2] : st.status === 'active' && isRunning() ? 'running' : st.status;
      const bits = [st.sessions.length ? st.sessions.length + ' run' + (st.sessions.length === 1 ? '' : 's') : 'no runs yet', outcome];
      if (last && last.model) bits.push(last.model);
      if (last && last.effort) bits.push('effort ' + last.effort);
      if (last) bits.push(fmtStamp(last.started_at) + (last.finished_at ? ' → ' + fmtClock(last.finished_at) : ''));
      row.append(el('span', bits.join(' · '), 'muted'));
      return row;
    });
    patchChildren($('pipe-rows'), rows);
  }

  /** Board fields of the issue: labels, priority, parent, blockers, sub-issues, dispatch note. */
  function renderIssueMeta() {
    const d = S.detail;
    const issue = d && d.issue;
    $('issue-section').hidden = !issue;
    if (!issue) return;
    patchChildren($('issue-labels'), (issue.labels || []).map((l) => el('span', l, 'chip')));
    const rows = [['Column', issue.state || '—']];
    if (issue.priority !== null && issue.priority !== undefined) rows.push(['Priority', 'P' + issue.priority]);
    if (issue.parent && issue.parent.identifier) rows.push(['Parent', issue.parent.identifier]);
    kv($('issue-kv'), rows);
    const extra = [];
    if (issue.blocked_by && issue.blocked_by.length) {
      extra.push(el('div', 'Blocked by', 'int-sub'));
      const list = el('ul', null, 'runs');
      for (const b of issue.blocked_by) {
        const li = el('li', null, 'tone-' + (b.state === 'CLOSED' || b.state === 'MERGED' ? 'green' : 'red'));
        const row = el('div', null, 'row');
        row.append(el('span', b.identifier || b.id || 'unknown'), el('span', String(b.state || '').toLowerCase()));
        li.append(row);
        list.append(li);
      }
      extra.push(list);
    }
    if (issue.sub_issues && issue.sub_issues.length) {
      extra.push(el('div', 'Sub-issues', 'int-sub'));
      const list = el('ul', null, 'runs');
      for (const s of issue.sub_issues) {
        const closed = s.state === 'CLOSED';
        const li = el('li', null, 'tone-' + (closed ? 'green' : 'cyan'));
        const row = el('div', null, 'row');
        row.append(el('span', s.identifier), el('span', (closed ? '✓ closed' : 'open') + (s.state_reason ? ' · ' + String(s.state_reason).toLowerCase() : '')));
        li.append(row);
        if (s.title) li.append(el('div', s.title, 'muted'));
        list.append(li);
      }
      extra.push(list);
    }
    if (issue.dispatch_note) extra.push(el('div', '⚠ ' + issue.dispatch_note, 'issue-note'));
    patchChildren($('issue-extra'), extra);
  }

  /** Integrations of the running session, else of the last one (GET /api/v1/<identifier>). */
  function integrationsOf(d) {
    return (d && d.running && d.running.integrations) || (d && d.run_trace && d.run_trace.integrations) || [];
  }

  /** The integration a timeline tool call belongs to: one of its MCP servers, or a Skill call of one of its skills. */
  function toolIntegration(it) {
    const mcp = /^mcp__(.+?)__/.exec(it.name || '');
    const input = String(it.input || '');
    for (const x of integrationsOf(S.detail)) {
      if (mcp && x.mcp_servers.includes(mcp[1])) return x;
      // Like the counters' skillMatches: the exact name, or plugin-qualified ("plugin:name").
      if (it.name === 'Skill' && x.skills.some((name) => input.includes('"' + name + '"') || input.includes(':' + name + '"'))) return x;
    }
    return null;
  }

  /** One section per integration (e.g. Laravel Boost): whether and how the agent used it, and what it provided. */
  function renderIntegrations() {
    const list = integrationsOf(S.detail);
    $('int-section').hidden = list.length === 0;
    if (!list.length) return;
    const single = list.length === 1 ? list[0] : null;
    patchChildren($('int-title'), single ? [integrationIcon(single.id, 18, single.status !== 'ready'), el('span', single.label)] : [el('span', 'Integrations')]);
    patchChildren($('int-body'), list.flatMap((x) => integrationBlock(x, !single)));
  }

  function integrationBlock(x, showName) {
    const nodes = [];
    const live = isRunning();
    const ready = x.status === 'ready';
    const u = x.usage || { calls: 0, tool_calls: {}, skill_calls: {} };
    const toolCalls = Object.values(u.tool_calls).reduce((s, n) => s + n, 0);
    const skillCalls = Object.values(u.skill_calls).reduce((s, n) => s + n, 0);
    const [statusText, tone] = INTEGRATION_STATUS[x.status] || [x.status, 'gray'];
    const head = el('div', null, 'int-head');
    if (showName) head.append(integrationIcon(x.id, 16, !ready), el('b', x.label));
    head.append(badge(statusText, tone, false));
    if (ready) head.append(badge(u.calls ? 'Used ×' + u.calls : live ? 'Not used yet' : 'Not used', u.calls ? 'cyan' : 'gray', false));
    nodes.push(head);

    const scope = live ? 'in this session' : 'in the last session';
    const guided = (x.parts || []).some((p) => p.guidelines);
    let text;
    if (ready && u.calls) {
      const what = [];
      if (toolCalls) what.push(toolCalls + ' MCP tool call' + (toolCalls === 1 ? '' : 's'));
      if (skillCalls) what.push(skillCalls + ' skill' + (skillCalls === 1 ? '' : 's') + ' loaded');
      text = 'The agent used ' + x.label + ' ' + scope + ': ' + what.join(' and ') + '.';
    } else if (ready) {
      text = x.label + ' was available ' + scope + '; the agent has not called its tools or skills' + (live ? ' yet' : '') + '.';
    } else if (x.status === 'unavailable') {
      text = x.label + ' was unavailable ' + scope + '; the agent worked without it (artisan and composer in the shell).';
    } else if (x.status === 'absent') {
      text = x.label + ' is not installed in this project' + (x.id === 'laravel-boost' ? ' (no laravel/boost in composer.json; add it with npm run repo-init)' : '') + '.';
    } else {
      text = x.label + ' is switched off in the workflow.';
    }
    if (ready && guided) text += ' Its guidelines were part of the agent\\'s context.';
    nodes.push(el('p', text, 'int-text'));
    for (const name of x.mcp_unavailable || []) {
      nodes.push(el('div', '⚠ The MCP server ' + name + ' did not connect ' + scope + '; its tools were unavailable to the agent.', 'int-warn'));
    }

    if (u.calls) {
      nodes.push(el('div', 'Used', 'int-sub'));
      const rows = [];
      for (const [tool, n] of Object.entries(u.tool_calls).sort((a, b) => b[1] - a[1])) rows.push([tool, '×' + n, 'info']);
      for (const [skill, n] of Object.entries(u.skill_calls).sort((a, b) => b[1] - a[1])) rows.push(['skill ' + skill, '×' + n, 'info']);
      const dl = el('dl', null, 'kv'); kv(dl, rows); nodes.push(dl);
    }

    for (const p of x.parts || []) {
      if (p.status === 'absent' && x.status !== 'absent') continue;
      nodes.push(el('div', 'Provided · ' + p.name, 'int-sub'));
      const rows = [];
      if (p.status !== 'ready') rows.push(['Status', p.status + (p.reason ? ' (' + p.reason + ')' : ''), p.status === 'failed' ? 'info' : '']);
      if (p.versions) rows.push(['Versions', p.versions]);
      if (p.status === 'ready') {
        rows.push(['Guidelines', p.guidelines || 'none']);
        rows.push(['Skills', p.skills.length ? p.skills.length + ': ' + p.skills.join(', ') : 'none']);
        if (x.skills_loaded && p.skills.length) {
          const loaded = p.skills.filter((name) => x.skills_loaded.includes(name)).length;
          rows.push(['Loaded by Claude Code', loaded + ' of ' + p.skills.length + ' skills', loaded < p.skills.length ? 'info' : '']);
        }
        if (p.mcp_server) rows.push(['MCP server', p.mcp_server + ' · ' + p.tools.length + ' tools pre-approved']);
      }
      const dl = el('dl', null, 'kv'); kv(dl, rows); nodes.push(dl);
      for (const w of p.warnings || []) nodes.push(el('div', '⚠ ' + w, 'int-warn'));
    }
    return nodes;
  }

  /** Bars: tokens per model call (one series, one axis); hover shows the call. */
  function renderChart(models) {
    const host = $('tok-chart');
    const calls = models.filter((m) => m.usage).slice(-80);
    host.hidden = calls.length < 2;
    if (host.hidden) return;
    const sig = calls.map((m) => m.key + ':' + callTokens(m.usage)).join(',');
    if (host.dataset.sig === sig) return;
    host.dataset.sig = sig;
    const W = 300, H = 64, n = calls.length, gap = 2;
    const max = Math.max(...calls.map((m) => callTokens(m.usage)), 1);
    const bw = Math.max(1, (W - gap * (n - 1)) / n);
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Tokens per model call, ' + n + ' calls, largest ' + fmtInt(max));
    const base = document.createElementNS(NS, 'line');
    base.setAttribute('class', 'axis'); base.setAttribute('x1', '0'); base.setAttribute('x2', String(W)); base.setAttribute('y1', String(H - 0.5)); base.setAttribute('y2', String(H - 0.5));
    calls.forEach((m, i) => {
      const v = callTokens(m.usage);
      const h = Math.max(1.5, (v / max) * (H - 4));
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('class', 'bar');
      r.setAttribute('x', String(i * (bw + gap)));
      r.setAttribute('y', String(H - h));
      r.setAttribute('width', String(bw));
      r.setAttribute('height', String(h));
      r.setAttribute('rx', String(Math.min(2, bw / 2)));
      r.dataset.i = String(i);
      svg.append(r);
    });
    svg.append(base);
    const tip = el('div', null, 'tip');
    tip.hidden = true;
    const cap = el('div', null, 'cap');
    const sum = calls.reduce((s, m) => s + callTokens(m.usage), 0);
    cap.append(el('span', 'tokens per model call (last ' + n + ')'), el('span', 'Σ ' + fmtCompact(sum)));
    host.replaceChildren(svg, tip, cap);
    let hot = null;
    svg.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const i = Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * n)));
      const m = calls[i];
      if (hot) hot.classList.remove('hot');
      hot = svg.querySelector('rect[data-i="' + i + '"]');
      if (hot) hot.classList.add('hot');
      tip.hidden = false;
      tip.textContent = fmtClock(m.at) + ' · ' + (m.model || '?') + ' · ' + fmtInt(callTokens(m.usage)) + ' tokens' + (m.cost !== null && m.cost !== undefined ? ' · ' + fmtCost(m.cost) : '');
      tip.style.left = Math.min(rect.width - 60, Math.max(60, e.clientX - rect.left)) + 'px';
      tip.style.top = '0px';
    });
    svg.addEventListener('mouseleave', () => { tip.hidden = true; if (hot) hot.classList.remove('hot'); hot = null; });
    svg.addEventListener('click', () => { if (hot) focusItem(calls[Number(hot.dataset.i)].key); });
  }

  function renderNotice() {
    const notice = $('notice');
    let text = '';
    if (!ID) {
      text = 'No agent selected. Open an agent from the dashboard.';
      setText($('hero-title'), 'No agent selected');
      $('state-slot').replaceChildren(badge('No agent', 'gray', false));
    }
    else if (S.notFound) text = 'The orchestrator has no record of ' + ID + ': it has not run since Symphony started and no archived details exist for it. Finished runs are listed on the Logs page.';
    else if (S.detail && S.detail.status === 'finished') {
      const a = S.detail.archived || {};
      text = 'This issue is no longer tracked by the orchestrator. Shown are the archived details of its last claim' +
        (a.archived_at ? ' (' + (a.released ? 'released ' : 'saved ') + fmtStamp(a.archived_at) + ')' : '') + '. Finished runs are also listed on the Logs page.';
    }
    else if (S.ended) text = 'This agent is no longer tracked by the orchestrator (released after finishing). The trace below is what this page had loaded.';
    else if (!S.online) text = 'Orchestrator unreachable: ' + (S.error || '') + ' · retrying every ' + POLL_MS / 1000 + 's';
    notice.hidden = !text;
    setText(notice, text);
    const d = S.detail;
    const sessions = (d && d.sessions) || [];
    const missing = sessions.filter((s) => !s.transcript).length;
    const reasons = [...S.tx.values()].map((t) => t.reason).filter(Boolean);
    let meta = '';
    if (sessions.length && missing === sessions.length) meta = 'Session transcripts are not available' + (reasons[0] ? ' (' + reasons[0] + ')' : '') + ': prompts, full responses, tool arguments and results cannot be shown; the timeline lists the agent events instead.';
    else if (S.firstSeq > 1) meta = 'Older orchestrator events were dropped (the issue keeps its newest events).';
    setText($('tl-meta'), meta);
    $('trace').hidden = !!(S.notFound || !ID);
  }

  function renderStatusbar() {
    const holder = $('sys-status');
    const b = S.online ? badge(isRunning() ? 'Live' : 'Online', isRunning() ? 'green' : 'cyan', isRunning()) : badge('Offline', 'red', false);
    const cur = holder.firstChild;
    if (!cur || cur.className !== b.className || cur.textContent !== b.textContent) holder.replaceChildren(b);
    setText($('sys-updated'), S.fetchedAt ? fmtClock(new Date(S.fetchedAt).toISOString()) : '—');
  }

  // ------------------------------------------------------------------ raw logs

  const LEVEL_TONE = { debug: 'gray', info: 'cyan', warn: 'amber', error: 'red' };
  function renderRaw() {
    if (!S.rawOpen) return;
    const q = S.rawQ.trim().toLowerCase();
    const short = splitId((S.detail && S.detail.issue_identifier) || ID).num;
    const rows = S.events.filter((e) => (!S.rawSev || e.level === S.rawSev) && (!q || (e.event + ' ' + (e.message || '') + ' ' + JSON.stringify(e.detail || {})).toLowerCase().includes(q)));
    setText($('raw-count'), fmtInt(rows.length) + ' of ' + fmtInt(S.events.length) + ' lines');
    const list = $('raw-list');
    const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 32;
    if (!rows.length) { list.replaceChildren(el('li', S.events.length ? 'No lines match the filter.' : 'No events yet.', 'note')); return; }
    list.replaceChildren(...rows.slice(-1500).map((e) => {
      const li = el('li', null, 'tone-' + (LEVEL_TONE[e.level] || 'gray'));
      const d = e.detail ? Object.entries(e.detail).filter(([k]) => k !== 'usage').map(([k, v]) => k + '=' + (typeof v === 'object' ? JSON.stringify(v) : v)).join(' ') : '';
      li.append(el('time', fmtClock(e.at) + '.' + String(new Date(e.at).getMilliseconds()).padStart(3, '0'), 't'), el('span', String(e.level).toUpperCase().slice(0, 4), 'sev'),
        el('span', short + (e.run ? ' ' + e.run : ''), 'who'), el('span', e.kind + '/' + e.event, 'ev'), el('span', (e.message || '') + (d ? '  ' + d : ''), 'd'));
      return li;
    }));
    if (stick) list.scrollTop = list.scrollHeight;
    const links = [];
    const repo = S.detail && S.detail.repo;
    if (repo && repo !== 'unknown') { const a = el('a', 'Repository log ↗'); a.href = '/api/v1/history/raw?repo=' + encodeURIComponent(repo); a.target = '_blank'; a.rel = 'noopener'; links.push(a); }
    patchChildren($('raw-links'), links);
  }

  // ------------------------------------------------------------------ render + interactions

  function render() {
    renderStatusbar();
    // The item list only changes with new events or transcript lines; header and summary refresh every time.
    if (S.dirty || !S.built) { S.items = buildItems(); S.dirty = false; S.built = true; }
    // Items that arrived with this poll get a short highlight (not ones re-rendered after a filter change).
    for (const it of S.items) if (!S.known.has(it.key)) { S.known.add(it.key); if (S.rendered) S.fresh.add(it.key); }
    if (S.detail || S.ended || S.notFound) {
      renderHeader();
      renderPipelineSection();
      renderIssueMeta();
      renderAlert();
      renderIntegrations();
      renderSummary();
    }
    renderNotice();
    renderTimeline();
    renderRaw();
  }

  function focusItem(key) {
    const idx = S.items.findIndex((x) => x.key === key);
    if (idx < 0) return;
    const it = S.items[idx];
    if (!matches(it)) { setFilter('all'); S.q = ''; $('tl-q').value = ''; }
    const visible = S.items.filter(matches);
    const pos = visible.indexOf(it);
    if (pos >= 0 && visible.length - pos > S.limit) S.limit = visible.length - pos + 20;
    if (expandable(it)) S.expanded.add(key);
    S.listSig = '';
    renderTimeline();
    const node = S.nodes.get(key);
    if (!node) return;
    const list = $('timeline');
    list.scrollTop = node.li.offsetTop - 40;
    node.li.classList.add('focus');
    setTimeout(() => node.li.classList.remove('focus'), 2400);
    const t = node.li.querySelector('button.toggle');
    if (t) t.focus({ preventScroll: true });
    if (list.scrollIntoView) list.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    updateJump();
  }

  function setFilter(f) {
    S.filter = f;
    for (const b of $('filters').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.f === f));
  }

  $('timeline').addEventListener('click', (e) => {
    const toggle = e.target.closest('button.toggle');
    if (!toggle) return;
    const li = toggle.closest('li.item');
    const key = li.dataset.key;
    setOpen(key, !S.expanded.has(key));
    const fresh = S.nodes.get(key);
    if (fresh) { const b = fresh.li.querySelector('button.toggle'); if (b) b.focus({ preventScroll: true }); }
    S.listSig = '';
  });
  $('timeline').addEventListener('scroll', () => updateJump(), { passive: true });
  $('jump').addEventListener('click', () => { const l = $('timeline'); l.scrollTop = l.scrollHeight; S.unseen = 0; updateJump(); });
  $('earlier').addEventListener('click', () => { S.limit += RENDER_LIMIT; renderTimeline(); });
  $('filters').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    setFilter(b.dataset.f);
    S.limit = RENDER_LIMIT;
    renderTimeline();
    const l = $('timeline'); l.scrollTop = l.scrollHeight;
  });
  let qTimer = null;
  $('tl-q').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.q = e.target.value.trim().toLowerCase(); renderTimeline(); }, 120); });
  $('expand-all').addEventListener('click', () => {
    // Only the rendered, matching items; bodies are built for those alone.
    for (const it of S.items.filter(matches).slice(-S.limit)) if (expandable(it)) S.expanded.add(it.key);
    renderTimeline();
  });
  $('collapse-all').addEventListener('click', () => { S.expanded.clear(); renderTimeline(); });
  $('alert').addEventListener('click', (e) => { const b = e.target.closest('button[data-goto]'); if (b) focusItem(b.dataset.goto); });
  $('raw-toggle').addEventListener('click', () => {
    S.rawOpen = !S.rawOpen;
    $('rawlog').hidden = !S.rawOpen;
    $('raw-toggle').setAttribute('aria-expanded', String(S.rawOpen));
    setText($('raw-toggle'), S.rawOpen ? 'Hide raw logs' : 'Show raw logs');
    if (S.rawOpen) { renderRaw(); const l = $('raw-list'); l.scrollTop = l.scrollHeight; }
  });
  $('raw-sev').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.rawSev = b.dataset.sev;
    for (const x of $('raw-sev').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    renderRaw();
  });
  $('raw-q').addEventListener('input', (e) => { S.rawQ = e.target.value; renderRaw(); });
  // Back keeps the dashboard's history entry when we came from it.
  $('back').addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    try { if (document.referrer && new URL(document.referrer).origin === location.origin && new URL(document.referrer).pathname === '/' && history.length > 1) { e.preventDefault(); history.back(); } } catch {}
  });

  // Runtime and countdowns tick between polls.
  setInterval(() => { if (S.detail && !S.ended) { renderHeader(); renderAlert(); } }, 1000);

  if (!ID) render();
  else { render(); poll(); setInterval(poll, POLL_MS); }
})();
</script>
</body>
</html>
`;
