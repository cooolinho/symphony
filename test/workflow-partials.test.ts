import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Logger } from '../src/log.ts';
import { SymphonyError } from '../src/util/errors.ts';
import { loadPartials, loadWorkflowFile, parseWorkflow } from '../src/workflow/loader.ts';
import { WorkflowStore } from '../src/workflow/store.ts';
import { compilePrompt, renderPrompt } from '../src/workflow/template.ts';
import { tempDir } from './helpers.ts';

/** The WORKFLOW.md shipped in the repository root. */
const shipped = path.join(import.meta.dirname, '..', 'WORKFLOW.md');

/** A workflow directory with WORKFLOW.md and the given files next to it. */
function workflowDir(files: Record<string, string>): string {
  const dir = tempDir();
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

const codeOf = (error: unknown): string => (error instanceof SymphonyError ? error.code : String(error));

describe('prompt partials', () => {
  it('loads the files a prompt includes, relative to WORKFLOW.md and recursively', async () => {
    const dir = workflowDir({
      'roles/developer.md': 'Developer {% include "roles/shared.md" %}',
      'roles/shared.md': 'shared\r\n',
    });
    const partials = await loadPartials('{% case role %}{%- when "developer" %}{% include "roles/developer.md" %}{% endcase %}', dir);
    assert.deepEqual(partials, { 'roles/developer.md': 'Developer {% include "roles/shared.md" %}', 'roles/shared.md': 'shared\n' });
  });

  it('rejects a missing file and a path outside the workflow directory', async () => {
    const dir = workflowDir({});
    await assert.rejects(loadPartials('{% include "roles/missing.md" %}', dir), (error) => codeOf(error) === 'missing_prompt_partial');
    for (const name of ['../outside.md', './roles/x.md', '/etc/passwd', 'roles/../../outside.md']) {
      await assert.rejects(loadPartials(`{% include "${name}" %}`, dir), (error) => codeOf(error) === 'invalid_prompt_partial', name);
    }
  });

  it('has no partials without a directory', () => {
    assert.deepEqual(parseWorkflow('---\n---\n{% include "roles/x.md" %}').partials, {});
  });

  it('renders an included file in the scope of the prompt, with strict variables', async () => {
    const partials = { 'roles/developer.md': 'Branch {{ branch }} for {{ issue.title }}' };
    const template = compilePrompt('{% capture branch %}feat/x{% endcapture %}{% include "roles/developer.md" %}', partials);
    assert.equal(template.parseError, null);
    assert.equal(await renderPrompt(template, { issue: { title: 'Invoices' } }), 'Branch feat/x for Invoices');

    const strict = compilePrompt('{% include "roles/developer.md" %}', { 'roles/developer.md': '{{ unknown }}' });
    await assert.rejects(renderPrompt(strict, {}), (error) => codeOf(error) === 'template_render_error');
  });

  it('never reads an include from the disk', async () => {
    const template = compilePrompt('{% include "package.json" %}');
    await assert.rejects(renderPrompt(template, {}), /Failed to lookup "package.json"/);
  });

  it('names the file with a syntax error', () => {
    const template = compilePrompt('{% include "roles/reviewer.md" %}', { 'roles/reviewer.md': '{% if %}' });
    assert.equal(template.parsed, null);
    assert.match(template.parseError ?? '', /^roles\/reviewer\.md: /);
  });

  it('reloads a changed include and keeps the last good version when one goes missing', async () => {
    const dir = workflowDir({ 'WORKFLOW.md': '---\n---\n{% include "roles/developer.md" %}', 'roles/developer.md': 'Version A' });
    const file = path.join(dir, 'WORKFLOW.md');
    const store = await WorkflowStore.open(file, { env: {}, logger: Logger.silent() });
    assert.equal(await renderPrompt(store.current.prompt, {}), 'Version A');

    await store.refreshIfChanged();
    assert.equal(store.current.version, 1, 'unchanged files are no new version');

    fs.writeFileSync(path.join(dir, 'roles/developer.md'), 'Version B');
    await store.refreshIfChanged();
    assert.equal(store.current.version, 2);
    assert.equal(await renderPrompt(store.current.prompt, {}), 'Version B');

    fs.rmSync(path.join(dir, 'roles/developer.md'));
    await store.refreshIfChanged();
    assert.equal(store.lastError?.code, 'missing_prompt_partial');
    assert.equal(store.current.version, 2);
    assert.equal(await renderPrompt(store.current.prompt, {}), 'Version B');

    fs.writeFileSync(path.join(dir, 'roles/developer.md'), 'Version B');
    await store.refreshIfChanged();
    assert.equal(store.lastError, null);
    store.close();
  });

  it('fails to start without an included file', async () => {
    const dir = workflowDir({ 'WORKFLOW.md': '---\n---\n{% include "roles/developer.md" %}' });
    await assert.rejects(
      WorkflowStore.open(path.join(dir, 'WORKFLOW.md'), { env: {}, logger: Logger.silent() }),
      (error) => codeOf(error) === 'missing_prompt_partial',
    );
  });
});

describe('shipped role prompts', () => {
  it('gives every role of WORKFLOW.md a file in roles/ and a when branch', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const roles = Object.keys(definition.config.roles as Record<string, unknown>).sort();
    const files = fs
      .readdirSync(path.join(path.dirname(shipped), 'roles'))
      .map((file) => file.replace(/\.md$/, ''))
      .filter((name) => name !== 'default' && name !== 'brain')
      .sort();
    const branches = [...definition.promptTemplate.matchAll(/\{%-? when "([a-z-]+)" %\}\{% include "roles\/([a-z-]+)\.md" %\}/g)];
    assert.deepEqual(files, roles, 'one roles/<role>.md per role');
    assert.deepEqual(branches.map((match) => match[1]).sort(), roles, 'one when branch per role');
    assert.ok(branches.every((match) => match[1] === match[2]), 'each branch includes the file of its role');
    assert.ok(Object.hasOwn(definition.partials, 'roles/default.md'), 'roles without a branch get roles/default.md');
    assert.equal(compilePrompt(definition.promptTemplate, definition.partials).parseError, null);
  });
});
