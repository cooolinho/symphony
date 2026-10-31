import { LOOP_VERDICTS } from '../workflow/results.ts';

/**
 * "Teams" section of the overview: one link row per running issue with the role avatars of its pipeline,
 * the action of the active role, context bar, live run time and subagent count. Like pipeline.ts it is
 * inlined into the page (TEAMS_CSS/TEAMS_JS next to BASE_JS) and unit-testable in a vm; all top-level
 * names start with `team`/`TEAM_` so they cannot collide with the dashboard script.
 */
export const TEAMS_CSS = `
  .team-list { display: grid; gap: 8px; }
  .team-row { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1.6fr) auto; align-items: center; gap: 10px 18px;
    min-height: 44px; padding: 12px 16px; border-radius: 16px; border: 1px solid rgba(255, 255, 255, .08);
    background: rgba(255, 255, 255, .03); color: inherit; text-decoration: none; }
  .team-row:hover { background: rgba(255, 255, 255, .06); text-decoration: none; }
  .team-row:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .team-head, .team-cast { min-width: 0; display: grid; gap: 4px; }
  .team-num { font: 600 11px var(--mono); color: var(--fg-3, var(--muted)); }
  .team-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .team-meta, .team-action { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--fg-3, var(--muted)); }
  .team-action { color: var(--fg-2, var(--text-2)); }
  .team-action.muted { color: var(--fg-3, var(--muted)); }
  .team-avs { display: flex; flex-wrap: wrap; gap: 6px; }
  .team-stats { display: grid; grid-template-columns: 120px auto auto; gap: 14px; align-items: center;
    font-family: var(--mono); font-size: 12px; font-variant-numeric: tabular-nums; }
  .team-ctx { display: flex; align-items: center; gap: 8px; }
  .team-ctx .ui-bar { flex: 1; }
  .team-empty { color: var(--fg-3, var(--muted)); margin: 0; }
  @media (max-width: 640px) {
    .team-row { grid-template-columns: minmax(0, 1fr); }
    .team-stats { grid-template-columns: 1fr auto auto; }
  }
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

  function teamAction(run) {
    return run.session_id ? teamTrunc(run.last_message || run.last_event || '', 80) : 'Wartet auf Session';
  }

  function teamSubs(run) {
    const sub = run.subagents || {};
    const live = (sub.running || []).length;
    return live + '/' + (live + (sub.finished || []).length);
  }

  function teamPercent(run) {
    const p = run.context ? run.context.percent : null;
    return typeof p === 'number' && Number.isFinite(p) ? p : null;
  }

  function teamRow(row, now) {
    const run = row.running;
    const id = String(row.issue_identifier || '');
    const a = el('a', null, 'team-row');
    a.setAttribute('href', '/issue?id=' + encodeURIComponent(id));
    const agents = teamAgents(row);
    const round = Math.max(1, ...agents.map((s) => s.round || 0));
    const head = el('div', null, 'team-head');
    head.append(
      el('span', '#' + id.slice(id.lastIndexOf('#') + 1), 'team-num'),
      el('span', row.title || id, 'team-title'),
      el('span', (row.repo || id.split('#')[0]) + ' · ' + (row.state || '') + ' · Runde ' + round, 'team-meta'),
    );
    const cast = el('div', null, 'team-cast');
    const avs = el('div', null, 'team-avs');
    for (const s of agents) avs.append(avatar(s.id, teamAvatarState(s, run)));
    const action = el('span', teamAction(run), 'team-action' + (run.session_id ? '' : ' muted'));
    action.setAttribute('title', String(run.last_message || run.last_event || ''));
    cast.append(avs, action);
    const stats = el('div', null, 'team-stats');
    const ctx = el('span', null, 'team-ctx');
    const p = teamPercent(run);
    if (p === null) ctx.append(el('span', '—', 'team-ctx-pct'));
    else {
      const b = bar(p, { height: 6 });
      b.setAttribute('aria-label', 'Context');
      ctx.append(b, el('span', Math.round(p) + ' %', 'team-ctx-pct'));
    }
    const time = el('span', teamClock(run.seconds_running), 'team-time');
    teamTimes.set(row.issue_id, { node: time, action, since: now - (run.seconds_running || 0) * 1000 });
    stats.append(ctx, time, el('span', teamSubs(run) + ' Subagents', 'team-subs'));
    a.append(head, cast, stats);
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
      r.running.role, !!r.running.session_id, teamPercent(r.running), teamSubs(r.running)]));
    if (fp === teamFp) {
      for (const r of rows) {
        const t = teamTimes.get(r.issue_id);
        if (!t) continue;
        t.since = now - (r.running.seconds_running || 0) * 1000;
        const text = teamAction(r.running);
        if (t.action.textContent !== text) t.action.textContent = text;
        t.action.setAttribute('title', String(r.running.last_message || r.running.last_event || ''));
      }
      tickTeams(now);
      return rows.length;
    }
    teamFp = fp;
    teamTimes.clear();
    if (!rows.length) host.replaceChildren(el('p', 'Kein Team arbeitet gerade.', 'team-empty'));
    else host.replaceChildren(...rows.map((r) => teamRow(r, now)));
    return rows.length;
  }
`;
