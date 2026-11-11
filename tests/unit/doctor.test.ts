import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collectChecks, compareVersions, runDoctor, type DoctorDeps } from '../../src/commands/doctor.js';
import { runInit } from '../../src/commands/init.js';
import { fakeInitDeps, type FakeEnv } from '../helpers/init.js';

function doctorDeps(f: FakeEnv, over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    paths: f.paths,
    io: f.deps.io,
    run: () => ({ status: 0, stderr: '' }),
    env: {},
    nodeVersion: '24.11.0',
    platform: 'darwin',
    claudeVersion: () => '2.1.310',
    health: async () => ({ ok: true, version: '0.1.0', enabled: true }),
    isPortFree: async () => false,
    managedSettingsPath: f.deps.managedSettingsPath,
    ...over,
  };
}

const levels = (checks: { level: string; name: string }[]): Record<string, string> => Object.fromEntries(checks.map((c) => [c.name, c.level]));

describe('doctor', () => {
  it('reports a healthy install', async () => {
    const f = fakeInitDeps();
    await runInit({ yes: true }, f.deps);
    const checks = await collectChecks(doctorDeps(f));
    expect(checks.filter((c) => c.level !== 'ok')).toEqual([]);
    expect(await runDoctor(doctorDeps(f))).toBe(0);
  });

  it('fails before init', async () => {
    const f = fakeInitDeps();
    const l = levels(await collectChecks(doctorDeps(f, { health: async () => null, isPortFree: async () => true })));
    expect(l).toMatchObject({ token: 'fail', daemon: 'fail', database: 'fail', launchd: 'warn' });
    expect(await runDoctor(doctorDeps(f))).toBe(1);
  });

  it('detects a stopped daemon, a foreign port owner and bad permissions', async () => {
    const f = fakeInitDeps();
    await runInit({ yes: true }, f.deps);
    chmodSync(f.paths.tokenFile, 0o644);
    const checks = await collectChecks(doctorDeps(f, { health: async () => null, isPortFree: async () => false, run: () => ({ status: 113, stderr: '' }) }));
    expect(levels(checks)).toMatchObject({ token: 'fail', daemon: 'fail', launchd: 'fail' });
    expect(checks.find((c) => c.name === 'daemon')?.detail).toMatch(/another process/);
  });

  it('detects settings drift and shell overrides without printing the token', async () => {
    const f = fakeInitDeps();
    await runInit({ yes: true }, f.deps);
    writeFileSync(f.paths.claudeSettingsFile, '{}');
    const checks = await collectChecks(doctorDeps(f, { env: { OTEL_LOGS_EXPORTER: 'console' } }));
    expect(levels(checks)).toMatchObject({ 'otel settings': 'fail', hooks: 'fail', 'shell env': 'warn' });
    const token = readFileSync(f.paths.tokenFile, 'utf8').trim();
    expect(JSON.stringify(checks)).not.toContain(token);
  });

  it('warns about old Claude Code, missing Claude Code and other platforms', async () => {
    const f = fakeInitDeps();
    await runInit({ yes: true }, f.deps);
    expect(levels(await collectChecks(doctorDeps(f, { claudeVersion: () => '2.0.1' })))['claude code']).toBe('warn');
    expect(levels(await collectChecks(doctorDeps(f, { claudeVersion: () => null })))['claude code']).toBe('warn');
    expect(levels(await collectChecks(doctorDeps(f, { platform: 'linux' })))['platform']).toBe('warn');
    expect(levels(await collectChecks(doctorDeps(f, { nodeVersion: '20.1.0' })))['node']).toBe('fail');
  });

  it('compares versions numerically', () => {
    expect(compareVersions('2.1.310', '2.1.99')).toBeGreaterThan(0);
    expect(compareVersions('2.1.310', '2.1.310')).toBe(0);
    expect(compareVersions('1.9.0', '2.0.0')).toBeLessThan(0);
  });
});
