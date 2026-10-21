import { classify } from '../workflow/classify.ts';
import { normalizeStateName, type ServiceConfig } from '../workflow/config.ts';
import { profileFor, profileSkipReason } from '../workflow/profile.ts';
import { roleFor, type RoleConfig } from '../workflow/roles.ts';
import { laterActiveColumns } from '../workflow/validate.ts';
import type { Issue } from '../tracker/types.ts';

type SkipConfig = Pick<ServiceConfig, 'tracker' | 'roles' | 'pipeline' | 'checks'>;
type SkipIssue = Pick<Issue, 'state' | 'description' | 'labels'>;

/** A stage that needs no session for an issue: Symphony moves the issue on to `target` instead. */
export interface StageSkip {
  role: string;
  /** Why the stage is not needed, for the comment and the timeline. */
  reason: string;
  /** Name of the workflow profile that applies to the issue; null when none does. */
  profile: string | null;
  /** The next active column whose stage is needed; it has no `checks.on_enter` script. */
  target: string;
}

/**
 * Why the stage of `role` is not needed for `issue`, or null when it is: the issue's workflow profile lists the role in
 * `skip`, or in `skip_when` with the issue's complexity (an issue without a usable `Complexity:` label never matches,
 * so the stage runs), or the role is the analysis stage and `pipeline.analysis` is `when_unlabeled` while the issue carries a
 * `Type:` and a `Complexity:` label.
 */
export function skipReason(issue: { labels: readonly string[] }, role: RoleConfig, config: Pick<ServiceConfig, 'pipeline'>): string | null {
  const { type, complexity } = classify(issue.labels);
  const profile = profileFor(config.pipeline, type);
  const byProfile = profileSkipReason(profile, role.name, complexity);
  if (byProfile !== null) return byProfile;
  if (role.result === 'analysis' && config.pipeline.analysis === 'when_unlabeled' && type !== null && complexity !== null) {
    return 'the issue already has Type and Complexity labels (pipeline.analysis: when_unlabeled)';
  }
  return null;
}

/**
 * Whether the stage `role` serves for `issue` is skipped, and where the issue goes then: the first active column after
 * the issue's own in board order whose stage is needed. Null when the stage runs: the role is not skipped, the board
 * order is unknown, no needed stage follows, or the target column has a `checks.on_enter` script (a move without a
 * workspace cannot run it, see {@link skipCheckProblems}).
 */
export function stageSkip(issue: SkipIssue, role: RoleConfig | null, config: SkipConfig, boardColumns: readonly string[] | null): StageSkip | null {
  if (role === null || boardColumns === null || boardColumns.length === 0) return null;
  const reason = skipReason(issue, role, config);
  if (reason === null) return null;
  const later = laterActiveColumns({ states: [issue.state] }, config.tracker.activeStates, boardColumns) ?? [];
  const target = later.find((column) => {
    const served = roleFor({ state: column, description: issue.description }, config.roles);
    return served === null || skipReason(issue, served, config) === null;
  });
  if (target === undefined || config.checks.onEnter.has(normalizeStateName(target))) return null;
  return { role: role.name, reason, profile: profileFor(config.pipeline, classify(issue.labels).type)?.name ?? null, target };
}

/**
 * Problems with skipping stages without a session: a skipped stage moves the issue on without a workspace, so the
 * column it moves to must not have a `checks.on_enter` script. Checked for the skip lists and the `skip_when`
 * conditions of every profile (a conditional skip counts as a skip: it may happen) and for the analysis stage under `pipeline.analysis: when_unlabeled`; empty when the board's columns are unknown (nothing is
 * skipped then).
 */
export function skipCheckProblems(config: SkipConfig, boardColumns: readonly string[] | null): string[] {
  if (boardColumns === null || boardColumns.length === 0 || config.roles === null) return [];
  const analysis = config.pipeline.analysis === 'when_unlabeled' ? config.roles.filter((role) => role.result === 'analysis').map((role) => role.name) : [];
  const problems: string[] = [];
  for (const profile of [null, ...config.pipeline.profiles.values()]) {
    const conditional = Object.keys(profile?.skipWhen ?? {});
    const skipped = new Set([...(profile?.skip ?? []), ...conditional, ...analysis]);
    for (const role of config.roles.filter((candidate) => skipped.has(candidate.name))) {
      const origin =
        profile?.skip.includes(role.name) === true
          ? `pipeline.profiles.${profile.name}.skip`
          : conditional.includes(role.name)
            ? `pipeline.profiles.${profile?.name}.skip_when.${role.name}`
            : 'pipeline.analysis';
      for (const state of role.states) {
        const later = laterActiveColumns({ states: [state] }, config.tracker.activeStates, boardColumns) ?? [];
        const target = later.find((column) => {
          const served = roleFor({ state: column, description: null }, config.roles);
          return served === null || !skipped.has(served.name);
        });
        if (target === undefined || !config.checks.onEnter.has(normalizeStateName(target))) continue;
        const column = boardColumns.find((candidate) => normalizeStateName(candidate) === state) ?? state;
        const problem = `${origin}: skipping ${role.name} moves issues from "${column}" to "${target}" without a workspace, but checks.on_enter has a script for "${target}"`;
        if (!problems.includes(problem)) problems.push(problem);
      }
    }
  }
  return problems;
}
