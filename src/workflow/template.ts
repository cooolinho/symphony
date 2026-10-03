import { Liquid, type Template } from 'liquidjs';
import { SymphonyError, errorMessage } from '../util/errors.ts';
import type { Issue } from '../tracker/types.ts';

/** Strict Liquid: unknown variables and unknown filters fail rendering. */
const engine = new Liquid({
  strictVariables: true,
  strictFilters: true,
  ownPropertyOnly: true,
  cache: false,
});

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
    return (await engine.render(template.parsed, scope)).trim();
  } catch (error) {
    throw new SymphonyError('template_render_error', `prompt template failed to render: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

/** Template view of an issue: string keys, ISO timestamps, nested lists and maps preserved. */
export function issueTemplateValue(issue: Issue): Record<string, unknown> {
  return {
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
  };
}
