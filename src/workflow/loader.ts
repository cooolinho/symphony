import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { SymphonyError, errorMessage } from '../util/errors.ts';

/** Parsed WORKFLOW.md: YAML front matter (root object) plus the trimmed Markdown prompt body. */
export interface WorkflowDefinition {
  config: Record<string, unknown>;
  promptTemplate: string;
  /**
   * The files the prompt includes (`{% include "roles/developer.md" %}`), keyed by the path as written in the tag,
   * relative to the directory of WORKFLOW.md. Empty for `parseWorkflow`, which knows no directory.
   */
  partials: Record<string, string>;
}

/** `{% include "<path>" %}` and `{% render "<path>" %}` with a quoted path: the files a prompt pulls in. */
const PARTIAL_TAG = /\{%-?\s*(?:include|render)\s+(["'])([^"']+)\1/g;

/** Drops a byte order mark and turns CRLF and CR line ends into LF. */
function normalizeText(source: string): string {
  return source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Splits front matter from the prompt body. A file that does not start with a `---` line is
 * all prompt. Empty front matter (`---` directly followed by `---`) counts as an empty map.
 */
export function parseWorkflow(source: string): WorkflowDefinition {
  const text = normalizeText(source);
  const lines = text.split('\n');
  if (lines[0]?.trimEnd() !== '---') {
    return { config: {}, promptTemplate: text.trim(), partials: {} };
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

  return { config: parsed, promptTemplate: lines.slice(closing + 1).join('\n').trim(), partials: {} };
}

/**
 * Reads the files `template` includes, and the files those include, relative to `baseDir` (the directory of
 * WORKFLOW.md). Only quoted paths count; each must stay inside `baseDir` and start with neither `./` nor `../`, so a
 * path means the same file in every file that includes it.
 */
export async function loadPartials(template: string, baseDir: string): Promise<Record<string, string>> {
  const partials: Record<string, string> = {};
  const pending = partialNames(template).map((name) => ({ name, from: 'WORKFLOW.md' }));
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    const { name, from } = next;
    if (Object.hasOwn(partials, name)) continue;
    const file = path.resolve(baseDir, name);
    const relative = path.relative(baseDir, file);
    const first = name.split(/[\\/]/)[0];
    if (path.isAbsolute(name) || first === '.' || first === '..' || relative.startsWith(`..${path.sep}`) || relative === '..') {
      throw new SymphonyError(
        'invalid_prompt_partial',
        `prompt partial "${name}" (included by ${from}) must be a path relative to the directory of WORKFLOW.md, without ./ or ../`,
      );
    }
    let source: string;
    try {
      source = await readFile(file, 'utf8');
    } catch (error) {
      throw new SymphonyError('missing_prompt_partial', `cannot read prompt partial ${name} (included by ${from}): ${errorMessage(error)}`, {
        cause: error,
      });
    }
    const text = normalizeText(source);
    partials[name] = text;
    for (const included of partialNames(text)) pending.push({ name: included, from: name });
  }
  return partials;
}

function partialNames(template: string): string[] {
  return [...template.matchAll(PARTIAL_TAG)].map((match) => match[2] ?? '').filter((name) => name !== '');
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
  const definition = parseWorkflow(source);
  return { definition: { ...definition, partials: await loadPartials(definition.promptTemplate, path.dirname(filePath)) }, source };
}
