import type { Logger } from '../../log.ts';
import { normalizeStateName } from '../../workflow/config.ts';
import { TrackerError, type AgentToolSpec, type Issue, type TrackerAdapter } from '../types.ts';
import { assertNoGraphqlErrors, type GithubGraphqlClient, type GraphqlError } from './client.ts';
import {
  NO_STATUS,
  applyDispatchRules,
  inRepositoryScope,
  normalizeItemNode,
  type IssueReference,
  type NormalizeOutcome,
  type ProjectMeta,
  type SelectOption,
} from './normalize.ts';
import { ITEM_DETAILS_QUERY, PROJECT_ITEMS_QUERY, PROJECT_META_QUERY, referenceStatesQuery } from './queries.ts';
import { KIND, type GithubProjectSettings } from './settings.ts';
import { createGithubTools } from './tools.ts';

/** Upper bound on board pages per poll (100 items each). */
const MAX_PAGES = 500;
/** Item ids per `nodes(ids:)` request; keeps each request's rate-limit cost small. */
const DETAIL_BATCH = 50;
/** Text references resolved per request. */
const REFERENCE_BATCH = 50;

type IssueOutcome = Extract<NormalizeOutcome, { kind: 'issue' }>;

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function options(value: unknown): SelectOption[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(obj)
    .filter((o): o is Json => o !== null && typeof o.id === 'string' && typeof o.name === 'string')
    .map((o) => ({ id: o.id as string, name: o.name as string }));
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export class GithubProjectAdapter implements TrackerAdapter {
  readonly kind = KIND;
  readonly settings: GithubProjectSettings;
  readonly client: GithubGraphqlClient;
  #logger: Logger;
  #meta: Promise<ProjectMeta> | null = null;

  constructor(settings: GithubProjectSettings, client: GithubGraphqlClient, logger: Logger) {
    this.settings = settings;
    this.client = client;
    this.#logger = logger.child({ tracker: KIND });
  }

  /** Project id and field metadata, fetched once per adapter instance (refresh with force). */
  meta(force = false): Promise<ProjectMeta> {
    if (force || this.#meta === null) {
      const pending = this.#loadMeta();
      this.#meta = pending;
      pending.catch(() => {
        if (this.#meta === pending) this.#meta = null;
      });
    }
    return this.#meta;
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) return [];
    const wanted = new Set(stateNames.map(normalizeStateName));
    const meta = await this.meta();

    const candidates: string[] = [];
    const seenCursors = new Set<string>();
    let after: string | null = null;
    for (let page = 1; ; page++) {
      const response = await this.client.request<Json>(PROJECT_ITEMS_QUERY, {
        projectId: meta.projectId,
        after,
        statusField: this.settings.statusField,
      });
      assertNoGraphqlErrors(response.errors);
      const items = obj(obj(obj(response.data)?.node)?.items);
      const pageInfo = obj(items?.pageInfo);
      if (items === null || pageInfo === null || !Array.isArray(items.nodes)) {
        throw new TrackerError('tracker_response', 'project items missing from GitHub response');
      }
      for (const raw of items.nodes) {
        const node = obj(raw);
        if (node === null || node.isArchived === true || typeof node.id !== 'string') continue;
        const content = obj(node.content);
        if (content?.__typename !== 'Issue') continue;
        const repository = obj(content.repository)?.nameWithOwner;
        if (!inRepositoryScope(this.settings, typeof repository === 'string' ? repository : null)) continue;
        const status = obj(node.status)?.name;
        const state = typeof status === 'string' && status.trim() !== '' ? status : NO_STATUS;
        if (wanted.has(normalizeStateName(state))) candidates.push(node.id);
      }

      if (pageInfo.hasNextPage !== true) break;
      const cursor = pageInfo.endCursor;
      if (typeof cursor !== 'string' || cursor === '' || seenCursors.has(cursor)) {
        throw new TrackerError('tracker_pagination', 'GitHub reported more project items but returned no new cursor');
      }
      if (page >= MAX_PAGES) {
        throw new TrackerError('tracker_pagination', `project has more than ${MAX_PAGES * 100} items; narrow the board`);
      }
      seenCursors.add(cursor);
      after = cursor;
    }

    const outcomes: IssueOutcome[] = [];
    for (const batch of chunk(candidates, DETAIL_BATCH)) {
      const nodes = await this.#fetchItemNodes(batch, meta);
      for (const [index, node] of nodes.entries()) {
        const outcome = normalizeItemNode(node, meta, this.settings);
        if (outcome.kind === 'issue') {
          // The item may have moved between the board pass and the detail fetch.
          if (wanted.has(normalizeStateName(outcome.issue.state))) outcomes.push(outcome);
        } else if (outcome.kind === 'malformed') {
          this.#logger.warn('omitting malformed project item', { item_id: batch[index], reason: outcome.reason });
        }
      }
    }
    await this.#resolveTextBlockers(outcomes);
    return outcomes.map((outcome) => outcome.issue);
  }

  async fetchIssuesByIds(issueIds: string[]): Promise<Issue[]> {
    const unique = [...new Set(issueIds)];
    if (unique.length === 0) return [];
    const meta = await this.meta();

    const outcomes: IssueOutcome[] = [];
    for (const batch of chunk(unique, DETAIL_BATCH)) {
      const nodes = await this.#fetchItemNodes(batch, meta);
      for (const [index, node] of nodes.entries()) {
        const outcome = normalizeItemNode(node, meta, this.settings);
        if (outcome.kind === 'issue') outcomes.push(outcome);
        else if (outcome.kind === 'malformed') {
          // Omission means "no longer visible", so a malformed requested record must fail the call.
          throw new TrackerError('tracker_response', `project item ${batch[index]} is malformed: ${outcome.reason}`);
        }
      }
    }
    await this.#resolveTextBlockers(outcomes);
    return outcomes.map((outcome) => outcome.issue);
  }

  /**
   * Adds blockers written in issue text ("blocked by #12") to `blocked_by`, with their current
   * state, then re-applies the dispatch rules. References that cannot be resolved (a typo, no
   * access) are dropped rather than blocking forever.
   */
  async #resolveTextBlockers(outcomes: IssueOutcome[]): Promise<void> {
    const key = (repository: string, number: number) => `${repository.toLowerCase()}#${number}`;
    const pending = new Map<string, IssueReference>();
    for (const outcome of outcomes) {
      const known = new Set(outcome.issue.blocked_by.map((b) => b.identifier?.toLowerCase()));
      for (const reference of outcome.textBlockers) {
        if (!known.has(key(reference.repository, reference.number))) pending.set(key(reference.repository, reference.number), reference);
      }
    }

    const resolved = new Map<string, { id: string | null; state: string | null }>();
    for (const batch of chunk([...pending.values()], REFERENCE_BATCH)) {
      const { query, variables } = referenceStatesQuery(batch);
      const response = await this.client.request<Json>(query, variables);
      // Unknown numbers or repositories come back as NOT_FOUND with a null entry.
      assertNoGraphqlErrors(response.errors, (error) => error.type === 'NOT_FOUND' && String(error.path?.[0] ?? '').startsWith('ref'));
      for (const [index, reference] of batch.entries()) {
        const target = obj(obj(obj(response.data)?.[`ref${index}`])?.issueOrPullRequest);
        if (target !== null && typeof target.state === 'string') {
          resolved.set(key(reference.repository, reference.number), { id: typeof target.id === 'string' ? target.id : null, state: target.state });
        } else {
          this.#logger.debug('ignoring unresolvable "blocked by" reference', { reference: `${reference.repository}#${reference.number}` });
        }
      }
    }

    for (const outcome of outcomes) {
      const known = new Set(outcome.issue.blocked_by.map((b) => b.identifier?.toLowerCase()));
      for (const reference of outcome.textBlockers) {
        const id = key(reference.repository, reference.number);
        const found = resolved.get(id);
        if (found === undefined || known.has(id)) continue;
        known.add(id);
        outcome.issue.blocked_by.push({ id: found.id, identifier: `${reference.repository}#${reference.number}`, state: found.state });
      }
      applyDispatchRules(outcome.issue, outcome.gates, this.settings);
    }
  }

  async statusOptions(): Promise<string[]> {
    return (await this.meta()).statusOptions.map((option) => option.name);
  }

  agentToolSpecs(): AgentToolSpec[] {
    return createGithubTools(this);
  }

  issueRepository(issue: Issue): string | null {
    const repository = issue.native_ref?.provider === KIND ? issue.native_ref.repository : null;
    return typeof repository === 'string' ? repository : null;
  }

  /** Lets hooks clone the issue's own repository, so one board can span several repositories. */
  hookEnvironment(issue: Issue): Record<string, string> {
    const ref = issue.native_ref;
    if (ref === null || ref.provider !== KIND) return {};
    return {
      SYMPHONY_ISSUE_REPOSITORY: typeof ref.repository === 'string' ? ref.repository : '',
      SYMPHONY_ISSUE_NUMBER: typeof ref.number === 'number' ? String(ref.number) : '',
    };
  }

  async #fetchItemNodes(ids: string[], meta: ProjectMeta): Promise<unknown[]> {
    const response = await this.client.request<Json>(ITEM_DETAILS_QUERY, {
      ids,
      statusField: this.settings.statusField,
      priorityField: this.settings.priorityField ?? '',
      withPriority: meta.priority !== null,
    });
    // Unknown or deleted ids come back as null entries with a NOT_FOUND error; those are "not visible".
    assertNoGraphqlErrors(response.errors, (error: GraphqlError) => error.type === 'NOT_FOUND' && error.path?.[0] === 'nodes');
    const nodes = obj(response.data)?.nodes;
    if (!Array.isArray(nodes) || nodes.length !== ids.length) {
      throw new TrackerError('tracker_response', 'GitHub returned an unexpected number of project items');
    }
    return nodes;
  }

  async #loadMeta(): Promise<ProjectMeta> {
    const { owner, projectNumber, statusField, priorityField } = this.settings;
    const response = await this.client.request<Json>(PROJECT_META_QUERY, {
      owner,
      number: projectNumber,
      statusField,
      priorityField: priorityField ?? '',
      withPriority: priorityField !== null,
    });
    const notFound = response.errors.find((e) => e.type === 'NOT_FOUND');
    if (notFound) {
      throw new TrackerError('invalid_tracker_config', `project ${owner}/${projectNumber} not found: ${notFound.message}`);
    }
    assertNoGraphqlErrors(response.errors);

    const ownerNode = obj(obj(response.data)?.repositoryOwner);
    if (ownerNode === null) throw new TrackerError('invalid_tracker_config', `GitHub user or organization "${owner}" not found`);
    const project = obj(ownerNode.projectV2);
    if (project === null || typeof project.id !== 'string') {
      throw new TrackerError('invalid_tracker_config', `project number ${projectNumber} not found for "${owner}"`);
    }

    const status = obj(project.statusField);
    if (status?.__typename !== 'ProjectV2SingleSelectField' || typeof status.id !== 'string') {
      throw new TrackerError(
        'invalid_tracker_config',
        `project field "${statusField}" is missing or not a single-select field (set tracker.provider.status_field)`,
      );
    }

    let priority: ProjectMeta['priority'] = null;
    if (priorityField !== null) {
      const field = obj(project.priorityField);
      if (field?.__typename === 'ProjectV2SingleSelectField') priority = { kind: 'single_select', options: options(field.options) };
      else if (field?.__typename === 'ProjectV2Field' && field.dataType === 'NUMBER') priority = { kind: 'number' };
      else {
        throw new TrackerError(
          'invalid_tracker_config',
          `priority field "${priorityField}" is missing or neither single-select nor number`,
        );
      }
    }

    if (project.closed === true) this.#logger.warn('project is closed; issues are still read', { project: project.title });
    return {
      projectId: project.id,
      title: typeof project.title === 'string' ? project.title : '',
      url: typeof project.url === 'string' ? project.url : null,
      statusFieldId: status.id,
      statusOptions: options(status.options),
      priority,
    };
  }
}
