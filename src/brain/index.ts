import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Logger } from '../log.ts';
import { isRepositoryName } from '../tracker/github-project/settings.ts';
import { errorMessage } from '../util/errors.ts';
import { MAX_NOTE_BYTES } from './common.ts';
import { noteStatus, noteTitle, parseNote } from './note.ts';
import { repoFolderName } from './vault.ts';

export interface IndexedNote {
  title: string;
  type: string | null;
  status: string | null;
  repo: string | null;
  issue: string | null;
  role: string | null;
  created: string | null;
  updated: string | null;
  target: string | null;
  /** First lines of the body; only set for candidates. */
  preview?: string;
  /** Normalized link targets (`Folder/name.md`, as written), without duplicates. */
  links: string[];
}

export interface VaultIndex {
  /** Keys are paths relative to the vault with `/`. */
  notes: Map<string, IndexedNote>;
  /** Target path to the sorted paths of the notes linking to it. */
  backlinks: Map<string, string[]>;
  orphans: string[];
  broken: { from: string; link: string }[];
  /** Number of resolved, distinct (source, target) pairs without self links. */
  links: number;
}

export interface BrainVitalCounts {
  notes_by_status: { candidate: number; approved: number; deprecated: number; none: number };
  links: number;
  orphans: number;
  broken_links: number;
  candidates: number;
}

export interface BrainFolder {
  /** Relative to the vault, without a trailing slash. */
  path: string;
  notes_by_status: { candidate: number; approved: number; deprecated: number; none: number };
  total: number;
}

/** Vitals derived from the counts: notes by status with their total, links with the links per note. */
export interface BrainVitalsDerived {
  notes: { total: number; approved: number; candidate: number; deprecated: number; none: number };
  /** `per_note` is links / notes with one decimal; 0 without notes. */
  links: { total: number; per_note: number };
}

export interface BrainVitals extends Omit<BrainVitalCounts, 'links'>, BrainVitalsDerived {
  /** `brain.path`. */
  path: string;
  obsidian_url: string | null;
  folders: BrainFolder[];
  writes_today: number;
  /** `by_folder`: `op: read` calls per first-level folder, most first; `pct` relative to `total`. */
  reads_today: { total: number; by_folder: { folder: string; reads: number; pct: number }[] };
  /** Clashes rejected in the last 7 days and how many of them are resolved. */
  clashes: { week: { total: number; resolved: number } };
  /** Number of vault commits; 0 without git. */
  commits: { total: number };
  /** `brain.clash_window_ms` in minutes (rounded). */
  clash_window_min: number;
  last_commit: { sha: string; at: string; author: string } | null;
}

export interface BrainCandidate {
  path: string;
  title: string;
  type: string | null;
  repo: string | null;
  issue: string | null;
  role: string | null;
  created: string | null;
  target: string;
  /** The first lines of the body, without frontmatter. */
  preview: string;
}

/** Text of a frontmatter value: a trimmed non-empty string, a number, or a date as YYYY-MM-DD; otherwise null. */
export function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return null;
}

function lowerText(value: unknown): string | null {
  return textOf(value)?.toLowerCase() ?? null;
}

/** Link targets of a note body, normalized; skips code fences, attachments and pure section links. */
export function extractLinks(body: string): string[] {
  const found = new Set<string>();
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    for (const match of line.replace(/`[^`]*`/g, '').matchAll(/\[\[([^[\]]+)\]\]/g)) {
      let target = (match[1] ?? '').split('|')[0] ?? '';
      target = (target.split('#')[0] ?? '').trim().replace(/^\/+/, '');
      if (target === '') continue;
      const last = target.split('/').pop() ?? '';
      const extension = /\.([a-z0-9]{1,5})$/i.exec(last)?.[1];
      if (extension !== undefined && extension.toLowerCase() !== 'md') continue;
      found.add(/\.md$/i.test(target) ? target : `${target}.md`);
    }
  }
  return [...found];
}

const PREVIEW_LINES = 10;

/** The first lines of a body without leading blank lines, at most 2000 characters. */
function previewOf(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && (lines[0] ?? '').trim() === '') lines.shift();
  return lines.slice(0, PREVIEW_LINES).join('\n').slice(0, 2000).trimEnd();
}

const EMPTY_FIELDS = { type: null, status: null, repo: null, issue: null, role: null, created: null, updated: null, target: null };

/** Reads one note; null when the file does not exist. An unreadable or too large file gives a note without fields and links. */
function readNoteSync(vault: string, rel: string): IndexedNote | null {
  const file = path.join(vault, ...rel.split('/'));
  const fallback = (): IndexedNote => ({ ...EMPTY_FIELDS, title: path.posix.basename(rel).replace(/\.md$/i, ''), links: [] });
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_NOTE_BYTES) return fallback();
    const { frontmatter, body } = parseNote(fs.readFileSync(file, 'utf8'));
    const status = noteStatus(frontmatter);
    return {
      title: noteTitle(frontmatter, body, path.posix.basename(rel)),
      type: lowerText(frontmatter.type),
      status,
      repo: textOf(frontmatter.repo),
      issue: textOf(frontmatter.issue),
      role: textOf(frontmatter.role),
      created: textOf(frontmatter.created),
      updated: textOf(frontmatter.updated),
      target: textOf(frontmatter.target),
      links: extractLinks(body),
      ...(status === 'candidate' ? { preview: previewOf(body) } : {}),
    };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : fallback();
  }
}

function walk(root: string, rel: string, out: string[]): void {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, ...(rel === '' ? [] : rel.split('/'))), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) walk(root, child, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(child);
  }
}

function readAll(vault: string, paths: string[], notes: Map<string, IndexedNote>): void {
  for (const rel of paths) {
    const note = readNoteSync(vault, rel);
    if (note) notes.set(rel, note);
    else notes.delete(rel);
  }
}

const ORPHAN_EXEMPT = /^Repos\/[^/]+\/index\.md$/;

/**
 * Backlinks, orphans and broken links from the notes. A link resolves by its full path (case-insensitive), or, without a
 * `/`, by a unique file name anywhere in the vault; an ambiguous file name is broken. Self links do not count.
 * `Repos/<repo>/index.md` and the root `README.md` are never orphans.
 */
export function deriveIndex(notes: Map<string, IndexedNote>): VaultIndex {
  const byPath = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const rel of notes.keys()) {
    byPath.set(rel.toLowerCase(), rel);
    const name = (rel.split('/').pop() ?? rel).toLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), rel]);
  }
  const incoming = new Map<string, Set<string>>();
  const broken: { from: string; link: string }[] = [];
  let links = 0;
  for (const [from, note] of notes) {
    for (const link of note.links) {
      let target = byPath.get(link.toLowerCase());
      if (target === undefined && !link.includes('/')) {
        const candidates = byName.get(link.toLowerCase());
        if (candidates?.length === 1) target = candidates[0];
      }
      if (target === undefined) {
        broken.push({ from, link });
        continue;
      }
      if (target === from) continue;
      const set = incoming.get(target) ?? new Set<string>();
      if (!set.has(from)) links++;
      set.add(from);
      incoming.set(target, set);
    }
  }
  const backlinks = new Map<string, string[]>();
  for (const [target, sources] of [...incoming].sort(([a], [b]) => a.localeCompare(b))) backlinks.set(target, [...sources].sort());
  const orphans = [...notes.keys()].filter((rel) => !incoming.has(rel) && !ORPHAN_EXEMPT.test(rel) && rel !== 'README.md').sort();
  broken.sort((a, b) => a.from.localeCompare(b.from) || a.link.localeCompare(b.link));
  return { notes, backlinks, orphans, broken, links };
}

/** Reads every `.md` of the vault (not below a folder or file starting with `.`). Never throws; a missing vault is empty. */
export async function buildIndex(vault: string): Promise<VaultIndex> {
  const paths: string[] = [];
  walk(vault, '', paths);
  paths.sort();
  const notes = new Map<string, IndexedNote>();
  readAll(vault, paths, notes);
  return deriveIndex(notes);
}

export function vitalsCounts(index: VaultIndex): BrainVitalCounts {
  const notesByStatus = { candidate: 0, approved: 0, deprecated: 0, none: 0 };
  for (const note of index.notes.values()) {
    const status = note.status;
    if (status === 'candidate' || status === 'approved' || status === 'deprecated') notesByStatus[status]++;
    else notesByStatus.none++;
  }
  return {
    notes_by_status: notesByStatus,
    links: index.links,
    orphans: index.orphans.length,
    broken_links: index.broken.length,
    candidates: notesByStatus.candidate,
  };
}

/** `notes` and `links` of the vitals, from the counts of the index (no second pass over the files). */
export function vitalsDerived(counts: BrainVitalCounts): BrainVitalsDerived {
  const byStatus = counts.notes_by_status;
  const total = byStatus.approved + byStatus.candidate + byStatus.deprecated + byStatus.none;
  return {
    notes: { total, ...byStatus },
    links: { total: counts.links, per_note: total === 0 ? 0 : Math.round((counts.links / total) * 10) / 10 },
  };
}

/** One entry per folder with notes (also in subfolders) and per parent folder; counts are recursive, notes in the vault root count nowhere. */
export function foldersOf(index: VaultIndex): BrainFolder[] {
  const folders = new Map<string, BrainFolder>();
  for (const [rel, note] of index.notes) {
    const segments = rel.split('/').slice(0, -1);
    const key = note.status === 'candidate' || note.status === 'approved' || note.status === 'deprecated' ? note.status : 'none';
    for (let depth = 1; depth <= segments.length; depth++) {
      const folder = segments.slice(0, depth).join('/');
      let entry = folders.get(folder);
      if (entry === undefined) {
        entry = { path: folder, notes_by_status: { candidate: 0, approved: 0, deprecated: 0, none: 0 }, total: 0 };
        folders.set(folder, entry);
      }
      entry.notes_by_status[key]++;
      entry.total++;
    }
  }
  return [...folders.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Groups of two or more non-deprecated notes with the same title (trimmed, lower case, white space collapsed), sorted. */
export function sameTitleGroups(index: VaultIndex): { title: string; paths: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const [rel, note] of index.notes) {
    if (note.status === 'deprecated') continue;
    const key = note.title.trim().toLowerCase().replace(/\s+/g, ' ');
    if (key === '') continue;
    groups.set(key, [...(groups.get(key) ?? []), rel]);
  }
  return [...groups]
    .filter(([, paths]) => paths.length >= 2)
    .map(([title, paths]) => ({ title, paths: paths.sort() }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

const TYPE_FOLDERS: Record<string, string> = { decision: 'Decisions/', lesson: 'Lessons/', issue: 'Issues/', agent: 'Agents/' };

/** Destination of a note when it is approved: `target`, else the folder of its type. */
export function targetOf(note: Pick<IndexedNote, 'target' | 'type' | 'repo'>): string {
  if (note.target !== null) return note.target;
  if (note.type === 'index') return note.repo !== null && isRepositoryName(note.repo) ? `Repos/${repoFolderName(note.repo)}/` : 'Repos/';
  return (note.type !== null ? TYPE_FOLDERS[note.type] : undefined) ?? 'Inbox/';
}

/** The `status: candidate` notes, oldest `created` first (without `created` last, then by path). */
export function candidatesOf(index: VaultIndex): BrainCandidate[] {
  const result: BrainCandidate[] = [];
  for (const [rel, note] of index.notes) {
    if (note.status !== 'candidate') continue;
    result.push({ path: rel, title: note.title, type: note.type, repo: note.repo, issue: note.issue, role: note.role, created: note.created, target: targetOf(note), preview: note.preview ?? '' });
  }
  return result.sort((a, b) => {
    if (a.created !== b.created) {
      if (a.created === null) return 1;
      if (b.created === null) return -1;
      return a.created < b.created ? -1 : 1;
    }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

/** Holds the index of one vault; rebuild and update run one after the other. Never throws, errors are logged. */
export class BrainIndex {
  readonly #logger: Logger;
  #chain: Promise<unknown> = Promise.resolve();
  #vault: string | null = null;
  #notes = new Map<string, IndexedNote>();
  #derived: VaultIndex = deriveIndex(this.#notes);

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn);
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #rebuild(vault: string): Promise<VaultIndex> {
    const started = performance.now();
    try {
      const index = await buildIndex(vault);
      this.#vault = vault;
      this.#notes = index.notes;
      this.#derived = index;
      this.#logger.info('brain index built', { notes: index.notes.size, ms: Math.round(performance.now() - started) });
    } catch (error) {
      this.#logger.warn('cannot build the brain index', { vault, error: errorMessage(error) });
    }
    return this.#derived;
  }

  rebuild(vault: string): Promise<VaultIndex> {
    return this.#enqueue(() => this.#rebuild(vault));
  }

  /** Re-reads the given vault-relative paths (deleted ones are removed). Does nothing before the first build of this vault. */
  update(vault: string, paths: string[]): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#vault !== vault) return;
      const relevant = [...new Set(paths.map((rel) => rel.replace(/\\/g, '/')))].filter(
        (rel) => rel.toLowerCase().endsWith('.md') && !rel.split('/').some((segment) => segment.startsWith('.')),
      );
      if (relevant.length === 0) return;
      try {
        const notes = new Map(this.#notes);
        readAll(vault, relevant, notes);
        this.#notes = notes;
        this.#derived = deriveIndex(notes);
      } catch (error) {
        this.#logger.warn('cannot update the brain index', { vault, error: errorMessage(error) });
      }
    });
  }

  /** The current index; builds it first when it belongs to another vault. */
  current(vault: string): Promise<VaultIndex> {
    return this.#enqueue(async () => (this.#vault === vault ? this.#derived : this.#rebuild(vault)));
  }
}

export const GRAPH_NODE_LIMIT = 150;

export interface BrainGraphNode {
  path: string;
  title: string;
  status: string | null;
  type: string | null;
  /** A broken link target: no note has this path. */
  missing: boolean;
  /** Distance to the root (root 0). */
  depth: number;
}

export interface BrainGraphEdge {
  from: string;
  to: string;
  /** The link does not resolve; `to` is a missing node. */
  broken: boolean;
}

export interface BrainGraph {
  root: string;
  depth: number;
  /** True when the node limit cut the graph. */
  truncated: boolean;
  /** Root first, then breadth-first. */
  nodes: BrainGraphNode[];
  /** Only between nodes of the graph, sorted by from, to. */
  edges: BrainGraphEdge[];
}

/** The index key of a root path (`\` → `/`, leading `/` dropped, `.md` added when missing; exact, else case-insensitive). */
function graphRootOf(index: VaultIndex, root: string): string | null {
  let rel = root.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (rel === '') return null;
  if (!/\.md$/i.test(rel)) rel = `${rel}.md`;
  if (index.notes.has(rel)) return rel;
  const lower = rel.toLowerCase();
  for (const key of index.notes.keys()) if (key.toLowerCase() === lower) return key;
  return null;
}

/**
 * The neighbourhood of a note up to `depth` links away (outgoing links and backlinks), breadth-first with sorted
 * neighbours. Broken links become nodes with `missing: true` and the link target as path. At most `limit` nodes; null
 * when the root is not in the index.
 */
export function graphAround(index: VaultIndex, root: string, depth = 2, limit = GRAPH_NODE_LIMIT): BrainGraph | null {
  const start = graphRootOf(index, root);
  if (start === null) return null;
  const neighbours = new Map<string, Set<string>>();
  const edges = new Map<string, BrainGraphEdge>();
  const connect = (a: string, b: string): void => {
    neighbours.set(a, (neighbours.get(a) ?? new Set()).add(b));
    neighbours.set(b, (neighbours.get(b) ?? new Set()).add(a));
  };
  for (const [target, sources] of index.backlinks) {
    for (const source of sources) {
      connect(source, target);
      edges.set(`${source}\n${target}`, { from: source, to: target, broken: false });
    }
  }
  const missing = new Set<string>();
  for (const { from, link } of index.broken) {
    // A broken link never equals a note path (it would resolve), so the missing node cannot collide with a note.
    missing.add(link);
    connect(from, link);
    edges.set(`${from}\n${link}`, { from, to: link, broken: true });
  }
  const nodes: BrainGraphNode[] = [];
  const seen = new Set<string>();
  const add = (rel: string, at: number): void => {
    seen.add(rel);
    const note = index.notes.get(rel);
    nodes.push(
      note !== undefined
        ? { path: rel, title: note.title, status: note.status, type: note.type, missing: false, depth: at }
        : { path: rel, title: path.posix.basename(rel).replace(/\.md$/i, ''), status: null, type: null, missing: true, depth: at },
    );
  };
  add(start, 0);
  let truncated = false;
  let frontier = [start];
  for (let at = 1; at <= depth && frontier.length > 0 && !truncated; at++) {
    const next: string[] = [];
    for (const rel of frontier) {
      for (const other of [...(neighbours.get(rel) ?? [])].sort()) {
        if (seen.has(other)) continue;
        if (nodes.length >= limit) {
          truncated = true;
          break;
        }
        add(other, at);
        // Missing nodes have no links of their own.
        if (!missing.has(other)) next.push(other);
      }
      if (truncated) break;
    }
    frontier = next;
  }
  const kept = [...edges.values()]
    .filter((edge) => seen.has(edge.from) && seen.has(edge.to))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return { root: start, depth, truncated, nodes, edges: kept };
}
