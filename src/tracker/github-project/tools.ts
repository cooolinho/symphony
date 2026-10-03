import { z } from 'zod';
import { errorMessage } from '../../util/errors.ts';
import { TrackerError, type AgentToolContext, type AgentToolSpec, type Issue, type ToolResult } from '../types.ts';
import type { GithubProjectAdapter } from './adapter.ts';
import { assertNoGraphqlErrors } from './client.ts';
import type { ProjectMeta, SelectOption } from './normalize.ts';
import {
  ADD_COMMENT_MUTATION,
  CREATE_PULL_REQUEST_MUTATION,
  ISSUE_CONTEXT_QUERY,
  REPOSITORY_QUERY,
  SET_STATUS_MUTATION,
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

  return [getIssue, setStatus, addComment, openPullRequest];
}
