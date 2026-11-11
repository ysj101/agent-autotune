import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { updateConfig, writeConfig } from '../../src/config/app-config.js';
import { runHook } from '../../src/hooks/handler.js';
import { ensureToken } from '../../src/security/local-token.js';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { tmpDir, tmpPaths } from '../helpers/tmp.js';

let d: TestDaemon | undefined;
afterEach(async () => {
  await d?.close();
  d = undefined;
});

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../fixtures/hooks/${name}`, import.meta.url), 'utf8'));

function projectDir(): string {
  const root = realpathSync(tmpDir('aat-proj-'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'test:unit': 'vitest' } }));
  return root;
}

async function run(event: string, input: string, env: Record<string, string>): Promise<string> {
  const stdout = new PassThrough();
  let out = '';
  stdout.on('data', (c) => (out += c));
  await runHook(event, { stdin: Readable.from([Buffer.from(input)]), stdout, env });
  return out;
}

const envFor = (t: TestDaemon): Record<string, string> => ({ HOME: t.paths.home });

describe('runHook', () => {
  it('forwards a normalized tool event to the daemon', async () => {
    d = await startTestDaemon();
    const cwd = projectDir();
    const input = { ...fixture('post-tool-use-failure-missing-script.json'), cwd };
    expect(await run('PostToolUseFailure', JSON.stringify(input), envFor(d))).toBe('');
    const row = d.store.db.prepare('SELECT command_name, failure_code, package_path FROM tool_events').get();
    expect(row).toEqual({ command_name: 'test', failure_code: 'NPM_MISSING_SCRIPT', package_path: join(cwd, 'package.json') });
  });

  it('prints additionalContext for SessionStart only when there is one', async () => {
    d = await startTestDaemon({ sessionStart: () => 'verified hint' });
    const input = JSON.stringify({ ...fixture('session-start.json'), cwd: projectDir() });
    const out = await run('SessionStart', input, envFor(d));
    expect(JSON.parse(out)).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'verified hint' } });
    await d.close();
    d = await startTestDaemon({ sessionStart: () => null });
    expect(await run('SessionStart', input, envFor(d))).toBe('');
  });

  it('is silent and does not contact the daemon when disabled', async () => {
    d = await startTestDaemon({ sessionStart: () => 'hint' });
    updateConfig(d.paths, { enabled: false });
    const input = JSON.stringify({ ...fixture('session-start.json'), cwd: projectDir() });
    expect(await run('SessionStart', input, envFor(d))).toBe('');
    expect(d.store.diagnostics()['hook.session_start.received']).toBeUndefined();
  });

  it.each([
    ['invalid JSON', 'not json'],
    ['empty', ''],
    ['array', '[]'],
    ['missing fields', '{"tool_name":"Bash"}'],
    ['huge', `{"x":"${'a'.repeat(300 * 1024)}"}`],
  ])('fails open on %s', async (_l, input) => {
    d = await startTestDaemon({ sessionStart: () => 'hint' });
    expect(await run('SessionStart', input, envFor(d))).toBe('');
    expect(await run('PostToolUse', input, envFor(d))).toBe('');
    expect(process.exitCode).toBe(0);
  });

  it('fails open without token or daemon', async () => {
    const p = tmpPaths();
    const input = JSON.stringify(fixture('session-start.json'));
    expect(await run('SessionStart', input, { HOME: p.home })).toBe('');
    ensureToken(p);
    writeConfig(p, { version: 1, port: 1025, enabled: true });
    expect(await run('SessionStart', input, { HOME: p.home })).toBe('');
  });

  it('gives up on a hanging daemon within the time budget', async () => {
    const p = tmpPaths();
    ensureToken(p);
    const hang = http.createServer(() => {});
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
    writeConfig(p, { version: 1, port: (hang.address() as { port: number }).port, enabled: true });
    const started = Date.now();
    expect(await run('SessionStart', JSON.stringify(fixture('session-start.json')), { HOME: p.home })).toBe('');
    expect(Date.now() - started).toBeLessThan(1500);
    hang.closeAllConnections();
    hang.close();
  });

  it('drops oversized additionalContext', async () => {
    d = await startTestDaemon({ sessionStart: () => 'x'.repeat(5000) });
    const input = JSON.stringify({ ...fixture('session-start.json'), cwd: projectDir() });
    expect(await run('SessionStart', input, envFor(d))).toBe('');
  });
});

const cli = new URL('../../dist/cli.js', import.meta.url).pathname;

describe.runIf(existsSync(cli))('hook process', () => {
  it('exits 0 with empty stdout when nothing is set up', () => {
    const home = tmpDir();
    for (const input of ['not json', JSON.stringify(fixture('session-start.json')), '']) {
      const r = spawnSync(process.execPath, [cli, 'hook', 'SessionStart'], { input, encoding: 'utf8', env: { ...process.env, HOME: home } });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('');
    }
  });
});
