# Characterization tests

A characterization test pins down **what the code does today**, not what it should do. It is the yardstick for the
refactoring. If you do not like the behaviour, write it down as it is anyway and report it as a finding.

## When to write them

The area has no tests, or they check too little (only the status code, only "runs without errors"). Check this with a
quick mutation in your head: would a test turn red if I changed the return value, the order or a condition?

## How

1. **Determine the behaviour**: read the code, if in doubt run it once (test run, not production) and note the output.
   Do not guess.
2. **Test the outer interface**, not the internals you are about to restructure:
   - HTTP/Livewire/Filament: response, rendered output, validation errors, authorization (allowed and forbidden)
   - services/actions: return value, database state afterwards, dispatched events/jobs/mails (`Event::fake()` etc.)
   - error cases: invalid input, missing records, missing permissions
3. **Real data instead of mocks** (factories, `RefreshDatabase`), mocks only at the system boundary (HTTP, mail, time).
4. **Deterministic**: fix time with `Carbon::setTestNow`, fix randomness and ordering.
5. **Green on the unchanged code** before you restructure anything. A red characterization test means: you described
   the behaviour wrongly. Fix the test, not the code.
6. In separate commit(s) before the refactoring. Pest if the project uses Pest, otherwise PHPUnit; use the existing
   helpers and conventions.

## Limits

Characterize what the refactoring touches, not the whole module. One test for every branch in the touched code, not for
every method in the project.
