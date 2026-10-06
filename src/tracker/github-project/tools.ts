import { z } from 'zod';
import { SerialQueue } from '../../util/async.ts';
import { errorMessage } from '../../util/errors.ts';
import { TrackerError, type AgentToolContext, type AgentToolSpec, type Issue, type ToolResult } from '../types.ts';
import type { GithubProjectAdapter } from './adapter.ts';
import { assertNoGraphqlErrors } from './client.ts';
import type { ProjectMeta, SelectOption } from './normalize.ts';
import {
  ADD_COMMENT_MUTATION,
  ADD_PROJECT_ITEM_MUTATION,
  CREATE_PULL_REQUEST_MUTATION,
  CREATE_SUB_ISSUE_MUTATION,
  ISSUE_CONTEXT_QUERY,
  REPOSITORY_QUERY,
  SET_STATUS_MUTATION,
  SUB_ISSUE_CONTEXT_QUERY,
  repositoryLabelsQuery,
} from './queries.ts';
import { KIND } from './settings.ts';

type Json = Record<string, unknown>;

interface IssueRef {
  itemId: string;
  issueId: string;
  repository: string;
  number: number;
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

/** Tools only ever act on the issue the session was started for. */
function issueRef(context: AgentToolContext): IssueRef | null {
  const ref = context.issue.native_ref;
  if (ref === null || ref.provider !== KIND) return null;
  const { item_id: itemId, issue_id: issueId, repository, number } = ref;
  if (typeof itemId !== 'string' || typeof issueId !== 'string' || typeof repository !== 'string' || typeof number !== 'number') {
    return null;
  }
  return { itemId, issueId, repository, number };
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

function findOption(meta: ProjectMeta, name: string): SelectOption | undefined {
  const wanted = name.trim().toLowerCase();
  return meta.statusOptions.find((option) => option.name.trim().toLowerCase() === wanted);
}

/** Titles are compared without case and with collapsed whitespace, so a retry with a re-typed title finds its sub-issue. */
function titleKey(title: unknown): string {
  return String(title ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Runs a tool body, turning any exception into a structured failure the agent can read. */
async function guarded(context: AgentToolContext, body: (ref: IssueRef) => Promise<ToolResult>): Promise<ToolResult> {
  const ref = issueRef(context);
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
      'assignee, blockers, the status options you can move it to, the latest 20 comments and linked pull requests. Read-only.',
    inputSchema: {},
    mutates: false,
    execute: (_args, context) =>
      guarded(context, async (ref) => {
        const [fresh] = await adapter.fetchIssuesByIds([context.issue.id]);
        if (fresh === undefined) return fail('not_found', 'the issue is no longer visible on the project board');
        const meta = await adapter.meta();
        const response = await client.request<Json>(ISSUE_CONTEXT_QUERY, { issueId: ref.issueId });
        assertNoGraphqlErrors(response.errors);
        const node = obj(obj(response.data)?.node);
        return ok({
          issue: issueView(fresh),
          status_options: meta.statusOptions.map((option) => option.name),
          comments: nodes(node?.comments).map((c) => ({
            author: obj(c.author)?.login ?? null,
            created_at: c.createdAt ?? null,
            url: c.url ?? null,
            body: c.body ?? '',
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
      guarded(context, async (ref) => {
        const status = String(args.status);
        let meta = await adapter.meta();
        let option = findOption(meta, status);
        if (option === undefined) {
          meta = await adapter.meta(true);
          option = findOption(meta, status);
        }
        if (option === undefined) {
          const valid = meta.statusOptions.map((o) => `"${o.name}"`).join(', ');
          return fail('invalid_argument', `unknown status "${status}"; valid options: ${valid}`);
        }
        const response = await client.request<Json>(SET_STATUS_MUTATION, {
          projectId: meta.projectId,
          itemId: ref.itemId,
          fieldId: meta.statusFieldId,
          optionId: option.id,
        });
        assertNoGraphqlErrors(response.errors);
        return ok({ previous_status: context.issue.state, status: option.name });
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
      guarded(context, async (ref) => {
        const response = await client.request<Json>(ADD_COMMENT_MUTATION, { subjectId: ref.issueId, body: String(args.body) });
        assertNoGraphqlErrors(response.errors);
        const url = obj(obj(obj(obj(response.data)?.addComment)?.commentEdge)?.node)?.url ?? null;
        return ok({ url });
      }),
  };

  const openPullRequest: AgentToolSpec = {
    name: 'open_pull_request',
    description:
      "Open a pull request in the issue's repository from a branch you have already pushed with git. If an open " +
      'pull request for that branch exists, it is returned instead of creating a duplicate. Put "Closes #<issue number>" ' +
      'in the body to link it to the issue.',
    inputSchema: {
      head: z.string().min(1).describe('Branch to merge from (already pushed to the repository)'),
      title: z.string().min(1).describe('Pull request title'),
      body: z.string().optional().describe('Pull request description (Markdown)'),
      base: z.string().optional().describe("Branch to merge into; defaults to the repository's default branch"),
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
          return ok({ created: false, number: existing.number, url: existing.url, title: existing.title, base: existing.baseRefName });
        }
        const base = typeof args.base === 'string' && args.base !== '' ? args.base : obj(repository.defaultBranchRef)?.name;
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
   */
  const subIssueQueue = new SerialQueue();
  const createSubIssue: AgentToolSpec = {
    name: 'create_sub_issue',
    description:
      'Create a sub-issue of the issue this session is working on, in the same repository, and put it on the project ' +
      `board in the column "${adapter.settings.subIssueStatus}", where a human decides whether it gets worked on. ` +
      'Refer to an earlier sub-issue with "Blocked by #<number>" in the body to make one wait for another. ' +
      'If an open sub-issue with the same title already exists it is returned instead of creating a duplicate. ' +
      'Labels must already exist in the repository; unknown ones are reported in unknown_labels and skipped.',
    inputSchema: {
      title: z.string().min(1).max(256).describe('Issue title'),
      body: z.string().max(60_000).optional().describe('Issue description (GitHub-flavored Markdown)'),
      labels: z.array(z.string().min(1)).max(10).optional().describe('Names of existing repository labels, e.g. ["bug"]'),
    },
    mutates: true,
    createsSubIssues: true,
    execute: (args, context) =>
      guarded(context, (ref) =>
        subIssueQueue.run(async (): Promise<ToolResult> => {
          const max = context.maxSubIssues;
          if (max === undefined) return fail('not_allowed', 'this role may not create sub-issues (roles.<name>.max_sub_issues is not set)');
          const title = String(args.title).trim();

          const response = await client.request<Json>(SUB_ISSUE_CONTEXT_QUERY, { issueId: ref.issueId });
          assertNoGraphqlErrors(response.errors);
          const parent = obj(obj(response.data)?.node);
          const repositoryId = obj(parent?.repository)?.id;
          if (typeof repositoryId !== 'string') return fail('not_found', `cannot read repository ${ref.repository} of the issue`);
          const open = nodes(parent?.subIssues).filter((sub) => sub.state !== 'CLOSED');

          let meta = await adapter.meta();
          let column = findOption(meta, adapter.settings.subIssueStatus);
          if (column === undefined) {
            meta = await adapter.meta(true);
            column = findOption(meta, adapter.settings.subIssueStatus);
          }
          const warnings: string[] = [];
          if (column === undefined) {
            warnings.push(
              `board column "${adapter.settings.subIssueStatus}" does not exist (valid: ${meta.statusOptions.map((o) => `"${o.name}"`).join(', ')}); ` +
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
          const result = (created: boolean, issue: Json, onBoard: boolean, unknownLabels: string[], used: number): ToolResult =>
            ok({
              created,
              number: issue.number ?? null,
              identifier: typeof issue.number === 'number' ? `${ref.repository}#${issue.number}` : null,
              url: issue.url ?? null,
              status: column?.name ?? null,
              on_board: onBoard,
              unknown_labels: unknownLabels,
              remaining: Math.max(0, max - used),
              ...(warnings.length > 0 ? { warnings } : {}),
            });

          const existing = open.find((sub) => titleKey(sub.title) === titleKey(title));
          if (existing !== undefined) {
            const onBoard = await placeOnBoard(String(existing.id), nodes(obj(existing.projectItems)));
            return result(false, existing, onBoard, [], open.length);
          }
          if (open.length >= max) {
            return fail('limit_reached', `this issue already has ${open.length} open sub-issues (limit ${max}); put the rest into the report instead`);
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
            parentId: ref.issueId,
            title,
            body: typeof args.body === 'string' ? args.body : null,
            labelIds,
          });
          if (created.errors.length > 0) return fail('github_error', created.errors.map((e) => e.message).join('; '));
          const issue = obj(obj(obj(created.data)?.createIssue)?.issue);
          if (issue === null || typeof issue.id !== 'string') return fail('tracker_response', 'GitHub created no issue');
          const onBoard = await placeOnBoard(issue.id, []);
          return result(true, issue, onBoard, unknownLabels, open.length + 1);
        }),
      ),
  };

  return [getIssue, setStatus, addComment, openPullRequest, createSubIssue];
}
