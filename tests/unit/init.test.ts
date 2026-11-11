import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../../src/commands/init.js';
import { readConfig } from '../../src/config/app-config.js';
import { plistPath } from '../../src/config/launchd.js';
import { readToken } from '../../src/security/local-token.js';
import { fakeInitDeps } from '../helpers/init.js';

const settingsOf = (p: string): Record<string, any> => JSON.parse(readFileSync(p, 'utf8'));

function seedSettings(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

describe('init', () => {
  it('registers token, config, settings, DB and launchd', async () => {
    const f = fakeInitDeps();
    seedSettings(f.paths.claudeSettingsFile, { model: 'opus' });
    expect(await runInit({ yes: true }, f.deps)).toBe(0);
    const token = readToken(f.paths)!;
    expect(token).toBeTruthy();
    expect(statSync(f.paths.tokenFile).mode & 0o777).toBe(0o600);
    expect(readConfig(f.paths)).toEqual({ version: 1, port: 43181, enabled: true });
    const s = settingsOf(f.paths.claudeSettingsFile);
    expect(s.model).toBe('opus');
    expect(s.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:43181');
    expect(s.env.OTEL_EXPORTER_OTLP_HEADERS).toBe(`Authorization=Bearer ${token}`);
    expect(s.hooks.SessionStart[0].hooks[0]).toEqual({ type: 'command', command: '/usr/local/bin/node', args: ['/opt/agent-autotune/dist/cli.js', 'hook', 'SessionStart'], timeout: 2 });
    expect(existsSync(f.paths.dbFile)).toBe(true);
    expect(existsSync(plistPath(f.paths))).toBe(true);
    expect(f.launchctl.map((c) => c[1])).toEqual(['bootout', 'bootstrap']);
    expect(readdirSync(dirname(f.paths.claudeSettingsFile)).some((n) => n.includes('agent-autotune-backup'))).toBe(true);
  });

  it('never prints the token', async () => {
    const f = fakeInitDeps();
    await runInit({ yes: true }, f.deps);
    const token = readToken(f.paths)!;
    expect([...f.out, ...f.err].join('\n')).not.toContain(token);
  });

  it('is idempotent', async () => {
    const f = fakeInitDeps();
    seedSettings(f.paths.claudeSettingsFile, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say hi' }] }] } });
    await runInit({ yes: true }, f.deps);
    const first = readFileSync(f.paths.claudeSettingsFile, 'utf8');
    const token = readToken(f.paths);
    const backups = (): number => readdirSync(dirname(f.paths.claudeSettingsFile)).filter((n) => n.includes('backup')).length;
    const before = backups();
    expect(await runInit({ yes: true }, f.deps)).toBe(0);
    expect(readFileSync(f.paths.claudeSettingsFile, 'utf8')).toBe(first);
    expect(readToken(f.paths)).toBe(token);
    expect(backups()).toBe(before);
    expect(f.out.join('\n')).toContain('already up to date');
  });

  it('changes nothing in dry-run mode', async () => {
    const f = fakeInitDeps();
    seedSettings(f.paths.claudeSettingsFile, { model: 'x' });
    expect(await runInit({ dryRun: true }, f.deps)).toBe(0);
    expect(settingsOf(f.paths.claudeSettingsFile)).toEqual({ model: 'x' });
    expect(existsSync(f.paths.tokenFile)).toBe(false);
    expect(existsSync(f.paths.configDir)).toBe(false);
    expect(f.launchctl).toEqual([]);
    expect(f.out.join('\n')).toContain('add env.OTEL_EXPORTER_OTLP_HEADERS=Authorization=<redacted>');
  });

  it('stops on conflicts without changing anything', async () => {
    const f = fakeInitDeps();
    seedSettings(f.paths.claudeSettingsFile, { env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://corp.example.com' } });
    expect(await runInit({ yes: true }, f.deps)).toBe(1);
    expect(settingsOf(f.paths.claudeSettingsFile)).toEqual({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://corp.example.com' } });
    expect(existsSync(f.paths.tokenFile)).toBe(false);
    expect(f.err.join('\n')).toMatch(/OTEL_EXPORTER_OTLP_ENDPOINT/);
  });

  it('stops on conflicting managed settings', async () => {
    const f = fakeInitDeps();
    seedSettings(f.deps.managedSettingsPath, { env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://corp' } });
    expect(await runInit({ yes: true }, f.deps)).toBe(1);
    expect(f.err.join('\n')).toContain('managed:env.OTEL_EXPORTER_OTLP_ENDPOINT');
  });

  it('refuses an unreadable settings.json', async () => {
    const f = fakeInitDeps();
    mkdirSync(dirname(f.paths.claudeSettingsFile), { recursive: true });
    writeFileSync(f.paths.claudeSettingsFile, '{ broken');
    expect(await runInit({ yes: true }, f.deps)).toBe(1);
    expect(readFileSync(f.paths.claudeSettingsFile, 'utf8')).toBe('{ broken');
  });

  it('does nothing when the user declines', async () => {
    const f = fakeInitDeps({ confirm: async () => false });
    expect(await runInit({}, f.deps)).toBe(1);
    expect(existsSync(f.paths.claudeSettingsFile)).toBe(false);
    expect(existsSync(f.paths.tokenFile)).toBe(false);
  });

  it('moves to the next free port and updates every place consistently', async () => {
    const f = fakeInitDeps({ isPortFree: async (p) => p !== 43181 });
    expect(await runInit({ yes: true }, f.deps)).toBe(0);
    expect(readConfig(f.paths).port).toBe(43182);
    expect(settingsOf(f.paths.claudeSettingsFile).env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:43182');
  });

  it('keeps the port when it is served by our own daemon', async () => {
    const f = fakeInitDeps();
    await runInit({ yes: true }, f.deps);
    f.deps.isPortFree = async () => false;
    f.deps.isOurDaemon = async (port) => port === 43181;
    expect(await runInit({ yes: true }, f.deps)).toBe(0);
    expect(readConfig(f.paths).port).toBe(43181);
  });

  it('fails when no port is available', async () => {
    const f = fakeInitDeps({ isPortFree: async () => false });
    expect(await runInit({ yes: true }, f.deps)).toBe(1);
    expect(f.err.join('\n')).toMatch(/no free port/);
  });

  it('can skip launchd', async () => {
    const f = fakeInitDeps();
    expect(await runInit({ yes: true, launchd: false }, f.deps)).toBe(0);
    expect(f.launchctl).toEqual([]);
  });
});
