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
