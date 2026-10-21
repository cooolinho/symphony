import type { IssueComplexity, IssueType } from './classify.ts';
import type { PipelineConfig } from './config.ts';

/** Profile that applies to issues without a type, and to types without a profile of their own. */
export const DEFAULT_PROFILE = 'default';

/** A workflow profile: a variant of the transition table for one kind of issue (bugfix, feature, …). */
export interface WorkflowProfile {
  /** Issue type (`bugfix`, `feature`, `refactor`) the profile is configured for, or `default`. */
  name: string;
  /** Roles whose stages `next` passes over. */
  skip: readonly string[];
  /**
   * Roles whose stages `next` and dispatch pass over only for some issues: role name → complexities (`S`, `M`, `L`,
   * `XL`) at which the stage is skipped. An issue without a usable `Complexity:` label never matches, so the stage runs.
   */
  skipWhen: Readonly<Record<string, readonly IssueComplexity[]>>;
  /** `on_result` overrides per role name: verdict → column or `next`. */
  onResult: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Override of `pipeline.max_review_rounds`; null keeps it. */
  maxReviewRounds: number | null;
  /** Override of `pipeline.max_test_rounds`; null keeps it. */
  maxTestRounds: number | null;
}

/**
 * The profile for an issue of `type`: the one configured for the type, else `default`, else null (the roles' own
 * transitions). An issue without a type (`null`) gets `default`.
 */
export function profileFor(pipeline: Pick<PipelineConfig, 'profiles'>, type: IssueType | null): WorkflowProfile | null {
  return (type !== null ? pipeline.profiles.get(type) : undefined) ?? pipeline.profiles.get(DEFAULT_PROFILE) ?? null;
}

/**
 * Whether `profile` leaves the stage of role `name` out for an issue of `complexity`: the role is in `skip`, or in
 * `skip_when` with that complexity. The one place that evaluates the condition; transitions, dispatch skips, the
 * preflight and the pipeline view all ask here.
 */
export function profileSkips(profile: Pick<WorkflowProfile, 'skip' | 'skipWhen'> | null, name: string, complexity: IssueComplexity | null): boolean {
  if (profile === null) return false;
  if (profile.skip.includes(name)) return true;
  return complexity !== null && Object.hasOwn(profile.skipWhen, name) && (profile.skipWhen[name] ?? []).includes(complexity);
}

/** Why {@link profileSkips} holds, for logs and comments; null when it does not. */
export function profileSkipReason(profile: Pick<WorkflowProfile, 'name' | 'skip' | 'skipWhen'> | null, name: string, complexity: IssueComplexity | null): string | null {
  if (!profileSkips(profile, name, complexity)) return null;
  return profile?.skip.includes(name) === true ? `skipped by profile ${profile.name}` : `skipped by profile ${profile?.name} (skip_when: complexity ${complexity})`;
}

