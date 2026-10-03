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
  # Board columns (GitHub "Kanban" template): Backlog | Ready | In progress | In review | Done
  #   Ready, In progress -> an agent works on the issue
  #   In review          -> handoff: agents move finished or blocked issues here (ends their run)
  #   Done               -> agent stops and its workspace is deleted
  #   Backlog            -> ignored until someone moves the issue to Ready
  # If your board names its columns differently, adjust these lists and the prompt below.
  active_states: [Ready, In progress]
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
  before_run: |
    git fetch --quiet --prune origin

agent:
  max_concurrent_agents: ${SYMPHONY_MAX_CONCURRENT_AGENTS:-2}
  max_turns: ${SYMPHONY_MAX_TURNS:-10}
  # Sessions after the first while the card stays active; then the issue is paused until it
  # changes on the board. Empty = unlimited.
  max_continuations: ${SYMPHONY_MAX_CONTINUATIONS:-}
  max_retry_backoff_ms: 600000

claude:
  model: $CLAUDE_MODEL                       # e.g. opus or sonnet; unset = Claude Code default
  permission_mode: auto                      # a classifier approves safe actions, blocks risky ones
  on_permission_request: deny                # what to answer when it asks: nobody is watching
  allowed_tools:
    - "Bash(git push:*)"                     # pushing the issue branch is part of the workflow
  stall_timeout_ms: 600000
  # max_budget_usd: 5                        # optional cost cap per agent session

server:
  port: $SYMPHONY_PORT                       # dashboard on 127.0.0.1; unset = no dashboard
---
{% capture branch %}{% if issue.branch_name %}{{ issue.branch_name }}{% else %}symphony/issue-{{ issue.native_ref.number }}{% endif %}{% endcapture %}
You are working on GitHub issue **{{ issue.identifier }}**: {{ issue.title }}

- Issue: {{ issue.url }}
- Board status: {{ issue.state }}
{% if issue.labels != empty %}- Labels: {{ issue.labels | join: ", " }}
{% endif %}{% if issue.native_ref.parent %}- Parent issue: {{ issue.native_ref.parent.identifier }} ("{{ issue.native_ref.parent.title }}"). This is a sub-issue: keep the change scoped to it.
{% endif %}{% if issue.native_ref.sub_issues != empty %}- Sub-issues:{% for sub in issue.native_ref.sub_issues %} {{ sub.identifier }} "{{ sub.title }}" ({{ sub.state | downcase }}){% unless forloop.last %},{% endunless %}{% endfor %}. Build on their results instead of redoing them.
{% endif %}{% if issue.blocked_by != empty %}- Depends on:{% for blocker in issue.blocked_by %} {{ blocker.identifier }} ({{ blocker.state | downcase }}){% unless forloop.last %},{% endunless %}{% endfor %}.
{% endif %}{% if attempt %}- Attempt {{ attempt }}: this workspace already holds earlier work on the issue. Check `git status`, `git log --oneline -10` and the issue comments (`mcp__tracker__get_issue`) and continue from there instead of starting over.
{% endif %}
## Issue description

{{ issue.description | default: "(no description)" }}

## How to work

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
