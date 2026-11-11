import { execFileSync } from 'node:child_process';
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

});
