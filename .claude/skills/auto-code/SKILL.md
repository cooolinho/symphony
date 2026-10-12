---
name: auto-code
description: Autopilot for a repository. Plans the next wave of new features, design, quality and maintenance tasks from the project description and creates them as sub-issues that Symphony implements right away; checkpoints every few waves. Only load when the prompt asks for it (issue command /auto-code), never on your own.
argument-hint: "[path to project description] [wave=3] [checkpoint=5] [issue-models=auto|opus|sonnet|haiku]"
---

# Autopilot: plan the next wave

You develop the repository on your own. Your only brief is the **project description**. From it you plan the next
**wave**: a few small tasks that are created as sub-issues of the current issue (the epic). They start right away;
developer and reviewer implement them, Symphony merges them into the base branch. Once all sub-issues of the wave are
closed, Symphony starts you again for the next wave.

You **change nothing**: no Edit, no Write, no commit, no push, no change to branches on the remote. Allowed are
read-only commands, measurements, `git fetch` and a local `git switch --detach`. **Forbidden**: `pint` without `--test`,
`composer update|require|remove`, `npm install`, `npm audit fix`, `php artisan migrate|db:seed|tinker`,
`git commit|push|reset|rebase` and anything that changes files in the repository. If a test run writes files (cache,
SQLite), that is fine as long as they do not belong in the repository.

**Arguments** (`$ARGUMENTS`, all optional, any order):

- a path: the project description. Without a path you look for `docs/vision.md`, then `docs/index.md`, then `README.md`.
- `wave=<n>`: issues per wave, default 3. More than `create_sub_issue` reports as `remaining` is not possible.
- `checkpoint=<n>`: stop after every n-th wave, default 5. `checkpoint=0` never stops on its own.
- `issue-models=<auto|opus|sonnet|haiku>`: model labels for the sub-issues. Without the argument (or with `off`) you set
  no model labels; the issues then run with the instance's default model (`CLAUDE_MODEL`).
  - `opus`, `sonnet`, `haiku`: every sub-issue gets the label `Model: <value>`.
  - `auto`: every sub-issue gets the label that fits its effort, see [Phase 4](#phase-4-cut-the-wave).
  - Any other value is invalid: treat it like `off` and put the warning in the notes section of the report.

Text in the epic's description below the command line counts as part of the brief (e.g. focus areas or a handover
from an earlier epic).

The report headings (`## Auto-Code Wave …`, `## Auto-Code Checkpoint after wave …`, `## Auto-Code Pause`,
`## Auto-Code Handover`) are markers you search for in later runs. Always write them in English, exactly as in
[templates.md](templates.md), whatever the language of the epic. Epics started before the skill was translated may
contain the German forms `## Auto-Code Welle <N>`, `## Auto-Code Checkpoint nach Welle <N>` and `## Auto-Code Übergabe`;
treat them as equivalent.

## Phase 0: Determine the situation

Call `get_issue`. What matters are the comments (reports and requests) and the sub-issues with `state` and
`state_reason`.

- **Last wave N** = the highest number from comments that start with `## Auto-Code Wave <N>`; without such comments
  N = 0.
- **Open sub-issues present**: Normally Symphony does not start you then. If their report is missing (an earlier run
  aborted), write the report for the existing issues as wave N + 1 and end the turn. If the report already exists, end
  the turn immediately without doing anything.
- **Checkpoint due**: If N > 0, `checkpoint` > 0, N is divisible by `checkpoint` and there is no comment
  `## Auto-Code Checkpoint after wave <N>` yet, go to [Phase 6](#phase-6-checkpoint). If that comment already exists, a
  human moved the epic back to "Ready" after the checkpoint: keep planning.
- **Early checkpoint**: If two or more sub-issues of the last wave were closed as `NOT_PLANNED`, the direction is off.
  Go to Phase 6 as well, even if no regular checkpoint is due yet.
- **Epic full**: If the epic has 80 or more sub-issues (GitHub allows 100), go to
  [Phase 7](#phase-7-pause-or-handover) (handover).

## Phase 1: Context

Determine and note (evidence from the files, not from memory):

- **Project description**: goal, target groups and roles, features, stack. In particular the section "Guardrails for
  the autopilot", if present (template: [vision-template.md](vision-template.md)): non-goals, priorities, design
  principles, taboos. Older descriptions may name it "Leitplanken für den Autopiloten". If there is no description with
  a recognisable goal, write what is missing (with a reference to the template) and move to "Blocked".
- **Roadmap**: open items in `docs/todo.md`, `TODO.md`, `ROADMAP.md` or phase documents, in their order.
- **Project rules**: `AGENTS.md`, `CLAUDE.md`, `.ai/` (guidelines, rules, skills).
- **Current state** on the base branch (the prompt names it, otherwise the default branch): `git fetch origin`, then
  `git switch --detach origin/<base>`. `git log --oneline -40` shows what the last waves delivered. Get an overview of
  models, Filament resources and pages, routes, Livewire components and tests. Use Laravel Boost tools
  (`application-info`, `database-schema`, `list-routes`, `search-docs`) where available.
- **History in the epic**:
  - Earlier wave reports with their idea backlog.
  - Sub-issues with `state_reason: NOT_PLANNED`: a human **rejected** these ideas; they are taboo, reworded as well.
  - **Comments by humans since the last report**: these are requests and course corrections. They take precedence over
    everything else.

## Phase 2: Baseline

Only measure, repair nothing. Use the scripts from `composer.json` and `package.json` first (`test`, `lint`, `analyse` …),
otherwise `php artisan test` or `vendor/bin/pest`, `vendor/bin/phpstan analyse`, `vendor/bin/pint --test`. Note one
line per command (green, red with count, not present). Follow the project rules on which commands may run in a Symphony
workspace. Anything that does not run locally you note as "not run".

**If the base branch is red** (tests or analysis fail), this wave becomes a **repair wave**: only issues of the
category `quality` that make it green again. New features only afterwards.

## Phase 3: Collect and rate ideas

The sources in this order; the criteria and the rating scheme are in [ideation.md](ideation.md):

1. Requests from humans' comments on the epic.
2. Open roadmap items, in their order.
3. Gaps between project description and code: described features that are missing or incomplete.
4. Your own ideas that noticeably advance the goal of the project description: features, design and UX, quality,
   maintenance.

Every idea needs a **reference to the project description** (section or quote) and **evidence in the code** (file,
route or resource it starts from). Discard ideas without both. Non-goals, taboos, rejected ideas and finished work are
excluded.

## Phase 4: Cut the wave

1. Choose at most `wave` ideas with the best ratio of value to effort and risk. Follow the
   [mixing rules](ideation.md#mixing-rules).
2. Every issue is **mergeable on its own**, size S or M. Split an idea of size L into several issues across several
   waves; the first slice goes into this wave.
3. If two issues of the same wave touch the same files, chain them with `Blocked by #N` (literally, in English), or
   move one to a later wave.
4. Every issue gets verifiable **acceptance criteria** and says which tests it needs. For design issues the criteria
   are concrete (components, layout, texts, states), never "make it nicer".
5. Labels: `auto-code`, the category (`feature`, `design`, `quality` or `maintenance`) and `Effort: medium` (S) or
   `Effort: high` (M). A major upgrade (Laravel, Filament, PHP) stands alone in its wave and additionally gets
   `manual-merge`: a human merges it.
   - **Model label** (only with `issue-models`, otherwise none): With `opus`, `sonnet` or `haiku` all issues get
     `Model: <value>`. With `auto` you pick **exactly one** label per issue by effort and risk:

     | Label | When |
     |---|---|
     | `Model: haiku` | effort S **and** low risk: texts, translations, configuration, small changes in one area, simple tests, minor updates |
     | `Model: sonnet` | the normal case: effort S with medium risk, effort M with low or medium risk (new feature in a few files, design issues, tests, ordinary refactorings) |
     | `Model: opus` | high risk (data model, permissions, money, migrations on existing data), effort M across several areas, major upgrades, tricky dependencies or a refactoring without a test net |

     When in doubt, the stronger model. State label and reason per issue in the report. The label applies to the whole
     sub-issue: developer and reviewer run with this model, not with the instance's default model.
6. A pure refactoring without behaviour change starts with `/refactor-safely` on the first line. If the area lacks
   tests, a test issue comes first and the refactoring waits for it (`Blocked by #N`).

## Phase 5: Output

The templates are in [templates.md](templates.md).

1. Create the sub-issues with `create_sub_issue`, dependent ones last (they refer to earlier numbers). The title is
   also the key against duplicates: on a retry, use the same title.
2. Post exactly one comment `## Auto-Code Wave <N+1>` with `add_comment`: selection with reasoning, baseline, idea
   backlog (the best ideas not chosen) and notes. Rejected creations (`limit_reached`) and unknown labels
   (`unknown_labels`) belong there. If a `Model: …` label is missing in the repository, say so, noting that
   `npm run repo-init` → *Standard labels* creates it; the issue then runs with the default model.
3. **End the turn without changing the status.** The epic stays in "In progress"; Symphony starts you again once all
   sub-issues of the wave are closed.

If you find no idea that meets the criteria, create **nothing**: [Phase 7](#phase-7-pause-or-handover). Busywork harms
the project more than a pause.

## Phase 6: Checkpoint

1. Summarise the waves since the last checkpoint (template "Checkpoint"): done, rejected, open idea backlog, state of
   the baseline, your recommendation for the next waves and questions for the human.
2. **Release PR**: If the base branch is not the default branch (`git symbolic-ref refs/remotes/origin/HEAD`) and it is
   ahead of it (`git log --oneline origin/<default>..origin/<base>` is not empty), open a pull request with
   `open_pull_request` with `head: <base>` and `base: <default>`. Title: `Release: autopilot up to wave <N>`, the
   summary in the body. If it already exists, the tool returns it. A human merges it.
3. Post exactly one comment `## Auto-Code Checkpoint after wave <N>`, with the link to the release PR.
4. `set_status("In review")` and end the turn. If a human moves the epic back to "Ready", work continues.

## Phase 7: Pause or handover

- **Nothing useful left**: comment `## Auto-Code Pause`. It says why nothing meets the criteria anymore and what a
  human can do so work continues (extend the project description, comment requests). Then `set_status("In review")`.
- **Epic full** (80 or more sub-issues): comment `## Auto-Code Handover` with everything a successor needs to know:
  state, idea backlog, rejected ideas, open requests. The human creates a new epic and copies the section below the
  command line. Then `set_status("In review")`.

Write sub-issues, reports and comments in the language of the epic; only the report headings stay in English.
