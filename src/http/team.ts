import type { TimelineEvent } from '../orchestrator/orchestrator.ts';
import type { PipelineStage } from '../orchestrator/pipeline.ts';
import type { ResultRow } from '../orchestrator/stage-history.ts';
import type { subagentsJson } from '../orchestrator/subagents.ts';
import { normalizeStateName } from '../workflow/config.ts';

/** The running session as `#runningRow` reports it (only the fields the team view uses). */
export interface TeamRunning {
  role: string;
  started_at: string;
  last_message: string;
  turn_count: number;
  model: string | null;
  tokens: { input_tokens: number; output_tokens: number; total_tokens: number };
  cost_usd: number;
  context: { tokens: number; window: number | null; percent: number | null; compacts: number };
  subagents: ReturnType<typeof subagentsJson>;
}

export interface TeamInput {
  pipeline: PipelineStage[];
  results: Array<Pick<ResultRow, 'role' | 'kind' | 'verdict' | 'target' | 'created_at'>>;
  /** Board column of the issue; null when unknown. */
  issueState: string | null;
  running: TeamRunning | null;
  timeline: Array<Pick<TimelineEvent, 'at' | 'kind' | 'event' | 'run' | 'message' | 'detail'>>;
  /** Current time in epoch ms; the module never reads the clock itself. */
  now: number;
}

export type SeatStatus = 'done' | 'playing' | 'waiting' | 'returned' | 'skipped';

export interface TeamSeat {
  role: string;
  status: SeatStatus;
  verdict: string | null;
  duration_ms: number | null;
  model: string | null;
}

export interface TeamTool {
  tool: string;
  message: string | null;
  at: string;
}

export interface TeamActive {
  role: string;
  action: string;
  recent_tools: TeamTool[];
  context: TeamRunning['context'];
  turn: number;
  model: string | null;
  tokens: TeamRunning['tokens'];
  cost_usd: number;
}

export interface TeamBlock {
  role: string;
  run: string;
  started_at: string;
  ended_at: string | null;
  verdict: string | null;
  round: number | null;
  model: string | null;
  tool_calls: number;
}

export interface TeamHandoff {
  from: string;
  to: string;
  verdict: string | null;
  at: string;
}

export interface TeamView {
  seats: TeamSeat[];
  active: TeamActive | null;
  subagents: ReturnType<typeof subagentsJson>;
  blocks: TeamBlock[];
  handoffs: TeamHandoff[];
}

const RECENT_TOOLS = 4;
const HUMAN_COLUMNS = new Set(['in review', 'human review']);

const isToolUse = (event: TeamInput['timeline'][number]) => event.kind === 'agent' && event.event === 'tool_use';

/** The newest unfinished session of the running role: the run the live session writes its events under. */
function activeRun(input: TeamInput, agents: PipelineStage[]): string | null {
  if (input.running === null) return null;
  const open = agents
    .filter((stage) => stage.id === input.running?.role)
    .flatMap((stage) => stage.sessions)
    .filter((session) => session.finished_at === null)
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
  return open.at(-1)?.run ?? null;
}

/** Whether the role's newest result sent the issue back to a stage left of its own. */
function returned(input: TeamInput, stage: PipelineStage, index: number): boolean {
  const newest = input.results.filter((result) => result.role === stage.id && result.kind !== 'reset' && result.kind !== 'skipped').at(-1);
  if (newest?.target == null) return false;
  const target = normalizeStateName(newest.target);
  const targetIndex = input.pipeline.findIndex((candidate) => candidate.columns.some((column) => normalizeStateName(column) === target));
  return targetIndex >= 0 && targetIndex < index;
}

function youStatus(input: TeamInput): SeatStatus {
  const waiting =
    input.pipeline.some((stage) => stage.kind === 'human' && stage.status === 'active') ||
    (input.issueState !== null && HUMAN_COLUMNS.has(normalizeStateName(input.issueState)));
  if (waiting) return 'waiting';
  return input.pipeline.some((stage) => stage.kind !== 'agent' && stage.status === 'done') ? 'done' : 'waiting';
}

/**
 * Seats, active session, subagents, score blocks and handoffs of an issue (GET /api/v1/<identifier>/team).
 * Pure: no I/O, the time comes in as `now`.
 *
 * - `returned`: the role's newest result (not reset/skipped) targets a stage left of its own.
 * - `you`: `waiting` while a human stage is active or the issue sits in "In review"/"Human Review".
 * - `tool_calls` counts `tool_use` events still in the timeline, which the orchestrator caps (TIMELINE_EVENTS);
 *   runs that dropped out of it count 0.
 */
export function buildTeamView(input: TeamInput): TeamView {
  const agents = input.pipeline.filter((stage) => stage.kind === 'agent');
  const run = activeRun(input, agents);
  const toolCounts = new Map<string, number>();
  for (const event of input.timeline) {
    if (isToolUse(event) && event.run !== null) toolCounts.set(event.run, (toolCounts.get(event.run) ?? 0) + 1);
  }

  const seats: TeamSeat[] = input.pipeline.flatMap((stage, index): TeamSeat[] => {
    if (stage.kind !== 'agent') return [];
    const playing = input.running !== null && input.running.role === stage.id;
    const status: SeatStatus = playing
      ? 'playing'
      : stage.status === 'skipped'
        ? 'skipped'
        : returned(input, stage, index)
          ? 'returned'
          : stage.sessions.length > 0 || stage.status === 'done'
            ? 'done'
            : 'waiting';
    const duration = stage.sessions.reduce((sum, session) => {
      const start = Date.parse(session.started_at);
      const end = session.finished_at !== null ? Date.parse(session.finished_at) : session.run === run ? input.now : start;
      return sum + Math.max(end - start, 0);
    }, 0);
    return [
      {
        role: stage.id,
        status,
        verdict: stage.verdict,
        duration_ms: stage.sessions.length === 0 ? null : duration,
        model: playing ? (input.running?.model ?? null) : (stage.sessions.at(-1)?.model ?? null),
      },
    ];
  });
  seats.push({ role: 'you', status: youStatus(input), verdict: null, duration_ms: null, model: null });

  let active: TeamActive | null = null;
  if (input.running !== null) {
    const running = input.running;
    const since = Date.parse(running.started_at);
    const tools = input.timeline
      .filter((event) => isToolUse(event) && typeof event.detail?.tool === 'string' && (run !== null ? event.run === run : Date.parse(event.at) >= since))
      .slice(-RECENT_TOOLS)
      .map((event) => ({ tool: event.detail?.tool as string, message: event.message, at: event.at }));
    active = {
      role: running.role,
      action: running.last_message,
      recent_tools: tools,
      context: running.context,
      turn: running.turn_count,
      model: running.model,
      tokens: running.tokens,
      cost_usd: running.cost_usd,
    };
  }

  const blocks: TeamBlock[] = agents
    .flatMap((stage) => stage.sessions)
    .sort((a, b) => a.started_at.localeCompare(b.started_at))
    .map((session) => ({
      role: session.role,
      run: session.run,
      started_at: session.started_at,
      ended_at: session.finished_at,
      verdict: session.verdict,
      round: session.round,
      model: session.model,
      tool_calls: toolCounts.get(session.run) ?? 0,
    }));

  const handoffs: TeamHandoff[] = [];
  for (let i = 1; i < blocks.length; i++) {
    const prev = blocks[i - 1] as TeamBlock;
    const next = blocks[i] as TeamBlock;
    if (prev.role !== next.role) handoffs.push({ from: prev.role, to: next.role, verdict: prev.verdict, at: prev.ended_at ?? next.started_at });
  }

  return { seats, active, subagents: input.running?.subagents ?? { running: [], finished: [] }, blocks, handoffs };
}
