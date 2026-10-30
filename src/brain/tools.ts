import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Logger } from '../log.ts';
import type { AgentToolContext, AgentToolSpec, ToolResult } from '../tracker/types.ts';
import { errorMessage } from '../util/errors.ts';
import type { BrainConfig } from '../workflow/config.ts';
import type { BrainMode } from '../workflow/roles.ts';
import type { BrainAccessLog, BrainAccessOp } from './access-log.ts';
import { fail, hashOf, MAX_NOTE_BYTES, ok, purposeOf, reasonOf, warnPurpose } from './common.ts';
import { noteStatus, noteTitle, parseNote } from './note.ts';
import { resolveVaultPath } from './paths.ts';
import { createBrainWriteTools, type BrainWriteOptions } from './write.ts';

export { createVaultGit, type VaultCommitHook } from './git.ts';
export type { BrainVersioning } from './write.ts';

export const MAX_SEARCH_RESULTS = 20;
const EXCERPT_CHARS = 200;

function fsFailure(error: unknown): ToolResult {
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return fail('not_found', 'no such file or folder in the vault');
  return fail('tool_error', errorMessage(error));
}

const PURPOSE = z.string().optional().describe('Why you read the vault (a few words); logged, please always give it');

/** All `.md` files below `dir` (vault-relative paths); hidden entries, symlinks and oversized files are skipped. */
function walkNotes(vault: string, dir: string = vault): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkNotes(vault, full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      if (fs.statSync(full).size <= MAX_NOTE_BYTES) found.push(path.relative(vault, full).split(path.sep).join('/'));
    }
  }
  return found;
}

function excerptOf(body: string, words: string[]): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const at = words.map((word) => lower.indexOf(word)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (at === undefined) return flat.slice(0, EXCERPT_CHARS);
  const start = Math.max(0, at - EXCERPT_CHARS / 2);
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + EXCERPT_CHARS)}`;
}

function statusRank(status: string | null): number {
  return status === 'approved' ? 0 : status === 'candidate' ? 1 : 2;
}

function fieldEquals(value: unknown, wanted: string): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === wanted.trim().toLowerCase();
}

/** Read tools of the knowledge vault. Everything runs synchronously on the file system; there is no index. */
export function createBrainTools(vaultPath: string, logger: Logger, access: BrainAccessLog | null = null): AgentToolSpec[] {
  const guarded =
    (
      tool: string,
      op: BrainAccessOp,
      subject: (args: Record<string, unknown>) => string,
      body: (args: Record<string, unknown>) => ToolResult,
    ): AgentToolSpec['execute'] =>
    async (args, context) => {
      warnPurpose(logger, tool, args, context);
      let result: ToolResult;
      try {
        result = body(args);
      } catch (error) {
        result = fail('tool_error', errorMessage(error));
      }
      if (access !== null) {
        const reason = reasonOf(result);
        access.record({
          at: new Date().toISOString(),
          run: context.runId ?? null,
          issue: context.issue.identifier,
          role: context.role ?? null,
          op,
          path_or_query: subject(args),
          purpose: purposeOf(args),
          result: result.ok ? 'ok' : 'rejected',
          ...(reason !== undefined ? { reason } : {}),
        });
      }
      return result;
    };

  const pathSubject = (args: Record<string, unknown>, key: string, allowRoot: boolean): string => {
    const resolved = resolveVaultPath(vaultPath, args[key] ?? '', { allowRoot });
    return resolved.ok ? resolved.relative : String(args[key] ?? '');
  };

  const search: AgentToolSpec = {
    name: 'brain_search',
    description:
      'Search the knowledge vault (title, frontmatter and full text of all .md notes, case-insensitive; every word of the query must occur). ' +
      'Notes with status approved come first, then candidate (not yet confirmed knowledge, treat with care); deprecated notes are never returned. ' +
      `At most ${MAX_SEARCH_RESULTS} hits. Optional filters: repo (frontmatter repo, owner/name) and type (frontmatter type). ` +
      'Returns {results: [{path, title, status, excerpt}], total}. Read a hit with brain_read.',
    inputSchema: {
      query: z.string().min(1).describe('Words to search for'),
      repo: z.string().optional().describe('Only notes with this frontmatter repo'),
      type: z.string().optional().describe('Only notes with this frontmatter type'),
      purpose: PURPOSE,
    },
    mutates: false,
    execute: guarded('brain_search', 'search', (args) => String(args.query ?? ''), (args) => {
      const words = String(args.query ?? '').toLowerCase().split(/\s+/).filter((word) => word !== '');
      if (words.length === 0) return fail('invalid_argument', 'query must contain a word');
      const repo = typeof args.repo === 'string' && args.repo !== '' ? args.repo : null;
      const type = typeof args.type === 'string' && args.type !== '' ? args.type : null;
      const hits: Array<{ path: string; title: string; status: string | null; excerpt: string; rank: number; score: number }> = [];
      for (const rel of walkNotes(vaultPath)) {
        const text = fs.readFileSync(path.join(vaultPath, ...rel.split('/')), 'utf8');
        const note = parseNote(text);
        const status = noteStatus(note.frontmatter);
        if (status === 'deprecated') continue;
        if (repo !== null && !fieldEquals(note.frontmatter.repo, repo)) continue;
        if (type !== null && !fieldEquals(note.frontmatter.type, type)) continue;
        const title = noteTitle(note.frontmatter, note.body, path.posix.basename(rel));
        const titleLower = title.toLowerCase();
        const frontLower = note.frontmatterText.toLowerCase();
        const bodyLower = note.body.toLowerCase();
        let score = 0;
        let matchedAll = true;
        for (const word of words) {
          const inTitle = titleLower.includes(word);
          const inFront = frontLower.includes(word);
          const inBody = bodyLower.includes(word);
          if (!inTitle && !inFront && !inBody) {
            matchedAll = false;
            break;
          }
          score += (inTitle ? 3 : 0) + (inFront ? 2 : 0) + (inBody ? 1 : 0);
        }
        if (!matchedAll) continue;
        hits.push({ path: rel, title, status, excerpt: excerptOf(note.body, words), rank: statusRank(status), score });
      }
      hits.sort((a, b) => a.rank - b.rank || b.score - a.score || a.path.localeCompare(b.path));
      const results = hits.slice(0, MAX_SEARCH_RESULTS).map(({ path: p, title, status, excerpt }) => ({ path: p, title, status, excerpt }));
      return ok({ results, total: hits.length });
    }),
  };

  const read: AgentToolSpec = {
    name: 'brain_read',
    description:
      'Read one note of the knowledge vault. path is relative to the vault (no .., no absolute path, nothing under .obsidian/). ' +
      'Returns {path, content, frontmatter, frontmatter_error, hash}; hash is the SHA-256 of the file and is needed for later writes.',
    inputSchema: { path: z.string().describe('Path relative to the vault, e.g. Lessons/caching.md'), purpose: PURPOSE },
    mutates: false,
    execute: guarded('brain_read', 'read', (args) => pathSubject(args, 'path', false), (args) => {
      const resolved = resolveVaultPath(vaultPath, args.path);
      if (!resolved.ok) return fail('rejected', resolved.message);
      try {
        const stat = fs.statSync(resolved.absolute);
        if (!stat.isFile()) return fail('invalid_argument', 'path is not a file');
        if (stat.size > MAX_NOTE_BYTES) return fail('too_large', `note is larger than ${MAX_NOTE_BYTES} bytes`);
        const buffer = fs.readFileSync(resolved.absolute);
        const note = parseNote(buffer.toString('utf8'));
        return ok({
          path: resolved.relative,
          content: buffer.toString('utf8'),
          frontmatter: note.frontmatter,
          frontmatter_error: note.frontmatterError,
          hash: hashOf(buffer),
        });
      } catch (error) {
        return fsFailure(error);
      }
    }),
  };

  const list: AgentToolSpec = {
    name: 'brain_list',
    description:
      'List a folder of the knowledge vault. folder is relative to the vault; empty or missing means the vault root. ' +
      'Returns {folder, entries: [{name, path, kind: folder|file, type, status}]}: folders first; type and status come from the frontmatter of .md files. ' +
      'Hidden entries (.obsidian/ and others) are not listed.',
    inputSchema: { folder: z.string().optional().describe('Folder relative to the vault; empty = root'), purpose: PURPOSE },
    mutates: false,
    execute: guarded('brain_list', 'list', (args) => pathSubject(args, 'folder', true), (args) => {
      const resolved = resolveVaultPath(vaultPath, args.folder ?? '', { allowRoot: true });
      if (!resolved.ok) return fail('rejected', resolved.message);
      try {
        if (!fs.statSync(resolved.absolute).isDirectory()) return fail('invalid_argument', 'path is not a folder');
        const entries = fs
          .readdirSync(resolved.absolute, { withFileTypes: true })
          .filter((entry) => !entry.name.startsWith('.') && !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
          .map((entry) => {
            const rel = resolved.relative === '' ? entry.name : `${resolved.relative}/${entry.name}`;
            let type: string | null = null;
            let status: string | null = null;
            if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
              const full = path.join(resolved.absolute, entry.name);
              if (fs.statSync(full).size <= MAX_NOTE_BYTES) {
                const { frontmatter } = parseNote(fs.readFileSync(full, 'utf8'));
                type = typeof frontmatter.type === 'string' ? frontmatter.type : null;
                status = noteStatus(frontmatter);
              }
            }
            return { name: entry.name, path: rel, kind: entry.isDirectory() ? ('folder' as const) : ('file' as const), type, status };
          })
          .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1));
        return ok({ folder: resolved.relative, entries });
      } catch (error) {
        return fsFailure(error);
      }
    }),
  };

  return [search, read, list];
}

export { createBrainWriteTools, type BrainWriteEntry, type BrainWriteOptions } from './write.ts';

/** The brain tools of a session: none unless `brain.enabled` and the role's mode is not `off`; `read` has the read tools, `write` also the write tools. */
export function brainToolsFor(
  config: Omit<BrainConfig, 'clashWindowMs'> & { clashWindowMs?: number },
  mode: BrainMode,
  logger: Logger,
  options: BrainWriteOptions = {},
): AgentToolSpec[] {
  if (!config.enabled || mode === 'off') return [];
  const readTools = createBrainTools(config.path, logger, options.access ?? null);
  if (mode === 'read') return readTools;
  const writeOptions: BrainWriteOptions =
    config.clashWindowMs === undefined ? options : { ...options, clashWindowMs: options.clashWindowMs ?? config.clashWindowMs };
  return [...readTools, ...createBrainWriteTools(config.path, logger, writeOptions)];
}
