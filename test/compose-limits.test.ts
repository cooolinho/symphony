import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const root = path.join(import.meta.dirname, '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');
const composeFiles = ['docker-compose.yml', 'docker-compose.local.yml'];

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

/** Top-level `volumes:` keys of a compose file. */
function topLevelVolumes(file: string): string[] {
  const lines = read(file).split('\n');
  const start = lines.indexOf('volumes:');
  assert.ok(start >= 0, `${file}: top-level volumes`);
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith(' ')) break;
    const match = line.match(/^ {4}([\w-]+):\s*$/);
    if (match) names.push(match[1] as string);
  }
  return names;
}

// Defaults keep the behaviour from before the variables: no CPU limits, symphony without a memory limit,
// dind 4g and mysql 3g. 0 makes compose drop the key (no limit).
const LIMITS: Record<string, { cpus: string; mem: string }> = {
  symphony: { cpus: '${SYMPHONY_CPUS:-0}', mem: '${SYMPHONY_MEM_LIMIT:-0}' },
  dind: { cpus: '${SYMPHONY_DIND_CPUS:-0}', mem: '${SYMPHONY_DIND_MEM_LIMIT:-4g}' },
  mysql: { cpus: '${SYMPHONY_MYSQL_CPUS:-0}', mem: '${SYMPHONY_MYSQL_MEM_LIMIT:-3g}' },
};

for (const file of composeFiles) {
  describe(`${file}: resource limits from .env`, () => {
    for (const [name, { cpus, mem }] of Object.entries(LIMITS)) {
      it(`limits ${name} through ${cpus} and ${mem}`, () => {
        const body = service(file, name);
        assert.ok(body.split('\n').includes(`        cpus: ${cpus}`), `${name}: cpus`);
        assert.ok(body.split('\n').includes(`        mem_limit: ${mem}`), `${name}: mem_limit`);
        assert.equal(body.match(/^ {8}(cpus|mem_limit):/gm)?.length, 2, `${name}: one cpus and one mem_limit`);
      });
    }

    it('keeps npm\'s cache in the volume npm-cache', () => {
      assert.ok(service(file, 'symphony').split('\n').includes('            - npm-cache:/home/symphony/.npm'));
      assert.ok(topLevelVolumes(file).includes('npm-cache'));
    });
  });
}

describe('Dockerfile: npm cache directory', () => {
  it('creates /home/symphony/.npm for symphony, so a new npm-cache volume takes over its owner', () => {
    const joined = read('Dockerfile').replace(/\\\r?\n/g, ' ');
    const install = joined.split('\n').find((l) => /install -d -o symphony -g symphony/.test(l));
    assert.ok(install, 'an install -d for the symphony user');
    assert.match(install, /\s\/home\/symphony\/\.npm(\s|$)/);
  });
});

describe('docs: resource limits', () => {
  it('documents the limit variables and both lock scopes in docs/docker.md', () => {
    const docker = read('docs/docker.md');
    for (const name of ['SYMPHONY_CPUS', 'SYMPHONY_MEM_LIMIT', 'SYMPHONY_DIND_CPUS', 'SYMPHONY_MYSQL_CPUS', 'npm-cache', 'host-all']) {
      assert.ok(docker.includes(name), name);
    }
  });
});
