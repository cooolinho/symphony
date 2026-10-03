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
<style>
  :root {
    --bg: #f6f7f9; --panel: #ffffff; --text: #1d2330; --muted: #5d6779; --line: #e3e6eb;
    --accent: #3b5bdb; --ok: #2b8a3e; --warn: #c26b00; --bad: #c92a2a; --chip: #eef1f6;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #12151b; --panel: #1a1f27; --text: #e3e7ee; --muted: #98a2b3; --line: #2a313c;
      --accent: #7c95ff; --ok: #5cc072; --warn: #f0a542; --bad: #ff6b6b; --chip: #232a35;
      color-scheme: dark;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between;
    padding: 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
  h1 { font-size: 18px; margin: 0; letter-spacing: .2px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); margin: 0 0 8px; }
  main { padding: 16px; display: grid; gap: 16px; max-width: 1400px; margin: 0 auto; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .stat, section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
  .stat .label { color: var(--muted); font-size: 12px; }
  .stat .value { font-size: 20px; font-variant-numeric: tabular-nums; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 7px 8px; border-top: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; border-top: none; }
  td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .scroll { overflow-x: auto; }
  .chip { display: inline-block; padding: 1px 8px; border-radius: 999px; background: var(--chip); font-size: 12px; white-space: nowrap; }
  .msg { color: var(--muted); max-width: 520px; overflow-wrap: anywhere; }
  .empty { color: var(--muted); padding: 6px 0; }
  .problems { border-color: var(--bad); }
  .problems li { color: var(--bad); }
  .meta { color: var(--muted); font-size: 12px; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  button { font: inherit; border: 1px solid var(--line); background: var(--chip); color: var(--text);
    border-radius: 6px; padding: 6px 12px; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: var(--ok); }
  .dot.bad { background: var(--bad); }
</style>
</head>
<body>
<header>
  <h1><span id="health-dot" class="dot"></span>Symphony</h1>
  <div class="meta" id="meta">loading…</div>
  <button id="refresh" type="button">Poll now</button>
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
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };
  const link = (text, url) => {
    if (typeof url === 'string' && /^https?:\\/\\//.test(url)) {
      const a = el('a', text); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
    }
    return el('span', text);
  };
  const fmtInt = (n) => (n ?? 0).toLocaleString();
  const fmtDuration = (s) => {
    s = Math.max(0, Math.round(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? h + 'h ' + m + 'm' : m ? m + 'm ' + sec + 's' : sec + 's';
  };
  const ago = (iso) => (iso ? fmtDuration((Date.now() - Date.parse(iso)) / 1000) + ' ago' : '—');

  function table(id, columns, rows, emptyText) {
    const t = document.getElementById(id);
    t.replaceChildren();
    if (!rows.length) { const td = el('td', emptyText, 'empty'); const tr = el('tr'); tr.append(td); t.append(tr); return; }
    const head = el('tr');
    for (const c of columns) head.append(el('th', c.label));
    t.append(head);
    for (const row of rows) {
      const tr = el('tr');
      for (const c of columns) {
        const td = el('td', null, c.className);
        const value = c.render(row);
        if (value instanceof Node) td.append(value); else td.textContent = value ?? '';
        tr.append(td);
      }
      t.append(tr);
    }
  }

  function render(state) {
    const h = state.health;
    const problems = [];
    if (h.workflow_error) problems.push('WORKFLOW.md: ' + h.workflow_error.message);
    for (const e of h.dispatch_errors) if (!h.workflow_error || !e.startsWith('WORKFLOW.md')) problems.push(e);
    if (h.last_tracker_error) problems.push('Tracker: ' + h.last_tracker_error.message);
    const box = document.getElementById('problems');
    box.hidden = problems.length === 0;
    document.getElementById('problem-list').replaceChildren(...problems.map((p) => el('li', p)));
    document.getElementById('health-dot').className = problems.length ? 'dot bad' : 'dot';
    document.getElementById('meta').textContent =
      'workflow v' + h.workflow_version + ' · polls every ' + Math.round(h.poll_interval_ms / 1000) + 's · last poll ' +
      ago(h.last_tick_at) + (h.stopping ? ' · shutting down' : '');

    const t = state.agent_totals;
    const stats = [
      ['Running', state.counts.running + ' / ' + h.max_concurrent_agents],
      ['Retrying', state.counts.retrying],
      ['Paused', state.counts.paused ?? 0],
      ['Tokens', fmtInt(t.total_tokens)],
      ['Est. cost', '$' + (t.cost_usd ?? 0).toFixed(2)],
      ['Agent time', fmtDuration(t.seconds_running)],
    ];
    document.getElementById('stats').replaceChildren(...stats.map(([label, value]) => {
      const box = el('div', null, 'stat'); box.append(el('div', label, 'label'), el('div', value, 'value')); return box;
    }));

    table('running', [
      { label: 'Issue', render: (r) => { const s = el('span'); s.append(link(r.issue_identifier, r.issue_url), el('div', r.title, 'meta')); return s; } },
      { label: 'State', render: (r) => el('span', r.stopping ? 'stopping' : r.state, 'chip') },
      { label: 'Phase', render: (r) => r.phase },
      { label: 'Turns', className: 'num', render: (r) => r.turn_count },
      { label: 'Last activity', render: (r) => { const s = el('div', null, 'msg'); s.append(el('div', (r.last_event || '—') + ' · ' + ago(r.last_event_at)), el('div', r.stopping || r.last_message)); return s; } },
      { label: 'Tokens', className: 'num', render: (r) => fmtInt(r.tokens.total_tokens) },
      { label: 'Cost', className: 'num', render: (r) => '$' + (r.cost_usd ?? 0).toFixed(2) },
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
