import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cli = new URL('../../dist/cli.js', import.meta.url).pathname;

describe.runIf(existsSync(cli))('cli', () => {
  it('prints the version', () => {
    const out = execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
    expect(out.trim()).toBe('0.1.0');
  });

  it('lists every subcommand from the spec', () => {
    const out = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
    for (const name of ['init', 'doctor', 'status', 'rules', 'disable', 'enable', 'purge', 'uninstall', 'daemon', 'hook']) {
      expect(out).toContain(name);
    }
  });

  it('hook exits 0 with empty stdout', () => {
    const r = spawnSync(process.execPath, [cli, 'hook', 'SessionStart'], { input: 'not json', encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
