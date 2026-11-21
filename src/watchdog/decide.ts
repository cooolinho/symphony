import { z } from 'zod';
import type { IssueComment } from '../tracker/types.ts';
import { normalizeStateName, type WatchdogConfig } from '../workflow/config.ts';
import type { BlockCase } from './case.ts';
import type { WatchdogEntry } from './marker.ts';

export const DIAGNOSIS_CAUSES = [
  'infra_transient',
  'environment',
  'missing_result',
  'question_answered',
  'needs_access',
  'needs_human',
  'round_limit',
  'unknown',
] as const;
export type DiagnosisCause = (typeof DIAGNOSIS_CAUSES)[number];

/** The input shape of the `report_diagnosis` tool. */
export const diagnosisShape = {
  cause: z.enum(DIAGNOSIS_CAUSES).describe('Why the issue is blocked (see the prompt for each value)'),
  evidence: z.array(z.string().trim().min(1).max(2000)).min(1).max(30).describe('Facts that prove the cause: log lines, file:line, transcript excerpts, URLs'),
  cause_gone: z.boolean().describe('True when the cause no longer holds right now (the outage is over, the answer is in the comment)'),
  comment: z.string().trim().min(1).max(20_000).describe('The finished Markdown comment for the issue, addressed to the next agent'),
  target_column: z.string().trim().min(1).nullable().describe('Column the issue should go back to; null when it must stay blocked'),
  confidence: z.enum(['low', 'medium', 'high']).describe('How sure the diagnosis is'),
};
export const diagnosisSchema = z.object(diagnosisShape);
export type Diagnosis = z.output<typeof diagnosisSchema>;

export type Decision =
  | { action: 'resume'; target: string; attempt: number; reason: string }
  | { action: 'wait'; reason: string }
  | { action: 'escalate'; reason: string }
  | { action: 'skip'; reason: string };

export interface DecideInput {
  diagnosis: Diagnosis;
  block: BlockCase;
  /** The issue's watchdog comments, oldest first. */
  entries: readonly WatchdogEntry[];
  /** Comments not written by Symphony's account. */
  humanComments: readonly IssueComment[];
  config: Pick<WatchdogConfig, 'maxResumes' | 'cooldownMs'>;
  activeStates: readonly string[];
  /** The first active column (Ready in the default board): re-runs analysis, so only allowed for an analysis block. */
  firstColumn: string | null;
  /** Columns served by the role with `result: docs`. */
  docsColumns: readonly string[];
  /** Columns served by the role with `result: review` (auto-merge follows an approval). */
  reviewColumns: readonly string[];
  /** Whether the role that blocked reports `result: analysis`. */
  blockedByAnalysis: boolean;
  /** Files changed since the docs hand-off fall outside `pipeline.docs_paths`. */
  docsPathRuleBroken: boolean;
  /** The issue carries the `manual-merge` label. */
  manualMerge: boolean;
  now: Date;
}

/** Causes the watchdog resumes on its own once `cause_gone` holds; the rest go to a human. */
const RESUMABLE: ReadonlySet<DiagnosisCause> = new Set(['infra_transient', 'environment', 'missing_result', 'question_answered']);

const same = (a: string, b: string) => normalizeStateName(a) === normalizeStateName(b);

/** Resumes since the newest human comment: a human's word starts the count again. */
export function resumesSinceHuman(entries: readonly WatchdogEntry[], humanComments: readonly IssueComment[]): WatchdogEntry[] {
  const lastHuman = Math.max(Number.NEGATIVE_INFINITY, ...humanComments.map((comment) => comment.createdAt.getTime()));
  return entries.filter((entry) => entry.marker.action === 'resume' && entry.comment.createdAt.getTime() > lastHuman);
}

/** The fixed guard rails around the session's recommendation (docs/watchdog.md, "Entscheidung"). */
export function decide(input: DecideInput): Decision {
  const { diagnosis } = input;
  if (!RESUMABLE.has(diagnosis.cause)) return { action: 'escalate', reason: `cause ${diagnosis.cause} needs a human` };
  if (diagnosis.cause === 'infra_transient' && !diagnosis.cause_gone) return { action: 'wait', reason: 'the infrastructure problem still holds' };
  if (!diagnosis.cause_gone) return { action: 'escalate', reason: `cause ${diagnosis.cause} still holds` };
  if (diagnosis.cause === 'question_answered' && diagnosis.confidence !== 'high') {
    return { action: 'escalate', reason: `answer given with ${diagnosis.confidence} confidence only` };
  }
  if (diagnosis.confidence === 'low') return { action: 'escalate', reason: 'low confidence' };

  const resumes = resumesSinceHuman(input.entries, input.humanComments);
  if (resumes.length >= input.config.maxResumes) {
    return { action: 'escalate', reason: `${resumes.length} automatic resumes since the last human comment (watchdog.max_resumes ${input.config.maxResumes})` };
  }
  const last = resumes.at(-1);
  if (last !== undefined && input.now.getTime() - last.comment.createdAt.getTime() < input.config.cooldownMs) {
    return { action: 'wait', reason: 'cooldown since the last resume' };
  }

  const wanted = diagnosis.target_column ?? input.block.from;
  if (wanted === null) return { action: 'escalate', reason: 'neither the diagnosis nor the block names the column to go back to' };
  const target = input.activeStates.find((state) => same(state, wanted));
  if (target === undefined) return { action: 'escalate', reason: `"${wanted}" is not an active column` };
  if (input.firstColumn !== null && same(target, input.firstColumn) && !input.blockedByAnalysis) {
    return { action: 'escalate', reason: `"${target}" would run the analysis (and design) again; only an analysis block may go there` };
  }
  if (input.docsPathRuleBroken && input.docsColumns.some((column) => same(column, target))) {
    return { action: 'escalate', reason: `"${target}": changes since the docs hand-off lie outside pipeline.docs_paths, the docs role would block again` };
  }
  if (!input.manualMerge && diagnosis.confidence !== 'high' && input.reviewColumns.some((column) => same(column, target))) {
    return { action: 'escalate', reason: `"${target}" leads to auto-merge without manual-merge; needs high confidence` };
  }
  return { action: 'resume', target, attempt: resumes.length + 1, reason: `cause ${diagnosis.cause} is gone` };
}

/** Causes whose escalation is not final: the fix lands on the base branch (a repaired test env, an outage over), not on the issue. */
export const RECHECK_CAUSES: ReadonlySet<string> = new Set<DiagnosisCause>(['environment', 'infra_transient']);

/** The newest settled diagnosis of one block, from its comment marker or from `events.jsonl`. */
export interface PriorDiagnosis {
  decision: 'resume' | 'escalate' | 'skip' | null;
  cause: string | null;
  /** 0 for the first diagnosis of the block, 1.. for re-checks. */
  recheck: number;
  /** Head of the base branch when it ran; null when unknown (or written before re-checks existed). */
  baseSha: string | null;
  at: Date;
}

/** Head of the repository's base branch and what its checks say. */
export interface BaseState {
  branch: string;
  sha: string;
  /** The commit's combined status and check runs, else Symphony's entry checks on that commit; `unknown` without either. */
  checks: 'passed' | 'failed' | 'pending' | 'unknown';
}

export type RecheckPlan =
  | { action: 'diagnose'; recheck: number; reason: string }
  | { action: 'later'; reason: string }
  | { action: 'final'; reason: string };

export interface RecheckInput {
  prior: PriorDiagnosis | null;
  config: Pick<WatchdogConfig, 'maxRechecks' | 'cooldownMs'>;
  now: Date;
  /** Read only when a re-check is due: the cheap pre-check before an expensive diagnosis. */
  readBase: () => Promise<BaseState | null>;
}

export function openForRecheck(prior: Pick<PriorDiagnosis, 'decision' | 'cause'>): boolean {
  return prior.decision === 'escalate' && prior.cause !== null && RECHECK_CAUSES.has(prior.cause);
}

const short = (sha: string | null) => (sha === null ? 'unknown' : sha.slice(0, 7));

/**
 * Whether a block is diagnosed (again) now (docs/watchdog.md, "Re-check"). A block without a diagnosis gets its first.
 * An escalation for `environment` / `infra_transient` is diagnosed again, at most `max_rechecks` times, once
 * `cooldown_ms` passed and the base branch has a new head whose checks are not red or pending. Without a recorded head
 * (older diagnoses), only green checks count as a reason.
 */
export async function planRecheck(input: RecheckInput): Promise<RecheckPlan> {
  const { prior, config } = input;
  if (prior === null) return { action: 'diagnose', recheck: 0, reason: 'first diagnosis of the block' };
  if (!openForRecheck(prior)) return { action: 'final', reason: `decided: ${prior.decision ?? 'comment'} (cause ${prior.cause ?? 'unknown'})` };
  if (prior.recheck >= config.maxRechecks) {
    return { action: 'final', reason: `${prior.recheck} re-checks done (watchdog.max_rechecks ${config.maxRechecks})` };
  }
  if (input.now.getTime() - prior.at.getTime() < config.cooldownMs) return { action: 'later', reason: 'cooldown since the last diagnosis' };
  const base = await input.readBase();
  if (base === null) return { action: 'later', reason: 'head of the base branch unknown' };
  if (prior.baseSha !== null && base.sha === prior.baseSha) return { action: 'later', reason: `${base.branch} still at ${short(base.sha)}` };
  if (base.checks === 'failed') return { action: 'later', reason: `checks on ${base.branch} ${short(base.sha)} failed` };
  if (base.checks === 'pending') return { action: 'later', reason: `checks on ${base.branch} ${short(base.sha)} still running` };
  if (prior.baseSha === null && base.checks !== 'passed') {
    return { action: 'later', reason: `no base head recorded with the diagnosis; waiting for green checks on ${base.branch}` };
  }
  return {
    action: 'diagnose',
    recheck: prior.recheck + 1,
    reason: `${base.branch} moved from ${short(prior.baseSha)} to ${short(base.sha)} (checks ${base.checks})`,
  };
}
