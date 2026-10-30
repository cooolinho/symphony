import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, it, mock } from 'node:test';
import { ensureVault, prepareBrain } from '../src/brain/vault.ts';
import { Logger } from '../src/log.ts';
import { parseWorkflow } from '../src/workflow/loader.ts';
import { tempDir } from './helpers.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

const FS_METHODS = ['mkdir', 'writeFile', 'readFile', 'readdir', 'stat', 'lstat', 'open', 'access', 'rm', 'rename', 'copyFile', 'appendFile', 'utimes', 'chmod', 'realpath', 'opendir'] as const;

/** Records every path argument passed to fs/promises while `fn` runs. */
async function traceFs(fn: () => Promise<unknown>): Promise<string[]> {
  const touched: string[] = [];
  const mocks = FS_METHODS.map((name) => {
    const original = (fsp as unknown as Record<string, (...args: unknown[]) => unknown>)[name]!;
    return mock.method(fsp as never, name as never, ((...args: unknown[]) => {
      if (typeof args[0] === 'string') touched.push(`${name}:${args[0]}`);
      return original.apply(fsp, args);
    }) as never);
  });
  try {
    await fn();
  } finally {
    for (const m of mocks) (m as unknown as { mock: { restore(): void } }).mock.restore();
  }
  return touched;
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    out.push(path.relative(base, full));
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, base));
  }
  return out.sort();
}

describe('brain vault acceptance', () => {
  describe('structure', () => {
    it('creates exactly README.md, the two Bases views and the six folders for an empty repository list', async () => {
      const vault = path.join(tempDir(), 'vault');
      await ensureVault(vault, []);
      assert.deepEqual(walk(vault).filter((p) => p !== '.git' && !p.startsWith(`.git${path.sep}`)), ['.gitignore', 'Agents', 'Decisions', 'Inbox', 'Issues', 'Kandidaten-Review.base', 'Lessons', 'Neueste Lessons.base', 'README.md', 'Repos']);
    });

    it('creates missing parent directories of the vault path', async () => {
      const vault = path.join(tempDir(), 'a', 'b', 'brain');
      await ensureVault(vault, []);
      assert.ok(fs.statSync(path.join(vault, 'Inbox')).isDirectory());
    });

    it('README documents folders, frontmatter fields and statuses', async () => {
      const vault = path.join(tempDir(), 'vault');
      await ensureVault(vault, []);
      const readme = fs.readFileSync(path.join(vault, 'README.md'), 'utf8');
      for (const folder of ['Inbox/', 'Repos/', 'Decisions/', 'Lessons/', 'Issues/', 'Agents/']) {
        assert.ok(readme.includes(folder), `folder ${folder}`);
      }
      for (const field of ['type', 'status', 'repo', 'issue', 'role', 'run', 'created', 'updated', 'sources']) {
        assert.match(readme, new RegExp(`\`${field}\``), `field ${field}`);
      }
      for (const status of ['candidate', 'approved', 'deprecated']) assert.match(readme, new RegExp(`\`${status}\``), `status ${status}`);
    });

    it('is idempotent: five calls leave content, mtimes and the entry list identical', async () => {
      const vault = path.join(tempDir(), 'vault');
      await ensureVault(vault, ['acme/shop', 'acme/tools']);
      const state = (): Record<string, string> =>
        Object.fromEntries(
          [...walk(vault), '.'].map((rel) => {
            const full = path.join(vault, rel);
            const stat = fs.statSync(full);
            return [rel, `${stat.mtimeMs}|${stat.isFile() ? fs.readFileSync(full, 'utf8') : 'dir'}`];
          }),
        );
      const before = state();
      for (let i = 0; i < 5; i += 1) assert.deepEqual(await ensureVault(vault, ['acme/shop', 'acme/tools']), []);
      assert.deepEqual(state(), before);
    });

    it('never overwrites existing files in any managed location', async () => {
      const vault = tempDir();
      fs.mkdirSync(path.join(vault, 'Inbox'));
      fs.writeFileSync(path.join(vault, 'Inbox', 'note.md'), 'keep');
      fs.writeFileSync(path.join(vault, 'README.md'), '');
      await ensureVault(vault, []);
      assert.equal(fs.readFileSync(path.join(vault, 'README.md'), 'utf8'), '', 'empty README stays empty');
      assert.equal(fs.readFileSync(path.join(vault, 'Inbox', 'note.md'), 'utf8'), 'keep');
    });

    it('fails without touching an existing README when a managed folder name is a file', async () => {
      const vault = tempDir();
      fs.writeFileSync(path.join(vault, 'README.md'), 'mine');
      fs.writeFileSync(path.join(vault, 'Lessons'), 'a file');
      await ensureVault(vault, []).catch(() => undefined);
      assert.equal(fs.readFileSync(path.join(vault, 'README.md'), 'utf8'), 'mine');
      assert.equal(fs.readFileSync(path.join(vault, 'Lessons'), 'utf8'), 'a file');
    });
  });

  describe('.obsidian', () => {
    it('is never read, listed, stat-ed or written, with or without an existing .obsidian', async () => {
      const vault = tempDir();
      fs.mkdirSync(path.join(vault, '.obsidian'));
      fs.writeFileSync(path.join(vault, '.obsidian', 'app.json'), '{"a":1}');
      const before = fs.statSync(path.join(vault, '.obsidian', 'app.json')).mtimeMs;
      const touched = await traceFs(() => ensureVault(vault, ['acme/shop', 'acme/.obsidian']));
      assert.ok(touched.length > 0, 'tracing works');
      assert.deepEqual(touched.filter((t) => t.includes('.obsidian') && !t.includes('acme-.obsidian')), []);
      assert.equal(fs.readFileSync(path.join(vault, '.obsidian', 'app.json'), 'utf8'), '{"a":1}');
      assert.equal(fs.statSync(path.join(vault, '.obsidian', 'app.json')).mtimeMs, before);
      assert.deepEqual(fs.readdirSync(path.join(vault, '.obsidian')), ['app.json']);
    });

    it('does not create .obsidian at the vault root, even for a repository named .obsidian', async () => {
      const vault = path.join(tempDir(), 'vault');
      await ensureVault(vault, ['acme/.obsidian', 'acme/..']);
      assert.equal(fs.existsSync(path.join(vault, '.obsidian')), false);
      for (const rel of walk(vault).filter((p) => !p.startsWith(`.git${path.sep}`))) assert.ok(!rel.split(path.sep).includes('.obsidian'), rel);
    });
  });

  describe('repository index', () => {
    it('writes index.md with frontmatter type: index and status: approved', async () => {
      const vault = path.join(tempDir(), 'vault');
      await ensureVault(vault, ['Acme/Shop']);
      const text = fs.readFileSync(path.join(vault, 'Repos', 'acme-shop', 'index.md'), 'utf8');
      const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
      assert.ok(match, 'frontmatter block at the top');
      const lines = match[1]!.split('\n');
      assert.ok(lines.includes('type: index'), 'type: index');
      assert.ok(lines.includes('status: approved'), 'status: approved');
    });

    it('creates one folder per repository and adds missing ones on a later call', async () => {
      const vault = path.join(tempDir(), 'vault');
      await ensureVault(vault, ['acme/shop']);
      assert.deepEqual(fs.readdirSync(path.join(vault, 'Repos')), ['acme-shop']);
      const created = await ensureVault(vault, ['acme/shop', 'other/repo.js']);
      assert.deepEqual(fs.readdirSync(path.join(vault, 'Repos')).sort(), ['acme-shop', 'other-repo.js']);
      assert.ok(created.some((p) => p.endsWith('index.md')));
      assert.ok(fs.existsSync(path.join(vault, 'Repos', 'other-repo.js', 'index.md')));
    });

    it('creates an index.md in an existing empty repository folder', async () => {
      const vault = tempDir();
      fs.mkdirSync(path.join(vault, 'Repos', 'acme-shop'), { recursive: true });
      await ensureVault(vault, ['acme/shop']);
      assert.ok(fs.existsSync(path.join(vault, 'Repos', 'acme-shop', 'index.md')));
    });

    it('skips invalid names and cannot escape Repos/', async () => {
      const base = tempDir();
      const vault = path.join(base, 'vault');
      const hostile = ['../x', 'a/../../etc', '/abs/path', 'a/b/c', 'a\\b', '', ' ', 'noslash', 'a/b\nc', 'a/b/../../c', '../../escape/x', 'a b/c', 'a/b;rm'];
      await ensureVault(vault, hostile);
      assert.deepEqual(fs.readdirSync(base), ['vault']);
      assert.deepEqual(fs.readdirSync(path.join(vault, 'Repos')), []);
      assert.deepEqual(walk(vault).filter((p) => p.startsWith(`Repos${path.sep}`)), []);
    });

    it('keeps dot-only names inside Repos/', async () => {
      const base = tempDir();
      const vault = path.join(base, 'vault');
      await ensureVault(vault, ['a/.', 'a/..', '-/..']);
      assert.deepEqual(fs.readdirSync(base), ['vault']);
      assert.deepEqual(fs.readdirSync(vault).sort(), ['.git', '.gitignore', 'Agents', 'Decisions', 'Inbox', 'Issues', 'Kandidaten-Review.base', 'Lessons', 'Neueste Lessons.base', 'README.md', 'Repos']);
      for (const rel of walk(vault)) assert.ok(!rel.split(path.sep).some((part) => part === '..' || part === '.'), rel);
    });
  });

  describe('prepareBrain (startup hook)', () => {
    it('with enabled: false touches no filesystem path at all', async () => {
      const base = tempDir();
      const target = path.join(base, 'missing', 'brain');
      const touched = await traceFs(() => prepareBrain({ enabled: false, path: target, clashWindowMs: 600000 }, ['acme/shop'], Logger.silent()));
      assert.deepEqual(touched, []);
      assert.equal(fs.existsSync(path.join(base, 'missing')), false);
      assert.deepEqual(fs.readdirSync(base), []);
    });

    it('with enabled: false leaves an existing directory untouched', async () => {
      const dir = tempDir();
      fs.writeFileSync(path.join(dir, 'x'), 'x');
      await prepareBrain({ enabled: false, path: dir, clashWindowMs: 600000 }, ['acme/shop'], Logger.silent());
      assert.deepEqual(fs.readdirSync(dir), ['x']);
    });

    it('with enabled: true builds the vault including repository indexes', async () => {
      const vault = path.join(tempDir(), 'brain');
      await prepareBrain({ enabled: true, path: vault, clashWindowMs: 600000 }, ['acme/shop'], Logger.silent());
      assert.ok(fs.existsSync(path.join(vault, 'README.md')));
      assert.ok(fs.existsSync(path.join(vault, 'Repos', 'acme-shop', 'index.md')));
    });

    it('logs and does not throw when the vault path is not writable', async () => {
      const file = path.join(tempDir(), 'file');
      fs.writeFileSync(file, 'x');
      const errors: unknown[][] = [];
      const logger = { info: () => undefined, warn: () => undefined, error: (...a: unknown[]) => void errors.push(a) } as unknown as Logger;
      await assert.doesNotReject(prepareBrain({ enabled: true, path: path.join(file, 'brain'), clashWindowMs: 600000 }, [], logger));
      assert.equal(errors.length, 1);
    });
  });

  describe('service wiring', () => {
    it('runService prepares the brain from config.brain, dryRun does not', () => {
      const src = read('src/service.ts');
      const runStart = src.indexOf('export async function runService');
      const dryStart = src.indexOf('export async function dryRun');
      assert.ok(runStart >= 0 && dryStart >= 0);
      const [run, dry] = runStart < dryStart ? [src.slice(runStart, dryStart), src.slice(dryStart)] : [src.slice(runStart), src.slice(dryStart, runStart)];
      assert.match(run, /prepareBrain\(\s*config\.brain\b/);
      assert.doesNotMatch(dry, /prepareBrain|ensureVault/);
    });
  });

  describe('docker', () => {
    for (const file of ['docker-compose.yml', 'docker-compose.local.yml']) {
      it(`${file}: mounts the brain volume at /home/symphony/brain and declares it`, () => {
        const text = read(file);
        assert.match(text, /^\s*-\s+brain:\/home\/symphony\/brain\s*$/m);
        const top = text.slice(text.search(/^volumes:/m));
        assert.match(top, /^\s+brain:\s*(#.*)?$/m, 'declared under top-level volumes');
      });
    }

    it('docker-compose.yml mounts the volume in the symphony service', () => {
      const text = read('docker-compose.yml');
      const services = text.slice(text.search(/^services:/m), text.search(/^volumes:/m));
      const symphony = /^ {4}symphony:\n([\s\S]*?)(?=^ {4}\S|(?![\s\S]))/m.exec(services);
      assert.ok(symphony, 'symphony service found');
      assert.match(symphony[1]!, /brain:\/home\/symphony\/brain/);
    });

    it('Dockerfile pre-creates /home/symphony/brain owned by the symphony user', () => {
      const text = read('Dockerfile');
      assert.match(text, /\/home\/symphony\/brain/);
      assert.match(text, /install -d -o symphony -g symphony/);
    });
  });

  describe('WORKFLOW.md', () => {
    it('contains the brain section commented out, with enabled and path, and explanations', () => {
      const text = read('WORKFLOW.md');
      const front = text.split(/^---$/m)[1]!;
      assert.match(front, /^# brain:/m);
      assert.match(front, /^#\s+enabled: false/m);
      assert.match(front, /^#\s+path: ~\/brain/m);
      assert.doesNotMatch(front, /^brain:/m, 'not active by default');
    });

    it('still parses, and the brain section stays out of the parsed front matter', () => {
      const definition = parseWorkflow(read('WORKFLOW.md'));
      assert.equal('brain' in definition.config, false);
    });

    it('uncommenting the block yields the documented defaults', () => {
      const text = read('WORKFLOW.md')
        .replace(/^# brain:.*$/m, 'brain:')
        .replace(/^#(\s+enabled: false).*$/m, '$1')
        .replace(/^#(\s+path: ~\/brain).*$/m, '$1');
      const definition = parseWorkflow(text);
      assert.deepEqual(definition.config.brain, { enabled: false, path: '~/brain' });
    });
  });
});
