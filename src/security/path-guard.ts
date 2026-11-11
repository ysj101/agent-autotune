import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

/** True when `target` is `root` itself or lies below it. Both must already be resolved paths. */
export function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** realpath that returns null instead of throwing (missing file, permission error, loops). */
export function safeRealpath(path: unknown): string | null {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) return null;
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}
