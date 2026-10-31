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

**Board preflight.** Every column named in `tracker.active_states`, `tracker.terminal_states`, `roles.*.states`,
`roles.*.may_move_to`, the targets of `roles.*.on_result`, `on_check_failed`, `on_missing_result` and `on_round_limit`, and
`checks.on_enter` must be a status option of the board (compared case-insensitively).
An unknown column is a dispatch-validation error (`unknown board column "Agent Reviw" (valid: …)`): dispatch
pauses while reconciliation continues, and the error clears on the first tick after `WORKFLOW.md` is fixed. The
options are fetched once per workflow version; a failed fetch is reported as a tracker error (the check is skipped
and retried on the next tick), not as a validation error. Adapters without `statusOptions` skip the check. The dry
run prints the same check.

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
| `SYMPHONY_ISSUE_IDENTIFIER` | e.g. `owner/repository#12` |
| `SYMPHONY_ISSUE_URL`, `SYMPHONY_ISSUE_BRANCH` | Issue URL; linked branch, if any (may be empty) |
| `SYMPHONY_ISSUE_REPOSITORY`, `SYMPHONY_ISSUE_NUMBER` | The issue's repository (`owner/name`) and number |
| `SYMPHONY_WORKSPACE`, `SYMPHONY_WORKSPACE_KEY` | Workspace path and directory name |
| `SYMPHONY_WORKFLOW_DIR` | Directory containing `WORKFLOW.md` |

| Key | When | On failure |
|---|---|---|
| `after_create` | Only when the workspace directory is newly created or exists but is empty | The half-created directory is deleted; the attempt fails and is retried. |
| `before_run` | Before every agent attempt | The attempt fails and is retried. |
| `after_run` | After every attempt (success, failure, cancellation) | Logged and ignored. |
| `before_remove` | Before a workspace is deleted | Logged and ignored; the directory is still deleted. |
| `timeout_ms` | Default `60000`; applies to every hook | A timed-out hook's whole process group is killed. |

A hook succeeds or fails by the exit code of its **last** command. Start a multi-line hook with `set -e`; without it a
failed `git clone` is followed by the next line, which may succeed in the empty directory, and the attempt carries on
with a workspace that holds no repository. An empty workspace directory (left by a crash or by such a hook) counts as
new, so `after_create` runs for it again.

#### Recipe: Laravel apps

The conventions a repository follows for this hook are in [Laravel repositories](laravel-repositories.md).

`hooks/laravel-env.sh` gives every Laravel app in the workspace (root or one level deep, without `vendor`,
`node_modules` and dot-directories) its own `.env` and SQLite database, so artisan and Laravel Boost never reach a
developer's or a shared database. It only acts on directories with `artisan` and `.env.example` but no `.env`, never
overwrites or reads an existing `.env`, and prints nothing when there is no Laravel app.

```yaml
hooks:
  after_create: |
    set -e
    git clone --quiet "git@github.com:${SYMPHONY_ISSUE_REPOSITORY}.git" .
    bash "$SYMPHONY_WORKFLOW_DIR/hooks/laravel-env.sh"
```

It copies `.env.example`, sets `APP_ENV=local`, `APP_DEBUG=true`, a fresh `APP_KEY`, `DB_CONNECTION=sqlite`, an absolute
`DB_DATABASE=<app>/database/symphony.sqlite`, `CACHE_STORE=file`, `QUEUE_CONNECTION=sync`, `MAIL_MAILER=log` and
`BOOST_BROWSER_LOGS_WATCHER=false` (each key exactly once, replaced in place), comments out `DB_HOST`, `DB_PORT`,
`DB_USERNAME` and `DB_PASSWORD`, creates the SQLite file and adds `.env` and the file to `.git/info/exclude` if the app
does not ignore them.

##### Optional: MySQL instead of SQLite

Apps whose tests or Boost usage need MySQL can opt in with `SYMPHONY_LARAVEL_DB=mysql` in Symphony's environment. Each
workspace then gets a development database `symphony_<key>` and a test database `symphony_<key>_test`, where `<key>`
is the first 12 hex characters of the sha256 of `SYMPHONY_WORKSPACE_KEY` (names stay below MySQL's 64-character limit).
`laravel-env.sh` creates both with the `mysql` client (`CREATE DATABASE IF NOT EXISTS`), sets `DB_CONNECTION=mysql`,
`DB_DATABASE`, `DB_HOST`, `DB_PORT`, `DB_USERNAME` and `DB_PASSWORD` in `.env` (mode `0600`) and writes `.env.testing`
for the test database. A failed `CREATE DATABASE` exits non-zero, so the half-created workspace is removed.
`hooks/laravel-db-drop.sh` drops both databases in `before_remove` (and, whenever `SYMPHONY_MYSQL_USER` is set, the
database of the full CI check, see [check scripts](#check-scripts-checkslaravelsh)); missing databases are not an error.

```yaml
hooks:
  after_create: |
    set -e
    git clone --quiet "git@github.com:${SYMPHONY_ISSUE_REPOSITORY}.git" .
    bash "$SYMPHONY_WORKFLOW_DIR/hooks/laravel-env.sh"
  before_remove: |
    bash "$SYMPHONY_WORKFLOW_DIR/hooks/laravel-db-drop.sh"
```

| Variable | Meaning |
| --- | --- |
| `SYMPHONY_LARAVEL_DB` | `mysql` enables this variant; anything else keeps SQLite |
| `SYMPHONY_MYSQL_HOST`, `SYMPHONY_MYSQL_PORT` | Server, default `127.0.0.1` and `3306` |
| `SYMPHONY_MYSQL_USER` | Required |
| `SYMPHONY_MYSQL_PASSWORD` | Passed to `mysql` via `MYSQL_PWD`, never printed; single line |

Create a dedicated user restricted to `symphony\_%` databases (this also covers the suffixed databases of
`php artisan test --parallel`). Symphony does not provision the MySQL server.

```sql
CREATE USER 'symphony'@'localhost' IDENTIFIED BY '...';
GRANT ALL PRIVILEGES ON `symphony\_%`.* TO 'symphony'@'localhost';
```

Prerequisite in the app: do not hard-code `DB_DATABASE` in `phpunit.xml`. PHPUnit's value would win over
`.env.testing`, and parallel workspaces would share one test database.

Hooks finish when their output pipes close, so redirect the output of background jobs (`cmd >/dev/null 2>&1 &`).

### `checks`

Deterministic entry checks: bash scripts that run before an issue may enter a gated column. Omitting the section
changes nothing.

```yaml
checks:
  timeout_ms: 1200000
  retries: 0
  on_enter:
    Agent review: bash "$SYMPHONY_WORKFLOW_DIR/checks/laravel.sh"
```

| Key | Default | Meaning |
|---|---|---|
| `timeout_ms` | `hooks.timeout_ms` | Limit per script run; must be below `claude.turn_timeout_ms`. A timed-out or aborted script's whole process group is killed; a timeout returns `check_timeout`. May come from a variable, e.g. `${SYMPHONY_CHECKS_TIMEOUT_MS:-1800000}`. |
| `retries` | `0` | Extra attempts after a failed check, `0`–`3`. |
| `on_enter` | `{}` | Map of column name (matched trimmed and case-insensitively) to what must pass to enter it: a bash script, a [named check](#named-checks), or a list of either, run in order. |
| `report_status` | `false` | Report named checks to the tracker; GitHub: commit statuses `symphony/<name>` (see [named checks](#named-checks)). |

#### Named checks

A column can run several checks, each with a name and its own timeout. The shipped `WORKFLOW.md` uses this for the
final gate before [auto-merge](adapters/github-project.md#merge-gate), standing in for a repository's GitHub Actions:

```yaml
checks:
  report_status: true
  on_enter:
    In review:
      - name: ci
        command: bash "$SYMPHONY_WORKFLOW_DIR/checks/repo.sh" ci -- bash "$SYMPHONY_WORKFLOW_DIR/checks/laravel.sh" --full
        timeout_ms: 1200000
      - name: prod-smoke
        command: bash "$SYMPHONY_WORKFLOW_DIR/checks/repo.sh" --lock prod-smoke
        timeout_ms: 1800000
```

| Key | Meaning |
|---|---|
| `name` | Lowercase letters, digits, `.`, `_`, `-` (at most 50), unique per column. The script sees it as `SYMPHONY_CHECK_NAME`. |
| `command` | The bash script, run like a plain one. |
| `timeout_ms` | Its own limit (default `checks.timeout_ms`); may come from a variable. The checks of one column run in one tool call, so their sum must stay below `claude.turn_timeout_ms`. |

- **Order and failures.** The checks run one after the other. A failing check (exit 1) does not stop the others: the
  agent gets every failure in one answer, each under a header `== <name>: failed (exit 1, 6m12s) ==`, sharing the
  6000 characters. A timeout or an environment problem stops at once.
- **Exit 78** means the check does not apply here (no such script in the repository, no Laravel app): it passes as
  `skipped` and reports no status.
- **Cache.** Each check is cached on its own (HEAD sha + name + command), so after a failure only the failed ones run
  again on the same commit.
- **Statuses.** With `report_status: true`, a named check posts `pending` once it has run for 5 s, and `success`,
  `failure` (exit 1) or `error` (timeout, environment) when it ends, on the commit it ran on; a cached pass posts
  `success` again. The description holds only the duration and exit code (no output: repositories may be public);
  the link goes to the agent page when [`server.public_url`](#server) is set. A failed post is logged as
  `check_status_failed` and never changes the decision. GitHub needs the token scope `repo` (classic) or "Commit
  statuses: write". Branch rules can then require `symphony/ci`, and the auto-merge gate reads them like any check.

#### Repository checks (`checks/repo.sh`)

`checks/repo.sh [--lock] <name> [-- fallback…]` runs a repository's own check, `.symphony/checks/<name>.sh`, **read
from the base branch** (`SYMPHONY_BASE_BRANCH`, else `origin/HEAD`): a pull request cannot weaken the check of its
own merge, and a changed script applies once it is merged. Without that script it runs the fallback after `--`;
without one it exits 78. First it requires a clean tree with everything pushed, like `checks/laravel.sh`.

- `--lock` runs one check of that name per repository at a time (`flock`), for checks with fixed compose project
  names, ports or networks. Waiting counts against the check's timeout.
- With `SYMPHONY_CI_DOCKER_HOST` (the compose profile `ci`, see [docker.md](docker.md)) the script gets
  `DOCKER_HOST`, `DOCKER_TLS_VERIFY` and `DOCKER_CERT_PATH` for the CI Docker daemon, and `SYMPHONY_DOCKER_HOST_IP`,
  the address of ports that daemon publishes. Agents never get these variables.

Scripts run like hooks (`bash -lc` in the issue workspace, own process group) with the same `SYMPHONY_*`
variables, `SYMPHONY_HOOK` set to the check's label. Because they execute repository code, their environment
also lacks agent credentials (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) on top of the tracker credentials
hooks already lack. Scripts are not `$VAR`-substituted by Symphony; the shell expands them at run time.

#### Transition guard

Every tracker tool that changes the issue's column (GitHub: `set_status`; for roles with `result`:
[`report_result`](results.md#the-report_result-tool)) goes through Symphony's transition guard before the tracker is
touched. The guard decides on the run's role and the target column only, in this order:

1. A terminal target (`tracker.terminal_states`, e.g. `Done`) is always denied; only a human moves issues there.
   With `roles`, a target outside the role's `may_move_to` is denied too. Both return the tool error
   `transition_denied` with the allowed targets.
2. A target without `checks.on_enter` entry is allowed, and so is every target of a role with `run_checks: false`
   (the guard logs `checks_skipped`; `may_move_to` still applies, see [`roles`](#roles)).
3. Otherwise the check runs in the workspace (see above) with `SYMPHONY_ROLE` (the run's role, `default` without
   roles) and `SYMPHONY_TARGET_STATE` (the target as the agent named it) added to its environment:

| Exit | Result | The agent is told |
|---|---|---|
| `0` | The issue is moved; the tool result carries `note: "Checks passed — end your turn now."` (`report_result` keeps its own note, `"Result recorded — end your turn now."`) | End the turn, so the next role takes over. |
| `1` | Tool error `check_failed`; the column is unchanged | The last 6000 characters of the output; fix the problems and call `set_status` (or `report_result`) again. |
| none, `checks.timeout_ms` reached | Tool error `check_timeout`; the column is unchanged | A runtime limit, not the change: do not change code and do not move the issue to `Blocked`; call `set_status` once more, and if that times out too, comment and end the turn without a status change. Symphony picks the issue up again later. |
| other, aborted, or the check cannot start | Tool error `check_error`; the column is unchanged | Do not change code; describe the problem in an issue comment and move the issue to `Blocked` (`report_result`: end the turn instead). |

**Cache.** A passing check is remembered per claim, in memory, under the key `HEAD sha` + hash of the script text. Before
running a check the guard reads `git rev-parse HEAD` and `git status --porcelain` (5 s timeout each); when the tree
is clean and the key has a passing result, the issue is moved without running the script and the tool result carries
`note: "cached result for <sha>"` (logged as `checks_cached`; no phase change, no `checks_finished`). The key includes
the script (and the name of a named check), so the shipped final gate of `In review` runs its own checks. A
new commit, a changed script, or any uncommitted change runs the check again; failures and errors are never cached; if
git fails (e.g. no repository) the check simply runs. The cache is not persisted and not shared between issues, so
a service restart or a new claim runs the checks again.

Because a failed check leaves the column unchanged, reconciliation never stops the run halfway and the agent gets the
feedback in the same session. Checks of one session run one after the other; stopping the run (e.g. a human moves the
card to `Done`) kills a running check's process group. Without `roles` and `checks`, only the terminal-target rule
applies.

While a check runs, the run is in phase `RunningChecks`: stall detection is suspended and its clock starts fresh when
the check ends, and the `set_status` tool call may last `checks.timeout_ms` (or the longest sum of a column's named
checks) `+ 60 s`
(see [agent-claude.md](agent-claude.md#timeouts-and-failures)). Each check logs `checks_started` and
`checks_finished` (`target`, `sha`, `exit_code`, `duration_ms`, `ok`) at info level, writes a `checks_finished`
line to the [repository log](#repository-logs) and becomes `last_check` in `GET /api/v1/<identifier>`; while the checks of a move run, `gate` in the same response lists every check of the column with its state, and the agent page shows it as *Entry checks* (see [usage](usage.md#dashboard-and-api)). Denied targets
write a `transition_denied` line.

### `agent`

| Key | Default | Notes |
|---|---|---|
| `max_concurrent_agents` | `10` | `0` pauses new dispatches; running agents continue. |
| `max_turns` | `20` | Turns per agent session; between turns Symphony re-reads the issue and stops if it left the active states or moved to a column served by another [role](#roles). |
| `max_continuations` | unlimited | After a session ends normally while the issue is still active, Symphony starts another one (a *continuation session*). With a limit, an issue that is still active after that many continuation sessions is **paused**: it stays claimed and nothing new starts. It resumes as soon as it changes on the tracker (status, comment, labels, edit), leaves the active states, the limit is raised or removed, or an operator restarts it (`POST /api/v1/<identifier>/retry`, which also restarts workers waiting in the retry queue). `0` = pause right after the first session. A switch to another [role](#roles) also ends the session and counts as a continuation; a session that hands the issue on with a recorded [result](results.md) starts the count again, unless the move after the result failed. |
| `max_issue_cost_usd` | unlimited | Cost cap in USD for one issue across all its stages. Before each dispatch Symphony sums the issue's run costs from the repository history (every role) plus a running run; once the sum reaches the cap, the next stage does not start and the issue is **paused** with a comment saying why. A running stage is not stopped. The cap holds after a restart. Only **Resume now**, **Start now**, a raised or removed cap, a terminal state or leaving the board lifts the pause; board changes do not. Must be positive. See [Cost budget per issue](usage.md#cost-budget-per-issue). |
| `max_session_limit_retries` | `3` | Retries per issue after the first session-limit failure (with the usual 10 s, 20 s, … backoff), before the worker waits for the reset (`retry at` = reset + 60 s). `0` = wait right away. An unknown reset, or one more than 8 days ahead, keeps the failure backoff instead. The wait is in memory only and is forgotten on restart. A model limit (`seven_day_opus`, `seven_day_sonnet`, or a message naming a model such as Fable) skips these retries and holds the model instead, see `model_hold_ms`. While a worker waits for an account-wide limit (`five_hour` or `seven_day` without a model in the message), no new issues are dispatched; running agents and retries continue. `GET /api/v1/state` reports this as `health.dispatch_gate` (`{ reason: "session_limit", window, until, issue_identifier }`, else `null`); it ends with the last wait, a restart or release of the waiting worker, or a successful turn of any agent after the limit was observed. See [Session limit](usage.md#session-limit). |
| `model_hold_ms` | `3600000` | How long a model stays on hold after a model limit (e.g. `You've reached your Fable limit`) whose message names no reset. With a reset the hold lasts until the reset + 60 s. While a model is on hold, no issue that would run on it starts; its issues wait in the retry queue, the other models keep running, and no issue moves to another model. Holds are stored under `<logDir>/state/` and survive a restart. `GET /api/v1/state` reports them as `model_holds[]`. See [Model limits](usage.md#model-limits). |
| `max_retry_backoff_ms` | `300000` | Cap for failure retries (10 s, 20 s, 40 s, …). |
| `max_concurrent_agents_by_state` | `{}` | Per-status limits, e.g. `{ "In Progress": 1 }`. Invalid entries are ignored with a warning. |
| `reserved_slots_by_role` | `{}` | Slots kept free for a [role](#roles), e.g. `{ developer: 1, reviewer: 1 }`, so a developer and a reviewer can always run side by side. An issue of role R starts only while the free slots exceed the unused reservations of the other roles (Σ max(0, reserved − running)); a reserved slot stays empty while its role has nothing to do. Command roles (`planner`, `auditor`, …) count as their own roles and never use the developer's reservation. Column limits still apply. Names that are not roles, and values that are not integers of `0` or more, are ignored with a warning. If the reservations add up to more than `max_concurrent_agents`, they are ignored and the dashboard shows a problem. See [Reserved slots](#reserved-slots). |
| `continuation_prompt` | built-in | Liquid template sent on turn 2+ of a session (variables: `issue`, `attempt`, `role`, `agents`, `brain`, `brain_index`, `results`, `round`, `result_required`, `test_paths`, `attachments`, `human_feedback`, `turn_number`, `max_turns`). |

#### Reserved slots

Without reservations, the first issues in [dispatch order](usage.md#dispatch-order) take every slot: with
`max_concurrent_agents: 3` three developers can run while an issue in `Agent review` waits for one of them to finish.
`reserved_slots_by_role: { developer: 1, reviewer: 1 }` keeps one slot for each of them:

| Running | Waiting | What starts |
|---|---|---|
| nothing | 5 issues in `Ready` | 2 developers; the third slot stays free for the reviewer (`reserved_for_role`, "the free slot is reserved for reviewer") |
| 2 developers | an issue in `Agent review` | its reviewer, at the next tick; both developers keep running |
| nothing | 2 `/plan` issues, 1 issue in `Ready` | 1 planner and 1 developer; the second planner waits, since the 2 other slots are reserved |

A reserved slot that its role does not use is idle capacity; that is the price of the guaranteed parallelism. When the
reservations take every slot (`max_concurrent_agents: 2` with the example above), roles without a reservation never
start; the dashboard notes it at the slot settings. When a result leads issues to such a role (the optional
[test engineer](#the-test-engineer) behind `Testing`), Symphony also logs a warning and lists the problem under
`limits.slot_problems` and in the dashboard's problem list, since the issues would wait in that column for good.

#### Agent slots set on the dashboard

`max_concurrent_agents`, `max_concurrent_agents_by_state` and `reserved_slots_by_role` can also be changed at runtime, on the dashboard or with
`PUT /api/v1/settings/agents` (see [Dashboard and API](usage.md#dashboard-and-api)). The value in force comes from the
first of:

1. the dashboard override (stored as `settings` in the runtime state file under `<logDir>/state/`, so it survives a
   restart),
2. `WORKFLOW.md`,
3. the `${VAR:-default}` fallback inside `WORKFLOW.md` (e.g. `SYMPHONY_MAX_CONCURRENT_AGENTS`, read once at start).

A reload of `WORKFLOW.md` does not overwrite an override; the dashboard then shows both values. Per column, an
override replaces that column's limit only; the other columns keep theirs; the same holds per role for the
reservations. **Reset to WORKFLOW.md** (`DELETE /api/v1/settings/agents`) removes the override. The dashboard accepts
`0`–`50` for the total (`0` pauses new dispatches), `1`–`50` per active column and `0`–`50` reserved slots per role. It
refuses (`400`) a total or a reservation that would leave fewer slots than reserved; a total of `0` is always allowed. A change applies from the next tick (requested at once); lowering the limit
below the number of running agents stops none of them, nothing new starts until the count is below the limit. Each
change writes a `settings_changed` line to the [repository log](#repository-logs) (`source`, old and new values) and an
info log line. Each Symphony instance has its own override; there is no shared budget across instances.

### `claude`

| Key | Default | Notes |
|---|---|---|
| `model` | Claude Code default | Default model: alias (`fable`, `opus`, `sonnet`, `haiku`) or full model id. A role's `claude.model` and a `Model: <model>` issue label override it, see [Model per issue](#model-per-issue). |
| `fallback_model` | none | Used when the primary model is overloaded. Left out for a session whose model is the same (the Agent SDK refuses that combination). |
| `effort` | Claude Code default | `low`, `medium`, `high`, `xhigh`, `max`. The shipped `WORKFLOW.md` reads it from `CLAUDE_EFFORT`. A role's `claude.effort` and an `Effort: <level>` issue label override it, see [Effort per issue](#effort-per-issue). |
| `permission_mode` | `auto` | `auto` (a classifier approves or blocks each action), `default`, `acceptEdits`, `dontAsk`, `plan`, `bypassPermissions`. See [agent-claude.md](agent-claude.md). |
| `on_permission_request` | `deny` | Answer when Claude Code asks for approval: `deny` or `approve`. |
| `allowed_tools` / `disallowed_tools` | `[]` | Claude Code permission rules, e.g. `"Bash(git push:*)"`. Tracker tools are always allowed; `AskUserQuestion` is always disallowed. |
| `by_model` | `{}` | Permission overrides per model, for models that cannot run in `permission_mode: auto` (Haiku). Keys name a model like a `Model:` label does (`haiku`, `haiku-4-5`, `claude-haiku-4-5`); an unknown name is a config error. Each entry takes `permission_mode` and `on_permission_request` (replace the values above) and `allowed_tools` / `disallowed_tools` (appended after the global and the role's). A key matches the model family or version and every id below it: `haiku` covers `haiku`, `claude-haiku-4-5` and `claude-haiku-4-5-20251001`; with several matches the longest key wins. See [Permissions per model](#permissions-per-model). |
| `setting_sources` | `[project]` | Which Claude Code settings to load: `project` (the repository's `.claude/settings.json` and `CLAUDE.md`), `local`, `user` (your personal `~/.claude` settings, plugins and hooks). |
| `strict_mcp_config` | `true` | Only the MCP servers Symphony passes (the `tracker` server and workspace extensions such as Laravel Boost) load. A repository's `.mcp.json`, user settings, plugin-provided MCP servers and the account's claude.ai connectors are ignored. `false` lets them load; a repository's `.mcp.json` then loads without approval. |
| `sandbox` | none | Passed to Claude Code's sandbox settings (`enabled`, `network`, `filesystem`, …). |
| `append_system_prompt` | none | Extra text appended to Claude Code's system prompt. |
| `max_budget_usd` | none | Cost cap per agent session; the turn fails when it is exceeded. |
| `persist_session` | `true` | Keep transcripts in `~/.claude/projects` so a session can be inspected with `claude --resume <id>`. |
| `env` | `{}` | Extra environment variables for the agent process. They win over Symphony's defaults, e.g. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0"` allows background tasks again ([why they are off](agent-claude.md#subagents)). |
| `executable` | bundled CLI | Path to another Claude Code executable. |
| `plugins` | `[]` | Local Claude Code plugin directories loaded into every session (skills, subagents, commands, hooks), relative to `WORKFLOW.md`. The shipped `WORKFLOW.md` loads `./.claude`, Symphony's own toolbox; its skills are named `symphony:<skill>`. A missing directory blocks dispatch. |
| `skills` | Claude Code default | `all` enables every discovered skill (the repository's, a plugin's, Laravel Boost's) and the Skill tool; a list enables only those names (`testing-best-practices`, `symphony:handoff`). |
| `turn_timeout_ms` | `3600000` | A turn fails after this long **without any output** from the agent. |
| `read_timeout_ms` | `30000` | Startup handshake timeout; also bounds the wait for `pending` MCP servers Symphony added. |
| `stall_timeout_ms` | `300000` | The orchestrator kills and retries a run without any agent event for this long; `<= 0` disables it. |

### `laravel`

`laravel` is an *integration section*: it belongs to a workspace integration (`src/laravel/integration.ts`, registered
in `src/integrations/registry.ts`), not to the core. Each registered integration resolves its own section; its errors
join the other `invalid_config` errors (a reload with an invalid value keeps the last good version), and the result
lands in `config.integrations.<id>`. Laravel is the only integration so far.

Laravel Boost for Laravel apps in the workspace. After the `before_run` hook, Symphony looks for Laravel apps in the
checkout (the root and one level deep: `artisan` plus a `composer.json` that requires `laravel/framework`). For each
app that requires `laravel/boost`, it installs Composer dependencies if needed, generates Boost's guidelines and skills
for Claude Code, keeps the generated files out of commits, and adds Boost's MCP server to the session. Apps without
Boost only get a log line; `npm run repo-init` creates an issue that adds it. One `integration_prepared` log line lists the
versions from `composer.lock` and the Boost status (`ready`, `failed`, `skipped`, `absent`) of each app; the dry run shows
the versions for existing workspaces. When Boost is `failed` or `skipped` for an app, the prompt says so and points the
agent to `artisan` and `composer` in the shell. Details:
[agent-claude.md](agent-claude.md#workspace-extensions-laravel-boost). What a repository must provide for this to work
(`AGENTS.md`, `.ai/`, composer scripts, `.env.example`, `phpunit.xml`) is described in
[Laravel repositories](laravel-repositories.md).

| Key | Default | Notes |
|---|---|---|
| `boost` | `auto` | `auto`: use Boost where a Laravel app requires it. `off`: never. |
| `php` | `php` | PHP command for `artisan`. A bare name is looked up on `PATH`; a value with `/` or `~` is a path, relative to `WORKFLOW.md`. A wrapper script (for example one that runs PHP in a per-workspace container) receives the absolute `artisan` path as its first argument and `SYMPHONY_WORKSPACE` in its environment. |
| `composer` | `composer` | Composer command, resolved like `php`. |
| `install_dependencies` | `true` | Run `composer install` when `vendor/` is missing or `composer.lock` changed since the last install. Off: apps without `vendor/` run without Boost. |
| `env` | `{ APP_ENV: local }` | Environment for Symphony's Composer and `artisan` steps and the Boost MCP server, not for the agent's shell. Boost only registers its commands with `APP_ENV=local` (or `APP_DEBUG=true`), and a fresh clone has no `.env`. Entries are merged over the default. Database settings belong in the app's `.env` (see [Recipe: Laravel apps](#recipe-laravel-apps)), not here. |
| `agent_env` | `{}` | Variables added to the agent's own environment in Boost sessions (its shell, tests, `artisan`). Keep it empty unless needed: an `APP_ENV` set here overrides PHPUnit's non-forced `APP_ENV=testing`, and `DB_*` values would send tests and `RefreshDatabase` to that database. |
| `allow_tinker` | `false` | Allow Boost's `tinker` tool, which runs arbitrary PHP. Off: `tinker` is denied, even if the repository enables it (`boost.tinker_tool_enabled`). |
| `deny_tools` | `[record-rule]` | Boost tools removed from the session. A listed tool is also dropped from the pre-approved ones, e.g. `[search-docs, record-rule]` keeps queries away from boost.laravel.com. `[]` allows `record-rule` (it writes `.ai/rules`) after the permission check. |
| `timeout_ms` | `hooks.timeout_ms` | Limit for each Composer or `artisan` step. |

### `roles`

Optional. Maps board columns to column-scoped agent roles. Without it, every active state is served by one implicit role named `default` and nothing changes.

When an issue is dispatched, the role serving its current column (and its [command](#issue-commands), if any) is
resolved once and kept for the whole run (an issue no role serves runs as `default`). The role decides:

- **Model:** a `Model: …` issue label (unless `model_label: ignore`), else the role's `claude.model_by_complexity` for
  the issue's `Complexity:` label, else the role's `claude.model`, else `claude.model` (see [Model per issue](#model-per-issue)).
- **Effort:** an `Effort: …` issue label (unless `effort_label: ignore`), else the role's `claude.effort`, else
  `claude.effort` (see [Effort per issue](#effort-per-issue)).
- **Claude settings:** the role's `claude` block is merged over [`claude`](#claude): `max_budget_usd`
  replaces the global value; `allowed_tools`, `disallowed_tools` and `append_system_prompt` are appended to it.
- **Permissions:** `read_only: true` starts the session read-only ([agent-claude.md](agent-claude.md#permission-and-safety-posture)).
- **Turns:** `max_turns` replaces `agent.max_turns` for the role's sessions.
- **Checks:** `run_checks: false` skips the [`checks.on_enter`](#transition-guard) scripts for the role's status changes.
- **Tools:** a role with `max_sub_issues` gets the tracker tool that creates sub-issues; other roles do not see it.
  `sub_issue_status` picks the column those sub-issues land in.
- **Waves:** `wait_for_sub_issues: true` holds the role's issues back while any of their sub-issues is open (see
  [Waves](#waves-wait_for_sub_issues)).
- **Subagents:** `agents` lists the plugin subagents the role may start; the others are denied for its sessions (see
  [Subagents per role](#subagents-per-role)).
- **Prompt:** the role name is the template variable `role` (see [Prompt template](#prompt-template)).

The role appears as `role` in the `dispatching issue` log line, in `run_started` of the repository log and on every
agent event log line (together with `run_id`).

**Role switches.** A run keeps its role for its whole session. After each turn Symphony re-reads the issue; when the
agent moved it to a column served by a **different** role (e.g. `In progress` → `Agent review`), the session ends at
that turn boundary with the reason `role changed (<from> → <to>)`, and the next role starts in a fresh session through
the usual continuation retry (1 s later). A move between columns of the same role (e.g. `Ready` → `In progress`) keeps
the session. Reconciliation never stops a running session because of a role change, so the agent can finish its
handoff (e.g. a comment) within the current turn. The run's `run_finished` line records `outcome=handed_off` with
`next_role` (every `run_finished` line carries the `role` of the run; see [Repository logs](#repository-logs)).

Each role switch starts a continuation session and therefore counts toward
[`agent.max_continuations`](#agent). This also caps a developer ↔ reviewer ping-pong: once the limit is reached, the
issue is paused until it changes on the board. With roles, `max_continuations: 6` is a good starting point (room for a
few review rounds plus continuations within each phase).

```yaml
roles:
  developer:
    states: [Ready, In progress]
    may_move_to: [In progress, Agent review, Blocked]
  reviewer:
    states: [Agent review]
    read_only: true
    max_turns: 6
    may_move_to: [In review, In progress, Blocked]
    claude: { model: opus }
```

| Key | Default | Notes |
|---|---|---|
| `states` | required | Active states the role serves; matched case-insensitively. |
| `read_only` | `false` | The role's agent must not change the repository. |
| `may_move_to` | unrestricted | Column names the agent may move the issue to, matched case-insensitively and enforced by the [transition guard](#transition-guard). Free-form; not checked against the board here. Terminal columns are never allowed. |
| `result` | none | Kind of the stage result the role reports: `analysis`, `design`, `implementation`, `test`, `review`, `security` or `docs` (see [result contracts](#result-driven-transitions)). Setting only this key is enough for a minimal result role. The role hands off with the [`report_result`](results.md#the-report_result-tool) tool and does not get `set_status`. |
| `on_result` | `{}` | Column per verdict of `result`, or `next` (the next active stage after the role's columns in board order). Needs `result`. See [Result-driven transitions](#result-driven-transitions). |
| `on_check_failed` | none | Column for an issue whose entry check fails for a role that cannot fix it (a read-only role). When the check of the column a `report_result` leads to fails, the tool records the result anyway, adds a note with the check output to its summary and moves the issue here (through the transition guard, so this column's own entry check applies). Without it the agent gets `check_failed` and nothing is recorded. Ignored for roles that are not `read_only`. |
| `on_missing_result` | `Blocked` with `result`, else none | Column for a session that ends without a result. Needs `result`. After the first turn without a result the session gets one reminder turn; if the turn limit comes first or the reminder fails too, Symphony re-fetches the issue and, only if it is still in the role's column, posts a plain comment ("Stage ended without a result") and moves it here. An issue someone moved meanwhile is left alone. See [Stages without a result](results.md#stages-without-a-result). |
| `on_round_limit` | the blocked column | Column for a loop verdict (review `changes_needed`, test `failed`, security `issues_found`) that reaches `pipeline.max_review_rounds` / `max_test_rounds` / `max_security_rounds`. Also the target of the hand-off that reaches `pipeline.max_check_failures` instead of `on_check_failed`. Needs `result: review`, `result: test` or `result: security`. See [Result-driven transitions](#result-driven-transitions). |
| `model_label` | `apply`; `ignore` for read-only roles with a `result` | `ignore` keeps a `Model:` issue label from changing the role's model (`model_by_complexity` still applies). |
| `effort_label` | `apply` | `ignore` keeps an `Effort:` issue label from changing the role's effort: the session runs with the role's `claude.effort`, else `claude.effort`. The shipped `WORKFLOW.md` sets it for the roles with a fixed task, so a label like `Effort: xhigh` raises the developer's effort, not the reviewer's or the docs agent's. |
| `max_turns` | `agent.max_turns` | Integer >= 1. |
| `commands` | none | Issue commands the role serves, e.g. `[refactoring]` (lowercase letters, digits and dashes; a leading `/` is allowed). Without it the role serves issues without a command. See [Issue commands](#issue-commands). |
| `run_checks` | `true` | `false` lets the role move the issue without running `checks.on_enter`. For roles that change nothing, whose hand-off must not depend on the repository's test suite. |
| `max_sub_issues` | none | Integer 1–100 (GitHub's limit): how many sub-issues the role may have open under its issue at once, counting the sub-issues of those (the whole tree when the role creates epics with `parent`). Setting it gives the role the GitHub tool `create_sub_issue` ([github-project.md](adapters/github-project.md#agent-tools)). |
| `sub_issue_status` | `tracker.provider.sub_issue_status` | Column for the sub-issues this role creates. Unlike the provider setting it may be an active column, so the sub-issues start without a human; this is the deliberate opt-in for autonomous roles such as the autopilot. Never a terminal column; needs `max_sub_issues`. Checked against the board like the other columns. |
| `wait_for_sub_issues` | `false` | `true` dispatches the role's issues only while none of their sub-issues is open. See [Waves](#waves-wait_for_sub_issues). |
| `brain` | `off` | Brain tools of the role's sessions: `off` none, `read` only `brain_search`, `brain_read`, `brain_list`, `write` also `brain_write` and `brain_append`. Only has an effect with [`brain.enabled`](#brain); without it no role gets brain tools. Roles are never given the vault as a directory. The shipped `WORKFLOW.md` sets `write` for `issue-analyst`, `architect` and `reviewer`, `read` for `developer`, `test-engineer` and `security-auditor`; `docs` and the command roles stay `off`. An existing `WORKFLOW.md` without the field gives no role brain tools anymore. Roles with `read` or `write` get the prompt section `roles/brain.md`. |
| `agents` | all | Plugin subagents (`agents/<name>.md` in [`claude.plugins`](#claude), names without the plugin prefix, e.g. `[laravel-code-reviewer]`) the role may start; `[]` allows none. See [Subagents per role](#subagents-per-role). |
| `claude` | `{}` | Overrides of `model`, `effort`, `allowed_tools`, `disallowed_tools`, `append_system_prompt`, `max_budget_usd` (same meaning as in [`claude`](#claude)). |

#### Result-driven transitions

A role that reports a stage result names the kind in `result` and says where each verdict leads:

```yaml
roles:
  reviewer:
    states: [Agent review]
    read_only: true
    result: review
    may_move_to: [In review, In progress, Blocked]
    on_result: { approved: In review, changes_needed: In progress, blocked: Blocked }
    on_round_limit: In review
    on_check_failed: In progress
```

- The verdicts of each kind are `analysis`: `ready`, `needs_info`; `design`: `ready`, `split`, `blocked`;
  `implementation`: `done`, `blocked`; `test`: `passed`, `failed`, `blocked`; `review`: `approved`, `changes_needed`,
  `blocked`; `security`: `passed`, `issues_found`, `blocked`; `docs`: `done`, `not_needed`, `blocked`. A verdict may be
  left out. `split` (a design split into [work packages](#work-packages-split)) needs `max_sub_issues` on the role, in
  `on_result` as in a profile's `on_result`.
- A target is a column name or `next`. `next` needs the board's column order (tracker kinds that list columns, such as
  `github_project`) and a later active stage, whose column must be in `may_move_to` when the role sets it; it is
  checked together with the board preflight.
- Targets are never terminal columns. Those that name a column are added to `may_move_to` (without duplicates), so the
  [transition guard](#transition-guard), the board preflight and the dashboard's pipeline view know them. A role
  without `may_move_to` stays unrestricted, but its targets are still checked against the board.

The target of a result is computed, not chosen by the agent (`resolveTransition` in `src/orchestrator/transitions.ts`,
used by the [`report_result`](results.md#the-report_result-tool) tool, which a session gets together with the stage
history at its start). The rules apply in this order:

1. **`blocked`** goes to `on_result.blocked` when it names a column, else to the blocked column: the column every role
   with `may_move_to` lists besides the active and terminal ones (`Blocked` in the default workflow), else the role's
   `on_missing_result`.
2. **Round limit.** A review with `changes_needed`, a test with `failed` or a security review with `issues_found` is
   round N, where N - 1 is the number of such results since the last reset. When N reaches
   `pipeline.max_review_rounds` / `max_test_rounds` / `max_security_rounds` (with the defaults: the 3rd
   `changes_needed`, the 2nd `failed`, the 2nd `issues_found`), the issue goes to `on_round_limit` (else the blocked column)
   and gets `pipeline.limit_label`. Every other transition removes that label.
   **Check failures.** A hand-off whose entry check failed and went to `on_check_failed` is no round, but it is counted
   per issue, across rounds and roles, from the result markers (`check_failed_for`; a `reset` result starts again). The
   hand-off that reaches `pipeline.max_check_failures` (default 3, so the 3rd) goes to `on_round_limit` (else the blocked
   column) instead, gets `pipeline.limit_label`, and its comment names the repeatedly failing checks.
3. **`on_result[verdict]`.** `next` is the first active column after the role's columns in board order whose role is
   not skipped by the issue's profile and whose stage condition holds. A verdict without a target goes to the blocked
   column. A reviewer's `approved` that leads out of the active columns (to `In review`) goes to the
   [security review](#the-security-auditor) first when the issue needs it.

The target is always a column the role may move to; a computed target outside `may_move_to` is refused, never used.

Every misconfiguration is an `invalid_config` error naming the field, e.g.
`roles.reviewer.on_result.passed: "passed" is not a verdict of result review (allowed: approved, changes_needed, blocked)`
or `roles.reviewer.on_result.approved must not be a terminal state (got "Done")`.

Invalid configs fail with `invalid_config`, listing every problem: a state outside `tracker.active_states`, a state in more than one role (two roles may share a state only for different commands), an active state without a role that has no `commands` (once `roles` is set), a command that is not a name or an empty `commands` list, `max_sub_issues` outside 1–100, a `sub_issue_status` that is terminal or set without `max_sub_issues`, unknown keys under a role or its `claude` block, and invalid value types. Dispatch validation also fails while a role's command has no skill in [`claude.plugins`](#claude): `roles.auditor.commands: no skill for /refactoring in claude.plugins (expected skills/refactoring/SKILL.md)`, while a role lists a subagent no plugin ships (`roles.reviewer.agents: no subagent … in claude.plugins`), and while a read-only role lists a subagent that can edit files (`roles.reviewer.agents: laravel-filament-developer can edit files, but the role is read-only`). With `roles` set and `agent.max_continuations` unlimited, a warning is logged because role switches will count as continuations.

#### The shipped developer and reviewer

The shipped `WORKFLOW.md` runs its two main roles on this mechanism:

```yaml
roles:
  developer:
    states: [In progress]
    result: implementation
    on_result: { done: Agent review, blocked: Blocked }
  reviewer:
    states: [Agent review]
    read_only: true
    result: review
    on_result: { approved: In review, changes_needed: In progress, blocked: Blocked }
    on_check_failed: In progress
pipeline:
  max_review_rounds: 3
```

- Both hand off with [`report_result`](results.md#the-report_result-tool) and have no `set_status`. The developer's
  summary, the reviewer's findings and the verdict are the result, posted by Symphony as the issue comment; neither
  prompt asks for a separate summary comment. The developer therefore cannot move an issue itself: it stays in its
  column until the result moves it.
- The reviewer prompt no longer counts review comments. Symphony counts the rounds: the third `changes_needed` goes to
  the blocked column (`Blocked`) with the `needs-human` label instead of back to the developer (set
  `roles.reviewer.on_round_limit` to choose another column). A human moving the issue back to an active column resets the
  rounds.
- The open findings of the latest review reach the developer through the prompt variable `results.open_findings`
  (and the reviewer sees the findings it asked to fix), see [Prompt template](#prompt-template).
- If the entry check of the approved target (`In review`) fails, the reviewer cannot repair the code: the result is
  recorded, the check output is appended to its summary and the issue goes back to `In progress` (`on_check_failed`).

Merging a change to these keys changes the running instance at once (live reload), so merge by hand when no issue is
active.

#### The issue analyst

Before anything is implemented, the shipped `WORKFLOW.md` serves every issue in `Ready` with a read-only issue analyst
(the role is named `issue-analyst`: `analyst` is the role of the `/concept` command). The developer serves only
`In progress`.

```yaml
roles:
  issue-analyst:
    states: [Ready]
    read_only: true
    max_turns: 3
    result: analysis
    on_result: { ready: next, needs_info: Blocked }
    may_move_to: [Design, In progress, Blocked]
    model_label: ignore               # sonnet, whatever the issue's Model: label picks for the developer
    agents: [laravel-architect]
    claude: { model: sonnet }
```

- The analyst reads the project instructions and the code and reports an [`analysis` result](results.md#kinds):
  requirements in the summary, `components`, refined `acceptance_criteria`, `risks`, `docs_needed`, the `plan`, and a
  `type` and `complexity`. `ready` moves the issue on (`next`: `Design` for a larger change, else `In progress`; see
  [The architect](#the-architect)); `needs_info`
  needs at least one open question, moves the issue to `Blocked` and shows the questions in the comment. A human answers
  in a comment and moves the issue back to `Ready`; the analyst then runs again.
- **Labels.** Right before the status change, `report_result` sets the issue's `Type:` and `Complexity:` labels from the
  analysis where it has none (see [Labels from the analysis](results.md#labels-from-the-analysis)). A label a human set
  always wins, and an alias such as `bug` or `feature` counts as a type label.
- **Input for later stages.** The architect, the developer, the test engineer and the reviewer get the newest analysis in
  their prompt (`results.analysis`, see [Prompt template](#prompt-template)).
- **Cost.** The analyst runs for every issue in `Ready`. `pipeline.analysis: when_unlabeled` skips it, without a
  session, for issues that already carry a `Type:` and a `Complexity:` label (see
  [Skipping stages without a session](#skipping-stages-without-a-session)).
- **Slots.** The analyst has no reserved slot, so it needs a slot beyond the ones kept for the developer and the reviewer:
  the shipped `agent.max_concurrent_agents` is 3. With 2 slots no issue in `Ready` would start; the dashboard and the log
  name the stage that never starts.

#### The architect

Larger features and refactorings get an explicit architecture decision before the implementation. The shipped
`WORKFLOW.md` has a `Design` column between `Ready` and `In progress` and a read-only `architect` role for it. Small
issues skip the column without a session, so a bugfix of complexity `S` costs nothing extra.

```yaml
roles:
  architect:
    states: [Design]
    read_only: true
    run_checks: false                 # nothing changes: no entry check before Agent review for a split issue
    max_sub_issues: ${SYMPHONY_ARCHITECT_MAX_SUB_ISSUES:-5}
    sub_issue_status: Ready           # the work packages start without a human
    max_turns: 4
    result: design
    on_result: { ready: In progress, split: Agent review, blocked: Blocked }
    may_move_to: [In progress, Agent review, Blocked]
    model_label: ignore               # opus, whatever the issue's Model: label picks for the developer
    agents: [laravel-architect]
    claude: { model: opus }
```

- The architect reads the code and reports a [`design` result](results.md#kinds): the `options` it compared, the
  `decision`, the `components` and `interfaces` of the change, `migrations` and `compatibility`. `ready` needs a decision
  and at least one component and one interface (`report_result` refuses a generic design with `invalid_result`);
  `blocked` needs a blocker and moves the issue to `Blocked`. It may start the `laravel-architect` subagent.
- **The developer implements the design.** `ready` moves the issue to `In progress`, and the developer's prompt contains
  the newest design (`results.design`, see [Prompt template](#prompt-template)). Where the design does not fit the code,
  the developer deviates and says so in `plan_deviations`.
- **When it runs.** The condition is `skip_when` in the [workflow profile](#workflow-profiles): the shipped
  `WORKFLOW.md` skips the architect for features, refactors and untyped issues of complexity `S` (they run it from `M`),
  and for bugfixes of complexity `S` and `M` (only `L` and `XL` run it). The complexity is the issue's `Complexity:`
  label, which the issue analyst sets.
- **No usable complexity label: the stage runs.** An issue without a `Complexity:` label, with an unknown value or with
  conflicting labels cannot be judged small, so `skip_when` never matches and the architect runs.
- **Board and entry checks.** The `Design` column must exist on the board, in order between `Ready` and `In progress`,
  and be an active state. A skipped stage moves the issue without a workspace, so neither `Design` nor the column after it
  (`In progress`) may have a `checks.on_enter` script; the dispatch preflight reports a configuration that does
  (`pipeline.profiles.feature.skip_when.architect: skipping architect moves issues from "Design" to … without a
  workspace, but checks.on_enter has a script for …`).
- **Slots.** Like the analyst, the architect has no reserved slot and needs one beyond the ones kept for the developer
  and the reviewer; a skipped stage needs none.
- **Work packages.** An issue of complexity `XL` may be split instead of designed for one developer, see below. For
  every other issue `work_packages` stays optional and `split` is refused.

##### Work packages (`split`)

A very large change can be split into work packages that run in parallel, each as a sub-issue with its own pipeline,
workspace, branch and pull request. The architect decides; Symphony enforces when it may and routes the issue:

- **When.** Only for an issue of complexity `XL` (its `Complexity:` label) that is not a sub-issue itself, and only from
  a role with `max_sub_issues`. `report_result` refuses `split` with `invalid_result` otherwise (also with fewer than
  two `work_packages`, or more than `max_sub_issues`), so small and medium issues keep the normal flow and a work
  package is never split again. A role that reports a `design` gets `create_sub_issue` only on such an issue: on any
  other one, a work package included, the tool is not offered and the session has no sub-issue limit, so its
  `max_sub_issues` cannot be used to file sub-issues next to a `ready` design. The shipped architect prompt mentions
  `split` and `create_sub_issue` only where they apply.
- **How.** The architect lists the packages in `work_packages` (implementation order) and files one sub-issue per
  package with `create_sub_issue` in that order: a body that stands on its own (goal, the part of the design, the
  acceptance criteria it covers, "Part of #N"), a `Type:` and a `Complexity:` label of its own size (plus `security`
  where the parent is security-relevant and the package touches that risk), and `blocked_by` for a package that builds
  on another one. `split` needs a decision, components and interfaces like `ready`, and
  `report_result` refuses it while the issue has fewer sub-issues than `work_packages` (read fresh from the tracker).
  A title that exists is returned instead of created twice, so an interrupted architect files only the missing ones.
- **The packages.** `sub_issue_status: Ready` puts them where the issue analyst picks them up right away; each one runs
  the normal pipeline and is closed when its pull request is merged. A package with `blocked_by` waits for the packages
  it builds on. A pull request that conflicts with the base branch after another package was merged goes back through
  [`auto_merge.on_conflict`](adapters/github-project.md#auto-merge) to its developer, like any other.
- **The parent waits.** `on_result.split` sends the issue to the reviewer's column (`Agent review`) past the developer,
  the test engineer and the documentation stage; the pipeline view shows those stages as skipped (each package documents
  its own change). While any sub-issue is open the issue is not
  dispatchable (`respect_sub_issues`): no session, not even with *Start now*, and the queue and `npm run dry-run` show
  `waiting for sub-issues …`. The architect's own session is not stopped by the sub-issues it opens: a running session
  of a role that may create sub-issues on its issue goes on while only open sub-issues hold it back (in practice the
  work packages it filed; one a human adds counts the same), until it reports.
  `run_checks: false` keeps the move into `Agent review` free of an entry check, since nothing changed.
- **Integration review.** Once the last sub-issue is closed (also as not planned), the reviewer runs in integration
  mode: the shipped prompt switches when the issue has sub-issues and no implementation of its own
  (`results.implementation` is `null`). It lists every package with its state and `state_reason`, reviews the commits
  the packages brought into the base branch (from the design's `head_sha`) against the issue's acceptance criteria and
  reports a normal `review` result. The workspace sits at the tip of `origin/<base>` (the shipped `before_run` hook
  fast-forwards a workspace that is still on the base branch), so the entry check of `In review` runs on the
  integrated base branch. A package closed as not planned did not deliver its part: the prompt asks for a `major`
  finding where a criterion still needs it.
- **Outcome.** The review transitions route it: `approved` goes to `In review` after the entry check, or first to the
  [security auditor](#the-security-auditor) when the parent needs the audit (see below); `changes_needed` goes to
  `In progress`, where the issue's own developer fixes the findings on the issue's branch with its own pull request
  (the developer prompt says the packages are merged and only the findings are left); that pull request then takes the
  normal path of the issue's profile and gets a normal review. The round limit applies as usual.
- **Security review.** An approved integration review is checked for the security triggers like any approval: the
  parent's `security` label, `risks.security` in its analysis, or a file matching `pipeline.security_paths` among the
  files the packages changed. The parent has no branch of its own and its workspace is at the tip of the base branch,
  so these files are measured from the commit the design was made at (the `head_sha` of the `split` result), not from
  the base branch; without that commit the audit is needed, to be safe. The security auditor then runs in integration
  mode (same switch as the reviewer): it lists the packages, audits `git diff <design head>..origin/<base>` on the base
  checkout, and looks for what only shows across packages. `passed` goes to `In review`; `issues_found` goes to the
  parent's own developer like `changes_needed`, and the fix pull request then gets a normal review and a normal
  security review. Each package's pull request went through the security decision on its own as well.

Why this and not an integration-engineer role: see
[Work packages instead of an integration engineer](concepts/multi-agent.md#work-packages-instead-of-an-integration-engineer).

#### The test engineer

The shipped `WORKFLOW.md` also defines an independent test engineer: a role in its own column that writes and runs tests
for every acceptance criterion, so the tests do not come from the agent that wrote the code. It changes no production
code, and a failing test sends the issue back to the developer. Bug, feature and refactor issues always pass through it
(the shipped `bugfix`, `feature` and `refactor` [profiles](#workflow-profiles)); other issues only when the stage is
switched on for all of them.

```yaml
roles:
  test-engineer:
    states: [Testing]
    result: test
    on_result: { passed: Agent review, failed: In progress, blocked: Blocked }
    may_move_to: [Agent review, In progress, Blocked]
    model_label: ignore               # sonnet, whatever the issue's Model: label picks for the developer
    agents: [laravel-test-engineer]
    claude: { model: sonnet }
pipeline:
  max_test_rounds: 2
  # test_paths: [tests/**, test/**, "**/*.test.*", "**/*Test.php"]
checks:
  on_enter:
    Testing: bash "$SYMPHONY_WORKFLOW_DIR/checks/laravel.sh"
```

- **On for bug, feature and refactor issues, off by default for the rest.** The shipped
  `pipeline.profiles.{bugfix,feature,refactor}.on_result` send the developer's `done` of a bug, feature or refactor issue
  to `Testing`. For every other issue the developer's `done` leads to `Agent review`
  unless `SYMPHONY_AFTER_IMPLEMENTATION=Testing` (the shipped `on_result.done` reads it, `.env.example` documents it).
  To run bug issues without the stage, set `pipeline.profiles.bugfix.on_result.developer.done: Agent review` (likewise
  for `feature` and `refactor`). The flow is `In progress → [checks] → Testing →
  [checks] → Agent review → [checks] → In review`. `Testing` is always one of `tracker.active_states`, so the board
  needs the column (the [board preflight](#tracker) reports it as `unknown board column "Testing"`); put it between
  `In progress` and `Agent review`, because `next` and the pipeline view of the dashboard follow the board's order.
  While the stage is off, the pipeline view leaves it out: a stage served by a role with `result` shows only when the
  flow leads to its column, when the first stage serves it, or when the issue sits in it. The flow leads to a column
  through the `on_result`, `on_check_failed`, `on_missing_result` and `on_round_limit` targets of the roles and of the
  issue's profile, through `next`, and through the moves of roles that hand off with `set_status` instead of a result
  (their `may_move_to` columns, or every active column without that list; the same goes for an active column no role
  serves). A project whose developer has no `result` therefore keeps its test stage once the developer may move issues
  to `Testing`. So an issue never shows a test stage as done that did not run, and the order of the `Testing` column on
  the board does not matter until a profile or the setting leads to the stage.
- **Slots.** The test engineer is a third role next to the developer and the reviewer, whose slots
  `agent.reserved_slots_by_role` keeps free. Like the other roles it only gets slots beyond those, so allow at least
  3 agent slots (`SYMPHONY_MAX_CONCURRENT_AGENTS`) when the stage is on, or the test engineer never starts; the
  dashboard, the log and `limits.slot_problems` of the API report it when it happens. With exactly 3 slots the test
  engineer and the issue analyst share the one free slot, so allow 4 to run them side by side.
  `agent.max_concurrent_agents_by_state.Testing` is 1 in the shipped file: one test run at a time.
- **Verdicts.** `passed` leads to `Agent review`, `failed` to `In progress` (the developer), `blocked` to `Blocked`
  (see [result contracts](results.md#kinds): `cases[]`, `commands[]`, `uncovered_criteria[]`). A session that ends without
  a result goes to `on_missing_result` (`Blocked`).
- **Entry checks.** `checks.on_enter.Testing` is optional: with it the developer has to hand over green code (lint,
  static analysis, tests). `Agent review` keeps its own check, which then runs against the commit with the new tests.
  The role is not `read_only`, so `on_check_failed` does not apply: a failing check of `Agent review` goes back to the
  test engineer like it goes back to the developer, who fixes the tests or reports `failed`.
- **Only tests.** `pipeline.test_paths` (default `tests/**`, `test/**`, `**/*.test.*`, `**/*Test.php`; see
  [`pipeline`](#pipeline)) lists the only files the test engineer may change. When the engineer calls `report_result`,
  Symphony lists what differs from a baseline commit (commits since, uncommitted and untracked files, deletions and both
  ends of a renamed file; ignored files do not count) and refuses the result with `invalid_result` if a file matches
  none of the globs: the message names the offending files and the baseline, nothing is recorded and the entry check of
  the target column does not run. For `passed` and `failed` the engineer has to undo the changes it made itself
  (`git checkout <baseline> -- <file>`, commit) and report again; a file it did not change (a commit already on the
  branch, a push by someone else) it leaves alone and reports `blocked` with a blocker, which is always accepted: the
  result notes the files under its summary. If git cannot tell, or the
  workspace is no git checkout, the call fails with `tool_error` and nothing is recorded: the rule is never skipped.
  The baseline is the commit the developer's newest finished `implementation` result recorded (`head_sha`), as long as
  `HEAD` descends from it when the engineer reports, and a later session of the stage (after a `check_timeout`, say) cannot forgive what an earlier one changed.
  Without such a result, or when it is no ancestor of `HEAD` (the branch was rebased), the baseline is the commit the
  session started from. The exception: a session that started on the base branch (its start commit is an ancestor of
  `origin/<base>`) after the hand-off measures from its start, so pull requests merged while there was no issue branch
  (a spike) are not the engineer's. Local commits of an earlier session are not on `origin/<base>` and stay counted.
  A commit someone else pushes to the issue branch after the hand-off counts as the engineer's: `passed` and `failed`
  are refused, the engineer reports `blocked`.
- **Failed cases reach the developer.** After a `failed` result the prompt of the developer lists the failed cases
  (`results.failed_cases`), the test engineer's summary and the commands it ran (`results.test`, see
  [Prompt template](#prompt-template)); the test engineer sees the same list in the next round and runs those cases
  first.
- **Round limit.** `pipeline.max_test_rounds` (default 2, overridable per profile) counts `failed` results since the last
  reset. The failed result of the last allowed round goes to `on_round_limit` (default: the blocked column, `Blocked`)
  and gets the `needs-human` label (`pipeline.limit_label`) instead of going back to the developer. A human moving the
  issue back to an active column resets the rounds.
- **Skipping.** A [profile](#workflow-profiles) can list `test-engineer` in `skip` only when the column its issues go
  to next has no `checks.on_enter` script: a skipped stage moves the issue without a workspace and so cannot run one
  ([Skipping stages](#skipping-stages-without-a-session)). With the shipped `Agent review` check the preflight rejects
  such a profile. A board without a test stage still needs the `Testing` column (it is an active state, `skip` only
  changes `next`); switch the stage off by overriding the developer's `done` in the profile (see above) or for the
  whole instance.

#### The security auditor

The shipped `WORKFLOW.md` has a read-only `security-auditor` role in the `Security review` column. It audits the diff
for authorization, injection, mass assignment and leaked secrets before a human reviews the pull request. It is
conditional: only issues that need it are sent there, all others go from the reviewer straight to `In review` without
a session.

```yaml
tracker:
  active_states: [Ready, Design, In progress, Testing, Agent review, Security review]
roles:
  reviewer:
    on_result: { approved: In review, changes_needed: In progress, blocked: Blocked }
    may_move_to: [Security review, In review, In progress, Blocked]   # approved goes to Security review when needed
  security-auditor:
    states: [Security review]
    read_only: true
    max_turns: 6
    result: security
    on_result: { passed: In review, issues_found: In progress, blocked: Blocked }
    on_check_failed: In progress
    may_move_to: [In review, In progress, Blocked]
    model_label: ignore
    agents: [laravel-code-reviewer]
    claude: { model: opus }
pipeline:
  max_security_rounds: 2
  # security_paths: [app/Policies/**, app/Http/Middleware/**, config/auth.php, routes/**, database/migrations/**]
```

- **When it runs.** When the reviewer reports `approved`, `report_result` decides, before it routes the result. The
  security review is needed when **any** of these holds: the issue carries the label `security` (trimmed and compared
  case-insensitively; `area:security` or `Security: high` are other labels and do not count); the newest analysis since
  the last reset flags `risks.security`; or at least one file the branch changes matches `pipeline.security_paths`.
  When none holds, the issue goes to `In review` as `on_result.approved` says, and the transition `reason` in the tool
  result says why (`security review not needed: no trigger (…)`); the pipeline view of the dashboard shows the stage as
  skipped, because no session ran there. When a trigger holds, the `reason` names it (`security review needed: 2 changed
  file(s) match pipeline.security_paths: app/Policies/PostPolicy.php, …`).
- **The files of the branch.** Symphony runs git in the workspace (each call bounded by a 15 s timeout) against the merge
  base of `HEAD` and the base branch, `origin/<base_branch>` (`tracker.provider.base_branch`), else `origin/HEAD`: commits
  since the branch left the base, uncommitted changes and untracked files (ignored files do not count; a rename counts as
  the deletion of the old and the addition of the new path). It is the whole branch, not just the changes since the last
  hand-off. If git cannot tell (no git checkout, the base ref is unknown, a git error or timeout), the review is **needed**:
  a failure never skips the audit silently, and the `reason` says that the changed files could not be determined. The
  integration review of an issue split into [work packages](#work-packages-split) has no branch: its files are measured
  from the commit the `split` design was made at, and the auditor audits the merged packages in an integration mode.
- **`pipeline.security_paths`** defaults to the places of a Laravel app where authorization, authentication and the schema
  live: `app/Policies/**`, `app/Http/Middleware/**`, `config/auth.php`, `routes/**`, `database/migrations/**` (see
  [Path globs](#path-globs)). An explicit list replaces the defaults; `[]` turns the path trigger off, the `security`
  label and the analysis risk still apply. Path globs miss things, which is why the label and the analysis risk are
  additional triggers; outside Laravel set the list for the project's layout.
- **Verdicts.** `passed` leads to `In review` (the entry check of that column runs, and `on_check_failed` sends a failing
  one back to the developer, like for the reviewer), `issues_found` to `In progress` (the developer) with the findings
  in the prompt (`results.security_findings`, see [Prompt template](#prompt-template)), `blocked` to `Blocked`. The result
  has `findings` like a review: `passed` allows only `minor` and `nit` findings, `issues_found` needs at least one
  ([result contracts](results.md#kinds)). A session that ends without a result goes to `on_missing_result` (`Blocked`).
- **After `issues_found`** the developer fixes the findings and hands over again; the reviewer reviews the fix, and when
  it approves, the security check is evaluated again on the new diff.
- **Round limit.** `pipeline.max_security_rounds` (default 2, at least 1; no profile override) counts `issues_found`
  results since the last reset. The last allowed round goes to `on_round_limit` (default: the blocked column) with the
  `needs-human` label (`pipeline.limit_label`) instead of back to the developer. A human moving the issue back to an
  active column resets the counter; every other transition removes the label.
- **Board.** `Security review` is one of `tracker.active_states`, so the board needs the column between `Agent review`
  and `In review` (the [board preflight](#tracker) reports a missing one as `unknown board column "Security review"`),
  and `roles.reviewer.may_move_to` must list it (the preflight says so otherwise).
- **Skipping and removing.** A [profile](#workflow-profiles) can list `security-auditor` in `skip`: the stage never runs
  for those issues, whatever the triggers say. To remove the stage for the whole instance, delete the role, the column from
  `active_states` and `Security review` from the reviewer's `may_move_to`. A human who moves an issue to `Security review`
  by hand always gets a session (the conditions only decide the reviewer's hand-off).
- **Slots.** Like the other additional roles, the auditor only gets slots beyond those of `agent.reserved_slots_by_role`;
  `agent.max_concurrent_agents_by_state."Security review"` is 1 in the shipped file.

#### The documentation stage

The shipped `WORKFLOW.md` has a `docs` role in the `Documentation` column, served by a cheap model (`haiku`). It updates
the documentation before the review, so the reviewer checks it together with the code. It is conditional: only issues
that need it are sent there, all others go straight to `Agent review` without a session.

```yaml
tracker:
  active_states: [Ready, Design, In progress, Testing, Documentation, Agent review, Security review]
roles:
  developer:
    may_move_to: [In progress, Testing, Documentation, Agent review, Blocked]   # done goes to Documentation when needed
  test-engineer:
    may_move_to: [Documentation, Agent review, In progress, Blocked]            # passed goes to Documentation when needed
  docs:
    states: [Documentation]
    result: docs
    on_result: { done: Agent review, not_needed: Agent review, blocked: Blocked }
    may_move_to: [Agent review, Blocked]
    model_label: ignore
    claude: { model: haiku }
pipeline:
  # docs_paths: [docs/**, "README*.md", "CHANGELOG*.md"]
  # docs_trigger_paths: [.env.example, "config/**", WORKFLOW.md]
```

- **When it runs.** When the developer reports `done` (or the test engineer `passed`) and the target is the reviewer,
  `report_result` decides, before it routes the result. The stage is needed when **either** holds: the newest analysis
  since the last reset says `docs_needed`; or at least one file the branch changes matches `pipeline.docs_trigger_paths`
  while **no** changed file matches `pipeline.docs_paths` (the documentation was already written). Otherwise the issue
  goes to `Agent review` as `on_result` says, and the transition `reason` says why (`documentation not needed: no trigger
  (…)`); the pipeline view shows the stage as skipped. With the Testing stage on, the decision is taken when the test
  engineer reports `passed` (the developer's hand-off to `Testing` is not routed to `Documentation`).
- **The files of the branch** are determined like for the [security review](#the-security-auditor) (merge base against
  `origin/<base_branch>`, else `origin/HEAD`). If git cannot tell, the stage is **needed**: a failure never skips it
  silently.
- **Path rule.** The docs agent may only change files matching `pipeline.docs_paths`. `report_result` compares the
  files that differ from the last hand-off of the developer or test engineer and refuses a `done` or `not_needed` result that comes with other
  files with `invalid_result`, naming them; nothing is recorded. `blocked` is always accepted and notes the files. The prompt lists the paths as `docs_paths`.
- **Verdicts.** `done` (with the changed `files`) and `not_needed` lead to `Agent review`, `blocked` to `Blocked`.
- **Haiku.** Haiku has no auto mode; `claude.by_model.haiku` in the shipped file holds the permission settings it needs.
- **Board.** `Documentation` is one of `tracker.active_states`, so the board needs the column between `Testing` and
  `Agent review`, and the `may_move_to` of the developer and the test engineer must list it (the preflight says so
  otherwise). A board without the column and role keeps its flow unchanged.
- **Skipping and removing.** A [profile](#workflow-profiles) can list `docs` in `skip`. To remove the stage for the
  whole instance, delete the role, the column from `active_states` and `Documentation` from the `may_move_to` of the
  developer and the test engineer. A human who moves an issue to `Documentation` by hand always gets a session.

#### Issue commands

An issue can ask for a skill: when the **first non-empty line** of its description is `/<name>` (optionally followed by
arguments, e.g. `/refactoring app/Filament`), Symphony treats it as a command. Text further down, a path such as
`/api/users` or a sentence that mentions a command is not one.

- **Prompt.** `issue.command` is `{name, args, skill}` when a plugin in [`claude.plugins`](#claude) ships
  `skills/<name>/SKILL.md`, otherwise `null` (an unknown `/word` is an ordinary issue). `skill` is the name the agent
  loads with the Skill tool, `<plugin name>:<name>`. The shipped prompt then tells the agent to load that skill first;
  the skill wins over the steps of the role, but the role's read-only access, `may_move_to` and tools still apply.
- **Role.** A role that lists the command under `commands` and serves the issue's column wins; a role with `commands`
  is never chosen for issues without one of them. Otherwise the role without `commands` that serves the column
  applies. `/refactoring` in `Agent review` therefore goes to the reviewer. The role is re-evaluated after every turn:
  if the command disappears from the description, the session ends with `role changed (auditor → developer)` and the
  developer starts fresh.
- **Sub-issues.** A parent whose first line looks like a command is not held back by `respect_sub_issues`: its
  sub-issues are the result of the run, not a prerequisite. This looks at the line only, not at whether a skill exists,
  so a real parent issue that happens to start with `/something` is dispatched with open sub-issues too.
  `respect_blockers` still applies.

The shipped `WORKFLOW.md` defines the `auditor` role for `/refactoring`, the `autopilot` role for `/auto-code`, the
`analyst` role for `/concept` and the `planner` role for `/plan`, and ships the skills `refactoring`, `refactor-safely`,
`auto-code`, `concept` and `plan` in `.claude/skills/` (see [agent-claude.md](agent-claude.md#skills-and-plugins)).

#### Subagents per role

The plugins in `claude.plugins` ship subagents (`agents/<name>.md`; Symphony's toolbox ships the `laravel-*` ones, see
[laravel-subagents.md](laravel-subagents.md)). Claude Code offers them as `<plugin>:<name>`, e.g.
`symphony:laravel-architect`. For each session Symphony decides which of them the agent may start:

1. **The role's list.** `agents` unset allows every plugin subagent, a list only those, `[]` none.
2. **Read-only roles** only get subagents that cannot edit files: their front matter denies `Edit` and `Write`
   (`disallowedTools: Edit, Write, NotebookEdit`) or lists `tools` without them. This applies with `agents` unset too.
3. **Project type.** A subagent whose name starts with a workspace integration's prefix belongs to it: `laravel-*`
   subagents are available only when the [`laravel`](#laravel) integration found a Laravel app in the workspace (with
   or without Boost).

The others are denied in two ways: a `disallowed_tools` rule `Agent(<plugin>:<name>)` (also `Agent(<name>)`, for a
repository that ships the same agent as a project agent) and a `PreToolUse` hook that refuses an Agent tool call
naming one of them. The allowed ones reach the prompt as the variable [`agents`](#prompt-template); the shipped
`WORKFLOW.md` lists them in each role section, phrased as optional.

#### Waves (`wait_for_sub_issues`)

A role with `wait_for_sub_issues: true` works in waves: it creates sub-issues, ends, and runs again once all of them are
closed. The shipped `autopilot` role (`/auto-code`) uses it together with `sub_issue_status: Ready`, so each wave starts
right away and the epic wakes up when the wave is done.

- **Dispatch.** The issue is not dispatched while the tracker reports open sub-issues (the GitHub adapter reads up to
  100, GitHub's limit). The dry run shows `waiting for sub-issues …`.
- **Running sessions** are never stopped for it: reconciliation ignores the gate, so the agent can create the whole wave
  and post its report. After each turn, though, a session whose issue has open sub-issues ends with
  `waiting for sub-issues …` instead of starting another turn.
- **Continuations.** The continuation retry that follows finds the issue waiting and releases its claim. Nothing is
  paused and the continuation count starts again with the next wave.
- The issue stays in its active column the whole time. Moving it out of the active states stops the cycle; moving it
  back resumes it.

### Model per issue

An issue label `Model: <value>` picks the model for that issue's sessions; issues without one use the model of their
[role](#roles) (`roles.<role>.claude.model`), else `claude.model`. Precedence: `Model:` label > role model > `claude.model`.
The prefix is matched case-insensitively and the space after the colon is optional. The value is lowercased and an
optional `claude-` is removed, then:

| Value | Model passed to Claude Code |
|---|---|
| `fable`, `opus`, `sonnet`, `haiku` (also `claude-fable`, …) | the alias itself, i.e. the newest model of that family |
| `<family>-<version>` with family `opus`, `sonnet`, `haiku` or `fable` (e.g. `sonnet-5-5`, `claude-opus-5-5`) | the full model id `claude-<family>-<version>` |
| anything else | unknown |

Unknown values, and several labels naming different models, are ignored: the session uses the role model or `claude.model` and Symphony
logs `model label ignored` (the dry run shows the same). The model is chosen when a session is dispatched, so a label
change applies from the next session (continuation or retry); a paused issue resumes with the new model. The choice
appears in the `dispatching issue` log line (`model`, plus `model_label` when a label picked it) and as `model` of
`run_started` in the repository log. The model Claude Code actually runs is logged with `session_configured`; the
`model` of a running agent in `GET /api/v1/state` is the one that used the most tokens (until the first turn ends, the
one the session started with).
`npm run repo-init` creates the standard labels (`Model: fable`, `Model: opus`, `Model: sonnet`, `Model: haiku`) through the GitHub
REST API. Other values such as `Model: claude-opus-5-5` work as labels too; create them by hand.

#### Permissions per model

Claude Code's `auto` permission mode is not available for every model. Haiku runs in `default` instead (the
`session_configured` event and the `init` message of the session transcript show the mode that is really used), and in
`default` every Bash, Write or Edit call asks for approval, which `on_permission_request: deny` refuses in an unattended run
("The orchestrator's permission policy does not allow Bash here…"). `claude.by_model` gives such a model its own mode and
tool rules in the orchestrator config instead of a `.claude/settings.json` in every repository:

```yaml
claude:
  permission_mode: auto
  by_model:
    haiku:
      permission_mode: acceptEdits               # file edits without asking
      allowed_tools: [Bash, Read, Write, Edit]   # shell commands and file tools without asking
```

The override applies to the model the session runs on, whether a `Model:` label, a role or `claude.model` picked it.
Sessions on other models keep the global values. Deny rules still win, so a role with `read_only: true` stays
read-only on Haiku, and `AskUserQuestion` stays disabled. If a session starts in another mode than requested, Symphony
logs `Claude Code is not using the requested permission mode` with the model.

### Effort per issue

An issue label `Effort: <level>` picks the effort for that issue's sessions; issues without one use the effort of their
[role](#roles) (`roles.<role>.claude.effort`), else `claude.effort` (`CLAUDE_EFFORT` in the shipped `WORKFLOW.md`; empty
= Claude Code default). Precedence: `Effort:` label > role effort > `claude.effort`; a role with `effort_label: ignore`
skips the label (the dry run shows `effort label on issue ignored by role policy`, the `run_dispatched` trace event
`effort_label_ignored`). The prefix is matched
case-insensitively and the space after the colon is optional. The value is lowercased and must be one of `low`,
`medium`, `high`, `xhigh` or `max`; anything else is unknown.

Unknown values, and several labels naming different levels, are ignored: the session uses the role effort or
`claude.effort` and Symphony logs `effort label ignored` (the dry run shows the same). Symphony does not check the effort
against the model; Claude Code lowers a level the model does not support. Like the model, the effort is chosen when a
session is dispatched, so a label change applies from the next session. The choice appears in the `dispatching issue`
log line (`effort`, plus `effort_label` when a label picked it), in the `run_dispatched` trace event and as `effort` of
`run_started`, `run_finished` and `model_usage` in the repository log (`default` when none is configured), which the
statistics page breaks down by effort. `npm run repo-init` creates the five standard labels `Effort: low` … `Effort: max`.

### `pipeline`

Optional. Limits and classification for the result-driven [roles](#result-driven-transitions); every key has a default,
so the section can be left out. `test_paths` limits what the [test engineer](#the-test-engineer) may change,
`security_paths` is one of the triggers of the [security review](#the-security-auditor); `docs_paths` limits what the
[docs agent](#the-documentation-stage) may change and `docs_trigger_paths` is one of its triggers. `$NAME` references work
like everywhere else (an unset variable counts as omitted). Unknown keys are ignored with a warning.

| Key | Default | Notes |
|---|---|---|
| `max_review_rounds` | `3` | Integer >= 1. Review rounds before the issue goes to a human. |
| `max_test_rounds` | `2` | Integer >= 1. Test rounds before the issue goes to a human. |
| `max_security_rounds` | `2` | Integer >= 1. Security review rounds (`issues_found` → developer fixes) before the issue goes to a human. |
| `max_check_failures` | `3` | Integer >= 1. Hand-offs per issue that went to a role's `on_check_failed` (the entry check of the column failed) before the issue goes to a human. |
| `limit_label` | `needs-human` | Label for an issue that hit a round limit or `max_check_failures`. |
| `type_labels` | `{}` | Map of issue label → change type, e.g. `{ bug: bug, enhancement: feature }` (labels are matched case-insensitively). |
| `default_type` | `feature` | Type of an issue without a label in `type_labels`. |
| `analysis` | `always` | `always` or `when_unlabeled`. With `when_unlabeled`, the analysis stage (the role whose `result` is `analysis`) is [skipped without a session](#skipping-stages-without-a-session) for issues that already carry a `Type:` and a `Complexity:` label. Needs a role with `result: analysis`. |
| `profiles` | `{}` | [Workflow profiles](#workflow-profiles) per issue type. |
| `test_paths` | `tests/**`, `test/**`, `**/*.test.*`, `**/*Test.php` | [Path globs](#path-globs) for test files: all that a role with `result: test` (the [test engineer](#the-test-engineer)) may change. An explicit list replaces the default; `[]` allows no file at all. |
| `security_paths` | `app/Policies/**`, `app/Http/Middleware/**`, `config/auth.php`, `routes/**`, `database/migrations/**` | [Path globs](#path-globs) for security-relevant files: a changed file that matches sends the reviewer's approval to the [security review](#the-security-auditor). An explicit list replaces the defaults; `[]` turns the path trigger off. |
| `docs_paths` | `docs/**`, `README*.md`, `CHANGELOG*.md` | [Path globs](#path-globs) for documentation files: all that a role with `result: docs` (the [docs agent](#the-documentation-stage)) may change, and a changed file that matches means the documentation was already written. An explicit list replaces the default; `[]` allows no file at all. |
| `docs_trigger_paths` | `.env.example`, `config/**`, `WORKFLOW.md` | [Path globs](#path-globs) for files that need documenting: a changed file that matches, with no change in `docs_paths`, sends the hand-off to the [documentation stage](#the-documentation-stage). An explicit list replaces the defaults; `[]` turns the path trigger off. |
| `ui_paths` | `resources/views/**`, `app/Filament/**`, `app/Livewire/**`, `resources/css/**`, `resources/js/**` | [Path globs](#path-globs) for files that make up the user interface: a developer's `done` result for a branch that changes one of them needs [screenshots](results.md#screenshots-for-ui-changes). An explicit list replaces the defaults; `[]` turns the check off. |
| `screenshot_paths` | `docs/screenshots/**` | [Path globs](#path-globs) for screenshot files: a changed file that matches means the developer delivered screenshots. An explicit list replaces the default. |
| `require_screenshots` | `auto` | `auto`, `always` or `never`. `auto`: the project asks for screenshots when `AGENTS.md` or `CLAUDE.md` in the workspace root, or the issue title or description, mention "screenshot" (case-insensitive). `always` asks for them for every change to `ui_paths`; `never` turns the check off. |

#### Path globs

The `*_paths` lists take globs that match repository-relative paths with `/` separators, in the whole path and
case-sensitively: `*` any characters except `/`, `?` one such character, `**` anything including `/` (`**/` also matches
no directory, so `**/*.test.*` matches `a.test.ts` and `src/a.test.ts`), `{a,b}` one of the alternatives (not nested).
Everything else is literal, including a leading dot (`tests/**` matches `tests/.env.testing`). A glob must not be empty,
absolute or contain `..` segments, and braces must be balanced; otherwise the config fails with `invalid_config`, e.g.
`pipeline.test_paths[1] "/abs/**" must be relative to the repository root, without a leading "/"`.

**Laravel apps in a subdirectory.** The defaults are written for an app at the repository root. When the workspace holds
a detected Laravel app in a subdirectory (`laravel/`, see the Laravel integration), Symphony extends each **default**
list of `test_paths`, `docs_paths`, `docs_trigger_paths` and `security_paths` with the app prefix, in addition to the
root globs: `tests/**` also covers `laravel/tests/**`, `app/Policies/**` also `laravel/app/Policies/**`. Globs that
start with `**` already match below any directory and get no copy. A list you set explicitly in `WORKFLOW.md` is used
exactly as written, never extended; write the prefixed globs yourself (`laravel/tests/**`) if you set one. There is no
`{app}` placeholder. The rejection message of `report_result` lists the effective globs, prefixes included.

#### Workflow profiles

Bugfix, feature and refactor issues can follow different stage sequences with the same roles: a profile, chosen by the
issue's type, skips stages and overrides transitions. The type comes from the issue labels (`Type: bugfix`, or the
aliases `bug`, `feature`, `enhancement`, `refactor`, `refactoring`).

```yaml
pipeline:
  profiles:
    bugfix:
      skip: [test-engineer]          # roles whose stages `next` passes over
      skip_when:                     # roles whose stages are passed over only for some issues
        architect: { complexity: [S, M] }
      max_review_rounds: 2           # optional, overrides pipeline.max_review_rounds
    refactor:
      on_result:                     # overrides roles.<role>.on_result for this profile
        reviewer: { changes_needed: Blocked }
    default:                         # issues without a type, and types without a profile of their own
      skip: [security]
```

- The profile names are the issue types `bugfix`, `feature`, `refactor` and `default`. An issue gets the profile of its
  type, else `default`, else none (the roles' own transitions). An unknown profile name or key is an error.
- `skip` lists role names; an unknown role is an error. `next` passes over the stages of these roles when it computes
  the target ([rule 3](#result-driven-transitions)), and the pipeline view of the dashboard and the API shows them as
  `skipped` (unless a session already ran there). An issue that arrives in a skipped column is passed on without a
  session, see [Skipping stages without a session](#skipping-stages-without-a-session).
- `skip_when` skips a stage only for some issues. The vocabulary is fixed: a map of a role name to a condition, and the
  only condition is `complexity`, a list of `S`, `M`, `L` and `XL` (`skip_when: { architect: { complexity: [S] } }`).
  The stage is skipped for an issue whose `Complexity:` label is in the list, in every place a `skip` is: `next`, the
  dispatch skip, the preflight and the pipeline view. An issue without a usable complexity label (none, an unknown
  value, conflicting labels) never matches, so the stage runs. An unknown role, condition or complexity value is an error
  (`pipeline.profiles.bugfix.skip_when.architect.complexity: unknown value "XXL" (allowed: S, M, L, XL)`).
- `on_result` maps a role name and a verdict of its result kind to a column or `next`, replacing the role's own target for
  that verdict. The same rules as for `roles.<role>.on_result` apply (no terminal column, a column in the role's
  `may_move_to` when it sets one, a role with a `result`).
- `max_review_rounds` and `max_test_rounds` (integers >= 1) override the section's limits for this profile.
- The board preflight checks `next` for every profile too: a profile that skips every later stage of a role is reported
  as `roles.<role>.on_result.<verdict>: "next" has no later active stage … (profile bugfix)`.
- The prompt sees the name as `issue.profile` (`null` when no profile applies), e.g.
  `{% if issue.profile == "bugfix" %}Reproduce the bug with a failing test first.{% endif %}`.

The shipped `WORKFLOW.md` defines these flows. Every profile has the same roles; the differences are the transitions
(`on_result`, `skip_when`) and the profile-specific steps in the role prompts, which switch on `issue.type`:

| Profile | Flow | Prompt steps |
|---|---|---|
| `bugfix` | `Ready` → `Design` (only `L`, `XL`) → `In progress` → `Testing` → `Agent review` → `In review` | developer: regression test first |
| `feature` | `Ready` → `Design` (not `S`) → `In progress` → `Testing` → `Agent review` → `In review` | developer: implement the design and the acceptance criteria, a test for every criterion; reviewer: checks the change against the design and every criterion |
| `refactor` | as `feature` | developer: load `symphony:refactor-safely` (not twice when the issue starts with `/refactor-safely`), characterization tests first, no behaviour change; test engineer: characterization tests green on the base commit and on HEAD, `failed` if behaviour differs; reviewer: public interfaces and existing tests unchanged, confirms each refactoring goal; analyst: fills `refactoring_goals` |
| `default`, untyped | `Ready` → `Design` (not `S`) → `In progress` → `Agent review` → `In review` | none |

- **Refactoring goals.** The analyst of a refactor issue lists what the refactoring has to achieve in the analysis
  result's `refactoring_goals`; the prompts of the later stages print them. The review of a refactor issue with goals
  can only be `approved` when `confirmed_goals` contains every goal ([consistency rules](results.md#consistency-rules));
  an incomplete approval is refused with `invalid_result`, naming the missing goals.
- **Characterization tests.** The developer commits them first, as the `refactor-safely` skill describes. The test engineer
  runs after the developer, so it verifies and extends them against the base commit instead of writing them before the
  change.

#### Skipping stages without a session

A stage that the issue's profile or a condition leaves out costs nothing: when the issue is due to be dispatched, Symphony
does not start an agent but moves it on. The stage is skipped when

- the role is in the `skip` list of the issue's [profile](#workflow-profiles), or in its `skip_when` with the issue's
  complexity (the architect of a small issue, see [The architect](#the-architect)), or
- the role is the analysis stage, `pipeline.analysis` is `when_unlabeled` and the issue has a `Type:` and a
  `Complexity:` label (the aliases `bug`, `enhancement`, … count; conflicting or unknown labels count as unset).

Symphony then posts a `skipped` [result](results.md) as an issue comment (hidden marker, `meta.target` = the new column,
no run), moves the issue to the first active column after its own in board order whose stage is needed, and logs
`stage_skipped` in the issue's timeline. The next stage starts with the next poll; consecutive skipped stages are passed
one poll at a time. For example, with an analyst in `Ready` and `pipeline.analysis: when_unlabeled`, a `Type: bugfix`,
`Complexity: S` issue goes from `Ready` to `In progress` without an analyst session.

- **No entry checks.** The move has no workspace, so it cannot run `checks.on_enter`. The dispatch preflight therefore
  reports (a `skip_when` condition counts, because it may skip the stage) a configuration where a skip would lead into a column with a script (`pipeline.profiles.bugfix.skip: skipping
  developer moves issues from "In progress" to "Agent review" without a workspace, but checks.on_enter has a script for
  "Agent review"`), and dispatch stops until it is fixed.
- **When nothing is skipped.** The stage runs as usual if the tracker does not list its columns (the board order is
  needed), no needed stage follows (a skipped role in the last active column still runs), or the posting or the move fails (the next poll decides again; a comment that was already posted is not posted twice). Only fresh dispatches
  are skipped: **Start now** (`/force`), retries and continuations of a stage always start a session.
- Conditions based on changed files are not part of this.

### `server`

| Key | Default | Notes |
|---|---|---|
| `port` | none | Starts the dashboard and JSON API. `0` picks a free port. `--port` overrides it. Restart to change it. |
| `host` | `127.0.0.1` | Bind address; the shipped `WORKFLOW.md` reads it from `SYMPHONY_HOST`. On a loopback address (`127.0.0.1`, `::1`, `localhost`), requests with another `Host` header are rejected. Any other address (e.g. `0.0.0.0` in a container) logs a warning at startup: Symphony has no login of its own, so put a reverse proxy with authentication (BasicAuth, forward auth) in front. Restart to change it. |
| `allow_remote_control` | `false` | Allows the control routes (restart with `POST /api/v1/<identifier>/retry`, **Retry now** / **Resume now**; **Start now** with `/force`; pause and resume of issues and models, `/pause`, `/resume`, `/models/<model>/hold` and `/release`; agent slots with `PUT` / `DELETE /api/v1/settings/agents`) when `host` is not a loopback address; the shipped `WORKFLOW.md` reads it from `SYMPHONY_ALLOW_REMOTE_CONTROL`. On such a bind every restart request must carry an `Origin` header that matches its `Host` (CSRF guard, since the browser sends the proxy's credentials with every request); without it the API answers `403 forbidden_origin`. Has no effect on a loopback bind, where restart is always allowed. Only enable it behind an authenticating proxy. Restart to change it. |
| `public_url` | none | The dashboard's address as people reach it (`https://symphony.example.com`); the shipped `WORKFLOW.md` reads it from `SYMPHONY_PUBLIC_URL`. Links in [commit statuses](#named-checks) point to its agent page. |

### `system`

Symphony samples CPU, memory, load and disk of the host every 10 s and keeps one hour of history in memory (`GET /api/v1/system`). Values that cannot be read are `null`.

| Key | Default | Meaning |
| --- | --- | --- |
| `gpu` | `false` | Reads GPU utilization, memory and temperature from `nvidia-smi`; with `false` `nvidia-smi` is never called and `gpu` is `null`. Restart to change it. |

### `brain`

The knowledge vault: one vault for all repositories. With `enabled: true` Symphony creates `README.md` (the rules), `Inbox/`, `Repos/`, `Decisions/`, `Lessons/`, `Issues/` and `Agents/` folders at startup, plus `Kandidaten-Review.base` and `Neueste Lessons.base` as Obsidian Bases views, and `Repos/<owner>-<name>/index.md` for each configured repository. It also creates `.gitignore` (`.obsidian/workspace*.json`, `.trash/`) and, when `.git` is missing, runs `git init` with a first commit of the structure (never `.obsidian/`); every agent write is then one commit (see [agent-claude.md](agent-claude.md#brain-tools)). After every successful merge Symphony itself (no agent) writes `Issues/<owner>-<name>/<number>.md` with the goal, the result per stage, rounds, cost, changed files and links to the pull request and `[[Repos/<owner>-<name>/index]]` (`status: approved`, `role: symphony`) and commits it as `symphony` with the subject `<repo>#<number>: issue summary`; a second run for the same issue changes nothing, and a failure only logs a warning. Existing files and folders are never overwritten; `.obsidian/` is never touched. Restart to change it. With `enabled: true` the sessions of roles with `brain: read` get the tools `brain_search`, `brain_read` and `brain_list`, those with `brain: write` also `brain_write` and `brain_append` (see [agent-claude.md](agent-claude.md#brain-tools)); roles without the field get none. `path` must not overlap `workspace.root` (same directory, vault inside the root or root inside the vault): agents reach the vault only through the tools. An unknown key is an error.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Create the vault at startup; with `false` no path is touched. |
| `path` | `~/brain` | Vault directory; `~` and `$VAR` are expanded, relative paths resolve against `WORKFLOW.md`. In Docker this is the `brain` volume. |
| `clash_window_ms` | `600000` | Integer >= 0. A `brain_write` or `brain_append` is rejected with reason `window` when another run wrote the same note successfully within this many milliseconds; the result holds the current content and hash. The same run may write again at once. `0` turns the check off. Every call is logged to `<log-dir>/brain/access.jsonl` (lines older than 30 days are removed at startup, see [agent-claude.md](agent-claude.md#brain-tools)). |

## Complete example: roles, checks and Laravel

The shipped `WORKFLOW.md`, shortened to the parts that make up the developer → checks → reviewer → human flow
(`Ready → In progress → [checks] → Agent review → [checks] → In review → Done`, plus `Blocked`). The board needs
the columns `Backlog`, `Ready`, `In progress`, `Agent review`, `Blocked`, `In review` and `Done`; the
[board preflight](#tracker) reports a missing one. The shipped file also defines the
[test engineer](#the-test-engineer) (used by bug issues through the `bugfix` [profile](#workflow-profiles)) and lists its
column `Testing` as an active state, so its board needs that column too; this example leaves the stage out. In a repository without a Laravel app the hook and the check
script do nothing (exit 0), so the same file also works there.

```yaml
---
tracker:
  kind: github_project
  provider:
    project_number: $GITHUB_PROJECT_NUMBER
    repositories: $GITHUB_REPOSITORY
    token: $GITHUB_TOKEN
  active_states: [Ready, In progress, Agent review]
  terminal_states: [Done]                    # In review and Blocked: neither active nor terminal (agent stops, workspace stays)

hooks:
  timeout_ms: 600000
  after_create: |
    set -e
    git clone --quiet "git@github.com:${SYMPHONY_ISSUE_REPOSITORY}.git" .
    bash "$SYMPHONY_WORKFLOW_DIR/hooks/laravel-env.sh"
  before_run: |
    git fetch --quiet --prune origin

agent:
  max_concurrent_agents: ${SYMPHONY_MAX_CONCURRENT_AGENTS:-3}
  max_turns: ${SYMPHONY_MAX_TURNS:-10}
  max_continuations: ${SYMPHONY_MAX_CONTINUATIONS:-6}   # role switches without a result count, so keep a limit
  max_concurrent_agents_by_state:
    "Agent review": 1

roles:
  issue-analyst:                             # analyses every issue in Ready first, see "The issue analyst"
    states: [Ready]
    read_only: true
    max_turns: 3
    result: analysis
    on_result: { ready: next, needs_info: Blocked }
    may_move_to: [Design, In progress, Blocked]
    model_label: ignore
    claude: { model: sonnet }
  developer:
    states: [In progress]
    result: implementation                   # hands off with report_result, see "The shipped developer and reviewer"
    on_result: { done: Agent review, blocked: Blocked }
    may_move_to: [In progress, Agent review, Blocked]
  reviewer:
    states: [Agent review]
    read_only: true
    max_turns: 6
    result: review
    on_result: { approved: In review, changes_needed: In progress, blocked: Blocked }
    on_check_failed: In progress
    may_move_to: [In review, In progress, Blocked]
    claude: { model: opus }
  auditor:                                   # issues that start with /refactoring: analysis only, findings become sub-issues
    commands: [refactoring]
    states: [Ready, In progress]
    read_only: true
    run_checks: false
    max_sub_issues: 20
    max_turns: 2
    may_move_to: [In progress, In review, Blocked]
    claude: { model: fable, max_budget_usd: 15 }

pipeline:
  max_review_rounds: 3                       # the 3rd review with changes_needed goes to Blocked (needs-human), not back

checks:
  timeout_ms: ${SYMPHONY_CHECKS_TIMEOUT_MS:-1800000}   # below claude.turn_timeout_ms (default 3600000)
  on_enter:
    Agent review: bash "$SYMPHONY_WORKFLOW_DIR/checks/laravel.sh"
    In review: bash "$SYMPHONY_WORKFLOW_DIR/checks/laravel.sh"   # usually a cache hit for the reviewed commit

laravel:
  agent_env: {}
  allow_tinker: false
  deny_tools: [record-rule]
---
{% capture branch %}{% if issue.branch_name %}{{ issue.branch_name }}{% else %}symphony/issue-{{ issue.native_ref.number }}{% endif %}{% endcapture %}
You are working on GitHub issue **{{ issue.identifier }}**: {{ issue.title }}

{{ issue.description | default: "(no description)" }}

{% case role %}{% when "developer" %}## Your role: developer

Implement the issue on `{{ branch }}`, integrate the base branch, commit, push, open a pull request with
`open_pull_request`, then hand off with `report_result` (verdict `done`; `blocked` with a blocker if you cannot go on).
Open findings of the last review: `results.open_findings`.
On `check_failed`: fix the problems and call `report_result` again.
On `check_timeout`: call `report_result` once more; if it times out again, comment and end your turn.
On `check_error`: describe the error with `add_comment` and end your turn.
After a recorded result, end your turn.
{% when "reviewer" %}## Your role: reviewer

You are read-only. Review `git diff origin/<base>...HEAD`, the pull request and the issue comments against the
checklist, then hand off with `report_result`: verdict `approved` or `changes_needed` with `findings`. Symphony picks
the column and enforces the round limit.
{% else %}## How to work

The single-agent prompt: implement, open a pull request and move the issue to "In review".
{% endcase %}
```

How the pieces work together:

| Step | Mechanism |
|---|---|
| `Ready` → issue analyst session | [`roles`](#roles): the column decides the role, `role` selects the prompt section. A description that starts with `/refactoring` selects the `auditor` instead ([issue commands](#issue-commands)). The analyst's `ready` moves the card to `In progress`. |
| `In progress` → developer session | Same mechanism; the developer gets the analysis in `results.analysis`. |
| Developer calls `report_result` (`done`) | The verdict leads to `Agent review` (`on_result`). [Transition guard](#transition-guard): `Agent review` is in the developer's `may_move_to`, so `checks.on_enter` runs; only exit `0` records the result and moves the card. |
| Card in `Agent review` → reviewer session | Role switch ends the developer session; the reviewer starts in a fresh, read-only session, at most one at a time (`max_concurrent_agents_by_state`). |
| Reviewer reports `approved` (`In review`) or `changes_needed` (`In progress`) | `In review` runs the same check again (cached for an unchanged, clean commit); `In progress` has no check. |
| Ping-pong between the roles | Each switch counts toward `agent.max_continuations`; results reset the count, and Symphony stops sending back at `pipeline.max_review_rounds`. |
| `Done` | Never allowed for agents (terminal state); a human sets it after the merge. |

The full prompt (developer steps, reviewer checklist and the fallback for the `default` role) is the body of the
shipped `WORKFLOW.md`; `test/workflow-prompt.test.ts` renders it for each role.

## Check scripts (`checks/laravel.sh`)

A deterministic quality gate that runs in the workspace (bash). The shipped `WORKFLOW.md` runs it through
[`checks.on_enter`](#checks) before an issue may enter `Testing` and `Agent review`, and with `--full` as the fallback
of the named check `ci` before `In review`.

| Exit code | Meaning |
|---|---|
| `0` | Pass (also when there is no `artisan`: `no Laravel app; nothing to check`). |
| `78` | Only with `--full`: no Laravel app, the check is skipped. |
| `1` | The code must be fixed. The output goes to the agent: dirty tree, unpushed commits, `php -l` errors, or a failing lint, analysis or test step. |
| other (`2`) | Environment problem: missing `php`/`git`, missing or broken `vendor/`, failing `git fetch`, unknown default branch, configured but missing PHPStan. The agent comments and moves the issue to `Blocked`. |

The app directory is `$SYMPHONY_LARAVEL_APP_PATH`; without it, the script uses the current directory, or the single
first-level subdirectory that holds an app (`artisan` plus `composer.json`, like Symphony's detection — `vendor/` and
`node_modules/` never count). With several such subdirectories it exits 2 and asks for `SYMPHONY_LARAVEL_APP_PATH`.
Steps, in order: clean tree, `git fetch` and everything pushed, `php -l` on PHP files changed against `origin/HEAD`,
style, static analysis, tests.

| Step | Composer script (preferred) | Fallback |
|---|---|---|
| Style | `lint` | `vendor/bin/pint --test <changed files>` if Pint exists; with `--full` every file |
| Static analysis | `analyse` | `vendor/bin/phpstan analyse --no-progress` if `phpstan.neon[.dist]` exists |
| Tests | `test` | `php artisan test` |

**`--full`** is the project's CI: Pint on every file, static analysis and the tests. With `SYMPHONY_CI_DB=mysql` (a
repository's `.symphony/checks/ci.sh` sets it) the tests run against a MySQL database of their own,
`symphony_<key>_ci` (`<key>` as for [the MySQL recipe](#optional-mysql-instead-of-sqlite)): the script drops and
creates it with `SYMPHONY_MYSQL_*`, exports `DB_CONNECTION=mysql`, `DB_DATABASE` and the credentials (the process
environment beats `.env` and the `<env>` entries of `phpunit.xml`), runs `php artisan config:clear` and
`php artisan migrate --force`, then the tests, and drops the database on exit. `hooks/laravel-db-drop.sh` in
`before_remove` drops a leftover of a killed check. The MySQL server of the compose profile `ci` serves this.
With `SYMPHONY_CI_PARALLEL=<n>` the tests run in `n` processes (`php artisan test --parallel --processes=<n>
--drop-databases`; with MySQL each process gets `<database>_test_<n>`, which the script drops on exit as well, since
`--drop-databases` keeps them when tests fail). That needs
`brianium/paratest`: a project that requires it, in a workspace whose `vendor/` predates it, gets it through
`composer update brianium/paratest` first, but only when `composer.lock` is not tracked (the tree must stay clean).
Without paratest the tests run in one process, with a note.

**Timings and host load.** Once the environment checks passed, the script prints `host load at start (1/5/15 min): …,
<n> CPUs` (from `/proc/loadavg` and `nproc`; `unknown` where they are missing) and, before the tests, `tests: <n>
process(es), database sqlite|mysql`. The last lines of the output are `host load at end …` and a `steps:` block with
one line per step (`php -l`, style, static analysis, `php artisan config:clear`/`migrate`, tests) in the form
`  <name>  <duration>  <ok|failed>`. They come last on every exit after the steps began, also after a failing step, so
they survive when the guard shortens the output from the front. On a timeout the guard terminates the script
(SIGTERM): it prints the same lines with the running step as `timed out (aborted)`, drops its MySQL databases and exits
143. The guard keeps the end of the output of a timed-out check in the gate run (`gate.checks[].output`, shown on the
issue's detail page), as it does for a failed check.

**Output of passed checks.** For a `passed` or `skipped` check the guard also keeps a short end of the output (at most
400 characters) in `gate.checks[].output`, from the `host load at end` or `steps:` line on; output without them (another
script) keeps just its last 400 characters, and empty output stays `null`. The agent page shows it collapsed in *Entry
checks*. The `checks_finished` line of the [repository log](#repository-logs) carries the parsed `steps` and `load` (also for failed and timed-out runs, which print them too), so
step durations can be compared across issues. The agent's answer to a passed check stays the short note without output.
A cached result keeps the output of the original run.

The fast gate (without `--full`) tests in parallel with `SYMPHONY_TEST_PARALLEL=<n>` in Symphony's environment
(`php artisan test --parallel --processes=<n>`, on SQLite, so without `--drop-databases`), when `vendor/bin/paratest`
exists. It never installs anything: without paratest the tests run in one process, with a note. An invalid value (not a
positive integer) is an environment problem (exit 2). A `test` script in `composer.json` takes precedence over both
variables; `--full` reads only `SYMPHONY_CI_PARALLEL`.

Composer scripts are detected with `composer run-script --list`, which lists exactly the scripts defined in
`composer.json` (without Composer, none are used). A `test` script can run the suite in parallel, e.g.
`@php artisan test --parallel` with `brianium/paratest`; start it with `Composer\Config::disableProcessTimeout`, or
Composer stops it after 300 s. The script never modifies tracked files, and prints only the tail (about 4000
characters) of a failing step, since the guard forwards at most 6000 characters. For failing tests it adds a list of
the failed tests last (`Failed tests:`, PHPUnit's `N) Class::method` with the first line of its message, or
Collision's `FAILED` lines): the tail of a test run is mostly stack traces, and the list survives any shortening.

## `model-costs.yml`

Prices for the cost estimates (dashboard, repository logs, logs page), next to `WORKFLOW.md`. Re-read when the file
changes; an invalid edit keeps the previous prices and is reported on the dashboard.

```yaml
default: { input: 5.00, output: 25.00, context_window: 200000 }   # USD per million tokens; window in tokens
opus:    { input: 4.00, output: 20.00, cache_read: 0.20 }
claude-opus-4-8: { input: 5.00, output: 25.00 }
```

- Each entry needs `input` and `output`; `cache_read` defaults to 10% and `cache_write` to 125% of `input`.
- A model id reported by Claude Code (e.g. `claude-opus-5-5`) uses the exact entry if there is one, else the longest
  key contained in the id (`opus`), else `default`. Without the file, every model is priced at 5 / 25.
- `context_window` (optional, a positive whole number of tokens) is the model's context window. It is looked up like the
  price (exact entry, else longest contained key, else `default`); the shipped file sets `default: 200000`. A model
  name with the suffix `[1m]` (e.g. `opus[1m]`) always gets 1,000,000 tokens, ahead of any entry. Symphony relates
  `input + cache_read + cache_creation` tokens of the latest call of the main conversation (subagents excluded) to this
  window: `running[].context` in `GET /api/v1/state` is `{ tokens, window, percent, compacts }`, with `window` and
  `percent` `null` when no window can be determined (no `context_window` on the entry or on `default`). Automatic
  compactions (`compact_boundary`) are counted in `compacts`. Add `context_window` to a custom `model-costs.yml`, e.g. a
  Docker mount, to get percentages.
- Cost = input × input price + output × output price + cache reads × cache_read + cache writes × cache_write.

## Repository logs

`<log-dir>/repositories/<owner>_<repo>.log` (log dir: `--log-dir`, else `SYMPHONY_LOG_DIR` resolved against the
workflow directory, else `$XDG_STATE_HOME/symphony` or `~/.local/state/symphony`). One `key=value` line per event:

| Event | Fields |
|---|---|
| `run_started` | `repo`, `issue`, `run`, `title`, `state`, `attempt`, `model` (requested: from a `Model: …` label, else the role's model, else `claude.model`), `effort` (requested: from an `Effort: …` label, else the role's effort, else `claude.effort`; `default` when none), `role` (`default` without roles), `laravel` and `boost` (only for workspaces with [`laravel`](#laravel) apps: `<app dir>:<laravel/framework version from composer.lock, or unknown>` and the Boost status `ready`, `failed`, `skipped` or `absent`, e.g. `laravel=laravel/:v13.1.0 boost=ready`; several apps give comma-separated entries, each status prefixed by its directory) |
| `run_finished` | `repo`, `issue`, `run`, `session` (Claude session id), `title`, `outcome` (`handed_off`, `continuing`, `failed`, `session_limit` (the run ended with a session limit; see `agent-claude.md`), `stopped`, `stalled`, `shutdown`), `role` (the [role](#roles) that served the run; `default` without roles; logs from before it was written have none and count as `unknown` in the analytics) and `next_role` (only when the run handed off to another role), `state`, `reason`, `attempt`, `turns`, `model` (most tokens), `models`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `total_tokens`, `cost_usd`, `claude_estimate_usd`, `agent_seconds`, `context_peak_percent` (highest context fill of the session in percent; `null` without a known window; older lines have none) and `context_compacts` (automatic compactions), `head_sha` and `branch` (final commit of a git workspace; omitted otherwise), `mcp_tool_calls` (`<server>:<n>,…` per MCP server; omitted when no MCP tool was used), `tool_calls` (`<tool>:<n>,…` per tool, built-in and `mcp__<server>__<tool>`; omitted without tool calls), `skill_calls` (`<skill>:<n>,…` per skill the Skill tool loaded; the count follows the last colon, so `symphony:handoff:1` is the skill `symphony:handoff`), `agent_calls` (`<subagent>:<n>,…` per subagent the Agent tool started, by `subagent_type`, `general-purpose` when unset; omitted without such calls), `integrations` (`<id>:<status>,…` of the workspace integrations, e.g. `laravel-boost:ready`; status `ready`, `unavailable`, `absent` or `off`), `integration_tools` and `integration_skills` (calls attributed to an integration: `<id>/<tool or skill>:<n>,…`, e.g. `laravel-boost/search-docs:3`), `started_at`, `mcp_unavailable` (comma-separated MCP servers Symphony added that did not connect; only when there are any), running totals `repo_runs`, `repo_tokens`, `repo_cost_usd`, `repo_agent_seconds` |
| `model_usage` | `repo`, `issue`, `run`, `model`, `price` (matched entry), token counts, `cost_usd` |
| `stage_result` | `repo`, `issue`, `run`, `role`, `kind` (result kind, e.g. `review`), `verdict`, `round` (review and test loops; omitted otherwise), `target` (column the result handed the issue to), `profile` (workflow profile; omitted without one), `complexity` (`S` … `XL` from the issue's `Complexity:` label; omitted without one), `findings` (number of findings of a review or security result; omitted when 0). Written when `report_result` has posted the result comment; the analytics group these lines by profile and role |
| `session_limit_wait` | `repo`, `issue`, `title`, `state`, `window`, `resets_at`, `retry_at` (reset + 60 s), `hits`, `max_retries`, `source` (`event` or `message`); written when the session-limit retries are used up and the worker waits for the reset |
| `issue_paused` | `repo`, `issue`, `title`, `state`, `source` (`continuations` with `continuations` and `max_continuations`, `operator` with `previous`, or `budget` with `cost_usd` and `max_issue_cost_usd`) |
| `issue_resumed` | `repo`, `issue`, `title`, `source` (the source of the lifted pause); written when an operator resumes a paused issue (`POST /api/v1/<identifier>/resume`) |
| `model_hold`, `model_hold_ended` | `model`, `since`, `until`; a limit hold also `issue`, `title`, `extended`, `text`; an operator hold (dashboard **Pause** on a model) `source=operator` with `stopped` or `requeued`, written to every repository with a claimed issue |
| `worker_restarted` | `repo`, `issue`, `title`, `previous` (`retrying` or `paused`); written when an operator restarts a waiting or paused worker through the dashboard or `POST /api/v1/<identifier>/retry` |
| `workspace_removed` | `repo`, `issue`, `state` |
| `checks_finished` | `repo`, `issue`, `run`, `role`, `target`, `sha` (workspace commit; omitted outside git), `ok`, `result` (`passed`, `skipped`, `check_failed`, `check_timeout`, `check_error`), `exit_code` (`null` when the script did not exit normally), `timed_out` (only when `true`), `duration_ms`, `steps` (JSON list of `{name, duration_s, result}` from the `steps:` block of `checks/laravel.sh`; omitted without one), `load` (JSON object `{1m, 5m, 15m, cpus}` (each a number or `null` when unknown) from the `host load at end` line; omitted without one) |
| `transition_denied` | `repo`, `issue`, `run`, `role`, `target`, `reason` (the message the agent received) |

`cost_usd` in a line uses the prices at the time it was written; the logs page and `/api/v1/history` recompute every
cost from the logged tokens with the current `model-costs.yml`. `input_tokens` counts uncached input only;
`total_tokens` is the sum of all four token counts.

## Prompt template

The Markdown body is rendered with strict Liquid: unknown variables and unknown filters fail the run attempt
(which is then retried with backoff), so typos show up immediately. Available variables:

- `issue`: `id`, `identifier`, `title`, `description`, `priority`, `state`, `branch_name`, `url`, `assignee_id`,
  `labels` (lowercase list), `blocked_by` (list of `{id, identifier, state}`), `dispatchable`, `created_at`,
  `updated_at` (ISO strings), `native_ref` (adapter data, for GitHub: `repository`, `number`, `issue_id`, `item_id`,
  `status_updated_at` (ISO string: when the Status field last changed), `parent` and `sub_issues` as
  `{identifier, title, state, state_reason}` (`state_reason` is `null` for an open issue), …), `command` (`{name, args, skill}` for an
  [issue command](#issue-commands) that has a skill, else `null`; always defined).
- `attempt`: `null` on the first run of an issue, then `1`, `2`, … on continuation runs and retries.
- `role`: name of the [role](#roles) running the issue (e.g. `developer`, `reviewer`), or `default` without `roles`.
  Always defined, so one prompt can branch per role: `{% if role == "reviewer" %}…{% endif %}`.
- `brain`, `brain_index`: the session's brain mode (`off`, `read` or `write`: the role's [`brain`](#roles) with `brain.enabled`, else `off`) and the path of the repository's index note in the vault (`Repos/<owner>-<name>/index.md`, `null` when the tracker has no repository). Always defined. The shipped `WORKFLOW.md` includes `roles/brain.md` unless `brain` is `off`.
- `agents`: the plugin subagents this session may start (see [Subagents per role](#subagents-per-role)), each with
  `name` (what the Agent tool takes as `subagent_type`, e.g. `symphony:laravel-architect`) and `description`. Always
  defined; empty when the session may start none: `{% if agents.size > 0 %}…{% endif %}`.
- `test_paths`: the list `pipeline.test_paths`, so the prompt of a test engineer can name the files it may change. Always defined.
- `attachments`: the files uploaded to the issue's description and comments, downloaded into the workspace before the
  session (see [Images and files in the issue](usage.md#images-and-files-in-the-issue)), in order of appearance, each
  `{path, label, source, error}`: `path` is workspace-relative (`.issue-assets/attachment-1.png`), or `null` when the
  download failed and `error` says why; `label` is the image's alt text or the file link's text; `source` is
  `description` or the comment's URL. Always defined; empty without attachments: `{% if attachments.size > 0 %}…{% endif %}`.
- `human_feedback`: for a role with [`result`](#result-driven-transitions), the comments a human wrote since the
  pipeline last handed the issue off, oldest first, each `{author, created_at, url, body}` (`body` cut to 6,000
  characters): every comment not written by Symphony's account that is newer than the newest result before the newest
  `reset` (without a reset: the newest result). It stays the same for all stages until the next reset, so the analyst,
  the architect and the developer all see what the human asked for after sending the issue back. Empty before the first
  result and for roles without `result`. Always defined.
- `results`, `round`, `result_required`: the issue's stage history, always defined. A role with
  [`result`](#result-driven-transitions) reads the issue's persisted results when its session starts (one paginated read
  of the issue's comments per session; other roles make no extra request and see the empty values).
  - `results.latest`: the newest result of each role, oldest first, each `{role, kind, verdict, summary, round, target,
    created_at}` (`summary` cut to 1,500 characters).
  - `results.open_findings`: the findings `{severity, file, line, problem, fix}` of the newest review since the last
    reset, while its verdict is `changes_needed`; empty otherwise.
  - `results.security_findings`: the same shape for the newest security review since the last reset, while its verdict is
    `issues_found`; empty otherwise.
  - `results.failed_cases`: the failed cases `{criterion, test}` of the newest test since the last reset, while its
    verdict is `failed`; empty otherwise.
  - `results.test`: the newest test since the last reset, whatever its verdict, as `{verdict, summary, round, commands}`
    (`summary` cut to 1,500 characters), else `null`. With `failed_cases` it tells the developer why the cases failed and
    how to run them again.
  - `results.analysis`: the newest analysis since the last reset, whatever its verdict, as `{verdict, summary, type,
    complexity, components, acceptance_criteria, risks, docs_needed, open_questions, plan, refactoring_goals}` (`summary` cut to 1,500
    characters; `risks` lists the flags that are set, e.g. `breaking change`), else `null`. The shipped prompts of the
    architect, developer, test engineer and reviewer print it as "Analysis of the issue analyst".
  - `results.design`: the newest design since the last reset, whatever its verdict, as `{verdict, summary, decision,
    components, interfaces, migrations, compatibility, options, work_packages, plan, tests, head_sha}` (`summary` cut to 1,500
    characters; `head_sha` is the commit the design was made at), else `null`. The shipped developer prompt prints it
    as "Design of the architect" and nothing without a design.
  - `results.implementation`: the newest implementation of the issue's developer, whatever its verdict and across
    resets, as `{verdict, summary, head_sha}`, else `null`. The shipped reviewer prompt reviews an issue
    [split into work packages](#work-packages-split) in integration mode only while it is `null`.
  - `round`: the round the role is working in, 1 for the first: the number of failed tests plus one for a role with
    `result: test`, else the number of reviews with `changes_needed` plus one (so a developer sees the review round it
    is fixing). 1 for roles without `result`.
  - `result_required`: `true` for a role with `result`, which hands off with `report_result` and has no `set_status`.

Besides the standard Liquid filters there are `without_model_labels` and `without_agent_labels`:
`issue.labels | without_model_labels` drops the `Model: …` labels, which only pick the agent's model (see
[Model per issue](#model-per-issue)); `issue.labels | without_agent_labels` drops the `Effort: …` labels as well (see
[Effort per issue](#effort-per-issue)). The shipped `WORKFLOW.md` uses the latter.

An empty body falls back to a minimal default prompt. `npm run dry-run` renders the prompt for the first eligible
issue so you can check it without starting an agent.

### Role prompts in separate files

The body can pull in other files with `{% include "<path>" %}` (or `{% render "<path>" %}`). The shipped `WORKFLOW.md`
keeps the instructions of each role in its own file and picks the one for the session's role:

```liquid
{% case role %}
{%- when "developer" %}{% include "roles/developer.md" %}
{%- when "reviewer" %}{% include "roles/reviewer.md" %}
{%- else %}{% include "roles/default.md" %}
{%- endcase %}
```

- Paths are relative to the directory of `WORKFLOW.md`, also inside an included file, and must stay inside it:
  no absolute paths, no `./` or `../`. Only quoted paths work; `{% include role %}` with a variable does not.
- An included file sees the whole scope of the prompt, including what the body `capture`s before the include
  (`{% render %}` sees only what it is passed, as in standard Liquid).
- Symphony loads the included files together with `WORKFLOW.md`: a change to one of them reloads the workflow live,
  like a change to `WORKFLOW.md`. A missing file stops the start; on a reload it keeps the last good version and
  pauses new dispatches until the file is back (`missing_prompt_partial` in the log). A syntax error in an included
  file fails every run attempt, with the file's path in the error.
- Rendering reads only these files, never other files from the disk.
- A new role needs three things: its entry under [`roles`](#roles), a file `roles/<role>.md` and a line
  `{%- when "<role>" %}{% include "roles/<role>.md" %}` in the body. A role without a `when` line gets
  `roles/default.md`.
