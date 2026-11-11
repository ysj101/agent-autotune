import http from 'node:http';
import type { Readable, Writable } from 'node:stream';
import { HOST, readConfig } from '../config/app-config.js';
import { resolvePaths } from '../config/paths.js';
import { readToken } from '../security/local-token.js';
import { MAX_EVENT_BYTES, parseJsonObject } from '../security/sanitize.js';
import { normalizeSessionStart, normalizeToolHook } from './tool-result.js';

/**
 * `agent-autotune hook <event>`: a short-lived process Claude Code runs for every matching hook.
 * It must never get in the way: every failure path ends with exit code 0 and empty stdout, and the
 * whole run is bounded well below the 2 s hook timeout.
 */

const HOOK_PATHS = { tool: '/hook/tool', sessionStart: '/hook/session-start' } as const;
const STDIN_TIMEOUT_MS = 500;
const REQUEST_TIMEOUT_MS = 800;
const MAX_CONTEXT_CHARS = 2000;

export interface HookIo {
  stdin?: Readable;
  stdout?: Writable;
  env?: Record<string, string | undefined>;
}

function readStdin(stream: Readable): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (v: Buffer | null): void => {
      clearTimeout(timer);
      stream.removeAllListeners('data');
      resolve(v);
    };
    const timer = setTimeout(() => done(null), STDIN_TIMEOUT_MS);
    stream.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_EVENT_BYTES) done(null);
      else chunks.push(c);
    });
    stream.on('end', () => done(Buffer.concat(chunks)));
    stream.on('error', () => done(null));
  });
}

function post(port: number, token: string, path: string, body: unknown): Promise<string | null> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: HOST,
        port,
        path,
        method: 'POST',
        timeout: REQUEST_TIMEOUT_MS,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: `Bearer ${token}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(res.statusCode === 200 ? Buffer.concat(chunks).toString() : null));
        res.on('error', () => resolve(null));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(payload);
  });
}

function sessionStartOutput(response: string | null): string | null {
  const parsed = response ? parseJsonObject(response) : null;
  const context = parsed?.['additionalContext'];
  if (typeof context !== 'string' || context.length === 0 || context.length > MAX_CONTEXT_CHARS) return null;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } });
}

export async function runHook(eventName: string, io: HookIo = {}): Promise<void> {
  try {
    const stdin = io.stdin ?? process.stdin;
    const stdout = io.stdout ?? process.stdout;
    const paths = resolvePaths(io.env ?? process.env);
    const config = readConfig(paths);
    if (!config.enabled) return;
    const token = readToken(paths);
    if (!token) return;
    const raw = await readStdin(stdin);
    const input = raw ? parseJsonObject(raw) : null;
    if (!input) return;

    if (eventName === 'SessionStart') {
      const event = normalizeSessionStart(input);
      if (!event) return;
      const out = sessionStartOutput(await post(config.port, token, HOOK_PATHS.sessionStart, event));
      if (out) stdout.write(`${out}\n`);
      return;
    }
    const event = normalizeToolHook(eventName, input);
    if (event) await post(config.port, token, HOOK_PATHS.tool, event);
  } catch {
    // fail-open: never surface hook errors to Claude Code
  } finally {
    process.exitCode = 0;
  }
}
