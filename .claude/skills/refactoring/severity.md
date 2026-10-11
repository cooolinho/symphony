# Rating

Every finding gets a **severity** and an **effort**. The order of the sub-issues follows from them.

## Severity

| Level | Criterion | Examples |
|---|---|---|
| critical | data loss, security hole or outage in normal use | missing authorization on a writing action, mass assignment with user input |
| high | wrong behaviour in a common path, or clearly measurable damage | N+1 in a list view, non-idempotent job with double effect |
| medium | wrong in rare cases, or a real maintenance drag | time zone bug, 400-line controller in a frequently changed place |
| low | readability, consistency, minor deprecations | duplicate helper, outdated spelling of an API |

## Effort

| Level | Guideline |
|---|---|
| S | one file or a few lines, one test is enough |
| M | a few files, one pull request, some tests |
| L | many files or tests missing; **split into smaller sub-issues**, otherwise do not create |

## Selection

1. Critical and high first, regardless of effort.
2. Then medium findings with effort S or M that relieve related areas.
3. Low findings only bundled (one sub-issue "Clean up in …") or not at all.
4. Areas without tests: the test sub-issue takes precedence over the refactoring that depends on it.
