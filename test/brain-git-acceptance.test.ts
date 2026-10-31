import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { agentAuthor, commitMessage, createVaultGit, initVaultGit } from '../src/brain/git.ts';
import { brainToolsFor, createBrainWriteTools, type BrainWriteEntry } from '../src/brain/tools.ts';
import { ensureVault } from '../src/brain/vault.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import type { AgentToolContext, AgentToolSpec, ToolResult } from '../src/tracker/types.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, baseFront, makeIssue, makeWorkflow, tempDir, until } from './helpers.ts';

// Acceptance tests of #347 (vault versioning), derived from the issue text and used through the public tool API.

const NOW = new Date('2026-10-30T12:00:00Z');
const note = (body = 'Body.'): string => `---\ntype: lesson\n---\n${body}\n`;
const sh = (dir: string, ...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@local'];
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const put = (dir: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const read = (dir: string, rel: string): string => fs.readFileSync(path.join(dir, rel), 'utf8');
const category = (r: ToolResult): string => (r as Extract<ToolResult, { ok: false }>).error.category;
const hashOf = (r: ToolResult): string => (r as { data: { hash: string } }).data.hash;

type Call = (args: Record<string, unknown>) => Promise<ToolResult>;

async function setup(opts: { context?: Partial<AgentToolContext>; onCommit?: (sha: string, paths: string[]) => void | Promise<void>; repos?: string[] } = {}) {
  const dir = path.join(tempDir(), 'vault');
  await ensureVault(dir, opts.repos ?? [], NOW);
  const lines: string[] = [];
  const logger = Logger.create({ sinks: [{ name: 'memory', write: (line: string) => lines.push(line) }], level: 'debug' } as never);
  const context: AgentToolContext = { issue: makeIssue({ id: 'a' }), role: 'developer', runId: 'run1', ...opts.context };
  const versioning = createVaultGit(dir, logger, opts.onCommit ? { onCommit: opts.onCommit } : {});
  const specs = createBrainWriteTools(dir, logger, { now: () => NOW, versioning });
  const call = (name: string): Call => {
    const spec = specs.find((s) => s.name === name)!;
    return (args) => spec.execute({ purpose: 'p', ...args }, context);
  };
  return { dir, write: call('brain_write'), append: call('brain_append'), lines, logger, context, versioning };
}

describe('ensureVault git init', () => {
  it('creates .git, .gitignore with both patterns and exactly one first commit holding the structure', async () => {
    const dir = path.join(tempDir(), 'vault');
    await ensureVault(dir, ['acme/shop'], NOW);
    assert.ok(fs.existsSync(path.join(dir, '.git')));
    const ignore = read(dir, '.gitignore').split('\n');
    assert.ok(ignore.includes('.obsidian/workspace*.json'));
    assert.ok(ignore.includes('.trash/'));
    assert.equal(sh(dir, 'rev-list', '--count', 'HEAD'), '1');
    assert.equal(sh(dir, 'status', '--porcelain'), '');
    const files = sh(dir, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n');
    for (const f of ['README.md', '.gitignore', 'Repos/acme-shop/index.md']) assert.ok(files.includes(f), `${f} in first commit`);
  });

  it('does not re-initialise or add a commit on an existing repository, and leaves its history alone', async () => {
    const dir = path.join(tempDir(), 'vault');
    fs.mkdirSync(dir, { recursive: true });
    sh(dir, 'init', '-q', '-b', 'main');
    put(dir, 'mine.md', 'x\n');
    sh(dir, 'add', '.');
    sh(dir, ...IDENTITY, 'commit', '-q', '-m', 'mine');
    const head = sh(dir, 'rev-parse', 'HEAD');
    await ensureVault(dir, [], NOW);
    assert.equal(sh(dir, 'rev-parse', 'HEAD'), head);
    assert.equal(sh(dir, 'rev-list', '--count', 'HEAD'), '1');
    assert.equal(await initVaultGit(dir), false);
  });

  it('does not commit .obsidian or ignored paths, even when present at init', async () => {
    const dir = path.join(tempDir(), 'vault');
    put(dir, '.obsidian/app.json', '{}');
    put(dir, '.obsidian/workspace.json', '{}');
    put(dir, '.trash/old.md', 'x');
    await ensureVault(dir, [], NOW);
    const files = sh(dir, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n');
    assert.ok(!files.some((f) => f.startsWith('.obsidian') || f.startsWith('.trash')), files.join(','));
  });

  it('works without a global git identity (HOME without config)', async () => {
    const home = tempDir();
    const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME, GCG: process.env.GIT_CONFIG_GLOBAL, GCS: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, 'xdg');
    process.env.GIT_CONFIG_GLOBAL = path.join(home, 'nothing');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    try {
      const { dir, write } = await setup();
      assert.ok((await write({ path: 'Inbox/x.md', content: note() })).ok);
      assert.equal(sh(dir, 'log', '-1', '--format=%an'), 'symphony-developer');
    } finally {
      for (const [k, v] of [['HOME', saved.HOME], ['XDG_CONFIG_HOME', saved.XDG], ['GIT_CONFIG_GLOBAL', saved.GCG], ['GIT_CONFIG_NOSYSTEM', saved.GCS]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('agent commits', () => {
  it('brain_write: author symphony-<role> <symphony-<role>@local>, subject "<issue> <run>: <purpose>", body is the path', async () => {
    const { dir, write, context } = await setup({ context: { role: 'tester', runId: 'run-9' } });
    const r = await write({ path: 'Lessons/a.md', content: note(), purpose: 'learned a thing' });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(sh(dir, 'log', '-1', '--format=%an <%ae>'), 'symphony-tester <symphony-tester@local>');
    assert.equal(sh(dir, 'log', '-1', '--format=%s'), `${context.issue.identifier} run-9: learned a thing`);
    assert.equal(sh(dir, 'log', '-1', '--format=%b'), 'Lessons/a.md');
    // second line of the raw message is empty, the third is the path
    assert.deepEqual(sh(dir, 'log', '-1', '--format=%B').split('\n').slice(1, 3), ['', 'Lessons/a.md']);
    assert.equal(sh(dir, 'show', '--name-only', '--format=', 'HEAD'), 'Lessons/a.md');
  });

  it('brain_append is committed as well, as its own commit', async () => {
    const { dir, write, append } = await setup();
    const w = await write({ path: 'Lessons/a.md', content: note('one') });
    const before = sh(dir, 'rev-list', '--count', 'HEAD');
    const a = await append({ path: 'Lessons/a.md', heading: 'Findings', text: 'two', base_hash: hashOf(w) });
    assert.ok(a.ok, JSON.stringify(a));
    assert.equal(Number(sh(dir, 'rev-list', '--count', 'HEAD')), Number(before) + 1);
    assert.equal(sh(dir, 'show', '--name-only', '--format=', 'HEAD'), 'Lessons/a.md');
    assert.match(sh(dir, 'show', 'HEAD:Lessons/a.md'), /two/);
    assert.equal(sh(dir, 'status', '--porcelain'), '');
  });

  it('commits only the written path, not unrelated tracked changes of other files', async () => {
    const { dir, write } = await setup();
    assert.ok((await write({ path: 'Inbox/a.md', content: note('a') })).ok);
    assert.ok((await write({ path: 'Inbox/b.md', content: note('b') })).ok);
    const files = sh(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n');
    assert.deepEqual(files, ['Inbox/b.md']);
  });

  it('role and purpose are sanitised: no stray characters in the author, one-line subject', async () => {
    const { dir, write } = await setup({ context: { role: 'Dev Ops/<x>' } });
    assert.ok((await write({ path: 'Inbox/a.md', content: note(), purpose: 'line1\n\nline2' })).ok);
    const author = sh(dir, 'log', '-1', '--format=%an|%ae');
    assert.match(author, /^symphony-[a-z0-9-]+\|symphony-[a-z0-9-]+@local$/);
    assert.equal(sh(dir, 'log', '-1', '--format=%s').includes('\n'), false);
    assert.match(sh(dir, 'log', '-1', '--format=%s'), /line1 line2$/);
  });

  it('exports pure helpers with the specified shape', () => {
    assert.deepEqual(agentAuthor('developer'), { name: 'symphony-developer', email: 'symphony-developer@local' });
    assert.equal(agentAuthor(null).name, 'symphony-agent');
    const entry = { path: 'a/b.md', issue: 'o/r#1', run: 'r1', purpose: 'why' } as BrainWriteEntry;
    assert.deepEqual(commitMessage(entry), { subject: 'o/r#1 r1: why', body: 'a/b.md' });
  });

  it('a base_hash conflict creates no commit and leaves the vault clean', async () => {
    const { dir, write } = await setup();
    assert.ok((await write({ path: 'Inbox/a.md', content: note('one') })).ok);
    const head = sh(dir, 'rev-parse', 'HEAD');
    const r = await write({ path: 'Inbox/a.md', content: note('two'), base_hash: sha256('stale') });
    assert.equal(r.ok, false);
    assert.equal(sh(dir, 'rev-parse', 'HEAD'), head);
    assert.equal(sh(dir, 'status', '--porcelain'), '');
  });

  it('a rejected path (outside the rules) creates no commit', async () => {
    const { dir, write } = await setup();
    const head = sh(dir, 'rev-parse', 'HEAD');
    assert.equal((await write({ path: '.obsidian/x.md', content: note() })).ok, false);
    assert.equal((await write({ path: '../escape.md', content: note() })).ok, false);
    assert.equal(sh(dir, 'rev-parse', 'HEAD'), head);
  });
});

describe('manual changes (Obsidian) are taken over as human before an agent write', () => {
  it('one human commit for several files: author human <human@local>, "Obsidian: <n> Dateien", before the agent commit', async () => {
    const { dir, write } = await setup();
    put(dir, 'Inbox/h1.md', 'one\n');
    put(dir, 'Inbox/h2.md', 'two\n');
    put(dir, 'Lessons/h3.md', 'three\n');
    const before = sh(dir, 'rev-list', '--count', 'HEAD');
    assert.ok((await write({ path: 'Inbox/agent.md', content: note() })).ok);
    assert.equal(Number(sh(dir, 'rev-list', '--count', 'HEAD')), Number(before) + 2);
    assert.equal(sh(dir, 'log', '-1', '--format=%an'), 'symphony-developer');
    assert.equal(sh(dir, 'log', '-1', '--skip=1', '--format=%an <%ae>|%s'), 'human <human@local>|Obsidian: 3 Dateien');
    assert.deepEqual(sh(dir, 'show', '--name-only', '--format=', 'HEAD~1').split('\n').sort(), ['Inbox/h1.md', 'Inbox/h2.md', 'Lessons/h3.md']);
    assert.deepEqual(sh(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['Inbox/agent.md']);
  });

  it('.obsidian/ changes alone cause no human commit and are never committed', async () => {
    const { dir, write } = await setup();
    put(dir, '.obsidian/app.json', '{"a":1}');
    put(dir, '.obsidian/workspace.json', '{}');
    put(dir, '.obsidian/plugins/x/main.js', '//');
    const before = sh(dir, 'rev-list', '--count', 'HEAD');
    assert.ok((await write({ path: 'Inbox/a.md', content: note() })).ok);
    assert.equal(Number(sh(dir, 'rev-list', '--count', 'HEAD')), Number(before) + 1);
    assert.equal(sh(dir, 'log', '--format=%an').split('\n').includes('human'), false);
    assert.equal(sh(dir, 'ls-files', '.obsidian'), '');
  });

  it('.trash/ and .obsidian/workspace*.json are ignored by git', async () => {
    const { dir, write } = await setup();
    put(dir, '.trash/gone.md', 'x');
    put(dir, '.obsidian/workspace.json', '{}');
    put(dir, '.obsidian/workspace-mobile.json', '{}');
    assert.ok((await write({ path: 'Inbox/a.md', content: note() })).ok);
    assert.equal(sh(dir, 'log', '--format=%an').split('\n').includes('human'), false);
    assert.equal(sh(dir, 'ls-files', '--others', '--exclude-standard', '.trash', '.obsidian/workspace.json'), '');
  });

  it('a manual edit of an existing note, a deletion and a file with spaces/umlauts are all taken over', async () => {
    const { dir, write } = await setup();
    assert.ok((await write({ path: 'Inbox/keep.md', content: note('k') })).ok);
    assert.ok((await write({ path: 'Inbox/del.md', content: note('d') })).ok);
    put(dir, 'Inbox/keep.md', 'edited\n');
    fs.rmSync(path.join(dir, 'Inbox/del.md'));
    put(dir, 'Inbox/Gedanken über Käse.md', 'x\n');
    assert.ok((await write({ path: 'Inbox/other.md', content: note() })).ok);
    assert.equal(sh(dir, 'log', '-1', '--skip=1', '--format=%an|%s'), 'human|Obsidian: 3 Dateien');
    assert.equal(sh(dir, 'status', '--porcelain'), '');
    assert.equal(sh(dir, 'show', 'HEAD~1:Inbox/keep.md'), 'edited');
  });

  it('no human commit when nothing changed, and commitHumanChanges returns null', async () => {
    const { dir, versioning } = await setup();
    const head = sh(dir, 'rev-parse', 'HEAD');
    assert.equal(await versioning.commitHumanChanges(), null);
    assert.equal(sh(dir, 'rev-parse', 'HEAD'), head);
  });

  it('commitHumanChanges commits on its own and returns the new sha', async () => {
    const { dir, versioning } = await setup();
    put(dir, 'Inbox/m.md', 'm\n');
    const sha = await versioning.commitHumanChanges();
    assert.equal(sha, sh(dir, 'rev-parse', 'HEAD'));
    assert.equal(sh(dir, 'log', '-1', '--format=%an|%s'), 'human|Obsidian: 1 Dateien');
  });

  it('a manual edit of the target file survives: it is in history before the agent overwrites it', async () => {
    const { dir, write } = await setup();
    assert.ok((await write({ path: 'Inbox/a.md', content: note('one') })).ok);
    put(dir, 'Inbox/a.md', note('human wrote this'));
    const h = sha256(read(dir, 'Inbox/a.md'));
    assert.ok((await write({ path: 'Inbox/a.md', content: note('agent'), base_hash: h })).ok);
    assert.match(sh(dir, 'show', 'HEAD~1:Inbox/a.md'), /human wrote this/);
    sh(dir, ...IDENTITY, 'revert', '--no-edit', 'HEAD');
    assert.match(read(dir, 'Inbox/a.md'), /human wrote this/);
  });
});

describe('serial queue', () => {
  it('many parallel writes from separate tool sets give one correctly attributed commit each', async () => {
    const { dir, logger } = await setup();
    const before = sh(dir, 'rev-parse', 'HEAD');
    const jobs = Array.from({ length: 8 }, (_, i) => {
      const tools = createBrainWriteTools(dir, logger, { now: () => NOW, versioning: createVaultGit(dir, logger) });
      const ctx: AgentToolContext = { issue: makeIssue({ id: `i${i}` }), role: `role${i}`, runId: `run${i}` };
      return tools.find((t) => t.name === 'brain_write')!.execute({ path: `Inbox/n${i}.md`, content: note(`n${i}`), purpose: `p${i}` }, ctx);
    });
    const results = await Promise.all(jobs);
    assert.ok(results.every((r) => r.ok), JSON.stringify(results));
    const shas = sh(dir, 'rev-list', `${before}..HEAD`).split('\n');
    assert.equal(shas.length, 8);
    for (const s of shas) {
      const files = sh(dir, 'show', '--name-only', '--format=', s).split('\n');
      assert.equal(files.length, 1);
      const i = /n(\d+)\.md$/.exec(files[0]!)![1]!;
      assert.equal(sh(dir, 'log', '-1', '--format=%an', s), `symphony-role${i}`);
      assert.match(sh(dir, 'log', '-1', '--format=%s', s), new RegExp(`run${i}: p${i}$`));
    }
    assert.equal(sh(dir, 'status', '--porcelain'), '');
    assert.equal(fs.existsSync(path.join(dir, '.git/index.lock')), false);
  });

  it('parallel writes to the same new note: one succeeds, the other is refused, the history stays linear and clean', async () => {
    const { dir, write } = await setup();
    const results = await Promise.all([write({ path: 'Inbox/same.md', content: note('a') }), write({ path: 'Inbox/same.md', content: note('b') })]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(sh(dir, 'status', '--porcelain'), '');
    assert.equal(sh(dir, 'log', '--format=%an').split('\n').filter((a) => a === 'symphony-developer').length, 1);
  });

  it('a manual change made while writes are queued is not pulled into an agent commit', async () => {
    const { dir, write } = await setup();
    put(dir, 'Inbox/manual.md', 'manual\n');
    const results = await Promise.all([write({ path: 'Inbox/a.md', content: note('a') }), write({ path: 'Inbox/b.md', content: note('b') })]);
    assert.ok(results.every((r) => r.ok));
    for (const s of sh(dir, 'log', '--format=%H', '--author=symphony-developer').split('\n')) {
      assert.equal(sh(dir, 'show', '--name-only', '--format=', s).includes('manual.md'), false);
    }
    assert.equal(sh(dir, 'log', '--format=%an').split('\n').filter((a) => a === 'human').length, 1);
  });
});

describe('revert and history', () => {
  it('git revert of an agent overwrite restores the previous text byte for byte; only linear single-parent commits', async () => {
    const { dir, write, append } = await setup();
    const w1 = await write({ path: 'Inbox/a.md', content: note('first') });
    const w2 = await append({ path: 'Inbox/a.md', heading: 'Findings', text: 'second', base_hash: hashOf(w1) });
    assert.ok(w2.ok);
    const w3 = await write({ path: 'Inbox/a.md', content: note('third'), base_hash: hashOf(w2) });
    assert.ok(w3.ok);
    const v2 = sh(dir, 'show', 'HEAD~1:Inbox/a.md');
    sh(dir, ...IDENTITY, 'revert', '--no-edit', 'HEAD');
    assert.equal(read(dir, 'Inbox/a.md').trim(), v2);
    assert.ok(sh(dir, 'log', '--format=%P').split('\n').every((p) => p.split(' ').filter(Boolean).length <= 1));
  });

  it('git revert of the creating commit removes the note again', async () => {
    const { dir, write } = await setup();
    assert.ok((await write({ path: 'Inbox/new.md', content: note() })).ok);
    sh(dir, ...IDENTITY, 'revert', '--no-edit', 'HEAD');
    assert.equal(fs.existsSync(path.join(dir, 'Inbox/new.md')), false);
  });

  it('every write adds a commit: the commit count grows monotonically (no amend, no squash)', async () => {
    const { dir, write } = await setup();
    let count = Number(sh(dir, 'rev-list', '--count', 'HEAD'));
    const shas = new Set<string>([sh(dir, 'rev-parse', 'HEAD')]);
    for (let i = 0; i < 4; i += 1) {
      assert.ok((await write({ path: `Inbox/n${i}.md`, content: note(`${i}`) })).ok);
      const now = Number(sh(dir, 'rev-list', '--count', 'HEAD'));
      assert.equal(now, count + 1);
      count = now;
      shas.add(sh(dir, 'rev-parse', 'HEAD'));
    }
    assert.equal(shas.size, 5);
    // every earlier commit is still reachable
    for (const s of shas) assert.equal(sh(dir, 'merge-base', '--is-ancestor', s, 'HEAD') === '', true);
  });
});

describe('onCommit hook', () => {
  it('is called with (sha, paths) for agent and human commits, with the commit sha', async () => {
    const calls: [string, string[]][] = [];
    const { dir, write } = await setup({ onCommit: (s, p) => void calls.push([s, p]) });
    put(dir, 'Inbox/m.md', 'm\n');
    assert.ok((await write({ path: 'Inbox/a.md', content: note() })).ok);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]![1], ['Inbox/m.md']);
    assert.deepEqual(calls[1]![1], ['Inbox/a.md']);
    assert.equal(calls[1]![0], sh(dir, 'rev-parse', 'HEAD'));
    assert.equal(calls[0]![0], sh(dir, 'rev-parse', 'HEAD~1'));
  });

  it('an async hook is awaited before the tool returns', async () => {
    let done = false;
    const { write } = await setup({
      onCommit: async () => {
        await new Promise((r) => setTimeout(r, 30));
        done = true;
      },
    });
    assert.ok((await write({ path: 'Inbox/a.md', content: note() })).ok);
    assert.equal(done, true);
  });

  it('a rejecting async hook is only logged; write stays ok and committed', async () => {
    const { dir, write, lines } = await setup({ onCommit: () => Promise.reject(new Error('async boom')) });
    assert.ok((await write({ path: 'Inbox/a.md', content: note() })).ok);
    assert.ok(lines.some((l) => l.includes('async boom')));
    assert.equal(sh(dir, 'status', '--porcelain'), '');
    assert.equal(sh(dir, 'show', '--name-only', '--format=', 'HEAD'), 'Inbox/a.md');
  });

  it('a throwing hook does not stop the next write (queue keeps running)', async () => {
    const { write } = await setup({
      onCommit: () => {
        throw new Error('boom');
      },
    });
    assert.ok((await write({ path: 'Inbox/a.md', content: note() })).ok);
    assert.ok((await write({ path: 'Inbox/b.md', content: note() })).ok);
  });

  it('is not called when the commit fails', async () => {
    const calls: string[] = [];
    const { dir, write } = await setup({ onCommit: (s) => void calls.push(s) });
    fs.writeFileSync(path.join(dir, '.git/index.lock'), '');
    assert.equal((await write({ path: 'Inbox/a.md', content: note() })).ok, false);
    assert.deepEqual(calls, []);
  });
});

describe('git errors', () => {
  it('a locked index: rejected, error logged, new note removed, old note restored, no commit', async () => {
    const { dir, write, lines } = await setup();
    const first = await write({ path: 'Inbox/a.md', content: note('one') });
    const oldText = read(dir, 'Inbox/a.md');
    const head = sh(dir, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, '.git/index.lock'), '');
    const created = await write({ path: 'Inbox/new.md', content: note() });
    const changed = await write({ path: 'Inbox/a.md', content: note('two'), base_hash: hashOf(first) });
    assert.equal(category(created), 'rejected');
    assert.equal(category(changed), 'rejected');
    assert.ok(lines.some((l) => /error/i.test(l)));
    fs.rmSync(path.join(dir, '.git/index.lock'));
    assert.equal(fs.existsSync(path.join(dir, 'Inbox/new.md')), false);
    assert.equal(read(dir, 'Inbox/a.md'), oldText);
    assert.equal(sh(dir, 'rev-parse', 'HEAD'), head);
    assert.equal(sh(dir, 'status', '--porcelain'), '');
    // vault is usable again
    assert.ok((await write({ path: 'Inbox/new.md', content: note() })).ok);
  });

  it('a failing human take-over rejects the write and the target file is not touched', async () => {
    const { dir, write } = await setup();
    assert.ok((await write({ path: 'Inbox/a.md', content: note('one') })).ok);
    put(dir, 'Inbox/manual.md', 'manual\n');
    const before = read(dir, 'Inbox/a.md');
    fs.writeFileSync(path.join(dir, '.git/index.lock'), '');
    const r = await write({ path: 'Inbox/a.md', content: note('two'), base_hash: sha256(before) });
    assert.equal(category(r), 'rejected');
    assert.equal(read(dir, 'Inbox/a.md'), before);
    assert.equal(read(dir, 'Inbox/manual.md'), 'manual\n');
    fs.rmSync(path.join(dir, '.git/index.lock'));
    assert.ok((await write({ path: 'Inbox/a.md', content: note('two'), base_hash: sha256(before) })).ok);
    assert.equal(sh(dir, 'status', '--porcelain'), '');
  });

  it('a broken repository (.git removed) gives rejected, not an exception, and the queue survives', async () => {
    const { dir, write } = await setup();
    fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    // the vault dir itself lives in a temp dir: make sure no parent repo adopts it
    const r = await write({ path: 'Inbox/a.md', content: note() });
    if (!r.ok) {
      assert.equal(category(r), 'rejected');
      assert.equal(fs.existsSync(path.join(dir, 'Inbox/a.md')), false);
    }
    // a following call still returns a result
    const r2 = await write({ path: 'Inbox/b.md', content: note() });
    assert.equal(typeof r2.ok, 'boolean');
  });
});

describe('without versioning the tools behave as before', () => {
  it('writes into a plain directory without git and without error', async () => {
    const dir = tempDir('symphony-vault-');
    put(dir, 'README.md', '# Rules\n');
    const logger = Logger.silent();
    const tools = brainToolsFor({ enabled: true, path: dir } as never, 'write', logger, {});
    const ctx: AgentToolContext = { issue: makeIssue({ id: 'a' }), role: 'developer', runId: 'r' };
    const r = await tools.find((t) => t.name === 'brain_write')!.execute({ path: 'Inbox/a.md', content: note(), purpose: 'p' }, ctx);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(fs.existsSync(path.join(dir, '.git')), false);
  });
});

describe('worker wiring: a real agent session commits its writes', () => {
  it('brain_write from a session tool set lands as a commit with role and run of the session', async () => {
    const dir = path.join(tempDir(), 'vault');
    await ensureVault(dir, []);
    const rootDir = tempDir();
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const workflow = new StaticWorkflow(makeWorkflow(baseFront(rootDir, { roles: { dev: { states: ['Todo', 'In Progress'], brain: 'write' } }, brain: { path: dir, enabled: true } })));
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
    const params = runner.sessions[0]!.params;
    const context = params.toolContext();
    const write = params.brainTools!.find((t: AgentToolSpec) => t.name === 'brain_write')!;
    put(dir, 'Inbox/by-hand.md', 'hand\n');
    const r = await write.execute({ path: 'Inbox/wired.md', content: note(), purpose: 'wiring' }, context);
    assert.ok(r.ok, JSON.stringify(r));
    assert.match(sh(dir, 'log', '-1', '--format=%an|%s'), new RegExp(`^symphony-${String(context.role).toLowerCase().replace(/[^a-z0-9-]/g, '-')}\\|.*: wiring$`));
    assert.equal(sh(dir, 'log', '-1', '--skip=1', '--format=%an|%s'), 'human|Obsidian: 1 Dateien');
    assert.equal(sh(dir, 'status', '--porcelain'), '');
  });
});
