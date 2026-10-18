import type { Issue } from '../tracker/types.ts';
import { normalizeStateName, type ServiceConfig } from '../workflow/config.ts';
import { classify } from '../workflow/classify.ts';
import { profileSkipReason, type WorkflowProfile } from '../workflow/profile.ts';
import { isLoopKind, LOOP_VERDICTS, type LoopKind } from '../workflow/results.ts';
import { NEXT_STAGE, roleFor, roleName, type RoleConfig } from '../workflow/roles.ts';
import { canMoveTo, laterActiveColumns, nextWithoutBoardOrder, securityRoles } from '../workflow/validate.ts';
import { blockedBucketColumns } from './pipeline.ts';
import type { StageHistory } from './stage-history.ts';

/** A workflow profile: a variant of the transition table for one kind of issue (bugfix, feature, …). */
export type TransitionProfile = WorkflowProfile;

/**
 * Whether a conditional stage is needed for the issue, by role name; roles not listed always run. An extra override on
 * top of the profile's `skip` and `skip_when` (see `profileSkips`), which `nextStage` always evaluates. The security
 * review (`result: security`) is the other way round: it runs only for `true`, see {@link securityStage}.
 */
export type StageConditions = Readonly<Record<string, boolean>>;

/** Round counters of the issue's persisted results; `securityRounds` is 0 when omitted. */
export type RoundHistory = Pick<StageHistory, 'reviewRounds' | 'testRounds'> & Partial<Pick<StageHistory, 'securityRounds'>>;

/** The round the next loop verdict of `kind` would be, minus one: the loop verdicts recorded so far. */
export function roundsDone(history: RoundHistory, kind: LoopKind): number {
  return kind === 'review' ? history.reviewRounds : kind === 'test' ? history.testRounds : (history.securityRounds ?? 0);
}

export interface TransitionInput {
  /** The role that reported the result. */
  role: RoleConfig;
  verdict: string;
  /** Round counters of the issue's persisted results, without the result being resolved. */
  history: RoundHistory;
  profile: TransitionProfile | null;
  flags?: StageConditions;
  /** Why a flag holds or not, by role name; named in the transition reason when it decided the route. */
  flagReasons?: Readonly<Record<string, string>>;
  config: Pick<ServiceConfig, 'tracker' | 'roles' | 'pipeline'>;
  /** The board's columns in board order (adapter `statusOptions`); null when the tracker does not list them. */
  boardColumns: readonly string[] | null;
  /**
   * For the roles serving later columns, which may depend on an issue command (`description`), and for the profile's
   * `skip_when` conditions (`labels`: the issue's `Complexity:`); omitted = no command, no complexity.
   */
  issue?: Pick<Issue, 'description'> & Partial<Pick<Issue, 'labels'>>;
}

/** The rule that picked the target, in the order the rules apply. */
export type TransitionRule = 'blocked' | 'round_limit' | 'on_result' | 'unmapped';

export interface Transition {
  ok: true;
  /** Column to move the issue to; always one the role may move to (`may_move_to`, never terminal). */
  target: string;
  labels: { add: string[]; remove: string[] };
  rule: TransitionRule;
  /** Human-readable explanation for logs and the result comment. */
  reason: string;
  limitReached: boolean;
  /** This result's round for a kind with a round limit (earlier loop verdicts + 1); null for other kinds. */
  round: number | null;
}

/** The configuration cannot route the result; dispatch validation reports the same cases up front where it can. */
export interface TransitionProblem {
  ok: false;
  problem: string;
}

export type TransitionOutcome = Transition | TransitionProblem;

type Target = { column: string; note: string } | { problem: string };

/**
 * Where an issue goes after `input.role` reported `input.verdict`. Pure; the rules apply in this order:
 *
 * 1. `blocked` → `on_result.blocked` when it names a column, else the blocked column (see {@link blockedColumn}).
 * 2. A loop verdict (review `changes_needed`, test `failed`, security `issues_found`) whose round reaches
 *    `max_review_rounds` / `max_test_rounds` (the profile's when set) / `max_security_rounds` → `on_round_limit`, else
 *    the blocked column, plus `limit_label`.
 * 3. `on_result[verdict]` (the profile's override first); `next` is the first active column after the role's
 *    columns in board order whose role the profile does not skip (`skip`, or `skip_when` for the issue's complexity).
 *    A verdict without a target goes to the blocked column. A reviewer's `approved` that leads out of the active
 *    columns (to the human review) goes to the security review first when `flags` say it is needed ({@link securityStage}).
 *
 * Every other transition removes `limit_label`, so an issue that left the limit behind loses it. A target the role may
 * not move to is a problem, never a transition.
 */
export function resolveTransition(input: TransitionInput): TransitionOutcome {
  const { role, verdict, config } = input;
  const kind = role.result;
  if (kind === null) return { ok: false, problem: `role ${role.name} reports no result (roles.${role.name}.result is not set)` };
  const override = input.profile !== null && Object.hasOwn(input.profile.onResult, role.name) ? input.profile.onResult[role.name] : {};
  const onResult = new Map(Object.entries({ ...role.onResult, ...override }));
  const round = isLoopKind(kind) ? roundsDone(input.history, kind) + 1 : null;
  const max = maxRounds(input);
  const limitReached = isLoopKind(kind) && verdict === LOOP_VERDICTS[kind] && round !== null && max !== null && round >= max;

  let rule: TransitionRule;
  let target: Target;
  if (verdict === 'blocked') {
    rule = 'blocked';
    const configured = onResult.get('blocked');
    target = configured !== undefined && configured !== NEXT_STAGE ? { column: configured, note: 'on_result.blocked' } : blockedColumn(input);
  } else if (limitReached) {
    rule = 'round_limit';
    target = role.onRoundLimit !== null ? { column: role.onRoundLimit, note: 'on_round_limit' } : blockedColumn(input);
  } else {
    const mapped = onResult.get(verdict);
    rule = mapped === undefined ? 'unmapped' : 'on_result';
    if (mapped === undefined) target = blockedColumn(input);
    else if (mapped === NEXT_STAGE) target = nextStage(input);
    else target = securityStage(input, { column: mapped, note: `on_result.${verdict}` });
  }

  const label = `${kind} ${verdict}${round !== null ? ` (round ${round}${max !== null ? ` of ${max}` : ''})` : ''}`;
  if ('problem' in target) return { ok: false, problem: `${label}: ${target.problem}` };
  if (!canMoveTo(role, target.column, config.tracker.terminalStates)) {
    return { ok: false, problem: `${label}: role ${role.name} may not move issues to "${target.column}" (${target.note})` };
  }
  const limit = config.pipeline.limitLabel;
  const why = rule === 'unmapped' ? `no on_result target for ${verdict}, ${target.note}` : rule === 'round_limit' ? `round limit reached, ${target.note}` : target.note;
  return {
    ok: true,
    target: target.column,
    labels: limitReached ? { add: [limit], remove: [] } : { add: [], remove: [limit] },
    rule,
    reason: `${label} → "${target.column}" (${why})`,
    limitReached,
    round,
  };
}

/** The round limit for the role's result kind; null for kinds without one. */
function maxRounds({ role, profile, config }: TransitionInput): number | null {
  if (role.result === 'review') return profile?.maxReviewRounds ?? config.pipeline.maxReviewRounds;
  if (role.result === 'test') return profile?.maxTestRounds ?? config.pipeline.maxTestRounds;
  if (role.result === 'security') return config.pipeline.maxSecurityRounds;
  return null;
}

/**
 * The column for a stage that needs a human: the shared escape hatch every restricted role may move to (see
 * `blockedBucketColumns`, "Blocked" in the default workflow), else the role's `on_missing_result`.
 */
function blockedColumn({ role, config }: TransitionInput): Target {
  const shared = blockedBucketColumns(config.roles, config.tracker.activeStates, config.tracker.terminalStates);
  const candidates = [...shared.map((column) => ({ column, note: 'blocked column' }))];
  if (role.onMissingResult !== null) candidates.push({ column: role.onMissingResult, note: 'blocked column (on_missing_result)' });
  const allowed = candidates.find(({ column }) => canMoveTo(role, column, config.tracker.terminalStates));
  return allowed ?? { problem: `role ${role.name} has no blocked column to move to (set roles.${role.name}.on_missing_result)` };
}

/** The first later active stage in board order that the profile does not skip for the issue and whose condition holds. */
function nextStage(input: TransitionInput): Target {
  const { role, verdict, config, profile, flags = {}, boardColumns } = input;
  const { complexity } = classify(input.issue?.labels ?? []);
  const path = `roles.${role.name}.on_result.${verdict}`;
  if (boardColumns === null || boardColumns.length === 0) return { problem: nextWithoutBoardOrder(path) };
  const later = laterActiveColumns(role, config.tracker.activeStates, boardColumns);
  if (later === null) return { problem: `${path}: "${NEXT_STAGE}" needs the columns of role ${role.name} on the board` };
  const passed: string[] = [];
  for (const column of later) {
    const name = roleName(roleFor({ state: column, description: input.issue?.description ?? null }, config.roles));
    const why = profileSkipReason(profile, name, complexity);
    const skipped = why !== null ? `${name} ${why}` : flags[name] === false ? `${name} not needed` : null;
    if (skipped === null) return { column, note: [`on_result.${verdict} = ${NEXT_STAGE}`, ...passed].join(', ') };
    if (!passed.includes(skipped)) passed.push(skipped);
  }
  const why = passed.length > 0 ? ` (${passed.join(', ')})` : '';
  return { problem: `${path}: "${NEXT_STAGE}" has no later active stage after ${role.states.join(', ')} on the board${why}` };
}

/**
 * The reviewer's `approved` leads to the human review, which is no active column. When the issue needs a security
 * review, it goes to the column of the role with `result: security` first. That role must be in the active columns, the
 * profile must not skip it, and `flags[<role>]` must be `true`: the security check (see `securityNeeded`) is evaluated
 * by `report_result` and a resolver without it keeps the configured target. A `Security review` role the flags call not
 * needed leaves the target alone and says so in the note.
 */
function securityStage(input: TransitionInput, target: { column: string; note: string }): { column: string; note: string } {
  const { role, verdict, config, profile, flags = {}, flagReasons = {} } = input;
  if (role.result !== 'review' || verdict !== 'approved') return target;
  if (config.tracker.activeStates.some((state) => normalizeStateName(state) === normalizeStateName(target.column))) return target;
  const { complexity } = classify(input.issue?.labels ?? []);
  const notes: string[] = [];
  for (const auditor of securityRoles(config.roles)) {
    if (profileSkipReason(profile, auditor.name, complexity) !== null) continue;
    const column = config.tracker.activeStates.find((state) => auditor.states.includes(normalizeStateName(state)));
    if (column === undefined) continue;
    const why = flagReasons[auditor.name];
    if (flags[auditor.name] === true) return { column, note: `${target.note}, security review needed${why !== undefined ? `: ${why}` : ''}` };
    if (flags[auditor.name] === false) notes.push(`security review not needed${why !== undefined ? `: ${why}` : ''}`);
  }
  return notes.length > 0 ? { ...target, note: [target.note, ...notes].join(', ') } : target;
}
