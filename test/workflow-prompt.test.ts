import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Logger } from '../src/log.ts';
import { resolveTransition } from '../src/orchestrator/transitions.ts';
import { STANDARD_LABELS } from '../src/repo-init/labels.ts';
import { githubProjectFactory } from '../src/tracker/github-project/index.ts';
import { parseSettings } from '../src/tracker/github-project/settings.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { maxColumnCheckMs, resolveConfig } from '../src/workflow/config.ts';
import { commandSkills, pluginAgents } from '../src/workflow/command.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { profileFor } from '../src/workflow/profile.ts';
import { roleFor, roleName, sessionAgents } from '../src/workflow/roles.ts';
import type { EffectiveWorkflow } from '../src/workflow/store.ts';
import { unknownBoardColumns, validateDispatch } from '../src/workflow/validate.ts';
import { compilePrompt, EMPTY_RESULTS, issueTemplateValue, renderPrompt } from '../src/workflow/template.ts';
import { RESULT_FIELD_BUDGET, SUMMARY_MAX } from '../src/workflow/results.ts';
import { makeIssue } from './helpers.ts';

/** The WORKFLOW.md shipped in the repository root. */
const shipped = path.join(import.meta.dirname, '..', 'WORKFLOW.md');

const issue = makeIssue({
  id: 'PVTI_1',
  identifier: 'acme/app#42',
  title: 'Add invoices',
  description: 'Create an invoice resource.',
  state: 'In progress',
  url: 'https://github.com/acme/app/issues/42',
  labels: ['feature', 'model: opus', 'effort: high'],
  native_ref: {
    provider: 'github_project',
    repository: 'acme/app',
    number: 42,
    parent: null,
    sub_issues: [],
    base_branch: null,
  },
});

/** The role of an ordinary issue (no command): the issue analyst looks at it in Ready, the developer implements it. */
const serving = (state: string): string => (state === 'Ready' ? 'issue-analyst' : 'developer');

/** Symphony's own plugin: the skills behind the issue commands. */
const toolbox = path.join(import.meta.dirname, '..', '.claude');

async function render(
  role: string,
  attempt: number | null = null,
  description?: string,
  baseBranch: string | null = null,
  agents: Array<{ name: string; description: string }> = [],
  history: Record<string, unknown> = {},
): Promise<string> {
  const { definition } = await loadWorkflowFile(shipped);
  const template = compilePrompt(definition.promptTemplate, definition.partials);
  assert.equal(template.parseError, null);
  const subject = {
    ...issue,
    ...(description !== undefined ? { description } : {}),
    native_ref: { ...issue.native_ref, base_branch: baseBranch },
  };
  return renderPrompt(template, { issue: issueTemplateValue(subject, commandSkills([toolbox])), attempt, role, agents, ...history });
}

/** The stage history of a session that follows a review with changes needed. */
const afterReview = {
  result_required: true,
  round: 2,
  results: {
    latest: [],
    open_findings: [
      { severity: 'major', file: 'app/Invoice.php', line: 12, problem: 'Total ignores discounts', fix: 'Subtract the discount' },
      { severity: 'minor', file: 'README.md', line: null, problem: 'Typo', fix: null },
    ],
    failed_cases: [],
  },
};

/** The stage history of a session that follows a test run with failed cases (a developer fixing it, a test engineer rerunning it). */
const afterFailedTest = {
  result_required: true,
  round: 2,
  test_paths: ['tests/**', '**/*Test.php'],
  results: {
    latest: [],
    open_findings: [],
    failed_cases: [{ criterion: 'A discount lowers the total', test: 'tests/TotalTest.php::discount' }],
    test: { verdict: 'failed', summary: 'The total ignores discounts.', round: 1, commands: ['php artisan test --filter=Total'] },
  },
};

describe('shipped WORKFLOW.md', () => {
  it('puts the newest human comments into the prompt as the current task, and leaves them out without any', async () => {
    const feedback = { human_feedback: [{ author: 'cooolinho', created_at: '2026-10-23T06:43:57.000Z', url: 'https://github.com/acme/app/issues/7#issuecomment-1', body: 'Behebe folgende Findings: startAgainFor()' }] };
    for (const role of ['issue-analyst', 'architect', 'developer']) {
      const prompt = await render(role, null, undefined, null, [], feedback);
      assert.match(prompt, /## Newest human comments/, role);
      assert.match(prompt, /### cooolinho, 2026-10-23T06:43:57\.000Z \(https:\/\/github\.com\/acme\/app\/issues\/7#issuecomment-1\)\n\nBehebe folgende Findings: startAgainFor\(\)/, role);
      assert.match(prompt, /It is the current task/, role);
    }
    assert.match(await render('issue-analyst'), /Read the newest human comment first/);
    assert.doesNotMatch(await render('issue-analyst'), /## Newest human comments/);
  });

  it('sets brain per role: write, read or off', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const config = resolveConfig(definition.config, { workflowPath: shipped, env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' }, trackerDefaults });
    const modes = Object.fromEntries((config.roles ?? []).map((role) => [role.name, role.brain]));
    assert.deepEqual(modes, {
      'issue-analyst': 'write', architect: 'write', reviewer: 'write',
      developer: 'read', 'test-engineer': 'read', 'security-auditor': 'read',
      docs: 'off', auditor: 'off', autopilot: 'off', analyst: 'off', planner: 'off', 'brain-gardener': 'write',
    });
  });

  it('includes the knowledge vault section only for brain read or write', async () => {
    const index = 'Repos/acme-app/index.md';
    for (const history of [{}, { brain: 'off', brain_index: index }]) {
      assert.ok(!(await render('developer', null, undefined, null, [], history)).includes('Knowledge vault'));
    }
    const read = await render('developer', null, undefined, null, [], { brain: 'read', brain_index: index });
    for (const part of ['Knowledge vault', index, 'brain_search', 'purpose', 'candidate', 'You cannot write', 'repeatable insight']) assert.ok(read.includes(part), part);
    assert.ok(!read.includes('base_hash') && !read.includes('brain_write'));
    const write = await render('reviewer', null, undefined, null, [], { brain: 'write', brain_index: index });
    for (const part of [index, 'base_hash', 'brain_write', 'brain_append', 'repeatable insight', 'no lesson']) assert.ok(write.includes(part), part);
    assert.ok(!write.includes('You cannot write'));
    assert.ok((await render('developer', null, undefined, null, [], { brain: 'read', brain_index: null })).includes('brain_list'));
  });

  it('resolves to the developer and reviewer roles with entry checks', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const config = resolveConfig(definition.config, {
      workflowPath: shipped,
      env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' },
      trackerDefaults,
    });
    assert.equal(roleName(roleFor({ state: 'Ready', description: null }, config.roles)), 'issue-analyst');
    assert.equal(roleName(roleFor({ state: 'In progress', description: null }, config.roles)), 'developer');
    assert.equal(roleName(roleFor({ state: 'Agent review', description: null }, config.roles)), 'reviewer');
    assert.equal(config.agent.maxContinuations, 6);
  });

  it('hands off with report_result: verdicts decide the next column and Symphony enforces the review rounds', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const config = resolveConfig(definition.config, {
      workflowPath: shipped,
      env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' },
      trackerDefaults,
    });
    const developer = roleFor({ state: 'In progress', description: null }, config.roles);
    const reviewer = roleFor({ state: 'Agent review', description: null }, config.roles);
    assert.equal(developer?.result, 'implementation');
    assert.deepEqual(developer?.onResult, { done: 'Agent review', blocked: 'Blocked' });
    assert.equal(reviewer?.result, 'review');
    assert.deepEqual(reviewer?.onResult, { approved: 'In review', changes_needed: 'In progress', blocked: 'Blocked' });
    assert.equal(reviewer?.onCheckFailed, 'In progress');
    assert.equal(config.pipeline.maxReviewRounds, 3);
  });

  it('adds the test engineer between the developer and the reviewer, switched on by SYMPHONY_AFTER_IMPLEMENTATION', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const resolveWith = (extra: NodeJS.ProcessEnv) =>
      resolveConfig(definition.config, {
        workflowPath: shipped,
        env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't', ...extra },
        trackerDefaults,
      });
    const config = resolveWith({});
    const tester = roleFor({ state: 'Testing', description: null }, config.roles);
    assert.equal(tester?.name, 'test-engineer');
    assert.deepEqual(config.tracker.activeStates, ['Ready', 'Design', 'In progress', 'Testing', 'Documentation', 'Agent review', 'Security review']);
    assert.deepEqual(
      [tester?.result, tester?.onResult, tester?.readOnly, tester?.modelLabel, tester?.claude.model, tester?.agents],
      ['test', { passed: 'Agent review', failed: 'In progress', blocked: 'Blocked' }, false, 'ignore', 'sonnet', ['test-designer']],
    );
    assert.deepEqual(tester?.mayMoveTo, ['Documentation', 'Agent review', 'In progress', 'Blocked']);
    assert.deepEqual([config.pipeline.maxTestRounds, config.pipeline.testPaths], [2, ['tests/**', 'test/**', '**/*.test.*', '**/*Test.php']]);
    assert.ok(config.checks.onEnter.has('testing') && config.checks.onEnter.has('agent review'), 'the optional Testing check, and Agent review keeps its own');

    // Off by default: the developer hands over to Agent review, so existing boards keep their flow.
    const developer = (candidate: typeof config) => roleFor({ state: 'In progress', description: null }, candidate.roles);
    assert.equal(developer(config)?.onResult.done, 'Agent review');
    const on = resolveWith({ SYMPHONY_AFTER_IMPLEMENTATION: 'Testing' });
    assert.equal(developer(on)?.onResult.done, 'Testing');
    assert.ok(developer(on)?.mayMoveTo?.includes('Testing'));
    assert.equal(developer(resolveWith({ SYMPHONY_AFTER_IMPLEMENTATION: '' }))?.onResult.done, 'Agent review');
  });

  describe('bugfix profile', () => {
    const BOARD = ['Backlog', 'Ready', 'Design', 'In progress', 'Testing', 'Documentation', 'Agent review', 'Security review', 'Blocked', 'In review', 'Done'];
    const resolveWith = async (extra: NodeJS.ProcessEnv = {}) => {
      const { definition } = await loadWorkflowFile(shipped);
      return resolveConfig(definition.config, {
        workflowPath: shipped,
        env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't', ...extra },
        trackerDefaults,
      });
    };
    /** Where `role` sends an issue with these labels after `verdict`, through the profile the labels pick. */
    const target = (config: Awaited<ReturnType<typeof resolveWith>>, labels: string[], role: string, verdict: string, board: readonly string[] = BOARD): string | undefined => {
      const profile = profileFor(config.pipeline, issueTemplateValue(makeIssue({ ...issue, labels }), new Map(), config.pipeline).type as never);
      const roleConfig = config.roles?.find((candidate) => candidate.name === role);
      assert.ok(roleConfig);
      const outcome = resolveTransition({ role: roleConfig, verdict, history: { reviewRounds: 0, testRounds: 0 }, profile, config, boardColumns: board, issue: { description: null, labels } });
      assert.ok(outcome.ok, outcome.ok ? '' : outcome.problem);
      return outcome.target;
    };

    it('defines the profiles: the bugfix, feature and refactor developers hand over to Testing, the architect is skipped for small issues, and the config has no warnings', async () => {
      const config = await resolveWith();
      assert.deepEqual([...config.pipeline.profiles.keys()], ['bugfix', 'feature', 'refactor', 'default']);
      const bugfix = config.pipeline.profiles.get('bugfix');
      assert.deepEqual(bugfix?.onResult, { developer: { done: 'Testing' } });
      assert.deepEqual(bugfix?.skip, []);
      assert.deepEqual(bugfix?.skipWhen, { architect: ['S', 'M'] });
      for (const name of ['feature', 'refactor']) {
        assert.deepEqual(config.pipeline.profiles.get(name)?.onResult, { developer: { done: 'Testing' } }, name);
        assert.deepEqual(config.pipeline.profiles.get(name)?.skipWhen, { architect: ['S'] }, name);
      }
      assert.deepEqual(config.pipeline.profiles.get('default')?.onResult, {});
      assert.deepEqual(config.pipeline.profiles.get('default')?.skipWhen, { architect: ['S'] });
      assert.equal(config.roles?.some((role) => role.name === 'architect'), true, 'the architect is a stage in Design');
      assert.equal(config.warnings?.length ?? 0, 0);
    });

    it('routes a bug through the analyst, developer, test engineer and reviewer to In review', async () => {
      const config = await resolveWith();
      for (const labels of [['bug', 'complexity: s'], ['type: bugfix', 'complexity: m']]) {
        assert.equal(target(config, labels, 'issue-analyst', 'ready'), 'In progress', labels.join());
        assert.equal(target(config, labels, 'developer', 'done'), 'Testing', labels.join());
        assert.equal(target(config, labels, 'test-engineer', 'passed'), 'Agent review', labels.join());
        assert.equal(target(config, labels, 'test-engineer', 'failed'), 'In progress', labels.join());
        assert.equal(target(config, labels, 'reviewer', 'approved'), 'In review', labels.join());
      }
    });

    it('routes features and refactors through Testing and keeps Agent review for untyped issues, unless SYMPHONY_AFTER_IMPLEMENTATION=Testing', async () => {
      const config = await resolveWith();
      for (const labels of [['feature'], ['type: refactor']]) {
        for (const complexity of ['complexity: s', 'complexity: m']) {
          const all = [...labels, complexity];
          assert.equal(target(config, all, 'issue-analyst', 'ready'), complexity === 'complexity: s' ? 'In progress' : 'Design', all.join());
          assert.equal(target(config, all, 'developer', 'done'), 'Testing', all.join());
          assert.equal(target(config, all, 'test-engineer', 'passed'), 'Agent review', all.join());
          assert.equal(target(config, all, 'test-engineer', 'failed'), 'In progress', all.join());
          assert.equal(target(config, all, 'reviewer', 'approved'), 'In review', all.join());
        }
      }
      for (const labels of [['documentation'], []]) assert.equal(target(config, labels, 'developer', 'done'), 'Agent review', labels.join() || 'untyped');
      const on = await resolveWith({ SYMPHONY_AFTER_IMPLEMENTATION: 'Testing' });
      for (const labels of [['feature'], ['bug'], []]) assert.equal(target(on, labels, 'developer', 'done'), 'Testing', labels.join() || 'untyped');
    });

    it('limits the test stage to one run at a time and keeps Testing an active state with a note on the slots', async () => {
      const config = await resolveWith();
      assert.equal(config.agent.maxConcurrentAgentsByState.get('testing'), 1);
      assert.equal(config.agent.maxConcurrentAgentsByState.get('agent review'), 2);
      assert.ok(config.tracker.activeStates.includes('Testing'));
      const source = fs.readFileSync(shipped, 'utf8');
      assert.match(source, /#   Testing +-> test engineer[\s\S]*Bug, feature and refactor issues \(pipeline\.profiles\) always go through it/);
      assert.doesNotMatch(source, /Optional: the developer hands over to Testing/);
    });

    it('passes the board preflight with all columns and names a missing Testing column, also through the profile target', async () => {
      const config = await resolveWith();
      assert.deepEqual(unknownBoardColumns(config, BOARD), []);
      const withoutTesting = BOARD.filter((column) => column !== 'Testing');
      assert.deepEqual(unknownBoardColumns(config, withoutTesting), [`unknown board column "Testing" (valid: ${withoutTesting.join(', ')})`]);

      // Even with no role and no active state for Testing, the profile's target (and the developer's may_move_to) still names the column.
      const { definition } = await loadWorkflowFile(shipped);
      const front = structuredClone(definition.config) as Record<string, any>;
      front.tracker.active_states = ['Ready', 'In progress', 'Agent review'];
      delete front.roles.architect;
      for (const profile of Object.values(front.pipeline.profiles) as Array<Record<string, unknown>>) delete profile.skip_when;
      delete front.roles['test-engineer'];
      delete front.roles['security-auditor'];
      delete front.roles.docs;
      front.roles.developer.on_result.done = 'Agent review';
      delete front.checks.on_enter.Testing;
      const profileOnly = resolveConfig(front, { workflowPath: shipped, env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' }, trackerDefaults });
      assert.deepEqual(unknownBoardColumns(profileOnly, withoutTesting), [`unknown board column "Testing" (valid: ${withoutTesting.join(', ')})`]);
    });

    it('adds the regression-test-first instruction to the developer prompt of bug issues only', async () => {
      const prompt = async (labels: string[]) => {
        const { definition } = await loadWorkflowFile(shipped);
        const template = compilePrompt(definition.promptTemplate, definition.partials);
        return renderPrompt(template, { issue: issueTemplateValue(makeIssue({ ...issue, labels }), commandSkills([toolbox])), attempt: null, role: 'developer', agents: [], round: 1 });
      };
      for (const labels of [['bug'], ['type: bugfix']]) {
        const text = await prompt(labels);
        assert.match(text, /write a regression test that reproduces the bug before you change any production code/, labels.join());
        assert.match(text, /confirm that it fails, and that it fails for the right reason/, labels.join());
        assert.match(text, /Then fix the bug and run the test again until it passes/, labels.join());
      }
      for (const labels of [['feature'], ['type: refactor'], []]) {
        const text = await prompt(labels);
        assert.doesNotMatch(text, /regression test/, labels.join() || 'untyped');
        assert.match(text, /5\. Implement the change\./);
      }
    });
  });

  it('adds the issue analyst before the developer: read-only, an analysis result, sonnet whatever the Model: label says', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const config = resolveConfig(definition.config, {
      workflowPath: shipped,
      env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' },
      trackerDefaults,
    });
    const analyst = config.roles?.find((role) => role.name === 'issue-analyst');
    assert.deepEqual(analyst?.states, ['ready']);
    assert.deepEqual(
      [analyst?.readOnly, analyst?.result, analyst?.onResult, analyst?.maxTurns, analyst?.modelLabel, analyst?.claude.model, analyst?.agents, analyst?.commands],
      [true, 'analysis', { ready: 'next', needs_info: 'Blocked' }, 3, 'ignore', 'sonnet', [], null],
    );
    assert.deepEqual(analyst?.mayMoveTo, ['Design', 'In progress', 'Blocked']);
    // The developer serves only In progress, so a Ready issue never reaches it without the analysis.
    assert.deepEqual(config.roles?.find((role) => role.name === 'developer')?.states, ['in progress']);
    assert.equal(roleName(roleFor({ state: 'Ready', description: 'Add invoices' }, config.roles)), 'issue-analyst');
    assert.equal(config.pipeline.analysis, 'always');
    // A slot beyond the developer's and the reviewer's, or no issue in Ready would ever start.
    assert.ok(config.agent.maxConcurrentAgents >= 3);
  });

  it('renders the read-only issue analyst prompt: what to analyse, the result fields and how to handle each answer', async () => {
    const prompt = await render('issue-analyst', 2, undefined, 'develop', [{ name: 'laravel-architect', description: 'Plans features' }]);
    assert.match(prompt, /Your role: issue analyst/);
    assert.match(prompt, /\*\*read-only\*\*/);
    assert.match(prompt, /`get_issue`, `add_comment` and `report_result`/);
    assert.match(prompt, /Read the project's instructions first/);
    assert.match(prompt, /Inspect the code/);
    assert.match(prompt, /Refine the acceptance criteria/);
    for (const field of ['`type`', '`complexity`', '`components`', '`acceptance_criteria`', '`risks`', '`docs_needed`', '`plan`', '`open_questions`']) {
      assert.ok(prompt.includes(field), `the prompt names ${field}`);
    }
    assert.match(prompt, /`ready`.*`needs_info`/);
    assert.match(prompt, /`open_questions`: for `needs_info`.*at least one.*"Blocked"/);
    assert.match(prompt, /only where the issue has none; a label a human set stays/);
    assert.match(prompt, /`invalid_result`.*call `report_result` again/);
    assert.match(prompt, /`laravel-architect`: Plans features/);
    assert.match(prompt, /Attempt 2/);
    assert.doesNotMatch(prompt, /set_status/);
    assert.doesNotMatch(prompt, /open_pull_request/);
    assert.doesNotMatch(prompt, /Your role: developer/);
    assert.doesNotMatch(prompt, /Analysis of the issue analyst/);
  });

  it('gives the developer, the test engineer and the reviewer the analysis of the issue analyst', async () => {
    const results = {
      latest: [],
      open_findings: [],
      failed_cases: [],
      test: null,
      analysis: {
        verdict: 'ready',
        summary: 'One component, no schema change.',
        type: 'feature',
        complexity: 'M',
        components: ['app/Filament/InvoiceResource.php'],
        acceptance_criteria: ['The export lists every invoice', 'An empty list exports a header only'],
        risks: ['breaking change'],
        docs_needed: true,
        open_questions: [],
        plan: ['Add the exporter', 'Test it'],
        refactoring_goals: [],
      },
    };
    for (const role of ['developer', 'test-engineer', 'reviewer']) {
      const prompt = await render(role, null, undefined, null, [], { result_required: true, round: 1, results });
      assert.match(prompt, /## Analysis of the issue analyst/, role);
      assert.match(prompt, /\(type: feature, complexity: M\)/, role);
      assert.match(prompt, /One component, no schema change\./, role);
      assert.match(prompt, /- `app\/Filament\/InvoiceResource\.php`/, role);
      assert.match(prompt, /- \[ \] The export lists every invoice\n- \[ \] An empty list exports a header only/, role);
      assert.match(prompt, /Risks: breaking change\./, role);
      assert.match(prompt, /Documentation needs an update\./, role);
      assert.match(prompt, /1\. Add the exporter\n2\. Test it/, role);
    }
    // Nothing is rendered without an analysis (the skipped stage, an old issue).
    for (const role of ['developer', 'test-engineer', 'reviewer']) {
      assert.doesNotMatch(await render(role), /Analysis of the issue analyst/, role);
    }
  });

  describe('feature and refactor profiles', () => {
    const GOALS = ['The parsing code exists once', 'No public signature of the module changes'];
    const resultsWith = (goals: string[]) => ({
      latest: [],
      open_findings: [],
      failed_cases: [],
      test: null,
      design: null,
      analysis: {
        verdict: 'ready',
        summary: 'Merge the parsers.',
        type: 'refactor',
        complexity: 'M',
        components: [],
        acceptance_criteria: [],
        risks: [],
        docs_needed: false,
        open_questions: [],
        plan: [],
        refactoring_goals: goals,
      },
    });
    const prompt = (role: string, labels: string[], description?: string, goals: string[] | null = []) => {
      const subject = { ...issue, labels, ...(description !== undefined ? { description } : {}) };
      return loadWorkflowFile(shipped).then(({ definition }) =>
        renderPrompt(compilePrompt(definition.promptTemplate, definition.partials), {
          issue: issueTemplateValue(makeIssue(subject), commandSkills([toolbox])),
          attempt: null,
          role,
          agents: [],
          round: 1,
          result_required: true,
          test_paths: ['tests/**'],
          ...(goals === null ? {} : { results: resultsWith(goals) }),
        }),
      );
    };
    const REFACTOR_ONLY = [
      /This is a refactoring: it must not change behaviour/,
      /characterization tests/,
      /Behaviour preserved \(refactoring\)/,
      /`refactoring_goals`/,
      /`confirmed_goals`/,
      /green on the base commit/,
    ];
    const FEATURE_ONLY = [/This is a new feature: implement the design/, /\*\*Feature:\*\* the change implements the design/];

    it('tells the refactor developer to load the skill, work characterization tests first and meet the goals', async () => {
      const text = await prompt('developer', ['type: refactor'], 'Merge the parsers.', GOALS);
      assert.match(text, /This is a refactoring: it must not change behaviour\. Before you change any code, load the skill `symphony:refactor-safely` with the Skill tool and follow it\./);
      assert.match(text, /Work characterization tests first/);
      assert.match(text, /Keep the public interfaces and the existing tests unchanged, and do not fix bugs on the way/);
      assert.match(text, /Meet the refactoring goals listed above/);
      assert.match(text, /Refactoring goals \(the review confirms each one\):\n- The parsing code exists once\n- No public signature of the module changes/);
      assert.doesNotMatch(await prompt('developer', ['type: refactor'], 'Merge the parsers.'), /Meet the refactoring goals listed above/);
      // The analysis stage was skipped: no analysis in the history, the steps still render.
      for (const role of ['developer', 'reviewer', 'test-engineer']) assert.match(await prompt(role, ['type: refactor'], undefined, null), /characterization tests|Behaviour preserved/, role);
    });

    it('does not load the refactor-safely skill twice when the issue starts with /refactor-safely', async () => {
      for (const role of ['developer', 'reviewer']) {
        const text = await prompt(role, ['type: refactor'], '/refactor-safely\n\nMerge the parsers.', GOALS);
        assert.equal(text.split('load the skill `symphony:refactor-safely`').length - 1, 1, role);
        assert.match(text, /## Issue command: \/refactor-safely/, role);
      }
    });

    it('tells the refactor test engineer to check characterization tests on the base commit and on HEAD', async () => {
      const text = await prompt('test-engineer', ['type: refactor']);
      assert.match(text, /your tests are characterization tests/);
      assert.match(text, /green on the base commit[^]*and green on HEAD/);
      assert.match(text, /report the verdict `failed`/);
    });

    it('tells the refactor reviewer to check the interfaces and confirm each goal, and to list confirmed_goals', async () => {
      const text = await prompt('reviewer', ['type: refactor'], 'Merge the parsers.', GOALS);
      assert.match(text, /load the skill `symphony:refactor-safely` with the Skill tool and use its review checklist/);
      assert.match(text, /Public interfaces .* are unchanged; existing tests and their assertions are unchanged/);
      assert.match(text, /\*\*Refactoring goals:\*\* check each goal of the analysis/);
      assert.match(text, /`confirmed_goals`: the refactoring goals of the analysis that the change meets/);
      const none = await prompt('reviewer', ['type: refactor'], 'Merge the parsers.');
      assert.match(none, /Behaviour preserved \(refactoring\)/);
      assert.doesNotMatch(none, /confirmed_goals/);
    });

    it('tells the refactor analyst to fill refactoring_goals, and shows the field to untyped issues too', async () => {
      assert.match(await prompt('issue-analyst', ['type: refactor']), /`refactoring_goals`: for a refactoring only/);
      assert.match(await prompt('issue-analyst', ['type: refactor']), /find the public interfaces and the existing tests/);
      assert.match(await prompt('issue-analyst', []), /`refactoring_goals`: for a refactoring only/);
      assert.doesNotMatch(await prompt('issue-analyst', ['bug']), /refactoring_goals/);
    });

    it('gives the feature developer and reviewer the design and acceptance criteria steps', async () => {
      const developer = await prompt('developer', ['feature']);
      assert.match(developer, /This is a new feature: implement the design given above \(if there is one\) and the acceptance criteria\. Every acceptance criterion needs a test/);
      const reviewer = await prompt('reviewer', ['type: feature']);
      assert.match(reviewer, /\*\*Feature:\*\* the change implements the design given above \(if there is one\) and every acceptance criterion; every criterion has a meaningful test/);
    });

    it('keeps the profile steps apart: bugfix, other types and untyped issues see neither', async () => {
      for (const role of ['developer', 'test-engineer', 'reviewer', 'issue-analyst']) {
        for (const labels of [['bug'], ['documentation'], []]) {
          const text = await prompt(role, labels, 'Merge the parsers.', GOALS);
          for (const pattern of [...REFACTOR_ONLY.slice(0, 3), ...FEATURE_ONLY]) assert.doesNotMatch(text, pattern, `${role} ${labels.join() || 'untyped'}`);
        }
        assert.doesNotMatch(await prompt(role, ['feature']), REFACTOR_ONLY[0] as RegExp, role);
        assert.doesNotMatch(await prompt(role, ['type: refactor']), FEATURE_ONLY[0] as RegExp, role);
      }
      assert.doesNotMatch(await prompt('reviewer', ['bug'], undefined, GOALS), /confirmed_goals/);
      assert.doesNotMatch(await prompt('reviewer', ['feature'], undefined, GOALS), /confirmed_goals/);
    });
  });

  it('renders the read-only architect prompt: what to decide, the design fields and how to handle each answer', async () => {
    const agents = [{ name: 'symphony:explorer', description: 'Maps the code' }];
    const prompt = await render('architect', null, undefined, 'develop', agents, { result_required: true, round: 1 });
    assert.match(prompt, /Your role: architect/);
    assert.match(prompt, /You are \*\*read-only\*\*: do not edit files, commit, push or open a pull request/);
    assert.match(prompt, /`get_issue`, `add_comment` and `report_result`/);
    for (const field of ['verdict', 'summary', 'decision', 'options', 'components', 'interfaces', 'migrations', 'compatibility', 'follow_ups']) {
      assert.ok(prompt.includes(`\`${field}\``), `the prompt names ${field}`);
    }
    assert.match(prompt, /`ready` needs a `decision`, at least one `components` entry and at least one `interfaces` entry/);
    assert.match(prompt, /`blocked` \(a human must decide something first, with at least one entry in `blockers`\)/);
    assert.match(prompt, /`invalid_result`.*call `report_result` again/);
    assert.match(prompt, /`symphony:explorer`: Maps the code/);
    assert.doesNotMatch(prompt, /set_status/);
    assert.doesNotMatch(prompt, /open_pull_request/);
    assert.doesNotMatch(prompt, /Your role: developer/);
    assert.doesNotMatch(prompt, /Design of the architect/);
  });

  it('gives the developer the design of the architect, and nothing without one', async () => {
    const results = {
      latest: [],
      open_findings: [],
      failed_cases: [],
      test: null,
      analysis: null,
      design: {
        verdict: 'ready',
        summary: 'Extend the existing exporter.',
        decision: 'A new InvoiceExporter next to the others',
        components: ['InvoiceExporter: writes the CSV', 'ExportCommand: wires it up'],
        interfaces: ['exportInvoices(list): string'],
        migrations: ['add invoices.exported_at'],
        compatibility: 'Existing exports are unchanged',
        options: ['A new service', 'Extend the exporter'],
        work_packages: [],
        plan: ['Add InvoiceExporter in app/Exports/InvoiceExporter.php', 'Call it from app/Console/ExportCommand.php'],
        tests: ['Invoices export as CSV: tests/Feature/InvoiceExportTest.php checks the rows'],
        head_sha: null,
      },
    };
    const prompt = await render('developer', null, undefined, null, [], { result_required: true, round: 1, results });
    assert.match(prompt, /## Design of the architect/);
    assert.match(prompt, /Implement this design;.*`plan_deviations`/);
    assert.match(prompt, /Extend the existing exporter\./);
    assert.match(prompt, /Decision: A new InvoiceExporter next to the others/);
    assert.match(prompt, /Components:\n- InvoiceExporter: writes the CSV\n- ExportCommand: wires it up/);
    assert.match(prompt, /Interfaces:\n- exportInvoices\(list\): string/);
    assert.match(prompt, /Migrations:\n- add invoices\.exported_at/);
    assert.match(prompt, /Compatibility: Existing exports are unchanged/);
    assert.match(prompt, /Options considered:\n- A new service\n- Extend the exporter/);
    assert.match(prompt, /Plan:\n1\. Add InvoiceExporter in app\/Exports\/InvoiceExporter\.php\n2\. Call it from app\/Console\/ExportCommand\.php/);
    assert.match(prompt, /Tests \(one per acceptance criterion\):\n- Invoices export as CSV: tests\/Feature\/InvoiceExportTest\.php checks the rows/);
    // The reviewer checks the change against it, with the same facts but a reviewer's wording.
    const reviewer = await render('reviewer', null, undefined, null, [], { result_required: true, round: 1, results });
    assert.match(reviewer, /## Design of the architect/);
    assert.match(reviewer, /Check the change against this design;.*`plan_deviations`/);
    assert.doesNotMatch(reviewer, /Implement this design/);
    assert.match(reviewer, /Decision: A new InvoiceExporter next to the others/);
    assert.match(reviewer, /Interfaces:\n- exportInvoices\(list\): string/);
    assert.match(reviewer, /Plan:\n1\. Add InvoiceExporter/);
    // The other roles do not get the block.
    for (const role of ['test-engineer', 'issue-analyst']) {
      assert.doesNotMatch(await render(role, null, undefined, null, [], { result_required: true, round: 1, results }), /Design of the architect/, role);
    }
    // Nothing is rendered without a design (a skipped stage, an old issue, the empty results).
    assert.doesNotMatch(await render('developer'), /Design of the architect/);
    assert.doesNotMatch(await render('developer', null, undefined, null, [], { result_required: true, round: 1, results: { ...results, design: null } }), /Design of the architect/);
    // A design that left the optional fields out renders only what it has.
    const minimal = await render('developer', null, undefined, null, [], { result_required: true, round: 1, results: { ...results, design: { ...results.design, migrations: [], compatibility: null, options: [] } } });
    assert.doesNotMatch(minimal, /Migrations:|Compatibility:|Options considered:/);
    assert.match(minimal, /Interfaces:/);
  });

  it('renders the test engineer prompt: its paths, the test round, the result fields and how to handle each answer', async () => {
    const prompt = await render('test-engineer', 2, undefined, 'develop', [], afterFailedTest);
    assert.match(prompt, /Your role: test engineer/);
    assert.match(prompt, /files matching `tests\/\*\*`, `\*\*\/\*Test\.php`/);
    assert.match(prompt, /`report_result` refuses your result with `invalid_result`, naming the files/);
    assert.match(prompt, /This is test round 2\./);
    assert.match(prompt, /`get_issue`, `add_comment` and `report_result`/);
    assert.match(prompt, /pull request's branch \(`symphony\/issue-42` unless the pull request says otherwise\)/);
    assert.match(prompt, /git push origin symphony\/issue-42/);
    assert.match(prompt, /`passed`.*`failed`.*`blocked`/);
    assert.match(prompt, /`cases`.*`criterion`.*`test`.*`status`/);
    assert.match(prompt, /`invalid_result`.*undo the changes outside the test paths/);
    assert.match(prompt, /`check_failed`.*production code.*report `failed`/);
    assert.match(prompt, /`check_timeout`.*Call `report_result` once more/);
    assert.match(prompt, /`check_error`.*issue comment/);
    assert.match(prompt, /## Failed cases of your previous test run/);
    assert.match(prompt, /1\. A discount lowers the total — `tests\/TotalTest\.php::discount`/);
    assert.doesNotMatch(prompt, /set_status|mcp__tracker__/);
    assert.doesNotMatch(prompt, /Your role: developer|Your role: reviewer/);

    const first = await render('test-engineer', null, undefined, null, [], { result_required: true });
    assert.match(first, /This is test round 1\./);
    assert.match(first, /\(no test path is configured, so you cannot change any file\)/);
    assert.doesNotMatch(first, /Failed cases of your previous test run/);
    const agents = [{ name: 'symphony:laravel-test-engineer', description: 'Writes Pest tests.' }];
    assert.match(await render('test-engineer', null, undefined, null, agents), /- `symphony:laravel-test-engineer`: Writes Pest tests\./);
  });

  it('gives the developer the failed test cases, the test engineer\'s summary and its commands', async () => {
    const prompt = await render('developer', null, undefined, null, [], afterFailedTest);
    assert.match(prompt, /## Failed test cases of the latest test run/);
    assert.match(prompt, /they fail \(test round 1\)\. Fix the production code until they pass\. Do not weaken, skip or delete the tests/);
    assert.match(prompt, /1\. A discount lowers the total — `tests\/TotalTest\.php::discount`/);
    assert.match(prompt, /The test engineer's summary: The total ignores discounts\./);
    assert.match(prompt, /Commands that ran:\n- `php artisan test --filter=Total`/);
    assert.match(prompt, /address the open findings of the latest agent review and the failed test cases\./);
    assert.doesNotMatch(prompt, /Open findings of the latest agent review\n/);

    const without = await render('developer');
    assert.doesNotMatch(without, /Failed test cases/);
    assert.match(without, /address the open findings of the latest agent review\./);
    const both = await render('developer', null, undefined, null, [], { ...afterReview, results: { ...afterReview.results, ...afterFailedTest.results } });
    assert.ok(both.indexOf('## Open findings of the latest agent review') < both.indexOf('## Failed test cases of the latest test run'));
  });

  it('renders the developer prompt with short tool names and the check handling', async () => {
    const prompt = await render('developer');
    assert.match(prompt, /acme\/app#42\*\*: Add invoices/);
    assert.match(prompt, /Your role: developer/);
    assert.match(prompt, /`get_issue`/);
    assert.match(prompt, /`open_pull_request`/);
    assert.match(prompt, /Integrate the base branch before requesting review/);
    assert.match(prompt, /`report_result`/);
    assert.match(prompt, /verdict `done`/);
    assert.match(prompt, /verdict `blocked`/);
    assert.match(prompt, /`check_failed`.*Fix the problems.*call `report_result` again/);
    assert.match(prompt, /`check_timeout`.*Call `report_result` once more.*end your turn/);
    assert.match(prompt, /`check_error`.*issue comment.*end your turn/);
    assert.match(prompt, /end your turn/);
    assert.doesNotMatch(prompt, /set_status/);
    assert.doesNotMatch(prompt, /Open findings/);
    assert.match(prompt, /git push -u origin symphony\/issue-42/);
    assert.match(prompt, /Closes #42/);
    assert.doesNotMatch(prompt, /mcp__tracker__/);
    assert.doesNotMatch(prompt, /Your role: reviewer/);
    assert.doesNotMatch(prompt, /model: opus/);
    assert.doesNotMatch(prompt, /effort: high/);
  });

  it('renders the read-only reviewer prompt with the checklist and the result fields', async () => {
    const prompt = await render('reviewer', 2, undefined, null, [], { project_types: ['laravel'] });
    assert.match(prompt, /Your role: reviewer/);
    assert.match(prompt, /read-only/);
    assert.match(prompt, /git diff origin\/<base>\.\.\.HEAD/);
    for (const phrase of [
      'Correctness',
      'Pest',
      'Filament',
      'Livewire',
      'Authorization',
      'mass assignment',
      'N+1',
      'eager loading',
      'Migrations',
      'Secrets',
      'CI or lint configuration',
    ]) {
      assert.ok(prompt.includes(phrase), `reviewer prompt mentions ${phrase}`);
    }
    assert.match(prompt, /`report_result`/);
    assert.match(prompt, /`approved`.*`changes_needed`.*`blocked`/);
    assert.match(prompt, /`severity` \(`blocker`, `major`, `minor` or `nit`\)/);
    assert.match(prompt, /`check_timeout`.*The issue stays in "Agent review"/);
    assert.match(prompt, /Attempt 2/);
    assert.doesNotMatch(prompt, /set_status/);
    assert.doesNotMatch(prompt, /## Agent review \(round/);
    assert.doesNotMatch(prompt, /Count the earlier review comments/);
    assert.doesNotMatch(prompt, /N is 3 or more/);
    assert.doesNotMatch(prompt, /Findings of your previous review/);
    assert.doesNotMatch(prompt, /mcp__tracker__/);
    assert.doesNotMatch(prompt, /Your role: developer/);
  });

  it('lists the open findings of the latest review for the developer and the reviewer', async () => {
    const developer = await render('developer', null, undefined, null, [], afterReview);
    assert.match(developer, /## Open findings of the latest agent review/);
    assert.match(developer, /1\. \[major\] app\/Invoice\.php:12 — Total ignores discounts Expected fix: Subtract the discount/);
    assert.match(developer, /2\. \[minor\] README\.md — Typo/);
    assert.doesNotMatch(developer, /README\.md:/);

    const reviewer = await render('reviewer', null, undefined, null, [], afterReview);
    assert.match(reviewer, /## Findings of your previous review/);
    assert.match(reviewer, /This is review round 2\./);
    assert.match(reviewer, /\[major\] app\/Invoice\.php:12 — Total ignores discounts/);
  });

  it('falls back to the single-agent prompt for the default role', async () => {
    const prompt = await render('default');
    assert.match(prompt, /## How to work/);
    assert.match(prompt, /Move the issue to "In review" with `mcp__tracker__set_status`/);
    assert.doesNotMatch(prompt, /Your role:/);
  });

  it('renders issue type and complexity from labels, filtering them from the issue context', async () => {
    const testIssue = makeIssue({
      ...issue,
      labels: ['feature', 'type: bugfix', 'complexity: M', 'model: opus', 'effort: high'],
    });
    const { definition } = await loadWorkflowFile(shipped);
    const template = compilePrompt(definition.promptTemplate, definition.partials);
    const subject = { ...testIssue, native_ref: { ...testIssue.native_ref, base_branch: null } };
    const rendered = await renderPrompt(template, { issue: issueTemplateValue(subject, commandSkills([toolbox])), attempt: null, role: 'developer', agents: [] });

    // Type and complexity are available in the template
    const value = issueTemplateValue(subject, commandSkills([toolbox]));
    assert.equal(value.type, 'bugfix');
    assert.equal(value.complexity, 'M');

    // Model and Effort are filtered from without_agent_labels, but type/complexity/needs-human should be too
    assert.doesNotMatch(rendered, /model: opus/);
    assert.doesNotMatch(rendered, /effort: high/);
    assert.doesNotMatch(rendered, /type: bugfix/);
    assert.doesNotMatch(rendered, /complexity: M/);

    // Feature label shows up (it's not filtered)
    assert.match(rendered, /feature/);
  });

  it('handles issues without type or complexity labels', async () => {
    const testIssue = makeIssue({
      ...issue,
      labels: ['design', 'model: opus'],
    });
    const subject = { ...testIssue, native_ref: { ...testIssue.native_ref, base_branch: null } };
    const value = issueTemplateValue(subject, commandSkills([toolbox]));
    assert.equal(value.type, null);
    assert.equal(value.complexity, null);
    assert.equal(value.profile, null);
  });

  it('exposes the profile of the issue type as issue.profile, so role sections can branch on it', async () => {
    const config = resolveConfig(
      {
        tracker: { kind: 'github', active_states: ['Ready'], terminal_states: ['Done'] },
        roles: { developer: { states: ['Ready'] } },
        pipeline: { profiles: { bugfix: { skip: ['developer'] }, default: {} } },
      },
      { workflowPath: shipped, env: {}, trackerDefaults },
    );
    const profileOf = (labels: string[]) => issueTemplateValue(makeIssue({ ...issue, labels }), new Map(), config.pipeline).profile;
    assert.equal(profileOf(['bug']), 'bugfix');
    assert.equal(profileOf(['type: refactor']), 'default');
    assert.equal(profileOf([]), 'default');

    const template = compilePrompt('{% if issue.profile == "bugfix" %}bugfix flow{% else %}standard flow ({{ issue.profile }}){% endif %}');
    const render = (labels: string[]) => renderPrompt(template, { issue: issueTemplateValue(makeIssue({ ...issue, labels }), new Map(), config.pipeline) });
    assert.equal(await render(['bug']), 'bugfix flow');
    assert.equal(await render(['feature']), 'standard flow (default)');
    // Without profiles in the config the variable still exists and is null.
    assert.equal(issueTemplateValue(makeIssue({ ...issue, labels: ['bug'] }), new Map(), resolveConfig({ tracker: { kind: 'github', active_states: ['Ready'], terminal_states: ['Done'] } }, { workflowPath: shipped, env: {}, trackerDefaults }).pipeline).profile, null);
  });
});

describe('shipped WORKFLOW.md issue commands', () => {
  it('serves /refactoring issues with the auditor and everything else as before', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const config = resolveConfig(definition.config, {
      workflowPath: shipped,
      env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' },
      trackerDefaults,
    });
    const roleOf = (state: string, description: string | null) => roleFor({ state, description }, config.roles);
    for (const state of ['Ready', 'In progress']) {
      assert.equal(roleName(roleOf(state, '/refactoring')), 'auditor');
      assert.equal(roleName(roleOf(state, '/refactoring app/Filament')), 'auditor');
      assert.equal(roleName(roleOf(state, '/refactor-safely\n\nBlocked by #3')), serving(state));
      assert.equal(roleName(roleOf(state, 'Add a /refactoring page')), serving(state));
    }
    assert.equal(roleName(roleOf('Agent review', '/refactoring')), 'reviewer');

    const auditor = roleOf('Ready', '/refactoring');
    assert.deepEqual(
      [auditor?.readOnly, auditor?.runChecks, auditor?.maxSubIssues, auditor?.maxTurns],
      [true, false, 20, 2],
    );
    assert.deepEqual(auditor?.mayMoveTo, ['In progress', 'In review', 'Blocked']);
    assert.equal(auditor?.claude.model, 'fable');
    assert.equal(roleOf('Ready', null)?.runChecks, true);
    assert.equal(roleOf('Ready', null)?.maxSubIssues, null);
    assert.equal(config.tracker.provider.sub_issue_status, 'Backlog');
  });

  it('renders the read-only auditor prompt with the skill instruction', async () => {
    const prompt = await render('auditor', null, '/refactoring app/Filament\n\nPlease look at the panel.');
    assert.match(prompt, /Your role: auditor/);
    assert.match(prompt, /## Issue command: \/refactoring/);
    assert.match(prompt, /load the skill `symphony:refactoring` with the Skill tool and pass it the argument/);
    assert.match(prompt, /argument `app\/Filament`/);
    assert.match(prompt, /read-only/);
    assert.match(prompt, /`create_sub_issue`/);
    assert.match(prompt, /`set_status\("In review"\)`\. No entry checks run for this role/);
    assert.doesNotMatch(prompt, /open_pull_request/);
    assert.doesNotMatch(prompt, /Your role: (developer|reviewer)/);
  });

  it('leaves out the argument phrase for a command without arguments', async () => {
    const prompt = await render('auditor', null, '/refactoring');
    assert.match(prompt, /load the skill `symphony:refactoring` with the Skill tool, then follow it/);
    assert.doesNotMatch(prompt, /and the argument/);
  });

  it('tells a developer or reviewer of a /refactor-safely issue to load that skill first', async () => {
    for (const role of ['developer', 'reviewer']) {
      const prompt = await render(role, null, '/refactor-safely\n\nBlocked by #3');
      assert.match(prompt, /## Issue command: \/refactor-safely/, role);
      assert.match(prompt, /load the skill `symphony:refactor-safely`/, role);
      assert.match(prompt, new RegExp(`Your role: ${role}`), role);
    }
  });

  it('serves /auto-code issues with the autopilot, which waits for its waves', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const config = resolveConfig(definition.config, {
      workflowPath: shipped,
      env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' },
      trackerDefaults,
    });
    const roleOf = (state: string, description: string | null) => roleFor({ state, description }, config.roles);
    for (const state of ['Ready', 'In progress']) {
      assert.equal(roleName(roleOf(state, '/auto-code docs/index.md wave=3')), 'autopilot');
    }
    assert.equal(roleName(roleOf('Agent review', '/auto-code')), 'reviewer');
    const autopilot = roleOf('Ready', '/auto-code');
    assert.deepEqual(
      [autopilot?.readOnly, autopilot?.runChecks, autopilot?.maxSubIssues, autopilot?.subIssueStatus, autopilot?.waitForSubIssues, autopilot?.maxTurns],
      [true, false, 5, 'Ready', true, 2],
    );
    assert.deepEqual(autopilot?.mayMoveTo, ['In progress', 'In review', 'Blocked']);
    assert.equal(roleOf('Ready', null)?.waitForSubIssues, false);
  });

  it('serves /concept issues with the analyst, which files into the backlog', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const config = resolveConfig(definition.config, {
      workflowPath: shipped,
      env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' },
      trackerDefaults,
    });
    const roleOf = (state: string, description: string | null) => roleFor({ state, description }, config.roles);
    for (const state of ['Ready', 'In progress']) {
      assert.equal(roleName(roleOf(state, '/concept docs/index.md')), 'analyst');
      assert.equal(roleName(roleOf(state, 'Write a /concept page')), serving(state));
    }
    assert.equal(roleName(roleOf('Agent review', '/concept docs/index.md')), 'reviewer');
    const analyst = roleOf('Ready', '/concept docs/index.md');
    assert.deepEqual(
      [analyst?.readOnly, analyst?.runChecks, analyst?.maxSubIssues, analyst?.subIssueStatus, analyst?.waitForSubIssues, analyst?.maxTurns],
      [true, false, 60, null, false, 3],
    );
    assert.deepEqual(analyst?.mayMoveTo, ['In progress', 'In review', 'Blocked']);
    assert.equal(config.tracker.provider.sub_issue_status, 'Backlog');
  });

  it('renders the read-only analyst prompt with the skill instruction', async () => {
    const prompt = await render('analyst', null, '/concept docs/index.md issue-models=auto');
    assert.match(prompt, /Your role: analyst/);
    assert.match(prompt, /## Issue command: \/concept/);
    assert.match(prompt, /load the skill `symphony:concept` with the Skill tool and pass it the argument/);
    assert.match(prompt, /argument `docs\/index\.md issue-models=auto`/);
    assert.match(prompt, /read-only/);
    assert.match(prompt, /`create_sub_issue`/);
    assert.match(prompt, /`parent`.*`blocked_by`/);
    assert.match(prompt, /`set_status\("In review"\)`\. No entry checks run for this role/);
    assert.doesNotMatch(prompt, /open_pull_request/);
    assert.doesNotMatch(prompt, /Your role: (developer|reviewer|auditor|autopilot|planner)/);
  });

  it('serves /plan issues with the planner, which files into the backlog', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const config = resolveConfig(definition.config, {
      workflowPath: shipped,
      env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' },
      trackerDefaults,
    });
    const roleOf = (state: string, description: string | null) => roleFor({ state, description }, config.roles);
    for (const state of ['Ready', 'In progress']) {
      assert.equal(roleName(roleOf(state, '/plan docs/todo.md')), 'planner');
      assert.equal(roleName(roleOf(state, '/plan\n- Export invoices as CSV\n- Dark mode')), 'planner');
      assert.equal(roleName(roleOf(state, 'Write a /plan page')), serving(state));
    }
    assert.equal(roleName(roleOf('Agent review', '/plan docs/todo.md')), 'reviewer');
    const planner = roleOf('Ready', '/plan');
    assert.deepEqual(
      [planner?.readOnly, planner?.runChecks, planner?.maxSubIssues, planner?.subIssueStatus, planner?.waitForSubIssues, planner?.maxTurns],
      [true, false, 30, null, false, 3],
    );
    assert.deepEqual(planner?.mayMoveTo, ['In progress', 'In review', 'Blocked']);
    assert.equal(config.tracker.provider.sub_issue_status, 'Backlog');
  });

  it('renders the read-only planner prompt with the skill instruction', async () => {
    const prompt = await render('planner', null, '/plan docs/todo.md issue-models=auto');
    assert.match(prompt, /Your role: planner/);
    assert.match(prompt, /## Issue command: \/plan/);
    assert.match(prompt, /load the skill `symphony:plan` with the Skill tool and pass it the argument/);
    assert.match(prompt, /argument `docs\/todo\.md issue-models=auto`/);
    assert.match(prompt, /read-only/);
    assert.match(prompt, /`create_sub_issue`.*`blocked_by`/);
    assert.match(prompt, /`set_status\("In review"\)`\. No entry checks run for this role/);
    assert.doesNotMatch(prompt, /open_pull_request/);
    assert.doesNotMatch(prompt, /Your role: (developer|reviewer|auditor|autopilot|analyst)/);
  });

  it('ends In review with the named final gate: ci and prod-smoke through checks/repo.sh, within the turn timeout', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const config = resolveConfig(definition.config, {
      workflowPath: shipped,
      env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't', SYMPHONY_CHECKS_REPORT_STATUS: 'true', SYMPHONY_PUBLIC_URL: 'http://symphony.lan/' },
      trackerDefaults,
    });
    const gate = config.checks.onEnter.get('in review') ?? [];
    assert.deepEqual(gate.map((check) => [check.name, check.timeoutMs]), [['ci', 1_200_000], ['prod-smoke', 1_800_000]]);
    assert.match(gate[0]?.command ?? '', /checks\/repo\.sh" ci -- bash "\$SYMPHONY_WORKFLOW_DIR\/checks\/laravel\.sh" --full$/);
    assert.match(gate[1]?.command ?? '', /checks\/repo\.sh" --lock prod-smoke$/);
    assert.ok(maxColumnCheckMs(config.checks) < config.claude.turnTimeoutMs);
    assert.equal(config.checks.reportStatus, true);
    assert.equal(config.server.publicUrl, 'http://symphony.lan');
    assert.match(config.hooks.beforeRemove ?? '', /hooks\/laravel-db-drop\.sh/);
  });

  it('turns base_branch and auto_merge on through the environment only', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const providerOf = (env: Record<string, string>) =>
      resolveConfig(definition.config, {
        workflowPath: shipped,
        env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't', ...env },
        trackerDefaults,
      }).tracker;
    const settingsOf = (env: Record<string, string>) => {
      const tracker = providerOf(env);
      return parseSettings(tracker.provider, { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't', ...env });
    };
    const off = settingsOf({});
    assert.deepEqual([off.settings?.baseBranch, off.settings?.autoMerge], [null, null]);
    const env = { SYMPHONY_BASE_BRANCH: 'develop', SYMPHONY_AUTO_MERGE: 'true' };
    const on = settingsOf(env);
    assert.equal(on.settings?.baseBranch, 'develop');
    assert.deepEqual(on.settings?.autoMerge, {
      onEnter: 'In review',
      doneState: 'Done',
      onConflict: 'In progress',
      method: 'SQUASH',
      optOutLabel: 'manual-merge',
      onChecksFailed: 'In progress',
      checks: { wait: true, timeoutMs: 3_600_000, ignore: [], maxSendBacks: 2 },
    });
    // The merge gate's ignore list and waiting come from the environment too.
    const tuned = settingsOf({ ...env, SYMPHONY_MERGE_IGNORE_CHECKS: 'acme/app:ci,acme/app:prod-smoke', SYMPHONY_MERGE_WAIT_FOR_CHECKS: 'false' });
    assert.deepEqual(tuned.settings?.autoMerge?.checks, { wait: false, timeoutMs: 3_600_000, ignore: ['acme/app:ci', 'acme/app:prod-smoke'], maxSendBacks: 2 });
    const tracker = providerOf(env);
    assert.doesNotThrow(() =>
      githubProjectFactory.create({
        provider: tracker.provider,
        activeStates: tracker.activeStates,
        terminalStates: tracker.terminalStates,
        env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't', ...env },
        logger: Logger.silent(),
      }),
    );
  });

  it('renders the read-only autopilot prompt that keeps the epic in its column', async () => {
    const prompt = await render('autopilot', null, '/auto-code docs/index.md wave=3', 'develop');
    assert.match(prompt, /Your role: autopilot/);
    assert.match(prompt, /load the skill `symphony:auto-code` with the Skill tool and pass it the argument/);
    assert.match(prompt, /argument `docs\/index\.md wave=3`/);
    assert.match(prompt, /implement the sub-issues against `develop`/);
    assert.match(prompt, /`create_sub_issue` and `open_pull_request`/);
    assert.match(prompt, /End your turn \*\*without changing the status\*\*/);
    assert.doesNotMatch(prompt, /Your role: (developer|reviewer|auditor|planner)/);
  });

  it('branches from and integrates the base branch when one is configured', async () => {
    const developer = await render('developer', null, undefined, 'develop');
    assert.match(developer, /create it from `origin\/develop` if it does not exist yet/);
    assert.match(developer, /the pull request's base, else `develop`\)/);
    const reviewer = await render('reviewer', null, undefined, 'develop');
    assert.match(reviewer, /the pull request's base branch, else `develop`\)/);
    assert.match(reviewer, /the result contains `auto_merge`/);
    const plain = await render('developer');
    assert.match(plain, /create it from the default branch if it does not exist yet/);
    assert.doesNotMatch(plain, /origin\/develop/);
  });

  it('lists the subagents of a role only when the session has some', async () => {
    const agents = [{ name: 'symphony:laravel-code-reviewer', description: 'Reviews a diff.' }];
    for (const role of ['developer', 'reviewer', 'auditor', 'autopilot', 'analyst', 'planner']) {
      const without = await render(role);
      assert.doesNotMatch(without, /Subagents you can start/, role);
      const prompt = await render(role, null, undefined, null, agents);
      assert.match(prompt, /Subagents you can start with the Agent tool/, role);
      assert.match(prompt, /- `symphony:laravel-code-reviewer`: Reviews a diff\./, role);
    }
    assert.match(await render('developer', null, undefined, null, agents), /before you report the result/);
  });

  it('tells every role with agents when to delegate and what a brief contains', async () => {
    const full = ['explorer', 'laravel-architect', 'laravel-database-engineer', 'laravel-filament-developer', 'laravel-test-engineer', 'laravel-code-reviewer'].map((name) => ({
      name: `symphony:${name}`,
      description: `The ${name}.`,
    }));
    const triggers: Record<string, RegExp[]> = {
      developer: [
        /Before you read more than about ten files[^\n]*`symphony:explorer`/,
        /not for a change you can finish in a handful of tool calls/,
        /`symphony:laravel-architect`[^\n]*not when a design is given below/,
        /specialist \(`symphony:laravel-database-engineer`, `symphony:laravel-filament-developer`, `symphony:laravel-test-engineer`\); not for parts coupled/,
        /`symphony:laravel-code-reviewer`[^\n]*before you report the result; not for a diff of a few lines/,
      ],
      architect: [/start 2–3 `symphony:explorer` calls in one message, one per code area/, /then read those files yourself\. Not for a change confined/],
      analyst: [/`symphony:explorer`[^\n]*not for a part whose files a few searches find/, /`symphony:laravel-architect`[^\n]*not for small or documentation-only parts/],
      planner: [/`symphony:explorer`[^\n]*not for a part whose files a few searches find/, /`symphony:laravel-architect`[^\n]*not for small or documentation-only parts/],
      autopilot: [/`symphony:explorer`[^\n]*not for a part whose files a few searches find/, /`symphony:laravel-architect`[^\n]*not for small or documentation-only parts/],
      auditor: [/`symphony:explorer`[^\n]*not for a repository a few searches survey/, /`symphony:laravel-code-reviewer`[^\n]*not for pre-existing style/, /`symphony:laravel-architect`[^\n]*not for a local finding/],
    };
    for (const [role, patterns] of Object.entries(triggers)) {
      const prompt = await render(role, null, undefined, null, full);
      assert.match(prompt, /Delegate where a trigger applies/, role);
      assert.match(prompt, /never for what a few tool calls finish/, role);
      for (const rule of ['acceptance criteria', 'absolute workspace path', 'boundaries', '`file:line`', 'file lists instead of file contents', '1,000–2,000 tokens', 'candidates', 'discard any claim without `file:line`']) {
        assert.ok(prompt.includes(rule), `${role}: ${rule}`);
      }
      assert.match(prompt, /When to delegate:/, role);
      for (const pattern of patterns) assert.match(prompt, pattern, role);
      assert.doesNotMatch(prompt, /optional|costs tokens/i, role);
    }
    // A bullet renders only for an allowed agent.
    const onlyReviewer = await render('developer', null, undefined, null, [full[5]!]);
    assert.doesNotMatch(onlyReviewer, /symphony:explorer|symphony:laravel-architect/);
    assert.match(onlyReviewer, /before you report the result/);
  });

  it('renders no agent intro for the roles without subagents in a Laravel workspace', async () => {
    for (const role of ['issue-analyst', 'test-engineer', 'reviewer', 'security-auditor']) {
      assert.doesNotMatch(await render(role), /Subagents you can start/, role);
    }
  });

  it('resolves no subagent for the issue analyst, so a Laravel workspace renders no intro', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const config = resolveConfig(definition.config, {
      workflowPath: shipped,
      env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' },
      trackerDefaults,
    });
    const all = pluginAgents([toolbox]);
    assert.equal(all.filter((agent) => agent.name.startsWith('laravel-')).length, 5);
    for (const name of ['issue-analyst']) {
      const role = (config.roles ?? []).find((entry) => entry.name === name) ?? null;
      assert.deepEqual(role?.agents, [], name);
      const { allowed, denied } = sessionAgents(all, role, ['laravel-'], ['laravel-']);
      const listed = allowed.map((agent) => ({ name: agent.qualified, description: agent.description }));
      assert.equal(allowed.length, 0, name);
      assert.ok(denied.some((agent) => agent.name === 'laravel-code-reviewer'), name);
      const prompt = await render(name, null, undefined, null, listed);
      assert.doesNotMatch(prompt, /Subagents you can start/, name);
    }
    // The roles that keep their subagents are untouched.
    for (const name of ['architect', 'developer', 'auditor']) {
      assert.ok((config.roles ?? []).find((entry) => entry.name === name)?.agents?.length, name);
    }
  });

  it('lets the shipped test engineer start only the test-designer, in a Laravel workspace and without', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const config = resolveConfig(definition.config, {
      workflowPath: shipped,
      env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' },
      trackerDefaults,
    });
    const all = pluginAgents([toolbox]);
    const role = (config.roles ?? []).find((entry) => entry.name === 'test-engineer') ?? null;
    for (const prefixes of [['laravel-'], []]) {
      const { allowed, denied } = sessionAgents(all, role, prefixes, prefixes);
      assert.deepEqual(allowed.map((agent) => agent.name), ['test-designer'], prefixes.join());
      assert.equal(denied.filter((agent) => agent.name.startsWith('laravel-')).length, 5, prefixes.join());
    }
  });

  it('lets the shipped reviewer start exactly the three lens personas, read-only, in a Laravel workspace and without', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const config = resolveConfig(definition.config, {
      workflowPath: shipped,
      env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' },
      trackerDefaults,
    });
    const all = pluginAgents([toolbox]);
    const role = (config.roles ?? []).find((entry) => entry.name === 'reviewer') ?? null;
    assert.deepEqual(role?.agents, ['convention-lens', 'bug-lens', 'finding-verifier']);
    for (const prefixes of [['laravel-'], []]) {
      const { allowed, denied } = sessionAgents(all, role, prefixes, prefixes);
      assert.deepEqual(allowed.map((agent) => agent.name).sort(), ['bug-lens', 'convention-lens', 'finding-verifier'], prefixes.join());
      assert.ok(allowed.every((agent) => agent.readOnly), prefixes.join());
      assert.equal(denied.filter((agent) => agent.name.startsWith('laravel-')).length, 5, prefixes.join());
    }
  });

  describe('lens personas', () => {
    const body = (name: string) => fs.readFileSync(path.join(toolbox, 'agents', `${name}.md`), 'utf8');
    const description = (name: string) => /^description: (.+)$/m.exec(body(name))?.[1] ?? '';

    it('gives each a trigger, an exclusion and no framework name in the description', () => {
      for (const name of ['convention-lens', 'bug-lens', 'finding-verifier']) {
        assert.match(description(name), /^Use /, name);
        assert.match(description(name), /Not for /, name);
        assert.doesNotMatch(description(name), /laravel/i, name);
        assert.match(body(name), /^disallowedTools: Edit, Write, NotebookEdit$/m, name);
      }
    });

    it('convention-lens reports only violations whose rule it can quote', () => {
      const text = body('convention-lens');
      for (const source of ['CLAUDE.md', 'AGENTS.md', '.ai/rules']) assert.ok(text.includes(source), source);
      assert.match(text, /quote/);
    });

    it('bug-lens names its two modes', () => {
      const text = body('bug-lens');
      assert.match(text, /Diff alone/);
      assert.match(text, /With context/);
    });

    it('finding-verifier takes one candidate, tries to refute it, rejects when in doubt and cites file:line', () => {
      const text = body('finding-verifier');
      assert.match(text, /exactly one candidate/);
      assert.match(text, /refute/);
      assert.match(text, /When in doubt, refute/);
      assert.match(text, /file:line/);
    });
  });

  it('lets the shipped security auditor start exactly the inventory and the judge, read-only, and validates', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const config = resolveConfig(definition.config, {
      workflowPath: shipped,
      env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' },
      trackerDefaults,
    });
    const all = pluginAgents([toolbox]);
    const role = (config.roles ?? []).find((entry) => entry.name === 'security-auditor') ?? null;
    assert.deepEqual(role?.agents, ['security-inventory', 'refutation-judge']);
    for (const prefixes of [['laravel-'], []]) {
      const { allowed, denied } = sessionAgents(all, role, prefixes, prefixes);
      assert.deepEqual(allowed.map((agent) => agent.name).sort(), ['refutation-judge', 'security-inventory'], prefixes.join());
      assert.ok(allowed.every((agent) => agent.readOnly), prefixes.join());
      assert.equal(denied.filter((agent) => agent.name.startsWith('laravel-')).length, 5, prefixes.join());
    }
    const errors = validateDispatch({ config } as unknown as EffectiveWorkflow, null, { GITHUB_TOKEN: 't' } as NodeJS.ProcessEnv).filter((error) => error.includes('.agents'));
    assert.deepEqual(errors, []);
  });

  describe('security panel at L/XL', () => {
    const both = ['security-inventory', 'refutation-judge'].map((name) => ({ name: `symphony:${name}`, description: `The ${name}.` }));
    const renderWith = async (labels: string[], agents = both, extra: Record<string, unknown> = {}) => {
      const { definition } = await loadWorkflowFile(shipped);
      const template = compilePrompt(definition.promptTemplate, definition.partials);
      const subject = { ...issue, labels, native_ref: { ...issue.native_ref, base_branch: 'develop' } };
      return renderPrompt(template, { issue: issueTemplateValue(subject, commandSkills([toolbox])), attempt: null, role: 'security-auditor', agents, round: 1, ...extra });
    };

    for (const label of ['complexity: l', 'complexity: xl']) {
      it(`names the inventory, three judges per candidate and the votes at ${label}`, async () => {
        const text = await renderWith(['feature', label]);
        assert.match(text, /Subagents you can start/);
        assert.match(text, /\`symphony:security-inventory\`/);
        assert.match(text, /three \`symphony:refutation-judge\` calls in one message/);
        for (const lens of ['reachability', 'impact', 'defenses']) assert.match(text, new RegExp(lens));
        assert.match(text, /false positive/);
        assert.match(text, /verification\.votes/);
        assert.match(text, /Do not run code/);
        assert.match(text, /go into \`refuted\`/);
        assert.match(text, /a finding stays only when no lens refutes it/);
        assert.doesNotMatch(text, /canAccess|\{!! !!\}\` output/);
      });
    }

    it('adds the Laravel lenses only in a Laravel workspace', async () => {
      const text = await renderWith(['feature', 'complexity: l'], both, { project_types: ['laravel'] });
      for (const hint of [/mass assignment/, /policies and gates/, /canAccess/, /authorize\*/, /whereRaw/, /\{!! !!\}/]) assert.match(text, hint);
      const plain = await renderWith(['feature', 'complexity: l'], both, { project_types: [] });
      assert.doesNotMatch(plain, /In this Laravel workspace/);
    });

    it('renders nothing new at S, M and without a complexity: identical to an auditor without agents', async () => {
      for (const labels of [['feature', 'complexity: s'], ['feature', 'complexity: m'], ['feature']]) {
        const text = await renderWith(labels);
        assert.equal(text, await renderWith(labels, []), labels.join());
        assert.doesNotMatch(text, /security-inventory|refutation-judge|Subagents you can start|Panel review/, labels.join());
      }
    });

    it('renders no panel without the judge and keeps the E3-4 sentence', async () => {
      const text = await renderWith(['feature', 'complexity: xl'], both.slice(0, 1));
      assert.doesNotMatch(text, /Panel review|security-inventory|Subagents you can start/);
      assert.match(text, /needs \`verification: \{status: "confirmed", evidence\}\`/);
    });
  });

  describe('lens review at L/XL', () => {
    const three = ['convention-lens', 'bug-lens', 'finding-verifier'].map((name) => ({ name: `symphony:${name}`, description: `The ${name}.` }));
    const renderWith = async (labels: string[], agents = three, subIssues: unknown[] = [], extra: Record<string, unknown> = {}) => {
      const { definition } = await loadWorkflowFile(shipped);
      const template = compilePrompt(definition.promptTemplate, definition.partials);
      const subject = { ...issue, labels, native_ref: { ...issue.native_ref, base_branch: 'develop', sub_issues: subIssues } };
      return renderPrompt(template, { issue: issueTemplateValue(subject, commandSkills([toolbox])), attempt: null, role: 'reviewer', agents, round: 1, ...extra });
    };

    for (const label of ['complexity: l', 'complexity: xl']) {
      it(`runs the lenses in one message and one verifier per candidate at ${label}`, async () => {
        const text = await renderWith(['feature', label]);
        assert.match(text, /Subagents you can start/);
        assert.match(text, /\`symphony:convention-lens\`/);
        assert.match(text, /\`symphony:bug-lens\`, twice/);
        assert.match(text, /diff alone/);
        assert.match(text, /surrounding code/);
        assert.match(text, /in one message/);
        assert.match(text, /one \`symphony:finding-verifier\` call per candidate/);
        assert.match(text, /rejects when in doubt/);
        assert.match(text, /Only confirmed, diff-introduced findings within the issue's scope enter \`findings\`/);
        assert.match(text, /pre-existing/);
        assert.match(text, /linter/);
      });
    }

    it('renders nothing at S, M and without a complexity: identical to a reviewer without agents', async () => {
      for (const labels of [['feature', 'complexity: s'], ['feature', 'complexity: m'], ['feature']]) {
        const text = await renderWith(labels);
        assert.equal(text, await renderWith(labels, []), labels.join());
        assert.doesNotMatch(text, /convention-lens|bug-lens|finding-verifier|Subagents you can start/, labels.join());
      }
    });

    it('adds no lens block and no intro to the integration review; other agents keep the intro', async () => {
      const split = [{ identifier: 'acme/app#43', title: 'CSV writer', state: 'CLOSED', state_reason: 'COMPLETED' }];
      const text = await renderWith(['feature', 'complexity: xl'], three, split);
      assert.match(text, /integration review/);
      assert.doesNotMatch(text, /convention-lens|bug-lens|finding-verifier|Subagents you can start/);
      const other = [...three, { name: 'symphony:laravel-code-reviewer', description: 'Reviews a diff.' }];
      assert.match(await renderWith(['feature', 'complexity: xl'], other, split), /Subagents you can start/);
    });

    it('names only the allowed personas and needs the verifier', async () => {
      const partial = await renderWith(['feature', 'complexity: xl'], three.filter((agent) => agent.name !== 'symphony:convention-lens'));
      assert.match(partial, /symphony:bug-lens/);
      assert.match(partial, /symphony:finding-verifier/);
      assert.doesNotMatch(partial, /convention-lens/);
      const noVerifier = await renderWith(['feature', 'complexity: xl'], three.slice(0, 2));
      assert.doesNotMatch(noVerifier, /convention-lens|bug-lens|Subagents you can start|Lens review/);
    });
  });

  describe('test designer at L/XL', () => {
    const designer = [{ name: 'symphony:test-designer', description: 'Writes tests from the criteria.' }];
    const renderWith = (labels: string[], agents = designer, history: Record<string, unknown> = {}) => {
      return (async () => {
        const { definition } = await loadWorkflowFile(shipped);
        const template = compilePrompt(definition.promptTemplate, definition.partials);
        const subject = { ...issue, labels, native_ref: { ...issue.native_ref, base_branch: 'develop' } };
        return renderPrompt(template, { issue: issueTemplateValue(subject, commandSkills([toolbox])), attempt: null, role: 'test-engineer', agents, round: 1, test_paths: ['tests/**'], ...history });
      })();
    };
    const withDesign = { results: { latest: [], open_findings: [], failed_cases: [], design: { verdict: 'ready', summary: 's', decision: '', compatibility: '', interfaces: ['exportInvoices(list): string'], components: [], migrations: [], options: [], plan: [], tests: [], work_packages: [], head_sha: null } } };

    for (const label of ['complexity: l', 'complexity: xl']) {
      it(`delegates to the designer at ${label} with the information boundary`, async () => {
        const text = await renderWith(['feature', label], designer, withDesign);
        assert.match(text, /`subagent_type`: `symphony:test-designer`/);
        assert.match(text, /one call per group of acceptance criteria/);
        assert.match(text, /one call at a time/);
        assert.match(text, /no diff, no changed files/);
        assert.match(text, /git merge-base HEAD origin\/develop/);
        assert.match(text, /absolute workspace path \(run `pwd`\)/);
        assert.match(text, /RED/);
        assert.match(text, /GREEN/);
        assert.match(text, /- exportInvoices\(list\): string/);
        assert.match(text, /its writes fall under the test paths and `report_result` checks them as yours/);
        assert.match(text, /`tests\/\*\*`/);
      });
    }

    it('describes the public entry points itself when no design carries interfaces', async () => {
      const text = await renderWith(['feature', 'complexity: l']);
      assert.match(text, /There is no design with interfaces/);
      assert.match(text, /no diff, no changed files/);
    });

    it('leaves the prompt unchanged at S, M and without a complexity label', async () => {
      for (const labels of [['feature', 'complexity: m'], ['feature', 'complexity: s'], ['feature']]) {
        const withDesigner = await renderWith(labels);
        assert.equal(withDesigner, await renderWith(labels, []), labels.join());
        assert.doesNotMatch(withDesigner, /no diff, no changed files|test-designer|Subagents you can start/, labels.join());
      }
    });

    it('adds no designer block to refactorings, nor without the designer; other agents keep the intro', async () => {
      assert.doesNotMatch(await renderWith(['type: refactor', 'complexity: l']), /no diff, no changed files/);
      assert.doesNotMatch(await renderWith(['feature', 'complexity: l'], []), /no diff, no changed files/);
      const other = [{ name: 'symphony:laravel-code-reviewer', description: 'Reviews a diff.' }];
      const text = await renderWith(['feature', 'complexity: m'], other);
      assert.match(text, /Subagents you can start with the Agent tool/);
      assert.doesNotMatch(text, /no diff, no changed files/);
    });
  });

  it('keeps the agent intro scaffold in the four role files but drops the lines that named a persona', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const agents = [{ name: 'symphony:laravel-code-reviewer', description: 'Reviews a diff.' }];
    const expectedBlocks: Record<string, number> = { 'issue-analyst': 1, 'test-engineer': 1, reviewer: 2, 'security-auditor': 1 };
    for (const [role, blocks] of Object.entries(expectedBlocks)) {
      const source = definition.partials[`roles/${role}.md`] ?? '';
      assert.equal(source.match(/\{% if agents\.size > 0 %\}/g)?.length, blocks, role);
      assert.equal(source.match(/\{\{ agent_intro \}\}/g)?.length, blocks, role);
      assert.doesNotMatch(source, /Use the architect to check the feasibility/, role);
      assert.doesNotMatch(source, /Good use: the test engineer subagent/, role);
      assert.doesNotMatch(source, /Use a reviewer subagent only for a second pass/, role);
      assert.doesNotMatch(source, /laravel-(architect|test-engineer|code-reviewer)/, role);
      assert.doesNotMatch(source, /When to delegate/, role);
      // A role that is given subagents anyway still gets the intro, without any persona guidance after it.
      const prompt = await render(role, null, undefined, null, agents);
      assert.match(prompt, /Subagents you can start with the Agent tool/, role);
      assert.match(prompt, /- `symphony:laravel-code-reviewer`: Reviews a diff\./, role);
      assert.doesNotMatch(prompt, /second pass over a large diff|Use the architect|Good use: the test engineer/, role);
    }
    // The integration variant of the reviewer prompt has no guidance line either.
    const template = compilePrompt(definition.promptTemplate, definition.partials);
    const split = { ...issue, native_ref: { ...issue.native_ref, sub_issues: [{ identifier: 'acme/app#43', title: 'CSV writer', state: 'CLOSED', state_reason: 'COMPLETED' }] } };
    const integration = await renderPrompt(template, {
      issue: issueTemplateValue(split, new Map()),
      attempt: null,
      role: 'reviewer',
      agents,
      result_required: true,
      round: 1,
      results: { ...EMPTY_RESULTS },
    });
    assert.match(integration, /integration review/);
    assert.match(integration, /Subagents you can start with the Agent tool/);
    assert.doesNotMatch(integration, /second pass over a large diff/);
  });

  it('gives the shipped roles only subagents the toolbox ships, read-only ones to read-only roles', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const config = resolveConfig(definition.config, {
      workflowPath: shipped,
      env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' },
      trackerDefaults,
    });
    const agents = new Map(pluginAgents([toolbox]).map((agent) => [agent.name, agent]));
    const byRole = Object.fromEntries((config.roles ?? []).map((role) => [role.name, role.agents]));
    assert.deepEqual(byRole, {
      'issue-analyst': [],
      architect: ['explorer', 'design-critic'],
      developer: ['explorer', 'laravel-architect', 'laravel-database-engineer', 'laravel-filament-developer', 'laravel-test-engineer', 'laravel-code-reviewer'],
      'test-engineer': ['test-designer'],
      docs: [],
      reviewer: ['convention-lens', 'bug-lens', 'finding-verifier'],
      'security-auditor': ['security-inventory', 'refutation-judge'],
      auditor: ['explorer', 'laravel-architect', 'laravel-code-reviewer'],
      autopilot: ['explorer', 'laravel-architect'],
      analyst: ['explorer', 'laravel-architect'],
      planner: ['explorer', 'laravel-architect'],
      'brain-gardener': [],
    });
    for (const role of config.roles ?? []) {
      assert.ok(Array.isArray(role.agents), `${role.name} has no explicit agents list`);
      for (const name of role.agents ?? []) {
        assert.ok(agents.has(name), `${role.name}: ${name}`);
        if (role.readOnly) assert.ok(agents.get(name)?.readOnly, `${role.name} is read-only, ${name} is not`);
      }
    }
  });

  it('denies all five laravel-* agents to docs and brain-gardener in a Laravel workspace', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const config = resolveConfig(definition.config, {
      workflowPath: shipped,
      env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' },
      trackerDefaults,
    });
    const all = pluginAgents([toolbox]);
    const laravel = all.filter((agent) => agent.name.startsWith('laravel-'));
    assert.equal(laravel.length, 5);
    for (const name of ['docs', 'brain-gardener']) {
      const role = (config.roles ?? []).find((entry) => entry.name === name) ?? null;
      const { allowed, denied } = sessionAgents(all, role, ['laravel-'], ['laravel-']);
      assert.deepEqual(allowed, [], name);
      for (const agent of laravel) assert.ok(denied.includes(agent), `${name}: ${agent.name}`);
      assert.doesNotMatch(await render(name, null, undefined, null, allowed), /Subagents you can start/, name);
    }
  });

  it('declares an explicit agents key for every role in the shipped WORKFLOW.md front matter', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const roles = (definition.config as { roles?: Record<string, Record<string, unknown>> }).roles ?? {};
    const names = Object.keys(roles);
    for (const name of ['developer', 'docs', 'brain-gardener', 'reviewer']) assert.ok(names.includes(name), name);
    for (const name of names) {
      assert.ok(Array.isArray(roles[name]?.agents), `${name}: agents is not an explicit list in WORKFLOW.md`);
    }
    assert.deepEqual(roles.docs?.agents, []);
    assert.deepEqual(roles['brain-gardener']?.agents, []);
  });

  it('leaves a role without an agents key at "all" and resolves "agents: []" to an empty list', async () => {
    const base = {
      tracker: { kind: 'github_project', provider: { owner: 'acme', project_number: 1, token: 't' }, active_states: ['Todo', 'Agent review'] },
    };
    const resolve = (roles: Record<string, unknown>) =>
      resolveConfig({ ...base, roles } as never, { workflowPath: shipped, env: {}, trackerDefaults }).roles ?? [];
    const [unset, none] = resolve({ a: { states: ['Todo'] }, b: { states: ['Agent review'], agents: [] } });
    assert.equal(unset?.agents ?? null, null);
    assert.deepEqual(none?.agents, []);
    const all = pluginAgents([toolbox]);
    assert.equal(sessionAgents(all, unset ?? null, [], []).denied.length, 0);
    assert.equal(sessionAgents(all, none ?? null, [], []).allowed.length, 0);
  });

  it('tells only the developer how to take, store and embed UI screenshots', async () => {
    const prompt = await render('developer');
    assert.match(prompt, /^7\. UI screenshots\. /m, 'its own numbered step');
    assert.ok(prompt.indexOf('7. UI screenshots.') < prompt.indexOf('8. Commit with'), 'before the commit and pull request step');
    assert.doesNotMatch(prompt, /^## UI screenshots/m, 'no block behind the steps');
    assert.match(prompt, /`screenshots_problem`/);
    assert.match(prompt, /`symphony-screenshot <url> <out\.png>`/);
    assert.match(prompt, /import \{ chromium \} from 'playwright'/);
    assert.match(prompt, /commit and push it on `symphony\/issue-42`/);
    assert.match(prompt, /blob\/<commit sha>\/<path>\?raw=true/);
    assert.match(prompt, /`\/opt\/ms-playwright`\)\. It is not on the `PATH`/);
    assert.match(prompt, /check it with `symphony-screenshot --check`/);
    assert.match(prompt, /`public\/build\/manifest\.json` is missing, install the dependencies and run the project's `build` script/);
    assert.match(prompt, /"No browser" and "no frontend build" are not reasons to skip them/);
    for (const role of ['reviewer', 'docs', 'issue-analyst']) assert.doesNotMatch(await render(role), /UI screenshots\. When the project/, role);
  });

  it('tells the architect and the reviewer that missing screenshots are not acceptable for want of a browser', async () => {
    for (const role of ['architect', 'reviewer']) {
      const prompt = await render(role);
      assert.match(prompt, /UI screenshots: when the project's instructions or the issue ask for screenshots/, role);
      assert.match(prompt, /`symphony-screenshot --check` tests it/, role);
    }
    assert.match(await render('architect'), /do not plan to leave them out or to hand them to a human/);
    const reviewer = await render('reviewer');
    assert.match(reviewer, /if they are missing, that is a `major` finding, unless the developer's result names the step that failed/);
    assert.match(reviewer, /\*\*UI screenshots:\*\* where the project asks for them/);
    for (const role of ['docs', 'issue-analyst', 'developer']) assert.doesNotMatch(await render(role), /UI screenshots: when the project's/, role);
  });

  it('tells only the developer which package manager builds the assets', async () => {
    const prompt = await render('developer');
    assert.match(prompt, /with the project's package manager: `packageManager` in `package\.json`, else the lockfile/);
    assert.match(prompt, /yarn, pnpm and npm are installed; do not switch to another package manager/);
    for (const role of ['reviewer', 'docs', 'issue-analyst']) assert.doesNotMatch(await render(role), /do not switch to another package manager/, role);
  });

  it('adds no command block for an ordinary issue or an unknown command', async () => {
    for (const description of ['Create an invoice resource.', '/login returns 500']) {
      const prompt = await render('developer', null, description);
      assert.doesNotMatch(prompt, /Issue command/, description);
    }
  });
});

describe('Symphony toolbox skills', () => {
  const skillsDir = path.join(toolbox, 'skills');
  const names = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

  it('ships the skills the shipped roles and templates refer to', async () => {
    assert.deepEqual([...commandSkills([toolbox])].sort(), [
      ['auto-code', 'symphony:auto-code'],
      ['brain-garden', 'symphony:brain-garden'],
      ['concept', 'symphony:concept'],
      ['plan', 'symphony:plan'],
      ['refactor-safely', 'symphony:refactor-safely'],
      ['refactoring', 'symphony:refactoring'],
    ]);
    const { definition } = await loadWorkflowFile(shipped);
    const roles = definition.config.roles as Record<string, { commands?: string[] }>;
    for (const command of Object.values(roles).flatMap((role) => role.commands ?? [])) {
      assert.ok(names.includes(command), `skill for /${command}`);
    }
  });

  it('auto-code: documents issue-models and maps every model label of the standard labels', () => {
    const text = fs.readFileSync(path.join(skillsDir, 'auto-code', 'SKILL.md'), 'utf8');
    assert.match(text, /argument-hint:.*issue-models=auto\|fable\|opus\|sonnet\|haiku/);
    assert.match(text, /`issue-models=<auto\|fable\|opus\|sonnet\|haiku>`/);
    for (const label of ['Model: haiku', 'Model: sonnet', 'Model: opus', 'Model: fable']) {
      assert.ok(text.includes(`\`${label}\``), label);
    }
  });

  it('concept: documents its arguments and uses the label families and tool parameters the workflow provides', () => {
    const dir = path.join(skillsDir, 'concept');
    const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    assert.match(text, /argument-hint:.*issue-models=auto\|fable\|opus\|sonnet\|haiku\|off/);
    assert.match(text, /`issue-models=<auto\|fable\|opus\|sonnet\|haiku\|off>`/);
    for (const phrase of ['## Concept Plan', '## Concept Report', 'parent: <number', 'blocked_by: [<numbers', 'Blocked by #N']) {
      assert.ok(text.includes(phrase), phrase);
    }
    const breakdown = fs.readFileSync(path.join(dir, 'breakdown.md'), 'utf8');
    for (const label of ['Model: haiku', 'Model: sonnet', 'Model: opus', 'Model: fable', 'Effort: low', 'Effort: medium', 'Effort: high', 'Effort: xhigh']) {
      assert.ok(breakdown.includes(`\`${label}\``), label);
    }
    for (const label of ['epic', 'concept']) {
      assert.ok(STANDARD_LABELS.some((entry) => entry.name === label), `repo-init creates the label ${label}`);
      assert.ok(fs.readFileSync(path.join(dir, 'templates.md'), 'utf8').includes(`\`${label}\``), `templates use ${label}`);
    }
  });

  it('plan: documents its arguments and uses the label families and tool parameters the workflow provides', () => {
    const dir = path.join(skillsDir, 'plan');
    const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    assert.match(text, /argument-hint:.*issue-models=auto\|fable\|opus\|sonnet\|haiku\|off/);
    assert.match(text, /`issue-models=<auto\|fable\|opus\|sonnet\|haiku\|off>`/);
    for (const phrase of ['## Plan Outline', '## Plan Report', 'blocked_by: [<numbers', 'Blocked by #N', 'without `parent`']) {
      assert.ok(text.includes(phrase), phrase);
    }
    const labels = fs.readFileSync(path.join(dir, 'labels.md'), 'utf8');
    for (const label of ['Model: haiku', 'Model: sonnet', 'Model: opus', 'Model: fable', 'Effort: low', 'Effort: medium', 'Effort: high', 'Effort: xhigh']) {
      assert.ok(labels.includes(`\`${label}\``), label);
    }
    assert.ok(STANDARD_LABELS.some((entry) => entry.name === 'plan'), 'repo-init creates the label plan');
    assert.ok(fs.readFileSync(path.join(dir, 'templates.md'), 'utf8').includes('`plan`'), 'templates use plan');
  });

  for (const name of names) {
    it(`${name}: SKILL.md names the skill like its directory and links only to existing files`, () => {
      const text = fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8');
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
      assert.equal(/^name:\s*(.+)$/m.exec(front)?.[1]?.trim(), name);
      assert.match(front, /^description:\s*\S/m);
      assert.match(front, /only load/i, 'description limits when the skill loads');
      for (const [, target] of text.matchAll(/\]\(([^)#]+\.md)\)/g)) {
        assert.ok(fs.existsSync(path.join(skillsDir, name, target as string)), `${name}/${target}`);
      }
    });
  }
});

describe('design critic (#504)', () => {
  const agents = [
    { name: 'symphony:explorer', description: 'Maps the code.' },
    { name: 'symphony:design-critic', description: 'Critiques a draft.' },
  ];
  const renderWith = async (labels: string[], list = agents) => {
    const { definition } = await loadWorkflowFile(shipped);
    const template = compilePrompt(definition.promptTemplate, definition.partials);
    const subject = { ...issue, labels, native_ref: { ...issue.native_ref, base_branch: 'develop' } };
    return renderPrompt(template, { issue: issueTemplateValue(subject, commandSkills([toolbox])), attempt: null, role: 'architect', agents: list, round: 1 });
  };
  const config = async () => {
    const { definition } = await loadWorkflowFile(shipped);
    return resolveConfig(definition.config, {
      workflowPath: shipped,
      env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' },
      trackerDefaults,
    });
  };

  for (const label of ['complexity: l', 'complexity: xl']) {
    it(`names the critic once, before report_result, at ${label}`, async () => {
      const text = await renderWith(['feature', label]);
      assert.match(text, /^- `symphony:design-critic`:/m);
      const bullet = /^- This is a large change[^\n]*$/m.exec(text)?.[0] ?? '';
      assert.match(bullet, /`symphony:design-critic`/);
      assert.match(bullet, /once/);
      assert.match(bullet, /before `report_result`/);
      assert.match(bullet, /file:line/);
      assert.match(bullet, /no second call/);
      assert.match(bullet, /Not for/);
      assert.match(text, /start 2–3 `symphony:explorer` calls/);
      assert.doesNotMatch(text, /laravel-architect/);
    });
  }

  it('never names the critic at M, S or without a complexity label, and keeps the explorer bullet', async () => {
    for (const labels of [['feature', 'complexity: m'], ['feature', 'complexity: s'], ['feature']]) {
      const text = await renderWith(labels);
      assert.doesNotMatch(text, /design-critic/, labels.join());
      assert.match(text, /start 2–3 `symphony:explorer` calls/, labels.join());
      assert.doesNotMatch(text, /laravel-architect/, labels.join());
    }
  });

  it('renders the critic alone at M like no agents at all', async () => {
    const only = [agents[1] as { name: string; description: string }];
    assert.equal(await renderWith(['feature', 'complexity: m'], only), await renderWith(['feature', 'complexity: m'], []));
  });

  it('gives the architect exactly explorer and design-critic; laravel-architect stays for the other roles', async () => {
    const byRole = Object.fromEntries(((await config()).roles ?? []).map((role) => [role.name, role.agents ?? []]));
    assert.deepEqual(byRole.architect, ['explorer', 'design-critic']);
    for (const name of ['developer', 'auditor', 'analyst', 'planner', 'autopilot']) assert.ok(byRole[name]?.includes('laravel-architect'), name);
    for (const [name, list] of Object.entries(byRole)) if (name !== 'architect') assert.ok(!list.includes('design-critic'), name);
  });

  it('passes validate for the read-only architect, and sessionAgents allows exactly the two agents', async () => {
    const resolved = await config();
    const role = (resolved.roles ?? []).find((entry) => entry.name === 'architect') ?? null;
    assert.equal(role?.readOnly, true);
    const errors = validateDispatch({ config: resolved } as unknown as EffectiveWorkflow, null, { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' });
    assert.deepEqual(errors.filter((error) => error.includes('.agents')), []);
    for (const prefixes of [['laravel-'], []]) {
      const { allowed, denied } = sessionAgents(pluginAgents([toolbox]), role, prefixes, prefixes);
      assert.deepEqual(allowed.map((agent) => agent.qualified).sort(), ['symphony:design-critic', 'symphony:explorer'], prefixes.join());
      assert.ok(denied.some((agent) => agent.qualified === 'symphony:laravel-architect'), prefixes.join());
    }
  });

  describe('design-critic.md', () => {
    const text = fs.readFileSync(path.join(toolbox, 'agents', 'design-critic.md'), 'utf8');
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';

    it('has exactly the five front matter keys, opus, maxTurns 40, the read-only deny list, no tools or effort', () => {
      assert.deepEqual(front.split('\n').map((line) => line.slice(0, line.indexOf(':'))), ['name', 'description', 'model', 'maxTurns', 'disallowedTools']);
      assert.match(front, /^name: design-critic$/m);
      assert.match(front, /^model: opus$/m);
      assert.match(front, /^maxTurns: 40$/m);
      assert.match(front, /^disallowedTools: Edit, Write, NotebookEdit$/m);
      assert.doesNotMatch(front, /^(tools|effort):/m);
    });

    it('is read-only for pluginAgents(), without a framework prefix, with trigger and exclusion', () => {
      const agent = pluginAgents([toolbox]).find((entry) => entry.name === 'design-critic');
      assert.ok(agent);
      assert.equal(agent.qualified, 'symphony:design-critic');
      assert.equal(agent.readOnly, true);
      assert.match(agent.description, /L or XL/);
      assert.match(agent.description, /Not for/);
    });

    it('asks for a critique: file:line, severity, what breaks, and no design', () => {
      assert.match(text, /file:line/);
      assert.match(text, /`blocker`, `major` or `minor`/);
      assert.match(text, /what breaks/);
      assert.match(text, /you do not design/);
      assert.match(text, /No new design/);
    });
  });
});

describe('Symphony toolbox subagents', () => {
  const agentsDir = path.join(toolbox, 'agents');
  const files = fs.readdirSync(agentsDir).filter((file) => file.endsWith('.md'));

  it('ships the Laravel subagents and the framework-neutral explorer, design-critic, test-designer and lens personas', () => {
    assert.deepEqual(files.map((file) => file.slice(0, -3)).sort(), [
      'bug-lens',
      'convention-lens',
      'design-critic',
      'explorer',
      'finding-verifier',
      'laravel-architect',
      'laravel-code-reviewer',
      'laravel-database-engineer',
      'laravel-filament-developer',
      'laravel-test-engineer',
      'refutation-judge',
      'security-inventory',
      'test-designer',
    ]);
  });

  for (const file of files) {
    const name = file.slice(0, -3);
    it(`${name}: named like its file, framework prefix for Laravel agents, MCP tools kept`, () => {
      const front = /^---\n([\s\S]*?)\n---\n/.exec(fs.readFileSync(path.join(agentsDir, file), 'utf8'))?.[1] ?? '';
      assert.equal(/^name:\s*(.+)$/m.exec(front)?.[1]?.trim(), name);
      const description = /^description:\s*(.+)$/m.exec(front)?.[1] ?? '';
      assert.ok(description.trim() !== '', 'has a description');
      if (/laravel/i.test(description)) assert.match(name, /^laravel-/);
      // An allowlist (`tools:`) drops the Boost MCP tools the Laravel agents rely on; read-only agents deny instead.
      if (name.startsWith('laravel-')) assert.doesNotMatch(front, /^tools:/m);
    });
  }

  describe('models and turn limits', () => {
    const front = (name: string) => /^---\n([\s\S]*?)\n---\n/.exec(fs.readFileSync(path.join(agentsDir, `${name}.md`), 'utf8'))?.[1] ?? '';
    const models: Record<string, string | undefined> = {
      'convention-lens': 'sonnet',
      'bug-lens': 'opus',
      'finding-verifier': 'opus',
      'design-critic': 'opus',
      'laravel-architect': undefined,
      'laravel-code-reviewer': 'opus',
      'laravel-database-engineer': 'sonnet',
      'laravel-filament-developer': 'sonnet',
      'laravel-test-engineer': undefined,
      'test-designer': 'sonnet',
      'refutation-judge': 'opus',
      'security-inventory': 'sonnet',
    };

    for (const [name, model] of Object.entries(models)) {
      it(`${name}: one-line maxTurns${model ? ` and model ${model}` : ''}, no effort, no YAML list`, () => {
        const text = front(name);
        assert.match(text, /^maxTurns: [1-9]\d*$/m);
        assert.equal(/^model: (.+)$/m.exec(text)?.[1], model);
        assert.doesNotMatch(text, /^effort:/m);
        assert.doesNotMatch(text, /^\s*-\s/m);
      });
    }

    it('pluginAgents() still marks the architect and the reviewer read-only and the other personas as writers', () => {
      const readOnly = Object.fromEntries(pluginAgents([toolbox]).map((agent) => [agent.name, agent.readOnly]));
      assert.deepEqual(readOnly, {
        'bug-lens': true,
        'convention-lens': true,
        'design-critic': true,
        explorer: true,
        'finding-verifier': true,
        'laravel-architect': true,
        'laravel-code-reviewer': true,
        'laravel-database-engineer': false,
        'laravel-filament-developer': false,
        'laravel-test-engineer': false,
        'refutation-judge': true,
        'security-inventory': true,
        'test-designer': false,
      });
    });
  });

  describe('security personas (E3-5)', () => {
    const read = (name: string) => fs.readFileSync(path.join(agentsDir, `${name}.md`), 'utf8');
    const frontOf = (name: string) => /^---\n([\s\S]*?)\n---\n/.exec(read(name))?.[1] ?? '';
    for (const name of ['security-inventory', 'refutation-judge']) {
      it(`${name}: read-only allowlist without a shell, trigger and exclusion, no framework name`, () => {
        assert.match(frontOf(name), /^tools: Read, Glob, Grep$/m);
        assert.doesNotMatch(frontOf(name), /Bash|Edit|Write/);
        assert.match(frontOf(name), /^description: Use /m);
        assert.match(frontOf(name), /Not for /);
        assert.doesNotMatch(frontOf(name), /laravel/i);
        assert.match(frontOf(name), /^maxTurns: \d+$/m);
      });
    }
    it('the inventory is sonnet and splits the change into components; the judge is opus', () => {
      assert.match(frontOf('security-inventory'), /^model: sonnet$/m);
      assert.match(read('security-inventory'), /components/);
      assert.match(frontOf('refutation-judge'), /^model: opus$/m);
    });
    it('the judge takes one candidate and one lens, names the three lenses, defaults to false positive and cites file:line', () => {
      const text = read('refutation-judge');
      for (const lens of ['reachability', 'impact', 'defenses']) assert.match(text, new RegExp(lens));
      assert.match(text, /false positive/);
      assert.match(text, /exactly one candidate finding and exactly one lens/);
      assert.match(text, /file:line/);
    });
  });

  describe('explorer', () => {
    const text = fs.readFileSync(path.join(agentsDir, 'explorer.md'), 'utf8');
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';

    it('is parsed by pluginAgents(), read-only, and routes by trigger and exclusion', () => {
      const agent = pluginAgents([toolbox]).find((entry) => entry.name === 'explorer');
      assert.ok(agent);
      assert.equal(agent.qualified, 'symphony:explorer');
      assert.equal(agent.readOnly, true);
      assert.match(agent.description, /Use before reading more than about ten files to find your way/);
      assert.match(agent.description, /Not for a change you can finish in a handful of tool calls/);
    });

    it('has one-line front matter with model sonnet, effort low, maxTurns around 25 and the read-only deny list', () => {
      for (const line of front.split('\n')) assert.match(line, /^[A-Za-z][\w-]*: \S.*$/, line);
      assert.match(front, /^model: sonnet$/m);
      assert.match(front, /^effort: low$/m);
      assert.match(front, /^maxTurns: 25$/m);
      assert.match(front, /^disallowedTools: Edit, Write, NotebookEdit$/m);
      assert.doesNotMatch(front, /^tools:/m);
    });

    it('asks for 5 to 10 file:line pointers, about 300 words and no file contents, and notes CLAUDE.md', () => {
      assert.match(text, /5 to 10 key files/);
      assert.match(text, /file:line|path\/to\/file:line/);
      assert.match(text, /300 words/);
      assert.match(text, /No file contents/);
      assert.match(text, /CLAUDE\.md/);
    });

    it('is listed for developer, architect, analyst, planner, autopilot and auditor in the shipped WORKFLOW.md', async () => {
      const { definition } = await loadWorkflowFile(shipped);
      const config = resolveConfig(definition.config, {
        workflowPath: shipped,
        env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' },
        trackerDefaults,
      });
      const withExplorer = (config.roles ?? []).filter((role) => role.agents?.includes('explorer')).map((role) => role.name).sort();
      assert.deepEqual(withExplorer, ['analyst', 'architect', 'auditor', 'autopilot', 'developer', 'planner']);
    });

    it('is allowed in a workspace without the Laravel integration, for every listed role, while laravel-* stays denied', async () => {
      const { definition } = await loadWorkflowFile(shipped);
      const config = resolveConfig(definition.config, {
        workflowPath: shipped,
        env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' },
        trackerDefaults,
      });
      const all = pluginAgents([toolbox]);
      for (const name of ['analyst', 'architect', 'auditor', 'autopilot', 'developer', 'planner']) {
        const role = (config.roles ?? []).find((entry) => entry.name === name) ?? null;
        const { allowed, denied } = sessionAgents(all, role, ['laravel-'], []);
        assert.deepEqual(allowed.map((agent) => agent.qualified), name === 'architect' ? ['symphony:design-critic', 'symphony:explorer'] : ['symphony:explorer'], name);
        assert.equal(denied.filter((agent) => agent.name.startsWith('laravel-')).length, 5, name);
        const listed = allowed.map((agent) => ({ name: agent.qualified, description: agent.description }));
        const prompt = await render(name, null, undefined, null, listed);
        assert.match(prompt, /symphony:explorer/, name);
        assert.doesNotMatch(prompt, /symphony:laravel-/, name);
        assert.doesNotMatch(prompt, /laravel-architect/, name);
        assert.match(prompt, /When to delegate:/, name);
      }
    });
  });

  describe('models and turn limits (independent of the persona files)', () => {
    const expected = {
      'bug-lens': { model: 'opus', readOnly: true, minTurns: 10 },
      'convention-lens': { model: 'sonnet', readOnly: true, minTurns: 10 },
      'design-critic': { model: 'opus', readOnly: true, minTurns: 1 },
      explorer: { model: 'sonnet', readOnly: true, minTurns: 1 },
      'finding-verifier': { model: 'opus', readOnly: true, minTurns: 5 },
      'laravel-architect': { model: undefined, readOnly: true, minTurns: 55 },
      'laravel-code-reviewer': { model: 'opus', readOnly: true, minTurns: 22 },
      'laravel-database-engineer': { model: 'sonnet', readOnly: false, minTurns: 1 },
      'laravel-filament-developer': { model: 'sonnet', readOnly: false, minTurns: 1 },
      'laravel-test-engineer': { model: undefined, readOnly: false, minTurns: 1 },
      'refutation-judge': { model: 'opus', readOnly: true, minTurns: 5 },
      'security-inventory': { model: 'sonnet', readOnly: true, minTurns: 5 },
      'test-designer': { model: 'sonnet', readOnly: false, minTurns: 30 },
    } as const;
    const allowedKeys = new Set(['name', 'description', 'model', 'effort', 'maxTurns', 'disallowedTools', 'tools']);
    const lines = (name: string) => {
      const text = fs.readFileSync(path.join(agentsDir, `${name}.md`), 'utf8');
      assert.ok(text.startsWith('---\n'), `${name}: starts with front matter`);
      const end = text.indexOf('\n---\n', 4);
      assert.ok(end > 0, `${name}: front matter is closed`);
      return text.slice(4, end).split('\n');
    };

    for (const [name, want] of Object.entries(expected)) {
      it(`${name}: every front-matter line is a one-line key: value entry with a known key, each key once`, () => {
        const keys: string[] = [];
        for (const line of lines(name)) {
          const match = /^([A-Za-z][\w-]*): \S.*$/.exec(line);
          assert.ok(match, `not a one-line key: value entry: "${line}"`);
          keys.push(match[1] as string);
        }
        for (const key of keys) assert.ok(allowedKeys.has(key), `unexpected key ${key}`);
        assert.equal(new Set(keys).size, keys.length, 'no duplicate keys');
        assert.ok(keys.includes('maxTurns'));
        assert.equal(keys.includes('model'), want.model !== undefined);
      });

      it(`${name}: model ${want.model ?? '(inherited)'}, maxTurns an integer between its observed tool calls and a sane ceiling`, () => {
        const entries = Object.fromEntries(lines(name).map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]));
        assert.equal(entries.model, want.model);
        assert.match(entries.maxTurns as string, /^\d+$/);
        const turns = Number(entries.maxTurns);
        // Observed tool calls: reviews 10–21, architect critiques 11–54. A limit below that cuts real runs short.
        assert.ok(turns >= want.minTurns, `maxTurns ${turns} is below the observed ${want.minTurns - 1}`);
        assert.ok(turns <= 200, `maxTurns ${turns} is no limit worth the name`);
      });
    }

    it('the architect, which critiques the most, gets the largest turn budget; the reviewer stays the tightest', () => {
      const turns = (name: string) => Number(/^maxTurns: (\d+)$/m.exec(lines(name).join('\n'))?.[1]);
      for (const other of ['laravel-code-reviewer', 'laravel-database-engineer', 'laravel-filament-developer', 'laravel-test-engineer']) {
        assert.ok(turns('laravel-architect') >= turns(other), `architect >= ${other}`);
      }
      for (const other of ['laravel-architect', 'laravel-database-engineer', 'laravel-filament-developer', 'laravel-test-engineer']) {
        assert.ok(turns('laravel-code-reviewer') <= turns(other), `reviewer <= ${other}`);
      }
    });

    it('pluginAgents() still reads every persona with name, description and its read-only mark', () => {
      const agents = pluginAgents([toolbox]);
      assert.deepEqual(agents.map((agent) => agent.name), Object.keys(expected));
      for (const agent of agents) {
        assert.equal(agent.readOnly, expected[agent.name as keyof typeof expected].readOnly, agent.name);
        assert.equal(agent.qualified, `symphony:${agent.name}`);
        assert.ok(agent.description.length > 20, `${agent.name}: description survives the new entries`);
      }
    });

    it('the read-only personas still deny Edit and Write; the writers deny nothing', () => {
      for (const [name, want] of Object.entries(expected)) {
        const text = lines(name).join('\n');
        if (want.readOnly) {
          const tools = /^tools: (.+)$/m.exec(text)?.[1];
          if (tools !== undefined) assert.doesNotMatch(tools, /\b(Edit|Write)\b/, name);
          else assert.match(text, /^disallowedTools: .*\bEdit\b.*\bWrite\b/m, name);
        }
        else assert.doesNotMatch(text, /^disallowedTools:/m, name);
      }
    });
  });

  it('the toolbox only refers to subagents it ships', () => {
    const shipped = new Set(files.map((file) => `symphony:${file.slice(0, -3)}`));
    const texts = [path.join(toolbox, 'README.md'), ...fs.readdirSync(path.join(toolbox, 'skills'), { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.md'))
      .map((file) => path.join(toolbox, 'skills', file))];
    for (const text of texts.map((file) => fs.readFileSync(file, 'utf8'))) {
      for (const [ref] of text.matchAll(/symphony:[a-z0-9-]+-(?:architect|reviewer|engineer|developer)\b/g)) assert.ok(shipped.has(ref), ref);
      assert.doesNotMatch(text, /symphony:(?:architect|code-reviewer|database-engineer|filament-developer|test-engineer)\b/);
    }
  });
});

describe('shipped WORKFLOW.md security auditor', () => {
  const afterSecurity = {
    result_required: true,
    round: 2,
    results: {
      latest: [],
      open_findings: [],
      security_findings: [
        { severity: 'blocker', file: 'app/Policies/PostPolicy.php', line: 12, problem: 'Any user may update a post', fix: 'Compare the owner' },
        { severity: 'minor', file: null, line: null, problem: 'Verbose error message', fix: null },
      ],
      failed_cases: [],
    },
  };

  async function config() {
    const { definition } = await loadWorkflowFile(shipped);
    return resolveConfig(definition.config, {
      workflowPath: shipped,
      env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' },
      trackerDefaults,
    });
  }

  it('defines a read-only role in the Security review column that reports a security result', async () => {
    const resolved = await config();
    const auditor = roleFor({ state: 'Security review', description: null }, resolved.roles);
    assert.equal(auditor?.name, 'security-auditor');
    assert.deepEqual(
      [auditor?.result, auditor?.readOnly, auditor?.onResult, auditor?.onCheckFailed, auditor?.modelLabel, auditor?.claude.model, auditor?.agents],
      ['security', true, { passed: 'In review', issues_found: 'In progress', blocked: 'Blocked' }, 'In progress', 'ignore', 'opus', ['security-inventory', 'refutation-judge']],
    );
    assert.ok(resolved.tracker.activeStates.includes('Security review'));
    assert.ok(roleFor({ state: 'Agent review', description: null }, resolved.roles)?.mayMoveTo?.includes('Security review'));
    assert.equal(resolved.pipeline.maxSecurityRounds, 2);
  });

  it('is part of the board preflight: a board without the column is reported', async () => {
    const resolved = await config();
    const board = ['Backlog', 'Ready', 'Design', 'In progress', 'Testing', 'Documentation', 'Agent review', 'Security review', 'Blocked', 'In review', 'Done'];
    assert.deepEqual(unknownBoardColumns(resolved, board), []);
    const without = board.filter((column) => column !== 'Security review');
    assert.deepEqual(unknownBoardColumns(resolved, without), [`unknown board column "Security review" (valid: ${without.join(', ')})`]);
  });

  it('lists the column between Agent review and In review in the board comment', () => {
    const source = fs.readFileSync(shipped, 'utf8');
    assert.match(source, /# Board columns: .*\| Agent review \| Security review \| Blocked \| In review \| Done/);
    assert.match(source, /active_states: \[.*Agent review, Security review\]/);
  });

  it('gives the auditor a read-only prompt with the round, the checklist and the fields of the result', async () => {
    const text = await render('security-auditor', null, undefined, 'develop', [{ name: 'laravel-code-reviewer', description: 'Reviews Laravel code' }], afterSecurity);
    assert.match(text, /## Your role: security auditor/);
    assert.match(text, /You are \*\*read-only\*\*: do not edit files, commit or push/);
    assert.match(text, /This is security round 2\./);
    assert.match(text, /git diff origin\/<base>\.\.\.HEAD` \(`<base>`: the pull request's base branch, else `develop`\)/);
    for (const topic of ['Authorization', 'Authentication and sessions', 'Injection', 'Output', 'Mass assignment', 'Secrets and data exposure', 'Migrations']) {
      assert.match(text, new RegExp(`\\*\\*${topic}`), topic);
    }
    for (const verdict of ['`passed`', '`issues_found`', '`blocked`']) assert.ok(text.includes(verdict), verdict);
    assert.match(text, /`findings`: one entry per problem with `severity`/);
    assert.match(text, /`laravel-code-reviewer`: Reviews Laravel code/);
    assert.match(text, /## Findings of your previous security review/);
    assert.match(text, /1\. \[blocker\] app\/Policies\/PostPolicy\.php:12 — Any user may update a post Expected fix: Compare the owner/);
    assert.doesNotMatch(text, /## Your role: reviewer/);
  });

  it('leaves out the previous findings in the first security round', async () => {
    const text = await render('security-auditor', null, undefined, null, [], { result_required: true, round: 1 });
    assert.match(text, /This is security round 1\./);
    assert.doesNotMatch(text, /Findings of your previous security review/);
    assert.match(text, /else the default branch/);
  });

  it('lists the open security findings in the developer prompt, apart from the review findings', async () => {
    const text = await render('developer', null, undefined, null, [], afterSecurity);
    assert.match(text, /## Open findings of the latest security review/);
    assert.match(text, /1\. \[blocker\] app\/Policies\/PostPolicy\.php:12 — Any user may update a post Expected fix: Compare the owner/);
    assert.match(text, /2\. \[minor\]  — Verbose error message/);
    assert.match(text, /the open findings of the latest security review \(listed above\)/);
    assert.doesNotMatch(text, /## Open findings of the latest agent review/);
    const without = await render('developer', null, undefined, null, [], { result_required: true, round: 1 });
    assert.doesNotMatch(without, /latest security review/);
  });

  it('tells the reviewer that an approval may go to the security review first', async () => {
    const text = await render('reviewer', null, undefined, null, [], { result_required: true, round: 1 });
    assert.match(text, /or first to "Security review" when the change is security-relevant/);
  });
});

describe('shipped WORKFLOW.md JSON hint for report_result (Claude Code rejects broken JSON before the tool runs)', () => {
  /** The rendered prompt of every role that hands off with `report_result` must carry the escaping hint. */
  const ROLES_WITH_RESULT = ['issue-analyst', 'architect', 'developer', 'docs', 'test-engineer', 'reviewer', 'security-auditor'];

  it('puts the hint into the rendered prompt of every role that reports a result', async () => {
    for (const role of ROLES_WITH_RESULT) {
      const prompt = await render(role, null, undefined, 'develop', [], { result_required: true, round: 1 });
      assert.match(prompt, /`report_result`/, role);
      assert.match(prompt, /must be valid JSON/, role);
      assert.ok(prompt.includes('escape `\\"` and `\\\\`'), `${role}: escaping of quote and backslash survives rendering`);
      assert.match(prompt, /no raw tab characters/, role);
      assert.match(prompt, /never Markdown bullet lines/, role);
      assert.match(prompt, /write paths with `\/`/, role);
      assert.match(prompt, /describe regexes in words/, role);
      assert.match(prompt, /keep the summary short and put details in the array fields/, role);
    }
  });

  it('puts the hint into the reviewer prompt of an integration review of split work packages as well', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const reviewerSources = ['roles/reviewer.md'].map((name) => definition.partials[name] ?? '');
    for (const source of reviewerSources) {
      const hints = source.match(/must be valid JSON/g) ?? [];
      const reports = source.match(/Report exactly one result with `report_result`/g) ?? [];
      assert.ok(reports.length >= 1);
      assert.equal(hints.length, reports.length, 'every reviewer hand-off step has its own hint');
    }
  });

  it('keeps the hint out of the prompts of roles that never call report_result', async () => {
    for (const role of ['default']) {
      assert.doesNotMatch(await render(role), /must be valid JSON/, role);
    }
  });

  it('keeps the hint short: one line per role prompt, no more than 520 characters', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    for (const [name, source] of Object.entries(definition.partials)) {
      for (const line of source.split('\n').filter((l) => l.includes('must be valid JSON'))) {
        assert.ok(line.length <= 520, `${name}: hint line has ${line.length} characters`);
      }
    }
  });
});

describe('shipped WORKFLOW.md JSON hint targets the main cause (list field written as Markdown list, 16 of 18 cases)', () => {
  it('tells the docs role that files is a JSON array of strings, with an example', async () => {
    const prompt = await render('docs', null, undefined, 'develop', [], { result_required: true, round: 1 });
    assert.match(prompt, /`files`[^\n]*JSON array/);
    assert.ok(prompt.includes('["README.md"]'));
    assert.match(prompt, /never a bullet list/);
  });

  it('names the array fields and shows an array literal in every role prompt with a result step', async () => {
    for (const role of ['issue-analyst', 'architect', 'developer', 'docs', 'test-engineer', 'reviewer', 'security-auditor']) {
      const prompt = await render(role, null, undefined, 'develop', [], { result_required: true, round: 1 });
      assert.match(prompt, /list fields \([^)]*`files`[^)]*\) are JSON arrays like `\["a\.md", "b\.md"\]`/, role);
    }
  });

  it('covers the German quote case (ASCII quote after a German opening quote)', async () => {
    const prompt = await render('developer', null, undefined, 'develop', [], { result_required: true, round: 1 });
    assert.match(prompt, /ASCII quote after a German opening quote/);
  });

  it('does not push the agent towards Markdown lists any more', async () => {
    for (const role of ['developer', 'docs', 'reviewer']) {
      const prompt = await render(role, null, undefined, 'develop', [], { result_required: true, round: 1 });
      assert.doesNotMatch(prompt, /put details in lists/, role);
    }
  });
});

describe('shipped prompts: result size budget', () => {
  for (const role of ['architect', 'issue-analyst', 'test-engineer']) {
    it(`${role} names the summary limit and the field budget`, async () => {
      const prompt = await render(role);
      assert.ok(prompt.includes(`at most ${SUMMARY_MAX} characters`), 'summary limit');
      assert.ok(prompt.includes(`at most about ${RESULT_FIELD_BUDGET} characters`), 'field budget');
    });
  }
});

describe('verified findings in the prompts (E3-4)', () => {
  const renderFor = async (role: string, label: string) => {
    const { definition } = await loadWorkflowFile(shipped);
    const template = compilePrompt(definition.promptTemplate, definition.partials);
    const subject = { ...issue, labels: ['feature', label], native_ref: { ...issue.native_ref, base_branch: 'develop' } };
    return renderPrompt(template, { issue: issueTemplateValue(subject, commandSkills([toolbox])), attempt: null, role, agents: [], round: 1, results: { latest: [], open_findings: [], failed_cases: [] } });
  };

  for (const role of ['reviewer', 'security-auditor']) {
    it(`tells the ${role} about verification and refuted at L/XL only`, async () => {
      for (const label of ['complexity: l', 'complexity: xl']) {
        const text = await renderFor(role, label);
        assert.match(text, /needs `verification: \{status: "confirmed", evidence\}`/, label);
        assert.match(text, /go into `refuted`/, label);
      }
      assert.doesNotMatch(await renderFor(role, 'complexity: m'), /`refuted`/);
    });
  }
});
