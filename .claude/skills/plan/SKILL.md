---
name: plan
description: Plan workflow. Turns a list (a file in the repository or the issue description) into one sub-issue per item, each with a detailed implementation plan, dependencies (Blocked by) and category, effort and model labels, in the backlog. Only load when the prompt asks for it (issue command /plan), never on your own.
argument-hint: "[<path to a list, e.g. docs/todo.md>] [issue-models=auto|fable|opus|sonnet|haiku|off] [issue-efforts=auto|off]"
---

# Turn a list into planned issues

Your brief is a **list**: every item on it is a piece of work. You turn **each item into exactly one issue** with a
detailed implementation plan. The issue you run on is the parent; the issues are created directly below it:

```
Plan issue (this issue)
├─ <Category>: <item 1>       labels plan, category (Effort, Model on request) · implementable on its own
├─ <Category>: <item 2>       … Blocked by #<item 1>
└─ …
```

Everything lands in the **backlog**. A human reviews the issues, drops or changes some and moves the ones to be
implemented to "Ready" one by one. You move nothing there.

You **change nothing**: no Edit, no Write, no commit, no push, no change to branches on the remote. Allowed are
read-only commands, `git fetch` and a local `git switch --detach`. **Forbidden**: `pint` without `--test`,
`composer update|require|remove`, `npm install`, `npm audit fix`, `php artisan migrate|db:seed|tinker`,
`git commit|push|reset|rebase` and anything that changes files in the repository.

**Arguments** (`$ARGUMENTS`, any order):

- `issue-models=<auto|fable|opus|sonnet|haiku|off>`: model labels for the issues. Default `off`.
  - `off`: no model labels. The model follows the issue's complexity, which the issue analyst sets in Ready: the
    architect designs large issues with fable, the developer implements them with opus, smaller ones with the
    instance's default model. A label would override that, so it is the exception.
  - `auto`: per issue the label that fits its size and risk ([labels.md](labels.md#model)).
  - `fable`, `opus`, `sonnet`, `haiku`: every issue gets `Model: <value>`.
  - Any other value is invalid: treat it like `off` and put the warning in the notes section of the report.
- `issue-efforts=<auto|off>`: effort labels for the issues. Default `off`.
  - `off`: no effort labels. The developer and the architect then run with the effort `WORKFLOW.md` gives them
    (the architect `high`, the developer the model's default); a label would override that, so it is the exception.
  - `auto`: per issue the label that fits its size and risk ([labels.md](labels.md#effort)).
  - Any other value is invalid: treat it like `off` and put the warning in the notes section of the report.
- an optional **source**. The first argument that is not `key=value` decides:
  - It looks like a path (contains `/` or ends in `.md` or `.txt`): **file mode**. The list is that file, relative to
    the repository root. If the path is absolute, contains `..` or the file does not exist on the base branch, write a
    comment saying what is missing and move to "Blocked". Text in the description below the command line counts as
    part of the brief (focus, "only section X", exclusions, order).
  - Otherwise, or with no argument at all: **description mode**. The list is in this issue's description, below the
    command line. Free text in the argument (`/plan Sprint 12`) is only the heading or context of the list.

**What an item is:** every top-level list entry (`-`, `*`, `+`, `1.`, `- [ ]`) of the source. Indented sub-entries,
code blocks and text that follows an entry up to the next top-level entry belong to it as details. A ticked entry
(`- [x]`) is done: create nothing for it and list it in the report. Headings group items but are no items themselves;
they can serve as context. If the source contains no list, write a comment that shows the expected format (one item
per top-level list entry) and move to "Blocked".

The comment headings `## Plan Outline` and `## Plan Report` are markers you search for in later runs. Always write them
in English, exactly as in [templates.md](templates.md), whatever the language of the list.

## Phase 0: Determine the situation

Call `get_issue`. What matters are the comments (your own outlines and reports, requests from humans) and the
sub-issues.

- **Neither `## Plan Outline` nor `## Plan Report`**: new run, continue with Phase 1.
- **`## Plan Outline` but no `## Plan Report`**: an earlier run aborted while creating. Read the source anyway
  (Phase 1), but do not plan again: take the items from the outline and carry out Phases 6 and 7 with it. Creating is
  idempotent: the same title under the same parent returns the existing issue (`created: false`).
- **`## Plan Report` present**: addendum. Read the source and the new comments by humans and create only what is
  missing from the report: new items, the section "Not created", requests. Nothing that is in the report is created
  again, even if it has been closed since. Number the reports consecutively (`## Plan Report (addendum 1)`).

## Phase 1: Read the list

1. `git fetch origin`, then `git switch --detach origin/<base>` (the prompt names the base branch, otherwise the
   default branch). In file mode the file must be there.
2. Read the source completely. Number the items in their order (`P1`, `P2`, …) and keep the **literal wording** of each
   one; it goes into the issue as the source quote.
3. In file mode, follow relatively linked Markdown files one level deep (at most 10) where an item refers to them;
   they are details of that item, not new items.

## Phase 2: Understand each item in the code

Read the project rules first (`AGENTS.md`, `CLAUDE.md`, `.ai/`) and the stack (`composer.json`, `package.json`, lock
files). Then, **per item**, find out where it lands: models, migrations, Filament resources and pages, Livewire
components, routes, policies, config, tests. Use Laravel Boost tools (`application-info`, `database-schema`,
`list-routes`, `search-docs` against the installed versions) where available.

Classify every item: **present** (no issue; say where in the report), **partial** (the issue covers only the missing
rest) or **missing**. Note the concrete files and lines you will name in the plan, with evidence, not from memory.

Measure nothing and repair nothing: this is planning, not an audit.

## Phase 3: Plan each item

**One item, one issue.** You neither split an item nor merge items: the list is the cut. For each item:

1. Title, category, size (S: one file or a few lines, M: a few files in one area, L: more) and risk (low, medium,
   high).
2. The **implementation plan**: numbered, concrete steps in the order a developer works through them, each naming
   the files, classes, migrations, routes or components it touches and what changes there. Detailed enough that the
   developer agent can start without searching for the starting point again.
3. Verifiable acceptance criteria (for permissions: who may, who may not), the tests that prove them, risks and open
   points, and what does **not** belong to the item.

Rules:

- The list is the scope. You do not add work that is not on it; gaps become **questions** in the report.
- An item too vague to plan (no recognisable goal, contradictory) becomes no issue: it goes under "Not created" with
  the question a human has to answer.
- An item of size L stays one issue (with `issue-efforts=auto`: `Effort: high`); note in the report that it should be
  split before it goes to "Ready".
- Decisions a human has to make (legal texts, prices, paid external services) are open points in the issue and
  questions in the report, never silent assumptions.
- **Design items** (the agent does not see the UI): concrete criteria with component, columns, filters, actions, texts,
  empty and error states and which role sees what. Never "make it nicer".
- A pure refactoring without behaviour change starts with `/refactor-safely` on the first line of its text.

## Phase 4: Order and labels

1. **Dependencies** between items ([labels.md](labels.md#dependencies)): only real ones, never a cycle. Sort the
   items **topologically**: blockers before the items that wait for them; otherwise keep the order of the list.
2. **Labels** per issue ([labels.md](labels.md)): `plan`, the category (`feature`, `design`, `quality` or
   `maintenance`), with `issue-efforts=auto` exactly one `Effort: …`, with `issue-models` other than `off` exactly one
   `Model: …`.
3. Every title is unique within this issue: it is the key against duplicates.

## Phase 5: Record the outline

Post exactly one comment `## Plan Outline` **before creating anything** ([templates.md](templates.md#outline)): source
and state, the items with key, title, category, size, risk, labels and dependencies, the creation order and the
coverage list (every item → issue, present, done or not created). It is the basis for a continuation if this run
aborts.

## Phase 6: Create

Only with `create_sub_issue`, never with git, `gh` or the API. Template for the text: [templates.md](templates.md#issue).

1. Go through the items in the order from Phase 4:
   `create_sub_issue(title, body, labels, blocked_by: [<numbers of the blockers>])`, without `parent`: the issue lands
   directly below this one. The line `Blocked by #N` (literally, in English) additionally goes into the text, directly
   below the goal.
2. Remember the `number` of every result: you need it for `blocked_by` of later items. Watch for `unknown_labels`
   (label missing in the repository, the issue was created without it), `unknown_blockers`, `warnings` and `remaining`.
3. Stop at the first `limit_reached`: all further items go into the report under "Not created".
4. An error (`github_error`, `invalid_argument`) affects only this item: read the message, correct the call once,
   otherwise the item belongs in the report. Items that wait for it are created without that blocker and the report
   says so.

## Phase 7: Report

Post exactly one comment `## Plan Report` ([templates.md](templates.md#report)): the created issues with numbers, per
issue the labels with the reason, "Not created", open questions and notes (`limit_reached`, `unknown_labels`,
`unknown_blockers`, `warnings`, items of size L). If a label such as `plan`, `Model: …` or `Effort: …` is missing in the
repository, say so, noting that `npm run repo-init` → *Standard labels* creates it.

Then `set_status("In review")` and end the turn. Whoever wants to extend the plan adds items to the list (or comments
here) and moves the issue back to "Ready": that is the addendum.

Write issues, outline, report and comments in the language of the list; only the `## Plan Outline` and
`## Plan Report` headings stay in English.
