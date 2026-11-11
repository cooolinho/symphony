import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildIndex } from '../src/brain/index.ts';
import { PricingStore } from '../src/costs/pricing.ts';
import { computeAnalytics, findingCategoryStats, type AnalyticsFilter } from '../src/history/analytics.ts';
import { HistoryLog, readHistory } from '../src/history/history.ts';
import { Logger } from '../src/log.ts';
import { buildStageHistory, resultRows, resultsTemplateValue } from '../src/orchestrator/stage-history.ts';
import { commandSkills } from '../src/workflow/command.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { decodeMarker, encodeMarker, parseResult, renderResultMarkdown, severeCategoryCounts, type ResultMeta, type StageResult } from '../src/workflow/results.ts';
import { compilePrompt, issueTemplateValue, renderPrompt } from '../src/workflow/template.ts';
import { makeIssue, tempDir } from './helpers.ts';

/** #575: finding categories through result, marker, archive rows, history line and analytics; the prompt blocks. */

const root = path.join(import.meta.dirname, '..');
const META: ResultMeta = { role: 'reviewer', run: 'r1', round: 1, profile: null, workflow_hash: null, head_sha: null, checks: null, target: 'In progress', created_at: '2026-11-10T10:00:00Z' };

function review(findings: unknown[], extra: Record<string, unknown> = {}): StageResult {
  const parsed = parseResult('review', { verdict: 'changes_needed', summary: 'Fix it.', findings, ...extra });
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  return parsed.result;
}

describe('finding category in the result (AC1)', () => {
  it('accepts a kebab-case slug of at most 40 characters and rejects others', () => {
    for (const category of ['screenshots-missing', 'n-plus-one', 'a', 'x1-2', 'a'.repeat(40)]) {
      assert.ok(parseResult('review', { verdict: 'changes_needed', summary: 's', findings: [{ severity: 'major', category, problem: 'p' }] }).ok, category);
    }
    for (const category of ['Screenshots', 'two words', 'a--b', '-a', 'a-', 'a_b', 'a'.repeat(41), '']) {
      const parsed = parseResult('review', { verdict: 'changes_needed', summary: 's', findings: [{ severity: 'major', category, problem: 'p' }] });
      assert.equal(parsed.ok, false, category);
      if (!parsed.ok) assert.match(parsed.message, /findings\[0\]\.category/);
    }
  });

  it('keeps results without a category valid, also in security results', () => {
    assert.ok(parseResult('review', { verdict: 'changes_needed', summary: 's', findings: [{ severity: 'major', problem: 'p' }] }).ok);
    assert.ok(parseResult('security', { verdict: 'issues_found', summary: 's', findings: [{ severity: 'major', category: 'idor', problem: 'p' }], lessons: ['Lessons/idor.md'] }).ok);
  });

  it('keeps the category and the lessons in the marker and shows them in the comment', () => {
    const result = review([{ severity: 'major', category: 'screenshots-missing', problem: 'No screenshot' }], { lessons: ['Lessons/screens.md'] });
    const decoded = decodeMarker(encodeMarker(result, META));
    assert.ok(decoded !== null && decoded.result.kind === 'review');
    assert.equal(decoded.result.findings[0]?.category, 'screenshots-missing');
    assert.deepEqual(decoded.result.lessons, ['Lessons/screens.md']);
    const markdown = renderResultMarkdown(result, META);
    assert.match(markdown, /\*\*major\*\* \[screenshots-missing\] — No screenshot/);
    assert.match(markdown, /\*\*Lessons\*\*\n- `Lessons\/screens\.md`/);
  });

  it('a marker from before categories still decodes', () => {
    const old = { schema: 'symphony.result/v1', kind: 'review', verdict: 'changes_needed', summary: 's', findings: [{ severity: 'major', problem: 'p' }] };
    const text = `<!-- symphony:result:v1 ${Buffer.from(JSON.stringify({ ...old, meta: META })).toString('base64url')} -->`;
    const decoded = decodeMarker(text);
    assert.ok(decoded !== null && decoded.result.kind === 'review');
    assert.equal(decoded.result.findings[0]?.category, undefined);
    assert.deepEqual(decoded.result.lessons, []);
  });

  it('severeCategoryCounts counts blocker and major findings per category', () => {
    const result = review([
      { severity: 'major', category: 'a', problem: 'p' },
      { severity: 'blocker', category: 'a', problem: 'p' },
      { severity: 'major', category: 'b', problem: 'p' },
      { severity: 'minor', category: 'c', problem: 'p' },
      { severity: 'major', problem: 'p' },
    ]);
    assert.deepEqual(severeCategoryCounts(result), { a: 2, b: 1 });
  });

  it('the archive rows and the prompt findings carry the category, null without one', () => {
    const result = review([{ severity: 'major', category: 'screenshots-missing', problem: 'p' }, { severity: 'nit', problem: 'q' }]);
    const rows = resultRows([{ result, meta: META }]);
    assert.deepEqual(rows[0]?.findings?.map((finding) => finding.category), ['screenshots-missing', null]);
    const value = resultsTemplateValue(buildStageHistory([{ result, meta: META }]));
    assert.deepEqual(value.open_findings.map((finding) => finding.category), ['screenshots-missing', null]);
  });

  it('the stage_result history line has categories=slug:n and leaves it out without categories', () => {
    const dir = tempDir();
    const log = new HistoryLog(path.join(dir, 'repositories'), new PricingStore(path.join(root, 'model-costs.yml'), Logger.silent()), Logger.silent());
    const line = { repo: 'acme/app', issue: 'acme/app#1', run: 'r1', role: 'reviewer', kind: 'review', verdict: 'changes_needed', round: 1, target: null, profile: null, complexity: null, findings: 3 };
    log.stageResult({ ...line, categories: { a: 2, b: 1 }, at: new Date('2026-11-10T10:00:00Z') });
    log.stageResult({ ...line, categories: {}, at: new Date('2026-11-10T10:01:00Z') });
    const [counted, plain] = readHistory(log.dir, 'acme/app').entries;
    assert.equal(counted?.fields.categories, 'a:2,b:1');
    assert.equal('categories' in (plain?.fields ?? {}), false);
  });
});

describe('IndexedNote.tags', () => {
  it('reads the frontmatter tags as a lowercased list; a single string is one tag', async () => {
    const vault = tempDir();
    fs.mkdirSync(path.join(vault, 'Lessons'));
    fs.writeFileSync(path.join(vault, 'Lessons', 'a.md'), '---\ntype: lesson\nstatus: candidate\ntags:\n  - Review-Lesson\n  - " review/screenshots-missing "\n  - 3\n---\n# A\n');
    fs.writeFileSync(path.join(vault, 'Lessons', 'b.md'), '---\ntype: lesson\ntags: git\n---\n# B\n');
    fs.writeFileSync(path.join(vault, 'Lessons', 'c.md'), '# C\n');
    const index = await buildIndex(vault);
    assert.deepEqual(index.notes.get('Lessons/a.md')?.tags, ['review-lesson', 'review/screenshots-missing']);
    assert.deepEqual(index.notes.get('Lessons/b.md')?.tags, ['git']);
    assert.deepEqual(index.notes.get('Lessons/c.md')?.tags, []);
  });
});

describe('analytics: finding categories (#575)', () => {
  const at = (iso: string) => Date.parse(iso);
  const results: Array<{ repo: string; issue: string; categories: Record<string, number>; ms: number }> = [
    { repo: 'acme/app', issue: 'acme/app#1', categories: { 'screenshots-missing': 1 }, ms: at('2026-11-02T10:00:00Z') },
    { repo: 'acme/app', issue: 'acme/app#2', categories: { 'screenshots-missing': 1, 'n-plus-one': 2 }, ms: at('2026-11-06T10:00:00Z') },
    { repo: 'acme/other', issue: 'acme/other#3', categories: { 'screenshots-missing': 1 }, ms: at('2026-11-07T10:00:00Z') },
  ];

  it('counts findings and issues per category, with the lesson since and the findings after it', () => {
    const stats = findingCategoryStats(results, [{ repo: 'acme/app', category: 'screenshots-missing', path: 'Lessons/screens.md', since: '2026-11-04T00:00:00.000Z' }]);
    assert.deepEqual(stats, [
      { category: 'screenshots-missing', findings: 3, issues: 3, lesson: { path: 'Lessons/screens.md', since: '2026-11-04T00:00:00.000Z' }, findings_after_lesson: 1 },
      { category: 'n-plus-one', findings: 2, issues: 1, lesson: null, findings_after_lesson: null },
    ]);
  });

  it('a lesson without a repository counts for every repository; one of another repository for none', () => {
    const general = findingCategoryStats(results, [{ repo: null, category: 'screenshots-missing', path: 'Lessons/g.md', since: '2026-11-04T00:00:00.000Z' }]);
    assert.equal(general[0]?.findings_after_lesson, 2);
    const foreign = findingCategoryStats(results, [{ repo: 'acme/else', category: 'screenshots-missing', path: 'Lessons/x.md', since: '2026-11-01T00:00:00.000Z' }]);
    assert.equal(foreign[0]?.lesson, null);
  });

  it('computeAnalytics returns finding_categories from the stage_result lines of the period', () => {
    const dir = tempDir();
    const pricing = new PricingStore(path.join(root, 'model-costs.yml'), Logger.silent());
    const log = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
    const line = { repo: 'acme/app', run: 'r1', role: 'reviewer', kind: 'review', verdict: 'changes_needed', round: 1, target: null, profile: null, complexity: null, findings: 1 };
    log.stageResult({ ...line, issue: 'acme/app#1', categories: { 'screenshots-missing': 1 }, at: new Date('2026-11-02T10:00:00Z') });
    log.stageResult({ ...line, issue: 'acme/app#2', categories: { 'screenshots-missing': 1 }, at: new Date('2026-11-06T10:00:00Z') });
    log.stageResult({ ...line, issue: 'acme/app#3', at: new Date('2026-11-06T11:00:00Z') });
    const filter: AnalyticsFilter = { from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-11-10T00:00:00Z'), repo: null, model: null, timeZone: 'UTC' };
    const { entries } = readHistory(log.dir, null);
    const lessons = [{ repo: 'acme/app', category: 'screenshots-missing', path: 'Lessons/screens.md', since: '2026-11-04T00:00:00.000Z' }];
    const analytics = computeAnalytics(entries, pricing.current(), filter, new Date('2026-11-10T00:00:00Z'), [], lessons);
    assert.deepEqual(analytics.finding_categories, [
      { category: 'screenshots-missing', findings: 2, issues: 2, lesson: { path: 'Lessons/screens.md', since: '2026-11-04T00:00:00.000Z' }, findings_after_lesson: 1 },
    ]);
    assert.deepEqual(computeAnalytics(entries, pricing.current(), filter, new Date('2026-11-10T00:00:00Z')).finding_categories[0]?.lesson, null);
  });
});

describe('prompt blocks (AC3, AC4)', () => {
  async function render(role: string, scope: Record<string, unknown>): Promise<string> {
    const { definition } = await loadWorkflowFile(path.join(root, 'WORKFLOW.md'));
    const template = compilePrompt(definition.promptTemplate, definition.partials);
    assert.equal(template.parseError, null);
    const issue = makeIssue({ id: 'PVTI_1', identifier: 'acme/app#42', title: 'Add invoices', description: 'Create it.', state: 'In progress', labels: ['feature', 'complexity: m'] });
    return renderPrompt(template, { issue: issueTemplateValue(issue, commandSkills([path.join(root, '.claude')])), attempt: null, role, agents: [], project_types: [], ...scope });
  }
  const recurring = [
    {
      category: 'screenshots-missing',
      triggers: ['cross_issue'],
      findings: 3,
      issues: ['acme/app#1', 'acme/app#7'],
      examples: [{ issue: 'acme/app#7', problem: 'Only a dark screenshot' }],
      lesson: { path: 'Lessons/screens.md', title: 'Screens', status: 'candidate' },
    },
  ];
  const lessons = {
    lessons: [
      { title: 'Screens before and after', path: 'Lessons/screens.md', status: 'candidate', candidate: true, categories: ['screenshots-missing'], rule: 'Embed a before and an after screenshot.' },
      { title: 'Merge the base', path: 'Lessons/conflicts.md', status: 'approved', candidate: false, categories: [], rule: 'Merge origin/develop first.' },
    ],
    more: ['Lessons/rest.md'],
    total: 3,
  };
  const openFindings = { open_findings: [{ severity: 'major', category: 'screenshots-missing', file: 'README.md', line: null, problem: 'No screenshot', fix: null }] };

  it('the reviewer prompt has the recurring block only with recurring_findings, with lesson and known categories', async () => {
    const plain = await render('reviewer', { brain: 'write' });
    assert.doesNotMatch(plain, /## Recurring findings/);
    const prompt = await render('reviewer', { brain: 'write', recurring_findings: recurring, known_categories: [{ category: 'screenshots-missing', issues: ['acme/app#1', 'acme/app#7'], findings: 3 }] });
    assert.match(prompt, /## Recurring findings/);
    assert.match(prompt, /- `screenshots-missing` \(cross_issue; 3 finding\(s\) in acme\/app#1, acme\/app#7\): lesson `Lessons\/screens\.md` \(candidate\)/);
    assert.match(prompt, /  - acme\/app#7: Only a dark screenshot/);
    assert.match(prompt, /Finding categories already used in this repository .*`screenshots-missing` \(2 issue\(s\)\)/);
    assert.match(prompt, /`lessons`: the vault paths of the lessons/);
    assert.match(prompt, /tags `review-lesson` and `review\/<category>`/);
    assert.match(plain, /Give every `blocker` and `major` finding a `category`/);
  });

  it('the security auditor gets the recurring block and, with brain: read, no write instruction', async () => {
    const prompt = await render('security-auditor', { brain: 'read', recurring_findings: recurring });
    assert.match(prompt, /## Recurring findings/);
    assert.match(prompt, /You cannot write to the vault: for a recurring category without a lesson/);
  });

  it('the developer prompt has the lessons before the open findings, candidates marked, the rest by path', async () => {
    const prompt = await render('developer', { brain: 'read', brain_lessons: lessons, results: openFindings });
    const block = prompt.indexOf('## Lessons of this repository');
    const findings = prompt.indexOf('## Open findings of the latest agent review');
    assert.ok(block !== -1 && findings !== -1 && block < findings, 'lessons come before the open findings');
    assert.match(prompt, /- \*\*Screens before and after\*\* \(`Lessons\/screens\.md`, candidate: check it against the code, categories: screenshots-missing\): Embed a before and an after screenshot\./);
    assert.match(prompt, /- \*\*Merge the base\*\* \(`Lessons\/conflicts\.md`\): Merge origin\/develop first\./);
    assert.match(prompt, /More lessons, by path .*`Lessons\/rest\.md`/);
    assert.match(prompt, /\[major, screenshots-missing\] README\.md — No screenshot/);
    assert.match(prompt, /Before your first change, run `brain_search` for the topic of the issue .*This is a rework round: read the lessons for the categories of the open findings/);
  });

  it('test engineer and architect render the lessons too; without brain_lessons or with brain off there is no block', async () => {
    for (const role of ['test-engineer', 'architect']) {
      assert.match(await render(role, { brain: 'read', brain_lessons: lessons }), /## Lessons of this repository/, role);
    }
    const none = await render('developer', { brain: 'read', results: openFindings });
    assert.doesNotMatch(none, /## Lessons of this repository/);
    const off = await render('developer', { brain: 'off', brain_lessons: null, results: openFindings });
    assert.doesNotMatch(off, /Lessons of this repository|brain_search/);
  });
});
