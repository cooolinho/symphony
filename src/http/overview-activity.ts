/**
 * "Agent-Aktivität · letzte 30 min" of the overview: a 54 px strip of 3 px bars (one per tool call, positioned by
 * time, coloured by role), the legend of all roles of the profile and the time axis. Inlined into the page
 * (ACTIVITY_CSS/ACTIVITY_JS after BASE_JS); all top-level names start with `act`/`ACT_`/`renderActivity`.
 */
export const ACTIVITY_CSS = `
  .act-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--fg-2, var(--text-2)); }
  .act-key { display: inline-flex; align-items: center; gap: 6px; }
  .act-key .ui-dot { width: 8px; height: 8px; }
  .act-strip { position: relative; height: 54px; border-bottom: 1px solid rgba(255, 255, 255, .1); }
  .act-bar { position: absolute; bottom: 0; width: 3px; border-radius: 2px; }
  .act-empty { position: absolute; inset: 0; display: grid; place-items: center; font-size: 12.5px; color: var(--fg-3, var(--muted)); }
  .act-axis { display: flex; justify-content: space-between; margin-top: 6px; font: 11.5px var(--mono); color: var(--fg-3, var(--muted)); }
`;

export const ACTIVITY_JS = `
  const ACT_MAX_BARS = 400;

  // Even sample of at most max events (the first one is always kept).
  function actThin(events, max) {
    if (events.length <= max) return events;
    return Array.from({ length: max }, (_, i) => events[Math.floor((i * events.length) / max)]);
  }

  // Bar height: 20 px by default, else 8 px + 1 px per second of tool time, within 8–42 px.
  function actHeight(event) {
    const ms = event && event.duration_ms;
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return 20;
    return Math.round(Math.min(42, Math.max(8, 8 + ms / 1000)));
  }

  // HH:MM:SS in local time; toLocaleTimeString is too slow for 400 titles.
  function actClock(t) {
    const d = new Date(t);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  // One bar per valid event (thinned to ACT_MAX_BARS): { left (% of the window), height, color, title }.
  function actBars(data) {
    const events = data && Array.isArray(data.events) ? data.events : [];
    const minutes = data && data.minutes > 0 ? data.minutes : 30;
    const until = data && Number.isFinite(Date.parse(data.generated_at)) ? Date.parse(data.generated_at) : Date.now();
    const since = data && Number.isFinite(Date.parse(data.since)) ? Date.parse(data.since) : until - minutes * 60000;
    const span = Math.max(1, until - since);
    // Thin first: formatting the title is the expensive part, so only the kept calls pay for it.
    const valid = events.filter((e) => e && !Number.isNaN(Date.parse(e.at)));
    return actThin(valid, ACT_MAX_BARS).map((e) => ({
      left: Math.min(100, Math.max(0, ((Date.parse(e.at) - since) / span) * 100)),
      height: actHeight(e),
      color: uiOwn(UI_ROLE_COLORS, e.role) || UI_ROLE_COLORS.symphony,
      title: (uiOwn(UI_ROLE_NAMES, e.role) || String(e.role)) + ' · ' + e.issue + ' · ' + actClock(Date.parse(e.at)),
    }));
  }

  // Roles of the profile (pipeline_config.roles), then roles seen in the events but missing there.
  function actRoles(state, events) {
    const roles = [];
    const add = (name) => { if (name && !roles.includes(name)) roles.push(name); };
    for (const r of (state && state.pipeline_config && state.pipeline_config.roles) || []) add(r && r.name);
    for (const e of events || []) add(e && e.role);
    return roles;
  }

  function renderActivityLegend(host, roles) {
    patchChildren(host, roles.map((role) => {
      const key = el('span', null, 'act-key');
      key.append(uiDot(uiOwn(UI_ROLE_COLORS, role) || UI_ROLE_COLORS.symphony), el('span', uiOwn(UI_ROLE_NAMES, role) || String(role)));
      return key;
    }));
  }

  function renderActivityStrip(host, data) {
    const bars = actBars(data);
    if (!bars.length) {
      host.replaceChildren(el('span', 'Keine Tool-Aufrufe in den letzten 30 Minuten', 'act-empty'));
      return;
    }
    host.replaceChildren(...bars.map((b) => {
      const bar = el('span', null, 'act-bar');
      bar.style.left = b.left.toFixed(2) + '%';
      bar.style.height = b.height + 'px';
      bar.style.background = b.color;
      bar.setAttribute('title', b.title);
      return bar;
    }));
  }
`;
