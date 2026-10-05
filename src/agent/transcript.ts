import fs from 'node:fs';
import { costOf, priceFor, type ModelTokenUsage, type PricingTable } from '../costs/pricing.ts';

/**
 * Reader for the per-session JSONL transcripts (`<log-dir>/sessions/<workspace>/<stamp>.jsonl`). Each line is
 * `{ at, message }` with a raw Agent SDK message, or `{ at, prompt: { turn, text } }` for the prompt Symphony
 * sent at the start of a turn. The reader turns them into a small, stable shape for the agent detail view:
 * prompts, model calls (one line per content block, grouped by `message_id`), tool results and turn results.
 * Unknown messages are skipped, so new SDK message types never break the view.
 */

/** Token counts of one model call as the Messages API reports them. */
export interface CallUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export type TranscriptBlock =
  | { type: 'text'; text: string; truncated?: true; length?: number }
  | { type: 'thinking'; text: string; truncated?: true; length?: number }
  | { type: 'tool_use'; id: string; name: string; input: string; truncated?: true; length?: number }
  | { type: string };

export type TranscriptEntry = { offset: number; at: string } & (
  | { type: 'prompt'; turn: number | null; text: string; truncated?: true; length?: number }
  | { type: 'session'; model: string | null; permission_mode: string | null; tools: number; mcp_servers: string[] }
  | {
      type: 'model_call';
      message_id: string | null;
      model: string | null;
      usage: CallUsage | null;
      /** Estimated with model-costs.yml; null when no price table is available or the call has no usage. */
      cost_usd: number | null;
      stop_reason: string | null;
      error: string | null;
      /** Set for calls of a subagent (the Task tool call that started it). */
      parent_tool_use_id: string | null;
      blocks: TranscriptBlock[];
    }
  | { type: 'tool_result'; tool_use_id: string; is_error: boolean; text: string; truncated?: true; length?: number; parent_tool_use_id: string | null }
  | { type: 'user_message'; text: string; truncated?: true; length?: number }
  | {
      type: 'turn_result';
      subtype: string;
      is_error: boolean;
      num_turns: number | null;
      duration_ms: number | null;
      total_cost_usd: number | null;
      text: string;
      truncated?: true;
      length?: number;
    }
  | { type: 'system'; subtype: string; text: string }
);

export interface TranscriptChunk {
  /** Byte offset this chunk started at. */
  from: number;
  /** Byte offset to pass as `from` for the next chunk (after the last complete line read). */
  next_offset: number;
  /** File size when it was read; more data is waiting when next_offset < size. */
  size: number;
  more: boolean;
  entries: TranscriptEntry[];
}

export interface ReadTranscriptOptions {
  pricing?: PricingTable | null;
  /** Bytes read per call (complete lines only; a single longer line is still read whole). */
  maxBytes?: number;
  /** Characters kept per text field; longer values are cut and flagged `truncated`. */
  maxText?: number;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TEXT = 64 * 1024;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Reads complete JSONL lines starting at byte `from`; returns null when the file does not exist. */
export function readTranscript(file: string, from: number, options: ReadTranscriptOptions = {}): TranscriptChunk | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.min(Math.max(0, Math.floor(from)), size);
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    // Read up to maxBytes, then keep reading while the chunk does not yet end a line.
    const parts: Buffer[] = [];
    let position = start;
    let lastNewline = -1;
    let total = 0;
    while (position < size) {
      const length = Math.min(maxBytes, size - position);
      const buffer = Buffer.alloc(length);
      const read = fs.readSync(fd, buffer, 0, length, position);
      if (read <= 0) break;
      const part = buffer.subarray(0, read);
      const newline = part.lastIndexOf(0x0a);
      if (newline >= 0) lastNewline = total + newline;
      parts.push(part);
      total += read;
      position += read;
      if (lastNewline >= 0) break;
    }
    const usable = lastNewline < 0 ? Buffer.alloc(0) : Buffer.concat(parts, total).subarray(0, lastNewline + 1);
    const entries: TranscriptEntry[] = [];
    const maxText = options.maxText ?? DEFAULT_MAX_TEXT;
    let lineStart = 0;
    while (lineStart < usable.length) {
      const end = usable.indexOf(0x0a, lineStart);
      const line = usable.subarray(lineStart, end).toString('utf8');
      const offset = start + lineStart;
      lineStart = end + 1;
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = normalizeLine(parsed, offset, options.pricing ?? null, maxText);
      if (entry !== null) entries.push(entry);
    }
    const next = start + usable.length;
    return { from: start, next_offset: next, size, more: next < size, entries };
  } finally {
    fs.closeSync(fd);
  }
}

function clip(text: string, maxText: number): { text: string; truncated?: true; length?: number } {
  if (text.length <= maxText) return { text };
  return { text: text.slice(0, maxText), truncated: true, length: text.length };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined || content === null ? '' : JSON.stringify(content, null, 2);
  return content
    .map((part) => {
      if (isObject(part) && part.type === 'text' && typeof part.text === 'string') return part.text;
      if (isObject(part) && typeof part.type === 'string') return `[${part.type}]`;
      return '';
    })
    .filter((part) => part !== '')
    .join('\n');
}

function callUsage(usage: unknown): CallUsage | null {
  if (!isObject(usage)) return null;
  return {
    input_tokens: num(usage.input_tokens) ?? 0,
    output_tokens: num(usage.output_tokens) ?? 0,
    cache_read_tokens: num(usage.cache_read_input_tokens) ?? 0,
    cache_write_tokens: num(usage.cache_creation_input_tokens) ?? 0,
  };
}

function callCost(pricing: PricingTable | null, model: string | null, usage: CallUsage | null): number | null {
  if (pricing === null || model === null || usage === null) return null;
  const tokens: ModelTokenUsage = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_tokens,
    cacheWriteTokens: usage.cache_write_tokens,
  };
  return Math.round(costOf(tokens, priceFor(pricing, model).price) * 1_000_000) / 1_000_000;
}

function block(raw: unknown, maxText: number): TranscriptBlock | null {
  if (!isObject(raw) || typeof raw.type !== 'string') return null;
  if (raw.type === 'text') return { type: 'text', ...clip(str(raw.text) ?? '', maxText) };
  if (raw.type === 'thinking') return { type: 'thinking', ...clip(str(raw.thinking) ?? '', maxText) };
  if (raw.type === 'tool_use' || raw.type === 'server_tool_use' || raw.type === 'mcp_tool_use') {
    const input = JSON.stringify(raw.input ?? {}, null, 2);
    const clipped = clip(input, maxText);
    return { type: 'tool_use', id: str(raw.id) ?? '', name: str(raw.name) ?? 'unknown', input: clipped.text, ...(clipped.truncated ? { truncated: true, length: clipped.length } : {}) };
  }
  return { type: raw.type };
}

/** One transcript line → entry; null for lines the view does not show. */
export function normalizeLine(line: unknown, offset: number, pricing: PricingTable | null, maxText = DEFAULT_MAX_TEXT): TranscriptEntry | null {
  if (!isObject(line)) return null;
  const at = str(line.at) ?? '';
  if (isObject(line.prompt)) {
    return { offset, at, type: 'prompt', turn: num(line.prompt.turn), ...clip(str(line.prompt.text) ?? '', maxText) };
  }
  const message = line.message;
  if (!isObject(message)) return null;
  const parent = str(message.parent_tool_use_id);
  switch (message.type) {
    case 'system': {
      const subtype = str(message.subtype) ?? 'system';
      if (subtype === 'init') {
        return {
          offset,
          at,
          type: 'session',
          model: str(message.model),
          permission_mode: str(message.permissionMode),
          tools: Array.isArray(message.tools) ? message.tools.length : 0,
          mcp_servers: Array.isArray(message.mcp_servers)
            ? message.mcp_servers.filter(isObject).map((server) => `${str(server.name) ?? '?'}:${str(server.status) ?? '?'}`)
            : [],
        };
      }
      if (subtype === 'api_retry') {
        const text = `API retry ${num(message.attempt) ?? '?'}/${num(message.max_retries) ?? '?'} (${String(message.error ?? 'error')}) in ${num(message.retry_delay_ms) ?? '?'}ms`;
        return { offset, at, type: 'system', subtype, text };
      }
      if (subtype === 'compact_boundary') {
        const meta = isObject(message.compact_metadata) ? message.compact_metadata : {};
        const text = `context compacted (${String(meta.trigger ?? 'auto')}, ${num(meta.pre_tokens) ?? '?'} tokens before)`;
        return { offset, at, type: 'system', subtype, text };
      }
      return null;
    }
    case 'assistant': {
      const body = isObject(message.message) ? message.message : {};
      const model = str(body.model);
      const usage = callUsage(body.usage);
      const content = Array.isArray(body.content) ? body.content : [];
      return {
        offset,
        at,
        type: 'model_call',
        message_id: str(body.id),
        model,
        usage,
        cost_usd: callCost(pricing, model, usage),
        stop_reason: str(body.stop_reason),
        error: str(message.error),
        parent_tool_use_id: parent,
        blocks: content.map((raw) => block(raw, maxText)).filter((b): b is TranscriptBlock => b !== null),
      };
    }
    case 'user': {
      const body = isObject(message.message) ? message.message : {};
      const content = body.content;
      if (Array.isArray(content)) {
        const result = content.find((part) => isObject(part) && part.type === 'tool_result');
        if (isObject(result)) {
          return {
            offset,
            at,
            type: 'tool_result',
            tool_use_id: str(result.tool_use_id) ?? '',
            is_error: result.is_error === true,
            ...clip(textOf(result.content), maxText),
            parent_tool_use_id: parent,
          };
        }
      }
      if (message.isReplay === true || message.isSynthetic === true) return null;
      const text = textOf(content);
      return text === '' ? null : { offset, at, type: 'user_message', ...clip(text, maxText) };
    }
    case 'result': {
      const subtype = str(message.subtype) ?? 'result';
      const errors = Array.isArray(message.errors) ? message.errors.filter((e) => typeof e === 'string').join('; ') : '';
      return {
        offset,
        at,
        type: 'turn_result',
        subtype,
        is_error: message.is_error === true || subtype !== 'success',
        num_turns: num(message.num_turns),
        duration_ms: num(message.duration_ms),
        total_cost_usd: num(message.total_cost_usd),
        ...clip(str(message.result) ?? errors, maxText),
      };
    }
    default:
      return null;
  }
}
