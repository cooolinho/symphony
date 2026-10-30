import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Logger } from '../log.ts';
import type { AgentToolContext, AgentToolSpec, ToolResult } from '../tracker/types.ts';
import { errorMessage } from '../util/errors.ts';
import type { BrainAccess, BrainAccessLog, BrainClashReason } from './access-log.ts';
import { fail, hashOf, MAX_NOTE_BYTES, ok, purposeOf, reasonOf, warnPurpose } from './common.ts';
import { appendUnderHeading, parseNote, prepareFrontmatter, serializeNote } from './note.ts';
import { resolveVaultWritePath } from './paths.ts';

/** What a successful write reports to `onWrite` (E7-3 commits, E7-4 logs). */
export interface BrainWriteEntry {
  tool: 'brain_write' | 'brain_append';
  path: string;
  purpose: string | null;
  hash: string;
  previousHash: string | null;
  created: boolean;
  issue: string;
  role: string | null;
  run: string | null;
  /** ISO timestamp. */
  at: string;
}

/** Vault versioning (E7-3): the whole write runs under `serial`; a failing `beforeWrite` or `commitWrite` rejects the write. */
export interface BrainVersioning {
  serial<T>(fn: () => Promise<T>): Promise<T>;
  /** Takes over manual changes (Obsidian) before the file is written. */
  beforeWrite(): Promise<void>;
  /** Commits the written file; returns the sha. */
  commitWrite(entry: BrainWriteEntry): Promise<string>;
}

export interface BrainWriteOptions {
  /** Commits every write to the vault repository; without it nothing is versioned. */
  versioning?: BrainVersioning;
  /** Called after every successful write; an error is only logged. */
  onWrite?: (entry: BrainWriteEntry) => void | Promise<void>;
  /** Clock, for tests. */
  now?: () => Date;
  /** Shared access log: logs every call and rejects a write when another run wrote the note within `clashWindowMs`. */
  access?: BrainAccessLog | null;
  /** Window of the clash check in ms (default 600000; 0 = off). */
  clashWindowMs?: number;
}

/** What the audit line of a call needs besides the arguments; filled in by the tool body as it learns more. */
interface Audit {
  path: string;
  hashBefore?: string;
  /** The call already left its access line (success or clash). */
  logged: boolean;
}

/** Writes through a temp file in the target folder and renames it, so a reader never sees half a note. */
function writeAtomic(absolute: string, text: string): void {
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temp = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, text, { flag: 'wx' });
    fs.renameSync(temp, absolute);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** Write tools of the knowledge vault: whole notes with `brain_write`, one section with `brain_append`. */
export function createBrainWriteTools(vaultPath: string, logger: Logger, options: BrainWriteOptions = {}): AgentToolSpec[] {
  const now = options.now ?? (() => new Date());
  const access = options.access ?? null;
  const windowMs = options.clashWindowMs ?? 600_000;

  const tooLarge = (): ToolResult => fail('rejected', `note is larger than ${MAX_NOTE_BYTES} bytes`);

  /** Current file of a write target: null when missing; a ToolResult when it cannot be written. */
  const current = (absolute: string): { text: string; hash: string } | null | ToolResult => {
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) return fail('invalid_argument', 'path is not a file');
      if (stat.size > MAX_NOTE_BYTES) return tooLarge();
      const buffer = fs.readFileSync(absolute);
      return { text: buffer.toString('utf8'), hash: hashOf(buffer) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw error;
    }
  };

  const conflict = (found: { text: string; hash: string }): ToolResult => ({
    ok: false,
    error: {
      category: 'rejected',
      message: 'base_hash does not match the current note; merge your change into the current version (details) and write again with its hash',
      details: { reason: 'hash_mismatch', content: found.text, hash: found.hash },
    },
  });

  const windowConflict = (found: { text: string; hash: string }, other: { run: string | null; at: string }): ToolResult => ({
    ok: false,
    error: {
      category: 'rejected',
      message: `another run (${other.run ?? 'unknown'}) wrote this note at ${other.at}, within brain.clash_window_ms; merge your change into the current version (details) and write again later`,
      details: { reason: 'window', content: found.text, hash: found.hash, run: other.run, at: other.at },
    },
  });

  /** Logs the rejection as a clash and builds the result. The window check goes first, then the hash. */
  const clashResult = (
    tool: BrainWriteEntry['tool'],
    args: Record<string, unknown>,
    context: AgentToolContext,
    audit: Audit,
    found: { text: string; hash: string },
    reason: BrainClashReason,
    other: { run: string | null; at: string | null },
  ): ToolResult => {
    audit.logged = true;
    access?.recordClash(
      {
        at: now().toISOString(),
        run: context.runId ?? null,
        issue: context.issue.identifier,
        role: context.role ?? null,
        op: tool === 'brain_write' ? 'write' : 'append',
        path_or_query: audit.path,
        purpose: purposeOf(args),
        result: 'rejected',
        hash_before: found.hash,
      },
      other,
      reason,
    );
    return reason === 'window' ? windowConflict(found, { run: other.run, at: other.at ?? '' }) : conflict(found);
  };

  /** Window check of a write to an existing note; null when the write may go on. */
  const windowCheck = (
    tool: BrainWriteEntry['tool'],
    args: Record<string, unknown>,
    context: AgentToolContext,
    audit: Audit,
    found: { text: string; hash: string },
  ): ToolResult | null => {
    const other = access?.recentWriteByOtherRun(audit.path, context.runId ?? null, now(), windowMs) ?? null;
    return other === null ? null : clashResult(tool, args, context, audit, found, 'window', other);
  };

  const finish = async (
    tool: BrainWriteEntry['tool'],
    args: Record<string, unknown>,
    context: AgentToolContext,
    audit: Audit,
    target: { absolute: string; relative: string },
    previous: { text: string; hash: string } | null,
    frontmatter: Record<string, unknown>,
    text: string,
  ): Promise<ToolResult> => {
    if (Buffer.byteLength(text) > MAX_NOTE_BYTES) return tooLarge();
    const versioning = options.versioning;
    if (versioning === undefined) return commitAndReport(tool, args, context, audit, target, previous, frontmatter, text);
    // One lock around take-over of manual changes, re-check, write and commit: no other session slips a file into this commit.
    return versioning.serial(async () => {
      try {
        await versioning.beforeWrite();
      } catch (error) {
        logger.error('brain vault commit failed', { tool, path: target.relative, error: errorMessage(error) });
        return fail('rejected', `vault git failed: ${errorMessage(error)}`);
      }
      const now = current(target.absolute);
      if (now !== null && 'ok' in now) return now;
      if (now?.hash !== previous?.hash) return now === null ? fail('rejected', 'note was removed while writing; read it again') : conflict(now);
      return commitAndReport(tool, args, context, audit, target, previous, frontmatter, text, versioning);
    });
  };

  const commitAndReport = async (
    tool: BrainWriteEntry['tool'],
    args: Record<string, unknown>,
    context: AgentToolContext,
    audit: Audit,
    target: { absolute: string; relative: string },
    previous: { text: string; hash: string } | null,
    frontmatter: Record<string, unknown>,
    text: string,
    versioning?: BrainVersioning,
  ): Promise<ToolResult> => {
    writeAtomic(target.absolute, text);
    const hash = hashOf(Buffer.from(text));
    const at = now().toISOString();
    // No await between the checks, the write and the index update: the next call sees this write.
    audit.logged = true;
    access?.recordWrite({
      at,
      run: context.runId ?? null,
      issue: context.issue.identifier,
      role: context.role ?? null,
      op: tool === 'brain_write' ? 'write' : 'append',
      path_or_query: target.relative,
      purpose: purposeOf(args),
      result: 'ok',
      ...(previous !== null ? { hash_before: previous.hash } : {}),
      hash_after: hash,
    });
    const entry: BrainWriteEntry = {
      tool,
      path: target.relative,
      purpose: typeof args.purpose === 'string' && args.purpose.trim() !== '' ? args.purpose.trim() : null,
      hash,
      previousHash: previous?.hash ?? null,
      created: previous === null,
      issue: context.issue.identifier,
      role: context.role ?? null,
      run: context.runId ?? null,
      at,
    };
    if (versioning !== undefined) {
      try {
        await versioning.commitWrite(entry);
      } catch (error) {
        try {
          if (previous === null) fs.rmSync(target.absolute, { force: true });
          else writeAtomic(target.absolute, previous.text);
        } catch (restoreError) {
          logger.error('brain write could not be rolled back', { path: target.relative, error: errorMessage(restoreError) });
        }
        logger.error('brain vault commit failed', { tool, path: target.relative, error: errorMessage(error) });
        return fail('rejected', `vault git failed: ${errorMessage(error)}`);
      }
    }
    try {
      await options.onWrite?.(entry);
    } catch (error) {
      logger.warn('brain onWrite hook failed', { tool, path: target.relative, error: errorMessage(error) });
    }
    return ok({ path: target.relative, hash, created: previous === null, frontmatter });
  };

  const stampOf = (context: AgentToolContext) => ({
    date: now().toISOString().slice(0, 10),
    issue: context.issue.identifier,
    ...(context.role !== undefined ? { role: context.role } : {}),
    ...(context.runId !== undefined ? { run: context.runId } : {}),
  });

  const guardedAsync =
    (tool: string, body: (args: Record<string, unknown>, context: AgentToolContext, audit: Audit) => Promise<ToolResult>): AgentToolSpec['execute'] =>
    async (args, context) => {
      warnPurpose(logger, tool, args, context);
      const audit: Audit = { path: String(args.path ?? ''), logged: false };
      let result: ToolResult;
      try {
        result = await body(args, context, audit);
      } catch (error) {
        result = fail('tool_error', errorMessage(error));
      }
      if (access !== null && !audit.logged) {
        const reason = reasonOf(result);
        const line: BrainAccess = {
          at: now().toISOString(),
          run: context.runId ?? null,
          issue: context.issue.identifier,
          role: context.role ?? null,
          op: tool === 'brain_write' ? 'write' : 'append',
          path_or_query: audit.path,
          purpose: purposeOf(args),
          result: result.ok ? 'ok' : 'rejected',
          ...(reason !== undefined ? { reason } : {}),
          ...(audit.hashBefore !== undefined ? { hash_before: audit.hashBefore } : {}),
        };
        access.record(line);
      }
      return result;
    };

  const WRITE_PURPOSE = z.string().optional().describe('Why you write to the vault (a few words); logged, please always give it');

  const write: AgentToolSpec = {
    name: 'brain_write',
    description:
      'Create or replace one note of the knowledge vault. path is relative, ends in .md (no .., nothing hidden such as .obsidian/, not README.md in the root). ' +
      'content is the whole file: a YAML frontmatter block with type (index|decision|lesson|issue|agent|note), optional repo (owner/name) and sources (list), then the body. ' +
      'Symphony sets status, issue, role, run, created and updated: a new note is always candidate; you cannot create or promote approved notes, and an existing approved note is read-only for agents (write a candidate note and link it). ' +
      'For an existing note pass base_hash (hash from brain_read); on a mismatch nothing is written and the error details hold the current content and hash. ' +
      'Returns {path, hash, created, frontmatter}. To add to a note, prefer brain_append.',
    inputSchema: {
      path: z.string().describe('Path relative to the vault, e.g. Lessons/caching.md'),
      content: z.string().describe('The whole note including frontmatter'),
      purpose: WRITE_PURPOSE,
      base_hash: z.string().optional().describe('Hash of the version you read; needed for an existing note'),
    },
    mutates: true,
    execute: guardedAsync('brain_write', async (args, context, audit) => {
      const target = resolveVaultWritePath(vaultPath, args.path);
      if (!target.ok) return fail('rejected', target.message);
      if (typeof args.content !== 'string') return fail('invalid_argument', 'content must be a string');
      if (Buffer.byteLength(args.content) > MAX_NOTE_BYTES) return tooLarge();
      const found = current(target.absolute);
      if (found !== null && 'ok' in found) return found;
      audit.path = target.relative;
      if (found !== null) {
        audit.hashBefore = found.hash;
        const windowed = windowCheck('brain_write', args, context, audit, found);
        if (windowed !== null) return windowed;
      }
      const baseHash = typeof args.base_hash === 'string' && args.base_hash.trim() !== '' ? args.base_hash.trim().toLowerCase() : null;
      if (found === null) {
        if (baseHash !== null) return fail('rejected', 'note does not exist; omit base_hash to create it');
      } else if (baseHash === null) {
        logger.warn('brain write without base_hash', { tool: 'brain_write', path: target.relative, issue: context.issue.identifier });
      } else if (baseHash !== found.hash) {
        return clashResult('brain_write', args, context, audit, found, 'hash_mismatch', access?.lastWrite(target.relative) ?? { run: null, at: null });
      }
      const parsed = parseNote(args.content);
      if (parsed.frontmatterError !== null) return fail('rejected', `frontmatter is not valid YAML: ${parsed.frontmatterError}`);
      if (parsed.frontmatterText === '' && Object.keys(parsed.frontmatter).length === 0) {
        return fail('rejected', 'note needs a YAML frontmatter block (--- … ---) with type');
      }
      const existing = found === null ? null : parseNote(found.text).frontmatter;
      const prepared = prepareFrontmatter(parsed.frontmatter, existing, stampOf(context));
      if (!prepared.ok) return fail('rejected', prepared.message);
      return finish('brain_write', args, context, audit, target, found, prepared.frontmatter, serializeNote(prepared.frontmatter, parsed.body));
    }),
  };

  const append: AgentToolSpec = {
    name: 'brain_append',
    description:
      'Append text to an existing note of the knowledge vault, at the end of the section under the heading (the heading is created at the end of the note if it is missing). ' +
      'base_hash (hash from brain_read) is required; on a mismatch nothing is written and the error details hold the current content and hash. ' +
      'Symphony sets updated; the status stays. Approved notes cannot be appended to (write a candidate note instead). Returns {path, hash, created: false, frontmatter}.',
    inputSchema: {
      path: z.string().describe('Path relative to the vault, e.g. Lessons/caching.md'),
      heading: z.string().min(1).describe('Heading of the section, e.g. "Findings" (taken as "## Findings"; "### Sub" keeps its level)'),
      text: z.string().min(1).describe('Markdown to add to the section'),
      purpose: WRITE_PURPOSE,
      base_hash: z.string().describe('Hash of the version you read'),
    },
    mutates: true,
    execute: guardedAsync('brain_append', async (args, context, audit) => {
      const baseHash = typeof args.base_hash === 'string' ? args.base_hash.trim().toLowerCase() : '';
      if (baseHash === '') return fail('invalid_argument', 'base_hash is required; read the note with brain_read first');
      if (typeof args.heading !== 'string' || args.heading.trim() === '') return fail('invalid_argument', 'heading must not be empty');
      if (typeof args.text !== 'string' || args.text.trim() === '') return fail('invalid_argument', 'text must not be empty');
      const target = resolveVaultWritePath(vaultPath, args.path);
      if (!target.ok) return fail('rejected', target.message);
      const found = current(target.absolute);
      if (found === null) return fail('not_found', 'brain_append needs an existing note; create it with brain_write');
      if ('ok' in found) return found;
      audit.path = target.relative;
      audit.hashBefore = found.hash;
      const windowed = windowCheck('brain_append', args, context, audit, found);
      if (windowed !== null) return windowed;
      if (baseHash !== found.hash) {
        return clashResult('brain_append', args, context, audit, found, 'hash_mismatch', access?.lastWrite(target.relative) ?? { run: null, at: null });
      }
      const parsed = parseNote(found.text);
      if (parsed.frontmatterError !== null) return fail('rejected', `frontmatter of the note is not valid YAML: ${parsed.frontmatterError}`);
      const prepared = prepareFrontmatter(parsed.frontmatter, parsed.frontmatter, stampOf(context));
      if (!prepared.ok) return fail('rejected', prepared.message);
      const body = appendUnderHeading(parsed.body, args.heading, args.text);
      return finish('brain_append', args, context, audit, target, found, prepared.frontmatter, serializeNote(prepared.frontmatter, body));
    }),
  };

  return [write, append];
}
