import type { z } from 'zod';
import type { Logger } from '../log.ts';
import type { ResultChecks, ResultMeta, StageResult } from '../workflow/results.ts';
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
  | 'tracker_rate_limited'
  | 'invalid_argument';

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
  /** Set by the transition guard (`guardTools`) for a call it allowed; absent for every other call. */
  transition?: AllowedTransition;
}

/** A move the transition guard allowed for one tool call. */
export interface AllowedTransition {
  /** The column the guard checked (`transitionTarget` of the call). */
  target: string;
  /** The entry check that cleared the move (run for this call or a cached pass); null when none applied. */
  check: ResultChecks | null;
  /**
   * Set when the entry check for the move the call asked for failed and the guard used the tool's
   * `checkFailedTarget` instead: `target` above is then that fallback column, and this is the move that failed.
   */
  checkFailed?: { target: string; output: string; check: ResultChecks };
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
  /**
   * For tools with `transitionTarget`: the column to move to instead when the entry check for that target fails
   * (`check_failed` only), or null for none. The guard checks that column like any other move, and the tool learns of
   * the substitution in `context.transition.checkFailed`.
   */
  checkFailedTarget?(args: Record<string, unknown>): string | null;
  /**
   * For tools with `transitionTarget`: a refusal that must come before the entry check of the target column, so the agent
   * does not wait for a check that cannot lead to a recorded result. Runs for a call with a target, after the input was
   * accepted; a non-null result goes back to the agent as it is, and neither the guard nor `execute` run.
   */
  precheck?(args: Record<string, unknown>, context: AgentToolContext): Promise<ToolResult | null>;
  execute(args: Record<string, unknown>, context: AgentToolContext): Promise<ToolResult>;
}

/** A comment on an issue. */
/** A stage result read back from a comment Symphony wrote. */
export interface TrackedResult {
  result: StageResult;
  meta: ResultMeta;
  createdAt: Date;
  url: string;
}

export interface IssueComment {
  /** Login of the author; null when the account was deleted. */
  author: string | null;
  createdAt: Date;
  body: string;
  url: string;
}

/** A comment Symphony posted. */
export interface PostedComment {
  url: string | null;
}

/** What `auto_merge` did when the issue entered its trigger column. */
export interface AutoMergeResult {
  merged: boolean;
  pull_request: number | null;
  /** Column the issue is in afterwards. */
  status: string;
  reason: string;
  warnings?: string[];
}

/** Outcome of moving an issue to another column. */
export interface StatusChange {
  /** The column in the `issue` snapshot the caller passed in, not a fresh read. */
  previous: string;
  /** Column the issue is in afterwards: the requested one, or the one `auto_merge` moved it to. */
  status: string;
  /** Present when entering the column triggered `auto_merge`. */
  autoMerge?: AutoMergeResult;
}

export interface AddLabelsResult {
  /** Labels now on the issue, as the tracker spells them (existing ones and the created ones). */
  added: string[];
  /** The part of `added` that did not exist and was created. */
  created: string[];
  /** Labels that do not exist and were not created (`create` off, or not a label family the adapter may create). */
  unknown: string[];
}

export interface RemoveLabelsResult {
  /** Existing labels detached from the issue (a label the issue did not carry is a no-op). */
  removed: string[];
  /** Labels that do not exist, so there was nothing to remove. */
  unknown: string[];
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
  /** Every comment of the issue with its author, oldest first, however many pages the tracker needs. */
  readComments?(issue: Issue): Promise<IssueComment[]>;
  /**
   * Stage results decoded from the issue's comments, oldest first. Only comments written by the adapter's own account
   * (`viewerLogin()`) count; markers in all others are ignored and logged.
   */
  readResults?(issue: Issue): Promise<TrackedResult[]>;
  /** Login of the account the adapter's credential acts as; fetched once per adapter. */
  viewerLogin?(): Promise<string>;
  /** Posts a Markdown comment on the issue and returns its URL. */
  postComment?(issue: Issue, body: string): Promise<PostedComment>;
  /**
   * Moves the issue to a column (matched case-insensitively), the same operation as the `set_status` tool, including
   * `auto_merge`. Throws `invalid_argument` for a column the board does not have.
   */
  setStatus?(issue: Issue, column: string): Promise<StatusChange>;
  /**
   * Adds labels to the issue. Labels that do not exist are reported in `unknown`; with `create` the missing ones of the
   * families `Type: …`, `Complexity: …` and `needs-human` are created first (other names are never created).
   */
  addLabels?(issue: Issue, names: string[], options?: { create?: boolean }): Promise<AddLabelsResult>;
  removeLabels?(issue: Issue, names: string[]): Promise<RemoveLabelsResult>;
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
