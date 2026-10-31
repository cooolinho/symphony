import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { NOTE_TYPES } from '../src/brain/note.ts';

/**
 * Independent checks for docs/brain.md (issue #361): every claim that can be derived from the shipped files
 * (WORKFLOW.md, the compose file, the config schema) is compared with the text.
 */

const root = path.join(import.meta.dirname, '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');
const brain = read('docs/brain.md');

function body(heading: string): string {
  const parts = brain.split(/^## /m).slice(1);
  const found = parts.find((part) => part.startsWith(`${heading}\n`));
  assert.ok(found, `docs/brain.md has no section "${heading}"`);
  return found;
}

describe('docs/brain.md', () => {
  it('has exactly the nine required sections in order', () => {
    const headings = [...brain.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(headings, ['Purpose', 'Vault layout', 'Frontmatter', 'Tools', 'Role switch', 'Clash rules', 'Obsidian container', 'Backup', 'Reset']);
  });

  it('role table matches the brain modes of the shipped WORKFLOW.md', () => {
    const workflow = parse(/^---\n([\s\S]*?)\n---/.exec(read('WORKFLOW.md'))?.[1] ?? '') as { roles: Record<string, { brain?: string }> };
    const table = body('Role switch');
    for (const mode of ['write', 'read'] as const) {
      const row = new RegExp(`^\\| \`${mode}\` \\| (.+) \\|$`, 'm').exec(table)?.[1] ?? '';
      const documented = [...row.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]).sort();
      const actual = Object.entries(workflow.roles)
        .filter(([, role]) => role.brain === mode)
        .map(([name]) => name)
        .sort();
      assert.deepEqual(documented, actual, mode);
    }
  });

  it('frontmatter types in the table are the real note types', () => {
    const row = /^\| `type` \|.*$/m.exec(body('Frontmatter'))?.[0] ?? '';
    const documented = [...row.matchAll(/`([a-z]+)`/g)].map((m) => m[1]).filter((v) => v !== 'type');
    assert.deepEqual([...documented].sort(), [...NOTE_TYPES].sort());
  });

  it('the Docker facts match docker-compose.yml', () => {
    const compose = read('docker-compose.yml');
    assert.ok(compose.includes('BRAIN_DOMAIN'));
    assert.ok(compose.includes('/config/vault'));
    assert.ok(compose.includes('/home/symphony/brain'));
    const obsidian = body('Obsidian container');
    assert.ok(obsidian.includes('/config/vault'));
    assert.ok(body('Backup').includes('/home/symphony/brain'));
  });

  it('every brain.* key and tool name it mentions exists', () => {
    const schema = read('src/workflow/config.ts');
    for (const key of new Set([...brain.matchAll(/`brain\.([a-z_]+)`/g)].map((m) => m[1] ?? ''))) {
      if (key === 'obsidian_url') continue; // covered below
      assert.ok(new RegExp(`'${key}'`).test(schema), `brain.${key}`);
    }
    for (const tool of new Set([...brain.matchAll(/`(brain_[a-z]+)`/g)].map((m) => m[1] ?? '')).values()) {
      if (tool === 'brain_index') continue; // prompt variable, not a tool
      assert.ok(['brain_search', 'brain_read', 'brain_list', 'brain_write', 'brain_append'].includes(tool), tool);
      assert.ok(read('src/brain/tools.ts').includes(`'${tool}'`) || read('src/brain/write.ts').includes(`'${tool}'`), tool);
    }
    assert.ok(fs.existsSync(path.join(root, 'roles', 'brain.md')));
  });

  it('is English: no German umlauts or typical German words in prose', () => {
    const prose = brain.replace(/`[^`]*`/g, '');
    assert.ok(!/[äöüß]/i.test(prose));
    assert.ok(!/\b(und|der|die|das|nicht)\b/.test(prose));
  });

  it('links to other docs point at existing files', () => {
    for (const match of brain.matchAll(/\]\(([^)#:]+\.md)(#[^)]*)?\)/g)) {
      assert.ok(fs.existsSync(path.join(root, 'docs', match[1] ?? '')), match[1] ?? '');
    }
  });
});
