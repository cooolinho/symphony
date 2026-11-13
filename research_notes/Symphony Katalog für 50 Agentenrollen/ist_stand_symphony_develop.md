# Ist-Stand: Agenten, Rollen und Skills in Symphony (origin/develop @ 37200a4, 2026-11-12)

Scope and method: everything below was read through `git show origin/develop:<path>` in `/home/cooolinho/projects/symphony`. `origin/develop` resolves to `37200a4` ("Feature: Wiederkehrende Review-Funde als Brain-Lessons ... (#575) (#576)", 2026-11-11). The working tree (e064ff9) was not touched. All `path:line` references are line numbers of the file **at origin/develop @ 37200a4**. No container, no GitHub access. Sources are repository files, so they are cited as `path:line` instead of URLs.

Counts at 37200a4: **14 subagents** (`.claude/agents/*.md`), **12 configured roles** in `WORKFLOW.md` (7 pipeline roles + 5 command roles) plus the implicit `default` role, **6 skills** (`.claude/skills/*/SKILL.md`), **3 shared prompt partials** (`roles/brain.md`, `roles/brain-lessons.md`, `roles/recurring-findings.md`).

## 1. Every subagent on origin/develop: purpose, tools, model, effort, maxTurns, calling role, complexity gate, enforcement

### Takeaway
There are 14 plugin subagents (13 at e064ff9 plus the new `spec-reviewer`). Which role may call which agent is enforced in code (allowlist → deny rules + `PreToolUse` hook + config validation); the S/M/L/XL gate is enforced only by Liquid logic in the prompts, backed up by outcome checks in `report_result` (verified findings, panel votes, RED-at-base evidence), not by blocking the spawn.

### Cited Findings

Inventory (front matter is lines 1-7 of each file; "inherit" = no key in the front matter):

| # | Agent | Purpose (one line) | Tools | Model | Effort | maxTurns | Allowed for role (WORKFLOW.md) | Complexity / occasion | Reference |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `explorer` | Read-only code map: 5-10 key files as `file:line` plus a summary of at most ~300 words, never file contents | all except Edit, Write, NotebookEdit | sonnet (front matter); pinned at call time below the parent: sonnet/haiku parent → haiku, opus/fable parent → sonnet | low | 25 | architect, developer, auditor, autopilot, analyst, planner | any complexity; occasion-based ("before reading more than about ten files"; architect: 2-3 calls per code area) | `.claude/agents/explorer.md:2-7`, `:17-21`; pin: `src/agent/claude.ts:548-557`, `src/agent/model-name.ts:37-43` |
| 2 | `design-critic` | Critiques a finished design draft against the code, max ~10 defects with severity; no new design | all except Edit, Write, NotebookEdit | opus | inherit | 40 | architect | L/XL only, once before `report_result` | `.claude/agents/design-critic.md:2-6`, `:17-20`; `roles/architect.md:10` |
| 3 | `spec-reviewer` (NEW) | Reviews a finished change against acceptance criteria and design before the first push; reports only correctness gaps with `file:line` and command output | all except Edit, Write, NotebookEdit | opus | inherit | 30 | developer | L/XL only, once before first `git push`, and only in non-Laravel workspaces (hidden when `laravel-code-reviewer` is available) | `.claude/agents/spec-reviewer.md:2-6`, `:17-22`; `WORKFLOW.md:228`, `:471-472`; `roles/developer.md:12`, `:49` |
| 4 | `test-designer` | Writes tests for one group of acceptance criteria from criteria + public interface only (information boundary), proves RED at base commit and GREEN on branch | all (can write) | sonnet | inherit | 50 | test-engineer | L/XL only and not for refactor issues; one call per criteria group, one at a time | `.claude/agents/test-designer.md:2-5`, `:10-15`; `roles/test-engineer.md:1`, `:23-29` |
| 5 | `convention-lens` | Checks the diff against written repo rules (CLAUDE.md, AGENTS.md, .ai/rules); reports only violations whose rule it can quote | all except Edit, Write, NotebookEdit | sonnet | inherit | 25 | reviewer | L/XL only, once, not in the integration review | `.claude/agents/convention-lens.md:2-6`, `:12-15`; `roles/reviewer.md:1`, `:65-67` |
| 6 | `bug-lens` | Finds bugs the diff introduces; called twice (diff alone, diff with context) | all except Edit, Write, NotebookEdit | opus | inherit | 30 | reviewer | L/XL only, twice in parallel | `.claude/agents/bug-lens.md:2-6`, `:11-13`; `roles/reviewer.md:68` |
| 7 | `finding-verifier` | Gets exactly one candidate finding and tries to refute it; rejects when in doubt | all except Edit, Write, NotebookEdit | opus | inherit | 15 | reviewer | L/XL only, one call per candidate | `.claude/agents/finding-verifier.md:2-6`, `:12-16`; `roles/reviewer.md:71-72` |
| 8 | `security-inventory` | Splits the change into components (entry point, trust boundary, sinks); no judgement, no shell | `tools: Read, Glob, Grep` (allowlist) | sonnet | inherit | 20 | security-auditor | L/XL only, once at the start | `.claude/agents/security-inventory.md:2-6`, `:16-21`; `roles/security-auditor.md:32` |
| 9 | `refutation-judge` | One candidate, one lens (`reachability`, `impact`, `defenses`); default "false positive"; no shell | `tools: Read, Glob, Grep` (allowlist) | opus | inherit | 15 | security-auditor | L/XL only, three calls per candidate (one per lens) | `.claude/agents/refutation-judge.md:2-6`, `:14-17`; `roles/security-auditor.md:34-35` |
| 10 | `laravel-architect` | Designs approach for a non-trivial Laravel feature/refactoring; returns a short plan, no code | all except Edit, Write, NotebookEdit | inherit (parent) | inherit | 80 | developer, auditor, autopilot, analyst, planner | any complexity, Laravel workspaces only; developer: "before a non-trivial feature; not when a design is given" | `.claude/agents/laravel-architect.md:2-5`; `roles/developer.md:10`; `WORKFLOW.md:228,308,320,330,340` |
| 11 | `laravel-code-reviewer` | Read-only review of a diff against its issue with a Laravel checklist (tests, authorization, mass assignment, N+1, migrations, secrets) | all except Edit, Write, NotebookEdit | opus | inherit | 40 | developer, auditor | developer: L/XL only (self-review before first push, hidden at S/M); auditor: one component each in a large repo; Laravel only | `.claude/agents/laravel-code-reviewer.md:2-6`, `:13-22`; `WORKFLOW.md:471`; `roles/auditor.md:10` |
| 12 | `laravel-database-engineer` | Migrations, schema, indexes, factories, seeders, Eloquent relations, query performance (N+1) | all (can write) | sonnet | inherit | 60 | developer | any complexity, Laravel only; "a self-contained part ... not for parts coupled to the rest" | `.claude/agents/laravel-database-engineer.md:2-5`, `:14-19`; `roles/developer.md:11` |
| 13 | `laravel-filament-developer` | Filament resources, forms, tables, actions, widgets, pages, panels incl. authorization and Livewire | all (can write) | sonnet | inherit | 60 | developer | any complexity, Laravel only; self-contained parts | `.claude/agents/laravel-filament-developer.md:2-5`; `roles/developer.md:11` |
| 14 | `laravel-test-engineer` | Writes/extends/repairs Pest tests (feature, unit, Livewire, Filament); changes test files only | all (can write) | inherit (parent) | inherit | 60 | developer | any complexity, Laravel only; self-contained parts (e.g. tests for one acceptance criterion) | `.claude/agents/laravel-test-engineer.md:2-4`, `:17-18`; `roles/developer.md:11` |

How the gates are enforced:

- **Role allowlist (code).** `roles.<role>.agents` lists names without plugin prefix; unset = all, `[]` = none — `src/workflow/config.ts:749-759`, `src/workflow/roles.ts:86-90`, comment in `WORKFLOW.md:167-168`.
- **Three conditions per session (code).** `sessionAgents()` allows an agent only when (a) the role lists it or lists none, (b) the agent is read-only or the role may write, (c) its name has no integration prefix (`laravel-`) or that integration is active in the workspace — `src/workflow/roles.ts:130-150`. The `laravel-` prefix is declared by the Laravel integration — `src/laravel/integration.ts:45`, `:94-95`. Called in `src/orchestrator/worker.ts:622-626`.
- **"Read-only" of an agent is derived from front matter**: neither `Edit` nor `Write` available via `disallowedTools` or a `tools` allowlist without them — `src/workflow/command.ts:75-76`, `:114-117`.
- **Deny at call time, twice (code).** Denied agents go into `disallowedTools` as `Agent(<name>)` (qualified and bare) — `src/agent/claude.ts:445-446`, `src/orchestrator/worker.ts:817`; and a `PreToolUse` hook on `Agent|Task` refuses the call with "The subagent ... is not available to this role in this workspace" — `src/agent/claude.ts:476`, `:534-547`.
- **Config validation (code).** An unknown agent name in `roles.<r>.agents` or a writing agent in a read-only role is a dispatch-preflight error — `src/workflow/validate.ts:59-65`.
- **Complexity gate (prompt Liquid only).** `large_issue` is true for complexity L or XL; `design-critic`, `spec-reviewer` and (in the developer role) `laravel-code-reviewer` are hidden from the rendered agent list unless `large_issue`; `spec-reviewer` is additionally hidden when `laravel-code-reviewer` is available — `WORKFLOW.md:471`. `self_review_agent` = `laravel-code-reviewer` if present else `spec-reviewer`, only when `large_issue` — `WORKFLOW.md:472`. Reviewer lenses: `roles/reviewer.md:1` (requires verifier + a lens + L/XL + not integration). Security panel: `roles/security-auditor.md:1`. Test designer: `roles/test-engineer.md:1` (L/XL and not refactor). `sessionAgents()` has no complexity parameter — `src/workflow/roles.ts:135-140`.
- **Outcome enforcement at L/XL (code, in `report_result`).** Review and security results at L/XL need `verification: {status: confirmed, evidence}` on every finding (`verifiedFindings`); security additionally needs three panel votes when the session may start the judge (`panelVotes`) — `src/orchestrator/result-tool.ts:283-291`. Panel rule: `PANEL_LENSES = ['reachability','impact','defenses']`, `PANEL_MAX_REFUTING_VOTES = 0` — `src/workflow/results.ts:102-109`, `:121-124`. L/XL non-refactor test results owe RED-at-base and (Laravel, Pest 3+) mutation evidence — `src/orchestrator/result-tool.ts:295-298`, `:488-503`; prompt side `roles/test-engineer.md:37-38`.
- **Session-level subagent rules (code).** Built-in agents (`claude`, `Explore`, `general-purpose`, `Plan`, `statusline-setup`) are off, background tasks off, nesting depth 1 (a subagent has no Agent tool), fork subagents off and denied (`Agent(fork)`) — `src/agent/claude.ts:63-75`, `:446`.
- **Context injection.** A `SubagentStart` hook gives every `symphony:*` subagent the issue identifier/title, workspace and acceptance criteria, capped at 4,000 characters — `src/agent/claude.ts:89-93`, `:112-116`, `:518-531`; `src/orchestrator/worker.ts:818`.
- **Brief rules for every delegating role** (`agent_intro`): pass the name as `subagent_type`; brief must contain issue, acceptance criteria, absolute workspace path, task boundaries, output format with `file:line`, return of about 1,000-2,000 tokens; treat findings as candidates — `WORKFLOW.md:472`.
- **Effort.** Only `explorer` sets `effort: low` (`.claude/agents/explorer.md:5`); the concept records that subagents otherwise inherit the session's effort ("Answered (E0-2): yes") — `docs/concepts/subagents.md:768-769`.
- **Naming rules.** File name = agent name; framework-specific agents carry a prefix (`laravel-`); read-only agents use `disallowedTools` instead of `tools:` because an allowlist also drops MCP tools (Laravel Boost) — `.claude/README.md:46-52`. The two security agents deliberately use `tools: Read, Glob, Grep` (no shell) — `.claude/agents/security-inventory.md:6`, `.claude/agents/refutation-judge.md:6`.

### Inferences
- An allowed agent can technically be started at S/M (nothing in code blocks it); the prompt simply does not list or mention it. The L/XL gate is therefore "soft" for spawning and "hard" only for the result contract.
- `laravel-architect` and `laravel-test-engineer` have no `model:`, so they run on the parent's model (fable in the command roles, opus/`CLAUDE_MODEL` in the developer) — the most expensive personas when called by fable roles.
- In a non-Laravel repository (e.g. Symphony itself) the developer effectively has only `explorer` (any size) and `spec-reviewer` (L/XL); auditor/autopilot/analyst/planner have only `explorer`.
- `.claude/README.md:10` lists 12 agents and omits `security-inventory` and `refutation-judge`; documentation drift.

### Gaps
- Real call frequencies per agent after v1.4.0 were not measured (no container access by instruction). The only numbers in the repo are historic and pre-date the current allowlists: `docs/concepts/subagents.md:67-81` (e.g. developer 371 runs, 28 with subagent; architect 170/19; reviewer 330/0), based on the old `laravel-*`-only setup.
- Whether deny rules really prevent writes inside subagents of read-only roles is recorded as "neither tested nor observed" in `docs/concepts/subagents.md:100-102`; shell writes are not covered by "read-only" (`:97-99`). Not re-verified here.

## 2. Every pipeline role and command role: column, model/effort, brain, agents, result contract, prompt intent

### Takeaway
Seven pipeline roles map one-to-one to board columns and hand off through a typed `report_result` (seven fixed result kinds); five command roles are triggered by `/command` in the issue description, are all read-only, run on fable (brain-gardener: opus) and hand off with `set_status` instead of a result. Models follow "plan strong, implement cheaper".

### Cited Findings

Pipeline roles (board columns; `active_states` in `WORKFLOW.md:83`):

| Role | Column | Read-only | Model / effort | `max_turns` | Brain | Agents | Result kind → verdicts → targets | Prompt intent | Reference |
|---|---|---|---|---|---|---|---|---|---|
| `issue-analyst` | Ready | yes | sonnet / medium; Model:/Effort: labels ignored | 3 | write | `[]` | `analysis`: `ready` → next stage, `needs_info` → Blocked | Analyse the issue before implementation: affected code, risks, refined acceptance criteria; sets `Type:`/`Complexity:` labels | `WORKFLOW.md:185-196`; `roles/issue-analyst.md:3` |
| `architect` | Design | yes | opus / high; fable at L/XL (`model_by_complexity`); `auto_compact_window: 400000`; Model: label ignored | 4 | write | `[explorer, design-critic]` | `design`: `ready` → In progress, `split` → Agent review (XL only, files work-package sub-issues, `max_sub_issues` default 5), `blocked` → Blocked | Compare options, choose one and turn it into a recipe (files, step order, tests) for a cheaper developer model; no code | `WORKFLOW.md:207-220`; `roles/architect.md:3`, `:27` |
| `developer` | In progress | no | `claude.model` (`$CLAUDE_MODEL`); opus at L/XL; Model:/Effort: labels apply | default (`agent.max_turns` 10) | read | `[explorer, laravel-architect, laravel-database-engineer, laravel-filament-developer, laravel-test-engineer, laravel-code-reviewer, spec-reviewer]` | `implementation`: `done` → Agent review (or Testing via profile / `SYMPHONY_AFTER_IMPLEMENTATION`), `blocked` → Blocked | Implement on branch `symphony/issue-N`, tests, merge base, screenshots, push, open PR; bugfix = regression test first, refactor = characterization tests first, feature = one test per criterion | `WORKFLOW.md:221-232`, `:117`; `roles/developer.md:3`, `:43-46`, `:49-50` |
| `test-engineer` | Testing | no (path rule: only `pipeline.test_paths`) | sonnet / high; labels ignored | default | read | `[test-designer]` | `test`: `passed` → Agent review (Documentation first when needed), `failed` → In progress, `blocked` → Blocked; round limit `max_test_rounds: 2` | Write and run independent tests per acceptance criterion, derived from the issue not the code; never fix production code | `WORKFLOW.md:237-246`, `:359`; `roles/test-engineer.md:4-5` |
| `docs` | Documentation | no (path rule: only `pipeline.docs_paths`) | haiku / medium; labels ignored | default | off (unset) | `[]` | `docs`: `done` / `not_needed` → Agent review, `blocked` → Blocked; `on_check_failed: In progress` | Update documentation for the change (config keys, env vars, commands, behaviour); conditional stage | `WORKFLOW.md:253-262`; `roles/docs.md:3-4`, `:12` |
| `reviewer` | Agent review | yes | opus / high; labels ignored | 6 | write | `[convention-lens, bug-lens, finding-verifier]` | `review`: `approved` → In review (Security review first when relevant), `changes_needed` → In progress, `blocked` → Blocked; `on_check_failed: In progress`; `max_review_rounds: 3` | Review the diff against a fixed checklist (correctness, tests, authorization, validation, queries, migrations, secrets, guardrails, screenshots); at L/XL lens review + verifier; separate integration-review mode for split issues; writes brain lessons for recurring categories | `WORKFLOW.md:263-277`, `:357`; `roles/reviewer.md:44`, `:52-72`, `:12-14`, `:80` |
| `security-auditor` | Security review | yes | opus / high; labels ignored | 6 | read | `[security-inventory, refutation-judge]` | `security`: `passed` → In review, `issues_found` → In progress, `blocked` → Blocked; `on_check_failed: In progress`; `max_security_rounds: 2` | Audit the approved change from the attacker's side (authorization, auth/sessions, injection, output, mass assignment, secrets, migrations, dependencies/config); at L/XL inventory + three-lens refutation panel; conditional stage | `WORKFLOW.md:287-299`, `:361`; `roles/security-auditor.md:4`, `:22-35` |

Command roles (all `states: [Ready, In progress]`, `read_only: true`, `run_checks: false`, `may_move_to: [In progress, In review, Blocked]`, no `result`):

| Role | Command | Model / effort / budget | `max_turns` | `max_sub_issues` | Brain | Agents | Prompt intent | Reference |
|---|---|---|---|---|---|---|---|---|
| `auditor` | `/refactoring` | fable, $15 | 2 | 20 (Backlog) | off | `[explorer, laravel-architect, laravel-code-reviewer]` | Analyse the repository and turn findings into sub-issues of the epic | `WORKFLOW.md:300-309`; `roles/auditor.md:3-4` |
| `autopilot` | `/auto-code` | fable, $10 | 2 | 5 per wave, `sub_issue_status: Ready`, `wait_for_sub_issues: true` | off | `[explorer, laravel-architect]` | Plan the next wave of work from the project description as sub-issues that start immediately; may open the release PR the skill describes | `WORKFLOW.md:310-321`; `roles/autopilot.md:3-4` |
| `analyst` | `/concept` | fable / high, $20 | 3 | 60 (whole tree) | off | `[explorer, laravel-architect]` | Turn a concept document into epics and sub-issues in Backlog | `WORKFLOW.md:322-331`; `roles/analyst.md:3-4` |
| `planner` | `/plan` | fable / high, $20 | 3 | 30 | off | `[explorer, laravel-architect]` | Turn every list item into one planned sub-issue in Backlog | `WORKFLOW.md:332-341`; `roles/planner.md:3-4` |
| `brain-gardener` | `/brain-garden` | opus, $5; `disallowed_tools: [mcp__tracker__open_pull_request]` | 2 | none | write, `brain_approved_writes: false` | `[]` | Find duplicates, orphans, broken links in the vault and propose fixes as candidate notes; never promotes | `WORKFLOW.md:342-352`; `roles/brain-gardener.md:3`, `:9-12` |

Further facts:

- **Implicit `default` role**: used when `roles` is unset or no role serves the state; single-agent prompt that moves the issue itself with `set_status` — `src/workflow/roles.ts:7-8`, `roles/default.md:5-12`, `WORKFLOW.md:604`.
- **Result kinds and verdicts are a fixed enum in code**: `analysis`, `design`, `implementation`, `test`, `review`, `security`, `docs` — `src/workflow/results.ts:13`, `:22-32`. Loop kinds with round limits: review/test/security — `src/workflow/results.ts:38`.
- **Model resolution order**: `Model:` label (unless `model_label: ignore`) → `model_by_complexity` → role `claude.model` → global `claude.model` — `src/agent/model.ts:33-34`, `:95-97`; philosophy comment `WORKFLOW.md:172-177`.
- **Brain modes**: `off` / `read` (search, read, list, vitals) / `write` (also write, append); default `off`; only with `brain.enabled` — `src/workflow/roles.ts:27-35`, `src/workflow/config.ts:448-449`, `WORKFLOW.md:169-171`. Brain is disabled by default (`SYMPHONY_BRAIN_ENABLED:-false`) — `WORKFLOW.md:459`.
- **Profiles per issue type** only override transitions, roles stay the same: bugfix skips architect at S/M, feature/refactor/default skip it at S; bugfix/feature/refactor route developer `done` → Testing — `WORKFLOW.md:382-400`.
- **Conditional stages**: Documentation only when `docs_needed` or a `docs_trigger_paths` match without docs change; Security review only with `security` label, `risks.security` or a `security_paths` match — `WORKFLOW.md:53-66`, `:247-252`, `:278-286`.
- **Concurrency**: `max_concurrent_agents` default 3; per column: Agent review 2, Security review 1, Documentation 1, Testing 1; reserved slots developer 1, reviewer 1 — `WORKFLOW.md:116`, `:126-138`. Dashboard maximum `MAX_SLOTS = 50` (slots, not roles) — `src/orchestrator/limits.ts:5-6`.
- **Auto-compact**: global `claude.auto_compact_window: 200000`; architect overrides to 400000 — `WORKFLOW.md:164`, `:220`; passed as `CLAUDE_CODE_AUTO_COMPACT_WINDOW` — `src/agent/claude.ts:437`.
- **Read-only role** = deny `Edit`, `Write`, `NotebookEdit`, `Bash(git commit:*)`, `Bash(git push:*)` — `src/agent/claude.ts:82`.
- **Brain lessons loop (#575)**: reviewer and security-auditor get `recurring_findings`/`known_categories`; developer, test-engineer and architect get `brain_lessons` — `src/orchestrator/worker.ts:481-501`; partials `roles/recurring-findings.md:1-10`, `roles/brain-lessons.md:1-9`; included via `WORKFLOW.md:548`; config `brain.review_lessons` (window 14 days, min 2 issues, 6000 chars) — `WORKFLOW.md:463-467`.

### Inferences
- The security-auditor has `brain: read`, so it cannot write lessons itself; its prompt tells it to state the rule in `summary` so the reviewer can turn it into a lesson (`roles/security-auditor.md:42`). That is an asymmetry in the lessons loop.
- The command roles have no `result` contract, so their output quality is not machine-checked the way pipeline results are (no `invalid_result` refusals, no round limits).
- `docs` and command roles other than brain-gardener have no brain access, so repository knowledge in the vault does not reach planning roles (auditor, autopilot, analyst, planner).

### Gaps
- `$CLAUDE_MODEL` / `$CLAUDE_EFFORT` values of the owner's instance live in `.env`, which was not read (not in git); the developer's actual default model is therefore unknown from the repo.
- Full text of role prompts beyond the first lines was read for developer, reviewer, security-auditor, test-engineer and architect; for issue-analyst, docs, auditor, autopilot, analyst, planner only the head (first ~12 non-empty lines).

## 3. Every skill: trigger, role, product

### Takeaway
Six skills ship in the plugin; five are bound to a command role via `roles.<r>.commands`, and `refactor-safely` is loaded by the regular developer and reviewer for refactor issues (or via `/refactor-safely`). All descriptions say "only load when the prompt asks for it".

### Cited Findings

| Skill | Trigger | Role that runs it | Produces | Arguments | Reference |
|---|---|---|---|---|---|
| `concept` | issue description starts with `/concept <file.md>` | analyst | Epics and sub-issues in Backlog with `Blocked by` dependencies and Model/Effort labels | `<path> [issue-models=...] [issue-efforts=...]` | `.claude/skills/concept/SKILL.md:2-4`; `WORKFLOW.md:75-76`, `:323` |
| `plan` | `/plan [file]` | planner | One sub-issue per list item with a detailed implementation plan, dependencies, category/effort/model labels, in Backlog | `[<path>] [issue-models=...] [issue-efforts=...]` | `.claude/skills/plan/SKILL.md:2-4`; `WORKFLOW.md:79-80`, `:333` |
| `auto-code` | `/auto-code` | autopilot | Next wave of sub-issues (features, design, quality, maintenance) that start in Ready; checkpoints every few waves | `[path] [wave=3] [checkpoint=5] [issue-models=...] [issue-efforts=...]` | `.claude/skills/auto-code/SKILL.md:2-4`, `:9-12`; `WORKFLOW.md:73-74`, `:311` |
| `refactoring` | `/refactoring [scope]` | auditor | Refactoring audit for a Laravel/Filament repository: baseline, bugs and candidates as sub-issues | `[scope]` | `.claude/skills/refactoring/SKILL.md:2-4`, `:9-14`; `WORKFLOW.md:71-72`, `:301` |
| `brain-garden` | `/brain-garden` | brain-gardener | Proposals (merges, fixes) as candidate notes in `Inbox/`; never promotes, never touches approved notes | none | `.claude/skills/brain-garden/SKILL.md:2-3`, `:11-14`; `WORKFLOW.md:77-78`, `:343` |
| `refactor-safely` | issue type `refactor` (prompt tells developer and reviewer to load `symphony:refactor-safely`), or description starts with `/refactor-safely` | developer and reviewer (no dedicated command role) | Behaviour-preserving procedure: characterization tests first; review checklist | `[optional hint]` | `.claude/skills/refactor-safely/SKILL.md:2-4`, `:9-11`; `roles/developer.md:45`; `roles/reviewer.md:62` |

- Mechanics: when the description starts with `/<name>` and `skills/<name>/SKILL.md` exists, the prompt tells the agent to load `symphony:<name>` with the Skill tool first — `WORKFLOW.md:585-587`, `.claude/README.md:54-58`.
- Supporting files per skill: auto-code (`ideation.md`, `templates.md`, `vision-template.md`), concept (`breakdown.md`, `templates.md`), plan (`labels.md`, `templates.md`), refactor-safely (`characterization-tests.md`, `review-checklist.md`), refactoring (`checklist.md`, `severity.md`, `templates.md`) — `git ls-tree origin/develop .claude/skills`.
- `.claude/commands/` and `.claude/hooks/` are empty (`.gitkeep` only); plugin manifest name `symphony`, version 0.1.0 — `.claude/.claude-plugin/plugin.json`.
- `claude.skills: all` makes repository skills, Laravel Boost skills and `symphony:*` skills available — `WORKFLOW.md:158`.

### Inferences
- `.claude/README.md:15-17` and `:54` list five skills and omit `brain-garden`: documentation drift.
- Three user-level skills visible in this session (`symphony-error-report`, `symphony-error-issues`, plus the brain import tools) are not part of the repository plugin; they are the owner's local Claude Code skills (see MEMORY index), not Symphony pipeline skills.

### Gaps
- Skill bodies beyond the first ~14 lines were not read in full (phases, sub-issue templates).

## 4. What changed between e064ff9 and origin/develop (18 commits) concerning agents, roles, prompts, subagent tracking, brain

### Takeaway
One new subagent (`spec-reviewer`), two new prompt partials for the review-lessons loop, a per-role auto-compact window, panel votes surfaced in comments and statistics, and subagent attribution by `agent_id`/`task_id`; the rest are prompt and tool bugfixes. Diff total: 113 files, +7076/-232.

### Cited Findings

Commit list from `git log --reverse e064ff9..origin/develop`; touched files from `git show --stat`. "Why" is taken from commit titles/bodies and in-file comments; where neither states a reason it is marked as such.

| Commit (date) | What | Why (as stated) | Agent-relevant files |
|---|---|---|---|
| 5f97f30, 58d6ee4, 94e342e (2026-11-06) and merge 78d8f2f (#547, "(E4-6) Maintenance: use the new SDK fields") | Subagent messages and `task_*` events are attributed by `agent_id` / `task_id` in addition to `parent_tool_use_id`; map `#subagentIds` | Concept item E4-6 "Use the new SDK fields" (`docs/concepts/subagents.md:696`) | `src/agent/claude.ts:144-146`, `:316-317`, `:899-910`, `:927-938`; test `test/subagent-attribution-acceptance.test.ts` |
| 6770e41 (#552) | `project_types` shown in the dry-run prompt preview | (E3-5) follow-up; no reason beyond title | no role/agent file; test `test/dryrun-project-types-independent.test.ts` |
| cb4a8bd (#556) | Tests for security panel wiring in the worker; rule sentence in the prompt tied to its constant | pin `PANEL_MAX_REFUTING_VOTES` to the sentence in `roles/security-auditor.md` (`src/workflow/results.ts:106-109`) | `src/workflow/results.ts`; `test/security-panel-wiring.test.ts` |
| 98c528a (#557) | Panel votes shown in the security comment | (E3-6) per title | `src/workflow/results.ts`; `test/panel-votes-comment-independent.test.ts` |
| 4bd1afa (#559) | Laravel-only checklist items in reviewer, security-auditor and test-engineer prompts only render when `project_types contains "laravel"` | Quality (#555): framework-neutral prompts for non-Laravel repos | `roles/reviewer.md:54-60`, `roles/security-auditor.md:23-27`, `roles/test-engineer.md:18`, `:21` |
| f7a2319 (#558) | `test/checks.test.ts` hermetic in agent workspaces | #551, leaked env variables | none (tests) |
| bfc0858 (#554/#560) | Security panel votes per lens in the statistics | per title | `src/workflow/results.ts`, `src/history/analytics.ts`; `test/security-panel-stats.test.ts` |
| 43ac8ad (#561/#562) | Planning roles (analyst, autopilot, planner) get a `screenshots_note`: they must not plan UI screenshots away or hand them to a human | "planning roles no longer assume UI screenshots are impossible" | `WORKFLOW.md:548-551`; `roles/analyst.md:12`, `roles/autopilot.md:12`, `roles/planner.md:12`; skills `auto-code/ideation.md`, `concept/breakdown.md`, `plan/SKILL.md` |
| bf18b22 (#564/#567) | Bash timeout default 10 min, max 20 min; prompts tell developer and test-engineer to run the full suite as one call | "so a full test run fits into one call" | `src/agent/claude.ts:70`; `WORKFLOW.md:160-162`; `roles/developer.md:43`; `roles/test-engineer.md:30` |
| 5bd0a48 (#565/#568) | `get_issue` returns PR description and discussion (`branch_pull_request.body`/`comments`); new tool `get_issue_by_number` for issue-analyst, reviewer, analyst | bugfix per title | `roles/issue-analyst.md:4`, `:11`; `roles/reviewer.md:15`, `:45`, `:49`; `roles/analyst.md:4`; `roles/developer.md:40` |
| 0b03334 (#569/#570) | Docs role gets `on_check_failed: In progress` and `In progress` in `may_move_to` | "docs cannot fix code" (flaky test, develop merge, developer bug) | `WORKFLOW.md:257-258`; `roles/docs.md`; `src/orchestrator/result-tool.ts` |
| d7d96b2 (#563/#566) | Empty/unreadable workspace lock files are reclaimed | bugfix; not agent-related | `src/workspace/lock.ts` |
| c12ddf6 (#503/#572) | **New subagent `spec-reviewer`**; developer allowlist gains it; early size-gated self-review before the first push (Laravel: `laravel-code-reviewer`, elsewhere `spec-reviewer`), none at S/M | Concept E3-1 "Early, size-gated self-review in the developer role" (`docs/concepts/subagents.md:536`) | `.claude/agents/spec-reviewer.md`; `WORKFLOW.md:168`, `:228`, `:471-472`; `roles/developer.md:8-12`, `:49`; `.claude/README.md:10`; `test/self-review-independent.test.ts` |
| 67e3010 (#571/#573) | `claude.auto_compact_window` global (200000) and per role (architect 400000); `budget.compact_threshold` becomes display fallback | per title; comment: "auto = the model window (1M on the 5-5 models, so it never compacts)" | `WORKFLOW.md:164`, `:220`, `:456`; `src/workflow/config.ts:110`, `:359`, `:804-805`; `src/workflow/roles.ts:11-13`; `src/agent/claude.ts:437`; `test/auto-compact-window-independent.test.ts` |
| 37200a4 (#575/#576) | **Review lessons loop**: findings get an optional `category` (kebab-case, max 40 chars); deterministic recurrence detection (`same_issue`, `cross_issue` within `window_days`/`min_issues`); prompt variables `recurring_findings`, `known_categories` (reviewer, security-auditor) and `brain_lessons` (developer, test-engineer, architect); `report_result` field `lessons` — first report without a lesson for a recurring category is refused, second accepted and logged as `lesson_missing`; config `brain.review_lessons` | commit body (German) as summarized | new `roles/brain-lessons.md`, `roles/recurring-findings.md`, `src/brain/review-recurrence.ts`; `roles/reviewer.md:32`, `:35`, `:77`, `:80`; `roles/security-auditor.md:40-42`; `roles/developer.md:13`, `:43`; `roles/architect.md:11`; `roles/test-engineer.md:9`; `roles/brain.md:13`; `src/workflow/results.ts:138-154`, `:239`, `:244`; `src/orchestrator/result-tool.ts:92-103`, `:538-575`; `src/orchestrator/worker.ts:481-501`; `WORKFLOW.md:463-467`, `:548` |

- Diff stat for agent-facing directories: `.claude` + `roles` = 18 files, +102/-52 — `git diff --stat e064ff9..origin/develop -- .claude roles`.
- `WORKFLOW.md` diff confirms the four config changes: developer `agents` + `spec-reviewer`, architect `auto_compact_window: 400000`, docs `on_check_failed`, `brain.review_lessons` block — `git diff -U0 e064ff9..origin/develop -- WORKFLOW.md`.
- New fixtures pin three role prompts byte-wise: `test/fixtures/role-prompts/{reviewer,security-auditor,test-engineer}.md` (diff stat).

### Inferences
- Since v1.4.0 the direction is unchanged: no new pipeline roles or columns, only one more size-gated helper and a feedback loop (reviewer findings → brain lessons → developer prompt). This matches the concept's non-goal "Symphony-run verification or test-design stages ... new roles and columns need a concept of their own" (`docs/concepts/subagents.md:746`).
- With `spec-reviewer` every item E3-1..E3-7 of the subagents concept has a shipped counterpart (headings `docs/concepts/subagents.md:536-620`); E2-5 (explorer evaluation) is the open measurement (MEMORY: #501 window).

### Gaps
- Issue/PR discussions (#503, #571, #575 etc.) were not read (no GitHub access by instruction); reasons are from commit messages and code comments only.
- Whether origin/develop is deployed in the container is unknown (not checked by instruction).

## 5. Mechanisms for adding a new agent or role; what 30 more would cost mechanically

### Takeaway
A new subagent is cheap: one Markdown file plus an allowlist entry and a prompt occasion, with validation and tests catching mistakes. A new pipeline role is expensive: it needs a board column, one of only seven hard-coded result kinds (or new code), transitions, a prompt file and a `when` line; a new command role needs a skill folder and a role entry. Thirty more *subagents* are mechanically feasible; thirty more *pipeline roles* are not without code and board changes.

### Cited Findings

Adding a subagent:
1. Create `.claude/agents/<name>.md` with front matter `name`, `description` (routing instruction: trigger + exclusion), optional `model`, `effort`, `maxTurns`, and `disallowedTools: Edit, Write, NotebookEdit` for read-only — `.claude/README.md:46-52`; pattern e.g. `.claude/agents/spec-reviewer.md:1-7`. Discovery is automatic by directory scan — `src/workflow/command.ts:94-120`.
2. Add the name to `roles.<role>.agents` in `WORKFLOW.md` (names without plugin prefix) — `WORKFLOW.md:167-168`, `src/workflow/config.ts:749-759`. Every shipped role declares an explicit `agents` key (test: `test/workflow-prompt.test.ts:1407`).
3. Validation: unknown name or writing agent in read-only role fails the dispatch preflight — `src/workflow/validate.ts:59-65`.
4. Framework scoping is by name prefix: `laravel-` is the only registered integration prefix — `src/laravel/integration.ts:45`, `:94-95`; `src/workflow/roles.ts:145-146`.
5. Prompt wiring: the agent appears automatically in `agent_list` with its description (`WORKFLOW.md:471-472`), but a size gate or a "When to delegate" occasion needs hand-written Liquid in `WORKFLOW.md:471-472` (hidden flags, named variables such as `explorer_agent`, `spec_agent`) and in the role file (e.g. `roles/developer.md:8-12`, `roles/reviewer.md:1`, `:64-72`).
6. If the agent's output must be enforced, the result contract in code must change (`src/workflow/results.ts`, `src/orchestrator/result-tool.ts:283-298`).
7. Tests that pin the agent set and prompts: `test/workflow-prompt.test.ts:1356` (shipped roles only get shipped agents, read-only to read-only roles), `:1407`, `:1751-1776` (toolbox subagents: named like file, prefix rule, MCP tools kept), `test/agent-occasions.test.ts:33` (list `ALL` of agents), `:115` (every bullet has trigger and exclusion), plus per-agent "independent" tests (`test/explorer-independent.test.ts`, `test/design-critic-independent.test.ts`, `test/self-review-independent.test.ts`, `test/test-designer-independent.test.ts`, `test/lens-review-independent.test.ts`, `test/security-panel-independent.test.ts`) and byte-identity fixtures `test/fixtures/role-prompts/*.md`.

Adding a command role (like `/plan`):
1. `.claude/skills/<name>/SKILL.md` (folder name = command, lowercase/digits/hyphens; description says "only load when the prompt asks") — `.claude/README.md:56-66`, `src/workflow/command.ts:5`.
2. Role entry with `commands: [<name>]` in `WORKFLOW.md`; dispatch validation checks the skill exists — `.claude/README.md:69-70`, `src/workflow/validate.ts:52-56`, `src/workflow/config.ts:735-746`.
3. `roles/<role>.md` and a `when` line in the `case role` block — comment "New role: add the file and a when line" `WORKFLOW.md:591-605`.
4. `test/workflow-prompt.test.ts:1572-1636` checks for every skill that name and folder match and linked files exist (`.claude/README.md:71`).
5. A command without a dedicated role falls to the plain role of the column (as `/refactor-safely` does with developer/reviewer) — `src/workflow/roles.ts:108-117`.

Adding a pipeline role (new stage):
1. Board column + `tracker.active_states` — `WORKFLOW.md:35`, `:81-83`.
2. Role entry: `states`, `result`, `on_result`, `may_move_to`, optional `on_check_failed`, `read_only`, `agents`, `brain`, `claude` — allowed keys `src/workflow/config.ts:313-335`, `:359`; type `src/workflow/roles.ts:38-96`.
3. `result` must be one of the seven `AGENT_RESULT_KINDS`; verdicts in `on_result` must belong to that kind — `src/workflow/results.ts:13`, `:22-32`; `src/workflow/config.ts:467`, `:488-492`. A new kind with its own fields needs a schema in `results.ts` and handling in `result-tool.ts`.
4. Roles are resolved per (command, state): "the role without commands that serves it" — one plain role per column — `src/workflow/roles.ts:104-117`, `src/workflow/config.ts:373-397`.
5. Path-restricted writer roles reuse the existing rule mechanism (`pipeline.test_paths`, `pipeline.docs_paths`) — `src/orchestrator/result-tool.ts:72-86`, `WORKFLOW.md:401-407`.
6. Slots: each additional stage competes for `max_concurrent_agents` (default 3) beyond the reserved developer/reviewer slots — `WORKFLOW.md:116`, `:131-138`.
7. Removal recipe documented for docs and security stages (delete role, column, `may_move_to` entry) — `WORKFLOW.md:251-252`, `:284-285`.

Constraints that shape any larger catalogue:
- Subagent nesting is capped at one level; no built-in agents; no forks; foreground only — `src/agent/claude.ts:63-75`.
- A subagent sees neither the role prompt nor the issue, only the brief plus up to 4,000 characters injected context — `WORKFLOW.md:472`, `src/agent/claude.ts:93`, `:518-531`.
- Plugin agents ignore their own `hooks` (stated in the concept) — `docs/concepts/subagents.md:792-793`.
- Concept non-goals: parallel writing subagents on coupled files, mandatory delegation at S/M, agent teams (~7× tokens), forks, Symphony-run verification stages, a global model force — `docs/concepts/subagents.md:738-750`.
- Subagent runs are tracked per session (board of running + last 10 finished) and evaluated in statistics — `src/orchestrator/subagents.ts:4-36`; tests `test/subagent-tracking-acceptance.test.ts`, `test/subagent-evaluation-independent.test.ts`.
- The agent description is always rendered into the role prompt for every allowed, non-hidden agent (`- \`{{ agent.name }}\`: {{ agent.description }}`) — `WORKFLOW.md:471-472`.

### Inferences
- Marginal cost of one more subagent ≈ 1 file + 1 allowlist entry + 0-2 Liquid edits + test list updates (`agent-occasions.test.ts:33`, `workflow-prompt.test.ts:1755`, fixtures if a pinned prompt changes). Thirty more would mainly cost prompt length (each allowed agent adds its description line to every session of that role) and test maintenance, not code.
- There is no generic, data-driven gate (e.g. front matter `complexity: [L, XL]` or `occasion:`); every gate is bespoke Liquid keyed on the agent's short name. For 30+ agents this hand-wiring in `WORKFLOW.md:471-472` is the scaling bottleneck and a natural refinement candidate.
- Only one framework prefix exists (`laravel-`); stack-specific roles for other stacks (e.g. `node-`, `react-`) would need an integration that reports `agentPrefixes`, analogous to `src/laravel/integration.ts:94-95`.
- "50 roles" maps onto Symphony most naturally as: few pipeline roles (columns) + many size- or occasion-gated subagents + command skills; `MAX_SLOTS = 50` is unrelated to the number of roles.

### Gaps
- The exact contents of the pinned lists in `test/workflow-prompt.test.ts:1755-1776` and `test/agent-occasions.test.ts:33-60` were seen only as headings/first line; which assertions break on adding an agent was not executed (no test run).
- `docs/configuration.md` and `docs/agent-claude.md` sections on subagents were not read line by line; statements here rest on code and `WORKFLOW.md`.

## 6. Pipeline parts with no dedicated agent or role today

### Takeaway
Symphony covers analysis → design → implementation → tests → docs → review → security plus five planning/maintenance commands. Operations-side work (dependencies, release, changelog, CI/flaky triage, performance, accessibility, issue dedup) has no dedicated role or subagent; some of it is handled mechanically or as a checklist bullet, and several helper agents are explicitly deferred in the concept.

### Cited Findings

Explicitly deferred in the roadmap ("Not in this concept", waiting for the E2-5 evaluation) — `docs/concepts/subagents.md:752-759`:
- haiku duplicate finder for the issue analyst
- haiku link and reference checker for docs
- haiku checkers per vault folder for the brain gardener
- per-section drafters and a feasibility checker for planner, analyst, autopilot
- inventory, per-component auditors and a verifier for the auditor
- a test runner with verbatim failure excerpts for the developer
- preloading Boost skills per persona through `skills:`

Best-practice table per role (recommended pattern vs. what to leave out) — `docs/concepts/subagents.md:214-225`; additionally names a "read-only test-quality judge" for the test engineer (`:219`), which has no shipped agent.

Area-by-area status at 37200a4:

| Area | Dedicated role/agent? | What exists instead | Reference |
|---|---|---|---|
| Dependency updates | none | Security checklist bullet "Dependencies and configuration: new packages from unknown sources"; `auto-code` plans "maintenance tasks" generically | `roles/security-auditor.md:30`; `.claude/skills/auto-code/SKILL.md:3` |
| Release / versioning | none | Autopilot may open "the release pull request the skill describes"; auto-merge never merges into the default branch; release flow is human (MEMORY: docs/gitflow.md) | `roles/autopilot.md:4`; `WORKFLOW.md:18-19` |
| Changelog | none | Docs role may edit `CHANGELOG*.md` (default `docs_paths`), but is only triggered by `docs_needed` or config-path changes | `WORKFLOW.md:403-407`, `:53-58` |
| PR description | none | Developer writes it via `open_pull_request` ("Closes #N", screenshots) | `roles/developer.md:49` |
| Migration safety | partial: `laravel-database-engineer` (Laravel only, writer, developer-called) | Reviewer bullet "Migrations: reversible ...", security bullet "Migrations", design field `migrations`/`compatibility` | `.claude/agents/laravel-database-engineer.md:14-18`; `roles/reviewer.md:58`; `roles/security-auditor.md:29`; `roles/architect.md:35` |
| Performance | none | Reviewer bullet "Queries: no N+1"; DB engineer mentions N+1 | `roles/reviewer.md:57`; `.claude/agents/laravel-database-engineer.md:17` |
| Accessibility / UX review | none | UI screenshots are required and checked for presence, not judged for a11y | `roles/reviewer.md:61`; `WORKFLOW.md:539-547` |
| CI failure triage | none (mechanical routing) | Failed entry checks and failed PR checks go back to the developer with the output; `max_check_failures: 3`, `max_send_backs: 2` then needs-human | `WORKFLOW.md:27-34`, `:257`, `:271`, `:293`, `:362-364`; `roles/developer.md:40`, `:61-63` |
| Flaky tests | none | Mentioned only as a cause in a comment ("flaky test, develop merge, developer bug"); no detection or quarantine | `WORKFLOW.md:257` |
| Issue triage / dedup | partial: issue-analyst classifies Type/Complexity and refines criteria | Duplicate finder deferred; `create_sub_issue` returns an open sub-issue with the same title instead of creating it twice | `roles/issue-analyst.md:3`; `docs/concepts/subagents.md:216`, `:755`; `roles/architect.md:19` |
| Test-quality judging | none | Mutation score (Laravel/Pest only) and RED-at-base evidence in `report_result` | `src/orchestrator/result-tool.ts:488-503`; `docs/concepts/subagents.md:219`, `:789-791` |
| Refactoring audit for non-Laravel repos | none | `refactoring` skill is described as "for a Laravel/Filament repository" | `.claude/skills/refactoring/SKILL.md:3` |
| Non-Laravel stack specialists | none | Only `laravel-*` personas; `spec-reviewer` is the neutral fallback | `src/laravel/integration.ts:45`; `WORKFLOW.md:228` |
| Brain lesson authoring for security | partial | Security auditor has `brain: read`; rule goes into `summary` for the reviewer | `WORKFLOW.md:298`; `roles/security-auditor.md:42` |
| Integration engineer | deliberately none | "Work packages instead of an integration engineer"; reviewer runs an integration review | `docs/concepts/multi-agent.md:114`; `roles/reviewer.md:12-14` |
| Merge / Done decision | deliberately none | "It does not decide on `Done`: only a human merges and closes" (auto-merge into `base_branch` is opt-in) | `docs/concepts/multi-agent.md:152`; `WORKFLOW.md:17-25` |
| Several roles on one issue at once | deliberately none | "parallel work is parallel issues" | `docs/concepts/multi-agent.md:155-156` |
| Other backends (Copilot runner, failover) | concept only | Stage 1 named backends + failover through OmniRoute, Stage 2 Copilot runner | `docs/concepts/multi-backend.md:41`, `:143` |

- Keyword search over the three concept documents returned no hits for accessibility/a11y/WCAG, flaky, performance/N+1, i18n/translation, observability/incident, or PR description — `git grep -i` on `docs/concepts/{subagents,multi-agent,multi-backend}.md` at origin/develop.
- Roles without any subagent today: issue-analyst, docs, brain-gardener (`agents: []`) — `WORKFLOW.md:194`, `:259`, `:351`.
- Roles without brain access: docs, auditor, autopilot, analyst, planner (no `brain` key → `off`) — `WORKFLOW.md:253-262`, `:300-341`; default in `src/workflow/config.ts:448`.

### Inferences
- The clearest "free" slots for a role catalogue, judged by what the repo itself already names as wanted: duplicate finder (issue-analyst), docs link/reference checker, vault checkers, plan drafters + feasibility checker, component auditors + verifier for `/refactoring`, test runner, test-quality judge.
- Areas the repo neither covers nor plans (accessibility, performance profiling, dependency updates, release/changelog, flaky-test handling, i18n, observability) would be genuinely new territory; under the concept's own rules they would have to be either size/occasion-gated read-only subagents of existing roles or new command skills, since new columns are a declared non-goal of the subagents concept.
- CI triage is currently "developer reads the check output"; because the developer only gets a check's name and URL for PR checks and not the log (`roles/reviewer.md:49`), a log-reading triage helper would fill an actual information gap.

### Gaps
- `docs/concepts/multi-backend.md` and `docs/concepts/multi-agent.md` were scanned by headings and targeted lines, not read in full; their implementation status at 37200a4 was not verified against code.
- Role prompts of docs, issue-analyst and the command roles were not read to the end, so a checklist bullet touching one of the "none" areas could exist there; the developer, reviewer, security-auditor, test-engineer and architect prompts were read completely.
- No usage data (how often each agent/role actually runs, bounce rates per stage) was collected; MEMORY mentions a 2026-11-11 baseline of 48 review bounces in 7 days (#575), which is outside the repository and not verified here.
- The earlier report `reports/Subagents pro Rolle in Symphony.md` was not opened for comparison (budget of tool calls); differences to it are not listed.
