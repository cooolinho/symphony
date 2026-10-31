import { LOOP_VERDICTS } from '../workflow/results.ts';

/**
 * "Teams live" section of the overview: one link row per running issue with the role avatars of its pipeline,
 * the action of the active role, context bar, live run time and subagent count. Like pipeline.ts it is
 * inlined into the page (TEAMS_CSS/TEAMS_JS next to BASE_JS) and unit-testable in a vm; all top-level
 * names start with `team`/`TEAM_` so they cannot collide with the dashboard script.
 */
export const TEAMS_CSS = `
  .teams-all { font-size: 13px; }
  .team-list { display: flex; flex-direction: column; gap: 10px; }
  .team-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 18px; padding: 14px 16px; color: inherit; text-decoration: none; }
  .team-row:hover { background: rgba(255, 255, 255, .06); text-decoration: none; }
  .team-row:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .team-head { flex: 1 1 260px; min-width: 0; display: grid; gap: 4px; }
  .team-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .team-num { font: 13px var(--mono); color: var(--fg-label); flex: none; }
  .team-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; font-weight: 600; }
  .team-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; color: var(--fg-3); }
  .team-avs { display: flex; flex-wrap: wrap; gap: 6px; }
  .team-cast { flex: 1 1 250px; min-width: 0; display: grid; gap: 6px; }
  .team-actline { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .team-role { font-size: 13px; font-weight: 500; flex: none; }
  .team-action { font: 12.5px var(--mono); color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .team-action.muted { color: var(--fg-3); }
  .team-ctx { display: grid; grid-template-columns: 52px 1fr 36px; align-items: center; gap: 8px; }
  .team-ctx-label { font-size: 12px; color: var(--fg-3); }
  .team-ctx-pct { font: 12px var(--mono); text-align: right; }
  .team-end { margin-left: auto; min-width: 86px; text-align: right; display: grid; gap: 2px; }
  .team-time { font: 15px var(--mono); font-variant-numeric: tabular-nums; }
  .team-subs { font-size: 12px; color: var(--fg-3); }
  .team-empty { font-size: 13px; color: var(--fg-2); margin: 0; }
`;

export const TEAMS_JS = `
  const TEAM_RETURN_VERDICTS = ${JSON.stringify(Object.values(LOOP_VERDICTS))};
  let teamFp = null;
  const teamTimes = new Map();

  function teamTrunc(s, max) {
    s = String(s || '');
    const cp = Array.from(s);
    return cp.length > max ? cp.slice(0, max - 1).join('') + '…' : s;
  }

  function teamClock(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    return pad2(Math.floor(s / 60)) + ':' + pad2(s % 60);
  }

  function teamAvatarState(stage, running) {
    if (stage.status === 'skipped') return 'skipped';
    if (running && running.session_id && running.role === stage.id) return 'playing';
    if (stage.status === 'active') return 'waiting';
    if (TEAM_RETURN_VERDICTS.includes(stage.verdict)) return 'returned';
    if (stage.status === 'done' || (stage.sessions || []).length > 0) return 'done';
    return 'waiting';
  }

  function teamAgents(row) {
    return (row.stages || []).filter((s) => s.kind === 'agent');
  }

  /** "Tool · argument": last_message "Name: arg" with the workspace prefix cut off the path. */
  function teamActionText(run) {
    if (!run.session_id) return 'Wartet auf Session';
    const msg = String(run.last_message || run.last_event || '');
    const at = msg.indexOf(': ');
    if (at <= 0) return teamTrunc(msg, 80);
    let arg = msg.slice(at + 2);
    const ws = run.workspace ? String(run.workspace).replace(/[/]+$/, '') + '/' : '';
    if (ws && arg.startsWith(ws)) arg = arg.slice(ws.length);
    return teamTrunc(msg.slice(0, at) + ' · ' + arg, 80);
  }

  const TEAM_STATE_WORDS = { done: 'fertig', playing: 'spielt', waiting: 'wartet', returned: 'Rückgabe', skipped: 'übersprungen' };

  function teamAria(agents, run) {
    return 'Team: ' + agents.map((s) => (UI_ROLE_NAMES[s.id] || s.id) + ' ' + TEAM_STATE_WORDS[teamAvatarState(s, run)]).join(', ');
  }

  function teamSubsText(run) {
    const n = ((run.subagents || {}).running || []).length;
    return n === 0 ? 'keine Subagents' : n === 1 ? '1 Subagent' : n + ' Subagents';
  }

  function teamCtxColor(p) {
    return p >= 70 ? '#fbbf24' : '#38bdf8';
  }

  function teamPercent(run) {
    const p = run.context ? run.context.percent : null;
    return typeof p === 'number' && Number.isFinite(p) ? p : null;
  }

  function teamRow(row, now) {
    const run = row.running;
    const id = String(row.issue_identifier || '');
    const a = el('a', null, 'gi row team-row');
    a.setAttribute('href', '/issue?id=' + encodeURIComponent(id));
    const agents = teamAgents(row);
    const round = Math.max(1, ...agents.map((s) => s.round || 0));
    const head = el('div', null, 'team-head');
    const line = el('div', null, 'team-line');
    line.append(el('span', '#' + id.slice(id.lastIndexOf('#') + 1), 'team-num'), el('span', row.title || id, 'team-title'));
    head.append(line, el('span', (row.repo || id.split('#')[0]) + ' · ' + (row.state || '') + ' · Runde ' + round, 'team-meta'));
    const avs = el('div', null, 'team-avs');
    avs.setAttribute('role', 'group');
    avs.setAttribute('aria-label', teamAria(agents, run));
    for (const s of agents) avs.append(avatar(s.id, teamAvatarState(s, run)));
    const cast = el('div', null, 'team-cast');
    const actline = el('div', null, 'team-actline');
    if (run.session_id) {
      const e = eq();
      e.style.color = UI_ROLE_COLORS[run.role] || UI_ROLE_COLORS.symphony;
      actline.append(e);
    }
    const action = el('span', teamActionText(run), 'team-action' + (run.session_id ? '' : ' muted'));
    action.setAttribute('title', String(run.last_message || run.last_event || ''));
    actline.append(el('span', UI_ROLE_NAMES[run.role] || run.role || '', 'team-role'), action);
    const ctx = el('div', null, 'team-ctx');
    const p = teamPercent(run);
    ctx.append(el('span', 'Context', 'team-ctx-label'));
    if (p === null) ctx.append(el('span'), el('span', '—', 'team-ctx-pct'));
    else {
      const b = bar(p, { height: 6, color: teamCtxColor(p) });
      b.setAttribute('aria-label', 'Context');
      ctx.append(b, el('span', Math.round(p) + ' %', 'team-ctx-pct'));
    }
    cast.append(actline, ctx);
    const time = el('span', teamClock(run.seconds_running), 'team-time');
    const end = el('div', null, 'team-end');
    end.append(time, el('span', teamSubsText(run), 'team-subs'));
    teamTimes.set(row.issue_id, { node: time, action, since: now - (run.seconds_running || 0) * 1000 });
    a.append(head, avs, cast, end);
    return a;
  }

  function tickTeams(now) {
    for (const t of teamTimes.values()) {
      const text = teamClock((now - t.since) / 1000);
      if (t.node.textContent !== text) t.node.textContent = text;
    }
  }

  function renderTeams(host, state, now) {
    const rows = (state.issues || []).filter((r) => r.running);
    const fp = JSON.stringify(rows.map((r) => [r.issue_id, r.issue_identifier, r.title, r.repo, r.state,
      teamAgents(r).map((s) => [s.id, s.status, s.verdict, s.round, (s.sessions || []).length]),
      r.running.role, !!r.running.session_id, teamPercent(r.running), teamSubsText(r.running)]));
    if (fp === teamFp) {
      for (const r of rows) {
        const t = teamTimes.get(r.issue_id);
        if (!t) continue;
        t.since = now - (r.running.seconds_running || 0) * 1000;
        const text = teamActionText(r.running);
        if (t.action.textContent !== text) t.action.textContent = text;
        t.action.setAttribute('title', String(r.running.last_message || r.running.last_event || ''));
      }
      tickTeams(now);
      return rows.length;
    }
    teamFp = fp;
    teamTimes.clear();
    if (!rows.length) host.replaceChildren(el('p', 'Kein Team spielt gerade', 'team-empty'));
    else host.replaceChildren(...rows.map((r) => teamRow(r, now)));
    return rows.length;
  }
`;
