# Laravel subagents and workflow roles

Status: **implemented** (phases 1–4). The findings below describe the state before; they are kept as background.

Symphony's toolbox ([`.claude/`](../.claude/README.md)) ships five subagents for Laravel repositories. This document
records how they relate to the roles in [`WORKFLOW.md`](../WORKFLOW.md) today, what the session logs say about their
use, and how roles and subagents are to be tied together.

## Findings

Sources: the code on `main` (605022f) and the transcripts of all agent sessions in the running instance
(`~/.local/state/symphony/sessions/`, 522 transcript files, 535 sessions, 2026-10-05 to 2026-10-14).

### The subagents are loaded into every session

`claude.plugins: [./.claude]` becomes `options.plugins` of every Claude Code session
([`src/agent/claude.ts`](../src/agent/claude.ts), `#options()`). Claude Code reports them in the `init` message of
each transcript:

| `init.agents` entry | Sessions |
|---|---|
| `symphony:architect`, `symphony:code-reviewer`, `symphony:database-engineer`, `symphony:filament-developer`, `symphony:test-engineer` | 471 each |
| `architect`, `code-reviewer`, … (unprefixed) | 93 each |

The 93 unprefixed entries are sessions on the Symphony repository itself: its clone carries `.claude/agents/`, and
`claude.setting_sources: [project]` loads them a second time as project agents. Sessions recorded before the plugin
was configured have no `symphony:*` entries.

### Nothing ties them to a role

- The role sections of the `WORKFLOW.md` prompt (developer, reviewer, auditor, planner, analyst) never mention a
  subagent.
- Neither the system prompt addition (`symphonyContext()` in `src/agent/claude.ts`) nor the Laravel Boost context
  section (`contextSection()` in `src/laravel/boost.ts`) lists them.
- `RoleConfig` ([`src/workflow/roles.ts`](../src/workflow/roles.ts)) has no field for subagents; every role can call
  every subagent.
- The only reference is in the `refactoring` skill (auditor), which suggests `symphony:architect` and
  `symphony:code-reviewer` for large repositories. No auditor session has run yet.

The subagents are therefore available everywhere, also in repositories without Laravel, but the agent only finds out
about them from the tool list Claude Code builds from their `description`.

### They are almost never used

Agent tool calls in all 535 sessions:

| Role | Calls |
|---|---|
| developer (Laravel) | 2 × `symphony:code-reviewer` (cooolinho/marktausschuss#20 and #29: self-review of the diff before the hand-off) |
| developer (other) | 2 × `general-purpose`, 1 × `Explore`, 3 × without `subagent_type` |
| every other role | none |

`architect`, `database-engineer`, `filament-developer` and `test-engineer` were never called (the `Design` column with its own architect role, added afterwards, gives the architect subagent a place in the flow). The reviewer role
carries its own checklist in the prompt that largely repeats `code-reviewer.md`.

For comparison, the Skill tool was called 80 times, mostly Boost skills in Laravel developer sessions
(`filament-development` 24, `testing-best-practices` 17, `laravel-best-practices` 4) and the command skills.

### The statistics cannot show subagents

The dashboard's "Tools" panel lists built-in tools, MCP tools and "Skills loaded". A subagent call only ever shows
up as the tool `Agent`:

1. `#onAssistant()` in `src/agent/claude.ts` emits one `tool_use` event per call with `detail.tool` (the tool name)
   and, only for the `Skill` tool, `detail.skill`. The `subagent_type` of an `Agent` (older: `Task`) call is dropped.
2. `countToolUse()` ([`src/orchestrator/tool-usage.ts`](../src/orchestrator/tool-usage.ts)) counts per tool and per
   skill only.
3. `run_finished` in the repository log ([`src/history/history.ts`](../src/history/history.ts)) writes `tool_calls`
   and `skill_calls`; [`src/history/analytics.ts`](../src/history/analytics.ts) and the logs page aggregate those.

So even a run that used `symphony:code-reviewer` counts as "Agent: 1". The tool calls of a subagent itself
(`parent_tool_use_id` set) are counted into the run like the main agent's.

The orchestrator's `/api/v1/state` response now tracks individual subagent runs (start, end, tokens) alongside
`agent_calls`; this data is available for the team view (E3-3) and team API (E3-2).

### Further issues

- **`code-reviewer` lacked the Boost tools it asks for.** Its front matter allowed only `Read, Grep, Glob, Bash`,
  which excludes `mcp__laravel-boost__*`, yet its instructions require `search-docs`, `database-schema` and
  `database-query`. Fixed in phase 1 (see below).
- **Read-only roles and writing subagents.** A read-only role denies `Edit`, `Write`, `NotebookEdit`, `git commit` and
  `git push` for the session (`READ_ONLY_DENY` in `src/agent/claude.ts`). Nothing stops a reviewer from starting
  `laravel-filament-developer`; whether the session's deny rules reach the subagent has to be verified (phase 2 makes
  the question moot: read-only roles never get writing subagents).

## Phase 1: `laravel-` prefix (done)

All five subagents are Laravel-specific (Boost tools, Pest, Filament, Eloquent), so all five carry the prefix. The
prefix states the scope at a glance and lets Symphony switch the whole group off outside Laravel workspaces
(phase 2).

| Before | After | Called as |
|---|---|---|
| `architect` | `laravel-architect` | `symphony:laravel-architect` |
| `code-reviewer` | `laravel-code-reviewer` | `symphony:laravel-code-reviewer` |
| `database-engineer` | `laravel-database-engineer` | `symphony:laravel-database-engineer` |
| `filament-developer` | `laravel-filament-developer` | `symphony:laravel-filament-developer` |
| `test-engineer` | `laravel-test-engineer` | `symphony:laravel-test-engineer` |

- `name:` in the front matter equals the file name.
- `laravel-architect` and `laravel-code-reviewer` only read: instead of an allowlist (`tools:`), which drops MCP tools,
  they deny `Edit, Write, NotebookEdit` (`disallowedTools:`) and keep everything else, Boost included.
- References updated: `.claude/README.md`, `README.md`, `README.de.md`, the `refactoring` skill.
- `test/workflow-prompt.test.ts` checks that every agent is named like its file and that Laravel agents carry the
  prefix.

Rule for new agents: a subagent that only makes sense for one framework carries that framework as prefix
(`laravel-…`); framework-neutral subagents carry none.

## Phase 2: roles choose their subagents (done)

### Configuration: `roles.<role>.agents`

```yaml
roles:
  developer:
    agents: [laravel-architect, laravel-database-engineer, laravel-filament-developer, laravel-test-engineer, laravel-code-reviewer]
  reviewer:
    agents: [laravel-code-reviewer]
```

- Names are the plugin agents' names without the plugin prefix.
- Omitted: every plugin agent (the current behaviour). `[]`: none.
- `src/workflow/validate.ts` rejects names no plugin ships, like it rejects unknown `roles.<role>.commands`.
- Built-in agents (`Explore`, `Plan`, `general-purpose`) are not affected.

### Enforcement

- New `pluginAgents(pluginDirs)` in [`src/workflow/command.ts`](../src/workflow/command.ts), next to `commandSkills()`
  and reusing `pluginName()`: reads `agents/*.md` of each plugin and returns name → qualified name
  (`symphony:<name>`) and `description`.
- `RoleConfig.agents: string[] | null`, parsed in `src/workflow/config.ts` like `readRoleCommands()`.
- `laravel-*` agents are available only when the Laravel integration found an app in the workspace; outside Laravel
  workspaces they count as not allowed.
- The worker (`src/orchestrator/worker.ts`, before `startSession`) adds a deny rule per plugin agent that is not
  allowed, in both forms (`Agent(symphony:<name>)` and `Agent(<name>)`, the latter for the Symphony repository's own
  project agents) to the session's `disallowedTools` (merged in `sessionClaudeConfig()`).
- A `PreToolUse` hook (matcher `Agent|Task`, in `src/agent/claude.ts`) refuses a call that names a denied subagent
  anyway and emits `approval_denied`.
- Verified with a real session (Claude Code 2.1.288): with `Agent(symphony:filament-developer)` in `disallowedTools`
  the call fails with "Agent type 'symphony:filament-developer' has been denied by permission rule
  'Agent(symphony:filament-developer)' from cliArg", while another plugin subagent runs normally. The denied agent
  still appears in `init.agents`; the refusal happens at call time.

### Prompt: template variable `agents`

The prompt scope gets `agents` next to `issue`, `attempt` and `role` (always defined, empty without subagents): the subagents allowed in this session, each with
`name` (qualified) and `description`. Each role section in `WORKFLOW.md` renders them only when the list is not empty
(`{% if agents.size > 0 %}`), with role-specific guidance. The calls stay optional: every subagent costs its own
context and tokens.

| Role | `agents` | Guidance in the prompt |
|---|---|---|
| architect | `laravel-architect` | structure of a Laravel or Filament change; the role itself decides and reports the `design` result, and runs only for larger changes ([details](configuration.md#the-architect)) |
| developer | all five | `laravel-architect` before a non-trivial feature, unless the architect stage already delivered a design (`results.design` in the prompt); `laravel-filament-developer`, `laravel-database-engineer`, `laravel-test-engineer` for self-contained parts; `laravel-code-reviewer` on the diff before `set_status("Agent review")` |
| test engineer | `laravel-test-engineer` | a self-contained group of tests; the role itself is the independent tester of the acceptance criteria and may only change test files ([details](configuration.md#the-test-engineer)) |
| reviewer | `laravel-code-reviewer` | optional second pass over a large diff; the reviewer still checks its findings and writes the one review comment |
| auditor | `laravel-architect`, `laravel-code-reviewer` | one area each in large repositories (what the `refactoring` skill describes) |
| autopilot | `laravel-architect` | structure and feasibility of a wave |
| analyst | `laravel-architect` | structure and feasibility of the concept's epics |
| planner | `laravel-architect` | implementation plan of a large or risky list item |

Read-only roles only get read-only subagents.

## Phase 3: subagents in the statistics (done)

- `src/agent/claude.ts`: an `Agent` or `Task` call additionally emits `detail.agent` = `subagent_type`
  (`general-purpose` when unset, which is Claude Code's default).
- `ToolUsage` gets `agents: Record<string, number>`; `countToolUse()` counts them.
- `run_finished` gets the field `agent_calls` (`formatToolCalls()`; `parseCounts()` already handles names with
  colons such as `symphony:laravel-architect`).
- `src/history/analytics.ts` ranks them like skills; the statistics page shows "Subagents used" after "Skills loaded".
  Per run they are in `agent_calls` of `GET /api/v1/state` (running) and of `run_trace` in `GET /api/v1/<identifier>`.
- Older runs have no `agent_calls`; the note under the panel already says so for tool calls.

## Phase 4: documentation (done)

- [configuration.md](configuration.md#subagents-per-role): `roles.<role>.agents`, the prompt variable `agents` and
  `agent_calls` in the repository log.
- [agent-claude.md](agent-claude.md#subagents): how subagents are loaded, denied per role and counted.
- `.claude/README.md`: the prefix rule for framework-specific subagents.

## Verification

- Tests in a throwaway container (the host has no Node):

  ```bash
  docker run --rm --entrypoint sh -v "$PWD":/src:ro symphony:local -c 'mkdir /tmp/w && cp -r /src/. /tmp/w/ && rm -rf /tmp/w/node_modules && ln -s /app/node_modules /tmp/w/node_modules && cd /tmp/w && node --test --test-concurrency=1 "test/**/*.test.ts"'
  ```

- Phase 2: config and validation tests for `agents` (`test/workflow.test.ts`), an orchestrator test for the deny
  list and the prompt variable in Laravel and non-Laravel workspaces and for a read-only role
  (`test/orchestrator.test.ts`), deny rule and hook (`test/claude.test.ts`), the `agents` block of every shipped role
  and the shipped role lists (`test/workflow-prompt.test.ts`).
- Phase 3: `detail.agent` (`test/claude.test.ts`), `agent_calls` in run trace and repository log
  (`test/orchestrator.test.ts`, `test/history.test.ts`), the ranking (`test/analytics.test.ts`).
- Still open, after deploying: one Laravel issue through developer and reviewer, then check that the dashboard shows
  "Subagents used" and that a non-Laravel repository's sessions refuse `laravel-*` subagents.
