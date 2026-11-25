/**
 * "Brain-Vitals" and "Brain-Zugriffe" panels of the overview: four vitals tiles with a footer (writes, reads, open
 * conflicts, last commit) and an Obsidian button, and the access log with role chips, a search over path and purpose,
 * day labels and three-column rows. Role filter and search work on the loaded rows (no request).
 * Without the Brain API (404 brain_disabled, network error) both panels stay hidden. Inlined into the page
 * (BRAIN_CSS/BRAIN_PANELS_HTML/BRAIN_JS after ALERTS_JS); all top-level names start with `brain`/`BRAIN_`/`renderBrain`/`loadBrain`.
 */
import { BRAIN_ACCESS_CSS, BRAIN_ACCESS_JS, brainAccessControlsHtml } from './brain-access.ts';
import { SCALES } from './ui/palette.ts';

export const BRAIN_CSS = `
  .brain-row > section { flex: 1 1 340px; min-width: 0; }
  .brain-row > .brain-access { flex-grow: 2; }
  .brain-head-action { display: inline-flex; }
  .brain-tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .brain-foot { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 12px 0 0; font: 12px var(--mono); color: var(--fg-3, var(--muted)); }
  .brain-access { display: flex; flex-direction: column; gap: 12px; }
  .brain-access > .section-head { margin: 0; }
  #brain-count { font: 12px var(--mono); color: var(--fg-3, var(--muted)); }
  ${BRAIN_ACCESS_CSS}
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
      ${brainAccessControlsHtml({ roles: 'brain-roles', input: 'brain-q', list: 'brain-access-list' })}
    </section>
  </div>
`;

export const BRAIN_JS = BRAIN_ACCESS_JS + `
  const BRAIN_LIMIT = BRAIN_ACCESS_LIMIT;
  const BRAIN_AMBER = '${SCALES.amber[400]}';
  const BRAIN_SKY = '${SCALES.sky[300]}';
  const BRAIN_VIOLET = '${SCALES.violet[300]}';
  const brainAccess = brainAccessView({ roles: 'brain-roles', count: 'brain-count', list: 'brain-access-list' });
  let brainSeq = 0;

  function brainValidVitals(v) {
    if (!v || typeof v !== 'object' || !v.notes_by_status || typeof v.notes_by_status !== 'object') return false;
    if (!v.links || typeof v.links.total !== 'number' || !v.reads_today || typeof v.reads_today.total !== 'number') return false;
    return ['orphans', 'candidates', 'writes_today'].every((k) => typeof v[k] === 'number');
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

  function brainSetProfile(state) {
    brainAccess.setProfile(state);
    if (!document.getElementById('brain-access').hidden) brainAccess.render(Date.now());
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
    if (!ok) { brainAccess.setEntries([]); return; }
    brainAccess.setEntries(page.access);
    const conflicts = clashes && Array.isArray(clashes.clashes) ? clashes.clashes.length : 0;
    const now = Date.now();
    renderBrainVitals(vitals, conflicts, now);
    brainAccess.render(now);
  }

  function brainBind(input) {
    brainAccess.bind(input);
  }
`;
