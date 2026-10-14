import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Logger } from '../src/log.ts';
import { STANDARD_LABELS } from '../src/repo-init/labels.ts';
import { githubProjectFactory } from '../src/tracker/github-project/index.ts';
import { parseSettings } from '../src/tracker/github-project/settings.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { commandSkills, pluginAgents } from '../src/workflow/command.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { roleFor, roleName } from '../src/workflow/roles.ts';
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

/** Symphony's own plugin: the skills behind the issue commands. */
const toolbox = path.join(import.meta.dirname, '..', '.claude');

async function render(
  role: string,
  attempt: number | null = null,
  description?: string,
  baseBranch: string | null = null,
  agents: Array<{ name: string; description: string }> = [],
): Promise<string> {
  const { definition } = await loadWorkflowFile(shipped);
  const template = compilePrompt(definition.promptTemplate);
  assert.equal(template.parseError, null);
  const subject = {
    ...issue,
    ...(description !== undefined ? { description } : {}),
    native_ref: { ...issue.native_ref, base_branch: baseBranch },
  };
  return renderPrompt(template, { issue: issueTemplateValue(subject, commandSkills([toolbox])), attempt, role, agents });
}

describe('shipped WORKFLOW.md', () => {
  it('resolves to the developer and reviewer roles with entry checks', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const config = resolveConfig(definition.config, {
      workflowPath: shipped,
      env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' },
      trackerDefaults,
    });
    assert.equal(roleName(roleFor({ state: 'Ready', description: null }, config.roles)), 'developer');
    assert.equal(roleName(roleFor({ state: 'In progress', description: null }, config.roles)), 'developer');
    assert.equal(roleName(roleFor({ state: 'Agent review', description: null }, config.roles)), 'reviewer');
    assert.equal(config.agent.maxContinuations, 6);
  });

  it('renders the developer prompt with short tool names and the check handling', async () => {
    const prompt = await render('developer');
    assert.match(prompt, /acme\/app#42\*\*: Add invoices/);
    assert.match(prompt, /Your role: developer/);
    assert.match(prompt, /`get_issue`/);
    assert.match(prompt, /`open_pull_request`/);
    assert.match(prompt, /Integrate the base branch before requesting review/);
    assert.match(prompt, /set_status\("Agent review"\)/);
    assert.match(prompt, /`check_failed`.*Fix the problems/);
    assert.match(prompt, /`check_error`.*set_status\("Blocked"\)/);
    assert.match(prompt, /end your turn/);
    assert.match(prompt, /git push -u origin symphony\/issue-42/);
    assert.match(prompt, /Closes #42/);
    assert.doesNotMatch(prompt, /mcp__tracker__/);
    assert.doesNotMatch(prompt, /Your role: reviewer/);
    assert.doesNotMatch(prompt, /model: opus/);
    assert.doesNotMatch(prompt, /effort: high/);
  });

  it('renders the read-only reviewer prompt with the checklist and round limit', async () => {
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
    assert.match(prompt, /## Agent review \(round N\)/);
    assert.match(prompt, /set_status\("In review"\)/);
    assert.match(prompt, /set_status\("In progress"\)/);
    assert.match(prompt, /N is 3 or more/);
    assert.match(prompt, /Attempt 2/);
    assert.doesNotMatch(prompt, /mcp__tracker__/);
    assert.doesNotMatch(prompt, /Your role: developer/);
  });

  it('falls back to the single-agent prompt for the default role', async () => {
    const prompt = await render('default');
    assert.match(prompt, /## How to work/);
    assert.match(prompt, /Move the issue to "In review" with `mcp__tracker__set_status`/);
    assert.doesNotMatch(prompt, /Your role:/);
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
      assert.equal(roleName(roleOf(state, '/refactor-safely\n\nBlocked by #3')), 'developer');
      assert.equal(roleName(roleOf(state, 'Add a /refactoring page')), 'developer');
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
      assert.equal(roleName(roleOf(state, 'Write a /concept page')), 'developer');
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
      assert.equal(roleName(roleOf(state, 'Write a /plan page')), 'developer');
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
    assert.deepEqual(on.settings?.autoMerge, { onEnter: 'In review', doneState: 'Done', onConflict: 'In progress', method: 'SQUASH', optOutLabel: 'manual-merge' });
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
    assert.match(await render('developer', null, undefined, null, agents), /before you hand off with `set_status\("Agent review"\)`/);
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
      developer: ['laravel-architect', 'laravel-database-engineer', 'laravel-filament-developer', 'laravel-test-engineer', 'laravel-code-reviewer'],
      reviewer: ['laravel-code-reviewer'],
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
