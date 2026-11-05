# Agent runner: Claude Code

Each run attempt starts one **Claude Code** session through the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) (`@anthropic-ai/claude-agent-sdk`), which bundles the
Claude Code CLI. The spec targets the Codex app-server; this section documents how its contract maps to Claude Code.

## Session model

| Spec concept | Claude Code |
|---|---|
| App-server subprocess | Claude Code CLI, started by the SDK in the issue workspace (`cwd`), as the leader of a new process group |
| Thread (`thread_id`) | Claude session id: a UUID Symphony generates and passes as `sessionId` |
| Turn (`turn_id`) | One user message on the live session (streaming input), numbered 1, 2, …; `session_id` = `<thread_id>-<n>` |
| Turn completed / failed | The `result` message for that turn: `success` without `is_error` completes it, anything else fails it |
| Continuation turn | Another user message on the same live session with the continuation prompt |
| Startup handshake | `initializationResult()`, bounded by `claude.read_timeout_ms` |
| Session title | `<identifier>: <title>` |
| Model | A `Model: <model>` label on the issue (unless the role has `model_label: ignore`), else the role's `model_by_complexity` for the issue's complexity, else the role's `claude.model`, else `claude.model` ([configuration](configuration.md#model-per-issue)); fixed for the session |
| Effort | An `Effort: <level>` label on the issue (unless the role has `effort_label: ignore`), else the role's `claude.effort`, else `claude.effort` (`CLAUDE_EFFORT` in the shipped `WORKFLOW.md`) ([configuration](configuration.md#effort-per-issue)); fixed for the session |
| Role | The [role](configuration.md#roles) of the issue's column at dispatch (`default` without roles); fixed for the run. Its `claude` overrides are merged into the session settings, `read_only` sets the policy below, `max_turns` limits the turns |
| MCP servers | The in-process `tracker` server, plus workspace extensions such as Laravel Boost (below); nothing else with `claude.strict_mcp_config` (default) |

Before launching, the runner checks that the working directory is an absolute, normalized path; the workspace
manager has already checked that it lies inside the workspace root.

## Permission and safety posture

Symphony runs agents **unattended**. Nobody watches a session, so every decision is made by configuration:

- **`claude.permission_mode: auto` (default):** Claude Code's classifier approves routine actions (editing files,
  running tests, local git) and blocks risky ones. When it cannot decide, it asks Symphony.
- **`claude.on_permission_request: deny` (default):** that question is answered with *no*, and the agent gets an
  explanation so it can take another route. `approve` answers *yes* instead (a high-trust setup; every approval is
  logged as `approval_auto_approved`).
- **`claude.allowed_tools`:** actions the workflow always needs, e.g. `Bash(git push:*)`, so the agent can push its
  branch without asking.
- **`claude.by_model`:** permission overrides per model. Haiku has no `auto` mode; Claude Code then starts the session in
  `default` and `on_permission_request: deny` refuses every Bash and Write call. The shipped `WORKFLOW.md` therefore runs
  Haiku with `permission_mode: acceptEdits` and `allowed_tools: [Bash, Read, Write, Edit]`
  ([details](configuration.md#permissions-per-model)).
- **Tracker tools** (`mcp__tracker__*`) are always allowed. They run inside Symphony with the GitHub token. The agent
  process never receives tracker credentials: they are removed from its environment. A tool failure reaches the
  agent as an error result `{error: {category, message}}`. Besides the adapter's own categories, tools that change
  the issue's column return the [transition guard](configuration.md#transition-guard) categories
  `transition_denied` (terminal column or outside the role's `may_move_to`), `check_failed` (the entry check exited
  `1`; the message carries its output), `check_timeout` (the check ran into `checks.timeout_ms`; the issue keeps its
  column) and `check_error` (the check could not run properly). `report_result` adds `invalid_result`
  (also for a test engineer's changes outside `pipeline.test_paths`), `transition_error`, `comment_failed` and `status_failed` ([results.md](results.md#the-report_result-tool)). A thrown
  error becomes `tool_error`.
- **`report_result`** is the tracker tool of the pipeline roles. A [role](configuration.md#roles) with `result` gets it
  (built per session, together with the issue's stage history) and does **not** get `set_status`: the agent reports a
  typed result with a verdict, and Symphony posts it as the issue comment, computes the target column and moves the
  issue through the transition guard. Roles without `result` keep `set_status` and never see `report_result`. The agent
  hands off once per run; after a success it ends its turn. Input, steps, errors and the one-result-per-run rule are in
  [results.md](results.md#the-report_result-tool).
- **User input:** `AskUserQuestion` is disabled. If a question still reaches the permission callback, it is answered
  automatically ("nobody can answer; decide yourself or ask on the issue"), an event `turn_input_required` is
  recorded, and the turn continues. A run therefore never waits for a human.
- **Settings:** only the repository's project settings are loaded by default (`setting_sources: [project]`). Your
  personal `~/.claude` settings, plugins and hooks are not. Plugins listed in `claude.plugins` (Symphony's own
  `.claude` toolbox in the shipped `WORKFLOW.md`) are loaded explicitly.
- **MCP servers:** `claude.strict_mcp_config: true` (default) sets the SDK's `strictMcpConfig`, so only the servers
  Symphony passes load. A repository's `.mcp.json` (which the `project` setting source would otherwise load without
  approval), user settings, plugin-provided MCP servers (Symphony's `.claude` plugin ships none today; strict mode
  would ignore them) and the logged-in account's claude.ai connectors (mail, drive, …) are ignored. The in-process
  `tracker` server is passed explicitly and is not affected.
- **Laravel Boost tools** (`mcp__laravel-boost__*`) are not allowed as a whole. Pre-approved are the tools that read
  the application: `application-info`, `browser-logs`, `database-connections`, `database-query` (Boost enforces
  read-only), `database-schema`, `get-absolute-url`, `last-error`, `read-log-entries`, plus `search-docs` (sends the
  query and the package list to boost.laravel.com). Denied are `tinker` (runs arbitrary PHP; allowed with
  `laravel.allow_tinker: true`) and every tool in `laravel.deny_tools` (default `[record-rule]`, which writes
  `.ai/rules`); a denied tool is also dropped from the pre-approved list. Tools of later Boost versions are not
  pre-approved on purpose: they go through the permission mode, and `canUseTool` denies them by default.
- **Per-server MCP tool policy:** each extension server (`StdioServer`) carries `autoApprove` and `deny`.
  `autoApprove: 'all'` (the default) allows the bare `mcp__<server>`, i.e. every tool of the server. A list such as `['search-docs']` allows only `mcp__<server>__search-docs`; the server's other tools go
  through the permission mode (the `auto` classifier). `deny` lists bare tool names that are added to
  `disallowedTools` as `mcp__<server>__<tool>`, so the agent cannot call them at all.
- **Read-only sessions:** a session started with `policy: { readOnly: true }` gets `Edit`, `Write`, `NotebookEdit`,
  `Bash(git commit:*)` and `Bash(git push:*)` added to `disallowedTools`. Deny rules beat allow rules, so this also
  overrides `claude.allowed_tools: ["Bash(git push:*)"]`. The orchestrator sets `readOnly` from the run's role
  (`roles.<role>.read_only`); without a policy, or for the `default` role, a session is not read-only. This is a
  policy, not a sandbox. Both inputs are agent-neutral; another runner maps them to its own mechanism.
  - *Covered, also inside subagents:* `Edit`, `Write`, `NotebookEdit`, `git commit` and `git push`. The deny rules
    are session-wide: Claude Code applies deny rules and the `PreToolUse` hook to a subagent's tool calls, and
    `canUseTool` answers a subagent's request (`agentID`) like a main-thread one. So a read-only role's subagent
    cannot edit files, and a denied subagent cannot be spawned from inside another subagent either. Locked in by
    the tests "refuses a denied subagent spawned from inside a subagent", "treats a subagent permission request like
    a main-thread one" and "keeps the read-only deny rules whatever subagents are denied" in `test/claude.test.ts`.
  - *Not covered:* shell writes through Bash (`sed -i`, `perl -pi`, redirection, `node -e` with file writes), in the
    main thread and in subagents. Callers that need a hard guarantee must enforce it elsewhere (for example in the
    transition guard, or with `claude.sandbox`). Blocking them is open question 5 in
    [concepts/subagents.md](concepts/subagents.md#open-questions-and-spikes); the current assumption is (a),
    document and keep.
  - *Live check:* **not executed yet.** The workspace of E4-1 had no Claude login (`Not logged in · Please run
    /login`, Claude Code 2.1.288). To run it: in a temp git repo with `target.txt`, start `claude -p "<ask a
    general-purpose subagent to edit target.txt>" --output-format stream-json --verbose --model haiku
    --permission-mode acceptEdits --disallowedTools Edit Write NotebookEdit "Bash(git commit:*)" "Bash(git push:*)"
    AskUserQuestion`, then expect an error `tool_result` for the subagent's Edit/Write (`parent_tool_use_id` set)
    and an unchanged file. Record the session id here.
- **Sandboxing:** off by default. `claude.sandbox` passes Claude Code's sandbox settings through (filesystem and
  network restrictions for shell commands).

Stricter alternatives: `permission_mode: dontAsk` with an explicit `allowed_tools` list (only listed tools run), or
`sandbox: { enabled: true }`. A fully trusted setup: `permission_mode: bypassPermissions`.

**Trust boundary:** agents run as your OS user. Even with secrets removed from their environment, a determined or
prompt-injected agent could read files your user can read (for example Symphony's own `.env`) unless the permission
mode, classifier or sandbox stops it. Issue text is untrusted input. For stronger isolation run Symphony under a
dedicated OS user or in a container or VM, and narrow `tracker.provider.repositories`.

## Skills and plugins

A session sees three kinds of skills:

| Source | Location | Name |
|---|---|---|
| The repository | `.claude/skills/<name>/SKILL.md` in the clone (project settings) | `<name>` |
| Laravel Boost | generated into the Laravel app's `.claude/skills/` (below) | `<name>`, e.g. `laravel-best-practices`, `testing-best-practices`, `filament-development` |
| Symphony's toolbox | `.claude/skills/` next to `WORKFLOW.md`, loaded as the plugin `symphony` via `claude.plugins` | `symphony:<name>` |

`claude.skills: all` enables all of them and the Skill tool. Plugin skills are namespaced, so they never collide with
a repository's skills. The `session_configured` event lists the loaded plugins, the number of skills and the status of
every MCP server; a plugin that fails to load is logged as a warning.

### Skills for issue commands

An issue whose description starts with `/<name>` asks for the skill of that name (see
[issue commands](configuration.md#issue-commands)). Symphony does not rely on Claude Code to recognise the slash in the
middle of its own prompt: it resolves the command against `skills/<name>/SKILL.md` in `claude.plugins` and the shipped
prompt tells the agent to load `symphony:<name>` with the Skill tool first. The toolbox ships six:

| Command | Skill | Role | What it does |
|---|---|---|---|
| `/refactoring [scope]` | `symphony:refactoring` | `auditor` (read-only, no entry checks) | Detects the stack (PHP, Laravel, Filament, Livewire, Pest, Vite, …), measures a baseline, finds bugs and refactoring candidates with Laravel Boost's `search-docs` and schema tools, then files them as sub-issues in `Backlog` with `create_sub_issue` and posts one report comment. The issue becomes the epic. |
| `/refactor-safely` | `symphony:refactor-safely` | `developer` and `reviewer` | Behaviour-neutral refactoring: characterization tests first, existing assertions untouched, no change to routes, config, schema or public signatures. The reviewer checks the test diff for removed assertions. The audit puts this command on the first line of each refactoring sub-issue. |
| `/auto-code [description] [wave=3] [checkpoint=5] [issue-models=auto]` | `symphony:auto-code` | `autopilot` (read-only, no entry checks, waits for its sub-issues) | Autopilot: reads the project description, roadmap, code on the base branch and the human's comments on the epic, and files the next wave of features, design, quality and maintenance work as sub-issues that start in `Ready` right away (with `issue-models=auto|opus|sonnet|haiku` each one also gets a `Model: …` label, so it does not run with the default model). The epic stays active and runs again when the wave is closed; every few waves it stops at a checkpoint with a report and a release pull request. See [usage.md](usage.md#autopilot-auto-code). |
| `/concept <file.md> [issue-models=auto]` | `symphony:concept` | `analyst` (read-only, no entry checks) | Reads a concept document from the repository, checks what the code already has, and files the work as a tree in `Backlog`: epics as sub-issues of the concept issue and the work items as sub-issues of the epics (`create_sub_issue` with `parent`). Each item gets `Blocked by` dependencies (text line and GitHub relationship via `blocked_by`), a category, one `Effort: …` and, unless `issue-models=off`, one `Model: …` label. It posts a plan comment before creating anything and a report afterwards, then moves the issue to `In review`. A human moves the items to `Ready` one by one. See [usage.md](usage.md#concept-to-backlog-concept). |
| `/plan [<file>] [issue-models=auto]` | `symphony:plan` | `planner` (read-only, no entry checks) | Takes a list, either a file in the repository or the list below the command line in the issue description, and files every top-level item as exactly one sub-issue of the plan issue in `Backlog`, without epics. Each issue gets the quoted item, the starting point in the code, a numbered implementation plan, acceptance criteria and tests, `Blocked by` dependencies between items (text line and `blocked_by`), the `plan` label, a category, one `Effort: …` and, unless `issue-models=off`, one `Model: …` label. It posts an outline comment before creating anything and a report afterwards, then moves the issue to `In review`. See [usage.md](usage.md#list-to-backlog-plan). |
| `/brain-garden` | `symphony:brain-garden` | `brain-gardener` (read-only, no entry checks) | Tends the knowledge vault: reads the repository index, calls `brain_vitals`, looks for duplicates, orphans and broken links and writes each proposal as a candidate note in `Inbox/`. It never promotes and never writes to approved notes (`brain_approved_writes: false`), posts one comment with the proposals and moves the issue to `In review`. See [brain.md](brain.md#gardener). |

A role stays read-only after the skill is loaded: `read_only: true` denies Edit, Write, `git commit` and `git push`,
but the tracker tools stay available, so the auditor can file sub-issues. Skill instructions that Bash could still
bend (`pint` without `--test`, `npm audit fix`, `composer update`) are forbidden in the skill text itself. A new command
needs a skill directory in the toolbox and a role with `commands` (or none at all, if the role is the developer).

### Subagents

Plugins also ship subagents (`agents/<name>.md`), which Claude Code offers to the Agent tool as `<plugin>:<name>`;
the `init` message of the transcript lists them under `agents`. Symphony's toolbox ships five for Laravel repositories
(`laravel-architect`, `laravel-code-reviewer`, `laravel-database-engineer`, `laravel-filament-developer`,
`laravel-test-engineer`) and the framework-neutral `explorer`, `design-critic` and `test-designer`. Which of them a session may start depends on the role's `agents`, read-only roles and the
workspace's project type ([Subagents per role](configuration.md#subagents-per-role)); the rest are denied by an
`Agent(<plugin>:<name>)` rule in `disallowedTools` and by a `PreToolUse` hook, which emits `approval_denied` when it
refuses a call. Every Agent tool call carries its subagent in the `tool_use` event (`detail.agent`), so the statistics
count subagents like skills. Background and usage figures: [laravel-subagents.md](laravel-subagents.md).

#### Delegation line of the `claude_code` preset (spike E0-1)

Checked in Claude Code 2.1.288, bundled with SDK 0.3.288 as the native binary
`node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude` (there is no `cli.js`; the JavaScript is minified inside
the binary, found with `rg -a`; line numbers are those of `rg -a -n`).

- The line is the system prompt section `opus5_reduced_delegation` (line 1410307, `jf("opus5_reduced_delegation", …)`).
  Its text, defined at line 1410261 (`QPt`): "Do not use the Agent tool, workflows, or deep-research unless the user, a
  CLAUDE.md file, or a skill asks for it". It is skipped when the project's own prompt (`JPt()`) already contains that
  text or the older "Do not call the AgentTool unless the user".
- The gate is `Sbn(model)` (line 1404855): the resolved model needs the capability **`opus_5_prompt_bundle`** in the
  model table (line 1401403) and the feature flag `tengu_fennel_godwit` must be off (it is off by default); the flag
  `tengu_slate_bittern` (default on) must be on as well. The capability is not derived from the model name.

| Model | Capabilities relevant here | Delegation line |
|---|---|---|
| `claude-opus-5-5` | `opus_5_5_prompt_bundle`, no `opus_5_prompt_bundle` | **no** |
| `claude-sonnet-5-5` | neither prompt-bundle capability | **no** |
| `claude-fable-5-1` | `fable_5_1_prompt_bundle`, no `opus_5_prompt_bundle` | **no** |
| `claude-opus-5` (for comparison) | `opus_5_prompt_bundle` | yes |

Limit: the capability table is the static one of this build; Claude Code can also take capabilities from the server
(`servedCapabilityLookup`, client data), which a static reading cannot see. The result holds for 2.1.288 as bundled.

**Probe runs (Agent calls without and with a delegation sentence).** Run on 2026-11-05, 21:50–21:57 UTC, in the
`symphony` container with SDK 0.3.288 / Claude Code 2.1.288; each combination 3 times (18 runs). Set-up:
`systemPrompt: { type: 'preset', preset: 'claude_code', append }`, default tool set, `permissionMode: 'dontAsk'` with
only `Agent` allowed, `settingSources: []`, `maxTurns: 8`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, subagent
`word-counter` (no tools) via `options.agents`. Task: "Count the words in the sentence "the quick brown fox jumps over
the lazy dog" using the word-counter subagent, then tell me the number." `append` without: "Context: this is a test
session."; with the delegation sentence: "When a task names a subagent, delegate it with the Agent tool." Counted: the
`Agent` `tool_use` blocks of the main agent.

| Model | Agent calls without (3 runs) | Agent calls with (3 runs) | Session ids without | Session ids with |
|---|---|---|---|---|
| `claude-opus-5-5` | 1, 1, 1 | 1, 1, 1 | `b5683081-d15c-422a-859d-9fe899acc4c4`<br>`fc9adb95-15bf-46a7-8850-58f80511a032`<br>`d702b01d-b0ab-4c89-b1b8-9b8db21baf90` | `436a7174-c2a2-4541-8317-cbc734b55eba`<br>`b6847b8a-0dde-4880-aeac-cc485d85b690`<br>`e50b5db9-9403-44d5-8140-c14ecfbee7d9` |
| `claude-sonnet-5-5` | 1, 1, 1 | 1, 1, 1 | `e1891d34-370d-432a-8f63-063b2c18184b`<br>`49c6854b-117d-407f-8ff1-50e778856357`<br>`27e4b04b-059e-41b0-8e1e-19f10b84291e` | `88165b66-c91f-45f7-8b1a-cf77071a4127`<br>`796e2fd8-e1ea-46ae-b138-ef502f4f3799`<br>`4187eec4-ee69-4815-b38b-6ac8093f965a` |
| `claude-fable-5-1` | 1, 1, 1 | 1, 1, 1 | `4e63278a-e3a4-4280-87e9-bdc3ea9bd907`<br>`8b42863e-8b02-4cd4-9d4d-f4a52f54d668`<br>`8fcdb8ad-a5ca-4744-9a03-4c549586b8fd` | `a6c0f736-4ce8-4e35-9627-fa3fa9494fbc`<br>`9a2fa59e-73a2-4ba7-8af7-d43e1142281b`<br>`56f58c54-e000-427c-b7b4-6f0a06762144` |

Every call went to `subagent_type: word-counter`, every answer was "9", `realModel` always matched the requested model,
no run failed.

**Conclusion for E2-2 (open question 1):** the preset does not carry the "do not call the Agent tool unless asked" line
for any of the three models, and when the task names a subagent all three delegate in every run, with or without an
explicit delegation sentence; the sentence does not change the number of calls. E2-2 does not need to write against the
preset: its own delegation sentence is unnecessary, naming concretely the occasions where a subagent fits is enough.
Not checked: delegation when the task does not name the subagent (the test task is trivial).

Subagents and commands run in the **foreground**: every session starts with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`,
so the Agent and Bash tools offer no `run_in_background` and nothing is moved to the background automatically. A
background task only reports back in a later turn, but Symphony ends a result-driven session after the one reminder
turn (and every session at `max_turns`), which stops the task with it. An agent that ended its turn to wait for a
background code review would then lose the review and the stage would end without a result. The system prompt
addition says the same: use the results in the same turn and never end a turn to wait. `claude.env` can set the
variable to `0`; if a session then ends without a result while tasks still run, the "Stage ended without a result"
comment names them, and `turn_completed` carries them in `detail.background_tasks`.

Subagent nesting is capped at one level: every session starts with `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`, so a
subagent has no Agent tool of its own. Claude Code allows three levels by default, which would let a lens fan-out
multiply, and no planned pattern nests; the SDK docs advise limits over instructions. `claude.env` can set another
value (e.g. `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "2"`). `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` keeps its default.

**Forks are denied.** A fork subagent inherits the whole context and the role's tools, so it bypasses the
`Agent(symphony:*)` denies. From SDK 0.3.302 forks are on by default, and Symphony pins 0.3.318 (Claude Code 2.1.318, E4-5), where they are on. Every
session therefore carries the rule `Agent(fork)` in `disallowedTools` (read-only or not, with or without denied agents)
and starts with `CLAUDE_CODE_FORK_SUBAGENT=0`. `claude.env` can override the variable; the deny rule stays.

**Claude Code 2.1.318 (E4-5).** Symphony pins `@anthropic-ai/claude-agent-sdk` **0.3.318** exactly (no `^`), which bundles
Claude Code 2.1.318; `session_configured.claude_code_version` reports it (verified: `system/init` of the bundled binary
says `2.1.318`). `npm run check` typechecks and the tests pass unchanged (no new message shapes, no new fixtures).
The live checks below were **not run** by the developer session: the workspace has no login (`Not logged in · Please run
/login`, the token variables are stripped from the session environment). They are pending for the merging maintainer.
Run each in a temp git repo with the flags and environment Symphony uses (`CLAUDE_CODE_FORK_SUBAGENT=0` plus
`--disallowedTools "Agent(fork)"` as above), with `--output-format stream-json --verbose`, once per role kind
(writing: `--permission-mode acceptEdits`; read-only: `--disallowedTools Edit Write NotebookEdit`; command: an
issue-command session, e.g. a skill). Record the session ids here.

- Fork refused: prompt `Start a fork subagent that says hi`; expect a refusal or error `tool_result` and no fork run. _pending_
- 2.1.302, a subagent's own Agent calls run in the foreground: needs `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2` (depth 1 gives
  subagents no Agent tool); ask a general-purpose subagent to start an Explore subagent; the nested call must finish before
  the outer result and carry no `run_in_background`. _pending_
- 2.1.314, the parent no longer keeps subagent tool results: the parent's next turn `usage` input tokens must not grow by
  the subagent's inner `tool_result` sizes. _pending_
- 2.1.317, a subagent on another model uses that model's effort: session on sonnet, subagent on `haiku`; the subagent's
  assistant messages carry the haiku model and no effort error. _pending_
- 2.1.311, `SubagentStop` no longer fires twice a minute: `--settings` with a `SubagentStop` hook appending to a file; it
  must fire once per subagent, not every ~30 s. _pending_

#### Mechanics (spike E0-2, Claude Code 2.1.288)

Seven questions, answered with controlled SDK sessions (SDK 0.3.288 / Claude Code 2.1.288, 2026-11-05 22:13–22:19 UTC)
that ran outside the agent sandbox with a login. The options are those of `#options()` in `src/agent/claude.ts`:
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`, `CLAUDE_CODE_FORK_SUBAGENT=0`,
the plugin, preset `claude_code`, `settingSources: []`, `model: sonnet`, `effort: low`, `permissionMode: default`, plus a
logging `canUseTool` and `PreToolUse`/`SubagentStart`/`SubagentStop` hooks. Evidence paths are relative to
`$CLAUDE_CONFIG_DIR/projects/-tmp-spike-e0-2-ws/`: `<session>.jsonl` is the main transcript,
`<session>/subagents/agent-<id>.jsonl` (with `.meta.json`) a subagent, `spike-logs/<case>.jsonl` the SDK stream with the
hook and callback log. The findings hold for this version only; the SDK upgrade (E4) re-runs the spike.

| # | Question | Answer | Evidence (session, line) | Consequence |
|---|----------|--------|--------------------------|-------------|
| 1 | Does a subagent inherit the session's `effort`? | Yes | `stats1` `14de2a7a-2216-4f2e-be04-97261e9e7f56`: main L18 and `agent-a2180c850630b00b3.jsonl` L10 both carry `"effort":"low"`. Production agrees: about 30 parent/subagent pairs (e.g. `70354e52-5187-4069-adf2-389d86d23a14` fable xhigh, `a98e3eb3-b740-45fc-ad36-93cf2ffdc918` opus medium) always match. A `haiku` subagent carries no `effort`. | E4-6: personas get their effort from the session; one that needs another sets it in the front matter |
| 2 | Do two Agent calls in one message run in parallel with background tasks disabled? | Yes | `stats2` `c94e3799-cab9-4301-b0d2-fa1fa415cd43`: main L18+L19 hold two Agent calls of one message (`msg_011CgkYuE5chQgusCEt9nHc2`); `spike-logs/stats2.jsonl` L5/L10 `task_started` 22:13:47.5 and 22:13:48.4, L23/L28 `task_notification`; the `sleep 20` Bash windows 1793916832.08–852.08 and 844.93–864.93 overlap; both `requestShape: foreground` | E3-3: lenses and explorers can run in one message, no sequential latency to plan for |
| 3 | Do denied agents disappear from the agent list the model sees? | Yes, from the model's list only | The `agent_listing_delta` attachment lists only allowed plugin agents: reviewer `7c8fedec-cfdd-494d-b802-db992d2ab7a1` shows `symphony:laravel-code-reviewer` alone, developer `21982277-ab36-419f-94b4-241a17873ea9` all five. `init.agents` still lists the denied ones. Taken from production transcripts, not re-run. | Enforcement: the `disallowedTools` rule hides the agent, the hook is the second layer; the comment "The deny rules hide the subagents" in `claude.ts` is right for the model's list |
| 4 | What do the fields of `subagent_stats` count? | See below | `stats0` `210845bb-2fd3-403d-bf7d-e9db6e69171b` `spike-logs/stats0.jsonl` L4 (0 calls), `stats1` L16 (1 call), `stats2` L31 (2 calls), `statsDenied` `58a6ab0e-5797-4c3b-ac47-f32d074a6457` L9 (1 call denied by the hook) | E0-7: usable as an extra signal; it does not see refused calls |
| 5 | Does an `options.agents` entry override a plugin agent of the same name? | Yes, by the full name | `override-a` `261a8bde-fcdb-4b19-93bb-d3f06a691d09` vs `override-b` `32f15e95-318f-47b7-88bf-327faa1a0acf`, `spike-logs/override-{a,b}.jsonl` L1 (`init.agents`), subagent L10 `message.model`. Key `symphony:laravel-architect` replaces the plugin agent (one entry; haiku; reply starts `OPTIONS-AGENT`). Key `laravel-architect` is a separate agent, and `symphony:laravel-architect` still runs the plugin one (sonnet, no marker). | E2-3: `options.agents` can override a persona, but only under the qualified name `<plugin>:<name>` |
| 6 | Can a `PreToolUse` hook rewrite `tool_input.model` with `updatedInput`? | Yes | `rewrite` `2bbceefe-a047-4fa4-a59e-2d3b29034623`: `spike-logs/rewrite.jsonl` L5 (hook output), `agent-a3169d7ec395a2ff6.jsonl` L10 and `.meta.json` `"model":"haiku"`. Under a sonnet session the subagent ran `claude-haiku-4-5-20251001` (control `stats1`: sonnet); the alias `haiku` resolves to Haiku 4.5. | E1-3: the existing `Agent|Task` hook can pin a model per invocation |
| 7a | Is `canUseTool` called for tool calls inside a subagent? | Yes, with `agentID` | `canuse2` `394763a3-0222-4def-ae09-2d26f5ce1a03`: `spike-logs/canuse2.jsonl` L4 (Write, `agentID: null`) and L13 (Write, `agentID: aedfa01af1f238e4b`, i.e. `agent-aedfa01af1f238e4b.jsonl` L10). Case `canuse` (`e244e8e4-b170-4d01-aa6a-6b0a4c495092`) is no evidence: `echo` and the Agent call need no permission, so the callback never fired. | E2-4: a subagent's tool calls can be judged in `canUseTool` by `agentID` |
| 7b | Does a `SubagentStart` callback hook with `additionalContext` work? | Yes | `substart` `2945d925-cfb1-42e6-afce-07500d90447d`: `spike-logs/substart.jsonl` L7 (hook output), `agent-a46d7db348df821a3.jsonl` L2 (`hook_additional_context`) and L11 (reply `PAPAYA-7`) | E2-4: context can be injected into a subagent from the SDK |

`subagent_stats` fields as observed (0, 1 and 2 foreground calls; one denied call):

- `spawned`: subagents actually started (0/1/2). `completed` follows (0/1/2); `by_type` counts them per `subagent_type`.
- `requested.{background,foreground,unset}`: how the call asked to run. With background tasks disabled every call counts
  as `unset` (0/1/2).
- `max_depth`: deepest nesting reached (0/1/1); `started_in_background`, `failed`, `killed.*` and `spawned_by_subagents`
  stayed 0.
- `refused.{depth_limit,concurrency_limit,budget}`: limits of the runtime only. A call denied by a `PreToolUse` hook
  counts **nowhere**: `spawned`, `requested` and `refused.*` were all 0. It shows only in `permission_denials` (tool name
  `Task`) of the result and in the transcript (`statsDenied` main L18, L24).

### Brain tools

With `brain.enabled: true` and a role with `brain: read` or `brain: write` ([`roles.*.brain`](configuration.md#roles)) a second in-process MCP server `brain` offers access to the knowledge vault (the name `brain` is reserved for extensions, like `tracker`): `mcp__brain__brain_search`, `mcp__brain__brain_read`, `mcp__brain__brain_list`, `mcp__brain__brain_vitals`, `mcp__brain__brain_write` and `mcp__brain__brain_append`. `read` registers only `brain_search`, `brain_read`, `brain_list` and `brain_vitals`, `write` all six. Without `brain.enabled` or with `brain: off` (the default) the server is absent. The vault is never in `additionalDirectories` or the workspace. Each call reports a `brain_tool` event.

- `brain_search(query, repo?, type?)`: title, frontmatter and full text of all `.md` notes, case-insensitive, every word must occur. `approved` notes come first, then `candidate`; `deprecated` never. At most 20 hits with `path`, `title`, `status`, `excerpt`.
- `brain_read(path)`: `content`, parsed `frontmatter` and `hash` (SHA-256 of the file, for later writes).
- `brain_list(folder)`: files and subfolders with `type` and `status` from the frontmatter.
- `brain_vitals(purpose?)`: `{notes_by_status, links, orphans, broken_links, candidates, orphan_paths, broken: [{from, link}], same_title: [{title, paths}], truncated}` from the link index (lists capped at 200).
- `brain_write(path, content, purpose?, base_hash?)`: creates or replaces a note (`content` is the whole file). The frontmatter needs `type` (`index|decision|lesson|issue|agent|note`); `sources` must be a list, `repo` a string. Symphony sets `issue`, `role`, `run`, `created` and `updated` itself (`created` stays on an existing note); unknown fields stay. A new note is always `candidate`. Agents cannot create or promote `approved` notes, and an existing `approved` note is read-only for agents (`rejected`; write a candidate note and link it). `brain_append` rejects `approved` notes too. Only `.md` files, nothing hidden (`.obsidian/`, `.git/`), and not `README.md` in the vault root. Parent folders are created; the file is written atomically.
- `brain_append(path, heading, text, purpose?, base_hash)`: adds `text` at the end of the section under `## <heading>` (a heading starting with `#` keeps its level); the heading is created at the end of the note if missing. `base_hash` is required, the note must exist, `updated` is set.
- `base_hash` is the `hash` of `brain_read`. Missing on an existing note in `brain_write`: warning in the log, the write runs. A mismatch returns `rejected` with `error.details = {reason: 'hash_mismatch', content, hash}` (the current version) and writes nothing. If another run wrote the same note within `brain.clash_window_ms` (default 10 minutes; the same run is exempt), the write is `rejected` with `error.details = {reason: 'window', content, hash, run, at}` before the hash is compared. Each rejection creates a `BrainClash` (`{id, path, runs: [earlier, rejected], at, reason, status: open|resolved}`) in the memory of the shared `BrainAccessLog`. Both write tools return `{path, hash, created, frontmatter}`.
- After each successful write the `onWrite(entry)` option of `createBrainWriteTools`/`brainToolsFor` is called (`BrainWriteEntry`: `tool`, `path`, `purpose`, `hash`, `previousHash`, `created`, `issue`, `role`, `run`, `at`); an error in the hook is only logged.
- Versioning (E7-3): the vault is a git repository. With the `versioning` option (`createVaultGit(path, logger, {onCommit})`, wired by the worker) the whole write runs in one serial queue per vault: manual changes (Obsidian, not `.obsidian/`) are first committed as `human <human@local>` (`Obsidian: <n> Dateien`), then the note is written and committed as `symphony-<role> <symphony-<role>@local>` with the subject `<issue> <run>: <purpose>` and the path as body. Plain commits only, so `git revert <sha>` restores the previous version. `onCommit(sha, paths)` is called after every commit (an error is only logged). The one system note, the issue summary `Issues/<owner>-<name>/<number>.md` after a merge, is committed as `symphony <symphony@local>` with the subject `<repo>#<number>: issue summary` (`VaultGit.commitAs`, same queue, no commit when nothing changed). A git error returns `rejected`, is logged, and the note is put back to its previous state (a new note is removed).
- Brain changes (E6-2): every vault commit becomes one Changes entry of type `brain` per path (`brain:<sha>:<path>`, never `.obsidian/`, the init commit is skipped, the system author `symphony` otherwise counts) with repo and issue from the frontmatter, role from the author, the note title, the file counts and a diff excerpt of at most 5 lines. `status` is the first match of: subject `approve:` = `approved`, subject `reject:` = `rejected_candidate` (the contract for promoting and discarding candidates), author `human` = `human`, new file = `created`, else `updated`. A rejected write (`window`, `hash_mismatch`) becomes an entry `brain:conflict:<clash id>` with status `conflict`, role, run, `reason` and `clash_id`. At startup the newest 200 vault commits and the clashes of the last 7 days are loaded; entries already known (same id) are not added twice.
- Paths are relative to the vault: no `..`, no absolute path, nothing under `.obsidian/`, no symlink out of the vault. A violation returns the error category `rejected`.
- Every tool takes an optional `purpose`; without it a warning is logged and the call runs anyway.
- Access log: every call is appended as one JSON line to `<log-dir>/brain/access.jsonl` (`{at, run, issue, role, op, path_or_query, purpose, result: ok|rejected, reason?, hash_before?, hash_after?}`; `op` is `read|search|list|write|append|resolve`, a missing `purpose` is logged as `''`; rejections by the clash check also carry `clash_id`, `other_run`, `other_at`). Symphony removes lines older than 30 days at startup, rebuilds the clash list from the last 7 days and the last writer per note from the file; write errors are only logged. `markResolved(id)` sets a clash to `resolved` and logs `op: resolve`.
- All access is synchronous on the file system; there is no index.

### MCP server status

Stdio servers such as Laravel Boost may still be `pending` after the handshake (Claude Code waits up to
`MCP_TIMEOUT`, 30 s, for them). Before the first turn, Symphony polls `mcpServerStatus()` while any server it added is
`pending`, until all settle, `claude.read_timeout_ms` elapses or the run is cancelled. Errors while polling are logged
and never fail the run. The final statuses are exposed as `AgentSession.mcpStatus` and in `session_configured`
(`mcp_status`). For every added server whose final status is not `connected` (`failed`, `needs-auth`, `disabled`,
still `pending`, or `missing`):

- a warning is logged;
- the turn-1 prompt starts with ``MCP server `<name>` is unavailable (<status>); do not call its tools.``
  (integration-specific hints stay in the integration's own prompt section);
- the run's `run_finished` history line lists it in `mcp_unavailable`.

## Workspace extensions: Laravel Boost

After the `before_run` hook and before the session starts (phase `PreparingWorkspace`), Symphony looks for Laravel
apps in the workspace: the root and its direct subdirectories (except `vendor`, `node_modules` and dot-directories)
that contain `artisan` and a `composer.json` requiring `laravel/framework`. Apps without `laravel/boost` only get a
log line (`npm run repo-init` → *Laravel Boost* creates an issue that adds it). For each app with Boost:

1. **Dependencies:** `laravel.composer install --no-interaction --no-progress` when `vendor/` is missing or
   `composer.lock` changed since Symphony's last install (`laravel.install_dependencies`).
2. **Generation:** if the repository does not commit a `boost.json`, Symphony writes one naming Claude Code
   (`agents: [claude_code]`, `mcp: true`) and runs `laravel.php <app>/artisan boost:install --no-interaction
   --guidelines --skills` with `laravel.env` (`APP_ENV=local` by default: Boost registers its commands only locally).
   This writes Boost's guidelines (into `CLAUDE.md` if the app has one, else `AGENTS.md`) and its skills (into
   `.claude/skills/`), matched to the installed package versions and including the app's `.ai/guidelines` and
   `.ai/skills`. No `.mcp.json` is written: Symphony adds the server itself. **Package skills:** Non-interactive
   Boost installs third-party skills only from the `packages` list of `boost.json`, so Symphony scans
   `vendor/*/*/resources/boost/` (a `skills/` or `guidelines/` directory) and adds every such package, for example
   `filament/filament` with its `filament-development` skill. Existing `packages` entries are kept. Generation runs
   again only when `composer.lock`, `.ai/`, the Boost version, the list of those packages or `laravel.php` change, or a generated file is gone; the state lives in
   `<git-dir>/symphony/laravel-boost.json`.
   **Check:** `boost:install` exits with 0 even when writing the guidelines or skills failed for an agent (it only prints
   ✗), so Symphony checks the result: the Boost block must be in the guideline file, and every skill `boost.json`
   lists under `skills` must have `.claude/skills/<name>/SKILL.md`. Otherwise it logs a warning and generates again on
   the next attempt; the session still gets the MCP server. No skills at all (Boost reports none) is a warning only.
3. **Git stays clean:** Symphony compares `git status` before and after. New files are listed one by one in a managed
   block of `.git/info/exclude`, so they never show up as changes (files the agent adds next to them still do).
   Tracked files Boost changed are restored with `git checkout`; their Boost block goes into the prompt instead.
   Tracked files the agent had already changed keep their exact content.
4. **Committed Boost files:** if `boost.json` is tracked, the repository manages Boost itself; Symphony generates
   nothing and uses the committed files.
5. **Session:** the MCP server `laravel-boost` (`laravel-boost-<dir>` when a repository holds several apps) runs
   `laravel.php <app>/artisan boost:mcp` with `laravel.env` plus `SYMPHONY_WORKSPACE`, using the tool policy above.
   A section in the system prompt names the app, the commands to use, the pre-approved and denied Boost tools and
   the skill directories Boost generated (`.claude/skills/<name>/`; the committed ones for committed Boost files),
   mentions `record-rule` and `.ai/rules` only when `record-rule` is allowed, and contains Boost's guidelines unless Claude Code already loads them
   from the root `CLAUDE.md` (blocks over 48 KB go to a file under `<git-dir>/symphony/` the prompt points to). For an
   app in a subdirectory, its directory is passed as an additional directory so its `.claude/skills` load at start.
   The agent's environment gets `laravel.agent_env` (default empty), not `laravel.env`: `APP_ENV=local` there would
   override PHPUnit's `APP_ENV=testing` and keep Boost active in tests.

**Visibility:** the Laravel integration reports per app what the session got (status and reason, versions, how the
guidelines reach the agent, the skills, the MCP server and its pre-approved tools, warnings from the check above).
The orchestrator counts every `tool_use` event per tool (one event per tool call, also for parallel calls in one
message), every Skill tool call per skill, the tool calls made inside subagents (`tool_use` events with `detail.subagent`, from messages with `parent_tool_use_id`) once more in `subagent_tool_calls` (`tool_calls` stays the total) and every Agent tool call per subagent, and attributes calls of the Boost MCP servers and Boost skills to Boost.
`session_configured` carries the skill names Claude Code loaded (`skill_names`), so the agent page can show how many
of Boost's skills were really available. All of this is in `GET /api/v1/state` (`running[].integrations`,
`tool_calls`, `subagent_tool_calls`, `skill_calls`, `agent_calls`), in `run_trace` of `GET /api/v1/<identifier>` and in the `run_finished`
line of the repository log (`integrations`, `integration_tools`, `integration_skills`, `tool_calls`, `subagent_tool_calls`, `skill_calls`,
`agent_calls`). The dashboard shows it as the Boost chip on the agent card, the *Laravel Boost* section of the agent
page and the *Tools* (with *Skills loaded* and *Subagents used*) and *Laravel Boost & integrations* sections of the
statistics page.

None of this blocks a run: when PHP is missing, `composer install` or `boost:install` fails, or the workspace is not
a git checkout, Symphony logs a warning and starts the session without Boost. An abort stops PHP and Composer at once;
the git clean-up still runs. If Boost detects Laravel Sail, Symphony warns: Boost's guidelines then tell the agent to
use `vendor/bin/sail`, but Symphony runs PHP on the host. To run PHP elsewhere, point `laravel.php` at a wrapper
script: it receives the absolute `artisan` path and its arguments, plus `SYMPHONY_WORKSPACE` in its environment.

## Timeouts and failures

| Situation | Result |
|---|---|
| Handshake slower than `read_timeout_ms` | `response_timeout`; the attempt is retried with backoff |
| No agent output for `turn_timeout_ms` during a turn | `turn_timeout`; the turn is interrupted, the attempt retried |
| No agent event for `stall_timeout_ms` (checked each tick) | The orchestrator stops the run (`stalled`) and retries. Workspace preparation (hooks, Composer, Boost) and entry checks (phase `RunningChecks`) have their own timeouts and do not count; the stall clock starts when the session launches and again when a check ends |
| A Symphony tool call (`mcp__tracker__*`) lasts longer than `checks.timeout_ms + 60 s` | Claude Code ends the call with a tool error. Set `MCP_TOOL_TIMEOUT` in `claude.env` to choose another limit |
| Turn result is an error (max budget, API error, …) | `turn_failed` |
| Claude Code exits mid-turn | `port_exit` (stderr tail included in the message) |
| Orchestrator stops the run (issue moved, shutdown) | `turn_cancelled`, no retry |

Entry checks run inside the `set_status` tool call, so that call must outlive the check. Claude Code (observed with 2.1.288, bundled
with Agent SDK 0.3.288; not re-checked with 2.1.318) bounds a call to an MCP server by the server config's `timeout` (used when ≥ 1000 ms), else
the `MCP_TOOL_TIMEOUT` environment variable, else 100 000 000 ms (about 28 hours); in-process `sdk` servers have no
idle timeout. Sources: the `timeout` docs of `createSdkMcpServer` and `McpSdkServerConfig` in the SDK's `sdk.d.ts`
("Overrides the MCP_TOOL_TIMEOUT environment variable for this server"), `sdk.mjs` forwarding it to the CLI as
`{type: "sdk", name, timeout}`, and the CLI's resolver (`timeout ?? MCP_TOOL_TIMEOUT ?? 1e8`, clamped to
1000 ms–2³¹−1). Symphony therefore sets `timeout` on its `tracker` server to `checks.timeout_ms + 60000`, unless
`claude.env` sets `MCP_TOOL_TIMEOUT`; then that value applies. `claude.turn_timeout_ms` must stay above
`checks.timeout_ms` (validated when `checks.timeout_ms` is set), because the turn timer does not re-arm while a tool
call is pending.

Stopping a session closes its input, waits up to 10 seconds, then closes it forcibly and kills the **whole process
group**, so commands the agent started (test runners, dev servers) end with it. On orchestrator exit, remaining
groups are killed too.

## Events and accounting

Events sent to the orchestrator: `session_started`, `session_configured` (model, permission mode, Claude Code
version, MCP server status, plugins, number of skills), `startup_failed`, `turn_started`, `turn_completed`, `turn_failed`, `turn_cancelled`, `turn_timeout`,
`turn_input_required`, `approval_auto_approved`, `approval_denied`, `permission_denied`, `tool_use`, `tool_result`,
`subagent`, `tracker_tool`, `brain_tool`, `assistant_message`, `api_retry`, `rate_limit`, `agent_error` (API or authentication errors),
`agent_exited`, `notification`, `other_message`. The worker adds the transition guard's `transition_denied`,
`checks_started` and `checks_finished` (`target`, `sha`, `exit_code`, `duration_ms`, `ok`), logged at info level.

The `subagent` event reports the subagents the session starts with the Agent/Task tool. Its `subagent` field is an
absolute snapshot: tool call id, type (`general-purpose` when unset), description (the `description` of the call, else
the start of its `prompt`), start, end, status (`running`, `ok`, `error`) and the tokens of the subagent's own model
calls (input, output, cache read and write; messages with its `parent_tool_use_id`, counted once per message id). This
`tokens` is the billed load, not the context size. Claude Code's own figures come from the `task_progress` and
`task_notification` messages, matched by `tool_use_id`: `contextTokens` (`usage.total_tokens`, the context of the latest
request), `toolUses` and `durationMs`. They are `null` until such a message arrives and stay `null` for runs without
`task_*` messages (the page shows "—"). A `task_notification` after the `tool_result` still updates the ended run.
`task_started`, `task_progress` and `task_notification` that match a subagent no longer appear as `notification`;
unmatched ones still do. `models` lists the models of the subagent's own calls (first seen first, no duplicates). The
`tool_result` with the same `tool_use_id` ends it (`is_error` gives `error`); a result text starting with "Agent terminated
early due to an API error" also gives `error`; a `task_notification` with status `failed` or `stopped` gives `error` even
after the `tool_result`. When status is `error`, a `reason` field contains a short explanation (API error, usage limit,
task failure summary); the tile shows "Fehler: <reason>". A session that ends or is stopped closes the open ones as `error`
(without `reason` if none was set). Only start and end carry a message; figure updates do not appear in the timeline. The
orchestrator keeps the running subagents and the last ten finished ones per running issue. `agent_calls` still counts the calls.
The subagents survive the run: `run_finished` carries them in the JSON field `subagents` (format in
[configuration.md](configuration.md#repository-logs)), `sessions[].subagents` in `GET /api/v1/<identifier>` lists them per
run, and `run_trace.subagents` holds those of the current or last run. Claude Code (2.1.288) also puts an undocumented
`subagent_stats` object (spawned, refused, ...) in the result; its numeric entries are kept as `subagent_stats` in
`run_finished` and `run_trace` as an extra signal that may change. The subagent lists never depend on it.

A turn that fails because of a Claude subscription usage limit settles with the failure code `session_limit` (instead
of `turn_failed`), carrying the window, the reset time and where it came from. Detection order:

1. A `rate_limit_event` with status `rejected` during the turn. Its `resetsAt` is the reset time (`source` = `event`);
   its `rateLimitType` is the window (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`).
2. The message text ("You've hit your session limit · resets 7:30pm (Europe/Berlin)", from the result or from an
   assistant message flagged `rate_limit`). Window and reset are parsed from it (`source` = `message`); a time without
   a zone uses the host's zone, and the next occurrence of that time counts.

A failed turn with `api_error_status` 429 is only a session limit together with a rejected `rate_limit_event`. Other
429s, such as rate limits of an `ANTHROPIC_API_KEY` (no `rate_limit_event`), stay `turn_failed` and use the normal
failure backoff. The orchestrator turns `session_limit` into the retry and wait behavior described under
`agent.max_session_limit_retries` in [configuration.md](configuration.md#agent); the run is logged with the outcome
`session_limit`.

Token usage is counted per model, keyed by the model id Claude Code reports (`claude-opus-5-5`, `claude-fable-5-1`,
…), so a new model needs no change in Symphony. The runner adds the `usage` of every assistant message as it
arrives (one response's blocks share a message id and are counted once) and reports the running totals as
`model_call` events; the `modelUsage` totals of each turn result, which are cumulative for the session (main loop,
subagents and compaction), then replace them. A run that is stopped, stalls or hits a session limit in the middle
of a turn therefore still ends with its tokens, cost and model in the repository log. In the dashboard totals, input
tokens include cache reads and cache writes; the repository logs keep the four counts apart. The orchestrator adds
the difference to the previous total, so nothing is counted twice. Cost is estimated per model with `model-costs.yml` (see
[configuration.md](configuration.md)); Claude Code's own estimate (`total_cost_usd`) is kept as
`claude_estimate_usd` for comparison. Rate-limit snapshots come from `rate_limit_event` messages (subscription
logins).
Every event is appended as one JSON line to `<log-dir>/budget/rate-limits.jsonl`
(`{at, run_id, issue, role, model, rate_limit_info}`, `rate_limit_info` is the raw SDK object). Symphony removes lines
older than 30 days at startup and then once a day; write errors are only logged. `GET /api/v1/state` shows
`rate_limits` as an object with the latest record per `rateLimitType` (`five_hour`, `seven_day`, ...), `{}` before the
first event. Instances sharing a log directory share the file, which fits because limits apply per account.

#### Rate-limit event fields

Besides `status`, `rateLimitType` and `resetsAt`, three fields of `rate_limit_info` carry the utilization of the
subscription windows. `utilization` and `surpassedThreshold` are typed in the SDK (`SDKRateLimitInfo`,
`@anthropic-ai/claude-agent-sdk@0.3.288`, spike); `unifiedWindows` is not. Findings from real payloads (spike E4-3, #332):

- `utilization`: share of the window named by `rateLimitType`, `0` to `1`. It is missing on `rejected` events.
- `surpassedThreshold`: the warning level that was just exceeded, on the same scale as `utilization`. Observed `0.75`
  for `seven_day` and `0.9` for `five_hour`. It comes with `allowed_warning` events.
- `unifiedWindows` (not typed): an object keyed by window (`five_hour`, `seven_day`, sometimes
  `seven_day_overage_included`), each with `utilization` and `resetsAt`. Values above `1` are possible. Read it
  defensively: every key, window and number may be missing or have another type.

What the payloads show:

1. `rateLimitType` is the window that currently binds, not a fixed one; the event can switch between `five_hour` and
   `seven_day`.
2. `rejected` carries neither `utilization` nor `surpassedThreshold`.
3. `unifiedWindows` is present in every event, so the utilization of all windows is known from the latest event.
4. The windows are fixed blocks, not rolling: the 5-hour window resets in steps of five hours, the week always on
   Wednesday 09:00 UTC. After a reset the utilization starts at `0`.

Abridged real payloads:

```jsonc
// allowed_warning / seven_day
{
  "status": "allowed_warning",
  "rateLimitType": "seven_day",
  "resetsAt": 1793782800,
  "utilization": 0.77,
  "surpassedThreshold": 0.75,
  "unifiedWindows": {
    "five_hour": { "utilization": 0, "resetsAt": 1793497800 },
    "seven_day": { "utilization": 0.77, "resetsAt": 1793782800 }
  }
}

// rejected / five_hour: no utilization, no surpassedThreshold
{
  "status": "rejected",
  "rateLimitType": "five_hour",
  "resetsAt": 1793537400,
  "unifiedWindows": {
    "five_hour": { "utilization": 1.01, "resetsAt": 1793537400 },
    "seven_day": { "utilization": 0.91, "resetsAt": 1793782800 },
    "seven_day_overage_included": { "utilization": 0.7, "resetsAt": 1793782800 }
  }
}
```

### Limit forecast

`GET /api/v1/budget` answers `{ five_hour, seven_day, generated_at }`. Each window holds `used_tokens` (tokens of
`run_finished` lines in the rolling window of 5 hours or 7 days), `burn_rate_per_min` (tokens of the last 30 minutes
/ 30), `utilization_rate_per_min`, `resets_at`, `sdk`, `percent`, `percent_source`, `forecast`, `alert` and `by_role` (tokens per role in the window).

**SDK utilisation.** `sdk` is `{ utilization, resets_at, event_at, status }` of the **latest rate-limit event of any
type** (by `at`, not after now) that gives a utilisation and a reset for the window: `unifiedWindows.<window>`, else the
top level when `rateLimitType` is the window. So a `seven_day` event can give the `five_hour` value. A `rejected` event of
the window without a utilisation counts as 1.0. Values above 1 are kept (1.01 = 101 %). `resets_at` comes from the same
event. Once that reset has passed, the value no longer holds: `sdk` and `resets_at` are `null`, the limit derived from
the event is dropped and the window is **unknown** until the next event (not 0 %). `percent` is `utilization × 100`
(`percent_source: "sdk"`), else `used_tokens / limit_tokens × 100` (`"calibrated"`), else `null` (`"none"`); it may exceed 100.

`utilization_rate_per_min` is the slope of the SDK utilisation (a share per minute, four decimals), `(last − first) / Δt` over the
events of the last 30 minutes (by `at`) that give a utilisation for the window. It is `null` with fewer than two such
events or when the utilisation drops between two events (a reset inside the 30 minutes).

`forecast` is `null` while there is neither a known limit nor an ETA. With an SDK utilisation (`percent_source: "sdk"`) the
`eta` comes from the slope, not from tokens: now + (1 − utilization) / slope, `now` once `utilization` ≥ 1, set only with a
slope > 0 and before `resets_at`; otherwise `null`. This counts all use of the account, not just Symphony runs. The ETA does
not depend on a token limit: if none can be derived, `forecast` is `{ limit_tokens: null, limit_source: "sdk", eta }`. The
token limit is taken from the SDK utilisation (limit = tokens in the window at the event time / `utilization`,
`limit_source: "sdk"`) and otherwise calibrated: the usage in the window at the time of the latest `rejected` event of the
same `rateLimitType` (`limit_source: "calibrated"`). **Fallback:** without an SDK utilisation the ETA is the token
calculation as before: now + (limit − used) / burn rate, only before `resets_at` (`now` once the limit is reached). `alert` is
`true` exactly when `eta` is set. `Orchestrator#budgetAlerts()` returns the windows with an alert for the alerts panel,
each with `percent` and `source` (`sdk` or `calibrated`); `limit_tokens` may be `null`. The tokens of a run only count once
it has finished, so running sessions are missing. Other methods than `GET` answer 405.

Every raw SDK message is also written as JSON lines to `<log-dir>/sessions/<workspace-key>/<timestamp>.jsonl`.

## Authentication

Claude Code uses `ANTHROPIC_API_KEY` if it is set (shell or `.env`), otherwise the login of your Claude Code
installation (`claude` → `/login`).
