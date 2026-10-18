# Result contracts

Every agent stage of the multi-agent pipeline reports a typed, validated and versioned result instead of free text.
Symphony renders it as an issue comment and reads it back from a hidden marker, so later stages, round limits and the
dashboard work from structured data. The contracts live in `src/workflow/results.ts`; agents report through the
[`report_result` tool](#the-report_result-tool) (`src/orchestrator/result-tool.ts`).

## Envelope

| Field | Set by | Content |
|---|---|---|
| `schema` | Symphony | `symphony.result/v1` |
| `kind` | Symphony | the stage kind (see below) |
| `verdict` | agent | one of the kind's verdicts, required |
| `summary` | agent | 1–4000 characters of Markdown, required |
| `blockers[]` | agent | `{description, needs: human\|info\|access\|infra}` |
| `follow_ups[]` | agent | work worth a separate issue |
| `omitted_findings` | Symphony | findings dropped to respect the size cap |

Only `verdict` and `summary` are required; every other field is optional, lists default to `[]`. Unknown fields are
reported to the agent instead of being dropped silently.

## Kinds

| Kind | Verdicts | Fields |
|---|---|---|
| `analysis` | `ready`, `needs_info` | `type`, `complexity` (S/M/L/XL), `components[]`, `acceptance_criteria[]`, `risks {security, data_migration, breaking_change}`, `docs_needed`, `open_questions[]`, `plan[]` |
| `design` | `ready`, `blocked` | `options[]`, `decision`, `interfaces[]`, `migrations[]`, `compatibility`, `work_packages[]` |
| `implementation` | `done`, `blocked` | `changed_files[]`, `tests_added[]`, `notes`, `plan_deviations[]` |
| `test` | `passed`, `failed`, `blocked` | `cases[] {criterion, test, status: passed\|failed\|skipped}`, `commands[]`, `uncovered_criteria[]` |
| `review` | `approved`, `changes_needed`, `blocked` | `findings[] {severity: blocker\|major\|minor\|nit, file, line, problem, fix}`, `checked[]` |
| `security` | `passed`, `issues_found`, `blocked` | `findings[]` (as in `review`) |
| `docs` | `done`, `not_needed`, `blocked` | `files[]` |
| `skipped`, `reset` | same as the kind | internal, recorded by Symphony without agent input (`skipped`: a stage passed [without a session](configuration.md#skipping-stages-without-a-session)) |

## Consistency rules

- `blocked` needs at least one blocker.
- `approved` (review) and `passed` (security) allow no `blocker` or `major` findings; `changes_needed` and
  `issues_found` need at least one finding.
- `failed` (test) needs a case with status `failed`; `passed` allows none.
- `needs_info` (analysis) needs at least one open question.

`parseResult(kind, input)` checks the schema, these rules and the size, and returns every problem in one message the
agent can act on, e.g. ``- `findings[0].severity`: Invalid option: expected one of "blocker"|"major"|"minor"|"nit"``.

## Meta

Symphony adds facts the agent never sets: `role`, `run`, `round`, `profile`, `workflow_hash`, `head_sha`, `checks`
(summary of the entry check: result, exit code, duration, commit), `target` (the column the stage hands over to) and
`created_at`.

## Comment and marker

`renderResultComment(result, meta)` returns the Markdown section (`renderResultMarkdown`) followed by the marker
(`encodeMarker`):

```
<!-- symphony:result:v1 <base64url(JSON of the result plus meta)> -->
```

- Base64url contains no `>`, so values such as `-->` cannot end the marker early. Agent text in the Markdown section
  cannot open an HTML comment (`<!--` is escaped), so it can neither hide the rest of the comment nor fake a marker.
- `decodeMarker(text)` reads the last marker of a comment and returns `{result, meta}`, or `null` when there is none or
  it is damaged (bad base64, bad JSON, unknown schema version, invalid fields). It never throws.
- Size cap: the comment stays below 60,000 characters (GitHub allows 65,536). Above it, the least severe findings are
  dropped first and counted in `omitted_findings`; the Markdown notes the omission. A result that does not fit even
  without findings is rejected (`result_too_large`).

## The `report_result` tool

A role with [`result`](configuration.md#result-driven-transitions) hands off with the tracker tool `report_result`
(`mcp__tracker__report_result`) instead of `set_status`: such a role never gets `set_status` (`toolsForRole`), so a
stage cannot end just because the agent moves the issue. The tool is built per session; its input is the kind's agent
fields (`verdict`, `summary`, the common and the kind-specific fields above). The worker builds it at session start,
after reading the issue's persisted results (`readResults`, `buildStageHistory`): the round counters come from that
history, and the same history fills the prompt variables `results`, `round` and `result_required` (see
[Prompt template](configuration.md#prompt-template)). Roles without `result` get neither the tool nor the read. If the
read fails, the run ends as `failed` with the code `results_read_error` and is retried like any failed run; no session
starts without the history.

If the newest marker handed the issue to a column that is not active (a round limit or Blocked) but the issue now sits
in an active column, a human moved it back. The session start then posts a `reset` marker (role `symphony`), removes
`pipeline.limit_label` and rebuilds the history, so the round counters start at 1. Nothing else writes a `reset`.
A result whose move to such a column failed (`status_failed`, step 6 below) looks the same, so the next session resets
the rounds then too; telling the two apart is [#210](https://github.com/cooolinho/symphony/issues/210).

A call runs these steps, one call at a time:

1. **Validate** the input (`parseResult`). An invalid result returns `invalid_result` with every problem; nothing runs.
2. **Route.** The target column is computed from the verdict, the profile and the round counters of the history
   loaded at session start (`resolveTransition`, see
   [Result-driven transitions](configuration.md#result-driven-transitions)). A configuration that cannot route the
   verdict returns `transition_error`.
3. **Guard.** For a role with `result: test`, the [path rule](#path-rule-of-the-test-engineer) comes first. The
   target passes the [transition guard](configuration.md#transition-guard) like a `set_status` call:
   `may_move_to`, then the column's entry check. `check_failed`, `check_timeout` and `check_error` return the guard's
   message (naming `report_result`) and write nothing, so a failed check never counts as a round and the agent can
   fix the problem and report again in the same session. On `check_error` the agent is told to comment and end its
   turn instead of moving the issue to `Blocked`, which it cannot.
   **`on_check_failed`:** a `check_failed` for a `read_only` role that sets [`on_check_failed`](configuration.md#roles)
   (it cannot fix the code, so repeating the report is pointless) does not stop the call: the guard checks the
   `on_check_failed` column instead (`may_move_to`, that column's entry check), and the result is recorded with the
   agent's verdict, a note with the failed check's output appended to the summary, `checks` of the failed check and
   `target` of the fallback column. The result then carries `check_failed_for` (the column whose check failed) and the
   round limit label is neither added nor removed. If the fallback is the column that failed, or its own check fails,
   the agent gets the denial as before. `check_timeout` and `check_error` never redirect. A session whose newest entry
   check timed out ends after the turn without a reminder: a timeout is a runtime limit, not a missing result.
4. **Confirm the column.** Right before writing, the tool re-reads the issue. If it has left the role's columns (a
   human moved it while the agent worked or the check ran), it returns `issue_moved` and writes nothing, so a result
   never moves an issue back; if the read fails, it returns `tracker_error` and the agent may report again.
5. **Comment.** The result comment (Markdown and marker) is posted. Its meta records the role, the run, the round, the
   profile, the workflow hash, the workspace commit, the entry check that cleared the move (`checks`; a pass reused
   from the check cache keeps the record of the check that ran; `null` when the column has no check) and the target.
   A failed post returns `comment_failed`; nothing is recorded.
6. **Move** the issue to the target with the adapter's `setStatus`, including [auto-merge](adapters/github-project.md#auto-merge)
   (the result then carries `auto_merge`, as with `set_status`). If the move fails after the comment, the call returns
   `status_failed`: the result stands (its marker keeps the `target`), the labels stay as they are, the agent ends its
   turn and the issue stays in its column; the stage runs again in a later session (see
   [Failures of result-driven stages](usage.md#failures-of-result-driven-stages)).
7. **Labels.** After the move, at the round limit `pipeline.limit_label` is added (the default `needs-human` is created when the
   repository lacks it); every other result removes it when the issue carries it. Label failures and a missing custom
   label are returned as `warnings`; the result and the move stand.

The success result is `{kind, verdict, target, status, previous_status, round, reason, checks, comment_url, labels?,
auto_merge?, warnings?, note: "Result recorded — end your turn now."}`.

**One result per run.** Once the comment is posted, every further call of the run, with any input, returns the stored
outcome (`already_recorded: true` on success) without running the checks or touching the tracker, and the run ends
after the turn that recorded the result; when the move led to another column of the same role, its stage starts in a
new session. The tool writes only
after the guard allowed exactly the computed target; called without the guard's approval it refuses (`tool_error`).

## Path rule of the test engineer

A role with `result: test` (the [test engineer](configuration.md#the-test-engineer)) may only change test files. Right
before a result reaches the guard (step 3), `report_result` compares the workspace with a baseline commit: the head the
developer's newest finished `implementation` result recorded (`head_sha`) when `HEAD` descends from it, else the commit
the session started from. It looks at the files committed since, changed or deleted in the working tree or the index,
and untracked ones (ignored files do not count; a renamed file counts at both ends). Every file that matches none of the globs of
`pipeline.test_paths` ([path globs](configuration.md#path-globs)) refuses the result:

```
invalid_result: The test result is invalid: role test-engineer may only change files matching `pipeline.test_paths`
(tests/**, test/**, **/*.test.*, **/*Test.php), but 1 file(s) that differ from commit 0123456789ab (the developer's last
hand-off, else where your session started) are outside them:
- src/app.ts
Nothing was recorded. Undo the changes you made yourself: restore a changed or deleted file with
`git checkout 0123456789ab -- <file>`, delete a new one, commit, and report again. Leave a file alone that you did not
change, … describe it in an issue comment and end your turn. …
```

- It applies to every verdict, `blocked` and `failed` included, and comes after the input check: an invalid result is
  reported as `invalid_result` without looking at the files.
- Nothing is recorded or moved, and the entry check of the target column does not run, so the engineer does not wait
  for a check that cannot lead to a result. The call may be repeated in the same session once the files are restored.
- Over 25 offending files, the message lists the first 25 and counts the rest.
- If git cannot list the changes, or the session has no start commit (the workspace is no git checkout), the call fails
  with `tool_error` and nothing is recorded; the rule is never skipped.
- Roles with another `result` are not restricted.

The tool declares the check as `precheck`, which `guardTools` runs for a call with a target before it asks the guard.

## Stages without a result

A run of a result-driven role never ends silently. When a turn ends with the issue still in the role's column and no
result recorded (the tool reports it to the worker the moment the result comment is posted), the next turn is a
reminder: Symphony appends a mandatory hint to the continuation prompt (the default and a custom
`agent.continuation_prompt` alike). It tells the agent to call `report_result` (verdict `blocked` if it cannot
finish) and names the column the issue moves to otherwise.

The run ends without a result when the reminder turn did not produce one, or when `max_turns` is reached first (with
`max_turns: 1` there is no reminder). The orchestrator then handles it in `#endStageWithoutResult`:

1. It **re-fetches** the issue. If it is no longer in one of the role's columns (a human or another run moved it),
   nothing is changed and the usual continuation follows.
2. Otherwise it posts a plain comment ("Stage ended without a result", no marker, so it never counts as a stage
   result) and moves the issue to the role's [`on_missing_result`](configuration.md#roles) (`Blocked` by default),
   then releases the issue.
3. A tracker error while fetching or moving schedules a retry like a failed run.

A run whose newest entry check timed out (`check_timeout`) is not a missing result: it ends without the reminder turn,
and the stage runs again in a continuation session. Roles without `result` are not affected.

## Scenario tests

`test/pipeline-flow.test.ts` drives the developer → reviewer loop end to end without Claude: the real orchestrator,
worker, transition guard, entry checks and `report_result` tool, with scripted sessions (`FakeRunner`; `callTool` in
`test/helpers.ts` calls a session tool the way the agent does), an in-memory board (`FakeTracker`) and manual timers.
It covers an approval in round 1, two `changes_needed` rounds before an approval, the round limit, a developer
`check_failed` fixed in the same session, a failed reviewer check (`on_check_failed`), forged markers, a stage without a
result, a restart mid-review, duplicate `report_result` calls and a session limit during the review. The failure paths
of [Failures of result-driven stages](usage.md#failures-of-result-driven-stages) each have a scenario there too: a move
that fails after the result comment (once, and every time), `check_timeout` inside `report_result`,
`tracker_rate_limited` while reading the results, a check that outlasts the stall timeout, a workflow reload mid-stage,
damaged markers, and a human moving the issue during the session.

The `test engineer stage` suite in the same file runs developer → test engineer → reviewer in a real git workspace: a
pass, a test engineer that changes `src/` (refused with `invalid_result`, no entry check, accepted once undone), uncommitted
and untracked changes, a workspace that is no git checkout, `failed` with the failed cases in the developer's prompt and
the engineer's next round, the round limit (`Blocked` with `needs-human`), a human resuming the issue, `max_test_rounds` 1
and `blocked`. The rule itself is unit-tested against temporary git repositories in `test/changed-files.test.ts`.
