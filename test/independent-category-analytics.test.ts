import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PricingStore } from '../src/costs/pricing.ts';
import { computeAnalytics, type AnalyticsFilter } from '../src/history/analytics.ts';
import { HistoryLog, readHistory, type HistoryEntry } from '../src/history/history.ts';
import { Logger } from '../src/log.ts';
import { resultRows, resultsTemplateValue, buildStageHistory, type PersistedResult } from '../src/orchestrator/stage-history.ts';
import {
  RESULT_SCHEMA,
  checkSummary,
  decodeMarker,
  encodeMarker,
  parseResult,
  renderResultComment,
  type ResultMeta,
  type StageResult,
} from '../src/workflow/results.ts';
import * as resultsModule from '../src/workflow/results.ts';
import { tempDir } from './helpers.ts';

// Namespace access, so a missing export fails only its own test.
const severeCategoryCounts = (result: StageResult): Record<string, number> =>
  (resultsModule as unknown as { severeCategoryCounts: (r: StageResult) => Record<string, number> }).severeCategoryCounts(result);

const meta: ResultMeta = {
  role: 'reviewer',
  run: 'run-1',
  round: 2,
  profile: 'standard',
  workflow_hash: 'f'.repeat(64),
  head_sha: 'a'.repeat(40),
  checks: null,
  target: 'In progress',
  created_at: '2026-10-18T10:00:05.000Z',
};

const finding = (over: Record<string, unknown> = {}) => ({ severity: 'major', file: 'src/a.ts', line: 3, problem: 'Off by one', fix: 'Use <=', ...over });
const reviewInput = (findings: unknown[]) => ({ verdict: 'changes_needed', summary: 'Findings.', findings });
const securityInput = (findings: unknown[]) => ({ verdict: 'issues_found', summary: 'Findings.', findings });

function parsed(kind: 'review' | 'security', findings: unknown[]): StageResult {
  const outcome = parseResult(kind, kind === 'review' ? reviewInput(findings) : securityInput(findings));
  if (!outcome.ok) assert.fail(outcome.message);
  return outcome.result;
}

describe('finding category (#575)', () => {
  describe('schema', () => {
    const valid = ['null-check', 'a', 'x1', '2fa-flow', 'a-b-c', 'a'.repeat(40), 'abc123'];
    const invalid: Array<[string, string]> = [
      ['uppercase', 'Null-Check'],
      ['space', 'null check'],
      ['41 characters', 'a'.repeat(41)],
      ['leading hyphen', '-null'],
      ['trailing hyphen', 'null-'],
      ['double hyphen', 'null--check'],
      ['underscore', 'null_check'],
      ['empty', ''],
      ['dot', 'a.b'],
    ];

    for (const kind of ['review', 'security'] as const) {
      const input = (findings: unknown[]) => (kind === 'review' ? reviewInput(findings) : securityInput(findings));
      for (const slug of valid) {
        it(`${kind}: accepts the slug "${slug.length > 20 ? `${slug.slice(0, 8)}...(${slug.length})` : slug}"`, () => {
          const outcome = parseResult(kind, input([finding({ category: slug })]));
          assert.equal(outcome.ok, true);
          if (outcome.ok && (outcome.result.kind === 'review' || outcome.result.kind === 'security')) {
            assert.equal(outcome.result.findings[0]?.category, slug);
          }
        });
      }
      for (const [name, slug] of invalid) {
        it(`${kind}: rejects a slug with ${name}`, () => {
          const outcome = parseResult(kind, input([finding({ category: slug })]));
          assert.equal(outcome.ok, false);
          if (!outcome.ok) assert.match(outcome.message, /category/);
        });
      }
      it(`${kind}: a finding without category stays valid and has none`, () => {
        const outcome = parseResult(kind, input([finding(), { severity: 'nit', problem: 'Typo' }]));
        assert.equal(outcome.ok, true);
        if (outcome.ok && (outcome.result.kind === 'review' || outcome.result.kind === 'security')) {
          assert.equal(outcome.result.findings[0]?.category, undefined);
        }
      });
      it(`${kind}: one invalid slug among valid findings invalidates the result`, () => {
        assert.equal(parseResult(kind, input([finding({ category: 'ok-slug' }), finding({ category: 'Bad Slug' })])).ok, false);
      });
    }

    it('rejects a non-string category', () => {
      assert.equal(parseResult('review', reviewInput([finding({ category: 7 })])).ok, false);
    });
  });

  describe('severeCategoryCounts', () => {
    it('counts blocker and major findings per category, ignoring minor, nit and uncategorised ones', () => {
      const result = parsed('review', [
        finding({ category: 'null-check', severity: 'major' }),
        finding({ category: 'null-check', severity: 'blocker' }),
        finding({ category: 'naming', severity: 'minor' }),
        finding({ category: 'naming', severity: 'nit' }),
        finding({ category: 'error-handling', severity: 'major' }),
        finding({ severity: 'major' }),
      ]);
      assert.deepEqual(severeCategoryCounts(result), { 'null-check': 2, 'error-handling': 1 });
    });

    it('is empty without categories', () => {
      assert.deepEqual(severeCategoryCounts(parsed('review', [finding()])), {});
    });
  });

  describe('marker and comment', () => {
    it('keeps the category through encode and decode, for review and security', () => {
      for (const kind of ['review', 'security'] as const) {
        const result = parsed(kind, [finding({ category: 'null-check' }), finding({ severity: 'minor' })]);
        const decoded = decodeMarker(`text\n\n${encodeMarker(result, meta)}\n`);
        assert.ok(decoded !== null && (decoded.result.kind === 'review' || decoded.result.kind === 'security'));
        assert.equal(decoded.result.findings[0]?.category, 'null-check');
        assert.equal(decoded.result.findings[1]?.category, undefined);
        assert.deepEqual(decoded.result, result);
      }
    });

    it('still decodes an old marker whose findings have no category', () => {
      const old = {
        schema: RESULT_SCHEMA,
        kind: 'review',
        verdict: 'changes_needed',
        summary: 'x',
        blockers: [],
        follow_ups: [],
        findings: [{ severity: 'major', problem: 'Old finding' }],
        checked: [],
        meta,
      };
      const decoded = decodeMarker(`<!-- symphony:result:v1 ${Buffer.from(JSON.stringify(old)).toString('base64url')} -->`);
      assert.ok(decoded !== null && decoded.result.kind === 'review');
      assert.equal(decoded.result.findings[0]?.problem, 'Old finding');
      assert.equal(decoded.result.findings[0]?.category, undefined);
    });

    it('shows the category in the rendered comment', () => {
      for (const kind of ['review', 'security'] as const) {
        const comment = renderResultComment(parsed(kind, [finding({ category: 'zz-unique-category' })]), meta);
        const visible = comment.slice(0, comment.indexOf('<!-- symphony:result:v1'));
        assert.match(visible, /zz-unique-category/);
      }
    });

    it('does not mention a category in the visible comment when none is set', () => {
      const comment = renderResultComment(parsed('review', [finding()]), meta);
      const visible = comment.slice(0, comment.indexOf('<!-- symphony:result:v1'));
      assert.doesNotMatch(visible, /categor/i);
    });
  });

  describe('issue archive and template values', () => {
    const persisted = (kind: 'review' | 'security', findings: unknown[], over: Partial<ResultMeta> = {}): PersistedResult => ({
      result: parsed(kind, findings),
      meta: { ...meta, role: kind === 'review' ? 'reviewer' : 'security-auditor', ...over },
    });

    it('resultRows carries the category per finding, null without one', () => {
      const [row] = resultRows([persisted('review', [finding({ category: 'null-check' }), finding({ severity: 'minor' })])]);
      assert.deepEqual(row?.findings?.map((f) => f.category), ['null-check', null]);
    });

    it('resultRows carries the category of security findings', () => {
      const [row] = resultRows([persisted('security', [finding({ category: 'token-leak', severity: 'blocker' })])]);
      assert.equal(row?.findings?.[0]?.category, 'token-leak');
    });

    it('results.open_findings[].category is the slug or null', () => {
      const value = resultsTemplateValue(buildStageHistory([persisted('review', [finding({ category: 'null-check' }), finding({ severity: 'minor' })])]));
      assert.deepEqual(value.open_findings.map((f) => f.category), ['null-check', null]);
    });

    it('results.security_findings[].category is the slug or null', () => {
      const value = resultsTemplateValue(
        buildStageHistory([persisted('security', [finding({ category: 'token-leak', severity: 'blocker' }), finding({ severity: 'minor' })])]),
      );
      assert.deepEqual(value.security_findings.map((f) => f.category), ['token-leak', null]);
    });
  });

  describe('history line stage_result', () => {
    function history() {
      const dir = tempDir();
      const file = path.join(dir, 'model-costs.yml');
      fs.writeFileSync(file, 'default: { input: 5, output: 25 }\n');
      return new HistoryLog(path.join(dir, 'repositories'), new PricingStore(file, Logger.silent()), Logger.silent());
    }
    const base = { repo: 'acme/app', issue: 'acme/app#1', run: 'r1', role: 'reviewer', kind: 'review', verdict: 'changes_needed', round: 1, target: null, profile: null, complexity: null, findings: 3 };

    it('writes categories=<slug>:<n>,... and omits it when there are none', () => {
      const log = history();
      log.stageResult({ ...base, categories: { 'null-check': 2, 'error-handling': 1 }, at: new Date('2026-10-04T08:00:00Z') });
      log.stageResult({ ...base, at: new Date('2026-10-04T08:01:00Z') });
      log.stageResult({ ...base, categories: {}, at: new Date('2026-10-04T08:02:00Z') });
      log.stageResult({ ...base, categories: null, at: new Date('2026-10-04T08:03:00Z') });
      const [with_, absent, empty, nul] = readHistory(log.dir, 'acme/app').entries;
      assert.deepEqual((with_?.fields.categories ?? '').split(',').sort(), ['error-handling:1', 'null-check:2']);
      assert.equal('categories' in (absent?.fields ?? {}), false);
      assert.equal('categories' in (empty?.fields ?? {}), false);
      assert.equal('categories' in (nul?.fields ?? {}), false);
    });
  });

  describe('GET /api/v1/history/analytics finding_categories', () => {
    const NOW = new Date('2026-10-20T00:00:00Z');
    const filter: AnalyticsFilter = { from: null, to: null, repo: null, model: null, timeZone: 'UTC' };
    const pricing = (() => {
      const dir = tempDir();
      const file = path.join(dir, 'model-costs.yml');
      fs.writeFileSync(file, 'default: { input: 5, output: 25 }\n');
      return new PricingStore(file, Logger.silent()).current();
    })();
    const line = (ts: string, issue: string, categories: string | undefined, repo = 'acme/app'): HistoryEntry => ({
      ts,
      event: 'stage_result',
      fields: { repo, issue, role: 'reviewer', kind: 'review', verdict: 'changes_needed', findings: '3', ...(categories === undefined ? {} : { categories }) },
    });
    const stats = (entries: HistoryEntry[], lessons?: Array<{ repo: string | null; category: string; path: string; since: string }>) =>
      (computeAnalytics(entries, pricing, filter, NOW, [], lessons) as unknown as { finding_categories: Array<Record<string, unknown>> }).finding_categories;

    const two = [line('2026-10-03T10:00:00.000Z', 'acme/app#1', 'null-check:2'), line('2026-10-05T10:00:00.000Z', 'acme/app#2', 'null-check:1')];

    it('counts findings and issues per category, with no lesson by default', () => {
      assert.deepEqual(stats(two), [{ category: 'null-check', findings: 3, issues: 2, lesson: null, findings_after_lesson: null }]);
    });

    it('counts two lines of two issues with one finding each as findings 2, issues 2', () => {
      const entries = [line('2026-10-03T10:00:00.000Z', 'acme/app#1', 'x-cat:1'), line('2026-10-05T10:00:00.000Z', 'acme/app#2', 'x-cat:1')];
      const [row] = stats(entries);
      assert.equal(row?.findings, 2);
      assert.equal(row?.issues, 2);
    });

    it('counts several lines of one issue as one issue', () => {
      const entries = [line('2026-10-03T10:00:00.000Z', 'acme/app#1', 'x-cat:1'), line('2026-10-05T10:00:00.000Z', 'acme/app#1', 'x-cat:1')];
      const [row] = stats(entries);
      assert.deepEqual([row?.findings, row?.issues], [2, 1]);
    });

    it('attaches a lesson and counts the findings after its since date', () => {
      const entries = [line('2026-10-03T10:00:00.000Z', 'acme/app#1', 'x-cat:1'), line('2026-10-07T10:00:00.000Z', 'acme/app#2', 'x-cat:1')];
      const [row] = stats(entries, [{ repo: 'acme/app', category: 'x-cat', path: 'Lessons/x-cat.md', since: '2026-10-05' }]);
      assert.deepEqual(row?.lesson, { path: 'Lessons/x-cat.md', since: '2026-10-05' });
      assert.equal(row?.findings_after_lesson, 1);
      assert.equal(row?.findings, 2);
    });

    it('a lesson without repo applies to every repository', () => {
      const entries = [line('2026-10-03T10:00:00.000Z', 'other/repo#1', 'x-cat:1', 'other/repo'), line('2026-10-07T10:00:00.000Z', 'other/repo#2', 'x-cat:2', 'other/repo')];
      const [row] = stats(entries, [{ repo: null, category: 'x-cat', path: 'Lessons/g.md', since: '2026-10-05' }]);
      assert.deepEqual(row?.lesson, { path: 'Lessons/g.md', since: '2026-10-05' });
      assert.equal(row?.findings_after_lesson, 2);
    });

    it('does not attach the lesson of another repository', () => {
      const [row] = stats(two, [{ repo: 'other/repo', category: 'null-check', path: 'Lessons/o.md', since: '2026-10-04' }]);
      assert.equal(row?.lesson, null);
      assert.equal(row?.findings_after_lesson, null);
    });

    it('does not attach the lesson of another category', () => {
      const [row] = stats(two, [{ repo: 'acme/app', category: 'naming', path: 'Lessons/n.md', since: '2026-10-04' }]);
      assert.equal(row?.lesson, null);
      assert.equal(row?.findings_after_lesson, null);
    });

    it('sorts by findings, most first, and sums several categories of one line', () => {
      const entries = [line('2026-10-03T10:00:00.000Z', 'acme/app#1', 'a-cat:1,b-cat:4'), line('2026-10-04T10:00:00.000Z', 'acme/app#2', 'c-cat:2')];
      assert.deepEqual(stats(entries).map((r) => [r.category, r.findings]), [['b-cat', 4], ['c-cat', 2], ['a-cat', 1]]);
    });

    it('is empty for old lines without categories and without lines', () => {
      assert.deepEqual(stats([line('2026-10-03T10:00:00.000Z', 'acme/app#1', undefined)]), []);
      assert.deepEqual(stats([]), []);
    });

    it('works through computeAnalytics without the lessons argument', () => {
      const a = computeAnalytics(two, pricing, filter, NOW) as unknown as { finding_categories: unknown[] };
      assert.equal(a.finding_categories.length, 1);
    });

    it('follows the period filter', () => {
      const [row] = (computeAnalytics(two, pricing, { ...filter, from: new Date('2026-10-04T00:00:00Z') }, NOW) as unknown as { finding_categories: Array<Record<string, unknown>> }).finding_categories;
      assert.deepEqual([row?.findings, row?.issues], [1, 1]);
    });
  });
});
