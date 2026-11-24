# Templates

Write in the language of the concept; translate the template text, but keep the `## Concept Plan` and
`## Concept Report` headings in English exactly as below, because later runs search for them. Keep titles short and
unambiguous: the title is also the key that keeps a retry from creating a duplicate. Every title starts with its key
from the plan (`(E2)`, `(E2-1)`). Paths, numbers and keys are placeholders.

## Epic

Title: `(E<n>) Epic: <area>`, e.g. `(E2) Epic: Invoices` · Labels: `epic`, `concept` · call without `parent`.

```markdown
## Goal
<What this area delivers once it is finished, in two or three sentences.>

## Reference to the concept
`<path>` – <section or quote>

## Mockups and screenshots
<Only if the concept has images for this area: overview images of the whole area; single screens belong to their issues.>
![<what it shows: screen, viewport, state>](https://<host>/<owner>/<repo>/blob/<full commit hash>/<path>?raw=true)
`<path>` – <concept section>

## Content
<The issues are listed below as sub-issues. Here only what connects them: order, shared decisions.>
<References to other epics: "builds on #<n>".>

## Not included
<What belongs to the area but is deliberately not in this epic, with a reference.>

This issue is a container: it stays in the backlog and is not implemented. Close it when all sub-issues are done.
Part of concept #<concept issue>.
```

## Sub-issue

Title: `(E<n>-<m>) <Feature|Design|Quality|Maintenance>: <what changes>`, e.g. `(E2-1) Feature: create invoice`.
Labels: `concept`, category, if applicable `Effort: …` and `Model: …`, if applicable `manual-merge`. Call with `parent`
(number of the epic) and `blocked_by`.

```markdown
## Goal
<What users can do afterwards or what is better afterwards, in one or two sentences.>

Blocked by #<n>

## Reference to the concept
`<path>` – <section or quote>

## Mockups and screenshots
<Only for issues with images; remove the section otherwise. One image per screen, the picture is embedded, not just linked.>
![<what it shows: screen, viewport, state>](https://<host>/<owner>/<repo>/blob/<full commit hash>/<path>?raw=true)
`<path>` – <concept section>. Open the file with the Read tool: layout, order, labels and texts follow it.
<Not embeddable (HTML, PDF, SVG, Figma, other site): name it here as text with its path or link and say that it cannot be opened.>

## Starting point
`<file>:<line>` / `<route>` / `<resource>`: <what exists or is missing today; for something new: where it connects>

## Acceptance criteria
- [ ] <verifiable criterion>
- [ ] <verifiable criterion, including permissions: who may, who may not>
- [ ] <only with an image: the result matches the mockup above in <layout, order, labels, texts, states>; deviations are named in the pull request>

## Tests
- <feature, Livewire or Filament test that proves the criteria>

## Not included
<What deliberately belongs to another issue, with the reference "see #<n>", and what should not be changed.>

Category: <feature|design|quality|maintenance> · Size: <S|M> · Risk: <low|medium|high> ·
Part of epic #<epic> in concept #<concept issue>.
```

The section "Mockups and screenshots" is only there if the plan assigns images to the issue. The link is always built as
`https://<host>/<owner>/<repo>/blob/<full commit hash>/<url-encoded path>?raw=true` (host, owner and repository from the
issue URL, the hash from Phase 1); this form also works in private repositories.

The line `Blocked by #<n>` is only there for issues with a dependency, directly below the goal. A pure refactoring
starts with `/refactor-safely` on the first line; `Blocked by` follows below it.

## Plan

```markdown
## Concept Plan

**Concept:** `<path>` @ `<base>` <short commit hash> · **issue-models:** <auto|fable|opus|sonnet|haiku|off>

### Epics and issues
- **(E1) Epic: <area>**: <one sentence>
  - (E1-1) <Category>: <task> (<category>, <S|M>, risk <…>; Effort and Model labels, if any)
  - (E1-2) <Category>: <task> (…) *waits for E1-1*
- **(E2) Epic: <area>**
  - (E2-1) <Category>: <task> (…) *waits for E1-2*

### Creation order
E1-1, E1-2, E2-1, …

### Coverage
| Concept section | Issue |
|---|---|
| <section> | E1-1, E1-2 |
| <section> | present (`<file>`) |
| <section> | not created: <reason> |

### Mockups and screenshots
Only if the concept has images. **Image commit:** `<full commit hash>` · host/repository: `<host>/<owner>/<repo>`

| Image | Shows | Embedded in |
|---|---|---|
| `<path>` | <screen, viewport, state> | E1, E1-2, E1-3 |
| `<path>` | <…> | not embedded: <reason: format, missing, non-goal> |

### Assumptions and questions
- <assumption or open question>
```

## Report

```markdown
## Concept Report

**Concept:** `<path>` @ `<base>` <short commit hash>

### Created (backlog)
- [ ] #<n> **(E1) Epic: <area>**
  - [ ] #<n> (E1-1) <Category>: <task> (<category>, <S|M>, Effort and Model labels, if any): <reason for those labels in half a sentence, if any>
  - [ ] #<n> (E1-2) <Category>: <task> (…) *waits for #<m>*
- [ ] #<n> **(E2) Epic: <area>**
  - …

### Not created
- <requirement>: <reason: present, non-goal, open question, limit>

### Mockups and screenshots
Only if the concept has images.
- `<path>`: embedded in #<n>, #<m>
- `<path>`: not embedded: <reason, e.g. HTML mockup: please add a PNG export; file missing on the base commit; non-goal>

### Open questions
- <decision a human should make, and what depends on it>

### Notes
<`limit_reached`, unknown labels (`unknown_labels`), `unknown_blockers`, `warnings`, invalid arguments.>

All issues are in the backlog. Review them, drop or add some and move them to "Ready" one by one: an issue with an
open "Blocked by" waits in "Ready" until its blockers are closed. The epics stay in the backlog and are closed when
their sub-issues are done. To extend: comment here, then move this issue back to "Ready".
```

For an addendum the heading is `## Concept Report (addendum <n>)` and the "Created" section lists only the new issues.
