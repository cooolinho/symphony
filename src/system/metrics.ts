import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../log.ts';
import { errorMessage } from '../util/errors.ts';

export const DEFAULT_INTERVAL_MS = 10_000;
/** One hour of history at the default interval. */
export const DEFAULT_CAPACITY = 360;
export const NVIDIA_SMI_ARGS: readonly string[] = ['--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'];

export interface CpuTimes {
  idle: number;
  total: number;
}

export interface DiskSample {
  name: string;
  path: string;
  used_bytes: number | null;
  total_bytes: number | null;
}

export interface GpuSample {
  utilization_percent: number | null;
  memory_used_mib: number | null;
  memory_total_mib: number | null;
  temperature_c: number | null;
}

export interface SystemSample {
  at: string;
  cpu_percent: number | null;
  memory: { used_bytes: number; total_bytes: number } | null;
  load: { one: number; five: number; fifteen: number } | null;
  disks: DiskSample[];
  gpu: GpuSample | null;
}

export interface SystemSnapshot {
  current: SystemSample | null;
  /** Oldest first, including `current`. */
  history: SystemSample[];
  gpu: GpuSample | null;
}

export type NvidiaSmiRunner = (args: readonly string[]) => Promise<string>;
export type SystemSource = Pick<SystemCollector, 'snapshot'>;

/** Aggregate `cpu` line of /proc/stat: total = user..steal, idle = idle + iowait. */
export function parseCpuTimes(text: string): CpuTimes | null {
  const line = text.split('\n').find((l) => /^cpu\s/.test(l));
  if (line === undefined) return null;
  const fields = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (fields.length < 4 || fields.some((n) => !Number.isFinite(n))) return null;
  const total = fields.reduce((a, b) => a + b, 0);
  return { idle: fields[3]! + (fields[4] ?? 0), total };
}

export function cpuPercent(prev: CpuTimes, next: CpuTimes): number | null {
  const dTotal = next.total - prev.total;
  if (dTotal <= 0) return null;
  const pct = (1 - (next.idle - prev.idle) / dTotal) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
}

export function parseMeminfo(text: string): { used_bytes: number; total_bytes: number } | null {
  const kb = (key: string): number | null => {
    const match = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text);
    return match ? Number(match[1]) * 1024 : null;
  };
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  if (total === null || available === null) return null;
  return { used_bytes: Math.max(0, total - available), total_bytes: total };
}

export function parseLoadavg(text: string): { one: number; five: number; fifteen: number } | null {
  const [one, five, fifteen] = text.trim().split(/\s+/).slice(0, 3).map(Number);
  if (one === undefined || five === undefined || fifteen === undefined) return null;
  if (![one, five, fifteen].every(Number.isFinite)) return null;
  return { one, five, fifteen };
}

export function parseNvidiaSmi(text: string): GpuSample | null {
  const line = text.split('\n').find((l) => l.trim() !== '');
  if (line === undefined) return null;
  const parts = line.split(',').map((p) => p.trim());
  if (parts.length < 4) return null;
  const num = (v: string): number | null => (/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null);
  return {
    utilization_percent: num(parts[0]!),
    memory_used_mib: num(parts[1]!),
    memory_total_mib: num(parts[2]!),
    temperature_c: num(parts[3]!),
  };
}

export const defaultNvidiaSmiRunner: NvidiaSmiRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile('nvidia-smi', [...args], { timeout: 5000, encoding: 'utf8' }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

export interface SystemCollectorOptions {
  volumes: ReadonlyArray<{ name: string; path: string }>;
  gpu: boolean;
  logger: Pick<Logger, 'info'>;
  procDir?: string;
  runNvidiaSmi?: NvidiaSmiRunner;
  intervalMs?: number;
  capacity?: number;
  now?: () => Date;
}

/**
 * Samples host CPU, memory, load, disks and optionally the GPU every interval into a ring buffer.
 * Every source catches its own errors and reports `null`; each failing source is logged once.
 */
export class SystemCollector {
  readonly #options: SystemCollectorOptions;
  readonly #samples: SystemSample[] = [];
  readonly #noted = new Set<string>();
  #prevCpu: CpuTimes | null = null;
  #timer: NodeJS.Timeout | null = null;
  #busy = false;

  constructor(options: SystemCollectorOptions) {
    this.#options = options;
  }

  #note(source: string, error: unknown): void {
    if (this.#noted.has(source)) return;
    this.#noted.add(source);
    this.#options.logger.info('system metric unavailable', { source, error: errorMessage(error) });
  }

  async #read<T>(source: string, fn: () => Promise<T | null>): Promise<T | null> {
    try {
      const value = await fn();
      if (value === null) this.#note(source, 'unparseable');
      return value;
    } catch (error) {
      this.#note(source, error);
      return null;
    }
  }

  async collect(): Promise<SystemSample> {
    const procDir = this.#options.procDir ?? '/proc';
    const readProc = (name: string) => fs.promises.readFile(path.join(procDir, name), 'utf8');
    const [cpu, memory, load, disks, gpu] = await Promise.all([
      this.#read('cpu', async () => parseCpuTimes(await readProc('stat'))),
      this.#read('memory', async () => parseMeminfo(await readProc('meminfo'))),
      this.#read('load', async () => parseLoadavg(await readProc('loadavg'))),
      Promise.all(this.#options.volumes.map((volume) => this.#disk(volume))),
      this.#options.gpu
        ? this.#read('gpu', async () => parseNvidiaSmi(await (this.#options.runNvidiaSmi ?? defaultNvidiaSmiRunner)(NVIDIA_SMI_ARGS)))
        : Promise.resolve(null),
    ]);
    const cpuPct = cpu !== null && this.#prevCpu !== null ? cpuPercent(this.#prevCpu, cpu) : null;
    if (cpu !== null) this.#prevCpu = cpu;
    const sample: SystemSample = { at: (this.#options.now?.() ?? new Date()).toISOString(), cpu_percent: cpuPct, memory, load, disks, gpu };
    this.#samples.push(sample);
    while (this.#samples.length > (this.#options.capacity ?? DEFAULT_CAPACITY)) this.#samples.shift();
    return sample;
  }

  async #disk(volume: { name: string; path: string }): Promise<DiskSample> {
    const stats = await this.#read(`disk:${volume.name}`, async () => {
      const s = await fs.promises.statfs(volume.path);
      return { total: Number(s.blocks) * Number(s.bsize), used: (Number(s.blocks) - Number(s.bfree)) * Number(s.bsize) };
    });
    return { name: volume.name, path: volume.path, used_bytes: stats?.used ?? null, total_bytes: stats?.total ?? null };
  }

  start(): void {
    if (this.#timer !== null) return;
    const tick = () => {
      if (this.#busy) return;
      this.#busy = true;
      this.collect().then(
        () => (this.#busy = false),
        () => (this.#busy = false),
      );
    };
    tick();
    this.#timer = setInterval(tick, this.#options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  current(): SystemSample | null {
    return this.#samples.at(-1) ?? null;
  }

  history(): SystemSample[] {
    return [...this.#samples];
  }

  snapshot(): SystemSnapshot {
    const current = this.current();
    return { current, history: this.history(), gpu: current?.gpu ?? null };
  }
}
