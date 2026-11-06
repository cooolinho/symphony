import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RESULT_SCHEMA, RESULT_SIZE_LIMIT, decodeMarker, parseResult, renderResultComment, verificationCounts, type ResultMeta, type StageResult } from '../src/workflow/results.ts';

const meta: ResultMeta = {
  role: 'reviewer', run: 'r', round: 1, profile: null, workflow_hash: null, head_sha: null, checks: null, target: 'In review', created_at: '2026-10-18T10:00:05.000Z',
};
const conf = { status: 'confirmed', evidence: 'src/a.ts:3 shows it' };
const refu = { status: 'refuted', evidence: 'src/b.ts:1 is guarded' };
const f = (over: Record<string, unknown> = {}) => ({ severity: 'major', file: 'src/a.ts', line: 3, problem: 'Off by one', ...over });

function parsed(kind: 'review' | 'security', input: Record<string, unknown>, context = {}): StageResult {
  const outcome = parseResult(kind, input, context);
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.message);
  return outcome.result;
}

describe('verified findings (E3-4): contract, counts, rendering', () => {
  it('parses verification on findings and refuted[] for review and security; refuted defaults to empty', () => {
    const review = parsed('review', { verdict: 'changes_needed', summary: 's', findings: [f({ verification: conf })], refuted: [f({ verification: refu })] });
    assert.ok(review.kind === 'review');
    assert.deepEqual(review.findings[0]?.verification, conf);
    assert.equal(review.refuted.length, 1);
    const security = parsed('security', { verdict: 'issues_found', summary: 's', findings: [f({ verification: conf })], refuted: [f({ verification: refu })] });
    assert.ok(security.kind === 'security');
    assert.equal(security.refuted.length, 1);
    const plain = parsed('review', { verdict: 'approved', summary: 's' });
    assert.ok(plain.kind === 'review');
    assert.deepEqual(plain.refuted, []);
  });

  it('verifiedFindings context refuses missing and refuted verification, an absent context does not', () => {
    const input = { verdict: 'changes_needed', summary: 's', findings: [f(), f({ verification: refu })] };
    const refused = parseResult('review', input, { verifiedFindings: true });
    assert.ok(!refused.ok);
    assert.match(refused.message, /findings\[0\]/);
    assert.match(refused.message, /findings\[1\]/);
    assert.ok(parseResult('review', { ...input, findings: [f()] }).ok);
    assert.ok(parseResult('review', { ...input, findings: [f()] }, { verifiedFindings: false }).ok);
    assert.ok(parseResult('review', { ...input, findings: [f({ verification: conf })] }, { verifiedFindings: true }).ok);
  });

  it('counts confirmed and refuted candidates (refuted[] plus findings with status refuted)', () => {
    const result = parsed('review', { verdict: 'changes_needed', summary: 's', findings: [f({ verification: conf }), f({ verification: conf })], refuted: [f({ verification: refu }), f({ verification: refu }), f({ verification: refu })] });
    assert.deepEqual(verificationCounts(result, true), { confirmed: 2, refuted: 3 });
    assert.deepEqual(verificationCounts(result, false), { confirmed: 2, refuted: 3 });
  });

  it('counts 0 confirmed and N refuted for a clean L/XL review', () => {
    const result = parsed('review', { verdict: 'approved', summary: 's', refuted: [f({ verification: refu })] }, { verifiedFindings: true });
    assert.deepEqual(verificationCounts(result, true), { confirmed: 0, refuted: 1 });
  });

  it('counts nothing for other kinds', () => {
    const impl = parseResult('implementation', { verdict: 'done', summary: 's' });
    assert.ok(impl.ok);
    assert.equal(verificationCounts(impl.result, true), null);
  });

  it('renders confirmed findings and omits refuted candidates, in the comment and in nothing but the marker', () => {
    const result = parsed('review', { verdict: 'changes_needed', summary: 's', findings: [f({ problem: 'REAL-ONE', verification: conf })], refuted: [f({ problem: 'FALSE-ALARM', verification: refu })] });
    const comment = renderResultComment(result, meta);
    const visible = comment.replace(/<!--[\s\S]*?-->/g, '');
    assert.match(visible, /REAL-ONE/);
    assert.doesNotMatch(visible, /FALSE-ALARM/);
    const back = decodeMarker(comment);
    assert.ok(back?.result.kind === 'review');
    assert.equal(back.result.refuted.length, 1);
    assert.equal(back.result.findings.length, 1);
  });

  it('decodes an old stored marker without verification or refuted', () => {
    const old = { schema: RESULT_SCHEMA, kind: 'review', verdict: 'approved', summary: 's', blockers: [], follow_ups: [], findings: [{ severity: 'nit', problem: 'x' }], checked: [], confirmed_goals: [], meta };
    const marker = `<!-- symphony:result:v1 ${Buffer.from(JSON.stringify(old)).toString('base64url')} -->`;
    const back = decodeMarker(marker);
    assert.ok(back?.result.kind === 'review');
    assert.equal(back.result.findings.length, 1);
    assert.deepEqual(back.result.refuted, []);
  });

  it('keeps the comment below the size limit with many large refuted candidates, and still shows the confirmed findings', () => {
    const big = 'x'.repeat(900);
    const refuted = Array.from({ length: 70 }, (_, i) => f({ problem: `refuted ${i} ${big}`, fix: big, verification: { status: 'refuted', evidence: big } }));
    const result = parsed('review', { verdict: 'changes_needed', summary: 's', findings: [f({ problem: 'KEEP-ME', verification: conf })], refuted });
    const comment = renderResultComment(result, meta);
    assert.ok(comment.length < RESULT_SIZE_LIMIT, `${comment.length}`);
    assert.match(comment, /KEEP-ME/);
    assert.ok(decodeMarker(comment) !== null);
  });

  it('keeps the comment below the size limit with many large findings that carry verification', () => {
    const big = 'y'.repeat(900);
    const findings = Array.from({ length: 80 }, (_, i) => f({ problem: `p${i} ${big}`, fix: big, verification: { status: 'confirmed', evidence: big } }));
    const result = parsed('security', { verdict: 'issues_found', summary: 's', findings });
    const comment = renderResultComment(result, meta);
    assert.ok(comment.length < RESULT_SIZE_LIMIT, `${comment.length}`);
    const back = decodeMarker(comment);
    assert.ok(back?.result.kind === 'security');
    assert.ok(back.result.findings.length < 80);
    assert.ok((back.result.omitted_findings ?? 0) > 0);
  });
});
