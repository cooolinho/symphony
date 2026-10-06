import { envReferenceName, resolveEnvReference } from '../../util/env.ts';
import type { TrackerErrorCategory } from '../types.ts';

export const KIND = 'github_project';
export const DEFAULT_ENDPOINT = 'https://api.github.com/graphql';
export const DEFAULT_STATUS_FIELD = 'Status';
/** Column `create_sub_issue` puts new sub-issues in: a human moves them on, so it must not be an active column. */
export const DEFAULT_SUB_ISSUE_STATUS = 'Backlog';
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Checked in order when `token` is omitted. */
export const TOKEN_FALLBACK_ENV = ['GITHUB_TOKEN', 'GH_TOKEN'] as const;
/** Every variable GitHub tooling (git, gh) reads credentials from; stripped from child processes. */
export const GITHUB_SECRET_ENV = ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_ENTERPRISE_TOKEN'] as const;

const PROJECT_URL = /^https?:\/\/[^/]+\/(?:users|orgs)\/([^/\s]+)\/projects\/(\d+)\/?(?:[?#].*)?$/;
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** True for an `owner/name` repository reference. */
export function isRepositoryName(name: string): boolean {
  return REPOSITORY.test(name);
}

/** Splits a comma or space separated repository list ("owner/a, owner/b") into its entries. */
export function splitRepositoryList(text: string): string[] {
  return text.split(/[\s,]+/).filter((entry) => entry !== '');
}

export interface GithubProjectSettings {
  owner: string;
  projectNumber: number;
  token: string;
  /** Where the token came from (an env var name or "literal"); never the token itself. */
  tokenSource: string;
  endpoint: string;
  statusField: string;
  priorityField: string | null;
  /** Lowercased `owner/name` entries; null means every repository on the board is in scope. */
  repositories: Set<string> | null;
  assignee: string | null;
  respectBlockers: boolean;
  respectSubIssues: boolean;
  /** Board column for sub-issues created by the `create_sub_issue` tool. */
  subIssueStatus: string;
  requestTimeoutMs: number;
  requestRetries: number;
}

export interface SettingsResult {
  settings: GithubProjectSettings | null;
  errors: string[];
  category: TrackerErrorCategory;
}

/** A provider value after `$VAR` resolution, with the variable name kept for error messages. */
function read(provider: Record<string, unknown>, key: string, env: NodeJS.ProcessEnv): { value: unknown; ref: string | null } {
  const raw = provider[key];
  return { value: resolveEnvReference(raw, env), ref: envReferenceName(raw) };
}

function text(value: unknown): string | null {
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function describe(key: string, ref: string | null): string {
  return ref === null ? `tracker.provider.${key}` : `tracker.provider.${key} ($${ref})`;
}

/**
 * Parses `tracker.provider` for kind github_project. Every key accepts a whole-value `$VAR`
 * reference (unset or empty counts as omitted). See docs/adapters/github-project.md.
 */
export function parseSettings(provider: Record<string, unknown>, env: NodeJS.ProcessEnv): SettingsResult {
  const errors: string[] = [];
  let category: TrackerErrorCategory = 'invalid_tracker_config';

  // repositories: a list or a comma/space separated string of owner/name entries.
  const repos = read(provider, 'repositories', env);
  let repositories: Set<string> | null = null;
  let firstRepository: string | null = null;
  if (repos.value !== undefined && repos.value !== null) {
    const entries = Array.isArray(repos.value)
      ? repos.value.map((entry) => resolveEnvReference(entry, env))
      : typeof repos.value === 'string'
        ? splitRepositoryList(repos.value)
        : null;
    const names = entries?.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map((e) => e.trim());
    if (names === undefined || names.length === 0 || names.some((name) => !isRepositoryName(name))) {
      errors.push(`${describe('repositories', repos.ref)} must be "owner/name" entries (comma-separated or a list)`);
    } else {
      repositories = new Set(names.map((name) => name.toLowerCase()));
      firstRepository = names[0] ?? null;
    }
  }

  // project_number: a number, or a project URL that also names the owner.
  const number = read(provider, 'project_number', env);
  let projectNumber = Number.NaN;
  let urlOwner: string | null = null;
  const numberText = text(number.value);
  const urlMatch = numberText === null ? null : PROJECT_URL.exec(numberText);
  if (urlMatch !== null) {
    urlOwner = urlMatch[1] ?? null;
    projectNumber = Number(urlMatch[2]);
  } else if (numberText !== null && /^\d+$/.test(numberText)) {
    projectNumber = Number(numberText);
  }
  if (!Number.isSafeInteger(projectNumber) || projectNumber <= 0) {
    errors.push(
      numberText === null
        ? `${describe('project_number', number.ref)} is required (the number in https://github.com/users/<owner>/projects/<number>)`
        : `${describe('project_number', number.ref)} must be a project number or project URL (got ${JSON.stringify(numberText)})`,
    );
  }

  // owner: explicit, else from the project URL, else the owner of the first repository.
  const ownerValue = read(provider, 'owner', env);
  const owner = text(ownerValue.value) ?? urlOwner ?? firstRepository?.split('/')[0] ?? null;
  if (owner === null) {
    errors.push('tracker.provider.owner is required: set it, use a project URL, or set repositories (the board owner defaults to the repository owner)');
  }

  // token: explicit `$VAR` (or literal), else GITHUB_TOKEN / GH_TOKEN.
  let token = '';
  let tokenSource = '';
  const tokenRef = envReferenceName(provider.token);
  if (tokenRef !== null) {
    token = env[tokenRef] ?? '';
    tokenSource = tokenRef;
    if (token === '') {
      errors.push(`tracker.provider.token references $${tokenRef}, which is unset or empty`);
      category = 'missing_tracker_secret';
    }
  } else if (typeof provider.token === 'string' && provider.token.trim() !== '') {
    token = provider.token.trim();
    tokenSource = 'literal';
  } else if (provider.token !== undefined && provider.token !== null) {
    errors.push('tracker.provider.token must be a string such as $GITHUB_TOKEN');
  } else {
    for (const name of TOKEN_FALLBACK_ENV) {
      if (env[name]) {
        token = env[name] as string;
        tokenSource = name;
        break;
      }
    }
    if (token === '') {
      errors.push(`no GitHub token: set tracker.provider.token (e.g. $GITHUB_TOKEN) or export ${TOKEN_FALLBACK_ENV.join(' or ')}`);
      category = 'missing_tracker_secret';
    }
  }

  const endpoint = text(read(provider, 'endpoint', env).value) ?? DEFAULT_ENDPOINT;
  if (!/^https?:\/\//.test(endpoint)) errors.push('tracker.provider.endpoint must be an http(s) URL');
  const statusField = text(read(provider, 'status_field', env).value) ?? DEFAULT_STATUS_FIELD;
  const priorityField = text(read(provider, 'priority_field', env).value);
  const assignee = text(read(provider, 'assignee', env).value);

  let respectBlockers = true;
  const blockers = read(provider, 'respect_blockers', env).value;
  if (blockers !== undefined && blockers !== null) {
    if (blockers === true || blockers === 'true') respectBlockers = true;
    else if (blockers === false || blockers === 'false') respectBlockers = false;
    else errors.push('tracker.provider.respect_blockers must be true or false');
  }

  let respectSubIssues = true;
  const subIssues = read(provider, 'respect_sub_issues', env).value;
  if (subIssues !== undefined && subIssues !== null) {
    if (subIssues === true || subIssues === 'true') respectSubIssues = true;
    else if (subIssues === false || subIssues === 'false') respectSubIssues = false;
    else errors.push('tracker.provider.respect_sub_issues must be true or false');
  }

  const subIssueStatus = text(read(provider, 'sub_issue_status', env).value) ?? DEFAULT_SUB_ISSUE_STATUS;

  let requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS;
  const timeout = text(read(provider, 'request_timeout_ms', env).value);
  if (timeout !== null) {
    const parsed = Number(timeout);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) errors.push('tracker.provider.request_timeout_ms must be a positive integer');
    else requestTimeoutMs = parsed;
  }

  let requestRetries = 2;
  const retries = text(read(provider, 'request_retries', env).value);
  if (retries !== null) {
    if (!/^\d+$/.test(retries)) errors.push('tracker.provider.request_retries must be an integer >= 0');
    else requestRetries = Number(retries);
  }

  if (errors.length > 0 || owner === null) return { settings: null, errors, category };
  return {
    settings: {
      owner,
      projectNumber,
      token,
      tokenSource,
      endpoint,
      statusField,
      priorityField,
      repositories,
      assignee,
      respectBlockers,
      respectSubIssues,
      subIssueStatus,
      requestTimeoutMs,
      requestRetries,
    },
    errors: [],
    category,
  };
}

export function secretEnvironmentNames(provider: Record<string, unknown>): string[] {
  const names = new Set<string>(GITHUB_SECRET_ENV);
  const ref = envReferenceName(provider.token);
  if (ref !== null) names.add(ref);
  return [...names];
}
