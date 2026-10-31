import fs from 'node:fs';
import path from 'node:path';
import type { HistoryLog } from '../history/history.ts';
import { resultRows, type PersistedResult } from '../orchestrator/stage-history.ts';
import { isRepositoryName } from '../tracker/github-project/settings.ts';
import type { VaultGit } from './git.ts';
import { parseNote, serializeNote } from './note.ts';
import { resolveVaultWritePath } from './paths.ts';
import { repoFolderName } from './vault.ts';
import { writeAtomic } from './write.ts';

export interface IssueSummarySubject {
  /** `owner/name` */
  repo: string;
  identifier: string;
  /** The issue number, as in the file name. */
  number: string;
  title: string;
  description: string | null;
  pullRequest: number | null;
  pullRequestUrl: string | null;
}

export type IssueCostSource = Pick<HistoryLog, 'issueCostUsd'>;

export interface IssueSummaryOptions {
  vaultPath: string;
  versioning: VaultGit;
  now?: () => Date;
  /** Cost of the run that is still going (not in the history yet). */
  extraCostUsd?: number;
}

const SUMMARY_CELL_LIMIT = 300;

export function issueSummaryPath(repo: string, number: string): string {
  if (!isRepositoryName(repo)) throw new Error(`invalid repository name: ${repo}`);
  if (!/^[A-Za-z0-9_-]+$/.test(number)) throw new Error(`invalid issue number: ${number}`);
  return `Issues/${repoFolderName(repo)}/${number}.md`;
}

function cell(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
  return flat.length > SUMMARY_CELL_LIMIT ? `${flat.slice(0, SUMMARY_CELL_LIMIT - 1)}…` : flat;
}

function firstLine(text: string | null): string | null {
  for (const line of (text ?? '').split(/\r?\n/)) if (line.trim() !== '') return line.trim();
  return null;
}

/** The note text; deterministic for the same input, so a second run changes no byte. */
export function renderIssueSummary(input: {
  issue: IssueSummarySubject;
  results: readonly PersistedResult[];
  costUsd: number;
  created: string;
  updated: string;
}): string {
  const { issue } = input;
  const rows = resultRows(input.results).filter((row) => row.kind !== 'reset');
  const rounds = rows.length === 0 ? 0 : Math.max(1, ...rows.map((row) => row.round ?? 0));
  const files = [...new Set(rows.flatMap((row) => row.changed_files))].sort();
  const goal = firstLine(issue.description);
  const lines: string[] = [`# ${issue.title.replace(/\s+/g, ' ').trim()}`, '', '## Goal', '', `- Issue: ${issue.title.replace(/\s+/g, ' ').trim()}`];
  if (goal !== null) lines.push(`- Description: ${cell(goal)}`);
  lines.push('', '## Stage results', '');
  if (rows.length === 0) {
    lines.push('No stage results recorded.');
  } else {
    lines.push('| Role | Verdict | Round | Summary |', '| --- | --- | --- | --- |');
    for (const row of rows) lines.push(`| ${cell(row.role)} | ${cell(row.verdict)} | ${row.round ?? ''} | ${cell(row.summary)} |`);
  }
  lines.push('', '## Totals', '', `- Rounds: ${rounds}`, `- Stage results: ${rows.length}`, `- Cost: ${input.costUsd.toFixed(2)} USD`);
  lines.push('', '## Changed files', '');
  if (files.length === 0) lines.push('- none recorded');
  else for (const file of files) lines.push(`- \`${file}\``);
  const pr =
    issue.pullRequest === null ? 'none' : issue.pullRequestUrl !== null ? `[#${issue.pullRequest}](${issue.pullRequestUrl})` : `#${issue.pullRequest}`;
  lines.push('', '## Links', '', `- Repository: [[Repos/${repoFolderName(issue.repo)}/index]]`, `- Pull request: ${pr}`);
  const frontmatter = {
    type: 'issue',
    status: 'approved',
    repo: issue.repo,
    issue: `${issue.repo}#${issue.number}`,
    role: 'symphony',
    created: input.created,
    updated: input.updated,
    sources: issue.pullRequestUrl !== null ? [issue.pullRequestUrl] : [],
  };
  return serializeNote(frontmatter, lines.join('\n'));
}

function dateOf(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return null;
}

/**
 * Writes `Issues/<owner-name>/<number>.md` and commits it as `symphony`. Runs on the vault queue; a second run with the
 * same data changes nothing and makes no commit. Throws on invalid input or a git error; the caller catches.
 */
export async function writeIssueSummary(
  issue: IssueSummarySubject,
  results: readonly PersistedResult[],
  history: IssueCostSource | null,
  options: IssueSummaryOptions,
): Promise<{ path: string; sha: string | null; changed: boolean }> {
  const relative = issueSummaryPath(issue.repo, issue.number);
  const target = resolveVaultWritePath(options.vaultPath, relative);
  if (!target.ok) throw new Error(target.message);
  const costUsd = (history?.issueCostUsd(issue.repo, issue.identifier) ?? 0) + (options.extraCostUsd ?? 0);
  const today = (options.now?.() ?? new Date()).toISOString().slice(0, 10);
  const subject = `${issue.repo}#${issue.number}: issue summary`;
  const { versioning } = options;
  return versioning.serial(async () => {
    await versioning.beforeWrite();
    let existing: string | null = null;
    try {
      existing = fs.readFileSync(target.absolute, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const old = existing === null ? null : parseNote(existing).frontmatter;
    const created = dateOf(old?.created) ?? today;
    const previousUpdated = dateOf(old?.updated) ?? today;
    const render = (updated: string): string => renderIssueSummary({ issue, results, costUsd, created, updated });
    let text = render(previousUpdated);
    const changed = text !== existing;
    if (changed) {
      text = render(today);
      fs.mkdirSync(path.dirname(target.absolute), { recursive: true });
      writeAtomic(target.absolute, text);
    }
    const sha = await versioning.commitAs(target.relative, subject);
    return { path: target.relative, sha, changed };
  });
}
