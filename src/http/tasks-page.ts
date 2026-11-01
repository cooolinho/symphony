import type { PlanReasonCode } from '../orchestrator/dispatch-plan.ts';
import { AURORA, escapeHtml, page, pageHeader } from './ui/layout.ts';
import { SCALES } from './ui/palette.ts';

/**
 * Tasks page: the dispatcher queue in six glass columns (Läuft, Als Nächstes, Wartet, Pausiert, Blockiert, Kürzlich
 * erledigt) with cards (number, priority/place, title, repo, reason chip in the column tone, owner, action) and the
 * control actions of the existing routes. Like overview-teams.ts the CSS and the script are inlined
 * (TASKS_CSS/TASKS_JS); all top-level script names start with `task`/`TASK_` so they cannot collide with BASE_JS or the
 * components. The head holds a glass pill with the agent slots (PUT/DELETE /api/v1/settings/agents) and the model-hold
 * chips; column limits, reservations, reset and the model pause (POST /api/v1/models/<m>/hold|release) sit in a
 * details block below. The columns are pre-rendered, so empty ones show their text at once.
 */

export interface TaskColumn {
  key: 'running' | 'next' | 'waiting' | 'paused' | 'blocked' | 'done';
  title: string;
  empty: string;
  tone: 'run' | 'next' | 'wait' | 'pause' | 'block' | 'done';
  /** #rrggbb of the column dot. */
  color: string;
}

export const TASK_COLUMNS: ReadonlyArray<TaskColumn> = [
  { key: 'running', title: 'Läuft', empty: 'Nichts läuft', tone: 'run', color: SCALES.green[400] },
  { key: 'next', title: 'Als Nächstes', empty: 'Nichts in der Warteschlange', tone: 'next', color: SCALES.sky[300] },
  { key: 'waiting', title: 'Wartet', empty: 'Nichts wartet', tone: 'wait', color: SCALES.amber[400] },
  { key: 'paused', title: 'Pausiert', empty: 'Nichts pausiert', tone: 'pause', color: SCALES.amber[400] },
  { key: 'blocked', title: 'Blockiert', empty: 'Nichts blockiert', tone: 'block', color: SCALES.red[400] },
  { key: 'done', title: 'Kürzlich erledigt', empty: 'Noch nichts erledigt', tone: 'done', color: SCALES.violet[300] },
];

/** German text of every PlanReasonCode (the compiler enforces all codes); `column` is the blocked-column reason. */
export const REASON_LABELS: Record<PlanReasonCode | 'column', string> = {
  ready: 'Startbereit',
  no_free_slot: 'Kein freier Slot',
  column_limit: 'Spaltenlimit erreicht',
  reserved_for_role: 'Slot für andere Rolle reserviert',
  backoff: 'Backoff nach Fehler',
  session_limit: 'Session-Limit erreicht',
  model_hold: 'Modell pausiert',
  waiting_for_sub_issues: 'Wartet auf Sub-Issues',
  inactive: 'Nicht aktiv',
  paused: 'Pausiert',
  blocked: 'Blockiert',
  missing_label: 'Pflicht-Label fehlt',
  column: 'In Blockiert-Spalte',
};

const OUTCOME_LABELS: Record<string, string> = {
  handed_off: 'Übergeben',
  continuing: 'Fortgesetzt',
  failed: 'Fehlgeschlagen',
  stopped: 'Gestoppt',
  stalled: 'Hängt',
  shutdown: 'Beendet',
  session_limit: 'Session-Limit',
};

export const CONTROLS_OFF = 'Steuerung deaktiviert: SYMPHONY_ALLOW_REMOTE_CONTROL=true hinter einem authentifizierenden Proxy setzen';

export const TASKS_CSS = `
  .tasks-page { display: grid; gap: 18px; }
  .task-off { margin: 0; color: var(--fg-3, var(--muted)); font-size: 13px; }
  .task-pill { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; padding: 8px 12px; border-radius: 999px; }
  .task-pill-label { font-size: 13px; color: var(--fg-2, var(--muted)); }
  .task-pill-step, .task-pill-chips { display: contents; }
  .task-slot-count { font: 18px var(--mono); min-width: 44px; text-align: center; font-variant-numeric: tabular-nums; color: var(--fg-strong, inherit); }
  .task-slot-notes { margin: 0; display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 12px; color: var(--amber); }
  .task-slot-notes .task-slot-error { color: var(--red); }
  .task-more { padding: 4px 14px; }
  .task-more summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; font-size: 13px; color: var(--fg-2, var(--muted)); }
  .task-more-body { display: grid; gap: 12px; padding-bottom: 12px; }
  .task-slots, .task-hold-list { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; margin: 0; padding: 0;
    list-style: none; font: 12px var(--mono); color: var(--fg-3, var(--muted)); }
  .task-slot-item, .task-hold { display: inline-flex; align-items: center; gap: 6px; }
  .task-slot-item b, .task-hold b { color: var(--fg-strong, inherit); font-weight: 600; }
  .task-slot-item b { min-width: 2ch; text-align: center; }
  .task-slot-step:disabled, .task-slot-reset:disabled { opacity: .4; cursor: default; }
  .task-slot-override { color: var(--amber); }
  .task-holds-title { margin: 0 0 6px; font: 600 13px var(--sans); }
  .task-hold-reason { color: var(--amber); }
  .tasks-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px; align-items: start; }
  .task-col { min-width: 0; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
  .task-col-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .task-col-name { display: inline-flex; align-items: center; gap: 8px; }
  .task-col-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--col); flex: none; }
  .task-col h2 { margin: 0; font: 600 14px var(--sans); letter-spacing: 0; text-transform: none; color: var(--fg-strong, inherit); }
  .task-count { font: 12px var(--mono); font-variant-numeric: tabular-nums; color: var(--fg-3, var(--muted)); }
  .task-tone-run { color: var(--task-run); background: var(--task-run-bg); }
  .task-tone-next { color: var(--task-next); background: var(--task-next-bg); }
  .task-tone-wait { color: var(--task-wait); background: var(--task-wait-bg); }
  .task-tone-pause { color: var(--task-pause); background: var(--task-pause-bg); }
  .task-tone-block { color: var(--task-block); background: var(--task-block-bg); }
  .task-tone-done { color: var(--task-done); background: var(--task-done-bg); }
  .task-list { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .tasks-grid .card { min-width: 0; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
  .tasks-grid .card:hover { border-color: rgba(255, 255, 255, .18); }
  .task-card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .task-num { font: 12.5px var(--mono); color: var(--fg-label, var(--muted)); }
  .task-place { font: 11px var(--mono); color: var(--fg-3, var(--muted)); }
  .task-title { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; color: var(--fg-strong, inherit); }
  .task-repo { font: 11.5px var(--mono); color: var(--fg-3, var(--muted)); overflow-wrap: anywhere; }
  .task-reason { align-self: flex-start; padding: 5px 10px; border-radius: 10px; font-size: 12px; overflow-wrap: anywhere; }
  .task-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .task-owner { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fg-2, var(--muted)); }
  .task-owner-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .task-foot .ui-btn.is-busy { opacity: .6; }
  .task-foot .ui-btn.is-failed { color: var(--red); }
  .task-empty { margin: 0; color: var(--fg-3, var(--muted)); font-size: 12.5px; }
`;

export const TASKS_JS = `
  const TASK_COLUMNS = ${JSON.stringify(TASK_COLUMNS)};
  const TASK_REASONS = ${JSON.stringify(REASON_LABELS)};
  const TASK_OUTCOMES = ${JSON.stringify(OUTCOME_LABELS)};
  const TASK_WAIT_CODES = new Set(['model_hold', 'session_limit', 'waiting_for_sub_issues']);
  const TASK_READING = new Set(['analyst', 'architect']);
  const TASK_REVIEWING = new Set(['reviewer', 'tester', 'security']);
  const TASK_HUMAN = { label: 'Mensch', color: UI_ROLE_COLORS.human };
  const TASK_SYMPHONY = { label: 'Symphony', color: UI_ROLE_COLORS.symphony };
  const TASK_SLOT_MAX = 8;
  const TASK_UNFORCEABLE = new Set(['model_hold', 'waiting_for_sub_issues']);
  // Route, label, busy label and success label of each control verb.
  const TASK_CONTROL = {
    pause: ['Pausieren', 'Pausiere…', 'Pausiert'],
    force: ['Jetzt starten', 'Starte…', 'Gestartet'],
    retry: ['Jetzt erneut', 'Starte neu…', 'Eingereiht'],
    resume: ['Fortsetzen', 'Setze fort…', 'Eingereiht'],
  };
  const TASK_DONE_LIMIT = 10;
  // Outcome of a control click per "<identifier> <verb>"; a poll rebuilds the cards, so the button is drawn from here.
  const taskButtons = new Map();
  const taskFps = new Map();
  let taskAllowed = true;
  let taskLast = null;
  let taskLoading = false;
  let taskAgain = false;
  let taskDone = null;
  let taskIds = new Set();

  function taskById(key) {
    return document.getElementById(key);
  }

  function taskNumber(id) {
    return '#' + String(id).slice(String(id).lastIndexOf('#') + 1);
  }

  function taskRole(row, state) {
    if (row.running && row.running.role) return row.running.role;
    const active = (row.stages || []).find((s) => s.kind === 'agent' && s.status === 'active');
    if (active) return active.id;
    const roles = (state.pipeline_config && state.pipeline_config.roles) || [];
    const col = String(row.state || '').toLowerCase();
    const match = roles.find((r) => (r.states || []).some((s) => String(s).toLowerCase() === col));
    return match ? match.name : null;
  }

  const taskCap = (text) => String(text || '').charAt(0).toUpperCase() + String(text || '').slice(1);
  const taskHm = (iso) => (iso ? new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '--:--');
  const taskCode = (row) => (row.reason && typeof row.reason === 'object' ? row.reason.code : row.reason_code);

  /** The column of a row: "next" rows that wait for a model, a session limit or sub-issues belong to "Wartet". */
  function taskGroups(state) {
    const groups = { running: [], next: [], waiting: [], paused: [], blocked: state.blocked || [] };
    for (const r of state.issues || []) {
      const key = r.section === 'next' && TASK_WAIT_CODES.has(taskCode(r)) ? 'waiting' : r.section;
      if (groups[key]) groups[key].push(r);
    }
    groups.next.sort((a, b) => (a.position || 0) - (b.position || 0));
    return groups;
  }

  /** Blockers that are not in a terminal state (an unknown state counts as open). */
  function taskOpenBlockers(row, state) {
    const done = ((state.health && state.health.terminal_states) || []).map((s) => String(s).toLowerCase());
    return (row.blocked_by || []).filter((b) => b && (!b.state || !done.includes(String(b.state).toLowerCase())));
  }

  function taskTitleOf(identifier, state) {
    const row = [...(state.issues || []), ...(state.blocked || [])].find((r) => r.issue_identifier === identifier);
    return row && row.title ? row.title : null;
  }

  function taskReason(row, col, state) {
    const code = taskCode(row);
    const fallback = TASK_REASONS[code] || (row.reason && row.reason.text) || (typeof row.reason === 'string' ? row.reason : '') || code || '';
    if (col === 'running') {
      const role = row.running && row.running.role;
      const roles = (state.pipeline_config && state.pipeline_config.roles) || [];
      const def = roles.find((r) => r.name === role);
      const verb = TASK_REVIEWING.has(role) ? 'prüft' : TASK_READING.has(role) || (def && def.read_only) ? 'liest' : 'spielt';
      return (UI_ROLE_NAMES[role] || role || 'Agent') + ' ' + verb + ' · Runde ' + ((row.review_rounds || 0) + 1) + ' · ' + fmtDuration(row.running ? row.running.seconds_running : 0);
    }
    if (col === 'next') return code === 'column_limit' ? 'Wartet auf Slot in ' + row.state : 'Startet, sobald ein Slot frei ist';
    if (col === 'waiting') {
      const retry = row.retry;
      if (code === 'model_hold') {
        const hold = row.model_hold || (retry && retry.limit ? { model: retry.limit.model, until: retry.due_at } : null);
        if (!hold || !hold.model) return fallback;
        return hold.until ? 'Modell-Limit: ' + taskCap(hold.model) + ' pausiert bis ' + taskHm(hold.until) : taskCap(hold.model) + ' von dir pausiert';
      }
      if ((code === 'backoff' || code === 'session_limit') && retry) return 'Retry in ' + Math.max(1, Math.ceil((retry.due_in_ms || 0) / 60000)) + ' min · ' + code;
      if (code === 'waiting_for_sub_issues') return 'Wartet auf Blocker-Merge';
      return fallback;
    }
    if (col === 'paused') {
      const p = row.paused || {};
      if ((row.labels || []).some((l) => String(l).toLowerCase() === 'needs-human')) return 'needs-human nach ' + (row.review_rounds || 0) + ' Review-Runden';
      if (p.source === 'budget') return 'Kostenbudget erreicht · ' + fmtUsd(p.cost_usd) + ' von ' + fmtUsd(p.max_issue_cost_usd);
      if (p.source === 'continuations') return 'Nach ' + (p.continuations || 0) + ' Fortsetzungen pausiert';
      return 'Von dir pausiert';
    }
    if (col === 'blocked') {
      const open = taskOpenBlockers(row, state);
      if (!open.length) return code === 'column' ? 'In Spalte ' + row.state : fallback;
      const short = open[0].identifier ? taskTitleOf(open[0].identifier, state) : null;
      const cut = short && short.length > 32 ? short.slice(0, 31) + '…' : short;
      return 'Blocked by ' + open.map((b) => (b.identifier ? taskNumber(b.identifier) : '#?')).join(', ') + (cut ? ' (' + cut + ')' : '');
    }
    return fallback;
  }

  function taskOwner(row, col, state) {
    if (col === 'running' || col === 'next') {
      const role = taskRole(row, state);
      if (!role) return col === 'running' ? null : TASK_SYMPHONY;
      return { label: UI_ROLE_NAMES[role] || role, color: UI_ROLE_COLORS[role] || UI_ROLE_COLORS.symphony };
    }
    if (col === 'paused') return TASK_HUMAN;
    if (col === 'blocked') return taskOpenBlockers(row, state).length ? TASK_SYMPHONY : TASK_HUMAN;
    return TASK_SYMPHONY;
  }

  /** The control verb of a card, or null (no button at all without permission). */
  function taskActionFor(row, col, rank) {
    if (!taskAllowed) return null;
    if (col === 'running') return row.running && row.running.stopping ? null : 'pause';
    if (col === 'next') return rank === 1 && !row.model_hold && !TASK_UNFORCEABLE.has(taskCode(row)) ? 'force' : null;
    if (col === 'waiting') return row.retry ? 'retry' : null;
    if (col === 'paused') return 'resume';
    return null;
  }

  /** View model of a card; it is also the fingerprint of the card (the text changes with every poll). */
  function taskView(row, col, rank, state) {
    const id = String(row.issue_identifier || '');
    const prio = row.priority !== null && row.priority !== undefined ? 'P' + row.priority : '';
    const right = col === 'next' ? [prio, 'Platz ' + rank].filter(Boolean).join(' · ') : prio;
    return { id, num: taskNumber(id), right, title: row.title || id, repo: row.repo || id.split('#')[0], tone: col === 'next' ? 'next' : TASK_COLUMNS.find((c) => c.key === col).tone,
      code: taskCode(row) || '', reason: taskReason(row, col, state), owner: taskOwner(row, col, state), verb: taskActionFor(row, col, rank) };
  }

  function taskButton(identifier, verb) {
    const st = taskButtons.get(identifier + ' ' + verb);
    const spec = TASK_CONTROL[verb];
    const b = button(st ? st.label : spec[0], { size: 36, onClick: () => taskControl(identifier, verb) });
    if (st && st.cls) b.classList.add(st.cls);
    if (st && st.cls === 'is-busy') b.setAttribute('aria-busy', 'true');
    b.dataset.identifier = identifier;
    b.dataset.verb = verb;
    b.setAttribute('aria-label', spec[0] + ' ' + identifier);
    return b;
  }

  function taskCard(v) {
    const card = el('article', null, 'gi card task-card');
    const head = el('div', null, 'task-card-head');
    const num = el('span', v.num, 'task-num');
    num.setAttribute('title', v.id);
    head.append(num, el('span', v.right, 'task-place'));
    const a = el('a', v.title, 'task-title');
    a.setAttribute('href', '/issue?id=' + encodeURIComponent(v.id));
    card.append(head, a, el('span', v.repo, 'task-repo'));
    if (v.reason) {
      const why = el('span', v.reason, 'task-reason task-tone-' + v.tone);
      if (v.code) why.setAttribute('title', v.code);
      card.append(why);
    }
    const foot = el('div', null, 'task-foot');
    const owner = el('span', null, 'task-owner');
    if (v.owner) {
      const dot = el('span', null, 'task-owner-dot');
      if (uiHex(v.owner.color)) dot.style.background = v.owner.color;
      dot.setAttribute('aria-hidden', 'true');
      owner.append(dot, el('span', v.owner.label));
    }
    foot.append(owner);
    if (v.verb) foot.append(taskButton(v.id, v.verb));
    card.append(foot);
    return card;
  }

  // Fingerprint of a view: the text of the card plus the outcome of the last click on its button.
  const taskViewFp = (v) => JSON.stringify([v, v.verb ? taskButtons.get(v.id + ' ' + v.verb) || null : null]);

  function taskFill(key, count, fp, build) {
    const col = TASK_COLUMNS.find((c) => c.key === key);
    taskById('col-' + key + '-count').textContent = pad2(count);
    if (taskFps.get(key) === fp) return;
    taskFps.set(key, fp);
    taskById('col-' + key).replaceChildren(...(count ? build() : [el('p', col.empty, 'task-empty')]));
  }

  // ---- Steuerung im Kopf: Agent-Slots (PUT/DELETE /api/v1/settings/agents) und Modelle (POST /api/v1/models/<m>/hold|release)
  let taskSlotBusy = false;
  let taskSlotError = '';
  const taskModelBusy = new Set();

  async function taskSlots(method, body) {
    if (taskSlotBusy) return;
    taskSlotBusy = true;
    let label = 'fehlgeschlagen';
    try {
      const init = { method, headers: { 'content-type': 'application/json' } };
      if (body !== null) init.body = JSON.stringify(body);
      const res = await fetch('/api/v1/settings/agents', init);
      let data = null;
      try { data = await res.json(); } catch {}
      label = res.ok ? (method === 'DELETE' ? 'auf WORKFLOW.md zurückgesetzt' : 'gespeichert') : (data && data.error && data.error.message) || 'fehlgeschlagen (' + res.status + ')';
      taskSlotError = res.ok ? '' : label;
    } catch {
      taskSlotError = label;
    }
    taskSlotBusy = false;
    if (taskSlotError) setTimeout(() => { taskSlotError = ''; }, 8000);
    taskById('announce').textContent = 'Agent-Slots: ' + label;
    setTimeout(taskLoad, 300);
  }

  function taskSlotStep(text, ariaLabel, body, disabled) {
    const b = button(text, { size: 36, ariaLabel });
    b.classList.add('task-slot-step');
    b.dataset.body = JSON.stringify(body);
    if (disabled || taskSlotBusy) b.disabled = true;
    return b;
  }

  /** The pill: "<occupied> / <total>" (aria-live), − / + within 1..8 and one chip per model hold. */
  function renderTaskPill(state) {
    const limits = state.limits;
    const total = limits ? limits.max_concurrent_agents.effective : state.health ? state.health.max_concurrent_agents : 0;
    const counts = state.counts || {};
    const text = Math.max((counts.running || 0) - (counts.forced || 0), 0) + ' / ' + total;
    const count = taskById('task-slot-count');
    if (count.textContent !== text) count.textContent = text;
    const steps = taskAllowed && limits;
    const cap = limits ? Math.min(TASK_SLOT_MAX, limits.max) : TASK_SLOT_MAX;
    patchChildren(taskById('task-slot-dec'), steps ? [taskSlotStep('−', 'Einen Slot weniger', { max_concurrent_agents: Math.min(total - 1, TASK_SLOT_MAX) }, total <= 1)] : []);
    patchChildren(taskById('task-slot-inc'), steps ? [taskSlotStep('+', 'Einen Slot mehr', { max_concurrent_agents: total + 1 }, total >= cap)] : []);
    const chips = (state.model_holds || []).map((h) => chip(taskCap(h.model) + ' pausiert' + (h.until ? ' · Limit bis ' + taskHm(h.until) : ''), { tone: 'amber' }));
    const free = (state.model_controls || []).filter((m) => !m.paused && !m.limit_until).map((m) => taskCap(m.model));
    if (free.length) chips.push(chip(free.join(' · ') + ' aktiv', { tone: 'green' }));
    patchChildren(taskById('task-pill-chips'), chips);
  }

  /** Column limits, reservations, reset and the hints about the total (the total itself is in the pill). */
  function renderTaskSlots(state) {
    const limits = state.limits;
    const host = taskById('task-slots');
    const notes = [];
    const nodes = [];
    if (limits) {
      const total = limits.max_concurrent_agents;
      // Forced sessions run beside the limit; only the others hold its slots.
      const running = (state.counts.running || 0) - (state.counts.forced || 0);
      for (const [column, v] of Object.entries(limits.by_state || {})) {
        const col = el('span', null, 'task-slot-item');
        col.append(el('span', column));
        if (taskAllowed && v.effective !== null) {
          col.append(taskSlotStep('−', 'Limit von ' + column + ' senken', { max_concurrent_agents_by_state: { [column]: Math.min(v.effective - 1, limits.max) } }, v.effective <= 1));
        }
        col.append(el('b', v.effective === null ? '–' : v.effective));
        if (taskAllowed) {
          col.append(v.effective === null
            ? taskSlotStep('+', 'Limit 1 für ' + column + ' setzen', { max_concurrent_agents_by_state: { [column]: 1 } }, false)
            : taskSlotStep('+', 'Limit von ' + column + ' erhöhen', { max_concurrent_agents_by_state: { [column]: v.effective + 1 } }, v.effective >= limits.max));
        }
        if (v.override !== null) {
          col.append(el('span', 'hier gesetzt · WORKFLOW.md ' + (v.workflow === null ? 'keins' : v.workflow), 'task-slot-override'));
          if (taskAllowed) col.append(taskSlotStep('×', 'WORKFLOW.md-Limit für ' + column + ' verwenden', { max_concurrent_agents_by_state: { [column]: null } }, false));
        }
        nodes.push(col);
      }
      for (const [role, r] of Object.entries(limits.reserved_slots_by_role || {})) {
        const res = el('span', null, 'task-slot-item');
        res.append(el('span', role + ' reserviert'));
        if (taskAllowed) res.append(taskSlotStep('−', 'Weniger Slots für ' + role + ' reservieren', { reserved_slots_by_role: { [role]: r.effective - 1 } }, r.effective <= 0));
        res.append(el('b', r.effective));
        if (taskAllowed) res.append(taskSlotStep('+', 'Einen Slot mehr für ' + role + ' reservieren', { reserved_slots_by_role: { [role]: r.effective + 1 } }, r.effective >= limits.max));
        if (r.override !== null) {
          res.append(el('span', 'hier gesetzt · WORKFLOW.md ' + r.workflow, 'task-slot-override'));
          if (taskAllowed) res.append(taskSlotStep('×', 'WORKFLOW.md-Reservierung für ' + role + ' verwenden', { reserved_slots_by_role: { [role]: null } }, false));
        }
        nodes.push(res);
      }
      if (taskAllowed && limits.override_active) {
        const reset = button('Auf WORKFLOW.md zurücksetzen (' + total.workflow + ')', { size: 36 });
        reset.classList.add('task-slot-reset');
        if (taskSlotBusy) reset.disabled = true;
        nodes.push(reset);
      }
      const reservedRoles = Object.entries(limits.reserved_slots_by_role || {});
      let reservedSum = 0;
      for (const [, r] of reservedRoles) reservedSum += r.effective;
      const unreserved = reservedRoles.filter(([, r]) => r.effective === 0).map(([role]) => role);
      if (!limits.reservation_problem && reservedSum > 0 && reservedSum >= total.effective && total.effective > 0 && unreserved.length > 0) {
        notes.push(el('span', 'Alle Slots reserviert: ' + unreserved.join(', ') + ' starten nur mit mehr Slots', 'task-slot-note'));
      }
      if (total.effective === 0) {
        notes.push(el('span', 'Limit 0: neue Starts pausiert' + (running > 0 ? ', ' + running + ' laufen weiter' : ''), 'task-slot-note'));
      } else if (running > total.effective) {
        const finish = running - total.effective + 1;
        notes.push(el('span', running + ' laufen, Limit ' + total.effective + ': keine neuen Starts, bis ' + (finish === 1 ? 'einer fertig ist' : finish + ' fertig sind'), 'task-slot-note'));
      }
    }
    if (taskSlotError) notes.push(el('span', taskSlotError, 'task-slot-error'));
    host.hidden = nodes.length === 0;
    patchChildren(host, nodes);
    const noteHost = taskById('task-slot-notes');
    noteHost.hidden = notes.length === 0;
    patchChildren(noteHost, notes);
  }

  async function taskModel(model, hold) {
    if (taskModelBusy.has(model)) return;
    taskModelBusy.add(model);
    let label = 'fehlgeschlagen';
    try {
      const res = await fetch('/api/v1/models/' + encodeURIComponent(model) + '/' + (hold ? 'hold' : 'release'), { method: 'POST' });
      let body = null;
      try { body = await res.json(); } catch {}
      label = res.ok ? (hold ? 'pausiert' : 'fortgesetzt') : (body && body.error && body.error.message) || 'fehlgeschlagen (' + res.status + ')';
    } catch {}
    taskModelBusy.delete(model);
    taskById('announce').textContent = 'Modell ' + model + ': ' + label;
    setTimeout(taskLoad, 300);
  }

  /** One row per model family: reason (operator pause and/or limit hold with its issue) and reset time. */
  function renderTaskHolds(state) {
    const models = state.model_controls || [];
    const holds = state.model_holds || [];
    taskById('task-holds').hidden = models.length === 0;
    taskById('task-more').hidden = taskById('task-slots').hidden && models.length === 0;
    const nodes = models.map((m) => {
      const li = el('li', null, 'task-hold');
      const parts = [];
      if (m.paused) parts.push('vom Operator pausiert');
      const limit = holds.find((h) => h.model === m.model && h.source === 'limit');
      if (limit) parts.push((limit.text || 'Modell-Limit') + (limit.issue_identifier ? ' · ausgelöst von ' + limit.issue_identifier : ''));
      li.append(el('b', m.model), el('span', parts.length ? parts.join(' · ') : 'läuft', parts.length ? 'task-hold-reason' : ''));
      if (m.limit_until) li.append(el('span', 'Reset ' + fmtTime(m.limit_until)));
      else if (m.paused) li.append(el('span', 'bis zur Freigabe'));
      if (taskAllowed) {
        const b = button(m.paused ? 'Fortsetzen' : 'Pausieren', { size: 36, ariaLabel: 'Modell ' + m.model + (m.paused ? ' fortsetzen' : ' pausieren') });
        b.classList.add('task-model');
        b.dataset.model = m.model;
        b.dataset.hold = m.paused ? '0' : '1';
        if (taskModelBusy.has(m.model)) b.setAttribute('aria-busy', 'true');
        li.append(b);
      }
      return li;
    });
    patchChildren(taskById('task-hold-list'), nodes);
  }

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const step = target ? target.closest('button.task-slot-step') : null;
    if (step && !step.disabled) taskSlots('PUT', JSON.parse(step.dataset.body));
    const reset = target ? target.closest('button.task-slot-reset') : null;
    if (reset && !reset.disabled) taskSlots('DELETE', null);
    const model = target ? target.closest('button.task-model') : null;
    if (model) taskModel(model.dataset.model, model.dataset.hold === '1');
  });

  function renderTasks(state) {
    taskLast = state;
    taskAllowed = !state.controls || state.controls.retry !== false;
    taskById('tasks-controls-off').hidden = taskAllowed;
    taskById('tasks-error').hidden = true;
    renderTaskSlots(state);
    renderTaskHolds(state);
    renderTaskPill(state);
    const issues = state.issues || [];
    const groups = taskGroups(state);
    for (const c of TASK_COLUMNS) {
      if (c.key === 'done') continue;
      const views = groups[c.key].map((r, i) => taskView(r, c.key, i + 1, state));
      taskFill(c.key, views.length, JSON.stringify(views.map(taskViewFp)), () => views.map(taskCard));
    }
    const ids = new Set([...issues, ...(state.blocked || [])].map((r) => r.issue_identifier));
    const left = [...taskIds].some((id) => !ids.has(id));
    taskIds = ids;
    renderDone(state);
    if (left) taskLoadDone();
  }

  /** A finished issue as a card: cost, duration and review rounds are summed over its runs in the history. */
  function taskDoneView(entry, state) {
    const id = String(entry.issue || '');
    let cost = 0;
    let seconds = 0;
    for (const e of taskDone.entries) {
      if (e.issue !== id) continue;
      cost += Number(e.cost_usd) || 0;
      seconds += Number(e.agent_seconds) || 0;
    }
    const rounds = taskDone.rounds.get(id) || 0;
    const terminal = ((state.health && state.health.terminal_states) || []).includes(entry.state);
    const today = new Date(entry.ts).toDateString() === new Date().toDateString();
    const when = today ? taskHm(entry.ts) : fmtTime(entry.ts);
    const role = entry.role || null;
    return { id, num: taskNumber(id), right: terminal ? 'gemerged ' + when : when, title: entry.title || id, repo: entry.repo || id.split('#')[0], tone: 'done',
      reason: rounds + (rounds === 1 ? ' Review-Runde' : ' Review-Runden') + ' · ' + fmtUsd(cost) + ' · ' + fmtDuration(seconds),
      owner: role ? { label: UI_ROLE_NAMES[role] || role, color: UI_ROLE_COLORS[role] || UI_ROLE_COLORS.symphony } : TASK_SYMPHONY, verb: null };
  }

  function renderDone(state) {
    let views = [];
    let empty = null;
    if (taskDone === null) empty = 'Lade …';
    else if (taskDone.error) empty = taskDone.error === 'history_disabled' ? 'History ist nicht aktiviert' : 'History nicht erreichbar';
    else {
      const active = new Set([...(state.issues || []), ...(state.blocked || [])].map((r) => r.issue_identifier));
      const seen = new Set();
      const rows = taskDone.entries.slice().sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
      for (const e of rows) {
        if (!e.issue || seen.has(e.issue)) continue;
        seen.add(e.issue);
        if (active.has(e.issue)) continue;
        views.push(taskDoneView(e, state));
        if (views.length >= TASK_DONE_LIMIT) break;
      }
      if (!views.length) empty = 'Noch nichts erledigt';
    }
    const fp = JSON.stringify([empty, views]);
    taskById('col-done-count').textContent = pad2(views.length);
    if (taskFps.get('done') === fp) return;
    taskFps.set('done', fp);
    taskById('col-done').replaceChildren(...(empty ? [el('p', empty, 'task-empty')] : views.map(taskCard)));
  }

  async function taskHistory(event) {
    const res = await fetch('/api/v1/history/entries?event=' + event + '&limit=200', { cache: 'no-store' });
    if (!res.ok) {
      let code = 'history_error';
      try { const b = await res.json(); if (b && b.error && b.error.code) code = b.error.code; } catch {}
      throw new Error(code);
    }
    const body = await res.json();
    return (body && body.entries) || [];
  }

  async function taskLoadDone() {
    try {
      const [finished, results] = await Promise.all([taskHistory('run_finished'), taskHistory('stage_result')]);
      const rounds = new Map();
      for (const r of results) if (r.issue && r.kind === 'review') rounds.set(r.issue, (rounds.get(r.issue) || 0) + 1);
      taskDone = { entries: finished, rounds, error: null };
    } catch (error) {
      taskDone = { entries: [], rounds: new Map(), error: String(error && error.message) };
    }
    if (taskLast) renderDone(taskLast);
  }

  function taskPaint() {
    if (taskLast) renderTasks(taskLast);
  }

  async function taskControl(identifier, verb) {
    const key = identifier + ' ' + verb;
    const spec = TASK_CONTROL[verb];
    const current = taskButtons.get(key);
    if (current && current.cls === 'is-busy') return;
    const counts = (taskLast && taskLast.counts) || {};
    const max = taskLast && taskLast.health ? taskLast.health.max_concurrent_agents : 0;
    if (verb === 'force' && max && (counts.running || 0) - (counts.forced || 0) >= max) {
      const question = 'Alle ' + max + ' Slots sind belegt. ' + taskNumber(identifier) + ' in einem zusätzlichen Slot starten?';
      if (!window.confirm(question)) return;
    }
    taskButtons.set(key, { cls: 'is-busy', label: spec[1] });
    taskPaint();
    let ok = false;
    let label = spec[0] + ' fehlgeschlagen';
    try {
      const res = await fetch('/api/v1/' + encodeURIComponent(identifier) + '/' + verb, { method: 'POST' });
      let body = null;
      try { body = await res.json(); } catch {}
      ok = res.ok;
      label = ok ? spec[2] : (body && body.error && body.error.message) || spec[0] + ' fehlgeschlagen (' + res.status + ')';
    } catch {}
    taskButtons.set(key, { cls: ok ? 'is-done' : 'is-failed', label });
    taskPaint();
    document.getElementById('announce').textContent = identifier + ': ' + label;
    setTimeout(taskLoad, 500);
    setTimeout(() => { taskButtons.delete(key); taskPaint(); }, ok ? 1800 : 5000);
  }

  async function taskLoad() {
    if (taskLoading) { taskAgain = true; return; }
    taskLoading = true;
    try {
      const progress = document.getElementById('progress');
      if (progress) {
        progress.classList.remove('tick');
        void progress.offsetWidth;
        progress.classList.add('tick');
      }
      const res = await fetch('/api/v1/state', { cache: 'no-store' });
      if (!res.ok) throw new Error('state ' + res.status);
      renderTasks(await res.json());
    } catch {
      const error = taskById('tasks-error');
      error.textContent = 'Orchestrator nicht erreichbar';
      error.hidden = false;
    } finally {
      taskLoading = false;
      if (taskAgain) { taskAgain = false; taskLoad(); }
    }
  }

  if (window.__SYMPHONY_TEST__) window.__render = renderTasks;
  taskLoad();
  taskLoadDone();
  live(taskLoad, pollEvery(taskLoad, 2000));
  setInterval(taskLoadDone, 30000);
`;

const PILL_HTML = `<div class="g task-pill" id="task-pill" role="group" aria-label="Agent-Slots">
      <span class="task-pill-label">Agent-Slots</span>
      <span class="task-pill-step" id="task-slot-dec"></span>
      <span class="task-slot-count mono" id="task-slot-count" aria-live="polite">– / –</span>
      <span class="task-pill-step" id="task-slot-inc"></span>
      <span class="task-pill-chips" id="task-pill-chips"></span>
    </div>`;

const column = (c: TaskColumn): string => `
    <section class="g task-col" aria-label="${escapeHtml(c.title)}" style="--col: ${c.color}">
      <div class="task-col-head"><span class="task-col-name"><span class="task-col-dot" aria-hidden="true"></span><h2 id="col-${c.key}-title">${escapeHtml(c.title)}</h2></span><span class="task-count" id="col-${c.key}-count">00</span></div>
      <div class="task-list" id="col-${c.key}"><p class="task-empty">${escapeHtml(c.empty)}</p></div>
    </section>`;

export const TASKS_HTML = page({
  title: 'Tasks · Symphony',
  nav: 'tasks',
  aurora: AURORA.tasks,
  styles: TASKS_CSS,
  body: `
  <div class="tasks-page">
    ${pageHeader({ title: 'Tasks', subtitle: 'Was läuft, was als Nächstes startet und warum ein Issue wartet', right: PILL_HTML })}
    <p class="task-off" id="tasks-error" role="status" hidden></p>
    <p class="task-off" id="tasks-controls-off" hidden>${escapeHtml(CONTROLS_OFF)}</p>
    <p class="task-slot-notes" id="task-slot-notes" hidden></p>
    <details class="g task-more" id="task-more" hidden>
      <summary>Spalten-Limits, Reservierungen und Modelle</summary>
      <div class="task-more-body">
        <div class="task-slots" id="task-slots" role="group" aria-label="Weitere Slot-Grenzen" hidden></div>
        <div id="task-holds" hidden>
          <p class="task-holds-title" id="task-holds-title">Modelle</p>
          <ul class="task-hold-list" id="task-hold-list" aria-labelledby="task-holds-title"></ul>
        </div>
      </div>
    </details>
    <div class="tasks-grid">${TASK_COLUMNS.map(column).join('')}
    </div>
  </div>`,
  scripts: TASKS_JS,
});
