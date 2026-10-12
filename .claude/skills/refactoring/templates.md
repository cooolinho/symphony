# Templates

Write in the language of the epic; translate the template text, but keep the `## Refactoring audit` report heading in
English, because later runs search for it. Keep titles short and unambiguous (the title is also the key that keeps a
retry from creating a duplicate). Paths and numbers are placeholders.

## Sub-issue: characterization tests

Title: `Tests: cover <area>`

```markdown
/refactor-safely

Characterization tests only (step 1 of the skill), **no production code**.

## Area
`<path>`: <what the code does, in one sentence>

## To secure
- <behaviour 1 the tests pin down, as it is today>
- <behaviour 2>

## Notes
<database/fakes/peculiarities>

Part of refactoring audit #<epic>.
```

## Sub-issue: refactoring

Title: `Refactoring: <area> – <goal>`

```markdown
/refactor-safely

Blocked by #<test sub-issue>

## Finding
`<file>:<line>`: <problem, with evidence>

## Goal
<State after the refactoring, without behaviour change>

## Approach
1. <step>
2. <step>

## Do not change
<Public interfaces that stay the same: routes, signatures, events, config keys, schema>

Severity: <critical|high|medium|low> · Effort: <S|M|L> · Part of refactoring audit #<epic>.
```

## Sub-issue: bug

Title: `Bug: <symptom>` · label `bug` · **No command on the first line.**

```markdown
## Defect
`<file>:<line>`: <what is wrong>

## Evidence
<How it occurs: input, flow, log or test output>

## Expected
<Correct behaviour>

## Approach
First write a regression test that **fails** (red), then fix the defect (green). Do not mix the fix with
refactorings.

Severity: <critical|high|medium|low> · Part of refactoring audit #<epic>.
```

## Report comment

```markdown
## Refactoring audit

**Scope:** <path or "whole repository"> · **State:** <short commit hash>

### Context
PHP <x> · Laravel <x> · Filament <x> · Livewire <x> · Pest/PHPUnit <x> · Vite <x> · Node <x> · Boost <yes/no>

### Baseline
- Tests: <result>
- Static analysis: <result>
- Pint: <result>
- composer audit / npm audit: <result>
- Build: <result>

### Sub-issues
- [ ] #<n> <title> (<severity>, <effort>)
- [ ] #<n> <title> … *waits for #<m>*

### Not created
- <finding>: <why not (limit, too small, too uncertain)>

### Unclear
- <assumption without evidence and what would be needed to clarify it>

The sub-issues are in the backlog. To implement a sub-issue, move it to "Ready".
```
