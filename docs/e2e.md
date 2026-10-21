# End-to-end test: `npm run e2e`

Runs the orchestrator against a real board. The default scenario checks two guarantees:

- no more than `agent.max_concurrent_agents` agents run at the same time, and
- no issue is started while one of its dependencies ("blocked by") is still open.

The [`roles` scenario](#scenario-roles) (`--scenario roles`) checks the roles lifecycle instead:
developer → entry check → reviewer → handoff. The [`pipeline` scenario](#scenario-pipeline) (`--scenario pipeline`)
runs the shipped bugfix pipeline: issue analyst → developer → test engineer → reviewer, with a test loop, a review loop
and a blocked analysis.

The test creates real issues and runs real Claude Code sessions, so use a dedicated test repository and board.
The agents only comment or report results; they change no code.

## Requirements

- The `.env` and `WORKFLOW.md` of this checkout point to the test board and repository, the same setup as `npm start`.
  The issues are created in the first repository of `GITHUB_REPOSITORY`.
- The board has the columns `Ready`, `In progress`, `In review` and `Done` (see `STATUS` in `scripts/e2e/context.ts`).
- The repository has the label `Model: sonnet` (`npm run repo-init` creates it).
- No issue on the board is in an active state. Symphony would work on it too, so the test refuses to start.
- No Symphony instance runs on the port (`server.port`, or `--port`).
- Claude Code is logged in, as for normal operation.
- Only for `--scenario roles`: the board also has the columns `Agent review` and `Blocked` (see `ROLE_STATUS` in
  `scripts/e2e/roles.ts`).
- Only for `--scenario pipeline`: the board has the columns `Ready`, `Design`, `In progress`, `Testing`, `Documentation`, `Agent review`,
  `Security review`, `In review`, `Blocked` and `Done` (see `PIPELINE_COLUMNS` in `scripts/e2e/pipeline.ts`), and
  `Testing` and `Documentation` sit between `In progress` and `Agent review`. The issues pass `Design`, `Documentation` and `Security review` without a
  session (complexity `S`, no changed files), but the shipped `active_states` name them. The agent slots (`SYMPHONY_MAX_CONCURRENT_AGENTS`, default 3) must leave the test
  engineer a slot beyond the ones reserved for the developer and the reviewer, and the repository must be reachable for
  the workspace hook (`git clone` over SSH, as for normal operation). The test checks the generated workflow against
  the board before it creates any issue and refuses to start on a problem.

## Scenario

All issues carry `Model: sonnet` and start in `Ready`. Each one asks the agent to set `In progress`, post one
comment (`E2E run T<n> done. Dependencies according to the tracker: …`) and hand off to `In review`.

| Issue | Depends on | Covers |
|---|---|---|
| T1–T4 | nothing | four free issues: with a limit of 3, T4 has to wait for a free slot |
| T5 | T1 (relationship) | a single blocker |
| T6 | T1, T2 (relationships) | several blockers |
| T7 | T5 (relationship) | a chain T1 → T5 → T7 |
| T8 | T3, as `Blocked by #N` in the text | the text reference parser |
| T9 | T6, T7, T8 (relationships) | a join; runs last |

## Run

```bash
npm run e2e
npm run e2e -- --env-file .env.test --review-delay 90
npm run e2e -- --scenario roles
npm run e2e -- --scenario pipeline
```

| Option | Default | Description |
|---|---|---|
| `--scenario <name>` | `default` | `default` (dependencies and concurrency), `roles` (roles lifecycle) or `pipeline` (bugfix pipeline), see below |
| `--env-file <path>` | `.env` next to `WORKFLOW.md` | dotenv file for the test and the Symphony instance |
| `--port <n>` | `server.port`, else 4000 | dashboard/API port of the test instance |
| `--review-delay <s>` | 60 | Default scenario only. How long an issue stays in `In review` before the simulated review closes it. Keep it longer than the poll interval, so that every dependency is visibly finished but still open for at least one poll. |
| `--timeout <min>` | 45; 60 for `pipeline` | Give up and stop Symphony after this many minutes. |

Steps:

1. **Preflight:** loads the config, checks the port, checks that the board has no active issues and that the status
   columns exist.
2. **Setup:** creates T1–T9, adds the relationships, adds the issues to the board and only then sets them to
   `Ready`. Afterwards it sets the status again where a board workflow overwrote it.
3. **Dispatch check:** the tracker adapter must report T1–T4 as dispatchable and T5–T9 as blocked, the same check
   as `--dry-run`. Otherwise Symphony is not started.
4. **Run:** starts Symphony with its own log directory. Every 5 s it records the running agents from
   `/api/v1/state`. Every 15 s the reviewer moves issues that have waited `--review-delay` seconds in `In review` to
   `Done` and closes them.
5. **Stop:** once all issues are closed and no agent runs, it stops Symphony and runs the verification.

The exit code is 0 only if every check passes.

## Checks

| Check | Passes when |
|---|---|
| Concurrency | The peak of overlapping runs in the history log is `min(limit, 4)`, and the API trace never shows more than the limit. |
| Dependencies | Every run started after all dependencies of its issue were closed (GitHub `closedAt`), and the relationships on GitHub match the scenario. |
| Model | Every run asked for `sonnet` and was answered by a Sonnet model. |
| No code changes | No pull request was created since the start, and no `symphony/issue-<n>` branch exists for a test issue. |
| Completeness | Every test issue is closed and has the agent's comment. |

A table lists each issue with the close times of its dependencies, the start and end of its runs, outcome, turns and
cost. Times are UTC.

## Scenario `roles`

Proves the lifecycle of [roles](configuration.md#roles) and [entry checks](configuration.md#checks) on a real board:
the developer reports an `implementation` result, the entry check of `Agent review` denies it once, the reviewer
reports a `review` result (approved, or `changes_needed` once), and the issue ends in `In review`. Both roles hand off
with [`report_result`](results.md#the-report_result-tool): Symphony posts the result comment and computes the next
column; the agents never change a status themselves.

**Workflow.** The test writes its own workflow to `<run dir>/WORKFLOW.md`, derived from the repository's
`WORKFLOW.md`: tracker, workspace, hooks, agent and Claude settings stay the same, relative paths are made absolute,
Laravel Boost is switched off. Replaced are:

| Setting | Value |
|---|---|
| `tracker.active_states` | `Ready`, `In progress`, `Agent review` |
| `roles` | `developer` (`Ready`, `In progress`; `result: implementation`, `on_result: {done: Agent review, blocked: Blocked}`) and `reviewer` (`Agent review`, read-only, 6 turns; `result: review`, `on_result: {approved: In review, changes_needed: In progress, blocked: Blocked}`, `on_check_failed: In progress`) |
| `pipeline.max_review_rounds` | 3 |
| `checks.on_enter` | `Agent review`: `<run dir>/roles-check.sh`. It fails the first time per issue and writes a marker file to `<run dir>/check-markers/`, then passes. |
| `agent.max_concurrent_agents_by_state` | `Agent review: 1` |
| `agent.max_continuations` | 6 (role switches without a recorded result count as continuations) |
| prompt | "follow the section of the issue text for your role; tracker tools only" |

**Issues.** Three issues with `Model: sonnet`, no dependencies, created in `Ready`. Each issue text has one section
per role:

| Issue | Developer | Reviewer |
|---|---|---|
| R1 | reports `done` (`E2E run R1 developed`) | reports `approved`: the issue moves to `In review` |
| R2 | reports `done` | reports `changes_needed` with one finding in review round 1 (the prompt's `round`): back to `In progress`; then `approved` |
| R3 | reports `done` | reports `approved` |

The developer's first `report_result` fails with `check_failed` (nothing is recorded); the issue text tells the agent to
repeat the call once. There is no simulated review: the run ends as soon as no test issue is in an active column and no
agent runs. Every 3 s the test reads the issues' statuses into `timeline.jsonl` and the running agents into
`trace.log`.

**Checks** (`scripts/e2e/verify-roles.ts`, a pure function over the repository log lines and the status timeline):

| Check | Passes when |
|---|---|
| Status path | After `Ready`, each issue went `Agent review` → `In review` (a result role has no `set_status`, so the developer's `report_result` moves it straight out of `Ready`); R2 went `Agent review` → `In progress` → `Agent review` → `In review`. |
| Never `Done` | No issue was ever seen in `Done`. |
| Entry check | Per issue, the first `checks_finished` line for `Agent review` failed, it is the only failed one, and a passing one follows. |
| Stage results | Read back from the issue comments: R1 and R3 have `implementation:done`, `review:approved`; R2 has `implementation:done`, `review:changes_needed`, `implementation:done`, `review:approved`. |
| Repository log | It has `checks_finished` and `run_finished outcome=handed_off` lines; every issue has a developer → reviewer handoff, R2 a reviewer → developer handoff, and each issue's last run is the reviewer's handoff out of the active columns. |
| `Agent review` limit | Reviewer runs in the history never overlap beyond 1, and the API trace never shows more than 1 agent in `Agent review`. |
| No code changes | As in the default scenario. |

**Cost.** About eight sessions (two per issue, two more for R2), each a few turns with Sonnet: expect roughly
0.50–1 USD and 10–15 minutes with a poll interval of 30 s. The test issues stay open in `In review`; close or archive
them afterwards.

## Scenario `pipeline`

Proves the shipped multi-agent pipeline of [`WORKFLOW.md`](../WORKFLOW.md) on a real board and with real Claude sessions:
the [issue analyst](configuration.md#the-issue-analyst) classifies the issue, the developer implements it, the
[test engineer](configuration.md#the-test-engineer) tests it and the reviewer reviews it. Bug issues take the
[`bugfix` profile](configuration.md#workflow-profiles), which sends the developer's `done` through `Testing`. Three
issues cover a test loop, a review loop and a blocked analysis. Every role hands off with
[`report_result`](results.md#the-report_result-tool): Symphony posts the result comment and computes the next column;
the agents never change a status themselves.

**Workflow.** The test writes its own workflow to `<run dir>/WORKFLOW.md`, derived from the repository's
`WORKFLOW.md`. What a regression in the shipped configuration would break stays as shipped, so the run proves it:
the roles `issue-analyst`, `developer`, `test-engineer` and `reviewer` with their `on_result` targets,
`pipeline.profiles.bugfix` (`developer: {done: Testing}`), `pipeline.max_review_rounds` (3), `max_test_rounds` (2),
`pipeline.analysis: always`, `tracker.active_states`, the agent slots (`SYMPHONY_MAX_CONCURRENT_AGENTS`, 3 by default;
the reservations for the developer and the reviewer, one agent each in `Testing` and `Agent review`) and the tracker,
hook and Claude settings. Replaced are:

| Setting | Value |
|---|---|
| `claude.model` and the `claude.model` of every role | `sonnet`. The shipped reviewer asks for `opus`; `model_by_complexity` is dropped. |
| `checks.on_enter` | empty (`timeout_ms` 60000): the test issues change no code, so no entry check runs the repository's test suite. |
| `polling.interval_ms` | 10000 (shipped: 30000). Every stage starts at a poll, and the run has about 14 of them in a row. |
| `agent.max_issue_cost_usd` | 4: an issue that spent this much gets no new stage. A safety net, not part of the checks. |
| paths | The workspace root, the hook scripts (`$SYMPHONY_WORKFLOW_DIR`) and `claude.plugins` are made absolute, since the file lives in the run directory. |
| `laravel.boost` | `off` |
| prompt | "follow the section of the issue text for your role; tracker tools only". It prints the round and the number of failed test cases or open findings. |

**Issues.** Three issues with `Model: sonnet`, no dependencies, created in `Ready`. Each issue text has one section per
role that works on the issue, with the exact `report_result` input and a marker string (`E2E run P1 developed`, …) that
the agent puts into the summary. The test engineer and the reviewer decide by the `round` of their prompt: the number of
failed tests, respectively `changes_needed` reviews, before it, plus one.

| Issue | Analyst | Developer | Test engineer | Reviewer | Board path after `Ready` |
|---|---|---|---|---|---|
| P1 test loop | `ready`, type `bugfix`, complexity `S` | `done` (twice) | round 1 `failed` with one failed case, round 2 `passed` | `approved` | `In progress` → `Testing` → `In progress` → `Testing` → `Agent review` → `In review` |
| P2 review loop | `ready`, type `bugfix`, complexity `S` | `done` (twice) | `passed` (twice) | round 1 `changes_needed` with one `major` finding, round 2 `approved` | `In progress` → `Testing` → `Agent review` → `In progress` → `Testing` → `Agent review` → `In review` |
| P3 blocked analysis | `needs_info` with one open question | none | none | none | `Blocked` |

The analyst's `Type: bugfix` label (set by `report_result`, created in the repository when it is missing) is what picks
the `bugfix` profile for P1 and P2. There is no simulated review: the run ends as soon as no test issue is in an active
column and no agent runs. Every 3 s the test reads the issues' statuses into `timeline.jsonl` and the running agents
into `trace.log`.

**Checks** (`scripts/e2e/verify-pipeline.ts`, a pure function over the repository log lines, the status timeline and
the results read back from the issues; unit-tested in `test/e2e-pipeline.test.ts`):

| Check | Passes when |
|---|---|
| Status path | After `Ready`, each issue went the path of the table above. |
| Never `Done` | No issue was ever seen in `Done`, and each was seen on the board at all. |
| Stage results | Read back from the issue comments: P1 has `analysis:ready`, `implementation:done`, `test:failed`, `implementation:done`, `test:passed`, `review:approved`; P2 has `analysis:ready`, `implementation:done`, `test:passed`, `review:changes_needed`, `implementation:done`, `test:passed`, `review:approved`; P3 has `analysis:needs_info`. |
| Markers | Each result's summary carries the marker its issue text asked for. |
| Rounds | The `round` in each result's meta is the expected one (P1: test 1 `failed`, test 2 `passed`; P2: review 1 `changes_needed`, review 2 `approved`), the `stage_result` lines of the repository log agree with it, no round limit was reached and no issue carries `pipeline.limit_label`. |
| Profile | The results of P1 and P2 after the analysis were routed by the `bugfix` profile, and both issues carry `Type: bugfix`. |
| Blocked analysis | P3's only result is `analysis:needs_info` with at least one open question and the target `Blocked`; it had one session (the analyst) and was never in another column. |
| Run order | The sessions that handed off ran in stage order: the roles of the results above, one session per result. |
| Last session | Each issue's last session handed off, and no session failed or stalled. |
| Cost per role | All four roles ran, each with a cost above 0 (`cost_usd` of `run_finished`). |
| Model | Every run asked for `sonnet` and was answered by a Sonnet model. |
| Total cost | Above 0 and below `COST_CEILING_USD` (6 USD, `scripts/e2e/pipeline.ts`). |
| No code changes | As in the default scenario: no pull request and no `symphony/issue-<n>` branch. |

The report starts with a table of the cost per role (sessions, turns, models, USD) followed by the table per issue
(status path, sessions, turns, USD).

**Cost and duration.** About 14 sessions (P1 6, P2 7, P3 1), each a few turns with Sonnet: expect roughly 1–3 USD and
20–35 minutes with the 10 s poll interval, so the default `--timeout` is 60 minutes. These are estimates until the
reference run below is filled in; then tune the timeout, the poll interval and `COST_CEILING_USD` from the measured
values. The test issues stay open in `In review` and `Blocked`; close or archive them afterwards.

### Reference run

Not recorded yet. The live run needs a board and Claude usage, so it is a manual step: after the first passing
`npm run e2e -- --scenario pipeline`, enter its values here.

| Date | Duration | Cost | Sessions | Commit | Run directory |
|---|---|---|---|---|---|
| _(date)_ | _(minutes)_ | _(USD, total from the report)_ | _(number)_ | _(`git rev-parse --short HEAD`)_ | _(`logs/e2e/<timestamp>`)_ |

## Run directory

Each run writes to `logs/e2e/<timestamp>/`, which is ignored by git:

| File | Content |
|---|---|
| `run.json` | Start time, repository and the created issues (numbers, node ids, board items, dependencies) |
| `symphony.log` | Output of the Symphony instance |
| `state/` | Its log directory: history log and session transcripts. Test runs therefore do not appear in the statistics of your normal instance. |
| `trace.log` | Running agents every 5 s (every 3 s in the roles and pipeline scenarios) |
| `reviewer.log` | When each issue reached `In review` and when it was closed (default scenario) |
| `WORKFLOW.md`, `roles-check.sh`, `check-markers/` | Roles scenario: generated workflow, entry check script and its markers |
| `WORKFLOW.md` | Pipeline scenario: generated workflow |
| `timeline.jsonl` | Roles and pipeline scenarios: every observed status change, `{"at", "number", "status"}` per line |

Verify a run again later (`run.json` says which scenario it was):

```bash
node scripts/e2e/verify.ts logs/e2e/<timestamp>
```

## Notes

- A free slot or a freshly closed dependency is used at the next poll, so starts lag by up to
  `polling.interval_ms`.
- The test issues stay closed in the repository. Archive them on the board if they get in the way.
- A reference run on 2026-10-04 (limit 3, review delay 60 s, poll every 30 s) took about 6 minutes. Each issue
  finished in one turn for about 0.05 USD, 0.47 USD in total.

## Files

| File | Purpose |
|---|---|
| `scripts/e2e/run.ts` | Entry point (`npm run e2e`): preflight, Symphony instance, monitor, reviewer |
| `scripts/e2e/scenario.ts` | Scenario definition and setup on GitHub |
| `scripts/e2e/roles.ts` | Roles scenario: issues, generated workflow and entry check script |
| `scripts/e2e/pipeline.ts` | Pipeline scenario: issues, expected paths, results and markers, generated workflow |
| `scripts/e2e/derive.ts` | What the generated workflows share: absolute paths, Laravel Boost off, the file header |
| `scripts/e2e/verify.ts` | Checks and report; also usable on its own |
| `scripts/e2e/verify-roles.ts` | Checks of the roles scenario, unit-tested in `test/e2e-roles.test.ts` |
| `scripts/e2e/verify-pipeline.ts` | Checks and cost per role of the pipeline scenario, unit-tested in `test/e2e-pipeline.test.ts` |
| `scripts/e2e/context.ts` | Config from `WORKFLOW.md`/`.env`, board lookup and GitHub GraphQL helpers |

## Laravel integration test: `npm run test:laravel`

A separate, opt-in check of the Laravel integration against real software instead of the stand-in `php` and
`composer` scripts of `test/laravel.test.ts`. It needs no board and no Claude Code session, and it is not part of
`npm test` or `npm run check`.

Prerequisites: PHP 8.3 or newer and Composer on `PATH`, plus network access to Packagist. If one is missing, the
script prints `skipped: …` and exits 0.

```bash
npm run test:laravel             # builds, checks and removes the temp app
npm run test:laravel -- --keep   # keeps the temp directory and prints its path
```

In a temp directory it builds a fresh app with `composer create-project laravel/laravel` (13.x),
`filament/filament:^5.0`, `laravel/boost` (dev) and Pest (added if the skeleton lacks it), commits it and pushes it
to a bare `origin`. Then it asserts:

| Step | Passes when |
|---|---|
| Workspace hook | `hooks/laravel-env.sh` writes the SQLite settings to `.env`, `php artisan about` succeeds and `git status` stays clean. |
| Boost preparation | The Laravel integration's `prepare` generates `.claude/skills/filament-development/SKILL.md`, keeps every generated file out of `git status --porcelain`, pre-approves the read-only Boost tools, denies `tinker`, and logs `integration_prepared` with Laravel 13.x, Filament 5.x and `boost=ready`. |
| MCP handshake | `php artisan boost:mcp`, started from the prepared server spec, answers `initialize` and `tools/list`; the list contains `database-schema` and `search-docs` but not `tinker`. |
| Check script | `checks/laravel.sh` exits 0 on the fresh app and 1 after a failing Pest test is committed and pushed. |

The summary prints the PHP and Composer versions and the resolved Laravel, Filament, Boost and Pest versions. The
exit code is 0 only if every assertion passes. A run takes a few minutes, mostly for Composer; the Composer cache
makes later runs faster.
