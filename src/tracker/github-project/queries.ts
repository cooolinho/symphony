/** GraphQL documents for the GitHub Projects (v2) adapter. Field names verified against the live schema. */

export const PROJECT_META_QUERY = /* GraphQL */ `
  query SymphonyProjectMeta($owner: String!, $number: Int!, $statusField: String!, $priorityField: String!, $withPriority: Boolean!) {
    repositoryOwner(login: $owner) {
      __typename
      ... on ProjectV2Owner {
        projectV2(number: $number) {
          id
          title
          url
          closed
          statusField: field(name: $statusField) {
            __typename
            ... on ProjectV2SingleSelectField { id name options { id name } }
          }
          priorityField: field(name: $priorityField) @include(if: $withPriority) {
            __typename
            ... on ProjectV2SingleSelectField { id name options { id name } }
            ... on ProjectV2Field { id name dataType }
          }
        }
      }
    }
  }
`;

/** Cheap pass over the board (no nested connections): just enough to pick candidates. */
export const PROJECT_ITEMS_QUERY = /* GraphQL */ `
  query SymphonyProjectItems($projectId: ID!, $after: String, $statusField: String!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        items(first: 100, after: $after, archivedStates: [NOT_ARCHIVED]) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isArchived
            status: fieldValueByName(name: $statusField) {
              ... on ProjectV2ItemFieldSingleSelectValue { name optionId }
            }
            content {
              __typename
              ... on Issue { repository { nameWithOwner } }
            }
          }
        }
      }
    }
  }
`;

/** Full snapshots for specific project items (candidate details and ID refresh). */
export const ITEM_DETAILS_QUERY = /* GraphQL */ `
  query SymphonyItemDetails($ids: [ID!]!, $statusField: String!, $priorityField: String!, $withPriority: Boolean!) {
    nodes(ids: $ids) {
      __typename
      ... on ProjectV2Item {
        id
        isArchived
        project { id }
        status: fieldValueByName(name: $statusField) {
          ... on ProjectV2ItemFieldSingleSelectValue { name optionId }
        }
        priority: fieldValueByName(name: $priorityField) @include(if: $withPriority) {
          __typename
          ... on ProjectV2ItemFieldSingleSelectValue { name optionId }
          ... on ProjectV2ItemFieldNumberValue { number }
        }
        content {
          __typename
          ... on Issue {
            id
            number
            title
            body
            url
            state
            createdAt
            updatedAt
            repository { nameWithOwner }
            labels(first: 100) { nodes { name } }
            assignees(first: 20) { nodes { login } }
            linkedBranches(first: 1) { nodes { ref { name } } }
            blockedBy(first: 50) { nodes { id number state repository { nameWithOwner } } }
            parent { number title state repository { nameWithOwner } }
            subIssues(first: 100) { nodes { number title state stateReason repository { nameWithOwner } } }
          }
        }
      }
    }
  }
`;

/**
 * States of issues or pull requests referenced in issue text ("blocked by #12"), one alias per
 * reference. Numbers are validated integers; owner and name travel as variables.
 */
export function referenceStatesQuery(references: Array<{ repository: string; number: number }>): {
  query: string;
  variables: Record<string, string>;
} {
  const variables: Record<string, string> = {};
  const params: string[] = [];
  const fields: string[] = [];
  references.forEach((reference, index) => {
    const [owner, name] = reference.repository.split('/');
    if (!Number.isSafeInteger(reference.number)) throw new Error(`invalid issue number ${reference.number}`);
    variables[`o${index}`] = owner ?? '';
    variables[`n${index}`] = name ?? '';
    params.push(`$o${index}: String!`, `$n${index}: String!`);
    fields.push(
      `ref${index}: repository(owner: $o${index}, name: $n${index}) { issueOrPullRequest(number: ${reference.number}) { ` +
        '__typename ... on Issue { id number state } ... on PullRequest { id number state } } }',
    );
  });
  return { query: `query SymphonyReferences(${params.join(', ')}) {\n  ${fields.join('\n  ')}\n}`, variables };
}

export const ISSUE_CONTEXT_QUERY = /* GraphQL */ `
  query SymphonyIssueContext($issueId: ID!) {
    node(id: $issueId) {
      ... on Issue {
        comments(last: 20) {
          totalCount
          nodes { author { login } createdAt url body }
        }
        closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {
          nodes { number url state title headRefName }
        }
      }
    }
  }
`;

export const REPOSITORY_QUERY = /* GraphQL */ `
  query SymphonyRepository($owner: String!, $name: String!, $head: String!) {
    repository(owner: $owner, name: $name) {
      id
      defaultBranchRef { name }
      pullRequests(headRefName: $head, states: [OPEN], first: 1) {
        nodes { number url title baseRefName headRefName isDraft }
      }
    }
  }
`;

export const SET_STATUS_MUTATION = /* GraphQL */ `
  mutation SymphonySetStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(
      input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }
    ) {
      projectV2Item { id }
    }
  }
`;

export const ADD_COMMENT_MUTATION = /* GraphQL */ `
  mutation SymphonyAddComment($subjectId: ID!, $body: String!) {
    addComment(input: { subjectId: $subjectId, body: $body }) {
      commentEdge { node { url } }
    }
  }
`;

export const CREATE_PULL_REQUEST_MUTATION = /* GraphQL */ `
  mutation SymphonyCreatePullRequest($repositoryId: ID!, $base: String!, $head: String!, $title: String!, $body: String, $draft: Boolean) {
    createPullRequest(
      input: { repositoryId: $repositoryId, baseRefName: $base, headRefName: $head, title: $title, body: $body, draft: $draft }
    ) {
      pullRequest { number url title isDraft }
    }
  }
`;

/** The issue's repository and its sub-issues (at most 100 on GitHub) with their items on any project board. */
export const SUB_ISSUE_CONTEXT_QUERY = /* GraphQL */ `
  query SymphonySubIssueContext($issueId: ID!) {
    node(id: $issueId) {
      ... on Issue {
        repository { id nameWithOwner }
        subIssues(first: 100) {
          nodes { id number title state url projectItems(first: 20) { nodes { id project { id } } } }
        }
      }
    }
  }
`;

/**
 * The ids of labels by name, one alias per name (`l0`, `l1`, …); a label that does not exist comes back as null.
 * Owner, repository and names travel as variables.
 */
export function repositoryLabelsQuery(repository: string, names: string[]): { query: string; variables: Record<string, string> } {
  const [owner, name] = repository.split('/');
  const variables: Record<string, string> = { owner: owner ?? '', name: name ?? '' };
  const params = ['$owner: String!', '$name: String!'];
  const fields = names.map((label, index) => {
    variables[`l${index}`] = label;
    params.push(`$l${index}: String!`);
    return `l${index}: label(name: $l${index}) { id name }`;
  });
  return { query: `query SymphonyLabels(${params.join(', ')}) {\n  repository(owner: $owner, name: $name) {\n    ${fields.join('\n    ')}\n  }\n}`, variables };
}

/** Creates an issue and links it as a sub-issue of `parentId` in one step. */
export const CREATE_SUB_ISSUE_MUTATION = /* GraphQL */ `
  mutation SymphonyCreateSubIssue($repositoryId: ID!, $parentId: ID!, $title: String!, $body: String, $labelIds: [ID!]) {
    createIssue(input: { repositoryId: $repositoryId, parentIssueId: $parentId, title: $title, body: $body, labelIds: $labelIds }) {
      issue { id number url }
    }
  }
`;

export const ADD_PROJECT_ITEM_MUTATION = /* GraphQL */ `
  mutation SymphonyAddProjectItem($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
      item { id }
    }
  }
`;

/**
 * What `auto_merge` needs to decide: the default branch, the issue's labels and the open pull request from the issue's
 * branch into the base branch.
 */
export const MERGE_CANDIDATE_QUERY = /* GraphQL */ `
  query SymphonyMergeCandidate($owner: String!, $name: String!, $number: Int!, $head: String!, $base: String!) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef { name }
      issue(number: $number) { labels(first: 50) { nodes { name } } }
      pullRequests(headRefName: $head, baseRefName: $base, states: [OPEN], first: 1) {
        nodes { id number url title isDraft headRefOid mergeable labels(first: 50) { nodes { name } } }
      }
    }
  }
`;

/** Merges only the head that was read (`expectedHeadOid`), so a later push is never merged unchecked. */
export const MERGE_PULL_REQUEST_MUTATION = /* GraphQL */ `
  mutation SymphonyMergePullRequest($pullRequestId: ID!, $expectedHeadOid: GitObjectID!, $method: PullRequestMergeMethod!, $headline: String) {
    mergePullRequest(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid, mergeMethod: $method, commitHeadline: $headline }) {
      pullRequest { number merged }
    }
  }
`;

/** GitHub closes issues named by "Closes #N" only for merges into the default branch, so `auto_merge` closes them. */
export const CLOSE_ISSUE_MUTATION = /* GraphQL */ `
  mutation SymphonyCloseIssue($issueId: ID!) {
    closeIssue(input: { issueId: $issueId, stateReason: COMPLETED }) {
      issue { number state }
    }
  }
`;
