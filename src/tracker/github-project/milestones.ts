import { TrackerError } from '../types.ts';
import { assertNoGraphqlErrors, type GithubGraphqlClient } from './client.ts';
import { MILESTONES_QUERY } from './queries.ts';
import { restBase } from './statuses.ts';

export interface MilestoneRef {
  id: string;
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED';
  url: string;
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function toRef(node: Json | null): MilestoneRef | null {
  if (node === null || typeof node.number !== 'number' || typeof node.title !== 'string') return null;
  return {
    id: String(node.id ?? node.node_id ?? ''),
    number: node.number,
    title: node.title,
    state: String(node.state).toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN',
    url: String(node.url ?? node.html_url ?? ''),
  };
}

/** Milestones of `repository` in the given states, newest first (at most 100). `query` narrows by title. */
export async function findMilestones(
  client: Pick<GithubGraphqlClient, 'request'>,
  repository: string,
  options: { states: Array<'OPEN' | 'CLOSED'>; query?: string },
): Promise<MilestoneRef[]> {
  const [owner, name] = repository.split('/');
  const response = await client.request<Json>(MILESTONES_QUERY, {
    owner,
    name,
    states: options.states,
    ...(options.query ? { query: options.query } : {}),
  });
  assertNoGraphqlErrors(response.errors);
  const list = obj(obj(obj(response.data)?.repository)?.milestones)?.nodes;
  if (!Array.isArray(list)) return [];
  return list.map((node) => toRef(obj(node))).filter((ref): ref is MilestoneRef => ref !== null);
}

/**
 * Creates a milestone (REST `POST /repos/{repo}/milestones`; GraphQL has no mutation for it). Needs the token scope
 * `repo` (classic) or "Issues: write" (fine-grained). Returns 'exists' when GitHub answers 422 already_exists.
 */
export async function createMilestone(
  options: { fetch: typeof fetch; endpoint: string; token: string; timeoutMs: number },
  repository: string,
  title: string,
): Promise<MilestoneRef | 'exists'> {
  const response = await options.fetch(`${restBase(options.endpoint)}/repos/${repository}/milestones`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const text = await response.text().catch(() => '');
  if (response.status === 422 && text.includes('already_exists')) return 'exists';
  if (!response.ok) {
    throw new TrackerError('tracker_status', `milestone "${title}" in ${repository}: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  let parsed: Json | null = null;
  try {
    parsed = obj(JSON.parse(text));
  } catch {
    parsed = null;
  }
  const ref = toRef(parsed);
  if (ref === null) throw new TrackerError('tracker_status', `milestone "${title}" in ${repository}: unexpected response`);
  return ref;
}
