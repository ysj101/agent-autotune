import type { InitDeps } from '../../src/commands/init.js';
import type { Runner } from '../../src/config/launchd.js';
import { tmpDir, tmpPaths } from './tmp.js';
import { join } from 'node:path';

export interface FakeEnv {
  deps: InitDeps;
  paths: ReturnType<typeof tmpPaths>;
  out: string[];
  err: string[];
  launchctl: string[][];
}

export function fakeInitDeps(over: Partial<InitDeps> = {}): FakeEnv {
  const paths = tmpPaths();
  const out: string[] = [];
  const err: string[] = [];
  const launchctl: string[][] = [];
  const run: Runner = (program, args) => (launchctl.push([program, ...args]), { status: 0, stderr: '' });
  const deps: InitDeps = {
    paths,
    program: { nodePath: '/usr/local/bin/node', cliPath: '/opt/agent-autotune/dist/cli.js' },
    run,
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    confirm: async () => true,
    isPortFree: async () => true,
    isOurDaemon: async () => false,
    managedSettingsPath: join(tmpDir(), 'managed-settings.json'),
    ...over,
  };
  return { deps, paths, out, err, launchctl };
}
