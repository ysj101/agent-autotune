/**
 * Versioned schema migrations. Each entry is applied once, in order, inside a transaction;
 * the applied version is tracked with `PRAGMA user_version`.
 */
export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE tool_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_use_id TEXT,
  prompt_id TEXT,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  project_id TEXT,
  package_path TEXT,
  package_hash TEXT,
  command_family TEXT,
  command_name TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'unknown')),
  failure_code TEXT,
  duration_ms INTEGER,
  UNIQUE(session_id, tool_use_id, source, event_type)
);
CREATE INDEX tool_events_package ON tool_events(package_path, command_family, command_name);
CREATE INDEX tool_events_observed ON tool_events(observed_at);

CREATE TABLE hints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  package_path TEXT NOT NULL,
  package_hash TEXT NOT NULL,
  failed_script TEXT NOT NULL,
  suggested_script TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('candidate', 'verified', 'active', 'stale', 'disabled', 'reverted')),
  version INTEGER NOT NULL DEFAULT 1,
  evidence_event_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  invalidated_reason TEXT
);
CREATE UNIQUE INDEX hints_logical
  ON hints(project_id, package_path, failed_script, suggested_script, package_hash);

CREATE TABLE hint_deliveries (
  session_id TEXT NOT NULL,
  hint_id TEXT NOT NULL REFERENCES hints(id) ON DELETE CASCADE,
  hint_version INTEGER NOT NULL,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (session_id, hint_id, hint_version)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  action TEXT NOT NULL,
  object_id TEXT,
  reason_code TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_events_timestamp ON audit_events(timestamp);

CREATE TABLE diagnostics (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  last_at TEXT NOT NULL
);

CREATE TABLE metric_points (
  name TEXT NOT NULL,
  series_key TEXT NOT NULL,
  start_time TEXT NOT NULL,
  time TEXT NOT NULL,
  day TEXT NOT NULL,
  temporality TEXT NOT NULL CHECK (temporality IN ('delta', 'cumulative', 'unknown')),
  value REAL NOT NULL,
  PRIMARY KEY (name, series_key, start_time, time)
);
CREATE INDEX metric_points_day ON metric_points(day);
`,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
