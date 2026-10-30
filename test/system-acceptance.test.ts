import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { startHttpServer } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { SystemCollector, type SystemSample } from '../src/system/metrics.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, tempDir } from './helpers.ts';

const METRICS = path.resolve(import.meta.dirname, '../src/system/metrics.ts');
const SERVICE = path.resolve(import.meta.dirname, '../src/service.ts');

function proc(stat: string, meminfo = 'MemTotal: 1000 kB\nMemAvailable: 250 kB\n', loadavg = '3.00 2.00 1.00 1/2 3\n'): string {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'stat'), stat);
  fs.writeFileSync(path.join(dir, 'meminfo'), meminfo);
  fs.writeFileSync(path.join(dir, 'loadavg'), loadavg);
  return dir;
}

function silent() {
  const calls: unknown[][] = [];
  return { calls, logger: { info: (...a: unknown[]) => void calls.push(a) } };
}

function get(port: number, method: string, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function serve(system?: SystemCollector) {
  const orchestrator = new Orchestrator({
    workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
    runner: new FakeRunner(),
    logger: Logger.silent(),
    env: {},
    logDir: null,
    timers: new ManualTimers(),
    createAdapter: () => new FakeTracker(),
  });
  return startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent(), system });
}

describe('system collector acceptance', () => {
  it('derives CPU percent from the delta of two /proc/stat readings (busy = 1 - idle/total)', async () => {
    const dir = proc('cpu  100 0 100 800 0 0 0 0 0 0\n');
    const c = new SystemCollector({ procDir: dir, volumes: [], gpu: false, logger: silent().logger });
    assert.equal((await c.collect()).cpu_percent, null);
    // +10 user, +90 idle -> 10 % busy
    fs.writeFileSync(path.join(dir, 'stat'), 'cpu  110 0 100 890 0 0 0 0 0 0\n');
    assert.equal((await c.collect()).cpu_percent, 10);
    // fully idle interval
    fs.writeFileSync(path.join(dir, 'stat'), 'cpu  110 0 100 990 0 0 0 0 0 0\n');
    assert.equal((await c.collect()).cpu_percent, 0);
    // fully busy interval
    fs.writeFileSync(path.join(dir, 'stat'), 'cpu  210 0 100 990 0 0 0 0 0 0\n');
    assert.equal((await c.collect()).cpu_percent, 100);
  });

  it('computes RAM used as MemTotal - MemAvailable and reads all three load averages', async () => {
    const c = new SystemCollector({ procDir: proc('cpu  1 1 1 1\n'), volumes: [], gpu: false, logger: silent().logger });
    const s = await c.collect();
    assert.deepEqual(s.memory, { used_bytes: 750 * 1024, total_bytes: 1000 * 1024 });
    assert.deepEqual(s.load, { one: 3, five: 2, fifteen: 1 });
    assert.ok(!Number.isNaN(Date.parse(s.at)));
  });

  it('reports a disk entry per volume (state and workspace) matching fs.statfs', async () => {
    const state = tempDir();
    const workspace = tempDir();
    const c = new SystemCollector({
      procDir: proc('cpu  1 1 1 1\n'),
      volumes: [
        { name: 'state', path: state },
        { name: 'workspace', path: workspace },
      ],
      gpu: false,
      logger: silent().logger,
    });
    const s = await c.collect();
    assert.deepEqual(s.disks.map((d) => [d.name, d.path]), [['state', state], ['workspace', workspace]]);
    const st = fs.statfsSync(state);
    const disk = s.disks[0]!;
    assert.equal(disk.total_bytes, Number(st.blocks) * Number(st.bsize));
    assert.ok(disk.used_bytes! >= 0 && disk.used_bytes! <= disk.total_bytes!);
  });

  it('a failing volume only nulls that volume', async () => {
    const good = tempDir();
    const c = new SystemCollector({
      procDir: proc('cpu  1 1 1 1\n'),
      volumes: [
        { name: 'state', path: path.join(good, 'missing') },
        { name: 'workspace', path: good },
      ],
      gpu: false,
      logger: silent().logger,
    });
    const s = await c.collect();
    assert.deepEqual([s.disks[0]!.used_bytes, s.disks[0]!.total_bytes], [null, null]);
    assert.ok(s.disks[1]!.total_bytes! > 0);
    assert.notEqual(s.memory, null);
  });

  it('keeps exactly 360 samples by default, dropping the oldest', async () => {
    let n = 0;
    const c = new SystemCollector({ procDir: proc('cpu  1 1 1 1\n'), volumes: [], gpu: false, logger: silent().logger, now: () => new Date(Date.UTC(2026, 0, 1) + n++ * 10_000) });
    for (let i = 0; i < 365; i += 1) await c.collect();
    const h = c.history();
    assert.equal(h.length, 360);
    assert.equal(h[0]!.at, new Date(Date.UTC(2026, 0, 1) + 5 * 10_000).toISOString());
    assert.equal(h.at(-1)!.at, new Date(Date.UTC(2026, 0, 1) + 364 * 10_000).toISOString());
    assert.deepEqual(h.map((s) => s.at), [...h.map((s) => s.at)].sort());
  });

  it('history() returns a copy; mutating it does not touch the buffer', async () => {
    const c = new SystemCollector({ procDir: proc('cpu  1 1 1 1\n'), volumes: [], gpu: false, logger: silent().logger });
    await c.collect();
    c.history().length = 0;
    assert.equal(c.history().length, 1);
  });

  it('nothing is collected before start()/collect(): current is null, history empty', () => {
    const c = new SystemCollector({ procDir: proc('cpu  1 1 1 1\n'), volumes: [], gpu: false, logger: silent().logger });
    assert.deepEqual(c.snapshot(), { current: null, history: [], gpu: null, cpu_count: os.availableParallelism() });
  });

  it('with an absent /proc prefix every field is null and nothing throws, gpu on or off', async () => {
    for (const gpu of [false, true]) {
      const missing = path.join(tempDir(), 'no-proc');
      const { logger } = silent();
      const c = new SystemCollector({
        procDir: missing,
        volumes: [{ name: 'state', path: missing }],
        gpu,
        logger,
        runNvidiaSmi: async () => {
          throw new Error('not found');
        },
      });
      const s = await c.collect();
      assert.deepEqual({ ...s, at: 'x', disks: [] }, { at: 'x', cpu_percent: null, memory: null, load: null, disks: [], gpu: null });
      assert.deepEqual([s.disks[0]!.used_bytes, s.disks[0]!.total_bytes], [null, null]);
    }
  });

  it('garbage in /proc files yields null, not an exception', async () => {
    const dir = proc('nonsense\n', 'garbage', 'abc def ghi');
    const c = new SystemCollector({ procDir: dir, volumes: [], gpu: false, logger: silent().logger });
    const s = await c.collect();
    assert.equal(s.cpu_percent, null);
    assert.equal(s.memory, null);
    assert.equal(s.load, null);
  });

  it('does not spam logs: many failing ticks log at most a handful of lines in total', async () => {
    const { calls, logger } = silent();
    const missing = path.join(tempDir(), 'x');
    const c = new SystemCollector({ procDir: missing, volumes: [{ name: 'state', path: missing }], gpu: true, logger, runNvidiaSmi: async () => Promise.reject(new Error('ENOENT')) });
    await c.collect();
    const first = calls.length;
    for (let i = 0; i < 20; i += 1) await c.collect();
    assert.equal(calls.length, first);
    assert.ok(first <= 5);
  });

  it('gpu true: calls nvidia-smi with --query-gpu and csv,noheader and reports utilization, memory and temperature', async () => {
    const seen: (readonly string[])[] = [];
    const c = new SystemCollector({
      procDir: proc('cpu  1 1 1 1\n'),
      volumes: [],
      gpu: true,
      logger: silent().logger,
      runNvidiaSmi: async (args) => {
        seen.push(args);
        return '97, 20000, 24576, 72\n';
      },
    });
    const s = await c.collect();
    assert.equal(seen.length, 1);
    const joined = seen[0]!.join(' ');
    assert.match(joined, /--query-gpu=/);
    assert.match(joined, /utilization\.gpu/);
    assert.match(joined, /memory\.used/);
    assert.match(joined, /temperature\.gpu/);
    assert.match(joined, /--format=csv,noheader/);
    assert.deepEqual(s.gpu, { utilization_percent: 97, memory_used_mib: 20000, memory_total_mib: 24576, temperature_c: 72 });
  });

  it('gpu true with a runner that recovers: later ticks pick the value up again', async () => {
    let fail = true;
    const c = new SystemCollector({
      procDir: proc('cpu  1 1 1 1\n'),
      volumes: [],
      gpu: true,
      logger: silent().logger,
      runNvidiaSmi: async () => {
        if (fail) throw new Error('boom');
        return '1, 2, 3, 4\n';
      },
    });
    assert.equal((await c.collect()).gpu, null);
    fail = false;
    assert.equal((await c.collect()).gpu?.temperature_c, 4);
  });

  it('gpu true with unparseable nvidia-smi output yields null without throwing', async () => {
    const c = new SystemCollector({ procDir: proc('cpu  1 1 1 1\n'), volumes: [], gpu: true, logger: silent().logger, runNvidiaSmi: async () => 'NVIDIA-SMI has failed\n' });
    assert.equal((await c.collect()).gpu, null);
  });

  it('gpu false: the runner is never called, not by collect() and not by the timer', async () => {
    let runs = 0;
    const c = new SystemCollector({
      procDir: proc('cpu  1 1 1 1\n'),
      volumes: [],
      gpu: false,
      logger: silent().logger,
      intervalMs: 10,
      runNvidiaSmi: async () => {
        runs += 1;
        return '1, 2, 3, 4';
      },
    });
    c.start();
    await new Promise((r) => setTimeout(r, 80));
    c.stop();
    assert.ok(c.history().length >= 2);
    assert.equal(runs, 0);
    assert.ok(c.history().every((s) => s.gpu === null));
  });

  it('start() collects immediately and stop() halts the timer', async () => {
    const c = new SystemCollector({ procDir: proc('cpu  1 1 1 1\n'), volumes: [], gpu: false, logger: silent().logger, intervalMs: 15 });
    c.start();
    await new Promise((r) => setTimeout(r, 120));
    c.stop();
    await new Promise((r) => setTimeout(r, 40));
    const size = c.history().length;
    assert.ok(size >= 2);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(c.history().length, size);
    c.stop(); // idempotent
  });

  it('the timer is unref: a process that starts the collector and never stops it still exits', () => {
    const script = path.join(tempDir(), 'unref.ts');
    fs.writeFileSync(
      script,
      `import { SystemCollector } from ${JSON.stringify(METRICS)};
const c = new SystemCollector({ volumes: [], gpu: false, logger: { info() {} }, procDir: '/nonexistent', intervalMs: 50 });
c.start();
`,
    );
    const res = spawnSync(process.execPath, [script], { timeout: 10_000, encoding: 'utf8' });
    assert.equal(res.error, undefined, String(res.error));
    assert.equal(res.status, 0, res.stderr);
  });

  it('reads the real /proc of this host when available (two samples, sane ranges)', async (t) => {
    if (!fs.existsSync('/proc/stat') || !fs.existsSync('/proc/meminfo') || !fs.existsSync('/proc/loadavg')) return t.skip('no /proc');
    const c = new SystemCollector({ volumes: [{ name: 'state', path: tempDir() }], gpu: false, logger: silent().logger });
    await c.collect();
    await new Promise((r) => setTimeout(r, 50));
    const s: SystemSample = await c.collect();
    assert.ok(s.cpu_percent === null || (s.cpu_percent >= 0 && s.cpu_percent <= 100));
    assert.ok(s.memory!.total_bytes > 0 && s.memory!.used_bytes <= s.memory!.total_bytes);
    assert.ok(s.load!.one >= 0);
  });
});

describe('system config key', () => {
  const resolve = (front: Record<string, unknown>) => resolveConfig(front, { workflowPath: '/srv/flows/WORKFLOW.md', env: {}, trackerDefaults });
  const base = { tracker: { kind: 'github-project' } };

  it('defaults to false, accepts booleans, rejects non-booleans and does not warn about the section', () => {
    assert.equal(resolve(base).system.gpu, false);
    assert.equal(resolve({ ...base, system: {} }).system.gpu, false);
    assert.equal(resolve({ ...base, system: { gpu: false } }).system.gpu, false);
    const on = resolve({ ...base, system: { gpu: true } });
    assert.equal(on.system.gpu, true);
    assert.deepEqual(on.warnings.filter((w) => /system/i.test(w)), []);
    for (const bad of ['yes', 1, [], {}]) assert.throws(() => resolve({ ...base, system: { gpu: bad } }), /system\.gpu/, JSON.stringify(bad));
  });
});

describe('GET /api/v1/system', () => {
  it('answers 200 JSON { current, history, gpu } with gpu null when the GPU is off, and is not shadowed by the issue route', async () => {
    const system = new SystemCollector({ procDir: proc('cpu  100 0 100 800 0 0 0 0 0 0\n'), volumes: [{ name: 'state', path: tempDir() }], gpu: false, logger: silent().logger });
    await system.collect();
    await system.collect();
    await system.collect();
    const server = await serve(system);
    try {
      const res = await get(server.port, 'GET', '/api/v1/system');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.deepEqual(Object.keys(body).sort(), ['cpu_count', 'current', 'gpu', 'history']);
      assert.equal(body.gpu, null);
      assert.equal(body.history.length, 3);
      assert.deepEqual(body.current, body.history.at(-1));
      assert.equal(body.current.memory.total_bytes, 1000 * 1024);
      assert.equal(body.current.disks[0].name, 'state');
      assert.notEqual(body.error?.code, 'issue_not_found');
    } finally {
      await server.close();
    }
  });

  it('exposes the gpu block at top level when system.gpu is on', async () => {
    const system = new SystemCollector({ procDir: proc('cpu  1 1 1 1\n'), volumes: [], gpu: true, logger: silent().logger, runNvidiaSmi: async () => '50, 100, 200, 60\n' });
    await system.collect();
    const server = await serve(system);
    try {
      const body = JSON.parse((await get(server.port, 'GET', '/api/v1/system')).body);
      const gpu = { utilization_percent: 50, memory_used_mib: 100, memory_total_mib: 200, temperature_c: 60 };
      assert.deepEqual(body.gpu, gpu);
      assert.deepEqual(body.current.gpu, gpu);
    } finally {
      await server.close();
    }
  });

  it('a collector with only nulls still answers 200 with null fields', async () => {
    const missing = path.join(tempDir(), 'none');
    const system = new SystemCollector({ procDir: missing, volumes: [{ name: 'state', path: missing }], gpu: false, logger: silent().logger });
    await system.collect();
    const server = await serve(system);
    try {
      const res = await get(server.port, 'GET', '/api/v1/system');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.current.cpu_percent, null);
      assert.equal(body.current.memory, null);
      assert.equal(body.current.load, null);
      assert.equal(body.gpu, null);
    } finally {
      await server.close();
    }
  });

  it('only allows GET: POST, PUT and DELETE answer 405', async () => {
    const server = await serve();
    try {
      for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await get(server.port, method, '/api/v1/system')).status, 405, method);
    } finally {
      await server.close();
    }
  });
});

describe('service wiring', () => {
  it('creates and stops the collector in runService only, never in dryRun', () => {
    const src = fs.readFileSync(SERVICE, 'utf8');
    const runStart = src.indexOf('export async function runService');
    const dryStart = src.indexOf('export async function dryRun');
    assert.ok(runStart >= 0 && dryStart >= 0);
    const [runBody, dryBody] = runStart < dryStart ? [src.slice(runStart, dryStart), src.slice(dryStart)] : [src.slice(runStart), src.slice(dryStart, runStart)];
    assert.match(runBody, /new SystemCollector\(/);
    assert.match(runBody, /\.start\(\)/);
    assert.match(runBody, /system\.stop\(\)/);
    assert.match(runBody, /gpu:\s*config\.system\.gpu/);
    assert.doesNotMatch(dryBody, /SystemCollector/);
  });
});

describe('documentation', () => {
  it('documents system.gpu in docs/configuration.md', () => {
    const doc = fs.readFileSync(path.resolve(import.meta.dirname, '../docs/configuration.md'), 'utf8');
    assert.match(doc, /^### `system`/m);
    assert.match(doc, /\| `gpu` \| `false` \|/);
  });
});
