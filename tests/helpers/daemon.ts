import { writeConfig } from '../../src/config/app-config.js';
import { createDaemon, type DaemonOptions } from '../../src/daemon/server.js';
import { ensureToken } from '../../src/security/local-token.js';
import { openStore, type Store } from '../../src/store/sqlite.js';
import { tmpPaths } from './tmp.js';

export interface TestDaemon {
  url: string;
  port: number;
  token: string;
  store: Store;
  paths: ReturnType<typeof tmpPaths>;
  post: (path: string, body: unknown, headers?: Record<string, string>) => Promise<Response>;
  close: () => Promise<void>;
}

export async function startTestDaemon(extra: Partial<DaemonOptions> = {}): Promise<TestDaemon> {
  const paths = tmpPaths();
  const token = ensureToken(paths);
  const store = openStore(paths.dbFile);
  const daemon = createDaemon({ paths, store, token, ...extra });
  const port = await daemon.listen(0);
  writeConfig(paths, { version: 1, port, enabled: true });
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    port,
    token,
    store,
    paths,
    post: (path, body, headers = {}) =>
      fetch(url + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    close: async () => {
      await daemon.close();
      store.close();
    },
  };
}
