import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATA_TABLES, runPurge } from '../../src/commands/purge.js';
import { ensureToken } from '../../src/security/local-token.js';
import { openStore } from '../../src/store/sqlite.js';
import { scenario } from '../helpers/scenario.js';
import { tmpPaths } from '../helpers/tmp.js';

function populated() {
  const paths = tmpPaths();
  ensureToken(paths);
  const store = openStore(paths.dbFile);
  const s = scenario(store);
  s.run('test', 'failure');
  s.run('test:unit', 'success');
  store.db.prepare("INSERT INTO hint_deliveries SELECT 's1', id, version, 't' FROM hints").run();
  store.incrementDiagnostic('otlp.logs.received');
  store.close();
  mkdirSync(paths.logDir, { recursive: true });
  writeFileSync(join(paths.logDir, 'daemon.log'), 'log');
  return paths;
}

const total = (paths: ReturnType<typeof tmpPaths>): number => {
  const store = openStore(paths.dbFile);
  const n = DATA_TABLES.reduce((sum, t) => sum + (store.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n, 0);
  store.close();
  return n;
};

describe('purge', () => {
  it('deletes all rows and logs after confirmation, keeping the token', async () => {
    const paths = populated();
    expect(total(paths)).toBeGreaterThan(0);
    const out: string[] = [];
    expect(await runPurge({}, { paths, io: { out: (l) => out.push(l), err: (l) => out.push(l) }, confirm: async () => true })).toBe(0);
    expect(total(paths)).toBe(0);
    expect(readdirSync(paths.logDir)).toEqual([]);
    expect(existsSync(paths.tokenFile)).toBe(true);
    expect(out.join('\n')).toMatch(/Purged \d+ rows/);
  });

  it('works while another connection (the daemon) has the database open', async () => {
    const paths = populated();
    const daemonConn = openStore(paths.dbFile);
    await runPurge({ yes: true }, { paths, io: { out: () => {}, err: () => {} }, confirm: async () => false });
    expect((daemonConn.db.prepare('SELECT COUNT(*) n FROM tool_events').get() as { n: number }).n).toBe(0);
    daemonConn.close();
  });

  it('deletes nothing without confirmation', async () => {
    const paths = populated();
    const before = total(paths);
    expect(await runPurge({}, { paths, io: { out: () => {}, err: () => {} }, confirm: async () => false })).toBe(1);
    expect(total(paths)).toBe(before);
  });

  it('covers every data table in the schema', () => {
    const store = openStore(':memory:');
    const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
    expect(new Set(tables)).toEqual(new Set(DATA_TABLES));
  });

  it('is a no-op on a fresh machine', async () => {
    const out: string[] = [];
    expect(await runPurge({ yes: true }, { paths: tmpPaths(), io: { out: (l) => out.push(l), err: () => {} }, confirm: async () => true })).toBe(0);
    expect(out).toEqual(['Nothing to purge.']);
  });
});
