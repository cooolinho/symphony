// The pipeline scenario: the shipped bugfix pipeline (issue analyst → developer → test engineer → reviewer) on three issues
// that change no code (a test loop, a review loop and a blocked analysis), with a workflow generated from WORKFLOW.md.
import fs from 'node:fs';
import path from 'node:path';
import { effectiveAgentLimits, NO_LIMIT_OVERRIDE, slotProblems } from '../../src/orchestrator/limits.ts';
import type { ServiceConfig } from '../../src/workflow/config.ts';
import { isPlainObject, parseWorkflow } from '../../src/workflow/loader.ts';
import { nextStageProblems, unknownBoardColumns } from '../../src/workflow/validate.ts';
import { STATUS } from './context.ts';
import { TIMELINE_FILE, independentOfWorkflowDir, renderWorkflow, section } from './derive.ts';
import { ROLE_STATUS } from './roles.ts';
import { MODEL, type ScenarioIssue } from './scenario.ts';

/** Columns of the pipeline on top of `STATUS`. */
export const PIPELINE_STATUS = { ...ROLE_STATUS, testing: 'Testing' } as const;

/** Board columns the scenario needs: the whole path of a bug issue, the way to `Blocked` and the terminal column. */
export const PIPELINE_COLUMNS: readonly string[] = [
  STATUS.start,
  PIPELINE_STATUS.progress,
  PIPELINE_STATUS.testing,
  PIPELINE_STATUS.review,
  STATUS.handoff,
  PIPELINE_STATUS.blocked,
  STATUS.done,
];

/** The roles of the shipped pipeline, as named in WORKFLOW.md. */
export const PIPELINE_ROLE = { analyst: 'issue-analyst', developer: 'developer', tester: 'test-engineer', reviewer: 'reviewer' } as const;

/** The role that reports each result kind. */
export const ROLE_OF_KIND = {
  analysis: PIPELINE_ROLE.analyst,
  implementation: PIPELINE_ROLE.developer,
  test: PIPELINE_ROLE.tester,
  review: PIPELINE_ROLE.reviewer,
} as const;

/** The workflow profile bug issues run through (`pipeline.profiles.bugfix` in WORKFLOW.md). */
export const BUGFIX_PROFILE = 'bugfix';

/** What the three issues may cost together, with sonnet (about 14 sessions); the verifier fails above it. */
export const COST_CEILING_USD = 6;

/** Safety net in the generated workflow: an issue that spent this much stops getting new stages. */
const ISSUE_COST_CAP_USD = 4;

/** Dispatch waits for the next poll; the shipped 30 s would stretch the run to more than half an hour. */
const POLL_INTERVAL_MS = 10_000;

/** Longest a run of the scenario may take by default (minutes). */
export const PIPELINE_TIMEOUT_MIN = 60;

/** Entry checks would run the repository's test suite; the test issues change no code. */
const CHECKS_TIMEOUT_MS = 60_000;

/** File names inside the run directory. */
export const PIPELINE_FILES = { workflow: 'WORKFLOW.md', timeline: TIMELINE_FILE } as const;

/** What the agents write into their results, so the run can be traced back to the scenario. */
export const PIPELINE_MARKER = {
  analyzed: (key: string) => `E2E run ${key} analyzed`,
  needsInfo: (key: string) => `E2E run ${key} needs info`,
  developed: (key: string) => `E2E run ${key} developed`,
  testFailed: (key: string) => `E2E run ${key} test failed`,
  testPassed: (key: string) => `E2E run ${key} test passed`,
  rejected: (key: string) => `E2E run ${key} rejected`,
  approved: (key: string) => `E2E run ${key} approved`,
};

export type PipelineKind = keyof typeof ROLE_OF_KIND;

/** A result the issue text asks for. */
export interface ExpectedResult {
  kind: PipelineKind;
  verdict: string;
  /** Text the agent puts into the summary. */
  marker: string;
  /** Round the result is recorded in: loop verdicts before it plus one for a test or review; null for the other kinds. */
  round: number | null;
}

export interface PipelineIssue extends ScenarioIssue {
  /** Board statuses after `Ready`, in order. */
  path: string[];
  /** Results in the order the board records them. */
  results: ExpectedResult[];
  /** Workflow profile the issue runs through after the analysis; null for an issue that never leaves it. */
  profile: string | null;
}

const analysis = (key: string): ExpectedResult => ({ kind: 'analysis', verdict: 'ready', marker: PIPELINE_MARKER.analyzed(key), round: null });
const implementation = (key: string): ExpectedResult => ({ kind: 'implementation', verdict: 'done', marker: PIPELINE_MARKER.developed(key), round: null });
const testPassed = (key: string, round: number): ExpectedResult => ({ kind: 'test', verdict: 'passed', marker: PIPELINE_MARKER.testPassed(key), round });
const approved = (key: string, round: number): ExpectedResult => ({ kind: 'review', verdict: 'approved', marker: PIPELINE_MARKER.approved(key), round });

const { progress, testing, review, blocked } = PIPELINE_STATUS;

export const PIPELINE_SCENARIO: PipelineIssue[] = [
  {
    key: 'P1',
    title: 'test loop',
    blockers: [],
    path: [progress, testing, progress, testing, review, STATUS.handoff],
    profile: BUGFIX_PROFILE,
    results: [
      analysis('P1'),
      implementation('P1'),
      { kind: 'test', verdict: 'failed', marker: PIPELINE_MARKER.testFailed('P1'), round: 1 },
      implementation('P1'),
      testPassed('P1', 2),
      approved('P1', 1),
    ],
  },
  {
    key: 'P2',
    title: 'review loop',
    blockers: [],
    path: [progress, testing, review, progress, testing, review, STATUS.handoff],
    profile: BUGFIX_PROFILE,
    results: [
      analysis('P2'),
      implementation('P2'),
      testPassed('P2', 1),
      { kind: 'review', verdict: 'changes_needed', marker: PIPELINE_MARKER.rejected('P2'), round: 1 },
      implementation('P2'),
      testPassed('P2', 1),
      approved('P2', 2),
    ],
  },
  {
    key: 'P3',
    title: 'blocked analysis',
    blockers: [],
    path: [blocked],
    profile: null,
    results: [{ kind: 'analysis', verdict: 'needs_info', marker: PIPELINE_MARKER.needsInfo('P3'), round: null }],
  },
];

export const pipelineIssue = (key: string): PipelineIssue | undefined => PIPELINE_SCENARIO.find((issue) => issue.key === key);

/** `kind:verdict` of a result, as the verifier compares and prints them. */
export const resultLabel = (result: { kind: string; verdict: string }): string => `${result.kind}:${result.verdict}`;

const find = (issue: PipelineIssue, kind: PipelineKind, verdict: string) => issue.results.find((result) => result.kind === kind && result.verdict === verdict);

const tools = `Only the tracker tools are allowed: \`mcp__tracker__get_issue\` and \`mcp__tracker__report_result\`. Every role hands off with \`report_result\`; Symphony posts the comment and moves the issue.`;

function analystSection(issue: PipelineIssue): string {
  const ready = find(issue, 'analysis', 'ready');
  const report =
    ready !== undefined
      ? `2. Call \`report_result\` with the verdict \`ready\`, the summary \`${ready.marker}\`, the type \`bugfix\`, the complexity \`S\` and one acceptance criterion: \`E2E: nothing to implement\`. End the turn.`
      : `2. Call \`report_result\` with the verdict \`needs_info\`, the summary \`${find(issue, 'analysis', 'needs_info')?.marker}\` and exactly one open question: \`E2E: which colour should the button have? This question is part of the test\`. End the turn. The issue moves to "${blocked}" and stays there; no other role runs.`;
  return `## Role \`${PIPELINE_ROLE.analyst}\` (status "${STATUS.start}")

1. Call \`mcp__tracker__get_issue\`.
${report}
`;
}

function developerSection(issue: PipelineIssue): string {
  return `## Role \`${PIPELINE_ROLE.developer}\` (status "${PIPELINE_STATUS.progress}")

1. Call \`mcp__tracker__get_issue\`.
2. Call \`report_result\` with the verdict \`done\`, the summary \`${implementation(issue.key).marker}\` and no changed files. End the turn.
3. If the issue comes back to you (failed test cases or open findings in your prompt), do the same again, unchanged. There is nothing to fix.
`;
}

function testerSection(issue: PipelineIssue): string {
  const failed = find(issue, 'test', 'failed');
  const passed = find(issue, 'test', 'passed');
  const passedCall = `Call \`report_result\` with the verdict \`passed\`, the summary \`${passed?.marker}\` and exactly one case: criterion \`E2E: nothing to test\`, test \`e2e/no-op\`, status \`passed\`. End the turn.`;
  const steps =
    failed !== undefined
      ? `2. Look at the round in your prompt. In round 1 call \`report_result\` with the verdict \`failed\`, the summary \`${failed.marker}\` and exactly one case: criterion \`E2E: this failed case is part of the test\`, test \`e2e/forced-failure\`, status \`failed\`. End the turn.
3. In any later round: ${passedCall}`
      : `2. ${passedCall}`;
  return `## Role \`${PIPELINE_ROLE.tester}\` (status "${PIPELINE_STATUS.testing}")

1. Call \`mcp__tracker__get_issue\`.
${steps}
`;
}

function reviewerSection(issue: PipelineIssue): string {
  const rejected = find(issue, 'review', 'changes_needed');
  const approvedCall = `Call \`report_result\` with the verdict \`approved\`, the summary \`${find(issue, 'review', 'approved')?.marker}\` and no findings. End the turn.`;
  const steps =
    rejected !== undefined
      ? `2. Look at the review round in your prompt. In round 1 call \`report_result\` with the verdict \`changes_needed\`, the summary \`${rejected.marker}\` and exactly one finding: severity \`major\`, file \`README.md\`, line 1, problem \`E2E: this finding is part of the test\`, fix \`none needed\`. End the turn.
3. In any later round: ${approvedCall}`
      : `2. ${approvedCall}`;
  return `## Role \`${PIPELINE_ROLE.reviewer}\` (status "${PIPELINE_STATUS.review}")

1. Call \`mcp__tracker__get_issue\` and read the comments.
${steps}
`;
}

/** Issue text: one section per role that works on the issue, each with the exact `report_result` input. */
export function pipelineIssueBody(issue: ScenarioIssue): string {
  const spec = pipelineIssue(issue.key);
  if (spec === undefined) throw new Error(`${issue.key} is not an issue of the pipeline scenario`);
  const kinds = new Set(spec.results.map((result) => result.kind));
  const sections = [
    analystSection(spec),
    ...(kinds.has('implementation') ? [developerSection(spec)] : []),
    ...(kinds.has('test') ? [testerSection(spec)] : []),
    ...(kinds.has('review') ? [reviewerSection(spec)] : []),
  ];
  return `E2E run of the Symphony bugfix pipeline (${issue.key}: ${issue.title}). **No code changes.**
${tools}

${sections.join('\n')}
Not allowed: changing files, creating a branch, committing, pushing, opening a pull request, posting other comments.
`;
}

const PROMPT = `You are the **{{ role }}** in an end-to-end test of Symphony's bugfix pipeline.
Issue {{ issue.identifier }}: {{ issue.title }} (board status: {{ issue.state }}).

{{ issue.description | default: "(no description)" }}

## Rules

- Follow only the section of the issue text for your role ({{ role }}), step by step.
- Use only the tracker tools. Do not read or change files, create branches, commit, push or open pull requests.
- Hand off with \`report_result\` exactly as the issue text asks; post no other comments.
- Round {{ round }}.{% if results.failed_cases.size > 0 %} Failed test cases: {{ results.failed_cases.size }}.{% endif %}{% if results.open_findings.size > 0 %} Open findings: {{ results.open_findings.size }}.{% endif %}
- Once \`report_result\` succeeded, end your turn.
`;

/**
 * The scenario's workflow, derived from the repository's WORKFLOW.md (`source`, located in `root`): the roles, the
 * `bugfix` profile, the round limits and the active columns stay as shipped, so a regression in them shows up. Replaced
 * are the models (every role runs with sonnet, the reviewer included), the entry checks (none), the paths, the
 * polling interval and the prompt; Laravel Boost is off and an issue gets a cost cap.
 */
export function pipelineWorkflow(source: string, root: string): string {
  const { config } = parseWorkflow(source);

  independentOfWorkflowDir(config, root);

  section(config, 'polling').interval_ms = POLL_INTERVAL_MS;
  section(config, 'agent').max_issue_cost_usd = ISSUE_COST_CAP_USD;
  section(config, 'claude').model = MODEL;

  // Every role runs with sonnet: the shipped reviewer asks for opus, and no complexity picks another model.
  const roles = section(config, 'roles');
  for (const [name, role] of Object.entries(roles)) {
    if (!isPlainObject(role)) continue;
    const claude = section(role, 'claude');
    delete claude.model_by_complexity;
    claude.model = MODEL;
    roles[name] = role;
  }

  config.checks = { timeout_ms: CHECKS_TIMEOUT_MS, on_enter: {} };

  return renderWorkflow(config, PROMPT, 'scripts/e2e/pipeline.ts', root);
}

/** Writes the workflow into the run directory; returns its path. */
export function writePipelineWorkflow(root: string, runDir: string): string {
  const workflowPath = path.join(runDir, PIPELINE_FILES.workflow);
  fs.writeFileSync(workflowPath, pipelineWorkflow(fs.readFileSync(path.join(root, 'WORKFLOW.md'), 'utf8'), root));
  return workflowPath;
}

/**
 * What Symphony would complain about in the generated workflow against the board's columns (`columns`, in board order):
 * warnings of the config, columns the board lacks, `next` targets without a stage and roles that never get a slot.
 * Without them the run would stall instead of failing.
 */
export function pipelineConfigProblems(config: ServiceConfig, columns: readonly string[]): string[] {
  return [
    ...config.warnings.map((warning) => `warning: ${warning}`),
    ...unknownBoardColumns(config, columns),
    ...nextStageProblems(config, columns),
    ...slotProblems(config, effectiveAgentLimits(config, NO_LIMIT_OVERRIDE)),
  ];
}
