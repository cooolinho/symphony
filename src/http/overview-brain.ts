/**
 * "Brain-Vitals" and "Brain-Zugriffe" panels of the overview: four vitals tiles with a footer (writes, reads, open
 * conflicts, last commit) and an Obsidian button, and the access log with role chips, a search over path and purpose,
 * day labels and three-column rows. Role filter and search work on the loaded rows (no request).
 * Without the Brain API (404 brain_disabled, network error) both panels stay hidden. Inlined into the page
 * (BRAIN_CSS/BRAIN_PANELS_HTML/BRAIN_JS after ALERTS_JS); all top-level names start with `brain`/`BRAIN_`/`renderBrain`/`loadBrain`.
 */
import { iconSvg } from './icons.ts';
import { OP_COLORS, SCALES, TEXT } from './ui/palette.ts';

export const BRAIN_CSS = `
  .brain-row > section { flex: 1 1 340px; min-width: 0; }
  .brain-row > .brain-access { flex-grow: 2; }
  .brain-head-action { display: inline-flex; }
  .brain-tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .brain-foot { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 12px 0 0; font: 12px var(--mono); color: var(--fg-3, var(--muted)); }
  .brain-access { display: flex; flex-direction: column; gap: 12px; }
  .brain-access > .section-head { margin: 0; }
  #brain-count { font: 12px var(--mono); color: var(--fg-3, var(--muted)); }
  .brain-search { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 14px; border-radius: 14px; background: rgba(0, 0, 0, .25); border: 1px solid rgba(255, 255, 255, .08); color: var(--fg-3, var(--muted)); }
  .brain-search svg { flex: none; }
  .brain-search input { flex: 1; min-width: 0; min-height: 44px; background: transparent; border: 0; outline: 0; color: var(--fg); font: inherit; }
  .brain-day { color: ${SCALES.sky[300]}; margin: 4px 0 0; }
  .brain-list { list-style: none; margin: 0; padding: 0; }
  .brain-acc { display: grid; grid-template-columns: 64px 104px minmax(0, 1fr); gap: 4px 12px; padding: 11px 8px; border-top: 1px solid rgba(255, 255, 255, .06); }
  .brain-acc > * { min-width: 0; }
  .brain-time { font: 12.5px var(--mono); color: var(--fg-2, var(--text-2)); }
  .brain-role { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; }
  .brain-op { display: block; font: 11.5px var(--mono); letter-spacing: .06em; }
  .brain-note { display: flex; flex-direction: column; gap: 2px; }
  .brain-name { font-size: 13.5px; font-weight: 500; overflow-wrap: anywhere; }
  .brain-folder { font-size: 12px; color: var(--fg-3, var(--muted)); }
  .brain-purpose { font-size: 12.5px; font-style: italic; color: var(--fg-2, var(--text-2)); }
  .brain-purpose.brain-nopurpose { color: ${TEXT.fgFaint}; }
  .brain-empty { padding: 14px 0; font-size: 12.5px; color: var(--fg-3, var(--muted)); }
`;

export const BRAIN_PANELS_HTML = `
  <div class="ov-row brain-row" id="brain-row" hidden>
    <section class="panel brain-panel" id="brain-panel" aria-labelledby="brain-title" hidden>
      <div class="section-head">
        <h2 class="lbl" id="brain-title">Brain-Vitals</h2>
        <span class="brain-head-action" id="brain-obsidian"></span>
      </div>
      <div class="brain-tiles" id="brain-tiles"></div>
      <p class="brain-foot" id="brain-foot"></p>
    </section>
    <section class="panel brain-access" id="brain-access" aria-labelledby="brain-access-title" hidden>
      <div class="section-head">
        <h2 class="lbl" id="brain-access-title">Brain-Zugriffe</h2>
        <span class="mono" id="brain-count"></span>
      </div>
      <div class="brain-roles" id="brain-roles"></div>
      <label class="brain-search" for="brain-q">
        ${iconSvg('search', 16)}
        <span class="sr">Zugriffe durchsuchen</span>
        <input type="search" id="brain-q" placeholder="Notiz oder Zweck suchen" autocomplete="off">
      </label>
      <div id="brain-access-list"></div>
    </section>
  </div>
`;

export const BRAIN_JS = `
  const BRAIN_LIMIT = 50;
  const BRAIN_AMBER = '${SCALES.amber[400]}';
  const BRAIN_SKY = '${SCALES.sky[300]}';
  const BRAIN_VIOLET = '${SCALES.violet[300]}';
  const BRAIN_GRAY = '${SCALES.gray[400]}';
  const BRAIN_OPS = {
    read: ['READ', '${OP_COLORS.read}'], write: ['WRITE', '${OP_COLORS.write}'], append: ['APPEND', '${SCALES.amber[400]}'],
    search: ['SEARCH', '${OP_COLORS.search}'], list: ['LIST', '${SCALES.gray[400]}'],
  };
  const BRAIN_HIDDEN_ROLES = ['docs', 'symphony', 'human'];

  const brainFilter = { role: null, q: '' };
  let brainEntries = [];
  let brainProfileRoles = [];
  let brainSeq = 0;

  function brainValidVitals(v) {
    if (!v || typeof v !== 'object' || !v.notes_by_status || typeof v.notes_by_status !== 'object') return false;
    if (!v.links || typeof v.links.total !== 'number' || !v.reads_today || typeof v.reads_today.total !== 'number') return false;
    return ['orphans', 'candidates', 'writes_today'].every((k) => typeof v[k] === 'number');
  }

  function brainInt(n) {
    return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('de-DE') : '—';
  }

  function brainClock(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '--:--:--';
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function brainRoleName(role) {
    return uiOwn(UI_ROLE_NAMES, role) || (role ? String(role) : 'Symphony');
  }

  function brainRoleColor(role) {
    return uiOwn(UI_ROLE_COLORS, role) || UI_ROLE_COLORS.symphony;
  }

  function brainOp(e) {
    if (e.result === 'rejected') return { label: 'ABGEWIESEN', color: '${OP_COLORS.denied}' };
    const known = uiOwn(BRAIN_OPS, e.op);
    if (known) return { label: known[0], color: known[1] };
    return { label: e.op ? String(e.op).toUpperCase() : '—', color: BRAIN_GRAY };
  }

  function brainFolder(e) {
    const path = typeof e.path_or_query === 'string' ? e.path_or_query : '';
    if (e.op === 'search') return 'Suche';
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '/';
    if (path.startsWith('Inbox/')) return 'Inbox/ · Kandidat';
    if (path.startsWith('Issues/')) return dir + ' · approved';
    return dir;
  }

  function brainDayStart(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  function brainDayLabel(dayStart, now) {
    const d = new Date(dayStart);
    const text = d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
    const today = new Date(now);
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (dayStart === todayStart.getTime()) return 'Heute · ' + text;
    if (dayStart === new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() - 1).getTime()) return 'Gestern · ' + text;
    return text;
  }

  function brainMatches(e) {
    if (brainFilter.role) {
      if (brainFilter.role === 'symphony') { if (e.role && e.role !== 'symphony') return false; }
      else if (e.role !== brainFilter.role) return false;
    }
    if (!brainFilter.q) return true;
    return (String(e.path_or_query || '') + ' ' + String(e.purpose || '')).toLowerCase().includes(brainFilter.q);
  }

  function brainRow(e) {
    const li = el('li', null, 'row brain-acc');
    const who = el('div', null, 'brain-who');
    const role = el('span', null, 'brain-role');
    const issue = typeof e.issue === 'string' ? e.issue.slice(e.issue.lastIndexOf('#')) : '';
    role.style.color = brainRoleColor(e.role);
    role.append(uiDot(brainRoleColor(e.role)), el('span', brainRoleName(e.role) + (issue.startsWith('#') ? ' ' + issue : '')));
    const op = brainOp(e);
    const opEl = el('span', op.label, 'brain-op');
    opEl.style.color = op.color;
    if (e.reason) opEl.setAttribute('title', String(e.reason));
    who.append(role, opEl);
    const path = typeof e.path_or_query === 'string' ? e.path_or_query : '';
    const search = e.op === 'search';
    const name = el('span', search ? '„' + path + '“' : (path.slice(path.lastIndexOf('/') + 1) || '—'), 'brain-name');
    name.setAttribute('title', path);
    const purposeText = typeof e.purpose === 'string' ? e.purpose.trim() : '';
    const purpose = el('span', purposeText || 'Zweck fehlt', 'brain-purpose' + (purposeText ? '' : ' brain-nopurpose'));
    const note = el('div', null, 'brain-note');
    note.append(name, el('span', brainFolder(e), 'brain-folder'), purpose);
    li.append(el('span', brainClock(e.at), 'brain-time'), who, note);
    return li;
  }

  function brainFooter(v, conflicts, now) {
    const parts = [brainInt(v.writes_today) + ' Writes heute', brainInt(v.reads_today.total) + ' Reads'];
    if (conflicts > 0) parts.push(conflicts === 1 ? '1 Konflikt' : brainInt(conflicts) + ' Konflikte');
    const last = v.last_commit;
    parts.push(last && typeof last === 'object' ? 'letzter Commit ' + agoDe(last.at, now) : 'noch kein Commit');
    const nodes = [];
    parts.forEach((p, i) => {
      if (i) { const sep = el('span', '·', 'brain-foot-sep'); sep.setAttribute('aria-hidden', 'true'); nodes.push(sep); }
      nodes.push(el('span', p, 'brain-foot-part'));
    });
    return nodes;
  }

  function brainObsidianUrl(url) {
    if (typeof url !== 'string') return null;
    const u = url.toLowerCase();
    return u.startsWith('https://') || u.startsWith('http://') || u.startsWith('obsidian://') ? url : null;
  }

  function renderBrainVitals(v, conflicts, now) {
    let total = 0;
    for (const k of Object.keys(v.notes_by_status)) if (typeof v.notes_by_status[k] === 'number') total += v.notes_by_status[k];
    patchChildren(document.getElementById('brain-tiles'), [
      kpi(brainInt(total), 'Notizen'),
      kpi(brainInt(v.candidates), 'Kandidaten warten', { color: BRAIN_AMBER }),
      kpi(brainInt(v.links.total), 'Links', { color: BRAIN_SKY }),
      kpi(brainInt(v.orphans), 'Waisen ohne Links', { color: BRAIN_VIOLET }),
    ]);
    const foot = document.getElementById('brain-foot');
    foot.replaceChildren(...brainFooter(v, conflicts, now));
    const host = document.getElementById('brain-obsidian');
    const url = brainObsidianUrl(v.obsidian_url);
    if (url) host.replaceChildren(button('In Obsidian öffnen ↗', { size: 36, tone: 'obsidian', href: url }));
    else host.replaceChildren();
  }

  function brainChipRoles() {
    const roles = [];
    const add = (r) => { if (typeof r === 'string' && r && !BRAIN_HIDDEN_ROLES.includes(r) && !roles.includes(r)) roles.push(r); };
    brainProfileRoles.forEach(add);
    brainEntries.forEach((e) => add(e.role));
    add(brainFilter.role);
    return roles;
  }

  function brainSetRole(role) {
    brainFilter.role = role;
    renderBrainAccess(Date.now());
  }

  function renderBrainChips() {
    const role = brainFilter.role;
    patchChildren(document.getElementById('brain-roles'), [filterGroup('Nach Rolle filtern', [
      filterChip('Alle', { color: '${TEXT.fg}', pressed: role === null, onClick: () => brainSetRole(null) }),
      ...brainChipRoles().map((r) => filterChip(brainRoleName(r), { color: brainRoleColor(r), pressed: role === r, onClick: () => brainSetRole(r) })),
      filterChip('Symphony', { color: '${SCALES.gray[400]}', pressed: role === 'symphony', onClick: () => brainSetRole('symphony') }),
    ])]);
  }

  function renderBrainAccess(now) {
    renderBrainChips();
    const shown = brainEntries.filter(brainMatches);
    document.getElementById('brain-count').textContent = brainInt(shown.length) + ' von ' + brainInt(brainEntries.length);
    const days = new Map();
    for (const e of shown) {
      const day = brainDayStart(e.at);
      if (day === null) continue;
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(e);
    }
    const n = new Date(now);
    const today = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
    if (!days.has(today)) days.set(today, []);
    const filtered = !!(brainFilter.role || brainFilter.q);
    const out = [];
    for (const day of [...days.keys()].sort((a, b) => b - a)) {
      const rows = days.get(day);
      out.push(el('p', brainDayLabel(day, now), 'lbl brain-day'));
      if (!rows.length) {
        out.push(el('p', filtered ? 'Keine Zugriffe für diesen Filter' : 'Noch keine Brain-Zugriffe heute', 'brain-empty'));
        continue;
      }
      const ol = el('ol', null, 'brain-list');
      ol.append(...rows.map(brainRow));
      out.push(ol);
    }
    document.getElementById('brain-access-list').replaceChildren(...out);
  }

  function brainSetProfile(state) {
    const roles = state && state.pipeline_config && state.pipeline_config.roles;
    brainProfileRoles = Array.isArray(roles) ? roles.map((r) => r && r.name).filter((r) => typeof r === 'string') : [];
    if (!document.getElementById('brain-access').hidden) renderBrainAccess(Date.now());
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
    const [vitals, page, clashes] = await Promise.all([
      brainFetch('/api/v1/brain/vitals'),
      brainFetch('/api/v1/brain/access?limit=' + BRAIN_LIMIT),
      brainFetch('/api/v1/brain/clashes?status=open'),
    ]);
    if (seq !== brainSeq) return;
    const ok = brainValidVitals(vitals) && !!page && Array.isArray(page.access);
    brainShow(ok);
    if (!ok) { brainEntries = []; return; }
    brainEntries = page.access.filter((e) => e && typeof e === 'object');
    const conflicts = clashes && Array.isArray(clashes.clashes) ? clashes.clashes.length : 0;
    const now = Date.now();
    renderBrainVitals(vitals, conflicts, now);
    renderBrainAccess(now);
  }

  function brainBind(input) {
    input.addEventListener('input', () => {
      brainFilter.q = input.value.trim().toLowerCase();
      renderBrainAccess(Date.now());
    });
  }
`;
