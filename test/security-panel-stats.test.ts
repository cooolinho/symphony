import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PricingStore } from '../src/costs/pricing.ts';
import { computeAnalytics, type AnalyticsFilter } from '../src/history/analytics.ts';
import { HistoryLog, readHistory } from '../src/history/history.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { Logger } from '../src/log.ts';
import { PANEL_LENSES, PANEL_MAX_REFUTING_VOTES, panelVoteCounts } from '../src/workflow/results.ts';
import { renderPage, until } from './helpers.ts';
import { analyticsFixture, entriesFixture } from './helpers/page-fixtures.ts';
import { tempDir } from './helpers.ts';

// #554, independent of the implementation's own tests: the whole way from a security result with panel votes via the
// stage_result line to subagent_evaluation.security_panel and the statistics page.

type Verdict = 'confirmed' | 'refuted';
const vote = (lens: string, verdict: Verdict) => ({ lens, verdict, evidence: 'src/a.ts:1' });
const candidate = (votes: Array<[string, Verdict]>) => ({
  severity: 'major',
  problem: 'p',
  verification: { status: votes.some(([, v]) => v === 'refuted') ? 'refuted' : 'confirmed', evidence: 'e', votes: votes.map(([l, v]) => vote(l, v)) },
});
const security = (findings: unknown[], refuted: unknown[] = [], kind = 'security') =>
  ({ kind, verdict: 'issues_found', summary: 's', findings, refuted }) as unknown as Parameters<typeof panelVoteCounts>[0];

const ALL_OK: Array<[string, Verdict]> = [['reachability', 'confirmed'], ['impact', 'confirmed'], ['defenses', 'confirmed']];
const ONE_REFUTES: Array<[string, Verdict]> = [['reachability', 'confirmed'], ['impact', 'refuted'], ['defenses', 'confirmed']];
const TWO_REFUTE: Array<[string, Verdict]> = [['reachability', 'confirmed'], ['impact', 'refuted'], ['defenses', 'refuted']];
const ALL_REFUTE: Array<[string, Verdict]> = [['reachability', 'refuted'], ['impact', 'refuted'], ['defenses', 'refuted']];

const PRICES = 'default: { input: 5, output: 25 }\n';
function history() {
  const dir = tempDir();
  const file = path.join(dir, 'model-costs.yml');
  fs.writeFileSync(file, PRICES);
  const pricing = new PricingStore(file, Logger.silent());
  return { log: new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent()), pricing, dir };
}
const filter = (over: Partial<AnalyticsFilter> = {}): AnalyticsFilter => ({ from: null, to: null, repo: null, model: null, timeZone: 'UTC', ...over });
const NOW = new Date('2026-10-06T00:00:00Z');

function write(h: ReturnType<typeof history>, repo: string, at: string, result: Parameters<typeof panelVoteCounts>[0], issue = '#1') {
  h.log.stageResult({
    repo, issue: repo + issue, run: null, role: 'security-auditor', kind: result.kind, verdict: 'issues_found', round: null, target: null,
    profile: 'feature', complexity: 'L', findings: result.kind === 'security' ? result.findings.length : 0, panelVotes: panelVoteCounts(result), at: new Date(at),
  });
}
const panelOf = (h: ReturnType<typeof history>, over: Partial<AnalyticsFilter> = {}) =>
  computeAnalytics(readHistory(h.log.dir, null).entries, h.pricing.current(), filter(over), NOW).subagent_evaluation.security_panel;

describe('security panel votes: counting (#554)', () => {
  it('counts the three scenarios: all confirmed, one lens refuting, two lenses refuting', () => {
    const all = panelVoteCounts(security([candidate(ALL_OK)]));
    assert.deepEqual(all, { candidates: 1, confirmed: { reachability: 1, impact: 1, defenses: 1 }, refuted: { reachability: 0, impact: 0, defenses: 0 }, singleRefuted: 0 });
    const one = panelVoteCounts(security([], [candidate(ONE_REFUTES)]));
    assert.deepEqual(one, { candidates: 1, confirmed: { reachability: 1, impact: 0, defenses: 1 }, refuted: { reachability: 0, impact: 1, defenses: 0 }, singleRefuted: 1 });
    const two = panelVoteCounts(security([], [candidate(TWO_REFUTE)]));
    assert.deepEqual(two, { candidates: 1, confirmed: { reachability: 1, impact: 0, defenses: 0 }, refuted: { reachability: 0, impact: 1, defenses: 1 }, singleRefuted: 0 });
  });

  it('a candidate refuted by all three lenses is not "exactly one"', () => {
    assert.equal(panelVoteCounts(security([], [candidate(ALL_REFUTE)]))?.singleRefuted, 0);
  });

  it('counts findings and refuted together, in lens order, and sums to the vote total', () => {
    const counts = panelVoteCounts(security([candidate(ALL_OK), candidate(ONE_REFUTES)], [candidate(ONE_REFUTES), candidate(TWO_REFUTE)]))!;
    assert.equal(counts.candidates, 4);
    assert.equal(counts.singleRefuted, 2);
    assert.deepEqual(Object.keys(counts.confirmed), [...PANEL_LENSES]);
    assert.deepEqual(Object.keys(counts.refuted), [...PANEL_LENSES]);
    const total = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
    assert.equal(total(counts.confirmed) + total(counts.refuted), 12);
  });

  it('is null without votes, for other kinds and for empty lists', () => {
    assert.equal(panelVoteCounts(security([])), null);
    assert.equal(panelVoteCounts(security([{ severity: 'major', problem: 'p' }])), null);
    assert.equal(panelVoteCounts(security([candidate(ALL_OK)], [], 'review')), null);
    assert.equal(panelVoteCounts(security([candidate(ALL_OK)], [], 'implementation')), null);
  });

  it('the rule itself is unchanged: PANEL_MAX_REFUTING_VOTES stays 0', () => {
    assert.equal(PANEL_MAX_REFUTING_VOTES, 0);
  });
});

describe('security panel votes: the stage_result line (#554)', () => {
  it('writes flat logfmt fields, no nested object', () => {
    const h = history();
    write(h, 'acme/app', '2026-10-03T10:00:00Z', security([candidate(ALL_OK)], [candidate(TWO_REFUTE)]));
    const files = fs.readdirSync(h.log.dir, { recursive: true, withFileTypes: true }).filter((f) => f.isFile());
    const text = files.map((f) => fs.readFileSync(path.join(f.parentPath, f.name), 'utf8')).join('\n');
    assert.match(text, /panel_candidates=2/);
    const [entry] = readHistory(h.log.dir, 'acme/app').entries;
    assert.equal(entry?.event, 'stage_result');
    assert.equal(entry?.fields.panel_candidates, '2');
    assert.equal(entry?.fields.panel_single_refuted, '0');
    assert.match(entry?.fields.panel_confirmed ?? '', /reachability:2/);
    assert.match(entry?.fields.panel_refuted ?? '', /impact:1/);
    assert.equal(/panel_\w+=\{/.test(text), false);
  });

  it('a line without votes is byte-identical to a line from a log that never knew the field', () => {
    const h = history();
    const base = { repo: 'acme/app', issue: 'acme/app#1', run: 'r1', role: 'security-auditor', kind: 'security', verdict: 'passed', round: null, target: null, profile: 'feature', complexity: 'M', findings: 0, at: new Date('2026-10-03T10:00:00Z') };
    h.log.stageResult(base);
    h.log.stageResult({ ...base, panelVotes: panelVoteCounts(security([])) });
    h.log.stageResult({ ...base, kind: 'review', panelVotes: panelVoteCounts(security([candidate(ALL_OK)], [], 'review')) });
    const entries = readHistory(h.log.dir, 'acme/app').entries;
    assert.equal(entries.length, 3);
    for (const e of entries) assert.equal(Object.keys(e.fields).some((k) => k.includes('panel')), false);
    assert.deepEqual(entries[0]!.fields, entries[1]!.fields);
  });
});

describe('security panel votes: the statistics (#554)', () => {
  function seed() {
    const h = history();
    write(h, 'acme/app', '2026-10-03T10:00:00Z', security([candidate(ALL_OK)]), '#1');
    write(h, 'acme/app', '2026-10-03T11:00:00Z', security([], [candidate(ONE_REFUTES)]), '#2');
    write(h, 'acme/app', '2026-10-03T12:00:00Z', security([], [candidate(TWO_REFUTE)]), '#3');
    write(h, 'acme/app', '2026-10-03T13:00:00Z', security([]), '#4'); // no votes
    write(h, 'acme/app', '2026-09-01T10:00:00Z', security([], [candidate(ONE_REFUTES), candidate(ONE_REFUTES)]), '#5'); // outside the later period
    write(h, 'other/repo', '2026-10-03T14:00:00Z', security([], [candidate(ALL_REFUTE)]), '#6');
    return h;
  }

  it('sums candidates, refutes per lens and single-lens refutes for the period and repository', () => {
    const h = seed();
    const p = panelOf(h, { repo: 'acme/app', from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-06T00:00:00Z') });
    assert.equal(p.results, 3);
    assert.equal(p.candidates, 3);
    assert.equal(p.refuted_by_one_lens, 1);
    assert.deepEqual(p.lenses, [
      { lens: 'reachability', confirmed: 3, refuted: 0 },
      { lens: 'impact', confirmed: 1, refuted: 2 },
      { lens: 'defenses', confirmed: 2, refuted: 1 },
    ]);
  });

  it('respects the period: an earlier line is only counted when the period includes it', () => {
    const h = seed();
    const wide = panelOf(h, { repo: 'acme/app', from: new Date('2026-08-01T00:00:00Z'), to: new Date('2026-10-06T00:00:00Z') });
    assert.deepEqual([wide.results, wide.candidates, wide.refuted_by_one_lens], [4, 5, 3]);
  });

  it('respects the repository filter and covers all repositories without one', () => {
    const h = seed();
    const period = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-06T00:00:00Z') };
    const other = panelOf(h, { ...period, repo: 'other/repo' });
    assert.deepEqual([other.results, other.candidates, other.refuted_by_one_lens], [1, 1, 0]);
    assert.deepEqual(other.lenses.map((l) => l.refuted), [1, 1, 1]);
    const all = panelOf(h, period);
    assert.deepEqual([all.results, all.candidates, all.refuted_by_one_lens], [4, 4, 1]);
  });

  it('an empty period and an empty history give empty values, no error', () => {
    const h = seed();
    const empty = panelOf(h, { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-01-02T00:00:00Z') });
    assert.deepEqual([empty.results, empty.candidates, empty.refuted_by_one_lens, empty.lenses], [0, null, null, []]);
    const none = history();
    fs.mkdirSync(none.log.dir, { recursive: true });
    const p = computeAnalytics([], none.pricing.current(), filter(), NOW).subagent_evaluation.security_panel;
    assert.deepEqual([p.results, p.candidates, p.refuted_by_one_lens, p.lenses], [0, null, null, []]);
  });

  it('old lines without the fields give empty values; other stage_result lines are not counted', () => {
    const h = history();
    write(h, 'acme/app', '2026-10-03T10:00:00Z', security([]));
    write(h, 'acme/app', '2026-10-03T11:00:00Z', security([candidate(ALL_OK)], [], 'review'));
    const p = panelOf(h);
    assert.deepEqual([p.results, p.candidates, p.refuted_by_one_lens, p.lenses], [0, null, null, []]);
  });

  it('ignores broken fields instead of failing', () => {
    const h = history();
    const raw = (fields: Record<string, string>) => ({ ts: '2026-10-03T10:00:00.000Z', event: 'stage_result', repo: 'acme/app', fields: { repo: 'acme/app', issue: 'acme/app#9', kind: 'security', ...fields } }) as unknown as ReturnType<typeof readHistory>['entries'][number];
    const entries = [
      raw({ panel_candidates: 'abc' }),
      raw({ panel_candidates: '-3' }),
      raw({ panel_candidates: '1.5' }),
      raw({ panel_candidates: '', panel_confirmed: 'impact:2' }),
      raw({ panel_confirmed: 'reachability:2' }), // lens data without the candidate count
      raw({ panel_candidates: '2', panel_confirmed: 'garbage,impact:x,,:3,reachability:2', panel_refuted: 'defenses:1,unknown:7', panel_single_refuted: 'nope' }),
    ];
    const p = computeAnalytics(entries, h.pricing.current(), filter(), NOW).subagent_evaluation.security_panel;
    assert.equal(p.results, 1);
    assert.equal(p.candidates, 2);
    assert.equal(p.refuted_by_one_lens, 0);
    assert.deepEqual(p.lenses, [{ lens: 'reachability', confirmed: 2, refuted: 0 }, { lens: 'impact', confirmed: 0, refuted: 0 }, { lens: 'defenses', confirmed: 0, refuted: 1 }]);
  });

  it('the note explains the figures and the JSON stays serialisable', () => {
    const p = panelOf(seed());
    assert.match(p.note, /PANEL_MAX_REFUTING_VOTES = 1/);
    assert.match(p.note, /Lens/);
    assert.deepEqual(JSON.parse(JSON.stringify(p)), p);
  });
});

describe('security panel votes: the statistics page (#554)', () => {
  const developer = { ...analyticsFixture().by_role[0], role: 'developer' };
  async function load(panel: unknown) {
    const base = analyticsFixture({ by_role: [developer] }) as { subagent_evaluation: Record<string, unknown> };
    const data = { ...base, subagent_evaluation: { ...base.subagent_evaluation, ...(panel === undefined ? {} : { security_panel: panel }) } };
    const page = renderPage(LOGS_HTML, undefined, { url: 'http://127.0.0.1/stats', fetch: (u: string) => (u.startsWith('/api/v1/history/entries') ? entriesFixture() : data) });
    await until(() => page.$('log-count').textContent === '1' && page.query('[data-body="kpi"] .ui-kpi').length > 0, 3000, 'the page to load');
    return page;
  }

  it('shows the figures and one row per lens', async () => {
    const page = await load({
      note: 'Erklärung PANEL_MAX_REFUTING_VOTES = 1', results: 3, candidates: 7, refuted_by_one_lens: 2,
      lenses: [{ lens: 'reachability', confirmed: 5, refuted: 1 }, { lens: 'impact', confirmed: 4, refuted: 3 }, { lens: 'defenses', confirmed: 6, refuted: 0 }],
    });
    const text = page.query('[data-body="security-panel"]').map((n) => n.textContent).join(' ');
    assert.match(text, /7/);
    assert.match(text, /Erklärung PANEL_MAX_REFUTING_VOTES = 1/);
    const cells = page.query('#security-panel-table td').map((td) => td.textContent);
    assert.deepEqual(cells, ['reachability', '5', '1', 'impact', '4', '3', 'defenses', '6', '0']);
  });

  it('shows nothing for an empty section and does not break on an old answer without the section', async () => {
    const empty = await load({ note: 'n', results: 0, candidates: null, refuted_by_one_lens: null, lenses: [] });
    assert.equal(empty.query('#security-panel-table td').length, 0);
    const old = await load(undefined);
    assert.equal(old.query('#security-panel-table td').length, 0);
    assert.ok(old.query('[data-body="kpi"] .ui-kpi').length > 0);
  });
});
