import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseNote } from '../src/brain/note.ts';
import { ensureVault } from '../src/brain/vault.ts';
import { PricingStore } from '../src/costs/pricing.ts';
import { HistoryLog, readHistory } from '../src/history/history.ts';
import type { IntegrationReport } from '../src/agent/types.ts';
import type { WorkspaceIntegration } from '../src/integrations/types.ts';
import { Logger } from '../src/log.ts';
import { limitScopeOf } from '../src/agent/rate-limit.ts';
import { CONTINUATION_DELAY_MS, SESSION_LIMIT_MAX_WAIT_MS, failureBackoffMs, sessionLimitWaitMs, sortForDispatch } from '../src/orchestrator/eligibility.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { runtimeStateFile } from '../src/orchestrator/runtime-state.ts';
import type { AgentToolSpec, ToolResult } from '../src/tracker/types.ts';
import { dryRunPlan, planLines } from '../src/service.ts';
import { decodeMarker, parseResult, renderResultComment, type ResultMeta } from '../src/workflow/results.ts';
import { compilePrompt } from '../src/workflow/template.ts';
import { workspaceKey } from '../src/workspace/manager.ts';
import {
  FakeRunner,
  FakeTracker,
  ManualClock,
  ManualTimers,
  StaticWorkflow,
  baseFront,
  callTool,
  makeIssue,
  makeWorkflow,
  tempDir,
  until,
} from './helpers.ts';

interface Setup {
  orchestrator: Orchestrator;
  tracker: FakeTracker;
  runner: FakeRunner;
  timers: ManualTimers;
  clock: ManualClock;
  root: string;
  workflow: StaticWorkflow;
}

function setup(
  options: {
    issues?: ReturnType<typeof makeIssue>[];
    front?: Record<string, unknown>;
    runner?: FakeRunner;
    prompt?: string;
    logger?: Logger;
    integrations?: WorkspaceIntegration[];
    history?: HistoryLog;
    logDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Setup {
  const root = tempDir();
  const tracker = new FakeTracker(options.issues ?? []);
  const runner = options.runner ?? new FakeRunner();
  const timers = new ManualTimers();
  const clock = new ManualClock();
  const workflow = new StaticWorkflow(
    makeWorkflow(baseFront(root, options.front), {
      ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
      ...(options.integrations !== undefined ? { integrations: options.integrations } : {}),
    }),
  );
  const orchestrator = new Orchestrator({
    workflow,
    runner,
    logger: options.logger ?? Logger.silent(),
    env: options.env ?? {},
    logDir: options.logDir ?? null,
    clock,
    timers,
    createAdapter: () => tracker,
    ...(options.integrations !== undefined ? { integrations: options.integrations } : {}),
    ...(options.history !== undefined ? { history: options.history } : {}),
  });
  return { orchestrator, tracker, runner, timers, clock, root, workflow };
}

const snapshot = (s: Setup) => s.orchestrator.snapshot();

describe('dispatch ordering and eligibility', () => {
  it('sorts by priority 1-4, then oldest creation, then identifier', () => {
    const sorted = sortForDispatch([
      makeIssue({ id: 'none', priority: null, created_at: new Date('2020-01-01') }),
      makeIssue({ id: 'p9', priority: 9, created_at: new Date('2019-01-01') }),
      makeIssue({ id: 'p2-new', priority: 2, created_at: new Date('2026-02-01') }),
      makeIssue({ id: 'p2-old', priority: 2, created_at: new Date('2026-01-01') }),
      makeIssue({ id: 'p1', priority: 1, created_at: null }),
    ]);
    assert.deepEqual(sorted.map((i) => i.id), ['p1', 'p2-old', 'p2-new', 'p9', 'none']);
  });

  it('computes failure backoff from 10s, doubling, capped', () => {
    assert.deepEqual([1, 2, 3, 4].map((a) => failureBackoffMs(a, 300_000)), [10_000, 20_000, 40_000, 80_000]);
    assert.equal(failureBackoffMs(10, 300_000), 300_000);
    assert.equal(failureBackoffMs(3, 15_000), 15_000);
  });

  it('computes the wait for a session limit reset plus a 60s buffer', () => {
    const now = new Date('2026-10-03T12:00:00Z');
    const at = (ms: number) => new Date(now.getTime() + ms);
    assert.equal(sessionLimitWaitMs(at(2 * 3600_000), now), 2 * 3600_000 + 60_000);
    assert.equal(sessionLimitWaitMs(at(-3600_000), now), 60_000);
    assert.equal(sessionLimitWaitMs(now, now), 60_000);
    assert.equal(sessionLimitWaitMs(at(SESSION_LIMIT_MAX_WAIT_MS), now), SESSION_LIMIT_MAX_WAIT_MS + 60_000);
    assert.equal(sessionLimitWaitMs(at(SESSION_LIMIT_MAX_WAIT_MS + 1), now), null);
    assert.equal(sessionLimitWaitMs(null, now), null);
    assert.equal(sessionLimitWaitMs(new Date('nope'), now), null);
  });

  it('dispatches in priority order up to the concurrency limit, skipping ineligible issues', async () => {
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const s = setup({
      runner,
      front: { agent: { max_concurrent_agents: 2 }, tracker: { kind: 'github_project', required_labels: ['ai'], provider: { owner: 'acme', project_number: 1, token: 't' } } },
      issues: [
        makeIssue({ id: 'low', priority: 3, labels: ['ai'] }),
        makeIssue({ id: 'high', priority: 1, labels: ['ai'] }),
        makeIssue({ id: 'blocked', priority: 1, labels: ['ai'], dispatchable: false }),
        makeIssue({ id: 'unlabeled', priority: 1 }),
        makeIssue({ id: 'later', priority: 4, labels: ['AI'] }),
        makeIssue({ id: 'done', priority: 1, labels: ['ai'], state: 'Done' }),
      ],
    });
    await s.orchestrator.tickNow();
    await until(() => runner.sessions.length === 2, 3_000, 'two sessions');
    // Running rows keep dispatch order; session start order depends on filesystem timing.
    assert.deepEqual(snapshot(s).running.map((r) => r.issue_id), ['high', 'low']);
  });

  it('runs each issue on the model its "Model:" label names, else on claude.model', async () => {
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const s = setup({
      runner,
      front: { claude: { model: 'opus', fallback_model: 'sonnet' } },
      issues: [
        makeIssue({ id: 'labeled', labels: ['bug', 'model: sonnet'] }),
        makeIssue({ id: 'plain', labels: ['bug'] }),
        makeIssue({ id: 'unknown', labels: ['model: gpt-4'] }),
      ],
    });
    await s.orchestrator.tickNow();
    await until(() => runner.sessions.length === 3, 3_000, 'three sessions');
    const configs = Object.fromEntries(runner.sessions.map((session) => [session.params.issue.id, session.params.config]));
    assert.deepEqual(
      Object.fromEntries(Object.entries(configs).map(([id, config]) => [id, [config.model, config.fallbackModel]])),
      { labeled: ['sonnet', null], plain: ['opus', 'sonnet'], unknown: ['opus', 'sonnet'] },
    );
    const models = Object.fromEntries(snapshot(s).running.map((row) => [row.issue_id, row.model]));
    assert.deepEqual(models, { labeled: 'sonnet', plain: 'opus', unknown: 'opus' });
  });

  it('runs each issue at the effort its "Effort:" label names, else on claude.effort', async () => {
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const s = setup({
      runner,
      front: { claude: { model: 'opus', effort: 'medium' } },
      issues: [
        makeIssue({ id: 'labeled', labels: ['bug', 'effort: high'] }),
        makeIssue({ id: 'plain', labels: ['bug'] }),
        makeIssue({ id: 'unknown', labels: ['effort: hi'] }),
        makeIssue({ id: 'conflict', labels: ['effort: low', 'effort: max'] }),
        makeIssue({ id: 'both', labels: ['model: sonnet', 'Effort: LOW'] }),
      ],
    });
    await s.orchestrator.tickNow();
    await until(() => runner.sessions.length === 5, 3_000, 'five sessions');
    const configs = Object.fromEntries(runner.sessions.map((session) => [session.params.issue.id, session.params.config]));
    assert.deepEqual(
      Object.fromEntries(Object.entries(configs).map(([id, config]) => [id, [config.model, config.effort]])),
      {
        labeled: ['opus', 'high'],
        plain: ['opus', 'medium'],
        unknown: ['opus', 'medium'],
        conflict: ['opus', 'medium'],
        both: ['sonnet', 'low'],
      },
    );
  });

  it('runs without an effort when neither a label nor the config names one', async () => {
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const s = setup({ runner, issues: [makeIssue({ id: 'plain' }), makeIssue({ id: 'labeled', labels: ['effort: xhigh'] })] });
    await s.orchestrator.tickNow();
    await until(() => runner.sessions.length === 2, 3_000, 'two sessions');
    const efforts = Object.fromEntries(runner.sessions.map((session) => [session.params.issue.id, session.params.config.effort]));
    assert.deepEqual(efforts, { plain: null, labeled: 'xhigh' });
  });

  it('honours per-state concurrency limits', async () => {
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const s = setup({
      runner,
      front: { agent: { max_concurrent_agents_by_state: { todo: 1 } } },
      issues: [makeIssue({ id: 'a' }), makeIssue({ id: 'b' }), makeIssue({ id: 'c', state: 'In Progress' })],
    });
    await s.orchestrator.tickNow();
    await until(() => runner.sessions.length === 2, 3_000, 'two sessions');
    assert.deepEqual(snapshot(s).running.map((r) => r.issue_id).sort(), ['a', 'c']);
  });
});

describe('workspace integrations', () => {
  it('hands the session the extensions of an injected integration', async () => {
    const seen: Array<{ config: unknown; workspacePath: string }> = [];
    const fake: WorkspaceIntegration<{ greeting: string }> = {
      id: 'fake',
      configKey: 'fake_section',
      resolveConfig: (raw) => ({ config: { greeting: String(raw.greeting ?? 'none') }, errors: [], warnings: [] }),
      prepare: async (config, ctx) => {
        seen.push({ config, workspacePath: ctx.workspacePath });
        return { mcpServers: {}, contextSections: [`fake says ${config.greeting}`], additionalDirectories: ['/fake'], env: { FAKE: '1' } };
      },
    };
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const s = setup({ runner, front: { fake_section: { greeting: 'hello' } }, integrations: [fake], issues: [makeIssue({ id: 'a' })] });
    assert.deepEqual(s.workflow.current.config.integrations, { fake: { greeting: 'hello' } });
    assert.deepEqual(s.workflow.current.config.warnings, []);
    await s.orchestrator.tickNow();
    await until(() => runner.sessions.length === 1, 3_000, 'one session');
    assert.deepEqual(runner.sessions[0]!.params.extensions, {
      mcpServers: {},
      contextSections: ['fake says hello'],
      additionalDirectories: ['/fake'],
      env: { FAKE: '1' },
    });
    assert.deepEqual(seen.map((entry) => entry.config), [{ greeting: 'hello' }]);
    assert.equal(seen[0]!.workspacePath, runner.sessions[0]!.params.cwd);
  });

  it('shows the running and finished subagents of a running issue', async () => {
    let live: unknown = null;
    let s: Setup | null = null;
    const runner = new FakeRunner((turn, params) => {
      const send = (event: string, fields: Record<string, unknown>) =>
        (params.onEvent as (event: unknown) => void)({ event, timestamp: new Date(), pid: 1, threadId: 't', turnId: '1', sessionId: 't-1', turnCount: 1, ...fields });
      const run = (id: string, status: string, tokens: number, endedAt: Date | null) => ({
        toolUseId: id,
        subagentType: 'Explore',
        description: 'Find files',
        startedAt: new Date('2026-01-01T10:00:00Z'),
        endedAt,
        status,
        tokens: { inputTokens: tokens, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
      });
      send('tool_use', { detail: { tool: 'Agent', agent: 'Explore' } });
      send('subagent', { subagent: run('a', 'running', 0, null) });
      send('subagent', { subagent: run('b', 'running', 0, null) });
      send('subagent', { subagent: run('a', 'running', 5, null) });
      send('subagent', { subagent: run('a', 'ok', 5, new Date('2026-01-01T10:01:00Z')) });
      live = s?.orchestrator.snapshot().running[0];
      s?.tracker.set('a', { state: 'In review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    });
    s = setup({ runner, issues: [makeIssue({ id: 'a' })] });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s!).running.length === 0 && runner.sessions.length === 1, 3_000, 'run finished');
    const row = live as { agent_calls: unknown; subagents: { running: Array<{ tool_use_id: string }>; finished: unknown[] } };
    assert.deepEqual(row.agent_calls, { Explore: 1 });
    assert.deepEqual(row.subagents.running.map((run) => run.tool_use_id), ['b']);
    assert.deepEqual(row.subagents.finished, [
      {
        tool_use_id: 'a',
        subagent_type: 'Explore',
        description: 'Find files',
        status: 'ok',
        started_at: '2026-01-01T10:00:00.000Z',
        ended_at: '2026-01-01T10:01:00.000Z',
        tokens: { input_tokens: 5, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4, total_tokens: 14 },
      },
    ]);
  });

  it('attributes MCP tool and skill calls to the reports of the integrations', async () => {
    const report: IntegrationReport = {
      id: 'laravel-boost',
      label: 'Laravel Boost',
      status: 'ready',
      parts: [{ name: '(repository root)', status: 'ready', reason: null, versions: 'Laravel v13.1.0', guidelines: 'CLAUDE.md (loaded by Claude Code)', skills: ['pest-testing', 'livewire-development'], mcpServer: 'laravel-boost', tools: ['search-docs'], warnings: [] }],
      mcpServers: ['laravel-boost'],
      skills: ['livewire-development', 'pest-testing'],
    };
    const fake: WorkspaceIntegration<object> = {
      id: 'fake',
      configKey: 'fake_section',
      resolveConfig: () => ({ config: {}, errors: [], warnings: [] }),
      prepare: async () => ({ mcpServers: {}, contextSections: [], additionalDirectories: [], env: {}, historyFields: { boost: 'ready' }, reports: [report] }),
    };
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
    const history = new HistoryLog(path.join(dir, 'repositories'), new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent()), Logger.silent());
    const emit = (params: { onEvent: (event: never) => void }, event: string, detail: Record<string, unknown>) =>
      (params.onEvent as (event: unknown) => void)({ event, timestamp: new Date(), pid: 1, threadId: 't', turnId: '1', sessionId: 't-1', turnCount: 1, message: event, detail });
    let live: unknown = null;
    let s: Setup | null = null;
    const runner = new FakeRunner((turn, params) => {
      emit(params, 'session_configured', { model: 'opus', skill_names: ['pest-testing', 'symphony:handoff'] });
      emit(params, 'tool_use', { tool: 'mcp__laravel-boost__search-docs' });
      emit(params, 'tool_use', { tool: 'mcp__laravel-boost__search-docs' });
      emit(params, 'tool_use', { tool: 'mcp__tracker__set_status' });
      emit(params, 'tool_use', { tool: 'Skill', skill: 'pest-testing' });
      emit(params, 'tool_use', { tool: 'Skill', skill: 'symphony:handoff' });
      emit(params, 'tool_use', { tool: 'Agent', agent: 'symphony:laravel-code-reviewer' });
      emit(params, 'tool_use', { tool: 'Bash' });
      live = s?.orchestrator.snapshot().running[0]?.integrations;
      s?.tracker.set('a', { state: 'In review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    });
    s = setup({ runner, front: { fake_section: {} }, integrations: [fake], issues: [makeIssue({ id: 'a' })], history });
    s.tracker.issueRepository = () => 'acme/app';
    await s.orchestrator.tickNow();
    await until(() => snapshot(s!).running.length === 0 && runner.sessions.length === 1, 3_000, 'run finished');

    const expected = {
      id: 'laravel-boost',
      label: 'Laravel Boost',
      status: 'ready',
      parts: [{ name: '(repository root)', status: 'ready', reason: null, versions: 'Laravel v13.1.0', guidelines: 'CLAUDE.md (loaded by Claude Code)', skills: ['pest-testing', 'livewire-development'], mcp_server: 'laravel-boost', tools: ['search-docs'], warnings: [] }],
      mcp_servers: ['laravel-boost'],
      mcp_unavailable: [],
      skills: ['livewire-development', 'pest-testing'],
      skills_loaded: ['pest-testing'],
      usage: { calls: 3, tool_calls: { 'search-docs': 2 }, skill_calls: { 'pest-testing': 1 } },
    };
    assert.deepEqual(live, [expected]);
    const detail = s.orchestrator.issueDetail('a') as { run_trace: { integrations: unknown; skill_calls: unknown; agent_calls: unknown } };
    assert.deepEqual(detail.run_trace.integrations, [expected]);
    assert.deepEqual(detail.run_trace.skill_calls, { 'pest-testing': 1, 'symphony:handoff': 1 });
    assert.deepEqual(detail.run_trace.agent_calls, { 'symphony:laravel-code-reviewer': 1 });

    const finished = readHistory(history.dir, 'acme/app').entries.find((entry) => entry.event === 'run_finished');
    assert.equal(finished?.fields.integrations, 'laravel-boost:ready');
    assert.equal(finished?.fields.integration_tools, 'laravel-boost/search-docs:2');
    assert.equal(finished?.fields.integration_skills, 'laravel-boost/pest-testing:1');
    assert.equal(finished?.fields.skill_calls, 'pest-testing:1,symphony:handoff:1');
    assert.equal(finished?.fields.agent_calls, 'symphony:laravel-code-reviewer:1');
    assert.equal(finished?.fields.tool_calls, 'mcp__laravel-boost__search-docs:2,mcp__tracker__set_status:1,Skill:2,Agent:1,Bash:1');
  });
});

describe('roles', () => {
  const rolesFront = {
    tracker: {
      kind: 'github_project',
      provider: { owner: 'acme', project_number: 1, token: 'test-token' },
      active_states: ['Todo', 'Agent review'],
    },
    agent: { max_turns: 3, max_continuations: 5 },
    claude: { model: 'sonnet', allowed_tools: ['Read'] },
    roles: {
      developer: { states: ['Todo'] },
      reviewer: {
        states: ['Agent review'],
        read_only: true,
        max_turns: 6,
        claude: { model: 'opus', allowed_tools: ['Grep'], append_system_prompt: 'Review only.' },
      },
    },
  };
  const rolePrompt = 'Act as {{ role }} on {{ issue.identifier }}';

  it('runs a role with its model, read-only policy, overrides and turn limit', async () => {
    const s = setup({ front: rolesFront, prompt: rolePrompt, issues: [makeIssue({ id: 'r', state: 'Agent review' })] });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'continuation retry');
    const session = s.runner.sessions[0];
    assert.equal(session?.params.config.model, 'opus');
    assert.equal(session?.params.policy?.readOnly, true);
    assert.deepEqual(session?.params.config.allowedTools, ['Read', 'Grep']);
    assert.equal(session?.params.config.appendSystemPrompt, 'Review only.');
    assert.equal(session?.turns.length, 6);
    assert.equal(session?.turns[0], 'Act as reviewer on acme/app#r');
  });

  it('offers each role only its subagents and the laravel- ones only in a Laravel workspace', async () => {
    const plugin = tempDir();
    fs.mkdirSync(path.join(plugin, '.claude-plugin'));
    fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), '{"name":"kit"}');
    fs.mkdirSync(path.join(plugin, 'agents'));
    const agent = (name: string, extra = '') => fs.writeFileSync(path.join(plugin, 'agents', `${name}.md`), `---\nname: ${name}\ndescription: ${name} work\n${extra}---\nBody\n`);
    agent('laravel-architect', 'disallowedTools: Edit, Write, NotebookEdit\n');
    agent('laravel-filament-developer');
    agent('helper');
    const laravel = (found: boolean): WorkspaceIntegration => ({
      id: 'fake-laravel',
      configKey: 'fake_section',
      agentPrefix: 'laravel-',
      resolveConfig: () => ({ config: {}, errors: [], warnings: [] }),
      prepare: async () => ({ mcpServers: {}, contextSections: [], additionalDirectories: [], env: {}, ...(found ? { agentPrefixes: ['laravel-'] } : {}) }),
    });
    const front = {
      ...rolesFront,
      claude: { ...rolesFront.claude, plugins: [plugin] },
      roles: { ...rolesFront.roles, developer: { states: ['Todo'], agents: ['laravel-architect', 'laravel-filament-developer'] } },
      fake_section: {},
    };
    const prompt = '{{ role }}:{% for a in agents %} {{ a.name }}{% endfor %}';
    const run = async (found: boolean) => {
      const runner = new FakeRunner(() => new Promise(() => undefined));
      const s = setup({ runner, front, prompt, integrations: [laravel(found)], issues: [makeIssue({ id: 'd' }), makeIssue({ id: 'r', state: 'Agent review' })] });
      await s.orchestrator.tickNow();
      await until(() => runner.sessions.length === 2 && runner.sessions.every((x) => x.turns.length === 1), 3_000, 'two sessions');
      const byRole = (role: string) => runner.sessions.find((x) => x.turns[0]?.startsWith(`${role}:`));
      return { developer: byRole('developer'), reviewer: byRole('reviewer') };
    };

    const inLaravel = await run(true);
    assert.equal(inLaravel.developer?.turns[0], 'developer: kit:laravel-architect kit:laravel-filament-developer');
    assert.deepEqual(inLaravel.developer?.params.deniedAgents, ['kit:helper', 'helper']);
    // helper can edit files, so the read-only reviewer does not get it.
    assert.equal(inLaravel.reviewer?.turns[0], 'reviewer: kit:laravel-architect');
    assert.deepEqual(inLaravel.reviewer?.params.deniedAgents, ['kit:helper', 'helper', 'kit:laravel-filament-developer', 'laravel-filament-developer']);

    const elsewhere = await run(false);
    assert.equal(elsewhere.developer?.turns[0], 'developer:');
    assert.deepEqual(elsewhere.developer?.params.deniedAgents, ['kit:helper', 'helper', 'kit:laravel-architect', 'laravel-architect', 'kit:laravel-filament-developer', 'laravel-filament-developer']);
    assert.equal(elsewhere.reviewer?.turns[0], 'reviewer:');
  });

  it('lets a "Model:" label override the role model', async () => {
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const s = setup({
      runner,
      front: {
        ...rolesFront,
        roles: {
          ...rolesFront.roles,
          reviewer: {
            ...rolesFront.roles.reviewer,
            result: 'review',
            on_result: { approved: 'In review', changes_needed: 'Todo', blocked: 'Todo' },
          },
        },
      },
      prompt: rolePrompt,
      issues: [makeIssue({ id: 'r', state: 'Agent review', labels: ['model: sonnet'] }), makeIssue({ id: 'd' })],
    });
    await s.orchestrator.tickNow();
    await until(() => runner.sessions.length === 2, 3_000, 'two sessions');
    const byId = Object.fromEntries(runner.sessions.map((session) => [session.params.issue.id, session]));
    assert.equal(byId.r?.params.config.model, 'opus');
    assert.equal(byId.r?.params.policy?.readOnly, true);
    assert.equal(byId.d?.params.config.model, 'sonnet');
    assert.equal(byId.d?.params.policy?.readOnly, false);
    assert.deepEqual(byId.d?.params.config.allowedTools, ['Read']);
    assert.equal(byId.d?.turns[0], 'Act as developer on acme/app#d');
  });

  it('lets an "Effort:" label override the role effort, which overrides claude.effort', async () => {
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const s = setup({
      runner,
      front: {
        ...rolesFront,
        claude: { ...rolesFront.claude, effort: 'low' },
        roles: { ...rolesFront.roles, reviewer: { ...rolesFront.roles.reviewer, claude: { ...rolesFront.roles.reviewer.claude, effort: 'high' } } },
      },
      prompt: rolePrompt,
      issues: [
        makeIssue({ id: 'r', state: 'Agent review' }),
        makeIssue({ id: 'rl', state: 'Agent review', labels: ['effort: max'] }),
        makeIssue({ id: 'd' }),
        makeIssue({ id: 'dl', labels: ['effort: medium'] }),
      ],
    });
    await s.orchestrator.tickNow();
    await until(() => runner.sessions.length === 4, 3_000, 'four sessions');
    const efforts = Object.fromEntries(runner.sessions.map((session) => [session.params.issue.id, session.params.config.effort]));
    assert.deepEqual(efforts, { r: 'high', rl: 'max', d: 'low', dl: 'medium' });
  });

  it('shows the role of each run in the snapshot and the issue detail', async () => {
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const s = setup({
      runner,
      front: rolesFront,
      prompt: rolePrompt,
      issues: [makeIssue({ id: 'r', state: 'Agent review' }), makeIssue({ id: 'd' })],
    });
    await s.orchestrator.tickNow();
    await until(() => runner.sessions.length === 2, 3_000, 'two sessions');
    const roles = Object.fromEntries(snapshot(s).running.map((row) => [row.issue_id, row.role]));
    assert.deepEqual(roles, { r: 'reviewer', d: 'developer' });
    const detail = s.orchestrator.issueDetail('acme/app#r');
    assert.equal(detail?.role, 'reviewer');
    assert.equal(detail?.running?.role, 'reviewer');
  });

  it('uses the implicit default role without roles and tags agent events with run_id and role', async () => {
    const lines: string[] = [];
    const logger = Logger.create({ sinks: [{ name: 'memory', write: (line) => lines.push(line) }], level: 'debug' });
    const s = setup({ logger, prompt: rolePrompt, front: { agent: { max_turns: 2 } }, issues: [makeIssue({ id: 'a' })] });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'continuation retry');
    const session = s.runner.sessions[0];
    assert.equal(session?.turns[0], 'Act as default on acme/app#a');
    assert.equal(session?.params.policy?.readOnly, false);
    assert.equal(session?.turns.length, 2);
    const event = lines.find((line) => line.includes('agent session_started'));
    assert.match(event ?? '', /run_id=[0-9a-f]{12}/);
    assert.match(event ?? '', /role=default/);
  });

  describe('issue commands', () => {
    /** A plugin with the skill behind /refactoring, so the dispatch preflight finds it. */
    function commandPlugin(): string {
      const dir = tempDir('symphony-plugin-');
      fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'symphony' }));
      fs.mkdirSync(path.join(dir, 'skills', 'refactoring'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'skills', 'refactoring', 'SKILL.md'), '---\nname: refactoring\n---\n');
      return dir;
    }
    const commandFront = (plugin: string) => ({
      tracker: {
        kind: 'github_project',
        provider: { owner: 'acme', project_number: 1, token: 'test-token' },
        active_states: ['Ready', 'In progress', 'Agent review'],
      },
      agent: { max_turns: 3, max_continuations: 6 },
      claude: { plugins: [plugin] },
      roles: {
        developer: { states: ['Ready', 'In progress'] },
        reviewer: { states: ['Agent review'], read_only: true },
        auditor: { commands: ['refactoring'], states: ['Ready', 'In progress'], read_only: true, run_checks: false, max_sub_issues: 7 },
      },
    });
    const subIssueTool: AgentToolSpec = {
      name: 'create_sub_issue',
      description: '',
      inputSchema: {},
      mutates: true,
      createsSubIssues: true,
      execute: async () => ({ ok: true, data: null }),
    };

    it('runs a /refactoring issue as the read-only auditor with the sub-issue tool, and other issues as before', async () => {
      const runner = new FakeRunner(() => new Promise(() => undefined));
      const s = setup({
        runner,
        front: commandFront(commandPlugin()),
        prompt: '{{ role }}|{% if issue.command %}{{ issue.command.skill }}{% else %}-{% endif %}',
        issues: [
          makeIssue({ id: 'a', state: 'Ready', description: '/refactoring app/Filament' }),
          makeIssue({ id: 'd', state: 'Ready', description: 'Add invoices' }),
        ],
      });
      s.tracker.agentToolSpecs = () => [subIssueTool];
      await s.orchestrator.tickNow();
      await until(() => runner.sessions.length === 2, 3_000, 'two sessions');
      const byId = Object.fromEntries(runner.sessions.map((session) => [session.params.issue.id, session]));

      assert.equal(byId.a?.turns[0], 'auditor|symphony:refactoring');
      assert.equal(byId.a?.params.policy?.readOnly, true);
      assert.deepEqual(byId.a?.params.tools.map((tool) => tool.name), ['create_sub_issue']);
      assert.equal(byId.a?.params.toolContext().maxSubIssues, 7);

      assert.equal(byId.d?.turns[0], 'developer|-');
      assert.equal(byId.d?.params.policy?.readOnly, false);
      assert.deepEqual(byId.d?.params.tools.map((tool) => tool.name), []);
      assert.equal(byId.d?.params.toolContext().maxSubIssues, undefined);
    });

    it('hands the issue to the developer in a fresh session when the command disappears from its description', async () => {
      const runner = new FakeRunner();
      const s = setup({
        runner,
        front: commandFront(commandPlugin()),
        prompt: '{{ role }}|{% if issue.command %}{{ issue.command.skill }}{% else %}-{% endif %}',
        issues: [makeIssue({ id: 'a', state: 'Ready', description: '/refactoring' })],
      });
      runner.script = (turn) => {
        if (runner.sessions.length === 1) s.tracker.set('a', { description: 'No command any more' });
        return { ok: true, turnId: String(turn), resultText: 'done' };
      };
      await s.orchestrator.tickNow();
      await until(() => snapshot(s).retrying.length === 1, 3_000, 'continuation retry');
      assert.equal(runner.sessions[0]?.turns.length, 1);
      assert.equal(runner.sessions[0]?.stopped, true);

      s.timers.fire(1_000);
      await until(() => runner.sessions.length === 2, 3_000, 'developer session');
      assert.deepEqual(runner.sessions.map((session) => session.turns[0]), ['auditor|symphony:refactoring', 'developer|-']);
      assert.equal(runner.sessions[1]?.params.policy?.readOnly, false);
    });

    it('does not dispatch while a command role has no skill in claude.plugins', async () => {
      const empty = tempDir('symphony-plugin-');
      const runner = new FakeRunner(() => new Promise(() => undefined));
      const s = setup({ runner, front: commandFront(empty), issues: [makeIssue({ id: 'a', state: 'Ready', description: '/refactoring' })] });
      await s.orchestrator.tickNow();
      assert.equal(runner.sessions.length, 0);
      assert.match(snapshot(s).health.dispatch_errors.join(), /roles\.auditor\.commands: no skill for \/refactoring in claude\.plugins/);
    });
  });

  describe('waves of sub-issues (wait_for_sub_issues)', () => {
    function autoCodePlugin(): string {
      const dir = tempDir('symphony-plugin-');
      fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'symphony' }));
      fs.mkdirSync(path.join(dir, 'skills', 'auto-code'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'skills', 'auto-code', 'SKILL.md'), '---\nname: auto-code\n---\n');
      return dir;
    }
    const waveFront = () => ({
      tracker: {
        kind: 'github_project',
        provider: { owner: 'acme', project_number: 1, token: 'test-token' },
        active_states: ['Ready', 'In progress'],
      },
      agent: { max_turns: 3, max_continuations: 6 },
      claude: { plugins: [autoCodePlugin()] },
      roles: {
        developer: { states: ['Ready', 'In progress'] },
        autopilot: {
          commands: ['auto-code'],
          states: ['Ready', 'In progress'],
          read_only: true,
          run_checks: false,
          max_sub_issues: 5,
          sub_issue_status: 'Ready',
          wait_for_sub_issues: true,
        },
      },
    });
    /** Open sub-issues per issue id, as the tracker reports them. */
    const openSubs = new Map<string, string[]>();
    const withSubIssues = (s: Setup) => {
      s.tracker.openSubIssues = (issue) => openSubs.get(issue.id) ?? [];
      return s;
    };

    it('holds only the waiting role back while sub-issues are open, and starts it once they are closed', async () => {
      openSubs.clear();
      openSubs.set('epic', ['acme/app#2']);
      openSubs.set('parent', ['acme/app#3']);
      const runner = new FakeRunner(() => new Promise(() => undefined));
      const s = withSubIssues(
        setup({
          runner,
          front: waveFront(),
          prompt: '{{ role }}',
          issues: [
            makeIssue({ id: 'epic', state: 'In progress', description: '/auto-code docs/index.md' }),
            makeIssue({ id: 'parent', state: 'Ready', description: 'An ordinary issue' }),
          ],
        }),
      );
      await s.orchestrator.tickNow();
      await until(() => runner.sessions.length === 1, 3_000, 'developer session');
      assert.equal(runner.sessions[0]?.params.issue.id, 'parent');

      openSubs.set('epic', []);
      await s.orchestrator.tickNow();
      await until(() => runner.sessions.length === 2, 3_000, 'autopilot session');
      const autopilot = runner.sessions[1];
      assert.equal(autopilot?.turns[0], 'autopilot');
      assert.equal(autopilot?.params.policy?.readOnly, true);
      assert.equal(autopilot?.params.toolContext().subIssueStatus, 'Ready');
      assert.equal(autopilot?.params.toolContext().maxSubIssues, 5);
    });

    it('lets the autopilot finish the turn that opened the wave, then ends the session and waits for the wave', async () => {
      openSubs.clear();
      let finishTurn: () => void = () => undefined;
      const runner = new FakeRunner(
        () =>
          new Promise((resolve) => {
            finishTurn = () => resolve({ ok: true, turnId: '1', resultText: 'wave planned' });
          }),
      );
      const s = withSubIssues(
        setup({ runner, front: waveFront(), issues: [makeIssue({ id: 'epic', state: 'In progress', description: '/auto-code' })] }),
      );
      await s.orchestrator.tickNow();
      await until(() => runner.sessions[0]?.turns.length === 1, 3_000, 'first turn');

      // create_sub_issue opened the wave mid-turn; reconciliation must not stop the autopilot for it.
      openSubs.set('epic', ['acme/app#2', 'acme/app#3']);
      await s.orchestrator.tickNow();
      assert.equal(snapshot(s).running.length, 1);
      assert.equal(runner.sessions[0]?.stopped, false);

      finishTurn();
      await until(() => snapshot(s).retrying.length === 1, 3_000, 'continuation retry');
      assert.equal(runner.sessions[0]?.turns.length, 1, 'no second turn while the wave is open');
      assert.equal(runner.sessions[0]?.stopped, true);

      // The continuation finds the wave open: the claim is released, nothing is paused or restarted.
      s.timers.fire(CONTINUATION_DELAY_MS);
      await until(() => snapshot(s).retrying.length === 0, 3_000, 'claim released');
      await s.orchestrator.tickNow();
      assert.equal(runner.sessions.length, 1);
      assert.equal(snapshot(s).paused.length, 0);

      openSubs.set('epic', []);
      await s.orchestrator.tickNow();
      await until(() => runner.sessions.length === 2, 3_000, 'next wave');
    });
  });

  const switchFront = {
    tracker: {
      kind: 'github_project',
      provider: { owner: 'acme', project_number: 1, token: 'test-token' },
      active_states: ['Ready', 'In progress', 'Agent review'],
    },
    agent: { max_turns: 3, max_continuations: 6 },
    roles: { developer: { states: ['Ready', 'In progress'] }, reviewer: { states: ['Agent review'], read_only: true } },
  };

  function withHistory(front: Record<string, unknown>, runner: FakeRunner, issues: ReturnType<typeof makeIssue>[]) {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
    const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
    const history = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
    const tracker = new FakeTracker(issues);
    tracker.issueRepository = () => 'acme/app';
    const timers = new ManualTimers();
    const workflow = new StaticWorkflow(makeWorkflow(baseFront(tempDir(), front), { prompt: rolePrompt }));
    const orchestrator = new Orchestrator({
      workflow,
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: null,
      clock: new ManualClock(),
      timers,
      createAdapter: () => tracker,
      pricing,
      history,
    });
    const finished = () => readHistory(history.dir, 'acme/app').entries.filter((e) => e.event === 'run_finished');
    return { orchestrator, tracker, runner, timers, history, finished, workflow };
  }

  describe('role switches', () => {
    it('ends the session when the issue moves to another role and starts the next role in a fresh session', async () => {
      const runner = new FakeRunner();
      const s = withHistory(switchFront, runner, [makeIssue({ id: 'a', state: 'Ready' })]);
      runner.script = (turn) => {
        if (runner.sessions.length === 1) s.tracker.set('a', { state: 'Agent review' });
        return { ok: true, turnId: String(turn), resultText: 'done' };
      };
      await s.orchestrator.tickNow();
      await until(() => s.orchestrator.snapshot().retrying.length === 1, 3_000, 'continuation retry');
      assert.equal(runner.sessions[0]?.turns.length, 1);
      assert.equal(runner.sessions[0]?.stopped, true);
      assert.equal(s.orchestrator.snapshot().retrying[0]?.kind, 'continuation');

      s.timers.fire(1_000);
      await until(() => runner.sessions.length === 2 && s.orchestrator.snapshot().retrying.length === 1, 3_000, 'reviewer session');
      const reviewer = runner.sessions[1];
      assert.equal(reviewer?.turns[0], 'Act as reviewer on acme/app#a');
      assert.equal(reviewer?.params.policy?.readOnly, true);
      assert.equal(reviewer?.turns.length, 3);

      const [developerRun, reviewerRun] = s.finished();
      assert.match(
        fs.readFileSync(s.history.fileFor('acme/app'), 'utf8'),
        /event=run_finished .*outcome=handed_off role=developer next_role=reviewer state="Agent review"/,
      );
      assert.equal(developerRun?.fields.reason, 'role changed (developer → reviewer)');
      assert.equal(reviewerRun?.fields.outcome, 'continuing');
      assert.equal(reviewerRun?.fields.role, 'reviewer');
      assert.equal(reviewerRun?.fields.next_role, undefined);
    });

    it('keeps one session when the issue moves to another column of the same role', async () => {
      const runner = new FakeRunner();
      const s = withHistory(switchFront, runner, [makeIssue({ id: 'a', state: 'Ready' })]);
      runner.script = (turn) => {
        s.tracker.set('a', { state: 'In progress' });
        return { ok: true, turnId: String(turn), resultText: 'done' };
      };
      await s.orchestrator.tickNow();
      await until(() => s.orchestrator.snapshot().retrying.length === 1, 3_000, 'continuation retry');
      assert.equal(runner.sessions.length, 1);
      assert.equal(runner.sessions[0]?.turns.length, 3);
      assert.equal(s.finished()[0]?.fields.outcome, 'continuing');
    });

    it('counts role switches as continuations and pauses developer↔reviewer ping-pong', async () => {
      const runner = new FakeRunner();
      const s = withHistory({ ...switchFront, agent: { max_turns: 3, max_continuations: 2 } }, runner, [makeIssue({ id: 'a', state: 'Ready' })]);
      runner.script = (turn, params) => {
        s.tracker.set('a', { state: params.policy?.readOnly ? 'In progress' : 'Agent review' });
        return { ok: true, turnId: String(turn), resultText: 'done' };
      };
      await s.orchestrator.tickNow();
      await until(() => s.orchestrator.snapshot().retrying.length === 1, 3_000, 'first handoff');
      s.timers.fire(1_000);
      await until(() => runner.sessions.length === 2 && s.orchestrator.snapshot().retrying.length === 1, 3_000, 'reviewer session');
      s.timers.fire(1_000);
      await until(() => runner.sessions.length === 3 && s.orchestrator.snapshot().retrying.length === 1, 3_000, 'developer session');
      s.timers.fire(1_000);
      await until(() => s.orchestrator.snapshot().counts.paused === 1, 3_000, 'paused');

      assert.deepEqual(runner.sessions.map((session) => session.turns[0]), [
        'Act as developer on acme/app#a',
        'Act as reviewer on acme/app#a',
        'Act as developer on acme/app#a',
      ]);
      assert.ok(runner.sessions.every((session) => session.turns.length === 1));
      assert.deepEqual(
        s.finished().map((e) => [e.fields.outcome, e.fields.role, e.fields.next_role]),
        [
          ['handed_off', 'developer', 'reviewer'],
          ['handed_off', 'reviewer', 'developer'],
          ['handed_off', 'developer', 'reviewer'],
        ],
      );
    });
  });

  describe('issue cost budget (agent.max_issue_cost_usd)', () => {
    const budgetFront = (limit: number) => ({
      ...switchFront,
      agent: { max_turns: 3, max_continuations: 6, max_issue_cost_usd: limit },
    });
    const seedHistory = (s: ReturnType<typeof withHistory>, lines: string[]) => {
      fs.mkdirSync(s.history.dir, { recursive: true });
      fs.writeFileSync(s.history.fileFor('acme/app'), `${lines.join('\n')}\n`);
    };
    /** One turn that cost $5 at the test pricing (1M input tokens at $5). */
    const spend = (params: Parameters<FakeRunner['script']>[1], turn: number) =>
      params.onEvent({
        event: 'turn_completed', timestamp: new Date(), pid: 1, threadId: 'thread-1', turnId: String(turn), sessionId: `thread-1-${turn}`, turnCount: turn,
        usage: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
        modelUsage: { 'claude-opus-5-5': { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      });
    const commented = (s: ReturnType<typeof withHistory>) => {
      const comments: string[] = [];
      s.tracker.commentOnIssue = async (_issue, body) => void comments.push(body);
      return comments;
    };

    it('does not start the next stage once the issue cost reached the budget, and says why', async () => {
      const runner = new FakeRunner();
      const s = withHistory(budgetFront(4), runner, [makeIssue({ id: 'a', state: 'Ready' })]);
      const comments = commented(s);
      runner.script = (turn, params) => {
        spend(params, turn);
        if (runner.sessions.length === 1) s.tracker.set('a', { state: 'Agent review' });
        return { ok: true, turnId: String(turn), resultText: 'done' };
      };
      await s.orchestrator.tickNow();
      await until(() => s.orchestrator.snapshot().retrying.length === 1, 3_000, 'continuation retry');
      s.timers.fire(1_000);
      await until(() => s.orchestrator.snapshot().counts.paused === 1, 3_000, 'paused');

      assert.equal(runner.sessions.length, 1, 'the reviewer stage did not start');
      const paused = s.orchestrator.snapshot().paused[0];
      assert.equal(paused?.source, 'budget');
      assert.equal(paused?.cost_usd, 5);
      assert.equal(paused?.max_issue_cost_usd, 4);
      // The dashboard card shows the spent share of the budget.
      assert.deepEqual(s.orchestrator.snapshot().issues.find((row) => row.issue_identifier === 'acme/app#a')?.budget, { cost_usd: 5, max_issue_cost_usd: 4 });
      assert.equal(comments.length, 1);
      assert.match(comments[0] ?? '', /Cost budget used up.*\$5\.00.*\$4\.00/s);
      assert.match(fs.readFileSync(s.history.fileFor('acme/app'), 'utf8'), /event=issue_paused .*source=budget cost_usd=5 max_issue_cost_usd=4/);
      const timeline = s.orchestrator.issueTimeline('acme/app#a');
      assert.equal(timeline?.events.find((e) => e.event === 'issue_paused')?.detail?.source, 'budget');

      // Board changes do not lift the pause.
      s.tracker.set('a', { labels: ['changed'] });
      await s.orchestrator.tickNow();
      assert.equal(s.orchestrator.snapshot().counts.paused, 1);
      assert.equal(runner.sessions.length, 1);
    });

    it('does not stop a running stage that passes the budget', async () => {
      const runner = new FakeRunner();
      const s = withHistory(budgetFront(4), runner, [makeIssue({ id: 'a', state: 'Ready' })]);
      runner.script = (turn, params) => {
        spend(params, turn);
        return { ok: true, turnId: String(turn), resultText: 'done' };
      };
      await s.orchestrator.tickNow();
      await until(() => s.orchestrator.snapshot().retrying.length === 1, 3_000, 'continuation retry');
      assert.equal(runner.sessions[0]?.turns.length, 3, 'all turns ran although the first one used up the budget');
      s.timers.fire(1_000);
      await until(() => s.orchestrator.snapshot().counts.paused === 1, 3_000, 'paused');
      assert.equal(runner.sessions.length, 1);
    });

    it('applies after a restart: the cost comes from the history log', async () => {
      const runner = new FakeRunner();
      const s = withHistory(budgetFront(4), runner, [makeIssue({ id: 'a', state: 'Ready' })]);
      seedHistory(s, [
        'ts=2026-10-01T10:00:00.000Z event=run_finished repo=acme/app issue=acme/app#a run=r1 role=developer cost_usd=3',
        'ts=2026-10-01T11:00:00.000Z event=run_finished repo=acme/app issue=acme/app#a run=r2 role=reviewer cost_usd=1.5',
        'ts=2026-10-01T12:00:00.000Z event=run_finished repo=acme/app issue=acme/app#b run=r3 role=developer cost_usd=50',
      ]);
      await s.orchestrator.tickNow();
      await until(() => s.orchestrator.snapshot().counts.paused === 1, 3_000, 'paused');
      assert.equal(runner.sessions.length, 0, 'no session started');
      assert.equal(s.orchestrator.snapshot().paused[0]?.cost_usd, 4.5);
    });

    it('starts issues below the budget and without a cap', async () => {
      for (const front of [budgetFront(6), switchFront]) {
        const runner = new FakeRunner();
        const s = withHistory(front, runner, [makeIssue({ id: 'a', state: 'Ready' })]);
        seedHistory(s, ['ts=2026-10-01T10:00:00.000Z event=run_finished repo=acme/app issue=acme/app#a run=r1 cost_usd=5']);
        await s.orchestrator.tickNow();
        await until(() => runner.sessions.length === 1, 3_000, 'session');
        assert.equal(s.orchestrator.snapshot().counts.paused, 0);
      }
    });

    it('resumes by itself when the cap is raised; Resume while still over the cap pauses again without a second comment', async () => {
      const runner = new FakeRunner();
      const s = withHistory(budgetFront(4), runner, [makeIssue({ id: 'a', state: 'Ready' })]);
      const comments = commented(s);
      seedHistory(s, ['ts=2026-10-01T10:00:00.000Z event=run_finished repo=acme/app issue=acme/app#a run=r1 cost_usd=5']);
      await s.orchestrator.tickNow();
      await until(() => s.orchestrator.snapshot().counts.paused === 1, 3_000, 'paused');

      assert.equal((await s.orchestrator.restartWorker('acme/app#a')).ok, true);
      s.timers.fire(0);
      await until(() => s.orchestrator.snapshot().counts.paused === 1 && s.orchestrator.snapshot().retrying.length === 0, 3_000, 'paused again');
      assert.equal(runner.sessions.length, 0);
      assert.equal(comments.length, 1);

      s.workflow.current = makeWorkflow(baseFront(tempDir(), budgetFront(10)), { prompt: rolePrompt });
      await s.orchestrator.tickNow();
      await until(() => runner.sessions.length === 1, 3_000, 'resumed session');
      assert.equal(s.orchestrator.snapshot().counts.paused, 0);
    });
  });
});

describe('transition guard', () => {
  it('gates set_status: denies Done, keeps the column on a failed check and moves after a passing one', async () => {
    const front = {
      tracker: {
        kind: 'github_project',
        provider: { owner: 'acme', project_number: 1, token: 'test-token' },
        active_states: ['Todo', 'Agent review'],
      },
      agent: { max_turns: 2 },
      roles: {
        developer: { states: ['Todo'], may_move_to: ['Agent review', 'Blocked'] },
        reviewer: { states: ['Agent review'], read_only: true },
      },
      checks: { on_enter: { 'Agent review': 'test -f ready || { echo "tests failed"; exit 1; }' } },
    };
    const results: ToolResult[] = [];
    const states: string[] = [];
    const runner = new FakeRunner(async (turn, params) => {
      const call = async (status: string) => {
        const result = await callTool(params, 'set_status', { status });
        results.push(result);
        states.push(s.tracker.issues.get('g')!.state);
      };
      await call('Done');
      await call('Agent review');
      fs.writeFileSync(path.join(params.cwd, 'ready'), '');
      await call('Agent review');
      return { ok: true, turnId: String(turn), resultText: 'done' };
    });
    const s = setup({ front, runner, issues: [makeIssue({ id: 'g' })] });
    await s.orchestrator.tickNow();
    await until(() => results.length === 3, 5_000, 'three set_status calls');

    const [done, failed, passed] = results;
    assert.equal(done?.ok === false ? done.error.category : null, 'transition_denied');
    assert.match(done?.ok === false ? done.error.message : '', /Allowed targets: "Agent review", "Blocked"/);
    assert.equal(failed?.ok === false ? failed.error.category : null, 'check_failed');
    assert.match(failed?.ok === false ? failed.error.message : '', /tests failed/);
    assert.deepEqual(passed, { ok: true, data: { previous_status: 'Todo', status: 'Agent review', note: 'Checks passed — end your turn now.' } });
    assert.deepEqual(states, ['Todo', 'Todo', 'Agent review']);
    assert.deepEqual(s.tracker.statusCalls, ['Agent review']);
  });
});

describe('entry checks at runtime', () => {
  it('exempts a running check from stall detection, then logs, records and serves its result', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
    const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
    const history = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
    const lines: string[] = [];
    const logger = Logger.create({ sinks: [{ name: 'memory', write: (line) => lines.push(line) }], level: 'info' });
    const results: ToolResult[] = [];
    let workspace = '';
    const runner = new FakeRunner(async (_turn, params) => {
      workspace = params.cwd;
      results.push(await callTool(params, 'set_status', { status: 'Done' }));
      results.push(await callTool(params, 'set_status', { status: 'Agent review' }));
      return new Promise((resolve) => params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: '1', code: 'turn_cancelled', message: 'cancelled' })));
    });
    const s = setup({
      runner,
      logger,
      history,
      issues: [makeIssue({ id: 'c' })],
      front: {
        tracker: {
          kind: 'github_project',
          provider: { owner: 'acme', project_number: 1, token: 'test-token' },
          active_states: ['Todo', 'Agent review'],
        },
        claude: { stall_timeout_ms: 60_000 },
        roles: { developer: { states: ['Todo'], may_move_to: ['Agent review'] }, reviewer: { states: ['Agent review'] } },
        checks: { on_enter: { 'Agent review': 'while [ ! -f "$SYMPHONY_WORKSPACE/go" ]; do sleep 0.02; done; echo "lint failed"; exit 1' } },
      },
    });
    s.tracker.issueRepository = () => 'acme/app';
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running[0]?.phase === 'RunningChecks', 5_000, 'running checks');
    s.clock.advance(120_000);
    await s.orchestrator.tickNow();
    assert.equal(snapshot(s).running[0]?.stopping, null, 'no stall while a check runs');

    fs.writeFileSync(path.join(workspace, 'go'), '');
    await until(() => results.length === 2 && snapshot(s).running[0]?.phase === 'StreamingTurn', 5_000, 'check finished');
    s.clock.advance(30_000);
    await s.orchestrator.tickNow();
    assert.equal(snapshot(s).running[0]?.stopping, null, 'the stall clock starts fresh after the check');

    assert.equal(results[1]?.ok === false ? results[1].error.category : null, 'check_failed');
    const events = lines.filter((line) => line.includes('level=info')).map((line) => /msg="agent (\w+)"/.exec(line)?.[1]);
    assert.ok(events.includes('transition_denied') && events.includes('checks_started') && events.includes('checks_finished'));
    const finishedLine = lines.find((line) => line.includes('msg="agent checks_finished"')) ?? '';
    assert.match(finishedLine, /target="Agent review"/);
    assert.match(finishedLine, /exit_code=1 /);
    assert.match(finishedLine, /duration_ms=\d+/);
    assert.match(finishedLine, /ok=false/);

    const entries = readHistory(history.dir, 'acme/app').entries;
    const denied = entries.find((e) => e.event === 'transition_denied');
    assert.equal(denied?.fields.target, 'Done');
    assert.equal(denied?.fields.role, 'developer');
    assert.match(denied?.fields.reason ?? '', /terminal column/);
    const check = entries.find((e) => e.event === 'checks_finished');
    assert.deepEqual([check?.fields.target, check?.fields.ok, check?.fields.result, check?.fields.exit_code], ['Agent review', 'false', 'check_failed', '1']);
    assert.ok(Number(check?.fields.duration_ms) >= 0);

    const last = s.orchestrator.issueDetail('acme/app#c')?.last_check;
    assert.deepEqual([last?.target, last?.role, last?.ok, last?.result, last?.exit_code, last?.timed_out], ['Agent review', 'developer', false, 'check_failed', 1, false]);
    const gate = s.orchestrator.issueDetail('acme/app#c')?.gate;
    assert.equal(gate?.target, 'Agent review');
    assert.notEqual(gate?.finished_at, null, 'a finished gate stays until the next one');
    assert.equal(gate?.checks[0]?.status, 'check_failed');

    s.clock.advance(31_000);
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'stall retry after the check');
  });
});

describe('worker lifecycle and retries', () => {
  it('runs turns while the issue stays active, then schedules a 1s continuation retry', async () => {
    const s = setup({ front: { agent: { max_turns: 3 } }, issues: [makeIssue({ id: 'a' })] });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'continuation retry');
    const session = s.runner.sessions[0];
    assert.equal(session?.turns.length, 3);
    assert.match(session?.turns[0] ?? '', /Work on acme\/app#a/);
    assert.match(session?.turns[1] ?? '', /still in the active state "Todo".*turn 2 of at most 3/s);
    assert.equal(session?.stopped, true);
    const retry = snapshot(s).retrying[0];
    assert.equal(retry?.attempt, 1);
    assert.equal(retry?.kind, 'continuation');
    assert.ok(s.timers.delays().includes(1_000));
  });

  it('stops after a turn once the agent moves the issue out of the active states', async () => {
    const s = setup({ issues: [makeIssue({ id: 'a' })] });
    s.runner.script = (turn) => {
      s.tracker.set('a', { state: 'Human Review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    };
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'retry');
    assert.equal(s.runner.sessions[0]?.turns.length, 1);

    // The continuation retry finds the issue no longer active and releases the claim.
    s.timers.fire(1_000);
    await until(() => snapshot(s).counts.claimed === 0, 3_000, 'claim released');
    assert.equal(snapshot(s).retrying.length, 0);
  });

  it('reports a session_limit turn failure as worker exited: session_limit', async () => {
    const s = setup({ issues: [makeIssue({ id: 'a' })] });
    s.runner.script = (turn) => ({ ok: false, turnId: String(turn), code: 'session_limit', message: "turn ended with an error: You've hit your session limit" });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'retry');
    assert.match(snapshot(s).retrying[0]?.error ?? '', /worker exited: session_limit: turn ended with an error: You've hit your session limit/);
  });

  it('retries failures with exponential backoff and re-dispatches with the attempt number', async () => {
    const s = setup({ issues: [makeIssue({ id: 'a' })] });
    s.runner.script = (turn) => ({ ok: false, turnId: String(turn), code: 'turn_failed', message: 'boom' });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'first retry');
    assert.equal(snapshot(s).retrying[0]?.attempt, 1);
    assert.match(snapshot(s).retrying[0]?.error ?? '', /worker exited: turn_failed: boom/);
    assert.ok(s.timers.delays().includes(10_000));

    s.timers.fire(10_000);
    await until(() => s.runner.sessions.length === 2 && snapshot(s).retrying.length === 1, 3_000, 'second retry');
    assert.equal(snapshot(s).retrying[0]?.attempt, 2);
    assert.ok(s.timers.delays().includes(20_000));
  });

  it('requeues a retry when no slot is free', async () => {
    const s = setup({
      front: { polling: { interval_ms: 7_000 }, agent: { max_concurrent_agents: 1 } },
      issues: [makeIssue({ id: 'a', priority: 1 })],
    });
    s.runner.script = (turn) => ({ ok: false, turnId: String(turn), code: 'turn_failed', message: 'boom' });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'retry');

    // A retry in its backoff holds no slot: another issue takes the only one before the retry fires.
    s.runner.script = () => new Promise(() => undefined);
    s.tracker.issues.set('b', makeIssue({ id: 'b', priority: 2 }));
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running.length === 1, 3_000, 'b running');
    s.timers.fire(10_000);
    await until(() => snapshot(s).retrying[0]?.error === 'waiting for a free slot (1/1 busy)', 3_000, 'requeue');
    assert.equal(snapshot(s).retrying[0]?.attempt, 1);
    assert.equal(snapshot(s).retrying[0]?.kind, 'failure');
    assert.ok(s.timers.delays().includes(7_000));
    assert.ok(!s.timers.delays().includes(20_000));
    // Requeued for a slot, it stays up next with the reason, ahead of new candidates.
    const item = snapshot(s).queue[0];
    assert.equal(item?.issue_identifier, 'acme/app#a');
    assert.equal(item?.status, 'next');
    assert.equal(item?.position, 1);
    assert.deepEqual(item?.reason, { code: 'no_free_slot', text: 'waiting for a free slot (1/1 busy)' });
  });

  it('keeps the slot of a continuation: a new candidate does not take it in the continuation delay', async () => {
    const s = setup({
      front: { agent: { max_concurrent_agents: 1, max_turns: 1 } },
      issues: [makeIssue({ id: 'a', priority: 3 })],
    });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying[0]?.kind === 'continuation', 3_000, 'continuation retry');

    // A new candidate with a higher priority arrives while the continuation waits its 1 s.
    s.runner.script = () => new Promise(() => undefined);
    s.tracker.issues.set('b', makeIssue({ id: 'b', priority: 1 }));
    await s.orchestrator.tickNow();
    assert.equal(snapshot(s).running.length, 0, 'b does not take the slot');
    const queue = snapshot(s).queue;
    assert.deepEqual(
      queue.map((item) => [item.position, item.issue_identifier, item.kind, item.decision, item.reason.code]),
      [
        [1, 'acme/app#a', 'continuation', 'start', 'ready'],
        [2, 'acme/app#b', 'new', 'wait', 'no_free_slot'],
      ],
    );

    // Position 1 is what starts next.
    s.timers.fire(CONTINUATION_DELAY_MS);
    await until(() => snapshot(s).running[0]?.issue_id === 'a', 3_000, 'a continues');
    await s.orchestrator.tickNow();
    assert.deepEqual(snapshot(s).running.map((row) => row.issue_id), ['a']);
    assert.equal(s.runner.sessions.filter((session) => session.params.issue.id === 'b').length, 0);
  });

  it('starts the issue at position 1 when a slot frees up', async () => {
    let finish: () => void = () => {};
    const s = setup({
      front: { agent: { max_concurrent_agents: 1 } },
      issues: [makeIssue({ id: 'a', priority: 1 })],
    });
    s.runner.script = (turn, params) =>
      params.issue.id === 'a'
        ? new Promise((resolve) => (finish = () => resolve({ ok: true, turnId: String(turn), resultText: 'done' })))
        : new Promise(() => undefined);
    await s.orchestrator.tickNow();
    await until(() => s.runner.sessions[0]?.turns.length === 1, 3_000, 'a in its turn');
    s.tracker.issues.set('late', makeIssue({ id: 'late', priority: 2, created_at: new Date('2026-03-01T00:00:00Z') }));
    s.tracker.issues.set('early', makeIssue({ id: 'early', priority: 2, created_at: new Date('2026-02-01T00:00:00Z') }));
    s.tracker.issues.set('low', makeIssue({ id: 'low', priority: 4 }));
    await s.orchestrator.tickNow();
    assert.deepEqual(
      snapshot(s).queue.map((item) => [item.position, item.issue_id, item.reason.code]),
      [
        [1, 'early', 'no_free_slot'],
        [2, 'late', 'no_free_slot'],
        [3, 'low', 'no_free_slot'],
      ],
    );
    // a hands off; its slot goes to position 1.
    s.tracker.set('a', { state: 'Human Review' });
    finish();
    await until(() => snapshot(s).running.length === 0, 3_000, 'a finished');
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running.length === 1, 3_000, 'next running');
    assert.equal(snapshot(s).running[0]?.issue_id, 'early');
  });

  it('requeues a continuation with no free slot as a continuation after one poll interval', async () => {
    const s = setup({
      front: { polling: { interval_ms: 7_000 }, agent: { max_concurrent_agents: 2, max_turns: 1 } },
      issues: [makeIssue({ id: 'a', priority: 1 }), makeIssue({ id: 'b', priority: 2 })],
    });
    s.runner.script = (turn, params) => (params.issue.id === 'a' ? { ok: true, turnId: String(turn), resultText: 'done' } : new Promise(() => undefined));
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying[0]?.kind === 'continuation' && snapshot(s).running.length === 1, 3_000, 'continuation retry');

    // A reload lowers the limit while b runs: the continuation has no slot left.
    s.workflow.current = makeWorkflow(baseFront(s.root, { polling: { interval_ms: 7_000 }, agent: { max_concurrent_agents: 1, max_turns: 1 } }));
    s.timers.fire(CONTINUATION_DELAY_MS);
    await until(() => snapshot(s).retrying[0]?.error === 'waiting for a free slot (1/1 busy)', 3_000, 'requeue');
    const retry = snapshot(s).retrying[0];
    assert.equal(retry?.kind, 'continuation');
    assert.equal(retry?.attempt, 1);
    assert.ok(s.timers.delays().includes(7_000));
  });

  it('releases the claim when a retried issue has disappeared', async () => {
    const s = setup({ issues: [makeIssue({ id: 'a' })] });
    s.runner.script = (turn) => ({ ok: false, turnId: String(turn), code: 'turn_failed', message: 'boom' });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'retry');
    s.tracker.issues.delete('a');
    s.timers.fire(10_000);
    await until(() => snapshot(s).counts.claimed === 0, 3_000, 'released');
  });
});

describe('session limit retries', () => {
  const RESETS_AT = new Date('2026-10-03T17:30:00Z');
  const TEXT = "You've hit your session limit · resets 7:30pm (Europe/Berlin)";
  type Mode = 'limit' | 'fail' | 'ok' | 'hang';

  /** A runner whose next sessions fail with a session limit, fail otherwise, end normally or hang until stopped. */
  function limitSetup(options: { front?: Record<string, unknown>; history?: HistoryLog; logger?: Logger } = {}) {
    const state: { mode: Mode; resetsAt: Date | null } = { mode: 'limit', resetsAt: RESETS_AT };
    const runner = new FakeRunner((turn, params) => {
      if (state.mode === 'limit') {
        return {
          ok: false,
          turnId: String(turn),
          code: 'session_limit',
          message: `turn ended with an error: ${TEXT}`,
          sessionLimit: { window: 'five_hour', scope: 'account', model: null, resetsAt: state.resetsAt, source: 'event', text: TEXT, overageDisabledReason: null },
        };
      }
      if (state.mode === 'fail') return { ok: false, turnId: String(turn), code: 'turn_failed', message: 'boom' };
      if (state.mode === 'ok') return { ok: true, turnId: String(turn), resultText: 'done' };
      return new Promise((resolve) => params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: String(turn), code: 'turn_cancelled', message: 'cancelled' })));
    });
    const s = setup({ runner, issues: [makeIssue({ id: 'a' })], ...options, front: { agent: { max_turns: 1 }, ...options.front } });
    return { s, state };
  }

  const retry = (s: Setup) => snapshot(s).retrying[0];

  /** Fires the pending retry and waits for the run it dispatches to be scheduled again. */
  async function fireRetry(s: Setup, delay: number) {
    const sessions = s.runner.sessions.length;
    assert.ok(s.timers.delays().includes(delay), `a ${delay}ms timer is pending (have ${s.timers.delays().join(', ')})`);
    s.timers.fire(delay);
    await until(() => s.runner.sessions.length === sessions + 1 && snapshot(s).retrying.length === 1, 3_000, 'next retry');
  }

  it('retries a session limit up to max_session_limit_retries times with the failure backoff, then waits for the reset', async () => {
    const { s, state } = limitSetup();
    const resetsAt = new Date(s.clock.now().getTime() + 2 * 3600_000);
    state.resetsAt = resetsAt;
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'first retry');
    for (const [hits, delay] of [[1, 10_000], [2, 20_000], [3, 40_000]] as const) {
      const row = retry(s);
      assert.equal(row?.kind, 'session_limit');
      assert.equal(row?.attempt, hits);
      assert.equal(row?.limit?.hits, hits);
      assert.equal(row?.limit?.max_retries, 3);
      assert.equal(row?.limit?.waiting, false);
      assert.deepEqual(s.timers.delays(), [delay]);
      await fireRetry(s, delay);
    }
    // The fourth failure is beyond the cap: the retry waits until the reset plus 60s.
    const wait = 2 * 3600_000 + 60_000;
    const row = retry(s);
    assert.equal(row?.kind, 'session_limit');
    assert.equal(row?.attempt, 4);
    assert.deepEqual(s.timers.delays(), [wait]);
    assert.equal(row?.due_at, new Date(resetsAt.getTime() + 60_000).toISOString());
    assert.deepEqual(row?.limit, {
      window: 'five_hour',
      scope: 'account',
      model: null,
      resets_at: resetsAt.toISOString(),
      source: 'event',
      text: TEXT,
      hits: 4,
      max_retries: 3,
      waiting: true,
      overage_disabled_reason: null,
      observed_at: s.clock.now().toISOString(),
    });
    assert.match(row?.error ?? '', /^worker exited: session_limit: turn ended with an error: You've hit your session limit/);

    // Polling does not start a session while the entry waits.
    await s.orchestrator.tickNow();
    await s.orchestrator.tickNow();
    assert.equal(s.runner.sessions.length, 4);
    assert.equal(snapshot(s).running.length, 0);

    const detail = s.orchestrator.issueDetail('acme/app#a');
    assert.match(detail?.last_error ?? '', /^session_limit: /);
    assert.equal(detail?.retry?.limit?.hits, 4);
    const events = s.orchestrator.issueTimeline('acme/app#a')?.events ?? [];
    const scheduled = events.filter((event) => event.event === 'retry_scheduled');
    assert.deepEqual(
      scheduled.map((event) => [event.level, event.message]),
      [
        ['warn', 'session limit: retry 1 of 3 in 10s'],
        ['warn', 'session limit: retry 2 of 3 in 20s'],
        ['warn', 'session limit: retry 3 of 3 in 40s'],
        ['warn', 'session limit: waiting for the reset, retry in 7260s'],
      ],
    );
    assert.equal((scheduled[0]?.detail?.limit as { text?: string } | null)?.text, TEXT);
    const waitEvent = events.find((event) => event.event === 'session_limit_wait');
    assert.equal(waitEvent?.level, 'warn');
    assert.deepEqual(waitEvent?.detail, {
      window: 'five_hour',
      resets_at: resetsAt.toISOString(),
      retry_at: new Date(resetsAt.getTime() + 60_000).toISOString(),
      source: 'event',
      hits: 4,
      max_retries: 3,
    });

    // After the wait the next session starts; it fails with the limit again and waits again at once.
    const nextReset = new Date(resetsAt.getTime() + 5 * 3600_000);
    state.resetsAt = nextReset;
    s.clock.advance(wait);
    await fireRetry(s, wait);
    assert.equal(retry(s)?.limit?.hits, 5);
    assert.equal(retry(s)?.limit?.waiting, true);
    assert.equal(retry(s)?.limit?.resets_at, nextReset.toISOString());
    assert.deepEqual(s.timers.delays(), [nextReset.getTime() - s.clock.now().getTime() + 60_000]);

    // A successful run after the wait starts the count again.
    state.mode = 'ok';
    const secondWait = s.timers.delays()[0] ?? 0;
    s.clock.advance(secondWait);
    await fireRetry(s, secondWait);
    assert.equal(retry(s)?.kind, 'continuation');
    state.mode = 'limit';
    await fireRetry(s, 1_000);
    assert.equal(retry(s)?.limit?.hits, 1);
    assert.equal(retry(s)?.limit?.waiting, false);
    assert.deepEqual(s.timers.delays(), [10_000]);
  });

  it('honours agent.max_session_limit_retries: 1', async () => {
    const { s } = limitSetup({ front: { agent: { max_turns: 1, max_session_limit_retries: 1 } } });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'first retry');
    assert.equal(retry(s)?.limit?.max_retries, 1);
    await fireRetry(s, 10_000);
    assert.equal(retry(s)?.limit?.hits, 2);
    assert.equal(retry(s)?.limit?.waiting, true);
    assert.deepEqual(s.timers.delays(), [RESETS_AT.getTime() - s.clock.now().getTime() + 60_000]);
  });

  it('waits for the reset after the first failure with agent.max_session_limit_retries: 0', async () => {
    const { s } = limitSetup({ front: { agent: { max_turns: 1, max_session_limit_retries: 0 } } });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'first retry');
    assert.equal(retry(s)?.limit?.hits, 1);
    assert.equal(retry(s)?.limit?.max_retries, 0);
    assert.equal(retry(s)?.limit?.waiting, true);
    assert.deepEqual(s.timers.delays(), [RESETS_AT.getTime() - s.clock.now().getTime() + 60_000]);
  });

  it('waits exactly 60s when the reset time is in the past', async () => {
    const { s, state } = limitSetup({ front: { agent: { max_turns: 1, max_session_limit_retries: 0 } } });
    state.resetsAt = new Date(s.clock.now().getTime() - 3600_000);
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'first retry');
    assert.equal(retry(s)?.limit?.waiting, true);
    assert.deepEqual(s.timers.delays(), [60_000]);
  });

  for (const [name, resetsAt] of [
    ['unknown', () => null],
    ['invalid', () => new Date('not a date')],
    ['more than 8 days ahead', (now: Date) => new Date(now.getTime() + 9 * 24 * 3600_000)],
  ] as const) {
    it(`keeps the capped backoff when the reset time is ${name}`, async () => {
      const lines: string[] = [];
      const logger = Logger.create({ sinks: [{ name: 'memory', write: (line) => lines.push(line) }], level: 'info' });
      const { s, state } = limitSetup({ front: { agent: { max_turns: 1, max_session_limit_retries: 1 } }, logger });
      state.resetsAt = resetsAt(s.clock.now());
      await s.orchestrator.tickNow();
      await until(() => snapshot(s).retrying.length === 1, 3_000, 'first retry');
      assert.ok(!lines.some((line) => line.includes('reset time unknown')));
      await fireRetry(s, 10_000);
      // Beyond the cap the attempt drives the backoff, as for any failure.
      assert.equal(retry(s)?.limit?.hits, 2);
      assert.equal(retry(s)?.limit?.waiting, false);
      assert.deepEqual(s.timers.delays(), [failureBackoffMs(2, 300_000)]);
      assert.ok(lines.some((line) => line.includes('level=warn') && line.includes('session limit: reset time unknown; retrying with backoff')));
      assert.equal(s.orchestrator.issueTimeline('acme/app#a')?.events.some((event) => event.event === 'session_limit_wait'), false);
    });
  }

  it('applies a changed max_session_limit_retries to the next failure only', async () => {
    const { s } = limitSetup({ front: { agent: { max_turns: 1, max_session_limit_retries: 1 } } });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'first retry');
    s.workflow.current = makeWorkflow(baseFront(s.root, { agent: { max_turns: 1, max_session_limit_retries: 3 } }));
    assert.equal(retry(s)?.limit?.max_retries, 1);
    await fireRetry(s, 10_000);
    assert.equal(retry(s)?.limit?.hits, 2);
    assert.equal(retry(s)?.limit?.max_retries, 3);
    assert.equal(retry(s)?.limit?.waiting, false);
    assert.deepEqual(s.timers.delays(), [20_000]);
  });

  it('turns a woken waiting entry into a short backoff when it is requeued', async () => {
    const { s } = limitSetup({ front: { agent: { max_turns: 1, max_session_limit_retries: 0 } } });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'wait');
    const wait = s.timers.delays()[0] ?? 0;
    assert.equal(retry(s)?.limit?.waiting, true);

    s.clock.advance(wait);
    s.tracker.failNext = new Error('network down');
    s.timers.fire(wait);
    await until(() => /retry refresh failed/.test(retry(s)?.error ?? ''), 3_000, 'refresh requeue');
    assert.equal(retry(s)?.kind, 'session_limit');
    assert.equal(retry(s)?.limit?.waiting, false);
    assert.deepEqual(s.timers.delays(), [failureBackoffMs(2, 300_000)]);
  });

  it('writes the session_limit_wait history note', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
    const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
    const history = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
    const { s } = limitSetup({ history, front: { agent: { max_turns: 1, max_session_limit_retries: 0 } } });
    s.tracker.issueRepository = () => 'acme/app';
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'wait');

    const note = readHistory(history.dir, 'acme/app').entries.find((entry) => entry.event === 'session_limit_wait')?.fields ?? {};
    assert.equal(note.issue, 'acme/app#a');
    assert.equal(note.state, 'Todo');
    assert.equal(note.window, 'five_hour');
    assert.equal(note.resets_at, RESETS_AT.toISOString());
    assert.equal(note.retry_at, new Date(RESETS_AT.getTime() + 60_000).toISOString());
    assert.equal(note.hits, '1');
    assert.equal(note.max_retries, '0');
    assert.equal(note.source, 'event');
    assert.ok(note.title);
  });
  it('starts the count again after a normal run and after another failure', async () => {
    const { s, state } = limitSetup();
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'first retry');
    await fireRetry(s, 10_000);
    assert.equal(retry(s)?.limit?.hits, 2);

    state.mode = 'ok';
    await fireRetry(s, 20_000);
    assert.equal(retry(s)?.kind, 'continuation');
    state.mode = 'limit';
    await fireRetry(s, 1_000);
    assert.equal(retry(s)?.kind, 'session_limit');
    assert.equal(retry(s)?.limit?.hits, 1);
    assert.deepEqual(s.timers.delays(), [10_000]);

    state.mode = 'fail';
    await fireRetry(s, 10_000);
    assert.equal(retry(s)?.kind, 'failure');
    assert.equal(retry(s)?.limit, null);
    state.mode = 'limit';
    const delay = s.timers.delays()[0] ?? 0;
    await fireRetry(s, delay);
    assert.equal(retry(s)?.limit?.hits, 1);
    assert.deepEqual(s.timers.delays(), [10_000]);
  });

  it('starts the count again after a stalled run (limit → stalled → limit)', async () => {
    const { s, state } = limitSetup({ front: { agent: { max_turns: 1 }, claude: { stall_timeout_ms: 60_000 } } });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'first retry');
    await fireRetry(s, 10_000);
    assert.equal(retry(s)?.limit?.hits, 2);

    state.mode = 'hang';
    s.timers.fire(20_000);
    await until(() => snapshot(s).running[0]?.phase === 'StreamingTurn', 3_000, 'streaming');
    s.clock.advance(61_000);
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'stall retry');
    assert.equal(retry(s)?.kind, 'failure');
    assert.match(retry(s)?.error ?? '', /^stalled: /);

    state.mode = 'limit';
    // The stalled run was attempt 2; its retry uses the attempt-based backoff.
    await fireRetry(s, failureBackoffMs(3, 300_000));
    assert.equal(retry(s)?.limit?.hits, 1);
    assert.ok(s.timers.delays().includes(10_000));
  });

  it('keeps kind, limit and hits when a retry is requeued without running an agent', async () => {
    const { s } = limitSetup({ front: { agent: { max_turns: 1, max_concurrent_agents: 1 }, polling: { interval_ms: 7_000 } } });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'first retry');
    const before = retry(s)?.limit;

    // Tracker refresh fails: attempt + 1, same kind and limit.
    s.tracker.failNext = new Error('network down');
    s.timers.fire(10_000);
    await until(() => /retry refresh failed/.test(retry(s)?.error ?? ''), 3_000, 'refresh requeue');
    assert.equal(retry(s)?.kind, 'session_limit');
    assert.equal(retry(s)?.attempt, 2);
    assert.deepEqual(retry(s)?.limit, before);

    // Validation fails: attempt + 1, same kind and limit.
    s.workflow.lastError = { code: 'workflow_parse_error', message: 'bad yaml', at: new Date() };
    s.timers.fire(20_000);
    await until(() => /dispatch validation failed/.test(retry(s)?.error ?? ''), 3_000, 'validation requeue');
    assert.equal(retry(s)?.kind, 'session_limit');
    assert.equal(retry(s)?.attempt, 3);
    assert.deepEqual(retry(s)?.limit, before);
    s.workflow.lastError = null;

    // No free slot: same attempt, kind and limit.
    s.runner.script = () => new Promise(() => undefined);
    s.tracker.issues.set('b', makeIssue({ id: 'b', priority: 2 }));
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running.length === 1 && s.runner.sessions.length === 2, 3_000, 'b running');
    s.timers.fire(40_000);
    await until(() => retry(s)?.error === 'waiting for a free slot (1/1 busy)', 3_000, 'slot requeue');
    assert.equal(retry(s)?.kind, 'session_limit');
    assert.equal(retry(s)?.attempt, 3);
    assert.deepEqual(retry(s)?.limit, before);
    assert.equal(retry(s)?.limit?.text, TEXT);
    assert.equal(s.runner.sessions.length, 2);
  });

  it('logs run_finished with outcome=session_limit', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
    const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
    const history = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
    const { s } = limitSetup({ history });
    s.tracker.issueRepository = () => 'acme/app';
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'retry');

    const finished = readHistory(history.dir, 'acme/app').entries.find((entry) => entry.event === 'run_finished')?.fields ?? {};
    assert.equal(finished.outcome, 'session_limit');
    assert.match(finished.reason ?? '', /^session_limit: turn ended with an error: You've hit your session limit/);
    const event = s.orchestrator.issueTimeline('acme/app#a')?.events.find((entry) => entry.event === 'run_finished');
    assert.equal(event?.level, 'warn');
    assert.equal(event?.detail?.outcome, 'session_limit');
  });

  it('clamps the timer delay to 2^31-1 ms but keeps the real due_at', async () => {
    const { s } = limitSetup({ front: { agent: { max_turns: 1, max_retry_backoff_ms: 3_000_000_000, max_session_limit_retries: 100 } } });
    s.runner.sessions.length = 0;
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'first retry');
    for (let i = 0; i < 25 && s.timers.delays()[0] !== 2_147_483_647; i++) {
      const delay = s.timers.delays()[0] ?? 0;
      await fireRetry(s, delay);
    }
    assert.deepEqual(s.timers.delays(), [2_147_483_647]);
    const realDelay = Math.min(10_000 * 2 ** ((retry(s)?.attempt ?? 1) - 1), 3_000_000_000);
    assert.ok(realDelay > 2_147_483_647);
    assert.equal(retry(s)?.due_at, new Date(s.clock.now().getTime() + realDelay).toISOString());
  });

  it('keeps a waiting entry waiting when its timer fires before the wall clock reaches due_at', async () => {
    const { s } = limitSetup({ front: { agent: { max_turns: 1, max_session_limit_retries: 0 } } });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'waiting entry');
    const before = retry(s);
    assert.equal(before?.limit?.waiting, true);
    const wait = s.timers.delays()[0] ?? 0;
    const fetches: string[][] = [];
    const original = s.tracker.fetchIssuesByIds.bind(s.tracker);
    s.tracker.fetchIssuesByIds = async (ids: string[]) => {
      fetches.push(ids);
      return original(ids);
    };
    s.clock.advance(wait - 10_000);
    s.timers.fire(wait);
    await until(() => s.timers.delays().length === 1 && s.timers.delays()[0] === 10_000, 3_000, 'rescheduled');
    const after = retry(s);
    assert.equal(after?.kind, 'session_limit');
    assert.equal(after?.attempt, before?.attempt);
    assert.deepEqual(after?.limit, before?.limit);
    assert.equal(after?.due_at, before?.due_at);
    assert.equal(fetches.length, 0);
    assert.equal(s.runner.sessions.length, 1);

    s.clock.advance(10_000);
    s.timers.fire(10_000);
    await until(() => s.runner.sessions.length === 2, 3_000, 'dispatch');
    assert.equal(fetches.length, 1);
  });

  describe('reconcile of waiting entries', () => {
    async function waiting(front: Record<string, unknown> = {}) {
      const { s } = limitSetup({ front: { agent: { max_turns: 1, max_session_limit_retries: 0 }, ...front } });
      await s.orchestrator.tickNow();
      await until(() => snapshot(s).retrying.length === 1, 3_000, 'waiting entry');
      assert.equal(retry(s)?.limit?.waiting, true);
      return s;
    }
    const workspaceOf = (s: Setup) => path.join(fs.realpathSync(s.root), workspaceKey('acme/app#a'));

    for (const state of ['In review', 'Blocked', 'Backlog']) {
      it(`releases a waiting entry whose issue moves to ${state} within one tick`, async () => {
        const s = await waiting();
        s.tracker.set('a', { state });
        await s.orchestrator.tickNow();
        assert.equal(snapshot(s).counts.claimed, 0);
        assert.equal(snapshot(s).counts.retrying, 0);
        assert.deepEqual(s.timers.delays(), []);
        assert.ok(fs.existsSync(workspaceOf(s)), 'workspace kept');
      });
    }

    it('releases a waiting entry whose issue is no longer dispatchable', async () => {
      const s = await waiting();
      s.tracker.set('a', { dispatchable: false });
      await s.orchestrator.tickNow();
      assert.equal(snapshot(s).counts.claimed, 0);
      assert.equal(snapshot(s).counts.retrying, 0);
      assert.deepEqual(s.timers.delays(), []);
    });

    it('releases a waiting entry at Done and removes the workspace with cleanup_terminal', async () => {
      const s = await waiting();
      assert.ok(fs.existsSync(workspaceOf(s)));
      s.tracker.set('a', { state: 'Done' });
      await s.orchestrator.tickNow();
      assert.equal(snapshot(s).counts.claimed, 0);
      assert.equal(snapshot(s).counts.retrying, 0);
      assert.deepEqual(s.timers.delays(), []);
      await until(() => !fs.existsSync(workspaceOf(s)), 3_000, 'workspace removed');
    });

    it('keeps the workspace at Done when cleanup_terminal is false', async () => {
      const s = await waiting({ workspace: { cleanup_terminal: false } });
      s.tracker.set('a', { state: 'Done' });
      await s.orchestrator.tickNow();
      assert.equal(snapshot(s).counts.claimed, 0);
      assert.equal(snapshot(s).counts.retrying, 0);
      assert.ok(fs.existsSync(workspaceOf(s)));
    });

    it('releases a waiting entry whose issue was deleted', async () => {
      const s = await waiting();
      s.tracker.issues.delete('a');
      await s.orchestrator.tickNow();
      assert.equal(snapshot(s).counts.claimed, 0);
      assert.equal(snapshot(s).counts.retrying, 0);
      assert.deepEqual(s.timers.delays(), []);
    });

    it('keeps waiting when the issue is edited or relabelled but stays eligible', async () => {
      const s = await waiting();
      const before = retry(s);
      s.tracker.set('a', { updated_at: new Date(s.clock.now().getTime() + 1_000), labels: ['area:orchestrator'] });
      await s.orchestrator.tickNow();
      assert.equal(snapshot(s).counts.claimed, 1);
      assert.equal(retry(s)?.due_at, before?.due_at);
      assert.equal(retry(s)?.limit?.waiting, true);
      assert.equal(s.runner.sessions.length, 1);
    });

    it('keeps the waiting entry when the tracker call fails', async () => {
      const s = await waiting();
      s.tracker.failNext = new Error('tracker down');
      await s.orchestrator.tickNow();
      assert.equal(snapshot(s).counts.claimed, 1);
      assert.equal(retry(s)?.limit?.waiting, true);
      assert.equal(s.runner.sessions.length, 1);
    });
  });

  describe('dispatch gate', () => {
    type GateMode = { mode: 'limit'; window: string | null } | { mode: 'ok' } | { mode: 'hang' };

    /** Issues fail with a session limit of their window (waiting at once), end normally, or hang until stopped. */
    function gateSetup(modes: Record<string, GateMode>, issues: string[], logger?: Logger) {
      const runner = new FakeRunner((turn, params) => {
        const mode = modes[params.issue.id] ?? { mode: 'ok' };
        if (mode.mode === 'limit') {
          const resetsAt = new Date(s.clock.now().getTime() + 2 * 3600_000);
          return {
            ok: false,
            turnId: String(turn),
            code: 'session_limit',
            message: `turn ended with an error: ${TEXT}`,
            sessionLimit: { window: mode.window, ...limitScopeOf(mode.window, null), resetsAt, source: 'event', text: TEXT, overageDisabledReason: null },
          };
        }
        if (mode.mode === 'ok') return { ok: true, turnId: String(turn), resultText: 'done' };
        return new Promise((resolve) => params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: String(turn), code: 'turn_cancelled', message: 'cancelled' })));
      });
      const s = setup({
        runner,
        issues: issues.map((id) => makeIssue({ id })),
        front: { agent: { max_turns: 1, max_session_limit_retries: 0 } },
        ...(logger !== undefined ? { logger } : {}),
      });
      return s;
    }
    const waitingCount = (s: Setup) => snapshot(s).retrying.filter((row) => row.limit?.waiting === true).length;
    const sessionsOf = (s: Setup, id: string) => s.runner.sessions.filter((session) => session.params.issue.id === id).length;
    const addReady = (s: Setup, id: string) => s.tracker.issues.set(id, makeIssue({ id }));

    it('holds back new dispatches while a worker waits for a five_hour limit, until the wait ends', async () => {
      const lines: string[] = [];
      const logger = Logger.create({ sinks: [{ name: 'memory', write: (line) => lines.push(line) }], level: 'info' });
      const s = gateSetup({ a: { mode: 'limit', window: 'five_hour' }, c: { mode: 'hang' } }, ['a', 'c'], logger);
      await s.orchestrator.tickNow();
      await until(() => waitingCount(s) === 1, 3_000, 'waiting entry');
      const due = snapshot(s).retrying[0]?.due_at ?? '';
      assert.deepEqual(snapshot(s).health.dispatch_gate, { reason: 'session_limit', window: 'five_hour', until: due, issue_identifier: 'acme/app#a' });

      addReady(s, 'b');
      const fetches = s.tracker.calls.byStates;
      const refreshes = s.tracker.calls.byIds;
      await s.orchestrator.tickNow();
      await s.orchestrator.tickNow();
      assert.equal(s.orchestrator.issueDetail('b'), null, 'b not dispatched');
      // The board is still fetched, so the dashboard shows why b waits.
      assert.equal(s.tracker.calls.byStates, fetches + 2, 'the board stays current while gated');
      assert.ok(s.tracker.calls.byIds > refreshes, 'reconcile still runs');
      const queued = snapshot(s).queue.find((item) => item.issue_identifier === 'acme/app#b');
      assert.equal(queued?.reason.code, 'session_limit');
      assert.match(queued?.reason.text ?? '', /^new sessions paused until .* UTC: session limit \(five hour\)$/);
      assert.equal(snapshot(s).running[0]?.issue_identifier, 'acme/app#c');
      assert.equal(snapshot(s).running[0]?.stopping, null);
      assert.equal(waitingCount(s), 1, 'the retry timer is untouched');
      assert.equal(lines.filter((line) => line.includes(`dispatch paused until ${due}: session limit (five_hour)`)).length, 1);

      s.clock.advance(new Date(due).getTime() - s.clock.now().getTime());
      await s.orchestrator.tickNow();
      assert.equal(snapshot(s).health.dispatch_gate, null);
      await until(() => sessionsOf(s, 'b') === 1, 3_000, 'b dispatched');
      assert.equal(lines.filter((line) => line.includes('dispatch resumed')).length, 1);
    });

    for (const window of ['seven_day_opus', 'overage', null]) {
      it(`does not gate for a ${window ?? 'missing'} window`, async () => {
        const s = gateSetup({ a: { mode: 'limit', window } }, ['a']);
        await s.orchestrator.tickNow();
        await until(() => waitingCount(s) === 1, 3_000, 'waiting entry');
        assert.equal(snapshot(s).health.dispatch_gate, null);
        addReady(s, 'b');
        await s.orchestrator.tickNow();
        await until(() => sessionsOf(s, 'b') === 1, 3_000, 'b dispatched');
      });
    }

    it('keeps the gate while another entry waits; restart and release lift it once both are gone', async () => {
      const s = gateSetup({ a: { mode: 'limit', window: 'five_hour' }, c: { mode: 'limit', window: 'seven_day' } }, ['a', 'c']);
      await s.orchestrator.tickNow();
      await until(() => waitingCount(s) === 2, 3_000, 'two waiting entries');
      assert.equal(snapshot(s).health.dispatch_gate?.reason, 'session_limit');
      addReady(s, 'b');

      assert.equal((await s.orchestrator.restartWorker('acme/app#a')).ok, true);
      await s.orchestrator.tickNow();
      assert.equal(snapshot(s).health.dispatch_gate?.issue_identifier, 'acme/app#c');
      assert.equal(snapshot(s).health.dispatch_gate?.window, 'seven_day');
      assert.equal(s.orchestrator.issueDetail('b'), null, 'b not dispatched');

      s.tracker.set('c', { state: 'Backlog' });
      await s.orchestrator.tickNow();
      assert.equal(snapshot(s).health.dispatch_gate, null);
      await until(() => sessionsOf(s, 'b') === 1, 3_000, 'b dispatched');
    });

    it('keeps the gate when the other waiting entry is released, and lifts it after a restart of the last one', async () => {
      const s = gateSetup({ a: { mode: 'limit', window: 'five_hour' }, c: { mode: 'limit', window: 'five_hour' } }, ['a', 'c']);
      await s.orchestrator.tickNow();
      await until(() => waitingCount(s) === 2, 3_000, 'two waiting entries');
      addReady(s, 'b');

      s.tracker.set('a', { state: 'Backlog' });
      await s.orchestrator.tickNow();
      assert.equal(snapshot(s).health.dispatch_gate?.issue_identifier, 'acme/app#c');
      assert.equal(s.orchestrator.issueDetail('b'), null, 'b not dispatched');

      assert.equal((await s.orchestrator.restartWorker('c')).ok, true);
      assert.equal(snapshot(s).health.dispatch_gate, null);
      await s.orchestrator.tickNow();
      await until(() => sessionsOf(s, 'b') === 1, 3_000, 'b dispatched');
    });

    it('is lifted by a turn_completed after the limit was observed, not by one before it', async () => {
      const s = gateSetup({ a: { mode: 'limit', window: 'five_hour' }, c: { mode: 'ok' } }, ['c']);
      await s.orchestrator.tickNow();
      await until(() => snapshot(s).retrying.some((row) => row.kind === 'continuation'), 3_000, 'c finished a turn');

      // Less than the continuation delay: the tick leaves c's continuation to its timer.
      s.clock.advance(500);
      addReady(s, 'a');
      await s.orchestrator.tickNow();
      await until(() => waitingCount(s) === 1, 3_000, 'a waiting');
      addReady(s, 'b');
      await s.orchestrator.tickNow();
      assert.notEqual(snapshot(s).health.dispatch_gate, null, 'an earlier successful turn does not lift the gate');
      assert.equal(s.orchestrator.issueDetail('b'), null, 'b not dispatched');

      s.clock.advance(1_000);
      s.timers.fire(CONTINUATION_DELAY_MS);
      await until(() => sessionsOf(s, 'c') === 2 && !snapshot(s).running.some((row) => row.issue_identifier === 'acme/app#c'), 3_000, 'c ran again');
      assert.equal(snapshot(s).health.dispatch_gate, null);
      await s.orchestrator.tickNow();
      await until(() => sessionsOf(s, 'b') === 1, 3_000, 'b dispatched');
    });
  });

  it('does not dispatch when shutdown runs while the retry refresh is pending', async () => {
    const { s } = limitSetup();
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'first retry');
    const original = s.tracker.fetchIssuesByIds.bind(s.tracker);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let called = false;
    s.tracker.fetchIssuesByIds = async (ids: string[]) => {
      called = true;
      await gate;
      return original(ids);
    };
    s.timers.fire(10_000);
    await until(() => called, 3_000, 'fetch started');
    const stopped = s.orchestrator.shutdown(1_000);
    release();
    await stopped;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(s.runner.sessions.length, 1);
    assert.equal(snapshot(s).counts.claimed, 0);
  });
});

describe('reconciliation', () => {
  async function running(s: Setup, id: string) {
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running.some((r) => r.issue_id === id && r.phase === 'StreamingTurn'), 3_000, `${id} streaming`);
  }

  const hanging = () =>
    new FakeRunner((_turn, params) => new Promise((resolve) => params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: '1', code: 'turn_cancelled', message: 'cancelled' }))));

  it('stops a run and removes its workspace when the issue becomes terminal', async () => {
    const s = setup({ runner: hanging(), issues: [makeIssue({ id: 'a' })] });
    await running(s, 'a');
    const workspace = path.join(fs.realpathSync(s.root), workspaceKey('acme/app#a'));
    assert.ok(fs.existsSync(workspace));

    s.tracker.set('a', { state: 'Done' });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).counts.claimed === 0 && !fs.existsSync(workspace), 3_000, 'cleanup');
    assert.equal(snapshot(s).retrying.length, 0);
  });

  it('stops a run without cleanup when the issue leaves the active states', async () => {
    const s = setup({ runner: hanging(), issues: [makeIssue({ id: 'a' })] });
    await running(s, 'a');
    s.tracker.set('a', { state: 'Human Review' });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).counts.claimed === 0, 3_000, 'released');
    assert.ok(fs.existsSync(path.join(fs.realpathSync(s.root), workspaceKey('acme/app#a'))));
  });

  it('updates the running snapshot while the issue stays active, and keeps workers when refresh fails', async () => {
    const s = setup({ runner: hanging(), issues: [makeIssue({ id: 'a' })] });
    await running(s, 'a');
    s.tracker.set('a', { state: 'In Progress', title: 'Renamed' });
    await s.orchestrator.tickNow();
    assert.equal(snapshot(s).running[0]?.state, 'In Progress');
    assert.equal(snapshot(s).running[0]?.title, 'Renamed');

    s.tracker.failNext = new Error('network down');
    await s.orchestrator.tickNow();
    assert.equal(snapshot(s).running.length, 1);
    assert.equal(snapshot(s).running[0]?.stopping, null);
  });

  it('kills stalled runs and schedules a retry', async () => {
    const s = setup({ runner: hanging(), front: { claude: { stall_timeout_ms: 60_000 } }, issues: [makeIssue({ id: 'a' })] });
    await running(s, 'a');
    s.clock.advance(61_000);
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'stall retry');
    assert.match(snapshot(s).retrying[0]?.error ?? '', /stalled: no agent activity/);
  });

  it('does not count workspace preparation as a stall', async () => {
    const s = setup({
      runner: hanging(),
      front: {
        claude: { stall_timeout_ms: 60_000 },
        hooks: { before_run: 'while [ ! -f "$SYMPHONY_WORKSPACE/go" ]; do sleep 0.02; done' },
      },
      issues: [makeIssue({ id: 'a' })],
    });
    const workspace = path.join(fs.realpathSync(s.root), workspaceKey('acme/app#a'));
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running[0]?.phase === 'PreparingWorkspace' && fs.existsSync(workspace), 3_000, 'preparing');
    s.clock.advance(120_000);
    await s.orchestrator.tickNow();
    assert.equal(snapshot(s).running[0]?.stopping, null);

    fs.writeFileSync(path.join(workspace, 'go'), '');
    await until(() => snapshot(s).running[0]?.phase === 'StreamingTurn', 3_000, 'streaming');
    s.clock.advance(30_000);
    await s.orchestrator.tickNow();
    assert.equal(snapshot(s).running[0]?.stopping, null, 'stall time counts from the end of preparation');
    s.clock.advance(31_000);
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'stall retry');
  });
});

describe('auto_merge waiting for pull request checks', () => {
  it('retries the merge of waiting issues each tick, one attempt per issue at a time, and leaves the rest alone', async () => {
    const s = setup({
      issues: [
        makeIssue({ id: 'w', identifier: 'acme/app#w', state: 'Human Review', labels: ['awaiting-checks'] }),
        makeIssue({ id: 'h', identifier: 'acme/app#h', state: 'Human Review' }),
      ],
    });
    const calls: string[] = [];
    let release: (() => void) | null = null;
    let outcome: 'pending' | 'merged' = 'pending';
    let finished = 0;
    s.tracker.mergeWatch = () => ({
      column: 'Human Review',
      awaiting: (issue) => issue.labels.includes('awaiting-checks'),
      retry: async (issue) => {
        calls.push(issue.id);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (outcome === 'merged') s.tracker.set(issue.id, { state: 'Done', labels: [] });
        finished++;
        return { merged: outcome === 'merged', pull_request: 7, status: outcome === 'merged' ? 'Done' : 'Human Review', reason: outcome, ...(outcome === 'pending' ? { awaiting_checks: true } : {}) };
      },
    });

    await s.orchestrator.tickNow();
    await until(() => calls.length === 1, 3_000, 'first retry');
    assert.deepEqual(calls, ['w']);
    await s.orchestrator.tickNow();
    assert.equal(calls.length, 1, 'no second attempt while one is in flight');
    (release as unknown as () => void)();
    await until(() => finished === 1, 3_000, 'first retry finished');
    await new Promise((resolve) => setImmediate(resolve));

    outcome = 'merged';
    await s.orchestrator.tickNow();
    await until(() => calls.length === 2, 3_000, 'second retry');
    (release as unknown as () => void)();
    await until(() => s.tracker.issues.get('w')?.state === 'Done', 3_000, 'merged');
    await s.orchestrator.tickNow();
    assert.equal(calls.length, 2, 'a merged issue is not retried');
    assert.equal(snapshot(s).running.length, 0, 'no session for issues in the merge column');
    await s.orchestrator.shutdown(1_000);
  });
});

describe('observability', () => {
  it('accumulates token and cost deltas from absolute session totals', async () => {
    const runner = new FakeRunner((turn, params) => {
      const usage = turn === 1 ? { inputTokens: 100, outputTokens: 10, totalTokens: 110 } : { inputTokens: 250, outputTokens: 30, totalTokens: 280 };
      params.onEvent({ event: 'turn_completed', timestamp: new Date(), pid: 1, threadId: 't', turnId: String(turn), sessionId: `t-${turn}`, turnCount: turn, usage, costUsd: turn * 0.5 });
      return { ok: true, turnId: String(turn), resultText: '' };
    });
    const s = setup({ runner, front: { agent: { max_turns: 2 } }, issues: [makeIssue({ id: 'a' })] });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'finished');
    const totals = snapshot(s).agent_totals;
    assert.deepEqual([totals.input_tokens, totals.output_tokens, totals.total_tokens, totals.cost_usd], [250, 30, 280, 1]);
  });

  it('serves per-issue details for running issues and null for unknown ones', async () => {
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const s = setup({ runner, issues: [makeIssue({ id: 'a' })] });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running[0]?.turn_count === 1, 3_000, 'first turn');
    const detail = s.orchestrator.issueDetail('acme/app#a');
    assert.equal(detail?.status, 'running');
    assert.equal(detail?.running?.turn_count, 1);
    assert.equal(s.orchestrator.issueDetail('nope'), null);
  });

  it('skips dispatch but keeps reconciling when validation fails', async () => {
    const s = setup({ issues: [makeIssue({ id: 'a' })] });
    s.workflow.lastError = { code: 'workflow_parse_error', message: 'bad yaml', at: new Date() };
    await s.orchestrator.tickNow();
    assert.equal(s.runner.sessions.length, 0);
    assert.match(snapshot(s).health.dispatch_errors.join(), /bad yaml/);
  });

  it('exposes agent.max_session_limit_retries in the health snapshot', () => {
    const s = setup({ front: { agent: { max_session_limit_retries: 5 } }, issues: [] });
    assert.equal(snapshot(s).health.max_session_limit_retries, 5);
  });
});

describe('health.repositories', () => {
  const repos = (repositories: unknown, env: NodeJS.ProcessEnv = {}) => {
    const provider: Record<string, unknown> = { owner: 'acme', project_number: 1, token: 'test-token' };
    if (repositories !== undefined) provider.repositories = repositories;
    const s = setup({ front: { tracker: { kind: 'github_project', provider } }, env, issues: [] });
    return snapshot(s).health.repositories;
  };

  it('lists a single configured repository', () => {
    assert.deepEqual(repos('$GITHUB_REPOSITORY', { GITHUB_REPOSITORY: 'acme/app' }), ['acme/app']);
  });

  it('lists several repositories once each, in configuration order', () => {
    assert.deepEqual(repos('$GITHUB_REPOSITORY', { GITHUB_REPOSITORY: 'acme/app,acme/api, acme/app' }), ['acme/app', 'acme/api']);
    assert.deepEqual(repos(['acme/app', 'acme/api']), ['acme/app', 'acme/api']);
  });

  it('is null without a restriction and skips invalid names', () => {
    assert.equal(repos(undefined), null);
    assert.equal(repos('$GITHUB_REPOSITORY', {}), null);
    assert.deepEqual(repos('acme/app not-a-repo'), ['acme/app']);
  });
});

describe('runtimeStateFile', () => {
  it('keeps the state file name for the configured repositories', () => {
    const tracker = { kind: 'github_project', provider: { repositories: '$R' } };
    assert.equal(runtimeStateFile('/logs', tracker, { R: 'Acme/B, acme/a acme/b' }), '/logs/state/acme_a+acme_b.json');
    assert.equal(runtimeStateFile('/logs', { kind: 'github_project', provider: {} }, {}), '/logs/state/github_project.json');
  });
});

describe('execution timeline', () => {
  it('records lifecycle steps, phase transitions and agent events in order, readable incrementally', async () => {
    const runner = new FakeRunner((turn, params) => {
      params.onEvent({ event: 'tool_use', timestamp: new Date(), pid: 1, threadId: 't', turnId: '1', sessionId: 't-1', turnCount: turn, message: 'Bash: ls', detail: { tool: 'Bash' } });
      params.onEvent({ event: 'tool_result', timestamp: new Date(), pid: 1, threadId: 't', turnId: '1', sessionId: 't-1', turnCount: turn });
      params.onEvent({
        event: 'turn_failed', timestamp: new Date(), pid: 1, threadId: 't', turnId: '1', sessionId: 't-1', turnCount: turn, message: 'boom',
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, detail: { duration_ms: 1500 },
      });
      return { ok: false, turnId: String(turn), code: 'turn_failed', message: 'boom' };
    });
    const s = setup({ runner, issues: [makeIssue({ id: 'a', title: 'Fix it' })] });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'failure retry');

    const timeline = s.orchestrator.issueTimeline('acme/app#a');
    assert.ok(timeline !== null);
    const events = timeline.events.map((e) => e.event);
    assert.equal(events[0], 'run_dispatched');
    assert.ok(events.includes('phase'));
    assert.ok(events.indexOf('tool_use') < events.indexOf('turn_failed'));
    assert.ok(!events.includes('tool_result'), 'events without message or detail are not kept');
    assert.deepEqual(events.slice(-2), ['run_finished', 'retry_scheduled']);
    const phases = timeline.events.filter((e) => e.kind === 'phase').map((e) => e.detail?.to);
    assert.deepEqual(phases.slice(0, 2), ['LaunchingAgentProcess', 'BuildingPrompt']);
    const failed = timeline.events.find((e) => e.event === 'turn_failed');
    assert.equal(failed?.level, 'warn');
    assert.deepEqual(failed?.detail?.usage, { input_tokens: 100, output_tokens: 20, total_tokens: 120 });
    const finished = timeline.events.find((e) => e.event === 'run_finished');
    assert.equal(finished?.detail?.outcome, 'failed');
    assert.equal(finished?.level, 'error');
    assert.match(String(finished?.detail?.reason), /turn_failed: boom/);
    const retry = timeline.events.at(-1);
    assert.deepEqual([retry?.detail?.attempt, retry?.detail?.kind], [1, 'failure']);
    assert.deepEqual(timeline.events.map((e) => e.seq), timeline.events.map((_, i) => i + 1));

    const later = s.orchestrator.issueTimeline('a', timeline.latest_seq - 1);
    assert.deepEqual(later?.events.map((e) => e.event), ['retry_scheduled']);

    const detail = s.orchestrator.issueDetail('a');
    assert.equal(detail?.title, 'Fix it');
    assert.equal(detail?.timeline_seq, timeline.latest_seq);
    assert.equal(detail?.sessions.length, 1);
    assert.equal(detail?.sessions[0]?.outcome, 'failed');
    assert.equal(detail?.sessions[0]?.transcript, null);
    // The dashboard's recent_events stay the agent events with a message.
    assert.deepEqual(detail?.recent_events.map((e) => e.event), ['tool_use', 'turn_failed']);
    assert.equal(s.orchestrator.issueTimeline('nope'), null);
    assert.deepEqual(s.orchestrator.issueTranscript('a', null), { run: detail?.sessions[0]?.run, available: false, reason: 'session transcripts are disabled (no log directory)' });
  });

  it('serves the session transcript of a run when a log directory is set', async () => {
    const runner = new FakeRunner((turn, params) => {
      const file = params.transcriptPath as string;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify({ at: '2026-10-03T12:00:00.000Z', prompt: { turn, text: 'Work on it' } })}\n`);
      fs.appendFileSync(
        file,
        `${JSON.stringify({ at: '2026-10-03T12:00:01.000Z', message: { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 1000, output_tokens: 100 } } } })}\n`,
      );
      return new Promise(() => undefined);
    });
    const logDir = tempDir();
    const s = setup({ runner, logDir, issues: [makeIssue({ id: 'a' })] });
    await s.orchestrator.tickNow();
    await until(() => (s.orchestrator.issueTranscript('a', null)?.entries?.length ?? 0) === 2, 3_000, 'transcript lines');
    const transcript = s.orchestrator.issueTranscript('a', null);
    assert.equal(transcript?.available, true);
    assert.ok(s.orchestrator.issueTranscriptFile('a', null)?.startsWith(path.join(logDir, 'sessions')));
    assert.deepEqual(transcript?.entries?.map((e) => e.type), ['prompt', 'model_call']);
    const call = transcript?.entries?.[1];
    assert.ok(call?.type === 'model_call');
    assert.equal(call.cost_usd, null, 'no price table configured');
    const rest = s.orchestrator.issueTranscript('a', transcript?.run ?? null, transcript?.next_offset);
    assert.deepEqual(rest?.entries, []);
    assert.equal(s.orchestrator.issueTranscript('a', 'unknown-run')?.available, false);
  });
});

describe('board column preflight', () => {
  const BOARD = ['Backlog', 'Todo', 'Agent review', 'In review', 'Done'];
  const front = (reviewState: string) => ({
    tracker: {
      kind: 'github_project',
      provider: { owner: 'acme', project_number: 1, token: 'test-token' },
      active_states: ['Todo', reviewState],
      terminal_states: ['Done'],
    },
    roles: { developer: { states: ['Todo'] }, reviewer: { states: [reviewState], may_move_to: ['in review'] } },
  });

  it('blocks dispatch on an unknown column and clears the error after a reload', async () => {
    const s = setup({ front: front('Agent Reviw'), issues: [makeIssue({ id: 'a' })] });
    s.tracker.statusOptions = async () => {
      s.tracker.calls.statusOptions++;
      return BOARD;
    };
    await s.orchestrator.tickNow();
    assert.equal(s.runner.sessions.length, 0);
    assert.match(snapshot(s).health.dispatch_errors.join(), /unknown board column "Agent Reviw" \(valid: Backlog, Todo, Agent review/);
    await s.orchestrator.tickNow();
    assert.equal(s.tracker.calls.statusOptions, 1, 'fetched once per workflow version');

    const fixed = makeWorkflow(baseFront(s.root, front('agent REVIEW')));
    s.workflow.current = { ...fixed, version: 2 };
    await s.orchestrator.tickNow();
    assert.deepEqual(snapshot(s).health.dispatch_errors, []);
    await until(() => s.runner.sessions.length === 1, 3_000, 'dispatch after fix');
  });

  it('reports a failed options fetch as a tracker error, not a validation error', async () => {
    const s = setup({ issues: [makeIssue({ id: 'a' })] });
    s.tracker.statusOptions = async () => {
      throw new Error('board unreachable');
    };
    await s.orchestrator.tickNow();
    assert.deepEqual(snapshot(s).health.dispatch_errors, []);
    assert.equal(s.tracker.calls.byStates, 1);
  });
});

describe('continuation limit and terminal cleanup', () => {
  it('pauses an issue that stays active after max_continuations sessions and resumes it when it changes', async () => {
    const s = setup({ front: { agent: { max_turns: 1, max_continuations: 1 } }, issues: [makeIssue({ id: 'a' })] });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'first continuation retry');

    s.timers.fire(1_000);
    await until(() => s.runner.sessions.length === 2 && snapshot(s).retrying.length === 1, 3_000, 'continuation session');

    s.timers.fire(1_000);
    await until(() => snapshot(s).counts.paused === 1, 3_000, 'paused');
    assert.deepEqual([snapshot(s).counts.running, snapshot(s).counts.retrying, snapshot(s).counts.claimed], [0, 0, 1]);
    assert.equal(snapshot(s).paused[0]?.continuations, 1);
    assert.equal(s.orchestrator.issueDetail('a')?.status, 'paused');

    // Unchanged on the tracker: stays paused, nothing new starts.
    await s.orchestrator.tickNow();
    assert.equal(s.runner.sessions.length, 2);
    assert.equal(snapshot(s).counts.paused, 1);

    // A human comments (updated_at changes): the issue resumes in the same tick.
    s.tracker.set('a', { updated_at: new Date('2026-10-04T08:00:00Z') });
    await s.orchestrator.tickNow();
    await until(() => s.runner.sessions.length === 3, 3_000, 'resumed session');
    assert.equal(snapshot(s).counts.paused, 0);
  });

  it('releases a paused issue that leaves the active states', async () => {
    const s = setup({ front: { agent: { max_turns: 1, max_continuations: 0 } }, issues: [makeIssue({ id: 'a' })] });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'retry');
    s.timers.fire(1_000);
    await until(() => snapshot(s).counts.paused === 1, 3_000, 'paused');
    s.tracker.set('a', { state: 'In review' });
    await s.orchestrator.tickNow();
    assert.equal(snapshot(s).counts.claimed, 0);
  });

  it('keeps workspaces of terminal issues when cleanup_terminal is false', async () => {
    const runner = new FakeRunner((_turn, params) => new Promise((resolve) => params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: '1', code: 'turn_cancelled', message: 'cancelled' }))));
    const s = setup({ runner, front: { workspace: { cleanup_terminal: false } }, issues: [makeIssue({ id: 'a' })] });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running[0]?.phase === 'StreamingTurn', 3_000, 'streaming');
    s.tracker.set('a', { state: 'Done' });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).counts.claimed === 0, 3_000, 'released');
    assert.ok(fs.existsSync(path.join(fs.realpathSync(s.root), workspaceKey('acme/app#a'))));
  });
});

describe('workspace cleanup after release', () => {
  it('deletes the workspace of a finished issue once it reaches Done, within one tick', async () => {
    const s = setup({ issues: [makeIssue({ id: 'a' })] });
    s.runner.script = (turn) => {
      s.tracker.set('a', { state: 'In review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    };
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'continuation retry');
    s.timers.fire(1_000);
    await until(() => snapshot(s).counts.claimed === 0, 3_000, 'released');
    const workspace = path.join(fs.realpathSync(s.root), workspaceKey('acme/app#a'));
    assert.ok(fs.existsSync(workspace), 'workspace kept while In review');

    await s.orchestrator.tickNow();
    assert.ok(fs.existsSync(workspace), 'still kept on the next tick');

    s.tracker.set('a', { state: 'Done' });
    await s.orchestrator.tickNow();
    await until(() => !fs.existsSync(workspace), 3_000, 'workspace removed');
  });
});

describe('issue archive', () => {
  it('keeps the details of a released issue and serves them again after a restart', async () => {
    const logDir = tempDir();
    const s = setup({ logDir, issues: [makeIssue({ id: 'a', title: 'Archive me', labels: ['effort: high'] })] });
    s.runner.script = (turn, params) => {
      fs.mkdirSync(path.dirname(params.transcriptPath as string), { recursive: true });
      fs.appendFileSync(params.transcriptPath as string, `${JSON.stringify({ at: '2026-10-03T12:00:00.000Z', prompt: { turn, text: 'Work on it' } })}\n`);
      params.onEvent({ event: 'tool_use', timestamp: new Date(), pid: 1, threadId: 't', turnId: '1', sessionId: 't-1', turnCount: turn, message: 'Bash: ls', detail: { tool: 'Bash' } });
      s.tracker.set('a', { state: 'In review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    };
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'continuation retry');
    // Still claimed: the live record answers, but a snapshot is already on disk.
    assert.equal(s.orchestrator.issueDetail('acme/app#a')?.status, 'retrying');
    const file = path.join(logDir, 'issues', 'acme_app_a.json');
    assert.ok(fs.existsSync(file), 'snapshot written when the run finished');
    assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as { released: boolean }).released, false);
    s.timers.fire(1_000);
    await until(() => snapshot(s).counts.claimed === 0, 3_000, 'released');

    const detail = s.orchestrator.issueDetail('acme/app#a');
    assert.equal(detail?.status, 'finished');
    assert.equal(detail?.title, 'Archive me');
    assert.equal(detail?.role, 'default');
    assert.equal(detail?.running, null);
    assert.equal(detail?.archived?.released, true);
    assert.equal(detail?.attempts.runs, 1);
    assert.equal(detail?.sessions.length, 1);
    assert.equal(detail?.sessions[0]?.outcome, 'handed_off');
    assert.equal(detail?.sessions[0]?.effort, 'high');
    assert.equal(detail?.run_trace?.tool_calls && (detail.run_trace.tool_calls as Record<string, number>).Bash, 1);
    assert.equal(s.orchestrator.issueDetail('a')?.status, 'finished', 'found by issue id too');
    const timeline = s.orchestrator.issueTimeline('acme/app#a');
    assert.ok(timeline !== null && timeline.events.some((e) => e.event === 'tool_use') && timeline.events.some((e) => e.event === 'run_finished'));
    assert.equal(timeline.latest_seq, detail?.timeline_seq);
    assert.equal(s.orchestrator.issueTranscript('acme/app#a', null)?.available, true);
    assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as { released: boolean }).released, true);

    // A new orchestrator (restart) reads the archive from the log directory.
    const fresh = setup({ logDir, issues: [] });
    const again = fresh.orchestrator.issueDetail('acme/app#a');
    assert.equal(again?.status, 'finished');
    assert.equal(again?.timeline_seq, detail?.timeline_seq);
    assert.equal(fresh.orchestrator.issueTimeline('acme/app#a')?.events.length, timeline.events.length);
    assert.deepEqual(fresh.orchestrator.issueTimeline('acme/app#a', timeline.latest_seq)?.events, []);
    assert.equal(fresh.orchestrator.issueTranscript('acme/app#a', null)?.available, true);
    assert.ok(fresh.orchestrator.issueTranscriptFile('acme/app#a', null)?.startsWith(path.join(logDir, 'sessions')));
    assert.equal(fresh.orchestrator.issueDetail('nope'), null);
    assert.equal(fresh.orchestrator.issueTimeline('nope'), null);
  });

  it('still reads archives written in version 1 and fills in what they lack', () => {
    const logDir = tempDir();
    const stage = { id: 'default', label: 'default', kind: 'agent', columns: ['Todo'], status: 'done', sessions: [{ run: 'r1', attempt: null, role: 'default', state: 'Todo', model: null, effort: null, started_at: '2026-10-03T12:00:00.000Z', finished_at: null, outcome: 'handed_off' }] };
    fs.mkdirSync(path.join(logDir, 'issues'), { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'issues', 'acme_app_old.json'),
      JSON.stringify({
        version: 1,
        pipeline: [stage],
        issue_id: 'old',
        issue_identifier: 'acme/app#old',
        issue_url: null,
        title: 'Old archive',
        repo: null,
        workspace_path: null,
        runs: 1,
        continuations: 0,
        last_error: null,
        archived_at: '2026-10-03T12:00:00.000Z',
        released: true,
        completed_before: false,
        timeline: [],
        next_seq: 1,
        sessions: [],
        run_trace: null,
        last_check: null,
      }),
    );
    const detail = setup({ logDir, issues: [] }).orchestrator.issueDetail('acme/app#old');
    assert.equal(detail?.status, 'finished');
    assert.equal(detail?.title, 'Old archive');
    assert.deepEqual(detail?.results, []);
    assert.equal(detail?.gate, null);
    assert.equal(detail?.pipeline[0]?.verdict, null);
    assert.equal(detail?.pipeline[0]?.round, null);
    assert.equal(detail?.pipeline[0]?.sessions[0]?.verdict, null);
  });

  it('serves released issues from memory without a log directory, but not issues that never ran', async () => {
    const s = setup({ issues: [makeIssue({ id: 'a' })] });
    s.runner.script = (turn) => {
      s.tracker.set('a', { state: 'In review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    };
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'continuation retry');
    s.timers.fire(1_000);
    await until(() => snapshot(s).counts.claimed === 0, 3_000, 'released');
    assert.equal(s.orchestrator.issueDetail('acme/app#a')?.status, 'finished');
    assert.equal(s.orchestrator.issueDetail('acme/app#a')?.sessions[0]?.transcript, null);
    assert.equal(s.orchestrator.issueTranscript('acme/app#a', null)?.available, false);
    assert.equal(s.orchestrator.issueDetail('acme/app#b'), null);
  });
});

describe('workspace lock', () => {
  it('starts no hooks or session when another instance holds the workspace', async () => {
    const s = setup({ issues: [makeIssue({ id: 'a' })] });
    const root = fs.realpathSync(s.root);
    fs.writeFileSync(
      path.join(root, `${workspaceKey('acme/app#a')}.lock`),
      JSON.stringify({ pid: process.pid, hostname: 'other-host', instance: 'foreign', acquiredAt: 'x' }),
    );
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).counts.claimed === 0 && snapshot(s).counts.running === 0, 3_000, 'claim released');
    assert.equal(s.runner.sessions.length, 0);
    assert.ok(!fs.existsSync(path.join(root, workspaceKey('acme/app#a'))), 'no workspace created');
    assert.equal(snapshot(s).retrying.length, 0);
  });
});

describe('run history', () => {
  it('logs run start and finish with tokens, model and cost to the repository log', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\nopus: { input: 4, output: 20 }\n');
    const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
    const history = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
    const runner = new FakeRunner((turn, params) => {
      params.onEvent({
        event: 'turn_completed', timestamp: new Date(), pid: 1, threadId: 'thread-9', turnId: '1', sessionId: 'thread-9-1', turnCount: 1,
        usage: { inputTokens: 1_100_000, outputTokens: 100_000, totalTokens: 1_200_000 },
        modelUsage: { 'claude-opus-5-5': { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 100_000, cacheWriteTokens: 0 } },
        costUsd: 9.99,
      });
      s.tracker.set('a', { state: 'In review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    });
    const root = tempDir();
    const tracker = new FakeTracker([makeIssue({ id: 'a' })]);
    tracker.issueRepository = () => 'acme/app';
    const s = {
      tracker,
      orchestrator: new Orchestrator({
        workflow: new StaticWorkflow(makeWorkflow(baseFront(root, { claude: { model: 'opus' } }))),
        runner,
        logger: Logger.silent(),
        env: {},
        logDir: null,
        timers: new ManualTimers(),
        createAdapter: () => tracker,
        pricing,
        history,
      }),
    };
    await s.orchestrator.tickNow();
    await until(() => s.orchestrator.snapshot().retrying.length === 1, 3_000, 'run finished');

    const entries = readHistory(history.dir, 'acme/app').entries;
    assert.deepEqual(entries.map((e) => e.event), ['run_started', 'run_finished', 'model_usage']);
    const finished = entries[1]?.fields ?? {};
    assert.equal(finished.issue, 'acme/app#a');
    assert.equal(finished.outcome, 'handed_off');
    assert.equal(finished.state, 'In review');
    assert.equal(finished.model, 'claude-opus-5-5');
    assert.equal(finished.session, 'thread-9');
    assert.equal(finished.total_tokens, '1200000');
    // 1M input × $4 + 0.1M output × $20 + 0.1M cache reads × $0.40 (10% of input) = $6.04
    assert.equal(finished.cost_usd, '6.04');
    assert.equal(finished.claude_estimate_usd, '9.99');
    assert.equal(s.orchestrator.snapshot().agent_totals.cost_usd, 6.04);
    assert.equal(entries[0]?.fields.model, 'opus');
    assert.equal(finished.mcp_unavailable, undefined);
  });

  it('logs effort and requested model, and the usage counted from model calls when a run is stopped mid-turn', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\nfable: { input: 10, output: 50 }\n');
    const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
    const history = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
    const tracker = new FakeTracker([makeIssue({ id: 'a', labels: ['model: fable', 'effort: xhigh'] })]);
    tracker.issueRepository = () => 'acme/app';
    const runner = new FakeRunner((_turn, params) => {
      params.onEvent({
        event: 'model_call', timestamp: new Date(), pid: 1, threadId: 't', turnId: '1', sessionId: 't-1', turnCount: 1,
        modelUsage: { 'claude-fable-5-1': { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        context: { model: 'claude-fable-5-1', window: 200_000, tokens: 90_000, percent: 45, peakPercent: 60, compacts: 1, preTokens: 120_000 },
      });
      // The issue moves on the board during the turn: the orchestrator stops the agent before any turn result.
      tracker.set('a', { state: 'In review' });
      return new Promise((resolve) => params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: '1', code: 'turn_cancelled', message: 'cancelled' })));
    });
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), { claude: { model: 'opus' } }))),
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => tracker,
      pricing,
      history,
    });
    await orchestrator.tickNow();
    await until(() => orchestrator.snapshot().running[0]?.tokens.total_tokens === 1_100_000, 3_000, 'live usage');
    const running = orchestrator.snapshot().running[0];
    assert.equal(running?.model, 'claude-fable-5-1');
    assert.equal(running?.effort, 'xhigh');
    assert.equal(running?.cost_usd, 15);
    assert.deepEqual(running?.context, { tokens: 90_000, window: 200_000, percent: 45, compacts: 1 });
    await orchestrator.tickNow();
    await until(() => orchestrator.snapshot().counts.claimed === 0, 3_000, 'stopped and released');

    const entries = readHistory(history.dir, 'acme/app').entries;
    assert.deepEqual(entries.map((e) => e.event), ['run_started', 'run_finished', 'model_usage']);
    assert.equal(entries[0]?.fields.model, 'fable');
    assert.equal(entries[0]?.fields.effort, 'xhigh');
    const finished = entries[1]?.fields ?? {};
    assert.equal(finished.outcome, 'stopped');
    assert.equal(finished.context_peak_percent, '60');
    assert.equal(finished.context_compacts, '1');
    assert.equal(finished.model, 'claude-fable-5-1');
    assert.equal(finished.model_requested, 'fable');
    assert.equal(finished.effort, 'xhigh');
    assert.equal(finished.total_tokens, '1100000');
    // 1M input × $10 + 0.1M output × $50 = $15
    assert.equal(finished.cost_usd, '15');
    assert.equal(entries[2]?.fields.model, 'claude-fable-5-1');
    assert.equal(entries[2]?.fields.effort, 'xhigh');
  });

  it('tells the agent about unavailable MCP servers on turn 1 and records them in run_finished', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
    const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
    const history = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
    const tracker = new FakeTracker([makeIssue({ id: 'a' })]);
    tracker.issueRepository = () => 'acme/app';
    const runner = new FakeRunner((turn) => {
      if (turn === 2) tracker.set('a', { state: 'In review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    });
    runner.mcpStatus = { 'laravel-boost': 'failed', other: 'connected' };
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), { agent: { max_turns: 3 } }))),
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => tracker,
      pricing,
      history,
    });
    await orchestrator.tickNow();
    await until(() => orchestrator.snapshot().retrying.length === 1, 3_000, 'run finished');

    const [first, second] = runner.sessions[0]?.turns ?? [];
    assert.ok(first?.startsWith('MCP server `laravel-boost` is unavailable (failed); do not call its tools.\n\n'));
    assert.match(first ?? '', /Work on acme\/app#a/);
    assert.ok(!first?.includes('`other`'));
    assert.ok(!second?.includes('MCP server'));
    const finished = readHistory(history.dir, 'acme/app').entries.find((entry) => entry.event === 'run_finished');
    assert.equal(finished?.fields.mcp_unavailable, 'laravel-boost');
  });

  it('adds no MCP note when every added server connected', async () => {
    const runner = new FakeRunner(() => new Promise(() => undefined));
    runner.mcpStatus = { 'laravel-boost': 'connected' };
    const s = setup({ runner, issues: [makeIssue({ id: 'a' })] });
    await s.orchestrator.tickNow();
    await until(() => (runner.sessions[0]?.turns.length ?? 0) === 1, 3_000, 'turn 1');
    assert.ok(!runner.sessions[0]?.turns[0]?.includes('MCP server'));
    assert.match(runner.sessions[0]?.turns[0] ?? '', /^Work on acme\/app#a/);
  });

  it('logs the model a "Model:" label picked when the run starts', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
    const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
    const history = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
    const tracker = new FakeTracker([makeIssue({ id: 'a', labels: ['bug', 'model: sonnet-5-5'] })]);
    tracker.issueRepository = () => 'acme/app';
    const runner = new FakeRunner((turn) => {
      tracker.set('a', { state: 'In review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    });
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), { claude: { model: 'opus' } }))),
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => tracker,
      pricing,
      history,
    });
    await orchestrator.tickNow();
    await until(() => orchestrator.snapshot().retrying.length === 1, 3_000, 'run finished');

    const started = readHistory(history.dir, 'acme/app').entries.find((entry) => entry.event === 'run_started');
    assert.equal(started?.fields.model, 'claude-sonnet-5-5');
    assert.equal(started?.fields.role, 'default');
    assert.equal(runner.sessions[0]?.params.config.model, 'claude-sonnet-5-5');
  });

  describe('final commit and MCP tool usage', () => {
    const toolUse = (params: { onEvent: (event: never) => void }, tool: string) =>
      (params.onEvent as (event: unknown) => void)({
        event: 'tool_use', timestamp: new Date(), pid: 1, threadId: 't', turnId: '1', sessionId: 't-1', turnCount: 1, message: `${tool}: x`, detail: { tool },
      });

    async function run(initGit: boolean) {
      const dir = tempDir();
      fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
      const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
      const history = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
      const tracker = new FakeTracker([makeIssue({ id: 'a' })]);
      tracker.issueRepository = () => 'acme/app';
      const runner = new FakeRunner((turn, params) => {
        if (initGit) {
          const git = (...args: string[]) =>
            execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd: params.cwd, encoding: 'utf8' });
          git('init', '-q', '-b', 'feature');
          git('commit', '-q', '--allow-empty', '-m', 'init');
        }
        toolUse(params, 'mcp__laravel-boost__database-schema');
        toolUse(params, 'mcp__laravel-boost__database-schema');
        toolUse(params, 'Bash');
        toolUse(params, 'Edit');
        tracker.set('a', { state: 'In review' });
        return { ok: true, turnId: String(turn), resultText: 'done' };
      });
      const orchestrator = new Orchestrator({
        workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
        runner,
        logger: Logger.silent(),
        env: {},
        logDir: null,
        timers: new ManualTimers(),
        createAdapter: () => tracker,
        pricing,
        history,
      });
      await orchestrator.tickNow();
      await until(() => orchestrator.snapshot().retrying.length === 1, 3_000, 'run finished');
      const finished = readHistory(history.dir, 'acme/app').entries.find((e) => e.event === 'run_finished');
      return { fields: finished?.fields ?? {}, orchestrator, cwd: runner.sessions[0]?.params.cwd ?? '' };
    }

    it('records head_sha, branch and counts only MCP tools for a git workspace', async () => {
      const { fields, orchestrator, cwd } = await run(true);
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
      assert.equal(fields.head_sha, sha);
      assert.equal(fields.branch, 'feature');
      assert.equal(fields.mcp_tool_calls, 'laravel-boost:2');
      assert.equal(fields.tool_calls, 'mcp__laravel-boost__database-schema:2,Bash:1,Edit:1');
      assert.equal('skill_calls' in fields, false);
      assert.equal('integrations' in fields, false);
      const detail = orchestrator.issueDetail('a') as { run_trace: Record<string, unknown> };
      assert.deepEqual(detail.run_trace, {
        head_sha: sha,
        branch: 'feature',
        mcp_tool_calls: { 'laravel-boost': 2 },
        tool_calls: { 'mcp__laravel-boost__database-schema': 2, Bash: 1, Edit: 1 },
        skill_calls: {},
        agent_calls: {},
        integrations: [],
      });
    });

    it('omits head_sha and branch for a non-git workspace', async () => {
      const { fields } = await run(false);
      assert.equal('head_sha' in fields, false);
      assert.equal('branch' in fields, false);
      assert.equal(fields.mcp_tool_calls, 'laravel-boost:2');
    });
  });
});

describe('model holds', () => {
  const FABLE = "You've reached your Fable limit. Switch to another model to continue.";
  type Mode = { mode: 'limit'; text?: string; window?: string | null; model?: string | null; resetsAt?: Date | null } | { mode: 'ok' } | { mode: 'hang' };

  /** Issues fail with a usage limit (Fable by default), end normally, or hang until stopped; by issue id. */
  function holdSetup(options: { issues: ReturnType<typeof makeIssue>[]; modes: Record<string, Mode>; front?: Record<string, unknown>; logDir?: string; history?: HistoryLog }) {
    const runner = new FakeRunner((turn, params) => {
      const mode = options.modes[params.issue.id] ?? { mode: 'hang' };
      if (mode.mode === 'limit') {
        const window = mode.window ?? null;
        const model = mode.model === undefined ? 'fable' : mode.model;
        const text = mode.text ?? FABLE;
        return {
          ok: false,
          turnId: String(turn),
          code: 'session_limit',
          message: `turn ended with a usage limit: ${text}`,
          sessionLimit: { window, ...limitScopeOf(window, model as 'fable' | null), resetsAt: mode.resetsAt ?? null, source: mode.resetsAt ? 'message' : null, text, overageDisabledReason: null },
        };
      }
      if (mode.mode === 'ok') return { ok: true, turnId: String(turn), resultText: 'done' };
      return new Promise((resolve) => params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: String(turn), code: 'turn_cancelled', message: 'cancelled' })));
    });
    const front = options.front ?? {};
    return setup({
      runner,
      issues: options.issues,
      ...(options.logDir !== undefined ? { logDir: options.logDir } : {}),
      ...(options.history !== undefined ? { history: options.history } : {}),
      front: {
        ...front,
        agent: { max_turns: 1, ...(front.agent as object | undefined) },
        tracker: { kind: 'github_project', provider: { owner: 'acme', project_number: 1, token: 't', repositories: 'acme/app' } },
      },
    });
  }
  const sessionsOf = (s: Setup, id: string) => s.runner.sessions.filter((session) => session.params.issue.id === id);
  const fable = (id: string, extra: Partial<Parameters<typeof makeIssue>[0]> = {}) => makeIssue({ id, labels: ['model: fable'], ...extra });

  it('holds model fable after a Fable limit; other models and the default model keep running, without a fallback', async () => {
    const s = holdSetup({ issues: [fable('a')], modes: { a: { mode: 'limit' } } });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'a in the retry queue');
    const hour = 3_600_000;
    const row = snapshot(s).retrying[0];
    assert.equal(row?.kind, 'session_limit');
    assert.equal(row?.limit?.scope, 'model');
    assert.equal(row?.limit?.model, 'fable');
    assert.equal(row?.limit?.waiting, true);
    // No quick retries: the issue waits for the end of the hold (agent.model_hold_ms without a reset time).
    assert.deepEqual(s.timers.delays(), [hour]);
    assert.equal(row?.due_at, new Date(s.clock.now().getTime() + hour).toISOString());
    assert.deepEqual(snapshot(s).model_holds, [
      {
        model: 'fable',
        source: 'limit',
        since: s.clock.now().toISOString(),
        until: new Date(s.clock.now().getTime() + hour).toISOString(),
        text: FABLE,
        issue_identifier: 'acme/app#a',
      },
    ]);
    assert.equal(snapshot(s).health.dispatch_gate, null);
    assert.equal(snapshot(s).running.length, 0);

    s.tracker.issues.set('b', fable('b'));
    s.tracker.issues.set('c', makeIssue({ id: 'c', labels: ['model: opus'] }));
    s.tracker.issues.set('d', makeIssue({ id: 'd' }));
    s.tracker.issues.set('e', makeIssue({ id: 'e', labels: ['Model: claude-fable-5-1'] }));
    await s.orchestrator.tickNow();
    await until(() => sessionsOf(s, 'c').length === 1 && sessionsOf(s, 'd').length === 1, 3_000, 'c and d dispatched');
    assert.equal(sessionsOf(s, 'b').length, 0, 'b (fable) not dispatched');
    assert.equal(sessionsOf(s, 'e').length, 0, 'e (a fable model id) not dispatched');
    assert.equal(sessionsOf(s, 'c')[0]?.params.config.model, 'opus');
    assert.equal(sessionsOf(s, 'd')[0]?.params.config.model, null);
    assert.ok(s.runner.sessions.every((session) => session.params.config.fallbackModel === null), 'no fallback model');
    const queued = snapshot(s).issues.find((issue) => issue.issue_id === 'b');
    assert.equal(queued?.status, 'queued');
    assert.deepEqual(queued?.model_hold, { model: 'fable', source: 'limit', until: new Date(s.clock.now().getTime() + hour).toISOString() });
    assert.equal(snapshot(s).issues.find((issue) => issue.issue_id === 'a')?.model_hold?.model, 'fable');

    const events = s.orchestrator.issueTimeline('acme/app#a')?.events ?? [];
    assert.equal(events.find((event) => event.event === 'model_hold')?.detail?.model, 'fable');
  });

  it('ends the hold at the reset + 60 s; the next Fable issue is the probe and runs on Fable', async () => {
    // ManualClock starts at 2026-10-03T12:00:00Z.
    const resetsAt = new Date('2026-10-03T15:00:00Z');
    const s = holdSetup({ issues: [fable('a')], modes: { a: { mode: 'limit', resetsAt } } });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'a waiting');
    const until1 = new Date(resetsAt.getTime() + 60_000);
    assert.equal(snapshot(s).model_holds[0]?.until, until1.toISOString());
    assert.deepEqual(s.timers.delays(), [until1.getTime() - s.clock.now().getTime()]);

    s.tracker.issues.set('b', fable('b'));
    s.clock.advance(until1.getTime() - s.clock.now().getTime() - 1_000);
    await s.orchestrator.tickNow();
    assert.equal(sessionsOf(s, 'b').length, 0, 'still held a second before the end');

    s.clock.advance(1_000);
    await s.orchestrator.tickNow();
    assert.deepEqual(snapshot(s).model_holds, []);
    await until(() => sessionsOf(s, 'b').length === 1, 3_000, 'b dispatched as the probe');
    assert.equal(sessionsOf(s, 'b')[0]?.params.config.model, 'fable');
    const events = s.orchestrator.issueTimeline('acme/app#a')?.events ?? [];
    assert.ok(events.some((event) => event.event === 'model_hold_ended'));
  });

  it('uses agent.model_hold_ms without a reset and extends the hold on a later limit', async () => {
    const s = holdSetup({ issues: [fable('a')], modes: { a: { mode: 'limit' }, b: { mode: 'limit' } }, front: { agent: { model_hold_ms: 600_000 } } });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'a waiting');
    const since = s.clock.now().toISOString();
    assert.equal(snapshot(s).model_holds[0]?.until, new Date(s.clock.now().getTime() + 600_000).toISOString());

    // b runs on the default model, which is Fable: never held, but its own Fable limit extends the hold.
    s.clock.advance(300_000);
    s.tracker.issues.set('b', makeIssue({ id: 'b' }));
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 2, 3_000, 'b waiting');
    const hold = snapshot(s).model_holds[0];
    assert.equal(hold?.since, since);
    assert.equal(hold?.until, new Date(s.clock.now().getTime() + 600_000).toISOString());
    assert.equal(hold?.issue_identifier, 'acme/app#b');
    // a's retry was due at the old end; it is requeued until the new end, without starting a session.
    s.clock.advance(300_000);
    s.timers.fire(600_000);
    await until(() => /^model fable on hold until /.test(snapshot(s).retrying.find((r) => r.issue_id === 'a')?.error ?? ''), 3_000, 'a requeued');
    assert.equal(sessionsOf(s, 'a').length, 1);
    assert.equal(snapshot(s).retrying.find((r) => r.issue_id === 'a')?.due_at, hold?.until);
  });

  it('does not let Retry now bypass the hold', async () => {
    const s = holdSetup({ issues: [fable('a')], modes: { a: { mode: 'limit' } } });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'a waiting');
    const hold = snapshot(s).model_holds[0];
    assert.equal((await s.orchestrator.restartWorker('acme/app#a')).ok, true);
    s.timers.fire(0);
    await until(() => snapshot(s).retrying[0]?.error === `model fable on hold until ${hold?.until}`, 3_000, 'requeued');
    assert.equal(sessionsOf(s, 'a').length, 1);
    assert.equal(snapshot(s).running.length, 0);
    assert.equal(snapshot(s).retrying[0]?.due_at, hold?.until);
  });

  it('scopes a weekly Fable limit to the model: the account-wide gate stays open', async () => {
    const text = "You've hit your weekly Fable limit · resets Oct 9, 3pm (Europe/Berlin)";
    const s = holdSetup({ issues: [fable('a')], modes: { a: { mode: 'limit', text, window: 'seven_day', resetsAt: new Date('2026-10-09T13:00:00Z') } } });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'a waiting');
    assert.equal(snapshot(s).retrying[0]?.limit?.window, 'seven_day');
    assert.equal(snapshot(s).health.dispatch_gate, null);
    assert.equal(snapshot(s).model_holds[0]?.until, '2026-10-09T13:01:00.000Z');
    s.tracker.issues.set('b', makeIssue({ id: 'b', labels: ['model: sonnet'] }));
    await s.orchestrator.tickNow();
    await until(() => sessionsOf(s, 'b').length === 1, 3_000, 'b dispatched');
  });

  it('keeps the account-wide behaviour for a session limit', async () => {
    const s = holdSetup({ issues: [fable('a')], modes: { a: { mode: 'limit', text: "You've hit your session limit", window: 'five_hour', model: null } } });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'a retrying');
    assert.deepEqual(snapshot(s).model_holds, []);
    assert.equal(snapshot(s).retrying[0]?.limit?.scope, 'account');
    assert.deepEqual(s.timers.delays(), [10_000]);
  });

  it('writes model_hold and model_hold_ended history notes', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
    const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
    const history = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
    const s = holdSetup({ issues: [fable('a')], modes: { a: { mode: 'limit' } }, history });
    s.tracker.issueRepository = () => 'acme/app';
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'a waiting');
    s.tracker.set('a', { state: 'Backlog' });
    s.clock.advance(3_600_000);
    await s.orchestrator.tickNow();
    const entries = readHistory(history.dir, 'acme/app').entries;
    const hold = entries.find((entry) => entry.event === 'model_hold')?.fields ?? {};
    assert.equal(hold.model, 'fable');
    assert.equal(hold.issue, 'acme/app#a');
    assert.equal(hold.text, FABLE);
    const ended = entries.find((entry) => entry.event === 'model_hold_ended')?.fields ?? {};
    assert.equal(ended.model, 'fable');
  });

  it('keeps holds across a restart and drops expired ones on load', async () => {
    const logDir = tempDir();
    const s = holdSetup({ issues: [fable('a')], modes: { a: { mode: 'limit' } }, logDir });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'a waiting');
    const file = path.join(logDir, 'state', 'acme_app.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stored.version, 1);
    assert.equal(stored.model_holds[0].model, 'fable');
    await s.orchestrator.shutdown(1_000);

    const restarted = holdSetup({ issues: [fable('b'), makeIssue({ id: 'c' })], modes: {}, logDir });
    assert.deepEqual(snapshot(restarted).model_holds.map((hold) => [hold.model, hold.issue_identifier]), [['fable', 'acme/app#a']]);
    await restarted.orchestrator.tickNow();
    await until(() => sessionsOf(restarted, 'c').length === 1, 3_000, 'c dispatched');
    assert.equal(sessionsOf(restarted, 'b').length, 0, 'b held after the restart');
    await restarted.orchestrator.shutdown(1_000);

    const later = holdSetup({ issues: [], modes: {}, logDir });
    assert.equal(snapshot(later).model_holds.length, 1);
    // A clock past the end drops the hold on load.
    const stale = new Orchestrator({
      workflow: later.workflow,
      runner: later.runner,
      logger: Logger.silent(),
      env: {},
      logDir,
      clock: { now: () => new Date(Date.parse(stored.model_holds[0].until) + 1), monotonicMs: () => 0 },
      timers: later.timers,
      createAdapter: () => later.tracker,
    });
    assert.deepEqual(stale.snapshot().model_holds, []);
  });
});

describe('restart a worker', () => {
  const RESETS_AT = new Date('2026-10-03T17:30:00Z');
  const TEXT = "You've hit your session limit · resets 7:30pm (Europe/Berlin)";

  /** A runner whose sessions fail with a session limit, fail otherwise, or end normally. */
  function restartSetup(options: { front?: Record<string, unknown>; history?: HistoryLog; mode?: 'limit' | 'fail' | 'ok' | 'hang' } = {}) {
    const state = { mode: options.mode ?? 'limit' };
    const runner = new FakeRunner((turn, params) => {
      if (state.mode === 'hang') {
        return new Promise((resolve) => params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: String(turn), code: 'turn_cancelled', message: 'cancelled' })));
      }
      if (state.mode === 'limit') {
        return {
          ok: false,
          turnId: String(turn),
          code: 'session_limit',
          message: `turn ended with an error: ${TEXT}`,
          sessionLimit: { window: 'five_hour', scope: 'account', model: null, resetsAt: RESETS_AT, source: 'event', text: TEXT, overageDisabledReason: null },
        };
      }
      if (state.mode === 'fail') return { ok: false, turnId: String(turn), code: 'turn_failed', message: 'boom' };
      return { ok: true, turnId: String(turn), resultText: 'done' };
    });
    const s = setup({
      runner,
      issues: [makeIssue({ id: 'a' })],
      ...(options.history !== undefined ? { history: options.history } : {}),
      front: { agent: { max_turns: 1, ...(options.front?.agent as object | undefined) } },
    });
    return { s, state };
  }

  it('starts a worker that waits for the session limit reset at once and resets its counter', async () => {
    const { s, state } = restartSetup({ front: { agent: { max_session_limit_retries: 0 } } });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'waiting');
    assert.equal(snapshot(s).retrying[0]?.limit?.waiting, true);

    state.mode = 'fail';
    assert.deepEqual(await s.orchestrator.restartWorker('acme/app#a'), { ok: true, issueIdentifier: 'acme/app#a', previous: 'retrying' });
    assert.equal(snapshot(s).retrying[0]?.kind, 'failure');
    assert.ok(s.timers.delays().includes(0));
    state.mode = 'limit';
    s.timers.fire(0);
    await until(() => s.runner.sessions.length === 2 && snapshot(s).retrying.length === 1, 3_000, 'restarted session');
    // The counter started again: the next limit is hit 1, which waits again because the cap is 0.
    assert.equal(snapshot(s).retrying[0]?.limit?.hits, 1);
    const events = s.orchestrator.issueTimeline('acme/app#a')?.events ?? [];
    const restarted = events.find((event) => event.event === 'worker_restarted');
    assert.equal(restarted?.level, 'info');
    assert.deepEqual(restarted?.detail, { previous: 'retrying' });
  });

  it('counts session limit retries from 1 after a restart', async () => {
    const { s } = restartSetup();
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'first retry');
    s.timers.fire(10_000);
    await until(() => s.runner.sessions.length === 2 && snapshot(s).retrying[0]?.limit?.hits === 2, 3_000, 'second hit');
    await s.orchestrator.restartWorker('a');
    s.timers.fire(0);
    await until(() => s.runner.sessions.length === 3 && snapshot(s).retrying.length === 1, 3_000, 'restarted session');
    assert.equal(snapshot(s).retrying[0]?.limit?.hits, 1);
    assert.equal(snapshot(s).retrying[0]?.kind, 'session_limit');
  });

  it('skips the backoff of a failure retry', async () => {
    const { s } = restartSetup({ mode: 'fail' });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'failure retry');
    assert.deepEqual(s.timers.delays(), [10_000]);
    assert.equal((await s.orchestrator.restartWorker('a')).ok, true);
    assert.deepEqual(s.timers.delays(), [0]);
    s.timers.fire(0);
    await until(() => s.runner.sessions.length === 2, 3_000, 'second session');
  });

  it('dispatches a continuation retry after a restart even with max_continuations 0', async () => {
    const { s } = restartSetup({ mode: 'ok', front: { agent: { max_continuations: 0 } } });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying[0]?.kind === 'continuation', 3_000, 'continuation retry');
    await s.orchestrator.restartWorker('a');
    assert.equal(snapshot(s).retrying[0]?.kind, 'failure');
    s.timers.fire(0);
    await until(() => s.runner.sessions.length === 2, 3_000, 'second session');
    assert.equal(snapshot(s).counts.paused, 0);
  });

  it('restarts a paused issue with attempt 1 and no continuations', async () => {
    const { s } = restartSetup({ mode: 'ok', front: { agent: { max_continuations: 0 } } });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'retry');
    s.timers.fire(1_000);
    await until(() => snapshot(s).counts.paused === 1, 3_000, 'paused');
    assert.equal(s.orchestrator.issueDetail('a')?.status, 'paused');

    assert.deepEqual(await s.orchestrator.restartWorker('a'), { ok: true, issueIdentifier: 'acme/app#a', previous: 'paused' });
    assert.equal(snapshot(s).counts.paused, 0);
    const detail = s.orchestrator.issueDetail('a');
    assert.equal(detail?.status, 'retrying');
    assert.equal(detail?.attempts.continuations, 0);
    assert.equal(detail?.attempts.current_retry_attempt, 1);
    s.timers.fire(0);
    await until(() => s.runner.sessions.length === 2, 3_000, 'restarted session');
  });

  it('reports why a restart is not possible', async () => {
    const runner = new FakeRunner((_turn, params) => new Promise((resolve) => params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: '1', code: 'turn_cancelled', message: 'cancelled' }))));
    const s = setup({ runner, issues: [makeIssue({ id: 'a' })], front: { agent: { max_turns: 1 } } });
    assert.deepEqual(await s.orchestrator.restartWorker('a'), { ok: false, reason: 'not_found' });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running[0]?.phase === 'StreamingTurn', 3_000, 'streaming');
    assert.deepEqual(await s.orchestrator.restartWorker('a'), { ok: false, reason: 'running' });
    assert.deepEqual(await s.orchestrator.restartWorker('acme/app#a'), { ok: false, reason: 'running' });
    assert.deepEqual(await s.orchestrator.restartWorker('nope'), { ok: false, reason: 'not_found' });
    await s.orchestrator.shutdown(1_000);
    assert.deepEqual(await s.orchestrator.restartWorker('a'), { ok: false, reason: 'stopping' });
  });

  it('releases a restarted issue that moved to Done', async () => {
    const { s } = restartSetup();
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'retry');
    await s.orchestrator.restartWorker('a');
    s.tracker.set('a', { state: 'Done' });
    s.timers.fire(0);
    await until(() => snapshot(s).counts.claimed === 0, 3_000, 'released');
    assert.equal(s.runner.sessions.length, 1);
  });

  it('requeues a restarted worker while no slot is free', async () => {
    const { s, state } = restartSetup({ mode: 'fail', front: { agent: { max_concurrent_agents: 1 } } });
    s.tracker.issues.set('b', makeIssue({ id: 'b' }));
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'retry of a');
    state.mode = 'hang';
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running.length === 1, 3_000, 'b running');
    await s.orchestrator.restartWorker('a');
    s.timers.fire(0);
    await until(() => snapshot(s).retrying[0]?.error === 'waiting for a free slot (1/1 busy)', 3_000, 'requeued');
    await until(() => s.runner.sessions.length === 2, 3_000, 'sessions of a and b');
  });

  it('writes the worker_restarted history note', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
    const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
    const history = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
    const { s } = restartSetup({ history, mode: 'fail' });
    s.tracker.issueRepository = () => 'acme/app';
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'retry');
    await s.orchestrator.restartWorker('a');
    const note = readHistory(history.dir, 'acme/app').entries.find((entry) => entry.event === 'worker_restarted')?.fields ?? {};
    assert.equal(note.issue, 'acme/app#a');
    assert.equal(note.previous, 'retrying');
    assert.equal(typeof note.title, 'string');
  });
});

describe('force-start an issue', () => {
  const RESETS_AT = new Date('2026-10-03T17:30:00Z');
  const TEXT = "You've hit your session limit · resets 7:30pm (Europe/Berlin)";

  /** Sessions hang until `finish` ends them (or a stop aborts them); `modes` makes an issue fail or hit a limit at once. */
  function forceSetup(options: { issues?: ReturnType<typeof makeIssue>[]; agent?: Record<string, unknown>; front?: Record<string, unknown>; history?: HistoryLog } = {}) {
    const finish = new Map<string, () => void>();
    const modes: Record<string, 'limit' | 'fail'> = {};
    const runner = new FakeRunner((turn, params) => {
      const mode = modes[params.issue.id];
      if (mode === 'fail') return { ok: false, turnId: String(turn), code: 'turn_failed', message: 'boom' };
      if (mode === 'limit') {
        return {
          ok: false,
          turnId: String(turn),
          code: 'session_limit',
          message: `turn ended with an error: ${TEXT}`,
          sessionLimit: { window: 'five_hour', scope: 'account', model: null, resetsAt: RESETS_AT, source: 'event', text: TEXT, overageDisabledReason: null },
        };
      }
      return new Promise((resolve) => {
        finish.set(params.issue.id, () => resolve({ ok: true, turnId: String(turn), resultText: 'done' }));
        params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: String(turn), code: 'turn_cancelled', message: 'cancelled' }));
      });
    });
    const s = setup({
      runner,
      issues: options.issues ?? ['a', 'b', 'c', 'd'].map((id) => makeIssue({ id })),
      ...(options.history !== undefined ? { history: options.history } : {}),
      front: { ...options.front, agent: { max_turns: 1, max_concurrent_agents: 3, ...options.agent } },
    });
    return { s, finish, modes };
  }
  const sessionsOf = (s: Setup, id: string) => s.runner.sessions.filter((session) => session.params.issue.id === id);
  const runningOf = (s: Setup, id: string) => snapshot(s).running.find((row) => row.issue_id === id);

  it('starts a queued issue in an extra slot when every slot is busy, for one session only', async () => {
    const { s, finish } = forceSetup();
    await s.orchestrator.tickNow();
    await until(() => s.runner.sessions.length === 3, 3_000, 'three sessions');
    assert.equal(snapshot(s).queue.find((item) => item.issue_id === 'd')?.reason.code, 'no_free_slot');

    assert.deepEqual(await s.orchestrator.forceStart('acme/app#d'), {
      ok: true,
      issueIdentifier: 'acme/app#d',
      previous: 'queued',
      slots: { running: 4, forced: 1, limit: 3 },
    });
    // Dispatched in the same call, not at the next tick.
    assert.equal(runningOf(s, 'd')?.forced, true);
    assert.equal(snapshot(s).counts.running, 4);
    assert.equal(snapshot(s).counts.forced, 1);
    await until(() => sessionsOf(s, 'd').length === 1, 3_000, 'forced session');
    const forced = s.orchestrator.issueTimeline('d')?.events.find((event) => event.event === 'worker_forced');
    assert.deepEqual(forced?.detail, { previous: 'queued', running: 4, forced: 1, limit: 3 });
    assert.equal(s.orchestrator.issueTimeline('d')?.events.find((event) => event.event === 'run_dispatched')?.detail?.forced, true);

    // The forced session ends: its continuation waits for a free slot like any other work.
    await until(() => finish.has('d'), 3_000, 'd streaming');
    finish.get('d')?.();
    await until(() => snapshot(s).retrying[0]?.kind === 'continuation', 3_000, 'continuation');
    s.timers.fire(CONTINUATION_DELAY_MS);
    await until(() => snapshot(s).retrying[0]?.error === 'waiting for a free slot (3/3 busy)', 3_000, 'continuation waits');
    assert.equal(snapshot(s).counts.running, 3);
    assert.equal(sessionsOf(s, 'd').length, 1);

    // A slot frees up: the continuation takes it, as a normal session.
    s.tracker.set('a', { state: 'Done' });
    await s.orchestrator.tickNow();
    await until(() => runningOf(s, 'a') === undefined, 3_000, 'a stopped');
    await s.orchestrator.tickNow();
    await until(() => sessionsOf(s, 'd').length === 2, 3_000, 'continuation started');
    assert.equal(runningOf(s, 'd')?.forced, false);
    assert.equal(snapshot(s).counts.forced, 0);
  });

  it('keeps the regular slots for the queue while a forced session runs', async () => {
    const { s, finish } = forceSetup({ agent: { max_concurrent_agents: 1 }, issues: [makeIssue({ id: 'a' }), makeIssue({ id: 'b' }), makeIssue({ id: 'c' })] });
    await s.orchestrator.tickNow();
    await until(() => finish.has('a'), 3_000, 'a running');
    assert.equal((await s.orchestrator.forceStart('c')).ok, true);
    s.tracker.set('a', { state: 'Done' });
    await s.orchestrator.tickNow();
    await until(() => runningOf(s, 'a') === undefined, 3_000, 'a stopped');
    await s.orchestrator.tickNow();
    // The forced c holds no slot: b gets the free one.
    await until(() => sessionsOf(s, 'b').length === 1, 3_000, 'b started');
    assert.deepEqual(snapshot(s).running.map((row) => [row.issue_id, row.forced]).sort(), [['b', false], ['c', true]]);
  });

  it('starts an issue that waits for an account-wide session limit, and a new one behind the dispatch gate', async () => {
    const { s, modes } = forceSetup({ agent: { max_session_limit_retries: 0 }, issues: [makeIssue({ id: 'a' })] });
    modes.a = 'limit';
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying[0]?.limit?.waiting === true, 3_000, 'waiting for the reset');
    assert.notEqual(snapshot(s).health.dispatch_gate, null);
    s.tracker.issues.set('b', makeIssue({ id: 'b' }));
    await s.orchestrator.tickNow();
    assert.equal(snapshot(s).queue.find((item) => item.issue_id === 'b')?.reason.code, 'session_limit');

    const b = await s.orchestrator.forceStart('b');
    assert.equal(b.ok && b.previous, 'queued');
    await until(() => sessionsOf(s, 'b').length === 1, 3_000, 'b started');

    delete modes.a;
    const a = await s.orchestrator.forceStart('a');
    assert.equal(a.ok && a.previous, 'retrying');
    await until(() => sessionsOf(s, 'a').length === 2, 3_000, 'a started');
    assert.equal(snapshot(s).retrying.length, 0);
    assert.equal(s.orchestrator.issueDetail('a')?.running?.attempt, 1);
  });

  it('skips the backoff of a failure retry and resets the counters', async () => {
    const { s, modes } = forceSetup({ issues: [makeIssue({ id: 'a' })] });
    modes.a = 'fail';
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'failure retry');
    assert.deepEqual(s.timers.delays(), [10_000]);
    delete modes.a;
    assert.equal((await s.orchestrator.forceStart('a')).ok, true);
    assert.deepEqual(s.timers.delays(), []);
    await until(() => sessionsOf(s, 'a').length === 2, 3_000, 'second session');
  });

  it('lifts an operator pause and starts the issue', async () => {
    const { s } = forceSetup({ agent: { max_concurrent_agents: 1 }, issues: [makeIssue({ id: 'a' }), makeIssue({ id: 'b' })] });
    await s.orchestrator.tickNow();
    await until(() => s.runner.sessions.length === 1, 3_000, 'a running');
    assert.equal((await s.orchestrator.pauseIssue('b')).ok, true);
    assert.equal(snapshot(s).counts.paused, 1);

    const result = await s.orchestrator.forceStart('b');
    assert.equal(result.ok && result.previous, 'paused');
    assert.equal(snapshot(s).counts.paused, 0);
    await until(() => sessionsOf(s, 'b').length === 1, 3_000, 'b started');
    assert.equal(snapshot(s).counts.running, 2);
  });

  it('refuses blocked, held, running and ineligible issues', async () => {
    const { s } = forceSetup({
      agent: { max_concurrent_agents: 1 },
      issues: [
        makeIssue({ id: 'a' }),
        makeIssue({ id: 'blocked', dispatchable: false, native_ref: { dispatch_note: 'blocked by acme/app#1' } }),
        makeIssue({ id: 'opus', labels: ['model: opus'] }),
        makeIssue({ id: 'moved' }),
      ],
    });
    await s.orchestrator.tickNow();
    await until(() => s.runner.sessions.length === 1, 3_000, 'a running');
    assert.deepEqual(await s.orchestrator.forceStart('a'), { ok: false, reason: 'running', message: 'issue a is already running' });
    assert.deepEqual(await s.orchestrator.forceStart('blocked'), { ok: false, reason: 'blocked', message: 'blocked by acme/app#1' });
    assert.equal((await s.orchestrator.holdModel('opus')).ok, true);
    const held = await s.orchestrator.forceStart('opus');
    assert.equal(held.ok === false && held.reason, 'model_held');
    assert.match(held.ok === false ? held.message : '', /resume the model first/);
    s.tracker.set('moved', { state: 'Backlog' });
    const moved = await s.orchestrator.forceStart('moved');
    assert.equal(moved.ok === false && moved.reason, 'not_eligible');
    assert.equal((await s.orchestrator.forceStart('nope')).ok === false, true);
    assert.equal(s.runner.sessions.length, 1);
    await s.orchestrator.shutdown(1_000);
    const stopped = await s.orchestrator.forceStart('opus');
    assert.equal(stopped.ok === false && stopped.reason, 'stopping');
  });

  it('writes the worker_forced history note with the slot counts', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
    const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
    const history = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
    const { s } = forceSetup({ history, agent: { max_concurrent_agents: 1 }, issues: [makeIssue({ id: 'a' }), makeIssue({ id: 'b' })] });
    s.tracker.issueRepository = () => 'acme/app';
    await s.orchestrator.tickNow();
    await until(() => s.runner.sessions.length === 1, 3_000, 'a running');
    await s.orchestrator.forceStart('b');
    const note = readHistory(history.dir, 'acme/app').entries.find((entry) => entry.event === 'worker_forced')?.fields ?? {};
    assert.equal(note.issue, 'acme/app#b');
    assert.equal(note.previous, 'queued');
    assert.equal(String(note.running), '2');
    assert.equal(String(note.forced), '1');
    assert.equal(String(note.limit), '1');
  });
});

describe('issue-centric snapshot', () => {
  const ROLE_FRONT = {
    agent: { max_concurrent_agents: 1 },
    tracker: {
      kind: 'github_project',
      provider: { owner: 'acme', project_number: 1, token: 'test-token' },
      active_states: ['Ready', 'In progress', 'Agent review'],
      terminal_states: ['Done'],
    },
    roles: {
      developer: { states: ['Ready', 'In progress'], may_move_to: ['In progress', 'Agent review', 'Blocked'] },
      reviewer: { states: ['Agent review'], read_only: true, may_move_to: ['In review', 'In progress', 'Blocked'] },
    },
  };

  it('lists issues in flight with their pipeline and blocked issues with reasons', async () => {
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const s = setup({
      runner,
      front: ROLE_FRONT,
      issues: [
        makeIssue({ id: 'run', state: 'Ready', priority: 1 }),
        makeIssue({ id: 'wait', state: 'Ready', priority: 2 }),
        makeIssue({
          id: 'gated',
          state: 'Ready',
          priority: 3,
          dispatchable: false,
          blocked_by: [{ id: 'b9', identifier: 'acme/app#9', state: 'OPEN' }],
          native_ref: { dispatch_note: 'blocked by acme/app#9' },
        }),
        makeIssue({ id: 'parked', state: 'Blocked' }),
      ],
    });
    await s.orchestrator.tickNow();
    await until(() => runner.sessions.length === 1, 3_000, 'one session');
    const snap = snapshot(s);

    assert.deepEqual(snap.issues.map((issue) => [issue.issue_id, issue.status]), [['run', 'running'], ['wait', 'queued']]);
    const row = snap.issues[0];
    assert.deepEqual(
      row?.stages.map((stage) => [stage.id, stage.status]),
      [['developer', 'active'], ['reviewer', 'pending'], ['human:in review', 'pending'], ['terminal:done', 'pending']],
    );
    assert.equal(row?.stages[0]?.sessions.length, 1);
    assert.notEqual(row?.running, null);
    assert.equal(snap.issues[1]?.running, null);

    assert.deepEqual(
      snap.blocked.map((issue) => [issue.issue_id, issue.reason]),
      [['parked', 'in column "Blocked"'], ['gated', 'blocked by acme/app#9']],
    );
    assert.deepEqual(snap.blocked[1]?.blocked_by, [{ id: 'b9', identifier: 'acme/app#9', state: 'OPEN' }]);
    assert.equal(snap.counts.queued, 1);
    assert.equal(snap.counts.blocked, 2);
    assert.deepEqual(snap.pipeline_config.blocked_states, ['Blocked']);
    assert.equal(typeof snap.board_fetched_at, 'string');
  });

  it('names the reason of every queued issue, in dispatch order, and --dry-run plans the same', async () => {
    const logDir = tempDir();
    fs.mkdirSync(path.join(logDir, 'state'));
    const hold = { model: 'fable', source: 'limit', since: '2026-10-03T11:00:00Z', until: '2026-10-03T18:00:00Z', text: 'limit', issue_identifier: null, repo: 'acme/app' };
    fs.writeFileSync(path.join(logDir, 'state', 'github_project.json'), JSON.stringify({ version: 1, model_holds: [hold] }));
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const front = {
      ...ROLE_FRONT,
      agent: { max_concurrent_agents: 2, max_concurrent_agents_by_state: { 'agent review': 1 } },
      tracker: { ...ROLE_FRONT.tracker, required_labels: ['ai'] },
      roles: { ...ROLE_FRONT.roles, developer: { ...ROLE_FRONT.roles.developer, wait_for_sub_issues: true } },
    };
    const issues = [
      makeIssue({ id: 'rev-run', state: 'Agent review', priority: 1, labels: ['ai'] }),
      makeIssue({ id: 'rev-wait', state: 'Agent review', priority: 2, labels: ['ai'] }),
      makeIssue({ id: 'wave', state: 'Ready', priority: 1, labels: ['ai'] }),
      makeIssue({ id: 'fable', state: 'Ready', priority: 2, labels: ['ai', 'model: fable'] }),
      makeIssue({ id: 'run', state: 'Ready', priority: 3, labels: ['ai'] }),
      makeIssue({ id: 'later', state: 'Ready', priority: 4, labels: ['ai'] }),
      makeIssue({ id: 'unlabeled', state: 'Ready', priority: 1 }),
    ];
    const s = setup({ runner, front, issues, logDir });
    s.tracker.openSubIssues = (issue) => (issue.id === 'wave' ? ['acme/app#7'] : []);
    await s.orchestrator.tickNow();
    await until(() => runner.sessions.length === 2, 3_000, 'two sessions');
    const snap = snapshot(s);

    assert.deepEqual(snap.running.map((row) => row.issue_id), ['rev-run', 'run']);
    const queue = snap.queue.map((item) => [item.position, item.issue_id, item.status, item.kind, item.decision, item.reason.code, item.reason.text]);
    assert.deepEqual(queue, [
      [1, 'wave', 'next', 'new', 'wait', 'waiting_for_sub_issues', 'waiting for sub-issues acme/app#7'],
      [2, 'fable', 'next', 'new', 'wait', 'model_hold', 'model fable on hold until 2026-10-03 18:00 UTC'],
      [3, 'rev-wait', 'next', 'new', 'wait', 'column_limit', 'Agent review limit 1/1'],
      [4, 'later', 'next', 'new', 'wait', 'no_free_slot', 'waiting for a free slot (2/2 busy)'],
    ]);
    assert.equal(snap.queue[1]?.model, 'fable');
    assert.deepEqual(
      snap.issues.map((row) => [row.issue_id, row.section, row.position, row.reason?.code ?? null]),
      [
        ['rev-run', 'running', null, null],
        ['run', 'running', null, null],
        ['wave', 'next', 1, 'waiting_for_sub_issues'],
        ['fable', 'next', 2, 'model_hold'],
        ['rev-wait', 'next', 3, 'column_limit'],
        ['later', 'next', 4, 'no_free_slot'],
      ],
    );
    assert.deepEqual(
      snap.blocked.map((row) => [row.issue_id, row.reason_code, row.reason]),
      [['unlabeled', 'missing_label', 'missing required label ai']],
    );
    assert.deepEqual(snap.blocked[0]!.labels, issues.find((i) => i.id === 'unlabeled')!.labels);
    assert.ok('updated_at' in snap.blocked[0]!);
    // review_rounds is additive: a number for tracked issues, null without a record (E2-8).
    assert.ok(snap.issues.every((row) => 'review_rounds' in row));
    assert.equal(snap.blocked[0]!.review_rounds, null);
    assert.equal(snap.issues.find((row) => row.issue_id === 'later')?.review_rounds, null);
    assert.equal(snap.issues.find((row) => row.issue_id === 'run')?.review_rounds, 0);
    assert.equal(snap.counts.queued, 4);

    // The dry run starts with nothing running: it starts what the tick started and gives the rest the same reasons.
    const plan = dryRunPlan(issues, s.workflow.current.config, s.tracker, new Map([['fable', { until: new Date(hold.until) }]]), s.clock.now());
    assert.deepEqual(plan.filter((item) => item.decision === 'start').map((item) => item.issueId), ['rev-run', 'run']);
    assert.deepEqual(
      plan.filter((item) => item.group === 'next' && item.decision === 'wait').map((item) => [item.issueId, item.reason.text]),
      snap.queue.map((item) => [item.issue_id, item.reason.text]),
    );
    const byId = new Map(issues.map((issue) => [issue.id, issue]));
    const lines = plan.flatMap((item) => planLines(item, byId.get(item.issueId) as (typeof issues)[number]));
    assert.deepEqual(lines.slice(0, 6), [
      '  #1   start  acme/app#rev-run  [Agent review, p1]  Issue rev-run',
      '              ↳ starts at the next poll',
      '  #2   wait   acme/app#wave  [Ready, p1]  Issue wave',
      '              ↳ waiting for sub-issues acme/app#7',
      '  #3   wait   acme/app#fable  [Ready, p2]  Issue fable',
      '              ↳ model fable on hold until 2026-10-03 18:00 UTC',
    ]);
    assert.deepEqual(lines.slice(-2), ['  blocked     acme/app#unlabeled  [Ready, p1]  Issue unlabeled', '              ↳ missing required label ai']);
  });

  it('serves issue metadata and the pipeline in the issue detail', async () => {
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const s = setup({
      runner,
      front: ROLE_FRONT,
      issues: [makeIssue({ id: 'run', state: 'In progress', labels: ['bug'], priority: 2 })],
    });
    await s.orchestrator.tickNow();
    await until(() => runner.sessions.length === 1, 3_000, 'one session');
    const detail = s.orchestrator.issueDetail('run');
    assert.equal(detail?.issue?.state, 'In progress');
    assert.deepEqual(detail?.issue?.labels, ['bug']);
    assert.equal(detail?.issue?.priority, 2);
    assert.deepEqual(
      detail?.pipeline.map((stage) => [stage.id, stage.status]),
      [['developer', 'active'], ['reviewer', 'pending'], ['human:in review', 'pending'], ['terminal:done', 'pending']],
    );
  });
});

describe('operator pause', () => {
  /** Sessions hang until stopped (`hang`), fail (`fail`) or end normally (`ok`), by issue id; hang by default. */
  function pauseSetup(options: { issues: ReturnType<typeof makeIssue>[]; modes?: Record<string, 'hang' | 'fail' | 'ok'>; front?: Record<string, unknown>; logDir?: string; history?: HistoryLog }) {
    const modes = options.modes ?? {};
    const runner = new FakeRunner((turn, params) => {
      const mode = modes[params.issue.id] ?? 'hang';
      if (mode === 'fail') return { ok: false, turnId: String(turn), code: 'turn_failed', message: 'boom' };
      if (mode === 'ok') return { ok: true, turnId: String(turn), resultText: 'done' };
      return new Promise((resolve) => params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: String(turn), code: 'turn_cancelled', message: 'cancelled' })));
    });
    const front = options.front ?? {};
    const s = setup({
      runner,
      issues: options.issues,
      ...(options.logDir !== undefined ? { logDir: options.logDir } : {}),
      ...(options.history !== undefined ? { history: options.history } : {}),
      front: {
        ...front,
        agent: { max_turns: 1, ...(front.agent as object | undefined) },
        tracker: { kind: 'github_project', provider: { owner: 'acme', project_number: 1, token: 't', repositories: 'acme/app' } },
      },
    });
    return { s, modes };
  }
  const sessionsOf = (s: Setup, id: string) => s.runner.sessions.filter((session) => session.params.issue.id === id);
  const pausedRow = (s: Setup, id: string) => snapshot(s).issues.find((issue) => issue.issue_id === id);

  it('stops a running agent, keeps its workspace and claim, and schedules no retry', async () => {
    const { s } = pauseSetup({ issues: [makeIssue({ id: 'a' })] });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running[0]?.phase === 'StreamingTurn', 3_000, 'streaming');
    const workspace = snapshot(s).running[0]?.workspace as string;

    assert.deepEqual(await s.orchestrator.pauseIssue('acme/app#a'), { ok: true, issueIdentifier: 'acme/app#a', previous: 'running' });
    await until(() => snapshot(s).running.length === 0, 3_000, 'agent stopped');
    assert.equal(s.runner.sessions[0]?.stopped, true);
    assert.ok(fs.existsSync(workspace), 'workspace kept');
    assert.equal(snapshot(s).retrying.length, 0);
    assert.deepEqual(s.timers.delays().filter((ms) => ms !== s.workflow.current.config.polling.intervalMs), []);
    assert.equal(snapshot(s).counts.paused, 1);
    const row = pausedRow(s, 'a');
    assert.equal(row?.section, 'paused');
    assert.equal(row?.paused?.source, 'operator');
    assert.equal(row?.reason?.text, 'paused by operator; press Resume to continue');
    assert.equal(s.orchestrator.issueDetail('a')?.status, 'paused');
    const paused = s.orchestrator.issueTimeline('a')?.events.find((event) => event.event === 'issue_paused');
    assert.deepEqual(paused?.detail, { source: 'operator', previous: 'running', state: 'Todo' });
    assert.deepEqual(await s.orchestrator.pauseIssue('a'), { ok: false, reason: 'already_paused' });

    await s.orchestrator.tickNow();
    assert.equal(s.runner.sessions.length, 1, 'a tick does not start a paused issue');
  });

  it('is not lifted by a comment, a label change or a column move; Done releases it', async () => {
    const { s } = pauseSetup({ issues: [makeIssue({ id: 'a' })] });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running[0]?.phase === 'StreamingTurn', 3_000, 'streaming');
    await s.orchestrator.pauseIssue('a');
    await until(() => snapshot(s).running.length === 0, 3_000, 'stopped');

    s.tracker.set('a', { updated_at: new Date('2026-10-03T12:05:00Z') });
    await s.orchestrator.tickNow();
    s.tracker.set('a', { labels: ['bug'] });
    await s.orchestrator.tickNow();
    s.tracker.set('a', { state: 'Backlog' });
    await s.orchestrator.tickNow();
    assert.equal(pausedRow(s, 'a')?.state, 'Backlog');
    s.tracker.set('a', { state: 'Todo' });
    await s.orchestrator.tickNow();
    assert.equal(s.runner.sessions.length, 1, 'still paused');
    assert.equal(snapshot(s).counts.paused, 1);

    s.tracker.set('a', { state: 'Done' });
    await s.orchestrator.tickNow();
    assert.equal(snapshot(s).counts.paused, 0);
    assert.equal(snapshot(s).counts.claimed, 0);
  });

  it('pauses a retrying issue (its timer is cancelled), a queued board candidate and an auto-paused issue', async () => {
    const { s } = pauseSetup({
      issues: [makeIssue({ id: 'a', priority: 1 }), makeIssue({ id: 'b', priority: 4 })],
      modes: { a: 'fail' },
      front: { agent: { max_concurrent_agents: 1 } },
    });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'a retrying');
    assert.deepEqual(s.timers.delays().filter((ms) => ms === 10_000), [10_000]);
    assert.deepEqual(await s.orchestrator.pauseIssue('a'), { ok: true, issueIdentifier: 'acme/app#a', previous: 'retrying' });
    assert.deepEqual(s.timers.delays().filter((ms) => ms === 10_000), [], 'retry timer cancelled');
    assert.equal(s.timers.fire(10_000), 0);

    // b is a board candidate; pausing it claims it before it ever runs.
    assert.deepEqual(await s.orchestrator.pauseIssue('b'), { ok: true, issueIdentifier: 'acme/app#b', previous: 'queued' });
    await s.orchestrator.tickNow();
    assert.equal(sessionsOf(s, 'b').length, 0, 'queued issue not started');
    assert.equal(snapshot(s).counts.paused, 2);
    assert.deepEqual(await s.orchestrator.pauseIssue('nope'), { ok: false, reason: 'not_found' });

    // An issue paused after its continuations becomes an operator pause, and board changes no longer lift it.
    const auto = pauseSetup({ issues: [makeIssue({ id: 'c' })], modes: { c: 'ok' }, front: { agent: { max_continuations: 0 } } });
    await auto.s.orchestrator.tickNow();
    await until(() => snapshot(auto.s).retrying.length === 1, 3_000, 'continuation');
    auto.s.timers.fire(1_000);
    await until(() => snapshot(auto.s).counts.paused === 1, 3_000, 'auto-paused');
    assert.equal(snapshot(auto.s).paused[0]?.source, 'continuations');
    assert.equal(pausedRow(auto.s, 'c')?.reason?.text, 'paused after 0 continuation sessions; change the issue on the board to resume');
    assert.deepEqual(await auto.s.orchestrator.pauseIssue('c'), { ok: true, issueIdentifier: 'acme/app#c', previous: 'paused' });
    auto.s.tracker.set('c', { updated_at: new Date('2026-10-03T12:05:00Z') });
    await auto.s.orchestrator.tickNow();
    assert.equal(snapshot(auto.s).paused[0]?.source, 'operator');
    assert.equal(auto.s.runner.sessions.length, 1);
  });

  it('resumes like Resume now: counters reset, attempt kept', async () => {
    const { s, modes } = pauseSetup({ issues: [makeIssue({ id: 'a' })], modes: { a: 'fail' } });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'retry');
    s.timers.fire(10_000);
    await until(() => s.runner.sessions.length === 2 && snapshot(s).retrying[0]?.attempt === 2, 3_000, 'second retry');
    assert.deepEqual(await s.orchestrator.resumeIssue('a'), { ok: false, reason: 'not_paused' });
    assert.deepEqual(await s.orchestrator.resumeIssue('nope'), { ok: false, reason: 'not_found' });
    await s.orchestrator.pauseIssue('a');

    modes.a = 'hang';
    assert.deepEqual(await s.orchestrator.resumeIssue('acme/app#a'), { ok: true, issueIdentifier: 'acme/app#a' });
    assert.equal(snapshot(s).counts.paused, 0);
    assert.equal(s.orchestrator.issueDetail('a')?.attempts.current_retry_attempt, 2);
    assert.ok(s.timers.delays().includes(0));
    s.timers.fire(0);
    await until(() => snapshot(s).running.length === 1, 3_000, 'resumed session');
    assert.equal(snapshot(s).running[0]?.attempt, 2);
    const events = s.orchestrator.issueTimeline('a')?.events ?? [];
    assert.deepEqual(events.find((event) => event.event === 'issue_resumed')?.detail, { source: 'operator' });
  });

  it('pauses model fable: stops Fable agents, holds every Fable issue, keeps other models running; release requeues', async () => {
    const fable = (id: string) => makeIssue({ id, labels: ['model: fable'] });
    const { s } = pauseSetup({ issues: [fable('a'), makeIssue({ id: 'b', labels: ['model: opus'] })] });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running.length === 2 && snapshot(s).running.every((row) => row.phase === 'StreamingTurn'), 3_000, 'both running');
    const workspace = snapshot(s).running.find((row) => row.issue_id === 'a')?.workspace as string;

    assert.deepEqual(await s.orchestrator.holdModel('Fable'), { ok: true, model: 'fable', issues: 1 });
    assert.deepEqual(await s.orchestrator.holdModel('fable'), { ok: false, reason: 'already_paused' });
    assert.deepEqual(await s.orchestrator.holdModel('gpt'), { ok: false, reason: 'unknown_model' });
    await until(() => snapshot(s).running.length === 1, 3_000, 'fable stopped');
    assert.equal(snapshot(s).running[0]?.issue_id, 'b', 'opus keeps running');
    assert.ok(fs.existsSync(workspace), 'workspace kept');
    const waiting = snapshot(s).issues.find((issue) => issue.issue_id === 'a');
    assert.equal(waiting?.section, 'waiting');
    assert.deepEqual(waiting?.reason, { code: 'model_hold', text: 'model fable paused by the operator' });
    assert.equal(snapshot(s).model_holds[0]?.source, 'operator');
    assert.deepEqual(snapshot(s).model_controls.map((m) => [m.model, m.paused]), [['fable', true], ['opus', false]]);

    s.tracker.issues.set('c', fable('c'));
    await s.orchestrator.tickNow();
    assert.equal(sessionsOf(s, 'c').length, 0, 'new Fable issue held');
    assert.equal(sessionsOf(s, 'a').length, 1);
    assert.equal(snapshot(s).issues.find((issue) => issue.issue_id === 'c')?.reason?.code, 'model_hold');

    assert.deepEqual(await s.orchestrator.releaseModel('fable'), { ok: true, model: 'fable', issues: 1 });
    assert.deepEqual(await s.orchestrator.releaseModel('fable'), { ok: false, reason: 'not_paused' });
    s.timers.fire(0);
    await until(() => sessionsOf(s, 'a').length === 2 && sessionsOf(s, 'c').length === 1, 3_000, 'fable issues start again');
    assert.ok(s.runner.sessions.every((session) => session.params.issue.id === 'b' || session.params.config.model === 'fable'), 'no fallback');
    const events = s.orchestrator.issueTimeline('a')?.events ?? [];
    assert.equal(events.find((event) => event.event === 'model_hold')?.detail?.source, 'operator');
    assert.equal(events.find((event) => event.event === 'model_hold_ended')?.detail?.source, 'operator');
  });

  it('keeps operator pauses and holds across a restart', async () => {
    const logDir = tempDir();
    const fable = makeIssue({ id: 'f', labels: ['model: fable'] });
    const first = pauseSetup({ issues: [makeIssue({ id: 'a' }), fable], logDir });
    await first.s.orchestrator.holdModel('fable');
    await first.s.orchestrator.tickNow();
    await until(() => snapshot(first.s).running.length === 1, 3_000, 'a running');
    await first.s.orchestrator.pauseIssue('a');
    await until(() => snapshot(first.s).running.length === 0, 3_000, 'a stopped');
    const stored = JSON.parse(fs.readFileSync(path.join(logDir, 'state', 'acme_app.json'), 'utf8'));
    assert.deepEqual(stored.operator_holds.map((hold: { model: string }) => hold.model), ['fable']);
    assert.deepEqual(stored.paused_issues.map((pause: { issue_identifier: string }) => pause.issue_identifier), ['acme/app#a']);
    await first.s.orchestrator.shutdown(1_000);

    const second = pauseSetup({ issues: [makeIssue({ id: 'a' }), fable], logDir });
    assert.equal(snapshot(second.s).counts.paused, 1);
    assert.equal(snapshot(second.s).model_holds[0]?.source, 'operator');
    await second.s.orchestrator.tickNow();
    await second.s.orchestrator.tickNow();
    assert.equal(second.s.runner.sessions.length, 0, 'nothing starts after the restart');
    assert.equal(snapshot(second.s).paused[0]?.state, 'Todo');

    assert.equal((await second.s.orchestrator.resumeIssue('acme/app#a')).ok, true);
    assert.equal((await second.s.orchestrator.releaseModel('fable')).ok, true);
    const cleared = JSON.parse(fs.readFileSync(path.join(logDir, 'state', 'acme_app.json'), 'utf8'));
    assert.deepEqual([cleared.operator_holds, cleared.paused_issues], [[], []]);
  });

  it('refuses while shutting down and writes history notes', async () => {
    const dir = tempDir();
    const history = new HistoryLog(path.join(dir, 'repositories'), new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent()), Logger.silent());
    const { s } = pauseSetup({ issues: [makeIssue({ id: 'a' })], history });
    s.tracker.issueRepository = () => 'acme/app';
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running.length === 1, 3_000, 'running');
    await s.orchestrator.pauseIssue('a');
    await until(() => snapshot(s).running.length === 0, 3_000, 'stopped');
    await s.orchestrator.resumeIssue('a');
    await s.orchestrator.holdModel('opus');
    await s.orchestrator.releaseModel('opus');
    const events = readHistory(history.dir, 'acme/app').entries.map((entry) => [entry.event, entry.fields.source]);
    for (const event of ['issue_paused', 'issue_resumed', 'model_hold', 'model_hold_ended']) {
      assert.deepEqual(events.find(([name]) => name === event), [event, 'operator']);
    }
    await s.orchestrator.shutdown(1_000);
    assert.deepEqual(await s.orchestrator.pauseIssue('a'), { ok: false, reason: 'stopping' });
    assert.deepEqual(await s.orchestrator.holdModel('fable'), { ok: false, reason: 'stopping' });
  });
});

describe('agent slots set on the dashboard', () => {
  /** Sessions run until they are stopped. */
  const hanging = () =>
    new FakeRunner((turn, params) => new Promise((resolve) => params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: String(turn), code: 'turn_cancelled', message: 'cancelled' }))));
  const issues = (...ids: string[]) => ids.map((id) => makeIssue({ id }));
  const front = { agent: { max_concurrent_agents: 3, max_concurrent_agents_by_state: { 'in progress': 1 } } };

  it('raises the limit: a fourth agent starts with the next tick', async () => {
    const s = setup({ runner: hanging(), front, issues: issues('a', 'b', 'c', 'd', 'e') });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running.length === 3, 3_000, 'three running');
    assert.equal(snapshot(s).queue.find((item) => item.issue_identifier === 'acme/app#d')?.reason?.code, 'no_free_slot');
    const result = await s.orchestrator.updateAgentSettings({ max_concurrent_agents: 4 });
    assert.equal(result.ok && result.changed, true);
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running.length === 4, 3_000, 'four running');
    const limits = snapshot(s).limits;
    assert.deepEqual(limits.max_concurrent_agents, { effective: 4, workflow: 3, override: 4 });
    assert.equal(limits.override_active, true);
    assert.equal(snapshot(s).health.max_concurrent_agents, 4);
    await s.orchestrator.shutdown(1_000);
  });

  it('lowers the limit without stopping a running agent; nothing new starts', async () => {
    const s = setup({ runner: hanging(), front, issues: issues('a', 'b', 'c') });
    await s.orchestrator.tickNow();
    await until(() => s.runner.sessions.length === 3, 3_000, 'three sessions');
    assert.equal((await s.orchestrator.updateAgentSettings({ max_concurrent_agents: 2 })).ok, true);
    s.tracker.issues.set('d', makeIssue({ id: 'd' }));
    await s.orchestrator.tickNow();
    await s.orchestrator.tickNow();
    assert.equal(snapshot(s).running.length, 3, 'all three keep running');
    assert.equal(s.runner.sessions.length, 3, 'nothing new started');
    assert.equal(snapshot(s).queue.find((item) => item.issue_identifier === 'acme/app#d')?.reason?.text, 'waiting for a free slot (2/2 busy)');
    // 0 pauses new dispatches, as in WORKFLOW.md.
    assert.equal((await s.orchestrator.updateAgentSettings({ max_concurrent_agents: 0 })).ok, true);
    assert.equal(snapshot(s).limits.max_concurrent_agents.effective, 0);
    await s.orchestrator.shutdown(1_000);
  });

  it('changes per-column limits and validates every value', async () => {
    const s = setup({ runner: hanging(), front, issues: [makeIssue({ id: 'a', state: 'In Progress' }), makeIssue({ id: 'b', state: 'In Progress' })] });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running.length === 1, 3_000, 'column limit 1');
    assert.deepEqual(snapshot(s).limits.by_state['In Progress'], { effective: 1, workflow: 1, override: null });
    assert.deepEqual(snapshot(s).limits.by_state.Todo, { effective: null, workflow: null, override: null });
    assert.equal((await s.orchestrator.updateAgentSettings({ max_concurrent_agents_by_state: { 'IN PROGRESS': 2 } })).ok, true);
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running.length === 2, 3_000, 'column limit 2');
    assert.deepEqual(snapshot(s).limits.by_state['In Progress'], { effective: 2, workflow: 1, override: 2 });

    const invalid = async (body: unknown, pattern: RegExp) => {
      const result = await s.orchestrator.updateAgentSettings(body);
      assert.equal(result.ok, false, JSON.stringify(body));
      assert.match(result.ok === false && result.reason === 'invalid' ? result.message : '', pattern);
    };
    await invalid({ max_concurrent_agents: 51 }, /0 to 50/);
    await invalid({ max_concurrent_agents: -1 }, /0 to 50/);
    await invalid({ max_concurrent_agents: 2.5 }, /0 to 50/);
    await invalid({ max_concurrent_agents: '3' }, /0 to 50/);
    await invalid({ max_concurrent_agents_by_state: { Todo: 0 } }, /1 to 50/);
    await invalid({ max_concurrent_agents_by_state: { Done: 1 } }, /Done is not an active column/);
    await invalid({ max_concurrent_agents_by_state: [] }, /object/);
    await invalid({ slots: 3 }, /unknown field slots/);
    await invalid({}, /set max_concurrent_agents/);
    await invalid(null, /JSON object/);
    assert.equal(snapshot(s).limits.by_state['In Progress']?.override, 2, 'a refused update changes nothing');

    // null removes one override; DELETE (reset) removes all.
    await s.orchestrator.updateAgentSettings({ max_concurrent_agents: 5, max_concurrent_agents_by_state: { 'In Progress': null } });
    assert.deepEqual(snapshot(s).limits.by_state['In Progress'], { effective: 1, workflow: 1, override: null });
    const reset = await s.orchestrator.resetAgentSettings();
    assert.equal(reset.ok && reset.changed, true);
    assert.equal(snapshot(s).limits.override_active, false);
    assert.equal(snapshot(s).limits.max_concurrent_agents.effective, 3);
    const again = await s.orchestrator.resetAgentSettings();
    assert.equal(again.ok && again.changed, false);
    await s.orchestrator.shutdown(1_000);
    assert.deepEqual(await s.orchestrator.updateAgentSettings({ max_concurrent_agents: 1 }), { ok: false, reason: 'stopping' });
  });

  it('keeps the override when WORKFLOW.md reloads and shows both values', async () => {
    const s = setup({ front, issues: [] });
    await s.orchestrator.updateAgentSettings({ max_concurrent_agents: 4 });
    s.workflow.current = makeWorkflow(baseFront(s.root, { agent: { max_concurrent_agents: 6 } }));
    assert.deepEqual(snapshot(s).limits.max_concurrent_agents, { effective: 4, workflow: 6, override: 4 });
    await s.orchestrator.resetAgentSettings();
    assert.deepEqual(snapshot(s).limits.max_concurrent_agents, { effective: 6, workflow: 6, override: null });
  });

  it('survives a restart and writes settings_changed', async () => {
    const logDir = tempDir();
    const dir = tempDir();
    const history = new HistoryLog(path.join(dir, 'repositories'), new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent()), Logger.silent());
    const first = setup({ front, logDir, history });
    await first.orchestrator.updateAgentSettings({ max_concurrent_agents: 5, max_concurrent_agents_by_state: { Todo: 2 } });
    const file = path.join(logDir, 'state', 'github_project.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).settings, { max_concurrent_agents: 5, max_concurrent_agents_by_state: { todo: 2 } });
    const changed = readHistory(history.dir, null).entries.find((entry) => entry.event === 'settings_changed')?.fields ?? {};
    assert.equal(changed.source, 'dashboard');
    assert.deepEqual(
      [changed.old_max_concurrent_agents, changed.new_max_concurrent_agents, changed.old_by_state, changed.new_by_state],
      ['3', '5', 'In Progress=1', 'In Progress=1, Todo=2'],
    );

    const second = setup({ front, logDir });
    assert.deepEqual(snapshot(second).limits.max_concurrent_agents, { effective: 5, workflow: 3, override: 5 });
    assert.equal(snapshot(second).limits.by_state.Todo?.effective, 2);
    await second.orchestrator.resetAgentSettings();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).settings, { max_concurrent_agents: null, max_concurrent_agents_by_state: {} });
    assert.equal(snapshot(setup({ front, logDir })).limits.override_active, false);

    // A hand-edited file: out-of-range values are dropped.
    fs.writeFileSync(file, JSON.stringify({ version: 1, model_holds: [], settings: { max_concurrent_agents: 99, max_concurrent_agents_by_state: { todo: 0, 'in progress': 2 } } }));
    const edited = snapshot(setup({ front, logDir })).limits;
    assert.equal(edited.max_concurrent_agents.override, null);
    assert.deepEqual(edited.by_state['In Progress'], { effective: 2, workflow: 1, override: 2 });
    assert.equal(edited.by_state.Todo?.override, null);
  });
});

describe('reserved slots by role', () => {
  const hanging = () =>
    new FakeRunner((turn, params) => new Promise((resolve) => params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: String(turn), code: 'turn_cancelled', message: 'cancelled' }))));
  /** A plugin with the skill behind /plan, so the dispatch preflight finds it. */
  const plugin = tempDir('symphony-plugin-');
  fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'symphony' }));
  fs.mkdirSync(path.join(plugin, 'skills', 'plan'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'skills', 'plan', 'SKILL.md'), '---\nname: plan\n---\n');
  const front = (agent: Record<string, unknown> = {}) => ({
    agent: { max_concurrent_agents: 3, max_continuations: 3, reserved_slots_by_role: { developer: 1, reviewer: 1 }, ...agent },
    claude: { plugins: [plugin] },
    tracker: {
      kind: 'github_project',
      provider: { owner: 'acme', project_number: 1, token: 'test-token' },
      active_states: ['Ready', 'In progress', 'Agent review'],
      terminal_states: ['Done'],
    },
    roles: {
      developer: { states: ['Ready', 'In progress'] },
      reviewer: { states: ['Agent review'], read_only: true },
      planner: { states: ['Ready', 'In progress'], commands: ['plan'], read_only: true },
    },
  });
  const ready = (count: number) => Array.from({ length: count }, (_, i) => makeIssue({ id: `dev-${i + 1}`, state: 'Ready', priority: 2 }));
  const runningRoles = (s: Setup) => snapshot(s).running.map((row) => [row.issue_id, row.role]);

  it('runs two developers with one slot free, then starts a reviewer at the next tick while both keep running', async () => {
    const s = setup({ runner: hanging(), front: front(), issues: ready(5) });
    await s.orchestrator.tickNow();
    await until(() => s.runner.sessions.length === 2, 3_000, 'two developers');
    await s.orchestrator.tickNow();
    assert.equal(s.runner.sessions.length, 2, 'the third slot stays free');
    const waiting = snapshot(s).queue.find((item) => item.issue_id === 'dev-3');
    assert.deepEqual(waiting?.reason, { code: 'reserved_for_role', text: 'the free slot is reserved for reviewer' });
    const limits = snapshot(s).limits;
    assert.deepEqual(limits.reserved_slots_by_role.developer, { effective: 1, workflow: 1, override: null, running: 2 });
    assert.deepEqual(limits.reserved_slots_by_role.reviewer, { effective: 1, workflow: 1, override: null, running: 0 });
    assert.deepEqual(limits.reserved_slots_by_role.planner, { effective: 0, workflow: 0, override: null, running: 0 });
    assert.equal(limits.reservation_problem, null);

    s.tracker.issues.set('review', makeIssue({ id: 'review', state: 'Agent review', priority: 4 }));
    await s.orchestrator.tickNow();
    await until(() => s.runner.sessions.length === 3, 3_000, 'reviewer started');
    assert.deepEqual(runningRoles(s), [['dev-1', 'developer'], ['dev-2', 'developer'], ['review', 'reviewer']]);
    await s.orchestrator.shutdown(1_000);
  });

  it('does not give the developer reservation to a /plan issue', async () => {
    const plan = (id: string) => makeIssue({ id, state: 'Ready', priority: 1, description: '/plan\nitems' });
    const s = setup({ runner: hanging(), front: front(), issues: [plan('plan-1'), plan('plan-2')] });
    await s.orchestrator.tickNow();
    await until(() => s.runner.sessions.length === 1, 3_000, 'one planner');
    await s.orchestrator.tickNow();
    assert.equal(s.runner.sessions.length, 1, 'the other two slots are reserved');
    assert.equal(snapshot(s).queue.find((item) => item.issue_id === 'plan-2')?.reason?.code, 'reserved_for_role');

    s.tracker.issues.set('dev-1', makeIssue({ id: 'dev-1', state: 'Ready', priority: 2 }));
    await s.orchestrator.tickNow();
    await until(() => s.runner.sessions.length === 2, 3_000, 'developer started');
    assert.deepEqual(runningRoles(s), [['plan-1', 'planner'], ['dev-1', 'developer']]);
    await s.orchestrator.shutdown(1_000);
  });

  it('keeps the Agent review limit of one reviewer', async () => {
    const reviews = [makeIssue({ id: 'review-1', state: 'Agent review', priority: 1 }), makeIssue({ id: 'review-2', state: 'Agent review', priority: 1 })];
    const s = setup({ runner: hanging(), front: front({ max_concurrent_agents_by_state: { 'Agent review': 1 } }), issues: [...reviews, ...ready(1)] });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running.length === 2, 3_000, 'one reviewer, one developer');
    await s.orchestrator.tickNow();
    assert.deepEqual(runningRoles(s), [['review-1', 'reviewer'], ['dev-1', 'developer']]);
    assert.equal(snapshot(s).queue.find((item) => item.issue_id === 'review-2')?.reason?.code, 'column_limit');
    await s.orchestrator.shutdown(1_000);
  });

  it('reports a role that results lead to but no slot reaches, and logs it once', async () => {
    const lines: string[] = [];
    const logger = Logger.create({ sinks: [{ name: 'memory', write: (line) => lines.push(line) }], level: 'debug' });
    const base = front({ max_concurrent_agents: 2 });
    const withTesting = {
      ...base,
      tracker: { ...base.tracker, active_states: ['Ready', 'In progress', 'Testing', 'Agent review'] },
      roles: {
        ...base.roles,
        developer: { states: ['Ready', 'In progress'], result: 'implementation', on_result: { done: 'Testing', blocked: 'Blocked' }, may_move_to: ['Testing', 'Blocked'] },
        'test-engineer': { states: ['Testing'], result: 'test', on_result: { passed: 'Agent review', failed: 'In progress', blocked: 'Blocked' }, may_move_to: ['Agent review', 'In progress', 'Blocked'] },
      },
    };
    const s = setup({ runner: hanging(), front: withTesting, issues: ready(1), logger });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running.length === 1, 3_000, 'one developer');
    await s.orchestrator.tickNow();
    const problem = 'role test-engineer never starts in Testing: the reservations of the other roles (developer 1 + reviewer 1 = 2) take every one of the 2 agent slots; raise the limit or reserve a slot for test-engineer';
    assert.deepEqual(snapshot(s).limits.slot_problems, [problem]);
    assert.equal(lines.filter((line) => line.includes(problem)).length, 1, 'logged once');
    await s.orchestrator.shutdown(1_000);
  });

  it('ignores reservations above the limit, logs the problem and reports it under limits', async () => {
    const lines: string[] = [];
    const logger = Logger.create({ sinks: [{ name: 'memory', write: (line) => lines.push(line) }], level: 'debug' });
    const s = setup({ runner: hanging(), front: front({ max_concurrent_agents: 1 }), issues: ready(2), logger });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running.length === 1, 3_000, 'one developer');
    await s.orchestrator.tickNow();
    const problem = 'reserved slots ignored: the reservations (developer 1 + reviewer 1 = 2) exceed the limit of 1 agent slot';
    assert.equal(snapshot(s).limits.reservation_problem, problem);
    assert.equal(lines.filter((line) => line.includes(problem)).length, 1, 'logged once');
    assert.equal(snapshot(s).queue.find((item) => item.issue_id === 'dev-2')?.reason?.code, 'no_free_slot');
    await s.orchestrator.shutdown(1_000);
  });

  it('changes reservations from the dashboard and refuses a limit below their sum', async () => {
    const logDir = tempDir();
    const s = setup({ runner: hanging(), front: front(), issues: ready(5), logDir });
    const invalid = async (body: unknown, pattern: RegExp) => {
      const result = await s.orchestrator.updateAgentSettings(body);
      assert.equal(result.ok, false, JSON.stringify(body));
      assert.match(result.ok === false && result.reason === 'invalid' ? result.message : '', pattern);
    };
    await invalid({ max_concurrent_agents: 1 }, /the limit of 1 agent slot is below the reserved slots \(developer 1 \+ reviewer 1 = 2\); lower the reservations first/);
    await invalid({ reserved_slots_by_role: { planner: 2 } }, /below the reserved slots \(developer 1 \+ reviewer 1 \+ planner 2 = 4\)/);
    await invalid({ reserved_slots_by_role: { tester: 1 } }, /tester is not a role; use one of developer, reviewer, planner/);
    await invalid({ reserved_slots_by_role: { developer: -1 } }, /0 to 50/);
    await invalid({ reserved_slots_by_role: [] }, /object/);
    // 0 pauses new dispatches, reservations or not.
    assert.equal((await s.orchestrator.updateAgentSettings({ max_concurrent_agents: 0 })).ok, true);
    assert.equal((await s.orchestrator.updateAgentSettings({ max_concurrent_agents: null })).ok, true);

    // Without the reviewer reservation all three slots go to developers.
    const result = await s.orchestrator.updateAgentSettings({ reserved_slots_by_role: { reviewer: 0 } });
    assert.equal(result.ok && result.changed, true);
    assert.deepEqual(snapshot(s).limits.reserved_slots_by_role.reviewer, { effective: 0, workflow: 1, override: 0, running: 0 });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running.length === 3, 3_000, 'three developers');
    // Lowering the limit to 1 now fits the remaining developer reservation.
    assert.equal((await s.orchestrator.updateAgentSettings({ max_concurrent_agents: 1 })).ok, true);

    const file = path.join(logDir, 'state', 'github_project.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).settings, {
      max_concurrent_agents: 1,
      max_concurrent_agents_by_state: {},
      reserved_slots_by_role: { reviewer: 0 },
    });
    assert.deepEqual(snapshot(setup({ front: front(), logDir })).limits.reserved_slots_by_role.reviewer, { effective: 0, workflow: 1, override: 0, running: 0 });
    await s.orchestrator.shutdown(1_000);
  });
});

describe('stage skipping', () => {
  const BOARD = ['Backlog', 'Ready', 'In progress', 'Agent review', 'Blocked', 'In review', 'Done'];
  const front = (extra: Record<string, unknown> = {}) => ({
    tracker: {
      kind: 'github_project',
      provider: { owner: 'acme', project_number: 1, token: 'test-token' },
      active_states: ['Ready', 'In progress', 'Agent review'],
      terminal_states: ['Done'],
    },
    roles: {
      analyst: { states: ['Ready'], read_only: true, result: 'analysis', on_result: { ready: 'next' } },
      developer: { states: ['In progress'] },
      reviewer: { states: ['Agent review'], read_only: true },
    },
    pipeline: { analysis: 'when_unlabeled' },
    ...extra,
  });
  const withBoard = (s: Setup) => {
    s.tracker.statusOptions = async () => BOARD;
  };
  const issueState = (s: Setup, id: string) => s.tracker.issues.get(id)?.state;

  it('moves a labelled issue from Ready to In progress without an analyst session and shows stage_skipped', async () => {
    const s = setup({ front: front(), issues: [makeIssue({ id: 'a', state: 'Ready', labels: ['Type: bugfix', 'Complexity: S'] })] });
    withBoard(s);
    await s.orchestrator.tickNow();
    await until(() => issueState(s, 'a') === 'In progress', 3_000, 'move to In progress');
    assert.equal(s.runner.sessions.length, 0, 'no session for the skipped stage');

    const comment = s.tracker.comments.get('a')?.[0]?.body ?? '';
    const marker = decodeMarker(comment);
    assert.equal(marker?.result.kind, 'skipped');
    assert.deepEqual([marker?.meta.role, marker?.meta.run, marker?.meta.target], ['analyst', null, 'In progress']);
    assert.match(comment, /Stage skipped/);

    const skipped = s.orchestrator.issueTimeline('acme/app#a')?.events.find((event) => event.event === 'stage_skipped');
    assert.equal(skipped?.detail?.role, 'analyst');
    assert.equal(skipped?.detail?.target, 'In progress');
    assert.equal(snapshot(s).counts.claimed, 0, 'the claim ends with the skip');

    // The next stage starts as usual, and the timeline of the issue goes on.
    await s.orchestrator.tickNow();
    await until(() => s.runner.sessions.length === 1, 3_000, 'developer session');
    const events = s.orchestrator.issueTimeline('acme/app#a')?.events.map((event) => event.event) ?? [];
    assert.ok(events.indexOf('stage_skipped') < events.indexOf('run_dispatched'));
    await s.orchestrator.shutdown(1_000);
  });

  it('starts the analyst for an issue without Type and Complexity labels', async () => {
    const s = setup({ front: front(), runner: new FakeRunner(() => new Promise(() => undefined)), issues: [makeIssue({ id: 'a', state: 'Ready', labels: ['Type: bugfix'] })] });
    withBoard(s);
    await s.orchestrator.tickNow();
    await until(() => s.runner.sessions.length === 1, 3_000, 'analyst session');
    assert.equal(issueState(s, 'a'), 'Ready');
    assert.equal(s.tracker.comments.size, 0);
    await s.orchestrator.shutdown(1_000);
  });

  it('runs the analyst for every issue with pipeline.analysis: always', async () => {
    const s = setup({ front: front({ pipeline: { analysis: 'always' } }), runner: new FakeRunner(() => new Promise(() => undefined)), issues: [makeIssue({ id: 'a', state: 'Ready', labels: ['Type: bugfix', 'Complexity: S'] })] });
    withBoard(s);
    await s.orchestrator.tickNow();
    await until(() => s.runner.sessions.length === 1, 3_000, 'analyst session');
    assert.equal(s.tracker.statusCalls.length, 0);
    await s.orchestrator.shutdown(1_000);
  });

  it('skips a role the issue profile lists, passing over consecutive skipped stages', async () => {
    const s = setup({
      front: front({ pipeline: { profiles: { bugfix: { skip: ['analyst', 'developer'] } } } }),
      issues: [makeIssue({ id: 'a', state: 'Ready', labels: ['Type: bugfix'] })],
    });
    withBoard(s);
    await s.orchestrator.tickNow();
    await until(() => issueState(s, 'a') === 'Agent review', 3_000, 'move to Agent review');
    assert.equal(s.runner.sessions.length, 0);
    assert.equal(s.tracker.comments.get('a')?.length, 1);
    const marker = decodeMarker(s.tracker.comments.get('a')?.[0]?.body ?? '');
    assert.deepEqual([marker?.meta.role, marker?.meta.profile, marker?.meta.target], ['analyst', 'bugfix', 'Agent review']);
    await s.orchestrator.shutdown(1_000);
  });

  it('does not skip when the tracker does not list its columns', async () => {
    const roles = { analyst: { states: ['Ready'], read_only: true, result: 'analysis' }, developer: { states: ['In progress'] }, reviewer: { states: ['Agent review'] } };
    const s = setup({ front: front({ roles }), runner: new FakeRunner(() => new Promise(() => undefined)), issues: [makeIssue({ id: 'a', state: 'Ready', labels: ['Type: bugfix', 'Complexity: S'] })] });
    await s.orchestrator.tickNow();
    await until(() => s.runner.sessions.length === 1, 3_000, 'analyst session');
    assert.equal(s.tracker.statusCalls.length, 0);
    await s.orchestrator.shutdown(1_000);
  });

  it('starts a skipped stage when the operator forces the issue', async () => {
    const s = setup({ front: front(), issues: [makeIssue({ id: 'a', state: 'Ready', labels: ['Type: bugfix', 'Complexity: S'] })] });
    withBoard(s);
    await s.orchestrator.tickNow();
    await until(() => issueState(s, 'a') === 'In progress', 3_000, 'skip');
    s.tracker.set('a', { state: 'Ready' });
    const result = await s.orchestrator.forceStart('acme/app#a');
    assert.equal(result.ok, true);
    await until(() => s.runner.sessions.length === 1, 3_000, 'forced analyst session');
    await s.orchestrator.shutdown(1_000);
  });

  it('keeps the issue in place when the move fails, posts the comment once and moves it when the board works again', async () => {
    const s = setup({ front: front(), issues: [makeIssue({ id: 'a', state: 'Ready', labels: ['Type: bugfix', 'Complexity: S'] })] });
    withBoard(s);
    const setStatus = s.tracker.setStatus.bind(s.tracker);
    let calls = 0;
    s.tracker.setStatus = async (...args: Parameters<typeof setStatus>) => {
      calls += 1;
      if (calls <= 2) throw new Error('board unreachable');
      return setStatus(...args);
    };
    await s.orchestrator.tickNow();
    await until(() => calls === 1 && snapshot(s).counts.claimed === 0, 3_000, 'first failed skip');
    assert.equal(issueState(s, 'a'), 'Ready');
    await s.orchestrator.tickNow();
    await until(() => calls === 2 && snapshot(s).counts.claimed === 0, 3_000, 'second failed skip');
    assert.equal(issueState(s, 'a'), 'Ready');
    assert.equal(s.tracker.comments.get('a')?.length, 1, 'no duplicate comment on the retry');
    await s.orchestrator.tickNow();
    await until(() => issueState(s, 'a') === 'In progress', 3_000, 'move once the board works');
    assert.equal(s.tracker.comments.get('a')?.length, 1);
    assert.equal(s.runner.sessions.length, 0);
    await s.orchestrator.shutdown(1_000);
  });

  it('reports a skip into a column with an entry check as a dispatch error and starts nothing', async () => {
    const s = setup({ front: front({ checks: { on_enter: { 'In progress': 'true' } } }), issues: [makeIssue({ id: 'a', state: 'Ready', labels: ['Type: bugfix', 'Complexity: S'] })] });
    withBoard(s);
    await s.orchestrator.tickNow();
    assert.match(snapshot(s).health.dispatch_errors.join(), /pipeline\.analysis: skipping analyst moves issues from "Ready" to "In progress" without a workspace, but checks\.on_enter has a script/);
    assert.equal(s.runner.sessions.length, 0);
    assert.equal(s.tracker.statusCalls.length, 0);
    await s.orchestrator.shutdown(1_000);
  });
});

describe('result-driven roles', () => {
  const front = (checks: Record<string, string> = {}, reviewer: Record<string, unknown> = {}) => ({
    tracker: {
      kind: 'github_project',
      provider: { owner: 'acme', project_number: 1, token: 'test-token' },
      active_states: ['Todo', 'Agent review'],
    },
    agent: { max_turns: 2 },
    roles: {
      developer: { states: ['Todo'], may_move_to: ['Agent review', 'Blocked'] },
      reviewer: {
        states: ['Agent review'],
        read_only: true,
        result: 'review',
        may_move_to: ['In review', 'Todo', 'Blocked'],
        on_result: { approved: 'In review', changes_needed: 'Todo' },
        ...reviewer,
      },
    },
    checks: { on_enter: checks },
  });
  const prompt = '{{ role }}|required={{ result_required }}|round={{ round }}|latest={{ results.latest.size }}|findings={{ results.open_findings.size }}|cases={{ results.failed_cases.size }}';
  const toolNames = (runner: FakeRunner) => runner.sessions.map((session) => session.params.tools.map((tool) => tool.name));

  /** A persisted result comment by the tracker's own account. */
  function persist(tracker: FakeTracker, issueId: string, kind: 'review' | 'implementation', input: Record<string, unknown>, role: string, at: string): void {
    const parsed = parseResult(kind, input);
    assert.ok(parsed.ok);
    const meta: ResultMeta = { role, run: `run-${role}-${at}`, round: null, profile: null, workflow_hash: null, head_sha: null, checks: null, target: null, created_at: at };
    const list = tracker.comments.get(issueId) ?? [];
    list.push({ author: tracker.viewer, createdAt: new Date(at), body: renderResultComment(parsed.result, meta), url: `https://github.com/acme/app/issues/${issueId}#c${list.length}` });
    tracker.comments.set(issueId, list);
  }

  it('gives roles without a result no extra request, no report_result tool and defined prompt variables', async () => {
    const s = setup({ front: front(), prompt, issues: [makeIssue({ id: 'd' })] });
    await s.orchestrator.tickNow();
    await until(() => s.runner.sessions.length === 1, 3_000, 'session');
    assert.equal(s.tracker.calls.readResults, 0);
    assert.deepEqual(toolNames(s.runner), [['set_status']]);
    assert.equal(s.runner.sessions[0]?.turns[0], 'developer|required=false|round=1|latest=0|findings=0|cases=0');
    await s.orchestrator.shutdown(1_000);
  });

  it('starts a result role with the stage history in its prompt and the report_result tool', async () => {
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const s = setup({ front: front(), runner, prompt, issues: [makeIssue({ id: 'r', state: 'Agent review' })] });
    persist(s.tracker, 'r', 'implementation', { verdict: 'done', summary: 'Built it.' }, 'developer', '2026-10-01T10:00:00Z');
    persist(
      s.tracker,
      'r',
      'review',
      { verdict: 'changes_needed', summary: 'Two problems.', findings: [{ severity: 'major', file: 'a.ts', problem: 'Off by one' }, { severity: 'nit', problem: 'Typo' }] },
      'reviewer',
      '2026-10-01T11:00:00Z',
    );
    await s.orchestrator.tickNow();
    await until(() => runner.sessions.length === 1, 3_000, 'session');
    assert.equal(s.tracker.calls.readResults, 1);
    assert.deepEqual(toolNames(runner), [['report_result']]);
    assert.equal(runner.sessions[0]?.turns[0], 'reviewer|required=true|round=2|latest=2|findings=2|cases=0');
    await s.orchestrator.shutdown(1_000);
  });

  it('records the result and moves the issue through the tool the session calls', async () => {
    const runner = new FakeRunner(async (turn, params) => {
      await callTool(params, 'report_result', { verdict: 'approved', summary: 'Fine.' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    });
    const s = setup({ front: front(), runner, issues: [makeIssue({ id: 'r', state: 'Agent review' })] });
    await s.orchestrator.tickNow();
    await until(() => s.tracker.statusCalls.length === 1, 5_000, 'report_result');
    assert.deepEqual(s.tracker.statusCalls, ['In review']);
    const marker = decodeMarker(s.tracker.comments.get('r')?.[0]?.body ?? '');
    assert.equal(marker?.meta.role, 'reviewer');
    assert.equal(marker?.meta.target, 'In review');
    assert.match(marker?.meta.run ?? '', /^[0-9a-f]{12}$/);
    assert.equal(marker?.meta.workflow_hash, 'test');
  });

  it('records a hand-off when reconciliation stops a run after its own result moved the issue', async () => {
    const reported: unknown[] = [];
    const runner = new FakeRunner(async (_turn, params) => {
      reported.push(await callTool(params, 'report_result', { verdict: 'approved', summary: 'Fine.' }));
      // The agent is still finishing its turn when the next tick sees the issue in "In review".
      return new Promise((resolve) => params.signal.addEventListener('abort', () => resolve({ ok: false, turnId: '1', code: 'turn_cancelled', message: 'cancelled' })));
    });
    const s = setup({ front: front(), runner, issues: [makeIssue({ id: 'r', state: 'Agent review' })] });
    await s.orchestrator.tickNow();
    await until(() => reported.length === 1, 5_000, 'report_result');
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).running.length === 0, 5_000, 'run stopped');
    const session = s.orchestrator.issueDetail('acme/app#r')?.sessions[0];
    assert.equal(session?.outcome, 'handed_off');
  });

  it('shows the loaded results, verdicts and rounds in the issue detail while the session runs', async () => {
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const s = setup({ front: front(), runner, issues: [makeIssue({ id: 'r', state: 'Agent review' })] });
    persist(s.tracker, 'r', 'implementation', { verdict: 'done', summary: 'Built it.' }, 'developer', '2026-10-01T10:00:00Z');
    persist(s.tracker, 'r', 'review', { verdict: 'changes_needed', summary: 'One problem.', findings: [{ severity: 'major', problem: 'Off by one' }] }, 'reviewer', '2026-10-01T11:00:00Z');
    await s.orchestrator.tickNow();
    await until(() => runner.sessions.length === 1, 3_000, 'session');
    const detail = s.orchestrator.issueDetail('acme/app#r');
    assert.deepEqual(detail?.results.map((row) => [row.role, row.kind, row.verdict]), [['developer', 'implementation', 'done'], ['reviewer', 'review', 'changes_needed']]);
    const stage = (id: string) => detail?.pipeline.find((candidate) => candidate.id === id);
    assert.equal(stage('developer')?.verdict, 'done');
    assert.equal(stage('reviewer')?.verdict, 'changes_needed');
    await s.orchestrator.shutdown(1_000);
  });

  it('adds the result a session reports to the detail and to the archive', async () => {
    const logDir = tempDir();
    const runner = new FakeRunner(async (turn, params) => {
      await callTool(params, 'report_result', { verdict: 'approved', summary: 'Fine.' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    });
    const s = setup({ front: front(), runner, logDir, issues: [makeIssue({ id: 'r', state: 'Agent review' })] });
    await s.orchestrator.tickNow();
    await until(() => s.tracker.statusCalls.length === 1, 5_000, 'report_result');
    await until(() => snapshot(s).running.length === 0, 5_000, 'run finished');
    const detail = s.orchestrator.issueDetail('acme/app#r');
    assert.deepEqual(detail?.results.map((row) => [row.role, row.verdict, row.target, row.round]), [['reviewer', 'approved', 'In review', 1]]);
    const archived = JSON.parse(fs.readFileSync(path.join(logDir, 'issues', 'acme_app_r.json'), 'utf8')) as { version: number; results: Array<{ verdict: string }> };
    assert.equal(archived.version, 2);
    assert.deepEqual(archived.results.map((row) => row.verdict), ['approved']);
  });

  describe('agent.max_continuations', () => {
    /** Developer (no result) <-> reviewer; the reviewer reports changes_needed when `reports` is set. */
    function pingPong(reports: boolean, maxContinuations: number, rounds = 20) {
      const runner = new FakeRunner(async (turn, params) => {
        const report = params.tools.find((tool) => tool.name === 'report_result');
        if (report === undefined) {
          s.tracker.set('p', { state: 'Agent review' });
        } else if (reports) {
          await report.execute({ verdict: 'changes_needed', summary: 'Again.', findings: [{ severity: 'major', file: 'a.ts', problem: 'Still wrong' }] }, params.toolContext());
        } else {
          s.tracker.set('p', { state: 'Todo' });
        }
        return { ok: true, turnId: String(turn), resultText: 'done' };
      });
      const s = setup({
        front: { ...front(), agent: { max_turns: 2, max_continuations: maxContinuations }, pipeline: { max_review_rounds: rounds } },
        runner,
        issues: [makeIssue({ id: 'p', state: 'Todo' })],
      });
      return s;
    }
    const driveTo = async (s: ReturnType<typeof setup>, sessions: number) => {
      await s.orchestrator.tickNow();
      for (let n = 1; n < sessions; n++) {
        await until(() => s.runner.sessions.length === n && snapshot(s).retrying.length === 1, 3_000, `session ${n}`);
        s.timers.fire(1_000);
      }
      await until(() => s.runner.sessions.length === sessions, 3_000, `session ${sessions}`);
    };

    it('does not pause a chain of result hand-offs', async () => {
      const s = pingPong(true, 2);
      await driveTo(s, 8);
      await until(() => snapshot(s).retrying.length === 1, 3_000, 'retry after the last session');
      assert.equal(snapshot(s).counts.paused, 0);
      await s.orchestrator.shutdown(1_000);
    });

    it('ends ping-pong between result roles at the round limit, not at max_continuations', async () => {
      const s = pingPong(true, 2, 2);
      await driveTo(s, 4);
      await until(() => snapshot(s).running.length === 0, 3_000, 'last run end');
      s.timers.fire(1_000);
      await s.orchestrator.tickNow();
      assert.equal(snapshot(s).counts.paused, 0);
      assert.equal(s.runner.sessions.length, 4);
      assert.notEqual(s.tracker.issues.get('p')?.state, 'Todo');
      await s.orchestrator.shutdown(1_000);
    });

    it('still pauses ping-pong between roles without a result', async () => {
      const s = pingPong(false, 2);
      await driveTo(s, 3);
      await until(() => snapshot(s).retrying.length === 1, 3_000, 'retry');
      s.timers.fire(1_000);
      await until(() => snapshot(s).counts.paused === 1, 3_000, 'paused');
      assert.equal(s.runner.sessions.length, 3);
    });
  });

  it('moves a reviewer whose hand-off check fails to on_check_failed and records why', async () => {
    const runner = new FakeRunner(async (turn, params) => {
      reported.push(await callTool(params, 'report_result', { verdict: 'approved', summary: 'Fine.' }));
      return { ok: true, turnId: String(turn), resultText: 'done' };
    });
    const reported: ToolResult[] = [];
    const s = setup({
      front: front({ 'In review': 'echo "lint failed"; exit 1' }, { on_check_failed: 'Todo' }),
      runner,
      issues: [makeIssue({ id: 'r', state: 'Agent review' })],
    });
    await s.orchestrator.tickNow();
    await until(() => reported.length === 1, 5_000, 'report_result');
    assert.deepEqual(s.tracker.statusCalls, ['Todo']);
    assert.equal(s.tracker.issues.get('r')?.state, 'Todo');
    const [result] = reported;
    assert.ok(result?.ok);
    assert.equal((result.data as Record<string, unknown>).target, 'Todo');
    assert.equal((result.data as Record<string, unknown>).check_failed_for, 'In review');

    const comments = s.tracker.comments.get('r') ?? [];
    assert.equal(comments.length, 1);
    const marker = decodeMarker(comments[0]?.body ?? '');
    assert.equal(marker?.result.verdict, 'approved');
    assert.equal(marker?.meta.target, 'Todo');
    assert.equal(marker?.meta.checks?.result, 'check_failed');
    assert.match(marker?.result.summary ?? '', /Fine\.[\s\S]*Entry check failed[\s\S]*"In review"[\s\S]*"Todo"[\s\S]*lint failed/);
  });

  it('keeps the denial for a failed check when the role has no on_check_failed', async () => {
    const reported: ToolResult[] = [];
    const runner = new FakeRunner(async (turn, params) => {
      reported.push(await callTool(params, 'report_result', { verdict: 'approved', summary: 'Fine.' }));
      return { ok: true, turnId: String(turn), resultText: 'done' };
    });
    const s = setup({ front: front({ 'In review': 'echo "lint failed"; exit 1' }), runner, issues: [makeIssue({ id: 'r', state: 'Agent review' })] });
    await s.orchestrator.tickNow();
    await until(() => reported.length === 1, 5_000, 'report_result');
    assert.equal(reported[0]?.ok === false ? reported[0].error.category : null, 'check_failed');
    assert.deepEqual(s.tracker.statusCalls, []);
    assert.equal(s.tracker.comments.get('r'), undefined);
  });

  /** A review marker that handed the issue to `target` (a round limit when `target` is not active). */
  function persistReview(tracker: FakeTracker, issueId: string, verdict: 'changes_needed' | 'approved', target: string, at: string): void {
    const parsed = parseResult('review', verdict === 'approved' ? { verdict, summary: 'Fine.' } : { verdict, summary: 'Again.', findings: [{ severity: 'major', problem: 'Bug' }] });
    assert.ok(parsed.ok);
    const meta: ResultMeta = { role: 'reviewer', run: `run-${at}`, round: null, profile: null, workflow_hash: null, head_sha: null, checks: null, target, created_at: at };
    const list = tracker.comments.get(issueId) ?? [];
    list.push({ author: tracker.viewer, createdAt: new Date(at), body: renderResultComment(parsed.result, meta), url: `https://github.com/acme/app/issues/${issueId}#c${list.length}` });
    tracker.comments.set(issueId, list);
  }

  it('resets the round counters and the limit label when a human moves the issue back after a limit', async () => {
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const s = setup({ front: front(), runner, prompt, issues: [makeIssue({ id: 'r', state: 'Agent review', labels: ['needs-human'] })] });
    s.tracker.repositoryLabels.add('needs-human');
    persistReview(s.tracker, 'r', 'changes_needed', 'Todo', '2026-10-01T10:00:00Z');
    persistReview(s.tracker, 'r', 'changes_needed', 'Todo', '2026-10-01T11:00:00Z');
    persistReview(s.tracker, 'r', 'changes_needed', 'In review', '2026-10-01T12:00:00Z');
    await s.orchestrator.tickNow();
    await until(() => runner.sessions.length === 1, 3_000, 'session');
    assert.equal(runner.sessions[0]?.turns[0], 'reviewer|required=true|round=1|latest=1|findings=0|cases=0');
    const comments = s.tracker.comments.get('r') ?? [];
    assert.equal(comments.length, 4);
    assert.equal(decodeMarker(comments[3]?.body ?? '')?.result.kind, 'reset');
    assert.deepEqual(s.tracker.issues.get('r')?.labels, []);
    await s.orchestrator.shutdown(1_000);
  });

  it('writes no reset without a human move: the issue was handed to an active column', async () => {
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const s = setup({ front: front(), runner, prompt, issues: [makeIssue({ id: 'r', state: 'Agent review' })] });
    persistReview(s.tracker, 'r', 'changes_needed', 'Agent review', '2026-10-01T10:00:00Z');
    await s.orchestrator.tickNow();
    await until(() => runner.sessions.length === 1, 3_000, 'session');
    assert.equal(runner.sessions[0]?.turns[0], 'reviewer|required=true|round=2|latest=1|findings=1|cases=0');
    assert.equal(s.tracker.comments.get('r')?.length, 1);
    await s.orchestrator.shutdown(1_000);
  });

  describe('a stage that ends without a result', () => {
    const silent = () => new FakeRunner((turn) => ({ ok: true, turnId: String(turn), resultText: 'done' }));

    it('reminds a reviewer once, then comments and moves the issue to Blocked', async () => {
      const runner = silent();
      const s = setup({ front: front(), runner, issues: [makeIssue({ id: 'r', state: 'Agent review' })] });
      await s.orchestrator.tickNow();
      await until(() => s.tracker.statusCalls.length === 1, 5_000, 'move to Blocked');
      assert.deepEqual(s.tracker.statusCalls, ['Blocked']);
      assert.equal(s.tracker.issues.get('r')?.state, 'Blocked');
      assert.equal(runner.sessions.length, 1);
      const [first, reminder] = runner.sessions[0]?.turns ?? [];
      assert.equal(runner.sessions[0]?.turns.length, 2);
      assert.doesNotMatch(first ?? '', /report_result/);
      assert.match(reminder ?? '', /still in the active state/);
      assert.match(reminder ?? '', /call `report_result` now[\s\S]*moves the issue to "Blocked"/);
      assert.match(reminder ?? '', /last turn of the session: nothing still running in the background reports back/);
      const comments = s.tracker.comments.get('r') ?? [];
      assert.equal(comments.length, 1);
      assert.match(comments[0]?.body ?? '', /^\*\*Stage ended without a result\.\*\*/);
      assert.match(comments[0]?.body ?? '', /moved the issue to "Blocked"/);
      assert.equal(decodeMarker(comments[0]?.body ?? ''), null, 'a plain comment, not a stage result');
      assert.doesNotMatch(comments[0]?.body ?? '', /background/);
      await until(() => snapshot(s).running.length === 0, 3_000, 'run end');
      assert.equal(snapshot(s).retrying.length, 0, 'the claim is released');
      await s.orchestrator.shutdown(1_000);
    });

    it('names the background tasks the session left running in the comment', async () => {
      const runner = new FakeRunner((turn) => ({ ok: true, turnId: String(turn), resultText: 'waiting', backgroundTasks: ['Review the diff'] }));
      const s = setup({ front: front(), runner, issues: [makeIssue({ id: 'r', state: 'Agent review' })] });
      await s.orchestrator.tickNow();
      await until(() => s.tracker.statusCalls.length === 1, 5_000, 'move to Blocked');
      assert.match(s.tracker.comments.get('r')?.[0]?.body ?? '', /Still running in the background when the session ended, and stopped with it: "Review the diff"\. A human/);
      await s.orchestrator.shutdown(1_000);
    });

    it('adds the reminder to a custom continuation prompt and honors on_missing_result', async () => {
      const runner = silent();
      const s = setup({
        front: { ...front({}, { on_missing_result: 'Todo' }), agent: { max_turns: 3 } },
        runner,
        issues: [makeIssue({ id: 'r', state: 'Agent review' })],
      });
      s.workflow.current.continuationPrompt = compilePrompt('Go on, turn {{ turn_number }}.');
      await s.orchestrator.tickNow();
      await until(() => s.tracker.statusCalls.length === 1, 5_000, 'move');
      assert.deepEqual(s.tracker.statusCalls, ['Todo']);
      const turns = runner.sessions[0]?.turns ?? [];
      assert.equal(turns.length, 2, 'one reminder turn, not all three');
      assert.match(turns[1] ?? '', /^Go on, turn 2\.\n\nYour stage ends with a result: call `report_result` now[\s\S]*"Todo"/);
      await s.orchestrator.shutdown(1_000);
    });

    it('moves a reviewer that reaches max_turns of 1 without a reminder', async () => {
      const runner = silent();
      const s = setup({ front: { ...front(), agent: { max_turns: 1 } }, runner, issues: [makeIssue({ id: 'r', state: 'Agent review' })] });
      await s.orchestrator.tickNow();
      await until(() => s.tracker.statusCalls.length === 1, 5_000, 'move');
      assert.equal(runner.sessions[0]?.turns.length, 1);
      assert.deepEqual(s.tracker.statusCalls, ['Blocked']);
      await s.orchestrator.shutdown(1_000);
    });

    it('does not end the stage when the reviewer reports after the reminder', async () => {
      const runner = new FakeRunner(async (turn, params) => {
        if (turn === 2) await callTool(params, 'report_result', { verdict: 'approved', summary: 'Fine.' });
        return { ok: true, turnId: String(turn), resultText: 'done' };
      });
      const s = setup({ front: front(), runner, issues: [makeIssue({ id: 'r', state: 'Agent review' })] });
      await s.orchestrator.tickNow();
      await until(() => s.tracker.statusCalls.length === 1, 5_000, 'report_result');
      await until(() => snapshot(s).running.length === 0, 3_000, 'run end');
      assert.deepEqual(s.tracker.statusCalls, ['In review']);
      assert.equal(s.tracker.comments.get('r')?.length, 1, 'only the result comment');
      await s.orchestrator.shutdown(1_000);
    });

    it('leaves an issue alone that was moved meanwhile', async () => {
      let turnsDone = 0;
      const runner = new FakeRunner((turn) => {
        turnsDone = turn;
        return { ok: true, turnId: String(turn), resultText: 'done' };
      });
      const s = setup({ front: front(), runner, issues: [makeIssue({ id: 'r', state: 'Agent review' })] });
      // A human moves the issue right after the worker's last look at it.
      const fetchIds = s.tracker.fetchIssuesByIds.bind(s.tracker);
      let moved = false;
      s.tracker.fetchIssuesByIds = async (ids) => {
        const issues = await fetchIds(ids);
        if (turnsDone === 2 && !moved) {
          moved = true;
          s.tracker.set('r', { state: 'In review' });
        }
        return issues;
      };
      await s.orchestrator.tickNow();
      await until(() => moved, 5_000, 'the human move');
      await until(() => snapshot(s).retrying.length === 1, 3_000, 'continuation retry');
      assert.equal(snapshot(s).retrying[0]?.kind, 'continuation');
      assert.deepEqual(s.tracker.statusCalls, []);
      assert.equal(s.tracker.comments.get('r'), undefined);
      assert.equal(s.tracker.issues.get('r')?.state, 'In review');
      await s.orchestrator.shutdown(1_000);
    });

    it('retries like a failed run when the tracker cannot move the issue', async () => {
      const s = setup({ front: front(), runner: silent(), issues: [makeIssue({ id: 'r', state: 'Agent review' })] });
      s.tracker.setStatus = async () => {
        throw new Error('GitHub is down');
      };
      await s.orchestrator.tickNow();
      await until(() => snapshot(s).retrying.length === 1, 5_000, 'retry');
      assert.equal(snapshot(s).retrying[0]?.kind, 'failure');
      assert.match(snapshot(s).retrying[0]?.error ?? '', /moving the issue to "Blocked" failed: GitHub is down/);
      await s.orchestrator.shutdown(1_000);
    });

    it('behaves as before for a role without a result', async () => {
      const runner = silent();
      const s = setup({ front: front(), runner, issues: [makeIssue({ id: 'd' })] });
      await s.orchestrator.tickNow();
      await until(() => snapshot(s).retrying.length === 1, 3_000, 'continuation retry');
      assert.equal(snapshot(s).retrying[0]?.kind, 'continuation');
      assert.equal(runner.sessions[0]?.turns.length, 2);
      assert.doesNotMatch(runner.sessions[0]?.turns[1] ?? '', /report_result/);
      assert.deepEqual(s.tracker.statusCalls, []);
      assert.equal(s.tracker.comments.get('d'), undefined);
      await s.orchestrator.shutdown(1_000);
    });
  });

  it('fails the run with results_read_error when the results cannot be read, and retries', async () => {
    const s = setup({ front: front(), prompt, issues: [makeIssue({ id: 'r', state: 'Agent review' })] });
    s.tracker.failReadResults = new Error('GitHub is down');
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 3_000, 'retry');
    assert.match(snapshot(s).retrying[0]?.error ?? '', /worker exited: results_read_error: could not read the stage results of acme\/app#r: GitHub is down/);
    assert.equal(s.runner.sessions.length, 0, 'no session starts without the history');

    s.timers.fire(10_000);
    await until(() => s.runner.sessions.length === 1, 3_000, 'second attempt');
    assert.equal(s.runner.sessions[0]?.turns[0], 'reviewer|required=true|round=1|latest=0|findings=0|cases=0');
    await s.orchestrator.shutdown(1_000);
  });

  it('keeps the latest rate-limit event per rateLimitType and logs every event', async () => {
    const logDir = tempDir();
    let s: Setup | null = null;
    const before: unknown[] = [];
    const runner = new FakeRunner((turn, params) => {
      const emit = (info: Record<string, unknown>) => {
        before.push(s?.orchestrator.snapshot().rate_limits);
        (params.onEvent as (event: unknown) => void)({ event: 'rate_limit', timestamp: new Date(), pid: 1, threadId: 't', turnId: '1', sessionId: 't-1', turnCount: turn, rateLimits: info });
      };
      emit({ rateLimitType: 'five_hour', status: 'allowed' });
      emit({ rateLimitType: 'seven_day', status: 'allowed' });
      emit({ rateLimitType: 'five_hour', status: 'allowed_warning' });
      return new Promise(() => undefined);
    });
    s = setup({ runner, logDir, issues: [makeIssue({ id: 'a' })] });
    await s.orchestrator.tickNow();
    await until(() => Object.keys(snapshot(s!).rate_limits as object).length === 2, 3_000, 'rate limits');
    assert.deepEqual(before[0], {});
    const limits = snapshot(s).rate_limits as Record<string, { issue: string; role: string; model: string | null; rate_limit_info: { status: string } }>;
    assert.deepEqual(Object.keys(limits).sort(), ['five_hour', 'seven_day']);
    assert.equal(limits.five_hour!.rate_limit_info.status, 'allowed_warning');
    assert.equal(limits.seven_day!.rate_limit_info.status, 'allowed');
    assert.equal(limits.five_hour!.issue, makeIssue({ id: 'a' }).identifier);
    assert.equal(typeof limits.five_hour!.role, 'string');
    const lines = fs.readFileSync(path.join(logDir, 'budget', 'rate-limits.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
  });
});

describe('change log (code changes per commit and merge)', () => {
  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd, encoding: 'utf8' }).trim();
  const PR_OK = { number: 7, url: null, base: 'main', head_sha: null, checks: { state: 'success' as const, failing: [], pending: [] } };

  /** An `origin` repository on `main`; issue workspaces clone it and work on a branch, so `origin/main` is the base. */
  function origin(): string {
    const dir = tempDir('symphony-origin-');
    run(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'README.md'), 'readme\n');
    run(dir, 'add', '-A');
    run(dir, 'commit', '-q', '-m', 'init');
    return dir;
  }

  function cloneInto(dir: string, from: string): void {
    fs.mkdirSync(dir, { recursive: true });
    run(dir, 'clone', '-q', from, '.');
    run(dir, 'checkout', '-q', '-b', 'symphony/issue-a');
  }

  function commitFile(cwd: string, file: string, message: string): void {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), 'one\ntwo\n');
    run(cwd, 'add', '-A');
    run(cwd, 'commit', '-q', '-m', message);
  }

  function changeSetup(script: (params: Parameters<FakeRunner['script']>[1], s: Setup) => Promise<void> | void, issues = [makeIssue({ id: 'a', native_ref: { base_branch: 'main' } })]) {
    const from = origin();
    const runner = new FakeRunner();
    const s = setup({ runner, issues, front: { hooks: { after_create: `git clone -q "${from}" . && git checkout -q -b symphony/issue-a` } } });
    s.tracker.issueRepository = () => 'acme/app';
    runner.script = async (turn, params) => {
      await script(params, s);
      if (s.tracker.issues.get('a')?.state === 'Todo') s.tracker.set('a', { state: 'In review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    };
    return { s, from };
  }

  it('records one code entry per commit of a session, with files, role, diff excerpt and the pull request', async () => {
    const { s } = changeSetup((params) => {
      commitFile(params.cwd, 'docs/guide.md', 'Add the guide');
      commitFile(params.cwd, 'src/app.ts', 'Add the app');
    });
    s.tracker.branchPullRequest = async () => PR_OK;
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 15_000, 'run finished');
    const entries = s.orchestrator.listChanges({ repo: 'acme/app' });
    assert.deepEqual(entries.map((e) => e.title).sort(), ['Add the app', 'Add the guide']);
    const guide = entries.find((e) => e.title === 'Add the guide')!;
    assert.equal(guide.type, 'code');
    assert.equal(guide.status, 'committed');
    assert.equal(guide.issue, 'acme/app#a');
    assert.equal(guide.role, 'default');
    assert.deepEqual(guide.files, [{ path: 'docs/guide.md', added: 2, deleted: 0, status: 'added' }]);
    assert.deepEqual(guide.pr, { number: 7, status: 'success' });
    assert.equal(guide.diff, 'docs/guide.md\n+one\n+two');
    assert.match(guide.id, /^code:acme\/app:[0-9a-f]{40}$/);
    assert.deepEqual(s.orchestrator.listChanges({ issue: 'acme/app#b' }), []);
    await s.orchestrator.shutdown(1_000);
  });

  it('persists the entries under <logDir>/changes/ and loads them at the next start', async () => {
    const logDir = tempDir();
    const from = origin();
    const runner = new FakeRunner();
    const s = setup({ runner, logDir, issues: [makeIssue({ id: 'a', native_ref: { base_branch: 'main' } })], front: { hooks: { after_create: `git clone -q "${from}" . && git checkout -q -b symphony/issue-a` } } });
    s.tracker.issueRepository = () => 'acme/app';
    runner.script = (turn, params) => {
      commitFile(params.cwd, 'docs/guide.md', 'Add the guide');
      s.tracker.set('a', { state: 'In review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    };
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 15_000, 'run finished');
    const lines = fs.readFileSync(path.join(logDir, 'changes', 'acme_app.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]!).title, 'Add the guide');
    await s.orchestrator.shutdown(1_000);
    const restarted = setup({ logDir });
    assert.deepEqual(restarted.orchestrator.listChanges().map((e) => e.title), ['Add the guide']);
  });

  it('records nothing for a session without commits or without git, and a pull request lookup that fails gives pr null', async () => {
    const quiet = changeSetup(() => undefined);
    quiet.s.tracker.branchPullRequest = async () => PR_OK;
    await quiet.s.orchestrator.tickNow();
    await until(() => snapshot(quiet.s).retrying.length === 1, 15_000, 'run finished');
    assert.deepEqual(quiet.s.orchestrator.listChanges(), []);
    await quiet.s.orchestrator.shutdown(1_000);

    const plain = setup({ issues: [makeIssue({ id: 'a' })] });
    await plain.orchestrator.tickNow();
    await until(() => snapshot(plain).retrying.length === 1, 15_000, 'run finished');
    assert.deepEqual(plain.orchestrator.listChanges(), []);
    await plain.orchestrator.shutdown(1_000);

    const failing = changeSetup((params) => commitFile(params.cwd, 'docs/guide.md', 'Add the guide'));
    failing.s.tracker.branchPullRequest = async () => {
      throw new Error('boom');
    };
    await failing.s.orchestrator.tickNow();
    await until(() => snapshot(failing.s).retrying.length === 1, 15_000, 'run finished');
    assert.deepEqual(failing.s.orchestrator.listChanges().map((e) => [e.title, e.pr]), [['Add the guide', null]]);
    await failing.s.orchestrator.shutdown(1_000);
  });

  it('records a merged entry with the branch diff against the base when a move merges the pull request', async () => {
    const { s } = changeSetup(async (params, setup) => {
      commitFile(params.cwd, 'docs/guide.md', 'Add the guide');
      const result = await callTool(params, 'set_status', { status: 'Human Review' });
      assert.equal(result.ok, true);
      assert.equal(setup.tracker.issues.get('a')?.state, 'Done');
    });
    s.tracker.autoMerge = (_issue, column) =>
      column === 'Human Review'
        ? { merged: true, pull_request: 9, status: 'Done', reason: 'merged', checks: { state: 'success', failing: [], pending: [] } }
        : undefined;
    await s.orchestrator.tickNow();
    await until(() => s.orchestrator.listChanges({ type: 'code' }).length === 2, 15_000, 'merge recorded');
    const merged = s.orchestrator.listChanges().find((e) => e.status === 'merged')!;
    assert.equal(merged.id, 'code:acme/app:merge:9');
    assert.equal(merged.title, 'Merged #9: Issue a');
    assert.deepEqual(merged.pr, { number: 9, status: 'success' });
    assert.deepEqual(merged.files, [{ path: 'docs/guide.md', added: 2, deleted: 0, status: 'added' }]);
    assert.equal(merged.diff, null);
    assert.equal(merged.role, 'default');
    await s.orchestrator.shutdown(1_000);
  });

  describe('issue summary after the merge (E8-3)', () => {
    const mergeResult = { merged: true, pull_request: 9, status: 'Done', reason: 'merged', checks: { state: 'success' as const, failing: [], pending: [] } };

    function brainSetup(brainFront: Record<string, unknown> | null) {
      const from = origin();
      const runner = new FakeRunner();
      const front: Record<string, unknown> = { hooks: { after_create: `git clone -q "${from}" . && git checkout -q -b symphony/issue-a` } };
      if (brainFront !== null) front.brain = brainFront;
      const s = setup({ runner, issues: [makeIssue({ id: 'a', native_ref: { base_branch: 'main' } })], front });
      s.tracker.issueRepository = () => 'acme/app';
      s.tracker.autoMerge = (_issue, column) => (column === 'Human Review' ? mergeResult : undefined);
      runner.script = async (turn, params) => {
        commitFile(params.cwd, 'docs/guide.md', 'Add the guide');
        const result = await callTool(params, 'set_status', { status: 'Human Review' });
        assert.equal(result.ok, true);
        return { ok: true, turnId: String(turn), resultText: 'done' };
      };
      return s;
    }

    it('writes Issues/<repo>/<nr>.md into the vault as symphony after the merge', async () => {
      const vault = path.join(tempDir(), 'vault');
      await ensureVault(vault, ['acme/app']);
      const s = brainSetup({ enabled: true, path: vault });
      await s.orchestrator.tickNow();
      const file = path.join(vault, 'Issues', 'acme-app', 'a.md');
      const last = (format: string): string => execFileSync('git', ['log', '-1', `--format=${format}`], { cwd: vault, encoding: 'utf8' }).trim();
      await until(() => fs.existsSync(file) && last('%s') === 'acme/app#a: issue summary', 15_000, 'summary committed');
      const note = parseNote(fs.readFileSync(file, 'utf8'));
      assert.equal(note.frontmatter.status, 'approved');
      assert.equal(note.frontmatter.role, 'symphony');
      assert.deepEqual(note.frontmatter.sources, ['https://github.com/acme/app/pull/9']);
      assert.equal(last('%an'), 'symphony');
      await s.orchestrator.shutdown(1_000);
    });

    it('writes nothing without brain.enabled', async () => {
      const vault = path.join(tempDir(), 'vault');
      await ensureVault(vault, ['acme/app']);
      const s = brainSetup({ enabled: false, path: vault });
      await s.orchestrator.tickNow();
      await until(() => s.orchestrator.listChanges({ type: 'code' }).some((e) => e.status === 'merged'), 15_000, 'merge recorded');
      await s.orchestrator.shutdown(1_000);
      assert.deepEqual(fs.readdirSync(path.join(vault, 'Issues')), []);
    });

    it('a failing vault only warns: the merge is recorded and the issue is done', async () => {
      const vault = path.join(tempDir(), 'not-a-vault');
      fs.mkdirSync(vault, { recursive: true });
      const s = brainSetup({ enabled: true, path: vault });
      await s.orchestrator.tickNow();
      await until(() => s.orchestrator.listChanges({ type: 'code' }).some((e) => e.status === 'merged'), 15_000, 'merge recorded');
      assert.equal(s.tracker.issues.get('a')?.state, 'Done');
      assert.equal(fs.existsSync(path.join(vault, 'Issues')), false);
      await s.orchestrator.shutdown(1_000);
    });
  });

  it('records a merged entry when a merge retry succeeds, without files when the issue has no workspace, and nothing when it fails', async () => {
    const issues = ['a', 'b', 'c'].map((id) => makeIssue({ id, identifier: `acme/app#${id}`, state: 'Human Review', labels: ['awaiting-checks'], native_ref: { base_branch: 'main' } }));
    const s = setup({ issues });
    s.tracker.issueRepository = () => 'acme/app';
    const from = origin();
    const workspace = path.join(s.root, workspaceKey('acme/app#a'));
    cloneInto(workspace, from);
    commitFile(workspace, 'docs/guide.md', 'Add the guide');
    let finished = 0;
    s.tracker.mergeWatch = () => ({
      column: 'Human Review',
      awaiting: (issue) => issue.labels.includes('awaiting-checks'),
      retry: async (issue) => {
        const merged = issue.id !== 'c';
        s.tracker.set(issue.id, { state: merged ? 'Done' : 'Human Review', labels: [] });
        finished++;
        return { merged, pull_request: issue.id === 'a' ? 7 : 8, status: merged ? 'Done' : 'Human Review', reason: merged ? 'merged' : 'conflict' };
      },
    });
    await s.orchestrator.tickNow();
    await until(() => finished === 3 && s.orchestrator.listChanges().length === 2, 15_000, 'retries recorded');
    await s.orchestrator.shutdown(1_000);
    const byIssue = Object.fromEntries(s.orchestrator.listChanges().map((e) => [e.issue, e]));
    assert.deepEqual(Object.keys(byIssue).sort(), ['acme/app#a', 'acme/app#b']);
    assert.equal(byIssue['acme/app#a']?.status, 'merged');
    assert.equal(byIssue['acme/app#a']?.role, 'symphony');
    assert.deepEqual(byIssue['acme/app#a']?.pr, { number: 7, status: 'success' });
    assert.deepEqual(byIssue['acme/app#a']?.files, [{ path: 'docs/guide.md', added: 2, deleted: 0, status: 'added' }]);
    assert.deepEqual(byIssue['acme/app#b']?.files, []);
  });
});

// Independent acceptance tests for the change log (#339): the issue text is the specification.
describe('change log acceptance (#339)', () => {
  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd, encoding: 'utf8' }).trim();
  const clone = (from: string) => `git clone -q "${from}" . && git checkout -q -b symphony/issue-a`;

  function origin(): string {
    const dir = tempDir('symphony-origin-');
    run(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'README.md'), 'readme\n');
    fs.writeFileSync(path.join(dir, 'old.txt'), 'keep me\n'.repeat(12));
    run(dir, 'add', '-A');
    run(dir, 'commit', '-q', '-m', 'init');
    return dir;
  }

  function commitFile(cwd: string, file: string, content: string, message: string): void {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), content);
    run(cwd, 'add', '-A');
    run(cwd, 'commit', '-q', '-m', message);
  }

  const lines = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i}\n`).join('');

  function prepared(front: Record<string, unknown> = {}, issue = makeIssue({ id: 'a', native_ref: { base_branch: 'main' } }), logDir?: string) {
    const from = origin();
    const runner = new FakeRunner();
    const s = setup({ runner, issues: [issue], ...(logDir !== undefined ? { logDir } : {}), front: { ...front, hooks: { after_create: clone(from) } } });
    s.tracker.issueRepository = () => 'acme/app';
    return { s, runner, from };
  }

  it('gives every code entry exactly the fields of the ChangeEntry type, with a diff of at most 5 lines per file', async () => {
    const { s, runner } = prepared();
    runner.script = (turn, params) => {
      // Distinct commit seconds: commits of the same second have no defined order among each other.
      commitFile(params.cwd, 'big.txt', lines(30), 'Add big file\n\nlong body');
      fs.writeFileSync(path.join(params.cwd, 'old.txt'), lines(12, 'new'));
      run(params.cwd, 'add', '-A');
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'Rewrite old'], {
        cwd: params.cwd,
        env: { ...process.env, GIT_COMMITTER_DATE: new Date(Date.now() + 60_000).toISOString() },
      });
      s.tracker.set('a', { state: 'In review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    };
    s.tracker.branchPullRequest = async () => ({ number: 12, url: null, base: 'main', head_sha: null, checks: { state: 'pending' as const, failing: [], pending: ['ci'] } });
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 10_000, 'run finished');
    const entries = s.orchestrator.listChanges({ type: 'code', repo: 'acme/app', limit: 10 });
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((e) => e.title), ['Rewrite old', 'Add big file'], 'newest first, the title is the subject only');
    for (const entry of entries) {
      assert.deepEqual(Object.keys(entry).sort(), ['at', 'diff', 'files', 'id', 'issue', 'pr', 'repo', 'role', 'status', 'title', 'type']);
      assert.equal(Number.isNaN(Date.parse(entry.at)), false);
      assert.equal(entry.repo, 'acme/app');
      assert.deepEqual(entry.pr, { number: 12, status: 'pending' });
      for (const file of entry.files) assert.deepEqual(Object.keys(file).sort(), ['added', 'deleted', 'path', 'status']);
      if (entry.diff !== null) {
        for (const block of entry.diff.split('\n\n')) {
          const [name, ...changed] = block.split('\n');
          assert.ok(entry.files.some((f) => f.path === name), `block starts with a file path: ${name}`);
          assert.ok(changed.length <= 5, `at most 5 lines for ${name}, got ${changed.length}`);
        }
      }
    }
    const big = entries.find((e) => e.title === 'Add big file')!;
    assert.deepEqual(big.files, [{ path: 'big.txt', added: 30, deleted: 0, status: 'added' }]);
    const rewrite = entries.find((e) => e.title === 'Rewrite old')!;
    assert.deepEqual(rewrite.files, [{ path: 'old.txt', added: 12, deleted: 12, status: 'modified' }]);
  });

  it('records a binary file with null counts and a rename as one file', async () => {
    const { s, runner } = prepared();
    runner.script = (turn, params) => {
      fs.writeFileSync(path.join(params.cwd, 'logo.png'), Buffer.from([0, 1, 2, 0, 255, 0]));
      run(params.cwd, 'add', '-A');
      run(params.cwd, 'commit', '-q', '-m', 'Add logo');
      run(params.cwd, 'mv', 'old.txt', 'renamed.txt');
      run(params.cwd, 'commit', '-q', '-m', 'Rename old');
      s.tracker.set('a', { state: 'In review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    };
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 10_000, 'run finished');
    const byTitle = Object.fromEntries(s.orchestrator.listChanges().map((e) => [e.title, e]));
    assert.deepEqual(byTitle['Add logo']?.files, [{ path: 'logo.png', added: null, deleted: null, status: 'binary' }]);
    assert.equal(byTitle['Rename old']?.files.length, 1);
    assert.equal(byTitle['Rename old']?.files[0]?.path, 'renamed.txt');
    assert.equal(byTitle['Rename old']?.files[0]?.status, 'renamed');
    assert.equal(byTitle['Add logo']?.pr, null, 'no pull request known: null');
  });

  it('uses the role of the session as the role of the entry', async () => {
    const { s, runner } = prepared(
      {
        tracker: { kind: 'github_project', provider: { owner: 'acme', project_number: 1, token: 'test-token' }, active_states: ['Ready'] },
        roles: { developer: { states: ['Ready'] } },
      },
      makeIssue({ id: 'a', state: 'Ready', native_ref: { base_branch: 'main' } }),
    );
    runner.script = (turn, params) => {
      commitFile(params.cwd, 'x.txt', 'x\n', 'Do x');
      s.tracker.set('a', { state: 'In review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    };
    await s.orchestrator.tickNow();
    await until(() => s.orchestrator.listChanges().length === 1, 15_000, 'entry recorded');
    assert.equal(s.orchestrator.listChanges()[0]?.role, 'developer');
  });

  it('records no duplicates when a later session adds one more commit', async () => {
    const { s, runner } = prepared();
    let session = 0;
    runner.script = (turn, params) => {
      session++;
      fs.writeFileSync(path.join(params.cwd, `f${session}.txt`), `${session}\n`);
      run(params.cwd, 'add', '-A');
      // Distinct commit seconds: commits of the same second have no defined order among each other.
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', `Commit of session ${session}`], {
        cwd: params.cwd,
        env: { ...process.env, GIT_COMMITTER_DATE: new Date(Date.now() + session * 60_000).toISOString() },
      });
      s.tracker.set('a', { state: 'In review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    };
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 15_000, 'first run finished');
    assert.deepEqual(s.orchestrator.listChanges().map((e) => e.title), ['Commit of session 1']);
    s.tracker.set('a', { state: 'Todo' });
    s.timers.fire(CONTINUATION_DELAY_MS);
    await until(() => snapshot(s).retrying.length === 0, 15_000, 'claim released');
    await s.orchestrator.tickNow();
    await until(() => session === 2, 15_000, 'second session');
    await until(() => s.orchestrator.listChanges().length === 2, 15_000, 'second entry recorded');
    const titles = s.orchestrator.listChanges().map((e) => e.title);
    assert.deepEqual(titles, ['Commit of session 2', 'Commit of session 1']);
    assert.equal(new Set(s.orchestrator.listChanges().map((e) => e.id)).size, 2);
  });

  it('does not fail the run when the pull request lookup or the change log write fails', async () => {
    const logDir = tempDir();
    fs.writeFileSync(path.join(logDir, 'changes'), 'a file where the directory should be');
    const { s, runner } = prepared({}, undefined, logDir);
    runner.script = (turn, params) => {
      commitFile(params.cwd, 'x.txt', 'x\n', 'Do x');
      s.tracker.set('a', { state: 'In review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    };
    s.tracker.branchPullRequest = async () => {
      throw new Error('tracker down');
    };
    await s.orchestrator.tickNow();
    await until(() => snapshot(s).retrying.length === 1, 10_000, 'run finished');
    assert.equal(s.tracker.issues.get('a')?.state, 'In review');
    assert.deepEqual(s.orchestrator.listChanges().map((e) => [e.title, e.pr]), [['Do x', null]]);
  });

  it('records no merged entry when the merge did not happen', async () => {
    const { s, runner } = prepared();
    runner.script = async (turn, params) => {
      commitFile(params.cwd, 'x.txt', 'x\n', 'Do x');
      await callTool(params, 'set_status', { status: 'Human Review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    };
    s.tracker.autoMerge = (_issue, column) =>
      column === 'Human Review' ? { merged: false, pull_request: 9, status: 'Human Review', reason: 'checks pending' } : undefined;
    await s.orchestrator.tickNow();
    await until(() => s.orchestrator.listChanges().length === 1, 15_000, 'commit recorded');
    await s.orchestrator.shutdown(1_000);
    assert.deepEqual(s.orchestrator.listChanges().map((e) => e.status), ['committed']);
  });

  it('records the merged entry with diffStat files and the pull request number, one per merge', async () => {
    const { s, runner } = prepared();
    runner.script = async (turn, params) => {
      commitFile(params.cwd, 'a.txt', 'a\nb\n', 'Add a');
      commitFile(params.cwd, 'b.txt', 'b\n', 'Add b');
      await callTool(params, 'set_status', { status: 'Human Review' });
      return { ok: true, turnId: String(turn), resultText: 'done' };
    };
    s.tracker.autoMerge = (_issue, column) =>
      column === 'Human Review' ? { merged: true, pull_request: 21, status: 'Done', reason: 'merged', checks: { state: 'success', failing: [], pending: [] } } : undefined;
    await s.orchestrator.tickNow();
    await until(() => s.orchestrator.listChanges({ type: 'code' }).length === 3, 15_000, 'merge recorded');
    await s.orchestrator.shutdown(1_000);
    const merged = s.orchestrator.listChanges().filter((e) => e.status === 'merged');
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.type, 'code');
    assert.equal(merged[0]?.pr?.number, 21);
    assert.equal(merged[0]?.issue, 'acme/app#a');
    assert.deepEqual(merged[0]?.files, [
      { path: 'a.txt', added: 2, deleted: 0, status: 'added' },
      { path: 'b.txt', added: 1, deleted: 0, status: 'added' },
    ]);
    if (merged[0]?.diff !== null && merged[0]?.diff !== undefined) {
      for (const block of merged[0].diff.split('\n\n')) assert.ok(block.split('\n').length - 1 <= 5);
    }
  });
});

// Independent acceptance tests for the issue summary after the merge (#360): the issue text is the specification.
describe('issue summary acceptance (#360)', () => {
  const mergeOk = { merged: true, pull_request: 9, status: 'Done', reason: 'merged', checks: { state: 'success' as const, failing: [], pending: [] } };

  async function newVault(): Promise<string> {
    const vault = path.join(tempDir(), 'vault');
    await ensureVault(vault, ['acme/app']);
    return vault;
  }

  /** A stored stage result of the tracker's own account, as the GitHub adapter reads it back. */
  function persistResult(s: Setup, issueId: string, result: Record<string, unknown>, role: string, round: number | null, at: string): void {
    const meta: ResultMeta = { role, run: `run-${role}-${at}`, round, profile: null, workflow_hash: null, head_sha: null, checks: null, target: null, created_at: at };
    const body = renderResultComment({ schema: 'symphony.result/v1', blockers: [], follow_ups: [], ...result } as never, meta);
    assert.notEqual(decodeMarker(body), null, 'the fixture result is a valid stored result');
    const list = s.tracker.comments.get(issueId) ?? [];
    list.push({
      author: s.tracker.viewer,
      createdAt: new Date(at),
      body,
      url: `https://github.com/acme/app/issues/${issueId}#c${list.length}`,
    });
    s.tracker.comments.set(issueId, list);
  }

  const lastCommit = (vault: string, format: string): string => execFileSync('git', ['log', '-1', `--format=${format}`], { cwd: vault, encoding: 'utf8' }).trim();

  function retrySetup(front: Record<string, unknown>, logger?: Logger) {
    const issues = [makeIssue({ id: 'r', identifier: 'acme/app#r', title: 'Retry me', description: 'Goal of r.', state: 'Human Review', labels: ['awaiting-checks'], native_ref: { base_branch: 'main' } })];
    const s = setup({ issues, front, ...(logger !== undefined ? { logger } : {}) });
    s.tracker.issueRepository = () => 'acme/app';
    let finished = false;
    s.tracker.mergeWatch = () => ({
      column: 'Human Review',
      awaiting: (issue) => issue.labels.includes('awaiting-checks'),
      retry: async (issue) => {
        s.tracker.set(issue.id, { state: 'Done', labels: [] });
        finished = true;
        return { ...mergeOk, pull_request_url: 'https://github.com/acme/app/pull/9' };
      },
    });
    return { s, done: () => finished };
  }

  it('the merge retry path writes the summary too, with stage results from the tracker, as symphony', async () => {
    const vault = await newVault();
    const { s, done } = retrySetup({ brain: { enabled: true, path: vault } });
    persistResult(s, 'r', { kind: 'implementation', verdict: 'done', summary: 'Built the retry thing', changed_files: ['src/retry.ts'], tests_added: [], plan_deviations: [] }, 'developer', 1, '2026-10-30T10:00:00Z');
    persistResult(s, 'r', { kind: 'review', verdict: 'approved', summary: 'Reviewed fine', findings: [], checked: [], confirmed_goals: [] }, 'reviewer', 1, '2026-10-30T11:00:00Z');
    await s.orchestrator.tickNow();
    await until(() => done(), 15_000, 'retry finished');
    const file = path.join(vault, 'Issues', 'acme-app', 'r.md');
    await until(() => fs.existsSync(file) && lastCommit(vault, '%s') === 'acme/app#r: issue summary', 15_000, 'summary committed');
    await s.orchestrator.shutdown(1_000);
    const note = parseNote(fs.readFileSync(file, 'utf8'));
    assert.equal(note.frontmatter.type, 'issue');
    assert.equal(note.frontmatter.status, 'approved');
    assert.equal(note.frontmatter.role, 'symphony');
    assert.equal(note.frontmatter.repo, 'acme/app');
    assert.equal(note.frontmatter.issue, 'acme/app#r');
    assert.deepEqual(note.frontmatter.sources, ['https://github.com/acme/app/pull/9']);
    assert.match(note.body, /Retry me/);
    assert.match(note.body, /Goal of r\./);
    assert.match(note.body, /\| developer \| done \| 1 \| Built the retry thing \|/);
    assert.match(note.body, /\| reviewer \| approved \| 1 \| Reviewed fine \|/);
    assert.match(note.body, /`src\/retry\.ts`/);
    assert.match(note.body, /\[\[Repos\/acme-app\/index\]\]/);
    assert.match(note.body, /https:\/\/github\.com\/acme\/app\/pull\/9/);
    assert.equal(lastCommit(vault, '%an'), 'symphony');
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: vault, encoding: 'utf8' }), '');
  });

  it('the merge retry path writes nothing without brain.enabled', async () => {
    const vault = await newVault();
    const { s, done } = retrySetup({ brain: { enabled: false, path: vault } });
    await s.orchestrator.tickNow();
    await until(() => done() && s.orchestrator.listChanges().some((e) => e.status === 'merged'), 15_000, 'retry recorded');
    await s.orchestrator.shutdown(1_000);
    assert.deepEqual(fs.readdirSync(path.join(vault, 'Issues')), []);
  });

  it('writes nothing when the merge did not happen', async () => {
    const vault = await newVault();
    const { s } = retrySetup({ brain: { enabled: true, path: vault } });
    s.tracker.mergeWatch = () => ({
      column: 'Human Review',
      awaiting: (issue) => issue.labels.includes('awaiting-checks'),
      retry: async (issue) => {
        s.tracker.set(issue.id, { state: 'Human Review', labels: [] });
        return { merged: false, pull_request: 9, status: 'Human Review', reason: 'conflict' };
      },
    });
    await s.orchestrator.tickNow();
    await until(() => s.tracker.issues.get('r')?.labels.length === 0, 15_000, 'retry ran');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await s.orchestrator.shutdown(1_000);
    assert.deepEqual(fs.readdirSync(path.join(vault, 'Issues')), []);
    assert.equal(s.orchestrator.listChanges().length, 0);
  });

  function memoryLogger(): { logger: Logger; lines: string[] } {
    const lines: string[] = [];
    return { lines, logger: Logger.create({ sinks: [{ name: 'memory', write: (line: string) => void lines.push(line) }], level: 'debug' }) };
  }

  it('an unreadable result history only logs a warning: the merge is recorded and no file is written', async () => {
    const vault = await newVault();
    const { logger, lines } = memoryLogger();
    const { s, done } = retrySetup({ brain: { enabled: true, path: vault } }, logger);
    s.tracker.failReadResults = new Error('tracker down');
    await s.orchestrator.tickNow();
    await until(() => done() && s.orchestrator.listChanges().some((e) => e.status === 'merged'), 15_000, 'merge recorded');
    await until(() => lines.some((line) => line.includes('level=warn') && /summary/i.test(line)), 5_000, 'warning logged');
    await s.orchestrator.shutdown(1_000);
    assert.equal(s.tracker.issues.get('r')?.state, 'Done');
    assert.deepEqual(fs.readdirSync(path.join(vault, 'Issues')), []);
  });

  it('a broken vault logs a warning (not an error) and the merge flow completes', async () => {
    const vault = path.join(tempDir(), 'plain-dir');
    fs.mkdirSync(vault, { recursive: true });
    const { logger, lines } = memoryLogger();
    const { s, done } = retrySetup({ brain: { enabled: true, path: vault } }, logger);
    await s.orchestrator.tickNow();
    await until(() => done() && s.orchestrator.listChanges().some((e) => e.status === 'merged'), 15_000, 'merge recorded');
    await until(() => lines.some((line) => line.includes('level=warn') && /summary/i.test(line)), 5_000, 'warning logged');
    await s.orchestrator.shutdown(1_000);
    assert.equal(s.tracker.issues.get('r')?.state, 'Done');
    assert.equal(lines.some((line) => line.includes('level=error') && /summary/i.test(line)), false);
  });
});
