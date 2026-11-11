import { readFileSync } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { runDisableRule, runSetEnabled } from '../../src/commands/toggle.js';
import { readConfig } from '../../src/config/app-config.js';
import { runHook } from '../../src/hooks/handler.js';
import { buildSessionContext } from '../../src/hooks/session-start.js';
import { loadHints } from '../../src/commands/hint-view.js';
import { openStore } from '../../src/store/sqlite.js';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { scenario } from '../helpers/scenario.js';
import { tmpPaths } from '../helpers/tmp.js';

let d: TestDaemon | undefined;
afterEach(async () => {
  await d?.close();
  d = undefined;
});

const io = (out: string[]) => ({ out: (l: string) => out.push(l), err: (l: string) => out.push(l) });

describe('disable / enable', () => {
  it('toggles config and records an audit event', () => {
    const paths = tmpPaths();
    openStore(paths.dbFile).close();
    const out: string[] = [];
    expect(runSetEnabled(false, { paths, io: io(out) })).toBe(0);
    expect(readConfig(paths).enabled).toBe(false);
    expect(runSetEnabled(true, { paths, io: io(out) })).toBe(0);
    expect(readConfig(paths).enabled).toBe(true);
    const store = openStore(paths.dbFile);
    expect((store.db.prepare('SELECT action FROM audit_events ORDER BY rowid').all() as { action: string }[]).map((r) => r.action)).toEqual(['autotune.disabled', 'autotune.enabled']);
  });

  it('makes the hook silent and the daemon discard events while disabled', async () => {
    d = await startTestDaemon({ sessionStart: () => 'hint' });
    runSetEnabled(false, { paths: d.paths, io: io([]) });
    const stdout = new PassThrough();
    let out = '';
    stdout.on('data', (c) => (out += c));
    const input = readFileSync(new URL('../fixtures/hooks/session-start.json', import.meta.url));
    await runHook('SessionStart', { stdin: Readable.from([input]), stdout, env: { HOME: d.paths.home } });
    expect(out).toBe('');
    const logs = JSON.parse(readFileSync(new URL('../fixtures/otlp/logs-tool-result-1.json', import.meta.url), 'utf8'));
    expect((await d.post('/v1/logs', logs)).status).toBe(200);
    expect((d.store.db.prepare('SELECT COUNT(*) n FROM tool_events').get() as { n: number }).n).toBe(0);
  });
});

describe('disable --rule', () => {
  function withHint() {
    const paths = tmpPaths();
    const store = openStore(paths.dbFile);
    const s = scenario(store);
    s.run('test', 'failure');
    s.run('test:unit', 'success');
    const id = loadHints(store, ['active'])[0]!.id;
    store.close();
    return { paths, s, id };
  }

  it('disables one hint by prefix so it is no longer injected', () => {
    const { paths, s, id } = withHint();
    const out: string[] = [];
    expect(runDisableRule(id.slice(0, 8), { paths, io: io(out) })).toBe(0);
    const store = openStore(paths.dbFile);
    expect(store.db.prepare('SELECT state, invalidated_reason FROM hints').get()).toEqual({ state: 'disabled', invalidated_reason: 'USER_DISABLED' });
    const ctx = { event: { kind: 'session_start' as const, session_id: 'new', cwd: s.root, source: null }, projectId: s.project.id, projectRoot: s.root };
    expect(buildSessionContext(store, ctx)).toBeNull();
    store.close();
    expect(runDisableRule(id, { paths, io: io(out) })).toBe(0);
    expect(out.at(-1)).toContain('already disabled');
  });

  it('rejects unknown, too short and malformed ids', () => {
    const { paths } = withHint();
    const out: string[] = [];
    expect(runDisableRule('ffffffff', { paths, io: io(out) })).toBe(1);
    expect(runDisableRule('ab', { paths, io: io(out) })).toBe(1);
    expect(runDisableRule("abcd' OR 1=1 --", { paths, io: io(out) })).toBe(1);
    expect(runDisableRule('%%%%', { paths, io: io(out) })).toBe(1);
    expect(runDisableRule('abcd', { paths: tmpPaths(), io: io(out) })).toBe(1);
  });
});
