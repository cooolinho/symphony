import { randomUUID, type UUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  createSdkMcpServer,
  query as sdkQuery,
  tool,
  type CanUseTool,
  type ModelUsage,
  type Options,
  type Query,
  type SandboxSettings,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { ModelTokenUsage } from '../costs/pricing.ts';
import type { Issue, ToolResult } from '../tracker/types.ts';
import { AsyncQueue, settledWithin, sleep, withTimeout } from '../util/async.ts';
import { SymphonyError, errorMessage } from '../util/errors.ts';
import { oneLine, tail, truncate } from '../util/text.ts';
import { forgetProcessGroup, killProcessGroup, processGroupSpawner } from './spawn.ts';
import type { AgentEvent, AgentRunner, AgentSession, StartSessionParams, TokenUsage, TurnResult } from './types.ts';

export type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

/** MCP server name for provider-native tools; the agent sees them as mcp__tracker__<name>. */
export const TRACKER_SERVER = 'tracker';
const ASK_USER_TOOL = 'AskUserQuestion';
const STOP_GRACE_MS = 10_000;
const STDERR_TAIL = 4_000;
const CLIENT_APP = 'symphony/0.1.0';
const MCP_STATUS_POLL_MS = 500;

const NO_HUMAN_ANSWER =
  'Nobody can answer questions in this unattended run. Decide on your own using the issue, the repository and ' +
  'your best judgment. If a decision truly needs a human, explain it in a comment on the issue and move the issue ' +
  'to a status that asks for human attention.';

/** Runs each issue in a Claude Code session through the Claude Agent SDK. */
export class ClaudeAgentRunner implements AgentRunner {
  #query: QueryFn;

  constructor(options: { query?: QueryFn } = {}) {
    this.#query = options.query ?? sdkQuery;
  }

  async startSession(params: StartSessionParams): Promise<AgentSession> {
    const session = new ClaudeSession(params, this.#query);
    await session.start();
    return session;
  }
}

interface PendingTurn {
  turnId: string;
  resolve: (result: TurnResult) => void;
  timer: NodeJS.Timeout | null;
}

export function usageFromModelUsage(modelUsage: Record<string, ModelUsage> | undefined): TokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const usage of Object.values(modelUsage ?? {})) {
    inputTokens += (usage.inputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
    outputTokens += usage.outputTokens ?? 0;
  }
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

/** Per-model session totals from a result message, with uncached input and cache traffic apart. */
export function modelUsageBreakdown(modelUsage: Record<string, ModelUsage> | undefined): Record<string, ModelTokenUsage> {
  const breakdown: Record<string, ModelTokenUsage> = {};
  for (const [model, usage] of Object.entries(modelUsage ?? {})) {
    breakdown[model] = {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: usage.cacheReadInputTokens ?? 0,
      cacheWriteTokens: usage.cacheCreationInputTokens ?? 0,
    };
  }
  return breakdown;
}

function describeResult(result: SDKResultMessage): string {
  if (result.subtype === 'success') return result.is_error ? `turn ended with an error: ${truncate(oneLine(result.result), 500)}` : 'ok';
  const reason: Record<string, string> = {
    error_max_turns: 'Claude Code stopped at its max-turns limit',
    error_max_budget_usd: 'claude.max_budget_usd was exceeded',
    error_during_execution: 'error during execution',
    error_max_structured_output_retries: 'structured output retries exhausted',
  };
  const errors = result.errors.length > 0 ? `: ${truncate(oneLine(result.errors.join('; ')), 500)}` : '';
  return `${reason[result.subtype] ?? result.subtype}${errors}`;
}

function summarizeToolInput(name: string, input: unknown): string {
  const value = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const primary = value.command ?? value.file_path ?? value.path ?? value.pattern ?? value.url ?? value.description;
  const text = typeof primary === 'string' ? primary : JSON.stringify(input ?? {});
  return `${name}: ${truncate(oneLine(text), 160)}`;
}

function toCallToolResult(result: ToolResult): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  const payload = result.ok ? result.data : { error: result.error };
  return { content: [{ type: 'text', text: JSON.stringify(payload ?? null, null, 2) }], isError: !result.ok };
}

function symphonyContext(issue: Issue, toolNames: string[], sections: string[], extra: string | null): string {
  const lines = [
    '# Symphony',
    `You are running unattended under the Symphony orchestrator, working on ${issue.identifier} in a dedicated ` +
      'workspace: the current working directory. Keep all changes inside it.',
    'No human watches this session or can answer questions while it runs. Make reasonable decisions on your own.',
  ];
  if (toolNames.length > 0) {
    lines.push(`Read and update the issue on the tracker with these tools: ${toolNames.join(', ')}.`);
  }
  for (const section of sections) lines.push('', section);
  if (extra !== null) lines.push('', extra);
  return lines.join('\n');
}

class ClaudeSession implements AgentSession {
  readonly threadId: UUID = randomUUID();
  #params: StartSessionParams;
  #queryFn: QueryFn;
  #input = new AsyncQueue<SDKUserMessage>();
  #abort = new AbortController();
  #query: Query | null = null;
  #reader: Promise<void> | null = null;
  #pid: number | null = null;
  #pending: PendingTurn | null = null;
  #turnNumber = 0;
  #turnId: string | null = null;
  #stderr = '';
  #transcript: fs.WriteStream | null = null;
  #ended = false;
  #endReason: string | null = null;
  #cancelReason: string | null = null;
  #initSeen = false;
  #stopped: Promise<void> | null = null;
  #mcpStatus: Record<string, string> | undefined;

  constructor(params: StartSessionParams, queryFn: QueryFn) {
    this.#params = params;
    this.#queryFn = queryFn;
  }

  get pid(): number | null {
    return this.#pid;
  }

  get mcpStatus(): Record<string, string> | undefined {
    return this.#mcpStatus;
  }

  async start(): Promise<void> {
    const { cwd, signal, config } = this.#params;
    if (!path.isAbsolute(cwd) || path.resolve(cwd) !== cwd) {
      throw new SymphonyError('invalid_workspace_cwd', `agent cwd must be an absolute normalized path (got ${cwd})`);
    }
    if (signal.aborted) throw new SymphonyError('turn_cancelled', 'cancelled before the agent started');
    signal.addEventListener('abort', () => this.#cancel(String(signal.reason ?? 'cancelled by the orchestrator')), { once: true });

    this.#openTranscript();
    this.#query = this.#queryFn({ prompt: this.#input, options: this.#options() });
    this.#reader = this.#read(this.#query);

    try {
      await withTimeout(
        this.#query.initializationResult(),
        config.readTimeoutMs,
        () => new SymphonyError('response_timeout', `Claude Code did not finish starting within ${config.readTimeoutMs}ms`),
      );
    } catch (error) {
      const detail = this.#stderr.trim() === '' ? '' : ` (stderr: ${tail(oneLine(this.#stderr), 500)})`;
      const message = `${errorMessage(error)}${detail}`;
      this.#emit('startup_failed', { message });
      await this.stop();
      throw new SymphonyError(error instanceof SymphonyError ? error.code : 'startup_failed', message, { cause: error });
    }
    await this.#settleMcpStatus(this.#query);
    this.#emit('session_started', { message: `Claude Code session ${this.threadId} started`, detail: { cwd } });
  }

  runTurn(prompt: string): Promise<TurnResult> {
    if (this.#pending !== null) return Promise.reject(new Error('a turn is already running on this session'));
    const turnId = String(++this.#turnNumber);
    this.#turnId = turnId;
    if (this.#ended || this.#stopped !== null) {
      return Promise.resolve({ ok: false, turnId, code: 'port_exit', message: this.#endReason ?? 'the agent session has ended' });
    }

    return new Promise<TurnResult>((resolve) => {
      this.#pending = { turnId, resolve, timer: null };
      this.#armTurnTimer();
      this.#emit('turn_started', { message: `turn ${turnId} started` });
      try {
        this.#input.push({
          type: 'user',
          message: { role: 'user', content: prompt },
          parent_tool_use_id: null,
          session_id: this.threadId,
          uuid: randomUUID(),
        });
      } catch (error) {
        this.#settle({ ok: false, turnId, code: 'port_exit', message: errorMessage(error) });
      }
    });
  }

  stop(): Promise<void> {
    this.#stopped ??= (async () => {
      if (this.#pending !== null) {
        this.#settle({ ok: false, turnId: this.#pending.turnId, code: 'turn_cancelled', message: 'session stopped' });
      }
      this.#input.close();
      if (this.#reader !== null && !(await settledWithin(this.#reader, STOP_GRACE_MS))) {
        this.#query?.close();
        await settledWithin(this.#reader, STOP_GRACE_MS);
      }
      // Commands the agent left running belong to this session; end them with it.
      killProcessGroup(this.#pid, 'SIGKILL');
      forgetProcessGroup(this.#pid);
      this.#transcript?.end();
      this.#transcript = null;
    })();
    return this.#stopped;
  }

  #options(): Options {
    const { config, issue, tools, env, cwd, extensions } = this.#params;
    const toolNames = tools.map((spec) => `mcp__${TRACKER_SERVER}__${spec.name}`);
    const extensionServers = Object.keys(extensions?.mcpServers ?? {});
    if (extensionServers.includes(TRACKER_SERVER)) {
      throw new SymphonyError('invalid_session_extensions', `MCP server name "${TRACKER_SERVER}" is reserved`);
    }
    const options: Options = {
      cwd,
      env: { ...env, ...extensions?.env, ...config.env, CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP },
      abortController: this.#abort,
      sessionId: this.threadId,
      title: truncate(`${issue.identifier}: ${issue.title}`, 200),
      permissionMode: config.permissionMode,
      canUseTool: this.#canUseTool,
      // A bare server name allows every tool of that server.
      allowedTools: [...config.allowedTools, ...toolNames, ...extensionServers.map((name) => `mcp__${name}`)],
      disallowedTools: [...new Set([...config.disallowedTools, ASK_USER_TOOL])],
      settingSources: config.settingSources,
      strictMcpConfig: config.strictMcpConfig,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: symphonyContext(issue, toolNames, extensions?.contextSections ?? [], config.appendSystemPrompt),
      },
      persistSession: config.persistSession,
      spawnClaudeCodeProcess: processGroupSpawner({
        onSpawn: (pid) => {
          this.#pid = pid;
        },
        onStderr: (text) => {
          this.#stderr = tail(this.#stderr + text, STDERR_TAIL);
        },
      }),
    };
    if (config.permissionMode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;
    if (config.model !== null) options.model = config.model;
    if (config.fallbackModel !== null) options.fallbackModel = config.fallbackModel;
    if (config.effort !== null) options.effort = config.effort;
    if (config.maxBudgetUsd !== null) options.maxBudgetUsd = config.maxBudgetUsd;
    if (config.sandbox !== null) options.sandbox = config.sandbox as SandboxSettings;
    if (config.executable !== null) options.pathToClaudeCodeExecutable = config.executable;
    if (config.plugins.length > 0) options.plugins = config.plugins.map((plugin) => ({ type: 'local' as const, path: plugin }));
    if (config.skills !== null) options.skills = config.skills;
    if ((extensions?.additionalDirectories.length ?? 0) > 0) options.additionalDirectories = extensions?.additionalDirectories;
    const mcpServers: NonNullable<Options['mcpServers']> = {};
    for (const [name, server] of Object.entries(extensions?.mcpServers ?? {})) {
      mcpServers[name] = { type: 'stdio', command: server.command, args: server.args, ...(server.env ? { env: server.env } : {}) };
    }
    if (tools.length > 0) mcpServers[TRACKER_SERVER] = this.#trackerServer();
    if (Object.keys(mcpServers).length > 0) options.mcpServers = mcpServers;
    return options;
  }

  #trackerServer() {
    const { tools, toolContext } = this.#params;
    return createSdkMcpServer({
      name: TRACKER_SERVER,
      version: '0.1.0',
      alwaysLoad: true,
      tools: tools.map((spec) =>
        tool(spec.name, spec.description, spec.inputSchema, async (args) => {
          const started = Date.now();
          let result: ToolResult;
          try {
            result = await spec.execute(args as Record<string, unknown>, toolContext());
          } catch (error) {
            result = { ok: false, error: { category: 'tool_error', message: errorMessage(error) } };
          }
          this.#emit('tracker_tool', {
            message: result.ok ? `${spec.name} ok` : `${spec.name} failed: ${truncate(result.error.message, 200)}`,
            detail: { tool: spec.name, ok: result.ok, mutates: spec.mutates, duration_ms: Date.now() - started },
          });
          return toCallToolResult(result);
        }),
      ),
    });
  }

  /** Approval policy (docs/agent-claude.md): questions are auto-answered, the rest follows config. */
  #canUseTool: CanUseTool = async (toolName, input, options) => {
    if (toolName === ASK_USER_TOOL) {
      this.#emit('turn_input_required', { message: 'agent asked for user input; answered that no human is available' });
      return { behavior: 'deny', message: NO_HUMAN_ANSWER };
    }
    const detail = { tool: toolName, reason: options.decisionReason ?? null, blocked_path: options.blockedPath ?? null };
    if (this.#params.config.onPermissionRequest === 'approve') {
      this.#emit('approval_auto_approved', { message: `${toolName} approved by policy`, detail });
      return { behavior: 'allow', updatedInput: input };
    }
    this.#emit('approval_denied', { message: `${toolName} denied by policy`, detail });
    return {
      behavior: 'deny',
      message:
        `The orchestrator's permission policy does not allow ${toolName} here and no human can approve it. ` +
        'Use an approach that does not need approval, or record what you need on the issue.',
    };
  };

  async #read(query: Query): Promise<void> {
    try {
      for await (const message of query) {
        this.#record(message);
        if (this.#pending !== null) this.#armTurnTimer();
        this.#handle(message);
      }
      this.#finish(null);
    } catch (error) {
      this.#finish(error);
    }
  }

  #finish(error: unknown): void {
    this.#ended = true;
    const cancelled = this.#abort.signal.aborted;
    const stderr = this.#stderr.trim() === '' ? '' : ` (stderr: ${tail(oneLine(this.#stderr), 500)})`;
    if (cancelled) this.#endReason = this.#cancelReason ?? 'cancelled';
    else if (error !== null) this.#endReason = `agent stream failed: ${errorMessage(error)}${stderr}`;
    else this.#endReason = `Claude Code exited${stderr}`;

    if (this.#pending !== null) {
      const code = cancelled ? 'turn_cancelled' : error !== null ? 'response_error' : 'port_exit';
      this.#settle({ ok: false, turnId: this.#pending.turnId, code, message: this.#endReason });
    }
    if (!cancelled && this.#stopped === null) this.#emit('agent_exited', { message: this.#endReason });
  }

  #handle(message: SDKMessage): void {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') this.#onInit(message);
        else if (message.subtype === 'api_retry') {
          this.#emit('api_retry', {
            message: `API retry ${message.attempt}/${message.max_retries} (${message.error}) in ${message.retry_delay_ms}ms`,
          });
        } else if (message.subtype === 'permission_denied') {
          this.#emit('permission_denied', { message: `${message.tool_name} denied: ${truncate(oneLine(message.message), 200)}` });
        } else {
          this.#emit('notification', { message: `system/${message.subtype}` });
        }
        return;
      case 'assistant':
        this.#onAssistant(message);
        return;
      case 'result':
        this.#onResult(message);
        return;
      case 'rate_limit_event':
        this.#emit('rate_limit', { message: `rate limit ${message.rate_limit_info.status}`, rateLimits: message.rate_limit_info });
        return;
      case 'auth_status':
        if (message.error !== undefined) this.#emit('agent_error', { message: `authentication: ${message.error}` });
        return;
      case 'user':
        this.#emit('tool_result', {});
        return;
      default:
        this.#emit('other_message', { message: message.type });
    }
  }

  #onInit(message: SDKSystemMessage): void {
    if (this.#initSeen) return;
    this.#initSeen = true;
    const requested = this.#params.config.permissionMode;
    if (message.permissionMode !== requested) {
      this.#params.logger.warn('Claude Code is not using the requested permission mode', {
        requested,
        actual: message.permissionMode,
      });
    }
    const tracker = message.mcp_servers.find((server) => server.name === TRACKER_SERVER);
    if (this.#params.tools.length > 0 && tracker?.status !== 'connected') {
      this.#params.logger.warn('tracker tools are not connected in the agent session', { status: tracker?.status ?? 'missing' });
    }
    for (const failure of message.plugin_errors ?? []) {
      this.#params.logger.warn('a Claude Code plugin did not load', { plugin: failure.plugin, type: failure.type, error: failure.message });
    }
    this.#emit('session_configured', {
      message: `model ${message.model}, permission mode ${message.permissionMode}`,
      detail: {
        model: message.model,
        permission_mode: message.permissionMode,
        claude_code_version: message.claude_code_version,
        api_key_source: message.apiKeySource,
        mcp_servers: message.mcp_servers.map((server) => `${server.name}:${server.status}`),
        ...(this.#mcpStatus !== undefined ? { mcp_status: this.#mcpStatus } : {}),
        plugins: (message.plugins ?? []).map((plugin) => plugin.name),
        skills: message.skills?.length ?? 0,
      },
    });
  }

  /**
   * Waits until no MCP server Symphony added is `pending` (stdio servers may take up to MCP_TIMEOUT to
   * connect), claude.read_timeout_ms elapses or the session is aborted. Records the final statuses and
   * warns about servers that did not connect. Never throws.
   */
  async #settleMcpStatus(query: Query): Promise<void> {
    const names = Object.keys(this.#params.extensions?.mcpServers ?? {});
    if (names.length === 0) return;
    const { logger, config } = this.#params;
    const signal = this.#abort.signal;
    const deadline = Date.now() + config.readTimeoutMs;
    const statuses: Record<string, string> = Object.fromEntries(names.map((name) => [name, 'pending']));
    try {
      while (!signal.aborted) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        // Bounded by the deadline and the abort signal: null means no answer in time.
        const answer = query.mcpServerStatus();
        answer.catch(() => undefined);
        const wait = new AbortController();
        const reported = await Promise.race([
          answer,
          sleep(remaining, AbortSignal.any([signal, wait.signal])).then(() => null),
        ]).finally(() => wait.abort());
        if (reported === null) break;
        for (const name of names) statuses[name] = reported.find((server) => server.name === name)?.status ?? 'missing';
        if (!names.some((name) => statuses[name] === 'pending')) break;
        await sleep(Math.min(MCP_STATUS_POLL_MS, deadline - Date.now()), signal);
      }
    } catch (error) {
      if (!signal.aborted) logger.warn('cannot read the MCP server status of the agent session', { error: errorMessage(error) });
    }
    this.#mcpStatus = statuses;
    if (signal.aborted) return;
    for (const [name, status] of Object.entries(statuses)) {
      if (status !== 'connected') {
        logger.warn('an MCP server Symphony added is not connected in the agent session', { server: name, status });
      }
    }
  }

  #onAssistant(message: SDKAssistantMessage): void {
    if (message.error !== undefined) {
      this.#emit('agent_error', { message: `Claude API error: ${message.error}` });
      return;
    }
    for (const block of message.message.content) {
      if (block.type === 'tool_use') {
        this.#emit('tool_use', { message: summarizeToolInput(block.name, block.input) });
        return;
      }
      if (block.type === 'text' && block.text.trim() !== '') {
        this.#emit('assistant_message', { message: truncate(oneLine(block.text), 300) });
        return;
      }
    }
    this.#emit('assistant_message', {});
  }

  #onResult(message: SDKResultMessage): void {
    const succeeded = message.subtype === 'success' && !message.is_error;
    const usage = usageFromModelUsage(message.modelUsage);
    this.#emit(succeeded ? 'turn_completed' : 'turn_failed', {
      message: succeeded ? `turn completed (${message.num_turns} model calls)` : describeResult(message),
      usage,
      modelUsage: modelUsageBreakdown(message.modelUsage),
      costUsd: message.total_cost_usd,
      detail: { subtype: message.subtype, stop_reason: message.stop_reason, duration_ms: message.duration_ms },
    });
    const pending = this.#pending;
    if (pending === null) return;
    if (succeeded) this.#settle({ ok: true, turnId: pending.turnId, resultText: message.subtype === 'success' ? message.result : '' });
    else this.#settle({ ok: false, turnId: pending.turnId, code: 'turn_failed', message: describeResult(message) });
  }

  #armTurnTimer(): void {
    const pending = this.#pending;
    if (pending === null) return;
    if (pending.timer !== null) clearTimeout(pending.timer);
    const timeoutMs = this.#params.config.turnTimeoutMs;
    pending.timer = setTimeout(() => {
      if (this.#pending !== pending) return;
      const message = `no agent output for ${timeoutMs}ms`;
      this.#emit('turn_timeout', { message });
      this.#settle({ ok: false, turnId: pending.turnId, code: 'turn_timeout', message });
      void this.#query?.interrupt().catch(() => undefined);
    }, timeoutMs);
  }

  #settle(result: TurnResult): void {
    const pending = this.#pending;
    if (pending === null) return;
    if (pending.timer !== null) clearTimeout(pending.timer);
    this.#pending = null;
    pending.resolve(result);
  }

  #cancel(reason: string): void {
    if (this.#cancelReason !== null) return;
    this.#cancelReason = reason;
    if (this.#pending !== null) {
      this.#emit('turn_cancelled', { message: reason });
      this.#settle({ ok: false, turnId: this.#pending.turnId, code: 'turn_cancelled', message: reason });
    }
    this.#input.close();
    this.#abort.abort(reason);
  }

  #emit(event: string, fields: Partial<Omit<AgentEvent, 'event' | 'timestamp'>>): void {
    const turnId = this.#turnId;
    this.#params.onEvent({
      event,
      timestamp: new Date(),
      pid: this.#pid,
      threadId: this.threadId,
      turnId,
      sessionId: turnId === null ? null : `${this.threadId}-${turnId}`,
      turnCount: this.#turnNumber,
      ...fields,
    });
  }

  #openTranscript(): void {
    const file = this.#params.transcriptPath;
    if (file === null) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.#transcript = fs.createWriteStream(file, { flags: 'a' });
      this.#transcript.on('error', (error) => {
        this.#params.logger.warn('session transcript write failed; transcript disabled', { error: error.message });
        this.#transcript = null;
      });
    } catch (error) {
      this.#params.logger.warn('cannot open session transcript', { path: file, error: errorMessage(error) });
    }
  }

  #record(message: SDKMessage): void {
    this.#transcript?.write(`${JSON.stringify({ at: new Date().toISOString(), message })}\n`);
  }
}
