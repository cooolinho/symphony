import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { classificationLabels } from '../src/orchestrator/result-tool.ts';
import { buildStageHistory, resultsTemplateValue, type PersistedResult } from '../src/orchestrator/stage-history.ts';
import { resolveTransition } from '../src/orchestrator/transitions.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { classify } from '../src/workflow/classify.ts';
import { commandSkills } from '../src/workflow/command.ts';
import { resolveConfig, type ServiceConfig } from '../src/workflow/config.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { profileFor } from '../src/workflow/profile.ts';
import { compilePrompt, issueTemplateValue, renderPrompt } from '../src/workflow/template.ts';
import { decodeMarker, encodeMarker, parseResult, renderResultComment, type AgentResultKind, type ResultMeta, type StageResult } from '../src/workflow/results.ts';
import { unknownBoardColumns } from '../src/workflow/validate.ts';
import { makeIssue } from './helpers.ts';

// Independent acceptance tests of #205 (feature and refactor profiles), derived from the issue and its refined
// criteria: profile-specific prompt steps, refactoring_goals / confirmed_goals, the goal rule, routing in the shipped
// WORKFLOW.md and the docs.

const root = path.join(import.meta.dirname, '..');
const shipped = path.join(root, 'WORKFLOW.md');
const toolbox = path.join(root, '.claude');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

const BOARD = ['Backlog', 'Ready', 'Design', 'In progress', 'Testing', 'Agent review', 'Blocked', 'In review', 'Done'];
const GOALS = ['The duplicated parser exists once', 'No public signature of the module changes'];

const META: ResultMeta = {
  role: 'issue-analyst',
  run: 'run-1',
  round: null,
  profile: null,
  workflow_hash: null,
  head_sha: null,
  checks: null,
  target: 'In progress',
  created_at: '2026-10-18T10:00:00.000Z',
};

async function load(env: NodeJS.ProcessEnv = {}): Promise<ServiceConfig> {
  const { definition } = await loadWorkflowFile(shipped);
  return resolveConfig(definition.config, {
    workflowPath: shipped,
    env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't', ...env },
    trackerDefaults,
  });
}

function route(config: ServiceConfig, labels: string[], role: string, verdict: string): string | undefined {
  const roleConfig = config.roles?.find((candidate) => candidate.name === role);
  assert.ok(roleConfig, `role ${role}`);
  const outcome = resolveTransition({
    role: roleConfig,
    verdict,
    history: { reviewRounds: 0, testRounds: 0 },
    profile: profileFor(config.pipeline, classify(labels).type),
    config,
    boardColumns: BOARD,
    issue: { description: null, labels },
  });
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.problem);
  return outcome.target;
}

function ok(kind: AgentResultKind, input: Record<string, unknown>, context?: { refactoringGoals: readonly string[] }): StageResult {
  const outcome = parseResult(kind, input, context);
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.message);
  return outcome.result;
}

function rejected(kind: AgentResultKind, input: Record<string, unknown>, context?: { refactoringGoals: readonly string[] }): string {
  const outcome = parseResult(kind, input, context);
  assert.equal(outcome.ok, false, 'expected rejection');
  return outcome.ok ? '' : outcome.message;
}

const analysis = (goals?: string[]) => ({ verdict: 'ready', summary: 'Analysed.', type: 'refactor', ...(goals !== undefined ? { refactoring_goals: goals } : {}) });
const approved = (confirmed?: string[]) => ({
  verdict: 'approved',
  summary: 'Fine.',
  findings: [{ severity: 'nit', problem: 'Typo' }],
  ...(confirmed !== undefined ? { confirmed_goals: confirmed } : {}),
});

describe('#205 routing in the shipped WORKFLOW.md', () => {
  it('sends features and refactors analyst -> (Design unless S) -> developer -> Testing -> Agent review -> In review', async () => {
    const config = await load();
    for (const type of ['Type: feature', 'Type: refactor']) {
      for (const [complexity, afterAnalysis] of [['Complexity: S', 'In progress'], ['Complexity: M', 'Design'], ['Complexity: XL', 'Design']] as const) {
        const labels = [type, complexity];
        const label = labels.join();
        assert.equal(route(config, labels, 'issue-analyst', 'ready'), afterAnalysis, label);
        assert.equal(route(config, labels, 'architect', 'ready'), 'In progress', label);
        assert.equal(route(config, labels, 'developer', 'done'), 'Testing', label);
        assert.equal(route(config, labels, 'test-engineer', 'passed'), 'Agent review', label);
        assert.equal(route(config, labels, 'test-engineer', 'failed'), 'In progress', label);
        assert.equal(route(config, labels, 'reviewer', 'approved'), 'In review', label);
        assert.equal(route(config, labels, 'reviewer', 'changes_needed'), 'In progress', label);
      }
    }
  });

  it('keeps default, untyped and other-typed issues on Agent review after the developer', async () => {
    const config = await load();
    for (const labels of [[], ['documentation'], ['area:workflow'], ['Complexity: M']]) assert.equal(route(config, labels, 'developer', 'done'), 'Agent review', labels.join() || 'untyped');
  });

  it('keeps the bugfix flow unchanged', async () => {
    const config = await load();
    assert.equal(route(config, ['bug', 'Complexity: S'], 'developer', 'done'), 'Testing');
    assert.equal(route(config, ['bug', 'Complexity: M'], 'issue-analyst', 'ready'), 'In progress');
    assert.equal(route(config, ['bug', 'Complexity: L'], 'issue-analyst', 'ready'), 'Design');
  });

  it('loads without warnings and passes the board checks against a board with all columns', async () => {
    const config = await load();
    assert.equal(config.warnings?.length ?? 0, 0);
    assert.deepEqual(unknownBoardColumns(config, BOARD), []);
    const profiles = config.pipeline.profiles;
    assert.deepEqual(profiles.get('feature')?.onResult, { developer: { done: 'Testing' } });
    assert.deepEqual(profiles.get('refactor')?.onResult, { developer: { done: 'Testing' } });
    assert.deepEqual(profiles.get('default')?.onResult, {});
  });
});

describe('#205 results: refactoring_goals and confirmed_goals', () => {
  it('analysis: refactoring_goals is optional, empty by default, and keeps its entries', () => {
    const without = ok('analysis', analysis());
    assert.ok(without.kind === 'analysis');
    assert.deepEqual(without.refactoring_goals, []);
    const withGoals = ok('analysis', analysis(GOALS));
    assert.ok(withGoals.kind === 'analysis');
    assert.deepEqual(withGoals.refactoring_goals, GOALS);
  });

  it('review: confirmed_goals is optional and empty by default', () => {
    const without = ok('review', approved());
    assert.ok(without.kind === 'review');
    assert.deepEqual(without.confirmed_goals, []);
  });

  it('applies the usual list limits to the new lists', () => {
    assert.match(rejected('analysis', analysis(Array.from({ length: 500 }, (_, i) => `goal ${i}`))), /refactoring_goals/);
    assert.match(rejected('review', approved(Array.from({ length: 500 }, (_, i) => `goal ${i}`))), /confirmed_goals/);
    assert.match(rejected('analysis', { ...analysis(), refactoring_goals: 'one goal' }), /refactoring_goals/);
  });

  it('renders the goals in the analysis comment and the confirmed goals in the review comment', () => {
    const analysisComment = renderResultComment(ok('analysis', analysis(GOALS)), META);
    for (const goal of GOALS) assert.ok(analysisComment.includes(`- ${goal}`), goal);
    assert.match(analysisComment, /Refactoring goals/);
    assert.doesNotMatch(renderResultComment(ok('analysis', analysis()), META), /Refactoring goals/);
    const reviewComment = renderResultComment(ok('review', approved(GOALS), { refactoringGoals: GOALS }), META);
    for (const goal of GOALS) assert.ok(reviewComment.includes(`- ${goal}`), goal);
    assert.match(reviewComment, /Confirmed goals/);
    assert.doesNotMatch(renderResultComment(ok('review', approved()), META), /Confirmed goals/);
  });

  it('keeps both lists through the marker round trip', () => {
    for (const result of [ok('analysis', analysis(GOALS)), ok('review', approved(GOALS), { refactoringGoals: GOALS })]) {
      const decoded = decodeMarker(`text\n\n${encodeMarker(result, META)}`);
      assert.ok(decoded);
      assert.deepEqual(decoded.result, result);
    }
  });

  it('still decodes a stored review/analysis marker without the new fields (backwards compatible)', () => {
    for (const result of [ok('analysis', analysis(GOALS)), ok('review', approved())]) {
      const marker = encodeMarker(result, META);
      const [, encoded] = /symphony:result:v1 (\S+) -->/.exec(marker) ?? [];
      assert.ok(encoded);
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
      delete payload.refactoring_goals;
      delete payload.confirmed_goals;
      const legacy = `<!-- symphony:result:v1 ${Buffer.from(JSON.stringify(payload)).toString('base64url')} -->`;
      const decoded = decodeMarker(legacy);
      assert.ok(decoded, result.kind);
      if (decoded.result.kind === 'review') assert.deepEqual(decoded.result.confirmed_goals, []);
      if (decoded.result.kind === 'analysis') assert.deepEqual(decoded.result.refactoring_goals, []);
    }
  });
});

describe('#205 the goal rule (a refactor review without confirmed goals is rejected)', () => {
  const context = { refactoringGoals: GOALS };

  it('rejects an approval without confirmed_goals and names every missing goal', () => {
    const message = rejected('review', approved(), context);
    for (const goal of GOALS) assert.ok(message.includes(goal), `${goal} in: ${message}`);
  });

  it('rejects an approval that confirms only some goals, listing just the missing one', () => {
    const message = rejected('review', approved([GOALS[0] as string]), context);
    assert.ok(message.includes(GOALS[1] as string));
    assert.ok(!message.includes(GOALS[0] as string), message);
  });

  it('accepts an approval that confirms all goals, trimmed and case-insensitive, in any order, with extras', () => {
    ok('review', approved(GOALS), context);
    ok('review', approved([...GOALS].reverse()), context);
    ok('review', approved(GOALS.map((goal) => `  ${goal.toUpperCase()}\t`)), context);
    ok('review', approved([...GOALS, 'Something extra']), context);
  });

  it('does not accept a paraphrase of a goal', () => {
    rejected('review', approved(['Parser exists once', GOALS[1] as string]), context);
  });

  it('does not touch changes_needed and blocked reviews', () => {
    ok('review', { verdict: 'changes_needed', summary: 'No.', findings: [{ severity: 'major', problem: 'Goal missed' }] }, context);
    ok('review', { verdict: 'blocked', summary: 'Cannot.', blockers: [{ description: 'No access', needs: 'access' }] }, context);
  });

  it('is off without goals in the context, with an empty list, and for other kinds', () => {
    ok('review', approved());
    ok('review', approved(), {} as { refactoringGoals: readonly string[] });
    ok('review', approved(), { refactoringGoals: [] });
    ok('analysis', analysis(), context);
    ok('test', { verdict: 'passed', summary: 'Ok.', cases: [{ criterion: 'c', test: 't', status: 'passed' }] }, context);
  });
});

describe('#205 the goals reach the later stages', () => {
  const persisted = (goals: string[]): PersistedResult => ({ result: ok('analysis', analysis(goals)), meta: META });

  it('exposes results.analysis.refactoring_goals to the prompt', () => {
    assert.deepEqual(resultsTemplateValue(buildStageHistory([persisted(GOALS)])).analysis?.refactoring_goals, GOALS);
    assert.deepEqual(resultsTemplateValue(buildStageHistory([persisted([])])).analysis?.refactoring_goals, []);
  });

  it('classifies an issue by the analyst\'s own labels of the same report and routes it through the refactor profile', async () => {
    const config = await load();
    const parsed = ok('analysis', { verdict: 'ready', summary: 'Analysed.', type: 'refactor', complexity: 'S' });
    const added = classificationLabels(parsed, []);
    assert.deepEqual(added, ['Type: refactor', 'Complexity: S']);
    assert.equal(profileFor(config.pipeline, classify(added).type)?.name, 'refactor');
    assert.equal(route(config, added, 'developer', 'done'), 'Testing');
  });
});

describe('#205 rendered prompts', () => {
  async function prompt(role: string, labels: string[], description = 'Merge the parsers.', goals?: string[]): Promise<string> {
    const { definition } = await loadWorkflowFile(shipped);
    const subject = makeIssue({
      id: 'PVTI_1',
      identifier: 'acme/app#42',
      title: 'Task',
      description,
      state: 'In progress',
      url: 'https://github.com/acme/app/issues/42',
      labels,
      native_ref: { provider: 'github_project', repository: 'acme/app', number: 42, parent: null, sub_issues: [], base_branch: null },
    });
    const results =
      goals === undefined
        ? {}
        : { results: resultsTemplateValue(buildStageHistory([{ result: ok('analysis', analysis(goals)), meta: META }])) };
    return renderPrompt(compilePrompt(definition.promptTemplate), {
      issue: issueTemplateValue(subject, commandSkills([toolbox])),
      attempt: null,
      role,
      agents: [],
      round: 1,
      result_required: true,
      test_paths: ['tests/**'],
      ...results,
    });
  }
  const SKILL = 'symphony:refactor-safely';
  const ROLES = ['developer', 'test-engineer', 'reviewer', 'issue-analyst'];

  it('refactor developer: loads the skill, characterization tests first, no behaviour change, shows the goals', async () => {
    const text = await prompt('developer', ['Type: refactor'], undefined, GOALS);
    assert.ok(text.includes(SKILL));
    assert.match(text, /characterization tests/i);
    assert.match(text, /not change behaviour/i);
    for (const goal of GOALS) assert.ok(text.includes(goal), goal);
  });

  it('refactor developer and reviewer do not load the skill twice when the issue starts with /refactor-safely', async () => {
    for (const role of ['developer', 'reviewer']) {
      const text = await prompt(role, ['Type: refactor'], '/refactor-safely\n\nMerge the parsers.', GOALS);
      assert.ok(text.includes('Issue command: /refactor-safely'), role);
      assert.equal(text.split('load the skill `symphony:refactor-safely`').length - 1, 1, role);
    }
  });

  it('refactor test engineer: characterization tests green on the base commit and on HEAD, failed on a difference', async () => {
    const text = await prompt('test-engineer', ['Type: refactor']);
    assert.match(text, /characterization tests/i);
    assert.match(text, /base commit/);
    assert.match(text, /HEAD/);
    assert.match(text, /`failed`/);
  });

  it('refactor reviewer: public interfaces unchanged, confirms each goal and asks for confirmed_goals', async () => {
    const text = await prompt('reviewer', ['Type: refactor'], undefined, GOALS);
    assert.match(text, /public interfaces/i);
    assert.match(text, /confirmed_goals/);
    for (const goal of GOALS) assert.ok(text.includes(goal), goal);
  });

  it('refactor analyst: asked for refactoring_goals', async () => {
    assert.match(await prompt('issue-analyst', ['Type: refactor']), /refactoring_goals/);
  });

  it('feature developer and reviewer: design and acceptance criteria, a test per criterion', async () => {
    const developer = await prompt('developer', ['Type: feature']);
    assert.match(developer, /new feature/);
    assert.match(developer, /acceptance criterion/i);
    assert.match(developer, /test/i);
    assert.match(await prompt('reviewer', ['Type: feature']), /\*\*Feature:\*\*/);
  });

  it('shows none of the refactor or feature steps to bugfix, other-typed and untyped issues', async () => {
    const REFACTOR = [/This is a refactoring/, /Behaviour preserved/, /refactoring_goals/, /confirmed_goals/, /characterization tests/i];
    const FEATURE = [/This is a new feature/, /\*\*Feature:\*\*/];
    for (const role of ROLES) {
      for (const labels of [['bug'], ['documentation']]) {
        if (role === 'issue-analyst' && labels[0] === 'documentation') continue; // the analyst assigns the type: it sees the goals field
        const text = await prompt(role, labels, 'Merge the parsers.', GOALS);
        for (const pattern of [...REFACTOR, ...FEATURE]) assert.doesNotMatch(text, pattern, `${role} ${labels.join()} ${pattern}`);
      }
    }
    // Untyped: the developer, test engineer and reviewer see neither; only the analyst (who assigns the type) may see the goals field.
    for (const role of ['developer', 'test-engineer', 'reviewer']) {
      const text = await prompt(role, [], 'Merge the parsers.', GOALS);
      for (const pattern of [...REFACTOR, ...FEATURE]) assert.doesNotMatch(text, pattern, `${role} untyped ${pattern}`);
    }
    for (const role of ROLES) {
      assert.doesNotMatch(await prompt(role, ['Type: feature'], 'x', GOALS), /This is a refactoring/, role);
      assert.doesNotMatch(await prompt(role, ['Type: refactor'], 'x', GOALS), /This is a new feature/, role);
    }
  });
});

describe('#205 docs', () => {
  it('describes the new fields and the profile flows', () => {
    assert.match(read('docs/results.md'), /refactoring_goals/);
    assert.match(read('docs/results.md'), /confirmed_goals/);
    assert.match(read('docs/configuration.md'), /refactoring_goals/);
    assert.match(read('docs/usage.md'), /refactor/i);
  });
});
