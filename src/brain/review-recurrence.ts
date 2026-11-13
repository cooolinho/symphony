import fs from 'node:fs';
import path from 'node:path';
import type { ResultRow } from '../orchestrator/stage-history.ts';
import { isRepositoryName } from '../tracker/github-project/settings.ts';
import type { BrainConfig } from '../workflow/config.ts';
import type { BrainMode } from '../workflow/roles.ts';
import { MAX_NOTE_BYTES } from './common.ts';
import type { VaultIndex } from './index.ts';
import { parseNote } from './note.ts';

/**
 * Recurring review findings (#575): a blocker or major finding whose category shows up again, in a later round of the
 * same issue or in several issues of a repository, should become a lesson in the vault, and every lesson of a repository
 * should reach the next developer session before it codes. Deterministic: the sources are the issue archives and the
 * results of the running issue, the lessons come from the vault index.
 */

/** Tag every review lesson carries. */
export const REVIEW_LESSON_TAG = 'review-lesson';
/** Prefix of the tag that names the category a lesson covers: `review/<category>`. */
export const CATEGORY_TAG_PREFIX = 'review/';

/** Problem examples per recurring category, and their length. */
const EXAMPLES_MAX = 3;
const EXAMPLE_CHARS = 160;
/** Known categories passed to a reviewer. */
const KNOWN_CATEGORIES_MAX = 30;
/** Length of the core rule of an injected lesson. */
const RULE_CHARS = 400;
/** Characters an injected lesson costs besides title, path and rule (markup, the candidate mark). */
const LESSON_OVERHEAD = 40;
/** Lessons beyond the budget listed by path. */
const MORE_MAX = 40;

/** One blocker or major finding with a category, of one result of one issue. */
export interface SevereFindingRecord {
  issue: string;
  /** Identifies the result the finding belongs to (run, role and time), so findings of one result count once. */
  result: string;
  /** ISO 8601 time of the result. */
  resultAt: string;
  round: number | null;
  category: string;
  problem: string;
}

/** Why a category recurs: again in this issue (`same_issue`), or in several issues of the repository (`cross_issue`). */
export type RecurrenceTrigger = 'same_issue' | 'cross_issue';

/** The lesson a category already has. */
export interface LessonRef {
  path: string;
  title: string;
  status: string;
}

/** A category that recurs: what the reviewer turns into a lesson (prompt variable `recurring_findings`). */
export interface RecurringCategory {
  category: string;
  triggers: RecurrenceTrigger[];
  /** Blocker and major findings of the category that were counted. */
  findings: number;
  /** Issues they occurred in, sorted. */
  issues: string[];
  examples: Array<{ issue: string; problem: string }>;
  /** The lesson that covers the category (tag `review/<category>`, the repository or none); null without one. */
  lesson: LessonRef | null;
}

/** A lesson of the vault that applies to a repository. */
export interface LessonNote {
  path: string;
  title: string;
  status: string;
  repo: string | null;
  /** Categories from its `review/<category>` tags. */
  categories: string[];
  /** Carries the tag `review-lesson`. */
  reviewLesson: boolean;
  /** `updated`, else `created` (YYYY-MM-DD); null without either. */
  updated: string | null;
}

/** Settings of the detection (`brain.review_lessons`). */
export interface RecurrenceSettings {
  windowDays: number;
  minIssues: number;
}

const DAY_MS = 86_400_000;

function at(value: string): number {
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

/** The blocker and major findings with a category of the review and security rows of an issue; rows without findings or categories add nothing. */
export function severeFindingsOf(issue: string, rows: readonly ResultRow[]): SevereFindingRecord[] {
  const records: SevereFindingRecord[] = [];
  for (const row of rows) {
    if (row.kind !== 'review' && row.kind !== 'security') continue;
    for (const finding of row.findings ?? []) {
      const category = typeof finding.category === 'string' ? finding.category : null;
      if (category === null || (finding.severity !== 'blocker' && finding.severity !== 'major')) continue;
      records.push({
        issue,
        result: `${row.run ?? ''}|${row.role}|${row.created_at}`,
        resultAt: row.created_at,
        round: row.round,
        category,
        problem: finding.problem,
      });
    }
  }
  return records;
}

export interface RecurrenceInput {
  /** The running issue. */
  issue: string;
  /** Findings of the running issue's persisted results (all rounds). */
  current: readonly SevereFindingRecord[];
  /** Findings of other issues of the same repository (from their archives); the running issue's own entries are ignored. */
  others: readonly SevereFindingRecord[];
  /** Categories of the blocker and major findings being reported now: they count as one more result of the running issue. */
  reported?: readonly string[];
  now: Date;
  config: RecurrenceSettings;
}

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The categories that recur: (a) `same_issue` when at least two distinct results of the running issue have a blocker or
 * major finding of the category (the reported findings count as one more result), (b) `cross_issue` when at least
 * `minIssues` distinct issues of the repository had one within `windowDays`. Sorted by findings, most first, then by name.
 * Lessons are not attached here (see {@link attachLessons}).
 */
export function detectRecurrence(input: RecurrenceInput): RecurringCategory[] {
  const since = input.now.getTime() - input.config.windowDays * DAY_MS;
  const reported = new Map<string, number>();
  for (const category of input.reported ?? []) reported.set(category, (reported.get(category) ?? 0) + 1);
  const others = input.others.filter((record) => record.issue !== input.issue && at(record.resultAt) >= since);
  const categories = new Set([...input.current.map((record) => record.category), ...others.map((record) => record.category), ...reported.keys()]);
  const found: RecurringCategory[] = [];
  for (const category of categories) {
    const current = input.current.filter((record) => record.category === category);
    const foreign = others.filter((record) => record.category === category);
    const nowReported = reported.get(category) ?? 0;
    const results = new Set(current.map((record) => record.result)).size + (nowReported > 0 ? 1 : 0);
    const issues = new Set(foreign.map((record) => record.issue));
    if (nowReported > 0 || current.some((record) => at(record.resultAt) >= since)) issues.add(input.issue);
    const triggers: RecurrenceTrigger[] = [];
    if (results >= 2) triggers.push('same_issue');
    if (issues.size >= input.config.minIssues) triggers.push('cross_issue');
    if (triggers.length === 0) continue;
    const records = [...current, ...foreign].sort((a, b) => at(b.resultAt) - at(a.resultAt));
    const examples: RecurringCategory['examples'] = [];
    for (const record of records) {
      if (examples.length >= EXAMPLES_MAX) break;
      const problem = shorten(record.problem, EXAMPLE_CHARS);
      if (!examples.some((example) => example.problem === problem)) examples.push({ issue: record.issue, problem });
    }
    found.push({
      category,
      triggers,
      findings: current.length + foreign.length + nowReported,
      issues: [...new Set([...issues, ...current.map((record) => record.issue)])].sort(),
      examples,
      lesson: null,
    });
  }
  return found.sort((a, b) => b.findings - a.findings || a.category.localeCompare(b.category));
}

/** Categories of the repository with the issues they occurred in (prompt variable `known_categories`), most issues first. */
export function knownCategories(records: readonly SevereFindingRecord[]): Array<{ category: string; issues: string[]; findings: number }> {
  const byCategory = new Map<string, { issues: Set<string>; findings: number }>();
  for (const record of records) {
    const entry = byCategory.get(record.category) ?? { issues: new Set<string>(), findings: 0 };
    entry.issues.add(record.issue);
    entry.findings += 1;
    byCategory.set(record.category, entry);
  }
  return [...byCategory]
    .map(([category, entry]) => ({ category, issues: [...entry.issues].sort(), findings: entry.findings }))
    .sort((a, b) => b.issues.length - a.issues.length || b.findings - a.findings || a.category.localeCompare(b.category))
    .slice(0, KNOWN_CATEGORIES_MAX);
}

/**
 * The lessons that apply to a repository: notes of type `lesson` with status approved or candidate whose `repo` is the
 * repository or unset. Categories come from the tags `review/<category>`.
 */
export function lessonNotesOf(index: Pick<VaultIndex, 'notes'>, repo: string): LessonNote[] {
  const lessons: LessonNote[] = [];
  const wanted = repo.toLowerCase();
  for (const [notePath, note] of index.notes) {
    if (note.type !== 'lesson' || (note.status !== 'approved' && note.status !== 'candidate')) continue;
    if (note.repo !== null && note.repo.toLowerCase() !== wanted) continue;
    const tags = note.tags ?? [];
    lessons.push({
      path: notePath,
      title: note.title,
      status: note.status,
      repo: note.repo,
      categories: tags.filter((tag) => tag.startsWith(CATEGORY_TAG_PREFIX) && tag.length > CATEGORY_TAG_PREFIX.length).map((tag) => tag.slice(CATEGORY_TAG_PREFIX.length)),
      reviewLesson: tags.includes(REVIEW_LESSON_TAG),
      updated: note.updated ?? note.created,
    });
  }
  return lessons.sort((a, b) => a.path.localeCompare(b.path));
}

/** The lesson of a category: approved before candidate, a repository lesson before a general one, then by path. */
export function lessonFor(category: string, lessons: readonly LessonNote[]): LessonNote | null {
  const matching = lessons.filter((lesson) => lesson.categories.includes(category));
  matching.sort((a, b) => Number(b.status === 'approved') - Number(a.status === 'approved') || Number(b.repo !== null) - Number(a.repo !== null) || a.path.localeCompare(b.path));
  return matching[0] ?? null;
}

/** The recurring categories with the lesson each one already has. */
export function attachLessons(recurring: readonly RecurringCategory[], lessons: readonly LessonNote[]): RecurringCategory[] {
  return recurring.map((entry) => {
    const lesson = lessonFor(entry.category, lessons);
    return { ...entry, lesson: lesson === null ? null : { path: lesson.path, title: lesson.title, status: lesson.status } };
  });
}

/** One injected lesson of the prompt variable `brain_lessons`. */
export interface InjectedLesson {
  title: string;
  path: string;
  status: string;
  /** A candidate: not reviewed yet, to be checked against the code. */
  candidate: boolean;
  categories: string[];
  /** The core rule: the first paragraph after the title, shortened. */
  rule: string;
}

/** The prompt variable `brain_lessons`: lessons within the budget, the rest by path. */
export interface BrainLessonsValue {
  lessons: InjectedLesson[];
  /** Paths of the lessons beyond the budget (at most {@link MORE_MAX}). */
  more: string[];
  /** All lessons that apply to the repository. */
  total: number;
}

/** The first paragraph of a note body after its H1 (headings, blank lines and list markers aside), shortened; empty without one. */
export function coreRule(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const paragraph: string[] = [];
  let fence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      fence = !fence;
      if (paragraph.length > 0) break;
      continue;
    }
    if (fence) continue;
    if (trimmed === '' || trimmed.startsWith('#')) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(trimmed);
  }
  return shorten(paragraph.join(' '), RULE_CHARS);
}

function readRule(vault: string, notePath: string): string {
  try {
    const file = path.join(vault, ...notePath.split('/'));
    if (fs.statSync(file).size > MAX_NOTE_BYTES) return '';
    return coreRule(parseNote(fs.readFileSync(file, 'utf8')).body);
  } catch {
    return '';
  }
}

export interface BrainLessonsInput {
  /** Vault directory; the core rules are read from the note files. */
  vault: string;
  lessons: readonly LessonNote[];
  /** Categories of the open findings (rework round): their lessons come first. */
  openCategories: readonly string[];
  /** Blocker and major findings per category in the repository within the window: orders the review lessons. */
  recurrenceCounts: ReadonlyMap<string, number>;
  /** `inject_budget_chars`. */
  budget: number;
}

/**
 * The lessons for a developer, test engineer or architect prompt: first the lessons of the open findings' categories,
 * then the review lessons by how often their categories occurred and how recent they are, then the others by recency.
 * Each one costs its title, path, rule and some markup; once the budget is spent, the rest is listed by path only.
 */
export function buildBrainLessons(input: BrainLessonsInput): BrainLessonsValue {
  const open = new Set(input.openCategories);
  const count = (lesson: LessonNote) => Math.max(0, ...lesson.categories.map((category) => input.recurrenceCounts.get(category) ?? 0));
  const recency = (a: LessonNote, b: LessonNote) => (b.updated ?? '').localeCompare(a.updated ?? '') || a.path.localeCompare(b.path);
  const tier = (lesson: LessonNote) => (lesson.categories.some((category) => open.has(category)) ? 0 : lesson.reviewLesson ? 1 : 2);
  const ordered = [...input.lessons].sort((a, b) => tier(a) - tier(b) || (tier(a) === 1 ? count(b) - count(a) : 0) || recency(a, b));
  const lessons: InjectedLesson[] = [];
  const more: string[] = [];
  let spent = 0;
  for (const lesson of ordered) {
    if (more.length === 0) {
      const rule = readRule(input.vault, lesson.path);
      const cost = lesson.title.length + lesson.path.length + rule.length + LESSON_OVERHEAD;
      if (spent + cost <= input.budget) {
        spent += cost;
        lessons.push({ title: lesson.title, path: lesson.path, status: lesson.status, candidate: lesson.status === 'candidate', categories: lesson.categories, rule });
        continue;
      }
    }
    if (more.length < MORE_MAX) more.push(lesson.path);
  }
  return { lessons, more, total: input.lessons.length };
}

/** Blocker and major findings per category within the records. */
export function categoryCounts(records: readonly SevereFindingRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) counts.set(record.category, (counts.get(record.category) ?? 0) + 1);
  return counts;
}

/** Whether review lessons apply to a session: the brain is on, `brain.review_lessons.enabled`, the role reads the brain, the repository is known. */
export function reviewLessonsActive(config: Pick<BrainConfig, 'enabled' | 'reviewLessons'>, mode: BrainMode, repository: string | null): repository is string {
  return config.enabled && config.reviewLessons.enabled && mode !== 'off' && repository !== null && isRepositoryName(repository);
}
