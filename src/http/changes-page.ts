import { CONTROLS_OFF } from './tasks-page.ts';
import { AURORA, page, pageHeader } from './ui/layout.ts';

const CHANGES_CSS = `
  .chg-right { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; }
  .chg-repo { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--fg-2); }
  .chg-repo select { min-height: 44px; border-radius: 999px; padding: 0 14px; background: rgba(255, 255, 255, .06); border: 1px solid rgba(255, 255, 255, .14); color: var(--fg); font: 500 14px var(--sans); }
  .chg-layout { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; margin-top: 18px; }
  .chg-feed { flex: 999 1 640px; min-width: 0; padding: 20px; }
  .chg-side { flex: 1 1 340px; min-width: 0; display: flex; flex-direction: column; gap: 20px; }
  .chg-side .g { padding: 20px; }
  .chg-side h2 { margin: 0 0 12px; }
  #changes-feed { display: flex; flex-direction: column; gap: 12px; }
  .chg-day { margin: 8px 0 0; color: #7dd3fc; }
  .chg-day:first-child { margin-top: 0; }
  .chg { padding: 16px; display: flex; gap: 14px; min-width: 0; }
  .chg-conflict { border-color: rgba(248, 113, 113, .45); }
  .chg-ico { flex: none; width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; }
  .chg-ico-code { background: rgba(125, 211, 252, .14); color: #7dd3fc; }
  .chg-ico-brain { background: rgba(251, 191, 36, .14); color: #fcd34d; }
  .chg-body { flex: 1; min-width: 0; display: grid; gap: 8px; }
  .chg-line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; font-size: 12.5px; color: var(--fg-2); }
  .chg-role { display: inline-flex; align-items: center; gap: 6px; }
  .chg-kind { font-size: 11px; }
  .chg-title { margin: 0; font: 600 15.5px var(--sans); color: var(--fg-strong, var(--fg)); overflow-wrap: anywhere; }
  .chg-meta { margin: 0; font-size: 12px; color: var(--fg-3); overflow-wrap: anywhere; }
  .chg-files { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .chg-file { display: grid; grid-template-columns: minmax(0, 1fr) 120px 84px; gap: 10px; align-items: center; font-size: 12.5px; }
  .chg-file-more { font-size: 12.5px; color: var(--fg-3); }
  .chg-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chg-nums { display: flex; gap: 8px; justify-content: flex-end; }
  .chg-add { color: #6ee7b7; font-variant-numeric: tabular-nums; }
  .chg-del { color: #fca5a5; font-variant-numeric: tabular-nums; }
  .chg-bar { display: flex; height: 6px; border-radius: 99px; background: rgba(255, 255, 255, .06); overflow: hidden; }
  .chg-bar-add { background: #6ee7b7; }
  .chg-bar-del { background: #fca5a5; }
  .chg-diff { margin: 0; padding: 10px 12px; border-radius: 10px; background: rgba(0, 0, 0, .3); font-size: 12.5px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .chg-diff .chg-dl { display: block; }
  .chg-dl-add { color: #6ee7b7; }
  .chg-dl-del { color: #fca5a5; }
  .chg-dl-ctx { color: var(--fg-2); }
  .chg-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
  .chg-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .chg-msg { margin: 0; font-size: 12px; color: var(--fg-2); }
  #changes-more { margin-top: 14px; display: flex; justify-content: center; }
  .chg-end { margin: 0; color: var(--fg-3); font-size: 12.5px; }
  #changes-today { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .chg-hot-h { margin: 12px 0 6px; font: 500 12.5px var(--sans); color: var(--fg-3); }
  .chg-hot-h:first-child { margin-top: 0; }
  .chg-hot { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 10px; font-size: 12.5px; }
  .chg-hot > span:nth-child(odd) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chg-clash { color: #fca5a5; }
`;

/** The Changes page: the feed of recorded commits and merges (and brain notes) with filters in the URL (`?type=&repo=&issue=`). */
export const CHANGES_HTML = page({
  title: 'Changes · Symphony',
  nav: 'changes',
  aurora: AURORA.changes,
  styles: CHANGES_CSS,
  body: `
  ${pageHeader({
    title: 'Changes',
    subtitle: 'Was sich im Code und im Brain geändert hat, neueste zuerst',
    right: '<div class="chg-right"><div id="changes-types"></div><label class="chg-repo"><span>Repository</span><select id="changes-repo"><option value="">Alle</option></select></label></div>',
  })}
  <div class="chg-layout">
    <section class="g chg-feed" aria-label="Änderungs-Feed">
      <div id="changes-feed"></div>
      <div id="changes-more"></div>
    </section>
    <aside class="chg-side" aria-label="Zahlen und Hotspots">
      <section class="g" aria-label="Heute in Zahlen"><h2 class="lbl">Heute in Zahlen</h2><div id="changes-today"></div></section>
      <section class="g" aria-label="Hotspots"><h2 class="lbl">Hotspots · 7 Tage</h2><div id="changes-hotspots"></div></section>
    </aside>
  </div>`,
  scripts: `
(() => {
  const $ = (id) => document.getElementById(id);
  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const CONTROLS_OFF = ${JSON.stringify(CONTROLS_OFF)};
  const KIND = {
    committed: 'Commit', merged: 'Merge', created: 'Notiz neu', updated: 'Notiz geändert', human: 'Notiz geändert',
    approved: 'Befördert', rejected_candidate: 'Verworfen', conflict: 'Schreiben abgewiesen',
  };
  const PR_TONES = { success: 'green', pending: 'amber', failure: 'red', none: 'gray' };
  const PR_TEXT = { success: ' \\u00b7 Checks grün', pending: ' \\u00b7 Checks laufen', failure: ' \\u00b7 Checks rot', none: '' };
  const VIOLET = '#c4b5fd';
  const DIFF_LINES = 5;
  const MAX_FILES = 8;
  const MAX_HOT = 5;

  function readFilter() {
    const p = new URLSearchParams(location.search);
    const type = p.get('type');
    return { type: type === 'code' || type === 'brain' ? type : 'all', repo: p.get('repo') || '', issue: p.get('issue') || '' };
  }
  let filter = readFilter();
  let counts = { all: 0, code: 0, brain: 0 };
  let knownRepos = [];
  let loaded = [];
  let generation = 0;
  let allowed = false;
  let brainOn = true;
  let obsidianUrl = null;
  let candidatePaths = new Set();
  let lastDay = null;

  function writeUrl() {
    const url = new URL(location.href);
    url.search = '';
    if (filter.type !== 'all') url.searchParams.set('type', filter.type);
    if (filter.repo) url.searchParams.set('repo', filter.repo);
    if (filter.issue) url.searchParams.set('issue', filter.issue);
    history.replaceState(null, '', url);
  }
  function setFilter(changes) {
    filter = { ...filter, ...changes };
    writeUrl();
    renderTypes();
    loadPage(null);
  }

  function renderTypes() {
    const options = [{ value: 'all', label: 'Alle', count: counts.all }, { value: 'code', label: 'Code', count: counts.code }];
    if (brainOn) options.push({ value: 'brain', label: 'Brain', count: counts.brain });
    $('changes-types').replaceChildren(segmented(options, filter.type, (type) => setFilter({ type }), 'Art der Änderung'));
  }

  function renderRepos() {
    const names = new Set([...knownRepos, ...loaded.map((e) => e.repo)]);
    if (filter.repo) names.add(filter.repo);
    const select = $('changes-repo');
    const options = [...names].sort().map((name) => { const o = el('option', name); o.value = name; return o; });
    const all = el('option', 'Alle');
    all.value = '';
    select.replaceChildren(all, ...options);
    select.value = filter.repo;
  }

  const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayKey = (ms) => dayFormat.format(ms);
  function dayLabel(at) {
    const ms = Date.parse(at);
    const key = dayKey(ms);
    const now = Date.now();
    const long = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(ms);
    if (key === dayKey(now)) return 'Heute \\u00b7 ' + long;
    if (key === dayKey(now - 86400000)) return 'Gestern \\u00b7 ' + long;
    const sameYear = key.slice(0, 4) === dayKey(now).slice(0, 4);
    return new Intl.DateTimeFormat('de-DE', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) }).format(ms);
  }
  const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });

  function fileRow(file, maxTotal) {
    const row = el('li', null, 'chg-file');
    row.append(el('span', file.path, 'chg-path mono'));
    const bar = el('span', null, 'chg-bar');
    const nums = el('span', null, 'chg-nums mono');
    if (file.added === null || file.deleted === null) {
      nums.append(el('span', 'bin', 'chg-add'));
    } else {
      const add = el('span', null, 'chg-bar-add');
      const del = el('span', null, 'chg-bar-del');
      add.style.width = Math.round((file.added / maxTotal) * 100) + '%';
      del.style.width = Math.round((file.deleted / maxTotal) * 100) + '%';
      bar.append(add, del);
      nums.append(el('span', '+' + file.added, 'chg-add'), el('span', '\\u2212' + file.deleted, 'chg-del'));
    }
    row.append(bar, nums);
    return row;
  }

  function fileList(files) {
    if (!files.length) return null;
    const maxTotal = Math.max(1, ...files.map((f) => (f.added || 0) + (f.deleted || 0)));
    const list = el('ul', null, 'chg-files');
    for (const file of files.slice(0, MAX_FILES)) list.append(fileRow(file, maxTotal));
    if (files.length > MAX_FILES) list.append(el('li', '+' + (files.length - MAX_FILES) + ' weitere', 'chg-file-more'));
    return list;
  }

  function diffBlock(diff) {
    if (!diff) return null;
    const lines = diff.split('\\n').slice(1).filter((l) => l.trim() !== '').slice(0, DIFF_LINES);
    if (!lines.length) return null;
    const pre = el('pre', null, 'chg-diff mono');
    for (const line of lines) pre.append(el('span', line, 'chg-dl ' + (line[0] === '+' ? 'chg-dl-add' : line[0] === '-' ? 'chg-dl-del' : 'chg-dl-ctx')));
    return pre;
  }

  function folderOf(p) { const i = p.lastIndexOf('/'); return i < 0 ? '/' : p.slice(0, i); }
  function isSummary(e) { return e.type === 'brain' && e.role === 'symphony' && !!e.files[0] && e.files[0].path.startsWith('Issues/'); }
  function metaText(e) {
    const file = e.files[0];
    if (e.type === 'code') {
      const hash = e.status === 'committed' ? e.id.split(':').pop().slice(0, 7) : '';
      return [e.repo, e.branch, hash].filter(Boolean).join(' \\u00b7 ');
    }
    if (isSummary(e)) return 'automatisch nach dem Merge \\u00b7 status: approved';
    if (e.status === 'conflict') {
      let text = e.reason === 'window' ? 'Schutzfenster' : 'Hash-Konflikt';
      if (e.other_role) text += ' \\u00b7 ' + e.other_role + (e.other_at ? ' schrieb um ' + clock(e.other_at) : '');
      return text;
    }
    return [file ? folderOf(file.path) : '', e.note_status ? 'status: ' + e.note_status : ''].filter(Boolean).join(' \\u00b7 ');
  }

  function isCandidate(e) {
    const file = e.files[0];
    return e.type === 'brain' && !isSummary(e) && (e.status === 'created' || e.status === 'updated') && !!file && candidatePaths.has(file.path);
  }
  function statusChip(e) {
    let text = null;
    let tone = 'gray';
    if (e.type === 'code') {
      if (e.status === 'merged') { text = 'gemerged'; tone = VIOLET; }
      else if (e.pr) { text = 'PR #' + e.pr.number + (PR_TEXT[e.pr.status] || ''); tone = PR_TONES[e.pr.status] || 'gray'; }
      else { text = 'kein PR'; }
    } else if (e.status === 'conflict') {
      if (e.clash_status === 'open') { text = 'Konflikt offen'; tone = 'red'; }
      else { text = e.clash_status === 'resolved' ? 'Konflikt gelöst' : 'Konflikt'; }
    } else if (e.status === 'rejected_candidate') { text = 'verworfen'; }
    else if (isCandidate(e)) { text = 'Kandidat · wartet auf dich'; tone = 'amber'; }
    else if (e.status === 'approved' || isSummary(e) || e.note_status === 'approved') { text = 'approved'; tone = 'green'; }
    else if (e.note_status) { text = e.note_status; }
    if (text === null) return null;
    const c = chip(text, { tone });
    c.classList.add('chg-status');
    return c;
  }

  async function loadVitals() {
    try {
      const res = await fetch('/api/v1/brain/vitals', { cache: 'no-store' });
      if (res.status === 404) { brainOn = false; return; }
      if (!res.ok) return;
      const body = await res.json();
      obsidianUrl = body && typeof body.obsidian_url === 'string' && body.obsidian_url !== '' ? body.obsidian_url : null;
    } catch (error) { /* unknown: keep the brain sections */ }
  }
  function obsidianHref(p) {
    if (!obsidianUrl) return null;
    if (!/^obsidian:/i.test(obsidianUrl)) return obsidianUrl;
    return obsidianUrl + (obsidianUrl.includes('?') ? '&' : '?') + 'file=' + encodeURIComponent(p.replace(/\\.md$/i, ''));
  }

  async function loadCandidates() {
    candidatePaths = new Set();
    if (!brainOn) return;
    try {
      const res = await fetch('/api/v1/brain/candidates', { cache: 'no-store' });
      if (!res.ok) return;
      const body = await res.json();
      if (body && Array.isArray(body.candidates)) candidatePaths = new Set(body.candidates.map((c) => c.path));
    } catch (error) { /* without brain there are no candidates */ }
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
  function settle(path, action) {
    candidatePaths.delete(path);
    for (const card of $('changes-feed').querySelectorAll('.chg')) {
      if (card.dataset.path !== path) continue;
      const actions = card.querySelector('.chg-actions');
      if (actions) actions.remove();
      const old = card.querySelector('.chg-status');
      const next = chip(action === 'approve' ? 'approved' : 'verworfen', { tone: action === 'approve' ? 'green' : 'gray' });
      next.classList.add('chg-status');
      const foot = card.querySelector('.chg-foot');
      foot.insertBefore(next, foot.firstChild);
      if (old) old.remove();
    }
  }
  async function act(box, path, action) {
    const buttons = [...box.querySelectorAll('.chg-actions button')];
    const msg = box.querySelector('.chg-msg');
    for (const b of buttons) b.disabled = true;
    msg.textContent = '';
    try {
      const { res, body } = await post(path, action);
      if (!res.ok) { msg.textContent = failure(res, body); for (const b of buttons) b.disabled = false; return; }
      settle(path, action);
    } catch (error) {
      msg.textContent = 'Fehlgeschlagen: ' + error.message;
      for (const b of buttons) b.disabled = false;
    }
  }
  function candidateActions(e, box) {
    if (!allowed || !isCandidate(e)) return null;
    const file = e.files[0];
    const msg = el('p', null, 'chg-msg');
    msg.setAttribute('role', 'status');
    const row = el('div', null, 'chg-actions');
    row.append(button('Befördern', { size: 40, tone: 'approve', onClick: () => act(box, file.path, 'approve') }));
    const href = obsidianHref(file.path);
    if (href) row.append(button('In Obsidian öffnen', { size: 40, tone: 'obsidian', icon: icon('arrow'), href }));
    row.append(
      button('Verwerfen', { size: 40, tone: 'danger', onClick: () => { if (confirm('Kandidat ' + file.path + ' verwerfen?')) act(box, file.path, 'reject'); } }),
      msg,
    );
    return row;
  }

  function roleLine(e) {
    const key = !e.role || e.role === 'symphony' ? 'symphony' : uiOwn(UI_ROLE_COLORS, e.role) ? e.role : 'symphony';
    const span = el('span', null, 'chg-role');
    span.append(uiDot(UI_ROLE_COLORS[key]), el('span', !e.role || e.role === 'symphony' ? 'Symphony' : e.role));
    return span;
  }

  function renderEntry(e) {
    const box = el('article', null, 'gi chg');
    box.dataset.id = e.id;
    if (e.files[0]) box.dataset.path = e.files[0].path;
    if (e.status === 'conflict') box.classList.add('chg-conflict');
    const ico = el('span', null, 'chg-ico ' + (e.type === 'brain' ? 'chg-ico-brain' : 'chg-ico-code'));
    ico.append(icon(e.type === 'brain' ? 'brain' : 'commit', 18));
    const body = el('div', null, 'chg-body');
    const line = el('div', null, 'chg-line');
    const time = el('time', clock(e.at), 'mono');
    time.setAttribute('datetime', e.at);
    line.append(time, roleLine(e));
    if (e.issue) {
      const issue = el('a', e.issue, 'mono');
      issue.href = '/issue?id=' + encodeURIComponent(e.issue);
      line.append(issue);
    }
    const kind = chip(KIND[e.status] || e.status);
    kind.classList.add('chg-kind');
    line.append(kind);
    body.append(line, el('h3', e.title, 'chg-title'));
    const meta = metaText(e);
    if (meta) body.append(el('p', meta, 'chg-meta mono'));
    const detail = e.type === 'code' ? fileList(e.files) : diffBlock(e.diff);
    if (detail) body.append(detail);
    const foot = el('div', null, 'chg-foot');
    const status = statusChip(e);
    if (status) foot.append(status);
    const actions = candidateActions(e, box);
    if (actions) foot.append(actions);
    if (foot.childNodes.length) body.append(foot);
    box.append(ico, body);
    return box;
  }

  function hotSection(title, rows) {
    return [el('h3', title, 'chg-hot-h'), (() => { const g = el('div', null, 'chg-hot mono'); g.append(...rows); return g; })()];
  }
  function renderStats(stats) {
    if (!stats) return;
    const t = stats.today;
    const open = stats.conflicts_open || 0;
    const conflicts = kpi(fmtInt(open), open === 1 ? 'Konflikt offen' : 'Konflikte offen', open > 0 ? { color: '#fca5a5' } : {});
    if (open === 0) conflicts.querySelector('.ui-kpi-value').style.color = 'var(--fg-3)';
    $('changes-today').replaceChildren(
      kpi(fmtInt(t.commits), 'Code-Commits'),
      kpi(fmtInt(t.brain || 0), 'Brain-Änderungen', { color: '#fcd34d' }),
      kpi(fmtInt(t.merges), 'PRs gemerged', { color: VIOLET }),
      conflicts,
    );
    const parts = [];
    const files = (stats.hotspots || []).slice(0, MAX_HOT);
    if (files.length) {
      const rows = files.flatMap((h) => { const name = el('span', h.path); name.title = h.repo; return [name, el('span', fmtInt(h.count) + '\\u00d7')]; });
      parts.push(...hotSection('Dateien', rows));
    }
    const notes = brainOn ? (stats.note_hotspots || []).slice(0, MAX_HOT) : [];
    if (notes.length) {
      const rows = notes.flatMap((h) => {
        const count = el('span', fmtInt(h.count) + '\\u00d7');
        if (h.clashes > 0) { count.textContent = fmtInt(h.count) + '\\u00d7 \\u00b7 ' + fmtInt(h.clashes) + ' Clash'; count.className = 'chg-clash'; }
        return [el('span', h.path), count];
      });
      parts.push(...hotSection('Notizen', rows));
    }
    $('changes-hotspots').replaceChildren(...(parts.length ? parts : [el('p', 'Keine Hotspots', 'empty')]));
  }

  async function loadPage(before) {
    const mine = before === null ? ++generation : generation;
    try {
      await Promise.all([stateReady, brainReady]);
      if (!brainOn && filter.type === 'brain') { filter = { ...filter, type: 'all' }; writeUrl(); renderTypes(); }
      const query = new URLSearchParams({ limit: '50', tz: TZ });
      const type = brainOn ? filter.type : 'code';
      if (type !== 'all') query.set('type', type);
      if (filter.repo) query.set('repo', filter.repo);
      if (filter.issue) query.set('issue', filter.issue);
      if (before) query.set('before', before);
      const [res] = await Promise.all([fetch('/api/v1/changes?' + query, { cache: 'no-store' }), before === null ? loadCandidates() : null]);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (mine !== generation) return;
      setLive(true);
      if (before === null) {
        loaded = [];
        lastDay = null;
        counts = data.counts;
        if (!brainOn) counts = { ...counts, all: counts.code };
        renderTypes();
        renderStats(data.stats);
        $('changes-feed').replaceChildren();
      }
      loaded.push(...data.entries);
      renderRepos();
      for (const entry of data.entries) {
        const day = dayKey(Date.parse(entry.at));
        if (day !== lastDay) { lastDay = day; $('changes-feed').append(el('div', dayLabel(entry.at), 'lbl chg-day')); }
        $('changes-feed').append(renderEntry(entry));
      }
      $('changes-more').replaceChildren();
      if (!loaded.length) {
        $('changes-feed').replaceChildren(el('p', 'Noch keine Änderungen für diesen Filter', 'empty'));
      } else if (data.next_before) {
        const more = button('Ältere laden', { onClick: () => { more.disabled = true; loadPage(data.next_before); } });
        $('changes-more').append(more);
      } else {
        $('changes-more').append(el('p', 'Keine älteren Änderungen', 'chg-end'));
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
      allowed = !state.controls || state.controls.retry !== false;
      const list = state && state.health && state.health.repositories;
      if (Array.isArray(list)) { knownRepos = list.filter((r) => typeof r === 'string'); renderRepos(); }
    } catch (error) { /* the select then lists the repositories of the loaded entries */ }
  }

  $('changes-repo').addEventListener('change', () => setFilter({ repo: $('changes-repo').value }));
  writeUrl();
  renderTypes();
  renderRepos();
  const stateReady = loadRepos();
  const brainReady = loadVitals();
  loadPage(null);
})();
`,
});
