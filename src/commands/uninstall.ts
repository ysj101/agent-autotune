import { rmSync } from 'node:fs';
import { planRemoval, readManifest, readSettings, writeSettings } from '../config/claude-settings.js';
import { defaultRunner, uninstallLaunchAgent, type Runner } from '../config/launchd.js';
import { resolvePaths, type Paths } from '../config/paths.js';
import { confirm, consoleIo, type Io } from './common.js';

export interface UninstallOptions {
  yes?: boolean;
  dryRun?: boolean;
  /** false leaves launchd alone (when init ran with --no-launchd). */
  launchd?: boolean;
}

export interface UninstallDeps {
  paths: Paths;
  run: Runner;
  io: Io;
  confirm: (question: string) => Promise<boolean>;
}

export function defaultUninstallDeps(): UninstallDeps {
  return { paths: resolvePaths(), run: defaultRunner, io: consoleIo, confirm };
}

/**
 * Remove only what `init` added: the env values and Hook entries recorded in the install manifest
 * (and still unchanged), plus the launchd agent. Collected data and the local token are kept;
 * `purge` deletes data.
 */
export async function runUninstall(opts: UninstallOptions, deps: UninstallDeps = defaultUninstallDeps()): Promise<number> {
  const { paths, io } = deps;
  const manifest = readManifest(paths.manifestFile);
  const settingsPath = manifest?.settingsPath ?? paths.claudeSettingsFile;
  const settings = readSettings(settingsPath);
  if (!settings.ok) {
    io.err(`uninstall: ${settings.reason}`);
    return 1;
  }
  const plan = manifest ? planRemoval(settings.value, manifest) : null;

  io.out(`Agent AutoTune uninstall${opts.dryRun ? ' (dry run)' : ''}`);
  if (!plan) io.out(`  ${settingsPath}: no install manifest found; settings are left untouched`);
  else if (!plan.changed) io.out(`  ${settingsPath}: nothing of AutoTune's left to remove`);
  else for (const r of plan.removed) io.out(`  remove ${r}`);
  for (const k of plan?.kept ?? []) io.out(`  keep   ${k.key} (${k.reason}); review it manually`);
  if (opts.launchd !== false) io.out('  stop and remove the launchd agent');
  if (opts.dryRun) return 0;

  if (!opts.yes && !(await deps.confirm('Remove these entries?'))) {
    io.err('uninstall: aborted; nothing was changed');
    return 1;
  }
  if (plan?.changed) {
    const backup = writeSettings(settingsPath, plan.next);
    if (backup) io.out(`  backup: ${backup}`);
  }
  const launchd = opts.launchd === false ? { ok: true, message: '' } : uninstallLaunchAgent(paths, deps.run);
  if (!launchd.ok) io.err(`uninstall: ${launchd.message}`);
  if (manifest && !plan?.kept.length) rmSync(paths.manifestFile, { force: true });
  io.out('Done. Local data is kept; run `agent-autotune purge` to delete it.');
  return launchd.ok ? 0 : 1;
}
