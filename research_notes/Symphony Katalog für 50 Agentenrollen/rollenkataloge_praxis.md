# Specialised agent roles in practice: multi-agent dev systems and public subagent collections (state: November 2026)

Researcher note on provenance. Each finding is tagged:
- **[fetched]** = page read in this session (2026-11-12).
- **[search]** = taken from a search-result summary only, page itself not opened; treat as secondary.
- **[background]** = from the researcher's prior knowledge of the primary paper, URL given but NOT re-fetched in this session (the session hit a fetch limit). Verify before quoting numbers.

---

## 1. Which roles do established multi-agent dev frameworks and products define?

### Takeaway
Academic frameworks (MetaGPT, ChatDev, MAGIS, HyperAgent, AgentCoder) mirror a human org chart (PM, architect, engineer, QA); shipping products from 2025-2026 (Claude Code plugins, Anthropic Code Review, Factory, GitHub agentic workflows) instead define roles by *task, tool set and output artefact* (explorer, architect-blueprint, lens reviewer, verifier, CI doctor). The second style is the one with published operating numbers.

### Cited Findings

**Claude Code built-in subagents** [fetched]
- Built-ins: `Explore` (read-only, Write/Edit denied; file discovery/code search with thoroughness quick/medium/very thorough), `Plan` (read-only research during plan mode), `general-purpose` (all tools; multi-step work needing exploration and changes), `claude` (catch-all, default for background sessions), `statusline-setup`, `claude-code-guide`. Explore and Plan start without CLAUDE.md and git status. — [Claude Code docs: sub-agents](https://code.claude.com/docs/en/sub-agents)
- Docs' own example custom subagents: `code-reviewer` (Read/Grep/Glob/Bash, sonnet, "use proactively after code changes"), `debugger`, `code-improver` (Read/Grep/Glob), `db-reader` (Bash only, read-only SQL enforced by a PreToolUse hook that exits 2 on INSERT/UPDATE/DROP). — [Claude Code docs: sub-agents](https://code.claude.com/docs/en/sub-agents)

**Anthropic `feature-dev` plugin (7-phase workflow)** [fetched]
- Phases: Discovery → Codebase Exploration → Clarifying Questions → Architecture Design → Implementation (only after explicit approval) → Quality Review → Summary. — [feature-dev README](https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/feature-dev/README.md)
- `code-explorer`: traces execution paths (entry points, call chains, data flow, layers, dependencies); 2-3 launched in parallel in phase 2; output = entry points with file:line, step-by-step flow, key components, list of essential files to read. — same source
- `code-architect`: designs implementation blueprint; 2-3 launched with different focuses (minimal change / clean architecture / pragmatic balance); output = patterns and conventions found, architecture decision with rationale, component design, file-level implementation map, build sequence. — same source
- `code-reviewer`: 3 launched in parallel with distinct lenses (simplicity/DRY/elegance; bugs/correctness; conventions/abstractions); output = critical/important issues with file:line and fix; confidence-filtered (README states both "≥80 only" and Critical 75-100 / Important 50-74 — internally inconsistent). — same source

**Anthropic `pr-review-toolkit` plugin (6 narrow review agents)** [fetched]
- `comment-analyzer` (comment accuracy vs code, comment rot), `pr-test-analyzer` (behavioural test coverage, gaps rated 1-10), `silent-failure-hunter` (silent catch blocks, inappropriate fallbacks, missing logging), `type-design-analyzer` (rates encapsulation, invariant expression, usefulness, enforcement each 1-10), `code-reviewer` (CLAUDE.md compliance, bugs; issues scored 0-100, 91-100 critical), `code-simplifier` (reduce complexity/nesting/redundancy, behaviour-preserving; runs after review passes). Shared output: issue, file:line, why it matters, suggested fix, severity priority. — [pr-review-toolkit README](https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/pr-review-toolkit/README.md)

**Anthropic `code-review` plugin (lens + scorer pattern)** [fetched]
- 4 parallel agents: #1 and #2 independent CLAUDE.md-compliance audits (deliberate redundancy), #3 bug detection on changed code only, #4 git blame/history analysis for context-based issues. Each issue then gets its own scorer agent (0/25/50/75/100); only ≥80 kept. For CLAUDE.md issues the scorer verifies the guideline explicitly covers the flagged problem. — [code-review README](https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/code-review/README.md)
- Explicit false-positive filter: drop pre-existing issues, things that look like bugs but are not, pedantic nitpicks, anything a linter would catch, general quality concerns not covered by CLAUDE.md, lint-ignored code. Skips closed/draft/trivial/already-reviewed PRs; posts nothing if no issue reaches threshold. — same source

**Anthropic Code Review (managed product, 2026-03-09)** [fetched]
- On PR open a team of agents looks for bugs in parallel; a verification step filters false positives; bugs ranked by severity; output = one overview comment plus inline comments. — [claude.com/blog/code-review](https://claude.com/blog/code-review)
- Anthropic-internal numbers: PRs with substantive review comments rose 16% → 54%; PRs >1,000 changed lines: 84% get findings, avg 7.5 issues; PRs <50 lines: 31% get findings, avg 0.5; <1% of findings marked incorrect by engineers; ~$15-25 per review; ~20 min average. — [claude.com/blog/code-review](https://claude.com/blog/code-review)

**Factory droids** [search]
- Named droids: Code Droid (ticket from Jira/Linear → PR), Knowledge Droid (research and documentation, searches codebase/docs/web, writes specs), Reliability Droid (triages production alerts, root-cause analysis, documents resolution), Product Droid (ticket/backlog management, prioritisation and assignment). Custom droids = Markdown files with own system prompt, model and tool set, invoked via Task tool. — [Anthropic customer story: Factory](https://www.anthropic.com/customers/factory); [Factory GA post](https://factory.ai/news/ga); [practitioner guide](https://sidbharath.com/blog/factory-ai-guide/)
- "Review", "QA", "Security" droids appear in a third-party wiki but it is unclear whether these are official product names. — [agentwiki.org/factory](https://agentwiki.org/factory)

**GitHub Next "agentics" sample agentic workflows (gh-aw)** [fetched] — the richest public catalogue of *repo-operations* roles; see section 4 for the full list. — [githubnext/agentics](https://github.com/githubnext/agentics)

**GitHub awesome-copilot custom agents** [fetched, page truncated after ~56 agents]
- Pipeline-relevant agents visible: Create PRD (user stories, acceptance criteria, can create GitHub issues after confirmation), Context Architect (plans multi-file changes), API Architect, Debug Mode, Critical Thinking (challenges assumptions), Agent Governance Reviewer, AI Team Producer / Dev / QA (plan-scope, implement, test-and-file-bugs trio), Accessibility Expert (WCAG) and Accessibility Runtime Tester (browser-based), C#/.NET Janitor (tech-debt cleanup), ADR Generator, Context7 Expert (current library docs). — [awesome-copilot README.agents.md](https://github.com/github/awesome-copilot/blob/main/docs/README.agents.md)

**Cursor Bugbot** [search — secondary sources only]
- PR bug-finding reviewer with team rules in `.cursor/BUGBOT.md`; Bugbot Autofix spawns a cloud agent to propose repairs. Cursor publishes "resolution rate" rather than precision/recall; third-party pages cite 70%+ of flagged issues resolved before merge and >35% of Autofix changes merged (unverified here). — [Cursor guide: AI code review](https://cursor.com/guides/ai-code-review); [Augment analysis](https://www.augmentcode.com/guides/cursor-bugbot-code-review-capabilities-limits)
- Review→fix hand-off pattern: review-tool comment can be dispatched to a coding agent (Claude, Codex, Cursor, Devin); Greptile has "Fix in Devin". — [State of AI code review, May 2026](https://dev.to/lewiska/state-of-ai-code-review-may-2026-roundup-5o7)

**Academic frameworks** [background — older, 2023-2024; URLs not re-fetched]
- MetaGPT (2023): Product Manager (PRD), Architect (system design, interfaces), Project Manager (task breakdown), Engineer (code), QA Engineer (tests); roles communicate via structured documents (SOPs) rather than free chat. — [arXiv 2308.00352](https://arxiv.org/abs/2308.00352)
- ChatDev (2023): CEO, CPO, CTO, Programmer, Reviewer, Tester (+ Art Designer) in a "chat chain" of design → coding → testing → documenting phases. — [arXiv 2307.07924](https://arxiv.org/abs/2307.07924)
- AgentCoder (2023): Programmer, Test Designer (writes tests independently of the code), Test Executor. — [arXiv 2312.13010](https://arxiv.org/abs/2312.13010)
- MAGIS (2024, GitHub-issue resolution): Manager, Repository Custodian (locates relevant files), Developer, QA Engineer (reviews each change). — [arXiv 2403.17927](https://arxiv.org/abs/2403.17927)
- HyperAgent (2024): Planner, Navigator (code search), Code Editor, Executor (runs tests/repro). — [arXiv 2409.16299](https://arxiv.org/abs/2409.16299)
- Survey of LLM multi-agent systems for SE (roles across requirement, design, code, QA, maintenance). — [arXiv 2404.04834](https://arxiv.org/html/2404.04834v4)

### Inferences
- Roles that recur across *independent* product designs and therefore look robust: **explorer/navigator/repository custodian** (read-only locate), **architect/planner producing a file-level blueprint**, **implementer**, **independent test designer**, **lens reviewers in parallel**, **per-finding verifier/scorer**, **executor/test runner**.
- The "manager" layer of academic frameworks (CEO, CPO, project manager) has no equivalent in 2025-2026 products; there it is replaced by a deterministic workflow or an orchestrating main agent.
- The target orchestrator's existing agents (visible in this session's agent list: explorer, design-critic, test-designer, bug-lens, convention-lens, finding-verifier, security-inventory, refutation-judge, laravel-architect/-code-reviewer/-database-engineer/-filament-developer/-test-engineer) already follow the product style, not the persona style.

### Gaps
- Devin, OpenHands, SWE-agent variants, Codex cloud agents, GitHub Copilot coding agent internals: no primary source opened in this session (fetch limit). Not known to publish fixed named role sets beyond a single generalist agent plus optional review; treat as unverified.
- CrewAI and AutoGen example dev teams: not researched in this session.
- Factory droid descriptions are from secondary summaries; the current (2026) Factory docs were not opened.
- awesome-copilot list was truncated; TDD red/green/refactor, security, Playwright, Laravel/PHP agents may exist there but were not confirmed.

---

## 2. Which roles appear in large public Claude Code subagent collections, and which recur?

### Takeaway
The two largest collections (VoltAgent, ~170 agents, 26.5k stars; wshobson/agents, 202 agents, 42.5k stars) are organised by job-title categories; about a dozen role names recur verbatim across them (code-reviewer, architect-reviewer, security-auditor, debugger, error-detective, test-automator, performance-engineer, database-optimizer, api-documenter, legacy-modernizer, dx-optimizer, php-pro/typescript-pro), while newer entries shift towards narrow, output-defined roles (docs-drift-editor, surgeon-reviewer, conductor-validator).

### Cited Findings

**VoltAgent/awesome-claude-code-subagents** [fetched] — 26.5k stars; header says "161+", tally ~170 in 10 categories. — [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents)
- Categories and counts: 01 Core Development (13), 02 Language Specialists (30), 03 Infrastructure (16), 04 Quality & Security (19), 05 Data & AI (13), 06 Developer Experience (16), 07 Specialized Domains (17), 08 Business & Product (19), 09 Meta & Orchestration (16), 10 Research & Analysis (11). — same source
- Pipeline-relevant roles, Core Development: api-designer, auth-integration-engineer, backend-developer, frontend-developer, fullstack-developer, design-bridge (designs → agent-ready specs), webhook-engineer, websocket-engineer. — same source
- Quality & Security: accessibility-tester, architect-reviewer, chaos-engineer, code-reviewer, compliance-auditor, debugger, error-detective, penetration-tester, performance-engineer, qa-expert, security-auditor, test-automator, ui-ux-tester (documented-flow UI testing), gdpr-ccpa-compliance, `surgeon-reviewer` (low-noise review with severity tiers and ship/no-ship verdict), `ponder-auditor` (multi-pass codebase/UI/security review with a coverage gate). — same source
- Developer Experience: build-engineer, dependency-manager, `docs-drift-editor` (fixes documentation drift in isolated worktrees), documentation-engineer, git-workflow-manager, legacy-modernizer, readme-generator, refactoring-specialist, tooling-engineer, dx-optimizer, mcp-developer, cli-developer. — same source
- Other pipeline-adjacent: api-documenter, database-administrator, database-optimizer, postgres-pro, sql-pro, deployment-engineer, devops-engineer, incident-responder, backlog-grooming, business-analyst (requirements), technical-writer, license-engineer. — same source
- Meta & Orchestration: agent-organizer, codebase-orchestrator (safe refactor governance), context-manager, error-coordinator, knowledge-synthesizer, memory-curator, multi-agent-coordinator, task-distributor, workflow-orchestrator, performance-monitor (agent performance). — same source
- Stack-relevant language specialists: `typescript-pro`, `javascript-pro`, `node-specialist`, `php-pro`, `laravel-specialist` (Laravel 10+), `symfony-specialist`. — same source

**wshobson/agents** [fetched] — 42.5k stars; 94 plugins, 202 agents, 185 skills, 105 commands. — [wshobson/agents](https://github.com/wshobson/agents)
- Review & security: code-reviewer (opus), architect-reviewer (opus), security-auditor (opus), backend-security-coder, frontend-security-coder, mobile-security-coder, `threat-modeling-expert` (opus). — [wshobson docs/agents.md](https://raw.githubusercontent.com/wshobson/agents/main/docs/agents.md)
- Testing & debugging: test-automator, `tdd-orchestrator`, debugger, error-detective, ui-visual-validator, incident-responder, devops-troubleshooter. — same source
- Documentation: docs-architect, api-documenter, reference-builder (haiku), tutorial-engineer, mermaid-expert, C4 diagram agents (c4-code, c4-component, c4-container, c4-context). — same source
- Database: database-architect, database-optimizer, database-admin, sql-pro. Other: performance-engineer, observability-engineer, legacy-modernizer, monorepo-architect, dx-optimizer, deployment-engineer, `conductor-validator`, context-manager. — same source
- Stack-relevant: `php-pro`, `typescript-pro`, `javascript-pro` (all sonnet). No Laravel-specific agent listed. — same source
- Model tiering per agent (haiku for reference-builder/context-manager/search; sonnet for language pros, test-automator, debugger; opus for reviewers, architects, security). — same source
- The repository's own README states its LLM-judge and Monte-Carlo evaluation layers are experimental, not validated against human labels, and that scores do not prove a task will succeed in a project. — [wshobson/agents](https://github.com/wshobson/agents)

### Inferences
- Role names that occur in both collections (and in the dev.to practitioner shortlist, section 6): code-reviewer, architect-reviewer, security-auditor, debugger, error-detective, test-automator, performance-engineer, database-optimizer, api-documenter, incident-responder, legacy-modernizer, dx-optimizer, context-manager. These are the "consensus labels", but mostly without distinct inputs/outputs.
- Category schemes are near-identical (core dev / language / infra / quality-security / data-AI / DX / domains / business / orchestration), i.e. organised by human job families, not by pipeline stage. A pipeline-stage taxonomy (intake → spec → design → implement → test → review → security → docs → release → maintenance) is not used by either large collection.
- 30 of ~170 VoltAgent agents are language/framework specialists — the category practitioners most often report as inert (section 6).

### Gaps
- Other often-cited collections (0xfurai, lst97, contains-studio, davepoon) were not opened; cross-collection recurrence is based on two collections plus one practitioner list.
- wshobson's agents.md listed only ~110 of the 202 agents in the fetched text; the remainder is unknown.
- No download/usage statistics per agent exist in either repository, so "popular" cannot be distinguished from "listed".

---

## 3. Which narrow lens / verifier roles exist for review and security?

### Takeaway
The best-documented pattern is "several narrow lenses in parallel + an independent verifier/scorer per finding + explicit drop rules"; Anthropic uses it in both the open plugin and the managed Code Review product and reports <1% of findings marked incorrect.

### Cited Findings

| Lens / verifier role | Responsibility | Trigger | Output | Source |
|---|---|---|---|---|
| Bug finder (diff-only) | obvious bugs in changed lines only | PR / `/code-review` | candidate issues | [code-review README](https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/code-review/README.md) [fetched] |
| Convention / guideline checker (run twice, redundantly) | violations of CLAUDE.md, only where a rule explicitly covers it | PR | candidate issues with rule reference | same [fetched] |
| History / blame analyst | uses git blame and history for context-dependent problems | PR | candidate issues | same [fetched] |
| Finding scorer / verifier (one per issue) | independently scores 0-100; ≥80 survives | per candidate | keep/drop | same [fetched] |
| Verification step in managed product | checks candidate bugs to filter false positives, then severity ranking | PR open | overview + inline comments | [claude.com/blog/code-review](https://claude.com/blog/code-review) [fetched] |
| Test-gap finder (`pr-test-analyzer`) | behavioural vs line coverage, critical missing tests | PR creation / new functionality | gaps rated 1-10 | [pr-review-toolkit README](https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/pr-review-toolkit/README.md) [fetched] |
| Silent-failure hunter | swallowed exceptions, inappropriate fallbacks, missing logging | error-handling changes | severity-flagged issues | same [fetched] |
| Comment-accuracy analyser | comments that contradict or will rot against the code | docs/comment changes | flagged comments | same [fetched] |
| Type-design analyser | invariants and encapsulation of new types | new types / data models | four 1-10 ratings | same [fetched] |
| Code simplifier | behaviour-preserving simplification after review passes | post-review | suggested simplifications | same [fetched] |
| Simplicity / correctness / conventions reviewer trio | three reviewers with one lens each | feature-dev phase 6 | issues with file:line | [feature-dev README](https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/feature-dev/README.md) [fetched] |
| Architect reviewer | change vs architectural principles | structural changes | review | [VoltAgent](https://github.com/VoltAgent/awesome-claude-code-subagents), [wshobson agents.md](https://raw.githubusercontent.com/wshobson/agents/main/docs/agents.md) [fetched] |
| Low-noise "surgeon" reviewer | severity tiers + ship/no-ship verdict | PR | verdict | [VoltAgent](https://github.com/VoltAgent/awesome-claude-code-subagents) [fetched] |
| Threat modeller | threat modelling | design stage | threat model | [wshobson agents.md](https://raw.githubusercontent.com/wshobson/agents/main/docs/agents.md) [fetched] |
| Security auditor / penetration tester / compliance auditor / GDPR-CCPA | vulnerability and compliance review | audit | findings | [VoltAgent](https://github.com/VoltAgent/awesome-claude-code-subagents) [fetched] |
| Malicious-code / supply-chain scanner | scans recent changes for suspicious patterns | daily | findings | [githubnext/agentics](https://github.com/githubnext/agentics) [fetched] |
| VEX generator | OpenVEX statements for dismissed Dependabot alerts | alert dismissal | VEX file | same [fetched] |
| Accessibility reviewer (static) / runtime tester (Playwright/browser) | WCAG guidance; runs and uses the app | daily or on demand | report | [githubnext/agentics](https://github.com/githubnext/agentics), [awesome-copilot](https://github.com/github/awesome-copilot/blob/main/docs/README.agents.md) [fetched] |
| Performance engineer / database optimizer | profiling, query performance | on demand | measured optimisations | [VoltAgent](https://github.com/VoltAgent/awesome-claude-code-subagents), [wshobson agents.md](https://raw.githubusercontent.com/wshobson/agents/main/docs/agents.md) [fetched] |
| Contribution-guidelines checker / nitpick reviewer / "grumpy" reviewer | guideline compliance; style nitpicks; opinionated persona review | PR or on demand | review / prioritised report | [githubnext/agentics](https://github.com/githubnext/agentics) [fetched] |
| Dependency manager / licence engineer | packages, licensing | on demand | — | [VoltAgent](https://github.com/VoltAgent/awesome-claude-code-subagents) [fetched] |
| Read-only DB query agent with hook-enforced guard | only SELECTs, enforced by PreToolUse hook | on demand | query results | [Claude Code docs](https://code.claude.com/docs/en/sub-agents) [fetched] |

- Drop rules that define what a lens must NOT report: pre-existing issues, linter-catchable issues, nitpicks, general quality concerns without a written rule, lint-ignored code. — [code-review README](https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/code-review/README.md) [fetched]

### Inferences
- A lens is distinguishable from a persona when it has (a) a restricted input (diff only / diff + history / written rules), (b) an exclusion list, (c) a scored, file:line-anchored output. All Anthropic review agents meet these; most collection "reviewer" entries do not state them.
- No public source found that defines a dedicated **migration-safety reviewer**, **N+1 query reviewer**, or **secret scanner** as an LLM agent role; these appear only as parts of broader "database" or "security" agents. They would be original role designs for the catalogue (secret scanning is conventionally a deterministic tool, not an agent).

### Gaps
- Anthropic's `claude-code-security-review` action (vulnerability categories, false-positive filter, prompt-injection caveat) could not be fetched (rate limit); not cited.
- Cursor "Security Agents" are mentioned in Cursor's guide but no details were found. — [Cursor guide](https://cursor.com/guides/ai-code-review) [search]
- No published precision/recall for any individual lens (only whole-pipeline figures).

---

## 4. Which maintenance and repo-operations roles exist?

### Takeaway
GitHub Next's "agentics" catalogue is the most complete public set of repo-operations roles (triage, CI doctor, PR fix, docs updater, test improver, duplicate-code detector, issue arborist, sub-issue closer); most are scheduled or event-triggered and produce an issue, comment or PR — but the catalogue publishes no effectiveness data.

### Cited Findings
All from [githubnext/agentics](https://github.com/githubnext/agentics) [fetched]; triggers marked (inferred) are not stated on the page.

- **Issue intake**: Issue Triage (labels issues and PRs); Repo Assist (triages, investigates, comments, fixes bugs, maintains activity summary); AI Moderator (spam / link-spam / AI-generated content detection); Hive Issue Triage (report-only, admission + classification steps, manual dispatch).
- **Issue structure**: Plan Command (`/plan` comment → breaks issue into sub-tasks); Issue Arborist (links related issues as parent/child sub-issues); Sub-Issue Closer (closes parent when all sub-issues done); Issue Monster (every 30 min assigns labelled issues to the coding agent); Discussion Task Miner (extracts tasks from Discussions into issues); Archie (`/archie` → Mermaid diagram of issue/PR relationships).
- **CI / fault analysis**: CI Doctor (monitors CI, investigates failures); PR Fix (analyses failing checks on a PR and implements fixes); CI Coach (optimises CI for speed/cost); Cost Tracker (per-run agent spend summary from token-usage.jsonl on PRs); Log Watcher (scans agent run logs for errors, retry loops, rate limits, token anomalies → health report).
- **Docs maintenance**: Documentation Update on push to main; Daily Documentation Updater (from recent changes and merged PRs); Glossary Maintainer; Link Checker (finds and fixes broken links); Documentation Unbloat (reduces verbosity); Markdown Linter (prioritised issue report); Agentic Wiki Writer; Multi-Device Docs Tester.
- **Code-health (PR-producing)**: Code Simplifier (recently modified code); Duplicate Code Detector; Daily Test Improver (tests for under-tested areas); Daily Perf Improver (benchmark and optimise); Repository Quality Improver (rotating daily dimension: code, docs, testing, security).
- **Code-health (report-only)**: Large File Simplifier (largest file → issue with refactoring plan); Daily Adhoc QA; Daily Accessibility Review.
- **Status/planning**: Daily Repo Status, Weekly Issue Activity (trends + recommendations), Daily Plan (updates planning issues), Weekly Repository Map.
- **Meta**: Q – Workflow Optimizer (analyses and optimises the agentic workflows themselves).
- **Security ops**: Daily Malicious Code Scan; VEX Generator.

Other collections:
- `dependency-manager`, `docs-drift-editor` (drift fix in isolated worktree), `legacy-modernizer`, `refactoring-specialist`, `git-workflow-manager`, `backlog-grooming`, `readme-generator`. — [VoltAgent](https://github.com/VoltAgent/awesome-claude-code-subagents) [fetched]
- `.NET Janitor` (tech-debt cleanup), `ADR Generator`. — [awesome-copilot](https://github.com/github/awesome-copilot/blob/main/docs/README.agents.md) [fetched]
- Factory Reliability Droid: production alert triage → root cause → documented resolution. — [sidbharath.com guide](https://sidbharath.com/blog/factory-ai-guide/) [search]
- `incident-responder`, `devops-troubleshooter`, `error-detective`. — [wshobson agents.md](https://raw.githubusercontent.com/wshobson/agents/main/docs/agents.md) [fetched]

### Inferences
- The catalogue shows a clean split usable for role design: **report-only** roles (issue/comment output) vs **PR-producing** roles; and **event-triggered** (push, failed CI, slash command) vs **scheduled** (daily/weekly).
- Agent-ops roles (Cost Tracker, Log Watcher, Workflow Optimizer) are a distinct cluster relevant to an orchestrator that already collects its own run errors.

### Gaps
- No dedicated public role found for: **dependency updater** as LLM agent (agentics has no dependency category; Dependabot/Renovate fill this deterministically), **flaky-test hunter**, **dead-code remover**, **changelog / release-notes writer**, **issue deduplicator** (named as such). These may exist elsewhere; not found in the sources opened.
- No outcome data (merge rate of generated PRs, triage accuracy) is published for any agentics workflow.

---

## 5. Which Laravel/PHP-specific and TypeScript-specific specialist roles are described?

### Takeaway
Laravel-specific collections exist but are small (4-10 agents) and split by *framework package* (Filament, Livewire, Pest, Flux, Reverb) or by concern (architecture, Eloquent/database, testing, security); TypeScript appears almost only as a generic "typescript-pro" persona.

### Cited Findings
- Laravel Altitude (Laravel News, 2026-01-07): default agents `architect` (multi-file features, architecture decisions), `database` (schema design, migrations, Eloquent models), `docs` (documentation lookup via MCP tools), `security` (audits, vulnerability checks); package-specific agents installed only if the package is used: livewire/livewire, livewire/flux, filament/filament, pestphp/pest, laravel/reverb; commands `/ship`, `/debug`, `/test`. — [laravel-news.com/laravel-altitude](https://laravel-news.com/laravel-altitude) [fetched]
- iserter/laravel-claude-agents: ~10 subagents plus skills covering architecture, Eloquent, APIs, testing (a Pest-focused `laravel-testing-expert`), security, performance, debugging; listings disagree on skill count (5 vs 15). — [packagist: iserter/laravel-claude-agents](https://packagist.org/packages/iserter/laravel-claude-agents) [search]
- ux-nl/agents: detects installed packages from composer.lock and matches registered "drivers" (Filament v4, Pest, …). — [github.com/ux-nl/agents](https://github.com/ux-nl/agents) [search]
- jeffallan/claude-skills `laravel-specialist` is a skill, not a subagent (Eloquent, Sanctum/Passport, queues, Horizon, Livewire, Inertia, Octane, Pest/PHPUnit). — [openskillindex listing](https://openskillindex.com/skills/jeffallan-claude-skills-laravel-specialist-d7637a) [search]
- hadyfayed/laravel-agent: Livewire 3 / Filament / Pest skills and slash commands such as a Filament resource generator. — [laravel-agent mirror](https://gh.hhj520.top/hadyfayed/laravel-agent) [search]
- php[architect], July 2026: "Claude Code Subagents: Delegate Like a Senior PHP Developer" (practitioner article; content not opened). — [phparch.com](https://www.phparch.com/2026/07/claude-code-subagents-delegate-like-a-senior-php-developer/) [search]
- General collections: `laravel-specialist`, `php-pro`, `symfony-specialist`, `typescript-pro`, `javascript-pro`, `node-specialist` (VoltAgent); `php-pro`, `typescript-pro`, `javascript-pro` (wshobson, no Laravel agent). — [VoltAgent](https://github.com/VoltAgent/awesome-claude-code-subagents); [wshobson agents.md](https://raw.githubusercontent.com/wshobson/agents/main/docs/agents.md) [fetched]
- TypeScript-adjacent narrow role: `type-design-analyzer` (invariants/encapsulation of new types). — [pr-review-toolkit README](https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/pr-review-toolkit/README.md) [fetched]

### Inferences
- The Laravel ecosystem's own convention is *package-conditional* agents (install/activate an agent only if composer.lock contains the package). That maps directly onto a rule "role is eligible only if repo stack matches".
- Much Laravel-specific knowledge is being shipped as **skills/guidelines** (e.g. laravel-specialist skill) rather than as subagents — a hint that framework knowledge is often better attached to a generic implementer than cast as a separate role.
- No public Laravel role found for: migration-safety review, Filament authorisation/policy review, Livewire state/security review, queue/job idempotency review, N+1 detection. These are gaps a catalogue could fill with original, stack-specific lenses.

### Gaps
- iserter README could not be fetched (rate limit): exact agent names unverified.
- Laravel Boost (official Laravel AI guidelines/MCP) was not researched in this session.
- No TypeScript/Node-specific role collections beyond generic "pro" personas were found; none with evidence.

---

## 6. Evidence of benefit vs. persona labels; what practitioners say

### Takeaway
Hard evidence exists only for a handful of role *patterns* — parallel lens review with verification (Anthropic numbers), independent test design (AgentCoder), structured hand-off documents (MetaGPT), exploration isolation — while the large persona collections publish no outcome data, and practitioner reports consistently say job-title and language-specialist agents sit unused; the value of a subagent is context isolation, tool restriction and a defined output.

### Cited Findings

**Evidence (vendor / paper)**
- Lens + verification review: 16% → 54% of PRs with substantive comments; <1% of findings marked incorrect; 84% of >1,000-line PRs get findings (avg 7.5) vs 31% of <50-line PRs (avg 0.5); cost $15-25 and ~20 min per review. Vendor-reported, internal use, no independent replication. — [claude.com/blog/code-review](https://claude.com/blog/code-review) [fetched]
- ChatDev ablation: removing the roles from agents' system prompts degraded results; the authors conclude role assignment matters. (2023, older; small-scale software generation, GPT-3.5 era.) — [arXiv 2307.07924 v5](https://arxiv.org/html/2307.07924v5) [search snippet from the paper]
- MetaGPT role ablation (secondary summary, verify against paper): Engineer alone 1.0 executability / 10 revisions → 4.0 executability / 2.5 revisions with PM/architect/project-manager roles added, over two tasks. (2023, older.) — [research note on MetaGPT](https://github.com/jjakimoto/research-issues/issues/1495) [search]; primary: [arXiv 2308.00352](https://arxiv.org/abs/2308.00352) [background]
- AgentCoder: separating Programmer and Test Designer (tests written without seeing the code) outperformed a single agent doing both. (2023, older; function-level benchmarks.) — [arXiv 2312.13010](https://arxiv.org/abs/2312.13010) [background; ablation claim seen only in secondary summary]
- "Why Do Multi-Agent LLM Systems Fail?" (MAST; v1 March 2025, v3 Oct 2025): 14 failure modes in 3 categories — system design issues, inter-agent misalignment, task verification; 1,600+ annotated traces across 7 multi-agent frameworks; kappa 0.88. — [arXiv 2503.13657](https://arxiv.org/abs/2503.13657) [fetched abstract]
- wshobson/agents itself states its evaluation scores are experimental and do not prove task success. — [wshobson/agents](https://github.com/wshobson/agents) [fetched]

**Practitioner opinion**
- "I built 100 Claude Code subagents; these are the 12 that earn their context" (dev.to, July, year not shown — presumably 2026): kept code-reviewer (read-only), debugger, test-runner (returns only failures; "purest context firewall"), security-auditor (opus), architect-reviewer, built-in Explore, performance-engineer (measurement-grounded), data-scientist, db-reader (hook-enforced read-only), docs-writer (haiku, cost lever), incident-responder, orchestrator/context-manager. — [dev.to article](https://dev.to/suraj_khaitan_f893c243958/i-built-100-claude-code-subagents-these-are-the-12-that-actually-earn-their-context-10nn) [fetched]
- Same author's scoring axes (1-5 each): trigger precision, context economy, tool hygiene, model fit, real weekly fit; ~80% of tested agents cut. — same source
- Same author's failure list: persona-driven agents "sat inert"; most language specialists rarely triggered or added value because the main model already handles the language; overlapping descriptions made the router pick wrong or none; verbose reports flooded the context they were meant to protect; long "expert" prompts burn tokens ("persona tax"); reviewers holding write access. — same source
- Hacker News commenters: better results from agents with "a specific task to do" than from job-like role descriptions; scepticism that persona agents change more than tone; subagents lose context in hand-offs and are poor for implementing features in complex codebases. — [HN 45181577](https://news.ycombinator.com/item?id=45181577); [HN 45231193](https://news.ycombinator.com/item?id=45231193) [search]
- Blog claim that a test of 162 personas over ~2,500 prompts showed no measurable gain over no persona (secondhand; original study not verified in this session). — [mindstudio.ai blog](https://www.mindstudio.ai/blog/claude-code-prompting-mistakes-personas) [search]
- Official guidance: keep each subagent focused on one job; define one when the same kind of worker is spawned repeatedly; write precise descriptions (router uses them); restrict tools deliberately (read-only reviewer = Read/Grep/Glob); route high-volume simple work to cheaper models; keep iterative work in the main conversation; combined descriptions >15,000 tokens trigger a warning. — [Claude Code docs: sub-agents](https://code.claude.com/docs/en/sub-agents) [fetched]

**Evidence grading per role cluster** (researcher's synthesis of the above; grades are inference)

| Role cluster | Evidence level | Basis |
|---|---|---|
| Parallel review lenses (bug, convention, history) + per-finding verifier | Strong (vendor numbers, shipped product) | claude.com/blog/code-review; code-review plugin |
| Read-only explorer / navigator / repository custodian | Good (built into Claude Code; recurs in MAGIS, HyperAgent, feature-dev) | docs; papers [background] |
| Architect producing file-level blueprint, multiple competing drafts | Moderate (shipped workflow, no numbers) | feature-dev |
| Independent test designer | Moderate (paper ablation, older, small tasks) | AgentCoder [background] |
| Test runner / executor returning only failures | Moderate (practitioner; HyperAgent Executor) | dev.to; [background] |
| Test-gap, silent-failure, comment, type-design lenses | Shipped by vendor, no separate numbers | pr-review-toolkit |
| CI doctor / PR fix / issue triage / docs updater | Shipped samples, no outcome data | agentics |
| Security auditor / threat modeller | Listed everywhere; no numbers found in this session | collections |
| PM / CEO / project-manager roles | Weak for 2026 (2023 ablations on toy tasks only) | MetaGPT, ChatDev |
| Language/framework "pro" personas, "senior X developer" | Negative practitioner evidence; no positive data | dev.to; HN |

### Inferences
- A defensible test for "real role vs persona label": does the role have (1) a trigger that the orchestrator can evaluate, (2) a restricted tool set, (3) a restricted input, (4) a typed output artefact, (5) a stated exclusion ("not for…")? By that test most of the ~170/202 collection entries are persona labels, while the Anthropic plugin agents and agentics workflows are real roles.
- The 2023 ablations showing "roles help" tested role *text in the prompt* on weak models and toy tasks; they do not show that a PM/CEO layer helps a 2026 frontier model on repository-level issues. They do support the narrower claim that separating author from tester/reviewer helps.
- For a 40-50 role catalogue, evidence supports many *narrow* reviewer/verifier/maintenance roles and few implementer personas; stack knowledge (Laravel, Filament, Pest, TypeScript) is better justified as package-conditional specialisation with distinct inputs (e.g. migrations, policies, Livewire components) than as generic "laravel-specialist".
- Overlapping descriptions are a documented failure cause; 40-50 roles therefore need mutually exclusive trigger descriptions or deterministic (non-router) dispatch by pipeline stage.

### Gaps
- No independent (non-vendor) benchmark was found that compares a multi-role pipeline against a single strong agent on real repository issues in 2025-2026; SWE-bench-style results per role were not located in this session.
- The MAST per-failure-mode percentages and the list of the 7 frameworks were not on the abstract page; not cited.
- The "162 personas" study behind the mindstudio blog was not traced to its primary source.
- Anthropic's engineering posts on multi-agent systems and Cognition's "Don't build multi-agents" position were not opened in this session (fetch limit) and are therefore not cited, although relevant to the persona-vs-task debate.
- The Cursor Bugbot figures (70%+ resolution, >35% Autofix merged, ~90 s review) come from third-party pages and one conflicts on platform support (GitHub-only vs GitLab/Bitbucket); verify at cursor.com before use.
