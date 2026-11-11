/**
 * End-to-end scenarios from spec §12 (Integration Tests 1–7, 9), run against the built CLI as
 * real processes: `init`, a `daemon`, and one short-lived `hook` process per Claude Code event.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writePackage } from '../helpers/project.js';

const CLI = new URL('../../dist/cli.js', import.meta.url).pathname;
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const SECRET_ARG = 'sk-live-THIS-MUST-NOT-BE-STORED';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

// The whole suite shares one HOME and its projects, so they are created here and removed in
// afterAll rather than through the per-test tmpDir helper.
const suiteDirs: string[] = [];
function suiteDir(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  suiteDirs.push(d);
  return d;
}
function makeProject(scripts: Record<string, string>): string {
  const root = suiteDir('aat-e2e-proj-');
  mkdirSync(join(root, '.git'));
  writePackage(root, scripts);
  return root;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(25);
  }
}

describe.runIf(existsSync(CLI))('end-to-end', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let port: number;
  let daemon: ChildProcess | undefined;
  let daemonLog = '';

  const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20_000 });
  const hook = (event: string, payload: unknown) => {
    const started = Date.now();
    const r = spawnSync(process.execPath, [CLI, 'hook', event], { env, input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', timeout: 5000 });
    return { ...r, ms: Date.now() - started };
  };
  const db = () => new Database(join(home, '.local/share/agent-autotune/agent-autotune.db'), { readonly: true, fileMustExist: true });
  const query = <T>(sql: string, ...params: unknown[]): T[] => {
    const d = db();
    try {
      return d.prepare(sql).all(...params) as T[];
    } finally {
      d.close();
    }
  };
  const token = (): string => readFileSync(join(home, '.config/agent-autotune/token'), 'utf8').trim();

  async function startDaemon(): Promise<void> {
    daemon = spawn(process.execPath, [CLI, 'daemon'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    daemon.stderr!.on('data', (c) => (daemonLog += c));
    daemon.stdout!.on('data', (c) => (daemonLog += c));
    await until(() => daemonLog.includes('listening'));
  }
  async function stopDaemon(): Promise<void> {
    if (!daemon || daemon.exitCode !== null) return;
    const exited = new Promise((r) => daemon!.once('exit', r));
    daemon.kill('SIGTERM');
    await exited;
  }

  // Hook payloads shaped exactly like the real-device fixtures, pointed at a temp project.
  let toolUse = 0;
  const failure = (cwd: string, session: string, command = 'npm test') => ({
    ...fixture('hooks/post-tool-use-failure-missing-script.json'),
    session_id: session,
    cwd,
    tool_use_id: `toolu_e2e${++toolUse}`,
    tool_input: { command, description: 'Run tests' },
    error: `Exit code 1\nnpm error Missing script: "${command === 'npm test' ? 'test' : command.split(' ').at(-1)}"\nnpm error\nnpm error To see a list of scripts, run:\nnpm error   npm run`,
  });
  const success = (cwd: string, session: string, script: string) => ({
    ...fixture('hooks/post-tool-use-success-test-unit.json'),
    session_id: session,
    cwd,
    tool_use_id: `toolu_e2e${++toolUse}`,
    tool_input: { command: `npm run ${script}`, description: 'Run unit tests' },
    tool_response: { stdout: `> ${script}\n\nunit ok ${SECRET_ARG}`, stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
  });
  const sessionStart = (cwd: string, session: string, source = 'startup') => ({ ...fixture('hooks/session-start.json'), session_id: session, cwd, source });
  const contextOf = (out: string): string | null => (out ? (JSON.parse(out).hookSpecificOutput.additionalContext as string) : null);

  let projectA: string;

  beforeAll(async () => {
    home = suiteDir('aat-e2e-home-');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
    env = { PATH: process.env['PATH'], HOME: home };
    port = await freePort();
    const init = cli('init', '--yes', '--no-launchd', '--port', String(port));
    expect(init.status, init.stderr).toBe(0);
    await startDaemon();
    projectA = makeProject({ 'test:unit': 'vitest run', build: 'tsc' });
  });

  afterAll(async () => {
    await stopDaemon();
    for (const d of suiteDirs) rmSync(d, { recursive: true, force: true });
  });

  it('1. learns a verified hint from a Missing script failure and a later success', async () => {
    expect(hook('PostToolUseFailure', failure(projectA, 'session-a1')).status).toBe(0);
    expect(hook('PostToolUse', success(projectA, 'session-a2', 'test:unit')).status).toBe(0);
    const [hint] = await until(() => {
      const rows = query<{ state: string; failed_script: string; suggested_script: string }>('SELECT state, failed_script, suggested_script FROM hints');
      return rows.length && rows[0]!.state === 'active' ? rows : null;
    });
    expect(hint).toEqual({ state: 'active', failed_script: 'test', suggested_script: 'test:unit' });
  });

  it('joins OTel tool_result events with hook events by tool_use_id', async () => {
    const logs = fixture('otlp/logs-tool-result-1.json');
    const body = JSON.stringify(logs).replaceAll('toolu_fixture0003', `toolu_e2e1`).replaceAll('00000000-0000-4000-8000-000000000001', 'session-a1');
    const res = await fetch(`http://127.0.0.1:${port}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` }, body });
    expect(res.status).toBe(200);
    const rows = query<{ source: string }>("SELECT source FROM tool_events WHERE session_id = 'session-a1' AND tool_use_id = 'toolu_e2e1' ORDER BY source");
    expect(rows.map((r) => r.source)).toEqual(['hook', 'otel']);
  });

  it('2. returns the hint exactly once to a new session', () => {
    const first = hook('SessionStart', sessionStart(projectA, 'session-a3'));
    expect(first.status).toBe(0);
    expect(contextOf(first.stdout)).toContain('`npm run test:unit`が成功しており');
    expect(hook('SessionStart', sessionStart(projectA, 'session-a3', 'resume')).stdout).toBe('');
    expect(hook('SessionStart', sessionStart(projectA, 'session-a3', 'compact')).stdout).toBe('');
  });

  it('5. does not leak the hint into another project', () => {
    const projectB = makeProject({ 'test:unit': 'vitest run' });
    expect(hook('SessionStart', sessionStart(projectB, 'session-b1')).stdout).toBe('');
  });

  it('3. stops injecting once package.json changes', () => {
    writePackage(projectA, { 'test:unit': 'vitest run --coverage', build: 'tsc' });
    expect(hook('SessionStart', sessionStart(projectA, 'session-a4')).stdout).toBe('');
    expect(query<{ state: string; invalidated_reason: string }>('SELECT state, invalidated_reason FROM hints')).toEqual([{ state: 'stale', invalidated_reason: 'PACKAGE_CHANGED' }]);
  });

  it('4. does not inject when several candidates succeeded', async () => {
    const projectC = makeProject({ 'test:unit': 'vitest', 'test:e2e': 'playwright' });
    hook('PostToolUseFailure', failure(projectC, 'session-c1'));
    hook('PostToolUse', success(projectC, 'session-c1', 'test:unit'));
    hook('PostToolUse', success(projectC, 'session-c1', 'test:e2e'));
    await until(() => query<{ n: number }>('SELECT COUNT(*) n FROM hints WHERE package_path = ?', join(projectC, 'package.json'))[0]!.n === 2);
    await sleep(100);
    expect(hook('SessionStart', sessionStart(projectC, 'session-c2')).stdout).toBe('');
    const states = query<{ state: string }>('SELECT state FROM hints WHERE package_path = ?', join(projectC, 'package.json')).map((r) => r.state);
    expect(states.every((s) => s === 'candidate' || s === 'reverted')).toBe(true);
  });

  it('6. never blocks Claude Code: invalid input, DB lock, stopped daemon', async () => {
    for (const bad of ['not json', '', '[]', `{"x":"${'a'.repeat(300 * 1024)}"}`]) {
      const r = hook('PostToolUse', bad);
      expect([r.status, r.stdout, r.stderr]).toEqual([0, '', '']);
    }
    // An exclusive lock held by another process: the daemon answers with an error, the hook stays silent.
    const writer = new Database(join(home, '.local/share/agent-autotune/agent-autotune.db'));
    writer.exec('BEGIN EXCLUSIVE');
    const locked = hook('SessionStart', sessionStart(projectA, 'session-lock'));
    writer.exec('ROLLBACK');
    writer.close();
    expect([locked.status, locked.stdout]).toEqual([0, '']);
    expect(locked.ms).toBeLessThan(2000);

    await stopDaemon();
    const down = hook('SessionStart', sessionStart(projectA, 'session-down'));
    expect([down.status, down.stdout, down.stderr]).toEqual([0, '', '']);
    const downTool = hook('PostToolUseFailure', failure(projectA, 'session-down'));
    expect([downTool.status, downTool.stdout]).toEqual([0, '']);
    await startDaemon();
  });

  it('9. stores no token, prompt, command text, output or secret arguments', () => {
    hook('PostToolUse', success(projectA, 'session-secret', `test:unit`));
    const d = db();
    const dump = d
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((t) => JSON.stringify(d.prepare(`SELECT * FROM ${(t as { name: string }).name}`).all()))
      .join('\n');
    d.close();
    const logs = existsSync(join(home, '.local/share/agent-autotune/logs')) ? readdirSync(join(home, '.local/share/agent-autotune/logs')).join('') : '';
    for (const haystack of [dump, daemonLog, logs]) {
      expect(haystack).not.toContain(token());
      expect(haystack).not.toContain(SECRET_ARG);
      expect(haystack).not.toContain('npm run');
      expect(haystack).not.toContain('Missing script');
      expect(haystack).not.toContain('unit ok');
      expect(haystack).not.toContain('dev@example.com');
      expect(haystack).not.toContain('Run unit tests');
    }
    const status = cli('status');
    expect(status.stdout).not.toContain(token());
  });

  it('7. init twice does not duplicate settings; uninstall restores the original', () => {
    const settingsPath = join(home, '.claude', 'settings.json');
    const once = readFileSync(settingsPath, 'utf8');
    expect(cli('init', '--yes', '--no-launchd', '--port', String(port)).status).toBe(0);
    expect(readFileSync(settingsPath, 'utf8')).toBe(once);
    const parsed = JSON.parse(once);
    for (const event of ['SessionStart', 'PostToolUse', 'PostToolUseFailure']) expect(parsed.hooks[event]).toHaveLength(1);
    const un = cli('uninstall', '--yes', '--no-launchd');
    expect(un.status, un.stderr).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
  });

  it('status and rules work against the live data', () => {
    const status = cli('status');
    expect(status.status).toBe(0);
    expect(status.stdout).toContain('Daemon: running');
    expect(status.stdout).toMatch(/Observed tools \(7d\): \d+/);
    const rules = cli('rules');
    expect(rules.stdout).toContain('[stale]');
    expect(rules.stdout).toContain('stopped: PACKAGE_CHANGED');
  });
});
