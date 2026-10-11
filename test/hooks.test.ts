import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { tempDir } from './helpers.ts';

const script = path.resolve(import.meta.dirname, '../hooks/laravel-env.sh');

const ENV_EXAMPLE = `APP_NAME=Laravel
APP_ENV=production
APP_KEY=
# APP_DEBUG=false
APP_DEBUG=false

DB_CONNECTION=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
# DB_DATABASE=laravel
DB_DATABASE=laravel
DB_USERNAME=root
DB_PASSWORD=secret

CACHE_STORE=database
APP_ENV=staging
`;

const MANAGED = [
  'APP_ENV',
  'APP_DEBUG',
  'APP_KEY',
  'DB_CONNECTION',
  'DB_DATABASE',
  'CACHE_STORE',
  'QUEUE_CONNECTION',
  'MAIL_MAILER',
  'BOOST_BROWSER_LOGS_WATCHER',
];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function repo(): string {
  const dir = fs.realpathSync(tempDir('symphony-hook-'));
  git(dir, 'init', '--quiet');
  return dir;
}

function laravelApp(dir: string, gitignore?: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'artisan'), '#!/usr/bin/env php\n');
  fs.writeFileSync(path.join(dir, '.env.example'), ENV_EXAMPLE);
  if (gitignore !== undefined) fs.writeFileSync(path.join(dir, '.gitignore'), gitignore);
}

function run(workspace: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [script], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, SYMPHONY_WORKSPACE: workspace, ...env },
  });
}

function parse(file: string): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (match) values.set(match[1]!, [...(values.get(match[1]!) ?? []), match[2]!]);
  }
  return values;
}

function assertPrepared(app: string): void {
  const env = parse(path.join(app, '.env'));
  for (const key of MANAGED) assert.equal(env.get(key)?.length, 1, `${key} exactly once`);
  assert.equal(env.get('APP_ENV')![0]!, 'local');
  assert.equal(env.get('APP_DEBUG')![0]!, 'true');
  assert.equal(env.get('DB_CONNECTION')![0]!, 'sqlite');
  assert.equal(env.get('CACHE_STORE')![0]!, 'file');
  assert.equal(env.get('QUEUE_CONNECTION')![0]!, 'sync');
  assert.equal(env.get('MAIL_MAILER')![0]!, 'log');
  assert.equal(env.get('BOOST_BROWSER_LOGS_WATCHER')![0]!, 'false');
  const appKey = env.get('APP_KEY')![0]!;
  assert.match(appKey, /^base64:/);
  assert.equal(Buffer.from(appKey.slice('base64:'.length), 'base64').length, 32);
  const database = env.get('DB_DATABASE')![0]!;
  assert.ok(path.isAbsolute(database));
  assert.equal(database, path.join(app, 'database', 'symphony.sqlite'));
  assert.ok(fs.existsSync(database));
  for (const key of ['DB_HOST', 'DB_PORT', 'DB_USERNAME', 'DB_PASSWORD']) assert.equal(env.has(key), false, `${key} commented out`);
  assert.match(fs.readFileSync(path.join(app, '.env'), 'utf8'), /^# DB_HOST=127\.0\.0\.1$/m);
  assert.match(fs.readFileSync(path.join(app, '.env'), 'utf8'), /^APP_NAME=Laravel$/m);
}

describe('hooks/laravel-env.sh', () => {
  it('prepares a Laravel app in the workspace root', () => {
    const dir = repo();
    laravelApp(dir);
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr);
    assertPrepared(dir);
    assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=all').includes('.env\n'), false);
    assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=all').includes('symphony.sqlite'), false);
  });

  it('prepares a one-level app and skips vendor, node_modules and dot-directories', () => {
    const dir = repo();
    laravelApp(path.join(dir, 'laravel'));
    for (const skipped of ['vendor', 'node_modules', '.hidden']) laravelApp(path.join(dir, skipped));
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr);
    assertPrepared(path.join(dir, 'laravel'));
    for (const skipped of ['vendor', 'node_modules', '.hidden']) assert.equal(fs.existsSync(path.join(dir, skipped, '.env')), false);
    const status = git(dir, 'status', '--porcelain', '--untracked-files=all');
    assert.doesNotMatch(status, /\.env$/m);
    assert.doesNotMatch(status, /symphony\.sqlite/);
  });

  it('adds nothing to .git/info/exclude when the app already ignores the files', () => {
    const dir = repo();
    laravelApp(dir, '.env\n*.sqlite\n');
    assert.equal(run(dir).status, 0);
    const exclude = fs.readFileSync(path.join(dir, '.git/info/exclude'), 'utf8');
    assert.doesNotMatch(exclude, /symphony\.sqlite|\/\.env/);
    assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=all').includes('.env\n'), false);
  });

  it('leaves an existing .env byte-identical', () => {
    const dir = repo();
    laravelApp(dir);
    const existing = Buffer.from('APP_KEY=mine\nDB_HOST=db\r\n\x00tail');
    fs.writeFileSync(path.join(dir, '.env'), existing);
    const result = run(dir);
    assert.equal(result.status, 0);
    assert.deepEqual(fs.readFileSync(path.join(dir, '.env')), existing);
    assert.equal(fs.existsSync(path.join(dir, 'database/symphony.sqlite')), false);
  });

  it('does nothing and prints nothing without a Laravel app', () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, '.env.example'), 'A=1\n');
    fs.mkdirSync(path.join(dir, 'src'));
    const before = git(dir, 'status', '--porcelain', '--untracked-files=all');
    const result = run(dir);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=all'), before);
    assert.equal(fs.existsSync(path.join(dir, '.env')), false);
  });

  it('works without SYMPHONY_WORKSPACE by using the current directory', () => {
    const dir = repo();
    laravelApp(dir);
    const result = spawnSync('bash', [script], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, SYMPHONY_WORKSPACE: undefined },
    });
    assert.equal(result.status, 0, result.stderr);
    assertPrepared(dir);
  });

  it('appends missing keys and generates a different APP_KEY per app', () => {
    const dir = repo();
    laravelApp(path.join(dir, 'a'));
    laravelApp(path.join(dir, 'b'));
    fs.writeFileSync(path.join(dir, 'a/.env.example'), 'APP_NAME=Only\n');
    assert.equal(run(dir).status, 0);
    assertPrepared(path.join(dir, 'b'));
    const a = parse(path.join(dir, 'a/.env'));
    for (const key of MANAGED) assert.equal(a.get(key)?.length, 1, key);
    assert.notEqual(a.get('APP_KEY')![0]!, parse(path.join(dir, 'b/.env')).get('APP_KEY')![0]!);
  });
});

const dropScript = path.resolve(import.meta.dirname, '../hooks/laravel-db-drop.sh');
const PASSWORD = 's3cr$t pass"word';
const KEY = 'org_repo_workspace-id-abc123def456';
const NAME = `symphony_${createHash('sha256').update(KEY).digest('hex').slice(0, 12)}`;

/** A fake mysql that logs its arguments (and whether MYSQL_PWD arrived) and can be made to fail. */
function fakeMysql(): { bin: string; log: string } {
  const bin = fs.realpathSync(tempDir('symphony-mysql-'));
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(
    path.join(bin, 'mysql'),
    `#!/usr/bin/env bash
echo "$* [pwd=\${MYSQL_PWD:+set}]" >> "$FAKE_LOG"
[ -z "\${FAKE_MYSQL_FAIL:-}" ]
`,
    { mode: 0o755 },
  );
  return { bin, log };
}

function mysqlEnv(fake: { bin: string; log: string }, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: `${fake.bin}:${process.env.PATH}`,
    FAKE_LOG: fake.log,
    SYMPHONY_LARAVEL_DB: 'mysql',
    SYMPHONY_WORKSPACE_KEY: KEY,
    SYMPHONY_MYSQL_HOST: 'db.internal',
    SYMPHONY_MYSQL_PORT: '3307',
    SYMPHONY_MYSQL_USER: 'symphony',
    SYMPHONY_MYSQL_PASSWORD: PASSWORD,
    ...extra,
  };
}

describe('MySQL variant', () => {
  it('creates both databases and writes .env and .env.testing', () => {
    const dir = repo();
    laravelApp(dir);
    const fake = fakeMysql();
    const result = run(dir, mysqlEnv(fake));
    assert.equal(result.status, 0, result.stderr);

    const calls = fs.readFileSync(fake.log, 'utf8').trim().split('\n');
    assert.equal(calls.length, 2);
    assert.match(calls[0]!, new RegExp(`--host=db.internal --port=3307 --user=symphony --execute=CREATE DATABASE IF NOT EXISTS \`${NAME}\` \\[pwd=set\\]`));
    assert.match(calls[1]!, new RegExp(`CREATE DATABASE IF NOT EXISTS \`${NAME}_test\``));

    const env = parse(path.join(dir, '.env'));
    assert.equal(env.get('DB_CONNECTION')!.join(), 'mysql');
    assert.equal(env.get('DB_DATABASE')!.join(), NAME);
    assert.equal(env.get('DB_HOST')!.join(), 'db.internal');
    assert.equal(env.get('DB_PORT')!.join(), '3307');
    assert.equal(env.get('DB_USERNAME')!.join(), 'symphony');
    assert.equal(env.get('DB_PASSWORD')!.join(), '"s3cr\\$t pass\\"word"');
    assert.equal(env.get('APP_ENV')!.join(), 'local');
    const testing = parse(path.join(dir, '.env.testing'));
    assert.equal(testing.get('DB_DATABASE')!.join(), `${NAME}_test`);
    assert.equal(testing.get('DB_CONNECTION')!.join(), 'mysql');
    assert.equal(testing.get('APP_ENV')!.join(), 'testing');
    assert.equal(fs.existsSync(path.join(dir, 'database/symphony.sqlite')), false);
    assert.equal(fs.statSync(path.join(dir, '.env')).mode & 0o077, 0);
    assert.doesNotMatch(git(dir, 'status', '--porcelain', '--untracked-files=all'), /\.env(\.testing)?$/m);
  });

  it('never prints the password or passes it as an argument', () => {
    const dir = repo();
    laravelApp(dir);
    const fake = fakeMysql();
    const result = run(dir, mysqlEnv(fake));
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!(result.stdout + result.stderr).includes(PASSWORD));
    assert.ok(!fs.readFileSync(fake.log, 'utf8').includes(PASSWORD));
  });

  it('fails with a clear message when CREATE DATABASE fails', () => {
    const dir = repo();
    laravelApp(dir);
    const fake = fakeMysql();
    const result = run(dir, mysqlEnv(fake, { FAKE_MYSQL_FAIL: '1' }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`CREATE DATABASE ${NAME} failed on db.internal:3307`));
    assert.ok(!(result.stdout + result.stderr).includes(PASSWORD));
  });

  it('fails without SYMPHONY_MYSQL_USER', () => {
    const dir = repo();
    laravelApp(dir);
    const result = run(dir, mysqlEnv(fakeMysql(), { SYMPHONY_MYSQL_USER: '' }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SYMPHONY_MYSQL_USER/);
  });

  it('keeps SQLite and never calls mysql without SYMPHONY_LARAVEL_DB=mysql', () => {
    const dir = repo();
    laravelApp(dir);
    const fake = fakeMysql();
    const result = run(dir, mysqlEnv(fake, { SYMPHONY_LARAVEL_DB: '' }));
    assert.equal(result.status, 0, result.stderr);
    assertPrepared(dir);
    assert.equal(fs.existsSync(fake.log), false);
    assert.equal(fs.existsSync(path.join(dir, '.env.testing')), false);
  });
});

describe('hooks/laravel-db-drop.sh', () => {
  const drop = (fake: { bin: string; log: string }, extra: NodeJS.ProcessEnv = {}) =>
    spawnSync('bash', [dropScript], { encoding: 'utf8', env: { ...process.env, ...mysqlEnv(fake, extra) } });

  it('drops both databases without leaking the password', () => {
    const fake = fakeMysql();
    const result = drop(fake);
    assert.equal(result.status, 0, result.stderr);
    const log = fs.readFileSync(fake.log, 'utf8');
    const calls = log.trim().split('\n');
    assert.equal(calls.length, 2);
    assert.match(calls[0]!, new RegExp(`--execute=DROP DATABASE IF EXISTS \`${NAME}\` \\[pwd=set\\]`));
    assert.match(calls[1]!, new RegExp(`DROP DATABASE IF EXISTS \`${NAME}_test\``));
    assert.ok(!(log + result.stdout + result.stderr).includes(PASSWORD));
  });

  it('does nothing without SYMPHONY_LARAVEL_DB=mysql', () => {
    const fake = fakeMysql();
    const result = drop(fake, { SYMPHONY_LARAVEL_DB: '' });
    assert.equal(result.status, 0);
    assert.equal(fs.existsSync(fake.log), false);
  });

  it('fails with a message when mysql fails', () => {
    const result = drop(fakeMysql(), { FAKE_MYSQL_FAIL: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DROP DATABASE/);
  });
});
