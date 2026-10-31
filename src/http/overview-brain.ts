/**
 * "Brain" and "Zugriffe" panels of the overview: vitals tiles (notes by status, candidates, links, orphans, writes
 * and reads today, last commit) and the access log with a filter chip per role and a search over path and purpose.
 * Without the Brain API (404 brain_disabled, network error) both panels stay hidden. Inlined into the page
 * (BRAIN_CSS/BRAIN_PANELS_HTML/BRAIN_JS after ALERTS_JS); all top-level names start with `brain`/`BRAIN_`/`renderBrain`/`loadBrain`.
 */
export const BRAIN_CSS = `
  .brain-row > section { flex: 1 1 340px; min-width: 0; }
  .brain-row > .brain-access { flex-grow: 2; }
  .brain-open { font-size: 13px; }
  .brain-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
  .brain-notes { grid-column: span 2; padding: 14px 16px; }
  .brain-notes-total { font: 600 24px var(--mono); }
  .brain-notes-label { font-size: 12.5px; color: var(--fg-3, var(--muted)); margin-bottom: 8px; }
  .brain-status { display: grid; grid-template-columns: 90px 36px 1fr; align-items: center; gap: 8px; font-size: 12px; margin-top: 4px; }
  .brain-status-n { font-family: var(--mono); text-align: right; }
  .brain-commit { margin: 12px 0 0; font-size: 12.5px; color: var(--fg-3, var(--muted)); }
  .brain-q { width: 220px; max-width: 100%; }
  .brain-roles { margin: 8px 0; }
  .brain-list { list-style: none; margin: 0; padding: 0; max-height: 420px; overflow: auto; }
  .brain-acc { display: grid; grid-template-columns: 70px 110px 60px minmax(0, 1.4fr) minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 6px 0; border-bottom: 1px solid rgba(255, 255, 255, .06); font-size: 12.5px; }
  .brain-acc > * { min-width: 0; }
  .brain-time, .brain-op, .brain-path { font-family: var(--mono); }
  .brain-path, .brain-purpose { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .brain-purpose { color: var(--fg-2, var(--text-2)); }
  .brain-acc .ui-chip { justify-self: start; }
  .brain-role { display: inline-flex; align-items: center; gap: 6px; }
  .brain-empty { padding: 14px 0; font-size: 12.5px; color: var(--fg-3, var(--muted)); }
  @media (max-width: 900px) { .brain-acc { grid-template-columns: 70px 1fr auto; } .brain-path, .brain-purpose { white-space: normal; } }
`;

export const BRAIN_PANELS_HTML = `
  <div class="ov-row brain-row" id="brain-row" hidden>
    <section class="panel brain-panel" id="brain-panel" aria-labelledby="brain-title" hidden>
      <div class="section-head">
        <h2 class="lbl" id="brain-title">Brain</h2>
        <a class="brain-open" href="/brain">Brain öffnen →</a>
      </div>
      <div class="brain-tiles" id="brain-tiles"></div>
      <p class="brain-commit" id="brain-commit" hidden></p>
    </section>
    <section class="panel brain-access" id="brain-access" aria-labelledby="brain-access-title" hidden>
      <div class="section-head">
        <h2 class="lbl" id="brain-access-title">Zugriffe</h2>
        <input type="search" id="brain-q" class="brain-q" placeholder="Notiz oder Zweck…" aria-label="Zugriffe nach Pfad und Zweck durchsuchen">
      </div>
      <div class="brain-roles" id="brain-roles"></div>
      <ol class="brain-list" id="brain-access-list"></ol>
    </section>
  </div>
`;

export const BRAIN_JS = `
  const BRAIN_LIMIT = 50;
  const BRAIN_DEBOUNCE_MS = 300;
  const BRAIN_STATUS = [
    ['approved', 'approved', UI_CHIP_TONES.green.c],
    ['candidate', 'Kandidat', UI_CHIP_TONES.amber.c],
    ['deprecated', 'deprecated', UI_CHIP_TONES.red.c],
    ['none', 'ohne Status', UI_CHIP_TONES.gray.c],
  ];

  const brainFilter = { role: null, q: '' };
  const brainRoles = [];
  let brainSeq = 0;
  let brainTimer = null;

  function brainValidVitals(v) {
    if (!v || typeof v !== 'object' || !v.notes_by_status || typeof v.notes_by_status !== 'object') return false;
    return ['links', 'orphans', 'candidates', 'writes_today', 'reads_today'].every((k) => typeof v[k] === 'number');
  }

  function brainAccessUrl(filter) {
    let url = '/api/v1/brain/access?limit=' + BRAIN_LIMIT;
    if (filter.role) url += '&role=' + encodeURIComponent(filter.role);
    if (filter.q) url += '&q=' + encodeURIComponent(filter.q);
    return url;
  }

  function brainClock(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '--:--:--';
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function brainNum(n) {
    return typeof n === 'number' && Number.isFinite(n) ? fmtInt(n) : '—';
  }

  function brainRoleName(role) {
    return uiOwn(UI_ROLE_NAMES, role) || (role ? String(role) : '—');
  }

  function brainRoleColor(role) {
    return uiOwn(UI_ROLE_COLORS, role) || UI_ROLE_COLORS.symphony;
  }

  function brainRow(e) {
    const li = el('li', null, 'brain-acc');
    const role = el('span', null, 'brain-role');
    if (e.role) role.append(uiDot(brainRoleColor(e.role)));
    role.append(el('span', brainRoleName(e.role)));
    const path = el('span', e.path_or_query || '—', 'brain-path');
    path.setAttribute('title', String(e.path_or_query || ''));
    const purposeText = typeof e.purpose === 'string' ? e.purpose.trim() : '';
    const purpose = purposeText
      ? el('span', purposeText, 'brain-purpose')
      : chip('Zweck fehlt', { tone: 'amber' });
    if (!purposeText) purpose.classList.add('brain-nopurpose');
    else purpose.setAttribute('title', purposeText);
    const ok = e.result !== 'rejected';
    const result = chip(ok ? 'ok' : 'abgewiesen', { tone: ok ? 'green' : 'red' });
    if (e.reason) result.setAttribute('title', String(e.reason));
    li.append(el('span', brainClock(e.at), 'brain-time'), role, el('span', e.op || '—', 'brain-op'), path, purpose, result);
    return li;
  }

  function renderBrainVitals(tiles, commit, v, now) {
    const counts = BRAIN_STATUS.map(([key]) => (typeof v.notes_by_status[key] === 'number' ? v.notes_by_status[key] : 0));
    const total = counts.reduce((a, b) => a + b, 0);
    const notes = el('div', null, 'brain-notes gi');
    notes.append(el('div', fmtInt(total), 'brain-notes-total'), el('div', 'Notizen', 'brain-notes-label'));
    BRAIN_STATUS.forEach(([, label, color], i) => {
      const line = el('div', null, 'brain-status');
      line.append(el('span', label), el('span', fmtInt(counts[i]), 'brain-status-n'), bar(total ? (counts[i] / total) * 100 : 0, { height: 6, color }));
      notes.append(line);
    });
    patchChildren(tiles, [
      notes,
      kpi(brainNum(v.candidates), 'Kandidaten', v.candidates > 0 ? { color: UI_CHIP_TONES.amber.c } : {}),
      kpi(brainNum(v.links), 'Links'),
      kpi(brainNum(v.orphans), 'Waisen', v.broken_links > 0 ? { sub: fmtInt(v.broken_links) + ' kaputte Links' } : {}),
      kpi(brainNum(v.writes_today), 'Writes heute'),
      kpi(brainNum(v.reads_today), 'Reads heute'),
    ]);
    const last = v.last_commit;
    if (last && typeof last === 'object') {
      commit.textContent = 'Letzter Commit ' + agoDe(last.at, now) + ' von ' + (last.author || 'unbekannt');
      commit.setAttribute('title', String(last.sha || '').slice(0, 7) + ' · ' + String(last.at || ''));
      commit.hidden = false;
    } else {
      commit.hidden = true;
    }
  }

  function renderBrainAccess(list, entries) {
    if (!entries.length) {
      const filtered = brainFilter.role || brainFilter.q;
      list.replaceChildren(el('li', filtered ? 'Keine Treffer' : 'Noch keine Zugriffe', 'brain-empty'));
      return;
    }
    list.replaceChildren(...entries.map(brainRow));
  }

  function renderBrainRoles(host) {
    patchChildren(host, [filterGroup('Rolle', brainRoles.map((r) => filterChip(brainRoleName(r), {
      color: brainRoleColor(r),
      pressed: brainFilter.role === r,
      onClick: (next) => { brainFilter.role = next ? r : null; renderBrainRoles(host); loadBrain(); },
    })))]);
  }

  async function brainFetch(url) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res || !res.ok) return null;
      return await res.json();
    } catch (err) {
      return null;
    }
  }

  function brainShow(on) {
    for (const id of ['brain-row', 'brain-panel', 'brain-access']) document.getElementById(id).hidden = !on;
  }

  async function loadBrain() {
    const seq = ++brainSeq;
    const [vitals, page] = await Promise.all([brainFetch('/api/v1/brain/vitals'), brainFetch(brainAccessUrl(brainFilter))]);
    if (seq !== brainSeq) return;
    const ok = brainValidVitals(vitals) && !!page && Array.isArray(page.access);
    brainShow(ok);
    if (!ok) return;
    for (const e of page.access) if (e && e.role && !brainRoles.includes(e.role)) brainRoles.push(e.role);
    renderBrainVitals(document.getElementById('brain-tiles'), document.getElementById('brain-commit'), vitals, Date.now());
    renderBrainRoles(document.getElementById('brain-roles'));
    renderBrainAccess(document.getElementById('brain-access-list'), page.access.filter((e) => e && typeof e === 'object'));
  }

  function brainBind(input) {
    input.addEventListener('input', () => {
      clearTimeout(brainTimer);
      brainTimer = setTimeout(() => { brainFilter.q = input.value.trim(); loadBrain(); }, BRAIN_DEBOUNCE_MS);
    });
  }
`;
