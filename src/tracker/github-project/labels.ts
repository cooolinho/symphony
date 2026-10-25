import { STANDARD_LABELS } from '../../repo-init/labels.ts';
import { isComplexityLabel, isNeedsHumanLabel, isTypeLabel } from '../../workflow/classify.ts';

/** How a label that does not exist yet is created. */
export interface LabelDefinition {
  name: string;
  color: string;
  description: string | null;
}

const DEFAULT_COLOR = 'ededed';

/** Label of an issue whose approved pull request waits for pending checks before `auto_merge` merges it. */
export const AWAITING_CHECKS_LABEL = 'awaiting-checks';

/**
 * Whether the adapter may create the label: only the families the pipeline itself puts on issues (`Type: …`,
 * `Complexity: …`, `needs-human`, `awaiting-checks`). Every other name is a typo or somebody else's label and stays unknown.
 */
export function isCreatableLabel(name: string): boolean {
  const hasValue = name.slice(name.indexOf(':') + 1).trim() !== '';
  return (
    isNeedsHumanLabel(name) ||
    name.trim().toLowerCase() === AWAITING_CHECKS_LABEL ||
    ((isTypeLabel(name) || isComplexityLabel(name)) && hasValue)
  );
}

/** Name, color and description for a new label; the standard labels of `repo-init` keep theirs. */
export function labelDefinition(name: string): LabelDefinition {
  const wanted = name.trim();
  const standard = STANDARD_LABELS.find((label) => label.name.toLowerCase() === wanted.toLowerCase());
  if (standard !== undefined) return { name: standard.name, color: standard.color, description: standard.description };
  return { name: wanted, color: DEFAULT_COLOR, description: null };
}
