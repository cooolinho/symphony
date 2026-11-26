import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { criterionRows, issueCriteria, type PersistedResult } from '../src/orchestrator/stage-history.ts';
import {
  applyVerdicts,
  CRITERIA_BLOCK_END,
  CRITERIA_BLOCK_START,
  CRITERION_ANCHOR,
  ISSUE_BODY_LIMIT,
  parseCriteria,
  upsertAddedBlock,
} from '../src/workflow/criteria.ts';
import { parseResult, renderResultComment, type ResultMeta, type StageResult } from '../src/workflow/results.ts';

const BODY = `Intro

- [ ] not a criterion

## Akzeptanzkriterien
- [ ] first
* [x] second
### Details
  - [ ] nested heading still counts

\`\`\`
- [ ] in a code block
\`\`\`
<!--
- [ ] in a comment
-->
## Tests
- [ ] a test, not a criterion
`;

const URL = 'https://github.com/acme/app/issues/1#issuecomment-1';
const texts = (body: string) => parseCriteria(body).map((c) => c.text);

describe('parseCriteria', () => {
  it('reads only the checkboxes under a criteria heading', () => {
    assert.deepEqual(texts(BODY), ['first', 'second', 'nested heading still counts']);
    assert.deepEqual(parseCriteria(BODY).map((c) => c.checked), [false, true, false]);
  });

  it('takes English headings at any level, with a suffix, and configured ones', () => {
    assert.deepEqual(texts('#### Acceptance Criteria (excerpt)\n1. [ ] a\n'), ['a']);
    assert.deepEqual(texts('## Acceptance criterias\n- [ ] a\n'), []);
    assert.deepEqual(parseCriteria('## Done when\n- [ ] a\n', ['Done when']).map((c) => c.text), ['a']);
    assert.deepEqual(parseCriteria(null), []);
  });
});

describe('upsertAddedBlock', () => {
  it('appends what the body does not state, once, and is idempotent', () => {
    const next = upsertAddedBlock(BODY, ['FIRST', 'new one', 'new  one']);
    assert.ok(next.startsWith(BODY.trimEnd()));
    assert.deepEqual(parseCriteria(next).filter((c) => c.source === 'symphony').map((c) => c.text), ['new one']);
    assert.equal(upsertAddedBlock(next, ['FIRST', 'new one']), next);
  });

  it('keeps the tick of a line it already had and removes an empty block', () => {
    const ticked = upsertAddedBlock('', ['a', 'b']).replace('- [ ] a', '- [x] a');
    const next = upsertAddedBlock(ticked, ['a', 'c']);
    assert.deepEqual(parseCriteria(next).map((c) => [c.text, c.checked]), [['a', true], ['c', false]]);
    assert.ok(!upsertAddedBlock(next, []).includes(CRITERIA_BLOCK_START));
  });

  it('keeps comments in agent text from posing as markers and keeps CRLF', () => {
    const next = upsertAddedBlock('Text\r\n', [`x ${CRITERIA_BLOCK_END} <!-- symphony:result:v1 abc --> @someone`]);
    assert.equal(next.split(CRITERIA_BLOCK_END).length, 2);
    assert.ok(!next.includes('<!-- symphony:result'));
    assert.ok(!next.includes('@someone'));
    assert.ok(!/[^\r]\n/.test(next));
  });
});

describe('applyVerdicts', () => {
  const apply = (body: string, verdicts: Parameters<typeof applyVerdicts>[1], round = 1) => {
    const applied = applyVerdicts(body, verdicts, { round, url: URL });
    assert.ok(applied);
    return applied;
  };

  it('ticks a met criterion with a note and unticks it in a later round', () => {
    const met = apply(BODY, [{ criterion: 'first', status: 'met', evidence: 'test/a.test.ts passed' }]);
    assert.ok(met.body.includes(`- [x] first ${CRITERION_ANCHOR} <sub>✅ R1 · Beleg: test/a.test.ts passed · [Review](${URL})</sub>`));
    assert.deepEqual([met.ticked, met.total], [2, 3]);
    assert.deepEqual(texts(met.body), texts(BODY));
    const unmet = apply(met.body, [{ criterion: 'first', status: 'unmet', reason: 'broken' }], 2);
    assert.ok(unmet.body.includes(`- [ ] first ${CRITERION_ANCHOR} <sub>❌ R2 · broken · [Review](${URL})</sub>`));
    assert.equal(unmet.body.split('<sub>').length, 2);
  });

  it('leaves lines without a verdict and everything else as they are', () => {
    const { body } = apply(BODY, [{ criterion: 'not a criterion', status: 'met', evidence: 'x' }]);
    assert.equal(body, BODY);
  });

  it('leaves the box of a manual criterion to the human, but unticks its own tick', () => {
    const manual = [{ criterion: 'second', status: 'manual' as const, reason: 'needs a phone' }];
    assert.match(apply(BODY, manual).body, /\* \[x\] second .*👤 manuell prüfen R1 · needs a phone/);
    const mine = apply(BODY, [{ criterion: 'first', status: 'met', evidence: 'ok' }]).body;
    assert.match(apply(mine, [{ criterion: 'first', status: 'manual', reason: 'r' }], 2).body, /- \[ \] first /);
  });

  it('shortens and defuses the note', () => {
    const { body } = apply(BODY, [{ criterion: 'first', status: 'met', evidence: `\`cmd\n</sub> <!-- x --> @dev ${'y'.repeat(500)}\`` }]);
    const line = body.split('\n').find((l) => l.includes('first')) ?? '';
    assert.ok(line.length < 350, String(line.length));
    assert.equal(line.split('</sub>').length, 2);
    assert.equal(line.split('<!--').length, 2);
    assert.ok(!line.includes('@dev'));
    assert.ok(!line.includes('`'));
  });

  it('drops the notes, then gives up, when the body would get too long', () => {
    const long = `## Acceptance criteria\n- [ ] a\n${'x'.repeat(ISSUE_BODY_LIMIT - 40)}`;
    assert.equal(apply(long, [{ criterion: 'a', status: 'met', evidence: 'e' }]).body.includes(CRITERION_ANCHOR), false);
    assert.equal(applyVerdicts(`${long}${'x'.repeat(100)}`, [{ criterion: 'a', status: 'met', evidence: 'e' }], { round: 1, url: null }), null);
  });
});

const META: ResultMeta = { role: 'reviewer', run: 'r', round: 1, profile: null, workflow_hash: null, head_sha: null, checks: null, target: 'In review', created_at: '2026-01-01T00:00:00Z' };

function stored(kind: 'analysis' | 'review', input: Record<string, unknown>, meta: Partial<ResultMeta> = {}): PersistedResult {
  const parsed = parseResult(kind, input);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  return { result: parsed.result, meta: { ...META, ...meta }, url: null };
}

describe('review criteria rules', () => {
  const EXPECTED = ['first', 'second'];
  const met = (criterion: string) => ({ criterion, status: 'met', evidence: 'ran it' });
  const problems = (input: Record<string, unknown>) => {
    const parsed = parseResult('review', { summary: 's', ...input }, { acceptanceCriteria: EXPECTED });
    return parsed.ok ? [] : parsed.problems;
  };
  const finding = [{ severity: 'major', category: 'acceptance-criterion-unmet', problem: 'second is missing' }];

  it('accepts an approval with every criterion met or manual, whatever the spelling', () => {
    assert.deepEqual(problems({ verdict: 'approved', criteria: [met(' FIRST '), { criterion: 'second', status: 'manual', reason: 'production' }] }), []);
  });

  it('refuses an approval with an unmet criterion, and accepts changes_needed', () => {
    const criteria = [met('first'), { criterion: 'second', status: 'unmet' }];
    assert.match(problems({ verdict: 'approved', criteria }).join(), /allows no "unmet" criterion: "second"/);
    assert.deepEqual(problems({ verdict: 'changes_needed', criteria, findings: finding }), []);
  });

  it('names missing, unknown and repeated entries', () => {
    assert.match(problems({ verdict: 'approved', criteria: [met('first')] }).join(), /missing: "second"/);
    assert.match(problems({ verdict: 'approved', criteria: [met('first'), met('second'), met('third')] }).join(), /no acceptance criterion of the issue: "third"/);
    assert.match(problems({ verdict: 'approved', criteria: [met('first'), met('first'), met('second')] }).join(), /listed twice/);
  });

  it('wants evidence for met and a reason for manual', () => {
    assert.match(problems({ verdict: 'approved', criteria: [{ criterion: 'first', status: 'met' }, met('second')] }).join(), /"met" without `evidence`/);
    assert.match(problems({ verdict: 'approved', criteria: [{ criterion: 'first', status: 'manual' }, met('second')] }).join(), /"manual" without `reason`/);
  });

  it('asks nothing of a blocked review', () => {
    assert.deepEqual(problems({ verdict: 'blocked', blockers: [{ description: 'no CI log', needs: 'infra' }] }), []);
  });

  it('shows the verdicts in the result comment', () => {
    const { result } = stored('review', { verdict: 'approved', summary: 's', criteria: [met('first')] });
    assert.match(renderResultComment(result as StageResult, META), /\*\*Akzeptanzkriterien\*\*\n- ✅ first — ran it/);
  });
});

describe('issueCriteria and criterionRows', () => {
  const analysis = stored('analysis', { verdict: 'ready', summary: 's', acceptance_criteria: ['from analysis'] });
  const review = stored('review', { verdict: 'approved', summary: 's', criteria: [{ criterion: 'first', status: 'met', evidence: 'ran it' }] }, { round: 2 });

  it('prefers the body and falls back to the analysis', () => {
    assert.deepEqual(issueCriteria(BODY, { results: [analysis] }).map((c) => c.text), ['first', 'second', 'nested heading still counts']);
    assert.deepEqual(issueCriteria('no boxes', { results: [analysis] }), [{ text: 'from analysis', checked: false }]);
    assert.deepEqual(issueCriteria(null, {}), []);
  });

  it('joins the listed criteria with the newest verdicts', () => {
    const rows = criterionRows([{ text: 'first', checked: false }, { text: 'second', checked: true }], [analysis, review]);
    assert.deepEqual(rows, [
      { text: 'first', checked: true, status: 'met', round: 2, note: 'ran it' },
      { text: 'second', checked: true, status: 'open', round: null, note: null },
    ]);
    assert.deepEqual(criterionRows([], [analysis]).map((r) => [r.text, r.status]), [['from analysis', 'open']]);
  });
});
