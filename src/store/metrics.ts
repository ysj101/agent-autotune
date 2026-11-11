import type { MetricPoint } from '../telemetry/normalizer.js';
import type { Store } from './sqlite.js';

/** Insert metric points; re-sent points (same series and interval) are ignored. Returns new rows. */
export function recordMetricPoints(store: Store, points: MetricPoint[]): number {
  const insert = store.db.prepare(
    `INSERT OR IGNORE INTO metric_points (name, series_key, start_time, time, day, temporality, value)
     VALUES (@name, @series_key, @start_time, @time, @day, @temporality, @value)`,
  );
  return store.transaction(() => points.reduce((n, p) => n + insert.run(p).changes, 0));
}

export interface DailyMetrics {
  day: string;
  sessions: number | null;
  tokens: number | null;
  costUsd: number | null;
}

/**
 * Per-day totals for the metrics Claude Code exported. Delta points are summed; for cumulative
 * series the latest value per series start is used. Days or metrics with no data are null (N/A).
 */
export function dailyMetrics(store: Store, sinceDay: string): DailyMetrics[] {
  const rows = store.db
    .prepare(
      `WITH per_series AS (
         SELECT name, day, series_key, start_time,
                CASE WHEN temporality = 'cumulative' THEN MAX(value) ELSE SUM(value) END AS v
         FROM metric_points WHERE day >= ?
         GROUP BY name, day, series_key, start_time, temporality
       )
       SELECT day, name, SUM(v) AS total FROM per_series GROUP BY day, name ORDER BY day`,
    )
    .all(sinceDay) as { day: string; name: string; total: number }[];
  const byDay = new Map<string, DailyMetrics>();
  for (const r of rows) {
    const d = byDay.get(r.day) ?? { day: r.day, sessions: null, tokens: null, costUsd: null };
    if (r.name === 'claude_code.session.count') d.sessions = r.total;
    if (r.name === 'claude_code.token.usage') d.tokens = r.total;
    if (r.name === 'claude_code.cost.usage') d.costUsd = r.total;
    byDay.set(r.day, d);
  }
  return [...byDay.values()];
}
