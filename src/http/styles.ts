import { BOOST_ICON_URI, ICONS_JS } from './icons.ts';
import { COMPONENTS_JS } from './ui/components.ts';

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
  const fmtClock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '--:--:--');
  const pad2 = (n) => String(n ?? 0).padStart(2, '0');

  // Workspace integrations (e.g. Laravel Boost) as the API reports them: icon, name and status wording.
  const INTEGRATION_ICONS = { 'laravel-boost': '${BOOST_ICON_URI}' };
  const INTEGRATION_LABELS = { 'laravel-boost': 'Laravel Boost' };
  const INTEGRATION_STATUS = { ready: ['Ready', 'green'], unavailable: ['Unavailable', 'amber'], absent: ['Not installed', 'gray'], off: ['Off', 'gray'] };
  const integrationLabel = (id) => INTEGRATION_LABELS[id] || id;
  function integrationIcon(id, size, dim) {
    size = size || 16;
    const src = INTEGRATION_ICONS[id];
    let icon;
    if (src) { icon = el('img', null, 'int-icon'); icon.src = src; icon.alt = ''; icon.width = size; icon.height = size; }
    else { icon = el('span', String(integrationLabel(id)).slice(0, 1).toUpperCase(), 'int-icon glyph'); icon.style.width = icon.style.height = size + 'px'; }
    icon.setAttribute('aria-hidden', 'true');
    if (dim) icon.classList.add('dim');
    return icon;
  }
  /** "name:count,…" of the repository logs (the count follows the last colon) → { name: count }. */
  function parseCounts(value) {
    const counts = {};
    for (const part of String(value || '').split(',')) {
      const at = part.lastIndexOf(':');
      const n = Number(part.slice(at + 1));
      if (at > 0 && Number.isFinite(n)) counts[part.slice(0, at)] = (counts[part.slice(0, at)] || 0) + n;
    }
    return counts;
  }
  /** { name: count } → "search-docs ×3, database-schema ×1", most used first. */
  const countsText = (counts) => Object.entries(counts || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ×' + v).join(', ');
  /** Integrations of a run_finished log entry with their calls: { id: { status, calls } }. */
  function logIntegrations(entry) {
    const result = {};
    for (const part of String(entry.integrations || '').split(',')) {
      const at = part.lastIndexOf(':');
      if (at > 0) result[part.slice(0, at)] = { status: part.slice(at + 1), calls: 0 };
    }
    for (const field of [entry.integration_tools, entry.integration_skills]) {
      for (const [key, n] of Object.entries(parseCounts(field))) {
        const x = result[key.split('/')[0]];
        if (x) x.calls += n;
      }
    }
    return result;
  }

  /** Status dot + label pill; tone is one of green, cyan, amber, red, gray. */
  function badge(text, tone, pulse) {
    const b = el('span', null, 'badge tone-' + tone + (pulse ? ' pulse' : ''));
    b.append(el('span', null, 'dot'), el('span', text));
    return b;
  }

  const BLOCK_SVG_NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs) => {
    const node = document.createElementNS(BLOCK_SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
    return node;
  };

  // Entries of the per-repository logs (/api/v1/history): one-line description and severity.
  const OUTCOMES = {
    handed_off: 'Handed off', continuing: 'Continuing', failed: 'Failed',
    stopped: 'Stopped', stalled: 'Stalled', shutdown: 'Shutdown', session_limit: 'Session limit',
  };
  function describeLogEntry(entry) {
    switch (entry.event) {
      case 'run_started':
        return 'Started in "' + entry.state + '"' + (entry.attempt && entry.attempt !== 'null' ? ' (attempt ' + entry.attempt + ')' : '') +
          (entry.model && entry.model !== 'default' ? ' · ' + entry.model : '') + (entry.effort && entry.effort !== 'default' ? ' · effort ' + entry.effort : '');
      case 'run_finished':
        return (OUTCOMES[entry.outcome] || entry.outcome) + ' → "' + entry.state + '" · ' + entry.turns + ' turn(s) · ' +
          fmtCompact(Number(entry.total_tokens)) + ' tokens · ' + fmtUsd(Number(entry.cost_usd)) + ' · ' +
          fmtDuration(Number(entry.agent_seconds)) + (entry.model && entry.model !== 'null' ? ' · ' + entry.model : '') +
          (entry.effort && entry.effort !== 'default' ? ' · effort ' + entry.effort : '') +
          Object.entries(logIntegrations(entry)).filter(([, x]) => x.status === 'ready')
            .map(([id, x]) => ' · ' + integrationLabel(id) + (x.calls ? ' used ×' + x.calls : ' not used')).join('') +
          (entry.outcome === 'failed' || entry.outcome === 'stalled' ? ' · ' + entry.reason : '');
      case 'issue_paused':
        return 'Paused after ' + entry.continuations + ' continuation session(s) in "' + entry.state + '"';
      case 'session_limit_wait':
        return 'Waiting for the session limit to reset · retry at ' + fmtTime(entry.retry_at);
      case 'worker_restarted':
        return 'Restarted by the operator' + (entry.previous ? ' (was ' + entry.previous + ')' : '');
      case 'workspace_removed':
        return 'Workspace removed ("' + entry.state + '")';
      default:
        return entry.event;
    }
  }
  function logSeverity(entry) {
    if (entry.event === 'run_finished') {
      if (entry.outcome === 'failed' || entry.outcome === 'stalled') return 'error';
      if (entry.outcome === 'stopped' || entry.outcome === 'shutdown' || entry.outcome === 'session_limit') return 'warn';
      return 'ok';
    }
    if (entry.event === 'issue_paused' || entry.event === 'session_limit_wait') return 'warn';
    return 'info';
  }
  const SEVERITY_TONE = { ok: 'green', info: 'cyan', warn: 'amber', error: 'red' };

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

  /** Replaces only the children that changed, so running animations and focus survive a refresh. */
  function patchChildren(host, nodes) {
    nodes.forEach((node, i) => {
      const old = host.children[i];
      if (!old) host.append(node);
      else if (old.outerHTML !== node.outerHTML) host.replaceChild(node, old);
    });
    while (host.children.length > nodes.length) host.lastElementChild.remove();
  }

  /** Metric tiles: [label, value, sub, options] with options { tone, hero, pulse, of }. */
  function tiles(id, items) {
    patchChildren(document.getElementById(id), items.map(([label, value, sub, opts]) => {
      opts = opts || {};
      const box = el('div', null, 'stat' + (opts.tone ? ' tone-' + opts.tone : '') + (opts.hero ? ' hero' : ''));
      const head = el('div', null, 'label');
      if (opts.tone) { const d = el('span', null, 'dot' + (opts.pulse ? ' pulse' : '')); head.append(d); }
      head.append(el('span', label));
      const v = el('div', value, 'value');
      if (opts.of !== undefined) v.append(el('span', ' / ' + opts.of, 'of'));
      box.append(head, v);
      if (sub) box.append(el('div', sub, 'sub'));
      return box;
    }));
  }

  // ------------------------------------------------------------------ live updates (SSE with polling fallback)
  const LIVE_POLL_MS = 30000;
  /** A polling interval whose period can change at runtime: { ms, current, set(next) }. */
  function pollEvery(fn, ms) {
    let timer = setInterval(fn, ms);
    const poller = { ms, current: ms, set(next) {
      if (next === poller.current) return;
      clearInterval(timer);
      timer = setInterval(fn, next);
      poller.current = next;
    } };
    return poller;
  }
  /**
   * Reloads the page on the server's change events (GET /api/v1/events). While the stream is connected the poller
   * slows to 30 s; on an error it returns to its own period. Without EventSource nothing happens and polling goes on.
   * gapMs > 0 spaces the reloads (leading and trailing edge). Returns the EventSource or null.
   */
  function live(onChange, poller, gapMs) {
    if (typeof EventSource === 'undefined') return null;
    const source = new EventSource('/api/v1/events');
    const flag = (on) => { if (typeof setLive === 'function') setLive(on); };
    let lost = false, last = 0, timer = null;
    const fire = () => { timer = null; last = Date.now(); onChange(); };
    source.addEventListener('open', () => {
      flag(true);
      if (poller) poller.set(Math.max(poller.ms, LIVE_POLL_MS));
      if (lost) { lost = false; onChange(); }
    });
    source.addEventListener('change', () => {
      const wait = gapMs > 0 ? last + gapMs - Date.now() : 0;
      if (wait <= 0) fire();
      else if (timer === null) timer = setTimeout(fire, wait);
    });
    source.addEventListener('error', () => {
      lost = true;
      flag(false);
      if (poller) poller.set(poller.ms);
    });
    return source;
  }
${ICONS_JS}${COMPONENTS_JS}`;
