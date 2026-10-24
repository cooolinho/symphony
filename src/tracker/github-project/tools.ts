import { z } from 'zod';
import { SerialQueue } from '../../util/async.ts';
import { errorMessage } from '../../util/errors.ts';
import { TrackerError, type AgentToolContext, type AgentToolSpec, type Issue, type ToolResult } from '../types.ts';
import type { GithubProjectAdapter } from './adapter.ts';
import { assertNoGraphqlErrors } from './client.ts';
import { issueRefOf, titleKey, type IssueRef } from './normalize.ts';
import {
  ADD_BLOCKED_BY_MUTATION,
  ADD_PROJECT_ITEM_MUTATION,
  CREATE_PULL_REQUEST_MUTATION,
  CREATE_SUB_ISSUE_MUTATION,
  ISSUE_CONTEXT_QUERY,
  REPOSITORY_QUERY,
  SET_STATUS_MUTATION,
  SUB_ISSUE_CONTEXT_QUERY,
  UPDATE_PULL_REQUEST_MUTATION,
  referenceStatesQuery,
  repositoryLabelsQuery,
} from './queries.ts';

type Json = Record<string, unknown>;

/** Stage-result markers are Symphony's alone: an agent's text must not carry one (case and spacing do not matter). */
const MARKER_START = /<!--\s*symphony:/i;

function markerProblem(text: string | undefined): ToolResult | null {
  if (text === undefined || !MARKER_START.test(text)) return null;
  return fail(
    'invalid_argument',
    'the text contains "<!-- symphony:", which is reserved for the result markers Symphony writes itself; remove that HTML comment and post again',
  );
}

function obj(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function nodes(connection: unknown): Json[] {
  const list = obj(connection)?.nodes;
  return Array.isArray(list) ? (list.map(obj).filter((n) => n !== null) as Json[]) : [];
}

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

function fail(category: string, message: string): ToolResult {
  return { ok: false, error: { category, message } };
}

function issueView(issue: Issue): Json {
  return {
    identifier: issue.identifier,
    title: issue.title,
    status: issue.state,
    url: issue.url,
    description: issue.description,
    labels: issue.labels,
    assignee: issue.assignee_id,
    priority: issue.priority,
    branch_name: issue.branch_name,
    blocked_by: issue.blocked_by,
    parent: issue.native_ref?.parent ?? null,
    sub_issues: issue.native_ref?.sub_issues ?? [],
    issue_state: issue.native_ref?.issue_state ?? null,
    created_at: issue.created_at?.toISOString() ?? null,
    updated_at: issue.updated_at?.toISOString() ?? null,
  };
}

const RESULT_MARKER = /<!--\s*symphony:result:v1\s+[A-Za-z0-9_-]+\s*-->/g;

/** Agents do not need the base64 payload of a stage-result marker; it only doubles the comment's size. */
function commentBody(body: string, maxChars: number | undefined): string {
  const clean = body.replace(RESULT_MARKER, '<!-- symphony:result -->');
  if (maxChars === undefined || clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars)}… [${clean.length - maxChars} characters cut]`;
}

function isOpen(issue: Json): boolean {
  return issue.state !== 'CLOSED';
}

/** Runs a tool body on the session's issue, turning any exception into a structured failure the agent can read. */
async function guarded(context: AgentToolContext, body: (ref: IssueRef) => Promise<ToolResult>): Promise<ToolResult> {
  const ref = issueRefOf(context.issue);
  if (ref === null) return fail('invalid_context', 'this session has no GitHub project item to act on');
  try {
    return await body(ref);
  } catch (error) {
    if (error instanceof TrackerError) return fail(error.category, error.message);
    return fail('tool_error', errorMessage(error));
  }
}

/**
 * Provider-native tools for the GitHub Projects adapter (see docs/adapters/github-project.md).
 * They run in the orchestrator process with the adapter's token; the agent never sees it.
 */
export function createGithubTools(adapter: GithubProjectAdapter): AgentToolSpec[] {
  const client = adapter.client;

  const getIssue: AgentToolSpec = {
    name: 'get_issue',
    description:
      'Read the issue this session is working on from the GitHub project board: title, body, status, labels, ' +
      'assignee, blockers, the status options you can move it to, the latest 20 comments and linked pull requests. Read-only. ' +
      'Returns JSON: {issue: {identifier, title, status, url, description, labels, assignee, priority, branch_name, blocked_by, parent, sub_issues, issue_state, created_at, updated_at}, ' +
      'status_options: list of strings (names, not objects), comments: [{author, from_symphony, created_at, url, body}] oldest first (the newest is last; ' +
      'from_symphony is false for comments a human wrote), total_comments: number, ' +
      'linked_pull_requests: [{number, url, state, title, head}] (may be empty)}. ' +
      'Stage-result markers in comment bodies are shown as <!-- symphony:result --> without their base64 payload. ' +
      'If the output is large, pass max_comment_chars to cut every comment body (the cut is noted in the body).',
    inputSchema: {
      max_comment_chars: z.number().int().positive().optional().describe('Cut each comment body to this many characters'),
    },
    mutates: false,
    execute: (args, context) =>
      guarded(context, async (ref) => {
        const maxChars = typeof args.max_comment_chars === 'number' ? args.max_comment_chars : undefined;
        const [fresh] = await adapter.fetchIssuesByIds([context.issue.id]);
        if (fresh === undefined) return fail('not_found', 'the issue is no longer visible on the project board');
        const [meta, viewer] = await Promise.all([adapter.meta(), adapter.viewerLogin()]);
        const response = await client.request<Json>(ISSUE_CONTEXT_QUERY, { issueId: ref.issueId });
        assertNoGraphqlErrors(response.errors);
        const node = obj(obj(response.data)?.node);
        return ok({
          issue: issueView(fresh),
          status_options: meta.statusOptions.map((option) => option.name),
          comments: nodes(node?.comments).map((c) => ({
            author: obj(c.author)?.login ?? null,
            from_symphony: obj(c.author)?.login === viewer,
            created_at: c.createdAt ?? null,
            url: c.url ?? null,
            body: commentBody(typeof c.body === 'string' ? c.body : '', maxChars),
          })),
          total_comments: obj(node?.comments)?.totalCount ?? null,
          linked_pull_requests: nodes(node?.closedByPullRequestsReferences).map((pr) => ({
            number: pr.number,
            url: pr.url,
            state: pr.state,
            title: pr.title,
            head: pr.headRefName,
          })),
        });
      }),
  };

  const setStatus: AgentToolSpec = {
    name: 'set_status',
    description:
      'Move the issue this session is working on to another status column of the project board, for example ' +
      'from "Todo" to "In Progress" or to "Human Review" when you hand off. Use a name from status_options of get_issue.',
    inputSchema: { status: z.string().min(1).describe('Target status option name, e.g. "Human Review"') },
    mutates: true,
    transitionTarget: (args) => String(args.status),
    execute: (args, context) =>
      guarded(context, async () => {
        const change = await adapter.setStatus(context.issue, String(args.status), { checkedSha: context.transition?.check?.sha ?? null });
        return ok({
          previous_status: change.previous,
          status: change.status,
          ...(change.autoMerge !== undefined ? { auto_merge: change.autoMerge } : {}),
        });
      }),
  };

  const addComment: AgentToolSpec = {
    name: 'add_comment',
    description:
      'Post a Markdown comment on the GitHub issue this session is working on: a progress note, a summary of ' +
      'the change with the pull request link, or a question that needs a human.',
    inputSchema: { body: z.string().min(1).describe('Comment text (GitHub-flavored Markdown)') },
    mutates: true,
    execute: (args, context) =>
      guarded(context, async () => markerProblem(String(args.body)) ?? ok(await adapter.postComment(context.issue, String(args.body)))),
  };

  const openPullRequest: AgentToolSpec = {
    name: 'open_pull_request',
    description:
      "Open a pull request in the issue's repository from a branch you have already pushed with git. If an open " +
      'pull request for that branch exists, no duplicate is created: with a body, its title and description are replaced ' +
      'by the ones you pass (call it again to refresh the description, e.g. to embed screenshots); without a body it is ' +
      'returned unchanged. Put "Closes #<issue number>" in the body to link it to the issue.' +
      (adapter.settings.baseBranch !== null ? ` Without base, it targets "${adapter.settings.baseBranch}".` : ''),
    inputSchema: {
      head: z.string().min(1).describe('Branch to merge from (already pushed to the repository)'),
      title: z.string().min(1).describe('Pull request title'),
      body: z.string().optional().describe('Pull request description (Markdown)'),
      base: z.string().optional().describe("Branch to merge into; defaults to the configured base branch, else the repository's default branch"),
      draft: z.boolean().optional().describe('Open as a draft pull request'),
    },
    mutates: true,
    execute: (args, context) =>
      guarded(context, async (ref) => {
        const [owner, name] = ref.repository.split('/');
        const head = String(args.head);
        const response = await client.request<Json>(REPOSITORY_QUERY, { owner, name, head });
        assertNoGraphqlErrors(response.errors);
        const repository = obj(obj(response.data)?.repository);
        if (repository === null || typeof repository.id !== 'string') {
          return fail('not_found', `repository ${ref.repository} is not accessible`);
        }
        const existing = nodes(repository.pullRequests)[0];
        if (existing !== undefined) {
          if (typeof args.body !== 'string') {
            return ok({ created: false, updated: false, number: existing.number, url: existing.url, title: existing.title, base: existing.baseRefName });
          }
          const updated = await client.request<Json>(UPDATE_PULL_REQUEST_MUTATION, {
            pullRequestId: existing.id,
            title: String(args.title),
            body: args.body,
          });
          if (updated.errors.length > 0) return fail('github_error', updated.errors.map((e) => e.message).join('; '));
          const pr = obj(obj(obj(updated.data)?.updatePullRequest)?.pullRequest);
          return ok({
            created: false,
            updated: true,
            number: pr?.number ?? existing.number,
            url: pr?.url ?? existing.url,
            title: pr?.title ?? String(args.title),
            base: pr?.baseRefName ?? existing.baseRefName,
          });
        }
        const base =
          typeof args.base === 'string' && args.base !== ''
            ? args.base
            : (adapter.settings.baseBranch ?? obj(repository.defaultBranchRef)?.name);
        if (typeof base !== 'string') return fail('invalid_argument', 'no base branch given and the repository has no default branch');

        const created = await client.request<Json>(CREATE_PULL_REQUEST_MUTATION, {
          repositoryId: repository.id,
          base,
          head,
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : null,
          draft: args.draft === true,
        });
        if (created.errors.length > 0) {
          // Typical causes the agent can fix: branch not pushed, no commits between base and head.
          return fail('github_error', created.errors.map((e) => e.message).join('; '));
        }
        const pr = obj(obj(obj(created.data)?.createPullRequest)?.pullRequest);
        return ok({ created: true, number: pr?.number ?? null, url: pr?.url ?? null, title: pr?.title ?? null, base });
      }),
  };

  /**
   * Creates sub-issues of the session's issue, one at a time per session. The limit and the duplicate check read the
   * issue's current sub-issues from GitHub on every call, so they hold across retries and continuation sessions.
   * With `parent` the issue becomes a sub-issue of one of those sub-issues (an epic): two levels, never deeper. The
   * limit counts the whole tree, so `parent` cannot be used to get around it.
   */
  const subIssueQueue = new SerialQueue();
  const createSubIssue: AgentToolSpec = {
    name: 'create_sub_issue',
    description:
      'Create a sub-issue of the issue this session is working on, in the same repository, and put it on the project ' +
      `board in the column "${adapter.settings.subIssueStatus}" (unless your role names another one; the result's ` +
      'status says where it landed). ' +
      'Pass parent (the number of an open sub-issue you created earlier, e.g. an epic) to create it one level deeper ' +
      'under that sub-issue instead. ' +
      'Pass blocked_by (issue numbers in the same repository) to make it wait for them: this sets GitHub\'s "blocked by" ' +
      'relationship; also write "Blocked by #<number>" in the body. Create the blocking issues first. ' +
      'If an open sub-issue with the same title already exists under the same parent it is returned instead of creating ' +
      'a duplicate (its missing blockers are still set). ' +
      'Labels must already exist in the repository; unknown ones are reported in unknown_labels and skipped.',
    inputSchema: {
      title: z.string().min(1).max(256).describe('Issue title'),
      body: z.string().max(60_000).optional().describe('Issue description (GitHub-flavored Markdown)'),
      labels: z.array(z.string().min(1)).max(10).optional().describe('Names of existing repository labels, e.g. ["bug"]'),
      parent: z.number().int().positive().optional().describe('Number of an open sub-issue of this session\'s issue to create the new issue under'),
      blocked_by: z.array(z.number().int().positive()).max(20).optional().describe('Numbers of issues in the same repository the new issue waits for'),
    },
    mutates: true,
    createsSubIssues: true,
    execute: (args, context) =>
      guarded(context, (ref) =>
        subIssueQueue.run(async (): Promise<ToolResult> => {
          const max = context.maxSubIssues;
          if (max === undefined) return fail('not_allowed', 'this role may not create sub-issues (roles.<name>.max_sub_issues is not set)');
          const rejected = markerProblem(typeof args.body === 'string' ? args.body : undefined) ?? markerProblem(String(args.title));
          if (rejected !== null) return rejected;
          const title = String(args.title).trim();

          const response = await client.request<Json>(SUB_ISSUE_CONTEXT_QUERY, { issueId: ref.issueId });
          assertNoGraphqlErrors(response.errors);
          const root = obj(obj(response.data)?.node);
          const repositoryId = obj(root?.repository)?.id;
          if (typeof repositoryId !== 'string') return fail('not_found', `cannot read repository ${ref.repository} of the issue`);
          const children = nodes(root?.subIssues);
          // The limit counts the whole tree: the open sub-issues and the open sub-issues of those (an epic's issues).
          const used = children.filter(isOpen).length + children.reduce((sum, child) => sum + nodes(child.subIssues).filter(isOpen).length, 0);

          // Where the new issue goes: under the session's issue, or under one of its open sub-issues (`parent`).
          const parentNumber = typeof args.parent === 'number' ? args.parent : null;
          let parentId = ref.issueId;
          let siblings = children;
          if (parentNumber !== null) {
            const epic = children.find((child) => child.number === parentNumber && isOpen(child));
            if (epic === undefined || typeof epic.id !== 'string') {
              return fail(
                'invalid_argument',
                `parent #${parentNumber} is not an open sub-issue of ${ref.repository}#${ref.number}; create it first, without parent`,
              );
            }
            const epicContext = await client.request<Json>(SUB_ISSUE_CONTEXT_QUERY, { issueId: epic.id });
            assertNoGraphqlErrors(epicContext.errors);
            parentId = epic.id;
            siblings = nodes(obj(obj(epicContext.data)?.node)?.subIssues);
          }
          const open = siblings.filter(isOpen);

          const columnName = context.subIssueStatus ?? adapter.settings.subIssueStatus;
          const { option: column, meta } = await adapter.statusOption(columnName);
          const warnings: string[] = [];
          if (column === undefined) {
            warnings.push(
              `board column "${columnName}" does not exist (valid: ${meta.statusOptions.map((o) => `"${o.name}"`).join(', ')}); ` +
                'the sub-issue has no status and is not worked on until a human sets one',
            );
          }

          /** Puts the issue on the board (once) and sets its column; failures after the issue exists are warnings. */
          const placeOnBoard = async (issueId: string, items: Json[]): Promise<boolean> => {
            if (items.some((item) => obj(item.project)?.id === meta.projectId)) return true; // a human may have moved it already
            try {
              const added = await client.request<Json>(ADD_PROJECT_ITEM_MUTATION, { projectId: meta.projectId, contentId: issueId });
              assertNoGraphqlErrors(added.errors);
              const itemId = obj(obj(obj(added.data)?.addProjectV2ItemById)?.item)?.id;
              if (typeof itemId !== 'string') throw new Error('GitHub returned no project item');
              if (column !== undefined) {
                const status = await client.request<Json>(SET_STATUS_MUTATION, {
                  projectId: meta.projectId,
                  itemId,
                  fieldId: meta.statusFieldId,
                  optionId: column.id,
                });
                assertNoGraphqlErrors(status.errors);
              }
              return true;
            } catch (error) {
              warnings.push(`could not put the issue on the board: ${errorMessage(error)}; call create_sub_issue again with the same title to retry`);
              return false;
            }
          };
          /**
           * Sets the "blocked by" relationships of `issue` (GitHub's own, next to the text line in the body). Numbers that
           * are no issue of this repository (a typo, a pull request) are reported, not set. Failures are warnings.
           */
          const requested = Array.isArray(args.blocked_by) ? args.blocked_by.map(Number) : [];
          const linkBlockers = async (issue: Json): Promise<{ linked: number[]; unknown: number[] }> => {
            const linked: number[] = [];
            const unknown: number[] = [];
            try {
              const present = new Set(nodes(issue.blockedBy).map((blocker) => blocker.number));
              const numbers = [...new Set(requested)].filter((number) => number !== issue.number);
              if (numbers.length === 0) return { linked, unknown };
              const { query, variables } = referenceStatesQuery(numbers.map((number) => ({ repository: ref.repository, number })));
              const found = await client.request<Json>(query, variables);
              // Unknown numbers come back as NOT_FOUND with a null entry.
              assertNoGraphqlErrors(found.errors, (error) => error.type === 'NOT_FOUND' && String(error.path?.[0] ?? '').startsWith('ref'));
              for (const [index, number] of numbers.entries()) {
                const target = obj(obj(obj(found.data)?.[`ref${index}`])?.issueOrPullRequest);
                if (target === null || target.__typename !== 'Issue' || typeof target.id !== 'string') {
                  unknown.push(number);
                  continue;
                }
                if (!present.has(number)) {
                  try {
                    const added = await client.request<Json>(ADD_BLOCKED_BY_MUTATION, { issueId: String(issue.id), blockingIssueId: target.id });
                    assertNoGraphqlErrors(added.errors);
                  } catch (error) {
                    warnings.push(`could not set "blocked by #${number}": ${errorMessage(error)}; call create_sub_issue again with the same title to retry`);
                    continue;
                  }
                }
                linked.push(number);
              }
            } catch (error) {
              warnings.push(`could not set the "blocked by" relationships: ${errorMessage(error)}; call create_sub_issue again with the same title to retry`);
            }
            return { linked, unknown };
          };
          /** What `parent` and `blocked_by` add to the result; nothing for a call without them. */
          const relations = async (issue: Json): Promise<Json> => {
            const extra: Json = {};
            if (parentNumber !== null) extra.parent = parentNumber;
            if (requested.length > 0) {
              const { linked, unknown } = await linkBlockers(issue);
              extra.blocked_by = linked;
              extra.unknown_blockers = unknown;
            }
            return extra;
          };
          const result = (created: boolean, issue: Json, onBoard: boolean, unknownLabels: string[], count: number, extra: Json): ToolResult =>
            ok({
              created,
              number: issue.number ?? null,
              identifier: typeof issue.number === 'number' ? `${ref.repository}#${issue.number}` : null,
              url: issue.url ?? null,
              status: column?.name ?? null,
              on_board: onBoard,
              unknown_labels: unknownLabels,
              remaining: Math.max(0, max - count),
              ...extra,
              ...(warnings.length > 0 ? { warnings } : {}),
            });

          const existing = open.find((sub) => titleKey(sub.title) === titleKey(title));
          if (existing !== undefined) {
            const onBoard = await placeOnBoard(String(existing.id), nodes(existing.projectItems));
            return result(false, existing, onBoard, [], used, await relations(existing));
          }
          if (used >= max) {
            return fail('limit_reached', `this issue already has ${used} open sub-issues (limit ${max}); put the rest into the report instead`);
          }

          const unknownLabels: string[] = [];
          const labelIds: string[] = [];
          const wanted = Array.isArray(args.labels) ? [...new Set(args.labels.map(String))] : [];
          if (wanted.length > 0) {
            const { query, variables } = repositoryLabelsQuery(ref.repository, wanted);
            const found = await client.request<Json>(query, variables);
            assertNoGraphqlErrors(found.errors);
            const repository = obj(obj(found.data)?.repository);
            wanted.forEach((label, index) => {
              const id = obj(repository?.[`l${index}`])?.id;
              if (typeof id === 'string') labelIds.push(id);
              else unknownLabels.push(label);
            });
          }

          const created = await client.request<Json>(CREATE_SUB_ISSUE_MUTATION, {
            repositoryId,
            parentId,
            title,
            body: typeof args.body === 'string' ? args.body : null,
            labelIds,
          });
          if (created.errors.length > 0) return fail('github_error', created.errors.map((e) => e.message).join('; '));
          const issue = obj(obj(obj(created.data)?.createIssue)?.issue);
          if (issue === null || typeof issue.id !== 'string') return fail('tracker_response', 'GitHub created no issue');
          const onBoard = await placeOnBoard(issue.id, []);
          return result(true, issue, onBoard, unknownLabels, used + 1, await relations(issue));
        }),
      ),
  };

  return [getIssue, setStatus, addComment, openPullRequest, createSubIssue];
}
