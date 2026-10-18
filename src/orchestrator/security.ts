import { errorMessage } from '../util/errors.ts';
import { matchesAnyGlob } from '../workflow/glob.ts';

/** Matching files named in the reason; more are counted. */
const FILES_SHOWN = 5;

/** The label that sends an issue to the security review (compared trimmed and case-insensitive; `area:security` is another label). */
export const SECURITY_LABEL = 'security';

/** The branch diff as the check needs it. */
export interface SecurityFacts {
  /** The latest analysis of the issue flags a security risk (`risks.security`). */
  risk: boolean;
  labels: readonly string[];
  /** `pipeline.security_paths`; `[]` turns the path trigger off. */
  securityPaths: readonly string[];
  /** The repository-relative files the branch changes against the base branch; throws when that cannot be told. */
  changedFiles: () => Promise<string[]>;
}

/** Whether the security review is needed, and why (or why not), for the transition reason. */
export interface SecurityDecision {
  needed: boolean;
  reason: string;
}

/**
 * Whether an approved issue needs the security review: a `security` label, a security risk in the latest analysis, or a
 * changed file that matches `security_paths`, in that order (the cheap triggers first; git is asked only when they do not
 * decide). Fail safe: when the changed files cannot be determined (not a git checkout, unknown base branch, git error or
 * timeout), the review is needed and the reason says why.
 */
export async function securityNeeded(facts: SecurityFacts): Promise<SecurityDecision> {
  if (facts.labels.some((label) => label.trim().toLowerCase() === SECURITY_LABEL)) return { needed: true, reason: `the issue carries the "${SECURITY_LABEL}" label` };
  if (facts.risk) return { needed: true, reason: 'the analysis flags a security risk' };
  if (facts.securityPaths.length === 0) return { needed: false, reason: 'no trigger (no security label or analysis risk, pipeline.security_paths is empty)' };
  let files: string[];
  try {
    files = await facts.changedFiles();
  } catch (error) {
    return { needed: true, reason: `the changed files could not be determined (${errorMessage(error).replace(/\s+/g, ' ').trim()}), reviewing to be safe` };
  }
  const matching = files.filter((file) => matchesAnyGlob(file, facts.securityPaths));
  if (matching.length === 0) {
    return { needed: false, reason: `no trigger (none of ${files.length} changed file(s) matches pipeline.security_paths)` };
  }
  const shown = matching.slice(0, FILES_SHOWN).join(', ');
  return { needed: true, reason: `${matching.length} changed file(s) match pipeline.security_paths: ${shown}${matching.length > FILES_SHOWN ? ', …' : ''}` };
}

/** The base ref the branch diff is measured against: the tracker's base branch on `origin`, else the remote's default branch. */
export function securityBaseRef(baseBranch: unknown): string {
  return typeof baseBranch === 'string' && baseBranch.trim() !== '' ? `origin/${baseBranch.trim()}` : 'origin/HEAD';
}
