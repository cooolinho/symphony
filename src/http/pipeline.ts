/**
 * Shared pipeline topology strip: the stations an issue passes (agent roles, human columns, terminal
 * columns) as a left-to-right chain of neon nodes joined by SVG connectors. Done stages are green with a
 * check, the active stage pulses in the tone of the issue's live status, and the connector feeding the
 * active stage runs an animated dash ("data flow"). Both the dashboard cards and the issue detail page
 * inline PIPELINE_CSS/PIPELINE_JS next to BASE_CSS/BASE_JS (like charts.ts on the logs page).
 */
export const PIPELINE_CSS = `
  .pipe { display: flex; align-items: flex-start; min-width: 0; overflow-x: auto; padding: 2px 0; scrollbar-width: thin; }
  .pipe-node { display: flex; flex-direction: column; align-items: center; gap: 6px; flex: none; min-width: 52px; max-width: 110px; }
  .pipe-ring { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; position: relative;
    border: 1px solid var(--tone-line); background: radial-gradient(circle at 35% 30%, var(--tone-dim), rgba(11, 17, 21, .9));
    color: var(--tone); font: 600 13px var(--mono); box-shadow: 0 0 14px -5px var(--tone);
    transition: border-color .25s var(--ease), box-shadow .25s var(--ease), color .25s var(--ease); }
  .pipe-node.kind-human .pipe-ring, .pipe-node.kind-terminal .pipe-ring { border-radius: 9px; }
  .pipe-node.st-pending .pipe-ring { border-style: dashed; box-shadow: none; opacity: .75; }
  .pipe-node.st-pending .pipe-label { color: var(--muted); }
  .pipe-node.st-active .pipe-ring::after { content: ""; position: absolute; inset: -1px; border-radius: inherit;
    border: 1px solid var(--tone); animation: pipe-pulse 1.8s var(--ease) infinite; }
  @keyframes pipe-pulse { 0% { transform: scale(1); opacity: .7; } 80%, 100% { transform: scale(1.65); opacity: 0; } }
  .pipe-label { font: 600 10px var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--text-2);
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pipe-sub { font: 500 10px var(--mono); color: var(--muted); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pipe-link { flex: 1 1 26px; min-width: 18px; height: 34px; }
  .pipe-link line { stroke: var(--line-2); stroke-width: 2; stroke-dasharray: 5 5; }
  .pipe-link.st-done line { stroke: var(--green); stroke-dasharray: none; opacity: .45; }
  .pipe-link.st-flow line { stroke: var(--tone, var(--green)); stroke-dasharray: 5 5; opacity: .9;
    animation: pipe-flow 1.1s linear infinite; filter: drop-shadow(0 0 3px var(--tone, var(--green))); }
  @keyframes pipe-flow { to { stroke-dashoffset: -10; } }
  .pipe.compact .pipe-node { min-width: 44px; max-width: 86px; }
  .pipe.compact .pipe-ring { width: 26px; height: 26px; font-size: 11px; }
  .pipe.compact .pipe-link { height: 26px; min-width: 12px; }
  .pipe.compact .pipe-sub { display: none; }
`;

export const PIPELINE_JS = `
  // Tone of the active node by the issue's live status; done is always green, pending gray.
  const PIPE_STATUS_TONE = { running: 'green', retrying: 'amber', paused: 'gray', queued: 'cyan', blocked: 'red', finished: 'green' };
  const PIPE_CHECK = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5"/></svg>';
  const PIPE_HUMAN = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="5.2" r="2.6"/><path d="M2.8 13.6c.8-2.6 2.7-3.9 5.2-3.9s4.4 1.3 5.2 3.9"/></svg>';
  const PIPE_FLAG = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14V2.5m0 .5h7.5L9.5 6l2 3H4"/></svg>';

  function pipeTone(stage, liveStatus) {
    if (stage.status === 'done') return 'green';
    if (stage.status === 'active') {
      if (stage.kind !== 'agent') return 'cyan';
      return PIPE_STATUS_TONE[liveStatus] || 'green';
    }
    return 'gray';
  }

  /** Tooltip lines for a stage: its columns and one line per session (newest first). */
  function pipeTitle(stage) {
    const lines = [stage.label + (stage.columns.length ? ' · ' + stage.columns.join(', ') : '')];
    for (const s of [...stage.sessions].reverse()) {
      lines.push((s.outcome ? (OUTCOMES[s.outcome] || s.outcome) : 'running') +
        (s.model ? ' · ' + s.model : '') + (s.effort ? ' · effort ' + s.effort : '') +
        (s.started_at ? ' · ' + fmtClock(s.started_at) : ''));
    }
    return lines.join('\\n');
  }

  /**
   * Renders the stages into host. Idempotent over a fingerprint of statuses and sessions, so the pulse
   * and dash-flow animations survive the 2s poll; opts = { compact, liveStatus }.
   */
  function renderPipeline(host, stages, opts) {
    opts = opts || {};
    stages = stages || [];
    const fp = JSON.stringify([!!opts.compact, opts.liveStatus || '', stages.map((s) =>
      [s.id, s.label, s.kind, s.status, s.sessions.length, s.sessions.map((x) => x.outcome + '|' + x.model).join(',')])]);
    if (host.dataset.pipeFp === fp) return;
    host.dataset.pipeFp = fp;
    host.className = 'pipe' + (opts.compact ? ' compact' : '');
    host.setAttribute('role', 'img');
    host.setAttribute('aria-label', 'Pipeline: ' + (stages.map((s) => s.label + ' ' + s.status).join(', ') || 'unknown'));
    const nodes = [];
    stages.forEach((stage, i) => {
      if (i > 0) {
        const previous = stages[i - 1];
        const cls = stage.status === 'active' && previous.status === 'done' ? 'st-flow tone-' + pipeTone(stage, opts.liveStatus)
          : previous.status === 'done' && stage.status === 'done' ? 'st-done' : 'st-pending';
        const linkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        linkSvg.setAttribute('class', 'pipe-link ' + cls);
        linkSvg.setAttribute('viewBox', '0 0 40 10');
        linkSvg.setAttribute('preserveAspectRatio', 'none');
        linkSvg.setAttribute('aria-hidden', 'true');
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', '0'); line.setAttribute('y1', '5'); line.setAttribute('x2', '40'); line.setAttribute('y2', '5');
        // The svg stretches to the ring height; keep the stroke at its CSS width instead of scaling with it.
        line.setAttribute('vector-effect', 'non-scaling-stroke');
        linkSvg.append(line);
        nodes.push(linkSvg);
      }
      const node = el('div', null, 'pipe-node kind-' + stage.kind + ' st-' + stage.status + ' tone-' + pipeTone(stage, opts.liveStatus));
      const ring = el('span', null, 'pipe-ring');
      if (stage.status === 'done') ring.innerHTML = PIPE_CHECK;
      else if (stage.kind === 'human') ring.innerHTML = PIPE_HUMAN;
      else if (stage.kind === 'terminal') ring.innerHTML = PIPE_FLAG;
      else ring.textContent = (stage.label || '?').slice(0, 1).toUpperCase();
      const label = el('span', stage.label, 'pipe-label');
      node.append(ring, label);
      if (!opts.compact && stage.kind === 'agent') {
        const last = stage.sessions[stage.sessions.length - 1];
        const sub = stage.sessions.length
          ? stage.sessions.length + ' run' + (stage.sessions.length === 1 ? '' : 's') + (last && last.model ? ' · ' + last.model : '')
          : '—';
        node.append(el('span', sub, 'pipe-sub'));
      }
      node.title = pipeTitle(stage);
      nodes.push(node);
    });
    host.replaceChildren(...nodes);
  }
`;
