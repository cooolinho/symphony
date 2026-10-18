import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, mock } from 'node:test';
import { repositoryFileName } from '../src/history/history.ts';
import { parseWorkflow } from '../src/workflow/loader.ts';
import { ROOT, type Board, type E2eContext } from '../scripts/e2e/context.ts';
import { TIMELINE_FILE, absolute, independentOfWorkflowDir, renderWorkflow, section } from '../scripts/e2e/derive.ts';
import {
  COST_CEILING_USD,
  PIPELINE_COLUMNS,
  PIPELINE_SCENARIO,
  PIPELINE_TIMEOUT_MIN,
  pipelineIssueBody,
  pipelineWorkflow,
  writePipelineWorkflow,
} from '../scripts/e2e/pipeline.ts';
import { ROLES_SCENARIO, rolesIssueBody, rolesWorkflow } from '../scripts/e2e/roles.ts';
import { MODEL_LABEL, SCENARIO, TITLE_PREFIX, createScenario, dependencies, doneMarker } from '../scripts/e2e/scenario.ts';
import { verify } from '../scripts/e2e/verify.ts';
import { costByRole, pipelineRuns, verifyPipeline, type PipelineData, type PipelineResult } from '../scripts/e2e/verify-pipeline.ts';
import { tempDir } from './helpers.ts';

// Independent acceptance tests of #202 (live e2e scenario for the bugfix pipeline), derived from the issue and the analysis:
// the command line, the setup on the board, what the generated workflow keeps and replaces, the verification of runs of
// every scenario, edge cases of the verifier and the documentation. The replay through the real orchestrator is in
// e2e-pipeline-replay.test.ts.

const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const source = read('WORKFLOW.md');

describe('#202 npm run e2e: command line', () => {
  const run = (script: string, args: string[]) => {
    const home = tempDir('e2e-pipeline-cli-');
    // No tokens, no board: nothing here can reach GitHub or create a file in the checkout.
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'e2e', script), ...args], {
      cwd: home,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: home },
      timeout: 60_000,
    });
    return { ...result, home };
  };

  it('lists the pipeline scenario in --help, with its columns, cost and timeout', () => {
    const { status, stdout } = run('run.ts', ['--help']);
    assert.equal(status, 0);
    assert.match(stdout, /Scenario "pipeline"/);
    assert.match(stdout, /--scenario <name>\s+default \| roles \| pipeline/);
    for (const column of ['Testing', 'Agent review', 'Blocked']) assert.ok(stdout.includes(`"${column}"`), `--help names the column ${column}`);
    assert.match(stdout, /P1/);
    assert.match(stdout, /P2/);
    assert.match(stdout, /P3/);
    assert.match(stdout, new RegExp(`--timeout <min>.*pipeline: ${PIPELINE_TIMEOUT_MIN}`));
    assert.ok(PIPELINE_TIMEOUT_MIN > 45, 'the pipeline needs more time than the default scenarios');
  });

  it('still lists the default and roles scenarios in --help', () => {
    const { stdout } = run('run.ts', ['--help']);
    assert.match(stdout, /Scenario "default"/);
    assert.match(stdout, /Scenario "roles"/);
  });

  it('names pipeline among the valid scenarios when the scenario is unknown, and exits 1 without a board', () => {
    const { status, stderr } = run('run.ts', ['--scenario', 'bogus']);
    assert.equal(status, 1);
    assert.match(stderr, /--scenario must be one of default, roles, pipeline \(got bogus\)/);
  });

  it('accepts --scenario pipeline: it gets as far as the configuration, not to a complaint about the scenario', () => {
    const empty = path.join(tempDir('e2e-pipeline-env-'), 'empty.env');
    fs.writeFileSync(empty, '');
    const { status, stderr, home } = run('run.ts', ['--scenario', 'pipeline', '--env-file', empty]);
    assert.equal(status, 1);
    assert.doesNotMatch(stderr, /--scenario must be one of/);
    assert.match(stderr, /^e2e: invalid tracker config/, 'the run stopped at the missing board settings, before it created anything');
    assert.deepEqual(fs.readdirSync(home), [], 'nothing was written into the working directory');
  });

  it('rejects a negative --timeout for the pipeline scenario like for the others', () => {
    const { status, stderr } = run('run.ts', ['--scenario', 'pipeline', '--timeout=-5']);
    assert.equal(status, 1);
    assert.match(stderr, /--timeout must be a non-negative number/);
  });

  it('explains how to use verify.ts without a run directory', () => {
    const { status, stderr } = run('verify.ts', []);
    assert.equal(status, 2);
    assert.match(stderr, /Usage: node scripts\/e2e\/verify\.ts <run-dir>/);
  });
});

describe('#202 setup on the board', () => {
  const OPTIONS = ['backlog', 'ready', 'in progress', 'testing', 'agent review', 'blocked', 'in review', 'done'];

  interface Call {
    query: string;
    variables: Record<string, unknown>;
  }

  /** A GitHub that answers the setup's queries and mutations in memory and remembers them. */
  function fakeGithub() {
    const calls: Call[] = [];
    const items = new Map<string, number>();
    let created = 0;
    const gql = async (query: string, variables: Record<string, unknown> = {}): Promise<unknown> => {
      calls.push({ query, variables });
      if (query.includes('repository(owner: $owner, name: $name) { id nameWithOwner label')) {
        return { repository: { id: 'R_1', nameWithOwner: 'acme/e2e', label: { id: 'L_model_sonnet' } } };
      }
      if (query.includes('createIssue(input')) {
        created += 1;
        return { createIssue: { issue: { id: `I_${created}`, number: 100 + created } } };
      }
      if (query.includes('addProjectV2ItemById')) {
        const number = 100 + Number(String(variables.content).slice(2));
        items.set(`item_${variables.content}`, number);
        return { addProjectV2ItemById: { item: { id: `item_${variables.content}` } } };
      }
      if (query.includes('nodes(ids:')) {
        const ids = variables.ids as string[];
        return { nodes: ids.map((id) => ({ id, status: { name: 'Ready' }, content: { number: items.get(id), state: 'OPEN' } })) };
      }
      return {};
    };
    return { calls, gql };
  }

  async function setup() {
    const github = fakeGithub();
    const board: Board = { projectId: 'PVT_1', statusFieldId: 'F_1', options: new Map(OPTIONS.map((name) => [name, `opt:${name}`])) };
    const context = { repository: 'acme/e2e', settings: { statusField: 'Status' }, github: { gql: github.gql } } as unknown as E2eContext;
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let settled = false;
      const pending = createScenario(context, board, () => {}, { name: 'pipeline', issues: PIPELINE_SCENARIO, body: pipelineIssueBody }).finally(() => {
        settled = true;
      });
      // The setup waits 10 s for board workflows that may overwrite the status: let that time pass.
      while (!settled) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        mock.timers.tick(10_000);
      }
      return { record: await pending, calls: github.calls };
    } finally {
      mock.timers.reset();
    }
  }

  it('creates P1, P2 and P3 with the Model: sonnet label and the text of their roles, without dependencies, and records the scenario', async () => {
    const { record, calls } = await setup();
    const created = calls.filter((call) => call.query.includes('createIssue(input'));
    assert.equal(created.length, 3);
    assert.deepEqual(
      created.map((call) => call.variables.title),
      PIPELINE_SCENARIO.map((issue) => `${TITLE_PREFIX} ${issue.key} – ${issue.title}`),
    );
    assert.deepEqual(
      created.map((call) => call.variables.body),
      PIPELINE_SCENARIO.map((issue) => pipelineIssueBody(issue)),
    );
    assert.ok(created.every((call) => call.variables.label === 'L_model_sonnet'), `${MODEL_LABEL} on every issue`);
    assert.ok(calls.every((call) => !call.query.includes('addBlockedBy')), 'no relationships: the issues are free');

    assert.equal(record.scenario, 'pipeline');
    assert.equal(record.repository, 'acme/e2e');
    assert.deepEqual(
      record.issues.map((issue) => [issue.key, issue.number, issue.relationships, issue.textBlocker]),
      [
        ['P1', 101, [], null],
        ['P2', 102, [], null],
        ['P3', 103, [], null],
      ],
    );
    assert.ok(record.issues.every((issue) => dependencies(issue).length === 0));
  });

  it('sets Ready on every issue only after all of them were created and added to the board', async () => {
    const { calls } = await setup();
    const kinds = calls.map((call) =>
      call.query.includes('createIssue(input') ? 'create' : call.query.includes('addProjectV2ItemById') ? 'add' : call.query.includes('updateProjectV2ItemFieldValue') ? 'status' : null,
    );
    assert.deepEqual(kinds.filter((kind) => kind !== null), ['create', 'create', 'create', 'add', 'add', 'add', 'status', 'status', 'status']);
    const statuses = calls.filter((call) => call.query.includes('updateProjectV2ItemFieldValue'));
    assert.ok(statuses.every((call) => call.variables.option === 'opt:ready'));
  });
});

describe('#202 what the generated workflow shares with the other scenarios (derive.ts)', () => {
  it('makes only relative file paths absolute', () => {
    assert.equal(absolute('./.claude', '/repo'), '/repo/.claude');
    assert.equal(absolute('bin/claude', '/repo'), '/repo/bin/claude');
    for (const kept of ['/abs/path', '~/symphony-workspaces', '$HOME/x', '${VAR:-x}', '']) assert.equal(absolute(kept, '/repo'), kept, kept);
    for (const kept of [42, null, undefined, true]) assert.equal(absolute(kept, '/repo'), kept);
  });

  it('copies a section into the config, creating it when it is missing', () => {
    const config: Record<string, unknown> = { agent: { max_turns: 3 } };
    const agent = section(config, 'agent');
    agent.max_turns = 5;
    assert.deepEqual(config.agent, { max_turns: 5 });
    assert.deepEqual(section(config, 'checks'), {});
    assert.deepEqual(config.checks, {});
    const odd: Record<string, unknown> = { agent: 'text' };
    assert.deepEqual(section(odd, 'agent'), {});
  });

  it('points workspace, hooks, plugins and executable at the checkout and switches Boost off', () => {
    const config: Record<string, unknown> = {
      workspace: { root: './workspaces', cleanup_terminal: true },
      hooks: {
        timeout_ms: 600_000,
        after_create: 'bash "$SYMPHONY_WORKFLOW_DIR/hooks/a.sh"; bash "${SYMPHONY_WORKFLOW_DIR}/hooks/b.sh"',
        before_run: 'git fetch',
      },
      claude: { plugins: ['./.claude', '/abs/plugin', '$PLUGIN'], executable: './bin/claude', model: 'sonnet' },
      laravel: { boost: 'auto', php: 'php' },
    };
    independentOfWorkflowDir(config, '/repo');
    assert.deepEqual(config, {
      workspace: { root: '/repo/workspaces', cleanup_terminal: true },
      hooks: { timeout_ms: 600_000, after_create: 'bash "/repo/hooks/a.sh"; bash "/repo/hooks/b.sh"', before_run: 'git fetch' },
      claude: { plugins: ['/repo/.claude', '/abs/plugin', '$PLUGIN'], executable: '/repo/bin/claude', model: 'sonnet' },
      laravel: { boost: 'off', php: 'php' },
    });
  });

  it('leaves a command found on PATH, a home path and a missing laravel section alone', () => {
    const config: Record<string, unknown> = { workspace: { root: '~/ws' }, claude: { executable: 'claude' } };
    independentOfWorkflowDir(config, '/repo');
    assert.deepEqual(config, { workspace: { root: '~/ws' }, hooks: {}, claude: { executable: 'claude' } });
  });

  it('renders a workflow file that reads back as the same front matter and prompt', () => {
    const config = { tracker: { kind: 'github_project' }, agent: { max_turns: 2 } };
    const text = renderWorkflow(config, 'Work on {{ issue.identifier }}\n', 'scripts/e2e/x.ts', '/repo');
    assert.match(text, /^---\n# Generated by scripts\/e2e\/x\.ts from \/repo\/WORKFLOW\.md; do not edit\./);
    const parsed = parseWorkflow(text);
    assert.deepEqual(parsed.config, config);
    assert.equal(parsed.promptTemplate.trim(), 'Work on {{ issue.identifier }}');
  });

  it('names the timeline file of the run directory', () => {
    assert.equal(TIMELINE_FILE, 'timeline.jsonl');
  });

  it('leaves the roles workflow as it was: same tracker, hooks, agent and claude settings, only the roles scenario overrides', () => {
    const { config } = parseWorkflow(rolesWorkflow(source, '/repo'));
    const shipped = parseWorkflow(source).config as Record<string, any>;
    const generated = config as Record<string, any>;
    assert.deepEqual(generated.tracker.active_states, ['Ready', 'In progress', 'Agent review']);
    assert.deepEqual(generated.tracker.provider, shipped.tracker.provider);
    assert.deepEqual(Object.keys(generated.roles), ['developer', 'reviewer']);
    assert.deepEqual(generated.pipeline, { max_review_rounds: 3 });
    assert.deepEqual(generated.checks.on_enter, { 'Agent review': 'bash "$SYMPHONY_WORKFLOW_DIR/roles-check.sh"' });
    assert.deepEqual(generated.agent.max_concurrent_agents_by_state, { 'Agent review': 1 });
    assert.equal(generated.agent.max_continuations, 6);
    assert.equal(generated.laravel.boost, 'off');
    assert.deepEqual(generated.claude.plugins, ['/repo/.claude']);
    assert.match(generated.hooks.after_create, /bash "\/repo\/hooks\/laravel-env\.sh"/);
    assert.doesNotMatch(generated.hooks.after_create, /SYMPHONY_WORKFLOW_DIR/);
    assert.equal(generated.workspace.root, shipped.workspace.root);
    assert.deepEqual(ROLES_SCENARIO.map((issue) => issue.key), ['R1', 'R2', 'R3']);
    assert.match(rolesIssueBody(ROLES_SCENARIO[1] as (typeof ROLES_SCENARIO)[number]), /changes_needed/);
  });
});

describe('#202 the generated pipeline workflow, key by key', () => {
  type Tree = Record<string, unknown>;

  /** Paths of the leaves (or whole values) that differ between two parsed front matters. */
  function differences(a: unknown, b: unknown, prefix = ''): string[] {
    if (JSON.stringify(a) === JSON.stringify(b)) return [];
    const isMap = (value: unknown): value is Tree => typeof value === 'object' && value !== null && !Array.isArray(value);
    if (isMap(a) && isMap(b)) {
      return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) => differences(a[key], b[key], prefix === '' ? key : `${prefix}.${key}`));
    }
    return [prefix];
  }

  const shipped = parseWorkflow(source);
  const generated = (text = source) => parseWorkflow(pipelineWorkflow(text, '/repo'));

  it('replaces only the models, the entry checks, the paths, the polling interval, the cost cap, Boost and the prompt', () => {
    const changed = differences(shipped.config, generated().config);
    const allowed = [
      /^polling\.interval_ms$/,
      /^hooks\./,
      /^agent\.max_issue_cost_usd$/,
      /^claude\.(model|plugins)$/,
      /^roles\.[a-z-]+\.claude(\.model(_by_complexity)?)?$/,
      /^checks\./,
      /^laravel\.boost$/,
    ];
    const unexpected = changed.filter((key) => !allowed.some((pattern) => pattern.test(key)));
    assert.deepEqual(unexpected, [], 'everything else stays as shipped');
    assert.ok(changed.length > 0);
    assert.notEqual(generated().promptTemplate, shipped.promptTemplate);
  });

  it('keeps tracker, active_states, roles, transitions, profiles, round limits and slots byte for byte', () => {
    const a = shipped.config as Record<string, any>;
    const b = generated().config as Record<string, any>;
    assert.deepEqual(b.tracker, a.tracker);
    assert.deepEqual(b.pipeline, a.pipeline);
    assert.deepEqual(Object.keys(b.pipeline.profiles).sort(), ['bugfix', 'default', 'feature', 'refactor']);
    for (const type of ['bugfix', 'feature', 'refactor']) assert.deepEqual(b.pipeline.profiles[type].on_result, { developer: { done: 'Testing' } }, type);
    assert.equal(b.pipeline.max_review_rounds, 3);
    assert.equal(b.pipeline.max_test_rounds, 2);
    assert.deepEqual(b.tracker.active_states, ['Ready', 'Design', 'In progress', 'Testing', 'Agent review', 'Security review']);
    for (const name of Object.keys(a.roles)) {
      const { claude: _shipped, ...before } = a.roles[name];
      const { claude: _generated, ...after } = b.roles[name];
      assert.deepEqual(after, before, `role ${name} keeps its states, results and transitions`);
    }
    for (const key of ['max_concurrent_agents', 'max_turns', 'max_continuations', 'max_concurrent_agents_by_state', 'reserved_slots_by_role']) {
      assert.deepEqual(b.agent[key], a.agent[key], `agent.${key}`);
    }
  });

  it('pins every role, the shipped reviewer and the command roles included, to sonnet', () => {
    const roles = (generated().config as Record<string, any>).roles as Record<string, any>;
    assert.equal(((shipped.config as Record<string, any>).roles as Record<string, any>).reviewer.claude.model, 'opus', 'the premise: the shipped reviewer asks for opus');
    for (const [name, role] of Object.entries(roles)) {
      assert.equal(role.claude.model, 'sonnet', name);
      assert.equal(role.claude.model_by_complexity, undefined, name);
    }
    assert.equal((generated().config as Record<string, any>).claude.model, 'sonnet');
  });

  it('has no entry checks and no check script that would run the repository tests', () => {
    const { checks } = generated().config as Record<string, any>;
    assert.deepEqual(checks.on_enter, {});
    assert.equal(typeof checks.timeout_ms, 'number');
    assert.doesNotMatch(pipelineWorkflow(source, '/repo'), /checks\/laravel\.sh/);
  });

  it('takes the pipeline from the repository WORKFLOW.md instead of copying it: a changed round limit, target or active column shows up', () => {
    const changed = source
      .replace('max_test_rounds: 2', 'max_test_rounds: 5')
      .replace('max_review_rounds: 3', 'max_review_rounds: 4')
      .replace('done: Testing }', 'done: Agent review }');
    assert.notEqual(changed, source);
    const { pipeline } = generated(changed).config as Record<string, any>;
    assert.equal(pipeline.max_test_rounds, 5);
    assert.equal(pipeline.max_review_rounds, 4);
    assert.deepEqual(pipeline.profiles.bugfix.on_result.developer, { done: 'Agent review' });
    const columns = source.replace('active_states: [Ready, Design, In progress, Testing, Agent review, Security review]', 'active_states: [Ready, Design, In progress, Agent review, Security review]');
    assert.notEqual(columns, source);
    assert.deepEqual(((generated(columns).config as Record<string, any>).tracker as Record<string, unknown>).active_states, ['Ready', 'Design', 'In progress', 'Agent review', 'Security review']);
  });

  it('uses absolute paths for what the run directory cannot resolve, whatever the root', () => {
    const text = pipelineWorkflow(source, '/some/where/symphony');
    assert.doesNotMatch(text, /\$SYMPHONY_WORKFLOW_DIR|\$\{SYMPHONY_WORKFLOW_DIR\}/);
    assert.match(text, /\/some\/where\/symphony\/hooks\/laravel-env\.sh/);
    assert.match(text, /- \/some\/where\/symphony\/\.claude/);
    assert.match(text, /# Generated by scripts\/e2e\/pipeline\.ts from \/some\/where\/symphony\/WORKFLOW\.md; do not edit\./);
  });

  it('writes the workflow into the run directory', () => {
    const runDir = tempDir('e2e-pipeline-dir-');
    const file = writePipelineWorkflow(ROOT, runDir);
    assert.equal(file, path.join(runDir, 'WORKFLOW.md'));
    assert.equal(fs.readFileSync(file, 'utf8'), pipelineWorkflow(source, ROOT));
  });

  it('is a workflow the other scenarios do not mix up with: no roles scenario settings', () => {
    const text = pipelineWorkflow(source, ROOT);
    assert.doesNotMatch(text, /roles-check\.sh/);
    const { config } = parseWorkflow(text);
    assert.ok(Object.keys((config as Record<string, any>).roles).includes('test-engineer'));
  });
});

describe('#202 issue texts: what a Claude session is told to do', () => {
  const body = (key: string) => pipelineIssueBody(PIPELINE_SCENARIO.find((issue) => issue.key === key) as (typeof PIPELINE_SCENARIO)[number]);

  it('never tells an agent to change a status, comment, commit, push, branch or open a pull request', () => {
    for (const issue of PIPELINE_SCENARIO) {
      const text = body(issue.key);
      assert.doesNotMatch(text, /Set the status|set_status|mcp__tracker__(?!get_issue|report_result)/);
      assert.match(text, /Not allowed:.*changing files.*creating a branch.*committing.*pushing.*opening a pull request/);
      assert.ok(!/status "Done"|set the status "Done"/i.test(text));
    }
  });

  it('gives P1 exactly one failing test round: a failed case in round 1 only, passed after', () => {
    const tester = body('P1').split('## Role `test-engineer`')[1]?.split('## Role `reviewer`')[0] ?? '';
    assert.match(tester, /In round 1 call `report_result` with the verdict `failed`.*status `failed`/);
    assert.equal(tester.match(/verdict `failed`/g)?.length, 1);
    assert.match(tester, /In any later round: .*verdict `passed`/);
    assert.equal(body('P1').match(/changes_needed/g), null, 'P1 has no review loop');
  });

  it('gives P2 exactly one rejected review round and no failing test', () => {
    const reviewer = body('P2').split('## Role `reviewer`')[1] ?? '';
    assert.match(reviewer, /In round 1 call `report_result` with the verdict `changes_needed`.*severity `major`/);
    assert.equal(reviewer.match(/verdict `changes_needed`/g)?.length, 1);
    assert.match(reviewer, /In any later round: .*verdict `approved`/);
    assert.equal(body('P2').match(/verdict `failed`/g), null);
    assert.doesNotMatch(body('P2').split('## Role `test-engineer`')[1]?.split('## Role `reviewer`')[0] ?? '', /round/i, 'the test engineer of P2 always passes');
  });

  it('keeps P3 at the analyst: a needs_info with one open question and no section for a later role', () => {
    const text = body('P3');
    assert.match(text, /verdict `needs_info`/);
    assert.equal(text.match(/open question: `/g)?.length, 1, 'exactly one open question');
    assert.deepEqual([...text.matchAll(/## Role `([a-z-]+)`/g)].map((match) => match[1]), ['issue-analyst']);
    assert.doesNotMatch(text, /verdict `ready`/);
  });

  it('has the bug analysis report the bugfix type for P1 and P2, which is what selects the profile', () => {
    for (const key of ['P1', 'P2']) {
      const analyst = body(key).split('## Role `developer`')[0] ?? '';
      assert.match(analyst, /verdict `ready`/);
      assert.match(analyst, /type `bugfix`/);
      assert.match(analyst, /complexity `S`/);
      assert.match(analyst, /acceptance criterion: `/, 'a ready analysis names an acceptance criterion');
    }
    assert.doesNotMatch(body('P3'), /type `bugfix`/);
  });

  it('asks for a marker string in every summary that is unique to the issue', () => {
    const markers = PIPELINE_SCENARIO.flatMap((issue) => issue.results.map((result) => [issue.key, result.marker]));
    for (const [key, marker] of markers) {
      assert.ok(String(marker).includes(String(key)), `${marker} names ${key}`);
      assert.ok(body(String(key)).includes(`\`${marker}\``), `${key} asks for ${marker}`);
    }
    // The markers that tell two results of an issue apart differ.
    for (const issue of PIPELINE_SCENARIO) {
      const byKind = new Map<string, Set<string>>();
      for (const result of issue.results) byKind.set(`${result.kind}:${result.verdict}`, (byKind.get(`${result.kind}:${result.verdict}`) ?? new Set()).add(result.marker));
      assert.ok([...byKind.values()].every((set) => set.size === 1), `${issue.key}: one marker per kind and verdict`);
      const all = [...byKind.values()].map((set) => [...set][0]);
      assert.equal(new Set(all).size, all.length, `${issue.key}: markers differ between verdicts`);
    }
  });

  it('has no dependencies: all three are dispatchable at once', () => {
    assert.ok(PIPELINE_SCENARIO.every((issue) => issue.blockers.length === 0 && issue.textBlocker === undefined));
    assert.deepEqual(
      PIPELINE_SCENARIO.map((issue) => issue.key),
      ['P1', 'P2', 'P3'],
    );
  });

  it('needs the board columns of the whole path, the way to Blocked and the terminal column', () => {
    const needed = new Set(PIPELINE_SCENARIO.flatMap((issue) => issue.path));
    for (const status of needed) assert.ok(PIPELINE_COLUMNS.includes(status), `${status} is preflighted`);
    for (const status of ['Ready', 'Design', 'In progress', 'Testing', 'Agent review', 'Security review', 'In review', 'Blocked', 'Done']) assert.ok(PIPELINE_COLUMNS.includes(status), status);
  });
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* verify.ts on records of the other scenarios, and edge cases of the pipeline verifier                              */
/* ------------------------------------------------------------------------------------------------------------------ */

const REPO = 'acme/e2e';
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 5, 10, 0, seconds)).toISOString();

function line(seconds: number, event: string, fields: Record<string, string | number | boolean>): string {
  const pairs = Object.entries(fields).map(([key, value]) => `${key}=${typeof value === 'string' && /[\s"]/.test(value) ? JSON.stringify(value) : value}`);
  return [`ts=${at(seconds)}`, `event=${event}`, `repo=${REPO}`, ...pairs].join(' ');
}

const started = (seconds: number, number: number, run: string, role = 'default', model = 'sonnet') =>
  line(seconds, 'run_started', { issue: `${REPO}#${number}`, run, title: 'E2E run', state: 'Ready', attempt: 'null', model, role });
const finished = (seconds: number, number: number, run: string, extra: Record<string, string | number> = {}) =>
  line(seconds, 'run_finished', {
    issue: `${REPO}#${number}`,
    run,
    outcome: 'handed_off',
    state: 'x',
    reason: 'handed off',
    turns: 2,
    model: 'claude-sonnet-5-5',
    cost_usd: 0.05,
    started_at: at(seconds - 30),
    ...extra,
  });

interface Stub {
  results?: Record<string, Array<{ kind: string; verdict: string }>>;
  repository?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

/** A context whose tracker lists the given results and whose GitHub answers with `repository`. */
function stubContext(stub: Stub = {}): E2eContext {
  return {
    config: stub.config ?? { agent: { maxConcurrentAgents: 3 }, pipeline: { maxReviewRounds: 3, maxTestRounds: 2, limitLabel: 'needs-human' } },
    adapter: {
      fetchIssuesByIds: async (ids: string[]) => ids.map((id) => ({ id, labels: [] })),
      readResults: async (issue: { id: string }) =>
        (stub.results?.[issue.id] ?? []).map(({ kind, verdict }) => ({ result: { kind, verdict, summary: '', open_questions: [] }, meta: { role: 'x', run: null, round: null, profile: null, target: null } })),
    },
    github: { gql: async () => ({ repository: { pullRequests: { nodes: [] }, refs: { nodes: [] }, ...stub.repository } }) },
  } as unknown as E2eContext;
}

function runDirWith(record: Record<string, unknown>, files: Record<string, string>): string {
  const dir = tempDir('e2e-pipeline-verify-');
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(record));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

async function verifyDir(dir: string, context: E2eContext): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  const ok = await verify(context, dir, (text) => lines.push(text));
  return { ok, lines };
}

describe('#202 verify.ts re-verifies runs of every scenario as before', () => {
  const historyFile = path.join('state', 'repositories', repositoryFileName(REPO));

  describe('roles records', () => {
    const ISSUES = [
      { key: 'R1', number: 11 },
      { key: 'R2', number: 12 },
      { key: 'R3', number: 13 },
    ];
    const check = (seconds: number, number: number, run: string, result: string) =>
      line(seconds, 'checks_finished', { issue: `${REPO}#${number}`, run, role: 'developer', target: 'Agent review', ok: result === 'passed', result, exit_code: result === 'passed' ? 0 : 1, duration_ms: 12 });
    const handoff = (seconds: number, number: number, run: string, role: string, next?: string) =>
      finished(seconds, number, run, { role, ...(next === undefined ? {} : { next_role: next }) });
    const lines = [
      started(0, 11, 'a1', 'developer'),
      started(0, 12, 'b1', 'developer'),
      check(60, 11, 'a1', 'check_failed'),
      check(60, 12, 'b1', 'check_failed'),
      check(120, 11, 'a1', 'passed'),
      check(120, 12, 'b1', 'passed'),
      handoff(120, 11, 'a1', 'developer', 'reviewer'),
      handoff(120, 12, 'b1', 'developer', 'reviewer'),
      started(180, 11, 'a2', 'reviewer'),
      started(180, 13, 'c1', 'developer'),
      handoff(240, 11, 'a2', 'reviewer'),
      started(300, 12, 'b2', 'reviewer'),
      check(300, 13, 'c1', 'check_failed'),
      check(360, 13, 'c1', 'passed'),
      handoff(360, 13, 'c1', 'developer', 'reviewer'),
      handoff(420, 12, 'b2', 'reviewer', 'developer'),
      started(420, 13, 'c2', 'reviewer'),
      started(420, 12, 'b3', 'developer'),
      handoff(480, 13, 'c2', 'reviewer'),
      handoff(480, 12, 'b3', 'developer', 'reviewer'),
      started(540, 12, 'b4', 'reviewer'),
      handoff(600, 12, 'b4', 'reviewer'),
    ];
    const timeline = [
      [11, ['Ready', 'Agent review', 'In review']],
      [12, ['Ready', 'Agent review', 'In progress', 'Agent review', 'In review']],
      [13, ['Ready', 'Agent review', 'In review']],
    ].flatMap(([number, statuses]) => (statuses as string[]).map((status, index) => JSON.stringify({ at: at(index), number, status })));
    const results = {
      '11': [{ kind: 'implementation', verdict: 'done' }, { kind: 'review', verdict: 'approved' }],
      '12': [
        { kind: 'implementation', verdict: 'done' },
        { kind: 'review', verdict: 'changes_needed' },
        { kind: 'implementation', verdict: 'done' },
        { kind: 'review', verdict: 'approved' },
      ],
      '13': [{ kind: 'implementation', verdict: 'done' }, { kind: 'review', verdict: 'approved' }],
    };
    const record = (scenario?: string) => ({
      ...(scenario === undefined ? {} : { scenario }),
      startedAt: '2026-01-01T00:00:00Z',
      repository: REPO,
      issues: ISSUES.map((issue) => ({ ...issue, issueId: `I_${issue.key}`, itemId: String(issue.number), relationships: [], textBlocker: null })),
    });
    const dir = () => runDirWith(record('roles'), { [historyFile]: `${lines.join('\n')}\n`, 'timeline.jsonl': `${timeline.join('\n')}\n`, 'trace.log': 'x running=1 ids=#11 review=1\n' });

    it('passes a recorded roles run with the roles checks, not those of the pipeline', async () => {
      const { ok, lines: out } = await verifyDir(dir(), stubContext({ results }));
      assert.equal(ok, true, out.join('\n'));
      assert.ok(out.some((text) => text.startsWith('PASS  Status path per issue')));
      assert.ok(out.some((text) => text.includes('One denied entry check per issue')));
      assert.ok(out.some((text) => text.startsWith('PASS  No code changes')));
      assert.ok(!out.some((text) => text.includes('Total cost below')), 'no pipeline check');
      assert.ok(!out.some((text) => /^Role\s+Runs/.test(text)), 'no per-role cost table');
    });

    it('fails a roles run in which a result is missing', async () => {
      const { ok, lines: out } = await verifyDir(dir(), stubContext({ results: { ...results, '12': (results['12'] ?? []).slice(0, 2) } }));
      assert.equal(ok, false);
      assert.ok(out.some((text) => text.startsWith('FAIL  Stage results per issue')));
    });

    it('fails a roles run whose test issues left a pull request behind', async () => {
      const repository = { pullRequests: { nodes: [{ number: 3, createdAt: '2026-06-01T00:00:00Z', headRefName: 'x' }] } };
      const { ok, lines: out } = await verifyDir(dir(), stubContext({ results, repository }));
      assert.equal(ok, false);
      assert.ok(out.some((text) => text.startsWith('FAIL  No code changes: pull requests: #3')));
    });
  });

  describe('records without a scenario (the dependency scenario)', () => {
    const numberOf = (key: string) => 30 + Number(key.slice(1));
    // Start, end and close time (seconds) of every issue: T1–T3 overlap, the rest follows the dependencies.
    const schedule: Record<string, [number, number, number]> = {
      T1: [0, 60, 90],
      T2: [0, 60, 90],
      T3: [0, 60, 90],
      T4: [72, 120, 150],
      T5: [126, 180, 210],
      T6: [126, 180, 210],
      T8: [126, 180, 210],
      T7: [240, 300, 330],
      T9: [360, 420, 450],
    };
    const lines = SCENARIO.flatMap((issue) => {
      const [start, end] = schedule[issue.key] as [number, number, number];
      return [started(start, numberOf(issue.key), `run-${issue.key}`), finished(end, numberOf(issue.key), `run-${issue.key}`)];
    });
    const record = {
      startedAt: '2026-01-01T00:00:00Z',
      repository: REPO,
      issues: SCENARIO.map((issue) => ({
        key: issue.key,
        number: numberOf(issue.key),
        issueId: `I_${issue.key}`,
        itemId: `item_${issue.key}`,
        relationships: issue.blockers,
        textBlocker: issue.textBlocker ?? null,
      })),
    };
    const repository = (overrides: { closed?: Record<string, boolean>; relations?: Record<string, string[]> } = {}) => ({
      ...Object.fromEntries(
        SCENARIO.map((issue) => [
          `i${numberOf(issue.key)}`,
          {
            state: overrides.closed?.[issue.key] === false ? 'OPEN' : 'CLOSED',
            closedAt: at((schedule[issue.key] as [number, number, number])[2]),
            blockedBy: { nodes: (overrides.relations?.[issue.key] ?? issue.blockers).map((key) => ({ number: numberOf(key) })) },
            comments: { nodes: [{ body: `${doneMarker(issue.key)}. Dependencies according to the tracker: none` }] },
          },
        ]),
      ),
    });
    const dir = () => runDirWith(record, { [historyFile]: `${lines.join('\n')}\n`, 'trace.log': 'x running=3 ids=#31,#32,#33 review=0\n' });

    it('passes a recorded dependency run with its own five checks', async () => {
      const { ok, lines: out } = await verifyDir(dir(), stubContext({ repository: repository() }));
      assert.equal(ok, true, out.join('\n'));
      const names = out.filter((text) => /^(PASS|FAIL)/.test(text)).map((text) => text.slice(6).split(':')[0]);
      assert.deepEqual(names, ['At most 3 agents at once', 'No issue started before all its dependencies were closed', 'Every run used sonnet', 'No code changes', 'Every issue commented and closed']);
    });

    it('fails when an issue stayed open', async () => {
      const { ok, lines: out } = await verifyDir(dir(), stubContext({ repository: repository({ closed: { T9: false } }) }));
      assert.equal(ok, false);
      assert.ok(out.some((text) => text.startsWith('FAIL  Every issue commented and closed: missing: T9')));
    });

    it('fails when the relationships on GitHub differ from the scenario', async () => {
      const { ok, lines: out } = await verifyDir(dir(), stubContext({ repository: repository({ relations: { T5: [] } }) }));
      assert.equal(ok, false);
      assert.ok(out.some((text) => text.includes('relationships of T5 differ from the scenario')));
    });

    it('dependencies of the default scenario are unchanged by the new scenario', () => {
      assert.equal(SCENARIO.length, 9);
      assert.deepEqual(dependencies({ key: 'T6', number: 1, issueId: '', itemId: '', relationships: ['T1', 'T2'], textBlocker: null }), ['T1', 'T2']);
    });
  });

  describe('pipeline records', () => {
    it('runs the pipeline checks and the per-role table for scenario "pipeline", and the roles ones for "roles" on the same files', async () => {
      const files = { [historyFile]: '', 'timeline.jsonl': '' };
      const issues = PIPELINE_SCENARIO.map((issue, index) => ({ key: issue.key, number: 21 + index, issueId: `I_${issue.key}`, itemId: String(21 + index), relationships: [], textBlocker: null }));
      const pipelineDir = runDirWith({ scenario: 'pipeline', startedAt: '2026-01-01T00:00:00Z', repository: REPO, issues }, files);
      const { ok, lines: out } = await verifyDir(pipelineDir, stubContext());
      assert.equal(ok, false, 'an empty run passes nothing');
      assert.ok(out.some((text) => text.startsWith('FAIL  Status path per issue')));
      assert.ok(out.some((text) => text.startsWith('FAIL  Total cost below 6 USD')));
      assert.ok(out.some((text) => /^Role\s+Runs\s+Turns\s+Models\s+USD/.test(text)), 'the per-role cost table is printed');
      assert.ok(out.every((text) => !text.includes('One denied entry check')));

      const rolesDir = runDirWith({ scenario: 'roles', startedAt: '2026-01-01T00:00:00Z', repository: REPO, issues }, files);
      const roles = await verifyDir(rolesDir, stubContext());
      assert.ok(roles.lines.some((text) => text.includes('One denied entry check')));
      assert.ok(roles.lines.every((text) => !text.includes('Total cost below')));
    });

    it('reports a run that is missing its files as an error instead of a pass', async () => {
      const issues = [{ key: 'P1', number: 21, issueId: 'I', itemId: '21', relationships: [], textBlocker: null }];
      const dir = runDirWith({ scenario: 'pipeline', startedAt: '2026-01-01T00:00:00Z', repository: REPO, issues }, {});
      const { ok } = await verifyDir(dir, stubContext());
      assert.equal(ok, false);
    });
  });
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* Edge cases of verifyPipeline that the acceptance criteria imply                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

describe('#202 verifyPipeline: edge cases', () => {
  const ISSUES = PIPELINE_SCENARIO.map((issue, index) => ({ key: issue.key, number: 21 + index }));
  const ROLE = { analysis: 'issue-analyst', implementation: 'developer', test: 'test-engineer', review: 'reviewer' } as Record<string, string>;
  const TARGET = {
    'analysis:ready': 'In progress',
    'analysis:needs_info': 'Blocked',
    'implementation:done': 'Testing',
    'test:failed': 'In progress',
    'test:passed': 'Agent review',
    'review:changes_needed': 'In progress',
    'review:approved': 'In review',
  } as Record<string, string>;

  /** The expected results, round numbers as the orchestrator counts them (earlier loop verdicts of the kind plus one). */
  function resultsFor(): PipelineResult[] {
    return PIPELINE_SCENARIO.flatMap((issue, index) =>
      issue.results.map((expected, position) => ({
        number: 21 + index,
        kind: expected.kind,
        verdict: expected.verdict,
        summary: `${expected.marker}. Details.`,
        role: ROLE[expected.kind] as string,
        run: `${issue.key}-${position}`,
        round: expected.round,
        profile: expected.kind === 'analysis' ? null : 'bugfix',
        target: TARGET[`${expected.kind}:${expected.verdict}`] as string,
        openQuestions: expected.verdict === 'needs_info' ? 1 : 0,
      })),
    );
  }

  function logFor(results: PipelineResult[], overrides: (result: PipelineResult, index: number) => Record<string, string | number> = () => ({})): string[] {
    return results.flatMap((result, index) => {
      const base = 60 * index;
      return [
        started(base, result.number, result.run as string, result.role),
        line(base + 20, 'stage_result', {
          issue: `${REPO}#${result.number}`,
          run: result.run as string,
          role: result.role,
          kind: result.kind,
          verdict: result.verdict,
          ...(result.round === null ? {} : { round: result.round }),
          target: result.target as string,
          ...(result.profile === null ? {} : { profile: result.profile }),
        }),
        finished(base + 30, result.number, result.run as string, { role: result.role, ...overrides(result, index) }),
      ];
    });
  }

  const timelineOf = (paths: Record<number, string[]>) =>
    Object.entries(paths).flatMap(([number, statuses]) => statuses.map((status, index) => ({ at: at(index), number: Number(number), status })));

  function data(overrides: Partial<PipelineData> = {}): PipelineData {
    const results = resultsFor();
    return {
      issues: ISSUES,
      historyLines: logFor(results),
      timeline: timelineOf({
        21: ['Ready', 'In progress', 'Testing', 'In progress', 'Testing', 'Agent review', 'In review'],
        22: ['Ready', 'In progress', 'Testing', 'Agent review', 'In progress', 'Testing', 'Agent review', 'In review'],
        23: ['Ready', 'Blocked'],
      }),
      results,
      labels: { 21: ['type: bugfix'], 22: ['type: bugfix'], 23: [] },
      maxReviewRounds: 3,
      maxTestRounds: 2,
      limitLabel: 'needs-human',
      costCeilingUsd: COST_CEILING_USD,
      ...overrides,
    };
  }

  const failing = (input: PipelineData) => verifyPipeline(input).filter((check) => !check.ok);

  it('passes the run built from the scenario definition: one check per aspect of the acceptance criteria', () => {
    const checks = verifyPipeline(data());
    assert.deepEqual(checks.filter((check) => !check.ok), []);
    assert.ok(checks.length >= 10, `${checks.length} checks`);
    assert.equal(new Set(checks.map((check) => check.name)).size, checks.length, 'every check has its own name');
  });

  it('still fails when an earlier session failed and a later one handed off: no failed or stalled run is allowed at all', () => {
    const results = resultsFor();
    const log = [...logFor(results), started(5, 22, 'retry-1', 'developer'), finished(6, 22, 'retry-1', { role: 'developer', outcome: 'failed' })];
    // The failed run started first (5 s), so the handed-off sessions come after it.
    const shuffled = [log[log.length - 2], log[log.length - 1], ...log.slice(0, -2)] as string[];
    const names = failing(data({ historyLines: shuffled })).map((check) => check.name);
    assert.deepEqual(names, ['Last session handed off, none failed or stalled']);
  });

  it('fails a run in which a session outcome is missing from the log (a session that never finished)', () => {
    const lines = logFor(resultsFor()).filter((entry) => !(entry.includes('event=run_finished') && entry.includes('run=P1-5')));
    const detail = failing(data({ historyLines: lines })).find((check) => check.name.startsWith('Sessions that handed off'))?.detail ?? '';
    assert.match(detail, /P1: .*expected .*reviewer/);
  });

  it('fails when a run finished without a cost, a model, or with the default model', () => {
    const noCost = logFor(resultsFor()).map((entry) => entry.replace(/ cost_usd=\S+/, ''));
    const names = (lines: string[]) => failing(data({ historyLines: lines })).map((check) => check.name);
    assert.ok(names(noCost).includes('Every role ran and cost something'));
    assert.ok(names(noCost).some((name) => name.startsWith('Total cost below')));
    const noModel = logFor(resultsFor()).map((entry) => entry.replace(/ model=claude-sonnet-5-5/, ''));
    assert.ok(names(noModel).includes('Every run used sonnet'));
    const defaulted = logFor(resultsFor()).map((entry) => (entry.includes('event=run_started') ? entry.replace('model=sonnet', 'model=default') : entry));
    assert.ok(names(defaulted).includes('Every run used sonnet'));
  });

  it('does not depend on the order of the results of different issues', () => {
    const results = resultsFor();
    // Round robin over the issues: the results of different issues alternate, the order within an issue stays.
    const perIssue = ISSUES.map((issue) => results.filter((result) => result.number === issue.number));
    const interleaved = Array.from({ length: Math.max(...perIssue.map((own) => own.length)) }, (_, position) => perIssue.flatMap((own) => (own[position] === undefined ? [] : [own[position]]))).flat() as PipelineResult[];
    assert.notDeepEqual(interleaved.map((result) => result.run), results.map((result) => result.run), 'the order did change');
    assert.deepEqual(failing(data({ results: interleaved })), []);
  });

  it('does not take lines of other events or other text for sessions', () => {
    const noise = ['', 'not a log line', line(1, 'poll_finished', { issue: `${REPO}#21`, run: 'x' }), line(2, 'retry_scheduled', { issue: `${REPO}#21`, run: 'y' })];
    assert.deepEqual(failing(data({ historyLines: [...noise, ...logFor(resultsFor()), ...noise] })), []);
    assert.equal(pipelineRuns(noise).length, 0);
    assert.deepEqual(costByRole(pipelineRuns(noise)), []);
  });

  it('prices every role by its own sessions and sums them', () => {
    const results = resultsFor();
    const lines = logFor(results, (result) => ({ cost_usd: result.role === 'reviewer' ? 0.5 : 0.1, turns: result.role === 'developer' ? 3 : 1 }));
    const byRole = Object.fromEntries(costByRole(pipelineRuns(lines)).map((cost) => [cost.role, cost]));
    assert.equal(byRole['reviewer']?.runs, 3);
    assert.ok(Math.abs((byRole['reviewer']?.costUsd ?? 0) - 1.5) < 1e-9);
    assert.ok(Math.abs((byRole['issue-analyst']?.costUsd ?? 0) - 0.3) < 1e-9);
    assert.equal(byRole['developer']?.turns, 12);
    assert.equal(byRole['test-engineer']?.runs, 4);
  });

  it('measures the ceiling on the sum of all sessions, exclusive', () => {
    const results = resultsFor();
    const sessions = results.length;
    const exactly = logFor(results, () => ({ cost_usd: COST_CEILING_USD / sessions }));
    assert.deepEqual(failing(data({ historyLines: exactly })).map((check) => check.name), [`Total cost below ${COST_CEILING_USD} USD`], 'on the ceiling is over it');
    const below = logFor(results, () => ({ cost_usd: (COST_CEILING_USD - 0.1) / sessions }));
    assert.deepEqual(failing(data({ historyLines: below })), []);
    assert.deepEqual(failing(data({ costCeilingUsd: 100 })), []);
  });

  it('fails P1 when the failed round is missing even though everything else looks right', () => {
    const results = resultsFor().filter((result) => !(result.number === 21 && result.verdict === 'failed'));
    const names = failing(data({ results, historyLines: logFor(results) })).map((check) => check.name);
    assert.ok(names.includes('Stage results per issue (report_result)'));
    assert.ok(!names.includes('Last session handed off, none failed or stalled'));
  });

  it('fails P2 when it was approved in the first round, without the review loop', () => {
    const results = resultsFor().filter((result) => result.number !== 22 || (result.verdict !== 'changes_needed' && result.round !== 2));
    const names = failing(data({ results, historyLines: logFor(results) })).map((check) => check.name);
    assert.ok(names.includes('Stage results per issue (report_result)'));
  });

  it('fails P3 when the blocked analysis is followed by a developer session', () => {
    const results = [...resultsFor(), { ...(resultsFor().find((result) => result.kind === 'implementation') as PipelineResult), number: 23, run: 'late' }];
    const names = failing(data({ results, historyLines: logFor(results) })).map((check) => check.name);
    assert.ok(names.some((name) => name.startsWith('Blocked analysis')));
    assert.ok(names.includes('Stage results per issue (report_result)'));
  });

  it('fails P3 with a needs_info that carries no question', () => {
    const results = resultsFor().map((result) => (result.number === 23 ? { ...result, openQuestions: 0 } : result));
    const detail = failing(data({ results })).find((check) => check.name.startsWith('Blocked analysis'))?.detail ?? '';
    assert.match(detail, /P3/);
    assert.match(detail, /question/);
  });

  it('fails any issue that was seen in Done at any time, also briefly', () => {
    const timeline = data().timeline.flatMap((entry) => (entry.number === 21 && entry.status === 'In review' ? [{ ...entry, status: 'Done' }, entry] : [entry]));
    const names = failing(data({ timeline })).map((check) => check.name);
    assert.ok(names.includes('No issue reached "Done"'));
  });

  it('is case-insensitive about board column names like the tracker is', () => {
    const timeline = data().timeline.map((entry) => ({ ...entry, status: (entry.status ?? '').toUpperCase() }));
    assert.deepEqual(failing(data({ timeline })), []);
  });

  it('throws on an issue key that is not part of the scenario instead of passing it silently', () => {
    assert.throws(() => verifyPipeline(data({ issues: [...ISSUES, { key: 'R1', number: 99 }] })), /R1/);
  });
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* Documentation                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

describe('#202 documentation', () => {
  const e2e = read('docs/e2e.md');
  const usage = read('docs/usage.md');
  const sectionOfDoc = (text: string, heading: string): string => {
    const start = text.indexOf(`\n${heading}\n`);
    assert.notEqual(start, -1, `${heading} exists`);
    const level = heading.match(/^#+/)?.[0].length ?? 2;
    const rest = text.slice(start + heading.length + 2);
    const next = rest.search(new RegExp(`\\n#{1,${level}} `));
    return next === -1 ? rest : rest.slice(0, next);
  };
  const pipelineSection = sectionOfDoc(e2e, '## Scenario `pipeline`');

  it('introduces the pipeline scenario with working links to its section and to the roles section', () => {
    const intro = e2e.slice(0, e2e.indexOf('## Requirements'));
    assert.match(intro, /\[`pipeline` scenario\]\(#scenario-pipeline\)/);
    assert.match(intro, /\[`roles` scenario\]\(#scenario-roles\)/);
    assert.ok(e2e.includes('\n## Scenario `pipeline`\n'), 'the anchor #scenario-pipeline resolves to this heading');
    assert.ok(e2e.includes('\n## Scenario `roles`\n'));
  });

  it('lists the requirements of the pipeline scenario: every column of the preflight and the slots', () => {
    const requirements = sectionOfDoc(e2e, '## Requirements');
    assert.match(requirements, /--scenario pipeline/);
    for (const column of PIPELINE_COLUMNS) assert.ok(requirements.includes(`\`${column}\``), `the requirements name the column ${column}`);
    assert.match(requirements, /SYMPHONY_MAX_CONCURRENT_AGENTS/);
  });

  it('describes the issues with their three board paths, as the scenario defines them', () => {
    for (const issue of PIPELINE_SCENARIO) {
      assert.ok(pipelineSection.includes(`| ${issue.key} `), `${issue.key} has a row in the issue table`);
      const route = issue.path.map((status) => `\`${status}\``).join(' → ');
      assert.ok(pipelineSection.includes(route), `${issue.key}: ${route}`);
      for (const result of issue.results) assert.ok(pipelineSection.includes(`\`${result.kind}:${result.verdict}\``), `${result.kind}:${result.verdict} is described`);
    }
    assert.match(pipelineSection, /Model: sonnet/);
  });

  it('documents the workflow overrides with the values the generated workflow really has', () => {
    const { config } = parseWorkflow(pipelineWorkflow(source, ROOT)) as { config: Record<string, any> };
    assert.match(pipelineSection, new RegExp(`\`polling\\.interval_ms\` \\| ${config.polling.interval_ms}`));
    assert.match(pipelineSection, new RegExp(`\`agent\\.max_issue_cost_usd\` \\| ${config.agent.max_issue_cost_usd}`));
    assert.match(pipelineSection, new RegExp(`\`timeout_ms\` ${config.checks.timeout_ms}`));
    for (const setting of ['claude.model', 'checks.on_enter', 'laravel.boost', 'pipeline.profiles.bugfix', 'pipeline.max_review_rounds', 'max_test_rounds', 'tracker.active_states']) {
      assert.ok(pipelineSection.includes(setting), `the overrides section mentions ${setting}`);
    }
    assert.match(pipelineSection, /opus/, 'it says why the reviewer is overridden');
  });

  it('documents the checks, the cost ceiling and duration of the scenario with the constants of the code', () => {
    assert.ok(pipelineSection.includes('scripts/e2e/verify-pipeline.ts'));
    assert.ok(pipelineSection.includes('test/e2e-pipeline.test.ts'));
    assert.match(pipelineSection, new RegExp(`${COST_CEILING_USD} USD`));
    assert.match(pipelineSection, new RegExp(`default \`--timeout\` is ${PIPELINE_TIMEOUT_MIN} minutes`));
    assert.match(pipelineSection, /\*\*Cost and duration\.\*\*/);
    assert.match(pipelineSection, /per role/);
    const checkNames = ['Status path', 'Never `Done`', 'Stage results', 'Markers', 'Rounds', 'Profile', 'Blocked analysis', 'Last session', 'Cost per role', 'Model', 'Total cost', 'No code changes'];
    for (const name of checkNames) assert.ok(pipelineSection.includes(`| ${name} |`), `a check row: ${name}`);
  });

  it('has a Reference run subsection inside the pipeline section, as a placeholder for the human live run', () => {
    assert.ok(pipelineSection.includes('### Reference run'));
    const reference = sectionOfDoc(e2e, '### Reference run');
    assert.match(reference, /Date/);
    assert.match(reference, /Duration/);
    assert.match(reference, /Cost/);
    assert.match(reference, /manual step|human|needs a board/i, 'it says that the live run is a manual step');
    assert.ok(e2e.indexOf('### Reference run') < e2e.indexOf('\n## Run directory\n'), 'the reference run belongs to the pipeline section');
  });

  it('lists the options, the run directory files and every script of scripts/e2e in the documentation', () => {
    const options = sectionOfDoc(e2e, '## Run');
    assert.match(options, /npm run e2e -- --scenario pipeline/);
    assert.match(options, /\| `--scenario <name>` \| `default` \| .*`pipeline`/);
    assert.match(options, new RegExp(`\\| \`--timeout <min>\` \\| 45; ${PIPELINE_TIMEOUT_MIN} for \`pipeline\``));
    const runDirectory = sectionOfDoc(e2e, '## Run directory');
    assert.match(runDirectory, /\| `WORKFLOW\.md` \| Pipeline scenario: generated workflow/);
    assert.match(runDirectory, /`timeline\.jsonl` \| Roles and pipeline scenarios/);
    assert.match(runDirectory, /verify\.ts logs\/e2e/);
    const files = sectionOfDoc(e2e, '## Files');
    for (const file of fs.readdirSync(path.join(ROOT, 'scripts', 'e2e')).filter((name) => name.endsWith('.ts'))) {
      assert.ok(files.includes(`\`scripts/e2e/${file}\``), `docs/e2e.md lists scripts/e2e/${file}`);
    }
  });

  it('mentions the scenario in the E2E section of docs/usage.md, with its command and its cost', () => {
    const start = usage.indexOf('`npm run e2e -- --scenario pipeline`');
    assert.notEqual(start, -1);
    assert.match(usage, /npm run e2e -- --scenario pipeline\s+#/);
    assert.match(usage, /docs\/e2e\.md|\(e2e\.md\)/);
    const around = usage.slice(start, start + 1_500);
    assert.match(around, /test loop|review loop|blocked/i);
    assert.match(usage, /USD 1–3 for `pipeline`/);
  });

  it('keeps the existing documentation of the default and roles scenarios', () => {
    assert.match(e2e, /## Scenario `roles`/);
    assert.match(e2e, /\| Concurrency \|/);
    assert.match(e2e, /\| Dependencies \|/);
    assert.match(usage, /npm run e2e -- --scenario roles/);
  });
});
