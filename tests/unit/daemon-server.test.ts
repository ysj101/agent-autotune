import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { updateConfig } from '../../src/config/app-config.js';
import type { HookToolEvent } from '../../src/hooks/types.js';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { tmpDir } from '../helpers/tmp.js';

let d: TestDaemon | undefined;
afterEach(async () => {
  await d?.close();
  d = undefined;
});

const logsFixture = JSON.parse(readFileSync(new URL('../fixtures/otlp/logs-tool-result-1.json', import.meta.url), 'utf8'));
const metricsFixture = JSON.parse(readFileSync(new URL('../fixtures/otlp/metrics-1.json', import.meta.url), 'utf8'));
const count = (t: TestDaemon, table: string): number => (t.store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

function projectDir(): string {
  const root = realpathSync(tmpDir('aat-proj-'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'test:unit': 'vitest' } }));
  return root;
}

const toolEvent = (cwd: string, over: Partial<HookToolEvent> = {}): HookToolEvent => ({
  kind: 'tool',
  event_type: 'PostToolUseFailure',
  session_id: 's1',
  tool_use_id: 't1',
  prompt_id: null,
  cwd,
  command_family: 'npm_script',
  command_name: 'test',
  outcome: 'failure',
  failure_code: 'NPM_MISSING_SCRIPT',
  duration_ms: 5,
  ...over,
});

describe('daemon server', () => {
  it('accepts OTLP logs and metrics with a well-formed response', async () => {
    d = await startTestDaemon();
    const r = await d.post('/v1/logs', logsFixture);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({});
    expect(count(d, 'tool_events')).toBeGreaterThan(0);
    expect((await d.post('/v1/metrics', metricsFixture)).status).toBe(200);
    expect(count(d, 'metric_points')).toBeGreaterThan(0);
    expect(d.store.diagnostics()['otlp.logs.received']?.count).toBe(1);
  });

  it('rejects requests without the token', async () => {
    d = await startTestDaemon();
    expect((await d.post('/v1/logs', logsFixture, { authorization: '' })).status).toBe(401);
    expect((await d.post('/v1/logs', logsFixture, { authorization: 'Bearer wrong-token-value-that-is-long-enough' })).status).toBe(401);
    expect((await fetch(`${d.url}/health`)).status).toBe(401);
    expect(count(d, 'tool_events')).toBe(0);
  });

  it('answers health with the token', async () => {
    d = await startTestDaemon();
    const r = await fetch(`${d.url}/health`, { headers: { authorization: `Bearer ${d.token}` } });
    expect(await r.json()).toMatchObject({ ok: true, enabled: true });
  });

  it('rejects oversized, non-JSON and unknown requests', async () => {
    d = await startTestDaemon();
    expect((await d.post('/v1/logs', `{"a":"${'x'.repeat(300 * 1024)}"}`)).status).toBe(413);
    expect((await d.post('/v1/logs', 'not json')).status).toBe(400);
    expect((await d.post('/v1/logs', '{}', { 'content-type': 'application/x-protobuf' })).status).toBe(415);
    expect((await d.post('/v1/traces', {})).status).toBe(404);
    const err = await d.post('/v1/logs', '[]');
    expect(err.status).toBe(400);
    expect(await err.json()).toMatchObject({ code: 3 });
  });

  it('stores hook tool events with the resolved package and notifies analysis', async () => {
    const seen: string[] = [];
    d = await startTestDaemon({ onToolRecorded: (r) => seen.push(r.packagePath ?? 'none') });
    const root = projectDir();
    expect((await d.post('/hook/tool', toolEvent(root))).status).toBe(200);
    await new Promise((r) => setImmediate(r));
    const row = d.store.db.prepare('SELECT package_path, package_hash, command_name, outcome FROM tool_events').get() as Record<string, string>;
    expect(row).toMatchObject({ package_path: join(root, 'package.json'), command_name: 'test', outcome: 'failure' });
    expect(row['package_hash']).toMatch(/^[0-9a-f]{64}$/);
    expect(seen).toEqual([join(root, 'package.json')]);
    expect(count(d, 'sessions')).toBe(1);
  });

  it('re-validates hook events', async () => {
    d = await startTestDaemon();
    const root = projectDir();
    expect((await d.post('/hook/tool', { ...toolEvent(root), command_name: 'test; rm -rf /' })).status).toBe(400);
    expect((await d.post('/hook/tool', { ...toolEvent(root), stdout: 'secret' })).status).toBe(200);
    expect(JSON.stringify(d.store.db.prepare('SELECT * FROM tool_events').all())).not.toContain('secret');
  });

  it('returns additionalContext only when the session handler provides one', async () => {
    d = await startTestDaemon({ sessionStart: ({ event }) => (event.session_id === 'with' ? 'hint text' : null) });
    const root = projectDir();
    const r1 = await d.post('/hook/session-start', { kind: 'session_start', session_id: 'with', cwd: root, source: 'startup' });
    expect(await r1.json()).toEqual({ additionalContext: 'hint text' });
    const r2 = await d.post('/hook/session-start', { kind: 'session_start', session_id: 'without', cwd: root, source: 'startup' });
    expect(await r2.json()).toEqual({});
  });

  it('accepts but discards everything while disabled', async () => {
    d = await startTestDaemon({ sessionStart: () => 'hint' });
    updateConfig(d.paths, { enabled: false });
    expect((await d.post('/v1/logs', logsFixture)).status).toBe(200);
    expect((await d.post('/hook/tool', toolEvent(projectDir()))).status).toBe(200);
    const r = await d.post('/hook/session-start', { kind: 'session_start', session_id: 's', cwd: projectDir(), source: null });
    expect(await r.json()).toEqual({});
    expect(count(d, 'tool_events')).toBe(0);
  });

  it('survives handler exceptions', async () => {
    d = await startTestDaemon({
      sessionStart: () => {
        throw new Error('boom');
      },
    });
    const r = await d.post('/hook/session-start', { kind: 'session_start', session_id: 's', cwd: projectDir(), source: null });
    expect(r.status).toBe(500);
    expect((await d.post('/v1/logs', logsFixture)).status).toBe(200);
  });
});
