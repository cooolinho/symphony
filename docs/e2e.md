# End-to-end test: `npm run e2e`

Runs the orchestrator against a real board and checks two guarantees:

- no more than `agent.max_concurrent_agents` agents run at the same time, and
- no issue is started while one of its dependencies ("blocked by") is still open.

The test creates real issues and runs real Claude Code sessions, so use a dedicated test repository and board.
The agents only comment; they change no code.

## Requirements

- The `.env` and `WORKFLOW.md` of this checkout point to the test board and repository, the same setup as `npm start`.
  The issues are created in the first repository of `GITHUB_REPOSITORY`.
- The board has the columns `Ready`, `In progress`, `In review` and `Done` (see `STATUS` in `scripts/e2e/context.ts`).
- The repository has the label `Model: sonnet` (`npm run repo-init` creates it).
- No issue on the board is in an active state. Symphony would work on it too, so the test refuses to start.
- No Symphony instance runs on the port (`server.port`, or `--port`).
- Claude Code is logged in, as for normal operation.

## Scenario

All issues carry `Model: sonnet` and start in `Ready`. Each one asks the agent to set `In progress`, post one
comment (`Testlauf T<n> erledigt. Abhängigkeiten laut Tracker: …`) and hand off to `In review`.

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
```

| Option | Default | Description |
|---|---|---|
| `--env-file <path>` | `.env` next to `WORKFLOW.md` | dotenv file for the test and the Symphony instance |
| `--port <n>` | `server.port`, else 4000 | dashboard/API port of the test instance |
| `--review-delay <s>` | 60 | How long an issue stays in `In review` before the simulated review closes it. Keep it longer than the poll interval, so that every dependency is visibly finished but still open for at least one poll. |
| `--timeout <min>` | 45 | Give up and stop Symphony after this many minutes. |

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

## Run directory

Each run writes to `logs/e2e/<timestamp>/`, which is ignored by git:

| File | Content |
|---|---|
| `run.json` | Start time, repository and the created issues (numbers, node ids, board items, dependencies) |
| `symphony.log` | Output of the Symphony instance |
| `state/` | Its log directory: history log and session transcripts. Test runs therefore do not appear in the statistics of your normal instance. |
| `trace.log` | Running agents every 5 s |
| `reviewer.log` | When each issue reached `In review` and when it was closed |

Verify a run again later:

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
| `scripts/e2e/verify.ts` | Checks and report; also usable on its own |
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
