import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const root = path.join(import.meta.dirname, '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');
const composeFiles = ['docker-compose.yml', 'docker-compose.local.yml'];

/** Dockerfile with line continuations joined and comments dropped, one instruction per entry. */
function instructions(): string[] {
  const joined = read('Dockerfile').replace(/\\\r?\n/g, ' ');
  return joined.split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).filter((l) => l !== '' && !l.startsWith('#'));
}

/** Body of a service (the lines indented below `    <name>:`), comments dropped. */
function service(file: string, name: string): string {
  const lines = read(file).split('\n');
  const start = lines.indexOf(`    ${name}:`);
  assert.ok(start >= 0, `${file}: service ${name}`);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith('        ')) break;
    if (!line.trim().startsWith('#')) body.push(line);
  }
  return body.join('\n');
}

describe('Dockerfile: CI tooling (Docker CLI, MySQL client)', () => {
  const lines = instructions();

  it('installs php-mysql and the mysql client with the PHP packages', () => {
    const php = lines.find((l) => l.startsWith('RUN ') && /php\$\{PHP_VERSION\}-cli/.test(l));
    assert.ok(php);
    assert.match(php, /"php\$\{PHP_VERSION\}-mysql"/);
    assert.match(php, /\sdefault-mysql-client\s/);
    assert.match(php, /\[client-mariadb\]\\nssl-verify-server-cert = off\\n' > \/etc\/mysql\/mariadb\.conf\.d\/[\w-]+\.cnf/,
      'MariaDB >= 11.4 rejects the self-signed certificate of mysql:8.0');
  });

  it('installs the Docker CLI with the compose and buildx plugins behind WITH_DOCKER_CLI', () => {
    assert.ok(lines.includes('ARG WITH_DOCKER_CLI=true'));
    const run = lines.find((l) => l.startsWith('RUN ') && /docker-ce-cli/.test(l));
    assert.ok(run, 'RUN … docker-ce-cli');
    assert.match(run, /if \[ "\$\{WITH_DOCKER_CLI\}" = "true" \]/);
    for (const pkg of ['docker-ce-cli', 'docker-compose-plugin', 'docker-buildx-plugin']) assert.match(run, new RegExp(`\\s${pkg}(\\s|$)`));
    assert.match(run, /signed-by=\/etc\/apt\/keyrings\/docker\.asc/);
    assert.match(run, /https:\/\/download\.docker\.com\/linux\/debian/);
    assert.doesNotMatch(run, /docker-ce(\s|$)|containerd/, 'client only, no daemon');
    assert.ok(lines.indexOf('ARG WITH_DOCKER_CLI=true') < lines.indexOf(run));
  });

  it('sets no DOCKER_HOST in the image', () => {
    assert.doesNotMatch(lines.filter((l) => l.startsWith('ENV ')).join('\n'), /DOCKER_HOST/);
  });
});

describe('docker compose: profile ci', () => {
  for (const file of composeFiles) {
    describe(file, () => {
      it('puts dind and mysql under profiles: [ci]', () => {
        assert.match(service(file, 'dind'), /^ {8}profiles: \[ci\]$/m);
        assert.match(service(file, 'mysql'), /^ {8}profiles: \[ci\]$/m);
        assert.doesNotMatch(service(file, 'symphony'), /profiles:/, 'symphony starts without the profile');
      });

      it('runs a privileged dind with TLS, reachable as docker on the ci network', () => {
        const dind = service(file, 'dind');
        assert.match(dind, /image: docker:\d+-dind/);
        assert.match(dind, /privileged: true/);
        assert.match(dind, /DOCKER_TLS_CERTDIR: \/certs/);
        assert.match(dind, /networks:\n\s+ci:\n\s+aliases:\n\s+- docker\n/);
        for (const v of ['dind-certs-ca:/certs/ca', 'dind-certs-client:/certs/client', 'dind-data:/var/lib/docker']) {
          assert.match(dind, new RegExp(`- ${v}$`, 'm'));
        }
        assert.match(dind, /test: \["CMD", "docker", "info"\]/);
        assert.match(dind, /mem_limit: 4g/);
      });

      it('mounts the workspaces volume into dind at the same path as in symphony', () => {
        const mount = '- workspaces:/home/symphony/symphony-workspaces';
        assert.ok(service(file, 'symphony').includes(mount));
        assert.ok(service(file, 'dind').includes(mount));
      });

      it('uses the CLI major for the dind image', () => {
        const major = service(file, 'dind').match(/image: docker:(\d+)-dind/)![1];
        assert.match(read('docs/docker.md'), new RegExp(`docker:${major}-dind`));
      });

      it('names mysql symphony-ci-mysql on the ci network, so no other project\'s "mysql" answers', () => {
        assert.match(service(file, 'mysql'), /networks:\n\s+ci:\n\s+aliases:\n\s+- symphony-ci-mysql\n/);
      });

      it('runs mysql 8.0 with the init script and without fail-early interpolation', () => {
        const mysql = service(file, 'mysql');
        assert.match(mysql, /image: mysql:8\.0$/m);
        assert.match(mysql, /MYSQL_ROOT_PASSWORD: \$\{SYMPHONY_CI_MYSQL_ROOT_PASSWORD:-\}/);
        assert.match(mysql, /MYSQL_ROOT_HOST: localhost/);
        assert.match(mysql, /- \.\/docker\/ci\/mysql-init\.sh:\/docker-entrypoint-initdb\.d\/[\w-]+\.sh:ro/);
        assert.match(mysql, /command: \[--skip-log-bin, --innodb-flush-log-at-trx-commit=0, --innodb-doublewrite=0, --innodb-buffer-pool-size=512M\]/);
        assert.match(mysql, /tmpfs:\n\s+- \/var\/lib\/mysql:size=2g,uid=999,gid=999\n/, 'test databases in memory');
        assert.doesNotMatch(read(file), /ci-mysql:\/var\/lib\/mysql/);
        assert.match(mysql, /mysqladmin", "ping"/);
        assert.match(mysql, /mem_limit: 3g/);
        // compose interpolates services of inactive profiles too: a :? here would break every setup without ci.
        assert.doesNotMatch(read(file), /\$\{(SYMPHONY_CI_|SYMPHONY_MYSQL_)\w*:\?/);
      });

      it('lets symphony wait for the sidecars only when they are enabled (required: false)', () => {
        const symphony = service(file, 'symphony');
        for (const name of ['dind', 'mysql']) {
          assert.match(symphony, new RegExp(`depends_on:[\\s\\S]*\\n {12}${name}:\\n {16}condition: service_healthy\\n {16}required: false\\n`));
        }
      });

      it('attaches symphony to ci with the client certs read-only and no DOCKER_HOST', () => {
        const symphony = service(file, 'symphony');
        assert.match(symphony, /networks:\n(\s+- \w+\n)*\s+- ci\n/);
        assert.match(symphony, /- dind-certs-client:\/certs\/client:ro/);
        assert.doesNotMatch(symphony, /DOCKER_HOST|DOCKER_CERT_PATH|DOCKER_TLS_VERIFY/);
      });

      it('pins the ci subnet outside bandenhub\'s 172.30.250.0/24', () => {
        const m = read(file).match(/- subnet: \$\{SYMPHONY_CI_SUBNET:-([\d./]+)\}/);
        assert.ok(m, 'ci network subnet from SYMPHONY_CI_SUBNET');
        assert.doesNotMatch(m[1]!, /^172\.30\./);
      });
    });
  }
});

describe('CI sidecar setup files', () => {
  it('mysql-init.sh creates the user with mysql_native_password for symphony_% only', () => {
    const script = read('docker/ci/mysql-init.sh');
    assert.match(script, /IDENTIFIED WITH mysql_native_password/);
    assert.match(script, /GRANT ALL PRIVILEGES ON \\`symphony\\\\_%\\`\.\*/);
    assert.match(script, /SYMPHONY_MYSQL_USER:\?/);
    assert.match(script, /SYMPHONY_MYSQL_PASSWORD:\?/);
    assert.ok((fs.statSync(path.join(root, 'docker/ci/mysql-init.sh')).mode & 0o111) !== 0, 'executable (otherwise sourced)');
  });

  it('.env.example names every variable of the profile', () => {
    const env = read('.env.example');
    for (const v of ['COMPOSE_PROFILES=ci', 'SYMPHONY_CI_DOCKER_HOST=tcp://docker:2376', 'SYMPHONY_CI_DOCKER_CERT_PATH=/certs/client',
      'SYMPHONY_MYSQL_HOST=symphony-ci-mysql', 'SYMPHONY_MYSQL_PORT=', 'SYMPHONY_MYSQL_USER=', 'SYMPHONY_MYSQL_PASSWORD=',
      'SYMPHONY_CI_MYSQL_ROOT_PASSWORD=', 'SYMPHONY_CI_SUBNET=']) {
      assert.ok(env.includes(`# ${v}`), v);
    }
  });

  it('SECURITY.md and docs/docker.md say that dind is host root and DOCKER_HOST is no boundary', () => {
    for (const file of ['SECURITY.md', 'docs/docker.md']) {
      const doc = read(file);
      assert.match(doc, /root on the host/, file);
      assert.match(doc, /not a security boundary/, file);
    }
  });
});
