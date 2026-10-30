import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import YAML from 'yaml';
import { brainToolsFor, type BrainWriteEntry } from '../src/brain/tools.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import type { AgentToolContext, AgentToolSpec, ToolResult } from '../src/tracker/types.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, baseFront, makeIssue, makeWorkflow, tempDir, until } from './helpers.ts';

// Acceptance tests of #343 (brain_write, brain_append), derived from the issue text and used through the public tool API.

type Call = (args: Record<string, unknown>) => Promise<ToolResult>;

function put(dir: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const get = (dir: string, rel: string): string => fs.readFileSync(path.join(dir, rel), 'utf8');

function frontmatterOf(text: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, `has frontmatter: ${text}`);
  return YAML.parse(match[1]!) as Record<string, unknown>;
}

function newVault(): string {
  const dir = tempDir('symphony-vault-');
  put(dir, '.obsidian/app.json', '{}');
  put(dir, 'README.md', '# Rules\n');
  return dir;
}

function setup(dir: string, onWrite?: (entry: BrainWriteEntry) => void | Promise<void>, context: Partial<AgentToolContext> = {}) {
  const lines: string[] = [];
  const logger = Logger.create({ sinks: [{ name: 'memory', write: (line: string) => lines.push(line) }], level: 'debug' } as never);
  const ctx: AgentToolContext = { issue: makeIssue({ id: 'a' }), role: 'developer', runId: 'run-77', ...context };
  const specs: AgentToolSpec[] = brainToolsFor({ enabled: true, path: dir } as never, logger, onWrite ? { onWrite } : {});
  const call = (name: string): Call => {
    const spec = specs.find((s) => s.name === name);
    assert.ok(spec, `tool ${name} exists`);
    return (args) => spec.execute({ purpose: 'acceptance', ...args }, ctx);
  };
  return { write: call('brain_write'), append: call('brain_append'), read: call('brain_read'), specs, lines, ctx };
}

function data(result: ToolResult): any {
  assert.ok(result.ok, JSON.stringify(result));
  return result.data;
}

function err(result: ToolResult): { category: string; message: string; details?: any } {
  assert.equal(result.ok, false, `expected rejection, got ${JSON.stringify(result)}`);
  return (result as Extract<ToolResult, { ok: false }>).error;
}

const note = (front: string, body = 'Body text.'): string => `---\n${front}\n---\n${body}\n`;

describe('tool definitions', () => {
  it('registers brain_write and brain_append as mutating tools with purpose and base_hash in the schema', () => {
    const { specs } = setup(newVault());
    const write = specs.find((s) => s.name === 'brain_write')!;
    const append = specs.find((s) => s.name === 'brain_append')!;
    assert.equal(write.mutates, true);
    assert.equal(append.mutates, true);
    for (const key of ['path', 'content', 'purpose', 'base_hash']) assert.ok(key in write.inputSchema, `write.${key}`);
    for (const key of ['path', 'heading', 'text', 'purpose', 'base_hash']) assert.ok(key in append.inputSchema, `append.${key}`);
    for (const name of ['brain_search', 'brain_read', 'brain_list']) assert.equal(specs.find((s) => s.name === name)!.mutates, false);
  });
});

describe('brain_write: paths', () => {
  it('writes a new note and creates missing parent folders', async () => {
    const dir = newVault();
    const { write } = setup(dir);
    const result = data(await write({ path: 'Lessons/a/b/caching.md', content: note('type: lesson') }));
    assert.equal(result.path, 'Lessons/a/b/caching.md');
    assert.ok(fs.existsSync(path.join(dir, 'Lessons/a/b/caching.md')));
  });

  it('rejects .obsidian/ on any level and in any case, and the README.md in the vault root', async () => {
    const dir = newVault();
    const { write } = setup(dir);
    const before = get(dir, 'README.md');
    for (const bad of ['.obsidian/x.md', '.obsidian/app.json', 'Sub/.obsidian/x.md', '.Obsidian/x.md', 'README.md', './README.md', 'readme.md', 'Readme.MD']) {
      const error = err(await write({ path: bad, content: note('type: lesson') }));
      assert.equal(error.category, 'rejected', bad);
      assert.ok(error.message.length > 0, bad);
    }
    assert.equal(get(dir, 'README.md'), before);
    assert.ok(!fs.existsSync(path.join(dir, '.obsidian/x.md')));
    assert.ok(!fs.existsSync(path.join(dir, 'Sub')));
  });

  it('allows a README.md in a subfolder', async () => {
    const dir = newVault();
    const { write } = setup(dir);
    data(await write({ path: 'Lessons/README.md', content: note('type: index') }));
    assert.ok(fs.existsSync(path.join(dir, 'Lessons/README.md')));
  });

  it('rejects traversal, absolute paths, non-strings and non-markdown files', async () => {
    const dir = newVault();
    const outside = tempDir();
    const { write } = setup(dir);
    for (const bad of ['../evil.md', 'a/../../evil.md', path.join(outside, 'evil.md'), '/etc/evil.md', '~/evil.md', 'a\\b.md', 'note.txt', 'noext', 'a\0b.md']) {
      assert.equal(err(await write({ path: bad, content: note('type: lesson') })).category, 'rejected', bad);
    }
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.ok(!(await write({ path: 42, content: note('type: lesson') })).ok);
  });

  it('rejects a symlinked folder or file that leads out of the vault, and writes nothing there', async () => {
    const dir = newVault();
    const outside = tempDir();
    put(outside, 'victim.md', 'untouched');
    fs.symlinkSync(outside, path.join(dir, 'link'));
    fs.symlinkSync(path.join(outside, 'victim.md'), path.join(dir, 'file.md'));
    const { write, append } = setup(dir);
    assert.equal(err(await write({ path: 'link/new.md', content: note('type: lesson') })).category, 'rejected');
    assert.equal(err(await write({ path: 'file.md', content: note('type: lesson') })).category, 'rejected');
    assert.ok(!(await append({ path: 'file.md', heading: 'X', text: 'y', base_hash: sha('untouched') })).ok);
    assert.deepEqual(fs.readdirSync(outside), ['victim.md']);
    assert.equal(get(outside, 'victim.md'), 'untouched');
  });

  it('rejects content over the size limit', async () => {
    const dir = newVault();
    const { write } = setup(dir);
    const error = err(await write({ path: 'big.md', content: note('type: lesson', 'x'.repeat(1024 * 1024 + 10)) }));
    assert.equal(error.category, 'rejected');
    assert.ok(!fs.existsSync(path.join(dir, 'big.md')));
  });
});

describe('brain_write: frontmatter', () => {
  it('rejects a missing or unknown type with a hint and writes nothing', async () => {
    const dir = newVault();
    const { write } = setup(dir);
    for (const content of ['no frontmatter at all', note('status: candidate'), note('type: banana'), note('type: 5'), note('type: [lesson')]) {
      const error = err(await write({ path: 'x.md', content }));
      assert.equal(error.category, 'rejected', content);
      assert.ok(error.message.length > 10, content);
    }
    assert.ok(!fs.existsSync(path.join(dir, 'x.md')));
  });

  it('names the allowed types in the hint for a missing type', async () => {
    const { write } = setup(newVault());
    const error = err(await write({ path: 'x.md', content: note('title: t') }));
    for (const type of ['index', 'decision', 'lesson', 'issue', 'agent', 'note']) assert.ok(error.message.includes(type), type);
  });

  it('accepts every allowed type', async () => {
    const dir = newVault();
    const { write } = setup(dir);
    for (const type of ['index', 'decision', 'lesson', 'issue', 'agent', 'note']) {
      data(await write({ path: `T/${type}.md`, content: note(`type: ${type}`) }));
      assert.equal(frontmatterOf(get(dir, `T/${type}.md`)).type, type);
    }
  });

  it('requires sources to be a list', async () => {
    const dir = newVault();
    const { write } = setup(dir);
    assert.equal(err(await write({ path: 'x.md', content: note('type: lesson\nsources: just-a-string') })).category, 'rejected');
    assert.equal(err(await write({ path: 'x.md', content: note('type: lesson\nsources:\n  a: b') })).category, 'rejected');
    data(await write({ path: 'x.md', content: note('type: lesson\nsources:\n  - https://example.com\n  - "#12"') }));
    assert.deepEqual(frontmatterOf(get(dir, 'x.md')).sources, ['https://example.com', '#12']);
  });

  it('stamps issue, role, run, created and updated from the tool context and overrides what the agent wrote', async () => {
    const dir = newVault();
    const { write, ctx } = setup(dir);
    data(await write({
      path: 'x.md',
      content: note('type: decision\nrepo: acme/app\nissue: "#999"\nrole: security\nrun: forged\ncreated: 1999-01-01\nupdated: 1999-01-02\ncustom: keep-me'),
    }));
    const fm = frontmatterOf(get(dir, 'x.md'));
    assert.equal(fm.role, 'developer');
    assert.equal(fm.run, 'run-77');
    assert.equal(fm.issue, ctx.issue.identifier);
    assert.equal(fm.repo, 'acme/app');
    assert.equal(fm.custom, 'keep-me');
    const today = new Date().toISOString().slice(0, 10);
    assert.notEqual(String(fm.created), '1999-01-01');
    assert.notEqual(String(fm.updated), '1999-01-02');
    assert.match(String(fm.created), /^\d{4}-\d{2}-\d{2}/);
    assert.match(String(fm.updated), /^\d{4}-\d{2}-\d{2}/);
    assert.ok([today, new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)].includes(String(fm.created).slice(0, 10)));
  });

  it('keeps the body unchanged', async () => {
    const dir = newVault();
    const { write } = setup(dir);
    data(await write({ path: 'x.md', content: note('type: lesson', '# Title\n\nParagraph with `code` and [[link]].\n\n- a\n- b') }));
    const text = get(dir, 'x.md');
    assert.ok(text.includes('# Title\n\nParagraph with `code` and [[link]].\n\n- a\n- b'));
  });

  it('keeps created of an existing note and moves updated', async () => {
    const dir = newVault();
    const original = note('type: lesson\nstatus: candidate\ncreated: 2020-02-02\nupdated: 2020-02-03');
    put(dir, 'x.md', original);
    const { write } = setup(dir);
    data(await write({ path: 'x.md', content: note('type: lesson\ncreated: 2031-01-01'), base_hash: sha(original) }));
    const fm = frontmatterOf(get(dir, 'x.md'));
    assert.equal(String(fm.created).slice(0, 10), '2020-02-02');
    assert.notEqual(String(fm.updated).slice(0, 10), '2020-02-03');
  });
});

describe('brain_write: status', () => {
  it('gives a new note status candidate, whether the agent gave none, candidate or deprecated', async () => {
    const dir = newVault();
    const { write } = setup(dir);
    data(await write({ path: 'a.md', content: note('type: lesson') }));
    data(await write({ path: 'b.md', content: note('type: lesson\nstatus: candidate') }));
    data(await write({ path: 'c.md', content: note('type: lesson\nstatus: deprecated') }));
    for (const f of ['a.md', 'b.md', 'c.md']) assert.equal(frontmatterOf(get(dir, f)).status, 'candidate', f);
  });

  it('rejects creating a note with status approved (any spelling) and writes nothing', async () => {
    const dir = newVault();
    const { write } = setup(dir);
    for (const status of ['approved', 'Approved', '"APPROVED"']) {
      assert.equal(err(await write({ path: 'a.md', content: note(`type: lesson\nstatus: ${status}`) })).category, 'rejected', status);
    }
    assert.ok(!fs.existsSync(path.join(dir, 'a.md')));
  });

  it('rejects setting an approved note to another status and leaves the file unchanged', async () => {
    const dir = newVault();
    const original = note('type: lesson\nstatus: approved\ncreated: 2020-01-01', 'Human text.');
    put(dir, 'a.md', original);
    const { write } = setup(dir);
    for (const status of ['candidate', 'deprecated']) {
      assert.equal(err(await write({ path: 'a.md', content: note(`type: lesson\nstatus: ${status}`), base_hash: sha(original) })).category, 'rejected', status);
    }
    assert.equal(get(dir, 'a.md'), original);
  });

  it('rejects editing an approved note even with status approved', async () => {
    const dir = newVault();
    const original = note('type: lesson\nstatus: approved', 'Human text.');
    put(dir, 'a.md', original);
    const { write } = setup(dir);
    const result = await write({ path: 'a.md', content: note('type: lesson\nstatus: approved', 'Edited.'), base_hash: sha(original) });
    assert.equal(err(result).category, 'rejected');
    assert.equal(get(dir, 'a.md'), original);
  });

  it('does not let an agent promote a candidate note to approved', async () => {
    const dir = newVault();
    const original = note('type: lesson\nstatus: candidate');
    put(dir, 'a.md', original);
    const { write } = setup(dir);
    assert.equal(err(await write({ path: 'a.md', content: note('type: lesson\nstatus: approved'), base_hash: sha(original) })).category, 'rejected');
    assert.equal(get(dir, 'a.md'), original);
  });
});

describe('brain_write: base_hash', () => {
  it('overwrites an existing note when base_hash matches and returns the new hash', async () => {
    const dir = newVault();
    const original = note('type: lesson\nstatus: candidate', 'Old.');
    put(dir, 'a.md', original);
    const { write } = setup(dir);
    const result = data(await write({ path: 'a.md', content: note('type: lesson', 'New.'), base_hash: sha(original) }));
    assert.equal(result.created, false);
    assert.ok(get(dir, 'a.md').includes('New.'));
    assert.ok(!get(dir, 'a.md').includes('Old.'));
    assert.equal(result.hash, sha(get(dir, 'a.md')));
  });

  it('on a wrong base_hash rejects, returns the current content and hash, and writes nothing', async () => {
    const dir = newVault();
    const original = note('type: lesson\nstatus: candidate', 'Somebody else wrote this.');
    put(dir, 'a.md', original);
    const { write } = setup(dir);
    const error = err(await write({ path: 'a.md', content: note('type: lesson', 'Mine.'), base_hash: sha('stale version') }));
    assert.equal(error.category, 'rejected');
    assert.equal(error.details.content, original);
    assert.equal(error.details.hash, sha(original));
    assert.equal(get(dir, 'a.md'), original);
  });

  it('the hash of the conflict answer can be used right away for a retry', async () => {
    const dir = newVault();
    const original = note('type: lesson\nstatus: candidate', 'Theirs.');
    put(dir, 'a.md', original);
    const { write } = setup(dir);
    const error = err(await write({ path: 'a.md', content: note('type: lesson', 'Merged.'), base_hash: 'wrong' }));
    data(await write({ path: 'a.md', content: note('type: lesson', 'Merged.'), base_hash: error.details.hash }));
    assert.ok(get(dir, 'a.md').includes('Merged.'));
  });

  it('writes an existing note without base_hash but logs a warning; no warning for a new note', async () => {
    const dir = newVault();
    put(dir, 'a.md', note('type: lesson\nstatus: candidate', 'Old.'));
    const { write, lines } = setup(dir);
    data(await write({ path: 'new.md', content: note('type: lesson') }));
    const warnings = () => lines.filter((l) => /warn/i.test(l) && /base_hash/i.test(l));
    assert.equal(warnings().length, 0);
    data(await write({ path: 'a.md', content: note('type: lesson', 'Replaced.') }));
    assert.equal(warnings().length, 1);
    assert.ok(get(dir, 'a.md').includes('Replaced.'));
  });

  it('writes nothing and calls no hook when the frontmatter is invalid, even with a matching base_hash', async () => {
    const dir = newVault();
    const original = note('type: lesson\nstatus: candidate');
    put(dir, 'a.md', original);
    const entries: BrainWriteEntry[] = [];
    const { write } = setup(dir, (e) => void entries.push(e));
    err(await write({ path: 'a.md', content: 'no frontmatter', base_hash: sha(original) }));
    assert.equal(get(dir, 'a.md'), original);
    assert.equal(entries.length, 0);
  });
});

describe('brain_write: hash and purpose', () => {
  it('returns the hash brain_read reports for the written file', async () => {
    const dir = newVault();
    const { write, read } = setup(dir);
    const result = data(await write({ path: 'a.md', content: note('type: lesson') }));
    assert.equal(result.created, true);
    assert.equal(result.hash, sha(get(dir, 'a.md')));
    assert.equal(data(await read({ path: 'a.md' })).hash, result.hash);
  });

  it('logs a warning, but still writes, when purpose is missing', async () => {
    const dir = newVault();
    const { specs, lines, ctx } = setup(dir);
    const write = specs.find((s) => s.name === 'brain_write')!;
    data(await write.execute({ path: 'a.md', content: note('type: lesson') }, ctx));
    assert.ok(fs.existsSync(path.join(dir, 'a.md')));
    assert.ok(lines.some((l) => /purpose/i.test(l)));
  });

  it('leaves no temp files behind', async () => {
    const dir = newVault();
    const { write } = setup(dir);
    data(await write({ path: 'Inbox/a.md', content: note('type: lesson') }));
    data(await write({ path: 'Inbox/a.md', content: note('type: lesson', 'Again.') }));
    assert.deepEqual(fs.readdirSync(path.join(dir, 'Inbox')), ['a.md']);
  });
});

describe('brain_append', () => {
  const base = note('type: lesson\nstatus: candidate\ncreated: 2020-01-01\nupdated: 2020-01-01', '# Title\n\n## Findings\n\nFirst.\n\n## Other\n\nOther text.');

  it('creates the heading at the end when it is missing and appends the text', async () => {
    const dir = newVault();
    put(dir, 'a.md', base);
    const { append } = setup(dir);
    const result = data(await append({ path: 'a.md', heading: 'Neu', text: 'Added text.', base_hash: sha(base) }));
    const text = get(dir, 'a.md');
    assert.ok(text.trimEnd().endsWith('## Neu\n\nAdded text.'), text);
    assert.ok(text.includes('First.') && text.includes('Other text.'));
    assert.equal(result.hash, sha(text));
  });

  it('appends under an existing heading, at the end of its section and before the next heading', async () => {
    const dir = newVault();
    put(dir, 'a.md', base);
    const { append } = setup(dir);
    data(await append({ path: 'a.md', heading: 'Findings', text: 'Second.', base_hash: sha(base) }));
    const text = get(dir, 'a.md');
    const first = text.indexOf('First.');
    const second = text.indexOf('Second.');
    const other = text.indexOf('## Other');
    assert.ok(first < second && second < other, text);
    assert.equal(text.match(/^## Findings$/gm)?.length, 1);
    assert.ok(text.includes('Other text.'));
  });

  it('sets updated, keeps created and the candidate status, and stamps role and run', async () => {
    const dir = newVault();
    const approved = note('type: decision\nstatus: candidate\ncreated: 2020-01-01\nupdated: 2020-01-01', '## Notes\n\nHuman.');
    put(dir, 'a.md', approved);
    const { append } = setup(dir);
    data(await append({ path: 'a.md', heading: 'Notes', text: 'Agent.', base_hash: sha(approved) }));
    const fm = frontmatterOf(get(dir, 'a.md'));
    assert.equal(fm.status, 'candidate');
    assert.equal(String(fm.created).slice(0, 10), '2020-01-01');
    assert.notEqual(String(fm.updated).slice(0, 10), '2020-01-01');
    assert.equal(fm.type, 'decision');
    assert.equal(fm.role, 'developer');
    assert.equal(fm.run, 'run-77');
  });

  it('two sequential appends with the returned hash both land in the note', async () => {
    const dir = newVault();
    put(dir, 'a.md', base);
    const { append } = setup(dir);
    const one = data(await append({ path: 'a.md', heading: 'Log', text: 'one', base_hash: sha(base) }));
    const two = data(await append({ path: 'a.md', heading: 'Log', text: 'two', base_hash: one.hash }));
    const text = get(dir, 'a.md');
    assert.ok(text.indexOf('one') < text.indexOf('two'));
    assert.equal(two.hash, sha(text));
    assert.equal(text.match(/^## Log$/gm)?.length, 1);
  });

  it('requires base_hash and writes nothing without it', async () => {
    const dir = newVault();
    put(dir, 'a.md', base);
    const { append } = setup(dir);
    const error = err(await append({ path: 'a.md', heading: 'X', text: 'y' }));
    assert.ok(['rejected', 'invalid_argument'].includes(error.category), error.category);
    assert.equal(get(dir, 'a.md'), base);
  });

  it('rejects a wrong base_hash with the current version and hash', async () => {
    const dir = newVault();
    put(dir, 'a.md', base);
    const { append } = setup(dir);
    const error = err(await append({ path: 'a.md', heading: 'X', text: 'y', base_hash: 'nope' }));
    assert.equal(error.category, 'rejected');
    assert.equal(error.details.content, base);
    assert.equal(error.details.hash, sha(base));
    assert.equal(get(dir, 'a.md'), base);
  });

  it('fails for a note that does not exist and does not create it', async () => {
    const dir = newVault();
    const { append } = setup(dir);
    assert.ok(!(await append({ path: 'missing.md', heading: 'X', text: 'y', base_hash: sha('') })).ok);
    assert.ok(!fs.existsSync(path.join(dir, 'missing.md')));
  });

  it('applies the path rules of the write tools', async () => {
    const dir = newVault();
    const { append } = setup(dir);
    const readme = get(dir, 'README.md');
    for (const bad of ['README.md', '.obsidian/app.json', '../x.md']) {
      assert.equal(err(await append({ path: bad, heading: 'X', text: 'y', base_hash: sha(readme) })).category, 'rejected', bad);
    }
    assert.equal(get(dir, 'README.md'), readme);
    assert.equal(get(dir, '.obsidian/app.json'), '{}');
  });

  it('logs a warning when purpose is missing but still appends', async () => {
    const dir = newVault();
    put(dir, 'a.md', base);
    const { specs, lines, ctx } = setup(dir);
    const append = specs.find((s) => s.name === 'brain_append')!;
    data(await append.execute({ path: 'a.md', heading: 'X', text: 'y', base_hash: sha(base) }, ctx));
    assert.ok(lines.some((l) => /purpose/i.test(l)));
    assert.ok(get(dir, 'a.md').includes('y'));
  });
});

describe('onWrite hook', () => {
  it('is called once after each successful write and append with the tool, path and new hash', async () => {
    const dir = newVault();
    const entries: BrainWriteEntry[] = [];
    const { write, append } = setup(dir, (entry) => void entries.push(entry));
    const first = data(await write({ path: 'Lessons/a.md', content: note('type: lesson') }));
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.tool, 'brain_write');
    assert.equal(entries[0]!.path, 'Lessons/a.md');
    assert.equal(entries[0]!.hash, first.hash);
    assert.equal(entries[0]!.created, true);
    const second = data(await append({ path: 'Lessons/a.md', heading: 'H', text: 't', base_hash: first.hash }));
    assert.equal(entries.length, 2);
    assert.equal(entries[1]!.tool, 'brain_append');
    assert.equal(entries[1]!.path, 'Lessons/a.md');
    assert.equal(entries[1]!.hash, second.hash);
    assert.equal(entries[1]!.created, false);
  });

  it('is not called for rejected writes and appends', async () => {
    const dir = newVault();
    put(dir, 'a.md', note('type: lesson\nstatus: candidate'));
    const entries: BrainWriteEntry[] = [];
    const { write, append } = setup(dir, (entry) => void entries.push(entry));
    await write({ path: '.obsidian/x.md', content: note('type: lesson') });
    await write({ path: 'README.md', content: note('type: lesson') });
    await write({ path: 'n.md', content: note('type: lesson\nstatus: approved') });
    await write({ path: 'n.md', content: 'nothing' });
    await write({ path: 'a.md', content: note('type: lesson'), base_hash: 'wrong' });
    await append({ path: 'a.md', heading: 'X', text: 'y', base_hash: 'wrong' });
    await append({ path: 'a.md', heading: 'X', text: 'y' });
    assert.equal(entries.length, 0);
  });

  it('is awaited, and a throwing or rejecting hook does not make the tool fail', async () => {
    const dir = newVault();
    let done = false;
    const slow = setup(dir, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      done = true;
    });
    data(await slow.write({ path: 'a.md', content: note('type: lesson') }));
    assert.equal(done, true);

    const throwing = setup(dir, () => {
      throw new Error('hook broke');
    });
    const result = data(await throwing.write({ path: 'b.md', content: note('type: lesson') }));
    assert.ok(fs.existsSync(path.join(dir, 'b.md')));
    assert.equal(result.hash, sha(get(dir, 'b.md')));
    assert.ok(throwing.lines.some((l) => l.includes('hook broke')));

    const rejecting = setup(dir, () => Promise.reject(new Error('async hook broke')));
    data(await rejecting.append({ path: 'b.md', heading: 'H', text: 't', base_hash: sha(get(dir, 'b.md')) }));
    assert.ok(get(dir, 'b.md').includes('## H'));
  });

  it('works without a hook', async () => {
    const dir = newVault();
    const { write } = setup(dir);
    data(await write({ path: 'a.md', content: note('type: lesson') }));
  });
});

describe('worker wiring: role and run id reach the write tools', () => {
  async function sessionFor(brain: Record<string, unknown> | undefined) {
    const dir = newVault();
    const rootDir = tempDir();
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const workflow = new StaticWorkflow(makeWorkflow(baseFront(rootDir, brain === undefined ? {} : { brain: { path: dir, ...brain } })));
    const orchestrator = new Orchestrator({
      workflow,
      runner,
      logger: Logger.silent(),
      env: {},
      logDir: null,
      clock: new ManualClock(),
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker([makeIssue({ id: 'a' })]),
    });
    await orchestrator.tickNow();
    await until(() => runner.sessions.length === 1, 3_000, 'one session');
    return { params: runner.sessions[0]!.params, dir };
  }

  it('the session tool context carries role and run id, and a note written by the session is stamped with them', async () => {
    const { params, dir } = await sessionFor({ enabled: true });
    const context = params.toolContext();
    assert.equal(typeof context.role, 'string');
    assert.ok(context.role!.length > 0);
    const write = params.brainTools!.find((t) => t.name === 'brain_write')!;
    data(await write.execute({ path: 'Inbox/wired.md', content: note('type: note'), purpose: 'wiring' }, context));
    const fm = frontmatterOf(get(dir, 'Inbox/wired.md'));
    assert.equal(fm.role, context.role);
    assert.equal(fm.status, 'candidate');
    assert.equal(fm.issue, context.issue.identifier);
    if (context.runId !== undefined) assert.equal(fm.run, context.runId);
  });

  it('gives the session no write tools without brain.enabled', async () => {
    assert.deepEqual((await sessionFor({ enabled: false })).params.brainTools ?? [], []);
    assert.deepEqual((await sessionFor(undefined)).params.brainTools ?? [], []);
  });
});
