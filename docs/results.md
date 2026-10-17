# Result contracts

Every agent stage of the multi-agent pipeline reports a typed, validated and versioned result instead of free text.
Symphony renders it as an issue comment and reads it back from a hidden marker, so later stages, round limits and the
dashboard work from structured data. The contracts live in `src/workflow/results.ts`; the tool that uses them and
reading comments back from GitHub follow separately.

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
