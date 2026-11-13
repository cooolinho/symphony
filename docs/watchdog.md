# The Blocked watchdog

The watchdog keeps the pipeline moving. It watches the board's blocked column (`Blocked` in the shipped workflow), and
for every issue that lands there it:

1. collects the evidence: the blocking result or comment, the repository log, the orchestrator log, the newest session
   transcripts, `/api/v1/state`, the GitHub status page and the workspace's git state;
2. starts one read-only Claude session (`fable` by default) with the prompt from [`roles/watchdog.md`](../roles/watchdog.md);
   the session reports its finding with the tool `report_diagnosis`: cause, evidence, the finished comment and the
   column to go back to;
3. checks that recommendation against fixed rules, and then comments on the issue and moves it back, or keeps it
   blocked and adds `needs-human`.

It replaces the manual routine of asking a separate Claude session what went wrong, pasting its comment into the issue
and moving the card.

The watchdog is a separate process from the same image (`node src/watchdog/cli.ts`, compose service `watchdog`). The
orchestrator ignores the `watchdog` section. If the orchestrator hangs, the watchdog keeps running and logs the
unreachable API in its evidence.

## Start

```bash
docker compose --profile watchdog up -d watchdog
```

Or add `watchdog` to `COMPOSE_PROFILES` in `.env`. The service:

- mounts Symphony's `state`, `workspaces` and `brain` volumes **read-only**;
- has its own Claude Code home (`watchdog-claude`) and state (`watchdog-state`: `events.jsonl` and its own transcripts);
- mounts `./roles` so that a prompt edit needs no rebuild;
- reaches the orchestrator as `http://symphony:<SYMPHONY_PORT>` (`SYMPHONY_WATCHDOG_API_URL`);
- needs `GITHUB_TOKEN`, `GITHUB_PROJECT_NUMBER`, `GITHUB_REPOSITORY` and Claude credentials from `.env`, but no SSH key.

The orchestrator log in the evidence comes from `SYMPHONY_LOG_FILE`, which both compose files now set on the
`symphony` service (`/home/symphony/.local/state/symphony/symphony.log`, rotated to `symphony.log.1` at 50 MB). It only
takes effect after the `symphony` container is recreated; until then the evidence says "no log file".

One pass without the loop, e.g. to try a prompt change:

```bash
docker compose run --rm watchdog watchdog --once
```

## Modes

`watchdog.mode` (`SYMPHONY_WATCHDOG_MODE`), default `observe`. Roll out in this order:

| Mode | What it does |
|---|---|
| `observe` | diagnoses and logs (`events.jsonl`, stderr); no write on GitHub |
| `comment` | also posts the diagnosis as a comment with its recommendation; moves nothing |
| `act` | posts the comment, moves the issue back, or adds `needs-human` |

Check `events.jsonl` against the real blocks for a while in `observe`, then switch to `act`.

## The prompt

[`roles/watchdog.md`](../roles/watchdog.md) is the whole task of the session: how to work, the rules from experience
(e.g. "check githubstatus.com before trusting a `git fetch` error", "never send an issue back to Ready") and how the
comment looks. Refine it whenever a diagnosis was wrong. It is a Liquid template like the role prompts, with strict
variables:

| Variable | Content |
|---|---|
| `issue` | `identifier`, `title`, `url`, `labels`, `state`, `description` |
| `block` | `kind` (see below), `from` (the active column it came from, or null), `role`, `blockers` (`needs`, `description`), `summary`, `check_failed_for`, `comment_url`, `blocked_at` |
| `evidence` | `history`, `log`, `state`, `github_status`, `git` (texts), `transcripts` (`file`, `excerpt`), `comments` (`author`, `created_at`, `body`, markers removed) |
| `columns` | the active columns |
| `attempt`, `max_resumes` | the resume this would be, and the limit |
| `paths` | `sessions`, `repositories`, `log`, `workspace` (for the session to read further) |
| `mode` | the watchdog mode |

The file is read anew for every diagnosis. If it is missing or does not render, nothing is diagnosed and the error is
logged. Every watchdog comment carries the first 12 hex digits of the file's sha256, so you can tell which version of
the prompt made which decision.

`block.kind`:

| Kind | Found by |
|---|---|
| `result` | a result marker with the verdict `blocked` or `needs_info` that sent the issue to the blocked column |
| `round_limit` | a result marker with a loop verdict at the round limit |
| `check_failed` | a result marker with `check_failed_for` (`max_check_failures` reached) |
| `missing_result` | Symphony's comment "Stage ended without a result" |
| `free_text` | none of these: the newest `run_finished` line of the repository log names the column |
| `unknown` | nothing at all; the watchdog never moves such an issue on its own column guess |

Only evidence from the current block counts (newer than ten minutes before `status_updated_at`).

## The session

Model `watchdog.claude.model` (default `fable`), effort `high`, `max_budget_usd` per diagnosis. Permission mode
`dontAsk` with only `Read`, `Grep`, `Glob`, the brain's read tools and `report_diagnosis`; `Bash`, edits, web and
subagents are denied, no setting sources or plugins are loaded. Its environment has no tracker token. The working
directory is the issue's workspace (read-only mount), and Symphony's state directory is added as a readable directory.
`max_turns` (default 2) is the number of prompts: the task, then a reminder to call `report_diagnosis`. A session that
fails (usage limit, outage) is retried after `cooldown_ms`; it is no verdict on the issue. While the orchestrator holds
the watchdog's model (`model_holds` in `/api/v1/state`), the watchdog waits as well.

Its cost does not appear in Symphony's budget; it is in `events.jsonl` (`cost_usd`) and in the watchdog's log.

## Decision

The session recommends; `src/watchdog/decide.ts` decides:

| Diagnosis | Action |
|---|---|
| `infra_transient`, cause gone | resume |
| `infra_transient`, cause holds | wait, look again after `cooldown_ms` (not counted as a resume) |
| `environment`, `missing_result`, cause gone | resume |
| `question_answered`, confidence `high` | resume; the answer is in the comment |
| `needs_access`, `needs_human`, `round_limit`, `unknown`, low confidence, or the cause still holds | escalate: comment, `needs-human`, stays blocked |

The target is the session's `target_column`, else the column the issue came from. It escalates instead when the target:

- is not an active column;
- is the first active column (`Ready`) and the block did not come from the analysis role (Ready runs analysis and design again);
- is the documentation column while files changed since the docs hand-off lie outside `pipeline.docs_paths` (the docs
  role would block again);
- is the review column, the issue has no `manual-merge` label and the confidence is below `high` (an approval merges automatically).

Loop protection, read from the watchdog's own comments on the issue: at most `max_resumes` (default 2) resumes since the
newest human comment, at least `cooldown_ms` between two, and `settle_ms` after the issue entered the blocked column. A
block is handled once: the comment's marker records `blocked_at`.

## The comment

```
### 🛟 Watchdog

<the session's comment>

<sub>Symphony watchdog · cause `missing_result` · confidence high · → back to "In progress" (automatic resume 1/2) · prompt 3f9c1a0b2d4e</sub>
<!-- symphony:watchdog:v1 <base64url JSON> -->
```

The marker holds `action` (`resume`, `escalate`, `comment`), `cause`, `target`, `attempt`, `blocked_at`, `prompt_hash`
and `created_at`. Only markers in comments of Symphony's own account count.

Symphony normally passes only comments of other accounts to the next agent (`human_feedback`). A watchdog comment whose
marker says `resume` is passed on as well, under "Newest human comments", so the next stage reads the comment as its
task. Moving the issue back writes the usual `reset` marker (round counters start again, `needs-human` is removed).

## Configuration

```yaml
watchdog:
  mode: ${SYMPHONY_WATCHDOG_MODE:-observe}
  interval_ms: 60000
  settle_ms: 120000
  cooldown_ms: 600000
  max_resumes: 2
  prompt: roles/watchdog.md          # relative to WORKFLOW.md
  api_url: ${SYMPHONY_WATCHDOG_API_URL:-}
  log_file: ${SYMPHONY_WATCHDOG_LOG_FILE:-}
  claude:
    model: fable
    effort: high
    max_budget_usd: 3
    max_turns: 2
```

Unknown keys are errors. The watchdog reloads `WORKFLOW.md` like the orchestrator.

## Files

| Path (container) | Content |
|---|---|
| `~/.local/state/symphony-watchdog/events.jsonl` | one line per diagnosis: issue, block, cause, confidence, recommendation, decision, reason, action, cost, prompt hash, errors |
| `~/.local/state/symphony-watchdog/sessions/<workspace key>/<time>.jsonl` | transcripts of the diagnosis sessions |
| `~/.local/state/symphony-watchdog/heartbeat.json` | sign of life, written every 30 s and after each pass: `pid`, `mode`, `model`, `started_at`, `updated_at`, `last_tick_at`, `stopped_at` |

## Status on the dashboard

The orchestrator mounts `watchdog-state` read-only and reads `heartbeat.json` from `watchdog.state_dir`
(`SYMPHONY_WATCHDOG_STATE_DIR`, set by both compose files). `GET /api/v1/state` reports it as `health.watchdog`
(`running`, `mode`, `started_at`, `updated_at`, `last_tick_at`, `stopped_at`), and the overview shows a chip next to
"Tracker ok" and "Workflow gültig":

| Chip | When |
|---|---|
| **Watchdog läuft** (green) | the heartbeat is at most 2 minutes old; the tooltip names the mode and the last pass |
| **Watchdog gestoppt** (red) | the watchdog stopped (`stopped_at`), or its heartbeat is older than 2 minutes |
| none | no `watchdog.state_dir`, or the watchdog never ran (`health.watchdog` is null) |

`--once` writes no heartbeat. The orchestrator container needs a recreate to get the mount
(`docker compose up -d symphony`); the image must contain the directory `~/.local/state/symphony-watchdog`, which it
does from this version on, so the volume belongs to the `symphony` user on first mount.

```bash
docker exec symphony-watchdog tail -n 20 /home/symphony/.local/state/symphony-watchdog/events.jsonl
```

## Limits

- No notification besides the label and the comment.
- No changes to containers, workspaces or configuration: the watchdog only reads, comments, labels and moves.
- Issue contents are untrusted. The session can only read and has no token; every move goes through the rules above.
