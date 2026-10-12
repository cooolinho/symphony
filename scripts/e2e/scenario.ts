// The test scenario: nine comment-only issues with "blocked by" dependencies, created on the board in "Ready".
import { STATUS, readItems, setStatus, sleep, type Board, type E2eContext } from './context.ts';

/** Every test issue runs with this model, chosen by its "Model: …" label. */
export const MODEL = 'sonnet';
export const MODEL_LABEL = `Model: ${MODEL}`;
export const TITLE_PREFIX = '[E2E run]';

export interface ScenarioIssue {
  key: string;
  title: string;
  /** "Blocked by" relationships. */
  blockers: string[];
  /** Dependency written only in the issue text ("Blocked by #N"). */
  textBlocker?: string;
}

/**
 * Four free issues (one more than three agents can take), a simple blocker, two blockers,
 * a chain, a text reference and a final issue that joins three branches.
 */
export const SCENARIO: ScenarioIssue[] = [
  { key: 'T1', title: 'Root A', blockers: [] },
  { key: 'T2', title: 'Root B', blockers: [] },
  { key: 'T3', title: 'Root C', blockers: [] },
  { key: 'T4', title: 'Root D', blockers: [] },
  { key: 'T5', title: 'after T1', blockers: ['T1'] },
  { key: 'T6', title: 'after T1 and T2', blockers: ['T1', 'T2'] },
  { key: 'T7', title: 'after T5', blockers: ['T5'] },
  { key: 'T8', title: 'after T3 (text)', blockers: [], textBlocker: 'T3' },
  { key: 'T9', title: 'Final', blockers: ['T6', 'T7', 'T8'] },
];

/** Issues without any dependency: they all start in the first wave, up to the concurrency limit. */
export const ROOT_COUNT = SCENARIO.filter((issue) => issue.blockers.length === 0 && issue.textBlocker === undefined).length;

export interface CreatedIssue {
  key: string;
  number: number;
  issueId: string;
  itemId: string;
  /** Keys of the issues set as "blocked by" relationships. */
  relationships: string[];
  /** Key of the issue referenced as "Blocked by #N" in the text. */
  textBlocker: string | null;
}

/** Every dependency of an issue: relationships and text reference alike. */
export function dependencies(issue: CreatedIssue): string[] {
  return issue.textBlocker === null ? issue.relationships : [...issue.relationships, issue.textBlocker];
}

export type ScenarioName = 'default' | 'roles';

/** What setup leaves in the run directory (run.json) for the run and the verification. */
export interface RunRecord {
  /** Absent in records of older runs: the dependency scenario. */
  scenario?: ScenarioName;
  startedAt: string;
  repository: string;
  issues: CreatedIssue[];
}

/** Marker the agent's comment must contain. */
export function doneMarker(key: string): string {
  return `E2E run ${key} done`;
}

/** Issue text; `numbers` holds the issue numbers of the issues created before this one. */
export type IssueBody = (issue: ScenarioIssue, numbers: Map<string, number>) => string;

function issueBody(issue: ScenarioIssue, numbers: Map<string, number>): string {
  const ref = (key: string) => `${key} (#${numbers.get(key)})`;
  const dependency =
    issue.textBlocker !== undefined
      ? `Dependency (text only): Blocked by #${numbers.get(issue.textBlocker)}`
      : issue.blockers.length > 0
        ? `Dependency via GitHub relationship: ${issue.blockers.map(ref).join(', ')}`
        : 'Dependency: none';
  return `E2E run of the Symphony orchestration (${issue.key}). **No code changes.**

${dependency}

## Task

1. Call \`mcp__tracker__get_issue\`.
2. Set the status to "In progress".
3. Post **one** comment (no separate plan comment) with exactly this content:
   \`${doneMarker(issue.key)}. Dependencies according to the tracker: <identifier: state, …>\`, or \`none\` if the tracker reports no dependencies.
4. Set the status to "${STATUS.handoff}".

Not allowed: changing files, creating a branch, committing, pushing, opening a pull request, setting the status "${STATUS.done}".
`;
}

/**
 * Creates the issues, their relationships and board items, then moves them to the start status.
 * The status is set last, so no issue is ever active without its dependencies.
 */
export async function createScenario(
  context: E2eContext,
  board: Board,
  log: (line: string) => void,
  scenario: { name: ScenarioName; issues: ScenarioIssue[]; body: IssueBody } = { name: 'default', issues: SCENARIO, body: issueBody },
): Promise<RunRecord> {
  const startedAt = new Date().toISOString();
  const [owner, name] = context.repository.split('/');
  const { repository } = await context.github.gql<{ repository: { id: string; nameWithOwner: string; label: { id: string } | null } | null }>(
    `query($owner: String!, $name: String!, $label: String!) { repository(owner: $owner, name: $name) { id nameWithOwner label(name: $label) { id } } }`,
    { owner, name, label: MODEL_LABEL },
  );
  if (repository === null) throw new Error(`repository ${context.repository} not found`);
  if (repository.label === null) throw new Error(`label "${MODEL_LABEL}" is missing in ${repository.nameWithOwner}; create it with npm run repo-init`);

  const numbers = new Map<string, number>();
  const ids = new Map<string, string>();
  for (const issue of scenario.issues) {
    const { createIssue } = await context.github.gql<{ createIssue: { issue: { id: string; number: number } } }>(
      `mutation($repo: ID!, $title: String!, $body: String!, $label: ID!) {
        createIssue(input: { repositoryId: $repo, title: $title, body: $body, labelIds: [$label] }) { issue { id number } }
      }`,
      { repo: repository.id, title: `${TITLE_PREFIX} ${issue.key} – ${issue.title}`, body: scenario.body(issue, numbers), label: repository.label.id },
    );
    numbers.set(issue.key, createIssue.issue.number);
    ids.set(issue.key, createIssue.issue.id);
    log(`created ${issue.key} as #${createIssue.issue.number}`);
  }

  for (const issue of scenario.issues) {
    for (const blocker of issue.blockers) {
      await context.github.gql(
        `mutation($issue: ID!, $blocker: ID!) { addBlockedBy(input: { issueId: $issue, blockingIssueId: $blocker }) { issue { number } } }`,
        { issue: ids.get(issue.key), blocker: ids.get(blocker) },
      );
    }
  }

  const items = new Map<string, string>();
  for (const issue of scenario.issues) {
    const { addProjectV2ItemById } = await context.github.gql<{ addProjectV2ItemById: { item: { id: string } } }>(
      `mutation($project: ID!, $content: ID!) { addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }`,
      { project: board.projectId, content: ids.get(issue.key) },
    );
    items.set(issue.key, addProjectV2ItemById.item.id);
  }
  for (const itemId of items.values()) await setStatus(context, board, itemId, STATUS.start);

  // Board workflows such as "Item added to project" may overwrite the status shortly after.
  await sleep(10_000);
  for (const item of await readItems(context, [...items.values()])) {
    if (item.status?.toLowerCase() !== STATUS.start.toLowerCase()) {
      log(`#${item.number} was "${item.status ?? 'No Status'}", setting "${STATUS.start}" again`);
      await setStatus(context, board, item.itemId, STATUS.start);
    }
  }

  return {
    scenario: scenario.name,
    startedAt,
    repository: repository.nameWithOwner,
    issues: scenario.issues.map((issue) => ({
      key: issue.key,
      number: numbers.get(issue.key) as number,
      issueId: ids.get(issue.key) as string,
      itemId: items.get(issue.key) as string,
      relationships: issue.blockers,
      textBlocker: issue.textBlocker ?? null,
    })),
  };
}
