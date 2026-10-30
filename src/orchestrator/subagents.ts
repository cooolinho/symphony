import type { SubagentRun } from '../agent/types.ts';

/** How many finished subagents a running issue keeps. */
export const FINISHED_SUBAGENTS = 10;

/** The subagents of one running issue: those still running and the last finished ones, oldest first. */
export interface SubagentBoard {
  running: Map<string, SubagentRun>;
  finished: SubagentRun[];
}

export function emptySubagents(): SubagentBoard {
  return { running: new Map(), finished: [] };
}

const copyOf = (run: SubagentRun): SubagentRun => ({ ...run, tokens: { ...run.tokens } });

/** Takes over the absolute snapshot of a subagent; a late `running` snapshot of a finished one is ignored. */
export function applySubagent(board: SubagentBoard, run: SubagentRun): void {
  if (run.status === 'running') {
    if (board.finished.some((done) => done.toolUseId === run.toolUseId)) return;
    board.running.set(run.toolUseId, copyOf(run));
    return;
  }
  board.running.delete(run.toolUseId);
  board.finished = board.finished.filter((done) => done.toolUseId !== run.toolUseId);
  board.finished.push(copyOf(run));
  if (board.finished.length > FINISHED_SUBAGENTS) board.finished.splice(0, board.finished.length - FINISHED_SUBAGENTS);
}

/** Ends every subagent still running as failed: the session is over. */
export function closeSubagents(board: SubagentBoard, at: Date): void {
  for (const run of [...board.running.values()]) applySubagent(board, { ...run, status: 'error', endedAt: at });
}

function subagentJson(run: SubagentRun) {
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = run.tokens;
  return {
    tool_use_id: run.toolUseId,
    subagent_type: run.subagentType,
    description: run.description,
    status: run.status,
    started_at: run.startedAt.toISOString(),
    ended_at: run.endedAt?.toISOString() ?? null,
    tokens: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
      total_tokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    },
  };
}

export function subagentsJson(board: SubagentBoard) {
  return { running: [...board.running.values()].map(subagentJson), finished: board.finished.map(subagentJson) };
}
