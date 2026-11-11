import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isSafeScriptName } from '../rules/npm-command.js';
import { isWithin, safeRealpath } from '../security/path-guard.js';

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

export interface PackageInfo {
  /** Realpath of package.json. */
  path: string;
  /** sha256 of the raw file contents. */
  hash: string;
  /** Names of scripts whose names are safe to mention. Script bodies are never kept. */
  scripts: Set<string>;
}

export type PackageReadError = 'not_found' | 'outside_root' | 'not_a_file' | 'too_large' | 'invalid_json' | 'invalid_shape';
export type PackageReadResult = { ok: true; pkg: PackageInfo } | { ok: false; reason: PackageReadError };

/**
 * Nearest package.json from `cwd` upwards, never above `root`. A package.json whose realpath
 * leaves `root` (e.g. a symlink pointing elsewhere) is rejected.
 */
export function findPackageJson(cwd: string, root: string): PackageReadResult {
  const realRoot = safeRealpath(root);
  const realCwd = safeRealpath(cwd);
  if (!realRoot || !realCwd || !isWithin(realRoot, realCwd)) return { ok: false, reason: 'outside_root' };
  let dir = realCwd;
  for (;;) {
    const candidate = join(dir, 'package.json');
    let present = false;
    try {
      lstatSync(candidate);
      present = true;
    } catch {
      // keep walking up
    }
    if (present) return readPackageJson(candidate, realRoot);
    if (dir === realRoot) return { ok: false, reason: 'not_found' };
    const parent = dirname(dir);
    if (parent === dir) return { ok: false, reason: 'not_found' };
    dir = parent;
  }
}

/** Read and validate a package.json that must resolve inside `root`. */
export function readPackageJson(path: string, root: string): PackageReadResult {
  const realRoot = safeRealpath(root);
  const real = safeRealpath(path);
  if (!real) return { ok: false, reason: 'not_found' };
  if (!realRoot || !isWithin(realRoot, real)) return { ok: false, reason: 'outside_root' };
  let raw: Buffer;
  try {
    const st = lstatSync(real);
    if (!st.isFile()) return { ok: false, reason: 'not_a_file' };
    if (st.size > MAX_PACKAGE_JSON_BYTES) return { ok: false, reason: 'too_large' };
    raw = readFileSync(real);
  } catch {
    return { ok: false, reason: 'not_found' };
  }
  if (raw.length > MAX_PACKAGE_JSON_BYTES) return { ok: false, reason: 'too_large' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, reason: 'invalid_shape' };
  const scriptsField = (parsed as Record<string, unknown>)['scripts'];
  const scripts = new Set<string>();
  if (scriptsField !== undefined) {
    if (typeof scriptsField !== 'object' || scriptsField === null || Array.isArray(scriptsField)) {
      return { ok: false, reason: 'invalid_shape' };
    }
    for (const [name, body] of Object.entries(scriptsField)) {
      if (typeof body === 'string' && isSafeScriptName(name)) scripts.add(name);
    }
  }
  return { ok: true, pkg: { path: real, hash: hashContent(raw), scripts } };
}

export function hashContent(raw: Buffer | string): string {
  return createHash('sha256').update(raw).digest('hex');
}
