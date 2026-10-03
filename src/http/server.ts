import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '../log.ts';
import type { Orchestrator } from '../orchestrator/orchestrator.ts';
import { errorMessage } from '../util/errors.ts';
import { DASHBOARD_HTML } from './dashboard.ts';

export interface HttpServerHandle {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const API_PREFIX = '/api/v1/';

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(text);
}

function sendError(res: http.ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { error: { code, message } }, headers);
}

function hostnameOf(hostHeader: string | undefined): string | null {
  if (hostHeader === undefined) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

/** True when a browser Origin header names this server (scheme ignored, host:port compared). */
function sameHost(origin: string, hostHeader: string | undefined): boolean {
  try {
    return hostHeader !== undefined && new URL(origin).host === hostHeader;
  } catch {
    return false;
  }
}

/**
 * Observability/control surface (spec 13.7): `/` dashboard, `/api/v1/state`, `/api/v1/<identifier>`,
 * `POST /api/v1/refresh`. Read-only except refresh. On a loopback bind, requests whose Host is
 * not a loopback name are rejected (DNS-rebinding guard), and cross-origin POSTs are refused.
 */
export function startHttpServer(options: {
  host: string;
  port: number;
  orchestrator: Orchestrator;
  logger: Logger;
}): Promise<HttpServerHandle> {
  const { orchestrator, logger } = options;
  const loopbackBind = LOOPBACK_HOSTS.has(options.host);

  const route = (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (loopbackBind) {
      const hostname = hostnameOf(req.headers.host);
      if (hostname === null || !LOOPBACK_HOSTS.has(hostname)) {
        sendError(res, 403, 'forbidden_host', 'this server only answers requests addressed to a loopback host name');
        return;
      }
    }
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const method = req.method ?? 'GET';
    const allow = (methods: string[], handler: () => void) => {
      if (methods.includes(method)) handler();
      else sendError(res, 405, 'method_not_allowed', `${method} is not supported on ${pathname}`, { allow: methods.join(', ') });
    };

    if (pathname === '/') {
      allow(['GET', 'HEAD'], () => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(method === 'HEAD' ? undefined : DASHBOARD_HTML);
      });
      return;
    }
    if (pathname === '/api/v1/state') {
      allow(['GET'], () => sendJson(res, 200, orchestrator.snapshot()));
      return;
    }
    if (pathname === '/api/v1/refresh') {
      allow(['POST'], () => {
        const origin = req.headers.origin;
        if (origin !== undefined && !sameHost(origin, req.headers.host)) {
          sendError(res, 403, 'forbidden_origin', 'cross-origin refresh requests are not allowed');
          return;
        }
        const { queued, coalesced } = orchestrator.requestRefresh();
        sendJson(res, 202, { queued, coalesced, requested_at: new Date().toISOString(), operations: ['poll', 'reconcile'] });
      });
      return;
    }
    if (pathname.startsWith(API_PREFIX) && pathname.length > API_PREFIX.length) {
      allow(['GET'], () => {
        let key: string;
        try {
          key = decodeURIComponent(pathname.slice(API_PREFIX.length));
        } catch {
          sendError(res, 400, 'bad_request', 'malformed issue identifier');
          return;
        }
        const detail = orchestrator.issueDetail(key);
        if (detail === null) sendError(res, 404, 'issue_not_found', `issue ${key} is not known to the running orchestrator`);
        else sendJson(res, 200, detail);
      });
      return;
    }
    sendError(res, 404, 'not_found', `no route for ${pathname}`);
  };

  const server = http.createServer((req, res) => {
    try {
      route(req, res);
    } catch (error) {
      logger.warn('http request failed', { path: req.url, error: errorMessage(error) });
      if (!res.headersSent) sendError(res, 500, 'internal_error', 'request failed; see the orchestrator logs');
      else res.end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      server.on('error', (error) => logger.warn('http server error', { error: error.message }));
      const address = server.address() as AddressInfo;
      const displayHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
      resolve({
        host: address.address,
        port: address.port,
        url: `http://${displayHost}:${address.port}/`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
