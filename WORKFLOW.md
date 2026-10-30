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
    sub_issue_status: Backlog                # column for sub-issues made by create_sub_issue; must not be an active or terminal state
    # Branch agents branch from and open pull requests against; unset = the repository's default branch.
    # Set it (e.g. develop) to keep the default branch for releases a human merges.
    base_branch: ${SYMPHONY_BASE_BRANCH:-}
    auto_merge:
      # true: when the reviewer moves an issue to on_enter (entry checks passed), Symphony merges its pull request into
      # base_branch, closes the issue and moves it to done_state. Needs base_branch; never merges into the default branch.
      # A pull request or issue labelled "manual-merge" stays for a human.
      # Merge gate: only merges when every check of the pull request's head passed (GitHub Actions and commit statuses
      # such as symphony/ci). Failing checks go back to the developer, pending ones wait (label "awaiting-checks"), and
      # jobs GitHub never started (Actions minutes used up) leave the issue for a human.
      enabled: ${SYMPHONY_AUTO_MERGE:-false}
      on_enter: In review
      done_state: Done
      on_conflict: In progress               # a pull request that conflicts with base_branch goes back to the developer
      on_checks_failed: In progress          # a pull request whose checks fail goes back to the developer
      method: squash
      checks:
        wait: ${SYMPHONY_MERGE_WAIT_FOR_CHECKS:-true}            # wait for pending checks, retried every poll
        timeout_ms: ${SYMPHONY_MERGE_CHECKS_TIMEOUT_MS:-3600000}  # then a human takes over
        ignore: ${SYMPHONY_MERGE_IGNORE_CHECKS:-}                # check names or "owner/repo:name" globs, comma-separated
        max_send_backs: 2                    # send-backs for failing checks per issue; then needs-human
  # Board columns: Backlog | Ready | Design | In progress | Testing | Documentation | Agent review | Security review | Blocked | In review | Done
  #   Ready              -> issue analyst (read-only) works out requirements, risks, refined acceptance criteria, type and
  #                         complexity before anything is implemented; later stages get the analysis in their prompt
  #                         (pipeline.analysis: when_unlabeled skips it for issues that already carry Type and Complexity labels)
  #   Design             -> architect agent (read-only) decides on the approach before the implementation: the options, the
  #                         chosen one, its components and interfaces; the developer gets the design in its prompt. Only for
  #                         larger changes: pipeline.profiles skip_when skips the column without a session for small issues
  #                         (feature and refactor except complexity S, bugfix only for L and XL; an issue without a Complexity
  #                         label does not skip it). The board needs the column between Ready and In progress.
  #                         An XL issue whose design falls into separate work packages is split instead: one sub-issue per
  #                         package (in Ready, each with its own pipeline, workspace, branch and pull request), and the
  #                         issue waits in Agent review until all of them are closed (roles.architect below).
  #   In progress        -> developer agent implements the issue
  #   Testing            -> test engineer agent writes independent tests for the acceptance criteria; it may only change test
  #                         files (pipeline.test_paths). Bug, feature and refactor issues (pipeline.profiles) always go through it; other
  #                         issues only with SYMPHONY_AFTER_IMPLEMENTATION=Testing (docs/configuration.md#the-test-engineer). The board
  #                         needs the column either way, between In progress and Agent review: `next` and the pipeline view
  #                         use its order.
  #   Documentation      -> docs agent (haiku) updates the documentation, and may only change files matching pipeline.docs_paths.
  #                         Entered only when the hand-off from the developer (or test engineer) needs it: `docs_needed` in the
  #                         analysis, or a changed file matching pipeline.docs_trigger_paths (.env.example, config/**, WORKFLOW.md)
  #                         while no file in pipeline.docs_paths changed; every other hand-off goes straight to Agent review
  #                         without a session. The board needs the column between Testing and Agent review
  #                         (docs/configuration.md#the-documentation-stage), so the reviewer checks the docs too.
  #   Agent review       -> reviewer agent (read-only) reviews it; entered only after checks pass. An issue split into work
  #                         packages gets an integration review instead: the merged packages on the base branch, once all
  #                         of its sub-issues are closed
  #   Security review    -> security auditor (read-only) audits the diff for authorization, injection, mass assignment and
  #                         secrets. Entered only when the reviewer approved AND the change is security-relevant: a `security`
  #                         label, `risks.security` in the analysis, or a changed file matching pipeline.security_paths;
  #                         every other approval goes straight to In review without a session. The board needs the column
  #                         between Agent review and In review (docs/configuration.md#the-security-auditor).
  #   In review          -> human review; only the reviewer moves issues here, after checks pass (ends the run)
  #   Blocked            -> an agent needs a human (ends the run, keeps the workspace)
  #   Done               -> set by a human only; agent stops and its workspace is deleted
  #   Backlog            -> ignored until someone moves the issue to Ready; also where sub-issues made by the auditor land
  #   An issue whose description starts with "/refactoring" is served by the auditor instead of the developer
  #   (roles.auditor.commands): it analyses read-only and files sub-issues. Skills in .claude/skills/ define the commands.
  #   An issue whose description starts with "/auto-code" is served by the autopilot: it plans waves of sub-issues that
  #   start in Ready right away, stays in "In progress" and runs again once all sub-issues of the wave are closed.
  #   An issue whose description starts with "/concept <file.md>" is served by the analyst: it turns the concept into
  #   epics and sub-issues (with "blocked by", Model and Effort labels) in Backlog; a human moves them to Ready.
  #   An issue whose description starts with "/plan [file]" is served by the planner: every item of the list (the file,
  #   or the description below the command line) becomes one planned sub-issue in Backlog; a human moves them to Ready.
  # If your board names its columns differently, adjust these lists, roles, checks, the prompt below and the role
  # prompts it includes from roles/<role>.md.
  active_states: [Ready, Design, In progress, Testing, Documentation, Agent review, Security review]
  terminal_states: [Done]

polling:
  interval_ms: ${SYMPHONY_POLL_INTERVAL_MS:-30000}

workspace:
  root: ~/symphony-workspaces
  cleanup_terminal: ${SYMPHONY_CLEANUP_TERMINAL:-true}  # delete the workspace (after before_remove) once an issue is Done

hooks:
  timeout_ms: 600000
  # SYMPHONY_ISSUE_REPOSITORY is the issue's own repository, so one board can span several.
  # SYMPHONY_BASE_BRANCH is tracker.provider.base_branch (unset: clone the default branch).
  after_create: |
    set -e                                               # only the last line's exit code counts: a failed clone must fail the hook
    git clone --quiet ${SYMPHONY_BASE_BRANCH:+--branch "$SYMPHONY_BASE_BRANCH"} "git@github.com:${SYMPHONY_ISSUE_REPOSITORY}.git" .
    bash "$SYMPHONY_WORKFLOW_DIR/hooks/laravel-env.sh"   # own .env + SQLite per Laravel app; no-op otherwise
  # A workspace still on the base branch (no issue branch yet: the analysis, the design, the integration review of an
  # issue split into work packages, a developer hand-off without an issue branch such as a spike) follows origin/<base>, so the
  # session and its entry checks see what was merged since. The path rule of the test and docs roles knows this: a session that
  # starts on origin/<base> is not blamed for the pull requests merged between the hand-off and its start.
  before_run: |
    set -e                                               # a failed fetch must fail the hook (the attempt is retried), not run on stale refs
    git fetch --quiet --prune origin
    base="${SYMPHONY_BASE_BRANCH:-$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null | sed 's|^origin/||')}"
    if [ -n "$base" ] && [ "$(git branch --show-current)" = "$base" ]; then git merge --quiet --ff-only "origin/$base" || true; fi
  # Drops the workspace's MySQL databases (SYMPHONY_LARAVEL_DB=mysql, the CI database of checks/laravel.sh --full);
  # a no-op without SYMPHONY_MYSQL_USER. A failure is logged, the workspace is removed anyway.
  before_remove: |
    bash "$SYMPHONY_WORKFLOW_DIR/hooks/laravel-db-drop.sh"

agent:
  max_concurrent_agents: ${SYMPHONY_MAX_CONCURRENT_AGENTS:-3}
  max_turns: ${SYMPHONY_MAX_TURNS:-10}
  # Sessions after the first while the card stays active; then the issue is paused until it
  # changes on the board. Role switches (developer <-> reviewer) count too, so keep a limit; a stage that
  # handed off with a result (report_result) resets the count, its loops are bounded by the round limits.
  max_continuations: ${SYMPHONY_MAX_CONTINUATIONS:-6}
  # Retries per issue after the first session-limit failure, then wait for the reset (0 = wait right away).
  max_session_limit_retries: ${SYMPHONY_MAX_SESSION_LIMIT_RETRIES:-3}
  # A model limit ("You've reached your Fable limit") holds only that model: until the reset + 60 s, else this long.
  # model_hold_ms: 3600000
  max_concurrent_agents_by_state:
    "Agent review": 2                        # two reviews at a time: an approval runs the In review checks (up to 50 min) in its session
    "Security review": 1                     # one security audit at a time
    Documentation: 1                         # one docs run at a time
    Testing: 1                               # one test run at a time (bug, feature and refactor issues; every issue with SYMPHONY_AFTER_IMPLEMENTATION=Testing)
  # Slots kept free for a role, so a developer and a reviewer can always run side by side. Other roles (/plan,
  # /refactoring, the issue analyst, the test engineer, ...) only get slots beyond these: with 2 slots in total they wait
  # until the limit is raised. The issue analyst serves every issue in Ready, so allow 3 slots, or no issue ever starts. The
  # test engineer of the bugfix, feature and refactor profiles needs a slot beyond these as well: with 3 it shares the one free slot with the
  # analyst, with 4 both can run at once (the dashboard and log say when a stage never starts).
  reserved_slots_by_role:
    developer: 1
    reviewer: 1
  max_retry_backoff_ms: 600000

claude:
  # Default model, e.g. fable, opus or sonnet; unset = Claude Code default. Roles with their own model use theirs (below:
  # the developer uses this one up to complexity M). A "Model: <model>" label on an issue overrides it for that issue,
  # e.g. "Model: sonnet" or "Model: claude-opus-5-5" (npm run repo-init creates them), in the roles that apply it.
  model: $CLAUDE_MODEL
  # Default effort: low, medium, high, xhigh or max; unset = Claude Code default. An "Effort: <level>" label on an
  # issue overrides it for that issue (a role's claude.effort sits in between), in the roles that apply it.
  effort: $CLAUDE_EFFORT
  permission_mode: auto                      # a classifier approves safe actions, blocks risky ones
  on_permission_request: deny                # what to answer when it asks: nobody is watching
  allowed_tools:
    - "Bash(git push:*)"                     # pushing the issue branch is part of the workflow
  by_model:                                  # permission overrides per model (a "Model: …" label or a role picks the model)
    haiku:                                   # Haiku has no auto mode: Claude Code falls back to "default" and the
      permission_mode: acceptEdits           # run would deny every Bash and Write call, so edits are accepted and
      allowed_tools: [Bash, Read, Write, Edit]  # these tools run without asking (read-only roles still deny edits)
  plugins: [./.claude]                       # Symphony's toolbox: skills, subagents and hooks for every repository
  skills: all                                # repository skills, Laravel Boost skills and symphony:* skills
  stall_timeout_ms: 600000
  # max_budget_usd: 5                        # optional cost cap per agent session

roles:
  # agents: plugin subagents (.claude/agents) the role may start; unset = all. Read-only roles only get read-only
  # ones, and laravel-* subagents only exist in workspaces with a Laravel app.
  # brain: which brain tools the role gets (off = none, read = search/read/list, write = also write/append); only with
  # brain.enabled; unset = off.
  # Models and effort follow "plan strong, implement cheaper": the architect designs larger changes with the strongest
  # model, the developer implements the design with a cheaper one, and the roles with a fixed task (analysis, tests,
  # docs, review, security) run with a fixed model and effort. model_by_complexity picks the model by the issue's
  # Complexity: label; model_label / effort_label: ignore keep a "Model: …" / "Effort: …" label on the issue from
  # changing a role. Labels then steer the developer (and the issue commands) only, e.g. "Model: fable" to escalate an
  # issue the developer failed on.
  # developer and reviewer hand off with report_result (docs/results.md): the verdict decides the next column, not the
  # agent. The targets of on_result are allowed moves on their own; they are listed in may_move_to for the board preflight.
  # The issue analyst runs before the developer, for every issue that enters Ready: a short read-only session that reports
  # an `analysis` result. `ready` moves the issue on (to In progress); `needs_info` sends it to Blocked with the open
  # questions in the comment. Symphony also sets the issue's Type: and Complexity: labels from the analysis where it has
  # none (a label a human set always wins). `ready` leads to the next stage of the issue's profile: Design for larger
  # changes, else In progress.
  issue-analyst:
    states: [Ready]
    read_only: true
    max_turns: 3
    result: analysis
    on_result: { ready: next, needs_info: Blocked }
    may_move_to: [Design, In progress, Blocked]
    model_label: ignore                      # sonnet, whatever the issue's Model: label picks for the developer
    effort_label: ignore                     # medium, whatever the issue's Effort: label says
    agents: [laravel-architect]
    brain: write
    claude: { model: sonnet, effort: medium }
  # The architect decides on the approach of larger changes before the developer starts: a short read-only session that
  # reports a `design` result. `ready` (decision, components and interfaces are required) moves the issue to In progress,
  # where the developer gets the design in its prompt; `blocked` sends it to Blocked. Small issues never reach it:
  # pipeline.profiles.<type>.skip_when passes Design over without a session.
  # `split` is only for an issue of complexity XL that is not itself a sub-issue, with at least two work packages: the
  # architect files one sub-issue per package (in Ready, so each runs its own pipeline right away) and the issue goes to
  # Agent review, where it waits until every sub-issue is closed. The reviewer then checks the integrated base branch
  # against the issue's acceptance criteria, and the security auditor audits the merged packages when the issue needs it
  # (docs/usage.md#work-packages-for-very-large-changes). On any other issue, a work package included, the architect does
  # not get create_sub_issue, whatever max_sub_issues says.
  architect:
    states: [Design]
    read_only: true
    run_checks: false                                          # nothing changes: no entry check before Agent review for a split issue
    max_sub_issues: ${SYMPHONY_ARCHITECT_MAX_SUB_ISSUES:-5}    # work packages of one issue; grants create_sub_issue on an XL issue that is no sub-issue
    sub_issue_status: Ready                                    # the packages start without a human
    max_turns: 4
    result: design
    on_result: { ready: In progress, split: Agent review, blocked: Blocked }
    may_move_to: [In progress, Agent review, Blocked]
    model_label: ignore                      # opus, fable at complexity L and XL, whatever the issue's Model: label picks
    agents: [laravel-architect]
    brain: write
    claude: { model: opus, effort: high, model_by_complexity: { L: fable, XL: fable } }   # a short session: thinking pays off here
  developer:
    states: [In progress]
    result: implementation
    on_result:
      done: ${SYMPHONY_AFTER_IMPLEMENTATION:-Agent review}   # Agent review, or Testing to run the test engineer first (bug, feature and refactor issues: pipeline.profiles)
      blocked: Blocked
    may_move_to: [In progress, Testing, Documentation, Agent review, Blocked]
    agents: [laravel-architect, laravel-database-engineer, laravel-filament-developer, laravel-test-engineer, laravel-code-reviewer]
    brain: read
    # claude.model (CLAUDE_MODEL), opus at complexity L and XL, which implement the architect's design; a Model: label
    # on the issue wins, and an Effort: label sets the effort.
    claude: { model_by_complexity: { L: opus, XL: opus } }
  # The test engineer is independent of the developer: it writes and runs tests for every acceptance criterion and may only
  # change files matching pipeline.test_paths (report_result refuses the result with invalid_result otherwise). `failed`
  # sends the issue back to the developer with the failed cases in the prompt; max_test_rounds failed rounds go to Blocked
  # with the needs-human label.
  test-engineer:
    states: [Testing]
    result: test
    on_result: { passed: Agent review, failed: In progress, blocked: Blocked }   # passed: Symphony goes to Documentation first when the change needs it
    may_move_to: [Documentation, Agent review, In progress, Blocked]
    model_label: ignore                      # sonnet, whatever the issue's Model: label picks for the developer
    effort_label: ignore                     # high, whatever the issue's Effort: label says
    agents: [laravel-test-engineer]
    brain: read
    claude: { model: sonnet, effort: high }
  # The docs agent is conditional: Symphony sends a finished implementation (or passed tests) here only when it needs
  # documentation (`docs_needed` in the analysis, or a changed file matching pipeline.docs_trigger_paths without any change in
  # pipeline.docs_paths; when the changed files cannot be determined, it is needed to be safe). Otherwise the hand-off goes
  # straight to Agent review and no session runs. It may only change files matching pipeline.docs_paths (report_result refuses
  # the result with invalid_result otherwise). A profile that lists docs in `skip` never runs it. To remove the stage, delete
  # this role, the column from active_states and Documentation from the may_move_to of developer and test-engineer.
  docs:
    states: [Documentation]
    result: docs
    on_result: { done: Agent review, not_needed: Agent review, blocked: Blocked }
    may_move_to: [Agent review, Blocked]
    model_label: ignore                      # haiku, whatever the issue's Model: label picks for the developer
    effort_label: ignore                     # medium, whatever the issue's Effort: label says
    claude: { model: haiku, effort: medium }
  reviewer:
    states: [Agent review]
    read_only: true                          # no edits, commits or pushes
    max_turns: 6
    result: review
    # For an issue split into work packages (integration review), changes_needed hands the findings to the issue's own
    # developer, who fixes them on the issue's branch with its own pull request; its next review is a normal one.
    on_result: { approved: In review, changes_needed: In progress, blocked: Blocked }   # approved: Symphony goes to Security review first when the change needs it
    on_check_failed: In progress             # the entry check of In review failed: back to the developer, with the output
    may_move_to: [Security review, In review, In progress, Blocked]
    model_label: ignore                      # opus, whatever the issue's Model: label picks for the developer
    effort_label: ignore                     # high, whatever the issue's Effort: label says: the review keeps a cheaper developer safe
    agents: [laravel-code-reviewer]
    brain: write
    claude: { model: opus, effort: high }
  # The security auditor is conditional: Symphony sends an approved issue here only when it needs the audit (a `security`
  # label, `risks.security` in the analysis, or a changed file matching pipeline.security_paths; when the changed files
  # cannot be determined, it is needed to be safe). Otherwise the reviewer's approval goes straight to In review and no
  # session runs. `passed` moves the issue to In review; `issues_found` sends it back to the developer with the findings
  # in the prompt (the reviewer then reviews the fix, and the security check is evaluated again); max_security_rounds
  # rounds with issues go to Blocked with the needs-human label. A profile that lists security-auditor in `skip` never
  # runs it. To remove the stage, delete this role, the column from active_states and Security review from
  # roles.reviewer.may_move_to. After the integration review of an issue split into work packages, the files the packages
  # changed since the design count, and the auditor audits the merged packages on the base branch (integration mode).
  security-auditor:
    states: [Security review]
    read_only: true                          # no edits, commits or pushes
    max_turns: 6
    result: security
    on_result: { passed: In review, issues_found: In progress, blocked: Blocked }
    on_check_failed: In progress             # the entry check of In review failed: back to the developer, with the output
    may_move_to: [In review, In progress, Blocked]
    model_label: ignore                      # opus, whatever the issue's Model: label picks for the developer
    effort_label: ignore                     # high, whatever the issue's Effort: label says
    agents: [laravel-code-reviewer]
    brain: read
    claude: { model: opus, effort: high }
  auditor:
    commands: [refactoring]                                 # served only for issues whose description starts with /refactoring
    states: [Ready, In progress]
    read_only: true                                         # analysis only; the findings become sub-issues
    run_checks: false                                       # nothing changes, so a red test suite must not block the hand-off
    max_sub_issues: ${SYMPHONY_AUDITOR_MAX_SUB_ISSUES:-20}  # open sub-issues at once; also what grants the create_sub_issue tool
    max_turns: 2
    may_move_to: [In progress, In review, Blocked]
    agents: [laravel-architect, laravel-code-reviewer]
    claude: { model: fable, max_budget_usd: 15 }
  autopilot:
    commands: [auto-code]                                   # served only for issues whose description starts with /auto-code
    states: [Ready, In progress]
    read_only: true                                         # plans only; the developer and reviewer implement the sub-issues
    run_checks: false
    max_sub_issues: ${SYMPHONY_AUTOPILOT_MAX_SUB_ISSUES:-5} # open sub-issues at once, i.e. the largest wave
    sub_issue_status: Ready                                 # wave issues start without a human (opt-in; the default column is Backlog)
    wait_for_sub_issues: true                               # the epic runs again only once all sub-issues of its wave are closed
    max_turns: 2
    may_move_to: [In progress, In review, Blocked]
    agents: [laravel-architect]
    claude: { model: fable, max_budget_usd: 10 }
  analyst:
    commands: [concept]                                     # served only for issues whose description starts with /concept
    states: [Ready, In progress]
    read_only: true                                         # analysis only; the concept becomes epics and sub-issues
    run_checks: false
    max_sub_issues: ${SYMPHONY_ANALYST_MAX_SUB_ISSUES:-60}  # open epics and sub-issues under the concept issue at once (the whole tree)
    max_turns: 3
    may_move_to: [In progress, In review, Blocked]
    agents: [laravel-architect]
    claude: { model: fable, effort: high, max_budget_usd: 20 }
  planner:
    commands: [plan]                                        # served only for issues whose description starts with /plan
    states: [Ready, In progress]
    read_only: true                                         # plans only; every list item becomes a sub-issue in Backlog
    run_checks: false
    max_sub_issues: ${SYMPHONY_PLANNER_MAX_SUB_ISSUES:-30}  # open sub-issues under the plan issue at once
    max_turns: 3
    may_move_to: [In progress, In review, Blocked]
    agents: [laravel-architect]
    claude: { model: fable, effort: high, max_budget_usd: 20 }

pipeline:
  # A third review with changes_needed does not go back to the developer: the issue moves to Blocked with the
  # needs-human label (roles.reviewer.on_round_limit changes the column). A human moving it back resets the rounds.
  max_review_rounds: 3
  # Test rounds (test failed -> developer fixes) before the issue goes to Blocked with needs-human.
  max_test_rounds: 2
  # Security rounds (security review found issues -> developer fixes) before the issue goes to Blocked with needs-human.
  max_security_rounds: 2
  # Hand-offs back to the developer over on_check_failed (a failed entry check, e.g. In review) per issue; the one that
  # reaches the limit goes to on_round_limit (else Blocked) with needs-human. A reset result starts the count again.
  max_check_failures: 3
  # always: the issue analyst runs for every issue in Ready. when_unlabeled: it is skipped without a session for issues that
  # already carry a Type: and a Complexity: label (they go straight to In progress).
  analysis: always
  # Stage sequences per issue type (docs/configuration.md#workflow-profiles); the type comes from the Type: label or the
  # analysis. The roles stay the same, a profile only overrides transitions. A bug issue runs Ready (analyst) -> In progress
  # (developer, regression test first) -> Testing (test engineer) -> Agent review -> In review. Only a bug of complexity L
  # or XL goes through Design (architect) first; for S and M the architect is skipped without a session.
  # A feature runs the full chain: Ready (analyst) -> Design (architect) -> In progress (developer, a test per acceptance
  # criterion) -> Testing (test engineer) -> Agent review -> In review. A refactoring runs the same chain, behaviour-preserving:
  # the developer loads symphony:refactor-safely and commits characterization tests first, the test engineer checks them
  # against the base commit, and the reviewer checks the public interfaces and confirms each refactoring goal of the analysis
  # (an approval without confirmed_goals is refused). Both skip Design at complexity S.
  # Needs the Testing column on the board. To run these issues without the test stage, set developer.done to Agent review here.
  # skip_when skips a stage only for some issues: the vocabulary is fixed, `complexity` is a list of S, M, L, XL. Features
  # and refactorings go through Design except at complexity S. An issue without a usable Complexity: label never matches,
  # so the architect runs. `default` applies to untyped issues, which go from the developer to Agent review
  # (docs/configuration.md#workflow-profiles).
  profiles:
    bugfix:
      skip_when:
        architect: { complexity: [S, M] }
      on_result:
        developer: { done: Testing }
    feature:
      skip_when:
        architect: { complexity: [S] }
      on_result:
        developer: { done: Testing }
    refactor:
      skip_when:
        architect: { complexity: [S] }
      on_result:
        developer: { done: Testing }
    default:
      skip_when:
        architect: { complexity: [S] }
  # Files the test engineer may change; defaults: tests/**, test/**, **/*.test.*, **/*Test.php
  # test_paths: [tests/**, test/**, "**/*.test.*", "**/*Test.php"]
  # Files the docs agent may change; defaults: docs/**, README*.md, CHANGELOG*.md
  # docs_paths: [docs/**, "README*.md", "CHANGELOG*.md"]
  # Changed files that send a finished implementation to the Documentation stage when no file in docs_paths changed (any match
  # is enough; the analysis' docs_needed does too); [] turns the path trigger off. Defaults: .env.example, config/**, WORKFLOW.md
  # docs_trigger_paths: [.env.example, "config/**", WORKFLOW.md]
  # Changed files that send an approved issue to the Security review (any match is enough); an explicit list replaces the
  # Laravel defaults below, [] turns the path trigger off (the security label and the analysis risk still apply).
  # security_paths: [app/Policies/**, app/Http/Middleware/**, config/auth.php, routes/**, database/migrations/**]

checks:
  # Entry checks: set_status into these columns only succeeds when the script passes (exit 0).
  # checks/laravel.sh is a no-op (exit 0) for repositories without a Laravel app.
  # A check that runs longer fails with check_timeout: the issue stays in its column (never Blocked).
  # Must stay below claude.turn_timeout_ms (default 3600000), like the sum of a column's named checks.
  timeout_ms: ${SYMPHONY_CHECKS_TIMEOUT_MS:-1800000}
  # true: named checks become commit statuses symphony/<name> on the checked commit (GitHub), which the auto_merge gate
  # and branch rules read. server.public_url links them to the agent page.
  report_status: ${SYMPHONY_CHECKS_REPORT_STATUS:-false}
  on_enter:
    Testing: bash "$SYMPHONY_WORKFLOW_DIR/checks/laravel.sh"       # only reached with the Testing stage on: the developer hands over green code
    Agent review: bash "$SYMPHONY_WORKFLOW_DIR/checks/laravel.sh"
    # The final gate before auto_merge: the repository's own CI, standing in for GitHub Actions.
    # ci: .symphony/checks/ci.sh of the base branch, else checks/laravel.sh --full (skipped without a Laravel app).
    # prod-smoke: .symphony/checks/prod-smoke.sh of the base branch, one run per repository at a time; skipped without
    # one. Both get the Docker daemon and MySQL of the compose profile "ci" (docs/docker.md) when it runs.
    In review:
      - name: ci
        command: bash "$SYMPHONY_WORKFLOW_DIR/checks/repo.sh" ci -- bash "$SYMPHONY_WORKFLOW_DIR/checks/laravel.sh" --full
        timeout_ms: ${SYMPHONY_CI_TIMEOUT_MS:-1200000}
      - name: prod-smoke
        command: bash "$SYMPHONY_WORKFLOW_DIR/checks/repo.sh" --lock prod-smoke
        timeout_ms: ${SYMPHONY_SMOKE_TIMEOUT_MS:-1800000}

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
  public_url: ${SYMPHONY_PUBLIC_URL:-}       # the dashboard as people reach it (https://symphony.example.com); links in commit statuses

# brain:                                     # knowledge vault: one vault for all repositories, created at startup
#   enabled: false                           # true = create the vault; false = no path is touched
#   path: ~/brain                            # /home/symphony/brain is the brain volume in Docker
# Only roles with brain: read or write get the brain tools (see roles:).
# Existing files and folders are never overwritten; .obsidian/ is never touched. Changes apply after a restart.
---
{% capture branch %}{% if issue.branch_name %}{{ issue.branch_name }}{% else %}symphony/issue-{{ issue.native_ref.number }}{% endif %}{% endcapture %}{% assign base = issue.native_ref.base_branch %}{% assign splittable = false %}{% if issue.complexity == "XL" and issue.native_ref.parent == nil %}{% assign splittable = true %}{% endif %}{% assign integration = false %}{% if issue.native_ref.sub_issues.size > 0 and results.implementation == nil %}{% assign integration = true %}{% endif %}{% capture agent_list %}{% for agent in agents %}
- `{{ agent.name }}`: {{ agent.description }}{% endfor %}{% endcapture %}{% capture agent_intro %}Subagents you may start with the Agent tool (`subagent_type` is the name). They are optional: each one works in its own context and costs tokens, so use them where they pay off. You stay responsible for their results; check them before you rely on them.{{ agent_list }}{% endcapture %}{% capture analysis_block %}{% if results.analysis %}
## Analysis of the issue analyst

A read-only analyst examined the issue before the implementation{% if results.analysis.type or results.analysis.complexity %} (type: {{ results.analysis.type | default: "n/a" }}, complexity: {{ results.analysis.complexity | default: "n/a" }}){% endif %}. Use it as input, but check it against the code: where it contradicts the issue description, the issue wins and you say so.

{{ results.analysis.summary }}
{% if results.analysis.components.size > 0 %}
Affected components:{% for item in results.analysis.components %}
- `{{ item }}`{% endfor %}
{% endif %}{% if results.analysis.acceptance_criteria.size > 0 %}
Refined acceptance criteria:{% for item in results.analysis.acceptance_criteria %}
- [ ] {{ item }}{% endfor %}
{% endif %}{% if results.analysis.risks.size > 0 %}
Risks: {{ results.analysis.risks | join: ", " }}.
{% endif %}{% if results.analysis.refactoring_goals.size > 0 %}
Refactoring goals (the review confirms each one):{% for item in results.analysis.refactoring_goals %}
- {{ item }}{% endfor %}
{% endif %}{% if results.analysis.docs_needed %}
Documentation needs an update.
{% endif %}{% if results.analysis.plan.size > 0 %}
Plan:{% for item in results.analysis.plan %}
{{ forloop.index }}. {{ item }}{% endfor %}
{% endif %}
{% endif %}{% endcapture %}{% capture design_block %}{% if results.design %}
## Design of the architect

{% if results.design.verdict == "split" %}An architect split this issue into work packages: the sub-issues listed above implemented them, each with its own pull request, merged into the base branch. {% if role == "reviewer" %}This pull request fixes what the integration review (or the security audit of the merged packages) found still missing or broken across the packages: check it against those findings and this issue's acceptance criteria, and do not review the merged packages again.{% else %}The open findings below, of the integration review or of the security audit of the merged packages, are what is still missing or broken across the packages: fix only those, on this issue's own branch with its own pull request, and do not redo the packages. Where the design does not fit the merged code, the code wins, and you say so in the `plan_deviations` of your result.{% endif %}{% else %}An architect decided on the approach before the implementation{% if results.design.verdict != "ready" %} (verdict: {{ results.design.verdict }}){% endif %}. {% if role == "reviewer" %}Check the change against this design; where the developer deviated from it, the deviation must be justified in the `plan_deviations` of the developer's result.{% else %}Implement this design; where it contradicts the issue description or does not fit the code, the issue and the code win, and you say so in the `plan_deviations` of your result.{% endif %}{% endif %}

{{ results.design.summary }}
{% if results.design.decision %}
Decision: {{ results.design.decision }}
{% endif %}{% if results.design.components.size > 0 %}
Components:{% for item in results.design.components %}
- {{ item }}{% endfor %}
{% endif %}{% if results.design.interfaces.size > 0 %}
Interfaces:{% for item in results.design.interfaces %}
- {{ item }}{% endfor %}
{% endif %}{% if results.design.migrations.size > 0 %}
Migrations:{% for item in results.design.migrations %}
- {{ item }}{% endfor %}
{% endif %}{% if results.design.compatibility %}
Compatibility: {{ results.design.compatibility }}
{% endif %}{% if results.design.plan.size > 0 %}
Plan:{% for item in results.design.plan %}
{{ forloop.index }}. {{ item }}{% endfor %}
{% endif %}{% if results.design.tests.size > 0 %}
Tests (one per acceptance criterion):{% for item in results.design.tests %}
- {{ item }}{% endfor %}
{% endif %}{% if results.design.options.size > 0 %}
Options considered:{% for item in results.design.options %}
- {{ item }}{% endfor %}
{% endif %}{% if results.design.work_packages.size > 0 %}
Work packages:{% for item in results.design.work_packages %}
{{ forloop.index }}. {{ item }}{% endfor %}
{% endif %}
{% endif %}{% endcapture %}{% capture packages_block %}
## Work packages

{% for sub in issue.native_ref.sub_issues %}- {{ sub.identifier }} "{{ sub.title }}": {{ sub.state | downcase }}{% if sub.state_reason %} as {{ sub.state_reason | downcase | replace: "_", " " }}{% endif %}
{% endfor %}{% if results.design %}
The architect's design{% if results.design.head_sha %}, made at commit `{{ results.design.head_sha | slice: 0, 12 }}`{% endif %}: {{ results.design.summary }}
{% if results.design.work_packages.size > 0 %}
Planned packages:{% for item in results.design.work_packages %}
{{ forloop.index }}. {{ item }}{% endfor %}
{% endif %}{% if results.design.interfaces.size > 0 %}
Interfaces between them:{% for item in results.design.interfaces %}
- {{ item }}{% endfor %}
{% endif %}{% endif %}{% endcapture %}{% capture packages_range %}{% if results.design and results.design.head_sha %}{{ results.design.head_sha }}{% else %}<the commit before the first package>{% endif %}..origin/<base>{% endcapture %}{% capture screenshots_block %}UI screenshots. When the project's instructions or the issue ask for screenshots of UI changes, take them before you commit; the workspace has a headless Chromium. "No browser" and "no frontend build" are not reasons to skip them. `report_result` refuses a change to UI files (`pipeline.ui_paths`) without a changed screenshot (`pipeline.screenshot_paths`) when the project asks for screenshots, unless you name the failed step in `screenshots_problem`.
   - The browser is Playwright's Chromium headless shell under `$PLAYWRIGHT_BROWSERS_PATH` (`/opt/ms-playwright`). It is not on the `PATH`, so `which chromium` and `~/.cache/ms-playwright` find nothing; check it with `symphony-screenshot --check`.
   - A fresh workspace has no `node_modules` and no `public/build`; that is expected, not a blocker. If the app uses Vite (`vite.config.*`, `@vite`, `->viteTheme(`) and `public/build/manifest.json` is missing, install the dependencies and run the project's `build` script before you serve it (package manager: see below). Do not commit lockfiles or build output the repository does not track; check `git status` before you commit.
   - Serve the app from this workspace only, on a free local port, with its own SQLite file and seed data; never a stack that serves another checkout. For a Laravel app: from its `public/` directory, `DB_CONNECTION=sqlite DB_DATABASE=/tmp/<name>.sqlite APP_URL=http://127.0.0.1:<port> php -S 127.0.0.1:<port> ../vendor/laravel/framework/src/Illuminate/Foundation/resources/server.php` after `php artisan migrate --seed` against that file (real environment variables override `.env`). Build the frontend assets first if the project needs them (see above), with the project's package manager: `packageManager` in `package.json`, else the lockfile (`yarn.lock`, `pnpm-lock.yaml`, `package-lock.json`), else what AGENTS.md names. yarn, pnpm and npm are installed; do not switch to another package manager. Run the server in the background with a PID file and stop it by that PID when you are done.
   - Take the screenshot with `symphony-screenshot <url> <out.png>` (`--login-url`, `--email`, `--password` for a form login, `--click`, `--clip`, `--scale 2`, `--header 'Host: …'`; `symphony-screenshot --help`). For more steps, write a short Node script with `import { chromium } from 'playwright'`; it resolves from any directory.
   - Open every PNG with the Read tool and check that it shows what it should (logged in, right page, real data, no error page).
   - Store it where the project's instructions say, else under `docs/screenshots/` with a descriptive name, then commit and push it on `{{ branch }}`.
   - Embed it in the pull request body by commit SHA: `![<what it shows>](https://github.com/<owner>/<repo>/blob/<commit sha>/<path>?raw=true)`; this works for private repositories too, `raw.githubusercontent.com` does not. `open_pull_request` on a branch with an open pull request replaces its title and body, so call it again with the complete body after adding screenshots.
   - If a screenshot still cannot be taken, set `screenshots_problem` in your result to exactly which step failed and with what error.
{% endcapture %}{% capture screenshots_note %}
UI screenshots: when the project's instructions or the issue ask for screenshots of UI changes, the developer takes them in its workspace: it builds the frontend assets where needed, serves the app and uses the image's headless Chromium (`symphony-screenshot --check` tests it; it is not on the `PATH`, and a missing `node_modules` or `public/build` is normal in a fresh workspace). "No browser" or "no frontend build" is never a reason to leave them out{% if role == "reviewer" %}: if they are missing, that is a `major` finding, unless the developer's result names the step that failed and its error; then it is `minor` and quotes that error{% else %}, so do not plan to leave them out or to hand them to a human{% endif %}.
{% endcapture %}
You are working on GitHub issue **{{ issue.identifier }}**: {{ issue.title }}

- Issue: {{ issue.url }}
- Board status: {{ issue.state }}
{% assign task_labels = issue.labels | without_agent_labels %}{% if task_labels != empty %}- Labels: {{ task_labels | join: ", " }}
{% endif %}{% if issue.native_ref.parent %}- Parent issue: {{ issue.native_ref.parent.identifier }} ("{{ issue.native_ref.parent.title }}"). This is a sub-issue: keep the change scoped to it.
{% endif %}{% if issue.native_ref.sub_issues != empty %}- Sub-issues:{% for sub in issue.native_ref.sub_issues %} {{ sub.identifier }} "{{ sub.title }}" ({{ sub.state | downcase }}){% unless forloop.last %},{% endunless %}{% endfor %}. Build on their results instead of redoing them.
{% endif %}{% if issue.blocked_by != empty %}- Depends on:{% for blocker in issue.blocked_by %} {{ blocker.identifier }} ({{ blocker.state | downcase }}){% unless forloop.last %},{% endunless %}{% endfor %}.
{% endif %}{% if attempt %}- Attempt {{ attempt }}: this workspace already holds earlier work on the issue. Check `git status`, `git log --oneline -10` and the issue comments (`get_issue`) and continue from there instead of starting over.
{% endif %}
Tools in the container: `jq`, `rg`, `node` and `php` are installed; `python3` is not (do not use it for JSON or scripting, use `jq` or `node`).

## Issue description

{{ issue.description | default: "(no description)" }}

{% if human_feedback.size > 0 %}## Newest human comments

A human wrote this on the issue after the pipeline last handed it off, usually when sending the issue back. It is the current task: where it asks for changes, do them, even when earlier results say the issue is done, a pull request is merged or a review approved it. The description and the earlier results are the background.
{% for comment in human_feedback %}
### {{ comment.author }}, {{ comment.created_at }} ({{ comment.url }})

{{ comment.body }}
{% endfor %}
{% endif %}{% if attachments.size > 0 %}## Attachments

The description and comments only link to these files; Symphony downloaded them into the workspace (`.issue-assets/`, kept out of git and listed in `.issue-assets/INDEX.md`). You see an image or PDF only when you open it: open every file below with the Read tool before you plan, design or change anything.
{% for file in attachments %}
- {% if file.path %}`{{ file.path }}`{% else %}not downloaded ({{ file.error }}){% endif %}{% if file.label != "" %}: "{{ file.label }}"{% endif %}, from {% if file.source == "description" %}the description{% else %}{{ file.source }}{% endif %}{% endfor %}

A mockup or screenshot is part of the requirements: layout, order, labels and texts follow it. Where it contradicts the description, say so in your result. If the issue depends on a file that could not be downloaded or opened, do not guess what it shows: say so in your result.

{% endif %}{% if issue.command %}## Issue command: /{{ issue.command.name }}

The description starts with the command `/{{ issue.command.name }}`{% if issue.command.args != "" %} and the argument `{{ issue.command.args }}`{% endif %}. Before anything else, load the skill `{{ issue.command.skill }}` with the Skill tool{% if issue.command.args != "" %} and pass it the argument{% endif %}, then follow it. Where the skill and the steps of your role below disagree, the skill wins. What your role may do (read-only access, allowed status changes, available tools) still applies.

{% endif %}{% if brain != "off" %}{% include "roles/brain.md" %}

{% endif %}{% comment %}Role prompts: roles/<role>.md next to this file. New role: add the file and a when line.{% endcomment %}{% case role %}
{%- when "developer" %}{% include "roles/developer.md" %}
{%- when "issue-analyst" %}{% include "roles/issue-analyst.md" %}
{%- when "architect" %}{% include "roles/architect.md" %}
{%- when "test-engineer" %}{% include "roles/test-engineer.md" %}
{%- when "reviewer" %}{% include "roles/reviewer.md" %}
{%- when "docs" %}{% include "roles/docs.md" %}
{%- when "security-auditor" %}{% include "roles/security-auditor.md" %}
{%- when "auditor" %}{% include "roles/auditor.md" %}
{%- when "autopilot" %}{% include "roles/autopilot.md" %}
{%- when "analyst" %}{% include "roles/analyst.md" %}
{%- when "planner" %}{% include "roles/planner.md" %}
{%- else %}{% include "roles/default.md" %}
{%- endcase %}
