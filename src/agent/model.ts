import type { ClaudeConfig } from '../workflow/config.ts';
import type { RoleClaudeOverrides } from '../workflow/roles.ts';

/** Issue labels with this prefix pick the Claude model for that issue, e.g. "Model: sonnet". Case-insensitive. */
export const MODEL_LABEL_PREFIX = 'model:';

/** Claude Code aliases that always mean the newest model of their family. */
const MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku']);
/** A model family with a version ("opus-5-5", "haiku-4-5"), completed to the full model id. */
const VERSIONED_MODEL = /^(?:opus|sonnet|haiku|fable)(?:-\d+)+$/;

export interface ModelChoice {
  /** Model for the session: the one a label names, else the default; null = Claude Code default. */
  model: string | null;
  /** The label that picked the model (as on the issue), or null when the default applies. */
  label: string | null;
  /** Why model labels were ignored (unknown value, conflicting labels), or null. */
  warning: string | null;
}

export function isModelLabel(label: string): boolean {
  return label.trim().toLowerCase().startsWith(MODEL_LABEL_PREFIX);
}

/**
 * Maps a label value to a model name Claude Code accepts: "opus" and "claude-opus" become the alias "opus"
 * (newest Opus), "sonnet-5-5" and "claude-sonnet-5-5" the model id "claude-sonnet-5-5". Null for anything else.
 */
export function modelForLabelValue(value: string): string | null {
  const name = value.trim().toLowerCase().replace(/^claude-/, '');
  if (MODEL_ALIASES.has(name)) return name;
  if (VERSIONED_MODEL.test(name)) return `claude-${name}`;
  return null;
}

/**
 * Picks the session model from "Model: <model>" labels, else `defaultModel` (claude.model). Unknown values are
 * ignored and labels naming different models cancel each other out; both are reported in `warning`.
 */
export function chooseModel(labels: readonly string[], defaultModel: string | null): ModelChoice {
  const picked: Array<{ label: string; model: string }> = [];
  const unknown: string[] = [];
  for (const label of labels) {
    if (!isModelLabel(label)) continue;
    const model = modelForLabelValue(label.trim().slice(MODEL_LABEL_PREFIX.length));
    if (model === null) unknown.push(label);
    else picked.push({ label, model });
  }
  const models = new Set(picked.map((entry) => entry.model));
  const problems: string[] = [];
  if (unknown.length > 0) problems.push(`unknown model label ${quoted(unknown)}`);
  if (models.size > 1) problems.push(`conflicting model labels ${quoted(picked.map((entry) => entry.label))}`);
  const warning = problems.length > 0 ? problems.join('; ') : null;
  const chosen = models.size === 1 ? picked[0] : undefined;
  return chosen === undefined
    ? { model: defaultModel, label: null, warning }
    : { model: chosen.model, label: chosen.label, warning };
}

function quoted(labels: string[]): string {
  return labels.map((label) => `"${label}"`).join(', ');
}

/**
 * Claude settings for one session running `model`, with the role's overrides merged in: `effort` and
 * `maxBudgetUsd` replace, `allowedTools`/`disallowedTools` and `appendSystemPrompt` are appended. The role's
 * `model` is not applied here; it is part of `model` (see `chooseModel`). Fallback models equal to `model` are
 * dropped, because the Agent SDK refuses to start a session whose fallback model is its main model.
 */
export function sessionClaudeConfig(config: ClaudeConfig, model: string | null, overrides: RoleClaudeOverrides = {}): ClaudeConfig {
  const merged = withRoleOverrides(config, overrides);
  if (model === null || merged.fallbackModel === null) return { ...merged, model };
  const fallbacks = merged.fallbackModel.split(',').map((entry) => entry.trim());
  if (!fallbacks.includes(model)) return { ...merged, model };
  const rest = fallbacks.filter((entry) => entry !== '' && entry !== model);
  return { ...merged, model, fallbackModel: rest.length > 0 ? rest.join(',') : null };
}

function withRoleOverrides(config: ClaudeConfig, overrides: RoleClaudeOverrides): ClaudeConfig {
  const prompts = [config.appendSystemPrompt, overrides.appendSystemPrompt ?? null].filter((text): text is string => text !== null && text !== '');
  return {
    ...config,
    effort: overrides.effort ?? config.effort,
    maxBudgetUsd: overrides.maxBudgetUsd ?? config.maxBudgetUsd,
    allowedTools: [...config.allowedTools, ...(overrides.allowedTools ?? [])],
    disallowedTools: [...config.disallowedTools, ...(overrides.disallowedTools ?? [])],
    appendSystemPrompt: prompts.length > 0 ? prompts.join('\n\n') : null,
  };
}
