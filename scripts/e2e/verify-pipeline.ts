// Checks of the pipeline scenario: a pure function over the repository log lines, the recorded status timelines and the
// results read back from the issues.
import { parseHistoryLine, type HistoryEntry } from '../../src/history/history.ts';
import { STATUS } from './context.ts';
import { PIPELINE_ROLE, PIPELINE_STATUS, ROLE_OF_KIND, pipelineIssue, resultLabel, type PipelineIssue } from './pipeline.ts';
import { MODEL } from './scenario.ts';
import { numberOf, observedPath, same, type Check, type TimelineEntry } from './verify-roles.ts';

/** A stage result read back from an issue comment (`adapter.readResults`), reduced to what the checks need. */
export interface PipelineResult {
  number: number;
  kind: string;
  verdict: string;
  summary: string;
  /** From the result's meta: the role that reported it, its run, round, workflow profile and the column it handed over to. */
  role: string;
  run: string | null;
  round: number | null;
  profile: string | null;
  target: string | null;
  /** Questions of an analysis; 0 for the other kinds. */
  openQuestions: number;
}

export interface PipelineData {
  issues: Array<{ key: string; number: number }>;
  /** Lines of the repository log of the run. */
  historyLines: string[];
  timeline: TimelineEntry[];
  /** Stage results recorded on the issues (`report_result` comments), oldest first. */
  results: PipelineResult[];
  /** Labels of each issue by number, as the tracker lists them (lowercase). */
  labels: Record<number, string[]>;
  /** `pipeline.max_review_rounds`, `max_test_rounds` and `limit_label` of the run's workflow. */
  maxReviewRounds: number;
  maxTestRounds: number;
  limitLabel: string;
  /** What all sessions together may cost. */
  costCeilingUsd: number;
}

/** A session of the repository log, from `run_started` and `run_finished`. */
export interface PipelineRun {
  run: string;
  issue: number;
  role: string;
  start: number;
  end: number | null;
  outcome: string | null;
  /** Model Symphony asked for, and the model that answered. */
  requestedModel: string | null;
  usedModel: string | null;
  turns: number;
  costUsd: number;
}

/** Sessions of the log, sorted by start. */
export function pipelineRuns(historyLines: string[]): PipelineRun[] {
  const runs = new Map<string, PipelineRun>();
  for (const { event, ts, fields } of historyLines.map(parseHistoryLine).filter((entry): entry is HistoryEntry => entry !== null)) {
    if (event !== 'run_started' && event !== 'run_finished') continue;
    const id = fields.run ?? '';
    const run = runs.get(id) ?? {
      run: id,
      issue: numberOf(fields.issue),
      role: fields.role ?? 'default',
      start: Date.parse(fields.started_at ?? ts),
      end: null,
      outcome: null,
      requestedModel: null,
      usedModel: null,
      turns: 0,
      costUsd: 0,
    };
    if (event === 'run_started') {
      run.start = Date.parse(ts);
      run.role = fields.role ?? 'default';
      run.requestedModel = fields.model ?? null;
    } else {
      run.end = Date.parse(ts);
      run.role = fields.role ?? run.role;
      run.outcome = fields.outcome ?? null;
      run.usedModel = fields.model ?? null;
      run.turns = Number(fields.turns ?? 0);
      run.costUsd = Number(fields.cost_usd ?? 0);
    }
    runs.set(id, run);
  }
  return [...runs.values()].sort((a, b) => a.start - b.start);
}

export interface RoleCost {
  role: string;
  runs: number;
  turns: number;
  models: string[];
  costUsd: number;
}

const ROLE_ORDER: string[] = Object.values(PIPELINE_ROLE);

/** Sessions, turns and cost per role: the roles of the pipeline first, in stage order, then any other. */
export function costByRole(runs: PipelineRun[]): RoleCost[] {
  const byRole = new Map<string, RoleCost>();
  for (const run of runs) {
    const cost = byRole.get(run.role) ?? { role: run.role, runs: 0, turns: 0, models: [], costUsd: 0 };
    cost.runs += 1;
    cost.turns += run.turns;
    cost.costUsd += run.costUsd;
    if (run.usedModel !== null && !cost.models.includes(run.usedModel)) cost.models.push(run.usedModel);
    byRole.set(run.role, cost);
  }
  const rank = (role: string) => (ROLE_ORDER.includes(role) ? ROLE_ORDER.indexOf(role) : ROLE_ORDER.length);
  return [...byRole.values()].sort((a, b) => rank(a.role) - rank(b.role) || a.role.localeCompare(b.role));
}

const usd = (value: number) => value.toFixed(4);

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);

const listed = (values: readonly string[]) => (values.length === 0 ? '(nothing)' : values.join(', '));

/** `kind:verdict:round` of a result, with `-` for results without a round. */
const roundLabel = (result: { kind: string; verdict: string; round: number | null }) => `${resultLabel(result)}:${result.round ?? '-'}`;

const specOf = (key: string): PipelineIssue => {
  const spec = pipelineIssue(key);
  if (spec === undefined) throw new Error(`${key} is not an issue of the pipeline scenario`);
  return spec;
};

export function verifyPipeline(data: PipelineData): Check[] {
  const entries = data.historyLines.map(parseHistoryLine).filter((entry): entry is HistoryEntry => entry !== null);
  const runs = pipelineRuns(data.historyLines);
  const issues = data.issues.map((issue) => ({ ...issue, spec: specOf(issue.key) }));
  const resultsOf = (number: number) => data.results.filter((result) => result.number === number);
  const stageLinesOf = (number: number) =>
    entries.filter((entry) => entry.event === 'stage_result' && numberOf(entry.fields.issue) === number);
  const checks: Check[] = [];

  const wrongPath = issues.flatMap((issue) => {
    const observed = observedPath(data.timeline, issue.number);
    const ok = observed.length === issue.spec.path.length && observed.every((status, index) => same(status, issue.spec.path[index] as string));
    return ok ? [] : [`${issue.key}: ${observed.join(' → ') || '(nothing)'}, expected ${issue.spec.path.join(' → ')}`];
  });
  checks.push({
    ok: wrongPath.length === 0,
    name: 'Status path per issue',
    detail: wrongPath.join('; ') || issues.map((issue) => `${issue.key}: ${observedPath(data.timeline, issue.number).join(' → ')}`).join('; '),
  });

  const unseen = issues.filter((issue) => !data.timeline.some((entry) => entry.number === issue.number));
  const done = issues.filter((issue) => data.timeline.some((entry) => entry.number === issue.number && same(entry.status, STATUS.done)));
  checks.push({
    ok: done.length === 0 && unseen.length === 0,
    name: `No issue reached "${STATUS.done}"`,
    detail:
      done.length > 0
        ? `in "${STATUS.done}": ${done.map((issue) => issue.key).join(', ')}`
        : unseen.length > 0
          ? `never observed on the board: ${unseen.map((issue) => issue.key).join(', ')}`
          : 'none',
  });

  const wrongResults = issues.flatMap((issue) => {
    const observed = resultsOf(issue.number).map(resultLabel);
    const expected = issue.spec.results.map(resultLabel);
    return sameList(observed, expected) ? [] : [`${issue.key}: ${listed(observed)}, expected ${expected.join(', ')}`];
  });
  checks.push({
    ok: wrongResults.length === 0,
    name: 'Stage results per issue (report_result)',
    detail: wrongResults.join('; ') || issues.map((issue) => `${issue.key}: ${issue.spec.results.map(resultLabel).join(', ')}`).join('; '),
  });

  const missingMarkers = issues.flatMap((issue) =>
    issue.spec.results.flatMap((expected) =>
      resultsOf(issue.number).some((result) => resultLabel(result) === resultLabel(expected) && result.summary.includes(expected.marker))
        ? []
        : [`${issue.key}: no ${resultLabel(expected)} result with "${expected.marker}"`],
    ),
  );
  checks.push({
    ok: missingMarkers.length === 0,
    name: 'Markers in the result summaries',
    detail: missingMarkers.join('; ') || `${issues.reduce((sum, issue) => sum + issue.spec.results.length, 0)} markers found`,
  });

  const roundProblems = issues.flatMap((issue) => {
    const own = resultsOf(issue.number);
    const meta = own.map(roundLabel);
    const logged = stageLinesOf(issue.number).map((entry) => roundLabel({ kind: entry.fields.kind ?? '', verdict: entry.fields.verdict ?? '', round: entry.fields.round === undefined ? null : Number(entry.fields.round) }));
    const expected = issue.spec.results.map(roundLabel);
    const atLimit = own.filter(
      (result) =>
        (result.kind === 'test' && result.verdict === 'failed' && result.round !== null && result.round >= data.maxTestRounds) ||
        (result.kind === 'review' && result.verdict === 'changes_needed' && result.round !== null && result.round >= data.maxReviewRounds),
    );
    return [
      ...(sameList(meta, expected) ? [] : [`${issue.key}: result rounds ${listed(meta)}, expected ${expected.join(', ')}`]),
      ...(sameList(logged, meta) ? [] : [`${issue.key}: stage_result lines ${listed(logged)} differ from the results ${listed(meta)}`]),
      ...(atLimit.length === 0 ? [] : [`${issue.key}: round limit reached by ${atLimit.map(roundLabel).join(', ')}`]),
      ...((data.labels[issue.number] ?? []).includes(data.limitLabel.toLowerCase()) ? [`${issue.key}: labelled "${data.limitLabel}"`] : []),
    ];
  });
  checks.push({
    ok: roundProblems.length === 0,
    name: 'Rounds (results and stage_result lines agree, no round limit hit)',
    detail: roundProblems.join('; ') || issues.map((issue) => `${issue.key}: ${issue.spec.results.map(roundLabel).join(', ')}`).join('; '),
  });

  const profileProblems = issues.flatMap((issue) => {
    const { profile } = issue.spec;
    if (profile === null) return [];
    const staged = resultsOf(issue.number).filter((result) => result.kind !== 'analysis');
    const wrong = staged.filter((result) => result.profile !== profile);
    return [
      ...(staged.length === 0 ? [`${issue.key}: no result after the analysis`] : []),
      ...(wrong.length === 0 ? [] : [`${issue.key}: profile ${wrong.map((result) => `${resultLabel(result)} ${result.profile ?? 'none'}`).join(', ')}, expected ${profile}`]),
      ...((data.labels[issue.number] ?? []).includes(`type: ${profile}`) ? [] : [`${issue.key}: no "Type: ${profile}" label`]),
    ];
  });
  checks.push({
    ok: profileProblems.length === 0,
    name: 'Workflow profile of the bug issues',
    detail: profileProblems.join('; ') || issues.filter((issue) => issue.spec.profile !== null).map((issue) => `${issue.key}: ${issue.spec.profile}`).join('; '),
  });

  const blockedProblems = issues.flatMap((issue) => {
    if (!same(issue.spec.path.at(-1), PIPELINE_STATUS.blocked)) return [];
    const [analysis, ...later] = resultsOf(issue.number);
    const roles = runs.filter((run) => run.issue === issue.number).map((run) => run.role);
    const reached = observedPath(data.timeline, issue.number).filter((status) => !same(status, PIPELINE_STATUS.blocked));
    return [
      ...(analysis === undefined || analysis.kind !== 'analysis' || analysis.verdict !== 'needs_info' ? [`${issue.key}: no analysis:needs_info result`] : []),
      ...(analysis !== undefined && analysis.openQuestions < 1 ? [`${issue.key}: the analysis carries no open question`] : []),
      ...(analysis !== undefined && !same(analysis.target, PIPELINE_STATUS.blocked) ? [`${issue.key}: the analysis handed over to ${analysis.target ?? 'no column'}`] : []),
      ...(later.length === 0 ? [] : [`${issue.key}: ${later.length} result(s) after the analysis`]),
      ...(sameList(roles, [PIPELINE_ROLE.analyst]) ? [] : [`${issue.key}: sessions ${listed(roles)}, expected ${PIPELINE_ROLE.analyst} only`]),
      ...(reached.length === 0 ? [] : [`${issue.key}: also in ${reached.join(', ')}`]),
    ];
  });
  checks.push({
    ok: blockedProblems.length === 0 && issues.some((issue) => same(issue.spec.path.at(-1), PIPELINE_STATUS.blocked)),
    name: `Blocked analysis stops at "${PIPELINE_STATUS.blocked}"`,
    detail: blockedProblems.join('; ') || 'one analyst session, one open question, no later stage',
  });

  const wrongOrder = issues.flatMap((issue) => {
    const handedOff = runs.filter((run) => run.issue === issue.number && run.outcome === 'handed_off').map((run) => run.role);
    const expected = issue.spec.results.map((result) => ROLE_OF_KIND[result.kind]);
    return sameList(handedOff, expected) ? [] : [`${issue.key}: ${listed(handedOff)}, expected ${expected.join(', ')}`];
  });
  checks.push({
    ok: wrongOrder.length === 0,
    name: 'Sessions that handed off, in stage order',
    detail: wrongOrder.join('; ') || `${runs.filter((run) => run.outcome === 'handed_off').length} handed-off sessions`,
  });

  const unfinished = issues.flatMap((issue) => {
    const own = runs.filter((run) => run.issue === issue.number);
    const last = own.filter((run) => run.end !== null).at(-1);
    const broken = own.filter((run) => run.outcome === 'failed' || run.outcome === 'stalled');
    return [
      ...(last?.outcome === 'handed_off' ? [] : [`${issue.key}: last session ${last === undefined ? 'missing' : (last.outcome ?? 'running')}`]),
      ...(broken.length === 0 ? [] : [`${issue.key}: ${broken.map((run) => `${run.role} ${run.outcome}`).join(', ')}`]),
    ];
  });
  checks.push({
    ok: unfinished.length === 0,
    name: 'Last session handed off, none failed or stalled',
    detail: unfinished.join('; ') || `${runs.length} sessions`,
  });

  const roleCosts = costByRole(runs);
  const costProblems = [
    ...ROLE_ORDER.filter((role) => !roleCosts.some((cost) => cost.role === role)).map((role) => `${role} never ran`),
    ...roleCosts.filter((cost) => cost.costUsd <= 0).map((cost) => `${cost.role} cost ${usd(cost.costUsd)} USD`),
  ];
  checks.push({
    ok: costProblems.length === 0,
    name: 'Every role ran and cost something',
    detail: costProblems.join('; ') || roleCosts.map((cost) => `${cost.role} ${usd(cost.costUsd)} USD`).join(', '),
  });

  const wrongModel = runs.filter((run) => run.requestedModel !== MODEL || !(run.usedModel ?? '').includes(MODEL));
  checks.push({
    ok: wrongModel.length === 0 && runs.length > 0,
    name: `Every run used ${MODEL}`,
    detail:
      wrongModel.map((run) => `${run.role} #${run.issue}: ${run.requestedModel} → ${run.usedModel}`).join('; ') ||
      (runs.length === 0 ? 'no session' : [...new Set(runs.map((run) => run.usedModel))].join(', ')),
  });

  const total = runs.reduce((sum, run) => sum + run.costUsd, 0);
  checks.push({
    ok: total > 0 && total < data.costCeilingUsd,
    name: `Total cost below ${data.costCeilingUsd} USD`,
    detail: `${usd(total)} USD in ${runs.length} sessions`,
  });

  return checks;
}
