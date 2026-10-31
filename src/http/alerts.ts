/**
 * Alerts panel ("Hinweise") of the overview: one list for everything that needs a look. alerts(state, budget) is a
 * pure function over the /api/v1/state snapshot and the /api/v1/budget report; renderAlerts() builds the panel from
 * its result. Both run in the page script after BASE_JS (they use el(), icon() and fmtClock()).
 *
 * Time of an entry: attention problems use their own timestamp, else health.last_tick_at; needs-human uses the
 * issue's updated_at, else state.board_fetched_at; model holds use `since`; budget alerts use the report's
 * generated_at. Entries without a time come last.
 */
export const ALERTS_CSS = `
  .alerts-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .alert { --alert-tone: var(--amber); display: grid; grid-template-columns: 16px auto minmax(0, 1fr); gap: 4px 10px; align-items: center; }
  .alert.kind-attention, .alert.kind-needs_human { --alert-tone: var(--red); }
  .alert > svg { color: var(--alert-tone); }
  .alert-time { font: 500 11px var(--mono); color: var(--muted); white-space: nowrap; }
  .alert-title { font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
  .alert-text { grid-column: 1 / -1; color: var(--text-2); overflow-wrap: anywhere; }
  .alerts-empty { display: flex; gap: 8px; align-items: center; color: var(--muted); }
`;

export const ALERTS_JS = `
  const ALERT_ICON = { attention: 'alert', needs_human: 'human', model_hold: 'pause', budget: 'clock' };
  const BUDGET_TITLE = { five_hour: '5-h-Limit in Sicht', seven_day: '7-Tage-Limit in Sicht' };

  // Relative German time: "gerade eben", "vor 5 min", "vor 2 h", "vor 3 d"; "—" without a valid time.
  function agoDe(iso, now) {
    const t = Date.parse(iso);
    if (!iso || Number.isNaN(t)) return '—';
    const s = ((now === undefined ? Date.now() : now) - t) / 1000;
    if (s < 60) return 'gerade eben';
    if (s < 3600) return 'vor ' + Math.floor(s / 60) + ' min';
    if (s < 86400) return 'vor ' + Math.floor(s / 3600) + ' h';
    return 'vor ' + Math.floor(s / 86400) + ' d';
  }

  function alerts(state, budget) {
    state = state || {};
    const h = state.health || {};
    const out = [];
    const tick = h.last_tick_at || null;
    const attention = (title, text, at) => out.push({ kind: 'attention', at: at || tick, title, text: String(text), href: '/stats' });
    if (h.workflow_error) attention('WORKFLOW.md', h.workflow_error.message);
    for (const e of h.dispatch_errors || []) if (!h.workflow_error || !e.startsWith('WORKFLOW.md')) attention('Dispatch', e);
    if (h.last_tracker_error) attention('Tracker', h.last_tracker_error.message, h.last_tracker_error.at);
    if (h.pricing_error) attention('model-costs.yml', h.pricing_error);
    const limits = state.limits || {};
    if (limits.reservation_problem) attention('Agent-Slots', limits.reservation_problem);
    for (const p of limits.slot_problems || []) attention('Agent-Slots', p);

    const seen = new Set();
    for (const row of [...(state.issues || []), ...(state.blocked || [])]) {
      const labels = (row.labels || []).map((l) => String(l).trim().toLowerCase());
      if (!labels.includes('needs-human') || seen.has(row.issue_identifier)) continue;
      seen.add(row.issue_identifier);
      out.push({
        kind: 'needs_human',
        at: row.updated_at || state.board_fetched_at || null,
        title: row.issue_identifier + ' braucht einen Menschen',
        text: row.title || '',
        href: '/issue?id=' + encodeURIComponent(row.issue_identifier),
      });
    }

    for (const hold of state.model_holds || []) {
      const operator = hold.source === 'operator';
      out.push({
        kind: 'model_hold',
        at: hold.since || null,
        title: operator ? 'Modell ' + hold.model + ' pausiert' : 'Modell ' + hold.model + ' im Limit bis ' + fmtClock(hold.until),
        text: operator ? 'vom Operator angehalten' : (hold.text || '') + (hold.issue_identifier ? ' · ausgelöst von ' + hold.issue_identifier : ''),
        href: '/tasks',
      });
    }

    if (budget) {
      for (const key of ['five_hour', 'seven_day']) {
        const w = budget[key];
        if (!w || w.alert !== true || !w.forecast || !w.forecast.eta) continue;
        out.push({
          kind: 'budget',
          at: budget.generated_at || null,
          title: BUDGET_TITLE[key],
          text: 'Prognose: Limit um ' + fmtClock(w.forecast.eta) + ' erreicht' + (w.resets_at ? ', Reset um ' + fmtClock(w.resets_at) : ''),
          href: '/stats',
        });
      }
    }

    // Newest first; entries without a valid time last; Array.sort is stable.
    const time = (a) => { const t = Date.parse(a.at); return Number.isNaN(t) ? -Infinity : t; };
    return out.sort((a, b) => (time(a) === time(b) ? 0 : time(a) < time(b) ? 1 : -1));
  }

  function alertItem(a) {
    const li = el('li', null, 'alert kind-' + a.kind);
    const ico = icon(ALERT_ICON[a.kind], 16);
    if (ico) li.append(ico);
    const title = el('a', a.title, 'alert-title');
    title.href = a.href;
    li.append(el('span', agoDe(a.at), 'alert-time'), title, el('span', a.text, 'alert-text'));
    return li;
  }

  function renderAlerts(list, host, countNode) {
    const n = String(list.length);
    if (countNode.textContent !== n) countNode.textContent = n;
    if (!list.length) {
      const empty = el('li', null, 'alerts-empty');
      empty.append(el('span', null, 'dot tone-green'), el('span', 'Alles ruhig'));
      patchChildren(host, [empty]);
      return;
    }
    patchChildren(host, list.map(alertItem));
  }
`;
