# Usage

## The lifecycle of an issue

The bundled `WORKFLOW.md` works with two **roles**: a *developer* implements the issue, a *reviewer* checks it
without changing anything. The column decides which role runs. Between the roles there are **checks**
(`checks/laravel.sh`: clean and pushed branch, lint, static analysis, tests) that Symphony runs itself before a card
may move to `Agent review` or `In review`. In repositories without a Laravel app the checks pass right away
(exit 0).

1. Symphony polls the board every 30 seconds (`polling.interval_ms`). Candidates are issues in `Ready`,
   `In progress` and `Agent review`. Work already in flight starts first, then new candidates by priority, then by
   age (see [Dispatch order](#dispatch-order)).
2. Symphony creates `~/symphony-workspaces/<owner>_<repo>_<nr>-<hash>` for the issue. The `after_create` hook clones
   the issue's repository there and uses `hooks/laravel-env.sh` to set up a separate `.env` with an SQLite database for
   each Laravel app. Before each run, `before_run` fetches the latest state (`git fetch`). If the clone contains a
   Laravel app with Laravel Boost, Symphony prepares Boost (see [Laravel Boost](#laravel-boost)).
3. **Developer** (`Ready`, `In progress`): Claude Code starts in the workspace with the developer part of the prompt.
   The agent
   - reads the repository's `AGENTS.md`, `CLAUDE.md` and `README.md`, plus the issue's comments and pull requests
     (including earlier reviews),
   - sets the issue to `In progress` and comments its plan,
   - works on the branch `symphony/issue-<nr>`, or on a branch you linked in the issue,
   - implements and tests, merges the base branch in, commits, pushes and opens a pull request with
     `Closes #<nr>`,
   - comments the result and calls `set_status("Agent review")`.
4. **Checks before `Agent review`:** Symphony runs the checks in the workspace. If they pass, the card moves to
   `Agent review` and the developer session ends. If they fail (`check_failed`), the card stays and the agent gets
   the output, fixes the errors and tries again. If the checks run longer than `checks.timeout_ms`
   (`check_timeout`), the agent tries once more and otherwise ends its turn; the card keeps its column and never goes
   to `Blocked` for a timeout. If the environment is broken (`check_error`, e.g. a missing `vendor/`), the agent
   comments that and moves the card to `Blocked`.
5. **Reviewer** (`Agent review`, at most one at a time, model `opus`, read-only, 6 turns): checks
   `git diff origin/<base>...HEAD`, the pull request and the comments against a checklist (correctness, tests,
   authorization, validation, N+1, migrations, secrets, changed test/CI/lint configuration) and writes
   **one** comment `## Agent review (round N)`. Then:
   - **approved:** `In review`. The checks run once more first; for an unchanged commit Symphony uses the stored
     result.
   - **changes needed:** back to `In progress`; the developer works through the findings (step 3).
   - **from round 3:** no further loop, but `In review` with the list of open findings for you.
6. After each turn Symphony checks the issue. If it moves to a column of another role, the session ends and the
   next role starts one second later in a fresh session. If it is still in a column of the same role, the agent
   gets more turns up to `max_turns`, then a new session. At most `SYMPHONY_MAX_CONTINUATIONS` (default 6) such
   sessions, role changes included, then the issue is paused.
7. You review the pull request, merge it and move the card to `Done`. Symphony then deletes the workspace. Only you
   set `Done`; Symphony refuses this move for agents.

| Column | What Symphony does |
|---|---|
| `Backlog` | nothing. Issues here are not released yet. |
| `Ready` | starts a developer as soon as a slot is free |
| `In progress` | a developer is working; if Symphony finds an issue here without an agent, it starts one |
| `Agent review` | starts a reviewer (at most one at a time); only reachable after passing checks |
| `Blocked` | stops a running agent; the workspace is kept. The agent needs you, see its comment. |
| `In review` | stops a running agent; the workspace is kept for follow-up work. Only the reviewer moves cards here, after passing checks. |
| `Done` | stops a running agent and deletes the workspace, at the latest on the next poll |

If you want follow-up work, comment in the issue and move it back to `Ready` or `In progress`. The developer
continues in the same workspace and reads your comments. Move an issue out of `Blocked` the same way once the
problem is resolved.

### Migrating from the single-prompt setup

Up to this version the `WORKFLOW.md` had a single prompt: one agent worked from `Ready` to `In review`.
To switch to roles:

1. **Board:** add the columns `Agent review` and `Blocked` (see
   [Set up the board](getting-started.md#2-set-up-the-github-project-board)). Running issues can stay in their columns.
2. **`WORKFLOW.md`:** take over the bundled file. If you have your own, add:
   - `tracker.active_states: [Ready, In progress, Agent review]`,
   - the `roles` section (`developer` for `Ready` and `In progress`, `reviewer` for `Agent review`),
   - `checks.on_enter` for `Agent review` and `In review` with `checks/laravel.sh`,
   - `agent.max_concurrent_agents_by_state: { "Agent review": 1 }` and a limit for `agent.max_continuations`
     (without a limit Symphony warns, because every role change counts as a continuation),
   - `bash "$SYMPHONY_WORKFLOW_DIR/hooks/laravel-env.sh"` in the `after_create` hook,
   - in the prompt, `{% case role %}` with sections `{% when "developer" %}`, `{% when "reviewer" %}` and an
     `{% else %}` with your previous prompt as fallback.
   A complete example is in [configuration.md](configuration.md#complete-example-roles-checks-and-laravel).
3. **`.env`:** set `SYMPHONY_MAX_CONTINUATIONS=6`. The old value `2` is not enough for developer, reviewer and one
   round of fixes.
4. **Verify:** `npm run dry-run` must not report `unknown board column` and shows the prompt for the role of the
   first candidate.

Existing workspaces do not get the `after_create` hook retroactively. For Laravel apps in them, run
`bash ~/projects/symphony/hooks/laravel-env.sh` once in the workspace, or delete the workspace.
To go back to the old behavior, remove `roles` and `checks`: then every issue runs with the role `default` and the
`{% else %}` prompt.

## Intervening while Symphony runs

| Goal | How |
|---|---|
| Stop an agent | Move the issue to `Backlog`, `Blocked` or `In review`. It stops on the next poll, at the latest after 30 s. |
| Cancel and clean up | Move the issue to `Done` |
| Pause all new starts | Set the slots to `0` on the dashboard, or `agent.max_concurrent_agents: 0` in the `WORKFLOW.md`. Running agents keep working. |
| Change the number of agent slots | At the slot bar of *Running* on the dashboard, use **−** / **+** for the total, for each active column and for the slots reserved per role (**×** returns a column or a role to its `WORKFLOW.md` value, **Reset to WORKFLOW.md** removes every override). The change applies from the next tick without a restart and survives a restart; a reload of `WORKFLOW.md` does not overwrite it, and the dashboard shows the `WORKFLOW.md` value next to it. Lowering it below the running count stops no agent: nothing new starts until the count is below the limit ("3 running, limit 2: no new starts until 2 finish"). With `curl`: `PUT /api/v1/settings/agents` with `Content-Type: application/json`, see [Dashboard and API](#dashboard-and-api). The same rights as restart apply. See [Agent slots set on the dashboard](configuration.md#agent-slots-set-on-the-dashboard). |
| Change the prompt or settings | Edit `WORKFLOW.md`. This applies right away to new sessions, without a restart. |
| Restart a waiting or paused worker right away | On the issue card (or the agent page) click **Retry now** or **Resume now**, or `curl -X POST http://127.0.0.1:4000/api/v1/<identifier>/retry` (the identifier URL-encoded, e.g. `owner%2Frepository%2312`). This is the way out of a session limit when you have topped up credits and do not want to wait for the reset. On a non-loopback address (`SYMPHONY_HOST`) it only works with `SYMPHONY_ALLOW_REMOTE_CONTROL=true`; with `curl` through the proxy, pass `-H 'Origin: https://<domain>'`, see [Dashboard and API](#dashboard-and-api). |
| Start an issue now, even when every slot is taken | On a card in *Up next*, *Waiting* or *Paused* (or on the agent page) click **Start now**, or `curl -X POST http://127.0.0.1:4000/api/v1/<identifier>/force`. The issue starts at once in an extra slot, for one session; see [Retry now or Start now](#retry-now-or-start-now). The same rights as restart apply. |
| Pause an issue or a model | On a card in *Running*, *Up next* or *Waiting* (or on the agent page) click **Pause**: a running agent stops at once (the workspace stays), nothing is retried, and the card moves to *Paused* ("paused by operator"). **Resume now** starts it again like a restart. In the *Models* bar, **Pause** next to a model family (e.g. `fable`) stops its running agents and keeps every issue of that model waiting (reason `model_hold`), while the other models keep running; no issue moves to another model. **Resume** retries them at once, as slots allow. With `curl`: `POST /api/v1/<identifier>/pause` and `/resume`, `POST /api/v1/models/<model>/hold` and `/release`. Board changes (comments, labels, column moves, also to `Backlog` and back) do not lift these pauses; an issue reaching a terminal column or leaving the board does. Both survive a restart. The same rights as restart apply (`SYMPHONY_ALLOW_REMOTE_CONTROL` on a non-loopback address). |
| Poll now instead of waiting 30 s | In the dashboard click **Poll now**, or `curl -X POST http://127.0.0.1:4000/api/v1/refresh` |

If the `WORKFLOW.md` is invalid after a change, Symphony keeps running with the last valid version. It only starts
new agents again once the error is fixed. The message is in the log and in the dashboard.

## Failures and retries

If a run fails, Symphony tries again. Reasons can be a failed hook, an agent error, a timeout or a stalled session
(10 minutes without activity). The wait doubles each time: 10 s, 20 s, 40 s and so on, at most 10 minutes
(`agent.max_retry_backoff_ms`). The dashboard shows the issue card as *Retrying*, with the reason and the next attempt. On the next
attempt the agent knows from `attempt` that there is earlier work in the workspace. Symphony handles a reached
session limit separately, see [Session limit](#session-limit).

The **retry queue** and **Paused** are two different things: in the queue, Symphony has scheduled a next attempt
with a time for the issue (after a failure, a continuation or a session limit). *Paused* lists an issue that no time
is scheduled for: either the operator paused it (*paused by operator*, lifted only by **Resume now**, a terminal
column or leaving the board), or it is still active after `SYMPHONY_MAX_CONTINUATIONS` continuations (*paused after N
continuations*, lifted by any change on the board), see [Continuations and pausing](#continuations-and-pausing). An
issue whose model the operator paused is not under *Paused*: it waits in the retry queue (*Waiting*, reason
`model_hold`) until the model is resumed.

## Session limit

When your Claude subscription hits its usage limit (message `You've hit your session limit · resets 7:30pm`, the
5-hour window or a weekly limit), retrying after 10 seconds does not help. A limit applies either to the **whole
account** (session limit, weekly limit) or to **one model** (for example `You've reached your Fable limit. Switch to
another model to continue.`, or a weekly Opus or Sonnet limit). Model limits are described in
[Model limits](#model-limits). For an account-wide limit Symphony works in two stages:

1. **Retries:** Up to `SYMPHONY_MAX_SESSION_LIMIT_RETRIES` times (default 3), Symphony retries the issue after the
   first session-limit error, with the usual wait (10 s, 20 s, 40 s …).
2. **Waiting for the reset:** If the limit is still reached after that, the worker waits for the reset. `retry at`
   is the reset time plus 1 minute. With `0`, Symphony waits after the first error. After that it continues like a
   normal retry. If the card leaves the active columns or is closed in the meantime, Symphony releases the issue.

**Where you see it:**

- In the dashboard on the issue card: badge *Session limit*, window, reset time, `retry N of M` or
  *waiting for reset*, plus the original message. While waiting, the issue is not listed under *Paused*.
- On the agent page (`/agent?id=<identifier>`) as the notice *Session limit reached* with window, reset and retries.
  The run appears as `run_finished` with the result `session_limit` and as the event `session_limit_wait`.
- In `GET /api/v1/state` in the entry under `retrying[]`: `kind` is `session_limit`, and the field `limit` contains
  `window`, `resets_at`, `source`, `text`, `hits`, `max_retries`, `waiting`, `overage_disabled_reason` and
  `observed_at`. For other retries `limit` is `null`.
- In the [repository log](#logs-and-statistics) as `session_limit_wait`.

**How Symphony finds the reset:** First it takes the time from Claude Code's structured `rate_limit_event`
(`source` = `event`). If that is missing, it reads the time from the message (`source` = `message`, e.g.
`resets 7:30pm (Europe/Berlin)`). If the reset is unknown or more than 8 days ahead, the normal failure backoff
applies and the worker does not wait for a point in time.

**No new issues while waiting:** The 5-hour window (`five_hour`) and the weekly limit (`seven_day`) apply to the
whole account. While a worker waits for the reset of one of these limits, Symphony starts no new issues instead of
letting each of them run into the limit (each would create a workspace, fail right away and use up its own retries).
Running agents, retries and reconciliation with the board continue. The gate ends by itself when the wait ends (reset
reached, issue released, **Retry now**) or when a turn of any agent finishes successfully after the limit. If several
workers wait, the gate lasts until the latest time. The dashboard then shows the notice
*Dispatch paused until … · session limit (five_hour) · started by …*, and `GET /api/v1/state` the field
`health.dispatch_gate` (`reason`, `window`, `until`, `issue_identifier`, else `null`). Model limits, `overage` and
limits without a known window never close this gate.

### Model limits

A limit whose message names a model family (`fable`, `opus`, `sonnet`, `haiku`), or the structured windows
`seven_day_opus` and `seven_day_sonnet`, applies to that model only. Symphony then puts **the model on hold**:

- The issue that hit the limit leaves its agent slot and waits in the retry queue until the hold ends. There are no
  quick retries, because a model limit does not go away within seconds.
- No issue that would run on that model starts until the hold ends. Symphony resolves the model the same way as at
  dispatch: `Model: …` label, else the role's `claude.model`, else `claude.model`. Issues with the
  [Claude Code default model](configuration.md#claude) (no model configured) are never held.
- Issues on other models keep running and start as usual, in the same tick.
- **No fallback:** Symphony never moves an issue to another model. An issue labelled `Model: fable` runs on Fable or
  waits.
- The hold lasts until the reset plus 1 minute when the message names a reset, otherwise for `agent.model_hold_ms`
  (default 1 hour). Another limit of the same model while it is held extends the hold, it never shortens it.
- When the hold ends, the next issue of that model is the probe. If it hits the limit again, a new hold starts.
- **Retry now** on an issue that waits for a held model does not bypass the hold: the issue goes back into the queue
  until the hold ends.

The message wins over the event: the Agent SDK has no window for every model (there is no Fable window), so a model
limit can arrive with the window `seven_day`. A message like `You've hit your weekly Fable limit` is therefore a
Fable limit, and it does not stop the other models. Claude Code sometimes reports a limit as a successful turn whose
whole answer is the limit message; Symphony treats such a turn as a limit too (no continuation, and it does not count
as a successful turn). A normal answer that merely mentions a limit stays a normal answer.

**Where you see it:** the dashboard shows a notice per held model (model, end of the hold, original message), and
waiting cards say *Waiting for model fable (limit until …)*. `GET /api/v1/state` lists the holds under
`model_holds[]` (`model`, `source`, `since`, `until`, `text`, `issue_identifier`), and waiting issue rows carry
`model_hold` (`model`, `source`, `until`, else `null`). A model the operator paused from the dashboard has a hold with
`source: "operator"` and `until: null`; it may coexist with a limit hold, and the model is available only when
neither holds it. `model_controls[]` lists every model family in use with `paused` (by the operator) and
`limit_until`. The issue timeline and the [repository log](#logs-and-statistics) show
`model_hold` and `model_hold_ended`.

**Restart:** holds are stored in `<logDir>/state/<repositories>.json` (one file per instance, named after the
configured repositories, so several instances can share one log directory) and restored on start; holds that ended
in the meantime are dropped. Several Symphony instances on one subscription do not share holds: each one hits the
limit once and then holds the model.

**Limitations:**

- The wait for an account-wide limit is kept in memory only. If you restart Symphony, it is forgotten: the issue is
  fetched again like any active issue and starts, and if the limit is still active, the process starts over. Model
  holds survive a restart (see [Model limits](#model-limits)).
- Only session limits of a Claude subscription count. Rate limits (HTTP 429) of an `ANTHROPIC_API_KEY` remain
  ordinary failures with backoff.
- A model limit holds only the affected model. Issues with a different model keep running.
- **Retry now** (section [Intervening while Symphony runs](#intervening-while-symphony-runs)) ends the wait right
  away, for example after topping up credits (`overage_disabled_reason` = `out_of_credits`). The retry counter then
  starts over. If the limit is still active, the worker is back in waiting mode after a few failures.

## Dependencies and sub-issues

An issue waits as long as something it depends on is still open. It stays in `Ready`, and Symphony starts it
automatically as soon as everything is done. Three kinds of dependencies count:

| Kind | How to create it |
|---|---|
| Relationship | In the issue sidebar under **Relationships → Blocked by** |
| Text in the issue | In the description, e.g. `blocked by #12`, `blocked #12` or `Blocked by: #12, #13`. `#N` means the same repository, others are written as `owner/repo#N`. |
| Sub-issues | In the sidebar under **Sub-issues**. The parent issue waits until all sub-issues are closed. Exception: an issue whose description starts with a [command](#commands-in-the-issue-refactoring) does not wait, because for it the sub-issues are the result of the run. A role with `wait_for_sub_issues` (the [autopilot](#autopilot-auto-code)) still waits: it only starts again once its sub-issues are closed. |

The `/concept` and `/plan` agent commands set both types at the same time: the relationship (`blocked_by` on
`create_sub_issue`) and the line `Blocked by #N` in the text. Both count as one dependency.

A dependency is done when the issue is **closed**; for a referenced pull request, when it is merged or closed.
Agents do not close issues themselves. So a dependency resolves as soon as you merge the related pull request with
`Closes #N`. That way the next issue builds on merged code. References to issues that do not exist are ignored.
`npm run dry-run` shows why an issue waits. The agent sees parent, sub-issues and dependencies in the prompt.

## Commands in the issue (`/refactoring`)

A task that works the same in many repositories does not go into each repository, but once into Symphony as a skill
(`.claude/skills/`). An issue calls it with a command line: if the **first non-empty line** of the description is
`/<name>` (optionally with arguments), the agent loads the skill `symphony:<name>`. The issue text stays short, the
instructions live in the skill. Mechanics and selection rules:
[configuration.md](configuration.md#issue-commands).

Symphony ships five commands:

| Command | Purpose |
|---|---|
| `/refactoring [scope]` | Audit of a Laravel/Filament repository: context, baseline, bugs and refactoring candidates. The result is sub-issues. |
| `/refactor-safely` | Restructure without changing behavior, with tests as a safety net. Is the first line of every refactoring sub-issue. |
| `/auto-code [description] [wave=3] [checkpoint=5] [issue-models=auto]` | [Autopilot](#autopilot-auto-code): develops the repository continuously from its project description, in waves of sub-issues that are implemented right away. |
| `/concept <path> [issue-models=auto]` | [Concept to Backlog](#concept-to-backlog-concept): breaks down a concept (Markdown file) into epics and sub-issues with dependencies, as well as model and effort labels. Everything ends up in the backlog. |
| `/plan [<path>] [issue-models=auto]` | [List to Backlog](#list-to-backlog-plan): turns every item of a list (a file in the repository, or the issue description itself) into one sub-issue with a detailed implementation plan, dependencies and category, effort and model labels. Everything ends up in the backlog. |

### How the audit works

1. Create an issue in the target repository. Title e.g. "Refactoring audit", description just `/refactoring`, or
   with a scope `/refactoring app/Filament`.
2. Move it to **Ready**. The role `auditor` takes over (`fable`, read-only, no entry checks, budget from
   `roles.auditor.claude.max_budget_usd`).
3. The agent determines the context from `composer.lock` and `package.json` (PHP, Laravel, Filament, Livewire, Pest,
   Vite …), measures the baseline (tests, analysis, Pint, `composer audit`, `npm audit`, build) and analyzes with
   Laravel Boost (`search-docs` against the installed version, schema, routes). It **changes nothing**.
4. The findings become sub-issues of the audit issue, in the **Backlog** column (`tracker.provider.sub_issue_status`):
   first sub-issues for characterization tests, then refactorings (`/refactor-safely`, with `Blocked by #N` on the
   tests), then bugs (label `bug`, no command). Plus a report comment with context, baseline and checklist. The audit
   issue moves to **In review** and so becomes the epic.
5. You review the sub-issues, drop or extend them and move the ones to implement to **Ready**. The order follows from
   the dependencies ([above](#dependencies-and-sub-issues)): a refactoring waits until the test sub-issue is merged
   and closed.
6. A refactoring sub-issue takes the normal path developer → reviewer → In review. The developer first writes the
   tests that capture today's behavior and then changes no existing assertion. The reviewer checks the test diff and
   reports every behavior change as a blocker. Bugs are fixed by the normal developer flow, with a regression test
   that is red first and then green.

Sub-issues land in the backlog on purpose: an audit can produce 20 findings, and you decide which runs (and costs)
you start. To repeat an audit, move the epic to Ready again. The skill then continues instead of starting over: a
sub-issue with the same title is not created twice.

**Requirements.** The board needs the columns `Backlog` and `In review`. The target repository should have
`laravel/boost` as a dev dependency ([Laravel Boost](#laravel-boost)); without Boost the skill works with reduced
capability and notes that in the report. The token needs write access to issues and the project (classic: `repo` and
`project`).

**Limitations.** At most `roles.auditor.max_sub_issues` sub-issues are open at the same time (default 20); further
ones are listed in the report under "Not created". An unknown `/word` without a skill is an ordinary
issue. A command further down in the description does not count.

### Custom commands

1. Create `.claude/skills/<name>/SKILL.md` in the Symphony repository ([rules](../.claude/README.md)). The
   `description` should say that the skill is only loaded when the prompt asks for it.
2. A command without its own role runs in the role of the column (developer or reviewer) and only loads the skill.
   If it needs its own permissions or tools (read-only, create sub-issues, no checks), add a role with
   `commands: [<name>]` in `WORKFLOW.md` and a branch in the prompt (`{% when "<role>" %}`).
3. Check with `npm run dry-run`: the issue shows the role and `↳ command /<name> → symphony:<name>`. If the skill is
   missing, dispatch validation reports `no skill for /<name> in claude.plugins`.

## Autopilot (`/auto-code`)

With `/auto-code` Symphony develops a repository on its own. The only brief is the project description in the
repository. From it the agent plans new features, design, quality and maintenance tasks, implements them and then
plans the next ones. This continues until you stop the epic.

The work runs in **waves**:

```
Epic "/auto-code docs/index.md" → Ready
  → autopilot (fable, read-only): reads project description, roadmap, code on develop and your comments on the epic
  → wave N: 3 sub-issues directly in Ready (labels auto-code, category, effort), report on the epic
  → the epic stays "In progress" and waits until all sub-issues of the wave are closed
       per sub-issue: developer → PR into develop → entry checks → reviewer → "In review"
                      → Symphony merges the PR into develop, closes the issue, sets it to Done
  → the autopilot starts again → wave N+1
  → after wave 5, 10, …: checkpoint report and release PR develop → main, the epic moves to "In review"
```

The autopilot's instructions are in the skill [`auto-code`](../.claude/skills/auto-code/SKILL.md). It only picks ideas
that relate to the project description and are backed by the code, follows mixing rules (at most one maintenance
issue per wave, regular quality work, no repeated redesigns of the same page) and would rather pause than deliver
busywork ([criteria](../.claude/skills/auto-code/ideation.md)).

### Setup

1. **Project description:** The target repository needs a description with a clear goal, e.g. `docs/index.md`.
   The autopilot works through a roadmap (`docs/todo.md`) first. A section "Guardrails for the autopilot"
   with non-goals, priorities and design principles is strongly recommended
   ([template](../.claude/skills/auto-code/vision-template.md)).
2. **Integration branch:** create and push `develop` from `main` (`git switch -c develop main && git push -u origin develop`).
3. **Instance env:** `SYMPHONY_BASE_BRANCH=develop` (agents clone, branch and open PRs against `develop`) and
   `SYMPHONY_AUTO_MERGE=true` (Symphony merges approved PRs into `develop`). Then restart Symphony.
4. **Labels:** `npm run repo-init` → *Standard labels* creates `auto-code`, `feature`, `design`, `quality`,
   `maintenance` and `manual-merge`, See also `concept` and `epic`.
5. **Epic:** an issue, e.g. "Autopilot", with the description `/auto-code docs/index.md` (optionally `wave=3
   checkpoint=5 issue-models=auto`), moved to **Ready**. Text below the command line counts as part of the brief (e.g. focus areas).

Check with `npm run dry-run`: the epic appears with `role=autopilot` and `↳ command /auto-code → symphony:auto-code`,
during a wave with `waiting for sub-issues …`.

### Model per sub-issue (`issue-models`)

Without this argument, sub-issues run with the model from `CLAUDE_MODEL`. With the argument `issue-models`, the
autopilot sets a [model label](#choosing-the-model-per-issue) when it creates them:

| Argument | Effect |
|---|---|
| (missing) or `issue-models=off` | no model labels, `CLAUDE_MODEL` applies |
| `issue-models=fable`, `opus`, `sonnet` or `haiku` | all sub-issues get `Model: <value>` |
| `issue-models=auto` | the autopilot picks per issue by effort and risk: `Model: haiku` for small, low-risk changes, `Model: sonnet` as the normal case, `Model: opus` for wide reach with medium risk, `Model: fable` for complex issues (high risk, major upgrades, tricky dependencies) |

The label applies to the developer and reviewer of the sub-issue. The autopilot states the label and the reason per
issue in the wave report. The labels `Model: fable|opus|sonnet|haiku` must exist in the repository (`npm run repo-init` →
*Standard labels*); if one is missing, the autopilot reports it and the issue runs with `CLAUDE_MODEL`. The argument
applies to every wave of the epic; to change it, edit the command line in the description.

### Steering and stopping

| You want to | How |
|---|---|
| get something specific next | Comment on the epic, e.g. "Next: PDF export of the invoice". The autopilot gives requests priority and says in the report what it did with them. |
| reject an idea | Close the sub-issue as **not planned**. The autopilot never suggests it again, not even reworded. |
| merge a PR yourself | Label `manual-merge` on the issue or PR. Symphony leaves it in "In review". Major upgrades get it automatically. |
| continue at a checkpoint | Review and merge the release PR (or not), answer questions on the epic, move the epic back to **Ready**. |
| pause | Move the epic to **Backlog**. Running sub-issues finish. Moving it back to **Ready** continues. |
| end | Move the epic to **Done**. |

An early checkpoint comes when you reject two or more sub-issues in one wave: then the direction is off. If the
autopilot finds nothing more that meets the criteria, it writes "Auto-Code Pause" and moves to "In review".

### Auto-merge into develop

`tracker.provider.auto_merge` merges as soon as the reviewer moves an issue to `on_enter` (here "In review"), so
after a passed agent review **and** passed entry checks:

- only pull requests from the issue branch (`symphony/issue-N` or the linked branch) into `base_branch`, never into
  the default branch, no drafts, nothing with the label `manual-merge`;
- squash merge of the reviewed commit (`expectedHeadOid`), then Symphony closes the issue (GitHub does not do that
  for merges into a branch other than the default branch) and sets it to **Done**;
- on a merge conflict the issue goes back to **In progress**, with a comment for the developer;
- without a pull request nothing happens (as with the handoff of auditor, analyst and planner); drafts, `manual-merge` and a
  failure stay in "In review" and get a comment with the reason.

Auto-merge applies to all issues of the instance, not only to those of the autopilot. Your own issues are therefore
also merged into `develop`. Only what you take over in a release PR reaches `main`.

### Limits and costs

- An epic holds at most 100 sub-issues (GitHub). From 80 on the autopilot writes a handoff; then create a new epic
  and copy the section below the command line.
- The wave is only done when **all** of its sub-issues are closed. A sub-issue in "Blocked" stops the autopilot
  until you resolve or close it.
- Costs: per wave one autopilot run (`roles.autopilot.claude.max_budget_usd`, default $10) plus developer and reviewer
  runs per sub-issue. Ways to slow it down: smaller waves (`wave=2`), more frequent checkpoints, few parallel agents,
  a cheaper model for implementation (`CLAUDE_MODEL=sonnet`).
- The autopilot does not see the UI. It therefore writes design issues with concrete, testable criteria.

## Concept to Backlog (`/concept`)

`/concept <path>` turns a concept into a work plan on the board. You write the concept as a Markdown file in the
repository (e.g. `docs/index.md`), create an issue with the description `/concept docs/index.md` and move it to
**Ready**. The `analyst` role (`fable`, read-only, no entry checks) reads the concept, checks what the code can already
do, and creates two levels of issues:

```
#10 /concept docs/index.md                      → In review once the plan is in place
├─ #11 Epic: User management                    Backlog · labels epic, concept
│  ├─ #13 Feature: Sign-in                      Backlog · concept, feature, Effort: high, Model: sonnet
│  └─ #14 Feature: Roles and permissions        Backlog · … Effort: xhigh, Model: fable · blocked by #13
└─ #12 Epic: Billing                            Backlog
   └─ #15 Feature: Create invoice               Backlog · … blocked by #14
```

Every issue gets acceptance criteria, the reference to the concept section, tests, **dependencies** (GitHub
relationship and a `Blocked by #N` line), a category (`feature`, `design`, `quality`, `maintenance`), exactly one
`Effort: …` label and one `Model: …` label. All of them land in **Backlog** (`tracker.provider.sub_issue_status`); they
only start when you move them to **Ready**. The instructions are in the skill
[`concept`](../.claude/skills/concept/SKILL.md), the breakdown rules in
[breakdown.md](../.claude/skills/concept/breakdown.md).

### Setup

1. **Concept:** a Markdown file on the base branch (`SYMPHONY_BASE_BRANCH`, otherwise the default branch), because
   that is what the agent clones. It also reads relatively linked `.md` files one level deep. Goal, roles, functional
   areas, flows, non-goals and open questions make a good concept.
2. **Labels:** `npm run repo-init` → *Standard labels* creates `concept`, `epic`, the `Model: …` and `Effort: …` labels
   and the categories. If a label is missing, the agent creates the issue without it and says so in the report.
3. **Issue:** description `/concept docs/index.md`, optionally `issue-models=auto|fable|opus|sonnet|haiku|off` (default
   `auto`) and below it text with focus areas or exclusions. Then move it to **Ready**.

Check with `npm run dry-run`: the issue shows up with `role=analyst` and `↳ command /concept → symphony:concept`.

### How a run works

1. The agent reads the concept and the state of the repository and classifies every area (present, partial, missing).
2. It cuts epics (2 to 10 issues, functionally self-contained) and issues (mergeable on their own, size S or M) and
   orders them by their dependencies. Every requirement of the concept ends up in an issue or under "Not created";
   gaps become questions, not invented issues.
3. It posts the comment **`## Concept Plan`** **before** it creates anything: tree, labels, order and a coverage list.
4. It creates epics and issues, blockers first. An epic is created when its first issue is due.
5. It posts **`## Concept Report`** with the tree including issue numbers, the reason for model and effort per issue,
   "Not created", open questions and notes. The concept issue moves to **In review**.

The two comment headings are always English, whatever the language of the concept, because later runs search for them.
Concept issues started before the skill was translated may carry `## Konzept-Plan` and `## Konzept-Bericht`; the agent
treats them as equivalent.

The labels follow size and risk ([tables](../.claude/skills/concept/breakdown.md#labels)): `Effort: low` for texts and
configuration, `medium` for small, `high` for medium-sized tasks, `xhigh` for data model, permissions, money or
migrations. The agent never assigns `Effort: max`. With `issue-models=auto` it picks `Model: haiku`, `sonnet`, `opus` or `fable`;
a fixed value puts the same model on all issues, `off` leaves the model labels out.

### Afterwards

| You want to | How |
|---|---|
| have an issue implemented | Move the issue from **Backlog** to **Ready**. If it has open blockers, it waits there and starts as soon as they are closed (pull request merged). |
| drop or change an issue | Close or edit it in the backlog before it goes to Ready. |
| extend the concept | Change the concept and commit it (to the base branch), put requests as a comment on the concept issue, move the issue back to **Ready**. The agent writes an **addendum** and creates only what is missing from the report. |
| recover from an abort | If a run aborts, Symphony continues it (or you move the issue back to **Ready**). The agent takes over the plan comment and creates only what is missing, without duplicates: the same title under the same epic returns the existing issue. |

**Do not move the epics to Ready**: they are containers. An epic with open sub-issues is not started anyway. Close it
by hand when all sub-issues are done.

### Limits

- At most `roles.analyst.max_sub_issues` (default 60) open issues at once; epics count, and so do the issues inside
  them. What no longer fits is listed in the report under "Not created". Once issues are done and closed, an addendum
  picks up the rest.
- Dependencies never point at an epic but at concrete issues, also across epics, never in a cycle.
- The agent changes nothing in the repository and does not see the UI; design issues therefore get concrete criteria.
- Costs: one run per concept and addendum (`roles.analyst.claude.max_budget_usd`, default $20), plus later the runs of
  the issues you release.

## List to Backlog (`/plan`)

`/plan` turns a list into planned issues: **every item becomes exactly one sub-issue** with a detailed implementation
plan. Unlike [`/concept`](#concept-to-backlog-concept) it does not cut the work itself and creates no epics: the list
is the cut. The `planner` role (`fable`, read-only, no entry checks) reads the list, looks up where each item lands in
the code and files the issues directly below the plan issue:

```
#20 /plan docs/todo.md                          → In review once the issues are in place
├─ #21 Feature: Export invoices as CSV           Backlog · plan, feature, Effort: high, Model: sonnet
├─ #22 Design: Dark mode for the admin panel     Backlog · plan, design, Effort: medium, Model: sonnet
└─ #23 Quality: Policy tests for invoices        Backlog · plan, quality, Effort: medium, Model: haiku · blocked by #21
```

The list comes from one of two places:

| Description | Source |
|---|---|
| `/plan docs/todo.md` | **File mode:** the file on the base branch (`SYMPHONY_BASE_BRANCH`, otherwise the default branch). An argument counts as a path when it contains `/` or ends in `.md` or `.txt`; if the file is missing, the issue moves to **Blocked**. Text below the command line narrows the brief ("only the section *Billing*"). |
| `/plan` followed by a list | **Description mode:** the list below the command line in the issue itself. Free text after `/plan` (`/plan Sprint 12`) is only its heading. |

An item is every top-level list entry (`-`, `*`, `1.`, `- [ ]`); indented entries and the text below an entry are its
details. Ticked entries (`- [x]`) count as done and become no issue. Example of description mode:

```
/plan issue-models=auto

- Export invoices as CSV (filtered like the table)
- Dark mode for the admin panel
- Policy tests for invoices
  - only accountants may delete
```

Every issue carries the quoted item, the starting point in the code (`file:line`), a numbered **implementation plan**,
acceptance criteria, tests, risks and what it does not include, plus the labels: `plan`, a category (`feature`,
`design`, `quality`, `maintenance`), exactly one `Effort: …` by size and risk and, unless `issue-models=off`, one
`Model: …` ([tables](../.claude/skills/plan/labels.md)). If one item needs another, it gets a dependency (GitHub
relationship and a `Blocked by #N` line). The instructions are in the skill [`plan`](../.claude/skills/plan/SKILL.md).

### Setup

1. **Labels:** `npm run repo-init` → *Standard labels* creates `plan`, the categories and the `Model: …` and
   `Effort: …` labels. If a label is missing, the agent creates the issue without it and says so in the report.
2. **Issue:** description `/plan <path>` or `/plan` with the list below it, optionally
   `issue-models=auto|fable|opus|sonnet|haiku|off` (default `auto`). Then move it to **Ready**.

Check with `npm run dry-run`: the issue shows up with `role=planner` and `↳ command /plan → symphony:plan`.

### How a run works

1. The agent reads the list, numbers the items and checks per item what the code already has: **present** items
   become no issue, **partial** ones an issue for the missing rest.
2. It plans every item on its own, without splitting or merging items. An item too vague to plan becomes a question
   in the report instead of an issue; an item of size L stays one issue with `Effort: xhigh` and a note that it should
   be split before **Ready**.
3. It posts **`## Plan Outline`** **before** it creates anything: items, labels, dependencies, order and coverage.
4. It creates the issues, blockers first.
5. It posts **`## Plan Report`** with the issue numbers, the reason for model and effort per issue, "Not created",
   open questions and notes. The plan issue moves to **In review**.

The two comment headings are always English, whatever the language of the list, because later runs search for them.

### Afterwards

| You want to | How |
|---|---|
| have an issue implemented | Move it from **Backlog** to **Ready**. With open blockers it waits there until they are closed. |
| drop or change an issue | Close or edit it in the backlog before it goes to Ready. |
| extend the list | Add items to the file (commit it to the base branch) or to the description, or comment on the plan issue, then move it back to **Ready**. The agent writes an **addendum** and creates only what is missing from the report. |
| recover from an abort | Symphony continues the run (or you move the issue back to **Ready**). The agent takes over the outline and creates only what is missing: the same title under the plan issue returns the existing issue. |

### Limits

- At most `roles.planner.max_sub_issues` (default 30, `SYMPHONY_PLANNER_MAX_SUB_ISSUES`) open issues at once; the rest
  is listed under "Not created" and picked up by an addendum once issues are closed. GitHub allows 100 sub-issues per
  issue.
- The agent changes nothing in the repository and does not see the UI; design issues therefore get concrete criteria.
- Costs: one run per list and addendum (`roles.planner.claude.max_budget_usd`, default $20), plus later the runs of the
  issues you release.

> **Renamed role.** Up to this version the `/auto-code` role was called `planner`. It is now `autopilot`, and its
> limit is `SYMPHONY_AUTOPILOT_MAX_SUB_ISSUES`. An `.env` that still sets `SYMPHONY_PLANNER_MAX_SUB_ISSUES` now limits
> `/plan` instead.

## Continuations and pausing

If a session ends normally but the issue is still in an active column, Symphony starts a **continuation session**
after one second. The agent was not finished then, for example because `max_turns` was reached. So that an issue
does not use sessions endlessly, `SYMPHONY_MAX_CONTINUATIONS` limits these continuations. Every role change
(developer → reviewer and back) also starts a continuation session. With the value `6`, an issue gets at most seven
sessions: the first one and six continuations. If it is still active after that, it is **paused**:

- It stays reserved for Symphony, but no agent starts for it anymore. The log shows the warning `issue paused`, and
  the dashboard shows the issue card as *Paused*.
- It continues by itself as soon as something changes on the board: a comment from you (e.g. a hint for the agent),
  a changed label, an edited description or another column. Then a fresh session starts that reads your comment.
- If you move the card to a non-active column, the pause is lifted without starting anything.
- If you raise or remove the limit (`agent.max_continuations`, e.g. via `SYMPHONY_MAX_CONTINUATIONS` in the `.env`
  with a restart, or directly in the `WORKFLOW.md`), the pause is lifted as well.
- **Resume now** in the dashboard or `POST /api/v1/<identifier>/retry` (see
  [Intervening while Symphony runs](#intervening-while-symphony-runs)) resumes a paused issue right away. The
  continuation counter then starts over, and the next run is a normal attempt that `max_continuations` does not
  pause again immediately.

In detail: on every tick `#reconcile` re-reads all paused issues from the board. It lifts the pause when their column
or their `updated_at` has changed, or when `agent.max_continuations` was raised or removed. The issue is then a normal
candidate again. There is no timer: without a change, a raised limit or a click, the issue stays paused, even for
hours. A worker that waits because of a session limit is in the retry queue, not under *Paused*; see
[Session limit](#session-limit). Pressing **Pause** on such an issue turns it into an operator pause, which board
changes no longer lift (see [Intervening while Symphony runs](#intervening-while-symphony-runs)).

Failed runs do not count here. The retries with backoff described above apply to them.

### Cost budget per issue

`agent.max_issue_cost_usd` caps the cost of one issue across all its stages (runs of every role, failed ones included).
Unset means unlimited; `claude.max_budget_usd` and `roles.<name>.claude.max_budget_usd` still cap each session.

- Before every dispatch (a new stage, a continuation, a retry) Symphony adds up the issue's `run_finished` costs in the
  repository history, plus a run that is still going. Once the sum reaches the cap, the next stage does not start. A
  stage that is running is never stopped; it may overshoot the cap.
- The issue is **paused** (`source=budget`): one comment on the issue says what was spent and how to go on, the timeline
  shows `issue_paused` with the cost, and the repository log gets an `issue_paused` line with `source=budget`.
- The figure comes from the history log, so the cap also holds after a Symphony restart. It uses the prices of
  `model-costs.yml` at the time each run was written. Without a history log, only a running run counts.
- Board changes (status, comments, labels) do **not** lift this pause. It ends when you raise or remove
  `agent.max_issue_cost_usd` (the issue resumes on the next tick), with **Resume now** or `POST /api/v1/<identifier>/retry`
  while the cost is below the cap (otherwise it pauses again, without a second comment), with **Start now** (a one-off
  override of the cap, the session runs in an extra slot), or when the issue reaches a terminal state or leaves the board.

## Choosing the model per issue

Every session uses the model from `CLAUDE_MODEL`, unless the issue has a label `Model: …`. Then the model from the
label applies to that issue:

| Label | Model for Claude Code |
|---|---|
| `Model: fable`, `Model: claude-fable` | `fable`, always the latest Fable model |
| `Model: claude-fable-5-1` | `claude-fable-5-1` |
| `Model: opus`, `Model: claude-opus` | `opus`, always the latest Opus model |
| `Model: claude-opus-5-5` | `claude-opus-5-5` |
| `Model: sonnet`, `Model: claude-sonnet` | `sonnet`, always the latest Sonnet model |
| `Model: sonnet-5-5`, `Model: claude-sonnet-5-5` | `claude-sonnet-5-5` |
| `Model: haiku` | `haiku`, always the latest Haiku model |

- `repo-init` only creates `Model: fable`, `Model: opus`, `Model: sonnet` and `Model: haiku`. Create the other labels from the table
  yourself in GitHub if you need them.
- Case does not matter. The `claude-` prefix is optional; Symphony adds it for values with a version. This also works
  for models without a standard label, e.g. `Model: claude-opus-4-8`.
- Without a model label, `CLAUDE_MODEL` applies. The same is true for an unknown value (e.g. `Model: gpt-4`) or for
  several labels with different models. Symphony then writes the warning `model label ignored` to the log and the
  dry run.
- The model applies to a whole session. If you change the label while an agent runs, the new model applies from the
  next session, i.e. the next continuation or retry. A paused issue continues after a label change, right away with
  the new model. This way you can retry a stuck issue with `Model: opus`, for example.
- Verification: `npm run dry-run` shows `↳ role …, model …` per issue (`default` without roles) and, with a label, `↳ model … (label "…")`. At start, the model is in the log line
  `dispatching issue` (`model=…`, with a label also `model_label=…`) and in the repository log at `run_started`.
  The dashboard shows the model Claude Code actually uses in the card’s *Model* field.
- In the prompt, the model labels are left out of the agent's label list. They do not matter for its work.
- You choose the thinking effort the same way, see [Choosing the effort per issue](#choosing-the-effort-per-issue).
- Do not confuse this with `claude.fallback_model` in the `WORKFLOW.md`: that is a fallback model in case the model
  is overloaded. If a label selects exactly that model, Symphony omits the fallback model for that session.

## Choosing the effort per issue

The effort controls how much Claude thinks and how thoroughly it works. It mainly affects cost, run time and quota:
`low` or `medium` are enough for small tasks (typos, docs, a config value), `xhigh` or `max` give a tricky issue more
room without changing the model. Every session uses the effort from `CLAUDE_EFFORT`, unless the issue has a label
`Effort: …`. Then the effort from the label applies to that issue:

| Label | Effort for Claude Code |
|---|---|
| `Effort: low` | `low` |
| `Effort: medium` | `medium` |
| `Effort: high` | `high` |
| `Effort: xhigh` | `xhigh` |
| `Effort: max` | `max` |

- `repo-init` creates all five labels, together with the model labels.
- Case does not matter. Other values (e.g. `Effort: hi`) are unknown.
- Precedence: `Effort:` label over the role's `effort` (`roles.<role>.claude.effort`) over `CLAUDE_EFFORT` (that is,
  `claude.effort` in the `WORKFLOW.md`). If none of these is set, Claude Code's default applies.
- For an unknown value or several labels with different levels, the effort without the label applies. Symphony then
  writes the warning `effort label ignored` to the log and the dry run.
- The effort applies to a whole session, just like the model: a label change takes effect from the next session.
- If a model does not support a level (e.g. Haiku), Claude Code lowers it by itself. Symphony does not check this.
- Verification: `npm run dry-run` shows `↳ role …, model …, effort …` per issue and, with a label,
  `↳ effort … (label "…")`. At start, the effort is in the log line `dispatching issue` (`effort=…`, with a label
  also `effort_label=…`) and in the repository log at `run_started` (`effort=…`, `default` without effort). The
  agent page shows it in the session start line.
- In the prompt, the effort and model labels are left out of the agent's label list (filter `without_agent_labels`).

## Setting up repositories (`repo-init`)

`repo-init` sets up the repositories from `GITHUB_REPOSITORY` interactively. There are two steps: the standard
labels (model, effort and the labels of the [autopilot](#autopilot-auto-code)) and an issue that introduces Laravel
Boost. Further steps are added as entries in the same selection list.

```bash
npm run repo-init                            # or ./repo-init.ts
npm run repo-init -- --env-file .env.website # different env file, as with npm start
```

1. With several repositories, you choose which ones to set up. Enter means: all.
2. In the selection list you choose the step, e.g. `1) Standard labels`. `0` exits the script.
3. **Standard labels:** For each repository the script shows which labels it would create (`+`) or change (`~`),
   and asks before each change. It only updates existing labels with a different color or description, or archived
   labels, if you agree. It deletes nothing. A second run reports
   `All standard labels are up to date.`
4. **Laravel Boost:** The script looks for Laravel apps on the default branch (root or one level down). For each
   repository it reports `– no Laravel app`, `✓ Laravel Boost installed`, `= open issue #N` or
   `+ create issue "Set up Laravel Boost"`. After you confirm, it creates the issue: it describes
   `composer require laravel/boost --dev`, `boost:install`, the `.gitignore` entries and the `.ai/` folder. Drag the
   issue onto the board, and an agent introduces Boost via a pull request.

The script uses `GITHUB_REPOSITORY` and `GITHUB_TOKEN` from the `.env`. A classic token needs the `repo` scope, which
the Symphony token already has. A fine-grained token needs *Issues: Read and write* and *Contents: Read* for the
repositories. The standard labels are in `src/repo-init/labels.ts`, the Boost step in
`src/repo-init/laravel-boost.ts`; new setup steps are added in `src/repo-init/tasks.ts`.

## Testing the orchestration (E2E)

`npm run e2e` tests the orchestration on a real board. The script creates nine test issues with dependencies, all
with `Model: sonnet`. The agents only comment. It then starts its own Symphony instance and plays the reviewer: it
sets issues in `In review` to `Done` after 60 s and closes them. At the end it checks that never more than
`max_concurrent_agents` agents ran at the same time and that no issue started before its dependencies were closed.

`npm run e2e -- --scenario roles` instead tests the role flow developer → checks → reviewer → handoff: it generates a
workflow with the roles `developer` and `reviewer`, creates three test issues and checks their status history, the
lines `transition_denied`, `checks_finished` and `handed_off` in the repository log, and the limit for
`Agent review`. For this the board also needs the columns `Agent review` and `Blocked`.

```bash
npm run e2e                                  # uses WORKFLOW.md and .env, like npm start
npm run e2e -- --scenario roles              # role flow with a generated workflow
node scripts/e2e/verify.ts logs/e2e/<time>   # check a run again later
```

Use a separate test repository with its own board: the issues are real, and every run costs Claude usage (about
USD 0.50). The script aborts if the board already has issues in active columns. Scenario, options and checks are
described in [docs/e2e.md](e2e.md).

## Dispatch order

One function, the **dispatch plan** (`src/orchestrator/dispatch-plan.ts`), decides what starts next. The poll, the
retry timers, `--dry-run` and the dashboard all read it, so the order shown is the order used.

1. **Continuations** (a session ended cleanly and the issue stays active). A continuation keeps the slot its session
   left: no new card takes it in the second before the continuation starts.
2. **Due retries** (failures and session limits past their backoff, and retries that already waited for a slot).
3. **New candidates** from the board.

Inside each group the order is priority (Priority field 1–4, others last), then the oldest issue, then the identifier.
Free slots go down this list; an issue that waits for something else (a model hold, a column limit, open
sub-issues, a slot reserved for another role) takes no slot, the next one gets it. A retry in its backoff holds no slot. This puts finishing work ahead
of starting new work: while continuations run, new cards wait longer.

### Example: 3 slots with a developer and a reviewer slot

With `max_concurrent_agents: 3`, `max_concurrent_agents_by_state: { "Agent review": 1 }` and
`reserved_slots_by_role: { developer: 1, reviewer: 1 }` (see [Reserved slots](configuration.md#reserved-slots)):

1. Five issues in `Ready`, none in `Agent review`: two developers start. The third slot stays free; the other three
   issues wait with `the free slot is reserved for reviewer`. The slot bar reads
   `02 / 03 agents · developer 1/1 · reviewer 0/1 reserved · 0 free`.
2. An issue reaches `Agent review` while both developers run (moved by a human, or by a developer whose session then
   ends): its reviewer starts at the next tick in the reserved slot. Running developers are never stopped for it, and
   a slot a developer leaves goes to the next issue in `Ready`, so two developers and one reviewer run side by side.
3. A second issue reaches `Agent review` while the first is reviewed: it waits with `Agent review limit 1/1`, the column
   limit still applies.
4. A `/plan` issue in `Ready` runs as the planner, its own role: it never takes the developer's or the reviewer's
   reserved slot, only a slot that is free beyond the unused reservations.

Every issue in the plan carries a reason (`reason.code` and a text; times in the text are UTC):

| Code | Meaning | Example text |
|---|---|---|
| `ready` | starts now or at the next poll | `starts at the next poll`, `continues its session`, `retry 2 starts now` |
| `no_free_slot` | all `agent.max_concurrent_agents` slots are busy | `waiting for a free slot (3/3 busy)` |
| `column_limit` | `agent.max_concurrent_agents_by_state` of its column is reached | `Agent review limit 1/1` |
| `reserved_for_role` | the free slots are kept for other roles by `agent.reserved_slots_by_role` | `the free slot is reserved for reviewer`, `the 2 free slots are reserved for developer, reviewer` |
| `model_hold` | its model is on hold after a model limit | `model fable on hold until 2026-10-03 18:00 UTC` |
| `waiting_for_sub_issues` | its role has `wait_for_sub_issues` and sub-issues are open | `waiting for sub-issues owner/repo#7` |
| `session_limit` | a session-limit retry, or new sessions held back by the dispatch gate | `session limit (five hour): retry after the reset at …`, `new sessions paused until …` |
| `backoff` | a failure retry before its due time | `retry 2 after a failure at …` |
| `inactive` | a claimed issue left the active columns; its claim is released at the next check | `left the active columns ("In review"); released at …` |
| `paused` | paused after `agent.max_continuations`, or at `agent.max_issue_cost_usd` | `paused after 3 continuation sessions; change the issue on the board to resume`, `paused: cost budget used up ($5.00 of $4.00); raise agent.max_issue_cost_usd or press Resume` |
| `blocked` | not dispatchable (assignee, open *blocked by*) | the adapter's note, e.g. `blocked by owner/repo#9` |
| `missing_label` | lacks a label of `tracker.required_labels` | `missing required label ai` |

## Dashboard and API

The dashboard only runs if `SYMPHONY_PORT` is set or you call `npm start -- --port 4000`. It listens on the address
from `SYMPHONY_HOST`, by default only on `127.0.0.1`. The header shows system status, workflow version, poll interval
and last poll. Below, the issues in an active column appear in separate sections, each with a count; empty
sections are hidden:

- **Running**: one card per agent session, with the slot bar (busy and free slots).
- **Up next**: numbered in the order Symphony starts them (`#1` takes the next free slot), with the board's age
  (`board as of …`). Each card shows a reason chip (`waiting for a free slot`, `Agent review limit 1/1`,
  `model fable on hold until …`), the priority and the model the session would use. Continuations and retries
  that are due stand here too, ahead of new cards.
- **Waiting**: retries before their due time (backoff, session limits, model holds), soonest first, with the due
  time and **Retry now**.
- **Paused**: issues held after `agent.max_continuations` or at `agent.max_issue_cost_usd` ([cost budget](#cost-budget-per-issue)), with **Resume now**.

See [Dispatch order](#dispatch-order) for the order and the reasons. Each card carries a **pipeline strip**: every station the
issue passes on its way across the board (the agent roles from the workflow, hand-off columns such as *In review*,
and *Done*), with finished stations checked in green, the current one pulsing in the card's status color and the
connector into it animated, and later ones dimmed. Hovering a station lists its sessions (outcome, model, start
time). Running cards additionally show model, phase, last activity, turns, run time, tokens and estimated cost;
retrying and paused cards show the reason, the countdown and the **Retry now** / **Resume now** button. If the agent
works on a Laravel project, the card shows the **Laravel Boost icon**: in color if Boost is ready for the session,
with the number of Boost calls so far (MCP tools and skills); gray with ✕ if Boost is missing or could not be
prepared. The tooltip names status, reason and the tools and skills used. Below follow an activity stream (changes
between polls, the agents' latest events and entries from the repository logs) and a collapsed **Blocked** panel:
issues in the shared blocked column, issues held back by open *blocked by* dependencies and issues without a label
of `tracker.required_labels`, each with the reason and its blockers; the panel remembers whether you opened it. Problems such as configuration or GitHub errors appear at
the top. The **Logs** button opens the log entries in a sidebar with filters by repository, severity and text; from
there (or by middle-clicking the button) a link leads to the full [logs page](#logs-and-statistics).

### Agent detail view (execution trace)

Clicking an issue card opens `/agent?id=<identifier>`, the issue's run as an execution trace. At the top are state
(Running, Retrying, Paused, Completed, Failed …), issue, repository, role, model, phase, run time, turn, tokens and
cost. Below the header, the **Pipeline** section shows the same topology as the dashboard card in full size, plus
one row per agent station with its runs (count, last outcome, model, effort, times). Errors and retries appear as a
banner with the reason, the failed tool and the next attempt; *View details* jumps to the spot in the timeline.

The **timeline** shows all sessions of the issue since the claim in chronological order: lifecycle (session started,
finished, retry scheduled, paused), phase changes, prompts, model calls (model, tokens, estimated cost, time since
the previous step), responses, thinking and tool calls with arguments, result, status and duration. Filters
(lifecycle, phases, model, tools, errors) and a search narrow it down. Prompts, responses and tool data are collapsed
and only rendered when expanded; errors are always visible in the entry. Next to the timeline, lifecycle, token usage
(with a small chart per model call), cost per model, sessions and run context (workspace, branch, commit, last entry
check) summarize the state. For Laravel projects the **Laravel Boost** section sits above it: whether the agent used
Boost (e.g. *The agent used Laravel Boost in this session: 3 MCP tool calls and 1 skill loaded*), which Boost tools
and skills how often, and what Boost provided: versions, guidelines (from which file, and whether Claude Code loads
them itself or they are in the system prompt), the skills and how many of them Claude Code actually loaded, the MCP
server with its allowed tools, and warnings if `boost:install` did not write guidelines or skills. Boost calls carry the Boost icon in the timeline. *Show raw logs* opens all events as a terminal log with
a severity filter. The page refreshes every 2 s and appends new entries without losing the scroll position.

Where the data comes from and where the limits are:

- Prompts, full responses, tool arguments and results, and tokens per model call come from the
  [session transcript](#logs-transcripts-and-workspaces). Without a log directory the timeline only shows the agent
  events (shortened texts).
- Claude Code reports the session's tokens and cost at the end of each turn; Symphony prices the values per model call
  with the same `model-costs.yml`.
- Symphony keeps at most the last 2,000 events of a claim. When the issue is released (moved to `Done` or out of
  the active columns, or at shutdown) the details are archived: timeline, sessions with their transcripts, the
  trace of the last run and the last entry check. The page then shows them with the state *Finished* and a note;
  the **Detail** button on the [logs page](#logs-and-statistics) leads there too. The archive is kept in memory
  (the last 200 issues) and, with a log directory, as one JSON file per issue under
  `~/.local/state/symphony/issues/`, so it survives a restart; a snapshot is written whenever a run ends. A new
  claim of the same issue starts a fresh timeline. The figures of every finished run are also in the
  [repository logs](#logs-and-statistics).

| Endpoint | Content |
|---|---|
| `GET /` | Dashboard |
| `GET /agent?id=<identifier>` | Agent detail view (execution trace) |
| `GET /logs` | Statistics and analytics page; filters in the URL: `?period=30d` (`today`, `yesterday`, `7d`, `14d`, `30d`, `90d`, `month`, `last_month`, `all` or `custom&from=YYYY-MM-DD&to=YYYY-MM-DD`), `&repo=owner/name`, `&model=<id>`, `&effort=<level>` |
| `GET /api/v1/history` | Overall statistics as JSON (no time range), optionally with `?repo=owner/name`; feeds the logs drawer in the dashboard |
| `GET /api/v1/history/analytics?from=&to=&repo=&model=&effort=&tz=` | server-side aggregated analytics for a time range (`from` inclusive, `to` exclusive, ISO timestamps, both optional): metrics with previous period, time series, models, efforts, roles (`by_role`: runs, tokens, cost, agent time and outcomes per role), repositories, issues (with the cost per role, i.e. the pipeline cost across all stages), results, run times, tools and integrations (`tools`), heatmap, top runs and most expensive issue pipelines (`top.pipelines`), anomalies. `tz` (IANA zone) determines buckets, weekdays and hours |
| `GET /api/v1/history/entries?from=&to=&repo=&issue=&event=&result=&order=desc&limit=200` | Log entries of a time range, filtered and sorted (at most 1,000) |
| `GET /api/v1/history/raw?repo=owner/name` | a repository's `.log` file as text |
| `GET /api/v1/state` | Overall state as JSON: issues in flight (`issues[]` with `status` running/retrying/paused/queued, the dashboard `section` running/next/waiting/paused, `position`, `reason` and the pipeline `stages[]`), the dispatch plan (`queue[]`, see below), blocked issues (`blocked[]` with the reason, `reason_code` `column`/`blocked`/`missing_label` and `blocked_by`), `pipeline_config` (board columns, roles, blocked columns), running agents (`running[]` with `role`), queue (`retrying[]` with `kind` and, for session limits, `limit`), agent slots (`limits`, see below), totals, health (`health.max_concurrent_agents` is the effective total), `controls.retry` (whether restarting is allowed) |
| `GET /api/v1/<identifier>` | Details of an issue: title, role, board fields (`issue`: column, labels, priority, parent, sub-issues, `blocked_by`, `dispatch_note`), the pipeline stations (`pipeline`: per stage `status` `done`/`active`/`pending`/`skipped`, the `verdict` and `round` of the role's newest result, and per session the `verdict` and `round` it reported; `skipped` marks a stage the workflow profile or a `skipped` result leaves out), the stage results (`results[]`: role, run, kind, verdict, summary, round, target, `head_sha`, `created_at`; empty for roles without `result`, and until a result-driven session has loaded them), workspace, attempts, sessions (`sessions`, each with `model` and `effort`), tokens and cost per model (`usage_by_model`), latest events, last error, last entry check (`last_check`), `controls.retry`. For an issue the orchestrator released, the archived details with `status: "finished"` and `archived` (`archived_at`, `released`); `404` only when nothing is known about the issue |
| `GET /api/v1/<identifier>/timeline?after=<seq>` | Timeline of the issue (live or archived): lifecycle, phase changes and agent events with a running `seq`; `after` returns only newer ones |
| `GET /api/v1/<identifier>/transcript?run=<run>&from=<offset>` | Transcript of a session (without `run` the latest; live or archived), prepared as prompts, model calls, tool results; from byte offset `from`, continue with `next_offset`. With `&format=raw` the JSONL file |
| `POST /api/v1/refresh` | poll and reconcile now |
| `POST /api/v1/<identifier>/pause` | pause an issue (running, retrying, queued on the board, or paused after its continuations); a running agent stops at once, its workspace stays. Response `202` with `paused`, `issue_identifier` and `previous` (`running`, `retrying`, `queued`, `paused`). Errors: `404` (issue unknown), `409` (`already_paused`; `stopping`: its agent is already stopping or Symphony is shutting down), `403` as for retry |
| `POST /api/v1/<identifier>/resume` | lift a pause and start the issue right away (counters reset, attempt kept). Response `202` with `queued` and `issue_identifier`. Errors: `404`, `409` (`not_paused`; `stopping`: the agent is still stopping), `403` as for retry |
| `POST /api/v1/models/<model>/hold` | pause a model family (`fable`, `opus`, `sonnet`, `haiku`): its running agents stop, its issues wait. Response `202` with `model`, `paused` and `stopped`. Errors: `400 unknown_model`, `409` (`already_paused`, `stopping`), `403` as for retry |
| `POST /api/v1/models/<model>/release` | resume a model family; its waiting issues retry at once as slots allow. Response `202` with `model`, `paused` and `requeued`. Errors: `400 unknown_model`, `409` (`not_paused`, `stopping`), `403` as for retry |
| `PUT /api/v1/settings/agents` | change the agent slots (dashboard override). Requires `Content-Type: application/json` (else `415`), body at most 16 KiB (else `413`), e.g. `{ "max_concurrent_agents": 3, "max_concurrent_agents_by_state": { "Agent review": 1 }, "reserved_slots_by_role": { "reviewer": 1 } }`. Fields left out keep their value; `null` removes an override (the total, one column or one role). Total: integer `0`–`50`; per column: integer `1`–`50`, only active columns; per role: integer `0`–`50`, only configured roles. A total or reservation that leaves fewer slots than reserved is refused (a total of `0` is always allowed). Response `200` with `changed` and `limits`. Errors: `400 invalid_settings` with a message, `400 bad_request` (invalid JSON), `409 stopping`, `403` as for retry |
| `DELETE /api/v1/settings/agents` | remove the override: `WORKFLOW.md` applies again. Requires `Content-Type: application/json` like `PUT`; no body needed. Response `200` with `changed` and `limits`; `403` as for retry |
| `POST /api/v1/<identifier>/force` | start an issue in *Up next*, *Waiting* or *Paused* now, in an extra slot beyond the limits, for one session. Response `202` with `started`, `issue_identifier`, `previous` and `slots` (`running`, `forced`, `limit`). Errors: `404`, `409` (`running`, `blocked`, `not_eligible`, `model_held`, `invalid_workflow`, `stopping`), `502 tracker_error`, `403` as for retry; see [Retry now or Start now](#retry-now-or-start-now) |
| `POST /api/v1/<identifier>/retry` | restart a waiting (retry queue, including session limit) or paused worker right away. Response `202` with `queued`, `issue_identifier` and `previous` (`retrying` or `paused`). Errors: `404` (issue unknown), `409` (`running`: currently running; `not_waiting`: not waiting for anything; `stopping`: Symphony is shutting down), `403` (`control_disabled` on a non-loopback address without `SYMPHONY_ALLOW_REMOTE_CONTROL=true`; `forbidden_origin` for cross-origin requests and, on a non-loopback address, also without an `Origin` header) |

`queue[]` lists the [dispatch plan](#dispatch-order) without running and blocked issues, in order: Up next, then
Waiting (soonest first), then Paused. Each entry:

| Field | Content |
|---|---|
| `position` | place in the start order (1 = next free slot); `null` outside Up next |
| `issue_id`, `issue_identifier`, `state`, `priority` | the issue |
| `status` | `next`, `waiting` or `paused` |
| `kind` | `continuation`, `failure`, `session_limit` (retries), `new` (board candidate) or `paused` |
| `decision` | `start` (gets a slot) or `wait` |
| `reason` | `{ code, text }`, see the table in [Dispatch order](#dispatch-order) |
| `due_at` | when a retry is due; `null` for new and paused issues |
| `model` | the model the next session would run with; `null` = Claude Code default |

`counts` stays as before (`queued` = new candidates in Up next).

`limits` holds the agent slots: `max_concurrent_agents` and, per active column, `by_state["<column>"]`, each as
`{ effective, workflow, override }` (`override: null` = none set on the dashboard; a column with `effective: null` has
no limit of its own, only the total applies), per configured role `reserved_slots_by_role["<role>"]` as
`{ effective, workflow, override, running }` (`0` = no reservation; `running` = sessions of that role now),
`reservation_problem` (why the reservations are ignored, else `null`), plus `override_active` and `max` (the highest
value the dashboard accepts, 50).

```bash
curl -s http://127.0.0.1:4000/api/v1/state
curl -s http://127.0.0.1:4000/api/v1/owner%2Frepository%2312   # / as %2F, # as %23
curl -s -X POST http://127.0.0.1:4000/api/v1/refresh
curl -s -X POST http://127.0.0.1:4000/api/v1/owner%2Frepository%2312/retry
curl -s -X POST http://127.0.0.1:4000/api/v1/owner%2Frepository%2312/force
curl -s -X POST http://127.0.0.1:4000/api/v1/owner%2Frepository%2312/pause
curl -s -X POST http://127.0.0.1:4000/api/v1/models/fable/hold
curl -s -X PUT -H 'Content-Type: application/json' -d '{"max_concurrent_agents": 3}' http://127.0.0.1:4000/api/v1/settings/agents
curl -s -X DELETE -H 'Content-Type: application/json' http://127.0.0.1:4000/api/v1/settings/agents
```

The restart endpoint and the **Retry now** and **Resume now** buttons always work as long as the server listens on a
loopback address (`127.0.0.1`, `::1`, `localhost`). On another address (`SYMPHONY_HOST=0.0.0.0`, e.g. in a container
behind Traefik) the API responds with `control_disabled`, and the dashboard and agent page show a notice instead of
the buttons. With `SYMPHONY_ALLOW_REMOTE_CONTROL=true` restarting is possible there too, but only with an `Origin`
header that matches the `Host` (protection against CSRF, because the browser sends the proxy credentials with every
request). The browser sets it itself; with `curl` through the proxy you pass it:

```bash
curl -s -X POST -u <user> -H 'Origin: https://<domain>' https://<domain>/api/v1/owner%2Frepository%2312/retry
```

Whether restarting is allowed is shown in `GET /api/v1/state` and `GET /api/v1/<identifier>` under `controls.retry`.
The restart only skips the wait: Symphony checks again, as for every retry, whether the issue really starts (active
column, configuration, free slot).

### Retry now or Start now

**Start now** starts an issue in the same moment, even when every slot is taken: Symphony runs it in an extra slot
(limit + 1) for one session. When that session ends, its continuation, the hand-off to the next role or a retry waits
in the queue like any other work and starts only when a slot is free. Each click adds one agent to the shared
subscription; the dashboard asks first when no slot is free ("All 3 slots are busy. Start #123 in an extra slot?"),
and the slot bar counts forced sessions separately ("04 / 03 agents, 1 forced"). A forced session holds none of the
slots, so the regular slots keep filling from the queue.

| | **Retry now** / **Resume now** | **Start now** |
|---|---|---|
| Works on | *Waiting* and *Paused* | *Up next*, *Waiting* and *Paused* |
| Retry backoff, session-limit wait | skipped | skipped |
| Account-wide dispatch gate (session limit) | holds back new issues only | skipped |
| Free slot, column limits, reserved slots | respected: waits for a free slot | skipped: starts in an extra slot |
| Operator pause of the issue | lifted (Resume now) | lifted |
| Counters (continuations, session-limit hits) | reset | reset |
| Blockers, open sub-issues (`wait_for_sub_issues`), required labels, active column | respected | respected: `409` |
| Model on hold (limit or operator) | respected: waits | respected: `409 model_held`; release the model first |
| When it starts | at the next retry pass, if a slot is free | in the same request |

`POST /api/v1/<identifier>/force` answers `202` with `started`, `issue_identifier`, `previous` (`queued`, `retrying`,
`paused`) and `slots` (`running` including the forced sessions, `forced`, `limit`). Errors: `404 issue_not_found`
(not in *Up next*, *Waiting* or *Paused*), `409` with `running` (already running), `blocked` (open blockers or
sub-issues), `not_eligible` (missing required label, not in an active column), `model_held`, `invalid_workflow`
(dispatch validation fails) or `stopping` (Symphony is shutting down), `502 tracker_error` (the issue could not be
refreshed), `403` as for retry. The running entry in `GET /api/v1/state` has `forced: true`, `counts.forced` counts
them, and the issue's timeline and the repository log get a `worker_forced` line with the slot counts.

## Logs, transcripts and workspaces

| What | Where |
|---|---|
| Running logs (`key=value`) | Terminal (stderr). Also to a file with `--log-file <path>`, more detailed with `--log-level debug`. |
| Log per repository: what was worked on when, with tokens, model, cost and agent time | `~/.local/state/symphony/repositories/<owner>_<repo>.log`, see [Logs and statistics](#logs-and-statistics) |
| Transcript of every session (all agent messages as JSON lines `{ at, message }`, plus the prompt of each turn as `{ at, prompt: { turn, text } }`) | `~/.local/state/symphony/sessions/<workspace>/<time>.jsonl`. Choose another location with `--log-dir <folder>`. The [agent detail view](#agent-detail-view-execution-trace) shows it in a prepared form. |
| Archived details of finished issues (timeline, sessions, last run and check) for the agent detail view | `~/.local/state/symphony/issues/<owner>_<repo>_<number>.json`, written when a run ends and when the issue is released. |
| View a Claude Code session | in the workspace, `claude --resume <thread-id>`. The ID is in the log as `thread_id` and in the API (`/api/v1/<identifier>`). |
| Workspaces | `~/symphony-workspaces/`. They are deleted on `Done`; you can safely delete others by hand if no agent is running in them. |

## Logs and statistics

Symphony writes a running log for each repository, e.g.
`~/.local/state/symphony/repositories/owner_repository.log`. Change the folder with
`SYMPHONY_LOG_DIR` in the `.env` or with `--log-dir`. Each line is one event in `key=value` format:

```
ts=2026-10-04T09:16:19.000Z event=run_started repo=owner/repository issue=owner/repository#5 run=8f3c2a1b9d0e title="Feature: …" state=Ready attempt=null model=opus effort=high role=developer
ts=2026-10-04T09:17:00.000Z event=run_finished repo=owner/repository issue=owner/repository#5 run=8f3c2a1b9d0e … outcome=handed_off state="In review" turns=1 model=claude-opus-5-5 model_requested=opus effort=high total_tokens=153200 cost_usd=0.1491 agent_seconds=41 repo_runs=4 repo_tokens=556200 repo_cost_usd=0.5262 repo_agent_seconds=246
ts=2026-10-04T09:17:00.000Z event=model_usage repo=owner/repository issue=owner/repository#5 run=8f3c2a1b9d0e model=claude-opus-5-5 price=opus effort=high input_tokens=2800 output_tokens=1680 cache_read_tokens=123200 cache_write_tokens=12320 total_tokens=140000 cost_usd=0.1361
```

| Event | Meaning |
|---|---|
| `run_started` | An agent starts on an issue: time, issue, title, column, attempt, requested model (from the label `Model: …`, else `CLAUDE_MODEL`) and requested effort (from the label `Effort: …`, else `CLAUDE_EFFORT`). |
| `run_finished` | A run ends. It records the result (`handed_off` = handed off, `continuing` = still active, `failed`, `session_limit`, `stopped`, `stalled`, `shutdown`) and the column afterwards. Plus turns, the most used model (`model`, as Claude Code reports it, e.g. `claude-fable-5-1`), the requested model and effort (`model_requested`, `effort`, like `run_started`), tokens (input, output, cache), estimated cost and agent time. The `repo_*` fields are the repository's running totals. |
| `model_usage` | Tokens and cost of a run per model, with the run's `effort`. One line per model Claude Code reported for the session (a second model used internally gets a second line); a new model needs no change, it is logged under its own id. The tokens are counted from every model call as it happens, so a run that is stopped, stalls or hits a session limit before its turn ends still has its usage. |
| `issue_paused` | An issue was paused: after its continuation sessions, by the operator, or because its [cost budget](#cost-budget-per-issue) is used up (`source=budget`, with `cost_usd` and `max_issue_cost_usd`). |
| `session_limit_wait` | The session-limit retries are used up: the worker waits for the limit to reset (`retry_at` = reset + 1 minute) and then continues. Fields include `window`, `resets_at`, `retry_at`, `hits`, `max_retries`, `source`. |
| `worker_restarted` | A waiting or paused worker was restarted via **Retry now** / **Resume now** or the API (`previous` = `retrying` or `paused`). |
| `worker_forced` | An issue was started with **Start now** or `POST /api/v1/<identifier>/force` in an extra slot (`previous` = `queued`, `retrying` or `paused`; `running`, `forced`, `limit` = the slot counts after the start). |
| `stage_skipped` | A stage was passed without a session ([skipping stages](configuration.md#skipping-stages-without-a-session)): `issue`, `title`, `role`, `from` and `to` (the columns) and `reason`. The issue's timeline has the same event with the comment URL. |
| `workspace_removed` | The workspace of an issue in `Done` was deleted. |

The **statistics page** (`/logs`, button *Logs* in the dashboard) evaluates these files. At the top is a global
filter: **period** (today, yesterday, last 7/14/30/90 days, this/last month, all or a custom date range),
**repository**, **model** and **effort**. It applies to all sections and is kept in the URL. Clicking a model,
effort or repository in the bar charts sets this filter; clicking a bar in the activity chart zooms into that
period. The page shows:

- **Metrics**: runs, issues, tokens, estimated cost, agent time, average run time, cost and tokens per run,
  successful and failed runs, retry rate, paused issues. Plus a comparison with the previous period of the same
  length, but only if the logs fully cover that previous period.
- **Time series** for runs, tokens, cost and agent time. The granularity adapts: hourly up to 2 days, daily up to
  ~3 months, weekly up to 2 years, monthly otherwise. Plus cost per bucket or cumulative, and tokens stacked by
  input, output and cache.
- **Models**: comparison by cost, runs, tokens, cost/run, tokens/run or agent time, plus an efficiency table (cost
  per 1M tokens, output/input ratio). Every model id that appears in the logs is listed; a run that ended before any
  usage was logged counts under the model it was started with, with 0 tokens (an alias such as `opus` under the
  reported id of that family, e.g. `claude-opus-5-5`; `fable` itself until a Fable run has reported usage). With a
  model filter, tokens and cost count only that model.
- **Effort**: runs, successful and failed runs, tokens, cost, agent time and the averages per run by the effort
  requested for the run (`Effort:` label, else the role's effort or `CLAUDE_EFFORT`; `default` = Claude Code's own
  default), with the main models that ran at that effort. Runs logged before the effort was recorded count as
  `unknown`.
- **Repositories**: comparison, activity over time (the three most active plus "Other") and a table with the last
  activity.
- **Results** of the runs as logged (`handed_off`/`continuing` = successful, `failed`/`stalled` = failed,
  `stopped`/`shutdown` = stopped). A run counts as a *retry* if the previous run of the same issue failed.
- **Run times**: average, median (from 3 runs), p90/p95 (from 20 runs), shortest and longest run, distribution; a
  **heatmap** of start times by weekday and hour.
- **Tools**: tool calls in the period, runs with calls, calls per run, the most used tools (built-in ones like
  `Bash` or `Edit` and MCP tools as `server · tool`) and the loaded skills.
- **Laravel Boost & integrations**: per integration, the runs on projects that use it, how often it was available
  and how often the agent actually used it (share of the runs where it was available), the calls and the most used
  Boost tools and skills. Guidelines belong to every session where Boost is available and do not count as a call.
  Tool calls are only in the logs since Symphony records them; older runs count as runs without calls.
- **Top runs** by cost, tokens and duration, the most retried issues and **Needs attention**: runs with at least 3
  times the period average (from 5 runs) and issues with at least 3 failed or retried runs.
- **Issues**, sortable (most expensive, most tokens, longest run time, most runs, newest, last finished, failed),
  and the **log** of the period with filters by issue, event and result. The log loads separately: if it fails, the
  statistics stay visible and the log can be reloaded on its own. For a single repository there is a link to the raw
  `.log` file.

All numbers come from the logs; the page computes costs with the current `model-costs.yml`.

## Estimating costs with `model-costs.yml`

Symphony computes costs from the tokens using the prices in `model-costs.yml` in the Symphony folder. Prices are in
USD per million tokens. Changes apply without a restart. The logs page also recomputes older entries with the
current prices.

```yaml
default:            # applies to every model without a matching entry
  input: 5.00
  output: 25.00

opus:               # applies to every model ID that contains "opus", e.g. claude-opus-5-5
  input: 4.00
  output: 20.00
  cache_read: 0.20  # optional; default: 10 % of the input price (cache_write: 125 %)

claude-opus-4-8:    # an exact model ID takes precedence over "opus"
  input: 5.00
  output: 25.00
```

The logs page shows which entry applies to a model in the *Price entry* column. If the file is invalid, Symphony
keeps computing with the last valid prices and shows the error in the dashboard. If it is missing entirely, a
built-in default of $5 / $25 applies to all models. Claude Code's own estimate is in the log as
`claude_estimate_usd` for comparison.

## Multiple repositories

- **One board for several repositories:** List them all in the `.env`, e.g.
  `GITHUB_REPOSITORY=owner/repository1,owner/repository2`. Each issue is worked on in a clone of its
  own repository. The hook uses `$SYMPHONY_ISSUE_REPOSITORY` for this.
- **One board per repository:** Create a separate env file per board and start one instance per board with its own
  port:

  ```bash
  cp .env .env.website                   # then adjust GITHUB_PROJECT_NUMBER, GITHUB_REPOSITORY and SYMPHONY_PORT
  npm start                              # instance 1 with .env
  npm start -- --env-file .env.website   # instance 2, e.g. in a second terminal
  ```

  The instances share `~/symphony-workspaces`. Their folder names do not collide because they contain the
  repository.

- **One instance per board:** Two instances on the same board would work on the same issue in the same folder
  (parallel git commands, `composer install`, two agents on one branch). So before each run Symphony creates the file
  `~/symphony-workspaces/<folder name>.lock`, next to the clone, so that `git status` stays clean. If another instance
  holds the lock (running process or another machine), Symphony starts neither hooks nor agent, logs a warning with
  the holder's pid and host, and tries again on the next poll. Symphony takes over the lock of a finished process on
  the same machine itself. Deleting the workspace also removes the lock. Across machines this lock is all there is;
  there is no distributed coordination.

## Adjusting the configuration

The most common settings in the `WORKFLOW.md`. All options are described in
[configuration.md](configuration.md).

| Setting | Effect |
|---|---|
| `agent.max_concurrent_agents` | how many agents run at the same time (default here: 2) |
| `agent.max_concurrent_agents_by_state` | limit per column, e.g. `{ "In progress": 1 }` |
| `agent.max_turns` | turns per session before Symphony reassesses the state |
| `agent.max_continuations` | continuation sessions per issue (including role changes), then pause |
| `agent.max_issue_cost_usd` | cost cap per issue across all stages; the next stage does not start once it is reached ([details](#cost-budget-per-issue)) |
| `roles` | roles per column: columns, allowed target columns (`may_move_to`), `read_only`, `max_turns`, model |
| `checks` | scripts that must pass before a card may enter a column (`on_enter`), and their timeout |
| `workspace.cleanup_terminal` | delete workspaces on `Done` (default) or keep them |
| `claude.max_budget_usd` | cost cap per session |
| `claude.effort` | thinking effort: `low` … `max`. Comes from `CLAUDE_EFFORT`; a label `Effort: …` on the issue takes precedence, see [Choosing the effort per issue](#choosing-the-effort-per-issue) |
| `claude.allowed_tools` | actions that are always allowed, e.g. `"Bash(npm test:*)"` |
| `claude.plugins`, `claude.skills` | plugin folders for all sessions (default: `./.claude`) and which skills are active (`all`) |
| `laravel.*` | Laravel Boost: `boost: auto` or `off`, PHP and Composer command, environment for Boost (`env`, default `APP_ENV: local`) and agent (`agent_env`), tool restrictions (`allow_tinker`, `deny_tools`) |
| `tracker.required_labels` | only work on issues with these labels, e.g. `[symphony]` |
| `hooks.*` | shell scripts around each run, e.g. installing dependencies |
| Text below the front matter | the prompt, a Liquid template with `issue`, `attempt` and `role` |

## Security

- **Permissions:** Claude Code runs in `auto` mode. A classifier allows normal development work and blocks risky
  actions. If Claude Code still asks, Symphony answers *no* (`on_permission_request: deny`), because nobody is
  watching. `git push` is explicitly allowed.
- **Token:** The GitHub token is removed from the environment of the agent and the hooks. Status, comments and pull
  requests go through tools that Symphony runs itself.
- **Limits:** The agent runs as your Linux user. In principle it could read files that you can read, such as the
  `.env`, unless the classifier or sandbox prevents it. Issue texts are untrusted input. Only work on boards whose
  issues you trust. For more isolation: enable `claude.sandbox`, or run Symphony as a separate user, in a container
  ([docker.md](docker.md)) or in a VM. Details: [agent-claude.md](agent-claude.md).
- **Dashboard:** The dashboard has no login of its own. Only use a non-loopback address (`SYMPHONY_HOST`, e.g.
  `0.0.0.0`) behind a reverse proxy with authentication (BasicAuth, forward auth); Symphony warns about this at
  startup. `SYMPHONY_ALLOW_REMOTE_CONTROL=true` allows restarting workers there, with a required origin check against
  CSRF.

## Costs

Every session starts with about 30,000 tokens of context (Claude Code's system prompt and tool descriptions). A
minimal test turn with `opus` cost about $0.15. Real issues cost considerably more, depending on their size. The
dashboard shows the estimated cost per agent and since startup. The logs page shows it per repository, model, issue
and day. Estimates use the [`model-costs.yml`](#estimating-costs-with-model-costsyml). Ways to limit costs:

- `claude.max_budget_usd` per session,
- a cheaper model for simple issues via label, e.g. `Model: sonnet` or `Model: haiku`,
- few parallel agents,
- `tracker.required_labels`, so that only explicitly marked issues are worked on.

## Laravel Boost

[Laravel Boost](https://laravel.com/docs/boost) gives AI agents Laravel knowledge that matches the installed
packages: **guidelines** (always loaded), **skills** (loaded on demand, e.g. `laravel-best-practices`,
`testing-best-practices`, `filament-development`) and an **MCP server** with docs search, database schema, logs and
errors. Symphony uses Boost automatically:

1. After the `before_run` hook, Symphony looks for Laravel apps in the workspace: in the root or one level down, e.g.
   `laravel/` in a typical Laravel repository structure.
2. If `laravel/boost` is in the `composer.json`, Symphony installs the dependencies if needed (`composer install`)
   and generates Boost's guidelines and skills for Claude Code (`boost:install`). It then checks whether the
   guidelines and all skills that Boost reports in `boost.json` were actually written: `boost:install` exits with
   code 0 even when writing fails. If something is missing, Symphony warns and regenerates on the next attempt.
3. Symphony adds the generated files to `.git/info/exclude`. It resets versioned files that Boost changed. So none
   of it ends up in the pull request.
4. The session gets the MCP server `laravel-boost`, the Boost skills and Boost's guidelines in the system prompt.
   The prompt lists the skills that were actually generated and the allowed and blocked tools.
5. Files are only regenerated when `composer.lock`, `.ai/` or the Boost version change.
6. Whether and how the agent used Boost is shown on the dashboard card, the agent page and the statistics page (see
   [Dashboard and API](#dashboard-and-api) and [Logs and statistics](#logs-and-statistics)).

So that Artisan and Boost never reach a foreign database, `hooks/laravel-env.sh` in the `after_create` hook creates a
separate `.env` with its own SQLite database for each Laravel app (`database/symphony.sqlite`, `CACHE_STORE=file`,
`BOOST_BROWSER_LOGS_WATCHER=false` and others). An existing `.env` is left untouched; `.env` and the database go into
`.git/info/exclude` if the app does not ignore them itself:

```yaml
after_create: |
  set -e
  git clone --quiet "git@github.com:${SYMPHONY_ISSUE_REPOSITORY}.git" .
  bash "$SYMPHONY_WORKFLOW_DIR/hooks/laravel-env.sh"
```

Optionally MySQL instead of SQLite: with `SYMPHONY_LARAVEL_DB=mysql` in Symphony's environment,
`hooks/laravel-env.sh` creates the databases `symphony_<key>` and `symphony_<key>_test` per workspace (`<key>` = the
first 12 hex characters of the sha256 of `SYMPHONY_WORKSPACE_KEY`), sets `DB_*` in `.env` and writes `.env.testing`.
In the `before_remove` hook, `bash "$SYMPHONY_WORKFLOW_DIR/hooks/laravel-db-drop.sh"` drops both again. Variables:
`SYMPHONY_MYSQL_HOST` (default `127.0.0.1`), `SYMPHONY_MYSQL_PORT` (`3306`), `SYMPHONY_MYSQL_USER` (required) and
`SYMPHONY_MYSQL_PASSWORD` (never printed). The MySQL user is restricted to `symphony\_%`, which also covers
`php artisan test --parallel`:

```sql
GRANT ALL PRIVILEGES ON `symphony\_%`.* TO 'symphony'@'localhost';
```

Requirement: `phpunit.xml` must not hard-code `DB_DATABASE`, otherwise its value wins over `.env.testing` and
parallel workspaces share one test database. Details in [configuration.md](configuration.md).

If Boost is missing in a Laravel repository, `npm run repo-init` → *Laravel Boost* creates an issue that introduces
Boost via a pull request. If something does not work (no PHP, `composer install` fails), the session continues
without Boost. The warning is in the log. `npm run dry-run` shows whether `php` and `composer` work.

Requirements and limitations:

- **PHP and Composer on the host**, in the versions the projects require. Custom paths:
  `SYMPHONY_PHP=/usr/bin/php8.4` in the `.env`. If PHP is to run in a container later, `laravel.php` points to a
  wrapper script. It gets the absolute `artisan` path as its first argument and `SYMPHONY_WORKSPACE` in the
  environment.
- **`APP_ENV=local`:** Boost only runs locally. Symphony sets `laravel.env` (default `APP_ENV: local`) for its
  Composer and `artisan` steps and the MCP server, because a fresh clone has no `.env`, but not for the agent's
  shell: there `APP_ENV=local` would override PHPUnit's `APP_ENV=testing`. Variables for the agent belong in
  `laravel.agent_env` (empty by default). Database settings belong in the app's `.env` (see above), not in
  `laravel.env`.
- **Boost tools:** Only the read-only tools are allowed (`application-info`, `browser-logs`,
  `database-connections`, `database-query` (read-only), `database-schema`, `get-absolute-url`, `last-error`,
  `read-log-entries`) and `search-docs` (sends queries and the package list to boost.laravel.com). `tinker` runs
  arbitrary PHP and is blocked, unless `laravel.allow_tinker: true`. `laravel.deny_tools` (default
  `[record-rule]`, which writes `.ai/rules`) blocks further tools, e.g. `[search-docs, record-rule]`. New tools in
  later Boost versions are not allowed in advance.
- **Committed Boost files:** If `boost.json` is in the repository, the repository manages Boost itself. Symphony then
  generates nothing and uses the committed files.
- **Sail:** If Boost detects Laravel Sail, its guidelines refer to `vendor/bin/sail`. Symphony then warns, because it
  runs PHP on the host.

## Skills: where do they belong?

Rule of thumb: knowledge belongs where it is versioned and where it applies.

| Knowledge | Location | Why |
|---|---|---|
| Framework knowledge (Laravel, Livewire, Pest, Inertia …) | **Laravel Boost** in the respective repository, generated by Symphony | matches the versions in `composer.lock`; copies in Symphony would go stale |
| Domain and project ("create invoices", tenant scoping) | **Repository:** `.ai/skills/` and `.ai/guidelines/` (Laravel), else `.claude/skills/` | versioned with the code and reviewed in the pull request; also helps you locally |
| Project rules and pitfalls | **Repository:** `.ai/rules/`, via Boost's `record-rule` tool or the `infer-conventions` skill | loaded by file path and applies to everyone |
| Working style across all repositories (PR style, commits, checking without a UI, handoff to the board) | **Symphony:** `.claude/skills/` | applies only to Symphony agents, the same in every repository |
| Tasks started by a command in the issue (`/refactoring`, `/refactor-safely`, `/auto-code`) | **Symphony:** `.claude/skills/`, see [Commands in the issue](#commands-in-the-issue-refactoring) | maintained once instead of in every repository; only run under Symphony |
| Personal preferences | `~/.claude/` | deliberately not loaded by Symphony |

Putting everything into the Symphony repository would be convenient, but has drawbacks. Only Symphony agents would
see these skills, not you locally. They would not be tied to the repository's code version. And Boost skills can only
be overridden in the repository: a skill with the same name in `.ai/skills/` replaces Boost's.

In Laravel repositories, your own skills go into `.ai/skills/<name>/SKILL.md`, not into `.claude/skills/`. Boost
overwrites `.claude/skills` when it generates, and `.ai/` also works with other agents (Cursor, Codex …).

Symphony's `.claude/` has the folders `skills/`, `agents/`, `commands/` and `hooks/` and is loaded via
`claude.plugins: [./.claude]`. Its skills are called `symphony:<name>` in the agent. Rules for good skills are in
[.claude/README.md](../.claude/README.md).

## Repositories with a Docker setup (e.g. a Laravel portal)

In a Docker-based application, PHP and Artisan commands run via `docker exec … container`, according to `AGENTS.md`. But this container
mounts your main checkout (e.g. `~/projects/repo/laravel`), not the agent's workspace. Tests there would
check the wrong code, and migrations would change your development database. The prompt therefore tells the agent not
to use foreign containers and to list checks it could not run in its result.

For the agent to run PHP tests itself, each workspace needs its own Docker stack. This can be set up with the hooks:

- `after_create` creates a `.env` in the clone with its own `APP_CONTAINER_NAME` and its own ports and starts
  `docker compose -p <workspace-key> up -d`.
- `before_remove` cleans up with `docker compose … down -v`.

This is deliberately not preconfigured yet, because it costs resources and ports per issue. Best start with
`max_concurrent_agents: 1`. Until then Laravel Boost runs with PHP on the host (see [Laravel Boost](#laravel-boost)).
With one stack per workspace, `laravel.php` can point to a wrapper script that runs PHP in that container.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `GitHub token lacks a required scope` | The token lacks `project`. Fix: `gh auth refresh -s project`, or create a classic token with `repo` and `project`. |
| `GitHub rejected the token (HTTP 401)` | Token wrong or expired. Check `GITHUB_TOKEN` in the `.env`. |
| `Candidates in active states: 0` | The board is empty, no issue is in `Ready`, `In progress` or `Agent review`, the issues come from a repository other than `GITHUB_REPOSITORY`, or the column names do not match `active_states`. |
| `↳ blocked by …` or `↳ waiting for sub-issues …` in the dry run | The issue waits for a dependency or a sub-issue. It starts by itself once these are closed, usually after their pull request is merged. |
| `↳ issue is closed` | Closed issues are not worked on. |
| `project field "Status" is missing` | The board has no single-select field `Status`. Enter the field's name under `tracker.provider.status_field`. |
| `after_create hook exited with code 128 … Permission denied (publickey)` | SSH access to GitHub is missing. Check `ssh -T git@github.com`. |
| `after_create hook exited with code 128 … Remote branch develop not found` | `SYMPHONY_BASE_BRANCH` applies to **all** repositories on the board. Create the branch in every repository or remove the repository from `GITHUB_REPOSITORY`. |
| `before_run hook exited with code 128 … not a git repository` | The workspace contains no clone, because `after_create` skipped over a failed `git clone` (without `set -e` only the last line of the hook counts). Symphony prepares empty workspaces again on the next attempt by itself. If the workspace is not empty but broken, delete the directory. |
| An agent keeps starting over | The issue never leaves the active columns, for example because the handoff column is missing or `set_status` fails (warning `agent tracker_tool` with `set_status failed` in the log). First pause (`max_concurrent_agents: 0`), then fix the columns or the prompt. |
| Warning `agent agent_error` (e.g. `authentication_failed`) or `startup_failed` | Claude Code is not logged in, or the account has a problem. Start `claude` once and run `/login`, or set `ANTHROPIC_API_KEY`. |
| `env file values ignored because the shell environment already sets them` | The variable is also set in the shell, and the shell wins. `unset GITHUB_TOKEN` or adjust the value there. |
| `unknown board column "…" (valid: …)` | The `WORKFLOW.md` names a column that does not exist on the board (typo in `active_states`, `terminal_states`, `roles.*.states`, `roles.*.may_move_to` or `checks.on_enter`). Fix the name; the check is case-insensitive and the error disappears after the automatic reload. The dry run shows it as well. |
| `dispatch validation failed` | An error in the `WORKFLOW.md` or `.env`. The exact message is in the log or the dashboard. |
| Warning `issue paused: still active after its continuation sessions` | The agent did not finish the issue after `SYMPHONY_MAX_CONTINUATIONS` continuations. Read the last comment and the transcript, then write a hint in the issue (that resumes it) or move the card. |
| Message `You've hit your session limit` (dashboard: *Session limit*) | Your Claude subscription has reached its usage limit. Symphony retries up to `SYMPHONY_MAX_SESSION_LIMIT_RETRIES` times and then waits for the reset, see [Session limit](#session-limit). If you have topped up credits, **Retry now** helps. An `ANTHROPIC_API_KEY` has no session limit. |
| A worker waits longer than expected | In the dashboard under *Retrying*, look at `retry at` and `resets`. For a session limit this is the reset plus 1 minute; for an unknown reset the normal backoff applies (up to 10 minutes). A paused issue (*Paused*) has no scheduled time: it only continues on a change to the issue, a higher `max_continuations` or via **Resume now**. After a Symphony restart a wait is forgotten. To start right away: **Retry now**. |
| Warning `model label ignored` | A model label is unknown (typo), or the issue has several model labels with different models. Symphony then uses `CLAUDE_MODEL`. Fix the label; `npm run dry-run` shows the result. |
| Warning `effort label ignored` | An effort label is unknown (typo; allowed are `low`, `medium`, `high`, `xhigh`, `max`), or the issue has several effort labels with different levels. Symphony then uses the role's effort or `CLAUDE_EFFORT`. Fix the label; `npm run dry-run` shows the result. |
| Session fails right at the start with a model error | The label names a version that does not exist, e.g. `Model: claude-opus-9-9`. Symphony retries the run with backoff. Fix the label. |
| `repo-init` reports `HTTP 404` or `HTTP 403` | The repository in `GITHUB_REPOSITORY` is misspelled, or the token may not create labels or issues, or may not read files. Classic token: scope `repo`; fine-grained token: *Issues: Read and write* and *Contents: Read*. |
| Warning `Laravel Boost skipped: composer install failed` | The PHP or extension version does not match `composer.lock`, or Composer cannot reach Packagist. The output is in the log. Install a matching PHP and set `SYMPHONY_PHP`. |
| Warning `Laravel Boost skipped: boost:install failed` with `Command "boost:install" is not defined` | Boost is not active, usually because `APP_ENV` is not `local`. Check `laravel.env`; `BOOST_ENABLED=false` in a committed configuration turns Boost off completely. |
| Warning `an MCP server Symphony added is not connected` | `php artisan boost:mcp` does not start. Run `APP_ENV=local php artisan boost:mcp` by hand in the workspace and read the error message. |
| Dry run: `php (not found)` | PHP is not installed or not in the `PATH`. Laravel workspaces then run without Boost. Set `SYMPHONY_PHP` to the path. |
| `candidate fetch failed … timed out` or `HTTP 503` | GitHub's GraphQL API is briefly disrupted. Symphony retries read queries automatically; otherwise just wait for the next tick. Running agents are not affected. |

## Laravel repositories

For Symphony agents and Laravel Boost to work well in a Laravel repository, the repository must follow a few
conventions: `AGENTS.md` and `.ai/`, the Composer scripts `test`, `lint` and `analyse`, a complete `.env.example`, a
suitable `phpunit.xml`, Boost in `require-dev` and the repository settings on GitHub. The guide is in
[laravel-repositories.md](laravel-repositories.md).

← [Documentation](index.md) · Back: [Getting Started](getting-started.md)
