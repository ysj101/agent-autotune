import { readConfig } from '../config/app-config.js';
import { resolvePaths } from '../config/paths.js';
import { createDaemon } from '../daemon/server.js';
import { buildSessionContext } from '../hooks/session-start.js';
import { evaluatePackage } from '../rules/engine.js';
import { readToken } from '../security/local-token.js';
import { applyRetention } from '../store/retention.js';
import { openStore } from '../store/sqlite.js';

const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

export async function runDaemon(): Promise<void> {
  const paths = resolvePaths();
  const token = readToken(paths);
  if (!token) {
    process.stderr.write('agent-autotune daemon: no local token; run `agent-autotune init` first\n');
    process.exitCode = 1;
    return;
  }
  // better-sqlite3 waits synchronously on locks, so the daemon keeps the wait short: a locked DB
  // turns into a quick error for one request instead of stalling every hook behind it.
  const store = openStore(paths.dbFile, { busyTimeoutMs: 250 });
  const retention = (): void => {
    try {
      applyRetention(store);
    } catch {
      store.incrementDiagnostic('daemon.retention_error');
    }
  };
  retention();
  setInterval(retention, RETENTION_INTERVAL_MS).unref();
  const daemon = createDaemon({
    paths,
    store,
    token,
    onToolRecorded: ({ projectId, projectRoot, packagePath }) => {
      if (packagePath) evaluatePackage(store, { projectId, projectRoot, packagePath });
    },
    sessionStart: (ctx) => buildSessionContext(store, ctx),
  });
  const port = await daemon.listen(readConfig(paths).port);
  process.stderr.write(`agent-autotune daemon listening on 127.0.0.1:${port}\n`);
  const stop = (): void => {
    void daemon.close().then(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
