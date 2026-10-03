/** Shared look of the dashboard pages: tokens, light/dark themes, tiles, tables, controls. */
export const BASE_CSS = `
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
  [hidden] { display: none !important; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between;
    padding: 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
  header .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  h1 { font-size: 18px; margin: 0; letter-spacing: .2px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); margin: 0 0 8px; }
  main { padding: 16px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; max-width: 1400px; margin: 0 auto; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .stat, section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; min-width: 0; }
  .stat .label { color: var(--muted); font-size: 12px; }
  .stat .value { font-size: 22px; font-weight: 600; margin-top: 2px; }
  .stat .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 7px 8px; border-top: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; border-top: none; white-space: nowrap; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.nowrap { white-space: nowrap; }
  .scroll { overflow-x: auto; }
  .chip { display: inline-block; padding: 1px 8px; border-radius: 999px; background: var(--chip); font-size: 12px; white-space: nowrap; }
  .msg { color: var(--muted); max-width: 520px; overflow-wrap: anywhere; }
  .empty { color: var(--muted); padding: 6px 0; }
  .problems { border-color: var(--bad); }
  .problems li { color: var(--bad); }
  .meta { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  button, .button, select { font: inherit; border: 1px solid var(--line); background: var(--chip); color: var(--text);
    border-radius: 6px; padding: 6px 12px; cursor: pointer; }
  .button { display: inline-block; }
  .button:hover { text-decoration: none; }
  button:hover, .button:hover, select:hover { border-color: var(--accent); }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: var(--ok); }
  .dot.bad { background: var(--bad); }
`;

/** Client helpers shared by both pages (plain functions, no framework). */
export const BASE_JS = `
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };
  const link = (text, url) => {
    if (typeof url === 'string' && (/^https?:\\/\\//.test(url) || url.startsWith('/'))) {
      const a = el('a', text); a.href = url;
      if (!url.startsWith('/')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      return a;
    }
    return el('span', text);
  };
  // Numbers use one format everywhere (1,284 / 12.9K / $4.20); dates follow the browser locale.
  const fmtInt = (n) => (n ?? 0).toLocaleString('en-US');
  const fmtCompact = (n) => {
    n = n ?? 0;
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e4) return (n / 1e3).toFixed(1) + 'K';
    return fmtInt(n);
  };
  const fmtUsd = (n) => '$' + (n ?? 0).toFixed((n ?? 0) >= 100 ? 0 : 2);
  const fmtDuration = (s) => {
    s = Math.max(0, Math.round(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? h + 'h ' + m + 'm' : m ? m + 'm ' + sec + 's' : sec + 's';
  };
  const ago = (iso) => (iso ? fmtDuration((Date.now() - Date.parse(iso)) / 1000) + ' ago' : '—');
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

  function table(id, columns, rows, emptyText) {
    const t = document.getElementById(id);
    t.replaceChildren();
    if (!rows.length) { const td = el('td', emptyText, 'empty'); const tr = el('tr'); tr.append(td); t.append(tr); return; }
    const head = el('tr');
    for (const c of columns) head.append(el('th', c.label, c.className));
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

  function tiles(id, items) {
    document.getElementById(id).replaceChildren(...items.map(([label, value, sub]) => {
      const box = el('div', null, 'stat');
      box.append(el('div', label, 'label'), el('div', value, 'value'));
      if (sub) box.append(el('div', sub, 'sub'));
      return box;
    }));
  }
`;
