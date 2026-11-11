import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { ensurePrivateDir } from '../util/fs.js';
import { migrate } from './migrations.js';

export const nowIso = (): string => new Date().toISOString();
export const newId = (): string => randomUUID();

export interface AuditInput {
  action: string;
  objectId?: string | null;
  reasonCode?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
}

export class Store {
  readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  audit(input: AuditInput, at: string = nowIso()): void {
    this.db
      .prepare('INSERT INTO audit_events (id, timestamp, action, object_id, reason_code, metadata_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(newId(), at, input.action, input.objectId ?? null, input.reasonCode ?? null, JSON.stringify(input.metadata ?? {}));
  }

  incrementDiagnostic(key: string, at: string = nowIso()): void {
    this.db
      .prepare('INSERT INTO diagnostics (key, count, last_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1, last_at = excluded.last_at')
      .run(key, at);
  }

  diagnostics(): Record<string, { count: number; lastAt: string }> {
    const rows = this.db.prepare('SELECT key, count, last_at FROM diagnostics').all() as { key: string; count: number; last_at: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, { count: r.count, lastAt: r.last_at }]));
  }

  close(): void {
    this.db.close();
  }
}

/** Open (creating if needed) the AutoTune database with WAL, foreign keys and a short busy timeout. */
export function openStore(file: string, opts: { busyTimeoutMs?: number } = {}): Store {
  if (file !== ':memory:') ensurePrivateDir(dirname(file));
  const isNew = file !== ':memory:' && !existsSync(file);
  const db = new Database(file);
  db.pragma(`busy_timeout = ${opts.busyTimeoutMs ?? 2000}`);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  if (isNew) chmodSync(file, 0o600);
  migrate(db);
  return new Store(db);
}
