import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import type { AgentEvent, AgentRunner, AgentSession, StartSessionParams, TurnResult } from '../src/agent/types.ts';
import type { Clock, Timers, WorkflowSource } from '../src/orchestrator/orchestrator.ts';
import type { WorkspaceIntegration } from '../src/integrations/types.ts';
import { isCreatableLabel } from '../src/tracker/github-project/labels.ts';
import type {
  AddLabelsResult,
  AgentToolSpec,
  AutoMergeResult,
  BranchPullRequest,
  Issue,
  IssueComment,
  MergeWatch,
  PostedComment,
  RemoveLabelsResult,
  StatusChange,
  ToolResult,
  TrackedResult,
  TrackerAdapter,
} from '../src/tracker/types.ts';
import { decodeMarker } from '../src/workflow/results.ts';
import { normalizeStateName, resolveConfig } from '../src/workflow/config.ts';
import type { EffectiveWorkflow, WorkflowLoadError } from '../src/workflow/store.ts';
import { compilePrompt, DEFAULT_CONTINUATION_PROMPT } from '../src/workflow/template.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { createFakeDocument, FakeElement, parseHtml } from './helpers/fake-dom.ts';

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
  calls = { byStates: 0, byIds: 0, statusOptions: 0, readResults: 0 };
  /** Set to give the tracker a board; adapters without it skip the column check. */
  statusOptions?: () => Promise<string[]>;
  /** Set to report open sub-issues (roles with wait_for_sub_issues); trackers without it have none. */
  openSubIssues?: (issue: Issue) => string[];
  /** Set to record the notices Symphony posts on an issue; trackers without it cannot comment. */
  commentOnIssue?: (issue: Issue, body: string) => Promise<void>;
  /** Set to give the tracker issues that wait for pull request checks before auto_merge. */
  mergeWatch?: () => MergeWatch | null;
  /** Set to report the open pull request of the issue's branch; trackers without it have none. */
  branchPullRequest?: (issue: Issue) => Promise<BranchPullRequest | null>;
  /** Set to make entering a column run `auto_merge`: its result is part of the move, undefined = no merge. */
  autoMerge?: (issue: Issue, column: string) => AutoMergeResult | undefined;

  constructor(issues: Issue[] = []) {
    for (const issue of issues) this.issues.set(issue.id, issue);
  }

  /**
   * Changes an issue like the board would. A change of column, by Symphony or by a test acting as a human, stamps
   * `native_ref.status_updated_at` like GitHub's Status field.
   */
  set(id: string, patch: Partial<Issue>): void {
    const issue = this.issues.get(id);
    if (issue === undefined) throw new Error(`no issue ${id}`);
    const next = { ...issue, ...patch };
    if (patch.state !== undefined && normalizeStateName(patch.state) !== normalizeStateName(issue.state)) {
      next.native_ref = { ...next.native_ref, status_updated_at: this.#next(id).toISOString() };
    }
    this.issues.set(id, next);
  }

  /** The board's clock for one issue: one second after its latest comment and its latest column change. */
  #next(id: string): Date {
    const moved = this.issues.get(id)?.native_ref?.status_updated_at;
    const times = [Date.UTC(2026, 0, 1), ...(this.comments.get(id) ?? []).map((comment) => comment.createdAt.getTime())];
    if (typeof moved === 'string') times.push(Date.parse(moved));
    return new Date(Math.max(...times) + 1000);
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

  /** Comments by issue id, oldest first; `postComment` appends. */
  comments = new Map<string, IssueComment[]>();
  /** Login `viewerLogin` reports and `postComment` writes as the author. */
  viewer = 'symphony-bot';
  /** Labels the repository has (any case); `addLabels` only adds these, or creates the pipeline's families. */
  repositoryLabels = new Set<string>();

  async readComments(issue: Issue): Promise<IssueComment[]> {
    return [...(this.comments.get(issue.id) ?? [])];
  }

  /** Set to make `readResults` fail, `failReadResultsTimes` times in a row. */
  failReadResults: Error | null = null;
  failReadResultsTimes = 1;

  /** Like the GitHub adapter: the markers in the viewer's own comments, oldest first. */
  async readResults(issue: Issue): Promise<TrackedResult[]> {
    this.calls.readResults++;
    if (this.failReadResults !== null) {
      const error = this.failReadResults;
      if (--this.failReadResultsTimes <= 0) {
        this.failReadResults = null;
        this.failReadResultsTimes = 1;
      }
      throw error;
    }
    const results: TrackedResult[] = [];
    for (const comment of this.comments.get(issue.id) ?? []) {
      const decoded = comment.author === this.viewer ? decodeMarker(comment.body) : null;
      if (decoded !== null) results.push({ ...decoded, createdAt: comment.createdAt, url: comment.url });
    }
    return results;
  }

  async viewerLogin(): Promise<string> {
    return this.viewer;
  }

  async postComment(issue: Issue, body: string): Promise<PostedComment> {
    const list = this.comments.get(issue.id) ?? [];
    const url = `https://github.com/acme/app/issues/${issue.id}#issuecomment-${list.length + 1}`;
    list.push({ author: this.viewer, createdAt: this.#next(issue.id), body, url });
    this.comments.set(issue.id, list);
    return { url };
  }

  /** Moves the session's issue in memory, like the GitHub adapter does on the board. */
  async setStatus(issue: Issue, column: string): Promise<StatusChange> {
    const previous = this.issues.get(issue.id)?.state ?? issue.state;
    this.statusCalls.push(column);
    const merge = this.autoMerge?.(issue, column);
    this.set(issue.id, { state: merge?.status ?? column });
    return { previous, status: merge?.status ?? column, ...(merge !== undefined ? { autoMerge: merge } : {}) };
  }

  async addLabels(issue: Issue, names: string[], { create = false }: { create?: boolean } = {}): Promise<AddLabelsResult> {
    const result: AddLabelsResult = { added: [], created: [], unknown: [] };
    for (const name of names) {
      const exists = this.#hasLabel(name);
      if (!exists && !(create && isCreatableLabel(name))) {
        result.unknown.push(name);
        continue;
      }
      if (!exists) {
        this.repositoryLabels.add(name);
        result.created.push(name);
      }
      result.added.push(name);
    }
    const current = this.issues.get(issue.id)?.labels ?? issue.labels;
    this.set(issue.id, { labels: [...new Set([...current, ...result.added.map((name) => name.toLowerCase())])] });
    return result;
  }

  async removeLabels(issue: Issue, names: string[]): Promise<RemoveLabelsResult> {
    const result: RemoveLabelsResult = { removed: [], unknown: [] };
    for (const name of names) (this.#hasLabel(name) ? result.removed : result.unknown).push(name);
    const gone = new Set(result.removed.map((name) => name.toLowerCase()));
    this.set(issue.id, { labels: (this.issues.get(issue.id)?.labels ?? issue.labels).filter((label) => !gone.has(label)) });
    return result;
  }

  #hasLabel(name: string): boolean {
    return [...this.repositoryLabels].some((label) => label.toLowerCase() === name.toLowerCase());
  }

  agentToolSpecs(): AgentToolSpec[] {
    return [
      {
        name: 'set_status',
        description: 'Move the issue to another column.',
        inputSchema: {},
        mutates: true,
        transitionTarget: (args) => String(args.status),
        execute: async (args, context) => {
          const change = await this.setStatus(context.issue, String(args.status));
          return { ok: true, data: { previous_status: change.previous, status: change.status, ...(change.autoMerge !== undefined ? { auto_merge: change.autoMerge } : {}) } };
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

/**
 * Calls the session tool `name` from a FakeRunner script the way the agent does: the tools the session got (wrapped by
 * the transition guard) with the session's current tool context. Throws when the session has no such tool.
 */
export async function callTool(params: StartSessionParams, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = params.tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`the session has no tool ${name} (it has ${params.tools.map((candidate) => candidate.name).join(', ') || 'none'})`);
  return tool.execute(args, params.toolContext());
}

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
        const result = await this.script(turn, params);
        // Like the Claude runner, a successful turn reports turn_completed (without ids, so a script's own events stay authoritative).
        if (result.ok) emit({ event: 'turn_completed', threadId: null, turnId: null, sessionId: null });
        return result;
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
  options: {
    prompt?: string;
    /** The files `prompt` includes, as `WorkflowDefinition.partials` (the shipped prompt: its roles/*.md). */
    partials?: Record<string, string>;
    dir?: string;
    env?: NodeJS.ProcessEnv;
    integrations?: readonly WorkspaceIntegration[];
  } = {},
): EffectiveWorkflow {
  const dir = options.dir ?? tempDir();
  const config = resolveConfig(front, {
    workflowPath: path.join(dir, 'WORKFLOW.md'),
    env: options.env ?? {},
    trackerDefaults,
    ...(options.integrations !== undefined ? { integrations: options.integrations } : {}),
  });
  return {
    definition: { config: front, promptTemplate: options.prompt ?? 'Work on {{ issue.identifier }}', partials: options.partials ?? {} },
    config,
    prompt: compilePrompt(options.prompt ?? 'Work on {{ issue.identifier }}', options.partials),
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

// ---------------------------------------------------------------------------------------------------------------
// Dashboard pages in a fake DOM

/** The contents of the inline <script> blocks of a served page. */
export function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] as string);
}

/** The page with the indentation of every inline script changed (behaviour must not depend on it). */
export function reindentScripts(html: string): string {
  return html.replace(/<script>([\s\S]*?)<\/script>/g, (_all, code: string) => `<script>${code.replace(/^( *)/gm, (_m, sp: string) => '\t' + sp + sp)}</script>`);
}

export interface RenderOptions {
  /** Page URL; the agent page needs `http://127.0.0.1/issue?id=acme%2Fapp%231`. */
  url?: string;
  /** Answers every fetch with this JSON body (status 200); throwing rejects the fetch. Without it fetches never settle. */
  fetch?: (url: string, init: { method: string; body?: unknown }) => unknown;
  /** Answer of confirm(); default true. */
  confirm?: boolean;
  /** document.referrer of the page; default ''. */
  referrer?: string;
  /** history.length; default 1. */
  historyLength?: number;
  /** The frozen clock (ms); default 2026-10-30T12:00:00Z. */
  now?: number;
}

export interface RenderedPage {
  document: ReturnType<typeof createFakeDocument>;
  root: FakeElement;
  /** The element with this id; throws when the page has none. */
  $(id: string): FakeElement;
  query(selector: string): FakeElement[];
  /** Calls the page's render hook again with another state (a refresh). */
  render(state: unknown): void;
  /** Click that bubbles up to the document. */
  click(el: FakeElement): void;
  fetches: Array<{ url: string; method: string; body?: unknown }>;
  /** The page's setInterval(fn, ms) calls (the timers never fire on their own). */
  intervals: Array<{ fn: () => unknown; ms: number }>;
  confirms: string[];
  /** Number of history.back() calls. */
  backs: number;
}

/**
 * Loads the inline scripts of a served page into a vm with a fake DOM parsed from the page (frozen clock, no-op
 * timers, recording fetch and confirm), then renders `state` through the page's window.__render hook.
 */
export function renderPage(html: string, state?: unknown, opts: RenderOptions = {}): RenderedPage {
  const root = parseHtml(html);
  const document = createFakeDocument(root);
  const fetches: RenderedPage['fetches'] = [];
  const confirms: string[] = [];
  const url = new URL(opts.url ?? 'http://127.0.0.1/');
  const location: Record<string, unknown> = {};
  const setLocation = (u: URL) => Object.assign(location, { href: u.href, origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash, host: u.host, hostname: u.hostname, protocol: u.protocol });
  setLocation(url);
  const store = new Map<string, string>();
  let timerId = 0;
  const timer = () => ++timerId;
  const intervals: RenderedPage['intervals'] = [];
  const sandbox: Record<string, unknown> = {
    document,
    location,
    history: { length: opts.historyLength ?? 1, back: () => { page.backs++; }, replaceState: (_s: unknown, _t: string, u?: string) => u && setLocation(new URL(u, url)), pushState: () => {} },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: unknown) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k) },
    setTimeout: timer,
    setInterval: (fn: () => unknown, ms: number) => (intervals.push({ fn, ms }), ++timerId),
    clearTimeout: () => {},
    clearInterval: () => {},
    requestAnimationFrame: timer,
    confirm: (question: string) => (confirms.push(question), opts.confirm ?? true),
    addEventListener: () => {},
    removeEventListener: () => {},
    Element: FakeElement,
    Node: FakeElement,
    HTMLElement: FakeElement,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    innerWidth: 1280,
    innerHeight: 800,
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    fetch: (target: string, init: { method?: string; body?: string } = {}) => {
      const body = init.body === undefined ? undefined : (JSON.parse(init.body) as unknown);
      fetches.push({ url: String(target), method: init.method ?? 'GET', ...(body === undefined ? {} : { body }) });
      if (!opts.fetch) return new Promise(() => {});
      try {
        const json = opts.fetch(String(target), { method: init.method ?? 'GET', body });
        return Promise.resolve({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json), headers: { get: () => null } });
      } catch (error) {
        return Promise.reject(error);
      }
    },
    URL,
    URLSearchParams,
    AbortController,
    console,
    __SYMPHONY_TEST__: true,
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  const now = opts.now ?? Date.parse('2026-10-30T12:00:00Z');
  vm.runInContext(
    `(() => { const Real = Date; class Frozen extends Real { constructor(...a) { if (a.length) super(...a); else super(${now}); } static now() { return ${now}; } } globalThis.Date = Frozen; let seed = 12345; Math.random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648); })();`,
    ctx,
  );
  const scripts = inlineScripts(html);
  assert.ok(scripts.length > 0, 'the page has inline scripts');
  scripts.forEach((code, i) => vm.runInContext(code, ctx, { filename: `page-script-${i}.js` }));
  document.referrer = opts.referrer ?? '';
  const render = (next: unknown): void => {
    const hook = (ctx as { __render?: (s: unknown) => void }).__render;
    assert.equal(typeof hook, 'function', 'the page exposes window.__render under __SYMPHONY_TEST__');
    hook!(next);
  };
  if (state !== undefined) render(state);
  const page: RenderedPage = {
    backs: 0,
    document,
    root,
    $: (id) => {
      const found = document.getElementById(id) as FakeElement | null;
      assert.ok(found, `the page has no element #${id}`);
      return found;
    },
    query: (selector) => root.querySelectorAll(selector),
    render,
    click: (el) => el.dispatch('click', { bubbles: true, button: 0 }),
    fetches,
    intervals,
    confirms,
  };
  return page;
}
