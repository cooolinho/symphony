import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { buildTeamView, type TeamInput, type TeamRunning } from '../src/http/team.ts';
import type { PipelineSession, PipelineStage } from '../src/orchestrator/pipeline.ts';

// Independent fixture: developer (round 1) -> reviewer (sends back) -> developer (round 2, still running).
const t = (hhmmss: string) => `2026-11-01T${hhmmss}.000Z`;

function sess(run: string, role: string, start: string, end: string | null, verdict: string | null, round: number | null, model = 'sonnet'): PipelineSession {
  return { run, attempt: null, role, state: 'x', model, effort: null, started_at: t(start), finished_at: end === null ? null : t(end), outcome: null, verdict, round };
}

function stg(id: string, kind: PipelineStage['kind'], columns: string[], status: PipelineStage['status'], sessions: PipelineSession[] = []): PipelineStage {
  return { id, label: id, kind, columns, status, sessions, verdict: sessions.at(-1)?.verdict ?? null, round: sessions.at(-1)?.round ?? null };
}

const ev = (run: string | null, at: string, event = 'tool_use', tool: string | null = 'Bash', kind: 'agent' | 'orchestrator' = 'agent') => ({
  at: t(at),
  kind: kind as 'agent',
  event,
  run,
  message: `${tool} call`,
  detail: tool === null ? null : { tool },
});

const live: TeamRunning = {
  role: 'developer',
  started_at: t('10:30:00'),
  last_message: 'Fixing the review findings',
  turn_count: 12,
  model: 'opus',
  tokens: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  cost_usd: 1.25,
  context: { tokens: 50_000, window: 200_000, percent: 25, compacts: 1 },
  subagents: { running: [], finished: [] },
};

function input(over: Partial<TeamInput> = {}): TeamInput {
  const dev = [sess('d1', 'developer', '10:00:00', '10:10:00', 'implemented', 1), sess('d2', 'developer', '10:30:00', null, null, null, 'opus')];
  const rev = [sess('v1', 'reviewer', '10:11:00', '10:20:00', 'changes_needed', 1)];
  return {
    pipeline: [
      stg('developer', 'agent', ['In progress'], 'active', dev),
      stg('reviewer', 'agent', ['Agent review'], 'pending', rev),
      stg('human:in review', 'human', ['In review'], 'pending'),
      stg('terminal:done', 'terminal', ['Done'], 'pending'),
    ],
    results: [
      { role: 'developer', kind: 'result', verdict: 'implemented', target: 'Agent review', created_at: t('10:10:00') },
      { role: 'reviewer', kind: 'result', verdict: 'changes_needed', target: 'In progress', created_at: t('10:20:00') },
    ],
    issueState: 'In progress',
    running: live,
    timeline: [
      ev('d1', '10:01:00'),
      ev('d1', '10:02:00'),
      ev('d1', '10:03:00'),
      ev('v1', '10:12:00'),
      ev('d2', '10:31:00', 'tool_use', 'Read'),
      ev('d2', '10:32:00', 'tool_use', 'Edit'),
      ev('d2', '10:32:30', 'text', null),
      ev('d2', '10:33:00', 'tool_use', 'Grep'),
      ev('d2', '10:34:00', 'tool_use', 'Write'),
      ev('d2', '10:35:00', 'tool_use', 'Bash'),
    ],
    now: Date.parse(t('10:36:00')),
    ...over,
  };
}

describe('team view (independent fixture)', () => {
  it('returns exactly seats, active, subagents, blocks, handoffs', () => {
    assert.deepEqual(Object.keys(buildTeamView(input())).sort(), ['active', 'blocks', 'handoffs', 'seats', 'subagents']);
  });

  it('has one seat per agent role in pipeline order plus a trailing "you" seat; human/terminal stages are no role seats', () => {
    const { seats } = buildTeamView(input());
    assert.deepEqual(seats.map((s) => s.role), ['developer', 'reviewer', 'you']);
    for (const seat of seats) {
      assert.ok(['done', 'playing', 'waiting', 'returned', 'skipped'].includes(seat.status), seat.status);
      for (const key of ['role', 'status', 'verdict', 'duration_ms', 'model']) assert.ok(key in seat, key);
    }
  });

  it('marks the running role playing and the sender-back reviewer returned', () => {
    const { seats } = buildTeamView(input());
    assert.equal(seats[0]?.status, 'playing');
    assert.equal(seats[1]?.status, 'returned');
    assert.equal(seats[1]?.verdict, 'changes_needed');
  });

  it('sums finished session durations per seat (the open session adds nothing before it counts)', () => {
    const view = buildTeamView(input({ running: null, pipeline: input().pipeline.map((s) => (s.id === 'developer' ? { ...s, sessions: s.sessions.slice(0, 1) } : s)) }));
    assert.equal(view.seats[0]?.duration_ms, 10 * 60_000);
    assert.equal(view.seats[1]?.duration_ms, 9 * 60_000);
  });

  it('reports a role without sessions as waiting with no duration or model', () => {
    const base = input({ running: null, results: [] });
    const pipeline = base.pipeline.map((s) => (s.id === 'reviewer' ? { ...s, sessions: [], verdict: null, round: null } : s));
    const reviewer = buildTeamView({ ...base, pipeline }).seats.find((s) => s.role === 'reviewer');
    assert.equal(reviewer?.status, 'waiting');
    assert.equal(reviewer?.verdict, null);
    assert.ok(reviewer?.duration_ms === null || reviewer?.duration_ms === 0);
    assert.equal(reviewer?.model, null);
  });

  it('reports skipped roles as skipped', () => {
    const base = input();
    const pipeline: PipelineStage[] = [stg('architect', 'agent', ['Design'], 'skipped'), ...base.pipeline];
    const seats = buildTeamView({ ...base, pipeline }).seats;
    assert.deepEqual(seats.map((s) => s.role), ['architect', 'developer', 'reviewer', 'you']);
    assert.equal(seats[0]?.status, 'skipped');
  });

  it('marks finished roles done after approval', () => {
    const base = input();
    const pipeline = [
      stg('developer', 'agent', ['In progress'], 'done', [sess('d1', 'developer', '10:00:00', '10:10:00', 'implemented', 1), sess('d2', 'developer', '10:30:00', '10:40:00', 'implemented', 2)]),
      stg('reviewer', 'agent', ['Agent review'], 'done', [sess('v1', 'reviewer', '10:11:00', '10:20:00', 'changes_needed', 1), sess('v2', 'reviewer', '10:41:00', '10:50:00', 'approved', 2)]),
      stg('human:in review', 'human', ['In review'], 'active'),
      stg('terminal:done', 'terminal', ['Done'], 'pending'),
    ];
    const results = [...base.results, { role: 'developer', kind: 'result', verdict: 'implemented', target: 'Agent review', created_at: t('10:40:00') }, { role: 'reviewer', kind: 'result', verdict: 'approved', target: 'In review', created_at: t('10:50:00') }];
    const view = buildTeamView({ ...base, pipeline, results, running: null, issueState: 'In review' });
    assert.deepEqual(view.seats.map((s) => s.status), ['done', 'done', 'waiting']);
    assert.equal(view.seats[1]?.verdict, 'approved');
    assert.equal(view.active, null);
  });

  for (const column of ['In review', 'Human Review', 'human review', 'IN REVIEW']) {
    it(`"you" waits while the issue sits in "${column}"`, () => {
      const you = buildTeamView(input({ running: null, issueState: column })).seats.at(-1);
      assert.equal(you?.role, 'you');
      assert.equal(you?.status, 'waiting');
    });
  }

  it('active is null without a running session', () => {
    assert.equal(buildTeamView(input({ running: null })).active, null);
  });

  it('active carries role, action, context, turn, model, tokens and cost from the running session', () => {
    const { active } = buildTeamView(input());
    assert.ok(active !== null);
    assert.equal(active.role, 'developer');
    assert.equal(active.action, 'Fixing the review findings');
    assert.deepEqual(active.context, live.context);
    assert.equal(active.turn, 12);
    assert.equal(active.model, 'opus');
    assert.deepEqual(active.tokens, live.tokens);
    assert.equal(active.cost_usd, 1.25);
  });

  it('active.recent_tools are the last four tool calls of the live run, oldest first, ignoring other events and other runs', () => {
    const tools = buildTeamView(input()).active?.recent_tools.map((x) => x.tool);
    assert.deepEqual(tools, ['Edit', 'Grep', 'Write', 'Bash']);
  });

  it('active.recent_tools has fewer than four entries when fewer calls happened', () => {
    const timeline = [ev('d2', '10:31:00', 'tool_use', 'Read'), ev('d1', '10:01:00', 'tool_use', 'Old')];
    assert.deepEqual(buildTeamView(input({ timeline })).active?.recent_tools.map((x) => x.tool), ['Read']);
    assert.deepEqual(buildTeamView(input({ timeline: [] })).active?.recent_tools, []);
  });

  it('passes subagents through from the running session and is empty otherwise', () => {
    const subagents = { running: [{ id: 's1' }], finished: [{ id: 's2' }, { id: 's3' }] } as unknown as TeamRunning['subagents'];
    assert.equal(buildTeamView(input({ running: { ...live, subagents } })).subagents, subagents);
    assert.deepEqual(buildTeamView(input({ running: null })).subagents, { running: [], finished: [] });
  });

  it('has one block per session in chronological order with verdict, round, times and tool call counts', () => {
    const { blocks } = buildTeamView(input());
    assert.deepEqual(
      blocks.map((b) => ({ role: b.role, started_at: b.started_at, ended_at: b.ended_at, verdict: b.verdict, round: b.round, tool_calls: b.tool_calls })),
      [
        { role: 'developer', started_at: t('10:00:00'), ended_at: t('10:10:00'), verdict: 'implemented', round: 1, tool_calls: 3 },
        { role: 'reviewer', started_at: t('10:11:00'), ended_at: t('10:20:00'), verdict: 'changes_needed', round: 1, tool_calls: 1 },
        { role: 'developer', started_at: t('10:30:00'), ended_at: null, verdict: null, round: null, tool_calls: 5 },
      ],
    );
  });

  it('counts only tool_use events of agent kind for tool_calls and defaults to 0 without events', () => {
    const timeline = [ev('d1', '10:01:00', 'tool_use', 'Bash', 'orchestrator'), ev('d1', '10:02:00', 'text', null), ev('d1', '10:03:00', 'tool_use', 'Bash')];
    const blocks = buildTeamView(input({ timeline })).blocks;
    assert.equal(blocks[0]?.tool_calls, 1);
    assert.equal(blocks[1]?.tool_calls, 0);
    assert.equal(buildTeamView(input({ timeline: [] })).blocks.every((b) => b.tool_calls === 0), true);
  });

  it('orders blocks by start time even when stages list sessions out of order', () => {
    const base = input();
    const pipeline = [base.pipeline[1] as PipelineStage, base.pipeline[0] as PipelineStage, ...base.pipeline.slice(2)];
    assert.deepEqual(buildTeamView({ ...base, pipeline }).blocks.map((b) => b.role), ['developer', 'reviewer', 'developer']);
  });

  it('creates one handoff per role change, with the verdict of the handing-over session', () => {
    const { handoffs } = buildTeamView(input());
    assert.equal(handoffs.length, 2);
    assert.deepEqual(handoffs.map((h) => [h.from, h.to, h.verdict]), [
      ['developer', 'reviewer', 'implemented'],
      ['reviewer', 'developer', 'changes_needed'],
    ]);
    for (const h of handoffs) assert.ok(!Number.isNaN(Date.parse(h.at)), h.at);
    assert.ok(Date.parse(handoffs[0]?.at as string) >= Date.parse(t('10:00:00')) && Date.parse(handoffs[0]?.at as string) <= Date.parse(t('10:11:00')));
  });

  it('creates no handoff when the same role runs twice in a row', () => {
    const base = input();
    const pipeline = [stg('developer', 'agent', ['In progress'], 'done', [sess('a', 'developer', '10:00:00', '10:05:00', 'implemented', 1), sess('b', 'developer', '10:06:00', '10:08:00', 'implemented', 2)])];
    const view = buildTeamView({ ...base, pipeline, running: null, results: [] });
    assert.equal(view.blocks.length, 2);
    assert.deepEqual(view.handoffs, []);
  });

  it('handles an issue without any session', () => {
    const view = buildTeamView(input({ pipeline: input().pipeline.map((s) => ({ ...s, sessions: [], verdict: null, round: null })), results: [], running: null, timeline: [] }));
    assert.deepEqual(view.blocks, []);
    assert.deepEqual(view.handoffs, []);
    assert.equal(view.active, null);
  });

  it('is pure: same input, same output, input untouched; module does not import the HTTP server', () => {
    const data = input();
    const snapshot = JSON.stringify(data);
    assert.deepEqual(buildTeamView(data), buildTeamView(data));
    assert.equal(JSON.stringify(data), snapshot);
    const source = fs.readFileSync(new URL('../src/http/team.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from '(node:http|\.\/server\.ts)'/);
    assert.doesNotMatch(source, /import\s+(?!type)[^;]*from '\.\.\/orchestrator\/orchestrator\.ts'/);
  });
});
