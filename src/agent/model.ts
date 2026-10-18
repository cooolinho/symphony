import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import { EFFORT_LEVELS, type ClaudeConfig, type ModelClaudeOverrides } from '../workflow/config.ts';
import type { ModelLabelPolicy, RoleClaudeOverrides } from '../workflow/roles.ts';
import type { IssueComplexity } from '../workflow/classify.ts';
import { bareModelName, modelForLabelValue } from './model-name.ts';

export { modelForLabelValue };

/** Issue labels with this prefix pick the Claude model for that issue, e.g. "Model: sonnet". Case-insensitive. */
export const MODEL_LABEL_PREFIX = 'model:';
/** Issue labels with this prefix pick the Claude effort for that issue, e.g. "Effort: high". Case-insensitive. */
export const EFFORT_LABEL_PREFIX = 'effort:';

/** What a label family (e.g. "Model: …") decided for one issue. */
export interface LabelChoice<T> {
  /** Value for the session: the one a label names, else the default. */
  value: T;
  /** The label that picked the value (as on the issue), or null when the default applies. */
  label: string | null;
  /** Why labels were ignored (unknown value, conflicting labels), or null. */
  warning: string | null;
}

export interface ModelChoice {
  /** Model for the session: the one a label names, else the default; null = Claude Code default. */
  model: string | null;
  /** The label that picked the model (as on the issue), or null when the default applies. */
  label: string | null;
  /** Why model labels were ignored (unknown value, conflicting labels), or null. */
  warning: string | null;
  /** Whether a model label was found but ignored by the role's policy. */
  labelIgnored: boolean;
  /** Where the model came from: 'label', 'complexity', 'role', 'global', or null (Claude Code default). */
  source: 'label' | 'complexity' | 'role' | 'global' | null;
}

export interface EffortChoice {
  /** Effort for the session: the one a label names, else the default; null = Claude Code default. */
  effort: EffortLevel | null;
  /** The label that picked the effort (as on the issue), or null when the default applies. */
  label: string | null;
  /** Why effort labels were ignored (unknown value, conflicting labels), or null. */
  warning: string | null;
}

export function isModelLabel(label: string): boolean {
  return hasPrefix(label, MODEL_LABEL_PREFIX);
}

export function isEffortLabel(label: string): boolean {
  return hasPrefix(label, EFFORT_LABEL_PREFIX);
}

function hasPrefix(label: string, prefix: string): boolean {
  return label.trim().toLowerCase().startsWith(prefix);
}

/** Maps a label value ("high", " Max ") to an effort level; null for anything that is not one. */
export function effortForLabelValue(value: string): EffortLevel | null {
  const name = value.trim().toLowerCase();
  return EFFORT_LEVELS.find((level) => level === name) ?? null;
}

/**
 * Picks the value of the labels starting with `prefix` (e.g. "model:"), else `fallback`. Unknown values are
 * ignored and labels naming different values cancel each other out; both are reported in `warning`.
 */
function chooseFromLabels<T>(
  labels: readonly string[],
  prefix: string,
  noun: string,
  parse: (value: string) => T | null,
  fallback: T,
): LabelChoice<T> {
  const picked: Array<{ label: string; value: T }> = [];
  const unknown: string[] = [];
  for (const label of labels) {
    if (!hasPrefix(label, prefix)) continue;
    const value = parse(label.trim().slice(prefix.length));
    if (value === null) unknown.push(label);
    else picked.push({ label, value });
  }
  const values = new Set(picked.map((entry) => entry.value));
  const problems: string[] = [];
  if (unknown.length > 0) problems.push(`unknown ${noun} label ${quoted(unknown)}`);
  if (values.size > 1) problems.push(`conflicting ${noun} labels ${quoted(picked.map((entry) => entry.label))}`);
  const warning = problems.length > 0 ? problems.join('; ') : null;
  const chosen = values.size === 1 ? picked[0] : undefined;
  return chosen === undefined ? { value: fallback, label: null, warning } : { value: chosen.value, label: chosen.label, warning };
}

/**
 * Picks the session model from "Model: <model>" labels, else `model_by_complexity`, else `defaultModel` (role's
 * claude.model or global claude.model). Unknown values are ignored and labels naming different models cancel each
 * other out; both are reported in `warning`. When `modelLabel` is 'ignore', model labels are not evaluated.
 * When complexity is provided but no complexity label is found, no model_by_complexity mapping is applied.
 */
export function chooseModel(
  labels: readonly string[],
  defaultModel: string | null,
  modelLabel: ModelLabelPolicy = 'apply',
  complexity: IssueComplexity | null = null,
  modelByComplexity: Partial<Record<IssueComplexity, string | null>> | null = null,
): ModelChoice {
  if (modelLabel === 'ignore') {
    const hasModelLabel = labels.some((label) => hasPrefix(label, MODEL_LABEL_PREFIX));
    // Check complexity-based model if label is ignored
    if (complexity !== null && modelByComplexity !== null && modelByComplexity[complexity] !== undefined) {
      const model = modelByComplexity[complexity];
      return { model, label: null, warning: null, labelIgnored: hasModelLabel, source: 'complexity' };
    }
    return { model: defaultModel, label: null, warning: null, labelIgnored: hasModelLabel, source: defaultModel === null ? null : 'role' };
  }

  const { value, label, warning } = chooseFromLabels<string | null>(labels, MODEL_LABEL_PREFIX, 'model', modelForLabelValue, defaultModel);
  if (label !== null) {
    // A model label was found and applied
    return { model: value, label, warning, labelIgnored: false, source: 'label' };
  }

  // No model label; check complexity-based model
  if (complexity !== null && modelByComplexity !== null && modelByComplexity[complexity] !== undefined) {
    const model = modelByComplexity[complexity];
    return { model, label: null, warning, labelIgnored: false, source: 'complexity' };
  }

  // Fall back to default model (role or global)
  return { model: value, label: null, warning, labelIgnored: false, source: value === null ? null : 'role' };
}

/**
 * Picks the session effort from "Effort: <level>" labels, else `defaultEffort` (the role's or claude.effort).
 * Unknown values are ignored and labels naming different levels cancel each other out; both are reported in `warning`.
 */
export function chooseEffort(labels: readonly string[], defaultEffort: EffortLevel | null): EffortChoice {
  const { value, label, warning } = chooseFromLabels<EffortLevel | null>(labels, EFFORT_LABEL_PREFIX, 'effort', effortForLabelValue, defaultEffort);
  return { effort: value, label, warning };
}

function quoted(labels: string[]): string {
  return labels.map((label) => `"${label}"`).join(', ');
}

/**
 * The `claude.by_model` entry for `model`: the one whose key is the model's bare name or a prefix of it up to a dash
 * ("haiku" covers "haiku", "claude-haiku-4-5" and "claude-haiku-4-5-20251001"), the longest key winning. Empty for
 * `null` (Claude Code's default model) and for models without an entry.
 */
export function modelOverridesFor(byModel: ReadonlyMap<string, ModelClaudeOverrides>, model: string | null): ModelClaudeOverrides {
  if (model === null) return {};
  const name = bareModelName(model);
  let best: string | null = null;
  for (const key of byModel.keys()) {
    if (name !== key && !name.startsWith(`${key}-`)) continue;
    if (best === null || key.length > best.length) best = key;
  }
  return best === null ? {} : (byModel.get(best) ?? {});
}

/**
 * Claude settings for one session running `model` at `effort`, with the role's and the model's overrides merged in:
 * `maxBudgetUsd` replaces, `allowedTools`/`disallowedTools` and `appendSystemPrompt` are appended. The model's
 * (`claude.by_model`) `permissionMode` and `onPermissionRequest` replace the global ones, its tool lists are appended
 * after the role's. The role's `model` and `effort` are not applied here; they are part of `model` and `effort` (see
 * `chooseModel` and `chooseEffort`). Fallback models equal to `model` are dropped, because the Agent SDK refuses to
 * start a session whose fallback model is its main model.
 */
export function sessionClaudeConfig(
  config: ClaudeConfig,
  model: string | null,
  effort: EffortLevel | null,
  overrides: RoleClaudeOverrides = {},
): ClaudeConfig {
  const merged = { ...withModelOverrides(withRoleOverrides(config, overrides), modelOverridesFor(config.byModel, model)), effort };
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
    maxBudgetUsd: overrides.maxBudgetUsd ?? config.maxBudgetUsd,
    allowedTools: [...config.allowedTools, ...(overrides.allowedTools ?? [])],
    disallowedTools: [...config.disallowedTools, ...(overrides.disallowedTools ?? [])],
    appendSystemPrompt: prompts.length > 0 ? prompts.join('\n\n') : null,
  };
}

function withModelOverrides(config: ClaudeConfig, overrides: ModelClaudeOverrides): ClaudeConfig {
  return {
    ...config,
    permissionMode: overrides.permissionMode ?? config.permissionMode,
    onPermissionRequest: overrides.onPermissionRequest ?? config.onPermissionRequest,
    allowedTools: [...config.allowedTools, ...(overrides.allowedTools ?? [])],
    disallowedTools: [...config.disallowedTools, ...(overrides.disallowedTools ?? [])],
  };
}
