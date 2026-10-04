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
| Hook shell | `bash -lc`, own process group, killed as a group on timeout |
| Hook and agent environment | Tracker secrets and Claude Code nesting markers removed |
| Empty prompt body | Minimal default prompt including identifier, title and description |
| Continuation prompt | Built-in text, overridable with `agent.continuation_prompt` |
| `max_concurrent_agents: 0` | Allowed; pauses new dispatches |
| Invalid workflow reload | Last good version keeps running (reconciliation, retries); new dispatches pause until the file is fixed |
| Reconciliation stop | Cooperative: the worker is cancelled and keeps its claim until it has exited (after `after_run`); terminal issues are cleaned afterwards. A worker that ignores the stop for `2 × hooks.timeout_ms + 60 s` is abandoned. |
| Retry dispatch | Also gated by dispatch preflight validation (a failing preflight requeues with backoff) |
| `.env` | Optional dotenv file, read once at startup; the shell environment wins |
| Whole-value references | `$NAME`, `${NAME}`, `${NAME:-default}` for every setting except hooks; unset without default means "omitted" |
| Tracker request retries | Read queries are retried after transient failures (`request_retries`); mutations are not |
| `agent.max_continuations` | Extension: pauses an issue after N continuation sessions until it changes on the tracker (default: unlimited, as specified) |
| `workspace.cleanup_terminal` | Extension: `false` keeps workspaces of terminal issues (default `true`, as specified) |
| Model per issue | Extension: a `Model: <model>` issue label overrides `claude.model` for that issue's sessions; unknown or conflicting labels fall back to `claude.model` with a warning |
| Terminal cleanup of released issues | Issues this process worked on stay watched after release; their workspace is deleted on the first tick that sees them terminal (the spec only requires startup, reconciliation and retry paths) |
| HTTP server | Loopback by default; Host-header check against DNS rebinding; cross-origin `POST` rejected |
| Logs | `key=value` lines on stderr (optional `--log-file`); per-session JSONL transcripts under the log directory |

## Optional extensions

| Extension | Status |
|---|---|
| HTTP server (13.7) | Implemented: `/`, `/api/v1/state`, `/api/v1/<identifier>`, `POST /api/v1/refresh` |
| Provider-native agent tools (10.5) | Implemented for `github_project`: `get_issue`, `set_status`, `add_comment`, `open_pull_request` |
| Repository history | Extension: one `key=value` log per repository with every run (tokens per model, cost, agent time), statistics at `/logs` and `/api/v1/history` |
| SSH workers (Appendix A) | Not implemented |
| Persisted retry queue | Not implemented (spec TODO); state is rebuilt from the tracker after a restart |

## Known limitations

- **Continuation loop:** as specified, an issue that stays in an active status after a normal run is picked up again
  after one second. If the agent never moves the issue (for example because the handoff status is missing on the
  board), sessions repeat. Set `agent.max_continuations` to pause such issues after a few sessions; other levers are
  `claude.max_budget_usd` and `agent.max_concurrent_agents: 0` (pauses all new starts, applies live).
- `.env` changes need a restart; `WORKFLOW.md` changes do not, except `server.*`.
- One adapter (`github_project`); `tracker.kind` values for other trackers are rejected.
