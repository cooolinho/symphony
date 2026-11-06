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

// Independent acceptance tests for #505 (E3-3): derived from the issue, not from the implementation.

const root = path.join(import.meta.dirname, '..');
const shipped = path.join(root, 'WORKFLOW.md');
const toolbox = path.join(root, '.claude');
const env = { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' };
const NAMES = ['convention-lens', 'bug-lens', 'finding-verifier'] as const;
const MODELS: Record<(typeof NAMES)[number], string> = { 'convention-lens': 'sonnet', 'bug-lens': 'opus', 'finding-verifier': 'opus' };

async function shippedConfig() {
  const { definition } = await loadWorkflowFile(shipped);
  return resolveConfig(definition.config, { workflowPath: shipped, env, trackerDefaults });
}

function persona(name: string) {
  const text = fs.readFileSync(path.join(toolbox, 'agents', `${name}.md`), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(match, `${name}: front matter present`);
  const front = (match[1] ?? '').split('\n');
  const entry = (key: string) => front.find((line) => line.startsWith(`${key}:`))?.slice(key.length + 1).trim();
  return { front, body: match[2] ?? '', entry };
}

describe('lens personas (#505)', () => {
  for (const name of NAMES) {
    describe(name, () => {
      const { front, body, entry } = persona(name);

      it('has a one-line front matter with the allowed keys, a model, maxTurns and the read-only deny list, no tools key', () => {
        const keys = front.map((line) => /^([A-Za-z][\w-]*): \S/.exec(line)?.[1]);
        assert.ok(keys.every((key) => key !== undefined), 'every line is a one-line entry');
        assert.deepEqual([...keys].sort(), ['description', 'disallowedTools', 'maxTurns', 'model', 'name']);
        assert.equal(entry('name'), name);
        assert.equal(entry('model'), MODELS[name]);
        assert.match(entry('maxTurns') ?? '', /^[1-9]\d*$/);
        assert.equal(entry('disallowedTools'), 'Edit, Write, NotebookEdit');
      });

      it('has a trigger and an exclusion in the description, without a framework name', () => {
        const description = entry('description') ?? '';
        assert.match(description, /^Use /);
        assert.match(description, /Not for /);
        assert.doesNotMatch(description, /laravel/i);
      });

      it('is read-only, unprefixed and qualified as symphony:<name> for pluginAgents', () => {
        const agent = pluginAgents([toolbox]).find((a) => a.name === name);
        assert.ok(agent);
        assert.equal(agent.readOnly, true);
        assert.equal(agent.qualified, `symphony:${name}`);
      });

      it('forbids changing the repository and demands file:line', () => {
        assert.match(body, /never edit, commit or push/);
        assert.match(body, /file:line/);
      });
    });
  }

  it('convention-lens: only violations of CLAUDE.md / AGENTS.md / .ai/rules where the rule can be quoted', () => {
    const { body, entry } = persona('convention-lens');
    const all = `${entry('description')}\n${body}`;
    for (const source of ['CLAUDE.md', 'AGENTS.md', '.ai/rules']) assert.ok(all.includes(source), source);
    assert.match(body, /quote/);
    assert.match(body, /No quotable rule, no finding/);
    assert.match(body, /linter/);
  });

  it('bug-lens: is called twice, on the diff alone and with context', () => {
    const { body, entry } = persona('bug-lens');
    assert.match(entry('description') ?? '', /twice/);
    assert.match(body, /Diff alone/);
    assert.match(body, /With context/);
    assert.match(body, /pre-existing/);
  });

  it('finding-verifier: one candidate per call, refutes, rejects when in doubt, cites file:line', () => {
    const { body, entry } = persona('finding-verifier');
    assert.match(entry('description') ?? '', /once per candidate/);
    assert.match(body, /exactly one candidate/);
    assert.match(body, /refute/);
    assert.match(body, /When in doubt, refute/);
    assert.match(body, /pre-existing/);
    assert.match(body, /scope/);
    assert.match(body, /verdict: confirmed/);
    assert.match(body, /verdict: refuted/);
    assert.match(body, /file:line/);
  });
});

describe('reviewer in the shipped WORKFLOW.md (#505)', () => {
  it('lists exactly the three lens personas, in a read-only role', async () => {
    const config = await shippedConfig();
    const role = (config.roles ?? []).find((entry) => entry.name === 'reviewer');
    assert.deepEqual(role?.agents, ['convention-lens', 'bug-lens', 'finding-verifier']);
    assert.equal(role?.readOnly, true);
  });

  it('lists them for no other role', async () => {
    const config = await shippedConfig();
    for (const name of NAMES) {
      const listed = (config.roles ?? []).filter((role) => role.agents?.includes(name)).map((role) => role.name);
      assert.deepEqual(listed, ['reviewer'], name);
    }
  });

  it('passes dispatch validation without subagent errors', async () => {
    const config = await shippedConfig();
    const errors = validateDispatch({ config } as unknown as EffectiveWorkflow, null, env).filter((error) => error.includes('.agents'));
    assert.deepEqual(errors, []);
  });

  it('allows exactly the three in any workspace, all read-only', async () => {
    const config = await shippedConfig();
    const all = pluginAgents([toolbox]);
    const role = (config.roles ?? []).find((entry) => entry.name === 'reviewer') ?? null;
    for (const prefixes of [['laravel-'], []]) {
      const { allowed } = sessionAgents(all, role, prefixes, prefixes);
      assert.deepEqual(allowed.map((agent) => agent.name).sort(), ['bug-lens', 'convention-lens', 'finding-verifier']);
      assert.ok(allowed.every((agent) => agent.readOnly));
    }
  });

  it('would reject a reviewer listing a persona that can edit (guard still works)', async () => {
    const config = await shippedConfig();
    const base = (config.roles ?? []).find((role) => role.name === 'reviewer') as RoleConfig;
    const errors = validateDispatch({ config: { ...config, roles: [{ ...base, agents: ['test-designer'] }] } } as unknown as EffectiveWorkflow, null, env).filter((error) =>
      error.includes('.agents'),
    );
    assert.equal(errors.length, 1);
  });
});

describe('reviewer prompt (#505)', () => {
  const qualified = (names: readonly string[]) => names.map((name) => ({ name: `symphony:${name}`, description: `The ${name}.` }));
  const three = qualified(NAMES);

  async function render(labels: string[], agents: Array<{ name: string; description: string }> = three, subIssues: unknown[] = []): Promise<string> {
    const { definition } = await loadWorkflowFile(shipped);
    const template = compilePrompt(definition.promptTemplate, definition.partials);
    const subject = makeIssue({
      id: 'PVTI_1', identifier: 'acme/app#42', title: 'Add invoices', description: 'Create invoices.', labels,
      native_ref: { provider: 'github_project', repository: 'acme/app', number: 42, parent: null, sub_issues: subIssues, base_branch: 'main' },
    });
    return renderPrompt(template, {
      issue: issueTemplateValue(subject, commandSkills([toolbox])), attempt: null, role: 'reviewer', agents, round: 1,
      results: { latest: [], open_findings: [], failed_cases: [] },
    });
  }

  for (const label of ['complexity: l', 'complexity: xl']) {
    describe(`at ${label}`, () => {
      it('names the three personas by their qualified subagent_type', async () => {
        const text = await render(['feature', label]);
        for (const name of NAMES) assert.ok(text.includes(`symphony:${name}`), name);
      });

      it('runs the lenses in one message and then one verifier per candidate', async () => {
        const text = await render(['feature', label]);
        assert.match(text, /in one message/);
        assert.match(text, /one `symphony:finding-verifier` call per candidate/);
        assert.match(text, /rejects when in doubt/);
        // order: lenses first, verifier afterwards
        assert.ok(text.indexOf('symphony:bug-lens') < text.indexOf('symphony:finding-verifier'));
        assert.ok(text.indexOf('symphony:convention-lens') < text.indexOf('symphony:finding-verifier'));
      });

      it('calls the bug lens twice: on the diff alone and with the surrounding code', async () => {
        const text = await render(['feature', label]);
        assert.match(text, /`symphony:bug-lens`, twice/);
        assert.match(text, /diff alone/);
        assert.match(text, /surrounding code/);
      });

      it('lets only confirmed, diff-introduced findings within the scope into the result and excludes style, linter and pre-existing', async () => {
        const text = await render(['feature', label]);
        assert.match(text, /Only confirmed, diff-introduced findings within the issue's scope enter `findings`/);
        assert.match(text, /style/i);
        assert.match(text, /linter/);
        assert.match(text, /pre-existing/);
      });

      it('keeps the existing checklist and the single report_result step', async () => {
        const text = await render(['feature', label]);
        assert.match(text, /\*\*Correctness:\*\*/);
        assert.match(text, /5\. Report exactly one result with `report_result`/);
      });
    });
  }

  for (const labels of [['feature', 'complexity: s'], ['feature', 'complexity: m'], ['feature'], ['bug', 'complexity: m']]) {
    it(`renders no subagent instruction for ${labels.join(', ')} and equals the render without agents`, async () => {
      const text = await render(labels);
      assert.doesNotMatch(text, /convention-lens|bug-lens|finding-verifier|Subagents you can start|subagent_type/);
      assert.equal(text, await render(labels, []));
    });
  }

  it('also renders nothing at S/M when the lens agents carry no plugin prefix', async () => {
    const bare = NAMES.map((name) => ({ name, description: name }));
    const text = await render(['feature', 'complexity: m'], bare);
    assert.doesNotMatch(text, /convention-lens|bug-lens|finding-verifier|Subagents you can start/);
  });

  it('resolves unprefixed names too at XL (prefix-agnostic)', async () => {
    const bare = NAMES.map((name) => ({ name, description: name }));
    const text = await render(['feature', 'complexity: xl'], bare);
    for (const name of NAMES) assert.match(text, new RegExp(`\`${name}\``));
    assert.doesNotMatch(text, /symphony:/);
  });

  it('adds neither lens block nor intro to the integration review at XL', async () => {
    const split = [{ identifier: 'acme/app#43', title: 'CSV writer', state: 'CLOSED', state_reason: 'COMPLETED' }];
    const text = await render(['feature', 'complexity: xl'], three, split);
    assert.match(text, /integration review/);
    assert.doesNotMatch(text, /convention-lens|bug-lens|finding-verifier|Subagents you can start/);
  });

  it('names no missing persona when only part of the list is allowed', async () => {
    const xl = ['feature', 'complexity: xl'];
    const noConvention = await render(xl, qualified(['bug-lens', 'finding-verifier']));
    assert.match(noConvention, /symphony:bug-lens/);
    assert.match(noConvention, /symphony:finding-verifier/);
    assert.doesNotMatch(noConvention, /convention-lens/);

    const noBug = await render(xl, qualified(['convention-lens', 'finding-verifier']));
    assert.match(noBug, /symphony:convention-lens/);
    assert.match(noBug, /symphony:finding-verifier/);
    assert.doesNotMatch(noBug, /bug-lens/);
  });

  it('starts no lenses without the verifier: nothing could be confirmed', async () => {
    const xl = ['feature', 'complexity: xl'];
    for (const names of [['convention-lens', 'bug-lens'], ['bug-lens'], ['convention-lens']]) {
      const text = await render(xl, qualified(names));
      assert.doesNotMatch(text, /convention-lens|bug-lens|finding-verifier|in one message/, names.join());
    }
  });

  it('starts no verifier-only review: a verifier without any lens renders nothing', async () => {
    const text = await render(['feature', 'complexity: xl'], qualified(['finding-verifier']));
    assert.doesNotMatch(text, /finding-verifier/);
  });

  it('keeps another allowed agent next to the lenses', async () => {
    const other = { name: 'symphony:explorer', description: 'Finds code.' };
    const text = await render(['feature', 'complexity: xl'], [...three, other]);
    assert.match(text, /symphony:explorer/);
    assert.match(text, /symphony:finding-verifier/);
  });
});

describe('lens review docs (#505)', () => {
  const config = fs.readFileSync(path.join(root, 'docs', 'configuration.md'), 'utf8');
  const start = config.indexOf('#### Subagents per role');
  const section = config.slice(start, config.indexOf('\n#### ', start + 5));

  it('describes the pattern: lenses, a verifier per finding, the L/XL gate', () => {
    assert.ok(start >= 0);
    for (const name of NAMES) assert.ok(section.includes(`\`${name}\``), name);
    assert.match(section, /L\/XL/);
    assert.match(section, /one message/);
    assert.match(section, /per candidate/);
    assert.match(section, /doubt/);
    assert.match(section, /pre-existing/);
    assert.match(section, /linter/);
  });

  it('no longer says the reviewer has an empty list', () => {
    assert.doesNotMatch(section, /`reviewer`[^.]*with `\[\]`/);
    assert.doesNotMatch(section, /`reviewer` and `security-auditor` with `\[\]`/);
  });
});
