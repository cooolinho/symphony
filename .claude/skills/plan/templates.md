# Templates

Write in the language of the list; translate the template text, but keep the `## Plan Outline` and `## Plan Report`
headings in English exactly as below, because later runs search for them. Keep titles short and unambiguous: the title
is also the key that keeps a retry from creating a duplicate. Paths, numbers and keys are placeholders.

## Issue

Title: `<Feature|Design|Quality|Maintenance>: <what changes>`, e.g. `Feature: export invoices as CSV`.
Labels: `plan`, category, if applicable `Effort: …` and `Model: …`, if applicable `manual-merge`. Call without `parent`,
with `blocked_by`.

```markdown
## Goal
<What users can do afterwards or what is better afterwards, in one or two sentences.>

Blocked by #<n>

## Source
<`<path>` or "issue description"> – item <P3>:
> <the item as it is on the list, including its details>

## Starting point
- `<file>:<line>` / `<route>` / `<resource>`: <what exists today, what is missing; for something new: where it connects>

## Implementation plan
1. <step: file or class, what changes there and why>
2. <step: migration, model, policy, resource, component, translation …>
3. <step: tests>

## Acceptance criteria
- [ ] <verifiable criterion>
- [ ] <verifiable criterion, including permissions: who may, who may not>

## Tests
- <feature, Livewire or Filament test that proves the criteria>

## Risks and open points
- <risk and how the plan handles it; decision a human has to make>

## Not included
<What deliberately belongs to another item, with the reference "see #<n>", and what should not be changed.>

Category: <feature|design|quality|maintenance> · Size: <S|M|L> · Risk: <low|medium|high> · Part of plan #<plan issue>.
```

The line `Blocked by #<n>` is only there for issues with a dependency, directly below the goal. A pure refactoring
starts with `/refactor-safely` on the first line; `Blocked by` follows below it. Leave out "Risks and open points" when
there are none.

## Outline

```markdown
## Plan Outline

**Source:** <`<path>` @ `<base>` <short commit hash> | issue description> · **issue-models:** <auto|fable|opus|sonnet|haiku|off>

### Items
- P1 <title> (<category>, <S|M|L>, risk <…>; Effort and Model labels, if any)
- P2 <title> (…) *waits for P1*
- P3 <title> (…)

### Creation order
P1, P3, P2, …

### Coverage
| Item | Issue |
|---|---|
| P1 <short wording> | P1 |
| P4 <short wording> | present (`<file>`) |
| P5 <short wording> | done on the list (`[x]`) |
| P6 <short wording> | not created: <reason> |

### Assumptions and questions
- <assumption or open question>
```

## Report

```markdown
## Plan Report

**Source:** <`<path>` @ `<base>` <short commit hash> | issue description>

### Created (backlog)
- [ ] #<n> <title> (<category>, <S|M|L>, Effort and Model labels, if any): <reason for those labels in half a sentence, if any>
- [ ] #<n> <title> (…) *waits for #<m>*

### Not created
- <item>: <reason: present, done on the list, too vague, limit>

### Open questions
- <decision a human should make, and what depends on it>

### Notes
<`limit_reached`, unknown labels (`unknown_labels`), `unknown_blockers`, `warnings`, invalid arguments, items of size L
that should be split before "Ready".>

All issues are in the backlog. Review them, drop or change some and move them to "Ready" one by one: an issue with an
open "Blocked by" waits in "Ready" until its blockers are closed. To extend: add items to the list (or comment here),
then move this issue back to "Ready".
```

For an addendum the heading is `## Plan Report (addendum <n>)` and the "Created" section lists only the new issues.
