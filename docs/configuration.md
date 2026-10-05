# Configuration reference

Symphony reads two files at startup:

- **`WORKFLOW.md`**: YAML front matter for the runtime settings, plus a Markdown body that is the per-issue prompt
  (a [Liquid](https://liquidjs.com/) template). Changes are picked up **while Symphony runs**: a file watch
  plus a check on every poll tick.
- **`.env`**: optional dotenv file with machine-specific values and secrets. By default it is the `.env` next to the
  selected `WORKFLOW.md`; `--env-file <path>` picks another one. It is read **once at startup**, so restart after
  editing it. Variables already set in the shell win over the file; Symphony logs the names (never the values) of
  file entries that the shell overrides.

## Environment references (`$NAME`, `${NAME:-default}`)

A setting whose whole value is `$NAME` or `${NAME}` takes the value of that variable from the shell or `.env`.
If the variable is unset or empty, the setting counts as **omitted** and its default applies. `${NAME:-default}`
uses `default` instead in that case (`${NAME:-}` with an empty default also means omitted). Numbers and booleans may
come from variables: `max_turns: ${SYMPHONY_MAX_TURNS:-10}`. This works for every setting except:

- `hooks.*` and `checks.on_enter.*`: shell scripts; the shell expands `$NAME` itself when the script runs.
- `tracker.provider.*`: resolved by the tracker adapter, which also uses the same `$NAME` rules (see
  [the adapter profile](adapters/github-project.md)). For `token`, an unset variable is a *missing secret* error.

Path settings (`workspace.root`, `claude.executable`, `claude.plugins`, and `laravel.php` / `laravel.composer` when
they contain a `/` or start with `~`) additionally expand `$NAME` *inside* the value
(`$HOME/ws`, where an unset variable is an error) and a leading `~`. Relative paths resolve against the directory
that contains `WORKFLOW.md`.

## Front matter

Unknown top-level keys are ignored with a warning. A `codex` section is ignored with a warning: this implementation
runs Claude Code and is configured through `claude`.

### `tracker`

| Key | Default | Notes |
|---|---|---|
| `kind` | (required) | `github_project` is the only supported adapter. |
| `provider` | `{}` | Adapter settings, see [github-project.md](adapters/github-project.md). |
| `active_states` | `[Todo, In Progress]` | Board statuses that get an agent. Compared case-insensitively. |
| `terminal_states` | `[Done]` | Statuses that stop the agent **and delete the workspace**. |
| `required_labels` | `[]` | An issue needs every listed label (case-insensitive) to be dispatched or keep running. |

Statuses that are neither active nor terminal (for example `Human Review`) stop the agent and keep the workspace.

### `polling`

| Key | Default | Notes |
|---|---|---|
| `interval_ms` | `30000` | Poll cadence; a change applies to the next tick. |

### `workspace`

| Key | Default | Notes |
|---|---|---|
| `root` | `<system temp>/symphony_workspaces` | One directory per issue below it, named after the issue identifier (`owner_repo_12-<hash>`). Workspaces survive restarts and are reused for retries. |
| `cleanup_terminal` | `true` | Delete an issue's workspace (after the `before_remove` hook) when it reaches a terminal state: at startup for all terminal issues, and within one poll interval for issues this process worked on, including ones already handed off (e.g. *In review* → merged → *Done*). `false` keeps them. |

### `hooks`

Shell scripts run with `bash -lc` in the issue workspace, in their own process group. They receive the
orchestrator's environment **without** tracker credentials (`GITHUB_TOKEN`, `GH_TOKEN`, the variable named in
`tracker.provider.token`, …), plus:

| Variable | Value |
|---|---|
| `SYMPHONY_HOOK` | `after_create`, `before_run`, `after_run` or `before_remove` |
| `SYMPHONY_ISSUE_ID` | Opaque issue id (GitHub project item id) |
| `SYMPHONY_ISSUE_IDENTIFIER` | e.g. `cooolinho/trainingsstunden-portal#12` |
| `SYMPHONY_ISSUE_URL`, `SYMPHONY_ISSUE_BRANCH` | Issue URL; linked branch, if any (may be empty) |
| `SYMPHONY_ISSUE_REPOSITORY`, `SYMPHONY_ISSUE_NUMBER` | The issue's repository (`owner/name`) and number |
| `SYMPHONY_WORKSPACE`, `SYMPHONY_WORKSPACE_KEY` | Workspace path and directory name |
| `SYMPHONY_WORKFLOW_DIR` | Directory containing `WORKFLOW.md` |

| Key | When | On failure |
|---|---|---|
| `after_create` | Only when the workspace directory is newly created | The half-created directory is deleted; the attempt fails and is retried. |
| `before_run` | Before every agent attempt | The attempt fails and is retried. |
| `after_run` | After every attempt (success, failure, cancellation) | Logged and ignored. |
| `before_remove` | Before a workspace is deleted | Logged and ignored; the directory is still deleted. |
| `timeout_ms` | Default `60000`; applies to every hook | A timed-out hook's whole process group is killed. |

Hooks finish when their output pipes close, so redirect the output of background jobs (`cmd >/dev/null 2>&1 &`).

### `checks`

Deterministic entry checks: bash scripts that run before an issue may enter a gated column. This section only
configures them; omitting it changes nothing.

```yaml
checks:
  timeout_ms: 1200000
  retries: 0
  on_enter:
    Agent review: bash "$SYMPHONY_WORKFLOW_DIR/checks/laravel.sh"
```

| Key | Default | Meaning |
|---|---|---|
| `timeout_ms` | `hooks.timeout_ms` | Limit per script run; must be below `claude.turn_timeout_ms`. A timed-out or aborted script's whole process group is killed. |
| `retries` | `0` | Extra attempts after a failed check, `0`–`3`. |
| `on_enter` | `{}` | Map of column name (matched trimmed and case-insensitively) to the bash script that must pass to enter it. |

Scripts run like hooks (`bash -lc` in the issue workspace, own process group) with the same `SYMPHONY_*`
variables, `SYMPHONY_HOOK` set to the check's label. Because they execute repository code, their environment
also lacks agent credentials (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) on top of the tracker credentials
hooks already lack. Scripts are not `$VAR`-substituted by Symphony; the shell expands them at run time.

### `agent`

| Key | Default | Notes |
|---|---|---|
| `max_concurrent_agents` | `10` | `0` pauses new dispatches; running agents continue. |
| `max_turns` | `20` | Turns per agent session; between turns Symphony re-reads the issue and stops if it left the active states. |
| `max_continuations` | unlimited | After a session ends normally while the issue is still active, Symphony starts another one (a *continuation session*). With a limit, an issue that is still active after that many continuation sessions is **paused**: it stays claimed and nothing new starts. It resumes as soon as it changes on the tracker (status, comment, labels, edit), leaves the active states, or the limit is raised. `0` = pause right after the first session. |
| `max_retry_backoff_ms` | `300000` | Cap for failure retries (10 s, 20 s, 40 s, …). |
| `max_concurrent_agents_by_state` | `{}` | Per-status limits, e.g. `{ "In Progress": 1 }`. Invalid entries are ignored with a warning. |
| `continuation_prompt` | built-in | Liquid template sent on turn 2+ of a session (variables: `issue`, `attempt`, `turn_number`, `max_turns`). |

### `claude`

| Key | Default | Notes |
|---|---|---|
| `model` | Claude Code default | Default model: alias (`opus`, `sonnet`, `haiku`) or full model id. A `Model: <model>` issue label overrides it for that issue, see [Model per issue](#model-per-issue). |
| `fallback_model` | none | Used when the primary model is overloaded. Left out for a session whose model is the same (the Agent SDK refuses that combination). |
| `effort` | Claude Code default | `low`, `medium`, `high`, `xhigh`, `max`. |
| `permission_mode` | `auto` | `auto` (a classifier approves or blocks each action), `default`, `acceptEdits`, `dontAsk`, `plan`, `bypassPermissions`. See [agent-claude.md](agent-claude.md). |
| `on_permission_request` | `deny` | Answer when Claude Code asks for approval: `deny` or `approve`. |
| `allowed_tools` / `disallowed_tools` | `[]` | Claude Code permission rules, e.g. `"Bash(git push:*)"`. Tracker tools are always allowed; `AskUserQuestion` is always disallowed. |
| `setting_sources` | `[project]` | Which Claude Code settings to load: `project` (the repository's `.claude/settings.json` and `CLAUDE.md`), `local`, `user` (your personal `~/.claude` settings, plugins and hooks). |
| `sandbox` | none | Passed to Claude Code's sandbox settings (`enabled`, `network`, `filesystem`, …). |
| `append_system_prompt` | none | Extra text appended to Claude Code's system prompt. |
| `max_budget_usd` | none | Cost cap per agent session; the turn fails when it is exceeded. |
| `persist_session` | `true` | Keep transcripts in `~/.claude/projects` so a session can be inspected with `claude --resume <id>`. |
| `env` | `{}` | Extra environment variables for the agent process. |
| `executable` | bundled CLI | Path to another Claude Code executable. |
| `plugins` | `[]` | Local Claude Code plugin directories loaded into every session (skills, subagents, commands, hooks), relative to `WORKFLOW.md`. The shipped `WORKFLOW.md` loads `./.claude`, Symphony's own toolbox; its skills are named `symphony:<skill>`. A missing directory blocks dispatch. |
| `skills` | Claude Code default | `all` enables every discovered skill (the repository's, a plugin's, Laravel Boost's) and the Skill tool; a list enables only those names (`pest-testing`, `symphony:handoff`). |
| `turn_timeout_ms` | `3600000` | A turn fails after this long **without any output** from the agent. |
| `read_timeout_ms` | `30000` | Startup handshake timeout. |
| `stall_timeout_ms` | `300000` | The orchestrator kills and retries a run without any agent event for this long; `<= 0` disables it. |

### `laravel`

Laravel Boost for Laravel apps in the workspace. After the `before_run` hook, Symphony looks for Laravel apps in the
checkout (the root and one level deep: `artisan` plus a `composer.json` that requires `laravel/framework`). For each
app that requires `laravel/boost`, it installs Composer dependencies if needed, generates Boost's guidelines and skills
for Claude Code, keeps the generated files out of commits, and adds Boost's MCP server to the session. Apps without
Boost only get a log line; `npm run repo-init` creates an issue that adds it. Details:
[agent-claude.md](agent-claude.md#workspace-extensions-laravel-boost).

| Key | Default | Notes |
|---|---|---|
| `boost` | `auto` | `auto`: use Boost where a Laravel app requires it. `off`: never. |
| `php` | `php` | PHP command for `artisan`. A bare name is looked up on `PATH`; a value with `/` or `~` is a path, relative to `WORKFLOW.md`. A wrapper script (for example one that runs PHP in a per-workspace container) receives the absolute `artisan` path as its first argument and `SYMPHONY_WORKSPACE` in its environment. |
| `composer` | `composer` | Composer command, resolved like `php`. |
| `install_dependencies` | `true` | Run `composer install` when `vendor/` is missing or `composer.lock` changed since the last install. Off: apps without `vendor/` run without Boost. |
| `env` | `{ APP_ENV: local }` | Environment for Composer, `artisan`, the Boost MCP server and the agent. Boost only registers its commands with `APP_ENV=local` (or `APP_DEBUG=true`), and a fresh clone has no `.env`. Entries are merged over the default, e.g. `{ DB_CONNECTION: sqlite }` keeps Boost's database tools away from a developer's database. |
| `timeout_ms` | `hooks.timeout_ms` | Limit for each Composer or `artisan` step. |

### Model per issue

An issue label `Model: <value>` picks the model for that issue's sessions; issues without one use `claude.model`.
The prefix is matched case-insensitively and the space after the colon is optional. The value is lowercased and an
optional `claude-` is removed, then:

| Value | Model passed to Claude Code |
|---|---|
| `opus`, `sonnet`, `haiku` (also `claude-opus`, …) | the alias itself, i.e. the newest model of that family |
| `<family>-<version>` with family `opus`, `sonnet`, `haiku` or `fable` (e.g. `sonnet-5-5`, `claude-opus-5-5`) | the full model id `claude-<family>-<version>` |
| anything else | unknown |

Unknown values, and several labels naming different models, are ignored: the session uses `claude.model` and Symphony
logs `model label ignored` (the dry run shows the same). The model is chosen when a session is dispatched, so a label
change applies from the next session (continuation or retry); a paused issue resumes with the new model. The choice
appears in the `dispatching issue` log line (`model`, plus `model_label` when a label picked it) and as `model` of
`run_started` in the repository log. The model Claude Code actually runs is logged with `session_configured`; the
`model` of a running agent in `GET /api/v1/state` is the one that used the most tokens (until the first turn ends, the
one the session started with).
`npm run repo-init` creates the standard labels (`Model: opus`, `Model: sonnet`, `Model: haiku`) through the GitHub
REST API. Other values such as `Model: claude-opus-5-5` work as labels too; create them by hand.

### `server`

| Key | Default | Notes |
|---|---|---|
| `port` | none | Starts the dashboard and JSON API. `0` picks a free port. `--port` overrides it. Restart to change it. |
| `host` | `127.0.0.1` | Bind address. On a loopback address, requests with another `Host` header are rejected. |

## `model-costs.yml`

Prices for the cost estimates (dashboard, repository logs, logs page), next to `WORKFLOW.md`. Re-read when the file
changes; an invalid edit keeps the previous prices and is reported on the dashboard.

```yaml
default: { input: 5.00, output: 25.00 }           # USD per million tokens
opus:    { input: 4.00, output: 20.00, cache_read: 0.20 }
claude-opus-4-8: { input: 5.00, output: 25.00 }
```

- Each entry needs `input` and `output`; `cache_read` defaults to 10% and `cache_write` to 125% of `input`.
- A model id reported by Claude Code (e.g. `claude-opus-5-5`) uses the exact entry if there is one, else the longest
  key contained in the id (`opus`), else `default`. Without the file, every model is priced at 5 / 25.
- Cost = input × input price + output × output price + cache reads × cache_read + cache writes × cache_write.

## Repository logs

`<log-dir>/repositories/<owner>_<repo>.log` (log dir: `--log-dir`, else `SYMPHONY_LOG_DIR` resolved against the
workflow directory, else `$XDG_STATE_HOME/symphony` or `~/.local/state/symphony`). One `key=value` line per event:

| Event | Fields |
|---|---|
| `run_started` | `repo`, `issue`, `run`, `title`, `state`, `attempt`, `model` (requested: from a `Model: …` label, else `claude.model`) |
| `run_finished` | `repo`, `issue`, `run`, `session` (Claude session id), `title`, `outcome` (`handed_off`, `continuing`, `failed`, `stopped`, `stalled`, `shutdown`), `state`, `reason`, `attempt`, `turns`, `model` (most tokens), `models`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `total_tokens`, `cost_usd`, `claude_estimate_usd`, `agent_seconds`, `started_at`, running totals `repo_runs`, `repo_tokens`, `repo_cost_usd`, `repo_agent_seconds` |
| `model_usage` | `repo`, `issue`, `run`, `model`, `price` (matched entry), token counts, `cost_usd` |
| `issue_paused` | `repo`, `issue`, `title`, `state`, `continuations`, `max_continuations` |
| `workspace_removed` | `repo`, `issue`, `state` |

`cost_usd` in a line uses the prices at the time it was written; the logs page and `/api/v1/history` recompute every
cost from the logged tokens with the current `model-costs.yml`. `input_tokens` counts uncached input only;
`total_tokens` is the sum of all four token counts.

## Prompt template

The Markdown body is rendered with strict Liquid: unknown variables and unknown filters fail the run attempt
(which is then retried with backoff), so typos show up immediately. Available variables:

- `issue`: `id`, `identifier`, `title`, `description`, `priority`, `state`, `branch_name`, `url`, `assignee_id`,
  `labels` (lowercase list), `blocked_by` (list of `{id, identifier, state}`), `dispatchable`, `created_at`,
  `updated_at` (ISO strings), `native_ref` (adapter data, for GitHub: `repository`, `number`, `issue_id`, `item_id`,
  `parent` and `sub_issues` as `{identifier, title, state}`, …).
- `attempt`: `null` on the first run of an issue, then `1`, `2`, … on continuation runs and retries.

Besides the standard Liquid filters there is `without_model_labels`: `issue.labels | without_model_labels` drops the
`Model: …` labels, which only pick the agent's model (see [Model per issue](#model-per-issue)).

An empty body falls back to a minimal default prompt. `npm run dry-run` renders the prompt for the first eligible
issue so you can check it without starting an agent.
