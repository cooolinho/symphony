import { assertNoGraphqlErrors, type GithubGraphqlClient } from '../tracker/github-project/client.ts';
import { errorMessage } from '../util/errors.ts';
import type { InitTask } from './tasks.ts';

/** The columns (options of the Status field) the bundled WORKFLOW.md expects, in board order. */
export const BOARD_COLUMNS: readonly string[] = [
  'Backlog',
  'Ready',
  'Design',
  'In progress',
  'Testing',
  'Documentation',
  'Agent review',
  'Security review',
  'Blocked',
  'In review',
  'Done',
];

/** Where the board task looks: the project from GITHUB_PROJECT_NUMBER and its owner. */
export interface BoardContext {
  owner: string;
  number: number;
  statusField: string;
  graphql: GithubGraphqlClient;
}

/** One option of a single select field, as GitHub returns it (and as updateProjectV2Field takes it back). */
export interface StatusOption {
  id?: string;
  name: string;
  color: string;
  description: string;
}

const key = (name: string): string => name.trim().toLowerCase();

/** The wanted columns that are not options yet (case-insensitive), in the wanted order. */
export function missingBoardColumns(existing: ReadonlyArray<{ name: string }>, wanted: readonly string[] = BOARD_COLUMNS): string[] {
  const known = new Set(existing.map((option) => key(option.name)));
  return wanted.filter((name) => !known.has(key(name)));
}

/**
 * The full option list after adding the missing columns: existing options keep their id, color, description and
 * order; each missing column goes right after the nearest wanted column before it that is on the board (or in front
 * of the first one). New options are gray and have no description.
 */
export function mergeBoardColumns(existing: readonly StatusOption[], wanted: readonly string[] = BOARD_COLUMNS): StatusOption[] {
  const result = existing.map((option) => ({ ...option }));
  for (const name of missingBoardColumns(existing, wanted)) {
    const before = wanted.slice(0, wanted.indexOf(name)).map(key);
    let index = -1;
    for (let i = result.length - 1; i >= 0; i--) {
      if (before.includes(key(result[i]?.name ?? ''))) {
        index = i;
        break;
      }
    }
    if (index === -1) {
      const after = new Set(wanted.slice(wanted.indexOf(name) + 1).map(key));
      const first = result.findIndex((option) => after.has(key(option.name)));
      result.splice(first === -1 ? result.length : first, 0, { name, color: 'GRAY', description: '' });
    } else {
      result.splice(index + 1, 0, { name, color: 'GRAY', description: '' });
    }
  }
  return result;
}

const STATUS_FIELD_QUERY = /* GraphQL */ `
  query SymphonyBoardStatus($owner: String!, $number: Int!, $statusField: String!) {
    repositoryOwner(login: $owner) {
      ... on ProjectV2Owner {
        projectV2(number: $number) {
          title
          url
          field(name: $statusField) {
            __typename
            ... on ProjectV2SingleSelectField { id name options { id name color description } }
          }
        }
      }
    }
  }
`;

const UPDATE_OPTIONS_MUTATION = /* GraphQL */ `
  mutation SymphonyBoardColumns($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
    updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) {
      projectV2Field {
        ... on ProjectV2SingleSelectField { id options { id name } }
      }
    }
  }
`;

interface StatusFieldData {
  repositoryOwner: {
    projectV2?: {
      title: string;
      url: string;
      field: { __typename: string; id?: string; name?: string; options?: StatusOption[] } | null;
    } | null;
  } | null;
}

export interface BoardStatus {
  title: string;
  url: string;
  fieldId: string;
  options: StatusOption[];
}

/** Reads the board's Status field; throws with a readable message if the board or field is missing. */
export async function readBoardStatus(board: BoardContext): Promise<BoardStatus> {
  const { data, errors } = await board.graphql.request<StatusFieldData>(STATUS_FIELD_QUERY, {
    owner: board.owner,
    number: board.number,
    statusField: board.statusField,
  });
  assertNoGraphqlErrors(errors);
  const project = data?.repositoryOwner?.projectV2 ?? null;
  if (project === null) throw new Error(`no project ${board.number} for ${board.owner} (check GITHUB_PROJECT_NUMBER and GITHUB_PROJECT_OWNER)`);
  const field = project.field;
  if (field === null || field.__typename !== 'ProjectV2SingleSelectField' || field.id === undefined) {
    throw new Error(`the board has no single select field "${board.statusField}"`);
  }
  return { title: project.title, url: project.url, fieldId: field.id, options: field.options ?? [] };
}

/** Writes the option list; options with an id keep their identity, so cards keep their column. */
export async function writeBoardColumns(board: BoardContext, fieldId: string, options: readonly StatusOption[]): Promise<void> {
  const { errors } = await board.graphql.request(UPDATE_OPTIONS_MUTATION, {
    fieldId,
    options: options.map(({ id, name, color, description }) => (id === undefined ? { name, color, description } : { id, name, color, description })),
  });
  assertNoGraphqlErrors(errors);
}

export const boardColumnsTask: InitTask = {
  id: 'board',
  title: 'Board columns',
  summary: `checks that the Status field of the board (GITHUB_PROJECT_NUMBER) has the columns WORKFLOW.md expects and adds the missing ones`,

  async run({ board, terminal }) {
    if (board === undefined) {
      terminal.print('Skipped: GITHUB_PROJECT_NUMBER is not set (the board number or URL).');
      return true;
    }
    let status: BoardStatus;
    try {
      status = await readBoardStatus(board);
    } catch (error) {
      terminal.print(`✗ cannot read the board: ${errorMessage(error)}`);
      return false;
    }
    terminal.print(`Board: ${status.title} (${status.url})`);
    terminal.print(`Columns: ${status.options.map((option) => option.name).join(', ') || '(none)'}`);
    const missing = missingBoardColumns(status.options);
    if (missing.length === 0) {
      terminal.print('All columns are there.');
      return true;
    }
    terminal.print(`Missing: ${missing.join(', ')}`);
    const merged = mergeBoardColumns(status.options);
    terminal.print(`New order: ${merged.map((option) => option.name).join(' → ')}`);
    terminal.print('Existing columns keep their cards; only the missing ones are added.');
    if ((await terminal.confirm(`Add ${missing.length === 1 ? 'this column' : `these ${missing.length} columns`}?`, true)) !== true) {
      terminal.print('Cancelled; nothing changed.');
      return true;
    }
    try {
      await writeBoardColumns(board, status.fieldId, merged);
    } catch (error) {
      terminal.print(`✗ cannot update the board: ${errorMessage(error)}`);
      terminal.print('Add the columns by hand: board → menu of the Status field → add option (see docs/getting-started.md).');
      return false;
    }
    terminal.print(`✓ added ${missing.join(', ')}`);
    return true;
  },
};
