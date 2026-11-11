import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildIndex } from '../src/brain/index.ts';
import {
  attachLessons,
  buildBrainLessons,
  detectRecurrence,
  lessonNotesOf,
  reviewLessonsActive,
  severeFindingsOf,
  type SevereFindingRecord,
} from '../src/brain/review-recurrence.ts';
import { Logger } from '../src/log.ts';
import { IssueArchive, type ArchivedIssue } from '../src/orchestrator/issue-archive.ts';
import { createGuard, guardTools, toolsForRole } from '../src/orchestrator/guard.ts';
import { RESULT_TOOL, createResultTool, type ResultToolParams } from '../src/orchestrator/result-tool.ts';
import type { ResultRow } from '../src/orchestrator/stage-history.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import type { Issue, ToolResult } from '../src/tracker/types.ts';
import { SymphonyError } from '../src/util/errors.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { decodeMarker } from '../src/workflow/results.ts';
import { WorkspaceManager } from '../src/workspace/manager.ts';
import { FakeTracker, baseFront, makeIssue, makeWorkflow, tempDir } from './helpers.ts';

/** Independent tests for #575, group B: recurrence detection, archive and index additions, config, report_result rule. */

const NOW = new Date('2026-11-11T12:00:00Z');
const SETTINGS = { windowDays: 14, minIssues: 2 };
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

type F = { severity: string; category?: string | null; problem?: string };

function row(at: string, findings: F[] | undefined, over: Partial<ResultRow> = {}): ResultRow {
  const base: ResultRow = {
    role: 'reviewer',
    run: `run-${at}`,
    kind: 'review',
    verdict: 'changes_needed',
    summary: 'Fix it.',
    round: 1,
    target: 'In progress',
    head_sha: null,
    created_at: at,
    ...over,
  };
  if (findings !== undefined) {
    base.findings = findings.map((f) => ({ severity: f.severity, category: f.category ?? null, file: null, line: null, problem: f.problem ?? 'A problem', fix: null }));
  }
  return base;
}

function archived(identifier: string, repo: string | null, results: ResultRow[], over: Partial<ArchivedIssue> = {}): ArchivedIssue {
  return {
    version: 2,
    issue_id: identifier,
    issue_identifier: identifier,
    issue_url: null,
    title: identifier,
    repo,
    workspace_path: null,
    runs: 1,
    continuations: 0,
    last_error: null,
    archived_at: NOW.toISOString(),
    released: true,
    completed_before: false,
    timeline: [],
    next_seq: 0,
    sessions: [],
    results,
    run_trace: null,
    last_check: null,
    ...over,
  };
}

const severe = (issue: ArchivedIssue): SevereFindingRecord[] => severeFindingsOf(issue.issue_identifier, issue.results);

/** The current issue's persisted results and the other issues' archives go in; the recurring categories come out. */
function detect(current: ArchivedIssue, others: ArchivedIssue[], reported: string[] = []) {
  return detectRecurrence({
    issue: current.issue_identifier,
    current: severe(current),
    others: others.flatMap(severe),
    reported,
    now: NOW,
    config: SETTINGS,
  });
}

const MAJOR = (category: string, problem = 'A problem'): F => ({ severity: 'major', category, problem });

describe('detectRecurrence', () => {
  it('(a) the same category as major in round 2 of the same issue recurs with trigger same_issue', () => {
    const issue = archived('acme/app#1', 'acme/app', [row(daysAgo(2), [MAJOR('n-plus-one')], { round: 1 }), row(daysAgo(1), [MAJOR('n-plus-one')], { round: 2 })]);
    const found = detect(issue, []);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.category, 'n-plus-one');
    assert.ok(found[0]?.triggers.includes('same_issue'));
    assert.equal(found[0]?.findings, 2);
  });

  it('(a) a blocker counts like a major, and a finding reported now counts as one more result of the issue', () => {
    const issue = archived('acme/app#1', 'acme/app', [row(daysAgo(1), [{ severity: 'blocker', category: 'auth-gap' }])]);
    const found = detect(issue, [], ['auth-gap']);
    assert.deepEqual(found.map((entry) => entry.category), ['auth-gap']);
    assert.ok(found[0]?.triggers.includes('same_issue'));
  });

  it('two findings of the same category inside ONE result are not a second round', () => {
    const issue = archived('acme/app#1', 'acme/app', [row(daysAgo(1), [MAJOR('naming'), MAJOR('naming')])]);
    assert.deepEqual(detect(issue, []), []);
  });

  it('(b) two issues of the repository within 14 days recur with trigger cross_issue, naming both issues', () => {
    const current = archived('acme/app#1', 'acme/app', [row(daysAgo(1), [MAJOR('missing-tests')])]);
    const other = archived('acme/app#2', 'acme/app', [row(daysAgo(5), [MAJOR('missing-tests')])]);
    const found = detect(current, [other]);
    assert.equal(found.length, 1);
    assert.ok(found[0]?.triggers.includes('cross_issue'));
    assert.deepEqual(found[0]?.issues, ['acme/app#1', 'acme/app#2']);
    assert.equal(found[0]?.findings, 2);
  });

  it('a single issue, one finding: nothing recurs', () => {
    const current = archived('acme/app#1', 'acme/app', [row(daysAgo(1), [MAJOR('missing-tests')])]);
    assert.deepEqual(detect(current, []), []);
  });

  it('a second issue outside the window (15 days) does not count; inside (13 days) it does', () => {
    const current = archived('acme/app#1', 'acme/app', [row(daysAgo(1), [MAJOR('missing-tests')])]);
    assert.deepEqual(detect(current, [archived('acme/app#2', 'acme/app', [row(daysAgo(15), [MAJOR('missing-tests')])])]), []);
    assert.equal(detect(current, [archived('acme/app#2', 'acme/app', [row(daysAgo(13), [MAJOR('missing-tests')])])]).length, 1);
  });

  it('minor and nit findings do not count', () => {
    const current = archived('acme/app#1', 'acme/app', [row(daysAgo(1), [{ severity: 'minor', category: 'naming' }, { severity: 'nit', category: 'naming' }])]);
    const other = archived('acme/app#2', 'acme/app', [row(daysAgo(2), [{ severity: 'minor', category: 'naming' }, { severity: 'nit', category: 'naming' }])]);
    assert.deepEqual(detect(current, [other]), []);
    // a minor in one issue and a major in the other is still only one issue with a severe finding
    const majorOnly = archived('acme/app#3', 'acme/app', [row(daysAgo(2), [MAJOR('naming')])]);
    assert.deepEqual(detect(current, [majorOnly]), []);
  });

  it('findings without a category are ignored; old rows without findings are tolerated', () => {
    const current = archived('acme/app#1', 'acme/app', [row(daysAgo(1), [{ severity: 'major' }, { severity: 'major', category: null }]), row(daysAgo(2), undefined)]);
    const other = archived('acme/app#2', 'acme/app', [row(daysAgo(2), [{ severity: 'major' }]), row(daysAgo(3), undefined)]);
    assert.deepEqual(detect(current, [other]), []);
  });

  it('an issue of another repository does not count (through IssueArchive.forRepo)', () => {
    const dir = path.join(tempDir(), 'issues');
    const archive = new IssueArchive(dir, Logger.silent());
    archive.save(archived('acme/other#9', 'acme/other', [row(daysAgo(2), [MAJOR('missing-tests')])]));
    const current = archived('acme/app#1', 'acme/app', [row(daysAgo(1), [MAJOR('missing-tests')])]);
    const others = archive.forRepo('acme/app', new Date(NOW.getTime() - 14 * 86_400_000));
    assert.deepEqual(detect(current, others), []);
    archive.save(archived('acme/app#2', 'acme/app', [row(daysAgo(2), [MAJOR('missing-tests')])]));
    assert.equal(detect(current, archive.forRepo('acme/app', new Date(NOW.getTime() - 14 * 86_400_000))).length, 1);
  });

  it('min_issues is respected: 3 needs three issues', () => {
    const current = archived('acme/app#1', 'acme/app', [row(daysAgo(1), [MAJOR('x')])]);
    const second = archived('acme/app#2', 'acme/app', [row(daysAgo(2), [MAJOR('x')])]);
    const third = archived('acme/app#3', 'acme/app', [row(daysAgo(3), [MAJOR('x')])]);
    const run = (others: ArchivedIssue[]) => detectRecurrence({ issue: current.issue_identifier, current: severe(current), others: others.flatMap(severe), now: NOW, config: { windowDays: 14, minIssues: 3 } });
    assert.deepEqual(run([second]), []);
    assert.equal(run([second, third]).length, 1);
  });

  it('carries at most 3 short problem examples with the issue they come from', () => {
    const long = 'x'.repeat(600);
    const current = archived('acme/app#1', 'acme/app', [row(daysAgo(1), [MAJOR('big', long), MAJOR('big', 'second'), MAJOR('big', 'third'), MAJOR('big', 'fourth')])]);
    const other = archived('acme/app#2', 'acme/app', [row(daysAgo(2), [MAJOR('big', 'fifth')])]);
    const [entry] = detect(current, [other]);
    assert.ok(entry);
    assert.equal(entry.findings, 5);
    assert.ok(entry.examples.length >= 1 && entry.examples.length <= 3, `examples: ${entry.examples.length}`);
    for (const example of entry.examples) {
      assert.ok(example.problem.length < 600, 'problem is truncated');
      assert.match(example.issue, /^acme\/app#[12]$/);
    }
    // the long problem is truncated if it is shown
    assert.ok(entry.examples.every((example) => !example.problem.includes(long)));
  });
});

describe('lessons of a category', () => {
  const put = (vault: string, rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), text);
  };
  const lesson = (fields: { status?: string; repo?: string | null; tags: string[]; type?: string; updated?: string }, body = '# Title\n\nThe rule.\n'): string =>
    `---\ntype: ${fields.type ?? 'lesson'}\nstatus: ${fields.status ?? 'approved'}\n${fields.repo === null ? '' : `repo: ${fields.repo ?? 'acme/app'}\n`}${fields.updated === undefined ? '' : `updated: ${fields.updated}\n`}tags: [${fields.tags.join(', ')}]\n---\n${body}`;
  const recurring = async (vault: string) => {
    const index = await buildIndex(vault);
    const current = archived('acme/app#1', 'acme/app', [row(daysAgo(1), [MAJOR('n-plus-one')])]);
    const other = archived('acme/app#2', 'acme/app', [row(daysAgo(2), [MAJOR('n-plus-one')])]);
    return { index, found: detect(current, [other]) };
  };

  it('IndexedNote.tags comes from the frontmatter tags', async () => {
    const vault = tempDir();
    put(vault, 'Lessons/a.md', lesson({ tags: ['review-lesson', 'review/n-plus-one'] }));
    put(vault, 'Lessons/b.md', '---\ntype: lesson\nstatus: approved\ntags:\n  - alpha\n  - review/x\n---\nbody\n');
    put(vault, 'Lessons/c.md', '---\ntype: lesson\nstatus: approved\n---\nbody\n');
    const index = await buildIndex(vault);
    assert.deepEqual([...(index.notes.get('Lessons/a.md')?.tags ?? [])].sort(), ['review-lesson', 'review/n-plus-one']);
    assert.deepEqual([...(index.notes.get('Lessons/b.md')?.tags ?? [])].sort(), ['alpha', 'review/x']);
    assert.deepEqual(index.notes.get('Lessons/c.md')?.tags, []);
  });

  it('attaches the lesson with tag review/<category> of the repository, or without a repository', async () => {
    const vault = tempDir();
    put(vault, 'Lessons/own.md', lesson({ tags: ['review/n-plus-one'], repo: 'acme/app' }, '# N+1\n\nEager load.\n'));
    const { index, found } = await recurring(vault);
    const [entry] = attachLessons(found, lessonNotesOf(index, 'acme/app'));
    assert.equal(entry?.lesson?.path, 'Lessons/own.md');

    const general = tempDir();
    put(general, 'Lessons/general.md', lesson({ tags: ['review/n-plus-one'], repo: null }));
    const generalRun = await recurring(general);
    assert.equal(attachLessons(generalRun.found, lessonNotesOf(generalRun.index, 'acme/app'))[0]?.lesson?.path, 'Lessons/general.md');
  });

  it('does not attach a lesson of another repository, of another category or of another type', async () => {
    const vault = tempDir();
    put(vault, 'Lessons/foreign.md', lesson({ tags: ['review/n-plus-one'], repo: 'acme/other' }));
    put(vault, 'Lessons/different.md', lesson({ tags: ['review/naming'], repo: 'acme/app' }));
    put(vault, 'Decisions/not-a-lesson.md', lesson({ tags: ['review/n-plus-one'], repo: 'acme/app', type: 'decision' }));
    const { index, found } = await recurring(vault);
    assert.equal(attachLessons(found, lessonNotesOf(index, 'acme/app'))[0]?.lesson, null);
  });

  it('prefers an approved lesson over a candidate', async () => {
    const vault = tempDir();
    put(vault, 'Lessons/a-candidate.md', lesson({ tags: ['review/n-plus-one'], status: 'candidate' }));
    put(vault, 'Lessons/z-approved.md', lesson({ tags: ['review/n-plus-one'], status: 'approved' }));
    const { index, found } = await recurring(vault);
    assert.equal(attachLessons(found, lessonNotesOf(index, 'acme/app'))[0]?.lesson?.path, 'Lessons/z-approved.md');
  });

  it('a candidate alone is attached; a recurring category without any lesson has lesson null', async () => {
    const vault = tempDir();
    put(vault, 'Lessons/only.md', lesson({ tags: ['review/n-plus-one'], status: 'candidate' }));
    const { index, found } = await recurring(vault);
    assert.equal(attachLessons(found, lessonNotesOf(index, 'acme/app'))[0]?.lesson?.status, 'candidate');
    const empty = await recurring(tempDir());
    assert.equal(attachLessons(empty.found, lessonNotesOf(empty.index, 'acme/app'))[0]?.lesson, null);
  });
});

describe('IssueArchive.forRepo', () => {
  const dirOf = () => path.join(tempDir(), 'issues');
  const since = new Date(NOW.getTime() - 14 * 86_400_000);

  it('returns only the issues of the repository', () => {
    const archive = new IssueArchive(dirOf(), Logger.silent());
    archive.save(archived('acme/app#1', 'acme/app', []));
    archive.save(archived('acme/app#2', 'acme/app', []));
    archive.save(archived('acme/other#3', 'acme/other', []));
    archive.save(archived('acme/none#4', null, []));
    assert.deepEqual(archive.forRepo('acme/app', new Date(0)).map((issue) => issue.issue_identifier).sort(), ['acme/app#1', 'acme/app#2']);
    // a fresh archive on the same directory reads them from the files
    const fresh = new IssueArchive(archive.dir, Logger.silent());
    assert.deepEqual(fresh.forRepo('acme/app', new Date(0)).map((issue) => issue.issue_identifier).sort(), ['acme/app#1', 'acme/app#2']);
  });

  it('skips files whose mtime is before `since`', () => {
    const dir = dirOf();
    const writer = new IssueArchive(dir, Logger.silent());
    writer.save(archived('acme/app#1', 'acme/app', []));
    writer.save(archived('acme/app#2', 'acme/app', []));
    const old = new Date(Date.now() - 40 * 86_400_000);
    const oldFile = writer.fileFor('acme/app#1');
    assert.ok(oldFile);
    fs.utimesSync(oldFile, old, old);
    const reader = new IssueArchive(dir, Logger.silent());
    assert.deepEqual(reader.forRepo('acme/app', new Date(Date.now() - 14 * 86_400_000)).map((issue) => issue.issue_identifier), ['acme/app#2']);
    assert.deepEqual(reader.forRepo('acme/app', new Date(Date.now() - 60 * 86_400_000)).map((issue) => issue.issue_identifier).sort(), ['acme/app#1', 'acme/app#2']);
  });

  it('prefers the entry in memory over the file of the same issue', () => {
    const dir = dirOf();
    const archive = new IssueArchive(dir, Logger.silent());
    archive.save(archived('acme/app#1', 'acme/app', [], { title: 'in memory' }));
    const file = archive.fileFor('acme/app#1');
    assert.ok(file);
    fs.writeFileSync(file, JSON.stringify(archived('acme/app#1', 'acme/app', [], { title: 'on disk' })));
    const found = archive.forRepo('acme/app', new Date(0));
    assert.equal(found.length, 1);
    assert.equal(found[0]?.title, 'in memory');
  });

  it('tolerates unreadable files and a missing directory', () => {
    const dir = dirOf();
    const archive = new IssueArchive(dir, Logger.silent());
    archive.save(archived('acme/app#1', 'acme/app', []));
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
    fs.writeFileSync(path.join(dir, 'wrong.json'), JSON.stringify({ hello: 'world' }));
    const reader = new IssueArchive(dir, Logger.silent());
    assert.deepEqual(reader.forRepo('acme/app', new Date(0)).map((issue) => issue.issue_identifier), ['acme/app#1']);
    assert.deepEqual(new IssueArchive(path.join(tempDir(), 'missing'), Logger.silent()).forRepo('acme/app', since), []);
    assert.deepEqual(new IssueArchive(null, Logger.silent()).forRepo('acme/app', since), []);
  });
});

describe('brain lessons (buildBrainLessons)', () => {
  const put = (vault: string, rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), text);
  };
  const note = (title: string, tags: string[], rule: string, over: { status?: string; repo?: string | null; updated?: string } = {}): string =>
    `---\ntype: lesson\nstatus: ${over.status ?? 'approved'}\n${over.repo === null ? '' : `repo: ${over.repo ?? 'acme/app'}\n`}updated: ${over.updated ?? '2026-11-01'}\ntags: [${tags.join(', ')}]\n---\n# ${title}\n\n${rule}\n\nSecond paragraph that is not the core rule.\n`;
  const build = async (vault: string, input: { open?: string[]; counts?: Record<string, number>; budget?: number; repo?: string } = {}) => {
    const index = await buildIndex(vault);
    return buildBrainLessons({
      vault,
      lessons: lessonNotesOf(index, input.repo ?? 'acme/app'),
      openCategories: input.open ?? [],
      recurrenceCounts: new Map(Object.entries(input.counts ?? {})),
      budget: input.budget ?? 6000,
    });
  };

  it('each lesson has title, path and the first paragraph after the H1 as its core rule; candidates are marked', async () => {
    const vault = tempDir();
    put(vault, 'Lessons/one.md', note('Eager load relations', ['review-lesson', 'review/n-plus-one'], 'Always eager load relations in list queries.'));
    put(vault, 'Lessons/two.md', note('Name things', ['review-lesson', 'review/naming'], 'Use domain names.', { status: 'candidate' }));
    const value = await build(vault);
    const one = value.lessons.find((entry) => entry.path === 'Lessons/one.md');
    const two = value.lessons.find((entry) => entry.path === 'Lessons/two.md');
    assert.equal(one?.title, 'Eager load relations');
    assert.equal(one?.rule, 'Always eager load relations in list queries.');
    assert.ok(!one?.rule.includes('Second paragraph'));
    assert.equal(one?.candidate, false);
    assert.equal(two?.candidate, true);
    assert.deepEqual(value.more, []);
  });

  it('only lessons of the issue repository or without a repository are included', async () => {
    const vault = tempDir();
    put(vault, 'Lessons/own.md', note('Own', ['review/a'], 'Own rule.'));
    put(vault, 'Lessons/general.md', note('General', ['review/b'], 'General rule.', { repo: null }));
    put(vault, 'Lessons/foreign.md', note('Foreign', ['review/c'], 'Foreign rule.', { repo: 'acme/other' }));
    const value = await build(vault);
    assert.deepEqual(value.lessons.map((entry) => entry.path).sort(), ['Lessons/general.md', 'Lessons/own.md']);
    assert.ok(!value.more.includes('Lessons/foreign.md'));
  });

  it('orders open-finding categories first, then review lessons by recurrence count, then the rest', async () => {
    const vault = tempDir();
    put(vault, 'Lessons/a-plain.md', note('Plain', ['review/plain'], 'Plain rule.'));
    put(vault, 'Lessons/b-low.md', note('Low', ['review-lesson', 'review/low'], 'Low rule.'));
    put(vault, 'Lessons/c-high.md', note('High', ['review-lesson', 'review/high'], 'High rule.'));
    put(vault, 'Lessons/d-open.md', note('Open', ['review-lesson', 'review/openc'], 'Open rule.'));
    const value = await build(vault, { open: ['openc'], counts: { low: 1, high: 5, plain: 9 } });
    assert.deepEqual(value.lessons.map((entry) => entry.path), ['Lessons/d-open.md', 'Lessons/c-high.md', 'Lessons/b-low.md', 'Lessons/a-plain.md']);
  });

  it('an open-finding category wins even for a lesson without the review-lesson tag', async () => {
    const vault = tempDir();
    put(vault, 'Lessons/a-review.md', note('Review', ['review-lesson', 'review/x'], 'X rule.'));
    put(vault, 'Lessons/z-plain.md', note('Plain', ['review/y'], 'Y rule.'));
    const value = await build(vault, { open: ['y'], counts: { x: 9 } });
    assert.equal(value.lessons[0]?.path, 'Lessons/z-plain.md');
  });

  it('review lessons with the same count come newest first', async () => {
    const vault = tempDir();
    put(vault, 'Lessons/a-old.md', note('Old', ['review-lesson', 'review/old'], 'Old rule.', { updated: '2026-10-01' }));
    put(vault, 'Lessons/z-new.md', note('New', ['review-lesson', 'review/new'], 'New rule.', { updated: '2026-11-09' }));
    const value = await build(vault, { counts: { old: 2, new: 2 } });
    assert.deepEqual(value.lessons.map((entry) => entry.path), ['Lessons/z-new.md', 'Lessons/a-old.md']);
  });

  it('stays within inject_budget_chars; the lessons beyond it appear only as a path list, in priority order', async () => {
    const vault = tempDir();
    const rule = 'R'.repeat(120);
    for (const [i, name] of ['a', 'b', 'c', 'd', 'e'].entries()) {
      put(vault, `Lessons/${name}.md`, note(`Lesson ${name}`, ['review-lesson', `review/cat-${name}`], rule));
      void i;
    }
    const counts = { 'cat-a': 5, 'cat-b': 4, 'cat-c': 3, 'cat-d': 2, 'cat-e': 1 };
    const budget = 500;
    const value = await build(vault, { budget, counts });
    const size = value.lessons.reduce((sum, entry) => sum + entry.title.length + entry.path.length + entry.rule.length, 0);
    assert.ok(size <= budget, `size ${size} within ${budget}`);
    assert.ok(value.lessons.length >= 1 && value.lessons.length < 5, `injected: ${value.lessons.length}`);
    assert.equal(value.lessons.length + value.more.length, 5);
    const all = [...value.lessons.map((entry) => entry.path), ...value.more];
    assert.deepEqual(all, ['Lessons/a.md', 'Lessons/b.md', 'Lessons/c.md', 'Lessons/d.md', 'Lessons/e.md']);
    for (const entry of value.lessons) assert.ok(!value.more.includes(entry.path));
  });

  it('with the default budget (6000) a handful of lessons all fit; with budget 0 all of them are only listed', async () => {
    const vault = tempDir();
    put(vault, 'Lessons/a.md', note('A', ['review-lesson', 'review/a'], 'A rule.'));
    put(vault, 'Lessons/b.md', note('B', ['review-lesson', 'review/b'], 'B rule.'));
    const roomy = await build(vault);
    assert.equal(roomy.lessons.length, 2);
    assert.deepEqual(roomy.more, []);
    const none = await build(vault, { budget: 0 });
    assert.deepEqual(none.lessons, []);
    assert.deepEqual([...none.more].sort(), ['Lessons/a.md', 'Lessons/b.md']);
  });

  it('is empty without lessons', async () => {
    const value = await build(tempDir());
    assert.deepEqual(value.lessons, []);
    assert.deepEqual(value.more, []);
  });
});

describe('reviewLessonsActive (brain_lessons is null otherwise)', () => {
  const defaults = { enabled: true, windowDays: 14, minIssues: 2, injectBudgetChars: 6000 };
  const on = { enabled: true, reviewLessons: defaults };

  it('is true with the brain on, review_lessons enabled, a brain mode and a known repository', () => {
    assert.equal(reviewLessonsActive(on, 'read', 'acme/app'), true);
    assert.equal(reviewLessonsActive(on, 'write', 'acme/app'), true);
  });

  it('is false with brain off, brain.review_lessons.enabled false, brain.enabled false or an unknown repository', () => {
    assert.equal(reviewLessonsActive(on, 'off', 'acme/app'), false);
    assert.equal(reviewLessonsActive({ enabled: true, reviewLessons: { ...defaults, enabled: false } }, 'read', 'acme/app'), false);
    assert.equal(reviewLessonsActive({ enabled: false, reviewLessons: defaults }, 'read', 'acme/app'), false);
    assert.equal(reviewLessonsActive(on, 'read', null), false);
  });
});

describe('brain.review_lessons config', () => {
  const base = { tracker: { kind: 'github-project' } };
  const env = { HOME: '/home/u' };
  const resolve = (front: Record<string, unknown>) => resolveConfig(front, { workflowPath: '/srv/flows/WORKFLOW.md', env, trackerDefaults });
  const lessonsOf = (reviewLessons: unknown) => resolve({ ...base, brain: { review_lessons: reviewLessons } }).brain.reviewLessons;
  const codeOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (error) {
      return error instanceof SymphonyError ? error.code : 'other';
    }
    return undefined;
  };

  it('defaults when missing: enabled, 14 days, 2 issues, 6000 characters', () => {
    const expected = { enabled: true, windowDays: 14, minIssues: 2, injectBudgetChars: 6000 };
    assert.deepEqual(resolve(base).brain.reviewLessons, expected);
    assert.deepEqual(resolve({ ...base, brain: { enabled: true } }).brain.reviewLessons, expected);
    assert.deepEqual(lessonsOf({}), expected);
  });

  it('reads all four keys, and keeps defaults for keys that are left out', () => {
    assert.deepEqual(lessonsOf({ enabled: false, window_days: 30, min_issues: 3, inject_budget_chars: 2000 }), { enabled: false, windowDays: 30, minIssues: 3, injectBudgetChars: 2000 });
    assert.deepEqual(lessonsOf({ window_days: 7 }), { enabled: true, windowDays: 7, minIssues: 2, injectBudgetChars: 6000 });
  });

  it('an unknown key under brain.review_lessons is an invalid_config', () => {
    assert.equal(lessonsOf({ enabled: true, window_days: 14, min_issues: 2, inject_budget_chars: 6000 }).minIssues, 2, 'the four known keys are accepted');
    assert.equal(codeOf(() => lessonsOf({ windows_days: 3 })), 'invalid_config');
    assert.equal(codeOf(() => lessonsOf({ enabled: true, extra: 1 })), 'invalid_config');
  });

  it('invalid values are rejected with invalid_config', () => {
    assert.equal(lessonsOf({ min_issues: 3, window_days: 7, inject_budget_chars: 100 }).windowDays, 7, 'valid boundary values are accepted');
    for (const bad of [{ min_issues: 0 }, { min_issues: -1 }, { window_days: 0 }, { window_days: -3 }, { inject_budget_chars: -1 }, { enabled: 'maybe' }, { window_days: 'soon' }]) {
      assert.equal(codeOf(() => lessonsOf(bad)), 'invalid_config', JSON.stringify(bad));
    }
  });
});

describe('report_result: lesson rule for recurring review findings', () => {
  const ROLES = {
    reviewer: {
      states: ['Agent review'],
      read_only: true,
      result: 'review',
      may_move_to: ['Security review', 'In review', 'In progress', 'Blocked'],
      on_result: { approved: 'In review', changes_needed: 'In progress' },
      on_round_limit: 'In review',
    },
    auditor: {
      states: ['Security review'],
      read_only: true,
      result: 'security',
      may_move_to: ['In review', 'In progress', 'Blocked'],
      on_result: { passed: 'In review', issues_found: 'In progress' },
      on_check_failed: 'In progress',
    },
  };

  function facts(over: Partial<NonNullable<ResultToolParams['lessons']>> & { recurringCategory?: string } = {}) {
    const missing: string[][] = [];
    const seen: string[][] = [];
    let writes = 0;
    const category = over.recurringCategory ?? 'n-plus-one';
    const lessons: NonNullable<ResultToolParams['lessons']> = {
      recurring: (reported) => {
        seen.push([...reported]);
        return reported.includes(category)
          ? [{ category, triggers: ['cross_issue' as const], findings: 2, issues: ['acme/app#1', 'acme/app#2'], examples: [{ issue: 'acme/app#2', problem: 'N+1 in list' }], lesson: null }]
          : [];
      },
      brainWrites: () => writes,
      enforce: true,
      onMissing: (categories) => missing.push(categories),
      ...(({ recurringCategory: _ignored, ...rest }) => rest)(over),
    };
    return { lessons, missing, seen, write: () => (writes += 1) };
  }

  function setup(lessons: NonNullable<ResultToolParams['lessons']>, roleName: 'reviewer' | 'auditor' = 'reviewer') {
    const root = tempDir('symphony-recurrence-');
    const front = baseFront(root, {
      tracker: {
        kind: 'github_project',
        provider: { owner: 'acme', project_number: 1, token: 'test-token' },
        active_states: ['Agent review', 'Security review'],
      },
      roles: ROLES,
      pipeline: { max_review_rounds: 3, max_test_rounds: 2 },
      checks: { timeout_ms: 10_000, on_enter: {} },
    });
    const config = makeWorkflow(front).config;
    const workspacePath = path.join(root, 'ws');
    fs.mkdirSync(workspacePath);
    const manager = new WorkspaceManager({ root, hooks: config.hooks, workflowDir: root }, { PATH: process.env.PATH }, Logger.silent());
    const role = config.roles?.find((r) => r.name === roleName);
    assert.ok(role);
    const tracker = new FakeTracker([makeIssue({ id: '1', state: roleName === 'reviewer' ? 'Agent review' : 'Security review', labels: [] })]);
    const current = (): Issue => {
      const issue = tracker.issues.get('1');
      assert.ok(issue);
      return issue;
    };
    const guard = createGuard({
      role,
      config,
      workspace: { path: workspacePath, key: 'ws', createdNow: false },
      issue: () => ({ id: '1', identifier: 'acme/app#1' }),
      manager,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    const params: ResultToolParams = {
      role,
      history: { reviewRounds: 0, testRounds: 0 },
      profile: null,
      flags: {},
      config,
      boardColumns: null,
      adapter: tracker,
      issue: current,
      runId: 'run-1',
      meta: { workflowHash: 'f'.repeat(64), headSha: async () => 'abc123def456abc1', now: () => new Date('2026-10-18T12:00:00Z') },
      lessons,
    };
    const unguarded = createResultTool(params);
    const tools = guardTools(toolsForRole(tracker.agentToolSpecs(), role, current(), unguarded), guard);
    const tool = tools.find((spec) => spec.name === RESULT_TOOL);
    assert.ok(tool);
    const report = (args: Record<string, unknown>): Promise<ToolResult> => tool.execute(args, { issue: current() });
    const markers = () => (tracker.comments.get('1') ?? []).map((comment) => decodeMarker(comment.body));
    return { report, tracker, markers };
  }

  const data = (result: ToolResult): Record<string, unknown> => {
    assert.ok(result.ok, result.ok ? '' : `${result.error.category}: ${result.error.message}`);
    return result.data as Record<string, unknown>;
  };
  const error = (result: ToolResult): { category: string; message: string } => {
    assert.ok(!result.ok, 'expected a tool error');
    return result.error;
  };

  const REVIEW = {
    verdict: 'changes_needed',
    summary: 'The N+1 is back.',
    findings: [
      { severity: 'major', category: 'n-plus-one', file: 'src/a.ts', line: 3, problem: 'N+1 in the list', fix: 'Eager load' },
      { severity: 'minor', category: 'naming', problem: 'A name' },
    ],
  };

  it('the first call is rejected with invalid_result and a hint naming the category; nothing is recorded', async () => {
    const { lessons, missing } = facts();
    const { report, tracker } = setup(lessons);
    const refused = error(await report(REVIEW));
    assert.equal(refused.category, 'invalid_result');
    assert.match(refused.message, /n-plus-one/);
    assert.deepEqual(tracker.statusCalls, []);
    assert.equal((tracker.comments.get('1') ?? []).length, 0);
    assert.deepEqual(missing, []);
  });

  it('the second identical call is accepted, reports lesson_missing through onMissing, and the summary gets a note', async () => {
    const { lessons, missing } = facts();
    const { report, markers, tracker } = setup(lessons);
    error(await report(REVIEW));
    const result = data(await report(REVIEW));
    assert.equal(result.verdict, 'changes_needed');
    assert.deepEqual(missing, [['n-plus-one']]);
    assert.equal(tracker.statusCalls.length, 1);
    const summary = markers()[0]?.result.summary ?? '';
    assert.ok(summary.startsWith('The N+1 is back.'));
    assert.ok(summary.length > 'The N+1 is back.'.length, 'a note was added to the summary');
    assert.match(summary, /n-plus-one/);
  });

  it('only blocker and major findings are passed to the recurrence check', async () => {
    const { lessons, seen } = facts();
    const { report } = setup(lessons);
    error(await report(REVIEW));
    assert.ok(seen.length >= 1);
    for (const reported of seen) assert.ok(!reported.includes('naming'), 'a minor category is not a recurrence candidate');
    assert.ok(seen.every((reported) => reported.includes('n-plus-one')));
  });

  it('the same rule applies to the security result', async () => {
    const { lessons, missing } = facts();
    const { report } = setup(lessons, 'auditor');
    const args = { verdict: 'issues_found', summary: 'Leak again.', findings: [{ severity: 'major', category: 'n-plus-one', file: 'src/a.ts', line: 1, problem: 'Leak', fix: 'Fix' }] };
    const refused = error(await report(args));
    assert.equal(refused.category, 'invalid_result');
    assert.match(refused.message, /n-plus-one/);
    assert.equal(data(await report(args)).verdict, 'issues_found');
    assert.deepEqual(missing, [['n-plus-one']]);
  });

  it('is accepted at once when lessons is non-empty (no lesson_missing)', async () => {
    const { lessons, missing } = facts();
    const { report, markers } = setup(lessons);
    assert.equal(data(await report({ ...REVIEW, lessons: ['Lessons/n-plus-one.md'] })).verdict, 'changes_needed');
    assert.deepEqual(missing, []);
    const stored = markers()[0]?.result;
    assert.deepEqual(stored?.kind === 'review' ? stored.lessons : null, ['Lessons/n-plus-one.md']);
  });

  it('is accepted at once when a brain write happened in the run', async () => {
    const { lessons, missing, write } = facts();
    write();
    const { report } = setup(lessons);
    assert.equal(data(await report(REVIEW)).verdict, 'changes_needed');
    assert.deepEqual(missing, []);
  });

  it('is not enforced without brain: write (enforce false)', async () => {
    const { lessons, missing } = facts({ enforce: false });
    const { report } = setup(lessons);
    assert.equal(data(await report(REVIEW)).verdict, 'changes_needed');
    assert.deepEqual(missing, []);
  });

  it('is not enforced for the verdict blocked', async () => {
    const { lessons, missing } = facts();
    const { report } = setup(lessons);
    const blocked = { verdict: 'blocked', summary: 'No access.', blockers: [{ description: 'No access', needs: 'access' }], findings: REVIEW.findings };
    assert.equal(data(await report(blocked)).verdict, 'blocked');
    assert.deepEqual(missing, []);
  });

  it('is not enforced when no reported category recurs', async () => {
    const { lessons, missing } = facts({ recurringCategory: 'something-else' });
    const { report } = setup(lessons);
    assert.equal(data(await report(REVIEW)).verdict, 'changes_needed');
    assert.deepEqual(missing, []);
  });

  it('an approving review with only minor findings is not affected', async () => {
    const { lessons, missing } = facts();
    const { report } = setup(lessons);
    const approved = { verdict: 'approved', summary: 'Fine.', findings: [{ severity: 'minor', category: 'n-plus-one', problem: 'tiny' }] };
    assert.equal(data(await report(approved)).verdict, 'approved');
    assert.deepEqual(missing, []);
  });
});
