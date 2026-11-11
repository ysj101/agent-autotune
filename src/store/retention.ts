import { nowIso, type Store } from './sqlite.js';

const DAY_MS = 86_400_000;
export const TOOL_EVENT_RETENTION_DAYS = 30;
export const HISTORY_RETENTION_DAYS = 90;

export interface RetentionResult {
  toolEvents: number;
  metricPoints: number;
  sessions: number;
  hints: number;
  deliveries: number;
  auditEvents: number;
}

const daysBefore = (now: Date, days: number): string => new Date(now.getTime() - days * DAY_MS).toISOString();

/**
 * Delete data past its retention: tool events and metrics after 30 days; sessions, hint
 * deliveries, finished hints and audit history after 90 days. Hints that can still be injected
 * (candidate/verified/active) are kept regardless of age; their validity is checked against
 * package.json, not against event age.
 */
export function applyRetention(store: Store, now: Date = new Date()): RetentionResult {
  const events = daysBefore(now, TOOL_EVENT_RETENTION_DAYS);
  const history = daysBefore(now, HISTORY_RETENTION_DAYS);
  const run = (sql: string, ...params: string[]): number => store.db.prepare(sql).run(...params).changes;
  const result = store.transaction(() => ({
    toolEvents: run('DELETE FROM tool_events WHERE observed_at < ?', events),
    metricPoints: run('DELETE FROM metric_points WHERE day < ?', events.slice(0, 10)),
    deliveries: run('DELETE FROM hint_deliveries WHERE delivered_at < ?', history),
    hints: run("DELETE FROM hints WHERE updated_at < ? AND state NOT IN ('candidate', 'verified', 'active')", history),
    sessions: run('DELETE FROM sessions WHERE last_seen_at < ?', history),
    auditEvents: run('DELETE FROM audit_events WHERE timestamp < ?', history),
  }));
  if (Object.values(result).some((n) => n > 0)) {
    store.audit({ action: 'retention.applied', metadata: { ...result } }, nowIso());
  }
  return result;
}
