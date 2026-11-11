import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { resolvePaths, type Paths } from '../../src/config/paths.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

export function tmpDir(prefix = 'aat-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Paths rooted in a fresh temporary HOME. */
export function tmpPaths(): Paths & { home: string } {
  const home = tmpDir('aat-home-');
  return { ...resolvePaths({ HOME: home }), home };
}
