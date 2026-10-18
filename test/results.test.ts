import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import type { CheckRecord } from '../src/orchestrator/guard.ts';
import {
  AGENT_RESULT_KINDS,
  RESULT_SCHEMA,
  RESULT_SIZE_LIMIT,
  checkSummary,
  decodeMarker,
  encodeMarker,
  internalResult,
  parseResult,
  renderResultComment,
  renderResultMarkdown,
  toolInputShape,
  type AgentResultKind,
  type ResultMeta,
  type StageResult,
} from '../src/workflow/results.ts';

const check: CheckRecord = {
  target: 'Agent review',
  role: 'developer',
  sha: 'a'.repeat(40),
  exitCode: 0,
  timedOut: false,
  durationMs: 1234,
  ok: true,
  result: 'passed',
  finishedAt: new Date('2026-10-18T10:00:00.000Z'),
};

const meta: ResultMeta = {
  role: 'reviewer',
  run: 'run-1',
  round: 2,
  profile: 'standard',
  workflow_hash: 'f'.repeat(64),
  head_sha: 'a'.repeat(40),
  checks: checkSummary(check),
  target: 'In review',
  created_at: '2026-10-18T10:00:05.000Z',
};

/** A complete, consistent input per agent kind, with every optional field set. */
const fullInputs: Record<AgentResultKind, Record<string, unknown>> = {
  analysis: {
    verdict: 'ready',
    summary: 'Adds result contracts.',
    blockers: [],
    follow_ups: ['Wire the contracts into a tool'],
    type: 'feature',
    complexity: 'M',
    components: ['src/workflow'],
    acceptance_criteria: ['round trip works', 'size cap holds'],
    risks: { security: false, data_migration: false, breaking_change: true },
    docs_needed: true,
    open_questions: ['Which round limit?'],
    plan: ['Write schemas', 'Write tests'],
  },
  design: {
    verdict: 'ready',
    summary: 'One module, zod schemas.',
    options: ['zod schemas', 'JSON schema files'],
    decision: 'zod schemas, already a dependency',
    components: ['schemas.ts: zod schemas per kind', 'markers.ts: encode and decode'],
    interfaces: ['encodeMarker(result, meta): string'],
    migrations: [],
    compatibility: 'New module, nothing changes',
    work_packages: ['schemas', 'markers', 'rendering'],
  },
  implementation: {
    verdict: 'done',
    summary: 'Implemented.',
    changed_files: ['src/workflow/results.ts'],
    tests_added: ['test/results.test.ts'],
    notes: 'Kept fields optional.',
    plan_deviations: ['Added an internal kind helper'],
  },
  test: {
    verdict: 'failed',
    summary: 'One case fails.',
    cases: [
      { criterion: 'round trip', test: 'results.test.ts', status: 'passed' },
      { criterion: 'size cap', test: 'results.test.ts', status: 'failed' },
      { criterion: 'docs', test: 'manual', status: 'skipped' },
    ],
    commands: ['npm run check'],
    uncovered_criteria: ['dashboard'],
  },
  review: {
    verdict: 'changes_needed',
    summary: 'Two findings.',
    findings: [
      { severity: 'major', file: 'src/a.ts', line: 12, problem: 'Off by one', fix: 'Use <=' },
      { severity: 'nit', problem: 'Typo' },
    ],
    checked: ['tests', 'docs'],
  },
  security: {
    verdict: 'issues_found',
    summary: 'Token in logs.',
    findings: [{ severity: 'blocker', file: 'src/log.ts', problem: 'Logs the token', fix: 'Redact it' }],
  },
  docs: { verdict: 'done', summary: 'Documented.', files: ['docs/results.md'] },
};

function parsed(kind: AgentResultKind, input: Record<string, unknown>): StageResult {
  const outcome = parseResult(kind, input);
  if (!outcome.ok) assert.fail(outcome.message);
  return outcome.result;
}

function problemsOf(kind: AgentResultKind, input: Record<string, unknown>): string[] {
  const outcome = parseResult(kind, input);
  assert.equal(outcome.ok, false, `expected ${kind} input to be rejected`);
  return outcome.ok ? [] : outcome.problems;
}

describe('result contracts: validation', () => {
  for (const kind of AGENT_RESULT_KINDS) {
    it(`accepts a complete ${kind} result and adds the envelope`, () => {
      const result = parsed(kind, fullInputs[kind]);
      assert.equal(result.schema, RESULT_SCHEMA);
      assert.equal(result.kind, kind);
      assert.equal(result.verdict, fullInputs[kind].verdict);
    });

    it(`accepts a minimal ${kind} result and defaults the lists`, () => {
      const verdict = { analysis: 'ready', design: 'ready', implementation: 'done', test: 'passed', review: 'approved', security: 'passed', docs: 'not_needed' }[kind];
      // A ready design has to name its decision, components and interfaces (see the consistency rules).
      const required = kind === 'design' ? { decision: 'd', components: ['c'], interfaces: ['i'] } : {};
      const result = parsed(kind, { verdict, summary: 'Short.', ...required });
      assert.deepEqual(result.blockers, []);
      assert.deepEqual(result.follow_ups, []);
    });

    it(`rejects a ${kind} result with an unknown verdict, no summary or an unknown field`, () => {
      const problems = problemsOf(kind, { verdict: 'maybe', summery: 'typo' });
      assert.ok(problems.some((p) => p.startsWith('`verdict`') && p.includes('expected one of')), problems.join('\n'));
      assert.ok(problems.includes('`summary`: required'), problems.join('\n'));
      assert.ok(problems.some((p) => p.includes('unknown field') && p.includes('`summery`')), problems.join('\n'));
    });
  }

  it('limits the summary to 1–4000 characters', () => {
    assert.ok(problemsOf('docs', { verdict: 'done', summary: '   ' }).some((p) => p.startsWith('`summary`')));
    assert.ok(problemsOf('docs', { verdict: 'done', summary: 'x'.repeat(4001) }).some((p) => p.startsWith('`summary`')));
    parsed('docs', { verdict: 'done', summary: 'x'.repeat(4000) });
  });

  it('names the path of nested problems', () => {
    const problems = problemsOf('review', {
      verdict: 'changes_needed',
      summary: 'x',
      findings: [{ severity: 'critical', line: 0, problem: 'p' }],
      blockers: [{ description: 'd', needs: 'money' }],
    });
    assert.ok(problems.some((p) => p.startsWith('`findings[0].severity`')), problems.join('\n'));
    assert.ok(problems.some((p) => p.startsWith('`findings[0].line`')), problems.join('\n'));
    assert.ok(problems.some((p) => p.startsWith('`blockers[0].needs`')), problems.join('\n'));
  });

  it('rejects input that is not an object', () => {
    assert.equal(parseResult('docs', 'done').ok, false);
    assert.equal(parseResult('docs', null).ok, false);
  });

  it('rejects schema, kind and meta fields the agent tries to set', () => {
    const problems = problemsOf('docs', { verdict: 'done', summary: 'x', kind: 'review', schema: 'v9', meta: {} });
    assert.ok(problems.some((p) => p.includes('`kind`') && p.includes('`schema`') && p.includes('`meta`')), problems.join('\n'));
  });
});

describe('result contracts: consistency rules', () => {
  it('approved allows no blocker or major findings', () => {
    const problems = problemsOf('review', { verdict: 'approved', summary: 'x', findings: [{ severity: 'major', problem: 'p' }] });
    assert.match(problems.join('\n'), /"approved" allows no blocker or major findings.*"changes_needed"/);
    parsed('review', { verdict: 'approved', summary: 'x', findings: [{ severity: 'minor', problem: 'p' }, { severity: 'nit', problem: 'q' }] });
  });

  it('changes_needed needs a finding', () => {
    assert.match(problemsOf('review', { verdict: 'changes_needed', summary: 'x' }).join('\n'), /"changes_needed" needs .*`findings`/);
  });

  it('security passed allows no blocker or major findings and issues_found needs one', () => {
    assert.match(
      problemsOf('security', { verdict: 'passed', summary: 'x', findings: [{ severity: 'blocker', problem: 'p' }] }).join('\n'),
      /"passed" allows no blocker or major/,
    );
    assert.match(problemsOf('security', { verdict: 'issues_found', summary: 'x' }).join('\n'), /"issues_found" needs/);
  });

  it('failed needs a failed case, passed allows none', () => {
    const cases = [{ criterion: 'c', test: 't', status: 'passed' }];
    assert.match(problemsOf('test', { verdict: 'failed', summary: 'x', cases }).join('\n'), /"failed" needs .*status "failed"/);
    const failing = [{ criterion: 'c', test: 't', status: 'failed' }];
    assert.match(problemsOf('test', { verdict: 'passed', summary: 'x', cases: failing }).join('\n'), /"passed" contradicts 1 failed/);
  });

  it('needs_info needs open questions', () => {
    assert.match(problemsOf('analysis', { verdict: 'needs_info', summary: 'x' }).join('\n'), /"needs_info" needs .*`open_questions`/);
    parsed('analysis', { verdict: 'needs_info', summary: 'x', open_questions: ['Which column?'] });
  });

  it('a ready design needs a decision, components and interfaces, with a message that names each', () => {
    const message = problemsOf('design', { verdict: 'ready', summary: 'x' }).join('\n');
    assert.match(message, /"ready" needs the chosen option in `decision`/);
    assert.match(message, /"ready" needs at least one entry in `components`/);
    assert.match(message, /"ready" needs at least one entry in `interfaces`/);
    assert.deepEqual(problemsOf('design', { verdict: 'ready', summary: 'x', decision: 'd', components: ['c'] }).map((p) => p.replace(/ \(.*$/, '')), ['verdict "ready" needs at least one entry in `interfaces`']);
    assert.match(problemsOf('design', { verdict: 'ready', summary: 'x', decision: '  ', components: ['c'], interfaces: ['i'] }).join('\n'), /`decision`/);
    parsed('design', { verdict: 'ready', summary: 'x', decision: 'd', components: ['c'], interfaces: ['i'] });
  });

  it('a blocked design needs a blocker, not components or interfaces', () => {
    assert.match(problemsOf('design', { verdict: 'blocked', summary: 'x' }).join('\n'), /"blocked" needs .*`blockers`/);
    parsed('design', { verdict: 'blocked', summary: 'x', blockers: [{ description: 'Which database?', needs: 'human' }] });
  });

  it('blocked needs a blocker', () => {
    assert.match(problemsOf('implementation', { verdict: 'blocked', summary: 'x' }).join('\n'), /"blocked" needs .*`blockers`/);
    parsed('implementation', { verdict: 'blocked', summary: 'x', blockers: [{ description: 'No token', needs: 'access' }] });
  });

  it('returns a message the agent can act on', () => {
    const outcome = parseResult('review', { verdict: 'approved', summary: 'x', findings: [{ severity: 'blocker', problem: 'p' }] });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.message, /^The review result is invalid; fix these and report it again:\n- verdict "approved"/);
  });
});

describe('result contracts: markers', () => {
  for (const kind of AGENT_RESULT_KINDS) {
    it(`round-trips a ${kind} result and its meta without loss`, () => {
      const result = parsed(kind, fullInputs[kind]);
      const decoded = decodeMarker(`Some text\n\n${encodeMarker(result, meta)}\n`);
      assert.deepEqual(decoded, { result, meta });
    });
  }

  it('round-trips the internal kinds', () => {
    for (const result of [internalResult('skipped', 'No docs stage for this issue'), internalResult('reset', 'Reset by /reset')]) {
      assert.equal(result.verdict, result.kind);
      assert.deepEqual(decodeMarker(encodeMarker(result, { ...meta, checks: null, round: null })), {
        result,
        meta: { ...meta, checks: null, round: null },
      });
    }
  });

  it('keeps --> and other HTML in values from breaking the marker', () => {
    const result = parsed('review', {
      verdict: 'changes_needed',
      summary: 'Ends early? --> <!-- symphony:result:v1 AAAA --> ünïcödé 🎻',
      findings: [{ severity: 'minor', problem: '-->', fix: '<!-- -->' }],
    });
    const marker = encodeMarker(result, meta);
    assert.match(marker, /^<!-- symphony:result:v1 [A-Za-z0-9_-]+ -->$/);
    assert.deepEqual(decodeMarker(marker), { result, meta });
    assert.deepEqual(decodeMarker(renderResultComment(result, meta)), { result, meta });
  });

  it('returns null for missing, tampered or invalid markers', () => {
    const marker = encodeMarker(parsed('docs', fullInputs.docs), meta);
    const payload = marker.slice('<!-- symphony:result:v1 '.length, -' -->'.length);
    const wrap = (value: string) => `<!-- symphony:result:v1 ${value} -->`;
    const encode = (value: unknown) => wrap(Buffer.from(JSON.stringify(value)).toString('base64url'));
    assert.equal(decodeMarker('no marker here'), null);
    assert.equal(decodeMarker(wrap(payload.slice(0, payload.length / 2))), null);
    assert.equal(decodeMarker(wrap(`x${payload}`)), null);
    assert.equal(decodeMarker(wrap(Buffer.from('not json').toString('base64url'))), null);
    assert.equal(decodeMarker(encode([1, 2])), null);
    assert.equal(decodeMarker(encode({ ...parsed('docs', fullInputs.docs), schema: 'symphony.result/v2', meta })), null);
    assert.equal(decodeMarker(encode({ ...parsed('docs', fullInputs.docs), verdict: 'approved', meta })), null);
    assert.equal(decodeMarker(encode({ ...parsed('docs', fullInputs.docs), meta: { ...meta, role: 1 } })), null);
    assert.equal(decodeMarker(encode({ ...parsed('docs', fullInputs.docs) })), null);
  });

  it('reads the last marker of a comment', () => {
    const first = parsed('docs', fullInputs.docs);
    const second = parsed('implementation', fullInputs.implementation);
    assert.deepEqual(decodeMarker(`${encodeMarker(first, meta)}\n${encodeMarker(second, meta)}`)?.result, second);
  });
});

describe('result contracts: size cap', () => {
  const finding = (severity: string, index: number) => ({ severity, file: `src/file-${index}.ts`, line: index + 1, problem: `${'p'.repeat(1500)} ${index}`, fix: 'f'.repeat(500) });

  it('trims the least severe findings and notes how many were omitted', () => {
    const findings = [
      ...Array.from({ length: 30 }, (_, i) => finding('nit', i)),
      ...Array.from({ length: 5 }, (_, i) => finding('blocker', 100 + i)),
      ...Array.from({ length: 30 }, (_, i) => finding('minor', 200 + i)),
    ];
    const result = parsed('review', { verdict: 'changes_needed', summary: 'Many findings.', findings });
    const comment = renderResultComment(result, meta);
    assert.ok(comment.length < RESULT_SIZE_LIMIT, `comment has ${comment.length} characters`);
    const decoded = decodeMarker(comment);
    assert.ok(decoded !== null && decoded.result.kind === 'review');
    const kept = decoded.result.findings;
    assert.ok(kept.length < findings.length && kept.length > 5);
    assert.equal(decoded.result.omitted_findings, findings.length - kept.length);
    assert.equal(kept.filter((f) => f.severity === 'blocker').length, 5, 'blockers are kept');
    assert.equal(kept.filter((f) => f.severity === 'nit').length, 0, 'nits are dropped first');
    assert.match(comment, new RegExp(`_${findings.length - kept.length} less severe finding\\(s\\) omitted`));

    const marker = encodeMarker(result, meta);
    assert.ok(marker.length < RESULT_SIZE_LIMIT);
    assert.ok((decodeMarker(marker)?.result as { findings: unknown[] }).findings.length > kept.length, 'the marker alone keeps more');
  });

  it('accepts an agent result whose findings only fit after trimming', () => {
    const findings = Array.from({ length: 60 }, (_, i) => finding('minor', i));
    parsed('review', { verdict: 'approved', summary: 'x', findings });
  });

  it('rejects results that do not fit without findings', () => {
    const files = Array.from({ length: 200 }, (_, i) => `${'docs/'.repeat(90)}${i}.md`);
    const problems = problemsOf('docs', { verdict: 'done', summary: 'x', files });
    assert.match(problems.join('\n'), /too large for an issue comment .*limit 60000/);
    const result = { schema: RESULT_SCHEMA, kind: 'docs', verdict: 'done', summary: 'x', blockers: [], follow_ups: [], files } as StageResult;
    assert.throws(() => encodeMarker({ ...result, files: [...files, ...files] } as StageResult, meta), { code: 'result_too_large' });
  });
});

describe('result contracts: rendering', () => {
  it('renders a review with findings, blockers, follow-ups and meta', () => {
    const result = parsed('review', { ...fullInputs.review, blockers: [{ description: 'CI is down', needs: 'infra' }], follow_ups: ['Refactor a.ts'] });
    const markdown = renderResultMarkdown(result, meta);
    assert.match(markdown, /^### ⚠️ Review: changes needed\n\nTwo findings\./);
    assert.match(markdown, /\*\*Findings \(2\)\*\*\n- 🟠 \*\*major\*\* `src\/a\.ts:12` — Off by one\n  Fix: Use <=\n- ⚪ \*\*nit\*\* — Typo/);
    assert.match(markdown, /\*\*Blockers\*\*\n- \*\*infra\*\*: CI is down/);
    assert.match(markdown, /\*\*Follow-ups\*\*\n- Refactor a\.ts/);
    assert.match(markdown, /<sub>Symphony · role `reviewer` · round 2 · run `run-1` · head `aaaaaaaaaaaa` · checks passed · → In review · profile `standard` · workflow `ffffffffffff` · 2026-10-18T10:00:05\.000Z<\/sub>$/);
    assert.ok(!markdown.includes('<!-- symphony'), 'the Markdown carries no marker');
  });

  it('renders every kind with its fields', () => {
    const expected: Record<AgentResultKind, RegExp[]> = {
      analysis: [/Type: feature · Complexity: M · Docs needed: yes/, /- \[ \] round trip works/, /\*\*Risks:\*\* breaking change/, /1\. Write schemas\n2\. Write tests/],
      design: [/\*\*Decision\*\*\nzod schemas/, /\*\*Components\*\*\n- schemas\.ts: zod schemas per kind\n- markers\.ts/, /\*\*Interfaces\*\*/, /\*\*Compatibility\*\*/, /1\. schemas/],
      implementation: [/- `src\/workflow\/results\.ts`/, /\*\*Tests added\*\*/, /\*\*Notes\*\*\nKept fields optional\./],
      test: [/### ❌ Test: failed/, /- ❌ size cap — `results\.test\.ts`/, /- `npm run check`/, /\*\*Uncovered criteria\*\*\n- dashboard/],
      review: [/\*\*Checked\*\*\n- tests\n- docs/],
      security: [/### ⚠️ Security review: issues found/, /🔴 \*\*blocker\*\* `src\/log\.ts`/],
      docs: [/### ✅ Documentation: done/, /- `docs\/results\.md`/],
    };
    for (const kind of AGENT_RESULT_KINDS) {
      const markdown = renderResultMarkdown(parsed(kind, fullInputs[kind]), meta);
      for (const pattern of expected[kind]) assert.match(markdown, pattern, `${kind}: ${markdown}`);
    }
    assert.match(renderResultMarkdown(internalResult('reset', 'Reset.'), meta), /^### 🔄 Pipeline reset: reset\n\nReset\./);
  });

  it('keeps agent text from opening an HTML comment', () => {
    const result = parsed('docs', { verdict: 'done', summary: 'Hide <!-- this', files: ['<!-- x'] });
    const markdown = renderResultMarkdown(result, meta);
    assert.ok(!markdown.includes('<!--'), markdown);
    assert.match(markdown, /Hide &lt;!-- this/);
  });

  it('omits empty sections and absent meta', () => {
    const markdown = renderResultMarkdown(parsed('docs', { verdict: 'not_needed', summary: 'Nothing to do.' }), {
      ...meta,
      run: null,
      round: null,
      profile: null,
      workflow_hash: null,
      head_sha: null,
      checks: null,
      target: null,
    });
    assert.equal(markdown, '### ✅ Documentation: not needed\n\nNothing to do.\n\n<sub>Symphony · role `reviewer` · 2026-10-18T10:00:05.000Z</sub>');
  });
});

describe('result contracts: tool input shape', () => {
  it('describes the agent fields, never the envelope or Symphony-owned fields', () => {
    for (const kind of AGENT_RESULT_KINDS) {
      const shape = toolInputShape(kind);
      assert.ok('verdict' in shape && 'summary' in shape && 'blockers' in shape && 'follow_ups' in shape, kind);
      for (const owned of ['schema', 'kind', 'meta', 'omitted_findings', 'role', 'round']) assert.ok(!(owned in shape), `${kind}: ${owned}`);
      assert.ok(z.object(shape).safeParse(fullInputs[kind]).success, kind);
    }
    assert.ok('findings' in toolInputShape('review') && 'cases' in toolInputShape('test') && 'open_questions' in toolInputShape('analysis'));
  });

  it('converts to JSON Schema with only verdict and summary required', () => {
    for (const io of ['input', 'output'] as const) {
      const schema = z.toJSONSchema(z.object(toolInputShape('review')), { io }) as { required?: string[] };
      assert.deepEqual(schema.required?.sort(), ['summary', 'verdict'], io);
    }
    assert.match(toolInputShape('review').findings?.description ?? '', /"approved" allows only minor and nit findings/);
  });
});
