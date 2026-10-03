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
            subIssues(first: 50) { nodes { number title state repository { nameWithOwner } } }
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
