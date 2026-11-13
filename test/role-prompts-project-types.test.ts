import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { commandSkills } from '../src/workflow/command.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { compilePrompt, DEFAULT_CONTINUATION_PROMPT, issueTemplateValue, renderPrompt } from '../src/workflow/template.ts';
import { makeIssue } from './helpers.ts';

// #555: the Laravel/Filament parts of the role checklists render only for `project_types` containing "laravel".
// test/fixtures/role-prompts/<role>.md are verbatim copies of the role files before #555 (the byte-identity
// reference). When someone changes the Laravel text of a role on purpose, update the fixture together with it.

const root = path.join(import.meta.dirname, '..');
const shipped = path.join(root, 'WORKFLOW.md');
const fixtureDir = path.join(import.meta.dirname, 'fixtures', 'role-prompts');
const LARAVEL_WORDS = /Filament|Livewire|\$fillable|Pest/;
const toolbox = path.join(root, '.claude');

type Agent = { name: string; description: string };
const agent = (name: string): Agent => ({ name, description: `${name} agent.` });

const ROLES = {
  reviewer: { lens: [agent('convention-lens'), agent('bug-lens'), agent('finding-verifier')] },
  'security-auditor': { lens: [agent('security-inventory'), agent('refutation-judge')] },
  'test-engineer': { lens: [] as Agent[] },
} as const;

async function render(role: string, labels: string[], attempt: number | null, projectTypes: string[], agents: Agent[], fixture?: string): Promise<string> {
  const { definition } = await loadWorkflowFile(shipped);
  const partials = fixture === undefined ? definition.partials : { ...definition.partials, [`roles/${role}.md`]: fixture };
  const template = compilePrompt(definition.promptTemplate, partials);
  assert.equal(template.parseError, null);
  const issue = makeIssue({ id: 'PVTI_1', identifier: 'acme/app#42', title: 'Add invoices', description: 'Create it.', state: 'In review', labels });
  return renderPrompt(template, {
    issue: issueTemplateValue(issue, commandSkills([toolbox])),
    attempt,
    role,
    agents,
    project_types: projectTypes,
  });
}

function variants(role: keyof typeof ROLES): Array<{ labels: string[]; attempt: number | null; agents: Agent[] }> {
  const out = [];
  for (const type of ['feature', 'bug', 'refactor']) {
    for (const complexity of ['complexity: m', 'complexity: l']) {
      for (const attempt of [null, 2]) {
        out.push({ labels: [type, complexity], attempt, agents: [] as Agent[] });
        if (complexity === 'complexity: l') out.push({ labels: [type, complexity], attempt, agents: [...ROLES[role].lens] });
      }
    }
  }
  return out;
}

const bullets = (prompt: string): number => prompt.split('\n').filter((l) => /^ {3}- /.test(l)).length;

describe('role checklists depend on project_types (#555)', () => {
  for (const role of Object.keys(ROLES) as Array<keyof typeof ROLES>) {
    const fixture = fs.readFileSync(path.join(fixtureDir, `${role}.md`), 'utf8');

    it(`${role}: the Laravel render is byte-identical to the role file before the change`, async () => {
      for (const v of variants(role)) {
        const now = await render(role, v.labels, v.attempt, ['laravel'], v.agents);
        const before = await render(role, v.labels, v.attempt, ['laravel'], v.agents, fixture);
        assert.equal(now, before, JSON.stringify([v.labels, v.attempt, v.agents.length]));
      }
    });

    it(`${role}: a workspace without a Laravel app gets no Filament, Livewire, $fillable or Pest`, async () => {
      for (const v of variants(role)) {
        const prompt = await render(role, v.labels, v.attempt, [], v.agents);
        assert.doesNotMatch(prompt, LARAVEL_WORDS, JSON.stringify([v.labels, v.attempt]));
        const other = await render(role, v.labels, v.attempt, ['symfony'], v.agents);
        assert.equal(other, prompt);
      }
      // the guard is active: the Laravel render does contain them
      assert.match(await render(role, ['feature', 'complexity: m'], null, ['laravel'], []), LARAVEL_WORDS);
    });
  }

  it('reviewer and security-auditor keep their checklist categories and item count', async () => {
    const labels = {
      reviewer: ['Tests', 'Authorization', 'Validation and mass assignment', 'Queries', 'Migrations', 'Guardrails'],
      'security-auditor': ['Authorization', 'Authentication and sessions', 'Injection', 'Output', 'Mass assignment and validation', 'Migrations'],
    };
    for (const [role, names] of Object.entries(labels)) {
      const laravel = await render(role, ['feature', 'complexity: m'], null, ['laravel'], []);
      const plain = await render(role, ['feature', 'complexity: m'], null, [], []);
      for (const name of names) {
        assert.ok(laravel.includes(`**${name}:**`), `${role} laravel ${name}`);
        assert.ok(plain.includes(`**${name}:**`), `${role} neutral ${name}`);
      }
      assert.equal(bullets(plain), bullets(laravel), role);
      assert.notEqual(plain, laravel, role);
    }
  });

  it('test-engineer: the Pest mutation hint is only for Laravel; the neutral render keeps the other fields', async () => {
    const laravel = await render('test-engineer', ['feature', 'complexity: l'], null, ['laravel'], []);
    const plain = await render('test-engineer', ['feature', 'complexity: l'], null, [], []);
    assert.match(laravel, /mutation_score/);
    assert.doesNotMatch(plain, /mutation_score/);
    assert.match(plain, /`commands`: the commands that ran/);
  });

  it('developer without laravel-* specialists has no Laravel wording', async () => {
    const prompt = await render('developer', ['feature', 'complexity: m'], null, [], [agent('explorer'), agent('design-critic')]);
    assert.doesNotMatch(prompt, LARAVEL_WORDS);
  });

  it('the built-in continuation prompt has no Laravel wording', () => {
    assert.doesNotMatch(DEFAULT_CONTINUATION_PROMPT, /Filament|Livewire|\$fillable|Pest|Laravel/);
  });
});
