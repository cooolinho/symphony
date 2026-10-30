import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { startHttpServer } from '../src/http/server.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { LAYOUT_JS } from '../src/http/ui/layout.ts';
import { Logger } from '../src/log.ts';
import type { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { until } from './helpers.ts';

// Acceptance tests for E1-6 (#351), derived from the issue text: GET /api/v1/events, throttle, keepalive, shutdown,
// host guard, live() in BASE_JS and the pages' polling fallback.

const logger = Logger.silent();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fake() {
  const listeners = new Set<() => void>();
  let subscribed = 0;
  const orchestrator = {
    onChange(l: () => void) {
      subscribed++;
      listeners.add(l);
      return () => listeners.delete(l);
    },
    snapshot: () => ({}),
  } as unknown as Orchestrator;
  return { orchestrator, listeners, subscribed: () => subscribed, fire: () => [...listeners].forEach((l) => l()) };
}

function stream(port: number, headers: Record<string, string> = {}) {
  const s = { text: '', status: 0, headers: {} as http.IncomingHttpHeaders, ended: false, at: [] as number[] };
  let req!: http.ClientRequest;
  const ready = new Promise<void>((resolve, reject) => {
    req = http.get({ host: '127.0.0.1', port, path: '/api/v1/events', headers }, (res) => {
      s.status = res.statusCode ?? 0;
      s.headers = res.headers;
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        s.text += c;
        for (let i = 0; i < c.split('event: change').length - 1; i++) s.at.push(Date.now());
      });
      res.on('close', () => (s.ended = true));
      res.on('end', () => (s.ended = true));
      resolve();
    });
    req.on('error', (e) => (s.ended ? undefined : reject(e)));
  });
  return { s, ready, req, count: () => s.text.split('event: change').length - 1 };
}

describe('E1-6 GET /api/v1/events', () => {
  it('answers text/event-stream and keeps the connection open', async () => {
    const f = fake();
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator: f.orchestrator, logger });
    try {
      const c = stream(server.port);
      await c.ready;
      assert.equal(c.s.status, 200);
      assert.match(String(c.s.headers['content-type']), /^text\/event-stream/);
      await sleep(300);
      assert.equal(c.s.ended, false, 'stream stays open');
      assert.equal(c.count(), 0, 'no event without a change');
      c.req.destroy();
    } finally {
      await server.close();
    }
  });

  it('sends event: change with {"at": <iso>} exactly in SSE framing', async () => {
    const f = fake();
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator: f.orchestrator, logger });
    try {
      const c = stream(server.port);
      await c.ready;
      await until(() => f.listeners.size === 1);
      const before = Date.now();
      f.fire();
      await until(() => c.count() === 1);
      const m = /(?:^|\n)event: change\ndata: (\{[^\n]*\})\n\n/.exec(c.s.text);
      assert.ok(m, c.s.text);
      const payload = JSON.parse(m![1]!) as { at: string };
      assert.deepEqual(Object.keys(payload), ['at']);
      assert.match(payload.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
      const t = Date.parse(payload.at);
      assert.ok(t >= before - 5 && t <= Date.now() + 5);
      c.req.destroy();
    } finally {
      await server.close();
    }
  });

  it('throttles: two quick changes give one event within 500 ms, then exactly one more', async () => {
    const f = fake();
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator: f.orchestrator, logger });
    try {
      const c = stream(server.port);
      await c.ready;
      await until(() => f.listeners.size === 1);
      const t0 = Date.now();
      f.fire();
      f.fire();
      await until(() => c.count() >= 1);
      await sleep(350);
      assert.equal(c.count(), 1, 'exactly one event inside the window');
      await until(() => c.count() === 2, 1500);
      assert.ok(c.s.at[1]! - c.s.at[0]! >= 450, `events at least ~500 ms apart (${c.s.at[1]! - c.s.at[0]!} ms)`);
      assert.ok(Date.now() - t0 >= 450);
      await sleep(900);
      assert.equal(c.count(), 2, 'trailing change delivered once, nothing more');
      c.req.destroy();
    } finally {
      await server.close();
    }
  });

  it('a burst of many changes never exceeds 1 event per ~500 ms and ends with a trailing event', async () => {
    const f = fake();
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator: f.orchestrator, logger });
    try {
      const c = stream(server.port);
      await c.ready;
      await until(() => f.listeners.size === 1);
      const start = Date.now();
      while (Date.now() - start < 1300) {
        f.fire();
        await sleep(20);
      }
      await sleep(700);
      const n = c.count();
      assert.ok(n >= 3 && n <= 4, `events in ~1.3 s burst: ${n}`);
      for (let i = 1; i < c.s.at.length; i++) assert.ok(c.s.at[i]! - c.s.at[i - 1]! >= 450, `gap ${i}`);
      c.req.destroy();
    } finally {
      await server.close();
    }
  });

  it('after a quiet period a single change is sent right away', async () => {
    const f = fake();
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator: f.orchestrator, logger });
    try {
      const c = stream(server.port);
      await c.ready;
      await until(() => f.listeners.size === 1);
      f.fire();
      await until(() => c.count() === 1);
      await sleep(700);
      const t = Date.now();
      f.fire();
      await until(() => c.count() === 2, 300);
      assert.ok(Date.now() - t < 300);
      c.req.destroy();
    } finally {
      await server.close();
    }
  });

  it('delivers to every connected client', async () => {
    const f = fake();
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator: f.orchestrator, logger });
    try {
      const a = stream(server.port);
      const b = stream(server.port);
      await Promise.all([a.ready, b.ready]);
      await until(() => /: connected|event/.test(a.s.text) || true);
      f.fire();
      await until(() => a.count() === 1 && b.count() === 1);
      a.req.destroy();
      b.req.destroy();
    } finally {
      await server.close();
    }
  });

  it('removes the orchestrator listener when the last client disconnects (no leak)', async () => {
    const f = fake();
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator: f.orchestrator, logger });
    try {
      const c = stream(server.port);
      await c.ready;
      await until(() => f.listeners.size === 1);
      c.req.destroy();
      await until(() => f.listeners.size === 0);
      const again = stream(server.port);
      await again.ready;
      await until(() => f.listeners.size === 1);
      f.fire();
      await until(() => again.count() === 1);
      again.req.destroy();
    } finally {
      await server.close();
    }
  });

  it('shutdown ends all open streams and close() does not hang', async () => {
    const f = fake();
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator: f.orchestrator, logger });
    const cs = [stream(server.port), stream(server.port), stream(server.port)];
    await Promise.all(cs.map((c) => c.ready));
    const t = Date.now();
    await Promise.race([server.close(), sleep(2000).then(() => assert.fail('close() hung'))]);
    assert.ok(Date.now() - t < 2000);
    await until(() => cs.every((c) => c.s.ended));
    assert.equal(f.listeners.size, 0);
  });

  it('keeps serving the other routes while a stream is open', async () => {
    const f = fake();
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator: f.orchestrator, logger });
    try {
      const c = stream(server.port);
      await c.ready;
      const status = await new Promise<number>((resolve) =>
        http.get({ host: '127.0.0.1', port: server.port, path: '/api/v1/state' }, (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        }),
      );
      assert.equal(status, 200);
      c.req.destroy();
    } finally {
      await server.close();
    }
  });

  it('same host guard as the other API routes: foreign Host gives 403 forbidden_host and no stream', async () => {
    const f = fake();
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator: f.orchestrator, logger });
    try {
      const evil = stream(server.port, { host: 'evil.example' });
      await evil.ready;
      assert.equal(evil.s.status, 403);
      assert.ok(evil.s.text.includes('forbidden_host'));
      assert.doesNotMatch(String(evil.s.headers['content-type']), /event-stream/);
      assert.equal(f.listeners.size, 0);
      for (const host of [`localhost:${server.port}`, `127.0.0.1:${server.port}`, `[::1]:${server.port}`]) {
        const ok = stream(server.port, { host });
        await ok.ready;
        assert.equal(ok.s.status, 200, host);
        ok.req.destroy();
      }
      // The guard answers the same for the sibling route.
      const state = await new Promise<number>((resolve) =>
        http.get({ host: '127.0.0.1', port: server.port, path: '/api/v1/state', headers: { host: 'evil.example' } }, (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        }),
      );
      assert.equal(state, 403);
    } finally {
      await server.close();
    }
  });

  it('only GET is allowed: POST, PUT and DELETE answer 405', async () => {
    const f = fake();
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator: f.orchestrator, logger });
    try {
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const res = await new Promise<http.IncomingMessage>((resolve) => {
          const req = http.request({ host: '127.0.0.1', port: server.port, method, path: '/api/v1/events' }, resolve);
          req.end();
        });
        assert.equal(res.statusCode, 405, method);
        res.resume();
      }
      assert.equal(f.listeners.size, 0);
    } finally {
      await server.close();
    }
  });

  it('registers a 25 s keepalive that writes `: ping` and stops when the stream closes', async () => {
    const f = fake();
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator: f.orchestrator, logger });
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const created: Array<{ fn: () => void; ms: number; handle: unknown; cleared: boolean }> = [];
    try {
      const c0 = stream(server.port);
      await c0.ready;
      c0.req.destroy();
      await until(() => f.listeners.size === 0);
      // Record intervals created while a stream opens; the callbacks are run by hand instead of waiting 25 s.
      globalThis.setInterval = ((fn: () => void, ms: number) => {
        const handle = realSetInterval(fn, ms);
        created.push({ fn, ms, handle, cleared: false });
        return handle;
      }) as typeof setInterval;
      globalThis.clearInterval = ((handle: never) => {
        for (const entry of created) if (entry.handle === handle) entry.cleared = true;
        realClearInterval(handle);
      }) as typeof clearInterval;
      const c = stream(server.port);
      await c.ready;
      await until(() => f.listeners.size === 1);
      globalThis.setInterval = realSetInterval;
      const ping = created.find((e) => e.ms === 25_000);
      assert.ok(ping, `a 25 s interval exists (${created.map((e) => e.ms).join(', ')})`);
      ping!.fn();
      await until(() => c.s.text.includes(': ping\n\n'));
      assert.equal(c.count(), 0, 'a ping is a comment, not an event');
      c.req.destroy();
      await until(() => f.listeners.size === 0);
      assert.equal(ping!.cleared, true, 'keepalive timer cleared on close');
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------- client (BASE_JS)

type Ctx = Record<string, any>;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  handlers: Record<string, Array<(e?: unknown) => void>> = {};
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(e: string, h: (e?: unknown) => void) {
    (this.handlers[e] ??= []).push(h);
  }
  set onerror(h: () => void) {
    this.addEventListener('error', h);
  }
  set onopen(h: () => void) {
    this.addEventListener('open', h);
  }
  close() {
    this.closed = true;
  }
  emit(e: string) {
    (this.handlers[e] ?? []).forEach((h) => h({ type: e }));
  }
}

function sandbox(extra: Ctx = {}, scripts: string[] = [BASE_JS]) {
  const intervals: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const ctx: Ctx = {
    document: { createElement: () => ({}), getElementById: () => null },
    setInterval: (fn: () => void, ms: number) => intervals.push({ fn, ms, cleared: false }),
    clearInterval: (id: number) => {
      const entry = intervals[id - 1];
      if (entry) entry.cleared = true;
    },
    setTimeout: () => 0,
    fmtClock: () => '',
    ...extra,
  };
  vm.createContext(ctx);
  // Concatenated like the pages do: one script scope, so function declarations (setLive) are visible to BASE_JS.
  vm.runInContext(scripts.join('\n'), ctx);
  return { ctx, intervals, active: () => intervals.filter((i) => !i.cleared).map((i) => i.ms) };
}

describe('E1-6 live() in BASE_JS', () => {
  it('is defined in BASE_JS and runs standalone in a vm without setLive', () => {
    FakeEventSource.instances = [];
    const { ctx } = sandbox({ EventSource: FakeEventSource });
    assert.equal(typeof ctx.live, 'function');
    assert.doesNotThrow(() => ctx.live(() => {}));
    const es = FakeEventSource.instances[0]!;
    assert.equal(es.url, '/api/v1/events');
    assert.doesNotThrow(() => es.emit('open'));
    assert.doesNotThrow(() => es.emit('error'));
  });

  it('without EventSource (undefined in the vm) live() does nothing and the poll interval stays', () => {
    const { ctx, active } = sandbox();
    assert.equal(ctx.EventSource, undefined);
    const poller = ctx.pollEvery(() => {}, 2000);
    assert.doesNotThrow(() => ctx.live(() => {}, poller));
    assert.deepEqual(active(), [2000]);
  });

  it('reloads on every change event', () => {
    FakeEventSource.instances = [];
    const { ctx } = sandbox({ EventSource: FakeEventSource });
    let calls = 0;
    ctx.live(() => calls++);
    const es = FakeEventSource.instances[0]!;
    es.emit('change');
    es.emit('change');
    es.emit('change');
    assert.equal(calls, 3);
  });

  it('sets the real LIVE badge: green when connected, gray on error', () => {
    FakeEventSource.instances = [];
    const mk = () => ({ className: '', title: '', textContent: '' });
    const live = mk();
    const text = mk();
    const nodes: Record<string, ReturnType<typeof mk>> = { 'shell-live': live, 'shell-live-text': text };
    const { ctx } = sandbox(
      { EventSource: FakeEventSource, document: { createElement: () => ({}), getElementById: (id: string) => nodes[id] ?? null } },
      [BASE_JS, LAYOUT_JS],
    );
    ctx.live(() => {});
    const es = FakeEventSource.instances[0]!;
    es.emit('open');
    assert.match(live.className, /tone-green/);
    es.emit('error');
    assert.match(live.className, /tone-gray/);
    assert.doesNotMatch(live.className, /tone-green/);
    es.emit('open');
    assert.match(live.className, /tone-green/);
  });

  it('stretches polling to 30 s on connect and goes back to the fast interval on error', () => {
    FakeEventSource.instances = [];
    const { ctx, active } = sandbox({ EventSource: FakeEventSource });
    const poller = ctx.pollEvery(() => {}, 2000);
    ctx.live(() => {}, poller);
    const es = FakeEventSource.instances[0]!;
    assert.deepEqual(active(), [2000], 'before the connection: fast polling');
    es.emit('open');
    assert.deepEqual(active(), [30000]);
    es.emit('error');
    assert.deepEqual(active(), [2000]);
    es.emit('open');
    assert.deepEqual(active(), [30000]);
  });

  it('a failing connection leaves the existing polling interval untouched', () => {
    FakeEventSource.instances = [];
    const { ctx, active } = sandbox({ EventSource: FakeEventSource });
    const poller = ctx.pollEvery(() => {}, 2000);
    ctx.live(() => {}, poller);
    FakeEventSource.instances[0]!.emit('error');
    assert.deepEqual(active(), [2000]);
  });

  it('pollEvery keeps polling with the given function', () => {
    const { ctx, intervals } = sandbox();
    let n = 0;
    ctx.pollEvery(() => n++, 2000);
    intervals[0]!.fn();
    intervals[0]!.fn();
    assert.equal(n, 2);
  });
});

describe('E1-6 pages', () => {
  const scripts = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] as string);

  it('all page scripts stay syntactically valid', () => {
    for (const [name, html] of Object.entries({ dashboard: DASHBOARD_HTML, agent: AGENT_HTML, logs: LOGS_HTML })) {
      for (const s of scripts(html)) assert.doesNotThrow(() => new vm.Script(s, { filename: name + '.js' }), name);
    }
  });

  it('overview, team/issue view and statistics call live() and no longer poll with a bare setInterval', () => {
    for (const [name, html] of Object.entries({ dashboard: DASHBOARD_HTML, agent: AGENT_HTML, logs: LOGS_HTML })) {
      assert.match(html, /\blive\(/, `${name} calls live()`);
      assert.match(html, /\bpollEvery\(/, `${name} keeps a polling fallback`);
    }
    assert.match(DASHBOARD_HTML, /pollEvery\(load, 2000\)/);
    assert.doesNotMatch(DASHBOARD_HTML, /setInterval\(load, 2000\)/);
    assert.doesNotMatch(AGENT_HTML, /setInterval\(poll, POLL_MS\)/);
  });

  it('statistics only reload periods that include now', () => {
    const start = LOGS_HTML.indexOf('function refreshOpen');
    assert.ok(start > 0);
    const body = LOGS_HTML.slice(start, start + 400);
    assert.match(body, /r\.to <= new Date\(\)/);
    assert.match(body, /loadAnalytics\(\)/);
  });

  it('page scripts run in a vm without EventSource and keep polling (overview 2 s)', () => {
    // The shipped overview script, run with a minimal DOM: it must reach live() without EventSource and not throw
    // on that account; its 2 s load interval must be registered.
    const script = scripts(DASHBOARD_HTML).find((s) => s.includes('live(load, pollEvery(load, 2000))'));
    assert.ok(script);
    const intervals: number[] = [];
    const proxy = (): any =>
      new Proxy(function () {}, {
        get: (_t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'length' ? 0 : proxy()),
        apply: () => proxy(),
        construct: () => proxy() as object,
        set: () => true,
      });
    const ctx: Ctx = {
      document: proxy(),
      window: proxy(),
      localStorage: proxy(),
      location: { search: '', pathname: '/', href: '' },
      fetch: () => new Promise(() => {}),
      setInterval: (_fn: () => void, ms: number) => intervals.push(ms),
      clearInterval: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
      requestAnimationFrame: () => 0,
      console,
    };
    vm.createContext(ctx);
    try {
      vm.runInContext(script!, ctx);
    } catch (error) {
      // A DOM stub gap must not be mistaken for a missing fallback: only fail when live()/pollEvery are the cause.
      assert.doesNotMatch(String((error as Error).message), /EventSource|live is not|pollEvery/);
    }
    assert.ok(intervals.includes(2000), `2 s polling registered: ${intervals.join(', ')}`);
    assert.equal(ctx.EventSource, undefined);
  });
});
