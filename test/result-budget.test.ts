import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { commandSkills } from '../src/workflow/command.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import {
  RESULT_FIELD_BUDGET,
  RESULT_SCHEMA,
  RESULT_SIZE_LIMIT,
  SUMMARY_MAX,
  decodeMarker,
  encodeMarker,
  parseResult,
  renderResultComment,
  toolInputShape,
  type AgentResultKind,
  type ResultMeta,
  type StageResult,
} from '../src/workflow/results.ts';
import { compilePrompt, issueTemplateValue, renderPrompt } from '../src/workflow/template.ts';
import { makeIssue } from './helpers.ts';

/**
 * Independent tests for #284: the size budget of `report_result` is named before an agent exceeds it, and the
 * `result_too_large` rejection says how far over the budget the result is and which fields to shorten.
 */

const meta: ResultMeta = {
  role: 'architect',
  run: 'run-1',
  round: 1,
  profile: 'standard',
  workflow_hash: 'f'.repeat(64),
  head_sha: 'a'.repeat(40),
  checks: null,
  target: 'In progress',
  created_at: '2026-10-25T10:00:05.000Z',
};

/** A realistic German sentence with Markdown, quotes and umlauts: the base64 marker costs more than for plain ASCII. */
const GERMAN = 'Die Funktion `fitResult` prüft die Größe und löst bei Überschreitung einen Fehler aus; für Änderungen gilt: "kürzen". ';

function text(length: number, unit = 'abcdefghij '): string {
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

/** `entries` plan steps of the same length, `total` characters of field text in all (the other fields are tiny). */
function planOf(total: number, entries: number, unit?: string): string[] {
  const per = Math.floor(total / entries);
  return Array.from({ length: entries }, (_, i) => `${i} ${text(per, unit)}`.slice(0, per));
}

function designWith(plan: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { verdict: 'ready', summary: 'S', decision: 'D', components: ['c'], interfaces: ['i'], plan, ...extra };
}

function outcome(kind: AgentResultKind, input: Record<string, unknown>) {
  return parseResult(kind, input);
}

function rejection(kind: AgentResultKind, input: Record<string, unknown>): string {
  const result = outcome(kind, input);
  assert.equal(result.ok, false, 'expected the result to be rejected');
  return result.ok ? '' : result.message;
}

function accepted(kind: AgentResultKind, input: Record<string, unknown>): StageResult {
  const result = outcome(kind, input);
  if (!result.ok) assert.fail(result.message);
  return result.result;
}

describe('#284 confirm: the comment holds the field text about 2.3 times', () => {
  it('a design with ~30,000 characters of field text is rejected as too large', () => {
    const message = rejection('design', designWith(planOf(30_000, 15)));
    assert.match(message, /too large for an issue comment/);
  });

  it('measures the ratio of rendered comment to field text, marker included', () => {
    const fieldText = 20_000;
    const result = accepted('design', designWith(planOf(fieldText, 20)));
    const comment = renderResultComment(result, meta);
    const ratio = comment.length / fieldText;
    // Markdown once (1x) + base64url of the JSON in the marker (4/3x) = ~2.33x, plus fixed headings and meta.
    assert.ok(ratio > 2.2 && ratio < 2.6, `ratio ${ratio.toFixed(3)} (comment ${comment.length} characters for ${fieldText})`);
  });

  it('the marker alone is about 4/3 of the field text', () => {
    const result = accepted('design', designWith(planOf(18_000, 18)));
    const marker = encodeMarker(result, meta);
    assert.ok(marker.length > 18_000 * 1.3 && marker.length < 18_000 * 1.45, `marker has ${marker.length} characters`);
  });
});

describe('#284 the field budget', () => {
  it('is a plausible figure derived from the limit: well under half of it, but not trivially small', () => {
    assert.ok(Number.isInteger(RESULT_FIELD_BUDGET));
    assert.ok(RESULT_FIELD_BUDGET > 15_000, `budget ${RESULT_FIELD_BUDGET}`);
    assert.ok(RESULT_FIELD_BUDGET < RESULT_SIZE_LIMIT / 2, `budget ${RESULT_FIELD_BUDGET}`);
  });

  it('the limits themselves are unchanged', () => {
    assert.equal(RESULT_SIZE_LIMIT, 60_000);
    assert.equal(SUMMARY_MAX, 4000);
  });

  it('a result a little under the budget fits, whatever the list layout', () => {
    for (const entries of [6, 50, 200]) {
      const plan = planOf(RESULT_FIELD_BUDGET - 1000, entries);
      const comment = renderResultComment(accepted('design', designWith(plan)), meta);
      assert.ok(comment.length < RESULT_SIZE_LIMIT, `${entries} entries: ${comment.length} characters`);
    }
  });

  it('realistic German prose with umlauts and Markdown fits a little under the budget', () => {
    const plan = planOf(RESULT_FIELD_BUDGET - 1000, 200, GERMAN);
    const comment = renderResultComment(accepted('design', designWith(plan)), meta);
    assert.ok(comment.length < RESULT_SIZE_LIMIT, `${comment.length} characters`);
  });

  it('a result well over the budget does not fit', () => {
    const message = rejection('design', designWith(planOf(RESULT_FIELD_BUDGET + 6000, 20)));
    assert.match(message, /too large/);
  });

  it('what fits can be encoded into a v1 marker and decoded again', () => {
    const result = accepted('design', designWith(planOf(RESULT_FIELD_BUDGET - 1000, 40)));
    const comment = renderResultComment(result, meta);
    const decoded = decodeMarker(comment);
    assert.ok(decoded);
    assert.equal(decoded.result.schema, RESULT_SCHEMA);
    assert.equal(RESULT_SCHEMA, 'symphony.result/v1');
    assert.deepEqual(decoded.result, result);
  });
});

describe('#284 the summary limit stays enforced by the schema', () => {
  it('accepts a summary of exactly SUMMARY_MAX characters and rejects one more', () => {
    accepted('design', designWith(['step'], { summary: 'x'.repeat(SUMMARY_MAX) }));
    const message = rejection('design', designWith(['step'], { summary: 'x'.repeat(SUMMARY_MAX + 1) }));
    assert.match(message, /summary/);
    assert.match(message, new RegExp(String(SUMMARY_MAX)));
  });

  it('the tool schema describes the summary limit', () => {
    const description = toolInputShape('design').summary?.description ?? '';
    assert.ok(description.includes(String(SUMMARY_MAX)), description);
  });
});

describe('#284 the result_too_large message', () => {
  const big = designWith(planOf(20_000, 10), {
    tests: planOf(9000, 9),
    components: ['c'.repeat(100), 'd'.repeat(50)],
    decision: 'D'.repeat(300),
    summary: 'S'.repeat(700),
  });
  const fieldText = 20_000 + 9000 + 150 + 300 + 700 + 'i'.length;

  it('names the budget, the limit, the rendered size and the field text', () => {
    const message = rejection('design', big);
    assert.match(message, new RegExp(`limit ${RESULT_SIZE_LIMIT}`));
    assert.ok(message.includes(String(RESULT_FIELD_BUDGET)), `budget ${RESULT_FIELD_BUDGET} missing in: ${message}`);
    const rendered = /(\d+) characters rendered/.exec(message);
    assert.ok(rendered, message);
    assert.ok(Number(rendered[1]) > RESULT_SIZE_LIMIT, 'the rendered size is over the limit');
    // The current field text: within a few characters of what we put in (list bookkeeping may differ slightly).
    const held = /fields hold (\d+) characters/.exec(message);
    assert.ok(held, message);
    assert.ok(Math.abs(Number(held[1]) - fieldText) < 100, `field text ${held[1]}, expected about ${fieldText}`);
  });

  it('lists the largest fields with their length, largest first, and leaves the small ones out', () => {
    const message = rejection('design', big);
    const plan = message.indexOf('plan (');
    const tests = message.indexOf('tests (');
    assert.ok(plan >= 0 && tests >= 0, message);
    assert.ok(plan < tests, 'plan (20,000) comes before tests (9,000)');
    assert.match(message, /plan \(2\d{4}\)/);
    assert.match(message, /tests \(\d{4}\)/);
    assert.doesNotMatch(message, /interfaces \(/, 'the smallest fields are not listed');
    assert.doesNotMatch(message, /options \(/, 'empty fields are not listed');
    assert.doesNotMatch(message, /\bschema \(|\bkind \(/, 'envelope fields are no fields to shorten');
  });

  it('names the field that is too large when the text is in the summary and the lists alike', () => {
    const message = rejection('design', designWith(['p'.repeat(100)], { summary: 'S'.repeat(SUMMARY_MAX), decision: 'D'.repeat(4000), compatibility: 'C'.repeat(4000), tests: planOf(40_000, 20) }));
    assert.match(message, /tests \(/);
  });

  it('tells the agent what to do: shorten, with the summary limit', () => {
    const message = rejection('design', big);
    assert.match(message, /shorten/i);
    assert.ok(message.includes(`${SUMMARY_MAX} characters`), message);
  });

  it('applies to other kinds as well (test result with long lists)', () => {
    const message = rejection('test', { verdict: 'passed', summary: 'ok', uncovered_criteria: planOf(30_000, 8) });
    assert.match(message, /too large for an issue comment/);
    assert.match(message, /uncovered_criteria \(\d+\)/);
    assert.ok(message.includes(String(RESULT_FIELD_BUDGET)));
  });

  it('counts the entries of structured lists (test cases) towards their field', () => {
    const cases = Array.from({ length: 40 }, (_, i) => ({ criterion: text(900), test: `t${i}`, status: 'passed' }));
    const message = rejection('test', { verdict: 'passed', summary: 'ok', cases, commands: ['npm test'] });
    const sizes = /cases \((\d+)\)/.exec(message);
    assert.ok(sizes, message);
    assert.ok(Number(sizes[1]) >= 36_000, `cases length ${sizes[1]}`);
  });
});

describe('#284 review and security findings are still trimmed instead of rejected', () => {
  const finding = (severity: string, index: number) => ({ severity, file: `src/f-${index}.ts`, line: index + 1, problem: `${text(1800)} ${index}`, fix: text(400) });

  for (const kind of ['review', 'security'] as const) {
    it(`${kind}: keeps the blockers, drops nits first, notes the omission`, () => {
      const findings = [
        ...Array.from({ length: 40 }, (_, i) => finding('nit', i)),
        ...Array.from({ length: 3 }, (_, i) => finding('blocker', 100 + i)),
      ];
      const verdict = kind === 'review' ? 'changes_needed' : 'issues_found';
      const result = accepted(kind, { verdict, summary: 'Many.', findings });
      const comment = renderResultComment(result, meta);
      assert.ok(comment.length < RESULT_SIZE_LIMIT, `${comment.length} characters`);
      const decoded = decodeMarker(comment);
      assert.ok(decoded && (decoded.result.kind === 'review' || decoded.result.kind === 'security'));
      assert.equal(decoded.result.findings.filter((f) => f.severity === 'blocker').length, 3);
      assert.ok(decoded.result.findings.filter((f) => f.severity === 'nit').length < 40, 'nits are dropped first');
      assert.ok((decoded.result.omitted_findings ?? 0) > 0);
    });
  }
});

describe('#284 the shipped role prompts name the budgets', () => {
  const shipped = path.join(import.meta.dirname, '..', 'WORKFLOW.md');
  const issue = makeIssue({
    id: 'PVTI_1',
    identifier: 'acme/app#42',
    title: 'Add invoices',
    description: 'Create an invoice resource.',
    state: 'In progress',
    url: 'https://github.com/acme/app/issues/42',
    labels: ['feature'],
    native_ref: { provider: 'github_project', repository: 'acme/app', number: 42, parent: null, sub_issues: [], base_branch: null },
  });

  async function render(role: string, scope: Record<string, unknown> = {}): Promise<string> {
    const { definition } = await loadWorkflowFile(shipped);
    const template = compilePrompt(definition.promptTemplate, definition.partials);
    assert.equal(template.parseError, null);
    return renderPrompt(template, { issue: issueTemplateValue(issue, commandSkills([])), attempt: null, role, agents: [], ...scope });
  }

  const summaryLine = (prompt: string): string => {
    const line = prompt.split('\n').find((candidate) => candidate.includes('`summary`'));
    assert.ok(line, 'prompt has a `summary` line');
    return line;
  };

  for (const role of ['architect', 'issue-analyst', 'test-engineer']) {
    it(`${role}: the summary line gives the summary limit and the total budget as numbers`, async () => {
      const line = summaryLine(await render(role));
      assert.ok(line.includes(`${SUMMARY_MAX} characters`), line);
      assert.ok(line.includes(`${RESULT_FIELD_BUDGET} characters`), line);
      assert.doesNotMatch(line, /\{\{|\}\}|undefined|NaN/);
    });
  }

  it('the issue analyst also names them when attachments are described', async () => {
    const attachments = [{ path: '.issue-assets/shot.png', error: '', label: 'Screenshot', source: 'description' }];
    const line = summaryLine(await render('issue-analyst', { attachments }));
    assert.ok(line.includes(`${SUMMARY_MAX} characters`) && line.includes(`${RESULT_FIELD_BUDGET} characters`), line);
    assert.match(line, /attachment/);
  });

  it('the numbers come from the constants: no other figure for the budget appears in the roles', async () => {
    for (const role of ['architect', 'issue-analyst', 'test-engineer']) {
      const prompt = await render(role);
      const numbers = [...summaryLine(prompt).matchAll(/\b(\d{4,6})\b/g)].map((match) => Number(match[1]));
      assert.deepEqual(numbers.sort(), [RESULT_FIELD_BUDGET, SUMMARY_MAX].sort(), role);
    }
  });

  it('other roles still render', async () => {
    for (const role of ['developer', 'reviewer', 'security-auditor', 'docs']) {
      const prompt = await render(role);
      assert.ok(prompt.length > 100, role);
      assert.doesNotMatch(prompt, /\{\{|\{%/, role);
    }
  });
});
