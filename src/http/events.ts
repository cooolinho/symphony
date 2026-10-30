import type http from 'node:http';
import type { Orchestrator } from '../orchestrator/orchestrator.ts';

const THROTTLE_MS = 500;
const PING_MS = 25_000;

/**
 * Broadcasts orchestrator changes to every open `GET /api/v1/events` stream as Server-Sent Events. One shared
 * listener (registered while at least one client is connected), one throttle timer and one keepalive timer serve all
 * streams. The throttle sends the first change at once and delivers changes inside the window once after it ends.
 */
export class ChangeEvents {
  readonly #source: Pick<Orchestrator, 'onChange'>;
  readonly #throttleMs: number;
  readonly #pingMs: number;
  readonly #clients = new Set<http.ServerResponse>();
  #unsubscribe: (() => void) | null = null;
  #window: NodeJS.Timeout | null = null;
  #pending = false;
  #ping: NodeJS.Timeout | null = null;

  constructor(source: Pick<Orchestrator, 'onChange'>, options: { throttleMs?: number; pingMs?: number } = {}) {
    this.#source = source;
    this.#throttleMs = options.throttleMs ?? THROTTLE_MS;
    this.#pingMs = options.pingMs ?? PING_MS;
  }

  get size(): number {
    return this.#clients.size;
  }

  /** Starts a stream on `res`; it is removed again when the connection closes. */
  open(res: http.ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    this.#clients.add(res);
    res.on('close', () => this.#remove(res));
    this.#unsubscribe ??= this.#source.onChange(() => this.#changed());
    this.#ping ??= setInterval(() => this.#write(': ping\n\n'), this.#pingMs);
    this.#ping.unref();
  }

  /** Ends every stream and releases the listener and the timers (server shutdown). */
  closeAll(): void {
    const open = [...this.#clients];
    this.#clients.clear();
    this.#idle();
    for (const res of open) res.end();
  }

  #remove(res: http.ServerResponse): void {
    this.#clients.delete(res);
    if (this.#clients.size === 0) this.#idle();
  }

  #idle(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#window !== null) clearTimeout(this.#window);
    this.#window = null;
    this.#pending = false;
    if (this.#ping !== null) clearInterval(this.#ping);
    this.#ping = null;
  }

  #changed(): void {
    if (this.#window !== null) {
      this.#pending = true;
      return;
    }
    this.#broadcast();
  }

  #broadcast(): void {
    this.#write(`event: change\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    this.#window = setTimeout(() => {
      this.#window = null;
      if (!this.#pending) return;
      this.#pending = false;
      this.#broadcast();
    }, this.#throttleMs);
    this.#window.unref();
  }

  #write(chunk: string): void {
    for (const res of this.#clients) {
      if (!res.writableEnded && !res.destroyed) res.write(chunk);
    }
  }
}
