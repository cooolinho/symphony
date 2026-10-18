import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { effectiveAgentLimits, NO_LIMIT_OVERRIDE, slotProblems } from '../src/orchestrator/limits.ts';
import { resolveTransition } from '../src/orchestrator/transitions.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { resolveConfig, type ServiceConfig } from '../src/workflow/config.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { profileFor } from '../src/workflow/profile.ts';
import { nextStageProblems, unknownBoardColumns } from '../src/workflow/validate.ts';
import { classify } from '../src/workflow/classify.ts';

// Independent acceptance tests of #201 (bugfix profile end to end in the shipped WORKFLOW.md), derived from the issue:
// the dry run's board checks, the routing of bug issues through every stage, the slots and the board setup docs.

const root = path.join(import.meta.dirname, '..');
const shipped = path.join(root, 'WORKFLOW.md');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

const BOARD = ['Backlog', 'Ready', 'In progress', 'Testing', 'Agent review', 'Blocked', 'In review', 'Done'];

async function load(env: NodeJS.ProcessEnv = {}): Promise<ServiceConfig> {
  const { definition } = await loadWorkflowFile(shipped);
  return resolveConfig(definition.config, {
    workflowPath: shipped,
    env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't', ...env },
    trackerDefaults,
  });
}

/** The column `role` hands an issue with these labels to after `verdict`, through the profile its labels pick. */
function route(config: ServiceConfig, labels: string[], role: string, verdict: string): string | undefined {
  const profile = profileFor(config.pipeline, classify(labels).type);
  const roleConfig = config.roles?.find((candidate) => candidate.name === role);
  assert.ok(roleConfig, `role ${role}`);
  const outcome = resolveTransition({ role: roleConfig, verdict, history: { reviewRounds: 0, testRounds: 0 }, profile, flags: {}, config, boardColumns: BOARD });
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.problem);
  return outcome.target;
}

describe('#201 bugfix profile in the shipped WORKFLOW.md', () => {
  it('loads without warnings and defines exactly the bugfix profile, which does not skip or add any stage', async () => {
    const config = await load();
    assert.equal(config.warnings?.length ?? 0, 0);
    const profile = config.pipeline.profiles.get('bugfix');
    assert.ok(profile);
    assert.deepEqual(profile.skip, []);
    assert.deepEqual(Object.keys(profile.onResult), ['developer']);
    assert.deepEqual(profile.onResult.developer, { done: 'Testing' });
    // The roles of the pipeline: no architect stage, the analyst, developer, test engineer and reviewer are there.
    const names = (config.roles ?? []).map((role) => role.name);
    assert.ok(!names.some((name) => /architect/.test(name)));
    for (const name of ['issue-analyst', 'developer', 'test-engineer', 'reviewer']) assert.ok(names.includes(name), name);
  });

  it('runs a bug from Ready through analyst, developer, test engineer and reviewer to In review', async () => {
    const config = await load();
    for (const labels of [['bug'], ['type: bugfix'], ['Type: bugfix', 'effort: low']]) {
      const label = labels.join();
      assert.equal(route(config, labels, 'issue-analyst', 'ready'), 'In progress', label);
      assert.equal(route(config, labels, 'developer', 'done'), 'Testing', label);
      assert.equal(route(config, labels, 'test-engineer', 'passed'), 'Agent review', label);
      assert.equal(route(config, labels, 'reviewer', 'approved'), 'In review', label);
    }
  });

  it('sends a failed test run back to the developer and keeps blocked going to Blocked for bug issues', async () => {
    const config = await load();
    assert.equal(route(config, ['bug'], 'test-engineer', 'failed'), 'In progress');
    assert.equal(route(config, ['bug'], 'test-engineer', 'blocked'), 'Blocked');
    assert.equal(route(config, ['bug'], 'developer', 'blocked'), 'Blocked');
    assert.equal(route(config, ['bug'], 'reviewer', 'changes_needed'), 'In progress');
  });

  it('leaves features, refactors, other types and untyped issues on Agent review, unless SYMPHONY_AFTER_IMPLEMENTATION=Testing', async () => {
    const config = await load();
    for (const labels of [['feature'], ['type: feature'], ['type: refactor'], ['refactor'], ['documentation'], []]) {
      assert.equal(route(config, labels, 'developer', 'done'), 'Agent review', labels.join() || 'untyped');
    }
    const all = await load({ SYMPHONY_AFTER_IMPLEMENTATION: 'Testing' });
    for (const labels of [['feature'], ['type: refactor'], ['bug'], []]) {
      assert.equal(route(all, labels, 'developer', 'done'), 'Testing', labels.join() || 'untyped');
    }
  });

  it('keeps the base transitions of the developer: the profile is an override, not a change of the roles', async () => {
    const config = await load();
    const developer = config.roles?.find((role) => role.name === 'developer');
    assert.equal(developer?.onResult.done, 'Agent review');
    assert.equal(developer?.onResult.blocked, 'Blocked');
    assert.ok(developer?.mayMoveTo?.includes('Testing'), 'the developer may move an issue to Testing');
  });
});

describe('#201 board checks (what npm run dry-run runs against the board)', () => {
  it('finds nothing to complain about on a board with all columns including Testing', async () => {
    const config = await load();
    assert.deepEqual(unknownBoardColumns(config, BOARD), []);
    assert.deepEqual(nextStageProblems(config, BOARD), []);
  });

  it('tolerates a different case and spelling of the column names the way the tracker does', async () => {
    const config = await load();
    assert.deepEqual(unknownBoardColumns(config, BOARD.map((column) => column.toLowerCase())), []);
  });

  it('names a missing Testing column with the existing message, exactly once', async () => {
    const config = await load();
    const board = BOARD.filter((column) => column !== 'Testing');
    assert.deepEqual(unknownBoardColumns(config, board), [`unknown board column "Testing" (valid: ${board.join(', ')})`]);
  });

  it('names the missing Testing column through the profile even when SYMPHONY_AFTER_IMPLEMENTATION is unset and nothing else uses it', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const front = structuredClone(definition.config) as Record<string, any>;
    front.tracker.active_states = front.tracker.active_states.filter((state: string) => state !== 'Testing');
    delete front.roles['test-engineer'];
    delete front.checks.on_enter.Testing;
    const config = resolveConfig(front, {
      workflowPath: shipped,
      env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' },
      trackerDefaults,
    });
    const board = BOARD.filter((column) => column !== 'Testing');
    const problems = unknownBoardColumns(config, board);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /^unknown board column "Testing"/);
    assert.deepEqual(unknownBoardColumns(config, BOARD), []);
  });

  it('still reports any other missing column with the same message format', async () => {
    const config = await load();
    const board = BOARD.filter((column) => column !== 'Agent review');
    assert.deepEqual(unknownBoardColumns(config, board), [`unknown board column "Agent review" (valid: ${board.join(', ')})`]);
  });
});

describe('#201 slots for the test stage', () => {
  const problems = async (slots: number): Promise<string[]> => {
    const config = await load({ SYMPHONY_MAX_CONCURRENT_AGENTS: String(slots) });
    return slotProblems(config, effectiveAgentLimits(config, NO_LIMIT_OVERRIDE));
  };

  it('limits Testing to one agent at a time, next to the existing review limit', async () => {
    const config = await load();
    assert.equal(config.agent.maxConcurrentAgentsByState.get('testing'), 1);
    assert.equal(config.agent.maxConcurrentAgentsByState.get('agent review'), 1);
    assert.ok(config.tracker.activeStates.includes('Testing'));
  });

  it('reports no starved role with the default 3 slots or with 4', async () => {
    assert.equal((await load()).agent.maxConcurrentAgents, 3);
    assert.deepEqual(await problems(3), []);
    assert.deepEqual(await problems(4), []);
  });

  it('reports the test engineer as starved with 2 slots, as WORKFLOW.md and the docs say (bug issues are routed to Testing by the profile)', async () => {
    const found = await problems(2);
    assert.ok(found.some((line) => line.includes('test-engineer never starts in Testing')), `limits.slot_problems is [${found.join('; ')}], but the bugfix profile sends bug issues to Testing, where the reservations of developer and reviewer take both slots`);
  });
});

describe('#201 comments and documentation', () => {
  it('lists the board columns in order in the WORKFLOW.md comment, with Testing between In progress and Agent review', () => {
    const source = read('WORKFLOW.md');
    assert.match(source, /# Board columns: Backlog \| Ready \| In progress \| Testing \| Agent review \| Blocked \| In review \| Done/);
    const order = ['Ready', 'In progress', 'Testing', 'Agent review', 'In review'].map((column) => source.search(new RegExp(`^  #   ${column} +->`, 'm')));
    assert.ok(order.every((index) => index >= 0), order.join());
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.doesNotMatch(source, /Optional: the developer hands over to Testing/);
  });

  it('does not tell any more that Testing stays unused or optional for every issue', () => {
    for (const file of ['WORKFLOW.md', '.env.example', 'docs/configuration.md', 'docs/getting-started.md', 'docs/usage.md']) {
      const text = read(file);
      assert.doesNotMatch(text, /Testing[^.\n]*stays unused/i, file);
      assert.doesNotMatch(text, /\(it stays unused until/i, file);
      assert.doesNotMatch(text, /Off by default\./, file);
    }
  });

  for (const file of ['docs/getting-started.md', 'docs/usage.md']) {
    it(`${file} describes the column order Backlog, Ready, In progress, Testing, Agent review, Blocked, In review, Done`, () => {
      const text = read(file);
      const sequence = BOARD.map((column) => `\`${column}\``).join(', ').replace(/, (`Done`)$/, ', $1');
      const flattened = text.replace(/\s+/g, ' ');
      assert.ok(flattened.includes(sequence), `${file} lacks the column sequence ${sequence}`);
    });

    it(`${file} describes the bugfix flow through Testing`, () => {
      const text = read(file).replace(/\s+/g, ' ');
      assert.match(text, /bugfix/i);
      assert.match(text, /Ready[^→]*→ In progress[^→]*→ (\[checks\] → )?Testing[^→]*→ (\[checks\] → )?Agent review[^→]*→ (\[checks\] → )?In review/);
    });
  }

  it('docs/usage.md explains how to run without the test stage: the profile override, and skip only without an entry check', () => {
    const text = read('docs/usage.md').replace(/\s+/g, ' ');
    assert.match(text, /developer: \{ done: Agent review \}/);
    assert.match(text, /skip: \[test-engineer\]/);
    assert.match(text, /no `checks\.on_enter`/);
  });

  it('docs/getting-started.md names the validation message of a missing Testing column', () => {
    assert.match(read('docs/getting-started.md').replace(/\s+/g, ' '), /unknown board column "Testing"/);
  });

  it('docs/configuration.md says bug issues use the test engineer and shows the override', () => {
    const text = read('docs/configuration.md').replace(/\s+/g, ' ');
    assert.match(text, /bug issues/i);
    assert.match(text, /pipeline\.profiles\.bugfix/);
  });

  it('.env.example says bug issues always go to Testing', () => {
    assert.match(read('.env.example').replace(/\s*\n#\s*/g, ' '), /Bug issues always go to Testing/);
  });
});
