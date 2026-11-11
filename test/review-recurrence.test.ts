import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildIndex } from '../src/brain/index.ts';
import {
  attachLessons,
  buildBrainLessons,
  coreRule,
  detectRecurrence,
  knownCategories,
  lessonNotesOf,
  reviewLessonsActive,
  severeFindingsOf,
  type SevereFindingRecord,
} from '../src/brain/review-recurrence.ts';
import { Logger } from '../src/log.ts';
import { IssueArchive, type ArchivedIssue } from '../src/orchestrator/issue-archive.ts';
import type { ResultRow } from '../src/orchestrator/stage-history.ts';
import { reviewLessonSources, reviewLessonVariables } from '../src/orchestrator/worker.ts';
import { REVIEW_LESSONS_DEFAULTS, type BrainConfig } from '../src/workflow/config.ts';
import type { RoleConfig } from '../src/workflow/roles.ts';
import { tempDir } from './helpers.ts';

/** #575: recurring review findings, the lessons of a repository and their injection. */

const NOW = new Date('2026-11-11T12:00:00Z');
const SETTINGS = { windowDays: 14, minIssues: 2 };
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

function reviewRow(at: string, findings: Array<{ severity: string; category?: string | null; problem?: string }>, over: Partial<ResultRow> = {}): ResultRow {
  return {
    role: 'reviewer',
    run: `run-${at}`,
    kind: 'review',
    verdict: 'changes_needed',
    summary: 'Fix it.',
    round: 1,
    target: 'In progress',
    head_sha: null,
    created_at: at,
    url: null,
    findings: findings.map((finding) => ({ severity: finding.severity, category: finding.category ?? null, file: null, line: null, problem: finding.problem ?? 'Problem', fix: null })),
    blockers: [],
    changed_files: [],
    ...over,
  };
}

/** An issue archive as the orchestrator writes it, with the stage results only. */
function archived(identifier: string, repo: string, rows: ResultRow[]): ArchivedIssue {
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
    results: rows,
    run_trace: null,
    last_check: null,
  };
}

const screenshots = (at: string, problem = 'No after screenshot') => reviewRow(at, [{ severity: 'major', category: 'screenshots-missing', problem }]);

describe('severeFindingsOf', () => {
  it('keeps blocker and major findings with a category of review and security rows; old rows without category or findings add nothing', () => {
    const rows: ResultRow[] = [
      reviewRow(daysAgo(1), [
        { severity: 'blocker', category: 'auth-missing' },
        { severity: 'major', category: 'screenshots-missing' },
        { severity: 'minor', category: 'naming' },
        { severity: 'major' },
      ]),
      { ...reviewRow(daysAgo(1), [{ severity: 'major', category: 'x-y' }]), kind: 'implementation' },
      { ...reviewRow(daysAgo(2), []), findings: undefined },
      reviewRow(daysAgo(2), [{ severity: 'major', category: 'idor' }], { kind: 'security', role: 'security-auditor' }),
    ];
    // An archive from before #575: findings without the category key.
    const legacy = { ...reviewRow(daysAgo(3), []), findings: [{ severity: 'major', file: null, line: null, problem: 'Old', fix: null }] };
    const records = severeFindingsOf('acme/app#1', [...rows, legacy]);
    assert.deepEqual(records.map((record) => record.category), ['auth-missing', 'screenshots-missing', 'idor']);
  });
});

describe('detectRecurrence', () => {
  it('same issue, round 2: the category again in a second result recurs (same_issue)', () => {
    const current = severeFindingsOf('acme/app#1', [screenshots(daysAgo(2)), { ...screenshots(daysAgo(1)), round: 2 }]);
    const [found, ...rest] = detectRecurrence({ issue: 'acme/app#1', current, others: [], now: NOW, config: SETTINGS });
    assert.deepEqual(rest, []);
    assert.equal(found?.category, 'screenshots-missing');
    assert.deepEqual(found?.triggers, ['same_issue']);
    assert.equal(found?.findings, 2);
    assert.deepEqual(found?.issues, ['acme/app#1']);
    assert.equal(found?.lesson, null);
  });

  it('the findings being reported count as one more result of the running issue', () => {
    const current = severeFindingsOf('acme/app#1', [screenshots(daysAgo(1))]);
    assert.deepEqual(detectRecurrence({ issue: 'acme/app#1', current, others: [], now: NOW, config: SETTINGS }), []);
    const found = detectRecurrence({ issue: 'acme/app#1', current, others: [], reported: ['screenshots-missing'], now: NOW, config: SETTINGS });
    assert.deepEqual(found.map((entry) => [entry.category, entry.triggers]), [['screenshots-missing', ['same_issue']]]);
  });

  it('two issues of the repository within 14 days recur (cross_issue), with examples', () => {
    const others = severeFindingsOf('acme/app#7', [screenshots(daysAgo(10), 'Dark screenshot only')]);
    const found = detectRecurrence({ issue: 'acme/app#1', current: [], others, reported: ['screenshots-missing'], now: NOW, config: SETTINGS });
    assert.equal(found.length, 1);
    assert.deepEqual(found[0]?.triggers, ['cross_issue']);
    assert.deepEqual(found[0]?.issues, ['acme/app#1', 'acme/app#7']);
    assert.deepEqual(found[0]?.examples, [{ issue: 'acme/app#7', problem: 'Dark screenshot only' }]);
    // Before the review reports, the running issue's own earlier finding counts as its issue.
    const current = severeFindingsOf('acme/app#1', [screenshots(daysAgo(3))]);
    assert.deepEqual(detectRecurrence({ issue: 'acme/app#1', current, others, now: NOW, config: SETTINGS })[0]?.triggers, ['cross_issue']);
  });

  it('one issue only, or the other issue outside the window: no recurrence', () => {
    const current = severeFindingsOf('acme/app#1', [screenshots(daysAgo(1))]);
    assert.deepEqual(detectRecurrence({ issue: 'acme/app#1', current, others: [], now: NOW, config: SETTINGS }), []);
    const old = severeFindingsOf('acme/app#7', [screenshots(daysAgo(15))]);
    assert.deepEqual(detectRecurrence({ issue: 'acme/app#1', current, others: old, now: NOW, config: SETTINGS }), []);
    // min_issues 3 needs a third issue.
    const recent = severeFindingsOf('acme/app#7', [screenshots(daysAgo(2))]);
    assert.deepEqual(detectRecurrence({ issue: 'acme/app#1', current, others: recent, now: NOW, config: { windowDays: 14, minIssues: 3 } }), []);
  });

  it('a minor finding of the category does not count', () => {
    const minor = reviewRow(daysAgo(1), [{ severity: 'minor', category: 'screenshots-missing' }]);
    const others = severeFindingsOf('acme/app#7', [minor]);
    assert.deepEqual(detectRecurrence({ issue: 'acme/app#1', current: [], others, reported: ['screenshots-missing'], now: NOW, config: SETTINGS }), []);
  });

  it('knownCategories lists the categories with their issues, most issues first', () => {
    const records: SevereFindingRecord[] = [
      ...severeFindingsOf('acme/app#1', [screenshots(daysAgo(1))]),
      ...severeFindingsOf('acme/app#2', [screenshots(daysAgo(2)), reviewRow(daysAgo(2), [{ severity: 'major', category: 'n-plus-one' }])]),
    ];
    assert.deepEqual(knownCategories(records), [
      { category: 'screenshots-missing', issues: ['acme/app#1', 'acme/app#2'], findings: 2 },
      { category: 'n-plus-one', issues: ['acme/app#2'], findings: 1 },
    ]);
  });
});

describe('IssueArchive.forRepo', () => {
  it('reads the archives of one repository saved within the window; another repository and old files do not count', () => {
    const dir = tempDir();
    const write = (issue: ArchivedIssue, mtime: Date) => {
      const file = path.join(dir, `${issue.issue_identifier.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
      fs.writeFileSync(file, JSON.stringify(issue));
      fs.utimesSync(file, mtime, mtime);
    };
    write(archived('acme/app#7', 'acme/app', [screenshots(daysAgo(3))]), new Date(daysAgo(3)));
    write(archived('acme/other#7', 'acme/other', [screenshots(daysAgo(3))]), new Date(daysAgo(3)));
    write(archived('acme/app#5', 'acme/app', [screenshots(daysAgo(30))]), new Date(daysAgo(30)));
    fs.writeFileSync(path.join(dir, 'broken.json'), '{');
    const archive = new IssueArchive(dir, Logger.silent());
    archive.save(archived('acme/app#9', 'acme/app', []));
    const since = new Date(daysAgo(14));
    assert.deepEqual(archive.forRepo('acme/app', since).map((issue) => issue.issue_identifier).sort(), ['acme/app#7', 'acme/app#9']);
    // Memory wins over the file for the same identifier.
    archive.save(archived('acme/app#7', 'acme/app', []));
    assert.deepEqual(archive.forRepo('acme/app', since).find((issue) => issue.issue_identifier === 'acme/app#7')?.results, []);
    // The other repository's issue never shows up in the recurrence of acme/app.
    const others = archive.forRepo('acme/app', since).flatMap((issue) => severeFindingsOf(issue.issue_identifier, issue.results));
    const current = severeFindingsOf('acme/app#1', [screenshots(daysAgo(1))]);
    assert.deepEqual(detectRecurrence({ issue: 'acme/app#1', current, others, now: NOW, config: SETTINGS }), []);
  });
});

/** A vault with lessons for acme/app, another repository and none. */
function vault(): string {
  const root = tempDir();
  const note = (rel: string, front: Record<string, unknown>, body: string) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const yaml = Object.entries(front)
      .map(([key, value]) => (Array.isArray(value) ? `${key}:\n${value.map((item) => `  - ${item}`).join('\n')}` : `${key}: ${value}`))
      .join('\n');
    fs.writeFileSync(file, `---\n${yaml}\n---\n${body}`);
  };
  note('Lessons/screens.md', { type: 'lesson', status: 'candidate', repo: 'acme/app', created: '2026-11-01', updated: '2026-11-02', tags: ['review-lesson', 'review/screenshots-missing'] }, '# Screens before and after\n\nEvery UI change embeds a before and an after screenshot in the pull request body.\n\nDetails follow.\n');
  note('Lessons/conflicts.md', { type: 'lesson', status: 'approved', repo: 'acme/app', created: '2026-10-01', updated: '2026-10-20', tags: ['review-lesson', 'review/base-branch-conflict'] }, '# Merge the base branch\n\nMerge origin/develop before every hand-off and run the tests again.\n');
  note('Lessons/n-plus-one.md', { type: 'lesson', status: 'approved', repo: 'acme/app', created: '2026-10-01', updated: '2026-11-05', tags: ['review-lesson', 'review/n-plus-one'] }, '# Eager load\n\nEager load relations that a table lists.\n');
  note('Lessons/general.md', { type: 'lesson', status: 'approved', created: '2026-09-01', updated: '2026-11-10', tags: ['git'] }, '# Relative refs\n\nTests never use relative git refs.\n');
  note('Lessons/other-repo.md', { type: 'lesson', status: 'approved', repo: 'acme/other', created: '2026-09-01', tags: ['review-lesson', 'review/screenshots-missing'] }, '# Other\n\nNot for acme/app.\n');
  note('Lessons/old.md', { type: 'lesson', status: 'deprecated', repo: 'acme/app', tags: ['review/screenshots-missing'] }, '# Old\n\nDeprecated.\n');
  note('Decisions/d.md', { type: 'decision', status: 'approved', repo: 'acme/app', tags: ['review/screenshots-missing'] }, '# Decision\n\nNot a lesson.\n');
  return root;
}

describe('lessons of a repository', () => {
  it('lessonNotesOf: lessons of the repository or without one, approved and candidates, with their categories', async () => {
    const lessons = lessonNotesOf(await buildIndex(vault()), 'acme/app');
    assert.deepEqual(lessons.map((lesson) => lesson.path), ['Lessons/conflicts.md', 'Lessons/general.md', 'Lessons/n-plus-one.md', 'Lessons/screens.md']);
    const screens = lessons.find((lesson) => lesson.path === 'Lessons/screens.md');
    assert.deepEqual([screens?.status, screens?.categories, screens?.reviewLesson], ['candidate', ['screenshots-missing'], true]);
  });

  it('attachLessons: the lesson with tag review/<category> of the repository, approved before candidate', async () => {
    const lessons = lessonNotesOf(await buildIndex(vault()), 'acme/app');
    const recurring = detectRecurrence({
      issue: 'acme/app#1',
      current: severeFindingsOf('acme/app#1', [screenshots(daysAgo(2)), screenshots(daysAgo(1))]),
      others: [],
      now: NOW,
      config: SETTINGS,
    });
    assert.deepEqual(attachLessons(recurring, lessons)[0]?.lesson, { path: 'Lessons/screens.md', title: 'Screens before and after', status: 'candidate' });
    const approvedToo = [...lessons, { ...lessons.find((lesson) => lesson.path === 'Lessons/screens.md')!, path: 'Lessons/screens-approved.md', status: 'approved' }];
    assert.equal(attachLessons(recurring, approvedToo)[0]?.lesson?.path, 'Lessons/screens-approved.md');
  });

  it('coreRule: the first paragraph after the title', () => {
    assert.equal(coreRule('# Title\n\nThe rule\ncontinues.\n\nMore.'), 'The rule continues.');
    assert.equal(coreRule('# Only a title\n'), '');
    assert.ok(coreRule(`# T\n\n${'x'.repeat(600)}`).length <= 400);
  });

  it('buildBrainLessons: open categories first, then review lessons by frequency, then the rest; candidates marked', async () => {
    const root = vault();
    const lessons = lessonNotesOf(await buildIndex(root), 'acme/app');
    const value = buildBrainLessons({
      vault: root,
      lessons,
      openCategories: ['base-branch-conflict'],
      recurrenceCounts: new Map([['screenshots-missing', 5], ['n-plus-one', 1]]),
      budget: 6000,
    });
    assert.deepEqual(value.lessons.map((lesson) => lesson.path), ['Lessons/conflicts.md', 'Lessons/screens.md', 'Lessons/n-plus-one.md', 'Lessons/general.md']);
    const screens = value.lessons[1];
    assert.deepEqual([screens?.candidate, screens?.rule], [true, 'Every UI change embeds a before and an after screenshot in the pull request body.']);
    assert.equal(value.lessons[0]?.candidate, false);
    assert.deepEqual([value.more, value.total], [[], 4]);
  });

  it('buildBrainLessons: beyond the budget the rest is listed by path only', async () => {
    const root = vault();
    const lessons = lessonNotesOf(await buildIndex(root), 'acme/app');
    const value = buildBrainLessons({ vault: root, lessons, openCategories: ['screenshots-missing'], recurrenceCounts: new Map(), budget: 200 });
    assert.deepEqual(value.lessons.map((lesson) => lesson.path), ['Lessons/screens.md']);
    assert.equal(value.more.length, 3);
    const paths = buildBrainLessons({ vault: root, lessons, openCategories: [], recurrenceCounts: new Map(), budget: 0 });
    assert.deepEqual([paths.lessons.length, paths.more.length], [0, 4]);
  });

  it('reviewLessonsActive: off without brain.enabled, with review_lessons.enabled false, for brain: off or an unknown repository', () => {
    const on = { enabled: true, reviewLessons: REVIEW_LESSONS_DEFAULTS };
    assert.equal(reviewLessonsActive(on, 'read', 'acme/app'), true);
    assert.equal(reviewLessonsActive({ ...on, enabled: false }, 'read', 'acme/app'), false);
    assert.equal(reviewLessonsActive({ ...on, reviewLessons: { ...REVIEW_LESSONS_DEFAULTS, enabled: false } }, 'write', 'acme/app'), false);
    assert.equal(reviewLessonsActive(on, 'off', 'acme/app'), false);
    assert.equal(reviewLessonsActive(on, 'read', null), false);
  });
});

describe('prompt variables of a session (worker)', () => {
  const role = (result: string) => ({ name: result, result }) as unknown as RoleConfig;
  const brainConfig = (root: string, over: Partial<BrainConfig> = {}): BrainConfig => ({ enabled: true, path: root, clashWindowMs: 0, obsidianUrl: '', reviewLessons: REVIEW_LESSONS_DEFAULTS, ...over });
  const history = (rows: ResultRow[]) => {
    // The running issue's persisted results as the worker sees them.
    return {
      results: rows.map((row) => ({
        result: { schema: 'symphony.result/v1', kind: 'review', verdict: 'changes_needed', summary: row.summary, blockers: [], follow_ups: [], findings: (row.findings ?? []).map((f) => ({ severity: f.severity, category: f.category ?? undefined, problem: f.problem })), refuted: [], checked: [], confirmed_goals: [], lessons: [] },
        meta: { role: 'reviewer', run: row.run, round: row.round, profile: null, workflow_hash: null, head_sha: null, checks: null, target: 'In progress', created_at: row.created_at },
      })),
    };
  };
  const support = (rows: ResultRow[], openCategory: string | null) =>
    ({
      history: history(rows),
      results: { open_findings: openCategory === null ? [] : [{ severity: 'major', category: openCategory, file: null, line: null, problem: 'x', fix: null }], security_findings: [] },
    }) as never;

  async function sources(root: string, over: Partial<BrainConfig>, mode: 'off' | 'read' | 'write', result: string) {
    const archive = { forRepo: () => [archived('acme/app#7', 'acme/app', [screenshots(new Date(Date.now() - 86_400_000).toISOString())])] };
    return reviewLessonSources(
      { workflow: { config: { brain: brainConfig(root, over) } }, issue: { identifier: 'acme/app#1' }, archive, brainIndex: null, logger: Logger.silent() },
      role(result),
      mode,
      'acme/app',
    );
  }

  it('the reviewer gets recurring_findings with the lesson and known_categories; the developer gets brain_lessons', async () => {
    const root = vault();
    const rows = [screenshots(new Date(Date.now() - 3_600_000).toISOString())];
    const review = reviewLessonVariables(role('review'), await sources(root, {}, 'write', 'review'), support(rows, null));
    assert.deepEqual(review.recurring_findings.map((entry) => [entry.category, entry.triggers, entry.lesson?.path]), [['screenshots-missing', ['cross_issue'], 'Lessons/screens.md']]);
    assert.deepEqual(review.known_categories.map((entry) => entry.category), ['screenshots-missing']);
    assert.equal(review.brain_lessons, null);

    const developer = reviewLessonVariables(role('implementation'), await sources(root, {}, 'read', 'implementation'), support(rows, 'n-plus-one'));
    assert.equal(developer.brain_lessons?.lessons[0]?.path, 'Lessons/n-plus-one.md');
    assert.deepEqual(developer.recurring_findings, []);
  });

  it('a review without recurrence gets an empty recurring_findings', async () => {
    const root = vault();
    const archive = { forRepo: () => [] };
    const lone = await reviewLessonSources(
      { workflow: { config: { brain: brainConfig(root) } }, issue: { identifier: 'acme/app#1' }, archive, brainIndex: null, logger: Logger.silent() },
      role('review'),
      'write',
      'acme/app',
    );
    assert.deepEqual(reviewLessonVariables(role('review'), lone, support([screenshots(new Date().toISOString())], null)).recurring_findings, []);
  });

  it('everything is empty with review_lessons.enabled false, brain: off or brain.enabled false', async () => {
    const root = vault();
    for (const [over, mode] of [[{ reviewLessons: { ...REVIEW_LESSONS_DEFAULTS, enabled: false } }, 'read'], [{}, 'off'], [{ enabled: false }, 'read']] as const) {
      const none = await sources(root, over, mode, 'implementation');
      assert.equal(none, null);
      assert.deepEqual(reviewLessonVariables(role('implementation'), none, support([], 'n-plus-one')), { recurring_findings: [], known_categories: [], brain_lessons: null });
    }
  });
});
