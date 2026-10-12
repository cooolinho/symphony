---
name: concept
description: Concept workflow. Reads a concept (Markdown file in the repository), analyses it and creates epics and sub-issues from it in the backlog, with dependencies (Blocked by) as well as model and effort labels. Only load when the prompt asks for it (issue command /concept), never on your own.
argument-hint: "<path to the concept, e.g. docs/index.md> [issue-models=auto|fable|opus|sonnet|haiku|off]"
---

# Break a concept down into epics and issues

Your brief is a **concept**: a Markdown file in the repository that describes what is to be built. You turn it into a
work plan on the board. The issue you run on is the root; two levels are created below it:

```
Concept issue (this issue)
└─ Epic: <functional area>             labels epic, concept · container, never "Ready"
   └─ <Category>: <task>               labels concept, category, Effort, Model · implementable on its own
```

Everything lands in the **backlog**. A human reviews the issues, drops or adds some and moves the ones to be
implemented to "Ready" one by one. You move nothing there.

You **change nothing**: no Edit, no Write, no commit, no push, no change to branches on the remote. Allowed are
read-only commands, `git fetch` and a local `git switch --detach`. **Forbidden**: `pint` without `--test`,
`composer update|require|remove`, `npm install`, `npm audit fix`, `php artisan migrate|db:seed|tinker`,
`git commit|push|reset|rebase` and anything that changes files in the repository.

**Arguments** (`$ARGUMENTS`, any order):

- a path (**required**): the concept, relative to the repository root. A file ending in `.md`, or a directory with
  `index.md` or `README.md`. If the path is missing, the file does not exist, the path is absolute or it contains `..`,
  write a comment saying what is missing and move to "Blocked".
- `issue-models=<auto|fable|opus|sonnet|haiku|off>`: model labels for the issues. Default `auto`.
  - `auto`: per issue the label that fits its size and risk ([breakdown.md](breakdown.md#labels)).
  - `fable`, `opus`, `sonnet`, `haiku`: every issue gets `Model: <value>`.
  - `off`: no model labels; the issues run with the instance's default model.
  - Any other value is invalid: treat it like `auto` and put the warning in the notes section of the report.

Text in the description below the command line counts as part of the brief (focus areas, order, exclusions).

The comment headings `## Concept Plan` and `## Concept Report` are markers you search for in later runs. Always write
them in English, exactly as in [templates.md](templates.md), whatever the language of the concept. Concept issues
started before the skill was translated may contain the German forms `## Konzept-Plan`, `## Konzept-Bericht` and
`## Konzept-Bericht (Nachtrag <n>)`; treat them as equivalent.

## Phase 0: Determine the situation

Call `get_issue`. What matters are the comments (your own plans and reports, requests from humans) and the sub-issues.

- **Neither `## Concept Plan` nor `## Concept Report`**: new run, continue with Phase 1.
- **`## Concept Plan` but no `## Concept Report`**: An earlier run aborted while creating. Read the concept anyway
  (Phase 1), but do not analyse it again: take the plan from the comment and carry out Phases 6 and 7 with it. Creating
  is idempotent: the same title under the same parent returns the existing issue (`created: false`).
- **`## Concept Report` present**: addendum. Read the concept and the new comments by humans and create only what is
  missing from the report: the section "Not created", new requirements, requests. Nothing that is in the report is
  created again, even if it has been closed since. Epics you need for this you get back by their title
  (`created: false`). Number the reports consecutively (`## Concept Report (addendum 1)`).

## Phase 1: Read the concept

1. `git fetch origin`, then `git switch --detach origin/<base>` (the prompt names the base branch, otherwise the
   default branch). The concept must be there.
2. Read the file completely. Follow relatively linked Markdown files in the repository one level deep (at most 15
   files); they are part of the concept.
3. Note with evidence (section or quote, not from memory): goal, target groups and roles, functional areas, data
   objects, flows, non-functional requirements, **non-goals**, open questions and assumptions of the concept.
4. If the concept has no recognisable goal or is too thin for a plan, write what is missing and move to "Blocked".

## Phase 2: State of the repository

- Project rules (`AGENTS.md`, `CLAUDE.md`, `.ai/`), stack from `composer.json`, `package.json` and the lock files.
- What already exists: models, Filament resources and pages, routes, Livewire components, tests; use Laravel Boost
  tools (`application-info`, `database-schema`, `list-routes`) where available.
- Classify every functional area of the concept: **present**, **partial** (what is missing), **missing**. What is
  present becomes no issue; what is partial only for the missing rest.

Measure nothing and repair nothing: this is planning, not an audit.

## Phase 3: Cut

Rules and sizes are in [breakdown.md](breakdown.md). The result:

1. The epics: one self-contained functional area of the concept each.
2. The issues per epic: mergeable on their own, size S or M. Split a requirement of size L.
3. A **coverage list**: every section of the concept is assigned to an issue, to "present" or to "Not created"
   (non-goal, open question, decision for a human). A requirement without a place is an error in the plan.

The concept is the scope. You do not invent features on top of it; gaps in the concept become **questions** in the
report.

## Phase 4: Order and labels

1. **Dependencies.** An issue waits only for concrete issues, never for an epic (rules in
   [breakdown.md](breakdown.md#dependencies)). Sort all issues **topologically**: blockers before the issues that wait
   for them.
2. **Labels** per issue ([breakdown.md](breakdown.md#labels)): `concept`, the category (`feature`, `design`, `quality`
   or `maintenance`), exactly one `Effort: …` and, except with `issue-models=off`, exactly one `Model: …`. Epics carry
   `epic` and `concept`, nothing else.
3. Give every epic and issue a stable key (`E1`, `E1.1`, `E1.2`, `E2.1` …) and a unique title.

## Phase 5: Record the plan

Post exactly one comment `## Concept Plan` **before creating anything** ([templates.md](templates.md#plan)): concept
path and state, epics with their issues (key, title, category, size, labels, dependencies) and the coverage list. It is
the basis for a continuation if this run aborts.

## Phase 6: Create

Only with `create_sub_issue`, never with git, `gh` or the API. Templates for the texts: [templates.md](templates.md).

1. Go through the issues in the order from Phase 4. Create an issue's epic as soon as its first issue is due:
   `create_sub_issue(title, body, labels: ["epic", "concept"])`, without `parent`.
2. The issue: `create_sub_issue(title, body, labels, parent: <number of the epic>, blocked_by: [<numbers of the blockers>])`.
   The line `Blocked by #N` (literally, in English) additionally goes into the text, directly below the goal.
3. Remember the `number` of every result: you need it as `parent` and for `blocked_by`. Watch for `unknown_labels`
   (label missing in the repository, the issue was created without it), `unknown_blockers`, `warnings` and `remaining`.
4. Stop at the first `limit_reached`: all further issues go into the report under "Not created". The limit counts
   epics too; that is why you create an epic only when it gets its first issue.
5. An error (`github_error`, `invalid_argument`) affects only this issue: read the message, correct the call once,
   otherwise the issue belongs in the report.

## Phase 7: Report

Post exactly one comment `## Concept Report` ([templates.md](templates.md#report)): the tree with numbers, per issue
the labels with the reason, "Not created", open questions and notes (`limit_reached`, `unknown_labels`,
`unknown_blockers`, `warnings`). If a label such as `epic`, `concept`, `Model: …` or `Effort: …` is missing in the
repository, say so, noting that `npm run repo-init` → *Standard labels* creates it.

Then `set_status("In review")` and end the turn. The concept issue is now the root epic. Whoever wants to extend the
plan comments here and moves the issue back to "Ready": that is the addendum.

Write issues, plan, report and comments in the language of the concept; only the `## Concept Plan` and
`## Concept Report` headings stay in English.
