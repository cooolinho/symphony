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
| `skipped`, `reset` | same as the kind | internal, recorded by Symphony without agent input |

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

A call runs these steps, one call at a time:

1. **Validate** the input (`parseResult`). An invalid result returns `invalid_result` with every problem; nothing runs.
2. **Route.** The target column is computed from the verdict, the profile and the round counters of the history
   loaded at session start (`resolveTransition`, see
   [Result-driven transitions](configuration.md#result-driven-transitions)). A configuration that cannot route the
   verdict returns `transition_error`.
3. **Guard.** The target passes the [transition guard](configuration.md#transition-guard) like a `set_status` call:
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
   the agent gets the denial as before. `check_timeout` and `check_error` never redirect.
4. **Comment.** The result comment (Markdown and marker) is posted. Its meta records the role, the run, the round, the
   profile, the workflow hash, the workspace commit, the entry check that cleared the move (`checks`; a pass reused
   from the check cache keeps the record of the check that ran; `null` when the column has no check) and the target.
   A failed post returns `comment_failed`; nothing is recorded.
5. **Move** the issue to the target with the adapter's `setStatus`, including [auto-merge](adapters/github-project.md#auto-merge)
   (the result then carries `auto_merge`, as with `set_status`). If the move fails after the comment, the call returns
   `status_failed`: the result stands, the agent ends its turn, and the next run finds the pending move in the marker.
6. **Labels.** At the round limit `pipeline.limit_label` is added (the default `needs-human` is created when the
   repository lacks it); every other result removes it when the issue carries it. Label failures and a missing custom
   label are returned as `warnings`; the result and the move stand.

The success result is `{kind, verdict, target, status, previous_status, round, reason, checks, comment_url, labels?,
auto_merge?, warnings?, note: "Result recorded — end your turn now."}`.

**One result per run.** Once the comment is posted, every further call of the run, with any input, returns the stored
outcome (`already_recorded: true` on success) without running the checks or touching the tracker. The tool writes only
after the guard allowed exactly the computed target; called without the guard's approval it refuses (`tool_error`).
