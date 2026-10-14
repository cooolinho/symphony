import type { ModelTokenUsage } from '../costs/pricing.ts';
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
  /** Absolute per-model totals for this session so far, keyed by the model id Claude Code reports. */
  modelUsage?: Record<string, ModelTokenUsage>;
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
  | 'response_error'
  | 'session_limit';

/** A turn that failed because the account hit a Claude usage limit. */
export interface SessionLimitInfo {
  window: string | null;
  resetsAt: Date | null;
  source: 'event' | 'message' | null;
  text: string;
  overageDisabledReason: string | null;
}

export type TurnResult =
  | { ok: true; turnId: string; resultText: string }
  | { ok: false; turnId: string; code: TurnFailureCode; message: string; sessionLimit?: SessionLimitInfo };

export interface AgentSession {
  readonly threadId: string;
  readonly pid: number | null;
  /**
   * Final connection status (`connected`, `failed`, `needs-auth`, `disabled`, `pending`, `missing`) of each
   * MCP server from SessionExtensions, settled before startSession resolves; undefined when none was added.
   */
  readonly mcpStatus?: Record<string, string>;
  /** Runs one turn on the live session; resolves (never rejects) when the turn ends. */
  runTurn(prompt: string): Promise<TurnResult>;
  /** Ends the session and its process tree. Safe to call more than once. */
  stop(): Promise<void>;
}

/** An MCP server the agent process starts over stdio. */
export interface StdioServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Tools that run without asking: `'all'` (default) or a list of bare tool names. */
  autoApprove?: string[] | 'all';
  /** Bare tool names removed from the session. */
  deny?: string[];
}

/** Agent-neutral permission inputs for one session; each runner maps them to its own mechanism. */
export interface SessionPolicy {
  /** The session must not change the workspace or publish changes (a policy, not a sandbox). */
  readOnly: boolean;
}

/** Per-workspace additions to a session, e.g. Laravel Boost for a detected Laravel app. */
export interface SessionExtensions {
  /** Extra MCP servers by name; their tool policy is set per server (autoApprove, deny). */
  mcpServers: Record<string, StdioServer>;
  /** Markdown sections appended to the system prompt, before claude.append_system_prompt. */
  contextSections: string[];
  /** Extra directories (absolute) the agent may use; Claude Code loads their .claude/skills at start. */
  additionalDirectories: string[];
  /** Variables added to the agent's environment. */
  env: Record<string, string>;
  /** Extra fields for the `run_started` line of the repository log (e.g. `laravel`, `boost`). */
  historyFields?: Record<string, string>;
  /** What the integrations set up for the session (dashboard, tool attribution); absent when none reported. */
  reports?: IntegrationReport[];
  /** Subagent name prefixes the integrations enable for this workspace (`laravel-`); see WorkspaceIntegration.agentPrefix. */
  agentPrefixes?: string[];
}

/**
 * Status of an integration in a session: ready (available to the agent), unavailable (a part failed or was
 * skipped), absent (the project does not use it) or off (disabled in the workflow).
 */
export type IntegrationStatus = 'ready' | 'unavailable' | 'absent' | 'off';

/** One part of an integration, e.g. one Laravel app of the workspace. */
export interface IntegrationPart {
  /** Display name, e.g. `repository root` or `backend/`. */
  name: string;
  /** Part status as the integration names it (e.g. ready, failed, skipped, absent, off). */
  status: string;
  /** Why the part is not ready; null otherwise. */
  reason: string | null;
  /** Versions of the relevant packages, e.g. `Laravel v13.1.0 · Boost v2.0.1`. */
  versions: string | null;
  /** Where the agent gets the guidelines from, e.g. `CLAUDE.md (loaded by Claude Code)`; null = none. */
  guidelines: string | null;
  /** Skills of this part available to the agent. */
  skills: string[];
  /** MCP server of this part, or null. */
  mcpServer: string | null;
  /** Tools of that server that run without asking. */
  tools: string[];
  /** Problems with the generated files that did not stop the session (e.g. no skills written). */
  warnings: string[];
}

/** What an integration (e.g. Laravel Boost) set up for a session; its MCP servers and skills attribute tool calls to it. */
export interface IntegrationReport {
  /** Stable id, e.g. `laravel-boost`. */
  id: string;
  /** Display name, e.g. `Laravel Boost`. */
  label: string;
  status: IntegrationStatus;
  parts: IntegrationPart[];
  /** Calls of `mcp__<server>__<tool>` for these servers count as the integration's tool calls. */
  mcpServers: string[];
  /** Skill tool calls for these names count as the integration's skill calls. */
  skills: string[];
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
  /** Workspace-specific MCP servers, prompt context and directories (e.g. Laravel Boost). */
  extensions?: SessionExtensions;
  /** Permission policy; absent means not read-only. */
  policy?: SessionPolicy;
  /** Subagents (`subagent_type`, e.g. `symphony:laravel-architect`) the session must not start. */
  deniedAgents?: string[];
  /** Upper bound for one call of a Symphony tool (it may run an entry check); absent = the agent's default. */
  toolTimeoutMs?: number;
}

export interface AgentRunner {
  /** Launches the agent and completes the startup handshake; throws a SymphonyError on failure. */
  startSession(params: StartSessionParams): Promise<AgentSession>;
}
