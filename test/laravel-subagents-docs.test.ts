import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const docsDir = path.resolve(import.meta.dirname, '..', 'docs');
const doc = fs.readFileSync(path.join(docsDir, 'laravel-subagents.md'), 'utf8');

describe('docs/laravel-subagents.md', () => {
  it('only links to files that exist', () => {
    const links = [...doc.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? '').filter((link) => !/^[a-z]+:|^#/.test(link));
    for (const link of links) {
      const file = link.split('#')[0] ?? '';
      assert.ok(fs.existsSync(path.join(docsDir, file)), `broken link: ${link}`);
    }
  });

  it('still names the five laravel subagents the roles refer to', () => {
    for (const name of ['laravel-architect', 'laravel-filament-developer', 'laravel-database-engineer', 'laravel-test-engineer', 'laravel-code-reviewer']) {
      assert.ok(doc.includes(name), name);
    }
  });

  it('lists no subagents in the role table for the four roles that only repeated their persona', () => {
    for (const role of ['issue analyst', 'test engineer', 'reviewer', 'security auditor']) {
      const row = doc.split('\n').find((line) => line.startsWith(`| ${role} |`));
      assert.ok(row, `${role} row`);
      assert.match(row, /^\|[^|]+\| none \(`\[\]`\) \|/, role);
    }
  });

  it('shows the reviewer example with an empty agents list', () => {
    assert.match(doc, /  reviewer:\n    agents: \[\]\n/);
    assert.doesNotMatch(doc, /reviewer:\n\s+agents: \[laravel-code-reviewer\]/);
  });

  it('names all six roles with [] in docs/configuration.md#subagents-per-role', () => {
    const configuration = fs.readFileSync(path.join(docsDir, 'configuration.md'), 'utf8');
    const section = configuration.slice(configuration.indexOf('The role\'s list.'));
    const line = section.split('\n')[0] ?? '';
    for (const role of ['docs', 'brain-gardener', 'issue-analyst', 'test-engineer', 'reviewer', 'security-auditor']) {
      assert.ok(line.includes(`\`${role}\``), role);
    }
    assert.match(line, /with `\[\]`/);
    assert.doesNotMatch(configuration, /agents: \[laravel-(test-engineer|code-reviewer)\]/);
    const examples = [...configuration.matchAll(/^    agents: (\[[^\]]*\])/gm)].map((match) => match[1]);
    assert.deepEqual(examples, ['[]', '[laravel-architect]', '[]', '[]']);
  });
});
