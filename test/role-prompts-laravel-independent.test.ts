import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { commandSkills } from '../src/workflow/command.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { compilePrompt, DEFAULT_CONTINUATION_PROMPT, issueTemplateValue, renderPrompt } from '../src/workflow/template.ts';
import { makeIssue } from './helpers.ts';

// #555, independent of the developer's tests: derived from the acceptance criteria.

const root = path.join(import.meta.dirname, '..');
const shipped = path.join(root, 'WORKFLOW.md');
const WORDS = /Filament|Livewire|\$fillable|Pest/;
const ROLES = ['reviewer', 'security-auditor', 'test-engineer', 'developer'];

async function render(role: string, projectTypes: unknown, opts: { labels?: string[]; integration?: boolean; attempt?: number | null } = {}): Promise<string> {
  const { definition } = await loadWorkflowFile(shipped);
  const template = compilePrompt(definition.promptTemplate, definition.partials);
  assert.equal(template.parseError, null);
  const sub = opts.integration ? [{ number: 8, identifier: 'acme/app#8', title: 'Package', state: 'CLOSED', state_reason: 'COMPLETED' }] : [];
  const issue = makeIssue({
    id: 'PVTI_1',
    identifier: 'acme/app#42',
    title: 'Add invoices',
    description: 'Create it.',
    state: 'In review',
    labels: opts.labels ?? ['feature', 'complexity: m'],
    native_ref: { provider: 'github_project', repository: 'acme/app', number: 42, parent: null, sub_issues: sub, base_branch: null, status_updated_at: '2026-01-01T00:00:00.000Z' },
  } as never);
  return renderPrompt(template, {
    issue: issueTemplateValue(issue, commandSkills([path.join(root, '.claude')])),
    attempt: opts.attempt ?? null,
    role,
    agents: [],
    project_types: projectTypes,
  } as never);
}

describe('#555 independent: role prompts and project_types', () => {
  for (const role of ROLES) {
    for (const labels of [['feature', 'complexity: m'], ['bug', 'complexity: l'], ['refactor', 'complexity: xl']]) {
      it(`${role} ${labels.join('/')}: empty project_types has none of the Laravel words`, async () => {
        for (const attempt of [null, 3]) {
          assert.doesNotMatch(await render(role, [], { labels, attempt }), WORDS);
        }
      });
    }
  }

  for (const role of ['reviewer', 'security-auditor']) {
    it(`${role}: integration mode is free of Laravel words without laravel`, async () => {
      const plain = await render(role, [], { integration: true });
      assert.doesNotMatch(plain, WORDS);
      assert.match(plain, /integration/i);
    });
  }

  it('a multi-integration list containing laravel counts as a Laravel workspace', async () => {
    for (const role of ['reviewer', 'security-auditor', 'test-engineer']) {
      const only = await render(role, ['laravel'], { labels: ['feature', 'complexity: l'] });
      const both = await render(role, ['symfony', 'laravel'], { labels: ['feature', 'complexity: l'] });
      assert.equal(both, only, role);
      assert.match(both, WORDS);
    }
  });

  it('a non-Laravel integration alone does not enable the Laravel text', async () => {
    for (const role of ROLES) assert.doesNotMatch(await render(role, ['symfony', 'node']), WORDS);
  });

  it('the reviewer keeps the same checklist items in neutral words', async () => {
    const p = await render('reviewer', []);
    for (const w of ['Tests', 'Authorization', 'Validation and mass assignment', 'Queries', 'Migrations']) assert.ok(p.includes(`**${w}:**`), w);
    assert.match(p, /N\+1/);
    assert.match(p, /mass assignment/);
  });

  it('the security auditor keeps its categories in neutral words', async () => {
    const p = await render('security-auditor', []);
    for (const w of ['Authorization', 'Injection', 'Output', 'Mass assignment and validation']) assert.ok(p.includes(`**${w}:**`), w);
    assert.match(p, /XSS/);
  });

  it('leftover Liquid tags never leak into the render', async () => {
    for (const role of ROLES) for (const pt of [[], ['laravel']]) assert.doesNotMatch(await render(role, pt), /\{%|%\}/);
  });

  it('the continuation prompt has no Laravel-only wording and custom ones still get project_types', async () => {
    assert.doesNotMatch(DEFAULT_CONTINUATION_PROMPT, /Filament|Livewire|\$fillable|Pest|Laravel/);
    const tpl = compilePrompt('types: {% for t in project_types %}{{ t }};{% endfor %}', {});
    assert.equal(tpl.parseError, null);
    assert.equal(await renderPrompt(tpl, { issue: {}, attempt: null, role: 'developer', agents: [], project_types: ['laravel'] } as never), 'types: laravel;');
  });

  it('docs/configuration.md says the Laravel checklist parts depend on project_types', () => {
    const docs = fs.readFileSync(path.join(root, 'docs', 'configuration.md'), 'utf8');
    const normalized = docs.replace(/\s+/g, ' ');
    assert.match(normalized, /Laravel[^.]*checklists?[^.]*render only when `project_types` contains `laravel`/);
    const bullet = docs.split('\n').find((l) => l.startsWith('- `project_types`'));
    assert.ok(bullet, 'project_types entry');
    assert.match(bullet, /checklist/);
  });

  it('no checklist for another framework was added to the role files', () => {
    for (const role of ROLES) {
      const text = fs.readFileSync(path.join(root, 'roles', `${role}.md`), 'utf8');
      assert.doesNotMatch(text, /Symfony|Django|Rails|Spring|Next\.js|Vue/, role);
    }
  });
});
