# Concept: multi-agent pipeline

The goal, target architecture and plan live in epic #177. This file collects the facts the implementation builds on.

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
  - Pending-transition recovery (#210) cannot rely on the actor. It compares the latest status event (or
    `updatedAt`) with the transition Symphony recorded itself: same target column and an event after the record
    → transition done; another column or a later event → a human moved the issue.
  - Forgery protection (#183) cannot rely on "author = `viewer`" alone while Symphony uses the operator's own
    account: the operator's hand-written comments have the same author. Either run Symphony with its own account
    (a machine user or a GitHub App token), or make the marker itself unforgeable (e.g. an HMAC with a secret only
    Symphony knows).

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

