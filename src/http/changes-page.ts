import { AURORA, page } from './ui/layout.ts';

const CHANGES_CSS = `
  .chg-bar-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; margin: 14px 0 18px; }
  .chg-repo { display: flex; align-items: center; gap: 8px; font: 600 10px var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
  .chg-repo select { min-width: 200px; letter-spacing: normal; text-transform: none; font-size: 12px; }
  .chg-grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 20px; align-items: start; }
  @media (max-width: 900px) { .chg-grid { grid-template-columns: minmax(0, 1fr); } }
  #changes-feed { display: grid; gap: 12px; }
  .chg { padding: 14px 16px; border: 1px solid var(--line-2); border-radius: var(--radius-sm); background: var(--panel-2); display: grid; gap: 8px; min-width: 0; }
  .chg-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; font-size: 12px; color: var(--text-2); }
  .chg-title { margin: 0; font: 600 14px var(--sans); color: var(--text); overflow-wrap: anywhere; }
  .chg-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chg-files { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .chg-file { display: grid; grid-template-columns: minmax(0, 1fr) auto auto 90px; gap: 10px; align-items: center; font-size: 12px; }
  .chg-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chg-add { color: var(--green); font-variant-numeric: tabular-nums; }
  .chg-del { color: var(--red); font-variant-numeric: tabular-nums; }
  .chg-bar { display: flex; height: 6px; border-radius: 3px; background: rgba(255, 255, 255, .05); overflow: hidden; }
  .chg-bar-add { background: var(--green); }
  .chg-bar-del { background: var(--red); }
  .chg-note { border-left: 2px solid var(--violet); padding: 4px 10px; display: grid; gap: 4px; font-size: 12px; }
  .chg-note b { font: 600 10px var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
  .chg-diff { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; color: var(--text-2); }
  #changes-more { margin-top: 14px; }
  .chg-side { display: grid; gap: 16px; }
  .chg-side h2 { margin: 0 0 10px; font: 600 10.5px var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--muted); }
  .chg-box { padding: 14px 16px; border: 1px solid var(--line-2); border-radius: var(--radius-sm); background: var(--panel-2); }
  #changes-today { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  #changes-hotspots { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  #changes-hotspots li { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; }
  #changes-hotspots li span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

/** The Changes page: the feed of recorded commits and merges (and brain notes) with filters in the URL (`?type=&repo=`). */
export const CHANGES_HTML = page({
  title: 'Changes · Symphony',
  nav: 'changes',
  aurora: AURORA.changes,
  styles: CHANGES_CSS,
  body: `
  <section aria-labelledby="page-title">
    <h1 id="page-title">Changes</h1>
    <div class="chg-bar-row">
      <div id="changes-types"></div>
      <label class="chg-repo"><span>Repository</span><select id="changes-repo"><option value="">Alle Repositories</option></select></label>
    </div>
    <div class="chg-grid">
      <div>
        <div id="changes-feed"></div>
        <div id="changes-more"></div>
      </div>
      <aside class="chg-side" aria-label="Zahlen und Hotspots">
        <div class="chg-box"><h2>Heute in Zahlen</h2><div id="changes-today"></div></div>
        <div class="chg-box"><h2>Hotspots · 7 Tage</h2><ol id="changes-hotspots"></ol></div>
      </aside>
    </div>
  </section>`,
  scripts: `
(() => {
  const $ = (id) => document.getElementById(id);
  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const TYPES = [['all', 'Alle'], ['code', 'Code'], ['brain', 'Brain']];
  const PR_TONES = { success: 'green', pending: 'amber', failure: 'red', none: 'gray' };

  function readFilter() {
    const p = new URLSearchParams(location.search);
    const type = p.get('type');
    return { type: type === 'code' || type === 'brain' ? type : 'all', repo: p.get('repo') || '' };
  }
  let filter = readFilter();
  let counts = { all: 0, code: 0, brain: 0 };
  let knownRepos = [];
  let loaded = [];
  let generation = 0;

  function writeUrl() {
    const url = new URL(location.href);
    url.search = '';
    if (filter.type !== 'all') url.searchParams.set('type', filter.type);
    if (filter.repo) url.searchParams.set('repo', filter.repo);
    history.replaceState(null, '', url);
  }
  function setFilter(changes) {
    filter = { ...filter, ...changes };
    writeUrl();
    renderChips();
    loadPage(null);
  }

  function renderChips() {
    $('changes-types').replaceChildren(filterGroup('Typ', TYPES.map(([type, label]) => {
      const c = filterChip(label, { pressed: filter.type === type, count: counts[type], onClick: () => setFilter({ type }) });
      c.dataset.type = type;
      return c;
    })));
  }

  function renderRepos() {
    const names = new Set([...knownRepos, ...loaded.map((e) => e.repo)]);
    if (filter.repo) names.add(filter.repo);
    const select = $('changes-repo');
    const options = [...names].sort().map((name) => { const o = el('option', name); o.value = name; return o; });
    const all = el('option', 'Alle Repositories');
    all.value = '';
    select.replaceChildren(all, ...options);
    select.value = filter.repo;
  }

  function fileRow(file, maxTotal) {
    const row = el('li', null, 'chg-file');
    row.append(el('span', file.path, 'chg-path mono'));
    if (file.added === null || file.deleted === null) {
      row.append(el('span', 'bin', 'chg-add mono'), el('span', '', 'chg-del mono'), el('span', '', 'chg-bar'));
      return row;
    }
    const bar = el('span', null, 'chg-bar');
    const add = el('span', null, 'chg-bar-add');
    const del = el('span', null, 'chg-bar-del');
    add.style.width = Math.round((file.added / maxTotal) * 100) + '%';
    del.style.width = Math.round((file.deleted / maxTotal) * 100) + '%';
    bar.append(add, del);
    row.append(el('span', '+' + file.added, 'chg-add mono'), el('span', '\\u2212' + file.deleted, 'chg-del mono'), bar);
    return row;
  }

  function renderEntry(e) {
    const box = el('article', null, 'chg');
    box.dataset.id = e.id;
    const head = el('div', null, 'chg-head');
    const time = el('time', fmtTime(e.at), 'mono');
    time.setAttribute('datetime', e.at);
    const issue = el('a', e.issue);
    issue.href = '/issue?id=' + encodeURIComponent(e.issue);
    head.append(time, el('span', e.repo, 'chg-repo-name'), issue, chip(e.role, { tone: uiOwn(UI_ROLE_COLORS, e.role) || 'gray', dot: true }));
    box.append(head, el('h3', e.title, 'chg-title'));
    if (e.type === 'brain') {
      const note = el('div', null, 'chg-note');
      note.append(el('b', 'Notiz'));
      if (e.files[0]) note.append(el('span', e.files[0].path, 'mono'));
      if (e.diff) note.append(el('pre', e.diff, 'chg-diff mono'));
      box.append(note);
    } else {
      const maxTotal = Math.max(1, ...e.files.map((f) => (f.added || 0) + (f.deleted || 0)));
      const list = el('ul', null, 'chg-files');
      for (const file of e.files) list.append(fileRow(file, maxTotal));
      box.append(list);
    }
    const chips = el('div', null, 'chg-chips');
    if (e.type === 'code' && e.pr) {
      const pr = chip('#' + e.pr.number, { tone: PR_TONES[e.pr.status] || 'gray', dot: true, mono: true });
      pr.classList.add('chg-pr');
      pr.title = 'Checks: ' + e.pr.status;
      chips.append(pr);
    }
    const status = chip(e.status, { tone: e.status === 'merged' ? 'violet' : 'sky' });
    status.classList.add('chg-status');
    chips.append(status);
    box.append(chips);
    return box;
  }

  function renderStats(stats) {
    if (!stats) return;
    const t = stats.today;
    $('changes-today').replaceChildren(
      kpi(fmtInt(t.commits), 'Commits'),
      kpi(fmtInt(t.merges), 'Merges'),
      kpi(fmtInt(t.files), 'Dateien'),
      kpi('+' + fmtInt(t.added) + ' / \\u2212' + fmtInt(t.deleted), 'Zeilen'),
    );
    const list = $('changes-hotspots');
    if (!stats.hotspots.length) { list.replaceChildren(el('li', 'Keine Änderungen in den letzten 7 Tagen.', 'empty')); return; }
    list.replaceChildren(...stats.hotspots.map((h) => {
      const li = el('li');
      const name = el('span', h.path, 'mono');
      name.title = h.repo;
      li.append(name, el('span', '\\u00d7' + h.count, 'mono'));
      return li;
    }));
  }

  async function loadPage(before) {
    const mine = before === null ? ++generation : generation;
    const query = new URLSearchParams({ limit: '50', tz: TZ });
    if (filter.type !== 'all') query.set('type', filter.type);
    if (filter.repo) query.set('repo', filter.repo);
    if (before) query.set('before', before);
    try {
      const res = await fetch('/api/v1/changes?' + query, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (mine !== generation) return;
      setLive(true);
      if (before === null) {
        loaded = [];
        counts = data.counts;
        renderChips();
        renderStats(data.stats);
        $('changes-feed').replaceChildren();
      }
      loaded.push(...data.entries);
      renderRepos();
      for (const entry of data.entries) $('changes-feed').append(renderEntry(entry));
      if (!loaded.length) $('changes-feed').replaceChildren(el('p', 'Noch keine Änderungen.', 'empty'));
      $('changes-more').replaceChildren();
      if (data.next_before) {
        const more = button('Mehr laden', { onClick: () => { more.disabled = true; loadPage(data.next_before); } });
        $('changes-more').append(more);
      }
    } catch (error) {
      if (mine !== generation) return;
      setLive(false);
      const failed = el('p', 'Änderungen konnten nicht geladen werden: ' + error.message, 'empty');
      if (before === null) { $('changes-feed').replaceChildren(failed); $('changes-more').replaceChildren(); }
      else {
        const retry = button('Erneut versuchen', { onClick: () => { retry.disabled = true; loadPage(before); } });
        $('changes-more').replaceChildren(failed, retry);
      }
    }
  }

  async function loadRepos() {
    try {
      const res = await fetch('/api/v1/state', { cache: 'no-store' });
      if (!res.ok) return;
      const state = await res.json();
      const list = state && state.health && state.health.repositories;
      if (Array.isArray(list)) { knownRepos = list.filter((r) => typeof r === 'string'); renderRepos(); }
    } catch (error) { /* the select then lists the repositories of the loaded entries */ }
  }

  $('changes-repo').addEventListener('change', () => setFilter({ repo: $('changes-repo').value }));
  writeUrl();
  renderChips();
  renderRepos();
  loadRepos();
  loadPage(null);
})();
`,
});
