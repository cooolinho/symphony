import type { Issue, TrackerAdapter } from '../tracker/types.ts';
import { errorMessage } from '../util/errors.ts';
import type { WatchdogMode } from '../workflow/config.ts';
import type { Decision, Diagnosis } from './decide.ts';
import { encodeWatchdogMarker, type WatchdogAction, type WatchdogMarker } from './marker.ts';

export interface ActInput {
  adapter: Pick<TrackerAdapter, 'postComment' | 'setStatus' | 'addLabels'>;
  issue: Issue;
  mode: WatchdogMode;
  diagnosis: Diagnosis;
  decision: Decision;
  maxResumes: number;
  limitLabel: string;
  blockedAt: Date | null;
  promptHash: string;
  now: Date;
}

export interface ActOutcome {
  /** What the comment's marker records; null when nothing was posted (observe, wait, skip). */
  action: WatchdogAction | null;
  moved: string | null;
  labelled: boolean;
  /** Problems with the GitHub writes; the comment counts as posted once it is. */
  errors: string[];
}

/** The action the marker records: a resume only when the watchdog really moves the issue (mode `act`). */
export function markerAction(mode: WatchdogMode, decision: Decision): WatchdogAction | null {
  if (mode === 'observe' || decision.action === 'wait' || decision.action === 'skip') return null;
  if (mode === 'comment') return 'comment';
  return decision.action === 'resume' ? 'resume' : 'escalate';
}

export function renderWatchdogComment(input: Omit<ActInput, 'adapter' | 'issue'>, action: WatchdogAction): string {
  const { decision, diagnosis } = input;
  const target = decision.action === 'resume' ? decision.target : null;
  const attempt = decision.action === 'resume' ? decision.attempt : 0;
  const outcome =
    action === 'resume'
      ? `→ back to "${target}" (automatic resume ${attempt}/${input.maxResumes})`
      : action === 'escalate'
        ? `stays blocked, \`${input.limitLabel}\`: ${decision.reason}`
        : `recommendation: ${decision.action === 'resume' ? `"${target}"` : `stay blocked (${decision.reason})`}; mode \`comment\`, nothing moved`;
  const marker: WatchdogMarker = {
    action,
    cause: diagnosis.cause,
    target,
    attempt,
    blocked_at: input.blockedAt?.toISOString() ?? null,
    prompt_hash: input.promptHash,
    created_at: input.now.toISOString(),
  };
  return [
    '### 🛟 Watchdog',
    '',
    diagnosis.comment.trim(),
    '',
    `<sub>Symphony watchdog · cause \`${diagnosis.cause}\` · confidence ${diagnosis.confidence} · ${outcome} · prompt ${input.promptHash}</sub>`,
    '',
    encodeWatchdogMarker(marker),
  ].join('\n');
}

/** Posts the comment first, then moves or labels the issue (the same order as `report_result`). */
export async function act(input: ActInput): Promise<ActOutcome> {
  const action = markerAction(input.mode, input.decision);
  const outcome: ActOutcome = { action, moved: null, labelled: false, errors: [] };
  if (action === null) return outcome;
  if (input.adapter.postComment === undefined) return { ...outcome, action: null, errors: ['the tracker cannot post comments'] };
  try {
    await input.adapter.postComment(input.issue, renderWatchdogComment(input, action));
  } catch (error) {
    return { ...outcome, action: null, errors: [`comment failed: ${errorMessage(error)}`] };
  }
  if (action === 'resume' && input.decision.action === 'resume') {
    try {
      if (input.adapter.setStatus === undefined) throw new Error('the tracker cannot move issues');
      outcome.moved = (await input.adapter.setStatus(input.issue, input.decision.target)).status;
    } catch (error) {
      outcome.errors.push(`move failed: ${errorMessage(error)}`);
    }
  }
  if (action === 'escalate' && !input.issue.labels.some((label) => label.toLowerCase() === input.limitLabel.toLowerCase())) {
    try {
      await input.adapter.addLabels?.(input.issue, [input.limitLabel], { create: true });
      outcome.labelled = true;
    } catch (error) {
      outcome.errors.push(`label failed: ${errorMessage(error)}`);
    }
  }
  return outcome;
}
