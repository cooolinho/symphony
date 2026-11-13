# Engpässe, Fehlermuster und Qualitätsverluste der Symphony-Pipeline (Betriebsdaten)

State: 2026-11-12, code `origin/develop` @ 37200a4 (working tree at e064ff9; 18 commits in between). Scope: development pipeline only (Ready → Design → In progress → Testing → Documentation → Agent review → Security review → In review). All sources are files of the repository `/home/cooolinho/projects/symphony`; paths are relative to its root. Tracked files were read from `origin/develop` (`git show origin/develop:<path>`), untracked ones (`errors-report.md`, `reports/`, `research_notes/`) from the working tree. Nothing was read from the container or GitHub.

Reading aid for the source labels:
- `ERR` = `errors-report.md` (untracked, 24-hour window 2026-11-08T08:06Z – 2026-11-09T08:06Z)
- `INT` = `research_notes/Subagents pro Rolle in Symphony/symphony_internal.md` (analysis of 2026-11-05, live logs since 2026-10-20)
- `REP` = `reports/Subagents pro Rolle in Symphony.md` (report of 2026-11-05)
- `SUB` = `docs/concepts/subagents.md` @ origin/develop
- `WF` = `WORKFLOW.md` @ origin/develop

Important caveat on data age: `INT`/`REP` describe the system **before** v1.4.0 (released 2026-11-06, commit b221932). v1.4.0 introduced explorer, design-critic, lens review, test-designer, security panel and removed the role-clone personas. `ERR` is the only data set **after** v1.4.0, and it covers only 24 hours. No after-measurement of v1.4.0 exists in the repository yet (see question 4).

---

## 1. Which error classes occur in agent runs, how often, and what causes them?

### Takeaway
In the one measured 24-hour window (178 transcripts, 108 errors, 35 unique signatures) 63 % of all errors fall into four real problems, and three of them are tooling or environment gaps, not model reasoning errors: an entry check that rejects hand-offs (30), the 2-minute Bash timeout (28), missing access to the PR description and CI logs (9) and a stuck lock file after a full disk (1 run, 3 issues). The remaining 37 % (40 errors, 27 signatures) are harmless exploration noise. All four were filed and fixed on `origin/develop` within a day; CI log access is still open as a draft issue.

### Cited Findings

**Totals**
- Window 2026-11-08T08:06:44Z – 2026-11-09T08:06:44Z, all repositories: 178 transcripts scanned, 108 errors, 35 unique signatures, 4 report sections, 27 signatures ignored — [errors-report.md:3-4](errors-report.md).
- The report undercounts: the container disk was at 99 % (137G of 145G) and ran full at 2026-11-09T06:16Z (`ENOSPC`); from then on Symphony could not write transcripts (#258, #267, #277 "transcript disabled") or history lines — [errors-report.md:7-10](errors-report.md).
- Overview table (count / issues / roles): ERR-001 1 run (3 issues stuck) / test-engineer; ERR-002 30 / 12 issues / developer, test-engineer, reviewer; ERR-003 28 / 19 issues / developer, test-engineer; ERR-004 9 / 9 issues / reviewer, analyst — [errors-report.md:14-19](errors-report.md).
- Own arithmetic from that table: 30 + 28 + 9 + 1 = 68 errors in sections (63 %), 40 errors in the "Ignored" table (37 %); 8 + 27 = 35 signatures. Shares: ERR-002 27.8 %, ERR-003 25.9 %, ERR-004 8.3 %, ERR-001 0.9 % — computed from [errors-report.md:14-19](errors-report.md) and [errors-report.md:391-419](errors-report.md).

**ERR-002: entry check rejects `report_result` (class "repo", 30)**
- 16 failed entry checks plus 14 rejected `report_result` calls in 12 issues of `cooolinho/trainingsstunden-portal`, roles developer (sonnet), test-engineer (sonnet), reviewer (opus) — [errors-report.md:113-114](errors-report.md).
- Cost per rejection: "every rejection costs a full suite run in the check (3–5 min) plus at least one more turn" — [errors-report.md:116-117](errors-report.md).
- Three distinct causes — [errors-report.md:121-125](errors-report.md):
  - a flaky test (`SendStaleApprovalRemindersCommandTest`) failed in 3 unrelated issues (#256, #274, #279);
  - the base branch itself was red (`YarnLockfileTest`, #259, #260; fixed on develop by `e1b8323`);
  - "tests affected by the change itself (agent missed them)" in 6 issues (#251, #262, #267, #273, #274, #275).
- Suite runtime in the check: `php artisan test` 2m 59s to 5m 18s, about 1,850 tests in one process because the project lacks `brianium/paratest` although `SYMPHONY_TEST_PARALLEL` is set — [errors-report.md:152-155](errors-report.md), [errors-report.md:163](errors-report.md), [errors-report.md:175-176](errors-report.md).
- Agent behaviour: the test engineer in #279 ran the flaky test three more times alone to check the instability — [errors-report.md:161-162](errors-report.md).
- Flaky cause is only "vermutet" (suspected): ordering assumption with frozen time — [errors-report.md:169-174](errors-report.md).

**ERR-003: Bash 2-minute default timeout (class "symphony", 28)**
- 28 timeouts in 19 issues, developer and test-engineer, all on Sonnet — [errors-report.md:208-209](errors-report.md), [errors-report.md:250-252](errors-report.md).
- Effect chain: the agent "reruns smaller parts (single test files) or skips the full run and calls `report_result`; the entry check then finds the failures the agent could not see (see ERR-002). Every timeout costs 2 minutes and a turn." — [errors-report.md:211-213](errors-report.md).
- Cause confirmed: no `BASH_DEFAULT_TIMEOUT_MS` in the session env, background tasks disabled, "Sonnet never sets the `timeout` parameter on its own"; entry-check durations for trainingsstunden-portal are 260–350 s — [errors-report.md:242-246](errors-report.md), [errors-report.md:264-269](errors-report.md).
- A minority are hanging Playwright screenshot scripts (#275, #279) that a larger timeout does not fix — [errors-report.md:257-258](errors-report.md).
- Fixed: "Bugfix: Bash-Timeout 10 min (max 20) für vollen Testlauf (#564) (#567)", commit bf18b22 (touches `src/agent/claude.ts`, `roles/developer.md`, `roles/test-engineer.md`).

**ERR-004: reviewers cannot read the PR description or CI logs (class "symphony", 9)**
- 9 occurrences in 9 issues, reviewer (opus) and analyst (fable): `gh pr view` (not installed) in 6 reviews, `gh issue view` by the analyst for sibling issues, unauthenticated `curl` → 404 for a red CI job, and once `git credential fill` + `curl`, denied by the auto-mode classifier as "Credential Exploration" — [errors-report.md:303-308](errors-report.md), [errors-report.md:341-346](errors-report.md).
- Quality effect: "The review runs without the PR description, which holds the screenshots and the developer's notes." — [errors-report.md:336-337](errors-report.md).
- Cause confirmed: prompt/tool mismatch. `roles/reviewer.md:48` promised "description and discussion", `get_issue` returned neither — [errors-report.md:352-357](errors-report.md).
- Fixed: "Bugfix: get_issue liefert PR-Beschreibung und -Diskussion; neues get_issue_by_number (#565) (#568)", commit 5bd0a48. The CI log excerpt was deliberately left out — [reports/symphony-issue-ci-log-tail.md:9](reports/symphony-issue-ci-log-tail.md).

**ERR-001: empty lock file after ENOSPC (class "symphony", 1 run, 3 issues)**
- A 0-byte lock file is read as "held by another instance" forever; #258, #268, #269 never ran again until a human deleted the files — [errors-report.md:52-56](errors-report.md), [errors-report.md:60-65](errors-report.md). Fixed by commit d7d96b2 (#563/#566).

**Ignored noise (40 errors, 27 signatures)** — [errors-report.md:391-419](errors-report.md)
- Model tool-name glitches (`bash`, `bash_placeholder`): 7, Sonnet.
- Exploration chains ending in a missing path or an exit-1-by-design git command: about 20 (e.g. `git status; … ls` 3, `git fetch && … merge-base` 2, `grep` on a missing file 2).
- Harness denials: auto-mode classifier without explanation 3, built-in removal check 1.
- `report_result` summary over 4,000 characters (issue-analyst) 2; run stopped because a human moved the issue 2; interrupted `report_result` 1.

**Further error cases documented outside the 24-hour report**
- CI red, log unreadable (tsv-server#10, 2026-11-11): test round 1 guessed SC2034, the developer disabled it file-wide ("Das war nicht die Ursache"); round 2 tried `gh run view` (not found), `curl …/annotations` (404) and a shellcheck download (blocked by the classifier, "Code from External"), named three wrong suspects, hit the round limit → Blocked, `needs-human`. The real cause stood in the last 15 lines of the job log; after a human comment with those two lines "lief die Pipeline in vier Minuten durch" — [reports/symphony-issue-ci-log-tail.md:15-18](reports/symphony-issue-ci-log-tail.md). The image lacks `shellcheck` and `bats`, so "reproduce locally" is impossible for shell repositories — [reports/symphony-issue-ci-log-tail.md:26](reports/symphony-issue-ci-log-tail.md).
- Docs stage blocked by a foreign flaky test (trainingsstunden-portal#283, 2026-11-09): the docs role had finished and pushed, the Agent-review entry check failed on a random-dependent test from another issue (`fake()->unique()->word()` gave "qui", a substring of "quibusdam"); docs may only change `docs_paths`, so it reported `blocked`, `needs: human` — [reports/symphony-issue-docs-on-check-failed.md:9-11](reports/symphony-issue-docs-on-check-failed.md), [reports/trainingsstunden-portal-283-comment.md:3-11](reports/trainingsstunden-portal-283-comment.md). Fixed structurally by commit 0b03334 (#569/#570, `docs.on_check_failed: In progress`, [WORKFLOW.md:257](WORKFLOW.md)).
- Entry check failing on infrastructure: marktausschuss#205, `report_result` failed twice at the Testing entry check ("git fetch origin failed"), outcome `continuing` — [INT:134](research_notes/Subagents%20pro%20Rolle%20in%20Symphony/symphony_internal.md).
- Subagent killed by the weekly limit and recorded as `ok` (marktausschuss#205 architect, 2026-11-02) — [INT:96](research_notes/Subagents%20pro%20Rolle%20in%20Symphony/symphony_internal.md); status detection fixed in E0-5 — [SUB:147](docs/concepts/subagents.md).

### Inferences
- (Inference) Three of the four real error classes are **missing capabilities or limits of the harness** (timeout, missing tool data, lock handling). They were fixed by configuration, a tool extension and code, not by a new role. A role catalogue should not claim these as justification.
- (Inference) ERR-002 is the one class with a role-shaped core: it mixes (a) flaky tests, (b) a red base branch and (c) genuine misses of the developer. For (a) and (b) every agent in the chain currently pays 3–5 minutes plus a turn and cannot fix the cause inside its issue. A **failure triage** step that classifies a red check as "caused by this diff / red on base / flaky" before any agent starts guessing would address both ERR-002 and the tsv-server#10 pattern. The classification "red on base" is deterministic (run the failing test on the base commit); "flaky" is semi-deterministic (rerun only the failed tests); only the diagnosis of an unclear failure needs a model.
- (Inference) The flaky tests themselves were produced by the pipeline (the #283 test "stammt aus E4-1a (#319)", [reports/symphony-issue-docs-on-check-failed.md:9](reports/symphony-issue-docs-on-check-failed.md)). That is a **test-quality** loss the test-engineer stage did not catch: substring assertions on Faker values, ordering assumptions. This is a concrete, evidenced occasion for a test-robustness lens (or a checklist item/lesson) in the Testing stage.
- (Inference) "Agent missed tests affected by the change" (6 of 12 issues) was partly caused by ERR-003: agents could not finish a full run in 2 minutes. After bf18b22 this share should drop; whether a residue remains is unmeasured.
- (Inference) The noise share (37 %) is cheap per event but shows Sonnet-specific friction (tool-name typos, guessing `gh`). It argues for prompt lines ("`gh` is not installed") rather than roles; the fix 5bd0a48 added exactly that.

### Gaps
- Only one 24-hour window exists in the repository; no trend, no weekly rate. The window is dominated by one repository (`trainingsstunden-portal`) and one flaky test.
- Errors after 2026-11-09T06:16Z are missing (disk full).
- No re-run of the collector after the fixes (each issue asks for one "after deploying"); whether the signatures disappeared is not recorded in the repository.
- The errors report counts tool-level errors only. It does not count wrong but accepted results (e.g. a review that approved a defect).

---

## 2. What do reports and concept docs say about delegation and loops (delegation share, review bounces, Blocked, failed entry checks, round limits, continuations, session-limit pauses)?

### Takeaway
Delegation is well measured for the period before v1.4.0: 48 of 1,686 runs (2.8 %) started a subagent, never a Sonnet developer (0 of 252). Loops are well **bounded** (round limits 3/2/2, 3 check failures, 6 continuations, 3 session-limit retries) but poorly **quantified**: the repository holds no figure for review bounces per issue, Blocked issues or continuation pauses, only the instruments to compute them and a handful of documented single cases.

### Cited Findings

**Delegation (before v1.4.0, since 2026-10-20)**
- "Since 2026-10-20 only **48 of 1,686 runs (2.8 %)** started any subagent: 28 developer, 19 architect and one analyst run, all in Laravel workspaces. **No sonnet developer run delegated** (0 of 252)" — [SUB:20-21](docs/concepts/subagents.md); table per role (developer 371 runs / 28, test-engineer 349 / 0, reviewer 330 / 0, issue-analyst 207 / 0, architect 170 / 19, security-auditor 128 / 0, docs 124 / 0, analyst 6 / 1) — [INT:113-125](research_notes/Subagents%20pro%20Rolle%20in%20Symphony/symphony_internal.md).
- All 28 delegating developer runs were opus (20) or fable (8) — [INT:127](research_notes/Subagents%20pro%20Rolle%20in%20Symphony/symphony_internal.md).
- All-time (2,745 runs): `laravel-database-engineer`, `laravel-filament-developer`, `laravel-test-engineer` 0 calls — [INT:128](research_notes/Subagents%20pro%20Rolle%20in%20Symphony/symphony_internal.md).
- The role-clone personas were never used: 0 of 207 (issue-analyst → architect), 349 (test-engineer → laravel-test-engineer), 330 and 128 (reviewer / security-auditor → laravel-code-reviewer) — [SUB:427](docs/concepts/subagents.md).
- Value where used: developer self-review cost 3–6 % of session tokens and 111–349 s, findings adopted in 4 of 5 sampled sessions, but it started 14–49 min into the session, after commits — [INT:153-161](research_notes/Subagents%20pro%20Rolle%20in%20Symphony/symphony_internal.md), [INT:180](research_notes/Subagents%20pro%20Rolle%20in%20Symphony/symphony_internal.md).
- Architect self-critique on the same model cost 18–57 % of session tokens, up to 568 s, and found real defects (bandenhub#72 rounding of negative amounts) — [INT:166-174](research_notes/Subagents%20pro%20Rolle%20in%20Symphony/symphony_internal.md).
- Design conclusion drawn from this: "Reliable patterns are enforced through the result contract (D1) | 0 of 252 sonnet developer runs used an optional subagent" — [SUB:246](docs/concepts/subagents.md); and "Only strong models follow such hints today … a skipped verification is invisible" — [SUB:255](docs/concepts/subagents.md).
- The report's central thesis: "Die Spaltenpipeline ist bereits das Multi-Agent-System"; second-level subagents pay only for (1) cheaper reading under expensive models, (2) an information boundary the columns do not draw, (3) parallel lenses with verification on large diffs. "Personas, die nur die Rolle wiederholen, leisten nichts davon." — [REP:59](reports/Subagents%20pro%20Rolle%20in%20Symphony.md).

**Token and time sinks (before v1.4.0)**
- Developer runs with ≥ 50 Bash calls: 53 of 371; Bash per developer run median 17, p90 62, max 127 — [INT:192](research_notes/Subagents%20pro%20Rolle%20in%20Symphony/symphony_internal.md).
- In five sampled Bash-heavy opus developer sessions 68–87 % of the Bash result text was exploration (grep, `sed -n`, cat), tests only 5–16 % — table at [INT:196-202](research_notes/Subagents%20pro%20Rolle%20in%20Symphony/symphony_internal.md) (the report text says 59–87 %, [REP:35](reports/Subagents%20pro%20Rolle%20in%20Symphony.md); the concept says 68–87 %, [SUB:158](docs/concepts/subagents.md); the table rows give 68, 68, 73, 84, 87 %).
- marktausschuss#205 developer: 97 main model calls re-read about 180k tokens each, 17.68M tokens in total, at a real context peak of 25.1 % of the 1M window — [INT:204](research_notes/Subagents%20pro%20Rolle%20in%20Symphony/symphony_internal.md).
- Fable architects ran 50–54 Bash calls per session — [INT:193](research_notes/Subagents%20pro%20Rolle%20in%20Symphony/symphony_internal.md).
- Developers edit through Bash scripts: 17–24 edit scripts (`fs.writeFileSync`, `perl -pi`, `sed -i`) per sampled session — [REP:27](reports/Subagents%20pro%20Rolle%20in%20Symphony.md).

**Loop limits (configuration, origin/develop)**
- `max_review_rounds: 3`, `max_test_rounds: 2`, `max_security_rounds: 2`, `max_check_failures: 3`; reaching a limit → `on_round_limit` or Blocked with `needs-human` — [WORKFLOW.md:356-364](WORKFLOW.md); explained in [docs/usage.md:250-257](docs/usage.md).
- `max_continuations: 6` (role switches count; a stage that handed off with a result resets the count), `max_session_limit_retries: 3`, `max_turns: 10`, `max_concurrent_agents: 3`, Agent review limited to 2 parallel sessions because "an approval runs the In review checks (up to 50 min) in its session" — [WORKFLOW.md:116-127](WORKFLOW.md).
- Merge gate: `max_send_backs: 2` for failing PR checks, then `needs-human`; pending checks wait up to 3,600,000 ms — [WORKFLOW.md:28-34](WORKFLOW.md).
- Entry checks: `timeout_ms` default 1,800,000 (30 min), CI check 1,200,000, prod-smoke 1,800,000; a timeout never goes to Blocked — [WORKFLOW.md:415-434](WORKFLOW.md).
- A failed entry check "records nothing and costs no round" (the agent stays in its session to fix it) — [docs/concepts/multi-agent.md:52](docs/concepts/multi-agent.md), [docs/concepts/multi-agent.md:99](docs/concepts/multi-agent.md). Read-only roles and (since 0b03334) the docs role fall back to the developer via `on_check_failed` — [docs/concepts/multi-agent.md:101](docs/concepts/multi-agent.md).
- A run without a result gets one reminder turn, then `on_missing_result` (Blocked by default) — [docs/concepts/multi-agent.md:79](docs/concepts/multi-agent.md).
- Session limits: a model limit holds only that model; after the retries Symphony waits for the reset and pauses new dispatches — [WORKFLOW.md:122-124](WORKFLOW.md), [docs/usage.md:363-391](docs/usage.md).

**Documented single cases of loops and blocks**
- tsv-server#10: test round limit reached after two rounds of guessing → Blocked, `needs-human`; resolved in four minutes once a human pasted two log lines — [reports/symphony-issue-ci-log-tail.md:15-18](reports/symphony-issue-ci-log-tail.md).
- trainingsstunden-portal#283: Blocked by a foreign flaky test in the docs stage; a human had to read the cause, write a comment and move the card — [reports/symphony-issue-docs-on-check-failed.md:9-11](reports/symphony-issue-docs-on-check-failed.md).
- symphony#509: after a human test fix, a renewed docs run failed on the path rule; one must know to resume in Agent review or In progress, not in Documentation — [reports/symphony-issue-docs-on-check-failed.md:20](reports/symphony-issue-docs-on-check-failed.md).
- marktausschuss#205: resumed through Ready instead of In progress, so issue-analyst and fable architect (156 s) ran again before a developer session with five model calls only re-reported the result ("Den Code habe ich nicht geändert") — [INT:135](research_notes/Subagents%20pro%20Rolle%20in%20Symphony/symphony_internal.md), [REP:41](reports/Subagents%20pro%20Rolle%20in%20Symphony.md).
- marktausschuss#205 architect: subagent died on the weekly limit, outcome `session_limit`, second architect attempt two days later (603 s) — [INT:132-133](research_notes/Subagents%20pro%20Rolle%20in%20Symphony/symphony_internal.md).
- Early background-task case (2026-10-21): a self-review started in the background was lost because the run ended after 9.3 s — [INT:97](research_notes/Subagents%20pro%20Rolle%20in%20Symphony/symphony_internal.md).

**Recurring review findings (#575, newest commit)**
- The premise of the feature: "A review finding that comes back is a lesson nobody wrote down." Example categories named in the docs: `screenshots-missing`, `base-branch-conflict` — [docs/brain.md:67-69](docs/brain.md).
- Mechanism: a blocker/major category recurs when it appears again in the same issue or in ≥ `min_issues` (2) issues within `window_days` (14); the reviewer must then write a lesson, which is injected into developer, test-engineer and architect prompts (budget 6,000 chars) — [docs/brain.md:71-80](docs/brain.md), [WORKFLOW.md:463-467](WORKFLOW.md); commit 37200a4.

### Inferences
- (Inference) The delegation data falsify one common catalogue assumption: **offering more optional specialists does not make agents use them**. Five Laravel personas were offered; three were never called in 2,745 runs. A catalogue of 40–50 roles only produces value if a role is either (a) a pipeline stage or an orchestrator-enforced step, or (b) tied to a hard occasion in the result contract (as E3-4/E3-5/E3-7 did). Purely advisory roles for Sonnet sessions are, on this evidence, dead entries.
- (Inference) The documented Blocked cases share one pattern: **the agent in the stage lacked the means to fix or even see the cause** (foreign flaky test, unreadable CI log, path rule). In each case the human contribution was small (two log lines, one comment, one card move). That points to a "blocked triage / unblock" function: read the Blocked reason, classify it, and either route it (to developer, to a base-branch fix issue) or prepare the human decision. Whether that is a role or a deterministic router depends on the class; the two fixed cases were solved deterministically (`on_check_failed`).
- (Inference) The resume errors (#205 via Ready, #509 via Documentation) are operator-knowledge problems. A deterministic "resume here" hint on the Blocked comment would fix them; no agent role is needed.
- (Inference) The implicit existence of #575 shows that review bounces for *repeated* reasons were frequent enough to build a feature against. The size of the effect is not in the repository (see Gaps).

### Gaps
- **No figure for review bounces** (developer ↔ reviewer rounds per issue) in any repository file. The analytics endpoint computes them (`returns`, question 4), but no export is checked in. A note in the owner's local memory index (outside the repository, not verified here) mentions a #575 baseline of "48 bounces/7 days"; it must not be cited as repository evidence.
- No count of Blocked issues, of `needs-human` labels, of `max_check_failures`/round-limit hits, of continuation pauses or of session-limit waits over any period.
- No delegation figures after v1.4.0 (explorer, lenses, test-designer). Whether Sonnet developers now delegate is unknown.
- The token-sink analysis rests on five sampled opus developer sessions in two Laravel repositories.

---

## 3. Which recurring bugfix themes show up in the git history, and what do they say about weak points?

### Takeaway
Since v1.4.0 (2026-11-06) every bugfix on `origin/develop` is a reaction to an observed agent failure, and they cluster in five themes: prompt/tool mismatch, harness limits, entry-check and flaky-test handling, docs-stage dead ends, and screenshots. The same themes already appear in the October history (check output, `report_result` JSON, screenshots, path rule, session limits), so they are chronic weak points rather than one-off defects.

### Cited Findings

**Commits e064ff9..origin/develop (18 commits, 2026-11-06 to 2026-11-11)** — `git log e064ff9..origin/develop`
- Prompt/tool mismatch: 5bd0a48 "get_issue liefert PR-Beschreibung und -Diskussion; neues get_issue_by_number (#565)"; 43ac8ad "Planungsrollen halten UI-Screenshots nicht mehr für unmöglich (#562)" (changes `roles/analyst.md`, `roles/autopilot.md`, `roles/planner.md` and three skills); 4bd1afa "Laravel-only checklist items only in Laravel workspaces (project_types) (#559)" (changes `roles/reviewer.md`, `roles/security-auditor.md`, `roles/test-engineer.md`).
- Harness limits: bf18b22 "Bash-Timeout 10 min (max 20) für vollen Testlauf (#564)"; 67e3010 "Auto-Compact-Fenster je Rolle (claude.auto_compact_window) (#573)" ([WORKFLOW.md:164](WORKFLOW.md): `auto_compact_window: 200000`, architect 400000 at [WORKFLOW.md:220](WORKFLOW.md)).
- Dead ends and recovery: d7d96b2 "leere/unlesbare Workspace-Lock-Dateien werden zurückgewonnen (#563)"; 0b03334 "Docs-Rolle gibt rote Entry-Checks über on_check_failed an den Developer zurück (#569)".
- Quality loops: c12ddf6 "frühes, größenabhängiges Self-Review in der Developer-Rolle (#503)" (adds `.claude/agents/spec-reviewer.md`); 37200a4 "Wiederkehrende Review-Funde als Brain-Lessons festhalten und dem Developer einspielen (#575)" (46 files, +2,878 lines).
- Test hygiene: f7a2319 "make test/checks.test.ts hermetic in agent workspaces (#558)" (tests picked up leaked `SYMPHONY_*/DB_*/DOCKER_*` variables of the agent environment); inside 4bd1afa the commit "Test: remove HEAD~1-based vacuous byte-identity test (#555)".
- Measurement: bfc0858 "security panel votes per lens in the statistics (#554)"; 98c528a "show the panel votes in the security comment (#557)"; 5f97f30/58d6ee4/94e342e (E4-6) subagent attribution by `agent_id`.

**Evidence of review rounds inside single PRs (squash-commit bodies)**
- 5bd0a48 contains a second developer commit "Bugfix: review findings for get_issue_by_number: project-scoped status, not_found, tool lists, typecheck (#565)" followed by more tests and docs commits — `git show -s 5bd0a48`.
- d7d96b2 contains "Bugfix: only remove a lock file this call created; neutral lock warning (#563)" after the first fix and its tests — `git show -s d7d96b2`.
- bf18b22 contains "Bugfix: developer prompt carries the one-call test-suite hint for every issue type (#564)" after the test commit — `git show -s bf18b22`.
- Stage authorship by trailer: developer and test commits "Co-Authored-By: Claude Sonnet 5.5", docs commits "Claude Haiku 5.5", the L-sized #575 developer commit "Claude Opus 5.5" — same commit bodies; consistent with [WORKFLOW.md:232](WORKFLOW.md), [WORKFLOW.md:246](WORKFLOW.md), [WORKFLOW.md:262](WORKFLOW.md).

**Same themes before v1.4.0 (`git log origin/develop`, 381 commits in total)**
- Entry checks and their output: "Check-Ausgabe: jeder fehlgeschlagene Check behält seinen Teil, check_error zeigt die Ausgabe" (2026-10-24), "ci-Check gibt Schrittdauern und Host-Last aus (#311)", "Paralleltests auch im schnellen Entry-Check (SYMPHONY_TEST_PARALLEL) (#304)", "Rückgaben über on_check_failed begrenzen (pipeline.max_check_failures) (#306)" (all 2026-10-25), "feat: check_timeout keeps a timed-out issue out of Blocked" (2026-10-16).
- Result contract: "report_result: weniger ungültiges JSON (Hinweis auf JSON-Arrays, Escaping) (#308)" (2026-10-25), "get_issue: Result-Marker aus Kommentaren entfernen und JSON-Form dokumentieren (#290)" (2026-10-23).
- Screenshots: "Headless Chromium in the image so agents can take UI screenshots", "Screenshots: Agenten finden Chromium und bauen das Frontend selbst" (2026-10-23), "Developer liefert Screenshots bei UI-Änderungen zuverlässig (#313)" (2026-10-25), then 43ac8ad (2026-11-09). The prompt now carries a long how-to block and a contract rule (`screenshots_problem`) — [WORKFLOW.md:539-544](WORKFLOW.md), [docs/results.md:213-224](docs/results.md).
- Path rule of test/docs roles: "Pfadregel: Commits aus dem Base-Branch nicht dem Test-Engineer anrechnen, blocked immer annehmen (#406)" (2026-10-30).
- Loops: "max_continuations: result-driven hand-offs no longer count as loops (#237)", "Reset round counters when a human resumes an issue (#236)", "Harden failure and retry paths of result-driven stages (#241)" (2026-10-18).
- Background tasks: "Run subagents and commands in the foreground; name leftover background tasks" (2026-10-22).
- Session limits: a block of ten commits on 2026-10-05 (#93–#110) plus "Model-specific session limits: hold only the affected model (#175)" (2026-10-17).
- Documentation drift: "(E1-4) Maintenance: fix the documentation drift (#521)" (2026-11-05); drift items listed at [INT:257](research_notes/Subagents%20pro%20Rolle%20in%20Symphony/symphony_internal.md).

### Inferences
- (Inference) **Prompts drift from tools.** Three fixes in four days corrected role prompts that promised or assumed something the tools or the workspace did not provide (PR body, screenshots, Laravel checklist in non-Laravel repos). This is a deterministic-check candidate ("prompt lint": every tool field or capability a role prompt names must exist), possibly supported by a periodic audit role outside the issue pipeline. It is not a per-issue pipeline role.
- (Inference) **Screenshots are the most persistent single friction** (four fixes across three weeks, a recurring-finding category named `screenshots-missing` in the docs). The current remedy is ever longer prompt text plus a contract refusal. A dedicated, narrowly scoped helper (serve the app, build assets, capture, verify the PNG) is a plausible subagent or skill: the task is mechanical, tool-heavy and independent of the implementation reasoning. The hanging Playwright scripts in ERR-003 belong to the same pattern.
- (Inference) **Tests written by the pipeline are a quality leak**: flaky tests from earlier issues block later ones (#283, ERR-002), a vacuous test had to be removed (#555), a test file was not hermetic (#558). The existing contract checks cover RED-at-base and mutation score at L/XL only, and the mutation rule is effectively off because the image has neither PCOV nor Xdebug ([docs/results.md:284-290](docs/results.md)). Determinism and robustness of new tests are not checked anywhere. Cheapest check: run new tests N times in the entry check (deterministic). A lens for randomness/ordering/time assumptions would be the role-shaped complement.
- (Inference) **Review rounds are normal even for small bugfixes** (three of five squash commits on 2026-11-09 show a second developer fix after tests or review). The findings named in 5bd0a48 (`not_found`, tool lists, typecheck) are spec-completeness misses of the kind the size-gated self-review (c12ddf6) targets, but that review is gated to L/XL ([WORKFLOW.md:228](WORKFLOW.md)), and these were smaller issues. Whether S/M deserves a cheap pre-handoff check is open; #575 lessons are the current answer.
- (Inference) The owner's fix pattern is consistent: first a deterministic rule in the orchestrator or result contract, then a prompt line, and a subagent only where an information boundary or cost argument exists. Role proposals that ignore this order would contradict the documented decision D1 ([SUB:246-262](docs/concepts/subagents.md)).

### Gaps
- Commit messages name the fix, not the frequency of the underlying failure; only ERR-001 to ERR-004 have counts.
- Whether the second developer commits inside the squash bodies came from the reviewer, the test engineer or an entry check cannot be told from the git history alone (the stage results live in issue comments on GitHub, not in the repository).
- No history evidence about the Design stage or the security stage failing; the absence may mean "works" or "not observed".

---

## 4. Which measurements exist or are planned, i.e. how could the benefit of a new role be measured?

### Takeaway
The instruments exist: `GET /api/v1/history/analytics` returns `subagent_evaluation` (per role × primary model, filterable by complexity, repository and period) with delegation rate, main-thread Bash, subagent token share, cost per finished issue and returns from review and testing; `finding_categories` measures whether a lesson lowers recurring findings. The first real before/after evaluation (#501, explorer) is running and ends no earlier than 2026-11-20; its export script and decision thresholds are a ready template for any new role. No results are checked in yet.

### Cited Findings

**E0 measurement (implemented 2026-11-05/06, commits af584be, b298c03, 2375249, ba78193, 6f2f932, b65fea8, a517a8f)**
- Why it came first: "while context fill, subagent tokens and status are wrong, no optimisation can be shown" — [SUB:278](docs/concepts/subagents.md). Before E0 the context fill was computed against 200k instead of 1M, so the "125.5 %" of #205 was really 25.1 % and "every peak above 80 %" was an artefact — [SUB:148](docs/concepts/subagents.md); the subagent token tile was about 8× Claude Code's figure (528,688 vs 65,819) — [INT:95](research_notes/Subagents%20pro%20Rolle%20in%20Symphony/symphony_internal.md); `tool_calls` mixed main-thread and subagent calls — [INT:90](research_notes/Subagents%20pro%20Rolle%20in%20Symphony/symphony_internal.md).
- E0-9 `subagent_evaluation`: "one row per role × primary model; filters `role`, `complexity`, repository, period" with delegation rate, main-thread Bash per run (median, p90), subagents' share of billed tokens, cost per finished issue, returns per issue from Agent review (`changes_needed`) and Testing (`failed`), confirmed/refuted findings, mutation scores and `security_panel` — [SUB:380-397](docs/concepts/subagents.md). Field names in code: `delegation_rate`, `runs_with_subagent`, `main_bash`, `subagent_token_share`, `cost_per_finished_issue`, `own_cost_per_finished_issue`, `review_changes_needed`, `test_failed`, `per_issue`, `mutation_scores`, `security_panel` — [src/history/analytics.ts:930-963](src/history/analytics.ts) @ origin/develop.
- Other analytics blocks in the same endpoint: `by_outcome`, `by_role`, `by_profile`, `verdicts_by_role`, `retry_rate`, `failure_rate`, `compacts_by_role`, `avg_context_by_role`, `budget_insights`, `attention`, `pipelines`, `retried`, `finding_categories` — [src/history/analytics.ts:1370-1409](src/history/analytics.ts).
- Raw sources: repository logs with `run_finished` (outcome, role, model, cost, `tool_calls`, `agent_calls`), `stage_result` (verdict, complexity, target, `categories=slug:n`, `panel_*`), `checks_finished` (`duration_ms`, exit code), `session_limit_wait`, `issue_paused`, `transition_denied`, `handed_off` — [reports/501-export.mjs:13-42](reports/501-export.mjs), [errors-report.md:268-269](errors-report.md), [docs/usage.md:377-381](docs/usage.md), [docs/usage.md:868-869](docs/usage.md), [docs/usage.md:1007](docs/usage.md).
- Planned metric table of the concept (cost per finished issue, main-thread Bash, delegation rate, subagent token share, returns, confirmed vs refuted findings, mutation score, handed-off share and duration, each with expected direction) — [SUB:715-728](docs/concepts/subagents.md).
- Method: "From stage 2 on every change is an A/B per role. The switch is the role's `agents` list plus its prompt line, so a change can be turned off without code." Comparison only within one model and complexity, because "the data cannot separate 'strong models follow the hints' from 'large issues get strong models'". "A pattern that raises the cost per finished issue without fewer returns or more confirmed findings is removed again." — [SUB:729-736](docs/concepts/subagents.md).

**#501 explorer measurement (E2-5), running**
- T0 = 2026-11-06T03:04:42Z (container start of v1.4.0); before arm 2026-10-23 to T0, after arm T0 to 2026-11-20T03:04:42Z, "verlängert, bis jede Hauptzelle mindestens 10 fertige Issues hat"; all repositories — [reports/501-kommentar-c.md:3-8](reports/501-kommentar-c.md).
- Thresholds: not assessable below 20 runs or 10 finished issues per arm; "Kosten gesenkt" = `cost_per_finished_issue` at least 5 % lower; "gleiche Erfolgsrate" = handed-off share falls by at most 5 percentage points and `returns.per_issue` rises by at most 0.1; the cell with the most runs decides per role; otherwise the explorer is removed from `roles.<role>.agents` — [reports/501-kommentar-c.md:10-17](reports/501-kommentar-c.md).
- Confounders named: v1.4.0 also changed Claude Code 2.1.288 → 2.1.318, removed personas (E1-2), added E3-2/E3-3/E3-6/E3-7 at L/XL and E4-3; roles without an explorer (test-engineer, reviewer, docs, security-auditor, issue-analyst) serve as control group — [reports/501-kommentar-c.md:21](reports/501-kommentar-c.md).
- Before-arm baseline quoted there: "Developer auf sonnet: 0 von 301 Läufen" delegated — [reports/501-kommentar-c.md:22](reports/501-kommentar-c.md).
- Roles expected to stay unassessable (n too small): analyst, planner, autopilot, auditor — [reports/501-kommentar-c.md:17](reports/501-kommentar-c.md).
- Export script: per complexity S/M/L/XL the `subagent_evaluation` rows plus the handed-off share per role × model computed from `run_finished` — [reports/501-export.mjs:25-45](reports/501-export.mjs).

**Review-lesson measurement (#575)**
- `finding_categories`: "per category the findings and affected issues of the period, the lesson with the date it exists since … and the findings after that date. A lesson that works lowers the findings after it." — [docs/brain.md:91](docs/brain.md); field `findings_after_lesson` — [src/history/analytics.ts:678](src/history/analytics.ts).
- A result without a lesson for a recurring category is refused once; the second call is accepted and logged as `lesson_missing` — commit 37200a4 body, [docs/results.md:203-211](docs/results.md).

**Contract-level quality signals usable as role metrics**
- Verified findings at L/XL (`verification.status confirmed|refuted`), security panel votes per lens (`panel_candidates`, `panel_confirmed`, `panel_refuted`, `panel_single_refuted`), `red_at_base` per new test case, `mutation_score` — [docs/results.md:229-297](docs/results.md).
- Entry-check step durations and host load are printed per step ("php -l 8s ok · pint 6s ok · composer analyse 6s ok · php artisan test 4m 19s failed") — [errors-report.md:135](errors-report.md), [checks/laravel.sh:30-31](checks/laravel.sh).
- Error collector with stable signatures per error (`/symphony-error-report` → `errors-report.md`), re-runnable per signature after a fix — [errors-report.md:5](errors-report.md), [errors-report.md:98](errors-report.md).

**Explicitly postponed role ideas waiting for E2-5**
- "These patterns … get no requirement yet; each waits for the E2-5 evaluation": a haiku duplicate finder for the issue analyst; a haiku link and reference checker for docs; haiku checkers per vault folder for the brain gardener; per-section drafters and a feasibility checker for planner, analyst and autopilot; inventory, per-component auditors and a verifier for the auditor; a test runner with verbatim failure excerpts for the developer; preloading Boost skills per persona — [SUB:752-759](docs/concepts/subagents.md).
- Non-goals: parallel writing subagents on coupled files; mandatory delegation for small issues; agent teams; forks; Symphony-run verification or test-design stages ("new roles and columns need a concept of their own"); subagents to protect the context window — [SUB:738-750](docs/concepts/subagents.md).

### Inferences
- (Inference) A new role can be measured with what exists, provided it is switchable through `roles.<role>.agents` plus a prompt line: before/after per role × model × complexity on (1) `cost_per_finished_issue`, (2) `returns.per_issue` (`review_changes_needed`, `test_failed`), (3) handed-off share, (4) for review-type roles confirmed vs refuted findings. The #501 thresholds (−5 % cost, ≤ 5 points handed-off loss, ≤ +0.1 returns, n ≥ 20 runs / 10 issues) are a ready acceptance template.
- (Inference) **Sample size is the binding constraint for a 40–50 role catalogue.** #501 already expects four roles to be unassessable in 14 days, and with one switch per period, 40–50 roles cannot be evaluated sequentially in any reasonable time. The report should prioritise a short list for measurement and mark the rest as unmeasured candidates, or propose per-issue assignment (open question 12 of the concept: "a label that empties `agents` for that issue", [SUB:795-797](docs/concepts/subagents.md)).
- (Inference) Metrics that are missing for the pain points found in questions 1–3 and would have to be added: check failures classified by cause (diff / base red / flaky), Blocked count and time-in-Blocked per reason, human interventions per issue, review rounds per issue as a plain time series, wall-clock time spent in entry checks per issue. The raw lines exist (`checks_finished`, `stage_result`, `issue_paused`), the aggregation does not.
- (Inference) For lesson-type or checklist-type remedies (skills, prompt changes), `finding_categories.findings_after_lesson` is the natural metric; it works per category without an A/B arm.

### Gaps
- No `501-before.json` / `501-after.json` or any analytics export is in the repository; the result of the explorer evaluation is unknown as of 2026-11-12 (after arm ends 2026-11-20 at the earliest).
- No measured effect yet for any v1.4.0 pattern (design-critic share < 20 %, lens review, test designer, security panel) nor for #503 (early self-review) or #575 (lessons); all were merged between 2026-11-06 and 2026-11-11.
- Mutation score is practically unavailable (image has neither PCOV nor Xdebug), so the test-quality metric of E3-7 does not yield data — [docs/results.md:284-290](docs/results.md).
- There is no metric for the quality of results that pass all gates (escaped defects found by the human in "In review" or after the merge).

---

## 5. For each pain point: dedicated agent role, skill, prompt change or deterministic check?

### Takeaway
On the repository's own evidence most observed pain points are best fixed deterministically or by prompt/tool repair, and the owner has done exactly that. Evidence supports dedicated roles or subagents only in a few places: failure diagnosis for red checks and CI, test-robustness review, a screenshot/UI-evidence helper, exploration under expensive models (already built, unmeasured), Blocked triage, and periodic audits of prompts and tests outside the per-issue pipeline. Everything in the right-hand column of the table is inference unless marked otherwise.

### Cited Findings
The table lists each pain point with its evidence; the assessment column is inference (see below). Status "fixed" means a commit on `origin/develop` exists.

| # | Pain point | Evidence | Status @ 37200a4 | Best lever (inference) | Role-shaped residue (inference) |
|---|---|---|---|---|---|
| 1 | Full test suite does not fit into one Bash call; agents hand off untested | 28 timeouts / 19 issues / 24 h, all Sonnet — [errors-report.md:208-213](errors-report.md) | fixed (bf18b22) | Deterministic (env default) + prompt line | none |
| 2 | Slow single-process suite: every rejected hand-off costs 3–5 min | 2m59s–5m18s, ~1,850 tests, no paratest — [errors-report.md:152-163](errors-report.md) | open in the target repo (#324) | Deterministic (paratest); repo-setup check at onboarding | "repo readiness" audit (one-off, per repository): paratest, lockfiles, tools in image |
| 3 | Flaky tests block unrelated issues | 3 issues in 24 h — [errors-report.md:123](errors-report.md); #283 — [reports/symphony-issue-docs-on-check-failed.md:9](reports/symphony-issue-docs-on-check-failed.md) | routing fixed (0b03334); detection explicitly "Nicht Teil dieses Issues" — [reports/symphony-issue-docs-on-check-failed.md:43](reports/symphony-issue-docs-on-check-failed.md) | Deterministic first: rerun failed tests, compare with base commit, label "red on base" / "flaky" | **Flaky-test fixer**: a role that takes a detected flaky test as its own issue and fixes the cause (the human instructions in [reports/trainingsstunden-portal-283-comment.md:13-31](reports/trainingsstunden-portal-283-comment.md) are effectively its brief) |
| 4 | Base branch red; every open issue fails its check | `YarnLockfileTest` red on develop, #259/#260 — [errors-report.md:124](errors-report.md), [errors-report.md:164-165](errors-report.md) | fixed once by hand (e1b8323) | Deterministic: check the base branch before dispatch, pause dispatch or open one fix issue | **Base-branch guardian** only as the fixer of that one issue; detection is deterministic |
| 5 | Agent missed tests affected by its own change | 6 of 12 issues — [errors-report.md:125](errors-report.md) | partly addressed by #1 | Prompt (run the full suite in one call) + entry check (exists) | possibly a test-impact helper (which tests cover the changed files); unmeasured |
| 6 | CI red, log unreadable; agents guess, burn rounds, land in Blocked | tsv-server#10: 2 rounds, 3 wrong suspects, Blocked; 4 min after 2 log lines — [reports/symphony-issue-ci-log-tail.md:15-18](reports/symphony-issue-ci-log-tail.md) | open (draft issue only) | Tool extension (`log_tail` in `get_issue`) + tools in the image + prompt "do not guess" | **CI-failure diagnostician**: reads the log excerpt, names file:line and cause, hands a minimal brief to the developer. Only useful once the log is readable |
| 7 | Reviewer worked without PR description; one credential-exploration attempt | 9 / 9 issues — [errors-report.md:303-346](errors-report.md) | fixed (5bd0a48) | Tool + prompt | none |
| 8 | Role prompts promise things the tools do not deliver | #565, #561/#562, #555/#559 — commits 5bd0a48, 43ac8ad, 4bd1afa; drift list — [INT:257](research_notes/Subagents%20pro%20Rolle%20in%20Symphony/symphony_internal.md) | fixed case by case | Deterministic prompt/tool consistency test (several such tests already exist, e.g. `test/workflow-prompt.test.ts`) | periodic **prompt/doc-drift auditor** outside the issue pipeline (like `/refactoring`) |
| 9 | UI screenshots missing or impossible; hanging Playwright scripts | four fixes 2026-10-23 to 2026-11-09 (see question 3); `screenshots-missing` as example category — [docs/brain.md:69](docs/brain.md); hangs — [errors-report.md:257-258](errors-report.md) | contract rule + long prompt block — [WORKFLOW.md:539-544](WORKFLOW.md) | Skill or script (`symphony-screenshot`) first | **Screenshot/UI-evidence helper** as a subagent of the developer: mechanical, tool-heavy, separable; could also give reviewers visual evidence |
| 10 | Docs stage dead end on red checks; resume in the wrong column | #283, #509 — [reports/symphony-issue-docs-on-check-failed.md:9-20](reports/symphony-issue-docs-on-check-failed.md) | fixed (0b03334) | Deterministic routing | none |
| 11 | Blocked issues need a human for small, mechanical steps | #283 (comment + card move), tsv-server#10 (two log lines), #205 (wrong resume column) — sources above and [REP:41](reports/Subagents%20pro%20Rolle%20in%20Symphony.md) | two causes fixed | Deterministic routing per known cause; "resume here" hint | **Blocked triager**: classifies the Blocked reason, proposes the route or prepares the human decision. Value depends on the unmeasured Blocked volume |
| 12 | Exploration on the most expensive models (cache re-reads) | 68–87 % of Bash output is exploration; 17.68M tokens re-read in one session — [INT:196-204](research_notes/Subagents%20pro%20Rolle%20in%20Symphony/symphony_internal.md) | explorer built (10aa70e, 895b27f), under measurement (#501) | Subagent (exists) | none new until #501 reports; the concept's verdict is "not measured" — [SUB:526](docs/concepts/subagents.md) |
| 13 | Optional subagents are ignored by Sonnet | 0 of 252 (0 of 301 in the #501 baseline) — [SUB:20-21](docs/concepts/subagents.md), [reports/501-kommentar-c.md:22](reports/501-kommentar-c.md) | prompts on occasions (c504854), contract enforcement at L/XL | Contract enforcement (D1) over more roles | none; this is a design constraint for the whole catalogue |
| 14 | Self-review came 14–49 min late; review rounds for spec-completeness misses | [INT:180](research_notes/Subagents%20pro%20Rolle%20in%20Symphony/symphony_internal.md); second developer commits in 5bd0a48, d7d96b2, bf18b22 | early self-review at L/XL (c12ddf6), `spec-reviewer` agent exists | Subagent (exists, L/XL only) + lessons (#575) | open question whether a cheap **acceptance-criteria checker** at S/M pays; the concept's non-goal says no mandatory delegation at S/M |
| 15 | Same review finding recurs across issues | premise of #575 — [docs/brain.md:67](docs/brain.md) | lessons mechanism (37200a4) | Knowledge injection (lesson) — neither role nor check | a role is justified only for categories that stay high in `findings_after_lesson`; then a category-specific lens is evidence-based |
| 16 | Tests of poor robustness or value (random substrings, ordering, vacuous, non-hermetic) | #283 test from E4-1a — [reports/trainingsstunden-portal-283-comment.md:3-11](reports/trainingsstunden-portal-283-comment.md); f7a2319; "remove … vacuous byte-identity test" in 4bd1afa | RED-at-base and mutation rules at L/XL; mutation effectively off — [docs/results.md:284-290](docs/results.md) | Deterministic: repeat new tests N times in the entry check; enable PCOV for mutation | **Test-robustness lens** in the Testing stage (randomness, time, order, substring assertions, environment leaks); read-only, cheap model |
| 17 | Architect critiques itself on the same model at 18–57 % of tokens | [INT:166-172](research_notes/Subagents%20pro%20Rolle%20in%20Symphony/symphony_internal.md) | design-critic on opus at L/XL (f7ace51) — [WORKFLOW.md:218](WORKFLOW.md) | Subagent (exists) | none until measured (target: critic share < 20 %, [SUB:559](docs/concepts/subagents.md)) |
| 18 | Operational blind spots: disk full, lost transcripts | [errors-report.md:7-10](errors-report.md) | lock fix (d7d96b2); disk itself is operations | Deterministic monitoring/alert (system collector exists: commit 301e6d7 "/api/v1/system") | none (operations, outside the development pipeline) |
| 19 | Harness refusals and tool-name glitches (Sonnet) | 7 + 4 events — [errors-report.md:393-395](errors-report.md), [errors-report.md:414-415](errors-report.md) | ignored on purpose | none (noise) | none |
| 20 | `report_result` formal rejections (JSON, summary too long, path rule) | #308 commit; 2 × `too_big` — [errors-report.md:416](errors-report.md); path rule — [docs/results.md:299-323](docs/results.md) | hints in tool and prompts | Deterministic validation (exists) + prompt | none |

Constraints the documents themselves place on role proposals:
- A fresh-eyes subagent inside the reviewer column "bringt … kaum zusätzliche Unabhängigkeit, und das erklärt auch die null Aufrufe" — [REP:59](reports/Subagents%20pro%20Rolle%20in%20Symphony.md).
- "Muster, die zuverlässig laufen müssen … sind als deterministischer Schritt der Orchestrierung besser aufgehoben als als optionaler Subagent, den nur starke Modelle überhaupt aufrufen." — [REP:102](reports/Subagents%20pro%20Rolle%20in%20Symphony.md).
- Writers stay single; no parallel writing subagents on coupled files — [SUB:738-741](docs/concepts/subagents.md), [REP:98](reports/Subagents%20pro%20Rolle%20in%20Symphony.md).
- Very large changes are split into sub-issues instead of an integration-engineer role — [docs/concepts/multi-agent.md:102](docs/concepts/multi-agent.md).
- Agent sessions have no GitHub token and no `gh`; this must stay — [errors-report.md:373](errors-report.md), [reports/symphony-issue-ci-log-tail.md:41](reports/symphony-issue-ci-log-tail.md).
- Current subagent inventory on `origin/develop` (14 files): explorer, design-critic, spec-reviewer, bug-lens, convention-lens, finding-verifier, security-inventory, refutation-judge, test-designer, and five `laravel-*` personas — `git ls-tree origin/develop .claude/agents/`; role allowlists at [WORKFLOW.md:194-351](WORKFLOW.md).

### Inferences
All of the following are my own inferences from the findings above.

1. **Roles with direct operational evidence (strongest justification):**
   - *Check/CI failure diagnostician* (pain points 3, 4, 6): the two best-documented Blocked cases were diagnosis failures where a short, correct diagnosis unblocked the pipeline in minutes. Precondition: the deterministic parts (log excerpt, base-commit comparison, rerun) exist first; the role only interprets.
   - *Flaky-test fixer* and *test-robustness lens* (3, 16): flaky tests created by earlier pipeline runs cost 3 of 12 affected issues in one day plus one Blocked issue the next morning.
   - *Screenshot/UI-evidence helper* (9): the longest-running friction in the history; currently handled with prompt text.
   - *Blocked triager* (11): supported by three cases; volume unmeasured.
2. **Roles that exist and await measurement (do not duplicate):** explorer, design-critic, spec-reviewer, lenses + verifier, security inventory + refutation judges, test-designer. New catalogue entries of the same shape (more lenses, more critics) should be framed as *variants to evaluate after #501*, not as needs.
3. **Roles the concept already names as candidates but has postponed** ("Not in this concept"): duplicate finder (issue-analyst), link/reference checker (docs), vault checkers (brain-gardener), per-section drafters and feasibility checker (planner/analyst/autopilot), inventory + per-component auditors + verifier (auditor), test runner with verbatim failure excerpts (developer). These have a documented rationale but no operational pain evidence in the repository; the test runner is weakened by the finding that test output is only 5–16 % of Bash volume ([INT:208](research_notes/Subagents%20pro%20Rolle%20in%20Symphony/symphony_internal.md)).
4. **Better as skill, prompt or lesson than as role:** framework conventions (the Laravel personas with 0 calls suggest domain specialists are not called; `skills:` preloading or lessons reach the main agent directly), recurring review categories (#575), screenshot how-to (until a helper is justified), resume instructions.
5. **Better as deterministic check:** timeouts, base-branch health before dispatch, flaky detection by rerun, N-times repetition of new tests, prompt/tool consistency, repo readiness (paratest, lockfile, tools in the image), disk space, classification of check failures by cause.
6. **Catalogue-level consequence:** with 0 % delegation by Sonnet developers before v1.4.0 and three never-called personas, a catalogue of 40–50 roles is only credible if each entry states its trigger (pipeline stage, contract-enforced step, or orchestrator-dispatched on a deterministic signal such as "check failed twice with the same test"), its switch (`roles.<role>.agents`) and its metric. Roles dispatched by the orchestrator on a signal avoid the "only strong models call it" problem; the concept currently lists Symphony-run stages as a non-goal that "need a concept of their own", so this is a decision for the owner, not an established direction.
7. **Honest count:** the repository evidence supports roughly four to six genuinely new role-shaped needs (diagnostician, flaky fixer, test-robustness lens, screenshot helper, Blocked triager, drift/readiness auditor), about nine existing subagents awaiting measurement and about seven documented-but-postponed candidates. Reaching 40–50 from pain-point evidence alone is not possible with the data in the repository; the remainder would have to be justified by external practice (other researchers' scope) and marked as unproven for Symphony.

### Gaps
- No repository data on pain in the Design stage, the security stage, the planning roles (analyst, planner, autopilot, auditor: n too small) or on escaped defects after "In review". Role proposals for those areas cannot be grounded in operational data.
- No cost breakdown per stage or per issue is checked in; which stage is the most expensive per finished issue cannot be stated from files (only single sessions: 14–24M tokens for Bash-heavy developer runs, [INT:189](research_notes/Subagents%20pro%20Rolle%20in%20Symphony/symphony_internal.md)).
- No data on how often the human reviewer in "In review" rejects work that passed all agent stages.
- The effect of the fixes of 2026-11-09 to 2026-11-11 is unmeasured; some pain points in the table may already be gone.
- Whether orchestrator-dispatched helper roles (triggered by a signal rather than chosen by the agent) fit the owner's architecture is undecided; the concept lists Symphony-run verification stages as a non-goal for now.
