import { BASE_CSS, BASE_JS } from './styles.ts';

/**
 * Logs page: statistics and recent entries from the per-repository logs (/api/v1/history).
 * The selected repository lives in the URL (?repo=owner/name), so every view can be linked.
 */
export const LOGS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Symphony logs</title>
<style>${BASE_CSS}
  .filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .split { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(420px, 100%), 1fr)); gap: 16px; }
  td.event { white-space: nowrap; }
  td.event .chip[class*="tone-"] { color: var(--tone); border-color: var(--tone-line); background: var(--tone-dim); }
  h2 { margin-bottom: 12px; }
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/" aria-label="Back to the Symphony dashboard">
      <span class="brand-mark" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,12 6,12 8.5,6 11.5,18 14.5,4 17,15 19,12 22,12"/></svg></span>
      <span class="brand-text"><span class="brand-name">SYMPHONY</span><span class="brand-sub">LOGS &amp; STATISTICS</span></span>
    </a>
    <div class="filters">
      <label class="meta" for="repo">Repository</label>
      <select id="repo"><option value="">All repositories</option></select>
      <a class="btn" id="raw" href="#" hidden>Raw log</a>
      <button class="btn" id="reload" type="button">Reload</button>
      <a class="btn btn-primary" href="/">Dashboard</a>
    </div>
  </div>
</header>
<main>
  <section id="problems" class="problems" hidden><h2>Needs attention</h2><ul id="problem-list"></ul></section>
  <div class="stats" id="stats"></div>
  <div class="split">
    <section>
      <h2>Models</h2>
      <div class="scroll"><table id="models"></table></div>
    </section>
    <section id="repos-section">
      <h2>Repositories</h2>
      <div class="scroll"><table id="repos"></table></div>
    </section>
  </div>
  <section>
    <h2>Issues</h2>
    <div class="scroll"><table id="issues"></table></div>
  </section>
  <section>
    <h2>Per day</h2>
    <div class="scroll"><table id="days"></table></div>
  </section>
  <section>
    <h2>Log</h2>
    <div class="scroll"><table id="entries"></table></div>
  </section>
  <p class="meta" id="footer"></p>
</main>
<script>
(() => {
${BASE_JS}

  const select = document.getElementById('repo');
  const selected = () => new URLSearchParams(location.search).get('repo') || '';

  function render(data) {
    const repo = data.repo || '';
    const options = [['', 'All repositories'], ...data.repositories_available.map((r) => [r.repo, r.repo])];
    select.replaceChildren(...options.map(([value, label]) => { const o = el('option', label); o.value = value; return o; }));
    select.value = repo;
    const raw = document.getElementById('raw');
    raw.hidden = repo === '';
    raw.href = '/api/v1/history/raw?repo=' + encodeURIComponent(repo);

    const problems = [];
    if (data.pricing_error) problems.push('model-costs.yml: ' + data.pricing_error + ' (using the previous prices)');
    document.getElementById('problems').hidden = problems.length === 0;
    document.getElementById('problem-list').replaceChildren(...problems.map((p) => el('li', p)));

    const t = data.totals;
    const span = t.first_at ? 'since ' + new Date(t.first_at).toLocaleDateString() : 'no runs yet';
    tiles('stats', [
      ['Est. cost', fmtUsd(t.cost_usd), span],
      ['Tokens', fmtCompact(t.total_tokens), fmtCompact(t.output_tokens) + ' output'],
      ['Agent time', fmtDuration(t.agent_seconds), t.runs ? fmtDuration(t.agent_seconds / t.runs) + ' per run' : ''],
      ['Runs', fmtInt(t.runs), t.runs ? fmtUsd(t.cost_usd / t.runs) + ' per run' : ''],
      ['Issues', fmtInt(t.issues), repo ? repo : fmtInt(t.repositories) + ' repositories'],
    ]);

    const totalCost = t.cost_usd || 0;
    table('models', [
      { label: 'Model', className: 'nowrap', render: (r) => r.model },
      { label: 'Price entry', render: (r) => el('span', r.price, 'chip') },
      { label: 'Runs', className: 'num', render: (r) => fmtInt(r.runs) },
      { label: 'Input', className: 'num', render: (r) => fmtCompact(r.input_tokens) },
      { label: 'Output', className: 'num', render: (r) => fmtCompact(r.output_tokens) },
      { label: 'Cache read', className: 'num', render: (r) => fmtCompact(r.cache_read_tokens) },
      { label: 'Cache write', className: 'num', render: (r) => fmtCompact(r.cache_write_tokens) },
      { label: 'Est. cost', className: 'num', render: (r) => fmtUsd(r.cost_usd) },
      { label: 'Share', className: 'num', render: (r) => (totalCost ? Math.round((r.cost_usd / totalCost) * 100) : 0) + '%' },
    ], data.models, 'No model usage logged yet.');

    document.getElementById('repos-section').hidden = repo !== '';
    table('repos', [
      { label: 'Repository', className: 'nowrap', render: (r) => link(r.repo, '/logs?repo=' + encodeURIComponent(r.repo)) },
      { label: 'Runs', className: 'num', render: (r) => fmtInt(r.runs) },
      { label: 'Issues', className: 'num', render: (r) => fmtInt(r.issues) },
      { label: 'Tokens', className: 'num', render: (r) => fmtCompact(r.total_tokens) },
      { label: 'Est. cost', className: 'num', render: (r) => fmtUsd(r.cost_usd) },
      { label: 'Agent time', className: 'num', render: (r) => fmtDuration(r.agent_seconds) },
      { label: 'Last run', className: 'nowrap', render: (r) => ago(r.last_at) },
    ], data.repositories, 'No runs logged yet.');

    table('issues', [
      { label: 'Issue', render: (r) => { const s = el('span'); s.append(el('div', r.issue), el('div', r.title, 'meta')); return s; } },
      { label: 'Runs', className: 'num', render: (r) => fmtInt(r.runs) },
      { label: 'Last result', render: (r) => el('span', (OUTCOMES[r.last_outcome] || r.last_outcome || '—') + ' → ' + (r.last_state || '—'), 'chip') },
      { label: 'Tokens', className: 'num', render: (r) => fmtCompact(r.total_tokens) },
      { label: 'Est. cost', className: 'num', render: (r) => fmtUsd(r.cost_usd) },
      { label: 'Agent time', className: 'num', render: (r) => fmtDuration(r.agent_seconds) },
      { label: 'First started', render: (r) => fmtTime(r.first_started_at) },
      { label: 'Last finished', render: (r) => fmtTime(r.last_finished_at) },
    ], data.issues, 'No issues processed yet.');

    table('days', [
      { label: 'Date', render: (r) => r.date },
      { label: 'Runs', className: 'num', render: (r) => fmtInt(r.runs) },
      { label: 'Tokens', className: 'num', render: (r) => fmtCompact(r.total_tokens) },
      { label: 'Est. cost', className: 'num', render: (r) => fmtUsd(r.cost_usd) },
      { label: 'Agent time', className: 'num', render: (r) => fmtDuration(r.agent_seconds) },
    ], data.days, 'No runs logged yet.');

    const columns = [{ label: 'Time', className: 'event', render: (r) => fmtTime(r.ts) }];
    if (!repo) columns.push({ label: 'Repository', render: (r) => r.repo });
    columns.push(
      { label: 'Issue', className: 'event', render: (r) => r.issue || '—' },
      { label: 'Event', className: 'event', render: (r) => el('span', r.event.replace(/_/g, ' '), 'chip tone-' + SEVERITY_TONE[logSeverity(r)]) },
      { label: 'Details', render: (r) => el('div', describeLogEntry(r), 'msg') },
    );
    table('entries', columns, data.recent, 'The log is empty.');

    document.getElementById('footer').textContent =
      'Logs: ' + data.history_dir + ' · Prices: ' + data.pricing_file +
      ' (costs are recalculated from the logged tokens with the current prices) · Updated ' + fmtTime(data.generated_at);
  }

  async function load() {
    try {
      const repo = selected();
      const res = await fetch('/api/v1/history' + (repo ? '?repo=' + encodeURIComponent(repo) : ''), { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ? data.error.message : 'HTTP ' + res.status);
      render(data);
    } catch (error) {
      document.getElementById('problems').hidden = false;
      document.getElementById('problem-list').replaceChildren(el('li', 'Cannot load the logs: ' + error.message));
    }
  }
  select.addEventListener('change', () => {
    const url = new URL(location.href);
    if (select.value) url.searchParams.set('repo', select.value); else url.searchParams.delete('repo');
    history.replaceState(null, '', url);
    load();
  });
  document.getElementById('reload').addEventListener('click', load);
  load();
  setInterval(load, 30000);
})();
</script>
</body>
</html>
`;
