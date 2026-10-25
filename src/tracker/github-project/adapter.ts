import type { Logger } from '../../log.ts';
import { errorMessage } from '../../util/errors.ts';
import { decodeMarker } from '../../workflow/results.ts';
import { normalizeStateName } from '../../workflow/config.ts';
import {
  TrackerError,
  type AddLabelsResult,
  type AgentToolSpec,
  type AutoMergeResult,
  type CheckStatus,
  type Issue,
  type IssueAttachment,
  type IssueComment,
  type MergeWatch,
  type PostedComment,
  type RemoveLabelsResult,
  type SetStatusOptions,
  type StatusChange,
  type TrackedResult,
  type TrackerAdapter,
} from '../types.ts';
import { downloadAttachments, extractAttachmentLinks, webOrigin, type AttachmentLink } from './attachments.ts';
import { assertNoGraphqlErrors, type GithubGraphqlClient, type GraphqlError } from './client.ts';
import { AWAITING_CHECKS_LABEL, isCreatableLabel, labelDefinition } from './labels.ts';
import { autoMerge, CHECKS_FAILED_MARKER, type MergeOptions } from './merge.ts';
import {
  NO_STATUS,
  applyDispatchRules,
  inRepositoryScope,
  isHeldBySubIssues,
  issueRefOf,
  normalizeItemNode,
  openSubIssuesOf,
  titleKey,
  type IssueRef,
  type IssueReference,
  type NormalizeOutcome,
  type ProjectMeta,
  type SelectOption,
} from './normalize.ts';
import {
  ADD_COMMENT_MUTATION,
  ADD_LABELS_MUTATION,
  CREATE_LABEL_MUTATION,
  ISSUE_ATTACHMENTS_QUERY,
  ISSUE_COMMENTS_QUERY,
  ITEM_DETAILS_QUERY,
  PROJECT_ITEMS_QUERY,
  PROJECT_META_QUERY,
  REMOVE_LABELS_MUTATION,
  SET_STATUS_MUTATION,
  VIEWER_QUERY,
  referenceStatesQuery,
  repositoryLabelsQuery,
} from './queries.ts';
import { KIND, type GithubProjectSettings } from './settings.ts';
import { postCommitStatus } from './statuses.ts';
import { createGithubTools } from './tools.ts';

/** Upper bound on board pages per poll (100 items each). */
const MAX_PAGES = 500;
/** Item ids per `nodes(ids:)` request; keeps each request's rate-limit cost small. */
const DETAIL_BATCH = 50;
/** Text references resolved per request. */
const REFERENCE_BATCH = 50;
/** The start of a stage-result marker, of any version (`decodeMarker` reads only intact v1 markers). */
const RESULT_MARKER = /<!-- symphony:result:/;

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

function findOption(meta: ProjectMeta, name: string): SelectOption | undefined {
  const wanted = name.trim().toLowerCase();
  return meta.statusOptions.find((option) => option.name.trim().toLowerCase() === wanted);
}

/** Trimmed, non-empty names without duplicates (GitHub label names are case-insensitive), in the order given. */
function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const name of names.map((n) => n.trim())) {
    if (name === '' || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    unique.push(name);
  }
  return unique;
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
  #fetch: typeof fetch;
  #meta: Promise<ProjectMeta> | null = null;
  #viewer: Promise<string> | null = null;
  /** Commit the entry checks ran on, per issue waiting for pull request checks; lost on restart (then not compared). */
  #awaitingChecked = new Map<string, string>();

  constructor(settings: GithubProjectSettings, client: GithubGraphqlClient, logger: Logger, fetchImpl: typeof fetch = fetch) {
    this.settings = settings;
    this.client = client;
    this.#logger = logger.child({ tracker: KIND });
    this.#fetch = fetchImpl;
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

  /** Lets hooks clone the issue's own repository (on the base branch), so one board can span several repositories. */
  hookEnvironment(issue: Issue): Record<string, string> {
    const ref = issue.native_ref;
    if (ref === null || ref.provider !== KIND) return {};
    return {
      SYMPHONY_ISSUE_REPOSITORY: typeof ref.repository === 'string' ? ref.repository : '',
      SYMPHONY_ISSUE_NUMBER: typeof ref.number === 'number' ? String(ref.number) : '',
      ...(this.settings.baseBranch !== null ? { SYMPHONY_BASE_BRANCH: this.settings.baseBranch } : {}),
    };
  }

  /** Sub-issues that are not closed; GitHub allows 100 per issue, and the item query reads all of them. */
  openSubIssues(issue: Issue): string[] {
    return openSubIssuesOf(issue).map((sub) => sub.identifier);
  }

  /** Only the open sub-issues hold the issue back (`respect_sub_issues`): no closed issue, assignee or open blocker. */
  heldBySubIssues(issue: Issue): boolean {
    return isHeldBySubIssues(issue);
  }

  async commentOnIssue(issue: Issue, body: string): Promise<void> {
    await this.postComment(issue, body);
  }

  async postComment(issue: Issue, body: string): Promise<PostedComment> {
    const ref = this.#requireRef(issue, 'comment on');
    const response = await this.client.request<Json>(ADD_COMMENT_MUTATION, { subjectId: ref.issueId, body });
    assertNoGraphqlErrors(response.errors);
    const url = obj(obj(obj(obj(response.data)?.addComment)?.commentEdge)?.node)?.url;
    return { url: typeof url === 'string' ? url : null };
  }

  async readComments(issue: Issue): Promise<IssueComment[]> {
    const ref = this.#requireRef(issue, 'read comments of');
    const comments: IssueComment[] = [];
    const seenCursors = new Set<string>();
    let after: string | null = null;
    for (let page = 1; ; page++) {
      const response = await this.client.request<Json>(ISSUE_COMMENTS_QUERY, { issueId: ref.issueId, after });
      assertNoGraphqlErrors(response.errors);
      const connection = obj(obj(obj(response.data)?.node)?.comments);
      const pageInfo = obj(connection?.pageInfo);
      if (connection === null || pageInfo === null || !Array.isArray(connection.nodes)) {
        throw new TrackerError('tracker_response', `comments of ${issue.identifier} missing from GitHub response`);
      }
      for (const raw of connection.nodes) {
        const node = obj(raw);
        const createdAt = new Date(String(node?.createdAt));
        if (node === null || typeof node.body !== 'string' || typeof node.url !== 'string' || Number.isNaN(createdAt.getTime())) {
          throw new TrackerError('tracker_response', `malformed comment on ${issue.identifier} in GitHub response`);
        }
        const login = obj(node.author)?.login;
        comments.push({ author: typeof login === 'string' ? login : null, createdAt, body: node.body, url: node.url });
      }

      if (pageInfo.hasNextPage !== true) return comments;
      const cursor = pageInfo.endCursor;
      if (typeof cursor !== 'string' || cursor === '' || seenCursors.has(cursor)) {
        throw new TrackerError('tracker_pagination', 'GitHub reported more comments but returned no new cursor');
      }
      if (page >= MAX_PAGES) {
        throw new TrackerError('tracker_pagination', `${issue.identifier} has more than ${MAX_PAGES * 100} comments`);
      }
      seenCursors.add(cursor);
      after = cursor;
    }
  }

  async issueAttachments(issue: Issue): Promise<IssueAttachment[]> {
    const ref = this.#requireRef(issue, 'read attachments of');
    const origin = webOrigin(this.settings.endpoint);
    const links: AttachmentLink[] = [];
    const seenCursors = new Set<string>();
    let after: string | null = null;
    for (let page = 1; ; page++) {
      const response = await this.client.request<Json>(ISSUE_ATTACHMENTS_QUERY, { issueId: ref.issueId, after });
      assertNoGraphqlErrors(response.errors);
      const node = obj(obj(response.data)?.node);
      const connection = obj(node?.comments);
      const pageInfo = obj(connection?.pageInfo);
      if (node === null || connection === null || pageInfo === null || !Array.isArray(connection.nodes)) {
        throw new TrackerError('tracker_response', `attachments of ${issue.identifier} missing from GitHub response`);
      }
      if (page === 1 && typeof node.bodyHTML === 'string') links.push(...extractAttachmentLinks(node.bodyHTML, 'description', origin));
      for (const raw of connection.nodes) {
        const comment = obj(raw);
        if (typeof comment?.bodyHTML === 'string' && typeof comment.url === 'string') {
          links.push(...extractAttachmentLinks(comment.bodyHTML, comment.url, origin));
        }
      }

      if (pageInfo.hasNextPage !== true) break;
      const cursor = pageInfo.endCursor;
      if (typeof cursor !== 'string' || cursor === '' || seenCursors.has(cursor) || page >= MAX_PAGES) {
        throw new TrackerError('tracker_pagination', `could not page through the comments of ${issue.identifier}`);
      }
      seenCursors.add(cursor);
      after = cursor;
    }
    // Signed image URLs expire after a few minutes: download right after reading them.
    return downloadAttachments(links, { fetch: this.#fetch, token: this.settings.token, origin, timeoutMs: this.settings.requestTimeoutMs });
  }

  async readResults(issue: Issue): Promise<TrackedResult[]> {
    const [comments, viewer] = await Promise.all([this.readComments(issue), this.viewerLogin()]);
    const results: TrackedResult[] = [];
    for (const comment of comments) {
      const decoded = decodeMarker(comment.body);
      if (decoded === null) {
        // A damaged marker of Symphony's own counts as no result: the round counters may be one short.
        if (comment.author === viewer && RESULT_MARKER.test(comment.body)) {
          this.#logger.warn('ignoring a damaged result marker', { issue: issue.identifier, url: comment.url });
        }
        continue;
      }
      if (comment.author !== viewer) {
        this.#logger.warn('ignoring a result marker from another author', { issue: issue.identifier, author: comment.author, url: comment.url });
        continue;
      }
      results.push({ ...decoded, createdAt: comment.createdAt, url: comment.url });
    }
    return results;
  }

  /** The account the token acts as; constant per token, so it is fetched once per adapter instance. */
  viewerLogin(): Promise<string> {
    if (this.#viewer === null) {
      const pending = this.#loadViewer();
      this.#viewer = pending;
      pending.catch(() => {
        if (this.#viewer === pending) this.#viewer = null;
      });
    }
    return this.#viewer;
  }

  /** The board's option for a column name (case-insensitive), refreshing the cached columns once if needed. */
  async statusOption(status: string): Promise<{ option: SelectOption | undefined; meta: ProjectMeta }> {
    let meta = await this.meta();
    let option = findOption(meta, status);
    if (option === undefined) {
      meta = await this.meta(true);
      option = findOption(meta, status);
    }
    return { option, meta };
  }

  /**
   * Moves the issue to a column. Entering `auto_merge.on_enter` merges the issue's pull request afterwards; the caller
   * (the `set_status` tool, the transition guard) has run the entry checks before, on `options.checkedSha`. Not
   * retried, like every mutation.
   */
  async setStatus(issue: Issue, column: string, options: SetStatusOptions = {}): Promise<StatusChange> {
    const ref = this.#requireRef(issue, 'move');
    const { option, meta } = await this.statusOption(column);
    if (option === undefined) {
      const valid = meta.statusOptions.map((o) => `"${o.name}"`).join(', ');
      throw new TrackerError('invalid_argument', `unknown status "${column}"; valid options: ${valid}`);
    }
    const moved = await this.#moveTo(ref, meta, option);
    const { autoMerge: merge, baseBranch } = this.settings;
    if (merge === null || baseBranch === null || titleKey(moved) !== titleKey(merge.onEnter)) {
      return { previous: issue.state, status: moved };
    }
    // The guard ran the entry checks before this call: the change is reviewed and green, so it can be merged.
    const result = await this.#merge(issue, ref, moved, { checkedSha: options.checkedSha ?? null });
    return { previous: issue.state, status: result.status, autoMerge: result };
  }

  async reportCheckStatus(issue: Issue, status: CheckStatus): Promise<void> {
    const ref = this.#requireRef(issue, 'report a check for');
    await postCommitStatus({ fetch: this.#fetch, endpoint: this.settings.endpoint, token: this.settings.token, timeoutMs: this.settings.requestTimeoutMs }, ref.repository, status);
  }

  /**
   * Issues in `auto_merge.on_enter` with the label `awaiting-checks`; null without `auto_merge` or with
   * `auto_merge.checks.wait` off. A retry past `checks.timeout_ms` (since the issue entered the column) gives up.
   */
  mergeWatch(): MergeWatch | null {
    const merge = this.settings.autoMerge;
    if (merge === null || this.settings.baseBranch === null || !merge.checks.wait) return null;
    return {
      column: merge.onEnter,
      awaiting: (issue) =>
        titleKey(issue.state) === titleKey(merge.onEnter) && issue.labels.some((label) => label.trim().toLowerCase() === AWAITING_CHECKS_LABEL),
      retry: async (issue) => {
        const ref = this.#requireRef(issue, 'merge');
        const entered = typeof issue.native_ref?.status_updated_at === 'string' ? Date.parse(issue.native_ref.status_updated_at) : Number.NaN;
        if (!Number.isNaN(entered) && Date.now() - entered > merge.checks.timeoutMs) {
          const reason = `the pull request checks did not finish within ${Math.round(merge.checks.timeoutMs / 60_000)} minutes (auto_merge.checks.timeout_ms)`;
          const warnings: string[] = [];
          await this.postComment(issue, `Symphony did not merge automatically: ${reason}. The issue stays in "${issue.state}" for a human.`).catch((error: unknown) =>
            warnings.push(`could not comment on the issue: ${errorMessage(error)}`),
          );
          await this.#dropAwaitingLabel(issue, warnings);
          return { merged: false, pull_request: null, status: issue.state, reason, ...(warnings.length > 0 ? { warnings } : {}) };
        }
        return this.#merge(issue, ref, issue.state, { checkedSha: this.#awaitingChecked.get(issue.id) ?? null, retry: true });
      },
    };
  }

  /** `autoMerge` with the adapter's operations; drops `awaiting-checks` once the issue no longer waits. */
  async #merge(issue: Issue, ref: IssueRef, column: string, options: MergeOptions): Promise<AutoMergeResult> {
    const { autoMerge: merge, baseBranch } = this.settings;
    if (merge === null || baseBranch === null) throw new Error('auto_merge is not configured');
    const result = await autoMerge(this.client, merge, baseBranch, ref, issue, column, {
      setStatus: async (name) => {
        const next = await this.statusOption(name);
        if (next.option === undefined) throw new Error(`board column "${name}" does not exist`);
        return this.#moveTo(ref, next.meta, next.option);
      },
      comment: async (body) => {
        await this.postComment(issue, body);
      },
      addLabel: async (name) => {
        const added = await this.addLabels(issue, [name], { create: true });
        if (added.unknown.length > 0) throw new Error(`label "${name}" does not exist`);
      },
      sendBacks: async () => {
        const [comments, viewer] = await Promise.all([this.readComments(issue), this.viewerLogin()]);
        return comments.filter((comment) => comment.author === viewer && comment.body.includes(CHECKS_FAILED_MARKER)).length;
      },
    }, options);
    if (result.awaiting_checks === true) {
      if (options.checkedSha !== null && options.checkedSha !== undefined) this.#awaitingChecked.set(issue.id, options.checkedSha);
      return result;
    }
    this.#awaitingChecked.delete(issue.id);
    const labelled = issue.labels.some((label) => label.trim().toLowerCase() === AWAITING_CHECKS_LABEL);
    if (options.retry === true || labelled) {
      const warnings = [...(result.warnings ?? [])];
      await this.#dropAwaitingLabel(issue, warnings);
      return warnings.length > 0 ? { ...result, warnings } : result;
    }
    return result;
  }

  async #dropAwaitingLabel(issue: Issue, warnings: string[]): Promise<void> {
    try {
      await this.removeLabels(issue, [AWAITING_CHECKS_LABEL]);
    } catch (error) {
      warnings.push(`could not remove the label "${AWAITING_CHECKS_LABEL}": ${errorMessage(error)}`);
    }
  }

  async addLabels(issue: Issue, names: string[], { create = false }: { create?: boolean } = {}): Promise<AddLabelsResult> {
    const ref = this.#requireRef(issue, 'label');
    const wanted = uniqueNames(names);
    const result: AddLabelsResult = { added: [], created: [], unknown: [] };
    if (wanted.length === 0) return result;

    const { repositoryId, labels } = await this.#lookupLabels(ref.repository, wanted);
    const ids: string[] = [];
    for (const [index, name] of wanted.entries()) {
      const existing = labels[index];
      if (existing !== null && existing !== undefined) {
        ids.push(existing.id);
        result.added.push(existing.name);
      } else if (create && isCreatableLabel(name)) {
        const made = await this.#createLabel(ref.repository, repositoryId, name);
        ids.push(made.id);
        result.added.push(made.name);
        result.created.push(made.name);
      } else {
        result.unknown.push(name);
      }
    }
    if (ids.length > 0) await this.#changeLabels(ADD_LABELS_MUTATION, ref, ids);
    return result;
  }

  async removeLabels(issue: Issue, names: string[]): Promise<RemoveLabelsResult> {
    const ref = this.#requireRef(issue, 'label');
    const wanted = uniqueNames(names);
    const result: RemoveLabelsResult = { removed: [], unknown: [] };
    if (wanted.length === 0) return result;

    const { labels } = await this.#lookupLabels(ref.repository, wanted);
    const ids: string[] = [];
    for (const [index, name] of wanted.entries()) {
      const existing = labels[index];
      if (existing !== null && existing !== undefined) {
        ids.push(existing.id);
        result.removed.push(existing.name);
      } else {
        result.unknown.push(name);
      }
    }
    if (ids.length > 0) await this.#changeLabels(REMOVE_LABELS_MUTATION, ref, ids);
    return result;
  }

  #requireRef(issue: Issue, action: string): IssueRef {
    const ref = issueRefOf(issue);
    if (ref === null) throw new TrackerError('tracker_request', `issue ${issue.identifier} has no GitHub reference to ${action}`);
    return ref;
  }

  async #moveTo(ref: IssueRef, meta: ProjectMeta, option: SelectOption): Promise<string> {
    const response = await this.client.request<Json>(SET_STATUS_MUTATION, {
      projectId: meta.projectId,
      itemId: ref.itemId,
      fieldId: meta.statusFieldId,
      optionId: option.id,
    });
    assertNoGraphqlErrors(response.errors);
    return option.name;
  }

  /** The repository id and, for each name in order, the label (matched case-insensitively by GitHub) or null. */
  async #lookupLabels(repository: string, names: string[]): Promise<{ repositoryId: string; labels: Array<{ id: string; name: string } | null> }> {
    const { query, variables } = repositoryLabelsQuery(repository, names);
    const response = await this.client.request<Json>(query, variables);
    assertNoGraphqlErrors(response.errors);
    const node = obj(obj(response.data)?.repository);
    if (node === null || typeof node.id !== 'string') throw new TrackerError('tracker_response', `repository ${repository} is not accessible`);
    const labels = names.map((_, index) => {
      const label = obj(node[`l${index}`]);
      return label !== null && typeof label.id === 'string' && typeof label.name === 'string' ? { id: label.id, name: label.name } : null;
    });
    return { repositoryId: node.id, labels };
  }

  async #createLabel(repository: string, repositoryId: string, name: string): Promise<{ id: string; name: string }> {
    const definition = labelDefinition(name);
    try {
      const response = await this.client.request<Json>(CREATE_LABEL_MUTATION, { repositoryId, ...definition });
      assertNoGraphqlErrors(response.errors);
      const label = obj(obj(obj(response.data)?.createLabel)?.label);
      if (label === null || typeof label.id !== 'string' || typeof label.name !== 'string') {
        throw new TrackerError('tracker_response', `GitHub created no label "${definition.name}"`);
      }
      return { id: label.id, name: label.name };
    } catch (error) {
      // Someone else created it between the lookup and now (another stage, a human): use theirs.
      if (!(error instanceof TrackerError) || !/already (exists|been taken)/i.test(error.message)) throw error;
      const [existing] = (await this.#lookupLabels(repository, [definition.name])).labels;
      if (existing === null || existing === undefined) throw error;
      return existing;
    }
  }

  async #changeLabels(mutation: string, ref: IssueRef, labelIds: string[]): Promise<void> {
    const response = await this.client.request<Json>(mutation, { labelableId: ref.issueId, labelIds });
    assertNoGraphqlErrors(response.errors);
  }

  async #loadViewer(): Promise<string> {
    const response = await this.client.request<Json>(VIEWER_QUERY, {});
    assertNoGraphqlErrors(response.errors);
    const login = obj(obj(response.data)?.viewer)?.login;
    if (typeof login !== 'string' || login === '') throw new TrackerError('tracker_response', 'GitHub returned no viewer login');
    return login;
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
