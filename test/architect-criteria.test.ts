import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TurnResult } from '../src/agent/types.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { skipCheckProblems, skipReason, stageSkip } from '../src/orchestrator/skip.ts';
import { resolveTransition } from '../src/orchestrator/transitions.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { classify } from '../src/workflow/classify.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { profileFor } from '../src/workflow/profile.ts';
import { decodeMarker, parseResult, renderResultMarkdown } from '../src/workflow/results.ts';
import { compilePrompt, issueTemplateValue, renderPrompt } from '../src/workflow/template.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, makeIssue, makeWorkflow, tempDir, until } from './helpers.ts';

// Independent acceptance tests for #204 (Design column, architect role, skip_when), derived from the issue's criteria.

const shipped = path.join(import.meta.dirname, '..', 'WORKFLOW.md');
const root = path.join(import.meta.dirname, '..');
const ENV = { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' };
const BOARD = ['Backlog', 'Ready', 'Design', 'In progress', 'Testing', 'Agent review', 'Blocked', 'In review', 'Done'];

async function shippedFront(): Promise<{ definition: Awaited<ReturnType<typeof loadWorkflowFile>>['definition']; raw: Record<string, any> }> {
  const { definition } = await loadWorkflowFile(shipped);
  return { definition, raw: structuredClone(definition.config) as Record<string, any> };
}

async function shippedConfig(mutate: (raw: Record<string, any>) => void = () => {}) {
  const { raw } = await shippedFront();
  mutate(raw);
  return resolveConfig(raw, { workflowPath: shipped, env: ENV, trackerDefaults });
}

describe('#204 shipped WORKFLOW.md: Design column and architect role', () => {
  it('loads without errors and wires the architect between the analyst and the developer', async () => {
    const config = await shippedConfig();
    const architect = config.roles?.find((role) => role.name === 'architect');
    assert.ok(architect, 'architect role');
    assert.deepEqual(architect.states.map((state) => state.toLowerCase()), ['design']);
    assert.equal(architect.readOnly, true);
    assert.equal(architect.result, 'design');
    assert.deepEqual(architect.onResult, { ready: 'In progress', split: 'Agent review', blocked: 'Blocked' });
    assert.equal(architect.modelLabel, 'ignore');
    const order = config.tracker.activeStates.map((state) => state.toLowerCase());
    assert.ok(order.includes('design'));
    assert.ok(order.indexOf('design') > order.indexOf('ready') && order.indexOf('design') < order.indexOf('in progress'));
  });

  it('declares the skip_when conditions for the shipped profiles: feature/refactor S, bugfix S and M', async () => {
    const config = await shippedConfig();
    assert.deepEqual(config.pipeline.profiles.get('feature')?.skipWhen, { architect: ['S'] });
    assert.deepEqual(config.pipeline.profiles.get('refactor')?.skipWhen, { architect: ['S'] });
    assert.deepEqual(config.pipeline.profiles.get('bugfix')?.skipWhen, { architect: ['S', 'M'] });
  });
});

describe('#204 skip_when validation', () => {
  const withProfile = (profile: unknown) => () =>
    shippedConfig((raw) => {
      raw.pipeline = { ...(raw.pipeline ?? {}), profiles: { feature: profile } };
    });
  const failure = async (profile: unknown): Promise<string> => {
    try {
      await withProfile(profile)();
    } catch (error) {
      assert.equal((error as { code?: string }).code, 'invalid_config');
      return (error as Error).message;
    }
    return assert.fail('expected invalid_config');
  };

  it('accepts every complexity of the vocabulary', async () => {
    const config = await withProfile({ skip_when: { architect: { complexity: ['S', 'M', 'L', 'XL'] } } })();
    assert.deepEqual(config.pipeline.profiles.get('feature')?.skipWhen, { architect: ['S', 'M', 'L', 'XL'] });
  });

  it('rejects an unknown role and names the field', async () => {
    assert.match(await failure({ skip_when: { designer: { complexity: ['S'] } } }), /pipeline\.profiles\.feature\.skip_when\.designer/);
  });

  it('rejects an unknown condition key and names the field', async () => {
    assert.match(await failure({ skip_when: { architect: { size: ['S'] } } }), /pipeline\.profiles\.feature\.skip_when\.architect\.size/);
  });

  it('rejects an unknown complexity value and names the field', async () => {
    assert.match(await failure({ skip_when: { architect: { complexity: ['S', 'XXL'] } } }), /pipeline\.profiles\.feature\.skip_when\.architect\.complexity.*XXL/);
  });

  it('rejects a skip_when that is not a map', async () => {
    assert.match(await failure({ skip_when: 'S' }), /pipeline\.profiles\.feature\.skip_when/);
  });
});

describe('#204 resolver and dispatch skip agree on the condition', () => {
  const expectDesign = (type: string | null, complexity: string | null): boolean => {
    if (complexity === null || !['S', 'M', 'L', 'XL'].includes(complexity)) return true;
    return type === 'bugfix' ? ['L', 'XL'].includes(complexity) : complexity !== 'S';
  };

  it('next from Ready, skipReason and stageSkip give the same answer for type x complexity (shipped config)', async () => {
    const config = await shippedConfig();
    const roles = config.roles ?? [];
    const analyst = roles.find((role) => role.name === 'issue-analyst')!;
    const architect = roles.find((role) => role.name === 'architect')!;
    for (const type of ['bugfix', 'feature', 'refactor', null]) {
      for (const complexity of ['S', 'M', 'L', 'XL', null]) {
        const labels = [...(type === null ? [] : [`Type: ${type}`]), ...(complexity === null ? [] : [`Complexity: ${complexity}`])];
        const expected = expectDesign(type, complexity);
        const label = `${type ?? 'untyped'} ${complexity ?? 'none'}`;
        const outcome = resolveTransition({
          role: analyst,
          verdict: 'ready',
          history: { reviewRounds: 0, testRounds: 0 },
          profile: profileFor(config.pipeline, classify(labels).type),
          config,
          boardColumns: BOARD,
          issue: { description: null, labels },
        });
        assert.ok(outcome.ok, label);
        assert.equal(outcome.target, expected ? 'Design' : 'In progress', `next: ${label}`);
        assert.equal(skipReason({ labels }, architect, config) === null, expected, `skipReason: ${label}`);
        const skip = stageSkip({ state: 'Design', description: null, labels } as never, architect, config, BOARD);
        assert.equal(skip === null, expected, `stageSkip: ${label}`);
        if (skip !== null) assert.equal(skip.target, 'In progress', label);
      }
    }
  });

  it('skipCheckProblems is empty for the shipped config and reports an on_enter script on the column after Design', async () => {
    const config = await shippedConfig();
    assert.deepEqual(skipCheckProblems(config, BOARD), []);
    const checked = await shippedConfig((raw) => {
      raw.checks = { ...(raw.checks ?? {}), on_enter: { ...(raw.checks?.on_enter ?? {}), 'In progress': 'true' } };
    });
    const problems = skipCheckProblems(checked, BOARD);
    assert.ok(problems.length > 0);
    assert.ok(problems.some((problem) => /skip_when/.test(problem) && /architect/.test(problem) && /In progress/.test(problem)), problems.join('\n'));
  });
});

describe('#204 design result', () => {
  const ready = { verdict: 'ready', summary: 'Extend the exporter.', decision: 'Extend it', components: ['A: does x'], interfaces: ['f(): void'] };
  const message = (input: Record<string, unknown>): string => {
    const outcome = parseResult('design', input);
    return outcome.ok ? '' : outcome.message;
  };

  it('requires components and interfaces for ready, each reported readably', () => {
    assert.equal(parseResult('design', ready).ok, true);
    assert.match(message({ ...ready, components: [] }), /components/);
    assert.match(message({ ...ready, interfaces: [] }), /interfaces/);
    assert.match(message({ verdict: 'ready', summary: 'x' }), /components[\s\S]*interfaces|interfaces[\s\S]*components/);
  });

  it('keeps blocked working with a blocker and without components', () => {
    assert.equal(parseResult('design', { verdict: 'blocked', summary: 'x', blockers: [{ description: 'Which storage?', needs: 'human' }] }).ok, true);
    assert.equal(parseResult('design', { verdict: 'blocked', summary: 'x' }).ok, false);
  });

  it('renders the decision and the components in the comment', () => {
    const outcome = parseResult('design', { ...ready, components: ['Exporter: writes CSV', 'Command: wires the CLI'] });
    assert.ok(outcome.ok);
    const text = renderResultMarkdown(outcome.result, { role: 'architect', run: null, round: null, profile: null, workflow_hash: null, head_sha: null, checks: null, target: 'In progress', created_at: '2026-01-01T00:00:00.000Z' });
    assert.match(text, /Extend it/);
    assert.match(text, /Exporter: writes CSV/);
    assert.match(text, /Command: wires the CLI/);
    assert.match(text, /f\(\): void/);
  });
});

describe('#204 prompts of the shipped WORKFLOW.md', () => {
  const design = {
    verdict: 'ready',
    summary: 'sum',
    decision: 'DECISION-TEXT',
    components: ['COMPONENT-ONE'],
    interfaces: ['INTERFACE-ONE'],
    migrations: ['MIGRATION-ONE'],
    compatibility: 'COMPAT-TEXT',
    options: ['OPTION-ONE'],
    work_packages: [],
    head_sha: null,
  };
  const render = async (role: string, results: Record<string, unknown> | undefined): Promise<string> => {
    const { definition } = await shippedFront();
    const issue = makeIssue({ id: '7', state: 'In progress', labels: ['Type: feature', 'Complexity: M'], description: 'Add an export', native_ref: { provider: 'github_project', repository: 'acme/app', number: 7, parent: null, sub_issues: [], base_branch: null, status_updated_at: '2026-01-01T00:00:00.000Z' } });
    const subject = { ...issue, native_ref: { ...issue.native_ref, base_branch: null } };
    const template = compilePrompt(definition.promptTemplate);
    assert.equal(template.parseError, null);
    const empty = { latest: [], open_findings: [], failed_cases: [], test: null, analysis: null, design: null };
    return renderPrompt(template, {
      issue: issueTemplateValue(subject, new Map()),
      attempt: null,
      role,
      agents: [],
      result_required: true,
      round: 1,
      results: results ?? empty,
    });
  };

  it('the developer sees the newest design when present and no design block when absent', async () => {
    const empty = { latest: [], open_findings: [], failed_cases: [], test: null, analysis: null, design: null };
    const withDesign = await render('developer', { ...empty, design });
    for (const part of ['DECISION-TEXT', 'COMPONENT-ONE', 'INTERFACE-ONE', 'MIGRATION-ONE', 'COMPAT-TEXT', 'OPTION-ONE']) assert.ok(withDesign.includes(part), part);
    const without = await render('developer', undefined);
    assert.doesNotMatch(without, /DECISION-TEXT|COMPONENT-ONE/);
    assert.doesNotMatch(without, /Design of the architect/);
  });

  it('the architect, reviewer and test engineer prompts still render without a design', async () => {
    for (const role of ['architect', 'reviewer', 'test-engineer', 'issue-analyst']) {
      const prompt = await render(role, undefined);
      assert.ok(prompt.length > 200, role);
    }
    const architect = await render('architect', undefined);
    assert.match(architect, /read-only/i);
    assert.match(architect, /laravel-architect|architect/);
    assert.match(architect, /report_result/);
  });
});

describe('#204 docs', () => {
  const read = async (file: string): Promise<string> => (await import('node:fs/promises')).readFile(path.join(root, file), 'utf8');

  it('document the Design column and the skip_when vocabulary', async () => {
    const configuration = await read('docs/configuration.md');
    assert.match(configuration, /skip_when/);
    for (const value of ['S', 'M', 'L', 'XL']) assert.ok(configuration.includes(value));
    assert.match(configuration, /Design/);
    assert.match(configuration, /architect/);
    for (const file of ['docs/results.md', 'docs/laravel-subagents.md', 'README.md', 'README.de.md']) {
      assert.match(await read(file), /Design|architect/i, file);
    }
  });
});

describe('#204 orchestrator: dispatch skips of Design for refactor S and bugfix M issues', () => {
  type Run = { orchestrator: Orchestrator; tracker: FakeTracker; runner: FakeRunner };

  async function start(labels: string[]): Promise<Run> {
    const { definition } = await loadWorkflowFile(shipped);
    const config: Record<string, unknown> = {
      ...definition.config,
      workspace: { root: tempDir() },
      hooks: {},
      checks: {},
      tracker: { ...(definition.config.tracker as Record<string, unknown>), kind: 'github_project', provider: { owner: 'acme', project_number: 1, token: 'test-token' } },
    };
    const tracker = new FakeTracker([
      makeIssue({ id: '7', state: 'Design', labels, description: 'x', native_ref: { provider: 'github_project', repository: 'acme/app', number: 7, parent: null, sub_issues: [], base_branch: null, status_updated_at: '2026-01-01T00:00:00.000Z' } }),
    ]);
    tracker.statusOptions = async () => BOARD;
    const runner = new FakeRunner(async (turn): Promise<TurnResult> => ({ ok: true, turnId: String(turn), resultText: 'done' }));
    const workflow = new StaticWorkflow(makeWorkflow(config, { prompt: definition.promptTemplate, env: ENV, dir: path.dirname(shipped) }));
    const orchestrator = new Orchestrator({ workflow, runner, logger: Logger.silent(), env: {}, logDir: null, clock: new ManualClock(), timers: new ManualTimers(), createAdapter: () => tracker });
    return { orchestrator, tracker, runner };
  }

  for (const [labels, profile] of [
    [['Type: refactor', 'Complexity: S'], 'refactor'],
    [['Type: bugfix', 'Complexity: M'], 'bugfix'],
    [['Type: feature', 'Complexity: S'], 'feature'],
  ] as const) {
    it(`skips Design for ${labels.join(' / ')} without a session and logs stage_skipped`, async () => {
      const run = await start([...labels]);
      await run.orchestrator.tickNow();
      await until(() => run.tracker.issues.get('7')?.state === 'In progress', 3_000, 'issue moved on');
      assert.equal(run.runner.sessions.length, 0, 'no architect session');
      const bodies = (run.tracker.comments.get('7') ?? []).map((comment) => decodeMarker(comment.body));
      const skipped = bodies.find((marker) => marker?.result.kind === 'skipped');
      assert.ok(skipped, 'a skipped result was posted');
      assert.equal(skipped.meta.role, 'architect');
      assert.equal(skipped.meta.profile, profile);
      const event = run.orchestrator.issueTimeline('acme/app#7')?.events.find((candidate) => candidate.event === 'stage_skipped');
      assert.equal(event?.detail?.role, 'architect');
      await run.orchestrator.shutdown(1_000);
    });
  }

  it('does not skip Design for a bugfix of complexity XL: an architect session starts', async () => {
    const run = await start(['Type: bugfix', 'Complexity: XL']);
    await run.orchestrator.tickNow();
    await until(() => run.runner.sessions.length === 1, 3_000, 'architect session');
    assert.match(run.runner.sessions[0]?.turns[0] ?? '', /Your role: architect/);
    await run.orchestrator.shutdown(1_000);
  });
});
