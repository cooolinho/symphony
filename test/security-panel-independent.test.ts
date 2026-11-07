import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { workspaceApps } from '../src/integrations/registry.ts';
import type { WorkspaceIntegration } from '../src/integrations/types.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { commandSkills, pluginAgents } from '../src/workflow/command.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { sessionAgents } from '../src/workflow/roles.ts';
import { PANEL_LENSES, PANEL_MAX_REFUTING_VOTES, parseResult } from '../src/workflow/results.ts';
import { compilePrompt, issueTemplateValue, renderPrompt } from '../src/workflow/template.ts';
import { makeIssue } from './helpers.ts';

// Independent acceptance tests of E3-5 (security: inventory and refutation panel), derived from the issue text:
// personas, WORKFLOW.md role, prompt gating by complexity and Laravel workspace, the panel rule of `report_result`,
// and the documentation.

const root = path.join(import.meta.dirname, '..');
const shipped = path.join(root, 'WORKFLOW.md');
const toolbox = path.join(root, '.claude');
const agentsDir = path.join(toolbox, 'agents');

const read = (...parts: string[]): string => fs.readFileSync(path.join(root, ...parts), 'utf8');
const frontOf = (name: string): string => /^---\n([\s\S]*?)\n---\n/.exec(read('.claude', 'agents', `${name}.md`))?.[1] ?? '';
const field = (name: string, key: string): string | undefined => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(frontOf(name))?.[1]?.trim();

describe('E3-5 personas', () => {
  for (const name of ['security-inventory', 'refutation-judge']) {
    describe(name, () => {
      it('exists, has no prefix in its name and carries a description with trigger and exclusion', () => {
        assert.ok(fs.existsSync(path.join(agentsDir, `${name}.md`)));
        assert.equal(field(name, 'name'), name);
        const description = field(name, 'description') ?? '';
        assert.match(description, /^Use /, 'trigger');
        assert.match(description, /Not for /, 'exclusion');
      });

      it('is read-only: no shell and no write tool, a turn budget is set', () => {
        const tools = field(name, 'tools');
        assert.equal(tools, 'Read, Glob, Grep');
        assert.doesNotMatch(frontOf(name), /\b(Bash|Edit|Write|NotebookEdit|WebFetch)\b/);
        const turns = Number(field(name, 'maxTurns'));
        assert.ok(Number.isInteger(turns) && turns > 0 && turns <= 60, `maxTurns ${turns}`);
      });

      it('tells the model it has no shell and runs no code', () => {
        assert.match(read('.claude', 'agents', `${name}.md`), /(cannot and must not run|no shell|must not run)/i);
      });
    });
  }

  it('security-inventory is sonnet and splits the change into components', () => {
    assert.equal(field('security-inventory', 'model'), 'sonnet');
    const text = read('.claude', 'agents', 'security-inventory.md');
    assert.match(text, /components?/i);
    assert.match(text, /file:line/);
  });

  it('refutation-judge is opus, takes one candidate and one lens, defaults to false positive and cites file:line', () => {
    assert.equal(field('refutation-judge', 'model'), 'opus');
    const text = read('.claude', 'agents', 'refutation-judge.md');
    for (const lens of ['reachability', 'impact', 'defenses']) assert.match(text, new RegExp(lens), lens);
    assert.match(text, /false positive/i);
    assert.match(text, /file:line/);
    assert.match(text, /one candidate/i);
    assert.match(text, /one lens/i);
  });

  it('both personas are discovered by the plugin scan as read-only agents', () => {
    const found = pluginAgents([toolbox]);
    for (const name of ['security-inventory', 'refutation-judge']) {
      const agent = found.find((entry) => entry.name === name);
      assert.ok(agent, name);
      assert.equal(agent.readOnly, true, `${name} readOnly`);
    }
  });
});

describe('E3-5 WORKFLOW.md', () => {
  const load = async () => {
    const { definition } = await loadWorkflowFile(shipped);
    return resolveConfig(definition.config, {
      workflowPath: shipped,
      env: { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' },
      trackerDefaults,
    });
  };

  it('lists exactly the two panel personas for the security auditor (pin)', async () => {
    const config = await load();
    const role = (config.roles ?? []).find((entry) => entry.name === 'security-auditor');
    assert.deepEqual(role?.agents, ['security-inventory', 'refutation-judge']);
    assert.equal(role?.readOnly, true);
  });

  it('the session of the security auditor gets exactly those two agents, in a Laravel and a plain workspace', async () => {
    const config = await load();
    const role = (config.roles ?? []).find((entry) => entry.name === 'security-auditor') ?? null;
    const all = pluginAgents([toolbox]);
    for (const prefixes of [[], ['laravel-']]) {
      const { allowed } = sessionAgents(all, role, prefixes, prefixes);
      assert.deepEqual(allowed.map((agent) => agent.name).sort(), ['refutation-judge', 'security-inventory']);
    }
  });

  it('other roles do not get the panel personas', async () => {
    const config = await load();
    for (const role of config.roles ?? []) {
      if (role.name === 'security-auditor') continue;
      const agents = role.agents ?? [];
      assert.ok(Array.isArray(agents) ? !agents.includes('refutation-judge') && !agents.includes('security-inventory') : true, role.name);
    }
  });
});

describe('E3-5 prompt of the security auditor', () => {
  const both = ['security-inventory', 'refutation-judge'].map((name) => ({ name: `symphony:${name}`, description: `The ${name}.` }));
  const issue = makeIssue({
    id: 'PVTI_1',
    identifier: 'acme/app#42',
    title: 'Add invoices',
    description: 'Create an invoice resource.',
    state: 'Security review',
    url: 'https://github.com/acme/app/issues/42',
    labels: ['feature'],
    native_ref: { provider: 'github_project', repository: 'acme/app', number: 42, parent: null, sub_issues: [], base_branch: 'develop' },
  });
  const renderWith = async (labels: string[], agents: Array<{ name: string; description: string }> = both, extra: Record<string, unknown> = {}) => {
    const { definition } = await loadWorkflowFile(shipped);
    const template = compilePrompt(definition.promptTemplate, definition.partials);
    assert.equal(template.parseError, null);
    const subject = { ...issue, labels };
    return renderPrompt(template, { issue: issueTemplateValue(subject, commandSkills([toolbox])), attempt: null, role: 'security-auditor', agents, round: 1, ...extra });
  };

  for (const label of ['complexity: l', 'complexity: xl']) {
    it(`at ${label}: names inventory, own research, three judges per candidate, no code run, votes in verification`, async () => {
      const text = await renderWith(['feature', label]);
      assert.match(text, /security-inventory/);
      assert.match(text, /refutation-judge/);
      assert.match(text, /inventory/i);
      assert.match(text, /yourself/, 'own research per component');
      assert.match(text, /three/i);
      for (const lens of PANEL_LENSES) assert.match(text, new RegExp(lens), lens);
      assert.match(text, /false positive/i);
      assert.match(text, /verification/);
      assert.match(text, /votes/);
      assert.match(text, /Do not run code/i);
    });
  }

  it('without a Laravel workspace there are no Laravel lenses; with one the brief names all five', async () => {
    const plain = await renderWith(['feature', 'complexity: l'], both, { project_types: [] });
    // the generic checklist already names raw queries and mass assignment; the Laravel lens adds Filament canAccess / authorize*
    assert.doesNotMatch(plain, /canAccess|authorize\*/);
    const laravel = await renderWith(['feature', 'complexity: l'], both, { project_types: ['laravel'] });
    assert.ok(laravel.length > plain.length, "the Laravel brief adds text");
    assert.match(laravel, /mass assignment/i);
    assert.match(laravel, /polic(y|ies)/i);
    assert.match(laravel, /gates?/i);
    assert.match(laravel, /canAccess/);
    assert.match(laravel, /authorize\*/);
    assert.match(laravel, /raw quer/i);
    assert.match(laravel, /\{!! !!\}/);
  });

  it('a Laravel workspace at S/M adds neither panel nor Laravel lenses', async () => {
    for (const label of ['complexity: s', 'complexity: m']) {
      const text = await renderWith(['feature', label], both, { project_types: ['laravel'] });
      assert.doesNotMatch(text, /canAccess|refutation-judge|security-inventory/, label);
    }
  });

  it('at S and M there is no subagent instruction and the prompt equals that of an auditor without agents', async () => {
    for (const label of ['complexity: s', 'complexity: m']) {
      const text = await renderWith(['feature', label]);
      assert.equal(text, await renderWith(['feature', label], []), label);
      assert.doesNotMatch(text, /Subagents you can start|subagent_type|refutation|inventory/i, label);
    }
  });

  it('the S/M prompt still asks for plain verification-free findings and keeps "no code" read-only role text', async () => {
    const text = await renderWith(['feature', 'complexity: s']);
    assert.match(text, /read-only/);
    assert.doesNotMatch(text, /verification: \{status/);
  });
});

describe('E3-5 report_result: panel rule', () => {
  const vote = (lens: string, verdict = 'confirmed') => ({ lens, verdict, evidence: `app/Http/PostController.php:12 ${lens}` });
  const panel = (verdicts: Record<string, string> = {}) => PANEL_LENSES.map((lens) => vote(lens, verdicts[lens] ?? 'confirmed'));
  const finding = (votes: unknown[] | undefined, status = 'confirmed') => ({
    severity: 'major',
    file: 'app/Http/PostController.php',
    line: 12,
    problem: 'Mass assignment of is_admin',
    fix: 'Use validated()',
    verification: { status, evidence: 'app/Http/PostController.php:12 shows it', ...(votes === undefined ? {} : { votes }) },
  });
  const result = (findings: unknown[], extra: Record<string, unknown> = {}) => ({ verdict: 'issues_found', summary: 'Audit.', findings, ...extra });
  const ctx = { verifiedFindings: true, panelVotes: true };

  it('the rule is one documented constant and the default keeps a finding only when no lens refutes it', () => {
    assert.equal(PANEL_MAX_REFUTING_VOTES, 0);
    assert.deepEqual([...PANEL_LENSES], ['reachability', 'impact', 'defenses']);
    const docs = read('docs', 'results.md') + read('docs', 'configuration.md');
    assert.match(docs, /PANEL_MAX_REFUTING_VOTES/);
  });

  it('the rule sentence in roles/security-auditor.md matches PANEL_MAX_REFUTING_VOTES', () => {
    const RULE_SENTENCE: Record<number, string> = { 0: 'a finding stays only when no lens refutes it' };
    const sentence = RULE_SENTENCE[PANEL_MAX_REFUTING_VOTES];
    assert.ok(sentence, `PANEL_MAX_REFUTING_VOTES (src/workflow/results.ts) is ${PANEL_MAX_REFUTING_VOTES}: write the rule sentence for it in roles/security-auditor.md and add it to RULE_SENTENCE here`);
    const occurrences = read('roles', 'security-auditor.md').split(sentence).length - 1;
    assert.equal(occurrences, 1, `roles/security-auditor.md must state "${sentence}" once for PANEL_MAX_REFUTING_VOTES = ${PANEL_MAX_REFUTING_VOTES} (src/workflow/results.ts)`);
  });

  it('accepts a finding with three non-refuting votes', () => {
    const outcome = parseResult('security', result([finding(panel())]), ctx);
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
  });

  for (const lens of PANEL_LENSES) {
    it(`refuses a finding that the ${lens} lens refutes, naming the lens`, () => {
      const outcome = parseResult('security', result([finding(panel({ [lens]: 'refuted' }))]), ctx);
      assert.equal(outcome.ok, false);
      const text = JSON.stringify(outcome);
      assert.match(text, new RegExp(lens));
      assert.match(text, /refuted/);
    });
  }

  it('refuses a finding refuted by all three lenses', () => {
    const outcome = parseResult('security', result([finding(panel({ reachability: 'refuted', impact: 'refuted', defenses: 'refuted' }))]), ctx);
    assert.equal(outcome.ok, false);
  });

  it('accepts the same refuted candidate as a passed audit with the candidate in refuted[]', () => {
    const refuted = finding(panel({ defenses: 'refuted' }), 'refuted');
    const outcome = parseResult('security', { verdict: 'passed', summary: 'Clean.', findings: [], refuted: [refuted] }, ctx);
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
  });

  it('refuses fewer than three votes with a message that names the finding and the missing lens', () => {
    for (const votes of [[], [vote('reachability')], [vote('reachability'), vote('impact')], undefined]) {
      const outcome = parseResult('security', result([finding(votes)]), ctx);
      assert.equal(outcome.ok, false, JSON.stringify(votes));
      assert.match(JSON.stringify(outcome), /findings\[0\]/);
    }
    const two = JSON.stringify(parseResult('security', result([finding([vote('reachability'), vote('impact')])]), ctx));
    assert.match(two, /defenses/);
  });

  it('refuses three votes that repeat a lens (one per lens is required)', () => {
    const outcome = parseResult('security', result([finding([vote('impact'), vote('impact'), vote('defenses')])]), ctx);
    assert.equal(outcome.ok, false);
  });

  it('refuses more than three votes and an unknown lens', () => {
    assert.equal(parseResult('security', result([finding([...panel(), vote('impact')])]), ctx).ok, false);
    assert.equal(parseResult('security', result([finding([vote('luck'), vote('impact'), vote('defenses')])]), ctx).ok, false);
  });

  it('checks every finding of the result, not only the first', () => {
    const outcome = parseResult('security', result([finding(panel()), finding([vote('impact')])]), ctx);
    assert.equal(outcome.ok, false);
    assert.match(JSON.stringify(outcome), /findings\[1\]/);
  });

  it('a vote needs evidence', () => {
    const bad = PANEL_LENSES.map((lens) => ({ lens, verdict: 'confirmed' }));
    assert.equal(parseResult('security', result([finding(bad)]), ctx).ok, false);
  });

  it('S/M (no panel context) is unchanged: a finding with a plain verification or none needs no votes', () => {
    assert.equal(parseResult('security', result([{ severity: 'major', file: 'a.ts', line: 1, problem: 'x' }]), {}).ok, true);
    assert.equal(parseResult('security', result([finding(undefined)]), {}).ok, true);
  });

  it('L/XL without the judge in the session keeps the E3-4 rule: confirmed verification, no votes required', () => {
    assert.equal(parseResult('security', result([finding(undefined)]), { verifiedFindings: true }).ok, true);
    assert.equal(parseResult('security', result([{ severity: 'major', file: 'a.ts', line: 1, problem: 'x' }]), { verifiedFindings: true }).ok, false);
  });

  it('a review result is not subject to the panel rule', () => {
    const review = { verdict: 'changes_needed', summary: 'x', findings: [finding(undefined)] };
    assert.equal(parseResult('review', review, ctx).ok, true);
  });

  it('a blocked audit is not checked for votes', () => {
    const blocked = { verdict: 'blocked', summary: 'No access.', blockers: [{ description: 'No checkout', needs: 'access' }], findings: [] };
    assert.equal(parseResult('security', blocked, ctx).ok, true);
  });
});

describe('E3-5 workspaceApps (the Laravel flag of the prompt)', () => {
  const integration = (id: string, dirs: string[] | undefined): WorkspaceIntegration =>
    ({ id, configKey: id, resolveConfig: () => ({ config: {}, errors: [], warnings: [] }), prepare: async () => null, ...(dirs === undefined ? {} : { appDirs: async () => dirs }) }) as WorkspaceIntegration;

  it('reports the id of an integration whose app was found, with its directories', async () => {
    const found = await workspaceApps([integration('laravel', ['', 'api'])], '/tmp/ws');
    assert.deepEqual(found.projectTypes, ['laravel']);
    assert.deepEqual(found.appDirs, ['', 'api']);
  });

  it('reports no project type when no app was found or the integration cannot look', async () => {
    const found = await workspaceApps([integration('laravel', []), integration('other', undefined)], '/tmp/ws');
    assert.deepEqual(found.projectTypes, []);
    assert.deepEqual(found.appDirs, []);
  });
});

describe('E3-5 documentation', () => {
  const section = (file: string, heading: RegExp): string => {
    const text = read('docs', file);
    const match = heading.exec(text);
    assert.ok(match, `${file}: ${heading}`);
    const rest = text.slice(match.index + match[0].length);
    const next = /\n#{1,4} /.exec(rest);
    return (next === null ? rest : rest.slice(0, next.index)).replace(/\s+/g, ' ');
  };

  it('docs/configuration.md#subagents-per-role documents personas, panel and L/XL', () => {
    const text = section('configuration.md', /#{2,4} Subagents per role/);
    assert.match(text, /security-inventory/);
    assert.match(text, /refutation-judge/);
    assert.match(text, /L\/XL/);
    assert.match(text, /reachability/);
    assert.match(text, /PANEL_MAX_REFUTING_VOTES|no lens refutes/);
  });

  it('docs/results.md#kinds documents the votes and the rule', () => {
    const results = read('docs', 'results.md');
    const start = results.search(/#{2,4} Kinds/i);
    assert.ok(start >= 0, 'kinds section');
    const text = results.replace(/\s+/g, ' ');
    assert.match(text, /votes/);
    assert.match(text, /PANEL_MAX_REFUTING_VOTES/);
    assert.match(text, /reachability, impact(,| and) defenses|reachability.*impact.*defenses/);
  });

  it('docs/concepts/subagents.md marks E3-5 as implemented', () => {
    const text = read('docs', 'concepts', 'subagents.md');
    const at = text.indexOf('E3-5');
    assert.ok(at >= 0);
    assert.match(text.slice(at), /implement/i);
  });
});
