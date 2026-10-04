import { SymphonyError, errorMessage } from '../util/errors.ts';
import { oneLine, truncate } from '../util/text.ts';

/** REST API version the requests are written against (https://docs.github.com/rest?apiVersion=2026-03-10). */
export const GITHUB_API_VERSION = '2026-03-10';
export const DEFAULT_REST_URL = 'https://api.github.com';
const USER_AGENT = 'symphony-repo-init/0.1';
const DEFAULT_TIMEOUT_MS = 30_000;
/** Upper bound on label pages (100 labels each). */
const MAX_PAGES = 50;

export interface GithubLabel {
  name: string;
  /** Lowercase hex color without "#". */
  color: string;
  description: string | null;
  /** Set while the label is archived; archived labels cannot be added to issues. */
  archived_at: string | null;
}

export interface NewLabel {
  name: string;
  color: string;
  description: string;
}

export interface LabelUpdate {
  color?: string;
  description?: string;
  archived?: boolean;
}

/** A failed REST call; `status` is the HTTP status, or null for network errors and timeouts. */
export class GithubRestError extends SymphonyError {
  readonly status: number | null;

  constructor(message: string, status: number | null, options?: ErrorOptions) {
    super('github_rest_error', message, options);
    this.name = 'GithubRestError';
    this.status = status;
  }
}

export interface GithubRestOptions {
  token: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Minimal GitHub REST client for repository setup (labels for now). */
export class GithubRestClient {
  #token: string;
  #baseUrl: string;
  #timeoutMs: number;
  #fetch: typeof fetch;

  constructor(options: GithubRestOptions) {
    this.#token = options.token;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_REST_URL).replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? fetch;
  }

  /** Every label of the repository, archived ones included. */
  async listLabels(repository: string): Promise<GithubLabel[]> {
    const labels: GithubLabel[] = [];
    let url: string | null = `${this.#baseUrl}${repositoryPath(repository)}/labels?per_page=100`;
    for (let page = 1; url !== null; page++) {
      if (page > MAX_PAGES) throw new GithubRestError(`more than ${MAX_PAGES * 100} labels`, null);
      const response = await this.#send('GET', url);
      const body = await readJson(response);
      if (!Array.isArray(body)) throw new GithubRestError('GitHub returned an unexpected label list', response.status);
      labels.push(...body.map(toLabel));
      url = nextPage(response.headers.get('link'));
      // The token travels with every request, so only follow links to the same API.
      if (url !== null && !url.startsWith(`${this.#baseUrl}/`)) throw new GithubRestError(`unexpected pagination link ${url}`, null);
    }
    return labels;
  }

  /** One label by name (case-insensitive on GitHub), or null if the repository has none. */
  async getLabel(repository: string, name: string): Promise<GithubLabel | null> {
    try {
      return toLabel(await readJson(await this.#send('GET', `${this.#baseUrl}${labelPath(repository, name)}`)));
    } catch (error) {
      if (error instanceof GithubRestError && error.status === 404) return null;
      throw error;
    }
  }

  async createLabel(repository: string, label: NewLabel): Promise<void> {
    await this.#send('POST', `${this.#baseUrl}${repositoryPath(repository)}/labels`, label);
  }

  async updateLabel(repository: string, name: string, update: LabelUpdate): Promise<void> {
    await this.#send('PATCH', `${this.#baseUrl}${labelPath(repository, name)}`, update);
  }

  async #send(method: string, url: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.#token}`,
      'x-github-api-version': GITHUB_API_VERSION,
      'user-agent': USER_AGENT,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new GithubRestError(
        timedOut ? `GitHub request timed out after ${this.#timeoutMs}ms` : `GitHub request failed: ${errorMessage(error)}`,
        null,
        { cause: error },
      );
    }
    if (!response.ok) throw await httpError(response);
    return response;
  }
}

function repositoryPath(repository: string): string {
  const [owner = '', name = ''] = repository.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function labelPath(repository: string, name: string): string {
  return `${repositoryPath(repository)}/labels/${encodeURIComponent(name)}`;
}

/** The `rel="next"` URL of a Link header, or null. */
function nextPage(link: string | null): string | null {
  for (const part of link?.split(',') ?? []) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new GithubRestError(`GitHub returned a non-JSON response: ${truncate(oneLine(text), 200)}`, response.status, { cause: error });
  }
}

function toLabel(value: unknown): GithubLabel {
  const label = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  if (typeof label.name !== 'string') throw new GithubRestError('GitHub returned a label without a name', null);
  return {
    name: label.name,
    color: typeof label.color === 'string' ? label.color.toLowerCase() : '',
    description: typeof label.description === 'string' ? label.description : null,
    archived_at: typeof label.archived_at === 'string' ? label.archived_at : null,
  };
}

async function httpError(response: Response): Promise<GithubRestError> {
  const { status } = response;
  const text = await response.text().catch(() => '');
  let detail = truncate(oneLine(text), 200);
  try {
    const body = JSON.parse(text) as { message?: unknown; errors?: unknown };
    // Validation errors look like {"message": "Validation Failed", "errors": [{"field": "name", "code": "already_exists"}]}.
    const errors = (Array.isArray(body.errors) ? (body.errors as unknown[]) : [])
      .map((entry) => {
        const error = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
        return [error.field, error.code].filter((part) => typeof part === 'string').join(' ');
      })
      .filter((entry) => entry !== '');
    if (typeof body.message === 'string') detail = errors.length > 0 ? `${body.message} (${errors.join(', ')})` : body.message;
  } catch {
    // Not JSON: keep the raw text.
  }
  if (status === 401) return new GithubRestError('GitHub rejected the token (HTTP 401); check GITHUB_TOKEN', status);
  if (status === 429 || (status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
    return new GithubRestError(`GitHub rate limit reached (HTTP ${status}); try again later`, status);
  }
  if (status === 403) {
    return new GithubRestError(
      `GitHub denied access (HTTP 403: ${detail}); classic tokens need the "repo" scope, fine-grained tokens "Issues: Read and write"`,
      status,
    );
  }
  if (status === 404) return new GithubRestError('not found (HTTP 404): the repository does not exist or the token cannot see it', status);
  return new GithubRestError(`GitHub returned HTTP ${status}: ${detail}`, status);
}
