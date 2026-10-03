import { errorMessage } from '../../util/errors.ts';
import { oneLine, truncate } from '../../util/text.ts';
import { TrackerError } from '../types.ts';

export interface GraphqlError {
  message: string;
  type?: string;
  path?: Array<string | number>;
}

export interface GraphqlResponse<T> {
  data: T | null;
  errors: GraphqlError[];
}

export interface GraphqlClientOptions {
  endpoint: string;
  token: string;
  timeoutMs: number;
  /** Extra attempts for queries after transient failures (network, timeout, HTTP 502/503/504). */
  retries?: number;
  /** Delay before retry n (1-based) in ms; defaults to n seconds. */
  retryDelayMs?: (retry: number) => number;
  fetch?: typeof fetch;
}

const USER_AGENT = 'symphony-orchestrator/0.1';
const TRANSIENT_STATUS = new Set([502, 503, 504]);

function isTransient(error: unknown): boolean {
  if (!(error instanceof TrackerError)) return false;
  return error.category === 'tracker_request' || (error.category === 'tracker_status' && TRANSIENT_STATUS.has(error.status ?? 0));
}

/**
 * Minimal GitHub GraphQL client. Transport, HTTP status and rate-limit failures become
 * TrackerErrors here; GraphQL `errors` are returned so callers can tolerate NOT_FOUND entries.
 */
export class GithubGraphqlClient {
  #options: GraphqlClientOptions;
  #fetch: typeof fetch;

  constructor(options: GraphqlClientOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
  }

  /**
   * Sends one GraphQL document. Queries are retried after transient failures; mutations are not,
   * because a request that timed out may still have been applied (no duplicate comments or PRs).
   */
  async request<T>(query: string, variables: Record<string, unknown>): Promise<GraphqlResponse<T>> {
    const retries = /^\s*mutation\b/.test(query) ? 0 : (this.#options.retries ?? 2);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#send<T>(query, variables);
      } catch (error) {
        if (attempt >= retries || !isTransient(error)) throw error;
        const delay = this.#options.retryDelayMs?.(attempt + 1) ?? (attempt + 1) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async #send<T>(query: string, variables: Record<string, unknown>): Promise<GraphqlResponse<T>> {
    let response: Response;
    try {
      response = await this.#fetch(this.#options.endpoint, {
        method: 'POST',
        headers: {
          authorization: `bearer ${this.#options.token}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.#options.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new TrackerError(
        'tracker_request',
        timedOut ? `GitHub request timed out after ${this.#options.timeoutMs}ms` : `GitHub request failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    const text = await response.text().catch(() => '');
    if (!response.ok) throw httpError(response, text);

    let body: { data?: T | null; errors?: GraphqlError[] };
    try {
      body = JSON.parse(text) as typeof body;
    } catch (error) {
      throw new TrackerError('tracker_response', `GitHub returned a non-JSON response: ${truncate(oneLine(text), 200)}`, {
        cause: error,
        status: response.status,
      });
    }

    const errors = Array.isArray(body.errors) ? body.errors : [];
    const rateLimited = errors.find((e) => e.type === 'RATE_LIMITED');
    if (rateLimited) {
      throw new TrackerError('tracker_rate_limited', `GitHub rate limit: ${rateLimited.message}`, {
        retryAfterMs: resetDelayMs(response.headers),
      });
    }
    const scopes = errors.find((e) => e.type === 'INSUFFICIENT_SCOPES');
    if (scopes) {
      throw new TrackerError(
        'tracker_status',
        `GitHub token lacks a required scope (${scopes.message}). Classic tokens need "repo" and "project"; for gh, run: gh auth refresh -s project`,
      );
    }
    return { data: body.data ?? null, errors };
  }
}

/** Throws `tracker_response` for any GraphQL error the caller does not explicitly tolerate. */
export function assertNoGraphqlErrors(errors: GraphqlError[], tolerate: (error: GraphqlError) => boolean = () => false): void {
  const fatal = errors.filter((error) => !tolerate(error));
  if (fatal.length > 0) {
    throw new TrackerError('tracker_response', `GitHub GraphQL error: ${fatal.map((e) => e.message).join('; ')}`);
  }
}

function httpError(response: Response, text: string): TrackerError {
  const detail = truncate(oneLine(text), 200);
  const remaining = response.headers.get('x-ratelimit-remaining');
  const retryAfter = response.headers.get('retry-after');
  if (response.status === 429 || (response.status === 403 && (remaining === '0' || retryAfter !== null))) {
    const retryAfterMs = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : resetDelayMs(response.headers);
    return new TrackerError('tracker_rate_limited', `GitHub rate limit (HTTP ${response.status}): ${detail}`, {
      status: response.status,
      retryAfterMs,
    });
  }
  if (response.status === 401) {
    return new TrackerError('tracker_status', 'GitHub rejected the token (HTTP 401); check tracker.provider.token', {
      status: 401,
    });
  }
  return new TrackerError('tracker_status', `GitHub returned HTTP ${response.status}: ${detail}`, { status: response.status });
}

function resetDelayMs(headers: Headers): number | null {
  const reset = headers.get('x-ratelimit-reset');
  if (reset === null || !/^\d+$/.test(reset)) return null;
  return Math.max(0, Number(reset) * 1000 - Date.now());
}
