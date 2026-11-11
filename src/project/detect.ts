import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { safeRealpath } from '../security/path-guard.js';

const MAX_DEPTH = 64;

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The project root for a working directory: the nearest ancestor containing `.git`
 * (directory or worktree file), otherwise the working directory itself. Returns a realpath,
 * or null if `cwd` is not an existing absolute directory.
 */
export function resolveProjectRoot(cwd: unknown): string | null {
  const real = safeRealpath(cwd);
  if (!real) return null;
  try {
    if (!statSync(real).isDirectory()) return null;
  } catch {
    return null;
  }
  let dir = real;
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (exists(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return real;
}
