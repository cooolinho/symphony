# Agent runner: Claude Code

Each run attempt starts one **Claude Code** session through the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) (`@anthropic-ai/claude-agent-sdk`), which bundles the
Claude Code CLI. The spec targets the Codex app-server; this section documents how its contract maps to Claude Code.

## Session model

| Spec concept | Claude Code |
|---|---|
| App-server subprocess | Claude Code CLI, started by the SDK in the issue workspace (`cwd`), as the leader of a new process group |
| Thread (`thread_id`) | Claude session id: a UUID Symphony generates and passes as `sessionId` |
| Turn (`turn_id`) | One user message on the live session (streaming input), numbered 1, 2, …; `session_id` = `<thread_id>-<n>` |
| Turn completed / failed | The `result` message for that turn: `success` without `is_error` completes it, anything else fails it |
| Continuation turn | Another user message on the same live session with the continuation prompt |
| Startup handshake | `initializationResult()`, bounded by `claude.read_timeout_ms` |
| Session title | `<identifier>: <title>` |
| Model | A `Model: <model>` label on the issue, else the role's `claude.model`, else `claude.model` ([configuration](configuration.md#model-per-issue)); fixed for the session |
| Role | The [role](configuration.md#roles) of the issue's column at dispatch (`default` without roles); fixed for the run. Its `claude` overrides are merged into the session settings, `read_only` sets the policy below, `max_turns` limits the turns |
| MCP servers | The in-process `tracker` server, plus workspace extensions such as Laravel Boost (below) |

Before launching, the runner checks that the working directory is an absolute, normalized path; the workspace
manager has already checked that it lies inside the workspace root.

## Permission and safety posture

Symphony runs agents **unattended**. Nobody watches a session, so every decision is made by configuration:

- **`claude.permission_mode: auto` (default):** Claude Code's classifier approves routine actions (editing files,
  running tests, local git) and blocks risky ones. When it cannot decide, it asks Symphony.
- **`claude.on_permission_request: deny` (default):** that question is answered with *no*, and the agent gets an
  explanation so it can take another route. `approve` answers *yes* instead (a high-trust setup; every approval is
  logged as `approval_auto_approved`).
- **`claude.allowed_tools`:** actions the workflow always needs, e.g. `Bash(git push:*)`, so the agent can push its
  branch without asking.
- **Tracker tools** (`mcp__tracker__*`) are always allowed. They run inside Symphony with the GitHub token. The agent
  process never receives tracker credentials: they are removed from its environment.
- **User input:** `AskUserQuestion` is disabled. If a question still reaches the permission callback, it is answered
  automatically ("nobody can answer; decide yourself or ask on the issue"), an event `turn_input_required` is
  recorded, and the turn continues. A run therefore never waits for a human.
- **Settings:** only the repository's project settings are loaded by default (`setting_sources: [project]`). Your
  personal `~/.claude` settings, plugins and hooks are not. Plugins listed in `claude.plugins` (Symphony's own
  `.claude` toolbox in the shipped `WORKFLOW.md`) are loaded explicitly.
- **Laravel Boost tools** (`mcp__laravel-boost__*`) are not allowed as a whole. Pre-approved are the tools that read
  the application: `application-info`, `browser-logs`, `database-connections`, `database-query` (Boost enforces
  read-only), `database-schema`, `get-absolute-url`, `last-error`, `read-log-entries`, plus `search-docs` (sends the
  query and the package list to boost.laravel.com). Denied are `tinker` (runs arbitrary PHP; allowed with
  `laravel.allow_tinker: true`) and every tool in `laravel.deny_tools` (default `[record-rule]`, which writes
  `.ai/rules`); a denied tool is also dropped from the pre-approved list. Tools of later Boost versions are not
  pre-approved on purpose: they go through the permission mode, and `canUseTool` denies them by default.
- **Per-server MCP tool policy:** each extension server (`StdioServer`) carries `autoApprove` and `deny`.
  `autoApprove: 'all'` (the default) allows the bare `mcp__<server>`, i.e. every tool of the server. A list such as `['search-docs']` allows only `mcp__<server>__search-docs`; the server's other tools go
  through the permission mode (the `auto` classifier). `deny` lists bare tool names that are added to
  `disallowedTools` as `mcp__<server>__<tool>`, so the agent cannot call them at all.
- **Read-only sessions:** a session started with `policy: { readOnly: true }` gets `Edit`, `Write`, `NotebookEdit`,
  `Bash(git commit:*)` and `Bash(git push:*)` added to `disallowedTools`. Deny rules beat allow rules, so this also
  overrides `claude.allowed_tools: ["Bash(git push:*)"]`. The orchestrator sets `readOnly` from the run's role
  (`roles.<role>.read_only`); without a policy, or for the `default` role, a session is not read-only. This is a
  policy, not a sandbox: Bash can still write files, so callers that need a hard guarantee must enforce it elsewhere
  (for example in the transition guard, or with `claude.sandbox`). Both inputs are agent-neutral; another runner
  maps them to its own mechanism.
- **Sandboxing:** off by default. `claude.sandbox` passes Claude Code's sandbox settings through (filesystem and
  network restrictions for shell commands).

Stricter alternatives: `permission_mode: dontAsk` with an explicit `allowed_tools` list (only listed tools run), or
`sandbox: { enabled: true }`. A fully trusted setup: `permission_mode: bypassPermissions`.

**Trust boundary:** agents run as your OS user. Even with secrets removed from their environment, a determined or
prompt-injected agent could read files your user can read (for example Symphony's own `.env`) unless the permission
mode, classifier or sandbox stops it. Issue text is untrusted input. For stronger isolation run Symphony under a
dedicated OS user or in a container or VM, and narrow `tracker.provider.repositories`.

## Skills and plugins

A session sees three kinds of skills:

| Source | Location | Name |
|---|---|---|
| The repository | `.claude/skills/<name>/SKILL.md` in the clone (project settings) | `<name>` |
| Laravel Boost | generated into the Laravel app's `.claude/skills/` (below) | `<name>`, e.g. `laravel-best-practices`, `testing-best-practices`, `filament-development` |
| Symphony's toolbox | `.claude/skills/` next to `WORKFLOW.md`, loaded as the plugin `symphony` via `claude.plugins` | `symphony:<name>` |

`claude.skills: all` enables all of them and the Skill tool. Plugin skills are namespaced, so they never collide with
a repository's skills. The `session_configured` event lists the loaded plugins, the number of skills and the status of
every MCP server; a plugin that fails to load and an extension MCP server that does not connect are logged as
warnings.

## Workspace extensions: Laravel Boost

After the `before_run` hook and before the session starts (phase `PreparingWorkspace`), Symphony looks for Laravel
apps in the workspace: the root and its direct subdirectories (except `vendor`, `node_modules` and dot-directories)
that contain `artisan` and a `composer.json` requiring `laravel/framework`. Apps without `laravel/boost` only get a
log line (`npm run repo-init` → *Laravel Boost* creates an issue that adds it). For each app with Boost:

1. **Dependencies:** `laravel.composer install --no-interaction --no-progress` when `vendor/` is missing or
   `composer.lock` changed since Symphony's last install (`laravel.install_dependencies`).
2. **Generation:** if the repository does not commit a `boost.json`, Symphony writes one naming Claude Code
   (`agents: [claude_code]`, `mcp: true`) and runs `laravel.php <app>/artisan boost:install --no-interaction
   --guidelines --skills` with `laravel.env` (`APP_ENV=local` by default: Boost registers its commands only locally).
   This writes Boost's guidelines (into `CLAUDE.md` if the app has one, else `AGENTS.md`) and its skills (into
   `.claude/skills/`), matched to the installed package versions and including the app's `.ai/guidelines` and
   `.ai/skills`. No `.mcp.json` is written: Symphony adds the server itself. **Package skills:** Non-interactive
   Boost installs third-party skills only from the `packages` list of `boost.json`, so Symphony scans
   `vendor/*/*/resources/boost/` (a `skills/` or `guidelines/` directory) and adds every such package, for example
   `filament/filament` with its `filament-development` skill. Existing `packages` entries are kept. Generation runs
   again only when `composer.lock`, `.ai/`, the Boost version, the list of those packages or `laravel.php` change, or a generated file is gone; the state lives in
   `<git-dir>/symphony/laravel-boost.json`.
3. **Git stays clean:** Symphony compares `git status` before and after. New files are listed one by one in a managed
   block of `.git/info/exclude`, so they never show up as changes (files the agent adds next to them still do).
   Tracked files Boost changed are restored with `git checkout`; their Boost block goes into the prompt instead.
   Tracked files the agent had already changed keep their exact content.
4. **Committed Boost files:** if `boost.json` is tracked, the repository manages Boost itself; Symphony generates
   nothing and uses the committed files.
5. **Session:** the MCP server `laravel-boost` (`laravel-boost-<dir>` when a repository holds several apps) runs
   `laravel.php <app>/artisan boost:mcp` with `laravel.env` plus `SYMPHONY_WORKSPACE`, using the tool policy above.
   A section in the system prompt names the app, the commands to use, the pre-approved and denied Boost tools and
   the skill directories Boost generated (`.claude/skills/<name>/`; the committed ones for committed Boost files),
   mentions `record-rule` and `.ai/rules` only when `record-rule` is allowed, and contains Boost's guidelines unless Claude Code already loads them
   from the root `CLAUDE.md` (blocks over 48 KB go to a file under `<git-dir>/symphony/` the prompt points to). For an
   app in a subdirectory, its directory is passed as an additional directory so its `.claude/skills` load at start.
   The agent's environment gets `laravel.agent_env` (default empty), not `laravel.env`: `APP_ENV=local` there would
   override PHPUnit's `APP_ENV=testing` and keep Boost active in tests.

None of this blocks a run: when PHP is missing, `composer install` or `boost:install` fails, or the workspace is not
a git checkout, Symphony logs a warning and starts the session without Boost. An abort stops PHP and Composer at once;
the git clean-up still runs. If Boost detects Laravel Sail, Symphony warns: Boost's guidelines then tell the agent to
use `vendor/bin/sail`, but Symphony runs PHP on the host. To run PHP elsewhere, point `laravel.php` at a wrapper
script: it receives the absolute `artisan` path and its arguments, plus `SYMPHONY_WORKSPACE` in its environment.

## Timeouts and failures

| Situation | Result |
|---|---|
| Handshake slower than `read_timeout_ms` | `response_timeout`; the attempt is retried with backoff |
| No agent output for `turn_timeout_ms` during a turn | `turn_timeout`; the turn is interrupted, the attempt retried |
| No agent event for `stall_timeout_ms` (checked each tick) | The orchestrator stops the run (`stalled`) and retries. Workspace preparation (hooks, Composer, Boost) has its own timeouts and does not count; the stall clock starts when the session launches |
| Turn result is an error (max budget, API error, …) | `turn_failed` |
| Claude Code exits mid-turn | `port_exit` (stderr tail included in the message) |
| Orchestrator stops the run (issue moved, shutdown) | `turn_cancelled`, no retry |

Stopping a session closes its input, waits up to 10 seconds, then closes it forcibly and kills the **whole process
group**, so commands the agent started (test runners, dev servers) end with it. On orchestrator exit, remaining
groups are killed too.

## Events and accounting

Events sent to the orchestrator: `session_started`, `session_configured` (model, permission mode, Claude Code
version, MCP server status, plugins, number of skills), `startup_failed`, `turn_started`, `turn_completed`, `turn_failed`, `turn_cancelled`, `turn_timeout`,
`turn_input_required`, `approval_auto_approved`, `approval_denied`, `permission_denied`, `tool_use`, `tool_result`,
`tracker_tool`, `assistant_message`, `api_retry`, `rate_limit`, `agent_error` (API or authentication errors),
`agent_exited`, `notification`, `other_message`.

Token usage comes from the `modelUsage` totals of each turn result, which are cumulative for the session (main
loop, subagents and compaction) and broken down per model. In the dashboard totals, input tokens include cache reads
and cache writes; the repository logs keep the four counts apart. The orchestrator adds the difference to the
previous total, so nothing is counted twice. Cost is estimated per model with `model-costs.yml` (see
[configuration.md](configuration.md)); Claude Code's own estimate (`total_cost_usd`) is kept as
`claude_estimate_usd` for comparison. Rate-limit snapshots come from `rate_limit_event` messages (subscription
logins).

Every raw SDK message is also written as JSON lines to `<log-dir>/sessions/<workspace-key>/<timestamp>.jsonl`.

## Authentication

Claude Code uses `ANTHROPIC_API_KEY` if it is set (shell or `.env`), otherwise the login of your Claude Code
installation (`claude` → `/login`).
