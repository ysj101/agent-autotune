import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths, type Paths } from '../config/paths.js';
import { openStore } from '../store/sqlite.js';
import { confirm, consoleIo, type Io } from './common.js';

/** Child tables first so foreign keys never block the delete. */
export const DATA_TABLES = ['hint_deliveries', 'hints', 'tool_events', 'sessions', 'projects', 'audit_events', 'diagnostics', 'metric_points'] as const;

export interface PurgeDeps {
  paths: Paths;
  io: Io;
  confirm: (question: string) => Promise<boolean>;
}

/**
 * Delete every locally stored row and the daemon logs. Rows are deleted (then VACUUM) instead of
 * removing the file, so a running daemon keeps a valid database. Config, token and Claude Code
 * settings are left alone (`uninstall` handles those).
 */
export async function runPurge(opts: { yes?: boolean }, deps: PurgeDeps = { paths: resolvePaths(), io: consoleIo, confirm }): Promise<number> {
  const { paths, io } = deps;
  if (!existsSync(paths.dbFile) && !existsSync(paths.logDir)) {
    io.out('Nothing to purge.');
    return 0;
  }
  if (!opts.yes && !(await deps.confirm(`Delete all AutoTune data in ${paths.dataDir}? This cannot be undone.`))) {
    io.err('purge: aborted; nothing was deleted (use --yes to confirm non-interactively)');
    return 1;
  }
  let rows = 0;
  if (existsSync(paths.dbFile)) {
    const store = openStore(paths.dbFile);
    try {
      store.transaction(() => {
        for (const t of DATA_TABLES) rows += store.db.prepare(`DELETE FROM ${t}`).run().changes;
      });
      store.db.exec('VACUUM');
      store.db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      store.close();
    }
  }
  if (existsSync(paths.logDir)) for (const f of readdirSync(paths.logDir)) rmSync(join(paths.logDir, f), { force: true, recursive: true });
  io.out(`Purged ${rows} rows and daemon logs from ${paths.dataDir}.`);
  return 0;
}
