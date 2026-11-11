import { realpathSync } from 'node:fs';
import net from 'node:net';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { HOST } from '../config/app-config.js';
import type { DaemonProgram } from '../config/launchd.js';

/** Absolute node binary and CLI script, resolved once at install time for Hooks and launchd. */
export function resolveProgram(): DaemonProgram {
  return { nodePath: process.execPath, cliPath: realpathSync(fileURLToPath(new URL('../cli.js', import.meta.url))) };
}

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, HOST, () => srv.close(() => resolve(true)));
  });
}

export interface Health {
  ok: boolean;
  version?: string;
  enabled?: boolean;
}

/** Ask the daemon on `port` whether it is ours (it accepts our token). */
export async function daemonHealth(port: number, token: string, timeoutMs = 1000): Promise<Health | null> {
  try {
    const res = await fetch(`http://${HOST}:${port}/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) return null;
    return (await res.json()) as Health;
  } catch {
    return null;
  }
}

/** y/N prompt. Without a TTY the answer is always no, so nothing changes unattended by accident. */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const consoleIo: Io = {
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
};
