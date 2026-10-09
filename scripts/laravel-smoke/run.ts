#!/usr/bin/env node
// Opt-in integration test of the Laravel integration against real software: builds a Laravel 13 app with
// Filament 5, Pest and Laravel Boost, then runs the workspace hook, Boost preparation, the Boost MCP server and
// the check script against it. Skips cleanly without php, composer or Packagist. See docs/e2e.md.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { StdioServer } from '../../src/agent/types.ts';
import { readLaravelFacts, type FactPackage } from '../../src/laravel/facts.ts';
import { laravelIntegration } from '../../src/laravel/integration.ts';
import { Logger, type LogSink } from '../../src/log.ts';
import { errorMessage } from '../../src/util/errors.ts';
import { tail } from '../../src/util/text.ts';
import { runProcess, type HookResult } from '../../src/workspace/hooks.ts';

const USAGE = `Usage: npm run test:laravel -- [options]

Builds a fresh Laravel 13 app (Filament 5, Pest, Laravel Boost) in a temp directory and checks
hooks/laravel-env.sh, the Laravel integration's Boost preparation, the Boost MCP server and checks/laravel.sh.
Needs PHP 8.3+, Composer and network; exits 0 with "skipped: ..." without them.

Options:
  --keep        keep the temp directory and print its path
  -h, --help    show this help
`;

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const MIN_PHP = [8, 3] as const;
const COMPOSER_TIMEOUT_MS = 10 * 60_000;
const STEP_TIMEOUT_MS = 3 * 60_000;
const MCP_TIMEOUT_MS = 20_000;
const SKILL = '.claude/skills/filament-development/SKILL.md';
const REQUIRED_TOOLS = ['database-schema', 'search-docs'];
const SUMMARY_PACKAGES: Array<[FactPackage, string]> = [
  ['laravel/framework', 'Laravel'],
  ['filament/filament', 'Filament'],
  ['laravel/boost', 'Boost'],
  ['pestphp/pest', 'Pest'],
];
const FAILING_TEST = `<?php

it('fails on purpose', function () {
    expect(1)->toBe(2);
});
`;

class Skip extends Error {}
class Failure extends Error {}

const passed: string[] = [];

function pass(message: string): void {
  passed.push(message);
  console.log(`  ok  ${message}`);
}

function assert(condition: boolean, message: string, detail?: string): asserts condition {
  if (!condition) throw new Failure(detail === undefined ? message : `${message}\n${tail(detail, 3_000)}`);
  pass(message);
}

function step(title: string): void {
  console.log(`\n${title}`);
}

/** The environment of every command: no prompts, a fixed git identity, no inherited Laravel settings. */
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COMPOSER_NO_INTERACTION: '1',
    GIT_AUTHOR_NAME: 'Symphony Smoke',
    GIT_AUTHOR_EMAIL: 'smoke@symphony.invalid',
    GIT_COMMITTER_NAME: 'Symphony Smoke',
    GIT_COMMITTER_EMAIL: 'smoke@symphony.invalid',
  };
  for (const key of ['APP_ENV', 'APP_KEY', 'APP_DEBUG', 'DB_CONNECTION', 'DB_DATABASE']) delete env[key];
  return env;
}

async function run(file: string, args: string[], cwd: string, timeoutMs = STEP_TIMEOUT_MS, env = baseEnv()): Promise<HookResult> {
  return runProcess(file, args, { cwd, env, timeoutMs });
}

/** Runs a command that must succeed; its output tail goes into the failure. */
async function must(label: string, file: string, args: string[], cwd: string, timeoutMs = STEP_TIMEOUT_MS): Promise<HookResult> {
  const result = await run(file, args, cwd, timeoutMs);
  const why = result.timedOut ? 'timed out' : result.error ?? `exit ${result.exitCode}`;
  assert(result.ok, label, result.ok ? undefined : `${file} ${args.join(' ')}: ${why}\n${result.output}`);
  return result;
}

// 1. Skip cleanly

async function preflight(): Promise<string> {
  const php = await run('php', ['-r', 'echo PHP_VERSION;'], ROOT, 10_000);
  if (!php.ok) throw new Skip('php is not installed or does not run');
  const version = php.output.trim();
  const [major = 0, minor = 0] = version.split('.').map(Number);
  if (major < MIN_PHP[0] || (major === MIN_PHP[0] && minor < MIN_PHP[1])) throw new Skip(`PHP ${version} is older than ${MIN_PHP.join('.')}`);
  const composer = await run('composer', ['--version', '--no-ansi'], ROOT, 30_000);
  if (!composer.ok) throw new Skip('composer is not installed or does not run');
  try {
    const response = await fetch('https://repo.packagist.org/packages.json', { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Skip(`Packagist is unreachable (${errorMessage(error)})`);
  }
  const composerVersion = /Composer (?:version )?(\S+)/.exec(composer.output)?.[1] ?? 'unknown';
  return `PHP ${version}, Composer ${composerVersion}`;
}

// 2. Build the app

async function buildApp(tmp: string): Promise<string> {
  step('2. Build the app');
  const app = path.join(tmp, 'app');
  await must('composer create-project laravel/laravel:^13.0', 'composer', ['create-project', 'laravel/laravel', app, '^13.0', '--prefer-dist', '--no-progress'], tmp, COMPOSER_TIMEOUT_MS);
  await must('composer require filament/filament:^5.0', 'composer', ['require', 'filament/filament:^5.0', '--no-progress', '-W'], app, COMPOSER_TIMEOUT_MS);
  await must('composer require --dev laravel/boost', 'composer', ['require', '--dev', 'laravel/boost', '--no-progress', '-W'], app, COMPOSER_TIMEOUT_MS);
  if (await exists(path.join(app, 'vendor', 'pestphp', 'pest'))) {
    pass('the skeleton ships Pest');
  } else {
    await must('composer require --dev pestphp/pest pestphp/pest-plugin-laravel', 'composer', ['require', '--dev', 'pestphp/pest', 'pestphp/pest-plugin-laravel', '--no-progress', '-W'], app, COMPOSER_TIMEOUT_MS);
  }
  if (!(await exists(path.join(app, 'tests', 'Pest.php')))) {
    await fs.writeFile(path.join(app, 'tests', 'Pest.php'), "<?php\n\npest()->extend(Tests\\TestCase::class)->in('Feature');\n");
  }
  // A clone has no .env and no database: the workspace hook creates both.
  await fs.rm(path.join(app, '.env'), { force: true });
  await fs.rm(path.join(app, 'database', 'database.sqlite'), { force: true });

  const origin = path.join(tmp, 'origin.git');
  await must('git init', 'git', ['init', '-q', '-b', 'main'], app);
  await must('git add', 'git', ['add', '-A'], app);
  await must('initial commit', 'git', ['commit', '-q', '-m', 'Laravel smoke app'], app);
  await must('bare origin remote', 'git', ['init', '-q', '--bare', '-b', 'main', origin], tmp);
  await must('git remote add origin', 'git', ['remote', 'add', 'origin', origin], app);
  await must('git push -u origin main', 'git', ['push', '-q', '-u', 'origin', 'main'], app);
  await must('origin/HEAD set', 'git', ['remote', 'set-head', 'origin', '-a'], app);
  return app;
}

// 3. Workspace hook

async function workspaceHook(app: string): Promise<void> {
  step('3. Workspace hook (hooks/laravel-env.sh)');
  const hook = await run('bash', [path.join(ROOT, 'hooks', 'laravel-env.sh')], app, STEP_TIMEOUT_MS, { ...baseEnv(), SYMPHONY_WORKSPACE: app });
  assert(hook.ok && hook.output.includes('laravel-env: prepared'), 'hooks/laravel-env.sh prepared the app', hook.output);
  const env = await fs.readFile(path.join(app, '.env'), 'utf8');
  const sqlite = path.join(app, 'database', 'symphony.sqlite');
  for (const line of ['DB_CONNECTION=sqlite', `DB_DATABASE=${sqlite}`, 'APP_ENV=local']) {
    assert(env.split('\n').includes(line), `.env contains ${line}`);
  }
  assert(/^APP_KEY=base64:.+/m.test(env), '.env has an APP_KEY');
  assert(await exists(sqlite), 'the SQLite database exists');
  await must('php artisan about', 'php', ['artisan', 'about', '--no-ansi'], app);
  const status = await git(app, ['status', '--porcelain', '--untracked-files=all']);
  assert(status === '', 'git status is clean after the hook', status);
}

// 4. Boost preparation

interface Prepared {
  server: StdioServer;
  prepared: string;
}

async function boostPreparation(app: string, tmp: string): Promise<Prepared> {
  step('4. Boost preparation (laravel integration prepare)');
  const resolved = laravelIntegration.resolveConfig({}, { workflowDir: tmp, env: process.env, hookTimeoutMs: COMPOSER_TIMEOUT_MS });
  assert(resolved.errors.length === 0, 'default laravel config resolves', resolved.errors.join('\n'));
  const lines: string[] = [];
  const sink: LogSink = { name: 'memory', write: (line) => lines.push(line) };
  const extensions = await laravelIntegration.prepare(resolved.config, {
    workspacePath: app,
    env: baseEnv(),
    logger: Logger.create({ sinks: [sink], level: 'debug' }),
    signal: AbortSignal.timeout(COMPOSER_TIMEOUT_MS),
  });
  const log = lines.join('\n');
  assert(extensions !== null, 'prepare returned session extensions', log);
  assert(await exists(path.join(app, SKILL)), `${SKILL} exists`, log);
  const status = await git(app, ['status', '--porcelain', '--untracked-files=all']);
  assert(status === '', 'generated Boost files are excluded (git status --porcelain is empty)', status);

  const server = extensions.mcpServers['laravel-boost'];
  assert(server !== undefined, 'the laravel-boost MCP server is configured', JSON.stringify(extensions.mcpServers));
  const autoApprove = Array.isArray(server.autoApprove) ? server.autoApprove : [];
  for (const tool of ['application-info', 'database-schema', 'database-query', 'search-docs', 'last-error', 'read-log-entries']) {
    assert(autoApprove.includes(tool), `${tool} is pre-approved`);
  }
  assert(!autoApprove.includes('tinker') && (server.deny ?? []).includes('tinker'), 'tinker is denied and not pre-approved', JSON.stringify(server));
  assert(server.args.at(-1) === 'boost:mcp', 'the server runs artisan boost:mcp', JSON.stringify(server));

  const prepared = lines.find((line) => line.includes('msg=integration_prepared')) ?? '';
  assert(prepared !== '', 'integration_prepared was logged', log);
  assert(/laravel\/framework=v?13\./.test(prepared), 'integration_prepared reports Laravel 13.x', prepared);
  assert(/filament\/filament=v?5\./.test(prepared), 'integration_prepared reports Filament 5.x', prepared);
  assert(/boost=ready/.test(prepared), 'integration_prepared reports Boost status ready', prepared);

  // What the dashboard shows: boost:install really wrote guidelines and skills.
  const report = extensions.reports?.find((entry) => entry.id === 'laravel-boost');
  const part = report?.parts[0];
  const detail = JSON.stringify(report);
  assert(report?.status === 'ready' && part?.status === 'ready', 'the Laravel Boost report is ready', detail);
  assert(part.guidelines !== null && part.guidelines.startsWith('CLAUDE.md'), 'the report names the guidelines from CLAUDE.md', detail);
  assert(part.skills.includes('filament-development'), 'the report lists the filament-development skill', detail);
  assert(part.warnings.length === 0, 'boost:install wrote the guidelines and every skill it reports', detail);
  assert(report.mcpServers.includes('laravel-boost'), 'the report names the laravel-boost MCP server', detail);
  return { server, prepared };
}

// 5. MCP handshake

/** Starts the server, sends initialize and tools/list as newline-delimited JSON-RPC and returns the tool names. */
async function listMcpTools(server: StdioServer, cwd: string): Promise<string[]> {
  const child = spawn(server.command, server.args, { cwd, env: { ...baseEnv(), ...server.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr = tail(stderr + chunk.toString(), 4_000)));
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === '') continue;
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (typeof message.id === 'number') pending.get(message.id)?.(message);
      } catch {
        // Not JSON-RPC (a stray notice); ignore it.
      }
    }
  });
  const exited = new Promise<never>((_, reject) => child.on('close', (code) => reject(new Error(`boost:mcp exited (code ${code}): ${stderr}`))));
  exited.catch(() => {});
  const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const request = (id: number, method: string, params: Record<string, unknown>) => {
    const answer = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve));
    send({ id, method, params });
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`no answer to ${method} within ${MCP_TIMEOUT_MS / 1000}s: ${stderr}`)), MCP_TIMEOUT_MS).unref(),
    );
    return Promise.race([answer, exited, timeout]);
  };
  try {
    const init = await request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'symphony-laravel-smoke', version: '0.1.0' },
    });
    if (init.error !== undefined) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
    send({ method: 'notifications/initialized' });
    const list = await request(2, 'tools/list', {});
    if (list.error !== undefined) throw new Error(`tools/list failed: ${JSON.stringify(list.error)}`);
    const tools = (list.result as { tools?: Array<{ name?: unknown }> } | undefined)?.tools ?? [];
    return tools.map((tool) => String(tool.name));
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
  }
}

async function mcpHandshake(server: StdioServer, app: string): Promise<string[]> {
  step('5. MCP handshake (php artisan boost:mcp)');
  let tools: string[];
  try {
    tools = await listMcpTools(server, app);
  } catch (error) {
    throw new Failure(`MCP handshake failed: ${errorMessage(error)}`);
  }
  pass(`initialize and tools/list answered (${tools.length} tools)`);
  for (const tool of REQUIRED_TOOLS) assert(tools.includes(tool), `tools/list contains ${tool}`, tools.join(', '));
  assert(!tools.includes('tinker'), 'tools/list does not contain tinker (not enabled)', tools.join(', '));
  return tools;
}

// 6. Check script

async function checkScript(app: string): Promise<void> {
  step('6. Check script (checks/laravel.sh)');
  const script = path.join(ROOT, 'checks', 'laravel.sh');
  const green = await run('bash', [script], app);
  assert(green.exitCode === 0, 'checks/laravel.sh exits 0 on the fresh app', green.output);

  await fs.writeFile(path.join(app, 'tests', 'Unit', 'SmokeFailingTest.php'), FAILING_TEST);
  await must('commit a failing Pest test', 'git', ['add', 'tests/Unit/SmokeFailingTest.php'], app);
  await must('git commit', 'git', ['commit', '-q', '-m', 'Add a failing test'], app);
  await must('git push', 'git', ['push', '-q'], app);
  const red = await run('bash', [script], app);
  assert(red.exitCode === 1, 'checks/laravel.sh exits 1 with a failing Pest test', red.output);
  assert(/test failed/.test(red.output) && red.output.includes('SmokeFailingTest'), 'the failure output names the failing test', red.output);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await run('git', args, cwd);
  if (!result.ok) throw new Failure(`git ${args.join(' ')} failed: ${result.output}`);
  return result.output.trim();
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { keep: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false } } });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const started = Date.now();
  let tools: string;
  try {
    step('1. Prerequisites');
    tools = await preflight();
    pass(tools);
  } catch (error) {
    if (error instanceof Skip) {
      console.log(`skipped: ${error.message}`);
      return 0;
    }
    throw error;
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-laravel-smoke-'));
  let app: string | null = null;
  let mcpTools: string[] = [];
  let failure: Error | null = null;
  try {
    app = await buildApp(tmp);
    await workspaceHook(app);
    const { server } = await boostPreparation(app, tmp);
    mcpTools = await mcpHandshake(server, app);
    await checkScript(app);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  const facts = app === null ? null : await readLaravelFacts(app);
  console.log('\nSummary');
  console.log(`  ${tools}`);
  for (const [name, label] of SUMMARY_PACKAGES) console.log(`  ${label.padEnd(9)} ${facts?.packages[name] ?? 'not installed'}`);
  if (mcpTools.length > 0) console.log(`  Boost MCP tools: ${mcpTools.join(', ')}`);
  console.log(`  ${passed.length} assertions passed in ${Math.round((Date.now() - started) / 1000)}s`);
  if (values.keep) console.log(`  kept: ${tmp}`);
  else await fs.rm(tmp, { recursive: true, force: true });

  if (failure !== null) {
    console.log(`\nFAILED: ${failure instanceof Failure ? failure.message : (failure.stack ?? failure.message)}`);
    return 1;
  }
  console.log('\nPASSED');
  return 0;
}

process.exitCode = await main();
