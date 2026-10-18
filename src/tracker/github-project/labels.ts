import { STANDARD_LABELS } from '../../repo-init/labels.ts';
import { isComplexityLabel, isNeedsHumanLabel, isTypeLabel } from '../../workflow/classify.ts';

/** How a label that does not exist yet is created. */
export interface LabelDefinition {
  name: string;
  color: string;
  description: string | null;
}

const DEFAULT_COLOR = 'ededed';

/**
 * Whether the adapter may create the label: only the families the pipeline itself puts on issues (`Type: …`,
 * `Complexity: …`, `needs-human`). Every other name is a typo or somebody else's label and stays unknown.
 */
export function isCreatableLabel(name: string): boolean {
  const hasValue = name.slice(name.indexOf(':') + 1).trim() !== '';
  return isNeedsHumanLabel(name) || ((isTypeLabel(name) || isComplexityLabel(name)) && hasValue);
}

/** Name, color and description for a new label; the standard labels of `repo-init` keep theirs. */
export function labelDefinition(name: string): LabelDefinition {
  const wanted = name.trim();
  const standard = STANDARD_LABELS.find((label) => label.name.toLowerCase() === wanted.toLowerCase());
  if (standard !== undefined) return { name: standard.name, color: standard.color, description: standard.description };
  return { name: wanted, color: DEFAULT_COLOR, description: null };
}
