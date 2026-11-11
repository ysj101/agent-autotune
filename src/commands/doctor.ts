import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { readConfig } from '../config/app-config.js';
import { desiredEnv, HOOK_EVENTS, readManagedSettings, readManifest, readSettings, MANAGED_SETTINGS_PATH, type JsonObject } from '../config/claude-settings.js';
import { defaultRunner, isLaunchAgentLoaded, plistPath, type Runner } from '../config/launchd.js';
import { resolvePaths, type Paths } from '../config/paths.js';
import { readToken } from '../security/local-token.js';
import { currentVersion } from '../store/migrations.js';
import { SCHEMA_VERSION } from '../store/schema.js';
import { openStore } from '../store/sqlite.js';
import { consoleIo, daemonHealth, isPortFree, type Health, type Io } from './common.js';

/** Claude Code version on which Hooks/OTel behaviour was verified (docs/findings-real-device.md). */
export const VERIFIED_CLAUDE_VERSION = '2.1.310';
const MIN_NODE_MAJOR = 24;

export type Level = 'ok' | 'warn' | 'fail';
export interface Check {
  level: Level;
  name: string;
  detail: string;
}

export interface DoctorDeps {
  paths: Paths;
  io: Io;
  run: Runner;
  env: Record<string, string | undefined>;
  nodeVersion: string;
  platform: NodeJS.Platform;
  claudeVersion: () => string | null;
  health: (port: number, token: string) => Promise<Health | null>;
  isPortFree: (port: number) => Promise<boolean>;
  managedSettingsPath: string;
}

export function defaultDoctorDeps(): DoctorDeps {
  return {
    paths: resolvePaths(),
    io: consoleIo,
    run: defaultRunner,
    env: process.env,
    nodeVersion: process.versions.node,
    platform: process.platform,
    claudeVersion: () => {
      const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000 });
      return r.status === 0 ? (/(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] ?? null) : null;
    },
    health: daemonHealth,
    isPortFree,
    managedSettingsPath: MANAGED_SETTINGS_PATH,
  };
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

const mode = (p: string): number | null => (existsSync(p) ? statSync(p).mode & 0o777 : null);
const octal = (m: number | null): string => (m === null ? 'missing' : `0${m.toString(8)}`);

function hookInstalled(settings: JsonObject, event: string, hook: JsonObject): boolean {
  const list = (settings['hooks'] as JsonObject | undefined)?.[event];
  return Array.isArray(list) && list.some((g) => Array.isArray((g as JsonObject)?.['hooks']) && ((g as JsonObject)['hooks'] as unknown[]).some((h) => isDeepStrictEqual(h, hook)));
}

export async function collectChecks(deps: DoctorDeps): Promise<Check[]> {
  const { paths } = deps;
  const checks: Check[] = [];
  const add = (level: Level, name: string, detail: string): void => void checks.push({ level, name, detail });

  const nodeMajor = Number(deps.nodeVersion.split('.')[0]);
  add(nodeMajor >= MIN_NODE_MAJOR ? 'ok' : 'fail', 'node', `v${deps.nodeVersion}${nodeMajor >= MIN_NODE_MAJOR ? '' : ` (need >= ${MIN_NODE_MAJOR})`}`);
  if (deps.platform !== 'darwin') add('warn', 'platform', `${deps.platform} is not supported in v0.1 (macOS only)`);

  const claude = deps.claudeVersion();
  if (!claude) add('warn', 'claude code', 'not found on PATH');
  else if (compareVersions(claude, VERIFIED_CLAUDE_VERSION) < 0) add('warn', 'claude code', `${claude} (hooks/OTel verified on >= ${VERIFIED_CLAUDE_VERSION})`);
  else add('ok', 'claude code', claude);

  const config = readConfig(paths);
  const token = readToken(paths);
  add(config.enabled ? 'ok' : 'warn', 'state', config.enabled ? 'enabled' : 'disabled (run `agent-autotune enable` to resume)');
  if (!token) add('fail', 'token', `missing at ${paths.tokenFile}; run \`agent-autotune init\``);
  else add(mode(paths.tokenFile) === 0o600 ? 'ok' : 'fail', 'token', `${paths.tokenFile} ${octal(mode(paths.tokenFile))}`);
  for (const dir of [paths.configDir, paths.dataDir]) {
    if (existsSync(dir)) add(mode(dir) === 0o700 ? 'ok' : 'warn', 'permissions', `${dir} ${octal(mode(dir))}`);
  }

  const health = token ? await deps.health(config.port, token) : null;
  if (health) add('ok', 'daemon', `responding on 127.0.0.1:${config.port} (v${health.version ?? '?'})`);
  else if (await deps.isPortFree(config.port)) add('fail', 'daemon', `not running on 127.0.0.1:${config.port}`);
  else add('fail', 'daemon', `port ${config.port} is used by another process`);

  if (deps.platform === 'darwin') {
    const plist = plistPath(paths);
    if (!existsSync(plist)) add('warn', 'launchd', `${plist} not installed`);
    else {
      const loaded = isLaunchAgentLoaded(deps.run);
      add(loaded ? 'ok' : 'fail', 'launchd', `${plist} ${loaded ? 'loaded' : 'not loaded'}`);
    }
  }

  const settings = readSettings(paths.claudeSettingsFile);
  if (!settings.ok) add('fail', 'settings', settings.reason);
  else if (token) {
    const env = (settings.value['env'] ?? {}) as JsonObject;
    const wrong = Object.entries(desiredEnv(config.port, token)).filter(([k, v]) => env[k] !== v).map(([k]) => k);
    add(wrong.length ? 'fail' : 'ok', 'otel settings', wrong.length ? `missing or different: ${wrong.join(', ')}` : 'logs/metrics → local receiver, detailed logging off');
    const shellOverrides = Object.keys(desiredEnv(config.port, token)).filter((k) => deps.env[k] !== undefined && deps.env[k] !== env[k]);
    if (shellOverrides.length) add('warn', 'shell env', `set differently in the current environment: ${shellOverrides.join(', ')}`);
    const manifest = readManifest(paths.manifestFile);
    const hooks = manifest?.hooks ?? [];
    const missing = hooks.filter((h) => !hookInstalled(settings.value, h.event, h.hook)).map((h) => h.event);
    if (!manifest) add('fail', 'hooks', 'no install manifest; run `agent-autotune init`');
    else add(missing.length ? 'fail' : 'ok', 'hooks', missing.length ? `missing: ${missing.join(', ')}` : HOOK_EVENTS.join(', '));
  }
  const managed = readManagedSettings(deps.managedSettingsPath);
  const managedEnv = Object.keys((managed?.['env'] ?? {}) as JsonObject).filter((k) => k.startsWith('OTEL_'));
  if (managedEnv.length) add('warn', 'managed settings', `configure ${managedEnv.join(', ')}`);

  if (!existsSync(paths.dbFile)) add('fail', 'database', `${paths.dbFile} missing; run \`agent-autotune init\``);
  else {
    try {
      const store = openStore(paths.dbFile);
      const v = currentVersion(store.db);
      store.close();
      add(v === SCHEMA_VERSION ? 'ok' : 'fail', 'database', `${paths.dbFile} schema v${v}`);
    } catch (err) {
      add('fail', 'database', `cannot open: ${(err as Error).message}`);
    }
  }
  return checks;
}

export async function runDoctor(deps: DoctorDeps = defaultDoctorDeps()): Promise<number> {
  const checks = await collectChecks(deps);
  for (const c of checks) deps.io.out(`[${c.level}] ${c.name}: ${c.detail}`);
  return checks.some((c) => c.level === 'fail') ? 1 : 0;
}
