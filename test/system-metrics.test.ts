import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_CAPACITY,
  DEFAULT_INTERVAL_MS,
  NVIDIA_SMI_ARGS,
  SystemCollector,
  cpuPercent,
  parseCpuTimes,
  parseMeminfo,
  parseNvidiaSmi,
} from '../src/system/metrics.ts';
import { tempDir, until } from './helpers.ts';

function procFixture(stat = 'cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 1 1 1\n'): string {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'stat'), stat);
  fs.writeFileSync(path.join(dir, 'meminfo'), 'MemTotal:        8000000 kB\nMemFree: 1 kB\nMemAvailable:   2000000 kB\n');
  fs.writeFileSync(path.join(dir, 'loadavg'), '0.50 1.25 2.00 1/123 4567\n');
  return dir;
}

function stub() {
  const calls: unknown[][] = [];
  return { calls, logger: { info: (...args: unknown[]) => void calls.push(args) } };
}

describe('system parsers', () => {
  it('counts iowait as idle and guards a zero delta', () => {
    const a = parseCpuTimes('cpu  10 0 10 70 10 0 0 0\n');
    assert.deepEqual(a, { idle: 80, total: 100 });
    assert.equal(cpuPercent(a!, a!), null);
    assert.equal(cpuPercent(a!, { idle: 80, total: 200 }), 100);
  });

  it('needs MemAvailable', () => {
    assert.equal(parseMeminfo('MemTotal: 10 kB\n'), null);
  });

  it('parses nvidia-smi output and [N/A]', () => {
    assert.deepEqual(parseNvidiaSmi('35, 1024, 8192, 61\n'), { utilization_percent: 35, memory_used_mib: 1024, memory_total_mib: 8192, temperature_c: 61 });
    assert.equal(parseNvidiaSmi('[N/A], 1, 2, 3')?.utilization_percent, null);
  });
});

describe('SystemCollector', () => {
  it('defaults to 10 s and 360 samples', () => {
    assert.equal(DEFAULT_INTERVAL_MS, 10_000);
    assert.equal(DEFAULT_CAPACITY, 360);
  });

  it('computes a CPU delta from two samples', async () => {
    const procDir = procFixture();
    const volume = tempDir();
    const collector = new SystemCollector({ procDir, volumes: [{ name: 'state', path: volume }], gpu: false, logger: stub().logger });
    const first = await collector.collect();
    assert.equal(first.cpu_percent, null);
    assert.deepEqual(first.memory, { used_bytes: 6_000_000 * 1024, total_bytes: 8_000_000 * 1024 });
    assert.deepEqual(first.load, { one: 0.5, five: 1.25, fifteen: 2 });
    const disk = first.disks[0]!;
    assert.ok(disk.used_bytes! > 0 && disk.total_bytes! >= disk.used_bytes!);
    fs.writeFileSync(path.join(procDir, 'stat'), 'cpu  150 0 150 900 0 0 0 0 0 0\n');
    assert.equal((await collector.collect()).cpu_percent, 50);
  });

  it('keeps at most `capacity` samples', async () => {
    let n = 0;
    const collector = new SystemCollector({ procDir: procFixture(), volumes: [], gpu: false, logger: stub().logger, capacity: 3, now: () => new Date(1_000_000 + 1000 * n++) });
    for (let i = 0; i < 5; i += 1) await collector.collect();
    const history = collector.history();
    assert.equal(history.length, 3);
    assert.equal(history[0]!.at, new Date(1_002_000).toISOString());
    assert.equal(collector.current(), history[2]);
  });

  it('reports null without /proc, without throwing or log spam', async () => {
    const { calls, logger } = stub();
    const missing = path.join(tempDir(), 'nope');
    const collector = new SystemCollector({ procDir: missing, volumes: [{ name: 'state', path: missing }], gpu: false, logger });
    await assert.doesNotReject(collector.collect());
    const sample = collector.current()!;
    assert.equal(sample.cpu_percent, null);
    assert.equal(sample.memory, null);
    assert.equal(sample.load, null);
    assert.equal(sample.gpu, null);
    assert.deepEqual([sample.disks[0]!.used_bytes, sample.disks[0]!.total_bytes], [null, null]);
    const after = calls.length;
    assert.ok(after > 0);
    for (let i = 0; i < 3; i += 1) await collector.collect();
    assert.equal(calls.length, after);
  });

  it('reports the CPU count: the option, else os.availableParallelism()', async () => {
    const fixed = new SystemCollector({ procDir: procFixture(), volumes: [], gpu: false, logger: stub().logger, cpuCount: 4 });
    assert.equal(fixed.snapshot().cpu_count, 4);
    await fixed.collect();
    assert.equal(fixed.snapshot().cpu_count, 4);
    const host = new SystemCollector({ procDir: procFixture(), volumes: [], gpu: false, logger: stub().logger });
    const count = host.snapshot().cpu_count;
    assert.ok(Number.isInteger(count) && count! > 0, String(count));
  });

  it('reads the GPU only when enabled', async () => {
    let runs = 0;
    const runNvidiaSmi = async (args: readonly string[]) => {
      runs += 1;
      assert.deepEqual(args, NVIDIA_SMI_ARGS);
      return '35, 1024, 8192, 61\n';
    };
    const on = new SystemCollector({ procDir: procFixture(), volumes: [], gpu: true, logger: stub().logger, runNvidiaSmi });
    await on.collect();
    const gpu = { utilization_percent: 35, memory_used_mib: 1024, memory_total_mib: 8192, temperature_c: 61 };
    assert.deepEqual(on.current()!.gpu, gpu);
    assert.deepEqual(on.snapshot().gpu, gpu);

    runs = 0;
    const off = new SystemCollector({ procDir: procFixture(), volumes: [], gpu: false, logger: stub().logger, runNvidiaSmi });
    await off.collect();
    await off.collect();
    assert.equal(runs, 0);
    assert.equal(off.snapshot().gpu, null);
  });

  it('survives a missing nvidia-smi and logs once', async () => {
    const { calls, logger } = stub();
    const runNvidiaSmi = async () => {
      throw Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' });
    };
    const collector = new SystemCollector({ procDir: procFixture(), volumes: [], gpu: true, logger, runNvidiaSmi });
    await collector.collect();
    await collector.collect();
    assert.equal(collector.current()!.gpu, null);
    assert.equal(calls.length, 1);
  });

  it('ticks on start and stops on stop', async () => {
    const collector = new SystemCollector({ procDir: procFixture(), volumes: [], gpu: false, logger: stub().logger, intervalMs: 20 });
    collector.start();
    collector.start();
    await until(() => collector.history().length >= 2);
    collector.stop();
    await new Promise((r) => setTimeout(r, 30));
    const size = collector.history().length;
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(collector.history().length, size);
  });
});
