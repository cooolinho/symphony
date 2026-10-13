import { normalizeStateName } from '../workflow/config.ts';
import { roleFor, roleName, type RoleConfig } from '../workflow/roles.ts';

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
  status: 'done' | 'active' | 'pending';
  /** Sessions of this stage's role, oldest first; always empty for human and terminal stages. */
  sessions: StageSession[];
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
 * The ordered stations an issue passes on its way across the board, with each station's status and the
 * sessions already run there.
 *
 * Agent stages come from the active columns (board order when known): each column's serving role via
 * `roleFor`, consecutive columns of the same role merged into one stage. Human stages are the non-active,
 * non-terminal columns the final agent stage may move to that not every role lists — that singles out a
 * hand-off column such as "In review" and excludes the shared "Blocked" escape hatch (see
 * `blockedBucketColumns`). When the heuristic yields nothing, the pipeline is agent stages plus the
 * terminal columns, which is always correct. Session history marks a role's stage done even when the
 * column moved backwards; sessions of roles no longer derived get a trailing stage so history never drops.
 */
export function derivePipeline(input: PipelineInput): PipelineStage[] {
  const { issue, roles, activeStates, terminalStates, boardColumns, sessions } = input;
  const index = columnIndex(boardColumns);
  const active = new Set(activeStates.map(normalizeStateName));
  const terminal = new Set(terminalStates.map(normalizeStateName));

  // Agent stages: one per run of consecutive active columns served by the same role.
  const agents: PipelineStage[] = [];
  for (const column of sortByBoard(activeStates, index)) {
    if (terminal.has(normalizeStateName(column))) continue;
    const role = roleFor({ state: column, description: issue.description }, roles ?? null);
    const name = roleName(role);
    const last = agents.at(-1);
    if (last !== undefined && last.id === name) last.columns.push(column);
    else agents.push({ id: name, label: name, kind: 'agent', columns: [column], status: 'pending', sessions: [] });
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
      humans.push({ id: `human:${key}`, label: column, kind: 'human', columns: [column], status: 'pending', sessions: [] });
    }
  }

  const terminals: PipelineStage[] = [];
  for (const column of sortByBoard(terminalStates, index)) {
    const key = normalizeStateName(column);
    if (terminals.some((stage) => stage.id === `terminal:${key}`)) continue;
    terminals.push({ id: `terminal:${key}`, label: column, kind: 'terminal', columns: [column], status: 'pending', sessions: [] });
  }

  const stages = [...agents, ...humans, ...terminals];

  // Attribute sessions to their role's stage; roles no longer derived get a trailing agent stage.
  for (const session of sessions) {
    let stage = stages.find((candidate) => candidate.kind === 'agent' && candidate.id === session.role);
    if (stage === undefined) {
      stage = { id: session.role, label: session.role, kind: 'agent', columns: [], status: 'pending', sessions: [] };
      stages.splice(agents.length, 0, stage);
      agents.push(stage);
    }
    stage.sessions.push(session);
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
  return stages;
}
