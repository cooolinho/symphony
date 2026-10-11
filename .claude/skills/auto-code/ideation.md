# Finding and rating ideas

The goal is a project that comes closer to its description, not a project with as many features as possible. A good
wave is small, backed by evidence and mergeable.

## Categories

| Label | Content | Examples |
|---|---|---|
| `feature` | New or completed feature from the project description or roadmap | export of a list, missing approval step, notification |
| `design` | User interface and usability | dashboard widget, clearer forms, empty states, consistent tables |
| `quality` | Bugs, missing tests, refactoring, performance, security | fix an N+1, add a policy, tests for an untested flow |
| `maintenance` | Dependencies, upgrades, tooling | minor updates, replace a deprecated API, deprecations |

## Rating

Every idea gets three values:

| | high | medium | low |
|---|---|---|---|
| **Value** | closes a gap to the goal of the project description or an open request | noticeably improves a frequently used flow | nice, but rarely needed |
| **Risk** | data model, permissions, money or billing, migrations on existing data | several areas, new dependency | one area, easy to test |

**Effort:** S (one file or a few lines) · M (a few files, one pull request) · L (split, never as a whole).

Selection: high value before medium. With equal value, lower risk wins, then lower effort. Ideas with low value only go
into the idea backlog.

## Mixing rules

1. Requests from humans and open roadmap items take precedence over your own ideas.
2. At most **one** `maintenance` issue per wave. A major upgrade stands alone in its wave and carries `manual-merge`.
3. Every **third** wave (3, 6, 9 …) contains at least one `quality` issue. With a red baseline the whole wave consists
   of `quality` issues.
4. **Design lock:** An area (a resource, a page, a panel) that had a `design` issue in the last three waves gets no
   further one. This prevents the same interface from being rebuilt over and over.
5. At most one issue with risk "high" per wave. Migrations on existing data need a reversible `down()` and tests.

## Guardrails against drift

- **Evidence required.** Every idea names the section of the project description it advances and the place in the code
  it starts from. If either is missing, it is not created.
- **Non-goals and taboos** from the guardrails apply absolutely, as do rejected sub-issues (`NOT_PLANNED`), even
  worded differently.
- **No new dependencies** (Composer, npm) without a clear reason. You state the reason in the issue.
- **No cross-cutting rebuilds** (different framework, new architecture, renames across the whole project). Such ideas
  belong in the checkpoint report as a question for the human.
- **No substitute for decisions**: legal matters, prices, texts with legal effect and external services with costs
  you suggest in the report, but do not create as an issue.
- **Better to pause than to fill.** If no idea meets the criteria, a pause (Phase 7) is the right result.

## Design issues

The agent cannot see the interface. Therefore for `design`:

- Concrete, verifiable criteria: which Filament component, which columns, filters, actions, texts, empty and error
  states, which role sees what.
- Use the project's existing building blocks (Filament components, theme, existing patterns), no custom CSS solutions
  where Filament can do it.
- A feature or Livewire test that proves the result (page renders, action visible for role X, not for Y).
- Follow the design principles from the guardrails. If there are none, consistency with the existing interface and
  accessibility (labels, contrast, keyboard operation) apply.
