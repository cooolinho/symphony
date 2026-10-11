---
name: refactor-safely
description: Behaviour-preserving refactoring with tests as a safety net, for developers and reviewers. Only load when the prompt asks for it (issue starts with /refactor-safely), never on your own.
argument-hint: "[optional hint]"
---

# Refactoring without behaviour change

A refactoring changes the structure, not the behaviour. Whatever the project did to the outside before, it does exactly
the same afterwards: same responses, same data, same errors. Tests prove it. Your role is stated in the prompt
("Your role: developer" or "reviewer"). Read the section for your role and the rules for everyone.

## Rules for everyone

**Behaviour stays the same.** Do not change, unless the issue explicitly asks for it:

- routes, URLs, HTTP status codes, response formats
- public signatures used elsewhere (classes, methods, events, jobs, Artisan commands)
- database schema and stored data (no migration, unless the issue asks for one)
- config keys, environment variables, permissions and validation rules
- texts and translations that users see

**Bugs do not belong here.** If you discover a bug while refactoring, do not fix it in this pull request. Describe it
in the issue comment with file and line; a human creates a separate issue.

**Tests are the safety net.** Existing tests are not weakened, skipped or deleted, and their assertions stay
unchanged. If an existing test turns red, you changed the behaviour: revert the change instead of adjusting the test.

**Verify against the installed version.** Check framework APIs with Boost `search-docs`, not from memory; Filament,
Livewire and Laravel differ a lot between major versions. Follow `AGENTS.md`, `.ai/` and the project's conventions.

## Developer

1. Read the issue, the audit epic (parent) and the files it names. Check the dependencies: if the issue still waits for
   a test issue (`Blocked by #N`) that is not closed, report that and set `Blocked`.
2. **Safety net first.** Check whether the area has tests that really pin down the behaviour
   (see [characterization-tests.md](characterization-tests.md)). If they are missing, write them **before** you touch
   production code. They must be green on the unchanged code. Commit them separately ("Tests: cover …").
3. If the issue says "characterization tests only", stop here: no production code, continue with step 6.
4. Refactor in small steps. After each step run the affected tests, then one commit per meaningful unit (keep renaming,
   extracting and moving separate).
5. Finally run the whole test suite and the project checks (Pint, analysis). All existing tests are green and
   unchanged; the test diff contains only new files or new lines.
6. Describe in the pull request and in the issue comment: what was restructured, which tests secure the behaviour, what
   did **not** change. If there are deviations from the goal, state them openly.

## Reviewer

You are read-only and work from diffs. Go through the [review-checklist.md](review-checklist.md). In short:

1. `git diff origin/<base>...HEAD -- tests/`: only added lines are allowed. Removed or changed assertions, new
   `skip`/`todo`/`markTestSkipped`, loosened expectations: **blocker**.
2. Diff on `routes/`, `config/`, `database/migrations/`, `app/Events`, `app/Policies`, validation and translations:
   every change not requested in the issue is a **blocker**.
3. Check whether the new tests really pin down the behaviour (responses, database state, error cases) and not just that
   something gets called.
4. Check that nothing unrelated came along: bug fixes, formatting noise in uninvolved files, configuration changes.
5. Report findings in the review's usual format. A refactoring with a behaviour change is **changes needed**, even if
   the change is well-intended.
