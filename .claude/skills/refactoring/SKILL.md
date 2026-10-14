---
name: refactoring
description: Refactoring audit for a Laravel/Filament repository. Determines the project context, measures the baseline, finds bugs and refactoring candidates and creates sub-issues from them. Only load when the prompt asks for it (issue command /refactoring), never on your own.
argument-hint: "[scope, e.g. app/Filament]"
---

# Refactoring audit

You analyse the repository and turn the findings into sub-issues of the current issue (the epic). You **change
nothing**: no Edit, no Write, no commit, no push, no pull request. Implementation happens later, in the sub-issues,
after a human approves them.

Scope: `$ARGUMENTS` (empty = whole repository). With a scope you analyse only that path, but read surrounding code as
far as you need it to understand it.

Allowed are read-only commands and measurements. **Forbidden**: `pint` without `--test`, `composer update|require|remove`,
`npm audit fix`, `npm install`, `php artisan migrate|db:seed|tinker`, `git commit|push|checkout` and anything that
changes files in the repository. If a test run writes files (cache, SQLite), that is fine as long as they do not
belong in the repository.

The report heading `## Refactoring audit` is a marker you search for in later runs. Always write it in English, exactly
as in [templates.md](templates.md), whatever the language of the epic. Epics started before the skill was translated
may contain the German form `## Refactoring-Audit`; treat it as equivalent.

## Phase 0: Resume or start fresh

Call `get_issue`. If there is already a comment that starts with `## Refactoring audit`, or there are sub-issues, an
earlier run is continuing here (abort, budget, retry). Then you do **not** start over:

- Report present → only check that all sub-issues it names exist; create missing ones, then `set_status("In review")`.
- Only sub-issues present → analyse only the areas no sub-issue covers yet, and write the report afterwards.

`create_sub_issue` is idempotent: the same title returns the existing issue.

## Phase 1: Project context

Determine and note (evidence from the files, not from memory):

- **PHP, Laravel, Filament, Livewire, test framework (Pest/PHPUnit), Larastan, Pint** from `composer.lock` and `composer.json`.
- **Node, Vite, Tailwind, Alpine** and other frontend packages from `package.json` and the lock file, plus `vite.config.*`.
- Boost tool `application-info`, if available: PHP/Laravel version, packages, models.
- Project rules: `CLAUDE.md`, `AGENTS.md`, `.ai/` (guidelines, rules, skills).
- Structure: panels and resources under `app/Filament`, Livewire components, jobs, policies, `routes/`.

If Boost is not available (no `laravel/boost`), note that in the report and check API questions against the installed
packages in `vendor/`.

## Phase 2: Measure the baseline

Only measure, repair nothing. Use the scripts from `composer.json` first (`test`, `lint`, `analyse` …), otherwise:
`php artisan test` (or `vendor/bin/pest`), `vendor/bin/phpstan analyse`, `vendor/bin/pint --test`, `composer audit`,
`npm audit`, `npm run build`. Per command: result in one line (green, red with count, not present). Red tests and
analysis errors are findings, not obstacles. Without tests in the affected area, Phase 4, rule 3 applies.

## Phase 3: Analysis

Record **bugs** and **refactoring candidates** separately. A bug is behaviour that is demonstrably wrong or will
certainly break. Everything else (structure, duplicates, readability, deprecated APIs) is a refactoring candidate.

- The criteria are in [checklist.md](checklist.md), the rating in [severity.md](severity.md).
- Check APIs against the **installed** version with Boost `search-docs`. Filament in particular differs a lot between
  v3, v4 and v5; what is right in one version can be wrong in another.
- Use `database-schema`, `list-routes`, `last-error` and `read-log-entries` where they back up claims.
- Read the project's Boost skills (`laravel-best-practices`, `filament-development`, `testing-best-practices`), if present.
- Every finding needs evidence: file and line, for bugs also how it occurs. Assumptions do not go into a sub-issue.
  Put them in the report under "Unclear".
- In large repositories you split the analysis by area (e.g. `app/Filament`, `app/Models`, `resources/js`) and let
  read-only subagents (`symphony:laravel-architect`, `symphony:laravel-code-reviewer`) check one area each. You check their findings
  against the code yourself before you adopt them.

## Phase 4: Prioritise and cut

1. At most as many sub-issues as `create_sub_issue` allows; fewer is better. The most important first; the rest you
   list in the report under "Not created".
2. Every sub-issue is **mergeable on its own** and small enough for a pull request a human can review calmly. Bundle
   similar small items into one sub-issue.
3. If a refactoring lies in an area without sufficient tests, that area **first** gets a sub-issue for
   characterization tests only. The refactoring waits for it (`Blocked by #N`).
4. Bug fixes are separate sub-issues and are never mixed into a refactoring: a fix changes behaviour, a refactoring
   must not.

## Phase 5: Output

The templates are in [templates.md](templates.md). Order, because later sub-issues refer to earlier ones:

1. Create sub-issues for characterization tests and note the numbers.
2. Create refactoring sub-issues. **First line of the body: `/refactor-safely`.** Write dependencies literally as
   `Blocked by #N` (in English, also in texts in other languages, otherwise Symphony does not recognise them).
3. Create bug sub-issues, label `bug`. They do **not** start with a command.
4. Post exactly one report comment with `add_comment`: context, baseline, checklist `- [ ] #N title`, Not created, Unclear.
5. Call `set_status("In review")` and end the turn. No entry checks run.

A sub-issue that `create_sub_issue` rejects with `limit_reached` belongs in the report. Mention unknown labels
(`unknown_labels`) there as well. Write sub-issues and report in the language of the epic; only the report heading
stays in English.
