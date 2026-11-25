/**
 * The Brain access list shared by the overview card ("Brain-Zugriffe") and the Brain page (section "Zugriffe"):
 * role filter chips, a search over path and purpose, day labels and three-column rows. Filter and search work on
 * the loaded rows (no request). The JS needs only BASE_JS (el, uiDot, filterChip, filterGroup, patchChildren,
 * pad2, uiOwn, UI_ROLE_*). Element ids are parameters of `brainAccessView(ids)`; the filter state lives in its closure.
 */
import { iconSvg } from './icons.ts';
import { OP_COLORS, SCALES, TEXT } from './ui/palette.ts';
import { escapeHtml } from './ui/layout.ts';

export const BRAIN_ACCESS_CSS = `
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

/** Role chips container, search field and list host. */
export function brainAccessControlsHtml(ids: { roles: string; input: string; list: string }): string {
  const roles = escapeHtml(ids.roles);
  const input = escapeHtml(ids.input);
  const list = escapeHtml(ids.list);
  return `<div class="brain-roles" id="${roles}"></div>
      <label class="brain-search" for="${input}">
        ${iconSvg('search', 16)}
        <span class="sr">Zugriffe durchsuchen</span>
        <input type="search" id="${input}" placeholder="Notiz oder Zweck suchen" autocomplete="off">
      </label>
      <div id="${list}"></div>`;
}

export const BRAIN_ACCESS_JS = `
  const BRAIN_ACCESS_LIMIT = 50;
  const BRAIN_GRAY = '${SCALES.gray[400]}';
  const BRAIN_OPS = {
    read: ['READ', '${OP_COLORS.read}'], write: ['WRITE', '${OP_COLORS.write}'], append: ['APPEND', '${SCALES.amber[400]}'],
    search: ['SEARCH', '${OP_COLORS.search}'], list: ['LIST', '${SCALES.gray[400]}'],
  };
  const BRAIN_HIDDEN_ROLES = ['docs', 'symphony', 'human'];

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

  /** ids = { roles, count, list } (element ids). Elements are looked up on every render. */
  function brainAccessView(ids) {
    const filter = { role: null, q: '' };
    let entries = [];
    let profileRoles = [];

    function matches(e) {
      if (filter.role) {
        if (filter.role === 'symphony') { if (e.role && e.role !== 'symphony') return false; }
        else if (e.role !== filter.role) return false;
      }
      if (!filter.q) return true;
      return (String(e.path_or_query || '') + ' ' + String(e.purpose || '')).toLowerCase().includes(filter.q);
    }

    function chipRoles() {
      const roles = [];
      const add = (r) => { if (typeof r === 'string' && r && !BRAIN_HIDDEN_ROLES.includes(r) && !roles.includes(r)) roles.push(r); };
      profileRoles.forEach(add);
      entries.forEach((e) => add(e.role));
      add(filter.role);
      return roles;
    }

    function setRole(role) {
      filter.role = role;
      render(Date.now());
    }

    function renderChips() {
      const role = filter.role;
      patchChildren(document.getElementById(ids.roles), [filterGroup('Nach Rolle filtern', [
        filterChip('Alle', { color: '${TEXT.fg}', pressed: role === null, onClick: () => setRole(null) }),
        ...chipRoles().map((r) => filterChip(brainRoleName(r), { color: brainRoleColor(r), pressed: role === r, onClick: () => setRole(r) })),
        filterChip('Symphony', { color: '${SCALES.gray[400]}', pressed: role === 'symphony', onClick: () => setRole('symphony') }),
      ])]);
    }

    function render(now) {
      renderChips();
      const shown = entries.filter(matches);
      document.getElementById(ids.count).textContent = brainInt(shown.length) + ' von ' + brainInt(entries.length);
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
      const filtered = !!(filter.role || filter.q);
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
      document.getElementById(ids.list).replaceChildren(...out);
    }

    return {
      setEntries(list) { entries = Array.isArray(list) ? list.filter((e) => e && typeof e === 'object') : []; },
      setProfile(state) {
        const roles = state && state.pipeline_config && state.pipeline_config.roles;
        profileRoles = Array.isArray(roles) ? roles.map((r) => r && r.name).filter((r) => typeof r === 'string') : [];
      },
      render,
      bind(input) {
        input.addEventListener('input', () => {
          filter.q = input.value.trim().toLowerCase();
          render(Date.now());
        });
      },
      filter() { return { role: filter.role, q: filter.q }; },
    };
  }
`;
