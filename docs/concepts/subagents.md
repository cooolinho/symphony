# Concept: subagents per role

Status: proposed · Research of 2026-11-05 (live data since 2026-10-20, code at `02e05e5`, references checked at
`4882c0c`) · Version of the concept: 1

This page describes how Symphony's roles use Claude Code subagents today, what the evidence says about where they pay
off, and what is to change. It links to the reference pages instead of repeating them: the configuration is in
[configuration.md](../configuration.md#subagents-per-role), loading, denial and accounting are in
[agent-claude.md](../agent-claude.md#subagents), the history of the `laravel-*` toolbox is in
[laravel-subagents.md](../laravel-subagents.md), the result contracts are in [results.md](../results.md).

## Summary

**What exists.** The mechanics are complete: a toolbox plugin with five `laravel-*` personas, an allowlist per role
(`roles.<role>.agents`), deny rules plus a `PreToolUse` hook against agents a role may not use, a prompt block that
lists the allowed agents, and live tracking on the issue page.

**The problem.** It is wired but almost unused, and the measurements mislead:

- Since 2026-10-20 only **48 of 1,686 runs (2.8 %)** started any subagent: 28 developer, 19 architect and one analyst
  run, all in Laravel workspaces. **No sonnet developer run delegated** (0 of 252); the 28 delegating developer runs
  ran on opus (20) or fable (8).
- **Three of five personas were never called** in 2,745 logged runs (`laravel-database-engineer`,
  `laravel-filament-developer`, `laravel-test-engineer`).
- **Nothing exists outside Laravel**: every role in every other repository (Symphony itself: 156 developer runs since
  2026-10-20) gets no subagent and no subagent text. No persona sets `model`, `effort` or `maxTurns`, so every subagent
  runs on the parent's model. docs, brain-gardener and the default role have no allowlist, and "unset" means "all".
- **Misleading measurements**: the context fill uses 200k instead of the reported 1M window; the subagent token figure
  includes cache reads (about 8× Claude Code's own); a subagent killed by the usage limit counts as `ok`; `tool_calls`
  mixes main-thread and subagent calls; the issue page forgets a subagent once its run has ended.

**Guiding principle.** The column pipeline already is the multi-agent system: every column starts fresh, and the
reviewer and security auditor never saw the developer's reasoning. Second-level subagents earn their cost only in
three ways:

1. **Cheap reading under expensive models**: exploration moves out of an opus or fable main thread.
2. **Information boundaries the columns do not draw**: tests designed without the implementation, critique of a design
   before it leaves the column.
3. **Parallel lenses with per-finding verification** on large diffs.

Writing roles (developer, docs) stay a single writer. Personas that only repeat the role add nothing.

## Current state

### Plugin and personas

- `claude.plugins: [./.claude]` loads the toolbox into every session ([WORKFLOW.md:157](../../WORKFLOW.md#L157),
  [claude.ts:381](../../src/agent/claude.ts#L381)). [`.claude/agents/`](../../.claude/agents) holds five personas:
  `laravel-architect` and `laravel-code-reviewer` set `name`, `description` and
  `disallowedTools: Edit, Write, NotebookEdit`; the other three set only `name` and `description`. None sets `model`,
  `effort`, `tools`, `maxTurns`, `skills` or `omitClaudeMd`.
- Symphony reads `name`, `description`, `tools` and `disallowedTools`; its parser understands one-line `key: value`
  entries only ([command.ts:79-88](../../src/workflow/command.ts#L79-L88)), so YAML lists must be comma strings. An agent
  is read-only when `Edit` and `Write` are denied or missing from `tools`; Bash is not considered
  ([command.ts:95-121](../../src/workflow/command.ts#L95-L121), readOnly at :116).
- In sessions on the Symphony repository the agents load twice, as plugin and as unprefixed project agents
  (`setting_sources: [project]`, 15 entries in `init.agents`).

### Who gets which subagent

`sessionAgents()` allows an agent when the role lists it (or lists none), when it is read-only or the role may write,
and when its integration prefix is active ([roles.ts:131-150](../../src/workflow/roles.ts#L131-L150), called in
[worker.ts:513-520](../../src/orchestrator/worker.ts#L513-L520)). `laravel-` is active only when the Laravel integration
found an app ([integration.ts:94-95](../../src/laravel/integration.ts#L94-L95)); an agent without a prefix would be
available everywhere (:145-146), but none ships yet.

| Role | Model / effort | `agents` in WORKFLOW.md | Laravel workspace gets | Elsewhere | Guidance in the role prompt | Runs since 2026-10-20 (with subagent) |
|---|---|---|---|---|---|---|
| issue-analyst | sonnet / medium, `max_turns: 3` | `[laravel-architect]` ([:190](../../WORKFLOW.md#L190)) | laravel-architect | none | feasibility of a larger plan | 207 (0) |
| architect | opus / high, fable at L/XL | `[laravel-architect]` ([:214](../../WORKFLOW.md#L214)) | laravel-architect | none | structure, checked against the code | 170 (19) |
| developer | `claude.model`, opus at L/XL | all five ([:224](../../WORKFLOW.md#L224)) | all five | none | plan, specialist, review before the result ([developer.md:8](../../roles/developer.md#L8)) | 371 (28) |
| test-engineer | sonnet / high | `[laravel-test-engineer]` ([:240](../../WORKFLOW.md#L240)) | laravel-test-engineer | none | a self-contained group of tests | 349 (0) |
| docs | haiku / medium, `acceptEdits` | `[]` ([:249-256](../../WORKFLOW.md#L249-L256)) | none | none | none (no intro block) | 124 (0) |
| reviewer | opus / high | `[laravel-code-reviewer]` ([:269](../../WORKFLOW.md#L269)) | laravel-code-reviewer | none | second pass over a large diff | 330 (0) |
| security-auditor | opus / high | `[laravel-code-reviewer]` ([:291](../../WORKFLOW.md#L291)) | laravel-code-reviewer | none | as the reviewer | 128 (0) |
| auditor `/refactoring` | fable, $15 | architect + code-reviewer ([:302](../../WORKFLOW.md#L302)) | both | none | one area per agent | – |
| autopilot `/auto-code` | fable, $10 | `[laravel-architect]` ([:314](../../WORKFLOW.md#L314)) | laravel-architect | none | feasibility of a wave | 1 (0) |
| analyst `/concept` | fable / high, $20 | `[laravel-architect]` ([:324](../../WORKFLOW.md#L324)) | laravel-architect | none | feasibility of the epics | 6 (1) |
| planner `/plan` | fable / high, $20 | `[laravel-architect]` ([:334](../../WORKFLOW.md#L334)) | laravel-architect | none | plan of a risky list item | – |
| brain-gardener | opus, $5 | `[]` ([:336-345](../../WORKFLOW.md#L336-L345)) | none | none | none | – |
| default (no `roles`) | `claude.model` | – | **all five** | none | **none** | – |

- "Unset = all" is the documented default ([config.ts:730-742](../../src/workflow/config.ts#L730-L742)) for custom
  workflows; the shipped roles list their agents explicitly. `docs` and `brain-gardener` now set `agents: []`
  in [WORKFLOW.md:249-256, 336-345](../../WORKFLOW.md#L249-L256), denying all Laravel subagents in [workflow-prompt.test.ts:1012-1025](../../test/workflow-prompt.test.ts#L1012-L1025).
- **Built-in agents are never filtered**: `claude`, `Explore`, `general-purpose`, `Plan` and `statusline-setup` are in
  every `init.agents`, `general-purpose` with all tools also in read-only roles. No prompt mentions them; they were last
  used on 2026-10-11.

### Enforcement

- Denied plugin agents are refused twice: `Agent(<qualified>)` and `Agent(<bare name>)` in `disallowedTools`
  ([claude.ts:345-358](../../src/agent/claude.ts#L345-L358), [worker.ts:680-681](../../src/orchestrator/worker.ts#L680-L681)),
  and a `PreToolUse` hook on `Agent|Task` that refuses with its own reason and emits `approval_denied`
  ([claude.ts:385-386](../../src/agent/claude.ts#L385-L386), [:428-441](../../src/agent/claude.ts#L428-L441)). A denied
  agent still appears in `init.agents`; the comment "The deny rules hide the subagents" (:385) is wrong.
- An unknown agent name, or a writing agent in a read-only role, is a config error
  ([validate.ts:59-67](../../src/workflow/validate.ts#L59-L67)).
- "Read-only" means `Edit`, `Write`, `NotebookEdit`, `git commit` and `git push` (`READ_ONLY_DENY`,
  [claude.ts:61](../../src/agent/claude.ts#L61)), not shell writes. Live developers edit through Bash all the time: 17–24
  edit scripts (`fs.writeFileSync`, `perl -pi`, `sed -i`) per sampled session.
- Per the Claude Code docs, deny rules and hooks also apply inside subagents. Symphony only tests that the deny list and
  the hook block the spawn ([claude.test.ts:549-566](../../test/claude.test.ts#L549-L566)); whether a subagent in a
  read-only role really cannot write is neither tested nor observed.

### Prompt

- The roles render the agent list only when it is not empty. `agent_intro` reads: "Subagents you may start … They are
  optional: each one works in its own context and costs tokens, so use them where they pay off. You stay responsible
  for their results" ([WORKFLOW.md:460](../../WORKFLOW.md#L460)), followed by one line of occasions per role. docs,
  brain-gardener and default have no intro block; the intro test covers six roles only
  ([workflow-prompt.test.ts:990-1001](../../test/workflow-prompt.test.ts#L990-L1001)).
- Subagents run in the foreground: the system prompt asks for it and `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` enforces it
  ([claude.ts:54](../../src/agent/claude.ts#L54), [:181-182](../../src/agent/claude.ts#L181-L182); rationale in
  [agent-claude.md](../agent-claude.md#subagents)). On bandenhub#11 (2026-10-21) the developer started its reviewer in
  the background, Symphony ended the run after 9.3 s, and the review was lost.
- **Symphony's appended context does not reach subagents.** Issue, role and tool names are part of the parent's system
  prompt (`preset: claude_code` with `append`, [claude.ts:360-364](../../src/agent/claude.ts#L360-L364)). A non-fork
  subagent sees only its persona, the CLAUDE.md hierarchy (not Explore and Plan) and the brief the main agent writes.
- For Opus 5 the `claude_code` preset adds a line telling Claude not to call the Agent tool unless asked. Whether it
  applies to Opus 5.5, Sonnet 5.5 or Fable 5.1 is not documented (spike E0-1).

### Model resolution

- Claude Code's order: the per-invocation `model` of the Agent call, then the front matter's `model`, then
  `CLAUDE_CODE_SUBAGENT_MODEL`, then the main model. Symphony sets none of these
  ([claude.ts:346-397](../../src/agent/claude.ts#L346-L397)), so a subagent always inherits the parent's model.
  Verified live: `laravel-code-reviewer` ran on `claude-opus-5-5` inside opus developers and on `claude-fable-5-1`
  inside the fable developer of bandenhub#11. Effort inheritance is not documented (spike E0-2).
- "Plan strong, implement cheaper" ([WORKFLOW.md:168-170](../../WORKFLOW.md#L168-L170)) cannot be expressed for
  subagents: neither a cheap explorer under an opus developer nor a strong reviewer under a sonnet developer.
- A front-matter `model` is not a hard pin; the per-invocation parameter wins. A hard pin needs a `PreToolUse` hook that
  rewrites `tool_input.model`, or `Agent(model:…)` deny rules (since 2.1.178). `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is
  global and overrides every agent file.

### Tracking and dashboard

| What | Today | Effect |
|---|---|---|
| Board | A fresh `SubagentBoard` per running entry ([orchestrator.ts:2095](../../src/orchestrator/orchestrator.ts#L2095)), closed at `Finishing` ([:2239](../../src/orchestrator/orchestrator.ts#L2239)), running runs plus the last 10 finished ([subagents.ts](../../src/orchestrator/subagents.ts)); the team API passes only `input.running?.subagents` ([team.ts:236](../../src/http/team.ts#L236)) | After the run the page says "Keine Session aktiv"; earlier subagents are visible nowhere on the issue page. Only the statistics page ranks subagents over all runs ([logs-page.ts:924-927](../../src/http/logs-page.ts#L924-L927)). |
| Empty text | `renderStageSubs` shows "Keine Subagents in dieser Session" for an active session with an empty board ([issue-page.ts:2125-2134](../../src/http/issue-page.ts#L2125-L2134)) | Correct, but it shows in every run that has not (yet) delegated |
| Tokens | Input + output + cache read + cache write over all the subagent's calls ([claude.ts:769-784](../../src/agent/claude.ts#L769-L784)) | #205 reviewer: "fertig · 529k" (528,688) against Claude Code's `total_tokens: 65819`; bandenhub#57 1,397,775 vs 92,786. Billed load, not context size. |
| Status | `ok` or `error` ([claude.ts:786-795](../../src/agent/claude.ts#L786-L795)), with a short reason in `SubagentRun.reason` and on the tile | Records `error` when the result has `is_error`, when `tool_result` text starts with "Agent terminated early due to an API error", or when the `task_notification` reports `failed` or `stopped` ([E0-5](#e0-5-subagent-status-from-the-result-text-and-the-task-status)). The tile shows "Fehler: <reason>" instead of "fertig". A late `failed`/`stopped` notification corrects an ok run and re-emits it to the timeline. |
| Context fill | `default.context_window: 200000`; opus, sonnet and fable set none ([model-costs.yml:16-38](../../model-costs.yml#L16-L38)); main thread only ([claude.ts:706-724](../../src/agent/claude.ts#L706-L724)) | Claude Code reports `contextWindow: 1000000` for `claude-opus-5-5` and `claude-sonnet-5-5` (200000 for `claude-haiku-4-5`). The #205 developer's "125.5 %" is 25.1 % (250,996 tokens); every peak above 80 % on opus, sonnet and fable (developer 5 of 42, architect 7 of 20 runs with the field) is an artefact. |
| `tool_calls` | `tool_use` events also for subagent messages ([claude.ts:664-678](../../src/agent/claude.ts#L664-L678), [orchestrator.ts:3310-3319](../../src/orchestrator/orchestrator.ts#L3310-L3319)) | #205: 100 main-thread plus 12 reviewer calls make the logged 112 (Bash 95 = 84 + 11) |
| SDK data | `task_started` / `task_progress` / `task_notification` (tokens, tool uses, duration) become a generic `notification` ([claude.ts:494-509](../../src/agent/claude.ts#L494-L509)) | `subagent_stats` in the result (spawned, refused, started in background) is delivered by Claude Code 2.1.288 but documented neither in the TypeScript reference nor in the changelog |
| Cost | `modelUsage` of the result includes the subagents ([claude.ts:831-848](../../src/agent/claude.ts#L831-L848)) | Correct: #205 developer 17,679,661 main + 528,688 subagent ≈ 18,296,438 reported |

### Live usage and value of the calls

- **All-time** (2,745 runs): `laravel-code-reviewer` 46 calls (developer 42), `laravel-architect` 22 (architect 19,
  analyst 1); the other three personas none.
- **Where delegation would pay**: the delegating developer sessions run 83–108 main-thread Bash calls and 14–24M tokens.
  In the five sampled sessions **68–87 % of the Bash output is exploration** (grep, `sed -n`, cat) and 5–16 % test runs.
  On #205, 97 main calls re-read about 180k tokens each (17.68M in total) at a real peak of 25.1 % of 1M: delegation
  would pay through cost, not through avoided overflow. The data cannot tell whether strong models follow the "good
  uses" more often or whether the L/XL issues that get opus offer more reason to review.
- **Developer → `laravel-code-reviewer`** (five sampled sessions): 3–6 % of the session's tokens and 111–349 s;
  concrete findings with file and line, adopted in 4 of 5 (on #205 a medium finding, wrong field numbers in error
  messages after a block, verified with tinker, fixed, tested and pushed). But each review started 14–49 min into the
  session, after the commits, so every finding cost an extra edit, test and commit cycle.
- **Architect → `laravel-architect`**: used as a **critique of the architect's own draft on the same model** ("Review
  tenancy design draft"), at 18–57 % of the session's tokens and up to 568 s. It finds real defects (bandenhub#72:
  `intdiv(x + 50, 100)` rounded negative amounts wrong; the fix reached the final design), but the persona does not fit
  ("You design; you do not implement … Output: a short plan",
  [laravel-architect.md](../../.claude/agents/laravel-architect.md)), and same-model judges prefer their own output.

### marktausschuss#205: the message was correct

"Keine Subagents in dieser Session" on the developer was no configuration error. On 2026-11-04 the opus developer ran
from 09:11:06Z to 09:47:57Z with 84 main-thread Bash calls and started `laravel-code-reviewer` at 09:35:45Z; until then
(24.6 min) the board showed the message. `report_result` then failed twice at the Testing entry check ("git fetch origin
failed") and the run ended `continuing`. On 2026-11-05 the issue came back through "Ready", and the developer ran an
8-minute hand-off session: five model calls, two Bash calls and `report_result` for PR #250 ("Den Code habe ich nicht
geändert"). Its prompt listed all five agents; there was simply nothing to delegate. The review of 2026-11-04 is visible
nowhere today (E0-7, E0-8). Resuming through "In progress" would have skipped the repeated analysis and design.

### SDK version and the fork trap

- Symphony pins `@anthropic-ai/claude-agent-sdk` **0.3.288**, which bundles **Claude Code 2.1.288** (`package-lock.json`).
  `package.json` allows `^0.3.288`, so a lock refresh would pull the newest 0.3.x (0.3.318 on 2026-11-05).
- From **0.3.302** forks are on by default in SDK sessions. A fork inherits the whole context and the role's tools and is
  not restricted by the `Agent(symphony:*)` denies, so an upgrade needs `Agent(fork)` in the denies or
  `CLAUDE_CODE_FORK_SUBAGENT=0`.
- Newer versions bring the Agent tool's `effort` parameter (2.1.292), `agent_id` on subagent messages (0.3.292),
  `CLAUDE_CODE_SUBAGENT_EFFORT` (2.1.316) and the fix for `SubagentStop` firing about twice a minute (2.1.311).
- Built-in Explore is no longer cheap: it runs on the main model (no longer haiku) and skips CLAUDE.md, and with it the
  Boost guidelines. A plugin agent named `Explore` is `symphony:Explore` and does not override it.

## Evidence

Vendor figures are marked **[vendor]**: self-reported, not independently replicated.

| Source | Finding | What it means here |
|---|---|---|
| [Anthropic, multi-agent research system (2025-06-13)](https://www.anthropic.com/engineering/multi-agent-research-system) | **[vendor]** +90.2 % over a single agent at about 15× the tokens of a chat; tokens alone explain 80 % of the variance. "Most coding tasks involve fewer truly parallelizable tasks than research." Briefs need objective, output format, tool guidance, task boundaries. | Fan-out pays for reading, not for writing code |
| [Claude Code best practices](https://code.claude.com/docs/en/best-practices) | Delegating the same task "doesn't make the answer any better"; a fresh reviewer helps because it has not seen the reasoning. "Use subagents to protect your context window" is listed under what you can stop doing. Fresh subagents have their own 5-minute prompt cache. | Judge a subagent by cost per issue, not by the context bar |
| [Google Research / MIT (2026-01-28)](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/) | 180 configurations: centralised multi-agent +80.9 % on parallelisable tasks, **every** variant −39 to −70 % on sequential ones; error amplification 17.2× (independent) vs 4.4× (centralised) | No concurrent writers on one column's coding work |
| [Cognition, revised position (2026-04-22)](https://cognition.com/blog/multi-agents-working) | Multi-agent works "when writes stay single-threaded and the additional agents contribute intelligence rather than actions" | One writer per column |
| [AgentCoder](https://arxiv.org/html/2312.13010v3) | Test accuracy 61.0 % → 87.8 % when a separate agent writes the tests without seeing the code (HumanEval, GPT-3.5); 56.9K tokens against 138–184K for MetaGPT and ChatDev | Strongest evidence: an information boundary for tests (old models, function-level tasks) |
| [MAST](https://arxiv.org/html/2503.13657v3) | 41–86.7 % failure rates in popular multi-agent frameworks; best single intervention a verifier of the task goal (+15.6 %) | Verification beats more agents |
| Self-preference ([Panickssery et al.](https://arxiv.org/abs/2404.13076), [Chen et al.](https://arxiv.org/abs/2504.03846v3)) | LLM judges favour their own output; on verifiable tasks the harmful bias is stronger in stronger models | Same-model self-critique has limited independence |
| [Anthropic Code Review (2026-03-09)](https://claude.com/blog/code-review) | **[vendor]** PRs with substantive comments 16 % → 54 %, under 1 % of findings marked incorrect; 84 % of PRs over 1,000 lines get findings (7.5 on average), 31 % of PRs under 50 lines (0.5) | Lens review pays on large diffs; gate it by size |
| Official plugins: [code-review](https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/code-review/commands/code-review.md), [feature-dev](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/feature-dev/commands/feature-dev.md), [claude-security](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/claude-security/agents) | code-review: haiku gate, parallel finders (sonnet conventions, opus bugs), **one validation subagent per finding**, drop what fails. feature-dev: 2–3 parallel explorers returning 5–10 key files that the parent reads. claude-security: inventory, researchers, three refutation lenses (reachability, impact, defenses) defaulting to false positive, "arithmetic done outside every model". | The patterns E2 and E3 copy |
| [OpenAI Symphony SPEC](https://github.com/openai/symphony/blob/main/SPEC.md) | One coding-agent session per issue; defines **no roles and no subagents** | The role per column is its own first decomposition level; subagents are a second one |
| [Opus 5 prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5) | Do not delegate what a handful of tool calls finishes; do not use subagents to verify your own work (over-verification) | Fits Symphony's adopted self-reviews (3–6 % cost) only when size-gated and limited to correctness against the spec (E3-1) |

## Best practices per role

| Role | Recommended pattern | Subagent(s) and model | Deliberately leave out |
|---|---|---|---|
| issue-analyst | One focused session with a fixed output schema, like Anthropic's [`triage-issue`](https://github.com/anthropics/claude-code/blob/main/.claude/commands/triage-issue.md) | at most a haiku duplicate finder | `laravel-architect` (0 of 207 runs, `max_turns: 3`) |
| architect | 2–3 parallel explorers per code area returning 5–10 key files with `file:line`; the parent reads them itself | explorer on sonnet; at L/XL a design critic on another model than the parent | same-model critique at S/M; stance architects without a real design space |
| developer | Single writer; exploration delegated; review against the spec before the first push | explorer (sonnet, haiku under sonnet parents); read-only reviewer at L/XL; a test runner only with verbatim failure excerpts | parallel writers on coupled migration, model, resource and policy; specialists without a fixed schema |
| test-engineer | Tests from the acceptance criteria without the diff, RED against the base commit, objective check with `pest --mutate --covered-only` | test designer (sonnet) with a brief without the implementation; read-only test-quality judge after `pr-test-analyzer` | `laravel-test-engineer` as a clone of the role |
| docs | The main session writes; it needs the context of the change | haiku checker for links and references (files, routes, config keys) | every writing Laravel persona |
| reviewer | Small diffs without subagents; large diffs with parallel lenses and a verifier per finding that rejects when in doubt | conventions on sonnet; bugs on opus (diff only, diff with context); verifier on opus | style, linter findings, pre-existing problems, findings outside the issue's scope |
| security-auditor | Inventory, researcher per component, panel of three refutation lenses (reachability, impact, defenses), default "false positive" | inventory on sonnet with Read/Glob/Grep; verifiers on opus; Laravel lenses: mass assignment, policies, Filament `canAccess`, raw queries, `{!! !!}` | running code; same-model critique without a refutation brief |
| planner, analyst, autopilot | One draft per independent section or item; duplicate search against open issues; the parent decides Blocked-by ([dedupe](https://github.com/anthropics/claude-code/blob/main/.claude/commands/dedupe.md)) | drafters on sonnet; feasibility checker (do the files exist?) | dependencies decided in subagents (cross-cutting decisions) |
| auditor `/refactoring` | Inventory, read-only auditor per component, verifier that rejects pre-existing style | inventory and auditors on sonnet; verifier on opus or fable | writing refactorers in the audit role |
| brain-gardener | Parallel checkers per vault folder (links, orphans, duplicate candidates); the parent proposes merges | haiku checkers | none (no Laravel subagents allowed) |

**For every role:**

1. **The brief** names goal, output format, tool hints and task boundaries, plus the issue, its acceptance criteria and
   the absolute repository path. It asks for file lists instead of contents and a return of about 1,000–2,000 tokens.
2. **The description is a routing instruction to the parent**: a trigger ("Use after …"), an exclusion ("Not for …"),
   and "use proactively" only where the agent should fire on its own.
3. **The parent treats findings as candidates**: it reads the cited lines itself, asks for evidence as command plus
   output, and discards claims without `file:line`.

## Decisions

| Decision | Why | Alternative not taken |
|---|---|---|
| Second-level subagents only for cheap reading, an information boundary or verified parallel lenses | Evidence above; personas that repeat the role were not called once in 349 + 330 + 128 runs | More personas per role |
| Size gate = the issue's `Complexity:` label `L` or `XL` | Available today in the prompt (`issue.complexity`) and to `report_result`; the benefit of review scales with size | A diff-size prompt variable (open question 8) |
| New helpers are plugin files without a prefix | The mechanism exists; how `options.agents` ranks against plugin agents is undocumented | Programmatic `options.agents` (only if E0-2 settles the ranking) |
| Model in the front matter; a hard pin through the existing `PreToolUse` hook only where needed | The per-invocation parameter wins over the front matter; Symphony already owns a hook on `Agent` | `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` (global, ignores per-agent models) |
| `tool_calls` stays the total; subagent calls get their own field | Comparability with 2,745 logged runs | Redefining `tool_calls` as main-thread only |
| Writers stay single | Cognition 2026, Google/MIT | Parallel writers in worktrees |
| Reliable patterns are enforced through the result contract (D1) | 0 of 252 sonnet developer runs used an optional subagent | Optional subagents only; Symphony-run stages |

### D1: deterministic orchestration step or optional subagent?

Patterns that must run reliably to be worth anything are the verification of every finding and the test design behind
an information boundary.

| Option | What it means | For | Against |
|---|---|---|---|
| **A. Optional subagent** | The prompt recommends the pattern above the size gate; the agent decides | No new mechanism; cheap to try and revert | Only strong models follow such hints today (0 of 252 sonnet developer runs); a skipped verification is invisible |
| **B. Contract gate** (recommended) | The result carries the evidence the pattern produces, and `report_result` refuses a gated result without it: every finding of an L/XL review or audit has a verification record (E3-4); an L/XL test result has RED at the base commit and a mutation score (E3-7). How the agent produces it stays its choice; the prompt recommends the subagent. | Follows the pipeline's own rules: transitions computed by Symphony, the test-path rule in `report_result`, entry checks that gate the move ([multi-agent.md](multi-agent.md#decisions)). Matches claude-security ("arithmetic done outside every model") and MAST. Makes confirmed and refuted findings data. | Checks the outcome, not the process: the test designer's information boundary stays soft (the brief). Evidence can be filled in carelessly, so the evaluation watches for verifications that never refute anything. |
| **C. Symphony-run step** | Symphony starts the step as its own session: a verifier session per finding, a test-design stage at the base commit before the developer | Hard boundary: the session gets only what the step may see | New roles, columns, result kinds and transitions; every extra session re-reads the code; size L and more, a concept of its own |

**Recommendation: B** for these two patterns; A stays for the soft ones (explorer, early self-review, design critic);
C becomes a follow-up concept only if the evaluation shows that B's evidence is produced without real verification. The
evidence settles the reliability argument (A fails for cheaper models). It does not settle cost against benefit at
repository level, because no controlled study on real repositories exists; the A/B evaluation measures that.
**Status: proposed.** E3-4 and E3-7 assume B. A human who prefers A says so on the concept issue before E3-4 starts;
E3-4 and E3-7 then keep the optional fields and drop the `report_result` validation.

## Target

A role gets a subagent only where it pays off in one of the three ways above. Every subagent has a model, effort and
turn limit chosen on purpose, framework-neutral helpers exist in every repository, the measurements show what really
happened (also after the run), and every change from E2 on is evaluated per role.

Each requirement `E<n>-<m>` is one mergeable change of size S or M. Tests belong to the requirement that changes the
code. Documentation goes to the reference pages ([configuration.md](../configuration.md#subagents-per-role),
[agent-claude.md](../agent-claude.md#subagents), [results.md](../results.md)), not to this page.

### E0 Measurement and visibility

Correct measurement comes first: while context fill, subagent tokens and status are wrong, no optimisation can be shown
to work, and the 200k artefacts even argue for the wrong benefit (context protection instead of cost). The two spikes
answer the mechanics questions later requirements depend on.

#### E0-1 Spike: does the `claude_code` preset suppress the Agent tool for Opus 5.5, Sonnet 5.5 and Fable 5.1?

**Change:** none in the code. Find the delegation line and its model condition in the Claude Code bundled with SDK
0.3.288 (`node_modules/@anthropic-ai/claude-agent-sdk`); then probe each model with a fixed task that names a subagent,
under `preset: claude_code`, with and without an explicit delegation sentence in `append`, and record the Agent calls.
**Why:** documented for Opus 5 only; it may be the main cause of the low delegation (open question 1).
- [ ] Per model: line present yes or no, with its source location; Agent calls with and without the sentence, with
  session ids.
- [ ] Result in [agent-claude.md](../agent-claude.md#subagents) and as a comment on the concept issue.

Depends on: none · Size: S · Category: maintenance

#### E0-2 Spike: subagent mechanics of Claude Code 2.1.288 in Symphony sessions

**Change:** none in the code. Controlled sessions answer: (1) does a subagent inherit the session's `effort`? (2) do two
Agent calls in one message run in parallel while background tasks are disabled (overlapping `task_*` times)? (3) do
denied agents disappear from the agent list the model sees? (4) what do the fields of `subagent_stats` count? (5) does an
`options.agents` entry override a plugin agent of the same name? (6) can a `PreToolUse` hook rewrite `tool_input.model`
of an Agent call with `updatedInput`? (7) is `canUseTool` called for tool calls inside a subagent, and does a
`SubagentStart` callback hook with `additionalContext` work in SDK sessions?
**Why:** these gaps block E1-3, E2-3, E2-4, E3-3 and E0-7 (open questions 2–7).
- [ ] Every question answered with transcript evidence (session id and line), documented in
  [agent-claude.md](../agent-claude.md#subagents).

Depends on: none · Size: M · Category: maintenance

#### E0-3 Context fill against the real window

**Change:** [model-costs.yml](../../model-costs.yml) gets `context_window: 1000000` for `opus`, `sonnet` (both reported
by Claude Code) and `fable` (inferred from 269k tokens without compaction on marktausschuss#202). `context_peak_percent`
in `run_finished` uses the peak tokens and the window in `result.modelUsage[<model>].contextWindow` when reported, else
the live value ([claude.ts:706-724](../../src/agent/claude.ts#L706-L724), `#onResult`); the live value during a turn
keeps coming from the file, because the result arrives only at the end of a turn.
**Why:** peaks of 98–134 % without compaction are artefacts; the "≥ 80 %" counts mislead.
- [ ] Peaks plausible: no `context_peak_percent` above 100 with `context_compacts=0`.
- [ ] Tests: 250,996 tokens on `claude-opus-5-5` give 25.1 %; a 200k model (haiku); a reported window overrides the
  file; an unknown model shows "—". [configuration.md](../configuration.md) describes the reported window.

Not included: rewriting old log lines. Depends on: none · Size: S · Category: quality

#### E0-4 Subagent measures: context, billed tokens, tool uses, duration, model

**Change:** [claude.ts](../../src/agent/claude.ts) reads `task_started` / `task_progress` / `task_notification` (matched
by `tool_use_id`) instead of reporting them as `notification`. `SubagentRun` gets `contextTokens` (Claude Code's
`usage.total_tokens`, from the final request), `toolUses`, `durationMs` and `models` (of its assistant messages);
`tokens` keeps the billed sum. The issue page tile shows both, e.g. "Kontext 66k · abgerechnet 529k", and the model;
the `subagent` event in [agent-claude.md](../agent-claude.md#events-and-accounting) is updated.
**Why:** the board figure is about 8× Claude Code's own and not comparable with the context bar; E1-3 needs the model.
- [ ] A fixture of the #205 reviewer gives context 65,819, billed 528,688, 12 tool uses, 110,436 ms, `claude-opus-5-5`.
- [ ] Runs without `task_*` messages keep working (context "—").

Depends on: none · Size: M · Category: quality

#### E0-5 Subagent status from the result text and the task status

**Change:** `#endSubagents` ([claude.ts:786-795](../../src/agent/claude.ts#L786-L795)) records `error` with a short
reason when the `tool_result` text starts with "Agent terminated early due to an API error" or the `task_notification`
reports `failed` or `stopped`.
**Why:** the #205 architect subagent killed by the weekly limit on 2026-11-02 counted as `ok`.
- [x] A fixture of that case gives `error` with the limit text as reason; a normal review stays `ok`.

Depends on: E0-4 (same code) · Size: S · Category: quality

#### E0-6 Main-thread and subagent tool calls apart

**Change:** a `tool_use` event from a message with `parent_tool_use_id` carries `detail.subagent`; `ToolUsage` counts
those calls separately; `run_finished` gets `subagent_tool_calls` (format of `tool_calls`), while `tool_calls` stays the
total; the statistics show main-thread calls as total minus subagent calls;
[configuration.md](../configuration.md#repository-logs) lists the field.
**Why:** the logs cannot show the main context's load or the delegated share, so an explorer would not show up.
- [ ] A #205 developer fixture gives `tool_calls` 112 (Bash 95) and `subagent_tool_calls` Bash 11 plus
  `SubagentHandback` 1; the statistics show 84 main-thread Bash calls.

Depends on: E0-4 (same code in `claude.ts`) · Size: M · Category: quality

#### E0-7 Persist the subagent runs of each session

**Change:** `run_finished` gets the run's subagents (type, description, status and reason, duration, context and billed
tokens, model; `<name>:<n>`-style or a JSON field, as the PR decides), and the run trace in `GET /api/v1/<identifier>`
lists them per run. `subagent_stats` from the result, when present, is kept as an extra signal marked undocumented.
**Why:** the review of #205 on 2026-11-04 is visible nowhere; the evaluation needs per-run subagent data.
- [x] After a run ends, `GET /api/v1/<identifier>` still lists its subagents (`sessions[].subagents`, `run_trace.subagents`); older lines parse as before. Decision: one JSON field `subagents` in `run_finished`.
- [x] Tests in `test/history.test.ts` and `test/orchestrator.test.ts`.

Depends on: E0-4, E0-5 · Size: M · Category: feature

#### E0-8 Issue page: subagents per stage, also after the run

**Change:** `renderStageSubs` ([issue-page.ts:2125-2134](../../src/http/issue-page.ts#L2125-L2134)) shows each finished
stage run with its persisted subagents (E0-7: type, description, status with reason, duration, both token figures,
model) and the running run's live board as today. Empty texts: "Diese Session hat (noch) keinen Subagent gestartet"
while running, "Keine Subagents in diesem Lauf" for a finished run.
**Why:** "Keine Session aktiv" hides earlier calls.
- [ ] For an issue like #205 the developer stage shows the review of an earlier run after that run ended; an `error`
  subagent shows its reason. Page tests in `test/http.test.ts`.

Depends on: E0-7 · Size: M · Category: design

#### E0-9 Subagent evaluation in the statistics

**Change:** `computeAnalytics` ([analytics.ts](../../src/history/analytics.ts)) gets a role filter and a section per
role × model (filters: repository, period, complexity): runs and runs with a subagent (delegation rate), calls per
subagent type, main-thread Bash per run (median, p90; E0-6), subagents' share of billed tokens (E0-7), cost per finished
issue, returns per issue from Agent review (`changes_needed`) and Testing (`failed`), and from E3-4 on confirmed and
refuted findings. Shown on the statistics page and in `GET /api/v1/history/analytics`, exportable as JSON.
**Why:** every change from E2 on is judged by these figures (see Evaluation).
- [x] Tests with fixture logs.

**Implemented as** `subagent_evaluation` (one row per role × primary model; filters `role`, `complexity`, repository, period).
Definitions: a *delegating run* has at least one `agent_calls` entry; *main-thread Bash* is `max(0, Bash − subagent Bash)`
per run; the *token share* is Σ persisted subagent tokens ÷ Σ billed tokens of the runs (subagents are part of the
billed total, so at most 100 %); a *finished issue* has a `stage_result` in the period with `target` In review or Done,
and the cost per finished issue sums all roles (the `own_` variant only the row's runs); *returns* are the
`review:changes_needed` and `test:failed` results on the row's issues, per issue; complexity comes from the issue's
newest `stage_result`. The row's `findings` stay `null` until `stage_result` lines carry `findings_confirmed` and
`findings_refuted` (E3-4).
- [ ] On the live logs since 2026-10-20 the section reproduces the research figures: developer 371 runs, 28 delegating,
  0 of 252 on sonnet; architect 170 with 19.

Depends on: E0-6, E0-7 · Size: M · Category: feature

### E1 Configuration clean-up

Low risk and no new mechanism: no role inherits agents by accident, no role keeps a persona that repeats it, and the
personas get models on purpose.

#### E1-1 Explicit allowlists for docs and brain-gardener

**Change:** `agents: []` for `docs` and `brain-gardener` in [WORKFLOW.md](../../WORKFLOW.md); the pins in
[workflow-prompt.test.ts:1012-1025](../../test/workflow-prompt.test.ts#L1012-L1025) change to `[]`, and a test asserts
that every shipped role has an explicit list; [configuration.md](../configuration.md#subagents-per-role) says that
"unset = all" remains for custom workflows.
**Why:** "unset = all" gives the haiku docs role with `acceptEdits` the writing Laravel personas.
- [ ] In a Laravel workspace, docs and brain-gardener sessions deny all five; no shipped role has `agents` unset.

Not included: the default role of workflows without `roles` keeps "all" (it never occurs with the shipped
`WORKFLOW.md`). Depends on: none · Size: S · Category: quality

#### E1-2 Remove the personas that repeat their role

**Change:** `agents: []` for `issue-analyst` (was `laravel-architect`), `test-engineer` (`laravel-test-engineer`),
`reviewer` and `security-auditor` (`laravel-code-reviewer`); delete the guidance lines naming them in
[issue-analyst.md](../../roles/issue-analyst.md), [test-engineer.md](../../roles/test-engineer.md),
[reviewer.md](../../roles/reviewer.md) and [security-auditor.md](../../roles/security-auditor.md), keeping the
`{% if agents.size > 0 %}` scaffold for E3; update the tests.
**Why:** 0 of 207, 349, 330 and 128 runs used them; less routing noise. E3 replaces them with real boundaries.
- [ ] The four roles render no agent intro in Laravel workspaces.
- [ ] No rise in duration or returns per role over the following period (E0-9, or the repository logs before it).

Depends on: E1-1 (same lines and pins) · Size: S · Category: quality

#### E1-3 Models and turn limits for the personas

**Change:** `model: opus` in [laravel-code-reviewer.md](../../.claude/agents/laravel-code-reviewer.md), `model: sonnet`
in `laravel-database-engineer.md` and `laravel-filament-developer.md`; `maxTurns` in all five, chosen from the observed
tool calls (reviews 10–21, architect critiques 11–54) and stated in the PR; one-line `key: value` entries only. A hard
pin through the `PreToolUse` hook only if transcripts show per-invocation overrides (after E0-2).
**Why:** subagents always inherit the parent's model: no strong reviewer under a sonnet developer, Filament work on
haiku under a haiku session.
- [ ] In a transcript (or on the E0-4 tile) `laravel-code-reviewer` under a sonnet developer runs on opus, and
  `laravel-filament-developer` under an opus developer on sonnet.
- [ ] `pluginAgents()` still marks the read-only agents correctly (toolbox test).

Depends on: none · Size: S · Category: quality

#### E1-4 Fix the documentation drift

**Change:** [laravel-subagents.md](../laravel-subagents.md): :156 `set_status("Agent review")` becomes `report_result`;
the open verification (:198-199) gets its result (no session ever tried a `laravel-*` agent outside Laravel; tests cover
the refusal); the usage figures (:43-57, 2026-10-14) are marked historical with a link to this concept. The comment at
[claude.ts:385](../../src/agent/claude.ts#L385) says the deny rules refuse the call and the agents still appear in
`init.agents`.
**Why:** the documentation contradicts the code and the observed `init.agents`.
- [ ] Docs and comment match the code; no other change.

Depends on: none · Size: S · Category: maintenance

### E2 Framework-neutral explorer, prompts and context injection

The biggest lever: cheap reading for the expensive roles in every repository, prompts that name occasions instead of
discouraging, and subagents that know the issue.

#### E2-1 A framework-neutral, read-only explorer

**Change:** new `.claude/agents/explorer.md` (no prefix, so available in every workspace): `disallowedTools: Edit,
Write, NotebookEdit`, `model: sonnet`, `effort: low` or `medium` (the PR picks and says why), `maxTurns` around 25.
Description: "Use before reading more than about ten files to find your way …; Not for a change you can finish in a
handful of tool calls". The body asks for 5–10 key files with `file:line` and a summary of at most about 300 words, no
file contents; as a custom agent it loads CLAUDE.md, unlike Explore. Listed for developer, architect, analyst, planner,
autopilot and auditor.
**Why:** 68–87 % of the Bash output in expensive developer sessions is exploration; the Symphony repository has no
helper at all.
- [ ] In a non-Laravel workspace the developer prompt and `init.agents` contain `symphony:explorer` while `laravel-*`
  stays denied; the read-only roles pass validation; toolbox and orchestrator tests.

Depends on: E1-2 (same lists and pins) · Size: S · Category: feature

#### E2-2 Prompts on occasions instead of deterrence

**Change:** `agent_intro` ([WORKFLOW.md:460](../../WORKFLOW.md#L460)) drops "optional … costs tokens" and says: delegate
where a trigger applies, never for a few tool calls; every brief contains the issue, the acceptance criteria, the
absolute workspace path, the task boundaries, the output format with `file:line`, file lists instead of contents and a
return of about 1,000–2,000 tokens; findings are candidates (read the cited lines, discard claims without `file:line`).
Each role gets a trigger and an exclusion that name the agent (developer: "Before you read more than about ten files,
ask `symphony:explorer` …"; architect: 2–3 explorers per code area, then read their files). The prompt test
([workflow-prompt.test.ts:990-1001](../../test/workflow-prompt.test.ts#L990-L1001)) covers every role with agents.
**Why:** naming the agent is the strongest soft lever; subagents do not see Symphony's context; the preset line (E0-1)
may suppress unrequested delegation.
- [ ] Delegation rate of sonnet developer runs above zero over the evaluation period (E0-9; today 0 of 252).
- [ ] Prompt tests pass.

Depends on: E2-1, E0-1 · Size: M · Category: feature

#### E2-3 The explorer's model follows the parent

**Change:** the `PreToolUse` hook on `Agent|Task` ([claude.ts:428-441](../../src/agent/claude.ts#L428-L441)) is
registered for every session and sets `tool_input.model` of a `symphony:explorer` call via `updatedInput`: `haiku` under
sonnet sessions, `sonnet` under opus and fable. If E0-2 shows that `options.agents` overrides a plugin agent, the
definition may be built in `#options()` instead; the PR states the choice.
**Why:** under a sonnet parent a sonnet explorer is not cheaper; only the hook pins the model.
- [ ] Unit test per session model; in a transcript the explorer runs on `claude-haiku-4-5` under a sonnet developer;
  denied agents are still refused.

Depends on: E2-1, E0-2 · Size: M · Category: feature

#### E2-4 Issue context for every subagent (`SubagentStart`)

**Change:** a `SubagentStart` callback hook in `#options()` returns `additionalContext` for `symphony:*` agents: issue
identifier and title, role and whether it is read-only, absolute workspace path, acceptance criteria from
`results.analysis` when present, pointers to the repository rules (CLAUDE.md / AGENTS.md, `.ai/rules/index.md` when
present) and "answer with `file:line`"; bounded in length, merged with the `PreToolUse` hook.
**Why:** Symphony's appended system prompt does not reach subagents; briefs forget the issue and the rules.
- [ ] Unit test of the hook output; sampled live subagent reports refer to the right issue and path; internal agents
  get nothing.

Depends on: E0-2 (question 7) · Size: M · Category: feature

#### E2-5 Evaluate stage 2 per role and apply the result

**Change:** compare before and after per role and model with E0-9 (delegation rate, main-thread Bash per run, cost per
finished issue, returns from Agent review and Testing, share of handed-off runs); record the table with run counts in
[agent-claude.md](../agent-claude.md#subagents); remove the explorer from `roles.<role>.agents` where it did not lower
the cost per finished issue at an equal success rate. The figures come from the E0-9 JSON export, attached by a human.
**Why:** whether an explorer makes these sessions cheaper is not measured; the evidence is from research tasks.
- [ ] Table in the docs; allowlists match the decision.

Depends on: E0-9, E2-2, E2-3 · Size: S · Category: quality

### E3 Size-gated quality patterns

Expensive patterns only where the evidence carries them: issues with the `Complexity:` label `L` or `XL`
(`issue.complexity`). S and M issues run without them. E3-4 and E3-7 implement decision D1 (option B).

#### E3-1 Early, size-gated self-review in the developer role

**Change:** [developer.md](../../roles/developer.md): at L/XL a read-only review against the acceptance criteria and the
design **before the first push**, briefed as "report only correctness gaps against the spec, skip style; give
`file:line` and the command with its output"; none at S/M. The reviewer is `laravel-code-reviewer` in Laravel
workspaces and, elsewhere, a new framework-neutral read-only `spec-reviewer` (`model: opus`, `maxTurns`) after the
official minimal reviewer ("You're reviewing code you didn't write …"), allowed for the developer.
**Why:** findings were adopted in 4 of 5 sessions but arrived 14–49 min late and cost an extra cycle; the gate
reconciles the self-review with the Opus 5 guide.
- [ ] At L/XL the review's Agent call precedes the first `git push`; S/M developer runs start no reviewer.
- [ ] The share of L/XL issues sent back by Agent review (`changes_needed`) falls (E0-9).

Depends on: E2-2 (same prompt) · Size: M · Category: feature

#### E3-2 A design critic instead of "architect calls architect"

**Change:** new read-only `.claude/agents/design-critic.md` (`model: opus`, so another model than the fable architect
at L/XL; `maxTurns`) whose output is a critique: defects with `file:line`, severity and what breaks, no new design.
`roles.architect.agents` becomes `[explorer, design-critic]` instead of `laravel-architect`;
[architect.md](../../roles/architect.md): explorers map the code, the critic runs only at L/XL, once, on the draft
before `report_result`.
**Why:** same-model critique costs 18–57 % of the architect's tokens and carries self-preference bias; the persona
("you design … return a short plan") does not fit the use.
- [ ] The critic's share is under 20 % of the architect session's billed tokens, and critiques still change the final
  design about as often as in the sampled sessions (transcripts like bandenhub#72).
- [ ] An opus architect (S/M) never starts the critic.

Depends on: E2-2 (same prompt and list) · Size: M · Category: feature

#### E3-3 Lens review with a verifier per finding in the reviewer role

**Change:** new read-only personas `convention-lens` (sonnet; CLAUDE.md / AGENTS.md / `.ai/rules` violations where the
rule can be quoted), `bug-lens` (opus; called once on the diff alone and once with context) and `finding-verifier`
(opus; one candidate per call, tries to refute it, rejects when in doubt, cites `file:line`).
[reviewer.md](../../roles/reviewer.md): at L/XL the lenses run in one message, then one verifier per candidate; only
confirmed, diff-introduced findings within the issue's scope enter the result; style, linter findings and pre-existing
problems are excluded. No subagents at S/M.
**Why:** the benefit scales with PR size (31 % vs 84 % of PRs with findings); the column already gives independence,
so lenses plus verification are what adds value.
- [ ] At L/XL the transcript shows the lenses and one verifier per reported finding; S/M reviews start none.
- [ ] Confirmed findings per large PR rise without more findings later found wrong by the developer (E0-9, E3-4).

Depends on: E1-2, E0-2 (question 2) · Size: M · Category: feature

#### E3-4 Verified findings in the result contract

**Change:** `findings[]` of `review` and `security` results ([results.ts](../../src/workflow/results.ts),
[results.md](../results.md#kinds)) get `verification {status: confirmed|refuted, evidence}`. `report_result` refuses a
review or security result on an L/XL issue whose findings lack a confirmed verification (`invalid_result` with a
message); refuted candidates may go into `refuted[]` and count for the metrics. S/M results are unchanged.
**Why:** decision D1 (B); reliable verification needs a check outside the model and becomes measurable.
- [ ] `report_result` tests for L/XL with and without verification and for S/M; E0-9 shows confirmed and refuted
  counts; the issue comment shows confirmed findings only.

Depends on: E3-3 · Size: M · Category: feature

#### E3-5 Security: inventory and refutation panel

**Change:** new personas `security-inventory` (sonnet, `tools: Read, Glob, Grep`, no shell; splits the change into
components) and `refutation-judge` (opus; one candidate and one lens per call: reachability, impact or defenses;
default "false positive"; `file:line` for every claim). [security-auditor.md](../../roles/security-auditor.md): at L/XL
inventory, the auditor's own research per component, then three judges per candidate; in Laravel workspaces the brief
adds mass assignment, policies and gates, Filament `canAccess` / `authorize*`, raw queries and `{!! !!}`. The votes go
into `verification` (E3-4), and `report_result` applies the panel rule (open question 9). No code is run.
**Why:** the claude-security pattern; same-model critique without a refutation brief adds little.
- [ ] At L/XL every reported security finding carries three votes, and the panel rule is computed in `report_result`.
- [ ] S/M audits are unchanged.

Depends on: E3-4, E0-2 · Size: M · Category: feature

#### E3-6 A test designer behind an information boundary

**Change:** new `.claude/agents/test-designer.md` (sonnet, `maxTurns`) whose brief contains only the acceptance criteria
and the public interface (routes, signatures from `results.design.interfaces`), never the diff or the changed files; it
writes the tests and shows them RED at the base commit and GREEN on the branch. `roles.test-engineer.agents:
[test-designer]`; [test-engineer.md](../../roles/test-engineer.md): at L/XL one call per group of acceptance criteria.
The existing test-path rule in `report_result` limits its writes to `pipeline.test_paths`.
**Why:** independent tests are the strongest research evidence (61.0 → 87.8 %); the test engineer works after the
developer, so only the brief keeps the implementation out.
- [ ] At L/XL the Agent prompt in the transcript contains no implementation paths or diff; RED and GREEN commands with
  output are in the result; S/M test sessions are unchanged.

Not included: an enforced read boundary (open question 11). Depends on: E1-2 · Size: M · Category: feature

#### E3-7 RED-at-base and mutation evidence in the test result

**Change:** `cases[]` of the `test` result gets `red_at_base` (with the command); in Laravel workspaces the result
carries `mutation_score` from `pest --mutate --covered-only` over the changed classes (needs Xdebug 3+ or PCOV; the PR
checks the image). `report_result` refuses an L/XL test result without `red_at_base` for the new cases, and without a
mutation score where Pest mutation testing is available; [results.md](../results.md#kinds) is updated.
**Why:** decision D1 (B): the outcome of the information boundary becomes checkable although the boundary is soft.
- [ ] `report_result` tests; E0-9 shows the mutation score per issue; new tests at L/XL score higher than in the
  comparison period.

Not included: TypeScript mutation testing (open question 10). Depends on: E3-6 · Size: M · Category: feature

### E4 Hardening and SDK upgrade

Enforcement inside subagents gets tested, unneeded agents go away, and the upgrade happens on purpose, with forks denied
first.

#### E4-1 Enforcement inside subagents: tests and documentation

**Change:** unit tests that the `PreToolUse` hook refuses a denied Agent call whose input carries `agent_id` (from
inside a subagent), that `canUseTool` treats subagent requests (with `agentID`) like main-thread ones, and that read-only
sessions keep `READ_ONLY_DENY`; a live check in `scripts/e2e` or a documented manual session (a read-only role's
read-only subagent told to edit a file is refused);
[agent-claude.md](../agent-claude.md#permission-and-safety-posture) states what read-only covers and what it does not
(shell writes).
**Why:** enforcement inside subagents is neither tested nor observed.
- [ ] Tests pass; the live check is recorded with its session id; the docs list the boundary.

Not included: blocking shell writes (open question 5). Depends on: none · Size: M · Category: quality

#### E4-2 Cap subagent nesting at one level

**Change:** `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` in the session defaults next to `BACKGROUND_TASKS_OFF`
([claude.ts:54](../../src/agent/claude.ts#L54)), overridable through `claude.env`; documented.
**Why:** three levels are allowed by default since 2.1.219; no planned pattern nests, and the lens fan-out must not
multiply. The SDK docs advise setting limits, not only instructions.
- [ ] Session options test; in a transcript a subagent has no Agent tool.

Not included: `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default 20 stays); `maxBudgetUsd` already counts subagent spend.
Depends on: none · Size: S · Category: quality

#### E4-3 Switch off the built-in agents

**Change:** `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` in the session defaults. An Agent call without `subagent_type`
then fails with "subagent_type is required", so the prompts always name the type (E2-2); `subagentOf` keeps
`general-purpose` for old logs.
**Why:** `general-purpose` gives read-only roles an agent with every tool; Explore and Plan run on the parent model and
skip CLAUDE.md; the built-ins compete for routing and were not used after 2026-10-11.
- [ ] `init.agents` of a new session contains no built-in agent (denied plugin agents still appear, as documented);
  session options test.

Depends on: E2-1, E2-2 · Size: S · Category: quality

#### E4-4 Deny forks before any upgrade

**Change:** `Agent(fork)` in every session's `disallowedTools` ([claude.ts:356-358](../../src/agent/claude.ts#L356-L358))
plus `CLAUDE_CODE_FORK_SUBAGENT=0` in the defaults; documented in [agent-claude.md](../agent-claude.md#subagents).
**Why:** from SDK 0.3.302 forks are on by default and bypass the allowlist; `package.json` allows `^0.3.288`, so any
lock refresh would turn them on. At 0.3.288 the rule is harmless.
- [ ] Every session's options contain the rule and the variable (test).

Depends on: none · Size: S · Category: quality

#### E4-5 Upgrade the Agent SDK

**Change:** bump `@anthropic-ai/claude-agent-sdk` to the current 0.3.x and pin it exactly in `package.json`, so the next
upgrade is deliberate too; check the behaviour changes with the full suite and one live session per role kind: a
subagent's own Agent calls run in the foreground (2.1.302), the parent no longer keeps subagent tool results (2.1.314),
a subagent on another model uses that model's effort (2.1.317), the `SubagentStop` fix (2.1.311). `manual-merge`
recommended.
**Why:** it brings `agent_id`, the Agent `effort` parameter and `CLAUDE_CODE_SUBAGENT_EFFORT`.
- [ ] `npm run check` passes; `session_configured` reports the new Claude Code version; a fork attempt is refused in a
  live session; the subagent tracking tests are unchanged.

Depends on: E4-4, E4-1 · Size: M · Category: maintenance

#### E4-6 Use the new SDK fields

**Change:** subagent attribution in `claude.ts` (E0-4, E0-6) uses `agent_id` on subagent messages and the `task_id` of
the task events where present, with `parent_tool_use_id` as the fallback; nested runs are attributed to their own
subagent. If E0-2 found that subagents inherit the session's effort, the personas' effort is set through their front
matter or `CLAUDE_CODE_SUBAGENT_EFFORT`, as the PR decides.
**Why:** direct correlation instead of the tool-use-id heuristic.
- [ ] Fixtures with `agent_id` give the same figures as E0-4 and E0-6; older fixtures still parse.

Depends on: E4-5, E0-6 · Size: S · Category: maintenance

## Order

- **No blockers:** E0-1, E0-2, E0-3, E0-4, E1-1, E1-3, E1-4, E4-1, E4-2, E4-4. E0-1 first: its answer shapes E2-2.
- **Measurement:** E0-4 → E0-5, E0-6 → E0-7 → E0-8; E0-6 + E0-7 → E0-9.
- **Stage 1 and 2:** E1-1 → E1-2 → E2-1 → E2-2 (also E0-1); E2-1 + E0-2 → E2-3; E0-2 → E2-4; E0-9 + E2-2 + E2-3 → E2-5.
- **Stage 3:** E2-2 → E3-1, E3-2; E1-2 + E0-2 → E3-3 → E3-4 → E3-5; E1-2 → E3-6 → E3-7.
- **Hardening:** E2-1 + E2-2 → E4-3; E4-4 + E4-1 → E4-5 → E4-6 (also E0-6).

## Evaluation

| Metric (per role × model, stratified by complexity; from E0-9) | Source | Expected direction |
|---|---|---|
| Cost per finished issue (USD, all stages) | `run_finished` costs, stage history | lower (E2); not higher at equal quality (E3) |
| Main-thread Bash calls per run (median, p90) | `tool_calls` − `subagent_tool_calls` (E0-6) | lower for developer and architect (E2) |
| Delegation rate | `agent_calls` | above zero for sonnet roles with an explorer (E2-2) |
| Subagents' share of billed tokens | persisted subagent runs (E0-7) | design critic under 20 % (E3-2) |
| Returns from Agent review (`changes_needed`) and Testing (`failed`) per issue | stage results | lower at L/XL (E3-1, E3-6) |
| Confirmed vs refuted findings per L/XL review and audit | `verification` (E3-4) | more confirmed, not more refuted |
| Mutation score of new tests | `mutation_score` (E3-7) | higher than the comparison period |
| Share of handed-off runs, duration | `run_finished` | unchanged |

The context fill is a sanity check after E0-3, not a target: an explorer is judged by cost per issue, not by the
context bar.

**Method.** From stage 2 on every change is an A/B per role. The switch is the role's `agents` list plus its prompt
line, so a change can be turned off without code. The default comparison is before and after over comparable periods on
the same repositories, with run counts per arm, compared within one model and complexity: the data cannot separate
"strong models follow the hints" from "large issues get strong models", so pooled figures would mislead. Stage 3
patterns are compared on L/XL issues only. A pattern that raises the cost per finished issue without fewer returns or
more confirmed findings is removed again (E2-5 does this for stage 2).

## Non-goals

- **Parallel writing subagents on coupled files** in the developer or docs role (migration, model, resource and policy
  share implicit decisions). Writers stay single.
- **Mandatory delegation for small issues**: at S/M a fresh subagent's start-up cost (own prompt cache, re-reading)
  buys nothing.
- **Agent teams** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`): about 7× the tokens of a standard session per the docs.
- **Forks as a delegation mechanism**: they inherit the whole context and bypass the allowlists (E4-4 denies them).
- **Symphony-run verification or test-design stages** (D1 option C): new roles and columns need a concept of their own.
- **Subagents to protect the context window**: real peaks are around 25 % of 1M.
- **A global model force** (`CLAUDE_CODE_SUBAGENT_MODEL_FORCE`), and changing "unset = all" for workflows without
  `roles`.
- **Writing refactorers in the auditor role**, and stance architects without a real design space.

## Not in this concept

These patterns from the best-practices table get no requirement yet; each waits for the E2-5 evaluation and becomes a
concept addendum if the explorer and the stage-3 gates pay off: a haiku duplicate finder for the issue analyst; a haiku
link and reference checker for docs; haiku checkers per vault folder for the brain gardener; per-section drafters and a
feasibility checker for planner, analyst and autopilot; inventory, per-component auditors and a verifier for the
auditor; a test runner with verbatim failure excerpts for the developer; preloading Boost skills per persona through
`skills:`.

## Open questions and spikes

Each question has a default assumption that the requirements build on until it is answered.

1. **Does the preset line that suppresses the Agent tool apply to Opus 5.5** (and Sonnet 5.5, Fable 5.1)? It is
   documented for Opus 5 only and may be the main cause of the low delegation. **Spike E0-1.** Assumption: it applies;
   E2-2 names the agents explicitly either way.
2. **Do subagents inherit the session's effort?** **Spike E0-2.** Assumption: yes; personas that need another effort set
   it in the front matter.
3. **How do `options.agents` rank against plugin agents of the same name?** The docs place them only above "filesystem"
   agents. **Spike E0-2.** Assumption: unknown, so new helpers are plugin files.
4. **Do foreground subagents run in parallel while background tasks are disabled?** **Spike E0-2.** Assumption:
   possibly not; lenses and explorers still work sequentially, with higher latency. E3-3 waits for the answer.
5. **Bash writes in read-only roles and read-only subagents.** Options: (a) document and keep, (b) deny patterns for
   common write commands (incomplete by nature), (c) a sandbox or read-only mount. **Decision for a human.**
   Assumption: (a), documented in E4-1.
6. **Can `subagent_stats` be relied on?** Claude Code 2.1.288 delivers it, but it is undocumented. **Spike E0-2.**
   Assumption: extra signal only (E0-7), never the only source.
7. **Further mechanics for E0-2**: do denied agents disappear from the model's agent list; is `canUseTool` called inside
   subagents; does the `SubagentStart` callback hook work in SDK sessions? Assumption: the agents stay listed (the deny
   happens at call time); the other two work, as the SDK typing suggests.
8. **Size gate**: complexity L/XL or the diff size? Code Review's figures are about lines changed, but the prompt has
   no diff-size variable. Assumption: complexity L/XL only; a diff-size variable would be its own requirement.
9. **Panel rule for security findings** (E3-5): how many of the three lenses must fail to refute a finding?
   claude-security computes it outside the model; the threshold was not part of the research. Assumption: a finding is
   kept only when no lens refutes it.
10. **Mutation testing environment**: do the workspace and check image have Xdebug 3+ or PCOV for `pest --mutate`, and
    what about TypeScript repositories (StrykerJS not verified)? Assumption: Pest only; no mutation score is required
    where it is unavailable.
11. **An enforced read boundary for the test designer**: a session `PreToolUse` hook branching on `agent_type` could
    deny Read of the changed implementation files (plugin agents ignore their own `hooks`); Bash would still read them.
    Assumption: not built; RED-at-base evidence (E3-7) checks the outcome instead.
12. **A/B method**: before/after periods or per-issue assignment (e.g. a label that empties `agents` for that issue),
    and how many runs per arm are enough? Assumption: before/after, stratified by model and complexity; a human decides
    when the run counts suffice.
