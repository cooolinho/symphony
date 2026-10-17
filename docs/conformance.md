# Spec conformance

This implementation follows the *Symphony Service Specification, Draft v1*. Core conformance items (spec 18.1) are
implemented and covered by `npm test`. The deliberate differences:

## Coding agent: Claude Code instead of Codex app-server

The spec's agent section (10) targets the Codex app-server protocol. Symphony runs **Claude Code** through the Claude
Agent SDK instead; the mapping of threads, turns, approvals, user input, timeouts and events is in
[agent-claude.md](agent-claude.md). Consequences:

- The front matter section is `claude`, not `codex`. A `codex` section is ignored with a warning.
- `codex.command` / `bash -lc <command>` is replaced by the SDK's bundled CLI (or `claude.executable`), spawned
  directly in the workspace, in its own process group.
- `claude.read_timeout_ms` defaults to 30 s (spec: 5 s), because starting Claude Code includes loading settings and
  MCP servers.
- Sessions use the SDK's strict MCP configuration by default (`claude.strict_mcp_config`): only MCP servers Symphony
  passes load. Before turn 1 Symphony waits for `pending` servers it added (bounded by `claude.read_timeout_ms`) and
  tells the agent about any that did not connect.
- The snapshot's token totals are named `agent_totals` (spec example: `codex_totals`) and include `cost_usd`
  (estimated with `model-costs.yml`) and `claude_estimate_usd`.

## Implementation-defined behavior

| Topic | Choice |
|---|---|
| Approval / sandbox / user input | Claude Code `auto` permission mode; undecided requests are denied; `AskUserQuestion` disabled and auto-answered; no sandbox by default (see agent-claude.md) |
| Tracker | `github_project` adapter ([profile](adapters/github-project.md)) |
| `issue.id` | GitHub project item id; the issue node id is kept in `native_ref` |
| Workspace key hash | First 16 hex characters (64 bits) of SHA-256 of the original identifier |
| Non-directory at a workspace path | Fails the attempt (`workspace_path_conflict`); nothing is deleted |
| Failed `after_create` | The half-created directory is deleted, so the next attempt starts clean |
| Empty workspace directory | Treated as new: `after_create` runs again (recovers from a crash during `after_create` or a hook that reported success without cloning) |
| Workspace lock | Extension: `<workspace root>/<key>.lock` (JSON: pid, hostname, instance id, timestamp), created with `wx` outside the clone before `ensure`; released when the attempt ends and deleted with the workspace. A live pid on this host or any other host counts as held and ends the attempt as `cancelled` (no hooks, no session; the next poll tick retries); a dead pid on this host is reclaimed. No locking across hosts beyond "held by another host". |
| Hook shell | `bash -lc`, own process group, killed as a group on timeout |
| Hook and agent environment | Tracker secrets and Claude Code nesting markers removed |
| Empty prompt body | Minimal default prompt including identifier, title and description |
| Continuation prompt | Built-in text, overridable with `agent.continuation_prompt` |
| `max_concurrent_agents: 0` | Allowed; pauses new dispatches |
| Invalid workflow reload | Last good version keeps running (reconciliation, retries); new dispatches pause until the file is fixed |
| Reconciliation stop | Cooperative: the worker is cancelled and keeps its claim until it has exited (after `after_run`); terminal issues are cleaned afterwards. A worker that ignores the stop for `2 × hooks.timeout_ms + 60 s` is abandoned. |
| Retry dispatch | Also gated by dispatch preflight validation (a failing preflight requeues with backoff). A retry that finds no free slot is requeued with its original kind and attempt after `polling.interval_ms`, not as a failure. |
| `.env` | Optional dotenv file, read once at startup; the shell environment wins |
| Whole-value references | `$NAME`, `${NAME}`, `${NAME:-default}` for every setting except hooks; unset without default means "omitted" |
| Tracker request retries | Read queries are retried after transient failures (`request_retries`); mutations are not |
| Session limits | Extension: a turn that fails with a Claude subscription limit (`session_limit`, detected from a rejected `rate_limit_event`, else the message text) is retried up to `agent.max_session_limit_retries` times with failure backoff, then waits in the retry queue until the reset + 60 s (an unknown reset, or one more than 8 days ahead, keeps the failure backoff). The wait is in memory only. |
| Operator restart | Extension: `POST /api/v1/<identifier>/retry` (loopback binds, or non-loopback binds with `server.allow_remote_control` and a matching `Origin`) and the dashboard buttons put a waiting or paused worker back into the retry queue without delay and reset its session-limit and continuation counters; eligibility, validation and slots are still checked. |
| Operator pause | Extension: `POST /api/v1/<identifier>/pause` / `resume` and `POST /api/v1/models/<model>/hold` / `release` (same guard as restart) pause an issue or a model family; running agents stop with the workspace kept, board changes do not lift the pause, terminal states and leaving the board do; persisted in the runtime state file. |
| `agent.max_continuations` | Extension: pauses an issue after N continuation sessions until it changes on the tracker (default: unlimited, as specified) |
| `workspace.cleanup_terminal` | Extension: `false` keeps workspaces of terminal issues (default `true`, as specified) |
| Model per issue | Extension: a `Model: <model>` issue label overrides `claude.model` for that issue's sessions; unknown or conflicting labels fall back to `claude.model` with a warning |
| Effort per issue | Extension: an `Effort: <level>` issue label overrides the role's and the global `claude.effort` for that issue's sessions; unknown or conflicting labels fall back to them with a warning |
| Waves (`roles.<role>.wait_for_sub_issues`) | Extension: a role's issues are not dispatched while they have open sub-issues; running sessions are not stopped for it, but end after the turn instead of continuing, and the continuation retry releases the claim |
| Auto-merge (`tracker.provider.auto_merge`) | Extension: the `github_project` adapter merges an issue's pull request into `base_branch` (never the default branch), closes the issue and moves it to a terminal state when an agent moves it into the configured column after its entry checks |
| Stall detection | Not applied while the run is in `PreparingWorkspace` (hooks, Composer, Laravel Boost have their own timeouts) or `RunningChecks` (entry checks have `checks.timeout_ms`); afterwards counted from the end of preparation until the first agent event, and again from the end of a check |
| Terminal cleanup of released issues | Issues this process worked on stay watched after release; their workspace is deleted on the first tick that sees them terminal (the spec only requires startup, reconciliation and retry paths) |
| HTTP server | Loopback by default (`server.host` / `SYMPHONY_HOST`); Host-header check against DNS rebinding on loopback binds; cross-origin `POST` rejected; on non-loopback binds a startup warning (no built-in login, use an authenticating proxy), restart off unless `server.allow_remote_control`, and then only with a matching `Origin`; `controls.retry` in `/api/v1/state` and `/api/v1/<identifier>` |
| Logs | `key=value` lines on stderr (optional `--log-file`); per-session JSONL transcripts under the log directory |

## Optional extensions

| Extension | Status |
|---|---|
| HTTP server (13.7) | Implemented: `/`, `/api/v1/state`, `/api/v1/<identifier>`, `POST /api/v1/refresh`; extensions: `/agent?id=<identifier>` (agent detail view), `/api/v1/<identifier>/timeline` and `/transcript`, `/logs`, `/api/v1/history` with `/analytics` and `/entries` |
| Provider-native agent tools (10.5) | Implemented for `github_project`: `get_issue`, `set_status`, `add_comment`, `open_pull_request`, `create_sub_issue` (only for roles with `max_sub_issues`; optional `parent` for a second level and `blocked_by` for GitHub's "blocked by" relationships) |
| Laravel Boost (`laravel`) | Extension: for Laravel apps that require `laravel/boost`, Composer dependencies, Boost guidelines and skills are prepared before each session (kept out of git) and Boost's MCP server is added; never blocks a run |
| Plugins and skills (`claude.plugins`, `claude.skills`) | Extension: local Claude Code plugins (Symphony's `.claude` toolbox) loaded into every session |
| Repository history | Extension: one `key=value` log per repository with every run (tokens per model, cost, agent time), statistics and analytics at `/logs`, `/api/v1/history` and `/api/v1/history/analytics` |
| SSH workers (Appendix A) | Not implemented |
| Persisted retry queue | Not implemented (spec TODO); state is rebuilt from the tracker after a restart |

## Known limitations

- **Continuation loop:** as specified, an issue that stays in an active status after a normal run is picked up again
  after one second. If the agent never moves the issue (for example because the handoff status is missing on the
  board), sessions repeat. Set `agent.max_continuations` to pause such issues after a few sessions; other levers are
  `claude.max_budget_usd` and `agent.max_concurrent_agents: 0` (pauses all new starts, applies live).
- `.env` changes need a restart; `WORKFLOW.md` changes do not, except `server.*`.
- One adapter (`github_project`); `tracker.kind` values for other trackers are rejected.
