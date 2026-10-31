import { CONTROLS_OFF } from './tasks-page.ts';
import { AURORA, escapeHtml, page } from './ui/layout.ts';

const BRAIN_CSS = `
  .br-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; }
  #brain-vitals { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin: 14px 0; }
  #brain-status { display: grid; gap: 8px; margin-bottom: 22px; }
  .br-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--text-2); }
  #candidates, #folders, #graph, #clashes { margin-top: 22px; }
  #candidates h2, #folders h2, #graph h2, #clashes h2 { margin: 0 0 10px; font: 600 10.5px var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--muted); }
  #brain-candidates { display: grid; gap: 12px; }
  #brain-undo { display: grid; gap: 8px; margin-bottom: 10px; }
  .br-undo { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; font-size: 12px; }
  .br-cand { padding: 14px 16px; border: 1px solid var(--line-2); border-radius: var(--radius-sm); background: var(--panel-2); display: grid; gap: 8px; min-width: 0; }
  .br-title { margin: 0; font: 600 14px var(--sans); color: var(--text); overflow-wrap: anywhere; }
  .br-path { font-size: 12px; color: var(--text-2); overflow-wrap: anywhere; }
  .br-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .br-meta { font-size: 12px; color: var(--text-2); overflow-wrap: anywhere; }
  .br-preview summary { cursor: pointer; font-size: 12px; color: var(--text-2); }
  .br-preview pre { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; color: var(--text-2); }
  .br-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .br-msg { margin: 0; font-size: 12px; color: var(--red); }
  .br-msg:empty { display: none; }
  .br-folder { margin: 4px 0; }
  .br-folder > summary, .br-folder.br-leaf { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 4px 0; font-size: 13px; }
  .br-folder > summary { cursor: pointer; }
  .br-children { margin-left: 18px; border-left: 1px solid var(--line-2); padding-left: 10px; }
  .br-total { font: 500 12px var(--mono); color: var(--text-2); }
  .br-columns { display: flex; flex-wrap: wrap; gap: 0 18px; align-items: flex-start; }
  .br-columns > #candidates { flex: 999 1 620px; min-width: 0; }
  .br-side { flex: 1 1 380px; min-width: 0; }
  .br-graph-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
  .br-graph-head h2 { margin: 0 !important; }
  #brain-graph-root { font: 500 12px var(--mono); color: var(--text); background: var(--panel-2); border: 1px solid var(--line-2); border-radius: var(--radius-sm); padding: 4px 8px; }
  #brain-graph { border: 1px solid var(--line-2); border-radius: var(--radius-sm); background: var(--panel-2); }
  #brain-graph .empty { margin: 0; padding: 14px 16px; }
  .br-graph { display: block; width: 100%; height: auto; color: var(--text-2); }
  .br-node { cursor: pointer; outline: none; }
  .br-node circle { pointer-events: all; transition: transform .15s ease-out; transform-box: fill-box; transform-origin: center; }
  .br-node:hover circle, .br-node:focus-visible circle, .br-node.is-selected circle { transform: scale(1.3); }
  .br-node:focus-visible circle { stroke: var(--text); stroke-width: 1.5; }
  .br-node text { font: 500 9px var(--mono); fill: var(--text-2); pointer-events: none; }
  #brain-graph-text { margin: 6px 0 0; font-size: 12px; color: var(--text-2); }
  #brain-graph-legend { margin-top: 6px; }
  .br-legend-dash { display: inline-block; width: 16px; border-top: 1.5px dashed var(--red); vertical-align: middle; margin-right: 6px; }
  #brain-graph-preview { margin-top: 10px; padding: 12px 14px; border: 1px solid var(--line-2); border-radius: var(--radius-sm); background: var(--panel-2); display: grid; gap: 6px; }
  #brain-graph-preview[hidden] { display: none; }
  .br-pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; color: var(--text-2); }
  #brain-clashes, #brain-clashes-resolved > div { display: grid; gap: 12px; }
  #brain-clashes-resolved { margin-top: 12px; }
  #brain-clashes-resolved > summary { cursor: pointer; font-size: 12px; color: var(--text-2); margin-bottom: 10px; }
  .br-clash { padding: 14px 16px; border: 1px solid var(--red-line); border-radius: var(--radius-sm); background: var(--panel-2); display: grid; gap: 8px; min-width: 0; animation: br-in .2s ease-out both; }
  .br-clash.is-resolved { border-color: var(--line-2); }
  .br-clash-path { font-weight: 600; color: var(--text); }
  @keyframes br-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  .br-diff-wrap > summary { cursor: pointer; font-size: 12px; color: var(--text-2); }
  .br-diff { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); margin-top: 6px; border: 1px solid var(--line-2); border-radius: var(--radius-sm); overflow: hidden; font: 11px/1.5 var(--mono); }
  .br-cell { padding: 0 8px; min-height: 1.5em; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-2); }
  .br-cell:nth-child(odd) { border-right: 1px solid var(--line-2); }
  .br-cell-head { padding: 4px 8px; font: 600 10.5px var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--line-2); }
  .br-del { background: var(--red-dim); color: var(--text); }
  .br-add { background: var(--green-dim); color: var(--text); }
  .br-del::before { content: "− "; color: var(--red); }
  .br-add::before { content: "+ "; color: var(--green); }
  .br-gap { background: repeating-linear-gradient(135deg, transparent 0 4px, var(--line-2) 4px 5px); }
  .br-more { grid-column: 1 / -1; padding: 4px 8px; color: var(--muted); }
  @media (prefers-reduced-motion: reduce) {
    .br-node circle { transition: none; }
    .br-clash { animation: none; }
  }
`;

/**
 * The Brain page: vitals with status bar, candidate review (promote, discard, undo), the graph around a repository index
 * (ring layout by link distance), the folder tree of the vault and the write clashes with a side-by-side line diff.
 */
export const BRAIN_HTML = page({
  title: 'Brain · Symphony',
  nav: 'brain',
  aurora: AURORA.brain,
  styles: BRAIN_CSS,
  body: `
  <section aria-labelledby="page-title">
    <div class="br-head">
      <h1 id="page-title">Brain</h1>
      <span id="brain-open"></span>
    </div>
    <p id="brain-off" class="empty" hidden>Das Brain ist nicht aktiviert (brain.enabled in WORKFLOW.md).</p>
    <p id="brain-error" class="empty" hidden></p>
    <div id="brain-main">
      <div id="brain-vitals"></div>
      <div id="brain-status"></div>
      <div class="br-columns">
      <section id="candidates" aria-labelledby="candidates-title">
        <h2 id="candidates-title">Kandidaten</h2>
        <p class="task-off" id="brain-controls-off" hidden>${escapeHtml(CONTROLS_OFF)}</p>
        <div id="brain-undo"></div>
        <div id="brain-candidates"></div>
      </section>
      <div class="br-side">
      <section id="graph" aria-labelledby="graph-title">
        <div class="br-graph-head">
          <h2 id="graph-title">Graph</h2>
          <select id="brain-graph-root" aria-label="Repository"></select>
        </div>
        <div id="brain-graph"></div>
        <p id="brain-graph-text" hidden></p>
        <div id="brain-graph-legend" class="br-legend"></div>
        <div id="brain-graph-preview" aria-live="polite" hidden></div>
      </section>
      <section id="folders" aria-labelledby="folders-title">
        <h2 id="folders-title">Ordner</h2>
        <div id="brain-folders"></div>
      </section>
      </div>
      </div>
      <section id="clashes" aria-labelledby="clashes-title">
        <h2 id="clashes-title">Write-Clashes</h2>
        <p class="task-off" id="brain-clash-controls-off" hidden>${escapeHtml(CONTROLS_OFF)}</p>
        <div id="brain-clashes"></div>
        <details id="brain-clashes-resolved" hidden><summary></summary><div></div></details>
      </section>
    </div>
  </section>`,
  scripts: `
(() => {
  const $ = (id) => document.getElementById(id);
  const CONTROLS_OFF = ${JSON.stringify(CONTROLS_OFF)};
  const UNDO_MS = 10000;
  const STATUS_TONES = { approved: UI_TRAFFIC.green, candidate: UI_TRAFFIC.amber, deprecated: '#6b7280' };
  const SAFE_URL = /^(https?|obsidian):\\/\\/\\S/i;
  let allowed = false;
  let vitals = null;
  let candidates = [];
  let undo = [];
  let fingerprint = '';
  const openKeys = new Set();
  let clashes = [];
  /** Open state of the clash comparisons the user toggled (key c:<id>). */
  const diffOpen = new Map();
  let graph = null;
  let graphRoot = null;
  let graphSelected = null;
  let graphPrint = '';
  let graphSeq = 0;

  function ageOf(created) {
    if (!created) return '—';
    const iso = /^\\d{4}-\\d{2}-\\d{2}$/.test(created) ? created + 'T00:00:00Z' : created;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? '—' : 'vor ' + fmtDuration((Date.now() - ms) / 1000);
  }

  /** Link to Obsidian; only http(s):// and obsidian:// URLs are ever rendered. */
  function obsidianLink(label, href, title) {
    if (typeof href !== 'string' || !SAFE_URL.test(href)) return null;
    const a = el('a', null, 'ui-btn ui-btn-36 ui-btn-obsidian');
    a.setAttribute('href', href);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener');
    if (title) a.setAttribute('title', title);
    a.append(el('span', label, 'ui-btn-label'));
    return a;
  }

  function editHref(path) {
    const base = vitals && vitals.obsidian_url;
    if (typeof base !== 'string' || base === '') return null;
    if (!/^obsidian:/i.test(base)) return base;
    return base + (base.includes('?') ? '&' : '?') + 'file=' + encodeURIComponent(path.replace(/\\.md$/i, ''));
  }

  function renderHead() {
    const v = vitals;
    const by = v.notes_by_status;
    const total = by.approved + by.candidate + by.deprecated + by.none;
    const last = v.last_commit;
    $('brain-vitals').replaceChildren(
      kpi(fmtInt(total), 'Notizen'),
      kpi(fmtInt(by.approved), 'Approved'),
      kpi(fmtInt(by.candidate), 'Kandidaten'),
      kpi(fmtInt(by.deprecated), 'Deprecated'),
      kpi(fmtInt(v.links), 'Links'),
      kpi(fmtInt(v.orphans), 'Waisen'),
      kpi(fmtInt(v.broken_links), 'Kaputte Links'),
      kpi(fmtInt(v.writes_today), 'Schreibzugriffe heute'),
      kpi(fmtInt(v.reads_today), 'Lesezugriffe heute'),
      last ? kpi(String(last.sha).slice(0, 7), 'Letzter Commit', { sub: last.author + ' · ' + ageOf(last.at) }) : kpi(null, 'Letzter Commit'),
    );
    const parts = ['approved', 'candidate', 'deprecated'].map((s) => ({ value: by[s], label: s, color: STATUS_TONES[s] }));
    const sum = parts.reduce((acc, p) => acc + p.value, 0);
    const legend = el('div', null, 'br-legend');
    for (const p of parts) legend.append(el('span', p.label + ' ' + (sum ? Math.round((p.value / sum) * 100) : 0) + ' %'));
    $('brain-status').replaceChildren(stackedBar(parts), legend);
    const open = obsidianLink('In Obsidian öffnen', v.obsidian_url);
    $('brain-open').replaceChildren(...(open ? [open] : []));
  }

  async function post(path, action) {
    const res = await fetch('/api/v1/brain/candidates/' + encodeURIComponent(path) + '/' + action, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    let body = {};
    try { body = await res.json(); } catch (error) { /* no JSON body */ }
    return { res, body: body || {} };
  }
  function failure(res, body) {
    if (res.status === 403) return CONTROLS_OFF;
    const e = body.error || {};
    return 'Fehlgeschlagen (' + res.status + '): ' + (e.message || e.code || '');
  }

  async function act(card, c, action) {
    const buttons = [...card.querySelectorAll('button')];
    const msg = card.querySelector('.br-msg');
    for (const b of buttons) b.disabled = true;
    msg.textContent = '';
    try {
      const { res, body } = await post(c.path, action);
      if (!res.ok) { msg.textContent = failure(res, body); for (const b of buttons) b.disabled = false; return; }
      if (action === 'approve') {
        undo.push({ path: body.path, title: c.title, until: Date.now() + UNDO_MS });
        setTimeout(() => { fingerprint = ''; render(); }, UNDO_MS + 50);
      }
      await load();
    } catch (error) {
      msg.textContent = 'Fehlgeschlagen: ' + error.message;
      for (const b of buttons) b.disabled = false;
    }
  }

  function candidateCard(c) {
    const card = el('article', null, 'br-cand');
    card.dataset.path = c.path;
    card.append(el('h3', c.title, 'br-title'), el('div', c.path, 'br-path mono'));
    const chips = el('div', null, 'br-chips');
    if (c.type) chips.append(chip(c.type, { tone: 'violet' }));
    if (c.repo) chips.append(chip(c.repo, { mono: true }));
    if (c.issue) {
      if (c.repo && /^\\d+$/.test(c.issue)) {
        const a = el('a', '#' + c.issue);
        a.href = '/issue?id=' + encodeURIComponent(c.repo + '#' + c.issue);
        chips.append(a);
      } else chips.append(chip(c.issue, { mono: true }));
    }
    if (c.role) chips.append(chip(c.role, { tone: uiOwn(UI_ROLE_COLORS, c.role) || 'gray', dot: true }));
    card.append(chips, el('div', 'Alter ' + ageOf(c.created) + ' · → ' + c.target, 'br-meta'));
    if (c.preview) {
      const d = el('details', null, 'br-preview');
      d.dataset.key = 'p:' + c.path;
      if (openKeys.has(d.dataset.key)) d.open = true;
      d.addEventListener('toggle', () => { if (d.open) openKeys.add(d.dataset.key); else openKeys.delete(d.dataset.key); });
      d.append(el('summary', 'Vorschau'), el('pre', c.preview, 'mono'));
      card.append(d);
    }
    const note = el('p', null, 'br-msg');
    note.setAttribute('role', 'status');
    card.append(note);
    if (allowed) {
      const actions = el('div', null, 'br-actions');
      actions.append(
        button('Befördern', { size: 36, tone: 'approve', onClick: () => act(card, c, 'approve') }),
        button('Verwerfen', { size: 36, tone: 'danger', onClick: () => { if (confirm('Kandidat ' + c.path + ' verwerfen?')) act(card, c, 'reject'); } }),
      );
      const edit = obsidianLink('In Obsidian bearbeiten', editHref(c.path), c.path);
      if (edit) actions.append(edit);
      card.append(actions);
    }
    return card;
  }

  function renderUndo() {
    const now = Date.now();
    undo = undo.filter((u) => u.until > now);
    $('brain-undo').replaceChildren(...undo.map((u) => {
      const row = el('div', null, 'br-undo');
      const msg = el('span', '„' + u.title + '“ nach ' + u.path + ' befördert.');
      const note = el('span', null, 'br-msg');
      note.setAttribute('role', 'status');
      const b = button('Rückgängig', { size: 36, onClick: async () => {
        b.disabled = true;
        try {
          const { res, body } = await post(u.path, 'revert');
          if (!res.ok) { note.textContent = failure(res, body); b.disabled = false; return; }
          undo = undo.filter((x) => x !== u);
          await load();
        } catch (error) { note.textContent = 'Fehlgeschlagen: ' + error.message; b.disabled = false; }
      } });
      row.append(msg, b, note);
      return row;
    }));
  }

  function folderTree(folders) {
    const nodes = new Map(folders.map((f) => [f.path, { f, children: [] }]));
    const roots = [];
    for (const n of nodes.values()) {
      const parent = nodes.get(n.f.path.slice(0, Math.max(0, n.f.path.lastIndexOf('/'))));
      if (n.f.path.includes('/') && parent) parent.children.push(n); else roots.push(n);
    }
    const LABELS = [['approved', 'approved', 'green'], ['candidate', 'candidate', 'amber'], ['deprecated', 'deprecated', 'gray'], ['none', 'ohne Status', 'gray']];
    const build = (n) => {
      const head = [el('span', n.f.path.split('/').pop(), 'mono'), el('span', String(n.f.total), 'br-total')];
      for (const [key, label, tone] of LABELS) if (n.f.notes_by_status[key] > 0) head.push(chip(label + ' ' + n.f.notes_by_status[key], { tone }));
      if (!n.children.length) {
        const leaf = el('div', null, 'br-folder br-leaf');
        leaf.append(...head);
        return leaf;
      }
      const d = el('details', null, 'br-folder');
      d.dataset.key = 'f:' + n.f.path;
      if (openKeys.has(d.dataset.key)) d.open = true;
      d.addEventListener('toggle', () => { if (d.open) openKeys.add(d.dataset.key); else openKeys.delete(d.dataset.key); });
      const s = el('summary');
      s.append(...head);
      const kids = el('div', null, 'br-children');
      kids.append(...n.children.map(build));
      d.append(s, kids);
      return d;
    };
    return roots.map(build);
  }

  // Graph: ring layout by distance to the root (no physics, nothing animates positions).
  const GW = 400, GH = 280;
  const RADII = [0, 64, 104, 128];
  const NODE_R = [12, 8, 6, 5];
  const NO_STATUS = UI_CHIP_TONES.gray.c;
  const statusColor = (n) => (n.missing ? UI_TRAFFIC.red : uiOwn(STATUS_TONES, n.status) || NO_STATUS);
  const short = (s) => (s.length > 18 ? s.slice(0, 17) + '…' : s);

  /** One root per Repos/<repo> folder of the vitals. */
  function repoRoots(v) {
    return ((v && v.folders) || [])
      .map((f) => /^Repos\\/([^/]+)$/.exec(f.path))
      .filter(Boolean)
      .map((m) => ({ label: m[1], root: 'Repos/' + m[1] + '/index.md' }));
  }

  function renderRootSelect(roots) {
    const select = $('brain-graph-root');
    const print = JSON.stringify(roots);
    if (select.dataset.print !== print) {
      select.dataset.print = print;
      select.replaceChildren(...roots.map((r) => {
        const o = el('option', r.label);
        o.setAttribute('value', r.root);
        return o;
      }));
    }
    select.hidden = roots.length === 0;
    if (graphRoot) select.value = graphRoot;
  }

  /** Path to { x, y, r }: the root in the centre, each ring a link further out, children inside the sector of their parent. */
  function ringLayout(g) {
    const depthOf = new Map(g.nodes.map((n) => [n.path, n.depth]));
    const near = new Map();
    for (const e of g.edges) {
      if (!near.has(e.from)) near.set(e.from, []);
      if (!near.has(e.to)) near.set(e.to, []);
      near.get(e.from).push(e.to);
      near.get(e.to).push(e.from);
    }
    const kids = new Map();
    for (const n of g.nodes) {
      if (n.depth === 0) continue;
      const parent = n.depth === 1 ? g.root : (near.get(n.path) || []).filter((p) => depthOf.get(p) === n.depth - 1).sort()[0] || g.root;
      if (!kids.has(parent)) kids.set(parent, []);
      kids.get(parent).push(n);
    }
    const pos = new Map();
    const place = (path, depth, angle, width) => {
      const ring = RADII[Math.min(depth, RADII.length - 1)];
      pos.set(path, { x: GW / 2 + ring * 1.4 * Math.cos(angle), y: GH / 2 + ring * 0.95 * Math.sin(angle), r: NODE_R[Math.min(depth, NODE_R.length - 1)] });
      const list = kids.get(path) || [];
      list.forEach((child, i) => {
        if (pos.has(child.path)) return;
        place(child.path, child.depth, angle - width / 2 + (width * (i + 0.5)) / list.length, width / list.length);
      });
    };
    place(g.root, 0, -Math.PI / 2, 2 * Math.PI);
    return pos;
  }

  function graphSummary(g) {
    const broken = g.edges.filter((e) => e.broken).length;
    return fmtInt(g.nodes.length) + ' Knoten, ' + fmtInt(g.edges.length) + ' Kanten, ' + fmtInt(broken) + ' kaputte Links' +
      (g.truncated ? ' · gekürzt auf ' + fmtInt(g.nodes.length) + ' Knoten' : '');
  }

  function showNode(n) {
    graphSelected = n.path;
    for (const node of $('brain-graph').querySelectorAll('.br-node')) node.classList.toggle('is-selected', node.dataset.path === n.path);
    const linked = graph.edges.filter((e) => e.from === n.path || e.to === n.path);
    const chips = el('div', null, 'br-chips');
    chips.append(n.missing ? chip('fehlt', { tone: 'red' }) : chip(n.status || 'ohne Status', { dot: statusColor(n) }));
    if (n.type) chips.append(chip(n.type, { tone: 'violet' }));
    const parts = [el('h3', n.title, 'br-title'), el('div', n.path, 'br-path mono'), chips];
    parts.push(n.missing
      ? el('div', 'Ziel fehlt – verlinkt von ' + linked.map((e) => e.from).join(', '), 'br-meta')
      : el('div', linked.length + ' Links im Ausschnitt', 'br-meta'));
    const c = candidates.find((x) => x.path === n.path);
    if (c && c.preview) parts.push(el('pre', c.preview, 'mono br-pre'));
    const open = n.missing ? null : obsidianLink('In Obsidian öffnen', editHref(n.path), n.path);
    if (open) parts.push(open);
    $('brain-graph-preview').replaceChildren(...parts);
    $('brain-graph-preview').hidden = false;
  }

  function graphLegend() {
    const items = [['approved', STATUS_TONES.approved], ['candidate', STATUS_TONES.candidate], ['deprecated', STATUS_TONES.deprecated], ['ohne Status', NO_STATUS]].map(([label, color]) => {
      const s = el('span');
      s.append(uiDot(color), el('span', ' ' + label));
      return s;
    });
    const broken = el('span');
    broken.append(el('span', null, 'br-legend-dash'), el('span', 'kaputter Link'));
    return [...items, broken];
  }

  function renderGraph() {
    const g = graph;
    const print = JSON.stringify([graphRoot, g, vitals && vitals.obsidian_url]);
    if (print === graphPrint) return;
    graphPrint = print;
    const box = $('brain-graph');
    const text = $('brain-graph-text');
    if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges) || g.edges.length === 0) {
      box.replaceChildren(el('p', 'Keine Links', 'empty'));
      text.hidden = true;
      $('brain-graph-legend').replaceChildren();
      $('brain-graph-preview').hidden = true;
      return;
    }
    const summary = graphSummary(g);
    const pos = ringLayout(g);
    const svg = svgEl('svg', { viewBox: '0 0 ' + GW + ' ' + GH, class: 'br-graph', role: 'group', 'aria-label': 'Graph um ' + g.root + ': ' + summary });
    for (const e of g.edges) {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) continue;
      svg.append(svgEl('line', e.broken
        ? { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'br-edge br-edge-broken', stroke: UI_TRAFFIC.red, 'stroke-width': 1.5, 'stroke-dasharray': '3 3' }
        : { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'br-edge', stroke: 'currentColor', 'stroke-width': 1, 'stroke-opacity': 0.35 }));
    }
    for (const n of g.nodes) {
      const p = pos.get(n.path);
      if (!p) continue;
      const node = svgEl('g', { class: 'br-node' + (n.missing ? ' br-node-missing' : ''), role: 'button', tabindex: 0, 'aria-label': n.title + ' (' + n.path + ')' });
      node.dataset.path = n.path;
      node.append(svgEl('circle', n.missing
        ? { cx: p.x, cy: p.y, r: p.r, fill: 'none', stroke: UI_TRAFFIC.red, 'stroke-width': 1.5, 'stroke-dasharray': '2 2' }
        : { cx: p.x, cy: p.y, r: p.r, fill: statusColor(n) }));
      const title = svgEl('title');
      title.textContent = n.path;
      node.append(title);
      if (n.depth <= 1) {
        const label = svgEl('text', { x: p.x, y: p.y + p.r + 10, 'text-anchor': 'middle' });
        label.textContent = short(n.title);
        node.append(label);
      }
      node.addEventListener('click', () => showNode(n));
      node.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showNode(n); }
      });
      svg.append(node);
    }
    box.replaceChildren(svg);
    text.textContent = summary;
    text.hidden = false;
    $('brain-graph-legend').replaceChildren(...graphLegend());
    const still = g.nodes.find((n) => n.path === graphSelected);
    if (still) showNode(still);
    else { graphSelected = null; $('brain-graph-preview').hidden = true; }
  }

  async function loadGraph() {
    const roots = repoRoots(vitals);
    if (!roots.some((r) => r.root === graphRoot)) graphRoot = roots.length ? roots[0].root : null;
    renderRootSelect(roots);
    const seq = ++graphSeq;
    let g = null;
    if (graphRoot) {
      try {
        const r = await getJson('/api/v1/brain/graph?root=' + encodeURIComponent(graphRoot) + '&depth=2');
        if (r.ok && r.body && Array.isArray(r.body.nodes)) g = r.body;
      } catch (error) { /* shown as no links */ }
    }
    if (seq !== graphSeq) return;
    graph = g;
    renderGraph();
  }

  $('brain-graph-root').addEventListener('change', () => {
    graphRoot = $('brain-graph-root').value;
    graphSelected = null;
    loadGraph();
  });

  // Write clashes: both versions side by side with an own line diff (LCS).
  const CLASH_REASONS = { hash_mismatch: 'Hash-Konflikt', window: 'Schutzfenster' };
  const DIFF_CELLS = 4000000;
  const DIFF_ROWS = 2000;

  /** Line diff of a and b: rows { kind: same | del | add, left, right } in order; LCS, by index above DIFF_CELLS cells. */
  function lineDiff(a, b) {
    const x = String(a).split('\\n'), y = String(b).split('\\n');
    const n = x.length, m = y.length;
    const rows = [];
    if (n * m > DIFF_CELLS) {
      for (let i = 0; i < Math.max(n, m); i++) {
        if (i < n && i < m && x[i] === y[i]) { rows.push({ kind: 'same', left: x[i], right: y[i] }); continue; }
        if (i < n) rows.push({ kind: 'del', left: x[i], right: null });
        if (i < m) rows.push({ kind: 'add', left: null, right: y[i] });
      }
      return rows;
    }
    const w = m + 1;
    const t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) t[i * w + j] = x[i] === y[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) { rows.push({ kind: 'same', left: x[i], right: y[j] }); i++; j++; }
      else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) rows.push({ kind: 'del', left: x[i++], right: null });
      else rows.push({ kind: 'add', left: null, right: y[j++] });
    }
    while (i < n) rows.push({ kind: 'del', left: x[i++], right: null });
    while (j < m) rows.push({ kind: 'add', left: null, right: y[j++] });
    return rows;
  }

  /** Two columns; a run of changes pairs its removed and added lines row by row, a missing side is a gap. */
  function diffGrid(leftHead, rightHead, rows) {
    const grid = el('div', null, 'br-diff');
    grid.setAttribute('role', 'table');
    grid.append(el('div', leftHead, 'br-cell br-cell-head'), el('div', rightHead, 'br-cell br-cell-head'));
    const pairs = [];
    for (let k = 0; k < rows.length;) {
      if (rows[k].kind === 'same') { pairs.push([rows[k].left, rows[k].right, false]); k++; continue; }
      const dels = [], adds = [];
      for (; k < rows.length && rows[k].kind !== 'same'; k++) {
        if (rows[k].kind === 'del') dels.push(rows[k].left); else adds.push(rows[k].right);
      }
      for (let q = 0; q < Math.max(dels.length, adds.length); q++) pairs.push([q < dels.length ? dels[q] : null, q < adds.length ? adds[q] : null, true]);
    }
    for (const [left, right, changed] of pairs.slice(0, DIFF_ROWS)) {
      grid.append(
        left === null ? el('div', null, 'br-cell br-gap') : el('div', left, 'br-cell' + (changed ? ' br-del' : '')),
        right === null ? el('div', null, 'br-cell br-gap') : el('div', right, 'br-cell' + (changed ? ' br-add' : '')),
      );
    }
    if (pairs.length > DIFF_ROWS) grid.append(el('div', '… weitere ' + fmtInt(pairs.length - DIFF_ROWS) + ' Zeilen', 'br-more'));
    return grid;
  }

  async function resolveClash(card, c) {
    const b = card.querySelector('button');
    const msg = card.querySelector('.br-msg');
    b.disabled = true;
    msg.textContent = '';
    try {
      const res = await fetch('/api/v1/brain/clashes/' + encodeURIComponent(c.id) + '/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      let body = {};
      try { body = await res.json(); } catch (error) { /* no JSON body */ }
      if (!res.ok && res.status !== 409) { msg.textContent = failure(res, body || {}); b.disabled = false; return; }
      await load();
    } catch (error) {
      msg.textContent = 'Fehlgeschlagen: ' + error.message;
      b.disabled = false;
    }
  }

  function clashCard(c, resolved) {
    const card = el('article', null, 'br-clash' + (resolved ? ' is-resolved' : ''));
    card.dataset.id = c.id;
    const runs = c.runs || [], roles = c.roles || [], at = c.at || [];
    const head = el('div', null, 'br-chips');
    head.append(el('span', c.path, 'br-path mono br-clash-path'), chip(uiOwn(CLASH_REASONS, c.reason) || String(c.reason), { tone: 'red' }));
    if (resolved) head.append(chip('gelöst', { tone: 'green' }));
    head.append(el('span', fmtTime(at[1]), 'br-meta mono'));
    const who = (k) => (runs[k] || 'unbekannter Run') + ' (' + (roles[k] || 'Rolle unbekannt') + ')';
    const when = (k) => (at[k] ? fmtTime(at[k]) : 'unbekannt');
    card.append(head, el('div', who(0) + ' schrieb um ' + when(0) + ', ' + who(1) + ' um ' + when(1) + ' – abgewiesen.', 'br-meta'));
    const left = c.attempted ? ['Abgewiesene Fassung', c.attempted.content] : c.base ? ['Fassung bei der Abweisung', c.base.content] : null;
    const right = c.current ? ['Aktuelle Fassung', c.current.content] : ['Aktuelle Fassung (Notiz fehlt)', ''];
    const d = el('details', null, 'br-diff-wrap');
    d.dataset.key = 'c:' + c.id;
    d.open = diffOpen.has(d.dataset.key) ? diffOpen.get(d.dataset.key) : !resolved;
    d.addEventListener('toggle', () => diffOpen.set(d.dataset.key, d.open));
    d.append(el('summary', 'Fassungen vergleichen'), left
      ? diffGrid(left[0], right[0], lineDiff(left[1], right[1]))
      : el('p', 'Keine Fassung des abgewiesenen Runs gespeichert.', 'br-meta'));
    const note = el('p', null, 'br-msg');
    note.setAttribute('role', 'status');
    card.append(d, note);
    if (allowed && !resolved) {
      const actions = el('div', null, 'br-actions');
      actions.append(button('Als gelöst markieren', { size: 36, tone: 'approve', onClick: () => resolveClash(card, c) }));
      card.append(actions);
    }
    return card;
  }

  function renderClashes() {
    const open = clashes.filter((c) => c.status !== 'resolved');
    const done = clashes.filter((c) => c.status === 'resolved');
    $('brain-clash-controls-off').hidden = allowed || open.length === 0;
    $('brain-clashes').replaceChildren(...(open.length ? open.map((c) => clashCard(c, false)) : [el('p', 'Keine Konflikte', 'empty')]));
    const resolved = $('brain-clashes-resolved');
    resolved.hidden = done.length === 0;
    resolved.querySelector('summary').textContent = 'Gelöste Clashes (' + done.length + ')';
    resolved.querySelector('div').replaceChildren(...done.map((c) => clashCard(c, true)));
  }

  function render() {
    const print = JSON.stringify([vitals, candidates, clashes, allowed, undo.map((u) => u.path)]);
    if (print === fingerprint) { renderUndo(); return; }
    fingerprint = print;
    renderHead();
    renderUndo();
    $('brain-controls-off').hidden = allowed;
    $('brain-candidates').replaceChildren(...(candidates.length
      ? candidates.map(candidateCard)
      : [el('p', 'Keine Kandidaten. Alles ist gesichtet.', 'empty')]));
    const tree = folderTree(vitals.folders || []);
    $('brain-folders').replaceChildren(...(tree.length ? tree : [el('p', 'Noch keine Notizen.', 'empty')]));
    renderClashes();
  }

  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    let body = null;
    try { body = await res.json(); } catch (error) { /* no JSON body */ }
    return { status: res.status, ok: res.ok, body };
  }

  async function load() {
    try {
      const [state, v, c, k] = await Promise.all([
        getJson('/api/v1/state').catch(() => null),
        getJson('/api/v1/brain/vitals'),
        getJson('/api/v1/brain/candidates'),
        getJson('/api/v1/brain/clashes'),
      ]);
      if (v.status === 404 || c.status === 404 || k.status === 404) {
        $('brain-off').hidden = false;
        $('brain-error').hidden = true;
        $('brain-main').hidden = true;
        setLive(true);
        return;
      }
      if (!v.ok || !c.ok || !k.ok) throw new Error('HTTP ' + (!v.ok ? v.status : !c.ok ? c.status : k.status));
      allowed = !!(state && state.ok && state.body && (!state.body.controls || state.body.controls.retry !== false));
      vitals = v.body;
      candidates = Array.isArray(c.body && c.body.candidates) ? c.body.candidates : (Array.isArray(c.body) ? c.body : []);
      clashes = Array.isArray(k.body && k.body.clashes) ? k.body.clashes : [];
      $('brain-off').hidden = true;
      $('brain-error').hidden = true;
      $('brain-main').hidden = false;
      setLive(true);
      render();
      await loadGraph();
    } catch (error) {
      setLive(false);
      $('brain-error').textContent = 'Brain-Daten konnten nicht geladen werden: ' + error.message;
      $('brain-error').hidden = false;
    }
  }

  load();
  live(load, pollEvery(load, 15000), 2000);
})();
`,
});
