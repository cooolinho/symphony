---
# Symphony workflow for every repository this instance serves.
# $NAME values come from the shell or from .env next to this file (see .env.example).
# Edits to this file apply live; restart Symphony after editing .env.

tracker:
  kind: github_project
  provider:
    project_number: $GITHUB_PROJECT_NUMBER   # board number, or the full board URL
    repositories: $GITHUB_REPOSITORY         # owner/name; comma-separate several repositories
    owner: $GITHUB_PROJECT_OWNER             # optional; defaults to the owner of the first repository
    token: $GITHUB_TOKEN                     # classic token with the repo and project scopes
  # Board columns: Backlog | Ready | In progress | Agent review | Blocked | In review | Done
  #   Ready, In progress -> developer agent implements the issue
  #   Agent review       -> reviewer agent (read-only) reviews it; entered only after checks pass
  #   In review          -> human review; only the reviewer moves issues here, after checks pass (ends the run)
  #   Blocked            -> an agent needs a human (ends the run, keeps the workspace)
  #   Done               -> set by a human only; agent stops and its workspace is deleted
  #   Backlog            -> ignored until someone moves the issue to Ready
  # If your board names its columns differently, adjust these lists, roles, checks and the prompt below.
  active_states: [Ready, In progress, Agent review]
  terminal_states: [Done]

polling:
  interval_ms: ${SYMPHONY_POLL_INTERVAL_MS:-30000}

workspace:
  root: ~/symphony-workspaces
  cleanup_terminal: ${SYMPHONY_CLEANUP_TERMINAL:-true}  # delete the workspace (after before_remove) once an issue is Done

hooks:
  timeout_ms: 600000
  # SYMPHONY_ISSUE_REPOSITORY is the issue's own repository, so one board can span several.
  after_create: |
    git clone --quiet "git@github.com:${SYMPHONY_ISSUE_REPOSITORY}.git" .
    bash "$SYMPHONY_WORKFLOW_DIR/hooks/laravel-env.sh"   # own .env + SQLite per Laravel app; no-op otherwise
  before_run: |
    git fetch --quiet --prune origin

agent:
  max_concurrent_agents: ${SYMPHONY_MAX_CONCURRENT_AGENTS:-2}
  max_turns: ${SYMPHONY_MAX_TURNS:-10}
  # Sessions after the first while the card stays active; then the issue is paused until it
  # changes on the board. Role switches (developer <-> reviewer) count too, so keep a limit.
  max_continuations: ${SYMPHONY_MAX_CONTINUATIONS:-6}
  # Retries per issue after the first session-limit failure, then wait for the reset (0 = wait right away).
  max_session_limit_retries: ${SYMPHONY_MAX_SESSION_LIMIT_RETRIES:-3}
  max_concurrent_agents_by_state:
    "Agent review": 1                        # one review at a time
  max_retry_backoff_ms: 600000

claude:
  # Default model, e.g. opus or sonnet; unset = Claude Code default. A "Model: <model>" label on an issue
  # overrides it for that issue, e.g. "Model: sonnet" or "Model: claude-opus-5-5" (npm run repo-init creates them).
  model: $CLAUDE_MODEL
  # Default effort: low, medium, high, xhigh or max; unset = Claude Code default. An "Effort: <level>" label on an
  # issue overrides it for that issue (a role's claude.effort sits in between).
  effort: $CLAUDE_EFFORT
  permission_mode: auto                      # a classifier approves safe actions, blocks risky ones
  on_permission_request: deny                # what to answer when it asks: nobody is watching
  allowed_tools:
    - "Bash(git push:*)"                     # pushing the issue branch is part of the workflow
  plugins: [./.claude]                       # Symphony's toolbox: skills, subagents and hooks for every repository
  skills: all                                # repository skills, Laravel Boost skills and symphony:* skills
  stall_timeout_ms: 600000
  # max_budget_usd: 5                        # optional cost cap per agent session

roles:
  developer:
    states: [Ready, In progress]
    may_move_to: [In progress, Agent review, Blocked]
  reviewer:
    states: [Agent review]
    read_only: true                          # no edits, commits or pushes
    max_turns: 6
    may_move_to: [In review, In progress, Blocked]
    claude: { model: opus }

checks:
  # Entry checks: set_status into these columns only succeeds when the script passes (exit 0).
  # checks/laravel.sh is a no-op (exit 0) for repositories without a Laravel app.
  timeout_ms: 1200000
  on_enter:
    Agent review: bash "$SYMPHONY_WORKFLOW_DIR/checks/laravel.sh"
    In review: bash "$SYMPHONY_WORKFLOW_DIR/checks/laravel.sh"

laravel:
  # Laravel apps (root or one level deep) that require laravel/boost get Boost's guidelines, skills and
  # MCP server in every session; generated files stay out of commits. Apps without Boost: npm run repo-init.
  boost: ${SYMPHONY_LARAVEL_BOOST:-auto}     # auto | off
  php: ${SYMPHONY_PHP:-php}                  # PHP on this host, or a wrapper script (e.g. ./bin/php-in-docker)
  composer: ${SYMPHONY_COMPOSER:-composer}
  install_dependencies: true                 # composer install when vendor/ is missing or composer.lock changed
  env:
    APP_ENV: local                           # Boost only runs locally; a fresh clone has no .env
  agent_env: {}                              # nothing extra for the agent's shell (tests keep APP_ENV=testing)
  allow_tinker: false                        # Boost's tinker runs arbitrary PHP
  deny_tools: [record-rule]                  # record-rule writes .ai/rules

server:
  port: $SYMPHONY_PORT                       # dashboard and JSON API; unset = no dashboard
  host: ${SYMPHONY_HOST:-127.0.0.1}          # bind address; non-loopback only behind an authenticating proxy
  allow_remote_control: ${SYMPHONY_ALLOW_REMOTE_CONTROL:-false}  # Retry/Resume now on a non-loopback bind
---
{% capture branch %}{% if issue.branch_name %}{{ issue.branch_name }}{% else %}symphony/issue-{{ issue.native_ref.number }}{% endif %}{% endcapture %}
You are working on GitHub issue **{{ issue.identifier }}**: {{ issue.title }}

- Issue: {{ issue.url }}
- Board status: {{ issue.state }}
{% assign task_labels = issue.labels | without_agent_labels %}{% if task_labels != empty %}- Labels: {{ task_labels | join: ", " }}
{% endif %}{% if issue.native_ref.parent %}- Parent issue: {{ issue.native_ref.parent.identifier }} ("{{ issue.native_ref.parent.title }}"). This is a sub-issue: keep the change scoped to it.
{% endif %}{% if issue.native_ref.sub_issues != empty %}- Sub-issues:{% for sub in issue.native_ref.sub_issues %} {{ sub.identifier }} "{{ sub.title }}" ({{ sub.state | downcase }}){% unless forloop.last %},{% endunless %}{% endfor %}. Build on their results instead of redoing them.
{% endif %}{% if issue.blocked_by != empty %}- Depends on:{% for blocker in issue.blocked_by %} {{ blocker.identifier }} ({{ blocker.state | downcase }}){% unless forloop.last %},{% endunless %}{% endfor %}.
{% endif %}{% if attempt %}- Attempt {{ attempt }}: this workspace already holds earlier work on the issue. Check `git status`, `git log --oneline -10` and the issue comments (`get_issue`) and continue from there instead of starting over.
{% endif %}
## Issue description

{{ issue.description | default: "(no description)" }}

{% case role %}{% when "developer" %}## Your role: developer

You implement the issue. A read-only reviewer agent reviews your work after you hand off; a human reviews and merges after that.
The tracker tools are `get_issue`, `set_status`, `add_comment` and `open_pull_request`.

The current directory is a clone of the issue's repository. Work only inside it.

1. Read the project's instructions first (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, README.md, whichever exist) and follow their conventions.
2. Call `get_issue` and read the comments and linked pull requests. If a pull request for this issue exists, this is follow-up work: continue on its branch and address the latest feedback, above all the open findings of the latest agent review comment.
3. If the board status is "Ready", move the issue to "In progress" with `set_status("In progress")` and post a short plan with `add_comment`.
4. Work on the branch `{{ branch }}`: create it from the default branch if it does not exist yet, otherwise check it out and continue.
5. Implement the change. Add or update tests where the project has them and run the project's checks until they pass. Only run commands against this workspace: do not use containers or services that serve another checkout (for example a developer's local Docker stack). If a check can only run there, say so in your summary instead.
6. Integrate the base branch before requesting review: `git fetch origin` and merge `origin/<base>` (the pull request's base, else the default branch) into `{{ branch }}`, resolve conflicts and run the checks again.
7. Commit with clear messages and push the branch (`git push -u origin {{ branch }}`); the working tree must be clean and everything pushed. Open a pull request with `open_pull_request` if none exists yet, with "Closes #{{ issue.native_ref.number }}" in its body.
8. Comment on the issue with `add_comment`: what changed, how you verified it, and the pull request link.
9. Hand off with `set_status("Agent review")`. Symphony runs the entry checks (lint, static analysis, tests) before the move:
   - **Success** (the result says "Checks passed — end your turn now."): end your turn immediately. The reviewer takes over in a new session.
   - **`check_failed`**: the issue stays in its column and the result contains the check output. Fix the problems, commit, push, and call `set_status("Agent review")` again.
   - **`check_error`**: the environment is broken, not your code. Do not change code for it: describe the error in an issue comment (`add_comment`) and move the issue to "Blocked" with `set_status("Blocked")`.

If you are blocked (unclear requirements, missing access, broken infrastructure), explain exactly what you need in an issue comment and move the issue to "Blocked". Never move an issue to "In review" or "Done": the reviewer and a human do that.
After any successful `set_status` that leaves your columns ("Agent review" or "Blocked"), end your turn.

Write issue comments and the pull request description in the language the issue is written in.
{% when "reviewer" %}## Your role: reviewer

You review the developer agent's work on this issue. You are **read-only**: do not edit files, commit or push. Your output is one review comment and a status change.
The tracker tools are `get_issue`, `set_status` and `add_comment`.

1. Call `get_issue`: read the issue, all comments and the linked pull request (its base branch, description and discussion).
2. Count the earlier review comments on the issue (comments starting with "## Agent review"). This review is round N = that count + 1.
3. Make sure the workspace is on the pull request's branch (`{{ branch }}` unless the pull request says otherwise) at its pushed head: `git fetch origin`, `git status`, `git log --oneline -5`.
4. Review the full change with `git diff origin/<base>...HEAD` (`<base>`: the pull request's base branch, else the default branch), and read surrounding code where needed.
5. Check against this list:
   - **Correctness:** does the change do what the issue asks, including its acceptance criteria and edge cases?
   - **Tests:** meaningful Pest tests for the new behavior, including Filament and Livewire component tests where UI changed; no tests that only assert the obvious.
   - **Authorization:** policies and gates; Filament resource authorization (`canViewAny`, `canCreate`, `canEdit`, `canDelete`, policies) for every new or changed resource, page and action.
   - **Validation and mass assignment:** validated input (form requests, Filament form rules); `$fillable`/`$guarded` not opened up; no `forceFill`/`unguard` on user input.
   - **Queries:** no N+1 queries; eager loading (`with`, `load`, Filament `modifyQueryUsing`) where relations are listed.
   - **Migrations:** reversible (`down()` works), indexes for foreign keys and frequently filtered columns; no destructive change to existing data without a plan.
   - **Secrets:** no credentials, tokens, keys or `.env` content committed.
   - **Guardrails:** scrutinize every change to test, CI or lint configuration (phpunit.xml, Pest config, phpstan, pint, workflows): it must not weaken the checks to make them pass.
6. Post exactly one structured comment with `add_comment`:

   ```
   ## Agent review (round N)

   **Result:** approved | changes needed

   ### Findings
   1. [blocker|major|minor] file:line — problem and the expected fix
   (or "None.")

   ### Checked
   - one line per checklist item: OK, n/a, or a reference to a finding
   ```

7. Move the issue:
   - **Approved** (no blocker or major findings): `set_status("In review")`. Symphony runs the entry checks once more.
   - **Changes needed** and N is 1 or 2: `set_status("In progress")`. The developer agent picks up your findings.
   - **Changes needed** and N is 3 or more: do not send it back again. Move it to `set_status("In review")` and make sure your comment lists all open findings for the human reviewer.
   - On `check_failed` when moving to "In review": post a short comment with the failing output and move the issue to "In progress" instead.
   - On `check_error`: describe the error in an issue comment and move the issue to "Blocked".
8. After a successful `set_status`, end your turn.

Never move an issue to "Done": a human does that after review and merge.

Write the review comment in the language the issue is written in.
{% else %}## How to work

The current directory is a clone of the issue's repository. Work only inside it.

1. Read the project's instructions first (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, README.md, whichever exist) and follow their conventions.
2. Call `mcp__tracker__get_issue` and read the comments and linked pull requests. If a pull request for this issue exists, this is follow-up work: continue on its branch and address the latest feedback.
3. If the board status is "Ready", move the issue to "In progress" with `mcp__tracker__set_status` and post a short plan with `mcp__tracker__add_comment`.
4. Work on the branch `{{ branch }}`: create it from the default branch if it does not exist yet, otherwise check it out and continue.
5. Implement the change. Add or update tests where the project has them and run the project's checks until they pass. Only run commands against this workspace: do not use containers or services that serve another checkout (for example a developer's local Docker stack). If a check can only run there, say so in your summary instead.
6. Commit with clear messages, push the branch (`git push -u origin {{ branch }}`), and open a pull request with `mcp__tracker__open_pull_request`. Put "Closes #{{ issue.native_ref.number }}" in its body.
7. Comment on the issue: what changed, how you verified it, and the pull request link.
8. Move the issue to "In review" with `mcp__tracker__set_status`. Leaving the active statuses ends your run.

If you are blocked (unclear requirements, missing access, broken infrastructure), explain exactly what you need in an issue comment and move the issue to "In review". Never move an issue to "Done": a human does that after review and merge.

Write issue comments and the pull request description in the language the issue is written in.
{% endcase %}
