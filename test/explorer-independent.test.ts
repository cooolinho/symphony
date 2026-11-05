import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { pluginAgents } from '../src/workflow/command.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { sessionAgents, type RoleConfig } from '../src/workflow/roles.ts';
import type { EffectiveWorkflow } from '../src/workflow/store.ts';
import { validateDispatch } from '../src/workflow/validate.ts';

// Independent acceptance tests for #497 (E2-1): derived from the issue, not from the implementation.

const root = path.join(import.meta.dirname, '..');
const shipped = path.join(root, 'WORKFLOW.md');
const agentsDir = path.join(root, '.claude', 'agents');
const EXPLORER_ROLES = ['analyst', 'architect', 'auditor', 'autopilot', 'developer', 'planner'];
const READ_ONLY_ROLES = ['analyst', 'planner', 'auditor', 'architect'];

const env = { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' };

async function shippedConfig() {
  const { definition } = await loadWorkflowFile(shipped);
  return resolveConfig(definition.config, { workflowPath: shipped, env, trackerDefaults });
}

function frontMatter(text: string): string[] {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, 'front matter present');
  return (match[1] ?? '').split('\n');
}

describe('explorer subagent file (#497)', () => {
  const file = path.join(agentsDir, 'explorer.md');
  const text = fs.readFileSync(file, 'utf8');
  const front = frontMatter(text);
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  const entry = (key: string) => front.find((line) => line.startsWith(`${key}:`))?.slice(key.length + 1).trim();

  it('has only one-line key: value entries, no continuation lines or lists', () => {
    for (const line of front) assert.match(line, /^[A-Za-z][\w-]*: \S/, `not a one-line entry: ${line}`);
  });

  it('is named explorer, has no integration prefix', () => {
    assert.equal(entry('name'), 'explorer');
    assert.ok(!entry('name')?.includes('-'), 'no hyphenated integration prefix');
  });

  it('denies Edit, Write and NotebookEdit and pins sonnet, a low or medium effort and about 25 turns', () => {
    const denied = (entry('disallowedTools') ?? '').split(',').map((tool) => tool.trim());
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) assert.ok(denied.includes(tool), tool);
    assert.equal(entry('model'), 'sonnet');
    assert.match(entry('effort') ?? '', /^(low|medium)$/);
    const turns = Number(entry('maxTurns'));
    assert.ok(Number.isInteger(turns) && turns >= 20 && turns <= 30, `maxTurns ${turns}`);
  });

  it('is parsed by pluginAgents() as read-only with qualified name symphony:explorer', () => {
    const agent = pluginAgents([path.join(root, '.claude')]).find((a) => a.name === 'explorer');
    assert.ok(agent);
    assert.equal(agent.readOnly, true);
    assert.equal(agent.qualified, 'symphony:explorer');
  });

  it('routes with a trigger and an exclusion in the description', () => {
    const description = entry('description') ?? '';
    assert.match(description, /^Use before reading more than about ten files to find your way/);
    assert.match(description, /Not for a change you can finish in a handful of tool calls/);
  });

  it('demands 5 to 10 files as file:line, at most about 300 words, no file contents, and mentions CLAUDE.md', () => {
    assert.match(body, /\b5\b.{0,12}\b10\b/);
    assert.match(body, /file:line|path\/to\/file:line/);
    assert.match(body, /300 words/);
    assert.match(body, /no file contents/i);
    assert.match(body, /CLAUDE\.md/);
  });
});

describe('explorer in the shipped WORKFLOW.md (#497)', () => {
  it('is listed for exactly developer, architect, analyst, planner, autopilot and auditor', async () => {
    const config = await shippedConfig();
    const listed = (config.roles ?? []).filter((role) => role.agents?.includes('explorer')).map((role) => role.name).sort();
    assert.deepEqual(listed, EXPLORER_ROLES);
  });

  it('keeps the existing laravel-* entries of those roles', async () => {
    const config = await shippedConfig();
    const byName = Object.fromEntries((config.roles ?? []).map((role) => [role.name, role.agents ?? []])) as Record<string, string[]>;
    assert.ok(byName.developer?.includes('laravel-architect') && byName.developer?.includes('laravel-code-reviewer'));
    assert.ok(byName.auditor?.includes('laravel-code-reviewer'));
    for (const name of ['architect', 'analyst', 'planner', 'autopilot']) assert.ok(byName[name]?.includes('laravel-architect'), name);
  });

  it('leaves the roles with an empty agent list empty', async () => {
    const config = await shippedConfig();
    for (const name of ['issue-analyst', 'test-engineer', 'docs', 'reviewer', 'security-auditor', 'brain-gardener']) {
      assert.deepEqual((config.roles ?? []).find((role) => role.name === name)?.agents, [], name);
    }
  });

  it('passes dispatch validation without any subagent error, including the read-only roles', async () => {
    const config = await shippedConfig();
    for (const name of READ_ONLY_ROLES) assert.equal((config.roles ?? []).find((role) => role.name === name)?.readOnly, true, `${name} is read-only`);
    const errors = validateDispatch({ config } as unknown as EffectiveWorkflow, null, env).filter((error) => error.includes('.agents'));
    assert.deepEqual(errors, []);
  });

  it('validate rejects nothing for a read-only role listing the explorer, but still rejects a writing subagent', async () => {
    const config = await shippedConfig();
    const base = (config.roles ?? []).find((role) => role.name === 'analyst') as RoleConfig;
    const run = (agents: string[]) =>
      validateDispatch({ config: { ...config, roles: [{ ...base, readOnly: true, agents }] } } as unknown as EffectiveWorkflow, null, env).filter((error) =>
        error.includes('.agents'),
      );
    assert.deepEqual(run(['explorer']), []);
    assert.equal(run(['laravel-filament-developer']).length, 1);
  });
});

describe('explorer without the Laravel integration (#497)', () => {
  it('is allowed for every listed role, all five laravel-* agents are denied, and the deny rules never name the explorer', async () => {
    const config = await shippedConfig();
    const all = pluginAgents([path.join(root, '.claude')]);
    assert.equal(all.filter((agent) => agent.name.startsWith('laravel-')).length, 5);
    for (const name of EXPLORER_ROLES) {
      const role = (config.roles ?? []).find((entry) => entry.name === name) ?? null;
      const { allowed, denied } = sessionAgents(all, role, ['laravel-'], []);
      assert.ok(allowed.some((agent) => agent.name === 'explorer'), `${name}: explorer allowed`);
      assert.ok(!allowed.some((agent) => agent.name.startsWith('laravel-')), `${name}: no laravel-* allowed`);
      assert.deepEqual(
        denied.filter((agent) => agent.name.startsWith('laravel-')).map((agent) => agent.name).sort(),
        all.filter((agent) => agent.name.startsWith('laravel-')).map((agent) => agent.name).sort(),
        name,
      );
      // The names the worker passes to the session as denied agents (the ones that stay in `init.agents` but are refused).
      const deniedNames = denied.flatMap((agent) => [agent.qualified, agent.name]);
      assert.ok(!deniedNames.includes('explorer') && !deniedNames.includes('symphony:explorer'), name);
      assert.ok(deniedNames.includes('symphony:laravel-architect'), name);
    }
  });

  it('is allowed in a Laravel workspace too, next to the laravel-* agents of the role', async () => {
    const config = await shippedConfig();
    const all = pluginAgents([path.join(root, '.claude')]);
    const role = (config.roles ?? []).find((entry) => entry.name === 'developer') ?? null;
    const { allowed } = sessionAgents(all, role, ['laravel-'], ['laravel-']);
    assert.deepEqual(allowed.map((agent) => agent.name).sort(), [
      'explorer',
      'laravel-architect',
      'laravel-code-reviewer',
      'laravel-database-engineer',
      'laravel-filament-developer',
      'laravel-test-engineer',
    ]);
  });

  it('gives a read-only role the explorer but no writing subagent', async () => {
    const config = await shippedConfig();
    const all = pluginAgents([path.join(root, '.claude')]);
    for (const name of READ_ONLY_ROLES) {
      const role = (config.roles ?? []).find((entry) => entry.name === name) ?? null;
      const { allowed } = sessionAgents(all, role, ['laravel-'], ['laravel-']);
      assert.ok(allowed.some((agent) => agent.name === 'explorer'), name);
      assert.ok(allowed.every((agent) => agent.readOnly), name);
    }
  });

  it('does not give the explorer to a role with agents: []', () => {
    const all = pluginAgents([path.join(root, '.claude')]);
    const role = { agents: [], readOnly: false } as unknown as RoleConfig;
    assert.equal(sessionAgents(all, role, [], []).allowed.length, 0);
  });
});

describe('explorer docs (#497)', () => {
  it('docs/configuration.md and docs/laravel-subagents.md mention the framework-neutral explorer', () => {
    for (const doc of ['configuration.md', 'laravel-subagents.md']) {
      const text = fs.readFileSync(path.join(root, 'docs', doc), 'utf8');
      assert.match(text, /explorer/, doc);
      assert.match(text, /framework-neutral/i, doc);
    }
    const config = fs.readFileSync(path.join(root, 'docs', 'configuration.md'), 'utf8');
    const start = config.indexOf('#### Subagents per role');
    assert.ok(start >= 0, 'section exists');
    const end = config.indexOf('\n#### ', start + 5);
    assert.match(config.slice(start, end), /explorer/);
  });
});
