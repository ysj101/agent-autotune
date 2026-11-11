import { statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { currentVersion, migrate } from '../../src/store/migrations.js';
import { SCHEMA_VERSION } from '../../src/store/schema.js';
import { openStore } from '../../src/store/sqlite.js';
import { tmpDir } from '../helpers/tmp.js';

describe('store', () => {
  it('creates the schema with WAL and foreign keys in a private file', () => {
    const file = join(tmpDir(), 'data', 'agent-autotune.db');
    const store = openStore(file);
    expect(store.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(store.db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(currentVersion(store.db)).toBe(SCHEMA_VERSION);
    const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['projects', 'sessions', 'tool_events', 'hints', 'hint_deliveries', 'audit_events', 'diagnostics', 'metric_points']));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    store.close();
  });

  it('is idempotent across reopen', () => {
    const file = join(tmpDir(), 'a.db');
    openStore(file).close();
    const s = openStore(file);
    expect(currentVersion(s.db)).toBe(SCHEMA_VERSION);
    s.close();
  });

  it('refuses a database newer than this build', () => {
    const db = new Database(':memory:');
    db.pragma('user_version = 999');
    expect(() => migrate(db)).toThrow(/newer/);
  });

  it('enforces foreign keys and hint uniqueness', () => {
    const s = openStore(':memory:');
    const insertHint = s.db.prepare(
      `INSERT INTO hints (id, project_id, package_path, package_hash, failed_script, suggested_script, state, evidence_event_ids_json, created_at, updated_at)
       VALUES (?, 'p1', '/p/package.json', 'h', 'test', 'test:unit', 'candidate', '[]', 't', 't')`,
    );
    expect(() => insertHint.run('h1')).toThrow(/FOREIGN KEY/);
    s.db.prepare("INSERT INTO projects (id, root_path, created_at) VALUES ('p1', '/p', 't')").run();
    insertHint.run('h1');
    expect(() => insertHint.run('h2')).toThrow(/UNIQUE/);
    expect(() =>
      s.db.prepare("UPDATE hints SET state = 'bogus' WHERE id = 'h1'").run(),
    ).toThrow(/CHECK/);
  });

  it('records audit events and diagnostic counters', () => {
    const s = openStore(':memory:');
    s.audit({ action: 'hint.created', objectId: 'h1', metadata: { n: 1 } });
    s.incrementDiagnostic('outcome_conflict');
    s.incrementDiagnostic('outcome_conflict');
    expect(s.diagnostics()['outcome_conflict']?.count).toBe(2);
    const row = s.db.prepare('SELECT action, metadata_json FROM audit_events').get() as { action: string; metadata_json: string };
    expect(row).toEqual({ action: 'hint.created', metadata_json: '{"n":1}' });
  });
});
