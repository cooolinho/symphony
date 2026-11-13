import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { commandSkills, pluginAgents } from '../src/workflow/command.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { sessionAgents } from '../src/workflow/roles.ts';
import { compilePrompt, issueTemplateValue, renderPrompt } from '../src/workflow/template.ts';
import { makeIssue } from './helpers.ts';

// Independent acceptance tests for #503 (E3-1): derived from the issue, not from the implementation.

const root = path.join(import.meta.dirname, '..');
const shipped = path.join(root, 'WORKFLOW.md');
const toolbox = path.join(root, '.claude');
const env = { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' };

type Agent = { name: string; description: string };
const explorer: Agent = { name: 'symphony:explorer', description: 'Maps the code.' };
const laravel: Agent = { name: 'symphony:laravel-code-reviewer', description: 'Reviews a diff before handoff.' };
const spec: Agent = { name: 'symphony:spec-reviewer', description: 'Reviews against the spec.' };

async function renderRole(role: string, labels: string[], agents: Agent[]): Promise<string> {
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

const developer = (labels: string[], agents: Agent[]) => renderRole('developer', labels, agents);

describe('developer prompt: size-gated self-review (#503)', () => {
  it('L and XL: instruction before the first git push with the brief from the issue', async () => {
    for (const complexity of ['complexity: l', 'complexity: xl']) {
      const text = await developer(['feature', complexity], [explorer, spec]);
      assert.match(text, /before the first `git push`/, complexity);
      assert.match(text, /correctness gaps/, complexity);
      assert.match(text, /skip style/, complexity);
      assert.match(text, /file:line/, complexity);
      assert.match(text, /command with its output/, complexity);
      assert.match(text, /read-only/, complexity);
      assert.match(text, /acceptance criteria/, complexity);
      // the review comes before the push instruction of the steps
      assert.ok(text.indexOf('before the first `git push`') < text.indexOf('git push -u origin'), complexity);
    }
  });

  it('S, M and no complexity: no review instruction, no reviewer named, no reviewer in the list', async () => {
    for (const labels of [['feature', 'complexity: s'], ['feature', 'complexity: m'], ['bug']]) {
      const text = await developer(labels, [explorer, laravel, spec]);
      assert.doesNotMatch(text, /spec-reviewer/, labels.join());
      assert.doesNotMatch(text, /laravel-code-reviewer/, labels.join());
      assert.doesNotMatch(text, /before the first `git push`/, labels.join());
      assert.doesNotMatch(text, /correctness gaps/, labels.join());
      assert.match(text, /`symphony:explorer`/, labels.join());
    }
  });

  it('S/M with only reviewers allowed: the developer gets no agent intro at all', async () => {
    for (const label of ['complexity: s', 'complexity: m']) {
      const text = await developer(['feature', label], [spec]);
      assert.doesNotMatch(text, /Subagents you can start/, label);
      assert.doesNotMatch(text, /spec-reviewer/, label);
      const laravelOnly = await developer(['feature', label], [laravel]);
      assert.doesNotMatch(laravelOnly, /Subagents you can start/, label);
      assert.doesNotMatch(laravelOnly, /laravel-code-reviewer/, label);
    }
  });

  it('L without any reviewer agent: no review bullet is invented', async () => {
    const text = await developer(['feature', 'complexity: l'], [explorer]);
    assert.doesNotMatch(text, /before the first `git push`/);
    assert.doesNotMatch(text, /correctness gaps/);
    assert.doesNotMatch(text, /spec-reviewer|laravel-code-reviewer/);
  });

  it('Laravel workspace: names laravel-code-reviewer exactly once as reviewer, never spec-reviewer', async () => {
    const text = await developer(['feature', 'complexity: xl'], [explorer, laravel, spec]);
    assert.doesNotMatch(text, /spec-reviewer/);
    const mentions = text.match(/symphony:laravel-code-reviewer/g) ?? [];
    // once in the agent list, once in the bullet, once in the step-8 pointer
    assert.ok(mentions.length >= 2 && mentions.length <= 3, `mentions: ${mentions.length}`);
  });

  it('non-Laravel workspace: names spec-reviewer as the reviewer', async () => {
    const text = await developer(['feature', 'complexity: l'], [explorer, spec]);
    assert.doesNotMatch(text, /laravel-code-reviewer/);
    assert.match(text, /start `symphony:spec-reviewer`/);
  });

  it('only the reviewer in the agent list is named, whatever the order', async () => {
    const text = await developer(['feature', 'complexity: l'], [spec, laravel, explorer]);
    assert.match(text, /start `symphony:laravel-code-reviewer`/);
    assert.doesNotMatch(text, /spec-reviewer/);
  });

  it('other roles keep their view: reviewer and auditor still list laravel-code-reviewer at S/M', async () => {
    for (const role of ['reviewer', 'auditor']) {
      const text = await renderRole(role, ['feature', 'complexity: s'], [explorer, laravel]);
      assert.match(text, /^- `symphony:laravel-code-reviewer`:/m, role);
    }
  });

  it('is not framed as a review of follow-up work and runs once', async () => {
    const text = await developer(['feature', 'complexity: l'], [explorer, spec]);
    const bullet = text.split('\n').find((line) => line.includes('before the first `git push`')) ?? '';
    assert.match(bullet, /once/);
    assert.match(bullet, /no second call/);
    assert.match(bullet, /[Nn]ot for/);
  });
});

describe('spec-reviewer.md (#503)', () => {
  const file = path.join(toolbox, 'agents', 'spec-reviewer.md');

  it('exists without a prefix and is read-only on opus with a bounded maxTurns', () => {
    assert.ok(fs.existsSync(file));
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(fs.readFileSync(file, 'utf8'));
    assert.ok(match);
    const front = Object.fromEntries((match[1] ?? '').split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]));
    assert.equal(front.name, 'spec-reviewer');
    assert.equal(front.model, 'opus');
    const turns = Number(front.maxTurns);
    assert.ok(Number.isInteger(turns) && turns > 0 && turns <= 80, String(front.maxTurns));
    const denied = String(front.disallowedTools).split(',').map((tool) => tool.trim());
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) assert.ok(denied.includes(tool), tool);
    // trigger and exclusion
    assert.match(String(front.description), /Use (at|when|for)/);
    assert.match(String(front.description), /Not for/);
    assert.match(String(front.description), /L or XL|L\/XL/);
    // framework-neutral: no Laravel wording that would make it look like a laravel-* persona
    assert.doesNotMatch(String(front.description), /laravel/i);
    // the body follows the official minimal reviewer and asks for file:line
    const body = match[2] ?? '';
    assert.match(body, /You're reviewing code you didn't write/);
    assert.match(body, /file/);
    assert.match(body, /style/i);
  });

  it('is available in a workspace without the Laravel integration and read-only for read-only roles', () => {
    const all = pluginAgents([toolbox]);
    const agent = all.find((entry) => entry.name === 'spec-reviewer');
    assert.ok(agent);
    assert.equal(agent.readOnly, true);
    const { allowed } = sessionAgents(all, null, ['laravel-'], []);
    assert.ok(allowed.some((entry) => entry.qualified === 'symphony:spec-reviewer'));
  });

  it('is listed in the developer agents of the shipped WORKFLOW.md only', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const config = resolveConfig(definition.config, { workflowPath: shipped, env, trackerDefaults });
    const holders = (config.roles ?? []).filter((role) => role.agents?.includes('spec-reviewer')).map((role) => role.name);
    assert.deepEqual(holders, ['developer']);
    const dev = (config.roles ?? []).find((role) => role.name === 'developer');
    assert.ok(dev?.agents?.includes('laravel-code-reviewer'), 'laravel-code-reviewer stays for the developer');
  });

  it('a read-only role (reviewer) is not offered the developer-only spec-reviewer', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const config = resolveConfig(definition.config, { workflowPath: shipped, env, trackerDefaults });
    const reviewer = (config.roles ?? []).find((role) => role.name === 'reviewer') ?? null;
    const { allowed } = sessionAgents(pluginAgents([toolbox]), reviewer, [], []);
    assert.ok(!allowed.some((entry) => entry.name === 'spec-reviewer'));
  });
});

describe('docs for the size gate (#503)', () => {
  const docs = path.join(root, 'docs');
  const configuration = fs.readFileSync(path.join(docs, 'configuration.md'), 'utf8');
  const laravelDoc = fs.readFileSync(path.join(docs, 'laravel-subagents.md'), 'utf8');

  it('configuration.md#subagents-per-role describes spec-reviewer and the L/XL gate', () => {
    const start = configuration.indexOf('#### Subagents per role');
    assert.ok(start >= 0);
    const next = configuration.indexOf('\n#### ', start + 10);
    const section = configuration.slice(start, next < 0 ? undefined : next);
    assert.match(section, /spec-reviewer/);
    assert.match(section, /laravel-code-reviewer/);
    assert.match(section, /before the first `git push`/);
    assert.match(section, /L\/XL|L or XL/);
    assert.match(section, /S\/M/);
  });

  it('laravel-subagents.md describes spec-reviewer and the gate', () => {
    assert.match(laravelDoc, /spec-reviewer/);
    assert.match(laravelDoc, /before the first `git push`/);
    assert.match(laravelDoc, /S\/M/);
  });
});
