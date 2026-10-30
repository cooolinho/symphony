import YAML from 'yaml';

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  /** The raw text of the frontmatter block (empty without one). */
  frontmatterText: string;
  body: string;
  frontmatterError: string | null;
}

/** Splits a note into frontmatter and body. Never throws: broken YAML gives `{}` and an error text. */
export function parseNote(text: string): ParsedNote {
  const source = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = /^---[ \t]*\n([\s\S]*?)\n?---[ \t]*(?:\n|$)/.exec(source);
  if (match === null) return { frontmatter: {}, frontmatterText: '', body: source, frontmatterError: null };
  const frontmatterText = match[1] ?? '';
  const body = source.slice(match[0].length);
  try {
    const parsed: unknown = YAML.parse(frontmatterText);
    if (parsed === null || parsed === undefined) return { frontmatter: {}, frontmatterText, body, frontmatterError: null };
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { frontmatter: {}, frontmatterText, body, frontmatterError: 'frontmatter is not a mapping' };
    }
    return { frontmatter: parsed as Record<string, unknown>, frontmatterText, body, frontmatterError: null };
  } catch (error) {
    return { frontmatter: {}, frontmatterText, body, frontmatterError: error instanceof Error ? error.message : String(error) };
  }
}

export function noteTitle(frontmatter: Record<string, unknown>, body: string, fileName: string): string {
  const title = frontmatter.title;
  if (typeof title === 'string' && title.trim() !== '') return title.trim();
  const heading = /^#[ \t]+(.+?)[ \t]*$/m.exec(body);
  if (heading?.[1]) return heading[1];
  return fileName.replace(/\.md$/i, '');
}

export function noteStatus(frontmatter: Record<string, unknown>): string | null {
  const status = frontmatter.status;
  return typeof status === 'string' && status.trim() !== '' ? status.trim().toLowerCase() : null;
}

export const NOTE_TYPES = ['index', 'decision', 'lesson', 'issue', 'agent', 'note'] as const;
export const NOTE_STATUSES = ['candidate', 'approved', 'deprecated'] as const;
const FRONTMATTER_ORDER = ['type', 'status', 'repo', 'issue', 'role', 'run', 'created', 'updated', 'sources'];

export interface FrontmatterStamp {
  /** Today as YYYY-MM-DD (UTC). */
  date: string;
  issue: string;
  role?: string;
  run?: string;
}

export type PreparedFrontmatter = { ok: true; frontmatter: Record<string, unknown> } | { ok: false; message: string };

function dateOf(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return null;
}

/**
 * Checks the frontmatter an agent wrote and adds what Symphony knows: issue, role, run, created, updated. A new note is
 * always `candidate`; an agent neither creates nor promotes `approved` notes and cannot demote one. Unknown fields stay.
 */
export function prepareFrontmatter(
  input: Record<string, unknown>,
  existing: Record<string, unknown> | null,
  stamp: FrontmatterStamp,
): PreparedFrontmatter {
  const reject = (message: string): PreparedFrontmatter => ({ ok: false, message });
  const type = typeof input.type === 'string' ? input.type.trim().toLowerCase() : '';
  if (!(NOTE_TYPES as readonly string[]).includes(type)) return reject(`frontmatter needs type: one of ${NOTE_TYPES.join('|')}`);
  if (input.sources !== undefined && !Array.isArray(input.sources)) return reject('sources must be a list');
  if (input.repo !== undefined && input.repo !== null && typeof input.repo !== 'string') return reject('repo must be a string (owner/name)');
  let status: string | null = null;
  if (input.status !== undefined && input.status !== null) {
    status = typeof input.status === 'string' ? input.status.trim().toLowerCase() : '';
    if (!(NOTE_STATUSES as readonly string[]).includes(status)) return reject(`status must be one of ${NOTE_STATUSES.join('|')}`);
  }
  let next: string;
  if (existing === null) {
    if (status === 'approved') return reject('agents cannot create approved notes; new notes start as candidate');
    next = 'candidate';
  } else {
    const old = noteStatus(existing);
    next = status ?? old ?? 'candidate';
    if (old === 'approved' && next !== 'approved') return reject('an approved note keeps status approved; only a human changes it');
    if (old !== 'approved' && next === 'approved') return reject('only a human promotes a note to approved');
  }
  const frontmatter: Record<string, unknown> = { ...input, type, status: next, issue: stamp.issue, updated: stamp.date };
  frontmatter.created = (existing !== null ? dateOf(existing.created) : null) ?? stamp.date;
  if (stamp.role !== undefined) frontmatter.role = stamp.role;
  else delete frontmatter.role;
  if (stamp.run !== undefined) frontmatter.run = stamp.run;
  else delete frontmatter.run;
  return { ok: true, frontmatter };
}

/** `---` frontmatter `---` body; known keys first in a fixed order, the rest as given. The body ends with one newline. */
export function serializeNote(frontmatter: Record<string, unknown>, body: string): string {
  const sorted: Record<string, unknown> = {};
  for (const key of FRONTMATTER_ORDER) if (frontmatter[key] !== undefined) sorted[key] = frontmatter[key];
  for (const [key, value] of Object.entries(frontmatter)) if (!(key in sorted) && value !== undefined) sorted[key] = value;
  return `---\n${YAML.stringify(sorted)}---\n${body.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '')}\n`;
}

/** Adds `text` at the end of the section under `heading` (`## heading` unless it starts with `#`); creates the section at the end if missing. */
export function appendUnderHeading(body: string, heading: string, text: string): string {
  const title = heading.trim().startsWith('#') ? heading.trim() : `## ${heading.trim()}`;
  const level = /^#+/.exec(title)?.[0].length ?? 2;
  const lines = body.replace(/\s+$/, '').split('\n');
  const at = lines.findIndex((line) => line.trimEnd() === title);
  const addition = text.replace(/\s+$/, '');
  if (at < 0) return `${lines.join('\n')}\n\n${title}\n\n${addition}\n`.replace(/^\n+/, '');
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    const match = /^(#+)[ \t]/.exec(lines[i] ?? '');
    if (match !== null && (match[1]?.length ?? 99) <= level) {
      end = i;
      break;
    }
  }
  let insert = end;
  while (insert > at + 1 && (lines[insert - 1] ?? '').trim() === '') insert--;
  const before = lines.slice(0, insert);
  const after = lines.slice(end);
  const tail = after.length > 0 ? ['', ...after] : [];
  return `${[...before, '', ...addition.split('\n'), ...tail].join('\n')}\n`;
}
