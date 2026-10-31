import { SCALES, rgba } from './ui/palette.ts';

/**
 * Alerts panel ("Alerts") of the overview: one list for everything that needs a look. alerts(state, budget) is a
 * pure function over the /api/v1/state snapshot and the /api/v1/budget report; renderAlerts() builds the panel from
 * its result. Both run in the page script after BASE_JS (they use el(), pad2(), uiOwn() and UI_ROLE_NAMES).
 *
 * Kinds: clash (state.brain_clashes, optional, open ones only), attention, needs_human, model_hold, budget. Each card is
 * a link; red cards (clash, attention) and amber cards (the rest) differ in border and label colour.
 *
 * Time of an entry: attention problems use their own timestamp, else health.last_tick_at; needs-human uses the
 * issue's updated_at, else state.board_fetched_at; model holds use `since`; budget alerts use the report's
 * generated_at. Entries without a time come last.
 */
export const ALERTS_CSS = `
  #alerts { flex: 1 1 340px; min-width: 0; margin: 0; }
  #alerts .section-head { align-items: center; }
  #alerts .section-head h2 { display: flex; align-items: center; gap: 10px; }
  .alerts-badge { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: ${rgba(SCALES.red[400], 0.2)};
    color: ${SCALES.red[200]}; font: 500 12px var(--mono); }
  .alerts-badge[hidden] { display: none; }
  .alerts-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  .alert { display: grid; gap: 4px; padding: 12px 14px; color: inherit; text-decoration: none; border: 1px solid ${rgba(SCALES.amber[400], 0.35)}; }
  .alert:hover { background: rgba(255, 255, 255, .06); text-decoration: none; }
  .alert:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .alert-red { border-color: ${rgba(SCALES.red[400], 0.4)}; }
  .alert-red .alert-kind { color: ${SCALES.red[300]}; }
  .alert-amber { border-color: ${rgba(SCALES.amber[400], 0.35)}; }
  .alert-amber .alert-kind { color: ${SCALES.amber[300]}; }
  .alert-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .alert-time { font: 12px var(--mono); color: var(--fg-3, var(--muted)); white-space: nowrap; }
  .alert-title { font-weight: 500; color: var(--fg, var(--text)); overflow-wrap: anywhere; }
  .alert-text { font-size: 13px; color: var(--fg-2, var(--text-2)); overflow-wrap: anywhere; }
  .alerts-empty { display: flex; gap: 8px; align-items: center; padding: 12px 14px; font-size: 13px; color: var(--fg-2, var(--text-2)); }
`;

export const ALERTS_JS = `
  const ALERT_KIND = { clash: 'Write-Clash', budget: 'Limit-Prognose', needs_human: 'needs-human', model_hold: 'Model-Hold', attention: 'Fehler' };
  const ALERT_TONE = { clash: 'red', attention: 'red', budget: 'amber', needs_human: 'amber', model_hold: 'amber' };
  const BUDGET_TITLE = { five_hour: '5-h-Limit in Sicht', seven_day: '7-Tage-Limit in Sicht' };

  // HH:MM in local time.
  function alertClock(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '--:--' : pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

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

  // Open write clashes of the Brain (state.brain_clashes, optional: absent means none).
  function alertClashes(state) {
    const list = state && Array.isArray(state.brain_clashes) ? state.brain_clashes : [];
    return list.filter((c) => c && c.status === 'open');
  }
  function alertWho(clash, i) {
    const role = clash.roles && clash.roles[i];
    const issue = clash.issues && clash.issues[i];
    const name = role ? uiOwn(UI_ROLE_NAMES, role) || String(role) : 'Agent';
    return issue ? name + ' (#' + String(issue).split('#').pop() + ')' : name;
  }
  function alertClashText(clash) {
    const at = (clash.at || []).map((t) => Date.parse(t));
    const min = at.length === 2 && at.every((t) => !Number.isNaN(t)) ? Math.max(0, Math.round((at[1] - at[0]) / 60000)) : 0;
    return alertWho(clash, 1) + ' wollte ' + min + ' min nach ' + alertWho(clash, 0) + ' schreiben – abgewiesen, Hash passt nicht. Beide Fassungen prüfen.';
  }

  function alerts(state, budget) {
    state = state || {};
    const h = state.health || {};
    const out = [];
    const tick = h.last_tick_at || null;
    for (const c of alertClashes(state)) out.push({ kind: 'clash', at: (c.at && c.at[1]) || null, title: c.path, text: alertClashText(c), href: '/brain' });
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
        title: row.issue_identifier + (row.title ? ' · ' + row.title : ''),
        text: row.review_rounds > 0 ? 'Nach ' + row.review_rounds + (row.review_rounds === 1 ? ' Review-Runde' : ' Review-Runden') + ' an dich übergeben.' : 'An dich übergeben.',
        href: '/issue?id=' + encodeURIComponent(row.issue_identifier),
      });
    }

    for (const hold of state.model_holds || []) {
      const operator = hold.source === 'operator';
      out.push({
        kind: 'model_hold',
        at: hold.since || null,
        title: 'Modell ' + hold.model,
        text: hold.model + ' pausiert · ' + (operator ? 'vom Operator angehalten' : 'Limit bis ' + alertClock(hold.until)),
        href: hold.issue_identifier ? '/issue?id=' + encodeURIComponent(hold.issue_identifier) : '/stats',
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
          text: 'Beim aktuellen Verbrauch ist das Limit gegen ' + alertClock(w.forecast.eta) + ' erreicht' + (w.resets_at ? ', Reset um ' + alertClock(w.resets_at) + '.' : '.'),
          href: '/stats',
        });
      }
    }

    // Newest first; entries without a valid time last; Array.sort is stable.
    const time = (a) => { const t = Date.parse(a.at); return Number.isNaN(t) ? -Infinity : t; };
    return out.sort((a, b) => (time(a) === time(b) ? 0 : time(a) < time(b) ? 1 : -1));
  }

  function alertItem(a) {
    const li = el('li');
    const card = el('a', null, 'gi alert alert-' + ALERT_TONE[a.kind] + ' kind-' + a.kind);
    card.href = a.href;
    const head = el('div', null, 'alert-head');
    head.append(el('span', ALERT_KIND[a.kind], 'lbl alert-kind'), el('span', agoDe(a.at), 'alert-time mono'));
    card.append(head, el('div', a.title, 'alert-title'), el('div', a.text, 'alert-text'));
    li.append(card);
    return li;
  }

  // The badge shows the number of cards and is hidden at 0; the empty state is one calm card.
  function renderAlerts(list, host, badge) {
    const n = list.length;
    if (badge.textContent !== String(n)) badge.textContent = String(n);
    badge.hidden = n === 0;
    badge.setAttribute('aria-label', n + ' Alerts');
    if (!n) {
      const empty = el('li');
      const card = el('div', null, 'gi alerts-empty');
      card.append(el('span', null, 'dot tone-green'), el('span', 'Alles ruhig'));
      empty.append(card);
      patchChildren(host, [empty]);
      return;
    }
    patchChildren(host, list.map(alertItem));
  }
`;
