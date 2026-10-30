import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTeamView, type TeamInput, type TeamRunning } from '../src/http/team.ts';
import type { PipelineSession, PipelineStage } from '../src/orchestrator/pipeline.ts';

const at = (hhmm: string) => `2026-10-03T${hhmm}:00.000Z`;

function session(run: string, role: string, start: string, end: string | null, verdict: string | null, round: number | null): PipelineSession {
  return { run, attempt: null, role, state: 'x', model: 'sonnet', effort: null, started_at: at(start), finished_at: end === null ? null : at(end), outcome: null, verdict, round };
}

function stage(id: string, kind: PipelineStage['kind'], columns: string[], status: PipelineStage['status'], sessions: PipelineSession[] = []): PipelineStage {
  return { id, label: id, kind, columns, status, sessions, verdict: sessions.at(-1)?.verdict ?? null, round: sessions.at(-1)?.round ?? null };
}

const running: TeamRunning = {
  role: 'developer',
  started_at: at('10:31'),
  last_message: 'Editing files',
  turn_count: 7,
  model: 'opus',
  tokens: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
  cost_usd: 0.5,
  context: { tokens: 100, window: 1000, percent: 10, compacts: 0 },
  subagents: { running: [], finished: [] },
};

const tool = (n: number, run: string, hhmm: string) => ({ at: `2026-10-03T${hhmm}:${String(n).padStart(2, '0')}.000Z`, kind: 'agent' as const, event: 'tool_use', run, message: `m${n}`, detail: { tool: `T${n}` } });

const results = [
  { role: 'developer', kind: 'result', verdict: 'implemented', target: 'Agent review', created_at: at('10:20') },
  { role: 'reviewer', kind: 'result', verdict: 'changes_needed', target: 'In progress', created_at: at('10:30') },
];

function fixture(over: Partial<TeamInput> = {}, finished = false): TeamInput {
  const dev = finished
    ? [session('r1', 'developer', '10:00', '10:20', 'implemented', 1), session('r3', 'developer', '10:31', '10:50', 'implemented', 2)]
    : [session('r1', 'developer', '10:00', '10:20', 'implemented', 1), session('r3', 'developer', '10:31', null, null, null)];
  const rev = finished
    ? [session('r2', 'reviewer', '10:21', '10:30', 'changes_needed', 1), session('r4', 'reviewer', '10:51', '11:00', 'approved', 2)]
    : [session('r2', 'reviewer', '10:21', '10:30', 'changes_needed', 1)];
  return {
    pipeline: [
      stage('architect', 'agent', ['Design'], 'skipped'),
      stage('developer', 'agent', ['In progress'], 'active', dev),
      stage('reviewer', 'agent', ['Agent review'], 'pending', rev),
      stage('human:in review', 'human', ['In review'], finished ? 'active' : 'pending'),
      stage('terminal:done', 'terminal', ['Done'], 'pending'),
    ],
    results: finished ? [...results, { role: 'developer', kind: 'result', verdict: 'implemented', target: 'Agent review', created_at: at('10:50') }, { role: 'reviewer', kind: 'result', verdict: 'approved', target: 'In review', created_at: at('11:00') }] : results,
    issueState: finished ? 'In review' : 'In progress',
    running: finished ? null : running,
    timeline: [tool(1, 'r1', '10:05'), tool(2, 'r1', '10:06'), tool(3, 'r2', '10:25'), ...[1, 2, 3, 4, 5].map((n) => tool(n, 'r3', '10:40'))],
    now: Date.parse(at('10:41')),
    ...over,
  };
}

describe('buildTeamView', () => {
  it('builds seats, blocks and handoffs for a running second round', () => {
    const view = buildTeamView(fixture());
    assert.deepEqual(view.seats.map((s) => s.role), ['architect', 'developer', 'reviewer', 'you']);
    assert.deepEqual(view.seats.map((s) => s.status), ['skipped', 'playing', 'returned', 'waiting']);
    assert.equal(view.seats[1]?.duration_ms, 20 * 60_000 + 10 * 60_000);
    assert.equal(view.seats[1]?.model, 'opus');
    assert.equal(view.seats[0]?.duration_ms, null);
    assert.deepEqual(view.blocks.map((b) => [b.role, b.tool_calls, b.verdict, b.round]), [
      ['developer', 2, 'implemented', 1],
      ['reviewer', 1, 'changes_needed', 1],
      ['developer', 5, null, null],
    ]);
    assert.equal(view.blocks[2]?.ended_at, null);
    assert.deepEqual(view.handoffs, [
      { from: 'developer', to: 'reviewer', verdict: 'implemented', at: at('10:20') },
      { from: 'reviewer', to: 'developer', verdict: 'changes_needed', at: at('10:30') },
    ]);
    assert.equal(view.active?.action, 'Editing files');
    assert.deepEqual(view.active?.recent_tools.map((t) => t.tool), ['T2', 'T3', 'T4', 'T5']);
    assert.equal(view.active?.turn, 7);
  });

  it('marks seats done and has no active session after the issue finished', () => {
    const view = buildTeamView(fixture({}, true));
    assert.deepEqual(view.seats.map((s) => s.status), ['skipped', 'done', 'done', 'waiting']);
    assert.equal(view.active, null);
    assert.deepEqual(view.subagents, { running: [], finished: [] });
    assert.equal(view.handoffs.length, 3);
    assert.equal(view.handoffs.at(-1)?.from, 'developer');
    assert.equal(view.handoffs.at(-1)?.to, 'reviewer');
  });

  it('passes subagents through and falls back to the start time without an open session', () => {
    const base = fixture();
    const subagents = { running: [{ id: 'a' }], finished: [{ id: 'b' }] } as unknown as TeamRunning['subagents'];
    const pipeline = base.pipeline.map((s) => (s.id === 'developer' ? { ...s, sessions: s.sessions.slice(0, 1) } : s));
    const view = buildTeamView({ ...base, pipeline, running: { ...running, subagents } });
    assert.equal(view.subagents, subagents);
    assert.deepEqual(view.active?.recent_tools.map((t) => t.tool), ['T2', 'T3', 'T4', 'T5']);
  });

  it('copes with archives without pipeline', () => {
    const view = buildTeamView({ ...fixture(), pipeline: [], results: [], running: null });
    assert.deepEqual(view.seats.map((s) => s.role), ['you']);
    assert.deepEqual(view.blocks, []);
  });
});
