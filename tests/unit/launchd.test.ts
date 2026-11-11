import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { installLaunchAgent, isLaunchAgentLoaded, LAUNCHD_LABEL, plistPath, renderPlist, uninstallLaunchAgent, type Runner } from '../../src/config/launchd.js';
import { tmpPaths } from '../helpers/tmp.js';

function recorder(status = 0): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, run: (program, args) => (calls.push([program, ...args]), { status, stderr: status ? 'boom' : '' }) };
}

const program = { nodePath: '/usr/local/bin/node', cliPath: '/opt/a&b/dist/cli.js' };

describe('launchd', () => {
  it('renders a plist that runs the daemon with escaped paths', () => {
    const p = tmpPaths();
    const xml = renderPlist(program, p, { HOME: p.home, AGENT_AUTOTUNE_DATA_DIR: '/data', UNRELATED: 'x' });
    expect(xml).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(xml).toContain('<string>/opt/a&amp;b/dist/cli.js</string>\n    <string>daemon</string>');
    expect(xml).toContain('<key>AGENT_AUTOTUNE_DATA_DIR</key>');
    expect(xml).not.toContain('UNRELATED');
    expect(xml).toContain('<key>KeepAlive</key>\n  <true/>');
  });

  it('installs with bootout + bootstrap through launchctl directly', () => {
    const p = tmpPaths();
    const r = recorder();
    expect(installLaunchAgent(program, p, r.run).ok).toBe(true);
    expect(existsSync(plistPath(p))).toBe(true);
    expect(statSync(plistPath(p)).mode & 0o777).toBe(0o644);
    expect(readFileSync(plistPath(p), 'utf8')).toContain('<string>daemon</string>');
    expect(r.calls.map((c) => c.slice(0, 2))).toEqual([
      ['/bin/launchctl', 'bootout'],
      ['/bin/launchctl', 'bootstrap'],
    ]);
    expect(r.calls[1]![3]).toBe(plistPath(p));
  });

  it('reports bootstrap failures', () => {
    expect(installLaunchAgent(program, tmpPaths(), recorder(5).run)).toEqual({ ok: false, message: 'launchctl bootstrap failed: boom' });
  });

  it('uninstalls the agent and plist', () => {
    const p = tmpPaths();
    installLaunchAgent(program, p, recorder().run);
    const r = recorder();
    expect(uninstallLaunchAgent(p, r.run).ok).toBe(true);
    expect(existsSync(plistPath(p))).toBe(false);
    expect(r.calls[0]?.[1]).toBe('bootout');
    expect(uninstallLaunchAgent(p, recorder().run).message).toBe('launch agent not installed');
  });

  it('checks whether the agent is loaded', () => {
    expect(isLaunchAgentLoaded(recorder(0).run)).toBe(true);
    expect(isLaunchAgentLoaded(recorder(113).run)).toBe(false);
  });
});
