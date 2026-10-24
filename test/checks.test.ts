import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { tempDir } from './helpers.ts';

const SCRIPT = path.resolve('checks/laravel.sh');

/** Fake php: `-l` fails for files containing SYNTAX_ERROR, `artisan test` fails with FAKE_TEST_FAIL. */
const FAKE_PHP = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(['php', ...args]) + '\\n');
if (args[0] === '-l') {
  if (fs.readFileSync(args[1], 'utf8').includes('SYNTAX_ERROR')) { console.log('Parse error in ' + args[1]); process.exit(255); }
  process.exit(0);
}
if (args[1] === 'test' && process.env.FAKE_ENV_LOG) fs.appendFileSync(process.env.FAKE_ENV_LOG, JSON.stringify([process.env.DB_CONNECTION, process.env.DB_DATABASE, process.env.DB_USERNAME, process.env.DB_PASSWORD]) + '\\n');
if (args[1] === 'test' && process.env.FAKE_TEST_FAIL) { console.log('Tests: 1 failed'); process.exit(1); }
`;

/** Fake mysql client: logs its arguments and whether the password came in MYSQL_PWD; FAKE_MYSQL_FAIL makes it fail. */
const FAKE_MYSQL = `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(['mysql', ...process.argv.slice(2), 'pwd=' + (process.env.MYSQL_PWD || '')]) + '\\n');
if (process.env.FAKE_MYSQL_FAIL) { console.log('ERROR 1045 (28000): Access denied'); process.exit(1); }
`;

/**
 * Fake composer: lists the scripts of composer.json like Composer 2 (heading on stderr, one indented line per script
 * on stdout, unknown options rejected); running one logs it and fails with FAKE_FAIL=<name>.
 */
const FAKE_COMPOSER = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(['composer', ...args]) + '\\n');
const scripts = JSON.parse(fs.readFileSync('composer.json', 'utf8')).scripts || {};
if (args[0] === 'run-script' && args[1] === '--list') {
  const unknown = args.slice(2).find((arg) => arg !== '--no-ansi');
  if (unknown !== undefined) { console.error('The "' + unknown + '" option does not exist.'); process.exit(1); }
  console.error('scripts:');
  for (const name of Object.keys(scripts)) console.log('  ' + name + '  Runs the ' + name + ' script as defined in composer.json');
  process.exit(0);
}
if (process.env.FAKE_FAIL === args[1]) { console.log(args[1] + ' broke'); process.exit(1); }
`;

const FAKE_TOOL = (name: string) => `#!${process.execPath}
require('node:fs').appendFileSync(process.env.FAKE_LOG, JSON.stringify(['${name}', ...process.argv.slice(2)]) + '\\n');
if (process.env.FAKE_FAIL === '${name}') { console.log('${name} broke'); process.exit(1); }
`;

interface Fixture {
  repo: string;
  origin: string;
  log: string;
  bin: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd, encoding: 'utf8' });
}

function write(root: string, name: string, content: string, mode?: number): void {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode === undefined ? undefined : { mode });
}

/** A Laravel-looking app on a pushed feature branch, with fake php/composer and vendor/bin tools. */
function fixture(options: { scripts?: Record<string, string>; phpstan?: boolean; vendor?: boolean; appDir?: string } = {}): Fixture {
  const base = tempDir('symphony-checks-');
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const repo = path.join(base, 'repo');
  const bin = path.join(base, 'bin');
  const app = (name: string) => (options.appDir === undefined ? name : `${options.appDir}/${name}`);
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  write(seed, '.gitignore', 'vendor/\n');
  write(seed, app('artisan'), '<?php');
  write(seed, app('app/Old.php'), '<?php');
  write(seed, app('composer.json'), JSON.stringify({ scripts: options.scripts ?? {} }));
  if (options.phpstan) write(seed, app('phpstan.neon'), 'parameters: {}');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', origin, 'main');
  git(base, 'clone', '-q', origin, repo);
  git(repo, 'checkout', '-q', '-b', 'feature');
  write(repo, app('app/New.php'), '<?php');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'feature');
  git(repo, 'push', '-q', '-u', 'origin', 'feature');

  if (options.vendor !== false) {
    write(repo, app('vendor/autoload.php'), '<?php');
    write(repo, app('vendor/bin/pint'), FAKE_TOOL('pint'), 0o755);
    write(repo, app('vendor/bin/phpstan'), FAKE_TOOL('phpstan'), 0o755);
  }
  write(base, 'bin/php', FAKE_PHP, 0o755);
  write(base, 'bin/composer', FAKE_COMPOSER, 0o755);
  write(base, 'bin/mysql', FAKE_MYSQL, 0o755);
  const log = path.join(base, 'calls.log');
  fs.writeFileSync(log, '');
  return { repo, origin, log, bin };
}

function run(f: Fixture, env: NodeJS.ProcessEnv = {}, cwd = f.repo, args: string[] = [], script = SCRIPT) {
  const result = spawnSync('bash', [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, FAKE_LOG: f.log, ...env },
  });
  return { status: result.status, out: result.stdout + result.stderr };
}

function calls(f: Fixture): string[][] {
  return fs.readFileSync(f.log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

describe('checks/laravel.sh', () => {
  it('passes on a clean, pushed app with passing tools', () => {
    const f = fixture({ phpstan: true });
    const result = run(f);
    assert.equal(result.status, 0, result.out);
    const names = calls(f).map((c) => c.join(' '));
    assert.ok(names.includes('php -l app/New.php'));
    assert.ok(!names.includes('php -l app/Old.php'), 'only changed files are linted');
    assert.ok(names.includes('pint --test app/New.php'));
    assert.ok(names.includes('phpstan analyse --no-progress'));
    assert.ok(names.includes('php artisan test'));
  });

  it('exits 0 with a message when there is no Laravel app', () => {
    const f = fixture();
    fs.rmSync(path.join(f.repo, 'artisan'));
    const result = run(f);
    assert.equal(result.status, 0);
    assert.match(result.out, /no Laravel app; nothing to check/);
  });

  it('honors SYMPHONY_LARAVEL_APP_PATH', () => {
    const f = fixture();
    const result = run(f, { SYMPHONY_LARAVEL_APP_PATH: path.join(f.repo, 'missing') });
    assert.equal(result.status, 2);
    const empty = tempDir('symphony-checks-empty-');
    assert.match(run(f, { SYMPHONY_LARAVEL_APP_PATH: empty }).out, /no Laravel app/);
  });

  it('finds a single app in a first-level subdirectory', () => {
    const f = fixture({ appDir: 'laravel' });
    const result = run(f);
    assert.equal(result.status, 0, result.out);
    const names = calls(f).map((c) => c.join(' '));
    assert.ok(names.includes('php -l app/New.php'), 'changed files are relative to the app');
    assert.ok(names.includes('php artisan test'));
  });

  it('exits 2 when several apps are found and none is configured', () => {
    const f = fixture({ appDir: 'laravel' });
    write(f.repo, 'api/artisan', '<?php');
    write(f.repo, 'api/composer.json', '{}');
    const result = run(f);
    assert.equal(result.status, 2);
    assert.match(result.out, /several Laravel apps/);
    assert.match(result.out, /SYMPHONY_LARAVEL_APP_PATH/);
    assert.equal(run(f, { SYMPHONY_LARAVEL_APP_PATH: path.join(f.repo, 'laravel') }).status, 1, 'configured app wins; api/ is untracked');
  });

  it('never treats vendor/ or node_modules/ as the app', () => {
    const f = fixture();
    fs.rmSync(path.join(f.repo, 'artisan'));
    write(f.repo, 'vendor/artisan', '<?php');
    write(f.repo, 'vendor/composer.json', '{}');
    write(f.repo, 'node_modules/artisan', '<?php');
    write(f.repo, 'node_modules/composer.json', '{}');
    const result = run(f);
    assert.equal(result.status, 0);
    assert.match(result.out, /no Laravel app; nothing to check/);
  });

  it('exits 1 on a dirty tree and lists the changes', () => {
    const f = fixture();
    write(f.repo, 'app/Dirty.php', '<?php');
    const result = run(f);
    assert.equal(result.status, 1);
    assert.match(result.out, /not clean/);
    assert.match(result.out, /app\/Dirty\.php/);
  });

  it('exits 1 on an unpushed commit', () => {
    const f = fixture();
    write(f.repo, 'app/Local.php', '<?php');
    git(f.repo, 'add', '-A');
    git(f.repo, 'commit', '-q', '-m', 'local');
    const result = run(f);
    assert.equal(result.status, 1);
    assert.match(result.out, /push the branch/);
  });

  it('exits 1 when the branch has no upstream', () => {
    const f = fixture();
    git(f.repo, 'checkout', '-q', '-b', 'other');
    const result = run(f);
    assert.equal(result.status, 1);
    assert.match(result.out, /push the branch/);
  });

  it('exits 1 on a php -l failure', () => {
    const f = fixture();
    write(f.repo, 'app/Bad.php', '<?php SYNTAX_ERROR');
    git(f.repo, 'add', '-A');
    git(f.repo, 'commit', '-q', '-m', 'bad');
    git(f.repo, 'push', '-q');
    const result = run(f);
    assert.equal(result.status, 1);
    assert.match(result.out, /syntax errors/);
    assert.match(result.out, /app\/Bad\.php/);
  });

  it('exits 1 with the output of failing tests', () => {
    const f = fixture();
    const result = run(f, { FAKE_TEST_FAIL: '1' });
    assert.equal(result.status, 1);
    assert.match(result.out, /php artisan test failed/);
    assert.match(result.out, /1 failed/);
  });

  it('exits 1 on style and static analysis failures', () => {
    const f = fixture({ phpstan: true });
    assert.equal(run(f, { FAKE_FAIL: 'pint' }).status, 1);
    assert.equal(run(f, { FAKE_FAIL: 'phpstan' }).status, 1);
  });

  it('exits 2 without vendor/', () => {
    const f = fixture({ vendor: false });
    const result = run(f);
    assert.equal(result.status, 2);
    assert.match(result.out, /vendor\//);
  });

  it('exits 2 when git fetch fails', () => {
    const f = fixture();
    fs.rmSync(f.origin, { recursive: true });
    const result = run(f);
    assert.equal(result.status, 2);
    assert.match(result.out, /git fetch/);
  });

  it('exits 2 when phpstan is configured but missing', () => {
    const f = fixture({ phpstan: true });
    fs.rmSync(path.join(f.repo, 'vendor/bin/phpstan'));
    assert.equal(run(f).status, 2);
  });

  it('prefers composer scripts over direct tools', () => {
    const f = fixture({ phpstan: true, scripts: { lint: 'x', analyse: 'x', test: 'x' } });
    const result = run(f);
    assert.equal(result.status, 0, result.out);
    const names = calls(f).map((c) => c.join(' '));
    assert.ok(names.includes('composer run-script lint'));
    assert.ok(names.includes('composer run-script analyse'));
    assert.ok(names.includes('composer run-script test'));
    assert.ok(!names.some((n) => n.startsWith('pint') || n.startsWith('phpstan') || n === 'php artisan test'));
    assert.equal(run(f, { FAKE_FAIL: 'test' }).status, 1);
  });
});

describe('checks/laravel.sh --full', () => {
  const full = (f: Fixture, env: NodeJS.ProcessEnv = {}) => run(f, env, f.repo, ['--full']);

  it('checks the style of every file, then runs the tests (on the app\'s own database without SYMPHONY_CI_DB)', () => {
    const f = fixture({ phpstan: true });
    const result = full(f);
    assert.equal(result.status, 0, result.out);
    const made = calls(f);
    assert.deepEqual(made.find((call) => call[0] === 'pint'), ['pint', '--test']);
    assert.ok(made.some((call) => call[0] === 'phpstan'));
    assert.ok(made.some((call) => call[0] === 'php' && call[2] === 'test'));
    assert.equal(made.some((call) => call[0] === 'mysql' || call[2] === 'migrate'), false);
  });

  it('skips (exit 78) without a Laravel app', () => {
    const f = fixture();
    const empty = tempDir('symphony-no-app-');
    const result = run(f, {}, empty, ['--full']);
    assert.equal(result.status, 78, result.out);
    assert.match(result.out, /no Laravel app/);
  });

  it('with SYMPHONY_CI_DB=mysql: creates a database of its own, migrates, tests against it and drops it', () => {
    const f = fixture();
    const envLog = path.join(path.dirname(f.log), 'env.log');
    const result = full(f, {
      SYMPHONY_CI_DB: 'mysql',
      SYMPHONY_MYSQL_HOST: 'mysql',
      SYMPHONY_MYSQL_USER: 'symphony',
      SYMPHONY_MYSQL_PASSWORD: 's3cret',
      SYMPHONY_WORKSPACE_KEY: 'acme_app_7-abc',
      FAKE_ENV_LOG: envLog,
    });
    assert.equal(result.status, 0, result.out);
    const db = `symphony_${execFileSync('sh', ['-c', "printf %s acme_app_7-abc | sha256sum | cut -c1-12"], { encoding: 'utf8' }).trim()}_ci`;
    assert.match(result.out, new RegExp(`tests against MySQL database ${db}`));
    const made = calls(f);
    const mysql = made.filter((call) => call[0] === 'mysql');
    assert.deepEqual(mysql[0], ['mysql', '--host=mysql', '--port=3306', '--user=symphony', `--execute=DROP DATABASE IF EXISTS \`${db}\`; CREATE DATABASE \`${db}\``, 'pwd=s3cret']);
    assert.equal(mysql[mysql.length - 1]?.[4], `--execute=DROP DATABASE IF EXISTS \`${db}\``, 'dropped at the end');
    const order = made.filter((call) => call[0] === 'php').map((call) => call[2]);
    assert.deepEqual(order.slice(-3), ['config:clear', 'migrate', 'test']);
    assert.deepEqual(JSON.parse(fs.readFileSync(envLog, 'utf8').trim()), ['mysql', db, 'symphony', 's3cret']);
    assert.equal(result.out.includes('s3cret'), false, 'the password never shows up in the output');
  });

  it('drops the database after failing tests too, and exits 2 when MySQL is not usable', () => {
    const f = fixture();
    const env = { SYMPHONY_CI_DB: 'mysql', SYMPHONY_MYSQL_USER: 'symphony', SYMPHONY_WORKSPACE_KEY: 'k' };
    const failing = full(f, { ...env, FAKE_TEST_FAIL: '1' });
    assert.equal(failing.status, 1, failing.out);
    const mysql = calls(f).filter((call) => call[0] === 'mysql');
    assert.match(String(mysql[mysql.length - 1]?.[4]), /^--execute=DROP DATABASE IF EXISTS `symphony_[0-9a-f]{12}_ci`$/);

    assert.equal(full(fixture(), { SYMPHONY_CI_DB: 'mysql' }).status, 2);
    const denied = full(fixture(), { ...env, FAKE_MYSQL_FAIL: '1' });
    assert.equal(denied.status, 2);
    assert.match(denied.out, /environment: cannot create the MySQL database symphony_[0-9a-f]{12}_ci .*Access denied/);
  });
});

describe('checks/repo.sh', () => {
  const REPO_SCRIPT = path.resolve('checks/repo.sh');
  /** The fixture with `.symphony/checks/<name>.sh` on main (the base branch), optionally changed on the feature branch. */
  function withCheck(name: string, base: string, feature?: string): Fixture {
    const f = fixture();
    const seed = path.join(path.dirname(f.repo), 'seed');
    write(seed, `.symphony/checks/${name}.sh`, base);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'check');
    git(seed, 'push', '-q', f.origin, 'main');
    git(f.repo, 'fetch', '-q', 'origin');
    git(f.repo, 'merge', '-q', '--no-edit', 'origin/main');
    if (feature !== undefined) {
      write(f.repo, `.symphony/checks/${name}.sh`, feature);
      git(f.repo, 'add', '-A');
      git(f.repo, 'commit', '-q', '-m', 'weaken');
    }
    git(f.repo, 'push', '-q');
    return f;
  }
  const repo = (f: Fixture, args: string[], env: NodeJS.ProcessEnv = {}) => run(f, env, f.repo, args, REPO_SCRIPT);

  it('runs the script of the base branch, not the pull request\'s copy', () => {
    const f = withCheck('prod-smoke', 'echo "base check in $PWD"; exit 1', 'echo weakened; exit 0');
    const result = repo(f, ['prod-smoke']);
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /== prod-smoke: \.symphony\/checks\/prod-smoke\.sh from origin\/main/);
    assert.match(result.out, /base check in /);
    assert.equal(result.out.includes('weakened'), false);
  });

  it('runs the fallback without a repository script, and skips (exit 78) without either', () => {
    const f = fixture();
    const fallback = repo(f, ['ci', '--', 'bash', '-c', 'echo fallback ran; exit 0']);
    assert.equal(fallback.status, 0, fallback.out);
    assert.match(fallback.out, /fallback ran/);
    const skipped = repo(f, ['ci']);
    assert.equal(skipped.status, 78, skipped.out);
    assert.match(skipped.out, /no \.symphony\/checks\/ci\.sh on origin\/main; skipped/);
  });

  it('refuses a dirty tree or unpushed commits before running anything', () => {
    const f = withCheck('ci', 'echo ran; exit 0');
    write(f.repo, 'app/Dirty.php', '<?php');
    const result = repo(f, ['ci']);
    assert.equal(result.status, 1);
    assert.match(result.out, /working tree is not clean/);
    assert.equal(result.out.includes('ran'), false);
  });

  it('maps the CI Docker daemon for the script only, with the address of its published ports', () => {
    const f = withCheck('prod-smoke', 'echo "host=$DOCKER_HOST tls=$DOCKER_TLS_VERIFY certs=$DOCKER_CERT_PATH ip=$SYMPHONY_DOCKER_HOST_IP"');
    const result = repo(f, ['prod-smoke'], { SYMPHONY_CI_DOCKER_HOST: 'tcp://localhost:2376', SYMPHONY_CI_DOCKER_CERT_PATH: '/certs/client' });
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /host=tcp:\/\/localhost:2376 tls=1 certs=\/certs\/client ip=127\.0\.0\.1/);
    const without = repo(f, ['prod-smoke']);
    assert.match(without.out, /host= tls= certs= ip=$/m);
  });

  it('--lock runs one check of a name per repository at a time', async () => {
    const f = withCheck('prod-smoke', 'echo "start $$" >> "$LOCK_LOG"; sleep 0.4; echo "end $$" >> "$LOCK_LOG"');
    const lockLog = path.join(path.dirname(f.log), 'lock.log');
    const env = { ...process.env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, FAKE_LOG: f.log, LOCK_LOG: lockLog, TMPDIR: tempDir('symphony-locks-'), SYMPHONY_ISSUE_REPOSITORY: 'acme/app' };
    const { spawn } = await import('node:child_process');
    const once = () => new Promise<number | null>((resolve) => spawn('bash', [REPO_SCRIPT, '--lock', 'prod-smoke'], { cwd: f.repo, env, stdio: 'ignore' }).on('exit', resolve));
    assert.deepEqual(await Promise.all([once(), once()]), [0, 0]);
    const lines = fs.readFileSync(lockLog, 'utf8').trim().split('\n').map((line) => line.split(' ')[0]);
    assert.deepEqual(lines, ['start', 'end', 'start', 'end']);
  });
});
