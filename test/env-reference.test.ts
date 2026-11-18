import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseEnv } from 'node:util';

const root = path.join(import.meta.dirname, '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

/** Names in examples and comments, not variables anyone sets. */
const NOT_VARIABLES = new Set(['NAME', 'VAR']);

function documented(): Set<string> {
  return new Set([...read('docs/environment.md').matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((match) => match[1] as string));
}

describe('docs/environment.md', () => {
  it('documents every variable of .env.example, set or commented out', () => {
    const names = [...read('.env.example').matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1] as string);
    assert.ok(names.length >= 10, 'found the variables');
    const missing = names.filter((name) => !documented().has(name));
    assert.deepEqual(missing, []);
  });

  it('documents every variable WORKFLOW.md and the compose files reference', () => {
    const names = new Set<string>();
    for (const file of ['WORKFLOW.md', 'docker-compose.yml', 'docker-compose.local.yml']) {
      for (const match of read(file).matchAll(/\$\{?([A-Z][A-Z0-9_]+)/g)) names.add(match[1] as string);
    }
    const missing = [...names].filter((name) => !NOT_VARIABLES.has(name) && !documented().has(name));
    assert.deepEqual(missing, []);
  });

  it('keeps .env.example lean and parseable', () => {
    const text = read('.env.example');
    assert.ok(text.split('\n').length <= 50, '.env.example stays short; details belong in docs/environment.md');
    const parsed = parseEnv(text);
    assert.deepEqual(Object.keys(parsed).sort(), ['CLAUDE_MODEL', 'GITHUB_PROJECT_NUMBER', 'GITHUB_REPOSITORY', 'GITHUB_TOKEN']);
    assert.match(text, /\.\/install\.sh/);
    assert.match(text, /docs\/environment\.md/);
  });
});
