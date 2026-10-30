import { CHART_CSS, CHART_JS } from './charts.ts';
import { page } from './ui/layout.ts';

const LOGS_CSS = `
  .filterbar { display: grid; gap: 12px; }
  .filter-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
  .filters { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: flex-end; }
  .field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .field > span { font: 600 10px var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
  .field select { min-width: 150px; }
  .custom { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  input[type="date"], input[type="text"] { font: 500 12px var(--mono); color: var(--text); background: var(--panel-2);
    border: 1px solid var(--line-2); border-radius: var(--radius-sm); padding: 6px 10px; color-scheme: dark; min-width: 0; }
  .period { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: baseline; font: 12px var(--mono); color: var(--text-2); }
  .period strong { color: var(--green); font-weight: 600; letter-spacing: .04em; }
  .period .chip.on { border-color: var(--cyan-line); color: var(--cyan); background: var(--cyan-dim); cursor: pointer; }
  .seg { display: inline-flex; border: 1px solid var(--line-2); border-radius: var(--radius-sm); overflow: hidden; }
  .seg button { border: 0; border-radius: 0; padding: 6px 10px; background: transparent; color: var(--muted); font-size: 11px; }
  .seg button + button { border-left: 1px solid var(--line-2); }
  .seg button[aria-pressed="true"] { background: var(--raise); color: var(--green); }
  .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(520px, 100%), 1fr)); gap: 20px; }
  .grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 20px; }
  .stats.primary .stat .value { font-size: 24px; }
  .stats.secondary { grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); }
  .stats.secondary .stat { padding: 9px 12px 9px 14px; }
  .stats.secondary .stat .value { font-size: 16px; margin-top: 3px; }
  .delta { font: 11px var(--mono); color: var(--muted); margin-top: 3px; }
  .delta b { font-weight: 600; color: var(--text-2); }
  .delta.up b { color: var(--cyan); } .delta.down b { color: var(--text-2); }
  .delta.bad b { color: var(--amber); }
  .note { color: var(--muted); font-size: 11.5px; margin: 10px 0 0; }
  .sub-h { font: 600 10.5px var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--muted); margin: 18px 0 10px; }
  .state { display: grid; place-items: center; text-align: center; gap: 6px; padding: 34px 12px; border: 1px dashed var(--line-2);
    border-radius: var(--radius-sm); color: var(--muted); font-size: 12.5px; }
  .state b { font: 600 11px var(--mono); letter-spacing: .2em; color: var(--text-2); }
  .state.error { border-color: var(--red-line); background: var(--red-dim); }
  .state.error b { color: var(--red); }
  .state.loading b { color: var(--green); animation: blink 1.2s steps(2) infinite; }
  @keyframes blink { 50% { opacity: .35; } }
  main.busy [data-section] { opacity: .55; transition: opacity .2s var(--ease); }
  .kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px 16px; margin: 0 0 14px; }
  .kv div { min-width: 0; }
  .kv dt { font: 600 10px var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
  .kv dd { margin: 2px 0 0; font: 600 15px var(--mono); font-variant-numeric: tabular-nums; color: var(--text); overflow-wrap: anywhere; }
  .kv dd small { display: block; font: 400 11px var(--sans); color: var(--muted); }
  .outcomes { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 4px; }
  .outcomes li { display: flex; justify-content: space-between; gap: 12px; font: 12px var(--mono); }
  .outcomes li span:first-child { display: inline-flex; align-items: center; gap: 8px; color: var(--text-2); }
  .outcomes li span:last-child { font-variant-numeric: tabular-nums; }
  .rank { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; counter-reset: rank; }
  .rank li { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; gap: 2px 8px; padding: 5px 6px; margin: 0 -6px;
    border-radius: var(--radius-sm); counter-increment: rank; cursor: pointer; }
  .rank li:hover, .rank li:focus-visible { background: rgba(255, 255, 255, .03); }
  .rank li::before { content: counter(rank); font: 11px var(--mono); color: var(--muted); }
  .rank .who { font: 12px var(--mono); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rank .val { font: 600 12px var(--mono); font-variant-numeric: tabular-nums; text-align: right; }
  .rank .meta { grid-column: 2 / -1; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .attention { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  .attention li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 2px 10px; padding: 8px 10px; cursor: pointer;
    border: 1px solid var(--amber-line); border-radius: var(--radius-sm); background: var(--amber-dim); }
  .attention li.red { border-color: var(--red-line); background: var(--red-dim); }
  .attention .ico { color: var(--amber); font: 600 13px var(--mono); }
  .attention li.red .ico { color: var(--red); }
  .attention .who { font: 12px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .attention .val { font: 600 12px var(--mono); text-align: right; }
  .attention .why { grid-column: 2 / -1; color: var(--text-2); font-size: 11.5px; }
  .int-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 4px 0 12px; }
  .int-head b { font: 600 14px var(--mono); color: var(--text); }
  .int-block + .int-block { margin-top: 18px; padding-top: 14px; border-top: 1px dashed var(--line-2); }
  td.event { white-space: nowrap; }
  td.event .chip[class*="tone-"], .chip[class*="tone-"] { color: var(--tone); border-color: var(--tone-line); background: var(--tone-dim); }
  tr.click { cursor: pointer; }
  .issue-cell .meta { max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-actions { display: flex; gap: 6px; }
  .row-actions .btn, .more { padding: 3px 8px; font-size: 10.5px; }
  .more { margin-top: 10px; }
  @media (max-width: 640px) {
    .field select { min-width: 0; width: 100%; }
    .filters > .field { flex: 1 1 140px; }
    .stats.primary .stat .value { font-size: 19px; }
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
  styles: CHART_CSS + LOGS_CSS,
  body: `
  <section class="filterbar" aria-label="Filter">
    <form class="filters" id="filters">
      <label class="field"><span>Period</span>
        <select id="period">
          <option value="today">Today</option><option value="yesterday">Yesterday</option>
          <option value="7d">Last 7 days</option><option value="14d">Last 14 days</option>
          <option value="30d">Last 30 days</option><option value="90d">Last 90 days</option>
          <option value="month">This month</option><option value="last_month">Last month</option>
          <option value="all">All time</option><option value="custom">Custom range…</option>
        </select>
      </label>
      <div class="field"><span>Custom</span>
        <div class="custom">
          <input type="date" id="from" aria-label="From (inclusive)"> <span class="meta">→</span>
          <input type="date" id="to" aria-label="To (inclusive)">
          <button class="btn btn-primary" type="submit" id="apply">Apply</button>
        </div>
      </div>
      <label class="field"><span>Repository</span><select id="repo"><option value="">All repositories</option></select></label>
      <label class="field"><span>Model</span><select id="model"><option value="">All models</option></select></label>
      <label class="field"><span>Effort</span><select id="effort"><option value="">All efforts</option></select></label>
    </form>
    <div class="filter-foot">
      <div class="period" id="period-label" aria-live="polite"></div>
      <div class="actions">
        <a class="btn" id="raw" href="#" hidden>Raw log</a>
        <button class="btn" id="reload" type="button">Reload</button>
      </div>
    </div>
  </section>

  <section id="problems" class="problems" hidden><h2>Problems</h2><ul id="problem-list"></ul></section>

  <section data-section aria-labelledby="h-kpi">
    <h2 id="h-kpi">Overview</h2>
    <div data-body="kpi"></div>
  </section>

  <section data-section>
    <div class="section-head"><h2>Activity</h2>
      <div class="seg" id="activity-metric" role="group" aria-label="Activity metric">
        <button type="button" data-v="runs" aria-pressed="true">Runs</button><button type="button" data-v="tokens">Tokens</button>
        <button type="button" data-v="cost">Cost</button><button type="button" data-v="time">Agent time</button>
      </div>
    </div>
    <div data-body="activity"></div>
  </section>

  <div class="grid-2">
    <section data-section>
      <div class="section-head"><h2>Estimated cost</h2>
        <div class="seg" id="cost-mode" role="group" aria-label="Cost view">
          <button type="button" data-v="period" aria-pressed="true">Per bucket</button><button type="button" data-v="cumulative">Cumulative</button>
        </div>
      </div>
      <div data-body="cost"></div>
    </section>
    <section data-section>
      <div class="section-head"><h2>Tokens</h2></div>
      <div data-body="tokens"></div>
    </section>
  </div>

  <section data-section>
    <div class="section-head"><h2>Models</h2>
      <label class="field"><span>Sort by</span><select id="model-sort">
        <option value="cost_usd">Total cost</option><option value="runs">Runs</option><option value="total_tokens">Tokens</option>
        <option value="avg_cost_per_run">Avg cost / run</option><option value="avg_tokens_per_run">Avg tokens / run</option>
        <option value="agent_seconds">Agent time</option>
      </select></label>
    </div>
    <div data-body="models"></div>
  </section>

  <section data-section>
    <div class="section-head"><h2>Effort</h2></div>
    <div data-body="efforts"></div>
  </section>

  <section data-section>
    <div class="section-head"><h2>Roles</h2></div>
    <div data-body="roles"></div>
  </section>

  <div class="grid-2">
    <section data-section><h2>Tools</h2><div data-body="tools"></div></section>
    <section data-section><h2>Laravel Boost &amp; integrations</h2><div data-body="integrations"></div></section>
  </div>

  <section data-section>
    <div class="section-head"><h2>Repositories</h2>
      <label class="field"><span>Compare</span><select id="repo-sort">
        <option value="runs">Runs</option><option value="cost_usd">Cost</option><option value="total_tokens">Tokens</option>
        <option value="agent_seconds">Agent time</option>
      </select></label>
    </div>
    <div data-body="repos"></div>
  </section>

  <div class="grid-3">
    <section data-section><h2>Run outcomes</h2><div data-body="outcomes"></div></section>
    <section data-section><h2>Run duration</h2><div data-body="durations"></div></section>
    <section data-section><h2>When Symphony runs</h2><div data-body="heatmap"></div></section>
  </div>

  <div class="grid-2">
    <section data-section><h2>Top runs</h2><div data-body="top"></div></section>
    <section data-section><h2>Needs attention</h2><div data-body="attention"></div></section>
  </div>

  <section data-section>
    <div class="section-head"><h2>Issues <span class="count" id="issue-count"></span></h2>
      <label class="field"><span>Sort</span><select id="issue-sort">
        <option value="cost">Most expensive</option><option value="tokens">Most tokens</option><option value="time">Longest runtime</option>
        <option value="runs">Most runs</option><option value="newest">Newest</option><option value="completed">Recently completed</option>
        <option value="failed">Failed</option>
      </select></label>
    </div>
    <div data-body="issues"></div>
  </section>

  <section id="logs">
    <div class="section-head"><h2>Log <span class="count" id="log-count"></span></h2></div>
    <form class="filters" id="log-filters">
      <label class="field"><span>Issue</span><input type="text" id="log-issue" placeholder="#76 or owner/name#76"></label>
      <label class="field"><span>Event</span><select id="log-event"><option value="">All events</option></select></label>
      <label class="field"><span>Result</span><select id="log-result"><option value="">All results</option></select></label>
      <label class="field"><span>Order</span><select id="log-order"><option value="desc">Newest first</option><option value="asc">Oldest first</option></select></label>
      <button class="btn" type="submit">Filter</button>
    </form>
    <div id="log-body" style="margin-top: 14px"></div>
  </section>
  <p class="meta" id="footer"></p>
`,
  scripts: `
(() => {
${CHART_JS}

  // ------------------------------------------------------------------------------------------------------------
  // Central filter state: everything below reads the period from range() and never computes dates itself.

  const PERIODS = { today: 'Today', yesterday: 'Yesterday', '7d': 'Last 7 days', '14d': 'Last 14 days', '30d': 'Last 30 days',
    '90d': 'Last 90 days', month: 'This month', last_month: 'Last month', all: 'All time', custom: 'Custom range' };
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
        if (!from || !to) return { error: 'Choose a start and an end date.' };
        if (to < from) return { error: 'The end date is before the start date.' };
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
    cost: { label: 'Est. cost', key: 'cost_usd', fmt: fmtUsd, axis: fmtAxisUsd, color: 'var(--green)' },
    time: { label: 'Agent time', key: 'agent_seconds', fmt: fmtDuration, axis: fmtDuration, color: 'var(--cyan)' },
  };
  const OUTCOME_TONE = { handed_off: 'green', continuing: 'cyan', failed: 'red', stalled: 'red', stopped: 'gray', shutdown: 'gray' };
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
    return g === 'week' ? (long ? 'Week of ' : '') + day : day;
  }
  /** Zooming into a bucket narrows the global period to it (day → hourly, week → daily, month → daily). */
  function zoomInto(key, g) {
    if (g === 'hour') return;
    const start = bucketStart(key);
    const end = g === 'day' ? start : g === 'week' ? addDays(start, 6) : new Date(start.getFullYear(), start.getMonth() + 1, 0);
    setFilter({ period: 'custom', from: isoDate(start), to: isoDate(end) });
  }
  const bucketTip = (b) => [['Runs', fmtInt(b.runs)], ['Tokens', fmtCompact(b.total_tokens)], ['Est. cost', fmtUsd(b.cost_usd)], ['Agent time', fmtDuration(b.agent_seconds)]];

  // ------------------------------------------------------------------------------------------------------------
  // Section states

  const bodies = {};
  for (const node of document.querySelectorAll('[data-body]')) bodies[node.dataset.body] = node;
  function stateBox(kind, title, text, retry) {
    const box = el('div', null, 'state ' + kind);
    box.append(el('b', title), el('span', text));
    if (retry) { const b = el('button', 'Retry'); b.type = 'button'; b.className = 'btn'; b.addEventListener('click', retry); box.append(b); }
    return box;
  }
  function setBody(name, ...nodes) {
    for (const host of bodies[name].querySelectorAll('.chart')) unmount(host);
    bodies[name].replaceChildren(...nodes);
  }
  const noData = (text) => stateBox('empty', 'NO DATA', text || 'No agent runs were recorded for the selected period.');

  // ------------------------------------------------------------------------------------------------------------
  // Analytics

  let data = null;
  let analyticsRequest = null;
  const view = { activity: 'runs', cost: 'period', issueLimit: 25 };

  async function loadAnalytics() {
    const r = range(filter);
    renderPeriod(r);
    if (r.error) { for (const name in bodies) setBody(name, stateBox('error', 'INVALID PERIOD', r.error)); return; }
    analyticsRequest?.abort();
    const controller = new AbortController();
    analyticsRequest = controller;
    if (data === null) for (const name in bodies) setBody(name, stateBox('loading', 'LOADING', 'Aggregating the logs…'));
    $('main').classList.add('busy');
    const params = new URLSearchParams({ tz: TZ });
    const to = effectiveEnd(r.to);
    if (r.from) params.set('from', r.from.toISOString());
    if (to) params.set('to', to.toISOString());
    if (filter.repo) params.set('repo', filter.repo);
    if (filter.model) params.set('model', filter.model);
    if (filter.effort) params.set('effort', filter.effort);
    try {
      if (r.from && to && r.from >= to) throw new Error('The period starts in the future.');
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
      for (const name in bodies) setBody(name, stateBox('error', 'CANNOT LOAD STATISTICS', error.message, loadAnalytics));
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
    else if (!r.error) parts.push(el('span', data && data.period.start ? 'since ' + fmtDay(new Date(data.period.start)) : 'everything logged'));
    if (data && !r.error) {
      parts.push(el('span', { hour: 'hourly', day: 'daily', week: 'weekly', month: 'monthly' }[data.period.granularity] + ' buckets', 'meta'));
      if (data.previous) parts.push(el('span', 'compared with ' + fmtDay(new Date(data.previous.from)) + ' → ' + fmtDay(new Date(Date.parse(data.previous.to) - 1)), 'meta'));
    }
    for (const [key, label] of [['repo', 'Repository'], ['model', 'Model'], ['effort', 'Effort']]) {
      if (!filter[key]) continue;
      const chip = el('span', label + ': ' + filter[key] + ' ✕', 'chip on'); chip.tabIndex = 0; chip.setAttribute('role', 'button');
      chip.title = 'Remove the ' + label.toLowerCase() + ' filter';
      const clear = () => setFilter({ [key]: '' });
      chip.addEventListener('click', clear);
      chip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clear(); } });
      parts.push(chip);
    }
    if (filter.model) parts.push(el('span', 'tokens and cost count only this model', 'meta'));
    $('period-label').replaceChildren(...parts);
  }

  function options(select, values, allLabel, current) {
    const list = [...new Set([...values, ...(current ? [current] : [])])];
    select.replaceChildren(...[['', allLabel], ...list.map((v) => [v, v])].map(([value, label]) => { const o = el('option', label); o.value = value; return o; }));
    select.value = current;
  }

  function render(d) {
    renderPeriod(range(filter));
    options($('repo'), d.repositories_available, 'All repositories', filter.repo);
    options($('model'), d.models_available, 'All models', filter.model);
    options($('effort'), d.efforts_available, 'All efforts', filter.effort);
    $('raw').hidden = !filter.repo;
    $('raw').href = '/api/v1/history/raw?repo=' + encodeURIComponent(filter.repo);
    const problems = [];
    if (d.pricing_error) problems.push('model-costs.yml: ' + d.pricing_error + ' (using the previous prices)');
    $('problems').hidden = problems.length === 0;
    $('problem-list').replaceChildren(...problems.map((p) => el('li', p)));
    $('footer').textContent = 'Logs: ' + d.history_dir + ' · Prices: ' + d.pricing_file +
      ' (costs are recalculated from the logged tokens with the current prices) · Time zone: ' + d.period.time_zone + ' · Updated ' + fmtTime(d.generated_at);

    renderKpis(d);
    if (d.totals.runs === 0) {
      for (const name of ['activity', 'cost', 'tokens', 'models', 'efforts', 'roles', 'tools', 'integrations', 'repos', 'outcomes', 'durations', 'heatmap', 'top', 'attention', 'issues']) setBody(name, noData());
      $('issue-count').textContent = '';
      return;
    }
    renderActivity(d); renderCost(d); renderTokens(d); renderModels(d); renderEfforts(d); renderRoles(d); renderTools(d); renderIntegrations(d); renderRepos(d);
    renderOutcomes(d); renderDurations(d); renderHeatmap(d); renderTop(d); renderAttention(d); renderIssues(d);
  }

  /** "↑ 12.4% vs previous period", only when the logs cover the previous period. */
  function delta(current, previous, key, opts) {
    if (!previous) return null;
    const before = previous[key], now = current[key];
    if (before === null || before === undefined || now === null || now === undefined) return null;
    const box = el('div', null, 'delta');
    if (before === 0 && now === 0) { box.append(el('b', '±0'), ' vs previous period'); return box; }
    if (before === 0) { box.append(el('b', 'new'), ' · previous period: 0'); return box; }
    const change = (now - before) / before;
    const up = change > 0;
    box.className = 'delta ' + (Math.abs(change) < 0.0005 ? '' : up ? 'up' : 'down') + (opts && opts.badWhenUp && up && change > 0 ? ' bad' : '');
    box.append(el('b', (Math.abs(change) < 0.0005 ? '±' : up ? '↑ ' : '↓ ') + (Math.abs(change) * 100).toFixed(1) + '%'), ' vs previous period');
    box.title = 'Previous period: ' + (opts && opts.fmt ? opts.fmt(before) : before);
    return box;
  }

  function kpiTile(label, value, sub, deltaNode, tone, hero) {
    const box = el('div', null, 'stat' + (tone ? ' tone-' + tone : '') + (hero ? ' hero' : ''));
    const head = el('div', null, 'label'); head.append(el('span', label));
    box.append(head, el('div', value, 'value'));
    if (sub) box.append(el('div', sub, 'sub'));
    if (deltaNode) box.append(deltaNode);
    return box;
  }

  function renderKpis(d) {
    const t = d.totals, p = d.previous;
    const primary = el('div', null, 'stats primary');
    primary.append(
      kpiTile('Runs', fmtInt(t.runs), fmtInt(t.repositories) + ' repositor' + (t.repositories === 1 ? 'y' : 'ies'), delta(t, p, 'runs', { fmt: fmtInt }), 'green'),
      kpiTile('Issues', fmtInt(t.issues), null, delta(t, p, 'issues', { fmt: fmtInt }), 'green'),
      kpiTile('Tokens', fmtCompact(t.total_tokens), fmtCompact(t.output_tokens) + ' output', delta(t, p, 'total_tokens', { fmt: fmtCompact }), 'cyan'),
      kpiTile('Est. cost', fmtUsd(t.cost_usd), null, delta(t, p, 'cost_usd', { fmt: fmtUsd }), 'green', true),
      kpiTile('Agent time', fmtDuration(t.agent_seconds), null, delta(t, p, 'agent_seconds', { fmt: fmtDuration }), 'cyan'),
      kpiTile('Avg run', orDash(t.avg_run_seconds, fmtDuration), null, delta(t, p, 'avg_run_seconds', { fmt: fmtDuration, badWhenUp: true }), 'cyan'),
    );
    const secondary = el('div', null, 'stats secondary');
    secondary.append(
      kpiTile('Cost / run', orDash(t.avg_cost_per_run, fmtUsd), null, delta(t, p, 'avg_cost_per_run', { fmt: fmtUsd })),
      kpiTile('Tokens / run', orDash(t.avg_tokens_per_run, fmtCompact), null, delta(t, p, 'avg_tokens_per_run', { fmt: fmtCompact })),
      kpiTile('Successful', fmtInt(t.successful), t.runs ? fmtPct(t.successful / t.runs) + ' of runs' : null, null, 'green'),
      kpiTile('Failed', fmtInt(t.failed), t.runs ? fmtPct(t.failure_rate) + ' of runs' : null, delta(t, p, 'failed', { fmt: fmtInt, badWhenUp: true }), t.failed ? 'red' : null),
      kpiTile('Retry rate', fmtPct(t.retry_rate), fmtInt(t.retries) + ' retried run' + (t.retries === 1 ? '' : 's'), null, t.retries ? 'amber' : null),
    );
    if (t.paused !== null) secondary.append(kpiTile('Paused', fmtInt(t.paused), 'issues paused', null, t.paused ? 'amber' : null));
    secondary.style.marginTop = '10px';
    const nodes = [primary, secondary];
    if (t.runs === 0) nodes.push(el('p', 'No agent runs were recorded for the selected period.', 'note'));
    else if (!p && d.period.from) nodes.push(el('p', 'No comparison: the logs do not cover the previous period of the same length.', 'note'));
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
      ariaLabel: metric.label + ' per ' + g,
    });
    if (g !== 'hour') bodies.activity.append(el('p', 'Click a bar to zoom into it.', 'note'));
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
      series: [{ label: 'Est. cost', color: 'var(--green)', values }],
      kind: view.cost === 'cumulative' || d.series.length > 1 ? 'area' : 'bar', fmt: fmtAxisUsd,
      tip: (i) => [...bucketTip(d.series[i]), ['Cumulative', fmtUsd(cumulative[i])]],
      ariaLabel: 'Estimated cost over time',
    });
  }

  function renderTokens(d) {
    const g = d.period.granularity;
    const host = chartHost(); const lg = el('div', null, 'legend');
    setBody('tokens', lg, host);
    const series = [
      { label: 'Input', color: 'var(--cyan)', values: d.series.map((b) => b.input_tokens) },
      { label: 'Output', color: 'var(--green)', values: d.series.map((b) => b.output_tokens) },
      { label: 'Cache read + write', color: 'var(--gray)', values: d.series.map((b) => b.cache_read_tokens + b.cache_write_tokens) },
    ];
    legend(lg, series.map((s) => [s.label, s.color]));
    timeChart(host, {
      labels: d.series.map((b) => bucketLabel(b.key, g)),
      title: (i) => bucketLabel(d.series[i].key, g, true),
      series, kind: 'bar', stacked: true, fmt: fmtCompact,
      tip: (i) => {
        const b = d.series[i];
        return [['Input', fmtCompact(b.input_tokens), 'var(--cyan)'], ['Output', fmtCompact(b.output_tokens), 'var(--green)'],
          ['Cache read', fmtCompact(b.cache_read_tokens), 'var(--gray)'], ['Cache write', fmtCompact(b.cache_write_tokens), 'var(--gray)'],
          ['Total', fmtCompact(b.total_tokens)], ['Runs', fmtInt(b.runs)]];
      },
      ariaLabel: 'Tokens over time, stacked by kind',
    });
  }

  const MODEL_SORT = {
    cost_usd: [fmtUsd, (r) => fmtPct(r.cost_share) + ' of cost'], runs: [fmtInt, null], total_tokens: [fmtCompact, (r) => fmtPct(r.token_share) + ' of tokens'],
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
        ['Cache read', fmtCompact(r.cache_read_tokens)], ['Cache write', fmtCompact(r.cache_write_tokens)], ['Total tokens', fmtCompact(r.total_tokens)],
        ['Est. cost', fmtUsd(r.cost_usd)], ['Agent time', fmtDuration(r.agent_seconds)], ['Price entry', r.price]],
      onClick: () => setFilter({ model: filter.model === r.model ? '' : r.model }),
    })), 'Filter by model');
    const tbl = el('table'); tbl.id = 'models-table';
    const wrap = el('div', null, 'scroll'); wrap.append(tbl);
    setBody('models', bars, el('p', 'Click a model to filter the whole page by it.', 'note'), el('h3', 'Efficiency', 'sub-h'), wrap,
      el('p', 'A run can use several models: runs and tokens count every model used; agent time and average run count the run for its main model (most tokens). Cost per 1M tokens includes cache tokens; output/input compares output with all input tokens incl. cache. A run that ended before any usage was logged counts under the model it was started with (an alias such as "opus" under the reported id of that family), with 0 tokens.', 'note'));
    table('models-table', [
      { label: 'Model', className: 'nowrap', render: (r) => r.model },
      { label: 'Runs', className: 'num', render: (r) => fmtInt(r.runs) },
      { label: 'Input', className: 'num', render: (r) => fmtCompact(r.input_tokens) },
      { label: 'Output', className: 'num', render: (r) => fmtCompact(r.output_tokens) },
      { label: 'Cache r/w', className: 'num', render: (r) => fmtCompact(r.cache_read_tokens) + ' / ' + fmtCompact(r.cache_write_tokens) },
      { label: 'Est. cost', className: 'num', render: (r) => fmtUsd(r.cost_usd) },
      { label: 'Agent time', className: 'num', render: (r) => fmtDuration(r.agent_seconds) },
      { label: 'Avg run', className: 'num', render: (r) => orDash(r.avg_run_seconds, fmtDuration) },
      { label: 'Cost/run', className: 'num', render: (r) => orDash(r.avg_cost_per_run, fmtUsd) },
      { label: 'Tokens/run', className: 'num', render: (r) => orDash(r.avg_tokens_per_run, fmtCompact) },
      { label: 'Cost/1M tok', className: 'num', render: (r) => orDash(r.cost_per_million_tokens, fmtUsd) },
      { label: 'Out/in', className: 'num', render: (r) => fmtRatio(r.output_input_ratio) },
    ], rows, 'No model usage in this period.');
  }

  /** Runs, tokens and cost by the effort requested for the run, with the models that ran at that effort. */
  function renderEfforts(d) {
    const rows = d.efforts;
    const bars = el('div', null, 'hbars');
    hbars(bars, rows.map((r) => ({
      label: r.effort, value: r.cost_usd || 0, text: fmtUsd(r.cost_usd), sub: fmtInt(r.runs) + ' run' + (r.runs === 1 ? '' : 's') + (r.cost_share !== null ? ' · ' + fmtPct(r.cost_share) + ' of cost' : ''),
      color: filter.effort === r.effort ? 'var(--green)' : 'var(--amber)', active: filter.effort === r.effort,
      tip: [['Runs', fmtInt(r.runs)], ['Successful', fmtInt(r.successful)], ['Failed', fmtInt(r.failed)], ['Tokens', fmtCompact(r.total_tokens)],
        ['Est. cost', fmtUsd(r.cost_usd)], ['Agent time', fmtDuration(r.agent_seconds)], ['Models', countsText(r.models) || '—']],
      onClick: () => setFilter({ effort: filter.effort === r.effort ? '' : r.effort }),
    })), 'Filter by effort');
    const tbl = el('table'); tbl.id = 'efforts-table';
    const wrap = el('div', null, 'scroll'); wrap.append(tbl);
    setBody('efforts', bars, el('p', 'Click an effort to filter the whole page by it.', 'note'), wrap,
      el('p', 'The effort requested for the run: the label Effort: …, else the role\\'s effort or CLAUDE_EFFORT; "default" means Claude Code\\'s own default. Runs logged before the effort was recorded count as "unknown". Models: the main model of the runs at this effort.', 'note'));
    table('efforts-table', [
      { label: 'Effort', className: 'nowrap', render: (r) => r.effort },
      { label: 'Runs', className: 'num', render: (r) => fmtInt(r.runs) },
      { label: 'Successful', className: 'num', render: (r) => fmtInt(r.successful) + (r.success_rate !== null ? ' (' + fmtPct(r.success_rate) + ')' : '') },
      { label: 'Failed', className: 'num', render: (r) => fmtInt(r.failed) },
      { label: 'Tokens', className: 'num', render: (r) => fmtCompact(r.total_tokens) },
      { label: 'Est. cost', className: 'num', render: (r) => fmtUsd(r.cost_usd) },
      { label: 'Agent time', className: 'num', render: (r) => fmtDuration(r.agent_seconds) },
      { label: 'Avg run', className: 'num', render: (r) => orDash(r.avg_run_seconds, fmtDuration) },
      { label: 'Cost/run', className: 'num', render: (r) => orDash(r.avg_cost_per_run, fmtUsd) },
      { label: 'Tokens/run', className: 'num', render: (r) => orDash(r.avg_tokens_per_run, fmtCompact) },
      { label: 'Models', render: (r) => countsText(r.models) || '—' },
    ], rows, 'No runs in this period.');
  }

  /** Runs, tokens, cost, agent time and outcomes by the agent role that served the run. */
  function renderRoles(d) {
    const rows = d.by_role;
    const bars = el('div', null, 'hbars');
    hbars(bars, rows.map((r) => ({
      label: r.role, value: r.cost_usd || 0, text: fmtUsd(r.cost_usd), sub: fmtInt(r.runs) + ' run' + (r.runs === 1 ? '' : 's') + (r.cost_share !== null ? ' · ' + fmtPct(r.cost_share) + ' of cost' : ''),
      color: 'var(--amber)',
      tip: [['Runs', fmtInt(r.runs)], ['Issues', fmtInt(r.issues)], ['Successful', fmtInt(r.successful)], ['Failed', fmtInt(r.failed)], ['Tokens', fmtCompact(r.total_tokens)],
        ['Est. cost', fmtUsd(r.cost_usd)], ['Agent time', fmtDuration(r.agent_seconds)], ['Outcomes', countsText(r.by_outcome) || '—']],
    })), null);
    const tbl = el('table'); tbl.id = 'roles-table';
    const wrap = el('div', null, 'scroll'); wrap.append(tbl);
    setBody('roles', bars, wrap,
      el('p', 'The role that served the run (the stage of the issue pipeline). Runs logged before the role was recorded count as "unknown".', 'note'));
    table('roles-table', [
      { label: 'Role', className: 'nowrap', render: (r) => r.role },
      { label: 'Runs', className: 'num', render: (r) => fmtInt(r.runs) },
      { label: 'Issues', className: 'num', render: (r) => fmtInt(r.issues) },
      { label: 'Successful', className: 'num', render: (r) => fmtInt(r.successful) + (r.success_rate !== null ? ' (' + fmtPct(r.success_rate) + ')' : '') },
      { label: 'Failed', className: 'num', render: (r) => fmtInt(r.failed) },
      { label: 'Tokens', className: 'num', render: (r) => fmtCompact(r.total_tokens) },
      { label: 'Est. cost', className: 'num', render: (r) => fmtUsd(r.cost_usd) + (r.cost_share !== null ? ' (' + fmtPct(r.cost_share) + ')' : '') },
      { label: 'Agent time', className: 'num', render: (r) => fmtDuration(r.agent_seconds) },
      { label: 'Avg run', className: 'num', render: (r) => orDash(r.avg_run_seconds, fmtDuration) },
      { label: 'Cost/run', className: 'num', render: (r) => orDash(r.avg_cost_per_run, fmtUsd) },
      { label: 'Outcomes', render: (r) => countsText(r.by_outcome) || '—' },
    ], rows, 'No runs in this period.');
  }

  function statList(items) {
    const kv = el('dl', null, 'kv');
    for (const [label, value, note] of items) { const box = el('div'); const dd = el('dd', value); if (note) dd.append(el('small', note)); box.append(el('dt', label), dd); kv.append(box); }
    return kv;
  }
  const TOOL_NOTE = 'Tool calls are logged per run since Symphony records them; older runs count as runs without tool calls.';

  /** Calls per tool (built-in and MCP) and per skill in the period. */
  function renderTools(d) {
    const t = d.tools;
    if (!t.calls) { setBody('tools', stateBox('empty', 'NO TOOL CALLS', 'No run in this period logged tool calls.'), el('p', TOOL_NOTE, 'note')); return; }
    const kv = statList([
      ['Tool calls', fmtInt(t.calls)],
      ['Runs with calls', fmtInt(t.runs_with_calls), 'of ' + fmtInt(t.runs) + ' runs'],
      ['Calls / run', orDash(t.avg_calls_per_run, (v) => String(v))],
      ['Distinct tools', fmtInt(t.distinct_tools)],
    ]);
    const bars = el('div', null, 'hbars');
    hbars(bars, t.tools.slice(0, 15).map((r) => ({
      label: r.server ? r.server + ' · ' + r.name : r.name, value: r.calls, text: fmtInt(r.calls), sub: fmtPct(r.calls / t.calls),
      color: r.server ? 'var(--cyan)' : 'var(--green)', tip: [['Calls', fmtInt(r.calls)], ['Runs', fmtInt(r.runs)], ['Tool', r.tool]],
    })));
    const nodes = [kv, el('h3', 'Most used tools', 'sub-h'), bars];
    if (t.skills.length) {
      const skills = el('div', null, 'hbars');
      hbars(skills, t.skills.slice(0, 10).map((r) => ({ label: r.skill, value: r.calls, text: fmtInt(r.calls), sub: fmtInt(r.runs) + ' run' + (r.runs === 1 ? '' : 's'), color: 'var(--amber)', tip: [['Loaded', fmtInt(r.calls) + '×'], ['Runs', fmtInt(r.runs)]] })));
      nodes.push(el('h3', 'Skills loaded', 'sub-h'), skills);
    }
    if (t.agents && t.agents.length) {
      const agents = el('div', null, 'hbars');
      hbars(agents, t.agents.slice(0, 10).map((r) => ({ label: r.agent, value: r.calls, text: fmtInt(r.calls), sub: fmtInt(r.runs) + ' run' + (r.runs === 1 ? '' : 's'), color: 'var(--violet, var(--cyan))', tip: [['Started', fmtInt(r.calls) + '×'], ['Runs', fmtInt(r.runs)]] })));
      nodes.push(el('h3', 'Subagents used', 'sub-h'), agents);
    }
    nodes.push(el('p', 'Green: built-in tools, cyan: MCP tools (server · tool). Subagents count the Agent tool calls by subagent type. ' + TOOL_NOTE, 'note'));
    setBody('tools', ...nodes);
  }

  /** Per integration (e.g. Laravel Boost): runs it was ready in, runs that used it, and its tools and skills. */
  function renderIntegrations(d) {
    const list = d.tools.integrations;
    if (!list.length) {
      setBody('integrations', stateBox('empty', 'NO INTEGRATIONS', 'No run in this period worked on a project with a workspace integration such as Laravel Boost.'));
      return;
    }
    const nodes = list.map((x) => {
      const box = el('div', null, 'int-block');
      const head = el('div', null, 'int-head');
      head.append(integrationIcon(x.id, 22, x.ready_runs === 0), el('b', integrationLabel(x.id)));
      const statuses = Object.entries(x.by_status).sort((a, b) => b[1] - a[1]);
      for (const [status, n] of statuses) { const s = INTEGRATION_STATUS[status] || [status, 'gray']; head.append(badge(s[0] + ' ' + fmtInt(n), s[1], false)); }
      const kv = statList([
        ['Runs', fmtInt(x.runs), 'on projects that use it'],
        ['Ready', fmtInt(x.ready_runs), 'available to the agent'],
        ['Used', fmtInt(x.used_runs), x.use_rate === null ? null : fmtPct(x.use_rate) + ' of ready runs'],
        ['Calls', fmtInt(x.calls), x.avg_calls_per_used_run === null ? null : x.avg_calls_per_used_run + ' per using run'],
      ]);
      box.append(head, kv);
      if (x.tools.length) {
        const bars = el('div', null, 'hbars');
        hbars(bars, x.tools.map((r) => ({ label: r.tool, value: r.calls, text: fmtInt(r.calls), sub: fmtInt(r.runs) + ' run' + (r.runs === 1 ? '' : 's'), color: 'rgb(178, 159, 244)', tip: [['Calls', fmtInt(r.calls)], ['Runs', fmtInt(r.runs)]] })));
        box.append(el('h3', 'MCP tools', 'sub-h'), bars);
      }
      if (x.skills.length) {
        const bars = el('div', null, 'hbars');
        hbars(bars, x.skills.map((r) => ({ label: r.skill, value: r.calls, text: fmtInt(r.calls), sub: fmtInt(r.runs) + ' run' + (r.runs === 1 ? '' : 's'), color: 'var(--amber)', tip: [['Loaded', fmtInt(r.calls) + '×'], ['Runs', fmtInt(r.runs)]] })));
        box.append(el('h3', 'Skills', 'sub-h'), bars);
      }
      if (!x.calls) box.append(el('p', x.ready_runs ? 'Available, but no agent called its tools or skills in this period.' : 'Not available to the agents in this period.', 'note'));
      return box;
    });
    setBody('integrations', ...nodes, el('p', 'Ready: the integration was set up for the session. Used: the agent called at least one of its MCP tools or loaded one of its skills. Guidelines are part of every ready session and are not counted.', 'note'));
  }

  const REPO_METRIC = { runs: [fmtInt, 'runs'], cost_usd: [fmtUsd, 'cost'], total_tokens: [fmtCompact, 'tokens'], agent_seconds: [fmtDuration, 'time'] };
  function renderRepos(d) {
    const key = $('repo-sort').value;
    const [fmt, metricName] = REPO_METRIC[key];
    const rows = [...d.repositories].sort((a, b) => b[key] - a[key]);
    const total = rows.reduce((sum, r) => sum + r[key], 0);
    const bars = el('div', null, 'hbars');
    hbars(bars, rows.map((r) => ({
      label: r.repo, value: r[key], text: fmt(r[key]), sub: total ? fmtPct(r[key] / total) : null,
      color: 'var(--green)', active: filter.repo.toLowerCase() === r.repo.toLowerCase(),
      tip: [['Runs', fmtInt(r.runs)], ['Issues', fmtInt(r.issues)], ['Tokens', fmtCompact(r.total_tokens)], ['Est. cost', fmtUsd(r.cost_usd)], ['Agent time', fmtDuration(r.agent_seconds)]],
      onClick: () => setFilter({ repo: filter.repo.toLowerCase() === r.repo.toLowerCase() ? '' : r.repo }),
    })), 'Filter by repository');

    // Activity over time, stacked: the three busiest repositories plus "Other".
    const g = d.period.granularity;
    const metric = METRICS[REPO_METRIC[key][1]];
    const leaders = rows.slice(0, 3).map((r) => r.repo);
    const series = leaders.map((repo, i) => ({ label: repo, color: SERIES_COLORS[i], values: d.series.map((b) => (b.by_repo[repo] || {})[metric.key] || 0) }));
    if (rows.length > 3) series.push({ label: 'Other', color: SERIES_COLORS[3], values: d.series.map((b) => Object.entries(b.by_repo).filter(([r]) => !leaders.includes(r)).reduce((s, [, v]) => s + (v[metric.key] || 0), 0)) });
    const lg = el('div', null, 'legend'); const host = chartHost();
    const tbl = el('table'); tbl.id = 'repos-table'; const wrap = el('div', null, 'scroll'); wrap.append(tbl);
    const grid = el('div', null, 'grid-2');
    const left = el('div'); left.append(el('h3', 'By ' + metricName, 'sub-h'), bars, el('p', 'Click a repository to filter the whole page by it.', 'note'));
    const right = el('div'); right.append(el('h3', metric.label + ' over time', 'sub-h'), lg, host);
    grid.append(left, right);
    setBody('repos', grid, wrap);
    legend(lg, series.map((s) => [s.label, s.color]));
    timeChart(host, {
      labels: d.series.map((b) => bucketLabel(b.key, g)),
      title: (i) => bucketLabel(d.series[i].key, g, true),
      series, kind: 'bar', stacked: true, fmt: metric.axis, height: 200, integer: key === 'runs',
      tip: (i) => series.filter((s) => s.values[i] > 0).map((s) => [shortRepo(s.label), metric.fmt(s.values[i]), s.color]).concat([['Total', metric.fmt(d.series[i][metric.key])]]),
      ariaLabel: metric.label + ' by repository over time',
    });
    table('repos-table', [
      { label: 'Repository', className: 'nowrap', render: (r) => r.repo },
      { label: 'Runs', className: 'num', render: (r) => fmtInt(r.runs) },
      { label: 'Issues', className: 'num', render: (r) => fmtInt(r.issues) },
      { label: 'Tokens', className: 'num', render: (r) => fmtCompact(r.total_tokens) },
      { label: 'Est. cost', className: 'num', render: (r) => fmtUsd(r.cost_usd) },
      { label: 'Agent time', className: 'num', render: (r) => fmtDuration(r.agent_seconds) },
      { label: 'Avg run', className: 'num', render: (r) => orDash(r.avg_run_seconds, fmtDuration) },
      { label: 'Cost/run', className: 'num', render: (r) => orDash(r.avg_cost_per_run, fmtUsd) },
      { label: 'Last activity', className: 'nowrap', render: (r) => { const s = el('span', ago(r.last_at)); s.title = fmtTime(r.last_at); return s; } },
    ], rows, 'No runs in this period.');
  }

  function renderOutcomes(d) {
    const o = d.outcomes, t = d.totals;
    const other = t.runs - o.successful - o.failed - o.stopped;
    const parts = [
      { label: '✓ Successful (handed off, continuing)', value: o.successful, color: 'var(--green)' },
      { label: '✕ Failed (failed, stalled)', value: o.failed, color: 'var(--red)' },
      { label: '■ Stopped (stopped, shutdown)', value: o.stopped, color: 'var(--gray)' },
      { label: '? Other', value: other, color: 'var(--faint)' },
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
    li('↻ Retried runs (after a failed/stalled run)', fmtInt(o.retried) + ' · ' + fmtPct(t.retry_rate));
    if (o.paused !== null) li('⏸ Issues paused', fmtInt(o.paused));
    const host = chartHost();
    const g = d.period.granularity;
    const series = [
      { label: 'Successful', color: 'var(--green)', values: d.series.map((b) => b.successful) },
      { label: 'Failed', color: 'var(--red)', values: d.series.map((b) => b.failed) },
      { label: 'Stopped', color: 'var(--gray)', values: d.series.map((b) => b.stopped) },
      { label: 'Other', color: 'var(--faint)', values: d.series.map((b) => b.runs - b.successful - b.failed - b.stopped) },
    ];
    setBody('outcomes', bar, list, extra, el('h3', 'Trend', 'sub-h'), host);
    timeChart(host, {
      labels: d.series.map((b) => bucketLabel(b.key, g)),
      title: (i) => bucketLabel(d.series[i].key, g, true),
      series, kind: 'bar', stacked: true, fmt: fmtCompact, height: 150, integer: true,
      tip: (i) => { const b = d.series[i]; return series.map((s) => [s.label, fmtInt(s.values[i]), s.color]).concat([['Retried', fmtInt(b.retries)], ['Success rate', b.runs ? fmtPct(b.successful / b.runs) : '—']]); },
      ariaLabel: 'Run outcomes over time',
    });
  }

  function renderDurations(d) {
    const s = d.durations;
    const kv = el('dl', null, 'kv');
    const item = (label, value, note) => { const box = el('div'); const dd = el('dd', value); if (note) dd.append(el('small', note)); box.append(el('dt', label), dd); kv.append(box); };
    item('Average', orDash(s.avg_seconds, fmtDuration));
    item('Median (p50)', orDash(s.p50_seconds, fmtDuration), s.p50_seconds === null ? 'needs ≥ 3 runs' : null);
    item('p90 / p95', s.p90_seconds === null ? '—' : fmtDuration(s.p90_seconds) + ' / ' + fmtDuration(s.p95_seconds), s.p90_seconds === null ? 'needs ≥ 20 runs' : null);
    item('Shortest', orDash(s.min_seconds, fmtDuration), s.shortest ? s.shortest.issue : null);
    item('Longest', orDash(s.max_seconds, fmtDuration), s.longest ? s.longest.issue : null);
    item('Total agent time', fmtDuration(s.total_seconds));
    const bars = el('div', null, 'hbars');
    hbars(bars, s.histogram.map((b, i) => ({
      label: b.label, value: b.runs, text: fmtInt(b.runs), sub: s.runs ? fmtPct(b.runs / s.runs) : null,
      color: i >= 4 ? 'var(--amber)' : 'var(--cyan)', tip: [['Runs', fmtInt(b.runs)], ['Share', s.runs ? fmtPct(b.runs / s.runs) : '—']],
    })));
    const host = chartHost();
    const g = d.period.granularity;
    setBody('durations', kv, el('h3', 'Distribution', 'sub-h'), bars, el('h3', 'Average run over time', 'sub-h'), host);
    timeChart(host, {
      labels: d.series.map((b) => bucketLabel(b.key, g)),
      title: (i) => bucketLabel(d.series[i].key, g, true),
      series: [{ label: 'Avg run', color: 'var(--cyan)', values: d.series.map((b) => b.avg_run_seconds || 0) }],
      kind: 'bar', fmt: fmtDuration, height: 130,
      tip: (i) => [['Avg run', orDash(d.series[i].avg_run_seconds, fmtDuration)], ['Runs', fmtInt(d.series[i].runs)], ['Agent time', fmtDuration(d.series[i].agent_seconds)]],
      ariaLabel: 'Average run duration over time',
    });
  }

  function renderHeatmap(d) {
    if (!d.heatmap.max) { setBody('heatmap', noData()); return; }
    const host = el('div');
    setBody('heatmap', host, el('p', 'Run starts by weekday and hour (' + d.period.time_zone + '). Darker cells had more starts; the busiest had ' + fmtInt(d.heatmap.max) + '.', 'note'));
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
    node.tabIndex = 0; node.setAttribute('role', 'button'); node.title = 'Show the log of ' + issue;
    node.addEventListener('click', () => showIssueLog(issue));
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showIssueLog(issue); } });
  }
  function rankList(rows, value, meta) {
    if (!rows.length) return el('p', 'Nothing in this period.', 'empty');
    const list = el('ol', null, 'rank');
    for (const r of rows) {
      const li = el('li'); li.append(el('span', r.issue + (r.title ? ' — ' + r.title : ''), 'who'), el('span', value(r), 'val'), el('span', meta(r), 'meta'));
      clickable(li, r.issue); list.append(li);
    }
    return list;
  }
  function renderTop(d) {
    const runMeta = (r) => [r.repo, r.model, r.effort && r.effort !== 'default' ? 'effort ' + r.effort : null, fmtTime(r.finished_at), OUTCOMES[r.outcome] || r.outcome].filter(Boolean).join(' · ');
    const grid = el('div', null, 'grid-2');
    grid.style.gap = '4px 20px';
    const block = (title, node) => { const box = el('div'); box.append(el('h3', title, 'sub-h'), node); return box; };
    grid.append(
      block('Top cost', rankList(d.top.cost, (r) => fmtUsd(r.cost_usd), runMeta)),
      block('Top token usage', rankList(d.top.tokens, (r) => fmtCompact(r.total_tokens), runMeta)),
      block('Longest runs', rankList(d.top.duration, (r) => fmtDuration(r.agent_seconds), runMeta)),
      block('Most expensive issue pipelines', rankList(d.top.pipelines, (r) => fmtUsd(r.cost_usd),
        (r) => r.repo + ' · ' + fmtInt(r.runs) + ' runs · ' + Object.entries(r.roles).map(([role, v]) => role + ' ' + fmtUsd(v.cost_usd)).join(', '))),
      block('Most retried issues', rankList(d.top.retried, (r) => fmtInt(r.retries) + '×', (r) => r.repo + ' · ' + fmtInt(r.runs) + ' runs · ' + fmtInt(r.failed) + ' failed')),
    );
    setBody('top', grid, el('p', 'Click an entry to see its log.', 'note'));
  }

  function renderAttention(d) {
    const rules = d.attention.rules;
    const ruleText = 'Flags single runs with at least ' + rules.factor + '× the period\\'s average run cost, duration or tokens (needs ≥ ' + rules.minRuns +
      ' runs), and issues with ≥ ' + rules.repeated + ' failed or retried runs.';
    if (!d.attention.items.length) {
      setBody('attention', stateBox('empty', 'ALL CLEAR', d.totals.runs < rules.minRuns ? 'Too few runs for averages; only repeated failures are checked.' : 'Nothing unusual in this period.'), el('p', ruleText, 'note'));
      return;
    }
    const list = el('ul', null, 'attention');
    for (const a of d.attention.items) {
      const red = a.kind === 'failures';
      const li = el('li', null, red ? 'red' : '');
      const value = a.kind === 'cost' ? fmtUsd(a.value) : a.kind === 'duration' ? fmtDuration(a.value) : a.kind === 'tokens' ? fmtCompact(a.value) : fmtInt(a.value) + '×';
      const avg = a.kind === 'cost' ? fmtUsd(a.average) : a.kind === 'duration' ? fmtDuration(a.average) : fmtCompact(a.average);
      const why = { cost: a.factor + '× average run cost (' + avg + ')', duration: a.factor + '× average runtime (' + avg + ')',
        tokens: a.factor + '× average tokens per run (' + avg + ')', failures: a.value + ' failed runs in this period', retries: a.value + ' retried runs in this period' }[a.kind];
      li.append(el('span', red ? '✕' : '⚠', 'ico'), el('span', a.issue + (a.title ? ' — ' + a.title : ''), 'who'), el('span', value, 'val'),
        el('span', why + (a.at ? ' · ' + fmtTime(a.at) : ''), 'why'));
      clickable(li, a.issue); list.append(li);
    }
    const nodes = [list];
    if (d.attention.total > d.attention.items.length) nodes.push(el('p', (d.attention.total - d.attention.items.length) + ' more not shown.', 'note'));
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
      const more = el('button', 'Show all ' + fmtInt(rows.length), 'btn more'); more.type = 'button';
      more.addEventListener('click', () => { view.issueLimit = Infinity; renderIssues(data); });
      nodes.push(more);
    }
    setBody('issues', ...nodes);
    const columns = [{ label: 'Issue', className: 'issue-cell', render: (r) => { const s = el('div'); s.append(el('div', r.issue, 'mono'), el('div', r.title, 'meta')); s.title = r.title; return s; } }];
    if (!filter.repo) columns.push({ label: 'Repository', className: 'nowrap', render: (r) => shortRepo(r.repo) });
    columns.push(
      { label: 'Runs', className: 'num', render: (r) => fmtInt(r.runs) + (r.failed ? ' (' + r.failed + ' ✕)' : '') },
      { label: 'Result', className: 'event', render: (r) => el('span', (OUTCOMES[r.last_outcome] || r.last_outcome || '—') + ' → ' + (r.last_state || '—'), 'chip tone-' + (OUTCOME_TONE[r.last_outcome] || 'gray')) },
      { label: 'Tokens', className: 'num', render: (r) => fmtCompact(r.total_tokens) },
      { label: 'Est. cost', className: 'num', render: (r) => fmtUsd(r.cost_usd) },
      { label: 'Cost by role', render: (r) => Object.entries(r.roles).map(([role, v]) => role + ' ' + fmtUsd(v.cost_usd)).join(', ') || '—' },
      { label: 'Agent time', className: 'num', render: (r) => fmtDuration(r.agent_seconds) },
      { label: 'First started', className: 'nowrap', render: (r) => fmtTime(r.first_started_at) },
      { label: 'Last finished', className: 'nowrap', render: (r) => fmtTime(r.last_finished_at) },
      { label: '', render: (r) => {
        const box = el('div', null, 'row-actions');
        const log = el('button', 'Log', 'btn'); log.type = 'button'; log.title = 'Show the log entries of ' + r.issue;
        log.addEventListener('click', () => showIssueLog(r.issue));
        const agent = link('Detail', '/issue?id=' + encodeURIComponent(r.issue)); agent.className = 'btn';
        agent.title = 'Agent detail view: timeline, sessions and transcripts of the last claim, kept after the issue finished';
        box.append(log, agent); return box;
      } },
    );
    table('issues-table', columns, rows.slice(0, view.issueLimit), sort === 'failed' ? 'No issue had a failed run in this period.' : 'No issues in this period.');
  }

  // ------------------------------------------------------------------------------------------------------------
  // Log entries: loaded independently, so an error here never hides the statistics.

  let logRequest = null;
  async function loadLogs() {
    const r = range(filter);
    if (r.error) { $('log-body').replaceChildren(stateBox('error', 'INVALID PERIOD', r.error)); return; }
    logRequest?.abort();
    const controller = new AbortController(); logRequest = controller;
    const params = new URLSearchParams({ order: $('log-order').value, limit: '200' });
    const to = effectiveEnd(r.to);
    if (r.from) params.set('from', r.from.toISOString());
    if (to) params.set('to', to.toISOString());
    if (filter.repo) params.set('repo', filter.repo);
    for (const [key, id] of [['issue', 'log-issue'], ['event', 'log-event'], ['result', 'log-result']]) if ($(id).value.trim()) params.set(key, $(id).value.trim());
    if (!$('log-body').firstChild) $('log-body').replaceChildren(stateBox('loading', 'LOADING', 'Reading the log…'));
    try {
      const res = await fetch('/api/v1/history/entries?' + params, { cache: 'no-store', signal: controller.signal });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ? body.error.message : 'HTTP ' + res.status);
      renderLogs(body);
    } catch (error) {
      if (error.name === 'AbortError') return;
      $('log-count').textContent = '';
      $('log-body').replaceChildren(stateBox('error', 'CANNOT LOAD THE LOG', error.message + ' — the statistics above are not affected.', loadLogs));
    } finally {
      if (logRequest === controller) logRequest = null;
    }
  }
  function renderLogs(body) {
    options($('log-event'), body.events_available, 'All events', $('log-event').value);
    options($('log-result'), body.results_available, 'All results', $('log-result').value);
    for (const o of $('log-event').options) if (o.value) o.textContent = o.value.replace(/_/g, ' ');
    for (const o of $('log-result').options) if (o.value) o.textContent = OUTCOMES[o.value] || o.value;
    $('log-count').textContent = body.truncated ? fmtInt(body.entries.length) + ' of ' + fmtInt(body.total) : fmtInt(body.total);
    if (!body.entries.length) { $('log-body').replaceChildren(noData('No log entries match the filter in the selected period.')); return; }
    const tbl = el('table'); tbl.id = 'entries'; const wrap = el('div', null, 'scroll'); wrap.append(tbl);
    const nodes = [wrap];
    if (body.truncated) nodes.push(el('p', 'Showing the ' + (($('log-order').value === 'asc') ? 'oldest ' : 'newest ') + fmtInt(body.entries.length) + ' entries; narrow the period or filter to see the rest.', 'note'));
    $('log-body').replaceChildren(...nodes);
    const columns = [{ label: 'Time', className: 'event', render: (r) => fmtTime(r.ts) }];
    if (!filter.repo) columns.push({ label: 'Repository', className: 'nowrap', render: (r) => r.repo || '—' });
    columns.push(
      { label: 'Issue', className: 'event', render: (r) => r.issue || '—' },
      { label: 'Event', className: 'event', render: (r) => el('span', r.event.replace(/_/g, ' '), 'chip tone-' + SEVERITY_TONE[logSeverity(r)]) },
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
  // Periods that include now refresh once a minute while the page is visible; past periods never change.
  setInterval(() => {
    const r = range(filter);
    if (document.hidden || r.error || (r.to && r.to <= new Date())) return;
    loadAnalytics();
  }, 60000);
  loadAll();
})();
`,
});
