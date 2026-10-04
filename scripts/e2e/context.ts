// Shared setup for the end-to-end test: the same WORKFLOW.md, .env and board Symphony uses, plus GitHub helpers.
import fs from 'node:fs';
import path from 'node:path';
import { Logger } from '../../src/log.ts';
import { GithubGraphqlClient, assertNoGraphqlErrors } from '../../src/tracker/github-project/client.ts';
import { githubProjectFactory } from '../../src/tracker/github-project/index.ts';
import { KIND, parseSettings, type GithubProjectSettings } from '../../src/tracker/github-project/settings.ts';
import type { TrackerAdapter } from '../../src/tracker/types.ts';
import { loadEnvFile } from '../../src/util/env.ts';
import type { ServiceConfig } from '../../src/workflow/config.ts';
import { WorkflowStore } from '../../src/workflow/store.ts';

export const ROOT = path.resolve(import.meta.dirname, '../..');

/** Board columns the scenario uses, as named in WORKFLOW.md. */
export const STATUS = { start: 'Ready', handoff: 'In review', done: 'Done' } as const;

export interface E2eContext {
  workflowPath: string;
  /** The dotenv file Symphony is started with; null when there is none. */
  envFile: string | null;
  config: ServiceConfig;
  settings: GithubProjectSettings;
  /** First entry of tracker.provider.repositories: the test issues are created there. */
  repository: string;
  github: Github;
  adapter: TrackerAdapter;
}

export async function loadContext(options: { workflowPath?: string; envFile?: string } = {}): Promise<E2eContext> {
  const workflowPath = path.resolve(options.workflowPath ?? path.join(ROOT, 'WORKFLOW.md'));
  const defaultEnvFile = path.join(path.dirname(workflowPath), '.env');
  const envFile = options.envFile !== undefined ? path.resolve(options.envFile) : fs.existsSync(defaultEnvFile) ? defaultEnvFile : null;
  const env = envFile === null ? process.env : loadEnvFile(envFile, process.env).env;

  const logger = Logger.create({ level: 'warn' });
  const { config } = (await WorkflowStore.open(workflowPath, { env, logger })).current;
  if (config.tracker.kind !== KIND) throw new Error(`the e2e test needs tracker.kind ${KIND}, got ${config.tracker.kind ?? '(none)'}`);
  const { settings, errors } = parseSettings(config.tracker.provider, env);
  if (settings === null) throw new Error(`invalid tracker config: ${errors.join('; ')}`);
  const repository = [...(settings.repositories ?? [])][0];
  if (repository === undefined) throw new Error('tracker.provider.repositories must name the repository for the test issues');

  const client = new GithubGraphqlClient({
    endpoint: settings.endpoint,
    token: settings.token,
    timeoutMs: settings.requestTimeoutMs,
    retries: settings.requestRetries,
  });
  const adapter = githubProjectFactory.create({
    provider: config.tracker.provider,
    activeStates: config.tracker.activeStates,
    terminalStates: config.tracker.terminalStates,
    env,
    logger,
  });
  return { workflowPath, envFile, config, settings, repository, github: new Github(client), adapter };
}

export class Github {
  #client: GithubGraphqlClient;

  constructor(client: GithubGraphqlClient) {
    this.#client = client;
  }

  /** Runs a query or mutation; any GraphQL error throws. */
  async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const { data, errors } = await this.#client.request<T>(query, variables);
    assertNoGraphqlErrors(errors);
    if (data === null) throw new Error('GitHub returned no data');
    return data;
  }
}

export interface Board {
  projectId: string;
  statusFieldId: string;
  /** Status option ids by lowercased option name. */
  options: Map<string, string>;
}

export async function loadBoard(context: E2eContext): Promise<Board> {
  const data = await context.github.gql<{
    repositoryOwner: { projectV2?: { id: string; field: { id?: string; options?: Array<{ id: string; name: string }> } | null } | null } | null;
  }>(
    `query($owner: String!, $number: Int!, $field: String!) {
      repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number) {
        id field(name: $field) { ... on ProjectV2SingleSelectField { id options { id name } } }
      } } }
    }`,
    { owner: context.settings.owner, number: context.settings.projectNumber, field: context.settings.statusField },
  );
  const project = data.repositoryOwner?.projectV2;
  if (!project) throw new Error(`board ${context.settings.owner}/projects/${context.settings.projectNumber} not found`);
  if (project.field?.id === undefined) throw new Error(`board has no single-select field "${context.settings.statusField}"`);
  const board: Board = {
    projectId: project.id,
    statusFieldId: project.field.id,
    options: new Map((project.field.options ?? []).map((option) => [option.name.toLowerCase(), option.id])),
  };
  for (const name of Object.values(STATUS)) statusOption(board, name);
  return board;
}

export function statusOption(board: Board, name: string): string {
  const id = board.options.get(name.toLowerCase());
  if (id === undefined) throw new Error(`board has no status "${name}" (has: ${[...board.options.keys()].join(', ')})`);
  return id;
}

export async function setStatus(context: E2eContext, board: Board, itemId: string, status: string): Promise<void> {
  await context.github.gql(
    `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
      updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) {
        projectV2Item { id }
      }
    }`,
    { project: board.projectId, item: itemId, field: board.statusFieldId, option: statusOption(board, status) },
  );
}

export interface ItemState {
  itemId: string;
  number: number;
  status: string | null;
  issueState: string;
}

/** Board status and issue state of the given project items. */
export async function readItems(context: E2eContext, itemIds: string[]): Promise<ItemState[]> {
  const data = await context.github.gql<{
    nodes: Array<{ id: string; status: { name?: string } | null; content: { number?: number; state?: string } | null } | null>;
  }>(
    `query($ids: [ID!]!, $field: String!) {
      nodes(ids: $ids) { ... on ProjectV2Item {
        id status: fieldValueByName(name: $field) { ... on ProjectV2ItemFieldSingleSelectValue { name } }
        content { ... on Issue { number state } }
      } }
    }`,
    { ids: itemIds, field: context.settings.statusField },
  );
  return data.nodes.flatMap((node) =>
    node?.content?.number === undefined
      ? []
      : [{ itemId: node.id, number: node.content.number, status: node.status?.name ?? null, issueState: node.content.state ?? '' }],
  );
}

/** Closes the issue unless it is already closed (the board's "Auto-close issue" workflow may have done it). */
export async function closeIssue(context: E2eContext, issueId: string): Promise<boolean> {
  const { node } = await context.github.gql<{ node: { state: string } | null }>(`query($id: ID!) { node(id: $id) { ... on Issue { state } } }`, {
    id: issueId,
  });
  if (node?.state !== 'OPEN') return false;
  await context.github.gql(`mutation($id: ID!) { closeIssue(input: { issueId: $id, stateReason: COMPLETED }) { issue { number } } }`, { id: issueId });
  return true;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** HH:MM:SS in UTC, as in Symphony's logs. */
export function clock(date: Date | string | null | undefined = new Date()): string {
  return date === null || date === undefined ? '–' : new Date(date).toISOString().slice(11, 19);
}
