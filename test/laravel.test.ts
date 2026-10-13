import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { boostToolPolicy, prepareLaravelBoost, extractGuidelines } from '../src/laravel/boost.ts';
import { candidateAppDirs, classifyComposer, detectLaravelApps } from '../src/laravel/detect.ts';
import { laravelIntegration, type LaravelConfig } from '../src/laravel/integration.ts';
import { Logger, type LogSink } from '../src/log.ts';
import { tempDir } from './helpers.ts';

const LARAVEL = JSON.stringify({ require: { php: '^8.3', 'laravel/framework': '^12.0' } });
const BOOST_READ_TOOLS = [
  'application-info',
  'browser-logs',
  'database-connections',
  'database-query',
  'database-schema',
  'get-absolute-url',
  'last-error',
  'read-log-entries',
  'search-docs',
];
const LARAVEL_BOOST = JSON.stringify({ require: { 'laravel/framework': '^12.0' }, 'require-dev': { 'laravel/boost': '^2.0' } });

/**
 * Stand-ins for php and composer: they log their arguments and write what Boost and Composer
 * would. FAKE_PHP_EXIT and FAKE_PHP_SLEEP make php fail or hang; FAKE_BOOST_NO_GUIDELINES and FAKE_BOOST_NO_SKILLS
 * make boost:install skip writing guidelines or skills (and still exit 0), FAKE_BOOST_NO_SKILL_LIST reports no skills.
 */
const FAKE_PHP = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const [artisan, command, ...rest] = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(['php', artisan, command, ...rest, process.env.APP_ENV]) + '\\n');
if (process.env.FAKE_PHP_SLEEP) { setTimeout(() => {}, 60_000); return; }
const app = path.dirname(artisan);
if (command === 'boost:install') {
  const file = fs.existsSync(path.join(app, 'CLAUDE.md')) ? 'CLAUDE.md' : 'AGENTS.md';
  const block = '<laravel-boost-guidelines>\\n# Boost ' + (process.env.FAKE_BOOST_TEXT || 'guidelines') + '\\n</laravel-boost-guidelines>';
  const current = fs.existsSync(path.join(app, file)) ? fs.readFileSync(path.join(app, file), 'utf8') : '';
  const next = /<laravel-boost-guidelines>[\\s\\S]*<\\/laravel-boost-guidelines>/.test(current)
    ? current.replace(/<laravel-boost-guidelines>[\\s\\S]*<\\/laravel-boost-guidelines>/, block)
    : current + (current === '' ? '' : '\\n\\n') + block + '\\n';
  if (!process.env.FAKE_BOOST_NO_GUIDELINES) fs.writeFileSync(path.join(app, file), next);
  if (!process.env.FAKE_BOOST_NO_SKILLS) {
    fs.mkdirSync(path.join(app, '.claude/skills/testing-best-practices'), { recursive: true });
    fs.writeFileSync(path.join(app, '.claude/skills/testing-best-practices/SKILL.md'), '---\\nname: testing-best-practices\\n---\\n');
  }
  const config = JSON.parse(fs.readFileSync(path.join(app, 'boost.json'), 'utf8'));
  for (const pkg of process.env.FAKE_BOOST_NO_SKILLS ? [] : config.packages || []) {
    const skills = path.join(app, 'vendor', pkg, 'resources/boost/skills');
    if (!fs.existsSync(skills)) continue;
    for (const skill of fs.readdirSync(skills)) {
      fs.mkdirSync(path.join(app, '.claude/skills', skill), { recursive: true });
      fs.copyFileSync(path.join(skills, skill, 'SKILL.md'), path.join(app, '.claude/skills', skill, 'SKILL.md'));
    }
  }
  config.skills = process.env.FAKE_BOOST_NO_SKILL_LIST ? [] : ['testing-best-practices'];
  if (process.env.FAKE_SAIL) config.sail = true;
  fs.writeFileSync(path.join(app, 'boost.json'), JSON.stringify(config));
}
process.exit(Number(process.env.FAKE_PHP_EXIT || 0));
`;

const FAKE_COMPOSER = `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(['composer', ...process.argv.slice(2)]) + '\\n');
fs.mkdirSync('vendor/laravel/boost', { recursive: true });
fs.mkdirSync('vendor/composer', { recursive: true });
fs.writeFileSync('vendor/autoload.php', '<?php');
for (const pkg of (process.env.FAKE_PACKAGES || '').split(',').filter(Boolean)) {
  fs.mkdirSync('vendor/' + pkg + '/resources/boost/skills/filament-development', { recursive: true });
  fs.writeFileSync('vendor/' + pkg + '/resources/boost/skills/filament-development/SKILL.md', '---\\nname: filament-development\\n---\\n');
}
fs.writeFileSync('vendor/composer/installed.json', JSON.stringify({ packages: [{ name: 'laravel/boost', version: 'v2.0.0' }] }));
`;

interface Fixture {
  repo: string;
  log: string;
  php: string;
  composer: string;
  warnings: string[];
  lines: string[];
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd, encoding: 'utf8' });
}

/** A committed repository with the given files and fake php/composer next to it. */
function fixture(files: Record<string, string>): Fixture {
  const base = tempDir('symphony-laravel-');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  for (const [name, content] of Object.entries({ '.gitignore': 'vendor/\n', ...files })) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), content);
  }
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  const php = path.join(bin, 'php');
  const composer = path.join(bin, 'composer');
  fs.writeFileSync(php, FAKE_PHP, { mode: 0o755 });
  fs.writeFileSync(composer, FAKE_COMPOSER, { mode: 0o755 });
  const log = path.join(base, 'calls.log');
  fs.writeFileSync(log, '');
  return { repo, log, php, composer, warnings: [], lines: [] };
}

function laravelConfig(f: Fixture, overrides: Partial<LaravelConfig> = {}): LaravelConfig {
  return {
    boost: 'auto',
    php: f.php,
    composer: f.composer,
    installDependencies: true,
    timeoutMs: 10_000,
    env: { APP_ENV: 'local' },
    agentEnv: {},
    allowTinker: false,
    denyTools: ['record-rule'],
    ...overrides,
  };
}

async function prepare(f: Fixture, options: { config?: Partial<LaravelConfig>; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}) {
  return (await prepareFull(f, options)).extensions;
}

function prepareFull(f: Fixture, options: { config?: Partial<LaravelConfig>; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}) {
  const sink: LogSink = {
    name: 'memory',
    write: (line) => {
      f.lines.push(line);
      if (line.includes(' WARN ') || line.includes('level=warn')) f.warnings.push(line);
    },
  };
  return prepareLaravelBoost({
    workspacePath: f.repo,
    config: laravelConfig(f, options.config),
    env: { ...process.env, FAKE_LOG: f.log, ...options.env },
    logger: Logger.create({ sinks: [sink], level: 'debug' }),
    signal: options.signal ?? new AbortController().signal,
  });
}

function calls(f: Fixture): string[][] {
  return fs.readFileSync(f.log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

function gitStatus(f: Fixture): string {
  return git(f.repo, 'status', '--porcelain', '--untracked-files=all');
}

function excludeBlock(f: Fixture): string[] {
  const content = fs.readFileSync(path.join(f.repo, '.git', 'info', 'exclude'), 'utf8');
  const match = /# >>> symphony laravel-boost[^\n]*\n([\s\S]*?)# <<< symphony laravel-boost/.exec(content);
  return match === null ? [] : (match[1] as string).split('\n').filter(Boolean);
}

describe('Laravel detection', () => {
  it('reads the framework from require and Boost from require or require-dev', () => {
    assert.deepEqual(classifyComposer(JSON.parse(LARAVEL_BOOST)), { laravel: true, boost: true });
    assert.deepEqual(classifyComposer({ require: { 'laravel/boost': '^2' } }), { laravel: false, boost: true });
    assert.deepEqual(classifyComposer({ 'require-dev': { 'laravel/framework': '^12' } }), { laravel: false, boost: false });
    assert.deepEqual(classifyComposer(null), { laravel: false, boost: false });
  });

  it('finds app directories at the root and one level deep', () => {
    const paths = [
      'artisan', 'composer.json', 'laravel/artisan', 'laravel/composer.json', 'api/composer.json',
      'vendor/x/artisan', 'vendor/composer.json', 'vendor/artisan', '.hidden/artisan', '.hidden/composer.json',
      'node_modules/artisan', 'node_modules/composer.json', 'deep/a/artisan', 'deep/a/composer.json',
    ];
    assert.deepEqual(candidateAppDirs(paths), ['', 'laravel']);
  });

  it('detects Laravel apps on disk and skips non-Laravel PHP projects', async () => {
    const root = tempDir();
    for (const [name, content] of Object.entries({
      'laravel/artisan': '', 'laravel/composer.json': LARAVEL_BOOST,
      'tool/artisan': '', 'tool/composer.json': JSON.stringify({ require: { 'symfony/console': '^7' } }),
      'vendor/artisan': '', 'vendor/composer.json': LARAVEL,
    })) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), content);
    }
    assert.deepEqual(await detectLaravelApps(root), [{ dir: 'laravel', path: path.join(root, 'laravel'), boost: true }]);
  });

  it('describes the Laravel apps of an existing workspace and the off mode for the dry run', async () => {
    const root = tempDir();
    for (const [name, content] of Object.entries({ artisan: '', 'composer.json': LARAVEL, 'api/artisan': '', 'api/composer.json': LARAVEL_BOOST })) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), content);
    }
    const { config } = laravelIntegration.resolveConfig({ boost: 'off' }, { workflowDir: root, env: {}, hookTimeoutMs: 1_000 });
    fs.writeFileSync(path.join(root, 'api/composer.lock'), JSON.stringify({ packages: [{ name: 'laravel/framework', version: 'v13.1.0' }], 'packages-dev': [{ name: 'laravel/boost', version: 'v2.0.1' }] }));
    assert.deepEqual(await laravelIntegration.describe!(config, {}, root), [
      'Laravel app (repository root): versions unknown (no composer.lock) (no laravel/boost in composer.json)',
      'Laravel app api/: Laravel v13.1.0 · Boost v2.0.1 (requires laravel/boost)',
    ]);
    assert.deepEqual(await laravelIntegration.describe!(config, {}, null), ['Laravel Boost:   off']);
  });

  it('extracts the Boost guideline block', () => {
    assert.equal(extractGuidelines('# Own\n\n<laravel-boost-guidelines>\nx\n</laravel-boost-guidelines>\n'), '<laravel-boost-guidelines>\nx\n</laravel-boost-guidelines>');
    assert.equal(extractGuidelines('# Own'), null);
  });
});

describe('Laravel Boost preparation', () => {
  it('installs dependencies, generates Boost files for Claude Code and keeps git clean', async () => {
    const f = fixture({ artisan: '', 'composer.json': LARAVEL_BOOST, 'composer.lock': '{}', 'CLAUDE.md': '# Team notes\n' });
    const extensions = await prepare(f);
    assert.ok(extensions !== null);

    assert.deepEqual(calls(f), [
      ['composer', 'install', '--no-interaction', '--no-progress'],
      ['php', path.join(f.repo, 'artisan'), 'boost:install', '--no-interaction', '--guidelines', '--skills', 'local'],
    ]);
    assert.equal(gitStatus(f), '');
    assert.deepEqual(excludeBlock(f), ['/.claude/skills/testing-best-practices/SKILL.md', '/boost.json']);
    // The tracked CLAUDE.md is back to the committed version; the block moved into the prompt.
    assert.equal(fs.readFileSync(path.join(f.repo, 'CLAUDE.md'), 'utf8'), '# Team notes\n');
    const boostJson = JSON.parse(fs.readFileSync(path.join(f.repo, 'boost.json'), 'utf8'));
    assert.deepEqual(boostJson.agents, ['claude_code']);
    assert.equal(boostJson.mcp, true);

    assert.deepEqual(extensions.mcpServers, {
      'laravel-boost': {
        command: f.php,
        args: [path.join(f.repo, 'artisan'), 'boost:mcp'],
        env: { APP_ENV: 'local', SYMPHONY_WORKSPACE: f.repo },
        autoApprove: BOOST_READ_TOOLS,
        deny: ['tinker', 'record-rule'],
      },
    });
    assert.deepEqual(extensions.additionalDirectories, []);
    assert.deepEqual(extensions.env, {}, 'laravel.env stays out of the agent shell');
    assert.equal(extensions.contextSections.length, 1);
    const section = extensions.contextSections[0] as string;
    assert.match(section, /Laravel application at the repository root/);
    assert.match(section, /mcp__laravel-boost__\*/);
    assert.match(section, /Pre-approved tools: `application-info`, .*`search-docs`\./);
    assert.match(section, /Not available in this session: `tinker`, `record-rule`\./);
    assert.match(section, /skills for this app's packages are available: `testing-best-practices`\./);
    assert.doesNotMatch(section, /pest-testing|read-only\)|\.ai\/rules|APP_ENV/);
    assert.match(section, /## Laravel Boost guidelines \(from CLAUDE\.md\)\n\n<laravel-boost-guidelines>\n# Boost guidelines/);
  });

  it('passes laravel.agent_env to the agent and keeps laravel.env for the MCP server', async () => {
    const f = fixture({ artisan: '', 'composer.json': LARAVEL_BOOST });
    const extensions = await prepare(f, { config: { env: { APP_ENV: 'local', DB_DATABASE: 'dev' }, agentEnv: { FOO: 'bar' } } });
    assert.deepEqual(extensions?.env, { FOO: 'bar' });
    assert.deepEqual(extensions?.mcpServers['laravel-boost']?.env, { APP_ENV: 'local', DB_DATABASE: 'dev', SYMPHONY_WORKSPACE: f.repo });
  });

  it('opens tinker, record-rule and search-docs only as configured', async () => {
    const f = fixture({ artisan: '', 'composer.json': LARAVEL_BOOST });
    const extensions = await prepare(f, { config: { allowTinker: true, denyTools: ['search-docs'] } });
    const server = extensions?.mcpServers['laravel-boost'];
    assert.deepEqual(server?.deny, ['search-docs']);
    assert.deepEqual(server?.autoApprove, BOOST_READ_TOOLS.filter((tool) => tool !== 'search-docs'));
    const section = extensions?.contextSections[0] as string;
    assert.match(section, /record-rule.*\.ai\/rules/);
    assert.doesNotMatch(section, /Use `search-docs`/);
  });

  it('derives the Boost tool policy from the config', () => {
    const base = { allowTinker: false, denyTools: ['record-rule'] } as LaravelConfig;
    assert.deepEqual(boostToolPolicy(base), { autoApprove: BOOST_READ_TOOLS, deny: ['tinker', 'record-rule'] });
    assert.deepEqual(boostToolPolicy({ ...base, allowTinker: true }).deny, ['record-rule']);
    const moved = boostToolPolicy({ ...base, denyTools: ['search-docs', 'record-rule'] });
    assert.deepEqual(moved.deny, ['tinker', 'search-docs', 'record-rule']);
    assert.ok(!moved.autoApprove.includes('search-docs'));
    assert.deepEqual(boostToolPolicy({ ...base, allowTinker: true, denyTools: [] }), { autoApprove: BOOST_READ_TOOLS, deny: [] });
  });

  it('handles an app in a subdirectory and writes AGENTS.md when there is no CLAUDE.md', async () => {
    const f = fixture({ 'README.md': '# Portal\n', 'laravel/artisan': '', 'laravel/composer.json': LARAVEL_BOOST });
    const extensions = await prepare(f);
    assert.ok(extensions !== null);
    assert.equal(gitStatus(f), '');
    assert.deepEqual(excludeBlock(f), ['/laravel/.claude/skills/testing-best-practices/SKILL.md', '/laravel/AGENTS.md', '/laravel/boost.json']);
    assert.deepEqual(Object.keys(extensions.mcpServers), ['laravel-boost']);
    assert.deepEqual(extensions.mcpServers['laravel-boost']?.args, [path.join(f.repo, 'laravel', 'artisan'), 'boost:mcp']);
    assert.deepEqual(extensions.additionalDirectories, [path.join(f.repo, 'laravel')]);
    assert.match(extensions.contextSections[0] as string, /at `laravel\/`/);
    assert.match(extensions.contextSections[0] as string, /\(from laravel\/AGENTS\.md\)/);
  });

  it('names one server per app when a repository holds several', async () => {
    const f = fixture({
      'admin/artisan': '', 'admin/composer.json': LARAVEL_BOOST,
      'shop/artisan': '', 'shop/composer.json': LARAVEL_BOOST,
    });
    const extensions = await prepare(f);
    assert.deepEqual(Object.keys(extensions?.mcpServers ?? {}), ['laravel-boost-admin', 'laravel-boost-shop']);
    assert.equal(gitStatus(f), '');
    assert.equal(excludeBlock(f).length, 6);
  });

  it('reuses generated files until composer.lock, .ai or Boost change', async () => {
    const f = fixture({ artisan: '', 'composer.json': LARAVEL_BOOST, 'composer.lock': '{"v":1}' });
    await prepare(f);
    assert.equal(calls(f).length, 2);

    const again = await prepare(f);
    assert.equal(calls(f).length, 2, 'nothing runs while the inputs are unchanged');
    assert.match(again?.contextSections[0] as string, /# Boost guidelines/);

    fs.mkdirSync(path.join(f.repo, '.ai', 'guidelines'), { recursive: true });
    fs.writeFileSync(path.join(f.repo, '.ai', 'guidelines', 'money.md'), 'Store cents.\n');
    await prepare(f);
    assert.deepEqual(calls(f).map((call) => call[0]), ['composer', 'php', 'php'], '.ai changes regenerate');

    fs.writeFileSync(path.join(f.repo, 'composer.lock'), '{"v":2}');
    await prepare(f);
    assert.deepEqual(calls(f).map((call) => call[0]), ['composer', 'php', 'php', 'composer', 'php'], 'a new lock reinstalls and regenerates');

    fs.rmSync(path.join(f.repo, '.claude'), { recursive: true });
    await prepare(f);
    assert.equal(calls(f).length, 6, 'a deleted generated file regenerates');
  });

  it('lists installed packages with Boost resources in boost.json and installs their skills', async () => {
    const f = fixture({ artisan: '', 'composer.json': LARAVEL_BOOST, 'composer.lock': '{}' });
    const extensions = await prepare(f, { env: { ...process.env, FAKE_PACKAGES: 'filament/filament' } });
    const boostJson = JSON.parse(fs.readFileSync(path.join(f.repo, 'boost.json'), 'utf8'));
    assert.deepEqual(boostJson.packages, ['filament/filament']);
    assert.ok(excludeBlock(f).includes('/.claude/skills/filament-development/SKILL.md'));
    assert.equal(gitStatus(f), '');
    assert.match(extensions?.contextSections[0] as string, /`filament-development`/);
  });

  it('detects skills although the repository gitignores them (the recommended setup)', async () => {
    const f = fixture({
      artisan: '',
      'composer.json': LARAVEL_BOOST,
      '.gitignore': 'vendor/\nboost.json\n.claude/skills/\n.mcp.json\n',
    });
    const full = await prepareFull(f);
    assert.deepEqual(full.apps[0]?.setup?.skills, ['testing-best-practices']);
    assert.deepEqual(full.apps[0]?.setup?.warnings, []);
    const section = full.extensions?.contextSections[0] as string;
    assert.match(section, /skills for this app's packages are available: `testing-best-practices`\./);
    assert.equal(gitStatus(f), '');
    // The repository ignores the skill files itself; info/exclude does not need them.
    assert.ok(!excludeBlock(f).some((line) => line.includes('.claude/skills')));
  });

  it('keeps committed skills out of the Boost list and warns when boost.json is not committed', async () => {
    const f = fixture({
      artisan: '',
      'composer.json': LARAVEL_BOOST,
      '.claude/skills/my-own/SKILL.md': '---\nname: my-own\n---\n',
    });
    const full = await prepareFull(f, { env: { FAKE_BOOST_NO_SKILLS: '1', FAKE_BOOST_NO_SKILL_LIST: '1' } });
    assert.deepEqual(full.apps[0]?.setup?.skills, []);
    assert.ok(full.apps[0]?.setup?.warnings.some((warning) => warning.includes('tracked in git')));
  });

  it('keeps existing packages entries and regenerates only when the package list changes', async () => {
    const f = fixture({ artisan: '', 'composer.json': LARAVEL_BOOST, 'composer.lock': '{}' });
    process.env.FAKE_PACKAGES = 'filament/filament';
    try {
      await prepare(f);
      fs.writeFileSync(path.join(f.repo, 'boost.json'), JSON.stringify({ packages: ['acme/custom'] }));
      await prepare(f);
      assert.equal(calls(f).length, 2, 'unchanged list keeps the fingerprint');
      fs.mkdirSync(path.join(f.repo, 'vendor/spatie/thing/resources/boost/guidelines'), { recursive: true });
      await prepare(f);
      assert.equal(calls(f).length, 3, 'a new package regenerates');
      const boostJson = JSON.parse(fs.readFileSync(path.join(f.repo, 'boost.json'), 'utf8'));
      assert.deepEqual(boostJson.packages, ['acme/custom', 'filament/filament', 'spatie/thing']);
    } finally {
      delete process.env.FAKE_PACKAGES;
    }
  });

  it('uses committed Boost files as they are', async () => {
    const f = fixture({
      artisan: '',
      'composer.json': LARAVEL_BOOST,
      'boost.json': '{"agents":["claude_code"]}',
      '.claude/skills/livewire-development/SKILL.md': '---\nname: livewire-development\n---\n',
      'CLAUDE.md': '# App\n\n<laravel-boost-guidelines>\ncommitted\n</laravel-boost-guidelines>\n',
    });
    const extensions = await prepare(f);
    assert.deepEqual(calls(f).map((call) => call[0]), ['composer'], 'no boost:install');
    assert.deepEqual(Object.keys(extensions?.mcpServers ?? {}), ['laravel-boost']);
    const section = extensions?.contextSections[0] as string;
    assert.match(section, /commits its Boost files/);
    assert.match(section, /skills for this app's packages are available: `livewire-development`\./);
    assert.doesNotMatch(section, /committed\n<\/laravel-boost-guidelines>/, 'Claude Code loads the root CLAUDE.md itself');
    assert.equal(gitStatus(f), '');
  });

  it('keeps changes the agent already made to files Boost touches', async () => {
    const f = fixture({ artisan: '', 'composer.json': LARAVEL_BOOST, 'AGENTS.md': '# Agents\n' });
    fs.writeFileSync(path.join(f.repo, 'AGENTS.md'), '# Agents\n\nEdited by the agent.\n');
    const extensions = await prepare(f);
    assert.equal(fs.readFileSync(path.join(f.repo, 'AGENTS.md'), 'utf8'), '# Agents\n\nEdited by the agent.\n');
    assert.equal(gitStatus(f), ' M AGENTS.md\n');
    assert.match(extensions?.contextSections[0] as string, /# Boost guidelines/);
  });

  it('leaves staged renames of the agent alone', async () => {
    const f = fixture({ artisan: '', 'composer.json': LARAVEL_BOOST, 'docs.md': '# Docs\n' });
    git(f.repo, 'mv', 'docs.md', 'manual.md');
    const before = gitStatus(f);
    assert.notEqual(await prepare(f), null);
    assert.equal(gitStatus(f), before);
  });

  it('points to a file instead of inlining very large guidelines', async () => {
    const f = fixture({ artisan: '', 'composer.json': LARAVEL_BOOST });
    const extensions = await prepare(f, { env: { FAKE_BOOST_TEXT: 'x'.repeat(60_000) } });
    const section = extensions?.contextSections[0] as string;
    const match = /Read Laravel Boost's guidelines before you start: (\S+)/.exec(section);
    assert.ok(match !== null, section.slice(0, 500));
    assert.ok(section.length < 5_000);
    assert.match(fs.readFileSync(match[1] as string, 'utf8'), /^<laravel-boost-guidelines>/);
    assert.equal(gitStatus(f), '');
  });

  it('runs without Boost when boost:install fails, keeping its leftovers out of git', async () => {
    const f = fixture({ artisan: '', 'composer.json': LARAVEL_BOOST });
    assert.equal(await prepare(f, { env: { FAKE_PHP_EXIT: '1' } }), null);
    assert.ok(f.warnings.some((line) => line.includes('boost:install failed')));
    assert.equal(gitStatus(f), '');

    // The next attempt retries.
    assert.notEqual(await prepare(f), null);
    assert.equal(calls(f).filter((call) => call[2] === 'boost:install').length, 2);
  });

  it('reports a failing boost:install as status failed with a prompt note and run history fields', async () => {
    const lock = JSON.stringify({ packages: [{ name: 'laravel/framework', version: 'v13.1.0' }], 'packages-dev': [{ name: 'laravel/boost', version: 'v2.0.1' }] });
    const f = fixture({ artisan: '', 'composer.json': LARAVEL_BOOST, 'composer.lock': lock });
    const logged: string[] = [];
    const sink: LogSink = { name: 'memory', write: (line) => logged.push(line) };
    const result = await laravelIntegration.prepare(laravelConfig(f), {
      workspacePath: f.repo,
      env: { ...process.env, FAKE_LOG: f.log, FAKE_PHP_EXIT: '1' },
      logger: Logger.create({ sinks: [sink], level: 'debug' }),
      signal: new AbortController().signal,
    });
    assert.deepEqual(result?.mcpServers, {});
    assert.deepEqual(result?.contextSections, ['Laravel Boost is unavailable for `(repository root)` (boost:install failed); use artisan and composer in the shell.']);
    assert.deepEqual(result?.historyFields, { laravel: '.:v13.1.0', boost: 'failed' });
    const line = logged.find((entry) => entry.includes('integration_prepared'));
    assert.match(line ?? '', /laravel\/framework=v13\.1\.0 laravel\/boost=v2\.0\.1.*boost=failed/);
  });

  it('reports what the session gets from Boost per app for the dashboard', async () => {
    const lock = JSON.stringify({ packages: [{ name: 'laravel/framework', version: 'v13.1.0' }], 'packages-dev': [{ name: 'laravel/boost', version: 'v2.0.1' }] });
    const f = fixture({ artisan: '', 'composer.json': LARAVEL_BOOST, 'composer.lock': lock, 'CLAUDE.md': '# Team notes\n', 'docs/artisan': '', 'docs/composer.json': LARAVEL });
    const result = await laravelIntegration.prepare(laravelConfig(f), {
      workspacePath: f.repo,
      env: { ...process.env, FAKE_LOG: f.log },
      logger: Logger.silent(),
      signal: new AbortController().signal,
    });
    assert.deepEqual(result?.reports, [
      {
        id: 'laravel-boost',
        label: 'Laravel Boost',
        status: 'ready',
        parts: [
          {
            name: '(repository root)',
            status: 'ready',
            reason: null,
            versions: 'Laravel v13.1.0 · Boost v2.0.1',
            guidelines: 'CLAUDE.md (in the system prompt)',
            skills: ['testing-best-practices'],
            mcpServer: 'laravel-boost',
            tools: BOOST_READ_TOOLS,
            warnings: [],
          },
          { name: 'docs/', status: 'absent', reason: null, versions: null, guidelines: null, skills: [], mcpServer: null, tools: [], warnings: [] },
        ],
        mcpServers: ['laravel-boost'],
        skills: ['testing-best-practices'],
      },
    ]);

    const failed = fixture({ artisan: '', 'composer.json': LARAVEL_BOOST });
    const unavailable = await laravelIntegration.prepare(laravelConfig(failed), {
      workspacePath: failed.repo,
      env: { ...process.env, FAKE_LOG: failed.log, FAKE_PHP_EXIT: '1' },
      logger: Logger.silent(),
      signal: new AbortController().signal,
    });
    assert.equal(unavailable?.reports?.[0]?.status, 'unavailable');
    assert.equal(unavailable?.reports?.[0]?.parts[0]?.reason, 'boost:install failed');
    assert.deepEqual(unavailable?.reports?.[0]?.mcpServers, []);
  });

  it('checks that boost:install wrote guidelines and skills and generates incomplete output again', async () => {
    const f = fixture({ artisan: '', 'composer.json': LARAVEL_BOOST });
    const first = await prepareFull(f, { env: { FAKE_BOOST_NO_GUIDELINES: '1', FAKE_BOOST_NO_SKILLS: '1' } });
    assert.equal(first.apps[0]?.status, 'ready', 'the MCP server still works');
    assert.deepEqual(first.apps[0]?.setup?.warnings, [
      'boost:install wrote no guidelines to AGENTS.md',
      'boost:install reported skills it did not write to .claude/skills: testing-best-practices',
    ]);
    assert.equal(first.apps[0]?.setup?.guidelines, null);
    assert.deepEqual(first.apps[0]?.setup?.skills, []);
    assert.ok(f.warnings.some((line) => line.includes('wrote no guidelines')));

    // Incomplete output is generated again on the next attempt, then reused.
    const second = await prepareFull(f);
    assert.deepEqual(second.apps[0]?.setup?.warnings, []);
    assert.deepEqual(second.apps[0]?.setup?.skills, ['testing-best-practices']);
    assert.equal(second.apps[0]?.setup?.guidelines, 'AGENTS.md (in the system prompt)');
    await prepareFull(f);
    assert.equal(calls(f).filter((call) => call[2] === 'boost:install').length, 2);
  });

  it('warns when Boost installs no skills at all without generating again', async () => {
    const f = fixture({ artisan: '', 'composer.json': LARAVEL_BOOST });
    const env = { FAKE_BOOST_NO_SKILLS: '1', FAKE_BOOST_NO_SKILL_LIST: '1' };
    const first = await prepareFull(f, { env });
    assert.deepEqual(first.apps[0]?.setup?.warnings, ['boost:install generated no skills (.claude/skills)']);
    const second = await prepareFull(f, { env });
    assert.deepEqual(second.apps[0]?.setup?.warnings, ['boost:install generated no skills (.claude/skills)'], 'kept with the reused files');
    assert.equal(calls(f).filter((call) => call[2] === 'boost:install').length, 1);
  });

  it('reports ready, absent and skipped statuses per app', async () => {
    const f = fixture({ artisan: '', 'composer.json': LARAVEL, 'api/artisan': '', 'api/composer.json': LARAVEL_BOOST });
    const ready = await prepareFull(f);
    assert.deepEqual(ready.apps.map((entry) => [entry.app.dir, entry.status, entry.reason]), [['', 'absent', null], ['api', 'ready', null]]);
    const off = await prepareFull(fixture({ artisan: '', 'composer.json': LARAVEL_BOOST }), { config: { boost: 'off' } });
    assert.deepEqual(off.apps.map((entry) => [entry.status, entry.reason]), [['skipped', 'laravel.boost is off']]);
    const noInstall = await prepareFull(fixture({ artisan: '', 'composer.json': LARAVEL_BOOST }), { config: { installDependencies: false } });
    assert.equal(noInstall.apps[0]?.status, 'skipped');
  });

  it('warns about Sail, whose guidelines contradict host PHP', async () => {
    const f = fixture({ artisan: '', 'composer.json': LARAVEL_BOOST });
    await prepare(f, { env: { FAKE_SAIL: '1' } });
    assert.ok(f.warnings.some((line) => line.includes('Sail')));
  });

  it('stops a hanging php on abort and on timeout', async () => {
    const f = fixture({ artisan: '', 'composer.json': LARAVEL_BOOST });
    await prepare(f); // installs vendor/
    fs.mkdirSync(path.join(f.repo, '.ai'));
    fs.writeFileSync(path.join(f.repo, '.ai', 'x.md'), 'changed');
    git(f.repo, 'add', '.ai');
    git(f.repo, 'commit', '-q', '-m', 'rules');

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    let started = Date.now();
    assert.equal(await prepare(f, { env: { FAKE_PHP_SLEEP: '1' }, signal: controller.signal }), null);
    assert.ok(Date.now() - started < 5_000);
    assert.equal(gitStatus(f), '', 'reconciled despite the abort');

    started = Date.now();
    assert.equal(await prepare(f, { env: { FAKE_PHP_SLEEP: '1' }, config: { timeoutMs: 200 } }), null);
    assert.ok(Date.now() - started < 5_000);
    assert.ok(f.warnings.some((line) => line.includes('boost:install failed')));
  });

  it('skips apps without Boost, without vendor/ when installs are off, and everything when off', async () => {
    const plain = fixture({ artisan: '', 'composer.json': LARAVEL });
    assert.equal(await prepare(plain), null);
    assert.ok(plain.lines.some((line) => line.includes('without Laravel Boost')));

    const noInstall = fixture({ artisan: '', 'composer.json': LARAVEL_BOOST });
    assert.equal(await prepare(noInstall, { config: { installDependencies: false } }), null);
    assert.ok(noInstall.warnings.some((line) => line.includes('vendor/ is missing')));

    const off = fixture({ artisan: '', 'composer.json': LARAVEL_BOOST });
    assert.equal(await prepare(off, { config: { boost: 'off' } }), null);
    assert.deepEqual(calls(off), []);
  });

  it('keeps existing info/exclude entries and replaces only its own block', async () => {
    const f = fixture({ artisan: '', 'composer.json': LARAVEL_BOOST });
    const exclude = path.join(f.repo, '.git', 'info', 'exclude');
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.writeFileSync(exclude, '# mine\n/scratch/\n');
    await prepare(f);
    fs.mkdirSync(path.join(f.repo, '.ai'));
    fs.writeFileSync(path.join(f.repo, '.ai', 'x.md'), 'changed');
    await prepare(f);
    const content = fs.readFileSync(exclude, 'utf8');
    assert.ok(content.startsWith('# mine\n/scratch/\n# >>> symphony laravel-boost'));
    assert.equal(content.match(/# >>> symphony laravel-boost/g)?.length, 1);
  });
});
