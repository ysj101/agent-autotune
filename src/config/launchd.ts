import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir, writeFileAtomic } from '../util/fs.js';
import type { Paths } from './paths.js';

/** launchd user agent that keeps `agent-autotune daemon` running across logins and crashes. */

export const LAUNCHD_LABEL = 'com.agent-autotune.daemon';
const LAUNCHCTL = '/bin/launchctl';
/** Environment overrides forwarded to the daemon so it uses the same locations as `init`. */
const FORWARDED_ENV = ['AGENT_AUTOTUNE_CONFIG_DIR', 'AGENT_AUTOTUNE_DATA_DIR'];

export interface RunResult {
  status: number | null;
  stderr: string;
}
/** Runs a program directly (never through a shell). Injectable for tests. */
export type Runner = (program: string, args: string[]) => RunResult;

export const defaultRunner: Runner = (program, args) => {
  const r = spawnSync(program, args, { encoding: 'utf8', timeout: 10_000 });
  return { status: r.status, stderr: r.stderr ?? '' };
};

export interface DaemonProgram {
  nodePath: string;
  cliPath: string;
}

export function plistPath(paths: Paths): string {
  return join(paths.launchAgentsDir, `${LAUNCHD_LABEL}.plist`);
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderPlist(program: DaemonProgram, paths: Paths, env: Record<string, string | undefined> = process.env): string {
  const forwarded = FORWARDED_ENV.filter((k) => env[k]).map((k) => `    <key>${xml(k)}</key>\n    <string>${xml(env[k]!)}</string>\n`);
  const home = env['HOME'] ? `    <key>HOME</key>\n    <string>${xml(env['HOME'])}</string>\n` : '';
  const log = join(paths.logDir, 'daemon.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(program.nodePath)}</string>
    <string>${xml(program.cliPath)}</string>
    <string>daemon</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${home}${forwarded.join('')}  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

const domain = (): string => `gui/${process.getuid?.() ?? 0}`;

export interface LaunchdResult {
  ok: boolean;
  message: string;
}

/** Write the plist and (re)load it. Re-running replaces a previously loaded agent. */
export function installLaunchAgent(program: DaemonProgram, paths: Paths, run: Runner = defaultRunner): LaunchdResult {
  ensurePrivateDir(paths.logDir);
  ensurePrivateDir(paths.launchAgentsDir);
  const file = plistPath(paths);
  writeFileAtomic(file, renderPlist(program, paths), 0o644);
  run(LAUNCHCTL, ['bootout', `${domain()}/${LAUNCHD_LABEL}`]);
  const r = run(LAUNCHCTL, ['bootstrap', domain(), file]);
  return r.status === 0 ? { ok: true, message: `loaded ${LAUNCHD_LABEL}` } : { ok: false, message: `launchctl bootstrap failed: ${r.stderr.trim()}` };
}

export function uninstallLaunchAgent(paths: Paths, run: Runner = defaultRunner): LaunchdResult {
  const file = plistPath(paths);
  run(LAUNCHCTL, ['bootout', `${domain()}/${LAUNCHD_LABEL}`]);
  if (!existsSync(file)) return { ok: true, message: 'launch agent not installed' };
  rmSync(file);
  return { ok: true, message: `removed ${file}` };
}

export function isLaunchAgentLoaded(run: Runner = defaultRunner): boolean {
  return run(LAUNCHCTL, ['print', `${domain()}/${LAUNCHD_LABEL}`]).status === 0;
}
