import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { appendUnderHeading, prepareFrontmatter } from '../src/brain/note.ts';
import { BrainAccessLog } from '../src/brain/access-log.ts';
import { createBrainTools, createBrainWriteTools, type BrainWriteEntry } from '../src/brain/tools.ts';
import { Logger } from '../src/log.ts';
import type { AgentToolContext, ToolResult } from '../src/tracker/types.ts';
import { makeIssue, tempDir } from './helpers.ts';

type Call = (args: Record<string, unknown>) => Promise<ToolResult>;

const NOW = new Date('2026-10-30T12:00:00Z');

function vault(): string {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'Inbox'));
  fs.mkdirSync(path.join(dir, '.obsidian'));
  return dir;
}

function setup(dir: string, options: { context?: Partial<AgentToolContext>; onWrite?: (entry: BrainWriteEntry) => void | Promise<void> } = {}) {
  const lines: string[] = [];
  const logger = Logger.create({ sinks: [{ name: 'memory', write: (line: string) => lines.push(line) }], level: 'debug' } as never);
  const context: AgentToolContext = { issue: makeIssue({ id: 'a' }), role: 'developer', runId: 'run1', ...options.context };
  const tools: Record<string, Call> = {};
  const specs = [
    ...createBrainTools(dir, logger),
    ...createBrainWriteTools(dir, logger, { now: () => NOW, ...(options.onWrite ? { onWrite: options.onWrite } : {}) }),
  ];
  for (const spec of specs) tools[spec.name] = (args) => spec.execute({ purpose: 'test', ...args }, context);
  return { tools, lines, context };
}

function data(result: ToolResult): any {
  assert.ok(result.ok, JSON.stringify(result));
  return result.data;
}

function failure(result: ToolResult): { category: string; message: string; details?: any } {
  assert.equal(result.ok, false, JSON.stringify(result));
  return (result as Extract<ToolResult, { ok: false }>).error as never;
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const note = (front: string, body = 'Body.'): string => `---\n${front}\n---\n${body}\n`;
const read = (dir: string, rel: string): string => fs.readFileSync(path.join(dir, rel), 'utf8');

describe('brain_write', () => {
  it('creates a candidate note and stamps issue, role, run and dates', async () => {
    const dir = vault();
    const { tools, context } = setup(dir);
    const result = data(await tools.brain_write!({ path: 'Inbox/x.md', content: note('type: lesson\nstatus: deprecated\nrole: hacker\ntitle: Hi'), purpose: 'p' }));
    assert.equal(result.created, true);
    const text = read(dir, 'Inbox/x.md');
    assert.match(text, /^type: lesson$/m);
    assert.match(text, /^status: candidate$/m);
    assert.match(text, /^role: developer$/m);
    assert.match(text, /^run: run1$/m);
    assert.match(text, new RegExp(`^issue: ${context.issue.identifier.replace('/', '\\/')}$`, 'm'));
    assert.match(text, /^created: 2026-10-30$/m);
    assert.match(text, /^updated: 2026-10-30$/m);
    assert.match(text, /^title: Hi$/m);
    assert.ok(!text.includes('hacker'));
    assert.equal(fs.readdirSync(path.join(dir, 'Inbox')).filter((f) => f.endsWith('.tmp')).length, 0);
  });

  it('omits role and run without context and creates parent folders', async () => {
    const dir = vault();
    const { tools } = setup(dir, { context: { role: undefined as never, runId: undefined as never } });
    data(await tools.brain_write!({ path: 'Lessons/neu/tief/x.md', content: note('type: note\nrole: hacker\nrun: fake') }));
    const text = read(dir, 'Lessons/neu/tief/x.md');
    assert.ok(!/^role:/m.test(text) && !/^run:/m.test(text));
  });

  it('rejects creating approved notes and changing approved ones', async () => {
    const dir = vault();
    const { tools } = setup(dir);
    assert.equal(failure(await tools.brain_write!({ path: 'Inbox/a.md', content: note('type: lesson\nstatus: approved') })).category, 'rejected');
    assert.ok(!fs.existsSync(path.join(dir, 'Inbox/a.md')));

    const approved = note('type: lesson\nstatus: approved\ncreated: 2026-01-01');
    fs.writeFileSync(path.join(dir, 'Inbox/b.md'), approved);
    const demote = await tools.brain_write!({ path: 'Inbox/b.md', content: note('type: lesson\nstatus: candidate'), base_hash: sha(approved) });
    assert.equal(failure(demote).category, 'rejected');
    assert.equal(read(dir, 'Inbox/b.md'), approved);

    for (const content of [note('type: lesson', 'New.'), note('type: lesson\nstatus: approved', 'New.')]) {
      const edit = await tools.brain_write!({ path: 'Inbox/b.md', content, base_hash: sha(approved) });
      assert.equal(failure(edit).category, 'rejected');
    }
    assert.equal(read(dir, 'Inbox/b.md'), approved);

    const candidate = note('type: lesson\nstatus: candidate');
    fs.writeFileSync(path.join(dir, 'Inbox/c.md'), candidate);
    const promote = await tools.brain_write!({ path: 'Inbox/c.md', content: note('type: lesson\nstatus: approved'), base_hash: sha(candidate) });
    assert.equal(failure(promote).category, 'rejected');
  });

  it('checks the frontmatter', async () => {
    const dir = vault();
    const { tools } = setup(dir);
    const cases: Array<[string, string, RegExp]> = [
      ['no frontmatter', 'just text', /type/],
      ['no type', note('status: candidate'), /type/],
      ['bad type', note('type: banana'), /type/],
      ['bad yaml', note('type: [lesson'), /YAML/],
      ['sources', note('type: lesson\nsources: foo'), /sources/],
    ];
    for (const [name, content, message] of cases) {
      const error = failure(await tools.brain_write!({ path: 'Inbox/f.md', content }));
      assert.equal(error.category, 'rejected', name);
      assert.match(error.message, message, name);
    }
    assert.ok(!fs.existsSync(path.join(dir, 'Inbox/f.md')));
    data(await tools.brain_write!({ path: 'Inbox/f.md', content: note('type: lesson\nsources: [a, b]') }));
  });

  it('handles base_hash', async () => {
    const dir = vault();
    const { tools, lines } = setup(dir);
    const original = note('type: lesson\nstatus: candidate');
    fs.writeFileSync(path.join(dir, 'Inbox/h.md'), original);
    const error = failure(await tools.brain_write!({ path: 'Inbox/h.md', content: note('type: lesson'), base_hash: 'deadbeef' }));
    assert.equal(error.category, 'rejected');
    assert.equal(error.details.content, original);
    assert.equal(error.details.hash, sha(original));
    assert.equal(read(dir, 'Inbox/h.md'), original);

    data(await tools.brain_write!({ path: 'Inbox/h.md', content: note('type: lesson') }));
    assert.ok(lines.some((line) => line.includes('brain write without base_hash')));

    assert.equal(failure(await tools.brain_write!({ path: 'Inbox/none.md', content: note('type: lesson'), base_hash: 'abc' })).category, 'rejected');
  });

  it('blocks forbidden paths', async () => {
    const dir = vault();
    const outside = tempDir();
    fs.symlinkSync(outside, path.join(dir, 'Inbox/out'));
    const { tools } = setup(dir);
    for (const bad of ['.obsidian/x.md', '.OBSIDIAN/x.md', 'README.md', 'readme.md', '.git/x.md', 'Inbox/x.txt', '../x.md', 'Inbox/out/neu.md']) {
      assert.equal(failure(await tools.brain_write!({ path: bad, content: note('type: lesson') })).category, 'rejected', bad);
    }
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.ok(!fs.existsSync(path.join(dir, '.obsidian/x.md')));
    data(await tools.brain_write!({ path: 'Inbox/README.md', content: note('type: index') }));
  });

  it('returns the hash brain_read reports, and calls onWrite once per success', async () => {
    const dir = vault();
    const entries: BrainWriteEntry[] = [];
    const { tools } = setup(dir, { onWrite: (entry) => void entries.push(entry) });
    const first = data(await tools.brain_write!({ path: 'Inbox/o.md', content: note('type: lesson'), purpose: 'why' }));
    assert.equal(first.hash, sha(read(dir, 'Inbox/o.md')));
    assert.equal(data(await tools.brain_read!({ path: 'Inbox/o.md' })).hash, first.hash);
    failure(await tools.brain_write!({ path: 'README.md', content: note('type: lesson') }));
    const second = data(await tools.brain_append!({ path: 'Inbox/o.md', heading: 'H', text: 't', base_hash: first.hash }));
    assert.equal(second.created, false);
    assert.equal(entries.length, 2);
    assert.deepEqual(
      { tool: entries[0]!.tool, path: entries[0]!.path, hash: first.hash, previousHash: null, created: true, role: 'developer', run: 'run1', purpose: 'why' },
      { tool: 'brain_write', path: 'Inbox/o.md', hash: entries[0]!.hash, previousHash: null, created: true, role: entries[0]!.role, run: entries[0]!.run, purpose: 'why' },
    );
    assert.equal(entries[1]!.previousHash, first.hash);
    assert.equal(entries[1]!.hash, second.hash);
  });

  it('survives a throwing hook', async () => {
    const dir = vault();
    const { tools, lines } = setup(dir, {
      onWrite: () => {
        throw new Error('boom');
      },
    });
    data(await tools.brain_write!({ path: 'Inbox/t.md', content: note('type: lesson') }));
    assert.ok(lines.some((line) => line.includes('brain onWrite hook failed')));
  });
});

describe('brain_append', () => {
  it('creates the heading, appends inside the section and keeps created', async () => {
    const dir = vault();
    const { tools } = setup(dir);
    const start = data(await tools.brain_write!({ path: 'Inbox/a.md', content: note('type: lesson', '# Title\n\n## Other\n\nx') }));
    const one = data(await tools.brain_append!({ path: 'Inbox/a.md', heading: 'Lessons', text: 'eins', base_hash: start.hash }));
    assert.match(read(dir, 'Inbox/a.md'), /## Other\n\nx\n\n## Lessons\n\neins\n$/);
    const two = data(await tools.brain_append!({ path: 'Inbox/a.md', heading: 'Lessons', text: 'zwei', base_hash: one.hash }));
    assert.match(read(dir, 'Inbox/a.md'), /## Lessons\n\neins\n\nzwei\n$/);
    assert.equal(two.frontmatter.created, '2026-10-30');
    assert.equal(two.frontmatter.updated, '2026-10-30');
    data(await tools.brain_append!({ path: 'Inbox/a.md', heading: 'Other', text: 'y', base_hash: two.hash }));
    assert.match(read(dir, 'Inbox/a.md'), /## Other\n\nx\n\ny\n\n## Lessons/);
  });

  it('needs base_hash and an existing note, and rejects a stale hash', async () => {
    const dir = vault();
    const { tools } = setup(dir);
    assert.equal(failure(await tools.brain_append!({ path: 'Inbox/a.md', heading: 'H', text: 't' })).category, 'invalid_argument');
    assert.equal(failure(await tools.brain_append!({ path: 'Inbox/missing.md', heading: 'H', text: 't', base_hash: 'x' })).category, 'not_found');
    const text = note('type: lesson');
    fs.writeFileSync(path.join(dir, 'Inbox/a.md'), text);
    const error = failure(await tools.brain_append!({ path: 'Inbox/a.md', heading: 'H', text: 't', base_hash: 'old' }));
    assert.equal(error.category, 'rejected');
    assert.equal(error.details.hash, sha(text));
    assert.equal(failure(await tools.brain_append!({ path: '.obsidian/x.md', heading: 'H', text: 't', base_hash: 'x' })).category, 'rejected');
  });

  it('rejects appending to an approved note', async () => {
    const dir = vault();
    const { tools } = setup(dir);
    const approved = note('type: lesson\nstatus: approved');
    fs.writeFileSync(path.join(dir, 'Inbox/p.md'), approved);
    assert.equal(failure(await tools.brain_append!({ path: 'Inbox/p.md', heading: 'H', text: 't', base_hash: sha(approved) })).category, 'rejected');
    assert.equal(read(dir, 'Inbox/p.md'), approved);
  });
});

describe('note helpers', () => {
  it('prepareFrontmatter and appendUnderHeading are pure', () => {
    const stamp = { date: '2026-10-30', issue: 'o/r#1' };
    assert.equal(prepareFrontmatter({ type: 'lesson' }, null, stamp).ok, true);
    assert.equal(prepareFrontmatter({ type: 'lesson', repo: 5 }, null, stamp).ok, false);
    assert.equal(prepareFrontmatter({ type: 'lesson', status: 'weird' }, null, stamp).ok, false);
    assert.equal(appendUnderHeading('', 'A', 'x'), '## A\n\nx\n');
    assert.equal(appendUnderHeading('### Sub\n\nx\n', '### Sub', 'y'), '### Sub\n\nx\n\ny\n');
  });
});

describe('dangling symlink folder', () => {
  it('rejects without leaking the host path', async () => {
    const dir = vault();
    fs.symlinkSync(path.join(os.tmpdir(), 'brain-nowhere-xyz'), path.join(dir, 'Inbox/dangling'));
    const { tools } = setup(dir);
    const error = failure(await tools.brain_write!({ path: 'Inbox/dangling/x.md', content: note('type: lesson') }));
    assert.equal(error.category, 'rejected');
    assert.ok(!String(error.message).includes(dir));
  });
});

describe('access log and clash window', () => {
  function clashSetup() {
    const dir = vault();
    const clock = { now: new Date(NOW) };
    const access = new BrainAccessLog(path.join(tempDir(), 'brain'), Logger.silent());
    const specs = createBrainWriteTools(dir, Logger.silent(), { now: () => clock.now, access, clashWindowMs: 600_000 });
    const as = (runId: string) => (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
      specs.find((s) => s.name === name)!.execute({ purpose: 'test', ...args }, { issue: makeIssue({ id: 'a' }), role: 'developer', runId });
    return { dir, clock, access, run1: as('run1'), run2: as('run2') };
  }
  const first = note('type: note');

  it('rejects another run within the window with the current version and one clash', async () => {
    const { dir, clock, access, run1, run2 } = clashSetup();
    const created = data(await run1('brain_write', { path: 'Inbox/a.md', content: first }));
    const before = read(dir, 'Inbox/a.md');
    clock.now = new Date(NOW.getTime() + 5 * 60_000);
    const rejected = failure(await run2('brain_write', { path: 'Inbox/a.md', content: note('type: note', 'Other.'), base_hash: created.hash }));
    assert.equal(rejected.details.reason, 'window');
    assert.equal(rejected.details.content, before);
    assert.equal(rejected.details.hash, sha(before));
    assert.equal(read(dir, 'Inbox/a.md'), before);
    const appended = failure(await run2('brain_append', { path: 'Inbox/a.md', heading: 'H', text: 'x', base_hash: created.hash }));
    assert.equal(appended.details.reason, 'window');
    const clashes = access.clashes();
    assert.equal(clashes.length, 2);
    assert.deepEqual([clashes[0]!.path, clashes[0]!.runs, clashes[0]!.reason, clashes[0]!.status], ['Inbox/a.md', ['run1', 'run2'], 'window', 'open']);
    const logged = fs.readFileSync(access.file!, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(logged.filter((l) => l.result === 'rejected' && l.reason === 'window').length, 2);
    assert.equal(logged.length, 3);
  });

  it('lets the same run write again at once', async () => {
    const { run1 } = clashSetup();
    const created = data(await run1('brain_write', { path: 'Inbox/a.md', content: first }));
    data(await run1('brain_write', { path: 'Inbox/a.md', content: note('type: note', 'Again.'), base_hash: created.hash }));
  });

  it('lets another run write after the window', async () => {
    const { clock, access, run1, run2 } = clashSetup();
    const created = data(await run1('brain_write', { path: 'Inbox/a.md', content: first }));
    clock.now = new Date(NOW.getTime() + 600_001);
    data(await run2('brain_write', { path: 'Inbox/a.md', content: note('type: note', 'Later.'), base_hash: created.hash }));
    assert.equal(access.clashes().length, 0);
  });

  it('rejects a stale base_hash after the window with hash_mismatch and a clash', async () => {
    const { clock, access, run1, run2 } = clashSetup();
    const created = data(await run1('brain_write', { path: 'Inbox/a.md', content: first }));
    clock.now = new Date(NOW.getTime() + 11 * 60_000);
    const rejected = failure(await run2('brain_write', { path: 'Inbox/a.md', content: note('type: note', 'X.'), base_hash: sha('stale') }));
    assert.equal(rejected.details.reason, 'hash_mismatch');
    const [clash] = access.clashes();
    assert.deepEqual([clash!.runs, clash!.reason], [['run1', 'run2'], 'hash_mismatch']);
    const last = fs.readFileSync(access.file!, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).at(-1);
    assert.equal(last.result, 'rejected');
    assert.equal(last.reason, 'hash_mismatch');
    assert.equal(last.hash_before, created.hash);
  });
});
