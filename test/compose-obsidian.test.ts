import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

const root = path.join(import.meta.dirname, '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');
const composeFiles = ['docker-compose.yml', 'docker-compose.local.yml'];

interface Service {
  image?: string;
  profiles?: string[];
  restart?: string;
  environment?: Record<string, string>;
  volumes?: string[];
  networks?: string[];
  ports?: string[];
  labels?: string[];
  build?: { args?: Record<string, string> };
}
interface Compose {
  services: Record<string, Service>;
  volumes: Record<string, unknown>;
}

const load = (file: string): Compose => parse(read(file)) as Compose;
const symphony = (file: string): Service => {
  const svc = load(file).services.symphony;
  assert.ok(svc, `${file}: service symphony`);
  return svc;
};
const obsidian = (file: string): Service => {
  const svc = load(file).services.obsidian;
  assert.ok(svc, `${file}: service obsidian`);
  return svc;
};
const label = (svc: Service, key: string): string | undefined =>
  svc.labels?.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1);

describe('compose: obsidian service', () => {
  for (const file of composeFiles) {
    it(`${file}: image, profile, restart, TZ`, () => {
      const svc = obsidian(file);
      assert.match(svc.image ?? '', /^lscr\.io\/linuxserver\/obsidian(:|$)/);
      assert.deepEqual(svc.profiles, ['brain']);
      assert.equal(svc.restart, 'unless-stopped');
      assert.ok(svc.environment?.TZ);
      assert.equal(symphony(file).profiles, undefined);
    });

    it(`${file}: shares the brain volume and has its own config volume`, () => {
      const svc = obsidian(file);
      assert.ok(svc.volumes?.includes('brain:/config/vault'));
      assert.ok(svc.volumes?.includes('obsidian-config:/config'));
      const volumes = Object.keys(load(file).volumes);
      assert.ok(volumes.includes('brain'));
      assert.ok(volumes.includes('obsidian-config'));
    });

    it(`${file}: runs as the same UID/GID as symphony`, () => {
      const svc = obsidian(file);
      const build = symphony(file).build;
      assert.equal(svc.environment?.PUID, '${UID:-1000}');
      assert.equal(svc.environment?.PGID, '${GID:-1000}');
      assert.equal(build?.args?.UID, svc.environment?.PUID);
      assert.equal(build?.args?.GID, svc.environment?.PGID);
    });

    // Compose interpolates every service, active profile or not: ${BRAIN_X:?} would break setups without Brain.
    it(`${file}: does not require BRAIN_* variables`, () => {
      assert.doesNotMatch(read(file), /\$\{BRAIN_\w+:\?/);
    });
  }

  it('docker-compose.yml: Traefik labels, same login as the dashboard, plain HTTP', () => {
    const svc = obsidian('docker-compose.yml');
    for (const l of [
      'traefik.enable=true',
      'traefik.http.routers.obsidian.rule=Host(`${BRAIN_DOMAIN:-}`)',
      'traefik.http.routers.obsidian.entrypoints=${TRAEFIK_ENTRYPOINT:-web}',
      'traefik.http.routers.obsidian.tls=false',
      'traefik.http.services.obsidian.loadbalancer.server.port=3000',
    ]) {
      assert.ok(svc.labels?.includes(l), l);
    }
    const middlewares = label(svc, 'traefik.http.routers.obsidian.middlewares');
    assert.equal(middlewares, label(symphony('docker-compose.yml'), 'traefik.http.routers.symphony.middlewares'));
    assert.match(middlewares ?? '', /symphony-auth/);
    assert.ok(!svc.labels?.some((l) => l.startsWith('traefik.http.middlewares.')));
    assert.ok(svc.networks?.includes('traefik'));
  });

  it('docker-compose.yml: no published ports', () => {
    assert.equal('ports' in obsidian('docker-compose.yml'), false);
  });

  it('docker-compose.local.yml: only on 127.0.0.1, no Traefik', () => {
    const svc = obsidian('docker-compose.local.yml');
    assert.ok(svc.ports && svc.ports.length > 0);
    for (const p of svc.ports) assert.match(p, /^127\.0\.0\.1:.*:3000$/);
    assert.equal(svc.labels, undefined);
    assert.equal(svc.networks, undefined);
  });

  it('.env.example documents BRAIN_DOMAIN and BRAIN_PORT', () => {
    const env = read('.env.example');
    assert.match(env, /^# BRAIN_DOMAIN=\S* +#/m);
    assert.match(env, /^# BRAIN_PORT=\S* +#/m);
    assert.match(env, /profile "brain"/);
  });

  it('docs/docker.md describes the service', () => {
    const doc = read('docs/docker.md');
    assert.match(doc, /^### Obsidian \(profile `brain`\)$/m);
    for (const word of ['obsidian-config', 'BRAIN_DOMAIN', '/config/vault']) assert.ok(doc.includes(word), word);
  });
});
