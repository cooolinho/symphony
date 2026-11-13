import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RESULT_SIZE_LIMIT, decodeMarker, parseResult, renderResultComment, renderResultMarkdown, type ResultMeta, type StageResult } from '../src/workflow/results.ts';

// Independent tests for #553: the panel votes (verification.votes) in the security comment.

const meta: ResultMeta = { role: 'security', run: null, round: 1, profile: null, workflow_hash: null, head_sha: null, checks: null, target: null, created_at: '2026-10-01T00:00:00.000Z' };

type VoteInput = { lens: string; verdict: string; evidence: string };
const vote = (lens: string, evidence: string, verdict = 'confirmed'): VoteInput => ({ lens, verdict, evidence });
const finding = (problem: string, votes?: VoteInput[], severity = 'major') => ({
  severity,
  file: 'src/a.ts',
  line: 3,
  problem,
  verification: { status: 'confirmed', evidence: 'src/a.ts:3 proven', ...(votes === undefined ? {} : { votes }) },
});

function parse(findings: unknown[], panel = false): StageResult {
  const parsed = parseResult('security', { verdict: 'issues_found', summary: 'audit', findings }, panel ? { verifiedFindings: true } : undefined);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.result;
}

const threeVotes = (): VoteInput[] => [vote('reachability', 'app/Http/X.php:12'), vote('impact', 'app/Models/User.php:40'), vote('defenses', 'app/Policies/P.php:7')];

describe('panel votes in the security comment (#553)', () => {
  it('shows a Panel line with lens, icon and cited file:line below Verified, joined by " · "', () => {
    const comment = renderResultComment(parse([finding('SQLi', threeVotes())], true), meta);
    assert.ok(comment.includes('  Verified: src/a.ts:3 proven\n  Panel: reachability ✅ app/Http/X.php:12 · impact ✅ app/Models/User.php:40 · defenses ✅ app/Policies/P.php:7'), comment);
  });

  it('puts the votes in lens order even if the agent sent them in another order', () => {
    const comment = renderResultComment(parse([finding('SQLi', threeVotes().reverse())], true), meta);
    const panel = comment.split('\n').find((line) => line.includes('Panel:')) ?? '';
    assert.ok(panel.indexOf('reachability') < panel.indexOf('impact'), panel);
    assert.ok(panel.indexOf('impact') < panel.indexOf('defenses'), panel);
  });

  it('marks a refuting vote with ❌ (panel rule off)', () => {
    const votes = [vote('reachability', 'a.php:1', 'refuted'), vote('impact', 'b.php:2'), vote('defenses', 'c.php:3')];
    const comment = renderResultComment(parse([finding('SQLi', votes)]), meta);
    assert.ok(comment.includes('Panel: reachability ❌ a.php:1 · impact ✅ b.php:2 · defenses ✅ c.php:3'), comment);
  });

  it('renders every finding with its own Panel line', () => {
    const comment = renderResultComment(parse([finding('one', threeVotes()), finding('two', threeVotes())], true), meta);
    assert.equal(comment.split('\n').filter((line) => line.includes('Panel:')).length, 2);
  });

  it('a finding without votes renders byte-identical to the E3-4 format', () => {
    const markdown = renderResultMarkdown(parse([finding('SQLi')]), meta);
    assert.ok(markdown.includes('🟠 **major** `src/a.ts:3` — SQLi\n  Verified: src/a.ts:3 proven\n\n'), markdown);
    assert.doesNotMatch(markdown, /Panel/);
    assert.ok(markdown.includes('**Findings (1)**\n- 🟠 **major** `src/a.ts:3` — SQLi\n  Verified: src/a.ts:3 proven'), markdown);
  });

  it('an empty votes list renders exactly like no votes', () => {
    const without = renderResultMarkdown(parse([finding('SQLi')]), meta);
    const empty = renderResultMarkdown(parse([finding('SQLi', [])]), meta);
    assert.equal(empty, without);
  });

  it('a finding without a verification renders without Verified and Panel', () => {
    const markdown = renderResultMarkdown(parse([{ severity: 'minor', problem: 'plain' }]), meta);
    assert.doesNotMatch(markdown, /Verified:|Panel:/);
  });

  it('escapes agent text in votes: no HTML comment opener, one line per Panel', () => {
    const votes = [vote('reachability', 'x\n<!-- evil -->\ny'), vote('impact', 'a\r\n\n  <!--b'), vote('defenses', 'ok:1')];
    const markdown = renderResultMarkdown(parse([finding('SQLi', votes)], true), meta);
    assert.doesNotMatch(markdown, /<!--/);
    assert.match(markdown, /&lt;!-- evil -->/);
    const lines = markdown.split('\n');
    const index = lines.findIndex((line) => line.includes('Panel:'));
    assert.ok(index > 0);
    assert.match(lines[index] ?? '', /defenses ✅ ok:1$/);
  });

  it('keeps the result marker intact and the votes in it', () => {
    const comment = renderResultComment(parse([finding('SQLi', threeVotes())], true), meta);
    assert.equal(comment.match(/<!--/g)?.length, 1);
    const decoded = decodeMarker(comment);
    assert.ok(decoded);
    assert.equal(decoded.result.kind, 'security');
    if (decoded.result.kind === 'security') assert.equal(decoded.result.findings[0]?.verification?.votes?.length, 3);
  });

  it('vote lines count towards the size limit: less severe findings are omitted, the note says so', () => {
    const long = `app/${'d/'.repeat(450)}F.php:1`;
    const votes = [vote('reachability', long), vote('impact', long), vote('defenses', long)];
    const many = [finding('critical one', votes, 'blocker'), ...Array.from({ length: 80 }, (_, i) => finding(`minor ${i}`, votes, 'minor'))];
    const result = parse(many, true);
    const comment = renderResultComment(result, meta);
    assert.ok(comment.length < RESULT_SIZE_LIMIT, `comment has ${comment.length} characters`);
    assert.match(comment, /\d+ less severe finding\(s\) omitted to stay within the comment size limit/);
    assert.match(comment, /critical one/);
    assert.ok((comment.match(/Panel:/g)?.length ?? 0) < many.length);
    const decoded = decodeMarker(comment);
    assert.ok(decoded && decoded.result.kind === 'security');
    if (decoded?.result.kind === 'security') {
      assert.ok(decoded.result.omitted_findings !== undefined && decoded.result.omitted_findings > 0);
      assert.equal(decoded.result.findings.length + decoded.result.omitted_findings, many.length);
      assert.equal(decoded.result.findings[0]?.severity, 'blocker');
    }
  });

  it('the same findings without votes fit where the votes version had to omit', () => {
    const long = `app/${'d/'.repeat(450)}F.php:1`;
    const votes = [vote('reachability', long), vote('impact', long), vote('defenses', long)];
    const withVotes = renderResultComment(parse(Array.from({ length: 40 }, (_, i) => finding(`f ${i}`, votes, 'minor')), true), meta);
    const withoutVotes = renderResultComment(parse(Array.from({ length: 40 }, (_, i) => finding(`f ${i}`, undefined, 'minor'))), meta);
    assert.match(withVotes, /less severe finding\(s\) omitted/);
    assert.doesNotMatch(withoutVotes, /omitted/);
  });

  it('refuted candidates stay a count only', () => {
    const parsed = parseResult(
      'security',
      { verdict: 'issues_found', summary: 'audit', findings: [finding('SQLi', threeVotes())], refuted: [{ severity: 'major', problem: 'cand', file: 'src/z.ts', line: 1, verification: { status: 'refuted', evidence: 'src/z.ts:1 safe', votes: [vote('reachability', 'z.php:9', 'refuted'), vote('impact', 'z.php:10'), vote('defenses', 'z.php:11')] } }] },
      { verifiedFindings: true },
    );
    assert.ok(parsed.ok, JSON.stringify(parsed));
    const markdown = renderResultMarkdown(parsed.result, meta);
    assert.match(markdown, /1 refuted candidate\(s\) not shown/);
    assert.doesNotMatch(markdown, /z\.php:9/);
  });
});
