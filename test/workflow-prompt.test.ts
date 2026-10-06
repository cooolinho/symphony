import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { commandSkills } from '../src/workflow/command.ts';
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
  },
});

/** Symphony's own plugin: the skills behind the issue commands. */
const toolbox = path.join(import.meta.dirname, '..', '.claude');

async function render(role: string, attempt: number | null = null, description?: string): Promise<string> {
  const { definition } = await loadWorkflowFile(shipped);
  const template = compilePrompt(definition.promptTemplate);
  assert.equal(template.parseError, null);
  const subject = description === undefined ? issue : { ...issue, description };
  return renderPrompt(template, { issue: issueTemplateValue(subject, commandSkills([toolbox])), attempt, role });
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
    assert.equal(auditor?.claude.model, 'opus');
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
      ['refactor-safely', 'symphony:refactor-safely'],
      ['refactoring', 'symphony:refactoring'],
    ]);
    const { definition } = await loadWorkflowFile(shipped);
    const roles = definition.config.roles as Record<string, { commands?: string[] }>;
    for (const command of Object.values(roles).flatMap((role) => role.commands ?? [])) {
      assert.ok(names.includes(command), `skill for /${command}`);
    }
  });

  for (const name of names) {
    it(`${name}: SKILL.md names the skill like its directory and links only to existing files`, () => {
      const text = fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8');
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
      assert.equal(/^name:\s*(.+)$/m.exec(front)?.[1]?.trim(), name);
      assert.match(front, /^description:\s*\S/m);
      assert.match(front, /nur laden|Nur laden/, 'description limits when the skill loads');
      for (const [, target] of text.matchAll(/\]\(([^)#]+\.md)\)/g)) {
        assert.ok(fs.existsSync(path.join(skillsDir, name, target as string)), `${name}/${target}`);
      }
    });
  }
});
