import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { tempDir } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

/** ssh: drops the options, logs the remote command and runs it with the "server" home and FAKE_SIDE=remote. */
const FAKE_SSH = `#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    -O) exit 0 ;;
    *) break ;;
  esac
done
shift
echo "ssh $*" >> "$FAKE_LOG"
cd "$FAKE_REMOTE_HOME"
HOME="$FAKE_REMOTE_HOME" FAKE_SIDE=remote exec bash -c "$*"
`;

/**
 * docker on both sides: logs "<side> docker <args>" and answers from $FAKE_STATE. Vault HEADs live in
 * <side>-head (missing: no vault); copying the brain volume carries the other side's HEAD over.
 */
const FAKE_DOCKER = `#!/usr/bin/env bash
side="$FAKE_SIDE"; [ -n "$side" ] || side=local
echo "$side docker $*" >> "$FAKE_LOG"
args="$*"
st="$FAKE_STATE"
case "$1" in
  inspect)
    case "$args" in
      *working_dir*) echo "$FAKE_REMOTE_WORKDIR" ;;
      *compose.project*) echo symphony ;;
      *Config.Image*) [ -f "$st/no-container" ] && exit 1; echo symphony:local ;;
      *Mounts*symphony-obsidian-1) echo /config=symphony_obsidian-config ;;
      *Mounts*) printf '%s\\n' /home/symphony/brain=symphony_brain /home/symphony/.local/state/symphony=symphony_state \\
        /home/symphony/.local/state/symphony-watchdog=symphony_watchdog-state /certs/client=symphony_dind-certs-client ;;
      *State.Running*) cat "$st/remote-running" 2>/dev/null || echo false ;;
    esac ;;
  network)
    case "$2" in
      ls) [ -f "$st/networks" ] && cut -d' ' -f1 "$st/networks" ;;
      inspect) grep "^\${@: -1} " "$st/networks" | cut -d' ' -f2- ;;
    esac ;;
  ps)
    case "$args" in
      *service=obsidian*) echo symphony-obsidian-1 ;;
      *service=watchdog*) echo symphony-watchdog-1 ;;
    esac ;;
  run)
    case "$args" in
      *package.json*) printf '{\\n  "name": "symphony",\\n  "version": "1.5.1"\\n}\\n' ;;
      *rev-parse*) cat "$st/$side-head" 2>/dev/null || exit 1 ;;
      *merge-base*) exit "$(cat "$st/$side-ancestor" 2>/dev/null || echo 0)" ;;
      *'id -u'*) printf 1000:1000 ;;
      *merge-history*) cat > /dev/null; [ -f "$st/fail-merge" ] && exit 1; exit 0 ;;
      *' -i '*)
        cat > /dev/null
        case "$args" in
          *_brain:/data*) other=local; [ "$side" = local ] && other=remote; cp "$st/$other-head" "$st/$side-head" ;;
        esac ;;
      *'tar czf'*) echo TAR ;;
    esac ;;
esac
exit 0
`;

const SERVER_ENV = [
  'COMPOSE_PROFILES=ci',
  'GITHUB_PROJECT_NUMBER=12',
  'SYMPHONY_BRAIN_ENABLED=true',
  'SYMPHONY_BRAIN_OBSIDIAN_URL=https://brain.docker.lan',
  'COMPOSE_PROJECT_NAME=symphony',
  '',
].join('\n');

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

interface Fixture {
  root: string;
  repo: string;
  bin: string;
  log: string;
  state: string;
  remoteHome: string;
  backups: string;
  worktree: string;
}

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode !== undefined) fs.chmodSync(file, mode);
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

/** A repository with the script at tag v1.5.1, fake ssh/docker, a "server" home and its Compose directory. */
function fixture(options: { remoteHead?: string | null; localHead?: string | null; running?: boolean } = {}): Fixture {
  const root = tempDir('symphony-handover-');
  const repo = path.join(root, 'symphony');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'develop');
  write(path.join(repo, 'scripts/handover.sh'), fs.readFileSync(path.join(ROOT, 'scripts/handover.sh'), 'utf8'), 0o755);
  write(path.join(repo, 'scripts/merge-history.ts'), fs.readFileSync(path.join(ROOT, 'scripts/merge-history.ts'), 'utf8'));
  write(path.join(repo, 'docker-compose.local.yml'), 'services: {}\n');
  write(path.join(repo, 'package.json'), '{\n  "version": "1.5.1"\n}\n');
  write(path.join(repo, '.gitignore'), '.env\nsecrets/\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'v1.5.1');
  git(repo, 'tag', 'v1.5.1');
  write(path.join(repo, '.env'), 'SYMPHONY_REMOTE=me@server\n');
  write(path.join(repo, 'secrets/ssh_key'), 'key', 0o400);

  const bin = path.join(root, 'bin');
  write(path.join(bin, 'ssh'), FAKE_SSH, 0o755);
  write(path.join(bin, 'docker'), FAKE_DOCKER, 0o755);
  const state = path.join(root, 'state');
  fs.mkdirSync(state);
  if (options.remoteHead !== null) fs.writeFileSync(path.join(state, 'remote-head'), options.remoteHead ?? HEAD_A);
  if (options.localHead !== undefined && options.localHead !== null) fs.writeFileSync(path.join(state, 'local-head'), options.localHead);
  fs.writeFileSync(path.join(state, 'remote-running'), options.running === false ? 'false' : 'true');
  const remoteHome = path.join(root, 'server-home');
  write(path.join(root, 'server-compose/.env'), SERVER_ENV);
  write(path.join(root, 'server-compose/secrets/ssh_key'), 'server-key', 0o400);
  fs.mkdirSync(remoteHome);
  const log = path.join(root, 'calls.log');
  fs.writeFileSync(log, '');
  return { root, repo, bin, log, state, remoteHome, backups: path.join(root, 'backups'), worktree: path.join(root, 'symphony-v1.5.1') };
}

function run(f: Fixture, args: string[], env: NodeJS.ProcessEnv = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SYMPHONY_|DOCKER_|FAKE_|COMPOSE_)/.test(key)));
  const result = spawnSync('bash', [path.join(f.repo, 'scripts/handover.sh'), ...args], {
    cwd: f.repo,
    encoding: 'utf8',
    input: '',
    env: {
      ...base,
      PATH: `${f.bin}${path.delimiter}${process.env.PATH}`,
      FAKE_LOG: f.log,
      FAKE_STATE: f.state,
      FAKE_REMOTE_HOME: f.remoteHome,
      FAKE_REMOTE_WORKDIR: path.join(f.root, 'server-compose'),
      SYMPHONY_HANDOVER_BACKUPS: f.backups,
      ...env,
    },
  });
  return { status: result.status, out: result.stdout + result.stderr, calls: fs.readFileSync(f.log, 'utf8').split('\n').filter((line) => line !== '') };
}

/** Index of the first call matching, failing when there is none. */
function at(calls: string[], pattern: RegExp): number {
  const index = calls.findIndex((call) => pattern.test(call));
  assert.notEqual(index, -1, `no call matching ${pattern}:\n${calls.join('\n')}`);
  return index;
}

function inOrder(calls: string[], ...patterns: RegExp[]): void {
  const indices = patterns.map((pattern) => at(calls, pattern));
  assert.deepEqual([...indices].sort((a, b) => a - b), indices, `out of order: ${patterns.join(' < ')}`);
}

const REMOTE_STOP = /^ssh .*docker stop symphony-watchdog-1 symphony symphony-obsidian-1/;
const REMOTE_START = /^ssh docker start /;

describe('scripts/handover.sh', () => {
  it('needs a command and SYMPHONY_REMOTE and rejects unknown arguments', () => {
    const f = fixture();
    assert.equal(run(f, []).status, 1);
    assert.match(run(f, ['pull', '--bogus']).out, /unknown argument: --bogus/);
    assert.match(run(f, ['pull', '--version', '1.5']).out, /--version expects a tag/);
    fs.writeFileSync(path.join(f.repo, '.env'), '');
    assert.match(run(f, ['pull']).out, /SYMPHONY_REMOTE is not set/);
    assert.equal(run(f, ['status'], { SYMPHONY_REMOTE: 'me@server' }).status, 0, 'the shell environment works too');
  });

  it('reports a missing server container', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.state, 'no-container'), '');
    const result = run(f, ['pull', '--yes']);
    assert.equal(result.status, 1);
    assert.match(result.out, /no container named 'symphony'/);
  });

  it('pull --dry-run changes nothing', () => {
    const f = fixture();
    const result = run(f, ['pull', '--dry-run']);
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /Dry run, nothing changed/);
    assert.match(result.out, /stop on the server: symphony-watchdog-1 symphony symphony-obsidian-1/);
    assert.equal(result.calls.some((call) => /docker (stop|start|compose)|-i /.test(call)), false, result.calls.join('\n'));
    assert.equal(fs.existsSync(f.worktree), false);
  });

  it('pull writes SYMPHONY_HANDOVER_CI_SUBNET into the local .env as SYMPHONY_CI_SUBNET', () => {
    const f = fixture();
    const result = run(f, ['pull', '--yes'], { SYMPHONY_HANDOVER_CI_SUBNET: '10.250.0.0/24' });
    assert.equal(result.status, 0, result.out);
    const env = fs.readFileSync(path.join(f.worktree, '.env'), 'utf8');
    assert.deepEqual(env.split('\n').filter((line) => line.startsWith('SYMPHONY_CI_SUBNET=')), ['SYMPHONY_CI_SUBNET=10.250.0.0/24']);
    assert.equal(run(fixture(), ['status'], { SYMPHONY_HANDOVER_CI_SUBNET: 'nope' }).status, 1);
  });

  it('pull moves the ci network to a free subnet when the default overlaps a local Docker network', () => {
    const f = fixture();
    // "<id> <name> <subnets>": the default 172.31.250.0/24 lies in other_net, 10.250.0.0/24 is taken too.
    fs.writeFileSync(path.join(f.state, 'networks'), ['n1 other_net 172.31.0.0/16', 'n2 lan 10.250.0.0/24 fd00::/64', 'n3 symphony_ci 172.31.250.0/24', ''].join('\n'));
    const result = run(f, ['pull', '--yes']);
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /overlaps the Docker network other_net \(172\.31\.0\.0\/16\) here, using 10\.250\.1\.0\/24/);
    const env = fs.readFileSync(path.join(f.worktree, '.env'), 'utf8');
    assert.deepEqual(env.split('\n').filter((line) => line.startsWith('SYMPHONY_CI_SUBNET=')), ['SYMPHONY_CI_SUBNET=10.250.1.0/24']);
  });

  it('pull refuses an explicit SYMPHONY_HANDOVER_CI_SUBNET that overlaps a local Docker network', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.state, 'networks'), 'n1 other_net 172.31.0.0/16\n');
    const result = run(f, ['pull', '--yes'], { SYMPHONY_HANDOVER_CI_SUBNET: '172.31.5.0/24' });
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /overlaps the Docker network other_net/);
    assert.equal(result.calls.some((call) => /docker stop/.test(call)), false, result.calls.join('\n'));
  });

  it('pull sets up the version of the server, stops it, copies the vault, merges the logs and starts here', () => {
    const f = fixture();
    const result = run(f, ['pull', '--yes']);
    assert.equal(result.status, 0, result.out);

    assert.equal(spawnSync('git', ['-C', f.worktree, 'describe', '--tags'], { encoding: 'utf8' }).stdout.trim(), 'v1.5.1');
    // The server's key, not the repository's (a local deploy key cannot clone the server's repositories).
    assert.equal(fs.readFileSync(path.join(f.worktree, 'secrets/ssh_key'), 'utf8'), 'server-key');
    assert.equal(fs.statSync(path.join(f.worktree, 'secrets/ssh_key')).mode & 0o777, 0o400);
    const env = fs.readFileSync(path.join(f.worktree, '.env'), 'utf8');
    assert.match(env, /^GITHUB_PROJECT_NUMBER=12$/m);
    assert.match(env, /^SYMPHONY_BRAIN_ENABLED=true$/m);
    for (const [key, value] of [['COMPOSE_PROFILES', 'ci,brain'], ['SYMPHONY_BRAIN_OBSIDIAN_URL', 'http://127.0.0.1:3000'], ['COMPOSE_PROJECT_NAME', 'symphony']]) {
      assert.deepEqual(env.split('\n').filter((line) => line.startsWith(`${key}=`)), [`${key}=${value}`]);
    }
    assert.equal(fs.statSync(path.join(f.worktree, '.env')).mode & 0o777, 0o600);

    inOrder(
      result.calls,
      /^local docker compose -p symphony -f docker-compose\.local\.yml build/,
      REMOTE_STOP,
      /^local docker compose .* create --force-recreate --remove-orphans/,
      /^local docker run --rm --user 0 -v symphony_brain:\/data:ro --entrypoint tar symphony:local czf/,
      /^local docker run --rm -i --user 0 -v symphony_brain:\/data /,
      /^local docker run --rm -i --user 0 -v symphony_obsidian-config:\/data /,
      /^local docker run --rm -i --user 0 -v symphony_state:\/home\/symphony\/\.local\/state\/symphony -v .*merge-history\.ts:\/merge\/merge-history\.ts:ro/,
      /^local docker run --rm -i --user 0 -v symphony_watchdog-state:\/home\/symphony\/\.local\/state\/symphony-watchdog /,
      /^local docker run .* fsck/,
      /^local docker compose .* up -d/,
    );
    assert.equal(result.calls.some((call) => REMOTE_START.test(call)), false, 'the server stays stopped');
    assert.deepEqual(fs.readFileSync(path.join(f.remoteHome, '.symphony-handover'), 'utf8').trim().split('\n').slice(1), ['symphony-obsidian-1', 'symphony', 'symphony-watchdog-1']);
    for (const kind of ['brain', 'obsidian-config', 'state', 'watchdog-state']) {
      assert.equal(fs.readdirSync(f.backups).filter((name) => new RegExp(`^\\d{8}-\\d{6}-${kind}\\.tgz$`).test(name)).length, 1, kind);
    }
    assert.match(result.out, /Dashboard: http:\/\/127\.0\.0\.1:4000\//);
  });

  it('pull refuses to drop vault commits the server lacks, unless --force', () => {
    const f = fixture({ localHead: HEAD_B });
    fs.writeFileSync(path.join(f.state, 'remote-ancestor'), '1');
    const result = run(f, ['pull', '--yes']);
    assert.equal(result.status, 1);
    assert.match(result.out, /local vault has commits the server lacks/);
    assert.equal(result.calls.some((call) => /docker stop/.test(call)), false);

    assert.equal(run(f, ['pull', '--yes', '--force']).status, 0);
  });

  it('pull gives the board back to the server when the transfer fails', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.state, 'fail-merge'), '');
    const result = run(f, ['pull', '--yes']);
    assert.equal(result.status, 1);
    assert.match(result.out, /merging state failed \(backups in /);
    inOrder(result.calls, REMOTE_STOP, /^ssh docker start symphony-obsidian-1 symphony symphony-watchdog-1 && rm -f/);
    assert.equal(result.calls.some((call) => /compose .* up -d/.test(call)), false);
    assert.equal(fs.existsSync(path.join(f.remoteHome, '.symphony-handover')), false);
  });

  it('push refuses while the server runs', () => {
    const f = fixture();
    assert.equal(run(f, ['pull', '--yes']).status, 0);
    const result = run(f, ['push', '--yes']);
    assert.equal(result.status, 1);
    assert.match(result.out, /runs on me@server: the server is the active instance/);
  });

  it('push stops here, backs up the server, copies the vault, merges the logs and starts the server', () => {
    const f = fixture();
    assert.equal(run(f, ['pull', '--yes']).status, 0);
    fs.writeFileSync(path.join(f.state, 'remote-running'), 'false');
    fs.writeFileSync(path.join(f.state, 'local-head'), HEAD_B);
    fs.writeFileSync(f.log, '');

    const result = run(f, ['push', '--yes']);
    assert.equal(result.status, 0, result.out);
    inOrder(
      result.calls,
      /^local docker compose -p symphony -f docker-compose\.local\.yml stop/,
      /^ssh docker run --rm --user 0 .*-v symphony_brain:\/backup\/brain:ro.* > ~\/symphony-handover-backup-/,
      /^ssh docker run --rm -i --user 0 -v symphony_brain:\/data /,
      /^ssh cat > ~\/\.symphony-handover-merge\.ts/,
      /^ssh docker run --rm -i --user 0 -v symphony_state:\/home\/symphony\/\.local\/state\/symphony -v \$HOME\/\.symphony-handover-merge\.ts/,
      /^ssh docker start symphony-obsidian-1 symphony symphony-watchdog-1 && rm -f ~\/\.symphony-handover/,
      /^ssh rm -f ~\/\.symphony-handover-merge\.ts/,
    );
    assert.equal(fs.readFileSync(path.join(f.state, 'remote-head'), 'utf8'), HEAD_B);
    assert.equal(fs.existsSync(path.join(f.remoteHome, '.symphony-handover')), false);
    assert.equal(fs.existsSync(path.join(f.remoteHome, '.symphony-handover-merge.ts')), false);
    assert.equal(result.calls.some((call) => /compose .* up -d/.test(call)), false, 'the local stack stays stopped');
  });

  it('push refuses to drop vault commits made on the server after the pull', () => {
    const f = fixture({ running: false, localHead: HEAD_B });
    fs.writeFileSync(path.join(f.state, 'local-ancestor'), '1');
    fs.mkdirSync(f.worktree);
    write(path.join(f.worktree, '.env'), '');
    write(path.join(f.worktree, 'docker-compose.local.yml'), '');
    const result = run(f, ['push', '--yes']);
    assert.equal(result.status, 1);
    assert.match(result.out, /server's vault has commits this machine lacks/);
    assert.equal(result.calls.some((call) => /compose .* stop/.test(call)), false);
  });

  it('push starts here again when the transfer fails', () => {
    const f = fixture({ running: false, localHead: HEAD_A });
    fs.mkdirSync(f.worktree);
    write(path.join(f.worktree, '.env'), '');
    write(path.join(f.worktree, 'docker-compose.local.yml'), '');
    fs.writeFileSync(path.join(f.state, 'fail-merge'), '');
    const result = run(f, ['push', '--yes']);
    assert.equal(result.status, 1);
    assert.match(result.out, /merging state failed \(backup: ~\/symphony-handover-backup-/);
    inOrder(result.calls, /compose .* stop/, /compose .* up -d/);
    assert.equal(result.calls.some((call) => REMOTE_START.test(call)), false);
  });

  it('status shows who runs and how the vaults relate', () => {
    const f = fixture({ localHead: HEAD_B });
    const result = run(f, ['status']);
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /version 1\.5\.1/);
    assert.match(result.out, /symphony +running/);
    assert.match(result.out, /Handed over: {2}no/);
    assert.match(result.out, /local is ahead/);
  });
});
