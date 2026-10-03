import type { Logger } from '../log.ts';
import type { AgentToolContext, AgentToolSpec, Issue } from '../tracker/types.ts';
import type { ClaudeConfig } from '../workflow/config.ts';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Structured update sent from a live agent session to the orchestrator (spec 10.4). */
export interface AgentEvent {
  event: string;
  timestamp: Date;
  pid: number | null;
  threadId: string | null;
  turnId: string | null;
  /** `<thread_id>-<turn_id>` once a turn has started. */
  sessionId: string | null;
  turnCount: number;
  /** Short human-readable summary for status surfaces. */
  message?: string;
  /** Absolute totals for this session so far (not deltas). */
  usage?: TokenUsage;
  /** Absolute estimated cost for this session so far, in USD. */
  costUsd?: number;
  rateLimits?: unknown;
  detail?: Record<string, unknown>;
}

export type TurnFailureCode =
  | 'turn_failed'
  | 'turn_cancelled'
  | 'turn_timeout'
  | 'turn_input_required'
  | 'port_exit'
  | 'response_error';

export type TurnResult =
  | { ok: true; turnId: string; resultText: string }
  | { ok: false; turnId: string; code: TurnFailureCode; message: string };

export interface AgentSession {
  readonly threadId: string;
  readonly pid: number | null;
  /** Runs one turn on the live session; resolves (never rejects) when the turn ends. */
  runTurn(prompt: string): Promise<TurnResult>;
  /** Ends the session and its process tree. Safe to call more than once. */
  stop(): Promise<void>;
}

export interface StartSessionParams {
  /** Absolute per-issue workspace path; the agent process runs here. */
  cwd: string;
  issue: Issue;
  config: ClaudeConfig;
  tools: AgentToolSpec[];
  /** Current tool context (the latest issue snapshot), read on every tool call. */
  toolContext: () => AgentToolContext;
  /** Child environment, already stripped of tracker secrets. */
  env: NodeJS.ProcessEnv;
  logger: Logger;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  /** JSONL file receiving every raw agent message, or null. */
  transcriptPath: string | null;
}

export interface AgentRunner {
  /** Launches the agent and completes the startup handshake; throws a SymphonyError on failure. */
  startSession(params: StartSessionParams): Promise<AgentSession>;
}
