# Concept: multi-agent pipeline

Epic #177 turned the single agent per issue into a pipeline of role-based stages whose transitions Symphony computes
itself. This page explains the architecture and the decisions behind it, then keeps the facts of the GitHub spike (#178)
that the implementation builds on. It links to the reference pages instead of repeating them: every setting is in
[configuration.md](../configuration.md), the result contracts and the `report_result` tool are in
[results.md](../results.md), operation is in [usage.md](../usage.md#the-lifecycle-of-an-issue).

## The problem

With one prompt and `set_status`, the agent decided when it was done and where the issue went next. That fails in ways
a prompt cannot fix: an agent can forget to hand off, move the issue to a column its checks never cleared, loop between
developer and reviewer without end, or write a review that nothing but a human can read. The pipeline moves these
decisions out of the agent:

- an agent reports **what it found** (a typed result with a verdict), never **where the issue goes**;
- Symphony computes the target column from the verdict, the workflow profile and the round counters;
- the result is stored on the issue itself, so any later stage, a restart or a human sees the same state.

## Architecture

```
            ┌────────────────────────── board (GitHub Project) ──────────────────────────┐
            │ Ready      In progress      Testing        Agent review        In review    │
            └──┬──────────────┬──────────────┬─────────────────┬──────────────────────────┘
          issue-analyst    developer     test-engineer       reviewer          (human)
          result: analysis result: impl.  result: test      result: review
               │               │              │                 │
               └─ report_result(verdict, summary, …) ───────────┘
                      │ 1 validate   2 route (resolver)   3 guard + entry check
                      │ 4 post comment with marker        5 move   6 labels
                      ▼
            issue comments: `<!-- symphony:result:v1 … -->` = the pipeline's state
```

**Roles and stages.** A [role](../configuration.md#roles) serves board columns; a stage is one session of a role in
one of its columns. A role with `result` names the kind of result it reports (`analysis`, `implementation`, `test`,
`review`, …) and gets the `report_result` tool instead of `set_status`
([agent-claude.md](../agent-claude.md#permission-and-safety-posture)). Roles without `result` (the auditor, the
autopilot, …) work as before; the pipeline is opt-in per role.

**The resolver.** `resolveTransition` (`src/orchestrator/transitions.ts`) is a pure function: role, verdict, round
counters, workflow profile and board order in, a target column and the label changes out. The rules and their order
(`blocked`, round limit, `on_result`) are in
[Result-driven transitions](../configuration.md#result-driven-transitions). The agent cannot influence the target, only
the verdict. A configuration that cannot route a verdict is rejected at dispatch preflight where possible and returns
`transition_error` otherwise.

**The transition guard.** Whatever computed the target, the move passes the same guard as a `set_status` call
([Transition guard](../configuration.md#transition-guard)): terminal columns are never allowed, the target must be in the
role's `may_move_to`, and a column with an entry check (`checks.on_enter`, e.g. lint, static analysis and tests before
`Agent review`) is entered only after the check passed. A failed check records nothing and costs no round.

**Results as state.** There is no database. Each stage result is posted as an issue comment whose hidden marker carries
the result and its meta (role, run, round, profile, workflow hash, head commit, entry check, target column). The
orchestrator rebuilds everything it needs from the issue's comments: the stage history, the round counters and the
column the last hand-off aimed at ([Comment and marker](../results.md#comment-and-marker)). The decision for comments
over a file or a custom field: the history is visible to humans on the issue, survives a restart or a lost workspace,
and costs one paginated read (1 GraphQL point per 100 comments, see the spike below).

**Round counters.** The review loop (`changes_needed`) and the test loop (`failed`) count rounds from the persisted
results since the last `reset`. At `pipeline.max_review_rounds` (default 3) or `pipeline.max_test_rounds` (default 2) the
issue goes to the role's `on_round_limit` (else the blocked column) and gets the `needs-human` label instead of looping
again. Counting from the history, not from memory, keeps the limit right across restarts, retries and continuation
sessions. A human who moves the issue back to an active column writes the `reset`: the labels and counters start over
([Rounds, limits and manual resume](../usage.md#rounds-limits-and-manual-resume)).

**Profiles.** `pipeline.profiles` lets bugfix, feature and refactor issues walk different stage sequences with the same
roles: a profile skips roles, overrides `on_result` and the round limits
([Workflow profiles](../configuration.md#workflow-profiles)). The issue type comes from its `Type:` label, which the
analyst sets where a human has not. A skipped stage passes the issue on **without a session**: Symphony posts a
`skipped` result and moves the issue, so an unneeded stage costs one comment and no agent
([Skipping stages](../configuration.md#skipping-stages-without-a-session)).

**Recovery.** The comment and the move are two GitHub calls, and Symphony may crash between them. The marker records the
`target`; the next dispatch compares it with the issue's current column and the time the column last changed and, if the
move is simply missing, completes it without a session, through the same guard. A human move in between always wins;
recovery never undoes a move ([Interrupted transitions](../results.md#interrupted-transitions)). A session that ends
without a result gets one reminder turn and then moves to `on_missing_result` (`Blocked` by default)
([Stages without a result](../results.md#stages-without-a-result)).

**Cost.** The pipeline adds sessions, so its budgets are layered: `claude.max_budget_usd` per session,
`agent.max_continuations` for the number of sessions in a row (every role switch counts), `agent.max_issue_cost_usd` for
the sum over all stages of an issue, and the round limits for loops. Read-only stages (analyst, reviewer) can use a
cheaper model or a smaller `max_turns`; `model_label: ignore` keeps an issue's `Model:` label, meant for the developer,
from changing their model. The round limits are about progress, the budgets about money; both end with a human decision,
and only the round limit sets `needs-human`
([Continuations and pausing](../usage.md#continuations-and-pausing)).

## Decisions

| Decision | Why | Alternative not taken |
|---|---|---|
| Transitions are computed from verdicts | The agent cannot skip a stage, bypass a loop limit or pick a column; configuration decides | Agent calls `set_status` and a prompt asks it to be careful |
| One result per run, written by Symphony | A run ends with exactly one recorded outcome; repeated calls return the stored one, so retries cannot count a round twice | Several partial reports per session |
| State lives in comment markers | Visible on the issue, no extra store to migrate or lose; the state survives a restart and a lost workspace | A local database or a hidden project field |
| Round counters come from history and reset on a human move | Limits survive restarts; a human decision is explicit and visible (`reset` marker) | In-memory counters; a counter field the human must edit |
| Marker author = the token's account | Agents and other accounts cannot forge a stage result (see below) | An HMAC with a secret only Symphony knows |
| Entry checks gate the move, not the report | A failing check keeps the agent in its session to fix the problem; nothing is recorded, no round is spent | Record first, check later |
| Skip without a session | A stage that is not needed should cost nothing, not a session that says "nothing to do" | Run the role with a "skip" prompt |
| Read-only roles fall back with `on_check_failed` | A reviewer cannot repair a red suite; the issue goes back to the developer with the output | Block the issue for a human |

### Forgery protection and the bot account

Two rules keep a stage result from being forged ([SECURITY.md](../../SECURITY.md#stage-result-markers)): `add_comment`
and `create_sub_issue` reject text containing `<!-- symphony:`, and a marker counts only in a comment written by the
account of the token (`viewerLogin()`). The spike showed (point 4 below) that with a personal token Symphony acts as the
operator, so a human comment from the same account also carries trusted markers and the author filter protects only
against agents and other accounts. The decision was to rely on the author, not on an HMAC, and to **recommend a
separate account** (a machine user or a GitHub App token) instead of a personal token. See
[Marker protection and the bot account](../adapters/github-project.md#stage-result-markers-and-the-bot-account).

### What the pipeline does not do

- It does not decide on `Done`: only a human merges and closes, as before.
- It does not detect *who* moved an issue. Symphony's moves carry the token owner's name like a human's, so it compares
  timestamps and target columns instead of actors.
- The stages of phase 4 (design, security, docs) are not part of this page; each documents its own keys.

## Spike results

Spike #178, measured on 2026-10-18 with a classic token (`repo`, `project`). Read queries ran against board 12 and
`cooolinho/symphony`; mutations ran against a private throwaway repository and board that were deleted afterwards.

Rate-limit cost is the `rateLimit { cost }` of the query (GraphQL points, 5,000 per hour). Mutations cannot select
`rateLimit`, and the `used` counter did not move measurably around them; per GitHub's docs a mutation costs 1 primary
point and 5 points against the secondary per-minute limit. The adapter never retries mutations.

| # | Question | Answer | Verified | Cost |
|---|---|---|---|---|
| 1 | Paginated comments with author and timestamp | yes | live | 1 per page |
| 2 | `viewer { login }` of the token's account | yes | live | 1 |
| 3 | Add, remove and create labels | yes | live | 1 per mutation |
| 4 | `updatedAt` of the Status value | yes, plus status-change events with actor | live | 1 |
| 5 | Create board columns (Status options) | yes, but only by rewriting the whole option list | live | 1 |
| 6 | Token scopes | `repo` + `project` | live | – |

### 1. Paginated comments

```graphql
query SymphonyIssueComments($issueId: ID!, $after: String) {
  node(id: $issueId) {
    ... on Issue {
      comments(first: 100, after: $after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { author { login } createdAt url body }
      }
    }
  }
}
```

- Cursor pagination works (issue #208, page size 3: three pages, `hasNextPage` false on the last one).
- `first: 100` is the maximum; `first: 101` fails with `EXCESSIVE_PAGINATION`, so the page size is 100.
- `author` is `null` for deleted accounts ("ghost"); the reader must allow that.
- Cost: 1 point per page, so 250 comments cost 3 points.

### 2. Token account

```graphql
query SymphonyViewer { viewer { login } }
```

Returns `cooolinho` (`__typename: User`), cost 1. It is constant per token, so cache it per adapter.

### 3. Labels

```graphql
mutation SymphonyCreateLabel($repositoryId: ID!, $name: String!, $color: String!, $description: String) {
  createLabel(input: { repositoryId: $repositoryId, name: $name, color: $color, description: $description }) {
    label { id name }
  }
}

mutation SymphonyAddLabels($labelableId: ID!, $labelIds: [ID!]!) {
  addLabelsToLabelable(input: { labelableId: $labelableId, labelIds: $labelIds }) { clientMutationId }
}

mutation SymphonyRemoveLabels($labelableId: ID!, $labelIds: [ID!]!) {
  removeLabelsFromLabelable(input: { labelableId: $labelableId, labelIds: $labelIds }) { clientMutationId }
}
```

- Live: `createLabel` created a missing `Type: bug`, `addLabelsToLabelable` added it, `removeLabelsFromLabelable`
  removed it again; each mutation returns the resulting label list.
- All three exist and are not deprecated. Both mutations take label **ids**, so the adapter looks the ids up first
  (`repository { labels(first: 100) { nodes { id name } } }`, or the issue's `labels`).
- `addLabelsToLabelable` also has a `labels` input (`LabelUpdateInput`: `labelId`, `rationale`, `suggest`,
  `confidence`). It is mutually exclusive with `labelIds` and still needs ids; `suggest` only stores a suggestion.
  Use `labelIds`.
- `repo-init` already creates labels through REST (`src/repo-init/github-rest.ts`, `createLabel`); either way works.

### 4. Detecting manual status changes

```graphql
query SymphonyStatusHistory($issueId: ID!) {
  node(id: $issueId) {
    ... on Issue {
      projectItems(first: 10) {
        nodes {
          project { number }
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name optionId updatedAt }
          }
        }
      }
      timelineItems(last: 20, itemTypes: [PROJECT_V2_ITEM_STATUS_CHANGED_EVENT]) {
        nodes {
          ... on ProjectV2ItemStatusChangedEvent {
            actor { login } wasAutomated createdAt previousStatus status project { number }
          }
        }
      }
    }
  }
}
```

- `ProjectV2ItemFieldSingleSelectValue.updatedAt` exists (issue #178: Status `Backlog`, `updatedAt`
  `2026-10-17T23:27:56Z`, which matches the last move). Live on the throwaway board: a move Todo → In Progress
  changed `updatedAt` from `01:13:53Z` to `01:14:04Z` while `createdAt` stayed; the item's own `updatedAt` moved too. `creator` is whoever set the **first** value
  (`github-project-automation`), not the last mover, so it is useless here.
- Better: the issue timeline has `ProjectV2ItemStatusChangedEvent` with `previousStatus`, `status`, `actor`,
  `createdAt` and `wasAutomated`. For #178 it shows the whole history (automation → Backlog, Backlog → Ready,
  Ready → Blocked, Blocked → Backlog). Cost 1. The event's `createdAt` lags the field's `updatedAt` by about two
  seconds (`01:14:06Z` vs `01:14:04Z`), so compare with a tolerance, not for equality.
- **Caveat: the actor does not tell Symphony and a human apart.** The move Ready → Blocked was made by the agent
  (one second after its comment), yet it shows `actor: cooolinho`, `wasAutomated: false`, exactly like the human's
  moves. With a personal token Symphony acts as the human. Consequences:
  - Pending-transition recovery (#210) cannot rely on the actor. As built, it compares the recorded `target` of the
    newest result with the issue's current column and the Status field's `updatedAt` (`native_ref.status_updated_at`)
    with the result comment's time: another column, or a column change after the comment, counts as a human move and
    is never "recovered" (see [Interrupted transitions](../results.md#interrupted-transitions)). The timeline events
    of this spike are not used.
  - Forgery protection (#183) cannot rely on "author = `viewer`" alone while Symphony uses the operator's own
    account: the operator's hand-written comments have the same author. As built, a marker counts only in a comment
    of the token's account and the agent tools refuse `<!-- symphony:`; the recommendation is to run Symphony with
    its own account (a machine user or a GitHub App token). An HMAC was considered and not built
    (see [Forgery protection and the bot account](#forgery-protection-and-the-bot-account)).

### 5. Creating board columns

```graphql
mutation SymphonyUpdateStatusOptions($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
  updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) {
    projectV2Field { ... on ProjectV2SingleSelectField { options { id name } } }
  }
}
```

- Live: sending the three existing options (with `id`) plus `Testing` kept the three ids, added `Testing` with a new
  id, and an item in the first column kept its status.
- Possible, but `singleSelectOptions` **replaces** the whole list ("provided values overwrite existing options").
  To add a column, `repo-init` reads the current options and sends all of them back **with their `id`** plus the
  new one. An option sent without its `id` gets a new identity, and every item in that column loses its status.
- `ProjectV2SingleSelectFieldOptionInput` needs `name`, `color` (enum, e.g. `PURPLE`) and `description` (non-null,
  may be empty); `id` is optional.
- Risk: a mistake empties the Status column of every issue on the board. `repo-init` should only add, never rename
  or reorder, and show the change before applying it.

### 6. Token scopes

Classic token:

- `repo` (`public_repo` for public repositories only): reading issues and comments, posting comments, labels.
  `X-Accepted-OAuth-Scopes: repo` on the comment query.
- `project`: moving issues and changing Status options. `read:project` is enough for questions 1, 2 and 4 only.
- `viewer` needs no scope.

This is the same set `docs/adapters/github-project.md` already documents, so the pipeline needs no new scope.

