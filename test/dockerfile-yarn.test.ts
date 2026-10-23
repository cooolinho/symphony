import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const root = path.join(import.meta.dirname, '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

/** Dockerfile with line continuations joined and comments dropped, one instruction per entry. */
function instructions(): string[] {
  const joined = read('Dockerfile').replace(/\\\r?\n/g, ' ');
  return joined.split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).filter((l) => l !== '' && !l.startsWith('#'));
}

describe('Dockerfile: yarn through pinned Corepack', () => {
  const lines = instructions();
  const index = (re: RegExp): number => lines.findIndex((l) => re.test(l));

  it('pins Corepack and yarn as build args', () => {
    assert.ok(lines.some((l) => /^ARG COREPACK_VERSION=\d+\.\d+\.\d+$/.test(l)), 'COREPACK_VERSION pinned to an exact version');
    assert.ok(lines.includes('ARG YARN_VERSION=1.22.22'));
  });

  it('pins a Corepack release that is at least 0.36.0 (published 2026-08-28)', () => {
    const m = lines.join('\n').match(/^ARG COREPACK_VERSION=(\d+)\.(\d+)\.(\d+)$/m);
    assert.ok(m);
    assert.ok(Number(m[1]) > 0 || Number(m[2]) >= 36);
  });

  it('sets COREPACK_HOME, no download prompt and no default-to-latest', () => {
    const env = lines.filter((l) => l.startsWith('ENV ')).join(' ');
    assert.match(env, /COREPACK_HOME=\/home\/symphony\/\.cache\/corepack(\s|$)/);
    assert.match(env, /COREPACK_ENABLE_DOWNLOAD_PROMPT=0(\s|$)/);
    assert.match(env, /COREPACK_DEFAULT_TO_LATEST=0(\s|$)/);
  });

  it('installs the pinned corepack in its own prefix and enables only the yarn shim', () => {
    const run = lines.find((l) => l.startsWith('RUN ') && /npm install --prefix \/opt\/corepack/.test(l) && /corepack@\$\{COREPACK_VERSION\}/.test(l));
    assert.ok(run, 'RUN npm install --prefix /opt/corepack corepack@${COREPACK_VERSION} (-g collides with pnpm)');
    assert.match(run, /corepack enable --install-directory \/usr\/local\/bin yarn(\s|&|$)/);
    assert.doesNotMatch(lines.join('\n'), /corepack enable(?! --install-directory \/usr\/local\/bin yarn)/, 'a bare `corepack enable` would also shim pnpm');
    assert.doesNotMatch(lines.join('\n'), /corepack enable yarn pnpm|corepack enable pnpm|corepack prepare|corepack use/);
  });

  it('leaves the pinned global pnpm install in place', () => {
    assert.ok(lines.some((l) => /npm install -g .*"pnpm@\$\{PNPM_VERSION\}"/.test(l)));
    assert.ok(index(/pnpm@\$\{PNPM_VERSION\}/) < index(/corepack enable --install-directory \/usr\/local\/bin yarn/), 'corepack is set up after pnpm');
  });

  it('creates COREPACK_HOME owned by symphony', () => {
    const install = lines.find((l) => /install -d/.test(l) && /\/home\/symphony\/\.cache\/corepack/.test(l));
    assert.ok(install, 'COREPACK_HOME is part of an `install -d`');
    assert.match(install, /-o symphony/);
  });

  it('pre-warms yarn@YARN_VERSION as user symphony after the user switch', () => {
    const user = index(/^USER symphony$/);
    const warm = index(/corepack install -g "?yarn@\$\{YARN_VERSION\}"?/);
    assert.ok(user >= 0 && warm > user, 'pre-warm comes after USER symphony');
    assert.ok(warm > index(/corepack enable --install-directory \/usr\/local\/bin yarn/));
    assert.equal(lines.slice(user + 1, warm).some((l) => /^USER /.test(l)), false, 'no switch back to root before pre-warm');
  });

  it('keeps ARGs declared before they are used (build-arg scoping)', () => {
    assert.ok(index(/^ARG YARN_VERSION/) < index(/yarn@\$\{YARN_VERSION\}/));
    assert.ok(index(/^ARG COREPACK_VERSION/) < index(/corepack@\$\{COREPACK_VERSION\}/));
  });
});

describe('yarn documentation', () => {
  it('docs/docker.md has the yarn error row, names the build args and the volume decision', () => {
    const doc = read('docs/docker.md');
    const row = doc.split('\n').find((l) => l.startsWith('|') && l.includes('yarn: command not found'));
    assert.ok(row, 'error table row for `yarn: command not found`');
    assert.match(row, /rebuild/i);
    assert.match(row, /docker compose up -d --build/);
    assert.match(row, /COREPACK_VERSION/);
    assert.match(row, /YARN_VERSION/);
    assert.match(row, /1\.22\.22/);
    assert.match(row, /COREPACK_HOME/);
    assert.match(row, /no volume|has no volume/i);
  });

  it('the documented YARN_VERSION matches the Dockerfile', () => {
    const arg = read('Dockerfile').match(/^ARG YARN_VERSION=(\S+)$/m);
    assert.ok(arg);
    assert.ok(read('docs/docker.md').includes(arg[1]!));
  });

  it('both READMEs mention yarn in the Dockerfile line', () => {
    for (const file of ['README.md', 'README.de.md']) {
      const line = read(file).split('\n').find((l) => /^[│├└ ─]*Dockerfile\s/.test(l));
      assert.ok(line, `${file}: Dockerfile line`);
      assert.match(line, /pnpm, yarn/, file);
    }
  });

  it('adds no compose volume for corepack and no new build args in compose', () => {
    for (const file of ['docker-compose.yml', 'docker-compose.local.yml']) {
      assert.doesNotMatch(read(file), /corepack/i, file);
    }
  });
});
