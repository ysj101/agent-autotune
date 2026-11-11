import { describe, expect, it } from 'vitest';
import type { HookToolEvent } from '../../src/hooks/types.js';
import { dailyMetrics, recordMetricPoints } from '../../src/store/metrics.js';
import { ensureProject, touchSession } from '../../src/store/projects.js';
import { openStore } from '../../src/store/sqlite.js';
import { countExecutions, listNpmExecutions, recordHookToolEvent, recordOtelToolResult } from '../../src/telemetry/correlation.js';
import type { MetricPoint, OtelToolResult } from '../../src/telemetry/normalizer.js';

const hook = (over: Partial<HookToolEvent> = {}): HookToolEvent => ({
  kind: 'tool',
  event_type: 'PostToolUseFailure',
  session_id: 's1',
  tool_use_id: 't1',
  prompt_id: 'p1',
  cwd: '/proj',
  command_family: 'npm_script',
  command_name: 'test',
  outcome: 'failure',
  failure_code: 'NPM_MISSING_SCRIPT',
  duration_ms: 10,
  ...over,
});

const otel = (over: Partial<OtelToolResult> = {}): OtelToolResult => ({
  session_id: 's1',
  tool_use_id: 't1',
  prompt_id: 'p1',
  event_sequence: 1,
  tool_name: 'Bash',
  outcome: 'failure',
  duration_ms: 1349,
  observed_at: '2026-11-11T00:00:01.000Z',
  ...over,
});

const ctx = { projectId: null, packagePath: '/proj/package.json', packageHash: 'h1', observedAt: '2026-11-11T00:00:00.000Z' };
const outcomes = (s: ReturnType<typeof openStore>): string[] =>
  (s.db.prepare('SELECT outcome FROM tool_events ORDER BY source').all() as { outcome: string }[]).map((r) => r.outcome);

describe('correlation', () => {
  it('joins hook-first and OTel-late without double counting', () => {
    const s = openStore(':memory:');
    expect(recordHookToolEvent(s, hook(), ctx).inserted).toBe(true);
    expect(recordOtelToolResult(s, otel()).inserted).toBe(true);
    expect(countExecutions(s, '2026-01-01')).toBe(1);
    const [e] = listNpmExecutions(s, '/proj/package.json');
    expect(e).toMatchObject({ command_name: 'test', outcome: 'failure', duration_ms: 1349 });
  });

  it('joins OTel-first and hook-late the same way', () => {
    const s = openStore(':memory:');
    recordOtelToolResult(s, otel());
    recordHookToolEvent(s, hook(), ctx);
    expect(countExecutions(s, '2026-01-01')).toBe(1);
    expect(outcomes(s)).toEqual(['failure', 'failure']);
  });

  it('ignores re-sent events', () => {
    const s = openStore(':memory:');
    const a = recordOtelToolResult(s, otel());
    const b = recordOtelToolResult(s, otel({ duration_ms: 1 }));
    expect(b).toEqual({ id: a.id, inserted: false, conflict: false });
    recordHookToolEvent(s, hook(), ctx);
    recordHookToolEvent(s, hook(), ctx);
    expect((s.db.prepare('SELECT COUNT(*) n FROM tool_events').get() as { n: number }).n).toBe(2);
  });

  it('downgrades contradicting outcomes to unknown and counts the diagnostic', () => {
    const s = openStore(':memory:');
    recordHookToolEvent(s, hook({ event_type: 'PostToolUse', outcome: 'success', failure_code: null }), ctx);
    const r = recordOtelToolResult(s, otel({ outcome: 'failure' }));
    expect(r.conflict).toBe(true);
    expect(outcomes(s)).toEqual(['unknown', 'unknown']);
    expect(s.diagnostics()['outcome_conflict']?.count).toBe(1);
    // a re-send of the conflicting event does not count again
    recordOtelToolResult(s, otel({ outcome: 'failure' }));
    expect(s.diagnostics()['outcome_conflict']?.count).toBe(1);
  });

  it('does not upgrade an unknown hook outcome from OTel', () => {
    const s = openStore(':memory:');
    recordHookToolEvent(s, hook({ outcome: 'unknown', failure_code: null }), ctx);
    expect(recordOtelToolResult(s, otel({ outcome: 'success' })).conflict).toBe(false);
    expect(listNpmExecutions(s, '/proj/package.json')[0]?.outcome).toBe('unknown');
  });

  it('never joins events without tool_use_id', () => {
    const s = openStore(':memory:');
    recordHookToolEvent(s, hook({ tool_use_id: null, outcome: 'success' }), ctx);
    recordOtelToolResult(s, otel({ tool_use_id: null, outcome: 'failure' }));
    recordOtelToolResult(s, otel({ tool_use_id: null, outcome: 'failure' }));
    expect(countExecutions(s, '2026-01-01')).toBe(3);
    expect(outcomes(s)).toEqual(['success', 'failure', 'failure']);
  });

  it('separates sessions with the same tool_use_id', () => {
    const s = openStore(':memory:');
    recordOtelToolResult(s, otel());
    recordOtelToolResult(s, otel({ session_id: 's2' }));
    expect(countExecutions(s, '2026-01-01')).toBe(2);
  });
});

describe('projects and sessions', () => {
  it('upserts projects and sessions', () => {
    const s = openStore(':memory:');
    const p = ensureProject(s, '/proj', 't0');
    expect(ensureProject(s, '/proj', 't1').id).toBe(p.id);
    touchSession(s, 's1', p.id, 't0');
    touchSession(s, 's1', p.id, 't1');
    expect(s.db.prepare('SELECT started_at, last_seen_at FROM sessions').get()).toEqual({ started_at: 't0', last_seen_at: 't1' });
  });
});

describe('metrics', () => {
  const point = (over: Partial<MetricPoint>): MetricPoint => ({
    name: 'claude_code.token.usage',
    series_key: '{"session.id":"s1","type":"input"}',
    start_time: '2026-11-11T00:00:00.000Z',
    time: '2026-11-11T00:00:05.000Z',
    day: '2026-11-11',
    temporality: 'delta',
    value: 100,
    ...over,
  });

  it('de-duplicates re-sent points and aggregates per day', () => {
    const s = openStore(':memory:');
    expect(recordMetricPoints(s, [point({}), point({ time: '2026-11-11T00:00:10.000Z', value: 50 })])).toBe(2);
    expect(recordMetricPoints(s, [point({})])).toBe(0);
    recordMetricPoints(s, [
      point({ name: 'claude_code.session.count', series_key: '{"session.id":"s1"}', value: 1 }),
      point({ name: 'claude_code.cost.usage', temporality: 'cumulative', value: 0.1 }),
      point({ name: 'claude_code.cost.usage', temporality: 'cumulative', time: '2026-11-11T00:00:10.000Z', value: 0.3 }),
    ]);
    expect(dailyMetrics(s, '2026-11-01')).toEqual([{ day: '2026-11-11', sessions: 1, tokens: 150, costUsd: 0.3 }]);
    expect(dailyMetrics(s, '2026-11-12')).toEqual([]);
  });
});
