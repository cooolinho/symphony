import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { dryRun } from '../src/service.ts';
import { githubProjectFactory } from '../src/tracker/github-project/index.ts';
import { FakeTracker, makeIssue, tempDir } from './helpers.ts';

// Independent test (E7-5): the dry-run prompt preview renders with the session's brain level of the role.

const original = githubProjectFactory.create;

afterEach(() => {
  githubProjectFactory.create = original;
});

async function preview(roleBrain: string | null, brainEnabled: boolean): Promise<string> {
  const dir = tempDir();
  const vault = tempDir();
  const roleLines = roleBrain === null ? '' : `    brain: ${roleBrain}\n`;
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
      'brain:',
      `  enabled: ${brainEnabled}`,
      `  path: ${vault}`,
      'roles:',
      '  dev:',
      '    states: [Todo, In Progress]',
      roleLines.trimEnd(),
      '---',
      '{% if brain != "off" %}BRAIN-SECTION level={{ brain }}{% else %}NO-BRAIN-SECTION{% endif %}',
    ]
      .filter((line) => line !== '')
      .join('\n'),
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

describe('dry-run prompt preview with the role switch brain', () => {
  it('shows the brain level of a write role when the brain is enabled', async () => {
    assert.match(await preview('write', true), /BRAIN-SECTION level=write/);
  });

  it('shows the brain level of a read role when the brain is enabled', async () => {
    assert.match(await preview('read', true), /BRAIN-SECTION level=read/);
  });

  it('shows off for a role with brain: off', async () => {
    assert.match(await preview('off', true), /NO-BRAIN-SECTION/);
  });

  it('shows off for a role without the field', async () => {
    assert.match(await preview(null, true), /NO-BRAIN-SECTION/);
  });

  it('shows off when brain.enabled is false even for a write role', async () => {
    assert.match(await preview('write', false), /NO-BRAIN-SECTION/);
  });
});
