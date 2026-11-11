import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HOST, readConfig } from '../config/app-config.js';
import type { Paths } from '../config/paths.js';
import type { HookSessionStart, HookToolEvent } from '../hooks/types.js';
import { validateHookSessionStart, validateHookToolEvent } from '../hooks/validate.js';
import { resolveProjectRoot } from '../project/detect.js';
import { findPackageJson } from '../project/package-json.js';
import { bearerToken, tokensEqual } from '../security/local-token.js';
import { MAX_EVENT_BYTES, parseJsonObject } from '../security/sanitize.js';
import { recordMetricPoints } from '../store/metrics.js';
import { ensureProject, touchSession } from '../store/projects.js';
import type { Store } from '../store/sqlite.js';
import { recordHookToolEvent, recordOtelToolResult } from '../telemetry/correlation.js';
import { normalizeLogs, normalizeMetrics } from '../telemetry/normalizer.js';
import { isJsonContentType, OTLP_LOGS_PATH, OTLP_METRICS_PATH, OTLP_SUCCESS_BODY, otlpErrorBody } from '../telemetry/otlp-http.js';
import { VERSION } from '../version.js';

export const HOOK_TOOL_PATH = '/hook/tool';
export const HOOK_SESSION_START_PATH = '/hook/session-start';
export const HEALTH_PATH = '/health';

export interface RecordedToolEvent {
  event: HookToolEvent;
  eventId: string;
  projectId: string;
  projectRoot: string;
  packagePath: string | null;
}

export interface SessionStartContext {
  event: HookSessionStart;
  projectId: string;
  projectRoot: string;
}

export interface DaemonOptions {
  paths: Paths;
  store: Store;
  token: string;
  /** Called after a hook tool event is stored. Heavy analysis belongs here, off the request path. */
  onToolRecorded?: (recorded: RecordedToolEvent) => void;
  /** Returns the additionalContext for a session, or null for none. */
  sessionStart?: (ctx: SessionStartContext) => string | null;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_EVENT_BYTES) {
      reject(new HttpError(413, 'payload too large'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_EVENT_BYTES) {
        reject(new HttpError(413, 'payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function createDaemon(opts: DaemonOptions): {
  server: http.Server;
  listen: (port: number) => Promise<number>;
  close: () => Promise<void>;
} {
  const { store, paths } = opts;

  async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (!isJsonContentType(req.headers['content-type'])) throw new HttpError(415, 'only application/json is supported');
    const parsed = parseJsonObject(await readBody(req));
    if (!parsed) throw new HttpError(400, 'invalid JSON body');
    return parsed;
  }

  function handleLogs(body: Record<string, unknown>): void {
    store.incrementDiagnostic('otlp.logs.received');
    for (const r of normalizeLogs(body)) recordOtelToolResult(store, r);
  }

  function handleMetrics(body: Record<string, unknown>): void {
    store.incrementDiagnostic('otlp.metrics.received');
    recordMetricPoints(store, normalizeMetrics(body));
  }

  function project(cwd: string, sessionId: string): { id: string; root: string } | null {
    const root = resolveProjectRoot(cwd);
    if (!root) return null;
    const p = ensureProject(store, root);
    touchSession(store, sessionId, p.id);
    return p.enabled ? { id: p.id, root } : null;
  }

  function handleHookTool(body: Record<string, unknown>): void {
    const event = validateHookToolEvent(body);
    if (!event) throw new HttpError(400, 'invalid hook event');
    store.incrementDiagnostic('hook.tool.received');
    const p = project(event.cwd, event.session_id);
    if (!p) return;
    const pkg = event.command_family ? findPackageJson(event.cwd, p.root) : null;
    const packagePath = pkg?.ok ? pkg.pkg.path : null;
    const res = recordHookToolEvent(store, event, { projectId: p.id, packagePath, packageHash: pkg?.ok ? pkg.pkg.hash : null });
    if (res.inserted && opts.onToolRecorded) {
      const recorded: RecordedToolEvent = { event, eventId: res.id, projectId: p.id, projectRoot: p.root, packagePath };
      setImmediate(() => {
        try {
          opts.onToolRecorded?.(recorded);
        } catch {
          store.incrementDiagnostic('daemon.analysis_error');
        }
      });
    }
  }

  function handleSessionStart(body: Record<string, unknown>): string {
    const event = validateHookSessionStart(body);
    if (!event) throw new HttpError(400, 'invalid hook event');
    store.incrementDiagnostic('hook.session_start.received');
    const p = project(event.cwd, event.session_id);
    if (!p || !opts.sessionStart) return '{}';
    const context = opts.sessionStart({ event, projectId: p.id, projectRoot: p.root });
    return context ? JSON.stringify({ additionalContext: context }) : '{}';
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0];
    if (!tokensEqual(opts.token, bearerToken(req.headers.authorization))) throw new HttpError(401, 'unauthorized');
    if (req.method === 'GET' && path === HEALTH_PATH) {
      send(res, 200, JSON.stringify({ ok: true, version: VERSION, enabled: readConfig(paths).enabled }));
      return;
    }
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
    const handlers: Record<string, (b: Record<string, unknown>) => string | void> = {
      [OTLP_LOGS_PATH]: handleLogs,
      [OTLP_METRICS_PATH]: handleMetrics,
      [HOOK_TOOL_PATH]: handleHookTool,
      [HOOK_SESSION_START_PATH]: handleSessionStart,
    };
    const handler = path === undefined ? undefined : handlers[path];
    if (!handler) throw new HttpError(404, 'not found');
    const body = await jsonBody(req);
    // While disabled, requests are accepted (so exporters do not retry) but nothing is recorded.
    if (!readConfig(paths).enabled) {
      send(res, 200, OTLP_SUCCESS_BODY);
      return;
    }
    send(res, 200, handler(body) ?? OTLP_SUCCESS_BODY);
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) {
        send(res, err.status, otlpErrorBody(err.message));
        if (err.status === 401) store.incrementDiagnostic('daemon.unauthorized');
      } else {
        try {
          store.incrementDiagnostic('daemon.error');
        } catch {
          // the store itself may be what failed
        }
        send(res, 500, otlpErrorBody('internal error'));
      }
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;

  return {
    server,
    listen: (port) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, () => {
          server.off('error', reject);
          resolve((server.address() as AddressInfo).port);
        });
      }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
