import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startHttpServer, type HttpServerHandle } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { NAV_ITEMS } from '../src/http/ui/layout.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, tempDir } from './helpers.ts';

/** Raw request so the Host header can be set freely. */
function request(
  port: number,
  method: string,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** The main navigation element of a page. */
function mainNav(body: string): string {
  const start = body.indexOf('aria-label="Hauptnavigation"');
  return body.slice(start, body.indexOf('</nav>', start));
}

const NEW_ROUTES = ['/', '/changes', '/tasks', '/brain', '/stats', '/issue?id=repo%2F1'];
const PLACEHOLDERS: Array<[string, string]> = [['/tasks', 'tasks'], ['/brain', 'brain']];

describe('E1-4 routes and redirects (independent acceptance tests)', () => {
  let server: HttpServerHandle;
  const root = path.resolve(import.meta.dirname, '..');

  before(async () => {
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
      runner: new FakeRunner(),
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker(),
    });
    server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
  });
  after(async () => {
    await server.close();
  });

  it('answers all six routes with 200 HTML, and HEAD without a body', async () => {
    for (const url of NEW_ROUTES) {
      const get = await request(server.port, 'GET', url);
      assert.equal(get.status, 200, url);
      assert.match(get.headers['content-type'] ?? '', /^text\/html/, url);
      assert.match(get.body, /^<!doctype html>/i, url);
      const head = await request(server.port, 'HEAD', url);
      assert.equal(head.status, 200, `HEAD ${url}`);
      assert.equal(head.body, '', `HEAD ${url}`);
    }
  });

  it('rejects other methods on the new routes with 405', async () => {
    for (const url of NEW_ROUTES) {
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const res = await request(server.port, method, url);
        assert.equal(res.status, 405, `${method} ${url}`);
      }
    }
  });

  it('/stats is the statistics page with the "stats" entry active', async () => {
    const { body } = await request(server.port, 'GET', '/stats');
    assert.match(body, /<title>Statistik · Symphony<\/title>/);
    assert.ok(body.includes('href="/stats" aria-current="page"'));
    assert.equal((mainNav(body).match(/aria-current="page"/g) ?? []).length, 1, 'exactly one active entry');
    assert.match(body, /\/api\/v1\/history\/analytics\?/);
  });

  it('/issue?id= is the issue detail page: no active nav entry, breadcrumb "Übersicht › Issue"', async () => {
    const { body } = await request(server.port, 'GET', '/issue?id=repo%2F1');
    assert.match(body, /<nav class="crumbs" aria-label="Brotkrumen">/);
    assert.match(body, /<a href="\/">Übersicht<\/a>/);
    assert.match(body, /id="crumb-current" aria-current="page">Issue</);
    // Only the breadcrumb carries aria-current; no main navigation entry is active.
    assert.doesNotMatch(mainNav(body), /aria-current/);
    // Client script fills in the issue id and polls the API.
    assert.match(body, /'Issue ' \+ num/);
    assert.doesNotMatch(body, /'Agent ' \+ num\)[^;]*crumb/);
    assert.match(body, /\/api\/v1\//);
  });

  it('placeholder pages: title, active navigation entry, empty text, in the shell', async () => {
    for (const [url, key] of PLACEHOLDERS) {
      const { body } = await request(server.port, 'GET', url);
      const label = NAV_ITEMS.find((i) => i.key === key)!.label;
      assert.match(body, new RegExp(`<title>[^<]*${label}[^<]*</title>`), url);
      assert.ok(body.includes(`href="${url}" aria-current="page"`), `${url} marks its entry`);
      assert.equal((mainNav(body).match(/aria-current="page"/g) ?? []).length, 1, url);
      assert.ok(body.includes('Diese Seite kommt in Kürze.'), url);
      assert.match(body, /<h1[^>]*>/, url);
      assert.ok(body.includes('aria-label="Hauptnavigation"'), `${url} is rendered in the shell`);
      assert.ok(body.includes('<header'), url);
    }
  });

  it('redirects /logs and /agent permanently, with the query string kept verbatim', async () => {
    const cases: Array<[string, string]> = [
      ['/logs', '/stats'],
      ['/logs?period=7d&repo=a%2Fb', '/stats?period=7d&repo=a%2Fb'],
      ['/agent?id=repo%2F1', '/issue?id=repo%2F1'],
      ['/agent?id=acme%2Fapp%231', '/issue?id=acme%2Fapp%231'],
      ['/agent', '/issue'],
      ['/agent?id=a+b&x=%25', '/issue?id=a+b&x=%25'],
    ];
    for (const [from, to] of cases) {
      for (const method of ['GET', 'HEAD']) {
        const res = await request(server.port, method, from);
        assert.equal(res.status, 301, `${method} ${from}`);
        assert.equal(res.headers.location, to, `${method} ${from}`);
        assert.equal(res.body, '', `${method} ${from}`);
      }
    }
  });

  it('redirect targets are fixed paths (no open redirect through the query or path)', async () => {
    for (const url of ['/logs?next=//evil.example', '/agent?id=//evil.example', '/logs//evil.example']) {
      const res = await request(server.port, 'GET', url);
      const location = res.headers.location;
      if (res.status === 301) assert.ok(location !== undefined && /^\/(stats|issue)(\?|$)/.test(location), `${url} -> ${location}`);
      else assert.notEqual(res.status, 200, url);
    }
  });

  it('applies the host check to every new route and redirect through the same code path', async () => {
    const urls = [...NEW_ROUTES, '/logs', '/agent?id=repo%2F1'];
    const reference = await request(server.port, 'GET', '/api/v1/state', { host: 'evil.example:80' });
    assert.equal(reference.status, 403);
    for (const url of urls) {
      for (const host of ['evil.example:80', 'evil.example', '10.0.0.5:8080', 'bad host']) {
        for (const method of ['GET', 'HEAD']) {
          const res = await request(server.port, method, url, { host });
          assert.ok([400, 403].includes(res.status), `${method} ${url} with Host ${host}: ${res.status}`);
          assert.equal(res.status, reference.status, `${method} ${url} behaves like the existing routes`);
          assert.equal(res.headers.location, undefined, `${url} must not redirect for a foreign host`);
          if (method === 'GET') assert.doesNotMatch(res.body, /<!doctype/i);
        }
      }
    }
  });

  it('keeps loopback host names working on every route', async () => {
    for (const host of ['localhost', '127.0.0.1', 'localhost:3000', '[::1]:3000']) {
      for (const url of NEW_ROUTES) {
        assert.equal((await request(server.port, 'GET', url, { host })).status, 200, `${url} with Host ${host}`);
      }
      assert.equal((await request(server.port, 'GET', '/logs', { host })).status, 301);
    }
  });

  it('pill navigation on every page points at /, /changes, /tasks, /brain, /stats', async () => {
    assert.deepEqual(NAV_ITEMS.map((i) => i.href), ['/', '/changes', '/tasks', '/brain', '/stats']);
    for (const url of NEW_ROUTES) {
      const { body } = await request(server.port, 'GET', url);
      const start = body.indexOf('aria-label="Hauptnavigation"');
      const nav = body.slice(start, body.indexOf('</nav>', start));
      const hrefs = [...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      assert.deepEqual(hrefs, ['/', '/changes', '/tasks', '/brain', '/stats'], url);
    }
  });

  it('no client page links to the former /logs and /agent routes', async () => {
    for (const url of NEW_ROUTES) {
      const { body } = await request(server.port, 'GET', url);
      assert.doesNotMatch(body, /href="\/(logs|agent)[?"#]/, url);
      assert.doesNotMatch(body, /['"`]\/agent\?id=/, url);
      assert.doesNotMatch(body, /['"`]\/logs['"`?]/, url);
      assert.doesNotMatch(body, /location\.(href|assign)\s*=\s*['"]\/(logs|agent)/, url);
    }
    // The dashboard rows and buttons point at the new routes.
    const dashboard = (await request(server.port, 'GET', '/')).body;
    assert.ok(dashboard.includes('/issue?id='));
    assert.ok(dashboard.includes('/stats'));
    const stats = (await request(server.port, 'GET', '/stats')).body;
    assert.ok(stats.includes('/issue?id='), 'the statistics page links to the issue detail page');
  });

  it('source of the HTTP layer does not link to the old page routes', () => {
    const dir = path.join(root, 'src/http');
    const files = fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts') && f !== 'server.ts');
    assert.ok(files.length > 5);
    for (const file of files) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      assert.doesNotMatch(text, /['"`]\/agent\?id=/, file);
      assert.doesNotMatch(text, /href=\\?"\/(logs|agent)\b/, file);
    }
  });

  it('server.ts documents the new routes and the redirects in its comment block', () => {
    const text = fs.readFileSync(path.join(root, 'src/http/server.ts'), 'utf8');
    const start = text.indexOf('Observability/control surface');
    assert.ok(start > 0);
    const block = text.slice(start, text.indexOf('export function startHttpServer', start));
    for (const route of ['/changes', '/tasks', '/brain', '/stats', '/issue', '301']) assert.ok(block.includes(route), route);
  });

  it('docs/usage.md lists the new routes and the redirects', () => {
    const text = fs.readFileSync(path.join(root, 'docs/usage.md'), 'utf8');
    for (const route of ['/issue', '/stats', '/changes', '/tasks', '/brain']) assert.ok(text.includes('`' + route) || text.includes(route + '`') || text.includes(route), route);
    assert.match(text, /301/);
    assert.match(text, /\/logs[^\n]*\/stats|\/stats[^\n]*\/logs/);
    assert.match(text, /\/agent[^\n]*\/issue|\/issue[^\n]*\/agent/);
  });

  it('keeps the check-status link of the worker on the new route', () => {
    const text = fs.readFileSync(path.join(root, 'src/orchestrator/worker.ts'), 'utf8');
    assert.doesNotMatch(text, /\/agent\?id=/);
  });
});
