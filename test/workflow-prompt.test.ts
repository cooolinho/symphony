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
import { roleFor, roleName } from '../src/workflow/roles.ts';
import { unknownBoardColumns } from '../src/workflow/validate.ts';
import { compilePrompt, issueTemplateValue, renderPrompt } from '../src/workflow/template.ts';
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
      ['test', { passed: 'Agent review', failed: 'In progress', blocked: 'Blocked' }, false, 'ignore', 'sonnet', ['laravel-test-engineer']],
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
      [true, 'analysis', { ready: 'next', needs_info: 'Blocked' }, 3, 'ignore', 'sonnet', ['laravel-architect'], null],
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
    const agents = [{ name: 'symphony:laravel-architect', description: 'Plans features' }];
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
    assert.match(prompt, /`symphony:laravel-architect`: Plans features/);
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
    const prompt = await render('reviewer', 2);
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
      assert.doesNotMatch(without, /Subagents you may start/, role);
      const prompt = await render(role, null, undefined, null, agents);
      assert.match(prompt, /Subagents you may start with the Agent tool/, role);
      assert.match(prompt, /- `symphony:laravel-code-reviewer`: Reviews a diff\./, role);
    }
    assert.match(await render('developer', null, undefined, null, agents), /before you report the result/);
    assert.match(await render('reviewer', null, undefined, null, agents), /second pass over a large diff/);
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
      'issue-analyst': ['laravel-architect'],
      architect: ['laravel-architect'],
      developer: ['laravel-architect', 'laravel-database-engineer', 'laravel-filament-developer', 'laravel-test-engineer', 'laravel-code-reviewer'],
      'test-engineer': ['laravel-test-engineer'],
      docs: null,
      reviewer: ['laravel-code-reviewer'],
      'security-auditor': ['laravel-code-reviewer'],
      auditor: ['laravel-architect', 'laravel-code-reviewer'],
      autopilot: ['laravel-architect'],
      analyst: ['laravel-architect'],
      planner: ['laravel-architect'],
    });
    for (const role of config.roles ?? []) {
      for (const name of role.agents ?? []) {
        assert.ok(agents.has(name), `${role.name}: ${name}`);
        if (role.readOnly) assert.ok(agents.get(name)?.readOnly, `${role.name} is read-only, ${name} is not`);
      }
    }
  });

  it('tells only the developer how to take, store and embed UI screenshots', async () => {
    const prompt = await render('developer');
    assert.match(prompt, /## UI screenshots/);
    assert.match(prompt, /`symphony-screenshot <url> <out\.png>`/);
    assert.match(prompt, /import \{ chromium \} from 'playwright'/);
    assert.match(prompt, /commit and push it on `symphony\/issue-42`/);
    assert.match(prompt, /blob\/<commit sha>\/<path>\?raw=true/);
    assert.match(prompt, /`\/opt\/ms-playwright`\)\. It is not on the `PATH`/);
    assert.match(prompt, /check it with `symphony-screenshot --check`/);
    assert.match(prompt, /`public\/build\/manifest\.json` is missing, install the dependencies and run the project's `build` script/);
    assert.match(prompt, /"No browser" and "no frontend build" are not reasons to skip them/);
    for (const role of ['reviewer', 'docs', 'issue-analyst']) assert.doesNotMatch(await render(role), /## UI screenshots/, role);
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

describe('Symphony toolbox subagents', () => {
  const agentsDir = path.join(toolbox, 'agents');
  const files = fs.readdirSync(agentsDir).filter((file) => file.endsWith('.md'));

  it('ships the Laravel subagents', () => {
    assert.deepEqual(files.map((file) => file.slice(0, -3)).sort(), [
      'laravel-architect',
      'laravel-code-reviewer',
      'laravel-database-engineer',
      'laravel-filament-developer',
      'laravel-test-engineer',
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
      assert.doesNotMatch(front, /^tools:/m);
    });
  }

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
      ['security', true, { passed: 'In review', issues_found: 'In progress', blocked: 'Blocked' }, 'In progress', 'ignore', 'opus', ['laravel-code-reviewer']],
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
