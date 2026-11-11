import { readFileSync } from 'node:fs';
import type { Paths } from './paths.js';
import { ensurePrivateDir, writeFileAtomic } from '../util/fs.js';

export const DEFAULT_PORT = 43181;
export const HOST = '127.0.0.1';

export interface AppConfig {
  version: 1;
  port: number;
  enabled: boolean;
}

export const DEFAULT_CONFIG: AppConfig = { version: 1, port: DEFAULT_PORT, enabled: true };

function isPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1024 && v <= 65535;
}

/**
 * Read config.json. Missing or malformed files fall back to defaults so the hook stays fail-open.
 * Deliberately avoids heavy schema libraries: the hook process reads this on every tool call.
 */
export function readConfig(paths: Paths): AppConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.configFile, 'utf8'));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_CONFIG };
  const obj = raw as Record<string, unknown>;
  return {
    version: 1,
    port: isPort(obj['port']) ? obj['port'] : DEFAULT_PORT,
    enabled: typeof obj['enabled'] === 'boolean' ? obj['enabled'] : true,
  };
}

export function writeConfig(paths: Paths, config: AppConfig): void {
  if (!isPort(config.port)) throw new Error(`invalid port: ${config.port}`);
  ensurePrivateDir(paths.configDir);
  writeFileAtomic(paths.configFile, `${JSON.stringify(config, null, 2)}\n`);
}

export function updateConfig(paths: Paths, patch: Partial<Omit<AppConfig, 'version'>>): AppConfig {
  const next: AppConfig = { ...readConfig(paths), ...patch, version: 1 };
  writeConfig(paths, next);
  return next;
}
