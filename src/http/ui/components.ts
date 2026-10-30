/**
 * Shared client building blocks of the dashboard pages: card, stat tile, progress bar (with a hatched forecast),
 * chip and filter chip. COMPONENTS_JS is appended to BASE_JS and uses its el() / fmtInt(); COMPONENTS_CSS is part of
 * TOKENS_CSS. All classes carry the prefix "ui-" so they never collide with the page-specific .card / .chip / .stat.
 * Text is always set through el() / textContent, never through innerHTML; transitions only touch transform.
 */

export const COMPONENTS_JS = `
  // UI building blocks (card, statTile, progressBar, chip, filterChip).
  const UI_TONES = ['green', 'cyan', 'amber', 'red', 'gray'];
  const uiTone = (tone) => (UI_TONES.includes(tone) ? ' tone-' + tone : '');
  /** Share of value in max as 0..1; anything not finite or max <= 0 gives 0. */
  const uiPct = (v, max) => {
    if (!Number.isFinite(v) || !Number.isFinite(max) || max <= 0) return 0;
    return Math.min(1, Math.max(0, v / max));
  };
  /** Appends a node, a string/number (as text) or an array of those to parent. */
  function uiContent(parent, content) {
    if (content === null || content === undefined) return;
    if (Array.isArray(content)) { content.forEach((part) => uiContent(parent, part)); return; }
    if (typeof content === 'string' || typeof content === 'number') parent.append(el('span', content));
    else parent.append(content);
  }

  function card({ title, meta, body } = {}) {
    const box = el('article', null, 'ui-card g');
    if (title || meta) {
      const head = el('div', null, 'ui-card-head');
      head.append(el('h3', title, 'ui-card-title'));
      if (meta !== null && meta !== undefined) {
        const m = el('div', null, 'ui-card-meta');
        uiContent(m, meta);
        head.append(m);
      }
      box.append(head);
    }
    if (body !== null && body !== undefined) {
      const b = el('div', null, 'ui-card-body');
      uiContent(b, body);
      box.append(b);
    }
    return box;
  }

  function statTile({ label, value, unit, tone, spark } = {}) {
    const box = el('div', null, 'ui-stat gi' + uiTone(tone));
    const head = el('div', null, 'ui-stat-label');
    if (uiTone(tone)) head.append(el('span', null, 'dot'));
    head.append(el('span', label));
    const v = el('div', value === null || value === undefined ? '\\u2014' : value, 'ui-stat-value num');
    if (unit) v.append(el('span', unit, 'ui-stat-unit'));
    box.append(head, v);
    if (spark) {
      const s = el('div', null, 'ui-stat-spark');
      s.append(spark);
      box.append(s);
    }
    return box;
  }

  /** Bar of value/max; a finite forecast adds a hatched area behind the fill, without one there is none. */
  function progressBar({ value, max, forecast, tone } = {}) {
    const bar = el('div', null, 'ui-bar' + uiTone(tone));
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(Math.round(uiPct(value, max) * 100)));
    if (Number.isFinite(forecast)) {
      const f = el('div', null, 'ui-bar-forecast');
      f.style.transform = 'scaleX(' + uiPct(forecast, max) + ')';
      bar.append(f);
    }
    const fill = el('div', null, 'ui-bar-fill');
    fill.style.transform = 'scaleX(' + uiPct(value, max) + ')';
    bar.append(fill);
    return bar;
  }

  function chip({ text, tone, icon } = {}) {
    const c = el('span', null, 'ui-chip' + uiTone(tone));
    if (icon !== null && icon !== undefined && icon !== '') {
      const i = typeof icon === 'object' ? el('span', null, 'ui-chip-icon') : el('span', icon, 'ui-chip-icon');
      if (typeof icon === 'object') i.append(icon);
      i.setAttribute('aria-hidden', 'true');
      c.append(i);
    }
    c.append(el('span', text, 'ui-chip-text'));
    return c;
  }

  /** Toggle button; onToggle(nextActive, button) runs after aria-pressed was flipped. */
  function filterChip({ text, count, active, onToggle } = {}) {
    const b = el('button', null, 'ui-fchip');
    b.setAttribute('type', 'button');
    b.setAttribute('aria-pressed', String(!!active));
    b.append(el('span', text, 'ui-fchip-text'));
    if (count !== null && count !== undefined) b.append(el('span', fmtInt(count), 'ui-fchip-count num'));
    b.addEventListener('click', () => {
      const next = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(next));
      if (typeof onToggle === 'function') onToggle(next, b);
    });
    return b;
  }
`;

export const COMPONENTS_CSS = `
  .ui-card { padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .ui-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .ui-card-title { margin: 0; font: 600 14px/1.3 var(--sans); color: var(--fg-1, var(--text)); }
  .ui-card-meta { color: var(--fg-3); font-size: var(--fs-meta); overflow-wrap: anywhere; }
  .ui-card-body { min-width: 0; }

  .ui-stat { position: relative; min-width: 0; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
  .ui-stat-label { font: 500 11px/1.3 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--fg-label); display: flex; align-items: center; gap: 7px; }
  .ui-stat-value { font-size: var(--fs-kpi-24); font-weight: 600; line-height: 1.2; overflow-wrap: anywhere; }
  .ui-stat-unit { margin-left: 4px; font-size: 13px; font-weight: 500; color: var(--fg-3); }
  .ui-stat-spark { min-width: 0; }

  .ui-bar { position: relative; height: 8px; overflow: hidden; border-radius: 999px; background: var(--glass-in); border: 1px solid var(--glass-line); }
  .ui-bar-forecast, .ui-bar-fill { position: absolute; inset: 0; transform-origin: left center; transition: transform .4s var(--ease); }
  .ui-bar-fill { background: var(--tone, var(--cyan)); border-radius: 999px; }
  .ui-bar-forecast { background: repeating-linear-gradient(135deg, var(--tone-line, var(--cyan-line)) 0 4px, transparent 4px 8px); }

  .ui-chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px; white-space: nowrap;
    font: 600 12px/1.5 var(--mono); border: 1px solid var(--tone-line, var(--glass-line)); background: var(--tone-dim, var(--glass-in)); color: var(--tone, var(--fg-2)); }
  .ui-chip-icon { display: inline-flex; align-items: center; }
  .ui-fchip { display: inline-flex; align-items: center; gap: 8px; padding: 4px 12px; min-height: 44px; border-radius: 999px; text-transform: none;
    letter-spacing: 0; font-size: 12px; color: var(--fg-3); background: var(--glass-in); border: 1px solid var(--glass-line); transition: opacity .2s var(--ease); }
  .ui-fchip-count { font-size: 12px; color: var(--fg-3); }
  .ui-fchip[aria-pressed="true"] { color: var(--cyan); background: var(--cyan-dim); border-color: var(--cyan-line); }
  .ui-fchip[aria-pressed="true"] .ui-fchip-count { color: var(--cyan); }
`;
