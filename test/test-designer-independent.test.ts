import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { commandSkills, pluginAgents } from '../src/workflow/command.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { sessionAgents, type RoleConfig } from '../src/workflow/roles.ts';
import type { EffectiveWorkflow } from '../src/workflow/store.ts';
import { compilePrompt, issueTemplateValue, renderPrompt } from '../src/workflow/template.ts';
import { validateDispatch } from '../src/workflow/validate.ts';
import { makeIssue } from './helpers.ts';

// Independent acceptance tests for #506 (E3-6): derived from the issue, not from the implementation.

const root = path.join(import.meta.dirname, '..');
const shipped = path.join(root, 'WORKFLOW.md');
const toolbox = path.join(root, '.claude');
const env = { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' };

async function shippedConfig() {
  const { definition } = await loadWorkflowFile(shipped);
  return resolveConfig(definition.config, { workflowPath: shipped, env, trackerDefaults });
}

describe('test-designer.md (#506)', () => {
  const text = fs.readFileSync(path.join(toolbox, 'agents', 'test-designer.md'), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(match, 'front matter present');
  const front = (match[1] ?? '').split('\n');
  const body = match[2] ?? '';
  const entry = (key: string) => front.find((line) => line.startsWith(`${key}:`))?.slice(key.length + 1).trim();

  it('has a one-line front matter with only the allowed keys and no disallowedTools or tools (a writer)', () => {
    const keys = front.map((line) => /^([A-Za-z][\w-]*): \S/.exec(line)?.[1]);
    assert.ok(keys.every((key) => key !== undefined), 'every line is a one-line entry');
    assert.deepEqual([...keys].sort(), ['description', 'maxTurns', 'model', 'name']);
    assert.equal(entry('name'), 'test-designer');
    assert.equal(entry('model'), 'sonnet');
    assert.equal(entry('maxTurns'), '50');
  });

  it('is read by pluginAgents as a writer without a prefix', () => {
    const agent = pluginAgents([toolbox]).find((a) => a.name === 'test-designer');
    assert.ok(agent);
    assert.equal(agent.readOnly, false);
    assert.equal(agent.qualified, 'symphony:test-designer');
  });

  it('has a trigger and an exclusion in the description', () => {
    const description = entry('description') ?? '';
    assert.match(description, /^Use at complexity L or XL/);
    assert.match(description, /Not for /);
    assert.doesNotMatch(description, /laravel/i);
  });

  it('tells the designer to use only criteria and public interface and never read the diff', () => {
    assert.match(body, /acceptance criteria|criteria/i);
    assert.match(body, /public interface/i);
    assert.match(body, /Do not run `git diff`/);
  });

  it('demands RED at the base commit in a separate worktree and GREEN on the branch, both reported with output', () => {
    assert.match(body, /RED/);
    assert.match(body, /GREEN/);
    assert.match(body, /git worktree add --detach/);
    assert.match(body, /base commit/);
    assert.match(body, /RED command with an output excerpt/);
    assert.match(body, /GREEN command with an output excerpt/);
  });

  it('forbids fixing production code and committing', () => {
    assert.match(body, /Never fix production code/);
    assert.match(body, /never commit or push/);
  });
});

describe('test designer in the shipped WORKFLOW.md (#506)', () => {
  it('lists exactly test-designer for the test engineer, a writing role', async () => {
    const config = await shippedConfig();
    const role = (config.roles ?? []).find((entry) => entry.name === 'test-engineer');
    assert.deepEqual(role?.agents, ['test-designer']);
    assert.equal(role?.readOnly, false);
  });

  it('is listed for no other role', async () => {
    const config = await shippedConfig();
    const listed = (config.roles ?? []).filter((role) => role.agents?.includes('test-designer')).map((role) => role.name);
    assert.deepEqual(listed, ['test-engineer']);
  });

  it('passes dispatch validation without subagent errors', async () => {
    const config = await shippedConfig();
    const errors = validateDispatch({ config } as unknown as EffectiveWorkflow, null, env).filter((error) => error.includes('.agents'));
    assert.deepEqual(errors, []);
  });

  it('is still rejected for a read-only role', async () => {
    const config = await shippedConfig();
    const base = (config.roles ?? []).find((role) => role.name === 'test-engineer') as RoleConfig;
    const errors = validateDispatch({ config: { ...config, roles: [{ ...base, readOnly: true }] } } as unknown as EffectiveWorkflow, null, env).filter((error) =>
      error.includes('.agents'),
    );
    assert.equal(errors.length, 1);
  });

  it('is the only subagent the test engineer may start, in any workspace', async () => {
    const config = await shippedConfig();
    const all = pluginAgents([toolbox]);
    const role = (config.roles ?? []).find((entry) => entry.name === 'test-engineer') ?? null;
    for (const prefixes of [['laravel-'], []]) {
      const { allowed } = sessionAgents(all, role, prefixes, prefixes);
      assert.deepEqual(allowed.map((agent) => agent.name), ['test-designer']);
    }
  });
});

describe('test-engineer prompt and the designer brief (#506)', () => {
  const designer = [{ name: 'symphony:test-designer', description: 'Writes tests.' }];
  const design = {
    verdict: 'ready', summary: 's', decision: '', compatibility: '', interfaces: ['POST /invoices', 'App\\Invoice::export(): string'],
    components: ['app/Secret/InternalThing.php'], migrations: [], options: [], plan: ['edit app/Secret/InternalThing.php'], tests: [], work_packages: [], head_sha: null,
  };

  async function render(labels: string[], agents = designer, results: Record<string, unknown> = {}): Promise<string> {
    const { definition } = await loadWorkflowFile(shipped);
    const template = compilePrompt(definition.promptTemplate, definition.partials);
    const subject = makeIssue({ id: 'PVTI_1',
      identifier: 'acme/app#42', title: 'Add invoices', description: 'Create invoices.', labels,
      native_ref: { provider: 'github_project', repository: 'acme/app', number: 42, parent: null, sub_issues: [], base_branch: 'main' },
    });
    return renderPrompt(template, {
      issue: issueTemplateValue(subject, commandSkills([toolbox])), attempt: null, role: 'test-engineer', agents, round: 1,
      test_paths: ['tests/**', '**/*Test.php'], results: { latest: [], open_findings: [], failed_cases: [], ...results },
    });
  }

  for (const label of ['complexity: l', 'complexity: xl']) {
    it(`at ${label} the brief carries criteria, interface, path, base commit and test paths`, async () => {
      const text = await render(['feature', label], designer, { design });
      assert.match(text, /acceptance criteria of the group/);
      assert.match(text, /- POST \/invoices/);
      assert.match(text, /- App\\Invoice::export\(\): string/);
      assert.match(text, /absolute workspace path/);
      assert.match(text, /git merge-base HEAD origin\/main/);
      assert.match(text, /`tests\/\*\*`, `\*\*\/\*Test\.php`/);
      assert.match(text, /one call per group of acceptance criteria/);
      assert.match(text, /no diff, no changed files and no implementation paths/);
    });

    it(`at ${label} the architect's components and plan are not rendered into the brief block`, async () => {
      const text = await render(['feature', label], designer, { design });
      assert.doesNotMatch(text, /InternalThing/);
    });
  }

  it('at L the path rule for the designer is stated', async () => {
    const text = await render(['feature', 'complexity: l'], designer, { design });
    assert.match(text, /test paths/);
    assert.match(text, /`report_result` checks them as yours/);
  });

  it('at M the designer is not mentioned and the prompt equals the one without the agent', async () => {
    const withAgent = await render(['feature', 'complexity: m']);
    assert.doesNotMatch(withAgent, /test-designer|no diff, no changed files/);
    assert.equal(withAgent, await render(['feature', 'complexity: m'], []));
  });

  it('with no complexity label the prompt is unchanged', async () => {
    const withAgent = await render(['feature']);
    assert.equal(withAgent, await render(['feature'], []));
  });

  it('keeps the existing S/M step 4 text', async () => {
    const text = await render(['feature', 'complexity: m']);
    assert.match(text, /4\. Write at least one test for every acceptance criterion, plus the edge cases it implies\./);
  });
});

describe('test designer docs (#506)', () => {
  const config = fs.readFileSync(path.join(root, 'docs', 'configuration.md'), 'utf8');
  const start = config.indexOf('#### The test engineer');
  const section = config.slice(start, config.indexOf('\n#### ', start + 5));

  it('the-test-engineer section exists and shows agents: [test-designer]', () => {
    assert.ok(start >= 0);
    assert.match(section, /agents: \[test-designer\]/);
    assert.doesNotMatch(section, /agents: \[\]/);
  });

  it('says the boundary is soft: the brief only, no enforced read boundary', () => {
    assert.match(section, /soft/i);
    assert.match(section, /brief/);
    assert.match(section, /open question 11/);
    assert.match(section, /no diff, no changed files/);
  });

  it('no longer claims test-engineer has an empty agents list', () => {
    const sub = config.slice(config.indexOf('#### Subagents per role'));
    assert.doesNotMatch(sub, /`test-engineer`[^`]*and `security-auditor` with `\[\]`/);
    assert.doesNotMatch(sub, /`issue-analyst`, `test-engineer`/);
  });
});
