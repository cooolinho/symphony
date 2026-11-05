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
});
