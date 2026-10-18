export const ISSUE_TYPES = ['bugfix', 'feature', 'refactor'] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];
export const COMPLEXITIES = ['S', 'M', 'L', 'XL'] as const;
export type IssueComplexity = (typeof COMPLEXITIES)[number];

export interface ClassifyResult {
  /** Issue type: one of the values, or null if no label or conflicting labels. */
  type: IssueType | null;
  /** The label that picked the type, or null when no type is assigned. */
  typeLabel: string | null;
  /** Issue complexity: one of the values, or null if no label or conflicting labels. */
  complexity: IssueComplexity | null;
  /** The label that picked the complexity, or null when no complexity is assigned. */
  complexityLabel: string | null;
  /** Why type/complexity labels were ignored (unknown value, conflicting labels), or null. */
  warning: string | null;
}

export interface ClassifyOptions {
  /** Map alias labels to their canonical types. Default: { 'bug': 'bugfix', 'enhancement': 'feature', 'feature': 'feature', 'refactoring': 'refactor' } */
  typeAliases?: Record<string, IssueType>;
}

const DEFAULT_TYPE_ALIASES: Record<string, IssueType> = {
  bug: 'bugfix',
  enhancement: 'feature',
  feature: 'feature',
  refactor: 'refactor',
  refactoring: 'refactor',
};

const CANONICAL_TYPES = new Set<IssueType>(ISSUE_TYPES);
const CANONICAL_COMPLEXITIES = new Set<IssueComplexity>(COMPLEXITIES);

function hasTypePrefix(label: string): boolean {
  return label.trim().toLowerCase().startsWith('type:');
}

function hasComplexityPrefix(label: string): boolean {
  return label.trim().toLowerCase().startsWith('complexity:');
}

function parseTypeValue(value: string): IssueType | null {
  const name = value.trim().toLowerCase();
  if (CANONICAL_TYPES.has(name as IssueType)) return name as IssueType;
  return null;
}

function parseComplexityValue(value: string): IssueComplexity | null {
  const name = value.trim().toUpperCase();
  if (CANONICAL_COMPLEXITIES.has(name as IssueComplexity)) return name as IssueComplexity;
  return null;
}

interface Choice<T> {
  value: T | null;
  label: string | null;
  warning: string | null;
}

/** Picks one value from the labels; prefixed labels ("Type: x") win over aliases, differing values cancel out. */
function classifyFromLabels<T extends string>(
  labels: readonly string[],
  prefix: string,
  noun: string,
  parse: (value: string) => T | null,
  aliases: Record<string, T> = {},
): Choice<T> {
  const direct: Array<{ label: string; value: T }> = [];
  const viaAlias: Array<{ label: string; value: T }> = [];
  const unknown: string[] = [];

  for (const label of labels) {
    const lowerLabel = label.trim().toLowerCase();
    if (lowerLabel.startsWith(prefix)) {
      const value = parse(lowerLabel.slice(prefix.length));
      if (value === null) unknown.push(label);
      else direct.push({ label, value });
    } else if (Object.hasOwn(aliases, lowerLabel)) {
      viaAlias.push({ label, value: aliases[lowerLabel] as T });
    }
  }

  const picked = direct.length > 0 ? direct : viaAlias;
  const values = new Set(picked.map((entry) => entry.value));
  const problems: string[] = [];
  if (unknown.length > 0) problems.push(`unknown ${noun} label ${quoted(unknown)}`);
  if (values.size > 1) problems.push(`conflicting ${noun} labels ${quoted(picked.map((entry) => entry.label))}`);
  const warning = problems.length > 0 ? problems.join('; ') : null;
  const chosen = values.size === 1 ? picked[0] : undefined;
  return chosen === undefined ? { value: null, label: null, warning } : { value: chosen.value, label: chosen.label, warning };
}

function quoted(items: string[]): string {
  return items.map((item) => `"${item}"`).join(', ');
}

/**
 * Classifies an issue by type and complexity from its labels. Handles canonical labels (Type:, Complexity:)
 * and aliases (bug→bugfix, enhancement→feature, refactoring→refactor).
 */
export function classify(labels: readonly string[], options?: ClassifyOptions): ClassifyResult {
  const typeAliases = options?.typeAliases ?? DEFAULT_TYPE_ALIASES;

  // Collect type candidates: canonical labels, then aliases, then return
  const type = classifyFromLabels<IssueType>(labels, 'type:', 'type', parseTypeValue, typeAliases);
  const complexity = classifyFromLabels<IssueComplexity>(labels, 'complexity:', 'complexity', parseComplexityValue);

  const warning =
    [type.warning, complexity.warning]
      .filter((w) => w !== null)
      .join('; ') || null;

  return {
    type: type.value,
    typeLabel: type.label,
    complexity: complexity.value,
    complexityLabel: complexity.label,
    warning,
  };
}

export function isTypeLabel(label: string): boolean {
  return hasTypePrefix(label);
}

export function isComplexityLabel(label: string): boolean {
  return hasComplexityPrefix(label);
}

export function isNeedsHumanLabel(label: string): boolean {
  return label.trim().toLowerCase() === 'needs-human';
}
