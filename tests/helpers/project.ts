import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './tmp.js';

/** A temporary git project with the given npm scripts. Returns its realpath. */
export function makeProject(scripts: Record<string, string> = { 'test:unit': 'vitest' }): string {
  const root = realpathSync(tmpDir('aat-proj-'));
  mkdirSync(join(root, '.git'));
  writePackage(root, scripts);
  return root;
}

export function writePackage(root: string, scripts: Record<string, string>, extra: Record<string, unknown> = {}): void {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, ...extra, scripts }, null, 2));
}
