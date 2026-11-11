import type Database from 'better-sqlite3';
import { MIGRATIONS, type Migration } from './schema.js';

export function currentVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/** Apply pending migrations. A database newer than this build is refused rather than altered. */
export function migrate(db: Database.Database, migrations: Migration[] = MIGRATIONS): number {
  const latest = migrations.at(-1)?.version ?? 0;
  const from = currentVersion(db);
  if (from > latest) throw new Error(`database schema v${from} is newer than supported v${latest}`);
  for (const m of migrations) {
    if (m.version <= currentVersion(db)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
  return currentVersion(db);
}
