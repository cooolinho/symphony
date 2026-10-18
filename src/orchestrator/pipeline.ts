import { normalizeStateName } from '../workflow/config.ts';
import type { WorkflowProfile } from '../workflow/profile.ts';
import { NEXT_STAGE, resultTargets, roleFor, roleName, type RoleConfig } from '../workflow/roles.ts';
import type { PersistedResult } from './stage-history.ts';

/** One agent session attributed to a pipeline stage (the `#sessionJson` shape without the transcript). */
export interface StageSession {
  run: string;
  attempt: number | null;
  role: string;
  state: string;
  model: string | null;
  effort: string | null;
  started_at: string;
  finished_at: string | null;
  outcome: string | null;
}

/** A session of a pipeline stage with the result it reported (matched by run and role). */
export interface PipelineSession extends StageSession {
  /** Verdict of the result this session reported; null when it reported none (or none is known). */
  verdict: string | null;
  /** Round the result was recorded for; null when not counted. */
  round: number | null;
}

/**
 * One station of an issue's path across the board: an agent role, a human column such as "In review",
 * or a terminal column. Stages are ordered left to right as the issue traverses them.
 */
export interface PipelineStage {
  /** Role name for agent stages, else `human:<column>` / `terminal:<column>` (normalized column). */
  id: string;
  label: string;
  kind: 'agent' | 'human' | 'terminal';
  /** Board columns this stage spans, in their original casing. */
  columns: string[];
  /** `skipped`: the issue's workflow profile or a `skipped` result leaves the stage out and no session ran there. */
  status: 'done' | 'active' | 'pending' | 'skipped';
  /** Sessions of this stage's role, oldest first; always empty for human and terminal stages. */
  sessions: PipelineSession[];
  /** Verdict of the role's newest result since the last reset; null without one (and for human and terminal stages). */
  verdict: string | null;
  /** Round of that result; null when not counted or without a result. */
  round: number | null;
}

export interface PipelineInput {
  issue: { state: string; description: string | null };
  /** Column-scoped roles; null = the implicit `default` role serves every active column. */
  roles: readonly RoleConfig[] | null;
  activeStates: string[];
  terminalStates: string[];
  /** The board's columns in board order when known (adapter statusOptions), for stage ordering. */
  boardColumns: string[] | null;
  /** The issue's session history, oldest first. */
  sessions: StageSession[];
  /** Roles the issue's workflow profile skips; their stages show as `skipped`. Omitted = none. */
  skip?: readonly string[];
  /** The issue's workflow profile, whose `on_result` overrides route issues too. Omitted = the roles' own routing. */
  profile?: Pick<WorkflowProfile, 'onResult'> | null;
  /** The issue's persisted stage results (see `buildStageHistory`), in any order. Omitted = none known. */
  results?: readonly PersistedResult[];
}

function columnIndex(boardColumns: string[] | null): Map<string, number> {
  const index = new Map<string, number>();
  if (boardColumns === null) return index;
  boardColumns.forEach((column, i) => {
    const key = normalizeStateName(column);
    if (!index.has(key)) index.set(key, i);
  });
  return index;
}

/** `columns` sorted by board order; columns the board does not know keep their relative order at the end. */
function sortByBoard(columns: string[], index: Map<string, number>): string[] {
  return columns
    .map((column, i) => ({ column, at: index.get(normalizeStateName(column)) ?? Number.MAX_SAFE_INTEGER - columns.length + i }))
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.column);
}

/**
 * Non-active, non-terminal columns every role may move to: the shared escape hatch (the "Blocked" column
 * in the default workflow), shown as a status, never as a pipeline stage. A hand-off column such as
 * "In review" is not one, because the first role never targets it. Roles without a `may_move_to` list are
 * unrestricted and do not narrow the intersection; conservatively empty without roles or with fewer than
 * two restricted roles.
 */
export function blockedBucketColumns(
  roles: readonly RoleConfig[] | null,
  activeStates: string[],
  terminalStates: string[],
): string[] {
  if (roles === null) return [];
  const active = new Set(activeStates.map(normalizeStateName));
  const terminal = new Set(terminalStates.map(normalizeStateName));
  const restricted = roles.filter((role) => role.mayMoveTo !== null);
  if (restricted.length < 2) return [];
  const counts = new Map<string, { column: string; roles: number }>();
  for (const role of restricted) {
    for (const column of new Set((role.mayMoveTo ?? []).map((c) => c.trim())).values()) {
      const key = normalizeStateName(column);
      if (active.has(key) || terminal.has(key)) continue;
      const entry = counts.get(key) ?? { column, roles: 0 };
      entry.roles++;
      counts.set(key, entry);
    }
  }
  return [...counts.values()].filter((entry) => entry.roles === restricted.length).map((entry) => entry.column);
}

/**
 * The normalized active columns that issues are led to: the targets of every role's `on_result`, `on_check_failed`,
 * `on_missing_result` and `on_round_limit` (and of the profile's `on_result` overrides), and, for a role that uses
 * `next`, every active column after its own. A role that hands off with `set_status` instead of a result (and the
 * implicit default role of a column no role serves) moves the issue wherever it likes: its `may_move_to` columns, or
 * any active column when it has no such list. `activeColumns` is in board order; `description` picks the role of a
 * column like the dispatcher does (an issue command). Conservative: a column counted here may still never be entered,
 * but a column that is not can only be entered by hand.
 */
function routedColumns(
  roles: readonly RoleConfig[],
  activeColumns: readonly string[],
  description: string | null,
  profile: PipelineInput['profile'],
): Set<string> {
  const routed = new Set<string>();
  for (const role of roles) {
    const overrides = Object.values(profile?.onResult[role.name] ?? {});
    for (const target of [...resultTargets(role), ...overrides]) {
      if (target !== NEXT_STAGE) routed.add(normalizeStateName(target));
    }
    if (![...Object.values(role.onResult), ...overrides].includes(NEXT_STAGE)) continue;
    const last = activeColumns.findLastIndex((column) => role.states.includes(normalizeStateName(column)));
    if (last === -1) continue;
    for (const column of activeColumns.slice(last + 1)) routed.add(normalizeStateName(column));
  }
  for (const column of activeColumns) {
    const role = roleFor({ state: column, description }, roles);
    if (role?.result != null) continue;
    for (const target of role?.mayMoveTo ?? activeColumns) routed.add(normalizeStateName(target));
  }
  return routed;
}

/** Results oldest first; ties and unparseable timestamps keep the input order. */
function chronological(results: readonly PersistedResult[]): PersistedResult[] {
  const at = (entry: PersistedResult): number => {
    const time = Date.parse(entry.meta.created_at);
    return Number.isNaN(time) ? 0 : time;
  };
  return results
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => at(a.entry) - at(b.entry) || a.i - b.i)
    .map(({ entry }) => entry);
}

/**
 * The ordered stations an issue passes on its way across the board, with each station's status and the
 * sessions already run there.
 *
 * Agent stages come from the active columns (board order when known): each column's serving role via
 * `roleFor`, consecutive columns of the same role merged into one stage. A column served by a role that hands off with
 * results is left out unless the flow leads to it (a result's target, or a move another role may make with
 * `set_status`, see `routedColumns`), the first stage serves it, or the issue is in it: a stage nothing routes to (the
 * optional Testing column while the developer hands over to Agent review) is not part of the pipeline, so it never
 * shows as done without having run. Human stages are the non-active,
 * non-terminal columns the final agent stage may move to that not every role lists — that singles out a
 * hand-off column such as "In review" and excludes the shared "Blocked" escape hatch (see
 * `blockedBucketColumns`). When the heuristic yields nothing, the pipeline is agent stages plus the
 * terminal columns, which is always correct. Session history marks a role's stage done even when the
 * column moved backwards; sessions of roles no longer derived get a trailing stage so history never drops. Stages of
 * roles in `skip` (the issue's profile) or whose newest result is a `skipped` marker are `skipped` unless they have
 * sessions. Sessions and stages carry the verdict and round of the results in `results`.
 */
export function derivePipeline(input: PipelineInput): PipelineStage[] {
  const { issue, roles, activeStates, terminalStates, boardColumns, sessions, skip = [], results = [], profile = null } = input;
  const index = columnIndex(boardColumns);
  const active = new Set(activeStates.map(normalizeStateName));
  const terminal = new Set(terminalStates.map(normalizeStateName));

  // Agent stages: one per run of consecutive active columns served by the same role.
  const agents: PipelineStage[] = [];
  const activeColumns = sortByBoard(activeStates, index).filter((column) => !terminal.has(normalizeStateName(column)));
  const routed = roles === null ? new Set<string>() : routedColumns(roles, activeColumns, issue.description, profile);
  const entry = new Set(roleFor({ state: activeColumns[0] ?? '', description: issue.description }, roles ?? null)?.states ?? []);
  for (const column of activeColumns) {
    const key = normalizeStateName(column);
    const role = roleFor({ state: column, description: issue.description }, roles ?? null);
    // Only a column served by a role with results can be left out, and only when nothing leads to it: the results
    // and the `set_status` moves of the other roles are all counted in `routed`.
    if (role?.result != null && !routed.has(key) && !entry.has(key) && key !== normalizeStateName(issue.state)) continue;
    const name = roleName(role);
    const last = agents.at(-1);
    if (last !== undefined && last.id === name) last.columns.push(column);
    else agents.push({ id: name, label: name, kind: 'agent', columns: [column], status: 'pending', sessions: [], verdict: null, round: null });
  }

  // Human stages: hand-off columns of the final agent stage that are not every role's shared target.
  const humans: PipelineStage[] = [];
  const lastRoleName = agents.at(-1)?.id;
  const lastRole = roles?.find((role) => role.name === lastRoleName) ?? null;
  if (roles !== null && lastRole !== null && lastRole.mayMoveTo !== null) {
    const shared = new Set(blockedBucketColumns(roles, activeStates, terminalStates).map(normalizeStateName));
    for (const column of sortByBoard(lastRole.mayMoveTo, index)) {
      const key = normalizeStateName(column);
      if (active.has(key) || terminal.has(key) || shared.has(key)) continue;
      humans.push({ id: `human:${key}`, label: column, kind: 'human', columns: [column], status: 'pending', sessions: [], verdict: null, round: null });
    }
  }

  const terminals: PipelineStage[] = [];
  for (const column of sortByBoard(terminalStates, index)) {
    const key = normalizeStateName(column);
    if (terminals.some((stage) => stage.id === `terminal:${key}`)) continue;
    terminals.push({ id: `terminal:${key}`, label: column, kind: 'terminal', columns: [column], status: 'pending', sessions: [], verdict: null, round: null });
  }

  const stages = [...agents, ...humans, ...terminals];

  // Attribute sessions to their role's stage; roles no longer derived get a trailing agent stage.
  for (const session of sessions) {
    let stage = stages.find((candidate) => candidate.kind === 'agent' && candidate.id === session.role);
    if (stage === undefined) {
      stage = { id: session.role, label: session.role, kind: 'agent', columns: [], status: 'pending', sessions: [], verdict: null, round: null };
      stages.splice(agents.length, 0, stage);
      agents.push(stage);
    }
    stage.sessions.push({ ...session, verdict: null, round: null });
    if (stage.columns.length === 0) stage.columns.push(session.state);
  }

  // Status: the stage holding the issue's column is active, earlier done, later pending. An issue in a
  // column outside the pipeline (e.g. "Blocked") counts from the last session's column instead.
  const stageAt = (state: string | undefined): number => {
    if (state === undefined) return -1;
    const key = normalizeStateName(state);
    return stages.findIndex((stage) => stage.columns.some((column) => normalizeStateName(column) === key));
  };
  let current = stageAt(issue.state);
  const isTerminalState = terminal.has(normalizeStateName(issue.state));
  if (current === -1) current = stageAt(sessions.at(-1)?.state);
  for (const [i, stage] of stages.entries()) {
    if (current === -1) stage.status = 'pending';
    else if (i < current || (isTerminalState && i === current)) stage.status = 'done';
    else if (i === current) stage.status = 'active';
    else stage.status = 'pending';
  }
  // A role that handed off is done even when the board moved backwards past its columns.
  for (const stage of stages) {
    if (stage.kind === 'agent' && stage.status === 'pending' && stage.sessions.some((session) => session.outcome === 'handed_off')) {
      stage.status = 'done';
    }
  }
  // Results: a session shows the verdict it reported, a stage the newest one of its role.
  const timeline = chronological(results);
  for (const stage of stages) {
    if (stage.kind !== 'agent') continue;
    const own = timeline.filter((entry) => entry.meta.role === stage.id);
    for (const session of stage.sessions) {
      const reported = own.findLast((entry) => entry.meta.run !== null && entry.meta.run === session.run && entry.result.kind !== 'skipped');
      session.verdict = reported?.result.verdict ?? null;
      session.round = reported?.meta.round ?? null;
    }
    const latest = own.findLast((entry) => entry.result.kind !== 'reset');
    stage.verdict = latest?.result.verdict ?? null;
    stage.round = latest?.meta.round ?? null;
  }
  // A stage the profile leaves out or a `skipped` result marks stays `skipped` unless a session already ran there.
  for (const stage of stages) {
    if (stage.kind !== 'agent' || stage.sessions.length > 0) continue;
    if (skip.includes(stage.id) || stage.verdict === 'skipped') stage.status = 'skipped';
  }
  return stages;
}
