import { z } from 'zod';
import type { CheckRecord } from '../orchestrator/guard.ts';
import { SymphonyError } from '../util/errors.ts';

/**
 * Result contracts: every agent stage reports a typed, versioned result. Symphony renders it as an issue comment
 * (Markdown for humans, a hidden marker for later stages) and reads it back from the marker.
 */

export const RESULT_SCHEMA = 'symphony.result/v1';

/** Kinds an agent reports through a tool. */
export const AGENT_RESULT_KINDS = ['analysis', 'design', 'implementation', 'test', 'review', 'security', 'docs'] as const;
/** Kinds Symphony records itself, without agent input. */
export const INTERNAL_RESULT_KINDS = ['skipped', 'reset'] as const;
export const RESULT_KINDS = [...AGENT_RESULT_KINDS, ...INTERNAL_RESULT_KINDS] as const;

export type AgentResultKind = (typeof AGENT_RESULT_KINDS)[number];
export type InternalResultKind = (typeof INTERNAL_RESULT_KINDS)[number];
export type ResultKind = (typeof RESULT_KINDS)[number];

export const RESULT_VERDICTS = {
  analysis: ['ready', 'needs_info'],
  design: ['ready', 'blocked'],
  implementation: ['done', 'blocked'],
  test: ['passed', 'failed', 'blocked'],
  review: ['approved', 'changes_needed', 'blocked'],
  security: ['passed', 'issues_found', 'blocked'],
  docs: ['done', 'not_needed', 'blocked'],
  skipped: ['skipped'],
  reset: ['reset'],
} as const satisfies Record<ResultKind, readonly [string, ...string[]]>;

/** Result kinds with a round limit and the verdict that starts another round (`pipeline.max_review_rounds` / `max_test_rounds`). */
export const LOOP_VERDICTS = { review: 'changes_needed', test: 'failed' } as const satisfies Partial<Record<AgentResultKind, string>>;
export type LoopKind = keyof typeof LOOP_VERDICTS;

export function isLoopKind(kind: string | null): kind is LoopKind {
  return kind !== null && Object.hasOwn(LOOP_VERDICTS, kind);
}

export const SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;
export const BLOCKER_NEEDS = ['human', 'info', 'access', 'infra'] as const;
export const CASE_STATUSES = ['passed', 'failed', 'skipped'] as const;
export const COMPLEXITIES = ['S', 'M', 'L', 'XL'] as const;

/**
 * Upper bound (exclusive) for a result comment, Markdown and marker together, and so for the marker alone. GitHub
 * rejects comments above 65,536 characters; the margin leaves room for text a tool adds around the result.
 */
export const RESULT_SIZE_LIMIT = 60_000;

export const SUMMARY_MAX = 4000;
const TEXT_MAX = 4000;
const NAME_MAX = 500;
const LIST_MAX = 200;

const text = (max = TEXT_MAX) => z.string().trim().min(1).max(max);
const list = <T extends z.ZodType>(item: T) => z.array(item).max(LIST_MAX).default([]);

const blockerSchema = z.object({
  description: text().describe('What blocks the stage'),
  needs: z.enum(BLOCKER_NEEDS).describe('What it takes to unblock: human (a decision), info, access or infra'),
});

const findingSchema = z.object({
  severity: z.enum(SEVERITIES).describe('blocker and major must be fixed before approval; minor and nit are optional'),
  file: text(NAME_MAX).optional().describe('Repository-relative path'),
  line: z.number().int().positive().optional().describe('1-indexed line'),
  problem: text().describe('What is wrong'),
  fix: text().optional().describe('How to fix it'),
});

const caseSchema = z.object({
  criterion: text().describe('Acceptance criterion the case covers'),
  test: text(NAME_MAX).describe('Test name or file'),
  status: z.enum(CASE_STATUSES),
});

/** Fields every result shares besides `schema` and `kind`; the agent fills them. */
const commonShape = {
  summary: text(SUMMARY_MAX).describe(`What the stage found or did, 1–${SUMMARY_MAX} characters (Markdown)`),
  blockers: list(blockerSchema).describe('What blocks the stage; required with the verdict "blocked"'),
  follow_ups: list(text()).describe('Work worth a separate issue later'),
};

/** Kind-specific fields: everything optional so a stage only reports what it has. */
const kindShapes = {
  analysis: {
    type: text(NAME_MAX).optional().describe('Kind of change, e.g. feature, bug, refactor, docs, chore'),
    complexity: z.enum(COMPLEXITIES).optional(),
    components: list(text(NAME_MAX)).describe('Affected modules, directories or services'),
    acceptance_criteria: list(text()),
    risks: z
      .object({
        security: z.boolean().optional(),
        data_migration: z.boolean().optional(),
        breaking_change: z.boolean().optional(),
      })
      .optional(),
    docs_needed: z.boolean().optional(),
    open_questions: list(text()).describe('Questions a human must answer; required with the verdict "needs_info"'),
    plan: list(text()).describe('Implementation steps in order'),
  },
  design: {
    options: list(text()).describe('Options considered'),
    decision: text().optional().describe('The chosen option and why'),
    interfaces: list(text()).describe('New or changed interfaces, signatures, endpoints'),
    migrations: list(text()),
    compatibility: text().optional().describe('Backwards compatibility and rollout'),
    work_packages: list(text()).describe('Work packages in implementation order'),
  },
  implementation: {
    changed_files: list(text(NAME_MAX)),
    tests_added: list(text(NAME_MAX)),
    notes: text().optional(),
    plan_deviations: list(text()).describe('Where and why the implementation left the plan'),
  },
  test: {
    cases: list(caseSchema).describe('One entry per acceptance criterion checked; "failed" needs a failed case'),
    commands: list(text()).describe('Commands that ran'),
    uncovered_criteria: list(text()).describe('Acceptance criteria without a test'),
  },
  review: {
    findings: list(findingSchema).describe('"approved" allows only minor and nit findings'),
    checked: list(text()).describe('What the review covered'),
  },
  security: {
    findings: list(findingSchema).describe('"passed" allows only minor and nit findings'),
  },
  docs: {
    files: list(text(NAME_MAX)).describe('Documentation files written or changed'),
  },
  skipped: {},
  reset: {},
} satisfies Record<ResultKind, z.ZodRawShape>;

function verdictSchema<K extends ResultKind>(kind: K) {
  return z.enum(RESULT_VERDICTS[kind]).describe(`One of: ${RESULT_VERDICTS[kind].join(', ')}`);
}

/** Shape of the agent's input for `kind` (no `schema`, `kind` or Symphony-owned fields). */
function agentShape<K extends ResultKind>(kind: K) {
  return { verdict: verdictSchema(kind), ...commonShape, ...kindShapes[kind] };
}

/** Shape of a stored result: the agent's fields plus the envelope Symphony sets. */
function storedShape<K extends ResultKind>(kind: K) {
  return {
    schema: z.literal(RESULT_SCHEMA),
    kind: z.literal(kind),
    ...agentShape(kind),
    /** Findings Symphony dropped to stay below {@link RESULT_SIZE_LIMIT}. */
    omitted_findings: z.number().int().positive().optional(),
  };
}

const storedSchemas = {
  analysis: z.object(storedShape('analysis')),
  design: z.object(storedShape('design')),
  implementation: z.object(storedShape('implementation')),
  test: z.object(storedShape('test')),
  review: z.object(storedShape('review')),
  security: z.object(storedShape('security')),
  docs: z.object(storedShape('docs')),
  skipped: z.object(storedShape('skipped')),
  reset: z.object(storedShape('reset')),
};

const resultSchema = z.discriminatedUnion('kind', Object.values(storedSchemas) as [
  (typeof storedSchemas)[ResultKind],
  ...(typeof storedSchemas)[ResultKind][],
]);

export type StageResult = { [K in ResultKind]: z.output<(typeof storedSchemas)[K]> }[ResultKind];
export type ResultOf<K extends ResultKind> = Extract<StageResult, { kind: K }>;
export type Finding = z.output<typeof findingSchema>;
export type Blocker = z.output<typeof blockerSchema>;

/** Summary of the entry check that ran before the result was recorded. */
export interface ResultChecks {
  /** `passed`, or the denial category (`check_failed`, `check_timeout`, `check_error`). */
  result: string;
  ok: boolean;
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  sha: string | null;
  finished_at: string;
}

/** Facts Symphony records with a result; never taken from agent input. */
export interface ResultMeta {
  role: string;
  run: string | null;
  /** Round of the stage for this issue (1 = first); null when not counted. */
  round: number | null;
  profile: string | null;
  workflow_hash: string | null;
  head_sha: string | null;
  checks: ResultChecks | null;
  /** Column the stage hands the issue to; null when it does not move it. */
  target: string | null;
  /** ISO 8601 timestamp. */
  created_at: string;
}

const nullableText = z.string().nullable();

const metaSchema = z.object({
  role: z.string(),
  run: nullableText,
  round: z.number().int().nonnegative().nullable(),
  profile: nullableText,
  workflow_hash: nullableText,
  head_sha: nullableText,
  checks: z
    .object({
      result: z.string(),
      ok: z.boolean(),
      exit_code: z.number().int().nullable(),
      timed_out: z.boolean(),
      duration_ms: z.number().nonnegative(),
      sha: nullableText,
      finished_at: z.string(),
    })
    .nullable(),
  target: nullableText,
  created_at: z.string(),
}) satisfies z.ZodType<ResultMeta>;

/** The `checks` meta field for an entry-check record. */
export function checkSummary(check: CheckRecord): ResultChecks {
  return {
    result: check.result,
    ok: check.ok,
    exit_code: check.exitCode,
    timed_out: check.timedOut,
    duration_ms: check.durationMs,
    sha: check.sha,
    finished_at: check.finishedAt.toISOString(),
  };
}

export function isAgentResultKind(kind: string): kind is AgentResultKind {
  return (AGENT_RESULT_KINDS as readonly string[]).includes(kind);
}

/**
 * Zod raw shape for `AgentToolSpec.inputSchema` of a tool reporting a `kind` result. Defaults become plain optional
 * fields, so every JSON Schema conversion (input or output view) requires only `verdict` and `summary`; the tool
 * passes the input to {@link parseResult}, which applies the defaults.
 */
export function toolInputShape(kind: AgentResultKind): Record<string, z.ZodType> {
  return Object.fromEntries(
    Object.entries(agentShape(kind)).map(([name, field]) => {
      if (!(field instanceof z.ZodDefault)) return [name, field];
      const optional = (field.unwrap() as z.ZodType).optional();
      return [name, field.description === undefined ? optional : optional.describe(field.description)];
    }),
  );
}

/** A result Symphony records without agent input (`skipped`, `reset`). */
export function internalResult<K extends InternalResultKind>(kind: K, summary: string): ResultOf<K> {
  return storedSchemas[kind].parse({ schema: RESULT_SCHEMA, kind, verdict: kind, summary }) as ResultOf<K>;
}

const isSevere = (finding: Finding) => finding.severity === 'blocker' || finding.severity === 'major';

/** Contradictions between the verdict and the fields, phrased for the agent that has to fix them. */
export function consistencyProblems(result: StageResult): string[] {
  const problems: string[] = [];
  if (result.verdict === 'blocked' && result.blockers.length === 0) {
    problems.push('verdict "blocked" needs at least one entry in `blockers` saying what blocks the stage');
  }
  switch (result.kind) {
    case 'analysis':
      if (result.verdict === 'needs_info' && result.open_questions.length === 0) {
        problems.push('verdict "needs_info" needs at least one entry in `open_questions`');
      }
      break;
    case 'test': {
      const failed = result.cases.filter((c) => c.status === 'failed').length;
      if (result.verdict === 'failed' && failed === 0) {
        problems.push('verdict "failed" needs at least one case in `cases` with status "failed"');
      }
      if (result.verdict === 'passed' && failed > 0) {
        problems.push(`verdict "passed" contradicts ${failed} failed case(s): use "failed" or fix the tests first`);
      }
      break;
    }
    case 'review':
    case 'security': {
      const severe = result.findings.filter(isSevere).length;
      const clean = result.kind === 'review' ? 'approved' : 'passed';
      const dirty = result.kind === 'review' ? 'changes_needed' : 'issues_found';
      if (result.verdict === clean && severe > 0) {
        problems.push(
          `verdict "${clean}" allows no blocker or major findings, but there are ${severe}: use "${dirty}" or lower their severity`,
        );
      }
      if (result.verdict === dirty && result.findings.length === 0) {
        problems.push(`verdict "${dirty}" needs at least one entry in \`findings\``);
      }
      break;
    }
  }
  return problems;
}

export type ParseResultOutcome =
  | { ok: true; result: StageResult }
  | { ok: false; problems: string[]; message: string };

function issuePath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((out, key) => (typeof key === 'number' ? `${out}[${key}]` : out === '' ? String(key) : `${out}.${String(key)}`), '');
}

function issueText(issue: z.core.$ZodIssue): string {
  if (issue.code === 'unrecognized_keys') {
    const where = issue.path.length > 0 ? ` in \`${issuePath(issue.path)}\`` : '';
    return `unknown field(s)${where}: ${issue.keys.map((k) => `\`${k}\``).join(', ')}`;
  }
  const field = issue.path.length > 0 ? `\`${issuePath(issue.path)}\`` : 'input';
  if (issue.code === 'invalid_type' && issue.input === undefined) return `${field}: required`;
  return `${field}: ${issue.message}`;
}

/** Probe meta for the size check of {@link parseResult}: longer than what Symphony usually records. */
const PROBE_META: ResultMeta = {
  role: 'r'.repeat(40),
  run: 'r'.repeat(64),
  round: 999,
  profile: 'p'.repeat(40),
  workflow_hash: 'h'.repeat(64),
  head_sha: 's'.repeat(40),
  checks: {
    result: 'check_timeout',
    ok: false,
    exit_code: 255,
    timed_out: true,
    duration_ms: 3_600_000,
    sha: 's'.repeat(40),
    finished_at: '2000-01-01T00:00:00.000Z',
  },
  target: 't'.repeat(40),
  created_at: '2000-01-01T00:00:00.000Z',
};

/**
 * Validates an agent's `kind` result: the schema, then the consistency rules, then the size (findings may be trimmed
 * later, everything else must fit). Unknown fields are reported, not dropped, so a typo does not lose data.
 */
export function parseResult(kind: AgentResultKind, input: unknown): ParseResultOutcome {
  const parsed = z.strictObject(agentShape(kind)).safeParse(input);
  if (!parsed.success) return invalid(kind, parsed.error.issues.map(issueText));
  const result = { schema: RESULT_SCHEMA, kind, ...parsed.data } as StageResult;
  const problems = consistencyProblems(result);
  if (problems.length > 0) return invalid(kind, problems);
  try {
    renderResultComment(result, PROBE_META);
  } catch (error) {
    if (error instanceof SymphonyError && error.code === 'result_too_large') return invalid(kind, [error.message]);
    throw error;
  }
  return { ok: true, result };
}

function invalid(kind: ResultKind, problems: string[]): ParseResultOutcome {
  const message = `The ${kind} result is invalid; fix these and report it again:\n${problems.map((p) => `- ${p}`).join('\n')}`;
  return { ok: false, problems, message };
}

const MARKER_PATTERN = /<!-- symphony:result:v1 ([A-Za-z0-9_-]+) -->/g;

function markerOf(result: StageResult, meta: ResultMeta): string {
  const json = JSON.stringify({ ...result, meta });
  return `<!-- symphony:result:v1 ${Buffer.from(json, 'utf8').toString('base64url')} -->`;
}

/** Findings in the order they are kept when trimming: blockers first, the least severe dropped first. */
function findingsByPriority(findings: Finding[]): number[] {
  return findings
    .map((finding, index) => ({ rank: SEVERITIES.indexOf(finding.severity), index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.index);
}

function withFindings(result: StageResult, keep: number): StageResult {
  if (result.kind !== 'review' && result.kind !== 'security') return result;
  const kept = new Set(findingsByPriority(result.findings).slice(0, keep));
  const omitted = result.findings.length - kept.size + (result.omitted_findings ?? 0);
  const findings = result.findings.filter((_, index) => kept.has(index));
  const { omitted_findings: _previous, ...rest } = result;
  return omitted > 0 ? { ...rest, findings, omitted_findings: omitted } : { ...rest, findings };
}

/**
 * The result itself when `size(result) < RESULT_SIZE_LIMIT`, else with the fewest findings dropped (least severe
 * first, counted in `omitted_findings`). Throws `result_too_large` when even no findings do not fit.
 */
function fitResult(result: StageResult, size: (candidate: StageResult) => number): StageResult {
  if (size(result) < RESULT_SIZE_LIMIT) return result;
  const total = result.kind === 'review' || result.kind === 'security' ? result.findings.length : 0;
  let low = 0;
  let high = total - 1;
  let best: StageResult | null = null;
  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const candidate = withFindings(result, keep);
    if (size(candidate) < RESULT_SIZE_LIMIT) {
      best = candidate;
      low = keep + 1;
    } else {
      high = keep - 1;
    }
  }
  if (best !== null) return best;
  throw new SymphonyError(
    'result_too_large',
    `the ${result.kind} result is too large for an issue comment (${size(result)} characters rendered, limit ${RESULT_SIZE_LIMIT}): shorten the summary and the lists`,
  );
}

/**
 * Hidden marker carrying the result and its meta: `<!-- symphony:result:v1 <base64url(JSON)> -->`. Base64url has no
 * `>`, so no value can end the comment early. Findings are trimmed to stay below {@link RESULT_SIZE_LIMIT}.
 */
export function encodeMarker(result: StageResult, meta: ResultMeta): string {
  return markerOf(fitResult(result, (candidate) => markerOf(candidate, meta).length), meta);
}

/** The last result marker in `text` (a comment body), or null when there is none or it is damaged. Never throws. */
export function decodeMarker(text: string): { result: StageResult; meta: ResultMeta } | null {
  const matches = [...text.matchAll(MARKER_PATTERN)];
  const encoded = matches.at(-1)?.[1];
  if (encoded === undefined) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
    const { meta, ...rest } = payload as Record<string, unknown>;
    const parsedMeta = metaSchema.safeParse(meta);
    const parsedResult = resultSchema.safeParse(rest);
    if (!parsedMeta.success || !parsedResult.success) return null;
    return { result: parsedResult.data as StageResult, meta: parsedMeta.data };
  } catch {
    return null;
  }
}

/** The full comment: the Markdown section followed by the marker, trimmed to stay below {@link RESULT_SIZE_LIMIT}. */
export function renderResultComment(result: StageResult, meta: ResultMeta): string {
  const comment = (candidate: StageResult) => `${renderResultMarkdown(candidate, meta)}\n\n${markerOf(candidate, meta)}`;
  return comment(fitResult(result, (candidate) => comment(candidate).length));
}

const KIND_TITLES: Record<ResultKind, string> = {
  analysis: 'Analysis',
  design: 'Design',
  implementation: 'Implementation',
  test: 'Test',
  review: 'Review',
  security: 'Security review',
  docs: 'Documentation',
  skipped: 'Stage skipped',
  reset: 'Pipeline reset',
};

const VERDICT_ICONS: Record<string, string> = {
  ready: '✅',
  done: '✅',
  passed: '✅',
  approved: '✅',
  not_needed: '✅',
  needs_info: '❓',
  changes_needed: '⚠️',
  issues_found: '⚠️',
  failed: '❌',
  blocked: '⛔',
  skipped: '⏭️',
  reset: '🔄',
};

const SEVERITY_ICONS: Record<Finding['severity'], string> = { blocker: '🔴', major: '🟠', minor: '🟡', nit: '⚪' };
const CASE_ICONS: Record<(typeof CASE_STATUSES)[number], string> = { passed: '✅', failed: '❌', skipped: '⏭️' };

/** Agent text must not open an HTML comment: it would hide the rest of the comment or fake a marker. */
const block = (value: string) => value.replaceAll('<!--', '&lt;!--');
const inline = (value: string) => block(value.replace(/\s*\n\s*/g, ' '));
const code = (value: string) => `\`${inline(value).replaceAll('`', "'")}\``;

function bullets(title: string, items: readonly string[], ordered = false): string | null {
  if (items.length === 0) return null;
  return `**${title}**\n${items.map((item, index) => `${ordered ? `${index + 1}.` : '-'} ${item}`).join('\n')}`;
}

function findingLines(findings: readonly Finding[], omitted: number | undefined): string | null {
  const items = findings.map((finding) => {
    const location = finding.file === undefined ? '' : ` ${code(finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`)}`;
    const fix = finding.fix === undefined ? '' : `\n  Fix: ${inline(finding.fix)}`;
    return `${SEVERITY_ICONS[finding.severity]} **${finding.severity}**${location} — ${inline(finding.problem)}${fix}`;
  });
  const list = bullets(`Findings (${findings.length})`, items);
  const note = omitted === undefined ? null : `_${omitted} less severe finding(s) omitted to stay within the comment size limit._`;
  return [list, note].filter((part) => part !== null).join('\n\n') || null;
}

function kindSections(result: StageResult): (string | null)[] {
  switch (result.kind) {
    case 'analysis': {
      const facts = [
        result.type === undefined ? null : `Type: ${inline(result.type)}`,
        result.complexity === undefined ? null : `Complexity: ${result.complexity}`,
        result.docs_needed === undefined ? null : `Docs needed: ${result.docs_needed ? 'yes' : 'no'}`,
      ].filter((fact) => fact !== null);
      const risks = Object.entries(result.risks ?? {})
        .filter(([, flagged]) => flagged === true)
        .map(([risk]) => risk.replaceAll('_', ' '));
      return [
        facts.length === 0 ? null : facts.join(' · '),
        bullets('Components', result.components.map(code)),
        bullets('Acceptance criteria', result.acceptance_criteria.map((c) => `[ ] ${inline(c)}`)),
        risks.length === 0 ? null : `**Risks:** ${risks.join(', ')}`,
        bullets('Open questions', result.open_questions.map(inline)),
        bullets('Plan', result.plan.map(inline), true),
      ];
    }
    case 'design':
      return [
        result.decision === undefined ? null : `**Decision**\n${block(result.decision)}`,
        bullets('Options', result.options.map(inline)),
        bullets('Interfaces', result.interfaces.map(inline)),
        bullets('Migrations', result.migrations.map(inline)),
        result.compatibility === undefined ? null : `**Compatibility**\n${block(result.compatibility)}`,
        bullets('Work packages', result.work_packages.map(inline), true),
      ];
    case 'implementation':
      return [
        bullets('Changed files', result.changed_files.map(code)),
        bullets('Tests added', result.tests_added.map(code)),
        bullets('Plan deviations', result.plan_deviations.map(inline)),
        result.notes === undefined ? null : `**Notes**\n${block(result.notes)}`,
      ];
    case 'test':
      return [
        bullets(
          'Cases',
          result.cases.map((c) => `${CASE_ICONS[c.status]} ${inline(c.criterion)} — ${code(c.test)}`),
        ),
        bullets('Commands', result.commands.map(code)),
        bullets('Uncovered criteria', result.uncovered_criteria.map(inline)),
      ];
    case 'review':
      return [findingLines(result.findings, result.omitted_findings), bullets('Checked', result.checked.map(inline))];
    case 'security':
      return [findingLines(result.findings, result.omitted_findings)];
    case 'docs':
      return [bullets('Files', result.files.map(code))];
    case 'skipped':
    case 'reset':
      return [];
  }
}

function metaLine(meta: ResultMeta): string {
  const parts = [
    `role ${code(meta.role)}`,
    meta.round === null ? null : `round ${meta.round}`,
    meta.run === null ? null : `run ${code(meta.run)}`,
    meta.head_sha === null ? null : `head ${code(meta.head_sha.slice(0, 12))}`,
    meta.checks === null ? null : `checks ${inline(meta.checks.result)}`,
    meta.target === null ? null : `→ ${inline(meta.target)}`,
    meta.profile === null ? null : `profile ${code(meta.profile)}`,
    meta.workflow_hash === null ? null : `workflow ${code(meta.workflow_hash.slice(0, 12))}`,
    inline(meta.created_at),
  ].filter((part) => part !== null);
  return `<sub>Symphony · ${parts.join(' · ')}</sub>`;
}

/** Human-readable Markdown section for a result; the marker is separate ({@link encodeMarker}). */
export function renderResultMarkdown(result: StageResult, meta: ResultMeta): string {
  const heading = `### ${VERDICT_ICONS[result.verdict] ?? '•'} ${KIND_TITLES[result.kind]}: ${result.verdict.replaceAll('_', ' ')}`;
  const sections = [
    heading,
    block(result.summary),
    ...kindSections(result),
    bullets(
      'Blockers',
      result.blockers.map((b) => `**${b.needs}**: ${inline(b.description)}`),
    ),
    bullets('Follow-ups', result.follow_ups.map(inline)),
    metaLine(meta),
  ];
  return sections.filter((section) => section !== null).join('\n\n');
}
