import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, readConfig, updateConfig, writeConfig } from '../../src/config/app-config.js';
import { resolvePaths } from '../../src/config/paths.js';
import { bearerToken, ensureToken, readToken, tokensEqual } from '../../src/security/local-token.js';
import { tmpPaths } from '../helpers/tmp.js';

const mode = (p: string): number => statSync(p).mode & 0o777;

describe('paths', () => {
  it('uses XDG-like defaults under HOME', () => {
    const p = resolvePaths({ HOME: '/h' });
    expect(p.configDir).toBe('/h/.config/agent-autotune');
    expect(p.dbFile).toBe('/h/.local/share/agent-autotune/agent-autotune.db');
    expect(p.claudeSettingsFile).toBe('/h/.claude/settings.json');
  });

  it('honours overrides', () => {
    const p = resolvePaths({ HOME: '/h', AGENT_AUTOTUNE_CONFIG_DIR: '/c', AGENT_AUTOTUNE_DATA_DIR: '/d', CLAUDE_CONFIG_DIR: '/cl' });
    expect(p.tokenFile).toBe('/c/token');
    expect(p.dbFile).toBe('/d/agent-autotune.db');
    expect(p.claudeSettingsFile).toBe('/cl/settings.json');
  });
});

describe('config', () => {
  it('falls back to defaults when missing or malformed', () => {
    const p = tmpPaths();
    expect(readConfig(p)).toEqual({ version: 1, port: DEFAULT_PORT, enabled: true });
    mkdirSync(p.configDir, { recursive: true });
    writeFileSync(p.configFile, '{not json');
    expect(readConfig(p).port).toBe(DEFAULT_PORT);
    writeFileSync(p.configFile, JSON.stringify({ port: 80, enabled: 'no' }));
    expect(readConfig(p)).toEqual({ version: 1, port: DEFAULT_PORT, enabled: true });
  });

  it('writes private files and round-trips', () => {
    const p = tmpPaths();
    writeConfig(p, { version: 1, port: 43182, enabled: true });
    expect(mode(p.configDir)).toBe(0o700);
    expect(mode(p.configFile)).toBe(0o600);
    expect(updateConfig(p, { enabled: false })).toEqual({ version: 1, port: 43182, enabled: false });
    expect(readConfig(p).enabled).toBe(false);
  });

  it('rejects invalid ports', () => {
    expect(() => writeConfig(tmpPaths(), { version: 1, port: 22, enabled: true })).toThrow();
  });
});

describe('local token', () => {
  it('is generated once with 0600 and reused', () => {
    const p = tmpPaths();
    const t = ensureToken(p);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mode(p.tokenFile)).toBe(0o600);
    expect(mode(p.configDir)).toBe(0o700);
    expect(ensureToken(p)).toBe(t);
    expect(readToken(p)).toBe(t);
  });

  it('regenerates an invalid token file', () => {
    const p = tmpPaths();
    mkdirSync(p.configDir, { recursive: true });
    writeFileSync(join(p.configDir, 'token'), 'short');
    expect(readToken(p)).toBeNull();
    expect(ensureToken(p)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('compares and parses bearer tokens', () => {
    expect(tokensEqual('abc', 'abc')).toBe(true);
    expect(tokensEqual('abc', 'abd')).toBe(false);
    expect(tokensEqual('abc', undefined)).toBe(false);
    expect(bearerToken('Bearer abc_DEF-1')).toBe('abc_DEF-1');
    expect(bearerToken('Bearer%20abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});
