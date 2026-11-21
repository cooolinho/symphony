import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadEnvFile } from '../src/util/env.ts';
import { tempDir } from './helpers.ts';

const root = path.join(import.meta.dirname, '..');

/** Tools the installer needs from the system; everything else on the stub PATH is a fake. */
const SYSTEM_TOOLS = ['bash', 'grep', 'head', 'sed', 'tr', 'cut', 'xargs', 'id', 'mktemp', 'date', 'dirname', 'basename', 'uname', 'cat', 'chmod', 'rm', 'mv', 'cp', 'od', 'env', 'sleep', 'hostname', 'sort'];

/** A copy of install.sh and its libraries, so the tests never touch the repository's .env or secrets/. */
function installerCopy(): string {
  const dir = tempDir('symphony-install-');
  fs.copyFileSync(path.join(root, 'install.sh'), path.join(dir, 'install.sh'));
  fs.chmodSync(path.join(dir, 'install.sh'), 0o755);
  fs.cpSync(path.join(root, 'scripts', 'install'), path.join(dir, 'scripts', 'install'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docker'));
  fs.copyFileSync(path.join(root, 'docker', 'ssh_known_hosts'), path.join(dir, 'docker', 'ssh_known_hosts'));
  return dir;
}

/** PATH with symlinks to the real system tools plus fake commands (name → shell script body). */
function stubPath(fakes: Record<string, string>): { bin: string; marker: string } {
  const bin = tempDir('symphony-install-bin-');
  for (const tool of SYSTEM_TOOLS) {
    const which = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
    const target = which.stdout.trim();
    if (which.status === 0 && target.startsWith('/')) fs.symlinkSync(target, path.join(bin, tool));
  }
  const marker = path.join(bin, 'sudo-was-called');
  const all: Record<string, string> = { sudo: `touch '${marker}'; exit 1`, ...fakes };
  for (const [name, body] of Object.entries(all)) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  }
  return { bin, marker };
}

const BASE_FAKES: Record<string, string> = {
  curl: 'echo "curl 8.5.0"',
  git: 'case "$1" in --version) echo "git version 2.43.0";; config) exit 1;; esac',
  jq: 'echo "jq-1.7.1"',
  ssh: 'echo "OpenSSH_9.6p1 Ubuntu" >&2',
  'ssh-keygen': 'exit 0',
};

function osRelease(): string {
  const file = path.join(tempDir('symphony-os-'), 'os-release');
  fs.writeFileSync(file, 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\nPRETTY_NAME="Ubuntu 24.04 LTS"\n');
  return file;
}

function install(dir: string, args: string[], options: { bin: string; input?: string; home?: string }) {
  const home = options.home ?? tempDir('symphony-home-');
  return spawnSync(path.join(options.bin, 'bash'), [path.join(dir, 'install.sh'), '--no-color', ...args], {
    cwd: dir,
    input: options.input ?? '',
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      PATH: options.bin,
      HOME: home,
      LANG: 'C.UTF-8',
      SYMPHONY_INSTALL_OS_RELEASE: osRelease(),
      // Unreachable on purpose: no test talks to GitHub.
      SYMPHONY_INSTALL_GITHUB_API: 'http://127.0.0.1:9',
    },
  });
}

describe('install.sh', () => {
  it('prints the help with the options and rejects unknown ones', () => {
    const dir = installerCopy();
    const { bin } = stubPath(BASE_FAKES);
    const help = install(dir, ['--help'], { bin });
    assert.equal(help.status, 0, help.stderr);
    for (const flag of ['--dry-run', '--mode', '--check', '--wizard', '--env-file']) assert.ok(help.stdout.includes(flag), flag);
    assert.match(help.stdout, /Simulationsmodus/);
    assert.equal(install(dir, ['--bogus'], { bin }).status, 2);
    assert.equal(install(dir, ['--mode', 'cloud'], { bin }).status, 2);
    assert.equal(install(dir, ['--mode', 'docker-local', '--env-file', 'other.env'], { bin }).status, 2);
  });

  it('lists present, missing and outdated requirements and exits with 1 while a required one is missing', () => {
    const dir = installerCopy();
    const { bin } = stubPath({ ...BASE_FAKES, node: 'echo v24.11.0', npm: 'echo 11.0.0' });
    const result = install(dir, ['--check', '--mode', 'native'], { bin });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /git +✔ vorhanden +2\.43\.0 +pflicht/);
    assert.match(result.stdout, /Node\.js ≥ 26 +▲ veraltet +24\.11\.0 +pflicht +\(mindestens 26 nötig\)/);
    assert.match(result.stdout, /GitHub CLI \(gh\) +○ fehlt +– +empfohlen/);
    assert.match(result.stdout, /Claude Code CLI +✘ fehlt/);
    assert.doesNotMatch(result.stdout, /Docker Engine/, 'docker is not relevant for native');
    assert.match(result.stdout, /Es fehlen Pflicht-Requirements: Node\.js ≥ 26 Claude Code CLI/);
  });

  it('passes the check once every required tool is there', () => {
    const dir = installerCopy();
    const { bin } = stubPath({ ...BASE_FAKES, node: 'echo v26.1.0', npm: 'echo 11.6.0', claude: 'echo "2.1.0 (Claude Code)"' });
    const result = install(dir, ['--check', '--mode', 'native'], { bin });
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /Alle Pflicht-Requirements für »Nativ \(npm start\)« sind vorhanden\./);
  });

  it('walks through the Docker setup in the simulation without writing files or calling sudo', () => {
    const dir = installerCopy();
    const { bin, marker } = stubPath({
      ...BASE_FAKES,
      docker: [
        'case "$1 $2" in',
        '  "--version "*) echo "Docker version 29.1.0, build abc";;',
        '  "compose version") echo "2.40.0";;',
        '  "info "*) exit 0;;',
        '  "network ls") printf "bridge\\nhost\\nnone\\n";;',
        '  *) exit 0;;',
        'esac',
      ].join('\n'),
    });
    const answers = [
      '', // keep mode docker-local
      '-', // install nothing
      '', // COMPOSE_PROJECT_NAME
      'acme/app',
      '7',
      '', // board owner = repository owner
      '', // opus
      '', // no base branch
      '', // 3 agents
      '', // port 4000
      '1', // classic token
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'n', // no other token (GitHub unreachable)
      '2', // skip the step
      '1', // OAuth token
      'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz',
      '', // create secrets/ssh_key
      'Symphony Bot',
      'bot@example.com',
      '-', // no optional parts
      'n', // do not start despite the skipped step
    ];
    const result = install(dir, ['--dry-run', '--mode', 'docker-local', '--wizard'], { bin, input: `${answers.join('\n')}\n` });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Docker Compose v2 +✔ vorhanden/);
    assert.match(result.stdout, /\[Simulation\] würde ausführen: ssh-keygen -t ed25519 -f .*secrets\/ssh_key -N ''/);
    assert.match(result.stdout, /CLAUDE_CODE_OAUTH_TOKEN=<gesetzt \(…wxyz\)>/);
    assert.match(result.stdout, /GIT_USER_EMAIL=bot@example\.com/);
    assert.match(result.stdout, /\[Simulation\] würde ausführen: docker compose -f docker-compose\.local\.yml run --rm symphony --dry-run/);
    assert.match(result.stdout, /übersprungen: GitHub-Token/);
    assert.doesNotMatch(result.stdout, /sk-ant-oat01-abcdefghijklmnopqrstuvwxyz|ghp_abcdefghij/, 'secrets never printed');
    assert.ok(!fs.existsSync(path.join(dir, '.env')), 'no .env written');
    assert.ok(!fs.existsSync(path.join(dir, 'secrets')), 'no secrets/ created');
    assert.ok(!fs.existsSync(marker), 'sudo never called');
  });
});

describe('install.sh .env writer', () => {
  function bash(script: string, cwd: string) {
    return spawnSync('bash', ['-c', `set -uo pipefail; source scripts/install/lib/ui.sh; source scripts/install/lib/run.sh; source scripts/install/lib/envfile.sh; ${script}`], {
      cwd,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: tempDir('symphony-home-'), LANG: 'C.UTF-8' },
    });
  }

  it('writes values that Node reads back unchanged, with mode 600, a backup and kept unknown keys', () => {
    const dir = installerCopy();
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, "# old\nGITHUB_REPOSITORY=acme/old\nMY_OWN_SETTING='keep me'\nexport CLAUDE_MODEL=sonnet # inline comment\n");
    const auth = 'admin:$2y$05$abcdefghijklmnopqrstuv/WXYZ0123456789abcdefghijklmno';
    const result = bash(
      [
        `env_load '${file}'`,
        'env_set GITHUB_REPOSITORY "acme/app, acme/web"',
        `env_set SYMPHONY_BASIC_AUTH '${auth}'`,
        'env_set GIT_USER_NAME "Symphony Bot"',
        'env_set_empty TRAEFIK_CERTRESOLVER',
        'env_set CLAUDE_MODEL ""',
        `env_write '${file}'`,
      ].join('; '),
      dir,
    );
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('.env.bak-')), 'backup of the old file');
    const { env } = loadEnvFile(file, {});
    assert.equal(env.GITHUB_REPOSITORY, 'acme/app, acme/web');
    assert.equal(env.SYMPHONY_BASIC_AUTH, auth);
    assert.equal(env.GIT_USER_NAME, 'Symphony Bot');
    assert.equal(env.TRAEFIK_CERTRESOLVER, '');
    assert.equal(env.MY_OWN_SETTING, 'keep me');
    assert.equal(env.CLAUDE_MODEL, undefined);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /# ── Other values \(kept from the previous \.env\) ──\nMY_OWN_SETTING='keep me'/);
    assert.match(text, /SYMPHONY_BASIC_AUTH='admin:\$2y\$05\$/);
  });

  it('masks secrets in the preview and refuses values it cannot quote safely', () => {
    const dir = installerCopy();
    const preview = bash('env_set GITHUB_TOKEN ghp_abcdefghijklmnopqrstuvwxyz1234; env_set GITHUB_PROJECT_NUMBER 7; env_render mask', dir);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /GITHUB_TOKEN=<gesetzt \(…1234\)>/);
    assert.match(preview.stdout, /GITHUB_PROJECT_NUMBER=7/);
    assert.doesNotMatch(preview.stdout, /ghp_abcdef/);
    const bad = bash(`env_set GIT_USER_NAME "it's \\"\\$x\\""; env_render`, dir);
    assert.notEqual(bad.status, 0);
  });
});

describe('install.sh shellcheck', () => {
  const available = spawnSync('bash', ['-c', 'command -v shellcheck'], { encoding: 'utf8' }).status === 0;
  it('has no findings', { skip: available ? false : 'shellcheck not installed (CI runs it)' }, () => {
    const result = spawnSync('shellcheck', ['-x', 'install.sh'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout);
  });
});
