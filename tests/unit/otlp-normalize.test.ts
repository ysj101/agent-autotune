import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nanosToIso, normalizeLogs, normalizeMetrics } from '../../src/telemetry/normalizer.js';

const dir = new URL('../fixtures/otlp/', import.meta.url);
const load = (prefix: string): unknown[] =>
  readdirSync(dir)
    .filter((f) => f.startsWith(prefix))
    .map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')));

describe('normalizeLogs', () => {
  it('extracts tool_result events from real-device fixtures', () => {
    const results = load('logs-').flatMap(normalizeLogs);
    expect(results).toHaveLength(3);
    const byId = Object.fromEntries(results.map((r) => [r.tool_use_id, r]));
    expect(byId['toolu_fixture0003']).toEqual({
      session_id: '00000000-0000-4000-8000-000000000001',
      tool_use_id: 'toolu_fixture0003',
      prompt_id: '00000000-0000-4000-8000-000000000002',
      event_sequence: 42,
      tool_name: 'Bash',
      outcome: 'failure',
      duration_ms: 1349,
      observed_at: '2026-11-11T22:47:18.055Z',
    });
    expect(byId['toolu_fixture0005']?.outcome).toBe('success');
  });

  it('never emits identity attributes', () => {
    const out = JSON.stringify(load('logs-').flatMap(normalizeLogs));
    expect(out).not.toMatch(/example\.com|user|organization|account|request_id|req_/);
  });

  it('ignores malformed and unrelated records', () => {
    expect(normalizeLogs(null)).toEqual([]);
    expect(normalizeLogs({ resourceLogs: 'x' })).toEqual([]);
    expect(normalizeLogs({ resourceLogs: [{ scopeLogs: [{ logRecords: [null, 1, { attributes: 'x' }] }] }] })).toEqual([]);
    const rec = (attrs: Record<string, unknown>): unknown => ({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: '1794437238055000000', attributes: Object.entries(attrs).map(([key, v]) => ({ key, value: { stringValue: v } })) }] }] }],
    });
    expect(normalizeLogs(rec({ 'event.name': 'api_request', 'session.id': 's' }))).toEqual([]);
    expect(normalizeLogs(rec({ 'event.name': 'tool_result', tool_name: 'Bash' }))).toEqual([]);
    expect(normalizeLogs(rec({ 'event.name': 'tool_result', 'session.id': 's', tool_name: 'Bash; rm' }))).toEqual([]);
    const [r] = normalizeLogs(rec({ 'event.name': 'tool_result', 'session.id': 's', tool_name: 'Bash', success: 'maybe', unknown_attr: 'x' }));
    expect(r).toMatchObject({ outcome: 'unknown', tool_use_id: null, observed_at: '2026-11-11T22:47:18.055Z' });
  });

  it('reads session.id from resource attributes as a fallback', () => {
    const body = {
      resourceLogs: [
        {
          resource: { attributes: [{ key: 'session.id', value: { stringValue: 'res-session' } }] },
          scopeLogs: [{ logRecords: [{ timeUnixNano: '1794437238055000000', body: { stringValue: 'claude_code.tool_result' }, attributes: [{ key: 'tool_name', value: { stringValue: 'Read' } }, { key: 'success', value: { boolValue: true } }] }] }],
        },
      ],
    };
    expect(normalizeLogs(body)[0]).toMatchObject({ session_id: 'res-session', tool_name: 'Read', outcome: 'success' });
  });
});

describe('normalizeMetrics', () => {
  it('extracts allowlisted delta sums from fixtures', () => {
    const points = load('metrics-').flatMap(normalizeMetrics);
    const names = new Set(points.map((p) => p.name));
    expect(names).toEqual(new Set(['claude_code.session.count', 'claude_code.token.usage', 'claude_code.cost.usage']));
    expect(points.every((p) => p.temporality === 'delta')).toBe(true);
    const session = points.find((p) => p.name === 'claude_code.session.count');
    expect(session).toMatchObject({ value: 1, day: '2026-11-11' });
    expect(JSON.parse(session!.series_key)).toEqual({ 'session.id': '00000000-0000-4000-8000-000000000001' });
    expect(JSON.stringify(points)).not.toMatch(/example\.com|user|organization|account/);
  });

  it('ignores unknown metrics and invalid points', () => {
    const body = {
      resourceMetrics: [{ scopeMetrics: [{ metrics: [
        { name: 'claude_code.lines_of_code.count', sum: { dataPoints: [{ asInt: '1', timeUnixNano: '1794437238055000000' }] } },
        { name: 'claude_code.cost.usage', sum: { aggregationTemporality: 2, dataPoints: [{ asDouble: -1, timeUnixNano: '1' }, { asDouble: 0.5, timeUnixNano: 'x' }, { asInt: '3', timeUnixNano: '1794437238055000000' }] } },
        { name: 'claude_code.token.usage', gauge: { dataPoints: [] } },
      ] }] }],
    };
    expect(normalizeMetrics(body)).toEqual([
      { name: 'claude_code.cost.usage', series_key: '{}', start_time: '2026-11-11T22:47:18.055Z', time: '2026-11-11T22:47:18.055Z', day: '2026-11-11', temporality: 'cumulative', value: 3 },
    ]);
    expect(normalizeMetrics('garbage')).toEqual([]);
  });
});

describe('nanosToIso', () => {
  it('converts and validates', () => {
    expect(nanosToIso('1794437238055000000')).toBe('2026-11-11T22:47:18.055Z');
    expect(nanosToIso('0')).toBeNull();
    expect(nanosToIso('-5')).toBeNull();
    expect(nanosToIso('99999999999999999999')).toBeNull();
  });
});
