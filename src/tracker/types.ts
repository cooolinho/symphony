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
  /** Role name of the session. */
  role?: string;
  /** Run id; absent outside a run. */
  runId?: string;
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
  | { ok: false; error: { category: string; message: string; /** Structured data for the agent, e.g. the current version of a note. */ details?: unknown } };

/** A provider-native tool advertised to the agent and executed host-side by the adapter. */
export interface AgentToolSpec {
  name: string;
  description: string;
  /** Zod raw shape describing the tool input. */
  inputSchema: z.ZodRawShape;
  /** Whether the tool can change tracker state (documented in the adapter profile). */
  mutates: boolean;
  /**
   * The tool creates sub-issues; only roles with `max_sub_issues` get it, a role that reports a design only on an issue
   * it may split (see `toolsForRole`).
   */
  createsSubIssues?: boolean;
  /**
   * For tools that move the issue to another column: the target column named by `args`, or null when the call does
   * not change the column. Symphony's transition guard checks such calls before `execute` runs. May be asynchronous when
   * the target depends on something the tool has to look up (the files a branch changes).
   */
  transitionTarget?(args: Record<string, unknown>): string | null | Promise<string | null>;
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
  /** The pull request's checks are still running: the issue waits in its column and the merge is retried. */
  awaiting_checks?: boolean;
  /** The checks of the pull request's head commit, when the merge gate read them. */
  checks?: AutoMergeChecks;
  warnings?: string[];
}

/** What the merge gate saw on the pull request's head commit. */
export interface AutoMergeChecks {
  state: 'none' | 'success' | 'pending' | 'failure';
  failing: Array<{ name: string; state: string; url: string | null }>;
  pending: string[];
}

/** The open pull request from the issue's branch and the state of its head commit's checks. */
export interface BranchPullRequest {
  number: number;
  url: string | null;
  base: string | null;
  head_sha: string | null;
  checks: AutoMergeChecks;
}

/** A named entry check's state, posted on the commit it ran on (GitHub: commit status `symphony/<name>`). */
export interface CheckStatus {
  name: string;
  sha: string;
  state: 'pending' | 'success' | 'failure' | 'error';
  description: string;
  /** Where the details are (Symphony's agent page); null = no link. */
  targetUrl: string | null;
}

/** Options of a move through `setStatus`. */
export interface SetStatusOptions {
  /** Commit the entry checks of the target column ran on; `auto_merge` merges nothing else. */
  checkedSha?: string | null;
}

/**
 * Issues waiting in the `auto_merge` column for pending pull request checks. The orchestrator fetches `column` with
 * the board and calls `retry` for every issue `awaiting` returns true for, one call per issue at a time.
 */
export interface MergeWatch {
  column: string;
  awaiting(issue: Issue): boolean;
  retry(issue: Issue): Promise<AutoMergeResult>;
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

/** A file uploaded to an issue's description or one of its comments, downloaded for the agent to open. */
export interface IssueAttachment {
  /** Alt text of the image or text of the file link; '' when it has none. */
  label: string;
  /** Where it appears: "description", or the URL of the comment. */
  source: string;
  /** File extension without the dot (from the content type, else the URL); '' when the download failed. */
  extension: string;
  /** The file's content; null when the download failed. */
  data: Uint8Array | null;
  /** Why the download failed; null when it succeeded. */
  error: string | null;
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
  /**
   * True when the issue is not dispatchable only because of its open sub-issues (the GitHub adapter's
   * `respect_sub_issues`). A running session of a role that creates sub-issues (`max_sub_issues`) goes on then, so the
   * work packages an architect files do not stop it before it reports; absent = sub-issues never hold an issue back.
   */
  heldBySubIssues?(issue: Issue): boolean;
  /** Posts a Markdown comment on the issue, for notices from Symphony itself (e.g. a spent cost budget). */
  commentOnIssue?(issue: Issue, body: string): Promise<void>;
  /** Every comment of the issue with its author, oldest first, however many pages the tracker needs. */
  readComments?(issue: Issue): Promise<IssueComment[]>;
  /**
   * The files uploaded to the issue's description and comments (images, PDFs, other files), downloaded in order of
   * appearance. A file that could not be downloaded is listed with `error`; only reading the issue itself throws.
   */
  issueAttachments?(issue: Issue): Promise<IssueAttachment[]>;
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
  setStatus?(issue: Issue, column: string, options?: SetStatusOptions): Promise<StatusChange>;
  /** Reports an entry check's state on the commit it ran on, in the issue's repository (`checks.report_status`). */
  reportCheckStatus?(issue: Issue, status: CheckStatus): Promise<void>;
  /** Issues waiting for pending pull request checks before `auto_merge`; null or absent when nothing waits. */
  mergeWatch?(): MergeWatch | null;
  /** The open pull request from the issue's branch with its checks; null without one, or when the tracker cannot say. Never throws. */
  branchPullRequest?(issue: Issue): Promise<BranchPullRequest | null>;
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
