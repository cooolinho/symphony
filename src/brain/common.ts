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

/** A call without `purpose` leaves a warning (the access log records it as an empty string, see `purposeOf`). */
export function warnPurpose(logger: Logger, tool: string, args: Record<string, unknown>, context: AgentToolContext): void {
  const purpose = args.purpose;
  if (typeof purpose === 'string' && purpose.trim() !== '') return;
  logger.warn('brain tool called without purpose', { tool, issue: context.issue.identifier });
}

/** The trimmed `purpose` argument; empty when missing. */
export function purposeOf(args: Record<string, unknown>): string {
  return typeof args.purpose === 'string' ? args.purpose.trim() : '';
}

/** Why a result was rejected: `details.reason` when it is a string, else the error category; undefined for ok. */
export function reasonOf(result: ToolResult): string | undefined {
  if (result.ok) return undefined;
  const reason = (result.error.details as { reason?: unknown } | undefined)?.reason;
  return typeof reason === 'string' ? reason : result.error.category;
}
