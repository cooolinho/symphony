# Environment variables

Every variable Symphony, the compose files, the hooks and the check scripts read, grouped by topic, with its default.
[`.env.example`](../.env.example) holds only the values most setups need; [`./install.sh`](install.md) writes a lean
`.env` with exactly the values you chose.

How the values get in:

- **`.env`** next to `WORKFLOW.md` (or `--env-file <file>`; for several boards keep one file per board). Variables set
  in the shell take precedence; Symphony reports such a conflict at startup by name, never with the value.
- **`WORKFLOW.md`** reads them through references: `$VAR`, or `${VAR:-default}` with a default for a missing or empty
  variable ([configuration reference](configuration.md)). The defaults below are the ones in the bundled `WORKFLOW.md`.
- **docker compose** reads `.env` in the repository directory for its own interpolation (`${VAR}` in the compose files)
  and passes it to the containers (`env_file: .env`). In `.env`, a value with `$` must be in single quotes, e.g.
  `SYMPHONY_BASIC_AUTH='admin:$2y$05$…'`: compose takes it literally, and Node's `util.parseEnv` reads it unchanged.
- After changing `.env`, restart Symphony (`docker compose up -d` for the container; a plain `restart` does not re-read
  `.env`).

> **Changed in the slim `.env.example`:** the old template set `SYMPHONY_MAX_CONCURRENT_AGENTS=1`,
> `SYMPHONY_MAX_TURNS=5`, `SYMPHONY_MAX_CONTINUATIONS=6`, `SYMPHONY_MAX_SESSION_LIMIT_RETRIES=3`,
> `SYMPHONY_POLL_INTERVAL_MS=30000`, `SYMPHONY_CLEANUP_TERMINAL=true` and the `*_MAX_SUB_ISSUES` limits explicitly. An
> existing `.env` keeps working unchanged; a new one without these lines gets the `WORKFLOW.md` defaults below
> (notably 3 agent slots and 10 turns instead of 1 and 5).

## Required

| Variable | Default | Meaning |
|---|---|---|
| `GITHUB_PROJECT_NUMBER` | – | The board: its number (`10` from `https://github.com/users/<owner>/projects/10`) or the full URL `https://github.com/users/<owner>/projects/<n>` / `https://github.com/orgs/<org>/projects/<n>`. |
| `GITHUB_REPOSITORY` | – | Repository whose issues Symphony works on: `owner/name`. Comma-separate several repositories that share the board; issues from other repositories on the board are ignored. |
| `GITHUB_TOKEN` | – | Classic token with the scopes `repo` and `project`, or the gh login: `gh auth refresh -s project && gh auth token`. Symphony keeps it to itself: it is removed from the environment of agents and hooks. `GH_TOKEN` works as a fallback. |
| `CLAUDE_CODE_OAUTH_TOKEN` | – | Docker: from `claude setup-token` (on a machine with a browser). Natively optional: Claude Code otherwise uses its existing login. The entrypoint requires it or `ANTHROPIC_API_KEY`. |
| `GIT_USER_NAME`, `GIT_USER_EMAIL` | – | Docker: git identity for the agents' commits (without it every commit fails). Natively Symphony uses your global git identity. |

## GitHub and Claude

| Variable | Default | Meaning |
|---|---|---|
| `GITHUB_PROJECT_OWNER` | owner of the first repository | Board owner, e.g. an organization, if it is not the owner of the first repository (not needed with a board URL). |
| `CLAUDE_MODEL` | Claude Code default | Default model of the developer: an alias (`fable`, `opus`, `sonnet`, `haiku`) or a full model id. A `Model: <model>` label on an issue overrides it for that issue (create the labels with `npm run repo-init`); see [model per issue](usage.md#choosing-the-model-per-issue). |
| `CLAUDE_EFFORT` | Claude Code default | Default effort: `low`, `medium`, `high`, `xhigh` or `max`. An `Effort: <level>` label overrides it; see [effort per issue](usage.md#choosing-the-effort-per-issue). |
| `ANTHROPIC_API_KEY` | – | Instead of the Claude login or OAuth token; billed per use. |

## Dashboard and logs

| Variable | Default | Meaning |
|---|---|---|
| `SYMPHONY_PORT` | – natively (no dashboard), `4000` in compose | Dashboard and JSON API on `http://127.0.0.1:<port>/`. |
| `SYMPHONY_HOST` | `127.0.0.1` | Bind address of the dashboard; `0.0.0.0` only behind an authenticating reverse proxy (the compose files set it), see [Security](usage.md#security). |
| `SYMPHONY_ALLOW_REMOTE_CONTROL` | `false` | `true`: **Retry now** / **Resume now** on a non-loopback bind too, then only with a matching `Origin` header. |
| `SYMPHONY_LOG_DIR` | `~/.local/state/symphony` | Repository logs, session transcripts and runtime state; a relative path is resolved from the Symphony directory, e.g. `logs`. |
| `SYMPHONY_LOG_FILE` | compose: `/home/symphony/.local/state/symphony/symphony.log` | Orchestrator log file (entrypoint `--log-file`); empty = stderr only. The watchdog quotes it. |
| `SYMPHONY_PUBLIC_URL` | – | Public dashboard URL; links the commit statuses of `SYMPHONY_CHECKS_REPORT_STATUS` to it. |

## Orchestrator limits

Referenced in `WORKFLOW.md` as `${VAR:-default}`.

| Variable | Default | Meaning |
|---|---|---|
| `SYMPHONY_MAX_CONCURRENT_AGENTS` | `3` | Agent slots (`0` pauses all new starts). The dashboard can override them at runtime (stored in the runtime state, survives a restart): dashboard override > `WORKFLOW.md` > this value; "Reset to WORKFLOW.md" returns to it. About 1 CPU and 2 GB RAM per agent. The test stage needs at least 3 slots (4 to run it next to the issue analyst). |
| `SYMPHONY_DISPATCH_ORDER` | `priority` | `agent.dispatch_order`: `priority` (priority, then age) or `column_first` (rightmost board column first, so review stages get free slots before new issues). See [configuration](configuration.md#agent). |
| `SYMPHONY_MAX_TURNS` | `10` | Turns per session before Symphony re-evaluates the state. |
| `SYMPHONY_MAX_CONTINUATIONS` | `6` | Continuation sessions while the card stays active; after that Symphony pauses the issue (empty = unlimited). Role switches (developer ↔ reviewer) count as continuations, so keep a limit. See [continuations](usage.md#continuations-and-pausing). |
| `SYMPHONY_MAX_SESSION_LIMIT_RETRIES` | `3` | Retries per issue after the first session-limit failure; after that the worker waits for the reset (retry at reset + 1 minute, in memory only; `0` = wait right away). An unknown reset keeps the normal backoff. See [session limit](usage.md#session-limit). |
| `SYMPHONY_POLL_INTERVAL_MS` | `30000` | How often the board is polled. |
| `SYMPHONY_CHECKS_TIMEOUT_MS` | `1800000` (30 min) | Time limit of one entry check (lint, analysis, tests). Must stay below `claude.turn_timeout_ms` (3600000). A check that runs longer fails with `check_timeout` and the issue keeps its column. |
| `SYMPHONY_CLEANUP_TERMINAL` | `true` | Delete the workspace (after the `before_remove` hook, e.g. for a test database) once an issue reaches `Done`; `false` keeps it. |
| `SYMPHONY_AFTER_IMPLEMENTATION` | `Agent review` | Column the developer hands an implementation to: `Agent review` or `Testing`, where an independent test engineer writes tests for the acceptance criteria first (it may only change test files, see `pipeline.test_paths`). Bug issues always go to Testing (`pipeline.profiles.bugfix` in `WORKFLOW.md`), and so do feature and refactor issues (`pipeline.profiles.feature` and `.refactor`); this setting switches the stage on for every other issue too. The board needs a `Testing` column between `In progress` and `Agent review` either way. |

### Sub-issue limits

How many sub-issues a role may file per run.

| Variable | Default | Role |
|---|---|---|
| `SYMPHONY_ANALYST_MAX_SUB_ISSUES` | `60` | `/concept` analyst |
| `SYMPHONY_PLANNER_MAX_SUB_ISSUES` | `30` | `/plan` planner |
| `SYMPHONY_AUDITOR_MAX_SUB_ISSUES` | `20` | `/refactoring` auditor |
| `SYMPHONY_AUTOPILOT_MAX_SUB_ISSUES` | `5` | `/auto-code` autopilot, per wave |
| `SYMPHONY_ARCHITECT_MAX_SUB_ISSUES` | `5` | Work packages the architect may split one XL issue into (one sub-issue each, see [work packages](usage.md#work-packages-for-very-large-changes)) |

## Branches, merge gate and final gate

| Variable | Default | Meaning |
|---|---|---|
| `SYMPHONY_BASE_BRANCH` | the default branch | Integration branch agents branch from and open pull requests against (e.g. `develop`). |
| `SYMPHONY_AUTO_MERGE` | `false` | `true`: once the reviewer moves an issue to `In review` (checks passed), Symphony merges its pull request into `SYMPHONY_BASE_BRANCH`, closes the issue and moves it to `Done`. Needs `SYMPHONY_BASE_BRANCH`; never merges into the default branch; the label `manual-merge` opts out. Merges only when the pull request's checks passed, see the [merge gate](adapters/github-project.md#merge-gate). Used by the `/auto-code` autopilot ([usage](usage.md)). |
| `SYMPHONY_MERGE_WAIT_FOR_CHECKS` | `true` | Merge gate: wait for pending checks. |
| `SYMPHONY_MERGE_CHECKS_TIMEOUT_MS` | `3600000` | How long the merge gate waits for them. |
| `SYMPHONY_MERGE_IGNORE_CHECKS` | – | Checks to disregard, e.g. `acme/app:ci, acme/app:prod-smoke`. |
| `SYMPHONY_RELEASE_ENABLED` | `false` | `true`: the `/release` role (`releaser`) may publish releases with `publish_release`: it merges its version bump into `SYMPHONY_BASE_BRANCH`, merges that branch into the default branch, tags `vX.Y.Z` and creates the GitHub release. Unlike `SYMPHONY_AUTO_MERGE` this merges into the default branch. See [Releases](adapters/github-project.md#releases). |
| `SYMPHONY_RELEASE_CHECKS_WAIT_MS` | `240000` | How long one `publish_release` call waits for pending checks before it returns `pending` and the agent calls again. |
| `SYMPHONY_CHECKS_REPORT_STATUS` | `false` | The final gate before the merge (`checks.on_enter` "In review": the named checks `ci` and `prod-smoke`). `true` reports them as commit statuses `symphony/ci` and `symphony/prod-smoke`; `SYMPHONY_PUBLIC_URL` links them to the dashboard. |
| `SYMPHONY_CI_TIMEOUT_MS` | `1200000` | Time limit of `ci`, including a wait for its lock; `ci` and `prod-smoke` together must stay below `claude.turn_timeout_ms` (1 h). |
| `SYMPHONY_SMOKE_TIMEOUT_MS` | `1800000` | Time limit of `prod-smoke`. |
| `SYMPHONY_CHECK_LOCK_WAIT_S` | `900` | `checks/repo.sh --lock` (`ci`, `prod-smoke`): how long a run waits for another run of the same check; never more than half its time limit. Then it exits 75 (busy) and the issue continues after a backoff, see [repository checks](configuration.md#repository-checks-checksreposh). |
| `SYMPHONY_CHECK_LOCK_SCOPE` | `repository` | `host`: one run of each locked check on the whole host, across repositories, for a host whose CPUs several CI runs overload. |
| `SYMPHONY_TEST_PARALLEL` | – | Fast entry checks (Testing, Agent review): `php artisan test` in n processes if `vendor/bin/paratest` exists (installs nothing; a composer `test` script wins). |
| `SYMPHONY_CI_PARALLEL` | – | The same for `checks/laravel.sh --full` (the `ci` gate); `--full` installs a paratest the project requires. |
| `SYMPHONY_CI_DB` | – | `mysql`: `checks/laravel.sh --full` runs the tests against a MySQL database of its own (`SYMPHONY_MYSQL_*`), dropped afterwards. |
| `SYMPHONY_LARAVEL_APP_PATH` | the current directory | App directory for `checks/laravel.sh` in a repository with several Laravel apps. |

## Laravel

| Variable | Default | Meaning |
|---|---|---|
| `SYMPHONY_LARAVEL_BOOST` | `auto` | Laravel Boost per workspace; `off` switches it off (see [Laravel Boost](usage.md)). |
| `SYMPHONY_PHP` | `php` | PHP binary, e.g. `/usr/bin/php8.4`. |
| `SYMPHONY_COMPOSER` | `composer` | Composer binary, e.g. `/usr/local/bin/composer`. |
| `SYMPHONY_LARAVEL_DB` | SQLite | `mysql`: `hooks/laravel-env.sh` creates two MySQL databases per workspace (`SYMPHONY_MYSQL_*`), see [MySQL instead of SQLite](configuration.md#optional-mysql-instead-of-sqlite). |

## Docker

Not needed without Docker. See [docs/docker.md](docker.md). The SSH deploy key goes to `./secrets/ssh_key`
(git-ignored).

| Variable | Default | Meaning |
|---|---|---|
| `COMPOSE_PROJECT_NAME` | `symphony` | Compose project name and prefix of containers, networks and volumes. Change it if you run several Symphony setups on the same host. |
| `COMPOSE_PROFILES` | – | Optional services: `ci`, `brain`, `watchdog`, comma-separated (e.g. `ci,brain`). |
| `SYMPHONY_SSH_KEY` | `/run/secrets/ssh_key` | Path of the SSH key in the container; set it only if it is mounted elsewhere. |
| `UID`, `GID` | `1000` | Build args: owner of the volumes and of `./secrets/ssh_key` (`id -u`, `id -g`). |
| `PHP_VERSION` | `8.4` | PHP in the image. |
| `WITH_BROWSER` | `true` | `false`: image without headless Chromium (no UI screenshots by agents, about 600 MB smaller). |
| `WITH_DOCKER_CLI` | `true` | `false`: image without docker CLI, compose and buildx (no `ci` profile checks). |
| `TZ` | `Europe/Berlin` | Time zone of the container. |
| `PLAYWRIGHT_BROWSERS_PATH` | `/opt/ms-playwright` (image) | Where the image keeps headless Chromium; set by the `Dockerfile`, not in `.env`. |

### Traefik (docker-compose.yml)

| Variable | Default | Meaning |
|---|---|---|
| `SYMPHONY_DOMAIN` | – (required) | Host name of the dashboard in Traefik. |
| `SYMPHONY_BASIC_AUTH` | – | Dashboard login, an htpasswd line (`htpasswd -nB admin`). Keep the single quotes and every `$` single (no `$$`). |
| `SYMPHONY_TRAEFIK_MIDDLEWARES` | `symphony-auth` (the BasicAuth) | Instead of the BasicAuth, e.g. `authelia@docker` or `a@file,b@docker`. Without it or `SYMPHONY_BASIC_AUTH` every compose command aborts (fail closed). |
| `TRAEFIK_NETWORK` | `traefik` | External network of the Traefik project. |
| `TRAEFIK_ENTRYPOINT` | `websecure` | HTTPS entrypoint (`web` with `TRAEFIK_TLS=false`). |
| `TRAEFIK_TLS` | `true` | `false`: plain HTTP for a LAN Traefik without certificates. |
| `TRAEFIK_CERTRESOLVER` | `letsencrypt` | Set but empty (`TRAEFIK_CERTRESOLVER=`): Traefik's default certificate, e.g. a local CA (mkcert) in a LAN. |

### CI sidecars (profile `ci`)

A Docker-in-Docker daemon and a MySQL 8.0 server for checks that run a project's CI themselves (lint, static analysis,
tests on MySQL, prod smoke test). Off unless `COMPOSE_PROFILES` contains `ci`. `DOCKER_HOST` is deliberately not set
for the container: the check scripts map `SYMPHONY_CI_DOCKER_HOST` / `SYMPHONY_CI_DOCKER_CERT_PATH` to `DOCKER_HOST` /
`DOCKER_CERT_PATH` themselves. Details: [CI sidecars](docker.md#ci-sidecars-profile-ci).

| Variable | Default | Meaning |
|---|---|---|
| `SYMPHONY_CI_DOCKER_HOST` | – (`tcp://docker:2376`) | Docker daemon of the `dind` sidecar. |
| `SYMPHONY_CI_DOCKER_CERT_PATH` | – (`/certs/client`) | Its client certificates. |
| `SYMPHONY_MYSQL_HOST` | – (`symphony-ci-mysql`) | CI MySQL; keep the dedicated name (a `mysql` service of another project on the Traefik network could answer otherwise). |
| `SYMPHONY_MYSQL_PORT` | `3306` | |
| `SYMPHONY_MYSQL_USER` | – (`symphony`) | Account of the CI MySQL, created on its first start by `docker/ci/mysql-init.sh`, restricted to `symphony_%` databases; the same variables drive `hooks/laravel-env.sh` with `SYMPHONY_LARAVEL_DB=mysql`. |
| `SYMPHONY_MYSQL_PASSWORD` | – | Single line. |
| `SYMPHONY_CI_MYSQL_ROOT_PASSWORD` | – (required with the profile) | Root may log in only inside the mysql container. |
| `SYMPHONY_CI_SUBNET` | `172.31.250.0/24` | Subnet of the compose network `ci`; must not overlap networks the projects create inside dind (bandenhub's smoke test: `172.30.250.0/24`) or networks on the host. |
| `SYMPHONY_DOCKER_HOST_IP` | set by `checks/repo.sh` | Address of the ports the CI daemon publishes; not for `.env`. |

## Knowledge vault and Obsidian

`brain.enabled` in `WORKFLOW.md`, see [docs/brain.md](brain.md); in Docker the `brain` volume.

| Variable | Default | Meaning |
|---|---|---|
| `SYMPHONY_BRAIN_ENABLED` | `false` | `true`: create the vault at startup; roles with a brain mode get the brain tools. |
| `SYMPHONY_BRAIN_OBSIDIAN_URL` | – | "In Obsidian öffnen" on `/brain`, e.g. `https://brain.docker.lan`; empty hides it. |
| `BRAIN_DOMAIN` | – | Compose profile `brain`: host name of Obsidian in Traefik; always HTTPS (the web client refuses plain HTTP), same login as the dashboard. |
| `BRAIN_TRAEFIK_ENTRYPOINT` | `websecure` | HTTPS entrypoint for Obsidian; certificate as for the dashboard (`TRAEFIK_CERTRESOLVER`). |
| `BRAIN_PORT` | `3000` | `docker-compose.local.yml` only: Obsidian published on `127.0.0.1`. |

## Blocked watchdog (profile `watchdog`)

Diagnoses blocked issues and moves them back; off unless `COMPOSE_PROFILES` contains `watchdog`. Start in `observe`,
check `events.jsonl`, then switch to `act`. See [docs/watchdog.md](watchdog.md).

| Variable | Default | Meaning |
|---|---|---|
| `SYMPHONY_WATCHDOG_MODE` | `observe` | `observe` (log only), `comment` (post the diagnosis), `act` (post and move). |
| `SYMPHONY_WATCHDOG_MODEL` | `fable` | Model of the diagnosis. |
| `SYMPHONY_WATCHDOG_MAX_BUDGET_USD` | `3` | Per diagnosis. |
| `SYMPHONY_WATCHDOG_MAX_RESUMES` | `2` | Automatic resumes since the last human comment, then `needs-human`. |
| `SYMPHONY_WATCHDOG_API_URL` | compose: `http://symphony:4000` | The compose files set it; override only outside Docker. |
| `SYMPHONY_WATCHDOG_LOG_FILE` | compose: `/home/symphony/.local/state/symphony/symphony.log` | Orchestrator log the watchdog quotes; set by the compose files. |
| `SYMPHONY_WATCHDOG_STATE_DIR` | set by the compose files | The watchdog's own directory (`events.jsonl`, transcripts, `heartbeat.json`); the dashboard reads the heartbeat there. |

## History transfer

`scripts/push-history.sh` (see [docs/docker.md](docker.md#transferring-existing-history-to-the-server)); read on the
machine running the script.

| Variable | Default | Meaning |
|---|---|---|
| `SYMPHONY_REMOTE` | – (required) | SSH target, e.g. `user@docker.lan`. |
| `SYMPHONY_CONTAINER` | `symphony` | Container name on the server, with Compose usually `<project>-symphony-1`. |
| `SYMPHONY_LOCAL_STATE` | `$SYMPHONY_LOG_DIR`, otherwise `~/.local/state/symphony` | Local log directory. |

## Set by Symphony for hooks and checks

Not for `.env`: Symphony sets these for the workspace hooks and check scripts.

| Variable | Meaning |
|---|---|
| `SYMPHONY_WORKFLOW_DIR` | Directory of `WORKFLOW.md`; hooks call `$SYMPHONY_WORKFLOW_DIR/hooks/…`. |
| `SYMPHONY_ISSUE_REPOSITORY` | The issue's own repository (`owner/name`), so one board can span several. |
| `SYMPHONY_WORKSPACE`, `SYMPHONY_WORKSPACE_KEY` | Path and key of the issue's workspace (e.g. for the database names). |
| `SYMPHONY_HOOK`, `SYMPHONY_ISSUE_ID`, `SYMPHONY_ISSUE_IDENTIFIER`, `SYMPHONY_ISSUE_URL`, `SYMPHONY_ISSUE_BRANCH` | The running hook and the issue it runs for. |

← [Documentation](index.md) · Setup: [Installer](install.md), [Getting Started](getting-started.md), [Docker](docker.md)
