import type { AgentToolContext, AgentToolSpec, AllowedTransition, Issue, StatusChange, ToolResult, TrackerAdapter } from '../tracker/types.ts';
import { SerialQueue } from '../util/async.ts';
import { SymphonyError, errorMessage } from '../util/errors.ts';
import { truncate } from '../util/text.ts';
import { classify, isComplexityLabel, isTypeLabel, type IssueComplexity, type IssueType } from '../workflow/classify.ts';
import { normalizeStateName, type ServiceConfig } from '../workflow/config.ts';
import { profileFor } from '../workflow/profile.ts';
import {
  RESULT_VERDICTS,
  resultBudgetNote,
  SPLIT_VERDICT,
  SUMMARY_MAX,
  parseResult,
  renderResultComment,
  toolInputShape,
  type ResultContext,
  type ResultMeta,
  type StageResult,
} from '../workflow/results.ts';
import type { RoleConfig } from '../workflow/roles.ts';
import { docsRoles, securityRoles } from '../workflow/validate.ts';
import { fitCheckOutput } from './guard.ts';
import { filesOutside } from './changed-files.ts';
import { docsNeeded, type DocsFacts } from './docs.ts';
import { screenshotsMissing, type ScreenshotFacts } from './screenshots.ts';
import { securityNeeded, type SecurityFacts } from './security.ts';
import { refactoringGoals, type PersistedResult, type StageHistory } from './stage-history.ts';
import { checkFailedRoute, resolveTransition, type RoundHistory, type StageConditions, type Transition, type TransitionProfile } from './transitions.ts';
import { isSubIssue, subIssueCount } from './work-packages.ts';

/** Name of the tool a role with `result` hands off with, instead of `set_status`. */
export const RESULT_TOOL = 'report_result';

/** Said in the tool description and in the role prompts: Claude Code drops a call whose JSON is broken before the tool runs. */
export const JSON_ARGUMENT_HINT =
  'Every argument must be valid JSON, or Claude Code rejects the call before it reaches Symphony and you must send it all again: list fields (`files`, `changed_files`, `findings` ...) are JSON arrays like `["a.md", "b.md"]`, never Markdown bullet lines; escape `\\"` and `\\\\` (also an ASCII quote after a German opening quote: close it with the typographic mark), no raw tab characters, write paths with `/`, describe regexes in words, keep the summary short and put details in the array fields.';
export const RESULT_RECORDED_NOTE = 'Result recorded — end your turn now.';

/**
 * Appended to every continuation prompt of a result-driven role (also to a custom `agent.continuation_prompt`): the
 * reminder that a stage ends with a result. `column` is the role's `on_missing_result`.
 */
export function resultReminder(column: string | null): string {
  const consequence = column !== null ? `Symphony moves the issue to "${column}" and posts a comment` : 'Symphony stops the stage and posts a comment';
  return (
    `Your stage ends with a result: call \`${RESULT_TOOL}\` now. This is the last turn of the session: nothing still running in the ` +
    'background reports back after it, so do not wait for it; report with what you have and name any check you could not finish. ' +
    `If you cannot finish, report the verdict \`blocked\` with the reason. ` +
    `If this session ends without a reported result, ${consequence}.`
  );
}

/**
 * What the tool needs from the tracker: the issue's current column, the comment, the move (including `auto_merge`)
 * and the limit label.
 */
export type ResultToolAdapter = Pick<TrackerAdapter, 'fetchIssuesByIds'> & Required<Pick<TrackerAdapter, 'postComment' | 'setStatus' | 'addLabels' | 'removeLabels'>>;

/** Facts for the result's meta that come from the session; read when the result is recorded. */
export interface ResultMetaSource {
  /** Hash of the workflow the session runs with; null when unknown. */
  workflowHash: string | null;
  /** Workspace commit; null outside git or when unknown. */
  headSha: () => Promise<string | null>;
  now?: () => Date;
}

/**
 * A role whose result may only come with changes to some paths (the test engineer: `pipeline.test_paths`). The rule is
 * checked when the agent reports, before the entry check of the target column; a file outside `allowed` refuses the
 * result with `invalid_result` and nothing is recorded.
 */
export interface PathRule {
  /** Path globs (see `src/workflow/glob.ts`) the role may change. */
  allowed: readonly string[];
  /**
   * The commit the role's changes are measured from (`base`) and the repository-relative files that differ from it,
   * looked up when the agent reports; throws when that cannot be told.
   */
  changedFiles: () => Promise<{ base: string; files: string[] }>;
  /** The setting `allowed` comes from, named in the refusal; default `pipeline.test_paths`. */
  setting?: string;
  /** What the role does instead of changing other files, ending the refusal; default: the test engineer's. */
  guidance?: string;
}

/** Offending files named in a refusal; more are counted. */
const OFFENDING_FILES_SHOWN = 25;

export interface ResultToolParams {
  /** The session's role; its `result` is the kind the tool reports. */
  role: RoleConfig;
  /**
   * Round counters and results of the issue's persisted results, loaded when the session starts (a run reports once).
   * A review reads the refactoring goals of the newest analysis from `results`.
   */
  history: RoundHistory & Partial<Pick<StageHistory, 'results' | 'failedChecks'>>;
  profile: TransitionProfile | null;
  flags?: StageConditions;
  /**
   * For a reviewer: what decides whether an approval needs the security review (see `securityNeeded`), looked up when the
   * agent reports `approved`. Without it the approval keeps its configured target.
   */
  security?: Pick<SecurityFacts, 'risk' | 'securityPaths' | 'changedFiles'> | null;
  /**
   * For a developer's `done` or a test engineer's `passed`: what decides whether the issue needs the documentation stage
   * (see `docsNeeded`), looked up when the agent reports. Without it the hand-off keeps its configured target.
   */
  docs?: Pick<DocsFacts, 'docsNeeded' | 'docsPaths' | 'triggerPaths' | 'changedFiles'> | null;
  /**
   * For a developer's `done`: what decides whether a UI change owes screenshots (see `screenshotsMissing`), checked before the
   * result is accepted. Without it nothing is checked.
   */
  screenshots?: ScreenshotFacts | null;
  config: Pick<ServiceConfig, 'tracker' | 'roles' | 'pipeline'>;
  /** The board's columns in board order; null when the tracker does not list them. */
  boardColumns: readonly string[] | null;
  adapter: ResultToolAdapter;
  /** The session's current issue; routing reads its description (the roles of later columns may depend on a command). */
  issue: () => Issue;
  /** The run recorded in the meta; null when unknown. */
  runId: string | null;
  meta: ResultMetaSource;
  /** For a role that may only change some paths: checked before a result is accepted; null = no restriction. */
  pathRule?: PathRule | null;
  /** Called once, when the result comment is posted (the result is recorded from then on), with the result as persisted. */
  onRecorded?: (entry: PersistedResult) => void;
  /** Called once, after the recorded result moved the issue (not when the move failed). */
  onMoved?: () => void;
}

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

function fail(category: string, message: string): ToolResult {
  return { ok: false, error: { category, message } };
}

/** Room kept for the cut marker and the line break before the check output in {@link withCheckFailedNote}. */
const NOTE_SLACK = 40;
/** Smallest piece of check output worth quoting. */
const MIN_QUOTED_OUTPUT = 200;

/**
 * The result with a note that its hand-off failed an entry check and went to `on_check_failed` instead. The note comes
 * after the summary and quotes as much of the check output as the summary limit leaves room for; the summary itself is
 * cut when the note alone would not fit.
 */
function withCheckFailedNote(
  result: StageResult,
  failed: NonNullable<AllowedTransition['checkFailed']>,
  target: string,
  limit: { repeated: string[]; max: number } | null,
): StageResult {
  const counts = new Map<string, number>();
  for (const column of limit?.repeated ?? []) counts.set(column, (counts.get(column) ?? 0) + 1);
  const named = [...counts].map(([column, n]) => `"${column}" (${n}×)`).join(', ');
  const note =
    limit === null
      ? `**Entry check failed.** The entry check for "${failed.target}" failed, so Symphony moved the issue to "${target}" ` +
        '(`on_check_failed`) instead of the column this result leads to.'
      : `**Entry check failed repeatedly.** The entry check for "${failed.target}" failed again; ${limit.repeated.length} hand-offs ` +
        `went back over \`on_check_failed\` (limit \`pipeline.max_check_failures\` = ${limit.max}): ${named}. Symphony moved the issue to ` +
        `"${target}" for a human instead of back to the developer.`;
  const summary = truncate(result.summary, Math.max(0, SUMMARY_MAX - note.length - 2));
  const room = SUMMARY_MAX - summary.length - note.length - NOTE_SLACK;
  const output = failed.output.trim();
  // Every failed check keeps its share (fitCheckOutput): the developer needs the ci failures as much as the smoke test's.
  // The indentation of every line counts too, so the output shrinks until the indented text fits.
  let quoted = '';
  for (let budget = room; output !== '' && budget >= MIN_QUOTED_OUTPUT; ) {
    const indented = fitCheckOutput(output, budget).replace(/^/gm, '    ');
    if (indented.length <= room) {
      quoted = `\n\n${indented}`;
      break;
    }
    budget -= indented.length - room;
  }
  return { ...result, summary: `${summary}\n\n${note}${quoted}` };
}

/** The result with `note` under its summary; the summary is cut when the note would not fit within `SUMMARY_MAX`. */
function withNote(result: StageResult, note: string): StageResult {
  const kept = note.length > SUMMARY_MAX ? '' : truncate(result.summary, SUMMARY_MAX - note.length - 2);
  return { ...result, summary: `${kept}\n\n${truncate(note, SUMMARY_MAX)}`.trim() };
}

/** Applies a transition's labels (removing only those the issue carries); failures become warnings. */
export async function applyTransitionLabels(
  adapter: Pick<ResultToolAdapter, 'addLabels' | 'removeLabels'>,
  issue: Issue,
  labels: Transition['labels'],
  warnings: string[],
): Promise<{ added: string[]; removed: string[] }> {
  const changed = { added: [] as string[], removed: [] as string[] };
  const carried = new Set(issue.labels.map((name) => name.toLowerCase()));
  const remove = labels.remove.filter((name) => carried.has(name.toLowerCase()));
  if (labels.add.length > 0) {
    try {
      const result = await adapter.addLabels(issue, labels.add, { create: true });
      changed.added = result.added;
      if (result.unknown.length > 0) warnings.push(`label(s) ${result.unknown.map((name) => `"${name}"`).join(', ')} do not exist and were not added`);
    } catch (error) {
      warnings.push(`could not add label(s) ${labels.add.join(', ')}: ${errorMessage(error)}`);
    }
  }
  if (remove.length > 0) {
    try {
      changed.removed = (await adapter.removeLabels(issue, remove)).removed;
    } catch (error) {
      warnings.push(`could not remove label(s) ${remove.join(', ')}: ${errorMessage(error)}`);
    }
  }
  return changed;
}

/** Type names an analysis may report besides the canonical ones: the aliases of `classify`. */
const TYPE_ALIASES: Readonly<Record<string, IssueType>> = {
  bug: 'bugfix',
  bugfix: 'bugfix',
  enhancement: 'feature',
  feature: 'feature',
  refactor: 'refactor',
  refactoring: 'refactor',
};

/**
 * The `Type:` and `Complexity:` labels an analysis result adds: only for a family the issue has no label of (a human's
 * label, or an alias such as `bug` or `feature`, always wins), and only for values the families know. A reported type
 * that maps to no `Type:` value (docs, chore) adds nothing.
 */
export function classificationLabels(result: StageResult, labels: readonly string[]): string[] {
  if (result.kind !== 'analysis') return [];
  const known = classify(labels);
  const added: string[] = [];
  const type = result.type === undefined ? undefined : TYPE_ALIASES[result.type.trim().toLowerCase()];
  if (type !== undefined && known.type === null && !labels.some(isTypeLabel)) added.push(`Type: ${type}`);
  const complexity: IssueComplexity | undefined = result.complexity;
  if (complexity !== undefined && known.complexity === null && !labels.some(isComplexityLabel)) added.push(`Complexity: ${complexity}`);
  return added;
}

/**
 * What the consistency rules of a result know of the session's issue and role: a refactor review has to confirm the
 * goals of the analysis (other issues and issues without goals are exempt), and a `split` design needs an XL issue that
 * is not a sub-issue and a role that may open a sub-issue per package.
 */
function resultContext(issue: Issue, role: RoleConfig, history: Partial<Pick<StageHistory, 'results'>>): ResultContext {
  const { type, complexity } = classify(issue.labels);
  const kind = role.result;
  return {
    refactoringGoals: kind === 'review' && type === 'refactor' ? refactoringGoals(history) : [],
    split: { complexity, subIssue: isSubIssue(issue), maxSubIssues: role.maxSubIssues },
  };
}

/** The conditions of one report: the configured flags plus what was looked up for this call. */
interface Conditions {
  flags: StageConditions;
  reasons: Readonly<Record<string, string>>;
}

type Plan = { ok: true; result: StageResult; transition: Transition } | { ok: false; failure: ToolResult };

/**
 * The `report_result` tool of one session (docs/results.md#the-report_result-tool). The agent reports a result;
 * Symphony validates it and computes the target column (`resolveTransition`). `transitionTarget` hands that column to
 * the transition guard (`guardTools`), so the move passes `may_move_to` and the entry checks like `set_status`, and a
 * failed check reaches the agent with nothing written. Only after the guard allowed the move, and a fresh read
 * confirmed the issue is still in one of the role's columns, does `execute` post the result comment (Markdown and
 * marker), move the issue (including `auto_merge`) and set the limit label.
 *
 * A run reports once: after the comment is posted, every further call returns the stored outcome without touching
 * the tracker. Calls run one at a time.
 */
export function createResultTool(params: ResultToolParams): AgentToolSpec {
  const { role, adapter } = params;
  const kind = role.result;
  if (kind === null) throw new Error(`role ${role.name} reports no result (roles.${role.name}.result is not set)`);
  const queue = new SerialQueue();
  const now = params.meta.now ?? (() => new Date());
  /** The outcome of the call that posted the result comment; null until one did. */
  let recorded: ToolResult | null = null;

  /** The conditions `transitionTarget` looked up, by the arguments of the call; `record` takes them over so both route alike. */
  const looked = new WeakMap<object, Conditions>();

  /**
   * The stage conditions for a call: the configured flags, and for a reviewer's `approved` whether the issue needs the
   * security review (labels, the analysis and the files of the branch diff), set for every security role. Looked up
   * asynchronously, before the synchronous {@link plan}.
   */
  const conditions = async (args: Record<string, unknown>): Promise<Conditions> => {
    const configured: Conditions = { flags: params.flags ?? {}, reasons: {} };
    const writers = docsRoles(params.config.roles);
    const docs = params.docs;
    if (docs !== undefined && docs !== null && writers.length > 0 && ((kind === 'implementation' && args.verdict === 'done') || (kind === 'test' && args.verdict === 'passed'))) {
      const decision = await docsNeeded(docs);
      return {
        flags: { ...configured.flags, ...Object.fromEntries(writers.map((writer) => [writer.name, decision.needed])) },
        reasons: Object.fromEntries(writers.map((writer) => [writer.name, decision.reason])),
      };
    }
    const security = params.security;
    const auditors = securityRoles(params.config.roles);
    if (security === undefined || security === null || kind !== 'review' || args.verdict !== 'approved' || auditors.length === 0) return configured;
    const decision = await securityNeeded({ ...security, labels: params.issue().labels });
    return {
      flags: { ...configured.flags, ...Object.fromEntries(auditors.map((auditor) => [auditor.name, decision.needed])) },
      reasons: Object.fromEntries(auditors.map((auditor) => [auditor.name, decision.reason])),
    };
  };

  const plan = (args: Record<string, unknown>, stage: Conditions = { flags: params.flags ?? {}, reasons: {} }): Plan => {
    const issue = params.issue();
    const parsed = parseResult(kind, args, resultContext(issue, role, params.history));
    if (!parsed.ok) return { ok: false, failure: fail('invalid_result', parsed.message) };
    // An analysis classifies the issue as it hands it on, so its `next` is routed by the labels it adds: the profile of
    // the new type and the `skip_when` conditions of the new complexity.
    const added = classificationLabels(parsed.result, issue.labels);
    const labels = [...issue.labels, ...added];
    const transition = resolveTransition({
      role,
      verdict: parsed.result.verdict,
      history: params.history,
      profile: added.length > 0 ? profileFor(params.config.pipeline, classify(labels).type) : params.profile,
      flags: stage.flags,
      flagReasons: stage.reasons,
      config: params.config,
      boardColumns: params.boardColumns,
      issue: { description: issue.description, labels },
    });
    if (!transition.ok) {
      return {
        ok: false,
        failure: fail(
          'transition_error',
          `Symphony cannot route this ${kind} result: ${transition.problem}. This is a configuration problem, not a problem ` +
            'with your result: nothing was recorded. Describe it in an issue comment and end your turn.',
        ),
      };
    }
    return { ok: true, result: parsed.result, transition };
  };

  /** The files outside the role's paths (with the commit they are measured from); null when no rule applies, `unverifiable` when git cannot tell. */
  const pathFacts = async (): Promise<{ rule: PathRule; base: string; outside: string[] } | { rule: PathRule; unverifiable: string } | null> => {
    const rule = params.pathRule;
    if (rule === undefined || rule === null) return null;
    try {
      const changed = await rule.changedFiles();
      return { rule, base: changed.base, outside: filesOutside(changed.files, rule.allowed) };
    } catch (error) {
      return { rule, unverifiable: errorMessage(error) };
    }
  };

  /**
   * The refusal for a result that comes with changes outside the role's paths; null when the rule holds or does not apply.
   * A `blocked` result is never refused: it is the way out for an agent that cannot go on, so `record` notes the files instead.
   */
  const pathViolation = async (args: Record<string, unknown>): Promise<ToolResult | null> => {
    if (args.verdict === 'blocked') return null;
    const facts = await pathFacts();
    if (facts === null) return null;
    if ('unverifiable' in facts) {
      return fail(
        'tool_error',
        `Symphony could not check which files you changed (${facts.unverifiable}), so nothing was recorded. This is not a ` +
          `problem with your change. Call ${RESULT_TOOL} again; if it fails again, report the verdict \`blocked\` with the problem as the blocker.`,
      );
    }
    const { rule, base, outside } = facts;
    if (outside.length === 0) return null;
    const shown = outside.slice(0, OFFENDING_FILES_SHOWN).map((file) => `- ${file}`);
    const more = outside.length > shown.length ? `\n- … and ${outside.length - shown.length} more` : '';
    return fail(
      'invalid_result',
      `The ${kind} result is invalid: role ${role.name} may only change files matching \`${rule.setting ?? 'pipeline.test_paths'}\` ` +
        `(${rule.allowed.length > 0 ? rule.allowed.join(', ') : 'none configured'}), but ${outside.length} file(s) that differ from ` +
        `commit ${base.slice(0, 12)} (the developer's last hand-off, else where your session started) are outside them:\n${shown.join('\n')}${more}\n` +
        'Nothing was recorded. Undo the changes you made yourself: restore a changed or deleted file with ' +
        `\`git checkout ${base.slice(0, 12)} -- <file>\`, delete a new one, commit, and report again. Leave a file alone that you did not ` +
        'change, for example a commit that was already on the branch or a push by someone else: report the verdict `blocked` with ' +
        'a blocker that names it, which is always accepted. ' +
        (rule.guidance ??
          'Production code belongs to the developer: if the tests fail because of it, report the verdict `failed` with the failed cases instead of fixing it.'),
    );
  };

  /** The note for a `blocked` result recorded with files outside the role's paths, or because git could not tell; null when there is nothing to say. */
  const pathNote = async (): Promise<string | null> => {
    const facts = await pathFacts();
    if (facts === null) return null;
    const setting = facts.rule.setting ?? 'pipeline.test_paths';
    if ('unverifiable' in facts) return `**Pfadregel:** Symphony konnte nicht prüfen, welche Dateien außerhalb \`${setting}\` geändert wurden (${facts.unverifiable}).`;
    if (facts.outside.length === 0) return null;
    const head = `**Pfadregel:** ${facts.outside.length} Datei(en) außerhalb \`${setting}\` seit \`${facts.base.slice(0, 12)}\`: `;
    const shown = facts.outside.slice(0, OFFENDING_FILES_SHOWN).map((file) => `\`${file}\``).join(', ');
    return `${head}${shown}${facts.outside.length > OFFENDING_FILES_SHOWN ? `, … und ${facts.outside.length - OFFENDING_FILES_SHOWN} weitere` : ''}`;
  };

  /** The refusal for a UI change without screenshots and without a `screenshots_problem`; null when the rule holds or does not apply. */
  const screenshotViolation = async (args: Record<string, unknown>): Promise<ToolResult | null> => {
    const facts = params.screenshots;
    if (facts === undefined || facts === null || kind !== 'implementation' || args.verdict !== 'done') return null;
    if (typeof args.screenshots_problem === 'string' && args.screenshots_problem.trim() !== '') return null;
    let decision;
    try {
      decision = await screenshotsMissing(facts);
    } catch (error) {
      return fail(
        'tool_error',
        `Symphony could not check which files you changed (${errorMessage(error)}), so nothing was recorded. This is not a ` +
          `problem with your change. Call ${RESULT_TOOL} again; if it fails again, describe the problem in an issue comment ` +
          'and end your turn.',
      );
    }
    if (!decision.missing) return null;
    const shown = decision.uiFiles.map((file) => `- ${file}`);
    const more = decision.more > 0 ? `\n- … and ${decision.more} more` : '';
    return fail(
      'invalid_result',
      `The ${kind} result is invalid: your change touches the UI (files matching \`pipeline.ui_paths\`), the project asks for ` +
        `screenshots, but no file matching \`pipeline.screenshot_paths\` (${facts.screenshotPaths.join(', ') || 'none configured'}) ` +
        `changed and \`screenshots_problem\` is not set. UI files:\n${shown.join('\n')}${more}\n` +
        'Nothing was recorded. Take the screenshots: build the frontend assets if the project needs them (install the dependencies, run the ' +
        '`build` script), start the app from this workspace with its own SQLite file and seed data, run `symphony-screenshot <url> <out.png>` ' +
        '(`symphony-screenshot --check` tests the browser), open the PNG with the Read tool to check it, commit it under the screenshot path, ' +
        'push, embed it in the pull request description by commit SHA, and report again. "No browser" and "no frontend build" are not ' +
        'reasons to skip them. If a step really fails, report again with `screenshots_problem`: the step that failed and its exact error message.',
    );
  };

  /**
   * The refusal for a `split` design whose work packages are not all sub-issues yet: the issue would go on to its
   * integration review with nothing to wait for. Read fresh, because the agent creates them in the same turn.
   */
  const splitViolation = async (args: Record<string, unknown>, context: AgentToolContext): Promise<ToolResult | null> => {
    const planned = plan(args);
    if (!planned.ok || planned.result.kind !== 'design' || planned.result.verdict !== SPLIT_VERDICT) return null;
    let issue: Issue | undefined;
    try {
      issue = (await adapter.fetchIssuesByIds([context.issue.id])).find((candidate) => candidate.id === context.issue.id);
    } catch (error) {
      return fail(
        'tracker_error',
        `Symphony could not read the sub-issues of the issue (${errorMessage(error)}), so nothing was recorded. Call ` +
          `${RESULT_TOOL} again; if it fails again, end your turn.`,
      );
    }
    // A vanished or moved issue is reported by `record`, after the guard.
    if (issue === undefined) return null;
    const count = subIssueCount(issue);
    const packages = planned.result.work_packages.length;
    if (count >= packages) return null;
    return fail(
      'invalid_result',
      `The ${kind} result is invalid: verdict "${SPLIT_VERDICT}" needs one sub-issue per work package, but ${issue.identifier} ` +
        `has ${count} sub-issue(s) for ${packages} work packages. Nothing was recorded. Create the missing ones with ` +
        'create_sub_issue (one per entry of `work_packages`, in that order; a title that exists is returned, not created twice), ' +
        'then report again.',
    );
  };

  const record = async (args: Record<string, unknown>, context: AgentToolContext): Promise<ToolResult> => {
    if (recorded !== null) return recorded.ok ? ok({ ...(recorded.data as object), already_recorded: true }) : recorded;
    const stage = looked.get(args) ?? (await conditions(args));
    looked.delete(args);
    const planned = plan(args, stage);
    if (!planned.ok) return planned.failure;
    // Fail closed: nothing is written unless the guard allowed exactly this move, or the `on_check_failed` fallback
    // after the computed move failed its entry check.
    const allowed = context.transition;
    const failed = allowed?.checkFailed;
    const route = failed !== undefined && role.readOnly ? checkFailedRoute({ role, history: params.history, config: params.config }) : null;
    const fallback = route?.column ?? null;
    const expected = fallback ?? planned.transition.target;
    if (
      allowed === undefined ||
      normalizeStateName(allowed.target) !== normalizeStateName(expected) ||
      (failed !== undefined && (fallback === null || normalizeStateName(failed.target) !== normalizeStateName(planned.transition.target)))
    ) {
      return fail('tool_error', `${RESULT_TOOL} ran without the transition guard's approval for "${expected}"; nothing was recorded`);
    }
    // The limit label belongs to the move the verdict leads to; a redirect to `on_check_failed` leaves it alone, unless
    // it is the one that reaches `max_check_failures`: that one goes to a human and carries the label.
    const limitReached = route?.limitReached === true;
    const limit = params.config.pipeline.limitLabel;
    const transition: Transition =
      failed === undefined
        ? planned.transition
        : {
            ...planned.transition,
            target: allowed.target,
            labels: limitReached ? { add: [limit], remove: [] } : { add: [], remove: [] },
            limitReached,
            reason: `${planned.transition.reason}; entry check for "${failed.target}" failed → "${allowed.target}" (${route?.note ?? 'on_check_failed'})`,
          };
    const repeated = [...(params.history.failedChecks ?? []), ...(failed !== undefined ? [failed.target] : [])];
    const note = planned.result.verdict === 'blocked' ? await pathNote() : null;
    const noted = note === null ? planned.result : withNote(planned.result, note);
    const result =
      failed === undefined
        ? noted
        : withCheckFailedNote(noted, failed, allowed.target, limitReached ? { repeated, max: params.config.pipeline.maxCheckFailures } : null);

    // The issue may have left the role's columns while the agent worked or the check ran (a human moved it): a result
    // for a column it is no longer in would move it back. Confirmed right before anything is written.
    let issue: Issue | undefined;
    try {
      issue = (await adapter.fetchIssuesByIds([context.issue.id])).find((candidate) => candidate.id === context.issue.id);
    } catch (error) {
      return fail(
        'tracker_error',
        `Symphony could not read the issue's column before recording the result (${errorMessage(error)}), so nothing was ` +
          `recorded and the issue was not moved. Call ${RESULT_TOOL} again; if it fails again, end your turn.`,
      );
    }
    if (issue === undefined || !role.states.includes(normalizeStateName(issue.state))) {
      const where = issue === undefined ? 'is no longer visible on the tracker' : `was moved to "${issue.state}"`;
      return fail(
        'issue_moved',
        `The issue ${where} while you worked (by a human or another run), so this ${kind} result was not recorded and ` +
          'the issue was not moved. Do not report again: end your turn now.',
      );
    }

    const meta: ResultMeta = {
      role: role.name,
      run: params.runId,
      round: transition.round,
      profile: params.profile?.name ?? null,
      workflow_hash: params.meta.workflowHash,
      head_sha: await params.meta.headSha().catch(() => null),
      checks: failed?.check ?? allowed.check,
      target: transition.target,
      ...(failed !== undefined ? { check_failed_for: failed.target } : {}),
      created_at: now().toISOString(),
    };
    let body: string;
    try {
      body = renderResultComment(result, meta);
    } catch (error) {
      if (error instanceof SymphonyError && error.code === 'result_too_large') return fail('invalid_result', `${error.message}, then report again`);
      throw error;
    }

    let url: string | null;
    try {
      url = (await adapter.postComment(issue, body)).url;
    } catch (error) {
      return fail(
        'comment_failed',
        `Posting the result comment failed (${errorMessage(error)}), so nothing was recorded and the issue was not moved. ` +
          `Call ${RESULT_TOOL} again; if it fails again, end your turn.`,
      );
    }

    // The result is recorded from here on; the move and the labels follow it, and a repeated call changes nothing.
    params.onRecorded?.({ result, meta, url });
    // An analysis classifies the issue before the stage hands it on, so the next stage (its profile, its model) sees the labels.
    const warnings: string[] = [];
    const classified = await applyTransitionLabels(adapter, issue, { add: classificationLabels(result, issue.labels), remove: [] }, warnings);
    let change: StatusChange;
    try {
      change = await adapter.setStatus(issue, transition.target, { checkedSha: allowed.check?.sha ?? null });
    } catch (error) {
      // The labels belong to the move, so they stay as they are. The run ends after this turn; the next dispatch
      // completes the move from the result's marker without a session (docs/usage.md#failures-of-result-driven-stages).
      recorded = fail(
        'status_failed',
        `The ${kind} result was recorded${url !== null ? ` (${url})` : ''}, but moving the issue to "${transition.target}" ` +
          `failed: ${errorMessage(error)}. Do not report again: end your turn now. The issue stays in "${issue.state}" ` +
          'for now; Symphony completes the move later without running this stage again.',
      );
      return recorded;
    }
    params.onMoved?.();
    const labels = await applyTransitionLabels(adapter, issue, transition.labels, warnings);
    labels.added.unshift(...classified.added);
    recorded = ok({
      kind,
      verdict: result.verdict,
      target: transition.target,
      status: change.status,
      previous_status: change.previous,
      round: transition.round,
      reason: transition.reason,
      checks: (failed?.check ?? allowed.check)?.result ?? null,
      ...(failed !== undefined ? { check_failed_for: failed.target } : {}),
      comment_url: url,
      ...(labels.added.length > 0 || labels.removed.length > 0 ? { labels } : {}),
      ...(change.autoMerge !== undefined ? { auto_merge: change.autoMerge } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      note: RESULT_RECORDED_NOTE,
    });
    return recorded;
  };

  return {
    name: RESULT_TOOL,
    description:
      `Report the result of your stage (a ${kind} result; verdict one of ${RESULT_VERDICTS[kind].join(', ')}) and hand the ` +
      'issue on. Symphony checks the result, computes the next column from the verdict and runs that column\'s entry ' +
      'checks; when they pass, it posts the result as an issue comment and moves the issue. Report once, when the stage ' +
      'is complete, then end your turn. If the result is invalid or a check fails, nothing is recorded and the issue ' +
      `stays: do what the error message says and report again. ${resultBudgetNote()} ${JSON_ARGUMENT_HINT}`,
    inputSchema: toolInputShape(kind),
    mutates: true,
    transitionTarget: async (args) => {
      if (recorded !== null) return null;
      const stage = await conditions(args);
      looked.set(args, stage);
      const planned = plan(args, stage);
      return planned.ok ? planned.transition.target : null;
    },
    checkFailedTarget: (args) => {
      if (recorded !== null || !role.readOnly) return null;
      return plan(args, looked.get(args)).ok ? (checkFailedRoute({ role, history: params.history, config: params.config })?.column ?? null) : null;
    },
    precheck: (args, context) => queue.run(async () => (await pathViolation(args)) ?? (await screenshotViolation(args)) ?? (await splitViolation(args, context))),
    execute: (args, context) => queue.run(() => record(args, context)),
  };
}
