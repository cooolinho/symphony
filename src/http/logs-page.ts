import { CHART_CSS, CHART_JS } from './charts.ts';
import { AURORA, page, pageHeader } from './ui/layout.ts';

const LOGS_CSS = `
  .filterbar { display: grid; gap: 12px; padding: 16px 18px; }
  .filter-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
  .filters { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: flex-end; }
  .field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .field select { min-width: 150px; }
  .custom { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  input[type="date"], input[type="text"] { font: 500 12px var(--mono); color: var(--fg); background: var(--glass-in);
    border: 1px solid var(--glass-line); border-radius: var(--radius-sm); padding: 6px 10px; color-scheme: dark; min-width: 0; min-height: 44px; }
  .period { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; font: 12px var(--mono); color: var(--fg-2); }
  .period strong { color: var(--green); font-weight: 600; letter-spacing: .04em; }
  .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(520px, 100%), 1fr)); gap: 20px; }
  .grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 20px; }
  .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .kpi-grid.secondary { grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); margin-top: 10px; }
  .kpi-grid .ui-spark { margin-top: 4px; }
  .delta { font: 12px var(--mono); color: var(--fg-3); }
  .delta b { font-weight: 600; color: var(--fg-2); }
  .delta.up b { color: var(--cyan); }
  .delta.bad b { color: var(--amber); }
  .sub-h { font: 600 12px var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--fg-3); margin: 18px 0 10px; }
  .state { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; text-align: center; gap: 8px 12px; padding: 28px 12px;
    color: var(--fg-3); font-size: 12.5px; }
  main.busy [data-section] { opacity: .55; transition: opacity .2s var(--ease); }
  .outcomes { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 4px; }
  .outcomes li { display: flex; justify-content: space-between; gap: 12px; font: 12px var(--mono); }
  .outcomes li span:first-child { display: inline-flex; align-items: center; gap: 8px; color: var(--fg-2); }
  .outcomes li span:last-child { font-variant-numeric: tabular-nums; }
  .rank { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; counter-reset: rank; }
  .rank li { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; gap: 2px 8px; padding: 5px 6px; margin: 0 -6px;
    border-radius: var(--radius-sm); counter-increment: rank; cursor: pointer; }
  .rank li:hover, .rank li:focus-visible { background: var(--glass-in); }
  .rank li::before { content: counter(rank); font: 12px var(--mono); color: var(--fg-3); }
  .rank .who { font: 12px var(--mono); color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rank .val { font: 600 12px var(--mono); font-variant-numeric: tabular-nums; text-align: right; }
  .rank .meta { grid-column: 2 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; }
  .attention { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  .attention li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 2px 10px; padding: 8px 10px; cursor: pointer;
    border: 1px solid var(--tone-line); border-radius: var(--radius-sm); background: var(--tone-dim); }
  .attention .ico { color: var(--tone); font: 600 13px var(--mono); }
  .attention .who { font: 12px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .attention .val { font: 600 12px var(--mono); text-align: right; }
  .attention .why { grid-column: 2 / -1; color: var(--fg-2); font-size: 12px; }
  .int-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 4px 0 12px; }
  .int-head b { font: 600 14px var(--mono); color: var(--fg); }
  .int-block { padding: 14px; }
  .int-block + .int-block { margin-top: 12px; }
  .role-chips { display: flex; flex-wrap: wrap; gap: 4px; }
  td.event { white-space: nowrap; }
  tr.click { cursor: pointer; }
  .issue-cell .meta { max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-actions { display: flex; gap: 6px; }
  .more { margin-top: 10px; }
  .note { color: var(--fg-3); font-size: 12px; margin: 10px 0 0; }
  @media (max-width: 640px) {
    .field select { min-width: 0; width: 100%; }
    .filters > .field { flex: 1 1 140px; }
  }
`;

/**
 * Statistics page: analytics of the per-repository logs for one global filter (period, repository, model).
 * The server aggregates (/api/v1/history/analytics); the log table is loaded separately
 * (/api/v1/history/entries) so a failure there leaves the charts intact. The filter lives in the URL
 * (?period=30d&repo=owner/name&model=…&effort=…, custom: ?period=custom&from=YYYY-MM-DD&to=YYYY-MM-DD), so every view
 * can be linked.
 */
export const LOGS_HTML = page({
  title: 'Statistik · Symphony',
  nav: 'stats',
  aurora: AURORA.stats,
  styles: CHART_CSS + LOGS_CSS,
  body: `
  ${pageHeader({ title: 'Statistik', subtitle: 'Auswertung der Logs nach Zeitraum, Repository und Modell' })}
  <section class="filterbar g" aria-label="Filter">
    <form class="filters" id="filters">
      <label class="field"><span class="lbl">Zeitraum</span>
        <select id="period">
          <option value="today">Heute</option><option value="yesterday">Gestern</option>
          <option value="7d">Letzte 7 Tage</option><option value="14d">Letzte 14 Tage</option>
          <option value="30d">Letzte 30 Tage</option><option value="90d">Letzte 90 Tage</option>
          <option value="month">Dieser Monat</option><option value="last_month">Letzter Monat</option>
          <option value="all">Gesamter Zeitraum</option><option value="custom">Eigener Zeitraum…</option>
        </select>
      </label>
      <div class="field"><span class="lbl">Eigener Zeitraum</span>
        <div class="custom">
          <input type="date" id="from" aria-label="Von (inklusive)"> <span class="meta">→</span>
          <input type="date" id="to" aria-label="Bis (inklusive)">
          <button class="ui-btn ui-btn-approve" type="submit" id="apply">Anwenden</button>
        </div>
      </div>
      <label class="field"><span class="lbl">Repository</span><select id="repo"><option value="">Alle Repositories</option></select></label>
      <label class="field"><span class="lbl">Modell</span><select id="model"><option value="">Alle Modelle</option></select></label>
      <label class="field"><span class="lbl">Effort</span><select id="effort"><option value="">Alle Efforts</option></select></label>
    </form>
    <div class="filter-foot">
      <div class="period" id="period-label" aria-live="polite"></div>
      <div class="actions">
        <a class="ui-btn" id="raw" href="#" hidden>Rohlog</a>
        <button class="ui-btn" id="reload" type="button">Neu laden</button>
      </div>
    </div>
  </section>

  <section id="problems" class="problems" hidden><h2>Probleme</h2><ul id="problem-list"></ul></section>

  <section class="ui-card g" data-section aria-labelledby="h-kpi">
    <div class="ui-card-head"><h2 class="ui-card-title" id="h-kpi">Kennzahlen</h2></div>
    <div class="ui-card-body" data-body="kpi"></div>
  </section>

  <section class="ui-card g" data-section aria-labelledby="h-activity">
    <div class="ui-card-head"><h2 class="ui-card-title" id="h-activity">Aktivität</h2>
      <div class="ui-seg" id="activity-metric" role="group" aria-label="Kennzahl der Aktivität">
        <button type="button" class="ui-seg-btn" data-v="runs" aria-pressed="true">Runs</button><button type="button" class="ui-seg-btn" data-v="tokens" aria-pressed="false">Tokens</button>
        <button type="button" class="ui-seg-btn" data-v="cost" aria-pressed="false">Kosten</button><button type="button" class="ui-seg-btn" data-v="time" aria-pressed="false">Agentenzeit</button>
      </div>
    </div>
    <div class="ui-card-body" data-body="activity"></div>
  </section>

  <div class="grid-2">
    <section class="ui-card g" data-section aria-labelledby="h-cost">
      <div class="ui-card-head"><h2 class="ui-card-title" id="h-cost">Geschätzte Kosten</h2>
        <div class="ui-seg" id="cost-mode" role="group" aria-label="Ansicht der Kosten">
          <button type="button" class="ui-seg-btn" data-v="period" aria-pressed="true">Je Zeitraum</button><button type="button" class="ui-seg-btn" data-v="cumulative" aria-pressed="false">Kumuliert</button>
        </div>
      </div>
      <div class="ui-card-body" data-body="cost"></div>
    </section>
    <section class="ui-card g" data-section aria-labelledby="h-tokens">
      <div class="ui-card-head"><h2 class="ui-card-title" id="h-tokens">Tokens</h2></div>
      <div class="ui-card-body" data-body="tokens"></div>
    </section>
  </div>

  <section class="ui-card g" data-section aria-labelledby="h-models">
    <div class="ui-card-head"><h2 class="ui-card-title" id="h-models">Modelle</h2>
      <label class="field"><span class="lbl">Sortieren nach</span><select id="model-sort">
        <option value="cost_usd">Gesamtkosten</option><option value="runs">Runs</option><option value="total_tokens">Tokens</option>
        <option value="avg_cost_per_run">Ø Kosten/Run</option><option value="avg_tokens_per_run">Ø Tokens/Run</option>
        <option value="agent_seconds">Agentenzeit</option>
      </select></label>
    </div>
    <div class="ui-card-body" data-body="models"></div>
  </section>

  <section class="ui-card g" data-section aria-labelledby="h-efforts">
    <div class="ui-card-head"><h2 class="ui-card-title" id="h-efforts">Effort</h2></div>
    <div class="ui-card-body" data-body="efforts"></div>
  </section>

  <section class="ui-card g" data-section aria-labelledby="h-roles">
    <div class="ui-card-head"><h2 class="ui-card-title" id="h-roles">Rollen</h2></div>
    <div class="ui-card-body" data-body="roles"></div>
  </section>

  <div class="grid-2">
    <section class="ui-card g" data-section aria-labelledby="h-tools">
      <div class="ui-card-head"><h2 class="ui-card-title" id="h-tools">Tools</h2></div>
      <div class="ui-card-body" data-body="tools"></div>
    </section>
    <section class="ui-card g" data-section aria-labelledby="h-integrations">
      <div class="ui-card-head"><h2 class="ui-card-title" id="h-integrations">Laravel Boost &amp; Integrationen</h2></div>
      <div class="ui-card-body" data-body="integrations"></div>
    </section>
  </div>

  <section class="ui-card g" data-section aria-labelledby="h-repos">
    <div class="ui-card-head"><h2 class="ui-card-title" id="h-repos">Repositories</h2>
      <label class="field"><span class="lbl">Vergleichen nach</span><select id="repo-sort">
        <option value="runs">Runs</option><option value="cost_usd">Kosten</option><option value="total_tokens">Tokens</option>
        <option value="agent_seconds">Agentenzeit</option>
      </select></label>
    </div>
    <div class="ui-card-body" data-body="repos"></div>
  </section>

  <div class="grid-3">
    <section class="ui-card g" data-section aria-labelledby="h-outcomes">
      <div class="ui-card-head"><h2 class="ui-card-title" id="h-outcomes">Run-Ergebnisse</h2></div>
      <div class="ui-card-body" data-body="outcomes"></div>
    </section>
    <section class="ui-card g" data-section aria-labelledby="h-durations">
      <div class="ui-card-head"><h2 class="ui-card-title" id="h-durations">Run-Dauer</h2></div>
      <div class="ui-card-body" data-body="durations"></div>
    </section>
    <section class="ui-card g" data-section aria-labelledby="h-heatmap">
      <div class="ui-card-head"><h2 class="ui-card-title" id="h-heatmap">Wann Symphony läuft</h2></div>
      <div class="ui-card-body" data-body="heatmap"></div>
    </section>
  </div>

  <div class="grid-2">
    <section class="ui-card g" data-section aria-labelledby="h-top">
      <div class="ui-card-head"><h2 class="ui-card-title" id="h-top">Top-Runs</h2></div>
      <div class="ui-card-body" data-body="top"></div>
    </section>
    <section class="ui-card g" data-section aria-labelledby="h-attention">
      <div class="ui-card-head"><h2 class="ui-card-title" id="h-attention">Auffälligkeiten</h2></div>
      <div class="ui-card-body" data-body="attention"></div>
    </section>
  </div>

  <section class="ui-card g" data-section aria-labelledby="h-issues">
    <div class="ui-card-head"><h2 class="ui-card-title" id="h-issues">Issues <span class="count" id="issue-count"></span></h2>
      <label class="field"><span class="lbl">Sortieren</span><select id="issue-sort">
        <option value="cost">Teuerste</option><option value="tokens">Meiste Tokens</option><option value="time">Längste Laufzeit</option>
        <option value="runs">Meiste Runs</option><option value="newest">Neueste</option><option value="completed">Zuletzt abgeschlossen</option>
        <option value="failed">Fehlgeschlagen</option>
      </select></label>
    </div>
    <div class="ui-card-body" data-body="issues"></div>
  </section>

  <section class="ui-card g" id="logs" aria-labelledby="h-log">
    <div class="ui-card-head"><h2 class="ui-card-title" id="h-log">Log <span class="count" id="log-count"></span></h2></div>
    <form class="filters" id="log-filters">
      <label class="field"><span class="lbl">Issue</span><input type="text" id="log-issue" placeholder="#76 oder owner/name#76"></label>
      <label class="field"><span class="lbl">Event</span><select id="log-event"><option value="">Alle Events</option></select></label>
      <label class="field"><span class="lbl">Ergebnis</span><select id="log-result"><option value="">Alle Ergebnisse</option></select></label>
      <label class="field"><span class="lbl">Reihenfolge</span><select id="log-order"><option value="desc">Neueste zuerst</option><option value="asc">Älteste zuerst</option></select></label>
      <button class="ui-btn" type="submit">Filtern</button>
    </form>
    <div class="ui-card-body" id="log-body" style="margin-top: 14px"></div>
  </section>
  <p class="meta" id="footer"></p>
`,
  scripts: `
(() => {
${CHART_JS}

  // ------------------------------------------------------------------------------------------------------------
  // Central filter state: everything below reads the period from range() and never computes dates itself.

  const PERIODS = { today: 'Heute', yesterday: 'Gestern', '7d': 'Letzte 7 Tage', '14d': 'Letzte 14 Tage', '30d': 'Letzte 30 Tage',
    '90d': 'Letzte 90 Tage', month: 'Dieser Monat', last_month: 'Letzter Monat', all: 'Gesamter Zeitraum', custom: 'Eigener Zeitraum' };
  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const $ = (id) => document.getElementById(id);

  function readFilter() {
    const p = new URLSearchParams(location.search);
    const period = PERIODS[p.get('period')] ? p.get('period') : '30d';
    return { period, from: p.get('from') || '', to: p.get('to') || '', repo: p.get('repo') || '', model: p.get('model') || '', effort: p.get('effort') || '' };
  }
  let filter = readFilter();

  function setFilter(changes) {
    filter = { ...filter, ...changes };
    if (filter.period !== 'custom') { filter.from = ''; filter.to = ''; }
    const url = new URL(location.href);
    url.search = '';
    for (const key of ['period', 'from', 'to', 'repo', 'model', 'effort']) if (filter[key]) url.searchParams.set(key, filter[key]);
    history.replaceState(null, '', url);
    loadAll();
  }

  const isoDate = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const parseDate = (s) => { const m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(s || ''); return m ? new Date(+m[1], m[2] - 1, +m[3]) : null; };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

  /** { from, to } in local time ([from, to), null = open), or { error }. */
  function range(f) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = { '7d': 7, '14d': 14, '30d': 30, '90d': 90 }[f.period];
    if (days) return { from: addDays(today, 1 - days), to: addDays(today, 1) };
    switch (f.period) {
      case 'today': return { from: today, to: addDays(today, 1) };
      case 'yesterday': return { from: addDays(today, -1), to: today };
      case 'month': return { from: new Date(today.getFullYear(), today.getMonth(), 1), to: new Date(today.getFullYear(), today.getMonth() + 1, 1) };
      case 'last_month': return { from: new Date(today.getFullYear(), today.getMonth() - 1, 1), to: new Date(today.getFullYear(), today.getMonth(), 1) };
      case 'all': return { from: null, to: null };
      default: {
        const from = parseDate(f.from), to = parseDate(f.to);
        if (!from || !to) return { error: 'Start- und Enddatum wählen.' };
        if (to < from) return { error: 'Das Enddatum liegt vor dem Startdatum.' };
        return { from, to: addDays(to, 1) };
      }
    }
  }

  /** The requested end: the period end, but never later than now (rounded up to the minute, so repeats hit the cache). */
  function effectiveEnd(to) {
    if (to === null) return null;
    const now = new Date(Math.ceil(Date.now() / 60000) * 60000);
    return to > now ? now : to;
  }
  const fmtDay = (d) => d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' });

  // ------------------------------------------------------------------------------------------------------------
  // Formatting

  const fmtAxisUsd = (v) => '$' + (v >= 100 ? v.toFixed(0) : v >= 1 || v === 0 ? v.toFixed(v % 1 ? 1 : 0) : v >= 0.01 ? v.toFixed(v >= 0.1 ? 2 : 3) : String(Number(v.toPrecision(2))));
  const fmtPct = (r) => (r === null || r === undefined ? '—' : (r * 100).toFixed(r * 100 >= 10 || r === 0 ? 0 : 1) + '%');
  const fmtRatio = (r) => (r === null || r === undefined ? '—' : r.toFixed(r >= 10 ? 0 : 2));
  const orDash = (v, fmt) => (v === null || v === undefined ? '—' : fmt(v));
  const METRICS = {
    runs: { label: 'Runs', key: 'runs', fmt: fmtInt, axis: fmtCompact, color: 'var(--green)' },
    tokens: { label: 'Tokens', key: 'total_tokens', fmt: fmtCompact, axis: fmtCompact, color: 'var(--cyan)' },
    cost: { label: 'Kosten (geschätzt)', key: 'cost_usd', fmt: fmtUsd, axis: fmtAxisUsd, color: 'var(--green)' },
    time: { label: 'Agentenzeit', key: 'agent_seconds', fmt: fmtDuration, axis: fmtDuration, color: 'var(--cyan)' },
  };
  const OUTCOME_TONE = { handed_off: 'green', continuing: 'cyan', failed: 'red', stalled: 'red', stopped: 'gray', shutdown: 'gray' };
  const chipTone = (t) => (t === 'cyan' ? 'sky' : t);
  const shortRepo = (r) => (r || '').split('/').pop();

  // Buckets: keys as the server builds them in our time zone (hour 2026-10-05T14, day 2026-10-05, week = its Monday, month 2026-10).
  function bucketStart(key) {
    const m = /^(\\d{4})-(\\d{2})(?:-(\\d{2}))?(?:T(\\d{2}))?$/.exec(key);
    return new Date(+m[1], m[2] - 1, m[3] ? +m[3] : 1, m[4] ? +m[4] : 0);
  }
  function bucketLabel(key, g, long) {
    const d = bucketStart(key);
    if (g === 'hour') return long ? d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ', ' + pad2(d.getHours()) + ':00–' + pad2((d.getHours() + 1) % 24) + ':00' : pad2(d.getHours()) + ':00';
    if (g === 'month') return d.toLocaleDateString(undefined, long ? { month: 'long', year: 'numeric' } : { month: 'short', year: '2-digit' });
    const day = d.toLocaleDateString(undefined, long ? { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });
    return g === 'week' ? (long ? 'Woche ab ' : '') + day : day;
  }
  /** Zooming into a bucket narrows the global period to it (day → hourly, week → daily, month → daily). */
  function zoomInto(key, g) {
    if (g === 'hour') return;
    const start = bucketStart(key);
    const end = g === 'day' ? start : g === 'week' ? addDays(start, 6) : new Date(start.getFullYear(), start.getMonth() + 1, 0);
    setFilter({ period: 'custom', from: isoDate(start), to: isoDate(end) });
  }
  const bucketTip = (b) => [['Runs', fmtInt(b.runs)], ['Tokens', fmtCompact(b.total_tokens)], ['Kosten', fmtUsd(b.cost_usd)], ['Agentenzeit', fmtDuration(b.agent_seconds)]];

  // ------------------------------------------------------------------------------------------------------------
  // Section states

  const bodies = {};
  for (const node of document.querySelectorAll('[data-body]')) bodies[node.dataset.body] = node;
  function stateBox(kind, title, text, retry) {
    const box = el('div', null, 'state gi ' + kind);
    box.append(chip(title, { tone: { empty: 'gray', loading: 'sky', error: 'red' }[kind] }), el('span', text));
    if (retry) box.append(button('Erneut versuchen', { size: 36, onClick: retry }));
    return box;
  }
  function setBody(name, ...nodes) {
    for (const host of bodies[name].querySelectorAll('.chart')) unmount(host);
    bodies[name].replaceChildren(...nodes);
  }
  const noData = (text) => stateBox('empty', 'KEINE DATEN', text || 'Für den gewählten Zeitraum wurden keine Agent-Runs aufgezeichnet.');

  // ------------------------------------------------------------------------------------------------------------
  // Analytics

  let data = null;
  let analyticsRequest = null;
  const view = { activity: 'runs', cost: 'period', issueLimit: 25 };

  async function loadAnalytics() {
    const r = range(filter);
    renderPeriod(r);
    if (r.error) { for (const name in bodies) setBody(name, stateBox('error', 'UNGÜLTIGER ZEITRAUM', r.error)); return; }
    analyticsRequest?.abort();
    const controller = new AbortController();
    analyticsRequest = controller;
    if (data === null) for (const name in bodies) setBody(name, stateBox('loading', 'LÄDT', 'Die Logs werden ausgewertet…'));
    $('main').classList.add('busy');
    const params = new URLSearchParams({ tz: TZ });
    const to = effectiveEnd(r.to);
    if (r.from) params.set('from', r.from.toISOString());
    if (to) params.set('to', to.toISOString());
    if (filter.repo) params.set('repo', filter.repo);
    if (filter.model) params.set('model', filter.model);
    if (filter.effort) params.set('effort', filter.effort);
    try {
      if (r.from && to && r.from >= to) throw new Error('Der Zeitraum beginnt in der Zukunft.');
      const res = await fetch('/api/v1/history/analytics?' + params, { cache: 'no-store', signal: controller.signal });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ? body.error.message : 'HTTP ' + res.status);
      data = body;
      render(body);
      setLive(true);
    } catch (error) {
      if (error.name === 'AbortError') return;
      setLive(false);
      data = null;
      for (const name in bodies) setBody(name, stateBox('error', 'STATISTIK NICHT LADBAR', error.message, loadAnalytics));
    } finally {
      if (analyticsRequest === controller) { analyticsRequest = null; $('main').classList.remove('busy'); }
    }
  }

  function renderPeriod(r) {
    $('period').value = filter.period;
    const custom = filter.period === 'custom';
    if (!custom && r.from && r.to) { $('from').value = isoDate(r.from); $('to').value = isoDate(addDays(r.to, -1)); }
    else if (!custom) { $('from').value = ''; $('to').value = ''; }
    else { $('from').value = filter.from; $('to').value = filter.to; }
    const parts = [el('strong', PERIODS[filter.period])];
    if (r.from && r.to) parts.push(el('span', fmtDay(r.from) + ' → ' + fmtDay(addDays(r.to, -1))));
    else if (!r.error) parts.push(el('span', data && data.period.start ? 'seit ' + fmtDay(new Date(data.period.start)) : 'alles Geloggte'));
    if (data && !r.error) {
      parts.push(el('span', { hour: 'stündliche', day: 'tägliche', week: 'wöchentliche', month: 'monatliche' }[data.period.granularity] + ' Balken', 'meta'));
      if (data.previous) parts.push(el('span', 'verglichen mit ' + fmtDay(new Date(data.previous.from)) + ' → ' + fmtDay(new Date(Date.parse(data.previous.to) - 1)), 'meta'));
    }
    for (const [key, label] of [['repo', 'Repository'], ['model', 'Modell'], ['effort', 'Effort']]) {
      if (!filter[key]) continue;
      const fc = filterChip(label + ': ' + filter[key] + ' ✕', { pressed: true, onClick: () => setFilter({ [key]: '' }) });
      fc.title = 'Filter „' + label + '“ entfernen';
      parts.push(fc);
    }
    if (filter.model) parts.push(el('span', 'Tokens und Kosten zählen nur dieses Modell', 'meta'));
    $('period-label').replaceChildren(...parts);
  }

  function options(select, values, allLabel, current) {
    const list = [...new Set([...values, ...(current ? [current] : [])])];
    select.replaceChildren(...[['', allLabel], ...list.map((v) => [v, v])].map(([value, label]) => { const o = el('option', label); o.value = value; return o; }));
    select.value = current;
  }

  function render(d) {
    renderPeriod(range(filter));
    options($('repo'), d.repositories_available, 'Alle Repositories', filter.repo);
    options($('model'), d.models_available, 'Alle Modelle', filter.model);
    options($('effort'), d.efforts_available, 'Alle Efforts', filter.effort);
    $('raw').hidden = !filter.repo;
    $('raw').href = '/api/v1/history/raw?repo=' + encodeURIComponent(filter.repo);
    const problems = [];
    if (d.pricing_error) problems.push('model-costs.yml: ' + d.pricing_error + ' (es gelten die bisherigen Preise)');
    $('problems').hidden = problems.length === 0;
    $('problem-list').replaceChildren(...problems.map((p) => el('li', p)));
    $('footer').textContent = 'Logs: ' + d.history_dir + ' · Preise: ' + d.pricing_file +
      ' (Kosten werden aus den geloggten Tokens mit den aktuellen Preisen neu berechnet) · Zeitzone: ' + d.period.time_zone + ' · Aktualisiert ' + fmtTime(d.generated_at);

    renderKpis(d);
    if (d.totals.runs === 0) {
      for (const name of ['activity', 'cost', 'tokens', 'models', 'efforts', 'roles', 'tools', 'integrations', 'repos', 'outcomes', 'durations', 'heatmap', 'top', 'attention', 'issues']) setBody(name, noData());
      $('issue-count').textContent = '';
      return;
    }
    renderActivity(d); renderCost(d); renderTokens(d); renderModels(d); renderEfforts(d); renderRoles(d); renderTools(d); renderIntegrations(d); renderRepos(d);
    renderOutcomes(d); renderDurations(d); renderHeatmap(d); renderTop(d); renderAttention(d); renderIssues(d);
  }

  /** "↑ 12.4% ggü. Vorperiode", only when the logs cover the previous period. */
  function delta(current, previous, key, opts) {
    if (!previous) return null;
    const before = previous[key], now = current[key];
    if (before === null || before === undefined || now === null || now === undefined) return null;
    const box = el('div', null, 'delta');
    if (before === 0 && now === 0) { box.append(el('b', '±0'), ' ggü. Vorperiode'); return box; }
    if (before === 0) { box.append(el('b', 'neu'), ' · Vorperiode: 0'); return box; }
    const change = (now - before) / before;
    const up = change > 0;
    box.className = 'delta ' + (Math.abs(change) < 0.0005 ? '' : up ? 'up' : 'down') + (opts && opts.badWhenUp && up && change > 0 ? ' bad' : '');
    box.append(el('b', (Math.abs(change) < 0.0005 ? '±' : up ? '↑ ' : '↓ ') + (Math.abs(change) * 100).toFixed(1) + '%'), ' ggü. Vorperiode');
    box.title = 'Vorperiode: ' + (opts && opts.fmt ? opts.fmt(before) : before);
    return box;
  }

  const toneHex = (t) => UI_CHIP_TONES[t].c;
  /** A key figure tile with the change against the previous period and, for the main figures, a sparkline of the buckets. */
  function tile(value, label, opts) {
    const { sub, color, size, change, trend } = opts || {};
    const box = kpi(value, label, { sub, color: color ? toneHex(color) : null, size });
    if (change) box.append(change);
    if (trend && trend.length > 1) { const sp = sparkline(trend, toneHex(color || 'sky')); if (sp) box.append(sp); }
    return box;
  }

  function renderKpis(d) {
    const t = d.totals, p = d.previous;
    const trend = (key) => d.series.map((b) => b[key]);
    const primary = el('div', null, 'kpi-grid primary');
    primary.append(
      tile(fmtInt(t.runs), 'Runs', { sub: fmtInt(t.repositories) + ' Repositor' + (t.repositories === 1 ? 'y' : 'ies'), change: delta(t, p, 'runs', { fmt: fmtInt }), trend: trend('runs') }),
      tile(fmtInt(t.issues), 'Issues', { change: delta(t, p, 'issues', { fmt: fmtInt }) }),
      tile(fmtCompact(t.total_tokens), 'Tokens', { sub: fmtCompact(t.output_tokens) + ' Output', change: delta(t, p, 'total_tokens', { fmt: fmtCompact }), trend: trend('total_tokens') }),
      tile(fmtUsd(t.cost_usd), 'Kosten (geschätzt)', { size: 28, change: delta(t, p, 'cost_usd', { fmt: fmtUsd }), trend: trend('cost_usd') }),
      tile(fmtDuration(t.agent_seconds), 'Agentenzeit', { change: delta(t, p, 'agent_seconds', { fmt: fmtDuration }), trend: trend('agent_seconds') }),
      tile(orDash(t.avg_run_seconds, fmtDuration), 'Ø Run', { change: delta(t, p, 'avg_run_seconds', { fmt: fmtDuration, badWhenUp: true }) }),
    );
    const secondary = el('div', null, 'kpi-grid secondary');
    secondary.append(
      tile(orDash(t.avg_cost_per_run, fmtUsd), 'Kosten/Run', { change: delta(t, p, 'avg_cost_per_run', { fmt: fmtUsd }) }),
      tile(orDash(t.avg_tokens_per_run, fmtCompact), 'Tokens/Run', { change: delta(t, p, 'avg_tokens_per_run', { fmt: fmtCompact }) }),
      tile(fmtInt(t.successful), 'Erfolgreich', { sub: t.runs ? fmtPct(t.successful / t.runs) + ' der Runs' : null, color: 'green' }),
      tile(fmtInt(t.failed), 'Fehlgeschlagen', { sub: t.runs ? fmtPct(t.failure_rate) + ' der Runs' : null, change: delta(t, p, 'failed', { fmt: fmtInt, badWhenUp: true }), color: t.failed ? 'red' : null }),
      tile(fmtPct(t.retry_rate), 'Retry-Quote', { sub: fmtInt(t.retries) + ' wiederholte Run' + (t.retries === 1 ? '' : 's'), color: t.retries ? 'amber' : null }),
    );
    if (t.paused !== null) secondary.append(tile(fmtInt(t.paused), 'Pausiert', { sub: 'Issues pausiert', color: t.paused ? 'amber' : null }));
    const nodes = [primary, secondary];
    if (t.runs === 0) nodes.push(el('p', 'Für den gewählten Zeitraum wurden keine Agent-Runs aufgezeichnet.', 'note'));
    else if (!p && d.period.from) nodes.push(el('p', 'Kein Vergleich: Die Logs decken die Vorperiode gleicher Länge nicht ab.', 'note'));
    setBody('kpi', ...nodes);
  }

  function chartHost(name) { const host = el('div', null, 'chart'); return host; }

  function renderActivity(d) {
    const metric = METRICS[view.activity];
    const g = d.period.granularity;
    const host = chartHost();
    setBody('activity', host);
    timeChart(host, {
      labels: d.series.map((b) => bucketLabel(b.key, g)),
      title: (i) => bucketLabel(d.series[i].key, g, true),
      series: [{ label: metric.label, color: metric.color, values: d.series.map((b) => b[metric.key]) }],
      kind: 'bar', fmt: metric.axis, height: 240, integer: view.activity === 'runs',
      tip: (i) => bucketTip(d.series[i]),
      onClick: g === 'hour' ? null : (i) => zoomInto(d.series[i].key, g),
      ariaLabel: metric.label + ' je ' + ({ hour: 'Stunde', day: 'Tag', week: 'Woche', month: 'Monat' }[g]),
    });
    if (g !== 'hour') bodies.activity.append(el('p', 'Ein Balken lässt sich anklicken, um hineinzuzoomen.', 'note'));
  }

  function renderCost(d) {
    const g = d.period.granularity;
    let sum = 0;
    const cumulative = d.series.map((b) => (sum += b.cost_usd));
    const values = view.cost === 'cumulative' ? cumulative : d.series.map((b) => b.cost_usd);
    const host = chartHost();
    setBody('cost', host);
    timeChart(host, {
      labels: d.series.map((b) => bucketLabel(b.key, g)),
      title: (i) => bucketLabel(d.series[i].key, g, true),
      series: [{ label: 'Kosten', color: 'var(--green)', values }],
      kind: view.cost === 'cumulative' || d.series.length > 1 ? 'area' : 'bar', fmt: fmtAxisUsd,
      tip: (i) => [...bucketTip(d.series[i]), ['Kumuliert', fmtUsd(cumulative[i])]],
      ariaLabel: 'Geschätzte Kosten im Zeitverlauf',
    });
  }

  function renderTokens(d) {
    const g = d.period.granularity;
    const host = chartHost(); const lg = el('div', null, 'legend');
    setBody('tokens', lg, host);
    const series = [
      { label: 'Input', color: 'var(--cyan)', values: d.series.map((b) => b.input_tokens) },
      { label: 'Output', color: 'var(--green)', values: d.series.map((b) => b.output_tokens) },
      { label: 'Cache lesen + schreiben', color: 'var(--gray)', values: d.series.map((b) => b.cache_read_tokens + b.cache_write_tokens) },
    ];
    legend(lg, series.map((s) => [s.label, s.color]));
    timeChart(host, {
      labels: d.series.map((b) => bucketLabel(b.key, g)),
      title: (i) => bucketLabel(d.series[i].key, g, true),
      series, kind: 'bar', stacked: true, fmt: fmtCompact,
      tip: (i) => {
        const b = d.series[i];
        return [['Input', fmtCompact(b.input_tokens), 'var(--cyan)'], ['Output', fmtCompact(b.output_tokens), 'var(--green)'],
          ['Cache lesen', fmtCompact(b.cache_read_tokens), 'var(--gray)'], ['Cache schreiben', fmtCompact(b.cache_write_tokens), 'var(--gray)'],
          ['Gesamt', fmtCompact(b.total_tokens)], ['Runs', fmtInt(b.runs)]];
      },
      ariaLabel: 'Tokens im Zeitverlauf, gestapelt nach Art',
    });
  }

  const MODEL_SORT = {
    cost_usd: [fmtUsd, (r) => fmtPct(r.cost_share) + ' der Kosten'], runs: [fmtInt, null], total_tokens: [fmtCompact, (r) => fmtPct(r.token_share) + ' der Tokens'],
    avg_cost_per_run: [(v) => orDash(v, fmtUsd), null], avg_tokens_per_run: [(v) => orDash(v, fmtCompact), null], agent_seconds: [fmtDuration, null],
  };
  function renderModels(d) {
    const key = $('model-sort').value;
    const [fmt, sub] = MODEL_SORT[key];
    const rows = [...d.models].sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1));
    const bars = el('div', null, 'hbars');
    hbars(bars, rows.map((r) => ({
      label: r.model, value: r[key] || 0, text: fmt(r[key]), sub: sub ? sub(r) : null,
      color: filter.model === r.model ? 'var(--green)' : 'var(--cyan)', active: filter.model === r.model,
      tip: [['Runs', fmtInt(r.runs)], ['Input', fmtCompact(r.input_tokens)], ['Output', fmtCompact(r.output_tokens)],
        ['Cache lesen', fmtCompact(r.cache_read_tokens)], ['Cache schreiben', fmtCompact(r.cache_write_tokens)], ['Tokens gesamt', fmtCompact(r.total_tokens)],
        ['Kosten', fmtUsd(r.cost_usd)], ['Agentenzeit', fmtDuration(r.agent_seconds)], ['Preiseintrag', r.price]],
      onClick: () => setFilter({ model: filter.model === r.model ? '' : r.model }),
    })), 'Nach Modell filtern');
    const tbl = el('table'); tbl.id = 'models-table';
    const wrap = el('div', null, 'scroll'); wrap.append(tbl);
    setBody('models', bars, el('p', 'Ein Modell anklicken, um die ganze Seite danach zu filtern.', 'note'), el('h3', 'Effizienz', 'sub-h'), wrap,
      el('p', 'Ein Run kann mehrere Modelle nutzen: Runs und Tokens zählen jedes genutzte Modell; Agentenzeit und Ø Run zählen den Run für sein Hauptmodell (meiste Tokens). Kosten je 1 Mio. Tokens enthalten Cache-Tokens; Out/In vergleicht den Output mit allen Input-Tokens inkl. Cache. Ein Run, der endete, bevor Nutzung geloggt wurde, zählt unter dem Modell, mit dem er gestartet wurde (ein Alias wie „opus“ unter der gemeldeten ID dieser Familie), mit 0 Tokens.', 'note'));
    table('models-table', [
      { label: 'Modell', className: 'nowrap', render: (r) => r.model },
      { label: 'Runs', className: 'num', render: (r) => fmtInt(r.runs) },
      { label: 'Input', className: 'num', render: (r) => fmtCompact(r.input_tokens) },
      { label: 'Output', className: 'num', render: (r) => fmtCompact(r.output_tokens) },
      { label: 'Cache L/S', className: 'num', render: (r) => fmtCompact(r.cache_read_tokens) + ' / ' + fmtCompact(r.cache_write_tokens) },
      { label: 'Kosten', className: 'num', render: (r) => fmtUsd(r.cost_usd) },
      { label: 'Agentenzeit', className: 'num', render: (r) => fmtDuration(r.agent_seconds) },
      { label: 'Ø Run', className: 'num', render: (r) => orDash(r.avg_run_seconds, fmtDuration) },
      { label: 'Kosten/Run', className: 'num', render: (r) => orDash(r.avg_cost_per_run, fmtUsd) },
      { label: 'Tokens/Run', className: 'num', render: (r) => orDash(r.avg_tokens_per_run, fmtCompact) },
      { label: 'Kosten/1 Mio. Tok.', className: 'num', render: (r) => orDash(r.cost_per_million_tokens, fmtUsd) },
      { label: 'Out/In', className: 'num', render: (r) => fmtRatio(r.output_input_ratio) },
    ], rows, 'Keine Modellnutzung in diesem Zeitraum.');
  }

  /** Runs, tokens and cost by the effort requested for the run, with the models that ran at that effort. */
  function renderEfforts(d) {
    const rows = d.efforts;
    const bars = el('div', null, 'hbars');
    hbars(bars, rows.map((r) => ({
      label: r.effort, value: r.cost_usd || 0, text: fmtUsd(r.cost_usd), sub: fmtInt(r.runs) + ' Run' + (r.runs === 1 ? '' : 's') + (r.cost_share !== null ? ' · ' + fmtPct(r.cost_share) + ' der Kosten' : ''),
      color: filter.effort === r.effort ? 'var(--green)' : 'var(--amber)', active: filter.effort === r.effort,
      tip: [['Runs', fmtInt(r.runs)], ['Erfolgreich', fmtInt(r.successful)], ['Fehlgeschlagen', fmtInt(r.failed)], ['Tokens', fmtCompact(r.total_tokens)],
        ['Kosten', fmtUsd(r.cost_usd)], ['Agentenzeit', fmtDuration(r.agent_seconds)], ['Modelle', countsText(r.models) || '—']],
      onClick: () => setFilter({ effort: filter.effort === r.effort ? '' : r.effort }),
    })), 'Nach Effort filtern');
    const tbl = el('table'); tbl.id = 'efforts-table';
    const wrap = el('div', null, 'scroll'); wrap.append(tbl);
    setBody('efforts', bars, el('p', 'Einen Effort anklicken, um die ganze Seite danach zu filtern.', 'note'), wrap,
      el('p', 'Der für den Run angeforderte Effort: das Label Effort: …, sonst der Effort der Rolle oder CLAUDE_EFFORT; „default“ ist der Standard von Claude Code. Runs, die vor der Aufzeichnung des Efforts geloggt wurden, zählen als „unknown“. Modelle: das Hauptmodell der Runs mit diesem Effort.', 'note'));
    table('efforts-table', [
      { label: 'Effort', className: 'nowrap', render: (r) => r.effort },
      { label: 'Runs', className: 'num', render: (r) => fmtInt(r.runs) },
      { label: 'Erfolgreich', className: 'num', render: (r) => fmtInt(r.successful) + (r.success_rate !== null ? ' (' + fmtPct(r.success_rate) + ')' : '') },
      { label: 'Fehlgeschlagen', className: 'num', render: (r) => fmtInt(r.failed) },
      { label: 'Tokens', className: 'num', render: (r) => fmtCompact(r.total_tokens) },
      { label: 'Kosten', className: 'num', render: (r) => fmtUsd(r.cost_usd) },
      { label: 'Agentenzeit', className: 'num', render: (r) => fmtDuration(r.agent_seconds) },
      { label: 'Ø Run', className: 'num', render: (r) => orDash(r.avg_run_seconds, fmtDuration) },
      { label: 'Kosten/Run', className: 'num', render: (r) => orDash(r.avg_cost_per_run, fmtUsd) },
      { label: 'Tokens/Run', className: 'num', render: (r) => orDash(r.avg_tokens_per_run, fmtCompact) },
      { label: 'Modelle', render: (r) => countsText(r.models) || '—' },
    ], rows, 'Keine Runs in diesem Zeitraum.');
  }

  /** Runs, tokens, cost, agent time and outcomes by the agent role that served the run. */
  function renderRoles(d) {
    const rows = d.by_role;
    const bars = el('div', null, 'hbars');
    hbars(bars, rows.map((r) => ({
      label: r.role, value: r.cost_usd || 0, text: fmtUsd(r.cost_usd), sub: fmtInt(r.runs) + ' Run' + (r.runs === 1 ? '' : 's') + (r.cost_share !== null ? ' · ' + fmtPct(r.cost_share) + ' der Kosten' : ''),
      color: uiOwn(UI_ROLE_COLORS, r.role) ? 'var(--role-' + r.role + ')' : 'var(--gray)',
      tip: [['Runs', fmtInt(r.runs)], ['Issues', fmtInt(r.issues)], ['Erfolgreich', fmtInt(r.successful)], ['Fehlgeschlagen', fmtInt(r.failed)], ['Tokens', fmtCompact(r.total_tokens)],
        ['Kosten', fmtUsd(r.cost_usd)], ['Agentenzeit', fmtDuration(r.agent_seconds)], ['Ergebnisse', countsText(r.by_outcome) || '—']],
    })), null);
    const tbl = el('table'); tbl.id = 'roles-table';
    const wrap = el('div', null, 'scroll'); wrap.append(tbl);
    setBody('roles', bars, wrap,
      el('p', 'Die Rolle, die den Run ausgeführt hat (die Stufe der Issue-Pipeline). Runs, die vor der Aufzeichnung der Rolle geloggt wurden, zählen als „unknown“.', 'note'));
    table('roles-table', [
      { label: 'Rolle', className: 'nowrap', render: (r) => r.role },
      { label: 'Runs', className: 'num', render: (r) => fmtInt(r.runs) },
      { label: 'Issues', className: 'num', render: (r) => fmtInt(r.issues) },
      { label: 'Erfolgreich', className: 'num', render: (r) => fmtInt(r.successful) + (r.success_rate !== null ? ' (' + fmtPct(r.success_rate) + ')' : '') },
      { label: 'Fehlgeschlagen', className: 'num', render: (r) => fmtInt(r.failed) },
      { label: 'Tokens', className: 'num', render: (r) => fmtCompact(r.total_tokens) },
      { label: 'Kosten', className: 'num', render: (r) => fmtUsd(r.cost_usd) + (r.cost_share !== null ? ' (' + fmtPct(r.cost_share) + ')' : '') },
      { label: 'Agentenzeit', className: 'num', render: (r) => fmtDuration(r.agent_seconds) },
      { label: 'Ø Run', className: 'num', render: (r) => orDash(r.avg_run_seconds, fmtDuration) },
      { label: 'Kosten/Run', className: 'num', render: (r) => orDash(r.avg_cost_per_run, fmtUsd) },
      { label: 'Ergebnisse', render: (r) => countsText(r.by_outcome) || '—' },
    ], rows, 'Keine Runs in diesem Zeitraum.');
  }

  function statList(items) {
    const grid = el('div', null, 'kpi-grid');
    for (const [label, value, note] of items) grid.append(kpi(value, label, { sub: note }));
    return grid;
  }
  const TOOL_NOTE = 'Tool-Aufrufe werden je Run geloggt, seit Symphony sie aufzeichnet; ältere Runs zählen als Runs ohne Tool-Aufrufe.';

  /** Calls per tool (built-in and MCP) and per skill in the period. */
  function renderTools(d) {
    const t = d.tools;
    if (!t.calls) { setBody('tools', stateBox('empty', 'KEINE TOOL-AUFRUFE', 'Kein Run in diesem Zeitraum hat Tool-Aufrufe geloggt.'), el('p', TOOL_NOTE, 'note')); return; }
    const kv = statList([
      ['Tool-Aufrufe', fmtInt(t.calls)],
      ['Runs mit Aufrufen', fmtInt(t.runs_with_calls), 'von ' + fmtInt(t.runs) + ' Runs'],
      ['Aufrufe/Run', orDash(t.avg_calls_per_run, (v) => String(v))],
      ['Verschiedene Tools', fmtInt(t.distinct_tools)],
    ]);
    const bars = el('div', null, 'hbars');
    hbars(bars, t.tools.slice(0, 15).map((r) => ({
      label: r.server ? r.server + ' · ' + r.name : r.name, value: r.calls, text: fmtInt(r.calls), sub: fmtPct(r.calls / t.calls),
      color: r.server ? 'var(--cyan)' : 'var(--green)', tip: [['Aufrufe', fmtInt(r.calls)], ['Runs', fmtInt(r.runs)], ['Tool', r.tool]],
    })));
    const nodes = [kv, el('h3', 'Meistgenutzte Tools', 'sub-h'), bars];
    if (t.skills.length) {
      const skills = el('div', null, 'hbars');
      hbars(skills, t.skills.slice(0, 10).map((r) => ({ label: r.skill, value: r.calls, text: fmtInt(r.calls), sub: fmtInt(r.runs) + ' Run' + (r.runs === 1 ? '' : 's'), color: 'var(--amber)', tip: [['Geladen', fmtInt(r.calls) + '×'], ['Runs', fmtInt(r.runs)]] })));
      nodes.push(el('h3', 'Geladene Skills', 'sub-h'), skills);
    }
    if (t.agents && t.agents.length) {
      const agents = el('div', null, 'hbars');
      hbars(agents, t.agents.slice(0, 10).map((r) => ({ label: r.agent, value: r.calls, text: fmtInt(r.calls), sub: fmtInt(r.runs) + ' Run' + (r.runs === 1 ? '' : 's'), color: 'var(--violet)', tip: [['Gestartet', fmtInt(r.calls) + '×'], ['Runs', fmtInt(r.runs)]] })));
      nodes.push(el('h3', 'Genutzte Subagents', 'sub-h'), agents);
    }
    nodes.push(el('p', 'Grün: eingebaute Tools, Cyan: MCP-Tools (Server · Tool). Subagents zählen die Aufrufe des Agent-Tools nach Subagent-Typ. ' + TOOL_NOTE, 'note'));
    setBody('tools', ...nodes);
  }

  /** Per integration (e.g. Laravel Boost): runs it was ready in, runs that used it, and its tools and skills. */
  function renderIntegrations(d) {
    const list = d.tools.integrations;
    if (!list.length) {
      setBody('integrations', stateBox('empty', 'KEINE INTEGRATIONEN', 'Kein Run in diesem Zeitraum arbeitete an einem Projekt mit einer Workspace-Integration wie Laravel Boost.'));
      return;
    }
    const nodes = list.map((x) => {
      const box = el('div', null, 'int-block gi');
      const head = el('div', null, 'int-head');
      head.append(integrationIcon(x.id, 22, x.ready_runs === 0), el('b', integrationLabel(x.id)));
      const statuses = Object.entries(x.by_status).sort((a, b) => b[1] - a[1]);
      for (const [status, n] of statuses) { const s = INTEGRATION_STATUS[status] || [status, 'gray']; head.append(chip(s[0] + ' ' + fmtInt(n), { tone: chipTone(s[1]), dot: true })); }
      const kv = statList([
        ['Runs', fmtInt(x.runs), 'auf Projekten, die sie nutzen'],
        ['Bereit', fmtInt(x.ready_runs), 'für den Agenten verfügbar'],
        ['Genutzt', fmtInt(x.used_runs), x.use_rate === null ? null : fmtPct(x.use_rate) + ' der bereiten Runs'],
        ['Aufrufe', fmtInt(x.calls), x.avg_calls_per_used_run === null ? null : x.avg_calls_per_used_run + ' je nutzendem Run'],
      ]);
      box.append(head, kv);
      if (x.tools.length) {
        const bars = el('div', null, 'hbars');
        hbars(bars, x.tools.map((r) => ({ label: r.tool, value: r.calls, text: fmtInt(r.calls), sub: fmtInt(r.runs) + ' Run' + (r.runs === 1 ? '' : 's'), color: 'var(--violet)', tip: [['Aufrufe', fmtInt(r.calls)], ['Runs', fmtInt(r.runs)]] })));
        box.append(el('h3', 'MCP-Tools', 'sub-h'), bars);
      }
      if (x.skills.length) {
        const bars = el('div', null, 'hbars');
        hbars(bars, x.skills.map((r) => ({ label: r.skill, value: r.calls, text: fmtInt(r.calls), sub: fmtInt(r.runs) + ' Run' + (r.runs === 1 ? '' : 's'), color: 'var(--amber)', tip: [['Geladen', fmtInt(r.calls) + '×'], ['Runs', fmtInt(r.runs)]] })));
        box.append(el('h3', 'Skills', 'sub-h'), bars);
      }
      if (!x.calls) box.append(el('p', x.ready_runs ? 'Verfügbar, aber kein Agent hat in diesem Zeitraum ihre Tools oder Skills genutzt.' : 'Den Agenten in diesem Zeitraum nicht verfügbar.', 'note'));
      return box;
    });
    setBody('integrations', ...nodes, el('p', 'Bereit: Die Integration war für die Session eingerichtet. Genutzt: Der Agent hat mindestens eines ihrer MCP-Tools aufgerufen oder einen ihrer Skills geladen. Guidelines gehören zu jeder bereiten Session und werden nicht gezählt.', 'note'));
  }

  const REPO_METRIC = { runs: [fmtInt, 'runs'], cost_usd: [fmtUsd, 'cost'], total_tokens: [fmtCompact, 'tokens'], agent_seconds: [fmtDuration, 'time'] }
  const REPO_METRIC_TEXT = { runs: 'Runs', cost: 'Kosten', tokens: 'Tokens', time: 'Agentenzeit' };;
  function renderRepos(d) {
    const key = $('repo-sort').value;
    const [fmt, metricName] = REPO_METRIC[key];
    const rows = [...d.repositories].sort((a, b) => b[key] - a[key]);
    const total = rows.reduce((sum, r) => sum + r[key], 0);
    const bars = el('div', null, 'hbars');
    hbars(bars, rows.map((r) => ({
      label: r.repo, value: r[key], text: fmt(r[key]), sub: total ? fmtPct(r[key] / total) : null,
      color: 'var(--green)', active: filter.repo.toLowerCase() === r.repo.toLowerCase(),
      tip: [['Runs', fmtInt(r.runs)], ['Issues', fmtInt(r.issues)], ['Tokens', fmtCompact(r.total_tokens)], ['Kosten', fmtUsd(r.cost_usd)], ['Agentenzeit', fmtDuration(r.agent_seconds)]],
      onClick: () => setFilter({ repo: filter.repo.toLowerCase() === r.repo.toLowerCase() ? '' : r.repo }),
    })), 'Nach Repository filtern');

    // Activity over time, stacked: the three busiest repositories plus "Other".
    const g = d.period.granularity;
    const metric = METRICS[REPO_METRIC[key][1]];
    const leaders = rows.slice(0, 3).map((r) => r.repo);
    const series = leaders.map((repo, i) => ({ label: repo, color: SERIES_COLORS[i], values: d.series.map((b) => (b.by_repo[repo] || {})[metric.key] || 0) }));
    if (rows.length > 3) series.push({ label: 'Sonstige', color: SERIES_COLORS[3], values: d.series.map((b) => Object.entries(b.by_repo).filter(([r]) => !leaders.includes(r)).reduce((s, [, v]) => s + (v[metric.key] || 0), 0)) });
    const lg = el('div', null, 'legend'); const host = chartHost();
    const tbl = el('table'); tbl.id = 'repos-table'; const wrap = el('div', null, 'scroll'); wrap.append(tbl);
    const grid = el('div', null, 'grid-2');
    const left = el('div'); left.append(el('h3', 'Nach ' + REPO_METRIC_TEXT[metricName], 'sub-h'), bars, el('p', 'Ein Repository anklicken, um die ganze Seite danach zu filtern.', 'note'));
    const right = el('div'); right.append(el('h3', metric.label + ' im Zeitverlauf', 'sub-h'), lg, host);
    grid.append(left, right);
    setBody('repos', grid, wrap);
    legend(lg, series.map((s) => [s.label, s.color]));
    timeChart(host, {
      labels: d.series.map((b) => bucketLabel(b.key, g)),
      title: (i) => bucketLabel(d.series[i].key, g, true),
      series, kind: 'bar', stacked: true, fmt: metric.axis, height: 200, integer: key === 'runs',
      tip: (i) => series.filter((s) => s.values[i] > 0).map((s) => [shortRepo(s.label), metric.fmt(s.values[i]), s.color]).concat([['Gesamt', metric.fmt(d.series[i][metric.key])]]),
      ariaLabel: metric.label + ' je Repository im Zeitverlauf',
    });
    table('repos-table', [
      { label: 'Repository', className: 'nowrap', render: (r) => r.repo },
      { label: 'Runs', className: 'num', render: (r) => fmtInt(r.runs) },
      { label: 'Issues', className: 'num', render: (r) => fmtInt(r.issues) },
      { label: 'Tokens', className: 'num', render: (r) => fmtCompact(r.total_tokens) },
      { label: 'Kosten', className: 'num', render: (r) => fmtUsd(r.cost_usd) },
      { label: 'Agentenzeit', className: 'num', render: (r) => fmtDuration(r.agent_seconds) },
      { label: 'Ø Run', className: 'num', render: (r) => orDash(r.avg_run_seconds, fmtDuration) },
      { label: 'Kosten/Run', className: 'num', render: (r) => orDash(r.avg_cost_per_run, fmtUsd) },
      { label: 'Letzte Aktivität', className: 'nowrap', render: (r) => { const s = el('span', ago(r.last_at)); s.title = fmtTime(r.last_at); return s; } },
    ], rows, 'Keine Runs in diesem Zeitraum.');
  }

  function renderOutcomes(d) {
    const o = d.outcomes, t = d.totals;
    const other = t.runs - o.successful - o.failed - o.stopped;
    const parts = [
      { label: '✓ Erfolgreich (übergeben, läuft weiter)', value: o.successful, color: 'var(--st-run)' },
      { label: '✕ Fehlgeschlagen (fehlgeschlagen, hängengeblieben)', value: o.failed, color: 'var(--st-error)' },
      { label: '■ Gestoppt (gestoppt, beendet)', value: o.stopped, color: 'var(--st-wait)' },
      { label: '? Sonstige', value: other, color: 'var(--faint)' },
    ];
    const bar = el('div'); distBar(bar, parts);
    const list = el('ul', null, 'outcomes');
    for (const [outcome, count] of Object.entries(o.by_outcome).sort((a, b) => b[1] - a[1])) {
      const li = el('li'); const name = el('span'); const sw = el('i', null, 'swatch');
      sw.style.setProperty('--sw', 'var(--' + (OUTCOME_TONE[outcome] || 'gray') + ')');
      name.append(sw, OUTCOMES[outcome] || outcome); li.append(name, el('span', fmtInt(count) + ' · ' + fmtPct(count / t.runs))); list.append(li);
    }
    const extra = el('ul', null, 'outcomes');
    const li = (label, value) => { const item = el('li'); item.append(el('span', label), el('span', value)); extra.append(item); };
    li('↻ Wiederholte Runs (nach einem fehlgeschlagenen/hängengebliebenen Run)', fmtInt(o.retried) + ' · ' + fmtPct(t.retry_rate));
    if (o.paused !== null) li('⏸ Pausierte Issues', fmtInt(o.paused));
    const host = chartHost();
    const g = d.period.granularity;
    const series = [
      { label: 'Erfolgreich', color: 'var(--st-run)', values: d.series.map((b) => b.successful) },
      { label: 'Fehlgeschlagen', color: 'var(--st-error)', values: d.series.map((b) => b.failed) },
      { label: 'Gestoppt', color: 'var(--st-wait)', values: d.series.map((b) => b.stopped) },
      { label: 'Sonstige', color: 'var(--faint)', values: d.series.map((b) => b.runs - b.successful - b.failed - b.stopped) },
    ];
    setBody('outcomes', bar, list, extra, el('h3', 'Verlauf', 'sub-h'), host);
    timeChart(host, {
      labels: d.series.map((b) => bucketLabel(b.key, g)),
      title: (i) => bucketLabel(d.series[i].key, g, true),
      series, kind: 'bar', stacked: true, fmt: fmtCompact, height: 150, integer: true,
      tip: (i) => { const b = d.series[i]; return series.map((s) => [s.label, fmtInt(s.values[i]), s.color]).concat([['Wiederholt', fmtInt(b.retries)], ['Erfolgsquote', b.runs ? fmtPct(b.successful / b.runs) : '—']]); },
      ariaLabel: 'Run-Ergebnisse im Zeitverlauf',
    });
  }

  function renderDurations(d) {
    const s = d.durations;
    const kv = statList([
      ['Durchschnitt', orDash(s.avg_seconds, fmtDuration)],
      ['Median (p50)', orDash(s.p50_seconds, fmtDuration), s.p50_seconds === null ? 'braucht ≥ 3 Runs' : null],
      ['p90 / p95', s.p90_seconds === null ? '—' : fmtDuration(s.p90_seconds) + ' / ' + fmtDuration(s.p95_seconds), s.p90_seconds === null ? 'braucht ≥ 20 Runs' : null],
      ['Kürzester', orDash(s.min_seconds, fmtDuration), s.shortest ? s.shortest.issue : null],
      ['Längster', orDash(s.max_seconds, fmtDuration), s.longest ? s.longest.issue : null],
      ['Agentenzeit gesamt', fmtDuration(s.total_seconds)],
    ]);
    const bars = el('div', null, 'hbars');
    hbars(bars, s.histogram.map((b, i) => ({
      label: b.label, value: b.runs, text: fmtInt(b.runs), sub: s.runs ? fmtPct(b.runs / s.runs) : null,
      color: i >= 4 ? 'var(--amber)' : 'var(--cyan)', tip: [['Runs', fmtInt(b.runs)], ['Anteil', s.runs ? fmtPct(b.runs / s.runs) : '—']],
    })));
    const host = chartHost();
    const g = d.period.granularity;
    setBody('durations', kv, el('h3', 'Verteilung', 'sub-h'), bars, el('h3', 'Ø Run im Zeitverlauf', 'sub-h'), host);
    timeChart(host, {
      labels: d.series.map((b) => bucketLabel(b.key, g)),
      title: (i) => bucketLabel(d.series[i].key, g, true),
      series: [{ label: 'Ø Run', color: 'var(--cyan)', values: d.series.map((b) => b.avg_run_seconds || 0) }],
      kind: 'bar', fmt: fmtDuration, height: 130,
      tip: (i) => [['Ø Run', orDash(d.series[i].avg_run_seconds, fmtDuration)], ['Runs', fmtInt(d.series[i].runs)], ['Agentenzeit', fmtDuration(d.series[i].agent_seconds)]],
      ariaLabel: 'Durchschnittliche Run-Dauer im Zeitverlauf',
    });
  }

  function renderHeatmap(d) {
    if (!d.heatmap.max) { setBody('heatmap', noData()); return; }
    const host = el('div');
    setBody('heatmap', host, el('p', 'Run-Starts nach Wochentag und Stunde (' + d.period.time_zone + '). Hellere Zellen hatten mehr Starts; die stärkste hatte ' + fmtInt(d.heatmap.max) + '.', 'note'));
    heatmap(host, d.heatmap.start_times, d.heatmap.max);
  }

  /** Clicking an issue anywhere shows its log entries (its execution history) below. */
  function showIssueLog(issue) {
    $('log-issue').value = issue;
    $('log-event').value = ''; $('log-result').value = '';
    loadLogs();
    $('logs').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function clickable(node, issue) {
    node.tabIndex = 0; node.setAttribute('role', 'button'); node.title = 'Log von ' + issue + ' anzeigen';
    node.addEventListener('click', () => showIssueLog(issue));
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showIssueLog(issue); } });
  }
  /** The meta line of a ranked entry: a role chip per role of a pipeline, plain text otherwise. */
  function rankMeta(meta) {
    if (typeof meta === 'string') return el('span', meta, 'meta');
    const box = el('span', null, 'meta');
    box.append(...meta);
    return box;
  }
  const roleChip = (role, v) => chip(role + ' ' + fmtUsd(v.cost_usd), { tone: uiOwn(UI_ROLE_COLORS, role) || 'gray' });
  function rankList(rows, value, meta) {
    if (!rows.length) return el('p', 'Nichts in diesem Zeitraum.', 'empty');
    const list = el('ol', null, 'rank');
    for (const r of rows) {
      const li = el('li'); li.append(el('span', r.issue + (r.title ? ' — ' + r.title : ''), 'who'), el('span', value(r), 'val'), rankMeta(meta(r)));
      clickable(li, r.issue); list.append(li);
    }
    return list;
  }
  function renderTop(d) {
    const runMeta = (r) => [r.repo, r.model, r.effort && r.effort !== 'default' ? 'Effort ' + r.effort : null, fmtTime(r.finished_at), OUTCOMES[r.outcome] || r.outcome].filter(Boolean).join(' · ');
    const grid = el('div', null, 'grid-2');
    grid.style.gap = '4px 20px';
    const block = (title, node) => { const box = el('div'); box.append(el('h3', title, 'sub-h'), node); return box; };
    grid.append(
      block('Höchste Kosten', rankList(d.top.cost, (r) => fmtUsd(r.cost_usd), runMeta)),
      block('Meiste Tokens', rankList(d.top.tokens, (r) => fmtCompact(r.total_tokens), runMeta)),
      block('Längste Runs', rankList(d.top.duration, (r) => fmtDuration(r.agent_seconds), runMeta)),
      block('Teuerste Issue-Pipelines', rankList(d.top.pipelines, (r) => fmtUsd(r.cost_usd),
        (r) => [r.repo + ' · ' + fmtInt(r.runs) + ' Runs', ...Object.entries(r.roles).map(([role, v]) => roleChip(role, v))])),
      block('Meist wiederholte Issues', rankList(d.top.retried, (r) => fmtInt(r.retries) + '×', (r) => r.repo + ' · ' + fmtInt(r.runs) + ' Runs · ' + fmtInt(r.failed) + ' fehlgeschlagen')),
    );
    setBody('top', grid, el('p', 'Einen Eintrag anklicken, um sein Log zu sehen.', 'note'));
  }

  function renderAttention(d) {
    const rules = d.attention.rules;
    const ruleText = 'Markiert einzelne Runs mit mindestens dem ' + rules.factor + '-Fachen der durchschnittlichen Kosten, Dauer oder Tokens des Zeitraums (braucht ≥ ' + rules.minRuns +
      ' Runs) sowie Issues mit ≥ ' + rules.repeated + ' fehlgeschlagenen oder wiederholten Runs.';
    if (!d.attention.items.length) {
      setBody('attention', stateBox('empty', 'UNAUFFÄLLIG', d.totals.runs < rules.minRuns ? 'Zu wenige Runs für Durchschnitte; geprüft werden nur wiederholte Fehlschläge.' : 'Nichts Ungewöhnliches in diesem Zeitraum.'), el('p', ruleText, 'note'));
      return;
    }
    const list = el('ul', null, 'attention');
    for (const a of d.attention.items) {
      const red = a.kind === 'failures';
      const li = el('li', null, 'gi ' + (red ? 'tone-red' : 'tone-amber'));
      const value = a.kind === 'cost' ? fmtUsd(a.value) : a.kind === 'duration' ? fmtDuration(a.value) : a.kind === 'tokens' ? fmtCompact(a.value) : fmtInt(a.value) + '×';
      const avg = a.kind === 'cost' ? fmtUsd(a.average) : a.kind === 'duration' ? fmtDuration(a.average) : fmtCompact(a.average);
      const why = { cost: a.factor + '× Ø Run-Kosten (' + avg + ')', duration: a.factor + '× Ø Laufzeit (' + avg + ')',
        tokens: a.factor + '× Ø Tokens je Run (' + avg + ')', failures: a.value + ' fehlgeschlagene Runs in diesem Zeitraum', retries: a.value + ' wiederholte Runs in diesem Zeitraum' }[a.kind];
      li.append(el('span', red ? '✕' : '⚠', 'ico'), el('span', a.issue + (a.title ? ' — ' + a.title : ''), 'who'), el('span', value, 'val'),
        el('span', why + (a.at ? ' · ' + fmtTime(a.at) : ''), 'why'));
      clickable(li, a.issue); list.append(li);
    }
    const nodes = [list];
    if (d.attention.total > d.attention.items.length) nodes.push(el('p', (d.attention.total - d.attention.items.length) + ' weitere nicht angezeigt.', 'note'));
    setBody('attention', ...nodes, el('p', ruleText, 'note'));
  }

  const ISSUE_SORT = {
    cost: (a, b) => b.cost_usd - a.cost_usd, tokens: (a, b) => b.total_tokens - a.total_tokens, time: (a, b) => b.agent_seconds - a.agent_seconds,
    runs: (a, b) => b.runs - a.runs, newest: (a, b) => (b.first_started_at || '').localeCompare(a.first_started_at || ''),
    completed: (a, b) => (b.last_finished_at || '').localeCompare(a.last_finished_at || ''), failed: (a, b) => b.failed - a.failed || b.cost_usd - a.cost_usd,
  };
  function renderIssues(d) {
    const sort = $('issue-sort').value;
    const rows = (sort === 'failed' ? d.issues.filter((r) => r.failed > 0) : [...d.issues]).sort(ISSUE_SORT[sort]);
    $('issue-count').textContent = fmtInt(d.issues.length);
    const tbl = el('table'); tbl.id = 'issues-table'; const wrap = el('div', null, 'scroll'); wrap.append(tbl);
    const nodes = [wrap];
    if (rows.length > view.issueLimit) {
      const more = el('button', 'Alle ' + fmtInt(rows.length) + ' zeigen', 'ui-btn ui-btn-36 more'); more.type = 'button';
      more.addEventListener('click', () => { view.issueLimit = Infinity; renderIssues(data); });
      nodes.push(more);
    }
    setBody('issues', ...nodes);
    const columns = [{ label: 'Issue', className: 'issue-cell', render: (r) => { const s = el('div'); s.append(el('div', r.issue, 'mono'), el('div', r.title, 'meta')); s.title = r.title; return s; } }];
    if (!filter.repo) columns.push({ label: 'Repository', className: 'nowrap', render: (r) => shortRepo(r.repo) });
    columns.push(
      { label: 'Runs', className: 'num', render: (r) => fmtInt(r.runs) + (r.failed ? ' (' + r.failed + ' ✕)' : '') },
      { label: 'Ergebnis', className: 'event', render: (r) => chip((OUTCOMES[r.last_outcome] || r.last_outcome || '—') + ' → ' + (r.last_state || '—'), { tone: chipTone(OUTCOME_TONE[r.last_outcome] || 'gray'), mono: true }) },
      { label: 'Tokens', className: 'num', render: (r) => fmtCompact(r.total_tokens) },
      { label: 'Kosten', className: 'num', render: (r) => fmtUsd(r.cost_usd) },
      { label: 'Kosten nach Rolle', render: (r) => { const entries = Object.entries(r.roles); if (!entries.length) return '—'; const box = el('div', null, 'role-chips'); box.append(...entries.map(([role, v]) => roleChip(role, v))); return box; } },
      { label: 'Agentenzeit', className: 'num', render: (r) => fmtDuration(r.agent_seconds) },
      { label: 'Erster Start', className: 'nowrap', render: (r) => fmtTime(r.first_started_at) },
      { label: 'Zuletzt beendet', className: 'nowrap', render: (r) => fmtTime(r.last_finished_at) },
      { label: '', render: (r) => {
        const box = el('div', null, 'row-actions');
        const log = button('Log', { size: 36, onClick: () => showIssueLog(r.issue) }); log.title = 'Log-Einträge von ' + r.issue + ' anzeigen';
        const agent = button('Detail', { size: 36, href: '/issue?id=' + encodeURIComponent(r.issue) });
        agent.title = 'Agent-Detailansicht: Verlauf, Sessions und Transkripte des letzten Claims, auch nach Abschluss des Issues erhalten';
        box.append(log, agent); return box;
      } },
    );
    table('issues-table', columns, rows.slice(0, view.issueLimit), sort === 'failed' ? 'Kein Issue hatte in diesem Zeitraum einen fehlgeschlagenen Run.' : 'Keine Issues in diesem Zeitraum.');
  }

  // ------------------------------------------------------------------------------------------------------------
  // Log entries: loaded independently, so an error here never hides the statistics.

  let logRequest = null;
  async function loadLogs() {
    const r = range(filter);
    if (r.error) { $('log-body').replaceChildren(stateBox('error', 'UNGÜLTIGER ZEITRAUM', r.error)); return; }
    logRequest?.abort();
    const controller = new AbortController(); logRequest = controller;
    const params = new URLSearchParams({ order: $('log-order').value, limit: '200' });
    const to = effectiveEnd(r.to);
    if (r.from) params.set('from', r.from.toISOString());
    if (to) params.set('to', to.toISOString());
    if (filter.repo) params.set('repo', filter.repo);
    for (const [key, id] of [['issue', 'log-issue'], ['event', 'log-event'], ['result', 'log-result']]) if ($(id).value.trim()) params.set(key, $(id).value.trim());
    if (!$('log-body').firstChild) $('log-body').replaceChildren(stateBox('loading', 'LÄDT', 'Das Log wird gelesen…'));
    try {
      const res = await fetch('/api/v1/history/entries?' + params, { cache: 'no-store', signal: controller.signal });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ? body.error.message : 'HTTP ' + res.status);
      renderLogs(body);
    } catch (error) {
      if (error.name === 'AbortError') return;
      $('log-count').textContent = '';
      $('log-body').replaceChildren(stateBox('error', 'LOG NICHT LADBAR', error.message + ' — die Statistik oben ist nicht betroffen.', loadLogs));
    } finally {
      if (logRequest === controller) logRequest = null;
    }
  }
  function renderLogs(body) {
    options($('log-event'), body.events_available, 'Alle Events', $('log-event').value);
    options($('log-result'), body.results_available, 'Alle Ergebnisse', $('log-result').value);
    for (const o of $('log-event').options) if (o.value) o.textContent = o.value.replace(/_/g, ' ');
    for (const o of $('log-result').options) if (o.value) o.textContent = OUTCOMES[o.value] || o.value;
    $('log-count').textContent = body.truncated ? fmtInt(body.entries.length) + ' von ' + fmtInt(body.total) : fmtInt(body.total);
    if (!body.entries.length) { $('log-body').replaceChildren(noData('Im gewählten Zeitraum passt kein Log-Eintrag zum Filter.')); return; }
    const tbl = el('table'); tbl.id = 'entries'; const wrap = el('div', null, 'scroll'); wrap.append(tbl);
    const nodes = [wrap];
    if (body.truncated) nodes.push(el('p', 'Angezeigt werden die ' + (($('log-order').value === 'asc') ? 'ältesten ' : 'neuesten ') + fmtInt(body.entries.length) + ' Einträge; Zeitraum oder Filter eingrenzen, um den Rest zu sehen.', 'note'));
    $('log-body').replaceChildren(...nodes);
    const columns = [{ label: 'Zeit', className: 'event', render: (r) => fmtTime(r.ts) }];
    if (!filter.repo) columns.push({ label: 'Repository', className: 'nowrap', render: (r) => r.repo || '—' });
    columns.push(
      { label: 'Issue', className: 'event', render: (r) => r.issue || '—' },
      { label: 'Event', className: 'event', render: (r) => chip(r.event.replace(/_/g, ' '), { tone: chipTone(SEVERITY_TONE[logSeverity(r)]), mono: true }) },
      { label: 'Details', render: (r) => el('div', describeLogEntry(r), 'msg') },
    );
    table('entries', columns, body.entries, '');
  }

  // ------------------------------------------------------------------------------------------------------------
  // Wiring

  function loadAll() { view.issueLimit = 25; loadAnalytics(); loadLogs(); }

  $('period').addEventListener('change', () => {
    const period = $('period').value;
    if (period !== 'custom') { setFilter({ period }); return; }
    // Custom starts from the period on screen, so the user only adjusts it.
    const r = range(filter);
    const from = r.from ? isoDate(r.from) : (data && data.period.start ? isoDate(new Date(data.period.start)) : isoDate(new Date()));
    const to = r.to ? isoDate(addDays(r.to, -1)) : isoDate(new Date());
    $('from').value = from; $('to').value = to;
    setFilter({ period: 'custom', from, to });
  });
  $('filters').addEventListener('submit', (event) => { event.preventDefault(); setFilter({ period: 'custom', from: $('from').value, to: $('to').value }); });
  $('repo').addEventListener('change', () => setFilter({ repo: $('repo').value }));
  $('model').addEventListener('change', () => setFilter({ model: $('model').value }));
  $('effort').addEventListener('change', () => setFilter({ effort: $('effort').value }));
  $('log-filters').addEventListener('submit', (event) => { event.preventDefault(); loadLogs(); });
  for (const id of ['log-event', 'log-result', 'log-order']) $(id).addEventListener('change', loadLogs);
  $('reload').addEventListener('click', loadAll);
  for (const [id, key, draw] of [['activity-metric', 'activity', () => renderActivity(data)], ['cost-mode', 'cost', () => renderCost(data)]]) {
    $(id).addEventListener('click', (event) => {
      const button = event.target.closest('button'); if (!button) return;
      view[key] = button.dataset.v;
      for (const b of $(id).querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === button));
      if (data && data.totals.runs) draw();
    });
  }
  for (const [id, draw] of [['model-sort', renderModels], ['repo-sort', renderRepos], ['issue-sort', renderIssues]]) {
    $(id).addEventListener('change', () => { if (data && data.totals.runs) draw(data); });
  }
  // Periods that include now refresh on change events (at most every 10 s) or once a minute while the page is
  // visible; past periods never change.
  function refreshOpen() {
    const r = range(filter);
    if (document.hidden || r.error || (r.to && r.to <= new Date())) return;
    loadAnalytics();
  }
  live(refreshOpen, pollEvery(refreshOpen, 60000), 10000);
  loadAll();
  // Tests load the page in a fake DOM and render a fixture through window.__render.
  if (window.__SYMPHONY_TEST__) window.__render = (d) => { data = d; render(d); };
})();
`,
});
