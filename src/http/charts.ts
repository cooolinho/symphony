/**
 * Small chart kit for the statistics page: plain SVG/HTML, no library. Every color is a token of the shell
 * (green = activity/success, cyan = information, amber = warning, red = failure, gray = secondary, --role-* for roles,
 * --st-* for status tones); series that only need an identity use the fixed order green, cyan, violet, gray ("Other"
 * is always gray).
 */
export const CHART_CSS = `
  .chart { position: relative; width: 100%; min-width: 0; }
  .chart svg { display: block; width: 100%; overflow: visible; }
  .chart .axis text, .chart .tick { font: 10px var(--mono); fill: var(--muted); font-variant-numeric: tabular-nums; }
  .chart .grid line { stroke: var(--line); stroke-width: 1; }
  .chart .base { stroke: var(--line-2); stroke-width: 1; }
  .chart .band { fill: transparent; cursor: default; }
  .chart .band.click { cursor: zoom-in; }
  .chart .hover-band { fill: var(--glass-in); pointer-events: none; }
  .chart .cross { stroke: var(--faint); stroke-width: 1; stroke-dasharray: 3 3; pointer-events: none; }
  .chart-tip { position: fixed; z-index: 60; pointer-events: none; min-width: 150px; max-width: 280px; padding: 8px 10px;
    border: 1px solid var(--glass-line); border-radius: var(--radius-sm); background: var(--solid);
    box-shadow: var(--shadow); font: 11.5px/1.5 var(--mono); color: var(--text); }
  .chart-tip .tip-title { color: var(--text-2); font-weight: 600; margin-bottom: 4px; letter-spacing: .04em; overflow-wrap: anywhere; }
  .chart-tip .tip-row { display: flex; justify-content: space-between; gap: 14px; }
  .chart-tip .tip-row span:first-child { color: var(--muted); display: inline-flex; align-items: center; gap: 6px; }
  .chart-tip .tip-row span:last-child { font-variant-numeric: tabular-nums; }
  .swatch { display: inline-block; width: 8px; height: 8px; border-radius: 2px; flex: none; background: var(--sw, var(--gray)); }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0 0 10px; font: 11px var(--mono); color: var(--text-2); }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }

  /* Horizontal bars (HTML, so long names wrap and stay readable). */
  .hbars { display: grid; gap: 6px; }
  .hbar { display: grid; grid-template-columns: minmax(90px, 32%) minmax(0, 1fr) auto; gap: 10px; align-items: center;
    padding: 3px 6px; margin: 0 -6px; border-radius: var(--radius-sm); }
  .hbar.click { cursor: pointer; }
  .hbar.click:hover, .hbar:focus-visible { background: var(--glass-in); }
  .hbar.active { background: var(--green-dim); }
  .hbar .name { font: 12px var(--mono); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hbar .track { height: 10px; border-radius: 3px; background: var(--glass-in); overflow: hidden; }
  .hbar .fill { height: 100%; border-radius: 0 3px 3px 0; background: var(--sw, var(--green)); min-width: 2px;
    box-shadow: 0 0 10px -3px var(--sw, var(--green)); transition: width .4s var(--ease); }
  .hbar .val { font: 12px var(--mono); font-variant-numeric: tabular-nums; color: var(--text); text-align: right; white-space: nowrap; }
  .hbar .val small { color: var(--muted); font-size: 11px; margin-left: 6px; }
  @media (max-width: 640px) {
    .hbar { grid-template-columns: minmax(0, 1fr) auto; }
    .hbar .name { grid-column: 1 / -1; }
  }

  /* One stacked bar for a distribution. */
  .dist { display: flex; height: 14px; border-radius: 4px; overflow: hidden; gap: 2px; background: var(--glass-in); }
  .dist span { background: var(--sw, var(--gray)); min-width: 3px; }

  /* Heatmap: 24 hour columns × 7 weekday rows. */
  .heat { display: grid; grid-template-columns: 34px repeat(24, minmax(0, 1fr)); gap: 2px; }
  .heat .hl { font: 9.5px var(--mono); color: var(--muted); text-align: center; overflow: hidden; }
  .heat .dl { font: 10px var(--mono); color: var(--muted); align-self: center; }
  .heat .cell { aspect-ratio: 1; min-height: 8px; border-radius: 2px; background: var(--glass-in); }
  .heat .cell.on { background: var(--green); opacity: var(--a, .15); }
`;

export const CHART_JS = `
  const SERIES_COLORS = ['var(--green)', 'var(--cyan)', 'var(--violet)', 'var(--gray)'];
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs, style) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
    if (style) node.setAttribute('style', style);
    return node;
  };

  // One shared tooltip; rows are [label, value, color?].
  const tip = el('div', null, 'chart-tip'); tip.hidden = true; tip.setAttribute('role', 'tooltip');
  document.body.append(tip);
  function showTip(event, title, rows) {
    tip.replaceChildren(el('div', title, 'tip-title'));
    for (const [label, value, color] of rows) {
      const row = el('div', null, 'tip-row'); const name = el('span');
      if (color) { const sw = el('i', null, 'swatch'); sw.style.setProperty('--sw', color); name.append(sw); }
      name.append(label); row.append(name, el('span', value)); tip.append(row);
    }
    tip.hidden = false;
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = event.clientX + pad, y = event.clientY + pad;
    if (x + w > innerWidth - 8) x = event.clientX - w - pad;
    if (y + h > innerHeight - 8) y = event.clientY - h - pad;
    tip.style.left = Math.max(8, x) + 'px'; tip.style.top = Math.max(8, y) + 'px';
  }
  const hideTip = () => { tip.hidden = true; };
  addEventListener('scroll', hideTip, { passive: true });

  // Charts re-render when their container changes width.
  const mounted = new Map();
  const resizer = new ResizeObserver((items) => {
    for (const item of items) {
      const entry = mounted.get(item.target);
      const width = Math.round(item.contentRect.width);
      if (entry && width && width !== entry.width) { entry.width = width; entry.render(); }
    }
  });
  function mount(host, render) {
    const known = mounted.has(host);
    mounted.set(host, { render, width: host.clientWidth });
    if (!known) resizer.observe(host);
    render();
  }
  function unmount(host) { mounted.delete(host); resizer.unobserve(host); }

  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    const power = 10 ** Math.floor(Math.log10(raw));
    const n = raw / power;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * power;
  }

  /**
   * Time series over buckets. opts: { labels, title(i), series: [{ label, color, values }], kind: 'bar' | 'area',
   * stacked, integer (counts: whole-number ticks), marks (boolean per bucket: red dot above the column), fmt(value), tip(i) -> rows, onClick(i), height, ariaLabel }.
   */
  function timeChart(host, opts) {
    mount(host, () => {
      host.replaceChildren();
      const n = opts.labels.length;
      const width = Math.max(240, host.clientWidth || 600), height = opts.height || 220;
      const totals = opts.labels.map((_, i) => opts.stacked
        ? opts.series.reduce((sum, s) => sum + (s.values[i] || 0), 0)
        : Math.max(0, ...opts.series.map((s) => s.values[i] || 0)));
      const raw = niceStep(Math.max(...totals, 0) / 4);
      const step = opts.integer ? Math.max(1, Math.ceil(raw)) : raw;
      const top = Math.max(step, Math.ceil(Math.max(...totals, 0) / step) * step);
      const ticks = []; for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
      const left = Math.min(80, 10 + Math.max(...ticks.map((v) => opts.fmt(v).length)) * 6.2);
      const marked = (opts.marks || []).some(Boolean);
      const m = { top: marked ? 18 : 8, right: 6, bottom: 22, left };
      const pw = width - m.left - m.right, ph = height - m.top - m.bottom;
      const band = pw / Math.max(1, n);
      const x = (i) => m.left + band * i + band / 2;
      const y = (v) => m.top + ph - (v / top) * ph;
      const root = svg('svg', { viewBox: '0 0 ' + width + ' ' + height, height, role: 'img', 'aria-label': opts.ariaLabel || '' });

      const grid = svg('g', { class: 'grid' }); const axis = svg('g', { class: 'axis' });
      for (const v of ticks) {
        if (v > 0) grid.append(svg('line', { x1: m.left, x2: width - m.right, y1: y(v), y2: y(v) }));
        const t = svg('text', { x: m.left - 6, y: y(v) + 3, 'text-anchor': 'end' }); t.textContent = opts.fmt(v); axis.append(t);
      }
      const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 74))));
      for (let i = 0; i < n; i += every) {
        const t = svg('text', { x: x(i), y: height - 6, 'text-anchor': n === 1 ? 'middle' : i === 0 ? 'start' : 'middle' });
        if (i === 0 && n > 1) t.setAttribute('x', String(m.left));
        t.textContent = opts.labels[i]; axis.append(t);
      }
      root.append(grid, axis);
      const hover = svg('rect', { class: 'hover-band', x: 0, y: m.top, width: band, height: ph, visibility: 'hidden' });
      root.append(hover);

      if (opts.kind === 'area') {
        for (const s of opts.series) {
          const points = s.values.map((v, i) => [x(i), y(v || 0)]);
          const line = points.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
          if (n > 1) {
            const area = line + ' L' + points[n - 1][0].toFixed(1) + ' ' + y(0) + ' L' + points[0][0].toFixed(1) + ' ' + y(0) + ' Z';
            root.append(svg('path', { d: area }, 'fill:' + s.color + ';opacity:.1'));
            root.append(svg('path', { d: line, fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, 'stroke:' + s.color));
          }
          if (n <= 40) for (const p of points) root.append(svg('circle', { cx: p[0], cy: p[1], r: n === 1 ? 4 : 2.2 }, 'fill:' + s.color));
        }
      } else {
        const bw = Math.max(1, Math.min(32, band * 0.72));
        opts.labels.forEach((_, i) => {
          let base = 0;
          opts.series.forEach((s, si) => {
            const v = s.values[i] || 0; if (v <= 0) return;
            const from = opts.stacked ? base : 0; const to = from + v; base = to;
            const h = Math.max(1, y(from) - y(to));
            const isTop = !opts.stacked || opts.series.slice(si + 1).every((other) => !(other.values[i] > 0));
            root.append(svg('rect', { x: x(i) - bw / 2, y: y(to), width: bw, height: h, rx: isTop && h > 3 ? 1.5 : 0 }, 'fill:' + s.color + ';opacity:.9'));
          });
        });
      }
      root.append(svg('line', { class: 'base', x1: m.left, x2: width - m.right, y1: y(0), y2: y(0) }));
      if (marked) opts.marks.forEach((on, i) => { if (on) root.append(svg('circle', { class: 'mark', 'data-mark': String(i), cx: x(i), cy: 9, r: 4 }, 'fill:var(--red)')); });
      const cross = svg('line', { class: 'cross', y1: m.top, y2: m.top + ph, visibility: 'hidden' });
      root.append(cross);

      opts.labels.forEach((_, i) => {
        const hit = svg('rect', { class: 'band' + (opts.onClick ? ' click' : ''), x: m.left + band * i, y: m.top, width: band, height: ph + m.bottom });
        hit.addEventListener('mousemove', (event) => {
          hover.setAttribute('x', String(m.left + band * i)); hover.setAttribute('visibility', opts.kind === 'area' ? 'hidden' : 'visible');
          if (opts.kind === 'area') { cross.setAttribute('x1', String(x(i))); cross.setAttribute('x2', String(x(i))); cross.setAttribute('visibility', 'visible'); }
          showTip(event, opts.title(i), opts.tip(i));
        });
        hit.addEventListener('mouseleave', () => { hover.setAttribute('visibility', 'hidden'); cross.setAttribute('visibility', 'hidden'); hideTip(); });
        if (opts.onClick) hit.addEventListener('click', () => { hideTip(); opts.onClick(i); });
        root.append(hit);
      });
      host.append(root);
    });
  }

  /** Horizontal bars: rows [{ label, value, text, sub, color, tip, onClick, active }]. */
  function hbars(host, rows, title) {
    unmount(host);
    const max = Math.max(0, ...rows.map((r) => r.value || 0));
    host.replaceChildren(...rows.map((r) => {
      const row = el('div', null, 'hbar' + (r.onClick ? ' click' : '') + (r.active ? ' active' : ''));
      const name = el('div', r.label, 'name'); name.title = r.label;
      const track = el('div', null, 'track'); const fill = el('div', null, 'fill');
      fill.style.width = (max > 0 ? Math.max(0.5, ((r.value || 0) / max) * 100) : 0) + '%';
      fill.style.setProperty('--sw', r.color || 'var(--green)');
      track.append(fill);
      const val = el('div', r.text, 'val'); if (r.sub) val.append(el('small', r.sub));
      row.append(name, track, val);
      if (r.tip) {
        row.addEventListener('mousemove', (event) => showTip(event, r.label, r.tip));
        row.addEventListener('mouseleave', hideTip);
      }
      if (r.onClick) {
        row.tabIndex = 0; row.setAttribute('role', 'button');
        row.setAttribute('aria-label', (title ? title + ': ' : '') + r.label + ' ' + r.text + (r.active ? ' (aktiver Filter)' : ''));
        row.addEventListener('click', () => { hideTip(); r.onClick(); });
        row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); r.onClick(); } });
      }
      return row;
    }));
  }

  /** Distribution as one stacked bar: parts [{ label, value, color, text }]. */
  function distBar(host, parts) {
    const total = parts.reduce((sum, p) => sum + p.value, 0);
    const bar = el('div', null, 'dist'); bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', parts.map((p) => p.label + ' ' + p.value).join(', '));
    for (const p of parts) {
      if (!(p.value > 0)) continue;
      const seg = el('span'); seg.style.flex = String(p.value); seg.style.setProperty('--sw', p.color);
      seg.addEventListener('mousemove', (event) => showTip(event, p.label, [['Runs', fmtInt(p.value)], ['Anteil', fmtPct(p.value / total)]]));
      seg.addEventListener('mouseleave', hideTip);
      bar.append(seg);
    }
    host.replaceChildren(bar);
  }

  /** Weekday × hour heatmap of counts (grid[weekday 0 = Monday][hour]). */
  function heatmap(host, grid, max) {
    const days = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
    const wrap = el('div', null, 'heat'); wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', 'Run-Starts nach Wochentag und Stunde');
    wrap.append(el('span'));
    for (let h = 0; h < 24; h++) wrap.append(el('span', h % 3 === 0 ? pad2(h) : '', 'hl'));
    grid.forEach((hours, d) => {
      wrap.append(el('span', days[d], 'dl'));
      hours.forEach((count, h) => {
        const cell = el('span', null, 'cell' + (count > 0 ? ' on' : ''));
        if (count > 0) cell.style.setProperty('--a', (0.15 + 0.85 * (count / max)).toFixed(2));
        cell.addEventListener('mousemove', (event) => showTip(event, days[d] + ' ' + pad2(h) + ':00–' + pad2((h + 1) % 24) + ':00', [['Run-Starts', fmtInt(count)]]));
        cell.addEventListener('mouseleave', hideTip);
        wrap.append(cell);
      });
    });
    host.replaceChildren(wrap);
  }

  function legend(host, items) {
    host.replaceChildren(...items.map(([label, color]) => {
      const item = el('span'); const sw = el('i', null, 'swatch'); sw.style.setProperty('--sw', color);
      item.append(sw, label); return item;
    }));
  }
`;
