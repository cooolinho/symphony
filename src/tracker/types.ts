import type { z } from 'zod';
import type { Logger } from '../log.ts';
import { SymphonyError } from '../util/errors.ts';

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

/** Normalized schedulable work item (spec 4.1.1). Field names follow the spec and templates. */
export interface Issue {
  /** Opaque dispatch identity (for GitHub Projects: the project item node id). */
  id: string;
  native_ref: Record<string, unknown> | null;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  assignee_id: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  dispatchable: boolean;
  created_at: Date | null;
  updated_at: Date | null;
}

export type TrackerErrorCategory =
  | 'unsupported_tracker_kind'
  | 'invalid_tracker_config'
  | 'missing_tracker_secret'
  | 'tracker_request'
  | 'tracker_status'
  | 'tracker_response'
  | 'tracker_pagination'
  | 'tracker_rate_limited';

/** Adapter failure; `code` is the portable category, `message` is human-readable. */
export class TrackerError extends SymphonyError {
  readonly category: TrackerErrorCategory;
  readonly retryAfterMs: number | null;
  readonly status: number | null;

  constructor(
    category: TrackerErrorCategory,
    message: string,
    details: { retryAfterMs?: number | null; status?: number | null; cause?: unknown } = {},
  ) {
    super(category, message, { cause: details.cause });
    this.name = 'TrackerError';
    this.category = category;
    this.retryAfterMs = details.retryAfterMs ?? null;
    this.status = details.status ?? null;
  }
}

/** Execution context for provider-native tools: the current issue, never the credential. */
export interface AgentToolContext {
  issue: Issue;
  /** Open sub-issues the session's role may have under its issue at once; absent = the role may create none. */
  maxSubIssues?: number;
  /** Board column for the sub-issues the role creates (`roles.<name>.sub_issue_status`); absent = the adapter's own. */
  subIssueStatus?: string;
}

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { category: string; message: string } };

/** A provider-native tool advertised to the agent and executed host-side by the adapter. */
export interface AgentToolSpec {
  name: string;
  description: string;
  /** Zod raw shape describing the tool input. */
  inputSchema: z.ZodRawShape;
  /** Whether the tool can change tracker state (documented in the adapter profile). */
  mutates: boolean;
  /** The tool creates sub-issues; only roles with `max_sub_issues` get it (see `toolsForRole`). */
  createsSubIssues?: boolean;
  /**
   * For tools that move the issue to another column: the target column named by `args`, or null when the call does
   * not change the column. Symphony's transition guard checks such calls before `execute` runs.
   */
  transitionTarget?(args: Record<string, unknown>): string | null;
  execute(args: Record<string, unknown>, context: AgentToolContext): Promise<ToolResult>;
}

/** The read kernel the orchestrator needs (spec 11.1), plus optional agent tools (spec 10.5). */
export interface TrackerAdapter {
  readonly kind: string;
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  fetchIssuesByIds(issueIds: string[]): Promise<Issue[]>;
  agentToolSpecs(): AgentToolSpec[];
  /** Extra non-secret variables for workspace hooks (e.g. which repository to clone). */
  hookEnvironment?(issue: Issue): Record<string, string>;
  /** Names of the board's status columns, for the preflight check of the configured columns. */
  statusOptions?(): Promise<string[]>;
  /** Repository the issue belongs to (`owner/name`), used to group the run history. */
  issueRepository?(issue: Issue): string | null;
  /** Identifiers of the issue's open sub-issues, for roles with `wait_for_sub_issues`; absent = the tracker has none. */
  openSubIssues?(issue: Issue): string[];
  /** Posts a Markdown comment on the issue, for notices from Symphony itself (e.g. a spent cost budget). */
  commentOnIssue?(issue: Issue, body: string): Promise<void>;
}

export interface TrackerAdapterParams {
  provider: Record<string, unknown>;
  activeStates: string[];
  terminalStates: string[];
  env: NodeJS.ProcessEnv;
  logger: Logger;
  fetch?: typeof fetch;
}

export interface TrackerAdapterFactory {
  readonly kind: string;
  /** Documented defaults used when active/terminal states are omitted. */
  readonly defaultActiveStates: string[];
  readonly defaultTerminalStates: string[];
  /** Validates provider config after `$VAR` resolution; returns problems (empty when valid). */
  validate(provider: Record<string, unknown>, env: NodeJS.ProcessEnv): string[];
  /** Environment variables holding tracker credentials, removed from agent and hook processes. */
  secretEnvironmentNames(provider: Record<string, unknown>): string[];
  create(params: TrackerAdapterParams): TrackerAdapter;
}
