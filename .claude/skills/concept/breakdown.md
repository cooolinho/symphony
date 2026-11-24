# Breakdown: epics, issues, dependencies, labels

A good plan is complete with respect to the concept, every issue is mergeable on its own, and the order follows from
the dependencies, not from the numbering.

## Epics

- An epic is a **functionally coherent area of the concept that can be delivered on its own** ("user management",
  "invoices"), not a technical layer ("database", "frontend").
- An epic has **2 to 10 issues**. A single issue belongs in another epic; more than 10 issues are two epics.
- A foundation epic (roles, tenants, base layout) only if the concept requires it and several areas build on it. It
  comes first.
- Title: `(E<n>) Epic: <area>`, with the key from [SKILL.md](SKILL.md#phase-4-order-and-labels). The text summarises the goal of the area and refers to the concept section. It **never**
  contains "blocked by #N" (not even negated) and never `/` commands at the start; references to other epics you write
  as "builds on #N".

## Issues

- **Mergeable on its own**: one pull request a human can review at leisure. Size S (one file or a few lines) or M
  (a few files, one area). Split L.
- **Vertical slice instead of layer**: "create invoice" (migration, model, resource, policy, test) instead of "all
  migrations". Tests belong in the issue that changes the code, not in a test issue of their own.
- Every issue has **verifiable acceptance criteria** (for permissions: who may, who may not), says which tests it
  needs, names the **concept section** and says what does **not** belong to it.
- **Design issues** (the planner never sees the rendered page; the developer checks it with screenshots): concrete criteria with Filament component, columns, filters,
  actions, texts, empty and error states and which role sees what. Never "make it nicer". A visual issue demands "Screenshots" (pages or panels, viewports, demo login, `docs/screenshots/`). Screenshots or a visual check are impossible only for a concrete reason from the repository, cited as file:line (no web interface, an external service or login without a local substitute, a stack that does not run with SQLite and `php -S`); "needs a running app", "no browser" and "no frontend build" are no reasons.
- **Mockups and screenshots** the concept names for this issue are embedded in it as images
  ([rules](#mockups-and-screenshots)). The criteria still say in words what is binding: the image shows, the criteria
  decide.
- Anything unclear stays a **question in the report**, not an issue. That also applies to decisions a human has to
  make: legal matters, prices, texts with legal effect, external services that cost money.
- Title: `(E<n>-<m>) <Feature|Design|Quality|Maintenance>: <what changes>`, short and unambiguous. The title is the
  key against duplicates and must be unique within an epic.
- A major upgrade (Laravel, Filament, PHP) stands alone in its epic and additionally gets `manual-merge`.
- A pure refactoring without behaviour change starts with `/refactor-safely` on the first line (dependencies go below
  it). If the area lacks tests, it waits for an issue that writes them.

## Mockups and screenshots

The concept's mockups and screenshots are part of the requirements. The planner and the developer only work from what the
issue contains, so the pictures belong **in the issues, as images**, not as a file name in the text.

- **Which images:** those the concept (and the files it links) embeds or names, and that lie in the repository as PNG,
  JPG, JPEG, WebP or GIF. You never create, copy, move or convert images; you only link what is there.
- **Where:** an image goes into every issue that implements what it shows. An overview image that spans several issues
  of one epic goes into the epic and also into each issue that needs it. One screen per image is
  the normal case. More than four images in one issue are a sign that it is cut too big: split it.
- **How:** Markdown image with a meaningful alt text (screen, viewport, state), then one line with the repository path
  and the concept section, so the developer can open the file with the Read tool (Symphony downloads only files
  uploaded to the issue, not repository files). The link is built from the host, owner and repository of the issue and the
  full commit hash of the concept ([SKILL.md](SKILL.md#phase-1-read-the-concept)); format in [templates.md](templates.md#sub-issue).
- **Acceptance criteria:** an issue with an image has at least one criterion that ties the result to it (layout, order,
  labels, texts, states shown) and, for a visual issue, the "Screenshots" demand from above, so the developer compares the
  result with the mockup. Where the image and the concept text contradict each other, that is a question in the report; the
  issue names the contradiction instead of choosing silently.
- **Not embeddable:** HTML mockups, PDFs, SVGs, Figma links and images on other sites. The issue names them as text with their
  path or link and says that the developer cannot open them, and the report asks for a PNG export.
- **Missing:** a file the concept names that is not on the base commit is an open question, never a made-up image.

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

Per issue exactly **one** category; **one** effort label only with `issue-efforts=auto`, **one** model label only with
an `issue-models` value other than `off`.

**Category**

| Label | When |
|---|---|
| `feature` | new or completed feature from the concept |
| `design` | UI and usability |
| `quality` | tests, refactoring, performance, security |
| `maintenance` | dependencies, upgrades, tooling |

**Effort** (only with `issue-efforts=auto`; how much thinking goes into it; size S/M and risk):

| Label | When |
|---|---|
| `Effort: low` | texts, translations, configuration, one line |
| `Effort: medium` | size S |
| `Effort: high` | size M, the normal case; also high risk: data model, permissions, money or billing, migration of existing data, tricky dependencies |

You never assign `Effort: xhigh` or `Effort: max` on your own: they cost about twice as much per step and a human
sets them for a single issue that needs more room. If you lack a yardstick, take `Effort: high`.

**Model** (`issue-models=auto`; with `fable`, `opus`, `sonnet`, `haiku` all issues get the same label):

| Label | When |
|---|---|
| `Model: haiku` | size S **and** low risk: texts, translations, configuration, small changes in one area, simple tests |
| `Model: sonnet` | the normal case: size S with medium risk, size M with low or medium risk (new feature in a few files, design issues, tests) |
| `Model: opus` | size M across several areas, wide reach with medium risk, complex issues: high risk (data model, permissions, money, migrations on existing data), major upgrades, tricky dependencies |

You never pick `Model: fable` with `auto`. For large and risky issues the architect already designs with fable
(complexity L and XL), and the developer implements that design with opus; `Model: fable` stays for a human who
escalates an issue the developer failed on. When in doubt, the stronger model. Effort and model are related but should not blindly run in step: a data
model in one file is `Effort: high` and `Model: opus`; a translation issue is `Effort: low` and `Model: haiku`.

Epics get neither an effort nor a model label: they are not implemented.
