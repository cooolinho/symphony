import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { VAULT_FOLDERS, ensureVault, prepareBrain, repoFolderName } from '../src/brain/vault.ts';
import { Logger } from '../src/log.ts';
import { tempDir } from './helpers.ts';

const root = path.join(import.meta.dirname, '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

/** Content and mtime of every entry below `dir`, keyed by relative path. */
function snapshot(dir: string, base = dir): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    const key = path.relative(base, full);
    result[key] = `${stat.mtimeMs}:${stat.isDirectory() ? 'dir' : fs.readFileSync(full, 'utf8')}`;
    if (stat.isDirectory()) Object.assign(result, snapshot(full, base));
  }
  return result;
}

describe('ensureVault', () => {
  it('creates README and all folders', async () => {
    const vault = path.join(tempDir(), 'vault');
    const created = await ensureVault(vault, []);
    for (const folder of VAULT_FOLDERS) assert.ok(fs.statSync(path.join(vault, folder)).isDirectory(), folder);
    const readme = fs.readFileSync(path.join(vault, 'README.md'), 'utf8');
    for (const word of ['type', 'status', 'repo', 'issue', 'role', 'run', 'created', 'updated', 'sources', 'candidate', 'approved', 'deprecated', ...VAULT_FOLDERS]) {
      assert.ok(readme.includes(word), word);
    }
    assert.deepEqual(created.sort(), ['README.md', ...VAULT_FOLDERS].sort());
    assert.equal(fs.existsSync(path.join(vault, '.obsidian')), false);
  });

  it('is idempotent: second call changes nothing, contents and mtimes equal', async () => {
    const vault = path.join(tempDir(), 'vault');
    await ensureVault(vault, ['Acme/Shop']);
    const before = snapshot(vault);
    const rootMtime = fs.statSync(vault).mtimeMs;
    assert.deepEqual(await ensureVault(vault, ['Acme/Shop']), []);
    assert.deepEqual(snapshot(vault), before);
    assert.equal(fs.statSync(vault).mtimeMs, rootMtime);
  });

  it('keeps an existing README.md and index.md', async () => {
    const vault = path.join(tempDir(), 'vault');
    fs.mkdirSync(path.join(vault, 'Repos', 'acme-shop'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'README.md'), 'mine');
    fs.writeFileSync(path.join(vault, 'Repos', 'acme-shop', 'index.md'), 'my index');
    const before = snapshot(vault);
    await ensureVault(vault, ['Acme/Shop']);
    assert.equal(fs.readFileSync(path.join(vault, 'README.md'), 'utf8'), 'mine');
    assert.equal(fs.readFileSync(path.join(vault, 'Repos', 'acme-shop', 'index.md'), 'utf8'), 'my index');
    assert.equal(snapshot(vault)['README.md'], before['README.md']);
    assert.equal(snapshot(vault)[path.join('Repos', 'acme-shop', 'index.md')], before[path.join('Repos', 'acme-shop', 'index.md')]);
    assert.ok(fs.statSync(path.join(vault, 'Agents')).isDirectory());
  });

  it('leaves an existing .obsidian untouched', async () => {
    const vault = path.join(tempDir(), 'vault');
    fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
    fs.writeFileSync(path.join(vault, '.obsidian', 'app.json'), '{}');
    const before = snapshot(path.join(vault, '.obsidian'));
    const dirMtime = fs.statSync(path.join(vault, '.obsidian')).mtimeMs;
    await ensureVault(vault, ['a/b']);
    assert.deepEqual(snapshot(path.join(vault, '.obsidian')), before);
    assert.equal(fs.statSync(path.join(vault, '.obsidian')).mtimeMs, dirMtime);
  });

  it('creates Repos/<owner>-<name>/index.md and skips invalid names', async () => {
    const vault = path.join(tempDir(), 'vault');
    await ensureVault(vault, ['Acme/Shop', 'acme/tools', 'not a repo', '../x']);
    assert.deepEqual(fs.readdirSync(path.join(vault, 'Repos')).sort(), ['acme-shop', 'acme-tools']);
    const index = fs.readFileSync(path.join(vault, 'Repos', 'acme-shop', 'index.md'), 'utf8');
    assert.match(index, /^---\ntype: index\nstatus: approved\nrepo: Acme\/Shop\n/);
    assert.equal(fs.existsSync(path.join(vault, 'x')), false);
    assert.equal(repoFolderName('Acme/Shop'), 'acme-shop');
  });
});

describe('prepareBrain', () => {
  it('touches no path when disabled', async () => {
    const missing = path.join(tempDir(), 'missing');
    await prepareBrain({ enabled: false, path: missing }, ['a/b'], Logger.silent());
    assert.equal(fs.existsSync(missing), false);
  });

  it('creates the vault when enabled', async () => {
    const vault = path.join(tempDir(), 'vault');
    await prepareBrain({ enabled: true, path: vault }, [], Logger.silent());
    assert.ok(fs.existsSync(path.join(vault, 'README.md')));
  });

  it('logs instead of throwing on failure', async () => {
    const file = path.join(tempDir(), 'file');
    fs.writeFileSync(file, 'x');
    await prepareBrain({ enabled: true, path: path.join(file, 'vault') }, [], Logger.silent());
  });
});

describe('brain volume', () => {
  it('is mounted in both compose files and prepared in the Dockerfile', () => {
    for (const file of ['docker-compose.yml', 'docker-compose.local.yml']) {
      const text = read(file);
      assert.match(text, /^\s+- brain:\/home\/symphony\/brain$/m, file);
      assert.match(text, /^volumes:\n(?:.*\n)*?    brain:$/m, file);
    }
    assert.match(read('Dockerfile'), /install -d -o symphony -g symphony[^\n]*(\\\n[^\n]*)*\/home\/symphony\/brain/);
  });
});
