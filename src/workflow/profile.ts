import type { IssueType } from './classify.ts';
import type { PipelineConfig } from './config.ts';

/** Profile that applies to issues without a type, and to types without a profile of their own. */
export const DEFAULT_PROFILE = 'default';

/** A workflow profile: a variant of the transition table for one kind of issue (bugfix, feature, …). */
export interface WorkflowProfile {
  /** Issue type (`bugfix`, `feature`, `refactor`) the profile is configured for, or `default`. */
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

/**
 * The profile for an issue of `type`: the one configured for the type, else `default`, else null (the roles' own
 * transitions). An issue without a type (`null`) gets `default`.
 */
export function profileFor(pipeline: Pick<PipelineConfig, 'profiles'>, type: IssueType | null): WorkflowProfile | null {
  return (type !== null ? pipeline.profiles.get(type) : undefined) ?? pipeline.profiles.get(DEFAULT_PROFILE) ?? null;
}
