# Breakdown: epics, issues, dependencies, labels

A good plan is complete with respect to the concept, every issue is mergeable on its own, and the order follows from
the dependencies, not from the numbering.

## Epics

- An epic is a **functionally coherent area of the concept that can be delivered on its own** ("user management",
  "invoices"), not a technical layer ("database", "frontend").
- An epic has **2 to 10 issues**. A single issue belongs in another epic; more than 10 issues are two epics.
- A foundation epic (roles, tenants, base layout) only if the concept requires it and several areas build on it. It
  comes first.
- Title: `Epic: <area>`. The text summarises the goal of the area and refers to the concept section. It **never**
  contains "blocked by #N" (not even negated) and never `/` commands at the start; references to other epics you write
  as "builds on #N".

## Issues

- **Mergeable on its own**: one pull request a human can review at leisure. Size S (one file or a few lines) or M
  (a few files, one area). Split L.
- **Vertical slice instead of layer**: "create invoice" (migration, model, resource, policy, test) instead of "all
  migrations". Tests belong in the issue that changes the code, not in a test issue of their own.
- Every issue has **verifiable acceptance criteria** (for permissions: who may, who may not), says which tests it
  needs, names the **concept section** and says what does **not** belong to it.
- **Design issues** (the agent does not see the UI): concrete criteria with Filament component, columns, filters,
  actions, texts, empty and error states and which role sees what. Never "make it nicer".
- Anything unclear stays a **question in the report**, not an issue. That also applies to decisions a human has to
  make: legal matters, prices, texts with legal effect, external services that cost money.
- Title: `<Feature|Design|Quality|Maintenance>: <what changes>`, short and unambiguous. The title is the key against
  duplicates and must be unique within an epic.
- A major upgrade (Laravel, Filament, PHP) stands alone in its epic and additionally gets `manual-merge`.
- A pure refactoring without behaviour change starts with `/refactor-safely` on the first line (dependencies go below
  it). If the area lacks tests, it waits for an issue that writes them.

## Dependencies

- **Only real dependencies**: issue B needs code or data from issue A (model, role, route, migration). Touching the
  same files alone is a reason to chain, a shared topic is not.
- **Never on an epic.** A human closes an epic by hand; it would block forever.
- Dependencies may cross epics, but never form a cycle. Check the graph for cycles before you post the plan.
- Short chains: if an issue waits for more than three others, it is too big or cut wrongly.
- In the call: `blocked_by: [<numbers>]` sets GitHub's relationship. In addition the text carries, as its own line
  directly below the goal, `Blocked by #N` (several: `Blocked by #3, #4`), literally and in English, whatever the
  language of the text. That is the only form Symphony recognises in the text.
- An issue is only started once all its blockers are **closed**, i.e. their pull request is merged. You do not write
  that into the issue; it is Symphony's behaviour.

## Labels

Per issue exactly **one** category, **one** effort label and (except with `issue-models=off`) **one** model label.

**Category**

| Label | When |
|---|---|
| `feature` | new or completed feature from the concept |
| `design` | UI and usability |
| `quality` | tests, refactoring, performance, security |
| `maintenance` | dependencies, upgrades, tooling |

**Effort** (how much thinking goes into it; size S/M and risk):

| Label | When |
|---|---|
| `Effort: low` | texts, translations, configuration, one line |
| `Effort: medium` | size S |
| `Effort: high` | size M, the normal case |
| `Effort: xhigh` | high risk: data model, permissions, money or billing, migration of existing data, tricky dependencies |

You never assign `Effort: max` on your own. If you lack a yardstick, take `Effort: high`.

**Model** (`issue-models=auto`; with `fable`, `opus`, `sonnet`, `haiku` all issues get the same label):

| Label | When |
|---|---|
| `Model: haiku` | size S **and** low risk: texts, translations, configuration, small changes in one area, simple tests |
| `Model: sonnet` | the normal case: size S with medium risk, size M with low or medium risk (new feature in a few files, design issues, tests) |
| `Model: opus` | size M across several areas, wide reach with medium risk, complex issues: high risk (data model, permissions, money, migrations on existing data), major upgrades, tricky dependencies |

You never pick `Model: fable` with `auto`. For large and risky issues the architect already designs with fable
(complexity L and XL), and the developer implements that design with opus; `Model: fable` stays for a human who
escalates an issue the developer failed on. When in doubt, the stronger model. Effort and model are related but should not blindly run in step: a data
model in one file is `Effort: xhigh` and `Model: opus`; a translation issue is `Effort: low` and `Model: haiku`.

Epics get neither an effort nor a model label: they are not implemented.
