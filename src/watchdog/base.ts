import type { HistoryEntry } from '../history/history.ts';
import type { TrackerAdapter } from '../tracker/types.ts';
import type { BaseState } from './decide.ts';

/** Reads the head of a repository's base branch (`owner/name`; branch null = the default branch); null when unknown. */
export type BaseReader = (repo: string, branch: string | null) => Promise<Omit<BaseState, 'checks'> & { rollup: BaseState['checks'] } | null>;

interface GraphqlLike {
  request<T>(query: string, variables: Record<string, unknown>): Promise<{ data: T | null; errors: Array<{ message: string }> }>;
}

const COMMIT = 'target { ... on Commit { oid statusCheckRollup { state } } }';
const BRANCH_QUERY = `query WatchdogBaseBranch($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) { ref(qualifiedName: $ref) { name ${COMMIT} } }
}`;
const DEFAULT_QUERY = `query WatchdogDefaultBranch($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { defaultBranchRef { name ${COMMIT} } }
}`;

type Ref = { name?: unknown; target?: { oid?: unknown; statusCheckRollup?: { state?: unknown } | null } | null } | null | undefined;

/** GitHub's `StatusState` of the combined status and check runs, mapped. */
export function rollupChecks(state: unknown): BaseState['checks'] {
  if (state === 'SUCCESS') return 'passed';
  if (state === 'FAILURE' || state === 'ERROR') return 'failed';
  if (state === 'PENDING' || state === 'EXPECTED') return 'pending';
  return 'unknown';
}

/** A base reader over the tracker's GitHub GraphQL client; null for a tracker without one. */
export function githubBaseReader(adapter: TrackerAdapter): BaseReader | null {
  const client = (adapter as { client?: unknown }).client as GraphqlLike | undefined;
  if (client === undefined || typeof client?.request !== 'function') return null;
  return async (repo, branch) => {
    const [owner, name] = repo.split('/');
    if (owner === undefined || name === undefined || owner === '' || name === '') return null;
    const response =
      branch === null
        ? await client.request<{ repository?: { defaultBranchRef?: Ref } | null }>(DEFAULT_QUERY, { owner, name })
        : await client.request<{ repository?: { ref?: Ref } | null }>(BRANCH_QUERY, { owner, name, ref: `refs/heads/${branch}` });
    const repository = response.data?.repository as { ref?: Ref; defaultBranchRef?: Ref } | null | undefined;
    const ref = branch === null ? repository?.defaultBranchRef : repository?.ref;
    const sha = ref?.target?.oid;
    if (typeof sha !== 'string' || sha === '') {
      // Without a head nothing is re-checked: make a missing permission or a renamed branch visible in the log.
      if (response.errors.length > 0) throw new Error(response.errors.map((error) => error.message).join('; '));
      return null;
    }
    return { branch: typeof ref?.name === 'string' ? ref.name : (branch ?? 'default branch'), sha, rollup: rollupChecks(ref?.target?.statusCheckRollup?.state) };
  };
}

/** Symphony's newest entry checks (`checks_finished`) that ran on `sha`: failed when any failed, else passed; null without any. */
export function entryChecksOn(history: readonly HistoryEntry[], sha: string): 'passed' | 'failed' | null {
  const on = history.filter((entry) => entry.event === 'checks_finished' && entry.fields.sha === sha && entry.fields.result !== 'skipped');
  if (on.length === 0) return null;
  return on.some((entry) => entry.fields.ok === 'false') ? 'failed' : 'passed';
}

/** The base state with the best check signal: the commit's own status, else Symphony's entry checks on that commit. */
export function baseState(read: Awaited<ReturnType<BaseReader>>, history: readonly HistoryEntry[]): BaseState | null {
  if (read === null) return null;
  const checks = read.rollup !== 'unknown' ? read.rollup : (entryChecksOn(history, read.sha) ?? 'unknown');
  return { branch: read.branch, sha: read.sha, checks };
}
