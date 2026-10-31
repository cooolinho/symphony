import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../log.ts';
import { errorMessage } from '../util/errors.ts';
import { hashOf } from './common.ts';
import { lastCommitWithSubject, type VaultGit } from './git.ts';
import { targetOf, textOf, type VaultIndex } from './index.ts';
import { noteStatus, parseNote, serializeNote } from './note.ts';
import { resolveVaultWritePath } from './paths.ts';
import { writeAtomic } from './write.ts';

export type PromoteFailure = 'invalid_path' | 'not_found' | 'not_candidate' | 'name_not_unique' | 'invalid_target' | 'no_approve_commit' | 'revert_conflict' | 'git_failed';

export type PromoteResult =
  | { ok: true; path: string; previousPath: string; hash: string; sha: string }
  | { ok: false; reason: PromoteFailure; message: string };

export interface PromoteOptions {
  vault: string;
  git: VaultGit;
  /** The current vault index (for the file name check of approve). */
  index: () => Promise<VaultIndex>;
  logger: Logger;
  /** Clock, for tests. */
  now?: () => Date;
}

const APPROVE_PREFIX = 'approve: ';
const MAX_SUFFIX = 99;

const failure = (reason: PromoteFailure, message: string): PromoteResult => ({ ok: false, reason, message });

interface Candidate {
  absolute: string;
  relative: string;
  text: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Reads the note at `relative`; only `status: candidate` passes. */
function readCandidate(absolute: string, relative: string): Candidate | PromoteResult {
  let text: string;
  try {
    if (!fs.statSync(absolute).isFile()) return failure('not_found', `${relative} is not a note`);
    text = fs.readFileSync(absolute, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return failure('not_found', `${relative} does not exist`);
    throw error;
  }
  const parsed = parseNote(text);
  if (parsed.frontmatterError !== null) return failure('not_candidate', `frontmatter of ${relative} is not valid YAML: ${parsed.frontmatterError}`);
  const status = noteStatus(parsed.frontmatter);
  if (status !== 'candidate') return failure('not_candidate', `${relative} is ${status ?? 'without status'}, not a candidate`);
  return { absolute, relative, text, frontmatter: parsed.frontmatter, body: parsed.body };
}

/**
 * Destination of an approved note: `target` from its frontmatter (a folder ending in `/`, a full `.md` path, or a folder
 * without the slash), else the folder of its type; the file name stays.
 */
export function targetPath(frontmatter: Record<string, unknown>, relative: string): string {
  const name = path.posix.basename(relative);
  const target = textOf(frontmatter.target);
  if (target === null) {
    return targetOf({ target: null, type: textOf(frontmatter.type)?.toLowerCase() ?? null, repo: textOf(frontmatter.repo) }) + name;
  }
  if (target.endsWith('/')) return target + name;
  if (target.toLowerCase().endsWith('.md')) return target;
  return `${target}/${name}`;
}

function exists(absolute: string): boolean {
  try {
    fs.lstatSync(absolute);
    return true;
  } catch {
    return false;
  }
}

/** The checked destination with `-2`, `-3`, … when another file already holds it. */
function freeTarget(vault: string, candidate: Candidate): { absolute: string; relative: string } | PromoteResult {
  const wanted = targetPath(candidate.frontmatter, candidate.relative);
  const stem = wanted.replace(/\.md$/i, '');
  const extension = wanted.slice(stem.length);
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const resolved = resolveVaultWritePath(vault, n === 1 ? wanted : `${stem}-${n}${extension}`);
    if (!resolved.ok) return failure('invalid_target', `target ${wanted} is not allowed: ${resolved.message}`);
    if (resolved.relative === candidate.relative || !exists(resolved.absolute)) return { absolute: resolved.absolute, relative: resolved.relative };
  }
  return failure('invalid_target', `no free file name for ${wanted}`);
}

function today(options: PromoteOptions): string {
  return (options.now?.() ?? new Date()).toISOString().slice(0, 10);
}

/** Path check like the tools, then `fn` in the vault queue after manual changes are committed. */
async function inQueue(options: PromoteOptions, input: string, fn: (target: { absolute: string; relative: string }) => Promise<PromoteResult>): Promise<PromoteResult> {
  const target = resolveVaultWritePath(options.vault, input);
  if (!target.ok) return failure('invalid_path', target.message);
  return options.git.serial(async () => {
    try {
      await options.git.beforeWrite();
    } catch (error) {
      options.logger.error('brain vault commit failed', { path: target.relative, error: errorMessage(error) });
      return failure('git_failed', `vault git failed: ${errorMessage(error)}`);
    }
    return fn(target);
  });
}

/** Writes the changed note (moved when `to` differs) and commits it as `human`; rolls the files back when the commit fails. */
async function writeAndCommit(options: PromoteOptions, candidate: Candidate, to: { absolute: string; relative: string }, text: string, subject: string): Promise<PromoteResult> {
  const moved = to.relative !== candidate.relative;
  writeAtomic(to.absolute, text);
  if (moved) fs.rmSync(candidate.absolute, { force: true });
  let sha: string | null;
  try {
    sha = await options.git.commitHuman(moved ? [candidate.relative, to.relative] : [to.relative], subject, to.relative);
    if (sha === null) throw new Error('nothing to commit');
  } catch (error) {
    try {
      if (moved) fs.rmSync(to.absolute, { force: true });
      writeAtomic(candidate.absolute, candidate.text);
    } catch (restoreError) {
      options.logger.error('brain promotion could not be rolled back', { path: candidate.relative, error: errorMessage(restoreError) });
    }
    options.logger.error('brain vault commit failed', { path: candidate.relative, error: errorMessage(error) });
    return failure('git_failed', `vault git failed: ${errorMessage(error)}`);
  }
  return { ok: true, path: to.relative, previousPath: candidate.relative, hash: hashOf(Buffer.from(text)), sha };
}

/**
 * Promotes a candidate: `status: approved`, `updated`, moved to its target (see `targetPath`), committed as `human` with
 * `approve: <path>`. Links are not rewritten; when the file name would not be unique in the vault nothing changes.
 */
export function approveCandidate(options: PromoteOptions, input: string): Promise<PromoteResult> {
  return inQueue(options, input, async (source) => {
    const candidate = readCandidate(source.absolute, source.relative);
    if ('ok' in candidate) return candidate;
    const to = freeTarget(options.vault, candidate);
    if ('ok' in to) return to;
    const name = path.posix.basename(to.relative).toLowerCase();
    const same = [...(await options.index()).notes.keys()].filter((rel) => rel !== candidate.relative && path.posix.basename(rel).toLowerCase() === name);
    if (same.length > 0) {
      return failure('name_not_unique', `links by file name to ${path.posix.basename(to.relative)} would be ambiguous; rename one of: ${same.sort().join(', ')}`);
    }
    const text = serializeNote({ ...candidate.frontmatter, status: 'approved', updated: today(options) }, candidate.body);
    return writeAndCommit(options, candidate, to, text, `${APPROVE_PREFIX}${candidate.relative}`);
  });
}

/** Discards a candidate: `status: deprecated`, `updated`; the file stays where it is. Committed as `human` with `reject: <path>`. */
export function rejectCandidate(options: PromoteOptions, input: string): Promise<PromoteResult> {
  return inQueue(options, input, async (source) => {
    const candidate = readCandidate(source.absolute, source.relative);
    if ('ok' in candidate) return candidate;
    const text = serializeNote({ ...candidate.frontmatter, status: 'deprecated', updated: today(options) }, candidate.body);
    return writeAndCommit(options, candidate, source, text, `reject: ${candidate.relative}`);
  });
}

/** Takes back the last approve of the note at its new path with `git revert` (as `human`); the candidate is back at its old path. */
export function revertApprove(options: PromoteOptions, input: string): Promise<PromoteResult> {
  return inQueue(options, input, async (source) => {
    if (!exists(source.absolute)) return failure('not_found', `${source.relative} does not exist`);
    const approve = await lastCommitWithSubject(options.vault, source.relative, APPROVE_PREFIX);
    if (approve === null) return failure('no_approve_commit', `${source.relative} has no approve commit`);
    const previous = resolveVaultWritePath(options.vault, approve.subject.slice(APPROVE_PREFIX.length));
    if (!previous.ok) return failure('no_approve_commit', `the approve commit of ${source.relative} names no valid path`);
    let sha: string;
    try {
      sha = await options.git.revert(approve.sha, [...new Set([previous.relative, source.relative])]);
    } catch (error) {
      options.logger.warn('brain approve revert failed', { path: source.relative, sha: approve.sha, error: errorMessage(error) });
      return failure('revert_conflict', `the approve commit cannot be reverted (the note changed since?): ${errorMessage(error)}`);
    }
    let hash = '';
    try {
      hash = hashOf(fs.readFileSync(previous.absolute));
    } catch (error) {
      options.logger.warn('brain reverted note cannot be read', { path: previous.relative, error: errorMessage(error) });
    }
    return { ok: true, path: previous.relative, previousPath: source.relative, hash, sha };
  });
}
