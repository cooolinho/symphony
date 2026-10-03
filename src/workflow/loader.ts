import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { SymphonyError, errorMessage } from '../util/errors.ts';

/** Parsed WORKFLOW.md: YAML front matter (root object) plus the trimmed Markdown prompt body. */
export interface WorkflowDefinition {
  config: Record<string, unknown>;
  promptTemplate: string;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Splits front matter from the prompt body. A file that does not start with a `---` line is
 * all prompt. Empty front matter (`---` directly followed by `---`) counts as an empty map.
 */
export function parseWorkflow(source: string): WorkflowDefinition {
  const text = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  if (lines[0]?.trimEnd() !== '---') {
    return { config: {}, promptTemplate: text.trim() };
  }

  const closing = lines.findIndex((line, index) => index > 0 && line.trimEnd() === '---');
  if (closing === -1) {
    throw new SymphonyError('workflow_parse_error', 'front matter opens with --- but has no closing --- line');
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(lines.slice(1, closing).join('\n'));
  } catch (error) {
    throw new SymphonyError('workflow_parse_error', `invalid YAML front matter: ${errorMessage(error)}`, { cause: error });
  }
  if (parsed === null || parsed === undefined) parsed = {};
  if (!isPlainObject(parsed)) {
    throw new SymphonyError('workflow_front_matter_not_a_map', 'YAML front matter must be a map of keys to values');
  }

  return { config: parsed, promptTemplate: lines.slice(closing + 1).join('\n').trim() };
}

export async function loadWorkflowFile(filePath: string): Promise<{ definition: WorkflowDefinition; source: string }> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new SymphonyError('missing_workflow_file', `cannot read workflow file ${filePath}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  return { definition: parseWorkflow(source), source };
}
