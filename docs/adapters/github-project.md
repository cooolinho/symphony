# Adapter profile: `github_project`

Reads work from a **GitHub Projects (v2)** board. The board's single-select status field (default `Status`) is the
issue state, so the board columns drive the workflow.

## Configuration (`tracker.provider`)

Every key accepts a whole-value `$NAME` reference; an unset or empty variable counts as omitted.

| Key | Default | Description |
|---|---|---|
| `project_number` | (required) | The board number from `https://github.com/users/<owner>/projects/<number>`, or that full URL (`/orgs/<org>/…` works too). A URL also sets `owner`. |
| `owner` | owner from the URL, else the owner of the first entry in `repositories` | User or organization that owns the board. |
| `repositories` | all repositories on the board | `owner/name` entries, as a list or a comma/space separated string. Issues from other repositories are invisible to Symphony. |
| `token` | `$GITHUB_TOKEN`, then `$GH_TOKEN` | **Secret.** Classic token with the `repo` and `project` scopes (`read:project` is enough for read-only use, but the agent tools need `project`). A literal value works but is discouraged. |
| `status_field` | `Status` | Name of the single-select field used as state. |
| `priority_field` | none | Single-select field (first option = priority 1) or number field used for dispatch order. |
| `assignee` | none | Only issues assigned to this login are dispatchable. |
| `respect_blockers` | `true` | Issues with an unresolved dependency are not dispatchable: a GitHub "blocked by" relationship, or a reference in the issue text such as `blocked by #12` (see Dependencies). |
| `respect_sub_issues` | `true` | Parent issues wait until all their sub-issues are closed. Exception: an issue whose description starts with a `/command` (see [issue commands](../configuration.md#issue-commands)) never waits for its sub-issues, because they are the result of its run. |
| `sub_issue_status` | `Backlog` | Board column for sub-issues created by the `create_sub_issue` tool. Must not be an active or terminal state (`invalid_tracker_config`), so a human decides what gets worked on. A [role](../configuration.md#roles) can override it with its own `sub_issue_status`, which may be active. |
| `base_branch` | none (the repository's default branch) | Branch agents branch from and open pull requests against, e.g. `develop`. Hooks get it as `SYMPHONY_BASE_BRANCH` (the shipped `after_create` clones it), the prompt as `issue.native_ref.base_branch`, and `open_pull_request` uses it when the agent names no `base`. |
| `auto_merge` | off | Map; Symphony merges an issue's pull request when the issue enters a column. See [Auto-merge](#auto-merge). |
| `endpoint` | `https://api.github.com/graphql` | GraphQL endpoint (GitHub Enterprise Server). |
| `request_timeout_ms` | `30000` | Per-request timeout. |
| `request_retries` | `2` | Extra attempts for read queries after network errors, timeouts and HTTP 502/503/504 (waiting 1 s, 2 s, …). Mutations (status, comments, pull requests) are never retried automatically, so nothing is created twice; the agent gets the error and can retry. |

Defaults when the workflow omits them: `active_states: [Todo, In Progress]`, `terminal_states: [Done]`.

**Secret handling:** `GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GH_ENTERPRISE_TOKEN` and the variable
named in `token` are removed from the environment of agents and hooks. The agent changes the issue only through the
tools below, which run inside Symphony. Pushing branches uses your normal git credentials (SSH).

**Validation errors:** missing `project_number` or `owner`, malformed `repositories`, non-URL `endpoint`, an invalid
`auto_merge` → `invalid_tracker_config`; no token → `missing_tracker_secret`. On first use the adapter also checks that the board
exists and that the status field is a single-select field (`invalid_tracker_config` otherwise).

## Reading the board

- **Candidates** (`fetch_issues_by_states`): one cheap pass over the board, 100 items per page, archived items
  excluded server-side. Matching items are then loaded in detail, 50 per request. Board order is preserved.
- **Refresh** (`fetch_issues_by_ids`): items are loaded in detail by id, 50 per request.
- **Scope:** only items whose content is an **issue** (no draft issues, no pull requests), from a repository in
  `repositories`, on this board, not archived, and readable with the token. Everything else is treated as invisible:
  skipped while polling, omitted from refresh results.
- **Malformed records** (an issue without number or title): skipped with a warning while polling; a refresh that
  asked for one fails, because omission would mean "no longer visible".
- **Limits:** at most 500 pages (50,000 items) per poll. Each poll costs a few GraphQL rate-limit points.

## Status options

`statusOptions()` returns the names of the board's `Status` single-select options (from the cached project
metadata, no extra request). The orchestrator uses it to check that every configured column exists on the board;
see the board preflight in [configuration.md](../configuration.md#tracker).

## Normalization

| Issue field | Source |
|---|---|
| `id` | Project item node id (`PVTI_…`): the dispatch identity |
| `identifier` | `owner/repo#number` |
| `title`, `description`, `url` | Issue title, body (`null` if empty), URL |
| `state` | Status option name as written on the board; `No Status` when unset |
| `priority` | From `priority_field` (option position + 1, or an integer number value), else `null` |
| `labels` | Lowercased, trimmed, de-duplicated |
| `assignee_id` | Login of the first assignee |
| `blocked_by` | Dependencies: "blocked by" relationships plus references in the issue text, as `{id, identifier, state}` (`OPEN`, `CLOSED`, or `MERGED` for pull requests) |
| `branch_name` | First branch linked to the issue ("Create a branch" in the issue sidebar), else `null` |
| `dispatchable` | Issue is open, matches `assignee` (if set), has no unresolved dependency (if `respect_blockers`) and no open sub-issue (if `respect_sub_issues`) |
| `created_at`, `updated_at` | Issue timestamps |
| `native_ref` | `{provider, project_id, item_id, issue_id, repository, number, issue_state, status_option_id, parent, sub_issues, base_branch, dispatch_note}`: `parent` and each sub-issue are `{identifier, title, state}`, a closed sub-issue also has `state_reason` (`COMPLETED`, `NOT_PLANNED`, `DUPLICATE`); all sub-issues are read (GitHub allows 100); `base_branch` is the configured `base_branch` or `null`; `dispatch_note` says why an issue is not dispatchable (shown by `--dry-run`) |

### Dependencies

An issue waits while any of these is unresolved:

1. **Relationships:** issues set under *Relationships → Blocked by* in the GitHub issue sidebar.
2. **Text references** in the issue description: `blocked by #12`, `blocked #12`, `Blocked by: #12, #13 and owner/repo#7`,
   also with Markdown emphasis (`**blocked by** #12`). Matching is case-insensitive; `#N` means the issue's own
   repository; references may point to issues or pull requests. Words like `unblocked` do not match, and negations
   (`not blocked by #12`) are not understood.
3. **Sub-issues** of a parent issue: the parent waits until every sub-issue is closed (not for an issue that starts
   with a `/command`, see `respect_sub_issues`).

Text references are resolved with one extra request per poll (`issueOrPullRequest`, 50 per request). A dependency
is resolved when the issue is closed or the pull request is closed or merged. References that do not exist or are not
readable are ignored, so a typo does not block an issue forever. In the Symphony workflow agents never close issues:
a dependency resolves when its pull request with `Closes #N` is merged.

A **closed** issue whose status is still active is reported as not dispatchable: a running agent is stopped, but
the workspace is only deleted once the issue reaches a terminal status.

Hooks additionally receive `SYMPHONY_ISSUE_REPOSITORY` and `SYMPHONY_ISSUE_NUMBER`, and `SYMPHONY_BASE_BRANCH` when
`base_branch` is set. For roles with `wait_for_sub_issues`, the adapter reports the open sub-issues
(`openSubIssues`); see [Waves](../configuration.md#waves-wait_for_sub_issues).

## Agent tools

Exposed to Claude Code as `mcp__tracker__<name>`. They act on the session's own issue and repository; the only issues
they create are sub-issues of that issue (`create_sub_issue`).

| Tool | Input | Mutates | Result |
|---|---|---|---|
| `get_issue` | none | no | Issue fields, valid status options, the latest 20 comments, linked pull requests |
| `set_status` | `status` | yes | Moves the board item; the name is matched case-insensitively. An unknown name returns the valid options. Guarded: see below. Entering `auto_merge.on_enter` triggers the [auto-merge](#auto-merge); the result then carries `auto_merge` and the final `status`. |
| `add_comment` | `body` | yes | Posts a comment on the issue; returns its URL |
| `open_pull_request` | `head`, `title`, `body?`, `base?`, `draft?` | yes | Opens a PR from an already pushed branch (base defaults to `base_branch`, else the default branch). An open PR for the same branch is returned instead of a duplicate (`created: false`). |
| `create_sub_issue` | `title`, `body?`, `labels?` | yes | Creates a sub-issue of the session's issue in the same repository, adds it to the board in the `sub_issue_status` column (the role's, else the provider's) and returns `{created, number, identifier, url, status, on_board, unknown_labels, remaining, warnings?}`. Only offered to [roles](../configuration.md#roles) with `max_sub_issues`. See below. |

`set_status` declares its target column (`transitionTarget`), so Symphony's
[transition guard](../configuration.md#transition-guard) checks every call before the mutation is sent: terminal
columns and columns outside the role's `may_move_to` are denied (`transition_denied`), and a gated column is entered
only after its entry check passes (`check_failed` / `check_error` otherwise). A denied call sends no request to GitHub.

**`create_sub_issue`.** One `createIssue` mutation creates the issue and links it to its parent (`parentIssueId`); then
the issue is added to the board and its status is set to `sub_issue_status`. The tool is built to survive retries:

- Calls of one session run one after the other. An **open sub-issue with the same title** (compared without case and
  with collapsed whitespace) is returned with `created: false` instead of a duplicate; if it is not on the board
  (a previous call failed half-way), it is added. A sub-issue that is already on the board keeps its column.
- The limit comes from GitHub, not from a counter: with `max_sub_issues` open sub-issues the call fails with
  `limit_reached`. Closed sub-issues do not count, so the limit holds across retries and continuation sessions.
- `labels` must already exist in the repository. Unknown ones are skipped and reported in `unknown_labels`; labels are
  never created.
- Once the issue exists, failures of the board steps (no access to the project, the column is missing on the board)
  are returned as `warnings` and the call still succeeds. Without a status the board item is inactive. Call the tool
  again with the same title to retry.
- A project workflow such as "Item added to project" can set its own status after the tool did; configure it to match
  `sub_issue_status` or turn it off.
- Errors: `not_allowed` (the role has no `max_sub_issues`), `limit_reached`, `github_error` (GitHub rejected the
  mutation, e.g. missing permission), `not_found`.

Failures come back to the agent as structured tool errors (`{error: {category, message}}`), so it can correct its
input. Keep GitHub's secondary rate limits in mind: content-creating calls such as comments are limited to roughly
80 per minute per token.

## Auto-merge

```yaml
tracker:
  provider:
    base_branch: develop
    auto_merge:
      enabled: true            # or $SYMPHONY_AUTO_MERGE; anything but true (or unset) turns it off
      on_enter: In review      # required: the column whose successful set_status triggers the merge
      done_state: Done         # default: the first terminal state
      on_conflict: In progress # default: none (stay in on_enter)
      method: squash           # squash | merge | rebase
      opt_out_label: manual-merge
```

When an agent's `set_status` moves an issue into `on_enter`, after the [transition guard](../configuration.md#transition-guard)
let it through (so its entry checks passed), Symphony:

1. looks up the open pull request from the issue's branch (the linked branch, else `symphony/issue-<number>`) into
   `base_branch`;
2. does nothing when there is no such pull request (for example when the auditor or the planner hands off its
   issue), and refuses, leaving the issue in `on_enter` with a comment, when `base_branch` is the repository's default
   branch, the pull request is a draft, or the pull request or the issue has the `opt_out_label`;
3. merges it with `mergePullRequest` and `expectedHeadOid` (only the head it read, never a newer push);
4. closes the issue (`closeIssue`, reason `COMPLETED`): GitHub ignores `Closes #N` for merges into a branch other than
   the default branch;
5. moves the issue to `done_state`, so the orchestrator stops tracking it and deletes its workspace, and comments with
   the pull request link.

A pull request that conflicts with `base_branch` (reported as `CONFLICTING`, or refused by GitHub as not mergeable)
moves the issue to `on_conflict` with a comment asking to integrate the base branch; without `on_conflict` it stays
for a human. Once the pull request is merged, a failure to close, move or comment is only reported as a warning.

Validation: `auto_merge` needs `base_branch` and `on_enter`; `on_enter` must not be an active or terminal state (it
is entered after the agents are done), `done_state` must be terminal and `on_conflict` must not be.
`auto_merge` never merges into the default branch: what reaches it stays a human decision, e.g. through a release
pull request from `base_branch`.

## Errors

| Category | Cause |
|---|---|
| `tracker_request` | Network failure or timeout (after the configured retries for queries) |
| `tracker_status` | HTTP error status (401: bad token), or a token without the needed scopes (`gh auth refresh -s project`) |
| `tracker_rate_limited` | HTTP 429, 403 with exhausted rate limit, or GraphQL `RATE_LIMITED`; carries `retryAfterMs` when GitHub sends one |
| `tracker_response` | Non-JSON body, GraphQL errors, unexpected payload, malformed requested item |
| `tracker_pagination` | GitHub reported more pages without a new cursor, or more than 500 pages |
| `invalid_tracker_config` / `missing_tracker_secret` | See Configuration |

Errors are `TrackerError` instances: `category` (also `code`), a human-readable `message`, optional `retryAfterMs`
and HTTP `status`. The orchestrator only distinguishes success from failure: a failed poll skips that tick, a failed
refresh keeps running agents.
