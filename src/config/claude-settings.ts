import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ensurePrivateDir, writeFileAtomic } from '../util/fs.js';
import { HOST } from './app-config.js';

/**
 * Key-level merge of AutoTune's OTel env and Hooks into Claude Code's user settings.json, and the
 * exact inverse. Existing values are never overwritten silently: anything that would change a
 * value AutoTune did not set is reported as a conflict and the merge is refused.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

export const HOOK_EVENTS = ['SessionStart', 'PostToolUse', 'PostToolUseFailure'] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];
export const HOOK_TIMEOUT_SECONDS = 2;

/** Settings keys that would send telemetry elsewhere or override our exporter if present. */
const COMPETING_ENV = [
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
];
const HEADERS_KEY = 'OTEL_EXPORTER_OTLP_HEADERS';

export interface HookCommand {
  command: string;
  /** Arguments before the event name, e.g. [cliPath, 'hook']. */
  argsPrefix: string[];
}

export interface HookEntry {
  event: HookEventName;
  matcher: string | null;
  hook: JsonObject;
}

export interface Manifest {
  version: 1;
  settingsPath: string;
  /** sha256 of each env value AutoTune set, so removal only touches values still equal to ours. */
  env: Record<string, string>;
  hooks: HookEntry[];
  createdEnvObject: boolean;
  createdHooksObject: boolean;
}

export interface Conflict {
  key: string;
  reason: string;
}

export interface MergeInput {
  port: number;
  token: string;
  hook: HookCommand;
  /** Manifest of a previous install: values recorded there may be updated (e.g. a new port). */
  previous?: Manifest | null;
  managed?: JsonObject | null;
}

export type MergeResult =
  | { ok: true; next: JsonObject; changes: string[]; manifest: Omit<Manifest, 'settingsPath'>; changed: boolean }
  | { ok: false; conflicts: Conflict[] };

export const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');

export function desiredEnv(port: number, token: string): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://${HOST}:${port}`,
    [HEADERS_KEY]: `Authorization=Bearer ${token}`,
    OTEL_LOG_USER_PROMPTS: '0',
    OTEL_LOG_ASSISTANT_RESPONSES: '0',
    OTEL_LOG_TOOL_DETAILS: '0',
    OTEL_LOG_TOOL_CONTENT: '0',
  };
}

export function desiredHooks(hook: HookCommand): HookEntry[] {
  return HOOK_EVENTS.map((event) => ({
    event,
    matcher: event === 'SessionStart' ? null : 'Bash',
    hook: { type: 'command', command: hook.command, args: [...hook.argsPrefix, event], timeout: HOOK_TIMEOUT_SECONDS },
  }));
}

/** Show a settings value without secrets: header values (ours or anyone's) are never printed. */
export function redact(key: string, value: string): string {
  return key.includes('HEADERS') ? value.replace(/=[^,]*/g, '=<redacted>') : value;
}

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

function managedConflicts(managed: JsonObject | null | undefined, wanted: Record<string, string>): Conflict[] {
  if (!managed) return [];
  const out: Conflict[] = [];
  if (managed['disableAllHooks'] === true) out.push({ key: 'managed:disableAllHooks', reason: 'managed settings disable all hooks' });
  if (managed['allowManagedHooksOnly'] === true) out.push({ key: 'managed:allowManagedHooksOnly', reason: 'managed settings allow only managed hooks' });
  const env = isObject(managed['env']) ? managed['env'] : {};
  for (const [k, v] of Object.entries(env)) {
    const competing = k.startsWith('OTEL_') || k === 'CLAUDE_CODE_ENABLE_TELEMETRY';
    if (competing && wanted[k] !== v) out.push({ key: `managed:env.${k}`, reason: 'managed settings configure telemetry; AutoTune will not override them' });
  }
  return out;
}

export function planMerge(current: JsonObject, input: MergeInput): MergeResult {
  const wanted = desiredEnv(input.port, input.token);
  const owned = input.previous?.env ?? {};
  const conflicts: Conflict[] = [...managedConflicts(input.managed, wanted)];
  if (current['disableAllHooks'] === true) conflicts.push({ key: 'disableAllHooks', reason: 'hooks are disabled in settings.json' });
  if (current['env'] !== undefined && !isObject(current['env'])) conflicts.push({ key: 'env', reason: 'env is not an object' });
  if (current['hooks'] !== undefined && !isObject(current['hooks'])) conflicts.push({ key: 'hooks', reason: 'hooks is not an object' });
  const env: JsonObject = isObject(current['env']) ? { ...current['env'] } : {};
  const hooks: JsonObject = isObject(current['hooks']) ? { ...current['hooks'] } : {};
  const changes: string[] = [];
  const manifestEnv: Record<string, string> = {};

  for (const key of COMPETING_ENV) {
    if (env[key] !== undefined) conflicts.push({ key: `env.${key}`, reason: 'a signal-specific OTLP setting would override AutoTune' });
  }
  for (const [key, value] of Object.entries(wanted)) {
    const existing = env[key];
    if (existing === value) {
      if (owned[key] === sha256(value)) manifestEnv[key] = sha256(value);
      continue;
    }
    if (existing === undefined || (typeof existing === 'string' && owned[key] === sha256(existing))) {
      env[key] = value;
      manifestEnv[key] = sha256(value);
      changes.push(`${existing === undefined ? 'add' : 'update'} env.${key}=${redact(key, value)}`);
      continue;
    }
    conflicts.push({ key: `env.${key}`, reason: `already set to ${typeof existing === 'string' ? redact(key, existing) : JSON.stringify(existing)}` });
  }
  if (env['OTEL_TRACES_EXPORTER'] === undefined) {
    env['OTEL_TRACES_EXPORTER'] = 'none';
    manifestEnv['OTEL_TRACES_EXPORTER'] = sha256('none');
    changes.push('add env.OTEL_TRACES_EXPORTER=none');
  } else if (owned['OTEL_TRACES_EXPORTER'] === sha256(String(env['OTEL_TRACES_EXPORTER']))) {
    manifestEnv['OTEL_TRACES_EXPORTER'] = owned['OTEL_TRACES_EXPORTER'];
  }

  const previousHooks = input.previous?.hooks ?? [];
  const entries = desiredHooks(input.hook);
  for (const entry of entries) {
    const list = hooks[entry.event];
    if (list !== undefined && !Array.isArray(list)) {
      conflicts.push({ key: `hooks.${entry.event}`, reason: 'not an array' });
      continue;
    }
    // Drop our own older entries (e.g. a moved install path), then add the current one once.
    let groups = (list ?? []) as Json[];
    const stale = previousHooks.filter((p) => p.event === entry.event && !isDeepStrictEqual(p.hook, entry.hook));
    if (stale.length) {
      groups = removeHooks(groups, stale.map((s) => s.hook));
      changes.push(`replace previous hooks.${entry.event} entry`);
    }
    if (!containsHook(groups, entry.hook)) {
      const group: JsonObject = entry.matcher ? { matcher: entry.matcher, hooks: [entry.hook] } : { hooks: [entry.hook] };
      groups = [...groups, group];
      changes.push(`add hooks.${entry.event} → ${entry.hook['command']} ${(entry.hook['args'] as string[]).join(' ')}`);
    }
    hooks[entry.event] = groups;
  }

  if (conflicts.length) return { ok: false, conflicts };
  const next: JsonObject = { ...current, env, hooks };
  return {
    ok: true,
    next,
    changes,
    changed: !isDeepStrictEqual(next, current),
    manifest: {
      version: 1,
      env: manifestEnv,
      hooks: entries,
      createdEnvObject: input.previous?.createdEnvObject ?? current['env'] === undefined,
      createdHooksObject: input.previous?.createdHooksObject ?? current['hooks'] === undefined,
    },
  };
}

function containsHook(groups: Json[], hook: JsonObject): boolean {
  return groups.some((g) => isObject(g) && Array.isArray(g['hooks']) && g['hooks'].some((h) => isDeepStrictEqual(h, hook)));
}

/** Remove exactly the given hook objects; groups left empty by that are dropped. */
function removeHooks(groups: Json[], targets: JsonObject[]): Json[] {
  const out: Json[] = [];
  for (const g of groups) {
    if (!isObject(g) || !Array.isArray(g['hooks'])) {
      out.push(g);
      continue;
    }
    const kept = g['hooks'].filter((h) => !targets.some((t) => isDeepStrictEqual(h, t)));
    if (kept.length === g['hooks'].length) out.push(g);
    else if (kept.length > 0) out.push({ ...g, hooks: kept });
  }
  return out;
}

export interface RemovalResult {
  next: JsonObject;
  removed: string[];
  /** Entries AutoTune added that were changed afterwards and are therefore left untouched. */
  kept: Conflict[];
  changed: boolean;
}

export function planRemoval(current: JsonObject, manifest: Manifest): RemovalResult {
  const removed: string[] = [];
  const kept: Conflict[] = [];
  const next: JsonObject = { ...current };

  if (isObject(current['env'])) {
    const env: JsonObject = { ...current['env'] };
    for (const [key, hash] of Object.entries(manifest.env)) {
      const value = env[key];
      if (value === undefined) continue;
      if (typeof value === 'string' && sha256(value) === hash) {
        delete env[key];
        removed.push(`env.${key}`);
      } else {
        kept.push({ key: `env.${key}`, reason: 'changed after install; left as is' });
      }
    }
    if (manifest.createdEnvObject && Object.keys(env).length === 0) delete next['env'];
    else next['env'] = env;
  }

  if (isObject(current['hooks'])) {
    const hooks: JsonObject = { ...current['hooks'] };
    for (const event of HOOK_EVENTS) {
      const list = hooks[event];
      if (!Array.isArray(list)) continue;
      const ours = manifest.hooks.filter((h) => h.event === event).map((h) => h.hook);
      const remaining = removeHooks(list, ours);
      if (remaining.length !== list.length || !isDeepStrictEqual(remaining, list)) removed.push(`hooks.${event}`);
      if (remaining.length === 0) delete hooks[event];
      else hooks[event] = remaining;
    }
    if (manifest.createdHooksObject && Object.keys(hooks).length === 0) delete next['hooks'];
    else next['hooks'] = hooks;
  }
  return { next, removed, kept, changed: !isDeepStrictEqual(next, current) };
}

export type SettingsRead = { ok: true; exists: boolean; value: JsonObject } | { ok: false; reason: string };

export function readSettings(path: string): SettingsRead {
  if (!existsSync(path)) return { ok: true, exists: false, value: {} };
  let parsed: unknown;
  try {
    const text = readFileSync(path, 'utf8');
    parsed = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    return { ok: false, reason: `${path} is not valid JSON; fix it before running AutoTune` };
  }
  if (!isObject(parsed)) return { ok: false, reason: `${path} is not a JSON object` };
  return { ok: true, exists: true, value: parsed };
}

/** Write settings.json atomically, keeping a timestamped backup of the previous file. Returns the backup path. */
export function writeSettings(path: string, value: JsonObject, now: Date = new Date()): string | null {
  let backup: string | null = null;
  let mode = 0o600;
  if (existsSync(path)) {
    mode = statSync(path).mode & 0o777;
    backup = `${path}.agent-autotune-backup-${now.toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(path, backup);
  } else {
    ensurePrivateDir(dirname(path));
  }
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);
  return backup;
}

export function readManifest(path: string): Manifest | null {
  try {
    const m = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
    return m && m.version === 1 && isObject(m.env as unknown as Json) && Array.isArray(m.hooks) ? m : null;
  } catch {
    return null;
  }
}

export function writeManifest(path: string, manifest: Manifest): void {
  ensurePrivateDir(dirname(path));
  writeFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

export const MANAGED_SETTINGS_PATH = '/Library/Application Support/ClaudeCode/managed-settings.json';

export function readManagedSettings(path: string = MANAGED_SETTINGS_PATH): JsonObject | null {
  const r = readSettings(path);
  return r.ok && r.exists ? r.value : null;
}
