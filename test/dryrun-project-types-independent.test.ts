import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { defaultIntegrations } from '../src/integrations/registry.ts';
import { dryRun } from '../src/service.ts';
import { githubProjectFactory } from '../src/tracker/github-project/index.ts';
import { FakeTracker, makeIssue, tempDir } from './helpers.ts';

// Independent test (#550): the dry-run prompt preview passes project_types (ids of all integrations that can detect apps).

const original = githubProjectFactory.create;

afterEach(() => {
  githubProjectFactory.create = original;
});

async function preview(body: string): Promise<string> {
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, 'WORKFLOW.md'),
    [
      '---',
      'tracker:',
      '  kind: github_project',
      '  provider:',
      '    owner: acme',
      '    project_number: 1',
      '    token: t',
      'workspace:',
      `  root: ${path.join(dir, 'ws')}`,
      '---',
      body,
    ].join('\n'),
  );
  githubProjectFactory.create = () => new FakeTracker([makeIssue({ id: 'a' })]) as never;
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  let status: number;
  try {
    status = await dryRun({ workflowPath: path.join(dir, 'WORKFLOW.md'), env: {}, envFile: null, logLevel: 'error', logDir: null });
  } finally {
    process.stdout.write = write;
  }
  const output = chunks.join('');
  assert.equal(status, 0, output);
  return output;
}

describe('dry-run prompt preview: project_types', () => {
  it('lists laravel in project_types for a flat (non-role) prompt', async () => {
    assert.match(await preview('TYPES=[{{ project_types | join: "," }}]'), /TYPES=\[laravel\]/);
  });

  it('is not the empty fallback: project_types.size is at least 1', async () => {
    const out = await preview('SIZE={{ project_types.size }}');
    assert.match(out, /SIZE=1\b/);
    assert.doesNotMatch(out, /SIZE=0/);
  });

  it('turns on a template branch guarded by contains "laravel"', async () => {
    const out = await preview('{% if project_types contains "laravel" %}LARAVEL-HINTS{% else %}NO-HINTS{% endif %}');
    assert.match(out, /LARAVEL-HINTS/);
    assert.doesNotMatch(out, /NO-HINTS/);
  });

  it('equals the ids of every default integration that defines appDirs', async () => {
    const expected = defaultIntegrations()
      .filter((integration) => integration.appDirs !== undefined)
      .map((integration) => integration.id)
      .join(',');
    assert.ok(expected.length > 0);
    assert.match(await preview('TYPES=[{{ project_types | join: "," }}]'), new RegExp(`TYPES=\\[${expected}\\]`));
  });

  it('keeps the other preview variables rendering (test_paths still passed)', async () => {
    const out = await preview('T={{ project_types.size }} P={{ test_paths.size }}');
    assert.match(out, /T=1 P=\d+/);
  });
});

describe('dry-run project_types: documentation and comment', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

  it('docs/configuration.md says which project_types the dry-run preview uses', () => {
    const doc = read('docs/configuration.md');
    const line = doc.split('\n').find((l) => l.startsWith('- `project_types`'));
    assert.ok(line, 'project_types variable entry missing');
    assert.match(line, /dry-run/i);
    assert.match(line, /laravel/);
  });

  it('docs/usage.md mentions project_types next to the dry-run preview', () => {
    const doc = read('docs/usage.md');
    assert.match(doc, /dry-run[^\n]*\n?[^\n]*project_types|project_types[^\n]*\n?[^\n]*dry-run/is);
    assert.match(doc, /preview uses `project_types`/);
  });

  it('src/service.ts states the "every integration applies" choice near project_types', () => {
    const src = read('src/service.ts');
    const idx = src.indexOf('project_types: ');
    assert.ok(idx > 0, 'project_types not passed in service.ts');
    const before = src.slice(Math.max(0, idx - 2500), idx);
    assert.match(before, /\/\/[^\n]*project_types[^\n]*|\/\/[^\n]*every integration/);
  });
});
