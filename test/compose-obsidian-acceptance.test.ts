import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parse } from 'yaml';

// Independent acceptance tests for E8-1 (Obsidian behind Traefik), derived from the issue text.
const root = path.join(import.meta.dirname, '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

type Svc = Record<string, unknown> & {
  image?: string;
  profiles?: string[];
  restart?: string;
  environment?: Record<string, unknown>;
  volumes?: string[];
  labels?: string[];
  ports?: unknown[];
  networks?: string[];
};
const raw = (file: string): { services: Record<string, Svc>; volumes: Record<string, unknown>; networks?: Record<string, unknown> } =>
  parse(read(file));

const hasCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

describe('E8-1 acceptance: raw compose files', () => {
  const prod = raw('docker-compose.yml');
  const obs = prod.services.obsidian as Svc;
  const symphonySvc = prod.services.symphony as Svc;

  it('service obsidian: image, restart, profile brain, TZ, PUID/PGID', () => {
    assert.ok(obs, 'service obsidian missing');
    assert.ok(String(obs.image).startsWith('lscr.io/linuxserver/obsidian'));
    assert.equal(obs.restart, 'unless-stopped');
    assert.deepEqual(obs.profiles, ['brain']);
    assert.ok('TZ' in (obs.environment ?? {}));
    assert.ok('PUID' in (obs.environment ?? {}));
    assert.ok('PGID' in (obs.environment ?? {}));
  });

  it('mounts brain at /config/vault and its own obsidian-config volume at /config', () => {
    assert.ok(obs.volumes?.includes('brain:/config/vault'));
    assert.ok(obs.volumes?.includes('obsidian-config:/config'));
    assert.ok('obsidian-config' in prod.volumes);
    assert.ok('brain' in prod.volumes);
    // the symphony service writes into the same volume
    assert.ok(symphonySvc.volumes?.some((v) => v.startsWith('brain:')));
  });

  it('is not reachable without Traefik: no ports, expose-only/host networking/privileged are absent', () => {
    assert.equal('ports' in obs, false);
    assert.notEqual(obs.network_mode, 'host');
    assert.notEqual(obs.privileged, true);
    assert.deepEqual(obs.networks, ['traefik']);
  });

  it('Traefik labels: router obsidian, host BRAIN_DOMAIN, entrypoint, tls=false, port 3000', () => {
    const labels = obs.labels ?? [];
    const get = (k: string): string | undefined => labels.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1);
    assert.equal(get('traefik.enable'), 'true');
    assert.match(get('traefik.http.routers.obsidian.rule') ?? '', /^Host\(`\$\{BRAIN_DOMAIN(:-)?\}`\)$/);
    assert.equal(get('traefik.http.routers.obsidian.entrypoints'), '${TRAEFIK_ENTRYPOINT:-web}');
    assert.equal(get('traefik.http.routers.obsidian.tls'), 'false');
    assert.equal(get('traefik.http.services.obsidian.loadbalancer.server.port'), '3000');
    assert.equal(get('traefik.http.routers.obsidian.service'), 'obsidian');
    // no certresolver / TLS options on a plain HTTP router
    assert.ok(!labels.some((l) => l.startsWith('traefik.http.routers.obsidian.tls.')));
  });

  it('uses the same auth middleware as the dashboard, and symphony-auth is defined by the dashboard', () => {
    const mw = (s: Svc, router: string): string | undefined =>
      s.labels?.find((l) => l.startsWith(`traefik.http.routers.${router}.middlewares=`))?.split('=')[1];
    assert.equal(mw(obs, 'obsidian'), mw(symphonySvc, 'symphony'));
    assert.match(mw(obs, 'obsidian') ?? '', /symphony-auth/);
    assert.ok(symphonySvc.labels?.some((l) => l.startsWith('traefik.http.middlewares.symphony-auth.basicauth.users=')));
  });

  it('BRAIN_DOMAIN is never required (compose interpolates inactive profiles)', () => {
    for (const f of ['docker-compose.yml', 'docker-compose.local.yml']) assert.doesNotMatch(read(f), /BRAIN_\w+:\?/);
  });

  it('docker-compose.local.yml: obsidian in profile brain, shared brain volume, loopback only, no Traefik', () => {
    const local = raw('docker-compose.local.yml');
    const o = local.services.obsidian as Svc;
    assert.deepEqual(o.profiles, ['brain']);
    assert.ok(o.volumes?.includes('brain:/config/vault'));
    assert.ok('obsidian-config' in local.volumes);
    assert.ok(o.ports?.length);
    for (const p of o.ports ?? []) assert.match(String(p), /^127\.0\.0\.1:/);
    assert.ok(!(o.labels ?? []).some((l) => l.startsWith('traefik.')));
  });

  it('.env.example documents BRAIN_DOMAIN with an explanation', () => {
    const env = read('.env.example');
    const idx = env.search(/^#?\s*BRAIN_DOMAIN=/m);
    assert.ok(idx >= 0, 'BRAIN_DOMAIN missing');
    const line = env.slice(idx).split('\n')[0] ?? '';
    const before = env.slice(0, idx).split('\n').slice(-3).join('\n');
    assert.ok(/#.*\S/.test(line.replace(/^#/, '')) || /#/.test(before), 'no explanation near BRAIN_DOMAIN');
    assert.match(env, /brain/i);
  });

  it('docs/docker.md has an English Obsidian section naming the volume, domain and ports', () => {
    const doc = read('docs/docker.md');
    const m = doc.match(/^#{2,4} .*Obsidian.*$/m);
    assert.ok(m, 'no Obsidian heading');
    const rest = doc.slice(doc.indexOf(m[0]) + m[0].length);
    const section = rest.slice(0, rest.search(/^#{1,3} /m) < 0 ? undefined : rest.search(/^#{1,3} /m));
    for (const w of ['obsidian-config', 'BRAIN_DOMAIN', 'Traefik']) assert.ok(section.includes(w) || doc.includes(w), w);
    assert.match(section, /\b(the|with|only)\b/);
    assert.ok(section.length < 4000, 'section should be short');
  });
});

// Resolve the real compose model with `docker compose config` (no daemon needed).
describe('E8-1 acceptance: resolved compose model', { skip: hasCompose ? false : 'docker compose not available' }, () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-obsidian-'));
    for (const f of ['docker-compose.yml', 'docker-compose.local.yml']) fs.copyFileSync(path.join(root, f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, '.env'), '');
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const config = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync('docker', ['compose', ...args, 'config', '--format', 'json'], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: dir, ...env },
    });
    return { status: r.status, stderr: r.stderr, json: r.status === 0 ? JSON.parse(r.stdout) : undefined };
  };
  const base = { SYMPHONY_BASIC_AUTH: 'admin:x', SYMPHONY_DOMAIN: 'symphony.lan' };

  it('without profile and without BRAIN_DOMAIN the config is valid and obsidian is not started', () => {
    const r = config([], base);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!('obsidian' in r.json.services));
  });

  it('with profile brain and BRAIN_DOMAIN: router host, plain HTTP on web, dashboard middleware, UID 1000, no ports', () => {
    const r = config(['--profile', 'brain'], { ...base, BRAIN_DOMAIN: 'brain.lan' });
    assert.equal(r.status, 0, r.stderr);
    const o = r.json.services.obsidian;
    assert.equal(o.labels['traefik.http.routers.obsidian.rule'], 'Host(`brain.lan`)');
    assert.equal(o.labels['traefik.http.routers.obsidian.entrypoints'], 'web');
    assert.equal(o.labels['traefik.http.routers.obsidian.tls'], 'false');
    assert.equal(o.labels['traefik.http.routers.obsidian.middlewares'], 'symphony-auth');
    assert.equal(o.labels['traefik.http.services.obsidian.loadbalancer.server.port'], '3000');
    assert.equal(String(o.environment.PUID), '1000');
    assert.equal(String(o.environment.PGID), '1000');
    assert.equal(o.ports, undefined);
    const sources = o.volumes.map((v: { source: string; target: string }) => `${v.source}:${v.target}`);
    assert.ok(sources.includes('brain:/config/vault'));
    assert.ok(sources.includes('obsidian-config:/config'));
  });

  it('TRAEFIK_ENTRYPOINT override is honoured; tls stays false', () => {
    const r = config(['--profile', 'brain'], { ...base, BRAIN_DOMAIN: 'b.lan', TRAEFIK_ENTRYPOINT: 'lan' });
    assert.equal(r.json.services.obsidian.labels['traefik.http.routers.obsidian.entrypoints'], 'lan');
    const r2 = config(['--profile', 'brain'], { ...base, BRAIN_DOMAIN: 'b.lan', TRAEFIK_TLS: 'true' });
    assert.equal(r2.json.services.obsidian.labels['traefik.http.routers.obsidian.tls'], 'false');
  });

  it('SYMPHONY_TRAEFIK_MIDDLEWARES replaces the login for obsidian exactly like for the dashboard', () => {
    const r = config(['--profile', 'brain'], { ...base, BRAIN_DOMAIN: 'b.lan', SYMPHONY_TRAEFIK_MIDDLEWARES: 'fwd@file' });
    assert.equal(r.json.services.obsidian.labels['traefik.http.routers.obsidian.middlewares'], 'fwd@file');
    assert.equal(r.json.services.symphony.labels['traefik.http.routers.symphony.middlewares'], 'fwd@file');
  });

  it('Symphony and Obsidian share the UID when UID/GID are overridden', () => {
    const r = config(['--profile', 'brain'], { ...base, UID: '1234', GID: '1235' });
    assert.equal(String(r.json.services.obsidian.environment.PUID), '1234');
    assert.equal(String(r.json.services.obsidian.environment.PGID), '1235');
    assert.equal(String(r.json.services.symphony.build.args.UID), '1234');
  });

  it('local file: valid, loopback port only, no Traefik labels, default UID 1000', () => {
    const r = config(['-f', 'docker-compose.local.yml', '--profile', 'brain']);
    assert.equal(r.status, 0, r.stderr);
    const o = r.json.services.obsidian;
    assert.equal(o.ports.length, 1);
    assert.equal(o.ports[0].host_ip, '127.0.0.1');
    assert.equal(o.ports[0].target, 3000);
    assert.equal(o.labels, undefined);
    assert.equal(String(o.environment.PUID), '1000');
    const off = config(['-f', 'docker-compose.local.yml']);
    assert.equal(off.status, 0, off.stderr);
    assert.ok(!('obsidian' in off.json.services));
  });
});
