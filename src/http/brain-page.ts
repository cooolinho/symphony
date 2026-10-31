import { CONTROLS_OFF } from './tasks-page.ts';
import { AURORA, escapeHtml, page } from './ui/layout.ts';

/** Where the disabled page points to; the dashboard does not serve the documentation itself. */
export const BRAIN_DOCS_URL = 'https://github.com/cooolinho/symphony/blob/main/docs/brain.md';

const BRAIN_CSS = `
  #brain-sub code { font: 500 13.5px var(--mono); color: var(--fg-chip); overflow-wrap: anywhere; }
  #brain-off { margin: 14px 4px 0; font-size: 14px; color: var(--fg-2); }
  #brain-off code { font: 500 13px var(--mono); color: var(--fg-chip); }
  #brain-main { display: flex; flex-direction: column; gap: 18px; margin-top: 18px; }
  .br-vitals { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; padding: 14px; }
  .br-notes { grid-column: span 2; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .br-notes-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .br-notes-label { font-size: 13px; color: var(--fg-2); }
  .br-notes-value { font: 500 26px/1.2 var(--mono); font-variant-numeric: tabular-nums; color: var(--fg-strong); }
  .br-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; font-size: 12px; color: var(--fg-2); }
  .br-legend-item { display: inline-flex; align-items: center; gap: 6px; }
  @media (max-width: 380px) { .br-notes { grid-column: auto; } }
  .br-columns { display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-start; }
  .br-cands { flex: 999 1 620px; min-width: 0; padding: 18px; }
  .br-side { flex: 1 1 380px; min-width: 0; display: flex; flex-direction: column; gap: 18px; }
  .br-side > section, .br-clashes { padding: 18px; }
  .br-count { font: 500 12px var(--mono); color: var(--fg-2); }
  .br-intro { margin: -4px 0 12px; font-size: 13px; color: var(--fg-3); }
  #brain-candidates { display: grid; gap: 12px; }
  .br-cand { padding: 14px 16px; display: grid; gap: 8px; min-width: 0; }
  .br-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; font-size: 12px; color: var(--fg-2); }
  .br-meta .mono { font-size: 12px; }
  .br-role { display: inline-flex; align-items: center; gap: 6px; }
  .br-type.ui-chip { font-size: 11px; }
  .br-title { margin: 0; font: 600 15px/1.35 var(--sans); color: var(--fg-strong); overflow-wrap: anywhere; }
  .br-target { font: 500 12px var(--mono); color: var(--fg-3); overflow-wrap: anywhere; }
  .br-excerpt { margin: 0; font-size: 13px; line-height: 1.5; color: var(--fg-chip); overflow-wrap: anywhere; }
  .br-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .br-msg { margin: 0; font-size: 12px; color: var(--red); }
  .br-msg:empty { display: none; }
  #brain-graph-repo { color: var(--fg-chip); }
  #brain-graph-root { font: 500 12px var(--mono); color: var(--text); background: var(--panel-2); border: 1px solid var(--line-2); border-radius: var(--radius-sm); padding: 4px 8px; min-height: 32px; }
  #brain-graph .empty { margin: 0; padding: 14px 0; }
  .br-graph { display: block; width: 100%; height: auto; }
  .br-graph text { font-family: var(--mono); fill: var(--fg-2); }
  .node { animation: breathe 4s ease-in-out infinite; }
  #brain-graph-text { margin: 8px 0 0; font-size: 12px; color: var(--fg-3); }
  #brain-graph-legend { margin-top: 8px; }
  .br-legend-dash { display: inline-block; width: 16px; border-top: 1.5px dashed #f87171; }
  .br-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; padding: 8px 0; border-top: 1px solid rgba(255, 255, 255, .06); }
  .br-row-path { font: 500 13px var(--mono); overflow-wrap: anywhere; }
  .br-row-count { font: 500 12.5px var(--mono); color: var(--fg-2); text-align: right; }
  .br-row-desc { grid-column: 1 / -1; font-size: 12px; color: var(--fg-3); }
  .br-clashes.has-open { border-color: rgba(248, 113, 113, .35); }
  .br-clashes .lbl { color: #fca5a5; }
  #brain-clashes, #brain-clashes-resolved > div { display: grid; gap: 12px; }
  #brain-clashes .empty { margin: 0; }
  .br-clash { padding: 14px 16px; display: grid; gap: 8px; min-width: 0; border-color: rgba(248, 113, 113, .4); animation: br-in .2s ease-out both; }
  .br-clash.is-resolved { border-color: rgba(255, 255, 255, .07); }
  .br-clash-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 12px; }
  .br-clash-path { font-weight: 600; color: var(--fg-strong); overflow-wrap: anywhere; }
  .br-clash-time { font: 500 12px var(--mono); color: var(--fg-2); }
  .br-clash-text { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--fg-chip); }
  .br-week { margin: 12px 0 0; font-size: 12px; color: var(--fg-3); }
  #brain-clashes-resolved { margin-top: 12px; }
  #brain-clashes-resolved > summary { cursor: pointer; font-size: 12px; color: var(--fg-2); margin-bottom: 10px; }
  @keyframes br-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  .br-diff { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); border: 1px solid var(--line-2); border-radius: var(--radius-sm); overflow: hidden; font: 11px/1.5 var(--mono); }
  .br-diff[hidden], .br-diff-wrap[hidden] { display: none; }
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
    .node { animation: none; }
    .br-clash { animation: none; }
  }
`;

/**
 * The Brain page: title block with vault path, commit count and Obsidian link; vitals (status bar and four tiles); candidate
 * review (promote, edit in Obsidian, discard, undo per card); the graph around a repository index (ring layout, folder
 * colours, at most 24 nodes); the vault structure; the write clashes with a side-by-side line diff and the week's balance.
 */
export const BRAIN_HTML = page({
  title: 'Brain · Symphony',
  nav: 'brain',
  aurora: AURORA.brain,
  styles: BRAIN_CSS,
  body: `
  <div class="page-title">
    <div><h1 id="page-title">Brain</h1><p class="page-sub" id="brain-sub">Das gemeinsame Gedächtnis der Agents</p></div>
    <div class="page-title-right" id="brain-open"></div>
  </div>
  <p id="brain-off" hidden><span>Das Brain ist nicht aktiviert (</span><code>brain.enabled</code><span>). Einrichtung: </span><a href="${escapeHtml(BRAIN_DOCS_URL)}" target="_blank" rel="noopener noreferrer">docs/brain.md</a></p>
  <p id="brain-error" class="empty" hidden></p>
  <div id="brain-main">
    <section class="g br-vitals" id="brain-vitals" aria-label="Vitalwerte"></section>
    <div class="br-columns">
      <section class="g br-cands" id="candidates" aria-labelledby="candidates-title">
        <div class="panel-head"><h2 class="lbl" id="candidates-title">Kandidaten-Review</h2><span class="br-count" id="brain-cand-count" aria-live="polite"></span></div>
        <p class="br-intro">Neue Notizen der Agents. Erst nach dem Befördern bevorzugen Agents sie beim Lesen.</p>
        <p class="task-off" id="brain-controls-off" hidden>${escapeHtml(CONTROLS_OFF)}</p>
        <div id="brain-candidates"></div>
      </section>
      <div class="br-side">
        <section class="g" id="graph" aria-labelledby="graph-title">
          <div class="panel-head">
            <h2 class="lbl" id="graph-title">Graph · Ausschnitt <span id="brain-graph-repo"></span></h2>
            <select id="brain-graph-root" aria-label="Repository" hidden></select>
          </div>
          <div id="brain-graph"></div>
          <div id="brain-graph-legend" class="br-legend"></div>
          <p id="brain-graph-text" hidden></p>
        </section>
        <section class="g" id="folders" aria-labelledby="folders-title">
          <div class="panel-head"><h2 class="lbl" id="folders-title">Struktur</h2></div>
          <div id="brain-folders"></div>
        </section>
      </div>
    </div>
    <section class="g br-clashes" id="clashes" aria-labelledby="clashes-title">
      <div class="panel-head"><h2 class="lbl" id="clashes-title">Write-Clashes</h2></div>
      <p class="task-off" id="brain-clash-controls-off" hidden>${escapeHtml(CONTROLS_OFF)}</p>
      <div id="brain-clashes"></div>
      <p class="br-week" id="brain-clash-week"></p>
      <details id="brain-clashes-resolved" hidden><summary></summary><div></div></details>
    </section>
  </div>`,
  scripts: `
(() => {
  const $ = (id) => document.getElementById(id);
  const CONTROLS_OFF = ${JSON.stringify(CONTROLS_OFF)};
  const SAFE_URL = /^(https?|obsidian):\\/\\/\\S/i;
  const SUB = 'Das gemeinsame Gedächtnis der Agents';
  const STATUS_COLORS = { approved: '#34d399', candidate: '#fbbf24', deprecated: '#64748b' };
  const TYPE_NAMES = { lesson: 'Lesson', index: 'Repo-Wissen', decision: 'Entscheidung', agent: 'Agent-Notiz' };
  const FOLDER_COLORS = { Repos: '#38bdf8', Decisions: '#a78bfa', Lessons: '#34d399', Inbox: '#fbbf24', Agents: '#f472b6', Issues: '#94a3b8' };
  const FOLDER_FALLBACK = '#94a3b8';
  const BROKEN = '#f87171';
  const GRAPH_MAX = 24;
  const STRUCTURE = [
    ['README.md', null, 'Regeln für Menschen und Agents', 'var(--fg-strong)'],
    ['Inbox/', 'Inbox', 'Kandidaten, warten auf Review', '#fbbf24'],
    ['Repos/<repo>/', 'Repos', 'Wissen je Repository, Einstieg index.md', '#38bdf8'],
    ['Decisions/', 'Decisions', 'Entscheidungen im ADR-Stil', '#a78bfa'],
    ['Lessons/', 'Lessons', 'Gelerntes aus Fehlern und Reviews', '#34d399'],
    ['Issues/<repo>/', 'Issues', 'Zusammenfassungen nach dem Merge, von Symphony', '#94a3b8'],
    ['Agents/<rolle>.md', 'Agents', 'Gedächtnis je Rolle', '#f9a8d4'],
  ];
  let allowed = false;
  let vitals = null;
  let candidates = [];
  /** Candidates decided on this page: path → { c, action, path (where the note is now) }; shown with a chip and "Rückgängig". */
  const decided = new Map();
  let fingerprint = '';
  let clashes = [];
  /** Open state of the clash comparisons the user toggled (key c:<id>). */
  const diffOpen = new Map();
  let graph = null;
  let graphRoot = null;
  let graphPrint = '';
  let graphSeq = 0;

  const deInt = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0).toLocaleString('de-DE');
  const deOne = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const hm = (iso) => {
    const d = new Date(iso || '');
    return Number.isNaN(d.getTime()) ? '—' : pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  };

  /** "gerade eben", "vor 4 min", "vor 1 h", "vor 1 Tag", "vor 2 Tagen"; "—" without a date. */
  function ageDe(created) {
    if (!created) return '—';
    const iso = /^\\d{4}-\\d{2}-\\d{2}$/.test(created) ? created + 'T00:00:00Z' : created;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return '—';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'gerade eben';
    if (s < 3600) return 'vor ' + Math.floor(s / 60) + ' min';
    if (s < 86400) return 'vor ' + Math.floor(s / 3600) + ' h';
    const days = Math.floor(s / 86400);
    return days === 1 ? 'vor 1 Tag' : 'vor ' + days + ' Tagen';
  }

  const typeName = (type) => uiOwn(TYPE_NAMES, String(type || '').toLowerCase()) || 'Sonstiges';
  const folderOf = (path) => {
    const i = String(path).lastIndexOf('/');
    return i < 0 ? '' : String(path).slice(0, i + 1);
  };
  /** "Inbox/ → Lessons/": the folder of the candidate and the folder it moves to (from target or the type folder). */
  function targetLine(c) {
    const target = String(c.target || '');
    const to = target.endsWith('/') ? target : /\\.md$/i.test(target) ? folderOf(target) : target ? target + '/' : '';
    return (folderOf(c.path) || '/') + ' → ' + (to || '?');
  }
  /** The first 200 characters of the body (the API sends it without frontmatter), line breaks as spaces. */
  function excerpt(text) {
    const flat = String(text || '').replace(/\\s+/g, ' ').trim();
    return flat.length > 200 ? flat.slice(0, 200).trimEnd() + '…' : flat;
  }
  const safeUrl = (href) => (typeof href === 'string' && SAFE_URL.test(href) ? href : null);

  function editHref(path) {
    const base = safeUrl(vitals && vitals.obsidian_url);
    if (!base) return null;
    if (!/^obsidian:/i.test(base)) return base;
    return base + (base.includes('?') ? '&' : '?') + 'file=' + encodeURIComponent(path.replace(/\\.md$/i, ''));
  }

  function renderHead() {
    const v = vitals;
    const sub = $('brain-sub');
    const commits = v.commits && typeof v.commits.total === 'number' ? v.commits.total : 0;
    sub.replaceChildren(el('span', SUB + ' · Vault '), el('code', v.path || '—'), el('span', ' · ' + deInt(commits) + (commits === 1 ? ' Commit' : ' Commits')));
    const url = safeUrl(v.obsidian_url);
    $('brain-open').replaceChildren(...(url ? [button('In Obsidian öffnen ↗', { size: 40, tone: 'obsidian', href: url })] : []));
  }

  function notesCard(v) {
    const by = v.notes || v.notes_by_status || {};
    const n = (k) => (typeof by[k] === 'number' ? by[k] : 0);
    const total = typeof by.total === 'number' ? by.total : n('approved') + n('candidate') + n('deprecated') + n('none');
    const box = el('div', null, 'gi br-notes');
    const head = el('div', null, 'br-notes-head');
    head.append(el('span', 'Notizen', 'br-notes-label'), el('span', deInt(total), 'br-notes-value mono'));
    const parts = [['approved', 'approved'], ['candidate', 'Kandidaten'], ['deprecated', 'veraltet']].map(([k, label]) => ({ value: n(k), label, color: STATUS_COLORS[k] }));
    const legend = el('div', null, 'br-legend');
    for (const p of parts) {
      const s = el('span', null, 'br-legend-item');
      s.append(uiDot(p.color), el('span', deInt(p.value) + ' ' + p.label));
      legend.append(s);
    }
    box.append(head, stackedBar(parts), legend);
    return box;
  }

  function renderVitals() {
    const v = vitals;
    const links = v.links && typeof v.links === 'object' ? v.links : { total: v.links, per_note: 0 };
    const reads = v.reads_today && typeof v.reads_today === 'object' ? v.reads_today : { total: v.reads_today, by_folder: [] };
    const top = Array.isArray(reads.by_folder) && reads.by_folder.length ? reads.by_folder[0] : null;
    $('brain-vitals').replaceChildren(
      notesCard(v),
      kpi(deInt(links.total), 'Links', { color: '#38bdf8', sub: deOne(links.per_note) + ' je Notiz' }),
      kpi(deInt(v.orphans), 'Waisen', { color: '#a78bfa', sub: 'ohne ein- und ausgehende Links' }),
      kpi(deInt(v.broken_links), 'Kaputte Links', { color: BROKEN, sub: 'Ziel fehlt' }),
      kpi(deInt(v.writes_today) + ' / ' + deInt(reads.total), 'Writes / Reads heute', {
        sub: top ? deInt(top.pct) + ' % der Reads aus ' + top.folder + '/' : 'keine Reads heute',
      }),
    );
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

  /** Runs approve, reject or revert from a card; on success the decision (or its undo) is kept and the page reloads. */
  async function act(card, c, action) {
    const buttons = [...card.querySelectorAll('button')];
    const msg = card.querySelector('.br-msg');
    for (const b of buttons) b.disabled = true;
    msg.textContent = '';
    try {
      const d = decided.get(c.path);
      const { res, body } = await post(action === 'revert' ? d.path : c.path, action);
      if (!res.ok) { msg.textContent = failure(res, body); for (const b of buttons) b.disabled = false; return; }
      if (action === 'revert') decided.delete(c.path);
      else decided.set(c.path, { c, action, path: typeof body.path === 'string' ? body.path : c.path });
      fingerprint = '';
      render();
      await load();
    } catch (error) {
      msg.textContent = 'Fehlgeschlagen: ' + error.message;
      for (const b of buttons) b.disabled = false;
    }
  }

  function issueNode(c) {
    if (!c.issue) return null;
    const issue = String(c.issue);
    const hash = issue.lastIndexOf('#');
    const id = /^\\d+$/.test(issue) && c.repo ? c.repo + '#' + issue : hash > 0 ? issue : null;
    const label = /^\\d+$/.test(issue) ? '#' + issue : hash > 0 ? issue.slice(hash) : issue;
    if (!id) return el('span', label, 'mono');
    const a = el('a', label, 'mono');
    a.href = '/issue?id=' + encodeURIComponent(id);
    return a;
  }

  function candidateCard(c, decision) {
    const card = el('article', null, 'gi br-cand' + (decision ? ' is-decided' : ''));
    card.dataset.path = c.path;
    const meta = el('div', null, 'br-meta');
    if (c.role) {
      const color = uiOwn(UI_ROLE_COLORS, c.role) || FOLDER_FALLBACK;
      const role = el('span', null, 'br-role');
      role.style.color = color;
      role.append(uiDot(color), el('span', uiOwn(UI_ROLE_NAMES, c.role) || c.role));
      meta.append(role);
    }
    const issue = issueNode(c);
    if (issue) meta.append(issue);
    meta.append(el('span', ageDe(c.created), 'mono br-age'));
    const type = chip(typeName(c.type), { tone: 'violet' });
    type.classList.add('br-type');
    meta.append(type);
    card.append(meta, el('h3', c.title, 'br-title'), el('div', targetLine(c), 'br-target mono'));
    const text = excerpt(c.preview);
    if (text) card.append(el('p', text, 'br-excerpt'));
    const note = el('p', null, 'br-msg');
    note.setAttribute('role', 'status');
    const actions = el('div', null, 'br-actions');
    if (decision) {
      actions.append(decision.action === 'approve'
        ? chip('Befördert · approved', { tone: 'green', dot: true })
        : chip('Verworfen · deprecated', { tone: 'red', dot: true }));
      if (allowed) actions.append(button('Rückgängig', { size: 36, onClick: () => act(card, c, 'revert') }));
    } else if (allowed) {
      actions.append(button('Befördern', { size: 40, tone: 'approve', onClick: () => act(card, c, 'approve') }));
      const edit = editHref(c.path);
      if (edit) actions.append(button('In Obsidian bearbeiten ↗', { size: 40, tone: 'obsidian', href: edit }));
      actions.append(button('Verwerfen', { size: 40, tone: 'danger', onClick: () => { if (confirm('Kandidat ' + c.path + ' verwerfen?')) act(card, c, 'reject'); } }));
    }
    if (actions.children.length) card.append(actions);
    card.append(note);
    return card;
  }

  const byAge = (a, b) => {
    const x = a.created || null, y = b.created || null;
    if (x !== y) { if (x === null) return 1; if (y === null) return -1; return x < y ? -1 : 1; }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  };

  function renderCandidates() {
    const open = candidates.filter((c) => !decided.has(c.path));
    const list = [...open.map((c) => ({ c, d: null })), ...[...decided.values()].map((d) => ({ c: d.c, d }))].sort((a, b) => byAge(a.c, b.c));
    $('brain-cand-count').textContent = deInt(open.length) + ' offen von ' + deInt(open.length + decided.size);
    $('brain-controls-off').hidden = allowed || open.length === 0;
    const cards = list.map((x) => candidateCard(x.c, x.d));
    if (open.length === 0) cards.unshift(el('p', 'Keine Kandidaten offen – alles gesichtet', 'empty'));
    $('brain-candidates').replaceChildren(...cards);
  }

  function renderStructure(folders) {
    const totals = new Map((folders || []).map((f) => [f.path, f.total]));
    $('brain-folders').replaceChildren(...STRUCTURE.map(([label, key, desc, color]) => {
      const row = el('div', null, 'br-row');
      const path = el('span', label, 'br-row-path mono');
      path.style.color = color;
      row.append(path, el('span', key === null ? '' : deInt(totals.get(key) || 0), 'br-row-count mono'), el('span', desc, 'br-row-desc'));
      return row;
    }));
  }

  // Graph: ring layout by distance to the root (no physics, nothing animates positions).
  const GW = 360, GH = 220;
  const RADII = [0, 58, 92];
  const folderColor = (path) => uiOwn(FOLDER_COLORS, String(path).split('/')[0]) || FOLDER_FALLBACK;
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
    select.hidden = roots.length < 2;
    if (graphRoot) select.value = graphRoot;
    const current = roots.find((r) => r.root === graphRoot);
    $('brain-graph-repo').textContent = current ? current.label : '';
  }

  /**
   * The shown part of the graph: notes two links away are grouped by their first folder ("Inbox (3)") when there are two or
   * more, then at most GRAPH_MAX nodes (root, nearer first, most links first); radius 13 for the root, else 5..11 by links.
   */
  function graphView(g) {
    const degree = new Map();
    for (const e of g.edges) for (const p of [e.from, e.to]) degree.set(p, (degree.get(p) || 0) + 1);
    const members = new Map();
    for (const n of g.nodes) {
      if (n.depth !== 2 || n.missing) continue;
      const folder = String(n.path).split('/')[0];
      if (!members.has(folder)) members.set(folder, []);
      members.get(folder).push(n);
    }
    const rename = new Map();
    const nodes = g.nodes.filter((n) => !(n.depth === 2 && !n.missing && members.get(String(n.path).split('/')[0]).length >= 2));
    for (const [folder, list] of members) {
      if (list.length < 2) continue;
      const path = 'group:' + folder;
      for (const n of list) rename.set(n.path, path);
      nodes.push({ path, title: folder + ' (' + list.length + ')', folder, group: true, count: list.length, depth: 2 });
    }
    const seen = new Set();
    const edges = [];
    for (const e of g.edges) {
      const from = rename.get(e.from) || e.from, to = rename.get(e.to) || e.to;
      const key = from + '\\n' + to;
      if (from === to || seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, to, broken: !!e.broken });
    }
    const weight = (n) => (n.group ? n.count : degree.get(n.path) || 0);
    nodes.sort((a, b) => (a.path === g.root ? -1 : b.path === g.root ? 1 : 0) || a.depth - b.depth || weight(b) - weight(a) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const kept = nodes.slice(0, GRAPH_MAX);
    const keep = new Set(kept.map((n) => n.path));
    for (const n of kept) {
      n.r = n.path === g.root ? 13 : n.missing ? 5 : n.group ? Math.min(11, 5 + n.count) : Math.min(11, 5 + 2 * Math.max(0, (degree.get(n.path) || 1) - 1));
      n.color = n.group ? folderColor(n.folder) : folderColor(n.path);
    }
    return { root: g.root, nodes: kept, edges: edges.filter((e) => keep.has(e.from) && keep.has(e.to)), cut: nodes.length - kept.length };
  }

  /** Path to { x, y }: the root in the centre, each ring a link further out, children inside the sector of their parent. */
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
      if (n.path === g.root) continue;
      const parent = n.depth <= 1 ? g.root : (near.get(n.path) || []).filter((p) => depthOf.get(p) === n.depth - 1).sort()[0] || g.root;
      if (!kids.has(parent)) kids.set(parent, []);
      kids.get(parent).push(n);
    }
    const pos = new Map();
    const place = (path, depth, angle, width) => {
      const ring = RADII[Math.min(depth, RADII.length - 1)];
      pos.set(path, { x: +(GW / 2 + ring * 1.4 * Math.cos(angle)).toFixed(1), y: +(GH / 2 + ring * 0.95 * Math.sin(angle)).toFixed(1) });
      const list = kids.get(path) || [];
      list.forEach((child, i) => {
        if (pos.has(child.path)) return;
        place(child.path, child.depth, angle - width / 2 + (width * (i + 0.5)) / list.length, width / list.length);
      });
    };
    place(g.root, 0, -Math.PI / 2, 2 * Math.PI);
    return pos;
  }

  function graphSummary(g, view) {
    const broken = view.edges.filter((e) => e.broken).length;
    return fmtInt(view.nodes.length) + ' Knoten, ' + fmtInt(view.edges.length) + ' Kanten, ' + fmtInt(broken) + ' kaputte Links' +
      (view.cut > 0 || g.truncated ? ' · Ausschnitt, höchstens ' + GRAPH_MAX + ' Knoten' : '');
  }

  function graphLegend() {
    const items = Object.entries(FOLDER_COLORS).map(([label, color]) => {
      const s = el('span', null, 'br-legend-item');
      s.append(uiDot(color), el('span', label));
      return s;
    });
    const broken = el('span', null, 'br-legend-item');
    broken.append(el('span', null, 'br-legend-dash'), el('span', 'kaputter Link'));
    return [...items, broken];
  }

  function renderGraph() {
    const g = graph;
    const print = JSON.stringify([graphRoot, g]);
    if (print === graphPrint) return;
    graphPrint = print;
    const box = $('brain-graph');
    const text = $('brain-graph-text');
    if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges) || g.edges.length === 0) {
      box.replaceChildren(el('p', 'Keine Links', 'empty'));
      text.hidden = true;
      $('brain-graph-legend').replaceChildren();
      return;
    }
    const view = graphView(g);
    const pos = ringLayout(view);
    const summary = graphSummary(g, view);
    const svg = svgEl('svg', { viewBox: '0 0 ' + GW + ' ' + GH, class: 'br-graph', role: 'img', 'aria-label': 'Ausschnitt des Notiz-Graphen rund um ' + String(g.root).replace(/\\.md$/i, '') });
    for (const e of view.edges) {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) continue;
      svg.append(svgEl('line', e.broken
        ? { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'br-edge br-edge-broken', stroke: BROKEN, 'stroke-width': 1.5, 'stroke-dasharray': '3 3' }
        : { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'br-edge', stroke: 'rgba(255,255,255,.18)', 'stroke-width': 1 }));
    }
    const labelled = new Set([view.root, ...view.nodes.filter((n) => n.path !== view.root).sort((a, b) => b.r - a.r || (a.path < b.path ? -1 : 1)).slice(0, 4).map((n) => n.path)]);
    for (const n of view.nodes) {
      const p = pos.get(n.path);
      if (!p) continue;
      const circle = svgEl('circle', n.missing
        ? { cx: p.x, cy: p.y, r: n.r, class: 'node br-node-missing', fill: 'none', stroke: BROKEN, 'stroke-width': 1.5, 'stroke-dasharray': '2 2' }
        : { cx: p.x, cy: p.y, r: n.r, class: 'node' + (n.group ? ' br-node-group' : ''), fill: n.color });
      const title = svgEl('title');
      title.textContent = n.group ? n.title : n.path;
      circle.append(title);
      svg.append(circle);
      if (labelled.has(n.path)) {
        const label = svgEl('text', { x: p.x, y: +(p.y + n.r + 11).toFixed(1), 'text-anchor': 'middle', 'font-size': n.path === view.root ? 11 : 10 });
        label.textContent = short(n.group ? n.title : n.title || n.path);
        svg.append(label);
      }
    }
    box.replaceChildren(svg);
    text.textContent = summary;
    text.hidden = false;
    $('brain-graph-legend').replaceChildren(...graphLegend());
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
    loadGraph();
  });

  // Write clashes: both versions side by side with an own line diff (LCS).
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

  async function resolveClash(card, b, c) {
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

  /** "Developer": role name of run k of the clash. */
  function clashRole(c, k) {
    const role = (c.roles || [])[k];
    return role ? uiOwn(UI_ROLE_NAMES, role) || role : 'Unbekannte Rolle';
  }

  /** "Developer #7": role name and issue number of run k of the clash. */
  function clashWho(c, k) {
    const issue = (c.issues || [])[k];
    const name = clashRole(c, k);
    const hash = typeof issue === 'string' ? issue.lastIndexOf('#') : -1;
    const number = typeof issue === 'string' && issue !== '' ? (hash >= 0 ? issue.slice(hash + 1) : issue) : '';
    return number ? name + ' #' + number : name;
  }

  function clashText(c) {
    const at = c.at || [];
    const a = clashWho(c, 0), b = clashWho(c, 1);
    const minutes = vitals && typeof vitals.clash_window_min === 'number' ? vitals.clash_window_min : null;
    const how = c.reason === 'window'
      ? ' innerhalb des Schutzfensters' + (minutes === null ? '' : ' von ' + deInt(minutes) + ' min') + '.'
      : ' mit altem Hash.';
    return a + ' schrieb um ' + hm(at[0]) + ', ' + b + ' um ' + hm(at[1]) + how +
      ' Der zweite Schreibvorgang wurde abgewiesen; ' + clashRole(c, 1) + ' hat die aktuelle Fassung zurückbekommen.';
  }

  function clashCard(c, resolved) {
    const card = el('article', null, 'gi br-clash' + (resolved ? ' is-resolved' : ''));
    card.dataset.id = c.id;
    const head = el('div', null, 'br-clash-head');
    const path = el('span', c.path, 'br-clash-path');
    if (resolved) {
      const wrap = el('span');
      wrap.append(path, ' ', chip('gelöst', { tone: 'green' }));
      head.append(wrap);
    } else head.append(path);
    head.append(el('span', hm((c.at || [])[1]), 'br-clash-time mono'));
    card.append(head, el('p', clashText(c), 'br-clash-text'));
    const left = c.attempted ? ['Abgewiesene Fassung', c.attempted.content] : c.base ? ['Fassung bei der Abweisung', c.base.content] : null;
    const right = c.current ? ['Aktuelle Fassung', c.current.content] : ['Aktuelle Fassung (Notiz fehlt)', ''];
    const key = 'c:' + c.id;
    const diff = el('div', null, 'br-diff-wrap');
    diff.append(left ? diffGrid(left[0], right[0], lineDiff(left[1], right[1])) : el('p', 'Keine Fassung des abgewiesenen Runs gespeichert.', 'br-clash-text'));
    diff.hidden = !diffOpen.get(key);
    const actions = el('div', null, 'br-actions');
    const compare = button('Fassungen vergleichen', { size: 38, onClick: () => {
      const open = diff.hidden;
      diffOpen.set(key, open);
      diff.hidden = !open;
      compare.setAttribute('aria-expanded', String(open));
    } });
    compare.setAttribute('aria-expanded', String(!diff.hidden));
    actions.append(compare);
    if (allowed && !resolved) {
      const done = button('Als gelöst markieren', { size: 38, tone: 'approve', onClick: () => resolveClash(card, done, c) });
      actions.append(done);
    }
    const note = el('p', null, 'br-msg');
    note.setAttribute('role', 'status');
    card.append(actions, diff, note);
    return card;
  }

  function renderClashes() {
    const open = clashes.filter((c) => c.status !== 'resolved');
    const done = clashes.filter((c) => c.status === 'resolved');
    $('clashes').classList.toggle('has-open', open.length > 0);
    $('brain-clash-controls-off').hidden = allowed || open.length === 0;
    $('brain-clashes').replaceChildren(...(open.length ? open.map((c) => clashCard(c, false)) : [el('p', 'Keine offenen Clashes', 'empty')]));
    const week = (vitals.clashes && vitals.clashes.week) || { total: 0, resolved: 0 };
    const minutes = typeof vitals.clash_window_min === 'number' ? vitals.clash_window_min : null;
    $('brain-clash-week').textContent = 'Diese Woche: ' + deInt(week.total) + (week.total === 1 ? ' Clash, ' : ' Clashes, ') + deInt(week.resolved) + ' gelöst · ' +
      (minutes === null ? 'Schutzfenster unbekannt' : minutes === 0 ? 'Schutzfenster aus' : 'Schutzfenster ' + deInt(minutes) + ' min');
    const resolved = $('brain-clashes-resolved');
    resolved.hidden = done.length === 0;
    resolved.querySelector('summary').textContent = 'Gelöste Clashes (' + done.length + ')';
    resolved.querySelector('div').replaceChildren(...done.map((c) => clashCard(c, true)));
  }

  function render() {
    const print = JSON.stringify([vitals, candidates, clashes, allowed, [...decided.keys()]]);
    if (print === fingerprint) return;
    fingerprint = print;
    renderHead();
    renderVitals();
    renderCandidates();
    renderStructure(vitals.folders);
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
        $('brain-sub').replaceChildren(SUB);
        $('brain-open').replaceChildren();
        fingerprint = '';
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
