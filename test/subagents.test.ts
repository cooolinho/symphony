import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SubagentRun } from '../src/agent/types.ts';
import { applySubagent, closeSubagents, emptySubagents, FINISHED_SUBAGENTS, subagentsJson } from '../src/orchestrator/subagents.ts';

const run = (id: string, status: SubagentRun['status'] = 'running'): SubagentRun => ({
  toolUseId: id,
  subagentType: 'Explore',
  description: `run ${id}`,
  startedAt: new Date('2026-01-01T10:00:00Z'),
  endedAt: status === 'running' ? null : new Date('2026-01-01T10:01:00Z'),
  status,
  tokens: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
});

describe('subagent board', () => {
  it('keeps only the last ten finished subagents', () => {
    const board = emptySubagents();
    for (let i = 1; i <= 11; i++) {
      applySubagent(board, run(`t${i}`));
      applySubagent(board, run(`t${i}`, 'ok'));
    }
    assert.equal(FINISHED_SUBAGENTS, 10);
    assert.equal(board.running.size, 0);
    assert.deepEqual(board.finished.map((entry) => entry.toolUseId), ['t2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11']);
  });

  it('ignores a late running snapshot of a finished subagent', () => {
    const board = emptySubagents();
    applySubagent(board, run('a', 'ok'));
    applySubagent(board, run('a'));
    assert.equal(board.running.size, 0);
    assert.equal(board.finished.length, 1);
  });

  it('closes the running subagents as failed', () => {
    const board = emptySubagents();
    applySubagent(board, run('a'));
    const at = new Date('2026-01-01T11:00:00Z');
    closeSubagents(board, at);
    assert.equal(board.running.size, 0);
    assert.equal(board.finished[0]?.status, 'error');
    assert.equal(board.finished[0]?.endedAt, at);
  });

  it('renders the documented JSON', () => {
    const board = emptySubagents();
    applySubagent(board, run('a'));
    applySubagent(board, run('b', 'ok'));
    assert.deepEqual(subagentsJson(board), {
      running: [
        {
          tool_use_id: 'a',
          subagent_type: 'Explore',
          description: 'run a',
          status: 'running',
          started_at: '2026-01-01T10:00:00.000Z',
          ended_at: null,
          tokens: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4, total_tokens: 10 },
        },
      ],
      finished: [
        {
          tool_use_id: 'b',
          subagent_type: 'Explore',
          description: 'run b',
          status: 'ok',
          started_at: '2026-01-01T10:00:00.000Z',
          ended_at: '2026-01-01T10:01:00.000Z',
          tokens: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4, total_tokens: 10 },
        },
      ],
    });
  });
});
