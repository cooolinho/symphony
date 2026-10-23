import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { commandSkills } from '../src/workflow/command.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { compilePrompt, issueTemplateValue, renderPrompt } from '../src/workflow/template.ts';
import { makeIssue } from './helpers.ts';

// Issue #287: agents use jq and python3 in Bash; the image must ship jq and agents must be told python3 is missing.

const root = path.join(import.meta.dirname, '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');
const shipped = path.join(root, 'WORKFLOW.md');
const toolbox = path.join(root, '.claude');

/** Dockerfile instructions with continuations joined and comments dropped. */
function instructions(): string[] {
  return read('Dockerfile')
    .replace(/\\\r?\n/g, ' ')
    .split('\n')
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .filter((l) => l !== '' && !l.startsWith('#'));
}

/** The package names of every `apt-get install` in the Dockerfile. */
function aptPackages(): string[] {
  const packages: string[] = [];
  for (const line of instructions()) {
    for (const part of line.split(/&&|;/)) {
      const m = part.trim().match(/^(?:RUN )?apt-get install (.*)$/);
      if (m) packages.push(...(m[1] ?? '').split(' ').filter((p) => p !== '' && !p.startsWith('-')));
    }
  }
  return packages;
}

async function renderFor(role: string, attempt: number | null): Promise<string> {
  const { definition } = await loadWorkflowFile(shipped);
  const template = compilePrompt(definition.promptTemplate, definition.partials);
  assert.equal(template.parseError, null);
  const issue = makeIssue({
    id: 'PVTI_1',
    identifier: 'acme/app#42',
    title: 'Add invoices',
    description: 'Create an invoice resource.',
    state: 'In progress',
    url: 'https://github.com/acme/app/issues/42',
    labels: ['feature'],
    native_ref: { provider: 'github_project', repository: 'acme/app', number: 42, parent: null, sub_issues: [], base_branch: null },
  });
  return renderPrompt(template, { issue: issueTemplateValue(issue, commandSkills([toolbox])), attempt, role, agents: [] });
}

describe('#287 Dockerfile: jq', () => {
  it('installs jq via apt-get', () => {
    assert.ok(aptPackages().includes('jq'), `apt packages: ${aptPackages().join(' ')}`);
  });

  it('keeps the existing system tools', () => {
    const apt = aptPackages();
    for (const tool of ['bash', 'ca-certificates', 'curl', 'git', 'openssh-client', 'openssl', 'ripgrep', 'tini', 'unzip']) {
      assert.ok(apt.includes(tool), `${tool} still installed`);
    }
  });

  it('installs jq without recommended packages, like the other system tools', () => {
    const run = instructions().find((l) => /apt-get install/.test(l) && /\bjq\b/.test(l));
    assert.ok(run);
    assert.match(run, /--no-install-recommends/);
  });
});

describe('#287 Dockerfile: python3 decision', () => {
  it('does not install python3 (decision: hint instead of installation)', () => {
    assert.doesNotMatch(instructions().join('\n'), /python3?(-minimal)?\b/);
  });
});

describe('#287 Dockerfile: unchanged parts', () => {
  const lines = instructions();

  it('keeps the base image and PHP setup', () => {
    assert.ok(lines.includes('FROM node:26-trixie-slim'));
    assert.ok(lines.includes('ARG PHP_VERSION=8.4'));
    assert.ok(lines.some((l) => /packages\.sury\.org/.test(l)), 'PHP still comes from the Sury repository');
    assert.ok(lines.some((l) => /php\$\{PHP_VERSION\}-cli/.test(l)), 'php cli still installed');
  });

  it('keeps the user and entrypoint', () => {
    assert.ok(lines.includes('ARG UID=1000'));
    assert.ok(lines.includes('ARG GID=1000'));
    assert.ok(lines.includes('USER symphony'));
    assert.ok(lines.includes('ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]'));
  });
});

describe('#287 shared agent prompt', () => {
  for (const [role, attempt] of [
    ['developer', null],
    ['developer', 2],
    ['test-engineer', null],
    ['reviewer', null],
    ['issue-analyst', null],
  ] as const) {
    it(`renders for ${role} (attempt ${attempt ?? 'none'}) and names the script tools`, async () => {
      const prompt = await renderFor(role, attempt);
      assert.match(prompt, /`jq`/);
      assert.match(prompt, /`node`/);
      assert.match(prompt, /`php`/);
      assert.match(prompt, /`python3`/);
      const line = prompt.split('\n').find((l) => l.includes('`python3`'));
      assert.ok(line);
      assert.match(line, /python3`? (is|does) ?n[o']?t|python3`? (is )?not|no python3|without python3|not (installed|available)/i);
    });
  }

  it('leaves no unrendered Liquid in the prompt', async () => {
    const prompt = await renderFor('developer', null);
    assert.doesNotMatch(prompt, /\{\{|\{%/);
    assert.match(prompt, /## Issue description/);
    assert.match(prompt, /Create an invoice resource\./);
  });

  it('puts the hint in the shared section, once, not in a role-specific block', async () => {
    const prompt = await renderFor('developer', null);
    assert.equal(prompt.split('`python3`').length - 1, 1);
  });
});

describe('#287 docs/docker.md', () => {
  const docs = read('docs/docker.md');

  it('documents that the image ships jq and that an older image needs a rebuild', () => {
    const row = docs.split('\n').find((l) => /jq/.test(l) && /^\|/.test(l));
    assert.ok(row, 'a table row mentions jq');
    assert.match(row, /jq: command not found/);
    assert.match(row, /docker compose up -d --build/);
  });

  it('documents that python3 is deliberately not installed', () => {
    const row = docs.split('\n').find((l) => /jq/.test(l) && /^\|/.test(l));
    assert.ok(row);
    assert.match(row, /python3/);
    assert.match(row, /not installed|deliberately|does not/i);
  });
});
