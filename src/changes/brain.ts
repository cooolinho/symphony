import fs from 'node:fs';
import path from 'node:path';
import type { BrainAccess, BrainClash } from '../brain/access-log.ts';
import { noteTitle, parseNote } from '../brain/note.ts';
import { isRepositoryName } from '../tracker/github-project/settings.ts';
import { diffExcerpt, fileStats, type FileStat } from '../workspace/changes.ts';
import { git } from '../workspace/git.ts';
import type { ChangeEntry } from './types.ts';

/** Vault commits `recentVaultCommits` reads at startup. */
export const BRAIN_BACKFILL_COMMITS = 200;

/** Author and subject of the init commit of the vault (`initVaultGit`): no change of a note. */
const INIT_AUTHOR = 'symphony';
const INIT_SUBJECT = 'Vault angelegt';
const HUMAN_AUTHOR = 'human';

/** True for `.obsidian` and everything below it: Obsidian's own settings are never a brain change. */
export function isObsidianPath(notePath: string): boolean {
  const normalized = notePath.replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized === '.obsidian' || normalized.startsWith('.obsidian/');
}

/**
 * The status of one file of a vault commit. The first match wins: subject `approve:` is `approved`, `reject:` is
 * `rejected_candidate` (the contract for promoting and discarding candidates), author `human` is `human` (the Obsidian
 * commit), a new file is `created`, anything else `updated`.
 */
export function brainCommitStatus(meta: { subject: string; author: string }, file: Pick<FileStat, 'status'>): ChangeEntry['status'] {
  const subject = meta.subject.trim().toLowerCase();
  if (subject.startsWith('approve:')) return 'approved';
  if (subject.startsWith('reject:')) return 'rejected_candidate';
  if (meta.author === HUMAN_AUTHOR) return 'human';
  return file.status === 'added' ? 'created' : 'updated';
}

function roleOf(author: string): string {
  return author.startsWith('symphony-') ? author.slice('symphony-'.length) : author;
}

/** The frontmatter of the note as of `rev` (the parent for a deleted file); `{}` when it cannot be read. */
async function frontmatterAt(vault: string, sha: string, file: FileStat): Promise<{ frontmatter: Record<string, unknown>; body: string }> {
  try {
    const rev = file.status === 'deleted' ? `${sha}^` : sha;
    const { frontmatter, body } = parseNote(await git(vault, ['show', `${rev}:${file.path}`]));
    return { frontmatter, body };
  } catch {
    return { frontmatter: {}, body: '' };
  }
}

function titleOf(frontmatter: Record<string, unknown>, body: string, notePath: string): string {
  const base = path.posix.basename(notePath);
  return notePath.toLowerCase().endsWith('.md') ? noteTitle(frontmatter, body, base) : base;
}

function repoOf(frontmatter: Record<string, unknown>): string {
  const repo = frontmatter.repo;
  return typeof repo === 'string' && isRepositoryName(repo.trim()) ? repo.trim() : 'unknown';
}

/**
 * One `brain` change per path of the vault commit `sha`: `options.paths` (default: every file of the commit) without
 * `.obsidian/` and without ids `options.known` already has. The init commit gives none. Reads only; throws when git fails.
 */
export async function brainCommitEntries(
  vault: string,
  sha: string,
  options: { paths?: string[]; known?: (id: string) => boolean } = {},
): Promise<ChangeEntry[]> {
  const [date = '', author = '', ...subjectLines] = (await git(vault, ['show', '-s', '--format=%cI%n%an%n%s', sha])).replace(/\n+$/, '').split('\n');
  if (author === INIT_AUTHOR && subjectLines.join(' ') === INIT_SUBJECT) return [];
  const subject = subjectLines.join(' ');
  const time = Date.parse(date);
  const at = Number.isNaN(time) ? new Date(0).toISOString() : new Date(time).toISOString();
  const wanted = options.paths === undefined ? null : new Set(options.paths);
  const files = (await fileStats(vault, ['show', '--format=', sha])).filter(
    (file) => !isObsidianPath(file.path) && (wanted === null || wanted.has(file.path)) && !options.known?.(`brain:${sha}:${file.path}`),
  );
  const issueFromSubject = /^\S*#\d+/.exec(subject)?.[0] ?? '';
  const entries: ChangeEntry[] = [];
  for (const file of files) {
    const [{ frontmatter, body }, patch] = await Promise.all([
      frontmatterAt(vault, sha, file),
      git(vault, ['-c', 'core.quotePath=false', 'show', '--format=', '-U0', '--no-color', '--no-ext-diff', sha, '--', file.path]),
    ]);
    const run = frontmatter.run;
    entries.push({
      id: `brain:${sha}:${file.path}`,
      type: 'brain',
      at,
      repo: repoOf(frontmatter),
      issue: typeof frontmatter.issue === 'string' && frontmatter.issue.trim() !== '' ? frontmatter.issue.trim() : issueFromSubject,
      role: roleOf(author),
      title: titleOf(frontmatter, body, file.path),
      files: [file],
      pr: null,
      diff: diffExcerpt(patch),
      status: brainCommitStatus({ subject, author }, file),
      ...(typeof run === 'string' ? { run } : {}),
    });
  }
  return entries;
}

/** The shas of the newest `max` non-merge commits of the vault, oldest first. */
export async function recentVaultCommits(vault: string, max: number = BRAIN_BACKFILL_COMMITS): Promise<string[]> {
  const listed = await git(vault, ['rev-list', '--no-merges', `--max-count=${max}`, 'HEAD', '--']);
  return listed.split('\n').filter((sha) => sha !== '').reverse();
}

/**
 * The `conflict` change of a rejected write (`window` or `hash_mismatch`) that belongs to a clash; null for any other
 * line and for `.obsidian/`. Repository and title come from the note as it is now (`unknown` and the file name otherwise).
 */
export function brainConflictEntry(vault: string, line: BrainAccess, clash: BrainClash): ChangeEntry | null {
  if (line.result !== 'rejected' || (line.reason !== 'window' && line.reason !== 'hash_mismatch')) return null;
  if (clash.id === '' || isObsidianPath(line.path_or_query)) return null;
  let frontmatter: Record<string, unknown> = {};
  let body = '';
  try {
    ({ frontmatter, body } = parseNote(fs.readFileSync(path.join(vault, line.path_or_query), 'utf8')));
  } catch {
    // the note is gone or unreadable: repository `unknown`, title from the file name
  }
  return {
    id: `brain:conflict:${clash.id}`,
    type: 'brain',
    at: line.at,
    repo: repoOf(frontmatter),
    issue: line.issue ?? '',
    role: line.role ?? '',
    title: titleOf(frontmatter, body, line.path_or_query),
    files: [{ path: line.path_or_query, added: 0, deleted: 0, status: 'modified' }],
    pr: null,
    diff: null,
    status: 'conflict',
    run: line.run,
    reason: line.reason,
    clash_id: clash.id,
  };
}
