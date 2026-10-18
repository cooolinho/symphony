import { Liquid, type Template } from 'liquidjs';
import { isEffortLabel, isModelLabel } from '../agent/model.ts';
import { isComplexityLabel, isNeedsHumanLabel, isTypeLabel, classify } from './classify.ts';
import { SymphonyError, errorMessage } from '../util/errors.ts';
import type { Issue } from '../tracker/types.ts';
import { resolveIssueCommand } from './command.ts';
import type { PipelineConfig } from './config.ts';
import { profileFor } from './profile.ts';

/** Strict Liquid: unknown variables and unknown filters fail rendering. */
const engine = new Liquid({
  strictVariables: true,
  strictFilters: true,
  ownPropertyOnly: true,
  cache: false,
});

/** `issue.labels | without_model_labels`: the labels minus "Model: …" labels, which only pick the agent's model. */
engine.registerFilter('without_model_labels', (labels: unknown) =>
  Array.isArray(labels) ? labels.filter((label) => typeof label !== 'string' || !isModelLabel(label)) : labels,
);

/** `issue.labels | without_agent_labels`: the labels minus "Model: …", "Effort: …", "Type: …", "Complexity: …", and "needs-human" labels. */
engine.registerFilter('without_agent_labels', (labels: unknown) =>
  Array.isArray(labels)
    ? labels.filter(
        (label) =>
          typeof label !== 'string' ||
          !(isModelLabel(label) || isEffortLabel(label) || isTypeLabel(label) || isComplexityLabel(label) || isNeedsHumanLabel(label)),
      )
    : labels,
);

/** The prompt variable `results` for roles without `result` and for issues without results; see `resultsTemplateValue`. */
export const EMPTY_RESULTS = { latest: [], open_findings: [], failed_cases: [], test: null, analysis: null, design: null };

/** Used when the WORKFLOW.md body is empty. */
export const DEFAULT_PROMPT = `You are working on an issue from the configured tracker.

{{ issue.identifier }}: {{ issue.title }}

{{ issue.description }}`;

/** Sent on later turns of the same live session instead of resending the full task prompt. */
export const DEFAULT_CONTINUATION_PROMPT = `The issue {{ issue.identifier }} ("{{ issue.title }}") is still in the active state "{{ issue.state }}" after your previous turn. This is turn {{ turn_number }} of at most {{ max_turns }} in this session.

Continue where you left off. If the work is finished, or you are blocked and need a human, update the issue on the tracker (status and a short comment) so it leaves the active states.`;

/** A parsed template, or the parse error that will fail each run attempt that uses it. */
export interface PromptTemplate {
  source: string;
  parsed: Template[] | null;
  parseError: string | null;
}

export function compilePrompt(source: string): PromptTemplate {
  try {
    return { source, parsed: engine.parse(source), parseError: null };
  } catch (error) {
    return { source, parsed: null, parseError: errorMessage(error) };
  }
}

export async function renderPrompt(template: PromptTemplate, scope: Record<string, unknown>): Promise<string> {
  if (template.parsed === null) {
    throw new SymphonyError('template_parse_error', `prompt template does not parse: ${template.parseError}`);
  }
  try {
    // `agents` (the session's subagents), `test_paths` and the stage-history variables are optional for callers that render without a session, e.g. tests.
    const defaults = { agents: [], results: EMPTY_RESULTS, round: 1, result_required: false, test_paths: [] };
    const results = typeof scope.results === 'object' && scope.results !== null ? { ...EMPTY_RESULTS, ...scope.results } : defaults.results;
    return (await engine.render(template.parsed, { ...defaults, ...scope, results })).trim();
  } catch (error) {
    throw new SymphonyError('template_render_error', `prompt template failed to render: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

/**
 * Template view of an issue: string keys, ISO timestamps, nested lists and maps preserved. `command` is the
 * `/<name>` of the description when `skills` (see `commandSkills`) has a skill of that name, else null. `profile` is the
 * name of the workflow profile that applies to the issue (see `profileFor`), null without `pipeline.profiles`.
 */
export function issueTemplateValue(
  issue: Issue,
  skills: ReadonlyMap<string, string> = new Map(),
  pipeline: Pick<PipelineConfig, 'profiles'> | null = null,
): Record<string, unknown> {
  const classification = classify(issue.labels);
  return {
    command: resolveIssueCommand(issue.description, skills),
    id: issue.id,
    native_ref: issue.native_ref,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    branch_name: issue.branch_name,
    url: issue.url,
    assignee_id: issue.assignee_id,
    labels: [...issue.labels],
    blocked_by: issue.blocked_by.map((blocker) => ({ ...blocker })),
    dispatchable: issue.dispatchable,
    created_at: issue.created_at?.toISOString() ?? null,
    updated_at: issue.updated_at?.toISOString() ?? null,
    type: classification.type,
    complexity: classification.complexity,
    profile: pipeline === null ? null : (profileFor(pipeline, classification.type)?.name ?? null),
  };
}
