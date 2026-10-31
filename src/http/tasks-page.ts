import type { PlanReasonCode } from '../orchestrator/dispatch-plan.ts';
import { AURORA, escapeHtml, page } from './ui/layout.ts';

/**
 * Tasks page: the dispatcher queue in six columns (Läuft, Als Nächstes, Wartet, Pausiert, Blockiert, Kürzlich
 * erledigt) with cards, reason chips and the control actions of the existing routes. Like overview-teams.ts the CSS
 * and the script are inlined (TASKS_CSS/TASKS_JS); all top-level script names start with `task`/`TASK_` so they
 * cannot collide with BASE_JS or the components. The head also holds the controls moved from the overview: agent slots
 * (PUT/DELETE /api/v1/settings/agents) and the model list with pause/resume (POST /api/v1/models/<m>/hold|release). The columns are pre-rendered, so empty ones show their text at once.
 */

export interface TaskColumn {
  key: 'running' | 'next' | 'waiting' | 'paused' | 'blocked' | 'done';
  title: string;
  empty: string;
  tone: 'run' | 'next' | 'wait' | 'pause' | 'block' | 'done';
}

export const TASK_COLUMNS: ReadonlyArray<TaskColumn> = [
  { key: 'running', title: 'Läuft', empty: 'Nichts läuft', tone: 'run' },
  { key: 'next', title: 'Als Nächstes', empty: 'Nichts steht an', tone: 'next' },
  { key: 'waiting', title: 'Wartet', empty: 'Nichts wartet', tone: 'wait' },
  { key: 'paused', title: 'Pausiert', empty: 'Nichts pausiert', tone: 'pause' },
  { key: 'blocked', title: 'Blockiert', empty: 'Nichts blockiert', tone: 'block' },
  { key: 'done', title: 'Kürzlich erledigt', empty: 'Noch nichts erledigt', tone: 'done' },
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

const REASON_TONES: Record<PlanReasonCode | 'column', string> = {
  ready: 'green',
  no_free_slot: 'sky',
  column_limit: 'amber',
  reserved_for_role: 'sky',
  backoff: 'amber',
  session_limit: 'amber',
  model_hold: 'amber',
  waiting_for_sub_issues: 'gray',
  inactive: 'gray',
  paused: 'gray',
  blocked: 'red',
  missing_label: 'red',
  column: 'red',
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

const CONTROLS_OFF = 'Steuerung deaktiviert: SYMPHONY_ALLOW_REMOTE_CONTROL=true hinter einem authentifizierenden Proxy setzen';

export const TASKS_CSS = `
  .tasks-head { margin-bottom: 16px; }
  .tasks-meta { margin: 4px 0 0; color: var(--fg-3, var(--muted)); font-size: 13px; }
  .task-off { margin: 0 0 14px; color: var(--fg-3, var(--muted)); font-size: 13px; }
  .tasks-steer { display: grid; gap: 12px; margin: 0 0 16px; }
  .task-slots, .task-hold-list { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; margin: 0; padding: 0;
    list-style: none; font: 12px var(--mono); color: var(--fg-3, var(--muted)); }
  .task-slot-item, .task-hold { display: inline-flex; align-items: center; gap: 6px; }
  .task-slot-item b, .task-hold b { color: var(--fg-strong, inherit); font-weight: 600; }
  .task-slot-item b { min-width: 2ch; text-align: center; }
  .task-slot-step:disabled, .task-slot-reset:disabled { opacity: .4; cursor: default; }
  .task-slot-override, .task-slot-note { color: var(--amber); }
  .task-slot-error { color: var(--red); }
  .task-slot-bar { display: flex; gap: 3px; }
  .task-slot-bar i { width: 14px; height: 6px; border-radius: 2px; background: rgba(255, 255, 255, .12); }
  .task-slot-bar i.on { background: var(--green); box-shadow: 0 0 8px -2px var(--green); }
  .task-slot-bar i.reserved { background: transparent; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .35); }
  .task-slot-bar i.forced { background: var(--amber); box-shadow: 0 0 8px -2px var(--amber); }
  .task-holds-title { margin: 0 0 6px; font: 600 13px var(--sans); }
  .task-hold-reason { color: var(--amber); }
  .tasks-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; align-items: start; }
  .task-col { min-width: 0; padding: 12px; border-radius: 16px; border: 1px solid rgba(255, 255, 255, .08);
    background: rgba(255, 255, 255, .03); display: grid; gap: 10px; }
  .task-col-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px;
    border-radius: 10px; }
  .task-col-head h2 { margin: 0; font: 600 13px var(--sans); }
  .task-count { font: 600 12px var(--mono); font-variant-numeric: tabular-nums; }
  .task-tone-run { color: var(--task-run); background: var(--task-run-bg); }
  .task-tone-next { color: var(--task-next); background: var(--task-next-bg); }
  .task-tone-wait { color: var(--task-wait); background: var(--task-wait-bg); }
  .task-tone-pause { color: var(--task-pause); background: var(--task-pause-bg); }
  .task-tone-block { color: var(--task-block); background: var(--task-block-bg); }
  .task-tone-done { color: var(--task-done); background: var(--task-done-bg); }
  .task-list { display: grid; gap: 8px; min-width: 0; }
  .task-card { min-width: 0; display: grid; gap: 6px; padding: 10px 12px; border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, .08); background: rgba(255, 255, 255, .04); }
  .task-num { font: 600 11px var(--mono); color: var(--fg-3, var(--muted)); }
  .task-title { font-weight: 600; overflow-wrap: anywhere; color: var(--fg-strong, inherit); }
  .task-meta, .task-note { font-size: 12px; color: var(--fg-3, var(--muted)); overflow-wrap: anywhere; }
  .task-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .task-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .task-actions .ui-btn.is-busy { opacity: .6; }
  .task-actions .ui-btn.is-failed { color: var(--red); }
  .task-empty { margin: 0; padding: 4px 2px; color: var(--fg-3, var(--muted)); font-size: 13px; }
  @media (max-width: 1280px) { .tasks-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  @media (max-width: 900px) { .tasks-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 640px) { .tasks-grid { grid-template-columns: minmax(0, 1fr); } }
`;

export const TASKS_JS = `
  const TASK_COLUMNS = ${JSON.stringify(TASK_COLUMNS)};
  const TASK_REASONS = ${JSON.stringify(REASON_LABELS)};
  const TASK_REASON_TONES = ${JSON.stringify(REASON_TONES)};
  const TASK_OUTCOMES = ${JSON.stringify(OUTCOME_LABELS)};
  const TASK_UNFORCEABLE = new Set(['model_hold', 'waiting_for_sub_issues']);
  // Route, label, busy label and success label of each control verb.
  const TASK_CONTROL = {
    pause: ['Pausieren', 'Pausiere…', 'Pausiert'],
    force: ['Jetzt starten', 'Starte…', 'Gestartet'],
    retry: ['Erneut versuchen', 'Starte neu…', 'Eingereiht'],
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

  function taskReasonChip(code, text) {
    const label = TASK_REASONS[code] || text || code;
    return chip(label, { tone: TASK_REASON_TONES[code] || 'gray' });
  }

  function taskRetryFor(row, state) {
    return (state.retrying || []).find((r) => r.issue_id === row.issue_id) || null;
  }

  /** The control verb of a card, or null (no button at all without permission). */
  function taskActionFor(row, col, state) {
    if (!taskAllowed) return null;
    const code = (row.reason && typeof row.reason === 'object' ? row.reason.code : row.reason_code);
    if (col === 'running') return row.running && row.running.stopping ? null : 'pause';
    if (col === 'next') return row.model_hold || TASK_UNFORCEABLE.has(code) ? null : 'force';
    if (col === 'waiting') return row.retry ? 'retry' : null;
    if (col === 'blocked') return taskRetryFor(row, state) ? 'retry' : null;
    if (col === 'paused') return 'resume';
    return null;
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

  function taskCard(row, col, state) {
    const id = String(row.issue_identifier || '');
    const card = el('article', null, 'task-card');
    const num = el('span', taskNumber(id), 'task-num');
    num.setAttribute('title', id);
    const a = el('a', row.title || id, 'task-title');
    a.setAttribute('href', '/issue?id=' + encodeURIComponent(id));
    const meta = [row.repo || id.split('#')[0]];
    if (col === 'next') meta.push('Platz ' + row.position);
    else if (row.priority !== null && row.priority !== undefined) meta.push('P' + row.priority);
    card.append(num, a, el('span', meta.join(' · '), 'task-meta'));
    const chips = el('div', null, 'task-chips');
    const code = (row.reason && typeof row.reason === 'object' ? row.reason.code : row.reason_code);
    if (code) {
      const c = taskReasonChip(code, row.reason && typeof row.reason === 'object' ? row.reason.text : row.reason);
      c.setAttribute('title', code);
      chips.append(c);
    }
    const role = taskRole(row, state);
    if (role) {
      const r = chip(UI_ROLE_NAMES[role] || role, { tone: UI_ROLE_COLORS[role] || UI_ROLE_COLORS.symphony, dot: true });
      r.classList.add('task-role');
      chips.append(r);
    }
    if (chips.childNodes.length) card.append(chips);
    const retry = row.retry || (col === 'blocked' ? taskRetryFor(row, state) : null);
    if (retry && retry.attempt !== undefined && retry.attempt !== null) {
      const due = typeof retry.due_in_ms === 'number' ? ' · in ' + fmtDuration(retry.due_in_ms / 1000) : '';
      card.append(el('span', 'Versuch ' + retry.attempt + due, 'task-note'));
    }
    const verb = taskActionFor(row, col, state);
    if (verb) {
      const box = el('div', null, 'task-actions');
      box.append(taskButton(id, verb));
      card.append(box);
    }
    return card;
  }

  function taskFill(key, count, fp, build) {
    const col = TASK_COLUMNS.find((c) => c.key === key);
    taskById('col-' + key + '-count').textContent = pad2(count);
    if (taskFps.get(key) === fp) return;
    taskFps.set(key, fp);
    taskById('col-' + key).replaceChildren(...(count ? build() : [el('p', col.empty, 'task-empty')]));
  }

  function taskRetryFp(r) {
    return r ? [r.attempt, r.due_at, r.kind] : null;
  }

  function taskRowFp(row, col, state) {
    return [row.issue_id, row.issue_identifier, row.title, row.repo, row.state, row.position, row.priority,
      row.reason, row.reason_code, taskRetryFp(row.retry), row.model_hold, taskRole(row, state), taskActionFor(row, col, state),
      row.running ? [row.running.role, row.running.stopping] : null,
      taskActionFor(row, col, state) ? taskButtons.get(row.issue_identifier + ' ' + taskActionFor(row, col, state)) || null : null,
      col === 'blocked' ? taskRetryFp(taskRetryFor(row, state)) : null];
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

  /** Occupancy bar and its text: "02 / 10 belegt, 1 erzwungen · developer 1/1 reserviert · 3 frei". */
  function taskSlotBar(state) {
    const limits = state.limits;
    const max = state.health ? state.health.max_concurrent_agents : 0;
    const counts = state.counts || {};
    const forced = counts.forced || 0;
    const slotted = (counts.running || 0) - forced;
    const reservations = limits && !limits.reservation_problem
      ? Object.entries(limits.reserved_slots_by_role || {}).filter(([, r]) => r.effective > 0)
      : [];
    let unused = 0;
    for (const [, r] of reservations) unused += Math.max(r.effective - r.running, 0);
    const free = Math.max(max - slotted - unused, 0);
    const bar = el('span', null, 'task-slot-bar');
    bar.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < Math.min(max, 24); i++) bar.append(el('i', null, i < slotted ? 'on' : i < slotted + unused ? 'reserved' : ''));
    for (let i = 0; i < Math.min(forced, 8); i++) bar.append(el('i', null, 'forced'));
    const used = pad2(counts.running || 0) + ' / ' + pad2(max) + ' belegt' + (forced > 0 ? ', ' + forced + ' erzwungen' : '');
    const text = used + ' · ' + (reservations.length > 0
      ? reservations.map(([role, r]) => role + ' ' + Math.min(r.running, r.effective) + '/' + r.effective).join(' · ') + ' reserviert · '
      : '') + free + ' frei';
    const wrap = el('span', null, 'task-slot-item');
    wrap.append(bar, el('span', text));
    return wrap;
  }

  function renderTaskSlots(state) {
    const limits = state.limits;
    const host = taskById('task-slots');
    host.hidden = !limits;
    if (!limits) return;
    const total = limits.max_concurrent_agents;
    // Forced sessions run beside the limit; only the others hold its slots.
    const running = (state.counts.running || 0) - (state.counts.forced || 0);
    const nodes = [taskSlotBar(state)];
    const item = el('span', null, 'task-slot-item');
    item.append(el('span', 'Slots gesamt'));
    if (taskAllowed) item.append(taskSlotStep('−', 'Weniger Agent-Slots', { max_concurrent_agents: Math.min(total.effective - 1, limits.max) }, total.effective <= 0));
    item.append(el('b', total.effective));
    if (taskAllowed) item.append(taskSlotStep('+', 'Mehr Agent-Slots', { max_concurrent_agents: total.effective + 1 }, total.effective >= limits.max));
    if (total.override !== null && total.override !== total.workflow) item.append(el('span', 'hier gesetzt · WORKFLOW.md ' + total.workflow, 'task-slot-override'));
    else if (total.override !== null) item.append(el('span', 'hier gesetzt', 'task-slot-override'));
    nodes.push(item);
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
      nodes.push(el('span', 'Alle Slots reserviert: ' + unreserved.join(', ') + ' starten nur mit mehr Slots', 'task-slot-note'));
    }
    if (total.effective === 0) {
      nodes.push(el('span', 'Limit 0: neue Starts pausiert' + (running > 0 ? ', ' + running + ' laufen weiter' : ''), 'task-slot-note'));
    } else if (running > total.effective) {
      const finish = running - total.effective + 1;
      nodes.push(el('span', running + ' laufen, Limit ' + total.effective + ': keine neuen Starts, bis ' + (finish === 1 ? 'einer fertig ist' : finish + ' fertig sind'), 'task-slot-note'));
    }
    if (taskSlotError) nodes.push(el('span', taskSlotError, 'task-slot-error'));
    patchChildren(host, nodes);
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
    renderTaskSlots(state);
    renderTaskHolds(state);
    const issues = state.issues || [];
    const groups = { running: [], next: [], waiting: [], paused: [], blocked: state.blocked || [] };
    for (const r of issues) if (groups[r.section]) groups[r.section].push(r);
    groups.next.sort((a, b) => (a.position || 0) - (b.position || 0));
    for (const c of TASK_COLUMNS) {
      if (c.key === 'done') continue;
      const rows = groups[c.key];
      const fp = JSON.stringify([taskAllowed, rows.map((r) => taskRowFp(r, c.key, state))]);
      taskFill(c.key, rows.length, fp, () => rows.map((r) => taskCard(r, c.key, state)));
    }
    const ids = new Set([...issues, ...(state.blocked || [])].map((r) => r.issue_identifier));
    const left = [...taskIds].some((id) => !ids.has(id));
    taskIds = ids;
    const total = issues.length + (state.blocked || []).length;
    taskById('tasks-meta').textContent = total + (total === 1 ? ' Issue im Dispatcher' : ' Issues im Dispatcher');
    renderDone(state);
    if (left) taskLoadDone();
  }

  function taskDoneCard(entry, verdict, state) {
    const card = el('article', null, 'task-card');
    const id = String(entry.issue || '');
    const num = el('span', taskNumber(id), 'task-num');
    num.setAttribute('title', id);
    const a = el('a', entry.title || id, 'task-title');
    a.setAttribute('href', '/issue?id=' + encodeURIComponent(id));
    const today = new Date(entry.ts).toDateString() === new Date().toDateString();
    const time = el('span', today ? fmtClock(entry.ts) : fmtTime(entry.ts), 'task-meta');
    time.setAttribute('title', fmtTime(entry.ts));
    card.append(num, a, el('span', entry.repo || id.split('#')[0], 'task-meta'), time);
    const chips = el('div', null, 'task-chips');
    chips.append(chip(verdict || TASK_OUTCOMES[entry.outcome] || entry.outcome || '—', { tone: verdict ? 'violet' : 'gray' }));
    if (entry.state) {
      const terminal = ((state.health && state.health.terminal_states) || []).includes(entry.state);
      chips.append(chip('→ ' + entry.state, { tone: terminal ? 'green' : 'violet' }));
    }
    card.append(chips);
    return card;
  }

  function renderDone(state) {
    let nodes = [];
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
        nodes.push(taskDoneCard(e, taskDone.verdicts.get(e.run) || null, state));
        if (nodes.length >= TASK_DONE_LIMIT) break;
      }
      if (!nodes.length) empty = 'Noch nichts erledigt';
    }
    const fp = JSON.stringify([empty, nodes.map((n) => n.textContent)]);
    const col = taskById('col-done');
    taskById('col-done-count').textContent = pad2(nodes.length);
    if (taskFps.get('done') === fp) return;
    taskFps.set('done', fp);
    col.replaceChildren(...(empty ? [el('p', empty, 'task-empty')] : nodes));
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
      const verdicts = new Map();
      for (const r of results) if (r.run && r.verdict) verdicts.set(r.run, r.verdict);
      taskDone = { entries: finished, verdicts, error: null };
    } catch (error) {
      taskDone = { entries: [], verdicts: new Map(), error: String(error && error.message) };
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
      taskById('tasks-meta').textContent = 'Orchestrator nicht erreichbar';
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

const column = (c: TaskColumn): string => `
    <section class="task-col" aria-labelledby="col-${c.key}-title">
      <div class="task-col-head task-tone-${c.tone}"><h2 id="col-${c.key}-title">${escapeHtml(c.title)}</h2><span class="task-count" id="col-${c.key}-count">00</span></div>
      <div class="task-list" id="col-${c.key}"><p class="task-empty">${escapeHtml(c.empty)}</p></div>
    </section>`;

export const TASKS_HTML = page({
  title: 'Tasks · Symphony',
  nav: 'tasks',
  aurora: AURORA.tasks,
  styles: TASKS_CSS,
  body: `
  <section aria-labelledby="page-title">
    <div class="tasks-head">
      <h1 id="page-title">Tasks</h1>
      <p class="tasks-meta" id="tasks-meta"></p>
    </div>
    <p class="task-off" id="tasks-controls-off" hidden>${escapeHtml(CONTROLS_OFF)}</p>
    <section class="tasks-steer" aria-label="Steuerung">
      <div class="task-slots" id="task-slots" role="group" aria-label="Agent-Slots" hidden></div>
      <div id="task-holds" hidden>
        <p class="task-holds-title" id="task-holds-title">Modelle</p>
        <ul class="task-hold-list" id="task-hold-list" aria-labelledby="task-holds-title"></ul>
      </div>
    </section>
    <div class="tasks-grid">${TASK_COLUMNS.map(column).join('')}
    </div>
  </section>`,
  scripts: TASKS_JS,
});
