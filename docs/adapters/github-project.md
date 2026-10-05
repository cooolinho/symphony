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
| `respect_sub_issues` | `true` | Parent issues wait until all their sub-issues are closed. |
| `endpoint` | `https://api.github.com/graphql` | GraphQL endpoint (GitHub Enterprise Server). |
| `request_timeout_ms` | `30000` | Per-request timeout. |
| `request_retries` | `2` | Extra attempts for read queries after network errors, timeouts and HTTP 502/503/504 (waiting 1 s, 2 s, …). Mutations (status, comments, pull requests) are never retried automatically, so nothing is created twice; the agent gets the error and can retry. |

Defaults when the workflow omits them: `active_states: [Todo, In Progress]`, `terminal_states: [Done]`.

**Secret handling:** `GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GH_ENTERPRISE_TOKEN` and the variable
named in `token` are removed from the environment of agents and hooks. The agent changes the issue only through the
tools below, which run inside Symphony. Pushing branches uses your normal git credentials (SSH).

**Validation errors:** missing `project_number` or `owner`, malformed `repositories`, non-URL `endpoint`
→ `invalid_tracker_config`; no token → `missing_tracker_secret`. On first use the adapter also checks that the board
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
| `native_ref` | `{provider, project_id, item_id, issue_id, repository, number, issue_state, status_option_id, parent, sub_issues, dispatch_note}`: `parent` and each sub-issue are `{identifier, title, state}`; `dispatch_note` says why an issue is not dispatchable (shown by `--dry-run`) |

### Dependencies

An issue waits while any of these is unresolved:

1. **Relationships:** issues set under *Relationships → Blocked by* in the GitHub issue sidebar.
2. **Text references** in the issue description: `blocked by #12`, `blocked #12`, `Blocked by: #12, #13 and owner/repo#7`,
   also with Markdown emphasis (`**blocked by** #12`). Matching is case-insensitive; `#N` means the issue's own
   repository; references may point to issues or pull requests. Words like `unblocked` do not match, and negations
   (`not blocked by #12`) are not understood.
3. **Sub-issues** of a parent issue: the parent waits until every sub-issue is closed.

Text references are resolved with one extra request per poll (`issueOrPullRequest`, 50 per request). A dependency
is resolved when the issue is closed or the pull request is closed or merged. References that do not exist or are not
readable are ignored, so a typo does not block an issue forever. In the Symphony workflow agents never close issues:
a dependency resolves when its pull request with `Closes #N` is merged.

A **closed** issue whose status is still active is reported as not dispatchable: a running agent is stopped, but
the workspace is only deleted once the issue reaches a terminal status.

Hooks additionally receive `SYMPHONY_ISSUE_REPOSITORY` and `SYMPHONY_ISSUE_NUMBER`.

## Agent tools

Exposed to Claude Code as `mcp__tracker__<name>`. They always act on the session's own issue and repository.

| Tool | Input | Mutates | Result |
|---|---|---|---|
| `get_issue` | none | no | Issue fields, valid status options, the latest 20 comments, linked pull requests |
| `set_status` | `status` | yes | Moves the board item; the name is matched case-insensitively. An unknown name returns the valid options. Guarded: see below. |
| `add_comment` | `body` | yes | Posts a comment on the issue; returns its URL |
| `open_pull_request` | `head`, `title`, `body?`, `base?`, `draft?` | yes | Opens a PR from an already pushed branch (base defaults to the default branch). An open PR for the same branch is returned instead of a duplicate (`created: false`). |

`set_status` declares its target column (`transitionTarget`), so Symphony's
[transition guard](../configuration.md#transition-guard) checks every call before the mutation is sent: terminal
columns and columns outside the role's `may_move_to` are denied (`transition_denied`), and a gated column is entered
only after its entry check passes (`check_failed` / `check_error` otherwise). A denied call sends no request to GitHub.

Failures come back to the agent as structured tool errors (`{error: {category, message}}`), so it can correct its
input. Keep GitHub's secondary rate limits in mind: content-creating calls such as comments are limited to roughly
80 per minute per token.

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
