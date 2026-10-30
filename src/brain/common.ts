import { createHash } from 'node:crypto';
import type { Logger } from '../log.ts';
import type { AgentToolContext, ToolResult } from '../tracker/types.ts';

export const MAX_NOTE_BYTES = 1024 * 1024;

export function hashOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

export function fail(category: string, message: string): ToolResult {
  return { ok: false, error: { category, message } };
}

/** Access log comes with E7-4; until then a call without `purpose` only leaves a warning. */
export function warnPurpose(logger: Logger, tool: string, args: Record<string, unknown>, context: AgentToolContext): void {
  const purpose = args.purpose;
  if (typeof purpose === 'string' && purpose.trim() !== '') return;
  logger.warn('brain tool called without purpose', { tool, issue: context.issue.identifier });
}
