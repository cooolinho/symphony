# Getting Started

> Running Symphony on a server in Docker behind Traefik? Then follow [docker.md](docker.md). This guide covers running
> without Docker; you set up the board and token as described here in both cases.

## Requirements

| What | Check with |
|---|---|
| Linux, WSL2 or macOS with **Node.js ≥ 26** and npm | `node --version` |
| **git** with SSH access to GitHub (Symphony clones via SSH, the agent pushes via SSH) | `ssh -T git@github.com` |
| **Claude Code**, logged in. Alternatively an `ANTHROPIC_API_KEY` | start `claude`, run `/login` if needed |
| **GitHub token** with the scopes `repo` and `project` | see step 3 |
| Laravel repositories only: **PHP** and **Composer** in the versions the projects use | `php --version`, `composer --version` |

The Claude Agent SDK ships its own Claude Code CLI. It uses the same login as your installed `claude`.

## 1. Install

```bash
cd ~/projects/symphony
npm install
```

## 2. Set up the GitHub Project board

1. On GitHub, go to **Profile → Projects → New project** and create a project from the **Kanban** template. It comes
   with the columns `Backlog`, `Ready`, `In progress`, `In review` and `Done`.
2. Add the columns `Agent review` and `Blocked`: on the board, add two options via the menu of the **Status** field (or
   *Settings → Fields → Status*). The order does not matter; this one is easy to follow:

   | Column | Who moves cards here | What Symphony does |
   |---|---|---|
   | `Backlog` | you | nothing |
   | `Ready` | you | starts the **Developer** |
   | `In progress` | Developer, Reviewer (changes needed) | Developer works |
   | `Agent review` | Developer, after passing checks | starts the **Reviewer** (at most one at a time) |
   | `Blocked` | Developer or Reviewer | stops the agent, workspace is kept; your turn |
   | `In review` | only the Reviewer, after passing checks | stops the agent, workspace is kept; your review |
   | `Done` | only you | stops the agent and deletes the workspace |

   The bundled `WORKFLOW.md` expects exactly these names. The dry run (step 6) reports every column missing from the
   board (`unknown board column`).
3. Note the **board number** from the URL, e.g. `10` from `https://github.com/users/cooolinho/projects/10`.
4. Add issues: on the board via **+ Add item** and then `#` for an issue of your repository, or in an issue's sidebar
   under **Projects**. Symphony only works on real issues, not on drafts or pull requests.
5. Optional: create dependencies and sub-issues. Symphony starts an issue only once everything it depends on is done.
   See [Dependencies and sub-issues](usage.md#dependencies-and-sub-issues).

> If your columns have different names, for example `Todo`, `In Progress`, `Human Review` and `Done` (another
> template), adjust `active_states`, `terminal_states`, `roles`, `checks.on_enter`, `agent.max_concurrent_agents_by_state`
> and the status names in the prompt of `WORKFLOW.md`. You need a hand-off column that is neither active nor terminal
> (here `In review`). Without it the agent never stops, see
> [Troubleshooting](usage.md#troubleshooting).

## 3. Create a GitHub token

You have two options:

- **Classic personal access token:** GitHub → *Settings → Developer settings → Personal access tokens →
  Tokens (classic) → Generate new token*. Select the scopes **`repo`** and **`project`**. A classic token works with
  boards in both user and organization accounts.
- **Reuse the GitHub CLI login:**

  ```bash
  gh auth refresh -s project
  gh auth token
  ```

  The second command prints the token.

## 4. Create `.env`

```bash
cp .env.example .env
chmod 600 .env
```

Then fill in your values:

```dotenv
GITHUB_PROJECT_NUMBER=10
GITHUB_REPOSITORY=cooolinho/trainingsstunden-portal
CLAUDE_MODEL=opus
GITHUB_TOKEN=ghp_…

# Orchestrator limits (optional, otherwise the defaults from WORKFLOW.md apply)
SYMPHONY_MAX_CONCURRENT_AGENTS=1
SYMPHONY_MAX_TURNS=5
SYMPHONY_MAX_CONTINUATIONS=6
SYMPHONY_MAX_SESSION_LIMIT_RETRIES=3
SYMPHONY_POLL_INTERVAL_MS=30000
SYMPHONY_CLEANUP_TERMINAL=true
```

| Variable | Meaning |
|---|---|
| `GITHUB_PROJECT_NUMBER` | Number of the board. The full board URL works too. |
| `GITHUB_REPOSITORY` | `owner/name` of the repository. Separate multiple repositories with commas. Issues from other repositories on the board are ignored. |
| `CLAUDE_MODEL` | Default model for Claude Code: an alias such as `opus` or `sonnet`, or a full model ID. Empty means the Claude Code default. A `Model: …` label on the issue takes precedence, see [Choosing the model per issue](usage.md#choosing-the-model-per-issue). |
| `CLAUDE_EFFORT` | *optional:* Default effort for Claude Code: `low`, `medium`, `high`, `xhigh` or `max`. Empty means the Claude Code default. An `Effort: …` label on the issue takes precedence, see [Choosing the effort per issue](usage.md#choosing-the-effort-per-issue). |
| `GITHUB_TOKEN` | Token from step 3. It is removed from the environment of agents and hooks. |
| `GITHUB_PROJECT_OWNER` | *optional:* Owner of the board if it is not the repository owner (e.g. an organization) |
| `SYMPHONY_PORT` | *optional:* Port for the dashboard and API, e.g. `4000` for `http://127.0.0.1:4000/` |
| `SYMPHONY_HOST` | *optional:* Bind address of the dashboard. Default `127.0.0.1`; use `0.0.0.0` (e.g. in a container) only behind a reverse proxy with login, see [Security](usage.md#security). |
| `SYMPHONY_ALLOW_REMOTE_CONTROL` | *optional:* `true` allows **Retry now** / **Resume now** on a non-loopback address too, then only with a matching `Origin` header. Default `false`. |
| `ANTHROPIC_API_KEY` | *optional:* Otherwise Claude Code uses its existing login. |
| `SYMPHONY_MAX_CONCURRENT_AGENTS` | *optional:* How many agents run at the same time. Default 2; `0` pauses all new starts. |
| `SYMPHONY_MAX_TURNS` | *optional:* Turns per session before Symphony re-evaluates the state. Default 10. |
| `SYMPHONY_MAX_CONTINUATIONS` | *optional:* How many more sessions an issue gets while its card stays active. Every switch between Developer and Reviewer counts. After that Symphony **pauses** the issue, see [Continuations and pausing](usage.md#continuations-and-pausing). Default 6; empty means unlimited. |
| `SYMPHONY_MAX_SESSION_LIMIT_RETRIES` | *optional:* How often Symphony retries an issue after the first session limit error before the worker waits for the reset. After that it waits until the reset (reset + 1 minute), see [Session limit](usage.md#session-limit). Default 3; `0` means wait right away. |
| `SYMPHONY_POLL_INTERVAL_MS` | *optional:* How often the board is polled, in milliseconds. Default 30000. |
| `SYMPHONY_CLEANUP_TERMINAL` | *optional:* `true` (default) deletes the workspace as soon as an issue lands in `Done`. The `before_remove` hook runs first, e.g. for a test database. `false` keeps the workspaces. |
| `SYMPHONY_LOG_DIR` | *optional:* Directory for repository logs and session transcripts. Default: `~/.local/state/symphony`. A relative path is resolved from the Symphony directory, e.g. `logs`. |

`WORKFLOW.md` reads these values through references such as `$GITHUB_TOKEN` or `${SYMPHONY_MAX_TURNS:-10}`. The second
form has a default in case the variable is missing or empty. Variables already set in your shell take precedence over
`.env`. Symphony reports such a conflict at startup with the variable name, never with the value. After changing `.env`
you have to restart Symphony.

## 5. Create labels (optional)

With labels such as `Model: sonnet` and `Effort: high` you choose the model and effort per issue, see [Choosing the model per issue](usage.md#choosing-the-model-per-issue) and [Choosing the effort per issue](usage.md#choosing-the-effort-per-issue).
The `repo-init` script creates them in the repositories from `GITHUB_REPOSITORY`:

```bash
npm run repo-init
```

It walks you through a selection list, shows what it would create before each change, and asks for confirmation. More
in [Setting up repositories (repo-init)](usage.md#setting-up-repositories-repo-init).

## 6. Check the setup (dry run)

```bash
npm run dry-run
```

The dry run loads `WORKFLOW.md` and `.env`, validates the configuration, reads the board and shows what Symphony would
start. It also checks whether `php` and `composer` work for Laravel Boost, and lists the detected Laravel apps for
issues with an existing workspace. It does not start any agents. Example:

```
Workflow:        /home/cooolinho/projects/symphony/WORKFLOW.md
Env file:        /home/cooolinho/projects/symphony/.env
Tracker:         github_project
Active states:   Ready, In progress, Agent review
…
Plugins:         /home/cooolinho/projects/symphony/.claude; skills: all
Laravel Boost:   auto, for Laravel apps that require laravel/boost; php (PHP 8.4.12), composer (Composer version 2.8.12 …)

Candidates in active states: 3
  dispatch  cooolinho/trainingsstunden-portal#12  [Ready]  Export billing as CSV
            ↳ Laravel app laravel/: Laravel Boost
  skip      cooolinho/trainingsstunden-portal#15  [Ready]  Export button in the dashboard
            ↳ blocked by cooolinho/trainingsstunden-portal#12
  skip      cooolinho/trainingsstunden-portal#16  [Ready]  Export feature
            ↳ waiting for sub-issues cooolinho/trainingsstunden-portal#15

Prompt preview for cooolinho/trainingsstunden-portal#12:
  | You are working on GitHub issue **cooolinho/trainingsstunden-portal#12**: …
```

On an error the dry run exits with code 1 and a specific message, e.g. a missing token scope.

## 7. Start

```bash
npm start
```

Symphony runs in the foreground and writes its logs to the terminal. With `SYMPHONY_PORT=4000` in `.env` the dashboard
is available at <http://127.0.0.1:4000/>.

- **Stop:** `Ctrl+C`. Symphony stops running agents and waits until their `after_run` hooks are done. A second
  `Ctrl+C` exits immediately.
- **Run in the background:** e.g. in `tmux` or `screen`, or with a log file:
  `npm start -- --log-file ~/symphony.log`

← [Documentation](index.md) · Next: [Usage](usage.md)
