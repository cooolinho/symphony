# Review checklist: refactoring without behaviour change

Work from diffs (`git diff origin/<base>...HEAD`); you are read-only. Per line: OK, n/a or a finding.

## Tests (safety net)

- [ ] `git diff origin/<base>...HEAD -- tests/` contains **only added** lines or new files. Every removed or changed assertion is a blocker.
- [ ] No new `skip`, `todo`, `markTestSkipped`, `->only()`; no loosened expectations (`assertOk` instead of `assertJson`, smaller result sets).
- [ ] The test setup (factories, `phpunit.xml`, Pest configuration, CI) is unchanged, unless the issue asks for it.
- [ ] New tests pin down behaviour: response, database state, error case, authorization. They do not just check that something was called.
- [ ] If the area had no tests before, they came in a **separate commit before** the restructuring (`git log --oneline`).

## Behaviour

- [ ] `routes/`: no route added, removed or renamed, middleware the same.
- [ ] `config/` and environment variables unchanged.
- [ ] `database/migrations/` unchanged, unless the issue asks for a migration; no change to model casts, `$fillable`, `$guarded`, relations with outward effect.
- [ ] Public signatures (return type, parameters, visibility) and events, jobs, Artisan commands the same or backwards compatible; all callers checked (`grep`).
- [ ] Validation, policies, Filament authorization (`canViewAny`, `canEdit` …) and translation texts unchanged.
- [ ] Order and number of results the same (sorting, `limit`, `with`), no new queries in loops.

## Scope

- [ ] Only the area named in the issue was touched; no formatting noise in unrelated files.
- [ ] No bug fix in the same pull request. If one was discovered, it is mentioned as a note in the comment.
- [ ] Commits small and described; renaming, moving and extracting not mixed in one commit.
- [ ] Entry checks (lint, analysis, tests) are green; nothing was weakened to get there.

## Result

- **approved**: no blocker or major findings.
- **changes needed**: every behaviour change, every weakened assertion, every unrelated content.
