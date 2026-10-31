import { CONTROLS_OFF } from './tasks-page.ts';
import { AURORA, escapeHtml, page } from './ui/layout.ts';

const BRAIN_CSS = `
  .br-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; }
  #brain-vitals { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin: 14px 0; }
  #brain-status { display: grid; gap: 8px; margin-bottom: 22px; }
  .br-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--text-2); }
  #candidates, #folders { margin-top: 22px; }
  #candidates h2, #folders h2 { margin: 0 0 10px; font: 600 10.5px var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--muted); }
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
`;

/** The Brain page: vitals with status bar, candidate review (promote, discard, undo) and the folder tree of the vault. */
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
      <section id="candidates" aria-labelledby="candidates-title">
        <h2 id="candidates-title">Kandidaten</h2>
        <p class="task-off" id="brain-controls-off" hidden>${escapeHtml(CONTROLS_OFF)}</p>
        <div id="brain-undo"></div>
        <div id="brain-candidates"></div>
      </section>
      <section id="folders" aria-labelledby="folders-title">
        <h2 id="folders-title">Ordner</h2>
        <div id="brain-folders"></div>
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

  function render() {
    const print = JSON.stringify([vitals, candidates, allowed, undo.map((u) => u.path)]);
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
  }

  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    let body = null;
    try { body = await res.json(); } catch (error) { /* no JSON body */ }
    return { status: res.status, ok: res.ok, body };
  }

  async function load() {
    try {
      const [state, v, c] = await Promise.all([
        getJson('/api/v1/state').catch(() => null),
        getJson('/api/v1/brain/vitals'),
        getJson('/api/v1/brain/candidates'),
      ]);
      if (v.status === 404 || c.status === 404) {
        $('brain-off').hidden = false;
        $('brain-error').hidden = true;
        $('brain-main').hidden = true;
        setLive(true);
        return;
      }
      if (!v.ok || !c.ok) throw new Error('HTTP ' + (v.ok ? c.status : v.status));
      allowed = !!(state && state.ok && state.body && (!state.body.controls || state.body.controls.retry !== false));
      vitals = v.body;
      candidates = Array.isArray(c.body && c.body.candidates) ? c.body.candidates : (Array.isArray(c.body) ? c.body : []);
      $('brain-off').hidden = true;
      $('brain-error').hidden = true;
      $('brain-main').hidden = false;
      setLive(true);
      render();
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
