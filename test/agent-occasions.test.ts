import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { commandSkills } from '../src/workflow/command.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { compilePrompt, issueTemplateValue, renderPrompt } from '../src/workflow/template.ts';
import { makeIssue } from './helpers.ts';

/**
 * Prompts on occasions instead of deterrence (E2-2): derived from the issue's acceptance criteria, not from the
 * implementation. Roles are discovered from the shipped WORKFLOW.md, not listed by hand.
 */

const root = path.join(import.meta.dirname, '..');
const shipped = path.join(root, 'WORKFLOW.md');
const toolbox = path.join(root, '.claude');

type Agent = { name: string; description: string };

const issue = makeIssue({
  id: 'PVTI_1',
  identifier: 'acme/app#42',
  title: 'Add invoices',
  description: 'Create an invoice resource.',
  state: 'In progress',
  url: 'https://github.com/acme/app/issues/42',
  labels: ['feature', 'complexity: m'],
  native_ref: { provider: 'github_project', repository: 'acme/app', number: 42, parent: null, sub_issues: [], base_branch: null },
});

const agent = (name: string): Agent => ({ name: `symphony:${name}`, description: `The ${name}.` });
const ALL = ['design-critic', 'explorer', 'laravel-architect', 'laravel-database-engineer', 'laravel-filament-developer', 'laravel-test-engineer', 'laravel-code-reviewer', 'test-designer'];

async function render(role: string, agents: Agent[], extra: Record<string, unknown> = {}, labels?: string[]): Promise<string> {
  const { definition } = await loadWorkflowFile(shipped);
  const template = compilePrompt(definition.promptTemplate, definition.partials);
  assert.equal(template.parseError, null);
  return renderPrompt(template, { issue: issueTemplateValue(labels ? { ...issue, labels } : issue, commandSkills([toolbox])), attempt: null, role, agents, round: 1, test_paths: ['tests/**'], ...extra });
}

/** The configured agent list of every role of the shipped workflow, short names. */
async function shippedRoles(): Promise<Record<string, string[] | undefined>> {
  const { definition } = await loadWorkflowFile(shipped);
  const roles = (definition.config as { roles?: Record<string, { agents?: string[] }> }).roles ?? {};
  return Object.fromEntries(Object.entries(roles).map(([name, role]) => [name, role.agents]));
}

/** The bullets below the "When to delegate:" heading, up to the next blank line. */
function delegateBullets(prompt: string): string[] {
  const start = prompt.indexOf('When to delegate:');
  assert.ok(start >= 0, 'no "When to delegate:" block');
  const lines = prompt.slice(start).split('\n').slice(1);
  const bullets: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('- ')) break;
    bullets.push(line);
  }
  return bullets;
}

const NOT_FOR = /\bnot (for|when)\b/i;

describe('prompts on occasions instead of deterrence', () => {
  it('has dropped the deterrent wording from the shipped prompt, the roles and the docs of the intro', () => {
    const workflow = fs.readFileSync(shipped, 'utf8');
    assert.doesNotMatch(workflow, /They are optional/);
    assert.doesNotMatch(workflow, /costs tokens/);
    for (const file of fs.readdirSync(path.join(root, 'roles'))) {
      const source = fs.readFileSync(path.join(root, 'roles', file), 'utf8');
      assert.doesNotMatch(source, /costs tokens/, file);
      assert.doesNotMatch(source, /\boptional\b/i, file);
    }
    const docs = fs.readFileSync(path.join(root, 'docs', 'configuration.md'), 'utf8');
    assert.doesNotMatch(docs, /phrased as optional/);
  });

  describe('every role that has agents', () => {
    it('renders the intro with delegation rule, brief rules and the candidate rule', async () => {
      const roles = await shippedRoles();
      const withAgents = Object.entries(roles).filter(([, agents]) => agents == null || agents.length > 0);
      assert.ok(withAgents.length >= 7, `expected the shipped roles with agents, got ${withAgents.map(([n]) => n).join()}`);
      for (const [role] of withAgents) {
        const listed = roles[role] ?? ALL;
        const prompt = await render(role, listed.map(agent), { delegate: true });
        const label = role;
        if (role === 'test-engineer') continue; // renders the intro depending on the complexity, see below
        assert.match(prompt, /Subagents you can start with the Agent tool/, label);
        assert.match(prompt, /subagent_type/, label);
        // delegate where a trigger applies, never for a few tool calls
        assert.match(prompt, /[Dd]elegate where a trigger applies/, label);
        assert.match(prompt, /never for what a few tool calls finish/, label);
        // the brief rules
        assert.match(prompt, /the issue[^.]*and its acceptance criteria/, label);
        assert.match(prompt, /absolute workspace path/, label);
        assert.match(prompt, /task and its boundaries/, label);
        assert.match(prompt, /output format with `file:line`/, label);
        assert.match(prompt, /file lists instead of file contents/, label);
        assert.match(prompt, /1,000–2,000 tokens/, label);
        // findings are candidates
        assert.match(prompt, /candidates/, label);
        assert.match(prompt, /read the cited lines yourself/, label);
        assert.match(prompt, /discard any claim without `file:line`/, label);
        assert.match(prompt, /You stay responsible/, label);
        // the agent list stays (the design-critic is listed only at L/XL, see the architect tests)
        for (const name of listed) if (name !== 'design-critic') assert.ok(prompt.includes(`- \`symphony:${name}\`: The ${name}.`), `${label}: ${name}`);
        // no deterrence
        assert.doesNotMatch(prompt, /\boptional\b/i, label);
        assert.doesNotMatch(prompt, /costs tokens/i, label);
        assert.doesNotMatch(prompt, /use them where they pay off/i, label);
      }
    });

    it('gives each role with agents a trigger and an exclusion in every bullet, naming the agent', async () => {
      const roles = await shippedRoles();
      for (const role of ['developer', 'architect', 'analyst', 'planner', 'autopilot', 'auditor']) {
        const listed = roles[role];
        assert.ok(listed && listed.length > 0, role);
        const prompt = await render(role, listed.map(agent), {}, role === 'architect' ? ['feature', 'complexity: l'] : undefined);
        const bullets = delegateBullets(prompt);
        assert.ok(bullets.length >= 2, `${role}: ${bullets.length} bullets`);
        for (const bullet of bullets) {
          assert.match(bullet, NOT_FOR, `${role}: no exclusion in "${bullet}"`);
          assert.match(bullet, /`symphony:[a-z-]+`/, `${role}: no qualified agent name in "${bullet}"`);
        }
        // the first bullet is the explorer in every role that lists it
        assert.match(bullets[0]!, /`symphony:explorer`/, role);
        // no Liquid left over
        assert.doesNotMatch(prompt, /\{%|\{\{|%\}|\}\}/, role);
      }
    });

    it('developer: asks the explorer before about ten files, not for a handful of tool calls', async () => {
      const prompt = await render('developer', ALL.filter((n) => n !== 'test-designer').map(agent));
      const explorer = delegateBullets(prompt).find((b) => b.includes('`symphony:explorer`'));
      assert.ok(explorer);
      assert.match(explorer, /Before you read more than about ten files/);
      assert.match(explorer, /handful of tool calls/);
      assert.match(prompt, /before you report the result/);
    });

    it('architect: 2–3 explorers per code area, then reads their files itself', async () => {
      const prompt = await render('architect', [agent('explorer'), agent('laravel-architect')]);
      const explorer = delegateBullets(prompt).find((b) => b.includes('`symphony:explorer`'));
      assert.ok(explorer);
      assert.match(explorer, /2–3/);
      assert.match(explorer, /per code area|one per code area/);
      assert.match(explorer, /read (those|their) files yourself/);
    });

    it('the auditor and the command roles keep an occasion for the explorer', async () => {
      for (const role of ['analyst', 'planner', 'autopilot', 'auditor']) {
        const prompt = await render(role, [agent('explorer')]);
        const bullets = delegateBullets(prompt);
        assert.equal(bullets.length, 1, role);
        assert.match(bullets[0]!, /`symphony:explorer`/, role);
        assert.match(bullets[0]!, NOT_FOR, role);
      }
    });
  });

  describe('a bullet renders only for an allowed agent', () => {
    it('names no laravel-* agent when only the framework-neutral explorer is allowed', async () => {
      for (const role of ['developer', 'architect', 'analyst', 'planner', 'autopilot', 'auditor']) {
        const prompt = await render(role, [agent('explorer')]);
        assert.match(prompt, /`symphony:explorer`/, role);
        assert.doesNotMatch(prompt, /laravel-(architect|code-reviewer|database|filament|test)/, role);
        assert.equal(delegateBullets(prompt).length, 1, role);
      }
    });

    it('renders no occasion for a role whose only agent has no bullet in that role', async () => {
      // an agent the role files do not name: the generic intro stays, no empty "When to delegate:" heading
      const prompt = await render('developer', [{ name: 'acme:custom', description: 'Custom.' }]);
      assert.match(prompt, /Subagents you can start with the Agent tool/);
      assert.match(prompt, /- `acme:custom`: Custom\./);
      assert.doesNotMatch(prompt, /When to delegate/);
    });

    it('uses the name of the agent as given, whatever the plugin prefix', async () => {
      const prompt = await render('architect', [
        { name: 'other:explorer', description: 'x' },
        { name: 'other:laravel-architect', description: 'y' },
      ]);
      assert.match(prompt, /`other:explorer`/);
      assert.match(prompt, /`other:laravel-architect`/);
      assert.doesNotMatch(prompt, /symphony:/);
    });

    it('developer without the specialists renders no specialist bullet; with them, all three names', async () => {
      const without = await render('developer', [agent('explorer'), agent('laravel-code-reviewer')]);
      assert.doesNotMatch(without, /specialist/i);
      const withSpecialists = await render('developer', ['laravel-database-engineer', 'laravel-filament-developer', 'laravel-test-engineer'].map(agent));
      for (const name of ['laravel-database-engineer', 'laravel-filament-developer', 'laravel-test-engineer']) {
        assert.ok(withSpecialists.includes(`\`symphony:${name}\``), name);
      }
      const bullet = delegateBullets(withSpecialists).find((b) => /specialist/i.test(b));
      assert.ok(bullet);
      assert.match(bullet, NOT_FOR);
    });
  });

  describe('roles and sessions without agents are unchanged', () => {
    it('renders no intro and no occasions without agents, for every shipped role', async () => {
      const roles = await shippedRoles();
      for (const role of Object.keys(roles)) {
        const prompt = await render(role, []);
        assert.doesNotMatch(prompt, /Subagents you (can|may) start/, role);
        assert.doesNotMatch(prompt, /When to delegate/, role);
        assert.doesNotMatch(prompt, /Delegate where a trigger applies/, role);
        assert.doesNotMatch(prompt, /1,000–2,000 tokens/, role);
      }
    });

    it('renders no intro and no occasions for roles configured with agents: [] even when agents are passed', async () => {
      // The orchestrator passes the allowed agents; for these roles that is the empty list. The prompt must not
      // depend on anything but that list: with the empty list the render is identical to a render without agents.
      const roles = await shippedRoles();
      const empty = Object.entries(roles).filter(([, agents]) => Array.isArray(agents) && agents.length === 0).map(([name]) => name);
      assert.ok(empty.length >= 5, empty.join());
      for (const role of empty) {
        const prompt = await render(role, []);
        assert.doesNotMatch(prompt, /Subagents you can start|When to delegate|a trigger applies/, role);
      }
    });

    it('does not render the occasions in the roles that carry only the intro scaffold', async () => {
      for (const role of ['issue-analyst', 'reviewer', 'security-auditor']) {
        const prompt = await render(role, ALL.map(agent));
        assert.doesNotMatch(prompt, /When to delegate/, role);
      }
    });

    it('test-engineer: the designer alone at M renders nothing; the generic intro appears next to another agent', async () => {
      const alone = await render('test-engineer', [agent('test-designer')]);
      assert.doesNotMatch(alone, /Subagents you can start|When to delegate/);
      const next = await render('test-engineer', [agent('test-designer'), agent('explorer')]);
      assert.match(next, /Subagents you can start with the Agent tool/);
      assert.match(next, /Delegate where a trigger applies/);
      assert.doesNotMatch(next, /\boptional\b|costs tokens/i);
    });
  });

  describe('docs/configuration.md#subagents-per-role', () => {
    const docs = fs.readFileSync(path.join(root, 'docs', 'configuration.md'), 'utf8');
    const start = docs.indexOf('#### Subagents per role');
    const end = docs.indexOf('\n#### ', start + 10);
    const section = docs.slice(start, end > 0 ? end : undefined).replace(/\s+/g, ' ');

    it('exists and describes the brief rules', () => {
      assert.ok(start >= 0);
      for (const rule of [/acceptance criteria/, /absolute workspace path/, /boundaries/, /`file:line`/, /file lists instead of file contents/, /1,000–2,000 tokens/]) {
        assert.match(section, rule);
      }
    });

    it('describes the candidate rule, the trigger and the exclusion per role', () => {
      assert.match(section, /candidates/);
      assert.match(section, /never for what a few tool calls finish/);
      assert.match(section, /`symphony:explorer`/);
      assert.match(section, /trigger/);
      assert.match(section, /exclusion/);
      assert.match(section, /2–3/);
      assert.doesNotMatch(section, /phrased as optional|costs tokens/);
    });
  });
});
