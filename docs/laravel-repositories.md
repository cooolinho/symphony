# Conventions for Laravel repositories

What a Laravel repository needs so that Symphony agents and [Laravel Boost](https://laravel.com/docs/boost) work well
with it. Symphony only provides the process and the workspace; the rest lives in the repository.

| Kind of knowledge | Where it lives |
|---|---|
| Framework knowledge | Laravel Boost (matches the installed package versions) |
| Project rules | The repository: `AGENTS.md` and `.ai/` |
| Process | Symphony's `WORKFLOW.md` |
| Workspace population | `hooks/laravel-env.sh` |
| Deterministic checks | `checks/laravel.sh`, which calls the repository's composer scripts |

Symphony finds Laravel apps in the repository root or one level deep (for example `laravel/`): a directory with
`artisan` and a `composer.json` requiring `laravel/framework`. The conventions below apply per app.

## Agent instructions

`AGENTS.md` is the single source of agent-neutral project rules (architecture, commands, naming, pitfalls). `CLAUDE.md`
only imports it and adds what is specific to Claude Code:

```markdown
@AGENTS.md

## Claude Code

- Use plan mode for changes touching more than three files.
```

Boost appends its own guideline block to `CLAUDE.md` (or to `AGENTS.md` when the app has no `CLAUDE.md`). Symphony
generates that block in every workspace and keeps it out of commits: new files are excluded through
`.git/info/exclude`, and a tracked file that Boost changed is restored with `git checkout`. Do not commit Boost's
block, and do not edit it by hand; project rules go into the part of `AGENTS.md` you own, or into `.ai/`.

## `.ai/` folders

Boost reads three folders in the repository and merges them with its built-ins when it generates guidelines and
skills:

| Folder | Content | Example |
|---|---|---|
| `.ai/guidelines/` | Always-loaded project guidance, one Markdown file per topic | `.ai/guidelines/tenancy.md` |
| `.ai/skills/<name>/SKILL.md` | Domain knowledge loaded on demand | `.ai/skills/invoicing/SKILL.md` |
| `.ai/rules/` | Short rules and pitfalls, loaded by file path | `.ai/rules/migrations.md` |

A file with the same name as a Boost built-in overrides it, so `.ai/skills/laravel-best-practices/SKILL.md` replaces
Boost's skill of that name. Put project skills in `.ai/skills/`, not `.claude/skills/`: Boost overwrites
`.claude/skills/` when it generates, and `.ai/` also works for other agents.

`.ai/` is committed, including `.ai/rules`. Symphony does not pass `record-rule` to agents by default (see
[Boost](#boost)); rules are added through pull requests like any other change.

## Composer scripts

`checks/laravel.sh` runs the repository's own scripts when they exist. Define them in `composer.json`:

```json
{
  "scripts": {
    "test": ["@php artisan config:clear --ansi", "@php artisan test"],
    "lint": "vendor/bin/pint --test",
    "analyse": "vendor/bin/phpstan analyse --no-progress"
  }
}
```

The script runs these steps in order and stops at the first failure:

1. A clean working tree and everything pushed (the branch needs an upstream).
2. `php -l` on the PHP files changed against the default branch.
3. `composer run-script lint`. Without that script: `vendor/bin/pint --test` on the changed files, if Pint is installed.
4. `composer run-script analyse`. Without that script: `vendor/bin/phpstan analyse --no-progress` when `phpstan.neon`
   or `phpstan.neon.dist` exists.
5. `composer run-script test`. Without that script: `php artisan test`.

Exit code 1 means the code must be fixed (the output goes to the agent); anything else, such as a missing `vendor/` or
`php`, is an environment problem. Enable the script for a column in `WORKFLOW.md`
([`checks`](configuration.md#checks)). An app in a single first-level subdirectory is found automatically;
`SYMPHONY_LARAVEL_APP_PATH` picks the app when a repository holds several.

## `.env.example`

`hooks/laravel-env.sh` builds the workspace's `.env` from `.env.example`, so keep that file complete: every variable
the app reads, with a harmless value and no secrets.

```dotenv
APP_NAME=Portal
APP_ENV=local
APP_KEY=
APP_DEBUG=true

DB_CONNECTION=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=portal
DB_USERNAME=root
DB_PASSWORD=
```

The hook copies the file and sets `APP_ENV=local`, `APP_DEBUG=true`, a fresh `APP_KEY`, `DB_CONNECTION=sqlite`,
`DB_DATABASE=<app>/database/symphony.sqlite`, `CACHE_STORE=file`, `QUEUE_CONNECTION=sync`, `MAIL_MAILER=log` and
`BOOST_BROWSER_LOGS_WATCHER=false`. It comments out `DB_HOST`, `DB_PORT`, `DB_USERNAME` and `DB_PASSWORD`, creates the
SQLite file and keeps `.env` and the file out of commits. A variable that is missing from `.env.example` stays
missing; an existing `.env` is never touched, and without `.env.example` the app gets no `.env`.

The agent therefore never reaches a developer's or a shared database. See
[Recipe: Laravel apps](configuration.md#recipe-laravel-apps) for the hook setup.

## `phpunit.xml`

Laravel's default works as is: tests run on in-memory SQLite.

```xml
<env name="APP_ENV" value="testing"/>
<env name="DB_CONNECTION" value="sqlite"/>
<env name="DB_DATABASE" value=":memory:"/>
```

If your tests need MySQL, do not hard-code `DB_DATABASE` (or the host and credentials) in `phpunit.xml`. Take them from
the environment, so that a workspace never points at a database you did not intend:

```xml
<env name="DB_CONNECTION" value="mysql"/>
<!-- no DB_DATABASE here: the environment provides it -->
```

PHPUnit sets an `<env>` entry only when the variable is not already in the environment, unless it has `force="true"`.
So a variable exported in the agent's environment wins over every non-forced `<env>` entry. Symphony passes nothing
database-related there: `laravel.env` (`APP_ENV=local`) applies only to Symphony's own Composer and `artisan` steps and
the Boost MCP server, and `laravel.agent_env` is empty by default. Setting `APP_ENV` or `DB_*` in `laravel.agent_env`
would override `APP_ENV=testing` and send tests to that database. Use `force="true"` only for values that must never be
overridden.

## Boost

- **Dependency:** `laravel/boost` belongs in `require-dev`:

  ```bash
  composer require laravel/boost --dev
  ```

  Symphony only prepares Boost for apps that require it. `npm run repo-init` → *Laravel Boost* creates an issue that
  adds it to a repository.
- **Generated files are not committed.** Symphony runs `php artisan boost:install --no-interaction --guidelines
  --skills` in each workspace and writes a `boost.json` that names Claude Code. Add the generated paths to
  `.gitignore` so humans do not commit them either: `boost.json`, `.claude/skills/`, `.mcp.json` and Boost's blocks in
  `CLAUDE.md`/`AGENTS.md` (keep the files themselves).
- **A committed `boost.json` means self-managed mode.** Symphony then generates nothing and uses the committed Boost
  files as they are. Commit it only when you want to maintain the generated output yourself.
- **Package skills are installed automatically.** Packages that ship Boost resources
  (`vendor/<vendor>/<name>/resources/boost/skills` or `guidelines`) are added to the `packages` list of `boost.json`.
  Example: `filament/filament` brings the `filament-development` skill. Entries you already have in `packages` stay.
- **Tools:** the agent may use Boost's read-only tools (`application-info`, `browser-logs`, `database-connections`,
  `database-query`, `database-schema`, `get-absolute-url`, `last-error`, `read-log-entries`) and `search-docs`.
  `tinker` and `record-rule` are off by default. To change that, edit the `laravel` section of `WORKFLOW.md`:

  ```yaml
  laravel:
    allow_tinker: false          # true allows tinker (runs arbitrary PHP)
    deny_tools: [record-rule]    # [] allows record-rule, which writes .ai/rules
  ```

  Details: [`laravel`](configuration.md#laravel) and
  [agent-claude.md](agent-claude.md#workspace-extensions-laravel-boost).

## `.mcp.json`

A repository's `.mcp.json` is for humans (your editor and your own Claude Code). Symphony sessions ignore it: with
`claude.strict_mcp_config` (default `true`) only the `tracker` server and the Boost server that Symphony adds are loaded.
Do not rely on a server in `.mcp.json` being available to an agent.

## Repository settings

On GitHub, under *Settings*:

- **Branch protection on the default branch** (`main`): require pull requests and passing status checks, so agent work
  always goes through review.
- **Automatically delete head branches** (*General → Pull Requests*): the `symphony/issue-<n>` branches disappear
  after the merge.
