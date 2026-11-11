import { newId, nowIso, type Store } from './sqlite.js';

export interface ProjectRow {
  id: string;
  root_path: string;
  enabled: number;
  created_at: string;
}

export function ensureProject(store: Store, rootPath: string, at: string = nowIso()): ProjectRow {
  store.db.prepare('INSERT INTO projects (id, root_path, created_at) VALUES (?, ?, ?) ON CONFLICT(root_path) DO NOTHING').run(newId(), rootPath, at);
  return store.db.prepare('SELECT * FROM projects WHERE root_path = ?').get(rootPath) as ProjectRow;
}

export function touchSession(store: Store, sessionId: string, projectId: string, at: string = nowIso()): void {
  store.db
    .prepare(
      `INSERT INTO sessions (session_id, project_id, started_at, last_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    )
    .run(sessionId, projectId, at, at);
}
