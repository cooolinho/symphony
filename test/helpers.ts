import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent, AgentRunner, AgentSession, StartSessionParams, TurnResult } from '../src/agent/types.ts';
import type { Clock, Timers, WorkflowSource } from '../src/orchestrator/orchestrator.ts';
import type { WorkspaceIntegration } from '../src/integrations/types.ts';
import type { AgentToolSpec, Issue, TrackerAdapter } from '../src/tracker/types.ts';
import { normalizeStateName, resolveConfig } from '../src/workflow/config.ts';
import type { EffectiveWorkflow, WorkflowLoadError } from '../src/workflow/store.ts';
import { compilePrompt, DEFAULT_CONTINUATION_PROMPT } from '../src/workflow/template.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';

const created: string[] = [];
process.on('exit', () => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fresh temporary directory, removed when the test process exits. */
export function tempDir(prefix = 'symphony-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export async function until(condition: () => boolean, timeoutMs = 3_000, what = 'condition'): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function makeIssue(overrides: Partial<Issue> & { id: string }): Issue {
  return {
    native_ref: null,
    identifier: `acme/app#${overrides.id}`,
    title: `Issue ${overrides.id}`,
    description: null,
    priority: null,
    state: 'Todo',
    branch_name: null,
    url: null,
    assignee_id: null,
    labels: [],
    blocked_by: [],
    dispatchable: true,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: null,
    ...overrides,
  };
}

/** In-memory tracker; tests mutate `issues` to simulate board changes. */
export class FakeTracker implements TrackerAdapter {
  readonly kind = 'github_project';
  issues = new Map<string, Issue>();
  failNext: Error | null = null;
  calls = { byStates: 0, byIds: 0, statusOptions: 0 };
  /** Set to give the tracker a board; adapters without it skip the column check. */
  statusOptions?: () => Promise<string[]>;

  constructor(issues: Issue[] = []) {
    for (const issue of issues) this.issues.set(issue.id, issue);
  }

  set(id: string, patch: Partial<Issue>): void {
    const issue = this.issues.get(id);
    if (issue === undefined) throw new Error(`no issue ${id}`);
    this.issues.set(id, { ...issue, ...patch });
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    this.calls.byStates++;
    this.#maybeFail();
    if (states.length === 0) return [];
    const wanted = new Set(states.map(normalizeStateName));
    return [...this.issues.values()].filter((issue) => wanted.has(normalizeStateName(issue.state)));
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    this.calls.byIds++;
    this.#maybeFail();
    return ids.map((id) => this.issues.get(id)).filter((issue): issue is Issue => issue !== undefined);
  }

  /** Executed `set_status` calls, in order (only those that reached the tracker). */
  statusCalls: string[] = [];

  /** `set_status` moves the session's issue in memory, like the GitHub tool does on the board. */
  agentToolSpecs(): AgentToolSpec[] {
    return [
      {
        name: 'set_status',
        description: 'Move the issue to another column.',
        inputSchema: {},
        mutates: true,
        transitionTarget: (args) => String(args.status),
        execute: async (args, context) => {
          const status = String(args.status);
          const previous = this.issues.get(context.issue.id)?.state ?? context.issue.state;
          this.statusCalls.push(status);
          this.set(context.issue.id, { state: status });
          return { ok: true, data: { previous_status: previous, status } };
        },
      },
    ];
  }

  issueRepository?: (issue: Issue) => string | null;

  #maybeFail(): void {
    if (this.failNext !== null) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
  }
}

export type TurnScript = (turn: number, params: StartSessionParams) => Promise<TurnResult> | TurnResult;

/** Agent runner whose turns are scripted; records every session it starts. */
export class FakeRunner implements AgentRunner {
  sessions: Array<{ params: StartSessionParams; turns: string[]; stopped: boolean }> = [];
  startError: Error | null = null;
  /** Final MCP server statuses the fake sessions report (AgentSession.mcpStatus). */
  mcpStatus: Record<string, string> | undefined;
  script: TurnScript;

  constructor(script: TurnScript = (turn) => ({ ok: true, turnId: String(turn), resultText: 'done' })) {
    this.script = script;
  }

  async startSession(params: StartSessionParams): Promise<AgentSession> {
    if (this.startError !== null) throw this.startError;
    const record = { params, turns: [] as string[], stopped: false };
    this.sessions.push(record);
    const emit = (event: Partial<AgentEvent> & { event: string }) =>
      params.onEvent({ timestamp: new Date(), pid: 4242, threadId: 'thread-1', turnId: null, sessionId: null, turnCount: record.turns.length, ...event });
    emit({ event: 'session_started' });
    emit({ event: 'session_configured', detail: { model: params.config.model ?? 'claude-code-default' } });
    return {
      threadId: 'thread-1',
      pid: 4242,
      ...(this.mcpStatus !== undefined ? { mcpStatus: this.mcpStatus } : {}),
      runTurn: async (prompt) => {
        record.turns.push(prompt);
        const turn = record.turns.length;
        emit({ event: 'turn_started', turnId: String(turn), sessionId: `thread-1-${turn}` });
        return this.script(turn, params);
      },
      stop: async () => {
        record.stopped = true;
      },
    };
  }
}

export class ManualTimers implements Timers {
  #next = 1;
  pending = new Map<number, { callback: () => void; ms: number }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#next++;
    this.pending.set(id, { callback, ms });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  delays(): number[] {
    return [...this.pending.values()].map((timer) => timer.ms);
  }

  /** Fires every pending timer with exactly this delay. */
  fire(ms: number): number {
    let fired = 0;
    for (const [id, timer] of [...this.pending]) {
      if (timer.ms !== ms) continue;
      this.pending.delete(id);
      timer.callback();
      fired++;
    }
    return fired;
  }
}

export class ManualClock implements Clock {
  mono = 1_000;
  wall = new Date('2026-10-03T12:00:00Z').getTime();

  now(): Date {
    return new Date(this.wall);
  }

  monotonicMs(): number {
    return this.mono;
  }

  advance(ms: number): void {
    this.mono += ms;
    this.wall += ms;
  }
}

export function makeWorkflow(
  front: Record<string, unknown>,
  options: { prompt?: string; dir?: string; env?: NodeJS.ProcessEnv; integrations?: readonly WorkspaceIntegration[] } = {},
): EffectiveWorkflow {
  const dir = options.dir ?? tempDir();
  const config = resolveConfig(front, {
    workflowPath: path.join(dir, 'WORKFLOW.md'),
    env: options.env ?? {},
    trackerDefaults,
    ...(options.integrations !== undefined ? { integrations: options.integrations } : {}),
  });
  return {
    definition: { config: front, promptTemplate: options.prompt ?? 'Work on {{ issue.identifier }}' },
    config,
    prompt: compilePrompt(options.prompt ?? 'Work on {{ issue.identifier }}'),
    continuationPrompt: compilePrompt(DEFAULT_CONTINUATION_PROMPT),
    version: 1,
    contentHash: 'test',
    loadedAt: new Date(),
  };
}

export class StaticWorkflow implements WorkflowSource {
  readonly path = '/tmp/WORKFLOW.md';
  current: EffectiveWorkflow;
  lastError: WorkflowLoadError | null = null;

  constructor(workflow: EffectiveWorkflow) {
    this.current = workflow;
  }

  async refreshIfChanged(): Promise<void> {}
}

/** Front matter that passes dispatch validation for the github_project kind. */
export function baseFront(root: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const workspace = (overrides.workspace ?? {}) as Record<string, unknown>;
  return {
    tracker: { kind: 'github_project', provider: { owner: 'acme', project_number: 1, token: 'test-token' } },
    ...overrides,
    workspace: { root, ...workspace },
  };
}
