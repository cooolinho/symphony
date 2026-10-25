import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Logger } from '../src/log.ts';
import { createGuard, guardTools, toolsForRole } from '../src/orchestrator/guard.ts';
import { RESULT_TOOL, createResultTool, type ResultToolParams } from '../src/orchestrator/result-tool.ts';
import { effectivePaths } from '../src/workflow/path-globs.ts';
import { commandSkills } from '../src/workflow/command.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { compilePrompt, issueTemplateValue, renderPrompt } from '../src/workflow/template.ts';
import { parseResult } from '../src/workflow/results.ts';
import { WorkspaceManager } from '../src/workspace/manager.ts';
import { changedFiles } from '../src/workspace/changes.ts';
import type { Issue, ToolResult } from '../src/tracker/types.ts';
import { FakeTracker, baseFront, makeIssue, makeWorkflow, tempDir } from './helpers.ts';

// Acceptance tests of #313 (screenshots for UI changes), derived from the issue: a developer's `done` result for a
// change to UI files is refused unless a screenshot changed or `screenshots_problem` names the failed step. They run
// against a real git repository and the default pipeline paths.

const ROLES = {
  developer: { states: ['Todo', 'In progress'], result: 'implementation', may_move_to: ['Documentation', 'Agent review', 'Blocked'], on_result: { done: 'Agent review' } },
  tester: {
    states: ['Testing'],
    result: 'test',
    may_move_to: ['Documentation', 'Agent review', 'In progress', 'Blocked'],
    on_result: { passed: 'Agent review', failed: 'In progress' },
  },
};

const DONE = { verdict: 'done', summary: 'Implemented.' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd, encoding: 'utf8' }).trim();
}

function write(repo: string, name: string, content = 'x'): void {
  const file = path.join(repo, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A repository on `main` with one commit, then a feature branch carrying `files` (committed). */
function branchWith(files: string[], extra: Record<string, string> = {}): string {
  const repo = tempDir('symphony-shots-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'README.md', 'base\n');
  for (const [name, content] of Object.entries(extra)) write(repo, name, content);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'checkout', '-q', '-b', 'symphony/issue-1');
  for (const file of files) write(repo, file, `content of ${file}\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'work');
  return repo;
}

interface Options {
  pipeline?: Record<string, unknown>;
  role?: 'developer' | 'tester';
  title?: string;
  description?: string;
  appDirs?: string[];
}

/** The tool of a developer working in `repo`, wired like the worker does it (default pipeline paths, git for the changed files). */
function developer(repo: string, options: Options = {}) {
  const root = tempDir('symphony-shots-root-');
  const front = baseFront(root, {
    tracker: {
      kind: 'github_project',
      provider: { owner: 'acme', project_number: 1, token: 'test-token' },
      active_states: ['Todo', 'In progress', 'Testing'],
    },
    roles: ROLES,
    pipeline: options.pipeline ?? {},
    checks: { timeout_ms: 10_000, on_enter: {} },
  });
  const config = makeWorkflow(front).config;
  const role = config.roles?.find((r) => r.name === (options.role ?? 'developer'));
  assert.ok(role);
  const tracker = new FakeTracker([
    makeIssue({ id: '1', state: options.role === 'tester' ? 'Testing' : 'In progress', title: options.title ?? 'Add a page', description: options.description ?? 'A new page.' }),
  ]);
  const current = (): Issue => {
    const issue = tracker.issues.get('1');
    assert.ok(issue);
    return issue;
  };
  const manager = new WorkspaceManager({ root, hooks: config.hooks, workflowDir: root }, { PATH: process.env.PATH }, Logger.silent());
  const guard = createGuard({
    role,
    config,
    workspace: { path: repo, key: 'ws', createdNow: false },
    issue: () => ({ id: '1', identifier: 'acme/app#1' }),
    manager,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  const paths = effectivePaths(config.pipeline, options.appDirs ?? []);
  const params: ResultToolParams = {
    role,
    history: { reviewRounds: 0, testRounds: 0 },
    profile: null,
    flags: {},
    config,
    boardColumns: null,
    adapter: tracker,
    issue: current,
    runId: 'run-1',
    meta: { workflowHash: 'f'.repeat(64), headSha: async () => 'abc123def456abc1', now: () => new Date('2026-10-18T12:00:00Z') },
    screenshots: {
      uiPaths: paths.uiPaths,
      screenshotPaths: paths.screenshotPaths,
      policy: config.pipeline.requireScreenshots,
      workspace: repo,
      issueText: () => `${current().title}\n${current().description ?? ''}`,
      changedFiles: () => changedFiles(repo, 'main'),
    },
  };
  const tools = guardTools(toolsForRole(tracker.agentToolSpecs(), role, current(), createResultTool(params)), guard);
  const tool = tools.find((spec) => spec.name === RESULT_TOOL);
  assert.ok(tool);
  return { tracker, report: (args: Record<string, unknown>) => tool.execute(args, { issue: current() }) };
}

function ok(result: ToolResult): Record<string, unknown> {
  assert.ok(result.ok, result.ok ? '' : `${result.error.category}: ${result.error.message}`);
  return result.data as Record<string, unknown>;
}

function refused(result: ToolResult): { category: string; message: string } {
  assert.ok(!result.ok, 'expected a refusal');
  return result.error;
}

const ASKS = { description: 'Please attach a screenshot of the new page.' };

describe('#313 report_result: screenshots for a UI change (real git, default paths)', () => {
  it('refuses a changed UI file without screenshot and without screenshots_problem', async () => {
    const { report, tracker } = developer(branchWith(['resources/views/invoices/index.blade.php', 'src/other.ts']), ASKS);
    const error = refused(await report(DONE));
    assert.equal(error.category, 'invalid_result');
    assert.match(error.message, /resources\/views\/invoices\/index\.blade\.php/);
    assert.doesNotMatch(error.message, /src\/other\.ts/, 'only UI files are named');
    assert.deepEqual(tracker.statusCalls, [], 'nothing recorded, no move');
    assert.deepEqual(tracker.comments.get('1') ?? [], []);
  });

  it('the refusal tells the agent what to do', async () => {
    const { report } = developer(branchWith(['app/Filament/Resources/InvoiceResource.php']), ASKS);
    const { message } = refused(await report(DONE));
    assert.match(message, /build/i, 'build the frontend');
    assert.match(message, /start the app|serve|start/i, 'start the app');
    assert.match(message, /symphony-screenshot/);
    assert.match(message, /commit/i);
    assert.match(message, /pull request description|pull request body/i, 'embed in the PR description');
    assert.match(message, /screenshots_problem/);
    assert.match(message, /pipeline\.ui_paths/);
    assert.match(message, /pipeline\.screenshot_paths/);
  });

  it('accepts it when a screenshot under docs/screenshots/ changed', async () => {
    const { report } = developer(branchWith(['resources/views/a.blade.php', 'docs/screenshots/invoices.png']), ASKS);
    assert.equal(ok(await report(DONE)).target, 'Agent review');
  });

  it('accepts it when only the screenshot is untracked in the working tree', async () => {
    const repo = branchWith(['resources/views/a.blade.php']);
    write(repo, 'docs/screenshots/new.png');
    assert.equal(ok(await developer(repo, ASKS).report(DONE)).target, 'Agent review');
  });

  it('accepts it with screenshots_problem and keeps the text in the recorded result', async () => {
    const { report, tracker } = developer(branchWith(['app/Livewire/Cart.php']), ASKS);
    const problem = 'step "npm run build" failed: sh: vite: not found';
    assert.equal(ok(await report({ ...DONE, screenshots_problem: problem })).target, 'Agent review');
    const body = (tracker.comments.get('1') ?? []).map((comment) => comment.body).join('\n');
    assert.ok(body.includes(problem), 'the reviewer sees the problem');
    const parsed = parseResult('implementation', { ...DONE, screenshots_problem: problem });
    assert.ok(parsed.ok);
  });

  it('a blank screenshots_problem does not count', async () => {
    const { report } = developer(branchWith(['resources/css/app.css']), ASKS);
    assert.equal(refused(await report({ ...DONE, screenshots_problem: '   ' })).category, 'invalid_result');
  });

  it('checks nothing when no UI file changed', async () => {
    const { report } = developer(branchWith(['src/Service.php', 'tests/ServiceTest.php', 'docs/readme.md']), ASKS);
    assert.equal(ok(await report(DONE)).target, 'Agent review');
  });

  it('checks nothing when the project does not ask for screenshots', async () => {
    const { report } = developer(branchWith(['resources/views/a.blade.php']), { description: 'A new page.' });
    assert.equal(ok(await report(DONE)).target, 'Agent review');
  });

  it('every default UI path counts as a UI file', async () => {
    for (const file of ['resources/views/a.blade.php', 'app/Filament/P.php', 'app/Livewire/C.php', 'resources/css/app.css', 'resources/js/app.js', 'resources/views/deep/er/b.blade.php']) {
      const { report } = developer(branchWith([file]), ASKS);
      assert.equal(refused(await report(DONE)).category, 'invalid_result', file);
    }
  });

  it('a project with AGENTS.md or CLAUDE.md that mention screenshots asks for them, one that does not mention them does not', async () => {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const asking = branchWith(['resources/views/a.blade.php'], { [name]: '# Rules\nAdd Screenshots to UI pull requests.\n' });
      assert.equal(refused(await developer(asking).report(DONE)).category, 'invalid_result', name);
      const silent = branchWith(['resources/views/a.blade.php'], { [name]: '# Rules\nUse Pest.\n' });
      assert.equal(ok(await developer(silent).report(DONE)).target, 'Agent review', `${name} without a mention`);
    }
  });

  it('the issue title alone can ask for screenshots', async () => {
    const { report } = developer(branchWith(['resources/views/a.blade.php']), { title: 'Dashboard (with screenshot)', description: 'Plain.' });
    assert.equal(refused(await report(DONE)).category, 'invalid_result');
  });

  it('does not check the verdict blocked', async () => {
    const { report } = developer(branchWith(['resources/views/a.blade.php']), ASKS);
    const blocked = await report({ verdict: 'blocked', summary: 'Stuck.', blockers: [{ description: 'No access', needs: 'access' }] });
    const control = developer(branchWith(['src/a.ts']), ASKS);
    const expected = ok(await control.report({ verdict: 'blocked', summary: 'Stuck.', blockers: [{ description: 'No access', needs: 'access' }] })).target;
    assert.equal(ok(blocked).target, expected, 'the same move as for a change without UI files');
  });

  it('does not check a result of another kind (test engineer)', async () => {
    const repo = branchWith(['resources/views/a.blade.php']);
    const { report } = developer(repo, { ...ASKS, role: 'tester' });
    const passed = await report({ verdict: 'passed', summary: 'ok', cases: [{ criterion: 'c', test: 't', status: 'passed' }] });
    if (!passed.ok) assert.doesNotMatch(passed.error.message, /screenshots_problem/, 'no screenshot rule for a test result');
  });

  it('pipeline.require_screenshots: always asks without a mention, never does not ask despite one', async () => {
    const always = developer(branchWith(['resources/views/a.blade.php']), { pipeline: { require_screenshots: 'always' }, description: 'Plain.' });
    assert.equal(refused(await always.report(DONE)).category, 'invalid_result');
    const never = developer(branchWith(['resources/views/a.blade.php']), { pipeline: { require_screenshots: 'never' }, ...ASKS });
    assert.equal(ok(await never.report(DONE)).target, 'Agent review');
  });

  it('pipeline.ui_paths and pipeline.screenshot_paths are honoured', async () => {
    const custom = { ui_paths: ['frontend/**'], screenshot_paths: ['shots/**'] };
    assert.equal(ok(await developer(branchWith(['resources/views/a.blade.php']), { pipeline: custom, ...ASKS }).report(DONE)).target, 'Agent review', 'not a UI file any more');
    assert.equal(refused(await developer(branchWith(['frontend/app.vue', 'docs/screenshots/a.png']), { pipeline: custom, ...ASKS }).report(DONE)).category, 'invalid_result', 'docs/screenshots no longer counts');
    assert.equal(ok(await developer(branchWith(['frontend/app.vue', 'shots/a.png']), { pipeline: custom, ...ASKS }).report(DONE)).target, 'Agent review');
    assert.equal(ok(await developer(branchWith(['resources/views/a.blade.php']), { pipeline: { ui_paths: [] }, ...ASKS }).report(DONE)).target, 'Agent review', 'empty ui_paths turn it off');
  });

  it('for an app in a subdirectory the defaults apply below it', async () => {
    const { report } = developer(branchWith(['shop/resources/views/a.blade.php']), { ...ASKS, appDirs: ['shop'] });
    assert.equal(refused(await report(DONE)).category, 'invalid_result');
    const shot = developer(branchWith(['shop/resources/views/a.blade.php', 'shop/docs/screenshots/a.png']), { ...ASKS, appDirs: ['shop'] });
    assert.equal(ok(await shot.report(DONE)).target, 'Agent review');
  });

  it('names at most a few UI files and counts the rest', async () => {
    const files = Array.from({ length: 9 }, (_, index) => `resources/views/page${index}.blade.php`);
    const { message } = refused(await developer(branchWith(files), ASKS).report(DONE));
    assert.ok((message.match(/resources\/views\/page\d\.blade\.php/g) ?? []).length < 9, 'the list is cut');
    assert.match(message, /more/);
  });

  it('is a tool_error, nothing recorded, when git cannot list the changed files', async () => {
    const notARepo = tempDir('symphony-shots-norepo-');
    const { report, tracker } = developer(notARepo, ASKS);
    assert.equal(refused(await report(DONE)).category, 'tool_error');
    assert.deepEqual(tracker.statusCalls, []);
  });
});

describe('#313 prompt: the screenshot instruction is its own numbered step', () => {
  const shipped = path.join(import.meta.dirname, '..', 'WORKFLOW.md');
  const toolbox = path.join(import.meta.dirname, '..', '.claude');

  async function render(role: string, type: string): Promise<string> {
    const { definition } = await loadWorkflowFile(shipped);
    const template = compilePrompt(definition.promptTemplate, definition.partials);
    assert.equal(template.parseError, null);
    const issue = makeIssue({
      id: 'PVTI_1',
      identifier: 'acme/app#42',
      title: 'Add invoices',
      description: 'Create an invoice resource.',
      state: 'In progress',
      labels: [type],
      native_ref: { provider: 'github_project', repository: 'acme/app', number: 42, parent: null, sub_issues: [], base_branch: null },
    });
    return renderPrompt(template, { issue: issueTemplateValue(issue, commandSkills([toolbox])), attempt: null, role, agents: [] });
  }

  for (const type of ['feature', 'bugfix', 'refactor']) {
    it(`developer (${type}): numbered step before the commit and pull request step, no block behind the steps`, async () => {
      const prompt = await render('developer', type);
      const step = /^(\d+)\. UI screenshots\./m.exec(prompt);
      assert.ok(step, 'a numbered "UI screenshots" step');
      const commit = /^(\d+)\. Commit with/m.exec(prompt);
      assert.ok(commit, 'the commit step');
      assert.ok(step.index < commit.index, 'before the commit step');
      assert.equal(Number(commit[1]), Number(step[1]) + 1, 'directly before it');
      assert.doesNotMatch(prompt, /^#+ UI screenshots/m, 'no block heading');
      assert.equal((prompt.match(/UI screenshots\. When the project/g) ?? []).length, 1, 'once');
      assert.match(prompt, /screenshots_problem/);
      const numbers = [...prompt.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]));
      assert.deepEqual(numbers, numbers.map((_, index) => index + 1), 'steps numbered without a gap');
    });
  }
});

describe('#313 git is only asked when the project asks for screenshots', () => {
  // A workspace without origin/HEAD (or no checkout at all) must not break the hand-off of a project that never asked
  // for screenshots: every developer `done` would end in tool_error otherwise.
  it('a project that does not ask for screenshots is accepted even when git cannot list the changed files', async () => {
    const { report, tracker } = developer(tempDir('symphony-shots-norepo-'), { description: 'A new page.' });
    assert.equal(ok(await report(DONE)).target, 'Agent review');
    assert.ok(tracker.statusCalls.length > 0);
  });

  it('policy never needs no git either', async () => {
    const { report } = developer(tempDir('symphony-shots-norepo-'), { pipeline: { require_screenshots: 'never' }, ...ASKS });
    assert.equal(ok(await report(DONE)).target, 'Agent review');
  });
});
