import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  desiredEnv,
  planMerge,
  planRemoval,
  readManifest,
  readSettings,
  writeManifest,
  writeSettings,
  type JsonObject,
  type Manifest,
  type MergeInput,
} from '../../src/config/claude-settings.js';
import { tmpDir } from '../helpers/tmp.js';

const TOKEN = 'tok_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk';
const input = (over: Partial<MergeInput> = {}): MergeInput => ({
  port: 43181,
  token: TOKEN,
  hook: { command: '/usr/local/bin/node', argsPrefix: ['/opt/agent-autotune/dist/cli.js', 'hook'] },
  ...over,
});

const userSettings = (): JsonObject => ({
  model: 'opus',
  env: { MY_VAR: 'keep' },
  hooks: {
    PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier --write' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
  },
});

function merged(current: JsonObject, over: Partial<MergeInput> = {}) {
  const r = planMerge(current, input(over));
  if (!r.ok) throw new Error(JSON.stringify(r.conflicts));
  return r;
}

describe('planMerge', () => {
  it('adds env and hooks while keeping everything else', () => {
    const r = merged(userSettings());
    const env = r.next['env'] as JsonObject;
    expect(env).toMatchObject({ MY_VAR: 'keep', ...desiredEnv(43181, TOKEN), OTEL_TRACES_EXPORTER: 'none' });
    const hooks = r.next['hooks'] as Record<string, JsonObject[]>;
    expect(hooks['Stop']).toEqual((userSettings()['hooks'] as JsonObject)['Stop']);
    expect(hooks['PostToolUse']).toHaveLength(2);
    expect(hooks['PostToolUse']![1]).toEqual({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: '/usr/local/bin/node', args: ['/opt/agent-autotune/dist/cli.js', 'hook', 'PostToolUse'], timeout: 2 }],
    });
    expect(hooks['SessionStart']).toEqual([{ hooks: [{ type: 'command', command: '/usr/local/bin/node', args: ['/opt/agent-autotune/dist/cli.js', 'hook', 'SessionStart'], timeout: 2 }] }]);
    expect(r.next['model']).toBe('opus');
  });

  it('never shows the token in the change list', () => {
    const r = merged({});
    expect(r.changes.join('\n')).not.toContain(TOKEN);
    expect(r.changes.join('\n')).toContain('Authorization=<redacted>');
  });

  it('is idempotent', () => {
    const first = merged(userSettings());
    const second = merged(first.next, { previous: { ...first.manifest, settingsPath: 'x' } });
    expect(second.changed).toBe(false);
    expect(second.changes).toEqual([]);
    expect(second.next).toEqual(first.next);
    // even without a manifest, identical entries are not duplicated
    const third = merged(first.next);
    expect((third.next['hooks'] as Record<string, unknown[]>)['SessionStart']).toHaveLength(1);
  });

  it('updates values it owns (port change, new install path)', () => {
    const first = merged({});
    const previous: Manifest = { ...first.manifest, settingsPath: 'x' };
    const r = merged(first.next, { previous, port: 43190, hook: { command: '/new/node', argsPrefix: ['/new/cli.js', 'hook'] } });
    expect((r.next['env'] as JsonObject)['OTEL_EXPORTER_OTLP_ENDPOINT']).toBe('http://127.0.0.1:43190');
    const ss = (r.next['hooks'] as Record<string, JsonObject[]>)['SessionStart']!;
    expect(ss).toHaveLength(1);
    expect((ss[0]!['hooks'] as JsonObject[])[0]!['command']).toBe('/new/node');
  });

  it.each([
    ['another exporter endpoint', { env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com' } }, 'env.OTEL_EXPORTER_OTLP_ENDPOINT'],
    ['existing headers', { env: { OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=secret' } }, 'env.OTEL_EXPORTER_OTLP_HEADERS'],
    ['telemetry disabled', { env: { CLAUDE_CODE_ENABLE_TELEMETRY: '0' } }, 'env.CLAUDE_CODE_ENABLE_TELEMETRY'],
    ['detailed logging on', { env: { OTEL_LOG_USER_PROMPTS: '1' } }, 'env.OTEL_LOG_USER_PROMPTS'],
    ['signal-specific endpoint', { env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://x' } }, 'env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT'],
    ['hooks disabled', { disableAllHooks: true }, 'disableAllHooks'],
    ['malformed hooks', { hooks: { SessionStart: {} } }, 'hooks.SessionStart'],
    ['malformed env', { env: 'x' }, 'env'],
  ])('refuses to overwrite %s', (_l, current, key) => {
    const r = planMerge(current as JsonObject, input());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.conflicts.map((c) => c.key)).toContain(key);
      expect(JSON.stringify(r.conflicts)).not.toContain('secret');
    }
  });

  it('accepts matching pre-existing values and leaves an existing traces exporter alone', () => {
    const r = merged({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_TRACES_EXPORTER: 'otlp' } });
    expect((r.next['env'] as JsonObject)['OTEL_TRACES_EXPORTER']).toBe('otlp');
    expect(r.manifest.env).not.toHaveProperty('OTEL_TRACES_EXPORTER');
    expect(r.manifest.env).not.toHaveProperty('CLAUDE_CODE_ENABLE_TELEMETRY');
  });

  it('respects managed settings', () => {
    expect(planMerge({}, input({ managed: { env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://corp' } } })).ok).toBe(false);
    expect(planMerge({}, input({ managed: { allowManagedHooksOnly: true } })).ok).toBe(false);
    expect(planMerge({}, input({ managed: { permissions: {} } })).ok).toBe(true);
  });
});

describe('planRemoval', () => {
  it('restores the original settings exactly', () => {
    const original = userSettings();
    const m = merged(original);
    const r = planRemoval(m.next, { ...m.manifest, settingsPath: 'x' });
    expect(r.next).toEqual(original);
    expect(r.kept).toEqual([]);
  });

  it('removes objects it created', () => {
    const m = merged({ model: 'x' });
    expect(planRemoval(m.next, { ...m.manifest, settingsPath: 'x' }).next).toEqual({ model: 'x' });
  });

  it('keeps entries changed after install and reports them', () => {
    const m = merged(userSettings());
    const edited = structuredClone(m.next);
    (edited['env'] as JsonObject)['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'https://elsewhere';
    const r = planRemoval(edited, { ...m.manifest, settingsPath: 'x' });
    expect((r.next['env'] as JsonObject)['OTEL_EXPORTER_OTLP_ENDPOINT']).toBe('https://elsewhere');
    expect(r.kept.map((k) => k.key)).toEqual(['env.OTEL_EXPORTER_OTLP_ENDPOINT']);
    expect(r.next['hooks']).toEqual(userSettings()['hooks']);
  });

  it('keeps hooks other tools added to the same group', () => {
    const m = merged({});
    const edited = structuredClone(m.next);
    const group = (edited['hooks'] as Record<string, JsonObject[]>)['SessionStart']![0]!;
    (group['hooks'] as JsonObject[]).push({ type: 'command', command: 'other' });
    const r = planRemoval(edited, { ...m.manifest, settingsPath: 'x' });
    expect((r.next['hooks'] as JsonObject)['SessionStart']).toEqual([{ hooks: [{ type: 'command', command: 'other' }] }]);
  });
});

describe('settings files', () => {
  it('backs up before writing and preserves mode', () => {
    const dir = tmpDir();
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{"a":1}', { mode: 0o644 });
    const backup = writeSettings(path, { a: 2 });
    expect(readFileSync(backup!, 'utf8')).toBe('{"a":1}');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 2 });
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('creates a new file without backup', () => {
    const path = join(tmpDir(), 'claude', 'settings.json');
    expect(writeSettings(path, { a: 1 })).toBeNull();
    expect(readSettings(path)).toEqual({ ok: true, exists: true, value: { a: 1 } });
  });

  it('refuses invalid settings', () => {
    const path = join(tmpDir(), 'settings.json');
    writeFileSync(path, '{ nope');
    expect(readSettings(path).ok).toBe(false);
    writeFileSync(path, '[]');
    expect(readSettings(path).ok).toBe(false);
    expect(readSettings(join(tmpDir(), 'missing.json'))).toEqual({ ok: true, exists: false, value: {} });
  });

  it('round-trips the manifest privately', () => {
    const path = join(tmpDir(), 'cfg', 'install-manifest.json');
    const m = merged({});
    writeManifest(path, { ...m.manifest, settingsPath: '/s' });
    expect(readManifest(path)).toEqual({ ...m.manifest, settingsPath: '/s' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).not.toContain(TOKEN);
  });
});
