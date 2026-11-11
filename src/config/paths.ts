import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Paths {
  configDir: string;
  dataDir: string;
  configFile: string;
  tokenFile: string;
  manifestFile: string;
  dbFile: string;
  logDir: string;
  claudeSettingsFile: string;
  launchAgentsDir: string;
}

type Env = Record<string, string | undefined>;

/**
 * Resolve every location AutoTune reads or writes. Environment overrides exist so tests
 * (and unusual setups) never touch the real home directory.
 */
export function resolvePaths(env: Env = process.env): Paths {
  const home = env['HOME'] || homedir();
  const configDir = env['AGENT_AUTOTUNE_CONFIG_DIR'] || join(home, '.config', 'agent-autotune');
  const dataDir = env['AGENT_AUTOTUNE_DATA_DIR'] || join(home, '.local', 'share', 'agent-autotune');
  const claudeDir = env['CLAUDE_CONFIG_DIR'] || join(home, '.claude');
  return {
    configDir,
    dataDir,
    configFile: join(configDir, 'config.json'),
    tokenFile: join(configDir, 'token'),
    manifestFile: join(configDir, 'install-manifest.json'),
    dbFile: join(dataDir, 'agent-autotune.db'),
    logDir: join(dataDir, 'logs'),
    claudeSettingsFile: join(claudeDir, 'settings.json'),
    launchAgentsDir: env['AGENT_AUTOTUNE_LAUNCH_AGENTS_DIR'] || join(home, 'Library', 'LaunchAgents'),
  };
}
