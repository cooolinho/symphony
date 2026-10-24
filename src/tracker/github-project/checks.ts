import { compileGlob } from '../../workflow/glob.ts';

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function nodes(connection: unknown): Json[] {
  const list = obj(connection)?.nodes;
  return Array.isArray(list) ? (list.map(obj).filter((n) => n !== null) as Json[]) : [];
}

/** One check of the head commit as the merge gate reports it. */
export interface CheckContext {
  name: string;
  /** `SUCCESS`, `FAILURE`, `PENDING`, `IN_PROGRESS`, … as GitHub spells it. */
  state: string;
  url: string | null;
}

export interface CheckEvaluation {
  /** `none`: the commit has no checks; `failure` wins over `pending`, which wins over `success`. */
  state: 'none' | 'success' | 'pending' | 'failure';
  failing: CheckContext[];
  pending: CheckContext[];
  /** Every failing check is a GitHub Actions job that never started (billing, spending limit): no code problem. */
  infra: boolean;
  /** Head commit the rollup belongs to; null when GitHub returned none. */
  sha: string | null;
}

/** Check-run conclusions that pass; every other completed conclusion fails. */
const PASSING_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PENDING_STATUSES = new Set(['PENDING', 'EXPECTED']);
const FAILING_STATUSES = new Set(['FAILURE', 'ERROR']);
/** The annotation GitHub puts on a job it did not run for account reasons. */
const NOT_STARTED = /job was not started|spending limit|payments have failed/i;

/** Whether `name` (also as `owner/repo:name`) matches one of the `ignore` globs; matched case-insensitively. */
function ignored(repository: string, name: string, ignore: readonly RegExp[]): boolean {
  const plain = name.toLowerCase();
  const qualified = `${repository.toLowerCase()}:${plain}`;
  return ignore.some((glob) => glob.test(plain) || glob.test(qualified));
}

/** Compiles `auto_merge.checks.ignore`; lowercased, so the match ignores case. */
export function compileIgnoreGlobs(globs: readonly string[]): RegExp[] {
  return globs.map((glob) => compileGlob(glob.toLowerCase()));
}

/**
 * Evaluates the `commits(last: 1)` connection of a pull request (`CHECK_ROLLUP_FIELDS` in queries.ts). More contexts than
 * returned count as pending: the merge gate never passes on a list it could not read completely.
 */
export function evaluateRollup(commits: unknown, repository: string, ignore: readonly RegExp[]): CheckEvaluation {
  const commit = obj(nodes(commits)[0]?.commit);
  const sha = typeof commit?.oid === 'string' ? commit.oid : null;
  const rollup = obj(commit?.statusCheckRollup);
  if (rollup === null) return { state: 'none', failing: [], pending: [], infra: false, sha };

  const failing: CheckContext[] = [];
  const pending: CheckContext[] = [];
  let infra = true;
  let seen = 0;
  const contexts = obj(rollup.contexts);
  for (const node of nodes(contexts)) {
    seen++;
    if (node.__typename === 'CheckRun') {
      const name = String(node.name ?? '');
      if (ignored(repository, name, ignore)) continue;
      const url = typeof node.detailsUrl === 'string' ? node.detailsUrl : null;
      const status = String(node.status ?? '');
      const conclusion = typeof node.conclusion === 'string' ? node.conclusion : null;
      if (status !== 'COMPLETED' || conclusion === null) {
        pending.push({ name, state: status, url });
      } else if (!PASSING_CONCLUSIONS.has(conclusion)) {
        failing.push({ name, state: conclusion, url });
        const messages = nodes(obj(node.annotations)).map((annotation) => String(annotation.message ?? ''));
        if (!messages.some((message) => NOT_STARTED.test(message))) infra = false;
      }
    } else if (node.__typename === 'StatusContext') {
      const name = String(node.context ?? '');
      if (ignored(repository, name, ignore)) continue;
      const url = typeof node.targetUrl === 'string' ? node.targetUrl : null;
      const state = String(node.state ?? '');
      if (PENDING_STATUSES.has(state)) pending.push({ name, state, url });
      else if (FAILING_STATUSES.has(state)) {
        failing.push({ name, state, url });
        infra = false;
      }
    }
  }
  const total = typeof contexts?.totalCount === 'number' ? contexts.totalCount : seen;
  if (total > seen) pending.push({ name: `${total - seen} more checks`, state: 'UNREAD', url: null });

  const state = failing.length > 0 ? 'failure' : pending.length > 0 ? 'pending' : seen === 0 ? 'none' : 'success';
  return { state, failing, pending, infra: failing.length > 0 && infra, sha };
}

/** `name (STATE)` entries, linked when GitHub gave a URL. */
export function describeChecks(checks: readonly CheckContext[]): string {
  return checks.map((check) => (check.url !== null ? `[${check.name}](${check.url}) (${check.state.toLowerCase()})` : `${check.name} (${check.state.toLowerCase()})`)).join(', ');
}
