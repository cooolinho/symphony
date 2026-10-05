import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { readTranscript } from '../src/agent/transcript.ts';
import { parsePricing } from '../src/costs/pricing.ts';
import { tempDir } from './helpers.ts';

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const at = (s: number) => `2026-10-05T10:00:${String(s).padStart(2, '0')}.000Z`;

function writeTranscript(lines: string[]): string {
  const file = path.join(tempDir(), 'session.jsonl');
  fs.writeFileSync(file, lines.join(''));
  return file;
}

describe('session transcript reader', () => {
  const pricing = parsePricing('default: { input: 5, output: 25 }\nopus: { input: 10, output: 50 }\n', 'model-costs.yml');

  it('normalizes prompts, model calls, tool calls, tool results and turn results', () => {
    const file = writeTranscript([
      line({ at: at(0), message: { type: 'system', subtype: 'init', model: 'claude-opus-5-5', permissionMode: 'auto', tools: ['Bash', 'Read'], mcp_servers: [{ name: 'tracker', status: 'connected' }] } }),
      line({ at: at(1), prompt: { turn: 1, text: 'Work on acme/app#1' } }),
      line({
        at: at(3),
        message: {
          type: 'assistant', parent_tool_use_id: null,
          message: { id: 'msg_1', model: 'claude-opus-5-5', stop_reason: null, content: [{ type: 'text', text: 'Looking at the issue.' }], usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } },
        },
      }),
      line({
        at: at(4),
        message: {
          type: 'assistant', parent_tool_use_id: null,
          message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__tracker__set_status', input: { status: 'Done' } }], usage: { input_tokens: 1000, output_tokens: 250 } },
        },
      }),
      line({ at: at(6), message: { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: true, content: [{ type: 'text', text: 'HTTP 403' }] }] } } }),
      line({ at: at(7), message: { type: 'rate_limit_event', rate_limit_info: {} } }),
      line({ at: at(8), message: { type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: 7000, total_cost_usd: 0.05, result: 'Moved the issue.' } }),
    ]);
    const chunk = readTranscript(file, 0, { pricing });
    assert.ok(chunk !== null);
    assert.equal(chunk.more, false);
    assert.equal(chunk.next_offset, chunk.size);
    assert.deepEqual(chunk.entries.map((e) => e.type), ['session', 'prompt', 'model_call', 'model_call', 'tool_result', 'turn_result']);
    const [session, prompt, text, toolUse, result, turn] = chunk.entries;
    assert.ok(session?.type === 'session' && prompt?.type === 'prompt' && text?.type === 'model_call' && toolUse?.type === 'model_call');
    assert.deepEqual([session.model, session.tools, session.mcp_servers], ['claude-opus-5-5', 2, ['tracker:connected']]);
    assert.deepEqual([prompt.turn, prompt.text], [1, 'Work on acme/app#1']);
    assert.equal(text.message_id, 'msg_1');
    assert.deepEqual(text.usage, { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 5000, cache_write_tokens: 0 });
    // opus price: 1000 * 10 + 200 * 50 + 5000 * 1 (cache read 10%) per million.
    assert.equal(text.cost_usd, 0.025);
    assert.deepEqual(toolUse.blocks, [{ type: 'tool_use', id: 'tu_1', name: 'mcp__tracker__set_status', input: '{\n  "status": "Done"\n}' }]);
    assert.ok(result?.type === 'tool_result');
    assert.deepEqual([result.tool_use_id, result.is_error, result.text], ['tu_1', true, 'HTTP 403']);
    assert.ok(turn?.type === 'turn_result');
    assert.deepEqual([turn.is_error, turn.num_turns, turn.duration_ms, turn.text], [false, 2, 7000, 'Moved the issue.']);
  });

  it('reads incrementally from a byte offset and leaves an unfinished line for later', () => {
    const first = line({ at: at(1), prompt: { turn: 1, text: 'one' } });
    const second = line({ at: at(2), prompt: { turn: 2, text: 'two' } });
    const file = writeTranscript([first, second, '{"at":"partial']);
    const chunk = readTranscript(file, 0);
    assert.ok(chunk !== null);
    assert.deepEqual(chunk.entries.map((e) => e.offset), [0, Buffer.byteLength(first)]);
    assert.equal(chunk.next_offset, Buffer.byteLength(first + second));
    assert.equal(chunk.more, true);

    const small = readTranscript(file, 0, { maxBytes: 10 });
    assert.equal(small?.entries.length, 1, 'a line longer than maxBytes is still read whole');
    const rest = readTranscript(file, small?.next_offset ?? 0);
    assert.deepEqual(rest?.entries.map((e) => (e.type === 'prompt' ? e.text : '')), ['two']);
    assert.equal(readTranscript(path.join(tempDir(), 'missing.jsonl'), 0), null);
  });

  it('cuts long texts and skips lines it cannot parse', () => {
    const file = writeTranscript(['not json\n', line({ at: at(1), prompt: { turn: 1, text: 'x'.repeat(50) } })]);
    const chunk = readTranscript(file, 0, { maxText: 10 });
    const prompt = chunk?.entries[0];
    assert.ok(prompt?.type === 'prompt');
    assert.deepEqual([prompt.text.length, prompt.truncated, prompt.length], [10, true, 50]);
  });
});
