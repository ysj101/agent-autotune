import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { Paths } from '../config/paths.js';
import { ensurePrivateDir } from '../util/fs.js';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function readToken(paths: Paths): string | null {
  try {
    const token = readFileSync(paths.tokenFile, 'utf8').trim();
    return TOKEN_PATTERN.test(token) ? token : null;
  } catch {
    return null;
  }
}

/**
 * Return the existing token or create one (using `candidate` if given, e.g. the value a plan was
 * built with). The file is always 0600 inside a 0700 directory.
 */
export function ensureToken(paths: Paths, candidate?: string): string {
  ensurePrivateDir(paths.configDir);
  const existing = readToken(paths);
  if (existing) {
    if ((statSync(paths.tokenFile).mode & 0o777) !== 0o600) chmodSync(paths.tokenFile, 0o600);
    return existing;
  }
  const token = candidate && TOKEN_PATTERN.test(candidate) ? candidate : generateToken();
  writeFileSync(paths.tokenFile, `${token}\n`, { mode: 0o600 });
  chmodSync(paths.tokenFile, 0o600);
  return token;
}

/** Constant-time comparison so the receiver does not leak the token through timing. */
export function tokensEqual(expected: string, actual: string | undefined | null): boolean {
  if (!actual) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Extract the token from an `Authorization: Bearer <token>` header (also accepts `Bearer%20`). */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer(?: |%20)([A-Za-z0-9_-]+)$/.exec(header.trim());
  return m?.[1] ?? null;
}
