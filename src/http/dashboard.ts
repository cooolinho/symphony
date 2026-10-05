import { BASE_CSS, BASE_JS } from './styles.ts';

/**
 * Client-side dashboard: polls /api/v1/state and renders it. All tracker text is inserted with
 * textContent (issue titles and agent messages are untrusted).
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Symphony</title>
<style>${BASE_CSS}</style>
</head>
<body>
<header>
  <h1><span id="health-dot" class="dot"></span>Symphony</h1>
  <div class="meta" id="meta">loading…</div>
  <div class="actions">
    <a class="button" href="/logs">Logs</a>
    <button id="refresh" type="button">Poll now</button>
  </div>
</header>
<main>
  <section id="problems" class="problems" hidden><h2>Needs attention</h2><ul id="problem-list"></ul></section>
  <div class="stats" id="stats"></div>
  <section>
    <h2>Running</h2>
    <div class="scroll"><table id="running"></table></div>
  </section>
  <section>
    <h2>Retry queue</h2>
    <div class="scroll"><table id="retrying"></table></div>
  </section>
  <section>
    <h2>Paused</h2>
    <div class="scroll"><table id="paused"></table></div>
  </section>
</main>
<script>
(() => {
${BASE_JS}

  function render(state) {
    const h = state.health;
    const problems = [];
    if (h.workflow_error) problems.push('WORKFLOW.md: ' + h.workflow_error.message);
    for (const e of h.dispatch_errors) if (!h.workflow_error || !e.startsWith('WORKFLOW.md')) problems.push(e);
    if (h.last_tracker_error) problems.push('Tracker: ' + h.last_tracker_error.message);
    if (h.pricing_error) problems.push('model-costs.yml: ' + h.pricing_error);
    document.getElementById('problems').hidden = problems.length === 0;
    document.getElementById('problem-list').replaceChildren(...problems.map((p) => el('li', p)));
    document.getElementById('health-dot').className = problems.length ? 'dot bad' : 'dot';
    document.getElementById('meta').textContent =
      'workflow v' + h.workflow_version + ' · polls every ' + Math.round(h.poll_interval_ms / 1000) + 's · last poll ' +
      ago(h.last_tick_at) + (h.stopping ? ' · shutting down' : '');

    const t = state.agent_totals;
    tiles('stats', [
      ['Running', state.counts.running + ' / ' + h.max_concurrent_agents],
      ['Retrying', state.counts.retrying],
      ['Paused', state.counts.paused ?? 0],
      ['Tokens', fmtCompact(t.total_tokens), 'since start'],
      ['Est. cost', fmtUsd(t.cost_usd), 'since start'],
      ['Agent time', fmtDuration(t.seconds_running), 'since start'],
    ]);

    table('running', [
      { label: 'Issue', render: (r) => { const s = el('span'); s.append(link(r.issue_identifier, r.issue_url), el('div', r.title, 'meta')); return s; } },
      { label: 'State', render: (r) => el('span', r.stopping ? 'stopping' : r.state, 'chip') },
      { label: 'Role', render: (r) => r.role || '—' },
      { label: 'Phase', render: (r) => r.phase },
      { label: 'Model', render: (r) => r.model || '—' },
      { label: 'Turns', className: 'num', render: (r) => r.turn_count },
      { label: 'Last activity', render: (r) => { const s = el('div', null, 'msg'); s.append(el('div', (r.last_event || '—') + ' · ' + ago(r.last_event_at)), el('div', r.stopping || r.last_message)); return s; } },
      { label: 'Tokens', className: 'num', render: (r) => fmtCompact(r.tokens.total_tokens) },
      { label: 'Est. cost', className: 'num', render: (r) => fmtUsd(r.cost_usd) },
      { label: 'Runtime', className: 'num', render: (r) => fmtDuration(r.seconds_running) },
    ], state.running, 'No agents running.');

    table('retrying', [
      { label: 'Issue', render: (r) => link(r.issue_identifier, r.issue_url) },
      { label: 'Attempt', className: 'num', render: (r) => r.attempt },
      { label: 'Kind', render: (r) => el('span', r.kind, 'chip') },
      { label: 'Due in', className: 'num', render: (r) => fmtDuration(r.due_in_ms / 1000) },
      { label: 'Reason', render: (r) => el('div', r.error || '—', 'msg') },
    ], state.retrying, 'Nothing queued.');

    table('paused', [
      { label: 'Issue', render: (r) => link(r.issue_identifier, r.issue_url) },
      { label: 'State', render: (r) => el('span', r.state, 'chip') },
      { label: 'Continuations', className: 'num', render: (r) => r.continuations },
      { label: 'Paused', render: (r) => ago(r.paused_at) },
      { label: 'Resume', render: () => el('div', 'change the issue on the board (status, comment or labels)', 'msg') },
    ], state.paused ?? [], 'Nothing paused.');
  }

  async function load() {
    try {
      const res = await fetch('/api/v1/state', { cache: 'no-store' });
      render(await res.json());
    } catch (error) {
      document.getElementById('meta').textContent = 'orchestrator unreachable: ' + error.message;
      document.getElementById('health-dot').className = 'dot bad';
    }
  }
  document.getElementById('refresh').addEventListener('click', async () => {
    await fetch('/api/v1/refresh', { method: 'POST' }).catch(() => {});
    setTimeout(load, 500);
  });
  load();
  setInterval(load, 2000);
})();
</script>
</body>
</html>
`;
