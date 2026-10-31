/**
 * Title block of the overview: subtitle with teams, free-slot queue and last poll, and the status chips (tracker,
 * workflow, write clashes). Like overview-teams.ts it is inlined into the page (HEAD_CSS/HEAD_JS after BASE_JS and
 * ALERTS_JS) and unit-testable in a vm; all top-level names start with `head`/`HEAD_`.
 */
export const HEAD_CSS = `
  .ov-head { align-items: flex-end; }
  .ov-title { display: grid; gap: 6px; min-width: 0; }
  .ov-title h1 { margin: 0; }
  .ov-title .subtitle { margin: 0; font-size: 13px; color: var(--fg-2, var(--text-2)); }
  #ov-subtitle.is-stale { color: var(--amber); }
  .ov-side { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
  .ov-chips { display: flex; flex-wrap: wrap; gap: 8px; }
`;

export const HEAD_JS = `
  // Teams playing (running issues) and issues waiting for a free slot (queue status "next").
  function headCounts(state) {
    state = state || {};
    return {
      playing: (state.issues || []).filter((r) => r.running).length,
      waiting: (state.queue || []).filter((q) => q.status === 'next').length,
    };
  }

  function headSubtitle(state, now) {
    const n = headCounts(state);
    const tick = state && state.health && state.health.last_tick_at ? Date.parse(state.health.last_tick_at) : NaN;
    return [
      n.playing === 1 ? '1 Team spielt' : n.playing + ' Teams spielen',
      n.waiting === 1 ? '1 wartet auf einen Slot' : n.waiting + ' warten auf einen Slot',
      Number.isNaN(tick) ? 'noch kein Poll' : 'letzter Poll vor ' + Math.max(0, Math.round((now - tick) / 1000)) + ' s',
    ].join(' · ');
  }

  function headChips(state) {
    const h = (state && state.health) || {};
    const out = [];
    const tracker = h.last_tracker_error ? chip('Tracker Fehler', { tone: 'red', dot: true }) : chip('Tracker ok', { tone: 'green', dot: true });
    tracker.title = h.last_tracker_error ? String(h.last_tracker_error.message || '') : '';
    const workflow = h.workflow_error ? chip('Workflow ungültig', { tone: 'red', dot: true }) : chip('Workflow gültig', { tone: 'green', dot: true });
    workflow.title = h.workflow_error ? String(h.workflow_error.message || '') : h.workflow_version === undefined ? '' : 'v' + h.workflow_version;
    out.push(tracker, workflow);
    const clashes = alertClashes(state).length;
    if (clashes > 0) out.push(chip(clashes + (clashes === 1 ? ' Write-Clash' : ' Write-Clashes'), { tone: 'amber', dot: true }));
    return out;
  }

  // Fills #ov-subtitle and #ov-chips; offline shows a notice and no chips. A poll older than three intervals is stale.
  function renderHead(state, now, online) {
    const sub = document.getElementById('ov-subtitle');
    const chips = document.getElementById('ov-chips');
    const text = (t) => { if (sub.textContent !== t) sub.textContent = t; };
    if (!online || !state) {
      text('Orchestrator nicht erreichbar');
      sub.classList.remove('is-stale');
      chips.replaceChildren();
      return;
    }
    text(headSubtitle(state, now));
    const h = state.health || {};
    const tick = h.last_tick_at ? Date.parse(h.last_tick_at) : NaN;
    sub.classList.toggle('is-stale', !Number.isNaN(tick) && now - tick > Math.max(3 * (h.poll_interval_ms || 0), 30000));
    patchChildren(chips, headChips(state));
  }
`;
