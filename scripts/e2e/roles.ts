// The roles scenario: developer → entry check → reviewer → handoff with report_result, with issues that change no code
// and a generated workflow.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { isPlainObject, parseWorkflow } from '../../src/workflow/loader.ts';
import { STATUS } from './context.ts';
import type { ScenarioIssue } from './scenario.ts';

/** Columns of the roles lifecycle on top of `STATUS`. */
export const ROLE_STATUS = { progress: 'In progress', review: 'Agent review', blocked: 'Blocked' } as const;

/** Per-column limit for `Agent review` in the generated workflow. */
export const AGENT_REVIEW_LIMIT = 1;

/** Role switches count as continuations; room for the rejection round plus a few continuations. */
const MAX_CONTINUATIONS = 6;

/** File names inside the run directory. */
export const ROLES_FILES = { workflow: 'WORKFLOW.md', check: 'roles-check.sh', markers: 'check-markers', timeline: 'timeline.jsonl' } as const;

export interface RolesIssue extends ScenarioIssue {
  /** The reviewer reports `changes_needed` in the first review round, so the issue goes back to the developer once. */
  rejectOnce: boolean;
}

export const ROLES_SCENARIO: RolesIssue[] = [
  { key: 'R1', title: 'approval', blockers: [], rejectOnce: false },
  { key: 'R2', title: 'changes needed once', blockers: [], rejectOnce: true },
  { key: 'R3', title: 'approval', blockers: [], rejectOnce: false },
];

export const rolesIssue = (key: string): RolesIssue | undefined => ROLES_SCENARIO.find((issue) => issue.key === key);

/** What the agents write into their results, so the run can be traced back to the scenario. */
export const ROLES_MARKER = {
  developed: (key: string) => `E2E run ${key} developed`,
  rejected: (key: string) => `E2E run ${key} rejected`,
  approved: (key: string) => `E2E run ${key} approved`,
};

/** Result kinds and verdicts the issue texts ask for, in the order the board records them. */
export function expectedResults(rejectOnce: boolean): string[] {
  const develop = 'implementation:done';
  return rejectOnce ? [develop, 'review:changes_needed', develop, 'review:approved'] : [develop, 'review:approved'];
}

export function rolesIssueBody(issue: ScenarioIssue): string {
  const spec = rolesIssue(issue.key);
  const review = spec?.rejectOnce
    ? `2. Look at the review round in your prompt. In round 1 call \`report_result\` with the verdict \`changes_needed\`, the summary \`${ROLES_MARKER.rejected(issue.key)}\` and exactly one finding: severity \`major\`, file \`README.md\`, line 1, problem \`E2E: this finding is part of the test\`, fix \`none needed\`. End the turn.
3. In any later round call \`report_result\` with the verdict \`approved\`, the summary \`${ROLES_MARKER.approved(issue.key)}\` and no findings. End the turn.`
    : `2. Call \`report_result\` with the verdict \`approved\`, the summary \`${ROLES_MARKER.approved(issue.key)}\` and no findings. End the turn.`;
  return `E2E run of the Symphony role lifecycle (${issue.key}). **No code changes.**
Only the tracker tools are allowed: \`mcp__tracker__get_issue\` and \`mcp__tracker__report_result\`. Both roles hand off with \`report_result\`; Symphony posts the comment and moves the issue.

## Role \`developer\` (status "${STATUS.start}" or "${ROLE_STATUS.progress}")

1. Call \`mcp__tracker__get_issue\`.
2. Call \`report_result\` with the verdict \`done\` and the summary \`${ROLES_MARKER.developed(issue.key)}\`. The first time, the entry check of "${ROLE_STATUS.review}" fails on purpose (\`check_failed\`, nothing is recorded): then repeat the same call unchanged exactly once. Then end the turn.

## Role \`reviewer\` (status "${ROLE_STATUS.review}")

1. Call \`mcp__tracker__get_issue\` and read the comments.
${review}

Not allowed: changing files, creating a branch, committing, pushing, opening a pull request, posting other comments.
`;
}

/** Entry check for `Agent review`: fails the first time per issue (marker file in the run directory), then passes. */
export const CHECK_SCRIPT = `#!/usr/bin/env bash
# e2e roles scenario: the first entry check of each issue fails, every later one passes.
set -u
dir="$SYMPHONY_WORKFLOW_DIR/${ROLES_FILES.markers}"
marker="$dir/$(printf '%s' "$SYMPHONY_ISSUE_IDENTIFIER" | tr -c 'A-Za-z0-9' '_')"
if [ -e "$marker" ]; then
  echo "e2e entry check passed"
  exit 0
fi
mkdir -p "$dir" && date -u +%Y-%m-%dT%H:%M:%SZ > "$marker" || { echo "environment: cannot write $marker"; exit 2; }
echo "e2e: this entry check fails once per issue on purpose. Change nothing; call set_status with the same target again."
exit 1
`;

const PROMPT = `You are the **{{ role }}** in an end-to-end test of Symphony's roles lifecycle.
Issue {{ issue.identifier }}: {{ issue.title }} (board status: {{ issue.state }}).

{{ issue.description | default: "(no description)" }}

## Rules

- Follow only the section of the issue text for your role ({{ role }}), step by step.
- Use only the tracker tools. Do not read or change files, create branches, commit, push or open pull requests.
- Hand off with \`report_result\` exactly as the issue text asks; post no other comments.
- Review round {{ round }}.{% if results.open_findings.size > 0 %} Open findings: {{ results.open_findings.size }}.{% endif %}
- Once \`report_result\` succeeded, end your turn.
`;

/** Makes a path from the source workflow independent of the workflow's directory. */
function absolute(value: unknown, root: string): unknown {
  if (typeof value !== 'string' || value === '' || value.startsWith('$') || value.startsWith('~') || path.isAbsolute(value)) return value;
  return path.resolve(root, value);
}

/**
 * The scenario's workflow, derived from the repository's WORKFLOW.md (`source`, located in `root`): same tracker,
 * workspace, hooks and agent settings, but with the roles, `checks`, `Agent review` limit and prompt of this scenario.
 * The file lives in the run directory, so relative paths are resolved against `root`.
 */
export function rolesWorkflow(source: string, root: string): string {
  const { config } = parseWorkflow(source);
  const section = (key: string): Record<string, unknown> => {
    const value = config[key];
    const copy = isPlainObject(value) ? { ...value } : {};
    config[key] = copy;
    return copy;
  };

  const tracker = section('tracker');
  tracker.active_states = [STATUS.start, ROLE_STATUS.progress, ROLE_STATUS.review];
  tracker.terminal_states = [STATUS.done];

  const workspace = section('workspace');
  workspace.root = absolute(workspace.root, root);

  // Hooks may call scripts next to WORKFLOW.md.
  const hooks = section('hooks');
  for (const [key, value] of Object.entries(hooks)) {
    if (typeof value === 'string') hooks[key] = value.replace(/\$\{?SYMPHONY_WORKFLOW_DIR\}?/g, root);
  }

  config.checks = {
    timeout_ms: 60_000,
    on_enter: { [ROLE_STATUS.review]: `bash "$SYMPHONY_WORKFLOW_DIR/${ROLES_FILES.check}"` },
  };

  const agent = section('agent');
  agent.max_concurrent_agents_by_state = { [ROLE_STATUS.review]: AGENT_REVIEW_LIMIT };
  agent.max_continuations = MAX_CONTINUATIONS;

  const claude = section('claude');
  if (Array.isArray(claude.plugins)) claude.plugins = claude.plugins.map((plugin) => absolute(plugin, root));
  if (typeof claude.executable === 'string' && claude.executable.includes('/')) claude.executable = absolute(claude.executable, root);

  if (isPlainObject(config.laravel)) config.laravel = { ...config.laravel, boost: 'off' };

  config.roles = {
    developer: {
      states: [STATUS.start, ROLE_STATUS.progress],
      result: 'implementation',
      on_result: { done: ROLE_STATUS.review, blocked: ROLE_STATUS.blocked },
      may_move_to: [ROLE_STATUS.progress, ROLE_STATUS.review, ROLE_STATUS.blocked],
    },
    reviewer: {
      states: [ROLE_STATUS.review],
      read_only: true,
      max_turns: 6,
      result: 'review',
      on_result: { approved: STATUS.handoff, changes_needed: ROLE_STATUS.progress, blocked: ROLE_STATUS.blocked },
      on_check_failed: ROLE_STATUS.progress,
      may_move_to: [STATUS.handoff, ROLE_STATUS.progress, ROLE_STATUS.blocked],
    },
  };

  config.pipeline = { max_review_rounds: 3 };

  return `---\n# Generated by scripts/e2e/roles.ts from ${path.join(root, 'WORKFLOW.md')}; do not edit.\n${YAML.stringify(config)}---\n${PROMPT}`;
}

/** Writes the workflow and the check script into the run directory; returns the workflow path. */
export function writeRolesWorkflow(root: string, runDir: string): string {
  const workflowPath = path.join(runDir, ROLES_FILES.workflow);
  fs.writeFileSync(workflowPath, rolesWorkflow(fs.readFileSync(path.join(root, 'WORKFLOW.md'), 'utf8'), root));
  fs.writeFileSync(path.join(runDir, ROLES_FILES.check), CHECK_SCRIPT, { mode: 0o755 });
  return workflowPath;
}
