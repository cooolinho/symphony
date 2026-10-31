import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/issue-page.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { ChangeEvents } from '../src/http/events.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { startHttpServer } from '../src/http/server.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { Logger } from '../src/log.ts';
import type { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { until } from './helpers.ts';

function fakeOrchestrator() {
  const listeners = new Set<() => void>();
  const orchestrator = {
    onChange(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    snapshot: () => ({}),
  } as unknown as Orchestrator;
  return { orchestrator, listeners, fire: () => [...listeners].forEach((l) => l()) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function openEvents(port: number, headers: Record<string, string> = {}) {
  const state = { text: '', status: 0, headers: {} as http.IncomingHttpHeaders, ended: false };
  const ready = new Promise<void>((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/v1/events', headers }, (res) => {
      state.status = res.statusCode ?? 0;
      state.headers = res.headers;
      res.setEncoding('utf8');
      res.on('data', (c) => (state.text += c));
      res.on('end', () => (state.ended = true));
      res.on('close', () => (state.ended = true));
      resolve();
    });
    req.on('error', reject);
  });
  return { state, ready, count: () => state.text.split('event: change').length - 1 };
}

describe('GET /api/v1/events', () => {
  const logger = Logger.silent();

  it('streams throttled change events with trailing edge', async () => {
    const { orchestrator, fire } = fakeOrchestrator();
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger });
    try {
      const c = openEvents(server.port);
      await c.ready;
      assert.equal(c.state.status, 200);
      assert.ok(String(c.state.headers['content-type']).startsWith('text/event-stream'));
      assert.ok(String(c.state.headers['cache-control']).includes('no-store'));
      await until(() => c.state.text.includes(': connected'));
      fire();
      fire();
      await until(() => c.count() === 1);
      const data = /event: change\ndata: (.+)\n\n/.exec(c.state.text)?.[1] ?? '';
      assert.ok(Number.isFinite(Date.parse(JSON.parse(data).at)));
      await sleep(250);
      assert.equal(c.count(), 1, 'second change waits for the window');
      await until(() => c.count() === 2, 1500);
      await sleep(700);
      assert.equal(c.count(), 2, 'no further events without changes');
    } finally {
      await server.close();
    }
  });

  it('ends open streams on shutdown without hanging', async () => {
    const { orchestrator, listeners } = fakeOrchestrator();
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger });
    const c = openEvents(server.port);
    await c.ready;
    assert.equal(listeners.size, 1);
    await Promise.race([server.close(), sleep(1000).then(() => assert.fail('close() hung'))]);
    await until(() => c.state.ended);
    assert.equal(listeners.size, 0);
  });

  it('applies the loopback host guard and allows GET only', async () => {
    const { orchestrator } = fakeOrchestrator();
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger });
    try {
      const evil = openEvents(server.port, { host: 'evil.example' });
      await evil.ready;
      assert.equal(evil.state.status, 403);
      assert.ok(evil.state.text.includes('forbidden_host'));
      const post = await new Promise<http.IncomingMessage>((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: server.port, method: 'POST', path: '/api/v1/events' }, resolve);
        req.end();
      });
      assert.equal(post.statusCode, 405);
      assert.equal(post.headers.allow, 'GET');
      post.resume();
    } finally {
      await server.close();
    }
  });
});

describe('ChangeEvents', () => {
  function fakeRes() {
    const handlers: Record<string, () => void> = {};
    const res = {
      chunks: [] as string[],
      writableEnded: false,
      destroyed: false,
      writeHead() {},
      write(c: string) {
        this.chunks.push(c);
        return true;
      },
      end() {
        this.writableEnded = true;
      },
      on(event: string, h: () => void) {
        handlers[event] = h;
      },
    };
    return { res, close: () => handlers.close?.() };
  }

  it('subscribes lazily, pings, and cleans up', async () => {
    const { orchestrator, listeners } = fakeOrchestrator();
    const events = new ChangeEvents(orchestrator, { pingMs: 20, throttleMs: 10 });
    assert.equal(listeners.size, 0);
    const a = fakeRes();
    const b = fakeRes();
    events.open(a.res as never);
    events.open(b.res as never);
    assert.equal(listeners.size, 1);
    await until(() => a.res.chunks.filter((c) => c === ': ping\n\n').length >= 2);
    a.close();
    assert.equal(listeners.size, 1);
    b.close();
    assert.equal(listeners.size, 0);
    assert.equal(events.size, 0);
    const before = b.res.chunks.length;
    await sleep(60);
    assert.equal(b.res.chunks.length, before, 'ping timer stopped');
  });

  it('closeAll ends every stream', () => {
    const { orchestrator, listeners } = fakeOrchestrator();
    const events = new ChangeEvents(orchestrator);
    const a = fakeRes();
    events.open(a.res as never);
    events.closeAll();
    assert.equal(a.res.writableEnded, true);
    assert.equal(listeners.size, 0);
  });
});

type Ctx = Record<string, any>;

function clientContext(extra: Ctx = {}) {
  const intervals: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const timeouts: Array<{ fn: () => void; ms: number }> = [];
  const ctx: Ctx = {
    document: { createElement: () => ({}) },
    setInterval: (fn: () => void, ms: number) => intervals.push({ fn, ms, cleared: false }) - 1,
    clearInterval: (id: number) => {
      if (intervals[id]) intervals[id].cleared = true;
    },
    setTimeout: (fn: () => void, ms: number) => timeouts.push({ fn, ms }) - 1,
    ...extra,
  };
  vm.createContext(ctx);
  vm.runInContext(BASE_JS, ctx);
  const active = () => intervals.filter((i) => !i.cleared).map((i) => i.ms);
  return { ctx, intervals, timeouts, active };
}

describe('live() in BASE_JS', () => {
  class FakeSource {
    static last: FakeSource;
    handlers: Record<string, Array<() => void>> = {};
    readonly url: string;
    constructor(url: string) {
      this.url = url;
      FakeSource.last = this;
    }
    addEventListener(e: string, h: () => void) {
      (this.handlers[e] ??= []).push(h);
    }
    emit(e: string) {
      (this.handlers[e] ?? []).forEach((h) => h());
    }
  }

  it('stretches polling on open, restores it on error and reloads missed changes', () => {
    const live: boolean[] = [];
    const { ctx, active } = clientContext({ EventSource: FakeSource, setLive: (v: boolean) => live.push(v) });
    let calls = 0;
    const poller = ctx.pollEvery(() => {}, 2000);
    ctx.live(() => calls++, poller);
    assert.equal(FakeSource.last.url, '/api/v1/events');
    assert.deepEqual(active(), [2000]);
    FakeSource.last.emit('open');
    assert.deepEqual(active(), [30000]);
    FakeSource.last.emit('change');
    assert.equal(calls, 1);
    FakeSource.last.emit('error');
    assert.deepEqual(active(), [2000]);
    FakeSource.last.emit('open');
    assert.equal(calls, 2, 'catches up after a reconnect');
    assert.deepEqual(live, [true, false, true]);
  });

  it('keeps a slower poller and spaces reloads with gapMs', () => {
    const { ctx, active, timeouts } = clientContext({ EventSource: FakeSource });
    let calls = 0;
    const poller = ctx.pollEvery(() => {}, 60000);
    ctx.live(() => calls++, poller, 10000);
    FakeSource.last.emit('open');
    assert.deepEqual(active(), [60000]);
    FakeSource.last.emit('change');
    FakeSource.last.emit('change');
    assert.equal(calls, 1);
    assert.equal(timeouts.length, 1);
    timeouts[0]!.fn();
    assert.equal(calls, 2);
  });

  it('does nothing without EventSource and polling continues', () => {
    const { ctx, active } = clientContext();
    const poller = ctx.pollEvery(() => {}, 2000);
    assert.equal(ctx.live(() => {}, poller), null);
    assert.deepEqual(active(), [2000]);
  });
});

describe('pages use live()', () => {
  it('wires live() with the polling fallback', () => {
    assert.ok(DASHBOARD_HTML.includes('live(load, pollEvery(load, 2000))'));
    assert.ok(!DASHBOARD_HTML.includes('setInterval(load, 2000)'));
    assert.ok(AGENT_HTML.includes('live(poll, pollEvery(poll, POLL_MS))'));
    assert.ok(LOGS_HTML.includes('live(refreshOpen, pollEvery(refreshOpen, 60000), 10000)'));
  });
});
