/**
 * Shared client building blocks of the dashboard pages, styled after the mockup: card, kpi tile, bar (with a hatched
 * forecast and a marker), stacked bar, chip, filter chip, button, segmented control, tabs, sparkline, ring gauge,
 * avatar and equalizer, plus the traffic-light helper trafficTone() (green below 80 %, amber from 80 %, red from 95 %)
 * with its colours UI_TRAFFIC. COMPONENTS_JS is appended to BASE_JS and uses its el() / svgEl() / fmtInt() and icon() from
 * ICONS_JS; COMPONENTS_CSS is part of TOKENS_CSS. All classes carry the prefix "ui-" so they never collide with the
 * page-specific .card / .chip / .stat / .btn (only the shared .ring / .eq of TOKENS_CSS are reused).
 * Text is always set through el() / textContent and SVG attributes through setAttribute, never through innerHTML;
 * colours come from palette.ts, runtime tints of a #rrggbb colour from uiRgba().
 */

import { CHIP_TONES, ROLE_COLORS, ROLE_LIGHT, SCALES, rgba } from './palette.ts';

const ROLE_NAMES = {
  analyst: 'Analyst', architect: 'Architect', developer: 'Developer', tester: 'Tester', docs: 'Docs',
  reviewer: 'Reviewer', security: 'Security', symphony: 'Symphony', human: 'Human',
};
const ROLE_SHORT = { analyst: 'AN', architect: 'AR', developer: 'DE', tester: 'TE', docs: 'DO', reviewer: 'RE', security: 'SE', symphony: 'SY', human: 'HU' };
/** Palette role of a configured role's result kind (issue-analyst reports analysis, so it is drawn as the analyst). */
const KIND_ROLE = {
  analysis: 'analyst', design: 'architect', implementation: 'developer', test: 'tester', docs: 'docs', review: 'reviewer',
  security: 'security', human: 'human',
};
const ROLE_ICON = {
  analyst: 'analyst', architect: 'architect', developer: 'developer', tester: 'tester', docs: 'docs',
  reviewer: 'reviewer', security: 'security', symphony: 'logo', human: 'human',
};

export const COMPONENTS_JS = `
  // UI building blocks (card, kpi, bar, stackedBar, chip, filterChip, filterGroup, button, segmented, tabs,
  // sparkline, ring, avatar, eq) and the traffic-light helper trafficTone.
  const UI_CHIP_TONES = ${JSON.stringify(CHIP_TONES)};
  const UI_ROLE_COLORS = ${JSON.stringify(ROLE_COLORS)};
  const UI_ROLE_LIGHT = ${JSON.stringify(ROLE_LIGHT)};
  const UI_KIND_ROLE = ${JSON.stringify(KIND_ROLE)};
  const UI_ROLE_NAMES = ${JSON.stringify(ROLE_NAMES)};
  const UI_ROLE_SHORT = ${JSON.stringify(ROLE_SHORT)};
  const UI_ROLE_ICON = ${JSON.stringify(ROLE_ICON)};
  const UI_AV_STATES = ['done', 'playing', 'waiting', 'returned', 'skipped'];
  const uiOwn = (table, key) => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined);
  /** v if it is a #rrggbb colour, else null (anything else never reaches a style). */
  const uiHex = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : null);
  /** "rgba(r,g,b,alpha)" of a #rrggbb colour (alpha as written, e.g. '.4'); '' for anything else. */
  const uiRgba = (hex, alpha) => {
    if (!uiHex(hex)) return '';
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  };
  /** Palette key (a key of UI_ROLE_COLORS) of a role: the role itself when the palette has it, else by its result kind, else symphony. */
  const uiRoleKey = (role, kind) => uiOwn(UI_ROLE_COLORS, role) ? role : uiOwn(UI_KIND_ROLE, kind) || 'symphony';
  /** A percentage clamped to 0..100; anything not finite gives 0. */
  const uiClamp = (pct) => (typeof pct === 'number' && Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0);
  const uiGiven = (v) => v !== null && v !== undefined && v !== '';
  /** Appends a node, a string/number (as text) or an array of those to parent. */
  function uiContent(parent, content) {
    if (content === null || content === undefined) return;
    if (Array.isArray(content)) { content.forEach((part) => uiContent(parent, part)); return; }
    if (typeof content === 'string' || typeof content === 'number') parent.append(el('span', content));
    else parent.append(content);
  }
  function uiDot(color) {
    const d = el('span', null, 'ui-dot');
    d.style.background = color;
    d.setAttribute('aria-hidden', 'true');
    return d;
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

  /** Traffic-light colours (#rrggbb) by tone name, for kpi / bar / sparkline. */
  const UI_TRAFFIC = { green: UI_CHIP_TONES.green.c, amber: UI_CHIP_TONES.amber.c, red: UI_CHIP_TONES.red.c };
  /** Traffic-light tone of a utilisation in percent: 'green' below 80, 'amber' from 80, 'red' from 95; null if not finite. */
  function trafficTone(pct) {
    if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
    return pct >= 95 ? 'red' : pct >= 80 ? 'amber' : 'green';
  }

  /** Key figure tile: value in monospace (size 24, or 26 / 28), label and an optional line below; null shows "—". */
  function kpi(value, label, opts) {
    const { sub, color, size } = opts || {};
    const box = el('div', null, 'ui-kpi gi' + (size === 26 || size === 28 ? ' ui-kpi-' + size : ''));
    const v = el('div', value === null || value === undefined ? '—' : value, 'ui-kpi-value mono');
    if (uiHex(color)) v.style.color = color;
    box.append(v, el('div', label, 'ui-kpi-label'));
    if (uiGiven(sub)) box.append(el('div', sub, 'ui-kpi-sub'));
    return box;
  }

  /**
   * Bar of pct (0..100). forecastPct > 0 adds a hatched area right after the fill, without one there is none;
   * marker { pct, title } draws a thin red mark at that position.
   */
  function bar(pct, opts) {
    const { height, color, forecastPct, marker } = opts || {};
    const p = uiClamp(pct);
    const h = [5, 6, 8, 10].includes(height) ? height : 8;
    const root = el('div', null, 'ui-bar ui-bar-h' + h);
    root.setAttribute('role', 'progressbar');
    root.setAttribute('aria-valuemin', '0');
    root.setAttribute('aria-valuemax', '100');
    root.setAttribute('aria-valuenow', String(Math.round(p)));
    const fill = el('div', null, 'ui-bar-fill');
    fill.style.width = p + '%';
    if (uiHex(color)) fill.style.background = color;
    root.append(fill);
    if (typeof forecastPct === 'number' && Number.isFinite(forecastPct) && forecastPct > 0 && p < 100) {
      const f = el('div', null, 'ui-bar-forecast');
      f.style.left = p + '%';
      f.style.width = Math.min(forecastPct, 100 - p) + '%';
      if (uiHex(color)) f.style.setProperty('--hatch', uiRgba(color, '.45'));
      root.append(f);
    }
    if (marker && typeof marker.pct === 'number' && Number.isFinite(marker.pct)) {
      const m = el('div', null, 'ui-bar-mark');
      m.style.left = uiClamp(marker.pct) + '%';
      if (uiGiven(marker.title)) m.setAttribute('title', String(marker.title));
      root.append(m);
      root.classList.add('has-mark');
    }
    return root;
  }

  /** Stacked bar of parts [{ value, label, color }]; the aria-label names every part ("371 approved, 17 candidates"). */
  function stackedBar(parts) {
    const list = (Array.isArray(parts) ? parts : []).filter((p) => p && typeof p.value === 'number' && Number.isFinite(p.value) && p.value >= 0);
    const total = list.reduce((sum, p) => sum + p.value, 0);
    const root = el('div', null, 'ui-stack');
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', list.length ? list.map((p) => fmtInt(p.value) + ' ' + String(p.label ?? '')).join(', ') : 'no data');
    for (const p of list) {
      if (p.value <= 0) continue;
      const s = el('span', null, 'ui-stack-part');
      s.style.width = +((p.value / total) * 100).toFixed(3) + '%';
      if (uiHex(p.color)) s.style.background = p.color;
      root.append(s);
    }
    return root;
  }

  /**
   * Chip; tone is a name of UI_CHIP_TONES or a #rrggbb colour c (text light, border c at .4, ground c at .1);
   * dot (#rrggbb, or true for the tone colour) adds an 8 px dot in front.
   */
  function chip(text, opts) {
    const { tone, mono, dot } = opts || {};
    const c = el('span', null, 'ui-chip' + (mono ? ' mono' : ''));
    const t = uiOwn(UI_CHIP_TONES, tone) || (uiHex(tone) ? { text: tone, c: tone } : null);
    if (t) {
      c.style.color = t.text;
      c.style.borderColor = uiRgba(t.c, '.4');
      c.style.background = uiRgba(t.c, '.1');
    }
    const dotColor = uiHex(dot) || (dot === true && t ? t.c : null);
    if (dotColor) c.append(uiDot(dotColor));
    c.append(el('span', text, 'ui-chip-text'));
    return c;
  }

  /** Toggle chip; onClick(nextPressed, button) runs after aria-pressed was flipped. color (#rrggbb) adds a dot. */
  function filterChip(label, opts) {
    const { color, pressed, onClick, count } = opts || {};
    const b = el('button', null, 'ui-fchip');
    b.setAttribute('type', 'button');
    b.setAttribute('aria-pressed', String(!!pressed));
    if (uiHex(color)) b.append(uiDot(color));
    b.append(el('span', label, 'ui-fchip-text'));
    if (uiGiven(count)) b.append(el('span', typeof count === 'number' ? fmtInt(count) : count, 'ui-fchip-count mono'));
    b.addEventListener('click', () => {
      const next = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(next));
      if (typeof onClick === 'function') onClick(next, b);
    });
    return b;
  }

  /** Group of filter chips with an accessible name. */
  function filterGroup(ariaLabel, chips) {
    const g = el('div', null, 'ui-fchips');
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', String(ariaLabel ?? ''));
    uiContent(g, chips);
    return g;
  }

  /**
   * Pill button (size 44 default, 40, 38, 36; tone approve, danger, obsidian). With href (http(s) or a local path)
   * it is a link styled as a button. A button without a visible label needs ariaLabel, otherwise this throws.
   */
  function button(label, opts) {
    const { size, tone, icon: glyph, ariaLabel, href, onClick } = opts || {};
    const hasLabel = uiGiven(label);
    if (!hasLabel && !uiGiven(ariaLabel)) throw new Error('button: an icon-only button needs an ariaLabel');
    const cls = 'ui-btn' + ([40, 38, 36].includes(size) ? ' ui-btn-' + size : '') +
      (['approve', 'danger', 'obsidian'].includes(tone) ? ' ui-btn-' + tone : '') + (hasLabel ? '' : ' is-icon');
    const isLink = typeof href === 'string' && (href.startsWith('https://') || href.startsWith('http://') || (href.startsWith('/') && !href.startsWith('//')));
    let b;
    if (isLink) {
      b = el('a', null, cls);
      b.setAttribute('href', href);
      if (!href.startsWith('/')) { b.setAttribute('target', '_blank'); b.setAttribute('rel', 'noopener noreferrer'); }
    } else {
      b = el('button', null, cls);
      b.setAttribute('type', 'button');
    }
    if (glyph && typeof glyph === 'object') {
      glyph.setAttribute('aria-hidden', 'true');
      b.append(glyph);
    }
    if (hasLabel) b.append(el('span', label, 'ui-btn-label'));
    if (uiGiven(ariaLabel)) b.setAttribute('aria-label', String(ariaLabel));
    if (typeof onClick === 'function') b.addEventListener('click', (event) => onClick(event, b));
    return b;
  }

  /** Segmented control of options [{ value, label, count }]; onChange(value, button) runs after a click. */
  function segmented(options, value, onChange, ariaLabel) {
    const root = el('div', null, 'ui-seg');
    root.setAttribute('role', 'group');
    if (uiGiven(ariaLabel)) root.setAttribute('aria-label', String(ariaLabel));
    const buttons = [];
    for (const o of Array.isArray(options) ? options : []) {
      if (!o) continue;
      const b = el('button', null, 'ui-seg-btn');
      b.setAttribute('type', 'button');
      b.setAttribute('aria-pressed', String(o.value === value));
      b.append(el('span', o.label ?? o.value, 'ui-seg-label'));
      if (uiGiven(o.count)) b.append(el('span', typeof o.count === 'number' ? fmtInt(o.count) : o.count, 'ui-seg-count mono'));
      b.addEventListener('click', () => {
        for (const x of buttons) x.setAttribute('aria-pressed', String(x === b));
        if (typeof onChange === 'function') onChange(o.value, b);
      });
      buttons.push(b);
      root.append(b);
    }
    return root;
  }

  /**
   * Tabs of items [{ id, label, count }] with roving tabindex; a click or ArrowLeft / ArrowRight / Home / End
   * selects a tab, moves the focus to it and calls onChange(id).
   */
  function tabs(items, active, onChange) {
    const root = el('div', null, 'ui-tabs');
    root.setAttribute('role', 'tablist');
    const list = [];
    const ids = [];
    let current = 0;
    const select = (i, focus) => {
      current = i;
      list.forEach((t, k) => {
        t.setAttribute('aria-selected', String(k === i));
        t.setAttribute('tabindex', k === i ? '0' : '-1');
      });
      if (focus && typeof list[i].focus === 'function') list[i].focus();
    };
    for (const it of Array.isArray(items) ? items : []) {
      if (!it) continue;
      const id = String(it.id);
      const t = el('button', null, 'ui-tab');
      t.setAttribute('type', 'button');
      t.setAttribute('role', 'tab');
      t.setAttribute('data-id', id);
      t.append(el('span', it.label ?? id, 'ui-tab-label'));
      if (uiGiven(it.count)) t.append(el('span', typeof it.count === 'number' ? fmtInt(it.count) : it.count, 'ui-tab-count mono'));
      const i = list.length;
      t.addEventListener('click', () => {
        select(i, false);
        if (typeof onChange === 'function') onChange(id);
      });
      list.push(t);
      ids.push(id);
      root.append(t);
    }
    if (list.length) select(Math.max(0, ids.indexOf(String(active))), false);
    root.addEventListener('keydown', (event) => {
      const n = list.length;
      if (!n) return;
      const from = list.indexOf(event.target);
      const at = from >= 0 ? from : current;
      const next = { ArrowRight: (at + 1) % n, ArrowLeft: (at - 1 + n) % n, Home: 0, End: n - 1 }[event.key];
      if (next === undefined) return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      select(next, true);
      if (typeof onChange === 'function') onChange(ids[next]);
    });
    return root;
  }

  /** Sparkline: decorative svg (100×24, stretched) with one polyline; no valid number gives null (no svg). */
  function sparkline(values, color) {
    const data = Array.isArray(values) ? values.filter((v) => typeof v === 'number' && Number.isFinite(v)) : [];
    if (!data.length) return null;
    if (data.length === 1) data.push(data[0]);
    const min = Math.min(...data);
    const range = Math.max(...data) - min;
    const pad = 1.5;
    const points = data.map((v, i) => {
      const x = (i * 100) / (data.length - 1);
      const y = range === 0 ? 12 : pad + (24 - 2 * pad) * (1 - (v - min) / range);
      return +x.toFixed(2) + ',' + +y.toFixed(2);
    }).join(' ');
    const svg = svgEl('svg', { class: 'ui-spark', viewBox: '0 0 100 24', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' });
    svg.append(svgEl('polyline', {
      fill: 'none', stroke: uiHex(color) || 'currentColor', 'stroke-width': '1.6', 'vector-effect': 'non-scaling-stroke',
      'stroke-linejoin': 'round', 'stroke-linecap': 'round', points,
    }));
    return svg;
  }

  /**
   * Ring gauge: conic-gradient of pct around an inner circle (inner: node or text, e.g. a role icon) with a
   * percentage badge below; amber from 70 %, sky below. null (or anything not finite) shows "—".
   */
  function ring(pct, opts) {
    const { size, color, inner, label } = opts || {};
    const p = typeof pct === 'number' && Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : null;
    const v = p === null ? 0 : +p.toFixed(2);
    const hot = p !== null && p >= 70;
    const c = uiHex(color) || (hot ? 'var(--amber-400)' : 'var(--sky-300)');
    const px = typeof size === 'number' && size >= 24 && size <= 256 ? size : 96;
    const root = el('div', null, 'ui-ring' + (p === null ? ' is-empty' : ''));
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', (uiGiven(label) ? label + ', ' : '') + (p === null ? 'no data' : Math.round(p) + ' percent'));
    root.style.width = px + 'px';
    root.style.height = px + 'px';
    root.style.color = c;
    root.style.background = 'conic-gradient(' + c + ' 0 ' + v + '%, rgba(255,255,255,.1) ' + v + '% 100%)';
    const inside = el('div', null, 'ui-ring-in');
    uiContent(inside, inner);
    const tag = el('span', p === null ? '—' : Math.round(p) + '%', 'ui-ring-pct mono' + (hot ? ' hot' : ''));
    tag.setAttribute('aria-hidden', 'true');
    root.append(inside, tag);
    return root;
  }

  /**
   * Role avatar (size 30 with the short name, 64 / 96 with the role icon); state is done, playing, waiting,
   * returned or skipped. Only playing carries the pulse ring and the equalizer; done and returned get a badge at 64 / 96.
   */
  function avatar(role, state, opts) {
    const { size, short } = opts || {};
    const key = String(role ?? '');
    const name = uiOwn(UI_ROLE_NAMES, key) || (key ? key.charAt(0).toUpperCase() + key.slice(1) : 'Unknown');
    const st = UI_AV_STATES.includes(state) ? state : 'waiting';
    const px = [30, 64, 96].includes(size) ? size : 30;
    const c = uiOwn(UI_ROLE_COLORS, key) || UI_ROLE_COLORS.symphony;
    const abbr = uiGiven(short) ? String(short) : uiOwn(UI_ROLE_SHORT, key) || key.slice(0, 2).toUpperCase() || '?';
    const root = el('span', null, 'ui-av ui-av-' + px + ' is-' + st);
    root.setAttribute('role', 'img');
    root.setAttribute('title', name + ' · ' + st);
    root.setAttribute('aria-label', name + ' · ' + st);
    const glyph = px >= 64 ? icon(uiOwn(UI_ROLE_ICON, key), px === 96 ? 34 : 26) : null;
    if (glyph) root.append(glyph);
    else {
      const face = el('span', abbr, 'ui-av-face');
      face.setAttribute('aria-hidden', 'true');
      root.append(face);
    }
    if (st === 'done') {
      root.style.background = uiRgba(c, '.16');
      root.style.color = c;
      root.style.borderColor = uiRgba(c, '.55');
    }
    if (st === 'playing') {
      root.style.background = uiRgba(c, '.32');
      root.style.color = '#fff';
      root.style.borderColor = c;
      root.style.boxShadow = '0 0 18px ' + uiRgba(c, '.6');
      const pulse = el('span', null, 'ring' + (px >= 64 ? ' ring-lg' : ''));
      pulse.style.color = c;
      pulse.setAttribute('aria-hidden', 'true');
      const bars = eq();
      bars.style.color = c;
      root.append(pulse, bars);
    }
    if (px >= 64 && (st === 'done' || st === 'returned')) {
      const mark = el('span', null, 'ui-av-badge' + (st === 'returned' ? ' is-x' : ''));
      mark.setAttribute('aria-hidden', 'true');
      mark.append(st === 'done' ? icon('check', 12) : icon('cross', 11));
      root.append(mark);
    }
    return root;
  }

  /** Equalizer: 4 bars 3×14 px (large: 5 bars 4×18 px) in currentColor. */
  function eq(opts) {
    const large = !!(opts && opts.large);
    const e = el('span', null, 'eq' + (large ? ' eq-lg' : ''));
    e.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < (large ? 5 : 4); i++) e.append(el('i'));
    return e;
  }
`;

const g400 = SCALES.green[400];
const s300 = SCALES.sky[300];
const r400 = SCALES.red[400];
const v400 = SCALES.violet[400];

export const COMPONENTS_CSS = `
  .ui-card { padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .ui-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .ui-card-title { margin: 0; font: 600 14px/1.3 var(--sans); color: var(--fg-1, var(--text)); }
  .ui-card-meta { color: var(--fg-3); font-size: var(--fs-meta); overflow-wrap: anywhere; }
  .ui-card-body { min-width: 0; }

  .ui-kpi { min-width: 0; padding: 12px 14px; display: flex; flex-direction: column; gap: 4px; }
  .ui-kpi-value { font: 500 var(--fs-kpi-24)/1.2 var(--mono); font-variant-numeric: tabular-nums; color: var(--fg-strong); overflow-wrap: anywhere; }
  .ui-kpi-26 .ui-kpi-value { font-size: var(--fs-kpi-26); }
  .ui-kpi-28 .ui-kpi-value { font-size: var(--fs-kpi-28); }
  .ui-kpi-label { font-size: 12.5px; color: var(--fg-2); }
  .ui-kpi-26 .ui-kpi-label, .ui-kpi-28 .ui-kpi-label { font-size: 13px; }
  .ui-kpi-sub { font-size: 12px; color: var(--fg-3); }

  .ui-bar { position: relative; height: 8px; overflow: hidden; border-radius: 99px; background: rgba(255, 255, 255, .08); }
  .ui-bar-h5 { height: 5px; }
  .ui-bar-h6 { height: 6px; }
  .ui-bar-h10 { height: 10px; }
  .ui-bar.has-mark { overflow: visible; }
  .ui-bar-fill, .ui-bar-forecast { position: absolute; top: 0; bottom: 0; left: 0; }
  .ui-bar-fill { border-radius: 99px; background: var(--green-400); }
  .ui-bar-forecast { border-radius: 0 99px 99px 0; background: repeating-linear-gradient(135deg, var(--hatch, ${rgba(g400, .45)}) 0 4px, transparent 4px 8px); }
  .ui-bar-mark { position: absolute; top: -4px; bottom: -4px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--red-400); }

  .ui-stack { display: flex; height: 10px; overflow: hidden; border-radius: 99px; background: rgba(255, 255, 255, .06); }
  .ui-stack-part { display: block; height: 100%; min-width: 2px; background: var(--gray-500); }

  .ui-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 12px; line-height: 1.4;
    white-space: nowrap; color: var(--fg-chip); background: rgba(255, 255, 255, .05); border: 1px solid rgba(255, 255, 255, .12); }
  .ui-dot { display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }

  .ui-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; min-width: 44px; padding: 0 14px;
    border-radius: 999px; border: 1px solid rgba(255, 255, 255, .14); background: rgba(255, 255, 255, .06); color: var(--fg);
    font: 500 13px var(--sans); letter-spacing: 0; text-transform: none; white-space: nowrap; cursor: pointer; text-decoration: none; }
  .ui-btn:hover { background: rgba(255, 255, 255, .12); border-color: rgba(255, 255, 255, .14); color: var(--fg-strong); text-decoration: none; }
  .ui-btn.is-icon { padding: 0; }
  .ui-btn.ui-btn-40 { min-height: 40px; min-width: 40px; }
  .ui-btn.ui-btn-38 { min-height: 38px; min-width: 38px; padding: 0 12px; font-size: 12.5px; }
  .ui-btn.ui-btn-36 { min-height: 36px; min-width: 36px; padding: 0 12px; font-size: 12.5px; }
  .ui-btn.is-icon.ui-btn-38, .ui-btn.is-icon.ui-btn-36 { padding: 0; }
  .ui-btn.ui-btn-approve { color: var(--green-100); border-color: ${rgba(g400, .5)}; }
  .ui-btn.ui-btn-danger { color: var(--red-200); }
  .ui-btn.ui-btn-obsidian { background: ${rgba(v400, .18)}; border-color: ${rgba(v400, .55)}; color: var(--violet-100); }
  .ui-btn.ui-btn-obsidian:hover { background: ${rgba(v400, .28)}; }

  .ui-fchips { display: flex; flex-wrap: wrap; gap: 8px; }
  .ui-fchip { display: inline-flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 12px; border-radius: 999px;
    font: 500 12.5px var(--sans); letter-spacing: 0; text-transform: none; color: var(--fg-2); background: rgba(255, 255, 255, .05);
    border: 1px solid rgba(255, 255, 255, .12); }
  .ui-fchip:hover { background: rgba(255, 255, 255, .1); border-color: rgba(255, 255, 255, .2); color: var(--fg); }
  .ui-fchip[aria-pressed="true"] { background: ${rgba(s300, .16)}; border-color: ${rgba(s300, .55)}; color: var(--sky-100); }
  .ui-fchip-count { font-size: 12px; opacity: .75; }

  .ui-seg { display: inline-flex; gap: 4px; padding: 4px; border-radius: 999px; background: rgba(0, 0, 0, .28); border: 1px solid rgba(255, 255, 255, .08); }
  .ui-seg-btn { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 18px; border-radius: 999px; border: 0;
    background: transparent; color: var(--fg-2); font: 500 14px var(--sans); letter-spacing: 0; text-transform: none; }
  .ui-seg-btn:hover { background: rgba(255, 255, 255, .06); color: var(--fg); }
  .ui-seg-btn[aria-pressed="true"] { background: rgba(255, 255, 255, .92); color: var(--ink-text); }
  .ui-seg-count { font-size: 12px; opacity: .75; }

  .ui-tabs { display: flex; flex-wrap: wrap; gap: 4px; }
  .ui-tab { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 16px; border-radius: 999px; border: 0;
    background: transparent; color: var(--fg-2); font: 500 13.5px var(--sans); letter-spacing: 0; text-transform: none; }
  .ui-tab:hover { background: rgba(255, 255, 255, .06); color: var(--fg); }
  .ui-tab[aria-selected="true"] { background: rgba(255, 255, 255, .12); color: var(--fg-strong); }
  .ui-tab-count { font-size: 12px; opacity: .75; }

  .ui-spark { display: block; width: 100%; height: 24px; overflow: visible; }

  .ui-ring { position: relative; display: inline-block; flex: none; padding: 5px; border-radius: 50%; }
  .ui-ring-in { width: 100%; height: 100%; border-radius: 50%; display: grid; place-items: center; background: var(--bg-2); border: 1px solid currentColor; }
  .ui-ring-pct { position: absolute; left: 50%; bottom: -10px; transform: translateX(-50%); padding: 1px 7px; border-radius: 99px;
    font-size: 11px; line-height: 1.4; white-space: nowrap; background: var(--ink-sky); border: 1px solid var(--sky-300); color: var(--sky-100); }
  .ui-ring-pct.hot { background: var(--ink-amber); border-color: var(--amber-400); color: var(--amber-200); }
  .ui-ring.is-empty .ui-ring-pct { background: var(--bg-2); border-color: rgba(255, 255, 255, .2); color: var(--fg-2); }

  .ui-av { position: relative; display: inline-grid; place-items: center; flex: none; border-radius: 50%; border: 1px solid transparent; color: var(--fg-2); }
  .ui-av-30 { width: 30px; height: 30px; }
  .ui-av-64 { width: 64px; height: 64px; }
  .ui-av-96 { width: 96px; height: 96px; }
  .ui-av-face { font: 600 10.5px/1 var(--mono); }
  .ui-av-64 .ui-av-face { font-size: 18px; }
  .ui-av-96 .ui-av-face { font-size: 24px; }
  .ui-av.is-waiting { background: rgba(255, 255, 255, .03); color: var(--fg-2); border: 1px dashed rgba(255, 255, 255, .22); }
  .ui-av.is-returned { background: ${rgba(r400, .14)}; color: var(--red-300); border-color: ${rgba(r400, .6)}; }
  .ui-av.is-skipped { background: transparent; color: var(--fg-mute); border: 1px dashed rgba(255, 255, 255, .12); }
  .ui-av-badge { position: absolute; right: -3px; bottom: -3px; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%;
    background: var(--green-400); color: var(--ink-green); border: 2px solid var(--ink-ring); }
  .ui-av-badge.is-x { background: var(--red-400); color: var(--ink-red); }
  .ui-av .ring { inset: -5px; }
  .ui-av .eq { position: absolute; right: -2px; bottom: -2px; height: 10px; }
  .ui-av .eq i { width: 2px; height: 10px; }

  .ui-ico-text { display: inline-block; line-height: 1; }
`;
