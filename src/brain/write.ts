import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Logger } from '../log.ts';
import type { AgentToolContext, AgentToolSpec, ToolResult } from '../tracker/types.ts';
import { errorMessage } from '../util/errors.ts';
import { fail, hashOf, MAX_NOTE_BYTES, ok, warnPurpose } from './common.ts';
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

export interface BrainWriteOptions {
  /** Called after every successful write; an error is only logged. */
  onWrite?: (entry: BrainWriteEntry) => void | Promise<void>;
  /** Clock, for tests. */
  now?: () => Date;
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
      details: { content: found.text, hash: found.hash },
    },
  });

  const finish = async (
    tool: BrainWriteEntry['tool'],
    args: Record<string, unknown>,
    context: AgentToolContext,
    target: { absolute: string; relative: string },
    previous: { hash: string } | null,
    frontmatter: Record<string, unknown>,
    text: string,
  ): Promise<ToolResult> => {
    if (Buffer.byteLength(text) > MAX_NOTE_BYTES) return tooLarge();
    writeAtomic(target.absolute, text);
    const hash = hashOf(Buffer.from(text));
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
      at: now().toISOString(),
    };
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
    (tool: string, body: (args: Record<string, unknown>, context: AgentToolContext) => Promise<ToolResult>): AgentToolSpec['execute'] =>
    async (args, context) => {
      warnPurpose(logger, tool, args, context);
      try {
        return await body(args, context);
      } catch (error) {
        return fail('tool_error', errorMessage(error));
      }
    };

  const WRITE_PURPOSE = z.string().optional().describe('Why you write to the vault (a few words); logged, please always give it');

  const write: AgentToolSpec = {
    name: 'brain_write',
    description:
      'Create or replace one note of the knowledge vault. path is relative, ends in .md (no .., nothing hidden such as .obsidian/, not README.md in the root). ' +
      'content is the whole file: a YAML frontmatter block with type (index|decision|lesson|issue|agent|note), optional repo (owner/name) and sources (list), then the body. ' +
      'Symphony sets status, issue, role, run, created and updated: a new note is always candidate; you cannot create or promote approved notes, and an approved note stays approved. ' +
      'For an existing note pass base_hash (hash from brain_read); on a mismatch nothing is written and the error details hold the current content and hash. ' +
      'Returns {path, hash, created, frontmatter}. To add to a note, prefer brain_append.',
    inputSchema: {
      path: z.string().describe('Path relative to the vault, e.g. Lessons/caching.md'),
      content: z.string().describe('The whole note including frontmatter'),
      purpose: WRITE_PURPOSE,
      base_hash: z.string().optional().describe('Hash of the version you read; needed for an existing note'),
    },
    mutates: true,
    execute: guardedAsync('brain_write', async (args, context) => {
      const target = resolveVaultWritePath(vaultPath, args.path);
      if (!target.ok) return fail('rejected', target.message);
      if (typeof args.content !== 'string') return fail('invalid_argument', 'content must be a string');
      if (Buffer.byteLength(args.content) > MAX_NOTE_BYTES) return tooLarge();
      const found = current(target.absolute);
      if (found !== null && 'ok' in found) return found;
      const baseHash = typeof args.base_hash === 'string' && args.base_hash.trim() !== '' ? args.base_hash.trim().toLowerCase() : null;
      if (found === null) {
        if (baseHash !== null) return fail('rejected', 'note does not exist; omit base_hash to create it');
      } else if (baseHash === null) {
        logger.warn('brain write without base_hash', { tool: 'brain_write', path: target.relative, issue: context.issue.identifier });
      } else if (baseHash !== found.hash) {
        return conflict(found);
      }
      const parsed = parseNote(args.content);
      if (parsed.frontmatterError !== null) return fail('rejected', `frontmatter is not valid YAML: ${parsed.frontmatterError}`);
      if (parsed.frontmatterText === '' && Object.keys(parsed.frontmatter).length === 0) {
        return fail('rejected', 'note needs a YAML frontmatter block (--- … ---) with type');
      }
      const existing = found === null ? null : parseNote(found.text).frontmatter;
      const prepared = prepareFrontmatter(parsed.frontmatter, existing, stampOf(context));
      if (!prepared.ok) return fail('rejected', prepared.message);
      return finish('brain_write', args, context, target, found, prepared.frontmatter, serializeNote(prepared.frontmatter, parsed.body));
    }),
  };

  const append: AgentToolSpec = {
    name: 'brain_append',
    description:
      'Append text to an existing note of the knowledge vault, at the end of the section under the heading (the heading is created at the end of the note if it is missing). ' +
      'base_hash (hash from brain_read) is required; on a mismatch nothing is written and the error details hold the current content and hash. ' +
      'Symphony sets updated; the status stays. Returns {path, hash, created: false, frontmatter}.',
    inputSchema: {
      path: z.string().describe('Path relative to the vault, e.g. Lessons/caching.md'),
      heading: z.string().min(1).describe('Heading of the section, e.g. "Findings" (taken as "## Findings"; "### Sub" keeps its level)'),
      text: z.string().min(1).describe('Markdown to add to the section'),
      purpose: WRITE_PURPOSE,
      base_hash: z.string().describe('Hash of the version you read'),
    },
    mutates: true,
    execute: guardedAsync('brain_append', async (args, context) => {
      const baseHash = typeof args.base_hash === 'string' ? args.base_hash.trim().toLowerCase() : '';
      if (baseHash === '') return fail('invalid_argument', 'base_hash is required; read the note with brain_read first');
      if (typeof args.heading !== 'string' || args.heading.trim() === '') return fail('invalid_argument', 'heading must not be empty');
      if (typeof args.text !== 'string' || args.text.trim() === '') return fail('invalid_argument', 'text must not be empty');
      const target = resolveVaultWritePath(vaultPath, args.path);
      if (!target.ok) return fail('rejected', target.message);
      const found = current(target.absolute);
      if (found === null) return fail('not_found', 'brain_append needs an existing note; create it with brain_write');
      if ('ok' in found) return found;
      if (baseHash !== found.hash) return conflict(found);
      const parsed = parseNote(found.text);
      if (parsed.frontmatterError !== null) return fail('rejected', `frontmatter of the note is not valid YAML: ${parsed.frontmatterError}`);
      const prepared = prepareFrontmatter(parsed.frontmatter, parsed.frontmatter, stampOf(context));
      if (!prepared.ok) return fail('rejected', prepared.message);
      const body = appendUnderHeading(parsed.body, args.heading, args.text);
      return finish('brain_append', args, context, target, found, prepared.frontmatter, serializeNote(prepared.frontmatter, body));
    }),
  };

  return [write, append];
}
