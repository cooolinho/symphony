import { PIPELINE_CSS, PIPELINE_JS } from './pipeline.ts';
import { AURORA, page } from './ui/layout.ts';

const AGENT_CSS = `
  /* Pipeline section: the topology strip plus one summary row per agent stage. */
  .pipe-section .pipe { justify-content: flex-start; }
  .pipe-rows { margin-top: 12px; display: grid; gap: 6px; }
  .pipe-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; padding: 7px 10px; font: 12px var(--mono);
    border: 1px solid var(--line); border-left: 2px solid var(--tone, var(--faint)); border-radius: var(--radius-sm); background: rgba(0, 0, 0, .2); }
  .pipe-row b { color: var(--text); font-weight: 600; }
  .pipe-row .muted { overflow-wrap: anywhere; }

  /* Entry gate: one row per check of the column. */
  .gate-checks { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .gate-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; padding: 7px 10px; font: 12px var(--mono);
    border: 1px solid var(--line); border-left: 2px solid var(--tone, var(--faint)); border-radius: var(--radius-sm); background: rgba(0, 0, 0, .2); }
  .gate-row b { color: var(--text); font-weight: 600; }
  .gate-row pre.code { flex: 1 0 100%; }

  /* Sidebar Ergebnisse: one compact row per result, newest last. */
  .result-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  .result-row { display: grid; gap: 6px; padding: 8px 10px; font: 12px var(--mono); border: 1px solid var(--line);
    border-left: 2px solid var(--tone, var(--faint)); border-radius: var(--radius-sm); background: rgba(0, 0, 0, .2); }
  .result-row.vd-good { --tone: var(--green); } .result-row.vd-warn { --tone: var(--amber); } .result-row.vd-bad { --tone: var(--red); }
  .result-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
  .result-head b { color: var(--text); font-weight: 600; }
  .result-head .ui-chip { font-size: 11px; min-height: 0; }
  .result-summary { color: var(--text-2); overflow-wrap: anywhere; white-space: pre-wrap; }
  .result-findings { margin: 0; padding-left: 18px; display: grid; gap: 3px; color: var(--text-2); overflow-wrap: anywhere; }
  .result-findings .sev { font-weight: 600; text-transform: uppercase; }
  .result-findings .sev.blocker, .result-findings .sev.major { color: var(--red); }
  .result-findings .sev.minor, .result-findings .sev.nit { color: var(--muted); }
  .result-more summary { color: var(--muted); cursor: pointer; }
  .result-more .result-findings { margin-top: 6px; }

  /* Sidebar Context-Verlauf: one bar per developer round, compact marker on the right. */
  .ctx-runs { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .ctx-runs:empty { display: none; }
  .ctx-run { display: grid; grid-template-columns: 28px minmax(0, 1fr) 44px 28px; gap: 8px; align-items: center; font: 12px var(--mono); color: var(--text-2); }
  .ctx-pct { text-align: right; font-variant-numeric: tabular-nums; color: var(--text); }
  .ctx-compact { color: var(--amber); }

  /* Tabs Trace, Sessions, Transkript */
  .tabs-bar { margin-bottom: 12px; }
  [role="tabpanel"][hidden] { display: none; }
  .tx-tools { margin-bottom: 8px; }
  .tx-tools label { font: 12px var(--mono); color: var(--muted); }

  /* Issue sidebar section: labels, blockers, sub-issues. */
  .issue-labels { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .issue-labels:empty { display: none; }
  .issue-note { margin-top: 10px; font: 12px var(--mono); color: var(--amber); overflow-wrap: anywhere; }
`;

const AGENT_PAGE_CSS = `
  /* Head card (Kopfkarte): chips, title, meta line, key figures and actions */
  .head { padding: 20px 22px; display: flex; flex-wrap: wrap; gap: 18px 28px; justify-content: space-between; align-items: flex-start; }
  .head-main { flex: 1 1 420px; min-width: 0; display: grid; gap: 10px; }
  .head-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .head-chips > span:empty { display: none; }
  #head-tags { display: contents; }
  .head h1 { margin: 0; font: 600 var(--fs-h1-team)/1.2 var(--sans); letter-spacing: -.02em; color: var(--fg-strong); overflow-wrap: anywhere; }
  .head-meta { font: 12.5px var(--mono); color: var(--fg-3); overflow-wrap: anywhere; }
  .head-meta:empty { display: none; }
  .head-kpis { display: grid; grid-template-columns: repeat(4, minmax(84px, auto)); gap: 6px 18px; align-self: center; }
  .head-kpis .lbl { display: block; }
  .head-kpi-v { display: block; margin-top: 4px; font: 500 var(--fs-kpi-22)/1.2 var(--mono); font-variant-numeric: tabular-nums; color: var(--fg-strong); white-space: nowrap; }
  .head-actions { display: flex; flex-wrap: wrap; gap: 8px; align-self: center; }
  .head-actions:empty { display: none; }
  .stage-head .lbl { margin: 0; }
  /* Key/value tiles of the timeline (model call metrics, panes) */
  .k { font: 600 10px var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--muted); display: block; }
  .v { display: block; margin-top: 3px; font: 600 15px var(--mono); font-variant-numeric: tabular-nums; color: var(--text); overflow-wrap: anywhere; }

  /* Alert (failure, retry, pause) */
  .alert { border-color: var(--tone-line); background: linear-gradient(180deg, var(--tone-dim), rgba(11, 17, 21, .85)); display: grid; gap: 8px; }
  .alert h2 { color: var(--tone); margin: 0; display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .alert .reason { font: 13px/1.55 var(--mono); color: var(--text); overflow-wrap: anywhere; white-space: pre-wrap; max-height: 9.5em; overflow: auto; }
  .alert .sub { font: 12px var(--mono); color: var(--text-2); display: flex; flex-wrap: wrap; gap: 4px 16px; }
  .alert .sub b { color: var(--text); font-weight: 600; }
  .alert .actions { margin-top: 2px; }
  .notice { font: 12.5px var(--mono); color: var(--text-2); padding: 10px 14px; border: 1px dashed var(--line-2); border-radius: var(--radius-sm); background: rgba(0, 0, 0, .2); }

  /* Layout: main column (stage, score, tabs) and the sidebar of the shell's .cols; the sidebar wraps below on narrow screens */
  .side section { padding: 14px 16px; }
  .side h2 { margin-bottom: 12px; }
  .side-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 12px; }
  .side-head h2 { margin: 0; }
  .side-head a { font-size: 12.5px; }
  .side-feed { list-style: none; margin: 0; padding: 0; display: grid; }
  .side-feed > li { padding: 8px 0; border-top: 1px solid var(--line-2); font-size: 12.5px; min-width: 0; }
  .side-chg-head { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; }
  .side-chg-title { margin-top: 4px; overflow-wrap: anywhere; }
  .side-files { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 2px; font-size: 12px; color: var(--text-2); }
  .side-files li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 6px; }
  .side-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .side-add { color: var(--green-400); }
  .side-del { color: var(--red-400); }
  .side-acc { display: grid; grid-template-columns: auto auto auto minmax(0, 1fr); gap: 4px 8px; align-items: center; }
  .side-acc > .ui-chip:last-of-type, .side-acc > .side-clash { grid-column: 1 / -1; justify-self: start; }
  .side-acc.rejected { border-left: 2px solid var(--red-400); padding-left: 8px; color: var(--red-200); }
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

  /* Stage (Bühne): spotlight, stage edge, one column per seat, then the fields Jetzt, Session and Subagents */
  .stage { position: relative; overflow: hidden; padding: 20px 22px 22px; display: grid; gap: 20px; }
  .stage-head { position: relative; z-index: 1; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
  .stage-legend { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--fg-3); }
  .stage-legend li { display: inline-flex; align-items: center; gap: 6px; }
  .stage-legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
  .stage-legend .lg-play { background: #34d399; }
  .stage-legend .lg-done { background: #94a3b8; }
  .stage-legend .lg-back { background: #f87171; }
  .stage-legend .lg-wait { width: 10px; height: 10px; box-sizing: border-box; border: 1px dashed rgba(255, 255, 255, .5); }
  .seats-wrap { position: relative; }
  .spot { position: absolute; z-index: 0; top: -150px; width: 320px; height: 420px; pointer-events: none; }
  .floor { position: absolute; z-index: 0; top: 47px; left: 6%; right: 6%; height: 2px; border-radius: 1px; background: rgba(255, 255, 255, .14); }
  .seats { position: relative; z-index: 1; list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(var(--seats, 8), minmax(0, 1fr)); gap: 18px 8px; }
  .stage-seat { position: relative; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; }
  .stage-spot { height: 96px; display: grid; place-items: center; }
  .stage-seat.is-active .stage-spot { margin-bottom: 8px; }
  .stage-seat.is-returned .ui-av { background: #2a1414; }
  .stage-seat.is-skipped .ui-av { background: transparent; color: #5b6678; border: 1px dashed #5b6678; }
  .stage-seat .ui-av.is-you { border-radius: 18px; }
  .stage-gauge { position: relative; width: 96px; height: 96px; }
  .stage-gauge > .ring { inset: -9px; }
  .stage-name { font: 600 13.5px/1.3 var(--sans); color: var(--fg); overflow-wrap: anywhere; }
  .stage-seat.is-returned .stage-name, .stage-seat.is-waiting .stage-name, .stage-seat.is-skipped .stage-name { color: var(--fg-chip); }
  .stage-sub { font-size: 12px; line-height: 1.35; color: var(--fg-3); overflow-wrap: anywhere; }
  .stage-seat.is-returned .stage-sub { color: #fca5a5; }
  .stage-seat.is-active .stage-sub { color: var(--fg-chip); }
  .stage-fields { position: relative; z-index: 1; display: flex; flex-wrap: wrap; gap: 14px; min-width: 0; }
  .stage-field { min-width: 0; padding: 16px 18px; display: grid; gap: 10px; align-content: start; }
  #stage-now { flex: 2 1 380px; }
  #stage-session { flex: 1 1 260px; }
  #stage-subs { flex: 1 1 300px; }
  .field-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .field-ago { font: 12px var(--mono); color: var(--fg-3); white-space: nowrap; }
  .field-body { display: grid; gap: 10px; min-width: 0; }
  .stage-action { font: 19px/1.35 var(--mono); color: var(--fg); overflow-wrap: anywhere; }
  .stage-desc { font-size: 13px; color: var(--fg-2); overflow-wrap: anywhere; }
  .stage-trace { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .stage-trace .ui-chip { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .stage-arrow { color: #5b6678; }
  .stage-ctx { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; color: var(--fg-2); }
  .stage-ctx .mono.hot { color: var(--amber-400); }
  .stage-session .ui-bar-fill { background: linear-gradient(90deg, #34d399, #fbbf24); }
  .stage-hint { font-size: 11.5px; color: var(--fg-2); }
  .stage-kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; margin: 0; font: 13px var(--mono); }
  .stage-kv dt { color: var(--fg-3); font-size: 13px; }
  .stage-kv dd { margin: 0; color: var(--fg); overflow-wrap: anywhere; }
  .stage-subagent { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .sub-av { position: relative; flex: none; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; font: 600 10.5px/1 var(--mono);
    color: #6ee7b7; background: rgba(52, 211, 153, .14); border: 1px solid rgba(52, 211, 153, .5); }
  .sub-av .ring { inset: -4px; color: #34d399; }
  .stage-subagent.is-done .sub-av { color: var(--fg-2); background: rgba(255, 255, 255, .04); border-color: rgba(255, 255, 255, .14); }
  .sub-main { flex: 1 1 auto; min-width: 0; display: grid; gap: 2px; }
  .sub-name { font-size: 13px; font-weight: 500; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub-task { font-size: 12px; color: var(--fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub-right { flex: none; font: 12px var(--mono); color: var(--fg-3); white-space: nowrap; }
  .stage-subagent.is-running .sub-right { color: #6ee7b7; }
  .stage-empty { margin: 0; color: var(--fg-3); font-size: 13px; }
  .score { padding: 20px 22px; min-width: 0; }
  .score-head { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px 16px; margin-bottom: 14px; }
  .score-head .lbl { margin: 0; }
  .score-legend { display: flex; flex-wrap: wrap; gap: 4px 6px; margin: 0; padding: 0; list-style: none; font-size: 12px; color: var(--fg-2); }
  .score-legend li + li::before { content: "·"; margin-right: 6px; }
  .score-frame { overflow-x: auto; overflow-y: hidden; max-width: 100%; padding-top: 8px; }
  .score-frame:focus-visible { outline: 2px solid var(--line-2); outline-offset: 2px; }
  .score-body { display: flex; min-width: 760px; }
  .score-lanes { width: 120px; flex: none; display: flex; flex-direction: column; }
  .score-lane { height: 44px; display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--fg-chip); white-space: nowrap; overflow: hidden; }
  .score-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .score-plot { position: relative; flex: 1; border-left: 1px solid rgba(255,255,255,.1); }
  .score-grid-v { position: absolute; top: 0; bottom: 0; width: 1px; background: rgba(255,255,255,.05); }
  .score-grid-h { position: absolute; left: 0; right: 0; height: 1px; background: rgba(255,255,255,.05); }
  .score-round { position: absolute; top: -6px; bottom: 0; width: 0; border-left: 1px dashed rgba(251,191,36,.6); }
  .score-round-label { position: absolute; top: -4px; font: 11px var(--mono); color: #fcd34d; white-space: nowrap; }
  .blk { position: absolute; height: 30px; border-radius: 9px; display: flex; align-items: center; padding: 0 10px; font: 500 12px var(--sans); white-space: nowrap; overflow: hidden; box-sizing: border-box; border: 1px solid transparent; color: var(--fg-strong); }
  .blk > span { position: relative; min-width: 0; overflow: hidden; text-overflow: clip; }
  .blk::before { content: ""; position: absolute; inset: 0; border-radius: inherit; background: repeating-linear-gradient(90deg, rgba(255,255,255,.16) 0 1px, transparent 1px var(--tick, 7px)); pointer-events: none; }
  .blk.quiet::before { content: none; }
  .blk:focus-visible { outline: 2px solid var(--fg-strong); outline-offset: 1px; }
  .blk.now { overflow: visible; }
  .blk.now::after { content: ""; position: absolute; inset: 0; border-radius: inherit; box-shadow: 0 0 22px var(--glow, transparent); animation: score-glow 2.4s ease-in-out infinite; pointer-events: none; }
  @keyframes score-glow { 0%, 100% { opacity: .3; } 50% { opacity: 1; } }
  .score-hand { position: absolute; width: 2px; }
  .score-arrow { position: absolute; left: -4px; width: 0; height: 0; border-left: 5px solid transparent; border-right: 5px solid transparent; }
  .score-hand.down .score-arrow { bottom: -2px; border-top: 7px solid var(--c, currentColor); }
  .score-hand.up .score-arrow { top: -2px; border-bottom: 7px solid var(--c, currentColor); }
  .score-hand-label { position: absolute; left: 8px; top: 50%; transform: translateY(-50%); font: 10.5px/1 var(--mono); white-space: nowrap; }
  .score-hand.flip .score-hand-label { left: auto; right: 8px; }
  .score-now-line { position: absolute; top: 0; bottom: 0; right: 0; width: 2px; background: #34d399; box-shadow: 0 0 12px #34d399; }
  .score-axis { display: flex; justify-content: space-between; margin-left: 120px; min-width: 640px; margin-top: 6px; font: 11.5px var(--mono); color: var(--fg-3); }
  .score-axis .now { color: #6ee7b7; }
  @media (max-width: 900px) {
    .seats { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .floor, .spot { display: none; }
  }
  @media (max-width: 640px) {
    .head, .stage { padding: 16px; }
    .head h1 { font-size: 22px; }
    .head-kpis { grid-template-columns: repeat(2, minmax(84px, auto)); }
    .stage-spot { height: 80px; }
    .stage-gauge, .stage-gauge .ui-ring { width: 80px !important; height: 80px !important; }
    .stage-sub { display: none; }
    .stage-name { font-size: 12px; overflow-wrap: normal; }
  }
`;

/**
 * Agent detail view (`/issue?id=<identifier>`): an execution trace of one claimed issue. It polls
 * /api/v1/<identifier> (state, sessions, usage), /timeline (orchestrator and agent events, incremental by
 * `seq`) and /transcript (prompts, model calls, tool calls and results of each session, incremental by byte
 * offset) on the dashboard's 2 s interval. Bodies of prompts, responses and tool payloads are only put into
 * the DOM when an item is expanded. All agent and tracker text is inserted with textContent (untrusted).
 */
export const AGENT_HTML = page({
  title: 'Agent · Symphony',
  nav: null,
  navHighlight: 'overview',
  aurora: AURORA.team,
  crumbs: [{ label: 'Übersicht', href: '/' }, { label: 'Issue' }],
  styles: PIPELINE_CSS + AGENT_CSS + AGENT_PAGE_CSS,
  body: `
  <section class="g head" id="hero" aria-labelledby="hero-title">
    <div class="head-main">
      <div class="head-chips" id="head-chips"><span class="ui-chip mono" id="head-num">#</span><span id="state-slot"><span class="ui-chip"><span class="ui-dot" aria-hidden="true"></span><span class="ui-chip-text">Loading</span></span></span><span id="head-tags"></span><span class="ui-chip" id="attempt" hidden></span></div>
      <h1 id="hero-title">Loading agent trace…</h1>
      <div class="head-meta" id="head-meta"></div>
    </div>
    <div class="head-kpis" id="head-kpis"></div>
    <div class="head-actions" id="head-actions"></div>
  </section>

  <div class="cols">
  <div class="col-main">
  <section class="g stage" id="stage" aria-labelledby="stage-title" hidden>
    <div class="stage-head">
      <h2 class="lbl" id="stage-title">Bühne</h2>
      <ul class="stage-legend" aria-label="Legende">
        <li><i class="lg-play" aria-hidden="true"></i>spielt</li>
        <li><i class="lg-done" aria-hidden="true"></i>fertig</li>
        <li><i class="lg-back" aria-hidden="true"></i>Rückgabe</li>
        <li><i class="lg-wait" aria-hidden="true"></i>wartet</li>
      </ul>
    </div>
    <div class="seats-wrap">
      <div class="spot" id="stage-spot" aria-hidden="true" hidden></div>
      <div class="floor" id="stage-floor" aria-hidden="true"></div>
      <ol class="seats" id="stage-seats" aria-label="Sitze in Pipeline-Reihenfolge"></ol>
    </div>
    <div class="stage-fields">
      <article class="stage-field gi" id="stage-now"><div class="field-head"><h3 class="lbl" id="stage-now-meta">Jetzt</h3><span class="field-ago" id="stage-now-ago"></span></div><div class="field-body" id="stage-now-body"></div></article>
      <article class="stage-field stage-session gi" id="stage-session"><div class="field-head"><h3 class="lbl">Session</h3></div><div class="field-body" id="stage-session-body"></div></article>
      <article class="stage-field gi" id="stage-subs"><div class="field-head"><h3 class="lbl">Subagents</h3><span class="field-ago" id="stage-subs-meta"></span></div><div class="field-body" id="stage-subs-body"></div></article>
    </div>
  </section>

  <section class="g score" id="score" aria-labelledby="score-title" hidden>
    <div class="score-head">
      <h2 class="lbl" id="score-title">Partitur</h2>
      <ul class="score-legend" aria-label="Legende">
        <li>Block = Session</li>
        <li>Striche = Tool-Aufrufe</li>
        <li>Pfeil = Übergabe mit Verdict</li>
      </ul>
    </div>
    <div class="score-frame" id="score-frame" tabindex="0" aria-label="Partitur, horizontal scrollbar">
      <div class="score-body">
        <div class="score-lanes" id="score-lanes"></div>
        <div class="score-plot" id="score-plot"></div>
      </div>
      <div class="score-axis" id="score-axis"></div>
    </div>
  </section>

  <section class="pipe-section" id="pipe-section" aria-labelledby="pipe-title" hidden>
    <div class="section-head"><h2 id="pipe-title">Pipeline</h2></div>
    <div id="pipeline"></div>
    <div class="pipe-rows" id="pipe-rows"></div>
  </section>

  <section class="gate-section" id="gate-section" aria-labelledby="gate-title" hidden>
    <div class="section-head"><h2 id="gate-title">Entry checks <span class="count" id="gate-meta"></span></h2></div>
    <ol class="gate-checks" id="gate-checks"></ol>
  </section>

  <section class="alert" id="alert" role="alert" hidden></section>
  <div class="notice" id="notice" hidden></div>

  <div class="tabs-block" id="tabs-block">
    <div class="ui-tabs tabs-bar" role="tablist" aria-label="Verlauf" id="tabs">
      <button type="button" class="ui-tab" role="tab" id="tab-trace" data-id="trace" aria-controls="panel-trace" aria-selected="true" tabindex="0">Trace</button>
      <button type="button" class="ui-tab" role="tab" id="tab-sessions" data-id="sessions" aria-controls="panel-sessions" aria-selected="false" tabindex="-1">Sessions <span class="ui-tab-count" id="runs-count"></span></button>
      <button type="button" class="ui-tab" role="tab" id="tab-transkript" data-id="transkript" aria-controls="panel-transkript" aria-selected="false" tabindex="-1">Transkript</button>
    </div>

    <section role="tabpanel" id="panel-trace" aria-labelledby="tab-trace">
      <div class="tl-head">
        <div class="section-head">
          <h2 id="tl-title">Trace <span class="count" id="tl-count"></span></h2>
          <div class="actions">
            <button type="button" id="expand-all">Alles aufklappen</button>
            <button type="button" id="collapse-all">Zuklappen</button>
          </div>
        </div>
        <div class="tl-tools">
          <div class="seg" id="filters" role="group" aria-label="Event-Filter">
            <button type="button" data-f="all" aria-pressed="true">Alle<span class="n"></span></button>
            <button type="button" data-f="lifecycle" class="tone-green" aria-pressed="false">Lifecycle<span class="n"></span></button>
            <button type="button" data-f="phase" class="tone-cyan" aria-pressed="false">Phasen<span class="n"></span></button>
            <button type="button" data-f="model" class="tone-cyan" aria-pressed="false">Modell<span class="n"></span></button>
            <button type="button" data-f="tools" class="tone-green" aria-pressed="false">Tools<span class="n"></span></button>
            <button type="button" data-f="errors" class="tone-red" aria-pressed="false">Fehler<span class="n"></span></button>
          </div>
          <input type="search" id="tl-q" placeholder="Events, Tools, Text suchen…" aria-label="Trace durchsuchen">
        </div>
        <div class="meta" id="tl-meta"></div>
      </div>
      <div class="tl-wrap">
        <button type="button" class="earlier" id="earlier" hidden></button>
        <ol class="timeline" id="timeline" aria-live="off"><li class="note">$ Trace wird geladen …</li></ol>
        <button type="button" class="btn-primary jump" id="jump" hidden>↓ Neueste</button>
      </div>
      <div class="tl-foot">
        <span class="meta" id="tl-follow">Folgt den Live-Events</span>
        <button type="button" id="raw-toggle" aria-expanded="false" aria-controls="rawlog">Raw-Logs anzeigen</button>
      </div>
      <div class="rawlog" id="rawlog" hidden>
        <div class="tl-tools">
          <div class="seg" id="raw-sev" role="group" aria-label="Schweregrad">
            <button type="button" data-sev="" aria-pressed="true">Alle</button>
            <button type="button" data-sev="debug" class="tone-gray" aria-pressed="false">Debug</button>
            <button type="button" data-sev="info" class="tone-cyan" aria-pressed="false">Info</button>
            <button type="button" data-sev="warn" class="tone-amber" aria-pressed="false">Warn</button>
            <button type="button" data-sev="error" class="tone-red" aria-pressed="false">Error</button>
          </div>
          <input type="search" id="raw-q" placeholder="Event oder Meldung filtern…" aria-label="Raw-Logs filtern">
        </div>
        <ol class="logs" id="raw-list"></ol>
        <div class="tl-foot"><span class="meta" id="raw-count"></span><span class="actions" id="raw-links"></span></div>
      </div>
    </section>

    <section role="tabpanel" id="panel-sessions" aria-labelledby="tab-sessions" hidden>
      <ul class="runs" id="runs"></ul>
    </section>

    <section role="tabpanel" id="panel-transkript" aria-labelledby="tab-transkript" hidden>
      <div class="tl-tools tx-tools">
        <label for="tx-run">Session</label>
        <select id="tx-run"></select>
        <span class="actions" id="tx-links"></span>
      </div>
      <ol class="timeline" id="transcript"><li class="note">Kein Transkript</li></ol>
    </section>
  </div>
  </div>

  <aside class="col-side side" aria-label="Seitenleiste">
    <section class="results-section" id="results-section" aria-labelledby="results-title" hidden>
      <h2 id="results-title">Ergebnisse <span class="count" id="results-count"></span></h2>
      <ol class="result-list" id="result-cards"></ol>
    </section>
    <section id="ctx-history" aria-labelledby="ctx-history-title">
      <h2 id="ctx-history-title">Context-Verlauf</h2>
      <ol class="ctx-runs" id="ctx-runs" aria-label="Context-Peak des Developers je Runde"></ol>
      <div class="muted" id="ctx-empty">—</div>
    </section>
    <section id="access-section" aria-labelledby="access-title" hidden>
      <div class="side-head"><h2 id="access-title">Brain-Zugriffe</h2><a id="access-link" href="/brain">Brain →</a></div>
      <ol class="side-feed" id="access-list"></ol>
      <div class="muted" id="access-empty" hidden>Keine Zugriffe.</div>
    </section>
    <section id="changes-section" aria-labelledby="changes-title">
      <div class="side-head"><h2 id="changes-title">Changes</h2><a id="changes-all" href="/changes">Alle Changes</a></div>
      <ol class="side-feed" id="changes-list"></ol>
      <div class="muted" id="changes-empty" hidden>Noch keine Änderungen.</div>
    </section>
    <section aria-labelledby="int-title" id="int-section" hidden>
      <h2 id="int-title"><span>Integrationen</span></h2>
      <div id="int-body"></div>
    </section>
    <section aria-labelledby="life-title">
      <h2 id="life-title">Lebenszyklus</h2>
      <ul class="milestones" id="milestones"></ul>
      <dl class="kv" id="life-kv"></dl>
    </section>
    <section aria-labelledby="tok-title">
      <h2 id="tok-title">Token</h2>
      <div class="big" id="tok-total">—</div>
      <div class="big-sub" id="tok-sub"></div>
      <dl class="kv" id="tok-kv"></dl>
      <div class="chart" id="tok-chart" hidden></div>
    </section>
    <section aria-labelledby="cost-title">
      <h2 id="cost-title">Kosten</h2>
      <div class="big" id="cost-total">—</div>
      <div class="big-sub" id="cost-sub"></div>
      <dl class="kv" id="cost-kv"></dl>
    </section>
    <section aria-labelledby="issue-title" id="issue-section" hidden>
      <h2 id="issue-title">Issue</h2>
      <div class="issue-labels" id="issue-labels"></div>
      <dl class="kv" id="issue-kv"></dl>
      <div id="issue-extra"></div>
    </section>
    <section aria-labelledby="ctx-title">
      <h2 id="ctx-title">Run-Kontext</h2>
      <dl class="kv" id="ctx-kv"></dl>
    </section>
  </aside>
  </div>
`,
  scripts: `
(() => {
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
    team: null, stageSig: '', stagePct: undefined, subsSig: '', scoreSig: '',
    tab: 'trace', ctxEntries: null, ctxFinished: 0, txRun: '', txSig: '',
    changes: null, access: null, brainOff: false, accessSeen: false,
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

  let polling = false, pollAgain = false;
  async function poll() {
    if (!ID) return;
    if (polling) { pollAgain = true; return; }
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
        const tm = await getJson(API + '/team').catch(() => null);
        if (tm && tm.ok && tm.body && Array.isArray(tm.body.seats)) S.team = tm.body;
        maybeLoadContextHistory();
        await loadSideFeeds();
      }
    } catch (error) {
      S.online = false;
      S.error = error.message;
    }
    polling = false;
    render();
    if (pollAgain) { pollAgain = false; poll(); }
  }

  // ------------------------------------------------------------------ timeline model
  // Every item: { key, at, ms, order, type, cat, tone, level, err, sig, title, ... }. New event types only need
  // an entry in describeEvent (orchestrator/agent events) or in fromTranscript (transcript lines).

  const COVERED_BY_TRANSCRIPT = new Set(['assistant_message', 'tool_use', 'tool_result', 'tracker_tool']);
  const CATEGORY = {
    run_dispatched: 'lifecycle', run_finished: 'lifecycle', retry_scheduled: 'lifecycle', issue_paused: 'lifecycle',
    session_limit_wait: 'lifecycle', worker_restarted: 'lifecycle', worker_forced: 'lifecycle', issue_resumed: 'lifecycle', model_hold: 'lifecycle', model_hold_ended: 'lifecycle',
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
        return { ...base, type: 'run', tone: 'green', glyph: '●', title: (d.continuation ? 'CONTINUATION SESSION' : d.attempt ? 'RETRY ATTEMPT ' + d.attempt : 'AGENT STARTED') + (d.forced ? ' · EXTRA SLOT' : ''),
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
      case 'model_hold':
        if (d.source === 'operator') {
          return { ...base, tone: 'amber', glyph: '⏸', title: 'MODEL ' + String(d.model || '').toUpperCase() + ' PAUSED', err: false, line: e.message || '' };
        }
        return { ...base, tone: 'amber', glyph: '⏳', title: 'MODEL ' + String(d.model || '').toUpperCase() + ' ON HOLD', err: false,
          line: 'Until ' + fmtStamp(d.until) + (d.extended ? ' (extended)' : '') + (d.text ? ' · ' + d.text : '') };
      case 'model_hold_ended':
        return { ...base, tone: 'cyan', glyph: '▶', title: 'MODEL ' + String(d.model || '').toUpperCase() + ' HOLD ENDED', err: false, line: e.message || '' };
      case 'worker_restarted':
        return { ...base, tone: 'cyan', glyph: '↻', title: 'WORKER RESTARTED', err: false, line: e.message || '' };
      case 'worker_forced':
        return { ...base, tone: 'cyan', glyph: '▶', title: 'STARTED IN AN EXTRA SLOT', err: false, line: e.message || '' };
      case 'issue_paused':
        return { ...base, tone: 'gray', glyph: '⏸', title: d.source === 'operator' ? 'PAUSED BY OPERATOR' : d.source === 'budget' ? 'COST BUDGET USED UP' : 'PAUSED', err: false,
          line: d.source === 'budget' ? e.message || '' : undefined };
      case 'issue_resumed':
        return { ...base, tone: 'cyan', glyph: '▶', title: 'RESUMED', err: false, line: e.message || '' };
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
    setText($('tl-count'), S.items.length ? fmtInt(S.items.length) + ' Events' : '');

    const visible = S.items.filter(matches);
    const shown = visible.slice(-S.limit);
    const earlier = $('earlier');
    earlier.hidden = visible.length <= shown.length;
    setText(earlier, fmtInt(Math.min(RENDER_LIMIT, visible.length - shown.length)) + ' frühere Events anzeigen (' + fmtInt(visible.length - shown.length) + ' verborgen)');

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
      list.replaceChildren(el('li', S.items.length ? 'Kein Event passt zum Filter.' : S.detail || S.ended ? '$ noch keine Events …' : '$ Trace wird geladen …', 'note'));
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
    setText($('jump'), S.unseen ? '↓ ' + S.unseen + ' neu' : '↓ Neueste');
    setText($('tl-follow'), atBottom ? (isRunning() ? 'Folgt den Live-Events' : 'Am neuesten Event') : 'Folgen pausiert · zum Ende scrollen');
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

  // Head card (Kopfkarte): state chip with a live dot, round, profile, complexity, meta line, key figures, actions.
  const LIVE_GREEN = '#34d399';
  const IDLE_GRAY = '#94a3b8';
  const HEAD_LABELS = { Pause: 'Pausieren', Resume: 'Fortsetzen', Force: 'Jetzt starten' };
  /** "L" of a "Complexity: L" label; null without one. */
  function complexityOf(labels) {
    for (const label of labels || []) {
      const m = /^complexity:\\s*(s|m|l|xl)$/i.exec(String(label).trim());
      if (m) return m[1].toUpperCase();
    }
    return null;
  }
  /** Seconds of all sessions together; the running one counts up to now. */
  function runtimeTotal(sessions) {
    let sum = 0;
    for (const s of sessions) {
      const start = Date.parse(s.started_at);
      const end = s.finished_at ? Date.parse(s.finished_at) : isRunning() ? Date.now() : start;
      if (Number.isFinite(start) && Number.isFinite(end)) sum += Math.max(0, end - start);
    }
    return sum / 1000;
  }

  let lastStateLabel = '';
  let lastStateChip = '';
  function renderHead() {
    const d = S.detail;
    const [labelText] = deriveState();
    const identifier = (d && d.issue_identifier) || ID;
    const { repo, num } = splitId(identifier);
    const words = labelText.replace(/^[^A-Za-z]+/, '');
    setText($('crumb-current'), d && d.title ? num + ' ' + oneLine(d.title, 40) : num);
    document.title = num + ' · ' + words + ' · Symphony';
    setText($('hero-title'), (d && d.title) || identifier);
    setText($('head-num'), num);

    // The column with a dot: green and pulsing while a session runs, gray otherwise.
    const live = isRunning();
    const column = (d && d.issue && d.issue.state) || (d && d.running && d.running.state) || '';
    const chipKey = [column, labelText, live].join('|');
    if (lastStateChip !== chipKey) {
      const c = el('span', null, 'ui-chip state-chip');
      const dot = el('span', null, 'ui-dot' + (live ? ' live' : ''));
      dot.style.background = live ? LIVE_GREEN : IDLE_GRAY;
      dot.setAttribute('aria-hidden', 'true');
      // Outside a live session the state (retrying, paused, failed …) follows the column.
      c.append(dot, el('span', live || !column ? column || labelText : column + ' · ' + labelText, 'ui-chip-text'));
      c.setAttribute('title', labelText);
      $('state-slot').replaceChildren(c);
      lastStateChip = chipKey;
    }
    if (lastStateLabel !== labelText) {
      if (lastStateLabel) $('announce').textContent = 'Agent state: ' + labelText;
      lastStateLabel = labelText;
    }
    const tags = [];
    const rounds = d && d.rounds;
    if (rounds && rounds.current) tags.push(chip('Runde ' + rounds.current + ' von ' + rounds.max, rounds.current >= 2 ? { tone: 'amber' } : {}));
    if (d && d.profile) tags.push(chip('Profil ' + d.profile));
    const complexity = complexityOf(d && d.issue && d.issue.labels);
    if (complexity) tags.push(chip('Komplexität ' + complexity));
    patchChildren($('head-tags'), tags);
    const attempt = $('attempt');
    const att = d && d.attempts && d.attempts.current_retry_attempt;
    attempt.hidden = !att;
    setText(attempt, 'attempt ' + (att || ''));

    // Meta line: repo · branch · HEAD · PR, missing parts left out.
    const run = live ? d.running : null;
    const trace = d && d.run_trace;
    const branch = (run && run.branch) || (trace && trace.branch) || (d && d.issue && d.issue.branch_name);
    const sha = (run && run.head_sha) || (trace && trace.head_sha);
    const parts = [(d && d.repo && d.repo !== 'unknown' ? d.repo : repo) || '', branch || '', sha ? 'HEAD ' + String(sha).slice(0, 7) : '', d && d.pull_request ? 'PR #' + d.pull_request : ''];
    setText($('head-meta'), parts.filter(Boolean).join(' · '));

    const sessions = (d && d.sessions) || [];
    const t = totals();
    patchChildren($('head-kpis'), [
      ['Laufzeit', sessions.length ? fmtDuration(runtimeTotal(sessions)) : '—'],
      ['Tokens', t && t.tokens ? fmtCompact(t.tokens.total_tokens) : '—'],
      ['Kosten', t && t.cost !== null && t.cost !== undefined ? fmtCost(t.cost) : '—'],
      ['Sessions', String(sessions.length)],
    ].map(([k, v]) => { const box = el('div', null, 'head-kpi'); box.append(el('span', k, 'lbl'), el('span', v, 'head-kpi-v')); return box; }));

    // Pause a running or retrying issue, resume a paused one, start a waiting one now; only where controls are allowed.
    const actions = [];
    if (d && !S.ended && retryAllowed()) {
      if (d.status === 'retrying' || d.status === 'paused') actions.push(restartButton('Force', HEAD_LABELS.Force));
      if (d.status === 'paused') actions.push(restartButton('Resume', HEAD_LABELS.Resume));
      if (d.status === 'running' || d.status === 'retrying') actions.push(restartButton('Pause', HEAD_LABELS.Pause));
    }
    const url = d && d.issue_url;
    if (typeof url === 'string' && /^https?:/.test(url)) actions.push(button('GitHub ↗', { size: 38, href: url }));
    patchChildren($('head-actions'), actions);
  }

  function lastErrorItem() {
    for (let i = S.items.length - 1; i >= 0; i--) if (S.items[i].err && (S.items[i].tone === 'red' || S.items[i].level === 'error')) return S.items[i];
    return null;
  }

  // Outcome of the last control click (Retry, Pause, Resume); the alert and the header are rebuilt every second, so
  // the buttons are drawn from here.
  let restartState = null;
  const RESTART_LABELS = { Retry: 'Retry now', Resume: 'Resume now', Pause: 'Pause', Force: 'Start now' };
  // Route, busy label and success label of each control button.
  const CONTROL = {
    Retry: ['retry', 'Restarting…', 'Queued'],
    Force: ['force', 'Starting…', 'Started'],
    Resume: ['resume', 'Resuming…', 'Queued'],
    Pause: ['pause', 'Pausing…', 'Paused'],
  };
  const RESTART_DISABLED = 'Controls disabled: set SYMPHONY_ALLOW_REMOTE_CONTROL=true behind an authenticating proxy';
  // controls.retry from /api/v1/<identifier>; false on a non-loopback bind without server.allow_remote_control.
  const retryAllowed = () => !S.detail || !S.detail.controls || S.detail.controls.retry !== false;

  /** A control button; with a label it is the head card's pill button (German label), else the alert's. */
  function restartButton(verb, label) {
    if (!retryAllowed()) return el('span', RESTART_DISABLED, 'muted restart-off');
    const st = restartState && restartState.verb === verb ? restartState : null;
    const b = el('button', st ? st.label : label || RESTART_LABELS[verb], (label ? 'ui-btn ui-btn-38' : 'btn') + ' restart' + (st && st.cls ? ' ' + st.cls : ''));
    b.type = 'button';
    b.dataset.verb = verb;
    b.setAttribute('aria-label', RESTART_LABELS[verb] + ' ' + ID);
    if (st && st.cls === 'is-busy') b.setAttribute('aria-busy', 'true');
    return b;
  }

  function repaintControls() {
    renderAlert();
    if (S.detail) renderHead();
  }

  async function restart(verb) {
    if (restartState && restartState.cls === 'is-busy') return;
    const [action, busy, done] = CONTROL[verb] || CONTROL.Retry;
    // Start now runs beside the limit: ask first when every slot is taken.
    const slots = S.detail && S.detail.slots;
    if (verb === 'Force' && slots && slots.running - slots.forced >= slots.limit) {
      const num = ID.lastIndexOf('#') > 0 ? ID.slice(ID.lastIndexOf('#')) : ID;
      if (!window.confirm('All ' + slots.limit + ' slot' + (slots.limit === 1 ? ' is' : 's are') + ' busy. Start ' + num + ' in an extra slot?')) return;
    }
    restartState = { verb, cls: 'is-busy', label: busy };
    repaintControls();
    let ok = false;
    let label = RESTART_LABELS[verb] + ' failed';
    try {
      const res = await fetch(API + '/' + action, { method: 'POST' });
      let body = null;
      try { body = await res.json(); } catch {}
      ok = res.ok;
      label = ok ? done : (body && body.error && body.error.message) || RESTART_LABELS[verb] + ' failed (' + res.status + ')';
    } catch {}
    restartState = { verb, cls: ok ? 'is-done' : 'is-failed', label };
    repaintControls();
    $('announce').textContent = ID + ': ' + label;
    setTimeout(poll, 500);
    setTimeout(() => { restartState = null; repaintControls(); }, ok ? 1800 : 5000);
  }

  document.addEventListener('click', (event) => {
    const b = event.target instanceof Element ? event.target.closest('button.restart') : null;
    if (b) restart(b.dataset.verb || 'Retry');
  });

  function sessionLimitSpec(d) {
    const r = d.retry;
    const limit = r.limit;
    const sub = [];
    const modelLimit = limit.scope === 'model' && limit.model;
    if (modelLimit) sub.push(['Model', limit.model + ' on hold; other models keep running, no fallback']);
    if (limit.window) sub.push(['Window', windowWords(limit.window)]);
    if (limit.resets_at) sub.push(['Resets at', fmtStamp(limit.resets_at)]);
    sub.push(['Retry at', fmtStamp(r.due_at) + ' (in ' + fmtDuration(Math.max(0, Date.parse(r.due_at) - Date.now()) / 1000) + ')']);
    sub.push(['Retries', modelLimit ? 'none: waits for the end of the hold' : limit.waiting ? 'used up' : limit.hits <= limit.max_retries ? limit.hits + ' of ' + limit.max_retries : 'backoff']);
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
      const budget = d.paused && d.paused.source === 'budget';
      const reason = d.paused && d.paused.source === 'operator'
        ? 'Paused by operator. Board changes (status, comments, labels) do not lift the pause; it ends with Resume, Done or leaving the board.'
        : budget
        ? 'Cost budget used up: $' + d.paused.cost_usd.toFixed(2) + ' of $' + d.paused.max_issue_cost_usd.toFixed(2) + ' (agent.max_issue_cost_usd). The next stage does not start. Raise the limit or press Resume; board changes do not lift the pause.'
        : 'Still active after ' + (d.paused ? d.paused.continuations : '?') + ' continuation session(s). Change the issue on the board (status, comment or labels) to resume' + (retryAllowed() ? ', or press Resume now.' : '.');
      spec = { tone: 'gray', title: d.paused && d.paused.source === 'operator' ? '⏸ Paused by operator' : budget ? '⏸ Cost budget used up' : '⏸ Agent paused', reason, sub: [], restart: 'Resume' };
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
        const a = el('a', 'Transkript (JSONL) ↗');
        a.href = API + '/transcript?run=' + encodeURIComponent(s.run) + '&format=raw';
        a.target = '_blank'; a.rel = 'noopener';
        li.append(a);
      } else li.append(el('div', 'kein Transkript', 'muted'));
      return li;
    });
    patchChildren($('runs'), runNodes.length ? runNodes : [el('li', 'Keine Sessions', 'muted')]);

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

  const GATE_STATUS = {
    pending: ['gray', 'pending'], running: ['cyan', 'running'], passed: ['green', 'passed'], skipped: ['gray', 'skipped'],
    check_failed: ['red', 'failed'], check_timeout: ['amber', 'timed out'], check_error: ['red', 'error'],
  };

  /** The newest entry gate: target, commit, and one row per check with its state, elapsed time and failure output. */
  function renderGate() {
    const g = S.detail && S.detail.gate;
    $('gate-section').hidden = !g;
    if (!g) { setText($('gate-meta'), ''); patchChildren($('gate-checks'), []); return; }
    setText($('gate-meta'), '→ ' + g.target + (g.sha ? ' · ' + g.sha.slice(0, 12) : '') + (g.finished_at ? ' · finished ' + fmtClock(g.finished_at) : ' · running'));
    const rows = g.checks.map((c) => {
      const known = GATE_STATUS[c.status] || ['gray', c.status];
      const label = c.status === 'pending' && g.finished_at ? 'not run' : c.status === 'check_failed' ? 'failed (exit ' + c.exit_code + ')' : known[1];
      const row = el('li', null, 'gate-row tone-' + known[0]);
      row.append(el('b', c.name || 'check'), el('span', label));
      if (c.status === 'running') row.append(el('span', fmtMs(c.duration_ms) + ' / ' + fmtMs(c.timeout_ms), 'muted'));
      else if (c.duration_ms !== null && c.duration_ms !== undefined) row.append(el('span', fmtMs(c.duration_ms), 'muted'));
      if (c.cached) row.append(el('span', 'from cache', 'chip'));
      if (c.output !== null && c.output !== undefined) {
        const quiet = c.status === 'passed' || c.status === 'skipped';
        const pre = el('pre', c.output || '(no output)', quiet ? 'code' : 'code err');
        if (quiet) {
          const details = el('details', null, 'gate-output');
          details.append(el('summary', 'output (end)'), pre);
          row.append(details);
        } else row.append(pre);
      }
      return row;
    });
    // A refresh must not fold output the user has opened: carry the open state over to the new row.
    const host = $('gate-checks');
    rows.forEach((row, i) => {
      const old = host.children[i];
      const was = old && old.querySelector('details');
      const now = row.querySelector('details');
      if (was && now && was.open) now.open = true;
    });
    patchChildren(host, rows);
  }

  const RESULT_CHIP_TONE = { good: 'green', warn: 'amber', bad: 'red' };
  /** Sidebar Ergebnisse: one row per recorded stage result with role, verdict chip, round, short summary and the comment's link; findings and blockers fold away. */
  function renderResults() {
    const d = S.detail;
    const results = (d && d.results) || [];
    $('results-section').hidden = !results.length;
    setText($('results-count'), results.length ? String(results.length) : '');
    const rows = results.map((r) => {
      const tone = PIPE_VERDICT_TONE[r.verdict] || 'muted';
      const row = el('li', null, 'result-row vd-' + tone);
      const head = el('div', null, 'result-head');
      head.append(el('b', r.role), el('span', r.kind, 'muted'));
      if (r.verdict) head.append(chip(pipeVerdict(r.verdict, null), RESULT_CHIP_TONE[tone] ? { tone: RESULT_CHIP_TONE[tone] } : {}));
      if (r.round) head.append(el('span', 'Runde ' + r.round, 'muted'));
      if (r.target) head.append(el('span', '→ ' + r.target, 'muted'));
      if (typeof r.url === 'string' && /^https?:/.test(r.url)) {
        const link = el('a', 'Kommentar ↗');
        link.href = r.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        head.append(link);
      }
      row.append(head);
      if (r.summary) {
        const summary = el('div', oneLine(r.summary, 140), 'result-summary');
        summary.title = String(r.summary);
        row.append(summary);
      }
      const findings = r.findings || [];
      const blockers = r.blockers || [];
      if (findings.length || blockers.length) {
        const more = el('details', null, 'result-more');
        const parts = [];
        if (findings.length) parts.push(findings.length + (findings.length === 1 ? ' Finding' : ' Findings'));
        if (blockers.length) parts.push(blockers.length + ' Blocker');
        more.append(el('summary', parts.join(' · ')));
        if (findings.length) {
          const list = el('ul', null, 'result-findings');
          for (const f of findings) {
            const li = el('li');
            li.append(el('span', f.severity, 'sev ' + f.severity), ' ' + (f.file ? f.file + (f.line ? ':' + f.line : '') + ' — ' : '') + f.problem + (f.fix ? ' → ' + f.fix : ''));
            list.append(li);
          }
          more.append(list);
        }
        if (blockers.length) {
          const list = el('ul', null, 'result-findings');
          for (const b of blockers) {
            const li = el('li');
            li.append(el('span', b.needs, 'sev blocker'), ' ' + b.description);
            list.append(li);
          }
          more.append(list);
        }
        row.append(more);
      }
      return row;
    });
    // A refresh must not fold a details element the user has opened.
    const host = $('result-cards');
    rows.forEach((row, i) => {
      const old = host.children[i];
      const was = old && old.querySelector('details');
      const now = row.querySelector('details');
      if (was && now && was.open) now.open = true;
    });
    patchChildren(host, rows);
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
    patchChildren($('int-title'), single ? [integrationIcon(single.id, 18, single.status !== 'ready'), el('span', single.label)] : [el('span', 'Integrationen')]);
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
    $('tabs-block').hidden = !!(S.notFound || !ID);
  }

  function renderStatusbar() {
    setLive(S.online);
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

  // ------------------------------------------------------------------ stage (Bühne)

  const STAGE_WORDS = { done: 'fertig', playing: 'spielt', waiting: 'wartet', returned: 'Rückgabe', skipped: 'übersprungen' };
  // Dark seat grounds of the mockup; other roles get their colour at .16.
  const SEAT_GROUND = { analyst: '#0d2433', architect: '#1d1838', developer: '#0c2e25' };
  const RETURNED_GROUND = '#2a1414';
  const RETURNED_RED = '#f87171';
  const FLOOR_BASE = 'rgba(255,255,255,.14)';
  const seatKey = (s) => uiRoleKey(s.role === 'you' ? 'human' : s.role, s.kind);
  const seatColor = (s) => UI_ROLE_COLORS[seatKey(s)];
  // Takes a seat, or a role id (Partitur) that is looked up among the seats for its result kind.
  function seatName(s) {
    if (typeof s === 'string') s = (S.team && Array.isArray(S.team.seats) && S.team.seats.find((x) => x.role === s)) || { role: s, kind: null };
    if (s.role === 'you') return 'Du';
    const own = uiOwn(UI_ROLE_NAMES, s.role) || (uiOwn(UI_KIND_ROLE, s.kind) ? UI_ROLE_NAMES[seatKey(s)] : null);
    return own || String(s.role).charAt(0).toUpperCase() + String(s.role).slice(1);
  }
  const seatDuration = (s) => (s.duration_ms === null || s.duration_ms === undefined ? '—' : fmtDuration(s.duration_ms / 1000));
  const fmtK = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n / 1000) + 'k' : '—');
  const stagePct = (n) => +Math.min(100, Math.max(0, n)).toFixed(2) + '%';
  const liveStart = () => (isRunning() && S.detail.running.started_at ? Date.parse(S.detail.running.started_at) : NaN);
  function seatTitle(seat, status) {
    return [seatName(seat), STAGE_WORDS[status], 'Verdict ' + (seat.verdict ?? '—'), 'Dauer ' + seatDuration(seat), 'Modell ' + (seat.model ?? '—')].join(' · ');
  }
  /** The line below a seat's name. */
  function seatSub(s, status) {
    if (s.role === 'you') return s.status === 'done' ? 'Done' : 'In review · Merge';
    if (status === 'playing') {
      const rounds = S.detail && S.detail.rounds;
      const start = liveStart();
      return 'spielt · Runde ' + ((rounds && rounds.current) || s.round || 1) + ' · ' + (Number.isFinite(start) ? fmtDuration((Date.now() - start) / 1000) : seatDuration(s));
    }
    if (status === 'done') return [s.verdict, s.duration_ms === null || s.duration_ms === undefined ? null : seatDuration(s), s.model].filter(Boolean).join(' · ') || '—';
    if (status === 'returned') { const n = s.round || 1; return 'R' + n + ' ' + (s.verdict || 'failed') + ' · wartet auf R' + (n + 1); }
    if (status === 'skipped') return 'übersprungen';
    const key = seatKey(s);
    return key === 'docs' ? 'wartet · nur bei Doku-Bedarf' : key === 'security' ? 'wartet · bei Sicherheitsbezug' : 'wartet';
  }
  // Without a session nothing plays; with one only its own seat does.
  function seatStatuses(seats, active) {
    let found = false;
    return seats.map((s) => {
      if (s.status === 'playing') {
        if (active && !found && s.role === active.role) { found = true; return 'playing'; }
        return 'waiting';
      }
      return STAGE_WORDS[s.status] ? s.status : 'waiting';
    });
  }

  /** The context ring of the playing seat: role icon inside, role glow around, an accessible name with the percent. */
  function contextRing(s, pct) {
    const key = seatKey(s);
    const glyph = el('span', null, 'stage-glyph');
    glyph.style.color = UI_ROLE_COLORS[key];
    const svg = icon(UI_ROLE_ICON[key], 34);
    if (svg) glyph.append(svg);
    const r = ring(pct, { size: 96, inner: glyph });
    r.setAttribute('aria-label', seatName(s) + ' spielt, Context ' + (pct === null ? 'unbekannt' : pct + ' Prozent'));
    r.style.boxShadow = '0 0 44px ' + uiRgba(UI_ROLE_COLORS[key], '.45');
    return r;
  }

  function buildSeat(s, status, pct) {
    const key = seatKey(s);
    const c = UI_ROLE_COLORS[key];
    const li = el('li', null, 'stage-seat is-' + status + (status === 'playing' ? ' is-active' : '') + (s.role === 'you' ? ' is-you' : ''));
    li.setAttribute('data-role', s.role);
    li.setAttribute('data-key', key);
    const spot = el('div', null, 'stage-spot');
    const name = el('div', seatName(s), 'stage-name');
    if (status === 'playing') {
      const gauge = el('div', null, 'stage-gauge');
      const pulse = el('span', null, 'ring ring-lg');
      pulse.style.color = c;
      pulse.setAttribute('aria-hidden', 'true');
      gauge.append(contextRing(s, pct), pulse);
      spot.append(gauge);
      const bars = eq({ large: true });
      bars.style.color = c;
      name.style.color = UI_ROLE_LIGHT[key];
      li.append(spot, bars, name, el('div', null, 'stage-sub'));
      return li;
    }
    const av = avatar(key, status, { size: 64 });
    if (s.role === 'you') av.classList.add('is-you');
    if (status === 'done') {
      av.style.background = uiOwn(SEAT_GROUND, key) || uiRgba(c, '.16');
      av.style.borderColor = uiRgba(c, '.6');
    }
    if (status === 'returned') av.style.background = RETURNED_GROUND;
    spot.append(av);
    li.append(spot, name, el('div', null, 'stage-sub'));
    return li;
  }

  function renderStageSeats(seats, statuses, active) {
    const list = $('stage-seats');
    const sig = seats.map((s, i) => [s.role, statuses[i], s.status, s.kind].join(':')).join(',');
    const pct = active && active.context && typeof active.context.percent === 'number' ? Math.round(active.context.percent) : null;
    if (sig !== S.stageSig) {
      S.stageSig = sig;
      S.stagePct = pct;
      list.style.setProperty('--seats', String(seats.length));
      list.replaceChildren(...seats.map((s, i) => buildSeat(s, statuses[i], pct)));
    }
    seats.forEach((s, i) => {
      const li = list.children[i];
      const title = seatTitle(s, statuses[i]);
      li.setAttribute('title', title);
      const av = li.querySelector('.ui-av');
      if (av) { av.setAttribute('title', title); av.setAttribute('aria-label', title); }
      setText(li.querySelector('.stage-sub'), seatSub(s, statuses[i]));
    });
    // Only the ring is swapped when the context changes; pulse and equalizer keep running.
    if (S.stagePct !== pct) {
      const k = statuses.indexOf('playing');
      const gauge = list.querySelector('.stage-gauge');
      if (gauge && k >= 0) gauge.replaceChild(contextRing(seats[k], pct), gauge.querySelector('.ui-ring'));
      S.stagePct = pct;
    }
  }

  /** Stage edge in the colours of the finished seats up to the playing one, and the spotlight above that seat. */
  function renderStageFloor(seats, statuses) {
    const n = seats.length;
    const k = statuses.indexOf('playing');
    let end = k;
    if (end < 0) statuses.forEach((st, i) => { if (st === 'done' || st === 'returned') end = i; });
    // Seat centres in percent of the edge, which runs from 6 % to 94 % of the row.
    const at = (i) => ((((i + 0.5) / n) * 100 - 6) / 88) * 100;
    const stops = [];
    for (let i = 0; i <= end; i++) {
      const st = statuses[i];
      if (st === 'done' || st === 'playing') stops.push(seatColor(seats[i]) + ' ' + stagePct(at(i)));
      else if (st === 'returned') stops.push(RETURNED_RED + ' ' + stagePct(at(i)));
    }
    const floor = $('stage-floor');
    const bg = stops.length ? 'linear-gradient(90deg, ' + stops.join(', ') + ', ' + FLOOR_BASE + ' ' + stagePct(at(end)) + ', ' + FLOOR_BASE + ' 100%)' : FLOOR_BASE;
    if (floor.style.background !== bg) floor.style.background = bg;
    const spot = $('stage-spot');
    spot.hidden = k < 0;
    if (k >= 0) {
      spot.style.left = 'calc(' + stagePct(((k + 0.5) / n) * 100) + ' - 160px)';
      spot.style.background = 'radial-gradient(closest-side, ' + uiRgba(seatColor(seats[k]), '.22') + ', transparent)';
    }
  }

  /** The argument of a tool call: its message without the "Tool: " prefix. */
  function toolArg(t) {
    const msg = String(t.message || '');
    const prefix = t.tool + ': ';
    return oneLine(msg.startsWith(prefix) ? msg.slice(prefix.length) : msg === t.tool ? '' : msg, 200);
  }
  /** Short form of the newest tool result of the live session (from its transcript); '' without one. */
  function lastToolResult() {
    const sessions = (S.detail && S.detail.sessions) || [];
    const live = sessions.length && !sessions[sessions.length - 1].finished_at ? sessions[sessions.length - 1].run : null;
    if (!live) return '';
    for (let i = S.items.length - 1; i >= 0; i--) {
      const it = S.items[i];
      if (it.type === 'toolcall' && it.run === live && !it.sub && it.result) return (it.result.is_error ? 'Fehler: ' : '') + oneLine(it.result.text, 120);
    }
    return '';
  }
  const stageEmpty = (text) => el('p', text, 'stage-empty');

  function renderStageNow(active, seat, trace) {
    const key = seat ? seatKey(seat) : active ? uiRoleKey(active.role, null) : null;
    const c = key ? UI_ROLE_COLORS[key] : null;
    $('stage-now').style.borderColor = active && c ? uiRgba(c, '.35') : '';
    setText($('stage-now-meta'), active ? 'Jetzt · ' + (seat ? seatName(seat) : seatName({ role: active.role, kind: null })) : 'Jetzt');
    const tools = ((active ? active.recent_tools : trace) || []).slice(-4);
    const last = tools[tools.length - 1];
    const since = last ? last.at : active && S.detail && S.detail.running ? S.detail.running.last_event_at : null;
    const secs = since ? Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000)) : NaN;
    setText($('stage-now-ago'), active && Number.isFinite(secs) ? 'vor ' + secs + ' s' : '');
    const nodes = [];
    if (active) {
      const action = el('div', null, 'stage-action');
      if (last) {
        action.append(el('span', last.tool, 'tool'));
        const arg = toolArg(last);
        if (arg) {
          const a = el('span', arg, 'arg');
          a.style.color = UI_ROLE_LIGHT[key];
          action.append(el('span', ' '), a);
        }
      } else action.append(el('span', oneLine(active.action, 200) || '—'));
      nodes.push(action);
      const desc = lastToolResult();
      if (desc) nodes.push(el('div', desc, 'stage-desc'));
    } else nodes.push(stageEmpty('Keine Session aktiv'));
    if (tools.length) {
      const row = el('div', null, 'stage-trace');
      tools.forEach((t, i) => {
        if (i) row.append(el('span', '→', 'stage-arrow'));
        const c2 = chip(t.tool, { mono: true });
        c2.setAttribute('title', String(t.message || t.tool || ''));
        // Only the live session's newest call is tinted in the role colour.
        if (active && c && i === tools.length - 1) {
          c2.classList.add('is-last');
          c2.style.color = UI_ROLE_LIGHT[key];
          c2.style.borderColor = uiRgba(c, '.6');
          c2.style.background = uiRgba(c, '.16');
        }
        row.append(c2);
      });
      nodes.push(row);
    } else if (active) nodes.push(stageEmpty('Noch keine Tool-Aufrufe'));
    patchChildren($('stage-now-body'), nodes);
  }

  function renderStageSession(active, threshold) {
    const box = $('stage-session-body');
    if (!active) return patchChildren(box, [stageEmpty('Keine Session aktiv')]);
    const c = active.context || {};
    const known = typeof c.window === 'number' && c.window > 0;
    const pct = known && typeof c.percent === 'number' && Number.isFinite(c.percent) ? c.percent : null;
    const head = el('div', null, 'stage-ctx');
    const value = known ? fmtK(c.tokens) + ' / ' + fmtK(c.window) + ' · ' + (pct === null ? '—' : Math.round(pct) + ' %') : '—';
    head.append(el('span', 'Context'), el('span', value, 'mono' + (pct !== null && pct >= 70 ? ' hot' : '')));
    const limit = typeof threshold === 'number' && Number.isFinite(threshold) ? threshold : 80;
    const start = liveStart();
    const tk = active.tokens || {};
    const kv = el('dl', null, 'stage-kv');
    for (const [k, v] of [
      ['Turn', (active.turn ?? '—') + (active.max_turns ? ' / ' + active.max_turns : '')],
      ['Dauer', Number.isFinite(start) ? fmtDuration((Date.now() - start) / 1000) : '—'],
      ['Modell', (active.model ?? '—') + (active.effort ? ' · effort ' + active.effort : '')],
      ['Tokens', fmtCompact(tk.total_tokens) + ' · ' + fmtCost(active.cost_usd)],
    ]) kv.append(el('dt', k), el('dd', v));
    patchChildren(box, [
      head,
      bar(pct ?? 0, { height: 8, marker: { pct: limit, title: 'Auto-Compact' } }),
      el('div', 'rote Marke: Auto-Compact ab ca. ' + limit + ' %', 'stage-hint'),
      kv,
    ]);
  }

  /** Two capitals of a subagent type: the initials of its first two words (test-runner → TR), else its first two letters (Explore → EX). */
  function subAbbr(type) {
    const words = String(type || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
    return (words.length > 1 ? words[0].charAt(0) + words[1].charAt(0) : (words[0] || '?').slice(0, 2)).toUpperCase();
  }

  function renderStageSubs(active, subs) {
    const box = $('stage-subs-body');
    const running = (subs && subs.running) || [];
    const finished = ((subs && subs.finished) || []).slice().reverse();
    setText($('stage-subs-meta'), active ? running.length + ' laufen · ' + finished.length + ' fertig' : '');
    const all = active ? [...running, ...finished] : [];
    if (!all.length) {
      S.subsSig = '';
      return patchChildren(box, [stageEmpty(active ? 'Keine Subagents in dieser Session' : 'Keine Session aktiv')]);
    }
    const sig = all.map((x, i) => (x.tool_use_id || i) + ':' + (x.status === 'running' ? 'r' : 'd')).join(',');
    const right = (x) => {
      const k = fmtK(x.tokens && x.tokens.total_tokens);
      return x.status === 'running' ? fmtDuration((Date.now() - Date.parse(x.started_at)) / 1000) + ' · ' + k : 'fertig · ' + k;
    };
    // Rebuild only when the set or a state changes, so the running pulse is not restarted by every poll.
    if (sig !== S.subsSig) {
      S.subsSig = sig;
      box.replaceChildren(...all.map((x) => {
        const isRun = x.status === 'running';
        const row = el('div', null, 'stage-subagent ' + (isRun ? 'is-running' : 'is-done'));
        const av = el('span', null, 'sub-av');
        av.setAttribute('role', 'img');
        av.setAttribute('aria-label', String(x.subagent_type || '?') + ' · ' + (isRun ? 'läuft' : 'fertig'));
        const face = el('span', subAbbr(x.subagent_type), 'sub-abbr');
        face.setAttribute('aria-hidden', 'true');
        av.append(face);
        if (isRun) { const pulse = el('span', null, 'ring'); pulse.setAttribute('aria-hidden', 'true'); av.append(pulse); }
        const main = el('div', null, 'sub-main');
        main.append(el('span', x.subagent_type, 'sub-name'), el('span', oneLine(x.description, 160), 'sub-task'));
        row.append(av, main, el('span', right(x), 'sub-right'));
        return row;
      }));
    }
    all.forEach((x, i) => setText(box.children[i].querySelector('.sub-right'), right(x)));
  }

  function renderStage() {
    const team = S.team;
    const ok = !!(team && Array.isArray(team.seats));
    $('stage').hidden = !ok;
    if (!ok) return;
    // A finished run has no live session, whatever the last /team said.
    const active = S.ended || S.notFound ? null : team.active || null;
    const statuses = seatStatuses(team.seats, active);
    const k = statuses.indexOf('playing');
    setText($('stage-title'), 'Bühne · das Team von ' + splitId((S.detail && S.detail.issue_identifier) || ID).num);
    renderStageSeats(team.seats, statuses, active);
    renderStageFloor(team.seats, statuses);
    renderStageNow(active, k >= 0 ? team.seats[k] : null, team.trace);
    renderStageSession(active, team.compact_threshold);
    renderStageSubs(active, team.subagents);
  }

  // ------------------------------------------------------------------ score (Partitur)

  const SCORE_LANE_H = 44, SCORE_LANE_W = 120, SCORE_MIN_PLOT = 640, SCORE_MIN_TEXT_PX = 60;
  const SCORE_FAIL = '#f87171';
  // Handoff verdicts drawn in red; every other verdict takes the sender's role colour. Only a failed block turns red.
  const SCORE_RED = new Set(['failed', 'request_changes', 'changes_needed', 'changes_requested', 'issues_found', 'blocked', 'needs_info']);
  const scoreRed = (v) => typeof v === 'string' && SCORE_RED.has(v);
  const scoreColor = (role) => uiHex(seatColor((S.team && Array.isArray(S.team.seats) && S.team.seats.find((x) => x.role === role)) || { role, kind: null })) || UI_ROLE_COLORS.symphony;
  const scoreHm = (ms) => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  /** Stroke period in px from the tool calls per minute: 14 px when quiet, 1 px denser per call and minute, at least 4 px. */
  const scoreTick = (calls, ms) => Math.min(14, Math.max(4, Math.round(14 - calls / Math.max(ms / 60000, 1))));
  function scoreBlockTitle(b, ms, running) {
    return [seatName(b.role) + (b.round ? ' R' + b.round : ''), fmtDuration(Math.max(0, ms) / 1000), b.model ?? '—', b.verdict ?? (running ? 'läuft' : '—')].join(' · ');
  }
  const scoreMaxRound = (blocks) => blocks.reduce((m, b) => Math.max(m, b.round || 0), 0) || 1;
  const scoreSummary = (blocks, handoffs) => 'Partitur: ' + blocks.length + ' Sessions, ' + handoffs.length + ' Übergaben, Runde ' + scoreMaxRound(blocks);
  function scoreDiv(cls, style) {
    const n = el('div', null, cls);
    for (const k in style || {}) n.style[k] = style[k];
    return n;
  }

  function renderScore() {
    const team = S.team;
    const blocks = team && Array.isArray(team.blocks) ? team.blocks.filter((b) => b && Number.isFinite(Date.parse(b.started_at))) : [];
    $('score').hidden = !blocks.length;
    if (!blocks.length) { S.scoreSig = ''; return; }
    const handoffs = (Array.isArray(team.handoffs) ? team.handoffs : []).filter((h) => h && Number.isFinite(Date.parse(h.at)));
    const live = !S.ended && !S.notFound && !!team.active;
    const frame = $('score-frame');
    const width = frame.clientWidth || 0;
    const sig = JSON.stringify([blocks, handoffs, team.seats && team.seats.map((s) => [s.role, s.kind]), live, live ? Math.floor(Date.now() / 60000) : 0, width]);
    if (sig === S.scoreSig) return;
    S.scoreSig = sig;

    const t0 = Math.min(...blocks.map((b) => Date.parse(b.started_at)));
    const endOf = (b) => (b.ended_at ? Date.parse(b.ended_at) : null);
    const lastEnd = Math.max(...blocks.map((b) => endOf(b) ?? Date.parse(b.started_at)), ...handoffs.map((h) => Date.parse(h.at)));
    // Under a minute the axis still spans one minute, so short blocks stay visible.
    const t1 = Math.max(live ? Date.now() : lastEnd, t0 + 60000);
    const span = t1 - t0;
    const frac = (t) => Math.min(1, Math.max(0, (t - t0) / span));
    const pct = (t) => (frac(t) * 100).toFixed(2) + '%';
    const plotPx = Math.max(SCORE_MIN_PLOT, width - SCORE_LANE_W);
    const roles = (team.seats || []).map((s) => s.role).filter((r) => r !== 'you');
    for (const b of blocks) if (!roles.includes(b.role)) roles.push(b.role);
    const lane = (role) => roles.indexOf(role);

    setText($('score-title'), 'Partitur · Ablauf seit ' + scoreHm(t0));
    frame.setAttribute('aria-label', scoreSummary(blocks, handoffs) + ', horizontal scrollbar');
    $('score-lanes').replaceChildren(...roles.map((r) => {
      const row = el('div', null, 'score-lane');
      row.setAttribute('data-role', r);
      const dot = el('i', null, 'score-dot');
      dot.setAttribute('aria-hidden', 'true');
      dot.style.background = scoreColor(r);
      row.append(dot, el('span', seatName(r)));
      return row;
    }));

    const plot = $('score-plot');
    plot.style.height = roles.length * SCORE_LANE_H + 'px';
    const parts = [];
    for (const p of [25, 50, 75]) parts.push(scoreDiv('score-grid-v', { left: p + '%' }));
    roles.forEach((_r, i) => parts.push(scoreDiv('score-grid-h', { top: (i + 1) * SCORE_LANE_H - 1 + 'px' })));

    let maxRound = 0;
    for (const b of [...blocks].sort((a, c) => Date.parse(a.started_at) - Date.parse(c.started_at))) {
      const r = b.round || 0;
      if (r > maxRound) {
        if (maxRound) {
          const x = pct(Date.parse(b.started_at));
          const line = scoreDiv('score-round', { left: x });
          line.setAttribute('data-round', r);
          line.setAttribute('aria-hidden', 'true');
          const label = el('span', 'Runde ' + r, 'score-round-label mono');
          label.style.left = 'calc(' + x + ' + 6px)';
          parts.push(line, label);
        }
        maxRound = r;
      }
    }

    for (const b of blocks) {
      const s = Date.parse(b.started_at), e = Math.max(endOf(b) ?? t1, s);
      const running = live && (b.ended_at === null || b.ended_at === undefined);
      const failed = b.verdict === 'failed';
      const c = scoreColor(b.role);
      const w = Math.max(0.4, (frac(e) - frac(s)) * 100);
      const calls = Number(b.tool_calls) || 0;
      const blk = scoreDiv('blk' + (running ? ' now' : '') + (failed ? ' failed' : '') + (calls > 0 ? '' : ' quiet'), {
        left: pct(s), width: w.toFixed(2) + '%', top: lane(b.role) * SCORE_LANE_H + 7 + 'px',
        background: failed ? 'rgba(248,113,113,.22)' : uiRgba(c, running ? '.42' : '.24'), borderColor: failed ? SCORE_FAIL : c,
      });
      if (failed) blk.style.color = '#fecaca';
      if (calls > 0) blk.style.setProperty('--tick', scoreTick(calls, e - s) + 'px');
      if (running) blk.style.setProperty('--glow', uiRgba(c, '.55'));
      const title = scoreBlockTitle(b, e - s, running);
      blk.title = title;
      for (const [k, v] of [['role', 'img'], ['tabindex', '0'], ['aria-label', title], ['data-role', b.role], ['data-run', b.run], ['data-round', b.round || ''], ['data-calls', calls]]) blk.setAttribute(k, String(v ?? ''));
      const text = running ? (b.round ? 'Runde ' + b.round + ' · spielt' : 'spielt') : (b.verdict ?? '—');
      blk.append(el('span', (w / 100) * plotPx < SCORE_MIN_TEXT_PX ? '' : text));
      parts.push(blk);
    }

    for (const h of handoffs) {
      const a = lane(h.from), z = lane(h.to);
      if (a < 0 || z < 0 || a === z) continue;
      const x = pct(Date.parse(h.at));
      const color = scoreRed(h.verdict) ? SCORE_FAIL : scoreColor(h.from);
      const hand = scoreDiv('score-hand ' + (z > a ? 'down' : 'up') + (frac(Date.parse(h.at)) > 0.88 ? ' flip' : ''), {
        left: 'calc(' + x + ' - 1px)', top: Math.min(a, z) * SCORE_LANE_H + 37 + 'px', height: Math.abs(z - a) * SCORE_LANE_H - 30 + 'px', background: color,
      });
      hand.style.setProperty('--c', color);
      for (const [k, v] of [['data-from', h.from], ['data-to', h.to], ['data-verdict', h.verdict ?? '']]) hand.setAttribute(k, String(v));
      const arrow = el('i', null, 'score-arrow');
      arrow.setAttribute('aria-hidden', 'true');
      const label = el('span', h.verdict || '—', 'score-hand-label');
      label.style.color = color;
      hand.append(arrow, label);
      parts.push(hand);
    }

    if (live) { const now = scoreDiv('score-now-line'); now.setAttribute('aria-hidden', 'true'); parts.push(now); }
    plot.replaceChildren(...parts);

    $('score-axis').replaceChildren(...[0, 1, 2, 3, 4].map((k) => {
      const t = scoreHm(t0 + (k * span) / 4);
      return k === 4 && live ? el('span', 'jetzt ' + t, 'now') : el('span', t);
    }));
  }

  // ------------------------------------------------------------------ sidebar Context-Verlauf

  // Context peak of every developer run from its run_finished line in the repository history (GET /api/v1/history/entries).
  // Loaded once after the first detail poll and again when another session has finished; without history it shows "—".
  let ctxLoading = false;
  const finishedSessions = () => ((S.detail && S.detail.sessions) || []).filter((s) => s.finished_at).length;
  async function loadContextHistory() {
    if (ctxLoading) return;
    const identifier = (S.detail && S.detail.issue_identifier) || ID;
    ctxLoading = true;
    S.ctxFinished = finishedSessions();
    let rows = [];
    try {
      const r = await getJson('/api/v1/history/entries?issue=' + encodeURIComponent(identifier) + '&event=run_finished&order=asc&limit=200');
      // The server matches the issue as a substring (#1 also finds #10): compare exactly here.
      if (r.ok && r.body && Array.isArray(r.body.entries)) rows = r.body.entries.filter((e) => e && e.issue === identifier && e.role === 'developer');
    } catch {}
    S.ctxEntries = rows;
    ctxLoading = false;
    renderContextHistory();
  }
  function maybeLoadContextHistory() {
    if (!S.detail || S.ended) return;
    if (S.ctxEntries === null || finishedSessions() > S.ctxFinished) loadContextHistory();
  }
  /** Changes and Brain-Zugriffe of this issue, reloaded with every poll; a failing call keeps what was shown. */
  const PR_TONES = { success: 'green', pending: 'amber', failure: 'red', none: 'gray' };
  async function loadSideFeeds() {
    const q = encodeURIComponent((S.detail && S.detail.issue_identifier) || ID);
    const [c, a] = await Promise.all([
      getJson('/api/v1/changes?issue=' + q + '&limit=10').catch(() => null),
      getJson('/api/v1/brain/access?issue=' + q + '&limit=10').catch(() => null),
    ]);
    if (c && c.ok && c.body && Array.isArray(c.body.entries)) S.changes = c.body.entries.slice(0, 10);
    if (a && a.status === 404) S.brainOff = true;
    else if (a && a.ok && a.body && Array.isArray(a.body.access)) { S.brainOff = false; S.accessSeen = true; S.access = a.body.access.slice(0, 10); }
  }
  const sideRole = (role) => (role ? chip(role, { tone: uiOwn(UI_ROLE_COLORS, role) || 'gray', dot: true }) : chip('—'));

  function renderChanges() {
    const identifier = (S.detail && S.detail.issue_identifier) || ID;
    $('changes-all').href = '/changes?issue=' + encodeURIComponent(identifier);
    const rows = (S.changes || []).map((e) => {
      const li = el('li', null, 'side-chg');
      li.dataset.id = String(e.id || '');
      const head = el('div', null, 'side-chg-head');
      head.append(el('time', fmtStamp(e.at), 'mono muted'), sideRole(e.role));
      if (e.pr) {
        const pr = chip('#' + e.pr.number, { tone: PR_TONES[e.pr.status] || 'gray', dot: true, mono: true });
        pr.classList.add('side-pr');
        pr.title = 'Checks: ' + e.pr.status;
        head.append(pr);
      }
      li.append(head, el('div', e.title, 'side-chg-title'));
      const files = Array.isArray(e.files) ? e.files : [];
      if (files.length) {
        const ul = el('ul', null, 'side-files');
        for (const file of files.slice(0, 3)) {
          const row = el('li');
          const path = el('span', file.path, 'mono side-path');
          path.title = file.path;
          row.append(path);
          if (typeof file.added === 'number' && typeof file.deleted === 'number') row.append(el('span', '+' + file.added, 'mono side-add'), el('span', '\\u2212' + file.deleted, 'mono side-del'));
          ul.append(row);
        }
        if (files.length > 3) ul.append(el('li', '+' + (files.length - 3) + ' weitere', 'muted'));
        li.append(ul);
      }
      return li;
    });
    patchChildren($('changes-list'), rows);
    $('changes-empty').hidden = !(S.changes && S.changes.length === 0);
  }

  function renderAccess() {
    $('access-section').hidden = S.brainOff || !S.accessSeen;
    const rows = (S.access || []).map((a) => {
      const rejected = a.result === 'rejected';
      const li = el('li', null, 'side-acc' + (rejected ? ' rejected' : ''));
      const path = el('span', a.path_or_query, 'mono side-path');
      path.title = a.purpose || a.path_or_query || '';
      li.append(el('time', fmtStamp(a.at), 'mono muted'), sideRole(a.role), el('span', a.op, 'mono side-op'), path);
      li.append(rejected ? chip('abgewiesen' + (a.reason ? ' · ' + a.reason : ''), { tone: 'red' }) : chip(String(a.result || 'ok'), { tone: 'green' }));
      if (rejected && (a.op === 'write' || a.op === 'append')) {
        const link = el('a', 'Clash ansehen', 'side-clash');
        link.href = '/brain#clashes';
        li.append(link);
      }
      return li;
    });
    patchChildren($('access-list'), rows);
    $('access-empty').hidden = !(S.access && S.access.length === 0);
  }

  /** A history field as a number; null for a missing or logged-as-null value. */
  const historyNumber = (v) => (v === undefined || v === null || v === '' || v === 'null' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

  function renderContextHistory() {
    const entries = (S.ctxEntries || []).filter((e) => historyNumber(e.context_peak_percent) !== null);
    const blocks = (S.team && Array.isArray(S.team.blocks)) ? S.team.blocks : [];
    const rows = entries.map((e, i) => {
      const pct = historyNumber(e.context_peak_percent);
      const compacts = historyNumber(e.context_compacts) || 0;
      const block = blocks.find((b) => b.run === e.run);
      const round = block && block.round ? block.round : i + 1;
      const li = el('li', null, 'ctx-run');
      li.dataset.run = String(e.run || '');
      li.title = 'Runde ' + round + ' · Context-Peak ' + Math.round(pct) + ' %' + (compacts ? ' · ' + compacts + ' Auto-Compacts' : '');
      li.append(el('span', 'R' + round, 'ctx-round'), bar(pct, { height: 6, color: pct >= 70 ? UI_TRAFFIC.amber : UI_TRAFFIC.green }), el('span', Math.round(pct) + ' %', 'ctx-pct mono'));
      if (compacts > 0) {
        const mark = el('span', '⇣' + compacts, 'ctx-compact');
        mark.title = compacts + ' Auto-Compacts';
        li.append(mark);
      } else li.append(el('span'));
      return li;
    });
    patchChildren($('ctx-runs'), rows);
    $('ctx-empty').hidden = rows.length > 0;
  }

  // ------------------------------------------------------------------ tabs Trace, Sessions, Transkript

  const TABS = ['trace', 'sessions', 'transkript'];
  /** Shows one tab panel; the hash (#trace, #sessions, #transkript) follows without a new history entry. */
  function selectTab(id, opts) {
    if (!TABS.includes(id)) id = 'trace';
    S.tab = id;
    for (const t of TABS) {
      const tab = $('tab-' + t);
      tab.setAttribute('aria-selected', String(t === id));
      tab.setAttribute('tabindex', t === id ? '0' : '-1');
      $('panel-' + t).hidden = t !== id;
    }
    if (opts && opts.focus) $('tab-' + id).focus();
    if (opts && opts.hash && location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
    if (id === 'trace') {
      const list = $('timeline');
      if (!S.unseen) list.scrollTop = list.scrollHeight;
      updateJump();
    } else if (id === 'transkript') renderTranscript();
  }
  const applyHash = () => selectTab(String(location.hash || '').slice(1));

  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[role="tab"]');
    if (b) selectTab(b.dataset.id, { hash: true });
  });
  $('tabs').addEventListener('keydown', (e) => {
    const i = TABS.indexOf(S.tab);
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    selectTab(TABS[next], { focus: true, hash: true });
  });
  window.addEventListener('hashchange', applyHash);

  // Transkript: prompts, responses, thinking, model and tool calls of one session, newest session with a transcript first.
  const TX_TYPES = new Set(['prompt', 'response', 'thinking', 'toolcall', 'model']);
  function renderTranscript() {
    const sessions = ((S.detail && S.detail.sessions) || []).slice().reverse();
    if (!S.txRun || !sessions.some((s) => s.run === S.txRun)) {
      const withTx = sessions.find((s) => s.transcript);
      S.txRun = withTx ? withTx.run : sessions.length ? sessions[0].run : '';
    }
    const select = $('tx-run');
    const options = sessions.map((s) => {
      const o = el('option', s.run + ' · ' + s.role + ' · ' + s.state);
      o.value = s.run;
      if (s.run === S.txRun) o.selected = true;
      return o;
    });
    patchChildren(select, options);
    select.value = S.txRun;
    const session = sessions.find((s) => s.run === S.txRun);
    const links = [];
    if (session && session.transcript) {
      const a = el('a', 'Transkript (JSONL) ↗');
      a.href = API + '/transcript?run=' + encodeURIComponent(session.run) + '&format=raw';
      a.target = '_blank'; a.rel = 'noopener';
      links.push(a);
    }
    patchChildren($('tx-links'), links);
    const items = S.items.filter((it) => it.run === S.txRun && TX_TYPES.has(it.type));
    const sig = S.txRun + '|' + items.map((it) => it.key + '~' + it.sig + (isOpen(it) ? '+' : '-')).join(',');
    if (sig === S.txSig) return;
    S.txSig = sig;
    const list = $('transcript');
    if (!items.length) {
      const t = S.tx.get(S.txRun);
      list.replaceChildren(el('li', 'Kein Transkript für diese Session' + (t && t.reason ? ' (' + t.reason + ')' : ''), 'note'));
      return;
    }
    list.replaceChildren(...items.map((it) => buildItem(it, false)));
  }
  $('tx-run').addEventListener('change', (e) => { S.txRun = e.target.value; S.txSig = ''; renderTranscript(); });
  $('transcript').addEventListener('click', (e) => {
    const toggle = e.target.closest('button.toggle');
    if (!toggle) return;
    const key = toggle.closest('li.item').dataset.key;
    if (S.expanded.has(key)) S.expanded.delete(key); else S.expanded.add(key);
    S.txSig = ''; S.listSig = '';
    renderTranscript();
    renderTimeline();
  });

  // ------------------------------------------------------------------ render + interactions

  function render() {
    renderStatusbar();
    // The item list only changes with new events or transcript lines; header and summary refresh every time.
    if (S.dirty || !S.built) { S.items = buildItems(); S.dirty = false; S.built = true; }
    // Items that arrived with this poll get a short highlight (not ones re-rendered after a filter change).
    for (const it of S.items) if (!S.known.has(it.key)) { S.known.add(it.key); if (S.rendered) S.fresh.add(it.key); }
    if (S.detail || S.ended || S.notFound) {
      renderHead();
      renderStage();
      renderScore();
      renderPipelineSection();
      renderResults();
      renderGate();
      renderIssueMeta();
      renderAlert();
      renderIntegrations();
      renderSummary();
    }
    renderContextHistory();
    renderAccess();
    renderChanges();
    if (S.tab === 'transkript') renderTranscript();
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
    setText($('raw-toggle'), S.rawOpen ? 'Raw-Logs ausblenden' : 'Raw-Logs anzeigen');
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
  // The Übersicht breadcrumb keeps the dashboard's history entry when we came from it.
  document.querySelector('nav[aria-label="Brotkrumen"] a[href="/"]').addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    try { if (document.referrer && new URL(document.referrer).origin === location.origin && new URL(document.referrer).pathname === '/' && history.length > 1) { e.preventDefault(); history.back(); } } catch {}
  });

  // Runtime and countdowns tick between polls.
  setInterval(() => { if (S.detail && !S.ended) { renderHead(); renderAlert(); renderStage(); } }, 1000);

  applyHash();
  if (!ID) render();
  else { render(); poll(); live(poll, pollEvery(poll, POLL_MS)); }
  // Tests load the page in a fake DOM and render a fixture through window.__render.
  if (window.__SYMPHONY_TEST__) window.__render = (state) => { Object.assign(S, state); if (state && state.tab) selectTab(state.tab); render(); };
})();
`,
});
