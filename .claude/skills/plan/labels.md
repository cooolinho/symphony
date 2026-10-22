# Labels and dependencies

Every item becomes exactly one issue, so the labels describe the item as it is on the list: its size, its risk and how
much thinking it needs.

## Labels

Per issue: `plan`, exactly **one** category, **one** effort label and (except with `issue-models=off`) **one** model
label. A major upgrade (Laravel, Filament, PHP) additionally gets `manual-merge`.

### Category

| Label | When |
|---|---|
| `feature` | new or completed feature |
| `design` | UI and usability |
| `quality` | bugs, tests, refactoring, performance, security |
| `maintenance` | dependencies, upgrades, tooling |

### Effort

How much thinking goes into it, from size and risk:

| Label | When |
|---|---|
| `Effort: low` | texts, translations, configuration, one line |
| `Effort: medium` | size S |
| `Effort: high` | size M, the normal case |
| `Effort: xhigh` | size L, or high risk: data model, permissions, money or billing, migration of existing data, tricky dependencies |

You never assign `Effort: max` on your own. If you lack a yardstick, take `Effort: high`.

### Model

With `issue-models=auto`; with `fable`, `opus`, `sonnet` or `haiku` all issues get the same label:

| Label | When |
|---|---|
| `Model: haiku` | size S **and** low risk: texts, translations, configuration, small changes in one area, simple tests |
| `Model: sonnet` | the normal case: size S with medium risk, size M with low or medium risk (new feature in a few files, design issues, tests) |
| `Model: opus` | size M across several areas, size L, wide reach with medium risk, complex issues: high risk (data model, permissions, money, migrations on existing data), major upgrades, tricky dependencies |

You never pick `Model: fable` with `auto`. For large and risky issues the architect already designs with fable
(complexity L and XL), and the developer implements that design with opus; `Model: fable` stays for a human who
escalates an issue the developer failed on. When in doubt, the stronger model. Effort and model are related but should not blindly run in step: a data
model in one file is `Effort: xhigh` and `Model: opus`; a translation is `Effort: low` and `Model: haiku`.

## Dependencies

- **Only real dependencies**: item B needs code or data from item A (model, role, route, migration). Touching the same
  files is a reason to chain, a shared topic is not. The position on the list alone is no dependency.
- Never a cycle. Check the graph before you post the outline.
- Short chains: if an item waits for more than three others, say so in the report; the list is probably cut too finely
  or too coarsely there.
- In the call: `blocked_by: [<numbers>]` sets GitHub's relationship. In addition the text carries, as its own line
  directly below the goal, `Blocked by #N` (several: `Blocked by #3, #4`), literally and in English, whatever the
  language of the text. That is the only form Symphony recognises in the text.
- An issue is only started once all its blockers are **closed**, i.e. their pull request is merged. You do not write
  that into the issue; it is Symphony's behaviour.
