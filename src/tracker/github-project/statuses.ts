import { TrackerError, type CheckStatus } from '../types.ts';

/** The REST API base for a GraphQL endpoint: api.github.com, or `<host>/api/v3` on GitHub Enterprise Server. */
export function restBase(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.hostname === 'api.github.com') return 'https://api.github.com';
  return `${url.origin}${url.pathname.replace(/\/graphql\/?$/, '/v3')}`;
}

/** GitHub caps a status description at 140 characters. */
const DESCRIPTION_LIMIT = 140;

/**
 * Sets the commit status `symphony/<name>` on `sha` (REST `POST /repos/{repo}/statuses/{sha}`; GraphQL has no
 * mutation for it). Needs the token scope `repo` (classic) or "Commit statuses: write" (fine-grained).
 */
export async function postCommitStatus(
  options: { fetch: typeof fetch; endpoint: string; token: string; timeoutMs: number },
  repository: string,
  status: CheckStatus,
): Promise<void> {
  const response = await options.fetch(`${restBase(options.endpoint)}/repos/${repository}/statuses/${status.sha}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      state: status.state,
      context: `symphony/${status.name}`,
      description: status.description.slice(0, DESCRIPTION_LIMIT),
      ...(status.targetUrl !== null ? { target_url: status.targetUrl } : {}),
    }),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new TrackerError('tracker_request', `commit status symphony/${status.name} on ${repository}@${status.sha.slice(0, 7)}: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
}
