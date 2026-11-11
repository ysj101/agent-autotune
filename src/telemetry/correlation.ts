import type { HookToolEvent, Outcome } from '../hooks/types.js';
import { newId, nowIso, type Store } from '../store/sqlite.js';
import type { OtelToolResult } from './normalizer.js';

/**
 * Hook and OTel describe the same tool execution with the same `session_id + tool_use_id`.
 * Each source keeps its own row (UNIQUE(session_id, tool_use_id, source, event_type)), re-sends are
 * ignored, and counting de-duplicates by the join key. Rows without a tool_use_id are standalone:
 * joining by time proximity is deliberately not attempted.
 */

export const HOOK_EVENT_TYPES = { PostToolUse: 'hook_post_tool_use', PostToolUseFailure: 'hook_post_tool_use_failure' } as const;
export const OTEL_TOOL_RESULT = 'otel_tool_result';

export interface HookContext {
  projectId: string | null;
  packagePath: string | null;
  packageHash: string | null;
  observedAt?: string;
}

export interface RecordResult {
  id: string;
  inserted: boolean;
  /** True when this event contradicted the other source and both were downgraded to unknown. */
  conflict: boolean;
}

interface Row {
  id: string;
  source: string;
  outcome: Outcome;
}

const DECIDED = new Set<Outcome>(['success', 'failure']);

function insertEvent(store: Store, fields: Record<string, unknown>): RecordResult {
  return store.transaction(() => {
    const id = newId();
    const res = store.db
      .prepare(
        `INSERT INTO tool_events (id, session_id, tool_use_id, prompt_id, source, event_type, observed_at, project_id,
           package_path, package_hash, command_family, command_name, outcome, failure_code, duration_ms)
         VALUES (@id, @session_id, @tool_use_id, @prompt_id, @source, @event_type, @observed_at, @project_id,
           @package_path, @package_hash, @command_family, @command_name, @outcome, @failure_code, @duration_ms)
         ON CONFLICT(session_id, tool_use_id, source, event_type) DO NOTHING`,
      )
      .run({ ...fields, id });
    if (res.changes === 0) {
      const existing = store.db
        .prepare('SELECT id FROM tool_events WHERE session_id = ? AND tool_use_id = ? AND source = ? AND event_type = ?')
        .get(fields['session_id'], fields['tool_use_id'], fields['source'], fields['event_type']) as { id: string };
      return { id: existing.id, inserted: false, conflict: false };
    }
    return { id, inserted: true, conflict: reconcile(store, id, fields) };
  });
}

/** If the other source already reported a different decided outcome, neither is trusted. */
function reconcile(store: Store, id: string, fields: Record<string, unknown>): boolean {
  if (fields['tool_use_id'] === null) return false;
  const outcome = fields['outcome'] as Outcome;
  const others = store.db
    .prepare('SELECT id, source, outcome FROM tool_events WHERE session_id = ? AND tool_use_id = ? AND source != ?')
    .all(fields['session_id'], fields['tool_use_id'], fields['source']) as Row[];
  const conflicting = others.filter((o) => DECIDED.has(o.outcome) && DECIDED.has(outcome) && o.outcome !== outcome);
  if (conflicting.length === 0) return false;
  const ids = [id, ...conflicting.map((o) => o.id)];
  store.db.prepare(`UPDATE tool_events SET outcome = 'unknown' WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  store.incrementDiagnostic('outcome_conflict');
  store.audit({ action: 'tool_event.outcome_conflict', objectId: id, reasonCode: 'HOOK_OTEL_MISMATCH' });
  return true;
}

export function recordHookToolEvent(store: Store, ev: HookToolEvent, ctx: HookContext): RecordResult {
  return insertEvent(store, {
    session_id: ev.session_id,
    tool_use_id: ev.tool_use_id,
    prompt_id: ev.prompt_id,
    source: 'hook',
    event_type: HOOK_EVENT_TYPES[ev.event_type],
    observed_at: ctx.observedAt ?? nowIso(),
    project_id: ctx.projectId,
    package_path: ctx.packagePath,
    package_hash: ctx.packageHash,
    command_family: ev.command_family,
    command_name: ev.command_name,
    outcome: ev.outcome,
    failure_code: ev.failure_code,
    duration_ms: ev.duration_ms,
  });
}

export function recordOtelToolResult(store: Store, r: OtelToolResult): RecordResult {
  return insertEvent(store, {
    session_id: r.session_id,
    tool_use_id: r.tool_use_id,
    prompt_id: r.prompt_id,
    source: 'otel',
    event_type: OTEL_TOOL_RESULT,
    observed_at: r.observed_at,
    project_id: null,
    package_path: null,
    package_hash: null,
    command_family: null,
    command_name: null,
    outcome: r.outcome,
    failure_code: null,
    duration_ms: r.duration_ms,
  });
}

/** Distinct tool executions since a time: one per session+tool_use_id, plus every unjoinable row. */
export function countExecutions(store: Store, sinceIso: string): number {
  const row = store.db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM (SELECT 1 FROM tool_events WHERE tool_use_id IS NOT NULL AND observed_at >= ? GROUP BY session_id, tool_use_id))
       + (SELECT COUNT(*) FROM tool_events WHERE tool_use_id IS NULL AND observed_at >= ?) AS n`,
    )
    .get(sinceIso, sinceIso) as { n: number };
  return row.n;
}

export interface Execution {
  id: string;
  session_id: string;
  tool_use_id: string | null;
  observed_at: string;
  package_path: string;
  package_hash: string | null;
  command_name: string;
  outcome: Outcome;
  failure_code: string | null;
  duration_ms: number | null;
}

/**
 * Hook-observed npm script executions for one package.json, with OTel duration preferred when the
 * two are joined. Outcomes were already reconciled at ingest time.
 */
export function listNpmExecutions(store: Store, packagePath: string): Execution[] {
  return store.db
    .prepare(
      `SELECT h.id, h.session_id, h.tool_use_id, h.observed_at, h.package_path, h.package_hash, h.command_name,
              h.outcome, h.failure_code,
              COALESCE((SELECT o.duration_ms FROM tool_events o
                        WHERE o.source = 'otel' AND o.session_id = h.session_id AND o.tool_use_id = h.tool_use_id), h.duration_ms) AS duration_ms
       FROM tool_events h
       WHERE h.source = 'hook' AND h.package_path = ? AND h.command_family = 'npm_script'
       ORDER BY h.observed_at`,
    )
    .all(packagePath) as Execution[];
}
