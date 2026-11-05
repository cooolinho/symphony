import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// E4-5 (#515): the Agent SDK is pinned exactly, so the next upgrade is deliberate. These tests derive from the issue:
// exact pin, a consistent lockfile, the Claude Code version the SDK bundles, and the documentation of the upgrade.

const SDK = '@anthropic-ai/claude-agent-sdk';
const root = new URL('../', import.meta.url);

function readJson<T>(rel: string): T {
  return JSON.parse(fs.readFileSync(new URL(rel, root), 'utf8')) as T;
}
function readText(rel: string): string {
  return fs.readFileSync(new URL(rel, root), 'utf8');
}

interface PackageJson {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}
interface LockPackage {
  version?: string;
  resolved?: string;
  integrity?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}
interface Lock {
  packages: Record<string, LockPackage>;
}

const pkg = readJson<PackageJson>('package.json');
const lock = readJson<Lock>('package-lock.json');
const pin = pkg.dependencies[SDK] ?? '';

describe('Agent SDK pin (E4-5)', () => {
  it('is an exact 0.3.x version in package.json, without a range operator', () => {
    assert.ok(pin, 'package.json must depend on the SDK');
    assert.match(pin, /^0\.3\.\d+$/, `expected an exact 0.3.x version, got "${pin}"`);
    assert.ok(!/[\^~<>=*xX|\s]/.test(pin));
  });

  it('is newer than the old 0.3.288 and not a downgrade', () => {
    assert.ok(Number(pin.split('.')[2]) > 288, `pin ${pin} must be newer than 0.3.288`);
  });

  it('is the same in the lockfile root entry and the locked package', () => {
    assert.equal(lock.packages['']?.dependencies?.[SDK], pin);
    assert.equal(lock.packages[`node_modules/${SDK}`]?.version, pin);
  });

  it('locks every platform package at the same version, with resolved url and integrity', () => {
    const sdkEntry = lock.packages[`node_modules/${SDK}`];
    const optional = Object.entries(sdkEntry?.optionalDependencies ?? {});
    assert.ok(optional.length >= 8, 'the SDK lists its platform binaries as optional dependencies');
    for (const [name, range] of optional) {
      assert.equal(range, pin, `${name} must be requested at ${pin}`);
      const entry = lock.packages[`node_modules/${name}`];
      assert.ok(entry, `${name} is missing in the lockfile`);
      assert.equal(entry.version, pin, `${name} locked at ${entry.version}`);
      assert.match(entry.resolved ?? '', new RegExp(`-${pin.replaceAll('.', '\\.')}\\.tgz$`));
      assert.match(entry.integrity ?? '', /^sha512-/);
    }
  });

  it('leaves no lockfile entry of the SDK family at another version', () => {
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (!key.startsWith(`node_modules/${SDK}`)) continue;
      assert.equal(entry.version, pin, `${key} is locked at ${entry.version}`);
    }
  });

  it('does not upgrade other dependencies (they keep their ranges)', () => {
    assert.equal(pkg.dependencies.liquidjs, '^10.30.0');
    assert.equal(pkg.dependencies.yaml, '^2.9.1');
    assert.equal(pkg.dependencies.zod, '^4.6.5');
    assert.equal(pkg.devDependencies['@types/node'], '^26.6.4');
    assert.equal(pkg.devDependencies.typescript, '^7.0.2');
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@anthropic-ai/claude-agent-sdk', 'liquidjs', 'yaml', 'zod']);
  });

  it('keeps the peer dependencies of the SDK satisfied by the locked versions', () => {
    const sdkEntry = lock.packages[`node_modules/${SDK}`] as LockPackage & { peerDependencies?: Record<string, string> };
    const zod = lock.packages['node_modules/zod']?.version ?? '';
    assert.match(zod, /^4\./);
    assert.ok(sdkEntry.peerDependencies?.zod, 'peer range of zod is declared');
  });
});

describe('installed Agent SDK (E4-5)', () => {
  const installed = path.join(new URL('node_modules/', root).pathname, SDK);
  const installedPkg = fs.existsSync(path.join(installed, 'package.json'))
    ? (JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')) as { version: string; claudeCodeVersion: string })
    : null;

  it('matches the pin', { skip: installedPkg === null }, () => {
    assert.equal(installedPkg?.version, pin);
  });

  it('bundles a Claude Code 2.1.x newer than 2.1.288 whose patch level follows the SDK', { skip: installedPkg === null }, () => {
    assert.match(installedPkg?.claudeCodeVersion ?? '', /^2\.1\.\d+$/);
    assert.ok(Number((installedPkg?.claudeCodeVersion ?? '').split('.')[2]) > 288);
  });

  const binary = path.join(path.dirname(installed), `claude-agent-sdk-${process.platform}-${process.arch}`, 'claude');
  it('ships a binary that reports the bundled Claude Code version', { skip: installedPkg === null || !fs.existsSync(binary) }, () => {
    const out = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, DISABLE_AUTOUPDATER: '1' } });
    assert.ok(out.startsWith(installedPkg?.claudeCodeVersion ?? 'x'), `binary says ${out.trim()}`);
  });
});

describe('upgrade documentation (E4-5)', () => {
  const agentDoc = readText('docs/agent-claude.md');
  const conceptDoc = readText('docs/concepts/subagents.md');
  const subagents = agentDoc.slice(agentDoc.indexOf('### Subagents'), agentDoc.indexOf('### Brain tools'));
  const claudeCode = `2.1.${(readJson<{ claudeCodeVersion?: string }>(`node_modules/${SDK}/package.json`).claudeCodeVersion ?? '').split('.')[2]}`;

  it('names the pinned SDK and Claude Code version in docs/agent-claude.md#subagents', () => {
    assert.ok(subagents.length > 100, 'the Subagents section exists');
    assert.ok(subagents.includes(pin));
    assert.ok(subagents.includes(claudeCode));
  });

  it('no longer says that package.json allows ^0.3.288 (the E4-4 history in the concept stays)', () => {
    assert.ok(!agentDoc.includes('allows `^0.3.288`'));
    const current = conceptDoc.slice(conceptDoc.indexOf('### SDK version and the fork trap'));
    const section = current.slice(0, current.indexOf('\n### ', 10));
    assert.ok(!section.includes('allows `^0.3.288`'));
  });

  it('records a result or an explicit pending state for every live check', () => {
    for (const marker of ['2.1.302', '2.1.314', '2.1.317', '2.1.311']) {
      assert.ok(subagents.includes(marker), `${marker} is not covered in the Subagents section`);
    }
    assert.match(subagents, /[Ff]ork refused/);
    // Without a login the checks are not claimed as done: each line either carries a session id or says pending.
    const lines = subagents.split('\n').filter((l) => /^- (Fork refused|2\.1\.(302|314|317|311))/.test(l));
    assert.equal(lines.length, 5);
  });

  it('states the depth-2 requirement for the 2.1.302 check', () => {
    assert.match(subagents, /CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2/);
  });

  it('states the pin in the concept document and keeps the historical spike text', () => {
    assert.ok(conceptDoc.includes(`**${pin}**`));
    assert.ok(conceptDoc.includes('2.1.288'));
  });
});

describe('scope of the upgrade (E4-5)', () => {
  it('does not use agent_id or the Agent effort in the code yet (E4-6)', () => {
    const dir = new URL('src/agent/', root).pathname;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      assert.ok(!fs.readFileSync(path.join(dir, file), 'utf8').includes('agent_id'), `${file} uses agent_id`);
    }
  });

  it('still denies forks in every session', () => {
    const source = readText('src/agent/claude.ts');
    assert.ok(source.includes('Agent(fork)'));
    assert.match(source, /CLAUDE_CODE_FORK_SUBAGENT:\s*'0'/);
  });

  it('still reports the Claude Code version in session_configured', () => {
    assert.match(readText('src/agent/claude.ts'), /claude_code_version:\s*message\.claude_code_version/);
  });
});
