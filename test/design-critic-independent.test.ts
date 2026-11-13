import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { commandSkills, pluginAgents } from '../src/workflow/command.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { sessionAgents } from '../src/workflow/roles.ts';
import type { EffectiveWorkflow } from '../src/workflow/store.ts';
import { compilePrompt, issueTemplateValue, renderPrompt } from '../src/workflow/template.ts';
import { validateDispatch } from '../src/workflow/validate.ts';
import { makeIssue } from './helpers.ts';

// Independent acceptance tests for #504 (E3-2): derived from the issue, not from the implementation.

const root = path.join(import.meta.dirname, '..');
const shipped = path.join(root, 'WORKFLOW.md');
const toolbox = path.join(root, '.claude');
const env = { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' };
const OTHER_ROLES = ['developer', 'auditor', 'analyst', 'planner', 'autopilot'];

async function shippedConfig() {
  const { definition } = await loadWorkflowFile(shipped);
  return resolveConfig(definition.config, { workflowPath: shipped, env, trackerDefaults });
}

async function renderRole(role: string, labels: string[], agents: Array<{ name: string; description: string }>) {
  const { definition } = await loadWorkflowFile(shipped);
  const template = compilePrompt(definition.promptTemplate, definition.partials);
  assert.equal(template.parseError, null);
  const base = makeIssue({
    id: 'PVTI_7',
    identifier: 'acme/app#7',
    title: 'A change',
    labels,
    native_ref: { provider: 'github_project', repository: 'acme/app', number: 7, parent: null, sub_issues: [], base_branch: null },
  });
  const subject = { ...base, labels, native_ref: { ...base.native_ref, base_branch: 'develop' } };
  return renderPrompt(template, { issue: issueTemplateValue(subject, commandSkills([toolbox])), attempt: null, role, agents, round: 1 });
}

/** What the worker hands the prompt: every plugin agent the architect may start, qualified. */
function allowedForArchitect(config: Awaited<ReturnType<typeof shippedConfig>>, prefixes: string[]) {
  const role = (config.roles ?? []).find((entry) => entry.name === 'architect') ?? null;
  const { allowed } = sessionAgents(pluginAgents([toolbox]), role, prefixes, prefixes);
  return allowed.map((agent) => ({ name: agent.qualified, description: agent.description }));
}

describe('design-critic.md (#504)', () => {
  const text = fs.readFileSync(path.join(toolbox, 'agents', 'design-critic.md'), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(match, 'front matter present');
  const front = (match[1] ?? '').split('\n');
  const body = match[2] ?? '';
  const entry = (key: string) => front.find((line) => line.startsWith(`${key}:`))?.slice(key.length + 1).trim();

  it('is named design-critic without an integration prefix', () => {
    assert.equal(entry('name'), 'design-critic');
    assert.ok(fs.existsSync(path.join(toolbox, 'agents', 'design-critic.md')));
  });

  it('denies Edit, Write and NotebookEdit', () => {
    const denied = (entry('disallowedTools') ?? '').split(',').map((tool) => tool.trim());
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) assert.ok(denied.includes(tool), tool);
  });

  it('runs on opus, i.e. not on the fable model of the L/XL architect', async () => {
    assert.equal(entry('model'), 'opus');
    const config = await shippedConfig();
    const architect = (config.roles ?? []).find((role) => role.name === 'architect');
    assert.notEqual(architect?.claude?.modelByComplexity?.L, entry('model'));
    assert.notEqual(architect?.claude?.modelByComplexity?.XL, entry('model'));
  });

  it('caps the turns with a positive integer maxTurns', () => {
    const turns = Number(entry('maxTurns'));
    assert.ok(Number.isInteger(turns) && turns > 0 && turns <= 80, `maxTurns ${entry('maxTurns')}`);
  });

  it('has a description with a trigger (L/XL, before report_result) and an exclusion', () => {
    const description = entry('description') ?? '';
    assert.match(description, /^Use /);
    assert.match(description, /L or XL|L\/XL/);
    assert.match(description, /report_result/);
    assert.match(description, /\bNot for\b/);
    assert.match(description, /S\/M|small|new design|alternative design/i);
  });

  it('asks for a critique: file:line, severity, what breaks, and forbids a new design', () => {
    assert.match(body, /file:line/);
    assert.match(body, /severity/i);
    assert.match(body, /what breaks|breaks/i);
    assert.match(body, /(do not design|no new design)/i);
    assert.match(body, /secret/i);
  });

  it('is parsed by pluginAgents() as a read-only symphony:design-critic', () => {
    const agent = pluginAgents([toolbox]).find((candidate) => candidate.name === 'design-critic');
    assert.ok(agent);
    assert.equal(agent.qualified, 'symphony:design-critic');
    assert.equal(agent.readOnly, true);
  });

  it('keeps laravel-architect in the toolbox, unchanged in its role as a designer', () => {
    const persona = fs.readFileSync(path.join(toolbox, 'agents', 'laravel-architect.md'), 'utf8');
    assert.match(persona, /^name: laravel-architect$/m);
  });
});

describe('architect allowlist (#504)', () => {
  it('lists exactly design-critic for the architect (E2-5: no explorer)', async () => {
    const config = await shippedConfig();
    assert.deepEqual((config.roles ?? []).find((role) => role.name === 'architect')?.agents, ['design-critic']);
  });

  it('keeps laravel-architect for developer, auditor, analyst, planner and autopilot', async () => {
    const config = await shippedConfig();
    for (const name of OTHER_ROLES) {
      assert.ok((config.roles ?? []).find((role) => role.name === name)?.agents?.includes('laravel-architect'), name);
    }
  });

  it('gives design-critic to no other role', async () => {
    const config = await shippedConfig();
    for (const role of config.roles ?? []) {
      if (role.name !== 'architect') assert.ok(!role.agents?.includes('design-critic'), role.name);
    }
  });

  it('keeps the architect read-only and passes dispatch validation', async () => {
    const config = await shippedConfig();
    assert.equal((config.roles ?? []).find((role) => role.name === 'architect')?.readOnly, true);
    const errors = validateDispatch({ config } as unknown as EffectiveWorkflow, null, env);
    assert.deepEqual(errors.filter((error) => error.includes('.agents')), []);
  });

  it('lets the architect session start exactly the critic (E2-5), with and without the Laravel integration', async () => {
    const config = await shippedConfig();
    for (const prefixes of [['laravel-'], []]) {
      assert.deepEqual(allowedForArchitect(config, prefixes).map((agent) => agent.name).sort(), ['symphony:design-critic'], prefixes.join());
    }
  });
});

describe('architect prompt gate (#504)', () => {
  const agents = [
    { name: 'symphony:explorer', description: 'Maps the code.' },
    { name: 'symphony:design-critic', description: 'Critiques a draft.' },
  ];

  for (const label of ['complexity: l', 'complexity: xl', 'Complexity: L']) {
    it(`names the critic at ${label}: once, on the draft, before report_result`, async () => {
      const text = await renderRole('architect', ['feature', label], agents);
      assert.match(text, /symphony:design-critic/);
      const line = text.split('\n').find((candidate) => /^- /.test(candidate) && /start `symphony:design-critic`/.test(candidate)) ?? '';
      assert.ok(line, 'a delegation bullet starts the critic');
      assert.match(line, /once/);
      assert.match(line, /draft/);
      assert.match(line, /before `report_result`/);
      assert.match(line, /Not for/);
    });
  }

  for (const labels of [['feature', 'complexity: m'], ['feature', 'complexity: s'], ['feature', 'Complexity: M'], ['feature']]) {
    it(`never names the critic for [${labels.join(', ')}] and keeps the explorer bullet`, async () => {
      const text = await renderRole('architect', labels, agents);
      assert.doesNotMatch(text, /design-critic/);
      assert.match(text, /start 2–3 `symphony:explorer` calls/);
    });
  }

  it('no longer sends the architect to laravel-architect at any size', async () => {
    for (const label of ['complexity: s', 'complexity: m', 'complexity: l', 'complexity: xl']) {
      const text = await renderRole('architect', ['feature', label], agents);
      assert.doesNotMatch(text, /laravel-architect/, label);
    }
  });

  it('renders the prompt the shipped architect would see (real allowlist, real toolbox) per size', async () => {
    const config = await shippedConfig();
    for (const prefixes of [['laravel-'], []]) {
      const listed = allowedForArchitect(config, prefixes);
      const large = await renderRole('architect', ['feature', 'complexity: l'], listed);
      const medium = await renderRole('architect', ['feature', 'complexity: m'], listed);
      assert.match(large, /symphony:design-critic/, prefixes.join());
      assert.doesNotMatch(medium, /design-critic/, prefixes.join());
      assert.doesNotMatch(large + medium, /laravel-architect/, prefixes.join());
    }
  });

  it('does not mention the critic in the prompt of any other role, at L', async () => {
    const all = pluginAgents([toolbox]).map((agent) => ({ name: agent.qualified, description: agent.description }));
    for (const role of ['developer', 'analyst', 'auditor', 'planner']) {
      const listed = all.filter((agent) => !agent.name.endsWith(':design-critic'));
      const text = await renderRole(role, ['feature', 'complexity: l'], listed);
      assert.doesNotMatch(text, /design-critic/, role);
    }
  });

  it('still tells the developer and the analyst about laravel-architect', async () => {
    const all = pluginAgents([toolbox]).map((agent) => ({ name: agent.qualified, description: agent.description }));
    for (const role of ['developer', 'analyst']) {
      const text = await renderRole(role, ['feature', 'complexity: m'], all);
      assert.match(text, /symphony:laravel-architect/, role);
    }
  });
});

describe('design-critic docs (#504)', () => {
  const read = (file: string) => fs.readFileSync(path.join(root, 'docs', file), 'utf8');
  const section = (text: string, heading: string) => {
    const start = text.indexOf(heading);
    assert.ok(start >= 0, `${heading} exists`);
    const next = text.slice(start + heading.length).search(/\n#{2,4} /);
    return next < 0 ? text.slice(start) : text.slice(start, start + heading.length + next);
  };

  it('docs/configuration.md#the-architect lists design-critic and drops laravel-architect and the explorer', () => {
    const architect = section(read('configuration.md'), '### The architect');
    assert.match(architect, /agents: \[design-critic\]/);
    assert.match(architect, /design-critic/);
    assert.match(architect, /L\/XL|L or XL/);
    assert.match(architect, /opus/);
    assert.match(architect, /maxTurns/);
    assert.match(architect, /no longer uses `laravel-architect`/);
    assert.doesNotMatch(architect, /agents: \[laravel-architect\]/);
    assert.doesNotMatch(architect, /It may start the `laravel-architect`/);
  });

  it('docs/laravel-subagents.md names the critic for the architect and says the architect no longer uses laravel-architect', () => {
    const text = read('laravel-subagents.md');
    const row = text.split('\n').find((line) => /^\| architect \|/.test(line)) ?? '';
    assert.match(row, /design-critic/);
    assert.match(row, /explorer/);
    assert.doesNotMatch(row, /`laravel-architect`\s*\|/);
    assert.match(text, /architect no longer uses `laravel-architect`/);
    assert.match(text, /opus/);
  });
});
