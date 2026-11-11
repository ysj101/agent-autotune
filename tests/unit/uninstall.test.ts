import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../../src/commands/init.js';
import { runUninstall, type UninstallDeps } from '../../src/commands/uninstall.js';
import { plistPath } from '../../src/config/launchd.js';
import { fakeInitDeps, type FakeEnv } from '../helpers/init.js';

const original = {
  model: 'opus',
  env: { MY_VAR: '1' },
  hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier --write' }] }] },
};

async function installed(): Promise<FakeEnv & { udeps: UninstallDeps }> {
  const f = fakeInitDeps();
  mkdirSync(dirname(f.paths.claudeSettingsFile), { recursive: true });
  writeFileSync(f.paths.claudeSettingsFile, JSON.stringify(original));
  expect(await runInit({ yes: true }, f.deps)).toBe(0);
  return { ...f, udeps: { paths: f.paths, run: f.deps.run, io: f.deps.io, confirm: async () => true } };
}

const settings = (f: FakeEnv): unknown => JSON.parse(readFileSync(f.paths.claudeSettingsFile, 'utf8'));

describe('uninstall', () => {
  it('restores the settings that existed before init', async () => {
    const f = await installed();
    expect(await runUninstall({ yes: true }, f.udeps)).toBe(0);
    expect(settings(f)).toEqual(original);
    expect(existsSync(plistPath(f.paths))).toBe(false);
    expect(existsSync(f.paths.manifestFile)).toBe(false);
    expect(existsSync(f.paths.dbFile)).toBe(true);
  });

  it('keeps entries changed after init and reports them', async () => {
    const f = await installed();
    const s = settings(f) as { env: Record<string, string>; hooks: Record<string, unknown[]> };
    s.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'https://mine.example.com';
    s.hooks['Stop'] = [{ hooks: [{ type: 'command', command: 'added later' }] }];
    writeFileSync(f.paths.claudeSettingsFile, JSON.stringify(s));
    expect(await runUninstall({ yes: true }, f.udeps)).toBe(0);
    const after = settings(f) as { env: Record<string, string>; hooks: Record<string, unknown> };
    expect(after.env).toEqual({ MY_VAR: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://mine.example.com' });
    expect(after.hooks).toEqual({ ...original.hooks, Stop: [{ hooks: [{ type: 'command', command: 'added later' }] }] });
    expect(f.out.join('\n')).toContain('keep   env.OTEL_EXPORTER_OTLP_ENDPOINT');
    expect(existsSync(f.paths.manifestFile)).toBe(true);
  });

  it('is safe to run twice and without a manifest', async () => {
    const f = await installed();
    await runUninstall({ yes: true }, f.udeps);
    expect(await runUninstall({ yes: true }, f.udeps)).toBe(0);
    expect(settings(f)).toEqual(original);
    expect(f.out.join('\n')).toContain('no install manifest found');
  });

  it('changes nothing on dry run or when declined', async () => {
    const f = await installed();
    const before = readFileSync(f.paths.claudeSettingsFile, 'utf8');
    expect(await runUninstall({ dryRun: true }, f.udeps)).toBe(0);
    expect(await runUninstall({}, { ...f.udeps, confirm: async () => false })).toBe(1);
    expect(readFileSync(f.paths.claudeSettingsFile, 'utf8')).toBe(before);
    expect(existsSync(plistPath(f.paths))).toBe(true);
  });
});
