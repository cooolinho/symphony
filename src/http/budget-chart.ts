/**
 * The 5-hour utilisation chart of the "Context-Budget · heute" panel (#605): plain SVG, no library. Colours and type come
 * from the shell tokens (amber = utilisation, red = limit, over the limit and pauses). Data: GET /api/v1/budget/five-hour.
 * The chart is one persistent host node; the overview hands it to patchChildren on every render, so its listeners stay.
 */
export const BUDGET_CHART_CSS = `
  .b5h { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 10px 12px 8px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .b5h-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
  .b5h .ui-seg { padding: 2px; gap: 2px; }
  .b5h .ui-seg-btn { min-height: 28px; padding: 0 10px; font-size: 12px; }
  .b5h-plot { position: relative; min-width: 0; }
  .b5h-plot svg { display: block; width: 100%; overflow: visible; }
  .b5h-tip { position: absolute; top: 0; transform: translate(-50%, -100%); pointer-events: none; white-space: nowrap; font: 12px var(--mono);
    color: var(--fg); background: var(--solid); border: 1px solid var(--glass-line); border-radius: var(--radius-sm); padding: 4px 8px; }
  .b5h-tick { font: 10px var(--mono); fill: var(--fg-label); font-variant-numeric: tabular-nums; }
  .b5h-grid { stroke: var(--line); stroke-width: 1; }
  .b5h-limit { stroke: var(--red); stroke-width: 1.2; stroke-dasharray: 6 4; fill: none; }
  .b5h-limit-lbl, .b5h-peak-lbl, .b5h-eta-lbl { font: 500 10.5px var(--mono); fill: var(--red); }
  .b5h-line { fill: none; stroke: var(--amber); stroke-width: 2; stroke-linejoin: round; }
  .b5h-line-over { fill: none; stroke: var(--red); stroke-width: 2.2; stroke-linejoin: round; }
  .b5h-area { stroke: none; }
  .b5h-area-over { fill: var(--red); fill-opacity: .38; stroke: none; }
  .b5h-forecast { fill: none; stroke: var(--amber); stroke-width: 1.6; stroke-dasharray: 4 4; }
  .b5h-forecast.over { stroke: var(--red); }
  .b5h-hatch-bar { fill: var(--red); fill-opacity: .3; }
  .b5h-pause { stroke: none; }
  .b5h-peak, .b5h-eta { fill: var(--red); }
  .b5h-now { stroke: var(--fg-label); stroke-width: 1; stroke-dasharray: 2 3; }
  .b5h-now-lbl { font: 10px var(--mono); fill: var(--fg-label); }
  .b5h-reset { stroke: var(--fg-label); stroke-opacity: .6; stroke-width: 1; stroke-dasharray: 1 3; }
  .b5h-hit { fill: transparent; }
  .b5h-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font: 11px var(--mono); color: var(--fg-chip); }
  .b5h-legend > span { display: inline-flex; align-items: center; gap: 6px; }
  .b5h-sw { display: inline-block; width: 16px; height: 0; border-top: 2px solid var(--amber); flex: none; }
  .b5h-sw.dash { border-top-style: dashed; }
  .b5h-sw.red { border-top-color: var(--red); }
  .b5h-sw.box { height: 10px; border: 0; border-radius: 2px; background: var(--red-line); }
  .b5h-sw.hatch { height: 10px; border: 0; border-radius: 2px; background: repeating-linear-gradient(-45deg, var(--red-line) 0 3px, transparent 3px 6px); }
  .b5h-sw.dot { width: 0; height: 12px; border-top: 0; border-left: 2px dotted var(--fg-label); margin: 0 7px; }
  .b5h-text, .b5h-empty { margin: 0; font-size: 12.5px; color: var(--fg-3); }
  .b5h-empty { padding: 18px 0; text-align: center; }
  .b5h-red { color: var(--red); }
`;

/** Client code; needs el and svgEl (BASE_JS), segmented (components) and budgetHm / budgetDayHm (LAYOUT_JS) in scope. */
export const BUDGET_CHART_JS = `
  const B5H_RANGES = [{ value: 'window', label: 'Fenster' }, { value: 'day', label: '24 h' }, { value: 'week', label: '7 Tage' }];
  const B5H_EMPTY = 'Noch keine Auslastung im Zeitraum';
  const B5H_HOUR = 3600000;

  /** The chart: { host, setData(series | null, budgetReport | null), setGate(untilIso | null), range }. */
  function fiveHourChart(opts) {
    const chart = { range: 'window' };
    const host = el('div', null, 'b5h');
    const head = el('div', null, 'b5h-head');
    head.append(el('span', 'Auslastung 5-h-Fenster', 'lbl'), segmented(B5H_RANGES, 'window', (value) => {
      chart.range = value;
      if (opts && typeof opts.onRange === 'function') opts.onRange(value);
    }, 'Zeitraum'));
    const plot = el('div', null, 'b5h-plot');
    const tip = el('div', null, 'b5h-tip');
    tip.hidden = true;
    let series = null, budget = null, gate = null, width = 0;

    const ms = (iso) => Date.parse(iso || '');
    const fin = (n) => typeof n === 'number' && Number.isFinite(n);

    /** The window the running pause belongs to: the current one, else the last. */
    function activeWindow() {
      const list = series ? series.windows : [];
      return list.find((w) => w.current) || list[list.length - 1] || null;
    }
    /** Pause of a window, or the running gate pause for the active window without own pause. */
    function pauseOf(w) {
      if (w.pause) return w.pause;
      if (gate && w === activeWindow()) {
        const last = w.points[w.points.length - 1];
        return { from: w.over_limit_at || (last && last.at), to: gate };
      }
      return null;
    }

    function legend(range, hasForecast) {
      const box = el('div', null, 'b5h-legend');
      const item = (sw, label) => {
        const s = el('span');
        s.append(el('i', null, 'b5h-sw ' + sw), el('span', label));
        box.append(s);
      };
      item('line', 'Auslastung');
      if (range === 'window' && hasForecast) item('dash', 'Prognose');
      item('dash red', '5-h-Limit (100 %)');
      item('box red', 'über Limit');
      item('hatch', 'pausiert');
      if (range !== 'window') item('dot', 'Reset');
      return box;
    }

    /** The text line below the chart: what matters, without the graphic. Text parts are spans so their order is kept. */
    function textLine(range) {
      const p = el('p', null, 'b5h-text');
      const add = (value, cls) => p.append(el('span', value, cls || null));
      if (range !== 'window') {
        const s = series.summary || { windows: 0, over_limit: 0, paused_min: 0 };
        add(s.windows + ' Fenster · ');
        if (s.over_limit > 0) {
          add(s.over_limit + '× über Limit', 'b5h-red');
          add(' · ' + s.paused_min + ' min pausiert');
        } else add('nie über Limit');
        return p;
      }
      add('Fenster ' + budgetHm(series.from) + '–' + budgetHm(series.to) + ' · ');
      const w = activeWindow();
      const pause = w ? pauseOf(w) : null;
      const eta = budget && budget.five_hour && budget.five_hour.forecast ? budget.five_hour.forecast.eta : null;
      if (w && (w.over_limit || pause)) {
        add(w.over_limit
          ? 'Limit überschritten um ' + budgetHm(w.over_limit_at) + ' (Spitze ' + Math.round(w.peak.percent) + ' %)'
          : 'Limit erreicht', 'b5h-red');
        if (pause) add(' · pausiert bis ' + budgetHm(pause.to));
      } else if (eta) {
        add('bei aktuellem Tempo Limit ca. ' + budgetHm(eta) + ', ' + Math.max(0, Math.round((ms(series.to) - ms(eta)) / 60000)) + ' min vor dem Reset');
      } else if (series.forecast) {
        add('reicht bei aktuellem Tempo bis zum Reset');
      } else {
        add('Reset ' + budgetHm(series.to));
      }
      return p;
    }

    function draw() {
      const range = series && typeof series.range === 'string' ? series.range : chart.range;
      const windows = series && Array.isArray(series.windows) ? series.windows.filter((w) => w && Array.isArray(w.points) && w.points.length) : [];
      tip.hidden = true;
      if (!windows.length) {
        host.replaceChildren(head, el('p', B5H_EMPTY, 'b5h-empty'), legend(range, false));
        return;
      }
      const W = plot.clientWidth || width || 600;
      width = W;
      const H = W < 480 ? 150 : 180;
      const pad = { l: 34, r: 8, t: 14, b: 20 };
      const from = ms(series.from), to = ms(series.to);
      const span = Math.max(1, to - from);
      let peak = 0;
      for (const w of windows) for (const pt of w.points) if (pt.percent > peak) peak = pt.percent;
      const yMax = Math.max(125, Math.ceil((peak + 8) / 25) * 25);
      const x = (t) => pad.l + ((t - from) / span) * (W - pad.l - pad.r);
      const y = (v) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b);
      const clampX = (t) => x(Math.min(to, Math.max(from, t)));
      const y0 = y(0), y100 = y(100);

      const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img', 'aria-label': 'Verlauf der 5-h-Auslastung' });
      const defs = svgEl('defs');
      const hatch = svgEl('pattern', { id: 'b5h-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
      hatch.append(svgEl('rect', { width: 3, height: 6, class: 'b5h-hatch-bar' }));
      const grad = svgEl('linearGradient', { id: 'b5h-fill', x1: 0, y1: 0, x2: 0, y2: 1 });
      grad.append(svgEl('stop', { offset: 0, style: 'stop-color: var(--amber); stop-opacity: .35' }), svgEl('stop', { offset: 1, style: 'stop-color: var(--amber); stop-opacity: .02' }));
      const below = svgEl('clipPath', { id: 'b5h-below' });
      below.append(svgEl('rect', { x: pad.l, y: y100, width: W - pad.l - pad.r, height: y0 - y100 + 2 }));
      const above = svgEl('clipPath', { id: 'b5h-above' });
      above.append(svgEl('rect', { x: pad.l, y: pad.t - 6, width: W - pad.l - pad.r, height: y100 - pad.t + 6 }));
      defs.append(hatch, grad, below, above);
      svg.append(defs);

      // grid and y ticks
      for (let v = 0; v <= yMax; v += 25) {
        if (v !== 100) svg.append(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'b5h-grid' }));
        const t = svgEl('text', { x: pad.l - 4, y: y(v) + 3, 'text-anchor': 'end', class: 'b5h-tick' });
        t.textContent = v + '%';
        svg.append(t);
      }
      // x ticks: window hourly, day every 4 h, week daily (fewer on narrow screens)
      const narrow = W < 480;
      const step = range === 'window' ? (narrow ? 2 : 1) * B5H_HOUR : range === 'day' ? (narrow ? 6 : 4) * B5H_HOUR : 24 * B5H_HOUR;
      const ticks = [];
      if (range === 'week') {
        // one weekday label per day, at its noon
        const d = new Date(from);
        d.setHours(12, 0, 0, 0);
        for (; d.getTime() <= to; d.setDate(d.getDate() + 1)) {
          if (d.getTime() >= from) ticks.push([d.getTime(), d.toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '')]);
        }
      } else {
        const d = new Date(from);
        d.setMinutes(60, 0, 0);
        for (; d.getTime() <= to; d.setTime(d.getTime() + B5H_HOUR)) {
          if (d.getHours() % (step / B5H_HOUR) === 0) ticks.push([d.getTime(), budgetHm(d.toISOString())]);
        }
      }
      for (const [t, text] of ticks) {
        const label = svgEl('text', { x: x(t), y: H - 4, 'text-anchor': 'middle', class: 'b5h-tick' });
        label.textContent = text;
        svg.append(label);
      }

      // pauses (hatched)
      for (const w of windows) {
        const p = pauseOf(w);
        if (!p) continue;
        const a = ms(p.from), b = ms(p.to);
        if (!fin(a) || !fin(b) || b <= from || a >= to) continue;
        svg.append(svgEl('rect', { x: clampX(a), y: pad.t, width: Math.max(1, clampX(b) - clampX(a)), height: y0 - pad.t, class: 'b5h-pause', fill: 'url(#b5h-hatch)' }));
      }

      // the windows: area and line, amber below 100 %, red above
      for (const w of windows) {
        const pts = w.points.map((pt) => [x(ms(pt.at)), y(pt.percent)]);
        const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
        const area = 'M' + pts[0][0].toFixed(1) + ' ' + y0.toFixed(1) + ' ' + line.replace(/^M/, 'L') + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + y0.toFixed(1) + ' Z';
        svg.append(svgEl('path', { d: area, class: 'b5h-area', fill: 'url(#b5h-fill)', 'clip-path': 'url(#b5h-below)' }));
        svg.append(svgEl('path', { d: line, class: 'b5h-line', 'clip-path': 'url(#b5h-below)' }));
        if (w.peak && w.peak.percent > 100) {
          svg.append(svgEl('path', { d: area, class: 'b5h-area-over', 'clip-path': 'url(#b5h-above)' }));
          svg.append(svgEl('path', { d: line, class: 'b5h-line-over', 'clip-path': 'url(#b5h-above)' }));
        }
        if (range !== 'window' && w.resets_at) {
          const r = ms(w.resets_at);
          if (r > from && r <= to) svg.append(svgEl('line', { x1: x(r), x2: x(r), y1: pad.t, y2: y0, class: 'b5h-reset' }));
        }
        if (w.over_limit && w.peak) {
          const px = x(ms(w.peak.at)), py = y(w.peak.percent);
          svg.append(svgEl('circle', { cx: px, cy: py, r: range === 'week' ? 2.5 : 3, class: 'b5h-peak' }));
          if (range !== 'week' && w.peak.percent > 100) {
            const lbl = svgEl('text', { x: px, y: py - 6, 'text-anchor': 'middle', class: 'b5h-peak-lbl' });
            lbl.textContent = '+' + Math.round(w.peak.percent - 100) + ' %';
            svg.append(lbl);
          }
        }
      }

      // 5-h limit, always visible
      svg.append(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: y100, y2: y100, class: 'b5h-limit' }));
      const limitLbl = svgEl('text', { x: pad.l + 4, y: y100 - 4, class: 'b5h-limit-lbl' });
      limitLbl.textContent = '5-h-Limit';
      svg.append(limitLbl);

      if (range === 'window') {
        const f = series.forecast;
        if (f && f.from && f.to) {
          const d = 'M' + x(ms(f.from.at)).toFixed(1) + ' ' + y(f.from.percent).toFixed(1) + ' L' + x(ms(f.to.at)).toFixed(1) + ' ' + y(f.to.percent).toFixed(1);
          svg.append(svgEl('path', { d, class: 'b5h-forecast', 'clip-path': 'url(#b5h-below)' }));
          svg.append(svgEl('path', { d, class: 'b5h-forecast over', 'clip-path': 'url(#b5h-above)' }));
        }
        // no ETA marker once the window is over the limit or paused: the text line already says so
        const aw = activeWindow();
        const reached = !!(aw && (aw.over_limit || pauseOf(aw)));
        const eta = budget && budget.five_hour && budget.five_hour.forecast ? ms(budget.five_hour.forecast.eta) : NaN;
        if (!reached && fin(eta) && eta >= from && eta <= to) {
          svg.append(svgEl('circle', { cx: x(eta), cy: y100, r: 3.5, class: 'b5h-eta' }));
          const lbl = svgEl('text', { x: x(eta), y: y100 - 7, 'text-anchor': x(eta) > W - 90 ? 'end' : 'middle', class: 'b5h-eta-lbl' });
          lbl.textContent = 'Limit ca. ' + budgetHm(budget.five_hour.forecast.eta);
          svg.append(lbl);
        }
        const now = ms(series.now);
        if (fin(now) && now >= from && now <= to) {
          svg.append(svgEl('line', { x1: x(now), x2: x(now), y1: pad.t, y2: y0, class: 'b5h-now' }));
          const lbl = svgEl('text', { x: x(now), y: pad.t - 3, 'text-anchor': 'middle', class: 'b5h-now-lbl' });
          lbl.textContent = 'jetzt';
          svg.append(lbl);
        }
      }

      // tooltip: nearest point within 20 px
      const all = [];
      for (const w of windows) for (const pt of w.points) all.push({ x: x(ms(pt.at)), y: y(pt.percent), pt });
      const hit = svgEl('rect', { x: 0, y: 0, width: W, height: H, class: 'b5h-hit' });
      const move = (event) => {
        const box = svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
        const scale = box && box.width > 0 ? W / box.width : 1;
        const px = box && box.width > 0 && fin(event.clientX) ? (event.clientX - box.left) * scale : fin(event.offsetX) ? event.offsetX : NaN;
        let best = null;
        for (const c of all) if (Math.abs(c.x - px) <= 20 && (!best || Math.abs(c.x - px) < Math.abs(best.x - px))) best = c;
        if (!best) { tip.hidden = true; return; }
        const when = range === 'week' ? budgetDayHm(best.pt.at) : budgetHm(best.pt.at);
        tip.textContent = when + ' · ' + Math.round(best.pt.percent) + ' %' + (best.pt.percent > 100 ? ' (über Limit)' : '');
        tip.style.left = (best.x / scale) + 'px';
        tip.style.top = (best.y / scale - 6) + 'px';
        tip.hidden = false;
      };
      hit.addEventListener('mousemove', move);
      hit.addEventListener('pointerdown', move);
      hit.addEventListener('mouseleave', () => { tip.hidden = true; });
      svg.append(hit);

      plot.replaceChildren(svg, tip);
      host.replaceChildren(head, plot, legend(range, !!series.forecast), textLine(range));
    }

    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        const w = plot.clientWidth;
        if (w && Math.abs(w - width) > 1) { width = w; draw(); }
      }).observe(host);
    }

    chart.host = host;
    chart.setData = (next, report) => {
      series = next && Array.isArray(next.windows) ? next : null;
      budget = report || null;
      draw();
    };
    chart.setGate = (until) => {
      const next = until || null;
      if (next === gate) return;
      gate = next;
      draw();
    };
    draw();
    return chart;
  }
`;
