import { modelForLabelValue } from '../agent/model.ts';
import { errorMessage } from '../util/errors.ts';
import { GithubRestError, type GithubLabel, type GithubRestClient, type LabelUpdate, type NewLabel } from './github-rest.ts';
import type { InitTask } from './tasks.ts';

/** Values of the standard "Model: <value>" labels (README: "Modell pro Issue wählen"). */
const MODEL_LABEL_VALUES = ['opus', 'sonnet', 'haiku'];
const FAMILY_COLORS: Record<string, string> = { opus: '5319e7', sonnet: '1d76db', haiku: '0e8a16' };
const DEFAULT_COLOR = 'ededed';

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** The label for a model value; its description names the model Symphony passes to Claude Code. */
function modelLabel(value: string): NewLabel {
  const model = modelForLabelValue(value);
  if (model === null) throw new Error(`"Model: ${value}" does not name a model`);
  const family = /opus|sonnet|haiku|fable/.exec(model)?.[0] ?? '';
  const newest = model === family ? ` (newest ${capitalize(family)})` : '';
  return {
    name: `Model: ${value}`,
    color: FAMILY_COLORS[family] ?? DEFAULT_COLOR,
    description: `Symphony uses ${model}${newest} for this issue`,
  };
}

/** What the "Standard labels" task creates in each repository. */
export const STANDARD_LABELS: readonly NewLabel[] = MODEL_LABEL_VALUES.map(modelLabel);

export type LabelChange =
  | { kind: 'create'; label: NewLabel }
  | { kind: 'update'; label: NewLabel; current: GithubLabel; differences: string[] }
  | { kind: 'ok'; label: NewLabel; current: GithubLabel };

/** Compares a repository's labels with the wanted ones; names match case-insensitively, as on GitHub. */
export function planLabelChanges(existing: readonly GithubLabel[], wanted: readonly NewLabel[]): LabelChange[] {
  const byName = new Map(existing.map((label) => [label.name.toLowerCase(), label]));
  return wanted.map((label): LabelChange => {
    const current = byName.get(label.name.toLowerCase());
    if (current === undefined) return { kind: 'create', label };
    const differences: string[] = [];
    if (current.color.toLowerCase() !== label.color.toLowerCase()) differences.push(`color ${current.color} → ${label.color}`);
    if ((current.description ?? '') !== label.description) differences.push('description');
    if (current.archived_at !== null) differences.push('archived');
    return differences.length === 0 ? { kind: 'ok', label, current } : { kind: 'update', label, current, differences };
  });
}

export interface ApplyResult {
  created: number;
  updated: number;
  /** Labels that turned out to exist while creating them. */
  existing: number;
  failures: string[];
}

/** Creates the missing labels and, with `update`, aligns the differing ones (unarchiving them). Never deletes. */
export async function applyLabelChanges(
  github: GithubRestClient,
  repository: string,
  changes: readonly LabelChange[],
  update: boolean,
): Promise<ApplyResult> {
  const result: ApplyResult = { created: 0, updated: 0, existing: 0, failures: [] };
  for (const change of changes) {
    try {
      if (change.kind === 'create') {
        if (await createLabel(github, repository, change.label)) result.created++;
        else result.existing++;
      } else if (change.kind === 'update' && update) {
        const fields: LabelUpdate = { color: change.label.color, description: change.label.description };
        if (change.current.archived_at !== null) fields.archived = false;
        await github.updateLabel(repository, change.current.name, fields);
        result.updated++;
      }
    } catch (error) {
      result.failures.push(`${change.label.name} (${errorMessage(error)})`);
    }
  }
  return result;
}

/** False if the label exists after all: GitHub answers 422 for a duplicate name. */
async function createLabel(github: GithubRestClient, repository: string, label: NewLabel): Promise<boolean> {
  try {
    await github.createLabel(repository, label);
    return true;
  } catch (error) {
    if (error instanceof GithubRestError && error.status === 422 && (await github.getLabel(repository, label.name)) !== null) return false;
    throw error;
  }
}

const NAME_WIDTH = Math.max(...STANDARD_LABELS.map((label) => label.name.length));

/** One line per label to create or update, then a count of the labels that are fine. */
function describeChanges(changes: readonly LabelChange[]): string[] {
  const lines: string[] = [];
  for (const change of changes) {
    const name = change.label.name.padEnd(NAME_WIDTH);
    if (change.kind === 'create') lines.push(`+ create  ${name}  ${change.label.color}  ${change.label.description}`);
    else if (change.kind === 'update') lines.push(`~ update  ${name}  ${change.differences.join(', ')}`);
  }
  const ok = changes.filter((change) => change.kind === 'ok').length;
  if (ok === changes.length) lines.push(`= all ${plural(ok, 'label')} up to date`);
  else if (ok > 0) lines.push(`= ${plural(ok, 'label')} already up to date`);
  return lines;
}

function describeResult(result: ApplyResult): string {
  const parts: string[] = [];
  if (result.created > 0) parts.push(`${result.created} created`);
  if (result.updated > 0) parts.push(`${result.updated} updated`);
  if (result.existing > 0) parts.push(`${result.existing} already existed`);
  if (result.failures.length > 0) parts.push(`failed: ${result.failures.join('; ')}`);
  return parts.length > 0 ? parts.join(', ') : 'nothing to do';
}

export const labelsTask: InitTask = {
  id: 'labels',
  title: 'Standard labels',
  summary: '"Model: …" labels that pick the Claude model per issue',

  async run({ repositories, github, terminal }) {
    let ok = true;
    const plans: Array<{ repository: string; changes: LabelChange[] }> = [];
    for (const repository of repositories) {
      terminal.print(repository);
      try {
        const changes = planLabelChanges(await github.listLabels(repository), STANDARD_LABELS);
        for (const line of describeChanges(changes)) terminal.print(`  ${line}`);
        plans.push({ repository, changes });
      } catch (error) {
        ok = false;
        terminal.print(`  ✗ cannot read the labels: ${errorMessage(error)}`);
      }
    }

    const count = (kind: LabelChange['kind']) => plans.reduce((sum, plan) => sum + plan.changes.filter((c) => c.kind === kind).length, 0);
    const creates = count('create');
    const updates = count('update');
    if (creates === 0 && updates === 0) {
      if (plans.length > 0) terminal.print('All standard labels are up to date.');
      return ok;
    }

    let update = false;
    if (updates > 0) {
      const answer = await terminal.confirm(
        `${plural(updates, 'existing label')} ${updates === 1 ? 'differs' : 'differ'} from the standard. Update ${updates === 1 ? 'it' : 'them'}?`,
        false,
      );
      if (answer === null) return ok;
      update = answer;
    }
    const actions = [creates > 0 ? `create ${plural(creates, 'label')}` : null, update ? `update ${plural(updates, 'label')}` : null];
    const action = actions.filter((part) => part !== null).join(' and ');
    if (action === '') {
      terminal.print('Nothing changed.');
      return ok;
    }
    if ((await terminal.confirm(`${capitalize(action)}?`, true)) !== true) {
      terminal.print('Cancelled; nothing changed.');
      return ok;
    }

    for (const { repository, changes } of plans) {
      const result = await applyLabelChanges(github, repository, changes, update);
      if (result.failures.length > 0) ok = false;
      terminal.print(`  ${result.failures.length > 0 ? '✗' : '✓'} ${repository}: ${describeResult(result)}`);
    }
    return ok;
  },
};
