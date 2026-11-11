import { DEFAULT_PORT, readConfig, writeConfig } from '../config/app-config.js';
import { planMerge, readManagedSettings, readManifest, readSettings, writeManifest, writeSettings, MANAGED_SETTINGS_PATH } from '../config/claude-settings.js';
import { defaultRunner, installLaunchAgent, plistPath, type DaemonProgram, type Runner } from '../config/launchd.js';
import { resolvePaths, type Paths } from '../config/paths.js';
import { ensureToken, generateToken, readToken } from '../security/local-token.js';
import { openStore } from '../store/sqlite.js';
import { confirm, consoleIo, daemonHealth, isPortFree, resolveProgram, type Io } from './common.js';

export interface InitOptions {
  dryRun?: boolean;
  yes?: boolean;
  /** false skips launchd registration (tests, or running the daemon by hand). */
  launchd?: boolean;
  port?: number;
}

export interface InitDeps {
  paths: Paths;
  program: DaemonProgram;
  run: Runner;
  io: Io;
  confirm: (question: string) => Promise<boolean>;
  isPortFree: (port: number) => Promise<boolean>;
  isOurDaemon: (port: number, token: string) => Promise<boolean>;
  managedSettingsPath: string;
}

const PORT_ATTEMPTS = 10;

export function defaultInitDeps(): InitDeps {
  return {
    paths: resolvePaths(),
    program: resolveProgram(),
    run: defaultRunner,
    io: consoleIo,
    confirm,
    isPortFree,
    isOurDaemon: async (port, token) => (await daemonHealth(port, token)) !== null,
    managedSettingsPath: MANAGED_SETTINGS_PATH,
  };
}

/**
 * Pick the receiver port: the configured one if it is free or already served by our daemon,
 * otherwise the next free port. CLI, Hooks (via config.json) and the OTLP endpoint all use it.
 */
async function choosePort(start: number, token: string | null, deps: InitDeps): Promise<number | null> {
  for (let port = start; port < start + PORT_ATTEMPTS && port <= 65535; port++) {
    if (await deps.isPortFree(port)) return port;
    if (token && (await deps.isOurDaemon(port, token))) return port;
  }
  return null;
}

export async function runInit(opts: InitOptions, deps: InitDeps = defaultInitDeps()): Promise<number> {
  const { paths, io } = deps;
  const existingToken = readToken(paths);
  const config = readConfig(paths);
  const previous = readManifest(paths.manifestFile);

  const port = await choosePort(opts.port ?? config.port ?? DEFAULT_PORT, existingToken, deps);
  if (port === null) {
    io.err(`init: no free port in ${opts.port ?? config.port}..${(opts.port ?? config.port) + PORT_ATTEMPTS - 1}. Free one or pass --port <n>.`);
    return 1;
  }

  const settings = readSettings(paths.claudeSettingsFile);
  if (!settings.ok) {
    io.err(`init: ${settings.reason}`);
    return 1;
  }
  // The token is only generated for real runs; a dry run plans with a throwaway value.
  const planToken = existingToken ?? generateToken();
  const plan = planMerge(settings.value, {
    port,
    token: planToken,
    hook: { command: deps.program.nodePath, argsPrefix: [deps.program.cliPath, 'hook'] },
    previous,
    managed: readManagedSettings(deps.managedSettingsPath),
  });
  if (!plan.ok) {
    io.err(`init: stopped without changing anything. ${paths.claudeSettingsFile} or managed settings conflict with AutoTune:`);
    for (const c of plan.conflicts) io.err(`  - ${c.key}: ${c.reason}`);
    io.err('Resolve these entries (remove them or point them at AutoTune), then run init again.');
    return 1;
  }

  io.out(`Agent AutoTune init${opts.dryRun ? ' (dry run)' : ''}`);
  io.out(`  receiver: 127.0.0.1:${port}${port !== config.port ? ` (was ${config.port})` : ''}`);
  io.out(`  config:   ${paths.configFile} (0600), token ${existingToken ? 'kept' : 'generated'} at ${paths.tokenFile} (0600)`);
  io.out(`  data:     ${paths.dbFile}`);
  if (plan.changes.length) {
    io.out(`  ${paths.claudeSettingsFile}:`);
    for (const c of plan.changes) io.out(`    ${c}`);
  } else {
    io.out(`  ${paths.claudeSettingsFile}: already up to date`);
  }
  if (opts.launchd !== false) io.out(`  launchd:  ${plistPath(paths)}`);
  if (opts.dryRun) return 0;

  if (!opts.yes && !(await deps.confirm('Apply these changes?'))) {
    io.err('init: aborted; nothing was changed (use --yes to apply non-interactively)');
    return 1;
  }

  const token = ensureToken(paths, planToken);
  if (token !== planToken) {
    io.err('init: the token changed while planning; run init again');
    return 1;
  }
  writeConfig(paths, { version: 1, port, enabled: config.enabled });
  openStore(paths.dbFile).close();
  if (plan.changed) {
    const backup = writeSettings(paths.claudeSettingsFile, plan.next);
    if (backup) io.out(`  backup:   ${backup}`);
  }
  writeManifest(paths.manifestFile, { ...plan.manifest, settingsPath: paths.claudeSettingsFile });
  if (opts.launchd !== false) {
    const r = installLaunchAgent(deps.program, paths, deps.run);
    if (!r.ok) {
      io.err(`init: ${r.message}. Settings were applied; start the daemon with \`agent-autotune daemon\` or rerun init.`);
      return 1;
    }
  }
  io.out('Done. Start `claude` as usual; check with `agent-autotune doctor` / `agent-autotune status`.');
  return 0;
}
