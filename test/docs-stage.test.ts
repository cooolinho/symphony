import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { docsNeeded, type DocsFacts } from '../src/orchestrator/docs.ts';
import { resolveTransition } from '../src/orchestrator/transitions.ts';
import { docsStageProblems } from '../src/workflow/validate.ts';
import type { RoleConfig } from '../src/workflow/roles.ts';

// The trigger of the documentation stage (docs/configuration.md#the-documentation-stage).

const DOCS = ['docs/**', 'README*.md', 'CHANGELOG*.md'];
const TRIGGERS = ['.env.example', 'config/**', 'WORKFLOW.md'];

function facts(overrides: Partial<DocsFacts> & { files?: string[] | Error } = {}): DocsFacts & { calls: number } {
  const { files = ['src/app.ts'], ...rest } = overrides;
  const result = {
    docsNeeded: false,
    docsPaths: DOCS,
    triggerPaths: TRIGGERS,
    calls: 0,
    changedFiles: async () => {
      result.calls += 1;
      if (files instanceof Error) throw files;
      return files;
    },
    ...rest,
  };
  return result;
}

describe('docsNeeded', () => {
  it('needs the stage for a changed .env.example without a docs change', async () => {
    const decision = await docsNeeded(facts({ files: ['.env.example', 'src/app.ts'] }));
    assert.equal(decision.needed, true);
    assert.match(decision.reason, /1 changed file\(s\) match pipeline\.docs_trigger_paths without a change in pipeline\.docs_paths: \.env\.example/);
  });

  it('needs the stage for config files and WORKFLOW.md', async () => {
    assert.equal((await docsNeeded(facts({ files: ['config/app.php'] }))).needed, true);
    assert.equal((await docsNeeded(facts({ files: ['WORKFLOW.md'] }))).needed, true);
  });

  it('skips a change without a trigger file', async () => {
    const decision = await docsNeeded(facts({ files: ['src/app.ts', 'test/app.test.ts'] }));
    assert.deepEqual(decision, { needed: false, reason: 'no trigger (none of 2 changed file(s) matches pipeline.docs_trigger_paths)' });
    assert.equal((await docsNeeded(facts({ files: [] }))).needed, false);
  });

  it('skips when the documentation changed already', async () => {
    const decision = await docsNeeded(facts({ files: ['.env.example', 'docs/configuration.md'] }));
    assert.equal(decision.needed, false);
    assert.match(decision.reason, /documentation already changed \(docs\/configuration\.md\)/);
    assert.equal((await docsNeeded(facts({ files: ['config/app.php', 'README.md'] }))).needed, false);
  });

  it('docs_needed in the analysis decides without asking git, whatever the files', async () => {
    const asked = facts({ docsNeeded: true, files: ['docs/usage.md'] });
    const decision = await docsNeeded(asked);
    assert.deepEqual([decision.needed, asked.calls], [true, 0]);
    assert.match(decision.reason, /analysis says documentation must change/);
  });

  it('an empty trigger list turns the path trigger off without asking git', async () => {
    const off = facts({ triggerPaths: [], files: ['.env.example'] });
    assert.equal((await docsNeeded(off)).needed, false);
    assert.equal(off.calls, 0);
    assert.equal((await docsNeeded({ ...off, docsNeeded: true })).needed, true);
  });

  it('fails safe: when git cannot list the files, the stage is needed and the reason says why', async () => {
    const decision = await docsNeeded(facts({ files: new Error('not a git repository') }));
    assert.equal(decision.needed, true);
    assert.match(decision.reason, /changed files could not be determined \(not a git repository\), documenting to be safe/);
  });
});

function role(overrides: Partial<RoleConfig> & Pick<RoleConfig, 'name' | 'states'>): RoleConfig {
  return {
    readOnly: false,
    mayMoveTo: null,
    result: null,
    onResult: {},
    onCheckFailed: null,
    onMissingResult: 'Blocked',
    onRoundLimit: null,
    modelLabel: 'apply',
    effortLabel: 'apply',
    maxTurns: null,
    commands: null,
    runChecks: true,
    maxSubIssues: null,
    subIssueStatus: null,
    waitForSubIssues: false,
    agents: null,
    brain: 'off',
    brainApprovedWrites: true,
    claude: {},
    ...overrides,
  };
}

const ACTIVE = ['Ready', 'In progress', 'Testing', 'Documentation', 'Agent review'];
const BOARD = ['Backlog', 'Ready', 'In progress', 'Testing', 'Documentation', 'Agent review', 'Blocked', 'In review', 'Done'];
const ROLES = [
  role({ name: 'developer', states: ['in progress'], result: 'implementation', onResult: { done: 'Agent review', blocked: 'Blocked' }, mayMoveTo: ['Testing', 'Documentation', 'Agent review', 'Blocked'] }),
  role({ name: 'test-engineer', states: ['testing'], result: 'test', onResult: { passed: 'next', failed: 'In progress', blocked: 'Blocked' }, mayMoveTo: ['Documentation', 'Agent review', 'In progress', 'Blocked'] }),
  role({ name: 'docs', states: ['documentation'], result: 'docs', onResult: { done: 'next', not_needed: 'next', blocked: 'Blocked' }, mayMoveTo: ['Agent review', 'Blocked'] }),
  role({ name: 'reviewer', states: ['agent review'], readOnly: true, result: 'review', onResult: { approved: 'In review', changes_needed: 'In progress', blocked: 'Blocked' }, mayMoveTo: ['In review', 'In progress', 'Blocked'] }),
];
const config = { tracker: { activeStates: ACTIVE, terminalStates: ['Done'] }, roles: ROLES, pipeline: { limitLabel: 'needs-human', maxReviewRounds: 3, maxTestRounds: 2, maxSecurityRounds: 2 } } as never;

function route(roleName: string, verdict: string, flags?: Record<string, boolean>, profile: Parameters<typeof resolveTransition>[0]['profile'] = null) {
  const outcome = resolveTransition({
    role: ROLES.find((candidate) => candidate.name === roleName)!,
    verdict,
    history: { reviewRounds: 0, testRounds: 0 },
    profile,
    flags,
    flagReasons: { docs: 'the reason' },
    config,
    boardColumns: BOARD,
  });
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.problem);
  return outcome;
}

describe('routing to the documentation stage', () => {
  it('a developer hand-off to the reviewer goes to Documentation when the flag holds, and says why', () => {
    const outcome = route('developer', 'done', { docs: true });
    assert.equal(outcome.target, 'Documentation');
    assert.match(outcome.reason, /documentation needed: the reason/);
  });

  it('goes to the reviewer when the flag is false, or when the resolver has no flag', () => {
    assert.equal(route('developer', 'done', { docs: false }).target, 'Agent review');
    assert.match(route('developer', 'done', { docs: false }).reason, /documentation not needed: the reason/);
    assert.equal(route('developer', 'done').target, 'Agent review');
  });

  it('a passed test with `next` runs the docs stage only when needed', () => {
    assert.equal(route('test-engineer', 'passed', { docs: true }).target, 'Documentation');
    const skipped = route('test-engineer', 'passed', { docs: false });
    assert.equal(skipped.target, 'Agent review');
    assert.match(skipped.reason, /docs not needed/);
  });

  it('the docs result leads to the reviewer, for done and not_needed', () => {
    assert.equal(route('docs', 'done').target, 'Agent review');
    assert.equal(route('docs', 'not_needed').target, 'Agent review');
    assert.equal(route('docs', 'blocked').target, 'Blocked');
  });

  it('other verdicts and a profile that skips docs keep their route', () => {
    assert.equal(route('developer', 'blocked', { docs: true }).target, 'Blocked');
    assert.equal(route('developer', 'done', { docs: true }, { name: 'bugfix', skip: ['docs'], skipWhen: {}, onResult: {}, maxReviewRounds: null, maxTestRounds: null }).target, 'Agent review');
  });

  it('a developer who hands over to Testing is not routed to Documentation', () => {
    const toTesting = { ...ROLES[0]!, onResult: { done: 'Testing' } };
    const outcome = resolveTransition({ role: toTesting, verdict: 'done', history: { reviewRounds: 0, testRounds: 0 }, profile: null, flags: { docs: true }, config, boardColumns: BOARD });
    assert.ok(outcome.ok && outcome.target === 'Testing');
  });
});

describe('docsStageProblems', () => {
  it('asks the developer and the test engineer to list the Documentation column', () => {
    assert.deepEqual(docsStageProblems(config), []);
    const without = { ...(config as object), roles: [{ ...ROLES[0]!, mayMoveTo: ['Agent review', 'Blocked'] }, ...ROLES.slice(1)] } as never;
    assert.deepEqual(docsStageProblems(without), ['roles.developer.may_move_to must list "Documentation": an issue goes there when it needs documentation (roles.docs)']);
  });

  it('reports a docs role whose column is not active', () => {
    const inactive = { ...(config as object), tracker: { activeStates: ['Ready', 'In progress', 'Agent review'], terminalStates: ['Done'] } } as never;
    assert.match(docsStageProblems(inactive)[0] ?? '', /roles\.docs: the documentation stage serves no column of tracker\.active_states/);
  });
});
