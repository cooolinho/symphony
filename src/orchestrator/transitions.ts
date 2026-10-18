import type { Issue } from '../tracker/types.ts';
import type { ServiceConfig } from '../workflow/config.ts';
import { isLoopKind, LOOP_VERDICTS } from '../workflow/results.ts';
import { NEXT_STAGE, roleFor, roleName, type RoleConfig } from '../workflow/roles.ts';
import { canMoveTo, laterActiveColumns, nextWithoutBoardOrder } from '../workflow/validate.ts';
import { blockedBucketColumns } from './pipeline.ts';
import type { StageHistory } from './stage-history.ts';

/** A workflow profile: a variant of the transition table for one kind of issue (bugfix, feature, …). */
export interface TransitionProfile {
  name: string;
  /** Roles whose stages `next` passes over. */
  skip: readonly string[];
  /** `on_result` overrides per role name: verdict → column or `next`. */
  onResult: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Override of `pipeline.max_review_rounds`; null keeps it. */
  maxReviewRounds: number | null;
  /** Override of `pipeline.max_test_rounds`; null keeps it. */
  maxTestRounds: number | null;
}

/** Whether the condition of a conditional stage holds for the issue, by role name; roles not listed always run. */
export type StageConditions = Readonly<Record<string, boolean>>;

export interface TransitionInput {
  /** The role that reported the result. */
  role: RoleConfig;
  verdict: string;
  /** Round counters of the issue's persisted results, without the result being resolved. */
  history: Pick<StageHistory, 'reviewRounds' | 'testRounds'>;
  profile: TransitionProfile | null;
  flags: StageConditions;
  config: Pick<ServiceConfig, 'tracker' | 'roles' | 'pipeline'>;
  /** The board's columns in board order (adapter `statusOptions`); null when the tracker does not list them. */
  boardColumns: readonly string[] | null;
  /** For the roles serving later columns, which may depend on an issue command; omitted = no command. */
  issue?: Pick<Issue, 'description'>;
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
 * 2. A loop verdict (review `changes_needed`, test `failed`) whose round reaches `max_review_rounds` /
 *    `max_test_rounds` (the profile's when set) → `on_round_limit`, else the blocked column, plus `limit_label`.
 * 3. `on_result[verdict]` (the profile's override first); `next` is the first active column after the role's
 *    columns in board order whose role the profile does not skip and whose condition holds.
 *    A verdict without a target goes to the blocked column.
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
  const round = isLoopKind(kind) ? (kind === 'review' ? input.history.reviewRounds : input.history.testRounds) + 1 : null;
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
    else target = { column: mapped, note: `on_result.${verdict}` };
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

/** The first later active stage in board order that the profile does not skip and whose condition holds. */
function nextStage(input: TransitionInput): Target {
  const { role, verdict, config, profile, flags, boardColumns } = input;
  const path = `roles.${role.name}.on_result.${verdict}`;
  if (boardColumns === null || boardColumns.length === 0) return { problem: nextWithoutBoardOrder(path) };
  const later = laterActiveColumns(role, config.tracker.activeStates, boardColumns);
  if (later === null) return { problem: `${path}: "${NEXT_STAGE}" needs the columns of role ${role.name} on the board` };
  const passed: string[] = [];
  for (const column of later) {
    const name = roleName(roleFor({ state: column, description: input.issue?.description ?? null }, config.roles));
    const skipped =
      profile?.skip.includes(name) === true ? `${name} skipped by profile ${profile.name}` : flags[name] === false ? `${name} not needed` : null;
    if (skipped === null) return { column, note: [`on_result.${verdict} = ${NEXT_STAGE}`, ...passed].join(', ') };
    if (!passed.includes(skipped)) passed.push(skipped);
  }
  const why = passed.length > 0 ? ` (${passed.join(', ')})` : '';
  return { problem: `${path}: "${NEXT_STAGE}" has no later active stage after ${role.states.join(', ')} on the board${why}` };
}
