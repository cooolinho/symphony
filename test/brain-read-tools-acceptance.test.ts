import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { resolveVaultPath } from '../src/brain/paths.ts';
import { createBrainTools } from '../src/brain/tools.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import type { AgentToolSpec, ToolResult } from '../src/tracker/types.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, baseFront, makeIssue, makeWorkflow, tempDir, until } from './helpers.ts';

// Acceptance tests of #340 (brain_search, brain_read, brain_list), derived from the issue text.

const root = path.resolve(import.meta.dirname, '..');

function put(dir: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

function newVault(): string {
  const dir = tempDir('symphony-vault-');
  put(dir, '.obsidian/app.json', '{"secret":true}');
  put(dir, '.obsidian/notes.md', '---\nstatus: approved\n---\nobsidianonlyword');
  return dir;
}

function memoryLogger(lines: string[]): Logger {
  return Logger.create({ sinks: [{ name: 'memory', write: (line: string) => lines.push(line) }], level: 'debug' } as never);
}

type Call = (args: Record<string, unknown>) => Promise<ToolResult>;

function tools(dir: string, lines: string[] = []): Record<'brain_search' | 'brain_read' | 'brain_list', Call> & { specs: AgentToolSpec[] } {
  const specs = createBrainTools(dir, memoryLogger(lines));
  const call = (name: string): Call => {
    const spec = specs.find((s) => s.name === name);
    assert.ok(spec, `tool ${name} exists`);
    return (args) => spec.execute({ purpose: 'acceptance', ...args }, { issue: makeIssue({ id: 'a' }) });
  };
  return { brain_search: call('brain_search'), brain_read: call('brain_read'), brain_list: call('brain_list'), specs };
}

function data(result: ToolResult): any {
  assert.ok(result.ok, JSON.stringify(result));
  return result.data;
}

function rejected(result: ToolResult, label: string): void {
  assert.ok(!result.ok, `${label} should be rejected`);
  if (!result.ok) {
    assert.equal(result.error.category, 'rejected', label);
    assert.ok(result.error.message.length > 0, label);
  }
}

const front = (fields: Record<string, string>, body = ''): string =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n`;

describe('tool specifications', () => {
  it('offers exactly brain_search, brain_read and brain_list in the tracker tool pattern', () => {
    const { specs } = tools(newVault());
    assert.deepEqual(specs.map((s) => s.name).sort(), ['brain_list', 'brain_read', 'brain_search']);
    for (const spec of specs) {
      assert.ok(spec.description.length > 20, spec.name);
      assert.equal(spec.mutates, false, spec.name);
      assert.equal(typeof spec.execute, 'function');
      assert.ok('purpose' in spec.inputSchema, `${spec.name} has purpose`);
      assert.ok(z.object(spec.inputSchema).safeParse({ ...requiredArgs(spec.name) }).success, `${spec.name}: purpose is optional`);
    }
  });

  it('declares the documented arguments', () => {
    const { specs } = tools(newVault());
    const keys = (name: string) => Object.keys(specs.find((s) => s.name === name)!.inputSchema);
    assert.ok(['query', 'repo', 'type'].every((k) => keys('brain_search').includes(k)));
    assert.ok(keys('brain_read').includes('path'));
    assert.ok(keys('brain_list').includes('folder'));
  });
});

function requiredArgs(name: string): Record<string, unknown> {
  return name === 'brain_search' ? { query: 'x' } : name === 'brain_read' ? { path: 'a.md' } : { folder: '' };
}

describe('path check (src/brain/paths.ts)', () => {
  it('rejects ../x, /etc/passwd and .obsidian/app.json in every tool', async () => {
    const t = tools(newVault());
    for (const bad of ['../x', '/etc/passwd', '.obsidian/app.json']) {
      rejected(await t.brain_read({ path: bad }), `read ${bad}`);
      rejected(await t.brain_list({ folder: bad }), `list ${bad}`);
    }
  });

  it('rejects variants: nested .., ./ prefix, other case, nested .obsidian, trailing dots, NUL, backslash, home', () => {
    const dir = newVault();
    put(dir, 'sub/.obsidian/x.md', 'x');
    const bad = [
      'a/../../etc/passwd',
      '..',
      '../',
      './../x',
      '/',
      '//etc/passwd',
      './.obsidian/app.json',
      '.Obsidian/app.json',
      '.OBSIDIAN',
      'sub/.obsidian/x.md',
      'sub/../.obsidian/app.json',
      'a\0b.md',
      '..\\x',
      'C:\\Windows\\win.ini',
      '~/secret',
      path.join(dir, 'a.md'),
    ];
    for (const input of bad) assert.equal(resolveVaultPath(dir, input).ok, false, JSON.stringify(input));
  });

  it('rejects non-string input', () => {
    const dir = newVault();
    for (const input of [undefined, null, 5, {}, ['a.md']]) assert.equal(resolveVaultPath(dir, input as never).ok, false);
  });

  it('accepts normal relative paths and normalizes ./ and double slashes', () => {
    const dir = newVault();
    const result = resolveVaultPath(dir, './Lessons//a.md');
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.relative, 'Lessons/a.md');
      assert.equal(result.absolute, path.join(dir, 'Lessons', 'a.md'));
    }
    assert.ok(resolveVaultPath(dir, 'Notes/.hidden-ish/..not-parent.md').ok, 'a name merely containing dots is fine');
    assert.ok(resolveVaultPath(dir, 'my.obsidian/x.md').ok, '.obsidian only as a whole segment');
  });

  it('rejects a symlinked file and a symlinked folder that lead out of the vault', async () => {
    const dir = newVault();
    const outside = tempDir('symphony-outside-');
    fs.writeFileSync(path.join(outside, 'secret.md'), '---\nstatus: approved\n---\noutsidesecret');
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(dir, 'link.md'));
    fs.symlinkSync(outside, path.join(dir, 'linkdir'));
    const t = tools(dir);
    rejected(await t.brain_read({ path: 'link.md' }), 'file symlink');
    rejected(await t.brain_read({ path: 'linkdir/secret.md' }), 'dir symlink');
    rejected(await t.brain_list({ folder: 'linkdir' }), 'list dir symlink');
    // search must not leak the outside content either
    const found = data(await t.brain_search({ query: 'outsidesecret' }));
    assert.equal(found.results.length, 0);
  });

  it('rejects a symlink inside the vault that points into .obsidian', async () => {
    const dir = newVault();
    fs.symlinkSync(path.join(dir, '.obsidian'), path.join(dir, 'obs'));
    rejected(await tools(dir).brain_read({ path: 'obs/app.json' }), 'obs symlink');
  });
});

describe('brain_read', () => {
  it('returns content, parsed frontmatter and the SHA-256 of the file content', async () => {
    const dir = newVault();
    const text = front({ type: 'lesson', status: 'approved', repo: 'acme/app' }, '# Title\nbody ümläut €');
    put(dir, 'Lessons/a.md', text);
    const r = data(await tools(dir).brain_read({ path: 'Lessons/a.md' }));
    assert.equal(r.content, text);
    assert.equal(r.frontmatter.type, 'lesson');
    assert.equal(r.frontmatter.status, 'approved');
    assert.equal(r.frontmatter.repo, 'acme/app');
    assert.match(r.hash, /^[0-9a-f]{64}$/);
    assert.equal(r.hash, createHash('sha256').update(fs.readFileSync(path.join(dir, 'Lessons/a.md'))).digest('hex'));
  });

  it('the hash changes when the file changes and is stable otherwise', async () => {
    const dir = newVault();
    put(dir, 'a.md', 'one');
    const t = tools(dir);
    const h1 = data(await t.brain_read({ path: 'a.md' })).hash;
    assert.equal(data(await t.brain_read({ path: 'a.md' })).hash, h1);
    put(dir, 'a.md', 'two');
    assert.notEqual(data(await t.brain_read({ path: 'a.md' })).hash, h1);
  });

  it('gives empty frontmatter without a block, and does not crash on invalid YAML', async () => {
    const dir = newVault();
    put(dir, 'plain.md', '# Just text\n--- not frontmatter');
    put(dir, 'broken.md', '---\nkey: [unclosed\n  : :\n---\nbody');
    put(dir, 'scalar.md', '---\njust a string\n---\nbody');
    put(dir, 'empty.md', '');
    const t = tools(dir);
    assert.deepEqual(data(await t.brain_read({ path: 'plain.md' })).frontmatter, {});
    const broken = data(await t.brain_read({ path: 'broken.md' }));
    assert.deepEqual(broken.frontmatter, {});
    assert.equal(broken.content, '---\nkey: [unclosed\n  : :\n---\nbody');
    assert.deepEqual(data(await t.brain_read({ path: 'scalar.md' })).frontmatter, {});
    const empty = data(await t.brain_read({ path: 'empty.md' }));
    assert.equal(empty.content, '');
    assert.equal(empty.hash, createHash('sha256').update('').digest('hex'));
  });

  it('handles CRLF frontmatter', async () => {
    const dir = newVault();
    put(dir, 'crlf.md', '---\r\nstatus: candidate\r\ntype: lesson\r\n---\r\nbody\r\n');
    const r = data(await tools(dir).brain_read({ path: 'crlf.md' }));
    assert.equal(r.frontmatter.status, 'candidate');
    assert.equal(r.content, '---\r\nstatus: candidate\r\ntype: lesson\r\n---\r\nbody\r\n', 'content is returned unchanged');
  });

  it('reports a missing file and a folder as errors, not as a crash', async () => {
    const dir = newVault();
    put(dir, 'Lessons/a.md', 'x');
    const t = tools(dir);
    const missing = await t.brain_read({ path: 'Lessons/none.md' });
    assert.ok(!missing.ok);
    const folder = await t.brain_read({ path: 'Lessons' });
    assert.ok(!folder.ok);
  });

  it('also delivers candidate notes when read directly (open question 10)', async () => {
    const dir = newVault();
    put(dir, 'Inbox/c.md', front({ status: 'candidate' }, 'maybe'));
    assert.equal(data(await tools(dir).brain_read({ path: 'Inbox/c.md' })).frontmatter.status, 'candidate');
  });
});

describe('brain_list', () => {
  it('lists files and subfolders with type and status from the frontmatter', async () => {
    const dir = newVault();
    put(dir, 'Lessons/a.md', front({ type: 'lesson', status: 'approved' }));
    put(dir, 'Lessons/b.md', front({ type: 'decision', status: 'candidate' }));
    put(dir, 'Lessons/sub/c.md', 'x');
    put(dir, 'Lessons/plain.md', 'no frontmatter');
    put(dir, 'Lessons/data.txt', 'not markdown');
    const entries = data(await tools(dir).brain_list({ folder: 'Lessons' })).entries as Array<Record<string, unknown>>;
    const by = (name: string) => entries.find((e) => e.name === name)!;
    assert.deepEqual(entries.map((e) => e.name).sort(), ['a.md', 'b.md', 'data.txt', 'plain.md', 'sub']);
    assert.equal(by('a.md').type, 'lesson');
    assert.equal(by('a.md').status, 'approved');
    assert.equal(by('b.md').type, 'decision');
    assert.equal(by('b.md').status, 'candidate');
    assert.ok(by('plain.md').type == null && by('plain.md').status == null);
    assert.ok(by('sub').type == null && by('sub').status == null);
    assert.equal(by('sub').path, 'Lessons/sub');
    assert.equal(by('a.md').path, 'Lessons/a.md');
  });

  it('lists the vault root for an empty or missing folder and hides .obsidian', async () => {
    const dir = newVault();
    put(dir, 'Inbox/x.md', 'x');
    put(dir, 'top.md', front({ status: 'approved' }));
    const t = tools(dir);
    for (const args of [{}, { folder: '' }, { folder: '.' }]) {
      const names = (data(await t.brain_list(args)).entries as Array<{ name: string }>).map((e) => e.name).sort();
      assert.deepEqual(names, ['Inbox', 'top.md'], JSON.stringify(args));
    }
  });

  it('fails for a missing folder and for a file given as folder', async () => {
    const dir = newVault();
    put(dir, 'a.md', 'x');
    const t = tools(dir);
    assert.ok(!(await t.brain_list({ folder: 'nope' })).ok);
    assert.ok(!(await t.brain_list({ folder: 'a.md' })).ok);
  });

  it('still lists deprecated notes (only search hides them) with their status', async () => {
    const dir = newVault();
    put(dir, 'Old/d.md', front({ status: 'deprecated', type: 'lesson' }));
    const entries = data(await tools(dir).brain_list({ folder: 'Old' })).entries as Array<{ status: string }>;
    assert.equal(entries[0]?.status, 'deprecated');
  });
});

describe('brain_search', () => {
  function sortingVault(): string {
    const dir = newVault();
    put(dir, 'Inbox/candidate.md', front({ type: 'lesson', status: 'candidate', title: 'Cache candidate' }, 'zebra caching'));
    put(dir, 'Lessons/approved.md', front({ type: 'lesson', status: 'approved', title: 'Cache approved' }, 'zebra caching'));
    put(dir, 'Lessons/deprecated.md', front({ type: 'lesson', status: 'deprecated', title: 'Cache deprecated' }, 'zebra caching'));
    return dir;
  }

  it('returns approved before candidate and never deprecated', async () => {
    const found = data(await tools(sortingVault()).brain_search({ query: 'zebra' }));
    assert.deepEqual(found.results.map((r: { path: string }) => r.path), ['Lessons/approved.md', 'Inbox/candidate.md']);
    assert.deepEqual(found.results.map((r: { status: string }) => r.status), ['approved', 'candidate']);
  });

  it('puts approved first even when the candidate matches the query better', async () => {
    const dir = newVault();
    put(dir, 'a-candidate.md', front({ status: 'candidate', title: 'Redis redis redis' }, 'redis redis redis'));
    put(dir, 'z-approved.md', front({ status: 'approved', title: 'Other' }, 'mentions redis once'));
    const paths = data(await tools(dir).brain_search({ query: 'redis' })).results.map((r: { path: string }) => r.path);
    assert.deepEqual(paths, ['z-approved.md', 'a-candidate.md']);
  });

  it('never returns deprecated, however it matches or is cased', async () => {
    const dir = newVault();
    put(dir, 'd1.md', front({ status: 'deprecated' }, 'needle'));
    put(dir, 'd2.md', front({ status: 'Deprecated' }, 'needle'));
    put(dir, 'd3.md', front({ status: 'deprecated', title: 'needle' }, 'needle'));
    assert.equal(data(await tools(dir).brain_search({ query: 'needle' })).results.length, 0);
  });

  it('gives each hit path, title, status and an excerpt', async () => {
    const dir = newVault();
    put(dir, 'Lessons/a.md', front({ status: 'approved', title: 'Queue tuning' }, 'Before text. The retry budget matters a lot. After text.'));
    const hit = data(await tools(dir).brain_search({ query: 'retry' })).results[0];
    assert.equal(hit.path, 'Lessons/a.md');
    assert.equal(hit.title, 'Queue tuning');
    assert.equal(hit.status, 'approved');
    assert.equal(typeof hit.excerpt, 'string');
    assert.ok(hit.excerpt.includes('retry budget'));
  });

  it('searches title, frontmatter and full text, case-insensitively', async () => {
    const dir = newVault();
    put(dir, 'title.md', front({ status: 'approved', title: 'Quokka handling' }, 'nothing'));
    put(dir, 'front.md', front({ status: 'approved', tags: '[wombat]' }, 'nothing'));
    put(dir, 'body.md', front({ status: 'approved' }, 'The numbat is in the text'));
    put(dir, 'heading.md', '# Echidna heading\n\nfoo');
    const t = tools(dir);
    const paths = async (query: string) => (data(await t.brain_search({ query })).results as Array<{ path: string }>).map((r) => r.path);
    assert.deepEqual(await paths('QUOKKA'), ['title.md']);
    assert.deepEqual(await paths('wombat'), ['front.md']);
    assert.deepEqual(await paths('NUMBAT'), ['body.md']);
    assert.deepEqual(await paths('echidna'), ['heading.md']);
  });

  it('searches all .md files in nested folders but ignores other file types and .obsidian', async () => {
    const dir = newVault();
    put(dir, 'a/b/c/deep.md', front({ status: 'approved' }, 'findme'));
    put(dir, 'notes.txt', 'findme');
    put(dir, 'x.json', '{"findme":1}');
    const paths = data(await tools(dir).brain_search({ query: 'findme' })).results.map((r: { path: string }) => r.path);
    assert.deepEqual(paths, ['a/b/c/deep.md']);
    assert.equal(data(await tools(dir).brain_search({ query: 'obsidianonlyword' })).results.length, 0);
  });

  it('returns at most 20 hits', async () => {
    const dir = newVault();
    for (let i = 0; i < 30; i++) put(dir, `n/${i}.md`, front({ status: i % 2 ? 'approved' : 'candidate' }, 'common'));
    const found = data(await tools(dir).brain_search({ query: 'common' }));
    assert.equal(found.results.length, 20);
    const statuses = found.results.map((r: { status: string }) => r.status);
    assert.deepEqual(statuses, [...statuses].sort(), 'approved hits fill the limit before candidates');
    assert.equal(statuses.filter((s: string) => s === 'approved').length, 15);
  });

  it('filters by repo and by type', async () => {
    const dir = newVault();
    put(dir, 'a.md', front({ status: 'approved', repo: 'acme/app', type: 'lesson' }, 'topic'));
    put(dir, 'b.md', front({ status: 'approved', repo: 'acme/other', type: 'decision' }, 'topic'));
    put(dir, 'c.md', front({ status: 'approved', type: 'lesson' }, 'topic'));
    const t = tools(dir);
    const paths = async (args: Record<string, unknown>) =>
      (data(await t.brain_search({ query: 'topic', ...args })).results as Array<{ path: string }>).map((r) => r.path).sort();
    assert.deepEqual(await paths({}), ['a.md', 'b.md', 'c.md']);
    assert.deepEqual(await paths({ repo: 'acme/app' }), ['a.md']);
    assert.deepEqual(await paths({ type: 'decision' }), ['b.md']);
    assert.deepEqual(await paths({ type: 'lesson' }), ['a.md', 'c.md']);
    assert.deepEqual(await paths({ repo: 'acme/app', type: 'decision' }), []);
  });

  it('finds nothing for an unknown word, and survives broken notes in the vault', async () => {
    const dir = newVault();
    put(dir, 'broken.md', '---\nfoo: [unclosed\n---\nstillfindable');
    put(dir, 'ok.md', front({ status: 'approved' }, 'fine'));
    const t = tools(dir);
    assert.equal(data(await t.brain_search({ query: 'absentword' })).results.length, 0);
    assert.deepEqual(data(await t.brain_search({ query: 'stillfindable' })).results.map((r: { path: string }) => r.path), ['broken.md']);
  });

  it('finds nothing in an empty vault', async () => {
    const dir = tempDir('symphony-vault-');
    assert.deepEqual(data(await tools(dir).brain_search({ query: 'anything' })).results, []);
  });

  it('refuses a blank query without crashing', async () => {
    const result = await tools(newVault()).brain_search({ query: '   ' });
    assert.ok(!result.ok || (result.data as { results: unknown[] }).results.length === 0);
  });
});

describe('purpose', () => {
  it('warns on a missing purpose in every tool but still answers', async () => {
    const dir = newVault();
    put(dir, 'a.md', front({ status: 'approved' }, 'hello'));
    for (const [name, args] of [
      ['brain_search', { query: 'hello' }],
      ['brain_read', { path: 'a.md' }],
      ['brain_list', { folder: '' }],
    ] as const) {
      const lines: string[] = [];
      const spec = createBrainTools(dir, memoryLogger(lines)).find((s) => s.name === name)!;
      const result = await spec.execute({ ...args }, { issue: makeIssue({ id: 'a' }) });
      assert.ok(result.ok, name);
      assert.ok(lines.some((l) => /warn/i.test(l) && /purpose/.test(l)), `${name}: warning logged`);
    }
  });

  it('logs no warning when a purpose is given, and warns once per call', async () => {
    const dir = newVault();
    put(dir, 'a.md', 'x');
    const lines: string[] = [];
    const spec = createBrainTools(dir, memoryLogger(lines)).find((s) => s.name === 'brain_read')!;
    const context = { issue: makeIssue({ id: 'a' }) };
    await spec.execute({ path: 'a.md', purpose: 'plan the change' }, context);
    assert.equal(lines.filter((l) => /purpose/.test(l)).length, 0);
    await spec.execute({ path: 'a.md' }, context);
    assert.equal(lines.filter((l) => /purpose/.test(l)).length, 1);
  });

  it('a rejected path with missing purpose still returns rejected (no abort)', async () => {
    const lines: string[] = [];
    const spec = createBrainTools(newVault(), memoryLogger(lines)).find((s) => s.name === 'brain_read')!;
    rejected(await spec.execute({ path: '../x' }, { issue: makeIssue({ id: 'a' }) }), 'no purpose');
  });
});

describe('synchronous file system access, no index', () => {
  it('src/brain/tools.ts and paths.ts use no async fs, no fs/promises and write nothing', () => {
    for (const file of ['src/brain/tools.ts', 'src/brain/paths.ts', 'src/brain/note.ts']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      assert.ok(!/fs\/promises/.test(source), `${file}: no fs/promises`);
      assert.ok(!/\bfs\.promises\b/.test(source), `${file}: no fs.promises`);
      assert.ok(!/\b(writeFile|appendFile|mkdir|rm|unlink|rename|copyFile|symlink)(Sync)?\s*\(/.test(source), `${file}: read-only`);
    }
  });

  it('sees a note written after the tools were created (no index/cache)', async () => {
    const dir = newVault();
    const t = tools(dir);
    assert.equal(data(await t.brain_search({ query: 'latecomer' })).results.length, 0);
    put(dir, 'late.md', front({ status: 'approved' }, 'latecomer'));
    assert.equal(data(await t.brain_search({ query: 'latecomer' })).results.length, 1);
    assert.ok(!fs.readdirSync(dir).some((n) => /index|cache|\.db|\.sqlite/i.test(n)), 'no index file created in the vault');
  });

  it('does not modify the vault', async () => {
    const dir = newVault();
    put(dir, 'a.md', front({ status: 'approved' }, 'x'));
    const snapshot = () => fs.readdirSync(dir, { recursive: true }).map(String).sort().map((f) => `${f}:${fs.statSync(path.join(dir, f)).mtimeMs}`);
    const before = snapshot();
    const t = tools(dir);
    await t.brain_search({ query: 'x' });
    await t.brain_read({ path: 'a.md' });
    await t.brain_list({ folder: '' });
    assert.deepEqual(snapshot(), before);
  });
});

describe('worker wiring: brain tools only with brain.enabled', () => {
  async function sessionFor(brain: Record<string, unknown> | undefined) {
    const dir = newVault();
    put(dir, 'Lessons/a.md', front({ status: 'approved' }, 'wired'));
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
    return runner.sessions[0]!.params;
  }

  it('hands the session the read and write tools when brain.enabled is true', async () => {
    const params = await sessionFor({ enabled: true });
    const names = (params.brainTools ?? []).map((t) => t.name).sort();
    assert.deepEqual(names, ['brain_append', 'brain_list', 'brain_read', 'brain_search', 'brain_write']);
    assert.ok(!params.tools.some((t) => t.name.startsWith('brain_')), 'brain tools are not mixed into the tracker tools');
    const search = params.brainTools!.find((t) => t.name === 'brain_search')!;
    const result = await search.execute({ query: 'wired', purpose: 'test' }, params.toolContext());
    assert.equal((data(result).results as unknown[]).length, 1);
  });

  it('hands the session no brain tools when brain.enabled is false or the section is missing', async () => {
    assert.deepEqual((await sessionFor({ enabled: false })).brainTools ?? [], []);
    assert.deepEqual((await sessionFor(undefined)).brainTools ?? [], []);
  });
});
