import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import type { PricingStore } from '../costs/pricing.ts';
import { computeAnalytics, filterEntries, isValidTimeZone, type Analytics, type AnalyticsFilter } from '../history/analytics.ts';
import { computeHistoryStats, readHistory, repositoryFileName } from '../history/history.ts';
import type { Logger } from '../log.ts';
import type { Orchestrator } from '../orchestrator/orchestrator.ts';
import { errorMessage } from '../util/errors.ts';
import { AGENT_HTML } from './agent-page.ts';
import { DASHBOARD_HTML } from './dashboard.ts';
import { LOGS_HTML } from './logs-page.ts';

/** Where the per-repository logs live and how to price them. */
export interface HistorySource {
  dir: string;
  pricing: PricingStore;
}

export interface HttpServerHandle {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

/** Largest page of log entries one request may ask for. */
const MAX_ENTRIES = 1000;
const ANALYTICS_CACHE_SIZE = 32;

/** An ISO date/time query parameter; undefined when present but invalid. */
function dateParam(params: URLSearchParams, name: string): Date | null | undefined {
  const raw = params.get(name);
  if (raw === null || raw === '') return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : undefined;
}

const textParam = (params: URLSearchParams, name: string): string | null => {
  const raw = params.get(name)?.trim();
  return raw === undefined || raw === '' ? null : raw;
};

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
 * Observability/control surface (spec 13.7): `/` dashboard, `/agent?id=<identifier>` agent detail view,
 * `/logs` statistics page with `/api/v1/history`, `/api/v1/history/analytics` and `/api/v1/history/entries`,
 * `/api/v1/state`, `/api/v1/<identifier>` with its `/timeline` and `/transcript`, `POST /api/v1/refresh`.
 * Read-only except refresh. On a loopback bind, requests whose Host is
 * not a loopback name are rejected (DNS-rebinding guard), and cross-origin POSTs are refused.
 */
export function startHttpServer(options: {
  host: string;
  port: number;
  orchestrator: Orchestrator;
  logger: Logger;
  history?: HistorySource | null;
}): Promise<HttpServerHandle> {
  const { orchestrator, logger } = options;
  const history = options.history ?? null;
  const loopbackBind = LOOPBACK_HOSTS.has(options.host);
  // Analytics per filter, valid while the log files (append-only, so their sizes) and the price table are unchanged.
  const analyticsCache = new Map<string, { pricing: object; value: Analytics }>();

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
    if (pathname === '/agent') {
      allow(['GET', 'HEAD'], () => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(method === 'HEAD' ? undefined : AGENT_HTML);
      });
      return;
    }
    if (pathname === '/api/v1/state') {
      allow(['GET'], () => sendJson(res, 200, orchestrator.snapshot()));
      return;
    }
    if (pathname === '/logs') {
      allow(['GET', 'HEAD'], () => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(method === 'HEAD' ? undefined : LOGS_HTML);
      });
      return;
    }
    if (pathname === '/api/v1/history/analytics' || pathname === '/api/v1/history/entries') {
      allow(['GET'], () => {
        if (history === null) {
          sendError(res, 404, 'history_disabled', 'the repository history is not enabled');
          return;
        }
        const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
        const from = dateParam(params, 'from');
        const to = dateParam(params, 'to');
        if (from === undefined || to === undefined) {
          sendError(res, 400, 'bad_request', 'from and to must be ISO dates (e.g. 2026-10-01T00:00:00Z)');
          return;
        }
        if (from !== null && to !== null && from.getTime() >= to.getTime()) {
          sendError(res, 400, 'bad_request', 'from must be before to');
          return;
        }
        const repo = textParam(params, 'repo');
        const { files, entries } = readHistory(history.dir, repo);
        if (pathname === '/api/v1/history/entries') {
          const limit = Number(params.get('limit') ?? 200);
          sendJson(res, 200, {
            generated_at: new Date().toISOString(),
            ...filterEntries(entries, {
              from,
              to,
              repo,
              issue: textParam(params, 'issue'),
              event: textParam(params, 'event'),
              result: textParam(params, 'result'),
              order: params.get('order') === 'asc' ? 'asc' : 'desc',
              limit: Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), MAX_ENTRIES) : 200,
            }),
          });
          return;
        }
        const zone = textParam(params, 'tz');
        const filter: AnalyticsFilter = {
          from,
          to,
          repo,
          model: textParam(params, 'model'),
          timeZone: zone !== null && isValidTimeZone(zone) ? zone : Intl.DateTimeFormat().resolvedOptions().timeZone,
        };
        const pricing = history.pricing.current();
        let value: Analytics;
        // An open end moves with the clock, so only bounded periods are cached.
        const key = to === null ? null : JSON.stringify([filter, files.map((f) => [f.file, f.bytes])]);
        const cached = key === null ? undefined : analyticsCache.get(key);
        if (cached !== undefined && cached.pricing === pricing) {
          value = cached.value;
        } else {
          value = computeAnalytics(entries, pricing, filter);
          if (key !== null) {
            analyticsCache.delete(key);
            analyticsCache.set(key, { pricing, value });
            if (analyticsCache.size > ANALYTICS_CACHE_SIZE) analyticsCache.delete(analyticsCache.keys().next().value as string);
          }
        }
        const all = repo === null ? files : readHistory(history.dir, null).files;
        sendJson(res, 200, {
          generated_at: new Date().toISOString(),
          history_dir: history.dir,
          pricing_file: history.pricing.path,
          pricing_error: history.pricing.lastError,
          repositories_available: all.map((f) => f.repo),
          ...value,
        });
      });
      return;
    }
    if (pathname === '/api/v1/history' || pathname === '/api/v1/history/raw') {
      allow(['GET'], () => {
        if (history === null) {
          sendError(res, 404, 'history_disabled', 'the repository history is not enabled');
          return;
        }
        const repoParam = new URL(req.url ?? '/', 'http://localhost').searchParams.get('repo');
        const repo = repoParam === null || repoParam === '' ? null : repoParam;
        if (pathname === '/api/v1/history/raw') {
          if (repo === null) {
            sendError(res, 400, 'bad_request', 'pass ?repo=owner/name');
            return;
          }
          const file = readHistory(history.dir, repo).files[0]?.file ?? `${history.dir}/${repositoryFileName(repo)}`;
          let text: string;
          try {
            text = fs.readFileSync(file, 'utf8');
          } catch {
            sendError(res, 404, 'not_found', `no log for ${repo}`);
            return;
          }
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end(text);
          return;
        }
        const { files, entries } = readHistory(history.dir, repo);
        const all = repo === null ? files : readHistory(history.dir, null).files;
        sendJson(res, 200, {
          generated_at: new Date().toISOString(),
          repo,
          history_dir: history.dir,
          pricing_file: history.pricing.path,
          pricing_error: history.pricing.lastError,
          repositories_available: all.map((f) => ({ repo: f.repo, file: f.file, bytes: f.bytes })),
          ...computeHistoryStats(entries, history.pricing.current()),
        });
      });
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
    // Sub-resources of an issue; the identifier is URL-encoded (owner%2Frepo%2312), so its slash cannot end it.
    const sub = /^(.+)\/(timeline|transcript)$/.exec(pathname.slice(API_PREFIX.length));
    if (pathname.startsWith(API_PREFIX) && sub !== null) {
      allow(['GET'], () => {
        let key: string;
        try {
          key = decodeURIComponent(sub[1] as string);
        } catch {
          sendError(res, 400, 'bad_request', 'malformed issue identifier');
          return;
        }
        const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
        const number = (name: string) => {
          const value = Number(params.get(name) ?? 0);
          return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
        };
        if (sub[2] === 'timeline') {
          const timeline = orchestrator.issueTimeline(key, number('after'));
          if (timeline === null) sendError(res, 404, 'issue_not_found', `issue ${key} is not known to the running orchestrator`);
          else sendJson(res, 200, timeline);
          return;
        }
        const run = params.get('run') || null;
        if (params.get('format') === 'raw') {
          const file = orchestrator.issueTranscriptFile(key, run);
          if (file === null) {
            sendError(res, 404, 'not_found', `no transcript for ${key}${run === null ? '' : ` run ${run}`}`);
            return;
          }
          const stream = fs.createReadStream(file);
          stream.once('error', () => {
            if (res.headersSent) res.destroy();
            else sendError(res, 404, 'not_found', 'the transcript file cannot be read');
          });
          stream.once('open', () => {
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
            stream.pipe(res);
          });
          return;
        }
        const transcript = orchestrator.issueTranscript(key, run, number('from'));
        if (transcript === null) sendError(res, 404, 'issue_not_found', `issue ${key} is not known to the running orchestrator`);
        else sendJson(res, 200, transcript);
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
