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

/** True when a bind address only accepts local connections (and the server applies its loopback guards). */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}
const API_PREFIX = '/api/v1/';
/** Largest JSON body a control route reads. */
const MAX_BODY_BYTES = 16 * 1024;

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(text);
}

function sendError(res: http.ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { error: { code, message } }, headers);
}

/**
 * Reads the JSON body of a control route. Requires `Content-Type: application/json` (415 otherwise, which also
 * refuses plain form posts) and at most MAX_BODY_BYTES (413). An empty body is null. Sends the error and resolves
 * `undefined` when refused.
 */
function readJsonBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<unknown> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') {
    req.resume();
    sendError(res, 415, 'unsupported_media_type', 'send the body with Content-Type: application/json');
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: unknown) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        sendError(res, 413, 'payload_too_large', `the body may have at most ${MAX_BODY_BYTES} bytes`, { connection: 'close' });
        req.resume();
        finish(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        finish(null);
        return;
      }
      try {
        finish(JSON.parse(text));
      } catch {
        sendError(res, 400, 'bad_request', 'the body is not valid JSON');
        finish(undefined);
      }
    });
    req.on('error', () => finish(undefined));
  });
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
 * Observability/control surface (spec 13.7): `/` dashboard, `/agent?id=<identifier>` agent detail view (live, or
 * archived once the orchestrator released the issue),
 * `/logs` statistics page with `/api/v1/history`, `/api/v1/history/analytics` and `/api/v1/history/entries`,
 * `/api/v1/state`, `/api/v1/<identifier>` with its `/timeline` and `/transcript`, `POST /api/v1/refresh`
 * `POST /api/v1/<identifier>/retry` (restart a waiting or paused worker), `/force` (Start now in an extra slot),
 * `/pause` and `/resume` (operator pause of an issue), `POST /api/v1/models/<model>/hold` and `/release` (operator pause of a model family), and
 * `PUT` / `DELETE /api/v1/settings/agents` (agent slots set on the dashboard; JSON body, `Content-Type:
 * application/json` required).
 * Read-only except refresh and these control routes. On a loopback bind, requests whose Host is not a loopback name are
 * rejected (DNS-rebinding guard), and cross-origin POSTs are refused. On any other bind the server has no
 * login of its own and belongs behind an authenticating reverse proxy: the control routes are disabled unless
 * `allowRemoteControl` is set, and then requires an Origin header naming this host (CSRF guard, since a
 * proxy's BasicAuth credentials ride along with every browser request). The same guard applies to every control
 * route. `/api/v1/state` and `/api/v1/<identifier>` report `controls.retry` so the pages show the control buttons
 * only when allowed.
 */
export function startHttpServer(options: {
  host: string;
  port: number;
  orchestrator: Orchestrator;
  logger: Logger;
  history?: HistorySource | null;
  /** Allow retry on a non-loopback bind (behind an authenticating reverse proxy). */
  allowRemoteControl?: boolean;
}): Promise<HttpServerHandle> {
  const { orchestrator, logger } = options;
  const history = options.history ?? null;
  const loopbackBind = isLoopbackHost(options.host);
  const controls = { retry: loopbackBind || options.allowRemoteControl === true };
  // Analytics per filter, valid while the log files (append-only, so their sizes) and the price table are unchanged.
  const analyticsCache = new Map<string, { pricing: object; value: Analytics }>();

  /**
   * The guard of every control route (retry, force, pause, resume, model hold and release, agent settings): loopback bind, or
   * `allowRemoteControl` plus an Origin header naming this host. Sends the 403 and returns false when refused.
   */
  const controlAllowed = (req: http.IncomingMessage, res: http.ServerResponse): boolean => {
    if (!controls.retry) {
      sendError(
        res,
        403,
        'control_disabled',
        'controls are disabled on a non-loopback bind; set server.allow_remote_control (SYMPHONY_ALLOW_REMOTE_CONTROL=true) behind an authenticating proxy',
      );
      return false;
    }
    const origin = req.headers.origin;
    if (origin === undefined && !loopbackBind) {
      sendError(res, 403, 'forbidden_origin', 'control requests need an Origin header naming this host (e.g. -H \'Origin: https://<domain>\')');
      return false;
    }
    if (origin !== undefined && !sameHost(origin, req.headers.host)) {
      sendError(res, 403, 'forbidden_origin', 'cross-origin control requests are not allowed');
      return false;
    }
    return true;
  };

  const route = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const respond = (pending: Promise<void>) =>
      pending.catch((error: unknown) => {
        logger.warn('http control request failed', { path: req.url, error: errorMessage(error) });
        if (!res.headersSent) sendError(res, 500, 'internal_error', 'request failed; see the orchestrator logs');
      });
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
      allow(['GET'], () => sendJson(res, 200, { ...orchestrator.snapshot(), controls }));
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
          effort: textParam(params, 'effort'),
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
    // Agent slots set on the dashboard: PUT changes them, DELETE returns to WORKFLOW.md.
    if (pathname === '/api/v1/settings/agents') {
      allow(['PUT', 'DELETE'], () => {
        if (!controlAllowed(req, res)) {
          req.resume();
          return;
        }
        respond(readJsonBody(req, res).then(async (body) => {
          if (body === undefined) return;
          const result = method === 'PUT' ? await orchestrator.updateAgentSettings(body) : await orchestrator.resetAgentSettings();
          if (result.ok) sendJson(res, 200, { changed: result.changed, limits: result.limits, requested_at: new Date().toISOString() });
          else if (result.reason === 'invalid') sendError(res, 400, 'invalid_settings', result.message);
          else sendError(res, 409, 'stopping', 'the orchestrator is shutting down');
        }));
      });
      return;
    }
    // Pause / Resume of a model family: POST /api/v1/models/<model>/hold and /release.
    const modelRoute = /^models\/([^/]+)\/(hold|release)$/.exec(pathname.slice(API_PREFIX.length));
    if (pathname.startsWith(API_PREFIX) && modelRoute !== null) {
      allow(['POST'], () => {
        if (!controlAllowed(req, res)) return;
        let model: string;
        try {
          model = decodeURIComponent(modelRoute[1] as string);
        } catch {
          sendError(res, 400, 'bad_request', 'malformed model family');
          return;
        }
        const hold = modelRoute[2] === 'hold';
        respond((hold ? orchestrator.holdModel(model) : orchestrator.releaseModel(model)).then((result) => {
          if (result.ok) {
            sendJson(res, 202, {
              model: result.model,
              paused: hold,
              [hold ? 'stopped' : 'requeued']: result.issues,
              requested_at: new Date().toISOString(),
            });
            return;
          }
          switch (result.reason) {
            case 'unknown_model':
              sendError(res, 400, 'unknown_model', `unknown model family ${model}; use one of fable, opus, sonnet, haiku`);
              break;
            case 'already_paused':
              sendError(res, 409, 'already_paused', `model ${model} is already paused`);
              break;
            case 'not_paused':
              sendError(res, 409, 'not_paused', `model ${model} is not paused by the operator`);
              break;
            case 'stopping':
              sendError(res, 409, 'stopping', 'the orchestrator is shutting down');
              break;
          }
        }));
      });
      return;
    }
    // Sub-resources of an issue; the identifier is URL-encoded (owner%2Frepo%2312), so its slash cannot end it.
    const sub = /^(.+)\/(timeline|transcript|retry|pause|resume|force)$/.exec(pathname.slice(API_PREFIX.length));
    if (pathname.startsWith(API_PREFIX) && sub !== null && (sub[2] === 'retry' || sub[2] === 'pause' || sub[2] === 'resume' || sub[2] === 'force')) {
      const action = sub[2];
      allow(['POST'], () => {
        if (!controlAllowed(req, res)) return;
        let key: string;
        try {
          key = decodeURIComponent(sub[1] as string);
        } catch {
          sendError(res, 400, 'bad_request', 'malformed issue identifier');
          return;
        }
        const notFound = () => sendError(res, 404, 'issue_not_found', `issue ${key} is not known to the running orchestrator`);
        const shuttingDown = () => sendError(res, 409, 'stopping', 'the orchestrator is shutting down; restart it before retrying');
        if (action === 'pause') {
          respond(orchestrator.pauseIssue(key).then((result) => {
            if (result.ok) {
              sendJson(res, 202, { paused: true, issue_identifier: result.issueIdentifier, previous: result.previous, requested_at: new Date().toISOString() });
            } else if (result.reason === 'not_found') notFound();
            else if (result.reason === 'already_paused') sendError(res, 409, 'already_paused', `issue ${key} is already paused by the operator`);
            else sendError(res, 409, 'stopping', 'the agent of this issue is already stopping, or the orchestrator is shutting down');
          }));
          return;
        }
        if (action === 'force') {
          respond(orchestrator.forceStart(key).then((result) => {
            if (result.ok) {
              sendJson(res, 202, {
                started: true,
                issue_identifier: result.issueIdentifier,
                previous: result.previous,
                slots: result.slots,
                requested_at: new Date().toISOString(),
              });
            } else if (result.reason === 'not_found') sendError(res, 404, 'issue_not_found', result.message);
            else if (result.reason === 'model_held') sendError(res, 409, 'model_held', result.message);
            else if (result.reason === 'tracker_error') sendError(res, 502, 'tracker_error', result.message);
            else if (result.reason === 'spawn_failed') sendError(res, 500, 'spawn_failed', result.message);
            else sendError(res, 409, result.reason, result.message);
          }));
          return;
        }
        if (action === 'resume') {
          respond(orchestrator.resumeIssue(key).then((result) => {
            if (result.ok) sendJson(res, 202, { queued: true, issue_identifier: result.issueIdentifier, requested_at: new Date().toISOString() });
            else if (result.reason === 'not_found') notFound();
            else if (result.reason === 'not_paused') sendError(res, 409, 'not_paused', `issue ${key} is not paused`);
            else sendError(res, 409, 'stopping', 'the agent of this issue is still stopping, or the orchestrator is shutting down');
          }));
          return;
        }
        respond(orchestrator.restartWorker(key).then((result) => {
          if (result.ok) {
            sendJson(res, 202, {
              queued: true,
              issue_identifier: result.issueIdentifier,
              previous: result.previous,
              requested_at: new Date().toISOString(),
            });
            return;
          }
          switch (result.reason) {
            case 'not_found':
              notFound();
              break;
            case 'running':
              sendError(res, 409, 'running', 'the worker is running; there is nothing to restart');
              break;
            case 'stopping':
              shuttingDown();
              break;
            case 'not_waiting':
              sendError(res, 409, 'not_waiting', 'the issue is not waiting for a retry or paused; there is nothing to restart');
              break;
          }
        }));
      });
      return;
    }
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
          if (timeline === null) sendError(res, 404, 'issue_not_found', `issue ${key} is neither tracked by the orchestrator nor archived`);
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
        if (transcript === null) sendError(res, 404, 'issue_not_found', `issue ${key} is neither tracked by the orchestrator nor archived`);
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
        if (detail === null) sendError(res, 404, 'issue_not_found', `issue ${key} is neither tracked by the orchestrator nor archived`);
        else sendJson(res, 200, { ...detail, controls });
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
