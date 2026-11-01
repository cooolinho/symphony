# Symphony for Laravel × Claude Code

![Project Preview](docs/preview.gif)

**English** | [Deutsch](README.de.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node.js 26](https://img.shields.io/badge/Node.js-26-5FA04E?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Claude Code](https://img.shields.io/badge/Claude_Code-D97757?logo=claude&logoColor=white)
![Laravel Boost](https://img.shields.io/badge/Laravel_Boost-FF2D20?logo=laravel&logoColor=white)

An autonomous coding pipeline: move a GitHub issue to **Ready**, and Symphony hands it to a team of **Claude Code**
agents. An analyst works out the requirements, an architect designs larger changes, a developer implements them in an
isolated workspace, a test engineer and a read-only reviewer check the result, and once every check is green Symphony
merges the pull request into `develop`. You watch it on a live dashboard and step in where an agent needs you.

## 📖 About

This repository is my take on agent-driven software delivery: a long-running service that turns a project board into a
queue of work for AI agents. Guard rails make it safe to run unattended: entry checks before every handoff, read-only
review and security roles, bounded review loops, cost and context budgets, permission modes and a merge gate. Agents
share what they learn in a knowledge vault (the *brain*), and **Laravel** projects get first-class support through
**Laravel Boost**.

### Origin: the OpenAI Symphony specification

Symphony is an independent implementation of the
[**Symphony Service Specification**](https://github.com/openai/symphony/blob/main/SPEC.md) published by OpenAI:

> Symphony is a long-running automation service that continuously reads work from a configured issue tracker, creates
> an isolated workspace for each issue, and runs a coding agent session for that issue inside the workspace.

The spec defines the core: a `WORKFLOW.md` that holds the configuration and the prompt next to the code, one workspace
per issue, a polling loop with bounded concurrency, reconciliation, retries and an optional HTTP status API. It targets
the Codex app-server as its coding agent and leaves the tracker to adapters. This implementation keeps that contract
([conformance notes](docs/conformance.md)) and extends it:

| Spec | This implementation |
|---|---|
| Codex app-server | **Claude Code** through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) ([mapping](docs/agent-claude.md)) |
| Pluggable tracker | **GitHub Projects (v2)** adapter: board columns drive the workflow ([profile](docs/adapters/github-project.md)) |
| One agent per issue | **A role per column**: analyst, architect, developer, test engineer, docs agent, reviewer and security auditor, plus command roles that file sub-issues |
| Agent decides when it is done | **Typed results and checks**: every stage reports a verdict, entry checks gate each handoff, a merge gate runs the repository's CI before the merge |
| Status API | **Live dashboard** with team view, change feed, knowledge vault and statistics, plus a JSON API |
| Generic repositories | **Tailored to Laravel**: Laravel Boost per workspace, a database per workspace, Laravel check scripts and subagents |

### Built for Laravel projects

Symphony works with any repository, but it is tuned for Laravel applications:

- **Laravel Boost, automatically.** When a workspace contains a Laravel app that requires `laravel/boost`, Symphony
  installs the Composer dependencies, generates Boost's guidelines and skills for exactly the installed package
  versions, and attaches Boost's MCP server (documentation search, database schema, logs) to the session. Generated
  files never end up in the pull request.
- **One environment per issue.** [`hooks/laravel-env.sh`](hooks/laravel-env.sh) gives every workspace its own `.env`
  and SQLite database (MySQL optional); [`hooks/laravel-db-drop.sh`](hooks/laravel-db-drop.sh) cleans up.
- **Laravel checks.** [`checks/laravel.sh`](checks/laravel.sh) runs Pint, static analysis and the tests before a
  handoff; with `--full` it runs the whole suite in parallel as the CI gate before the merge.
- **Laravel-aware subagents.** The shared toolbox in [`.claude/`](.claude/README.md) ships specialists such as
  `laravel-filament-developer`, `laravel-database-engineer`, `laravel-test-engineer` and `laravel-code-reviewer`
  ([how they relate to the roles](docs/laravel-subagents.md)); repository conventions are in
  [docs/laravel-repositories.md](docs/laravel-repositories.md).

## ⚙️ How it works

```
Ready            issue analyst: requirements, risks, refined acceptance criteria, Type and Complexity labels
  ▼
Design           architect (larger changes): approach and interfaces, optionally work packages as sub-issues
  ▼
In progress      developer: branch, implementation, tests, pull request
  ▼ checks
Testing          test engineer: tests for the acceptance criteria (bug, feature and refactor issues)
  ▼
Documentation    docs agent: only when the change needs documentation
  ▼ checks
Agent review     reviewer (read-only) ──── changes needed ────▶ back to In progress
  ▼
Security review  security auditor (read-only): only for security-relevant changes
  ▼ ci, prod-smoke
In review        merge gate: Symphony squash-merges into develop (auto_merge), or the pull request waits for you
  ▼
Done             workspace removed; with the brain on, an issue summary lands in the vault

Blocked          an agent needs you: open questions, a broken environment, or the round limit (label needs-human)
```

Symphony polls a **GitHub Project board** and hands every issue in an active column to the role of that column. Each
issue gets its own workspace: a clone of the repository on the branch `symphony/issue-<number>`. A stage ends with a
typed result (`report_result`); Symphony posts it on the issue, runs the entry checks of the next column and moves the
card. Small issues skip the stages they do not need without starting a session.

What the agents do is defined in **`WORKFLOW.md`** (settings and the shared prompt) and the role prompts it includes
from **`roles/<role>.md`**. Board, repositories, models, tokens and switches live in **`.env`**.

## ✨ Features

### Pipeline

- **Board-driven:** the columns of your GitHub Project board drive the flow, ordered by priority and age, with bounded
  concurrency overall and per column. Open blockers and sub-issues are respected; one instance can serve several
  repositories.
- **Multi-agent pipeline:** every stage hands off with a typed result (`report_result`) instead of moving the card
  itself. Symphony computes the next column from the verdict, per issue type through workflow profiles, and bounds the
  review, test and security loops with round limits; at the limit the issue waits for you with the label `needs-human`
  ([architecture](docs/concepts/multi-agent.md), [result contracts](docs/results.md),
  [rounds and manual resume](docs/usage.md#rounds-limits-and-manual-resume)).
- **Architect:** larger changes pass through the `Design` column first, where a read-only architect decides on the
  approach before the developer implements it ([details](docs/configuration.md#the-architect)).
- **Work packages:** a very large feature (complexity `XL`) can be split by the architect into work packages, one
  sub-issue each, with their own pipeline, workspace, branch and pull request. The parent waits until all of them are
  closed; then the reviewer checks the integrated base branch against its acceptance criteria
  ([details](docs/configuration.md#work-packages-split),
  [why](docs/concepts/multi-agent.md#work-packages-instead-of-an-integration-engineer)).
- **Test engineer, docs agent and security auditor:** an independent agent writes tests for the acceptance criteria
  and may only change test files ([details](docs/configuration.md#the-test-engineer)); a cheap `haiku` agent updates
  the docs when the change needs it ([details](docs/configuration.md#the-documentation-stage)); a read-only auditor
  checks security-relevant changes such as policies, middleware, routes and migrations
  ([details](docs/configuration.md#the-security-auditor)).
- **Checks and merge gate:** entry checks (lint, static analysis, tests) run before every handoff; a failing check
  keeps the card where it is and the agent fixes it. Before the merge the named checks `ci` and `prod-smoke` run the
  repository's own CI and an image smoke test, optionally reported as commit statuses `symphony/*`. With `auto_merge`
  Symphony then squash-merges into `develop` and closes the issue
  ([merge gate](docs/adapters/github-project.md#merge-gate), [auto-merge](docs/usage.md#auto-merge-into-develop)).
- **Issue commands:** a description that starts with a command loads a skill instead of the normal pipeline:
  `/refactoring` audits a codebase and files sub-issues, `/refactor-safely` implements them behaviour-neutrally,
  `/auto-code` evolves a project in waves ([autopilot](docs/usage.md#autopilot-auto-code)), `/concept` and `/plan`
  turn a concept or a list into a backlog ([concept](docs/usage.md#concept-to-backlog-concept),
  [list](docs/usage.md#list-to-backlog-plan)), and `/brain-garden` tidies the knowledge vault.
- **Images and files in the issue:** mockups, screenshots and PDFs attached to an issue are downloaded into the
  workspace, and agents take UI screenshots of their own changes with the headless Chromium in the image
  ([details](docs/usage.md#images-and-files-in-the-issue)).

### Dashboard

- **Live overview:** system cards (CPU, memory, disk, load, agent slots, GitHub API budget), alerts, the context
  budget of the 5-hour window and the week, the teams at work and an activity stream, updated live over Server-Sent
  Events.
- **Tasks:** what runs, what starts next and why an issue waits (column limits, model holds, backoff, pauses, blockers),
  with controls for the agent slots, retry, start now, pause and resume.
- **Team view per issue:** the stages of the issue as a score, the running session with its subagents, the execution
  trace (prompts, model and tool calls, phases, tokens, cost), all sessions and the transcript.
- **Changes:** a feed of every commit, merge and brain change by day, with diffs, check states and hotspots.
- **Brain:** vitals of the knowledge vault, the review of candidate notes (promote, discard, undo), a link graph, the
  folder structure and write clashes with a side-by-side comparison.
- **Statistik:** cost, tokens and agent time per day, model, role and repository, the budget history and every run.

Details: [dashboard and API](docs/usage.md#dashboard-and-api).

### Knowledge vault (brain)

- **Shared memory:** one vault of Markdown notes with YAML frontmatter for all repositories, kept under git. Agents
  read and write it only through the `brain_*` tools; every write is a commit by `symphony-<role>`.
- **Human in the loop:** new notes are candidates; only a human promotes them to `approved`, on the dashboard or in
  Obsidian. Approved notes are read-only for agents, and clash rules stop two runs from overwriting each other.
- **Obsidian in the browser:** the compose profile `brain` runs Obsidian on the same vault behind Traefik.
- **Grows with the work:** after every merge Symphony writes an issue summary; the gardener role proposes merges and
  fixes for duplicates, orphans and broken links.

Details: [docs/brain.md](docs/brain.md).

### Operations

- **Budgets and limits:** when the Claude subscription hits its limit, Symphony retries and then waits for the reset;
  a limit of one model only puts that model on hold. A cost budget per issue and the context fill per session keep
  long runs in check ([session limit](docs/usage.md#session-limit),
  [cost budget](docs/usage.md#cost-budget-per-issue)).
- **Costs per repository:** every run is logged with model, effort, tokens, estimated cost (from
  [`model-costs.yml`](model-costs.yml)) and agent time.
- **Robust:** retries with exponential backoff, stall detection, an agent stops when its issue changes on the board,
  and `WORKFLOW.md` reloads without a restart.
- **Docker:** an image with Node, PHP, Composer, pnpm, yarn, gitleaks and headless Chromium runs as a non-root user
  behind Traefik; the compose profile `ci` adds a Docker daemon and MySQL for the CI gate, `brain` adds Obsidian
  ([docs/docker.md](docs/docker.md)).
- **Secure by default:** the GitHub token stays in the Symphony process, agents never see it; read-only roles cannot
  change files; the dashboard listens on `127.0.0.1` unless you put it behind a proxy with a login.

## 🤖 Claude models and effort, chosen per issue by label

Labels on the issue pick the **Claude model** and the **thinking effort** for the developer that works on it.

| Label | Effect |
|---|---|
| `Model: fable` | Claude Fable for complex, high-risk work (data model, permissions, migrations, major upgrades) |
| `Model: opus` | Claude Opus for hard, open-ended work (architecture, tricky bugs, larger features) |
| `Model: sonnet` | Claude Sonnet for everyday implementation work |
| `Model: haiku` | Claude Haiku for small, well-defined changes (docs, copy, config) |
| `Model: claude-opus-5-5` | Any full model id works as well |
| `Effort: low` … `Effort: max` | Thinking effort: `low`, `medium`, `high`, `xhigh`, `max` |

- Without a label the developer uses `CLAUDE_MODEL` / `CLAUDE_EFFORT` from `.env` (`opus` at complexity L and XL).
  The roles with a fixed task keep their own model, following "plan strong, implement cheaper": the architect designs
  with `opus` (`fable` at L and XL), the reviewer and the security auditor check with `opus`, the docs agent writes
  with `haiku` ([model and effort per role](docs/usage.md#model-and-effort-per-role)).
- `npm run repo-init` creates the model and effort labels (and the command labels) in your repositories.
- With `/auto-code … issue-models=auto`, the autopilot labels each sub-issue with a model that fits the task.

Details: [choosing the model](docs/usage.md#choosing-the-model-per-issue) and
[the effort](docs/usage.md#choosing-the-effort-per-issue) per issue.

## 🧰 Tech stack

| | Technology | Used for |
|---|---|---|
| <img src="https://cdn.simpleicons.org/claude" width="24" alt="Claude"> | **Claude Code** + [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) | Coding agents: sessions, turns, permission modes, plugins, skills, subagents |
| <img src="https://cdn.simpleicons.org/anthropic" width="24" alt="Anthropic"> | **Claude Fable / Opus / Sonnet / Haiku** | Models per role and per issue, with effort per issue |
| <img src="https://cdn.simpleicons.org/nodedotjs" width="24" alt="Node.js"> | **Node.js 26** | Runtime; runs TypeScript directly, tests with `node:test` |
| <img src="https://cdn.simpleicons.org/typescript" width="24" alt="TypeScript"> | **TypeScript** | The orchestrator, the dashboard and the tools, type-checked with `tsc` |
| <img src="https://cdn.simpleicons.org/github" width="24" alt="GitHub"> | **GitHub Projects v2, GraphQL & REST API** | Tracker: board columns, issues, sub-issues, labels, pull requests, commit statuses |
| <img src="https://cdn.simpleicons.org/githubactions" width="24" alt="GitHub Actions"> | **GitHub Actions** | CI (`npm run check`, Docker build and start test) |
| <img src="https://cdn.simpleicons.org/modelcontextprotocol" width="24" alt="MCP"> | **Model Context Protocol** | In-process tracker and brain tools for the agents; Laravel Boost's MCP server |
| <img src="https://cdn.simpleicons.org/laravel" width="24" alt="Laravel"> | **Laravel + Laravel Boost**, **PHP + Composer** | Target projects: Boost per workspace, preparing workspaces, running their checks |
| <img src="https://cdn.simpleicons.org/obsidian" width="24" alt="Obsidian"> | **Obsidian** | Reviewing and editing the knowledge vault in the browser |
| <img src="https://cdn.simpleicons.org/googlechrome" width="24" alt="Chromium"> | **Playwright + headless Chromium** | UI screenshots taken by the agents |
| <img src="https://cdn.simpleicons.org/docker" width="24" alt="Docker"> | **Docker + Docker Compose** | Server deployment, CI sidecars (Docker-in-Docker, MySQL) |
| <img src="https://cdn.simpleicons.org/traefikproxy" width="24" alt="Traefik"> | **Traefik** | Reverse proxy with HTTPS and login for the dashboard and Obsidian |
| <img src="https://cdn.simpleicons.org/zod" width="24" alt="Zod"> | **Zod**, **LiquidJS**, **YAML** | Config validation, prompt templates, front matter |

## 🚀 Getting started

You need Node.js ≥ 26, git with SSH access to GitHub, a logged-in Claude Code and a GitHub token with the `repo` and
`project` scopes. Create a GitHub Project board with the columns `Backlog`, `Ready`, `Design`, `In progress`,
`Testing`, `Documentation`, `Agent review`, `Security review`, `Blocked`, `In review` and `Done`.

```bash
npm install
cp .env.example .env    # board number, repositories, model and token
npm run repo-init       # standard labels in your repositories
npm run dry-run         # check the setup without starting agents
npm start               # start Symphony
```

For a server, run the Docker image behind Traefik instead (`docker compose up -d --build`); a local test run of the
same image without Traefik uses `docker-compose.local.yml`. Turn on the knowledge vault with
`SYMPHONY_BRAIN_ENABLED=true` and Obsidian with the compose profile `brain`.

Step by step: [docs/getting-started.md](docs/getting-started.md) and [docs/docker.md](docs/docker.md).

## 📋 Usage

Move an issue to `Ready`. The analyst works out requirements, risks and refined acceptance criteria and sets `Type:`
and `Complexity:` labels where the issue has none, or asks you a question in `Blocked`. From there the pipeline runs on
its own: design, implementation, tests, docs, review and security audit as the issue needs them. With `auto_merge` the
pull request lands in `develop` once the review approved it and every check passed; you release `develop` to `main`
yourself ([git flow](docs/gitflow.md)).

While it runs, the dashboard (`SYMPHONY_PORT`) shows who works on what and why an issue waits. Comment on the issue to
steer an agent, add labels like `Model: opus` or `Effort: high`, pause or retry an issue, and promote the notes the
agents propose in the brain.

Everything else is in [docs/usage.md](docs/usage.md): the life of an issue, intervening while it runs, dependencies,
model choice, commands, dashboard and API, logs and cost, several repositories, security and troubleshooting.

## 📁 Project structure

```
symphony/
├── WORKFLOW.md                 # settings, roles, checks and the shared prompt (reloaded live)
├── roles/                      # one prompt per role (issue-analyst.md, architect.md, developer.md, …)
├── checks/                     # entry checks and the CI gate: laravel.sh, repo.sh (named checks ci, prod-smoke)
├── hooks/                      # workspace hooks: laravel-env.sh (own .env and database), laravel-db-drop.sh
├── .claude/                    # toolbox for all sessions, loaded as plugin "symphony" (skills, agents, commands)
├── bin/screenshot.mjs          # symphony-screenshot: PNG of a page with headless Chromium, for agents
├── model-costs.yml             # model prices for the cost estimate (reloaded live)
├── Dockerfile                  # image with Node, PHP, Composer, pnpm, yarn, git, gitleaks and headless Chromium
├── docker-compose.yml          # deployment behind Traefik; profiles ci (Docker-in-Docker, MySQL) and brain (Obsidian)
├── docker-compose.local.yml    # local test run of the same image without Traefik
├── docker/                     # entrypoint, SSH known hosts and the CI sidecar setup
├── .env.example                # template for .env
├── repo-init.ts                # interactive repository setup (labels, Laravel Boost issue)
├── scripts/                    # demo dashboard, end-to-end and Laravel tests, history transfer to a server
├── src/
│   ├── cli.ts, service.ts      # entry point, startup, shutdown, dry run
│   ├── workflow/               # load and validate WORKFLOW.md, templates, live reload
│   ├── tracker/                # GitHub Projects adapter, agent tools, merge gate and auto-merge
│   ├── orchestrator/           # polling, dispatch, pipeline stages, reconciliation, retries
│   ├── agent/                  # Claude Code sessions via the Claude Agent SDK, models, limits
│   ├── workspace/              # per-issue workspaces, hooks, git
│   ├── brain/                  # knowledge vault: tools, index, git versioning, access log, promotion
│   ├── changes/                # change feed of commits, merges and brain changes
│   ├── history/, costs/        # per-repository log, statistics, cost estimate
│   ├── budget/, system/        # context and rate-limit budget, host metrics
│   ├── http/                   # dashboard pages, live updates and JSON API
│   ├── laravel/, integrations/ # Laravel detection and Laravel Boost per workspace
│   ├── repo-init/              # repo-init: GitHub REST client, standard labels
│   └── util/                   # helpers (.env, paths, errors, …)
├── test/                       # tests with node:test
└── docs/                       # documentation (start at docs/index.md)
```

## 📚 Documentation

Start at [docs/index.md](docs/index.md).

- [docs/getting-started.md](docs/getting-started.md): step-by-step setup
- [docs/docker.md](docs/docker.md): running with Docker behind Traefik: setup, HTTPS, CI sidecars, Obsidian, backup, troubleshooting
- [docs/usage.md](docs/usage.md): operation, dashboard and API, commands, logs and cost, troubleshooting
- [docs/configuration.md](docs/configuration.md): every `WORKFLOW.md` option, `$VARIABLE` references, hooks and prompt variables
- [docs/adapters/github-project.md](docs/adapters/github-project.md): the GitHub Projects adapter: settings, agent tools, merge gate, errors
- [docs/agent-claude.md](docs/agent-claude.md): Claude Code sessions, permissions, skills and plugins, brain tools, cost accounting
- [docs/brain.md](docs/brain.md): the knowledge vault: layout, frontmatter, tools, role switch, clash rules, Obsidian, backup and reset
- [docs/results.md](docs/results.md): result contracts of the pipeline stages: kinds, verdicts, the `report_result` tool, recovery
- [docs/concepts/multi-agent.md](docs/concepts/multi-agent.md): the multi-agent pipeline: architecture, decisions and spike results
- [docs/conformance.md](docs/conformance.md): differences from the specification and implementation-defined behavior
- [docs/laravel-repositories.md](docs/laravel-repositories.md) and [docs/laravel-subagents.md](docs/laravel-subagents.md): Laravel conventions and subagents
- [docs/gitflow.md](docs/gitflow.md): branches, pull requests, merges and releases
- [docs/e2e.md](docs/e2e.md): end-to-end test of the orchestration and the Laravel integration test

## 🛠️ Development

```bash
npm test                 # tests
npm run typecheck        # TypeScript check
npm run check            # both
node scripts/demo.ts     # dashboard with made-up data on http://127.0.0.1:4000 (no GitHub, no Claude)
npm run e2e              # end-to-end test on a test board (creates real issues)
npm run test:laravel     # Laravel integration against a real app (needs PHP 8.3+, Composer, network)
```

Every change goes through a pull request into `develop`; releases go from `develop` to `main` with a release pull
request and a tag `vX.Y.Z` ([git flow](docs/gitflow.md)). CI ([.github/workflows/ci.yml](.github/workflows/ci.yml))
runs `npm run check` on Node 26 and builds and starts the Docker image for every pull request. Symphony's own agents
work on this repository too: their pull requests are merged into `develop` by the merge gate once the review approved
them and every check passed. For setups whose agents target the default branch,
[.github/workflows/automerge.yml](.github/workflows/automerge.yml) squash-merges agent pull requests after CI; it
leaves pull requests from forks, with the label `manual-merge`, without a linked issue or touching `.github/` or the
package files to a human.

## 🔗 References

- [Symphony Service Specification](https://github.com/openai/symphony/blob/main/SPEC.md) and the
  [reference implementation](https://github.com/openai/symphony) (OpenAI, Apache-2.0)
- [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk),
  [Claude Code settings and sandbox](https://code.claude.com/docs/en/settings#sandbox-settings),
  [plugins](https://code.claude.com/docs/en/plugins) and [skills](https://code.claude.com/docs/en/skills)
- [Laravel Boost](https://laravel.com/docs/boost) and [Agent Skills](https://agentskills.io/what-are-skills)
- [GitHub Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects) and
  [the Projects API](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)
- [Obsidian](https://obsidian.md) and the [linuxserver.io Obsidian image](https://docs.linuxserver.io/images/docker-obsidian/)
- [LiquidJS](https://liquidjs.com/), the template language of the prompt

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately, see [SECURITY.md](SECURITY.md).

## 📄 License

[MIT](LICENSE): fork it, change it, ship it. The packages used have their own licenses; the Claude Agent SDK is
subject to Anthropic's terms of service.
