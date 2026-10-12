# Templates

Write in the language of the epic; translate the template text, but keep the `## Auto-Code …` report headings in
English exactly as below, because later runs search for them. Keep titles short and unambiguous: the title is also the
key that keeps a retry from creating a duplicate. Paths and numbers are placeholders.

## Sub-issue

Title: `<Feature|Design|Quality|Maintenance>: <what changes>`, e.g. `Feature: CSV export of invoices`.
Labels: `auto-code`, category, `Effort: medium|high`, if applicable `Model: fable|opus|sonnet|haiku` (only with
`issue-models`), if applicable `manual-merge`.

```markdown
## Goal
<What users can do afterwards or what is better afterwards, in one or two sentences.>

## Reference to the project description
<Section or quote from the project description / the roadmap item this issue advances.>

## Starting point
`<file>:<line>` / `<route>` / `<resource>`: <what exists or is missing today>

## Acceptance criteria
- [ ] <verifiable criterion>
- [ ] <verifiable criterion, including permissions: who may, who may not>

## Tests
- <feature, Livewire or Filament test that proves the criteria>

## Notes
<Affected areas, what should not be changed, if applicable "tick off roadmap item `<…>` in `docs/todo.md`".>

Category: <feature|design|quality|maintenance> · Effort: <S|M> · Risk: <low|medium|high> ·
Part of wave <N> of autopilot #<epic>.
```

Dependencies go on their own line directly below the goal: `Blocked by #<n>`. A pure refactoring starts with
`/refactor-safely` on the first line.

## Wave report

```markdown
## Auto-Code Wave <N>

**State:** `<base>` @ <short commit hash> · **Project description:** `<path>`

### Baseline
- Tests: <result> · Analysis: <result> · Pint: <result>

### This wave
- [ ] #<n> <title> (<category>, <effort>, risk <…>[, model <fable|opus|sonnet|haiku>: <reason>]): <why now, reference to the description>
- [ ] #<n> <title> … *waits for #<m>*

### Requests considered
- <comment by @…>: <implemented in #n | later, because … | not, because …>

### Idea backlog (not created)
1. <idea> (<category>, value <…>, effort <…>): <why not yet>

### Notes
<Rejected creations (`limit_reached`), unknown labels, observations.>

Next wave as soon as all issues of this wave are closed. To steer: requests as a comment here on the epic. To reject an
idea: close the sub-issue as "not planned". To stop: move the epic to Backlog.
```

## Checkpoint

```markdown
## Auto-Code Checkpoint after wave <N>

**Release PR:** #<n> (`<base>` → `<default>`) · **Waves:** <from>–<N>

### Done
- #<n> <title>

### Rejected
- #<n> <title>: <what follows from it>

### State
<Baseline, test coverage of the new parts, anything conspicuous.>

### Idea backlog
1. <idea>: <value, effort>

### Recommendation for the next waves
<Focus areas, risks, what you would do differently.>

### Questions
- <decision a human should make>

To continue, move the epic back to "Ready". Requests and answers as a comment here.
```

## Pause and handover

```markdown
## Auto-Code Pause

<Why no idea meets the criteria.> Work continues when the project description gets new goals or requests are posted
here; then move the epic back to "Ready".
```

```markdown
## Auto-Code Handover

This epic has <n> sub-issues (GitHub allows 100). Create a new epic with the description
`/auto-code <arguments>` and paste this section below it.

### State
<Wave N, base branch, last release PR.>

### Idea backlog
1. <idea>

### Rejected (do not suggest again)
- <idea>

### Open requests
- <request>
```
